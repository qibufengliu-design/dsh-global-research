import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  checkDocsIndex,
  checkDocumentedCommands,
  checkJsonBlocks,
  checkLeaks,
  checkRepository,
  checkToolParams,
  checkWorkflows,
  documentedCommands,
  documentedParams,
  scanLeaks,
  toolParamNames,
} from '../scripts/check-docs.mjs'
import {
  checkRelease,
  parseDepthProfiles,
  parseReadmeBudgets,
  parseRetrievalVersion,
  releaseSections,
  staleTestCounts,
} from '../scripts/check-release.mjs'
import { extractReleaseNotes } from '../scripts/release-notes.mjs'
import { normalizeBody, parseRepository, releaseBodyMatches } from '../scripts/verify-release.mjs'

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

test('toolParamNames reads the research tool parameters in order', () => {
  const source = [
    'ctx.tools.register({',
    "  name: 'research',",
    '  parameters: {',
    "    question: { type: 'string', required: true },",
    "    depth: { type: 'string', enum: ['auto'] },",
    "    text: { type: 'string', description: 'nested { brace }' },",
    '  },',
    "  output: { schema: OUTPUT_SCHEMA, render: () => [] },",
    '})',
    '',
  ].join('\n')
  assert.deepEqual(toolParamNames(source), ['question', 'depth', 'text'])
  assert.deepEqual(toolParamNames('const x = 1'), [])
})

test('documentedParams reads the README parameter table only', () => {
  const markdown = [
    '## 参数',
    '',
    '| 参数 | 必填 | 说明 |',
    '|---|---|---|',
    '| `question` | 是 | 问题 |',
    '| `text` | 否 | 资料 |',
    '',
    '## 预算',
    '',
    '| `notAParam` | x | y |',
    '',
  ].join('\n')
  assert.deepEqual(documentedParams(markdown), ['question', 'text'])
  assert.deepEqual(documentedParams('没有参数表'), [])
})

