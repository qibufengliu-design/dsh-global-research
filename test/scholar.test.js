import test from 'node:test'
import assert from 'node:assert/strict'
import { classify, resolveStrategy } from '../lib/strategy.js'
import {
  KIND_PRIORITY, QUESTION_KINDS, SIGNAL_VERSION, STRATEGIES,
} from '../lib/strategies.js'
import { pickVerticals } from '../lib/verticals.js'
import { synthPrompt } from '../lib/prompts.js'
import { computeConfidence, requiredSectionsFor } from '../lib/brief.js'
import { QUESTIONS } from '../scripts/eval.mjs'

/*
 * 1.1.3 — the `scholar` question kind. The point of the kind is that an
 * academic question ("近年论文", "benchmark 综述", "papers about X") stops
 * landing in concept/learning, walks the papers channel, recruits the arXiv
 * and OpenAlex verticals, and gets a literature-review brief structure instead
 * of a selection report. These tests pin the classifier gates (including the
 * neighbours it must not steal from), the pack shape, and the prompt contract.
 */

const PAPER_QUESTION = 'RAG 长上下文检索的近年论文'

function prompt(extra = {}) {
  return synthPrompt({
    question: PAPER_QUESTION,
    focus: [],
    language: 'zh',
    clusters: [{ claim: '长上下文仍是瓶颈', status: 'confirmed', evidence: [{ id: 'S1', quote: 'q' }] }],
    constraints: [],
    criteria: [],
    sourceList: '[S1] arXiv 2404.16130 LongRoPE',
    depth: 'quick',
    questionKind: 'scholar',
    mode: 'explain',
    ...extra,
  })
}

/* --------------------------------------------------------------- registry */

test('scholar is registered as a kind and outranks the kinds it must beat', () => {
  assert.equal(SIGNAL_VERSION, 5)
  assert.ok(QUESTION_KINDS.includes('scholar'), QUESTION_KINDS.join(','))
  const rank = (kind) => KIND_PRIORITY.indexOf(kind)
  // 学术题常带「近年」：scholar 必须排在 fresh-data 之前，legal 仍最优先。
  assert.ok(rank('scholar') < rank('fresh-data'))
  assert.ok(rank('legal') < rank('scholar'))
  assert.ok(rank('scholar') < rank('troubleshoot'))
  assert.ok(rank('scholar') < rank('tech-selection'))
  assert.ok(rank('scholar') < rank('learning'))
  assert.ok(rank('scholar') < rank('concept'))
  assert.ok(Object.hasOwn(STRATEGIES, 'scholar'))
})

/* ----------------------------------------------------------- classifier */

test('the strong tier names a scholar question', () => {
  for (const question of [
    PAPER_QUESTION,
    '长上下文检索的 benchmark 数据集综述',
    'papers about retrieval augmented generation',
    'IEEE 802.11 的 meta-analysis 文献',
  ]) {
    const result = classify({ question })
    assert.equal(result.questionKind, 'scholar', question)
    assert.equal(result.source, 'regex', question)
    assert.ok(result.confidence >= 0.7, question)
    assert.ok(result.signals.includes('kw:scholar'), `${question} → ${result.signals.join(',')}`)
  }
  // 5 分的强档给 0.9；题面同时带「近年」时辅助档只会把它推得更高。
  assert.equal(classify({ question: PAPER_QUESTION }).confidence, 0.9)
})

test('the auxiliary tier alone cannot name the kind', () => {
  const result = classify({ question: '近年 方法 评估 数据集' })
  assert.equal(result.scores.scholar, 1)
  assert.notEqual(result.questionKind, 'scholar')
  assert.equal(result.questionKind, 'concept')
})

test('scholar does not steal fresh-data questions that merely mention 近年', () => {
  const plain = classify({ question: 'Node.js 最新 LTS 支持到什么时候' })
  assert.equal(plain.questionKind, 'fresh-data')
  assert.equal(plain.scores.scholar, 0)
  const recent = classify({ question: 'React 最新版本发布了吗，近年有什么变化' })
  assert.equal(recent.questionKind, 'fresh-data')
  assert.equal(recent.scores.scholar, 1)
})

test('scholar does not misfire on "how do I learn" questions', () => {
  const result = classify({ question: '如何学习 Java' })
  assert.equal(result.questionKind, 'learning')
  assert.equal(result.scores.scholar, 0)
})

test('legal keeps precedence over heavy academic vocabulary', () => {
  const result = classify({ question: 'IEEE 802.11 标准的合规义务' })
  assert.equal(result.questionKind, 'legal')
  assert.ok(result.scores.scholar > 0)
})

/* ------------------------------------------------------------------ pack */

