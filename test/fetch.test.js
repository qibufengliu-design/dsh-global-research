import test from 'node:test'
import assert from 'node:assert/strict'
import { createPageFetcher, rawGithubUrl, cellarCelex } from '../lib/fetch.js'

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