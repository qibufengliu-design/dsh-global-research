/**
 * Shared real-harness plumbing for the `scripts/*` health checks (1.1.0).
 *
 * Why this exists: `retrieval-check.mjs` (0.8.0) and `eval.mjs` (1.1.0) both need
 * the exact same three things — a tavily key that may live in the desktop profile
 * patch, a *real* engine/page-fetcher pair built the way a real run builds it, and
 * a fake model client that speaks the streaming shape `lib/llm.js` consumes. The
 * first two used to be copy-pasted; they live here now so a fix to the key lookup
 * or to the engine list cannot land in one script and miss the other.
 *
 * Everything in this module is offline-safe: no import starts a run, nothing here
 * touches the network at import time. The unit tests
 * (`test/retrieval-check.test.js`, `test/eval.test.js`) import the pure helpers.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { validateConfig } from '../../lib/config.js'
import { createEngines, createRawFetcher } from '../../lib/engines.js'
import { createPageFetcher } from '../../lib/fetch.js'

/** DSH's desktop profile patch; the plugin's own keys live in its `config.keys`. */
export const PROFILE_PATCH = join(process.env.USERPROFILE ?? homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml')

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
 * Fake LLM client (the `llm` argument of `runResearch`) driven by one callback.
 *
 * `lib/llm.js` only consumes `stream()`, so the fake speaks exactly that shape:
 * one `text-delta` with the whole reply, then `finish`. `replyFor(prompt)` gets
 * the flattened first message text; callers decide per prompt (plan / analysis /
 * synthesis) what to answer.
 */
export function createFakeLlm(replyFor) {
  return {
    stream(options) {
      const prompt = options?.messages?.[0]?.content?.[0]?.text ?? ''
      const reply = replyFor(String(prompt ?? ''))
      return (async function* emit() {
        yield { type: 'text-delta', text: reply }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
}

/** Engine switches both scripts use: ddg-html always, tavily only when a key was found. */
export const ENGINE_DEFAULTS = Object.freeze({
  ctxWeb: false,
  ddgHtml: true,
  brave: false,
  serper: false,
  exa: false,
})

/**
 * Build the real (network) harness used by `retrieval-check.mjs` and
 * `eval.mjs --real`: validated config, raw fetcher, live engines, page fetcher.
 *
 * Returns the pieces so a caller can pass `__engines` / `__fetchPage` /
 * `__fetchRaw` into `runResearch`'s config and report which engines survived.
 * `logger` is only used by the page fetcher (it logs fetch failures).
 */
export function createRealHarness({ tavilyKey, logger = console.error } = {}) {
  const { config } = validateConfig({
    enabled: true,
    pageFetcher: 'raw',
    keys: tavilyKey ? { tavily: tavilyKey } : {},
    engines: { ...ENGINE_DEFAULTS, tavily: Boolean(tavilyKey) },
  })
  const fetchRaw = createRawFetcher()
  const engines = createEngines({ config, web: null, fetchRaw })
  const fetchPage = createPageFetcher({ config, fetchRaw, logger })
  return { config, fetchRaw, engines, fetchPage, engineNames: engines.map((engine) => engine.name) }
}