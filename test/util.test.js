import test from 'node:test'
import assert from 'node:assert/strict'
import {
  Budget, BudgetExceeded, configureDomainTrust, decodeEntities, dedupeHits, domainTrust,
  evidenceAgeDays, htmlToText, isBlockedDomain, isOfficialDomain, jaccard, jsonSafe, normalizeUrl,
  parseLooseJson, rankHits, truncate, canonicalKey, extractUrls, looksStale,
} from '../lib/util.js'

test('vendor documentation and price pages count as official sources (0.6.3)', () => {
  const official = [
    'https://docs.spring.io/spring-boot/3.4/reference/',
    'https://spring.io/projects/spring-boot',
    'https://help.aliyun.com/zh/model-studio/models',
    'https://bigmodel.cn/pricing',
    'https://www.volcengine.com/docs/82379/1099320',
    'https://api-docs.deepseek.com/quick_start/pricing',
    'https://react.dev/learn',
    'https://nodejs.org/en/about/previous-releases',
  ]
  for (const url of official) assert.equal(isOfficialDomain(url), true, url)
  // A repo/forum page about a vendor is not the vendor's own docs.
  assert.equal(isOfficialDomain('https://github.com/nodejs/node'), false)
  assert.equal(isOfficialDomain('https://example.com/pricing'), false)
})

test('evidenceAgeDays counts days for a parseable date, null otherwise', () => {
  const now = Date.parse('2026-01-31T00:00:00Z')
  assert.equal(evidenceAgeDays('2026-01-01T00:00:00Z', now), 30)
  assert.equal(evidenceAgeDays('not a date', now), null)
  assert.equal(evidenceAgeDays('', now), null)
  assert.equal(evidenceAgeDays(undefined, now), null)
})

test('extractUrls pulls pasted URLs out of prose and strips trailing punctuation', () => {
  assert.deepEqual(
    extractUrls('按 https://example.com/pricing?v=2 这页的定价，以及（https://a.com/x）哪个更便宜？'),
    ['https://example.com/pricing?v=2', 'https://a.com/x'],
  )
  assert.deepEqual(extractUrls('没有链接的问题'), [])
  assert.deepEqual(extractUrls('重复 https://a.com https://a.com 去重'), ['https://a.com'])
})

test('normalizeUrl strips tracking, fragment and trailing slash', () => {
  assert.equal(
    normalizeUrl('https://WWW.Example.com/a/b/?utm_source=x&id=3#frag'),
    'https://example.com/a/b?id=3',
  )
  assert.equal(normalizeUrl('//example.com/x/'), 'https://example.com/x')
  assert.equal(normalizeUrl('not a url'), 'not a url')
})

test('dedupeHits merges engines and near-identical titles', () => {
  const hits = [
    { url: 'https://a.com/x?utm_source=1', title: 'Node package managers compared', engine: 'ctx-web' },
    { url: 'https://a.com/x', title: 'Other title', engine: 'ddg-html' },
    { url: 'https://b.com/y', title: 'Node package managers compared (2026)', engine: 'brave' },
    { url: 'https://c.com/z', title: 'Completely different topic', engine: 'serper' },
  ]
  const kept = dedupeHits(hits)
  assert.equal(kept.length, 2)
  assert.equal(kept[0].engines.size, 3)
})

test('looksStale reads the wording a source uses about itself (0.6.5)', () => {
  for (const text of [
    '本项目已过期，不再维护',
    'This repository is ARCHIVED',
    'Deprecated API — no longer maintained',
    '该库停止维护，已归档',
  ]) assert.equal(looksStale(text), true, text)

  for (const text of [
    'Node 22 LTS release notes',
    'Spring Boot reference documentation',
    'Pricing update for 2026',
    '',
  ]) assert.equal(looksStale(text), false, text)
})

