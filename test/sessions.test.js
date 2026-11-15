import test from 'node:test'
import assert from 'node:assert/strict'
import { ResearchSessions } from '../lib/sessions.js'

test('create returns an opaque id and get returns the stored payload', () => {
  const now = () => 1000
  const sessions = new ResearchSessions({ now })
  const payload = { pages: [{ url: 'https://a.com/1' }], clusters: [] }
  const id = sessions.create(payload)
  assert.match(id, /^rs_[0-9a-f]{16}$/)
  assert.equal(sessions.get(id), payload)
 })

test('an expired session is dropped on read', () => {
  let clock = 0
  const sessions = new ResearchSessions({ ttlMs: 60_000, now: () => clock })
  const id = sessions.create({ pages: [] })
  clock = 59_000
  assert.deepEqual(sessions.get(id), { pages: [] })
  clock = 61_000
  assert.equal(sessions.get(id), undefined)
  assert.equal(sessions.size, 0)
})

test('oldest session is evicted past maxEntries', () => {
  let clock = 0
  const sessions = new ResearchSessions({ maxEntries: 2, now: () => clock })
  const first = sessions.create({ pages: [{ url: 'a' }] })
  clock += 1
  const second = sessions.create({ pages: [{ url: 'b' }] })
  clock += 1
  const third = sessions.create({ pages: [{ url: 'c' }] })
  assert.equal(sessions.get(first), undefined)
  assert.deepEqual(sessions.get(second), { pages: [{ url: 'b' }] })
  assert.deepEqual(sessions.get(third), { pages: [{ url: 'c' }] })
  assert.equal(sessions.size, 2)
})

test('ageMs reports the age and delete/clear remove entries', () => {
  let clock = 5_000
  const sessions = new ResearchSessions({ now: () => clock })
  const id = sessions.create({ pages: [] })
  clock = 9_000
  assert.equal(sessions.ageMs(id), 4_000)
  sessions.delete(id)
  assert.equal(sessions.ageMs(id), undefined)
  const other = sessions.create({ pages: [] })
  sessions.clear()
  assert.equal(sessions.size, 0)
  assert.equal(sessions.get(other), undefined)
})