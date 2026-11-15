#!/usr/bin/env node
/**
 * 仓库整洁性检查（零依赖，CI 与本地共用）
 *
 *   node scripts/check-docs.mjs
 *
 * 检查七件事：
 *   1. 企业级仓库需要的文件都在（README / CHANGELOG / 社区文件 / docs / 模板）；
 *   2. README、docs/、CONTRIBUTING、SECURITY、HANDOFF 里的相对链接都能解析；
 *   3. CHANGELOG 有 [Unreleased] 段，且有与 package.json 版本一致的条目；
 *   4. package.json 元数据齐全、运行时依赖为空；
 *   5. Issue 表单（.github/ISSUE_TEMPLATE/*.yml）的必填键与 body 类型合法，否则 GitHub 会静默不显示模板；
 *   6. README 的参数表与 index.js 里 research 工具的 parameters 一致（新参数不写进 README 就是文档漂移）；
 *   7. Markdown 里标成 ```json 的示例都能解析（示例是给人复制去跑的，语法错等于没写）。
 *
 * 任何一项不通过就以非零码退出并列出具体文件，方便在 CI 里一眼看出哪里不整齐。
 * `checkRepository()` 同时被 test/repo-hygiene.test.js 直接调用，测试不落盘、不起子进程。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
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
  'scripts/check-release.mjs',
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

const BODY_TYPES = new Set(['markdown', 'input', 'textarea', 'dropdown', 'checkboxes'])

/**
 * 从 index.js 里取出 research 工具 `parameters: { … }` 的顶层键名。
 * 只做花括号配对 + 行首键名识别，不解析 JS —— 参数定义是字面量对象，够用且零依赖。
 * @param {string} source index.js 源码
 * @returns {string[]}
 */
export function toolParamNames(source) {
  const marker = /\bparameters:\s*\{/.exec(source)
  if (!marker) return []
  const open = source.indexOf('{', marker.index)
  let depth = 0
  let end = source.length
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  const block = source.slice(open + 1, end)
  const names = []
  let level = 0
  for (const line of block.split('\n')) {
    if (level === 0) {
      const key = /^\s*([A-Za-z_$][\w$]*)\s*:/.exec(line)
      if (key) names.push(key[1])
    }
    for (const ch of line) {
      if (ch === '{') level += 1
      else if (ch === '}') level -= 1
    }
  }
  return [...new Set(names)]
}

/**
 * 从 README 的「## 参数」表里取出参数名（表格行首列的 `code` 名）。
 * @param {string} markdown
 * @returns {string[]}
 */
export function documentedParams(markdown) {
  const lines = markdown.split('\n')
  const start = lines.findIndex((line) => /^##\s*参数\s*$/.test(line))
  if (start < 0) return []
  const names = []
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i])) break
    const row = /^\|\s*`([A-Za-z][\w]*)`\s*\|/.exec(lines[i])
    if (row) names.push(row[1])
  }
  return names
}

/**
 * README 参数表必须覆盖工具的全部参数，且不能列出工具没有的参数。
 * 这是最容易被忽略的文档漂移：新参数只在代码里加、README 没跟上，用户根本不知道有这个开关。
 * @param {string} root
 * @param {{ fail: (m: string) => void, pass: (m: string) => void }} report
 */
export function checkToolParams(root, report) {
  const indexPath = join(root, 'index.js')
  const readmePath = join(root, 'README.md')
  if (!existsSync(indexPath) || !existsSync(readmePath)) return
  const names = toolParamNames(readFileSync(indexPath, 'utf8'))
  if (!names.length) {
    report.fail('index.js 里找不到 research 工具的 `parameters: { … }` 定义')
    return
  }
  const documented = documentedParams(readFileSync(readmePath, 'utf8'))
  if (!documented.length) {
    report.fail('README.md 里找不到「## 参数」表（工具参数必须在 README 里列全）')
    return
  }
  const missing = names.filter((name) => !documented.includes(name))
  const extra = documented.filter((name) => !names.includes(name))
  if (missing.length) report.fail(`README 参数表缺少工具参数：${missing.join('、')}`)
  if (extra.length) report.fail(`README 参数表列出了工具没有的参数：${extra.join('、')}`)
  if (!missing.length && !extra.length) report.pass(`README 参数表与工具参数一致（${names.length} 个）`)
}

