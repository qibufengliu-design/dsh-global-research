/**
 * Brief assembly and citation hygiene.
 * Every [S#] in the final text must exist in the source table; dangling
 * citations are removed and the remaining ids renumbered by first appearance.
 */
import { canonicalKey, jsonSafe, isMirrorUrl, truncate, domainTrust } from './util.js'

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
  if (disputed > 0) return confirmed >= 1 ? 'medium' : 'low'
  if (confirmed >= 3) return 'high'
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
    const meta = [source.domain, source.publishedAt].filter(Boolean).join(' · ')
    return `- [${source.id}] ${truncate(source.title, 90)} — ${source.url}${meta ? `（${meta}）` : ''}`
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

/** Guarantee the two decision-critical sections exist even if the model omitted them. */
export function ensureSections(brief, confidence, gaps) {
  let out = String(brief ?? '').trim()
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
  return out
}

export function buildResult({ brief, sources, confidence, gaps, partial, depth, stats }) {
  const withReferences = appendReferences(ensureSections(brief, confidence, gaps), sources)
  return jsonSafe({
    brief: appendStats(withReferences, stats, depth),
    confidence,
    sources,
    gaps,
    partial: Boolean(partial),
    depthUsed: depth,
    stats,
  })
}