import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_CONFIG, validateConfig } from '../lib/config.js'

test('validateConfig fills defaults for an empty object', () => {
  const { config, warnings } = validateConfig({})
  assert.deepEqual(warnings, [])
  assert.equal(config.depthDefault, 'auto')
  assert.equal(config.pageFetcher, 'raw')
  assert.deepEqual(config.cache, DEFAULT_CONFIG.cache)
  assert.deepEqual(config.domainTrust, { trusted: [], blocked: [] })
})

test('validateConfig coerces booleans and numbers from the bundle patch', () => {
  const { config } = validateConfig({
    debugStats: 'true',
    verboseLog: 'false',
    timeoutMs: '45000',
    maxDeepPerSession: 2.6,
    cache: { enabled: 'false', ttlMinutes: '30', maxEntries: '8' },
  })
  assert.equal(config.debugStats, true)
  assert.equal(config.verboseLog, false)
  assert.equal(config.timeoutMs, 45000)
  assert.equal(config.maxDeepPerSession, 3)
  assert.deepEqual(config.cache, { enabled: false, ttlMinutes: 30, maxEntries: 8, persistPath: '', persistDebounceMs: 500 })
})

test('validateConfig keeps cache persistence opt-in and rejects bad path values', () => {
  const defaults = validateConfig({}).config.cache
  assert.equal(defaults.persistPath, '', 'persistence stays off unless the user asks for it')
  assert.equal(defaults.persistDebounceMs, 500)

  const { config, warnings } = validateConfig({ cache: { persistPath: '  .cache/research.json  ', persistDebounceMs: 0 } })
  assert.equal(config.cache.persistPath, '.cache/research.json')
  assert.equal(config.cache.persistDebounceMs, 0)

  const bad = validateConfig({ cache: { persistPath: 42, persistDebounceMs: 'soon' } })
  assert.equal(bad.config.cache.persistPath, '')
  assert.equal(bad.config.cache.persistDebounceMs, 500)
  assert.ok(bad.warnings.some((warning) => /cache\.persistPath/.test(warning)))
  assert.ok(bad.warnings.some((warning) => /cache\.persistDebounceMs/.test(warning)))
})

test('validateConfig clamps unsafe values instead of failing the tool', () => {
  const { config, warnings } = validateConfig({ timeoutMs: 1, maxDeepPerSession: -4, cache: { ttlMinutes: 0 } })
  assert.equal(config.timeoutMs, 5000)
  assert.equal(config.maxDeepPerSession, 0)
  assert.equal(config.cache.ttlMinutes, 1)
  assert.ok(warnings.length >= 3)
})

test('validateConfig reports invalid enums and unknown keys as warnings', () => {
  const { config, warnings } = validateConfig({
    depthDefault: 'thorough',
    pageFetcher: 'ftp',
    engines: { tavily: true, dggHtml: true },
    verticals: { pypi: false, stackoverflow: true },
    keys: { tavily: '', brave: 42 },
    mystery: 1,
  })
  assert.equal(config.depthDefault, 'auto')
  assert.equal(config.pageFetcher, 'raw')
  assert.equal(config.engines.tavily, true)
  assert.equal(config.engines.dggHtml, undefined, 'unknown engine keys are dropped')
  assert.equal(config.verticals.pypi, false)
  assert.equal(config.verticals.stackoverflow, undefined)
  assert.deepEqual(config.keys, {})
  assert.ok(warnings.some((warning) => /dggHtml/.test(warning)))
  assert.ok(warnings.some((warning) => /depthDefault/.test(warning)))
})

test('validateConfig normalizes domain lists from URLs and deduplicates', () => {
  const { config } = validateConfig({
    domainTrust: {
      trusted: ['https://Example.com/some/path', 'example.com', 'github.com'],
      blocked: ['spam.example.org'],
    },
  })
  assert.deepEqual(config.domainTrust.trusted, ['example.com', 'github.com'])
  assert.deepEqual(config.domainTrust.blocked, ['spam.example.org'])
})

test('validateConfig keeps per-engine quota overrides and enables the docs vertical', () => {
  const { config, warnings } = validateConfig({ quotaPerMonth: { tavily: 500, brave: '1000', bad: -1, worse: 'many' } })
  assert.equal(config.verticals.docs, true)
  assert.deepEqual(config.quotaPerMonth, { tavily: 500, brave: 1000 })
  assert.ok(warnings.some((warning) => /quotaPerMonth\.bad/.test(warning)))
  assert.ok(warnings.some((warning) => /quotaPerMonth\.worse/.test(warning)))
  assert.deepEqual(validateConfig({ quotaPerMonth: 'lots' }).config.quotaPerMonth, {})
})