#!/usr/bin/env node
/**
 * 发布核对（零依赖）：确认 GitHub 上某个 tag 的 Release 页正文与 CHANGELOG 对应小节一致。
 *
 *   node scripts/verify-release.mjs v0.9.8
 *   GITHUB_TOKEN=… node scripts/verify-release.mjs v0.9.8     # 可选，只为放宽 API 限流
 *
 * 做三件事：
 *   1. 拉 `GET /repos/<owner>/<repo>/releases/tags/<tag>`；
 *   2. 拉**该 tag 提交上**的 CHANGELOG.md（raw.githubusercontent.com，与 release.yml 检出的一致；
 *      工作区里可能已经有下一版的改动，直接比工作区会误报）；
 *   3. 把 Release 正文按行尾/首尾空白归一后与 CHANGELOG 小节逐字比对。
 *
 * 为什么要单独跑：Release 页是 workflow 生成的，正文取自 CHANGELOG，但「取哪一段」「取到的是不是
 * 空段」只有真的去 GitHub 看一眼才知道。0.9.2 那种「tag 打了、Release 没建」就是靠这一步发现的。
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractReleaseNotes } from './release-notes.mjs'

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 归一化 Markdown 正文：统一换行、去掉行尾空白与首尾空行。
 * Release 正文是 GitHub 存下来的原文，末尾可能被加/少一个换行，不该因此判失败。
 * @param {string} text
 * @returns {string}
 */
export function normalizeBody(text) {
  return String(text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .trim()
}

/**
 * Release 正文是否等于 CHANGELOG 里该版本的小节。
 * @param {string} changelogMarkdown
 * @param {string} releaseBody
 * @param {string} version 允许前导 `v`
 * @returns {{ ok: boolean, reason?: string, expected?: string, actual?: string }}
 */
export function releaseBodyMatches(changelogMarkdown, releaseBody, version) {
  const expected = normalizeBody(extractReleaseNotes(changelogMarkdown, version))
  const actual = normalizeBody(releaseBody)
  if (!expected) return { ok: false, reason: `CHANGELOG.md 里找不到 ${version} 的小节`, actual }
  if (!actual) return { ok: false, reason: `Release ${version} 的正文是空的`, expected }
  if (expected !== actual) return { ok: false, reason: `Release ${version} 的正文与 CHANGELOG 小节不一致`, expected, actual }
  return { ok: true, expected, actual }
}

/**
 * 从 package.json 的 repository.url 解析 `<owner>/<repo>`。
 * @param {object} pkg
 * @returns {{ owner: string, repo: string } | null}
 */
export function parseRepository(pkg) {
  const url = pkg?.repository?.url
  if (typeof url !== 'string') return null
  const match = /github\.com[/:]([^/]+)\/([^/.]+)(?:\.git)?/.exec(url)
  if (!match) return null
  return { owner: match[1], repo: match[2] }
}

/**
 * 取某个 tag 的 Release（找不到返回 null）。
 * @param {string} apiBase 例如 https://api.github.com
 * @param {{ owner: string, repo: string }} slug
 * @param {string} tag
 * @param {string} [token]
 * @returns {Promise<{ tag_name: string, body: string, id: number } | null>}
 */
export async function fetchRelease(apiBase, { owner, repo }, tag, token = '') {
  const headers = { 'user-agent': 'dsh-global-research-release-check', accept: 'application/vnd.github+json' }
  if (token) headers.authorization = `Bearer ${token}`
  const response = await fetch(`${apiBase}/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`, { headers })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`GitHub API ${response.status} ${response.statusText}`)
  return response.json()
}

/**
 * 取某个 tag 上的 CHANGELOG.md 原文（与 release.yml 检出 tag 后读的是同一份）。
 * 404 返回 null，让调用方回落到工作区文件。
 * @param {{ owner: string, repo: string }} slug
 * @param {string} tag
 * @param {string} [token]
 * @returns {Promise<string | null>}
 */
export async function fetchChangelogAt(slug, tag, token = '') {
  const headers = { 'user-agent': 'dsh-global-research-release-check' }
  if (token) headers.authorization = `Bearer ${token}`
  const url = `https://raw.githubusercontent.com/${slug.owner}/${slug.repo}/${encodeURIComponent(tag)}/CHANGELOG.md`
  const response = await fetch(url, { headers })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`raw.githubusercontent.com ${response.status} ${response.statusText}`)
  return response.text()
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isMain) {
  const tag = process.argv[2]
  if (!tag) {
    console.error('用法：node scripts/verify-release.mjs <tag>（例如 v0.9.8）')
    process.exit(2)
  }
  const root = DEFAULT_ROOT
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const slug = parseRepository(pkg)
  if (!slug) {
    console.error('✘ package.json 的 repository.url 解析不出 <owner>/<repo>')
    process.exit(1)
  }
  const token = process.env.GITHUB_TOKEN || ''
  const apiBase = process.env.GITHUB_API_URL || 'https://api.github.com'
  let release = null
  try {
    release = await fetchRelease(apiBase, slug, tag, token)
  } catch (error) {
    console.error(`✘ 拉取 Release 失败：${error.message}`)
    process.exit(1)
  }
  if (!release) {
    console.error(`✘ ${slug.owner}/${slug.repo} 上没有 ${tag} 的 Release 页（tag 推上去后由 release.yml 生成）`)
    process.exit(1)
  }
  let changelog
  try {
    changelog = (await fetchChangelogAt(slug, tag, token)) ?? readFileSync(join(root, 'CHANGELOG.md'), 'utf8')
  } catch (error) {
    console.error(`✘ 拉取 tag 上的 CHANGELOG.md 失败：${error.message}`)
    process.exit(1)
  }
  const result = releaseBodyMatches(changelog, release.body, tag)
  if (!result.ok) {
    console.error(`✘ ${result.reason}`)
    if (result.expected !== undefined && result.actual !== undefined) {
      console.error(`  tag 上的 CHANGELOG 小节 ${result.expected.length} 字 / Release 正文 ${result.actual.length} 字`)
    }
    process.exit(1)
  }
  console.log(`✔ Release ${tag}（id ${release.id}）的正文与 tag 上的 CHANGELOG 小节一致（${result.expected.length} 字）`)
  process.exit(0)
}