import test from 'node:test'
import assert from 'node:assert/strict'
import { crawlSitemap, parseSitemap, parseSitemapEntries, pickSitemapUrls } from '../lib/sources.js'

const URLSET = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://docs.spring.io/spring-boot/3.4/reference/configuration.html</loc></url>
  <url><loc>https://docs.spring.io/spring-boot/3.4/reference/application-properties.html</loc></url>
  <url><loc>https://docs.spring.io/spring-boot/3.4/reference/actuator/index.html</loc></url>
  <url><loc>https://docs.spring.io/spring-boot/3.4/reference/configuration.html</loc></url>
  <url><loc>https://docs.spring.io/spring-boot/3.4/reference/security/index.html?utm_source=sitemap&amp;x=1</loc></url>
</urlset>`

const INDEX = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://docs.spring.io/spring-boot/sitemap.xml</loc></sitemap>
  <sitemap><loc>https://docs.spring.io/spring-framework/sitemap.xml</loc></sitemap>
</sitemapindex>`

test('parseSitemap returns every absolute <loc> once, decoding entities', () => {
  const urls = parseSitemap(URLSET, 'https://docs.spring.io')
  assert.equal(urls.length, 4)
  assert.equal(urls[0], 'https://docs.spring.io/spring-boot/3.4/reference/configuration.html')
  assert.match(urls[3], /utm_source=sitemap&x=1$/)
})

test('parseSitemap expands a sitemapindex into its child maps and resolves relative locs', () => {
  const urls = parseSitemap(INDEX, 'https://docs.spring.io')
  assert.deepEqual(urls, [
    'https://docs.spring.io/spring-boot/sitemap.xml',
    'https://docs.spring.io/spring-framework/sitemap.xml',
  ])
  const relative = parseSitemap('<urlset><url><loc>/docs/guide.html</loc></url></urlset>', 'https://nodejs.org/en')
  assert.deepEqual(relative, ['https://nodejs.org/docs/guide.html'])
})

test('pickSitemapUrls ranks path matches, dedupes, and caps at the limit', () => {
  const urls = parseSitemap(URLSET, 'https://docs.spring.io')
  const picked = pickSitemapUrls(urls, ['spring', 'boot', 'configuration'], 2)
  assert.equal(picked.length, 2)
  assert.match(picked[0], /configuration\.html$/)
  assert.notEqual(picked[0], picked[1])
  // Default limit is 3; unrelated URLs score 0 and are dropped.
  assert.equal(pickSitemapUrls(urls, ['spring', 'boot'], 3).length, 3)
  assert.deepEqual(pickSitemapUrls(urls, ['kubernetes'], 3), [])
  assert.deepEqual(pickSitemapUrls(urls, [], 3), [])
})

test('parseSitemapEntries keeps <lastmod> while parseSitemap stays a URL array (0.6.5)', () => {
  const XML = `<urlset>
  <url><loc>https://nodejs.org/en/learn/node/</loc><lastmod>2025-01-02</lastmod></url>
  <url><loc>https://nodejs.org/en/blog/node-22</loc><lastmod>2018-05-06T10:00:00Z</lastmod></url>
  <url><loc>https://nodejs.org/en/about/lts-schedule</loc></url>
</urlset>`
  const entries = parseSitemapEntries(XML, 'https://nodejs.org')
  assert.deepEqual(entries, [
    { loc: 'https://nodejs.org/en/learn/node/', lastmod: '2025-01-02' },
    { loc: 'https://nodejs.org/en/blog/node-22', lastmod: '2018-05-06T10:00:00Z' },
    { loc: 'https://nodejs.org/en/about/lts-schedule' },
  ])
  // The historical API is unchanged: a string array, same order, no duplicates.
  assert.deepEqual(parseSitemap(XML, 'https://nodejs.org'), entries.map((entry) => entry.loc))
})

