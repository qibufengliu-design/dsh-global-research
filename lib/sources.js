/**
 * Targeted sitemap crawling (0.6.0).
 *
 * `sourcePlan` channels of method `sitemap` need concrete URLs without a search
 * engine. We read the site's sitemap, score the URLs against the question, and
 * hand back the best few. Everything here is best-effort: a missing or broken
 * sitemap returns `{ ok: false, reason }` and never throws, because a sitemap is
 * an optimisation, not a requirement.
 *
 * Known limitations (deliberate, see the 0.6.0 design doc):
 * - robots.txt is not parsed: we only probe the conventional sitemap paths (at
 *   the site root and, since 0.6.7, under the base directory) and rely on the
 *   host's own crawl-delay being respected by a 400ms gap.
 * - gzipped sitemaps (`sitemap.xml.gz`) are not decompressed.
 * - a sitemapindex costs an extra request to expand its child map, so the crawl
 *   allows `candidates + 2` requests in total.
 */
import { decodeEntities, sleep, tokenSet } from './util.js'

const DEFAULT_LIMIT = 3
const MIN_GAP_MS = 400
const DEFAULT_TIMEOUT_MS = 12000
/**
 * 0.6.4 — ordered candidates relative to the site root. Spring publishes
 * `/sitemap-index.xml` (hyphen), which is why 0.6.3's per-root retry alone could
 * never reach spring.io.
 */
export const ROOT_SITEMAP_PATHS = Object.freeze(['/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml'])
/**
 * 0.6.7 — the same names relative to the base directory. Documentation sites
 * keep the sitemap under the manual's own directory
 * (`https://docs.spring.io/spring-ai/reference/sitemap.xml`), which a root-only
 * probe can never find.
 */
export const BASE_SITEMAP_PATHS = Object.freeze(['sitemap.xml', 'sitemap_index.xml', 'sitemap-index.xml'])
/** Historical alias: the root-relative candidate list (0.6.4). */
export const SITEMAP_PATHS = ROOT_SITEMAP_PATHS
/** Room for up to two index expansions (one per candidate family). */
const INDEX_EXPANSION_REQUESTS = 2
/**
 * 0.6.8 — how many cross-host `<loc>` entries may be re-pointed at the base
 * host. A site that moved domains usually keeps serving its old sitemap:
 * `docs.langchain4j.dev/sitemap.xml` still lists `langchain4j.github.io/...`
 * (404 today) while the same path answers on the base host. 0 disables the
 * probe entirely.
 */
export const DOC_HOST_REWRITE_MAX = 3
/** Documentation-class TLDs: the rewrite only runs between these families. */
const DOC_CLASS_SUFFIX = /\.(dev|io)$/i
/** A documentation host: `docs.example.dev`, `www.docs.example.io`, … */
const isDocHostname = (host) => /(^|\.)docs\./i.test(String(host ?? ''))
const isDocClassHost = (host) => DOC_CLASS_SUFFIX.test(String(host ?? ''))

/** `<loc>` values, in document order; duplicates and non-http(s) entries drop. */
export function parseSitemap(xml, baseUrl) {
  return parseSitemapEntries(xml, baseUrl).map((entry) => entry.loc)
}

/**
 * Like `parseSitemap`, but keeps each entry's `<lastmod>` (0.6.5).
 *
 * `parseSitemap` stays a string array for callers that only need URLs; the
 * crawler uses this richer form so an undated-old child map can be demoted
 * instead of filling the page budget with years-old pages.
 */
export function parseSitemapEntries(xml, baseUrl) {
  const entries = []
  const seen = new Set()
  const text = String(xml ?? '')
  const matches = [...text.matchAll(/<loc\b[^>]*>([\s\S]*?)<\/loc>/gi)]
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]
    // `<lastmod>` follows `<loc>` inside the same <url>/<sitemap> block, so the
    // window up to the next <loc> is the right place to look.
    const windowEnd = index + 1 < matches.length ? matches[index + 1].index : text.length
    const after = text.slice(match.index + match[0].length, windowEnd)
    const lastmod = after.match(/<lastmod\b[^>]*>([\s\S]*?)<\/lastmod>/i)
    // CDATA is legal inside <loc>; unwrap before entity decoding.
    const cdata = match[1].match(/<!\[CDATA\[([\s\S]*?)\]\]>/)
    const raw = decodeEntities((cdata ? cdata[1] : match[1]).replace(/<[^>]+>/g, '')).trim()
    if (!raw) continue
    let absolute
    try {
      absolute = new URL(raw, baseUrl || undefined).toString()
    } catch {
      continue
    }
    if (!/^https?:\/\//i.test(absolute) || seen.has(absolute)) continue
    seen.add(absolute)
    const stamp = lastmod ? decodeEntities(lastmod[1].replace(/<[^>]+>/g, '')).trim() : ''
    entries.push(stamp ? { loc: absolute, lastmod: stamp } : { loc: absolute })
  }
  return entries
}

