#!/usr/bin/env node
/**
 * 仓库整洁性检查（零依赖，CI 与本地共用）
 *
 *   node scripts/check-docs.mjs
 *
 * 检查四件事：
 *   1. 企业级仓库需要的文件都在（README / CHANGELOG / 社区文件 / docs / 模板）；
 *   2. README、docs/、CONTRIBUTING、SECURITY、HANDOFF 里的相对链接都能解析；
 *   3. CHANGELOG 有 [Unreleased] 段，且有与 package.json 版本一致的条目；
 *   4. package.json 元数据齐全、运行时依赖为空。
 *
 * 任何一项不通过就以非零码退出并列出具体文件，方便在 CI 里一眼看出哪里不整齐。
 * `checkRepository()` 同时被 test/repo-hygiene.test.js 直接调用，测试不落盘、不起子进程。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const REQUIRED_FILES = [
  'README.md',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'CODE_OF_CONDUCT.md',
  'SECURITY.md',
  'LICENSE',
  'HANDOFF.md',
  '.editorconfig',
  '.gitattributes',
  '.gitignore',
  '.github/PULL_REQUEST_TEMPLATE.md',
  '.github/CODEOWNERS',
  '.github/ISSUE_TEMPLATE/bug_report.yml',
  '.github/ISSUE_TEMPLATE/feature_request.yml',
  '.github/ISSUE_TEMPLATE/question.yml',
  '.github/ISSUE_TEMPLATE/config.yml',
  '.github/workflows/ci.yml',
  '.github/workflows/release.yml',
  'docs/architecture.md',
  'docs/configuration.md',
  'docs/development.md',
  'docs/release.md',
  'docs/screenshots/01-card.png',
  'scripts/test-all.mjs',
  'scripts/check-docs.mjs',
  'scripts/release-notes.mjs',
]

const LINK_SCAN = [
  'README.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'CODE_OF_CONDUCT.md',
  'HANDOFF.md',
  'docs/architecture.md',
  'docs/configuration.md',
  'docs/development.md',
  'docs/release.md',
]

// [文字](目标 "可选标题") —— 图片语法 ![..](..) 也走这里
const LINK_PATTERN = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g

/**
 * @param {string} [root] 仓库根目录
 * @returns {{ passes: string[], failures: string[] }}
 */
export function checkRepository(root = DEFAULT_ROOT) {
  const passes = []
  const failures = []
  const pass = (message) => passes.push(message)
  const fail = (message) => failures.push(message)
  const read = (path) => readFileSync(join(root, path), 'utf8')

  // 1. 必需文件 -------------------------------------------------------------
  const missingFiles = REQUIRED_FILES.filter((file) => !existsSync(join(root, file)))
  for (const file of missingFiles) fail(`缺少必需文件：${file}`)
  if (!missingFiles.length) pass(`必需文件 ${REQUIRED_FILES.length} 项齐全`)

  // 2. Markdown 相对链接 ----------------------------------------------------
  let linkTotal = 0
  for (const file of LINK_SCAN) {
    if (!existsSync(join(root, file))) continue
    const body = read(file)
    LINK_PATTERN.lastIndex = 0
    let match
    while ((match = LINK_PATTERN.exec(body)) !== null) {
      const target = match[1]
      if (/^(https?:|mailto:|#)/i.test(target)) continue
      if (target.includes('{') || target.includes('<')) continue // 模板占位
      const [pathPart] = target.split('#')
      if (!pathPart) continue
      linkTotal += 1
      const resolved = pathPart.startsWith('/')
        ? join(root, pathPart)
        : resolve(dirname(join(root, file)), pathPart)
      if (!existsSync(resolved)) {
        fail(`${file} 的链接指向不存在的路径：${target}（解析为 ${relative(root, resolved)}）`)
      }
    }
  }
  if (linkTotal && !failures.length) pass(`Markdown 相对链接 ${linkTotal} 条全部可解析`)

  // 3. CHANGELOG ------------------------------------------------------------
  let version = ''
  try {
    version = JSON.parse(read('package.json')).version ?? ''
  } catch {
    fail('package.json 缺失或无法解析')
  }
  if (existsSync(join(root, 'CHANGELOG.md'))) {
    const changelog = read('CHANGELOG.md')
    if (!/^## \[Unreleased\]/m.test(changelog)) fail('CHANGELOG.md 缺少 `## [Unreleased]` 段')
    if (!version) {
      /* package.json 的问题上面已报 */
    } else if (!changelog.includes(`## [${version}]`)) {
      fail(`CHANGELOG.md 缺少当前版本条目 \`## [${version}]\`（发版前先写 CHANGELOG）`)
    } else {
      pass(`CHANGELOG 含当前版本条目 ${version}`)
    }
  }

  // 4. package.json ---------------------------------------------------------
  let pkg = null
  if (version) {
    try {
      pkg = JSON.parse(read('package.json'))
    } catch {
      /* 上面已报 */
    }
  }
  if (pkg) {
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
    if (Object.keys(deps).length) fail(`package.json 不应有依赖（当前：${Object.keys(deps).join(', ')}）`)
    else pass('零依赖')

    const pick = (path) => path.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), pkg)
    const metadata = [
      ['description', (value) => typeof value === 'string' && value.trim().length > 0],
      ['license', (value) => value === 'MIT'],
      ['repository.url', (value) => typeof value === 'string' && /^git\+https:\/\/github\.com\/.+\.git$/.test(value)],
      ['homepage', (value) => typeof value === 'string' && /^https:\/\/github\.com\/\S+$/.test(value)],
      ['bugs.url', (value) => typeof value === 'string' && value.startsWith('https://github.com/')],
      ['author', (value) => typeof value === 'string' && value.trim().length > 0],
      ['engines.node', (value) => typeof value === 'string' && value.includes('>=')],
    ]
    const missing = metadata.filter(([path, valid]) => !valid(pick(path))).map(([path]) => path)
    if (missing.length) fail(`package.json 元数据不完整：${missing.join('、')}`)
    else pass('package.json 元数据完整')

    const scripts = pkg.scripts ?? {}
    const missingScripts = ['test', 'e2e', 'retrieval-check'].filter((name) => !scripts[name])
    if (missingScripts.length) fail(`package.json 缺少 npm scripts：${missingScripts.join('、')}`)
    else pass('npm scripts 齐全')

    const files = Array.isArray(pkg.files) ? pkg.files : []
    const missingEntries = ['index.js', 'client.js', 'lib', 'README.md', 'CHANGELOG.md', 'LICENSE'].filter(
      (entry) => !files.includes(entry),
    )
    if (missingEntries.length) fail(`package.json 的 files 应包含：${missingEntries.join('、')}`)
    else {
      const absent = files.filter((entry) => !existsSync(join(root, entry)))
      if (absent.length) fail(`package.json files 指向不存在的路径：${absent.join('、')}`)
      else pass('package.json files 指向的路径都存在')
    }
  }

  return { passes, failures }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isMain) {
  const { passes, failures } = checkRepository()
  for (const line of passes) console.log(`✔ ${line}`)
  if (failures.length) {
    for (const line of failures) console.error(`✘ ${line}`)
    console.error(`\n仓库整洁性检查未通过：${failures.length} 项`)
    process.exit(1)
  }
  console.log('\n✔ 仓库整洁性检查通过')
}