test('rankHits demotes a source that says it is retired (0.6.5)', () => {
  const hits = dedupeHits([
    { url: 'https://github.com/org/old', title: '本项目已过期，不再维护', engine: 'github', publishedAt: '2016-01-01' },
    { url: 'https://github.com/org/new', title: 'Active project', engine: 'github', publishedAt: '2016-01-01' },
  ])
  const ranked = rankHits(hits, { question: 'spring boot configuration' })
  // Demoted, not dropped: the stale repo is still evidence-eligible when alone.
  assert.equal(ranked.length, 2)
  assert.ok(ranked[0].url.endsWith('/org/new'), ranked.map((hit) => hit.url).join(' | '))
  assert.ok(ranked[1].url.endsWith('/org/old'))
})

test('rankHits prefers trusted domains and engine consensus', () => {
  const hits = dedupeHits([
    { url: 'https://github.com/org/repo', title: 'repo', engine: 'ctx-web' },
    { url: 'https://spam-farm.example/post', title: 'cheap content', engine: 'ctx-web' },
    { url: 'https://nodejs.org/docs', title: 'docs', engine: 'ctx-web' },
    { url: 'https://nodejs.org/docs', title: 'docs', engine: 'ddg-html' },
  ])
  const ranked = rankHits(hits, { question: 'node docs' })
  assert.ok(domainTrust(ranked[0].url) >= 2)
})

test('rankHits boosts are additive and leave the default order untouched', () => {
  const hits = dedupeHits([
    { url: 'https://example.com/a', title: 'Node 22 release notes', engine: 'ctx-web' },
    { url: 'https://github.com/nodejs/node', title: 'Node 22 repository', engine: 'ctx-web' },
    { url: 'https://news.ycombinator.com/item?id=1', title: 'Node 22 discussion', engine: 'ctx-web' },
    { url: 'https://www.nist.gov/report', title: 'Node 22 security report', engine: 'ctx-web' },
  ])
  const urls = (list) => list.map((hit) => hit.url)
  const plain = rankHits(hits, { question: 'node 22' })
  // undefined boosts is the historical ranking: no hidden extra term.
  assert.deepEqual(urls(rankHits(hits, { question: 'node 22', boosts: undefined })), urls(plain))
  assert.deepEqual(urls(rankHits(hits, { question: 'node 22', boosts: {} })), urls(plain))
  // A domain boost lifts a normally-low hit to the top.
  assert.equal(
    rankHits(hits, { question: 'node 22', boosts: { domains: { 'news.ycombinator.com': 9 } } })[0].url,
    'https://news.ycombinator.com/item?id=1',
  )
  // Same for the official-domain term; unknown engine names are ignored.
  assert.ok(rankHits(hits, { question: 'node 22', boosts: { official: 9 } })[0].url.endsWith('nist.gov/report'))
  assert.deepEqual(
    urls(rankHits(hits, { question: 'node 22', boosts: { engines: { nope: 9 }, official: 0 } })),
    urls(plain),
  )
})

test('parseLooseJson survives fences, prose and trailing commas', () => {
  assert.deepEqual(parseLooseJson('```json\n{"a":1,}\n```'), { a: 1 })
  assert.deepEqual(parseLooseJson('好的，结果如下：\n{"a":[1,2],}'), { a: [1, 2] })
  assert.equal(parseLooseJson('no json here'), null)
  assert.deepEqual(parseLooseJson("{'a': 'b'}"), { a: 'b' })
})

test('htmlToText drops markup and keeps paragraphs', () => {
  const text = htmlToText('<html><script>x()</script><body><h1>标题</h1><p>第一段</p><p>第二段</p></body></html>')
  assert.match(text, /标题/)
  assert.match(text, /第一段/)
  assert.doesNotMatch(text, /x\(\)/)
  assert.equal(decodeEntities('a &amp; b &#x4e2d;'), 'a & b 中')
})

test('Budget enforces limits and reports usage', () => {
  const budget = new Budget({ queries: 2, pages: 1 })
  budget.take('queries', 2)
  assert.throws(() => budget.take('queries'), BudgetExceeded)
  assert.equal(budget.remaining('pages'), 1)
  budget.take('pages')
  assert.equal(budget.remaining('pages'), 0)
})

test('jaccard and truncate behave', () => {
  assert.equal(jaccard('hello world', 'hello world'), 1)
  assert.equal(jaccard('hello world', 'foo bar'), 0)
  assert.equal(truncate('abcdef', 4).length, 4)
})

