/**
 * Small dependency-free helpers shared by the research pipeline.
 * No DSH imports here on purpose: everything stays unit-testable with node:test.
 */

export class BudgetExceeded extends Error {
  constructor(kind, limit) {
    super(`budget exceeded: ${kind} (limit ${limit})`)
    this.name = 'BudgetExceeded'
    this.kind = kind
    this.limit = limit
  }
}

export class TimeoutError extends Error {
  constructor(ms) {
    super(`timed out after ${ms}ms`)
    this.name = 'TimeoutError'
  }
}

/** Hard counters for one research run. */
export class Budget {
  constructor(limits) {
    this.limits = { queries: 0, pages: 0, llmCalls: 0, gapRounds: 0, ...limits }
    this.used = { queries: 0, pages: 0, llmCalls: 0, gapRounds: 0 }
  }

  take(kind, n = 1) {
    const limit = this.limits[kind]
    if (limit === undefined) return
    if (this.used[kind] + n > limit) throw new BudgetExceeded(kind, limit)
    this.used[kind] += n
  }

  remaining(kind) {
    return Math.max(0, (this.limits[kind] ?? 0) - (this.used[kind] ?? 0))
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Combine a caller signal with a per-operation timeout. */
export function anySignal(signal, ms) {
  const signals = []
  if (signal) signals.push(signal)
  if (Number.isFinite(ms) && ms > 0) {
    if (typeof AbortSignal.timeout === 'function') signals.push(AbortSignal.timeout(ms))
  }
  if (signals.length === 0) return undefined
  if (signals.length === 1) return signals[0]
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(signals)
  const controller = new AbortController()
  const onAbort = (s) => controller.abort(s.reason)
  for (const s of signals) {
    if (s.aborted) {
      controller.abort(s.reason)
      break
    }
    s.addEventListener('abort', () => onAbort(s), { once: true })
  }
  return controller.signal
}

export function domainOf(rawUrl) {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./, '').toLowerCase()
  } catch {
    return ''
  }
}

const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'gclid', 'fbclid', 'ref', 'ref_src', 'spm', 'from', 'source', 'share_token',
  'mc_cid', 'mc_eid', 'igshid', 'yclid', 'msclkid',
])

/** Canonicalize a URL for de-duplication (drops tracking, fragment, trailing slash). */
export function normalizeUrl(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return ''
  const value = raw.trim()
  try {
    const url = new URL(value.startsWith('//') ? `https:${value}` : value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return value
    url.hash = ''
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(key.toLowerCase())) url.searchParams.delete(key)
    }
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '')
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '')
    return url.toString()
  } catch {
    return value
  }
}

export function tokenSet(text) {
  const normalized = String(text ?? '')
    .toLowerCase()
    .replace(/[\u3000-\u303f\uff00-\uffef]/g, ' ')
  const words = normalized.split(/[^a-z0-9\u4e00-\u9fff]+/).filter((w) => w.length > 1)
  const cjk = normalized.match(/[\u4e00-\u9fff]/g) ?? []
  const bigrams = []
  for (let i = 0; i + 1 < cjk.length; i += 1) bigrams.push(cjk[i] + cjk[i + 1])
  return new Set([...words, ...bigrams])
}

export function jaccard(a, b) {
  const setA = a instanceof Set ? a : tokenSet(a)
  const setB = b instanceof Set ? b : tokenSet(b)
  if (setA.size === 0 || setB.size === 0) return 0
  let intersection = 0
  for (const value of setA) if (setB.has(value)) intersection += 1
  return intersection / (setA.size + setB.size - intersection)
}

/** Two titles describe the same page: near-identical, or one is a short superset of the other. */
function isNearTitle(a, b) {
  if (a.size === 0 || b.size === 0) return false
  if (jaccard(a, b) >= 0.85) return true
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  if (small.size < 3) return false
  for (const token of small) if (!large.has(token)) return false
  return true
}

const LOCALE_SEGMENTS = new Set(['en', 'zh-cn', 'zh-tw', 'ja', 'fr', 'de', 'es', 'pt-br', 'ko', 'ru', 'it', 'pl'])
// EU sites publish the same page under a language prefix (/bg/policies/… vs
// /en/policies/…); treat those as one source instead of citing it twice.
const EU_LOCALES = new Set([
  'bg', 'cs', 'da', 'de', 'el', 'en', 'es', 'et', 'fi', 'fr', 'ga', 'hr', 'hu',
  'it', 'lt', 'lv', 'mt', 'nl', 'pl', 'pt', 'ro', 'sk', 'sl', 'sv',
])

