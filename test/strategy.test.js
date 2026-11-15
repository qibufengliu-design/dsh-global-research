import test from 'node:test'
import assert from 'node:assert/strict'
import {
  autoDepthOf, classify, isCodeish, isFollowUp, isLegalText, isPricingQuestion, isTimeSensitive, normalizeMode,
  resolveStrategy,
} from '../lib/strategy.js'
import { PRICING_SEEDS, QUESTION_KINDS, STRATEGY_DEFAULTS } from '../lib/strategies.js'
import { DEPTH_PROFILES, buildQueries, resolveDepth, runResearch, strategyDirectedQueries } from '../lib/pipeline.js'

/*
 * Frozen copies of the six predicates this module replaces. They are the
 * specification: the classifier must agree with them on every input, quirks
 * included. Do not "improve" them here — that would hide a behaviour change.
 */
const OLD_DEEP_SIGNALS = /对比|选型|调研|方案|迁移|替代|是否值得|取舍|优劣|benchmark|\bvs\.?\b|compare|comparison|migrate|migration|alternatives?|trade-?offs?|which .* should/i
const OLD_QUICK_SIGNALS = /是什么|多少|哪一年|谁|定义|what is|who is|how many|when did/i
const OLD_LEGAL_HINTS = /法规|条例|指令|法案|合规|认证|监管|标准原文|regulation|directive|compliance|certification|eur-lex|gdpr|ai act|\bcra\b/i
const OLD_TIME_SENSITIVE = /最新|当前|目前|现在|今年|本月|本周|今天|刚刚|发布|上线|价格|定价|收费|支持到|EOL|过期|停止维护|latest|current|today|this (week|month|year)|release[ds]?|price|pricing|cost|end of life|deprecated/i
const OLD_CODEISH = /github|npm|pip|library|库|包|api|sdk|报错|error/i
const OLD_FOLLOW_UP = /(上面|上述|前述|刚才|前面|第\s*[一二三四五六七八九十0-9]+\s*条|展开(说|讲)|这个(方案|结论|说法|观点)|把它|它(指|说|再)|继续(展开|说说)|接上|上一条)/u

function oldAutoDepth(question, focus = []) {
  const text = String(question ?? '')
  if (OLD_DEEP_SIGNALS.test(text) || focus.length >= 2) return 'deep'
  const constraintCount = (text.match(/[必须需限]/g) ?? []).length
  if (constraintCount >= 2) return 'deep'
  if (text.length < 60 && OLD_QUICK_SIGNALS.test(text)) return 'quick'
  return 'standard'
}

function oldFollowUp(question) {
  const text = String(question ?? '').trim()
  if (text.length === 0 || text.length > 80) return false
  return OLD_FOLLOW_UP.test(text)
}

test('classify recognises every shipped question kind', () => {
  const cases = [
    ['pnpm vs yarn vs bun，2026 年该选哪个？', 'tech-selection'],
    ['Node 22 现在的最新版本是多少？', 'fresh-data'],
    ['qwen、豆包、deepseek 的 API 价格谁便宜？', 'pricing'],
    ['有人说 TypeScript 比 JavaScript 更好，这种说法有争议吗？', 'contested'],
    ['CRA 合规要求有哪些？', 'legal'],
    ['升级到 Node 22 后 build 报错怎么修', 'troubleshoot'],
    ['零基础怎么学 Rust？', 'learning'],
    ['我们团队 8 个人，微服务该不该拆', 'decision'],
    ['TypeScript 是什么？', 'concept'],
  ]
  for (const [question, expected] of cases) {
    const result = classify({ question })
    assert.equal(result.questionKind, expected, `kind for ${question}`)
    assert.equal(result.source, 'regex')
    assert.ok(result.confidence >= 0.5, `confidence for ${question}`)
  }
  // A decisive legal citation beats an incidental comparison in the same text.
  assert.equal(classify({ question: 'GDPR vs 国内数据合规，哪个要求更严？' }).questionKind, 'legal')
})

