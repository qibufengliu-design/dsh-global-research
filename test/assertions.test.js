import test from 'node:test'
import assert from 'node:assert/strict'
import { extractAssertions, findAssertionConflicts } from '../lib/assertions.js'

function card(url, claim, publishedAt) {
  return { claim, quote: claim, url, domain: new URL(url).hostname, publishedAt }
}

function ofKind(assertions, kind) {
  return assertions.filter((assertion) => assertion.kind === kind)
}

test('extracts a Chinese per-million token price with its unit and property', () => {
  const assertions = ofKind(extractAssertions(card('https://a.com/pricing', 'Claude 3.5 Sonnet 的输入价格为 0.2 元/百万 tokens')), 'price')
  assert.equal(assertions.length, 1)
  assert.equal(assertions[0].value, '0.2')
  assert.equal(assertions[0].unit, '元/百万 tokens')
  assert.match(assertions[0].attribute, /输入价格/)
  assert.deepEqual(assertions[0].norm, { currency: 'CNY', perMillion: 0.2 })
})

test('extracts a dollar-per-million price and converts the scale to millions', () => {
  const assertions = ofKind(extractAssertions(card('https://b.com/pricing', 'Output costs $1.5 / M tokens on the paid plan')), 'price')
  assert.equal(assertions.length, 1)
  assert.equal(assertions[0].value, '1.5')
  assert.equal(assertions[0].unit, '美元/百万 tokens')
  assert.equal(assertions[0].norm.currency, 'USD')
  assert.equal(assertions[0].norm.perMillion, 1.5)
})

test('extracts a dotted product version once, even with a v prefix', () => {
  const assertions = extractAssertions(card('https://nodejs.org/en/about', 'Node v22.11.0 is the current LTS release'))
  const versions = ofKind(assertions, 'version')
  assert.equal(versions.length, 1)
  assert.equal(versions[0].attribute, 'Node')
  assert.equal(versions[0].value, '22.11.0')
  assert.equal(versions[0].unit, '版本')
  // "Node 22" is covered too, but a bare major version is never compared.
  const major = ofKind(extractAssertions(card('https://nodejs.org/en/about', 'Node 22 is the current LTS release')), 'version')
  assert.equal(major.length, 1)
  assert.equal(major[0].value, '22')
  assert.equal(major[0].generic, true)
})

test('extracts an ISO date together with the property it applies to', () => {
  const assertions = ofKind(extractAssertions(card('https://eur-lex.europa.eu/x', 'CRA 报告义务生效日期为 2027-04-30')), 'date')
  assert.equal(assertions.length, 1)
  assert.equal(assertions[0].value, '2027-04-30')
  assert.equal(assertions[0].unit, '日期')
  assert.match(assertions[0].attribute, /报告义务生效日期/)
})

test('extracts a month-precision Chinese date', () => {
  const assertions = ofKind(extractAssertions(card('https://europa.eu/x', '2026 年 11 月起适用新的报告要求')), 'date')
  assert.equal(assertions.length, 1)
  assert.equal(assertions[0].value, '2026-11')
  assert.equal(assertions[0].unit, '月份')
})

test('extracts a comparator percentage as its own unit', () => {
  const assertions = ofKind(extractAssertions(card('https://a.com/survey', '内部团队的付费转化率为 >90%，远高于行业中位数')), 'percent')
  assert.equal(assertions.length, 1)
  assert.equal(assertions[0].value, '>90')
  assert.equal(assertions[0].unit, '%')
})

test('reads a headcount range as one assertion, not as its upper bound', () => {
  const assertions = ofKind(extractAssertions(card('https://a.com/about', '团队规模 8–10 人，负责整个平台')), 'headcount')
  assert.equal(assertions.length, 1)
  assert.equal(assertions[0].value, '8–10')
  assert.equal(assertions[0].unit, '人')
})

test('reports a conflict when two sources give different prices', () => {
  const conflicts = findAssertionConflicts([
    card('https://a.com/pricing', '输入价格为 0.2 元/百万 tokens'),
    card('https://b.com/pricing', '输入价格为 0.3 元/百万 tokens'),
  ])
  assert.equal(conflicts.length, 1)
  assert.match(conflicts[0].attribute, /输入价格/)
  assert.deepEqual(conflicts[0].values.map((entry) => entry.value), ['0.2', '0.3'])
  assert.deepEqual(conflicts[0].values.map((entry) => entry.source), ['a.com', 'b.com'])
})

test('does not report the same source\'s older value as a conflict', () => {
  const conflicts = findAssertionConflicts([
    card('https://a.com/pricing', '输入价格为 0.2 元/百万 tokens', '2024-01-01'),
    card('https://a.com/pricing', '输入价格为 0.3 元/百万 tokens', '2025-06-01'),
  ])
  assert.deepEqual(conflicts, [])
})

