import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickVerticals, searchVerticals, tagsFor, VERTICALS } from '../lib/verticals.js'

test('pickVerticals picks code sources for library questions', () => {
  const picked = pickVerticals({ question: 'React 19 的 use() 和 useEffect 在数据获取上怎么选？' })
  assert.ok(picked.includes('github'))
  // Official docs score 3, so MDN outranks Stack Overflow for a React question.
  assert.ok(picked.includes('docs'))
  assert.ok(picked.length <= 2)
})

test('pickVerticals picks arXiv for research questions', () => {
  const picked = pickVerticals({ question: 'which retrieval augmented generation benchmark is standard in 2026?' })
  assert.ok(picked.includes('arxiv'))
  assert.ok(picked.includes('scholar'))
  assert.deepEqual(picked.length <= 2, true)
})

test('pickVerticals returns nothing for non-technical policy questions', () => {
  assert.deepEqual(pickVerticals({ question: '欧盟《网络弹性法案》对户外插座有哪些合规义务？' }), [])
})

test('pickVerticals respects disabled verticals', () => {
  const picked = pickVerticals({
    question: 'pnpm 安装依赖报错怎么解决',
    enabled: { github: false, stackexchange: false, npm: false, arxiv: false, hn: false },
  })
  assert.deepEqual(picked, [])
})

test('pickVerticals honours strategy allow/deny/limit without changing the default', () => {
  const question = 'React 19 的 use() 和 useEffect 在数据获取上怎么选？'
  // No strategy arguments == the legacy keyword scoring, exactly.
  assert.deepEqual(pickVerticals({ question }), pickVerticals({ question, allow: [], deny: [], limit: 2 }))
  // allow pins a vertical first, but deny and enabled still win.
  assert.deepEqual(pickVerticals({ question, allow: ['hn'], limit: 2 })[0], 'hn')
  assert.ok(!pickVerticals({ question, allow: ['hn'], deny: ['hn'] }).includes('hn'))
  assert.ok(!pickVerticals({ question, allow: ['hn'], enabled: { hn: false } }).includes('hn'))
  // limit caps the result, and allow fills it before scoring.
  assert.deepEqual(pickVerticals({ question, allow: ['hn', 'npm'], limit: 2 }), ['hn', 'npm'])
  assert.equal(pickVerticals({ question, limit: 1 }).length, 1)
  // Unknown names are ignored instead of leaking into the search list.
  assert.deepEqual(pickVerticals({ question: '欧盟法规', allow: ['not-a-vertical'] }), [])
})

function fakeFetch(payloads) {
  return async (url) => {
    const entry = Object.entries(payloads).find(([needle]) => url.includes(needle))
    if (!entry) return { status: 404, body: '' }
    const [, value] = entry
    if (value instanceof Error) throw value
    return value
  }
}

test('github adapter maps repositories to hits', async () => {
  const fetchRaw = fakeFetch({
    'api.github.com/search/repositories': {
      status: 200,
      body: JSON.stringify({ items: [{ html_url: 'https://github.com/facebook/react', full_name: 'facebook/react', description: 'UI lib', stargazers_count: 230000, pushed_at: '2026-11-01T00:00:00Z' }] }),
    },
  })
  const { hits } = await searchVerticals(['github'], ['react'], { fetchRaw })
  assert.equal(hits.length, 1)
  assert.equal(hits[0].engine, 'github')
  assert.equal(hits[0].url, 'https://github.com/facebook/react')
  assert.match(hits[0].snippet, /star|★/)
})

test('openalex adapter turns inverted abstracts into text with year and citations', async () => {
  const payload = JSON.stringify({
    results: [{
      id: 'https://openalex.org/W1',
      doi: 'https://doi.org/10.1000/abc',
      display_name: 'Retrieval Augmented Generation: A Survey',
      publication_year: 2024,
      cited_by_count: 321,
      abstract_inverted_index: { We: [0], study: [1], RAG: [2] },
    }],
  })
  const { hits } = await searchVerticals(['scholar'], ['retrieval augmented generation survey'], {
    fetchRaw: fakeFetch({ 'api.openalex.org': { status: 200, body: payload } }),
  })
  assert.equal(hits.length, 1)
  assert.equal(hits[0].url, 'https://doi.org/10.1000/abc')
  assert.match(hits[0].text, /We study RAG/)
  assert.match(hits[0].text, /2024/)
  assert.match(hits[0].text, /321/)
})

