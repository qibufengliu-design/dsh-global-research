/**
 * Brief assembly and citation hygiene.
 * Every [S#] in the final text must exist in the source table; dangling
 * citations are removed and the remaining ids renumbered by first appearance.
 */
import {
  canonicalKey, jsonSafe, isMirrorUrl, truncate, domainTrust, isOfficialDomain, domainOf, evidenceAgeDays, evidenceSiteKey,
} from './util.js'

/** Section headings the deterministic layer guarantees. Exact text matters: the UI renders them. */
export const CONFLICT_HEADING = '## 存在冲突'
export const NEXT_STEPS_HEADING = '## 下一步建议'
// 0.6.1 — the conflict section is split three ways, in this order. Exact text
// matters: the UI and the tests key off the headings.
export const FACT_CONFLICT_HEADING = '### 事实冲突'
export const SCOPE_DIFFERENCE_HEADING = '### 口径差异'
export const SELF_CONTRADICTION_HEADING = '### 来源自相矛盾'
const NEXT_STEPS_FALLBACK = '- 按「未解决」逐条补一轮定向检索，或把关键页面 URL 直接贴进问题重查'

/**
 * Evidence grade shown next to every reference. The user should be able to see
 * at a glance whether a claim rests on a regulation, a paper, a repo, a forum
 * answer or a blog — those are not equally strong.
 *
 * 0.6.0: optional `via` (raw | web | jina | render | cellar | sitemap). Text
 * obtained through a reader/render proxy is one grade weaker: we know the URL
 * says "official" or "paper", but not that the proxy returned that page intact.
 */
const GRADE_ORDER = ['官方', '论文', '仓库', '论坛', '百科', '网页']

