// 评测脚本（scripts/eval.mjs）的单元与端到端测试。
// 纯函数部分直接喂构造数据；端到端部分走 offline fixture，不联网、不 spawn 子进程
// （沙箱里 piped stdio 会 EPERM，见 scripts/test-all.mjs 的注释）。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  QUESTIONS,
  REGRESSION_MARGIN,
  WEIGHTS,
  buildReport,
  compareToBaseline,
  confidencePoints,
  expectedConfidence,
  fourNumbersComplete,
  missingSections,
  officialSourceRatio,
  parseArgs,
  parseCompareTable,
  renderMarkdown,
  requiredSectionsFor,
  runOffline,
  scoreRun,
  splitTableRow,
  tableFillRate,
  weightedScore,
} from '../scripts/eval.mjs'

const STATS = { identified: 40, deduped: 12, readable: 8, adopted: 6 }

const FULL_BRIEF = [
  '## 结论',
  '- 三种方案里优先用 Spring AI [S1]',
  '',
  '## 依据',
  '- 官方文档给出版本范围与成本 [S1]',
  '',
  '## 方案对比',
  '',
  '| 维度 | Spring AI | LangChain4j |',
  '| --- | --- | --- |',
  '| 接入成本 | 0.2 元/百万 tokens [S1] | 0.3 元/百万 tokens [S2] |',
  '| 生态成熟度 | 官方维护 [S1] | 社区活跃 [S2] |',
  '',
  '## 判据',
  '- 团队已有 Spring 经验 [S1]',
  '',
  '## 行动清单',
  '- 先用 Spring AI 做 PoC [S1]',
  '',
  '## 坑与风险',
  '- 生态较新 [S1]',
  '',
  '## 置信度',
  'high（官方文档为主）',
  '',
  '## 未解决',
  '- 无',
].join('\n')

const DOC = 'https://docs.spring.io/spring-ai/reference/api/chatclient.html'
const DOC2 = 'https://docs.langchain4j.dev/tutorials/rag/'
const FORUM = 'https://stackoverflow.com/questions/76012345/spring-ai-vs-langchain4j'
const CODE = 'https://github.com/langchain4j/langchain4j/blob/main/pom.xml'

test('语料固定为 10 题，字段齐全且 id 唯一', () => {
  assert.equal(QUESTIONS.length, 10)
  assert.equal(new Set(QUESTIONS.map((question) => question.id)).size, 10)
  for (const question of QUESTIONS) {
    assert.equal(typeof question.id, 'string')
    assert.equal(typeof question.question, 'string')
    assert.ok(['quick', 'standard', 'deep'].includes(question.depth))
    assert.equal(typeof question.mode, 'string')
    assert.equal(typeof question.expectKind, 'string')
  }
  assert.deepEqual(
    QUESTIONS.map((question) => question.id),
    ['a-rag', 'b-price', 'c-split', 'd-node', 'e-so', 'f-legal', 'g-learn', 'h-compare-zh', 'i-paper', 'j-eval'],
  )
  // 权重合计 100，回归阈值 3 分。
  assert.equal(Object.values(WEIGHTS).reduce((sum, weight) => sum + weight, 0), 100)
  assert.equal(REGRESSION_MARGIN, 3)
})

test('scoreRun：来源全官方 + 段齐 + 四数齐 + 置信匹配 = 满分', () => {
  const record = scoreRun({
    brief: FULL_BRIEF,
    sources: [{ url: DOC }, { url: DOC2 }],
    stats: STATS,
    confidence: 'high',
    kind: 'tech-selection',
    mode: 'compare',
    depth: 'standard',
    partial: false,
    seconds: 30,
  })
  assert.equal(record.officialRatio, 1)
  assert.equal(record.tableFillRate, 1)
  assert.equal(record.sectionsComplete, true)
  assert.equal(record.fourNumbers, true)
  assert.equal(record.confidenceMatch, true)
  assert.equal(record.score, 100)
  assert.equal(record.weightUsed, 100)
  assert.deepEqual(record.notes, [])
})

test('scoreRun：来源质量按官方占比打折，repo code 不算官方', () => {
  const half = officialSourceRatio([{ url: DOC }, { url: FORUM }])
  assert.deepEqual(half, { total: 2, official: 1, ratio: 0.5 })
  // 仓库代码文件是证据不是规范，不计入官方占比。
  assert.equal(officialSourceRatio([{ url: CODE }]).ratio, 0)

  const record = scoreRun({
    brief: FULL_BRIEF,
    sources: [{ url: DOC }, { url: FORUM }],
    stats: { ...STATS, adopted: 3 },
    confidence: 'medium',
    kind: 'tech-selection',
    mode: 'compare',
    seconds: 30,
  })
  assert.equal(record.officialRatio, 0.5)
  // 30/100 权重打了五折 → 扣 15 分。
  assert.equal(record.score, 85)
  assert.equal(record.notes.length, 0)
})