test('arxiv adapter parses atom entries and strips markup', async () => {
  const atom = `<?xml version="1.0"?><feed><entry><id>http://arxiv.org/abs/2601.00001v1</id><title>Retrieval &amp; RAG</title><summary>We study RAG.</summary><published>2026-01-02T00:00:00Z</published></entry></feed>`
  const { hits } = await searchVerticals(['arxiv'], ['rag'], { fetchRaw: fakeFetch({ 'export.arxiv.org': { status: 200, body: atom } }) })
  assert.equal(hits.length, 1)
  assert.equal(hits[0].url, 'https://arxiv.org/abs/2601.00001v1')
  assert.equal(hits[0].title, 'Retrieval & RAG')
  assert.equal(hits[0].publishedAt, '2026-01-02')
})

test('stackexchange and npm adapters tolerate garbage payloads', async () => {
  const fetchRaw = fakeFetch({
    'api.stackexchange.com': { status: 200, body: 'not json' },
    'registry.npmjs.org': { status: 500, body: '' },
  })
  const { hits } = await searchVerticals(['stackexchange', 'npm'], ['pnpm install'], { fetchRaw })
  assert.deepEqual(hits, [])
})

test('stackexchange skips pure-Chinese queries instead of asking for noise', async () => {
  const calls = []
  const fetchRaw = async (url) => {
    calls.push(url)
    return { status: 200, body: JSON.stringify({ items: [] }) }
  }
  const { hits } = await searchVerticals(['stackexchange'], ['React 19 数据获取 怎么写'], { fetchRaw })
  assert.deepEqual(hits, [])
  assert.deepEqual(calls, [])
})

test('stackexchange falls back to a title search when full-text finds nothing', async () => {
  const calls = []
  const fetchRaw = async (url) => {
    calls.push(url)
    if (url.includes('intitle=')) {
      return { status: 200, body: JSON.stringify({ items: [{ link: 'https://stackoverflow.com/questions/2/use', title: 'React use() with a cached promise', tags: ['react'], score: 12, body: '<p>Cache the promise outside render.</p>', creation_date: 1760000000 }] }) }
    }
    return { status: 200, body: JSON.stringify({ items: [] }) }
  }
  const { hits } = await searchVerticals(['stackexchange'], ['react use data fetching'], { fetchRaw })
  assert.equal(hits.length, 1)
  assert.equal(hits[0].engine, 'stackexchange')
  assert.match(calls[0], /search\/advanced/)
  assert.match(calls.at(-1), /intitle=/)
})

test('stackexchange maps question terms to a tag before falling back', async () => {
  assert.deepEqual(tagsFor('How to fetch data with useEffect in React 19'), ['react-hooks'])
  assert.deepEqual(tagsFor('which database should I use with Django'), ['django'])
  assert.deepEqual(tagsFor('欧盟 CRA 合规义务'), [])
  const calls = []
  const fetchRaw = async (url) => {
    calls.push(url)
    return { status: 200, body: JSON.stringify({ items: [] }) }
  }
  await searchVerticals(['stackexchange'], ['react use data fetching'], { fetchRaw })
  assert.match(calls[0], /tagged=reactjs/)
  assert.ok(!calls[1].includes('tagged='), 'untagged retry must not reuse a wrong tag')
})

test('github adapter prefers issue threads over repositories', async () => {
  const fetchRaw = fakeFetch({
    'api.github.com/search/issues': {
      status: 200,
      body: JSON.stringify({ items: [{ html_url: 'https://github.com/reactjs/react.dev/issues/3308', title: 'use() and data fetching', body: 'Should I use use()?', created_at: '2025-01-02T00:00:00Z' }] }),
    },
  })
  const { hits } = await searchVerticals(['github'], ['react use data fetching'], { fetchRaw })
  assert.equal(hits.length, 1)
  assert.match(hits[0].url, /issues\/3308/)
})

