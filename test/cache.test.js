import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ResearchCache, cacheKey } from '../lib/cache.js'

test('cacheKey ignores whitespace, case and focus order but keeps focus content', () => {
  const base = cacheKey({ question: '  Node 22 LTS?  ', depth: 'standard', focus: ['迁移成本', '稳定性'] })
  assert.equal(base, cacheKey({ question: 'node 22 lts?', depth: 'standard', focus: ['稳定性', '迁移成本'] }))
  assert.notEqual(base, cacheKey({ question: 'node 22 lts?', depth: 'standard', focus: ['稳定性'] }))
  assert.notEqual(base, cacheKey({ question: 'node 22 lts?', depth: 'deep', focus: ['稳定性', '迁移成本'] }))
  assert.notEqual(base, cacheKey({ question: 'node 24 lts?', depth: 'standard', focus: ['稳定性', '迁移成本'] }))
})

test('cacheKey separates modes so one question cannot reuse another mode brief', () => {
  const question = 'Node 22 还是 24？'
  const explain = cacheKey({ question, depth: 'standard', mode: 'explain' })
  assert.notEqual(explain, cacheKey({ question, depth: 'standard', mode: 'compare' }))
  assert.notEqual(explain, cacheKey({ question, depth: 'standard', mode: 'track' }))
  assert.notEqual(explain, cacheKey({ question, depth: 'standard', mode: 'evaluate' }))
  // An illegal mode is normalised, so it shares the explain entry instead of
  // creating a stray key that would return a differently shaped brief.
  assert.equal(explain, cacheKey({ question, depth: 'standard', mode: 'nonsense' }))
  // Omitting mode means the default, which is explain.
  assert.equal(explain, cacheKey({ question, depth: 'standard' }))
  // Optional classifier keys only participate when provided.
  assert.equal(explain, cacheKey({ question, depth: 'standard', questionKind: undefined, signalVersion: undefined }))
  assert.notEqual(explain, cacheKey({ question, depth: 'standard', questionKind: 'legal' }))
  assert.notEqual(explain, cacheKey({ question, depth: 'standard', signalVersion: 2 }))
})

test('cache returns a value until the ttl expires', () => {
  let now = 1000
  const cache = new ResearchCache({ maxEntries: 4, ttlMs: 5000, now: () => now })
  cache.set('a', { brief: 'x' })
  assert.deepEqual(cache.get('a'), { brief: 'x' })
  now += 4999
  assert.deepEqual(cache.get('a'), { brief: 'x' })
  now += 2
  assert.equal(cache.get('a'), undefined)
  assert.equal(cache.size, 0, 'expired entries are dropped on read')
})

test('cache evicts the least recently used entry when full', () => {
  const cache = new ResearchCache({ maxEntries: 2, ttlMs: 60000 })
  cache.set('a', 1)
  cache.set('b', 2)
  cache.get('a') // refresh a, so b becomes the oldest
  cache.set('c', 3)
  assert.equal(cache.size, 2)
  assert.equal(cache.get('b'), undefined)
  assert.equal(cache.get('a'), 1)
  assert.equal(cache.get('c'), 3)
})

test('ageMs reports how old an entry is', () => {
  let now = 1000
  const cache = new ResearchCache({ ttlMs: 60000, now: () => now })
  cache.set('k', 'v')
  now += 1234
  assert.equal(cache.ageMs('k'), 1234)
  assert.equal(cache.ageMs('missing'), undefined)
})

test('clear empties the cache', () => {
  const cache = new ResearchCache()
  cache.set('a', 1)
  cache.clear()
  assert.equal(cache.size, 0)
})

test('cacheKey keeps user-provided text so different material never shares a brief', () => {
  const question = 'Node 22 支持到什么时候'
  const plain = cacheKey({ question, depth: 'quick' })
  const withText = cacheKey({ question, depth: 'quick', text: 'Node 22 支持到 2027 年 4 月。' })
  assert.notEqual(plain, withText, 'provided text must change the key')
  // Formatting noise should not fragment the cache.
  assert.equal(
    withText,
    cacheKey({ question, depth: 'quick', text: '  Node 22   支持到 2027 年 4 月。 ' }),
  )
  assert.notEqual(withText, cacheKey({ question, depth: 'quick', text: 'Node 22 支持到 2026 年 4 月。' }))
})

// 0.7.1 — opt-in persistence. These tests own a temp directory so the real
// workspace is never written to.
async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-research-cache-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('cache snapshot is written atomically and can be read back by a new instance', async () => {
  await withTempDir(async (dir) => {
    const persistPath = join(dir, 'nested', 'cache.json')
    const now = () => 1_000_000
    const first = new ResearchCache({ persistPath, debounceMs: 0, now, ttlMs: 60_000 })
    first.set('k1', { brief: 'hello' })
    first.set('k2', { brief: 'world' })
    await first.flush()
    assert.ok(existsSync(persistPath), 'snapshot exists after flush')
    const parsed = JSON.parse(readFileSync(persistPath, 'utf8'))
    assert.equal(parsed.version, 1)
    assert.equal(parsed.entries.length, 2, 'no temp file is left behind, both entries are in the snapshot')
    assert.deepEqual(parsed.entries.map((entry) => entry.key), ['k1', 'k2'])

    const second = new ResearchCache({ persistPath, debounceMs: 0, now, ttlMs: 60_000 })
    assert.equal(second.load(), 2)
    assert.deepEqual(second.get('k1'), { brief: 'hello' })
    assert.deepEqual(second.get('k2'), { brief: 'world' })
  })
})

test('expired entries in a snapshot are not restored', async () => {
  await withTempDir(async (dir) => {
    const persistPath = join(dir, 'cache.json')
    const writer = new ResearchCache({ persistPath, debounceMs: 0, now: () => 1_000, ttlMs: 5_000 })
    writer.set('old', { brief: 'stale' })
    await writer.flush()

    const reader = new ResearchCache({ persistPath, debounceMs: 0, now: () => 10_000, ttlMs: 5_000 })
    assert.equal(reader.load(), 0)
    assert.equal(reader.size, 0)
    assert.equal(reader.get('old'), undefined)
  })
})

test('an empty persist path never touches the filesystem', async () => {
  await withTempDir(async (dir) => {
    const cache = new ResearchCache({ persistPath: '', now: () => 1_000 })
    assert.equal(cache.persistPath, '')
    cache.set('a', 1)
    assert.equal(cache.timer, null, 'no debounce timer is scheduled without a path')
    await cache.flush()
    assert.deepEqual(readdirSync(dir), [], 'nothing is written next to the process')
    assert.equal(cache.load(), 0, 'load() is a no-op without a path')
    assert.equal(cache.size, 1, 'the in-memory entry still works')
  })
})

test('a corrupt snapshot is reported and treated as an empty cache', async () => {
  await withTempDir(async (dir) => {
    const persistPath = join(dir, 'cache.json')
    writeFileSync(persistPath, '{not json', 'utf8')
    const errors = []
    const cache = new ResearchCache({ persistPath, onError: (error) => errors.push(error) })
    assert.equal(cache.load(), 0)
    assert.equal(cache.size, 0)
    assert.equal(errors.length, 1)
  })
})
