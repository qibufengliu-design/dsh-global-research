/**
 * The research pipeline. Plain functions + an injected dependency object, so
 * every step is testable without DSH, network, or a model.
 */
import { Budget, BudgetExceeded, jaccard, tokenSet, heuristicSubQuestions, rankHits, dedupeHits, truncate, uniqueStrings, domainTrust, isOfficialDomain, isPrimarySource, extractUrls, canonicalKey, looksStale, sourceTier } from './util.js'
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
import { createRenderFetcher, isRenderHost, MIN_USEFUL_CHARS } from './fetch.js'

// 0.9.1 — the confidence gate's breadth key lives in lib/util.js, next to
// `isOfficialDomain` / `sourceTier` (its only dependencies), because
// `lib/brief.js` needs it too and importing this module from brief.js would
// close the brief → pipeline → brief import cycle. Re-exported here because the
// breadth rule is documented and tested as part of the pipeline surface.
export { evidenceSiteKey } from './util.js'

// 0.9.5 — the wall budget was raised (90/180/300s → 120/240/360s) after a real
// standard price-comparison run hit the 180s ceiling: analysis+search+evidence
// consumed 161s, the evidence stage alone 86s, so synthesis was cut and the
// directed retry never got its 30s reserve. The evidence stage is now parallel
// (see EVIDENCE_CONCURRENCY), so the extra budget is headroom, not slack.
export const DEPTH_PROFILES = {
  quick: { queries: 2, pages: 3, llmCalls: 6, gapRounds: 0, wallMs: 120000, batch: 3, candidates: 12, synthTokens: 2600 },
  standard: { queries: 6, pages: 12, llmCalls: 14, gapRounds: 1, wallMs: 240000, batch: 3, candidates: 40, synthTokens: 5200 },
  deep: { queries: 16, pages: 30, llmCalls: 28, gapRounds: 1, wallMs: 360000, batch: 4, candidates: 80, synthTokens: 7000 },
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
// 1.0.1 — a comparison connective names the options on both of its sides, so it
// is cut *before* `OPTION_SPLIT` ever sees the sentence: "Spring AI 和
// LangChain4j 怎么选" used to be one 24-character candidate because the comma
// split ran first and 和 was not a separator at all. `以及` precedes `及` so the
// conjunction is not cut into 「以」.
const COMPARE_CONNECTIVE = /\s*(?:以及|还是|(?<![A-Za-z])vs\.?(?![A-Za-z])|对比|比较|和|与|及)\s*/iu
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
// 1.0.1 — a segment carrying one of these words is the question's setting clause
// ("Java 后端做 RAG 应用"), not an option: it must not become a table row or a
// zero-evidence gap. Same for a name that is followed by one of them ("Java 后端").
const BACKGROUND_OPTION_WORD = /(?:应用|场景|项目|架构|后端|系统|功能)/u
const BACKGROUND_FOLLOWER = /^\s*(?:应用|场景|项目|架构|后端|系统|功能)/u
/** 1.0.1 — an option longer than this is a clause, not a name. */
const MAX_OPTION_CHARS = 24
// 1.1.1 — an inline enumeration inside brackets names the options explicitly:
// "国内四家大模型 API（DeepSeek、通义千问、豆包、Kimi）的价格怎么比" lists four
// options, while the punctuation split sees "国内四家大模型 API（DeepSeek" as the
// first one and keeps "豆包" only because it happens to be third. A bracket list
// with at least two items is therefore authoritative for that source, and the
// fragment it was cut out of never becomes a candidate.
const INLINE_OPTION_BRACKET = /[（(]([^（()）]{2,160})[）)]/gu
const INLINE_OPTION_SEPARATOR = /\s*(?:、|，|,|\/|\||;|；)\s*/u
/** A bracket list is a user-declared set, not a trimmed shortlist: keep all of it. */
const MAX_BRACKET_OPTIONS = 6
// 1.1.1 — a fragment carrying the question's predicate ("我们做一个小型 RAG 产品
// 该选哪家") is background, not a name. It is dropped unless it opens with a name
// ("Haystack 该怎么选"), which the split already cut down to the name itself.
const OPTION_PREDICATE = /(?:该怎么|该选|选哪|哪家|怎么比|怎么选|如何选|哪个|哪一种?)/u
// 1.0.1 — the fallback vocabulary, consulted only when the sentence cannot be cut
// into options (no list punctuation, an over-long side, or a setting clause). It
// stays a short list of names this tool already researches rather than a general
// product dictionary: `compareOptions()` must not invent candidates. Entries are
// matched case-insensitively and the text as written is what gets returned.
const KNOWN_OPTION_NAMES = [
  'Spring AI Alibaba', 'Spring AI', 'Spring Boot', 'Spring Cloud',
  'LangChain4j', 'LangChain', 'LlamaIndex', 'Haystack', 'RAGFlow', 'Dify',
  'Pinecone', 'pgvector', 'Weaviate', 'Milvus', 'Qdrant', 'Chroma', 'FAISS',
  'DeepSeek', 'Qwen', 'GLM', 'Kimi', 'Doubao', '豆包', '通义千问', '文心一言', '智谱',
  'OpenAI', 'Claude', 'Gemini', 'Ollama', 'vLLM',
  'pnpm', 'yarn', 'npm', 'bun', 'Vite', 'Next.js', 'Nuxt', 'React', 'Vue', 'Svelte',
  'Django', 'Flask', 'FastAPI', 'Rails', 'Laravel', 'Express', 'NestJS',
  'PostgreSQL', 'Postgres', 'MySQL', 'Redis', 'Kafka', 'RabbitMQ',
]
// Acronyms that are sentence furniture, not options: "RAG 应用" is a setting
// clause, and without this list the fallback would offer RAG as a candidate.
const NON_OPTION_ACRONYMS = new Set([
  'ai', 'api', 'llm', 'llms', 'rag', 'sdk', 'http', 'https', 'json', 'sql', 'ui', 'cli',
  'cpu', 'gpu', 'db', 'orm', 'css', 'html', 'js', 'ts', 'pdf', 'csv', 'url', 'uri', 'id', 'ok',
])

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
 * 1.0.1 — splits one option source on the comparison connectives first, then on
 * the list punctuation, so "Spring AI 和 LangChain4j" yields two sides and
 * "A、B 和 C" yields three pieces. `background` reports whether any piece looks
 * like the question's setting clause (too long, or a background word), which is
 * the trigger for the name-based fallback in `compareOptions()`.
 */
function optionSegments(text) {
  const sides = String(text).split(COMPARE_CONNECTIVE).map((part) => part.trim()).filter(Boolean)
  const pieces = []
  for (const side of sides) {
    for (const piece of side.split(OPTION_SPLIT)) {
      const trimmed = piece.trim()
      if (trimmed) pieces.push(trimmed)
    }
  }
  const background = pieces.some((piece) => piece.length > MAX_OPTION_CHARS || BACKGROUND_OPTION_WORD.test(piece))
  return { pieces, background }
}

function escapeOptionName(name) {
  return String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 1.0.1 — the names a question spells out: Latin names that are capitalised in
 * the text ("Spring AI", "LangChain4j") plus the `KNOWN_OPTION_NAMES` vocabulary,
 * in the order they appear. Overlaps favour the longer name ("Spring AI Alibaba"
 * is not also reported as "Spring AI"), a name followed by a setting-clause word
 * ("Java 后端") is dropped, and so are bare acronyms (RAG / API / LLM).
 */
function knownOptionNames(text) {
  const source = String(text ?? '')
  const found = []
  const scan = (regex) => {
    for (const match of source.matchAll(regex)) {
      const name = cleanOptionToken(match[0])
      if (!name) continue
      if (OPTION_GUIDE.test(name)) continue
      if (BACKGROUND_OPTION_WORD.test(name)) continue
      if (NON_OPTION_ACRONYMS.has(optionCore(name))) continue
      if (BACKGROUND_FOLLOWER.test(source.slice(match.index + match[0].length))) continue
      found.push({ start: match.index, end: match.index + match[0].length, name })
    }
  }
  scan(/(?<![\p{L}\p{N}])[A-Z][A-Za-z0-9]*(?:[ .-][A-Z0-9][A-Za-z0-9]*)*(?![\p{L}\p{N}])/gu)
  for (const name of KNOWN_OPTION_NAMES) {
    scan(new RegExp(`(?<![\\p{L}\\p{N}])${escapeOptionName(name)}[\\d.\\-_]*(?![\\p{L}\\p{N}])`, 'giu'))
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end)
  const out = []
  const seen = new Set()
  let cursor = -1
  for (const item of found) {
    if (item.start < cursor) continue
    const key = optionCore(item.name)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(item.name)
    cursor = item.end
  }
  return out
}

/**
 * 1.0.1 — the clause that actually compares: the comma-delimited sentence holding a
 * comparison connective. "后端用 Spring Boot，Spring AI 和 LangChain4j 哪个好" must
 * not promote the setting's "Spring Boot" to a candidate just because it is a known
 * product name; the comparison lives in the second clause.
 */
function comparisonClause(text) {
  const clauses = String(text).split(/[，,；;。\n]/u).map((clause) => clause.trim()).filter(Boolean)
  const related = clauses.filter((clause) => COMPARE_CONNECTIVE.test(clause))
  return related.length ? related.join('，') : ''
}

function fallbackOptionNames(text) {
  const scoped = knownOptionNames(comparisonClause(text))
  return scoped.length >= 2 ? scoped : knownOptionNames(text)
}

/**
 * 1.1.1 — the options the question enumerates inside brackets. "国内四家大模型 API
 * （DeepSeek、通义千问、豆包、Kimi）的价格怎么比" is a list the user spelled out,
 * and it is authoritative: the punctuation split only sees the fragment "国内四家
 * 大模型 API（DeepSeek" as a piece, so reading the bracket list first is what keeps
 * the real four names and keeps the fragment out of the candidate set. A group is
 * only read as a list when it holds at least two cleaned names: "（如 2024 年）" and
 * "（价格怎么比）" stay prose. Several groups are tried in order, and the first
 * qualifying one wins — the question's own enumeration, not a later aside.
 */
function bracketedOptionNames(text) {
  const source = String(text ?? '')
  if (!source || !/[（(]/.test(source)) return []
  for (const match of source.matchAll(INLINE_OPTION_BRACKET)) {
    const inner = match[1] ?? ''
    const names = []
    const seen = new Set()
    for (const item of inner.split(INLINE_OPTION_SEPARATOR)) {
      const name = cleanOptionToken(item)
      if (!name) continue
      if (OPTION_GUIDE.test(name)) continue
      if (BACKGROUND_OPTION_WORD.test(name)) continue
      // A parenthetical clause ("我们做一个小型 RAG 产品该选哪家") is an aside, not
      // a name, even when it is short enough to survive `cleanOptionToken`.
      if (OPTION_PREDICATE.test(name)) continue
      const key = optionCore(name)
      if (!key || seen.has(key)) continue
      seen.add(key)
      names.push(name)
      if (names.length >= MAX_BRACKET_OPTIONS) break
    }
    if (names.length >= 2) return names
  }
  return []
}

/**
 * 1.1.1 — a split fragment that opens with a name is still that name's segment
 * ("Haystack 该怎么选" is a candidate), while a fragment that merely *contains* the
 * question's predicate ("我们做一个小型 RAG 产品该选哪家") is background.
 */
function startsWithOptionName(piece) {
  const text = String(piece ?? '').trim()
  if (!text) return false
  if (/^[A-Za-z]/.test(text)) return true
  return KNOWN_OPTION_NAMES.some((name) => !/^[\x20-\x7e]+$/.test(name) && text.startsWith(name))
}

/**
 * Candidate option names the user wrote, in the order they are written.
 *
 * 1.0.1 — comparison connectives are cut first ("Spring AI 和 LangChain4j" is two
 * options, not one), then the list punctuation splits whatever is left. A segment
 * longer than 24 characters, or one carrying a setting-clause word (应用 / 后端 /
 * 系统 …), means the sentence is not a clean list: in that case the fallback reads
 * the product names the question actually spells out (capitalised Latin names plus
 * `KNOWN_OPTION_NAMES`) and the setting clause is never a candidate. At most three
 * options are kept, and a single name is not a comparison (`只有 A` → []).
 *
 * Segments that are guide words ("价格对比") are still dropped: they never reach a
 * gap or the compare table.
 *
 * 1.1.1 — a parenthetical enumeration wins over the split: "（DeepSeek、通义千问、
 * 豆包、Kimi）" is read as four options, and the question's setting clause it was
 * embedded in never becomes one. A split fragment carrying the question's
 * predicate ("我们做一个小型 RAG 产品该选哪家") is dropped for the same reason;
 * only a fragment that opens with a name survives it ("Haystack 该怎么选").
 */
export function compareOptions(question, focus = []) {
  const out = []
  const seen = new Set()
  const push = (option, limit = 3) => {
    if (!option) return false
    if (OPTION_GUIDE.test(option)) return false
    if (BACKGROUND_OPTION_WORD.test(option)) return false
    const key = optionCore(option)
    if (!key || seen.has(key)) return false
    seen.add(key)
    out.push(option)
    return out.length >= limit
  }
  for (const source of [question, ...(Array.isArray(focus) ? focus : [])]) {
    const text = optionSource(source)
    if (!text) continue
    // 1.1.1 — an explicit bracket list is the answer for this source; the
    // punctuation split is not consulted at all, so the fragment the list was
    // cut out of ("国内四家大模型 API（DeepSeek") can never come back as a name.
    const bracketed = bracketedOptionNames(text)
    if (bracketed.length >= 2) {
      for (const name of bracketed) {
        if (push(name, MAX_BRACKET_OPTIONS)) return out
      }
      continue
    }
    const { pieces, background } = optionSegments(text)
    const listed = pieces
      .filter((piece) => !OPTION_PREDICATE.test(piece) || startsWithOptionName(piece))
      .map((piece) => cleanOptionToken(piece))
      .filter(Boolean)
    const names = background || listed.length < 2 ? fallbackOptionNames(text) : listed
    for (const name of names) {
      if (push(name, 3)) return out
    }
  }
  return out.length >= 2 ? out : []
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
    // 0.9.8 — a price row quotes the model codename (`doubao-pro-32k`) while the
    // page title names the vendor (`豆包大模型`). Without the title the option gate
    // reads the vendor's own price page as zero evidence for that vendor.
    ...evidence.flatMap((item) => [
      item?.claim ?? '',
      item?.quote ?? '',
      item?.type === 'pricing' ? (item?.title ?? '') : '',
    ]),
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
    // 0.9.8 — price rows all share one sentence shape (`输入 …，输出 …`), so the
    // 0.45 similarity merge would fold every model on a price page into the first
    // row's cluster and hide the rest behind one claim. Two pricing claims are the
    // same claim only when they are identical.
    const pricing = item?.type === 'pricing'
    const existing = clusters.find((cluster) => {
      if (pricing || cluster.evidence[0]?.type === 'pricing') {
        return normalizeForMatch(cluster.claim) === normalizeForMatch(claim)
      }
      return jaccard(cluster.claim, claim) >= 0.45
    })
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
  // 1.1.2 — the sitemap channel and the documentation tiers now share one
  // definition with `computeConfidence` and scripts/eval.mjs (lib/util.js
  // `isPrimarySource`): a vendor's docs page is first-party evidence even when
  // its host was never added to OFFICIAL_DOMAINS.
  return Boolean(page) && (page.via === 'sitemap' || isPrimarySource(page.url))
}

// 0.9.8 — a price table is flattened by htmlToText into one line per <tr>:
// `</tr>` becomes a newline and every <td> becomes a space, so a row reaches the
// pipeline as `doubao-pro-32k 0.0008 元/千 tokens 0.002 元/千 tokens` — no pipes,
// no paragraph length, nothing the 60/120-character paragraph gate can keep. On
// the vendor price page that is the whole body: the header alone passes, the rows
// are dropped, and the page ends up with zero evidence. A row is evidence as soon
// as it carries a token price unit; the row itself, not a paragraph, is the quote.
const PRICING_ROW_RULES = Object.freeze([
  // 0.8 元/百万 tokens · 0.0008 元/千 tokens · $0.5 per 1M tokens
  /\d+(?:\.\d+)?\s*(?:元|块|美元|\$|￥|¥)\s*(?:每|\/|per\s+)?\s*(?:百万|1M|M|千|K|1000)?\s*tokens?/i,
  // 每百万 tokens / 每千 tokens as the only unit the line prints
  /每\s*(?:百万|1M|千|1000)\s*tokens?/i,
  // 输入 0.5 元 / 输出：2 美元 — a cell that lost its token unit keeps the label
  /(?:输入|输出|缓存命中)\s*[:：]?\s*[\d.]+\s*(?:元|美元|\$)/i,
])
const PRICING_ROW_MAX = 8
const PRICING_ROW_CHARS = 120
// Amount + currency + optional token unit: the only numbers a row may turn into a
// claim. A plan or total price (`199 元/月`) is not a token price and is dropped
// again by the unit-or-label filter in pricingClaim().
const PRICE_WITH_UNIT = /(\d+(?:\.\d+)?)\s*(元|块|美元|USD|RMB|\$|￥|¥)\s*(?:每|\/|per\s+)?\s*(十亿|百万|千|1M|1K|1000|B|M|K)?\s*(?:tokens?|token)/i
const PRICE_WITH_UNIT_ALL = new RegExp(PRICE_WITH_UNIT.source, 'gi')
// Any amount with a currency, unit optional: a row that prints `输入 0.5 元`
// without repeating `tokens` still carries a token price.
const PRICE_AMOUNT_ALL = /(\d+(?:\.\d+)?)\s*(元|块|美元|USD|RMB|\$|￥|¥)\s*(?:每|\/|per\s+)?\s*(十亿|百万|千|1M|1K|1000|B|M|K)?\s*(?:tokens?|token)?/gi
const NON_MODEL_CELL = /^(?:模型|型号|名称|产品|品名|价格|单价|费用|计费项|输入|输出|缓存命中|tokens?|元|价格（[^）]*）|价格\([^)]*\))$/i

function isPricingRowText(text) {
  const value = String(text ?? '')
  return PRICING_ROW_RULES.some((rule) => rule.test(value))
}

/**
 * Split body text into row candidates. htmlToText already puts one <tr> per line;
 * a plain-text or reader-proxy table can instead keep `model | in | out | model |
 * in | out` on one line, so pipe/tab cells are regrouped into rows too. Nothing
 * here decides evidence — the caller still demands a price unit.
 */
function pricingRowSegments(text) {
  const rows = []
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const cells = line.split(/\s*[|\t]\s*/).map((cell) => cell.trim()).filter(Boolean)
    if (cells.length < 3) {
      rows.push(line)
      continue
    }
    // A cell that is not a price starts a new row once the current row already
    // holds one: `doubao-pro-32k | 0.0008 … | 0.002 … | doubao-lite | …`.
    let current = []
    for (const cell of cells) {
      const priced = isPricingRowText(cell)
      if (current.length > 0 && !priced && current.some((held) => isPricingRowText(held))) {
        rows.push(current.join(' | '))
        current = []
      }
      current.push(cell)
    }
    if (current.length > 0) rows.push(current.join(' | '))
  }
  return rows
}

/** Role printed before a price: 输入 / 输出 / 缓存命中, or '' when positional. */
function priceRoleBefore(row, index) {
  const before = row.slice(Math.max(0, index - 12), index)
  if (/缓存(?:命中|读取)?[\s:：|]*$/u.test(before)) return '缓存命中'
  if (/输出[\s:：|]*$/u.test(before)) return '输出'
  if (/输入[\s:：|]*$/u.test(before)) return '输入'
  return ''
}

/**
 * The model a row is about. Pipe cells give it directly; with space-separated
 * cells (htmlToText's normal output) it is whatever sits before the first price,
 * with a trailing role word trimmed off (`DeepSeek-V3 输入 0.5 元` → DeepSeek-V3).
 */
function modelNameFromRow(row) {
  const cells = row.split(/\s*\|\s*/).map((cell) => cell.trim()).filter(Boolean)
  for (const cell of cells.slice(0, 3)) {
    if (isPricingRowText(cell)) continue
    const name = cell.replace(/^[\s\-–—·:：*•]+/u, '').replace(/[（(][^）)]*[）)]$/u, '').trim()
    if (!name || name.length > 40 || !/[A-Za-z\u4e00-\u9fff]/.test(name)) continue
    if (NON_MODEL_CELL.test(name)) continue
    return name
  }
  const start = row.search(PRICE_WITH_UNIT)
  if (start <= 0) return ''
  const cleaned = row
    .slice(0, start)
    .replace(/(?:输入|输出|缓存命中|缓存读取|价格|单价|费用|计费|模型)[\s:：|]*$/u, '')
    .replace(/[\s|,:：*•]+$/u, '')
    .trim()
  if (!cleaned || cleaned.length > 40 || !/[A-Za-z\u4e00-\u9fff]/.test(cleaned)) return ''
  return cleaned
}