test('github adapter drops repositories unrelated to the question', async () => {
  const fetchRaw = fakeFetch({
    'api.github.com/search/issues': { status: 200, body: JSON.stringify({ items: [] }) },
    'api.github.com/search/repositories': {
      status: 200,
      body: JSON.stringify({ items: [
        { html_url: 'https://github.com/AbhishekKalavadiya/covid-19_tracker', full_name: 'AbhishekKalavadiya/covid-19_tracker', description: 'covid tracker', stargazers_count: 300 },
        { html_url: 'https://github.com/facebook/react', full_name: 'facebook/react', description: 'React UI library', stargazers_count: 230000 },
      ] }),
    },
  })
  const { hits } = await searchVerticals(['github'], ['react use data fetching'], { fetchRaw })
  assert.equal(hits.length, 1)
  assert.equal(hits[0].url, 'https://github.com/facebook/react')
})

test('one failing vertical does not hide the others', async () => {
  const fetchRaw = fakeFetch({
    'api.github.com': new Error('boom'),
    'hn.algolia.com': { status: 200, body: JSON.stringify({ hits: [{ title: 'Show HN: Node 26 LTS', url: 'https://news.ycombinator.com/item?id=1', created_at: '2026-10-28T00:00:00Z' }] }) },
  })
  const { hits } = await searchVerticals(['github', 'hn'], ['node 26'], { fetchRaw })
  assert.equal(hits.length, 1)
  assert.equal(hits[0].engine, 'hn')
})

test("pypi adapter reads the package page and the JSON description", async () => {
  const html = `<html><body><a class="package-snippet" href="/project/httpx/"><span class="package-snippet__name">httpx</span><p class="package-snippet__description">HTTP client</p></a><a class="package-snippet" href="/project/aiohttp/"><span class="package-snippet__name">aiohttp</span></a></body></html>`
  const fetchRaw = fakeFetch({
    "pypi.org/search": { status: 200, body: html },
    "pypi.org/pypi/httpx/json": { status: 200, body: JSON.stringify({ info: { name: "httpx", summary: "HTTP client for Python", description: "A next generation HTTP client. ".repeat(20) } }) },
    "pypi.org/pypi/aiohttp/json": { status: 404, body: "" },
  })
  const { hits } = await searchVerticals(["pypi"], ["python http client"], { fetchRaw })
  assert.equal(hits.length, 2)
  assert.equal(hits[0].url, "https://pypi.org/project/httpx/")
  assert.match(hits[0].text, /next generation HTTP client/)
  assert.equal(hits[1].title, "aiohttp")
})

test("pickVerticals picks pypi for pip/python package questions", () => {
  const picked = pickVerticals({ question: "pip install 装不上，python 包依赖冲突怎么排查" })
  assert.ok(picked.includes("pypi"), picked.join(","))
})

test('docs adapter maps MDN search documents to hits', async () => {
  const calls = []
  const fetchRaw = async (url, options = {}) => {
    calls.push({ url, ...options })
    return {
      status: 200,
      body: JSON.stringify({
        documents: [
          { mdn_url: '/en-US/docs/Web/API/AbortController', title: 'AbortController', summary: 'Lets you abort fetch requests.' },
          { mdn_url: '/en-US/docs/Web/API/AbortSignal', title: 'AbortSignal', summary: 'A signal object used by AbortController.' },
        ],
      }),
    }
  }
  const { hits } = await searchVerticals(['docs'], ['react useEffect cleanup abort fetch'], { fetchRaw })
  assert.equal(hits.length, 2)
  assert.equal(hits[0].engine, 'docs')
  assert.equal(hits[0].url, 'https://developer.mozilla.org/en-US/docs/Web/API/AbortController')
  assert.equal(hits[0].title, 'AbortController')
  assert.match(hits[0].snippet, /abort fetch requests/)
  assert.match(calls[0].url, /developer\.mozilla\.org\/api\/v1\/search\?q=react%20useEffect%20cleanup/)
})

