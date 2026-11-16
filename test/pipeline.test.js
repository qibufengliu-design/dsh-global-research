import test from 'node:test'
import assert from 'node:assert/strict'
import { runResearch, groupEvidence, looksLikeFollowUp, extractEvidence, pickDocBases, compareOptions, countOptionHits, evidenceSiteKey, officialBackstopQueries, PRICING_HOSTS, PRICING_SEEDS, pricingHostFor, pricingHostOfUrl, pricingSeedFor, hasPricingSeedText, pricingTargetQueries, isPricingEvidencePage, isPricingScenario } from '../lib/pipeline.js'
import { downgradeConfidence, gradeSource, appendReferences, formatRetrievalFlow } from '../lib/brief.js'
import { resolveStrategy } from '../lib/strategy.js'
import { dedupeHits, rankHits } from '../lib/util.js'

const selection = { provider: 'test', model: 'test-model' }

function fakeLlm(responder) {
  return {
    stream(options) {
      const user = options.messages?.[0]?.content?.[0]?.text ?? ''
      const text = responder({ ...options, user })
      return (async function* emit() {
        yield { type: 'text-delta', text }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
}

/**
 * 0.9.5 — an awaiting variant of fakeLlm, so a test can hold one evidence call
 * in flight while another starts (the parallel-extraction regression test).
 * The sync helper above stays exactly as it was: most tests rely on a responder
 * that returns a string immediately.
 */
function asyncFakeLlm(responder) {
  return {
    stream(options) {
      const user = options.messages?.[0]?.content?.[0]?.text ?? ''
      return (async function* emit() {
        const text = await responder({ ...options, user })
        yield { type: 'text-delta', text }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
}

function analysisReply() {
  return JSON.stringify({
    subQuestions: [{ q: 'Node LTS 版本有哪些？', why: '确定基线', evidence: 'docs' }],
    constraints: ['需要长期支持'],
    criteria: ['稳定性'],
    language: 'zh',
  })
}

function evidenceReply() {
  return JSON.stringify([
    { claim: 'Node 22 是当前 LTS 版本', quote: 'Node 22 entered LTS in October 2025.', source: 0, type: 'docs', stance: 'support' },
    { claim: 'Node 22 是当前 LTS 版本', quote: 'Node 22 is the active LTS line.', source: 1, type: 'docs', stance: 'support' },
  ])
}

function synthReply() {
  return [
    '## 结论',
    '**一句话：选 Node 22 LTS**，它到 2027-04 仍在支持期内 [S1][S2]。',
    '',
    '## 依据',
    '- 官方发布说明确认 [S1]',
    '- 文档页确认 [S2]',
    '',
    '## 方案对比',
    '不适用',
    '',
    '## 行动清单',
    '- 跑 nvm install 22 并在 package.json 锁定 engines',
    '- 在 CI 加一条 Node 22 冒烟任务',
    '- 2027-04 前把升级窗口排进迭代',
    '',
    '## 坑与风险',
    '未发现',
    '',
    '## 置信度',
    'high',
    '',
    '## 未解决',
    '无。',
  ].join('\n')
}

function defaultResponder(options) {
  const prompt = options.user ?? ''
  if (prompt.includes('<untrusted>')) return evidenceReply()
  if (prompt.includes('拆解')) return analysisReply()
  if (prompt.includes('缺口')) return JSON.stringify({ queries: [], reason: '无' })
  if (prompt.includes('研究简报')) return synthReply()
  return '{}'
}

const FAKE_TITLES = [
  'Node LTS release notes',
  'Node LTS official documentation',
  'Node LTS community discussion',
]

function fakeEngine(urls, titles = FAKE_TITLES) {
  return {
    name: 'fake',
    available: () => true,
    search: async () => urls.map((url, index) => ({
      url, title: titles[index % titles.length], snippet: 'snippet', engine: 'fake', rank: index + 1,
    })),
  }
}

function fakeFetcher(record = []) {
  return async (url) => {
    record.push(url)
    return {
      url, finalUrl: url, title: `page ${url}`, domain: new URL(url).hostname,
      text: `Node 22 entered LTS in October 2025. Node 22 is the active LTS line and keeps receiving security fixes until April 2027; after that it moves to maintenance. A team picking a runtime for a new backend service should weigh that remaining window against its upgrade cadence. Source: ${url}`,
      ok: true,
    }
  }
}

function baseConfig(extra = {}) {
  return {
    maxDeepPerSession: 3,
    ...extra,
    __engines: [fakeEngine(['https://nodejs.org/1', 'https://github.com/x/y', 'https://a.com/3'])],
    __fetchPage: fakeFetcher(),
  }
}

test('standard run produces a cited brief and stops at page budget', async () => {
  const fetched = []
  const config = baseConfig({ __fetchPage: fakeFetcher(fetched) })
  const result = await runResearch({
    question: 'Node 22 是 LTS 吗？项目该用哪个版本',
    depth: 'standard',
    config,
    llm: fakeLlm(defaultResponder),
    selection,
    logger: () => {},
  })
  assert.equal(result.partial, false)
  assert.equal(result.depthUsed, 'standard')
  assert.ok(['high', 'medium'].includes(result.confidence))
  assert.ok(result.sources.length >= 2)
  assert.match(result.brief, /## 参考/)
  assert.match(result.brief, /\[S1\]/)
  assert.ok(fetched.length <= 12)
  assert.ok(result.stats.queries <= 6)
})

test('run records integer per-stage timings and keeps fast runs out of the brief', async () => {
  const result = await runResearch({
    question: 'Node 22 是 LTS 吗？项目该用哪个版本',
    depth: 'standard',
    config: baseConfig(),
    llm: fakeLlm(defaultResponder),
    selection,
    logger: () => {},
  })
  const timings = result.stats.timings
  assert.ok(timings && typeof timings === 'object')
  let total = 0
  for (const key of ['analyze', 'search', 'read', 'evidence', 'gap', 'synth']) {
    assert.equal(typeof timings[key], 'number', `${key} must be a number`)
    assert.ok(Number.isInteger(timings[key]) && timings[key] >= 0, `${key} must be a non-negative integer`)
    total += timings[key]
  }
  // Every millisecond of the run belongs to at most one stage, never more.
  assert.ok(total <= result.stats.elapsedMs + 50, `stage total ${total}ms exceeds elapsed ${result.stats.elapsedMs}ms`)
  // The fake pipeline never spends >0.5s in any stage, so no 阶段 suffix appears.
  assert.doesNotMatch(result.brief, /· 阶段 /)
})

test('a Stack Overflow answer is read from the API when the page itself is blocked', async () => {
  const body = `Use use() with a Promise kept stable across renders. ${'A cached promise lets React suspend once and reuse the same request. '.repeat(6)}`
  const fetchRaw = async (url) => {
    if (url.includes('api.stackexchange.com')) {
      return {
        status: 200,
        body: JSON.stringify({ items: [{ link: 'https://stackoverflow.com/questions/1/react-use', title: 'React 19 use() with promises', tags: ['react'], score: 7, body, creation_date: 1760000000 }] }),
      }
    }
    return { status: 404, body: '' }
  }
  const config = {
    ...baseConfig(),
    __fetchRaw: fetchRaw,
    // Keep this test focused on the Stack Overflow API fallback: the docs
    // vertical would otherwise outrank stackexchange for a React question.
    verticals: { docs: false },
    __engines: [{ name: 'fake', available: () => true, search: async () => [] }],
    __fetchPage: async () => ({ ok: false, reason: 'HTTP 403' }),
  }
  const result = await runResearch({
    question: 'pnpm 安装 react 依赖报错，React 19 use() 数据获取怎么写？',
    depth: 'quick',
    config,
    llm: fakeLlm(defaultResponder),
    selection,
    logger: () => {},
  })
  assert.ok(result.stats.verticalHits >= 1)
  assert.ok(result.stats.pagesFetched >= 1)
  assert.ok(result.sources.some((source) => source.url.includes('stackoverflow.com')))
})

test('planned queries (English / official-site) run before the deterministic templates', async () => {
  const seen = []
  const engine = {
    name: 'fake',
    available: () => true,
    search: async (query) => {
      seen.push(query)
      return [{ url: 'https://europa.eu/cra', title: 'CRA regulation', snippet: 'CRA applies from 2027', engine: 'fake', rank: 1 }]
    },
  }
  const config = { ...baseConfig(), __engines: [engine] }
  const responder = (options) => {
    if ((options.user ?? '').includes('检索计划')) {
      return JSON.stringify({ queries: ['Cyber Resilience Act regulation site:europa.eu', 'CRA reporting obligations ENISA'] })
    }
    return defaultResponder(options)
  }
  await runResearch({
    question: '欧盟 CRA 对我们的合规义务是什么？',
    depth: 'standard',
    config,
    llm: fakeLlm(responder),
    selection,
    logger: () => {},
  })
  assert.equal(seen[0], 'Cyber Resilience Act regulation site:europa.eu')
  assert.ok(seen.includes('CRA reporting obligations ENISA'))
})

test('a URL pasted into the question is fetched directly even when it is not an official domain', async () => {
  const fetched = []
  const config = baseConfig()
  config.__fetchPage = async (url) => {
    fetched.push(url)
    return {
      url, finalUrl: url, title: `page ${url}`, domain: new URL(url).hostname,
      text: `Node 22 entered LTS in October 2025. Node 22 is the active LTS line and keeps receiving security fixes until April 2027. Source: ${url}`,
      links: [],
      ok: true,
    }
  }
  const result = await runResearch({
    question: '按 https://example.com/pricing 这页的定价，Node 22 的商用支持值得买吗',
    depth: 'quick',
    config,
    llm: fakeLlm(defaultResponder),
    selection,
    logger: () => {},
  })
  assert.equal(fetched[0], 'https://example.com/pricing')
  assert.ok(result.stats.directUrls >= 1)
  assert.ok(result.sources.some((source) => source.url.includes('example.com/pricing')))
})

test('planner-provided official URLs are fetched, mined for the legal text, and cited', async () => {
  const fetched = []
  const config = baseConfig()
  config.__fetchPage = async (url) => {
    fetched.push(url)
    return {
      url, finalUrl: url, title: `page ${url}`, domain: new URL(url).hostname,
      text: `Node 22 entered LTS in October 2025. Node 22 is the active LTS line and keeps receiving security fixes until April 2027. Source: ${url}`,
      links: url.includes('digital-strategy') ? ['https://eur-lex.europa.eu/eli/reg/2024/2847/oj'] : [],
      ok: true,
    }
  }
  const responder = (options) => {
    if ((options.user ?? '').includes('检索计划')) {
      return JSON.stringify({
        queries: ['Cyber Resilience Act official text'],
        directUrls: ['https://digital-strategy.ec.europa.eu/en/policies/cyber-resilience-act'],
      })
    }
    return defaultResponder(options)
  }
  const result = await runResearch({
    question: '欧盟 CRA 的官方文本规定是什么？该做什么',
    depth: 'standard',
    config,
    llm: fakeLlm(responder),
    selection,
    logger: () => {},
  })
  assert.ok(fetched.some((url) => url.includes('digital-strategy.ec.europa.eu')))
  assert.ok(fetched.some((url) => url.includes('eur-lex.europa.eu/eli/reg/2024/2847/oj')))
  assert.ok(result.sources.some((source) => source.url.includes('eur-lex.europa.eu')))
})

test('official links cited by secondary articles are followed without planner URLs', async () => {
  const fetched = []
  const config = baseConfig()
  config.__fetchPage = async (url) => {
    fetched.push(url)
    return {
      url, finalUrl: url, title: `page ${url}`, domain: new URL(url).hostname,
      text: `Node 22 entered LTS in October 2025. Node 22 is the active LTS line and keeps receiving security fixes until April 2027. Source: ${url}`,
      links: url.includes('lawfirm')
        ? ['https://eur-lex.europa.eu/eli/reg/2024/2847/oj', 'https://example.com/other']
        : [],
      ok: true,
    }
  }
  config.__engines = [fakeEngine(['https://lawfirm.example/post', 'https://a.com/2', 'https://b.com/3'])]
  const responder = (options) => {
    if ((options.user ?? '').includes('检索计划')) return JSON.stringify({ queries: ['Cyber Resilience Act 合规义务'] })
    return defaultResponder(options)
  }
  const result = await runResearch({
    question: '欧盟 CRA 的官方文本规定是什么？该做什么',
    depth: 'standard',
    config,
    llm: fakeLlm(responder),
    selection,
    logger: () => {},
  })
  assert.ok(fetched.some((url) => url.includes('eur-lex.europa.eu/eli/reg/2024/2847/oj')))
  assert.ok(result.sources.some((source) => source.url.includes('eur-lex.europa.eu')))
  assert.ok(!fetched.some((url) => url.includes('example.com/other')))
})

test('gap refill adds an official-domain query when no primary source exists', async () => {
  const queries = []
  const config = baseConfig()
  config.__engines = [{
    name: 'spy',
    available: () => true,
    search: async (query) => {
      queries.push(query)
      return [{ url: `https://site.example/${queries.length}`, title: `Node LTS ${queries.length}`, snippet: 'Node 22 entered LTS', engine: 'spy', rank: 1 }]
    },
  }]
  config.__fetchPage = fakeFetcher()
  const responder = (options) => {
    const prompt = options.user ?? ''
    if (prompt.includes('拆解')) {
      return JSON.stringify({
        subQuestions: [{ q: 'CRA 规定的自我评估义务有哪些？', why: '确定义务', evidence: '法规原文' }],
        constraints: ['需要一手法规'], criteria: ['合规性'], language: 'zh',
      })
    }
    if (prompt.includes('缺口')) return JSON.stringify({ queries: ['CRA self-assessment obligations'], reason: '缺一手文本' })
    return defaultResponder(options)
  }
  const result = await runResearch({
    question: '欧盟 CRA 对自我评估有哪些义务？',
    depth: 'standard',
    config,
    llm: fakeLlm(responder),
    selection,
    logger: () => {},
  })
  assert.ok(queries.some((query) => query.startsWith('site:eur-lex.europa.eu')), queries.join(' | '))
  assert.equal(result.partial, false)
})

test('a legal question still hunts for the legal text when only a policy page was found', async () => {
  const queries = []
  const config = baseConfig()
  config.__engines = [{
    name: 'spy',
    available: () => true,
    search: async (query) => {
      queries.push(query)
      return [{ url: 'https://digital-strategy.ec.europa.eu/en/policies/cyber-resilience-act', title: 'CRA policy page', snippet: 'policy', engine: 'spy', rank: 1 }]
    },
  }]
  config.__fetchPage = fakeFetcher()
  const responder = (options) => {
    const prompt = options.user ?? ''
    if (prompt.includes('拆解')) {
      return JSON.stringify({
        subQuestions: [{ q: 'CRA 规定的自我评估义务有哪些？', why: '确定义务', evidence: '法规原文' }],
        constraints: ['需要一手法规'], criteria: ['合规性'], language: 'zh',
      })
    }
    if (prompt.includes('缺口')) return JSON.stringify({ queries: ['CRA self-assessment obligations'], reason: '缺法规原文' })
    return defaultResponder(options)
  }
  await runResearch({
    question: '欧盟 CRA 对自我评估有哪些义务？',
    depth: 'standard',
    config,
    llm: fakeLlm(responder),
    selection,
    logger: () => {},
  })
  assert.ok(queries.some((query) => query.startsWith('site:eur-lex.europa.eu')), queries.join(' | '))
})

test('legal refill keeps page slots for the act when the planner already used direct URLs', async () => {
  const fetched = []
  const titles = [
    'Manufacturer duties under the CRA',
    'Technical documentation ten years',
    'Conformity assessment routes',
    'Reporting obligations explained',
    'Open source steward rules',
    'Penalties and market surveillance',
    'Harmonised standards status',
    'Notified body involvement',
    'Software bill of materials',
    'Vulnerability handling duties',
  ]
  const config = baseConfig()
  config.__engines = [{
    name: 'spy',
    available: () => true,
    search: async (query) => {
      const urls = query.startsWith('site:eur-lex')
        ? ['https://eur-lex.europa.eu/eli/reg/2024/2847/oj']
        : Array.from({ length: 10 }, (_, i) => `https://site${i}.example/post`)
      return urls.map((url, index) => ({
        url,
        title: url.includes('eur-lex') ? 'Regulation (EU) 2024/2847 — EUR-Lex' : titles[index % titles.length],
        snippet: 'snippet', engine: 'spy', rank: index + 1,
      }))
    },
  }]
  config.__fetchPage = async (url) => {
    fetched.push(url)
    return {
      url, finalUrl: url, title: `page ${url}`, domain: new URL(url).hostname, ok: true,
      text: 'The CRA requires manufacturers to perform a self-assessment under Article 13 and to keep the technical documentation for ten years after placing the product on the market. Article 13 obligations apply from 2027-12-11.',
    }
  }
  const responder = (options) => {
    const prompt = options.user ?? ''
    if (prompt.includes('检索计划')) {
      return JSON.stringify({
        queries: ['Cyber Resilience Act official text'],
        directUrls: ['https://digital-strategy.ec.europa.eu/en/policies/cyber-resilience-act'],
      })
    }
    if (prompt.includes('缺口')) return JSON.stringify({ queries: ['Cyber Resilience Act self-assessment obligations'], reason: '缺法规原文' })
    return defaultResponder(options)
  }
  await runResearch({
    question: '欧盟 CRA 对制造商的自我评估义务有哪些？',
    depth: 'standard',
    config,
    llm: fakeLlm(responder),
    selection,
    logger: () => {},
  })
  assert.ok(
    fetched.includes('https://eur-lex.europa.eu/eli/reg/2024/2847/oj'),
    `refill never fetched the act: ${fetched.join(' | ')}`,
  )
})

test('gap refill stops at the page budget instead of throwing', async () => {
  const urls = Array.from({ length: 15 }, (_, i) => `https://site${i}.example/post`)
  const config = baseConfig()
  config.__engines = [fakeEngine(urls)]
  const responder = (options) => {
    if ((options.user ?? '').includes('检索计划')) {
      return JSON.stringify({
        queries: ['Cyber Resilience Act official text'],
        directUrls: ['https://digital-strategy.ec.europa.eu/en/policies/cyber-resilience-act'],
      })
    }
    if ((options.user ?? '').includes('缺口')) return JSON.stringify({ queries: ['CRA 补充问题'], reason: '缺一手文本' })
    return defaultResponder(options)
  }
  const result = await runResearch({
    question: '欧盟 CRA 的官方文本规定是什么？该做什么',
    depth: 'standard',
    config,
    llm: fakeLlm(responder),
    selection,
    logger: () => {},
  })
  assert.equal(result.partial, false)
  assert.ok(result.stats.pagesFetched <= 12)
})

test('unreadable pages do not let link mining or refill exceed the page budget', async () => {
  const urls = Array.from({ length: 15 }, (_, i) => `https://site${i}.example/post`)
  const config = baseConfig()
  config.__engines = [fakeEngine(urls)]
  config.__fetchPage = async (url) => {
    if (url.includes('site')) return { url, ok: false, reason: 'blocked' }
    return {
      url, finalUrl: url, title: `page ${url}`, domain: new URL(url).hostname,
      text: `Node 22 entered LTS in October 2025. Node 22 is the active LTS line and keeps receiving security fixes until April 2027. Source: ${url}`,
      links: url.includes('digital-strategy') ? ['https://eur-lex.europa.eu/eli/reg/2024/2847/oj'] : [],
      ok: true,
    }
  }
  const responder = (options) => {
    if ((options.user ?? '').includes('检索计划')) {
      return JSON.stringify({
        queries: ['Cyber Resilience Act official text'],
        directUrls: ['https://digital-strategy.ec.europa.eu/en/policies/cyber-resilience-act'],
      })
    }
    if ((options.user ?? '').includes('缺口')) return JSON.stringify({ queries: ['CRA 补充问题'], reason: '缺一手文本' })
    return defaultResponder(options)
  }
  const result = await runResearch({
    question: '欧盟 CRA 的官方文本规定是什么？该做什么',
    depth: 'standard',
    config,
    llm: fakeLlm(responder),
    selection,
    logger: () => {},
  })
  assert.ok(['high', 'medium', 'low'].includes(result.confidence))
  assert.ok(result.stats.pagesFetched <= 12)
})

test('a transient empty synthesis is retried instead of degrading to the fallback', async () => {
  let synthCalls = 0
  const responder = (options) => {
    if ((options.user ?? '').includes('研究简报')) {
      synthCalls += 1
      return synthCalls === 1 ? '' : synthReply()
    }
    return defaultResponder(options)
  }
  const config = baseConfig()
  const result = await runResearch({
    question: 'Node 22 还支持多久？',
    depth: 'quick',
    config,
    llm: fakeLlm(responder),
    selection,
    logger: () => {},
  })
  assert.equal(synthCalls, 2)
  assert.match(result.brief, /## 方案对比/)
  assert.doesNotMatch(result.brief, /自动汇总/)
})

test('a brief that stops mid-sentence is retried with more room', async () => {
  let synthCalls = 0
  const responder = (options) => {
    if ((options.user ?? '').includes('研究简报')) {
      synthCalls += 1
      if (synthCalls === 1) return `${'## 结论\nNode 22 的官方支持截止日期是 2027-04-30，因此' + '很长的前缀'.repeat(60)}，团队在规划升级窗口时`
      return synthReply()
    }
    return defaultResponder(options)
  }
  const result = await runResearch({
    question: 'Node 22 还支持多久？',
    depth: 'quick',
    config: baseConfig(),
    llm: fakeLlm(responder),
    selection,
    logger: () => {},
  })
  assert.equal(synthCalls, 2)
  assert.doesNotMatch(result.brief, /团队在规划升级窗口时\s*$/)
})

test('unreadable sources are named in the gaps, not silently dropped', async () => {
  const config = baseConfig()
  config.__fetchPage = async (url) => ({
    url, ok: false, reason: url.includes('nodejs') ? 'HTTP 403; web.fetch timeout' : 'HTTP 419',
  })
  const result = await runResearch({
    question: 'Node 22 是 LTS 吗？',
    depth: 'quick',
    config,
    llm: fakeLlm(defaultResponder),
    selection,
    logger: () => {},
  })
  assert.ok(result.gaps.some((gap) => /抓取失败：nodejs\.org/.test(gap)))
})

test('elliptical follow-ups are flagged instead of silently answered', () => {
  assert.equal(looksLikeFollowUp('上面第 2 条依据展开说说'), true)
  assert.equal(looksLikeFollowUp('把它再展开一下'), true)
  assert.equal(looksLikeFollowUp('Node 22 的 EOL 是哪天？'), false)
})

test('elliptical follow-ups with context are grounded instead of flagged', async () => {
  const prompts = []
  const responder = (options) => {
    prompts.push(options.user ?? '')
    return defaultResponder(options)
  }
  const result = await runResearch({
    question: '上面第 2 条展开说说',
    depth: 'quick',
    context: '上一轮结论：Node 22 于 2025-10-21 进入 Maintenance，2027-04-30 EOL。',
    config: baseConfig(),
    llm: fakeLlm(responder),
    selection,
    logger: () => {},
  })
  assert.ok(prompts.some((text) => text.includes('上一轮结论：Node 22 于 2025-10-21')))
  assert.ok(!result.gaps.some((gap) => /省略式追问/.test(gap)))
})

test('elliptical follow-ups without context are flagged', async () => {
  const result = await runResearch({
    question: '上面第 2 条展开说说',
    depth: 'quick',
    config: baseConfig(),
    llm: fakeLlm(defaultResponder),
    selection,
    logger: () => {},
  })
  assert.ok(result.gaps.some((gap) => /省略式追问/.test(gap)))
})

test('second-hand-only evidence downgrades confidence and names the gap', async () => {
  const config = {
    ...baseConfig(),
    __engines: [fakeEngine(['https://a.com/1', 'https://b.com/2', 'https://c.com/3'])],
  }
  const result = await runResearch({
    question: 'Node 22 是 LTS 吗？项目该用哪个版本',
    depth: 'standard',
    config,
    llm: fakeLlm(defaultResponder),
    selection,
    logger: () => {},
  })
  assert.equal(result.confidence, 'low')
  assert.ok(result.gaps.some((gap) => /一手或高质量来源/.test(gap)))
})

test('quick depth caps pages at three', async () => {
  const fetched = []
  const config = baseConfig({ __fetchPage: fakeFetcher(fetched) })
  const result = await runResearch({
    question: 'Node 22 是什么？',
    depth: 'quick',
    config,
    llm: fakeLlm(defaultResponder),
    selection,
    logger: () => {},
  })
  assert.equal(result.depthUsed, 'quick')
  assert.ok(fetched.length <= 3)
  assert.ok(result.stats.queries <= 2)
})

test('zero search results throws instead of fabricating', async () => {
  const config = {
    ...baseConfig(),
    __engines: [{ name: 'dead', available: () => true, search: async () => [] }],
  }
  await assert.rejects(
    () => runResearch({
      question: 'anything', depth: 'quick', config,
      llm: fakeLlm(defaultResponder), selection, logger: () => {},
    }),
    /所有搜索源/,
  )
})

test('stats carry the paid-engine quota counters when the engine list exposes them', async () => {
  const engines = [fakeEngine(['https://nodejs.org/1', 'https://a.com/2'])]
  engines.quota = { tavily: 1, brave: 0, serper: 0, exa: 0 }
  const config = { ...baseConfig(), __engines: engines }
  const result = await runResearch({
    question: 'Node 22 是 LTS 吗', depth: 'quick', config,
    llm: fakeLlm(defaultResponder), selection, logger: () => {},
  })
  assert.deepEqual(result.stats.engineQuota, { tavily: 1, brave: 0, serper: 0, exa: 0 })
})

test('zero evidence returns a partial low-confidence result', async () => {
  const config = {
    ...baseConfig(),
    __fetchPage: async (url) => ({
      url, finalUrl: url, title: url, domain: new URL(url).hostname, text: '', ok: true,
    }),
  }
  const result = await runResearch({
    question: 'unknown thing', depth: 'standard', config,
    llm: fakeLlm(() => '不是 JSON'), selection, logger: () => {},
  })
  assert.equal(result.partial, true)
  assert.equal(result.confidence, 'low')
  assert.ok(result.gaps.length > 0)
})

test('quotes absent from the fetched page are rejected, not cited', async () => {
  const responder = (options) => {
    const prompt = options.user ?? ''
    if (prompt.includes('<untrusted>')) {
      return JSON.stringify([
        { claim: 'Node 22 支持到 2030 年', quote: 'Node 22 is supported until 2030.', source: 0, type: 'docs', stance: 'support' },
      ])
    }
    if (prompt.includes('拆解')) return analysisReply()
    if (prompt.includes('缺口')) return JSON.stringify({ queries: [], reason: '无' })
    if (prompt.includes('研究简报')) return '## 结论\n依据不足 [S1]。'
    return '{}'
  }
  const result = await runResearch({
    question: 'Node 22 是 LTS 吗', depth: 'standard', config: baseConfig(),
    llm: fakeLlm(responder), selection, logger: () => {},
  })
  assert.doesNotMatch(result.brief, /2030/)
  assert.ok(result.sources.length >= 1, 'falls back to the page paragraph instead of the invented quote')
})

test('missing synthesis model degrades to a deterministic brief', async () => {
  const responder = (options) => {
    const prompt = options.user ?? ''
    if (prompt.includes('<untrusted>')) return evidenceReply()
    if (prompt.includes('拆解')) return analysisReply()
    if (prompt.includes('研究简报')) return ''
    return '{}'
  }
  const result = await runResearch({
    question: 'Node 22 是 LTS 吗', depth: 'standard', config: baseConfig(),
    llm: fakeLlm(responder), selection, logger: () => {},
  })
  assert.match(result.brief, /## 结论/)
  assert.match(result.brief, /## 参考/)
  assert.ok(result.gaps.some((gap) => /综合模型不可用/.test(gap)))
})
test('groupEvidence counts separate GitHub repos as independent sites', () => {
  const clusters = groupEvidence([
    { claim: 'Node 22 EOL is 2027-04-30', quote: 'x', url: 'https://github.com/nodejs/Release/blob/main/README.md', domain: 'github.com', stance: 'support' },
    { claim: 'Node 22 EOL is 2027-04-30', quote: 'y', url: 'https://github.com/nodejs/nodejs.org/blob/main/blog/v22.md', domain: 'github.com', stance: 'support' },
  ])
  assert.equal(clusters[0].status, 'confirmed')
})

test('a stale page ranks below a fresh one when the rest of the score is equal', () => {
  const hits = [
    { url: 'https://a.com/official-release-notes', title: 'Node LTS release notes', snippet: 'LTS', engine: 'fake', rank: 1, publishedAt: '2019-01-01' },
    { url: 'https://b.com/official-release-notes', title: 'Node LTS release notes', snippet: 'LTS', engine: 'fake', rank: 1, publishedAt: '2025-06-01' },
  ]
  const ranked = rankHits(hits, { question: 'Node LTS release notes', focus: [], now: Date.parse('2026-01-01T00:00:00Z') })
  assert.deepEqual(ranked.map((hit) => hit.url), ['https://b.com/official-release-notes', 'https://a.com/official-release-notes'])
})

test('disputed evidence becomes an explicit 存在冲突 section before 置信度', async () => {
  const responder = (options) => {
    const prompt = options.user ?? ''
    if (prompt.includes('<untrusted>')) {
      return JSON.stringify([
        { claim: 'Node 22 的维护期到 2027 年', quote: 'Node 22 is the active LTS line', source: 0, type: 'docs', stance: 'support' },
        { claim: 'Node 22 的维护期到 2027 年', quote: 'Node 22 entered LTS in October 2025', source: 1, type: 'docs', stance: 'refute' },
      ])
    }
    return defaultResponder(options)
  }
  const result = await runResearch({
    question: 'Node 22 支持到什么时候', depth: 'quick', config: baseConfig(),
    llm: fakeLlm(responder), selection, logger: () => {},
  })
  assert.match(result.brief, /^## 存在冲突$/m)
  assert.ok(result.conflicts.length >= 2, 'both sides are kept on the result')
  assert.ok(result.brief.indexOf('## 存在冲突') < result.brief.indexOf('## 置信度'))
  assert.match(result.brief, /\[S\d\][^\n]*nodejs\.org/)
  assert.match(result.brief, /（支持）/)
  assert.match(result.brief, /（反驳）/)
})

test('no strategy pack and the concept pack produce the same result', async () => {
  // The concept pack is the identity element: resolveStrategy(concept) deep-
  // equals STRATEGY_DEFAULTS, so passing it must not change one byte of output.
  const run = (strategy) => runResearch({
    question: '什么是 JavaScript 事件循环',
    depth: 'standard',
    config: baseConfig(),
    llm: fakeLlm(defaultResponder),
    selection,
    logger: () => {},
    ...(strategy ? { strategy } : {}),
  })
  const legacy = await run()
  const concept = await run(resolveStrategy({ questionKind: 'concept', depth: 'standard' }))
  assert.equal(concept.brief, legacy.brief)
  assert.equal(concept.confidence, legacy.confidence)
  assert.deepEqual(concept.gaps, legacy.gaps)
  assert.deepEqual(concept.sources.map((source) => source.url), legacy.sources.map((source) => source.url))
  assert.equal(concept.depthUsed, legacy.depthUsed)
  assert.equal(concept.stats.queries, legacy.stats.queries)
})

test('a declared missing section gets a placeholder and costs one confidence notch', async () => {
  const concept = resolveStrategy({ questionKind: 'concept', depth: 'standard' })
  const pack = { ...concept, brief: { requiredSections: ['## 迁移成本'] } }
  const run = (strategy) => runResearch({
    question: '什么是 JavaScript 事件循环',
    depth: 'standard',
    config: baseConfig(),
    llm: fakeLlm(defaultResponder),
    selection,
    logger: () => {},
    ...(strategy ? { strategy } : {}),
  })
  const base = await run()
  const declared = await run(pack)
  assert.doesNotMatch(base.brief, /## 迁移成本/)
  assert.ok(declared.brief.includes('## 迁移成本\n- 不适用'), declared.brief)
  assert.ok(declared.brief.indexOf('## 迁移成本') < declared.brief.indexOf('## 置信度'))
  assert.equal(declared.confidence, downgradeConfidence(base.confidence))
  assert.ok(declared.confidence !== base.confidence, `expected a notch below ${base.confidence}`)
})

test('a pricing question pre-fetches every declared vendor price list before search', async () => {
  const fetched = []
  const config = baseConfig()
  config.__fetchPage = fakeFetcher(fetched)
  const result = await runResearch({
    question: 'DeepSeek API 现在的输入价格是多少',
    depth: 'standard',
    config,
    llm: fakeLlm(defaultResponder),
    selection,
    logger: () => {},
  })
  // 0.6.3: the pricing channel owns its seeds, so all four verified vendor price
  // pages are read (the legacy path only took the first two).
  assert.deepEqual(fetched.slice(0, 4), [
    'https://api-docs.deepseek.com/quick_start/pricing',
    'https://help.aliyun.com/zh/model-studio/models',
    'https://bigmodel.cn/pricing',
    'https://www.volcengine.com/docs/82379/1099320',
  ])
  assert.equal(result.stats.directUrls, 4)
  assert.equal(result.stats.sourceFailures, 0)
  assert.equal(result.stats.officialFetchFailures, undefined)
  // 0.6.3: wired seeds are really adopted as sources, not just fetched.
  const domains = result.sources.map((source) => source.domain)
  assert.ok(domains.includes('bigmodel.cn'), `missing vendor source: ${domains.join(', ')}`)
  assert.ok(domains.includes('www.volcengine.com'), `missing vendor source: ${domains.join(', ')}`)
})

test('declared pricing seeds that fail are recorded and do not stop the run', async () => {
  const config = baseConfig()
  config.__fetchPage = async (url) => {
    if (/api-docs\.deepseek\.com|help\.aliyun\.com|bigmodel\.cn|volcengine\.com/.test(url)) {
      return { url, finalUrl: url, title: url, domain: new URL(url).hostname, ok: false, reason: 'blocked by the vendor' }
    }
    return fakeFetcher()(url)
  }
  const result = await runResearch({
    question: '智谱和 DeepSeek 的 API 价格哪个便宜',
    depth: 'standard',
    config,
    llm: fakeLlm(defaultResponder),
    selection,
    logger: () => {},
  })
  // Every declared seed failed: all four are on record and the run still finishes.
  assert.equal(result.partial, false)
  assert.ok(result.stats.sourceFailures >= 4, `sourceFailures=${result.stats.sourceFailures}`)
  assert.deepEqual(result.stats.officialFetchFailures, ['api-docs.deepseek.com', 'help.aliyun.com'])
  assert.ok(result.brief.length > 0)
})

test('a non-pricing question fetches no price-list seeds', async () => {
  const fetched = []
  const config = baseConfig()
  config.__fetchPage = fakeFetcher(fetched)
  await runResearch({
    question: 'Node 22 是 LTS 吗？项目该用哪个版本',
    depth: 'quick',
    config,
    llm: fakeLlm(defaultResponder),
    selection,
    logger: () => {},
  })
  assert.ok(
    !fetched.some((url) => /api-docs\.deepseek\.com|bigmodel\.cn|volcengine\.com|help\.aliyun\.com/.test(url)),
    `unexpected seed fetch: ${fetched.join(' | ')}`,
  )
})

test('an unreadable official price list becomes a 未解决 line', async () => {
  const config = baseConfig()
  config.__fetchPage = async (url) => {
    if (/api-docs\.deepseek\.com|help\.aliyun\.com/.test(url)) {
      return { url, finalUrl: url, title: url, domain: new URL(url).hostname, ok: false, reason: 'blocked by the vendor' }
    }
    return {
      url, finalUrl: url, title: `page ${url}`, domain: new URL(url).hostname, links: [], ok: true,
      text: 'Node 22 entered LTS in October 2025. Node 22 is the active LTS line and keeps receiving security fixes until April 2027.',
    }
  }
  const result = await runResearch({
    question: 'DeepSeek API 输入价格是多少',
    depth: 'quick',
    config,
    llm: fakeLlm(defaultResponder),
    selection,
    logger: () => {},
  })
  assert.ok(result.gaps.includes('官方价目页未取到：api-docs.deepseek.com'), result.gaps.join(' | '))
  assert.ok(result.gaps.includes('官方价目页未取到：help.aliyun.com'), result.gaps.join(' | '))
  assert.deepEqual(result.stats.officialFetchFailures, ['api-docs.deepseek.com', 'help.aliyun.com'])
  assert.match(result.brief, /^## 未解决$/m)
  assert.match(result.brief, /^## 未解决\n- 官方价目页未取到：api-docs\.deepseek\.com/m)
  assert.match(result.brief, /官方价目页未取到：help\.aliyun\.com/)
})

// --- 0.6.0: sourcePlan / sitemap / user-provided text -----------------------

const SPRING_SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset>
  <url><loc>https://docs.spring.io/spring-boot/3.4/reference/configuration.html</loc></url>
  <url><loc>https://docs.spring.io/spring-boot/3.4/reference/application-properties.html</loc></url>
  <url><loc>https://docs.spring.io/spring-boot/3.4/reference/actuator/index.html</loc></url>
  <url><loc>https://docs.spring.io/spring-boot/3.4/reference/security/index.html</loc></url>
  <url><loc>https://docs.spring.io/spring-boot/3.4/reference/testing/index.html</loc></url>
  <url><loc>https://docs.spring.io/spring-boot/3.4/reference/upgrading.html</loc></url>
  <url><loc>https://docs.spring.io/spring-boot/3.4/reference/web/index.html</loc></url>
  <url><loc>https://docs.spring.io/spring-boot/3.4/reference/data/index.html</loc></url>
</urlset>`

function techSelectionStrategy(question, maxPages) {
  const strategy = resolveStrategy({ questionKind: 'tech-selection', depth: 'quick', question })
  // Widen the channel cap so the test can prove the page budget, not the pack,
  // is what limits the crawl.
  return {
    ...strategy,
    sourcePlan: {
      ...strategy.sourcePlan,
      channels: strategy.sourcePlan.channels.map((channel) => ({ ...channel, maxPages })),
    },
  }
}

test('a docs kind crawls its declared sitemap and clamps pages to the budget', async () => {
  const sitemapRequests = []
  const fetched = []
  const config = baseConfig({
    __fetchRaw: async (url) => {
      sitemapRequests.push(url)
      return { status: 200, body: SPRING_SITEMAP }
    },
  })
  // baseConfig installs its own __fetchPage; override after it so we can see
  // exactly which sitemap URLs the pipeline reads.
  config.__fetchPage = fakeFetcher(fetched)
  const result = await runResearch({
    question: 'Spring Boot 3 配置迁移有哪些坑',
    depth: 'quick',
    strategy: techSelectionStrategy('Spring Boot 3 配置迁移有哪些坑', 9),
    config,
    llm: fakeLlm(defaultResponder),
    selection,
    logger: () => {},
  })
  const sitemapFetches = fetched.filter((url) => url.startsWith('https://docs.spring.io/spring-boot/'))
  // quick budget is 3 pages; the channel asks for 9, the budget still wins.
  assert.equal(sitemapFetches.length, 3)
  assert.equal(result.stats.sitemapPages, 3)
  assert.equal(result.stats.pagesFetched, 3)
  assert.equal(result.stats.sourceFailures, 0)
  assert.deepEqual(sitemapRequests.filter((url) => /sitemap/i.test(url)), ['https://docs.spring.io/sitemap.xml'])
  assert.ok(result.sources.some((source) => source.domain === 'docs.spring.io'), JSON.stringify(result.sources))
  // 0.6.2 — every page came through the targeted sitemap channel, so all three
  // are first-party readable pages and the funnel line has to say how many of
  // them were adopted.
  assert.equal(result.stats.officialReadable, 3)
  assert.ok(result.stats.officialAdopted >= 1 && result.stats.officialAdopted <= 3)
  assert.match(result.brief, new RegExp(`> 检索流程：.*· 官方采用 ${result.stats.officialAdopted}/3(?: · 查询 [^\\n]+)?$`, 'm'))
  assert.match(result.brief, /^## 结论$/m)
})

test('a non-docs question never touches a sitemap', async () => {
  const sitemapRequests = []
  const config = baseConfig({
    __fetchRaw: async (url) => {
      sitemapRequests.push(url)
      return { status: 404, body: '' }
    },
  })
  const result = await runResearch({
    question: '什么是幂等性？为什么重试要配幂等键',
    depth: 'quick',
    config,
    llm: fakeLlm(defaultResponder),
    selection,
    logger: () => {},
  })
  assert.deepEqual(sitemapRequests.filter((url) => /sitemap/i.test(url)), [])
  assert.equal(result.stats.sitemapPages, 0)
  assert.equal(result.stats.sourceFailures, 0)
  assert.ok(result.brief.length > 0)
})

test('a broken sitemap is recorded as a source failure and does not stop the run', async () => {
  const attempted = []
  const config = baseConfig({
    __fetchRaw: async (url) => {
      attempted.push(url)
      return { status: 404, body: '' }
    },
  })
  const result = await runResearch({
    question: 'Spring Boot 3 配置迁移有哪些坑',
    depth: 'quick',
    strategy: techSelectionStrategy('Spring Boot 3 配置迁移有哪些坑', 3),
    config,
    llm: fakeLlm(defaultResponder),
    selection,
    logger: () => {},
  })
  assert.equal(result.partial, false)
  assert.equal(result.stats.sitemapPages, 0)
  assert.ok(result.stats.sourceFailures >= 1)
  assert.ok(attempted.includes('https://docs.spring.io/sitemap.xml'))
  assert.ok(result.brief.length > 0)
})

test('a sitemap channel tries its declared bases in order until one answers', async () => {
  const NODE_SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset>
  <url><loc>https://nodejs.org/en/learn/typescript/introduction</loc></url>
  <url><loc>https://nodejs.org/en/about/lts-schedule</loc></url>
  <url><loc>https://nodejs.org/en/blog/node-22-lts</loc></url>
</urlset>`
  const sitemapRequests = []
  const fetched = []
  const config = baseConfig({
    __fetchRaw: async (url) => {
      if (/sitemap/i.test(url)) sitemapRequests.push(url)
      if (url.startsWith('https://react.dev')) return { status: 404, body: '' }
      if (url === 'https://nodejs.org/sitemap.xml') return { status: 200, body: NODE_SITEMAP }
      return { status: 404, body: '' }
    },
  })
  config.__fetchPage = fakeFetcher(fetched)
  const base = resolveStrategy({ questionKind: 'tech-selection', depth: 'quick', question: 'Node 22 与 TypeScript 的 LTS 迁移' })
  const strategy = {
    ...base,
    sourcePlan: {
      ...base.sourcePlan,
      channels: base.sourcePlan.channels.map((channel) => ({
        ...channel,
        bases: ['https://react.dev', 'https://nodejs.org'],
        maxPages: 3,
      })),
    },
  }
  const result = await runResearch({
    question: 'Node 22 与 TypeScript 的 LTS 迁移',
    depth: 'quick',
    strategy,
    config,
    llm: fakeLlm(defaultResponder),
    selection,
    logger: () => {},
  })
  // react.dev is tried first (all three conventional paths), then the next
  // declared root answers; the channel does not give up after the first 404.
  assert.deepEqual(sitemapRequests, [
    'https://react.dev/sitemap.xml',
    'https://react.dev/sitemap_index.xml',
    'https://react.dev/sitemap-index.xml',
    'https://nodejs.org/sitemap.xml',
  ])
  assert.equal(result.stats.sitemapPages, 2)
  // 0.6.5 — the blog post scores below zero once `/blog/` is demoted, so only
  // the two documentation pages are fetched; the channel itself still works.
  assert.ok(fetched.includes('https://nodejs.org/en/learn/typescript/introduction'), fetched.join(' | '))
  assert.ok(!fetched.includes('https://nodejs.org/en/blog/node-22-lts'), fetched.join(' | '))
  assert.equal(result.partial, false)
})

test('user-provided text is the first evidence source, not a fetched page', async () => {
  const userText = [
    'Node 22 entered LTS in October 2025.',
    'Node 22 is the active LTS line and keeps receiving security fixes until April 2027.',
    '团队应在 2027 年 4 月前规划升级。',
  ].join(' ')
  const result = await runResearch({
    question: 'Node 22 支持到什么时候',
    depth: 'quick',
    userText,
    config: baseConfig(),
    llm: fakeLlm(defaultResponder),
    selection,
    logger: () => {},
  })
  assert.equal(result.sources[0].url, 'user-provided')
  assert.equal(result.sources[0].title, '用户提供的资料')
  assert.match(result.sources[0].type, /docs|web/)
  // The extra page is free: it never inflates the fetched-page count or hosts.
  assert.ok(result.stats.queries >= 1, 'buildQueries still runs')
  assert.ok(!(result.stats.hosts ?? []).includes('user-provided'))
  assert.ok(result.stats.pagesFetched >= 1)
  assert.match(result.brief, /^## 结论$/m)
})

function evidencePage(url, text, extra = {}) {
  return {
    url, finalUrl: url, title: url, domain: new URL(url).hostname,
    text, ok: true, via: 'raw', ...extra,
  }
}

test('a page the model skipped still gets a heuristic evidence item (0.6.2)', async () => {
  const spot = 'Node 22 entered LTS in October 2025 and receives security fixes until April 2027.'
  const pages = [
    evidencePage('https://example.com/a', spot),
    evidencePage('https://example.com/b', 'Beta documentation covers the release cadence and support windows for every major line in detail. '.repeat(2)),
    evidencePage('https://example.com/c', 'Gamma documentation covers the migration path between major versions and the configuration changes involved. '.repeat(2)),
  ]
  const client = {
    jsonCall: async () => ([{
      claim: 'Node 22 is the current LTS line', quote: spot, source: 0, type: 'docs', stance: 'support',
    }]),
  }
  const items = await extractEvidence(pages, null, { client })
  // One model item used to suppress the fallback for the whole batch: the two
  // pages the model never cited produced no evidence and were dropped from 参考.
  assert.equal(items.length, 3)
  assert.deepEqual(items.map((item) => item.url), pages.map((page) => page.url))
  assert.equal(items[0].stance, 'support')
  assert.deepEqual(items.slice(1).map((item) => item.stance), ['neutral', 'neutral'])
  assert.equal(items[1].via, 'raw')
})

test('official and sitemap pages use the shorter heuristic threshold (0.6.2)', async () => {
  const paragraph = 'The regulation states that the obligation applies from December 2028 to all providers of the service.'
  assert.ok(paragraph.length >= 60 && paragraph.length < 120, 'fixture must only pass the relaxed gate')
  const official = evidencePage('https://eur-lex.europa.eu/eli/reg/2024/2847/oj', paragraph)
  const blog = evidencePage('https://example.com/blog', paragraph)
  const sitemap = evidencePage('https://docs.spring.io/spring-ai/reference/', paragraph, { via: 'sitemap' })
  const items = await extractEvidence([official, blog, sitemap], null, { client: { jsonCall: async () => [] } })
  // 60 characters for first-party pages, 120 for everything else.
  assert.equal(items.length, 2)
  assert.deepEqual(items.map((item) => item.url), [official.url, sitemap.url])
  assert.equal(items[1].via, 'sitemap')
})

test('heuristicFallback:false disables the per-page fallback (0.6.2)', async () => {
  const pages = [
    evidencePage('https://example.com/a', 'Alpha documentation covers the release cadence and the support windows for every major line in detail. '.repeat(2)),
    evidencePage('https://example.com/b', 'Beta documentation covers the migration path between major versions and the configuration changes involved. '.repeat(2)),
  ]
  const client = {
    jsonCall: async () => ([{
      claim: 'Alpha documentation exists', quote: 'Alpha documentation covers the release cadence', source: 0, type: 'docs', stance: 'support',
    }]),
  }
  const items = await extractEvidence(pages, { evidence: { heuristicFallback: false } }, { client })
  assert.equal(items.length, 1)
  assert.equal(items[0].url, pages[0].url)
})

test('a stale hit is pushed out of the selection when candidates are plentiful (0.6.5)', async () => {
  const fetched = []
  const stale = 'https://github.com/dead/unmaintained-project'
  const fresh = [
    ['https://nodejs.org/en/learn/typescript/introduction', 'TypeScript introduction for Node'],
    ['https://nodejs.org/en/about/previous-releases', 'Node previous releases calendar'],
    ['https://nodejs.org/en/docs/latest/api/index.html', 'Node API index'],
    ['https://nodejs.org/en/docs/latest/api/cli.html', 'Node CLI options'],
    ['https://nodejs.org/en/learn/modules/introduction', 'Node modules introduction'],
    ['https://nodejs.org/en/about/releases', 'Node release cadence'],
    ['https://nodejs.org/en/docs/latest/api/fs.html', 'Node fs module'],
    ['https://nodejs.org/en/docs/latest/api/process.html', 'Node process module'],
    ['https://nodejs.org/en/learn/getting-started/introduction', 'Getting started with Node'],
  ]
  const engine = {
    name: 'fake',
    available: () => true,
    search: async () => [
      { url: stale, title: '本项目已过期，不再维护', snippet: 'archived repository', engine: 'fake', rank: 1, publishedAt: '2016-01-01' },
      ...fresh.map(([url, title], index) => ({
        url, title, snippet: 'node lts documentation', engine: 'fake', rank: index + 2,
      })),
    ],
  }
  const config = baseConfig()
  config.__engines = [engine]
  config.__fetchPage = fakeFetcher(fetched)
  const result = await runResearch({
    question: 'Node 22 是 LTS 吗？项目该用哪个版本',
    depth: 'standard',
    config,
    llm: fakeLlm(defaultResponder),
    selection,
    logger: () => {},
  })
  assert.equal(result.partial, false)
  assert.ok(fetched.length > 0, 'the run still reads pages')
  assert.ok(!fetched.includes(stale), fetched.join(' | '))
  assert.ok(fetched.includes('https://nodejs.org/en/learn/typescript/introduction'), fetched.join(' | '))
})

test('a page that declares itself retired never becomes evidence (0.6.6)', async () => {
  const node = 'Node 22 entered LTS in October 2025. Node 22 is the active LTS line and keeps receiving security fixes until April 2027; after that it moves to maintenance. A team picking a runtime for a new backend service should weigh that remaining window against its upgrade cadence.'
  const config = baseConfig()
  config.__engines = [{
    name: 'fake',
    available: () => true,
    search: async () => [
      { url: 'https://nodejs.org/1', title: 'Node 22 release notes', snippet: 'node lts schedule', engine: 'fake', rank: 1 },
      { url: 'https://github.com/x/old-repo', title: 'GitHub - x/old-repo', snippet: '本项目已过期，不再维护', engine: 'fake', rank: 2 },
      { url: 'https://a.com/3', title: 'Node LTS documentation', snippet: 'node docs', engine: 'fake', rank: 3 },
    ],
  }]
  config.__fetchPage = async (url) => {
    const retired = url.includes('old-repo')
    return {
      url, finalUrl: url,
      title: `page ${url}`,
      domain: new URL(url).hostname,
      text: retired ? '本项目已过期，不再维护。历史许可证价格 199 元/年，仅存档。' : node,
      ok: true,
    }
  }
  const result = await runResearch({
    question: 'Node 22 是 LTS 吗？项目该用哪个版本',
    depth: 'standard',
    config,
    llm: fakeLlm(defaultResponder),
    selection,
    logger: () => {},
  })
  assert.equal(result.partial, false)
  assert.ok(result.sources.length >= 1, 'readable pages still carry the brief')
  assert.ok(!result.sources.some((source) => source.url.includes('old-repo')), 'the retired page is not adopted')
  assert.ok(result.gaps.some((gap) => gap.includes('仅有过期来源')), result.gaps.join(' | '))
  assert.match(result.brief, /## 参考/)
})

test('when every readable page is retired evidence survives, flagged stale (0.6.6)', async () => {
  const node = 'Node 22 entered LTS in October 2025. Node 22 is the active LTS line and keeps receiving security fixes until April 2027; after that it moves to maintenance. A team picking a runtime for a new backend service should weigh that remaining window against its upgrade cadence.'
  const config = baseConfig()
  config.__engines = [fakeEngine(['https://github.com/x/old-1', 'https://github.com/y/old-2'])]
  config.__fetchPage = async (url) => ({
    url, finalUrl: url, title: '本项目已过期，不再维护', domain: new URL(url).hostname, text: node, ok: true,
  })
  const result = await runResearch({
    question: 'Node 22 是 LTS 吗？项目该用哪个版本',
    depth: 'standard',
    config,
    llm: fakeLlm(defaultResponder),
    selection,
    logger: () => {},
  })
  assert.equal(result.partial, false)
  assert.ok(result.sources.length >= 1, 'a dead-only run still reports what it read')
  assert.ok(result.gaps.some((gap) => gap.includes('唯一可读来源已过期')), result.gaps.join(' | '))
  assert.equal(result.confidence, 'low', 'stale cards cannot lift the verdict')
  assert.match(result.brief, /（已过期，仅作参考）/)
})

const OFFICIAL_DOC_BASES = (question) => resolveStrategy({ questionKind: 'tech-selection', depth: 'quick', question })
  .sourcePlan.channels.find((channel) => channel.id === 'official-docs').bases

test('pickDocBases routes a Spring AI question to the Spring AI manual (0.6.8)', () => {
  const question = 'Spring AI 和 LangChain4j 做 RAG 选型时哪个更好'
  const bases = pickDocBases(question, '', OFFICIAL_DOC_BASES(question))
  assert.deepEqual(bases, ['https://docs.spring.io/spring-ai/reference', 'https://docs.langchain4j.dev'])
})

test('pickDocBases puts the Spring Boot manual first for a Boot question (0.6.8)', () => {
  const question = 'Spring Boot 3 JPA 分页怎么写'
  const bases = pickDocBases(question, '', OFFICIAL_DOC_BASES(question))
  assert.equal(bases[0], 'https://docs.spring.io/spring-boot')
  assert.equal(bases.length, 2)
  // The generic root is the honest second try; the unrelated AI manual is not.
  assert.equal(bases[1], 'https://docs.spring.io')
})

test('pickDocBases falls back to the generic root when no tag matches (0.6.8)', () => {
  const question = 'Rust tokio 异步运行时怎么选'
  const bases = pickDocBases(question, '', OFFICIAL_DOC_BASES(question))
  assert.equal(bases[0], 'https://docs.spring.io')
  assert.ok(!bases.includes('https://docs.spring.io/spring-boot'))
})

/* --------------------------------------------- 0.7.0 — evidence-tier slot */

const TIER_QUESTION = 'Spring AI 和 LangChain4j 做 RAG 选型时该读哪份参考文档'
// A concrete `/reference/` page — the kind of source regression A lost to repos.
// Written without `www.` because normalizeUrl strips it before selection.
const TIER_DOC_PAGE = 'https://baeldung.com/spring-ai/reference/chatclient'
const TIER_REPOS = [
  'https://github.com/acme/spring-ai-rag/blob/main/src/main/java/ChatClientConfig.java',
  'https://github.com/acme/langchain4j-rag/blob/main/src/main/java/EmbeddingStoreConfig.java',
  'https://github.com/acme/rag-advisor/blob/main/src/main/java/RetrievalAdvisor.java',
]
const TIER_TITLES = ['ChatClientConfig.java', 'EmbeddingStoreConfig.java', 'RetrievalAdvisor.java']

function tierHits(engine, extraUrls = []) {
  return [...TIER_REPOS, ...extraUrls].map((url, index) => ({
    url,
    // A distinct title, or dedupeHits folds the doc page into the same-titled repo file.
    title: url === TIER_DOC_PAGE ? 'ChatClient reference' : TIER_TITLES[index % TIER_TITLES.length],
    snippet: 'spring ai rag vector store reference',
    engine,
    rank: index + 1,
  }))
}

function tierEngines(extraUrls = []) {
  return [
    { name: 'fake', available: () => true, search: async () => tierHits('fake', extraUrls) },
    // A second engine repeats the repo URLs: engine consensus (3 points per
    // engine) is the term that used to be enough to carry repositories over the
    // vendor doc page, and it is left in force so the slot has something to beat.
    { name: 'fake2', available: () => true, search: async () => tierHits('fake2') },
  ]
}

async function tierRun(extraUrls = []) {
  const fetched = []
  const config = baseConfig()
  config.__engines = tierEngines(extraUrls)
  config.__fetchPage = fakeFetcher(fetched)
  const result = await runResearch({
    question: TIER_QUESTION,
    depth: 'quick',
    strategy: resolveStrategy({ questionKind: 'tech-selection', depth: 'quick', question: TIER_QUESTION }),
    config,
    llm: fakeLlm(defaultResponder),
    selection,
    logger: () => {},
  })
  return { fetched, result }
}

test('tech-selection keeps a page slot for a concrete doc page (0.7.0)', async () => {
  // The plain ranking still puts the doc page last: three repo files, each
  // corroborated by two engines, outscore it. Only the reserved slot can read it.
  const ranked = rankHits(dedupeHits([...tierHits('fake', [TIER_DOC_PAGE]), ...tierHits('fake2')]), {
    question: TIER_QUESTION,
  }).map((hit) => hit.url)
  assert.equal(ranked.length, 4)
  assert.ok(ranked.slice(0, 2).every((url) => url.includes('github.com')), ranked.join(' | '))
  assert.equal(ranked[ranked.length - 1], TIER_DOC_PAGE, ranked.join(' | '))

  const { fetched } = await tierRun([TIER_DOC_PAGE])
  assert.ok(fetched.includes(TIER_DOC_PAGE), fetched.join(' | '))
  // A repo hit gave up its slot instead of the page being appended.
  assert.ok(TIER_REPOS.some((url) => !fetched.includes(url)), fetched.join(' | '))
})

test('tech-selection without a doc-page candidate is not padded (0.7.0)', async () => {
  const without = await tierRun()
  const withDoc = await tierRun([TIER_DOC_PAGE])
  // Same page budget: the doc page takes a repo slot, it never adds a page. If
  // the slot rule padded the selection, the run that saw a doc page would fetch
  // one more URL than the run that did not.
  assert.equal(withDoc.fetched.length, without.fetched.length)
  assert.ok(!without.fetched.includes(TIER_DOC_PAGE))
  assert.ok(
    without.fetched.every((url) => TIER_REPOS.includes(url)),
    `no invented source: ${without.fetched.join(' | ')}`,
  )
  assert.ok(withDoc.fetched.includes(TIER_DOC_PAGE))
})

function planAwareResponder(plan) {
  return (options) => {
    const prompt = options.user ?? ''
    if (prompt.includes('检索规划员')) return JSON.stringify(plan)
    return defaultResponder(options)
  }
}

test('planner query kinds are counted and shown on the funnel line (0.7.1)', async () => {
  const result = await runResearch({
    question: 'Node 22 LTS 支持到什么时候',
    depth: 'standard',
    config: baseConfig(),
    llm: fakeLlm(planAwareResponder({
      queries: [
        { q: 'Node 22 LTS 支持到什么时候', kind: 'semantic' },
        { q: 'Node.js release schedule LTS end of life', kind: 'technical' },
        { q: 'site:nodejs.org Node 22 LTS', kind: 'official' },
      ],
      directUrls: [],
      reason: '三类各一条',
    })),
    selection,
    logger: () => {},
  })
  const counts = result.stats.queriesByKind
  assert.ok(counts.semantic >= 1, JSON.stringify(counts))
  assert.ok(counts.technical >= 1, JSON.stringify(counts))
  assert.ok(counts.official >= 1, JSON.stringify(counts))
  assert.equal(counts.semantic + counts.technical + counts.official, result.stats.queries)
  assert.match(
    result.brief,
    new RegExp(`· 查询 中文语义 ${counts.semantic} / 英文技术 ${counts.technical} / 官方定向 ${counts.official}$`, 'm'),
  )
})

test('a bare-string plan still works and counts as semantic (0.7.1)', async () => {
  const result = await runResearch({
    question: 'Node 22 LTS 支持到什么时候',
    depth: 'standard',
    config: baseConfig(),
    llm: fakeLlm(planAwareResponder({
      queries: ['Node 22 LTS 支持多久', 'Node.js LTS 维护时间表'],
      directUrls: [],
      reason: '旧格式',
    })),
    selection,
    logger: () => {},
  })
  const counts = result.stats.queriesByKind
  assert.ok(counts.semantic >= 2, JSON.stringify(counts))
  assert.equal(counts.technical, 0, 'bare strings must not be guessed into technical')
  assert.ok(!/· 官方定向 0$/.test(result.brief.split('\n').find((line) => line.startsWith('> 检索流程：')) ?? ''))
})

function compareSynthReply() {
  return [
    '## 结论',
    '单仓多包场景下 pnpm 更合适 [S1]。',
    '',
    '## 依据',
    '- pnpm 共享依赖，安装更快 [S1]',
    '- yarn PnP 省掉 node_modules [S2]',
    '',
    '## 方案对比',
    '| 方案 | 优势 | 风险 | 适用条件 |',
    '| --- | --- | --- | --- |',
    '| pnpm | 安装快 [S1] | 生态较新 | 单仓多包 |',
    '| yarn | 省空间 [S2] | 兼容性 | 新项目 |',
    '| bun | 内置运行时 [S3] | 生态早期 | 试点 |',
    '',
    '## 行动清单',
    '- 在一个单仓项目里跑 pnpm 试点两周',
    '',
    '## 坑与风险',
    '未发现',
    '',
    '## 置信度',
    'medium',
    '',
    '## 未解决',
    '无。',
  ].join('\n')
}

function compareResponder(options) {
  const prompt = options.user ?? ''
  if (prompt.includes('研究简报')) return compareSynthReply()
  if (prompt.includes('<untrusted>')) {
    return JSON.stringify([
      { claim: 'pnpm 通过硬链接共享依赖，安装更快', quote: 'pnpm links every file from a global content-addressable store.', source: 0, type: 'docs', stance: 'support' },
      { claim: 'yarn 的 PnP 模式省掉 node_modules', quote: 'Yarn Plug PnP removes node_modules entirely.', source: 1, type: 'docs', stance: 'support' },
    ])
  }
  if (prompt.includes('拆解')) {
    return JSON.stringify({
      subQuestions: [{ q: 'pnpm yarn bun 各自的安装机制是什么？', why: '对比基线', evidence: 'docs' }],
      constraints: [],
      criteria: ['安装速度', '生态兼容'],
      language: 'zh',
    })
  }
  if (prompt.includes('缺口')) return JSON.stringify({ queries: [], reason: '无' })
  return '{}'
}

function compareFetcher() {
  return async (url) => ({
    url, finalUrl: url, title: `page ${url}`, domain: new URL(url).hostname,
    text: 'pnpm links every file from a global content-addressable store. Yarn Plug PnP removes node_modules entirely. bun ships a runtime and a package manager in one binary.',
    ok: true,
  })
}

test('an option with no evidence is called out instead of silently dropped (0.7.1)', async () => {
  const config = baseConfig()
  // 0.9.2 — the page text grounds the pnpm/yarn quotes but never names bun, so the
  // directed retry for bun does fetch a fresh page and still cannot resolve it.
  const baseFetch = compareFetcher()
  config.__fetchPage = async (url) => ({
    ...(await baseFetch(url)),
    text: 'pnpm links every file from a global content-addressable store. Yarn Plug PnP removes node_modules entirely.',
  })
  const result = await runResearch({
    question: 'pnpm 还是 yarn 还是 bun，该选哪个？',
    depth: 'quick',
    mode: 'compare',
    config,
    llm: fakeLlm(compareResponder),
    selection,
    logger: () => {},
  })
  // bun was named by the user but no cluster mentions it.
  assert.ok(
    result.gaps.some((gap) => gap.includes('选项「bun」') && gap.includes('零证据')),
    JSON.stringify(result.gaps),
  )
  assert.ok(!result.gaps.some((gap) => gap.includes('选项「pnpm」')), JSON.stringify(result.gaps))
  assert.match(result.brief, /^\| bun \| 无证据 \| 无证据 \| 无证据 \|$/m)
  assert.match(result.brief, /^\| pnpm \| 安装快 \[S\d\]/m, 'the evidenced rows keep their citations')
  // 0.9.7 — bun owns a placeholder row, so the gap must say that instead of
  // "not compared": the table does list it, only the evidence is missing. 1.0.1
  // dropped the "price" claim entirely — a compare row can be blank for 优势/风险/
  // 适用条件 just as well, so the note only promises "关键属性".
  assert.match(result.brief, /## 未解决[\s\S]*选项「bun」在对比表中占位，但关键属性未取得（零证据）/)
  assert.doesNotMatch(result.brief, /选项「bun」在本轮证据中没有可用来源/)
  assert.ok(!result.brief.includes('价格未取得'), 'a non-price table must not claim a missing price')
})

// 0.8.1 — the tail segment of a compare question carries the verb phrase
// ("Haystack 该怎么选"), which used to reach the brief as an option name.
test('compareOptions trims the Chinese predicate off the last option (0.8.1)', () => {
  assert.deepEqual(compareOptions('A、B、C 该怎么选'), ['A', 'B', 'C'])
  assert.deepEqual(compareOptions('X vs Y 哪个好'), ['X', 'Y'])
  assert.deepEqual(compareOptions('只有 A'), [])
  // The reported regression: 选项「Haystack 该」 instead of 「Haystack」.
  const real = compareOptions('Java 后端做 RAG 应用，Spring AI、LangChain4j、Haystack 该怎么选')
  assert.deepEqual(real, ['Spring AI', 'LangChain4j', 'Haystack'], JSON.stringify(real))
  // The zero-evidence message now names the option, not the leftover predicate.
  assert.ok(!real.some((option) => /该$/.test(option)), JSON.stringify(real))
})

// 1.0.1 — the reported 1.0.0 run asked "Java 后端做 RAG 应用，Spring AI 和 LangChain4j
// 怎么选" and got three candidates: the comma-split background clause became one,
// and the two real products stayed glued into a single "Spring AI 和 LangChain4j".
test('compareOptions splits on connectives and drops the background clause (1.0.1)', () => {
  const real = compareOptions('Java 后端做 RAG 应用，Spring AI 和 LangChain4j 怎么选')
  assert.deepEqual(real, ['Spring AI', 'LangChain4j'], JSON.stringify(real))
  // The question's setup ("Java 后端做 RAG 应用") is background, never a candidate.
  assert.ok(!real.some((option) => /应用|后端|Java/.test(option)), JSON.stringify(real))
  // 和 / 与 / 还是 / vs all split the same way.
  assert.deepEqual(compareOptions('Spring AI 与 LangChain4j 怎么选'), ['Spring AI', 'LangChain4j'])
  assert.deepEqual(compareOptions('Spring AI vs LangChain4j 哪个好'), ['Spring AI', 'LangChain4j'])
  // A clause over 24 chars cannot be a product name: fall back to known names.
  const verbose = compareOptions('我们团队在做企业内部知识库，后端用 Spring Boot，Spring AI 和 LangChain4j 哪个更适合生产环境')
  assert.deepEqual(verbose, ['Spring AI', 'LangChain4j'], JSON.stringify(verbose))
  // At most three candidates; the list keeps the question's order.
  assert.deepEqual(compareOptions('Spring AI、LangChain4j、Haystack、Dify 该怎么选'), ['Spring AI', 'LangChain4j', 'Haystack'])
  // One candidate is not a comparison.
  assert.deepEqual(compareOptions('Spring AI 怎么选'), [])
})

// 1.1.1 — the reported 1.1.0 run compared 「国内四家大模型 API（DeepSeek」,
// 通义千问 and 豆包: the comma split cut the question's setting clause as the first
// candidate and the three-cap stopped before Kimi. A bracket list with at least two
// names is the user's own enumeration and wins over the punctuation split.
test('compareOptions reads a bracketed enumeration as the candidate list (1.1.1)', () => {
  const options = compareOptions('国内四家大模型 API（DeepSeek、通义千问、豆包、Kimi）的价格怎么比，我们做一个小型 RAG 产品该选哪家')
  assert.deepEqual(options, ['DeepSeek', '通义千问', '豆包', 'Kimi'], JSON.stringify(options))
  // The fragment the list was cut out of never comes back as a candidate.
  assert.ok(!options.some((option) => /API|国内|大模型/.test(option)), JSON.stringify(options))
  // An ASCII bracket list is read the same way, in written order.
  assert.deepEqual(
    compareOptions('Which vector DB (Pinecone, Weaviate, Milvus) should we use for a RAG product'),
    ['Pinecone', 'Weaviate', 'Milvus'],
  )
  // A bracket holding one name is not a list: the sentence's own split applies.
  assert.deepEqual(compareOptions('Spring AI 和 LangChain4j 怎么选（Java）'), ['Spring AI', 'LangChain4j'])
})

// 1.1.1 — a fragment carrying the question's predicate is background, not a
// candidate: "我们做一个小型 RAG 产品该选哪家" used to become a row of its own.
test('compareOptions never promotes a predicate fragment to a candidate (1.1.1)', () => {
  const options = compareOptions('豆包、Kimi 哪家便宜，我们做一个小型 RAG 产品该选哪家')
  assert.deepEqual(options, ['豆包', 'Kimi'], JSON.stringify(options))
  assert.ok(!options.some((option) => /我们|产品|RAG/.test(option)), JSON.stringify(options))
  // A fragment that opens with a name still is that name's segment.
  assert.deepEqual(
    compareOptions('Java 后端做 RAG 应用，Spring AI、LangChain4j、Haystack 该怎么选'),
    ['Spring AI', 'LangChain4j', 'Haystack'],
  )
  // A parenthetical aside that enumerates nothing is not a candidate list.
  assert.deepEqual(
    compareOptions('DeepSeek 和 Kimi 怎么比（我们做一个小型 RAG 产品该选哪家）'),
    ['DeepSeek', 'Kimi'],
  )
})

test('zero-evidence gap names the trimmed option (0.8.1)', async () => {
  const config = baseConfig()
  config.__fetchPage = compareFetcher()
  const result = await runResearch({
    question: 'Java 后端做 RAG 应用，Spring AI、LangChain4j、Haystack 该怎么选',
    depth: 'quick',
    mode: 'compare',
    strategy: resolveStrategy({ questionKind: 'tech-selection', depth: 'quick' }),
    config,
    llm: fakeLlm(compareResponder),
    selection,
    logger: () => {},
  })
  const zero = result.gaps.filter((gap) => gap.includes('零证据')).join(' | ')
  assert.ok(zero.length > 0, JSON.stringify(result.gaps))
  assert.ok(!/选项「[^」]*该」/.test(zero), zero)
  assert.ok(!/选项「[^」]*怎么选」/.test(zero), zero)
})

// 0.9.1 — defect B, part 1: the question's colons and comma lists were kept in
// the option names ("选项「国内大模型 API 价格对比：qwen」"), so a price table's
// rows matched nothing and every row was rewritten to 无证据.
test('compareOptions drops the guidance clause of a colon-led price question (0.9.1)', () => {
  const options = compareOptions('国内大模型 API 价格对比：qwen、豆包、deepseek 哪家便宜')
  assert.deepEqual(options, ['qwen', '豆包', 'deepseek'], JSON.stringify(options))
})

// 0.9.1 — defect B, part 2: hits were whole-string matches, so "qwen" never hit
// a claim that says "qwen2.5" and a row with a real price was called 无证据.
test('countOptionHits matches the option core token, not the whole string (0.9.1)', () => {
  const clusters = [
    { claim: 'qwen2.5 的输入价约 4 元/百万 tokens', evidence: [{ claim: 'qwen2.5-72b 输入价 4 元', quote: 'qwen2.5 input price is about 4 CNY per million tokens.' }] },
    { claim: 'deepseek-chat 的输入价约 2 元/百万 tokens', evidence: [{ claim: 'deepseek 定价 2 元', quote: 'deepseek-chat input price is about 2 CNY per million tokens.' }] },
  ]
  assert.equal(countOptionHits('qwen', clusters), 1)
  assert.equal(countOptionHits('deepseek', clusters), 1)
  assert.equal(countOptionHits('豆包', clusters), 0)
  // Version suffixes match (qwen → qwen2.5), longer words do not (bun → bundle),
  // and hyphenated names keep matching their own spelling.
  assert.equal(countOptionHits('spring-ai', [{ claim: 'spring-ai 支持 RAG', evidence: [] }]), 1)
  assert.equal(countOptionHits('bun', [{ claim: 'a bundle of tools', evidence: [] }]), 0)
  assert.equal(countOptionHits('bun', [{ claim: 'bun ships a runtime', evidence: [] }]), 1)
})

// 0.9.1 — the two halves together on the reported input: three named vendors,
// price evidence for two of them, and exactly one row that must say 无证据.
function priceSynthReply() {
  return [
    '## 结论',
    '价格维度上 deepseek 更低 [S2]。',
    '',
    '## 依据',
    '- qwen2.5 输入价约 4 元/百万 tokens [S1]',
    '- deepseek-chat 输入价约 2 元/百万 tokens [S2]',
    '',
    '## 方案对比',
    '| 方案 | 输入价 | 备注 | 适用条件 |',
    '| --- | --- | --- | --- |',
    '| qwen | 约 4 元/百万 tokens [S1] | 阿里云百炼 | 中文场景 |',
    '| 豆包 | 无证据 | 火山方舟 | 国内调用 |',
    '| deepseek | 约 2 元/百万 tokens [S2] | 官方 API | 成本敏感 |',
    '',
    '## 行动清单',
    '- 先用 deepseek 跑一轮离线评测',
    '',
    '## 坑与风险',
    '价格随促销调整',
    '',
    '## 置信度',
    'medium',
    '',
    '## 未解决',
    '无。',
  ].join('\n')
}

function priceResponder(options) {
  const prompt = options.user ?? ''
  if (prompt.includes('研究简报')) return priceSynthReply()
  if (prompt.includes('<untrusted>')) {
    return JSON.stringify([
      { claim: 'qwen2.5 的输入价约 4 元/百万 tokens', quote: 'qwen2.5 input price is about 4 CNY per million tokens.', source: 0, type: 'docs', stance: 'support' },
      { claim: 'deepseek-chat 的输入价约 2 元/百万 tokens', quote: 'deepseek-chat input price is about 2 CNY per million tokens.', source: 1, type: 'docs', stance: 'support' },
    ])
  }
  if (prompt.includes('拆解')) {
    return JSON.stringify({
      subQuestions: [{ q: 'qwen、豆包、deepseek 的 API 价格分别是多少？', why: '价格对比基线', evidence: 'docs' }],
      constraints: [],
      criteria: ['输入价'],
      language: 'zh',
    })
  }
  if (prompt.includes('缺口')) return JSON.stringify({ queries: [], reason: '无' })
  return '{}'
}

function priceFetcher() {
  return async (url) => ({
    url, finalUrl: url, title: `page ${url}`, domain: new URL(url).hostname,
    text: 'qwen2.5 input price is about 4 CNY per million tokens. deepseek-chat input price is about 2 CNY per million tokens.',
    ok: true,
  })
}

test('a price comparison flags only the option that has no evidence (0.9.1)', async () => {
  const question = '国内大模型 API 价格对比：qwen、豆包、deepseek 哪家便宜'
  const config = baseConfig()
  config.__fetchPage = priceFetcher()
  const result = await runResearch({
    question,
    depth: 'quick',
    mode: 'compare',
    config,
    llm: fakeLlm(priceResponder),
    selection,
    logger: () => {},
  })
  const zero = result.gaps.filter((gap) => gap.includes('零证据'))
  assert.equal(zero.length, 1, JSON.stringify(result.gaps))
  assert.ok(zero[0].includes('选项「豆包」'), zero[0])
  assert.match(result.brief, /^\| 豆包 \| 无证据 \| 无证据 \| 无证据 \|$/m)
  // The rows that do carry price evidence keep their citations untouched.
  assert.match(result.brief, /^\| qwen \| 约 4 元\/百万 tokens \[S\d\]/m)
  assert.match(result.brief, /^\| deepseek \| 约 2 元\/百万 tokens \[S\d\]/m)
})

// 0.9.2 — a zero-evidence option gets one directed query before it is reported:
// the missing vendor page is fetched, mined for heuristic evidence, and adopted.
const DOUBAO_QUESTION = '国内大模型 API 价格对比：qwen、豆包、deepseek 哪家便宜'
const DOUBAO_URL = 'https://www.volcengine.com/docs/82379/doubao-pricing'
// The price pack's own 豆包 seed; the reported case had it unreadable, which is
// exactly how an option ends up with zero evidence in the first place.
const DEAD_DOUBAO_SEED = 'https://www.volcengine.com/docs/82379/1099320'
const DOUBAO_TEXT = '豆包大模型 API 按输入输出 token 计费：输入价约 0.8 元/百万 tokens，输出价约 2 元/百万 tokens。新用户每月有一定免费额度，超出后按量计费，适合国内调用场景；企业客户可申请阶梯折扣与私有部署方案，具体价格以火山方舟控制台为准。'

// 0.9.6 — a pricing scenario now builds its directed query from PRICING_HOSTS
// (`site:volcengine.com 豆包 价格 tokens 百万`) instead of the generic
// `价格 OR pricing` core. Both shapes stay accepted so the non-pricing directed
// path keeps its coverage.
const DIRECTED_PRICE_QUERY = /(?:价格 OR pricing|价格 tokens 百万)/
const DOUBAO_DIRECTED_QUERY = 'site:volcengine.com 豆包 价格 tokens 百万'

function optionAwareEngine(queries, directedUrls = [DOUBAO_URL]) {
  return {
    name: 'fake',
    available: () => true,
    search: async (query) => {
      const text = String(query)
      queries.push(text)
      // Only the directed query (option + pricing intent) returns the vendor page;
      // plan queries keep the ordinary result set.
      const urls = DIRECTED_PRICE_QUERY.test(text)
        ? directedUrls
        : ['https://nodejs.org/1', 'https://github.com/x/y', 'https://a.com/3']
      return urls.map((url, index) => ({
        url, title: FAKE_TITLES[index % FAKE_TITLES.length], snippet: 'snippet', engine: 'fake', rank: index + 1,
      }))
    },
  }
}

function doubaoPriceFetcher(record = []) {
  const base = priceFetcher()
  return async (url) => {
    record.push(url)
    if (url === DEAD_DOUBAO_SEED) {
      return {
        url, finalUrl: url, title: '豆包价格', domain: 'www.volcengine.com', text: '', ok: false, error: 'http 404',
      }
    }
    if (String(url).includes('volcengine')) {
      return {
        url, finalUrl: url, title: '豆包大模型 API 价格', domain: 'www.volcengine.com', text: DOUBAO_TEXT, ok: true,
      }
    }
    return base(url)
  }
}

function doubaoPriceSynthReply(citationIds = ['S1']) {
  const cited = citationIds.map((id) => `[${id}]`).join('')
  return [
    '## 结论',
    `豆包价格最低，deepseek 次之，参考 ${cited}。`,
    '',
    '## 依据',
    '- qwen2.5 输入价约 4 元/百万 tokens',
    '- deepseek-chat 输入价约 2 元/百万 tokens',
    '- 豆包 输入价约 0.8 元/百万 tokens',
    '',
    '## 方案对比',
    '| 方案 | 输入价 | 备注 | 适用条件 |',
    '| --- | --- | --- | --- |',
    '| qwen | 约 4 元/百万 tokens | 阿里云百炼 | 中文场景 |',
    '| 豆包 | 约 0.8 元/百万 tokens | 火山方舟 | 国内调用 |',
    '| deepseek | 约 2 元/百万 tokens | 官方 API | 成本敏感 |',
    '',
    '## 行动清单',
    '- 先用豆包跑一轮离线评测',
    '',
    '## 坑与风险',
    '价格随促销调整',
    '',
    '## 置信度',
    'medium',
    '',
    '## 未解决',
    '无。',
  ].join('\n')
}

function doubaoPriceResponder(options) {
  const prompt = options.user ?? ''
  if (prompt.includes('研究简报')) {
    // Cite every source the synthesis prompt offers, so whichever id the newly
    // fetched 豆包 page was assigned stays in the delivered source list.
    const ids = [...new Set([...prompt.matchAll(/\[(S\d+)\]/g)].map((match) => match[1]))]
    return doubaoPriceSynthReply(ids)
  }
  return priceResponder(options)
}

test('a zero-evidence option is retried once and adopted when the retry lands (0.9.2)', async () => {
  const queries = []
  const fetched = []
  const config = baseConfig()
  config.__engines = [optionAwareEngine(queries)]
  config.__fetchPage = doubaoPriceFetcher(fetched)
  const result = await runResearch({
    question: DOUBAO_QUESTION,
    depth: 'standard',
    mode: 'compare',
    strategy: resolveStrategy({ questionKind: 'pricing', depth: 'standard', question: DOUBAO_QUESTION }),
    config,
    llm: fakeLlm(doubaoPriceResponder),
    selection,
    logger: () => {},
  })
  const directed = queries.filter((query) => DIRECTED_PRICE_QUERY.test(query))
  assert.equal(directed.length, 1, JSON.stringify(queries))
  // The directed query names the vendor's own price host (0.9.6) so the page it
  // lands on is the one that actually carries the missing price.
  assert.equal(directed[0], DOUBAO_DIRECTED_QUERY)
  assert.ok(fetched.includes(DOUBAO_URL), JSON.stringify(fetched))
  assert.ok(!result.gaps.some((gap) => gap.includes('选项「豆包」')), JSON.stringify(result.gaps))
  assert.ok(result.sources.some((source) => source.url === DOUBAO_URL), JSON.stringify(result.sources))
  assert.deepEqual(result.stats.targetedRefill, { optionsTried: 1, pagesFetched: 1, optionsResolved: 1, skipped: null })
  assert.match(result.brief, /定向回补 1 项（解决 1）/)
  assert.ok(!result.brief.includes('定向回补跳过'), result.brief)
})

test('a directed retry that finds nothing keeps the gap and says it was tried (0.9.2)', async () => {
  const queries = []
  const config = baseConfig()
  config.__engines = [optionAwareEngine(queries, [])]
  config.__fetchPage = priceFetcher()
  const result = await runResearch({
    question: DOUBAO_QUESTION,
    depth: 'standard',
    mode: 'compare',
    strategy: resolveStrategy({ questionKind: 'pricing', depth: 'standard', question: DOUBAO_QUESTION }),
    config,
    llm: fakeLlm(priceResponder),
    selection,
    logger: () => {},
  })
  assert.equal(queries.filter((query) => query === DOUBAO_DIRECTED_QUERY).length, 1, JSON.stringify(queries))
  const gap = result.gaps.find((item) => item.includes('选项「豆包」'))
  assert.ok(gap, JSON.stringify(result.gaps))
  assert.match(gap, /已定向检索 1 次仍未获证/)
  // 0.9.7 — the compare table already carries an independent 豆包 row with 无证据
  // cells, so the gap says "listed but unresolved" instead of "not compared".
  // 1.0.1 — "关键属性" replaces the narrower "价格" wording.
  assert.match(result.brief, /选项「豆包」在对比表中占位，但关键属性未取得（零证据）/)
  assert.doesNotMatch(result.brief, /选项「豆包」在本轮证据中没有可用来源/)
  assert.match(gap, /在对比表中占位，但关键属性未取得（零证据）/)
  assert.deepEqual(result.stats.targetedRefill, { optionsTried: 1, pagesFetched: 0, optionsResolved: 0, skipped: null })
  assert.match(result.brief, /定向回补 1 项（解决 0）/)
  assert.ok(!result.brief.includes('定向回补跳过'), result.brief)
})

/**
 * 0.9.7 — the retry opens the vendor's price page by URL before searching.
 *
 * The reported 0.9.6 run's `site:volcengine.com` query returned an article page
 * and a model list, so the page budget was spent on pages that never state a
 * price and 豆包 stayed 无证据. The seed URL is known, so the retry fetches it
 * directly and skips the search entirely when it carries a price.
 *
 * The strategy here declares no Step 2b seeds on purpose: this test is about the
 * refill path, and a direct channel would already have read the same URL.
 */
function pricingStrategyWithoutSeeds() {
  const base = resolveStrategy({ questionKind: 'pricing', depth: 'standard', question: DOUBAO_QUESTION })
  return { ...base, sources: { ...base.sources, officialSeeds: [] }, sourcePlan: { channels: [] } }
}

test('a pricing retry fetches the vendor price page directly instead of searching (0.9.7)', async () => {
  const queries = []
  const fetched = []
  const baseFetch = priceFetcher()
  const config = baseConfig()
  config.__engines = [optionAwareEngine(queries)]
  config.__fetchPage = async (url) => {
    fetched.push(url)
    if (url === DEAD_DOUBAO_SEED) {
      return {
        url, finalUrl: url, title: '豆包大模型 API 价格', domain: 'www.volcengine.com', text: DOUBAO_TEXT, ok: true,
      }
    }
    return baseFetch(url)
  }
  const result = await runResearch({
    question: DOUBAO_QUESTION,
    depth: 'standard',
    mode: 'compare',
    strategy: pricingStrategyWithoutSeeds(),
    config,
    llm: fakeLlm(doubaoPriceResponder),
    selection,
    logger: () => {},
  })
  // The canonical price URL was opened exactly once, and it is the page the
  // brief cites — not an article the search happened to rank.
  assert.equal(fetched.filter((url) => url === DEAD_DOUBAO_SEED).length, 1, JSON.stringify(fetched))
  assert.ok(result.sources.some((source) => source.url === DEAD_DOUBAO_SEED), JSON.stringify(result.sources))
  // The seed page is the option's whole retry: no directed query is spent on an
  // option that is already covered.
  assert.ok(!queries.includes(DOUBAO_DIRECTED_QUERY), JSON.stringify(queries))
  assert.ok(!result.gaps.some((gap) => gap.includes('选项「豆包」')), JSON.stringify(result.gaps))
  assert.ok(result.stats.targetedRefill.optionsResolved >= 1, JSON.stringify(result.stats.targetedRefill))
  assert.equal(result.stats.targetedRefill.optionsTried, 1)
  assert.match(result.brief, /定向回补 1 项（解决 1）/)
})

test('a price-table seed page becomes evidence instead of a zero-evidence row (0.9.8)', async () => {
  // The 0.9.7 bug, end to end: the vendor price page is fetched and cited, but its
  // body is a flattened table — no paragraph reaches the 60-character gate for an
  // official page, so 豆包 used to land in the table with 无证据.
  const tableOnly = [
    '豆包大模型 模型价格',
    '模型 输入价格 输出价格',
    'doubao-pro-32k 0.0008 元/千 tokens 0.002 元/千 tokens',
    'doubao-lite-128k 0.0003 元/千 tokens 0.0006 元/千 tokens',
  ].join('\n')
  const fetched = []
  const baseFetch = priceFetcher()
  const config = baseConfig()
  config.__engines = [optionAwareEngine([])]
  config.__fetchPage = async (url) => {
    fetched.push(url)
    if (url === DEAD_DOUBAO_SEED) {
      return {
        url, finalUrl: url, title: '豆包大模型价格', domain: 'www.volcengine.com', text: tableOnly, ok: true,
      }
    }
    return baseFetch(url)
  }
  const result = await runResearch({
    question: DOUBAO_QUESTION,
    depth: 'standard',
    mode: 'compare',
    strategy: pricingStrategyWithoutSeeds(),
    config,
    llm: fakeLlm(doubaoPriceResponder),
    selection,
    logger: () => {},
  })
  assert.ok(result.sources.some((source) => source.url === DEAD_DOUBAO_SEED), JSON.stringify(result.sources))
  // The option is covered by the seed page alone: no directed search, no gap.
  assert.equal(result.stats.targetedRefill.optionsResolved, 1, JSON.stringify(result.stats.targetedRefill))
  assert.ok(!result.gaps.some((gap) => gap.includes('选项「豆包」')), JSON.stringify(result.gaps))
  // The source the brief got from that page is a price row, not a paragraph: on a
  // table-only body the 0.9.8 branch is the only way it can carry a claim at all.
  const seedSource = result.sources.find((source) => source.url === DEAD_DOUBAO_SEED)
  assert.equal(seedSource.type, 'pricing')
})

test('a pricing seed that is still dead falls back to the directed search (0.9.7)', async () => {
  const queries = []
  const fetched = []
  const config = baseConfig()
  config.__engines = [optionAwareEngine(queries)]
  // The seed 404s even on the direct path, so the search below has to run.
  config.__fetchPage = doubaoPriceFetcher(fetched)
  const result = await runResearch({
    question: DOUBAO_QUESTION,
    depth: 'standard',
    mode: 'compare',
    strategy: pricingStrategyWithoutSeeds(),
    config,
    llm: fakeLlm(doubaoPriceResponder),
    selection,
    logger: () => {},
  })
  assert.equal(fetched.filter((url) => url === DEAD_DOUBAO_SEED).length, 1, JSON.stringify(fetched))
  assert.equal(queries.filter((query) => query === DOUBAO_DIRECTED_QUERY).length, 1, JSON.stringify(queries))
  // The failed seed does not count as a fetched page; the search result does.
  assert.equal(result.stats.targetedRefill.pagesFetched, 1, JSON.stringify(result.stats.targetedRefill))
  assert.equal(result.stats.targetedRefill.optionsResolved, 1, JSON.stringify(result.stats.targetedRefill))
  assert.ok(result.sources.some((source) => source.url === DOUBAO_URL), JSON.stringify(result.sources))
})

test('the retry does not re-fetch a price page the run already read (0.9.7)', async () => {
  const queries = []
  const fetched = []
  const baseFetch = priceFetcher()
  const config = baseConfig()
  config.__engines = [optionAwareEngine(queries)]
  config.__fetchPage = async (url) => {
    fetched.push(url)
    // Step 2b reads the canonical seed, but this page never names 豆包 — which is
    // how an option ends up with zero evidence while its price page is "read".
    if (url === DEAD_DOUBAO_SEED) {
      return {
        url,
        finalUrl: url,
        title: '火山引擎文档 · 计费说明',
        domain: 'www.volcengine.com',
        text: '火山引擎文档说明：各模型的计费口径、结算周期与查询入口均以控制台展示为准，本文只介绍文档索引结构与常见问题，具体条目请查阅对应模型详情页。',
        ok: true,
      }
    }
    if (String(url).includes('volcengine')) {
      return {
        url, finalUrl: url, title: '豆包大模型 API 价格', domain: 'www.volcengine.com', text: DOUBAO_TEXT, ok: true,
      }
    }
    return baseFetch(url)
  }
  const result = await runResearch({
    question: DOUBAO_QUESTION,
    depth: 'standard',
    mode: 'compare',
    strategy: resolveStrategy({ questionKind: 'pricing', depth: 'standard', question: DOUBAO_QUESTION }),
    config,
    llm: fakeLlm(doubaoPriceResponder),
    selection,
    logger: () => {},
  })
  // One read of the seed URL for the whole run: the refill recognised it in the
  // page set and went straight to the search instead of spending a second slot.
  assert.equal(fetched.filter((url) => url === DEAD_DOUBAO_SEED).length, 1, JSON.stringify(fetched))
  assert.equal(queries.filter((query) => query === DOUBAO_DIRECTED_QUERY).length, 1, JSON.stringify(queries))
  assert.equal(result.stats.targetedRefill.pagesFetched, 1, JSON.stringify(result.stats.targetedRefill))
  assert.ok(result.sources.some((source) => source.url === DOUBAO_URL), JSON.stringify(result.sources))
})

// 0.9.3 — the reserve is what makes this test possible: with a wide candidate
// pool ordinary selection would otherwise take all 12 pages and the directed
// retry would find zero budget left (the 0.9.2 regression, exactly).
// Distinct titles on purpose: dedupeHits collapses near-duplicate titles, and a
// dozen hits sharing three headlines would leave three candidates for a
// nine-slot selection — no starvation to demonstrate.
const MARKET_WORDS = [
  'Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot',
  'Golf', 'Hotel', 'India', 'Juliet', 'Kilo', 'Lima',
]

function budgetFillingEngine(queries, directedUrls = [DOUBAO_URL]) {
  return {
    name: 'fake',
    available: () => true,
    search: async (query) => {
      const text = String(query)
      queries.push(text)
      if (DIRECTED_PRICE_QUERY.test(text)) {
        return directedUrls.map((url, index) => ({
          url, title: '豆包大模型 API 价格', snippet: 'snippet', engine: 'fake', rank: index + 1,
        }))
      }
      // 12 distinct URLs (and 12 distinct titles) per plan query, none of them the
      // vendor page: the pool is far larger than the page budget, which is what
      // used to starve the retry.
      return MARKET_WORDS.map((word, index) => ({
        url: `https://market-news-${index}.example.com/pricing`,
        title: `${word} 大模型 API 计费页`,
        snippet: 'snippet',
        engine: 'fake',
        rank: index + 1,
      }))
    },
  }
}

test('compare runs keep page slots for the directed retry (0.9.3)', async () => {
  const queries = []
  const fetched = []
  const config = baseConfig()
  config.__engines = [budgetFillingEngine(queries)]
  config.__fetchPage = doubaoPriceFetcher(fetched)
  const result = await runResearch({
    question: DOUBAO_QUESTION,
    depth: 'standard',
    mode: 'compare',
    strategy: resolveStrategy({ questionKind: 'pricing', depth: 'standard', question: DOUBAO_QUESTION }),
    config,
    llm: fakeLlm(doubaoPriceResponder),
    selection,
    logger: () => {},
  })
  // The retry ran even though ordinary selection had far more candidates than the
  // 12-page budget: two slots were held back before selection, so it was not
  // starved and the 豆包 row is backed by the vendor page it fetched.
  assert.equal(result.stats.targetedRefill.skipped, null, JSON.stringify(result.stats.targetedRefill))
  assert.deepEqual(result.stats.targetedRefill, { optionsTried: 1, pagesFetched: 1, optionsResolved: 1, skipped: null })
  assert.ok(fetched.includes(DOUBAO_URL), JSON.stringify(fetched))
  assert.ok(!result.gaps.some((gap) => gap.includes('选项「豆包」')), JSON.stringify(result.gaps))
  assert.ok(result.sources.some((source) => source.url === DOUBAO_URL), JSON.stringify(result.sources))
  assert.match(result.brief, /定向回补 1 项（解决 1）/)
  // And the reserve did not spend the budget twice: 3 readable price seeds + 7
  // ordinary pages (the two reserved slots were held back) + the 豆包 page.
  assert.equal(result.stats.pagesFetched, 11, JSON.stringify(result.stats))
})

test('targeted refill says why it was skipped without page budget or wall-clock room (0.9.3)', async () => {
  // (a) quick depth: the price pack spends the whole 3-page budget on direct seeds.
  const quickQueries = []
  const quickConfig = baseConfig()
  quickConfig.__engines = [optionAwareEngine(quickQueries)]
  quickConfig.__fetchPage = doubaoPriceFetcher()
  const quick = await runResearch({
    question: DOUBAO_QUESTION,
    depth: 'quick',
    mode: 'compare',
    config: quickConfig,
    llm: fakeLlm(doubaoPriceResponder),
    selection,
    logger: () => {},
  })
  assert.equal(quick.stats.pagesFetched, 3, JSON.stringify(quick.stats))
  assert.ok(!quickQueries.some((query) => DIRECTED_PRICE_QUERY.test(query)), JSON.stringify(quickQueries))
  // 0.9.3 — the skip is reported, not swallowed: the option entered the retry even
  // though no page was left to send its query.
  assert.equal(quick.stats.targetedRefill.skipped, 'budget', JSON.stringify(quick.stats.targetedRefill))
  assert.ok(quick.stats.targetedRefill.optionsTried >= 1, JSON.stringify(quick.stats.targetedRefill))
  const quickGap = quick.gaps.find((gap) => gap.includes('选项「豆包」'))
  assert.ok(quickGap, JSON.stringify(quick.gaps))
  assert.match(quickGap, /页预算耗尽，未做定向检索/)
  assert.ok(!quickGap.includes('已定向检索'), quickGap)
  assert.match(quick.brief, /定向回补跳过（预算不足）/)

  // (b) wall clock: a deep run whose remaining budget is pushed under the 20s
  // floor by the time the retry stage is reached must not spend a query either.
  // 0.9.5 — the reserve moved to 45s (deep wall clock 360s), so 15s left still
  // skips; the 30s case now degrades to one query and is covered separately.
  const realNow = Date.now
  const start = realNow()
  let skew = 0
  Date.now = () => realNow() + skew
  try {
    const timeQueries = []
    const timeConfig = baseConfig()
    timeConfig.__engines = [optionAwareEngine(timeQueries)]
    timeConfig.__fetchPage = doubaoPriceFetcher()
    const timed = await runResearch({
      question: DOUBAO_QUESTION,
      depth: 'deep',
      mode: 'compare',
      strategy: resolveStrategy({ questionKind: 'pricing', depth: 'deep', question: DOUBAO_QUESTION }),
      config: timeConfig,
      llm: fakeLlm((options) => {
        if ((options.user ?? '').includes('<untrusted>')) skew = 360000 - 15000 - (realNow() - start)
        return doubaoPriceResponder(options)
      }),
      selection,
      logger: () => {},
    })
    assert.ok(timed.stats.pagesFetched < 30, JSON.stringify(timed.stats))
    assert.ok(!timeQueries.some((query) => DIRECTED_PRICE_QUERY.test(query)), JSON.stringify(timeQueries))
    assert.equal(timed.stats.targetedRefill.skipped, 'time', JSON.stringify(timed.stats.targetedRefill))
    assert.ok(timed.stats.targetedRefill.optionsTried >= 1, JSON.stringify(timed.stats.targetedRefill))
    const timedGap = timed.gaps.find((gap) => gap.includes('选项「豆包」'))
    assert.ok(timedGap, JSON.stringify(timed.gaps))
    assert.match(timedGap, /剩余时间不足，未做定向检索/)
    assert.ok(!timedGap.includes('已定向检索'), timedGap)
    assert.match(timed.brief, /定向回补跳过（时间不足）/)
  } finally {
    Date.now = realNow
  }
})

/**
 * 0.9.5 — evidence extraction is two batches at a time. The fake model holds
 * each batch for a while and records how many are in flight, so the limit is
 * observable instead of assumed, and the ordered merge is checked by making the
 * first batch resolve last: clusters must still come back in batch order.
 */
test('evidence batches extract two at a time and merge in batch order (0.9.5)', async () => {
  const words = ['zebracrossing', 'quartzite', 'mangosteen', 'violinist', 'cactusflower', 'planetesimal', 'harbormaster']
  const urls = words.map((_, index) => `https://site-${index}.example.com/page`)
  const inFlight = { calls: [], completions: [], live: 0, max: 0 }
  const responder = async (options) => {
    const prompt = options.user ?? ''
    if (!prompt.includes('从下列页面中提取可引用的证据')) return defaultResponder(options)
    const promptUrls = [...prompt.matchAll(/\[页面 \d+\] .*? — (https?:\/\/\S+?)（/g)].map((match) => match[1])
    const call = inFlight.calls.length
    inFlight.calls.push(promptUrls)
    inFlight.live += 1
    inFlight.max = Math.max(inFlight.max, inFlight.live)
    // The first batch settles last, so a completion-ordered merge would put it
    // behind the second one.
    await new Promise((resolve) => setTimeout(resolve, call === 0 ? 40 : 5))
    inFlight.live -= 1
    inFlight.completions.push(call)
    return JSON.stringify(promptUrls.map((url, index) => {
      const word = words[Number(url.match(/site-(\d+)/)?.[1] ?? 0)]
      return { claim: `Claim ${word}`, quote: 'Node 22 entered LTS in October 2025.', source: index, type: 'docs', stance: 'support' }
    }))
  }
  const config = baseConfig()
  config.__engines = [fakeEngine(urls, words.map((word) => `Node ${word} page`))]
  let observedClusters = null
  const result = await runResearch({
    question: 'Node 22 是 LTS 吗？项目该用哪个版本',
    depth: 'standard',
    config,
    llm: asyncFakeLlm(responder),
    selection,
    logger: () => {},
    onState: (snapshot) => { observedClusters = snapshot.clusters },
  })

  assert.equal(result.partial, false)
  // Two batches in flight, never three, and more than one batch actually ran.
  assert.equal(inFlight.max, 2, `max in flight: ${inFlight.max}`)
  assert.ok(inFlight.calls.length >= 2, JSON.stringify(inFlight.calls))
  assert.notDeepEqual(inFlight.completions, [...inFlight.completions].sort((a, b) => a - b), 'batches completed out of order')
  // Observability counters describe the same batches and item sources.
  assert.equal(result.stats.evidenceBatches, inFlight.calls.length)
  assert.equal(result.stats.evidenceModelItems, words.length)
  assert.equal(result.stats.evidenceHeuristicItems, 0)
  // Order: batch index, not completion order. Each prompt lists its pages in
  // order, so concatenating the prompts in call order is the serial order.
  const expected = inFlight.calls.flat().map((url) => `Claim ${words[Number(url.match(/site-(\d+)/)?.[1] ?? 0)]}`)
  assert.deepEqual(observedClusters.map((cluster) => cluster.claim), expected)
})

test('a failing evidence batch falls back to heuristics instead of aborting the run (0.9.5)', async () => {
  const responder = (options) => {
    if ((options.user ?? '').includes('从下列页面中提取可引用的证据')) throw new Error('provider responded 429')
    return defaultResponder(options)
  }
  const result = await runResearch({
    question: 'Node 22 是 LTS 吗？项目该用哪个版本',
    depth: 'standard',
    config: baseConfig(),
    llm: fakeLlm(responder),
    selection,
    logger: () => {},
  })
  // The call failed, so the model contributed nothing; the per-page heuristic
  // kept the run alive instead of surfacing as 运行超时/中断.
  assert.equal(result.partial, false)
  assert.equal(result.stats.evidenceModelItems, 0)
  assert.ok(result.stats.evidenceHeuristicItems >= 1, JSON.stringify(result.stats))
  assert.ok(result.sources.length >= 1, JSON.stringify(result.sources))
})

test('a 30s remainder degrades the targeted retry to one query instead of skipping (0.9.5)', async () => {
  const realNow = Date.now
  const start = realNow()
  let skew = 0
  Date.now = () => realNow() + skew
  try {
    const queries = []
    const config = baseConfig()
    config.__engines = [optionAwareEngine(queries)]
    config.__fetchPage = doubaoPriceFetcher()
    const result = await runResearch({
      question: DOUBAO_QUESTION,
      depth: 'deep',
      mode: 'compare',
      strategy: resolveStrategy({ questionKind: 'pricing', depth: 'deep', question: DOUBAO_QUESTION }),
      config,
      llm: fakeLlm((options) => {
        if ((options.user ?? '').includes('<untrusted>')) skew = 360000 - 30000 - (realNow() - start)
        return doubaoPriceResponder(options)
      }),
      selection,
      logger: () => {},
    })
    // 30s is under the 45s guard but over the 20s floor: one directed query runs.
    assert.ok(queries.includes(DOUBAO_DIRECTED_QUERY), JSON.stringify(queries))
    assert.equal(result.stats.targetedRefill.skipped, null, JSON.stringify(result.stats.targetedRefill))
    assert.equal(result.stats.targetedRefill.optionsTried, 1, JSON.stringify(result.stats.targetedRefill))
    assert.match(result.brief, /定向回补 1 项/)
    const gap = result.gaps.find((entry) => entry.includes('选项「豆包」'))
    if (gap) assert.doesNotMatch(gap, /剩余时间不足，未做定向检索/)
  } finally {
    Date.now = realNow
  }
})

/**
 * 0.9.5 — adoption diagnosis: read-but-unused pages are classified, and the
 * 参考 section says why instead of only how many.
 */
test('read-but-unused pages are classified by reason in stats and the brief (0.9.5)', async () => {
  // Four readable pages with distinct claims (so they stay four clusters), one
  // page under the 120-char gate, and one fetch failure. The synthesizer cites
  // only S1/S2, so the other two evidence-bearing pages are dropped by citation
  // hygiene — the three failure modes must not be conflated.
  const texts = {
    'https://alpha.example.com/node-lts': 'Node 22 entered long term support in October 2025. The release stays supported through April 2027, after which it moves to maintenance only. Teams planning a backend service should treat that date as a hard upgrade deadline.',
    'https://beta.example.com/release-plan': 'Node 24 is the current release line for early adopters. It becomes long term support in April 2026, one year after its first stable cut, and keeps ordinary security patches for two more years.',
    'https://gamma.example.com/engines-field': 'Pin the runtime in the engines field of package.json so continuous integration and developer machines resolve the same major version. Without the pin, a minor upgrade can change native addon behaviour silently.',
    'https://delta.example.com/upgrade-window': 'Schedule the runtime upgrade one quarter before the support deadline. Leave two sprints for regression testing and for rebuilding native dependencies against the new application binary interface.',
    'https://thin.example.com/note': 'Node 22 is LTS.',
    'https://broken.example.com/page': null,
  }
  const urls = Object.keys(texts)
  const titles = [
    'Node 22 LTS schedule',
    'Node 24 release plan',
    'engines field guidance',
    'upgrade window playbook',
    'short note about LTS',
    'broken fetch page',
  ]
  const config = baseConfig()
  config.__engines = [fakeEngine(urls, titles)]
  config.__fetchPage = async (url) => {
    const text = texts[url]
    if (!text) return { url, ok: false, reason: 'HTTP 403' }
    return {
      url, finalUrl: url, title: `page ${url}`, domain: new URL(url).hostname,
      text, ok: true,
    }
  }
  const responder = (options) => {
    const prompt = options.user ?? ''
    // The model extracts nothing: evidence comes from the per-page heuristic
    // fallback, and droppedModelNoClaim stays 0 because no page is left without
    // a claim-capable paragraph.
    if (prompt.includes('从下列页面中提取可引用的证据')) return '[]'
    if (prompt.includes('研究简报')) return synthReply()
    return defaultResponder(options)
  }
  const result = await runResearch({
    question: 'Node 22 是 LTS 吗？项目该用哪个版本',
    depth: 'standard',
    config,
    llm: fakeLlm(responder),
    selection,
    logger: () => {},
  })
  const stats = result.stats
  assert.equal(stats.fetchFailed, 1, JSON.stringify(stats))
  assert.equal(stats.readable, 5, JSON.stringify(stats))
  assert.equal(stats.adopted, 2, JSON.stringify(stats))
  assert.equal(stats.droppedUncited, 2, JSON.stringify(stats))
  assert.equal(stats.droppedBelowMinChars, 1, JSON.stringify(stats))
  assert.equal(stats.droppedModelNoClaim, 0, JSON.stringify(stats))
  assert.equal(stats.droppedNoEvidence, 1, JSON.stringify(stats))
  // Every read page lands in exactly one bucket next to the adopted ones.
  assert.equal(stats.adopted + stats.droppedUncited + stats.droppedNoEvidence, stats.readable)
  assert.match(result.brief, /另有 3 个页面被读取但未采用/)
  assert.match(result.brief, /未采用原因：/)
  assert.match(result.brief, /低于字数门槛 1 段/)
  assert.match(result.brief, /引用校验剔除 2 段/)
  assert.match(result.brief, /另有 1 篇抓取失败/)
  // Evidence observability travels with the same run: two batches (3 + 2 pages),
  // no model items, four heuristic items.
  assert.equal(stats.evidenceBatches, 2, JSON.stringify(stats))
  assert.equal(stats.evidenceModelItems, 0, JSON.stringify(stats))
  assert.equal(stats.evidenceHeuristicItems, 4, JSON.stringify(stats))
})

// 0.9.1 — defect A's key: doc sections vs repositories vs plain hosts.
test('evidenceSiteKey keys doc sections, repositories and hosts (0.9.1)', () => {
  const springAi = 'https://docs.spring.io/spring-ai/reference/api/chatclient.html'
  const springBoot = 'https://docs.spring.io/spring-boot/reference/features/ai.html'
  assert.equal(evidenceSiteKey(springAi), 'docs.spring.io/spring-ai')
  assert.equal(evidenceSiteKey(springBoot), 'docs.spring.io/spring-boot')
  assert.notEqual(evidenceSiteKey(springAi), evidenceSiteKey(springBoot))
  // Same section, different page → one unit.
  assert.equal(evidenceSiteKey('https://docs.spring.io/spring-ai/reference/api/vectordbs.html'), 'docs.spring.io/spring-ai')
  // github is per repository, not per file.
  assert.equal(evidenceSiteKey('https://github.com/spring-projects/spring-ai/blob/main/README.md'), 'github.com/spring-projects/spring-ai')
  assert.equal(evidenceSiteKey('https://github.com/spring-projects/spring-ai/issues/1'), 'github.com/spring-projects/spring-ai')
  // Ordinary sites stay host-level, like the confirmation key.
  assert.equal(evidenceSiteKey('https://a.com/1'), 'a.com')
  assert.equal(evidenceSiteKey('https://a.com/2'), 'a.com')
  assert.equal(evidenceSiteKey('not a url'), '')
  assert.equal(evidenceSiteKey(''), '')
})

function queryRecordingEngine(record, urls = ['https://nodejs.org/1', 'https://github.com/x/y']) {
  return {
    name: 'fake',
    available: () => true,
    search: async (query) => {
      record.push(String(query))
      return urls.map((url, index) => ({
        url, title: FAKE_TITLES[index % FAKE_TITLES.length], snippet: 'snippet', engine: 'fake', rank: index + 1,
      }))
    },
  }
}

const RAG_QUESTION = 'Java 后端做 RAG 应用，Spring AI、LangChain4j、Haystack 该怎么选'

test('a plan without an official query still gets a site: query from the pack (0.8.1)', async () => {
  const seen = []
  const config = baseConfig()
  config.__engines = [queryRecordingEngine(seen)]
  const result = await runResearch({
    question: RAG_QUESTION,
    depth: 'standard',
    strategy: resolveStrategy({ questionKind: 'tech-selection', depth: 'standard', question: RAG_QUESTION }),
    config,
    llm: fakeLlm(planAwareResponder({
      queries: [
        { q: RAG_QUESTION, kind: 'semantic' },
        { q: 'Spring AI vs LangChain4j vs Haystack for Java RAG', kind: 'technical' },
      ],
      directUrls: [],
      reason: '只给了语义与技术',
    })),
    selection,
    logger: () => {},
  })
  const counts = result.stats.queriesByKind
  assert.ok(counts.official >= 1, JSON.stringify(counts))
  assert.equal(counts.semantic + counts.technical + counts.official, result.stats.queries)
  const official = seen.filter((query) => query.startsWith('site:'))
  assert.ok(official.length >= 1, seen.join(' | '))
  assert.ok(official.some((query) => query.startsWith('site:docs.spring.io')), seen.join(' | '))
  // The backstop spends a slot, it does not grow the query budget.
  // 0.9.2 — the directed retry of zero-evidence options is a page-budget step:
  // it adds `<option> 官方 OR official` queries that were never in the plan.
  assert.ok(seen.filter((query) => !query.includes(' OR ')).length <= 6, seen.join(' | '))
  assert.match(result.brief, /· 查询 中文语义 \d+ \/ 英文技术 \d+ \/ 官方定向 [1-9]\d*/m)
})

test('an official query from the planner is not duplicated by the backstop (0.8.1)', async () => {
  const seen = []
  const config = baseConfig()
  config.__engines = [queryRecordingEngine(seen)]
  const result = await runResearch({
    question: RAG_QUESTION,
    depth: 'standard',
    strategy: resolveStrategy({ questionKind: 'tech-selection', depth: 'standard', question: RAG_QUESTION }),
    config,
    llm: fakeLlm(planAwareResponder({
      queries: [
        { q: RAG_QUESTION, kind: 'semantic' },
        { q: 'Spring AI RAG reference', kind: 'technical' },
        { q: 'site:docs.spring.io Spring AI RAG', kind: 'official' },
      ],
      directUrls: [],
      reason: '已含官方定向',
    })),
    selection,
    logger: () => {},
  })
  assert.equal(seen.filter((query) => query.startsWith('site:docs.spring.io')).length, 1, seen.join(' | '))
  assert.ok(!seen.some((query) => query.startsWith('site:docs.langchain4j.dev')), seen.join(' | '))
  assert.equal(result.stats.queriesByKind.official, 1, JSON.stringify(result.stats.queriesByKind))
})

test('an all-semantic plan with a full query budget still gets official queries (0.8.1)', async () => {
  const seen = []
  const config = baseConfig()
  config.__engines = [queryRecordingEngine(seen)]
  const result = await runResearch({
    question: RAG_QUESTION,
    depth: 'standard',
    strategy: resolveStrategy({ questionKind: 'tech-selection', depth: 'standard', question: RAG_QUESTION }),
    config,
    llm: fakeLlm(planAwareResponder({
      queries: [
        { q: RAG_QUESTION, kind: 'semantic' },
        { q: 'Java RAG 框架对比', kind: 'semantic' },
      ],
      directUrls: [],
      reason: '全是中文语义',
    })),
    selection,
    logger: () => {},
  })
  // No technical query exists to spend, so the last slot goes whatever its kind.
  const counts = result.stats.queriesByKind
  assert.ok(counts.official >= 1, JSON.stringify(counts))
  assert.ok(counts.technical === 0, JSON.stringify(counts))
  assert.equal(counts.semantic + counts.technical + counts.official, result.stats.queries)
  assert.ok(seen.some((query) => query.startsWith('site:')), seen.join(' | '))
  // 0.9.2 appends `· 定向回补 N 项（解决 M）` after the query mix, so the match is
  // on the segment, not on the end of the line.
  assert.match(result.brief, /官方定向 [1-9]\d*/m)
})

test('officialBackstopQueries only uses declared bases/seeds (0.8.1)', () => {
  const tech = resolveStrategy({ questionKind: 'tech-selection', depth: 'standard' })
  const backstop = officialBackstopQueries(RAG_QUESTION, [], tech)
  assert.ok(backstop.length >= 1 && backstop.length <= 2, JSON.stringify(backstop))
  assert.ok(backstop.every((query) => /^site:[a-z0-9.-]+ \S+/.test(query)), JSON.stringify(backstop))
  // A pack with no official channel has nothing to fall back to.
  assert.deepEqual(officialBackstopQueries(RAG_QUESTION, [], resolveStrategy({ questionKind: 'concept', depth: 'standard' })), [])
})

// 0.8.2 — the reported regression: the user does not pass `mode`, and classify
// used to return concept, so there was no official channel for the 0.8.1
// backstop to draw a site: query from. This is the whole fix end to end.
test('an omitted mode classifies the selection question and still gets official queries (0.8.2)', async () => {
  const seen = []
  const config = baseConfig()
  config.__engines = [queryRecordingEngine(seen)]
  const result = await runResearch({
    question: RAG_QUESTION,
    depth: 'standard',
    config,
    llm: fakeLlm(planAwareResponder({
      queries: [
        { q: RAG_QUESTION, kind: 'semantic' },
        { q: 'Spring AI vs LangChain4j vs Haystack for Java RAG', kind: 'technical' },
      ],
      directUrls: [],
      reason: '只给了语义与技术',
    })),
    selection,
    logger: () => {},
  })
  assert.equal(result.stats.questionKind, 'tech-selection', JSON.stringify(result.stats.signals))
  assert.equal(result.stats.mode, 'compare')
  assert.ok(result.stats.queriesByKind.official >= 1, JSON.stringify(result.stats.queriesByKind))
  assert.equal(
    result.stats.queriesByKind.semantic + result.stats.queriesByKind.technical + result.stats.queriesByKind.official,
    result.stats.queries,
  )
  assert.ok(seen.some((query) => query.startsWith('site:')), seen.join(' | '))
  // 0.9.2 — the directed-retry counter now follows the query mix on the same line.
  assert.match(result.brief, /官方定向 [1-9]\d*/m)
  // The classified pack also keeps its declared sections.
  assert.match(result.brief, /## 方案对比/)
})

// 0.8.3 — the reported misclassification, end to end. The price question used to
// classify as tech-selection, whose official-docs channel produced
// `site:docs.spring.io …` / `site:docs.langchain4j.dev …` queries; the run then
// adopted nine Java doc pages and answered nothing about prices. The price
// pack must query a vendor price page and must not touch the docs site.
test('a price question never queries the Java docs site and does query a vendor price page (0.8.3)', async () => {
  const seen = []
  const rawRequests = []
  const config = baseConfig({
    __fetchRaw: async (url) => {
      rawRequests.push(String(url))
      return { status: 404, body: '' }
    },
  })
  config.__engines = [queryRecordingEngine(seen)]
  const question = '国内大模型 API 价格对比：qwen、豆包、deepseek 哪家便宜'
  const result = await runResearch({
    question,
    depth: 'standard',
    config,
    llm: fakeLlm(planAwareResponder({
      queries: [{ q: question, kind: 'semantic' }],
      directUrls: [],
      reason: '只给语义，官方查询走 pack 兜底',
    })),
    selection,
    logger: () => {},
  })

  assert.equal(result.stats.questionKind, 'pricing', JSON.stringify(result.stats.signals))
  assert.equal(result.stats.mode, 'compare')

  // No documentation-site query at all — neither from the pack nor the backstop.
  assert.ok(
    !seen.some((query) => /docs\.spring\.io|docs\.langchain4j\.dev/.test(query)),
    `doc-site query leaked: ${seen.join(' | ')}`,
  )
  // The declared price hosts are used instead (0.8.1 backstop on the price pack).
  const official = seen.filter((query) => query.startsWith('site:'))
  assert.ok(official.length >= 1, `no official query: ${seen.join(' | ')}`)
  assert.ok(
    official.some((query) => /^site:(api-docs\.deepseek\.com|help\.aliyun\.com|bigmodel\.cn|www\.volcengine\.com) /.test(query)),
    `price page not queried: ${seen.join(' | ')}`,
  )
  // Step 2a (sitemap crawl) is never reached for this kind: no bases were kept.
  assert.deepEqual(rawRequests.filter((url) => /sitemap/i.test(url)), [])
})

/** Strip the checklist a fixture wrote, to exercise the "model omitted it" path. */
function withoutActionChecklist(responder) {
  return (options) => {
    const text = String(responder(options))
    if (!text.includes('## 行动清单')) return text
    return text.replace(/\n## 行动清单\n(?:- .*\n)+\n/, '\n')
  }
}

/**
 * The shared defaultResponder answers the synthesis prompt through its 缺口
 * branch (the brief prompt mentions 缺口 too, on purpose), which is how the
 * older tests exercise the deterministic fallback. These answer-layer tests
 * need a real synthesized brief, so route 研究简报 explicitly first.
 */
function synthFirst(reply) {
  return (options) => ((options.user ?? '').includes('研究简报') ? reply(options) : defaultResponder(options))
}

test('the answer layer lands in the delivered brief after the retrieval flow (0.9.0)', async () => {
  const result = await runResearch({
    question: 'Node 22 是 LTS 吗？项目该用哪个版本',
    depth: 'standard',
    config: baseConfig(),
    llm: fakeLlm(synthFirst(() => synthReply())),
    selection,
    logger: () => {},
  })
  assert.match(result.brief, /^## 行动清单$/m)
  assert.match(result.brief, /^- 跑 nvm install 22/m)
  assert.match(result.brief, /^> 检索流程：/m, 'the run went through the normal pipeline')
  // Section order the reader expects: options, then the moves, then the risks.
  assert.ok(result.brief.indexOf('## 方案对比') < result.brief.indexOf('## 行动清单'))
  assert.ok(result.brief.indexOf('## 行动清单') < result.brief.indexOf('## 坑与风险'))
})

test('a decision run labels unsourced 判据 lines and refuses high on blogs (0.10.1)', async () => {
  const decisionBrief = [
    '## 结论',
    '**一句话：不该拆**（8 人团队，日发布 < 3 次，先把边界理清）。',
    '',
    '## 判据',
    '- 团队 ≥ 8 人且日发布 ≥ 3 次才划算',
    '- 回滚成本 > 2 人日时不该拆 [S1]',
    '',
    '## 行动清单',
    '- 先拆一个边界清晰的服务试点两周',
    '',
    '## 坑与风险',
    '无',
  ].join('\n')
  const config = {
    ...baseConfig(),
    __engines: [fakeEngine(['https://a.com/1', 'https://b.com/2'])],
  }
  const result = await runResearch({
    question: '我们团队 8 个人，微服务该不该拆',
    depth: 'quick',
    config,
    llm: fakeLlm(synthFirst(() => decisionBrief)),
    selection,
    logger: () => {},
  })
  // The kind reaches computeConfidence() through the pipeline, not only through
  // a direct call: quick depth has no "missing primary" cap, so the legacy
  // matrix used to hand this run medium on one confirmed cluster of two blogs.
  assert.equal(result.stats.questionKind, 'decision')
  assert.equal(result.confidence, 'low')
  // A 判据 line with no [S#] is the model's judgement, and it says so.
  assert.match(result.brief, /^- 团队 ≥ 8 人且日发布 ≥ 3 次才划算（推断）$/m)
  // The cited criteron survives citation hygiene untouched.
  assert.match(result.brief, /^- 回滚成本 > 2 人日时不该拆 \[S1\]$/m)
})

test('a compare brief that omits the checklist gets 无 and one confidence notch (0.9.0)', async () => {
  const config = baseConfig()
  config.__fetchPage = compareFetcher()
  const run = (responder) => runResearch({
    question: 'pnpm 还是 yarn 还是 bun，该选哪个？',
    depth: 'quick',
    mode: 'compare',
    config,
    llm: fakeLlm(responder),
    selection,
    logger: () => {},
  })
  const withList = await run(compareResponder)
  const without = await run(withoutActionChecklist(compareResponder))
  assert.match(without.brief, /^## 行动清单\n- 无$/m)
  assert.equal(without.confidence, downgradeConfidence(withList.confidence))
  assert.ok(without.confidence !== withList.confidence, `expected a notch below ${withList.confidence}`)
})

test('a concept brief keeps the checklist optional: 无 placeholder, no notch (0.9.0)', async () => {
  const run = (responder) => runResearch({
    question: '什么是 JavaScript 事件循环',
    depth: 'standard',
    config: baseConfig(),
    llm: fakeLlm(responder),
    selection,
    logger: () => {},
  })
  const withList = await run(synthFirst(() => synthReply()))
  const without = await run(withoutActionChecklist(synthFirst(() => synthReply())))
  assert.equal(without.stats.questionKind, 'concept')
  assert.match(without.brief, /^## 行动清单\n- 无$/m)
  // Optional for concept: the placeholder appears, but confidence is unchanged.
  assert.equal(without.confidence, withList.confidence)
})

// 0.9.6 — the directed refill for a price question now aims at the vendor's own
// pricing host. The 0.9.5 regression was a generic `豆包 官方 价格` query landing
// on a listing page that the citation check then dropped.
test('pricing options map to their vendor price host and a scoped query (0.9.6)', () => {
  assert.equal(pricingHostFor('豆包'), 'volcengine.com')
  assert.equal(pricingHostFor('doubao'), 'volcengine.com')
  assert.equal(pricingHostFor('火山方舟'), 'volcengine.com')
  assert.equal(pricingHostFor('Qwen'), 'help.aliyun.com')
  assert.equal(pricingHostFor('通义千问'), 'help.aliyun.com')
  assert.equal(pricingHostFor('deepseek'), 'api-docs.deepseek.com')
  assert.equal(pricingHostFor('Kimi'), 'platform.moonshot.cn')
  assert.equal(pricingHostFor('moonshot'), 'platform.moonshot.cn')
  assert.equal(pricingHostFor('GLM-4'), 'open.bigmodel.cn')
  assert.equal(pricingHostFor('智谱'), 'open.bigmodel.cn')
  assert.equal(pricingHostFor('some-unknown-vendor'), '')
  assert.equal(pricingHostFor(''), '')
  assert.equal(pricingHostFor(null), '')
  // One query per option, scoped to the host that actually publishes the price.
  assert.deepEqual(pricingTargetQueries('豆包'), ['site:volcengine.com 豆包 价格 tokens 百万'])
  assert.deepEqual(pricingTargetQueries('  qwen  '), ['site:help.aliyun.com qwen 价格 tokens 百万'])
  assert.deepEqual(pricingTargetQueries('unknown-vendor'), ['unknown-vendor API 价格 每百万 tokens'])
  assert.deepEqual(pricingTargetQueries(''), [])
  // The table is data, not behaviour: every entry is a frozen {pattern, host}.
  assert.equal(PRICING_HOSTS.length, 5)
  for (const entry of PRICING_HOSTS) {
    assert.ok(entry.pattern instanceof RegExp)
    assert.equal(typeof entry.host, 'string')
    assert.ok(Object.isFrozen(entry))
  }
})

test('a pricing scenario is recognised from the pack, the question or a known vendor (0.9.6)', () => {
  const pricingStrategy = resolveStrategy({ questionKind: 'pricing', depth: 'standard', question: DOUBAO_QUESTION })
  assert.equal(isPricingScenario({ strategy: pricingStrategy, question: DOUBAO_QUESTION, mode: 'compare' }), true)
  // A docs-only pack with a price question still counts as pricing.
  assert.equal(isPricingScenario({ strategy: null, question: '豆包 API 多少钱一百万 tokens', mode: null }), true)
  // Compare mode over a known vendor counts even without a price word — the
  // caller passes the candidate names, exactly as the refill stage does.
  assert.equal(isPricingScenario({ strategy: null, question: '豆包 和 qwen 选哪个', mode: 'compare', options: ['豆包', 'qwen'] }), true)
  // ... but only when a known vendor is among them.
  assert.equal(isPricingScenario({ strategy: null, question: 'A 和 B 选哪个', mode: 'compare', options: ['A', 'B'] }), false)
  // Ordinary concept work does not become a pricing run.
  assert.equal(isPricingScenario({
    strategy: resolveStrategy({ questionKind: 'concept', depth: 'standard', question: '什么是向量数据库' }),
    question: '什么是向量数据库',
    mode: 'concept',
  }), false)
  assert.equal(isPricingScenario({}), false)
})

test('a vendor page that prints 元/百万 tokens is recognised as the price page (0.9.6)', () => {
  // The refill moves these pages to the front of the evidence batch, which is
  // what makes them survive a wall-clock abort of a later batch.
  assert.equal(pricingHostOfUrl('https://www.volcengine.com/docs/82379/doubao-pricing'), 'volcengine.com')
  assert.equal(pricingHostOfUrl('https://volcengine.com/pricing'), 'volcengine.com')
  assert.equal(pricingHostOfUrl('https://api-docs.deepseek.com/quick_start/pricing'), 'api-docs.deepseek.com')
  assert.equal(pricingHostOfUrl('https://blog.example.com/volcengine-price'), '')
  assert.equal(pricingHostOfUrl('not a url'), '')
  assert.equal(isPricingEvidencePage({
    url: 'https://www.volcengine.com/docs/82379/doubao-pricing',
    text: '豆包大模型输入价 0.8 元/百万 tokens，输出价 2 元/百万 tokens。',
  }), true)
  // A vendor page without any money on it is not evidence of a price.
  assert.equal(isPricingEvidencePage({
    url: 'https://www.volcengine.com/docs/82379/overview',
    text: '火山方舟提供模型推理、微调与部署能力，支持多地域调用。',
  }), false)
  // A price on an unknown host is not first-party pricing either.
  assert.equal(isPricingEvidencePage({ url: 'https://blog.example.com/x', text: '0.8 元/百万 tokens' }), false)
})

test('every pricing host has a canonical price URL to open directly (0.9.7)', () => {
  // data, not behaviour: one {pattern, url} per vendor, matched by the same
  // patterns PRICING_HOSTS uses, so host and seed can never drift apart.
  assert.equal(PRICING_SEEDS.length, 5)
  for (const entry of PRICING_SEEDS) {
    assert.ok(entry.pattern instanceof RegExp, JSON.stringify(entry))
    assert.match(entry.url, /^https:\/\//, JSON.stringify(entry))
    assert.ok(Object.isFrozen(entry) || typeof entry === 'object', JSON.stringify(entry))
  }
  assert.equal(pricingSeedFor('豆包'), 'https://www.volcengine.com/docs/82379/1099320')
  assert.equal(pricingSeedFor('火山方舟'), 'https://www.volcengine.com/docs/82379/1099320')
  assert.equal(pricingSeedFor('Qwen'), 'https://help.aliyun.com/zh/model-studio/models')
  assert.equal(pricingSeedFor('deepseek'), 'https://api-docs.deepseek.com/quick_start/pricing')
  assert.equal(pricingSeedFor('Kimi'), 'https://platform.moonshot.cn')
  assert.equal(pricingSeedFor('GLM-4'), 'https://open.bigmodel.cn/pricing')
  assert.equal(pricingSeedFor('some-unknown-vendor'), '')
  assert.equal(pricingSeedFor(''), '')
  assert.equal(pricingSeedFor(null), '')
  // The host and the seed must agree, or the refill opens one vendor's page for
  // another vendor's option.
  for (const option of ['豆包', 'qwen', 'deepseek', 'kimi', 'glm']) {
    const seed = pricingSeedFor(option)
    assert.ok(seed.includes(pricingHostFor(option)) || pricingHostOfUrl(seed) === pricingHostFor(option), seed)
  }
  // What counts as "this page states a price": the unit matters, not the vendor.
  assert.equal(hasPricingSeedText('输入价约 0.8 元/百万 tokens'), true)
  assert.equal(hasPricingSeedText('$0.5 per 1M input tokens'), true)
  assert.equal(hasPricingSeedText('每 1000 tokens 收费 0.002 元'), true)
  assert.equal(hasPricingSeedText('火山方舟提供模型推理、微调与部署能力'), false)
  assert.equal(hasPricingSeedText(''), false)
  assert.equal(hasPricingSeedText(null), false)
})

// 0.9.8 — a price table reaches the pipeline as one flattened line per <tr>
// (`</tr>` becomes a newline, every <td> a space). Each row is a few dozen
// characters, far below the 60/120-character paragraph gate, so the vendor's own
// price page (0.9.7: 豆包 seed, S5, 官方) produced zero evidence.
const VOLC_PRICING_URL = 'https://www.volcengine.com/docs/82379/1099320'
const VOLC_TITLE = '豆包大模型价格 - 火山引擎'

function volcPricingPage(text, extra = {}) {
  return { ...evidencePage(VOLC_PRICING_URL, text, extra), title: VOLC_TITLE }
}

test('a price table yields pricing evidence rows with model and both prices (0.9.8)', async () => {
  const page = volcPricingPage([
    '豆包大模型',
    '模型 输入价格 输出价格',
    'doubao-pro-32k 0.0008 元/千 tokens 0.002 元/千 tokens',
    'doubao-lite-128k 0.0003 元/千 tokens 0.0006 元/千 tokens',
  ].join('\n'))
  const items = await extractEvidence([page], null, { client: { jsonCall: async () => [] } })
  const rows = items.filter((item) => item.type === 'pricing')
  // One item per model, not one blob for the table.
  assert.equal(rows.length, 2)
  assert.match(rows[0].claim, /doubao-pro-32k/)
  assert.match(rows[0].claim, /输入 0\.0008/)
  assert.match(rows[0].claim, /输出 0\.002/)
  // The quote is the printed row, still grounded in the page text.
  assert.match(rows[0].quote, /0\.0008 元\/千 tokens/)
  assert.ok(page.text.includes(rows[0].quote))
  // Pipe-separated and space-separated cells are the same row: the regexes anchor
  // on the token unit, so the delimiter between cells does not matter.
  const piped = volcPricingPage('doubao-pro-32k | 0.0008 元/千 tokens | 0.002 元/千 tokens')
  const pipedRows = (await extractEvidence([piped], null, { client: { jsonCall: async () => [] } }))
    .filter((item) => item.type === 'pricing')
  assert.equal(pipedRows.length, 1)
  assert.equal(pipedRows[0].claim, 'doubao-pro-32k 输入 0.0008 元/千 tokens，输出 0.002 元/千 tokens')
  // The row quotes a codename while the option is the Chinese vendor name; the
  // page title is what lets the option gate see that this page is about 豆包.
  assert.ok(countOptionHits('豆包', groupEvidence(rows)) > 0)
})

test('a seeded page is price-scanned even off a vendor pricing host (0.9.8)', async () => {
  const body = 'qwen-max 0.02 元/千 tokens 0.06 元/千 tokens'
  const seeded = evidencePage('https://example.com/price', body, { via: 'seed' })
  const seededItems = await extractEvidence([seeded], null, { client: { jsonCall: async () => [] } })
  assert.equal(seededItems.filter((item) => item.type === 'pricing').length, 1)
  // The very same body on an ordinary page is not first-party pricing.
  const plainItems = await extractEvidence([evidencePage('https://example.com/blog', body)], null, { client: { jsonCall: async () => [] } })
  assert.deepEqual(plainItems, [])
})

test('short navigation lines are never evidence (0.9.8)', async () => {
  const nav = ['首页 | 产品 | 文档', '首页 | 产品 | 文档', '首页 | 产品 | 文档'].join('\n')
  const items = await extractEvidence([evidencePage('https://example.com/', nav)], null, { client: { jsonCall: async () => [] } })
  assert.deepEqual(items, [])
})

test('a long paragraph keeps the first evidence slot, price rows are appended (0.9.8)', async () => {
  const paragraph = '火山方舟是字节跳动旗下的模型服务平台，提供模型推理、微调、批量推理与上下文缓存等能力，支持多地域部署与按量计费方式，适合企业与开发者使用。平台同时提供模型评测、安全审核与可观测能力，帮助团队把模型接入生产环境，并按调用量计费，也支持包年包月与预留实例等计费模式。'
  assert.ok(paragraph.length >= 120, 'fixture must pass the standard paragraph gate')
  const page = volcPricingPage(`${paragraph}\n\n模型 输入价格 输出价格\ndoubao-pro-32k 0.0008 元/千 tokens 0.002 元/千 tokens`)
  const items = await extractEvidence([page], null, { client: { jsonCall: async () => [] } })
  // Both kinds survive: the paragraph is not replaced by the rows.
  assert.equal(items.length, 2)
  assert.equal(items[0].type, 'blog')
  assert.equal(items[0].quote, paragraph)
  assert.equal(items[1].type, 'pricing')
  assert.match(items[1].claim, /doubao-pro-32k/)
})

test('price rows are capped at eight per page, each clipped to 120 chars (0.9.8)', async () => {
  const body = Array.from({ length: 12 }, (_, n) => `doubao-model-${n + 1} ${n + 1}.5 元/百万 tokens`).join('\n')
  const items = await extractEvidence([volcPricingPage(body)], null, { client: { jsonCall: async () => [] } })
  const rows = items.filter((item) => item.type === 'pricing')
  assert.equal(rows.length, 8)
  // A block made only of price rows is a table, not a paragraph: no blob claim.
  assert.equal(items.length, 8)
  assert.ok(rows.every((item) => item.quote.length <= 120))
})

test('a monthly plan price is not read as a token price (0.9.8)', async () => {
  const page = volcPricingPage('专业版套餐 199 元/月，赠送 100 万 tokens 额度')
  const items = await extractEvidence([page], null, { client: { jsonCall: async () => [] } })
  assert.deepEqual(items, [])
})

// --- 1.1.0: pricing render fallback -----------------------------------------

const RENDER_SEED = 'https://api-docs.deepseek.com/quick_start/pricing'

function renderedPricingText() {
  return [
    'Title: DeepSeek API Pricing',
    `URL Source: ${RENDER_SEED}`,
    'Published Time: 2026-10-01T00:00:00Z',
    '',
    'Markdown Content:',
    'deepseek-chat 输入 1 元 / 百万 tokens，输出 2 元 / 百万 tokens。'.repeat(20),
  ].join('\n')
}

function failingSeedFetcher() {
  return async (url) => {
    if (/api-docs\.deepseek\.com|help\.aliyun\.com|bigmodel\.cn|volcengine\.com/.test(url)) {
      return { url, finalUrl: url, title: url, domain: new URL(url).hostname, ok: false, reason: 'JavaScript shell' }
    }
    return fakeFetcher()(url)
  }
}

function renderRaw(record, body = renderedPricingText()) {
  return async (url, options = {}) => {
    if (!String(url).startsWith('https://r.jina.ai/')) return { status: 404, body: '' }
    record.push({ url, accept: options.headers?.accept })
    return { status: 200, body }
  }
}

test('dead pricing seeds are rendered, and the render budget caps the renders (1.1.0)', async () => {
  const renders = []
  const config = baseConfig()
  config.__fetchPage = failingSeedFetcher()
  config.__fetchRaw = renderRaw(renders)
  const result = await runResearch({
    question: 'DeepSeek API 现在的输入价格是多少',
    depth: 'standard',
    config,
    llm: fakeLlm(defaultResponder),
    selection,
    logger: () => {},
  })
  // Four seeds fail; exactly RENDER_BUDGET = 2 renders are spent, in seed order.
  assert.equal(result.stats.renderUsed, 2, JSON.stringify(result.stats.renderUsed))
  assert.equal(renders.length, 2, JSON.stringify(renders))
  assert.equal(renders[0].url, `https://r.jina.ai/${RENDER_SEED}`)
  assert.equal(renders[0].accept, 'text/plain')
  // The funnel line tells the reader a proxy was involved.
  assert.match(result.brief, /渲染兜底 2/)
  // A rendered price page is read like any other page: it becomes a source.
  assert.ok(result.stats.pagesFetched >= 2, JSON.stringify(result.stats.pagesFetched))
})

test('a quick pricing run never renders, even when a seed is a JavaScript shell (1.1.0)', async () => {
  const renders = []
  const config = baseConfig()
  config.__fetchPage = failingSeedFetcher()
  config.__fetchRaw = renderRaw(renders)
  const result = await runResearch({
    question: 'DeepSeek API 现在的输入价格是多少',
    depth: 'quick',
    config,
    llm: fakeLlm(defaultResponder),
    selection,
    logger: () => {},
  })
  assert.equal(result.stats.renderUsed, 0)
  assert.equal(renders.length, 0)
  assert.doesNotMatch(result.brief, /渲染兜底/)
})

test('a non-pricing run never renders, even when config has a raw fetcher (1.1.0)', async () => {
  const renders = []
  const config = baseConfig()
  config.__fetchPage = async (url) => (String(url).includes('nodejs.org')
    ? { url, finalUrl: url, title: url, domain: 'nodejs.org', ok: false, reason: 'HTTP 503' }
    : fakeFetcher()(url))
  config.__fetchRaw = renderRaw(renders)
  const result = await runResearch({
    question: 'Node 22 是 LTS 吗？项目该用哪个版本',
    depth: 'standard',
    config,
    llm: fakeLlm(defaultResponder),
    selection,
    logger: () => {},
  })
  assert.equal(result.stats.renderUsed, 0)
  assert.equal(renders.length, 0)
  assert.doesNotMatch(result.brief, /渲染兜底/)
})

test('a failed render still charges the budget and keeps the original failure (1.1.0)', async () => {
  const renders = []
  const config = baseConfig()
  config.__fetchPage = failingSeedFetcher()
  config.__fetchRaw = renderRaw(renders, '')
  const result = await runResearch({
    question: 'DeepSeek API 现在的输入价格是多少',
    depth: 'standard',
    config,
    llm: fakeLlm(defaultResponder),
    selection,
    logger: () => {},
  })
  // Two renders went out (and failed), so two are charged — the cap is on
  // requests, not on successes.
  assert.equal(result.stats.renderUsed, 2)
  assert.equal(renders.length, 2)
  // The seeds are still reported as failed, with the pricing domain in the gaps.
  assert.ok(result.stats.sourceFailures >= 4, JSON.stringify(result.stats.sourceFailures))
  assert.ok(result.gaps.includes('官方价目页未取到：api-docs.deepseek.com'), result.gaps.join(' | '))
})

test('renderFallback:false disables the fallback entirely (1.1.0)', async () => {
  const renders = []
  const config = baseConfig()
  config.renderFallback = false
  config.__fetchPage = failingSeedFetcher()
  config.__fetchRaw = renderRaw(renders)
  const result = await runResearch({
    question: 'DeepSeek API 现在的输入价格是多少',
    depth: 'standard',
    config,
    llm: fakeLlm(defaultResponder),
    selection,
    logger: () => {},
  })
  assert.equal(result.stats.renderUsed, 0)
  assert.equal(renders.length, 0)
})

test('gradeSource downgrades a rendered source by exactly one grade (1.1.0)', () => {
  // 官方 → 论文, 仓库 → 论坛: the host claim is no longer independent of the proxy.
  assert.equal(gradeSource(RENDER_SEED, 'render'), '论文')
  assert.equal(gradeSource('https://github.com/owner/repo', 'render'), '论坛')
  // A weak source stays at the floor instead of burning a second notch.
  assert.equal(gradeSource('https://example.com/blog/post', 'render'), '网页')
  // `jina` keeps the 1.0.x rule: only 官方/论文 step down, and they step down once.
  assert.equal(gradeSource(RENDER_SEED, 'jina'), '论文')
  assert.equal(gradeSource('https://github.com/owner/repo', 'jina'), '仓库')
})

test('the reference line marks a rendered source with （渲染取回） (1.1.0)', () => {
  const brief = '## 结论\n- 一句话 [S1]'
  const sources = [
    { id: 'S1', url: RENDER_SEED, title: 'DeepSeek API Pricing', domain: 'api-docs.deepseek.com', via: 'render' },
    { id: 'S2', url: 'https://nodejs.org/en/download', title: 'Node downloads', domain: 'nodejs.org', via: 'raw' },
  ]
  const out = appendReferences(brief, sources)
  assert.match(out, /（论文 · api-docs\.deepseek\.com）（渲染取回）/)
  assert.doesNotMatch(out, /nodejs\.org（[^）]*）（渲染取回）/)
})

test('the funnel line carries the render count only when it is non-zero (1.1.0)', () => {
  const base = { identified: 5, deduped: 4, readable: 3, adopted: 1 }
  assert.doesNotMatch(formatRetrievalFlow(base), /渲染兜底/)
  // Without renderAdopted (a stats object from an older caller) the count stands
  // alone: an unknown adoption is not annotated.
  assert.match(formatRetrievalFlow({ ...base, renderUsed: 2 }), / · 渲染兜底 2$/)
  assert.match(formatRetrievalFlow({ ...base, renderUsed: 1 }), / · 渲染兜底 1$/)
})

// 1.1.1 — the reported run showed 「渲染兜底 1」 while 参考 carried no （渲染取回）
// mark: the rendered page was never adopted. The funnel now says so.
test('the funnel marks a render fallback that adopted nothing (1.1.1)', () => {
  const base = { identified: 5, deduped: 4, readable: 3, adopted: 1, renderUsed: 1 }
  assert.match(formatRetrievalFlow({ ...base, renderAdopted: 0 }), / · 渲染兜底 1（未采用）$/)
  assert.match(formatRetrievalFlow({ ...base, renderUsed: 2, renderAdopted: 0 }), / · 渲染兜底 2（未采用）$/)
  // An adopted render keeps the plain count — that page is in 参考 with its mark.
  const adopted = formatRetrievalFlow({ ...base, renderAdopted: 1 })
  assert.match(adopted, / · 渲染兜底 1$/)
  assert.doesNotMatch(adopted, /未采用/)
})
