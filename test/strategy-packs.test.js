import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildQueries, extractEvidence, strategyDirectedQueries,
} from '../lib/pipeline.js'
import {
  computeConfidence, downgradeConfidence, ensureSections, missingSections,
} from '../lib/brief.js'
import { rankBoosts, resolveStrategy } from '../lib/strategy.js'
import { QUESTION_KINDS } from '../lib/strategies.js'
import { domainTrust, rankHits } from '../lib/util.js'
import { gradeSource } from '../lib/brief.js'

/*
 * PR2: the strategy pack has to change behaviour, not just exist. These tests
 * pin the three wiring points that can silently do nothing — kind-directed
 * queries, declared brief sections, and confidence gates — and, just as
 * important, that the default/empty pack still reproduces PR1 byte for byte.
 */

const QUESTION = 'Node 22 是 LTS 吗？项目该用哪个版本'
const SUBS = ['Node LTS 版本有哪些', 'Node 22 支持到什么时候']

function pack(questionKind, extra = {}) {
  const base = resolveStrategy({ questionKind, depth: 'standard' })
  return { ...base, ...extra }
}

/* ---------------------------------------------------------------- queries */

test('the default pack leaves the deterministic query plan byte-identical', () => {
  const legacy = buildQueries(SUBS, [], QUESTION, 6)
  const concept = buildQueries(SUBS, [], QUESTION, 6, resolveStrategy({ questionKind: 'concept', depth: 'standard' }))
  assert.deepEqual(concept, legacy)
  // A pack literally without query policy must not invent one either.
  assert.deepEqual(buildQueries(SUBS, [], QUESTION, 6, null), legacy)
  assert.deepEqual(strategyDirectedQueries({}, QUESTION), [])
})

test('legal leads the plan with the official publication site hint', () => {
  const legal = resolveStrategy({ questionKind: 'legal', depth: 'standard' })
  const plan = buildQueries(['GDPR 第 32 条要求什么'], [], 'GDPR 第 32 条要求什么？', 6, legal)
  assert.match(plan[0], /^site:eur-lex\.europa\.eu /)
  assert.ok(plan.some((query) => /^site:europa\.eu /.test(query)))
  // The hint is a prefix, never a replacement: the question is still there.
  assert.ok(plan[0].includes('GDPR 第 32 条要求什么'))
})

test('fresh-data adds pricing/price/recency queries stamped with the current year', () => {
  const fresh = resolveStrategy({ questionKind: 'fresh-data', depth: 'standard' })
  const year = String(new Date().getFullYear())
  const directed = strategyDirectedQueries(fresh.queries, 'Claude 订阅多少钱？')
  assert.ok(directed.some((query) => /pricing/.test(query)), directed.join(' | '))
  assert.ok(directed.some((query) => /价格/.test(query)), directed.join(' | '))
  assert.ok(directed.some((query) => query.includes(year)), directed.join(' | '))
  const plan = buildQueries([], [], 'Claude 订阅多少钱？', 6, fresh)
  assert.ok(plan.some((query) => /pricing/.test(query)), plan.join(' | '))
})

test('tech-selection adds comparison phrasing while other kinds do not', () => {
  const compare = resolveStrategy({ questionKind: 'tech-selection', depth: 'standard' })
  const directed = strategyDirectedQueries(compare.queries, 'pnpm vs yarn 该选哪个？')
  assert.ok(directed.some((query) => /\bvs\b|alternatives?\b/.test(query)), directed.join(' | '))
  assert.ok(directed.some((query) => /benchmark/.test(query)), directed.join(' | '))
  const fresh = resolveStrategy({ questionKind: 'fresh-data', depth: 'standard' })
  const freshDirected = strategyDirectedQueries(fresh.queries, 'pnpm vs yarn 该选哪个？')
  assert.notDeepEqual(compare.queries.extraTemplates, fresh.queries.extraTemplates)
  assert.ok(!freshDirected.some((query) => /benchmark/.test(query)))
})