export function gradeSource(url, via) {
  const value = String(url ?? '')
  let grade
  if (isOfficialDomain(value)) grade = '官方'
  else if (/arxiv\.org|doi\.org|semanticscholar\.org|openalex\.org|\/paper\//i.test(value)) grade = '论文'
  else if (/github\.com|gitlab\.com|npmjs\.com|pypi\.org/i.test(value)) grade = '仓库'
  else if (/stackoverflow\.com|stackexchange\.com|news\.ycombinator\.com|reddit\.com|v2ex\.com/i.test(value)) grade = '论坛'
  else if (/wikipedia\.org/i.test(value)) grade = '百科'
  else grade = '网页'
  if ((via === 'jina' || via === 'render') && (grade === '官方' || grade === '论文')) {
    grade = GRADE_ORDER[GRADE_ORDER.indexOf(grade) + 1]
  }
  return grade
}

export function assignSourceIds(clusters) {
  const sources = []
  const byKey = new Map()
  for (const cluster of clusters) {
    for (const item of cluster.evidence) {
      const key = canonicalKey(item.url)
      let source = byKey.get(key)
      if (!source) {
        // Republished copies land on different hosts under an identical title.
        const twin = sources.find((candidate) => sameTitle(candidate.title, item.title))
        if (twin) {
          source = twin
          byKey.set(key, twin)
          if (!twin.publishedAt && item.publishedAt) twin.publishedAt = item.publishedAt
        }
      }
      if (!source) {
        source = {
          id: `S${sources.length + 1}`,
          url: item.url,
          title: item.title || item.domain || item.url,
          domain: item.domain,
          publishedAt: item.publishedAt,
          type: item.type ?? 'web',
          via: item.via,
        }
        byKey.set(key, source)
        sources.push(source)
      } else if (isMirrorUrl(source.url) && !isMirrorUrl(item.url)) {
        source.url = item.url
        source.title = item.title || source.title
        source.domain = item.domain || source.domain
      }
      item.id = source.id
    }
  }
  return sources
}

function normalizeTitle(title) {
  return String(title ?? '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

function sameTitle(a, b) {
  const left = normalizeTitle(a)
  const right = normalizeTitle(b)
  if (left.length < 12 || right.length < 12) return false
  // Syndicated copies often append the host name ("…影响 - 贸企通").
  return left === right || left.startsWith(right) || right.startsWith(left)
}

/**
 * Bracket citation hygiene: only what the brief cites survives, renumbered
 * S1..Sn in first-mention order.
 *
 * 0.9.6 — a source fetched by a cost-budgeted targeted refill is the one
 * exception. Dropping it silently is what made "定向回补 1 项（解决 1）" coexist
 * with a missing vendor price: the page was read, the synthesis model did not
 * quote it, and the reference list therefore never showed it. Up to `maxKept`
 * uncited refill pages now stay in 参考 with an explicit
 * （已检索，未被采用） label (`unusedRefill: true`). They are not counted as
 * `cited`, they do not renumber the cited set, and they never enter the body.
 */
export function validateCitations(brief, sources, options = {}) {
  const list = Array.isArray(sources) ? sources : []
  const known = new Map(list.map((source) => [source.id, source]))
  const order = []
  const seen = new Set()

  const replaced = String(brief ?? '').replace(/\[(S\d+)\]/g, (_match, id) => {
    if (!known.has(id)) return ''
    if (!seen.has(id)) {
      seen.add(id)
      order.push(id)
    }
    return `[[${id}]]`
  })

  const finalSources = []
  const renumber = new Map()
  order.forEach((id, index) => {
    renumber.set(id, `S${index + 1}`)
    finalSources.push({ ...known.get(id), id: `S${index + 1}` })
  })

  // Uncited refill pages kept for visibility (0.9.6). Capped, ordered by the
  // source list, and appended after the cited set so S1..Sn stay stable for any
  // consumer that maps citations back to the brief.
  const maxKept = Number.isFinite(Number(options?.maxKept))
    ? Math.max(0, Math.floor(Number(options.maxKept)))
    : 2
  const refillKeys = new Set(
    (Array.isArray(options?.refillUrls) ? options.refillUrls : [])
      .map((url) => canonicalKey(url))
      .filter(Boolean),
  )
  let kept = 0
  if (maxKept > 0 && refillKeys.size > 0) {
    for (const source of list) {
      if (kept >= maxKept) break
      if (!source?.id || seen.has(source.id)) continue
      if (!refillKeys.has(canonicalKey(source.url))) continue
      kept += 1
      finalSources.push({ ...source, id: `S${finalSources.length + 1}`, unusedRefill: true })
    }
  }

  const cleaned = replaced.replace(/\[\[(S\d+)\]\]/g, (_match, id) => {
    const next = renumber.get(id)
    return next ? `[${next}]` : ''
  })

  // Bare mentions of a source that no longer exists ("S1 与 S4 说法不一致")
  // would point at a phantom reference after the bracket pass.
  const bareSafe = cleaned.replace(/(?<!\[)\bS(\d{1,2})\b(?!\])/g, (match, id) => (
    renumber.has(`S${id}`) ? match : '〔来源未列出〕'
  ))

  return {
    brief: bareSafe.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(),
    sources: finalSources,
    cited: order.length,
    // Kept-but-unused refill pages: listed in 参考, never counted as adopted.
    kept,
  }
}

const CONFIDENCE_ORDER = Object.freeze(['low', 'medium', 'high'])

/** One notch down; "low" is the floor. */
export function downgradeConfidence(level) {
  const index = CONFIDENCE_ORDER.indexOf(level)
  if (index <= 0) return 'low'
  return CONFIDENCE_ORDER[index - 1]
}

/**
 * Confidence verdict from the evidence clusters.
 *
 * `gates` is optional and mirrors the strategy pack's `gates` key; every default
 * reproduces the pre-strategy behaviour exactly, so `computeConfidence(c)` and
 * `computeConfidence(c, {})` agree byte for byte:
 *   gate                  cap on the verdict (high/medium/low)
 *   highNeedsPrimary      "high" needs primary-grade sources (alias:
 *                         requirePrimaryForHigh; default true)
 *   minPrimaryDomains     how many independent primary hosts "high" needs (=2)
 *   missingPrimary        no primary source at all: cap at primaryMissingCap
 *   primaryMissingCap     the cap applied then (default low)
 *   missingSections       a strategy-declared brief section was missing: one
 *                         notch down (the placeholder is visible in the brief)
 *
 * 0.10.1 — `questionKind` (also accepted as `gates.questionKind` / `gates.kind`)
 * adds one question-specific rule: a `decision` verdict is a judgement about
 * this team, so commentary pages may describe the trade-off but cannot authorise
 * the go/no-go line. See the decision gate below.
 */
export function computeConfidence(clusters, gates = {}, questionKind = null) {
  const options = gates && typeof gates === 'object' ? gates : {}
  const kind = questionKind ?? options.questionKind ?? options.kind ?? null
  const highNeedsPrimary = options.highNeedsPrimary ?? options.requirePrimaryForHigh ?? true
  const minPrimaryDomains = Number.isFinite(options.minPrimaryDomains)
    ? Math.max(1, Math.floor(options.minPrimaryDomains))
    : 2
  // 0.6.6 — a source that announces its own retirement cannot lift the verdict.
  // A cluster only recomputes its status when it actually holds stale cards; a
  // cluster with none keeps the status the pipeline assigned it.
  const evidenceOf = (cluster) => (Array.isArray(cluster?.evidence) ? cluster.evidence : [])
  const hasStale = (cluster) => evidenceOf(cluster).some((item) => item?.stale === true)
  const liveEvidence = (cluster) => evidenceOf(cluster).filter((item) => item?.stale !== true)
  const statusOf = (cluster) => {
    if (!hasStale(cluster)) return cluster.status
    const evidence = liveEvidence(cluster)
    if (evidence.length === 0) return 'unverified'
    const domains = new Set(evidence.map((item) => item.domain).filter(Boolean))
    const stances = new Set(evidence.map((item) => item.stance).filter((stance) => stance && stance !== 'neutral'))
    return stances.size > 1 ? 'disputed' : domains.size >= 2 ? 'confirmed' : 'unverified'
  }
  const confirmed = clusters.filter((cluster) => statusOf(cluster) === 'confirmed').length
  const disputed = clusters.filter((cluster) => statusOf(cluster) === 'disputed').length
  // Breadth fallback: several independent high-trust sources that do not
  // contradict each other are worth more than a single confirmed cluster.
  // 0.9.1 — breadth counts documentation *sections*, not hosts: eight pages of
  // official docs split over three manuals were one site and stayed `low`.
  // `confirmed` above still uses the coarse cross-source unit, so this only
  // widens breadth; it never turns one vendor into two independent sources.
  const strong = new Set()
  for (const cluster of clusters) {
    for (const item of liveEvidence(cluster)) {
      if (domainTrust(item.url) < 2) continue
      strong.add(evidenceSiteKey(item.url) || canonicalKey(item.url))
    }
  }
  // Grade rule: a "high" verdict should rest on at least two independent
  // primary-grade sources (regulation/paper), not on three blogs agreeing.
  const primary = new Set()
  for (const cluster of clusters) {
    for (const item of liveEvidence(cluster)) {
      const grade = gradeSource(item.url, item.via)
      if (grade !== '官方' && grade !== '论文') continue
      try {
        primary.add(new URL(item.url).hostname.replace(/^www\./, ''))
      } catch {
        primary.add(canonicalKey(item.url))
      }
    }
  }
  let value = 'low'
  if (disputed > 0) value = confirmed >= 1 ? 'medium' : 'low'
  else if (confirmed >= 3) value = highNeedsPrimary === false || primary.size >= minPrimaryDomains ? 'high' : 'medium'
  else if (confirmed >= 1 || strong.size >= 2) value = 'medium'
  // 0.10.1 — decision gate. A go/no-go answer without a single first-party host
  // (domainTrust >= 3: official docs, standards, vendor pages, trusted domains)
  // cannot be "high": the breadth gate counts blog hosts as two independent
  // voices, but two blog posts do not make an organisation's policy. Breadth
  // below two sites is not even independent evidence, so it drops to "low".
  // Every other kind keeps the legacy matrix byte for byte (`kind` is null).
  if (kind === 'decision') {
    const firstParty = new Set()
    for (const cluster of clusters) {
      for (const item of liveEvidence(cluster)) {
        if (domainTrust(item.url) < 3) continue
        try {
          firstParty.add(new URL(item.url).hostname.replace(/^www\./, ''))
        } catch {
          firstParty.add(canonicalKey(item.url))
        }
      }
    }
    if (firstParty.size === 0) {
      value = CONFIDENCE_ORDER[Math.min(CONFIDENCE_ORDER.indexOf(value), CONFIDENCE_ORDER.indexOf('medium'))]
      if (strong.size < 2) value = 'low'
    }
  }
  // A missing primary source caps the verdict (legacy: force "low" unless quick).
  if (options.missingPrimary === true) {
    const cap = CONFIDENCE_ORDER.includes(options.primaryMissingCap) ? options.primaryMissingCap : 'low'
    value = CONFIDENCE_ORDER[Math.min(CONFIDENCE_ORDER.indexOf(value), CONFIDENCE_ORDER.indexOf(cap))]
  }
  // A strategy-declared section filled with a placeholder is a visible unknown.
  if (options.missingSections === true) value = downgradeConfidence(value)
  if (CONFIDENCE_ORDER.includes(options.gate)) {
    value = CONFIDENCE_ORDER[Math.min(CONFIDENCE_ORDER.indexOf(value), CONFIDENCE_ORDER.indexOf(options.gate))]
  }
  return value
}

const DEPTH_LABELS = { quick: '快速档', standard: '标准档', deep: '深度档' }
const STATS_LINE = /^>\s*本次检索：/m
// Fixed order for the stage chips; the labels are the user-visible vocabulary.
const STAGE_LABELS = [
  ['analyze', '拆题'],
  ['search', '检索'],
  ['read', '精读'],
  ['evidence', '证据'],
  ['gap', '补缺'],
  ['synth', '合成'],
]
const STAGE_MIN_MS = 500
const STAGE_LIMIT = 4

/**
 * Compress per-stage milliseconds into `拆题1s/检索12s/精读30s`. Only stages over
 * half a second are worth a slot (otherwise every fast run ends in noise), and
 * the four slowest win; they are then printed back in canonical stage order so
 * the same run always reads the same way.
 */
function stageSummary(timings) {
  if (!timings || typeof timings !== 'object') return ''
  const stages = STAGE_LABELS
    .map(([key, label], index) => ({ key, label, index, ms: Number(timings[key]) || 0 }))
    .filter((entry) => entry.ms > STAGE_MIN_MS)
  const picked = stages
    .sort((a, b) => b.ms - a.ms || a.index - b.index)
    .slice(0, STAGE_LIMIT)
    .sort((a, b) => a.index - b.index)
  return picked.map((entry) => `${entry.label}${Math.max(1, Math.round(entry.ms / 1000))}s`).join('/')
}

/**
 * One-line run summary appended after the 参考 section. Idempotent: a brief that
 * already carries the line is returned untouched, so rendering a result twice
 * never duplicates it. A missing stats object is tolerated (older results).
 */
export function appendStats(brief, stats, depth) {
  const text = String(brief ?? '').trimEnd()
  if (!stats) return text
  const queries = Math.max(0, Math.round(Number(stats.queries) || 0))
  const pages = Math.max(0, Math.round(Number(stats.newPagesFetched ?? stats.pagesFetched) || 0))
  const reused = Math.max(0, Math.round(Number(stats.reusedPages) || 0))
  const evidence = Math.max(0, Math.round(Number(stats.clusters) || 0))
  const seconds = Math.max(0, Math.round((Number(stats.elapsedMs) || 0) / 1000))
  if (!queries && !pages && !evidence) return text
  if (STATS_LINE.test(text)) return text
  const label = DEPTH_LABELS[depth] ?? DEPTH_LABELS[stats.depthUsed]
  const tail = label ? `（${label}）` : ''
  const reuse = reused > 0 ? ` · 复用 ${reused} 页` : ''
  const stage = stageSummary(stats.timings)
  const stages = stage ? ` · 阶段 ${stage}` : ''
  return `${text}\n\n> 本次检索：${queries} 个查询 · ${pages} 个页面 · ${evidence} 条证据 · ${seconds} 秒${tail}${reuse}${stages}`
}

const RETRIEVAL_FLOW_LINE = /^>\s*检索流程：/m
// Full line, so re-rendering with fresher stats can replace it in place.
const RETRIEVAL_FLOW_LINE_FULL = /^>\s*检索流程：[^\n]*/m

/**
 * 0.6.1 — the PRISMA-style retrieval funnel, one fixed line:
 * `> 检索流程：识别 N 篇 · 去重后 M 篇 · 可读 K 篇 · 采用 J 篇`.
 * Every number comes from the run's counters (statsOf), never from an estimate.
 * A resumed run keeps the totals for K/J and says how many pages it reused, so
 * a second run does not look like it read less than the first.
 */
export function formatRetrievalFlow(stats) {
  if (!stats) return ''
  const identified = Math.max(0, Math.round(Number(stats.identified) || 0))
  const deduped = Math.max(0, Math.round(Number(stats.deduped) || 0))
  const readable = Math.max(0, Math.round(Number(stats.readable) || 0))
  const adopted = Math.max(0, Math.round(Number(stats.adopted) || 0))
  if (!identified && !deduped && !readable && !adopted) return ''
  // 0.6.2 — first-party adoption is the number the reader cannot reconstruct
  // from the reference list: "you read 3 official pages but cited 1". Only
  // appended when such pages were actually read, so ordinary briefs keep the
  // plain four-number line.
  const officialReadable = Math.max(0, Math.round(Number(stats.officialReadable) || 0))
  const officialAdopted = Math.max(0, Math.round(Number(stats.officialAdopted) || 0))
  const official = officialReadable > 0 ? ` · 官方采用 ${officialAdopted}/${officialReadable}` : ''
  return `> 检索流程：识别 ${identified} 篇 · 去重后 ${deduped} 篇 · 可读 ${readable} 篇 · 采用 ${adopted} 篇${official}${queryKindSuffix(stats)}${targetedRefillSuffix(stats)}`
}

/**
 * 0.9.3 — how many zero-evidence comparison options were retried once with a
 * directed query, and how many of those retries actually produced evidence.
 * Omitted when the step never ran, so every other brief keeps the 0.7.1 line
 * verbatim.
 *
 * A skipped retry says so instead of reporting `0 项`: 0.9.2's stage could be
 * killed by a spent page budget or the wall clock and leave no trace at all, and
 * "定向回补 0 项（解决 0）" would read like the search ran and found nothing —
 * the same silent failure with a number attached.
 */
function targetedRefillSuffix(stats) {
  const refill = stats?.targetedRefill
  if (!refill || typeof refill !== 'object') return ''
  if (refill.skipped === 'budget') return ' · 定向回补跳过（预算不足）'
  if (refill.skipped === 'time') return ' · 定向回补跳过（时间不足）'
  const tried = Math.max(0, Math.round(Number(refill.optionsTried) || 0))
  if (!tried) return ''
  const resolved = Math.max(0, Math.round(Number(refill.optionsResolved) || 0))
  return ` · 定向回补 ${tried} 项（解决 ${resolved}）`
}

/**
 * 0.7.1 — query mix on the same line: how the plan split into Chinese semantic,
 * English technical and official `site:` queries. Omitted when a run planned no
 * queries (early-exit and hand-built stats keep the 0.6.x line verbatim).
 */
function queryKindSuffix(stats) {
  const counts = stats?.queriesByKind
  if (!counts || typeof counts !== 'object') return ''
  const semantic = Math.max(0, Math.round(Number(counts.semantic) || 0))
  const technical = Math.max(0, Math.round(Number(counts.technical) || 0))
  const official = Math.max(0, Math.round(Number(counts.official) || 0))
  if (!semantic && !technical && !official) return ''
  return ` · 查询 中文语义 ${semantic} / 英文技术 ${technical} / 官方定向 ${official}`
}

/**
 * Insert the funnel line before 参考 (it describes how 参考 was built, so it must
 * not sit after the reference list). Idempotent like appendStats(); when the
 * brief already has the line it is replaced with the fresher one (a resumed run
 * reports new totals), never duplicated.
 */
export function appendRetrievalFlow(brief, stats) {
  const text = String(brief ?? '').trimEnd()
  const line = formatRetrievalFlow(stats)
  if (!line) return text
  const reused = Math.max(0, Math.round(Number(stats.reusedPages) || 0))
  const resume = reused > 0 ? `（续跑：复用 ${reused} 页）` : ''
  const desired = `${line}${resume}`
  if (RETRIEVAL_FLOW_LINE.test(text)) return text.replace(RETRIEVAL_FLOW_LINE_FULL, desired)
  return `${text}\n\n${desired}`
}

export function appendReferences(brief, sources, pages = [], stats = null) {
  if (sources.length === 0) return brief
  // 0.6.6 — a page that says it is retired stays in the list (the link is still
  // the provenance) but the line is marked so nobody quotes it as current.
  const retiredKeys = new Set(
    (Array.isArray(pages) ? pages : [])
      .filter((page) => page?.stale === true)
      .map((page) => canonicalKey(page.url))
      .filter(Boolean),
  )
  const lines = sources.map((source) => {
    const meta = [gradeSource(source.url, source.via), source.domain, source.publishedAt].filter(Boolean).join(' · ')
    // A two-year-old page is still citable, but the reader deserves to know the
    // claim may have moved on. Unknown dates are never flagged as old.
    const age = evidenceAgeDays(source.publishedAt)
    const old = age !== null && age > 730 ? ' · 旧' : ''
    const retired = retiredKeys.has(canonicalKey(source.url)) ? '（已过期，仅作参考）' : ''
    // 0.9.6 — refill pages the brief did not cite stay visible, but the reader
    // must not mistake them for adopted evidence.
    const unused = source?.unusedRefill === true ? '（已检索，未被采用）' : ''
    return `- [${source.id}] ${truncate(source.title, 90)} — ${source.url}（${meta}）${old}${retired}${unused}`
  })
  const unused = unusedPageLine(sources, pages)
  if (unused) {
    lines.push(unused)
    // 0.9.5 — "read 12, adopted 1" is only actionable if the reader knows where
    // the other 11 went: text under the gate, model silence, or citation
    // hygiene. The counts come from statsOf, measured per page, not estimated.
    const reasons = unusedReasonLine(stats)
    if (reasons) lines.push(reasons)
  }
  return `${brief}\n\n## 参考\n${lines.join('\n')}`
}

/**
 * 0.9.5 — the reason distribution behind `另有 N 个页面被读取但未采用`:
 * 证据提取为空 has two very different causes (the page was too thin to carry a
 * quote, or it was readable and the model still made no claim), and a page with
 * evidence that never got cited is a citation-hygiene drop, not an extraction
 * failure. Fetch failures are counted separately because those pages never
 * reached extraction at all.
 */
function unusedReasonLine(stats) {
  if (!stats || typeof stats !== 'object') return ''
  const count = (value) => Math.max(0, Math.round(Number(value) || 0))
  const below = count(stats.droppedBelowMinChars)
  const noClaim = count(stats.droppedModelNoClaim)
  const stale = count(stats.droppedStale)
  const uncited = count(stats.droppedUncited)
  const fetchFailed = count(stats.fetchFailed)
  const parts = []
  if (below) parts.push(`低于字数门槛 ${below} 段`)
  if (noClaim) parts.push(`模型未给论断 ${noClaim} 段`)
  if (stale) parts.push(`已过期 ${stale} 段`)
  if (uncited) parts.push(`引用校验剔除 ${uncited} 段`)
  if (parts.length === 0) return fetchFailed ? `- 未采用原因：${fetchFailed} 篇抓取失败` : ''
  const body = parts.join(' · ')
  return fetchFailed ? `- 未采用原因：${body}；另有 ${fetchFailed} 篇抓取失败` : `- 未采用原因：${body}`
}

/**
 * Reading something and then not citing it is information: the page was either
 * a duplicate or held no citable claim. Keep one compact line (count + domains)
 * instead of a second reference list — the reader sees the coverage, not a wall
 * of links the brief refused to use.
 */
function unusedPageLine(sources, pages) {
  if (!Array.isArray(pages) || pages.length === 0) return ''
  const cited = new Set()
  for (const source of sources) {
    const key = canonicalKey(source?.url)
    if (key) cited.add(key)
  }
  const seen = new Set()
  const domains = []
  let count = 0
  for (const page of pages) {
    const key = canonicalKey(page?.url)
    if (!key || cited.has(key) || seen.has(key)) continue
    seen.add(key)
    count += 1
    const domain = page?.domain || domainOf(page?.url)
    if (domain && !domains.includes(domain)) domains.push(domain)
  }
  if (count === 0) return ''
  if (domains.length === 0) return `- 另有 ${count} 个页面被读取但未采用`
  const shown = domains.slice(0, 6).join('、')
  const more = domains.length > 6 ? '…' : ''
  return `- 另有 ${count} 个页面被读取但未采用（${shown}${more}）`
}

// 0.7.1 — zero-evidence options. Dropping an option from the comparison table
// would read as "we weighed it and it lost"; the honest cell is 无证据. The gap
// line says the same thing in words, so the reader never mistakes silence for a
// verdict.
export const ZERO_EVIDENCE_TEXT = '无证据'

// 0.9.7 — an option that owns a row is a placeholder, not an omission: saying
// 「未纳入对比」 next to a row that *is* in the table was the reported
// contradiction. The price wording is used for a table with a price column/row;
// a non-price comparison (pnpm / yarn / bun) keeps a generic wording so the
// reader is not told a price is missing from a table that never had one.
// 1.0.1 — both wordings say 关键属性未取得 instead of naming a price: a row whose
// every cell is 无证据 has no price*and* no advantages/risks, and the price-only
// sentence read as a contradiction under a non-price table header.
export const ZERO_EVIDENCE_ROW_TEXT = '在对比表中占位，但关键属性未取得（零证据）'
export const ZERO_EVIDENCE_ROW_GENERIC_TEXT = '在对比表中占位，但关键属性未取得（零证据）'
const ZERO_EVIDENCE_OMITTED_TEXT = '在本轮证据中没有可用来源（零证据），未纳入对比'

export function zeroEvidenceGapText(option, options = {}) {
  const config = options && typeof options === 'object' ? options : {}
  // `priceTable` defaults to true: a caller that only knows "the option has a
  // row" is almost always looking at a price comparison (the reported case).
  const suffix = config.hasRow
    ? (config.priceTable === false ? ZERO_EVIDENCE_ROW_GENERIC_TEXT : ZERO_EVIDENCE_ROW_TEXT)
    : ZERO_EVIDENCE_OMITTED_TEXT
  return `选项「${option}」${suffix}`
}

/**
 * 0.9.7 — rewrite zero-evidence gap lines that already reached the brief (the
 * pipeline writes them before the table exists, so it cannot know whether the
 * option ends up with a row). The suffix the pipeline appends after the
 * sentence, e.g. 「（已定向检索 1 次仍未获证）」, is preserved.
 */
function realignZeroEvidenceGapText(text, ownedKeys, priceTable) {
  const line = String(text ?? '')
  const at = line.indexOf(ZERO_EVIDENCE_OMITTED_TEXT)
  if (at < 0) return line
  const name = /选项「([^」]+)」$/.exec(line.slice(0, at))
  if (!name || !ownedKeys.has(optionKey(name[1]))) return line
  const replacement = priceTable ? ZERO_EVIDENCE_ROW_TEXT : ZERO_EVIDENCE_ROW_GENERIC_TEXT
  return `${line.slice(0, at)}${replacement}${line.slice(at + ZERO_EVIDENCE_OMITTED_TEXT.length)}`
}

const COMPARE_TABLE_HEADING = /^##\s*方案对比\s*$/
const TABLE_LINE = /^\s*\|/

/** Compare an option name with a table cell: spaces/punctuation/case ignored. */
function optionKey(value) {
  return String(value ?? '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

function splitTableRow(line) {
  const trimmed = String(line ?? '').trim()
  if (!trimmed.startsWith('|')) return null
  const cells = trimmed.split('|')
  if (cells.length > 1) cells.shift()
  if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop()
  return cells.map((cell) => cell.trim())
}

function isTableSeparator(cells) {
  return cells.length > 0 && cells.every((cell) => /^:?-{2,}:?$/.test(cell.replace(/\s+/g, '')))
}

function zeroEvidenceRow(cells, width) {
  return `| ${cells[0] ?? ''} | ${Array.from({ length: Math.max(1, width - 1) }, () => ZERO_EVIDENCE_TEXT).join(' | ')} |`
}

/**
 * Mark each zero-evidence option in 「## 方案对比」. Rows the synthesis model
 * wrote for that option become `| 选项 | 无证据 | …`; options the model silently
 * dropped get an explicit row (or, when there is no table at all, a bullet).
 * Idempotent: a row already marked 无证据 stays exactly as it is.
 */
export function applyZeroEvidenceOptions(brief, options) {
  const text = String(brief ?? '')
  const names = (Array.isArray(options) ? options : [])
    .filter((option) => typeof option === 'string' && option.trim())
    .map((option) => option.trim())
  if (names.length === 0) return text
  const lines = text.split('\n')
  const headingIndex = lines.findIndex((line) => COMPARE_TABLE_HEADING.test(line.trim()))
  if (headingIndex < 0) return text
  let endIndex = lines.length
  for (let i = headingIndex + 1; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i])) {
      endIndex = i
      break
    }
  }
  const handled = new Set()
  let headerWidth = 0
  let lastRowIndex = -1
  for (let i = headingIndex + 1; i < endIndex; i += 1) {
    const cells = splitTableRow(lines[i])
    if (!cells) continue
    lastRowIndex = i
    if (isTableSeparator(cells)) continue
    if (!headerWidth && /^方案$/.test(cells[0])) {
      headerWidth = cells.length
      continue
    }
    if (cells.length < 2) continue
    const key = optionKey(cells[0])
    if (!key) continue
    const matched = names.find((name) => {
      const target = optionKey(name)
      return Boolean(target) && (key === target || key.includes(target) || target.includes(key))
    })
    if (!matched) continue
    handled.add(matched)
    lines[i] = zeroEvidenceRow(cells, cells.length)
  }
  const missing = names.filter((name) => !handled.has(name))
  if (missing.length === 0) return lines.join('\n')
  if (lastRowIndex >= 0) {
    const width = headerWidth || (splitTableRow(lines[lastRowIndex])?.length ?? 4)
    const rows = missing.map((name) => zeroEvidenceRow([name], width))
    lines.splice(lastRowIndex + 1, 0, ...rows)
  } else {
    const bullets = missing.map((name) => `- 「${name}」：${ZERO_EVIDENCE_TEXT}，未纳入对比（本轮证据中没有可用来源）`)
    lines.splice(headingIndex + 1, 0, '', ...bullets)
  }
  return lines.join('\n')
}

/** 0.9.9 — the compare table's columns follow the question kind (see prompts.js). */
export const COST_OVERVIEW_HEADER = '成本概览'
/** 0.9.9 — a bare price number in a 成本概览 column is replaced, not deleted. */
export const PRICE_SEE_NOTE = '见注'
// A header that names a money column. Deliberately word-level: 「性价比」/「评价」
// are legitimately non-money columns, while a pricing table's 输入价 / 输出价 /
// 单价 / 报价 are all "价格 columns" the reader sees as one axis.
const PRICE_COLUMN_HEADER = /价格|单价|报价|输入价|输出价|价目|pricing|price/i
// A price cell that carries nothing but the number and its unit. Ranges
// (0.2–0.3 元), prose ("见官网") and per-second/per-call units fall through and
// are left as they are — see the boundary note in docs/architecture.md.
const PRICE_NUMBER_CELL = /^(?:约|大约|≈|~|～)?\s*(?:[¥￥$]\s*)?\d+(?:[.,]\d+)*(?:\s*(?:元|块|人民币|美元|美分|角|分))?(?:\s*\/\s*(?:百万|千|十亿|1M|1K|M|K|B)?\s*(?:tokens?|token))?(?:\s*\[S\d+\])?$/iu
// Provenance labels that belong in a numeric cell (or nowhere), never in the
// label column: a row whose candidate reads 「先拆 2-3 个服务（无来源）」 cannot be
// matched to any candidate.
const UNSOURCED_CELL_MARKS = ['（无来源）', '(无来源)']
const LABEL_CELL_MARKS = ['（零证据）', '(零证据)', '（推断）', '(推断)']
// 0.9.10 — a cell that is nothing but a quantity ("0.2 元/百万 tokens", "8 人",
// "99.9%", "20–40 ms") is a quantitative claim, so its （无来源） mark is the
// number-provenance contract and stays. Prose, 未核实 and even a prose cell that
// happens to contain a digit are not quantities: a no-source mark on them is
// leftover noise, not provenance.
const QUANTITY_NUMBER = '(?:[¥￥$€]\\s*)?\\d+(?:[.,]\\d+)*'
const QUANTITY_UNITS = '(?:%|‰|元|块|人民币|美元|美分|角|分|个|人|台|核|GB|MB|TB|K|k|M|G|万|亿|倍|天|周|个月|小时|分钟|秒|毫秒|ms|QPS|qps|RPS|rps|TPS|tps|tokens?|token|次|条|页)'
const PURE_NUMBER_CELL = new RegExp(
  `^(?:约|大约|≈|~|～)?\\s*${QUANTITY_NUMBER}(?:\\s*(?:[–—~至]|-)\\s*${QUANTITY_NUMBER})?(?:\\s*${QUANTITY_UNITS})?(?:\\s*/\\s*(?:百万|千|十亿)?\\s*(?:tokens?|token|秒|s|次|人|个|页))?(?:\\s*${QUANTITY_UNITS})?(?:\\s*\\[S\\d+\\])?$`,
  'iu',
)

/** Remove the given markers from a cell, then tidy the space they leave behind. */
function stripCellMarks(value, marks) {
  let out = String(value ?? '')
  for (const mark of marks) out = out.split(mark).join('')
  return out.replace(/[ \t]{2,}/g, ' ').trim()
}

/**
 * 0.9.9 — hygiene for the delivered compare table, before the annotating layers
 * (markUnsourcedNumbers / checkCompareRows) touch it.
 *
 * Two reported leaks from 0.9.7's 判断题 (微服务该不该拆):
 *  1. the label column read 「先拆 2-3 个服务（无来源）」 — a provenance mark that
 *     leaked into the first column, where it breaks candidate matching and reads
 *     as part of the option's name;
 *  2. the table still carried a 「价格」 column filled with 未核实 on every row —
 *     a judgement question has no price axis, so the column is noise that looks
 *     like a finding.
 *
 * Rules: markers are stripped from the label column (all four kinds) and, in every
 * other column, （无来源） survives only on a cell that is nothing but a quantity
 * (`0.2 元/百万 tokens（无来源）`); a prose cell — including 未核实 — loses it.
 * For a question kind that is known and is not `pricing`, a 价格-column header
 * becomes 成本概览 and bare-number price cells become 见注 (rows are never deleted).
 * When the kind is unknown the table is left exactly as written.
 *
 * Idempotent: no marker survives a first pass, the renamed header no longer
 * matches PRICE_COLUMN_HEADER and 见注 is not a number.
 */
export function sanitizeCompareTable(brief, options = {}) {
  const text = String(brief ?? '')
  const config = options && typeof options === 'object' ? options : {}
  const kind = String(config.questionKind ?? config.kind ?? config.stats?.questionKind ?? '')
    .trim()
    .toLowerCase()
  const lines = text.split('\n')
  const heading = lines.findIndex((line) => COMPARE_TABLE_HEADING.test(line.trim()))
  if (heading < 0) return text
  let end = lines.length
  for (let i = heading + 1; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i])) {
      end = i
      break
    }
  }
  // Only the first contiguous run of table lines belongs to this table.
  let start = -1
  for (let i = heading + 1; i < end; i += 1) {
    if (splitTableRow(lines[i])) {
      start = i
      break
    }
  }
  if (start < 0) return text
  let stop = start
  for (let i = start; i < end; i += 1) {
    if (!splitTableRow(lines[i])) break
    stop = i
  }
  const rows = []
  for (let i = start; i <= stop; i += 1) rows.push({ index: i, cells: splitTableRow(lines[i]) })
  if (rows.length === 0) return text
  const header = rows.length >= 2 && isTableSeparator(rows[1].cells) ? rows[0] : null
  const dataRows = rows.filter((row, index) => !isTableSeparator(row.cells) && !(header && index === 0))

  let changed = false
  // Pass 1 — provenance marks. The label column loses every marker; any other
  // cell loses the no-source label unless it is a pure quantity. 0.9.10: the old
  // test was /\d/, so a prose cell that merely mentioned a number (「部署 1 个包
  // （无来源）」) kept its mark. (The delivered 未核实（无来源） came from
  // checkCompareRows re-marking the neutral 成本概览 column, not from this rule.)
  for (const row of dataRows) {
    row.cells = row.cells.map((cell, index) => {
      const before = String(cell ?? '')
      if (index === 0) {
        const stripped = stripCellMarks(before, [...UNSOURCED_CELL_MARKS, ...LABEL_CELL_MARKS])
        // An empty label would be worse than a marked one: no candidate can be
        // matched to `|  | … |`, so keep the original when nothing is left.
        if (!stripped) return before
        if (stripped !== before) changed = true
        return stripped
      }
      const stripped = stripCellMarks(before, UNSOURCED_CELL_MARKS)
      if (stripped === before) return before
      if (PURE_NUMBER_CELL.test(stripped)) return before
      changed = true
      return stripped
    })
  }
  // Pass 2 — a price column on a non-pricing question. `pricing` keeps its price
  // columns; an unknown kind keeps the table as written.
  if (header && kind && kind !== 'pricing') {
    const priceCol = header.cells.findIndex((cell, index) => index > 0 && PRICE_COLUMN_HEADER.test(String(cell ?? '')))
    if (priceCol > 0) {
      header.cells[priceCol] = COST_OVERVIEW_HEADER
      changed = true
      for (const row of dataRows) {
        const cell = row.cells[priceCol]
        if (cell === undefined) continue
        // Judge the value without its provenance mark: 「0.2 元（无来源）」 is a
        // pure number price, and 成本概览 may state 未核实 without a mark.
        const plain = stripCellMarks(cell, [...UNSOURCED_CELL_MARKS, ...LABEL_CELL_MARKS])
        // A price the brief could cite is a cost fact, not noise: keep the cell
        // (and its [S#]) so the rename never hides evidence.
        if (CITATION_REF.test(plain)) continue
        if (!PRICE_NUMBER_CELL.test(plain)) continue
        row.cells[priceCol] = PRICE_SEE_NOTE
      }
    }
  }
  if (!changed) return text
  for (const row of rows) {
    const original = splitTableRow(lines[row.index])
    if (original && original.join('\u0000') === row.cells.join('\u0000')) continue
    lines[row.index] = `| ${row.cells.join(' | ')} |`
  }
  return lines.join('\n')
}

