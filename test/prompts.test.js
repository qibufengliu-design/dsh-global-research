import test from 'node:test'
import assert from 'node:assert/strict'
import { evidencePrompt, planPrompt, synthPrompt, compareColumnKind, effectiveCompareColumnKind } from '../lib/prompts.js'

function page(url, text = 'DeepSeek 输入价格 0.2 元/百万 tokens，要求 v22.11.0 以上，有效期到 2027-04-30。') {
  return { url, title: `page ${url}`, text, engine: 'web', publishedAt: '2025-01-01' }
}

function synthArgs() {
  return {
    question: 'DeepSeek 和 Qwen 的 API 输入价格差多少',
    focus: [],
    language: 'zh',
    clusters: [{
      claim: 'DeepSeek 输入价格为 0.2 元/百万 tokens',
      status: 'confirmed',
      evidence: [{ id: 'S1', quote: 'DeepSeek 输入价格为 0.2 元/百万 tokens' }],
    }],
    constraints: [],
    criteria: [],
    sourceList: '[S1] https://api-docs.deepseek.com/quick_start/pricing',
    depth: 'standard',
    mode: 'compare',
    // A price-difference question: the price columns are the ones under test.
    questionKind: 'pricing',
  }
}

test('evidence prompt keeps numbers, units and dates verbatim in claims', () => {
  const prompt = evidencePrompt({ pages: [page('https://api-docs.deepseek.com/quick_start/pricing')] })
  assert.ok(prompt.includes('必须原样保留'), 'numbers/units/dates rule is missing')
  assert.ok(prompt.includes('0.2 元/百万 tokens'), 'the per-million price example is missing')
  assert.ok(prompt.includes('v22.11.0'), 'the version example is missing')
  assert.ok(prompt.includes('2027-04-30'), 'the date example is missing')
  assert.ok(prompt.includes('禁止改写'), 'the no-rewrite clause is missing')
  assert.ok(prompt.includes('禁止省略单位'), 'the keep-the-unit clause is missing')
  // The per-page cap is unchanged.
  assert.ok(prompt.includes('不要超过 6 条'), 'the per-page evidence cap changed')
})

test('synthesis prompt requires a citation on every numeric table value', () => {
  const prompt = synthPrompt(synthArgs())
  assert.ok(prompt.includes('「## 方案对比」表里每个含数字的单元格'), 'numeric-cell citation rule is missing')
  assert.ok(prompt.includes('必须紧跟 [S#]'), 'the [S#] requirement is missing')
  assert.ok(prompt.includes('未核实'), 'the unsourced-number placeholder is missing')
  // The existing table limits must survive the new rule, and 0.9.6 replaces the
  // blanket "at most 3 rows" cap with "one row per candidate" — the cap was what
  // pushed the synthesizer into merging two candidates into one cell.
  assert.ok(prompt.includes('每格不超过 20 字'), 'the per-cell size limit changed')
  assert.ok(prompt.includes('表格每行一个方案'), 'the one-row-per-candidate rule is missing')
  assert.ok(!prompt.includes('表格最多 3 行'), 'the flat row cap must not come back')
})

test('a compare prompt forbids merging two candidates into one table row (0.9.6)', () => {
  const prompt = synthPrompt(synthArgs())
  assert.ok(prompt.includes('每个候选必须独立一行'), 'the per-candidate row rule is missing')
  assert.ok(prompt.includes('禁止'), 'the merge prohibition is missing')
  assert.ok(prompt.includes('qwen / 豆包 API'), 'the counter-example is missing')
  assert.ok(prompt.includes('未核实（无来源）'), 'the missing-price placeholder is missing')
  assert.ok(prompt.includes('不要删行、不要并格'), 'the keep-the-row rule is missing')
})

test('synthesis prompt forces a currency column and forbids cross-currency comparison', () => {
  const prompt = synthPrompt(synthArgs())
  assert.ok(prompt.includes('必须有一列「币种/单位」'), 'the currency-column rule is missing')
  assert.ok(prompt.includes('不得直接比较大小'), 'the no-direct-comparison rule is missing')
  assert.ok(prompt.includes('币种不同，未换算'), 'the 未解决 disclosure string is missing')
  // The rule must not weaken the numeric-cell citation rule it sits next to.
  assert.ok(prompt.includes('必须紧跟 [S#]'), 'the [S#] requirement is missing')
})

