#!/usr/bin/env node
/**
 * 从 CHANGELOG.md 抽出发版说明（零依赖）
 *
 *   node scripts/release-notes.mjs 0.9.5     # 版本号，带不带 v 都行
 *
 * 供 `.github/workflows/release.yml` 生成 GitHub Release 正文：
 *   1. 找到 `## [<version>]` 段；
 *   2. 输出到下一个 `## [` 之前的内容（去掉标题行本身）；
 *   3. 找不到就以非零码退出，避免发出空正文的 Release。
 *
 * 同时导出的 `extractReleaseNotes()` 供测试直接调用。
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * @param {string} markdown CHANGELOG 全文
 * @param {string} version 版本号（可带前导 v）
 * @returns {string} 该版本的正文（不含 `## [...]` 标题行），未找到时返回空串
 */
export function extractReleaseNotes(markdown, version) {
  const wanted = String(version).trim().replace(/^v/, '')
  if (!wanted) return ''
  const lines = markdown.split(/\r?\n/)
  const heading = new RegExp(`^## \\[${wanted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]`)
  const start = lines.findIndex((line) => heading.test(line))
  if (start === -1) return ''
  const body = []
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^## \[/.test(lines[index])) break
    body.push(lines[index])
  }
  while (body.length && body[0].trim() === '') body.shift()
  while (body.length && body[body.length - 1].trim() === '') body.pop()
  return body.join('\n')
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isMain) {
  const raw = process.argv[2]
  if (!raw) {
    console.error('用法：node scripts/release-notes.mjs <版本号，例如 0.9.5>')
    process.exit(2)
  }
  const version = raw.replace(/^v/, '')
  const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8')
  const notes = extractReleaseNotes(changelog, version)
  if (!notes) {
    console.error(`CHANGELOG.md 里找不到版本 ${version} 的条目（形如 "## [${version}] - 2026-11-15"）`)
    process.exit(1)
  }
  process.stdout.write(`${notes}\n`)
}