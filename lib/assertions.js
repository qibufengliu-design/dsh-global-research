/**
 * Assertion-level conflicts.
 *
 * Stance-level disagreement ("this page supports, that page refutes") is
 * produced by the evidence extractor, but two pages can also quietly state
 * different numbers for the same property — `0.2 元/百万 tokens` vs
 * `$1.5 / M`, `v22.11.0` vs `22.12.0`, `2027-04-30` vs `2026 年 11 月`.
 * This module pulls `(attribute, value, unit, time)` tuples out of evidence
 * cards with regular expressions and reports the properties where independent
 * sources disagree.
 *
 * False positives are worse than misses here: a fabricated contradiction makes
 * the reader distrust the whole brief. The rules therefore are:
 *
 *  - a source that states several different values for one property is listing
 *    a table/changelog, not making a claim: it is left out of the comparison;
 *  - the same source, different time: the newer statement wins — an updated
 *    page is not a disagreement with itself;
 *  - at least two independent sources must remain before anything is reported;
 *  - units are converted before comparing (`元/千 tokens` vs `元/百万 tokens`,
 *    `v22.11.0` vs `22.11.0`, month vs day precision);
 *  - when conversion is impossible (CNY vs USD without a rate) both values are
 *    listed side by side with their own units instead of being dropped;
 *  - assertions with no named property (`>90%` in mid-sentence, a bare
 *    `v22.11.0`) are extracted but never compared: "比例" alone is not a claim
 *    about the same thing across two unrelated pages;
 *  - a version number is compared only when every source frames it as the
 *    current/required one: `22.11.0 已发布` and `22.12.0 已发布` are two release
 *    notes, not two answers to one question.
 */

import { domainOf } from './util.js'

const MAX_LABEL = 20
const MAX_QUOTE = 160
const EPSILON = 1e-6
const LIMIT = 1e9

const CURRENCY_BY_SYMBOL = Object.freeze({
  '$': 'USD', '¥': 'CNY', '￥': 'CNY', '€': 'EUR', '£': 'GBP',
})
const CURRENCY_NAME = Object.freeze({ USD: '美元', CNY: '元', EUR: '欧元', GBP: '英镑' })
const CURRENCY_BY_WORD = Object.freeze({
  元: 'CNY', 人民币: 'CNY', cny: 'CNY', 美元: 'USD', usd: 'USD',
  欧元: 'EUR', eur: 'EUR', 英镑: 'GBP', gbp: 'GBP',
})
// Scale words used after both a currency symbol and a currency word.
const SCALE = Object.freeze({ 十亿: 1e9, 百万: 1e6, 千: 1e3, b: 1e9, m: 1e6, k: 1e3 })

const COMPARATORS = Object.freeze({
  '>': '>', '>=': '>=', '≥': '>=', '≥=': '>=', '<': '<', '<=': '<=', '≤': '<=', '≤=': '<=',
  超过: '>', 高于: '>', 多于: '>', 低于: '<', 少于: '<',
  至少: '>=', 不低于: '>=', 不少于: '>=', 最多: '<=', 不超过: '<=',
})

/* ------------------------------------------------------------------ *
 * Patterns. Every capture is justified in the comment above it.
 * ------------------------------------------------------------------ */

// $1.5 / M, ¥0.2/千 tokens, €3 / B
const PRICE_SYMBOL = /([$¥€£￥])\s*(\d+(?:\.\d+)?)\s*(?:\/\s*(十亿|百万|千|B|M|K)\s*(?:tokens?)?)?/gi
// 0.2 元/百万 tokens, 1.5 美元 / M, 3000 元/月
const PRICE_WORD = /(\d+(?:\.\d+)?)\s*(元|人民币|美元|欧元|英镑|CNY|USD|EUR|GBP)\s*(?:\/\s*(十亿|百万|千|B|M|K)?\s*(?:tokens?|token)?)?/gi

