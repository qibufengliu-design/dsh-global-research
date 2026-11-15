/**
 * Small result cache. Research runs are expensive (10s–5min and paid search
 * quota), so repeating the same question within the TTL returns the previous
 * brief instead of paying for it twice.
 *
 * Keys are built from the normalized inputs that can change the answer. The
 * cache is in memory by default: a profile restart loses it. Setting
 * `persistPath` opts into a JSON snapshot on disk — the pipeline still works
 * when the file cannot be read or written, it only loses the warm start.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { normalizeMode } from './strategy.js'

/**
 * Cache key over the inputs that can change the answer.
 *
 * `mode` used to be missing: the same question asked as `explain` and again as
 * `compare` hit the same entry and returned the wrong brief. `questionKind` and
 * `signalVersion` are optional so cached briefs are only invalidated when a
 * caller actually classifies (undefined keys are not part of the digest input).
 */
export function cacheKey({ question = '', depth = 'auto', focus = [], language = 'auto', mode = 'explain', text = '', questionKind, signalVersion } = {}) {
  const normalized = {
    question: String(question).trim().replace(/\s+/g, ' ').toLowerCase(),
    depth,
    focus: [...focus].map((item) => String(item).trim().toLowerCase()).filter(Boolean).sort(),
    language,
    mode: normalizeMode(mode),
  }
  // 0.6.0 — pasted source text is part of the input: two runs with different
  // text must never share a cached brief. Hashed so the key stays short.
  const userText = String(text ?? '').trim().replace(/\s+/g, ' ')
  if (userText) normalized.text = createHash('sha256').update(userText).digest('hex').slice(0, 16)
  if (typeof questionKind === 'string' && questionKind !== '') normalized.questionKind = questionKind
  if (Number.isFinite(signalVersion)) normalized.signalVersion = signalVersion
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex').slice(0, 32)
}

export class ResearchCache {
  constructor({
    maxEntries = 16, ttlMs = 60 * 60 * 1000, now = () => Date.now(),
    // 0.7.1 — opt-in persistence. Empty path keeps the cache in memory only,
    // which is the default and the behaviour every earlier version had.
    persistPath = '', debounceMs = 500, onError = null,
  } = {}) {
    this.maxEntries = Math.max(1, Math.floor(Number(maxEntries) || 16))
    this.ttlMs = Math.max(0, Number(ttlMs) || 0)
    this.now = now
    this.entries = new Map()
    this.persistPath = typeof persistPath === 'string' ? persistPath.trim() : ''
    this.debounceMs = Math.max(0, Number(debounceMs) || 0)
    this.onError = typeof onError === 'function' ? onError : null
    this.timer = null
    // Serialise writes: a burst of set() calls must not interleave two renames.
    this.writes = Promise.resolve()
  }

  report(error) {
    if (!this.onError) return
    try {
      this.onError(error)
    } catch {
      // Reporting must never break the research call.
    }
  }

  /**
   * 0.7.1 — restore entries saved by a previous process. Synchronous on
   * purpose: apply() runs it once at mount time, and a debugStats counter should
   * not depend on a promise winning a race with the first tool call.
   *
   * Expired entries are dropped, malformed lines are skipped, and a corrupt file
   * is reported through onError and treated as an empty cache. Returns the
   * number of restored entries.
   */
  load() {
    if (!this.persistPath) return 0
    let raw
    try {
      raw = readFileSync(this.persistPath, 'utf8')
    } catch (error) {
      // No snapshot yet is the normal first-run case, not a problem to report.
      if (error?.code !== 'ENOENT') this.report(error)
      return 0
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      this.report(error)
      return 0
    }
    if (!Array.isArray(parsed?.entries)) {
      this.report(new Error('cache snapshot has no entries array; ignoring it'))
      return 0
    }
    let restored = 0
    for (const entry of parsed.entries) {
      if (!entry || typeof entry.key !== 'string' || !entry.key) continue
      if (!Object.prototype.hasOwnProperty.call(entry, 'value')) continue
      if (!Number.isFinite(Number(entry.savedAt))) continue
      if (this.now() - Number(entry.savedAt) > this.ttlMs) continue
      this.entries.set(entry.key, { value: entry.value, savedAt: Number(entry.savedAt) })
      restored += 1
    }
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value
      this.entries.delete(oldest)
    }
    return restored
  }

  /**
   * 0.7.1 — debounced snapshot. set()/clear() call this; a burst of writes
   * within debounceMs produces one file. The write itself goes to a sibling
   * temporary file and is renamed into place, so a crash mid-write leaves the
   * previous snapshot readable instead of a truncated JSON file.
   */
  save() {
    if (!this.persistPath) return
    if (this.timer) clearTimeout(this.timer)
    const fire = () => {
      this.timer = null
      this.enqueueWrite()
    }
    if (this.debounceMs <= 0) {
      fire()
      return
    }
    this.timer = setTimeout(fire, this.debounceMs)
    // Do not keep the process alive only to flush a cache file.
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  enqueueWrite() {
    this.writes = this.writes
      .then(() => this.write())
      .catch((error) => this.report(error))
    return this.writes
  }

  /** Wait for the pending debounce and any queued write (tests, shutdown). */
  async flush() {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
      this.enqueueWrite()
    }
    await this.writes
  }

  async write() {
    const payload = JSON.stringify({
      version: 1,
      entries: [...this.entries].map(([key, entry]) => ({ key, value: entry.value, savedAt: entry.savedAt })),
    })
    const target = this.persistPath
    await mkdir(dirname(target), { recursive: true })
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temporary, payload, 'utf8')
    await rename(temporary, target)
  }

  get size() {
    return this.entries.size
  }

  /** Fresh value or undefined. Stale entries are dropped on read. */
  get(key) {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (this.now() - entry.savedAt > this.ttlMs) {
      this.entries.delete(key)
      return undefined
    }
    // Refresh recency so eviction drops the least recently *used* entry.
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value
  }

  ageMs(key) {
    const entry = this.entries.get(key)
    return entry ? this.now() - entry.savedAt : undefined
  }

  set(key, value) {
    // Re-insert so the eviction order tracks recency.
    this.entries.delete(key)
    this.entries.set(key, { value, savedAt: this.now() })
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value
      this.entries.delete(oldest)
    }
    this.save()
    return value
  }

  clear() {
    this.entries.clear()
    this.save()
  }
}
