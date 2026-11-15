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