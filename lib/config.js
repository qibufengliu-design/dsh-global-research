/**
 * Config normalization. DSH passes the bundle patch's `config` object through
 * untouched, so a typo ("tavilyKey", "timeout: 120") would otherwise be
 * silently ignored. Everything here is defensive: invalid values fall back to
 * the default and are reported as warnings instead of failing the tool.
 */

export const DEFAULT_CONFIG = {
  enabled: true,
  depthDefault: 'auto',
  maxDeepPerSession: 5,
  engines: { ctxWeb: true, ddgHtml: true, tavily: false, brave: false, serper: false, exa: false },
  keys: {},
  verticals: { github: true, arxiv: true, stackexchange: true, npm: true, hn: true, pypi: true },
  pageFetcher: 'raw',
  useJinaFallback: false,
  timeoutMs: 120000,
  verboseLog: false,
  debugStats: false,
  cache: { enabled: true, ttlMinutes: 60, maxEntries: 16 },
  domainTrust: { trusted: [], blocked: [] },
}

const DEPTHS = ['auto', 'quick', 'standard', 'deep']
const FETCH_MODES = ['raw', 'web', 'auto']

function asBoolean(value, fallback, name, warnings) {
  if (value === undefined || value === null) return fallback
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  warnings.push(`${name} must be a boolean, got ${JSON.stringify(value)}; keeping ${fallback}`)
  return fallback
}

function asNumber(value, fallback, { min, max, name, integer = false }, warnings) {
  if (value === undefined || value === null) return fallback
  const number = Number(value)
  if (!Number.isFinite(number)) {
    warnings.push(`${name} must be a number, got ${JSON.stringify(value)}; keeping ${fallback}`)
    return fallback
  }
  let result = integer ? Math.round(number) : number
  if (result < min || result > max) {
    warnings.push(`${name} must be within [${min}, ${max}], got ${result}; clamping`)
    result = Math.min(max, Math.max(min, result))
  }
  return result
}

/** "https://Example.com/a/b" → "example.com" so hosts and URLs both work. */
function hostEntry(value) {
  return String(value).trim().toLowerCase().replace(/^[a-z]+:\/\//, '').split(/[/?#]/)[0]
}

function asHostList(value, name, warnings) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    warnings.push(`${name} must be an array of domains; ignoring ${JSON.stringify(value)}`)
    return []
  }
  return [...new Set(value.map(hostEntry).filter(Boolean))]
}

export function validateConfig(raw = {}) {
  const warnings = []
  const input = raw && typeof raw === 'object' ? raw : {}
  const config = { ...DEFAULT_CONFIG }

  config.enabled = asBoolean(input.enabled, DEFAULT_CONFIG.enabled, 'enabled', warnings)
  if (input.depthDefault !== undefined) {
    if (DEPTHS.includes(input.depthDefault)) config.depthDefault = input.depthDefault
    else warnings.push(`depthDefault must be one of ${DEPTHS.join('/')}; keeping auto`)
  }
  config.maxDeepPerSession = asNumber(input.maxDeepPerSession, DEFAULT_CONFIG.maxDeepPerSession, { min: 0, max: 20, integer: true, name: 'maxDeepPerSession' }, warnings)
  config.timeoutMs = asNumber(input.timeoutMs, DEFAULT_CONFIG.timeoutMs, { min: 5000, max: 600000, integer: true, name: 'timeoutMs' }, warnings)

  if (input.pageFetcher !== undefined) {
    if (FETCH_MODES.includes(input.pageFetcher)) config.pageFetcher = input.pageFetcher
    else warnings.push(`pageFetcher must be one of ${FETCH_MODES.join('/')}; keeping raw`)
  }

  config.useJinaFallback = asBoolean(input.useJinaFallback, DEFAULT_CONFIG.useJinaFallback, 'useJinaFallback', warnings)
  config.verboseLog = asBoolean(input.verboseLog, DEFAULT_CONFIG.verboseLog, 'verboseLog', warnings)
  config.debugStats = asBoolean(input.debugStats, DEFAULT_CONFIG.debugStats, 'debugStats', warnings)

  for (const [name, defaults] of [['engines', DEFAULT_CONFIG.engines], ['verticals', DEFAULT_CONFIG.verticals]]) {
    const given = input[name]
    config[name] = { ...defaults }
    if (given === undefined || given === null) continue
    if (typeof given !== 'object' || Array.isArray(given)) {
      warnings.push(`${name} must be an object; ignoring it`)
      continue
    }
    for (const [key, value] of Object.entries(given)) {
      if (!(key in defaults)) {
        warnings.push(`unknown ${name} key "${key}" is ignored`)
        continue
      }
      config[name][key] = asBoolean(value, defaults[key], `${name}.${key}`, warnings)
    }
  }

  config.keys = {}
  if (input.keys !== undefined) {
    if (typeof input.keys !== 'object' || Array.isArray(input.keys) || input.keys === null) {
      warnings.push('keys must be an object of { engine: apiKey }; ignoring it')
    } else {
      for (const [key, value] of Object.entries(input.keys)) {
        if (typeof value === 'string' && value.trim()) config.keys[key] = value.trim()
        else warnings.push(`keys.${key} must be a non-empty string; ignored`)
      }
    }
  }

  const cache = input.cache ?? {}
  if (cache && typeof cache === 'object' && !Array.isArray(cache)) {
    config.cache = {
      enabled: asBoolean(cache.enabled, DEFAULT_CONFIG.cache.enabled, 'cache.enabled', warnings),
      ttlMinutes: asNumber(cache.ttlMinutes, DEFAULT_CONFIG.cache.ttlMinutes, { min: 1, max: 1440, name: 'cache.ttlMinutes' }, warnings),
      maxEntries: asNumber(cache.maxEntries, DEFAULT_CONFIG.cache.maxEntries, { min: 1, max: 128, integer: true, name: 'cache.maxEntries' }, warnings),
    }
  } else if (input.cache !== undefined) {
    warnings.push('cache must be an object; using defaults')
  }

  const trust = input.domainTrust ?? {}
  if (trust && typeof trust === 'object' && !Array.isArray(trust)) {
    config.domainTrust = {
      trusted: asHostList(trust.trusted, 'domainTrust.trusted', warnings),
      blocked: asHostList(trust.blocked, 'domainTrust.blocked', warnings),
    }
  } else if (input.domainTrust !== undefined) {
    warnings.push('domainTrust must be an object; using defaults')
  }

  return { config, warnings }
}