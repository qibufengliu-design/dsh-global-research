import test from 'node:test'
import assert from 'node:assert/strict'
import { createPageFetcher, createRenderFetcher, isRenderHost, rawGithubUrl, cellarCelex } from '../lib/fetch.js'

const PAGE = `<html><head><title>Node LTS schedule</title>
<meta property="article:published_time" content="2026-01-09T10:00:00Z"></head>
<body><article><p>${'Node 22 is supported until April 2027. '.repeat(20)}</p></article></body></html>`

function rawOk() {
  return async () => ({ status: 200, body: PAGE })
}

test('cellarCelex maps ELI and CELEX URLs to Cellar identifiers', () => {
  assert.equal(cellarCelex('https://eur-lex.europa.eu/eli/reg/2024/2847/oj'), '32024R2847')
  assert.equal(cellarCelex('https://eur-lex.europa.eu/eli/dir/2019/1937/oj'), '32019L1937')
  assert.equal(cellarCelex('https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32024R2847'), '32024R2847')
  assert.equal(cellarCelex('https://nodejs.org/en/about/previous-releases'), null)
})

test('EUR-Lex acts are read from the Cellar XHTML instead of the JS shell', async () => {
  const seen = []
  const fetchRaw = async (url, options = {}) => {
    seen.push({ url, accept: options.headers?.accept })
    if (url.includes('publications.europa.eu')) {
      return {
        status: 200,
        body: `<html><head><title>L_202402847EN.000101.fmx.xml</title></head><body><article><p>REGULATION (EU) 2024/2847 OF THE EUROPEAN PARLIAMENT AND OF THE COUNCIL on horizontal cybersecurity requirements</p><p>${'Article 13 requires manufacturers to perform a self-assessment. '.repeat(20)}</p></article></body></html>`,
      }
    }
    return { status: 200, body: '<html><body><p>Enable JavaScript</p></body></html>' }
  }
  const fetchPage = createPageFetcher({ config: { pageFetcher: 'raw' }, fetchRaw })
  const page = await fetchPage('https://eur-lex.europa.eu/eli/reg/2024/2847/oj')
  assert.equal(page.ok, true)
  assert.equal(page.viaCellar, true)
  assert.match(page.text, /self-assessment/)
  assert.match(page.title, /^REGULATION \(EU\) 2024\/2847/)
  assert.equal(seen[0].accept, 'application/xhtml+xml')
})

test('EUR-Lex falls back to the page when Cellar has no document', async () => {
  const fetchRaw = async (url) => (url.includes('publications.europa.eu')
    ? { status: 404, body: 'no datastream' }
    : { status: 200, body: '<html><body><p>Enable JavaScript</p></body></html>' })
  const fetchPage = createPageFetcher({ config: { pageFetcher: 'raw' }, fetchRaw })
  const page = await fetchPage('https://eur-lex.europa.eu/eli/reg/2024/2847/oj')
  assert.equal(page.ok, false)
})

test('falls back to raw HTTP when web.fetch is missing', async () => {
  const fetchPage = createPageFetcher({ config: {}, web: undefined, fetchRaw: rawOk() })
  const page = await fetchPage('https://nodejs.org/en/about/previous-releases')
  assert.equal(page.ok, true)
  assert.match(page.text, /Node 22 is supported until April 2027/)
  assert.equal(page.title, 'Node LTS schedule')
  assert.equal(page.publishedAt, '2026-01-09')
})

test('falls back to raw HTTP when web.fetch throws', async () => {
  const web = { fetch: async () => { throw new Error('provider offline') } }
  const fetchPage = createPageFetcher({ config: {}, web, fetchRaw: rawOk() })
  const page = await fetchPage('https://nodejs.org/en/about/previous-releases')
  assert.equal(page.ok, true)
  assert.ok(page.text.length > 80)
})

test('raw HTTP 403 is retried through web.fetch instead of failing the page', async () => {
  const web = {
    fetch: async ({ url }) => ({ url, statusCode: 200, body: { kind: 'html', content: PAGE } }),
  }
  const fetchPage = createPageFetcher({
    config: { pageFetcher: 'raw' },
    web,
    fetchRaw: async () => ({ status: 403, body: 'Forbidden' }),
  })
  const page = await fetchPage('https://stackoverflow.com/questions/1/example')
  assert.equal(page.ok, true)
  assert.equal(page.viaWeb, true)
  assert.match(page.text, /Node 22 is supported until April 2027/)
})

test('a page that fails every layer reports each reason', async () => {
  const web = { fetch: async () => ({ statusCode: 419, body: { kind: 'text', content: '' } }) }
  const fetchPage = createPageFetcher({
    config: { pageFetcher: 'raw' },
    web,
    fetchRaw: async () => ({ status: 403, body: 'Forbidden' }),
  })
  const page = await fetchPage('https://news.ycombinator.com/item?id=1')
  assert.equal(page.ok, false)
  assert.match(page.reason, /HTTP 403/)
  assert.match(page.reason, /web\.fetch HTTP 419/)
})