test('pickSitemapUrls prefers documentation paths over blog posts (0.6.5)', () => {
  const urls = [
    'https://example.dev/blog/spring-boot-release-notes',
    'https://example.dev/reference/spring-boot',
  ]
  // Both match all four keywords, so only the path prior decides the order.
  const picked = pickSitemapUrls(urls, ['spring', 'boot', 'release', 'notes'], 2)
  assert.deepEqual(picked, [
    'https://example.dev/reference/spring-boot',
    'https://example.dev/blog/spring-boot-release-notes',
  ])
  // A weak blog match is dropped entirely instead of spending a page slot.
  assert.deepEqual(pickSitemapUrls(urls, ['spring', 'boot'], 2), [
    'https://example.dev/reference/spring-boot',
  ])
})

test('pickSitemapUrls demotes entries whose <lastmod> is older than three years (0.6.5)', () => {
  const entries = [
    { loc: 'https://example.dev/docs/spring-boot-old', lastmod: '2015-03-01' },
    { loc: 'https://example.dev/docs/spring-boot-new', lastmod: '2025-06-01' },
  ]
  const picked = pickSitemapUrls(entries, ['spring', 'boot'], 2)
  assert.deepEqual(picked, [
    'https://example.dev/docs/spring-boot-new',
    'https://example.dev/docs/spring-boot-old',
  ])
})

test('crawlSitemap fetches /sitemap.xml, scores it, and returns absolute page URLs', async () => {
  const seen = []
  const fetchRaw = async (url) => {
    seen.push(url)
    return { status: 200, body: URLSET }
  }
  const result = await crawlSitemap({
    baseUrl: 'https://docs.spring.io',
    keywords: ['spring', 'boot', 'configuration'],
    limit: 3,
    fetchRaw,
  })
  assert.equal(result.ok, true)
  assert.equal(seen.length, 1)
  assert.equal(seen[0], 'https://docs.spring.io/sitemap.xml')
  assert.equal(result.urls.length, 3)
  assert.ok(result.urls.every((url) => url.startsWith('https://docs.spring.io/spring-boot/')))
})

test('crawlSitemap follows one child map from a sitemapindex with a >=400ms gap', async () => {
  const seen = []
  const started = Date.now()
  const fetchRaw = async (url) => {
    seen.push(url)
    if (url.endsWith('/sitemap.xml') && url === 'https://docs.spring.io/sitemap.xml') {
      return { status: 200, body: INDEX }
    }
    return { status: 200, body: URLSET }
  }
  const result = await crawlSitemap({
    baseUrl: 'https://docs.spring.io',
    keywords: ['spring', 'boot'],
    limit: 2,
    fetchRaw,
  })
  assert.equal(result.ok, true)
  assert.deepEqual(seen, ['https://docs.spring.io/sitemap.xml', 'https://docs.spring.io/spring-boot/sitemap.xml'])
  assert.equal(result.urls.length, 2)
  assert.ok(Date.now() - started >= 350, 'at least one 400ms pacing gap between requests')
})

test('crawlSitemap returns a reason instead of throwing when no sitemap exists', async () => {
  const seen = []
  const fetchRaw = async (url) => {
    seen.push(url)
    return { status: 404, body: 'not found' }
  }
  const result = await crawlSitemap({ baseUrl: 'https://docs.spring.io', keywords: ['spring'], fetchRaw })
  assert.equal(result.ok, false)
  assert.match(result.reason, /sitemap\.xml: HTTP 404/)
  assert.match(result.reason, /sitemap_index\.xml: HTTP 404/)
  // 0.6.4: three ordered candidates (including the hyphen form Spring uses),
  // never more than three requests.
  assert.deepEqual(seen, [
    'https://docs.spring.io/sitemap.xml',
    'https://docs.spring.io/sitemap_index.xml',
    'https://docs.spring.io/sitemap-index.xml',
  ])
})