test('evidence prompt marks retired pages so the model does not prop claims on them (0.6.6)', () => {
  const prompt = evidencePrompt({
    pages: [
      page('https://github.com/old/repo', 'Node 文档仍在维护。'),
      { ...page('https://github.com/dead/repo'), stale: true },
    ],
  })
  assert.match(prompt, /\[页面 1\][^\n]*⚠ 已过期\/停维护/)
  assert.doesNotMatch(prompt.split('\n').find((line) => line.startsWith('[页面 0]')), /已过期/)
  assert.ok(prompt.includes('不要用它支撑当前状态'), 'the stale-citation rule is missing')
})

test('plan prompt tags every query with one of the three kinds (0.7.1)', () => {
  const prompt = planPrompt({ question: 'pnpm 还是 yarn 该选哪个？', focus: [], depth: 'standard' })
  assert.ok(prompt.includes('"kind"'), 'the per-query kind field is missing')
  assert.ok(prompt.includes('semantic'), 'the semantic kind is missing')
  assert.ok(prompt.includes('technical'), 'the technical kind is missing')
  assert.ok(prompt.includes('official'), 'the official kind is missing')
  // The example must show the object form; a bare string list would silently
  // teach the model the old shape.
  assert.ok(prompt.includes('{"queries":[{"q":"...","kind":"semantic"}]'), 'the JSON example does not show the kind field')
})

test('synthesis prompt opens with a cited one-sentence verdict (0.9.0)', () => {
  const prompt = synthPrompt(synthArgs())
  assert.ok(prompt.includes('**一句话：<结论>**'), 'the 一句话 one-liner format is missing')
  assert.ok(prompt.includes('不超过 80 字'), 'the one-liner length cap is missing')
  assert.ok(prompt.includes('有推荐对象就点名'), 'the name-the-recommendation rule is missing')
  assert.ok(prompt.includes('选 X'), 'the recommendation example is missing')
  // Every verifiable judgement carries a source, every unsourced one says so.
  assert.ok(prompt.includes('结论段里每个可核查判断的末尾都必须紧跟 [S#]'), 'the conclusion citation rule is missing')
  assert.ok(prompt.includes('（推断）'), 'the inference marker is missing')
  assert.ok(prompt.includes('**（证据不足，以下为初步判断）**'), 'the insufficient-evidence prefix is missing')
})

test('synthesis prompt requires the action checklist with executable items (0.9.0)', () => {
  const prompt = synthPrompt(synthArgs())
  assert.ok(prompt.includes('## 行动清单'), 'the action checklist section is missing')
  assert.ok(prompt.includes('3-5 条'), 'the item count is missing')
  assert.ok(prompt.includes('动词开头'), 'the verb-first rule is missing')
  assert.ok(prompt.includes('不超过 60 字'), 'the per-item length cap is missing')
  assert.ok(prompt.includes('如何小范围验证或试点'), 'the compare-mode pilot rule is missing')
  // Placement is part of the contract, not left to the model's taste.
  assert.ok(prompt.includes('之后、「## 坑与风险」之前'), 'the placement rule is missing')
})

test('synthesis prompt warns that uncited table numbers get a no-source label (0.9.0)', () => {
  const prompt = synthPrompt(synthArgs())
  assert.ok(prompt.includes('数字列里每一行的数字后都要带 [S#]'), 'the per-row number rule is missing')
  assert.ok(prompt.includes('（无来源）'), 'the fallback label is not disclosed to the model')
})