test('depthHint mirrors the old autoDepth(), quirks included', () => {
  const corpus = [
    'pnpm vs yarn vs bun，2026 年该选哪个？',
    'TypeScript 是什么？',
    '如何配置 DSH 插件的工具注册方式，需要哪些字段和注意事项',
    '对比 A 和 B',
    '系统限 3 个并发', // one constraint char only: not deep
    '必须限 3 个并发', // two constraint chars: deep
    '请说明我们需要限制哪些接口必须鉴权', // 3 hits of 必须需限: deep
    'Node 22 的 EOL 是哪天？',
    'what is the difference between a and b',
    '这个方案有哪些取舍？',
    '这是一段足够长的问题描述，用来验证长度小于六十个字符这条规则只作用于短问题，'.repeat(2)
      + '它自己是什么？',
    '',
  ]
  for (const question of corpus) {
    assert.equal(autoDepthOf(question), oldAutoDepth(question), `depth for ${question}`)
    assert.equal(classify({ question }).depthHint, oldAutoDepth(question), `depthHint for ${question}`)
  }
  // focus length is the second deep signal, and only its length matters.
  assert.equal(autoDepthOf('随便一个问题', ['a', 'b']), 'deep')
  assert.equal(autoDepthOf('随便一个问题', ['a']), 'standard')
  assert.equal(autoDepthOf('随便一个问题', ['a', 'b']), oldAutoDepth('随便一个问题', ['a', 'b']))
})

test('mirrored predicates are byte-for-byte the old ones', () => {
  const texts = [
    'Node 22 现在的最新版本是多少？',
    'EUR-Lex 上的 CRA 原文',
    'npm install 报错',
    '上面第 2 条依据展开说说',
    '把它再展开一下',
    'Node 22 的 EOL 是哪天？',
    '一段超过八十个字符的问题……上面提到的方案还需要展开说说吗？我们想知道迁移成本和迁移路径以及兼容性细节，以及回滚方案是否可行，谢谢。',
    '',
  ]
  for (const text of texts) {
    assert.equal(isTimeSensitive(text), OLD_TIME_SENSITIVE.test(String(text ?? '')), `time for ${text}`)
    assert.equal(isLegalText(text), OLD_LEGAL_HINTS.test(text), `legal for ${text}`)
    assert.equal(isCodeish(text), OLD_CODEISH.test(text), `codeish for ${text}`)
    assert.equal(isFollowUp(text), oldFollowUp(text), `follow-up for ${text}`)
  }
  // The 80-char cap is part of the old behaviour, not a new detail.
  assert.equal(isFollowUp('上面提到的方案还需要展开说说吗？'.padEnd(81, '啊')), false)
})

test('unknown, empty and signal-free questions fall back to concept', () => {
  for (const question of ['', '嗯', '???', '好的谢谢']) {
    const result = classify({ question })
    assert.equal(result.questionKind, 'concept', `kind for ${JSON.stringify(question)}`)
    assert.equal(result.source, 'fallback')
    assert.equal(result.confidence, 0.35)
    assert.ok(result.signals.includes('fallback:no-signal'))
  }
  // An illegal llmKind never invents a vocabulary.
  assert.equal(classify({ question: '嗯', llmKind: 'not-a-kind' }).source, 'fallback')
  const fromLlm = classify({ question: '嗯', llmKind: 'legal' })
  assert.equal(fromLlm.questionKind, 'legal')
  assert.equal(fromLlm.source, 'llm')
})

test('mode is normalised and illegal modes fall back to explain', () => {
  assert.equal(normalizeMode('compare'), 'compare')
  assert.equal(normalizeMode('TRACK'), 'explain')
  assert.equal(normalizeMode(undefined), 'explain')
  assert.equal(normalizeMode('nonsense'), 'explain')
  assert.equal(normalizeMode('nonsense', 'track'), 'track')
  assert.deepEqual(
    [...new Set(['explain', 'compare', 'track', 'evaluate', 'bogus'].map((mode) => normalizeMode(mode)))].sort(),
    ['compare', 'evaluate', 'explain', 'track'],
  )
})

