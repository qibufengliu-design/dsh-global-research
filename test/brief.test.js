import test from 'node:test'
import assert from 'node:assert/strict'
import {
  appendReferences, appendStats, assignSourceIds, buildResult, computeConfidence,
  ensureSections, fallbackBrief, gradeSource, validateCitations,
} from '../lib/brief.js'
import { autoDepth, buildQueries, groupEvidence, resolveDepth, shortFragments } from '../lib/pipeline.js'

test('references carry an evidence grade so a blog does not look like a regulation', () => {
  assert.equal(gradeSource('https://eur-lex.europa.eu/eli/reg/2024/2847/oj'), '官方')
  assert.equal(gradeSource('https://stackoverflow.com/questions/1/x'), '论坛')
  assert.equal(gradeSource('https://arxiv.org/abs/2401.00001'), '论文')
  assert.equal(gradeSource('https://github.com/nodejs/release'), '仓库')
  assert.equal(gradeSource('https://example.com/blog/post'), '网页')
  const brief = appendReferences('## 结论\nok', [
    { id: 'S1', title: 'CRA', url: 'https://eur-lex.europa.eu/eli/reg/2024/2847/oj', domain: 'eur-lex.europa.eu' },
  ])
  assert.ok(brief.includes('（官方 · eur-lex.europa.eu）'))
})

test('long Chinese questions are also cut into short query fragments', () => {
  const fragments = shortFragments('我在用 Spring Boot 3 写一个带幂等重试的支付回调接口，应该怎么设计事务边界和去重表')
  assert.ok(fragments.length >= 1 && fragments.length <= 2)
  assert.ok(fragments.every((fragment) => fragment.length <= 12))
  const queries = buildQueries(['支付回调接口设计'], [], '我在用 Spring Boot 3 写一个带幂等重试的支付回调接口，应该怎么设计事务边界和去重表', 8)
  assert.ok(queries.some((query) => query.length <= 12 && /[\u4e00-\u9fff]/.test(query)))
})

test('a Chinese question still yields an English query for Latin-only engines', () => {
  const queries = buildQueries(['幂等重试'], [], 'Spring Boot 3 的幂等重试和事务边界怎么写', 8)
  assert.ok(queries.some((query) => /spring boot/i.test(query) && !/[\u4e00-\u9fff]/.test(query)))
})

function cluster(claim, urls, stance = 'support') {
  const domains = new Set(urls.map((url) => new URL(url).hostname))
  const status = stance === 'support' && urls.length >= 2 && domains.size >= 2 ? 'confirmed' : 'unverified'
  return {
    status,
    claim,
    evidence: urls.map((url, index) => ({
      claim, quote: `quote ${index}`, url, title: `title ${index}`, domain: new URL(url).hostname,
      type: 'docs', stance,
    })),
  }
}

test('validateCitations removes dangling ids and renumbers by first use', () => {
  const sources = [
    { id: 'S1', url: 'https://a.com', title: 'A' },
    { id: 'S2', url: 'https://b.com', title: 'B' },
    { id: 'S3', url: 'https://c.com', title: 'C' },
  ]
  const { brief, sources: kept } = validateCitations('结论见 [S2]，另见 [S9]，再提 [S1]。', sources)
  assert.equal(brief, '结论见 [S1]，另见 ，再提 [S2]。')
  assert.deepEqual(kept.map((s) => s.id), ['S1', 'S2'])
  assert.deepEqual(kept.map((s) => s.url), ['https://b.com', 'https://a.com'])
})

test('assignSourceIds dedupes by url and assigns stable ids', () => {
  const clusters = [cluster('claim one', ['https://a.com/x', 'https://b.com/y'])]
  const sources = assignSourceIds(clusters)
  assert.equal(sources.length, 2)
  assert.equal(clusters[0].evidence[0].id, 'S1')
  assert.equal(clusters[0].evidence[1].id, 'S2')
})