test('every shipped kind except concept contributes directed queries, and they differ per kind', () => {
  const seen = new Map()
  for (const kind of QUESTION_KINDS) {
    const plan = strategyDirectedQueries(resolveStrategy({ questionKind: kind, depth: 'standard' }).queries, 'pnpm vs yarn 该选哪个？')
    if (kind === 'concept') {
      assert.deepEqual(plan, [], 'concept must not add queries')
      continue
    }
    assert.ok(plan.length > 0, `${kind} declares no directed query`)
    seen.set(kind, plan.join('\n'))
  }
  // No two kinds share an identical directed set: the packs are not cosmetic.
  assert.equal(new Set(seen.values()).size, seen.size)
})

// 0.10.0 — a decision question is judged from thresholds and counter-examples,
// not from a vendor's docs: the pack declares no channel and spends its directed
// queries on the way the judgement flips.
test('decision leads the plan with threshold and counter-example queries (0.10.0)', () => {
  const question = '我们团队 8 个人，微服务该不该拆'
  const decision = resolveStrategy({ questionKind: 'decision', depth: 'standard' })
  assert.deepEqual(decision.sourcePlan.channels, [])
  assert.equal(decision.depth.bias, resolveStrategy({ questionKind: 'concept', depth: 'standard' }).depth.bias)
  const directed = strategyDirectedQueries(decision.queries, question, new Date('2026-11-16'))
  assert.deepEqual(directed, [
    `${question} 何时该拆 微服务`,
    `${question} 团队规模 阈值`,
    `${question} 反例 失败`,
    `${question} trade-offs`,
  ])
  // The criteria queries lead a capped plan; the raw question is the fallback.
  const plan = buildQueries([], [], question, 6, decision)
  assert.deepEqual(plan.slice(0, 4), directed)
  assert.equal(plan[4], question)
  // Without sub-questions there is no official-docs variant in front of them.
  assert.deepEqual(strategyDirectedQueries(resolveStrategy({ questionKind: 'concept', depth: 'standard' }).queries, question), [])
})

test('queries.limit caps the plan below the caller budget', () => {
  const concept = resolveStrategy({ questionKind: 'concept', depth: 'standard' })
  const capped = { ...concept, queries: { ...concept.queries, limit: 2 } }
  const plan = buildQueries(SUBS, [], QUESTION, 6, capped)
  assert.equal(plan.length, 2)
  // A null limit (the default) keeps the caller's budget exactly.
  assert.equal(buildQueries(SUBS, [], QUESTION, 6).length <= 6, true)
  assert.ok(buildQueries(SUBS, [], QUESTION, 6).length > 2)
})

/* --------------------------------------------------------------- sections */

test('ensureSections without a section list is the legacy brief plus the 0.9.0 checklist', () => {
  const brief = '## 结论\nNode 22 是 LTS'
  const out = ensureSections(brief, 'medium', [])
  assert.equal(out, [
    '## 结论',
    'Node 22 是 LTS',
    '',
    '## 行动清单',
    '- 无',
    '',
    '## 置信度',
    'medium（工具按已确认来源数计算）',
    '',
    '## 未解决',
    '- 无',
    '',
    '## 下一步建议',
    '- 按「未解决」逐条补一轮定向检索，或把关键页面 URL 直接贴进问题重查',
  ].join('\n'))
})

