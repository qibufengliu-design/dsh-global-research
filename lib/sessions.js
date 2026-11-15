// In-memory store for follow-up research: a finished run keeps its pages and
// evidence clusters so a follow-up can deepen the same topic instead of paying
// for the whole pipeline again. Nothing is written to disk: the data is raw
// web text and should not outlive the process.
import { randomUUID } from 'node:crypto'

export const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000

export class ResearchSessions {
  constructor({ maxEntries = 8, ttlMs = DEFAULT_SESSION_TTL_MS, now = () => Date.now() } = {}) {
    this.maxEntries = Math.max(1, Number(maxEntries) || 8)
    this.ttlMs = Math.max(0, Number(ttlMs) || DEFAULT_SESSION_TTL_MS)
    this.now = now
    this.entries = new Map()
  }

  create(payload) {
    const id = `rs_${randomUUID().replace(/-/g, '').slice(0, 16)}`
    this.entries.set(id, { id, createdAt: this.now(), payload })
    // Least recently created goes first; follow-ups are short-lived.
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value
      this.entries.delete(oldest)
    }
    return id
  }

  get(id) {
    const entry = this.entries.get(id)
    if (!entry) return undefined
    if (this.ttlMs > 0 && this.now() - entry.createdAt > this.ttlMs) {
      this.entries.delete(id)
      return undefined
    }
    return entry.payload
  }

  ageMs(id) {
    const entry = this.entries.get(id)
    return entry ? Math.max(0, this.now() - entry.createdAt) : undefined
  }

  delete(id) {
    this.entries.delete(id)
  }

  clear() {
    this.entries.clear()
  }

  get size() {
    return this.entries.size
  }
}