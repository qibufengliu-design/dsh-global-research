import test from 'node:test'
import assert from 'node:assert/strict'
import { createEngines, EngineUnavailable, parseDuckDuckGo, searchAll } from '../lib/engines.js'

const SAMPLE = `
<div class="result">
  <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fen%2Fabout%2Freleases&amp;rut=abc">Node.js Releases</a>
  <a class="result__snippet" href="x">Node 22 is the active LTS line &amp; supported.</a>
</div>
<div class="result">
  <a class="result__a" href="https://github.com/nodejs/node/releases">nodejs/node releases</a>
  <a class="result__snippet" href="y">Official release notes.</a>
</div>
`

test('parseDuckDuckGo extracts and unwraps redirect links', () => {
  const results = parseDuckDuckGo(SAMPLE)
  assert.equal(results.length, 2)
  assert.equal(results[0].url, 'https://nodejs.org/en/about/releases')
  assert.equal(results[0].title, 'Node.js Releases')
  assert.match(results[0].snippet, /Node 22 is the active LTS line & supported/)
  assert.equal(results[1].url, 'https://github.com/nodejs/node/releases')
})

test('searchAll isolates engine failures', async () => {
  const engines = [
    { name: 'broken', available: () => true, search: async () => { throw new Error('429') } },
    { name: 'ok', available: () => true, search: async () => [{ url: 'https://a.com', title: 'a', engine: 'ok' }] },
  ]
  const errors = []
  const { hits, engineFailures } = await searchAll(engines, 'query', {
    onError: (engine, error) => errors.push(`${engine}:${error.message}`),
  })
  assert.equal(hits.length, 1)
  assert.equal(engineFailures, 1)
  assert.deepEqual(errors, ['broken:429'])
})

function fakeFetch(payload, calls) {
  return async (url, options = {}) => {
    calls.push({ url, ...options })
    return { status: 200, body: JSON.stringify(payload) }
  }
}

test('an engine that reports itself unavailable is disabled for later queries', async () => {
  let calls = 0
  const blocked = { name: 'blocked', available: () => true, search: async () => { calls += 1; throw new EngineUnavailable('blocked', 'challenge page') } }
  const ok = { name: 'ok', available: () => true, search: async () => [{ url: 'https://a.com', title: 'a', engine: 'ok' }] }
  const first = await searchAll([blocked, ok], 'q1')
  assert.equal(first.hits.length, 1)
  assert.equal(first.engineFailures, 1)
  const second = await searchAll([blocked, ok], 'q2')
  assert.equal(second.engineFailures, 0)
  assert.equal(calls, 1, 'blocked engine must not be retried')
  assert.equal(second.hits.length, 1)
})

test('brave engine sends its token and prefers ISO page_age over human age', async () => {
  const calls = []
  const engines = createEngines({
    config: { engines: { ctxWeb: false, ddgHtml: false, brave: true }, keys: { brave: 'brave-key' } },
    fetchRaw: fakeFetch({
      web: { results: [{ url: 'https://nodejs.org/en/about/releases', title: 'Releases', description: 'Node 22 LTS', page_age: '2026-01-02T00:00:00Z', age: '2 days ago' }] },
    }, calls),
  })
  assert.deepEqual(engines.map((engine) => engine.name), ['brave'])
  const hits = await engines[0].search('node lts', { maxResults: 5 })
  assert.equal(hits.length, 1)
  assert.equal(hits[0].publishedAt, '2026-01-02T00:00:00Z')
  assert.equal(calls[0].headers['x-subscription-token'], 'brave-key')
  const url = new URL(calls[0].url)
  assert.equal(url.searchParams.get('q'), 'node lts')
  assert.equal(url.searchParams.get('count'), '5')
})

test('tavily engine uses bearer auth and maps published_date', async () => {
  const calls = []
  const engines = createEngines({
    config: { engines: { ctxWeb: false, ddgHtml: false, tavily: true }, keys: { tavily: 'tv-key' } },
    fetchRaw: fakeFetch({ results: [{ url: 'https://eur-lex.europa.eu/eli/reg/2024/2847/oj', title: 'CRA', content: 'Regulation text', published_date: '2024-11-20' }] }, calls),
  })
  const hits = await engines[0].search('CRA regulation', { maxResults: 3 })
  assert.equal(hits[0].url, 'https://eur-lex.europa.eu/eli/reg/2024/2847/oj')
  assert.equal(hits[0].publishedAt, '2024-11-20')
  assert.equal(calls[0].headers.authorization, 'Bearer tv-key')
  const body = JSON.parse(calls[0].body)
  assert.equal(body.query, 'CRA regulation')
  assert.equal(body.api_key, undefined)
})

test('serper and exa map their own result shapes', async () => {
  const serper = createEngines({
    config: { engines: { ctxWeb: false, ddgHtml: false, serper: true }, keys: { serper: 's-key' } },
    fetchRaw: fakeFetch({ organic: [{ link: 'https://a.com', title: 'A', snippet: 'sa' }] }, []),
  })[0]
  const serperHit = (await serper.search('q'))[0]
  assert.equal(serperHit.url, 'https://a.com')
  assert.equal(serperHit.title, 'A')
  assert.equal(serperHit.snippet, 'sa')
  assert.equal(serperHit.engine, 'serper')

  const exa = createEngines({
    config: { engines: { ctxWeb: false, ddgHtml: false, exa: true }, keys: { exa: 'e-key' } },
    fetchRaw: fakeFetch({ results: [{ url: 'https://b.com', title: 'B', text: 'sb', publishedDate: '2025-03-04' }] }, []),
  })[0]
  const exaHit = (await exa.search('q'))[0]
  assert.equal(exaHit.url, 'https://b.com')
  assert.equal(exaHit.snippet, 'sb')
  assert.equal(exaHit.publishedAt, '2025-03-04')
  assert.equal(exaHit.engine, 'exa')
})

test('paid engines fall back to environment variables when config.keys is absent', () => {
  const previous = process.env.SERPER_API_KEY
  process.env.SERPER_API_KEY = 'env-key'
  try {
    const engines = createEngines({
      config: { engines: { ctxWeb: false, ddgHtml: false, serper: true } },
      fetchRaw: async () => ({ status: 200, body: '{}' }),
    })
    assert.deepEqual(engines.map((engine) => engine.name), ['serper'])
  } finally {
    if (previous === undefined) delete process.env.SERPER_API_KEY
    else process.env.SERPER_API_KEY = previous
  }
})

test('paid engine quota throws EngineUnavailable before the network call', async () => {
  const calls = []
  const engines = createEngines({
    config: {
      engines: { ctxWeb: false, ddgHtml: false, tavily: true },
      keys: { tavily: 'tv-key' },
      quotaPerMonth: { tavily: 2 },
    },
    fetchRaw: fakeFetch({ results: [{ url: 'https://a.com', title: 'A', content: 'c' }] }, calls),
  })
  assert.deepEqual(engines.quota, { tavily: 0, brave: 0, serper: 0, exa: 0 })
  assert.equal(engines[0].name, 'tavily')
  await engines[0].search('q1')
  await engines[0].search('q2')
  assert.equal(calls.length, 2)
  await assert.rejects(
    () => engines[0].search('q3'),
    (error) => error instanceof EngineUnavailable && /quota exceeded/.test(error.message),
  )
  assert.equal(calls.length, 2, 'a throttled engine must not reach the network past its quota')
  assert.equal(engines.quota.tavily, 3, 'the blocked attempt still counts')
})