test('prefers web.fetch when it works', async () => {
  let rawCalls = 0
  const web = {
    fetch: async ({ url }) => ({ url, statusCode: 200, body: { kind: 'html', content: PAGE } }),
  }
  const fetchPage = createPageFetcher({
    config: { pageFetcher: 'auto' },
    web,
    fetchRaw: async () => { rawCalls += 1; return { status: 500, body: '' } },
  })
  const page = await fetchPage('https://nodejs.org/en/about/previous-releases')
  assert.equal(page.ok, true)
  assert.equal(rawCalls, 0)
})

test('retries over raw HTTP when web.fetch returns navigation-only junk', async () => {
  let rawCalls = 0
  const junk = '<html><body><p>Skip to content</p><a href="/x">Menu</a></body></html>'
  const web = { fetch: async ({ url }) => ({ url, statusCode: 200, body: { kind: 'html', content: junk } }) }
  const fetchPage = createPageFetcher({
    config: { pageFetcher: 'auto' },
    web,
    fetchRaw: async () => { rawCalls += 1; return { status: 200, body: PAGE } },
  })
  const page = await fetchPage('https://nodejs.org/en/about/previous-releases')
  assert.equal(page.ok, true)
  assert.equal(rawCalls, 1)
  assert.match(page.text, /Node 22 is supported until April 2027/)
  assert.doesNotMatch(page.text, /Skip to content/)
})

test('fails when both web.fetch and raw HTTP yield only navigation junk', async () => {
  const junk = '<html><body><p>Skip to content</p><a href="/x">Menu</a></body></html>'
  const web = { fetch: async ({ url }) => ({ url, statusCode: 200, body: { kind: 'html', content: junk } }) }
  const fetchPage = createPageFetcher({
    config: { pageFetcher: 'auto' },
    web,
    fetchRaw: async () => ({ status: 200, body: junk }),
  })
  const page = await fetchPage('https://nodejs.org/en/about/previous-releases')
  assert.equal(page.ok, false)
  assert.match(page.reason, /no extractable article text/)
  assert.equal(page.text, '')
})

test('extracts absolute links so official landing pages can lead to the legal text', async () => {
  const html = '<html><body><article><p>Policy overview with enough body text to pass the gate. ' + 'x'.repeat(500) + '</p><a href="/eli/reg/2024/2847/oj">Regulation</a><a href="https://eur-lex.europa.eu/eli/reg/2024/2847/oj">EUR-Lex</a></article></body></html>'
  const fetchRaw = async () => ({ status: 200, body: html, headers: {} })
  const fetchPage = createPageFetcher({ fetchRaw })
  const page = await fetchPage('https://digital-strategy.ec.europa.eu/en/policies/cyber-resilience-act')
  assert.equal(page.ok, true)
  assert.ok(page.links.includes('https://eur-lex.europa.eu/eli/reg/2024/2847/oj'))
  assert.ok(page.links.some((url) => url.includes('/eli/reg/2024/2847/oj')))
})

test('pdf payloads are reported as unreadable instead of being quoted', async () => {
  const fetchRaw = async () => ({ status: 200, body: '%PDF-1.7\n1 0 obj << /Type /Catalog >>\n\u0001\u0002', headers: {} })
  const fetchPage = createPageFetcher({ fetchRaw })
  const page = await fetchPage('https://example.com/doc.pdf')
  assert.equal(page.ok, false)
  assert.match(page.reason, /binary/)
})

test('reports failure instead of inventing content', async () => {
  const web = { fetch: async () => ({ url: 'x', statusCode: 403, body: { kind: 'html', content: 'forbidden' } }) }
  const fetchPage = createPageFetcher({
    config: {},
    web,
    fetchRaw: async () => ({ status: 403, body: 'forbidden' }),
  })
  const page = await fetchPage('https://example.com/locked')
  assert.equal(page.ok, false)
  assert.match(page.reason, /403/)
  assert.equal(page.text, '')
})
test('raw mode ignores the host provider and reads GitHub blobs as raw markdown', async () => {
  let webCalls = 0
  const web = { fetch: async ({ url }) => { webCalls += 1; return { url, statusCode: 200, body: { kind: 'html', content: PAGE } } } }
  const seen = []
  const fetchPage = createPageFetcher({
    config: {},
    web,
    fetchRaw: async (url) => { seen.push(url); return { status: 200, body: '# Release schedule\n\n' + '| 22.x | 2027-04-30 |\n'.repeat(30) } },
  })
  const page = await fetchPage('https://github.com/nodejs/Release/blob/main/README.md')
  assert.equal(webCalls, 0)
  assert.equal(seen[0], 'https://raw.githubusercontent.com/nodejs/Release/main/README.md')
  assert.equal(page.ok, true)
  assert.match(page.text, /2027-04-30/)
  assert.equal(page.url, 'https://github.com/nodejs/Release/blob/main/README.md')
})