test('confidence reflects confirmed/disputed mix', () => {
  assert.equal(computeConfidence([]), 'low')
  assert.equal(computeConfidence([cluster('x', ['https://a.com']) ]), 'low')
  assert.equal(computeConfidence([
    cluster('a', ['https://a.com', 'https://b.com']),
    cluster('b', ['https://a.com', 'https://b.com']),
    cluster('c', ['https://a.com', 'https://b.com']),
  ]), 'medium') // three blogs agreeing is not "high": no primary-grade source
  assert.equal(computeConfidence([
    cluster('a', ['https://eur-lex.europa.eu/x', 'https://arxiv.org/abs/1']),
    cluster('b', ['https://eur-lex.europa.eu/x', 'https://arxiv.org/abs/1']),
    cluster('c', ['https://eur-lex.europa.eu/x', 'https://arxiv.org/abs/1']),
  ]), 'high')
  assert.equal(computeConfidence([
    cluster('a', ['https://a.com', 'https://b.com']),
    { ...cluster('b', ['https://a.com', 'https://b.com']), status: 'disputed' },
  ]), 'medium')
})

test('fallbackBrief is deterministic and marks partial runs', () => {
  const clusters = [cluster('Node 22 is LTS', ['https://a.com', 'https://b.com'])]
  const brief = fallbackBrief({ question: 'which node', clusters, gaps: ['缺基准'], partial: true, reason: '超时' })
  assert.match(brief, /## 结论/)
  assert.match(brief, /Node 22 is LTS/)
  assert.match(brief, /预算或时间耗尽/)
  assert.match(brief, /缺基准/)
})

test('buildResult appends references and keeps schema shape', () => {
  const clusters = [cluster('x', ['https://a.com']) ]
  const sources = assignSourceIds(clusters)
  const result = buildResult({
    brief: '## 结论\nx [S1]', sources, confidence: 'low', gaps: [], partial: false, depth: 'quick',
    stats: { queries: 1, pagesFetched: 1, llmRounds: 1, elapsedMs: 5 },
  })
  assert.match(result.brief, /## 参考/)
  assert.equal(result.sources.length, 1)
  assert.equal(result.depthUsed, 'quick')
})

test('buildResult appends one run-stats line after 参考 and stays idempotent', () => {
  const clusters = [cluster('x', ['https://a.com'])]
  const sources = assignSourceIds(clusters)
  const stats = { queries: 6, pagesFetched: 9, clusters: 14, elapsedMs: 73000 }
  const first = buildResult({
    brief: '## 结论\nx [S1]', sources, confidence: 'low', gaps: [], partial: false,
    depth: 'standard', stats,
  })
  assert.match(first.brief, /## 参考[\s\S]*> 本次检索：6 个查询 · 9 个页面 · 14 条证据 · 73 秒（标准档）$/)
  assert.equal(first.brief.match(/本次检索：/g).length, 1)
  // Rendering the same result again must not add a second line.
  const again = buildResult({
    brief: first.brief, sources: [], confidence: 'low', gaps: [], partial: false,
    depth: 'standard', stats,
  })
  assert.equal(again.brief.match(/本次检索：/g).length, 1)
})

test('buildResult does not throw without stats and appends nothing', () => {
  const result = buildResult({
    brief: '## 结论\nx', sources: [], confidence: 'low', gaps: [], partial: true, depth: 'quick',
  })
  assert.doesNotMatch(result.brief, /本次检索/)
})

test('appendStats maps depth labels and skips empty runs', () => {
  assert.match(
    appendStats('x', { queries: 1, pagesFetched: 2, clusters: 3, elapsedMs: 1500 }, 'quick'),
    /1 个查询 · 2 个页面 · 3 条证据 · 2 秒（快速档）$/,
  )
  assert.equal(appendStats('x', undefined), 'x')
  assert.equal(appendStats('x', { queries: 0, pagesFetched: 0, clusters: 0, elapsedMs: 0 }), 'x')
})

test('autoDepth picks deep for comparison, quick for simple facts', () => {
  assert.equal(autoDepth('pnpm vs yarn vs bun，2026 年该选哪个？'), 'deep')
  assert.equal(autoDepth('TypeScript 是什么？'), 'quick')
  assert.equal(autoDepth('如何配置 DSH 插件的工具注册方式，需要哪些字段和注意事项'), 'standard')
  assert.equal(resolveDepth({ depth: 'auto', question: '对比 A 和 B', focus: [], config: { maxDeepPerSession: 3 } }), 'deep')
  assert.equal(resolveDepth({ depth: 'deep', question: 'x', focus: [], config: { maxDeepPerSession: 3 }, deepUsed: 3 }), 'standard')
})

test('buildQueries leads with subquestion variants and keeps a compact fallback', () => {
  const queries = buildQueries([{ q: 'Node LTS 版本' }], ['性能'], 'which node is the best choice for a new project', 4)
  assert.equal(queries[0], 'Node LTS 版本')
  assert.ok(queries.some((query) => /性能/.test(query)))
  assert.ok(queries.at(-1).startsWith('which node'))
  assert.ok(queries.every((query) => query.length <= 100))
})

test('groupEvidence marks confirmed/disputed/unverified', () => {
  const clusters = groupEvidence([
    { claim: 'A is fast', url: 'https://a.com', domain: 'a.com', stance: 'support' },
    { claim: 'A is fast', url: 'https://b.com', domain: 'b.com', stance: 'support' },
    { claim: 'B is slow', url: 'https://c.com', domain: 'c.com', stance: 'support' },
  ])
  assert.equal(clusters[0].status, 'confirmed')
  assert.equal(clusters[1].status, 'unverified')
})

test('assignSourceIds collapses translated and mirrored copies of one page', () => {
  const clusters = [{
    status: 'confirmed',
    claim: 'Node 22 EOL',
    evidence: [
      { claim: 'Node 22 EOL', quote: 'q', url: 'https://nodejs.org/fr/about/previous-releases', title: 'fr page', domain: 'nodejs.org', stance: 'support' },
      { claim: 'Node 22 EOL', quote: 'q', url: 'https://nodejs.org/ja/about/previous-releases', title: 'ja page', domain: 'nodejs.org', stance: 'support' },
      { claim: 'Node 22 EOL', quote: 'q', url: 'https://cdn.jsdelivr.net/gh/nodejs/Release@main/README.md', title: 'mirror', domain: 'cdn.jsdelivr.net', stance: 'support' },
    ],
  }]
  const sources = assignSourceIds(clusters)
  assert.equal(sources.length, 2)
  assert.equal(sources[0].url, 'https://nodejs.org/fr/about/previous-releases')
})

test('assignSourceIds merges republished copies with an identical title', () => {
  const clusters = [{
    status: 'unverified',
    claim: 'CRA report duty applies from 2026-09-11',
    evidence: [
      { claim: 'x', quote: 'q', url: 'https://ctils.com/articles/28146', title: '欧盟《网络韧性法案》（CRA）对中国制造商开源软件合规的影响', domain: 'ctils.com', stance: 'neutral' },
      { claim: 'x', quote: 'q', url: 'https://eccpit.com/news/32384', title: '欧盟《网络韧性法案》（CRA）对中国制造商开源软件合规的影响', domain: 'eccpit.com', stance: 'neutral' },
    ],
  }]
  const sources = assignSourceIds(clusters)
  assert.equal(sources.length, 1)
})

test('assignSourceIds merges syndicated copies whose title gained a host suffix', () => {
  const clusters = [{
    status: 'unverified',
    claim: 'CRA',
    evidence: [
      { claim: 'x', quote: 'q', url: 'https://ctils.com/articles/28146', title: '欧盟《网络韧性法案》（CRA）对中国制造商开源软件合规的影响', domain: 'ctils.com', stance: 'neutral' },
      { claim: 'x', quote: 'q', url: 'https://eccpit.com/news/32384', title: '欧盟《网络韧性法案》（CRA）对中国制造商开源软件合规的影响 - 贸企通', domain: 'eccpit.com', stance: 'neutral' },
    ],
  }]
  assert.equal(assignSourceIds(clusters).length, 1)
})

test('validateCitations refuses to leave a bare id for a source that does not exist', () => {
  const sources = [{ id: 'S1', url: 'https://europa.eu/x', title: 'CRA' }]
  const { brief } = validateCitations('结论 [S1]。但 S1 与 S4 说法不一致，S4 称需上报。', sources)
  assert.match(brief, /\[S1\]/)
  assert.doesNotMatch(brief, /\bS4\b/)
  assert.match(brief, /〔来源未列出〕/)
})

test('ensureSections replaces an empty 未解决 under a low confidence verdict', () => {
  const brief = ensureSections('## 结论\nx\n\n## 置信度\nlow\n\n## 未解决\n- 无', 'low', [])
  assert.match(brief, /## 未解决\n- 无\n- 证据不足/)
})

test('ensureSections fills confidence and gaps when the model omits them', () => {
  const brief = ensureSections('## 结论\nx', 'medium', ['Node 24 的 EOL 未核实', '依赖兼容性未知'])
  assert.match(brief, /## 置信度\nmedium/)
  assert.match(brief, /## 未解决\n- Node 24 的 EOL 未核实/)
  const kept = ensureSections('## 结论\nx\n\n## 置信度\nhigh', 'low', [])
  assert.match(kept, /## 置信度\nhigh/)
  assert.match(kept, /## 未解决\n- 无/)
})

test('references flag pages older than two years with 旧', () => {
  const brief = appendReferences('## 结论\nx', [
    { id: 'S1', title: 'old note', url: 'https://a.com/old', domain: 'a.com', publishedAt: '2019-05-01' },
    { id: 'S2', title: 'fresh note', url: 'https://b.com/new', domain: 'b.com', publishedAt: '2026-01-01' },
    { id: 'S3', title: 'undated note', url: 'https://c.com/x', domain: 'c.com' },
  ])
  assert.match(brief, /\[S1\][^\n]*（网页 · a\.com · 2019-05-01） · 旧$/m)
  assert.doesNotMatch(brief, /\[S2\][^\n]* · 旧$/m)
  assert.doesNotMatch(brief, /\[S3\][^\n]* · 旧$/m)
})

function disputedCluster(claim, urls) {
  const evidence = urls.map((url, index) => ({
    claim, quote: `quote ${index}`, url, title: `title ${index}`,
    domain: new URL(url).hostname, stance: index === 0 ? 'support' : 'refute',
  }))
  return { status: 'disputed', claim, evidence }
}

test('a disputed cluster becomes a 存在冲突 section above 置信度', () => {
  const clusters = [disputedCluster('Node 22 的维护期到 2027 年', ['https://nodejs.org/x', 'https://blog.example.com/y'])]
  assignSourceIds(clusters)
  const brief = ensureSections('## 结论\n两种说法并存 [S1][S2]\n\n## 置信度\nmedium\n\n## 未解决\n- 官方日期未核实', 'medium', [], clusters)
  assert.match(brief, /^## 存在冲突$/m)
  assert.ok(brief.indexOf('## 存在冲突') < brief.indexOf('## 置信度'))
  assert.match(brief, /（支持）— \[S1\] nodejs\.org/)
  assert.match(brief, /（反驳）— \[S2\] blog\.example\.com/)
  // Already present: never duplicated (the pipeline inserts it before citation checking).
  const twice = ensureSections(brief, 'medium', [], clusters)
  assert.equal(twice.match(/## 存在冲突/g).length, 1)
})

test('buildResult exposes the conflict lines next to the brief', () => {
  const clusters = [disputedCluster('Node 22 的维护期到 2027 年', ['https://nodejs.org/x', 'https://blog.example.com/y'])]
  const sources = assignSourceIds(clusters)
  const result = buildResult({
    brief: '## 结论\nx [S1][S2]', sources, confidence: 'medium', gaps: [], partial: false, depth: 'quick',
    conflicts: clusters,
  })
  assert.equal(result.conflicts.length, 2)
  assert.match(result.conflicts[0], /\[S1\] nodejs\.org/)
  assert.match(result.brief, /## 存在冲突/m)
})

test('ensureSections adds a fallback 下一步建议 when the model omitted it', () => {
  const brief = ensureSections('## 结论\nx\n\n## 置信度\nmedium', 'medium', [])
  assert.match(brief, /^## 下一步建议\n- 按「未解决」逐条补一轮定向检索，或把关键页面 URL 直接贴进问题重查$/m)
  const kept = ensureSections('## 下一步建议\n- 跑 npm view node version', 'medium', [])
  assert.equal(kept.match(/## 下一步建议/g).length, 1)
  assert.match(kept, /跑 npm view node version/)
})