/** 0.9.0 — the answer layer: one executable move after the verdict. */
export const ACTION_CHECKLIST_HEADING = '## 行动清单'
/**
 * 0.10.0 — a decision brief owes the reader the thresholds behind the verdict,
 * not just the verdict. The section is declared by the answer layer (not by the
 * strategy pack) for the same reason the checklist is: it must hold even when a
 * caller overrides the strategy, and it is part of how the brief reads.
 */
export const DECISION_CRITERIA_HEADING = '## 判据'
const DECISION_CRITERIA_PLACEHOLDER = '- 无'
export const UNSOURCED_NUMBER_MARK = '（无来源）'
const ACTION_CHECKLIST_PLACEHOLDER = '- 无'
const CHECKLIST_REQUIRED_MODES = new Set(['compare'])
// 0.10.0 — decision 题必须以「## 行动清单」收尾，所以它也进这一组。
const CHECKLIST_REQUIRED_KINDS = new Set(['tech-selection', 'learning', 'decision'])
const CITATION_REF = /\[S\d+\]/
// A number that carries no [S#]. The look-behind keeps "v22.11.0" or "GPT-4o"
// from reading as bare digits, and the optional unit lets "0.2 元" match whole.
const BARE_NUMBER = /(?<![\w.-])\d+(?:[.,]\d+)*(?:\s*(?:%|‰|元|美元|块|人民币|美分|ms|毫秒|秒|分钟|小时|天|周|个月|tokens|token|万|亿|倍|QPS|qps|RPS|rps|GB\/s|MB\/s|GB|MB|TB|K|k|M|G))?/u

