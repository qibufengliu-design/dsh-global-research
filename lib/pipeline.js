/**
 * The research pipeline. Plain functions + an injected dependency object, so
 * every step is testable without DSH, network, or a model.
 */
import { Budget, BudgetExceeded, jaccard, tokenSet, heuristicSubQuestions, rankHits, dedupeHits, truncate, uniqueStrings, domainTrust, isOfficialDomain, extractUrls, canonicalKey, looksStale, sourceTier } from './util.js'
import { searchAll } from './engines.js'
import { createLlmClient } from './llm.js'
import {
  appendConflictSection, appendReferences, applyZeroEvidenceOptions, assignSourceIds, buildResult, computeConfidence, fallbackBrief, missingSections, requiredSectionsFor, validateCitations, zeroEvidenceGapText,
} from './brief.js'
import { analyzePrompt, evidencePrompt, gapPrompt, planPrompt, repairPrompt, SAFETY_SYSTEM, synthPrompt } from './prompts.js'
import { pickVerticals, searchVerticals } from './verticals.js'
import { applyDepthBias, classify, isCodeish, isFollowUp, isLegalText, normalizeMode, rankBoosts, resolveStrategy } from './strategy.js'
import { crawlSitemap } from './sources.js'
import { analyzeAssertions, extractAssertions, findSelfContradictions } from './assertions.js'

// 0.9.1 — the confidence gate's breadth key lives in lib/util.js, next to
// `isOfficialDomain` / `sourceTier` (its only dependencies), because
// `lib/brief.js` needs it too and importing this module from brief.js would
// close the brief → pipeline → brief import cycle. Re-exported here because the
// breadth rule is documented and tested as part of the pipeline surface.
export { evidenceSiteKey } from './util.js'

export const DEPTH_PROFILES = {
  quick: { queries: 2, pages: 3, llmCalls: 6, gapRounds: 0, wallMs: 90000, batch: 3, candidates: 12, synthTokens: 2600 },
  standard: { queries: 6, pages: 12, llmCalls: 14, gapRounds: 1, wallMs: 180000, batch: 3, candidates: 40, synthTokens: 5200 },
  deep: { queries: 16, pages: 30, llmCalls: 28, gapRounds: 1, wallMs: 300000, batch: 4, candidates: 80, synthTokens: 7000 },
}

/** Depth heuristic, kept for callers; the vocabulary lives in lib/strategy.js. */
export function autoDepth(question, focus = []) {
  return classify({ question, focus }).depthHint
}

/**
 * Pick the depth profile. `strategy` is optional and only used for its bias;
 * without it this is the old behaviour exactly. The bias is applied to the
 * auto-derived request and clamped by the pack, never to DEPTH_PROFILES.
 * runResearch() intentionally does not pass a strategy yet (PR3), so depth is
 * still classifier-driven even for packs that declare `depth.bias`.
 */
export function resolveDepth({ depth, question, focus, config, deepUsed = 0, strategy = null }) {
  const fromAuto = !(depth && depth !== 'auto')
  const requested = fromAuto ? autoDepth(question, focus) : depth
  const resolved = applyDepthBias(requested, strategy, { auto: fromAuto })
  if (resolved === 'deep' && deepUsed >= (config.maxDeepPerSession ?? 5)) return 'standard'
  return DEPTH_PROFILES[resolved] ? resolved : 'standard'
}

/** Deterministic query plan: per-subquestion variants first, then a compact fallback. */
export function buildQueries(subQuestions, focus, question, limit, strategy = null) {
  const policy = strategy?.queries ?? {}
  const variants =
    Array.isArray(policy.perSubVariants) && policy.perSubVariants.length > 0
      ? policy.perSubVariants
      : ['sub', 'sub+focus', 'site|official']
  const maxLen = Number.isFinite(policy.maxLen) ? policy.maxLen : 100
  const siteTargets = Array.isArray(policy.siteTargets) ? policy.siteTargets.filter(Boolean) : []
  const out = []
  let subIndex = 0
  for (const sub of subQuestions) {
    const text = typeof sub === 'string' ? sub : sub.q
    if (!text) continue
    // The classifier owns "is this a code question?", so the site suffix can no
    // longer disagree with the legal/vertical stages; a strategy may force it.
    const forced = typeof policy.codeish === 'boolean' ? policy.codeish : null
    const codeish = forced ?? isCodeish(text)
    for (const variant of variants) {
      if (variant === 'sub') {
        out.push(text)
      } else if (variant === 'sub+focus') {
        if (focus.length > 0) out.push(`${text} ${focus.join(' ')}`)
      } else if (variant === 'site|official') {
        // `site:github.com` only makes sense for code-shaped subquestions; forcing
        // it on policy/regulatory questions hides the primary sources.
        if (siteTargets.length > 0) out.push(`${text} ${siteTargets[subIndex % siteTargets.length]}`)
        else out.push(codeish ? `${text} site:github.com` : `${text} 官方`)
      }
    }
    subIndex += 1
  }
  // Kind-directed queries (official sites for legal, comparison/recency phrasing
  // for the others) lead the plan: it is sliced to a small limit, and a query
  // appended after the per-subquestion variants and fragments would never reach
  // an engine. A pack that declares none (the concept anchor) adds nothing, so
  // the deterministic plan is unchanged.
  const directed = strategyDirectedQueries(policy, question)
  if (directed.length > 0) out.unshift(...directed)
  // Long questions make poor engine queries (and DDG sometimes challenges them);
  // keep the first sentence as a last-resort fallback instead of the raw text.
  // Chinese questions have no word boundaries, so also cut short fragments: a
  // 40-character sentence rarely matches anything, its 8–12 character clauses do.
  const compact = String(question ?? '').split(/[。？！?!\n]/)[0].trim().slice(0, maxLen)
  if (compact) out.push(compact)
  if (compact.length > 24) out.push(...shortFragments(compact))
  // English engines answer many Chinese questions far better through their
  // English terms; if the planner produced no Latin query, add one ourselves.
  const wantsLatin = policy.latinBoost !== false
  if (wantsLatin && !out.some((query) => /[a-z]{4,}/i.test(query) && !/[\u4e00-\u9fff]/.test(query))) {
    const latin = latinTopic(`${question} ${focus.join(' ')}`)
    if (latin) out.push(latin, `${latin} official documentation`)
  }
  // A pack may spend fewer queries than the depth profile allows (the plan is a
  // budget, not a target); null keeps the caller's limit exactly.
  const cap = Number.isFinite(policy.limit) && policy.limit > 0 ? Math.min(limit, policy.limit) : limit
  return uniqueStrings(out).slice(0, cap)
}

/**
 * Queries a strategy pack adds for its kind. `{q}` is the compact question and
 * `{year}` the current year; `siteHints` are prefixed to the question instead.
 * No declared hints/templates returns [], which is the legacy plan.
 */
export function strategyDirectedQueries(policy = {}, question = '', now = new Date()) {
  const templates = Array.isArray(policy.extraTemplates) ? policy.extraTemplates : []
  const hints = Array.isArray(policy.siteHints) ? policy.siteHints : []
  if (templates.length === 0 && hints.length === 0) return []
  const topic = String(question ?? '').split(/[。？！?!\n]/)[0].trim().slice(0, 60)
  if (!topic) return []
  const year = String(now.getFullYear())
  const fill = (text) => String(text ?? '').split('{q}').join(topic).split('{year}').join(year).trim()
  const out = []
  for (const hint of hints) {
    const clean = fill(hint)
    if (clean) out.push(`${clean} ${topic}`)
  }
  for (const template of templates) {
    const clean = fill(template)
    if (clean) out.push(clean)
  }
  return out
}

/** 0.7.1 — map a planner label onto the three kinds, defaulting to semantic. */
function normalizeQueryKind(value) {
  const kind = String(value ?? '').trim().toLowerCase()
  if (kind === 'technical' || kind === 'tech' || kind === 'en' || kind === 'english') return 'technical'
  if (kind === 'official' || kind === 'site' || kind === 'directed') return 'official'
  return 'semantic'
}

/**
 * 0.7.1 — accept both plan shapes: `{q, kind}` (0.7.1) and the bare string
 * queries every earlier version asked for (those count as `semantic`).
 */
function normalizePlannedQueries(items) {
  if (!Array.isArray(items)) return []
  const out = []
  for (const item of items) {
    const raw = typeof item === 'string'
      ? item
      : (item && typeof item === 'object' ? (item.q ?? item.query) : null)
    if (typeof raw !== 'string') continue
    const q = raw.trim().slice(0, 100)
    if (!q) continue
    out.push({ q, kind: item && typeof item === 'object' ? normalizeQueryKind(item.kind) : 'semantic' })
  }
  return out
}

/** Queries the deterministic safety net adds carry no label; guess by shape. */
function classifyQueryKind(query) {
  if (/^\s*site:/i.test(query)) return 'official'
  if (/[\u4e00-\u9fff]/.test(query)) return 'semantic'
  return 'technical'
}

// 0.8.1 — channels whose declared targets *are* the official destination. A pack
// that declares one of these can always be pointed at `site:<host>` directly.
const OFFICIAL_CHANNEL_IDS = new Set(['official-docs', 'pricing', 'standards'])

/** A declared base/seed is a URL; a declared `hosts` entry may be a bare domain. */
function declaredHost(value) {
  const raw = typeof value === 'string' ? value : (value?.base ?? value?.url ?? '')
  const text = String(raw ?? '').trim()
  if (!text) return ''
  if (/^https?:\/\//i.test(text)) {
    try {
      return new URL(text).hostname.replace(/^www\./i, '').toLowerCase()
    } catch {
      return ''
    }
  }
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(text) ? text.replace(/^www\./i, '').toLowerCase() : ''
}

/**
 * 0.8.1 — planner backstop. `planPrompt` asks for 2–3 directed `site:` queries but
 * the model frequently returns only Chinese/English ones, so the funnel reads
 * `官方定向 0` and no query ever targets the vendor docs the strategy already
 * declares. When the pack has an official-docs/pricing/standards channel, build
 * up to two `site:<host> <topic>` queries from that channel's declared
 * bases/seeds — declared targets, never invented ones. A channel that declares
 * only a `hosts` list (the legal pack) is skipped: its `siteHints` already plan
 * the directed queries, and guessing a host from a standards-body list would
 * search the wrong site.
 */
export function officialBackstopQueries(question, focus = [], strategy = null) {
  const channels = Array.isArray(strategy?.sourcePlan?.channels) ? strategy.sourcePlan.channels : []
  const hosts = []
  const seen = new Set()
  const add = (value) => {
    const host = declaredHost(value)
    if (host && !seen.has(host)) {
      seen.add(host)
      hosts.push(host)
    }
  }
  for (const channel of channels) {
    if (!OFFICIAL_CHANNEL_IDS.has(String(channel?.id ?? '').trim().toLowerCase())) continue
    for (const entry of (Array.isArray(channel.bases) ? channel.bases : [])) add(entry)
    for (const entry of (Array.isArray(channel.seeds) ? channel.seeds : [])) add(entry)
    if (hosts.length >= 2) break
  }
  if (hosts.length === 0) return []
  const latin = latinTopic(`${question ?? ''} ${(Array.isArray(focus) ? focus : []).join(' ')}`)
  const term = latin || String(question ?? '').trim().slice(0, 20)
  if (!term) return []
  return hosts.slice(0, 2).map((host) => `site:${host} ${term}`)
}