test('jsonSafe makes values survive a JSON round-trip', () => {
  const input = {
    brief: 'ok',
    confidence: undefined,
    sources: [{ id: 'S1', url: 'https://a.com', domain: undefined, publishedAt: undefined }],
    gaps: undefined,
    partial: false,
    stats: { elapsedMs: 12, score: Number.NaN },
    when: new Date('2026-01-09T00:00:00Z'),
    big: 10n,
    list: [1, undefined, Number.POSITIVE_INFINITY],
  }
  const safe = jsonSafe(input)
  assert.deepEqual(safe, JSON.parse(JSON.stringify(safe)))
  assert.equal('confidence' in safe, false)
  assert.equal('domain' in safe.sources[0], false)
  assert.equal(safe.stats.score, null)
  assert.equal(safe.list.length, 3)
  assert.equal(safe.list[1], null)
  assert.equal(safe.when, '2026-01-09T00:00:00.000Z')
  assert.equal(safe.big, '10')

  const circular = { name: 'loop' }
  circular.self = circular
  assert.equal(jsonSafe(circular).self, '[circular]')
})

test('canonicalKey collapses translations, mirrors and CDN copies', () => {
  assert.equal(
    canonicalKey('https://nodejs.org/fr/about/previous-releases'),
    canonicalKey('https://nodejs.org/en/about/previous-releases'),
  )
  assert.equal(
    canonicalKey('https://url.nodejs.cn/zh-cn/about/previous-releases'),
    canonicalKey('https://nodejs.org/about/previous-releases'),
  )
  assert.equal(
    canonicalKey('https://cdn.jsdelivr.net/gh/nodejs/Release@main/README.md'),
    canonicalKey('https://github.com/nodejs/Release/blob/main/README.md'),
  )
  assert.equal(
    canonicalKey('https://github.com/nodejs/Release/blob/1ec6209/README.md'),
    canonicalKey('https://github.com/nodejs/Release/blob/main/README.md'),
  )
  assert.equal(
    canonicalKey('https://developers.wpengine.com/docs/configuring-builds.md'),
    canonicalKey('https://developers.wpengine.com/docs/configuring-builds'),
  )
  assert.notEqual(
    canonicalKey('https://github.com/nodejs/Release/blob/main/README.md'),
    canonicalKey('https://github.com/nodejs/nodejs.org/blob/main/README.md'),
  )
})

test('canonicalKey folds EU language prefixes of europa.eu pages', () => {
  assert.equal(
    canonicalKey('https://digital-strategy.ec.europa.eu/bg/policies/cra-conformity-assessment'),
    canonicalKey('https://digital-strategy.ec.europa.eu/en/policies/cra-conformity-assessment'),
  )
})

test('rankHits prefers the EUR-Lex act over its summary/search pages and demotes landing pages', () => {
  const hits = [
    { url: 'https://eur-lex.europa.eu/EN/legal-content/summary/horizontal-cybersecurity-requirements.html', title: 'CRA summary', engine: 'tavily', rank: 1 },
    { url: 'https://eur-lex.europa.eu/eli/reg/2024/2847/oj', title: 'Regulation (EU) 2024/2847', engine: 'tavily', rank: 2 },
    { url: 'https://commission.europa.eu/index_en', title: 'European Commission', engine: 'tavily', rank: 3 },
    { url: 'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32024R2847', title: 'CRA full text', engine: 'tavily', rank: 4 },
  ]
  const ranked = rankHits(hits, { question: 'CRA self-assessment duties' })
  assert.match(ranked[0].url, /\/eli\/reg\/2024\/2847\/oj$/)
  const eliIndex = ranked.findIndex((hit) => /\/eli\//.test(hit.url))
  const summaryIndex = ranked.findIndex((hit) => /legal-content\/summary/.test(hit.url))
  const landingIndex = ranked.findIndex((hit) => /index_en/.test(hit.url))
  assert.ok(eliIndex < summaryIndex, ranked.map((hit) => hit.url).join(' | '))
  assert.ok(summaryIndex < landingIndex, ranked.map((hit) => hit.url).join(' | '))
})