/**
 * Content identity of a URL: mirrors, translations and CDN copies of the same
 * page collapse to one key so the brief lists each entity once.
 */
export function canonicalKey(raw) {
  const normalized = normalizeUrl(raw)
  if (!normalized) return ''
  try {
    const url = new URL(normalized)
    let host = url.hostname.replace(/^www\./, '')
    let path = url.pathname
    const stripExtension = (value) => value
      .replace(/\/index\.html?$/i, '')
      .replace(/\.(md|markdown|html?)$/i, '')
    const jsdelivr = path.match(/^\/gh\/([^/@]+)\/([^/@]+)@([^/]+)\/(.+)$/)
    if (host === 'cdn.jsdelivr.net' && jsdelivr) {
      return `github.com/${jsdelivr[1].toLowerCase()}/${jsdelivr[2].toLowerCase()}/${stripExtension(jsdelivr[4])}`
    }
    const rawGithub = path.match(/^\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/)
    if (host === 'raw.githubusercontent.com' && rawGithub) {
      return `github.com/${rawGithub[1].toLowerCase()}/${rawGithub[2].toLowerCase()}/${stripExtension(rawGithub[4])}`
    }
    if (host === 'url.nodejs.cn') host = 'nodejs.org'
    host = host.replace(/^[a-z-]+\.wikipedia\.org$/, 'wikipedia.org')
    const githubPath = path.match(/^\/([^/]+)\/([^/]+)\/(blob|tree)\/([^/]+)\/(.+)$/)
    if (host === 'github.com' && githubPath) {
      return `github.com/${githubPath[1].toLowerCase()}/${githubPath[2].toLowerCase()}/${stripExtension(githubPath[5])}`
    }
    if (host === 'nodejs.org' || host === 'europa.eu' || host.endsWith('.europa.eu')) {
      const segments = path.split('/').filter(Boolean)
      const locales = host === 'nodejs.org' ? LOCALE_SEGMENTS : EU_LOCALES
      if (segments.length > 1 && locales.has(segments[0].toLowerCase())) {
        path = `/${segments.slice(1).join('/')}`
      }
    }
    return `${host}${stripExtension(path).replace(/\/+$/, '')}`
  } catch {
    return normalized
  }
}

/** A less canonical copy of a page (CDN mirror or translated locale), safe to replace in place. */
export function isMirrorUrl(raw) {
  try {
    const url = new URL(String(raw))
    const host = url.hostname.replace(/^www\./, '')
    if (host === 'cdn.jsdelivr.net' || host === 'url.nodejs.cn') return true
    if (host === 'nodejs.org') {
      const first = url.pathname.split('/').filter(Boolean)[0] ?? ''
      return LOCALE_SEGMENTS.has(first.toLowerCase())
    }
    return false
  } catch {
    return false
  }
}

const TRUSTED_DOMAINS = [
  'github.com', 'gitlab.com', 'arxiv.org', 'docs.python.org', 'nodejs.org',
  'developer.mozilla.org', 'stackoverflow.com', 'stackexchange.com',
  'npmjs.com', 'pypi.org', 'rust-lang.org', 'go.dev', 'kubernetes.io',
  'docs.docker.com', 'postgresql.org', 'sqlite.org', 'w3.org', 'ietf.org',
  'acm.org', 'ieee.org', 'nature.com', 'science.org', 'who.int',
]

// Primary sources: laws, regulators, standards bodies. Evidence resting only on
// second-hand commentary must not be presented with a confident verdict.
const OFFICIAL_DOMAINS = [
  'europa.eu', 'eur-lex.europa.eu', 'ec.europa.eu', 'enisa.europa.eu',
  'un.org', 'oecd.org', 'imf.org', 'worldbank.org', 'iso.org', 'iec.ch',
  'nist.gov', 'iana.org', 'unicode.org', 'wipo.int', 'wto.org',
]

export function isOfficialDomain(url) {
  const domain = domainOf(url)
  return OFFICIAL_DOMAINS.some((official) => domain === official || domain.endsWith(`.${official}`))
    || domain.endsWith('.gov') || domain.endsWith('.gov.cn')
}

/**
 * Time-sensitive questions must not be answered from a stale cache: "latest",
 * "current", prices, releases and EOL dates change between two questions.
 * Deliberately broad — a false positive only costs one re-run, a false
 * negative silently returns yesterday's answer.
 *
 * The vocabulary moved to lib/strategy.js (it is one of the implicit classifiers
 * that PR1 unifies); this stays as the historical import site so callers and the
 * public plugin surface are unchanged.
 */
export { isTimeSensitive } from './strategy.js'