test('converts 元/十亿 and 元/百万 to the same unit before comparing', () => {
  const conflicts = findAssertionConflicts([
    card('https://a.com/pricing', '输入价格为 0.2 元/百万 tokens'),
    card('https://b.com/pricing', '输入价格为 200 元/十亿 tokens'),
  ])
  assert.deepEqual(conflicts, [])
})

test('keeps values with incomparable currencies side by side', () => {
  const conflicts = findAssertionConflicts([
    card('https://a.com/pricing', '输入价格为 0.2 元/百万 tokens'),
    card('https://b.com/pricing', '输入价格为 1.5 美元/百万 tokens'),
  ])
  assert.equal(conflicts.length, 1)
  const values = conflicts[0].values.map((entry) => `${entry.value} ${entry.unit}`)
  assert.deepEqual(values, ['0.2 元/百万 tokens', '1.5 美元/百万 tokens'])
})

test('treats differing version precision as the same version', () => {
  const conflicts = findAssertionConflicts([
    card('https://a.com/x', 'Node 22.11 is supported'),
    card('https://b.com/x', 'Node v22.11.0 已发布'),
  ])
  assert.deepEqual(conflicts, [])
})

test('reports a specific dotted-version conflict but not two product lines', () => {
  const conflicts = findAssertionConflicts([
    card('https://a.com/x', 'Node 22.11.0 is the current LTS'),
    card('https://b.com/x', 'Node 22.12.0 is the current LTS'),
  ])
  assert.equal(conflicts.length, 1)
  assert.deepEqual(conflicts[0].values.map((entry) => entry.value), ['22.11.0', '22.12.0'])
  // Node 22 · Node 24: two releases a page may perfectly well mention together.
  assert.deepEqual(findAssertionConflicts([
    card('https://a.com/x', 'Node 22 is the current LTS'),
    card('https://b.com/x', 'Node 24 is the next LTS'),
  ]), [])
})

test('does not turn two release notes into a version conflict', () => {
  const conflicts = findAssertionConflicts([
    card('https://a.com/x', 'Node 22.11.0 是当前 LTS，支持到 2027-04-30'),
    card('https://b.com/x', 'Node 22.12.0 已发布，修复了安全问题'),
  ])
  assert.deepEqual(conflicts, [])
})

test('treats a month and a day inside that month as the same date', () => {
  const conflicts = findAssertionConflicts([
    card('https://a.com/x', '报告义务生效日期为 2026-11-30'),
    card('https://b.com/x', '报告义务生效日期为 2026 年 11 月'),
  ])
  assert.deepEqual(conflicts, [])
})

test('ignores unlabelled percentages because they share no property name', () => {
  const conflicts = findAssertionConflicts([
    card('https://a.com/x', '90% 的受访者支持该方案'),
    card('https://b.com/x', '85% 的受访者支持该方案'),
  ])
  assert.deepEqual(conflicts, [])
})

test('drops a source that lists several values for one property at the same time', () => {
  const conflicts = findAssertionConflicts([
    card('https://a.com/pricing', '套餐价格为 10 元/月，套餐价格为 20 元/月'),
    card('https://b.com/pricing', '套餐价格为 10 元/月'),
  ])
  assert.deepEqual(conflicts, [])
})

test('keeps units on price claims, so two vendors with different prices still conflict', () => {
  const conflicts = findAssertionConflicts([
    card('https://api-docs.deepseek.com/quick_start/pricing', 'DeepSeek（官方）：输入价格为 0.2 元/百万 tokens；输出价格为 0.8 元/百万 tokens'),
    card('https://bigmodel.cn/pricing', '智谱（官方）：输入价格为 0.5 元/百万 tokens；输出价格为 1.5 元/百万 tokens'),
  ])
  const input = conflicts.find((conflict) => /输入价格/.test(conflict.attribute))
  assert.ok(input, `expected an 输入价格 conflict, got ${conflicts.map((conflict) => conflict.attribute).join(', ')}`)
  assert.deepEqual(
    input.values.map((entry) => `${entry.value} ${entry.unit}`),
    ['0.2 元/百万 tokens', '0.5 元/百万 tokens'],
  )
})

test('reads numbers from the full claim+quote join instead of a truncated prefix', () => {
  // The evidence card pipeline caps the displayed claim, so assertion extraction
  // must still see the numbers that live further down in the quote.
  const quote = `${'背景说明：按月计费，按量结算。'.repeat(8)}输入价格为 0.2 元/百万 tokens`
  const assertions = ofKind(extractAssertions({
    claim: '输入价格需要核对',
    quote,
    url: 'https://api-docs.deepseek.com/quick_start/pricing',
    domain: 'api-docs.deepseek.com',
  }), 'price')
  assert.equal(assertions.length, 1)
  assert.equal(assertions[0].value, '0.2')
  assert.equal(assertions[0].unit, '元/百万 tokens')
})