/** Path segments that mark a documentation page rather than an announcement. */
const DOC_PATH_SEGMENTS = new Set(['reference', 'docs', 'api', 'guide', 'guides', 'manual', 'learn'])
/** Path segments that mark news, not documentation (0.6.5). */
const BLOG_PATH_SEGMENTS = new Set(['blog', 'news', 'press', 'events', 'changelog', 'tag'])
const PATH_PRIOR = 3
const STALE_LASTMOD_DAYS = 1095

/**
 * Score URLs by how many keyword tokens their path contains (whole-segment
 * hits count twice). Shallow paths win ties: they are usually the landing page
 * rather than an incidental mention.
 *
 * 0.6.5 adds two priors on the same scale: documentation segments
 * (`/reference/`, `/docs/`, `/api/`, `/guide/`, `/manual/`, `/learn/`) gain +3
 * and news/blog segments (`/blog/`, `/news/`, `/press/`, `/events/`,
 * `/changelog/`, `/tag/`) lose 3, so a sitemap's blog posts no longer displace
 * its reference pages. Entries may be plain URL strings or
 * `{ loc, lastmod }` objects (see `parseSitemapEntries`); a `<lastmod>` older
 * than three years costs another 2. A URL must still match at least one keyword
 * — path shape alone is not evidence that the page is about the question — and
 * a final score of zero or less is dropped rather than fetched.
 */
export function pickSitemapUrls(urls, keywords = [], limit = DEFAULT_LIMIT, { now = Date.now() } = {}) {
  const max = Math.max(1, Math.floor(Number(limit) || DEFAULT_LIMIT))
  const keywordText = Array.isArray(keywords) ? keywords.join(' ') : String(keywords ?? '')
  const tokens = [...tokenSet(keywordText)].filter((token) => token.length >= 2)
  const seen = new Set()
  const scored = []
  for (const raw of Array.isArray(urls) ? urls : []) {
    const entry = typeof raw === 'string' ? { loc: raw } : (raw ?? {})
    const url = String(entry.loc ?? entry.url ?? '').trim()
    if (!url || seen.has(url)) continue
    seen.add(url)
    let path = ''
    try {
      path = decodeURIComponent(new URL(url).pathname).toLowerCase()
    } catch {
      continue
    }
    const segments = path.split('/').filter(Boolean)
    let keywordScore = 0
    for (const token of tokens) {
      if (path.includes(token)) keywordScore += 1
      if (segments.includes(token)) keywordScore += 2
    }
    if (keywordScore === 0) continue
    let score = keywordScore
    if (segments.some((segment) => DOC_PATH_SEGMENTS.has(segment))) score += PATH_PRIOR
    if (segments.some((segment) => BLOG_PATH_SEGMENTS.has(segment))) score -= PATH_PRIOR
    const ageDays = entry.lastmod ? (now - Date.parse(entry.lastmod)) / 86400000 : null
    if (Number.isFinite(ageDays) && ageDays > STALE_LASTMOD_DAYS) score -= 2
    if (score <= 0) continue
    scored.push({ url, score, depth: segments.length })
  }
  scored.sort((a, b) => b.score - a.score
    || a.depth - b.depth
    || a.url.length - b.url.length
    || (a.url < b.url ? -1 : 1))
  return scored.slice(0, max).map((entry) => entry.url)
}

/**
 * Child maps may themselves be indexes; only pages are worth fetching.
 */
function pageEntries(entries) {
  return entries.filter((entry) => {
    try {
      return !/\.(xml|xml\.gz)$/i.test(new URL(entry.loc).pathname)
    } catch {
      return false
    }
  })
}