/** 元/块/￥/¥ → 元; 美元/USD/$ → 美元. */
function currencyWord(raw) {
  const value = String(raw ?? '')
  if (/美元|USD|\$/i.test(value)) return '美元'
  return '元'
}

/** The unit a price is printed with, kept as printed (never re-based). */
function unitWord(raw) {
  const value = String(raw ?? '')
  if (/十亿|^B$/i.test(value)) return '十亿'
  if (/百万|1M|^M$/i.test(value)) return '百万'
  if (/千|1K|^K$|^1000$/i.test(value)) return '千'
  return ''
}

/**
 * Assertion for a price row: `<model> 输入 X 元/百万 tokens，输出 Y …`. The quote
 * stays the raw row; the claim is the readable sentence built from it, so a
 * compare table has a claim to cite instead of a lone number. Roles come from the
 * row's own 输入/输出/缓存命中 labels, and fall back to column order. A price with
 * neither a token unit nor a role is a plan/total price and is left out.
 */
function pricingClaim(row, page) {
  const prices = [...String(row ?? '').matchAll(PRICE_AMOUNT_ALL)]
    .map((match) => ({
      amount: match[1],
      currency: currencyWord(match[2]),
      unit: unitWord(match[3]),
      role: priceRoleBefore(row, match.index),
    }))
    .filter((price) => price.unit || price.role)
  const model = modelNameFromRow(row) || truncate(String(page?.title ?? '').trim(), 40)
  if (prices.length === 0) return truncate(row, 200)
  const taken = new Set(prices.map((price) => price.role).filter(Boolean))
  const order = ['输入', '输出', '缓存命中'].filter((role) => !taken.has(role))
  prices.forEach((price) => {
    if (!price.role) price.role = order.shift() ?? ''
  })
  const parts = prices.map((price) => {
    const value = `${price.amount} ${price.currency}${price.unit ? `/${price.unit}` : ''}${price.unit ? ' tokens' : ''}`
    return price.role ? `${price.role} ${value}` : value
  })
  const sentence = parts.join('，')
  return truncate(model ? `${model} ${sentence}` : sentence, 200)
}