function headingIndex(text, heading) {
  const label = String(heading ?? '').replace(/^##\s*/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`^##\\s*${label}\\s*$`, 'm').exec(String(text ?? ''))
  return match ? match.index : -1
}

/**
 * 「## 行动清单」 is guaranteed for every brief: the reader should never have to
 * infer the next move. A model that omitted it gets the placeholder `- 无`
 * (same "missing section downgrade" semantics as the declared sections), while
 * the pipeline decides per mode whether the omission also costs confidence.
 */
function ensureActionChecklist(brief) {
  const out = String(brief ?? '')
  if (headingIndex(out, ACTION_CHECKLIST_HEADING) >= 0) return out
  const block = `${ACTION_CHECKLIST_HEADING}\n${ACTION_CHECKLIST_PLACEHOLDER}`
  // Ordered by where the section belongs, but positioned at whichever of these
  // the brief actually has first, so the list stays after 方案对比/步骤.
  const anchors = ['## 坑与风险', '## 置信度', '## 未解决', '## 下一步建议']
    .map((heading) => headingIndex(out, heading))
    .filter((index) => index >= 0)
  const at = anchors.length > 0 ? Math.min(...anchors) : -1
  if (at < 0) return `${out}\n\n${block}`
  return `${out.slice(0, at).trimEnd()}\n\n${block}\n\n${out.slice(at)}`
}

/**
 * Per-mode required sections. The strategy pack contributes its own list; the
 * answer layer adds 「## 行动清单」 as required for compare-style modes and the
 * kinds that end in a decision — concept/track keep it optional (still filled
 * with `- 无`, just without the confidence notch). 0.10.0 adds 「## 判据」 for
 * `decision` on the same terms: a missing one is filled with `- 无` and costs
 * the brief one confidence notch.
 */
export function requiredSectionsFor({ mode = null, questionKind = null, base = null } = {}) {
  const sections = normalizeSectionList(base)
  const kind = String(questionKind ?? '')
  const wantsChecklist = CHECKLIST_REQUIRED_MODES.has(String(mode ?? ''))
    || CHECKLIST_REQUIRED_KINDS.has(kind)
  if (wantsChecklist && !sections.some(({ heading }) => heading === ACTION_CHECKLIST_HEADING)) {
    sections.push({ heading: ACTION_CHECKLIST_HEADING, fallback: SECTION_PLACEHOLDER })
  }
  // 0.10.0 — the criteria list is the part of a decision answer a reader checks
  // first ("why 8 people?"), so it is a declared section, not model courtesy.
  if (kind === 'decision' && !sections.some(({ heading }) => heading === DECISION_CRITERIA_HEADING)) {
    sections.push({ heading: DECISION_CRITERIA_HEADING, fallback: DECISION_CRITERIA_PLACEHOLDER })
  }
  return sections.length > 0 ? sections : null
}

function markBareNumberCell(cell) {
  const value = String(cell ?? '')
  if (CITATION_REF.test(value)) return value
  if (value.includes(UNSOURCED_NUMBER_MARK)) return value
  if (!BARE_NUMBER.test(value)) return value
  return `${value}${UNSOURCED_NUMBER_MARK}`
}

/**
 * 0.9.0 — number provenance fallback. In 「## 方案对比」 every row number must
 * come with [S#]; a number the synthesis model left uncited gets 「（无来源）」
 * appended to its cell instead of being deleted (deleting would hide the claim).
 * The first column is exempt (0.9.9): it holds the candidate's name, and
 * 「先拆 2-3 个服务」 is a name that happens to contain a number, not a quantitative
 * claim — marking it leaked a provenance tag into the label column.
 * Idempotent: a cell already marked, or already citing a source, is untouched.
 */
export function markUnsourcedNumbers(brief) {
  const text = String(brief ?? '')
  const lines = text.split('\n')
  const heading = lines.findIndex((line) => COMPARE_TABLE_HEADING.test(line.trim()))
  if (heading < 0) return text
  let end = lines.length
  for (let i = heading + 1; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i])) {
      end = i
      break
    }
  }
  const rows = []
  for (let i = heading + 1; i < end; i += 1) {
    const cells = splitTableRow(lines[i])
    if (cells) rows.push({ index: i, cells })
  }
  if (rows.length === 0) return text
  // A header row is the row right before the alignment separator; it labels the
  // columns rather than asserting values, so it is left alone.
  const headerIndex = rows.length >= 2 && isTableSeparator(rows[1].cells) ? rows[0].index : -1
  let changed = false
  for (const row of rows) {
    if (row.index === headerIndex || isTableSeparator(row.cells)) continue
    const next = row.cells.map((cell, i) => (i === 0 ? cell : markBareNumberCell(cell)))
    if (!next.some((cell, i) => cell !== row.cells[i])) continue
    lines[row.index] = `| ${next.join(' | ')} |`
    changed = true
  }
  return changed ? lines.join('\n') : text
}

/** 0.9.6 — prefix of the compare-table row-integrity note. */
export const COMPARE_ROW_NOTE_PREFIX = '> 注意：'
const PRICE_COLUMN = /价格|单价|费用|成本|报价|pricing|price/i
// A price cell that says nothing citable. "无证据" is deliberately absent: that
// word already declares the absence, so appending （无来源） would only repeat it.
const BARE_UNSOURCED_PRICE = /^(?:-+|—+|–+|~|～|\?|？|无|暂无|未知|未核实|待核实|待确认|不明|n\/?a|null|tbd)$/i
const SELF_EVIDENT_PRICE = /无证据|（无来源）|\(无来源\)/
// 0.9.7 — a price comparison does not always name its column 价格: "输入价" or a
// bare "每百万 tokens" column never matches PRICE_COLUMN, yet the table is about
// money. A table that states price units anywhere is treated as a price table,
// which 1.0.1 still reports through `priceTable` (the wording itself no longer
// promises a price: a blank cell can be 优势/风险/适用条件 too).
const PRICE_TABLE_SIGNAL = /元|￥|¥|\$|人民币|百万|1M\b|tokens?|price|pricing|cost/i

