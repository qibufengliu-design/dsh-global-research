/**
 * Page retrieval and readability-lite extraction.
 * A failed page is reported as failed; it is never replaced by guessed content.
 */
import { anySignal, decodeEntities, domainOf, htmlToText, truncate } from './util.js'

const MAX_TEXT = 8000
const MIN_USEFUL = 400

function pickTitle(html) {
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i)
  if (og) return decodeEntities(og[1]).trim()
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  return title ? decodeEntities(title[1]).replace(/\s+/g, ' ').trim() : ''
}

function cellarTitle({ html, text, domain }) {
  const shown = (html ? pickTitle(html) : '').trim()
  const fileish = /\.(xml|html?|pdf)$/i.test(shown) || /^L_\d{8}/.test(shown)
  if (shown && !fileish && shown.length >= 8) return truncate(shown, 140)
  const lines = String(text).split(/\n+/).map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean)
  const heading = lines.slice(0, 15).find((line) => /^(REGULATION|DIRECTIVE|DECISION)\b/i.test(line) && line.length >= 20)
    ?? lines.slice(0, 15).find((line) => line.length >= 40 && /[A-Za-z]{4}/.test(line))
  return truncate(heading ?? domain, 140)
}

function pickPublishedAt(html) {
  const patterns = [
    /<meta[^>]+property=["']article:published_time["'][^>]*content=["']([^"']+)["']/i,
    /<meta[^>]+name=["'](?:date|pubdate|publishdate|article:published_time)["'][^>]*content=["']([^"']+)["']/i,
    /<time[^>]+datetime=["']([^"']+)["']/i,
  ]
  for (const pattern of patterns) {
    const match = html.match(pattern)
    if (match) {
      const parsed = Date.parse(match[1])
      if (Number.isFinite(parsed)) return new Date(parsed).toISOString().slice(0, 10)
    }
  }
  return undefined
}

/** Prefer semantic containers; fall back to the whole document. */
function mainRegion(html) {
  for (const pattern of [
    /<article\b[^>]*>([\s\S]*?)<\/article>/i,
    /<main\b[^>]*>([\s\S]*?)<\/main>/i,
    /<div[^>]+(?:id|class)=["'][^"']*(?:content|article|post-body|entry-content)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
  ]) {
    const match = html.match(pattern)
    if (match && htmlToText(match[1]).length >= MIN_USEFUL) return match[1]
  }
  return html
}

function looksLikeJsShell(html, text) {
  if (text.length >= MIN_USEFUL) return false
  return /enable javascript|javascript is required|__NEXT_DATA__|<div id="root">\s*<\/div>/i.test(html)
}

/** GitHub renders blob pages as a React shell; the raw file is stable markdown. */
export function rawGithubUrl(url) {
  const match = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/?#]+)\/([^?#]+)/i.exec(url)
  if (!match) return url
  return `https://raw.githubusercontent.com/${match[1]}/${match[2]}/${match[3]}/${match[4]}`
}

/** Absolute http(s) links on the page — official pages usually link the legal text. */
function extractLinks(html, baseUrl) {
  const links = []
  const seen = new Set()
  for (const match of html.matchAll(/<a\b[^>]*href=["']([^"']+)["']/gi)) {
    const href = decodeEntities(match[1]).trim()
    if (!href || href.startsWith('#') || /^(mailto|javascript):/i.test(href)) continue
    let absolute
    try {
      absolute = new URL(href, baseUrl).toString()
    } catch {
      continue
    }
    if (!/^https?:\/\//i.test(absolute) || seen.has(absolute)) continue
    seen.add(absolute)
    links.push(absolute)
    if (links.length >= 40) break
  }
  return links
}

/** EUR-Lex renders acts with JavaScript; the Publications Office serves the
 * same document as XHTML via its Cellar API. Map an EUR-Lex URL to that
 * resource so legal text is readable without a browser. */
export function cellarCelex(url) {
  const direct = /[?&]uri=CELEX:([0-9A-Z()]+)/i.exec(url)?.[1]
  if (direct) return direct
  const eli = /eur-lex\.europa\.eu\/eli\/(reg|dir|dec)[^/]*\/(\d{4})\/(\d+)/i.exec(url)
  if (!eli) return null
  const [, type, year, number] = eli
  const letter = type.toLowerCase().startsWith('reg') ? 'R' : type.toLowerCase().startsWith('dir') ? 'L' : 'D'
  return `3${year}${letter}${String(number).padStart(4, '0')}`
}

export function cellarResourceUrl(url) {
  const celex = cellarCelex(url)
  return celex ? `https://publications.europa.eu/resource/celex/${celex}` : null
}

export function createPageFetcher({ config = {}, web, fetchRaw, logger }) {
  async function fetchViaJina(url, signal) {
    const { status, body } = await fetchRaw(`https://r.jina.ai/${url}`, {
      signal,
      headers: { accept: 'text/plain' },
    })
    if (status >= 400) throw new Error(`jina HTTP ${status}`)
    return body
  }

  /**
   * `config.pageFetcher` chooses the retrieval path:
   * - 'raw' (default): plain HTTP + our own extraction. Most faithful: host
   *   providers may return readability output that drops tables or even another
   *   article, which is worse than a failed fetch.
   * - 'web': only the host's web.fetch (honours proxies/cookies).
   * - 'auto': web.fetch first, plain HTTP when the result is too thin to cite.
   */

  return async function fetchPage(url, { signal, timeoutMs = 15000 } = {}) {
    const domain = domainOf(url)
    const base = { url, finalUrl: url, title: domain, domain, text: '', ok: false, via: 'raw' }
    const mode = config.pageFetcher ?? 'raw'

    const extract = (result) => {
      const body = result.body ?? {}
      const content = String(body.content ?? '')
      if (body.kind === 'text') return { text: content.trim(), html: '', title: pickTitle(content) }
      return { text: htmlToText(mainRegion(content)), html: content, title: pickTitle(content) }
    }

    // EUR-Lex's own pages are a JavaScript shell; Cellar has the act itself.
    const cellarUrl = config.useCellar === false ? null : cellarResourceUrl(url)
    if (cellarUrl) {
      try {
        const raw = await fetchRaw(cellarUrl, { signal, timeoutMs, headers: { accept: 'application/xhtml+xml' } })
        if (raw.status < 400) {
          const { text, html } = extract({ statusCode: raw.status, body: { kind: 'html', content: raw.body } })
          if (text.length >= MIN_USEFUL) {
            return {
              ...base,
              finalUrl: url,
              title: cellarTitle({ html, text, domain }),
              text: truncate(text, MAX_TEXT),
              publishedAt: html ? pickPublishedAt(html) : undefined,
              links: [],
              viaCellar: true,
              via: 'cellar',
              ok: true,
            }
          }
        }
      } catch (error) {
        logger?.(`cellar fetch failed for ${domain}: ${error.message}`)
      }
    }

    try {
      let result = null
      let fromWeb = false
      if ((mode === 'auto' || mode === 'web') && web?.fetch) {
        try {
          result = await web.fetch({ url }, signal)
          fromWeb = true
        } catch (error) {
          logger?.(`web.fetch failed for ${domain}: ${error.message}; trying raw HTTP`)
          if (signal?.aborted) throw error
        }
      }
      if (!result || (result.statusCode ?? 0) >= 400) {
        const rawUrl = rawGithubUrl(url)
        const raw = await fetchRaw(rawUrl, { signal, timeoutMs })
        if (raw.status >= 400) throw new Error(`HTTP ${raw.status}`)
        result = { statusCode: raw.status, finalUrl: rawUrl, body: { kind: 'html', content: raw.body } }
        fromWeb = false
      }

      let { text, html } = extract(result)
      // Unified retrieval marker for the evidence grader (0.6.0). It starts as
      // the path that produced the text and is overwritten below if Jina does.
      let via = fromWeb ? 'web' : 'raw'
      // The host provider can succeed with a JS shell or navigation-only body;
      // retry over plain HTTP before declaring the page unreadable.
      if (fromWeb && text.length < MIN_USEFUL) {
        try {
          const raw = await fetchRaw(rawGithubUrl(url), { signal, timeoutMs })
          const retried = extract({ statusCode: raw.status, body: { kind: 'html', content: raw.body } })
          if (retried.text.length > text.length) {
            text = retried.text
            html = retried.html
          }
        } catch (error) {
          logger?.(`raw retry failed for ${domain}: ${error.message}`)
        }
      }

      if (looksLikeJsShell(html, text) && config.useJinaFallback) {
        try {
          text = (await fetchViaJina(url, anySignal(signal, timeoutMs))).trim()
          if (text.length >= MIN_USEFUL) via = 'jina'
        } catch (error) {
          logger?.(`jina fallback failed for ${domain}: ${error.message}`)
        }
      }
      // PDFs and other binary payloads look like text to a naive reader; they
      // must count as "not fetched", never as quotable content.
      if (/^%PDF-/.test(text) || /[\u0000-\u0008\u000E-\u001F]/.test(text.slice(0, 500))) {
        throw new Error('binary content (pdf/compressed) is not readable text')
      }
      // Quality gate: navigation junk ("Skip to content", cookie banners) must not
      // masquerade as an article — a too-short extraction counts as a failure.
      if (text.length < MIN_USEFUL) {
        throw new Error(`page had no extractable article text (${text.length} chars)`)
      }
      return {
        ...base,
        finalUrl: result.finalUrl ?? url,
        title: (html ? pickTitle(html) : '') || domain,
        text: truncate(text, MAX_TEXT),
        publishedAt: html ? pickPublishedAt(html) : undefined,
        links: html ? extractLinks(html, result.finalUrl ?? url) : [],
        via,
        ok: true,
      }
    } catch (error) {
      if (signal?.aborted) throw error
      const reasons = [error?.message ?? 'fetch failed']
      // Layer 2: the host provider may succeed where plain HTTP was refused
      // (403/419) or where the site only renders for its own client.
      if (web?.fetch && mode === 'raw') {
        try {
          const result = await web.fetch({ url }, signal)
          if ((result.statusCode ?? 0) < 400) {
            const { text, html } = extract(result)
            if (text.length >= MIN_USEFUL && !/^%PDF-/.test(text)) {
              return {
                ...base,
                finalUrl: result.finalUrl ?? url,
                title: (html ? pickTitle(html) : '') || domain,
                text: truncate(text, MAX_TEXT),
                publishedAt: html ? pickPublishedAt(html) : undefined,
                links: html ? extractLinks(html, result.finalUrl ?? url) : [],
                viaWeb: true,
                via: 'web',
                ok: true,
              }
            }
            reasons.push(`web.fetch returned ${text.length} chars`)
          } else {
            reasons.push(`web.fetch HTTP ${result.statusCode}`)
          }
        } catch (webError) {
          logger?.(`web.fetch fallback failed for ${domain}: ${webError.message}`)
          reasons.push(`web.fetch failed: ${webError.message}`)
        }
      }
      // Layer 3: a reader proxy for JavaScript shells and bot walls.
      if (config.useJinaFallback && !String(error.message).includes('jina')) {
        try {
          const text = (await fetchViaJina(url, anySignal(signal, timeoutMs))).trim()
          if (text.length >= 80) {
            return { ...base, title: domain, text: truncate(text, MAX_TEXT), viaJina: true, via: 'jina', ok: true }
          }
          reasons.push(`jina returned ${text.length} chars`)
        } catch (jinaError) {
          logger?.(`jina fallback failed for ${domain}: ${jinaError.message}`)
          reasons.push(`jina failed: ${jinaError.message}`)
        }
      }
      return { ...base, ok: false, reason: reasons.join('; ') }
    }
  }
}

/**
 * 1.1.0 — the render whitelist. These official pages are JavaScript shells: a
 * plain HTTP fetch returns the page chrome and no price table, and the host's
 * own price-list URL is the one page we cannot answer a pricing question
 * without. Everything else keeps the raw path; rendering is not a general
 * retrieval upgrade, it is a fallback for a known set of shells.
 */
export const DEFAULT_RENDER_HOSTS = Object.freeze([
  'volcengine.com',
  'help.aliyun.com',
  'api-docs.deepseek.com',
  'platform.moonshot.cn',
  'open.bigmodel.cn',
  'bigmodel.cn',
])

/** Same 400-character readability gate as the regular fetch path. */
export const MIN_USEFUL_CHARS = MIN_USEFUL
export const RENDER_TIMEOUT_MS = 20000

function renderHostList(hosts) {
  const list = Array.isArray(hosts) && hosts.length > 0 ? hosts : DEFAULT_RENDER_HOSTS
  return list
    .map((entry) => String(entry ?? '').trim().toLowerCase()
      .replace(/^[a-z]+:\/\//, '')
      .replace(/^www\./, '')
      .split(/[/?#]/)[0])
    .filter(Boolean)
}

/**
 * Host-suffix match: `help.aliyun.com` matches `help.aliyun.com` and its
 * subdomains, never `nothelp.aliyun.com`.
 */
export function isRenderHost(url, hosts) {
  const host = domainOf(url)
  if (!host) return false
  return renderHostList(hosts).some((entry) => host === entry || host.endsWith(`.${entry}`))
}

function renderTitle(text, fallback) {
  const titled = text.match(/^Title:\s*(.+)$/m)
  if (titled) return truncate(titled[1].trim(), 140)
  const heading = text.match(/^#{1,2}\s+(.+)$/m)
  if (heading) return truncate(heading[1].replace(/\s+/g, ' ').trim(), 140)
  return fallback
}

function renderPublishedAt(text) {
  const line = text.match(/^Published Time:\s*(.+)$/m)
  if (!line) return undefined
  const parsed = Date.parse(line[1].trim())
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : undefined
}

/**
 * 1.1.0 — an independent render fetcher for pricing shells.
 *
 * Deliberately separate from `createPageFetcher`: the pipeline decides when a
 * render is worth spending (pricing channel, standard/deep, its own budget) and
 * the normal path stays byte-for-byte what it was. `renderPage` never throws —
 * on any failure it returns the original failure plus `renderReason`, so the
 * caller can keep the real error and record why the fallback did not help.
 */
export function createRenderFetcher({ fetchRaw, config = {}, logger } = {}) {
  const enabled = config.renderFallback !== false
  const hosts = config.renderHosts

  return async function renderPage(url, { signal, timeoutMs = RENDER_TIMEOUT_MS, reason = '' } = {}) {
    const domain = domainOf(url)
    const base = { url, finalUrl: url, title: domain, domain, text: '', ok: false, via: 'raw' }
    const failed = (renderReason) => ({ ...base, reason, renderReason })

    if (!enabled) return failed('renderFallback disabled')
    if (typeof fetchRaw !== 'function') return failed('no raw fetcher for render fallback')
    if (!isRenderHost(url, hosts)) return failed('host not in the render whitelist')

    try {
      const { status, body } = await fetchRaw(`https://r.jina.ai/${url}`, {
        signal,
        headers: { accept: 'text/plain' },
      })
      if (status >= 400) return failed(`render HTTP ${status}`)
      const text = String(body ?? '').trim()
      if (text.length < MIN_USEFUL) return failed(`render returned ${text.length} chars`)
      return {
        ...base,
        title: renderTitle(text, domain),
        text: truncate(text, MAX_TEXT),
        publishedAt: renderPublishedAt(text),
        links: [],
        via: 'render',
        ok: true,
      }
    } catch (error) {
      logger?.(`render fallback failed for ${domain}: ${error.message}`)
      return failed(`render failed: ${error.message}`)
    }
  }
}