test('resolveStrategy keeps the concept strategy identical to the defaults', () => {
  const concept = resolveStrategy({ questionKind: 'concept', depth: 'auto' })
  assert.deepEqual(concept, STRATEGY_DEFAULTS)
  assert.equal(concept.reason, 'fallback:no-signal')
  // Unknown kinds degrade to concept and say why.
  const unknown = resolveStrategy({ questionKind: 'not-a-kind', depth: 'auto' })
  assert.equal(unknown.questionKind, 'concept')
  assert.equal(unknown.reason, 'fallback:unknown-kind')
  // Every shipped kind resolves to itself and keeps the mirrored defaults.
  for (const kind of QUESTION_KINDS) {
    const strategy = resolveStrategy({ questionKind: kind, depth: 'auto', confidence: 0.7 })
    assert.equal(strategy.questionKind, kind)
    assert.equal(strategy.signalVersion, STRATEGY_DEFAULTS.signalVersion)
    assert.equal(strategy.confidence, 0.7)
    assert.deepEqual(strategy.depth.floor, 'quick')
    assert.deepEqual(strategy.depth.ceiling, 'deep')
    assert.equal(strategy.pages.reserve.primary, kind === 'legal' ? 2 : STRATEGY_DEFAULTS.pages.reserve.primary)
  }
  assert.equal(resolveStrategy({ questionKind: 'tech-selection' }).mode, 'compare')
  assert.equal(resolveStrategy({ questionKind: 'tech-selection', mode: 'track' }).mode, 'track')
  assert.equal(resolveStrategy({ questionKind: 'tech-selection', mode: 'bogus' }).mode, 'explain')
  assert.equal(resolveStrategy({ questionKind: 'concept' }).mode, 'explain')
})

test('depth bias only moves an auto-derived request, then clamps to the pack', () => {
  const biased = resolveStrategy({ questionKind: 'tech-selection' })
  const loose = { depth: { bias: 5, floor: 'quick', ceiling: 'standard' } }
  assert.equal(resolveDepth({ depth: 'auto', question: '随便', focus: [], config: {}, strategy: biased }), 'deep')
  // An explicit depth is the user's decision: no bias, no downgrade.
  assert.equal(resolveDepth({ depth: 'standard', question: '随便', focus: [], config: {}, strategy: biased }), 'standard')
  assert.equal(resolveDepth({ depth: 'auto', question: '是什么', focus: [], config: {}, strategy: loose }), 'standard')
  // deepUsed still caps the biased result.
  assert.equal(
    resolveDepth({ depth: 'auto', question: '随便', focus: [], config: { maxDeepPerSession: 1 }, deepUsed: 1, strategy: biased }),
    'standard',
  )
  // The shared profile table (and the deep wall-clock) is never rewritten.
  // 0.9.5 — the wall budget grew to 120/240/360s after a standard run hit the
  // 180s ceiling during evidence extraction; the ordering is the invariant.
  assert.equal(DEPTH_PROFILES.quick.wallMs, 120000)
  assert.equal(DEPTH_PROFILES.standard.wallMs, 240000)
  assert.equal(DEPTH_PROFILES.deep.wallMs, 360000)
  assert.ok(DEPTH_PROFILES.quick.wallMs < DEPTH_PROFILES.standard.wallMs)
  assert.ok(DEPTH_PROFILES.standard.wallMs < DEPTH_PROFILES.deep.wallMs)
  assert.equal(DEPTH_PROFILES.quick.queries, 2)
})