test('rawGithubUrl rewrites blob links and leaves other URLs alone', () => {
  assert.equal(rawGithubUrl('https://github.com/nodejs/Release/blob/main/README.md?plain=1'), 'https://raw.githubusercontent.com/nodejs/Release/main/README.md')
  assert.equal(rawGithubUrl('https://nodejs.org/en/about'), 'https://nodejs.org/en/about')
})

// --- 1.1.0: pricing render fallback -----------------------------------------

const PRICING_URL = 'https://api-docs.deepseek.com/quick_start/pricing'

function renderBody(extra = '') {
  return [
    'Title: DeepSeek API Pricing',
    'URL Source: https://api-docs.deepseek.com/quick_start/pricing',
    'Published Time: 2026-10-01T00:00:00Z',
    '',
    'Markdown Content:',
    `${'deepseek-chat 输入 1 元 / 百万 tokens，输出 2 元 / 百万 tokens。'.repeat(20)}${extra}`,
  ].join('\n')
}

test('the render fetcher returns a rendered page tagged via:render', async () => {
  const seen = []
  const renderPage = createRenderFetcher({
    fetchRaw: async (url, options = {}) => {
      seen.push({ url, accept: options.headers?.accept })
      return { status: 200, body: renderBody() }
    },
  })
  const page = await renderPage(PRICING_URL, { reason: 'empty shell' })
  assert.equal(page.ok, true)
  assert.equal(page.via, 'render')
  assert.equal(page.url, PRICING_URL)
  assert.equal(page.title, 'DeepSeek API Pricing')
  assert.equal(page.publishedAt, '2026-10-01')
  assert.deepEqual(page.links, [])
  assert.match(page.text, /百万 tokens/)
  // The proxy is addressed through its URL prefix, and it is asked for plain text.
  assert.equal(seen[0].url, `https://r.jina.ai/${PRICING_URL}`)
  assert.equal(seen[0].accept, 'text/plain')
})

test('the render fetcher refuses hosts outside the whitelist', async () => {
  let calls = 0
  const renderPage = createRenderFetcher({ fetchRaw: async () => { calls += 1; return { status: 200, body: renderBody() } } })
  const page = await renderPage('https://nodejs.org/en/about/previous-releases', { reason: 'HTTP 403' })
  assert.equal(page.ok, false)
  assert.equal(page.via, 'raw')
  assert.equal(calls, 0)
  assert.match(page.renderReason, /whitelist/)
  // The original failure is still reported unchanged.
  assert.equal(page.reason, 'HTTP 403')
})

test('the render fetcher honors renderFallback:false and a custom whitelist', async () => {
  let calls = 0
  const fetchRaw = async () => { calls += 1; return { status: 200, body: renderBody() } }
  const disabled = createRenderFetcher({ fetchRaw, config: { renderFallback: false } })
  assert.equal((await disabled(PRICING_URL)).ok, false)
  assert.equal(calls, 0)

  const custom = createRenderFetcher({ fetchRaw, config: { renderHosts: ['example.com'] } })
  assert.equal((await custom(PRICING_URL)).ok, false)
  assert.equal(calls, 0)
  assert.equal((await custom('https://docs.example.com/pricing')).ok, true)
  assert.equal(calls, 1)
})

test('a failed or thin render keeps the original reason and adds renderReason', async () => {
  const fiveHundred = createRenderFetcher({ fetchRaw: async () => ({ status: 500, body: 'proxy exploded' }) })
  const page = await fiveHundred(PRICING_URL, { reason: 'raw body under 400 chars' })
  assert.equal(page.ok, false)
  assert.equal(page.reason, 'raw body under 400 chars')
  assert.match(page.renderReason, /HTTP 500/)

  const thin = createRenderFetcher({ fetchRaw: async () => ({ status: 200, body: 'Title: Just the shell' }) })
  const short = await thin(PRICING_URL)
  assert.equal(short.ok, false)
  assert.match(short.renderReason, /chars/)

  const throws = createRenderFetcher({ fetchRaw: async () => { throw new Error('ECONNRESET') } })
  const broken = await throws(PRICING_URL, { reason: 'HTTP 504' })
  assert.equal(broken.ok, false)
  assert.equal(broken.reason, 'HTTP 504')
  assert.match(broken.renderReason, /ECONNRESET/)
})

test('isRenderHost matches host suffixes, not arbitrary substrings', () => {
  assert.equal(isRenderHost(PRICING_URL), true)
  assert.equal(isRenderHost('https://www.volcengine.com/docs/82379/1099320'), true)
  assert.equal(isRenderHost('https://bigmodel.cn/pricing'), true)
  assert.equal(isRenderHost('https://nothelp.aliyun.com/pricing'), false)
  assert.equal(isRenderHost('https://aliyun.com.example.org/pricing'), false)
  assert.equal(isRenderHost('not a url'), false)
  assert.equal(isRenderHost(PRICING_URL, []), true) // empty list falls back to the default
})