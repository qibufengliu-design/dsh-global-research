import test from 'node:test'
import assert from 'node:assert/strict'
import { exitCodeFor, parseArgs, summarize, tavilyKeyFromPatch } from '../scripts/retrieval-check.mjs'

// No network here: only the pure helpers that decide what retrieval-check calls
// a regression. The script's main() is behind an import.meta.url guard, so
// importing it must not start a run.
const SOURCES = [
  { id: 'S1', url: 'https://docs.spring.io/spring-ai/reference/api/chatclient.html' },
  { id: 'S2', url: 'https://docs.langchain4j.dev/tutorials/rag/' },
  { id: 'S3', url: 'https://haystack.deepset.ai/docs/pipelines' },
  { id: 'S4', url: 'https://github.com/langchain4j/langchain4j/blob/main/langchain4j-core/src/main/java/dev/langchain4j/chain/Chain.java' },
  { id: 'S5', url: 'https://github.com/deepset-ai/haystack/blob/main/haystack/core/pipeline/pipeline.py' },
  { id: 'S6', url: 'https://stackoverflow.com/questions/76012345/spring-ai-rag' },
]

test('summarize buckets adopted sources by sourceTier and keeps the funnel numbers (0.8.0)', () => {
  const summary = summarize(SOURCES, { identified: 40, deduped: 31, readable: 14, adopted: 6 })
  assert.deepEqual(
    { identified: summary.identified, deduped: summary.deduped, readable: summary.readable, adopted: summary.adopted },
    { identified: 40, deduped: 31, readable: 14, adopted: 6 },
  )
  assert.deepEqual(summary.buckets, { docPage: 3, repoCode: 2, other: 1 })
  assert.equal(summary.tiers['doc-page'], 3)
  assert.equal(summary.tiers['repo-code'], 2)
  assert.equal(summary.tiers.forum, 1)
  assert.equal(summary.top.length, 6)
  assert.deepEqual(summary.top[0], { url: SOURCES[0].url, tier: 'doc-page' })
})

test('summarize falls back to stats.adopted and caps the URL list at ten (0.8.0)', () => {
  const empty = summarize([], { adopted: 0 })
  assert.equal(empty.adopted, 0)
  assert.deepEqual(empty.buckets, { docPage: 0, repoCode: 0, other: 0 })
  const many = Array.from({ length: 13 }, (_, index) => ({ url: `https://docs.spring.io/spring-ai/${index}/reference/api.html` }))
  const summary = summarize(many, { adopted: 13 })
  assert.equal(summary.top.length, 10)
  assert.equal(summary.adopted, 13)
})

test('exitCodeFor treats "adopted 0" as a regression (0.8.0)', () => {
  assert.equal(exitCodeFor(summarize(SOURCES, { adopted: 6 })), 0)
  assert.equal(exitCodeFor(summarize([], { adopted: 0 })), 1)
  assert.equal(exitCodeFor({ adopted: 0 }), 1)
  assert.equal(exitCodeFor(undefined), 1)
})

test('tavilyKeyFromPatch reads quoted and bare keys only from the keys block (0.8.0)', () => {
  assert.equal(tavilyKeyFromPatch('config:\n  keys:\n    tavily: "tvly-quoted"\n'), 'tvly-quoted')
  // The live desktop profile writes the value unquoted; a quote-only regex misses it.
  assert.equal(tavilyKeyFromPatch('config:\n  keys:\n    tavily: tvly-bare  \n  engines:\n    tavily: true\n'), 'tvly-bare')
  assert.equal(tavilyKeyFromPatch('config:\n  engines:\n    tavily: true\n'), undefined)
  assert.equal(tavilyKeyFromPatch('config:\r\n  keys:\r\n    brave: x\r\n'), undefined)
  assert.equal(tavilyKeyFromPatch(''), undefined)
})

test('parseArgs accepts "--flag value" and "--flag=value" (0.8.0)', () => {
  assert.deepEqual(parseArgs(['--question', 'q1', '--focus', 'a, b', '--depth', 'quick', '--json']), {
    question: 'q1', focus: ['a', 'b'], depth: 'quick', mode: '', json: true,
  })
  assert.equal(parseArgs(['--question=q2', '--depth=deep']).question, 'q2')
  assert.equal(parseArgs([]).depth, 'standard')
  // 0.8.1 — mode picks the strategy pack (compare ⇒ tech-selection).
  assert.equal(parseArgs(['--mode=compare']).mode, 'compare')
  assert.equal(parseArgs(['--mode', 'track']).mode, 'track')
  assert.equal(parseArgs([]).mode, '')
})