/** Price rows of one page → evidence items (≤8, each row ≤120 chars). */
function pricingRowEvidence(page) {
  if (!page || (page.via !== 'seed' && !isPricingEvidencePage(page))) return []
  const text = typeof page.text === 'string' ? page.text : ''
  if (!text) return []
  const items = []
  const seen = new Set()
  for (const row of pricingRowSegments(text)) {
    if (items.length >= PRICING_ROW_MAX) break
    if (!isPricingRowText(row)) continue
    if (NAV_NOISE.test(row)) continue
    const rowText = row.replace(/\s+/g, ' ').trim()
    const quote = truncate(rowText, PRICING_ROW_CHARS)
    if (quote.length < 8 || seen.has(quote)) continue
    seen.add(quote)
    items.push({
      claim: pricingClaim(rowText, page),
      quote,
      url: page.url,
      title: page.title,
      domain: page.domain,
      publishedAt: page.publishedAt,
      // 0.9.8 — 'pricing' is a new evidence kind: the brief counts the card as
      // evidence, and the type says the claim is a printed unit price.
      type: 'pricing',
      stance: 'neutral',
      via: page.via,
      ...(page.stale === true ? { stale: true } : {}),
    })
  }
  return items
}

function paragraphEvidence(page, paragraph) {
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
 * A block that is really a table: two or more price rows and no sentence
 * punctuation. The old paragraph gate would turn such a block into one blob
 * claim ("豆包大模型 模型 输入价格 输出价格 doubao-pro-32k | 0.0008 …"), which
 * duplicates and dilutes the rows. Only consulted on pages that yielded at least
 * one price row, so an ordinary page keeps the old paragraph rule untouched.
 */
function isPriceTableBlock(block) {
  const rows = pricingRowSegments(block).filter((row) => isPricingRowText(row))
  // A decimal point in 0.0008 is not a sentence end; only CJK stops and Latin
  // stops followed by whitespace/end count as prose punctuation.
  return rows.length >= 2 && !/[。！？]|[.!?](?=\s|$)/u.test(block)
}

/**
 * Model-free evidence for one page. Returns an array: the paragraph the gate
 * accepts first (old rule), then any price rows — a page with both keeps both
 * kinds, and the rows are appended, never substituted for the paragraph.
 */
function heuristicEvidence(page, { minChars = 120 } = {}) {
  const text = typeof page?.text === 'string' ? page.text : ''
  if (!text) return []
  const rows = pricingRowEvidence(page)
  const items = []
  const paragraph = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .find((p) => p.length >= minChars && !NAV_NOISE.test(p))
  if (paragraph && !(rows.length > 0 && isPriceTableBlock(paragraph))) {
    items.push(paragraphEvidence(page, paragraph))
  }
  for (const row of rows) {
    if (items.some((item) => item.quote === row.quote)) continue
    items.push(row)
  }
  return items
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
export async function extractEvidence(batch, strategy = null, { client, clampLlm = (fn) => fn(), logger = () => {}, signal, allowStale = false, tally = null } = {}) {
  const policy = strategy?.evidence ?? {}
  // 0.9.5 — a batch failure (typically a provider 429 while two batches are in
  // flight) must not abort the whole run: the same per-page heuristic fallback
  // that covers "the model cited nothing" covers "the model call failed". An
  // aborted run is still rethrown, so wall-clock cancellation keeps working.
  let raw = null
  try {
    raw = await clampLlm(() => client.jsonCall({
      system: SAFETY_SYSTEM,
      user: evidencePrompt({ pages: batch }),
      signal,
      maxTokens: 2600,
    }))
  } catch (error) {
    if (signal?.aborted) throw error
    logger(`evidence batch failed (${error?.message ?? error}); falling back to per-page heuristics`)
    raw = null
  }
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
      const found = heuristicEvidence(page, { minChars: isOfficialPage(page) ? 60 : 120 })
      if (found.length === 0) return
      items.push(...found)
      heuristicCount += found.length
    })
  }
  // 0.9.5 — observability: count batches and where the items came from. The
  // funnel line can only say 采用 J; these three numbers say whether the model
  // extracted the evidence or the heuristic fallback carried the run.
  if (tally) {
    tally.batches += 1
    tally.modelItems += modelCount
    tally.heuristicItems += heuristicCount
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

/**
 * 0.9.5 — how many evidence model batches may be in flight at once. Two, not
 * more: the same limit the page fetcher uses, and a provider sees at most two
 * concurrent JSON calls from this stage instead of one long serial chain.
 */
const EVIDENCE_CONCURRENCY = 2

/**
 * Extract evidence for every page batch, two batches at a time, and merge the
 * clusters in batch order (0.9.5).
 *
 * Before this the main evidence step awaited each 3-4 page batch in turn: ten
 * readable pages on a standard run meant ~86s of serial model latency. Batches
 * are independent, so two can run at once; the results are written back by
 * batch index and merged left to right, because cluster order decides [S#]
 * numbering and the 参考 table. A faster batch never jumps ahead of a slower
 * one. Returns the merged cluster list so the caller can fold it into
 * state.clusters exactly as the serial loop did.
 */
async function extractEvidenceInBatches(pages, { profile, policy, client, clampLlm, logger, signal, allowStale = false, tally = null }) {
  const batches = chunk(pages, profile.batch)
  if (batches.length === 0) return []
  const results = await runWithConcurrency(batches, EVIDENCE_CONCURRENCY, async (batch) => {
    if (signal?.aborted) return []
    return extractEvidence(batch, policy, { client, clampLlm, logger, signal, allowStale, tally })
  }, signal)
  const clusters = []
  // Ordered merge, not `for ... of await`: index order is what keeps 参考 stable.
  for (const items of results) {
    if (Array.isArray(items) && items.length > 0) clusters.push(...groupEvidence(items))
  }
  return clusters
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
 * URLs of pages the refill stages fetched (0.9.6). Two lists, because the gap
 * round keeps its pages out of state.pages while the directed option retry adds
 * them; both are "read at some cost, may still be uncited".
 */
function refillUrlsOf(state) {
  return [
    ...(state?.targetedRefillPages ?? []),
    ...(state?.refillPages ?? []).map((page) => page?.url),
  ].filter(Boolean)
}

/** Sources the brief actually cites (0.9.6's kept-for-visibility pages excluded). */
function citedOnly(sources) {
  return (Array.isArray(sources) ? sources : []).filter((source) => source?.unusedRefill !== true)
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
    // funnel line and the debug row even when nothing was tried. 0.9.3 — the
    // report also says *why* nothing was tried (`skipped`), because a stage that
    // vanishes silently is indistinguishable from "the option has no data".
    targetedRefill: { optionsTried: 0, pagesFetched: 0, optionsResolved: 0, skipped: null, triedOptions: [], resolvedOptions: [] },
    // 0.9.6 — pages fetched by the directed retry. 0.9.5 deleted their sources
    // when the synthesis model did not quote them, so a successful refill could
    // be invisible in 参考; these URLs survive citation hygiene (up to 2) with an
    // explicit （已检索，未被采用） label.
    targetedRefillPages: [],
    // 0.9.6 — the compare candidates the brief will be checked against
    // (checkCompareRows): every one of them must own a table row.
    compareOptions: [],
    adoptedSources: 0,
    officialAdopted: 0,
    // 0.9.5 — adoption diagnosis. `adoptedUrls` is what the reference list
    // actually printed (filled after citation hygiene), so statsOf can say how
    // many read pages were dropped and why instead of only counting them.
    adoptedUrls: [],
    evidenceTally: { batches: 0, modelItems: 0, heuristicItems: 0 },
    fetchFailed: 0,
    // 1.1.0 — pricing render fallback. `renderUsed` is the charge made against
    // RENDER_BUDGET (counted the moment a render request leaves, not when it
    // succeeds), so a run can never exceed the cap even if renders keep failing.
    renderUsed: 0,
    // 1.1.1 — of the adopted sources, how many came from a rendered fetch. A
    // non-zero renderUsed with a zero here means rendering paid off nothing, which
    // the funnel line annotates as （未采用）.
    renderAdopted: 0,
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
      // 1.1.0 — only the pricing channel may spend a render: its seeds are the
      // JavaScript-shell vendor price pages, and no other channel needs them.
      const page = channelId === 'pricing'
        ? await fetchPricingSeedPage(url, { config, state, signal: runSignal, depth: resolvedDepth, logger })
        : await fetchDirect(url, { signal: runSignal, timeoutMs: 20000 })
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
    // 0.9.3 — a compare run still has a directed retry ahead of it (Step 8b). In
    // 0.9.2 ordinary selection could take the whole page budget first, so on a
    // 12-page standard run the retry found `remaining('pages') === 0` and returned
    // silently; the zero-evidence option then read like "no such data exists".
    // Keep up to two slots for that retry. It stacks on top of refillReserve
    // instead of replacing it: that reserve belongs to the gap round, this one to
    // the option retry, and the two stages take pages at different times. It is
    // also never allowed to eat the last ordinary search slot, so a small budget
    // still reads something.
    const compareCandidates = isCompareRun(resolvedMode, policy, state.questionKind)
      ? compareOptions(question, focus)
      : []
    // 0.9.6 — buildResult checks the delivered table against this list: a
    // candidate folded into another candidate's cell costs a visible note.
    state.compareOptions = compareCandidates
    const targetedRefillReserve = compareCandidates.length >= 2
      ? Math.min(2, Math.max(0, pageBudget - usedPrimaryPages - reserve - refillReserve - 1))
      : 0
    // Never fetch a URL the previous run already read: the carried pages are
    // already in state.pages and their evidence is already in state.clusters.
    const ranked = rankHits(dedupeHits(state.hits), { focus, question, boosts })
      .filter((hit) => !seenUrls.has(hit.url))
    // At least one search page when the budget allows it (a resumed run relies on
    // this), but never more than the room left after sitemap/direct pages, so
    // budget.take cannot throw.
    const roomForSearch = Math.max(0, pageBudget - usedPrimaryPages)
    const wantedSearch = Math.max(1, pageBudget - usedPrimaryPages - reserve - refillReserve - targetedRefillReserve)
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
    state.fetchFailed = unread.length
    // Keep the failure reasons: a silently missing source looks like "the web has
    // nothing", which is a lie the answer would inherit. Surface them as gaps.
    state.fetchFailures = unread.slice(0, 3).map((page) => ({ url: page.url, reason: page.reason ?? 'unreadable' }))

    // Step 5b — follow official links found inside the secondary articles we
    // did read (law-firm posts almost always cite EUR-Lex / government texts).
    const newPageCount = Math.max(0, state.pages.filter((page) => !page.provided).length - carriedPages.length)
    const spare = Math.min(
      // 0.9.3 — both reserves are off limits here: refillReserve for the gap
      // round, targetedRefillReserve for the directed option retry.
      Math.max(0, budget.remaining('pages') - refillReserve - targetedRefillReserve),
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
    // 0.9.5 — two batches at a time (EVIDENCE_CONCURRENCY); the merged clusters
    // come back in batch order, so [S#] numbering and 参考 stay deterministic.
    const evidenceClusters = await extractEvidenceInBatches(evidencePages, {
      profile, policy, client, clampLlm, logger, signal: runSignal, allowStale: allStale, tally: state.evidenceTally,
    })
    state.clusters = mergeClusters(state.clusters, evidenceClusters)
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
      state.gaps = await gapRefill({ client, state, profile, budget, runSignal, config, focus, question, logger, clampLlm, needPrimary: missingPrimary || needsLegalText, strategy: policy, reservePages: targetedRefillReserve })
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
      // Same candidate list the page reserve was sized from in Step 4, so the
      // reservation and the retry can never disagree about which options matter.
      const candidates = compareCandidates
      // 0.9.1 — only a real name (≥2 core characters) that is genuinely absent is
      // worth a gap; "A" or a leftover single character would be noise, and the
      // clean-up above already dropped empty/guide-only segments.
      const zeroOptions = candidates.filter((option) => optionCore(option).length >= 2 && countOptionHits(option, state.clusters) === 0)
      if (zeroOptions.length > 0) logger(`zero-evidence options: ${zeroOptions.join(', ')}`)
      // 0.9.2 — a zero count is a fact about the plan, not about the vendor: the
      // queries were planned before anyone knew this option would be uncovered.
      // Retry each one once, in a strictly bounded way, before reporting it.
      state.targetedRefill = await targetedOptionRefill({
        state, profile, budget, runSignal, config, logger, strategy, options: zeroOptions,
        question, mode: resolvedMode, startedAt, depth: resolvedDepth,
      })
      const tried = new Set(state.targetedRefill.triedOptions ?? [])
      // 0.9.3 — a skip is a fact about this round too. Before, a retry killed by
      // the page budget or the wall clock left no trace at all, so the zero-
      // evidence line read as if nobody had looked (the 0.9.2 regression).
      const skipped = state.targetedRefill.skipped ?? null
      // Recompute after the refill: new evidence may now cover an option, and a
      // covered option must keep the model's citation instead of being blanked.
      const stillZero = zeroOptions.filter((option) => countOptionHits(option, state.clusters) === 0)
      for (const option of stillZero) {
        // 0.9.7 — the wording is deliberately the "omitted" form here: this runs
        // before synthesis, so no compare table exists yet. An option that ends
        // up with a placeholder row (applyZeroEvidenceOptions guarantees one) is
        // re-worded to 「在对比表中占位，但关键属性未取得」 by buildResult(), which is
        // the first place the final table is known (see realignZeroEvidenceGapText
        // in lib/brief.js).
        const line = zeroEvidenceGapText(option)
        if (state.gaps.some((gap) => gap.startsWith(line))) continue
        // Say what happened, not just that the option is blank: the retry ran and
        // came back empty, or the budget/wall clock stopped it before the query.
        const suffix = skipped === 'budget'
          ? '（页预算耗尽，未做定向检索）'
          : skipped === 'time'
            ? '（剩余时间不足，未做定向检索）'
            : tried.has(option)
              ? '（已定向检索 1 次仍未获证）'
              : ''
        state.gaps.push(`${line}${suffix}`)
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
        compareOptions: state.compareOptions ?? [],
        clusters: state.clusters,
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
    if (primaryAbsent) {
      gaps.push('缺少一手或高质量来源：现有证据均为二手解读，关键事实需以官方原文复核')
    }
    // Gates are applied here so the fallback brief and the gap text already see a
    // plausible verdict. 1.1.2 — the *delivered* verdict is recomputed below,
    // once the adopted reference list (and with it the official share) exists:
    // 「采用条数 + 官方占比」 is what the reader can audit in 参考.
    let confidence = computeConfidence(state.clusters, {
      ...confidenceGates,
      missingPrimary: primaryAbsent,
    }, state.questionKind)
    let synthError = ''
    const synthOptions = (maxTokens, temperature) => ({
      system: SAFETY_SYSTEM,
      user: synthPrompt({
        question, focus, language,
        clusters: state.clusters,
        constraints: state.analysis.constraints,
        criteria: state.analysis.criteria,
        sourceList, depth: resolvedDepth, hasPrimary, prior, mode: resolvedMode,
        questionKind: state.questionKind,
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
    const { brief: cleaned, sources: finalSources } = validateCitations(withConflicts, sources, {
      refillUrls: refillUrlsOf(state),
      maxKept: 2,
    })
    // 采用 (J) is the number of sources the brief actually cites — the kept
    // refill pages of 0.9.6 are listed in 参考 but marked 未被采用, so they must
    // not inflate the funnel.
    const adopted = citedOnly(finalSources)
    state.adoptedSources = adopted.length
    // 0.9.5 — remember *which* pages survived, not only how many: statsOf needs
    // the URL set to classify the read-but-unused pages by reason.
    state.adoptedUrls = adopted.map((source) => canonicalKey(source.url) || String(source.url ?? ''))
    // 0.6.2 — of the adopted references, how many rest on a first-party page
    // (official domain or targeted sitemap channel).
    state.officialAdopted = adopted.filter((source) => isOfficialPage(source)).length
    // 1.1.1 — a render fallback that produced no *adopted* source still charges a
    // slot in the funnel's 渲染兜底 count. Record whether any adopted source came
    // from rendering, so the flow line can annotate the count with （未采用） and a
    // reader does not take it for "one page was read through rendering".
    state.renderAdopted = adopted.filter((source) => source?.via === 'render').length
    // A declared section that had to be filled with a placeholder is a visible
    // unknown, so it costs one confidence notch (only when the pack declares it).
    const absentSections = missingSections(cleaned, requiredSections)
    // 1.1.2 — the delivered verdict is the evidence ladder over the adopted
    // reference list (official share + how many sources carry the brief), capped
    // by the gates the pipeline already owns: unresolved conflict, missing
    // first-party source, a missing declared section, zero-evidence options and
    // the pack's own ceiling. See computeConfidence's `evidence` option.
    confidence = computeConfidence(state.clusters, {
      ...confidenceGates,
      missingPrimary: primaryAbsent,
      missingSections: absentSections.length > 0,
      evidence: { adopted: state.adoptedSources, official: state.officialAdopted },
      zeroEvidence: (state.zeroEvidenceOptions ?? []).length,
    }, state.questionKind)
    // The thin-evidence gap must describe the verdict that is actually delivered,
    // so it is derived from the final level instead of the pre-synthesis estimate.
    if (confidence === 'low' && gaps.length === 0) {
      gaps.push('证据不足：关键事实缺少一手或独立来源确认')
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
        compareOptions: state.compareOptions ?? [],
        clusters: state.clusters,
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
        { refillUrls: refillUrlsOf(state), maxKept: 2 },
      )
      const adopted = citedOnly(finalSources)
      state.adoptedSources = adopted.length
      state.adoptedUrls = adopted.map((source) => canonicalKey(source.url) || String(source.url ?? ''))
      state.officialAdopted = adopted.filter((source) => isOfficialPage(source)).length
      // 1.1.1 — see the success path: a render attempt that produced no adopted
      // source is annotated as （未采用） on the funnel line.
      state.renderAdopted = adopted.filter((source) => source?.via === 'render').length
      return finalize(buildResult({
        brief: cleaned, sources: finalSources,
        confidence: computeConfidence(state.clusters, {
          ...confidenceGates,
          missingPrimary: resolvedDepth !== 'quick' && !hasPrimaryClusters(state.clusters),
          missingSections: missingSections(cleaned, requiredSections).length > 0,
          evidence: { adopted: state.adoptedSources, official: state.officialAdopted },
          zeroEvidence: (state.zeroEvidenceOptions ?? []).length,
        }, state.questionKind),
        gaps: state.gaps, partial: true, depth: resolvedDepth, stats: buildStats(),
        conflicts,
        assertionConflicts,
        divergences: entityDivergences,
        selfContradictions,
        sections: requiredSections,
        pages: state.pages,
        zeroEvidenceOptions: state.zeroEvidenceOptions ?? [],
        compareOptions: state.compareOptions ?? [],
        clusters: state.clusters,
      }))
    }
    if (aborted) throw new Error('研究在获得任何证据前被中断（超时或用户取消）')
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Any evidence from a first-party or high-trust source? (1.1.2)
 *
 * The gate asks "do we hold a source that can carry a factual claim at all", so
 * it accepts both the documented first-party tiers (`isPrimarySource`) and the
 * high-trust hosts a `domainTrust` of 2+ covers (standards bodies, `.gov`/`.edu`,
 * curated repositories and papers). Documentation pages on vendors the
 * OFFICIAL_DOMAINS list never heard of used to fail this gate and forced a `low`
 * verdict on evidence that was entirely first-party.
 */
export function hasPrimaryClusters(clusters) {
  return clusters.some((cluster) => cluster.evidence.some((item) => (
    domainTrust(item.url) >= 2 || isPrimarySource(item.url)
  )))
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

async function gapRefill({ client, state, profile, budget, runSignal, config, focus, question, logger, clampLlm, needPrimary = false, strategy = null, reservePages = 0 }) {
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
  // 0.9.3 — pages promised to the directed option retry are not available to this
  // round: it runs after us and a compare question needs it most.
  const room = Math.max(0, budget.remaining('pages') - Math.max(0, reservePages))
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
    const spare = Math.min(2, Math.max(0, budget.remaining('pages') - Math.max(0, reservePages)))
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
  // 0.9.5 — the refill round uses the same two-batch evidence extraction, with
  // the same ordered merge, so both paths share one latency profile.
  const refillClusters = await extractEvidenceInBatches(pricingFirst(refillEvidencePages), {
    profile, policy: strategy, client, clampLlm, logger, signal: runSignal, allowStale: refillAllStale, tally: state.evidenceTally,
  })
  state.clusters = mergeClusters(state.clusters, refillClusters)
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
  // 0.9.5 — 30s → 45s. With evidence extraction parallelised, a standard run
  // reaches this stage with far more clock left, so the reserve can cover a
  // query *and* the fetch it needs (the retry costs ~10-15s) instead of only
  // the synthesis tail it was sized for.
  minRemainingMs: 45000,
  // 0.9.5 — degraded mode: under the 45s guard there is still time for exactly
  // one query if 20s remain. Below that even one query would eat the synthesis
  // reserve, so the stage stays skipped and says so.
  degradedMinRemainingMs: 20000,
})

/**
 * 0.9.6 — vendor host map for price/comparison questions.
 *
 * The 0.9.5 price run queried `豆包 官方 价格` and got resellers and blog round-
 * ups; the vendor's own pricing page (volcengine.com) never became a candidate.
 * A `site:` query against the vendor host is the cheapest way to make the fetch
 * land on first-party text, so each known vendor gets an explicit host.
 */
export const PRICING_HOSTS = Object.freeze([
  Object.freeze({ pattern: /豆包|doubao|火山方舟|volcengine/i, host: 'volcengine.com' }),
  Object.freeze({ pattern: /qwen|通义|千问/i, host: 'help.aliyun.com' }),
  Object.freeze({ pattern: /deepseek/i, host: 'api-docs.deepseek.com' }),
  Object.freeze({ pattern: /kimi|moonshot/i, host: 'platform.moonshot.cn' }),
  Object.freeze({ pattern: /glm|智谱|chatglm/i, host: 'open.bigmodel.cn' }),
])

/** The vendor pricing host for an option name, '' when we do not know it. */
export function pricingHostFor(option) {
  const name = String(option ?? '').trim()
  if (!name) return ''
  const hit = PRICING_HOSTS.find(({ pattern }) => pattern.test(name))
  return hit ? hit.host : ''
}

/**
 * The directed query for one option. A known vendor gets `site:<host>` so the
 * engine cannot drift to a comparison blog; an unknown option falls back to a
 * per-million-token wording that still describes the unit we need.
 */
export function pricingTargetQueries(option) {
  const name = String(option ?? '').trim()
  if (!name) return []
  const host = pricingHostFor(name)
  return [host ? `site:${host} ${name} 价格 tokens 百万` : `${name} API 价格 每百万 tokens`]
}

function hostnameOf(url) {
  try {
    return new URL(String(url ?? '')).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/** The known vendor host a URL belongs to ('' when not a pricing host). */
export function pricingHostOfUrl(url) {
  const host = hostnameOf(url)
  if (!host) return ''
  const hit = PRICING_HOSTS.find((entry) => host === entry.host || host.endsWith(`.${entry.host}`))
  return hit ? hit.host : ''
}

/**
 * 1.1.0 — how many renders one run may spend, independent of the page budget.
 *
 * A render is a request to a third-party reader (r.jina.ai) that costs seconds
 * and is not free; the page budget counts pages we read, and a render is the
 * same page read a second way. Two per run is enough to rescue the DeepSeek and
 * Ali price lists of a typical run while keeping a dead weekend from turning
 * into ten timed-out proxy calls.
 */
export const RENDER_BUDGET = 2

function renderAllowed({ config, depth, state }) {
  if (config?.renderFallback === false) return false
  // Only the deeper profiles: a quick run's page budget cannot afford a 20s
  // render, and quick pricing answers may legitimately cite secondary sources.
  if (depth !== 'standard' && depth !== 'deep') return false
  if (typeof config?.__fetchRaw !== 'function') return false
  return Math.max(0, RENDER_BUDGET - (state?.renderUsed ?? 0)) > 0
}

/**
 * 1.1.0 — fetch one pricing seed page, with the render fallback.
 *
 * The regular fetch runs first and wins whenever it returns a usable body; a
 * render is attempted only for a failed/thin page on a whitelisted host, in a
 * standard/deep run, while the render budget lasts. The budget is charged
 * *before* the request: a render that times out still cost the request, and a
 * charge on success only would let a run of broken renders burn unbounded time.
 * Never throws — the caller keeps the original failure, annotated with
 * `renderReason`, so 未解决 can explain the miss.
 */
async function fetchPricingSeedPage(url, { config, state, signal, depth = 'standard', logger = () => {}, timeoutMs = 20000 }) {
  const fetchPage = config?.__fetchPage
  if (typeof fetchPage !== 'function') return null
  let first = null
  try {
    first = await fetchPage(url, { signal, timeoutMs })
  } catch (error) {
    logger(`pricing seed fetch failed for ${url}: ${error?.message ?? error}`)
    first = { url, finalUrl: url, domain: hostOf(url), text: '', ok: false, via: 'raw', reason: error?.message ?? 'fetch failed' }
  }
  if (first?.ok && String(first.text ?? '').trim().length >= MIN_USEFUL_CHARS) return first
  if (!renderAllowed({ config, depth, state })) return first
  if (!isRenderHost(url, config.renderHosts)) return first
  state.renderUsed += 1
  const renderer = createRenderFetcher({ fetchRaw: config.__fetchRaw, config, logger })
  const rendered = await renderer(url, { signal, timeoutMs: 20000, reason: first?.reason ?? 'thin body' })
  if (rendered?.ok) {
    logger(`pricing render fallback adopted for ${url} (${state.renderUsed}/${RENDER_BUDGET})`)
    return rendered
  }
  logger(`pricing render fallback failed for ${url}: ${rendered?.renderReason ?? 'unknown'}`)
  // A thin page that did come back is still the original result; keep it intact
  // and let the downstream readability rules decide. A failed one gains the
  // render reason so the gap line is not silent about the retry.
  if (first?.ok) return first
  return { ...(first ?? { url, finalUrl: url, domain: hostOf(url), text: '', ok: false, via: 'raw' }), renderReason: rendered?.renderReason ?? 'render failed' }
}

/**
 * 0.9.7 — the one page per vendor that actually carries its price list.
 *
 * Not to be confused with `PRICING_SEEDS` in `lib/strategies.js`, which is the
 * source-pack *channel seed list* (several URLs per pack, fetched in Step 2b
 * before any retrieval). This map answers a different question: when one
 * candidate is still unpriced after synthesis, which single URL should the
 * directed retry open first? A `site:` query lands on the right host but not
 * necessarily on the price page (the 0.9.6 run got `volcengine.com/article/…`
 * and `ai.volcengine.com/model` instead of `docs/82379/1099320`).
 */
export const PRICING_SEEDS = Object.freeze([
  Object.freeze({ pattern: /豆包|doubao|火山方舟|volcengine/i, url: 'https://www.volcengine.com/docs/82379/1099320' }),
  Object.freeze({ pattern: /qwen|通义|千问/i, url: 'https://help.aliyun.com/zh/model-studio/models' }),
  Object.freeze({ pattern: /deepseek/i, url: 'https://api-docs.deepseek.com/quick_start/pricing' }),
  Object.freeze({ pattern: /kimi|moonshot/i, url: 'https://platform.moonshot.cn' }),
  Object.freeze({ pattern: /glm|智谱|chatglm/i, url: 'https://open.bigmodel.cn/pricing' }),
])

/** The canonical price page for an option, '' when the vendor is unknown. */
export function pricingSeedFor(option) {
  const name = String(option ?? '').trim()
  if (!name) return ''
  const hit = PRICING_SEEDS.find(({ pattern }) => pattern.test(name))
  return hit ? hit.url : ''
}

// A page opened by URL (not by search) still has to prove it is the price list:
// a vendor redesign can turn the old doc id into a login page or a 404 body with
// `ok: true`. Prices are printed as 元/百万, ￥, US$, per 1M tokens or per 1000
// tokens; text without one of those is not evidence and the retry falls back to
// the `site:` search instead of spending the page slot on a dead page.
const PRICING_SEED_TEXT = /元|￥|\$|\/百万|1M|1000\s*tokens/

/** Does this body carry a price feature (see PRICING_SEED_TEXT)? */
export function hasPricingSeedText(text) {
  return PRICING_SEED_TEXT.test(String(text ?? ''))
}

// "0.8 元" / "0.8 元/百万 tokens" / "US$0.5 per 1M tokens" all describe a price;
// the unit half is what 0.9.5 missed on the volcengine page (it printed prices
// as 元/百万, not "pricing").
const PRICE_AMOUNT = /(?:\d|[一二三四五六七八九十])\s*(?:元|块|美元|USD|RMB|¥|\$)/i
const PRICE_UNIT = /百万|千\s*tokens|1M|1K|per\s+million|per\s+1M|tokens?\s*(?:价格|单价)/i

/**
 * A readable page that is likely the vendor's own price list: the host is one of
 * PRICING_HOSTS and the text carries a price amount or a token price unit.
 */
export function isPricingEvidencePage(page) {
  if (!pricingHostOfUrl(page?.url)) return false
  const text = String(page?.text ?? '')
  return PRICE_AMOUNT.test(text) || PRICE_UNIT.test(text)
}

/**
 * Move pricing pages to the front of a batch. Ordered extraction aborts (wall
 * clock) and per-batch caps mean the first batch is the one that reliably gets
 * read, so "the price page made it into the evidence stage" is exactly this
 * position, not merely its presence in the array.
 */
function pricingFirst(pages) {
  const list = Array.isArray(pages) ? pages : []
  if (list.length < 2) return list.slice()
  const hot = list.filter(isPricingEvidencePage)
  if (hot.length === 0 || hot.length === list.length) return list.slice()
  return [...hot, ...list.filter((page) => !hot.includes(page))]
}

/** Hits from a vendor pricing host first, order otherwise preserved. */
function pricingHostsFirst(hits) {
  return (Array.isArray(hits) ? hits : [])
    .map((hit, index) => ({ hit, index, rank: pricingHostOfUrl(hit?.url) ? 0 : 1 }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ hit }) => hit)
}

/** Is this run asking about money? Pack templates, the question, or the options. */
export function isPricingScenario({ strategy = null, question = '', mode = null, options = [] } = {}) {
  const label = String(mode ?? '')
  if (label === 'pricing') return true
  const templates = [
    ...(strategy?.queries?.extraTemplates ?? []),
    ...(strategy?.queries?.templates ?? []),
  ].join(' ')
  if (/pricing|price|价格|报价|收费|计费/i.test(templates)) return true
  if (/价格|定价|报价|收费|计费|多少钱|单价|pricing|price/i.test(String(question ?? ''))) return true
  if (label === 'compare' && (Array.isArray(options) ? options : []).some((option) => pricingHostFor(option))) return true
  return false
}

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
async function targetedOptionRefill({ state, profile, budget, runSignal, config, logger = () => {}, strategy = null, options = [], question = '', mode = null, startedAt = Date.now(), depth = 'standard' }) {
  let targets = uniqueStrings((options ?? []).map((option) => String(option ?? '').trim()).filter((option) => option.length >= 2))
    .slice(0, TARGETED_REFILL.maxOptions)
  // 0.9.3 — the report is written *before* any guard runs. 0.9.2 only returned a
  // filled-in report on the happy path, so a run stopped by the page budget or the
  // wall clock reported `optionsTried: 0` and the brief could not tell "the retry
  // found nothing" from "the retry never happened".
  const report = {
    // Options that entered the retry, not options that got a query: with a page
    // budget of zero this is still the number of options waiting for a directed
    // search, which is exactly what the reader has to be told.
    optionsTried: targets.length,
    pagesFetched: 0,
    optionsResolved: 0,
    // 'budget' | 'time' | null — why the retry did not run (or stopped before it
    // could start), so the gap line and the funnel line can say so.
    skipped: null,
    triedOptions: [],
    resolvedOptions: [],
  }
  if (targets.length === 0) return report
  const timeLeft = () => profile.wallMs - (Date.now() - startedAt)
  // A skip is only a *stage* skip when no query went out at all; once one option
  // was tried the counts below describe a retry that ran, and calling it skipped
  // would be the same kind of lie in the other direction.
  const markSkipped = (reason) => {
    if (report.triedOptions.length === 0) report.skipped = reason
  }
  // Budget safety in one line: three pages, never more than the profile allows,
  // never more than the run has left. 0.9.5 — checked before the wall clock now,
  // because the degraded fallback below has to know whether a page slot exists.
  let pagesLeft = Math.min(TARGETED_REFILL.maxPages, Math.max(0, Number(profile.pages) || 0), budget.remaining('pages'))
  if (pagesLeft <= 0) {
    logger('targeted refill skipped: no page budget left')
    report.skipped = 'budget'
    return report
  }
  // Same wall-clock rule as the gap round, one notch stricter: synthesis and
  // repair still have to fit in what is left, so a run under 45s skips outright.
  // 0.9.5 — except for one last query: with the evidence already extracted we
  // can afford a single directed search + one page if 20s remain, and something
  // is better than a skipped stage when the wall clock is the only blocker.
  // This is best-effort by design: if it cannot run, the skip label stands.
  let degraded = false
  if (timeLeft() < TARGETED_REFILL.minRemainingMs) {
    if (timeLeft() < TARGETED_REFILL.degradedMinRemainingMs) {
      logger('targeted refill skipped: wall clock reserve')
      report.skipped = 'time'
      return report
    }
    logger('targeted refill degraded: one query before the wall-clock reserve')
    targets = targets.slice(0, 1)
    pagesLeft = Math.min(pagesLeft, 1)
    degraded = true
  }
  const core = targetedCoreTerm(strategy)
  // 0.9.6 — a price comparison needs the vendor's own price page, which a
  // generic "官方 价格" query rarely returns (resellers and round-ups rank
  // higher). `pricing` switches the query builder below to site:<vendor host>.
  const pricing = isPricingScenario({ strategy, question, mode, options: targets })
  // 0.9.7 — a seed fetch and the search after it are one attempt for the option,
  // so it is recorded once (an option can now enter via either path).
  const noteTried = (option) => {
    if (!report.triedOptions.includes(option)) report.triedOptions.push(option)
  }
  const fetched = new Set(
    [...state.pages, ...(state.refillPages ?? [])]
      .map((page) => canonicalKey(page?.url) || String(page?.url ?? ''))
      .filter(Boolean),
  )
  // 0.9.7 — a URL this run already failed to read (a dead seed caught in Step 2b,
  // most often) is not retried here: nothing changes seconds later, and the retry
  // would spend a page slot (plus up to the fetch timeout) for the same 404.
  const unreachable = new Set(
    [...(state.sourceFailures ?? []), ...(state.officialFetchFailures ?? [])]
      .map((failed) => canonicalKey(failed?.url) || String(failed?.url ?? ''))
      .filter(Boolean),
  )
  for (const option of targets) {
    if (runSignal.aborted) {
      markSkipped('time')
      break
    }
    if (pagesLeft <= 0) {
      markSkipped('budget')
      break
    }
    // 0.9.5 — the degraded path already decided it can afford exactly one
    // query, so it must not immediately trip the 45s guard it just fell under.
    if (!degraded && timeLeft() < TARGETED_REFILL.minRemainingMs) {
      logger('targeted refill stopped: wall clock reserve')
      markSkipped('time')
      break
    }
    // 0.9.7 — a pricing retry opens the vendor's canonical price page by URL
    // before it searches. The 0.9.6 run's `site:volcengine.com` query landed on
    // an article page and a model list, not the price list, and the page budget
    // was spent on pages that never state a price. One URL, one page slot; any
    // miss (404, unreadable, no price text) falls through to the `site:` search.
    if (pricing) {
      const seedUrl = pricingSeedFor(option)
      const seedKey = seedUrl ? canonicalKey(seedUrl) || seedUrl : ''
      // Already read in this run (e.g. the pack's Step 2b direct seeds): fetching
      // it again would spend a second page slot on the same bytes. The same goes
      // for a seed Step 2b already failed on (`unreachable`).
      if (seedUrl && seedKey && !fetched.has(seedKey) && !unreachable.has(seedKey) && pagesLeft > 0) {
        budget.take('pages', 1)
        pagesLeft -= 1
        noteTried(option)
        let page = null
        try {
          // 1.1.0 — the same render fallback as the channel seeds: a vendor
          // price list that only renders client-side is worth the extra request
          // here too, because this page *is* the retry.
          page = await fetchPricingSeedPage(seedUrl, { config, state, signal: runSignal, depth, logger, timeoutMs: 15000 })
        } catch (error) {
          logger(`targeted refill seed fetch failed for ${option}: ${error?.message ?? error}`)
        }
        // Record the attempt either way, so a failed seed is not retried through
        // the search hits below (which would charge the budget twice for one URL).
        fetched.add(canonicalKey(page?.url ?? seedUrl) || seedKey)
        if (page && page.ok && hasPricingSeedText(page.text)) {
          markStalePages([page])
          const key = canonicalKey(page.url) || String(page.url ?? '')
          const knownSeed = state.pages.some((known) => (canonicalKey(known?.url) || String(known?.url ?? '')) === key)
          if (!knownSeed) {
            // 0.9.8 — tag the page as a seed so the price-row scan also covers a
            // vendor whose seed host is not in PRICING_HOSTS. `via` is only read by
            // isOfficialPage (sitemap), gradeSource (jina/render) and the pricing
            // scan, so the tag changes nothing else.
            // 1.1.0 — a rendered page keeps its `via: 'render'` so gradeSource
            // can downgrade it and the reference line can say so; only the plain
            // fetch is re-tagged as a seed.
            const seedPage = { ...page, via: page.via === 'render' ? 'render' : 'seed' }
            state.pages.push(seedPage)
            state.targetedRefillPages = [...(state.targetedRefillPages ?? []), page.url].filter(Boolean)
            report.pagesFetched += 1
            const found = heuristicEvidence(page, { minChars: isOfficialPage(page) ? 60 : 120 })
            if (found.length > 0) state.clusters = mergeClusters(state.clusters, groupEvidence(found))
          }
          if (countOptionHits(option, state.clusters) > 0) {
            report.optionsResolved += 1
            report.resolvedOptions.push(option)
          }
          logger(`targeted refill seed adopted for ${option}: ${seedUrl}`)
          // The seed page is this option's whole retry: a search on top would
          // only re-fetch the same vendor page.
          if (degraded) break
          continue
        }
        if (page && page.ok) {
          logger(`targeted refill seed for ${option} has no price text; falling back to search`)
        }
      }
    }
    // The seed attempt took the last page slot; a search would have no page left
    // to fetch, so it is skipped rather than reported as a retry that found
    // nothing.
    if (pagesLeft <= 0) {
      logger('targeted refill stopped: no page budget left after the seed fetch')
      markSkipped('budget')
      break
    }
    const query = pricing ? pricingTargetQueries(option)[0] : `${option} ${core}`
    // Record the attempt before the search so even a dead engine leaves a trace
    // (the debug line prints every refill query, gapRefill's included).
    state.refillQueries = [...(state.refillQueries ?? []), query]
    noteTried(option)
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
    // the same host would re-read the page we already have. 0.9.6 — the vendor
    // pricing host is served first, so the page budget cannot be spent on two
    // blogs before the price page is ever fetched.
    const domains = new Set()
    const picks = []
    for (const hit of pricingHostsFirst(hits)) {
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
    // 0.9.6 — the vendor price page goes first: extraction is ordered and a
    // wall-clock abort drops whatever sits in a late batch.
    const pagesForEvidence = pricingFirst(live.length > 0 ? live : readable)
    const known = new Set(state.pages.map((page) => canonicalKey(page?.url) || String(page?.url ?? '')))
    const added = readable.filter((page) => {
      const key = canonicalKey(page.url) || String(page.url ?? '')
      if (!key || known.has(key)) return false
      known.add(key)
      return true
    })
    state.pages.push(...pricingFirst(added))
    // 0.9.6 — remember *which* pages the retry fetched: validateCitations keeps
    // up to two uncited ones in 参考 with an explicit （已检索，未被采用） label
    // instead of deleting the evidence the run just paid for.
    state.targetedRefillPages = [
      ...(state.targetedRefillPages ?? []),
      ...added.map((page) => page.url).filter(Boolean),
    ]
    report.pagesFetched += added.length
    // 0.6.2's fallback, reused rather than re-implemented: these pages never went
    // through the model, so the heuristic paragraph is all the evidence they can
    // carry. Official/sitemap pages get the relaxed 60-char gate, as in Step 6.
    const items = []
    for (const page of pagesForEvidence) {
      items.push(...heuristicEvidence(page, { minChars: isOfficialPage(page) ? 60 : 120 }))
    }
    if (items.length > 0) state.clusters = mergeClusters(state.clusters, groupEvidence(items))
    if (countOptionHits(option, state.clusters) > 0) {
      report.optionsResolved += 1
      report.resolvedOptions.push(option)
    }
    // 0.9.5 — one query is the whole degraded budget; stop before the reserve
    // is eaten.
    if (degraded) break
  }
  // A retry that ran reports the options that actually went out, so `定向回补 N 项`
  // can never overstate; a skip keeps the entering count above, because that is
  // the number of options left unserved.
  if (report.skipped === null) report.optionsTried = report.triedOptions.length
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
  // 0.9.5 — one page can appear in both state.pages and refillPages; classify
  // each URL once or the reason counts double up.
  const uniqueReadable = []
  const seenReadable = new Set()
  for (const page of readablePages) {
    const key = canonicalKey(page?.url) || String(page?.url ?? '')
    if (!key || seenReadable.has(key)) continue
    seenReadable.add(key)
    uniqueReadable.push(page)
  }
  const readable = uniqueReadable.length
  // 0.9.5 — adoption diagnosis. The funnel can say 可读 K · 采用 J, but not where
  // the K-J pages went. Classify every read page that is not in the reference
  // table into one of four buckets, using the same heuristicEvidence gate the
  // extraction path uses, so the number in the brief is measured, not guessed.
  const evidenceKeys = new Set()
  for (const cluster of state.clusters ?? []) {
    for (const item of cluster.evidence ?? []) {
      const key = canonicalKey(item.url) || String(item.url ?? '')
      if (key) evidenceKeys.add(key)
    }
  }
  const adoptedKeys = new Set(state.adoptedUrls ?? [])
  let droppedNoEvidence = 0
  let droppedBelowMinChars = 0
  let droppedModelNoClaim = 0
  let droppedStale = 0
  let droppedUncited = 0
  for (const page of uniqueReadable) {
    if (!page || page.provided) continue
    const key = canonicalKey(page.url) || String(page.url ?? '')
    if (adoptedKeys.has(key)) continue
    if (evidenceKeys.has(key)) {
      // Evidence survived extraction but not citation hygiene / synthesis.
      droppedUncited += 1
      continue
    }
    droppedNoEvidence += 1
    if (page.stale) droppedStale += 1
    else if (heuristicEvidence(page, { minChars: isOfficialPage(page) ? 60 : 120 }).length > 0) droppedModelNoClaim += 1
    else droppedBelowMinChars += 1
  }
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
    // 0.9.3 — `skipped` ('budget' | 'time' | null) is part of the stat because a
    // retry that never ran must not be reported as a retry that found nothing.
    targetedRefill: {
      optionsTried: state.targetedRefill?.optionsTried ?? 0,
      pagesFetched: state.targetedRefill?.pagesFetched ?? 0,
      optionsResolved: state.targetedRefill?.optionsResolved ?? 0,
      skipped: state.targetedRefill?.skipped ?? null,
    },
    // 0.9.5 — evidence extraction observability: how many model batches ran and
    // how many items the model produced versus the per-page heuristic fallback.
    // A run whose adopted count sits at 1 because the model was silent looks
    // identical to one where the pages were thin; these three numbers tell them
    // apart. Batches are counted per index, not per attempt, so a retried batch
    // is not double counted.
    evidenceBatches: state.evidenceTally?.batches ?? 0,
    evidenceModelItems: state.evidenceTally?.modelItems ?? 0,
    evidenceHeuristicItems: state.evidenceTally?.heuristicItems ?? 0,
    // 0.9.5 — adoption diagnosis behind `可读 K · 采用 J`: pages whose fetch
    // failed, pages that produced no evidence at all (and why: text under the
    // 60/120-char gate, stale beyond use, or a readable page the model never
    // made a claim about), and pages that had evidence but were dropped by
    // citation validation.
    fetchFailed: state.fetchFailed ?? 0,
    // 1.1.0 — renders charged against RENDER_BUDGET this run (0 on every non-
    // pricing run); the funnel line mentions it only when it is non-zero.
    renderUsed: state.renderUsed ?? 0,
    // 1.1.1 — adopted sources that came from a rendered fetch. `renderUsed` counts
    // attempts; this counts what made it into 参考, so the flow line can say
    // （未采用） when rendering was charged for but nothing was adopted.
    renderAdopted: state.renderAdopted ?? 0,
    droppedNoEvidence,
    droppedBelowMinChars,
    droppedModelNoClaim,
    droppedStale,
    droppedUncited,
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
