import test from 'node:test'
import assert from 'node:assert/strict'
import {
  autoDepthOf, classify, isCodeish, isFollowUp, isLegalText, isTimeSensitive, normalizeMode,
  resolveStrategy,
} from '../lib/strategy.js'
import { QUESTION_KINDS, STRATEGY_DEFAULTS } from '../lib/strategies.js'
import { DEPTH_PROFILES, buildQueries, resolveDepth } from '../lib/pipeline.js'

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

test('classify recognises all seven question kinds', () => {
  const cases = [
    ['pnpm vs yarn vs bun，2026 年该选哪个？', 'tech-selection'],
    ['Node 22 现在的最新版本是多少？', 'fresh-data'],
    ['有人说 TypeScript 比 JavaScript 更好，这种说法有争议吗？', 'contested'],
    ['CRA 合规要求有哪些？', 'legal'],
    ['升级到 Node 22 后 build 报错怎么修', 'troubleshoot'],
    ['零基础怎么学 Rust？', 'learning'],
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
  assert.equal(DEPTH_PROFILES.deep.wallMs, 300000)
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