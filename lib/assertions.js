/**
 * Assertion-level conflicts.
 *
 * Stance-level disagreement ("this page supports, that page refutes") is
 * produced by the evidence extractor, but two pages can also quietly state
 * different numbers for the same property — `0.2 元/百万 tokens` vs
 * `$1.5 / M`, `v22.11.0` vs `22.12.0`, `2027-04-30` vs `2026 年 11 月`,
 * `输出上限 384K tokens` vs `max_output_tokens 256K`.
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
 *  - when conversion is impossible (CNY vs USD without a rate, tokens vs bytes)
 *    both values are listed side by side with their own units instead of being
 *    dropped, and the line is marked「单位不一致」;
 *  - two property names that mean the same thing because the domain always
 *    writes them several ways (`输出上限`, `最大输出`, `max_output_tokens`,
 *    `output tokens`) are normalised to one attribute before comparing;
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

// Capacity is the sixth family: token budgets, context windows, concurrency,
// storage. Product pages write the same property four different ways
// (输出上限 / 最大输出 / max_output_tokens / output tokens), so the numbers are
// only comparable after the attribute is normalised.
//
// 384K tokens, 128 万上下文, 200 并发连接, 512 MB 存储.
// Longest unit alternative first, or "上下文" would swallow "上下文窗口". Gaps
// allow spaces but not newlines: claims and quotes are joined with "\n", and a
// trailing scale letter must not be borrowed from the next line ("256000\nmax…").
// A Latin scale may not be followed by another letter, or the "M" of "1024 MB"
// would be read as millions and leave the "B" as a stray unit.
const SCALE_TOKEN = '(K|M|B|万|亿|千)(?![A-Za-z])'
const CAPACITY_SCALED = new RegExp(`(\\d+(?:\\.\\d+)?)[ \\t]*(?:${SCALE_TOKEN})?[ \\t]*(?:个|条|路)?[ \\t]*(tokens?|上下文窗口|上下文|窗口|并发连接|并发|连接|存储|MB|GB|TB)`, 'gi')
// 最多 384K tokens, 上限 256K, ≤ 200 并发, 不超过 8 GB. The bound word is carried
// on the assertion as `modifier: 'limit'` rather than compared as a value.
const CAPACITY_LIMIT = new RegExp(`(最多|最大|上限|≤|不超过)[ \\t]*(?:为|是|达到|达|约有|约|支持|可达)?[ \\t]*(\\d+(?:\\.\\d+)?)[ \\t]*(?:${SCALE_TOKEN})?[ \\t]*(?:个|条|路)?[ \\t]*(tokens?|上下文窗口|上下文|窗口|并发连接|并发|连接|存储|MB|GB|TB)?`, 'gi')
// max_output_tokens: 4096, 上下文窗口：128K, 输出上限 384K — in API docs and
// datasheets the property name *is* the unit, so a bare number must still be
// read as a token capacity.
const CAPACITY_KEY = new RegExp(`(max[_\\s-]?output[_\\s-]?tokens|output[_\\s-]?tokens|context[_\\s-]?window|上下文窗口|上下文长度|输出上限|最大输出)[ \\t]*[:：=＝]?[ \\t]*(?:为|是)?[ \\t]*[（(]?[ \\t]*(\\d+(?:\\.\\d+)?)[ \\t]*(K|M|B|万|亿)?(?!\\d)`, 'gi')

const CAPACITY_SCALE = Object.freeze({ k: 1e3, m: 1e6, b: 1e9, 千: 1e3, 万: 1e4, 亿: 1e8 })
const CAPACITY_FAMILY = Object.freeze({
  token: 'tokens', tokens: 'tokens', 上下文: 'tokens', 上下文窗口: 'tokens', 窗口: 'tokens',
  并发: 'concurrency', 并发连接: 'concurrency', 连接: 'concurrency',
  存储: 'storage', mb: 'storage', gb: 'storage', tb: 'storage',
})
// Storage is binary in every datasheet (1 GB = 1024 MB); token budgets are
// decimal (1M = 1,000,000) — converting both with one base would invent a
// disagreement between 1024 MB and 1 GB.
const STORAGE_IN_MB = Object.freeze({ mb: 1, gb: 1024, tb: 1024 * 1024 })

/* ------------------------------------------------------------------ *
 * The object a number belongs to.
 *
 * 65536 tokens is qwen3-coder-plus' output ceiling and, separately, an
 * on-demand limit of Claude Sonnet 4 on Bedrock: two correct statements about
 * two different models. Comparing them invents a contradiction, so every
 * assertion carries the object it describes (`entity`) and two numbers are only
 * compared inside one entity. A page that names no model leaves `entity: null`
 * ("object unknown"), which may only be compared through the narrow
 * two-values rule in analyzeAssertions().
 * ------------------------------------------------------------------ */