// Node 22.11.0, Node v22.11.0, Spring Boot 3.5
const VERSION_PRODUCT = /\b([A-Za-z][A-Za-z0-9.+#_-]*(?:\s+[A-Z][A-Za-z0-9.+#_-]*){0,2})\s+v?(\d+(?:\.\d+){1,3})\b/g
// A bare v22.11.0 only gets an attribute when the text names the product.
const VERSION_BARE = /\bv(\d+(?:\.\d+){1,3})\b/gi
// Node 22, Vue 3 — a product followed by a single major number.
const VERSION_MAJOR = /\b([A-Z][A-Za-z0-9.+#_-]*)\s+(\d{1,3})(?![\d.]|[A-Za-z])/g

// 2027-04-30
const DATE_ISO = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g
// 2026 年 11 月, 2026 年 11 月 30 日
const DATE_CN = /(\d{4})\s*年\s*(\d{1,2})\s*月(?:\s*(\d{1,2})\s*[日号])?/g
// 2027/04/30
const DATE_SLASH = /\b(\d{4})\/(\d{1,2})\/(\d{1,2})\b/g

// >90%, 至少 90%, 90%
const PERCENT = /([<>≥≤]=?|超过|高于|多于|低于|少于|至少|不低于|不少于|最多|不超过)?\s*(\d+(?:\.\d+)?)\s*(%|％)/g

// 8–10 人, 8 到 10 人, 8 至 10 名
const COUNT_RANGE = /(\d+(?:\.\d+)?)\s*(?:[–—~～-]|到|至)\s*(\d+(?:\.\d+)?)\s*(人|名|位)(?!民币)/g
// 12 人, 12 名员工
const COUNT_SINGLE = /(\d+(?:\.\d+)?)\s*(?:人|名员工|名成员|个人)(?!民币)/g

const LABEL_SPLITTERS = ['。', '！', '？', '；', '\n', '，', ',', ':', '：']
// A version number only claims a role ("the current one") when the text says
// so. "22.11.0 was released" and "22.12.0 was released" are two release notes,
// not two answers to one question.
const VERSION_STATE = /当前|目前|现在|最新|最新版|目前稳定|latest|current|newest|required|minimum|最低|至少/u
const LABEL_TAIL = /(?:大约|约为|约|大概|预计|已经|已|将会|将|会|可以|可|达到|达|报出|共计|共|计|目前|现在|当前|根据|显示|表明|表示|称为|超过|高于|低于|为|是|有|在|其|该|\s)+$/g

const STOP_WORDS = new Set([
  'released', 'release', 'version', 'versions', 'updated', 'update', 'required', 'requires',
  'minimum', 'latest', 'latestversion', 'installed', 'install', 'supports', 'support',
  'using', 'use', 'based', 'current', 'nodejs', 'the', 'and', 'with', 'for', 'from', 'since',
  'tokens', 'token', 'million', 'thousand', 'price', 'pricing', 'cost',
])

function normalizeText(value) {
  return String(value ?? '').replace(/\s+/g, '').replace(/的/g, '')
}

/** The readable property name immediately before a value (best effort). */
function labelBefore(text, index) {
  const window = String(text ?? '').slice(Math.max(0, index - 44), index)
  let cut = -1
  for (const splitter of LABEL_SPLITTERS) {
    const at = window.lastIndexOf(splitter)
    if (at > cut) cut = at
  }
  let segment = cut >= 0 ? window.slice(cut + 1) : window
  segment = segment.replace(/[（(【\[]\s*$/, '').replace(LABEL_TAIL, '').trim()
  if (!segment) return ''
  const chars = [...segment]
  return chars.slice(-MAX_LABEL).join('')
}

/** Comparison key for a property name: punctuation/spaces/的 are not meaning. */
function labelKey(raw) {
  return normalizeText(raw)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}.+#_-]/gu, '')
    .slice(-MAX_LABEL)
}

/**
 * Two property names describe the same property when one is the other with a
 * qualifier added ("报告义务生效日期" / "生效日期"). A two-character suffix
 * ("价格") is not enough: input and output price must stay apart.
 */
function sameAttribute(left, right) {
  if (!left || !right) return false
  if (left === right) return true
  const [longer, shorter] = left.length >= right.length ? [left, right] : [right, left]
  if (shorter.length < 4) return false
  return longer.endsWith(shorter)
}

/** Last meaningful Latin product token before a bare version/price. */
function productBefore(text, index) {
  const window = String(text ?? '').slice(Math.max(0, index - 48), index)
  const tokens = window.match(/[A-Za-z][A-Za-z0-9.+#_-]*/g) ?? []
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    const token = tokens[i]
    if (STOP_WORDS.has(token.toLowerCase())) continue
    if (token.length < 2) continue
    return token
  }
  return ''
}

function currencyUnit(currency, scale) {
  const name = CURRENCY_NAME[currency] ?? currency
  if (!scale) return name
  return `${name}/百万 tokens`
}

function priceAssertion({ amount, currency, scale, text, index, extra }) {
  if (!Number.isFinite(amount) || amount < 0) return null
  const perMillion = scale ? amount * (1e6 / scale) : null
  return {
    kind: 'price',
    attribute: labelBefore(text, index),
    value: String(amount),
    unit: currencyUnit(currency, scale),
    norm: perMillion !== null ? { currency, perMillion } : { currency, amount },
    generic: false,
    ...extra,
  }
}

function versionParts(raw) {
  return String(raw).split('.').map((part) => Number(part)).filter((part) => Number.isFinite(part))
}

function dateNorm(year, month, day) {
  const y = Number(year)
  const m = month === undefined || month === null ? null : Number(month)
  const d = day === undefined || day === null ? null : Number(day)
  if (!Number.isFinite(y) || y < 1900 || y > 2200) return null
  if (m !== null && (m < 1 || m > 12)) return null
  if (d !== null && (d < 1 || d > 31)) return null
  return { y, m, d }
}

function isoDate(norm) {
  const pad = (value) => String(value).padStart(2, '0')
  if (norm.m === null) return String(norm.y)
  if (norm.d === null) return `${norm.y}-${pad(norm.m)}`
  return `${norm.y}-${pad(norm.m)}-${pad(norm.d)}`
}

function percentNorm(comparator, amount) {
  switch (comparator) {
    case '>': return { lo: amount + EPSILON, hi: LIMIT }
    case '>=': return { lo: amount, hi: LIMIT }
    case '<': return { lo: -LIMIT, hi: amount - EPSILON }
    case '<=': return { lo: -LIMIT, hi: amount }
    default: return { lo: amount, hi: amount }
  }
}

function normalizeTime(value) {
  const text = String(value ?? '').trim()
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : ''
}

function normKey(assertion) {
  return `${assertion.kind}|${JSON.stringify(assertion.norm)}`
}

function baseAssertion(item) {
  const domain = item.domain || domainOf(item.url) || ''
  return {
    source: item.id || domain || String(item.url ?? ''),
    sourceKey: domain || String(item.url ?? ''),
    domain,
    time: normalizeTime(item.publishedAt),
    quote: String(item.quote ?? item.claim ?? '').slice(0, MAX_QUOTE),
  }
}

function collect(text, regex, build, extra, out, seen) {
  for (const match of text.matchAll(regex)) {
    const assertion = build(match, extra)
    if (!assertion) continue
    const key = normKey(assertion)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(assertion)
  }
}

/**
 * Extract every numeric assertion a single evidence card makes.
 *
 * @param {object} item evidence card ({claim, quote, url, domain, publishedAt, id})
 * @returns {Array<{attribute, kind, value, unit, time, source, quote, norm, generic}>}
 */
export function extractAssertions(item = {}) {
  const claim = typeof item.claim === 'string' ? item.claim : ''
  const quote = typeof item.quote === 'string' ? item.quote : ''
  const text = [claim, quote].filter((part) => part.trim()).join('\n')
  if (!text) return []
  const base = baseAssertion(item)
  const out = []
  const seen = new Set()

  collect(text, PRICE_SYMBOL, (match) => {
    const currency = CURRENCY_BY_SYMBOL[match[1]]
    const scale = SCALE[String(match[3] ?? '').toLowerCase()] ?? null
    return priceAssertion({ amount: Number(match[2]), currency, scale, text, index: match.index, extra: base })
  }, base, out, seen)
  collect(text, PRICE_WORD, (match) => {
    const currency = CURRENCY_BY_WORD[String(match[2]).toLowerCase()] ?? CURRENCY_BY_WORD[match[2]]
    const scale = SCALE[String(match[3] ?? '').toLowerCase()] ?? null
    return priceAssertion({ amount: Number(match[1]), currency, scale, text, index: match.index, extra: base })
  }, base, out, seen)

  collect(text, VERSION_PRODUCT, (match) => {
    const parts = versionParts(match[2])
    if (parts.length < 2) return null
    return {
      ...base,
      kind: 'version',
      attribute: match[1].trim(),
      value: parts.join('.'),
      unit: '版本',
      norm: { parts },
      state: VERSION_STATE.test(text),
      generic: false,
    }
  }, base, out, seen)
  collect(text, VERSION_BARE, (match) => {
    const parts = versionParts(match[1])
    if (parts.length < 2) return null
    const product = productBefore(text, match.index)
    return {
      ...base,
      kind: 'version',
      attribute: product,
      value: parts.join('.'),
      unit: '版本',
      norm: { parts },
      state: VERSION_STATE.test(text),
      generic: !product,
    }
  }, base, out, seen)
  collect(text, VERSION_MAJOR, (match) => {
    const parts = versionParts(match[2])
    return {
      ...base,
      kind: 'version',
      attribute: match[1].trim(),
      value: parts.join('.'),
      unit: '版本',
      norm: { parts },
      state: VERSION_STATE.test(text),
      // "Node 22" and "Node 20" are two product lines, not two answers to the
      // same question: a bare major version is extracted for display but never
      // compared. Only a dotted version makes a specific-enough claim.
      generic: true,
    }
  }, base, out, seen)

  collect(text, DATE_ISO, (match) => {
    const norm = dateNorm(match[1], match[2], match[3])
    if (!norm) return null
    return {
      ...base,
      kind: 'date',
      attribute: labelBefore(text, match.index),
      value: isoDate(norm),
      unit: norm.d === null ? '月份' : '日期',
      norm,
      generic: false,
    }
  }, base, out, seen)
  collect(text, DATE_CN, (match) => {
    const norm = dateNorm(match[1], match[2], match[3])
    if (!norm) return null
    return {
      ...base,
      kind: 'date',
      attribute: labelBefore(text, match.index),
      value: isoDate(norm),
      unit: norm.d === null ? '月份' : '日期',
      norm,
      generic: false,
    }
  }, base, out, seen)
  collect(text, DATE_SLASH, (match) => {
    const norm = dateNorm(match[1], match[2], match[3])
    if (!norm) return null
    return {
      ...base,
      kind: 'date',
      attribute: labelBefore(text, match.index),
      value: isoDate(norm),
      unit: '日期',
      norm,
      generic: false,
    }
  }, base, out, seen)

  collect(text, PERCENT, (match) => {
    const comparator = COMPARATORS[match[1]] ?? ''
    const amount = Number(match[2])
    if (!Number.isFinite(amount) || amount < 0 || amount > 100) return null
    const label = labelBefore(text, match.index)
    return {
      ...base,
      kind: 'percent',
      attribute: label,
      value: `${comparator}${amount}`,
      unit: '%',
      norm: percentNorm(comparator, amount),
      generic: labelKey(label) === '',
    }
  }, base, out, seen)

  // Ranges first: "8–10 人" must not also produce a "10 人" single-count claim.
  const occupied = []
  collect(text, COUNT_RANGE, (match) => {
    const low = Number(match[1])
    const high = Number(match[2])
    if (!Number.isFinite(low) || !Number.isFinite(high)) return null
    occupied.push([match.index, match.index + match[0].length])
    const label = labelBefore(text, match.index)
    return {
      ...base,
      kind: 'headcount',
      attribute: label,
      value: `${low}–${high}`,
      unit: '人',
      norm: { lo: Math.min(low, high), hi: Math.max(low, high) },
      generic: labelKey(label) === '',
    }
  }, base, out, seen)
  for (const match of text.matchAll(COUNT_SINGLE)) {
    const start = match.index
    const end = start + match[0].length
    if (occupied.some(([from, to]) => start < to && end > from)) continue
    const amount = Number(match[1])
    if (!Number.isFinite(amount)) continue
    const label = labelBefore(text, start)
    const assertion = {
      ...base,
      kind: 'headcount',
      attribute: label,
      value: String(amount),
      unit: '人',
      norm: { lo: amount, hi: amount },
      generic: labelKey(label) === '',
    }
    const key = normKey(assertion)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(assertion)
  }

  return out
}

/* ------------------------------------------------------------------ *
 * Comparison: convert units first, then decide whether two values agree.
 * ------------------------------------------------------------------ */

function closeEnough(left, right) {
  const diff = Math.abs(left - right)
  return diff <= Math.max(EPSILON, Math.max(Math.abs(left), Math.abs(right)) * 1e-6)
}

function samePrice(left, right) {
  if (left.norm.currency !== right.norm.currency) return { same: false, incomparable: true }
  if (left.norm.perMillion !== undefined && right.norm.perMillion !== undefined) {
    return { same: closeEnough(left.norm.perMillion, right.norm.perMillion), incomparable: false }
  }
  if (left.norm.amount !== undefined && right.norm.amount !== undefined) {
    return { same: closeEnough(left.norm.amount, right.norm.amount), incomparable: false }
  }
  return { same: false, incomparable: true }
}

function samePercent(left, right) {
  return { same: left.norm.lo <= right.norm.hi + EPSILON && right.norm.lo <= left.norm.hi + EPSILON, incomparable: false }
}

function sameHeadcount(left, right) {
  return { same: left.norm.lo <= right.norm.hi + EPSILON && right.norm.lo <= left.norm.hi + EPSILON, incomparable: false }
}

function sameVersion(left, right) {
  const a = left.norm.parts
  const b = right.norm.parts
  const length = Math.min(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    if (a[index] !== b[index]) return { same: false, incomparable: false }
  }
  return { same: true, incomparable: false }
}

function sameDate(left, right) {
  const a = left.norm
  const b = right.norm
  if (a.y !== b.y) return { same: false, incomparable: false }
  if (a.m !== null && b.m !== null && a.m !== b.m) return { same: false, incomparable: false }
  if (a.d !== null && b.d !== null && a.d !== b.d) return { same: false, incomparable: false }
  return { same: true, incomparable: false }
}

const COMPARE = {
  price: samePrice,
  percent: samePercent,
  headcount: sameHeadcount,
  version: sameVersion,
  date: sameDate,
}

function compareValues(kind, left, right) {
  const compare = COMPARE[kind]
  if (!compare) return { same: true, incomparable: false }
  return compare(left, right)
}

/**
 * One source's claim about one property. Same source + newer time wins; a
 * source that states several values at the same time is a table, so it is
 * dropped rather than turned into a fake disagreement.
 */
function claimPerSource(assertions) {
  const bySource = new Map()
  for (const assertion of assertions) {
    if (!assertion || assertion.generic) continue
    const key = assertion.sourceKey || assertion.source
    if (!key) continue
    const bucket = bySource.get(key) ?? []
    bucket.push(assertion)
    bySource.set(key, bucket)
  }
  const claims = []
  for (const bucket of bySource.values()) {
    const distinct = new Map()
    for (const assertion of bucket) distinct.set(normKey(assertion), assertion)
    if (distinct.size === 1) {
      claims.push(bucket[0])
      continue
    }
    let newest = bucket[0]
    for (const assertion of bucket) {
      if (assertion.time > newest.time) newest = assertion
    }
    const atNewest = bucket.filter((assertion) => assertion.time === newest.time)
    const newestValues = new Set(atNewest.map((assertion) => normKey(assertion)))
    // Several values timestamped identically: a list, not a claim. (When the
    // times are unknown the page is treated the same way, conservatively.)
    if (newestValues.size === 1) claims.push(newest)
  }
  return claims
}

function conflictFromGroup(group) {
  const claims = claimPerSource(group.assertions)
  if (claims.length < 2) return null
  // A released version is not a claim about "the version"; only when every
  // source frames its number as the current/required one can they disagree.
  if (group.kind === 'version' && !claims.every((claim) => claim.state)) return null
  const representatives = []
  for (const claim of claims) {
    if (representatives.some((other) => normKey(other) === normKey(claim))) continue
    representatives.push(claim)
  }
  if (representatives.length < 2) return null
  let disagree = false
  for (let i = 0; i < representatives.length && !disagree; i += 1) {
    for (let j = i + 1; j < representatives.length; j += 1) {
      if (!compareValues(group.kind, representatives[i], representatives[j]).same) {
        disagree = true
        break
      }
    }
  }
  if (!disagree) return null
  return {
    attribute: group.label || '数值',
    values: representatives.slice(0, 4).map((claim) => ({
      value: claim.value,
      unit: claim.unit,
      source: claim.source,
      quote: claim.quote,
    })),
  }
}

/**
 * Report the numeric properties that independent sources state differently.
 *
 * @param {Array<object>} items evidence cards (assignSourceIds ids are used as source)
 * @returns {Array<{attribute: string, values: Array<{value, unit, source, quote}>}>}
 */
export function findAssertionConflicts(items = []) {
  const assertions = []
  for (const item of items) {
    if (!item) continue
    assertions.push(...extractAssertions(item))
  }
  const groups = []
  for (const assertion of assertions) {
    const key = labelKey(assertion.attribute)
    if (!key || assertion.generic) continue
    const group = groups.find((candidate) => candidate.kind === assertion.kind && sameAttribute(candidate.key, key))
    if (group) {
      group.assertions.push(assertion)
    } else {
      groups.push({ kind: assertion.kind, key, label: assertion.attribute, assertions: [assertion] })
    }
  }
  const conflicts = []
  for (const group of groups) {
    const conflict = conflictFromGroup(group)
    if (conflict) conflicts.push(conflict)
  }
  return conflicts
}