test('an HTML soft-404 is not a hit: the crawl falls through to the next candidate', async () => {
  const seen = []
  const fetchRaw = async (url) => {
    seen.push(url)
    // A host that answers 200 text/xml with its HTML 404 page for any unknown path.
    if (url.endsWith('/sitemap.xml')) {
      return { status: 200, body: '<!doctype html><html><body><h1>Not found</h1></body></html>' }
    }
    return { status: 200, body: URLSET }
  }
  const result = await crawlSitemap({
    baseUrl: 'https://docs.spring.io',
    keywords: ['spring', 'boot', 'configuration'],
    limit: 2,
    fetchRaw,
  })
  assert.equal(result.ok, true)
  assert.equal(seen.length, 2)
  assert.deepEqual(seen, [
    'https://docs.spring.io/sitemap.xml',
    'https://docs.spring.io/sitemap_index.xml',
  ])
  assert.equal(result.sitemapUrl, 'https://docs.spring.io/sitemap_index.xml')
  assert.equal(result.urls.length, 2)
})

test('crawlSitemap probes the hyphenated sitemap-index.xml last (0.6.4)', async () => {
  const seen = []
  const fetchRaw = async (url) => {
    seen.push(url)
    if (url === 'https://spring.io/sitemap-index.xml') return { status: 200, body: URLSET }
    return { status: 404, body: '' }
  }
  const result = await crawlSitemap({
    baseUrl: 'https://spring.io',
    keywords: ['spring', 'boot', 'configuration'],
    limit: 3,
    fetchRaw,
  })
  assert.equal(result.ok, true)
  assert.deepEqual(seen, [
    'https://spring.io/sitemap.xml',
    'https://spring.io/sitemap_index.xml',
    'https://spring.io/sitemap-index.xml',
  ])
  assert.equal(result.sitemapUrl, 'https://spring.io/sitemap-index.xml')
  assert.equal(result.urls.length, 3)
})

test('callers can override the ordered path candidates', async () => {
  const seen = []
  const fetchRaw = async (url) => {
    seen.push(url)
    return { status: 404, body: '' }
  }
  const result = await crawlSitemap({
    baseUrl: 'https://example.com',
    keywords: ['x'],
    paths: ['robots-then-sitemap.xml'],
    fetchRaw,
  })
  assert.equal(result.ok, false)
  assert.deepEqual(seen, ['https://example.com/robots-then-sitemap.xml'])
})

test('crawlSitemap never throws without a fetchRaw or a valid base URL', async () => {
  assert.deepEqual(await crawlSitemap({ baseUrl: 'https://docs.spring.io' }), { ok: false, reason: 'no fetchRaw' })
  assert.deepEqual(await crawlSitemap({ fetchRaw: async () => ({ status: 200, body: '' }) }), { ok: false, reason: 'no baseUrl' })
  const invalid = await crawlSitemap({ baseUrl: 'not a url', fetchRaw: async () => ({ status: 200, body: URLSET }) })
  assert.equal(invalid.ok, false)
  assert.equal(invalid.reason, 'invalid baseUrl')
})

test('an index found at the last candidate gets one extra request to expand', async () => {
  // spring.io/sitemap-index.xml is itself a sitemapindex, so the three path
  // probes are spent when it answers; the crawl must still be able to read the
  // child map it points at.
  const SPRING_INDEX = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://spring.io/sitemap-0.xml</loc></sitemap>
</sitemapindex>`
  const seen = []
  const fetchRaw = async (url) => {
    seen.push(url)
    if (url === 'https://spring.io/sitemap-index.xml') return { status: 200, body: SPRING_INDEX }
    if (url === 'https://spring.io/sitemap-0.xml') return { status: 200, body: URLSET }
    return { status: 404, body: '' }
  }
  const result = await crawlSitemap({
    baseUrl: 'https://spring.io',
    keywords: ['spring', 'boot', 'configuration'],
    limit: 2,
    fetchRaw,
  })
  assert.equal(result.ok, true)
  assert.deepEqual(seen, [
    'https://spring.io/sitemap.xml',
    'https://spring.io/sitemap_index.xml',
    'https://spring.io/sitemap-index.xml',
    'https://spring.io/sitemap-0.xml',
  ])
  assert.equal(result.urls.length, 2)
})