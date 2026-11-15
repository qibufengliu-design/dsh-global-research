/**
 * The research pipeline. Plain functions + an injected dependency object, so
 * every step is testable without DSH, network, or a model.
 */
import { Budget, BudgetExceeded, jaccard, tokenSet, heuristicSubQuestions, rankHits, dedupeHits, truncate, uniqueStrings, domainTrust, isOfficialDomain, extractUrls } from './util.js'
import { searchAll } from './engines.js'
import { createLlmClient } from './llm.js'
import {
  appendConflictSection, appendReferences, assignSourceIds, buildResult, computeConfidence, fallbackBrief, validateCitations,
} from './brief.js'
import { analyzePrompt, evidencePrompt, gapPrompt, planPrompt, repairPrompt, SAFETY_SYSTEM, synthPrompt } from './prompts.js'
import { pickVerticals, searchVerticals } from './verticals.js'

export const DEPTH_PROFILES = {
  quick: { queries: 2, pages: 3, llmCalls: 6, gapRounds: 0, wallMs: 90000, batch: 3, candidates: 12, synthTokens: 2600 },
  standard: { queries: 6, pages: 12, llmCalls: 14, gapRounds: 1, wallMs: 180000, batch: 3, candidates: 40, synthTokens: 5200 },
  deep: { queries: 16, pages: 30, llmCalls: 28, gapRounds: 1, wallMs: 300000, batch: 4, candidates: 80, synthTokens: 7000 },
}

const DEEP_SIGNALS = /对比|选型|调研|方案|迁移|替代|是否值得|取舍|优劣|benchmark|\bvs\.?\b|compare|comparison|migrate|migration|alternatives?|trade-?offs?|which .* should/i
const QUICK_SIGNALS = /是什么|多少|哪一年|谁|定义|what is|who is|how many|when did/i

export function autoDepth(question, focus = []) {
  const text = String(question ?? '')
  if (DEEP_SIGNALS.test(text) || focus.length >= 2) return 'deep'
  const constraintCount = (text.match(/[必须需限]/g) ?? []).length
  if (constraintCount >= 2) return 'deep'
  if (text.length < 60 && QUICK_SIGNALS.test(text)) return 'quick'
  return 'standard'
}

export function resolveDepth({ depth, question, focus, config, deepUsed = 0 }) {
  const requested = depth && depth !== 'auto' ? depth : autoDepth(question, focus)
  if (requested === 'deep' && deepUsed >= (config.maxDeepPerSession ?? 5)) return 'standard'
  return DEPTH_PROFILES[requested] ? requested : 'standard'
}

/** Deterministic query plan: per-subquestion variants first, then a compact fallback. */
export function buildQueries(subQuestions, focus, question, limit) {
  const out = []
  for (const sub of subQuestions) {
    const text = typeof sub === 'string' ? sub : sub.q
    if (!text) continue
    out.push(text)
    if (focus.length > 0) out.push(`${text} ${focus.join(' ')}`)
    // `site:github.com` only makes sense for code-shaped subquestions; forcing it
    // on policy/regulatory questions hides the primary sources.
    const codeish = /github|npm|pip|library|库|包|api|sdk|报错|error/i.test(text)
    out.push(codeish ? `${text} site:github.com` : `${text} 官方`)
  }
  // Long questions make poor engine queries (and DDG sometimes challenges them);
  // keep the first sentence as a last-resort fallback instead of the raw text.
  // Chinese questions have no word boundaries, so also cut short fragments: a
  // 40-character sentence rarely matches anything, its 8–12 character clauses do.
  const compact = String(question ?? '').split(/[。？！?!\n]/)[0].trim().slice(0, 100)
  if (compact) out.push(compact)
  if (compact.length > 24) out.push(...shortFragments(compact))
  // English engines answer many Chinese questions far better through their
  // English terms; if the planner produced no Latin query, add one ourselves.
  if (!out.some((query) => /[a-z]{4,}/i.test(query) && !/[\u4e00-\u9fff]/.test(query))) {
    const latin = latinTopic(`${question} ${focus.join(' ')}`)
    if (latin) out.push(latin, `${latin} official documentation`)
  }
  return uniqueStrings(out).slice(0, limit)
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
// of silently researching a different question.
export function looksLikeFollowUp(question) {
  const text = String(question ?? '').trim()
  if (text.length === 0 || text.length > 80) return false
  return /(上面|上述|前述|刚才|前面|第\s*[一二三四五六七八九十0-9]+\s*条|展开(说|讲)|这个(方案|结论|说法|观点)|把它|它(指|说|再)|继续(展开|说说)|接上|上一条)/u.test(text)
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
  }
}