// 0.9.9 — the compare table used to hardcode a 价格 column, so a judgement
// question (微服务该不该拆) got 「未核实」 under 价格 on every row: a column that
// cannot be filled but still reads as a finding. The columns now follow the kind.
test('the compare table columns are chosen by the question kind (0.9.9)', () => {
  const args = synthArgs()

  const pricing = synthPrompt({ ...args, questionKind: 'pricing' })
  assert.ok(pricing.includes('| 方案 | 输入价 | 输出价 | 币种/口径 | 适用场景 |'), 'the pricing header is missing')
  assert.ok(pricing.includes('未核实（无来源）'), 'the pricing placeholder is missing')

  // 0.9.10 — evaluate joins the judgement bucket: an evaluation question has no
  // price axis either, so it must not fall back to the generic header.
  for (const kind of ['tech-selection', 'architecture', 'decision', 'evaluate']) {
    const prompt = synthPrompt({ ...args, questionKind: kind })
    assert.ok(prompt.includes('| 方案 | 优势 | 风险 | 适用场景 | 成本概览 |'), `the ${kind} header is missing`)
    assert.ok(prompt.includes('不得为了填表编造价格或单价'), `the no-invented-price rule is missing for ${kind}`)
    assert.ok(!prompt.includes('| 输入价 |'), `a price column leaked into ${kind}`)
    assert.ok(!prompt.includes('| 价格 |'), `a 价格 column leaked into ${kind}`)
  }

  // learning / a missing kind still fall back to the neutral columns.
  for (const kind of ['learning', 'concept', null, undefined]) {
    const prompt = synthPrompt({ ...args, questionKind: kind })
    assert.ok(prompt.includes('| 选项 | 优势 | 风险 | 适用条件 |'), `the generic header is missing for ${kind}`)
    assert.ok(!prompt.includes('| 价格 |'), `a 价格 column leaked into ${String(kind)}`)
  }

  // The per-candidate row rule is independent of the columns.
  assert.ok(synthPrompt({ ...args, questionKind: 'pricing' }).includes('每个候选必须独立一行'))
  assert.ok(synthPrompt({ ...args, questionKind: 'tech-selection' }).includes('每个候选必须独立一行'))
  assert.ok(synthPrompt({ ...args, questionKind: 'learning' }).includes('每个候选必须独立一行'))
})

// 0.9.10 — 「我们团队 8 个人，微服务该不该拆」 carries no classified signal: the
// classifier falls back to concept (all scores 0, confidence 0.35), so even after
// 0.9.9 the table came out generic (选项/适用条件). The wording is a decision, so the
// table now upgrades to the cost columns while stats.questionKind stays `concept`.
test('an unclassified decision question still gets the cost columns (0.9.10)', () => {
  const args = { ...synthArgs(), mode: 'explain' }
  const decision = '我们团队 8 个人，微服务该不该拆'
  assert.equal(compareColumnKind('concept'), 'generic', 'concept should still map to generic')
  assert.equal(effectiveCompareColumnKind('concept', decision), 'cost', 'the decision wording should upgrade to cost')

  const prompt = synthPrompt({ ...args, question: decision, questionKind: 'concept' })
  assert.ok(prompt.includes('| 方案 | 优势 | 风险 | 适用场景 | 成本概览 |'), 'the decision question kept the generic header')
  assert.ok(!prompt.includes('| 选项 |'), 'the generic header leaked into the decision question')
  assert.ok(!prompt.includes('| 价格 |'), 'a 价格 column leaked into the decision question')

  // The other decision phrasings the classifier also misses.
  for (const wording of ['要不要上 Kubernetes', '值不值得自建机房', '是否该拆微服务', '应不应该换数据库']) {
    assert.ok(
      synthPrompt({ ...args, question: wording, questionKind: 'concept' }).includes('| 方案 | 优势 | 风险 | 适用场景 | 成本概览 |'),
      `no cost header for 「${wording}」`,
    )
  }

  // A neutral question that is not a decision keeps the neutral columns.
  const neutral = synthPrompt({ ...args, question: 'Kubernetes 是什么', questionKind: 'concept' })
  assert.ok(neutral.includes('| 选项 | 优势 | 风险 | 适用条件 |'), 'a non-decision concept question lost its generic header')

  // The upgrade never overrides a classified bucket: pricing stays pricing.
  assert.equal(effectiveCompareColumnKind('pricing', decision), 'pricing')
  assert.ok(
    synthPrompt({ ...args, question: decision, questionKind: 'pricing' }).includes('| 方案 | 输入价 | 输出价 | 币种/口径 | 适用场景 |'),
    'the pricing header was overridden by the wording upgrade',
  )
  // evaluate is a judgement question, so it is cost.
  assert.equal(compareColumnKind('evaluate'), 'cost')
})