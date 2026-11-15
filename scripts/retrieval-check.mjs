#!/usr/bin/env node
/**
 * Retrieval regression check (0.8.0).
 *
 * Why this exists: `scripts/e2e-real.mjs` proves the pipeline can finish on the
 * wire, but it never says *what* it selected, so a ranking/selection regression
 * ("five repo hits and one doc page again") only shows up in a full 2-minute
 * research run that also costs an LLM. This script runs the same real
 * engines/real page fetcher through `runResearch` with a fake model, so the
 * only variable is retrieval and page selection:
 *
 *   node scripts/retrieval-check.mjs --question "<问题>" [--focus "a,b"] \
 *     [--depth standard] [--json]
 *
 * It prints the funnel's four numbers (identified / deduped / readable /
 * adopted), the adopted sources per `sourceTier(url)` bucket, vertical hits and
 * the first 10 adopted URLs. Exit code 1 means "adopted 0 sources": retrieval
 * produced nothing usable, which is the only hard regression signal that does
 * not depend on the model.
 *
 * No network is needed for the unit tests (`test/retrieval-check.test.js`):
 * they import only the pure functions below.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { validateConfig } from '../lib/config.js'
import { createEngines, createRawFetcher } from '../lib/engines.js'
import { createPageFetcher } from '../lib/fetch.js'
import { runResearch } from '../lib/pipeline.js'
import { sourceTier } from '../lib/util.js'

export const VERSION = '0.9.6'
export const DEPTHS = ['auto', 'quick', 'standard', 'deep']
// 0.8.1 — the caller normally passes `mode`, and it decides the strategy pack
// (compare ⇒ tech-selection ⇒ official-docs channels). Without a way to pass it,
// a script run always landed on the concept pack and could never exercise the
// official-query path the real reports come from.
export const MODES = ['explain', 'compare', 'track', 'evaluate']
/** DSH's desktop profile patch; the plugin's own keys live in its `config.keys`. */
export const PROFILE_PATCH = join(process.env.USERPROFILE ?? homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml')

/** Fixed brief for the fake model: cites up to S10 so 采用 tracks the selected pages. */
const SYNTH_BRIEF = [
  '## 结论',
  '这是 0.8.0 检索回归自检的固定简报，只用于让「采用」落在本轮真实选出的页面上，不判断内容质量。[S1][S2][S3][S4][S5][S6][S7][S8][S9][S10]',
  '',
  '## 依据',
  '- 固定证据 1 [S1]',
  '- 固定证据 2 [S2]',
  '- 固定证据 3 [S3]',
  '',
  '## 方案对比',
  '不适用。',
  '',
  '## 坑与风险',
  '未发现。',
  '',
  '## 置信度',
  'low：自检用假模型，不评估真实性。',
  '',
  '## 未解决',
  '无。',
].join('\n')

/** Fake model reply for one prompt. Order matters: the synthesis prompt also contains 证据. */
export function fakeReply(prompt, question = '') {
  const text = String(prompt ?? '')
  if (text.includes('检索计划')) {
    return JSON.stringify({ queries: [{ q: question, kind: 'semantic' }], directUrls: [] })
  }
  if (text.includes('拆解')) {
    // `criteria` is left out on purpose: normalizeAnalysis then falls back to the
    // caller's focus, so the compare-coverage computation sees the real dimensions.
    return JSON.stringify({ subQuestions: [{ q: question, why: '回归自检固定子问题', evidence: 'web' }], constraints: [], language: 'zh' })
  }
  if (text.includes('研究简报')) return SYNTH_BRIEF
  if (text.includes('证据')) return '[]'
  return SYNTH_BRIEF
}

/**
 * Fake LLM client (the `llm` argument of runResearch). It speaks the same
 * streaming shape as the real ctx.llm.stream because lib/llm.js only consumes
 * `stream()`; there is no `call(prompt)` entry point in the pipeline.
 */
export function fakeLlm(question) {
  return {
    stream(options) {
      const prompt = options?.messages?.[0]?.content?.[0]?.text ?? ''
      const reply = fakeReply(prompt, question)
      return (async function* emit() {
        yield { type: 'text-delta', text: reply }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
}

/**
 * Pull the tavily key out of the profile patch's `keys:` block.
 *
 * The live profile writes `keys:\n  tavily: tvly-...` (unquoted), so both
 * quoted and bare values are accepted; `tavily: true` under `engines:` is not
 * in a `keys:` block and is therefore never mistaken for a key.
 */
export function tavilyKeyFromPatch(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const head = /^(\s*)keys:\s*(.*)$/.exec(lines[index])
    if (!head) continue
    const inline = /tavily:\s*(?:"([^"]+)"|'([^']+)'|([^\s#"']+))/.exec(head[2] ?? '')
    if (inline) return (inline[1] ?? inline[2] ?? inline[3]).trim() || undefined
    const indent = head[1].length
    for (let next = index + 1; next < lines.length; next += 1) {
      const line = lines[next]
      if (!line.trim() || /^\s*#/.test(line)) continue
      const lineIndent = /^(\s*)/.exec(line)[1].length
      if (lineIndent <= indent) break
      const match = /^\s*tavily:\s*(?:"([^"]+)"|'([^']+)'|([^\s#]+))/.exec(line)
      if (match) return (match[1] ?? match[2] ?? match[3]).trim() || undefined
    }
  }
  return undefined
}

/** `TAVILY_API_KEY` first, then the desktop profile's `keys.tavily`. Never prints the key. */
export function resolveTavilyKey({ env = process.env, patchPath = PROFILE_PATCH, readFile = readFileSync } = {}) {
  const fromEnv = String(env.TAVILY_API_KEY ?? '').trim()
  if (fromEnv) return { key: fromEnv, source: 'env' }
  try {
    const text = readFile(patchPath, 'utf8')
    const key = tavilyKeyFromPatch(text)
    if (key) return { key, source: 'profile' }
  } catch {
    // No profile patch on this machine: ddg-html alone has to carry the run.
  }
  return { key: undefined, source: 'missing' }
}

/**
 * Turn the pipeline's adopted sources + stats into the regression numbers.
 *
 * `tiers` counts every adopted source by `sourceTier(url)`; `buckets` folds
 * those into the three numbers the CLI reports (docPage / repoCode / other) so
 * "the ranking returned five repo files and one doc page" is visible at a
 * glance. `adopted` comes from the source list itself — the same list the
 * brief's 参考 section prints — falling back to `stats.adopted` only when the
 * caller has no source objects.
 */
export function summarize(sources = [], stats = {}) {
  const list = (Array.isArray(sources) ? sources : []).filter(Boolean)
  const tiers = { 'doc-page': 0, 'doc-index': 0, 'repo-doc': 0, 'repo-code': 0, forum: 0, blog: 0, other: 0 }
  for (const source of list) {
    const url = typeof source === 'string' ? source : source?.url
    const tier = sourceTier(url)
    tiers[tier] = (tiers[tier] ?? 0) + 1
  }
  const adopted = list.length > 0 ? list.length : Number(stats.adopted ?? 0) || 0
  const docPage = tiers['doc-page']
  const repoCode = tiers['repo-code']
  return {
    identified: Number(stats.identified ?? 0) || 0,
    deduped: Number(stats.deduped ?? 0) || 0,
    readable: Number(stats.readable ?? 0) || 0,
    adopted,
    tiers,
    buckets: { docPage, repoCode, other: Math.max(0, adopted - docPage - repoCode) },
    top: list.slice(0, 10).map((source) => ({
      url: typeof source === 'string' ? source : String(source?.url ?? ''),
      tier: sourceTier(typeof source === 'string' ? source : source?.url),
    })),
  }
}

/** 0 is a pass; 1 means the run adopted no source at all. */
export function exitCodeFor(summary) {
  return (Number(summary?.adopted ?? 0) || 0) < 1 ? 1 : 0
}

/** Hand-rolled flag parser: `--flag value` and `--flag=value` both work. */
export function parseArgs(argv = []) {
  const options = { question: '', focus: [], depth: 'standard', mode: '', json: false }
  const take = (index, inline) => (inline !== undefined ? [inline, index] : [argv[index + 1], index + 1])
  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index] ?? '')
    const [name, inline = undefined] = arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined]
    if (name === '--json') { options.json = true; continue }
    if (name === '--question') {
      const [value, next] = take(index, inline)
      options.question = String(value ?? '').trim()
      index = next
    } else if (name === '--focus') {
      const [value, next] = take(index, inline)
      options.focus = String(value ?? '').split(',').map((item) => item.trim()).filter(Boolean).slice(0, 6)
      index = next
    } else if (name === '--depth') {
      const [value, next] = take(index, inline)
      options.depth = String(value ?? '').trim() || 'standard'
      index = next
    } else if (name === '--mode') {
      const [value, next] = take(index, inline)
      options.mode = String(value ?? '').trim()
      index = next
    } else if (name === '--help' || name === '-h') {
      options.help = true
    }
  }
  return options
}

