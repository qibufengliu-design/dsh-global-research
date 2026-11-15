/**
 * Vertical sources: direct API access to places general web search ranks poorly
 * (GitHub code/issues, arXiv papers, Stack Overflow answers, npm packages,
 * Hacker News discussion). Each adapter turns the API payload into the same
 * hit shape the search engines produce, so ranking/dedupe stay unchanged.
 *
 * All adapters are best-effort: a failing vertical must never fail the run.
 */
import { decodeEntities, truncate } from './util.js'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const DEV_HINTS = /\b(node(?:\.js)?|npm|pnpm|yarn|bun|react|vue|svelte|angular|typescript|javascript|python|rust|golang|java|kotlin|swift|c\+\+|api|sdk|library|framework|package|dependency|install|build|compile|error|exception|breaking change|migration)\b|插件|依赖|版本|报错|编译|构建|安装|迁移|接口|框架|库/i
const RESEARCH_HINTS = /\b(paper|papers|study|research|benchmark|arxiv|survey|dataset|model|algorithm|论文|研究|实验|评测|基准|算法|数据集)\b|论文|研究|实验|综述/i
const BUG_HINTS = /\b(bug|issue|error|exception|crash|regression)\b|报错|错误|崩溃|异常|复现/i
const PYTHON_HINTS = /\bpip install\b|\bpypi\b|python\s+(package|library|module|project)|python\s*(包|库|模块)|虚拟环境|requirements\.txt/i

export const VERTICALS = {
  github: {
    label: 'GitHub',
    hosts: ['github.com'],
    search: githubSearch,
  },
  arxiv: {
    label: 'arXiv',
    hosts: ['arxiv.org'],
    search: arxivSearch,
  },
  scholar: {
    label: 'OpenAlex',
    hosts: ['openalex.org', 'doi.org'],
    search: openAlexSearch,
  },
  stackexchange: {
    label: 'Stack Exchange',
    hosts: ['stackoverflow.com', 'stackexchange.com'],
    search: stackExchangeSearch,
  },
  npm: {
    label: 'npm',
    hosts: ['npmjs.com'],
    search: npmSearch,
  },
  hn: {
    label: 'Hacker News',
    hosts: ['news.ycombinator.com'],
    search: hnSearch,
  },
  pypi: {
    label: 'PyPI',
    hosts: ['pypi.org'],
    search: pypiSearch,
  },
}

/** Pick at most two verticals that plausibly answer this question. */
export function pickVerticals({ question = '', focus = [], subQuestions = [], enabled = {} } = {}) {
  const text = [question, ...(Array.isArray(focus) ? focus : []), ...(Array.isArray(subQuestions) ? subQuestions : [])].join(' ')
  const scores = {
    github: DEV_HINTS.test(text) ? 3 : 0,
    stackexchange: DEV_HINTS.test(text) ? 2 : 0,
    npm: DEV_HINTS.test(text) ? 1 : 0,
    arxiv: RESEARCH_HINTS.test(text) ? 3 : 0,
    scholar: RESEARCH_HINTS.test(text) ? 2 : 0,
    pypi: PYTHON_HINTS.test(text) ? 3 : 0,
    hn: /\b(opinion|discussion|experience|worth|should i|best|alternatives)\b|值得|推荐|体验|看法|对比/i.test(text) ? 2 : 0,
  }
  if (scores.github > 0 && BUG_HINTS.test(text)) scores.github += 1
  const picked = Object.entries(scores)
    .filter(([name, score]) => score > 0 && enabled[name] !== false)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([name]) => name)
  return picked
}

async function verticalSearch(name, query, { fetchRaw, signal, timeoutMs = 12000, config = {} }) {
  const adapter = VERTICALS[name]
  if (!adapter || typeof fetchRaw !== 'function') return []
  try {
    return await adapter.search(query, { fetchRaw, signal, timeoutMs, config })
  } catch {
    return []
  }
}

/** Run every picked vertical for the first queries; failures are isolated. */
export async function searchVerticals(names, queries, options = {}) {
  const list = (names ?? []).filter((name) => VERTICALS[name])
  if (list.length === 0 || queries.length === 0) return { hits: [], errors: [] }
  const tasks = []
  for (const name of list) {
    for (const query of queries) {
      tasks.push(verticalSearch(name, query, options))
    }
  }
  const settled = await Promise.allSettled(tasks)
  const hits = []
  const errors = []
  settled.forEach((result) => {
    if (result.status === 'fulfilled') hits.push(...result.value)
    else errors.push(String(result.reason?.message ?? result.reason))
  })
  return { hits, errors }
}