/**
 * 0.9.10 — 成本概览 is the neutral cost column 0.9.9 introduced for judgement
 * questions, and it is allowed to say 未核实 without a provenance mark. It must
 * therefore not be treated as the price column this layer annotates: without this
 * guard, every 未核实 sanitizeCompareTable had just cleaned was re-marked to
 * 未核实（无来源） (the delivered 判断题 bug). A real 价格/单价/费用 column is
 * unaffected, and pricing tables keep the 0.9.6 contract.
 */
export function isPriceColumnHeader(cell) {
  const text = String(cell ?? '')
  if (text.includes(COST_OVERVIEW_HEADER)) return false
  return PRICE_COLUMN.test(text)
}

/** Candidate names whose (punctuation/case-insensitive) key occurs in `cell`. */
function namesInCell(cell, names) {
  const key = optionKey(cell)
  if (!key) return []
  const hits = names.filter((name) => {
    const target = optionKey(name)
    return Boolean(target) && key.includes(target)
  })
  // "qwen" matched only because "qwen API" is in the same cell: the longer name
  // is the real hit, otherwise every API-suffixed option would look merged.
  return hits.filter((name) => !hits.some((other) => other !== name
    && optionKey(other).length > optionKey(name).length
    && optionKey(other).includes(optionKey(name))))
}

/** `未核实` → `未核实（无来源）`; null when the cell needs no mark. */
function markUnsourcedPriceCell(cell) {
  const value = String(cell ?? '').trim()
  if (!value) return `未核实${UNSOURCED_NUMBER_MARK}`
  if (SELF_EVIDENT_PRICE.test(value)) return null
  if (!BARE_UNSOURCED_PRICE.test(value)) return null
  return `${value}${UNSOURCED_NUMBER_MARK}`
}

/**
 * 0.9.6 — 「## 方案对比」 row integrity.
 *
 * The synthesis model sometimes folds two candidates into one cell
 * (`| qwen / 豆包 API | … |`), which reads as "both were compared" while only
 * one of them was priced. This checks the delivered table against the candidate
 * list and, for a candidate without its own row, appends
 * `> 注意：豆包 未作为独立行出现（关键属性未取得），下表结论不含该候选。` right
 * after the table. A candidate that does own a row but left its price cell as
 * `未核实/未知/—/空` gets `（无来源）` appended instead (the number-provenance
 * contract of markUnsourcedNumbers, extended to "no number at all").
 *
 * Returns true when every declared candidate owns an independent row; the value
 * is also mirrored into `options.stats.compareRowsComplete`. The annotated brief
 * is written to `options.sink.brief` (and returned via sink.missing /
 * sink.unsourced) because the return value is the boolean, per contract.
 * 0.9.7 adds `sink.owned` (candidates that do own an independent row) and
 * `sink.priceTable` (the table has a price column/row), which `buildResult()`
 * uses to word the zero-evidence gap line.
 * 1.0.1 adds `sink.present`: every candidate that appears in the table at all,
 * merged cells included. The gap line must only claim 「未纳入对比」 when the
 * option is genuinely absent — an option that shares a merged row is a
 * placeholder, not an omission.
 *
 * Name options: `options` (primary), `names`, `candidates`.
 */
export function checkCompareRows(brief, options = {}) {
  const config = options && typeof options === 'object' ? options : {}
  const names = [...new Set((config.options ?? config.names ?? config.candidates ?? [])
    .filter((name) => typeof name === 'string' && name.trim())
    .map((name) => name.trim()))]
  const stats = config.stats && typeof config.stats === 'object' ? config.stats : null
  const sink = config.sink && typeof config.sink === 'object' ? config.sink : null
  const text = String(brief ?? '')
  const missing = []
  const unsourced = []
  // 0.9.7 — which candidates ended up owning an independent row, and whether
  // this table has a price column/row at all. buildResult() uses both to word
  // the zero-evidence gap line: a placeholder row is not an omitted option.
  const owned = []
  // 1.0.1 — candidates that appear anywhere in the table, merged cells included;
  // `buildResult()` needs this to tell "placeholder row" from "not compared".
  const present = []
  let priceTable = false
  let out = text
  const finish = () => {
    if (stats) stats.compareRowsComplete = missing.length === 0
    if (sink) {
      sink.brief = out
      sink.missing = missing.slice()
      sink.unsourced = unsourced.slice()
      sink.owned = owned.slice()
      sink.present = present.slice()
      sink.priceTable = priceTable
    }
    return missing.length === 0
  }
  if (names.length === 0) return finish()
  const lines = text.split('\n')
  const heading = lines.findIndex((line) => COMPARE_TABLE_HEADING.test(line.trim()))
  if (heading < 0) return finish()
  let end = lines.length
  for (let i = heading + 1; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i])) {
      end = i
      break
    }
  }
  // Only the first contiguous run of table lines belongs to this table.
  let start = -1
  for (let i = heading + 1; i < end; i += 1) {
    if (splitTableRow(lines[i])) {
      start = i
      break
    }
  }
  if (start < 0) return finish()
  let stop = start
  for (let i = start; i < end; i += 1) {
    if (!splitTableRow(lines[i])) break
    stop = i
  }
  const rows = []
  for (let i = start; i <= stop; i += 1) rows.push({ index: i, cells: splitTableRow(lines[i]) })
  const header = rows.length >= 2 && isTableSeparator(rows[1].cells) ? rows[0].cells : null
  const dataRows = rows.filter((row, index) => !isTableSeparator(row.cells) && !(header && index === 0))
  for (const name of names) {
    if (rows.some((row) => namesInCell(row.cells.join(' '), names).includes(name))) present.push(name)
  }
  // 0.9.7 — decide "is this a price table" from the whole table, not only from a
  // column header the model may have worded its own way (see PRICE_TABLE_SIGNAL).
  if (PRICE_TABLE_SIGNAL.test(rows.map((row) => row.cells.join(' ')).join(' '))) priceTable = true
  // A transposed table puts the candidates in the header ("| 维度 | A | B |").
  // That layout gives each candidate its own column, so it is complete by
  // construction; the price then lives in the 价格 row, not a 价格 column.
  const headerNames = header
    ? names.filter((name) => header.some((cell, i) => i > 0 && namesInCell(cell, names).includes(name)))
    : []
  const firstColumnNames = names.filter((name) => dataRows.some((row) => namesInCell(row.cells[0] ?? '', names).includes(name)))
  const transposed = headerNames.length > 0 && firstColumnNames.length === 0

  if (transposed) {
    for (const name of names) if (!headerNames.includes(name)) missing.push(name)
    else owned.push(name)
    const priceRow = dataRows.find((row) => isPriceColumnHeader(row.cells[0]))
    if (priceRow) {
      priceTable = true
      let changed = false
      header.forEach((cell, i) => {
        if (i === 0 || !priceRow.cells[i]) return
        const owner = headerNames.find((name) => namesInCell(cell, names).includes(name))
        if (!owner) return
        const next = markUnsourcedPriceCell(priceRow.cells[i])
        if (next === null) return
        priceRow.cells[i] = next
        changed = true
        if (!unsourced.includes(owner)) unsourced.push(owner)
      })
      if (changed) lines[priceRow.index] = `| ${priceRow.cells.join(' | ')} |`
    }
  } else {
    const independent = new Map()
    for (const row of dataRows) {
      const own = namesInCell(row.cells[0] ?? '', names)
      // own.length > 1 is the merged row: one cell, several candidates, so none
      // of them owns an independent row.
      if (own.length === 1 && !independent.has(own[0])) independent.set(own[0], row)
    }
    for (const name of names) if (!independent.has(name)) missing.push(name)
    else owned.push(name)
    const priceCol = header ? header.findIndex((cell, i) => i > 0 && isPriceColumnHeader(cell)) : -1
    if (priceCol > 0) {
      priceTable = true
      for (const name of names) {
        const row = independent.get(name)
        if (!row) continue
        const next = markUnsourcedPriceCell(row.cells[priceCol])
        if (next === null) continue
        row.cells[priceCol] = next
        lines[row.index] = `| ${row.cells.join(' | ')} |`
        unsourced.push(name)
      }
    }
  }

  if (missing.length > 0) {
    const notes = missing
      .map((name) => `${COMPARE_ROW_NOTE_PREFIX}${name} 未作为独立行出现（关键属性未取得），下表结论不含该候选。`)
      .filter((note) => !text.includes(note))
    if (notes.length > 0) {
      // Always leave a blank line between the table and the quote: an unbroken
      // row of pipes plus `>` would keep some renderers inside the table.
      const after = stop + 1
      if (lines[after] !== undefined && lines[after].trim() === '') {
        lines.splice(after + 1, 0, ...notes)
      } else {
        lines.splice(after, 0, '', ...notes)
      }
    }
  }
  out = lines.join('\n')
  return finish()
}

// 1.0.1 — empty-cell detection for the compare table. The cells `applyZeroEvidenceOptions`
// blanks are 无证据, `sanitizeCompareTable` leaves 未核实, and the model itself
// writes dashes / 未知 / 空 for "we did not get this attribute".
const EMPTY_COMPARE_CELL = /^(?:无证据|未核实|待核实|待确认|未知|暂无(?:数据)?|无数据|不明|n\/?a|null|tbd|—+|–+|-+|\?|？)?$/iu
/** A filled cell keeps at most this many characters of the claim before the citation. */
const COMPARE_CELL_LIMIT = 60
const RISK_COLUMN_HEADER = /风险|限制|不足|缺点|劣势|隐患/u
const FIT_COLUMN_HEADER = /适用|场景|条件|推荐/u
const PRICE_COLUMN_HEADER_RE = /价格|单价|报价|费用|输入价|输出价|pricing|price|cost/i
// 1.0.2 — 「成本概览」是判断题的中性成本列（0.9.10 起还可以是价格列改名来的）。
// 它只接受含成本语义的断言；没有这样的断言时宁可写「未取得（无成本数据）」，
// 也不能像 1.0.1 那样回落到该选项的首条断言（那里通常是能力描述，读者会当成
// 成本数据）。`价格概览` 也算成本列：它比 `价格` 宽，语义上不是单价。
const COST_COLUMN_HEADER = /成本概览|成本|价格概览/u
// 成本语义：货币/金额、计费方式、免费、按量、token 计价、英文 price/cost/billing、
// 配额额度。只用来判断一条断言能不能进成本格，不判断它是不是好证据。
const COST_CLAIM = /元|￥|¥|\$|美元|人民币|免费|计费|按量|tokens?|千次|每百万|price|cost|billing|quota|额度/iu
/** 成本列没有任何可引用的成本断言时写这个占位，而不是借一条能力描述。 */
export const COST_MISSING_CELL = '未取得（无成本数据）'
/** 成本列一整列都是占位时的表下附注（整张表只写一次）。 */
export const COST_OVERVIEW_NOTE = '> 成本概览仅在有价目/计费证据时填充；本轮未取得，可参考「未解决」中的缺口。'
const RISK_CLAIM = /风险|限制|不支持|需要/u
const FIT_CLAIM = /适合|适用于|场景/u
const PRICE_CLAIM = /元|￥|¥|\$|人民币|免费|收费|计费|价格|定价|tokens?|pricing|price|cost/i