test('buildQueries keeps the inline code-ish suffix, then lets the strategy steer it', () => {
  const subs = [{ q: 'npm install 报错' }, { q: 'Node LTS 版本' }]
  const legacy = buildQueries(subs, ['性能'], 'Node 22 还是 24？', 12)
  // A concept strategy carries no overrides, so the output is identical.
  assert.deepEqual(buildQueries(subs, ['性能'], 'Node 22 还是 24？', 12, resolveStrategy({ questionKind: 'concept' })), legacy)
  assert.ok(legacy.some((query) => query === 'npm install 报错 site:github.com'))
  assert.ok(legacy.some((query) => query === 'Node LTS 版本 官方'))
  // The old inline regex and the shared one agree on every sub-question.
  for (const sub of subs) assert.equal(isCodeish(sub.q), OLD_CODEISH.test(sub.q))
  // A pack can force the suffix and drop the Latin boost. (Strategy objects are
  // frozen, so build the variant explicitly rather than mutating one.)
  const base = resolveStrategy({ questionKind: 'concept' })
  const forced = {
    ...base,
    queries: { ...base.queries, codeish: true, latinBoost: false, perSubVariants: ['sub', 'site|official'] },
  }
  const steered = buildQueries(subs, [], 'Node 22 还是 24？', 12, forced)
  assert.ok(steered.includes('Node LTS 版本 site:github.com'))
  assert.ok(steered.every((query) => /[\u4e00-\u9fff]/.test(query)), 'no invented Latin query')
})

test('classify reports the signals and keywords that drove the kind', () => {
  const result = classify({ question: 'pnpm vs yarn vs bun，2026 年该选哪个？' })
  assert.ok(result.signals.includes('kw:vs'), `signals: ${result.signals}`)
  assert.ok(result.keywords.includes('vs'))
  assert.equal(result.codeish, true)
  assert.equal(result.timeSensitive, false)
  assert.equal(result.margin > 0, true)
  assert.equal(result.signalVersion, STRATEGY_DEFAULTS.signalVersion)
  // focus.length >= 2 is a structural signal for tech-selection.
  assert.ok(classify({ question: '选哪个', focus: ['成本', '生态'] }).signals.includes('focus:>=2'))
  // An explicit mode nudges the kind without being required.
  assert.equal(classify({ question: 'React 还是 Vue', mode: 'compare' }).questionKind, 'tech-selection')
})

// 0.8.2 — the reported gap: a selection question with no `mode` fell through to
// concept because DEEP_SIGNALS never matched "该怎么选". Comparison wording plus
// a stack word is now decisive, and comparison wording alone still routes to the
// selection pack (there is no `comparison` kind, and that pack is the policy
// that actually compares options).
test('selection/comparison wording is classified without an explicit mode (0.8.2)', () => {
  const rag = classify({ question: 'Java 后端做 RAG 应用，Spring AI、LangChain4j、Haystack 该怎么选' })
  assert.equal(rag.questionKind, 'tech-selection')
  assert.equal(rag.mode, 'compare')
  assert.equal(rag.source, 'regex')
  assert.ok(rag.signals.includes('kw:compare'), JSON.stringify(rag.signals))
  assert.ok(rag.signals.includes('kw:tech'), JSON.stringify(rag.signals))

  // No technology word: still a comparison, so still the selection pack.
  const hbase = classify({ question: 'HBase 和 Cassandra 哪个好' })
  assert.equal(hbase.questionKind, 'tech-selection')
  assert.equal(hbase.mode, 'compare')
  assert.ok(hbase.signals.includes('kw:compare:no-tech'), JSON.stringify(hbase.signals))

  // Three parallel options are themselves a comparison signal.
  const list = classify({ question: 'A、B、C 该怎么选' })
  assert.equal(list.questionKind, 'tech-selection')
  assert.equal(list.mode, 'compare')
  assert.ok(list.signals.includes('options:>=3'), JSON.stringify(list.signals))
  assert.ok(classify({ question: 'A/B/C 哪个好' }).signals.includes('options:>=3'))

  // Concept questions keep explain, and an explicit mode is never second-guessed.
  assert.equal(classify({ question: 'TypeScript 是什么？' }).mode, 'explain')
  const explained = classify({ question: 'Java 后端做 RAG 应用，Spring AI、LangChain4j、Haystack 该怎么选', mode: 'explain' })
  assert.equal(explained.questionKind, 'concept')
  assert.equal(explained.mode, 'explain')
  // Timing words under an explicit non-compare mode stay with the time pack.
  assert.equal(classify({ question: 'HBase 和 Cassandra 哪个好', mode: 'track' }).questionKind, 'fresh-data')
})

