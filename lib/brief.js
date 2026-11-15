/**
 * Brief assembly and citation hygiene.
 * Every [S#] in the final text must exist in the source table; dangling
 * citations are removed and the remaining ids renumbered by first appearance.
 */
import {
  canonicalKey, jsonSafe, isMirrorUrl, truncate, domainTrust, isOfficialDomain, domainOf, evidenceAgeDays,
} from './util.js'

/** Section headings the deterministic layer guarantees. Exact text matters: the UI renders them. */
export const CONFLICT_HEADING = '## 存在冲突'
export const NEXT_STEPS_HEADING = '## 下一步建议'
const NEXT_STEPS_FALLBACK = '- 按「未解决」逐条补一轮定向检索，或把关键页面 URL 直接贴进问题重查'

/**
 * Evidence grade shown next to every reference. The user should be able to see
 * at a glance whether a claim rests on a regulation, a paper, a repo, a forum
 * answer or a blog — those are not equally strong.
 */
export function gradeSource(url) {
  const value = String(url ?? '')
  if (isOfficialDomain(value)) return '官方'
  if (/arxiv\.org|doi\.org|semanticscholar\.org|openalex\.org|\/paper\//i.test(value)) return '论文'
  if (/github\.com|gitlab\.com|npmjs\.com|pypi\.org/i.test(value)) return '仓库'
  if (/stackoverflow\.com|stackexchange\.com|news\.ycombinator\.com|reddit\.com|v2ex\.com/i.test(value)) return '论坛'
  if (/wikipedia\.org/i.test(value)) return '百科'
  return '网页'
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

export function computeConfidence(clusters) {
  const confirmed = clusters.filter((cluster) => cluster.status === 'confirmed').length
  const disputed = clusters.filter((cluster) => cluster.status === 'disputed').length
  // Breadth fallback: several independent high-trust sources that do not
  // contradict each other are worth more than a single confirmed cluster.
  const strong = new Set()
  for (const cluster of clusters) {
    for (const item of cluster.evidence) {
      if (domainTrust(item.url) < 2) continue
      try {
        strong.add(new URL(item.url).hostname.replace(/^www\./, ''))
      } catch {
        strong.add(canonicalKey(item.url))
      }
    }
  }
  // Grade rule: a "high" verdict should rest on at least two independent
  // primary-grade sources (regulation/paper), not on three blogs agreeing.
  const primary = new Set()
  for (const cluster of clusters) {
    for (const item of cluster.evidence) {
      const grade = gradeSource(item.url)
      if (grade !== '官方' && grade !== '论文') continue
      try {
        primary.add(new URL(item.url).hostname.replace(/^www\./, ''))
      } catch {
        primary.add(canonicalKey(item.url))
      }
    }
  }
  if (disputed > 0) return confirmed >= 1 ? 'medium' : 'low'
  if (confirmed >= 3) return primary.size >= 2 ? 'high' : 'medium'
  if (confirmed >= 1 || strong.size >= 2) return 'medium'
  return 'low'
}

const DEPTH_LABELS = { quick: '快速档', standard: '标准档', deep: '深度档' }
const STATS_LINE = /^>\s*本次检索：/m

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
  return `${text}\n\n> 本次检索：${queries} 个查询 · ${pages} 个页面 · ${evidence} 条证据 · ${seconds} 秒${tail}${reuse}`
}

export function appendReferences(brief, sources) {
  if (sources.length === 0) return brief
  const lines = sources.map((source) => {
    const meta = [gradeSource(source.url), source.domain, source.publishedAt].filter(Boolean).join(' · ')
    // A two-year-old page is still citable, but the reader deserves to know the
    // claim may have moved on. Unknown dates are never flagged as old.
    const age = evidenceAgeDays(source.publishedAt)
    const stale = age !== null && age > 730 ? ' · 旧' : ''
    return `- [${source.id}] ${truncate(source.title, 90)} — ${source.url}（${meta}）${stale}`
  })
  return `${brief}\n\n## 参考\n${lines.join('\n')}`
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

/** Insert the conflict section before 置信度 unless the brief already has one. */
export function appendConflictSection(brief, clusters = []) {
  const text = String(brief ?? '').trim()
  if (text === '' || /^##\s*存在冲突/m.test(text)) return text
  const lines = conflictLines(clusters)
  if (lines.length === 0) return text
  const section = `${CONFLICT_HEADING}\n${lines.join('\n')}`
  const confidence = /^##\s*置信度/m.exec(text)
  if (confidence) {
    return `${text.slice(0, confidence.index).trimEnd()}\n\n${section}\n\n${text.slice(confidence.index)}`
  }
  const gaps = /^##\s*未解决/m.exec(text)
  if (gaps) {
    return `${text.slice(0, gaps.index).trimEnd()}\n\n${section}\n\n${text.slice(gaps.index)}`
  }
  return `${text}\n\n${section}`
}

function sectionBullets(text, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // `$` is not usable as "end of input" under the m flag: it would stop at the
  // end of the first bullet. `(?![^])` means end of string instead.
  const match = new RegExp(`^${escaped}[ \\t]*\\n([\\s\\S]*?)(?=\\n##[ \\t]|(?![^]))`, 'm').exec(String(text ?? ''))
  if (!match) return []
  return match[1].split('\n').map((line) => line.trim()).filter((line) => line.startsWith('- '))
}

/** Guarantee the two decision-critical sections exist even if the model omitted them. */
export function ensureSections(brief, confidence, gaps, conflicts = []) {
  let out = String(brief ?? '').trim()
  // Disagreement is a finding, not noise: surface it above the verdict. The
  // section is normally inserted before citation renumbering (so the [S#] ids
  // are already final); this is the safety net for direct callers.
  const conflictBlock = /^##\s*存在冲突/m.test(out) ? '' : conflictLines(conflicts).join('\n')
  if (conflictBlock) {
    const anchor = /^##\s*置信度/m.exec(out)
    out = anchor
      ? `${out.slice(0, anchor.index).trimEnd()}\n\n${CONFLICT_HEADING}\n${conflictBlock}\n\n${out.slice(anchor.index)}`
      // No confidence section yet: it is appended below, so this lands first.
      : `${out}\n\n${CONFLICT_HEADING}\n${conflictBlock}`
  }
  if (!/^##\s*置信度/m.test(out)) {
    out += `\n\n## 置信度\n${confidence ?? 'low'}（工具按已确认来源数计算）`
  }
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
  // A brief that ends on "未解决" leaves the reader with no move; always end on
  // an executable next step.
  if (!/^##\s*下一步建议/m.test(out)) {
    out += `\n\n${NEXT_STEPS_HEADING}\n${NEXT_STEPS_FALLBACK}`
  }
  return out
}

export function buildResult({ brief, sources, confidence, gaps, partial, depth, stats, conflicts = [] }) {
  const withSections = ensureSections(brief, confidence, gaps, conflicts)
  const withReferences = appendReferences(withSections, sources)
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