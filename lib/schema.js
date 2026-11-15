/**
 * Schemastery Config declaration.
 *
 * DSH derives the plugin's settings page from its Config schema, but a bundle
 * loaded from an arbitrary workspace directory cannot resolve
 * `@deepseek-ai/schemastery` with a normal bare import. The running Desktop app
 * ships it inside `app.asar`, which Electron's `require` can load — so we
 * resolve it from the app resources and stay `undefined` when that fails (plain
 * Node in tests, other hosts), which simply means "no settings page".
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'

function loadSchema() {
  const candidates = []
  try {
    if (process.resourcesPath) candidates.push(join(process.resourcesPath, 'app.asar', 'dsh', 'package.json'))
  } catch {
    // process may be absent in exotic hosts
  }
  candidates.push('D:/Program Files (x86)/deepseek/resources/app.asar/dsh/package.json')
  for (const from of candidates) {
    try {
      const requireFromApp = createRequire(from)
      const module = requireFromApp('@deepseek-ai/schemastery')
      const schema = module?.default ?? module
      if (schema && typeof schema.object === 'function') return schema
    } catch {
      // try the next candidate
    }
  }
  return undefined
}

const z = loadSchema()

const engines = z
  ? z.object({
    ctxWeb: z.boolean().default(true).description('复用宿主 web.search'),
    ddgHtml: z.boolean().default(true).description('DuckDuckGo HTML 端点'),
    tavily: z.boolean().default(false).description('Tavily（需 keys.tavily 或 TAVILY_API_KEY）'),
    brave: z.boolean().default(false).description('Brave（需 key）'),
    serper: z.boolean().default(false).description('Serper（需 key）'),
    exa: z.boolean().default(false).description('Exa（需 key）'),
  })
  : undefined

const verticals = z
  ? z.object({
    github: z.boolean().default(true),
    arxiv: z.boolean().default(true),
    stackexchange: z.boolean().default(true),
    npm: z.boolean().default(true),
    hn: z.boolean().default(true),
    pypi: z.boolean().default(true),
  })
  : undefined

const cache = z
  ? z.object({
    enabled: z.boolean().default(true).description('同一问题在 TTL 内复用简报'),
    ttlMinutes: z.natural().default(60).description('缓存有效期（分钟）'),
    maxEntries: z.natural().default(16).description('缓存条目上限'),
    persistPath: z.string().default('').description('缓存落盘路径（留空=只放内存；相对路径相对 workspace）'),
    persistDebounceMs: z.natural().default(500).description('落盘防抖（毫秒），0=立即写'),
  })
  : undefined

const domainTrust = z
  ? z.object({
    trusted: z.array(z.string()).default([]).description('额外信任的域名（按 host 匹配）'),
    blocked: z.array(z.string()).default([]).description('直接丢弃的域名'),
  })
  : undefined

/** Settings form schema: every key validateConfig understands, all optional. */
export const Config = z
  ? z.object({
    enabled: z.boolean().default(true).description('启用 research 工具与调研协议（关闭后模型看不到该工具）'),
    depthDefault: z.string().default('auto').volatile().description('默认研究深度：auto / quick / standard / deep（改动即时生效）'),
    material: z.string().default('').description('研究材料：在设置页粘贴原文（≤20000 字），下次 research 调用自动作为最高优先级证据；随时可清空'),
    maxDeepPerSession: z.natural().default(5).description('每个 agent 每次会话最多跑几次 deep'),
    timeoutMs: z.natural().default(120000).description('单次研究墙钟（毫秒），实际取 max(该值, deep 300s) + 20s'),
    pageFetcher: z.string().default('raw').description('正文抓取方式：raw（自带 HTTP）/ web（宿主 web.fetch）/ auto'),
    useJinaFallback: z.boolean().default(false).description('JS 壳页面用 r.jina.ai 兜底'),
    verboseLog: z.boolean().default(false).description('输出调试日志'),
    debugStats: z.boolean().default(false).description('简报末尾附「检索统计」便于排查'),
    engines: engines ? engines.default({}) : undefined,
    keys: z.dict(z.string()).default({}).description('付费引擎 API key（也可用环境变量）'),
    verticals: verticals ? verticals.default({}) : undefined,
    cache: cache ? cache.default({}) : undefined,
    domainTrust: domainTrust ? domainTrust.default({}) : undefined,
  })
  : undefined