/**
 * Fetch a site's sitemap and return up to `limit` keyword-matched absolute URLs.
 *
 * 0.6.7 probes two candidate families in order: the site root
 * (`/sitemap.xml`, `/sitemap_index.xml`, `/sitemap-index.xml`) and then the base
 * directory itself (`sitemap.xml`, …), because documentation sites such as
 * docs.spring.io publish their sitemap under the manual path rather than at the
 * origin root. Duplicate candidates collapse, so a bare-origin base still costs
 * three requests; `paths` replaces both families with root-relative paths.
 *
 * A candidate only counts as a sitemap when the body really looks like one
 * (`<urlset>` or `<sitemapindex>`) and yields at least one `<loc>`; a host that
 * answers 200 with its HTML 404 page therefore falls through to the next
 * candidate instead of ending the crawl. A sitemapindex costs one extra request
 * to expand, and a child `<loc>` is resolved against the index URL, so a
 * relative `sitemap-0.xml` under `/docs/` stays under `/docs/`. At most
 * `candidates + 2` requests are made, at least 400ms apart.
 *
 * 0.6.8 — before returning, up to `DOC_HOST_REWRITE_MAX` cross-host entries are
 * re-pointed at the base host when both hosts are documentation-class domains
 * and the base is a `docs.*` host; a quick 5s probe keeps the rewrite only when
 * the twin URL answers 2xx/3xx.
 *
 * Returns `{ ok: true, sitemapUrl, urls }` or `{ ok: false, reason }`; never
 * throws (an aborted signal is reported, not re-raised) so the caller can keep
 * the research going.
 */