const MODEL_WORDS = 'sonnet|opus|haiku|pro|flash|mini|turbo|instruct|chat|lite|preview|thinking|vision|omni'
// A run must contain a digit and either a hyphen/underscore-joined identifier
// (claude-3-7-sonnet-20250219, qwen3-coder-plus, GPT-4o, DeepSeek-V3) or a
// model word (Claude 3.7 Sonnet, Gemini 1.5 Pro). "Node 22.11.0" is a version,
// not a model, and "Bedrock" alone is not a subject: both stay unknown.
const ENTITY_RUN = new RegExp(
  `(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9]*(?:(?:[._-][A-Za-z0-9]+)|[ \\t]+\\d+(?:\\.\\d+)*|[ \\t]+(?:${MODEL_WORDS}))*)(?![A-Za-z0-9])`,
  'gi',
)
const MODEL_WORD = new RegExp(`(?:^|[\\s._-])(?:${MODEL_WORDS})(?![A-Za-z])`, 'i')

function modelName(name) {
  if (!/\d/.test(name)) return false
  // claude-3-7-sonnet-20250219, qwen3-coder-plus, DeepSeek-V3, GPT-4o: an
  // identifier that joins letters, digits and hyphens is a model id.
  if (/[._-]/.test(name)) return true
  return MODEL_WORD.test(name)
}