export function usage() {
  return [
    `retrieval-check ${VERSION} — 真实检索/选页回归自检（不需要 LLM 的 2 分钟研究）`,
    '',
    '用法：',
    '  node scripts/retrieval-check.mjs --question "<问题>" [--focus "a,b"] [--depth standard] [--json]',
    '',
    '  --question  必填。研究问题（原样交给引擎）',
    '  --focus     可选。逗号分隔的评估维度',
    '  --depth     quick | standard | deep（默认 standard）',
    '  --mode      explain | compare | track | evaluate（可不传：0.8.2 起由 classify 决定，选型/对比题会自动走 compare → tech-selection 包；0.8.3 起价格题走 pricing 包，不再进 official-docs）',
    '  --json      只把 JSON 打到 stdout（日志仍在 stderr）',
    '',
    '退出码：0 = 至少采用 1 条来源；1 = 采用 0 条（检索退化）或运行失败。',
  ].join('\n')
}

async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(usage())
    return 0
  }

  const options = parseArgs(argv)
  if (!options.question) {
    console.error(usage())
    return 2
  }
  if (!DEPTHS.includes(options.depth)) {
    console.error(`--depth 只能是 ${DEPTHS.join(' / ')}，收到 ${options.depth}`)
    return 2
  }
  if (options.mode && !MODES.includes(options.mode)) {
    console.error(`--mode 只能是 ${MODES.join(' / ')}，收到 ${options.mode}`)
    return 2
  }

  const tkey = resolveTavilyKey()
  if (!tkey.key) {
    console.error(`[retrieval-check] 未取到 tavily key（TAVILY_API_KEY 与 ${PROFILE_PATCH} 的 keys.tavily 都没有）：只用 ddg-html，若它被 DuckDuckGo 拦截本次检索会失败。`)
  }

  // Real config normalisation, real engines, real page fetcher: only the model
  // and the host's ctx.web are replaced. No `web` means ctx-web stays out and
  // retrieval is exactly what a machine without a host search tool would see.
  const { config } = validateConfig({
    enabled: true,
    pageFetcher: 'raw',
    keys: tkey.key ? { tavily: tkey.key } : {},
    engines: {
      ctxWeb: false,
      ddgHtml: true,
      tavily: Boolean(tkey.key),
      brave: false,
      serper: false,
      exa: false,
    },
  })
  const fetchRaw = createRawFetcher()
  const engines = createEngines({ config, web: null, fetchRaw })
  const fetchPage = createPageFetcher({ config, fetchRaw, logger: console.error })
  if (engines.length === 0) {
    console.error('[retrieval-check] 没有可用引擎：至少保留 ddg-html，或配置 tavily key。')
    return 1
  }

  const startedAt = Date.now()
  let result
  try {
    result = await runResearch({
      question: options.question,
      focus: options.focus,
      depth: options.depth,
      mode: options.mode || undefined,
      config: { ...config, __engines: engines, __fetchPage: fetchPage, __fetchRaw: fetchRaw },
      web: undefined,
      llm: fakeLlm(options.question),
      selection: { provider: 'retrieval-check', model: 'retrieval-check-fake-llm' },
      logger: console.error,
      signal: AbortSignal.timeout(300000),
    })
  } catch (error) {
    const message = error?.message ?? String(error)
    if (options.json) {
      console.log(JSON.stringify({ ok: false, version: VERSION, question: options.question, depth: options.depth, tavilyKeySource: tkey.source, error: message }, null, 2))
    } else {
      console.error(`[retrieval-check] FAIL：${message}`)
      if (!tkey.key) console.error('[retrieval-check] 提示：没有 tavily key 时仅 ddg-html 可用，DuckDuckGo 拦爬虫就会整轮无结果。')
    }
    return 1
  }

  const stats = result.stats ?? {}
  const summary = summarize(result.sources, stats)
  const code = exitCodeFor(summary)
  const elapsedMs = Date.now() - startedAt
  const engineNames = engines.map((engine) => engine.name)

  if (options.json) {
    console.log(JSON.stringify({
      ok: code === 0,
      version: VERSION,
      question: options.question,
      focus: options.focus,
      depth: result.depthUsed ?? options.depth,
      mode: stats.mode ?? options.mode ?? 'explain',
      engines: engineNames,
      tavilyKeySource: tkey.source,
      elapsedMs,
      summary,
      stats: {
        identified: summary.identified,
        deduped: summary.deduped,
        readable: summary.readable,
        adopted: summary.adopted,
        queries: stats.queries ?? 0,
        queriesByKind: stats.queriesByKind ?? {},
        verticals: stats.verticals ?? [],
        verticalHits: stats.verticalHits ?? 0,
        verticalsByEngine: stats.verticalsByEngine ?? {},
        engineErrors: stats.engineErrors ?? 0,
        clusters: stats.clusters ?? 0,
        officialAdopted: stats.officialAdopted ?? 0,
        timings: stats.timings ?? {},
      },
    }, null, 2))
    return code
  }

  const lines = [
    `retrieval-check ${VERSION} · ${new Date().toISOString()}`,
    `question: ${options.question}`,
    `focus: ${options.focus.length > 0 ? options.focus.join('、') : '未指定'} · depth: ${result.depthUsed ?? options.depth} · mode: ${stats.mode ?? options.mode ?? 'explain'}${options.mode ? '' : '（classify 推定）'}`,
    `engines: ${engineNames.join(',')}${tkey.source === 'profile' ? '（tavily key 来自 profile patch）' : tkey.source === 'env' ? '（tavily key 来自 TAVILY_API_KEY）' : '（只跑了 ddg-html）'}`,
    '',
    `identified ${summary.identified} · deduped ${summary.deduped} · readable ${summary.readable} · adopted ${summary.adopted}`,
    `adopted tiers: docPage ${summary.buckets.docPage} · repoCode ${summary.buckets.repoCode} · other ${summary.buckets.other}  (doc-index ${summary.tiers['doc-index']} / repo-doc ${summary.tiers['repo-doc']} / forum ${summary.tiers.forum} / blog ${summary.tiers.blog} / other ${summary.tiers.other})`,
    `verticals: ${stats.verticals?.length ? stats.verticals.join(',') : '(none)'} · 垂直源命中 ${stats.verticalHits ?? 0}`,
    `queries: ${stats.queries ?? 0}${stats.queriesByKind ? `（语义 ${stats.queriesByKind.semantic ?? 0} / 技术 ${stats.queriesByKind.technical ?? 0} / 官方 ${stats.queriesByKind.official ?? 0}）` : ''} · engineErrors ${stats.engineErrors ?? 0} · clusters ${stats.clusters ?? 0}`,
    '',
  ]
  if (summary.top.length > 0) {
    lines.push(`前 ${summary.top.length} 条采用来源：`)
    summary.top.forEach((item, index) => {
      lines.push(`  ${String(index + 1).padStart(2)}. [${item.tier}] ${item.url}`)
    })
  } else {
    lines.push('前 10 条采用来源：（无）')
  }
  lines.push('', `elapsed ${(elapsedMs / 1000).toFixed(1)}s`)
  if (code !== 0) {
    lines.push('', 'RESULT: FAIL（采用 0 条：检索或选页退化，或引擎全部被拦截）')
  } else {
    lines.push('', `RESULT: PASS（docPage ${summary.buckets.docPage} · repoCode ${summary.buckets.repoCode} · other ${summary.buckets.other}）`)
  }
  console.log(lines.join('\n'))
  return code
}

const invokedDirectly = Boolean(process.argv[1])
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href

if (invokedDirectly) {
  main().then((code) => {
    process.exitCode = code
  }).catch((error) => {
    const message = error?.message ?? String(error)
    if (process.argv.includes('--json')) console.log(JSON.stringify({ ok: false, version: VERSION, error: message }, null, 2))
    else console.error(`[retrieval-check] FAIL：${message}`)
    process.exitCode = 1
  })
}