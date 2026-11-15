import test from 'node:test'
import assert from 'node:assert/strict'
import { runResearch, groupEvidence, looksLikeFollowUp, extractEvidence } from '../lib/pipeline.js'
import { downgradeConfidence } from '../lib/brief.js'
import { resolveStrategy } from '../lib/strategy.js'
import { rankHits } from '../lib/util.js'

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
    'Node 22 是当前 LTS，建议在长期支持项目中使用 [S1][S2]。',
    '',
    '## 依据',
    '- 官方发布说明确认 [S1]',
    '- 文档页确认 [S2]',
    '',
    '## 方案对比',
    '不适用',
    '',
    '## 坑与风险',
    '未发现',
    '',
    '## 置信度',
    'high',
    '',
    '## 未解决',
    '无',
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

function fakeEngine(urls) {
  return {
    name: 'fake',
    available: () => true,
    search: async () => urls.map((url, index) => ({
      url, title: FAKE_TITLES[index % FAKE_TITLES.length], snippet: 'snippet', engine: 'fake', rank: index + 1,
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
  assert.match(result.brief, new RegExp(`> 检索流程：.*· 官方采用 ${result.stats.officialAdopted}/3$`, 'm'))
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