/** 1.0.1 — does this text mention the option at all (same edges as countOptionHits)? */
function mentionsOption(haystack, option) {
  const text = String(haystack ?? '')
  const name = String(option ?? '').trim()
  if (!text || !name) return false
  if (/[\u4e00-\u9fff]/u.test(name)) {
    const core = optionKey(name)
    // A single CJK character sits inside too much unrelated text to identify an
    // option; `countOptionHits()` drops those too.
    return core.length >= 2 && optionKey(text).includes(core)
  }
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').split(/\s+/).join('[\\s_-]*')
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}[\\d.\\-_]*(?![\\p{L}\\p{N}])`, 'iu').test(text)
}

/**
 * 1.0.1 — the claims that mention this option, highest frequency first, with the
 * `[S#]` ids of the evidence items they were read from. The evidence card's claim
 * usually repeats the cluster claim, so it only counts when it differs: otherwise
 * one assertion would look like the option's top claim twice over.
 */
function optionClaims(clusters, option) {
  const claims = new Map()
  let order = 0
  for (const cluster of Array.isArray(clusters) ? clusters : []) {
    const evidence = Array.isArray(cluster?.evidence) ? cluster.evidence : []
    const mentions = [
      cluster?.claim ?? '',
      ...evidence.flatMap((item) => [item?.claim ?? '', item?.quote ?? '', item?.title ?? '']),
    ]
    if (!mentions.some((line) => mentionsOption(line, option))) continue
    const refs = evidence.map((item) => String(item?.id ?? '')).filter((id) => /^S\d+$/.test(id))
    const add = (raw) => {
      const claim = String(raw ?? '').replace(/\s+/g, ' ').trim()
      if (!claim) return
      const key = claim.toLowerCase()
      const entry = claims.get(key) ?? { text: claim, count: 0, refs: [], order: order++ }
      entry.count += 1
      for (const ref of refs) if (!entry.refs.includes(ref)) entry.refs.push(ref)
      claims.set(key, entry)
    }
    add(cluster?.claim)
    for (const item of evidence) if (item?.claim && item.claim !== cluster?.claim) add(item.claim)
  }
  return [...claims.values()].sort((a, b) => b.count - a.count || a.order - b.order)
}

/**
 * 1.0.2 — is this table header the neutral 「成本概览」 column? Risk/适用 columns
 * win over it, exactly like `pickClaimForColumn()`, so an odd header such as
 * 「成本风险」 keeps its risk semantics instead of turning into a cost column.
 */
function isCostColumnHeader(cell) {
  const text = String(cell ?? '')
  if (RISK_COLUMN_HEADER.test(text) || FIT_COLUMN_HEADER.test(text)) return false
  return COST_COLUMN_HEADER.test(text)
}

/** Pick the claim the column is about; null keeps the 无证据 placeholder. */
function pickClaimForColumn(claims, header) {
  const column = String(header ?? '')
  if (RISK_COLUMN_HEADER.test(column)) return claims.find((claim) => RISK_CLAIM.test(claim.text)) ?? null
  if (FIT_COLUMN_HEADER.test(column)) return claims.find((claim) => FIT_CLAIM.test(claim.text)) ?? null
  // 1.0.2 — 成本概览 只接受成本断言；命中不了就由调用方写占位，不再回落到 claims[0]。
  // 放在真价格列之前，因为 `价格概览` 同时匹配 `价格`。
  if (isCostColumnHeader(column)) return claims.find((claim) => COST_CLAIM.test(claim.text)) ?? null
  // 成本概览 is not a price axis (0.9.10 renamed it on purpose), so only a real
  // price column prefers a price-bearing claim.
  if (PRICE_COLUMN_HEADER_RE.test(column)) {
    return claims.find((claim) => PRICE_CLAIM.test(claim.text)) ?? claims[0] ?? null
  }
  return claims[0] ?? null
}

/**
 * 1.0.1 — `validateCitations()` renumbers `[S#]` by the order the brief cites
 * them, so `clusters` still hold the ids `assignSourceIds()` handed out before
 * that pass. Remap them onto the delivered `sources` (by URL, then by title for
 * republished copies) so a filled cell never cites a reference the reader cannot
 * find. An item that cannot be matched loses its id and contributes no citation.
 */
function remapClusterSourceIds(clusters, sources) {
  const list = Array.isArray(sources) ? sources : []
  const byUrl = new Map()
  const byTitle = new Map()
  for (const source of list) {
    const id = source?.id
    if (!id) continue
    const key = canonicalKey(source?.url)
    if (key) byUrl.set(key, id)
    const title = normalizeTitle(source?.title)
    if (title) byTitle.set(title, id)
  }
  if (byUrl.size === 0 && byTitle.size === 0) return Array.isArray(clusters) ? clusters : []
  return (Array.isArray(clusters) ? clusters : []).map((cluster) => {
    const evidence = Array.isArray(cluster?.evidence) ? cluster.evidence : []
    return {
      ...cluster,
      evidence: evidence.map((item) => {
        const key = canonicalKey(item?.url)
        const id = (key && byUrl.get(key)) || byTitle.get(normalizeTitle(item?.title)) || null
        return id ? { ...item, id } : { ...item, id: undefined }
      }),
    }
  })
}

/**
 * 1.0.1 — fills the 「无证据」 cells of 「## 方案对比」 with the option's own evidence.
 *
 * A table whose every cell reads 无证据 contradicts the reference list: the
 * clusters do mention the option, the synthesis model just did not copy them into
 * the row. For each row owned by exactly one option, every empty cell takes that
 * option's most frequent claim (first 60 characters) with the `[S#]` ids it came
 * from. The column decides which claim: 风险 columns take the first claim with
 * 风险/限制/不支持/需要, 适用 columns the first with 适合/适用于/场景, a price column
 * prefers a price-bearing claim, everything else the top claim. When no claim
 * matches the cell keeps 无证据 — a made-up attribute is worse than an empty one.
 * A merged row (`| qwen / 豆包 API |`) is left alone because the owner is not one
 * option. Idempotent: a filled cell is no longer empty.
 *
 * 1.0.2 — the 「成本概览」 column only takes a claim with cost semantics (货币 /
 * 计费 / token 价 / price / billing / quota …). Without one it writes
 * COST_MISSING_CELL instead of borrowing the option's top claim: a capability
 * sentence in a cost column reads like a cost finding. When every 成本概览 cell
 * ends up as that placeholder, COST_OVERVIEW_NOTE is appended under the table
 * (once). Real price columns (输入价 / 输出价 / 单价 …) keep the 1.0.1 behaviour.
 *
 * `options` is the candidate list; without it the table's own row labels are used.
 */
export function fillEmptyCompareCells(table, clusters = [], options = []) {
  const text = String(table ?? '')
  if (!text) return text
  const lines = text.split('\n')
  const heading = lines.findIndex((line) => COMPARE_TABLE_HEADING.test(line.trim()))
  if (heading < 0) return text
  let end = lines.length
  for (let i = heading + 1; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i])) {
      end = i
      break
    }
  }
  let start = -1
  for (let i = heading + 1; i < end; i += 1) {
    if (splitTableRow(lines[i])) {
      start = i
      break
    }
  }
  if (start < 0) return text
  let stop = start
  for (let i = start; i < end; i += 1) {
    if (!splitTableRow(lines[i])) break
    stop = i
  }
  const rows = []
  for (let i = start; i <= stop; i += 1) rows.push({ index: i, cells: splitTableRow(lines[i]) })
  const header = rows.length >= 2 && isTableSeparator(rows[1].cells) ? rows[0].cells : null
  const dataRows = rows.filter((row, index) => !isTableSeparator(row.cells) && !(header && index === 0))
  const costCol = header ? header.findIndex((cell, index) => index > 0 && isCostColumnHeader(cell)) : -1
  const names = [...new Set((Array.isArray(options) ? options : [])
    .filter((name) => typeof name === 'string' && name.trim())
    .map((name) => name.trim()))]
  const fillCell = (row, index, claim) => {
    const refs = claim.refs.map((id) => ` [${id}]`).join('')
    row.cells[index] = `${truncate(claim.text, COMPARE_CELL_LIMIT)}${refs}`
  }
  let changed = false
  for (const row of dataRows) {
    const label = stripCellMarks(row.cells[0] ?? '', LABEL_CELL_MARKS).trim()
    const matched = names.length > 0 ? namesInCell(label, names) : []
    const option = names.length > 0 ? (matched.length === 1 ? matched[0] : '') : label
    if (!option || !optionKey(option)) continue
    const claims = optionClaims(clusters, option)
    if (claims.length === 0) continue
    for (let i = 1; i < row.cells.length; i += 1) {
      const value = stripCellMarks(row.cells[i] ?? '', [...UNSOURCED_CELL_MARKS, ...LABEL_CELL_MARKS]).trim()
      if (!EMPTY_COMPARE_CELL.test(value)) continue
      const cost = i === costCol
      const claim = pickClaimForColumn(claims, header?.[i] ?? '')
      if (claim) {
        fillCell(row, i, claim)
        changed = true
        continue
      }
      // 1.0.2 — a cost cell with no cost-bearing claim states the absence. Other
      // columns keep 无证据 (1.0.1 contract): a made-up attribute is worse.
      if (cost) {
        row.cells[i] = COST_MISSING_CELL
        changed = true
      }
    }
  }
  const allCostMissing = costCol > 0 && dataRows.length > 0 && dataRows.every((row) => {
    const value = stripCellMarks(row.cells[costCol] ?? '', [...UNSOURCED_CELL_MARKS, ...LABEL_CELL_MARKS]).trim()
    return value === COST_MISSING_CELL
  })
  const addNote = allCostMissing && !lines.includes(COST_OVERVIEW_NOTE)
  if (!changed && !addNote) return text
  for (const row of dataRows) lines[row.index] = `| ${row.cells.join(' | ')} |`
  if (addNote) {
    // A blank line keeps Markdown renderers from reading the quote as a table row.
    lines.splice(stop + 1, 0, '', COST_OVERVIEW_NOTE)
  }
  return lines.join('\n')
}

/** Deterministic brief used when the synthesis model fails or the run is partial. */
export function fallbackBrief({ question, clusters, gaps, partial, reason }) {
  const confirmed = clusters.filter((cluster) => cluster.status === 'confirmed')
  const disputed = clusters.filter((cluster) => cluster.status === 'disputed')
  const unverified = clusters.filter((cluster) => cluster.status === 'unverified')

  const lines = ['## 结论']
  if (confirmed.length > 0) {
    lines.push(`围绕「${truncate(question, 60)}」，已确认以下要点：`)
    for (const cluster of confirmed.slice(0, 5)) {
      lines.push(`- ${cluster.claim}${cluster.evidence.map((item) => ` [${item.id}]`).join('')}`)
    }
  } else {
    lines.push('（证据不足，未能形成可靠结论）')
  }

  if (disputed.length > 0) {
    lines.push('', '## 有争议')
    for (const cluster of disputed.slice(0, 4)) {
      lines.push(`- ${cluster.claim}：来源说法不一致${cluster.evidence.map((item) => ` [${item.id}]`).join('')}`)
    }
  }

  if (unverified.length > 0) {
    lines.push('', '## 待验证')
    for (const cluster of unverified.slice(0, 4)) {
      lines.push(`- ${truncate(cluster.claim, 120)}${cluster.evidence.map((item) => ` [${item.id}]`).join('')}（单一来源）`)
    }
  }

  lines.push('', '## 置信度', confirmed.length >= 3 ? 'medium（自动汇总，未经综合模型复核）' : 'low（证据有限）')

  lines.push('', '## 未解决')
  if (gaps.length > 0) for (const gap of gaps) lines.push(`- ${gap}`)
  else lines.push('- 无')
  if (reason) lines.push(`- 说明：${reason}`)

  if (partial) lines.push('', '> 本次研究未跑完（预算或时间耗尽），以上为已获取部分的汇总。')
  return lines.join('\n')
}

/**
 * One line per side of a disagreement: the reader must see the two claims and
 * who says each, not a smooth "experts believe" summary. At most four lines
 * (two disputed clusters), one side each.
 */