test('the scholar pack walks the papers channel and asks for literature queries', () => {
  const strategy = resolveStrategy({ questionKind: 'scholar', question: PAPER_QUESTION })
  assert.equal(strategy.questionKind, 'scholar')
  assert.equal(strategy.reason, 'kind:scholar')
  assert.equal(strategy.signalVersion, SIGNAL_VERSION)
  // 学术题缺省 explain：不需要对比表，也不强推行动清单。
  assert.equal(strategy.mode, 'explain')
  assert.equal(strategy.depth.bias, 0)
  assert.equal(strategy.sourcePlan.channels.length, 1)
  const [channel] = strategy.sourcePlan.channels
  assert.equal(channel.id, 'papers')
  assert.equal(channel.method, 'api')
  assert.ok(channel.hosts.includes('arxiv.org'))
  assert.ok(channel.hosts.includes('openalex.org'))
  assert.ok(channel.hosts.includes('doi.org'))
  assert.deepEqual(strategy.queries.extraTemplates, ['{q} survey', '{q} arxiv', '{q} benchmark results', '{q} 综述'])
  assert.deepEqual(strategy.brief.requiredSections, ['## 依据', '## 未解决'])
  assert.deepEqual(strategy.sources.officialSeeds, [])
})

test('the scholar brief requires 依据 and 未解决 but no comparison table or action list', () => {
  const strategy = resolveStrategy({ questionKind: 'scholar' })
  const sections = requiredSectionsFor({
    mode: strategy.mode,
    questionKind: strategy.questionKind,
    base: strategy.brief.requiredSections,
  })
  assert.deepEqual(sections.map((entry) => entry.heading), ['## 依据', '## 未解决'])
  for (const heading of ['## 方案对比', '## 行动清单', '## 判据']) {
    assert.ok(!sections.some((entry) => entry.heading === heading), heading)
  }
})

test('a missing declared section costs scholar one confidence notch', () => {
  const clusters = [
    { claim: 'a', status: 'confirmed', evidence: [{ url: 'https://arxiv.org/abs/2401.00001' }] },
    { claim: 'b', status: 'confirmed', evidence: [{ url: 'https://doi.org/10.1145/1' }] },
    { claim: 'c', status: 'confirmed', evidence: [{ url: 'https://github.com/nodejs/node' }] },
  ]
  const gates = resolveStrategy({ questionKind: 'scholar' }).gates
  const clean = computeConfidence(clusters, gates)
  const missing = computeConfidence(clusters, { ...gates, missingSections: true })
  assert.notEqual(missing, clean)
  assert.equal(missing, 'medium')
})

/* -------------------------------------------------------------- verticals */

test('the papers channel recruits arxiv and scholar together for academic questions', () => {
  // 同一个问题也命中 DEV_HINTS（「框架」「接口」），github 原本会挤掉 arxiv。
  const picked = pickVerticals({ question: 'RAG 检索框架的 benchmark 论文有哪些' })
  assert.deepEqual([...picked].sort(), ['arxiv', 'scholar'])
  assert.ok(!picked.includes('github'))
  // 既有论断之一：学术题必须两家论文库同时入选。
  const legacy = pickVerticals({ question: 'which retrieval augmented generation benchmark is standard in 2026?' })
  assert.deepEqual([...legacy].sort(), ['arxiv', 'scholar'])
  // 非学术题不受影响。
  assert.deepEqual(pickVerticals({ question: 'pnpm 工作区里怎么配置依赖' }), ['github', 'stackexchange'])
})

/* ----------------------------------------------------------------- prompt */

test('the synthesis prompt carries the academic structure and its cautions', () => {
  const text = prompt()
  assert.ok(text.includes('输出结构（学术型）'), 'missing 学术型 header')
  for (const heading of ['## 结论', '## 主要工作', '## 证据强度', '## 未解决']) {
    assert.ok(text.includes(heading), heading)
  }
  assert.ok(text.includes('预印本'), 'must warn about preprints')
  assert.ok(text.includes('（未核实）'), 'must mark unverified DOIs')
  // 学术题不套用选型报告：没有对比结构，也没有行动清单。
  assert.ok(!text.includes('输出结构（对比型）'))
  assert.ok(!text.includes('## 行动清单'))
  assert.ok(!text.includes('## 方案对比'))
  // 对比模式也不会盖掉学术结构（kind 优先于 mode，decision 同款先例）。
  const compared = prompt({ mode: 'compare' })
  assert.ok(compared.includes('输出结构（学术型）'))
  assert.ok(!compared.includes('输出结构（对比型）'))
  // 非学术题保持原样。
  const plain = prompt({ questionKind: 'concept' })
  assert.ok(!plain.includes('输出结构（学术型）'))
  assert.ok(!plain.includes('## 主要工作'))
  assert.ok(plain.includes('## 行动清单'))
})

/* ------------------------------------------------------------------- eval */

test('the eval corpus expects only registered kinds, and i-paper expects scholar', () => {
  for (const entry of QUESTIONS) {
    assert.ok(QUESTION_KINDS.includes(entry.expectKind), `${entry.id}: ${entry.expectKind}`)
  }
  assert.equal(QUESTIONS.find((entry) => entry.id === 'i-paper').expectKind, 'scholar')
  // 语料期望必须真的可达：该题分类成 scholar，而不是只被跳过断言。
  const paper = QUESTIONS.find((entry) => entry.id === 'i-paper')
  assert.equal(classify({ question: paper.question }).questionKind, 'scholar')
})