const CONTENT_FARM_HINTS = [
  'pinterest.', 'quora.com/profile', 'answers.yahoo.', 'ehow.com',
  'wikihow.com', 'buzzfeed.', 'slideshare.net', 'scribd.com', 'coursehero.com',
]

// User-configured overrides, set once at plugin apply time. Entries are hosts
// ("example.com") or domain suffixes ("foo.example.com" also matches bar.foo...).
let domainOverrides = { trusted: [], blocked: [] }

export function configureDomainTrust({ trusted = [], blocked = [] } = {}) {
  domainOverrides = {
    trusted: Array.isArray(trusted) ? trusted : [],
    blocked: Array.isArray(blocked) ? blocked : [],
  }
}

function matchesHost(domain, entry) {
  return domain === entry || domain.endsWith(`.${entry}`)
}

export function isBlockedDomain(url) {
  const domain = domainOf(url)
  return domainOverrides.blocked.some((entry) => matchesHost(domain, entry))
}

export function domainTrust(url) {
  const domain = domainOf(url)
  if (isBlockedDomain(url)) return -10
  if (domainOverrides.trusted.some((entry) => matchesHost(domain, entry))) return 3
  if (CONTENT_FARM_HINTS.some((hint) => domain.includes(hint))) return -3
  if (isOfficialDomain(url)) return 3
  if (TRUSTED_DOMAINS.some((trusted) => domain === trusted || domain.endsWith(`.${trusted}`))) return 2
  if (domain.endsWith('.gov') || domain.endsWith('.edu')) return 2
  if (domain.endsWith('.org')) return 1
  return 0
}

/**
 * Age of a dated source in days, or null when the date is missing/unparseable.
 * Callers must treat null as "unknown", never as "fresh": a page without a date
 * is not evidence that it is current.
 */
export function evidenceAgeDays(publishedAt, now = Date.now()) {
  if (publishedAt === null || publishedAt === undefined) return null
  let stamp
  if (publishedAt instanceof Date) stamp = publishedAt.getTime()
  else if (typeof publishedAt === 'number') stamp = publishedAt
  else {
    const text = String(publishedAt).trim()
    if (text === '') return null
    stamp = Date.parse(text)
  }
  if (!Number.isFinite(stamp) || !Number.isFinite(now)) return null
  return (now - stamp) / 86400000
}

/** De-duplicate search hits by URL and near-identical title, merging engine provenance. */
export function dedupeHits(hits, limit = Infinity) {
  const kept = []
  for (const hit of hits) {
    if (!hit || typeof hit.url !== 'string') continue
    const url = normalizeUrl(hit.url)
    if (!url) continue
    const key = canonicalKey(url)
    const existing = kept.find((candidate) => canonicalKey(candidate.url) === key)
    if (existing) {
      for (const engine of hit.engines ?? [hit.engine].filter(Boolean)) existing.engines.add(engine)
      if (!existing.snippet && hit.snippet) existing.snippet = hit.snippet
      if (!existing.publishedAt && hit.publishedAt) existing.publishedAt = hit.publishedAt
      if ((!existing.text || existing.text.length < (hit.text?.length ?? 0)) && hit.text) existing.text = hit.text
      if (isMirrorUrl(existing.url) && !isMirrorUrl(url)) {
        existing.url = url
        if (hit.title) existing.title = hit.title
      }
      continue
    }
    const titleKey = tokenSet(hit.title ?? '')
    const duplicate = kept.find((candidate) => isNearTitle(titleKey, tokenSet(candidate.title ?? '')))
    if (duplicate) {
      for (const engine of hit.engines ?? [hit.engine].filter(Boolean)) duplicate.engines.add(engine)
      if (!duplicate.text && hit.text) duplicate.text = hit.text
      continue
    }
    kept.push({
      url,
      title: hit.title ?? domainOf(url),
      snippet: hit.snippet ?? '',
      text: hit.text,
      publishedAt: hit.publishedAt,
      engines: new Set(hit.engines ?? [hit.engine].filter(Boolean)),
      rank: Number.isFinite(hit.rank) ? hit.rank : kept.length + 1,
    })
    if (kept.length >= limit) break
  }
  return kept
}

/**
 * Rank hits for reading: engine consensus, domain trust, focus coverage, freshness.
 *
 * `boosts` is optional and only additive, so leaving it undefined reproduces the
 * old ranking exactly. Shape: { domains: { 'github.com': 2 }, engines: { hn: 1 },
 * official: 1 } — the classifier uses it to nudge a kind's preferred sources
 * without hard-coding domain names here.
 */