export function conflictLines(clusters = []) {
  const lines = []
  for (const cluster of clusters) {
    if (!cluster || cluster.status !== 'disputed') continue
    const sides = [
      ['支持', (cluster.evidence ?? []).find((item) => item?.stance === 'support')],
      ['反驳', (cluster.evidence ?? []).find((item) => item?.stance === 'refute')],
    ]
    for (const [label, item] of sides) {
      if (lines.length >= 4) break
      if (!item || !item.id) continue
      const domain = item.domain || domainOf(item.url) || '未知来源'
      lines.push(`- ${truncate(cluster.claim, 60)}（${label}）— [${item.id}] ${domain}`)
    }
    if (lines.length >= 4) break
  }
  return lines.slice(0, 4)
}

const ASSERTION_UNIT_WORDS = /^(版本|版本号|日期|月份)$/

/** `0.2 元/百万 tokens（[S1]）` — the unit stays visible, never averaged away. */
function assertionValueBody(entry) {
  const value = String(entry?.value ?? '')
  const unit = String(entry?.unit ?? '')
  return !unit || ASSERTION_UNIT_WORDS.test(unit) ? value : unit === '%' ? `${value}%` : `${value} ${unit}`
}

function formatAssertionValue(entry) {
  const body = assertionValueBody(entry)
  const source = String(entry?.source ?? '')
  if (!source) return body
  return `${body}（${/^S\d+$/.test(source) ? `[${source}]` : source}）`
}

/**
 * One line per numeric property that independent sources state differently.
 * These come first: a number that two sources disagree on is the most concrete
 * conflict in the report. At most four lines, matching the section cap.
 */
export function assertionConflictLines(conflicts = []) {
  const lines = []
  for (const conflict of conflicts) {
    if (lines.length >= 4) break
    const values = (conflict?.values ?? []).filter((entry) => entry && entry.value !== undefined && entry.value !== '')
    if (values.length < 2) continue
    const attribute = truncate(String(conflict?.attribute ?? ''), 40) || '数值'
    // Values that cannot be converted into one unit (元 vs 美元) are listed side
    // by side; the label tells the reader not to compare them as numbers.
    const suffix = conflict.unitMismatch ? '（单位不一致）' : ''
    lines.push(`- ${attribute}：${values.slice(0, 3).map(formatAssertionValue).join(' · ')}${suffix}`)
  }
  return lines.slice(0, 4)
}

/**
 * Numbers that differ because they describe different objects. This is not a
 * conflict — qwen3-coder-plus' output ceiling and a Bedrock Claude Sonnet 4
 * limit are both true — but the brief must say so once, or the reader compares
 * two numbers that were never about the same thing. At most two lines.
 */
export function divergenceLines(divergences = []) {
  const lines = []
  for (const divergence of divergences) {
    if (lines.length >= 2) break
    const values = (divergence?.values ?? []).filter((entry) => entry && entry.value !== undefined && entry.value !== '')
    if (values.length < 2) continue
    const attribute = truncate(String(divergence?.attribute ?? ''), 40) || '数值'
    lines.push(`- 口径差异：${attribute}在不同对象上分别为 ${values.slice(0, 2).map(formatAssertionValue).join(' / ')}，不可直接比较`)
  }
  return lines.slice(0, 2)
}

/**
 * 0.6.1 — 口径差异: values that cannot be compared, with the reason spelled out.
 * Two shapes feed it: numbers that describe different entities (divergences) and
 * numbers whose units cannot be converted (unitMismatch conflicts). At most two
 * lines, matching the subsection cap; the reader gets the why, not just the two
 * numbers side by side.
 */
export function scopeDifferenceLines(divergences = [], assertionConflicts = []) {
  const lines = []
  for (const divergence of divergences) {
    if (lines.length >= 2) break
    const values = (divergence?.values ?? []).filter((entry) => entry && entry.value !== undefined && entry.value !== '')
    if (values.length < 2) continue
    const attribute = truncate(String(divergence?.attribute ?? ''), 40) || '数值'
    lines.push(`- ${attribute}：${values.slice(0, 2).map(formatAssertionValue).join(' / ')}（对象不同，不可直接比较）`)
  }
  for (const conflict of assertionConflicts) {
    if (lines.length >= 2) break
    if (!conflict?.unitMismatch) continue
    const values = (conflict?.values ?? []).filter((entry) => entry && entry.value !== undefined && entry.value !== '')
    if (values.length < 2) continue
    const attribute = truncate(String(conflict?.attribute ?? ''), 40) || '数值'
    const units = [...new Set(values.slice(0, 2).map((entry) => String(entry.unit ?? '')).filter(Boolean))]
    const reason = units.length >= 2 ? `单位不同：${units.join(' / ')}` : '统计口径不同'
    lines.push(`- ${attribute}：${values.slice(0, 2).map(formatAssertionValue).join(' / ')}（${reason}，不可直接比较）`)
  }
  return lines.slice(0, 2)
}

/** `- 输出上限：384K tokens / 256K tokens（[S1] 同一页面内说法不一致）` */
export function selfContradictionLines(contradictions = []) {
  const lines = []
  for (const contradiction of contradictions) {
    if (lines.length >= 2) break
    const values = (contradiction?.values ?? []).filter((entry) => entry && entry.value !== undefined && entry.value !== '')
    if (values.length < 2) continue
    const attribute = truncate(String(contradiction?.attribute ?? ''), 40) || '数值'
    const source = String(contradiction?.source ?? values[0]?.source ?? '')
    const ref = source ? `（${/^S\d+$/.test(source) ? `[${source}]` : source} 同一页面内说法不一致）` : '（同一页面内说法不一致）'
    lines.push(`- ${attribute}：${values.slice(0, 2).map(assertionValueBody).join(' / ')}${ref}`)
  }
  return lines.slice(0, 2)
}

function conflictLinesByKind(clusters, assertionConflicts, divergences, selfContradictions) {
  // A unit-mismatch pair is not a factual conflict: both numbers may be right,
  // they just cannot be converted into one unit, so it belongs to 口径差异.
  const factual = (assertionConflicts ?? []).filter((conflict) => !conflict?.unitMismatch)
  return {
    fact: [...assertionConflictLines(factual), ...conflictLines(clusters)].slice(0, 4),
    scope: scopeDifferenceLines(divergences, assertionConflicts),
    self: selfContradictionLines(selfContradictions),
  }
}

/**
 * The three-way conflict section. 事实冲突, 来源自相矛盾 and an unconvertible-unit
 * pair are findings and may create the section; a pure entity divergence only
 * annotates, so a brief whose only numeric note is a divergence keeps the legacy
 * 未解决 sentence instead of a section whose other two headings would be empty.
 * All three empty returns '' — no section at all, so an empty run grows no new
 * headings.
 */
function conflictSectionText(clusters, assertionConflicts, divergences, selfContradictions) {
  const { fact, scope, self } = conflictLinesByKind(clusters, assertionConflicts, divergences, selfContradictions)
  // 0.6.3: two vendors quoting 元 vs 美元 is an incomparable-unit pair. It belongs
  // in 口径差异 and must be stated, even when no factual conflict exists.
  const unitMismatch = (assertionConflicts ?? []).some((conflict) => conflict?.unitMismatch)
  if (fact.length === 0 && self.length === 0 && !unitMismatch) return { text: '', hasScope: false }
  const text = [
    CONFLICT_HEADING,
    FACT_CONFLICT_HEADING,
    fact.length > 0 ? fact.join('\n') : '- 无',
    SCOPE_DIFFERENCE_HEADING,
    scope.length > 0 ? scope.join('\n') : '- 无',
    SELF_CONTRADICTION_HEADING,
    self.length > 0 ? self.join('\n') : '- 无',
  ].join('\n')
  return { text, hasScope: scope.length > 0 }
}

/** Insert the conflict section before 置信度 unless the brief already has one. */
export function appendConflictSection(brief, clusters = [], assertionConflicts = [], divergences = [], selfContradictions = []) {
  let text = String(brief ?? '').trim()
  if (text === '') return text
  const existing = /^##\s*存在冲突/m.test(text)
  const section = existing ? { text: '', hasScope: false } : conflictSectionText(clusters, assertionConflicts, divergences, selfContradictions)
  // The 口径差异 note lives in 未解决 when no section carries it, and is added
  // before citation checking so its [S#] ids are renumbered like any other.
  if (!section.hasScope) text = injectGapBullets(text, divergenceLines(divergences))
  if (existing || section.text === '') return text
  const confidence = /^##\s*置信度/m.exec(text)
  if (confidence) {
    return `${text.slice(0, confidence.index).trimEnd()}\n\n${section.text}\n\n${text.slice(confidence.index)}`
  }
  const gaps = /^##\s*未解决/m.exec(text)
  if (gaps) {
    return `${text.slice(0, gaps.index).trimEnd()}\n\n${section.text}\n\n${text.slice(gaps.index)}`
  }
  return `${text}\n\n${section.text}`
}

function sectionBullets(text, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // `$` is not usable as "end of input" under the m flag: it would stop at the
  // end of the first bullet. `(?![^])` means end of string instead.
  const match = new RegExp(`^${escaped}[ \\t]*\\n([\\s\\S]*?)(?=\\n##[ \\t]|(?![^]))`, 'm').exec(String(text ?? ''))
  if (!match) return []
  return match[1].split('\n').map((line) => line.trim())
    // `- 无` is a placeholder for an empty conflict kind, not a conflict.
    .filter((line) => line.startsWith('- ') && !/^-\s*无$/.test(line))
}

/** The body of 「## 未解决」, '' when the section or brief is missing. */
function unresolvedBodyOf(text) {
  const match = /^##\s*未解决\s*\n([\s\S]*?)(?=\n##\s|(?![^]))/m.exec(String(text ?? ''))
  return match ? match[1] : ''
}

/**
 * Append bullets to 「未解决」, replacing a lone 「无」 and skipping lines the
 * section already has. A missing section is created so a concrete gap is never
 * lost to a brief that forgot its own heading.
 */
function injectGapBullets(out, bullets) {
  if (bullets.length === 0) return out
  const current = /^##\s*未解决\s*\n([\s\S]*?)(?=\n##\s|(?![^]))/m.exec(out)
  const body = unresolvedBodyOf(out)
  const missing = bullets.filter((bullet) => !body.includes(bullet.replace(/^- /, '')))
  if (missing.length === 0) return out
  const text = missing.join('\n')
  const onlyNone = /^\s*(?:[-*]\s*)?无\s*$/.test(body.trim())
  if (!current) return `${out}\n\n## 未解决\n${text}`
  return out.replace(
    current[0],
    () => `${onlyNone ? '## 未解决' : current[0].trimEnd()}\n${text}\n`,
  )
}