/** Model ids differ only in spelling and snapshot date: claude-3-7-sonnet-20250219 ≡ Claude 3.7 Sonnet. */
export function normalizeEntity(raw) {
  return String(raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    // A trailing release date names a deployment, not a different model.
    .replace(/-v?\d{8}$/, '')
    .replace(/^-+|-+$/g, '')
}

/**
 * The nearest model/product name before the value; failing that, a name that
 * follows it on the same line. `index` is where the value itself starts: a run
 * that overlaps it is the value's own identifier ("Node 22.11.0"), not the
 * object the value describes, and is skipped. Nearest wins: a quote that
 * mentions several models must not hang every number on the first name it
 * happens to contain, and a repeated claim/quote line must not be mistaken for
 * a second name.
 */
function entityFor(text, index) {
  const source = String(text ?? '')
  const lineEnd = source.indexOf('\n', index)
  const limit = lineEnd === -1 ? source.length : lineEnd
  let chosen = null
  for (const match of source.matchAll(ENTITY_RUN)) {
    const name = match[1].trim()
    if (!modelName(name)) continue
    const start = match.index
    const stop = start + match[0].length
    if (start >= limit) break
    if (stop <= index) {
      chosen = name
      continue
    }
    // A name after the number ("65536 tokens（qwen3-coder-plus）") still names
    // the object, but only within the same line as the value.
    if (chosen === null && start >= index) chosen = name
  }
  return chosen
}

// Property names that mean one thing; the first matching alias wins, so a
// narrow spelling must not be listed after a broader one that would swallow it.
const ATTRIBUTE_ALIASES = Object.freeze([
  {
    key: 'output_capacity',
    label: '输出上限',
    patterns: [/输出上限/, /最大输出/, /max[_\s-]?output[_\s-]?tokens/i, /output\s+tokens/i],
  },
  {
    key: 'context_window',
    label: '上下文窗口',
    patterns: [/上下文窗口/, /上下文长度/, /上下文/, /context[_\s-]?window/i],
  },
  {
    key: 'output_price',
    label: '输出价格',
    patterns: [/输出价/, /output\s+price/i],
  },
  {
    key: 'input_price',
    label: '输入价格',
    patterns: [/输入价/, /input\s+price/i],
  },
])

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

/**
 * The canonical property behind a label, or null. `输出上限 384K` and
 * `max_output_tokens: 256000` answer the same question; without this the two
 * claims sit in different groups and never get compared.
 */
function attributeAlias(raw) {
  const text = String(raw ?? '')
  if (!text) return null
  for (const alias of ATTRIBUTE_ALIASES) {
    if (alias.patterns.some((pattern) => pattern.test(text))) return alias
  }
  return null
}

/**
 * Identity of one mention, used to drop the same number extracted twice (a
 * "输出上限 384K tokens" is matched by the key, bound and scaled patterns). For
 * a known property the canonical name is part of the key, so one source stating
 * the same number for two properties (上下文 128K / 输出上限 128K) is not
 * collapsed; every other kind keeps the historical value-only identity.
 */
function assertionKey(assertion) {
  const key = normKey(assertion)
  const alias = attributeAlias(assertion.attribute)
  return alias ? `${key}|alias:${alias.key}` : key
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
    entity: entityFor(text, index),
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

/** Same host and same page = the same source, updated in place. */
function pageKey(rawUrl) {
  try {
    const url = new URL(String(rawUrl ?? ''))
    const host = url.hostname.replace(/^www\./i, '').toLowerCase()
    return `${host}${url.pathname.replace(/\/+$/, '')}`
  } catch {
    return ''
  }
}

function baseAssertion(item) {
  const domain = item.domain || domainOf(item.url) || ''
  return {
    source: item.id || domain || String(item.url ?? ''),
    sourceKey: pageKey(item.url) || domain || String(item.url ?? ''),
    domain,
    time: normalizeTime(item.publishedAt),
    quote: String(item.quote ?? item.claim ?? '').slice(0, MAX_QUOTE),
  }
}

function collect(text, regex, build, extra, out, seen) {
  for (const match of text.matchAll(regex)) {
    const assertion = build(match, extra)
    if (!assertion) continue
    const key = assertionKey(assertion)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(assertion)
  }
}

/**
 * One capacity claim. `impliedFamily` carries the unit for "max_output_tokens:
 * 4096" and for a bare `上限 256K`, where the property name already says what is
 * being counted; a bare `10 万` with no unit is a headcount, not a capacity.
 */
function capacityAssertion({ amountText, scaleText, unitWord, label, impliedFamily, limit, text, index, extra }) {
  const amount = Number(amountText)
  if (!Number.isFinite(amount) || amount < 0) return null
  const scaleKey = String(scaleText ?? '').toLowerCase()
  const scale = CAPACITY_SCALE[scaleKey] ?? null
  const unitRaw = String(unitWord ?? '')
  let family = CAPACITY_FAMILY[unitRaw.toLowerCase()] ?? CAPACITY_FAMILY[unitRaw] ?? ''
  if (!family) {
    if (impliedFamily) family = impliedFamily
    else if (!scale || ['千', '万', '亿'].includes(scaleKey)) return null
    else family = 'tokens'
  }
  const attribute = String(label ?? '')
  const storageScale = family === 'storage' ? STORAGE_IN_MB[unitRaw.toLowerCase()] : undefined
  return {
    kind: 'capacity',
    attribute,
    entity: entityFor(text, index),
    value: `${amountText}${scaleText ?? ''}`,
    unit: unitRaw || 'tokens',
    // The bound word is normalised, not compared: 上限 384K and 实测 384K state
    // the same capacity, so they must agree rather than count as two values.
    modifier: limit ? 'limit' : '',
    norm: { family, base: storageScale ? amount * storageScale : amount * (scale ?? 1) },
    generic: labelKey(attribute) === '',
    ...extra,
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
      entity: entityFor(text, match.index + match[0].length - match[2].length),
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
      entity: entityFor(text, match.index + match[0].length - match[1].length),
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
      entity: entityFor(text, match.index + match[0].length - match[2].length),
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
      entity: entityFor(text, match.index),
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
      entity: entityFor(text, match.index),
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
      entity: entityFor(text, match.index),
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
      entity: entityFor(text, match.index),
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
      entity: entityFor(text, match.index),
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
      entity: entityFor(text, start),
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

  // Capacity: token budgets, context windows, concurrency, storage. Collected
  // key → bound → scaled so "输出上限 384K tokens" is one claim instead of
  // three, and the property name read off the key form ("输出上限") wins over
  // the label heuristic ("官方输出").
  const occupiedCapacity = []
  const collectCapacity = (regex, build) => {
    for (const match of text.matchAll(regex)) {
      const start = match.index
      const end = start + match[0].length
      if (occupiedCapacity.some(([from, to]) => start < to && end > from)) continue
      const assertion = build(match)
      if (!assertion) continue
      const key = assertionKey(assertion)
      if (seen.has(key)) continue
      seen.add(key)
      occupiedCapacity.push([start, end])
      out.push(assertion)
    }
  }
  collectCapacity(CAPACITY_KEY, (match) => capacityAssertion({
    amountText: match[2],
    scaleText: match[3],
    unitWord: '',
    label: match[1],
    impliedFamily: 'tokens',
    text,
    index: match.index,
    extra: base,
  }))
  collectCapacity(CAPACITY_LIMIT, (match) => {
    const unitRaw = String(match[4] ?? '')
    const before = labelBefore(text, match.index)
    return capacityAssertion({
      amountText: match[2],
      scaleText: match[3],
      unitWord: unitRaw,
      // "官方输出上限 384K": the bound word completes the property name. With no
      // property in front the bound word is all there is to group on.
      label: before ? `${before}${match[1]}` : match[1],
      limit: true,
      text,
      index: match.index,
      extra: base,
    })
  })
  collectCapacity(CAPACITY_SCALED, (match) => capacityAssertion({
    amountText: match[1],
    scaleText: match[2],
    unitWord: match[3],
    label: labelBefore(text, match.index),
    text,
    index: match.index,
    extra: base,
  }))

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

/**
 * 384K tokens and 393216 tokens are the same budget; 384K and 1M are not.
 * Different families (tokens vs MB) cannot be converted into each other, so they
 * are reported side by side and flagged instead of being ranked.
 */
function sameCapacity(left, right) {
  if (left.norm.family !== right.norm.family) return { same: false, incomparable: true }
  return { same: closeEnough(left.norm.base, right.norm.base), incomparable: false }
}

const COMPARE = {
  price: samePrice,
  percent: samePercent,
  headcount: sameHeadcount,
  version: sameVersion,
  date: sameDate,
  capacity: sameCapacity,
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

/**
 * One property group's representatives: one claim per source (newer wins, tables
 * dropped), de-duplicated by normalised value. Empty when the group cannot be
 * compared at all (a single source, or the version-framing gate).
 */
function groupRepresentatives(group) {
  const claims = claimPerSource(group.assertions)
  if (claims.length < 2) return []
  // A released version is not a claim about "the version"; only when every
  // source frames its number as the current/required one can they disagree.
  if (group.kind === 'version' && !claims.every((claim) => claim.state)) return []
  const representatives = []
  for (const claim of claims) {
    if (representatives.some((other) => normKey(other) === normKey(claim))) continue
    representatives.push(claim)
  }
  return representatives.length >= 2 ? representatives : []
}

function assertionValue(claim) {
  return { value: claim.value, unit: claim.unit, source: claim.source, quote: claim.quote }
}

/** A disagreement between claims about the same object, or null. */
function conflictFromClaims(group, claims) {
  if (claims.length < 2) return null
  let incomparable = false
  for (let i = 0; i < claims.length; i += 1) {
    for (let j = i + 1; j < claims.length; j += 1) {
      const verdict = compareValues(group.kind, claims[i], claims[j])
      if (verdict.incomparable) incomparable = true
      if (!verdict.same) {
        return {
          attribute: group.label || '数值',
          // Values that cannot be converted into one unit (元 vs 美元, tokens vs
          // MB) are listed side by side and labelled rather than silently ranked.
          unitMismatch: incomparable,
          values: claims.slice(0, 4).map(assertionValue),
        }
      }
    }
  }
  return null
}

/**
 * Values that differ only because they describe different objects. Not a
 * conflict (two models may legitimately have different limits) — but the reader
 * deserves one note, so the numbers are not silently read as one fact.
 */
function divergenceFromClaims(group, claims, entityKeys) {
  for (let i = 0; i < claims.length; i += 1) {
    for (let j = i + 1; j < claims.length; j += 1) {
      const left = entityKeys[i]
      const right = entityKeys[j]
      if (!left || !right || left === right) continue
      if (compareValues(group.kind, claims[i], claims[j]).same) continue
      return {
        attribute: group.label || '数值',
        values: [assertionValue(claims[i]), assertionValue(claims[j])],
      }
    }
  }
  return null
}

/** Group assertions that answer the same question (kind + normalised property). */
function groupAssertions(assertions) {
  const groups = []
  for (const assertion of assertions) {
    if (!assertion || assertion.generic) continue
    // Normalise the property first: "输出上限 384K" and "max_output_tokens:
    // 256000" are two answers to one question, whatever the wording.
    const alias = attributeAlias(assertion.attribute)
    const key = labelKey(assertion.attribute)
    if (!alias && !key) continue
    const group = groups.find((candidate) => {
      if (candidate.kind !== assertion.kind) return false
      if (alias) return candidate.aliasKey === alias.key
      if (candidate.aliasKey) return false
      return sameAttribute(candidate.key, key)
    })
    if (group) {
      group.assertions.push(assertion)
    } else {
      groups.push({
        kind: assertion.kind,
        key: key || alias.key,
        aliasKey: alias ? alias.key : '',
        label: alias ? alias.label : assertion.attribute,
        assertions: [assertion],
      })
    }
  }
  return groups
}

/**
 * Entity-scoped analysis of the numbers asserted by the evidence cards.
 *
 * Two numbers are only a conflict when they describe the same object:
 *  - same attribute + same entity (both known, equal after normalisation):
 *    compared exactly as before;
 *  - either side `entity: null` (the page never names a model): compared only
 *    when the property has exactly two values in total, so the historical
 *    384K vs 256K case still reports while three or more unnamed values stay
 *    unranked instead of being lined up as contradictions;
 *  - different entities: never a conflict — 65536 tokens is qwen3-coder-plus'
 *    output ceiling and a Bedrock Claude Sonnet 4 on-demand limit — but the
 *    pair is returned as a divergence for the brief's 未解决 note.
 *
 * @param {Array<object>} items evidence cards (assignSourceIds ids are used as source)
 * @returns {{conflicts: Array, divergences: Array}}
 */
export function analyzeAssertions(items = []) {
  const assertions = []
  for (const item of items) {
    if (!item) continue
    assertions.push(...extractAssertions(item))
  }
  const conflicts = []
  const divergences = []
  for (const group of groupAssertions(assertions)) {
    const claims = groupRepresentatives(group)
    if (claims.length < 2) continue
    const entityKeys = claims.map((claim) => normalizeEntity(claim.entity))
    const byEntity = new Map()
    claims.forEach((claim, index) => {
      const key = entityKeys[index]
      if (!key) return
      const bucket = byEntity.get(key) ?? []
      bucket.push(claim)
      byEntity.set(key, bucket)
    })
    for (const bucket of byEntity.values()) {
      const conflict = conflictFromClaims(group, bucket)
      if (conflict) conflicts.push(conflict)
    }
    // Unknown objects are comparable only in the one case where there is no
    // other candidate value to confuse them with.
    if (claims.length === 2 && entityKeys.includes('')) {
      const conflict = conflictFromClaims(group, claims)
      if (conflict) conflicts.push(conflict)
    }
    const divergence = divergenceFromClaims(group, claims, entityKeys)
    if (divergence) divergences.push(divergence)
  }
  return { conflicts, divergences }
}

/**
 * Report the numeric properties that independent sources state differently for
 * the same object.
 *
 * @param {Array<object>} items evidence cards (assignSourceIds ids are used as source)
 * @returns {Array<{attribute: string, values: Array<{value, unit, source, quote}>}>}
 */
export function findAssertionConflicts(items = []) {
  return analyzeAssertions(items).conflicts
}

/**
 * Numeric properties stated differently for *different* named objects. These are
 * not conflicts; the brief mentions them once in 未解决 so the reader does not
 * compare numbers that were never about the same thing.
 */
export function findEntityDivergences(items = []) {
  return analyzeAssertions(items).divergences
}