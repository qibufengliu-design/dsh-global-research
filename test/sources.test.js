import test from 'node:test'
import assert from 'node:assert/strict'
import { crawlSitemap, parseSitemap, pickSitemapUrls } from '../lib/sources.js'

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
  // Two conventional paths, never more than two requests.
  assert.equal(seen.length, 2)
})

test('crawlSitemap never throws without a fetchRaw or a valid base URL', async () => {
  assert.deepEqual(await crawlSitemap({ baseUrl: 'https://docs.spring.io' }), { ok: false, reason: 'no fetchRaw' })
  assert.deepEqual(await crawlSitemap({ fetchRaw: async () => ({ status: 200, body: '' }) }), { ok: false, reason: 'no baseUrl' })
  const invalid = await crawlSitemap({ baseUrl: 'not a url', fetchRaw: async () => ({ status: 200, body: URLSET }) })
  assert.equal(invalid.ok, false)
  assert.equal(invalid.reason, 'invalid baseUrl')
})

test('crawlSitemap reports a spent request budget when only the fallback index is found', async () => {
  const seen = []
  const fetchRaw = async (url) => {
    seen.push(url)
    if (url.endsWith('/sitemap.xml')) return { status: 404, body: '' }
    return { status: 200, body: INDEX }
  }
  const result = await crawlSitemap({ baseUrl: 'https://docs.spring.io', keywords: ['spring'], fetchRaw })
  assert.equal(result.ok, false)
  assert.match(result.reason, /request budget spent/)
  assert.equal(seen.length, 2)
})