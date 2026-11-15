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

export function validateCitations(brief, sources) {
  const known = new Map(sources.map((source) => [source.id, source]))
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
 */
export function computeConfidence(clusters, gates = {}) {
  const options = gates && typeof gates === 'object' ? gates : {}
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
 * 0.9.2 — how many zero-evidence comparison options were retried once with a
 * directed query, and how many of those retries actually produced evidence.
 * Omitted when the step never ran, so every other brief keeps the 0.7.1 line
 * verbatim.
 */
function targetedRefillSuffix(stats) {
  const refill = stats?.targetedRefill
  if (!refill || typeof refill !== 'object') return ''
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

export function appendReferences(brief, sources, pages = []) {
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
    return `- [${source.id}] ${truncate(source.title, 90)} — ${source.url}（${meta}）${old}${retired}`
  })
  const unused = unusedPageLine(sources, pages)
  if (unused) lines.push(unused)
  return `${brief}\n\n## 参考\n${lines.join('\n')}`
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

export function zeroEvidenceGapText(option) {
  return `选项「${option}」在本轮证据中没有可用来源（零证据），未纳入对比`
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

/** 0.9.0 — the answer layer: one executable move after the verdict. */
export const ACTION_CHECKLIST_HEADING = '## 行动清单'
export const UNSOURCED_NUMBER_MARK = '（无来源）'
const ACTION_CHECKLIST_PLACEHOLDER = '- 无'
const CHECKLIST_REQUIRED_MODES = new Set(['compare'])
const CHECKLIST_REQUIRED_KINDS = new Set(['tech-selection', 'learning'])
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
 * with `- 无`, just without the confidence notch).
 */
export function requiredSectionsFor({ mode = null, questionKind = null, base = null } = {}) {
  const sections = normalizeSectionList(base)
  const wantsChecklist = CHECKLIST_REQUIRED_MODES.has(String(mode ?? ''))
    || CHECKLIST_REQUIRED_KINDS.has(String(questionKind ?? ''))
  if (wantsChecklist && !sections.some(({ heading }) => heading === ACTION_CHECKLIST_HEADING)) {
    sections.push({ heading: ACTION_CHECKLIST_HEADING, fallback: SECTION_PLACEHOLDER })
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
    const next = row.cells.map(markBareNumberCell)
    if (!next.some((cell, i) => cell !== row.cells[i])) continue
    lines[row.index] = `| ${next.join(' | ')} |`
    changed = true
  }
  return changed ? lines.join('\n') : text
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

/**
 * Append bullets to 「未解决」, replacing a lone 「无」 and skipping lines the
 * section already has. A missing section is created so a concrete gap is never
 * lost to a brief that forgot its own heading.
 */
function injectGapBullets(out, bullets) {
  if (bullets.length === 0) return out
  const current = /^##\s*未解决\s*\n([\s\S]*?)(?=\n##\s|(?![^]))/m.exec(out)
  const body = current ? current[1] : ''
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
  zeroEvidenceOptions = [],
}) {
  const withSections = ensureSections(brief, confidence, gaps, conflicts, sections, assertionConflicts, divergences, selfContradictions)
  // 0.7.1 — compensate for a model that ignored the zero-evidence gap: the table
  // row is blanked/added, and the same fact is injected into 「未解决」 so the
  // reader sees it whether or not the model wrote the section itself.
  const withZeroEvidence = applyZeroEvidenceOptions(withSections, zeroEvidenceOptions)
  const zeroBullets = (Array.isArray(zeroEvidenceOptions) ? zeroEvidenceOptions : [])
    .filter((option) => typeof option === 'string' && option.trim())
    .map((option) => `- ${zeroEvidenceGapText(option.trim())}`)
  const withZeroGaps = zeroBullets.length > 0 ? injectGapBullets(withZeroEvidence, zeroBullets) : withZeroEvidence
  // 0.9.0 — numbers in the compare table without a [S#] are labelled, not cut.
  const withProvenance = markUnsourcedNumbers(withZeroGaps)
  // The funnel line describes how 参考 was built, so it goes immediately before
  // that section; appendStats() still closes the brief with the timing line.
  const withFlow = appendRetrievalFlow(withProvenance, stats)
  const withReferences = appendReferences(withFlow, sources, pages)
  const conflictBullets = sectionBullets(withSections, CONFLICT_HEADING)
  return jsonSafe({
    brief: appendStats(withReferences, stats, depth),
    confidence,
    sources,
    gaps,
    partial: Boolean(partial),
    depthUsed: depth,
    stats,
    // Keep the disagreement list next to the brief so a caller can render or
    // re-check it without parsing Markdown again.
    conflicts: conflictBullets.length > 0 ? conflictBullets : undefined,
  })
}