test('docs adapter ignores questions outside its keyword set', async () => {
  let calls = 0
  const fetchRaw = async () => {
    calls += 1
    return { status: 200, body: '{}' }
  }
  const { hits } = await searchVerticals(['docs'], ['linux 内核调度策略'], { fetchRaw })
  assert.deepEqual(hits, [])
  assert.equal(calls, 0, 'unknown topics must not hit the network')
})

test('docs adapter returns fixed official references for Spring and Python', async () => {
  const fetchRaw = async () => {
    throw new Error('fixed docs must not use the network')
  }
  const spring = await searchVerticals(['docs'], ['spring boot actuator endpoint'], { fetchRaw })
  assert.equal(spring.hits.length, 1)
  assert.equal(spring.hits[0].url, 'https://docs.spring.io/spring-boot/docs/current/reference/htmlsingle/')
  assert.equal(spring.hits[0].title, 'Spring Boot Reference Documentation')
  assert.equal(spring.hits[0].snippet, '官方参考文档')
  const python = await searchVerticals(['docs'], ['pandas groupby aggregation slow'], { fetchRaw })
  assert.equal(python.hits.length, 1)
  assert.equal(python.hits[0].url, 'https://docs.python.org/3/')
  assert.equal(python.hits[0].title, 'Python 3 Documentation')
  assert.equal(python.hits[0].snippet, '官方文档')
})

test('pickVerticals scores official docs as a first-class code source', () => {
  assert.ok(pickVerticals({ question: 'React 19 的 use() 和 useEffect 在数据获取上怎么选？' }).includes('docs'))
  assert.ok(pickVerticals({ question: 'spring boot 怎么配置 actuator 端点' }).includes('docs'))
  assert.ok(pickVerticals({ question: 'pandas groupby 很慢怎么优化' }).includes('docs'))
})

test('github adapter falls back to code search when issues and repositories are empty', async () => {
  const calls = []
  const fetchRaw = async (url, options = {}) => {
    calls.push({ url, ...options })
    if (url.includes('/search/issues')) return { status: 200, body: JSON.stringify({ items: [] }) }
    if (url.includes('/search/repositories')) return { status: 200, body: JSON.stringify({ items: [] }) }
    if (url.includes('/search/code')) {
      return {
        status: 200,
        body: JSON.stringify({
          items: [{
            html_url: 'https://github.com/vercel/next.js/blob/canary/packages/next/src/server/app-render.tsx',
            repository: { full_name: 'vercel/next.js' },
            path: 'packages/next/src/server/app-render.tsx',
            text_matches: [{ fragment: 'const cache = new Map()' }, { fragment: 'return cache.get(key)' }],
          }],
        }),
      }
    }
    return { status: 404, body: '' }
  }
  const { hits } = await searchVerticals(['github'], ['app renderer cache'], { fetchRaw })
  assert.equal(hits.length, 1)
  assert.equal(hits[0].engine, 'github')
  assert.match(hits[0].title, /^vercel\/next\.js · packages\/next/)
  assert.match(hits[0].snippet, /const cache = new Map/)
  assert.match(hits[0].snippet, /return cache.get\(key\)/)
  const codeCall = calls.find((call) => call.url.includes('/search/code'))
  assert.ok(codeCall, 'code search must be requested')
  assert.match(codeCall.url, /in:file/)
  assert.match(codeCall.url, /per_page=5/)
  assert.equal(codeCall.headers.accept, 'application/vnd.github.text-match+json')
})

test('github code search stays silent on 401/403 instead of throwing', async () => {
  const calls = []
  const fetchRaw = async (url) => {
    calls.push(url)
    if (url.includes('/search/code')) return { status: 401, body: JSON.stringify({ message: 'Requires authentication' }) }
    return { status: 200, body: JSON.stringify({ items: [] }) }
  }
  const hits = await VERTICALS.github.search('private api usage pattern', { fetchRaw })
  assert.deepEqual(hits, [])
  assert.equal(calls.filter((url) => url.includes('/search/code')).length, 1)
})

