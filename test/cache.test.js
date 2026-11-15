import test from 'node:test'
import assert from 'node:assert/strict'
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