export function rankHits(hits, { focus = [], question = '', now = Date.now(), boosts = undefined } = {}) {
  const focusTokens = tokenSet([question, ...focus].join(' '))
  const domainBoosts = boosts?.domains && typeof boosts.domains === 'object' ? boosts.domains : null
  const engineBoosts = boosts?.engines && typeof boosts.engines === 'object' ? boosts.engines : null
  const officialBoost = Number.isFinite(boosts?.official) ? boosts.official : 0
  // Blocked domains are dropped before selection, so they never spend a page
  // slot or enter the evidence set.
  return [...hits].filter((hit) => !isBlockedDomain(hit.url)).sort((a, b) => score(b) - score(a))

  function score(hit) {
    let value = 0
    value += (hit.engines?.size ?? 1) * 3
    value += domainTrust(hit.url)
    if (isOfficialDomain(hit.url)) value += 2
    if (domainBoosts) {
      const host = domainOf(hit.url)
      for (const [suffix, weight] of Object.entries(domainBoosts)) {
        const clean = String(suffix ?? '').toLowerCase().replace(/^\.+/, '')
        if (!clean || !Number.isFinite(weight)) continue
        if (host === clean || host.endsWith(`.${clean}`)) {
          value += weight
          break
        }
      }
    }
    if (engineBoosts) {
      for (const engine of hit.engines ?? []) {
        const weight = engineBoosts[engine]
        if (Number.isFinite(weight)) {
          value += weight
          break
        }
      }
    }
    if (officialBoost !== 0 && isOfficialDomain(hit.url)) value += officialBoost
    // Prefer the canonical project repo over personal forks of the same content,
    // but only when the repo itself matches the question: a random commit in an
    // unrelated repo is not evidence for this question.
    const repoMatch = /^https?:\/\/github\.com\/([^/]+)\/([^/#?]+)/i.exec(hit.url)
    if (repoMatch) {
      const repoTokens = tokenSet(`${repoMatch[1]} ${repoMatch[2]}`)
      const relevant = /^nodejs$/i.test(repoMatch[1]) || [...repoTokens].some((token) => focusTokens.has(token))
      if (relevant) value += 2
    }
    if (/^https?:\/\/github\.com\/[^/]+\/Release\b/i.test(hit.url) && !/^https?:\/\/github\.com\/nodejs\//i.test(hit.url)) value -= 1
    // EUR-Lex search/translated-summary pages are JS shells with no legal text;
    // the act itself lives under /eli/(reg|dir|dec)/… which the fetcher can map
    // to the Cellar XHTML. Prefer the latter and demote the former.
    if (/eur-lex\.europa\.eu\/(?:[a-z]{2}\/)?(?:legal-content\/summary|search\b)/i.test(hit.url)) value -= 2
    if (/eur-lex\.europa\.eu\/(?:[a-z]{2}\/)?eli\/(?:reg|dir|dec)\//i.test(hit.url)) value += 2
    // Landing pages ("/", "/index_en") rarely carry the fact being asked about.
    try {
      const path = new URL(hit.url).pathname
      if (path === '/' || /^\/index([._-][a-z]{2,5})?\/?$/i.test(path)) value -= 4
    } catch { /* ignore malformed URLs */ }
    const textTokens = tokenSet(`${hit.title} ${hit.snippet}`)
    if (focusTokens.size > 0 && textTokens.size > 0) {
      let overlap = 0
      for (const token of focusTokens) if (textTokens.has(token)) overlap += 1
      value += Math.min(3, overlap * 0.4)
    }
    // Freshness is a small additive term only: it breaks ties between otherwise
    // equal hits and demotes stale pages. It never overrides domain trust, and
    // an undated page sits exactly in the middle (unknown ≠ fresh).
    const ageDays = evidenceAgeDays(hit.publishedAt, now)
    if (ageDays !== null) {
      if (ageDays <= 365) value += 0.6
      else if (ageDays > 730) value -= 1.2
    }
    value -= Math.min(3, (hit.rank ?? 1) / 10)
    return value
  }
}

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—',
  ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”',
  laquo: '«', raquo: '»', sbquo: '‚', bdquo: '„', copy: '©', reg: '®',
  trade: '™', deg: '°', plusmn: '±', times: '×', divide: '÷', micro: 'µ',
  para: '¶', sect: '§', middot: '·', bull: '•', euro: '€', pound: '£',
  yen: '¥', cent: '¢', frac12: '½', frac14: '¼', frac34: '¾', sup2: '²',
  sup3: '³', szlig: 'ß', agrave: 'à', eacute: 'é', uuml: 'ü', ouml: 'ö',
  auml: 'ä', ccedil: 'ç',
}

export function decodeEntities(text) {
  return String(text ?? '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    return ENTITIES[body] ?? match
  })
}

/** Strip markup from HTML into readable plain text with paragraph breaks preserved. */
export function htmlToText(html) {
  let text = String(html ?? '')
  text = text.replace(/<!--[\s\S]*?-->/g, ' ')
  text = text.replace(/<(script|style|noscript|svg|template|iframe|form|nav|footer|header|aside)\b[\s\S]*?<\/\1>/gi, ' ')
  text = text.replace(/<(br|hr)\s*\/?>/gi, '\n')
  text = text.replace(/<\/(p|div|li|tr|h[1-6]|section|article|blockquote|pre)>/gi, '\n')
  text = text.replace(/<li\b[^>]*>/gi, '- ')
  text = text.replace(/<[^>]+>/g, ' ')
  text = decodeEntities(text)
  text = text.replace(/[ \t\u00a0]+/g, ' ')
  text = text.replace(/\n\s*\n\s*\n+/g, '\n\n')
  return text.trim()
}

export function truncate(text, max) {
  const value = String(text ?? '')
  if (!Number.isFinite(max) || value.length <= max) return value
  return `${value.slice(0, Math.max(0, max - 1))}…`
}

/** Parse a JSON object out of a model reply, tolerating fences, prose and trailing commas. */
export function parseLooseJson(text) {
  if (typeof text !== 'string' || text.trim() === '') return null
  let body = text.trim()
  const fence = body.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) body = fence[1].trim()
  const start = body.search(/[[{]/)
  if (start < 0) return null
  body = body.slice(start)
  const end = Math.max(body.lastIndexOf('}'), body.lastIndexOf(']'))
  if (end >= 0) body = body.slice(0, end + 1)

  const attempt = (candidate) => {
    try {
      return JSON.parse(candidate)
    } catch {
      return undefined
    }
  }

  let parsed = attempt(body)
  if (parsed !== undefined) return parsed
  let repaired = body
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/,\s*([}\]])/g, '$1')
  parsed = attempt(repaired)
  if (parsed !== undefined) return parsed
  repaired = repaired
    .replace(/\/\/[^\n]*/g, '')
    .replace(/'([^'\\]*)'/g, '"$1"')
    .replace(/,\s*([}\]])/g, '$1')
  parsed = attempt(repaired)
  return parsed === undefined ? null : parsed
}