/** Guarantee the two decision-critical sections exist even if the model omitted them. */
export function ensureSections(brief, confidence, gaps, conflicts = [], sections = null, assertionConflicts = [], divergences = [], selfContradictions = []) {
  let out = String(brief ?? '').trim()
  // Disagreement is a finding, not noise: surface it above the verdict. The
  // section is normally inserted before citation renumbering (so the [S#] ids
  // are already final); this is the safety net for direct callers.
  const hasConflictHeading = /^##\s*存在冲突/m.test(out)
  const conflict = hasConflictHeading
    ? { text: '', hasScope: false }
    : conflictSectionText(conflicts, assertionConflicts, divergences, selfContradictions)
  if (conflict.text) {
    const anchor = /^##\s*置信度/m.exec(out)
    out = anchor
      ? `${out.slice(0, anchor.index).trimEnd()}\n\n${conflict.text}\n\n${out.slice(anchor.index)}`
      // No confidence section yet: it is appended below, so this lands first.
      : `${out}\n\n${conflict.text}`
  }
  if (!/^##\s*置信度/m.test(out)) {
    out += `\n\n## 置信度\n${confidence ?? 'low'}（工具按已确认来源数计算）`
  }
  out = ensureActionChecklist(out)
  const realGaps = (gaps ?? []).filter((gap) => gap && !/^无$/.test(String(gap).trim()))
  const section = /^##\s*未解决\s*\n([\s\S]*?)(?=\n##\s|$)/m.exec(out)
  const existing = section ? section[1] : ''
  const existingEmpty = section ? !/^\s*[-*]\s*(?!无)\S/m.test(existing) : true
  if (section && existingEmpty && confidence === 'low') {
    // "未解决: 无" next to a low confidence verdict hides real uncertainty.
    out = out.replace(section[0], `${section[0].trimEnd()}\n- 证据不足：关键事实缺少一手或独立来源确认`)
  } else if (!section) {
    out += `\n\n## 未解决\n${realGaps.length > 0 ? realGaps.map((gap) => `- ${gap}`).join('\n') : '- 无'}`
  }
  // An official price list that could not be read is a concrete gap the reader
  // must see, so it is injected even when the model already wrote 「## 未解决」
  // (generic gaps are deliberately left to the model there). Scoped to this
  // prefix, so no other gap changes behaviour.
  const officialGaps = realGaps.filter((gap) => /^官方价目页未取到：/.test(String(gap)))
  out = injectGapBullets(out, officialGaps.map((gap) => `- ${gap}`))
  // Two numbers that differ only because they measure different objects are not
  // a conflict, but they must not be read as one fact either. When the section
  // above already lists them under 口径差异, the note would say it twice.
  if (!conflict.hasScope) out = injectGapBullets(out, divergenceLines(divergences))
  // A brief that ends on "未解决" leaves the reader with no move; always end on
  // an executable next step.
  if (!/^##\s*下一步建议/m.test(out)) {
    out += `\n\n${NEXT_STEPS_HEADING}\n${NEXT_STEPS_FALLBACK}`
  }
  // Strategy-declared sections (design §4): the four headings above are the
  // legacy minimum for every kind; a pack may require more. A missing one gets
  // its fallback placeholder so the reader sees the gap instead of a silent
  // omission, and the pipeline drops confidence one notch for it. The heading
  // text is data from the pack, never rewritten here.
  const declared = missingSections(out, sections)
  if (declared.length > 0) {
    const block = declared.map(({ heading, fallback }) => `${heading}\n${fallback}`).join('\n\n')
    const anchor = /^##\s*置信度/m.exec(out)
    out = anchor
      ? `${out.slice(0, anchor.index).trimEnd()}\n\n${block}\n\n${out.slice(anchor.index)}`
      : `${out}\n\n${block}`
  }
  return out
}

const CRITERIA_INFERENCE_MARK = '（推断）'
const CRITERIA_HEADING_LINE = /^##[ \t]*判据[ \t]*$/m
const CRITERIA_EXPLICIT_MARK = /（推断）|\(推断\)|（无来源）|\(无来源\)/
const CITATION_ID = /\[S(\d+)\]/g

/**
 * 0.10.1 — criteria grounding.
 *
 * A `## 判据` bullet that names no source is the model's own judgement ("团队 ≥ 8
 * 人且日发布 ≥ 3 次才划算"), and a judgement must not read like a finding. Every
 * such line gets an explicit （推断） at the end; a line that already carries
 * `[S#]` or an explicit `（推断）` / `（无来源）` mark is left untouched. The
 * placeholder `- 无` is not a criterion. Idempotent: the appended mark is itself
 * one of the marks that makes the line skip.
 *
 * `sources` is the final reference table. A `[S#]` whose id is not in it grounds
 * nothing (the citation-hygiene pass would drop it), so it counts as unsourced —
 * but only when the table is non-empty, so a direct caller that passes no table
 * keeps the plain "has a bracket" rule.
 */
export function groundCriteria(brief, sources) {
  const text = String(brief ?? '')
  const heading = CRITERIA_HEADING_LINE.exec(text)
  if (!heading) return text
  const known = new Set((Array.isArray(sources) ? sources : [])
    .map((source) => source?.id)
    .filter(Boolean))
  const grounds = (line) => {
    const ids = [...line.matchAll(CITATION_ID)].map((match) => `S${match[1]}`)
    if (ids.length === 0) return false
    return known.size === 0 || ids.some((id) => known.has(id))
  }
  const start = heading.index + heading[0].length
  const rest = text.slice(start)
  const next = /\n##[ \t]/.exec(rest)
  const end = next ? next.index : rest.length
  const section = rest.slice(0, end).split('\n').map((line) => {
    if (!line.startsWith('- ')) return line
    if (/^-\s*无\s*$/.test(line.trim())) return line
    if (CRITERIA_EXPLICIT_MARK.test(line)) return line
    if (grounds(line)) return line
    return `${line.replace(/[ \t]+$/, '')}${CRITERIA_INFERENCE_MARK}`
  }).join('\n')
  return `${text.slice(0, start)}${section}${rest.slice(end)}`
}

const SECTION_PLACEHOLDER = '- 不适用'
// ensureSections() adds these unconditionally, so a strategy listing them is
// never "missing" — only data-dependent or model-written sections can be.
const ALWAYS_SECTIONS = new Set(['置信度', '未解决', '下一步建议'])

/** Normalise `[{ heading, fallback }]` (plain headings allowed) into a list. */
function normalizeSectionList(sections) {
  if (!Array.isArray(sections)) return []
  const out = []
  for (const entry of sections) {
    const raw = typeof entry === 'string' ? entry : entry?.heading
    if (typeof raw !== 'string') continue
    const text = raw.trim()
    if (!text) continue
    const label = text.replace(/^#+\s*/, '')
    if (!label) continue
    const fallback = typeof entry?.fallback === 'string' && entry.fallback.trim()
      ? entry.fallback.trim()
      : SECTION_PLACEHOLDER
    out.push({ heading: `## ${label}`, fallback })
  }
  return out
}

function hasSection(text, heading) {
  const label = heading.replace(/^##\s*/, '')
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^##\\s*${escaped}\\s*$`, 'm').test(text)
}

/**
 * Declared sections the brief does not have yet. Headings ensureSections()
 * always appends are excluded, because their absence now does not mean they will
 * be absent in the delivered brief. Exported so the pipeline can take the
 * confidence notch before buildResult() fills the placeholders.
 */
export function missingSections(brief, sections) {
  const text = String(brief ?? '')
  return normalizeSectionList(sections).filter(({ heading }) => {
    if (ALWAYS_SECTIONS.has(heading.replace(/^##\s*/, ''))) return false
    return !hasSection(text, heading)
  })
}

export function buildResult({
  brief, sources, confidence, gaps, partial, depth, stats,
  conflicts = [], sections = null, assertionConflicts = [], divergences = [], selfContradictions = [], pages = [],
  zeroEvidenceOptions = [], compareOptions = [], questionKind = null, clusters = [],
}) {
  const withSections = ensureSections(brief, confidence, gaps, conflicts, sections, assertionConflicts, divergences, selfContradictions)
  // 0.10.1 — a 判据 bullet with no [S#] and no explicit mark is the model's own
  // judgement; label it before any downstream pass so the delivered text (and
  // every derived count) sees the same line. Placed here, after citation
  // renumbering has happened in the pipeline, so a surviving [S#] is a real one.
  const withCriteria = groundCriteria(withSections, sources)
  // 0.7.1 — compensate for a model that ignored the zero-evidence gap: the table
  // row is blanked/added, and the same fact is injected into 「未解决」 so the
  // reader sees it whether or not the model wrote the section itself.
  const withZeroEvidence = applyZeroEvidenceOptions(withCriteria, zeroEvidenceOptions)
  const zeroNames = (Array.isArray(zeroEvidenceOptions) ? zeroEvidenceOptions : [])
    .filter((option) => typeof option === 'string' && option.trim())
    .map((option) => option.trim())
  // 0.9.9 — the compare table is cleaned before the annotating layers: provenance
  // marks out of the label column / non-numeric cells, and a 价格 column turned
  // into 成本概览 for a question that has no price axis. `stats.questionKind` is
  // the pipeline's classification, so no extra plumbing is needed here.
  const withCleanTable = sanitizeCompareTable(withZeroEvidence, {
    questionKind: questionKind ?? stats?.questionKind ?? null,
  })
  // 1.0.1 — a row of 无证据 next to a reference list that does name the option is
  // a copy failure, not missing evidence: fill the empty cells from the option's
  // own claims before the provenance pass labels the numbers.
  const withFilledTable = fillEmptyCompareCells(withCleanTable, remapClusterSourceIds(clusters, sources), compareOptions)
  // 0.9.0 — numbers in the compare table without a [S#] are labelled, not cut.
  const withProvenance = markUnsourcedNumbers(withFilledTable)
  // 0.9.6 — a candidate folded into another candidate's cell
  // ("qwen / 豆包 API") is not a comparison row: declare the omission in the
  // brief and record the verdict in stats instead of letting the table imply a
  // comparison that never happened.
  const compareSink = {}
  checkCompareRows(withProvenance, { options: compareOptions, stats, sink: compareSink })
  const withCompareRows = typeof compareSink.brief === 'string' ? compareSink.brief : withProvenance
  // 0.9.7 — the zero-evidence sentence must match the table that now exists.
  // `state.compareOptions` is resolved in the pipeline before synthesis, but the
  // table is only final here (applyZeroEvidenceOptions just guaranteed every
  // zero-evidence option a row), so the wording is decided from checkCompareRows'
  // owned rows instead of guessed at gap-generation time.
  // 1.0.1 — an option that shares a merged cell is in the table but owns no row;
  // it must not be described as 「未纳入对比」 either. `present` covers both cases,
  // so the sentence and the table can never disagree about whether it is listed.
  const ownedKeys = new Set((Array.isArray(compareSink.owned) ? compareSink.owned : []).map(optionKey))
  const presentKeys = new Set([
    ...ownedKeys,
    ...(Array.isArray(compareSink.present) ? compareSink.present : []).map(optionKey),
  ])
  const priceTable = compareSink.priceTable === true
  const gapBody = unresolvedBodyOf(withCompareRows)
  // The pipeline already pushed its own line for an option (with a suffix like
  // 「（已定向检索 1 次仍未获证）」); realign it below instead of adding a second
  // bullet that would only repeat the same fact without the context.
  const zeroBullets = zeroNames
    .filter((option) => !gapBody.includes(`选项「${option}」`))
    .map((option) => `- ${zeroEvidenceGapText(option, { hasRow: presentKeys.has(optionKey(option)), priceTable })}`)
  const withZeroGaps = zeroBullets.length > 0 ? injectGapBullets(withCompareRows, zeroBullets) : withCompareRows
  const alignedBrief = withZeroGaps.split('\n')
    .map((line) => realignZeroEvidenceGapText(line, presentKeys, priceTable))
    .join('\n')
  const alignedGaps = Array.isArray(gaps)
    ? gaps.map((gap) => realignZeroEvidenceGapText(gap, presentKeys, priceTable))
    : gaps
  // The funnel line describes how 参考 was built, so it goes immediately before
  // that section; appendStats() still closes the brief with the timing line.
  const withFlow = appendRetrievalFlow(alignedBrief, stats)
  const withReferences = appendReferences(withFlow, sources, pages, stats)
  const conflictBullets = sectionBullets(withSections, CONFLICT_HEADING)
  return jsonSafe({
    brief: appendStats(withReferences, stats, depth),
    confidence,
    sources,
    gaps: alignedGaps,
    partial: Boolean(partial),
    depthUsed: depth,
    stats,
    // Keep the disagreement list next to the brief so a caller can render or
    // re-check it without parsing Markdown again.
    conflicts: conflictBullets.length > 0 ? conflictBullets : undefined,
  })
}