// 0.7.1 — "zero-evidence option" detection for compare runs. A comparison that
// silently drops an option the user named reads as "this is the shortlist",
// which is a stronger claim than the clusters support. These helpers only count
// evidence coverage for a name; they never judge which option is better.
const COMPARE_KINDS = new Set(['compare', 'tech-selection', 'selection'])
// 0.9.1 — `，` is a separator too: users list options with commas as often as
// with 「、」 ("qwen，豆包，deepseek 哪家便宜"). It only becomes one after the
// question's setting clause has been cut away in `optionSource`, because in a
// Chinese question a comma usually introduces the list ("Java 后端做 RAG 应用，
// Spring AI、…") rather than an option.
const OPTION_SPLIT = /\s*(?:\||\/|、|，|,|\bvs\.?|还是)\s*/i
/** A separator strong enough to mark a real option list (a comma alone is not). */
const LIST_SEPARATOR = /[、|]|\/|\bvs\b|还是/i
// 0.8.1 — the option name ends where the segment turns into a predicate. A split
// segment is "Haystack 该怎么选", not "Haystack": cutting at the *first*
// predicate/punctuation keeps the name and discards everything after it.
// 0.9.1 — `该选` / `选哪` / `哪家` cover the Chinese interrogative tails 0.8.1
// missed: "deepseek 哪家便宜" is the option `deepseek`, and a trailing
// "该选哪个？" is a predicate, not an option.
const OPTION_CUT = /(该怎么|该选|选哪|哪家|怎么|如何|哪个|哪一种?|呢|吗|？|\?|。|，|,)/u
const OPTION_TAILS = /(?:该选哪个|该选什么|选哪个|怎么选|如何选择|哪个更好|哪个好|有什么区别|对比|比较|呢|吧)[？?。！!，,；;：:\s]*$/u
const OPTION_NOISE = new Set(['对比', '比较', '方案', '选项', '差异', '优劣', '选型', '区别', '如何', '怎么', '哪个'])
// 0.9.1 — guide words: a segment carrying one of these is the introduction
// ("国内大模型 API 价格对比"), not an option name, and must not become a gap.
const OPTION_GUIDE = /(?:对比|价格|选型|哪个|怎么|如何)/u