/** Last-resort search query plan when the model is unavailable. */
export function heuristicSubQuestions(question) {
  const parts = String(question)
    .split(/[?？;；\n]+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 4)
  return (parts.length > 0 ? parts : [String(question).trim()]).slice(0, 4)
}

export function uniqueStrings(values) {
  return [...new Set(values.map((value) => String(value).trim()).filter(Boolean))]
}

/**
 * URLs the user pasted into the question or focus. These are fetched directly:
 * a user-supplied URL is a stronger signal than anything a search engine ranks,
 * and pricing/login pages are exactly the ones search never surfaces.
 */
export function extractUrls(text) {
  const found = String(text ?? '').match(/https?:\/\/[^\s<>"'）)】\]，。；]+/gi) ?? []
  return uniqueStrings(found.map((url) => url.replace(/[.,;:!?]+$/u, '')))
}

/**
 * Make a value safe for JSON round-tripping. Tool results cross the harness
 * boundary, which rejects payloads that JSON.stringify would silently alter:
 * `undefined` properties, NaN/Infinity, Date, Map/Set, circular references.
 * Objects lose undefined-valued keys; arrays keep length with null holes.
 */
export function jsonSafe(value, seen = new WeakSet()) {
  if (value === null) return null
  const type = typeof value
  if (type === 'undefined') return undefined
  if (type === 'string' || type === 'boolean') return value
  if (type === 'number') return Number.isFinite(value) ? value : null
  if (type === 'bigint') return value.toString()
  if (type === 'function' || type === 'symbol') return undefined
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null
  if (seen.has(value)) return '[circular]'
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      return value.map((item) => {
        const safe = jsonSafe(item, seen)
        return safe === undefined ? null : safe
      })
    }
    if (value instanceof Map) {
      return jsonSafe(Object.fromEntries(value), seen)
    }
    if (value instanceof Set) {
      return jsonSafe([...value], seen)
    }
    const output = {}
    for (const [key, item] of Object.entries(value)) {
      const safe = jsonSafe(item, seen)
      if (safe !== undefined) output[key] = safe
    }
    return output
  } finally {
    seen.delete(value)
  }
}