// 0.8.3 — the reported misclassification: "国内大模型 API 价格对比：qwen、豆包、
// deepseek 哪家便宜" was read as tech-selection (the stack word + 对比 won), so
// the official-docs channel crawled docs.spring.io / docs.langchain4j.dev for a
// question about money: nine adopted doc pages, none about pricing.
test('price questions are pricing, never a tech selection, and drop the doc channel (0.8.3)', () => {
  const price = '国内大模型 API 价格对比：qwen、豆包、deepseek 哪家便宜'
  const result = classify({ question: price })
  assert.equal(result.questionKind, 'pricing')
  assert.equal(result.mode, 'compare')
  assert.equal(result.source, 'regex')
  assert.equal(result.pricing, true)
  assert.ok(result.signals.includes('kw:pricing'), JSON.stringify(result.signals))
  // The stack word and the comparison verb are still scored — they just lose.
  assert.ok(result.scores['tech-selection'] > 0, JSON.stringify(result.scores))
  assert.ok(result.scores.pricing > 0, JSON.stringify(result.scores))

  // A stack name does not pull a price question back to tech-selection.
  const spring = classify({ question: 'Spring AI 收费吗' })
  assert.equal(spring.questionKind, 'pricing')
  assert.equal(spring.mode, 'explain')

  // "Whose price is cheaper" is a compare run with the price pack.
  const twoVendors = classify({ question: '两家价格谁便宜' })
  assert.equal(twoVendors.questionKind, 'pricing')
  assert.equal(twoVendors.mode, 'compare')

  // A legal question that mentions money keeps its legal precedence.
  assert.equal(classify({ question: 'CRA 合规要花多少钱' }).questionKind, 'legal')

  // The resolved pack keeps the price channel and never the documentation one.
  const pricing = resolveStrategy({ questionKind: result.questionKind, depth: 'standard', mode: result.mode, question: price })
  const pricingChannels = pricing.sourcePlan.channels.map((channel) => channel.id)
  assert.ok(pricingChannels.includes('pricing'), JSON.stringify(pricingChannels))
  assert.ok(!pricingChannels.includes('official-docs'), JSON.stringify(pricingChannels))

  // Even a forced tech-selection (caller override) cannot keep the docs channel.
  const forced = resolveStrategy({ questionKind: 'tech-selection', depth: 'standard', question: 'Spring AI 和 LangChain4j 收费对比' })
  const forcedChannels = forced.sourcePlan.channels.map((channel) => channel.id)
  assert.ok(forcedChannels.includes('pricing'), JSON.stringify(forcedChannels))
  assert.ok(!forcedChannels.includes('official-docs'), JSON.stringify(forcedChannels))

  // A non-price selection question is untouched (the A question of the report).
  const selection = resolveStrategy({
    questionKind: 'tech-selection',
    depth: 'standard',
    question: 'Java 后端做 RAG 应用，Spring AI、LangChain4j、Haystack 该怎么选',
  })
  assert.deepEqual(selection.sourcePlan.channels.map((channel) => channel.id), ['official-docs'])

  // The widened vocabulary from the task, one token at a time.
  for (const text of ['免费额度有多少', '每百万 token 多少钱', 'per token 的价格', '/1k tokens 怎么计费', '成本']) {
    assert.equal(isPricingQuestion(text), true, text)
  }
})

/* ------------------------------------------------------------------ *
 * The wiring test: runResearch() has to pass the resolved pack into
 * resolveDepth(). The unit test above proves applyDepthBias() works; this
 * one proves the pipeline actually calls it (PR3 regression guard).
 * ------------------------------------------------------------------ */

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

const FAKE_TITLES = ['Node LTS release notes', 'Node LTS docs', 'Node LTS community']

function fakeEngine(urls) {
  return {
    name: 'fake',
    available: () => true,
    search: async () => urls.map((url, index) => ({
      url, title: FAKE_TITLES[index % FAKE_TITLES.length], snippet: 'snippet', engine: 'fake', rank: index + 1,
    })),
  }
}

