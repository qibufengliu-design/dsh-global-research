import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ACTION_CHECKLIST_HEADING, appendConflictSection, appendReferences, appendRetrievalFlow, appendStats, applyZeroEvidenceOptions, assignSourceIds, buildResult,
  checkCompareRows, computeConfidence, COST_MISSING_CELL, COST_OVERVIEW_HEADER, COST_OVERVIEW_NOTE, DECISION_CRITERIA_HEADING, ensureSections, fallbackBrief, fillEmptyCompareCells, formatRetrievalFlow, gradeSource, groundCriteria, isPriceColumnHeader, markUnsourcedNumbers, missingSections, PRICE_SEE_NOTE, requiredSectionsFor,
  sanitizeCompareTable, UNSOURCED_NUMBER_MARK, validateCitations, validateCriteria, zeroEvidenceGapText,
} from '../lib/brief.js'
import { findSelfContradictions } from '../lib/assertions.js'
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

test('via jina/render downgrades official and paper grades one notch', () => {
  const official = 'https://eur-lex.europa.eu/eli/reg/2024/2847/oj'
  assert.equal(gradeSource(official), '官方')
  assert.equal(gradeSource(official, 'jina'), '论文')
  assert.equal(gradeSource(official, 'render'), '论文')
  // Only proxy-rendered text is discounted; the normal raw path keeps the grade.
  assert.equal(gradeSource(official, 'raw'), '官方')
  assert.equal(gradeSource('https://arxiv.org/abs/2401.00001', 'jina'), '仓库')
  // A downgrade must never lift a weak source.
  assert.equal(gradeSource('https://example.com/blog/post', 'jina'), '网页')
  const brief = appendReferences('## 结论\nok', [
    { id: 'S1', title: 'CRA', url: official, domain: 'eur-lex.europa.eu', via: 'jina' },
  ])
  assert.ok(brief.includes('（论文 · eur-lex.europa.eu）'))
  // The retrieval path travels with the source table so grading is auditable.
  const sources = assignSourceIds([{ evidence: [{ url: 'https://nodejs.org/en', title: 'Node 22', via: 'sitemap' }] }])
  assert.equal(sources[0].via, 'sitemap')
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

// 0.9.1 — defect A: the breadth set keyed on hosts, so eight official pages on
// docs.spring.io (7) + docs.langchain4j.dev (1) were one unit and a well-sourced
// answer came back `low`. A documentation section is now the breadth unit; the
// cross-source `confirmed` count keeps the coarser host key so one vendor's docs
// never read as independent confirmation of each other.
test('confidence breadth counts documentation sections, not just hosts (0.9.1)', () => {
  const springAi = 'https://docs.spring.io/spring-ai/reference/api/chatclient.html'
  const springBoot = 'https://docs.spring.io/spring-boot/reference/features/ai.html'
  const langchain4j = 'https://docs.langchain4j.dev/tutorials/spring-boot-integration'
  // Two doc sections of the same vendor: breadth 2 lifts `unverified` to medium.
  assert.equal(computeConfidence([cluster('Spring AI 的 ChatClient 用法', [springAi]), cluster('Spring Boot 的 AI 自动配置', [springBoot])]), 'medium')
  // A doc page on another docs host is a third section: still medium, never high
  // (no primary-grade source, no cross-source confirmation).
  assert.equal(computeConfidence([cluster('a', [springAi]), cluster('b', [springBoot]), cluster('c', [langchain4j])]), 'medium')
  // Pages of the same section are counted once: no lift.
  assert.equal(computeConfidence([
    cluster('a', [springAi]),
    cluster('b', ['https://docs.spring.io/spring-ai/reference/api/vectordbs.html']),
  ]), 'low')
  // Ordinary hosts keep the old behaviour: two pages of a.com are one unit.
  assert.equal(computeConfidence([cluster('a', ['https://a.com/1']), cluster('b', ['https://a.com/2'])]), 'low')
})

// 1.1.2 — 「官方占比高 + 采用条数足够」 must reach medium/high. The matrix alone
// could not: every cluster of a real run is `unverified` (one vendor's docs are
// one source), and the adopted count never reached the function at all, so an
// 8/8-official run still read `low`. The base verdict now comes from the adopted
// mix — the same rule scripts/eval.mjs scores — and the gates below still cap it.
test('confidence follows the adopted first-party mix (1.1.2)', () => {
  const firstParty = (n) => Array.from({ length: n }, (_, i) => `https://docs.spring.io/spring-ai/reference/api/page-${i}.html`)
  const secondHand = (n) => Array.from({ length: n }, (_, i) => `https://blog-${i}.example.com/node-lts`)
  const at = (mix, adopted, official) => computeConfidence(
    [cluster('Node 22 是当前 LTS 版本', mix)],
    { evidence: { adopted, official } },
  )

  // 全官方 8 条 → high.
  assert.equal(at(firstParty(8), 8, 8), 'high')
  // 官方 6 + 二手 2: 75% first-party, still high.
  assert.equal(at([...firstParty(6), ...secondHand(2)], 8, 6), 'high')
  // 官方 3 + 二手 4: 42.9% clears the medium floor but not the high bar (50%).
  assert.equal(at([...firstParty(3), ...secondHand(4)], 7, 3), 'medium')
  // 官方 3 + 二手 5: 37.5% sits below the 40% floor the eval scores → low.
  assert.equal(at([...firstParty(3), ...secondHand(5)], 8, 3), 'low')
  // 全二手 8 条: no first-party page at all.
  assert.equal(at(secondHand(8), 8, 0), 'low')
  // One adopted page is never stronger than low, however official it is.
  assert.equal(at(firstParty(1), 1, 1), 'low')
})

test('conflicts, zero-evidence rows and soft gates still cap a strong mix (1.1.2)', () => {
  const firstParty = (n) => Array.from({ length: n }, (_, i) => `https://docs.spring.io/spring-ai/reference/api/page-${i}.html`)
  const strong = { evidence: { adopted: 8, official: 8 } }
  const mixed = [cluster('Node 22 是当前 LTS 版本', firstParty(8))]

  // 有零证据选项: an unresolved comparison row is a medium at best.
  assert.equal(computeConfidence(mixed, { ...strong, zeroEvidence: 1 }), 'medium')
  // 有未解决冲突 + 另一条已确认结论: capped at medium, never high.
  const disputed = [
    { ...cluster('Node 22 是当前 LTS 版本', firstParty(8)), status: 'disputed' },
    cluster('另一条结论', ['https://a.com/x', 'https://b.com/y']),
  ]
  assert.equal(computeConfidence(disputed, strong), 'medium')
  // 有未解决冲突且没有一条已确认结论: low.
  assert.equal(computeConfidence([disputed[0]], strong), 'low')
  // 缺口多 (a required section is missing): one notch below the mix.
  assert.equal(computeConfidence(mixed, { ...strong, missingSections: true }), 'medium')
  // 缺一手来源: the pack's own cap.
  assert.equal(computeConfidence(mixed, { ...strong, missingPrimary: true }), 'low')
  // A pack's hard ceiling still wins over a perfect mix.
  assert.equal(computeConfidence(mixed, { ...strong, gate: 'medium' }), 'medium')
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

test('references name the pages that were read but never cited', () => {
  const brief = appendReferences('## 结论\nx', [
    { id: 'S1', title: 'used', url: 'https://a.com/used', domain: 'a.com' },
  ], [
    { url: 'https://a.com/used', domain: 'a.com' },
    { url: 'https://b.com/one', domain: 'b.com' },
    { url: 'https://c.com/two', domain: 'c.com' },
    { url: 'https://b.com/one#frag', domain: 'b.com' },
  ])
  assert.match(brief, /- 另有 2 个页面被读取但未采用（b\.com、c\.com）$/)
})

test('buildResult reports unused pages only when some page was left out', () => {
  const clusters = [cluster('x', ['https://a.com/used'])]
  const sources = assignSourceIds(clusters)
  const allCited = buildResult({
    brief: '## 结论\nx [S1]', sources, confidence: 'low', gaps: [], partial: false, depth: 'quick',
    pages: [{ url: 'https://a.com/used', domain: 'a.com' }],
  })
  assert.doesNotMatch(allCited.brief, /未采用/)
  const withUnused = buildResult({
    brief: '## 结论\nx [S1]', sources, confidence: 'low', gaps: [], partial: false, depth: 'quick',
    pages: [
      { url: 'https://a.com/used', domain: 'a.com' },
      { url: 'https://d.com/skipped', domain: 'd.com' },
    ],
  })
  assert.match(withUnused.brief, /- 另有 1 个页面被读取但未采用（d\.com）$/)
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

test('appendStats appends a stage summary in canonical order and skips sub-second noise', () => {
  const brief = appendStats('x', {
    queries: 2, pagesFetched: 3, clusters: 4, elapsedMs: 70000,
    timings: { analyze: 900, search: 12000, read: 30000, evidence: 0, gap: 200, synth: 25000 },
  }, 'quick')
  // 证据/补缺 are 0ms and 200ms: below the 0.5s floor, so neither earns a chip.
  assert.match(brief, / · 阶段 拆题1s\/检索12s\/精读30s\/合成25s$/)
  assert.doesNotMatch(brief, /证据\d+s|补缺/)
})

test('stage summary keeps at most the four slowest stages, then restores stage order', () => {
  const brief = appendStats('x', {
    queries: 2, pagesFetched: 3, clusters: 4, elapsedMs: 90000,
    timings: { analyze: 1000, search: 2000, read: 3000, evidence: 4000, gap: 5000, synth: 6000 },
  }, 'standard')
  // The four slowest are synth/gap/evidence/read, printed back as read→synth.
  assert.match(brief, / · 阶段 精读3s\/证据4s\/补缺5s\/合成6s$/)
  assert.doesNotMatch(brief, /拆题\d+s|检索\d+s/)
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

test('numeric conflicts are listed before stance conflicts in 存在冲突', () => {
  const clusters = [disputedCluster('Node 22 的维护期到 2027 年', ['https://nodejs.org/x', 'https://blog.example.com/y'])]
  const sources = assignSourceIds(clusters)
  const numeric = [{
    attribute: '输出上限',
    unitMismatch: false,
    values: [
      { value: '384K', unit: 'tokens', source: 'S1' },
      { value: '256K', unit: 'tokens', source: 'S2' },
    ],
  }]
  const brief = ensureSections('## 结论\nx [S1][S2]\n\n## 置信度\nmedium', 'medium', [], clusters, null, numeric)
  assert.match(brief, /^## 存在冲突$/m)
  assert.ok(brief.indexOf('- 输出上限：') < brief.indexOf('（支持）— [S1] nodejs.org'))
  assert.match(brief, /输出上限：384K tokens（\[S1\]） · 256K tokens（\[S2\]）/m)
  // result.conflicts mirrors the rendered section, so the order is the same.
  const result = buildResult({
    brief: '## 结论\nx [S1][S2]', sources, confidence: 'medium', gaps: [], partial: false, depth: 'quick',
    conflicts: clusters, assertionConflicts: numeric,
  })
  assert.ok(result.conflicts[0].startsWith('- 输出上限：'), result.conflicts[0])
  assert.equal(result.conflicts.length, 3)
})

test('ensureSections adds a fallback 下一步建议 when the model omitted it', () => {
  const brief = ensureSections('## 结论\nx\n\n## 置信度\nmedium', 'medium', [])
  assert.match(brief, /^## 下一步建议\n- 按「未解决」逐条补一轮定向检索，或把关键页面 URL 直接贴进问题重查$/m)
  const kept = ensureSections('## 下一步建议\n- 跑 npm view node version', 'medium', [])
  assert.equal(kept.match(/## 下一步建议/g).length, 1)
  assert.match(kept, /跑 npm view node version/)
})

function divergence(attribute, left, right) {
  return {
    attribute,
    values: [
      { value: left.value, unit: left.unit, source: left.source },
      { value: right.value, unit: right.unit, source: right.source },
    ],
  }
}

test('numbers that describe different objects become a 口径差异 note, not a conflict', () => {
  const divergences = [divergence('输出上限', { value: '65536', unit: 'tokens', source: 'S1' }, { value: '131072', unit: 'tokens', source: 'S2' })]
  const brief = ensureSections(
    '## 结论\nx [S1][S2]\n\n## 置信度\nmedium\n\n## 未解决\n- 无',
    'medium', [], [], null, [], divergences,
  )
  // Two true statements about two different models are not a contradiction.
  assert.doesNotMatch(brief, /## 存在冲突/)
  assert.match(
    brief,
    /^- 口径差异：输出上限在不同对象上分别为 65536 tokens（\[S1\]） \/ 131072 tokens（\[S2\]），不可直接比较$/m,
  )
  assert.ok(brief.indexOf('## 未解决') < brief.indexOf('- 口径差异'))
})

test('the 口径差异 note is capped at two lines and never duplicated', () => {
  const divergences = [
    divergence('输出上限', { value: '65536', unit: 'tokens', source: 'S1' }, { value: '131072', unit: 'tokens', source: 'S2' }),
    divergence('上下文窗口', { value: '128K', unit: 'tokens', source: 'S3' }, { value: '200K', unit: 'tokens', source: 'S4' }),
    divergence('输入价格', { value: '0.2', unit: '元/百万 tokens', source: 'S1' }, { value: '0.5', unit: '元/百万 tokens', source: 'S5' }),
  ]
  const brief = appendConflictSection('## 结论\nx\n\n## 置信度\nmedium\n\n## 未解决\n- 无', [], [], divergences)
  assert.equal(brief.match(/口径差异/g).length, 2)
  const twice = ensureSections(brief, 'medium', [], [], null, [], divergences)
  assert.equal(twice.match(/口径差异/g).length, 2)
})

test('the 口径差异 note is inserted before citation renumbering so its ids stay true', () => {
  const sources = [
    { id: 'S1', title: 'qwen', url: 'https://help.aliyun.com/qwen' },
    { id: 'S2', title: 'bedrock', url: 'https://docs.aws.amazon.com/bedrock/claude' },
    { id: 'S3', title: 'anthropic', url: 'https://docs.anthropic.com/claude-3-7' },
  ]
  const divergences = [divergence('输出上限', { value: '65536', unit: 'tokens', source: 'S1' }, { value: '131072', unit: 'tokens', source: 'S2' })]
  // The model cites [S3] first, so renumbering turns S3 into S1 — and the note
  // must follow, or it would point at the wrong source.
  const withNote = appendConflictSection('## 结论\nx [S3]\n\n## 置信度\nmedium\n\n## 未解决\n- 无', [], [], divergences)
  const { brief, sources: finalSources } = validateCitations(withNote, sources)
  assert.equal(finalSources.length, 3)
  assert.match(brief, /口径差异：输出上限在不同对象上分别为 65536 tokens（\[S2\]） \/ 131072 tokens（\[S3\]）/m)
  assert.equal((brief.match(/\[S1\]/g) ?? []).length, 1)
})

test('the retrieval funnel line reports real counts and sits before 参考', () => {
  const clusters = [cluster('Node 22 is LTS', ['https://nodejs.org/en/about/releases', 'https://github.com/nodejs/release'])]
  const sources = assignSourceIds(clusters)
  const stats = {
    identified: 20, deduped: 12, readable: 9, adopted: sources.length,
    queries: 6, pagesFetched: 9, clusters: 14, elapsedMs: 73000,
  }
  const result = buildResult({
    brief: '## 结论\nok [S1]', sources, confidence: 'medium', gaps: [], partial: false, depth: 'standard', stats,
  })
  assert.match(result.brief, /^> 检索流程：识别 20 篇 · 去重后 12 篇 · 可读 9 篇 · 采用 2 篇$/m)
  // It introduces 参考, so it must appear before it and only once.
  assert.ok(result.brief.indexOf('> 检索流程：') < result.brief.indexOf('## 参考'))
  assert.equal((result.brief.match(/检索流程：/g) ?? []).length, 1)
  const rendered = buildResult({
    brief: result.brief, sources: [], confidence: 'medium', gaps: [], partial: false, depth: 'standard', stats,
  })
  assert.equal((rendered.brief.match(/检索流程：/g) ?? []).length, 1)
  // Stats objects from older runs carry no funnel counters: say nothing rather than guess.
  const legacy = buildResult({
    brief: '## 结论\nok', sources: [], confidence: 'medium', gaps: [], partial: false, depth: 'standard',
    stats: { queries: 6, pagesFetched: 9, clusters: 14, elapsedMs: 73000 },
  })
  assert.doesNotMatch(legacy.brief, /检索流程：/)
})

test('the funnel line is printed in the quick profile and marks reuse on a resumed run', () => {
  const stats = { identified: 4, deduped: 4, readable: 3, adopted: 1, queries: 2, pagesFetched: 3, clusters: 2, elapsedMs: 12000 }
  const quick = buildResult({
    brief: '## 结论\nok', sources: [], confidence: 'low', gaps: [], partial: false, depth: 'quick', stats,
  })
  assert.match(quick.brief, /^> 检索流程：识别 4 篇 · 去重后 4 篇 · 可读 3 篇 · 采用 1 篇$/m)
  // A resumed run reports this round's N/M but keeps the totals for readable/adopted.
  const resumed = appendRetrievalFlow('## 结论\nok', { ...stats, readable: 12, adopted: 5, reusedPages: 9, resumed: true })
  assert.match(resumed, /^> 检索流程：识别 4 篇 · 去重后 4 篇 · 可读 12 篇 · 采用 5 篇（续跑：复用 9 页）$/m)
})

/**
 * 1.1.1 — the body of 「## 存在冲突」 ('' when the section is absent), so a test can
 * talk about the conflict section without the 「未解决」 placeholder matching too.
 */
function conflictSectionOf(text) {
  const match = /^## 存在冲突\n([\s\S]*?)(?=\n## |(?![^]))/m.exec(String(text ?? ''))
  return match ? match[1] : ''
}

test('冲突 keeps its heading and gains 事实冲突/口径差异/来源自相矛盾 subsections', () => {
  const clusters = [disputedCluster('Node 22 输出上限', ['https://nodejs.org/en/about/releases', 'https://github.com/nodejs/release'])]
  assignSourceIds(clusters)
  const numeric = [{
    attribute: '输出上限',
    unitMismatch: false,
    values: [
      { value: '384K', unit: 'tokens', source: 'S1' },
      { value: '256K', unit: 'tokens', source: 'S2' },
    ],
  }]
  const brief = ensureSections(
    '## 结论\nx [S1][S2]\n\n## 置信度\nmedium\n\n## 未解决\n- 无',
    'medium', [], clusters, null, numeric,
  )
  assert.match(brief, /^## 存在冲突$/m)
  assert.match(brief, /^### 事实冲突\n- 输出上限：384K tokens（\[S1\]） · 256K tokens（\[S2\]）\n- Node 22 输出上限（支持）— \[S1\] nodejs\.org\n- Node 22 输出上限（反驳）— \[S2\] github\.com$/m)
  // 1.1.1 — an empty kind is omitted, not written as 「- 无」: the placeholder
  // said "no difference" under a heading whose only content was the negation.
  assert.doesNotMatch(brief, /^### 口径差异/m)
  assert.doesNotMatch(brief, /^### 来源自相矛盾/m)
  assert.doesNotMatch(conflictSectionOf(brief), /^-\s*无$/m)
  assert.ok(brief.indexOf('## 存在冲突') < brief.indexOf('### 事实冲突'))
})

test('口径差异 holds entity and unit differences with a reason instead of calling them facts', () => {
  const clusters = [disputedCluster('Node 22 输出上限', ['https://nodejs.org/en/about/releases', 'https://github.com/nodejs/release'])]
  assignSourceIds(clusters)
  const divergences = [divergence('输出上限', { value: '65536', unit: 'tokens', source: 'S1' }, { value: '131072', unit: 'tokens', source: 'S2' })]
  const mismatched = [{
    attribute: '输出价格',
    unitMismatch: true,
    values: [
      { value: '0.2', unit: '元', source: 'S3' },
      { value: '0.03', unit: '美元', source: 'S4' },
    ],
  }]
  const brief = ensureSections(
    '## 结论\nx [S1]\n\n## 置信度\nmedium\n\n## 未解决\n- 无',
    'medium', [], clusters, null, mismatched, divergences,
  )
  assert.match(brief, /^### 口径差异\n- 输出上限：65536 tokens（\[S1\]） \/ 131072 tokens（\[S2\]）（对象不同，不可直接比较）\n- 输出价格：0\.2 元（\[S3\]） \/ 0\.03 美元（\[S4\]）（单位不同：元 \/ 美元，不可直接比较）$/m)
  // An incomparable unit is a scope problem, not a factual contradiction.
  const factBlock = conflictSectionOf(brief).split('### 口径差异')[0]
  assert.doesNotMatch(factBlock, /输出价格/)
  // 1.1.1 — no kind is written as 「- 无」 when another kind has a finding.
  assert.doesNotMatch(conflictSectionOf(brief), /^-\s*无$/m)
  // The scope lines replace the legacy 未解决 note instead of duplicating it.
  assert.doesNotMatch(brief, /^- 口径差异：/m)
})

test('an unconvertible unit pair reaches 口径差异 even when nothing else is disputed (0.6.3)', () => {
  const mismatched = [{
    attribute: '输入价格',
    unitMismatch: true,
    values: [
      { value: '0.15', unit: '美元/百万 tokens', source: 'S1' },
      { value: '0.3', unit: '元/百万 tokens', source: 'S2' },
    ],
  }]
  const brief = appendConflictSection(
    '## 结论\nx [S1]\n\n## 置信度\nmedium\n\n## 未解决\n- 无',
    [], mismatched, [], [],
  )
  assert.match(brief, /^## 存在冲突$/m)
  assert.match(brief, /^### 口径差异\n- 输入价格：0\.15 美元\/百万 tokens（\[S1\]） \/ 0\.3 元\/百万 tokens（\[S2\]）（单位不同：美元\/百万 tokens \/ 元\/百万 tokens，不可直接比较）$/m)
  assert.doesNotMatch(brief, /^### 事实冲突/m)
  assert.doesNotMatch(conflictSectionOf(brief), /^-\s*无$/m)
  assert.doesNotMatch(brief, /^- 口径差异：/m)
})

test('a page that states two different values for one property is a 来源自相矛盾', () => {
  const quote = '输出上限：384K tokens。输出上限：256K tokens。'
  const items = [{
    id: 'S1',
    url: 'https://nodejs.org/en/about/previous-releases',
    title: 'Node releases',
    publishedAt: '2026-01-01',
    claim: quote,
    quote,
  }]
  const contradictions = findSelfContradictions(items)
  assert.equal(contradictions.length, 1)
  assert.equal(contradictions[0].attribute, '输出上限')
  assert.deepEqual(contradictions[0].values.map((entry) => `${entry.value} ${entry.unit}`), ['384K tokens', '256K tokens'])
  const brief = appendConflictSection(
    '## 结论\nx [S1]\n\n## 置信度\nmedium\n\n## 未解决\n- 无', [], [], [], contradictions,
  )
  assert.match(brief, /^## 存在冲突$/m)
  // 1.1.1 — the reported defect: the section wrote 「- 无」 and then listed the two
  // self-contradicting values right under it. An empty kind must not be spoken at
  // all when another kind has a finding.
  assert.doesNotMatch(brief, /^### 事实冲突/m)
  assert.doesNotMatch(conflictSectionOf(brief), /^-\s*无$/m)
  assert.match(brief, /^### 来源自相矛盾\n- 输出上限：384K tokens \/ 256K tokens（\[S1\] 同一页面内说法不一致）$/m)
  // Three values on one page are a table, not a self-contradiction.
  assert.equal(findSelfContradictions([{ ...items[0], quote: '输出上限：384K tokens。输出上限：256K tokens。输出上限：128K tokens。' }]).length, 0)
})

test('when all three conflict kinds are empty the brief grows no conflict section', () => {
  const plain = buildResult({
    brief: '## 结论\nok', sources: [], confidence: 'low', gaps: [], partial: false, depth: 'standard',
    stats: { identified: 1, deduped: 1, readable: 1, adopted: 0 },
  })
  assert.doesNotMatch(plain.brief, /## 存在冲突/)
  assert.doesNotMatch(plain.brief, /^### /m)
  assert.doesNotMatch(appendConflictSection('## 结论\nx\n\n## 置信度\nmedium', [], [], [], []), /存在冲突/)
})

test('the funnel line reports official adoption only when first-party pages were read', () => {
  const stats = {
    identified: 20, deduped: 12, readable: 9, adopted: 3,
    officialReadable: 3, officialAdopted: 1,
    queries: 6, pagesFetched: 9, clusters: 14, elapsedMs: 73000,
  }
  const result = buildResult({
    brief: '## 结论\nok', sources: [], confidence: 'medium', gaps: [], partial: false, depth: 'standard', stats,
  })
  // "you read 3 official pages but cited 1" stays visible on the funnel line.
  assert.match(result.brief, /^> 检索流程：识别 20 篇 · 去重后 12 篇 · 可读 9 篇 · 采用 3 篇 · 官方采用 1\/3$/m)
  // No official page read → the suffix would be noise, so it is omitted.
  const none = buildResult({
    brief: '## 结论\nok', sources: [], confidence: 'medium', gaps: [], partial: false, depth: 'standard',
    stats: { ...stats, officialReadable: 0, officialAdopted: 0 },
  })
  assert.match(none.brief, /^> 检索流程：识别 20 篇 · 去重后 12 篇 · 可读 9 篇 · 采用 3 篇$/m)
  assert.doesNotMatch(none.brief, /官方采用/)
})

test('stale sources cannot lift the confidence verdict (0.6.6)', () => {
  const clusters = [
    cluster('Spring AI 由官方维护', ['https://ec.europa.eu/a', 'https://eur-lex.europa.eu/b']),
    cluster('Spring AI 1.0 已发布', ['https://ec.europa.eu/c', 'https://eur-lex.europa.eu/d']),
    cluster('Spring AI 支持 RAG', ['https://ec.europa.eu/e', 'https://eur-lex.europa.eu/f']),
  ]
  assert.equal(computeConfidence(clusters), 'high')
  // The pipeline's cluster status still says "confirmed"; the stale cards must be
  // discounted before counting confirmed clusters or primary domains.
  const retired = clusters.map((item) => ({
    ...item,
    evidence: item.evidence.map((evidence) => ({ ...evidence, stale: true })),
  }))
  assert.equal(computeConfidence(retired), 'low')
  // One live card per claim is not two independent sources either.
  const mixed = retired.map((item) => ({
    ...item,
    evidence: [item.evidence[0], { ...item.evidence[1], stale: false }],
  }))
  assert.equal(computeConfidence(mixed), 'low')
})

test('reference lines mark retired sources as 已过期 (0.6.6)', () => {
  const sources = assignSourceIds([
    cluster('Node 22 是 LTS', ['https://nodejs.org/en/about/previous-releases', 'https://github.com/old/repo']),
  ])
  const text = appendReferences('## 结论\nNode 22 是 LTS。', sources, [
    { url: 'https://nodejs.org/en/about/previous-releases' },
    { url: 'https://github.com/old/repo', stale: true },
  ])
  const retired = text.split('\n').find((line) => line.includes('github.com/old/repo'))
  const fresh = text.split('\n').find((line) => line.includes('nodejs.org'))
  assert.match(retired, /（已过期，仅作参考）$/)
  assert.doesNotMatch(fresh, /已过期/)
})

test('the funnel line reports the planner query mix (0.7.1)', () => {
  const line = formatRetrievalFlow({
    identified: 10, deduped: 8, readable: 5, adopted: 3,
    queriesByKind: { semantic: 2, technical: 3, official: 1 },
  })
  assert.equal(line, '> 检索流程：识别 10 篇 · 去重后 8 篇 · 可读 5 篇 · 采用 3 篇 · 查询 中文语义 2 / 英文技术 3 / 官方定向 1')
  // A run that planned no queries keeps the 0.6.x line byte for byte.
  assert.equal(
    formatRetrievalFlow({ identified: 10, deduped: 8, readable: 5, adopted: 3, queriesByKind: { semantic: 0, technical: 0, official: 0 } }),
    '> 检索流程：识别 10 篇 · 去重后 8 篇 · 可读 5 篇 · 采用 3 篇',
  )
  assert.doesNotMatch(formatRetrievalFlow({ identified: 10, deduped: 8, readable: 5, adopted: 3 }), /查询/)
})

test('a zero-evidence option is marked 无证据 in the comparison table (0.7.1)', () => {
  const compare = [
    '## 结论',
    '多数场景 pnpm 更省磁盘 [S1]。',
    '',
    '## 方案对比',
    '| 方案 | 优势 | 风险 | 适用条件 |',
    '| --- | --- | --- | --- |',
    '| pnpm | 安装快 [S1] | 生态较新 | 单仓多包 |',
    '| bun | 内置运行时 [S3] | 生态早期 | 试点 |',
    '',
    '## 置信度',
    'medium',
  ].join('\n')

  const marked = applyZeroEvidenceOptions(compare, ['bun'])
  assert.match(marked, /^\| bun \| 无证据 \| 无证据 \| 无证据 \|$/m)
  assert.match(marked, /^\| pnpm \| 安装快 \[S1\]/m, 'the evidenced row is untouched')
  assert.equal(applyZeroEvidenceOptions(marked, ['bun']), marked, 'idempotent')

  // The model dropped the option entirely: add the row instead of leaving a
  // shorter shortlist that implies the option was weighed.
  const dropped = compare.replace('| bun | 内置运行时 [S3] | 生态早期 | 试点 |\n', '')
  assert.match(applyZeroEvidenceOptions(dropped, ['bun']), /^\| bun \| 无证据 \| 无证据 \| 无证据 \|$/m)

  // No table at all: a bullet carries the fact, no table is invented.
  assert.match(applyZeroEvidenceOptions('## 方案对比\n不适用\n\n## 置信度\nlow', ['bun']), /- 「bun」：无证据/)
  assert.match(zeroEvidenceGapText('bun'), /^选项「bun」在本轮证据中没有可用来源（零证据），未纳入对比$/)

  // 0.9.7 — an option that owns a placeholder row is listed, not omitted, and a
  // price table says which fact is missing. Default (no row) stays unchanged.
  // 1.0.1 — the wording no longer promises a price: a compare row can be blank
  // for any key attribute (优势/风险/适用条件), not just cost.
  assert.equal(zeroEvidenceGapText('豆包', { hasRow: true }), '选项「豆包」在对比表中占位，但关键属性未取得（零证据）')
  assert.equal(
    zeroEvidenceGapText('豆包', { hasRow: true, priceTable: true }),
    '选项「豆包」在对比表中占位，但关键属性未取得（零证据）',
  )
  assert.equal(
    zeroEvidenceGapText('bun', { hasRow: true, priceTable: false }),
    '选项「bun」在对比表中占位，但关键属性未取得（零证据）',
  )
})

test('a brief without an action checklist gets the 无 placeholder (0.9.0)', () => {
  const filled = ensureSections('## 结论\n选 Node 22 [S1]\n\n## 依据\n- 官方发布说明 [S1]', 'high', [])
  assert.match(filled, new RegExp(`^${ACTION_CHECKLIST_HEADING}\\n- 无$`, 'm'))
  // Position: after the verdict/options, before the verdict's confidence block.
  assert.ok(filled.indexOf(ACTION_CHECKLIST_HEADING) > filled.indexOf('## 结论'))
  assert.ok(filled.indexOf(ACTION_CHECKLIST_HEADING) < filled.indexOf('## 置信度'))

  // After 方案对比 and before 坑与风险 when the model wrote both.
  const positioned = ensureSections(
    '## 结论\n选 pnpm [S1]\n\n## 方案对比\n| 方案 | 优势 |\n| --- | --- |\n| pnpm | 快 [S1] |\n\n## 坑与风险\n未发现',
    'medium',
    [],
  )
  assert.ok(positioned.indexOf('## 方案对比') < positioned.indexOf(ACTION_CHECKLIST_HEADING))
  assert.ok(positioned.indexOf(ACTION_CHECKLIST_HEADING) < positioned.indexOf('## 坑与风险'))

  // A checklist the model wrote is kept verbatim and never duplicated.
  const written = ensureSections(
    '## 结论\n选 pnpm [S1]\n\n## 行动清单\n- 在一个单仓项目里跑 pnpm 试点两周\n\n## 置信度\nmedium',
    'medium',
    [],
  )
  assert.equal((written.match(/^## 行动清单$/gm) ?? []).length, 1)
  assert.match(written, /- 在一个单仓项目里跑 pnpm 试点两周/)
})

test('the action checklist is required for compare/tech-selection/learning only (0.9.0)', () => {
  const headings = (options) => (requiredSectionsFor(options) ?? []).map((entry) => entry.heading)
  assert.ok(headings({ mode: 'compare' }).includes(ACTION_CHECKLIST_HEADING))
  assert.ok(headings({ mode: 'explain', questionKind: 'tech-selection' }).includes(ACTION_CHECKLIST_HEADING))
  assert.ok(headings({ mode: 'explain', questionKind: 'learning' }).includes(ACTION_CHECKLIST_HEADING))
  // Optional for concept/track: still filled by ensureSections, but no notch.
  assert.ok(!headings({ mode: 'explain', questionKind: 'concept' }).includes(ACTION_CHECKLIST_HEADING))
  assert.ok(!headings({ mode: 'track', questionKind: 'fresh-data' }).includes(ACTION_CHECKLIST_HEADING))
  assert.equal(requiredSectionsFor({ mode: 'explain', questionKind: 'concept' }), null)

  // A pack's own declaration survives the merge, placeholder included.
  const merged = requiredSectionsFor({ mode: 'compare', base: [{ heading: '## 迁移成本' }] })
  assert.deepEqual(merged.map((entry) => entry.heading), ['## 迁移成本', ACTION_CHECKLIST_HEADING])
  assert.equal(merged[0].fallback, '- 不适用')

  assert.deepEqual(
    missingSections('## 结论\nx', requiredSectionsFor({ mode: 'compare' })).map((entry) => entry.heading),
    [ACTION_CHECKLIST_HEADING],
  )
  assert.deepEqual(missingSections('## 结论\nx', requiredSectionsFor({ mode: 'explain', questionKind: 'concept' })), [])
})

test('a decision brief owes a 判据 section, filled with 无 and costing one notch (0.10.0)', () => {
  const sections = requiredSectionsFor({ mode: 'explain', questionKind: 'decision' })
  assert.deepEqual(sections.map((entry) => entry.heading), [ACTION_CHECKLIST_HEADING, DECISION_CRITERIA_HEADING])
  assert.equal(DECISION_CRITERIA_HEADING, '## 判据')
  assert.equal(sections[1].fallback, '- 无')
  // The section is required, so a model that skipped it is visible to the
  // pipeline *before* the placeholder is filled — that is the confidence notch.
  assert.deepEqual(
    missingSections('## 结论\n不该拆 [S1]\n\n## 行动清单\n- 先试点两周', sections).map((entry) => entry.heading),
    [DECISION_CRITERIA_HEADING],
  )
  const filled = ensureSections(
    '## 结论\n不该拆 [S1]\n\n## 行动清单\n- 先试点两周\n\n## 置信度\nhigh',
    'high', [], [], sections,
  )
  assert.match(filled, /^## 判据\n- 无$/m)
  assert.ok(filled.indexOf(DECISION_CRITERIA_HEADING) < filled.indexOf('## 置信度'))
  assert.deepEqual(missingSections(filled, sections), [])
  // A criteria list the model wrote is kept verbatim and never duplicated.
  const written = ensureSections(
    '## 结论\n不该拆 [S1]\n\n## 判据\n- 团队 ≥ 8 人且日发布 ≥ 3 次时拆分才划算\n\n## 置信度\nhigh',
    'high', [], [], sections,
  )
  assert.equal((written.match(/^## 判据$/gm) ?? []).length, 1)
  assert.match(written, /团队 ≥ 8 人/)
  // Only decision declares it: the legacy kinds keep the exact 0.9.0 list.
  assert.equal(requiredSectionsFor({ mode: 'explain', questionKind: 'concept' }), null)
  assert.ok(!(requiredSectionsFor({ mode: 'explain', questionKind: 'learning' }) ?? [])
    .some((entry) => entry.heading === DECISION_CRITERIA_HEADING))

  // A missing declared section costs one confidence notch (the pipeline passes
  // missingSections: true exactly like this when missingSections() is non-empty).
  const primary = [0, 1, 2].map((index) => cluster(`claim ${index}`, ['https://eur-lex.europa.eu/x', 'https://arxiv.org/abs/1']))
  assert.equal(computeConfidence(primary), 'high')
  assert.equal(computeConfidence(primary, { missingSections: true }), 'medium')
})

test('an unsourced 判据 bullet is labeled 推断, a cited one is left alone (0.10.1)', () => {
  const brief = [
    '## 结论', '**一句话：不该拆 [S1]。**', '',
    '## 判据',
    '- 团队 ≥ 8 人且日发布 ≥ 3 次才划算',
    '- 回滚成本 > 2 人日时不宜拆 [S1]',
    '- 无',
    '',
    '## 置信度', 'medium',
  ].join('\n')
  const sources = [{ id: 'S1', url: 'https://a.com/x', title: 'A' }]
  const grounded = groundCriteria(brief, sources)
  assert.match(grounded, /^- 团队 ≥ 8 人且日发布 ≥ 3 次才划算（推断）$/m)
  // A line that cites a real source is a finding, not a judgement.
  assert.match(grounded, /^- 回滚成本 > 2 人日时不宜拆 \[S1\]$/m)
  // `- 无` is the empty-section placeholder, not a criterion.
  assert.match(grounded, /^- 无$/m)
  assert.ok(!grounded.includes('- 无（推断）'))
  assert.ok(!grounded.includes('不该拆 [S1]（推断）'), 'the conclusion is outside 判据')
  // A mark the model already wrote is never doubled.
  const written = '## 判据\n- 阈值（推断）\n- 阈值 2（无来源）\n- 阈值 3 (推断)'
  assert.equal(groundCriteria(written, []), written)
  // A [S#] that is not in the source table grounds nothing: citation hygiene
  // would drop it, so the criterion would read as sourced while citing air.
  assert.match(
    groundCriteria('## 判据\n- 阈值 [S9]', sources),
    /^- 阈值 \[S9\]（推断）$/m,
  )

  // buildResult() applies it to the delivered text, not only to a dry run.
  const result = buildResult({
    brief: '## 结论\n不该拆 [S1]\n\n## 判据\n- 团队 ≥ 8 人且日发布 ≥ 3 次才划算\n\n## 置信度\nhigh',
    sources: [], confidence: 'medium', gaps: [], partial: false, depth: 'quick',
    stats: { questionKind: 'decision', queries: 1, pagesFetched: 1, llmRounds: 1, elapsedMs: 5 },
  })
  assert.match(result.brief, /^- 团队 ≥ 8 人且日发布 ≥ 3 次才划算（推断）$/m)
})

test('criteria grounding is idempotent (0.10.1)', () => {
  const once = groundCriteria('## 判据\n- 团队 ≥ 8 人', [])
  assert.equal(once, '## 判据\n- 团队 ≥ 8 人（推断）')
  assert.equal(groundCriteria(once, []), once)
})

test('a brief without a 判据 section is returned byte for byte (0.10.1)', () => {
  const brief = '## 结论\n不该拆\n\n## 置信度\nlow'
  assert.equal(groundCriteria(brief, []), brief)
  assert.equal(groundCriteria('', []), '')
  // The section ends at the next heading: later bullets are not criteria.
  const withTail = '## 判据\n- 阈值\n\n## 行动清单\n- 先试点两周'
  assert.equal(groundCriteria(withTail, []), '## 判据\n- 阈值（推断）\n\n## 行动清单\n- 先试点两周')
})

test('a decision verdict needs a first-party host to be high, thin breadth is low (0.10.1)', () => {
  // A real first-party host keeps the legacy verdict, whichever way the kind
  // arrives (positional argument, gates.questionKind, gates.kind).
  const primary = [0, 1, 2].map((index) => cluster(`claim ${index}`, ['https://eur-lex.europa.eu/x', 'https://arxiv.org/abs/1']))
  assert.equal(computeConfidence(primary), 'high')
  assert.equal(computeConfidence(primary, {}, 'decision'), 'high')
  assert.equal(computeConfidence(primary, { questionKind: 'decision' }), 'high')
  assert.equal(computeConfidence(primary, { kind: 'decision' }), 'high')

  // Papers count as primary-grade for the untouched "high" rule (primary.size
  // = 2), but no host here clears domainTrust 3: a paper can describe the
  // trade-off, it cannot decide for the team.
  const papers = [
    cluster('a', ['https://arxiv.org/abs/2401.00001', 'https://github.com/nodejs/release']),
    cluster('b', ['https://doi.org/10.1000/x', 'https://github.com/other/repo']),
    cluster('c', ['https://arxiv.org/abs/2401.00002', 'https://doi.org/10.1000/y']),
  ]
  assert.equal(computeConfidence(papers), 'high')
  assert.equal(computeConfidence(papers, {}, 'decision'), 'medium')
  assert.equal(computeConfidence(papers, { questionKind: 'decision' }), 'medium')
  // Other kinds are untouched: no gate widens or narrows them.
  assert.equal(computeConfidence(papers, {}, 'tech-selection'), 'high')
  assert.equal(computeConfidence(papers, {}, 'concept'), 'high')

  // Breadth below two independent sites is not evidence even for "medium".
  const thin = [cluster('only', ['https://arxiv.org/abs/2401.00001', 'https://doi.org/10.1000/x'])]
  assert.equal(computeConfidence(thin), 'medium')
  assert.equal(computeConfidence(thin, {}, 'decision'), 'low')
  assert.equal(computeConfidence([], {}, 'decision'), 'low')
})

test('uncited numbers in the compare table are marked, cited ones are left alone (0.9.0)', () => {
  const brief = [
    '## 结论', '选 A [S1]。', '',
    '## 方案对比',
    '| 方案 | 价格 | 延迟 |',
    '| --- | --- | --- |',
    '| A | 0.2 元 | 120 ms |',
    '| B | 0.2 元 [S1] | 90 ms [S2] |',
    '',
    '## 置信度', 'medium',
  ].join('\n')

  const marked = markUnsourcedNumbers(brief)
  assert.match(marked, /^\| A \| 0\.2 元（无来源） \| 120 ms（无来源） \|$/m)
  assert.match(marked, /^\| B \| 0\.2 元 \[S1\] \| 90 ms \[S2\] \|$/m)
  assert.ok(!marked.includes(`[S1]${UNSOURCED_NUMBER_MARK}`), 'a cited number must not be marked')
  // Numbers stay; only the label is added.
  assert.ok(marked.includes('0.2 元'), 'the value itself must survive')
  // Idempotent: running it again changes nothing.
  assert.equal(markUnsourcedNumbers(marked), marked)
  // The header row (`价格`, `延迟`) is never marked.
  assert.match(marked, /^\| 方案 \| 价格 \| 延迟 \|$/m)

  // Spliced into buildResult(), the same fallback runs on the delivered brief.
  const result = buildResult({
    brief: '## 结论\nx [S1]', sources: [], confidence: 'medium', gaps: [], partial: false, depth: 'quick',
    stats: { queries: 1, pagesFetched: 1, llmRounds: 1, elapsedMs: 5 },
  })
  assert.doesNotMatch(result.brief, /（无来源）/, 'nothing to mark when the table only cites sources')

  const withTable = buildResult({
    brief: [
      '## 结论', '选 A [S1]。', '',
      '## 方案对比',
      '| 方案 | 价格 |',
      '| --- | --- |',
      '| A | 0.2 元 |',
      '| B | 0.3 元 [S1] |',
    ].join('\n'),
    sources: [], confidence: 'medium', gaps: [], partial: false, depth: 'quick',
    stats: { queries: 1, pagesFetched: 1, llmRounds: 1, elapsedMs: 5 },
  })
  assert.match(withTable.brief, /^\| A \| 0\.2 元（无来源） \|$/m)
  assert.match(withTable.brief, /^\| B \| 0\.3 元 \[S1\] \|$/m)
})
// 0.9.6 — the compare table must give every declared candidate its own row.
// A merged `qwen / 豆包 API` cell hides a candidate from the conclusion, so the
// check names it instead of letting the table read as complete.
function compareTable(rows, header = '| 方案 | 价格 |') {
  return ['## 方案对比', header, '| --- | --- |', ...rows, '', '## 置信度', 'medium'].join('\n')
}

test('a candidate merged into another row is named under the compare table (0.9.6)', () => {
  const brief = compareTable([
    '| deepseek-flash | 0.5 元/百万 tokens [S1] |',
    '| qwen / 豆包 API | 未核实 |',
  ])
  const stats = {}
  const sink = {}
  const complete = checkCompareRows(brief, { options: ['deepseek-flash', 'qwen', '豆包'], stats, sink })
  assert.equal(complete, false)
  assert.equal(stats.compareRowsComplete, false)
  assert.deepEqual(sink.missing, ['qwen', '豆包'])
  assert.match(sink.brief, /^> 注意：qwen 未作为独立行出现（关键属性未取得），下表结论不含该候选。$/m)
  assert.match(sink.brief, /^> 注意：豆包 未作为独立行出现（关键属性未取得），下表结论不含该候选。$/m)
  // The note sits after the table, before the next section.
  assert.ok(sink.brief.indexOf('> 注意：') < sink.brief.indexOf('## 置信度'))
  // A merged row is never credited to either of its members.
  assert.doesNotMatch(sink.brief, /> 注意：deepseek-flash/)
  // Idempotent: the delivered brief can be re-checked without piling up notes.
  const again = {}
  assert.equal(checkCompareRows(sink.brief, { options: ['deepseek-flash', 'qwen', '豆包'], sink: again }), false)
  assert.equal(again.brief.match(/> 注意：豆包/g).length, 1)
})

test('an independent row with an unverified price is marked as unsourced (0.9.6)', () => {
  const brief = compareTable([
    '| deepseek-flash | 0.5 元/百万 tokens [S1] |',
    '| 豆包 | 未核实 |',
    '| qwen | — |',
    '| kimi | 无证据 |',
  ])
  const stats = {}
  const sink = {}
  assert.equal(checkCompareRows(brief, { options: ['deepseek-flash', '豆包', 'qwen', 'kimi'], stats, sink }), true)
  assert.equal(stats.compareRowsComplete, true)
  assert.deepEqual(sink.missing, [])
  assert.match(sink.brief, /^\| 豆包 \| 未核实（无来源） \|$/m)
  assert.match(sink.brief, /^\| qwen \| —（无来源） \|$/m)
  // 无证据 already says "there is no evidence"; do not stack a second label.
  assert.match(sink.brief, /^\| kimi \| 无证据 \|$/m)
  assert.match(sink.brief, /^\| deepseek-flash \| 0\.5 元\/百万 tokens \[S1\] \|$/m)
  assert.doesNotMatch(sink.brief, /^> 注意：/m)
})

test('a complete compare table is left untouched (0.9.6)', () => {
  const brief = compareTable([
    '| deepseek-flash | 0.5 元/百万 tokens [S1] |',
    '| 豆包 | 0.8 元/百万 tokens [S2] |',
  ])
  const stats = { compareRowsComplete: undefined }
  const sink = {}
  assert.equal(checkCompareRows(brief, { options: ['deepseek-flash', '豆包'], stats, sink }), true)
  assert.equal(stats.compareRowsComplete, true)
  assert.equal(sink.brief, brief)
  assert.deepEqual(sink.unsourced, [])

  // A transposed table (candidates as columns) still gets its price cells marked,
  // because that layout is legitimate.
  const transposed = ['## 方案对比', '| 维度 | 豆包 | qwen |', '| --- | --- | --- |', '| 价格 | 未核实 | 0.4 元 [S1] |', '', '## 置信度', 'medium'].join('\n')
  const transposedSink = {}
  assert.equal(checkCompareRows(transposed, { options: ['豆包', 'qwen'], sink: transposedSink }), true)
  assert.match(transposedSink.brief, /^\| 价格 \| 未核实（无来源） \| 0\.4 元 \[S1\] \|$/m)

  // No table and no compare heading: nothing to judge, and no crash.
  assert.equal(checkCompareRows('## 结论\n纯文字。', { options: ['a'], sink: {} }), true)
  assert.equal(checkCompareRows('', { options: [], sink: {} }), true)
})

// 0.9.6 — a directed refill source that the synthesizer did not cite is kept in
// the reference list (up to two) and labelled, instead of vanishing: the 0.9.5
// complaint was that the vendor page was fetched and then invisible.
test('an uncited refill source is kept and labelled instead of dropped (0.9.6)', () => {
  const sources = [
    { id: 'S1', title: 'Alpha', url: 'https://alpha.example.com/x' },
    { id: 'S2', title: '豆包价格', url: 'https://www.volcengine.com/docs/82379/doubao-pricing' },
    { id: 'S3', title: 'Gamma', url: 'https://gamma.example.com/y' },
    { id: 'S4', title: 'Delta', url: 'https://delta.example.com/z' },
  ]
  const refillUrls = [
    'https://www.volcengine.com/docs/82379/doubao-pricing',
    'https://gamma.example.com/y',
    'https://delta.example.com/z',
  ]
  const kept = validateCitations('结论 [S1]', sources, { refillUrls, maxKept: 2 })
  assert.equal(kept.cited, 1)
  assert.equal(kept.kept, 2, 'at most two unused refill sources are retained')
  assert.deepEqual(kept.sources.map((source) => source.url), [
    'https://alpha.example.com/x',
    'https://www.volcengine.com/docs/82379/doubao-pricing',
    'https://gamma.example.com/y',
  ])
  const rendered = appendReferences(kept.brief, kept.sources)
  assert.match(rendered, /^- \[S2\] 豆包价格 .*（官方）（已检索，未被采用）$/m)
  assert.match(rendered, /^- \[S3\] Gamma .*（已检索，未被采用）$/m)
  assert.doesNotMatch(rendered, /^- \[S1\] .*已检索，未被采用/m)
  // Without a refill hint nothing is retained — citation hygiene is unchanged.
  assert.equal(validateCitations('结论 [S1]', sources).sources.length, 1)
})

// 0.9.9 — two leaks reported on the 0.9.7 判断题 (微服务该不该拆): the label column
// read 「先拆 2-3 个服务（无来源）」 (a provenance tag inside the candidate's name,
// which also breaks candidate matching), and the table kept a 价格 column whose
// every row said 未核实 (a column that cannot be filled but reads as a finding).
const COMPARE_COLUMNS_5 = '| 方案 | 优势 | 风险 | 价格 | 适用场景 |'

function cCaseTable() {
  return [
    '## 结论', '建议先拆 [S1]。', '',
    '## 方案对比',
    COMPARE_COLUMNS_5,
    '| --- | --- | --- | --- | --- |',
    '| 单体 | 简单 [S1] | 耦合 | 未核实 | 小团队 |',
    '| 先拆 2-3 个服务（无来源） | 平衡 | 边界成本（推断） | 0.2 元/百万 tokens（无来源） | 成长期 |',
    '| 全量微服务（零证据） | 弹性（无来源） | 运维复杂 (无来源) | 未核实（无来源） | 大团队 |',
    '',
    '## 置信度', 'medium',
  ].join('\n')
}

test('provenance marks are stripped from the label column and non-numeric cells (0.9.9)', () => {
  // `pricing` keeps its price column, so only the mark rules are under test here.
  const out = sanitizeCompareTable(cCaseTable(), { questionKind: 'pricing' })

  assert.match(out, /^\| 先拆 2-3 个服务 \| 平衡 \| 边界成本（推断） \| 0\.2 元\/百万 tokens（无来源） \| 成长期 \|$/m,
    'the label column keeps its name, the numeric price cell keeps its provenance mark')
  assert.match(out, /^\| 全量微服务 \| 弹性 \| 运维复杂 \| 未核实 \| 大团队 \|$/m,
    '（零证据）/（无来源） must not survive in a label or a non-numeric cell')
  assert.doesNotMatch(out.split('\n').filter((line) => line.startsWith('|')).map((line) => line.split('|')[1]).join(''), /（无来源）|（零证据）|（推断）/,
    'no marker may remain in the label column')
  // A numeric cell is the one place a provenance mark belongs.
  assert.ok(out.includes('0.2 元/百万 tokens（无来源）'), 'a numeric cell keeps its （无来源） mark')
  // The header row labels columns, so it is not stripped.
  assert.ok(out.includes(COMPARE_COLUMNS_5), 'the header row changed')
  // A brief with no compare table is returned verbatim.
  assert.equal(sanitizeCompareTable('## 结论\n纯文字。', { questionKind: 'concept' }), '## 结论\n纯文字。')
})

test('a 价格 column on a non-pricing question becomes 成本概览 without dropping rows (0.9.9)', () => {
  const out = sanitizeCompareTable(cCaseTable(), { questionKind: 'concept' })
  assert.ok(out.includes(`| 方案 | 优势 | 风险 | ${COST_OVERVIEW_HEADER} | 适用场景 |`), 'the price header was not renamed')
  assert.ok(!out.includes('| 价格 |'), 'the 价格 header survived')
  // The bare-number price becomes 见注; the row itself stays (deleting it would
  // hide the candidate), and 未核实 is a legitimate 成本概览 value.
  assert.match(out, /^\| 先拆 2-3 个服务 \| 平衡 \| 边界成本（推断） \| 见注 \| 成长期 \|$/m, 'a numeric price cell must become 见注')
  assert.match(out, /^\| 单体 \| 简单 \[S1\] \| 耦合 \| 未核实 \| 小团队 \|$/m, '未核实 survives under 成本概览')
  assert.equal(out.split('\n').filter((line) => line.startsWith('| 全量微服务')).length, 1, 'no row may be dropped')
  assert.equal(PRICE_SEE_NOTE, '见注')
  // A price the brief can cite is a cost fact, not column noise: the [S#] stays.
  const cited = cCaseTable().replace('0.2 元/百万 tokens（无来源）', '0.2 元/百万 tokens [S2]')
  assert.ok(sanitizeCompareTable(cited, { questionKind: 'concept' }).includes('0.2 元/百万 tokens [S2]'),
    'a cited price must survive the rename')

  // architecture / decision / learning / evaluate behave the same: no price axis.
  for (const kind of ['architecture', 'decision', 'learning', 'evaluate', 'tech-selection']) {
    assert.ok(!sanitizeCompareTable(cCaseTable(), { questionKind: kind }).includes('| 价格 |'), `${kind} kept a 价格 column`)
  }
  // A pricing question keeps its price column exactly as written.
  assert.ok(sanitizeCompareTable(cCaseTable(), { questionKind: 'pricing' }).includes('| 价格 |'), 'pricing lost its price column')
  // Unknown kind: cannot judge, so the column is left alone (marks are still cleaned).
  const unknown = sanitizeCompareTable(cCaseTable(), {})
  assert.ok(unknown.includes('| 价格 |'), 'an unknown kind must leave the header alone')
})

test('sanitizeCompareTable is idempotent and runs before checkCompareRows in buildResult (0.9.9)', () => {
  const once = sanitizeCompareTable(cCaseTable(), { questionKind: 'concept' })
  assert.equal(sanitizeCompareTable(once, { questionKind: 'concept' }), once, 'a second pass must change nothing')
  assert.equal(sanitizeCompareTable(cCaseTable(), { questionKind: 'pricing' }).includes(PRICE_SEE_NOTE), false, 'pricing must not produce 见注')

  const result = buildResult({
    brief: cCaseTable(), sources: [], confidence: 'medium', gaps: [], partial: false, depth: 'quick',
    stats: { questionKind: 'concept', queries: 1, pagesFetched: 1, llmRounds: 1, elapsedMs: 5 },
  })
  // The delivered brief, not just the helper's return value, is clean.
  assert.ok(result.brief.includes(`| 方案 | 优势 | 风险 | ${COST_OVERVIEW_HEADER} | 适用场景 |`), 'buildResult missed the column rename')
  assert.match(result.brief, /^\| 先拆 2-3 个服务 \| 平衡 \| 边界成本（推断） \| 见注 \| 成长期 \|$/m)
  const labelCells = result.brief.split('\n').filter((line) => line.startsWith('|')).map((line) => line.split('|')[1]).join('')
  assert.doesNotMatch(labelCells, /（无来源）|（零证据）|（推断）/, 'a marker leaked back into the label column')

  // A pricing question keeps its price column and still gets the number marks.
  const priced = buildResult({
    brief: cCaseTable(), sources: [], confidence: 'medium', gaps: [], partial: false, depth: 'quick',
    stats: { questionKind: 'pricing', queries: 1, pagesFetched: 1, llmRounds: 1, elapsedMs: 5 },
  })
  assert.ok(priced.brief.includes('| 价格 |'), 'the pricing table lost its price column')
  assert.ok(priced.brief.includes('0.2 元/百万 tokens（无来源）'), 'the uncited price lost its mark')
})

// 0.9.10 — the 0.9.9 strip rule was `/\d/.test(cell)`, so 「未核实（无来源）」 (and
// any prose cell that merely mentioned a number) kept its mark: the delivered 成本
// 概览 still read 未核实（无来源）. The rule is now "strip unless the cell is nothing
// but a quantity".
const COST_COLUMNS_5 = `| 方案 | 优势 | 风险 | 适用场景 | ${COST_OVERVIEW_HEADER} |`

function costCaseTable() {
  return [
    '## 结论', '建议先拆 [S1]。', '',
    '## 方案对比',
    COST_COLUMNS_5,
    '| --- | --- | --- | --- | --- |',
    '| 单体 | 部署 1 个包（无来源） | 耦合（无来源） | 8 人以内 | 未核实（无来源） |',
    '| 微服务 | 每次发布 3 分钟（无来源） | 运维复杂（无来源） | 20 人以上 | 0.2 元/百万 tokens（无来源） |',
    '',
    '## 置信度', 'medium',
  ].join('\n')
}

test('（无来源） survives only on pure quantities, not on prose (0.9.10)', () => {
  const out = sanitizeCompareTable(costCaseTable(), { questionKind: 'concept' })
  // Prose cells lose the mark even when they contain digits.
  assert.ok(out.includes('| 部署 1 个包 |'), 'a digit-bearing prose cell kept （无来源）')
  assert.ok(out.includes('| 每次发布 3 分钟 |'), 'a digit-bearing prose cell kept （无来源）')
  assert.ok(out.includes('| 运维复杂 |'), 'a prose cell kept （无来源）')
  // 未核实 is the reported leak: the value stays, the mark does not.
  assert.ok(out.includes(`| 未核实 |`), 'the 未核实 value was lost')
  assert.ok(!out.includes('未核实（无来源）'), '未核实（无来源） survived sanitizeCompareTable')
  assert.ok(out.includes('| 未核实 |'), '未核实 must stay in the 成本概览 cell')
  // A pure number+unit cell is a quantitative claim and keeps its provenance.
  assert.ok(out.includes('0.2 元/百万 tokens（无来源）'), 'a pure quantity lost its provenance mark')

  // The boundary, one cell at a time: quantities keep the mark, prose strips it.
  const cellTable = (cell) => ['## 方案对比', COST_COLUMNS_5, '| --- | --- | --- | --- | --- |', `| A | x | y | z | ${cell} |`].join('\n')
  for (const quantity of ['0.2 元/百万 tokens', '8 人', '99.9%', '20–40 ms', '3 天', '1M tokens']) {
    const kept = sanitizeCompareTable(cellTable(`${quantity}（无来源）`), { questionKind: 'concept' })
    assert.ok(kept.includes(`${quantity}（无来源）`), `${quantity} is a quantity and must keep （无来源）`)
  }
  for (const prose of ['未核实', '延迟低', 'v22.11.0', '先拆 2-3 个服务', '见注']) {
    const stripped = sanitizeCompareTable(cellTable(`${prose}（无来源）`), { questionKind: 'concept' })
    assert.ok(stripped.includes(`| ${prose} |`), `${prose} is prose and must lose （无来源）`)
  }
  // Idempotent: a second pass changes nothing.
  assert.equal(sanitizeCompareTable(out, { questionKind: 'concept' }), out)
})

test('the delivered 成本概览 no longer re-marks 未核实 after sanitize (0.9.10)', () => {
  const result = buildResult({
    brief: costCaseTable(), sources: [], confidence: 'medium', gaps: [], partial: false, depth: 'quick',
    compareOptions: ['单体', '微服务'],
    stats: { questionKind: 'concept', queries: 1, pagesFetched: 1, llmRounds: 1, elapsedMs: 5 },
  })
  // sanitizeCompareTable cleaned it; checkCompareRows used to add it straight back
  // because 成本概览 matched PRICE_COLUMN /成本/.
  assert.ok(!result.brief.includes('未核实（无来源）'), 'checkCompareRows re-marked the neutral 成本概览 cell')
  assert.ok(result.brief.includes(`| 未核实 |`), 'the 未核实 value must stay in 成本概览')
  assert.ok(result.brief.includes('0.2 元/百万 tokens（无来源）'), 'the quantity provenance mark was lost end to end')
  assert.ok(result.brief.includes(COST_COLUMNS_5), 'the cost header changed')

  // A pricing question keeps the 0.9.6 contract: a bare 未核实 under 价格 is marked.
  const pricingTable = [
    '## 方案对比', '| 方案 | 价格 | 币种/口径 | 适用场景 |',
    '| --- | --- | --- | --- |',
    '| DeepSeek | 0.2 元/百万 tokens [S1] | 人民币 | 通用 |',
    '| Qwen | 未核实 | 人民币 | 通用 |',
  ].join('\n')
  const priced = buildResult({
    brief: pricingTable, sources: [], confidence: 'medium', gaps: [], partial: false, depth: 'quick',
    compareOptions: ['DeepSeek', 'Qwen'],
    stats: { questionKind: 'pricing', queries: 1, pagesFetched: 1, llmRounds: 1, elapsedMs: 5 },
  })
  assert.ok(priced.brief.includes('未核实（无来源）'), 'a pricing table must still mark a bare 未核实')

  // A plain 成本 column (not 成本概览) still counts as a price column for pricing.
  assert.equal(isPriceColumnHeader('成本'), true, 'a plain 成本 column is still a price column')
  assert.equal(isPriceColumnHeader(COST_OVERVIEW_HEADER), false, '成本概览 must not be treated as a price column')
  assert.equal(isPriceColumnHeader('价格'), true)
})

// 1.0.1 — the reported 1.0.0 run fetched nine references, seven of them official,
// and still delivered a 3×4 compare table whose every cell said 无证据. The table
// filler reuses what the evidence already says about each option instead of
// throwing the cells away, and picks the claim by column semantics.
function fillTable(rows, header = '| 方案 | 优势 | 风险 | 适用场景 |') {
  const columns = header.split('|').length - 2
  const separator = `| ${Array.from({ length: columns }, () => '---').join(' | ')} |`
  return ['## 方案对比', header, separator, ...rows, '', '## 置信度', 'low'].join('\n')
}

function fillClusters() {
  return [{
    claim: 'Spring AI 提供统一的 ChatClient 抽象，可以切换不同模型',
    evidence: [
      { id: 'S1', claim: 'Spring AI 提供统一的 ChatClient 抽象，可以切换不同模型', url: 'https://docs.spring.io/spring-ai/reference/chatclient.html' },
    ],
  }, {
    claim: 'Spring AI 需要 Java 17 以上，迁移现有项目需要额外改造',
    evidence: [
      { id: 'S2', claim: 'Spring AI 需要 Java 17 以上，迁移现有项目需要额外改造', url: 'https://docs.spring.io/spring-ai/reference/getting-started.html' },
    ],
  }, {
    claim: 'Spring AI 适合已经使用 Spring 后端的企业项目',
    evidence: [
      { id: 'S3', claim: 'Spring AI 适合已经使用 Spring 后端的企业项目', url: 'https://docs.spring.io/spring-ai/reference/intro.html' },
    ],
  }, {
    claim: 'LangChain4j 支持多种向量库，但文档和示例仍偏少',
    evidence: [
      { id: 'S4', claim: 'LangChain4j 支持多种向量库，但文档和示例仍偏少', url: 'https://docs.langchain4j.dev/integrations/' },
    ],
  }, {
    claim: 'LangChain4j 适用于快速搭建原型',
    evidence: [
      { id: 'S5', claim: 'LangChain4j 适用于快速搭建原型', url: 'https://docs.langchain4j.dev/tutorials/' },
    ],
  }]
}

test('empty compare cells are filled with the option own claims (1.0.1)', () => {
  const table = fillTable([
    '| Spring AI | 无证据 | 无证据 | 无证据 |',
    '| LangChain4j | 无证据 | 无证据 | 无证据 |',
  ])
  const filled = fillEmptyCompareCells(table, fillClusters(), ['Spring AI', 'LangChain4j'])
  assert.ok(filled.split('\n').some((line) => line.startsWith('| Spring AI | Spring AI ')), filled)
  const ai = filled.split('\n').find((line) => line.startsWith('| Spring AI |'))
  // 优势 keeps the first claim; 风险 prefers a risk/limitation claim; 适用场景 the fit one.
  assert.match(ai, /ChatClient 抽象[^|]*\[S1\]/)
  assert.match(ai, /风险|需要 Java 17|改造/)
  assert.match(ai, /适合已经使用 Spring 后端/)
  const lc = filled.split('\n').find((line) => line.startsWith('| LangChain4j |'))
  assert.match(lc, /向量库/)
  assert.match(lc, /适用于快速搭建原型/)
  // A column with no matching claim stays 无证据 instead of stretching another claim.
  assert.match(lc, /无证据/)
  assert.ok(!/LangChain4j[^|]*风险[^|]*\[S4\]/.test(lc), lc)
  // The table keeps its shape: header, separator and one row per option.
  assert.equal(filled.split('\n').filter((line) => line.trim().startsWith('|')).length, 4)
  // Claims longer than 60 chars are truncated rather than pasted whole.
  assert.ok(filled.split('\n').every((line) => line.length < 400))
})

test('filling empty compare cells is idempotent and never invents a claim (1.0.1)', () => {
  const table = fillTable([
    '| Spring AI | 无证据 | 无证据 | 无证据 |',
    '| bun | 无证据 | 无证据 | 无证据 |',
  ])
  const once = fillEmptyCompareCells(table, fillClusters(), ['Spring AI', 'bun'])
  assert.equal(fillEmptyCompareCells(once, fillClusters(), ['Spring AI', 'bun']), once, 'second pass changes nothing')
  // bun has no claim at all: 无证据 stays instead of borrowing Spring AI's text.
  const bun = once.split('\n').find((line) => line.startsWith('| bun |'))
  assert.equal(bun, '| bun | 无证据 | 无证据 | 无证据 |')
  // A table without the heading is returned untouched.
  assert.equal(fillEmptyCompareCells('## 结论\nok', fillClusters(), ['Spring AI']), '## 结论\nok')
})

// 1.0.2 — the reported selection run filled both 成本概览 cells of
// `| 方案 | 优势 | 风险 | 适用场景 | 成本概览 |` with capability descriptions
// ("Advisors API 用于拦截增强") plus [S#]. The cell looked like cost data but said
// nothing about money: the column now only accepts cost-bearing claims and states
// the absence otherwise.
const costCellOf = (line) => line.split('|').slice(-2)[0].trim()

function costTable() {
  return fillTable([
    '| Spring AI | 无证据 | 无证据 | 无证据 | 无证据 |',
    '| LangChain4j | 无证据 | 无证据 | 无证据 | 无证据 |',
  ], COST_COLUMNS_5)
}

function costClaimClusters() {
  return [...fillClusters(), {
    claim: 'Spring AI 按量计费，0.2 元/千 tokens',
    evidence: [
      { id: 'S6', claim: 'Spring AI 按量计费，0.2 元/千 tokens', url: 'https://docs.spring.io/spring-ai/reference/pricing.html' },
    ],
  }, {
    claim: 'LangChain4j 免费（Apache-2.0）',
    evidence: [
      { id: 'S7', claim: 'LangChain4j 免费（Apache-2.0）', url: 'https://docs.langchain4j.dev/pricing/' },
    ],
  }]
}

test('a 成本概览 cell never borrows a capability claim (1.0.2)', () => {
  const filled = fillEmptyCompareCells(costTable(), fillClusters(), ['Spring AI', 'LangChain4j'])
  const lines = filled.split('\n')
  for (const name of ['Spring AI', 'LangChain4j']) {
    const line = lines.find((row) => row.startsWith(`| ${name} |`))
    assert.ok(line, `${name} row is gone`)
    assert.equal(costCellOf(line), COST_MISSING_CELL, `${name} 成本概览 borrowed a capability claim: ${line}`)
    assert.doesNotMatch(costCellOf(line), /ChatClient|向量库|搭建原型|迁移/, 'a capability claim landed in the cost column')
  }
  // The other columns keep the 1.0.1 fill: the fix is scoped to the cost column.
  assert.match(filled, /ChatClient 抽象[^|]*\[S1\]/)
  assert.match(filled, /需要 Java 17/)
  assert.match(filled, /适合已经使用 Spring 后端/)
  // The note is appended once, under the table, and only for a fully missing column.
  assert.equal(filled.split(COST_OVERVIEW_NOTE).length - 1, 1, 'the cost note must appear exactly once')
  assert.ok(lines.indexOf(COST_OVERVIEW_NOTE) > lines.findIndex((line) => line.startsWith('| LangChain4j |')), 'the note must sit under the table')
  assert.equal(fillEmptyCompareCells(filled, fillClusters(), ['Spring AI', 'LangChain4j']), filled, 'second pass changes nothing')
})

test('cost-bearing claims fill the 成本概览 column normally (1.0.2)', () => {
  const filled = fillEmptyCompareCells(costTable(), costClaimClusters(), ['Spring AI', 'LangChain4j'])
  const ai = costCellOf(filled.split('\n').find((line) => line.startsWith('| Spring AI |')))
  const lc = costCellOf(filled.split('\n').find((line) => line.startsWith('| LangChain4j |')))
  assert.match(ai, /按量计费|0\.2 元\/千 tokens/)
  assert.match(ai, /\[S6\]/)
  assert.match(lc, /免费/)
  assert.match(lc, /\[S7\]/)
  assert.ok(!filled.includes(COST_MISSING_CELL), 'a cost-bearing claim must not be replaced by the missing placeholder')
  assert.ok(!filled.includes(COST_OVERVIEW_NOTE), 'the note must not fire when the column has cost evidence')
})

test('the cost note needs the whole column to lack cost evidence (1.0.2)', () => {
  // Only Spring AI has a price claim: the other cell is missing, but the column is
  // not empty, so the report-level note would be wrong.
  const clusters = [...fillClusters(), costClaimClusters().find((cluster) => cluster.claim.includes('按量计费'))]
  const filled = fillEmptyCompareCells(costTable(), clusters, ['Spring AI', 'LangChain4j'])
  const ai = costCellOf(filled.split('\n').find((line) => line.startsWith('| Spring AI |')))
  const lc = costCellOf(filled.split('\n').find((line) => line.startsWith('| LangChain4j |')))
  assert.match(ai, /按量计费/)
  assert.equal(lc, COST_MISSING_CELL)
  assert.ok(!filled.includes(COST_OVERVIEW_NOTE), 'a half-filled cost column must not get the note')
})

test('pricing questions keep true price columns without a cost placeholder (1.0.2)', () => {
  const table = fillTable([
    '| Spring AI | 未核实 | 未核实 |',
    '| LangChain4j | 未核实 | 未核实 |',
  ], '| 方案 | 输入价 | 输出价 |')
  const clusters = [{
    claim: 'Spring AI 输入价 $0.15/百万 tokens，输出价 $0.60/百万 tokens',
    evidence: [{ id: 'S8', claim: 'Spring AI 输入价 $0.15/百万 tokens，输出价 $0.60/百万 tokens', url: 'https://example.com/spring-ai-pricing' }],
  }, {
    claim: 'LangChain4j 输入价 $0.10/百万 tokens',
    evidence: [{ id: 'S9', claim: 'LangChain4j 输入价 $0.10/百万 tokens', url: 'https://example.com/langchain4j-pricing' }],
  }]
  const filled = fillEmptyCompareCells(table, clusters, ['Spring AI', 'LangChain4j'])
  assert.ok(filled.includes('| 方案 | 输入价 | 输出价 |'), 'a true price header must stay')
  assert.match(filled, /输入价 \$0\.15\/百万 tokens[^|]*\[S8\]/)
  assert.match(filled, /输出价 \$0\.60\/百万 tokens[^|]*\[S8\]/)
  assert.ok(!filled.includes(COST_MISSING_CELL), 'a price column is not a cost column')
  assert.ok(!filled.includes(COST_OVERVIEW_NOTE), 'a price column must not get the cost note')

  // Same guarantee end to end for a pricing question: 价格 stays filled, no cost note.
  const priced = buildResult({
    brief: ['## 方案对比', '| 方案 | 价格 | 币种/口径 | 适用场景 |', '| --- | --- | --- | --- |', '| DeepSeek | 未核实 | 人民币 | 通用 |', '', '## 置信度', 'low'].join('\n'),
    sources: [{ id: 'S1', url: 'https://example.com/deepseek-pricing', title: 'DeepSeek pricing' }],
    confidence: 'low', gaps: [], partial: false, depth: 'quick',
    clusters: [{ claim: 'DeepSeek 输入价 0.2 元/百万 tokens', evidence: [{ id: 'S1', claim: 'DeepSeek 输入价 0.2 元/百万 tokens', url: 'https://example.com/deepseek-pricing' }] }],
    compareOptions: ['DeepSeek'],
    stats: { questionKind: 'pricing', queries: 1, pagesFetched: 1, llmRounds: 1, elapsedMs: 5 },
  })
  assert.match(priced.brief, /0\.2 元\/百万 tokens/)
  assert.ok(!priced.brief.includes(COST_MISSING_CELL), 'pricing flow leaked the cost placeholder')
  assert.ok(!priced.brief.includes(COST_OVERVIEW_NOTE), 'pricing flow leaked the cost note')
})

test('a zero-evidence note matches the compare table it describes (1.0.1)', () => {
  // The option owns a row: the note must not claim it was left out of the table.
  const withRow = buildResult({
    brief: fillTable(['| 豆包 | 无证据 | 无证据 | 无证据 |']),
    sources: [], confidence: 'low', gaps: ['暂无官方价格页'], partial: false, depth: 'quick',
    zeroEvidenceOptions: ['豆包'],
    compareOptions: ['豆包'],
    stats: { questionKind: 'selection', queries: 1, pagesFetched: 1, llmRounds: 1, elapsedMs: 5 },
  })
  assert.match(withRow.brief, /选项「豆包」在对比表中占位，但关键属性未取得（零证据）/)
  assert.doesNotMatch(withRow.brief, /选项「豆包」在本轮证据中没有可用来源/)

  // Merged row: 豆包 does appear in the table, so again "not compared" would be a lie.
  const merged = buildResult({
    brief: fillTable(['| qwen / 豆包 API | 无证据 | 无证据 | 无证据 |']),
    sources: [], confidence: 'low', gaps: [], partial: false, depth: 'quick',
    zeroEvidenceOptions: ['豆包'],
    compareOptions: ['qwen', '豆包'],
    stats: { questionKind: 'selection', queries: 1, pagesFetched: 1, llmRounds: 1, elapsedMs: 5 },
  })
  assert.match(merged.brief, /选项「豆包」在对比表中占位，但关键属性未取得（零证据）/)
  assert.doesNotMatch(merged.brief, /选项「豆包」在本轮证据中没有可用来源/)

  // No table at all: the note and the bullet both say it was not compared.
  const noTable = buildResult({
    brief: '## 方案对比\n不适用\n\n## 置信度\nlow',
    sources: [], confidence: 'low', gaps: [], partial: false, depth: 'quick',
    zeroEvidenceOptions: ['豆包'],
    compareOptions: ['豆包'],
    stats: { questionKind: 'selection', queries: 1, pagesFetched: 1, llmRounds: 1, elapsedMs: 5 },
  })
  assert.match(noTable.brief, /- 「豆包」：无证据，未纳入对比/)
  assert.match(noTable.brief, /选项「豆包」在本轮证据中没有可用来源（零证据），未纳入对比/)
})

test('buildResult fills a compare table from clusters and cites the delivered source ids (1.0.1)', () => {
  const table = fillTable(['| Spring AI | 无证据 | 无证据 | 无证据 |', '| LangChain4j | 无证据 | 无证据 | 无证据 |'])
  const sources = [
    { id: 'S1', url: 'https://docs.spring.io/spring-ai/reference/chatclient.html', title: 'ChatClient' },
    { id: 'S2', url: 'https://docs.spring.io/spring-ai/reference/getting-started.html', title: 'Getting started' },
    { id: 'S3', url: 'https://docs.spring.io/spring-ai/reference/intro.html', title: 'Introduction' },
    { id: 'S4', url: 'https://docs.langchain4j.dev/integrations/', title: 'Integrations' },
    { id: 'S5', url: 'https://docs.langchain4j.dev/tutorials/', title: 'Tutorials' },
  ]
  const result = buildResult({
    brief: table, sources, confidence: 'medium', gaps: [], partial: false, depth: 'quick',
    clusters: fillClusters(),
    compareOptions: ['Spring AI', 'LangChain4j'],
    stats: { questionKind: 'selection', queries: 1, pagesFetched: 5, llmRounds: 1, elapsedMs: 5 },
  })
  assert.ok(!/\| Spring AI \| 无证据 \|/.test(result.brief), result.brief)
  assert.match(result.brief, /ChatClient 抽象[^|]*\[S\d\]/)
  assert.match(result.brief, /适用于快速搭建原型[^|]*\[S\d\]/)
  // The citation must land in the reference list, so [S#] cannot dangle.
  for (const match of result.brief.matchAll(/\[(S\d+)\]/g)) {
    assert.ok(result.sources.some((source) => source.id === match[1]), match[1])
  }
})

// 1.1.1 — the reported run filled the 通义千问 row with 「阿里云 AI 助手导入模型时，
// 可选模型包括…」: the cluster was owned by 通义千问 (its quote named the vendor)
// while its claim was about something else, and the filler copied the claim. A
// claim may only fill the row of an option it names itself.
test('a compare cell only takes a claim that names its own option (1.1.1)', () => {
  const clusters = [{
    claim: '阿里云 AI 助手导入模型时，可选模型包括 qwen-max、qwen-plus 与 Llama 系列。',
    status: 'confirmed',
    evidence: [{
      id: 'S1',
      url: 'https://help.aliyun.com/zh/model-studio/assistant',
      title: '阿里云百炼 AI 助手',
      claim: '阿里云 AI 助手导入模型时，可选模型包括 qwen-max、qwen-plus 与 Llama 系列。',
      quote: '通义千问（Qwen）系列模型由阿里云提供，可在智能体应用中被引用。',
    }],
  }]
  const table = fillTable(['| 通义千问 | 无证据 | 无证据 | 无证据 |'])
  const filled = fillEmptyCompareCells(table, clusters, ['通义千问'])
  const row = filled.split('\n').find((line) => line.startsWith('| 通义千问 |'))
  assert.ok(row, filled)
  // The unrelated claim is not borrowed, so every cell keeps the placeholder.
  assert.match(row, /无证据/)
  assert.doesNotMatch(row, /可选模型包括/)
  assert.doesNotMatch(row, /\[S1\]/)

  // A claim that does name the option still fills the row (the gate is not a mute).
  const named = [{ ...clusters[0], claim: '通义千问的 qwen-max 支持 32K 上下文，可按量计费。' }]
  const filledNamed = fillEmptyCompareCells(table, named, ['通义千问'])
  const namedRow = filledNamed.split('\n').find((line) => line.startsWith('| 通义千问 |'))
  assert.match(namedRow, /32K 上下文[^|]*\[S1\]/)
})

// 1.1.1 — the DeepSeek row said 无证据 while a price sentence sat right under the
// table ("$0.6–3.96 / 百万 tokens"). A price sentence outside the table may fill a
// price cell for the option it names; it is never used for 风险/优势 columns and it
// never fills a row for another option.
test('a price sentence under the table fills the price cell it belongs to (1.1.1)', () => {
  const table = [
    '## 方案对比',
    '| 方案 | 输入价 | 风险 |',
    '| --- | --- | --- |',
    '| DeepSeek | 无证据 | 无证据 |',
    '| 通义千问 | 无证据 | 无证据 |',
    '',
    '- DeepSeek 输入价 $0.6–3.96 / 百万 tokens，命中缓存更便宜 [S3]',
    '',
    '## 置信度',
    'low',
  ].join('\n')
  const filled = fillEmptyCompareCells(table, [], ['DeepSeek', '通义千问'])
  const ds = filled.split('\n').find((line) => line.startsWith('| DeepSeek |'))
  assert.match(ds, /\$0\.6–3\.96/)
  assert.match(ds, /\[S3\]/)
  // 风险 stays empty: a price is not a risk, and the sentence must not be stretched.
  assert.match(ds, /无证据/)
  // The sentence names DeepSeek only, so 通义千问 gets nothing from it.
  const qwen = filled.split('\n').find((line) => line.startsWith('| 通义千问 |'))
  assert.match(qwen, /无证据/)
  assert.doesNotMatch(qwen, /\$0\.6/)
  assert.doesNotMatch(qwen, /\[S3\]/)
  // Idempotent: the filled cell is no longer empty.
  assert.equal(fillEmptyCompareCells(filled, [], ['DeepSeek', '通义千问']), filled)
})

// 1.1.1 — the same defect at the section level: a model-written 「## 存在冲突」 with a
// 「- 无」 body is not a finding, so the deterministic self-contradictions replace
// it instead of being skipped along with the heading.
test('a placeholder-only 冲突 section is replaced by the findings (1.1.1)', () => {
  const quote = '输出上限：384K tokens。输出上限：256K tokens。'
  const items = [{
    id: 'S1',
    url: 'https://nodejs.org/en/about/previous-releases',
    title: 'Node releases',
    publishedAt: '2026-01-01',
    claim: quote,
    quote,
  }]
  const contradictions = findSelfContradictions(items)
  assert.equal(contradictions.length, 1)
  const placeholder = '## 结论\nx [S1]\n\n## 存在冲突\n- 无\n\n## 置信度\nmedium\n\n## 未解决\n- 无'
  const out = appendConflictSection(placeholder, [], [], [], contradictions)
  assert.match(out, /^### 来源自相矛盾$/m)
  assert.match(out, /输出上限：384K tokens \/ 256K tokens/)
  assert.doesNotMatch(conflictSectionOf(out), /^-\s*无$/m)
  assert.match(out, /^## 置信度$/m)
  // Idempotent: a section that states something is kept as written.
  assert.equal(appendConflictSection(out, [], [], [], contradictions), out)
})

test('validateCriteria keeps a 判据 section whose bullets all carry thresholds (1.1.0)', () => {
  const brief = [
    '## 结论', '不该拆 [S1]。', '',
    '## 判据',
    '- 团队 ≥ 8 人且日发布 ≥ 3 次才划算',
    '- 回滚成本超过 2 人日时不宜拆',
    '- 故障定位 > 30 分钟则先拆分',
    '',
    '## 置信度', 'high', '',
    '## 未解决', '- 无',
  ].join('\n')
  const report = validateCriteria(brief, { confidence: 'high' })
  assert.equal(report.brief, brief)
  assert.equal(report.weak, 0)
  assert.equal(report.total, 3)
  assert.equal(report.downgraded, false)
})

test('validateCriteria labels 推断 on mostly-prose 判据 and lowers the verdict one notch (1.1.0)', () => {
  const brief = [
    '## 结论', '看情况 [S1]。', '',
    '## 判据',
    '- 团队规模要够大才值得拆',
    '- 要评估现有架构的耦合度',
    '- 团队 ≥ 8 人时再考虑',
    '',
    '## 置信度', 'high', '',
    '## 未解决', '- 无',
  ].join('\n')
  const report = validateCriteria(brief, { confidence: 'high' })
  assert.equal(report.weak, 2)
  assert.equal(report.total, 3)
  assert.equal(report.downgraded, true)
  assert.match(report.brief, /^- 团队规模要够大才值得拆（推断）$/m)
  assert.match(report.brief, /^- 要评估现有架构的耦合度（推断）$/m)
  assert.match(report.brief, /^- 团队 ≥ 8 人时再考虑$/m)
  assert.match(report.brief, /^## 置信度\nmedium$/m)
  assert.match(report.brief, /^- 判据偏软：2\/3 条缺少可量化阈值，结论按证据强度下调$/m)
  // `low` has nowhere to fall, and no confidence means no verdict to lower.
  assert.equal(validateCriteria(brief, { confidence: 'low' }).downgraded, false)
  assert.equal(validateCriteria(brief).downgraded, false)
})

test('validateCriteria never doubles a provenance mark and skips 无 and citation ids (1.1.0)', () => {
  const brief = [
    '## 判据',
    '- 阈值要看团队成熟度（推断）',
    '- 团队已有微服务经验 [S1]',
    '- 无',
    '',
    '## 置信度', 'medium',
  ].join('\n')
  const report = validateCriteria(brief, { confidence: 'medium' })
  assert.equal(report.total, 2, '- 无 is not a criterion')
  assert.equal(report.weak, 2)
  assert.equal(report.brief.match(/（推断）/g).length, 1)
  assert.match(report.brief, /^- 团队已有微服务经验 \[S1\]$/m)
  assert.match(report.brief, /^## 置信度\nlow$/m)
  // No 未解决 section: the note creates one, and only once.
  assert.equal(report.brief.match(/判据偏软：/g).length, 1)
})

// 1.1.2 — 判据 is a required section only for decision briefs (and a soft one is
// a genuine decision risk). On a concept or comparison question the same prose
// bullets were costing well-sourced answers a notch for no reason, which is the
// other half of "the brief looks weaker than its evidence".
test('判据校验 only costs a notch on decision briefs (1.1.2)', () => {
  const brief = [
    '## 判据',
    '- 团队规模与迁移成本是否匹配 [S1]',
    '',
    '## 置信度', 'medium',
  ].join('\n')
  const decision = validateCriteria(brief, { confidence: 'medium', questionKind: 'decision' })
  assert.equal(decision.downgraded, true)
  assert.match(decision.brief, /^## 置信度\nlow$/m)
  const concept = validateCriteria(brief, { confidence: 'medium', questionKind: 'concept' })
  assert.equal(concept.downgraded, false)
  assert.match(concept.brief, /^## 置信度\nmedium$/m)
  assert.doesNotMatch(concept.brief, /判据偏软：/)
  // The provenance mark is unaffected: it is about the line, not the verdict.
  assert.match(concept.brief, /^- 团队规模与迁移成本是否匹配 \[S1\]$/m)
})

test('validateCriteria returns a brief without 判据 byte for byte (1.1.0)', () => {
  const brief = '## 结论\n该上。\n\n## 置信度\nhigh'
  const report = validateCriteria(brief, { confidence: 'high' })
  assert.equal(report.brief, brief)
  assert.deepEqual(
    { weak: report.weak, total: report.total, downgraded: report.downgraded },
    { weak: 0, total: 0, downgraded: false },
  )
  assert.equal(validateCriteria('', { confidence: 'high' }).brief, '')
})

test('validateCriteria is idempotent (1.1.0)', () => {
  const brief = [
    '## 判据',
    '- 看团队规模',
    '- 需要评估耦合度',
    '',
    '## 置信度', 'high', '',
    '## 未解决', '- 无',
  ].join('\n')
  const once = validateCriteria(brief, { confidence: 'high' })
  const twice = validateCriteria(once.brief, { confidence: 'high' })
  assert.equal(once.downgraded, true)
  assert.equal(twice.downgraded, false)
  assert.equal(twice.brief, once.brief)
  assert.match(twice.brief, /^## 置信度\nmedium$/m)
  assert.equal(twice.brief.match(/判据偏软：/g).length, 1)
})

test('validateCriteria reads Chinese thresholds and magnitudes as decidable (1.1.0)', () => {
  const lines = [
    '- 每周发布 3 次以上才拆分',
    '- 团队八人以上才值得拆',
    '- 发布频率两倍于同行时',
    '- 每天至少两次故障',
    '- P99 延迟 > 200ms',
    '- 每月 2 次回滚算多',
  ]
  for (const line of lines) {
    const report = validateCriteria(`## 判据\n${line}\n`, { confidence: 'high' })
    assert.equal(report.weak, 0, line)
    assert.ok(!report.brief.includes('（推断）'), line)
  }
})

test('buildResult delivers the lowered verdict and a matching 置信度 section (1.1.0)', () => {
  const result = buildResult({
    brief: [
      '## 结论', '不该拆 [S1]。', '',
      '## 判据',
      '- 团队规模要够大',
      '- 需要评估耦合度',
      '- 回滚成本 > 2 人日时不宜拆',
      '',
      '## 置信度', 'high',
    ].join('\n'),
    sources: [], confidence: 'high', gaps: [], partial: false, depth: 'quick',
    stats: { questionKind: 'decision', queries: 1, pagesFetched: 1, llmRounds: 1, elapsedMs: 5 },
  })
  assert.equal(result.confidence, 'medium')
  assert.match(result.brief, /^## 置信度\nmedium$/m)
  assert.match(result.brief, /^- 团队规模要够大（推断）$/m)
  assert.match(result.brief, /^## 未解决\n- 判据偏软：2\/3 条缺少可量化阈值，结论按证据强度下调$/m)
})
