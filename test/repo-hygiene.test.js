import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkRepository } from '../scripts/check-docs.mjs'
import {
  checkRelease,
  parseDepthProfiles,
  parseReadmeBudgets,
  releaseSections,
  staleTestCounts,
} from '../scripts/check-release.mjs'
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

test('releaseSections splits versions and keeps their bodies', () => {
  const markdown = [
    '# Changelog',
    '',
    '## [Unreleased]',
    '',
    '- pending',
    '',
    '## [2.0.0] - 2026-02-02',
    '',
    '### Added',
    '',
    '- big one',
    '',
    '## [1.9.0] - 2026-01-01',
    '',
    '- small one',
    '',
  ].join('\n')
  const sections = releaseSections(markdown)
  assert.deepEqual(
    sections.map((section) => section.version),
    ['2.0.0', '1.9.0']
  )
  assert.match(sections[0].body, /big one/)
  assert.doesNotMatch(sections[0].body, /small one/)
})

test('checkRelease flags duplicated and empty CHANGELOG sections', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sections-'))
  try {
    mkdirSync(join(dir, 'lib'))
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '9.9.9', name: 'fixture' }))
    writeFileSync(
      join(dir, 'CHANGELOG.md'),
      [
        '# Changelog',
        '',
        '## [Unreleased]',
        '',
        '## [9.9.9] - 2026-01-01',
        '',
        '- ship it',
        '',
        '## [9.9.9] - 2025-12-31',
        '',
        '## [9.9.8] - 2025-12-01',
        '',
        '- old',
        '',
      ].join('\n')
    )
    writeFileSync(
      join(dir, 'lib/pipeline.js'),
      'export const DEPTH_PROFILES = {\n  quick: { queries: 2, pages: 3, llmCalls: 6, gapRounds: 0, wallMs: 120000 },\n  standard: { queries: 6, pages: 12, llmCalls: 14, gapRounds: 1, wallMs: 240000 },\n  deep: { queries: 16, pages: 30, llmCalls: 28, gapRounds: 1, wallMs: 360000 },\n}\n'
    )
    writeFileSync(
      join(dir, 'README.md'),
      '| depth | queries | pages | LLM 轮 | 补搜轮 | 墙钟 |\n|---|---|---|---|---|---|\n| quick | 2 | 3 | 6 | 0 | 120s |\n| standard | 6 | 12 | 14 | 1 | 240s |\n| deep | 16 | 30 | 28 | 1 | 360s |\n'
    )
    const { failures } = checkRelease(dir)
    const joined = failures.join('\n')
    assert.match(joined, /重复的版本小节：9\.9\.9/, joined)
    assert.match(joined, /空的（发 Release 时正文会为空）：9\.9\.9/, joined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('checkRepository rejects broken issue forms before GitHub hides them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-issue-'))
  try {
    mkdirSync(join(dir, '.github', 'ISSUE_TEMPLATE'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '1.2.3' }))
    writeFileSync(
      join(dir, '.github/ISSUE_TEMPLATE/bug_report.yml'),
      [
        'name: Bug 报告',
        'body:',
        '  - type: textbox',
        '    id: detail',
        '    attributes:',
        '      label: 详情',
        '  - type: input',
        '    id: detail',
        '    attributes:',
        '      label: 重复 id',
        '',
      ].join('\n')
    )
    const { failures } = checkRepository(dir)
    const joined = failures.join('\n')
    assert.match(joined, /ISSUE_TEMPLATE\/bug_report\.yml 缺少必填顶层键 description/, joined)
    assert.match(joined, /未知的 body 类型：textbox/, joined)
    assert.match(joined, /id 重复：detail/, joined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('parseDepthProfiles reads the real profile numbers', () => {
  const source = [
    'export const DEPTH_PROFILES = {',
    '  quick: { queries: 2, pages: 3, llmCalls: 6, gapRounds: 0, wallMs: 120000, batch: 3 },',
    '  standard: { queries: 6, pages: 12, llmCalls: 14, gapRounds: 1, wallMs: 240000 },',
    '  deep: { queries: 16, pages: 30, llmCalls: 28, gapRounds: 1, wallMs: 360000 },',
    '}',
    '',
  ].join('\n')
  const profiles = parseDepthProfiles(source)
  assert.equal(profiles.quick.wallMs, 120000)
  assert.equal(profiles.standard.pages, 12)
  assert.equal(profiles.deep.llmCalls, 28)
  assert.equal(parseDepthProfiles('export const OTHER = {}'), null)
})

test('parseReadmeBudgets converts the wall-clock column to milliseconds', () => {
  const markdown = [
    '| depth | queries | pages | LLM 轮 | 补搜轮 | 墙钟 |',
    '|---|---|---|---|---|---|',
    '| quick | 2 | 3 | 6 | 0 | 120s |',
    '| standard | 6 | 12 | 14 | 1 | 240s |',
    '| deep | 16 | 30 | 28 | 1 | 360s |',
    '',
  ].join('\n')
  const budgets = parseReadmeBudgets(markdown)
  assert.deepEqual(budgets.quick, { queries: 2, pages: 3, llmCalls: 6, gapRounds: 0, wallMs: 120000 })
  assert.equal(budgets.deep.wallMs, 360000)
  assert.equal(parseReadmeBudgets('没有表格'), null)
})

test('staleTestCounts flags hardcoded example counts', () => {
  assert.deepEqual(staleTestCounts('逐文件跑全部 352 例测试'), [{ count: 352, snippet: '352 例' }])
  assert.deepEqual(staleTestCounts('逐文件跑全部测试'), [])
  assert.deepEqual(staleTestCounts('0.9.5 起 19 个文件'), [])
})

test('checkRelease keeps version, CHANGELOG, budgets and doc counts in sync', () => {
  const { passes, failures, notes } = checkRelease(root)
  assert.deepEqual(failures, [])
  assert.ok(passes.length >= 4, `expected several checks to run, got ${passes.length}`)
  assert.ok(Array.isArray(notes))
})

test('checkRelease fails when the README budget table drifts from the code', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-release-'))
  try {
    mkdirSync(join(dir, 'lib'))
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '9.9.9', name: 'fixture' }))
    writeFileSync(
      join(dir, 'CHANGELOG.md'),
      '# Changelog\n\n## [Unreleased]\n\n## [9.9.9] - 2026-01-01\n\n- ship it\n'
    )
    writeFileSync(
      join(dir, 'lib/pipeline.js'),
      'export const DEPTH_PROFILES = {\n  quick: { wallMs: 120000 },\n  standard: { wallMs: 240000 },\n  deep: { wallMs: 360000 },\n}\n'
    )
    writeFileSync(
      join(dir, 'README.md'),
      '| depth | queries | pages | LLM 轮 | 补搜轮 | 墙钟 |\n|---|---|---|---|---|---|\n| quick | 2 | 3 | 6 | 0 | 90s |\n| standard | 6 | 12 | 14 | 1 | 180s |\n| deep | 16 | 30 | 28 | 1 | 300s |\n'
    )
    const { failures } = checkRelease(dir)
    assert.ok(
      failures.some((line) => line.includes('预算不一致（quick.wallMs）')),
      failures.join('\n')
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})