function fakeFetcher(url) {
  return {
    url, finalUrl: url, title: `page ${url}`, domain: new URL(url).hostname, ok: true,
    text: `Node 22 entered LTS in October 2025. Node 22 is the active LTS line and keeps receiving security fixes until April 2027; after that it moves to maintenance. A team picking a runtime for a new backend service should weigh that remaining window against its upgrade cadence. Source: ${url}`,
  }
}

function fakeConfig() {
  return {
    maxDeepPerSession: 3,
    __engines: [fakeEngine(['https://nodejs.org/1', 'https://github.com/x/y', 'https://a.com/3'])],
    __fetchPage: async (url) => fakeFetcher(url),
  }
}

function responders() {
  return {
    analysis: JSON.stringify({
      subQuestions: [{ q: 'Node LTS 版本有哪些？', why: '确定基线', evidence: 'docs' }],
      constraints: ['需要长期支持'],
      criteria: ['稳定性'],
      language: 'zh',
    }),
    evidence: JSON.stringify([
      { claim: 'Node 22 是当前 LTS 版本', quote: 'Node 22 entered LTS in October 2025.', source: 0, type: 'docs', stance: 'support' },
      { claim: 'Node 22 是当前 LTS 版本', quote: 'Node 22 is the active LTS line.', source: 1, type: 'docs', stance: 'support' },
    ]),
    synth: [
      '## 结论',
      'Node 22 是当前 LTS [S1][S2]。',
      '',
      '## 依据',
      '- 官方发布说明确认 [S1]',
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
    ].join('\n'),
  }
}

function defaultResponder(options) {
  const prompt = options.user ?? ''
  const reply = responders()
  if (prompt.includes('<untrusted>')) return reply.evidence
  if (prompt.includes('拆解')) return reply.analysis
  if (prompt.includes('缺口')) return JSON.stringify({ queries: [], reason: '无' })
  if (prompt.includes('研究简报')) return reply.synth
  return '{}'
}

test('runResearch applies a pack depth bias to an auto-derived quick run, then clamps it', async () => {
  const strategy = resolveStrategy({ questionKind: 'tech-selection', depth: 'auto' })
  // Same pack with a bias far past the ceiling: the pack's ceiling must win.
  const clamped = { ...strategy, depth: { ...strategy.depth, bias: 5, ceiling: 'standard' } }
  const run = (extra) => runResearch({
    question: 'Node 22 是什么',
    config: fakeConfig(),
    llm: fakeLlm(defaultResponder),
    selection: { provider: 'test', model: 'test-model' },
    logger: () => {},
    ...extra,
  })
  const plain = await run()
  assert.equal(plain.depthUsed, 'quick')
  const biased = await run({ strategy })
  assert.equal(biased.depthUsed, 'standard')
  const capped = await run({ strategy: clamped })
  assert.equal(capped.depthUsed, 'standard')
})

test('only pricing questions get official price-list seeds', () => {
  assert.ok(isPricingQuestion('DeepSeek API 输入价格是多少'))
  assert.ok(isPricingQuestion('AWS Lambda 按量计费怎么算'))
  assert.ok(!isPricingQuestion('Node 22 什么时候发布'))
  assert.ok(!isPricingQuestion('什么是 JavaScript 事件循环'))

  // Default: every kind ships an empty seed list, so direct-URL fetching is
  // untouched for everything that is not a pricing question.
  assert.deepEqual(STRATEGY_DEFAULTS.sources.officialSeeds, [])
  for (const kind of QUESTION_KINDS) {
    const strategy = resolveStrategy({ questionKind: kind })
    assert.deepEqual(strategy.sources.officialSeeds, [], kind)
  }

  const pricing = resolveStrategy({ questionKind: 'fresh-data', question: 'DeepSeek 和 Qwen 的输入价格谁便宜' })
  assert.deepEqual(pricing.sources.officialSeeds, PRICING_SEEDS)
  assert.equal(pricing.sources.officialSeeds.length, 4)

  // Version/release questions keep the existing official-domain rule: no seeds.
  const release = resolveStrategy({ questionKind: 'fresh-data', question: 'Node 22 什么时候发布' })
  assert.deepEqual(release.sources.officialSeeds, [])
})

