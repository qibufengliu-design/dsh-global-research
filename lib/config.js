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
  verticals: { github: true, arxiv: true, scholar: true, stackexchange: true, npm: true, hn: true, pypi: true, docs: true },
  // Per-engine monthly call budget; {} means "use the built-in plan limits".
  quotaPerMonth: {},
  pageFetcher: 'raw',
  useJinaFallback: false,
  timeoutMs: 120000,
  verboseLog: false,
  debugStats: false,
  // 0.7.1 — cache persistence is opt-in: persistPath '' means memory only.
  cache: { enabled: true, ttlMinutes: 60, maxEntries: 16, persistPath: '', persistDebounceMs: 500 },
  domainTrust: { trusted: [], blocked: [] },
  // 0.6.8 — how many cross-host sitemap <loc> entries may be re-pointed at the
  // documentation base host (0 disables the probe).
  docHostRewrite: 3,
  // 0.9.3 — material pasted on the settings page. Empty means "no material":
  // a research call then relies on its own `text` argument or on the web.
  material: '',
}

const MATERIAL_MAX_CHARS = 20000

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

/** Optional path string: '' is "off", anything else is kept verbatim. */
function asPath(value, fallback, name, warnings) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string') {
    warnings.push(`${name} must be a string path, got ${JSON.stringify(value)}; keeping it empty`)
    return fallback
  }
  return value.trim()
}

/**
 * Multi-line text from the settings page. Whitespace-only is "off", and a value
 * past the cap is truncated instead of dropped: a user pasting 21k characters
 * should lose the tail, not the whole document.
 */
function asMaterial(value, fallback, warnings) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string') {
    warnings.push(`material must be a string, got ${JSON.stringify(value)}; ignoring it`)
    return fallback
  }
  const trimmed = value.trim()
  if (trimmed.length > MATERIAL_MAX_CHARS) {
    warnings.push(`material is ${trimmed.length} chars (limit ${MATERIAL_MAX_CHARS}); truncating`)
    return trimmed.slice(0, MATERIAL_MAX_CHARS)
  }
  return trimmed
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
  config.material = asMaterial(input.material, DEFAULT_CONFIG.material, warnings)
  config.timeoutMs = asNumber(input.timeoutMs, DEFAULT_CONFIG.timeoutMs, { min: 5000, max: 600000, integer: true, name: 'timeoutMs' }, warnings)
  config.docHostRewrite = asNumber(input.docHostRewrite, DEFAULT_CONFIG.docHostRewrite, { min: 0, max: 3, integer: true, name: 'docHostRewrite' }, warnings)

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

  // Monthly call limits for paid engines: { tavily: 500, brave: 1000 }.
  config.quotaPerMonth = {}
  if (input.quotaPerMonth !== undefined && input.quotaPerMonth !== null) {
    const quota = input.quotaPerMonth
    if (typeof quota !== 'object' || Array.isArray(quota)) {
      warnings.push('quotaPerMonth must be an object of { engine: limit }; ignoring it')
    } else {
      for (const [name, value] of Object.entries(quota)) {
        const limit = Number(value)
        if (!Number.isFinite(limit) || limit < 0) {
          warnings.push(`quotaPerMonth.${name} must be a non-negative number; ignored`)
          continue
        }
        config.quotaPerMonth[name] = Math.round(limit)
      }
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
      persistPath: asPath(cache.persistPath, DEFAULT_CONFIG.cache.persistPath, 'cache.persistPath', warnings),
      persistDebounceMs: asNumber(
        cache.persistDebounceMs, DEFAULT_CONFIG.cache.persistDebounceMs,
        { min: 0, max: 60000, integer: true, name: 'cache.persistDebounceMs' }, warnings,
      ),
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