test('a declared section is filled with its placeholder before 置信度', () => {
  const brief = '## 结论\nNode 22 是 LTS'
  const sections = ['## 迁移成本', { heading: '## 坑与风险', fallback: '- 未发现' }]
  const out = ensureSections(brief, 'medium', [], [], sections)
  assert.ok(out.includes('## 迁移成本\n- 不适用'), out)
  assert.ok(out.includes('## 坑与风险\n- 未发现'), out)
  assert.ok(out.indexOf('## 迁移成本') < out.indexOf('## 置信度'))
  assert.ok(out.indexOf('## 坑与风险') < out.indexOf('## 置信度'))
  // A section the brief already has is left alone, not duplicated.
  const full = '## 结论\nNode 22 是 LTS\n\n## 迁移成本\n- 两小时'
  const kept = ensureSections(full, 'medium', [], [], sections)
  assert.equal((kept.match(/^## 迁移成本/mg) ?? []).length, 1)
  assert.ok(kept.includes('## 迁移成本\n- 两小时'))
})

test('missingSections ignores the headings ensureSections always guarantees', () => {
  const text = '## 结论\nNode 22 是 LTS'
  const declared = ['## 结论', '## 置信度', '## 未解决', '## 下一步建议', '## 依据']
  assert.deepEqual(missingSections(text, declared).map((entry) => entry.heading), ['## 依据'])
  assert.deepEqual(missingSections(text, null), [])
})

/* ------------------------------------------------------------ confidence */

function evidenceItem(url, stance = 'support') {
  return { url, stance, title: 't', claim: 'c', quote: 'q', type: 'docs' }
}

function cluster(status, urls) {
  return { claim: status, status, evidence: urls.map((url) => evidenceItem(url)) }
}

const EURLEX = 'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32016R0679'
const NIST = 'https://www.nist.gov/publications/example'
const ARXIV = 'https://arxiv.org/abs/2401.00001'
const GITHUB = 'https://github.com/nodejs/node'
const BLOG = 'https://blog.example.com/post'

/** The pre-PR2 rule set, frozen here as the golden the gates must default to. */
function legacyConfidence(clusters) {
  const confirmed = clusters.filter((entry) => entry.status === 'confirmed').length
  const disputed = clusters.filter((entry) => entry.status === 'disputed').length
  const strong = new Set()
  const primary = new Set()
  for (const entry of clusters) {
    for (const item of entry.evidence) {
      const host = new URL(item.url).hostname.replace(/^www\./, '')
      if (domainTrust(item.url) >= 2) strong.add(host)
      if (gradeSource(item.url) === '官方' || gradeSource(item.url) === '论文') primary.add(host)
    }
  }
  if (disputed > 0) return confirmed >= 1 ? 'medium' : 'low'
  if (confirmed >= 3) return primary.size >= 2 ? 'high' : 'medium'
  if (confirmed >= 1 || strong.size >= 2) return 'medium'
  return 'low'
}

test('computeConfidence defaults mirror the legacy verdict on a cluster matrix', () => {
  const matrix = [
    [],
    [cluster('confirmed', [BLOG])],
    [cluster('confirmed', [BLOG]), cluster('confirmed', [GITHUB])],
    [cluster('confirmed', [EURLEX]), cluster('confirmed', [NIST]), cluster('confirmed', [GITHUB])],
    [cluster('confirmed', [BLOG]), cluster('confirmed', [ARXIV]), cluster('confirmed', [GITHUB])],
    [cluster('disputed', [EURLEX, BLOG])],
    [cluster('disputed', [EURLEX, BLOG]), cluster('confirmed', [GITHUB])],
    [cluster('unverified', [GITHUB]), cluster('unverified', [ARXIV])],
    [cluster('confirmed', [EURLEX]), cluster('disputed', [NIST, BLOG])],
  ]
  for (const clusters of matrix) {
    assert.equal(computeConfidence(clusters, {}), legacyConfidence(clusters))
    assert.equal(computeConfidence(clusters), legacyConfidence(clusters))
  }
})

test('confidence gates cap the verdict only when the pack declares them', () => {
  const threeConfirmed = [
    cluster('confirmed', [EURLEX]), cluster('confirmed', [NIST]), cluster('confirmed', [GITHUB]),
  ]
  assert.equal(computeConfidence(threeConfirmed), 'high')
  assert.equal(computeConfidence(threeConfirmed, { gate: 'medium' }), 'medium')
  assert.equal(computeConfidence(threeConfirmed, { gate: 'low' }), 'low')
  // A pack can describe "high" as not needing primary-grade sources.
  const blogsOnly = [
    cluster('confirmed', [BLOG]), cluster('confirmed', [GITHUB]), cluster('confirmed', [ARXIV]),
  ]
  assert.equal(computeConfidence(blogsOnly), 'medium')
  assert.equal(computeConfidence(blogsOnly, { highNeedsPrimary: false }), 'high')
})

test('confidence drops one notch for a missing primary source and for a missing declared section', () => {
  const clusters = [cluster('confirmed', [EURLEX]), cluster('confirmed', [NIST]), cluster('confirmed', [GITHUB])]
  assert.equal(computeConfidence(clusters, { missingPrimary: true }), 'low')
  assert.equal(computeConfidence(clusters, { missingPrimary: true, primaryMissingCap: 'medium' }), 'medium')
  assert.equal(computeConfidence(clusters, { missingSections: true }), 'medium')
  assert.equal(downgradeConfidence('high'), 'medium')
  assert.equal(downgradeConfidence('medium'), 'low')
  assert.equal(downgradeConfidence('low'), 'low')
})

/* --------------------------------------------------------------- ranking */

test('rankBoosts is undefined without a preferred vertical and ordered otherwise', () => {
  assert.equal(rankBoosts(resolveStrategy({ questionKind: 'concept', depth: 'standard' })), undefined)
  assert.equal(rankBoosts(resolveStrategy({ questionKind: 'legal', depth: 'standard' })), undefined)
  assert.equal(rankBoosts(null), undefined)
  const boosts = rankBoosts(resolveStrategy({ questionKind: 'tech-selection', depth: 'standard' }))
  assert.equal(boosts.engines.github, 2)
  assert.equal(boosts.engines.stackexchange, 1.5)
  assert.ok(boosts.domains['github.com'] > 0)
  assert.ok(boosts.domains['stackoverflow.com'] > 0)
})

test('rankHits only reorders when a pack actually declares prefer', () => {
  // 0.7.0: the tier term (forum −1, repo-doc +1) now separates these two on its
  // own, so the fixture needs a legacy order the page shape alone cannot flip:
  // a `/docs/` page first, then the forum hit, then the repo docs tree. The
  // pack's github domain boost (+2) is what lifts the repo above the doc page.
  const hits = [
    { url: 'https://example.com/docs/getting-started', engines: new Set(['x']), rank: 1 },
    { url: 'https://stackoverflow.com/questions/1/node-lts', engines: new Set(['x']), rank: 2 },
    { url: 'https://github.com/acme/widgets/tree/main/docs', engines: new Set(['x']), rank: 3 },
  ]
  const legacy = rankHits(hits, { question: '' }).map((hit) => hit.url)
  const boosted = rankHits(hits, {
    question: '',
    boosts: rankBoosts(resolveStrategy({ questionKind: 'tech-selection', depth: 'standard' })),
  }).map((hit) => hit.url)
  assert.equal(legacy[0], 'https://example.com/docs/getting-started')
  assert.equal(boosted[0], 'https://github.com/acme/widgets/tree/main/docs')
  // concept/legal declare no preference, so the ranking is untouched.
  assert.deepEqual(
    rankHits(hits, { question: '', boosts: rankBoosts(resolveStrategy({ questionKind: 'concept', depth: 'standard' })) }).map((hit) => hit.url),
    legacy,
  )
})

/* -------------------------------------------------------------- evidence */

function page(url, text) {
  return { url, finalUrl: url, title: `page ${url}`, domain: new URL(url).hostname, text, ok: true }
}

const PAGE_TEXT = 'Node 22 entered LTS in October 2025. Node 22 is the active LTS line and receives fixes until April 2027.'

test('extractEvidence keeps grounded model items and logs the count', async () => {
  const logs = []
  const client = {
    jsonCall: async () => [{
      claim: 'Node 22 is the current LTS', quote: 'Node 22 entered LTS in October 2025.', source: 0, type: 'docs', stance: 'support',
    }],
  }
  const items = await extractEvidence([page('https://nodejs.org/1', PAGE_TEXT)], null, { client, logger: (line) => logs.push(line) })
  assert.equal(items.length, 1)
  assert.equal(items[0].url, 'https://nodejs.org/1')
  assert.deepEqual(logs, ['evidence batch: 1 items'])
})

test('extractEvidence falls back to heuristics and honours the pack switches', async () => {
  const logs = []
  const client = { jsonCall: async () => [] }
  const batch = [page('https://nodejs.org/1', 'A'.repeat(200))]
  const items = await extractEvidence(batch, null, { client, logger: (line) => logs.push(line) })
  assert.equal(items.length, 1)
  assert.equal(logs.length, 1)
  assert.match(logs[0], /heuristic found 1/)
  // A pack may turn the fallback off entirely; the refill path reads the same keys.
  const off = await extractEvidence(batch, { evidence: { heuristicFallback: false } }, { client, logger: () => {} })
  assert.deepEqual(off, [])
  // ...and may silence the fallback log while keeping the fallback.
  const quietLogs = []
  await extractEvidence(batch, { evidence: { fallbackLog: false } }, { client, logger: (line) => quietLogs.push(line) })
  assert.deepEqual(quietLogs, [])
})