test('reports a capacity conflict when the official output limit differs from a third-party measurement', () => {
  // The regression that motivated capacity extraction: the report quoted
  // "官方输出上限 384K [S1] vs 第三方 256K [S4]" but neither number was ever
  // compared, because 384K tokens is not a price, version, date, rate or headcount.
  const conflicts = findAssertionConflicts([
    card('https://platform.example.com/docs/models', '官方输出上限 384K tokens', '2025-10-01'),
    card('https://bench.example.org/review', '第三方实测输出上限 256K tokens', '2025-10-20'),
  ])
  assert.equal(conflicts.length, 1)
  assert.equal(conflicts[0].attribute, '输出上限')
  assert.equal(conflicts[0].unitMismatch, false)
  assert.deepEqual(
    conflicts[0].values.map((entry) => `${entry.value} ${entry.unit}`),
    ['384K tokens', '256K tokens'],
  )
  assert.deepEqual(
    conflicts[0].values.map((entry) => entry.source),
    ['platform.example.com', 'bench.example.org'],
  )
})

test('normalises 输出上限 and max_output_tokens into one property before comparing', () => {
  const conflicts = findAssertionConflicts([
    card('https://platform.example.com/docs/models', '官方输出上限 384K tokens'),
    card('https://api.example.com/models', 'max_output_tokens: 256000'),
  ])
  assert.equal(conflicts.length, 1)
  assert.equal(conflicts[0].attribute, '输出上限')
  assert.deepEqual(conflicts[0].values.map((entry) => entry.value), ['384K', '256000'])
  // Sabotage check: the two properties must not both be reported under their raw
  // wording, which is what happened before normalisation.
  assert.equal(conflicts[0].values.length, 2)
})

test('converts K, M and 万 to one magnitude before comparing', () => {
  // 1M tokens and 1000K tokens are the same budget, not a disagreement.
  assert.deepEqual(findAssertionConflicts([
    card('https://a.com/x', '输出上限 1M tokens'),
    card('https://b.com/x', '输出上限 1000K tokens'),
  ]), [])
  assert.deepEqual(findAssertionConflicts([
    card('https://a.com/x', '上下文窗口 128 万 tokens'),
    card('https://b.com/x', '上下文窗口 1280K tokens'),
  ]), [])
  const conflicts = findAssertionConflicts([
    card('https://a.com/x', '输出上限 1M tokens'),
    card('https://b.com/x', '输出上限 512K tokens'),
  ])
  assert.equal(conflicts.length, 1)
  assert.deepEqual(
    conflicts[0].values.map((entry) => `${entry.value} ${entry.unit}`),
    ['1M tokens', '512K tokens'],
  )
})

test('takes the newer value on the same page instead of calling it a conflict', () => {
  // Same host and same URL: the page was revised, so the newer number wins.
  assert.deepEqual(findAssertionConflicts([
    card('https://platform.example.com/docs/models', '输出上限 256K tokens', '2025-01-05'),
    card('https://platform.example.com/docs/models/', '输出上限 384K tokens', '2025-06-20'),
  ]), [])
})

test('flags values it cannot convert instead of ranking them', () => {
  const conflicts = findAssertionConflicts([
    card('https://a.com/x', '缓存容量 512 MB'),
    card('https://b.com/x', '缓存容量 512K tokens'),
  ])
  assert.equal(conflicts.length, 1)
  assert.equal(conflicts[0].unitMismatch, true)
  assert.deepEqual(
    conflicts[0].values.map((entry) => `${entry.value} ${entry.unit}`),
    ['512 MB', '512K tokens'],
  )
})

test('does not read headcounts, percentages or prices as capacity', () => {
  for (const claim of [
    '支持 12 人协作，最多 10 万人同时在线',
    '90% 的受访者支持该方案',
    '输入价格为 0.2 元/百万 tokens',
  ]) {
    assert.deepEqual(ofKind(extractAssertions(card('https://a.com/x', claim)), 'capacity'), [], claim)
  }
  // A headcount still conflicts as a headcount — capacity extraction must not
  // swallow it or change the kind that reports it.
  const conflicts = findAssertionConflicts([
    card('https://a.com/x', '支持 12 人协作'),
    card('https://b.com/x', '支持 20 人协作'),
  ])
  assert.ok(conflicts.length >= 1)
  assert.ok(conflicts.every((conflict) => conflict.values.every((entry) => entry.unit !== 'tokens')))
})