/* ------------------------------------------------------------------ *
 * 0.10.0 — decision: 该不该 / 要不要 / 值不值得. Before it, the C 题
 * 「我们团队 8 个人，微服务该不该拆」 scored 0 on every kind and fell back
 * to concept (confidence 0.35); the cost columns came from a wording patch.
 * ------------------------------------------------------------------ */

test('0.10.0 — judgement wording names the decision kind, with a two-tier signal', () => {
  const c = classify({ question: '我们团队 8 个人，微服务该不该拆' })
  assert.equal(c.questionKind, 'decision')
  assert.equal(c.source, 'regex')
  // 该不该 (5) + 团队 (1): the auxiliary tier reinforced, it did not decide.
  assert.deepEqual(c.scores.decision, 6)
  assert.ok(c.confidence >= 0.7, `confidence ${c.confidence}`)
  assert.ok(c.signals.includes('kw:decision'))
  assert.ok(c.signals.includes('kw:decision-context'))

  // The auxiliary tier alone is below the acceptance threshold: a question that
  // merely mentions 团队/规模 must not become a decision question.
  const auxOnly = classify({ question: '团队规模多大' })
  assert.notEqual(auxOnly.questionKind, 'decision')
  assert.equal(auxOnly.scores.decision, 1)

  // Priority: pricing still outranks decision (a price question is decided by a
  // price page, not by thresholds); decision outranks tech-selection.
  assert.equal(classify({ question: '该不该买 DeepSeek API，多少钱' }).questionKind, 'pricing')
  assert.equal(classify({ question: '要不要上 Kubernetes' }).questionKind, 'decision')
})

test('0.10.0 — sentence-level regression: decision does not steal the other classes', () => {
  // The three questions the 0.9.10 report pinned as regressions must not move.
  assert.equal(classify({ question: '如何学习 Java' }).questionKind, 'learning')
  assert.equal(classify({ question: 'A 和 B 哪个好' }).questionKind, 'tech-selection')
  assert.equal(classify({ question: '多少钱' }).questionKind, 'pricing')

  // 该不该用 React names ONE option: it asks for a verdict, so it is a decision,
  // not a selection (the tech-selection pack would build a one-row table and ask
  // "在 X 条件下选 A，在 Y 条件下选 B" for a single candidate).
  assert.equal(classify({ question: '该不该用 React' }).questionKind, 'decision')
  // A real head-to-head carries no 该不该/要不要 wording, so it stays a selection.
  assert.equal(classify({ question: 'React 还是 Vue 哪个好' }).questionKind, 'tech-selection')
})

test('0.10.0 — the decision pack adds criteria queries and no source channel', () => {
  const question = '我们团队 8 个人，微服务该不该拆'
  const strategy = resolveStrategy({ questionKind: 'decision', question })
  assert.equal(strategy.reason, 'kind:decision')
  assert.equal(strategy.mode, 'explain')
  // Same depth as concept: a decision answer gains from thresholds, not pages.
  assert.equal(strategy.depth.bias, resolveStrategy({ questionKind: 'concept' }).depth.bias)
  // No official-docs channel: the evidence is principles and counter-examples.
  assert.deepEqual(strategy.sourcePlan.channels, [])
  assert.deepEqual(strategy.queries.extraTemplates, [
    '{q} 何时该拆 微服务',
    '{q} 团队规模 阈值',
    '{q} 反例 失败',
    '{q} trade-offs',
  ])
  const directed = strategyDirectedQueries(strategy.queries, question, new Date('2026-11-16'))
  assert.deepEqual(directed, [
    `${question} 何时该拆 微服务`,
    `${question} 团队规模 阈值`,
    `${question} 反例 失败`,
    `${question} trade-offs`,
  ])
  // The thresholds lead a capped plan; the raw question is only the fallback.
  const plan = buildQueries([], [], question, 6, strategy)
  assert.deepEqual(plan.slice(0, 4), directed)
  assert.equal(plan[4], question)
})