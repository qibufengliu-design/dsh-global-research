import test from 'node:test'
import assert from 'node:assert/strict'
import { evidencePrompt, synthPrompt } from '../lib/prompts.js'

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
  // The existing table limits must survive the new rule.
  assert.ok(prompt.includes('表格最多 3 行、每格不超过 20 字'), 'the table size limits changed')
})