function stripTags(html) {
  return decodeEntities(String(html ?? '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
}

function toHit(engine, { url, title, snippet, text, publishedAt }) {
  return {
    url,
    title: truncate(stripTags(title) || url, 120),
    snippet: truncate(stripTags(snippet), 300),
    text: stripTags(text).slice(0, 20000) || undefined,
    publishedAt,
    engine,
  }
}

async function githubSearch(query, { fetchRaw, signal, timeoutMs }) {
  const q = encodeURIComponent(query.slice(0, 120))
  const headers = { accept: 'application/vnd.github+json' }
  // Discussions are usually a better answer than a repo for "how do I …"
  // questions, so issues come first; repos are a fallback for library names.
  const issues = await fetchRaw(`https://api.github.com/search/issues?q=${q}+type:issue&sort=reactions&order=desc&per_page=5`, {
    signal, timeoutMs, headers,
  }).catch(() => null)
  if (issues && issues.status < 400) {
    const data = JSON.parse(issues.body)
    const hits = (data.items ?? []).map((item) => toHit('github', {
      url: item.html_url,
      title: item.title,
      snippet: item.body,
      text: item.body,
      publishedAt: item.created_at?.slice(0, 10),
    })).filter((hit) => hit.url && hit.title)
    if (hits.length > 0) return hits
  }
  const repos = await fetchRaw(`https://api.github.com/search/repositories?q=${q}&sort=stars&order=desc&per_page=5`, {
    signal, timeoutMs, headers,
  })
  if (repos.status >= 400) return []
  const data = JSON.parse(repos.body)
  const tokens = String(query).toLowerCase().split(/[^a-z0-9+#._-]+/).filter((word) => word.length >= 3)
  return (data.items ?? []).map((item) => toHit('github', {
    url: item.html_url,
    title: item.full_name,
    snippet: `${item.description ?? ''} ★${item.stargazers_count ?? 0}`,
    publishedAt: item.pushed_at?.slice(0, 10),
  }))
    .filter((hit) => hit.url)
    // A repo whose name/description shares no word with the question is noise
    // (e.g. random COVID trackers for a React hooks question).
    .filter((hit) => tokens.some((token) => `${hit.title} ${hit.snippet}`.toLowerCase().includes(token)))
}

async function arxivSearch(query, { fetchRaw, signal, timeoutMs }) {
  const q = encodeURIComponent(`all:${query.slice(0, 120)}`)
  const { status, body } = await fetchRaw(`https://export.arxiv.org/api/query?search_query=${q}&start=0&max_results=5`, {
    signal,
    timeoutMs,
    headers: { accept: 'application/atom+xml' },
  })
  if (status >= 400) return []
  const hits = []
  const entry = /<entry>([\s\S]*?)<\/entry>/g
  for (let match = entry.exec(body); match; match = entry.exec(body)) {
    const block = match[1]
    const id = /<id>([\s\S]*?)<\/id>/.exec(block)?.[1]?.trim()
    const title = /<title>([\s\S]*?)<\/title>/.exec(block)?.[1]
    const summary = /<summary>([\s\S]*?)<\/summary>/.exec(block)?.[1]
    const published = /<published>([\s\S]*?)<\/published>/.exec(block)?.[1]?.slice(0, 10)
    if (!id) continue
    hits.push(toHit('arxiv', { url: id.replace('http://', 'https://'), title, snippet: summary, text: summary, publishedAt: published }))
  }
  return hits
}

/**
 * OpenAlex: free, key-less scholarly index (Semantic Scholar needs a key at
 * scale). Only Latin queries work; each hit carries year and citation count so
 * the evidence prompt can say "2023, cited 120 times" instead of just a title.
 */
async function openAlexSearch(query, { fetchRaw, signal, timeoutMs }) {
  const words = latinWords(query)
  if (words.length < 2) return []
  const q = encodeURIComponent(words.slice(0, 6).join(' '))
  const { status, body } = await fetchRaw(`https://api.openalex.org/works?search=${q}&per-page=5&sort=cited_by_count:desc`, {
    signal,
    timeoutMs,
    headers: { accept: 'application/json' },
  })
  if (status >= 400) return []
  let payload
  try {
    payload = JSON.parse(String(body))
  } catch {
    return []
  }
  const hits = []
  for (const work of payload.results ?? []) {
    const url = work.doi ? `https://doi.org/${String(work.doi).replace(/^https?:\/\/doi\.org\//, '')}` : work.id
    if (!url) continue
    const year = work.publication_year
    const cited = work.cited_by_count
    const summary = reconstructAbstract(work.abstract_inverted_index)
    const text = [summary, year ? `${year} 年发表` : '', typeof cited === 'number' ? `被引用 ${cited} 次` : ''].filter(Boolean).join('；')
    hits.push(toHit('scholar', {
      url,
      title: work.display_name,
      snippet: text,
      text: text || work.display_name,
      publishedAt: year ? String(year) : undefined,
    }))
  }
  return hits
}

/** OpenAlex stores abstracts as an inverted index: word → positions. */
function reconstructAbstract(index) {
  if (!index || typeof index !== 'object') return ''
  const slots = []
  for (const [word, positions] of Object.entries(index)) {
    for (const position of positions ?? []) slots[position] = word
  }
  return slots.filter(Boolean).join(' ').slice(0, 1200)
}
function latinWords(query) {
  const latin = String(query)
    .replace(/[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]+/g, ' ')
    .replace(/[^A-Za-z0-9+#._-]+/g, ' ')
  return [...new Set(latin.split(/\s+/).map((word) => word.toLowerCase()).filter((word) => word.length >= 3))].slice(0, 8)
}

/** Question terms → Stack Overflow tags. Order matters: the first match is the
 * most specific, and SE combines `tagged` values with AND, so we only send one. */
const TAG_RULES = [
  [/\b(useEffect|useMemo|useCallback|useState|hooks?)\b/i, 'react-hooks'],
  [/\breact(-dom)?\b/i, 'reactjs'],
  [/\bnext\.?js\b/i, 'next.js'],
  [/\bvue(\.?js)?\b/i, 'vue.js'],
  [/\bsvelte(kit)?\b/i, 'svelte'],
  [/\bangular\b/i, 'angular'],
  [/\btypescript\b/i, 'typescript'],
  [/\bnode(\.?js)?\b/i, 'node.js'],
  [/\bexpress(\.?js)?\b/i, 'express'],
  [/\bpython\b/i, 'python'],
  [/\bpandas\b/i, 'pandas'],
  [/\bnumpy\b/i, 'numpy'],
  [/\bdjango\b/i, 'django'],
  [/\brust\b/i, 'rust'],
  [/\bgolang\b|\bgo\s+(module|lang)\b/i, 'go'],
  [/\bjava\b/i, 'java'],
  [/\bspring(-boot)?\b/i, 'spring-boot'],
  [/\bdocker\b/i, 'docker'],
  [/\bkubernetes\b|\bk8s\b/i, 'kubernetes'],
  [/\bpostgres(ql)?\b/i, 'postgresql'],
  [/\bmysql\b/i, 'mysql'],
  [/\bmongo(db)?\b/i, 'mongodb'],
  [/\bredis\b/i, 'redis'],
  [/\bgraphql\b/i, 'graphql'],
  [/\bwebsockets?\b/i, 'websocket'],
  [/\btailwind(css)?\b/i, 'tailwindcss'],
  [/\baws\b|\bamazon web services\b/i, 'amazon-web-services'],
  [/\bazure\b/i, 'azure'],
  [/\bgcp\b|\bgoogle cloud\b/i, 'google-cloud-platform'],
  [/\bpnpm\b/i, 'pnpm'],
  [/\byarn\b/i, 'yarn'],
  [/\bnpm\b/i, 'npm'],
]

export function tagsFor(text) {
  const source = String(text ?? '')
  const tag = TAG_RULES.find(([pattern]) => pattern.test(source))?.[1]
  return tag ? [tag] : []
}

async function stackExchangeSearch(query, { fetchRaw, signal, timeoutMs }) {
  const words = latinWords(query)
  if (words.length < 2) return []
  const request = async (path) => {
    const { status, body } = await fetchRaw(`https://api.stackexchange.com/2.3/${path}&site=stackoverflow&pagesize=5&filter=withbody`, {
      signal,
      timeoutMs,
      headers: { accept: 'application/json' },
    })
    if (status >= 400) return []
    try {
      return JSON.parse(body).items ?? []
    } catch {
      return []
    }
  }
  const tag = tagsFor(query)?.[0]
  const taggedPath = tag
    ? `search/advanced?order=desc&sort=relevance&q=${encodeURIComponent(words.join(' '))}&tagged=${encodeURIComponent(tag)}`
    : ''
  let items = taggedPath ? await request(taggedPath) : []
  // A wrong/unmatched tag must not cost us the whole channel: retry untagged.
  if (items.length === 0) items = await request(`search/advanced?order=desc&sort=relevance&q=${encodeURIComponent(words.join(' '))}`)
  // Full-text on a long query is noisy; a title match against the key terms is
  // a better fallback than returning nothing.
  if (items.length === 0) items = await request(`search?order=desc&sort=votes&intitle=${encodeURIComponent(words.slice(0, 4).join(' '))}`)
  return items.map((item) => toHit('stackexchange', {
    url: item.link,
    title: item.title,
    snippet: `${(item.tags ?? []).join(', ')} · score ${item.score ?? 0}`,
    text: item.body,
    publishedAt: item.creation_date ? new Date(item.creation_date * 1000).toISOString().slice(0, 10) : undefined,
  })).filter((hit) => hit.url)
}

async function pypiSearch(query, { fetchRaw, signal, timeoutMs }) {
  const q = encodeURIComponent(query.slice(0, 120))
  const { status, body } = await fetchRaw(`https://pypi.org/search/?q=${q}`, {
    signal,
    timeoutMs,
    headers: { accept: 'text/html' },
  })
  if (status >= 400) return []
  const names = []
  const pattern = /<a[^>]+class="package-snippet"[^>]+href="\/project\/([^/"]+)\/?"/gi
  for (let match = pattern.exec(body); match && names.length < 4; match = pattern.exec(body)) {
    const name = decodeEntities(match[1]).trim()
    if (name && !names.includes(name)) names.push(name)
  }
  const hits = []
  // The search page only carries a one-line summary; the JSON API carries the
  // README. Fetch at most two packages so one vertical cannot dominate the page
  // budget.
  for (const name of names.slice(0, 2)) {
    const detail = await fetchRaw(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`, {
      signal,
      timeoutMs,
      headers: { accept: 'application/json' },
    }).catch(() => null)
    let info
    if (detail && detail.status < 400) {
      try {
        info = JSON.parse(detail.body).info
      } catch {
        info = undefined
      }
    }
    hits.push(toHit('pypi', {
      url: `https://pypi.org/project/${name}/`,
      title: info?.name ?? name,
      snippet: info?.summary ?? '',
      text: info ? `${info.summary ?? ''}\n\n${info.description ?? ''}` : '',
    }))
  }
  return hits.filter((hit) => hit.url)
}

async function npmSearch(query, { fetchRaw, signal, timeoutMs }) {
  const q = encodeURIComponent(query.slice(0, 120))
  const { status, body } = await fetchRaw(`https://registry.npmjs.org/-/v1/search?text=${q}&size=5`, {
    signal,
    timeoutMs,
    headers: { accept: 'application/json' },
  })
  if (status >= 400) return []
  let data
  try {
    data = JSON.parse(body)
  } catch {
    return []
  }
  return (data.objects ?? []).map((item) => toHit('npm', {
    url: item.package?.links?.npm ?? `https://www.npmjs.com/package/${item.package?.name ?? ''}`,
    title: item.package?.name,
    snippet: item.package?.description,
    publishedAt: item.package?.date?.slice(0, 10),
  })).filter((hit) => hit.url && hit.title)
}

async function hnSearch(query, { fetchRaw, signal, timeoutMs }) {
  const q = encodeURIComponent(query.slice(0, 120))
  const { status, body } = await fetchRaw(`https://hn.algolia.com/api/v1/search?query=${q}&hitsPerPage=5`, {
    signal,
    timeoutMs,
    headers: { accept: 'application/json' },
  })
  if (status >= 400) return []
  let data
  try {
    data = JSON.parse(body)
  } catch {
    return []
  }
  return (data.hits ?? []).map((item) => toHit('hn', {
    url: item.url || `https://news.ycombinator.com/item?id=${item.objectID}`,
    title: item.title || item.story_title,
    snippet: item.story_text || item.comment_text,
    text: item.story_text || item.comment_text,
    publishedAt: item.created_at?.slice(0, 10),
  })).filter((hit) => hit.url && hit.title)
}