test('表格：无证据格扣分、对比题缺表记 0、非对比题缺表不计入', () => {
  const table = parseCompareTable(['## 方案对比', '', '| 维度 | A | B |', '| --- | --- | --- |', '| 成本 | 0.2 元 | 无证据 |'].join('\n'))
  assert.deepEqual(table.header, ['维度', 'A', 'B'])
  assert.deepEqual(table.rows, [['成本', '0.2 元', '无证据']])
  assert.deepEqual(splitTableRow('| a | b |'), ['a', 'b'])
  assert.deepEqual(tableFillRate(table), { rate: 0.5, cells: 2, filled: 1 })

  const noTable = ['## 结论', '- x', '## 依据', '- y', '## 行动清单', '- 下一步', '## 置信度', 'low', '## 未解决', '- z'].join('\n')
  const compareRun = scoreRun({
    brief: noTable,
    sources: [{ url: DOC }],
    stats: { ...STATS, adopted: 1 },
    confidence: 'low',
    kind: 'tech-selection',
    mode: 'compare',
    seconds: 5,
  })
  assert.equal(compareRun.tableFillRate, 0)
  assert.ok(compareRun.notes.some((note) => note.startsWith('表格：该题应有')))
  // 表格 20 分归零，其余满分 → 80。
  assert.equal(compareRun.score, 80)

  const freshRun = scoreRun({
    brief: noTable,
    sources: [{ url: DOC }],
    stats: { ...STATS, adopted: 1 },
    confidence: 'low',
    kind: 'fresh-data',
    mode: '',
    seconds: 5,
  })
  // 非对比题不该有表 → 该项不适用，按剩余权重归一。
  assert.equal(freshRun.tableFillRate, null)
  assert.equal(freshRun.weightUsed, 80)
  assert.equal(freshRun.score, 100)
})

test('段落：decision 必备「判据」「行动清单」，缺失按比例扣分', () => {
  assert.deepEqual(requiredSectionsFor('fresh-data', ''), ['## 结论', '## 依据', '## 置信度', '## 未解决'])
  assert.deepEqual(requiredSectionsFor('decision', '').slice(-2), ['## 判据', '## 行动清单'])
  assert.deepEqual(requiredSectionsFor('tech-selection', 'compare').slice(-1), ['## 行动清单'])

  const partial = ['## 结论', '- x', '## 依据', '- y', '## 置信度', 'low', '## 未解决', '- z'].join('\n')
  assert.deepEqual(missingSections(partial, requiredSectionsFor('decision', '')), ['## 判据', '## 行动清单'])

  const record = scoreRun({
    brief: partial,
    sources: [{ url: DOC }, { url: DOC2 }],
    stats: STATS,
    confidence: 'high',
    kind: 'decision',
    mode: '',
    seconds: 5,
  })
  assert.equal(record.sectionsComplete, false)
  assert.deepEqual(record.sectionsMissing, ['## 判据', '## 行动清单'])
  assert.ok(record.notes.some((note) => note.startsWith('段落缺失')))
  // decision 不需要对比表（表格项不适用被剔除），段落 4/6 扣 5 分 →
  // 75/80 = 93.75。
  assert.equal(record.weightUsed, 80)
  assert.equal(record.score, 93.8)
})

test('四数：缺项或 adopted=0 都记 0 分并留下备注', () => {
  assert.deepEqual(fourNumbersComplete(STATS), { complete: true, adoptedOk: true, rate: 1, values: [40, 12, 8, 6], adopted: 6 })
  assert.equal(fourNumbersComplete({ identified: 3, deduped: 2, readable: 1 }).rate, 0)
  assert.equal(fourNumbersComplete({ identified: 3, deduped: 2, readable: 1, adopted: 0 }).rate, 0)

  const record = scoreRun({
    brief: FULL_BRIEF,
    sources: [{ url: DOC }],
    stats: { identified: 3, deduped: 2, readable: 1, adopted: 0 },
    confidence: 'low',
    kind: 'tech-selection',
    mode: 'compare',
    seconds: 5,
  })
  assert.equal(record.fourNumbers, false)
  assert.ok(record.notes.includes('四数：adopted=0（没有可用来源）'))
  assert.equal(record.score, 90)
})