test('checkToolParams catches parameters that never made it into the README', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-params-'))
  try {
    writeFileSync(
      join(dir, 'index.js'),
      [
        'ctx.tools.register({',
        '  parameters: {',
        "    question: { type: 'string' },",
        "    text: { type: 'string' },",
        '  },',
        '})',
        '',
      ].join('\n')
    )
    writeFileSync(
      join(dir, 'README.md'),
      '## 参数\n\n| 参数 | 必填 | 说明 |\n|---|---|---|\n| `question` | 是 | 问题 |\n| `ghost` | 否 | 工具里没有 |\n'
    )
    const failures = []
    checkToolParams(dir, { fail: (line) => failures.push(line), pass: () => {} })
    assert.ok(
      failures.some((line) => line.includes('缺少工具参数：text')),
      failures.join('\n')
    )
    assert.ok(
      failures.some((line) => line.includes('列出了工具没有的参数：ghost')),
      failures.join('\n')
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('checkJsonBlocks rejects fenced JSON examples that do not parse', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-json-'))
  try {
    writeFileSync(join(dir, 'README.md'), '```json\n{ "tool": "install_bundle", }\n```\n')
    const failures = []
    checkJsonBlocks(dir, { fail: (line) => failures.push(line), pass: () => {} })
    assert.equal(failures.length, 1, failures.join('\n'))
    assert.match(failures[0], /README\.md 第 1 个 `json` 代码块无法解析/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('documentedCommands finds the scripts a doc promises readers can run', () => {
  const markdown = [
    '```bash',
    'node scripts/test-all.mjs',
    'node scripts/check-docs.mjs',
    'npm run test',
    'node scripts/test-all.mjs',
    '```',
    '',
  ].join('\n')
  assert.deepEqual(documentedCommands(markdown), {
    files: ['scripts/check-docs.mjs', 'scripts/test-all.mjs'],
    scripts: ['test'],
  })
  assert.deepEqual(documentedCommands('没有命令'), { files: [], scripts: [] })
})

test('checkDocumentedCommands flags commands that no longer exist', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-commands-'))
  try {
    mkdirSync(join(dir, 'scripts'))
    writeFileSync(join(dir, 'scripts/test-all.mjs'), '// fixture\n')
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '1.2.3', scripts: { test: 'x' } }))
    writeFileSync(
      join(dir, 'README.md'),
      '```bash\nnode scripts/test-all.mjs\nnode scripts/removed-script.mjs\nnpm run e2e\n```\n'
    )
    const failures = []
    checkDocumentedCommands(dir, { fail: (line) => failures.push(line), pass: () => {} })
    assert.ok(
      failures.some((line) => line.includes('文档里写到的脚本不存在：scripts/removed-script.mjs')),
      failures.join('\n')
    )
    assert.ok(
      failures.some((line) => line.includes('文档里写到的 npm script 不存在：e2e')),
      failures.join('\n')
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('scanLeaks finds pasted tokens and local machine paths', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-leaks-'))
  try {
    // 拆开拼，避免这个测试文件自己变成泄露扫描的命中项
    const fakeToken = ['ghp', 'A'.repeat(30)].join('_')
    writeFileSync(join(dir, 'notes.md'), `token: ${fakeToken}\n见 D:\\Users\\someone\\work\n`)
    writeFileSync(join(dir, 'clean.md'), '# 干净的文件\n')
    const { scanned, findings } = scanLeaks(dir)
    assert.equal(scanned, 2)
    assert.ok(
      findings.some((finding) => finding.file === 'notes.md' && finding.kind === 'GitHub classic token'),
      JSON.stringify(findings)
    )
    assert.ok(
      findings.some((finding) => finding.file === 'notes.md' && finding.kind.includes('本机绝对路径')),
      JSON.stringify(findings)
    )
    assert.ok(!findings.some((finding) => finding.file === 'clean.md'), JSON.stringify(findings))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('checkLeaks passes a tree without secrets', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-noleak-'))
  try {
    writeFileSync(join(dir, 'README.md'), '# 标题\n\n`node scripts/test-all.mjs`\n')
    const passes = []
    const failures = []
    checkLeaks(dir, { fail: (line) => failures.push(line), pass: (line) => passes.push(line) })
    assert.deepEqual(failures, [])
    assert.ok(passes.some((line) => line.includes('没有密钥或本机绝对路径')), passes.join('\n'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('checkDocsIndex flags a docs page nobody links to', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-docsindex-'))
  try {
    mkdirSync(join(dir, 'docs'))
    writeFileSync(join(dir, 'README.md'), '# 标题\n\n| [architecture](docs/architecture.md) | 架构 |\n')
    writeFileSync(join(dir, 'docs/architecture.md'), '# 架构\n')
    writeFileSync(join(dir, 'docs/orphan.md'), '# 没人链的文档\n')
    const failures = []
    const passes = []
    checkDocsIndex(dir, { fail: (line) => failures.push(line), pass: (line) => passes.push(line) })
    assert.deepEqual(failures, ['docs 文档没有从 README 链到：docs/orphan.md'])
    assert.deepEqual(passes, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('checkDocsIndex passes when every page is linked', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-docsindex-ok-'))
  try {
    mkdirSync(join(dir, 'docs'))
    writeFileSync(join(dir, 'README.md'), '# 标题\n\n见 [docs/a.md](docs/a.md) 与 [docs/b.md#节](docs/b.md#节)。\n')
    writeFileSync(join(dir, 'docs/a.md'), '# A\n')
    writeFileSync(join(dir, 'docs/b.md'), '# B\n')
    const failures = []
    const passes = []
    checkDocsIndex(dir, { fail: (line) => failures.push(line), pass: (line) => passes.push(line) })
    assert.deepEqual(failures, [])
    assert.deepEqual(passes, ['docs/2 篇文档都能从 README 链到'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('checkWorkflows flags the mistakes GitHub only reports by never running', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-wf-'))
  try {
    mkdirSync(join(dir, '.github', 'workflows'), { recursive: true })
    writeFileSync(
      join(dir, '.github', 'workflows', 'tabbed.yml'),
      ['name: Tabbed', 'on: push', 'jobs:', '  build:', '\truns-on: ubuntu-latest', ''].join('\n'),
    )
    writeFileSync(
      join(dir, '.github', 'workflows', 'norunson.yml'),
      ['name: NoRunner', 'on: push', 'jobs:', '  build:', '    steps:', '      - run: echo hi', ''].join('\n'),
    )
    const failures = []
    const passes = []
    checkWorkflows(dir, { fail: (line) => failures.push(line), pass: (line) => passes.push(line) })
    assert.ok(failures.some((line) => line.includes('制表符缩进')), failures.join('\n'))
    assert.ok(failures.some((line) => line.includes('job `build`')), failures.join('\n'))
    assert.deepEqual(passes, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('checkWorkflows passes the workflows this repository ships', () => {
  const failures = []
  const passes = []
  checkWorkflows(root, { fail: (line) => failures.push(line), pass: (line) => passes.push(line) })
  assert.deepEqual(failures, [])
  assert.equal(passes.length, 1)
  assert.match(passes[0], /个 workflow 结构完整/)
})

function makeReleaseFixture({ version = '1.2.3', changelog, retrievalVersion } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-release-'))
  mkdirSync(join(dir, 'lib'), { recursive: true })
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', version }))
  writeFileSync(
    join(dir, 'CHANGELOG.md'),
    changelog ??
      [
        '# Changelog',
        '',
        '## [Unreleased]',
        '',
        `## [${version}] - 2026-02-02`,
        '',
        '- 当前版本',
        '',
        '## [1.2.2] - 2026-01-01',
        '',
        '- 上一版',
        '',
      ].join('\n'),
  )
  writeFileSync(
    join(dir, 'lib/pipeline.js'),
    'export const DEPTH_PROFILES = {\n  quick: { queries: 2, pages: 3, llmCalls: 6, gapRounds: 0, wallMs: 120000 },\n  standard: { queries: 6, pages: 12, llmCalls: 14, gapRounds: 1, wallMs: 240000 },\n  deep: { queries: 16, pages: 30, llmCalls: 28, gapRounds: 1, wallMs: 360000 },\n}\n',
  )
  writeFileSync(
    join(dir, 'README.md'),
    [
      '| depth | queries | pages | LLM 轮 | 补搜轮 | 墙钟 |',
      '|---|---|---|---|---|---|',
      '| quick | 2 | 3 | 6 | 0 | 120s |',
      '| standard | 6 | 12 | 14 | 1 | 240s |',
      '| deep | 16 | 30 | 28 | 1 | 360s |',
      '',
    ].join('\n'),
  )
  writeFileSync(
    join(dir, 'scripts/retrieval-check.mjs'),
    `export const VERSION = '${retrievalVersion ?? version}'\nexport const DEPTHS = ['quick', 'standard', 'deep']\n`,
  )
  return dir
}

test('checkRelease flags a CHANGELOG that is one version behind package.json', () => {
  const dir = makeReleaseFixture({
    version: '1.2.3',
    changelog: ['# Changelog', '', '## [Unreleased]', '', '## [1.2.4] - 2026-03-03', '', '- 新', '', '## [1.2.3] - 2026-02-02', '', '- 旧', ''].join('\n'),
  })
  try {
    const { failures } = checkRelease(dir)
    assert.ok(
      failures.some((line) => line.includes('最上面的版本小节是 1.2.4')),
      failures.join('\n'),
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('checkRelease catches retrieval-check VERSION drifting from package.json', () => {
  const dir = makeReleaseFixture({ version: '1.2.3', retrievalVersion: '1.2.2' })
  try {
    const { failures } = checkRelease(dir)
    assert.ok(
      failures.some((line) => line.includes('VERSION 是 1.2.2')),
      failures.join('\n'),
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('parseRetrievalVersion reads the exported constant', () => {
  assert.equal(parseRetrievalVersion("export const VERSION = '1.0.0'\n"), '1.0.0')
  assert.equal(parseRetrievalVersion('export const DEPTHS = []\n'), null)
})

test('normalizeBody irons out line endings and trailing blanks', () => {
  assert.equal(normalizeBody('a  \r\nb\r\n\r\n'), 'a\nb')
  assert.equal(normalizeBody(undefined), '')
})

test('releaseBodyMatches compares a release page against the tagged CHANGELOG section', () => {
  const changelog = [
    '# Changelog',
    '',
    '## [Unreleased]',
    '',
    '## [1.2.3] - 2026-01-01',
    '',
    '### Added',
    '',
    '- 一件小事',
    '',
    '## [1.2.2] - 2025-12-31',
    '',
    '- 旧事',
    '',
  ].join('\n')
  const good = releaseBodyMatches(changelog, '### Added\n\n- 一件小事\n', 'v1.2.3')
  assert.equal(good.ok, true)
  const stale = releaseBodyMatches(changelog, '### Added\n\n- 另一件事\n', '1.2.3')
  assert.equal(stale.ok, false)
  assert.match(stale.reason, /不一致/)
  assert.equal(releaseBodyMatches(changelog, '### Added\n\n- x\n', '9.9.9').ok, false)
  assert.match(releaseBodyMatches(changelog, '', '1.2.3').reason, /正文是空的/)
})

test('parseRepository reads owner/repo out of the package metadata', () => {
  assert.deepEqual(
    parseRepository({ repository: { url: 'git+https://github.com/qibufengliu-design/dsh-global-research.git' } }),
    { owner: 'qibufengliu-design', repo: 'dsh-global-research' }
  )
  assert.equal(parseRepository({}), null)
  assert.equal(parseRepository({ repository: { url: 'https://gitlab.com/a/b.git' } }), null)
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