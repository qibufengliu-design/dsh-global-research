/**
 * Search engines. The default layer is key-free (ctx.web.search + DuckDuckGo
 * HTML); paid engines activate only when their config flag is on AND their
 * environment variable is present. Keys never live in plugin config.
 */
import { anySignal, decodeEntities, domainOf, normalizeUrl, sleep } from './util.js'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const DEFAULT_TIMEOUT = 15000

export class EngineUnavailable extends Error {
  constructor(engine, reason) {
    super(`${engine} unavailable: ${reason}`)
    this.name = 'EngineUnavailable'
    this.engine = engine
  }
}

/**
 * Monthly call budget per paid engine (the cheapest plan of each provider).
 * `config.quotaPerMonth` overrides individual entries. The counter lives in
 * memory for the process: it is a safety net against a runaway query, not a
 * billing ledger.
 */
export const DEFAULT_QUOTA = { tavily: 1000, brave: 2000, serper: 2500, exa: 1000 }

/** Raw HTTP text fetch used by engines that do not go through ctx.web. */
export function createRawFetcher() {
  return async function fetchRaw(url, { signal, timeoutMs = DEFAULT_TIMEOUT, headers = {}, method = 'GET', body } = {}) {
    const response = await fetch(url, {
      method,
      body,
      redirect: 'follow',
      signal: anySignal(signal, timeoutMs),
      headers: {
        'user-agent': UA,
        accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        ...headers,
      },
    })
    const text = await response.text()
    return { status: response.status, body: text }
  }
}

function throttle(fn, minInterval = 1100) {
  let last = 0
  return async (...args) => {
    const wait = last + minInterval - Date.now()
    if (wait > 0) await sleep(wait)
    last = Date.now()
    return fn(...args)
  }
}

function toHit(engine, item, index) {
  return {
    url: item.url,
    title: item.title ?? domainOf(item.url),
    snippet: item.snippet ?? '',
    publishedAt: item.publishedAt,
    engine,
    rank: index + 1,
  }
}

function ctxWebEngine(web) {
  const search = throttle(async (query, { maxResults, signal }) => {
    const result = await web.search({ query, maxResults }, signal)
    const sources = result?.sources ?? []
    return sources.map((source, index) => toHit('ctx-web', {
      url: source.url,
      title: source.title,
      snippet: source.snippet ?? source.summary ?? '',
      publishedAt: source.publishedAt,
    }, index))
  }, 300)
  return { name: 'ctx-web', available: () => true, search }
}

export function parseDuckDuckGo(body) {
  if (/anomaly|challenge|unusual traffic/i.test(body) && !/result__a/.test(body)) {
    throw new Error('blocked by DuckDuckGo (challenge page)')
  }
  const links = []
  const linkPattern = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
  for (let match = linkPattern.exec(body); match; match = linkPattern.exec(body)) {
    links.push({ href: decodeEntities(match[1]), title: decodeEntities(match[2].replace(/<[^>]+>/g, ' ')).trim() })
  }
  const snippets = []
  const snippetPattern = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi
  for (let match = snippetPattern.exec(body); match; match = snippetPattern.exec(body)) {
    snippets.push(decodeEntities(match[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim())
  }
  return links.map((link, index) => ({ url: unwrapDdg(link.href), title: link.title, snippet: snippets[index] ?? '' }))
}

function unwrapDdg(href) {
  try {
    const url = new URL(href, 'https://duckduckgo.com')
    const target = url.searchParams.get('uddg')
    return target ? decodeURIComponent(target) : url.toString()
  } catch {
    return href
  }
}

function ddgEngine(fetchRaw) {
  const search = throttle(async (query, { maxResults = 10, signal } = {}) => {
    const target = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=wt-wt`
    const { status, body } = await fetchRaw(target, { signal, timeoutMs: 8000 })
    if (status === 429) throw new EngineUnavailable('ddg-html', 'HTTP 429')
    if (status >= 400) throw new EngineUnavailable('ddg-html', `HTTP ${status}`)
    return parseDuckDuckGo(body).slice(0, maxResults).map((item, index) => toHit('ddg-html', item, index))
  })
  return { name: 'ddg-html', available: () => true, search }
}

function tavilyEngine(fetchRaw, key, spend) {
  const search = throttle(async (query, { maxResults = 8, signal } = {}) => {
    spend?.('tavily')
    const { status, body } = await fetchRaw('https://api.tavily.com/search', {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ query, max_results: maxResults, search_depth: 'basic', include_answer: false }),
    })
    if (status === 429) throw new EngineUnavailable('tavily', 'HTTP 429')
    if (status >= 400) throw new EngineUnavailable('tavily', `HTTP ${status}`)
    const data = JSON.parse(body)
    return (data.results ?? []).slice(0, maxResults).map((item, index) => toHit('tavily', {
      url: item.url, title: item.title, snippet: item.content ?? '',
      publishedAt: item.published_date,
    }, index))
  })
  return { name: 'tavily', available: () => Boolean(key), search }
}

function braveEngine(fetchRaw, key, spend) {
  const search = throttle(async (query, { maxResults = 8, signal } = {}) => {
    spend?.('brave')
    const params = new URLSearchParams({
      q: query,
      count: String(Math.min(20, maxResults)),
      safesearch: 'moderate',
      text_decorations: 'false',
    })
    const { status, body } = await fetchRaw(`https://api.search.brave.com/res/v1/web/search?${params}`, {
      signal,
      headers: { 'x-subscription-token': key, accept: 'application/json' },
    })
    if (status === 429) throw new EngineUnavailable('brave', 'HTTP 429')
    if (status >= 400) throw new EngineUnavailable('brave', `HTTP ${status}`)
    const data = JSON.parse(body)
    return (data.web?.results ?? []).slice(0, maxResults).map((item, index) => toHit('brave', {
      url: item.url, title: item.title, snippet: item.description ?? '',
      // page_age is ISO-8601 when present; age is a human string ("2 days ago")
      publishedAt: item.page_age ?? item.age,
    }, index))
  })
  return { name: 'brave', available: () => Boolean(key), search }
}