test('置信度：与证据不匹配按 1 / 0.5 / 0.15 记分', () => {
  assert.equal(expectedConfidence({ officialRatio: 1, adopted: 6 }), 'high')
  assert.equal(expectedConfidence({ officialRatio: 0.5, adopted: 2 }), 'medium')
  assert.equal(expectedConfidence({ officialRatio: 0.2, adopted: 8 }), 'low')
  assert.equal(expectedConfidence({ officialRatio: 0, adopted: 0 }), 'low')
  assert.equal(confidencePoints('high', 'high'), 1)
  assert.equal(confidencePoints('medium', 'high'), 0.5)
  assert.equal(confidencePoints('low', 'high'), 0.15)

  const strong = { brief: FULL_BRIEF, sources: [{ url: DOC }, { url: DOC2 }], stats: STATS, kind: 'tech-selection', mode: 'compare', seconds: 5 }
  const honest = scoreRun({ ...strong, confidence: 'high' })
  const inflated = scoreRun({ ...strong, confidence: 'low' })
  assert.equal(inflated.expectedConfidence, 'high')
  assert.equal(inflated.confidenceMatch, false)
  assert.ok(inflated.notes.some((note) => note.startsWith('置信度：报 low')))
  assert.ok(inflated.score < honest.score)
  // 置信度 15 分：0.15 → 2.25 → 满分 100 掉到 87.3。
  assert.equal(inflated.score, 87.3)
})

test('weightedScore：null 指标剔除后按剩余权重归一', () => {
  assert.deepEqual(weightedScore({ sourceQuality: { ratio: 1, weight: 30 }, tableFill: { ratio: null, weight: 20 } }), { score: 100, weightUsed: 30 })
  assert.deepEqual(weightedScore({}), { score: 0, weightUsed: 0 })
})

test('compareToBaseline：低 3 分以上判回归，缺题记空', () => {
  const report = { total: 80, records: [{ id: 'a-rag', score: 80 }, { id: 'b-price', score: 80 }] }
  const close = compareToBaseline(report, { total: 82, records: [{ id: 'a-rag', score: 82 }, { id: 'b-price', score: 82 }] })
  assert.equal(close.totalDelta, -2)
  assert.equal(close.regressed, false)
  assert.equal(close.exitCode, 0)
  assert.deepEqual(close.items.map((item) => item.delta), [-2, -2])

  const regressed = compareToBaseline(report, { total: 83, records: [{ id: 'a-rag', score: 83 }, { id: 'b-price', score: 83 }] })
  assert.equal(regressed.totalDelta, -3)
  assert.equal(regressed.regressed, true)
  assert.equal(regressed.exitCode, 1)

  const missing = compareToBaseline(report, { total: 80, records: [{ id: 'a-rag', score: 80 }] })
  assert.equal(missing.items[1].baseline, null)
  assert.equal(missing.items[1].delta, null)
  assert.equal(missing.exitCode, 0)
})

test('parseArgs：默认 offline，支持 --only / --json / --baseline / --flag=value', () => {
  assert.deepEqual(parseArgs([]), { mode: 'offline', only: [], json: '', jsonPath: '', baseline: '', help: false })
  assert.equal(parseArgs(['--real']).mode, 'real')
  assert.deepEqual(parseArgs(['--only', 'a-rag,b-price']).only, ['a-rag', 'b-price'])
  assert.deepEqual(parseArgs(['--only=c-split']).only, ['c-split'])
  assert.equal(parseArgs(['--json']).json, 'stdout')
  assert.equal(parseArgs(['--json', 'out.json']).jsonPath, 'out.json')
  assert.equal(parseArgs(['--baseline', 'prev.json']).baseline, 'prev.json')
  assert.equal(parseArgs(['--help']).help, true)
  assert.throws(() => parseArgs(['--nope']), /未知参数/)
  assert.throws(() => parseArgs(['--only']), /--only 需要一个题目 id/)
})

test('offline 端到端：10 题都出数、表格可读、总分与基线自比相减为 0', async () => {
  const runs = await runOffline(QUESTIONS, { logger: () => {} })
  assert.equal(runs.length, 10)

  const report = buildReport(runs, { mode: 'offline' })
  assert.equal(report.schema, 1)
  assert.equal(report.questions, 10)
  assert.equal(report.records.length, 10)
  for (const record of report.records) {
    assert.ok(Number.isFinite(record.score) && record.score >= 0 && record.score <= 100, `${record.id} 分数越界`)
    assert.ok(record.sources > 0, `${record.id} 一条来源都没有（fixture 的 URL 与 normalizeUrl 没对上？）`)
  }
  assert.ok(report.total > 50 && report.total <= 100)

  const markdown = renderMarkdown(report, compareToBaseline(report, report))
  assert.match(markdown, /^\| id \| kind \| 来源 \| 官方 \| 表格 \| 段 \| 四数 \| 置信 \| 秒 \| 分 \|$/m)
  for (const question of QUESTIONS) assert.match(markdown, new RegExp(`^\\| ${question.id} \\|`, 'm'))
  assert.match(markdown, /\*\*总分 [\d.]+ \/ 100\*\*/)
  assert.match(markdown, /总分差：\+0\.0/)
  assert.match(markdown, /RESULT: PASS/)

  // 与自身比较不回归 → CLI 退出码 0 的等价断言。
  assert.equal(compareToBaseline(report, report).exitCode, 0)
})