/** Model-free evidence fallback: first substantial paragraph of each page. */
const NAV_NOISE = /skip to content|skip navigation|cookie|consent|subscribe to our|sign in|log in|all rights reserved|privacy policy/i

function heuristicEvidence(page) {
  const paragraph = page.text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .find((p) => p.length >= 120 && !NAV_NOISE.test(p))
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
  }
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
  question, focus = [], depth = 'auto', outputLanguage = 'auto', context = '', mode = 'explain',
  resume = null, onState = null,
  config = {}, web, llm, selection, signal, logger = () => {}, deepUsed = 0,
}) {
  const prior = truncate(String(context ?? '').trim(), 2000)
  const resolvedMode = ['explain', 'compare', 'track', 'evaluate'].includes(mode) ? mode : 'explain'
  const startedAt = Date.now()
  const resolvedDepth = resolveDepth({ depth, question, focus, config, deepUsed })
  const profile = DEPTH_PROFILES[resolvedDepth]
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
    hits: [],
    pages: [...carriedPages],
    clusters: [...carriedClusters],
    gaps: [],
    engineErrors: 0,
    queryCount: 0,
    reason: '',
    reusedPages: carriedPages.length,
    reusedClusters: carriedClusters.length,
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
        onState({ question, focus, depth: resolvedDepth, pages: state.pages, clusters: state.clusters, gaps: result.gaps })
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
    const planned = Array.isArray(planRaw?.queries)
      ? planRaw.queries.filter((query) => typeof query === 'string' && query.trim()).map((query) => query.trim().slice(0, 100))
      : []
    const queries = uniqueStrings([
      ...planned,
      ...buildQueries(state.analysis.subQuestions, focus, question, profile.queries),
    ]).slice(0, profile.queries)
    budget.take('queries', queries.length)
    state.queryCount = queries.length

    // Step 2b — primary sources by direct URL. A URL the user pasted always wins
    // (pricing/login pages are exactly what search cannot surface); otherwise the
    // planner may name one or two official URLs it is confident about.
    const askedUrls = extractUrls(`${question} ${focus.join(' ')}`).slice(0, 2)
    const plannedUrls = (Array.isArray(planRaw?.directUrls) ? planRaw.directUrls : [])
      .filter((url) => typeof url === 'string' && /^https?:\/\//i.test(url.trim()) && isOfficialDomain(url))
      .map((url) => url.trim())
    const directUrls = uniqueStrings([...askedUrls, ...plannedUrls]).slice(0, 2)
    const directPages = []
    const fetchDirect = config.__fetchPage
    for (const url of directUrls) {
      if (runSignal.aborted || typeof fetchDirect !== 'function') break
      const page = await fetchDirect(url, { signal: runSignal, timeoutMs: 20000 })
      if (page?.ok) directPages.push(page)
      else logger(`direct url unreadable: ${url}`)
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
      const page = await fetchDirect(url, { signal: runSignal, timeoutMs: 20000 })
      if (page?.ok) {
        directPages.push(page)
        state.directUrls += 1
      } else logger(`linked primary url unreadable: ${url}`)
    }

    // Step 3 — search.
    const engines = config.__engines ?? []
    state.engineNames = engines.map((engine) => engine.name)
    let searchFailures = 0
    for (const query of queries) {
      if (runSignal.aborted) break
      const { hits, engineFailures } = await searchAll(engines, query, {
        signal: runSignal, maxResults: 10, onError: (engine, error) => logger(`engine ${engine} failed: ${error.message}`),
      })
      searchFailures += engineFailures
      state.hits.push(...hits)
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
      state.verticalHits = verticalHits.length
      const byEngine = {}
      for (const hit of verticalHits) {
        for (const engine of hit.engines ?? [hit.engine].filter(Boolean)) byEngine[engine] = (byEngine[engine] ?? 0) + 1
      }
      state.verticalHitsByEngine = byEngine
      if (verticalErrors.length > 0) logger(`vertical failures: ${verticalErrors.length}`)
    }
    if (state.hits.length === 0 && directPages.length === 0) {
      throw new Error(`所有搜索源均未返回结果（${searchFailures} 次引擎失败），已中止而不编造内容`)
    }

    // Step 4 — dedupe, rank, select. Direct primary pages take precedence;
    // when the planner named none, keep two slots for official links mined
    // out of the secondary pages in step 5b.
    const reserve = directPages.length > 0 ? 0 : (verticalNames.length > 0 ? 1 : 2)
    // Legal/regulatory questions are only really answered by the act itself.
    // Keep two page slots for the gap-refill round that hunts for EUR-Lex,
    // otherwise planner-provided direct URLs consume the entire page budget
    // before the refill can run.
    const wantsPrimaryText = resolvedDepth !== 'quick'
      && (LEGAL_HINTS.test(`${question} ${focus.join(' ')}`) || directPages.length === 0)
    const refillReserve = wantsPrimaryText
      ? Math.min(2, Math.max(0, pageBudget - directPages.length - reserve - 1))
      : 0
    // Never fetch a URL the previous run already read: the carried pages are
    // already in state.pages and their evidence is already in state.clusters.
    const ranked = rankHits(dedupeHits(state.hits), { focus, question })
      .filter((hit) => !seenUrls.has(hit.url))
    const selected = ranked.slice(0, Math.max(1, pageBudget - directPages.length - reserve - refillReserve))
    // A vertical hit is a direct answer (issue thread, SO answer, paper), not a
    // secondary tutorial; keep at least one slot for it when general ranking
    // pushed them all out.
    const VERTICAL_ENGINES = new Set(['github', 'stackexchange', 'arxiv', 'scholar', 'npm', 'hn', 'pypi'])
    const isVertical = (hit) => [...(hit.engines ?? [])].some((engine) => VERTICAL_ENGINES.has(engine))
    const verticalPick = ranked.find(isVertical)
    if (verticalPick && !selected.includes(verticalPick)) {
      const replaceAt = selected.map(isVertical).lastIndexOf(false)
      if (replaceAt >= 0) selected[replaceAt] = verticalPick
    }
    // standard/deep have page budget to spare; give a second direct source
    // (e.g. a Stack Overflow answer next to a GitHub issue) a slot as well.
    if (profile.pages >= 8) {
      const enginesOf = (hit) => new Set([...(hit.engines ?? [])])
      const firstEngines = enginesOf(verticalPick ?? selected.find(isVertical) ?? {})
      const extraVertical = ranked
        .filter(isVertical)
        .find((hit) => !selected.includes(hit) && [...enginesOf(hit)].some((engine) => !firstEngines.has(engine)))
        ?? ranked.filter(isVertical).find((hit) => !selected.includes(hit))
      if (extraVertical) {
        const replaceAt = selected.map(isVertical).lastIndexOf(false)
        if (replaceAt >= 0) selected[replaceAt] = extraVertical
      }
    }
    budget.take('pages', directPages.length + selected.length)

    // Step 5 — fetch and read.
    const fetcher = config.__fetchPage
    const pages = await runWithConcurrency(selected, 3, async (hit) => {
      const page = await fetcher(hit.url, { signal: runSignal, timeoutMs: 15000 })
      const source = [...(hit.engines ?? [hit.engine].filter(Boolean))][0] ?? 'web'
      // Stack Overflow and HN block plain HTTP fetches (403/419); the vertical
      // API already returned the post body, so use it instead of dropping the
      // source.
      if (!page?.ok && typeof hit.text === 'string' && hit.text.length >= 200) {
        return { url: hit.url, title: hit.title, ok: true, text: hit.text, publishedAt: hit.publishedAt, viaApi: true, engine: source }
      }
      return page ? { ...page, engine: page.engine ?? source } : page
    }, runSignal)
    state.pages = [...directPages, ...pages].filter(Boolean).filter((page) => page.ok)
    const unread = pages.filter((page) => page && !page.ok)
    if (unread.length > 0) logger(`pages unreadable: ${unread.length}`)
    // Keep the failure reasons: a silently missing source looks like "the web has
    // nothing", which is a lie the answer would inherit. Surface them as gaps.
    state.fetchFailures = unread.slice(0, 3).map((page) => ({ url: page.url, reason: page.reason ?? 'unreadable' }))

    // Step 5b — follow official links found inside the secondary articles we
    // did read (law-firm posts almost always cite EUR-Lex / government texts).
    const newPageCount = Math.max(0, state.pages.length - carriedPages.length)
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
        const page = await fetcher(url, { signal: runSignal, timeoutMs: 15000 })
        if (page?.ok) {
          state.pages.push(page)
          state.directUrls += 1
        } else logger(`official link unreadable: ${url}`)
      }
    }

    // Step 6 —?evidence cards. Carried pages already produced evidence in the
    // previous run; only the freshly fetched pages need extraction.
    const usable = state.pages.slice(carriedPages.length, carriedPages.length + pageBudget)
    const batches = chunk(usable, profile.batch)
    for (const batch of batches) {
      if (runSignal.aborted) break
      const raw = await clampLlm(() => client.jsonCall({
        system: SAFETY_SYSTEM,
        user: evidencePrompt({ pages: batch }),
        signal: runSignal,
        maxTokens: 2600,
      }))
      const items = []
      if (Array.isArray(raw)) {
        raw.forEach((entry) => {
          const page = batch[Number(entry?.source)]
          const evidence = page ? toEvidence(entry, page) : null
          if (evidence) items.push(evidence)
        })
      }
      if (items.length === 0) {
        for (const page of batch) {
          const evidence = heuristicEvidence(page)
          if (evidence) items.push(evidence)
        }
        logger(`evidence batch: model returned none, heuristic found ${items.length}`)
      } else logger(`evidence batch: ${items.length} items`)
      state.clusters = mergeClusters(state.clusters, groupEvidence(items))
    }

    // Step 7 —?gaps.
    state.gaps = clauseGaps(state.analysis.subQuestions, state.clusters)

    // Step 8 —?one gap-refill round (standard/deep only). Keep at least
    // 60s of the wall clock for synthesis/repair, otherwise skip the refill.
    const remainingMs = profile.wallMs - (Date.now() - startedAt)
    const missingPrimary = !hasPrimaryClusters(state.clusters)
    // A legal/regulatory question is only really answered by the legal text
    // itself: a policy landing page counts as "official" but not as the act.
    const needsLegalText = LEGAL_HINTS.test(`${question} ${focus.join(' ')}`)
      && !state.pages.some((page) => /eur-lex\.europa\.eu/i.test(page.url))
    if (budget.remaining('gapRounds') > 0
      && ((state.gaps.length > 0 && (state.clusters.length < 4 || missingPrimary)) || needsLegalText)
      && !runSignal.aborted && remainingMs > 60000) {
      budget.take('gapRounds')
      state.gaps = await gapRefill({ client, state, profile, budget, runSignal, config, focus, question, logger, clampLlm, needPrimary: missingPrimary || needsLegalText })
    }

    // Tell the reader when sources were fetched but unreadable, instead of
    // pretending those sources do not exist; same for elliptical follow-ups the
    // tool cannot resolve without conversation history.
    state.gaps = [
      ...state.gaps,
      ...(state.fetchFailures ?? []).map((failed) => `抓取失败：${hostOf(failed.url)}（${truncate(failed.reason, 90)}）`),
      ...(looksLikeFollowUp(question) && !prior
        ? ['本次问题是省略式追问：研究工具看不到对话历史，可能答非所问。请把被指代的内容写成完整问题后重查']
        : []),
    ]

    if (state.clusters.length === 0) {
      logger('early return: no clusters')
      const brief = fallbackBrief({ question, clusters: [], gaps: ['所有页面均未产生可引用证据'], partial: true, reason: '证据提取失败' })
      return finalize(buildResult({
        brief, sources: [], confidence: 'low', gaps: state.gaps, partial: true, depth: resolvedDepth,
        stats: statsOf(state, budget, startedAt),
      }))
    }

    // Step 9 —?synthesize.
    // Disagreement between sources is a result in its own right: keep the
    // disputed clusters so every brief path can surface them instead of letting
    // the synthesis model smooth them into "experts believe".
    state.conflicts = state.clusters.filter((cluster) => cluster.status === 'disputed')
    const sources = assignSourceIds(state.clusters)
    const language = outputLanguage === 'auto' ? (state.analysis.language ?? 'zh') : outputLanguage
    const sourceList = sources.map((source) => `[${source.id}] ${source.title} — ${source.url}`).join('\n')
    // Evidence built only from commentary/marketing pages cannot carry a confident
    // verdict, even when several such pages agree: they all copy one another.
    const hasPrimary = hasPrimaryClusters(state.clusters)
    const gaps = [...state.gaps]
    let confidence = computeConfidence(state.clusters)
    if (resolvedDepth !== 'quick' && !hasPrimary) {
      confidence = 'low'
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
        sourceList, depth: resolvedDepth, hasPrimary, prior, mode,
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

    // The section is inserted before citation checking so its [S#] ids are
    // remapped and counted exactly like citations written by the model.
    const withConflicts = appendConflictSection(brief, state.conflicts)
    const { brief: cleaned, sources: finalSources } = validateCitations(withConflicts, sources)
    const result = buildResult({
      brief: cleaned,
      sources: finalSources,
      confidence,
      gaps,
      partial: false,
      depth: resolvedDepth,
      stats: statsOf(state, budget, startedAt),
      conflicts: state.conflicts,
    })
    if (state.reason) result.gaps = [...result.gaps, state.reason]
    return finalize(result)
  } catch (error) {
    const aborted = runSignal.aborted
    if (state.clusters.length > 0) {
      const sources = assignSourceIds(state.clusters)
      const conflicts = state.conflicts ?? state.clusters.filter((cluster) => cluster.status === 'disputed')
      const brief = fallbackBrief({
        question, clusters: state.clusters, gaps: state.gaps, partial: true,
        reason: aborted ? '运行超时/中断' : `流程中断：${error.message}`,
      })
      const { brief: cleaned, sources: finalSources } = validateCitations(appendConflictSection(brief, conflicts), sources)
      return finalize(buildResult({
        brief: cleaned, sources: finalSources, confidence: computeConfidence(state.clusters),
        gaps: state.gaps, partial: true, depth: resolvedDepth, stats: statsOf(state, budget, startedAt),
        conflicts,
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

const LEGAL_HINTS = /法规|条例|指令|法案|合规|认证|监管|标准原文|regulation|directive|compliance|certification|eur-lex|gdpr|ai act|\bcra\b/i

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
export function primaryTargetQueries(question, focus = []) {
  const text = `${question ?? ''} ${focus.join(' ')}`
  const topic = latinTopic(question) || latinTopic(focus.join(' '))
  if (!topic) return []
  const targets = LEGAL_HINTS.test(text)
    ? ['site:eur-lex.europa.eu', 'site:europa.eu']
    : /\bnpm\b|package|依赖/i.test(text)
      ? ['site:npmjs.com']
      : /github|开源|repository/i.test(text)
        ? ['site:github.com']
        : []
  return targets.slice(0, 2).map((site) => `${site} ${topic}`)
}

async function gapRefill({ client, state, profile, budget, runSignal, config, focus, question, logger, clampLlm, needPrimary = false }) {
  const raw = await clampLlm(() => client.jsonCall({
    system: SAFETY_SYSTEM,
    user: gapPrompt({ question, analysis: state.analysis, clusters: state.clusters, gaps: state.gaps, needPrimary }),
    signal: runSignal,
    maxTokens: 500,
  }))
  const queries = uniqueStrings((raw?.queries ?? []).map((query) => String(query))).slice(0, 2)
  if (needPrimary) queries.push(...primaryTargetQueries(question, focus))
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
  const room = budget.remaining('pages')
  if (room <= 0) return state.gaps
  const fresh = rankHits(dedupeHits(extra), { focus, question })
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
  for (const batch of chunk(usable, profile.batch)) {
    if (runSignal.aborted) break
    const evidenceRaw = await clampLlm(() => client.jsonCall({
      system: SAFETY_SYSTEM,
      user: evidencePrompt({ pages: batch }),
      signal: runSignal,
      maxTokens: 2600,
    }))
    const items = []
    if (Array.isArray(evidenceRaw)) {
      evidenceRaw.forEach((entry) => {
        const page = batch[Number(entry?.source)]
        const evidence = page ? toEvidence(entry, page) : null
        if (evidence) items.push(evidence)
      })
    }
    if (items.length === 0) for (const page of batch) { const e = heuristicEvidence(page); if (e) items.push(e) }
    state.clusters = mergeClusters(state.clusters, groupEvidence(items))
  }
  return clauseGaps(state.analysis.subQuestions, state.clusters)
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

function statsOf(state, budget, startedAt) {
  return {
    queries: budget.used.queries,
    directUrls: state.directUrls ?? 0,
    pagesFetched: state.pages.filter((page) => page.ok).length,
    // Pages carried over from the previous run were not fetched this time; the
    // brief should not claim otherwise.
    newPagesFetched: Math.max(0, state.pages.filter((page) => page.ok).length - (state.reusedPages ?? 0)),
    clusters: state.clusters.length,
    llmRounds: budget.used.llmCalls,
    elapsedMs: Date.now() - startedAt,
    engines: state.engineNames ?? [],
    engineErrors: state.engineErrors ?? 0,
    verticals: state.verticals ?? [],
    verticalHits: state.verticalHits ?? 0,
    verticalsByEngine: state.verticalHitsByEngine ?? {},
    refillQueries: state.refillQueries ?? [],
    reusedPages: state.reusedPages ?? 0,
    reusedClusters: state.reusedClusters ?? 0,
    resumed: (state.reusedPages ?? 0) > 0,
    hosts: uniqueStrings(state.pages.filter((page) => page.ok).map((page) => {
      try { return new URL(page.url).hostname } catch { return '' }
    }).filter(Boolean)),
  }
}