/**
 * Markdown 里标成 ```json 的代码块必须能 JSON.parse —— 示例是给人复制去跑的。
 * @param {string} root
 * @param {{ fail: (m: string) => void, pass: (m: string) => void }} report
 */
export function checkJsonBlocks(root, report) {
  let total = 0
  const problems = []
  for (const file of LINK_SCAN) {
    if (!existsSync(join(root, file))) continue
    const body = readFileSync(join(root, file), 'utf8')
    const fence = '```'
    const pattern = new RegExp(`${fence}json\\s*\\n([\\s\\S]*?)${fence}`, 'g')
    let match
    let index = 0
    while ((match = pattern.exec(body)) !== null) {
      index += 1
      total += 1
      try {
        JSON.parse(match[1])
      } catch (error) {
        problems.push(`${file} 第 ${index} 个 \`json\` 代码块无法解析：${error.message}`)
      }
    }
  }
  for (const problem of problems) report.fail(problem)
  if (total && !problems.length) report.pass(`Markdown 里的 JSON 示例 ${total} 段都能解析`)
}

/**
 * Issue 模板是 YAML，但没有引依赖就不做完整解析：只校验 GitHub Issue Forms 必需的
 * 顶层键与 `body[].type` 白名单，能挡住「模板写坏 → 仓库页面上一个模板都不显示」这类问题。
 * @param {string} root
 * @param {{ fail: (m: string) => void, pass: (m: string) => void }} report
 */
function checkIssueTemplates(root, report) {
  const dir = join(root, '.github', 'ISSUE_TEMPLATE')
  if (!existsSync(dir)) return
  const forms = readdirSync(dir).filter((file) => file.endsWith('.yml') || file.endsWith('.yaml'))
  const problems = []
  let checked = 0

  for (const file of forms) {
    if (file === 'config.yml') continue
    checked += 1
    const body = readFileSync(join(dir, file), 'utf8')
    for (const [key, label] of [['name', 'name'], ['description', 'description'], ['body', 'body']]) {
      if (!new RegExp(`^${key}:\\s*\\S`, 'm').test(body)) {
        problems.push(`.github/ISSUE_TEMPLATE/${file} 缺少必填顶层键 ${label}`)
      }
    }
    const types = [...body.matchAll(/^\s*-\s*type:\s*([A-Za-z_]+)/gm)].map((m) => m[1])
    if (!types.length) problems.push(`.github/ISSUE_TEMPLATE/${file} 的 body 里没有任何 \`- type:\``)
    const unknown = [...new Set(types.filter((type) => !BODY_TYPES.has(type)))]
    if (unknown.length) {
      problems.push(`.github/ISSUE_TEMPLATE/${file} 有未知的 body 类型：${unknown.join('、')}（允许 ${[...BODY_TYPES].join('/')}）`)
    }
    const ids = [...body.matchAll(/^\s*id:\s*([A-Za-z0-9_-]+)/gm)].map((m) => m[1])
    const duplicated = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))]
    if (duplicated.length) problems.push(`.github/ISSUE_TEMPLATE/${file} 的 id 重复：${duplicated.join('、')}`)
  }

  const configPath = join(dir, 'config.yml')
  if (existsSync(configPath)) {
    const config = readFileSync(configPath, 'utf8')
    if (!/^blank_issues_enabled:/m.test(config)) {
      problems.push('.github/ISSUE_TEMPLATE/config.yml 缺少 blank_issues_enabled')
    }
    checked += 1
  }

  for (const problem of problems) report.fail(problem)
  if (checked && !problems.length) report.pass(`Issue 模板 ${checked} 个结构完整`)
}

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

  // 5. Issue 模板 ------------------------------------------------------------
  checkIssueTemplates(root, { fail, pass })

  // 6. README 参数表 ↔ 工具参数 ------------------------------------------------
  checkToolParams(root, { fail, pass })

  // 7. JSON 示例可解析 --------------------------------------------------------
  checkJsonBlocks(root, { fail, pass })

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