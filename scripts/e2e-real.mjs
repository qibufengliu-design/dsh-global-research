#!/usr/bin/env node
/**
 * Real-network end-to-end smoke test.
 *
 * The unit tests fake engines, page fetches and the model, so they can never
 * catch the failures that only appear on the wire: DuckDuckGo blocking the
 * scraper, a docs page returning a JS shell instead of text, the citation
 * pipeline choking on real snippets. This script wires the real engines
 * (`lib/engines.js`), the real page fetcher (`lib/fetch.js`) and the real
 * `fetch` into `runResearch`, and only fakes the LLM (the one dependency that
 * costs money and needs a provider).
 *
 * It needs the network, so it is NOT part of the default test run:
 *
 *   RUN_REAL=1 TAVILY_API_KEY=... node scripts/e2e-real.mjs
 *
 * Without `RUN_REAL=1` it prints `skipped (set RUN_REAL=1)` and exits 0.
 * Tavily is optional; without `TAVILY_API_KEY` it is skipped and the free
 * DuckDuckGo HTML engine carries the search.
 */
import assert from 'node:assert/strict'

import { validateConfig } from '../lib/config.js'
import { createEngines, createRawFetcher } from '../lib/engines.js'
import { createPageFetcher } from '../lib/fetch.js'
import { runResearch } from '../lib/pipeline.js'

const QUESTION = 'React 19 的 use() 和 useEffect 在数据获取上的区别'
const SYNTH_BRIEF = [
  '## 结论',
  'React 19 中 use() 直接读取缓存过的 Promise，把加载/错误交给最近的 Suspense 边界；useEffect 仍是通用副作用钩子，在其中手动请求需要自己管理 loading、错误与竞态。[S1]',
  '',
  '## 依据',
  '- use() 在渲染期读取 Promise，挂起时由 Suspense 接管（[S1]）。',
  '- useEffect 在提交后执行请求，React 不会在渲染期等待它，取消与依赖都要自行处理（[S1]）。',
  '',
  '## 方案对比',
  '不适用。',
  '',
  '## 坑与风险',
  '- 每次渲染都新建 Promise 会反复挂起，必须缓存 Promise 或交给框架的数据层。',
  '',
  '## 置信度',
  'medium：结论来自官方文档页面，本次为快速档抽检。',
  '',
  '## 未解决',
  '- 未逐一核对 React 19 迁移指南中的全部边界情况。',
].join('\n')

const verbose = process.env.E2E_VERBOSE === '1'
const logger = verbose ? (message) => console.error(`[e2e] ${message}`) : () => {}

/**
 * Fake model. Answer shapes have to be good enough for the real pipeline:
 * the planner must produce ≥2 queries, evidence quotes must be literal slices
 * of the fetched page text (otherwise `isGrounded` rightly rejects them), and
 * the synthesis must look like a finished brief so no truncation retry fires.
 */
function fakeLlm() {
  return {
    stream(options) {
      const prompt = options.messages?.[0]?.content?.[0]?.text ?? ''
      let text
      if (prompt.includes('<untrusted>')) text = evidenceReply(prompt)
      // Check synthesis before the gap prompt: the synthesis prompt also talks
      // about 缺口 in its style rules, so a loose match would hijack it.
      else if (prompt.includes('研究简报')) text = SYNTH_BRIEF
      else if (prompt.includes('检索规划员')) {
        text = JSON.stringify({
          queries: [QUESTION, 'React 19 use() vs useEffect data fetching'],
          directUrls: [],
          reason: '中文问题 + 英文官方文档检索',
        })
      } else if (prompt.includes('拆解')) {
        text = JSON.stringify({
          subQuestions: [
            { q: 'React 19 的 use() 在数据获取时如何配合 Suspense？', why: '确认新 API 的定位', evidence: 'docs' },
            { q: 'useEffect 获取数据在 React 19 里还有哪些适用场景？', why: '区分两者边界', evidence: 'docs' },
          ],
          constraints: ['需要能区分两者适用场景'],
          criteria: ['官方文档依据'],
          language: 'zh',
        })
      } else if (prompt.includes('当前缺口')) {
        text = JSON.stringify({ queries: [], reason: '快速档不做补缺' })
      } else {
        text = '{}'
      }
      return (async function* emit() {
        yield { type: 'text-delta', text }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
}

function evidenceReply(prompt) {
  const blocks = [...prompt.matchAll(/\[页面 (\d+)\][^\n]*\n<untrusted>\n([\s\S]*?)\n<\/untrusted>/g)]
  const items = []
  for (const [, index, raw] of blocks) {
    const text = String(raw ?? '').replace(/\s+/g, ' ').trim()
    if (text.length < 40) continue
    items.push({
      claim: `页面 ${index} 记载了 React 19 中 use() 与 useEffect 在数据获取上的分工`,
      // Literal prefix of the normalized page text: the pipeline masks only
      // whitespace/punctuation, so this stays grounded without guessing.
      quote: text.slice(0, 120),
      source: Number(index),
      type: 'docs',
      stance: 'neutral',
    })
  }
  return JSON.stringify(items)
}

if (process.env.RUN_REAL !== '1') {
  console.log('skipped (set RUN_REAL=1)')
  process.exit(0)
}

const hasTavily = Boolean(process.env.TAVILY_API_KEY?.trim())
if (!hasTavily) logger('TAVILY_API_KEY not set: skipping tavily, falling back to ddg-html')

try {
  const { config } = validateConfig({
    enabled: true,
    pageFetcher: 'raw',
    verboseLog: verbose,
    engines: {
      ctxWeb: false,
      ddgHtml: true,
      tavily: hasTavily,
      brave: false,
      serper: false,
      exa: false,
    },
  })

  const fetchRaw = createRawFetcher()
  const engines = createEngines({ config, web: null, fetchRaw })
  const fetchPage = createPageFetcher({ config, web: null, fetchRaw, logger })
  assert.ok(engines.length > 0, 'no search engine available: set TAVILY_API_KEY or allow ddg-html')

  const result = await runResearch({
    question: QUESTION,
    focus: [],
    depth: 'quick',
    mode: 'explain',
    config: { ...config, __engines: engines, __fetchPage: fetchPage, __fetchRaw: fetchRaw },
    llm: fakeLlm(),
    selection: { provider: 'e2e-real', model: 'e2e-fake-llm' },
    logger,
    signal: AbortSignal.timeout(180000),
  })

  const stats = result.stats ?? {}
  assert.ok(stats.queries >= 2, `expected ≥2 queries, got ${stats.queries}`)
  assert.ok(stats.pagesFetched >= 1, `expected ≥1 fetched page, got ${stats.pagesFetched}`)
  assert.match(result.brief, /## 参考/, 'brief is missing the 参考 section')
  assert.match(result.brief, /^>\s*本次检索：/m, 'brief is missing the run-stats line')

  const elapsed = ((stats.elapsedMs ?? 0) / 1000).toFixed(1)
  console.log(`PASS e2e-real: queries=${stats.queries} pages=${stats.pagesFetched} clusters=${stats.clusters} sources=${result.sources.length} engine=${stats.engines.join(',') || 'none'} verticals=${stats.verticals.join(',') || 'none'} elapsed=${elapsed}s`)
  if (verbose) {
    console.error(`[e2e] timings=${JSON.stringify(stats.timings)} confidence=${result.confidence} partial=${result.partial}`)
    console.error(result.brief)
  }
} catch (error) {
  console.error(`FAIL e2e-real: ${error?.message ?? error}`)
  if (verbose && error?.stack) console.error(error.stack)
  process.exitCode = 1
}