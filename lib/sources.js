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
 * - robots.txt is not parsed: we only probe the conventional sitemap paths and
 *   rely on the host's own crawl-delay being respected by a 400ms gap.
 * - gzipped sitemaps (`sitemap.xml.gz`) are not decompressed.
 * - a sitemapindex costs one of the allowed requests to pick a child map, so an
 *   index discovered only at the last candidate path cannot be expanded.
 */
import { decodeEntities, sleep, tokenSet } from './util.js'

const DEFAULT_LIMIT = 3
const MIN_GAP_MS = 400
const DEFAULT_TIMEOUT_MS = 12000
/**
 * 0.6.4 — ordered candidates. Spring publishes `/sitemap-index.xml` (hyphen),
 * which is why 0.6.3's per-root retry alone could never reach spring.io.
 */
export const SITEMAP_PATHS = Object.freeze(['/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml'])
/** One extra request is allowed when a candidate turns out to be a sitemapindex. */
const INDEX_EXPANSION_REQUESTS = 1

/** `<loc>` values, in document order; duplicates and non-http(s) entries drop. */
export function parseSitemap(xml, baseUrl) {
  const urls = []
  const seen = new Set()
  const text = String(xml ?? '')
  for (const match of text.matchAll(/<loc\b[^>]*>([\s\S]*?)<\/loc>/gi)) {
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
    urls.push(absolute)
  }
  return urls
}

/**
 * Score URLs by how many keyword tokens their path contains (whole-segment
 * hits count twice). Shallow paths win ties: they are usually the landing page
 * rather than an incidental mention. Returns at most `limit` absolute URLs.
 */
export function pickSitemapUrls(urls, keywords = [], limit = DEFAULT_LIMIT) {
  const max = Math.max(1, Math.floor(Number(limit) || DEFAULT_LIMIT))
  const keywordText = Array.isArray(keywords) ? keywords.join(' ') : String(keywords ?? '')
  const tokens = [...tokenSet(keywordText)].filter((token) => token.length >= 2)
  const seen = new Set()
  const scored = []
  for (const raw of Array.isArray(urls) ? urls : []) {
    const url = String(raw ?? '').trim()
    if (!url || seen.has(url)) continue
    seen.add(url)
    let path = ''
    try {
      path = decodeURIComponent(new URL(url).pathname).toLowerCase()
    } catch {
      continue
    }
    const segments = path.split('/').filter(Boolean)
    let score = 0
    for (const token of tokens) {
      if (path.includes(token)) score += 1
      if (segments.includes(token)) score += 2
    }
    if (score === 0) continue
    scored.push({ url, score, depth: segments.length })
  }
  scored.sort((a, b) => b.score - a.score
    || a.depth - b.depth
    || a.url.length - b.url.length
    || (a.url < b.url ? -1 : 1))
  return scored.slice(0, max).map((entry) => entry.url)
}

/**
 * Fetch a site's sitemap and return up to `limit` keyword-matched absolute URLs.
 *
 * Probes the ordered `paths` candidates (`/sitemap.xml`, `/sitemap_index.xml`,
 * `/sitemap-index.xml` by default) at least 400ms apart, and allows one extra
 * request when the winning candidate is a sitemapindex (so three path probes
 * plus an index expansion is the worst case). A candidate only counts as found
 * when `parseSitemap` returns at least one `<loc>`; an HTML soft-404 served as
 * XML therefore falls through to the next path instead of ending the crawl.
 * Returns `{ ok: true, sitemapUrl, urls }` or `{ ok: false, reason }`; never
 * throws (an aborted signal is reported, not re-raised) so the caller can keep
 * the research going.
 */
export async function crawlSitemap({
  baseUrl,
  keywords = [],
  limit = DEFAULT_LIMIT,
  paths = SITEMAP_PATHS,
  fetchRaw,
  signal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (typeof fetchRaw !== 'function') return { ok: false, reason: 'no fetchRaw' }
  if (!baseUrl) return { ok: false, reason: 'no baseUrl' }
  let origin
  try {
    origin = new URL(baseUrl)
  } catch {
    return { ok: false, reason: 'invalid baseUrl' }
  }
  const candidates = (Array.isArray(paths) ? paths : SITEMAP_PATHS)
    .map((path) => String(path ?? '').trim())
    .filter(Boolean)
    .map((path) => (path.startsWith('/') ? path : `/${path}`))
  const pathList = candidates.length > 0 ? candidates : [...SITEMAP_PATHS]
  // 0.6.4: probe every candidate, plus one request to expand a sitemapindex.
  const maxRequests = pathList.length + INDEX_EXPANSION_REQUESTS
  const budgetMs = Math.max(1000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS)
  const deadline = Date.now() + budgetMs
  let requests = 0
  let lastRequestAt = 0

  // One request, paced and bounded. Throws on HTTP errors so the caller can try
  // the next conventional path.
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

  try {
    const reasons = []
    let xml = ''
    let sitemapUrl = ''
    let urls = []
    for (const path of pathList) {
      const candidateUrl = new URL(path, origin).toString()
      try {
        xml = await request(candidateUrl)
      } catch (error) {
        reasons.push(`${path}: ${error.message}`)
        continue
      }
      // A soft-404 (HTML body served with an XML content type) has no <loc>;
      // parse it, and only treat the candidate as found when it really yields
      // URLs. `<loc` alone is not enough evidence.
      urls = parseSitemap(xml, candidateUrl)
      if (urls.length > 0) {
        sitemapUrl = candidateUrl
        break
      }
      reasons.push(`${path}: no <loc> entries`)
      xml = ''
    }
    if (!xml) return { ok: false, reason: reasons.join('; ') || 'no sitemap found' }

    if (/<sitemapindex\b/i.test(xml)) {
      // An index lists child maps; follow the one that best matches the topic.
      const child = pickSitemapUrls(urls, keywords, 1)[0] ?? urls[0]
      if (!child) return { ok: false, reason: 'empty sitemapindex' }
      if (requests >= maxRequests) {
        return { ok: false, reason: 'sitemapindex found but request budget spent' }
      }
      try {
        xml = await request(child)
      } catch (error) {
        return { ok: false, reason: `child sitemap ${error.message}` }
      }
      urls = parseSitemap(xml, child)
      sitemapUrl = child
    }

    // Child maps may themselves be indexes; only pages are worth fetching.
    const pages = urls.filter((url) => {
      try {
        return !/\.(xml|xml\.gz)$/i.test(new URL(url).pathname)
      } catch {
        return false
      }
    })
    return { ok: true, sitemapUrl, urls: pickSitemapUrls(pages, keywords, limit) }
  } catch (error) {
    return { ok: false, reason: signal?.aborted ? 'aborted' : (error?.message ?? 'sitemap crawl failed') }
  }
}