function serperEngine(fetchRaw, key, spend) {
  const search = throttle(async (query, { maxResults = 8, signal } = {}) => {
    spend?.('serper')
    const { status, body } = await fetchRaw('https://google.serper.dev/search', {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json', 'x-api-key': key },
      body: JSON.stringify({ q: query, num: maxResults }),
    })
    if (status === 429) throw new EngineUnavailable('serper', 'HTTP 429')
    if (status >= 400) throw new EngineUnavailable('serper', `HTTP ${status}`)
    const data = JSON.parse(body)
    return (data.organic ?? []).slice(0, maxResults).map((item, index) => toHit('serper', {
      url: item.link, title: item.title, snippet: item.snippet ?? '',
    }, index))
  })
  return { name: 'serper', available: () => Boolean(key), search }
}

function exaEngine(fetchRaw, key, spend) {
  const search = throttle(async (query, { maxResults = 8, signal } = {}) => {
    spend?.('exa')
    const { status, body } = await fetchRaw('https://api.exa.ai/search', {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json', 'x-api-key': key },
      body: JSON.stringify({ query, numResults: maxResults, contents: { text: { maxCharacters: 1000 } } }),
    })
    if (status === 429) throw new EngineUnavailable('exa', 'HTTP 429')
    if (status >= 400) throw new EngineUnavailable('exa', `HTTP ${status}`)
    const data = JSON.parse(body)
    return (data.results ?? []).slice(0, maxResults).map((item, index) => toHit('exa', {
      url: item.url, title: item.title, snippet: item.text ?? '',
      publishedAt: item.publishedDate,
    }, index))
  })
  return { name: 'exa', available: () => Boolean(key), search }
}

function keyFor(config, name) {
  const inline = config.keys?.[name]
  if (typeof inline === 'string' && inline.trim()) return inline.trim()
  return process.env[`${name.toUpperCase()}_API_KEY`]?.trim() || undefined
}

export function createEngines({ config = {}, web, fetchRaw }) {
  const engines = []
  // Every paid request bumps these counters; crossing the monthly plan limit
  // throws EngineUnavailable, which searchAll turns into "stop using this
  // engine" instead of spewing 4xx responses for the rest of the run.
  const quota = { tavily: 0, brave: 0, serper: 0, exa: 0 }
  const limits = { ...DEFAULT_QUOTA }
  for (const [name, value] of Object.entries(config.quotaPerMonth ?? {})) {
    const limit = Number(value)
    if (name in limits && Number.isFinite(limit) && limit >= 0) limits[name] = Math.round(limit)
  }
  const spend = (name) => {
    quota[name] = (quota[name] ?? 0) + 1
    if (quota[name] > limits[name]) throw new EngineUnavailable(name, 'quota exceeded')
  }
  // Paid engines first: their titles/snippets survive dedupe/merge better.
  if (config.engines?.brave) engines.push(braveEngine(fetchRaw, keyFor(config, 'brave'), spend))
  if (config.engines?.tavily) engines.push(tavilyEngine(fetchRaw, keyFor(config, 'tavily'), spend))
  if (config.engines?.serper) engines.push(serperEngine(fetchRaw, keyFor(config, 'serper'), spend))
  if (config.engines?.exa) engines.push(exaEngine(fetchRaw, keyFor(config, 'exa'), spend))
  if (config.engines?.ctxWeb !== false && web?.search) engines.push(ctxWebEngine(web))
  if (config.engines?.ddgHtml !== false) engines.push(ddgEngine(fetchRaw))
  const available = engines.filter((engine) => engine.available())
  // Let the pipeline report spend without threading a second return value
  // through index.js.
  available.quota = quota
  return available
}

/**
 * Query every available engine in parallel. One failing engine never fails the
 * query; failures are reported through `onError` for logging only.
 *
 * An engine that reports itself unavailable (challenge page, HTTP 4xx/5xx) is
 * disabled for the rest of the process: retrying a blocked endpoint burns the
 * wall-clock budget on every query without ever returning hits.
 */
export async function searchAll(engines, query, { signal, maxResults = 10, onError } = {}) {
  const usable = engines.filter((engine) => !engine.disabled)
  const settled = await Promise.allSettled(
    usable.map((engine) => engine.search(query, { signal, maxResults })),
  )
  const hits = []
  settled.forEach((outcome, index) => {
    const engine = usable[index]
    if (outcome.status === 'fulfilled') {
      hits.push(...outcome.value)
      return
    }
    if (outcome.reason instanceof EngineUnavailable) engine.disabled = true
    onError?.(engine?.name ?? 'unknown', outcome.reason)
  })
  return { hits, engineFailures: settled.filter((outcome) => outcome.status === 'rejected').length }
}

export { normalizeUrl }