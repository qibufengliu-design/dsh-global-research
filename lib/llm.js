/**
 * Thin text-only wrapper over ctx.llm.stream: one buffered string per call,
 * one retry, JSON repair retry. Model/provider come from the agent default.
 */
import { anySignal, parseLooseJson, truncate } from './util.js'

export function createLlmClient({ llm, selection, logger, timeoutMs = 60000 }) {
  const available = Boolean(llm?.stream && selection?.provider && selection?.model)

  async function rawCall({ system, user, maxTokens = 1400, temperature = 0.2, signal }) {
    let text = ''
    let lastFinish = ''
    const stream = llm.stream({
      provider: selection.provider,
      model: selection.model,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
      temperature,
      maxTokens,
      signal: anySignal(signal, timeoutMs),
    })
    for await (const chunk of stream) {
      if (chunk?.type === 'text-delta') text += chunk.text ?? ''
      else if (chunk?.type === 'finish') {
        if (chunk.reason?.kind === 'error') throw new Error(chunk.reason.failure?.message ?? 'model call failed')
        lastFinish = chunk.reason?.kind ?? 'unknown'
      }
    }
    if (!text.trim()) throw new Error(`empty model output (finish: ${lastFinish}, maxTokens: ${maxTokens})`)
    return text.trim()
  }

  async function call(options) {
    try {
      return await rawCall(options)
    } catch (error) {
      if (options.signal?.aborted) throw error
      logger?.(`llm retry after: ${error.message}`)
      return rawCall(options)
    }
  }

  /** One JSON-producing call with a single repair attempt; null means model unavailable/failed. */
  async function jsonCall({ system, user, signal, maxTokens = 1200 }) {
    if (!available) return null
    let text
    try {
      text = await call({ system, user, signal, maxTokens })
    } catch (error) {
      if (signal?.aborted) throw error
      logger?.(`llm json call failed: ${error.message}`)
      return null
    }
    let parsed = parseLooseJson(text)
    if (parsed !== null) return parsed
    logger?.(`json parse failed, repairing: ${truncate(text, 120)}`)
    try {
      const repaired = await call({
        system: '你是 JSON 修复器，只输出合法 JSON。',
        user: `修复下面的 JSON（只输出 JSON 本身）：\n\n${truncate(text, 6000)}`,
        signal,
        maxTokens,
      })
      parsed = parseLooseJson(repaired)
    } catch (error) {
      if (signal?.aborted) throw error
    }
    return parsed
  }

  return { available, call, jsonCall }
}