export async function crawlSitemap({
  baseUrl,
  keywords = [],
  limit = DEFAULT_LIMIT,
  paths,
  rootPaths = ROOT_SITEMAP_PATHS,
  basePaths = BASE_SITEMAP_PATHS,
  docHostRewrite = DOC_HOST_REWRITE_MAX,
  fetchRaw,
  signal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (typeof fetchRaw !== 'function') return { ok: false, reason: 'no fetchRaw' }
  if (!baseUrl) return { ok: false, reason: 'no baseUrl' }
  let origin
  let baseDir
  try {
    origin = new URL(baseUrl)
    // A base without a trailing slash names a directory, not a file, so append
    // one: `new URL('sitemap.xml', baseDir)` then stays inside that directory.
    baseDir = new URL(String(baseUrl).endsWith('/') ? String(baseUrl) : `${String(baseUrl)}/`)
  } catch {
    return { ok: false, reason: 'invalid baseUrl' }
  }
  const normalizePaths = (list) => (Array.isArray(list) ? list : [])
    .map((path) => String(path ?? '').trim())
    .filter(Boolean)
  const candidates = []
  const seenCandidates = new Set()
  const addCandidate = (label, absolute) => {
    if (seenCandidates.has(absolute)) return
    seenCandidates.add(absolute)
    candidates.push({ label, url: absolute })
  }
  const overrides = normalizePaths(paths)
  if (overrides.length > 0) {
    // Legacy escape hatch: explicit candidates stay root-relative (0.6.4).
    for (const path of overrides) {
      const rooted = path.startsWith('/') ? path : `/${path}`
      addCandidate(rooted, new URL(rooted, origin).toString())
    }
  } else {
    for (const path of normalizePaths(rootPaths)) {
      const rooted = path.startsWith('/') ? path : `/${path}`
      addCandidate(rooted, new URL(rooted, origin).toString())
    }
    for (const path of normalizePaths(basePaths)) {
      const relative = path.replace(/^\/+/, '')
      addCandidate(relative, new URL(relative, baseDir).toString())
    }
  }
  const pathList = candidates.length > 0
    ? candidates
    : [{ label: '/sitemap.xml', url: new URL('/sitemap.xml', origin).toString() }]
  // Every candidate path, plus room for two sitemapindex expansions.
  const maxRequests = pathList.length + INDEX_EXPANSION_REQUESTS
  const budgetMs = Math.max(1000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS)
  const deadline = Date.now() + budgetMs
  let requests = 0
  let lastRequestAt = 0

  // One request, paced and bounded. Throws on HTTP errors so the caller can try
  // the next candidate.
  const request = async (url) => {
    if (signal?.aborted) throw new Error('aborted')
    if (requests >= maxRequests) throw new Error('request budget exhausted')
    const wait = lastRequestAt + MIN_GAP_MS - Date.now()
    if (wait > 0) await sleep(wait)
    if (signal?.aborted) throw new Error('aborted')
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error('sitemap timeout')
    requests += 1
    lastRequestAt = Date.now()
    const result = await fetchRaw(url, {
      signal,
      timeoutMs: Math.min(budgetMs, remaining),
    })
    const status = Number(result?.status ?? 200)
    if (status >= 400) throw new Error(`HTTP ${status}`)
    return typeof result === 'string' ? result : String(result?.body ?? '')
  }

  // 0.6.8 — a migrated documentation site often keeps its old sitemap: entries
  // point at the previous host while the pages now live under the base host
  // (`langchain4j.github.io/tutorials/chat-memory` 404 →
  // `docs.langchain4j.dev/tutorials/chat-memory/` 200). Re-point the first
  // candidates at the base host, but only when the base really is a docs host
  // and both hosts are documentation-class TLDs, so CDN/multi-domain sites are
  // left alone. A failed probe keeps the original `<loc>`.
  const rewriteDocHosts = async (urls) => {
    const requested = Number(docHostRewrite)
    const limit = Math.max(0, Math.min(DOC_HOST_REWRITE_MAX, Number.isFinite(requested) ? Math.floor(requested) : DOC_HOST_REWRITE_MAX))
    if (limit === 0 || !Array.isArray(urls) || urls.length === 0) return urls
    const baseHostname = baseDir.hostname
    if (!isDocHostname(baseHostname) || !isDocClassHost(baseHostname)) return urls
    const rewritten = [...urls]
    for (let index = 0; index < Math.min(limit, rewritten.length); index += 1) {
      let loc
      try {
        loc = new URL(rewritten[index])
      } catch {
        continue
      }
      if (loc.host === baseDir.host) continue
      if (!isDocClassHost(loc.hostname)) continue
      const candidate = `${baseDir.origin}${loc.pathname}${loc.search}`
      if (candidate === rewritten[index]) continue
      try {
        if (signal?.aborted) break
        const remaining = Math.max(1000, Math.min(5000, deadline - Date.now()))
        const response = await fetchRaw(candidate, { signal, timeoutMs: remaining })
        const status = Number(response?.status ?? 200)
        if (status >= 200 && status < 400) rewritten[index] = candidate
      } catch {
        // Keep the original <loc>: the twin is not reachable.
      }
    }
    return rewritten
  }

  try {
    const reasons = []
    for (const candidate of pathList) {
      let xml
      try {
        xml = await request(candidate.url)
      } catch (error) {
        reasons.push(`${candidate.label}: ${error.message}`)
        continue
      }
      // 0.6.7: a 200 is not proof. Many hosts answer unknown paths with their
      // HTML 404 page (sometimes even as text/xml), so require the body to look
      // like a sitemap and to actually contain a <loc>.
      if (!/<urlset\b|<sitemapindex\b/i.test(xml)) {
        reasons.push(`${candidate.label}: not a sitemap`)
        continue
      }
      let entries = parseSitemapEntries(xml, candidate.url)
      if (entries.length === 0) {
        reasons.push(`${candidate.label}: no <loc> entries`)
        continue
      }
      if (/<sitemapindex\b/i.test(xml)) {
        // An index lists child maps; follow the one that best matches the topic.
        // `entries` are already absolute against the index URL, which keeps a
        // relative child map in the index's own directory.
        const child = pickSitemapUrls(entries, keywords, 1)[0] ?? entries[0]?.loc
        if (!child) {
          reasons.push(`${candidate.label}: empty sitemapindex`)
          continue
        }
        let childXml
        try {
          childXml = await request(child)
        } catch (error) {
          reasons.push(`${candidate.label}: child sitemap ${error.message}`)
          continue
        }
        if (!/<urlset\b/i.test(childXml)) {
          reasons.push(`${candidate.label}: child is not a urlset`)
          continue
        }
        entries = parseSitemapEntries(childXml, child)
        if (entries.length === 0) {
          reasons.push(`${candidate.label}: child has no <loc> entries`)
          continue
        }
        return { ok: true, sitemapUrl: child, urls: await rewriteDocHosts(pickSitemapUrls(pageEntries(entries), keywords, limit)) }
      }
      return { ok: true, sitemapUrl: candidate.url, urls: await rewriteDocHosts(pickSitemapUrls(pageEntries(entries), keywords, limit)) }
    }
    return { ok: false, reason: reasons.join('; ') || 'no sitemap found' }
  } catch (error) {
    return { ok: false, reason: signal?.aborted ? 'aborted' : (error?.message ?? 'sitemap crawl failed') }
  }
}