function cleanOptionToken(token) {
  const raw = String(token ?? '').replace(/\s+/g, ' ').trim()
  if (!raw) return ''
  const unbracket = (text) => text
    .replace(/^[\s「『“"'《(（[【]+/u, '')
    .replace(/[\s」』”"'》)_）\]】]+$/u, '')
    .trim()
  const cutAt = (text) => {
    const at = text.search(OPTION_CUT)
    return (at >= 0 ? text.slice(0, at) : text).trim()
  }
  let text = cutAt(unbracket(raw))
  // 0.8.1 — a segment can open with the introduction rather than the name
  // ("Java 后端做 RAG 应用，Spring AI"). When the head is a Chinese clause and
  // the clause after the last comma is a Latin name, the name is the option.
  const comma = Math.max(raw.lastIndexOf('，'), raw.lastIndexOf(','))
  if (comma >= 0) {
    const tail = cutAt(unbracket(raw.slice(comma + 1)))
    if (tail && /[A-Za-z]/.test(tail) && /[\u4e00-\u9fff]/u.test(text)) text = tail
  }
  // Removing the predicate can expose the punctuation that introduced it:
  // "bun，该选哪个？" -> "bun，" -> "bun".
  text = text.replace(/[\s」』”"'》)_）\]】？?。！!，,；;：:]+$/u, '').trim()
  for (let i = 0; i < 3 && OPTION_TAILS.test(text); i += 1) text = text.replace(OPTION_TAILS, '').trim()
  text = text.replace(/[\s，,、；;：:]+$/u, '').trim()
  if (!text || text.length > 24) return ''
  // A lone Latin letter is still a name ("A、B、C 该怎么选"); a lone CJK character
  // is what punctuation leftovers look like.
  if (text.length < 2 && !/[A-Za-z0-9]/.test(text)) return ''
  if (OPTION_NOISE.has(text.toLowerCase())) return ''
  return text
}

/** The name with spacing/punctuation removed; the "too short to report" gate. */
function optionCore(option) {
  return String(option ?? '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

/**
 * The part of a question (or focus line) that actually lists options. Two kinds
 * of introduction are cut away, each only when what remains is still a list:
 *   - everything before the last `：` / `:` — "国内大模型 API 价格对比：qwen、…";
 *     a URL or a ratio keeps the text intact so the question is not swallowed;
 *   - the setting clause before the last `，` / `,` — "Java 后端做 RAG 应用，
 *     Spring AI、…" — when another list separator follows it.
 */
function optionSource(source) {
  let text = String(source ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return ''
  if (!text.includes('://')) {
    const colon = Math.max(text.lastIndexOf('：'), text.lastIndexOf(':'))
    if (colon >= 0) {
      const tail = text.slice(colon + 1).trim()
      if (tail && LIST_SEPARATOR.test(tail)) text = tail
    }
  }
  if (LIST_SEPARATOR.test(text)) {
    const comma = Math.max(text.lastIndexOf('，'), text.lastIndexOf(','))
    if (comma >= 0) {
      const tail = text.slice(comma + 1).trim()
      if (tail && LIST_SEPARATOR.test(tail)) text = tail
    }
  }
  return text
}

/**
 * Candidate option names the user wrote, split on `|` `/` `、` `，` `vs` `还是`
 * once the introduction is out of the way. Returns at most 5 unique names; a
 * question without any separator yields []. Segments that are themselves guide
 * words ("价格对比") are dropped: they never reach a gap or the compare table.
 */
export function compareOptions(question, focus = []) {
  const out = []
  const seen = new Set()
  for (const source of [question, ...(Array.isArray(focus) ? focus : [])]) {
    const text = optionSource(source)
    if (!text) continue
    const parts = text.split(OPTION_SPLIT)
    if (parts.length < 2) continue
    for (const part of parts) {
      const option = cleanOptionToken(part)
      if (!option) continue
      if (OPTION_GUIDE.test(option)) continue
      const key = option.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push(option)
      if (out.length >= 5) return out
    }
  }
  return out
}

/**
 * Core-token matcher for evidence coverage (0.9.1).
 *
 * Latin names match on word edges so `bun` never hits `bundle`, and accept a
 * version suffix so `qwen` does hit `qwen2.5` / `qwen-2.5` / `qwen3` — a name with
 * a version after it is still that option. CJK names match as a substring of at
 * least two characters: a single character sits inside too much unrelated text
 * to count as evidence, and it is dropped by the caller instead.
 */
function optionPattern(option) {
  const text = String(option ?? '').trim()
  if (!text) return null
  if (/[\u4e00-\u9fff]/.test(text)) {
    const normalized = optionCore(text)
    return normalized.length >= 2 ? { normalized } : null
  }
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').split(/\s+/).join('[\\s_-]*')
  return { regex: new RegExp(`(?<![\\p{L}\\p{N}])${escaped}[\\d.\\-_]*(?![\\p{L}\\p{N}])`, 'iu') }
}

function optionMatches(pattern, cluster) {
  const evidence = Array.isArray(cluster?.evidence) ? cluster.evidence : []
  const haystack = [
    cluster?.claim ?? '',
    ...evidence.flatMap((item) => [item?.claim ?? '', item?.quote ?? '']),
  ].join(' ')
  if (!haystack.trim()) return false
  if (pattern.regex) return pattern.regex.test(haystack)
  return optionCore(haystack).includes(pattern.normalized)
}

/** How many clusters mention this option's core name at all (0 means zero evidence). */
export function countOptionHits(option, clusters = []) {
  const pattern = optionPattern(option)
  if (!pattern) return 0
  return (clusters ?? []).filter((cluster) => optionMatches(pattern, cluster)).length
}

function isCompareRun(mode, policy, questionKind) {
  if (mode === 'compare') return true
  if (policy?.mode === 'compare') return true
  const kind = policy?.kind ?? policy?.questionKind ?? questionKind
  return COMPARE_KINDS.has(kind)
}

/** ≤12-character clauses usable as queries; only CJK fragments are kept. */
export function shortFragments(text, limit = 2) {
  return String(text ?? '')
    .split(/[，。；、！？,.;!?\s]+/u)
    .map((part) => part.trim())
    .filter((part) => part.length >= 4 && /[\u4e00-\u9fff]/.test(part))
    .map((part) => (part.length > 12 ? part.slice(0, 12) : part))
    .slice(0, limit)
}

/**
 * Topic keywords for sitemap path scoring (0.6.0): latin tokens (the part of a
 * docs URL that is searchable) plus up to two CJK fragments for sites that keep
 * Chinese path slugs. Bounded so a long question cannot explode the scorer.
 */
export function sitemapKeywords(question, focus = [], subQuestions = []) {
  const subText = (Array.isArray(subQuestions) ? subQuestions : [])
    .map((sub) => (typeof sub === 'string' ? sub : sub?.q ?? ''))
  const text = [question, ...(Array.isArray(focus) ? focus : []), ...subText].join(' ')
  const latin = [...tokenSet(text)].filter((token) => /^[a-z][a-z0-9+#.-]{2,}$/i.test(token))
  return uniqueStrings([...latin, ...shortFragments(text, 2)]).slice(0, 10)
}

// Host labels that say nothing about the topic; matching on them would crawl
// every docs site for every question.
const GENERIC_HOST_LABELS = new Set([
  'www', 'docs', 'developer', 'developers', 'api', 'dev', 'com', 'org', 'net', 'io',
  'help', 'support', 'learn', 'reference', 'guide', 'guides', 'platform', 'cloud',
])

/**
 * Pick the declared host whose name matches the question ("Spring Boot" →
 * docs.spring.io). Returns null when nothing matches, so a declared channel is
 * skipped instead of crawling an unrelated site. Ties keep declaration order.
 */
export function pickSitemapHost(hosts, text) {
  const tokens = [...tokenSet(String(text ?? ''))].filter((token) => /^[a-z][a-z0-9+#.-]{2,}$/i.test(token))
  let best = null
  let bestScore = 0
  for (const host of Array.isArray(hosts) ? hosts : []) {
    const labels = String(host).toLowerCase().split('.')
      .filter((label) => label.length >= 3 && !GENERIC_HOST_LABELS.has(label))
    let score = 0
    for (const label of labels) {
      for (const token of tokens) {
        if (label === token) score += 3
        else if (label.startsWith(token) || token.startsWith(label)) score += 2
      }
    }
    if (score > bestScore) {
      best = host
      bestScore = score
    }
  }
  return best
}

/**
 * 0.6.8 — order a channel's declared doc bases for this question.
 *
 * Each base may be a plain URL string or `{ base, tags }`. A base scores one
 * point per tag whose tokens all appear in the question, so "Spring AI 和
 * LangChain4j 做 RAG" puts the Spring AI manual ahead of the Spring Boot one
 * while "Spring Boot JPA" flips the order. Tagged-but-unmatched bases are
 * dropped in favour of the untagged generic fallback; ties keep declaration
 * order. At most `max` bases come back, because every base costs a sitemap
 * probe round (up to six requests, see `crawlSitemap`).
 */
export function pickDocBases(question, focus = '', bases = [], { max = 2 } = {}) {
  const limit = Math.max(1, Math.floor(Number(max) || 2))
  const text = [question, ...(Array.isArray(focus) ? focus : [focus])].filter(Boolean).join(' ')
  const tokens = tokenSet(text)
  const candidates = (Array.isArray(bases) ? bases : [])
    .map((entry, index) => {
      const raw = typeof entry === 'string' ? entry : (entry?.base ?? entry?.url ?? '')
      const tags = (typeof entry === 'object' && Array.isArray(entry?.tags) ? entry.tags : [])
        .map((tag) => String(tag ?? '').trim().toLowerCase())
        .filter(Boolean)
      return {
        base: String(raw ?? '').trim().replace(/\/+$/, ''),
        tags,
        index,
        score: 0,
        universal: tags.length === 0,
      }
    })
    .filter((item) => /^https?:\/\//i.test(item.base))
  for (const item of candidates) {
    for (const tag of item.tags) {
      const tagTokens = [...tokenSet(tag)]
      if (tagTokens.length === 0) continue
      // Every token of a multi-word tag must appear ("spring-ai" → spring + ai).
      if (tagTokens.every((token) => tokens.has(token))) item.score += 1
    }
  }
  const matched = candidates
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
  const universal = candidates
    .filter((item) => item.universal)
    .sort((a, b) => a.index - b.index)
  const unmatched = candidates
    .filter((item) => !item.universal && item.score === 0)
    .sort((a, b) => a.index - b.index)
  // Nothing matched: the generic base is the honest fallback, unmatched tagged
  // bases are last resorts (they at least document the same stack family).
  const fallback = universal.length > 0 ? [...universal, ...unmatched] : unmatched
  return [...matched, ...fallback].slice(0, limit).map((item) => item.base)
}

function clauseGaps(subQuestions, clusters) {
  const gaps = []
  const corpus = clusters.flatMap((cluster) => [
    cluster.claim,
    ...cluster.evidence.map((item) => `${item.title ?? ''} ${item.quote ?? ''} ${item.url ?? ''}`),
  ])
  const corpusTokens = tokenSet(corpus.join(' '))
  for (const sub of subQuestions) {
    const text = typeof sub === 'string' ? sub : sub.q
    if (!text) continue
    // Two shared content words (or a cosine-free Jaccard floor) count as covering
    // the clause — evidence phrases rarely repeat the question verbatim.
    let shared = 0
    for (const token of tokenSet(text)) if (token.length >= 2 && corpusTokens.has(token)) shared += 1
    const covered = shared >= 2
      || clusters.some((cluster) => jaccard(cluster.claim, text) >= 0.12
        || cluster.evidence.some((item) => jaccard(`${item.title} ${item.url}`, text) >= 0.1))
    if (!covered) gaps.push(`未找到关于「${truncate(text, 80)}」的直接证据`)
  }
  return gaps
}

/** Independence unit: a GitHub repo counts as its own site, not the whole host. */
function siteKey(item) {
  const url = String(item?.url ?? '')
  const match = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)/i.exec(url)
  if (match) return `github.com/${match[1].toLowerCase()}/${match[2].toLowerCase()}`
  if (item?.domain) return item.domain
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

function hostOf(url) {
  try {
    return new URL(String(url)).hostname.replace(/^www\./i, '')
  } catch {
    return String(url)
  }
}

// "上面第 2 条"、"展开说说"、"这个方案" reference the previous turn, which the
// research tool cannot see. Detecting it lets the answer admit the risk instead
// of silently researching a different question. The vocabulary now lives in
// lib/strategy.js so there is exactly one copy of it.
export function looksLikeFollowUp(question) {
  return isFollowUp(question)
}

export function groupEvidence(items) {
  const clusters = []
  for (const item of items) {
    const claim = truncate(item.claim, 200)
    const existing = clusters.find((cluster) => jaccard(cluster.claim, claim) >= 0.45)
    if (existing) existing.evidence.push({ ...item, claim })
    else clusters.push({ claim, evidence: [{ ...item, claim }] })
  }
  for (const cluster of clusters) {
    const domains = new Set(cluster.evidence.map((item) => siteKey(item)).filter(Boolean))
    const stances = new Set(cluster.evidence.map((item) => item.stance).filter((s) => s && s !== 'neutral'))
    if (stances.size > 1) cluster.status = 'disputed'
    else if (domains.size >= 2) cluster.status = 'confirmed'
    else cluster.status = 'unverified'
  }
  return clusters
}

function normalizeForMatch(text) {
  return String(text ?? '').toLowerCase().replace(/\s+/g, ' ').replace(/[“”"'’‘]/g, '"').trim()
}

/** A quote only counts when it actually appears in the page we fetched. */
function isGrounded(pageText, quote) {
  const needle = normalizeForMatch(quote).replace(/[\s.。!?！？…,:;；\-—]+$/u, '')
  if (needle.length < 12) return false
  const haystack = normalizeForMatch(pageText)
  return haystack.includes(needle.slice(0, Math.min(60, needle.length)))
}

function toEvidence(raw, page) {
  if (!raw || typeof raw !== 'object') return null
  const claim = truncate(String(raw.claim ?? '').trim(), 200)
  if (claim.length < 8) return null
  const quote = truncate(String(raw.quote ?? '').trim(), 300)
  if (!isGrounded(page.text, quote)) return null
  return {
    claim,
    quote,
    url: page.url,
    title: page.title,
    domain: page.domain,
    publishedAt: page.publishedAt,
    type: ['official', 'docs', 'repo', 'paper', 'forum', 'blog', 'news'].includes(raw.type) ? raw.type : 'blog',
    stance: ['support', 'refute', 'neutral'].includes(raw.stance) ? raw.stance : 'neutral',
    // Retrieval path travels with the evidence so gradeSource can discount
    // proxy-rendered text (0.6.0).
    via: page.via,
    // 0.6.6 — only set when the page itself says it is retired. The flag travels
    // with the card so the brief, the confidence gate and the conflict analyzer
    // all know this claim came from a page nobody maintains any more.
    ...(page.stale === true ? { stale: true } : {}),
  }
}

/** Model-free evidence fallback: first substantial paragraph of each page. */
const NAV_NOISE = /skip to content|skip navigation|cookie|consent|subscribe to our|sign in|log in|all rights reserved|privacy policy/i

/**
 * Pages that are our best shot at primary text: anything fetched through the
 * targeted sitemap channel, plus official standards domains. Vendor docs and
 * price pages live on the vendor's own host, which `isOfficialDomain` does not
 * know about; the sitemap channel is what marks those as first-party (0.6.0).
 * 0.6.2 uses this to relax the heuristic threshold — doc paragraphs are short,
 * so a 120-character gate drops exactly the pages we most want to adopt.
 */
export function isOfficialPage(page) {
  return Boolean(page) && (page.via === 'sitemap' || isOfficialDomain(page.url))
}

function heuristicEvidence(page, { minChars = 120 } = {}) {
  const text = typeof page?.text === 'string' ? page.text : ''
  if (!text) return null
  const paragraph = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .find((p) => p.length >= minChars && !NAV_NOISE.test(p))
  if (!paragraph) return null
  return {
    claim: truncate(paragraph.split(/[。.!?！？]/)[0], 200),
    quote: truncate(paragraph, 300),
    url: page.url,
    title: page.title,
    domain: page.domain,
    publishedAt: page.publishedAt,
    type: 'blog',
    stance: 'neutral',
    via: page.via,
    ...(page.stale === true ? { stale: true } : {}),
  }
}

/**
 * Turn one batch of fetched pages into evidence items.
 *
 * This used to exist twice: inline in the main evidence step and again (without
 * the logging) inside gapRefill. Both call sites now share this function, so
 * the main path and the refill path can never drift in model prompt, grounding
 * filter, or fallback behaviour. `strategy` is optional and only read for the
 * `evidence.heuristicFallback` / `evidence.fallbackLog` switches; without it
 * the legacy behaviour (both on) applies.
 */
export async function extractEvidence(batch, strategy = null, { client, clampLlm = (fn) => fn(), logger = () => {}, signal, allowStale = false } = {}) {
  const policy = strategy?.evidence ?? {}
  const raw = await clampLlm(() => client.jsonCall({
    system: SAFETY_SYSTEM,
    user: evidencePrompt({ pages: batch }),
    signal,
    maxTokens: 2600,
  }))
  const items = []
  const covered = new Set()
  // 0.6.6 — a page that announces its own retirement cannot back a claim. Only a
  // run where nothing else is readable may fall back to it, and then the card is
  // tagged so the brief and the confidence gate can discount it.
  const skipStale = (page) => page?.stale === true && !allowStale
  if (Array.isArray(raw)) {
    raw.forEach((entry) => {
      const index = Number(entry?.source)
      const page = batch[index]
      if (!page || skipStale(page)) return
      const evidence = toEvidence(entry, page)
      if (!evidence) return
      items.push(evidence)
      covered.add(index)
    })
  }
  const modelCount = items.length
  let heuristicCount = 0
  if (policy.heuristicFallback !== false) {
    // 0.6.2 — fall back page by page, not batch by batch. The model usually
    // cites only some of the pages it was given; before this, one returned item
    // silently suppressed the fallback for every other page, so a fetched and
    // readable official page could never reach the evidence set. A page the
    // model already cited is left alone to avoid a duplicate claim from it.
    batch.forEach((page, index) => {
      if (covered.has(index)) return
      if (skipStale(page)) return
      const evidence = heuristicEvidence(page, { minChars: isOfficialPage(page) ? 60 : 120 })
      if (!evidence) return
      items.push(evidence)
      heuristicCount += 1
    })
  }
  if (policy.fallbackLog !== false) {
    if (modelCount === 0) logger(`evidence batch: model returned none, heuristic found ${heuristicCount}`)
    else if (heuristicCount > 0) logger(`evidence batch: ${items.length} items (${heuristicCount} heuristic)`)
    else logger(`evidence batch: ${modelCount} items`)
  }
  return items
}

/**
 * 0.6.6 — mark self-declared retired pages once, at read time, so the prompt, the
 * evidence layer and the confidence gate all see the same flag. User-provided
 * text is exempt: the user chose to paste it, the tool did not pick it up.
 */
export function markStalePages(pages) {
  for (const page of pages ?? []) {
    if (!page || page.provided) continue
    page.stale = looksStale(`${page.title ?? ''} ${page.snippet ?? ''}`)
  }
  return pages
}

/**
 * 0.6.6 — when a stale page is dropped before evidence extraction, the numbers it
 * stated are not "absent because nobody said them"; they were stated by a page we
 * no longer trust. Read the stale text deterministically and report at most two
 * attributes that lost their only source, so a missing figure does not look like
 * an unasked question. Same-attribute mentions in live evidence count as covered.
 */
function staleOnlyGaps(stalePages, clusters) {
  const liveText = clusters
    .flatMap((cluster) => cluster.evidence ?? [])
    .filter((item) => item?.stale !== true)
    .map((item) => `${item.claim ?? ''} ${item.quote ?? ''}`)
    .join('\n')
  const hints = []
  const seen = new Set()
  for (const page of stalePages) {
    const items = extractAssertions({
      url: page.url,
      title: page.title,
      domain: page.domain,
      publishedAt: page.publishedAt,
      claim: String(page.title ?? ''),
      quote: truncate(String(page.text ?? ''), 4000),
    })
    for (const assertion of items) {
      if (assertion?.generic) continue
      const attribute = String(assertion?.attribute ?? '').trim()
      if (!attribute || seen.has(attribute)) continue
      seen.add(attribute)
      if (liveText.includes(attribute)) continue
      hints.push(`「${truncate(attribute, 60)}」仅有过期来源，已剔除`)
      if (hints.length >= 2) return hints
    }
  }
  return hints
}

async function runWithConcurrency(items, limit, worker, signal) {
  const results = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      if (signal?.aborted) return
      const index = cursor
      cursor += 1
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

function mergeClusters(target, incoming) {
  for (const cluster of incoming) {
    const existing = target.find((candidate) => jaccard(candidate.claim, cluster.claim) >= 0.45)
    if (existing) {
      existing.evidence.push(...cluster.evidence)
      const domains = new Set(existing.evidence.map((item) => item.domain).filter(Boolean))
      const stances = new Set(existing.evidence.map((item) => item.stance).filter((s) => s && s !== 'neutral'))
      existing.status = stances.size > 1 ? 'disputed' : domains.size >= 2 ? 'confirmed' : 'unverified'
    } else {
      target.push(cluster)
    }
  }
  return target
}

/**
 * Run one research question end to end.
 * All failures that leave usable evidence return a partial result instead of
 * throwing; only a run with zero evidence throws.
 */
export async function runResearch({
  question, focus = [], depth = 'auto', outputLanguage = 'auto', context = '', mode,
  resume = null, onState = null, classification = null, strategy: strategyInput = null,
  userText = '', config = {}, web, llm, selection, signal, logger = () => {}, deepUsed = 0,
}) {
  const prior = truncate(String(context ?? '').trim(), 2000)
  // Bug fix: an illegal mode used to reach the synthesis prompt verbatim. One
  // normalisation here feeds both the prompt and the cache key. 0.8.2 — an
  // omitted mode is no longer silently turned into 'explain': it stays
  // undefined through classification, and the classifier decides whether the
  // question is a compare run. An explicit mode (including 'explain') wins.
  const requestedMode = mode === undefined || mode === null || String(mode).trim() === ''
    ? undefined
    : normalizeMode(mode)
  const startedAt = Date.now()
  // One classifier decides what kind of question this is, and one strategy pack
  // describes the policy for it. Both are frozen: stages read, never write.
  // They are resolved before the depth so the pack's depth.bias can move an
  // auto-derived request exactly once (design §4.2); an explicit depth is
  // never moved, and a pack without bias changes nothing.
  const classificationResult = classification ?? classify({ question, focus, mode: requestedMode })
  const resolvedMode = requestedMode ?? normalizeMode(classificationResult.mode)
  const strategy =
    strategyInput ??
    resolveStrategy({
      questionKind: classificationResult.questionKind,
      depth,
      mode: resolvedMode,
      confidence: classificationResult.confidence,
      question,
    })
  const resolvedDepth = resolveDepth({ depth, question, focus, config, deepUsed, strategy })
  // Frozen copy: PR2 reads this; nothing may rewrite the shared depth profile.
  const profile = Object.freeze({ ...DEPTH_PROFILES[resolvedDepth] })
  const policy = Object.freeze({
    ...strategy,
    codeish: classificationResult.codeish,
    followUp: classificationResult.followUp,
    legalText: classificationResult.legalText,
    timeSensitive: classificationResult.timeSensitive,
    depthHint: classificationResult.depthHint,
    source: classificationResult.source,
  })
  // Additive ranking nudges for a pack that names preferred sources. A pack
  // without `verticals.prefer` (the concept anchor) yields undefined, which is
  // exactly the old ranking.
  const boosts = rankBoosts(strategy)
  // Strategy-declared brief sections and confidence gates (design §4/§5). An
  // empty/null list keeps the four legacy headings; the gate mirror keeps the
  // old verdict, and only a pack that actually declares a gate/policy changes it.
  // 0.9.0 — the answer layer adds 「## 行动清单」 to the requirement for
  // compare-style modes and decision kinds; concept/track keep it optional.
  const requiredSections = requiredSectionsFor({
    mode: resolvedMode,
    questionKind: classificationResult.questionKind,
    base: strategy?.brief?.requiredSections ?? null,
  })
  const confidenceGates = {
    ...(strategy?.gates ?? {}),
    highNeedsPrimary: strategy?.gates?.requirePrimaryForHigh,
  }
  // A follow-up reuses the pages the previous run already read, so it only buys
  // a fraction of the page budget for the new material.
  const pageBudget = resume ? Math.max(2, Math.round(profile.pages * 0.4)) : profile.pages
  const budget = new Budget({ queries: profile.queries, pages: pageBudget, llmCalls: profile.llmCalls, gapRounds: profile.gapRounds })

  const timeoutController = new AbortController()
  const timer = setTimeout(() => timeoutController.abort(new Error('research wall-clock timeout')), profile.wallMs)
  const runSignal = combineSignals(signal, timeoutController.signal)

  const client = createLlmClient({ llm, selection, logger, timeoutMs: Math.max(20000, profile.wallMs / 2) })
  const carriedPages = resume ? JSON.parse(JSON.stringify(resume.pages ?? [])) : []
  const carriedClusters = resume ? JSON.parse(JSON.stringify(resume.clusters ?? [])) : []
  const seenUrls = new Set(carriedPages.map((page) => page.url))
  const state = {
    analysis: { subQuestions: [], constraints: [], criteria: [], language: 'zh' },
    // Surfaced in stats so a surprising brief can be traced back to the kind the
    // classifier picked (and to the signals that drove it).
    questionKind: classificationResult.questionKind,
    questionKindSignals: classificationResult.signals,
    hits: [],
    pages: [...carriedPages],
    clusters: [...carriedClusters],
    gaps: [],
    // Official pages fetched by URL (Step 2b) that could not be read. They become
    // an explicit 未解决 line instead of silently missing evidence.
    officialFetchFailures: [],
    // 0.6.0: sitemap channels that could not be crawled (`{channel, host, reason}`).
    sourceFailures: [],
    engineErrors: 0,
    queryCount: 0,
    reason: '',
    reusedPages: carriedPages.length,
    reusedClusters: carriedClusters.length,
    // 0.6.1 — the retrieval funnel behind the brief's 检索流程 line. Raw hit URLs
    // are the pre-dedupe identification count; refill pages are fetched in the
    // gap round but are never added to state.pages, so they need their own list
    // or 可读 would be smaller than 采用.
    rawHitUrls: [],
    refillPages: [],
    // 0.9.2 — directed retry of zero-evidence compare options, counted in the
    // funnel line and the debug row even when nothing was tried.
    targetedRefill: { optionsTried: 0, pagesFetched: 0, optionsResolved: 0 },
    adoptedSources: 0,
    officialAdopted: 0,
    timings: { analyze: 0, search: 0, read: 0, evidence: 0, gap: 0, synth: 0 },
  }

  // 0.6.0 — user-supplied text is pre-extracted evidence: the exact wording, no
  // fetch and no extraction. It takes pages[0] and the first evidence slot, but
  // it is not a fetched page: stats, hosts and onState skip `provided`, so a
  // follow-up never persists text the user only pasted in.
  const providedPage = typeof userText === 'string' && userText.trim()
    ? {
      url: 'user-provided',
      finalUrl: 'user-provided',
      title: '用户提供的资料',
      domain: 'user-provided',
      text: truncate(userText.trim(), 20000),
      engine: 'user',
      provided: true,
      ok: true,
      via: 'user',
    }
    : null
  // The funnel counts the user's text as one identified candidate, like any
  // other source; canonicalKey() returns '' for the pseudo-URL, so statsOf()
  // falls back to the raw string when counting unique candidates.
  if (providedPage) state.rawHitUrls.push(providedPage.url)

  // Wall-clock per stage. Without this a 90s run looks identical to a hung run;
  // the brief and the card surface these numbers so slowness is attributable.
  const stageTimings = { analyze: 0, search: 0, read: 0, evidence: 0, gap: 0, synth: 0 }
  let stage = 'analyze'
  let stageStartedAt = Date.now()
  const markStage = (next) => {
    if (stage) stageTimings[stage] += Date.now() - stageStartedAt
    stage = next
    stageStartedAt = Date.now()
  }
  const refreshTimings = () => {
    const snapshot = { ...stageTimings }
    if (stage) snapshot[stage] += Date.now() - stageStartedAt
    for (const key of Object.keys(snapshot)) snapshot[key] = Math.round(snapshot[key])
    state.timings = snapshot
  }
  const buildStats = () => {
    refreshTimings()
    return statsOf(state, budget, startedAt, resolvedMode)
  }

  const clampLlm = async (fn) => {
    try {
      budget.take('llmCalls')
      return await fn()
    } catch (error) {
      if (error instanceof BudgetExceeded) {
        state.reason ||= 'LLM 调用预算耗尽'
        return null
      }
      throw error
    }
  }

  // Hand the finished state back so the tool can store it for follow-ups.
  const finalize = (result) => {
    if (typeof onState === 'function') {
      try {
        onState({ question, focus, depth: resolvedDepth, pages: state.pages.filter((page) => !page.provided), clusters: state.clusters, gaps: result.gaps })
      } catch (error) {
        logger(`onState failed: ${error?.message ?? error}`)
      }
    }
    return result
  }

  try {
    const analysisRaw = await clampLlm(() => client.jsonCall({
      system: SAFETY_SYSTEM,
      user: analyzePrompt({ question, focus, depth: resolvedDepth, prior }),
      signal: runSignal,
      maxTokens: 900,
    }))
    state.analysis = normalizeAnalysis(analysisRaw, question, focus, outputLanguage)

    // Step 2 —?queries. The LLM plan adds English and official-site queries that a
    // deterministic template cannot invent; templates stay as a safety net.
    const planRaw = await clampLlm(() => client.jsonCall({
      system: SAFETY_SYSTEM,
      user: planPrompt({ question, focus, depth: resolvedDepth }),
      signal: runSignal,
      maxTokens: 700,
    }))
    // 0.7.1 — queries may carry a kind; unlabelled templates are classified by shape.
    const plannedItems = normalizePlannedQueries(planRaw?.queries)
    const plannedKind = new Map(plannedItems.map((item) => [item.q, item.kind]))
    const queries = uniqueStrings([
      ...plannedItems.map((item) => item.q),
      ...buildQueries(state.analysis.subQuestions, focus, question, profile.queries, policy),
    ]).slice(0, profile.queries)
    // Kinds are tracked by index so the backstop can replace one slot in place.
    const queryKinds = queries.map((query) => plannedKind.get(query) ?? classifyQueryKind(query))
    // 0.8.1 — backstop: a plan with no `site:` query never reaches the official
    // docs the pack declares (funnel line: `官方定向 0`). Append the declared
    // hosts as directed queries; when the budget is already full, spend the last
    // technical slot instead of one of the Chinese/English ones — and if the plan
    // produced no technical query at all (the reported case: all 6 semantic),
    // spend the last slot whatever its kind, so `official` is never 0.
    if (!queryKinds.includes('official')) {
      for (const query of officialBackstopQueries(question, focus, strategy)) {
        if (queries.includes(query)) continue
        if (queries.length < profile.queries) {
          queries.push(query)
          queryKinds.push('official')
          continue
        }
        let slot = -1
        for (let i = queryKinds.length - 1; i >= 0; i -= 1) {
          if (queryKinds[i] === 'technical') {
            slot = i
            break
          }
        }
        if (slot < 0) {
          for (let i = queryKinds.length - 1; i >= 0; i -= 1) {
            if (queryKinds[i] !== 'official') {
              slot = i
              break
            }
          }
        }
        if (slot < 0) break
        queries[slot] = query
        queryKinds[slot] = 'official'
      }
    }
    budget.take('queries', queries.length)
    state.queryCount = queries.length
    state.queriesByKind = { semantic: 0, technical: 0, official: 0 }
    for (const kind of queryKinds) state.queriesByKind[kind] += 1

    markStage('read')
    // Step 2a — sourcePlan dispatch (0.6.0). A `sitemap` channel crawls one
    // site: the declared `bases` roots are tried in order and the first root
    // that answers wins (0.6.3); a channel without bases falls back to the
    // topic-matched host from its declared list. `direct` channels are fetched
    // in Step 2b, right after any URL the user pasted. Default/concept has no
    // channels and therefore keeps the legacy fetch set exactly.
    const channelPages = []
    const planChannels = Array.isArray(strategy?.sourcePlan?.channels) ? strategy.sourcePlan.channels : []
    const baseUrlOf = (entry) => (typeof entry === 'string' ? entry : (entry?.base ?? entry?.url ?? ''))
    const hasDeclaredBase = (entry) => /^https?:\/\//i.test(String(baseUrlOf(entry) ?? '').trim())
    const sitemapChannels = planChannels.filter((channel) => channel?.method === 'sitemap'
      && Number(channel.maxPages) > 0
      && ((Array.isArray(channel.bases) && channel.bases.some(hasDeclaredBase))
        || (Array.isArray(channel.hosts) && channel.hosts.length > 0)))
    if (sitemapChannels.length > 0 && !runSignal.aborted && typeof config.__fetchRaw === 'function') {
      const topicText = [
        question,
        ...(Array.isArray(focus) ? focus : []),
        ...(state.analysis.subQuestions ?? []).map((sub) => (typeof sub === 'string' ? sub : sub?.q ?? '')),
      ].join(' ')
      const keywords = sitemapKeywords(question, focus, state.analysis.subQuestions)
      for (const channel of sitemapChannels) {
        if (runSignal.aborted || budget.remaining('pages') <= 0) break
        const wanted = Math.min(Number(channel.maxPages) || 0, budget.remaining('pages'))
        const fetchSitemapPage = config.__fetchPage
        if (typeof fetchSitemapPage !== 'function') break
        // 0.6.8 — bases carry tags describing the stack they document, and the
        // question decides their order: a Spring AI question must reach the
        // Spring AI manual, not the (much larger) Spring Boot one.
        const bases = pickDocBases(question, focus, channel.bases)
        let crawled = null
        if (bases.length > 0) {
          for (const baseUrl of bases) {
            if (runSignal.aborted || budget.remaining('pages') <= 0) break
            const attempt = await crawlSitemap({
              baseUrl,
              keywords,
              limit: wanted,
              docHostRewrite: config.docHostRewrite,
              fetchRaw: config.__fetchRaw,
              signal: runSignal,
              timeoutMs: 15000,
            })
            if (attempt?.ok) {
              crawled = attempt
              break
            }
            // A 404 on the first root is normal (spring publishes docs under
            // per-project roots): record it and try the next declared root.
            state.sourceFailures.push({ channel: channel.id, host: hostOf(baseUrl), reason: attempt?.reason ?? 'sitemap crawl failed' })
            logger(`sitemap ${channel.id} (${hostOf(baseUrl)}) failed: ${attempt?.reason ?? 'unknown'}`)
          }
        } else {
          const host = pickSitemapHost(channel.hosts, topicText)
          if (!host) {
            // Nothing in the declared host list relates to this question; skip
            // quietly but leave a trace for the stats line.
            state.sourceFailures.push({ channel: channel.id, host: '', reason: 'no declared host matched the question' })
            continue
          }
          crawled = await crawlSitemap({
            baseUrl: `https://${host}`,
            keywords,
            limit: wanted,
            docHostRewrite: config.docHostRewrite,
            fetchRaw: config.__fetchRaw,
            signal: runSignal,
            timeoutMs: 15000,
          })
          if (!crawled?.ok) {
            // A sitemap is an optimisation: log the failure and continue.
            state.sourceFailures.push({ channel: channel.id, host: String(host), reason: crawled?.reason ?? 'sitemap crawl failed' })
            logger(`sitemap ${channel.id} (${host}) failed: ${crawled?.reason ?? 'unknown'}`)
            continue
          }
        }
        if (!crawled?.ok) continue
        for (const url of (crawled.urls ?? []).slice(0, wanted)) {
          if (runSignal.aborted || budget.remaining('pages') <= 0) break
          state.rawHitUrls.push(url)
          const page = await fetchSitemapPage(url, { signal: runSignal, timeoutMs: 20000 })
          if (!page?.ok) {
            state.sourceFailures.push({ channel: channel.id, host: hostOf(url), reason: page?.reason ?? 'unreadable' })
            continue
          }
          // Charge the page budget only for pages that actually made it in.
          budget.take('pages')
          channelPages.push({ ...page, engine: 'sitemap', via: 'sitemap' })
        }
      }
      state.sitemapPageCount = channelPages.filter((page) => page.engine === 'sitemap').length
    }
    // Step 2b — primary sources by direct URL. A URL the user pasted always wins
    // (pricing/login pages are exactly what search cannot surface); otherwise a
    // `direct` channel's declared seeds (0.6.3), then the planner's official
    // URLs, then the legacy price-list seeds.
    const askedUrls = extractUrls(`${question} ${focus.join(' ')}`).slice(0, 2)
    const plannedUrls = (Array.isArray(planRaw?.directUrls) ? planRaw.directUrls : [])
      .filter((url) => typeof url === 'string' && /^https?:\/\//i.test(url.trim()) && isOfficialDomain(url))
      .map((url) => url.trim())
    // Pricing questions carry the vendor price lists in strategy.sources: search
    // almost never surfaces them. Order is still "user URL, planner URL, seeds",
    // and every other kind ships an empty list, so its fetch set is unchanged.
    const seedUrls = (Array.isArray(strategy?.sources?.officialSeeds) ? strategy.sources.officialSeeds : [])
      .filter((url) => typeof url === 'string' && /^https?:\/\//i.test(url.trim()))
      .map((url) => url.trim())
      .slice(0, 2)
    const seedSet = new Set(seedUrls)
    // 0.6.3 — `direct` channels were declared but never dispatched. Their seeds
    // (pricing → the four vendor price pages) now feed the same direct fetch
    // loop as pasted/planned URLs, tagged with `engine: 'channel:<id>'` so the
    // stats show where a page came from.
    const directChannels = planChannels.filter((channel) => channel?.method === 'direct'
      && Array.isArray(channel.seeds) && channel.seeds.length > 0
      && Number(channel.maxPages) > 0)
    const channelSeedMap = new Map()
    for (const channel of directChannels) {
      const limit = Math.min(Number(channel.maxPages) || 0, channel.seeds.length)
      for (const seed of channel.seeds.slice(0, limit)) {
        if (typeof seed !== 'string' || !/^https?:\/\//i.test(seed.trim())) continue
        const url = seed.trim()
        if (!channelSeedMap.has(url)) channelSeedMap.set(url, channel.id)
      }
    }
    const channelSeedUrls = [...channelSeedMap.keys()]
    // A wired channel legitimately fetches more pages than the legacy two-seed
    // path, but never more than it declares; unrelated kinds keep the cap at 2.
    const directCap = Math.max(2, Math.min(4, channelSeedUrls.length))
    const directUrls = uniqueStrings([...askedUrls, ...channelSeedUrls, ...plannedUrls, ...seedUrls]).slice(0, directCap)
    const directPages = []
    const fetchDirect = config.__fetchPage
    for (const url of directUrls) {
      if (runSignal.aborted || typeof fetchDirect !== 'function') break
      // Step 2a may already have spent the page budget on sitemap pages; do not
      // fetch a direct URL we could not pay for in Step 4 (Budget.take throws).
      if (budget.remaining('pages') - directPages.length <= 0) break
      const channelId = channelSeedMap.get(url)
      state.rawHitUrls.push(url)
      const page = await fetchDirect(url, { signal: runSignal, timeoutMs: 20000 })
      if (page?.ok) directPages.push(channelId ? { ...page, engine: `channel:${channelId}` } : page)
      else {
        logger(`direct url unreadable: ${url}`)
        // A channel seed that fails is a declared-but-missing source: record it
        // on both ledgers (channel failures for stats, official failures for the
        // 未解决 line) and keep going — one dead vendor page must not stop the run.
        if (channelId) state.sourceFailures.push({ channel: channelId, url, domain: hostOf(url), reason: page?.reason ?? 'unreadable' })
        // An unreadable seed is a concrete gap ("the official price page is
        // missing"), not a fatal error: record it and let the brief say so.
        if (seedSet.has(url)) state.officialFetchFailures.push({ url, domain: hostOf(url) })
      }
    }
    state.directUrls = directPages.length

    // Step 2c — mine the official pages for the legal text they link to
    // (policy landing pages almost always link EUR-Lex/ENISA).
    const linkedPrimary = uniqueStrings(
      directPages.flatMap((page) => page.links ?? [])
        .filter((url) => /eur-lex\.europa\.eu|enisa\.europa\.eu|\/eli\//i.test(url) && !directUrls.includes(url)),
    ).slice(0, 2)
    for (const url of linkedPrimary) {
      if (runSignal.aborted || typeof fetchDirect !== 'function') break
      if (budget.remaining('pages') - directPages.length <= 0) break
      state.rawHitUrls.push(url)
      const page = await fetchDirect(url, { signal: runSignal, timeoutMs: 20000 })
      if (page?.ok) {
        directPages.push(page)
        state.directUrls += 1
      } else logger(`linked primary url unreadable: ${url}`)
    }

    markStage('search')
    // Step 3 — search.
    const engines = config.__engines ?? []
    state.engineNames = engines.map((engine) => engine.name)
    // Paid engines expose their per-run call counters on the engine list.
    if (engines.quota) state.engineQuota = engines.quota
    let searchFailures = 0
    for (const query of queries) {
      if (runSignal.aborted) break
      const { hits, engineFailures } = await searchAll(engines, query, {
        signal: runSignal, maxResults: 10, onError: (engine, error) => logger(`engine ${engine} failed: ${error.message}`),
      })
      searchFailures += engineFailures
      state.hits.push(...hits)
      state.rawHitUrls.push(...hits.map((hit) => hit.url).filter(Boolean))
    }
    state.engineErrors = searchFailures
    // Step 3b — vertical APIs (GitHub/arXiv/Stack Overflow/npm/HN). General
    // engines rank forum threads and repos poorly, especially for library and
    // research questions; these APIs return them directly.
    const verticalNames = pickVerticals({
      question,
      focus,
      subQuestions: state.analysis.subQuestions,
      enabled: config.verticals ?? {},
      // The strategy may pin or ban verticals; empty allow/deny keeps the
      // legacy keyword scoring exactly as it was (PR1).
      allow: policy.verticals.allow,
      deny: policy.verticals.deny,
      limit: policy.verticals.limit,
    })
    state.verticals = verticalNames
    if (verticalNames.length > 0 && !runSignal.aborted && typeof config.__fetchRaw === 'function') {
      const verticalQueries = uniqueStrings([
        // Stack Overflow / arXiv index English text far better than Chinese;
        // prefer the planner's English queries when it produced any.
        ...(queries.some((query) => /[a-z]{4,}/i.test(query) && !/[\u4e00-\u9fff]/.test(query))
          ? queries.filter((query) => /[a-z]{4,}/i.test(query) && !/[\u4e00-\u9fff]/.test(query))
          : queries.slice(0, 1)),
        ...(state.analysis.subQuestions ?? []),
      ]).slice(0, 2)
      const { hits: verticalHits, errors: verticalErrors } = await searchVerticals(verticalNames, verticalQueries, {
        fetchRaw: config.__fetchRaw,
        signal: runSignal,
        timeoutMs: 12000,
      })
      state.hits.push(...verticalHits)
      state.rawHitUrls.push(...verticalHits.map((hit) => hit.url).filter(Boolean))
      state.verticalHits = verticalHits.length
      const byEngine = {}
      for (const hit of verticalHits) {
        for (const engine of hit.engines ?? [hit.engine].filter(Boolean)) byEngine[engine] = (byEngine[engine] ?? 0) + 1
      }
      state.verticalHitsByEngine = byEngine
      if (verticalErrors.length > 0) logger(`vertical failures: ${verticalErrors.length}`)
    }
    if (state.hits.length === 0 && directPages.length === 0 && channelPages.length === 0) {
      throw new Error(`所有搜索源均未返回结果（${searchFailures} 次引擎失败），已中止而不编造内容`)
    }

    // Step 4 — dedupe, rank, select. Direct primary pages take precedence;
    // when the planner named none, keep two slots for official links mined
    // out of the secondary pages in step 5b. Sitemap pages (Step 2a) are
    // already fetched and already charged to the budget, so they shrink the
    // search selection instead of being re-counted.
    const usedPrimaryPages = directPages.length + channelPages.length
    const reserve = usedPrimaryPages > 0 ? 0 : (verticalNames.length > 0 ? 1 : 2)
    // Legal/regulatory questions are only really answered by the act itself.
    // Keep two page slots for the gap-refill round that hunts for EUR-Lex,
    // otherwise planner-provided direct URLs consume the entire page budget
    // before the refill can run.
    const wantsPrimaryText = resolvedDepth !== 'quick'
      && (policy.legalText || usedPrimaryPages === 0)
    const refillReserve = wantsPrimaryText
      ? Math.min(2, Math.max(0, pageBudget - usedPrimaryPages - reserve - 1))
      : 0
    // Never fetch a URL the previous run already read: the carried pages are
    // already in state.pages and their evidence is already in state.clusters.
    const ranked = rankHits(dedupeHits(state.hits), { focus, question, boosts })
      .filter((hit) => !seenUrls.has(hit.url))
    // At least one search page when the budget allows it (a resumed run relies on
    // this), but never more than the room left after sitemap/direct pages, so
    // budget.take cannot throw.
    const roomForSearch = Math.max(0, pageBudget - usedPrimaryPages)
    const wantedSearch = Math.max(1, pageBudget - usedPrimaryPages - reserve - refillReserve)
    const selected = ranked.slice(0, Math.min(wantedSearch, roomForSearch))
    // A vertical hit is a direct answer (issue thread, SO answer, paper), not a
    // secondary tutorial; keep at least one slot for it when general ranking
    // pushed them all out.
    const VERTICAL_ENGINES = new Set(['github', 'stackexchange', 'arxiv', 'scholar', 'npm', 'hn', 'pypi', 'docs'])
    const isVertical = (hit) => [...(hit.engines ?? [])].some((engine) => VERTICAL_ENGINES.has(engine))
    // 0.6.5 — never let this reserved slot undo the stale demotion: a repo that
    // says it is archived is only kept when it is the sole vertical candidate.
    const isStaleHit = (hit) => looksStale(`${hit.title ?? ''} ${hit.snippet ?? ''}`)
    const verticalPick = ranked.find((hit) => isVertical(hit) && !isStaleHit(hit))
      ?? ranked.find(isVertical)
    if (verticalPick && !selected.includes(verticalPick)) {
      const replaceAt = selected.map(isVertical).lastIndexOf(false)
      if (replaceAt >= 0) selected[replaceAt] = verticalPick
    }
    // standard/deep have page budget to spare; give a second direct source
    // (e.g. a Stack Overflow answer next to a GitHub issue) a slot as well.
    let extraVertical = null
    if (profile.pages >= 8) {
      const enginesOf = (hit) => new Set([...(hit.engines ?? [])])
      const firstEngines = enginesOf(verticalPick ?? selected.find(isVertical) ?? {})
      const verticalPool = ranked.filter(isVertical)
      extraVertical = verticalPool
        .filter((hit) => !isStaleHit(hit))
        .find((hit) => !selected.includes(hit) && [...enginesOf(hit)].some((engine) => !firstEngines.has(engine)))
        ?? verticalPool.filter((hit) => !isStaleHit(hit)).find((hit) => !selected.includes(hit))
        ?? verticalPool.find((hit) => !selected.includes(hit))
      if (extraVertical) {
        const replaceAt = selected.map(isVertical).lastIndexOf(false)
        if (replaceAt >= 0) selected[replaceAt] = extraVertical
      }
    }
    // 0.7.0 — evidence tier. Regression A (RAG selection) adopted five repo hits
    // and a single vendor doc page: a wide, github-heavy candidate list can push
    // the concrete `/reference/` page out of the window even though the ranking
    // now prefers it per hit. So for a decision/comparison/learning question keep
    // one slot for a doc-page. Same discipline as the vertical slot above: never
    // invent a candidate, do nothing when nothing qualifies, and keep both
    // vertical picks protected.
    // `compare` is a *mode* in this build, not a question kind, so it is checked
    // as a mode; `kind` is accepted as an alias of `questionKind`.
    const DOC_PAGE_KINDS = new Set(['tech-selection', 'learning', 'compare'])
    const questionKind = strategy?.kind ?? strategy?.questionKind
    if (DOC_PAGE_KINDS.has(questionKind) || resolvedMode === 'compare') {
      const isDocPage = (hit) => sourceTier(hit.url) === 'doc-page'
      const docPagePick = ranked.find((hit) => isDocPage(hit) && !isStaleHit(hit)) ?? ranked.find(isDocPage)
      if (docPagePick && !selected.includes(docPagePick)) {
        // Give up a repo source file first — that is the hit that crowded the
        // documentation out — then any ordinary slot.
        const replaceable = (hit) => hit !== verticalPick && hit !== extraVertical
        const repoAt = selected.map((hit) => sourceTier(hit.url) === 'repo-code' && replaceable(hit)).lastIndexOf(true)
        const anyAt = selected.map((hit) => !isDocPage(hit) && replaceable(hit)).lastIndexOf(true)
        const replaceAt = repoAt >= 0 ? repoAt : anyAt
        if (replaceAt >= 0) selected[replaceAt] = docPagePick
      }
    }
    budget.take('pages', directPages.length + selected.length)

    markStage('read')
    // Step 5 — fetch and read.
    const fetcher = config.__fetchPage
    const pages = await runWithConcurrency(selected, 3, async (hit) => {
      const page = await fetcher(hit.url, { signal: runSignal, timeoutMs: 15000 })
      const source = [...(hit.engines ?? [hit.engine].filter(Boolean))][0] ?? 'web'
      // Stack Overflow and HN block plain HTTP fetches (403/419); the vertical
      // API already returned the post body, so use it instead of dropping the
      // source.
      if (!page?.ok && typeof hit.text === 'string' && hit.text.length >= 200) {
        return { url: hit.url, title: hit.title, ok: true, text: hit.text, publishedAt: hit.publishedAt, viaApi: true, engine: source, snippet: hit.snippet }
      }
      // 0.6.6 — keep the search snippet with the page: a README that says "this
      // project is no longer maintained" usually reaches us through the snippet,
      // and stale detection runs on title + snippet.
      return page ? { ...page, engine: page.engine ?? source, snippet: page.snippet ?? hit.snippet } : page
    }, runSignal)
    state.pages = [...channelPages, ...directPages, ...pages].filter(Boolean).filter((page) => page.ok)
    // The user's own text is the first thing the synthesizer (and the evidence
    // extractor) sees; it is free evidence, not a fetched page.
    if (providedPage) state.pages.unshift(providedPage)
    const unread = pages.filter((page) => page && !page.ok)
    if (unread.length > 0) logger(`pages unreadable: ${unread.length}`)
    // Keep the failure reasons: a silently missing source looks like "the web has
    // nothing", which is a lie the answer would inherit. Surface them as gaps.
    state.fetchFailures = unread.slice(0, 3).map((page) => ({ url: page.url, reason: page.reason ?? 'unreadable' }))

    // Step 5b — follow official links found inside the secondary articles we
    // did read (law-firm posts almost always cite EUR-Lex / government texts).
    const newPageCount = Math.max(0, state.pages.filter((page) => !page.provided).length - carriedPages.length)
    const spare = Math.min(
      Math.max(0, budget.remaining('pages') - refillReserve),
      Math.max(0, pageBudget - newPageCount),
    )
    const officialLinked = uniqueStrings(
      state.pages.flatMap((page) => page.links ?? [])
        .filter((url) => isOfficialDomain(url) && !state.pages.some((page) => page.url === url)),
    ).slice(0, Math.min(2, spare))
    if (officialLinked.length > 0) {
      budget.take('pages', officialLinked.length)
      for (const url of officialLinked) {
        if (runSignal.aborted) break
        state.rawHitUrls.push(url)
        const page = await fetcher(url, { signal: runSignal, timeoutMs: 15000 })
        if (page?.ok) {
          state.pages.push(page)
          state.directUrls += 1
        } else logger(`official link unreadable: ${url}`)
      }
    }

    markStalePages(state.pages)

    markStage('evidence')
    // Step 6 —?evidence cards. Carried pages already produced evidence in the
    // previous run; only the freshly fetched pages need extraction. The
    // user-provided page is always included and does not consume a budget slot.
    const usable = [
      ...(providedPage ? [providedPage] : []),
      ...state.pages.filter((page) => !page.provided).slice(carriedPages.length, carriedPages.length + pageBudget),
    ]
    // 0.6.6 — stale pages are dropped before extraction so they cannot back a
    // claim. They get a second chance only when nothing else is readable; then
    // the cards carry `stale: true` and the brief says the only source is dead.
    const freshPages = usable.filter((page) => page.stale !== true)
    const stalePages = usable.filter((page) => page.stale === true)
    const allStale = usable.length > 0 && freshPages.length === 0
    const evidencePages = allStale ? usable : freshPages
    const staleGaps = []
    if (allStale) {
      const hosts = uniqueStrings(stalePages.map((page) => page.domain || hostOf(page.url) || '未知来源')).slice(0, 3)
      staleGaps.push(`唯一可读来源已过期（${hosts.join('、')}）`)
    }
    const batches = chunk(evidencePages, profile.batch)
    for (const batch of batches) {
      if (runSignal.aborted) break
      const items = await extractEvidence(batch, policy, { client, clampLlm, logger, signal: runSignal, allowStale: allStale })
      state.clusters = mergeClusters(state.clusters, groupEvidence(items))
    }
    if (stalePages.length > 0 && !allStale) staleGaps.push(...staleOnlyGaps(stalePages, state.clusters))

    markStage('gap')
    // Step 7 —?gaps.
    state.gaps = [...clauseGaps(state.analysis.subQuestions, state.clusters), ...staleGaps]

    // Step 8 —?one gap-refill round (standard/deep only). Keep at least
    // 60s of the wall clock for synthesis/repair, otherwise skip the refill.
    const remainingMs = profile.wallMs - (Date.now() - startedAt)
    const missingPrimary = !hasPrimaryClusters(state.clusters)
    // A legal/regulatory question is only really answered by the legal text
    // itself: a policy landing page counts as "official" but not as the act.
    const needsLegalText = policy.legalText
      && !state.pages.some((page) => /eur-lex\.europa\.eu/i.test(page.url))
    if (budget.remaining('gapRounds') > 0
      && ((state.gaps.length > 0 && (state.clusters.length < 4 || missingPrimary)) || needsLegalText)
      && !runSignal.aborted && remainingMs > 60000) {
      budget.take('gapRounds')
      state.gaps = await gapRefill({ client, state, profile, budget, runSignal, config, focus, question, logger, clampLlm, needPrimary: missingPrimary || needsLegalText, strategy: policy })
    }

    // Tell the reader when sources were fetched but unreadable, instead of
    // pretending those sources do not exist; same for elliptical follow-ups the
    // tool cannot resolve without conversation history.
    state.gaps = [
      ...state.gaps,
      ...(state.fetchFailures ?? []).map((failed) => `抓取失败：${hostOf(failed.url)}（${truncate(failed.reason, 90)}）`),
      // One line per unreadable official price list; deduped because two seeds
      // can share a host.
      ...[...new Set((state.officialFetchFailures ?? []).map((failed) => `官方价目页未取到：${failed.domain}`))],
      ...(policy.followUp && !prior
        ? ['本次问题是省略式追问：研究工具看不到对话历史，可能答非所问。请把被指代的内容写成完整问题后重查']
        : []),
    ]

    // 0.7.1 — compare runs: count evidence coverage for each option the user
    // named. A zero count is a fact about this round, so it becomes a gap before
    // synthesis (and reaches the partial/fallback paths below unchanged).
    if (isCompareRun(resolvedMode, policy, state.questionKind)) {
      const candidates = compareOptions(question, focus)
      // 0.9.1 — only a real name (≥2 core characters) that is genuinely absent is
      // worth a gap; "A" or a leftover single character would be noise, and the
      // clean-up above already dropped empty/guide-only segments.
      const zeroOptions = candidates.filter((option) => optionCore(option).length >= 2 && countOptionHits(option, state.clusters) === 0)
      if (zeroOptions.length > 0) logger(`zero-evidence options: ${zeroOptions.join(', ')}`)
      // 0.9.2 — a zero count is a fact about the plan, not about the vendor: the
      // queries were planned before anyone knew this option would be uncovered.
      // Retry each one once, in a strictly bounded way, before reporting it.
      state.targetedRefill = await targetedOptionRefill({
        state, profile, budget, runSignal, config, logger, strategy, options: zeroOptions, startedAt,
      })
      const tried = new Set(state.targetedRefill.triedOptions ?? [])
      // Recompute after the refill: new evidence may now cover an option, and a
      // covered option must keep the model's citation instead of being blanked.
      const stillZero = zeroOptions.filter((option) => countOptionHits(option, state.clusters) === 0)
      for (const option of stillZero) {
        const line = zeroEvidenceGapText(option)
        if (state.gaps.some((gap) => gap.startsWith(line))) continue
        // Say the directed search happened; otherwise "zero evidence" reads as if
        // nobody looked, which is exactly the complaint that opened 0.9.2.
        state.gaps.push(tried.has(option) ? `${line}（已定向检索 1 次仍未获证）` : line)
      }
      state.zeroEvidenceOptions = stillZero
      if (zeroOptions.length - stillZero.length > 0) {
        logger(`targeted refill resolved: ${zeroOptions.filter((option) => !stillZero.includes(option)).join(', ')}`)
      }
    }

    if (state.clusters.length === 0) {
      logger('early return: no clusters')
      const brief = fallbackBrief({ question, clusters: [], gaps: ['所有页面均未产生可引用证据'], partial: true, reason: '证据提取失败' })
      return finalize(buildResult({
        brief, sources: [], confidence: 'low', gaps: state.gaps, partial: true, depth: resolvedDepth,
        stats: buildStats(),
        sections: requiredSections,
        pages: state.pages,
        zeroEvidenceOptions: state.zeroEvidenceOptions ?? [],
      }))
    }

    markStage('synth')
    // Step 9 —?synthesize.
    // Disagreement between sources is a result in its own right: keep the
    // disputed clusters so every brief path can surface them instead of letting
    // the synthesis model smooth them into "experts believe".
    state.conflicts = state.clusters.filter((cluster) => cluster.status === 'disputed')
    const sources = assignSourceIds(state.clusters)
    // Assertion-level disagreement is narrower than a stance-level conflict: the
    // two sources agree on the point but not on the number. Run it after
    // assignSourceIds so every value can cite its final [S#] id. Numbers that
    // differ only because they describe different objects are not conflicts;
    // they come back as divergences for one 未解决 note.
    const evidenceItems = state.clusters.flatMap((cluster) => cluster.evidence ?? [])
    // 0.6.6 — a claim whose only source is retired is missing evidence, not a
    // disagreement: drop stale cards before looking for conflicts, so the stale
    // page cannot become the "other side" of a contradiction either.
    const liveEvidenceItems = evidenceItems.filter((item) => item?.stale !== true)
    const { conflicts: assertionConflicts, divergences: entityDivergences } = analyzeAssertions(liveEvidenceItems)
    // 0.6.1 — one page disagreeing with itself is neither a cross-source conflict
    // nor a divergence; it gets its own 来源自相矛盾 line.
    const selfContradictions = findSelfContradictions(liveEvidenceItems)
    const language = outputLanguage === 'auto' ? (state.analysis.language ?? 'zh') : outputLanguage
    const sourceList = sources.map((source) => `[${source.id}] ${source.title} — ${source.url}`).join('\n')
    // Evidence built only from commentary/marketing pages cannot carry a confident
    // verdict, even when several such pages agree: they all copy one another.
    const hasPrimary = hasPrimaryClusters(state.clusters)
    const gaps = [...state.gaps]
    const primaryAbsent = resolvedDepth !== 'quick' && !hasPrimary
    // Gates are applied here (not after synthesis) so the "no primary source"
    // gap and the low-confidence gap follow the same verdict the reader gets;
    // the section gate is the only part that needs the finished brief.
    let confidence = computeConfidence(state.clusters, {
      ...confidenceGates,
      missingPrimary: primaryAbsent,
    })
    if (primaryAbsent) {
      gaps.push('缺少一手或高质量来源：现有证据均为二手解读，关键事实需以官方原文复核')
    }
    if (confidence === 'low' && gaps.length === 0) {
      gaps.push('证据不足：关键事实缺少一手或独立来源确认')
    }
    let synthError = ''
    const synthOptions = (maxTokens, temperature) => ({
      system: SAFETY_SYSTEM,
      user: synthPrompt({
        question, focus, language,
        clusters: state.clusters,
        constraints: state.analysis.constraints,
        criteria: state.analysis.criteria,
        sourceList, depth: resolvedDepth, hasPrimary, prior, mode: resolvedMode,
      }),
      signal: runSignal,
      maxTokens,
      temperature,
    })
    const trySynth = (maxTokens, temperature) => clampLlm(async () => {
      try {
        return await client.call(synthOptions(maxTokens, temperature))
      } catch (error) {
        if (runSignal.aborted) throw error
        synthError = error?.message ?? String(error)
        logger(`synthesis failed: ${synthError}`)
        return ''
      }
    })
    const synthesized = await trySynth(profile.synthTokens ?? 3000, 0.3)

    let brief = synthesized
    let reason = ''
    // A brief that stops mid-sentence is worse than a shorter one: the missing
    // half usually holds the dates or the verdict. Ask once more with more room.
    const truncated = (text) => text && text.length > 200 && !/[。！？.!?…）)\]】」”"']\s*$/u.test(text.trim())
    if (truncated(brief)) {
      logger('synthesis looked truncated; retrying with a larger budget')
      const retry = await trySynth((profile.synthTokens ?? 3000) + 1600, 0.2)
      if (retry && retry.length > brief.length) brief = retry
    }
    if (!brief || brief.length < 40) {
      // One retry with a smaller budget: a transient provider error should not
      // silently downgrade the answer to the deterministic fallback.
      // Retry with a budget at least as large as the first attempt: capping the
      // retry below the original only guarantees a second max-tokens truncation.
      brief = await trySynth(Math.min((profile.synthTokens ?? 3000) + 1600, 9000), 0.2)
    }
    if (!brief || brief.length < 40) {
      reason = synthError ? `综合模型不可用（${truncate(synthError, 90)}），已按证据自动汇总` : '综合模型不可用，已按证据自动汇总'
      state.reason ||= reason
      brief = fallbackBrief({ question, clusters: state.clusters, gaps: [...gaps, reason], partial: false })
    }

    // 0.7.1 — blank the row for a zero-evidence option *before* citation
    // hygiene: any [S#] the model invented in that row then drops out of 参考
    // like every other unverifiable citation.
    const withZeroEvidence = applyZeroEvidenceOptions(brief, state.zeroEvidenceOptions ?? [])
    // The section is inserted before citation checking so its [S#] ids are
    // remapped and counted exactly like citations written by the model.
    const withConflicts = appendConflictSection(withZeroEvidence, state.conflicts, assertionConflicts, entityDivergences, selfContradictions)
    const { brief: cleaned, sources: finalSources } = validateCitations(withConflicts, sources)
    // 采用 (J) is the number of sources that survived citation hygiene, i.e. the
    // rows the 参考 section will actually print.
    state.adoptedSources = finalSources.length
    // 0.6.2 — of the adopted references, how many rest on a first-party page
    // (official domain or targeted sitemap channel).
    state.officialAdopted = finalSources.filter((source) => isOfficialPage(source)).length
    // A declared section that had to be filled with a placeholder is a visible
    // unknown, so it costs one confidence notch (only when the pack declares it).
    const absentSections = missingSections(cleaned, requiredSections)
    if (absentSections.length > 0) {
      confidence = computeConfidence(state.clusters, {
        ...confidenceGates,
        missingPrimary: primaryAbsent,
        missingSections: true,
      })
    }
    const result = buildResult({
      brief: cleaned,
      sources: finalSources,
      confidence,
      gaps,
      partial: false,
      depth: resolvedDepth,
      stats: buildStats(),
      conflicts: state.conflicts,
      assertionConflicts,
      divergences: entityDivergences,
      selfContradictions,
      sections: requiredSections,
      pages: state.pages,
      zeroEvidenceOptions: state.zeroEvidenceOptions ?? [],
    })
    if (state.reason) result.gaps = [...result.gaps, state.reason]
    return finalize(result)
  } catch (error) {
    const aborted = runSignal.aborted
    if (state.clusters.length > 0) {
      const sources = assignSourceIds(state.clusters)
      const conflicts = state.conflicts ?? state.clusters.filter((cluster) => cluster.status === 'disputed')
      const evidenceItems = state.clusters.flatMap((cluster) => cluster.evidence ?? [])
      const liveEvidenceItems = evidenceItems.filter((item) => item?.stale !== true)
      const { conflicts: assertionConflicts, divergences: entityDivergences } = analyzeAssertions(liveEvidenceItems)
      const selfContradictions = findSelfContradictions(liveEvidenceItems)
      const brief = fallbackBrief({
        question, clusters: state.clusters, gaps: state.gaps, partial: true,
        reason: aborted ? '运行超时/中断' : `流程中断：${error.message}`,
      })
      const { brief: cleaned, sources: finalSources } = validateCitations(
        appendConflictSection(brief, conflicts, assertionConflicts, entityDivergences, selfContradictions),
        sources,
      )
      state.adoptedSources = finalSources.length
      state.officialAdopted = finalSources.filter((source) => isOfficialPage(source)).length
      return finalize(buildResult({
        brief: cleaned, sources: finalSources,
        confidence: computeConfidence(state.clusters, {
          ...confidenceGates,
          missingPrimary: resolvedDepth !== 'quick' && !hasPrimaryClusters(state.clusters),
          missingSections: missingSections(cleaned, requiredSections).length > 0,
        }),
        gaps: state.gaps, partial: true, depth: resolvedDepth, stats: buildStats(),
        conflicts,
        assertionConflicts,
        divergences: entityDivergences,
        selfContradictions,
        sections: requiredSections,
        pages: state.pages,
        zeroEvidenceOptions: state.zeroEvidenceOptions ?? [],
      }))
    }
    if (aborted) throw new Error('研究在获得任何证据前被中断（超时或用户取消）')
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/** Any evidence from an official or high-trust source? */
export function hasPrimaryClusters(clusters) {
  return clusters.some((cluster) => cluster.evidence.some((item) => domainTrust(item.url) >= 2))
}

function latinTopic(text) {
  const words = String(text ?? '')
    .replace(/[^A-Za-z0-9+#._-]+/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length >= 3)
  return [...new Set(words)].slice(0, 5).join(' ')
}

/** Deterministic official-site queries for gap refill. The model's own
 * `site:` suggestions are unreliable, so legal/regulatory questions always
 * get at least one EUR-Lex query. */
export function primaryTargetQueries(question, focus = [], strategy = null) {
  const text = `${question ?? ''} ${focus.join(' ')}`
  const topic = latinTopic(question) || latinTopic(focus.join(' '))
  if (!topic) return []
  // The strategy may name official targets for its kind; otherwise fall back to
  // the legacy branch so an unclassified question behaves exactly as before.
  const explicit = strategy?.legalText === true && Array.isArray(strategy?.queries?.primaryTargets)
    ? strategy.queries.primaryTargets.filter((site) => typeof site === 'string' && site.trim())
    : []
  const legal = strategy?.legalText === true || (strategy?.legalText === undefined ? isLegalText(text) : false)
  const targets = explicit.length > 0
    ? explicit
    : legal
      ? ['site:eur-lex.europa.eu', 'site:europa.eu']
      : /\bnpm\b|package|依赖/i.test(text)
        ? ['site:npmjs.com']
        : /github|开源|repository/i.test(text)
          ? ['site:github.com']
          : []
  return targets.slice(0, 2).map((site) => `${site} ${topic}`)
}

async function gapRefill({ client, state, profile, budget, runSignal, config, focus, question, logger, clampLlm, needPrimary = false, strategy = null }) {
  const raw = await clampLlm(() => client.jsonCall({
    system: SAFETY_SYSTEM,
    user: gapPrompt({ question, analysis: state.analysis, clusters: state.clusters, gaps: state.gaps, needPrimary }),
    signal: runSignal,
    maxTokens: 500,
  }))
  const queries = uniqueStrings((raw?.queries ?? []).map((query) => String(query))).slice(0, 2)
  if (needPrimary) queries.push(...primaryTargetQueries(question, focus, strategy))
  if (queries.length === 0) return state.gaps
  state.refillQueries = [...(state.refillQueries ?? []), ...queries]

  const extra = []
  for (const query of uniqueStrings(queries)) {
    if (runSignal.aborted) break
    const { hits } = await searchAll(config.__engines ?? [], query, {
      signal: runSignal, maxResults: 8, onError: (engine, error) => logger(`refill engine ${engine} failed: ${error.message}`),
    })
    extra.push(...hits)
  }
  // These hits are ranked and fetched but never join state.hits/state.pages (the
  // search budget was already spent), so the funnel line must count them here.
  state.rawHitUrls.push(...extra.map((hit) => hit.url).filter(Boolean))
  const room = budget.remaining('pages')
  if (room <= 0) return state.gaps
  const fresh = rankHits(dedupeHits(extra), { focus, question, boosts: rankBoosts(strategy) })
    .filter((hit) => !state.pages.some((page) => page.url === hit.url))
    .slice(0, Math.min(4, room))
  if (fresh.length === 0) return state.gaps
  logger(`refill fresh: ${fresh.map((hit) => hit.url).slice(0, 4).join(' ')}`)

  budget.take('pages', fresh.length)
  const pages = await runWithConcurrency(fresh, 2, (hit) => config.__fetchPage(hit.url, { signal: runSignal, timeoutMs: 15000 }), runSignal)
  let usable = pages.filter((page) => page && page.ok)
  // Official pages are usually one hop away (a policy page links to the ELI
  // text). Spend leftover page budget on those links instead of on more
  // second-hand commentary.
  if (needPrimary && usable.length > 0) {
    const known = new Set(state.pages.map((page) => page.url))
    const officialLinks = uniqueStrings(usable.flatMap((page) => page.links ?? []))
      .filter((url) => isOfficialDomain(url) && !known.has(url))
    const spare = Math.min(2, budget.remaining('pages'))
    if (spare > 0 && officialLinks.length > 0) {
      const digs = officialLinks.slice(0, spare)
      budget.take('pages', digs.length)
      const dug = await runWithConcurrency(digs.map((url) => ({ url })), 2, (hit) => config.__fetchPage(hit.url, { signal: runSignal, timeoutMs: 15000 }), runSignal)
      usable = usable.concat(dug.filter((page) => page && page.ok))
    }
  }
  // Refill pages stay out of state.pages, so keep them for 可读 (K).
  markStalePages(usable)
  state.refillPages = [...(state.refillPages ?? []), ...usable]
  // 0.6.6 — same rule as the main evidence step: retired refill pages are not
  // evidence unless nothing else was readable.
  const freshRefill = usable.filter((page) => page.stale !== true)
  const refillAllStale = usable.length > 0 && freshRefill.length === 0
  const refillEvidencePages = refillAllStale ? usable : freshRefill
  for (const batch of chunk(refillEvidencePages, profile.batch)) {
    if (runSignal.aborted) break
    const items = await extractEvidence(batch, strategy, { client, clampLlm, logger, signal: runSignal, allowStale: refillAllStale })
    state.clusters = mergeClusters(state.clusters, groupEvidence(items))
  }
  return clauseGaps(state.analysis.subQuestions, state.clusters)
}

/**
 * 0.9.2 — hard caps for the directed retry. The query budget was already spent
 * on the plan, so like gapRefill() this step lives off the *page* budget; the
 * numbers here are the whole allowance for one run (not per option).
 */
const TARGETED_REFILL = Object.freeze({
  maxOptions: 3,
  maxPages: 3,
  maxHitsPerOption: 2,
  minRemainingMs: 30000,
})

/**
 * The core term of the directed query: the intent of the first query template
 * the pack declares. `价格 OR pricing` for price packs, docs wording for packs
 * that point at official documentation, and a neutral official-search term
 * otherwise — the option name is always quoted verbatim in front of it.
 */
function targetedCoreTerm(strategy) {
  const template = String(strategy?.queries?.extraTemplates?.[0] ?? '')
  if (/pricing|price|价格|报价|收费/i.test(template)) return '价格 OR pricing'
  if (/文档|docs|documentation/i.test(template)) return '官方 文档 OR official docs'
  return '官方 OR official'
}

/**
 * One directed search per zero-evidence option of a comparison (0.9.2).
 *
 * A vendor with no hit usually means "the plan never queried it", not "the data
 * does not exist": the price question in 0.9.2 had a 豆包 row and no price at
 * all. Each option gets exactly one `<option> <core term>` query; at most two
 * unread links from distinct hosts are fetched per option, and only the 0.6.2
 * per-page heuristic fallback turns those pages into evidence (the model never
 * saw them, so there is no extraction to reuse). Successful pages join
 * state.pages so the 参考 table and the funnel's 可读 count include them.
 *
 * Never throws: a dead engine or a failed fetch is a logged attempt, recorded in
 * state.refillQueries for the debug line, and leaves the gap untouched.
 */
async function targetedOptionRefill({ state, profile, budget, runSignal, config, logger = () => {}, strategy = null, options = [], startedAt = Date.now() }) {
  const report = {
    optionsTried: 0,
    pagesFetched: 0,
    optionsResolved: 0,
    triedOptions: [],
    resolvedOptions: [],
  }
  const targets = uniqueStrings((options ?? []).map((option) => String(option ?? '').trim()).filter((option) => option.length >= 2))
    .slice(0, TARGETED_REFILL.maxOptions)
  if (targets.length === 0) return report
  const timeLeft = () => profile.wallMs - (Date.now() - startedAt)
  // Same wall-clock rule as the gap round, one notch stricter: synthesis and
  // repair still have to fit in what is left, so a run under 30s skips outright.
  if (timeLeft() < TARGETED_REFILL.minRemainingMs) {
    logger('targeted refill skipped: wall clock reserve')
    return report
  }
  // Budget safety in one line: three pages, never more than the profile allows,
  // never more than the run has left.
  let pagesLeft = Math.min(TARGETED_REFILL.maxPages, Math.max(0, Number(profile.pages) || 0), budget.remaining('pages'))
  if (pagesLeft <= 0) {
    logger('targeted refill skipped: no page budget left')
    return report
  }
  const core = targetedCoreTerm(strategy)
  const fetched = new Set(
    [...state.pages, ...(state.refillPages ?? [])]
      .map((page) => canonicalKey(page?.url) || String(page?.url ?? ''))
      .filter(Boolean),
  )
  for (const option of targets) {
    if (runSignal.aborted) break
    if (pagesLeft <= 0) break
    if (timeLeft() < TARGETED_REFILL.minRemainingMs) {
      logger('targeted refill stopped: wall clock reserve')
      break
    }
    const query = `${option} ${core}`
    // Record the attempt before the search so even a dead engine leaves a trace
    // (the debug line prints every refill query, gapRefill's included).
    state.refillQueries = [...(state.refillQueries ?? []), query]
    report.optionsTried += 1
    report.triedOptions.push(option)
    let hits = []
    try {
      const found = await searchAll(config.__engines ?? [], query, {
        signal: runSignal,
        maxResults: 8,
        onError: (engine, error) => logger(`targeted refill engine ${engine} failed: ${error.message}`),
      })
      hits = Array.isArray(found?.hits) ? found.hits : []
    } catch (error) {
      logger(`targeted refill search failed for ${option}: ${error?.message ?? error}`)
      continue
    }
    // Same funnel accounting as the gap round: identified, then (maybe) read.
    state.rawHitUrls.push(...hits.map((hit) => hit?.url).filter(Boolean))
    // One hit per host, never a URL already read in this run: a second hit on
    // the same host would re-read the page we already have.
    const domains = new Set()
    const picks = []
    for (const hit of hits) {
      if (picks.length >= pagesLeft) break
      const url = String(hit?.url ?? '')
      const key = canonicalKey(url) || url
      if (!key || fetched.has(key)) continue
      let domain = ''
      try { domain = new URL(url).hostname } catch { continue }
      if (!domain || domains.has(domain)) continue
      domains.add(domain)
      picks.push(hit)
      if (picks.length >= TARGETED_REFILL.maxHitsPerOption) break
    }
    if (picks.length === 0) continue
    budget.take('pages', picks.length)
    pagesLeft -= picks.length
    const pages = await runWithConcurrency(picks, 2, (hit) => config.__fetchPage(hit.url, { signal: runSignal, timeoutMs: 15000 }), runSignal)
    const readable = (pages ?? []).filter((page) => page && page.ok)
    for (const page of readable) fetched.add(canonicalKey(page.url) || String(page.url ?? ''))
    if (readable.length === 0) continue
    markStalePages(readable)
    // 0.6.6 — a retired page is not evidence unless nothing else was readable.
    const live = readable.filter((page) => page.stale !== true)
    const pagesForEvidence = live.length > 0 ? live : readable
    const known = new Set(state.pages.map((page) => canonicalKey(page?.url) || String(page?.url ?? '')))
    for (const page of readable) {
      const key = canonicalKey(page.url) || String(page.url ?? '')
      if (known.has(key)) continue
      known.add(key)
      state.pages.push(page)
      report.pagesFetched += 1
    }
    // 0.6.2's fallback, reused rather than re-implemented: these pages never went
    // through the model, so the heuristic paragraph is all the evidence they can
    // carry. Official/sitemap pages get the relaxed 60-char gate, as in Step 6.
    const items = []
    for (const page of pagesForEvidence) {
      const item = heuristicEvidence(page, { minChars: isOfficialPage(page) ? 60 : 120 })
      if (item) items.push(item)
    }
    if (items.length > 0) state.clusters = mergeClusters(state.clusters, groupEvidence(items))
    if (countOptionHits(option, state.clusters) > 0) {
      report.optionsResolved += 1
      report.resolvedOptions.push(option)
    }
  }
  return report
}

function combineSignals(a, b) {
  if (!a) return b
  if (!b) return a
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([a, b])
  const controller = new AbortController()
  for (const signal of [a, b]) {
    if (signal.aborted) { controller.abort(signal.reason); break }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true })
  }
  return controller.signal
}

function chunk(items, size) {
  const out = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

function normalizeAnalysis(raw, question, focus, outputLanguage) {
  const language = outputLanguage === 'auto'
    ? (raw?.language === 'en' ? 'en' : /[\u4e00-\u9fff]/.test(question) ? 'zh' : 'en')
    : outputLanguage
  const subQuestions = Array.isArray(raw?.subQuestions)
    ? raw.subQuestions
      .map((item) => (typeof item === 'string' ? { q: item, why: '', evidence: 'web' } : { q: String(item?.q ?? ''), why: String(item?.why ?? ''), evidence: String(item?.evidence ?? 'web') }))
      .filter((item) => item.q.length >= 3)
      .slice(0, 6)
    : []
  if (subQuestions.length === 0) {
    heuristicSubQuestions(question).forEach((q) => subQuestions.push({ q, why: '', evidence: 'web' }))
  }
  return {
    subQuestions,
    constraints: Array.isArray(raw?.constraints) ? raw.constraints.map(String).slice(0, 8) : [],
    criteria: Array.isArray(raw?.criteria) ? raw.criteria.map(String).slice(0, 8) : (focus ?? []),
    language,
  }
}

function statsOf(state, budget, startedAt, mode = 'explain') {
  // A user-provided page is evidence but not a fetched page: never count it in
  // pagesFetched/hosts, or the debug line would claim a fetch that did not
  // happen.
  const fetchedPages = state.pages.filter((page) => page.ok && !page.provided)
  // 0.6.1 — retrieval funnel. Identified is the pre-dedupe raw hit count of this
  // round (engine + vertical + sitemap + direct + user text + gap-refill hits);
  // deduped is the normalised unique candidate count; readable counts every page
  // that was actually fetched OK, including the gap-refill pages that never make
  // it into state.pages; adopted is set by the caller once the reference table is
  // final. All four are counted, never estimated.
  const rawHitUrls = state.rawHitUrls ?? []
  const refillPages = (state.refillPages ?? []).filter((page) => page?.ok)
  const readablePages = [...state.pages.filter((page) => page?.ok), ...refillPages]
  const identified = rawHitUrls.length
  const deduped = new Set(rawHitUrls.map((url) => canonicalKey(url) || url)).size
  const readable = readablePages.length
  const stats = {
    questionKind: state.questionKind ?? 'concept',
    // 0.8.2 — the effective mode: what the caller asked for, or what the
    // classifier inferred when they asked for nothing.
    mode,
    signals: state.questionKindSignals ?? [],
    queries: budget.used.queries,
    // 0.7.1 — planner query mix. Every query in the plan is counted once; the
    // three numbers sum to `queries` unless the budget cut the list short.
    queriesByKind: { ...(state.queriesByKind ?? { semantic: 0, technical: 0, official: 0 }) },
    identified,
    deduped,
    readable,
    adopted: state.adoptedSources ?? 0,
    // 0.6.2 — adoption transparency for first-party pages: how many readable
    // pages were official/sitemap channels, and how many of those made it into
    // the reference table. Reported as `官方采用 x/y` on the funnel line, so a
    // page that was read but not used is visible instead of silent.
    officialReadable: readablePages.filter((page) => isOfficialPage(page)).length,
    officialAdopted: state.officialAdopted ?? 0,
    directUrls: state.directUrls ?? 0,
    pagesFetched: fetchedPages.length,
    // Pages carried over from the previous run were not fetched this time; the
    // brief should not claim otherwise.
    newPagesFetched: Math.max(0, fetchedPages.length - (state.reusedPages ?? 0)),
    // 0.6.0 — targeted sitemap pages that made it into the evidence set, and
    // sourcePlan channels that failed (a failure is a gap, not a crash).
    sitemapPages: state.pages.filter((page) => page.ok && page.engine === 'sitemap').length,
    sourceFailures: (state.sourceFailures ?? []).length,
    clusters: state.clusters.length,
    llmRounds: budget.used.llmCalls,
    elapsedMs: Date.now() - startedAt,
    timings: { ...(state.timings ?? {}) },
    engines: state.engineNames ?? [],
    engineErrors: state.engineErrors ?? 0,
    verticals: state.verticals ?? [],
    verticalHits: state.verticalHits ?? 0,
    verticalsByEngine: state.verticalHitsByEngine ?? {},
    refillQueries: state.refillQueries ?? [],
    // 0.9.2 — the directed retry of zero-evidence compare options: how many
    // options got their one query, how many pages it read, how many were solved.
    targetedRefill: {
      optionsTried: state.targetedRefill?.optionsTried ?? 0,
      pagesFetched: state.targetedRefill?.pagesFetched ?? 0,
      optionsResolved: state.targetedRefill?.optionsResolved ?? 0,
    },
    reusedPages: state.reusedPages ?? 0,
    reusedClusters: state.reusedClusters ?? 0,
    resumed: (state.reusedPages ?? 0) > 0,
    hosts: uniqueStrings(fetchedPages.map((page) => {
      try { return new URL(page.url).hostname } catch { return '' }
    }).filter(Boolean)),
  }
  // Snapshot live counters at report time; omit the key entirely for plain
  // engine arrays so existing stats shapes stay unchanged.
  if (state.engineQuota) stats.engineQuota = { ...state.engineQuota }
  if (state.officialFetchFailures?.length) {
    stats.officialFetchFailures = uniqueStrings(state.officialFetchFailures.map((failed) => failed.domain))
  }
  return stats
}
