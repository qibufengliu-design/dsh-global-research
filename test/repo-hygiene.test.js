import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkRepository } from '../scripts/check-docs.mjs'
import { extractReleaseNotes } from '../scripts/release-notes.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('extractReleaseNotes pulls one version section and stops at the next heading', () => {
  const markdown = [
    '# Changelog',
    '',
    '## [Unreleased]',
    '',
    '- pending work',
    '',
    '## [9.9.9] - 2026-01-01',
    '',
    '### Added',
    '',
    '- alpha',
    '',
    '## [9.9.8] - 2025-12-31',
    '',
    '- beta',
    '',
  ].join('\n')
  const notes = extractReleaseNotes(markdown, '9.9.9')
  assert.match(notes, /### Added/)
  assert.match(notes, /alpha/)
  assert.doesNotMatch(notes, /beta/)
  assert.doesNotMatch(notes, /9\.9\.9/)
  assert.equal(extractReleaseNotes(markdown, 'v9.9.9'), notes, '前导 v 也应接受')
  assert.equal(extractReleaseNotes(markdown, '0.0.1'), '', '未知版本返回空串')
})

test('checkRepository passes on the repository itself', () => {
  const { passes, failures } = checkRepository(root)
  assert.deepEqual(failures, [])
  assert.ok(passes.length >= 5, `expected several checks to run, got ${passes.length}`)
})

test('checkRepository reports missing files instead of throwing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-hygiene-'))
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '1.2.3' }))
    const { failures } = checkRepository(dir)
    assert.ok(failures.some((line) => line.includes('缺少必需文件')), failures.join('\n'))
    assert.ok(failures.some((line) => line.includes('CHANGELOG.md')), failures.join('\n'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})