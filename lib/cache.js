/**
 * Small in-memory result cache. Research runs are expensive (10s–5min and
 * paid search quota), so repeating the same question within the TTL returns the
 * previous brief instead of paying for it twice.
 *
 * Keys are built from the normalized inputs that can change the answer. The
 * cache is process-local on purpose: a profile restart loses it, and nothing
 * is written to disk.
 */
import { createHash } from 'node:crypto'

export function cacheKey({ question = '', depth = 'auto', focus = [], language = 'auto' } = {}) {
  const normalized = {
    question: String(question).trim().replace(/\s+/g, ' ').toLowerCase(),
    depth,
    focus: [...focus].map((item) => String(item).trim().toLowerCase()).filter(Boolean).sort(),
    language,
  }
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex').slice(0, 32)
}

export class ResearchCache {
  constructor({ maxEntries = 16, ttlMs = 60 * 60 * 1000, now = () => Date.now() } = {}) {
    this.maxEntries = Math.max(1, Math.floor(Number(maxEntries) || 16))
    this.ttlMs = Math.max(0, Number(ttlMs) || 0)
    this.now = now
    this.entries = new Map()
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
    return value
  }

  clear() {
    this.entries.clear()
  }
}