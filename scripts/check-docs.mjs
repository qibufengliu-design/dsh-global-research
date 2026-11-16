#!/usr/bin/env node
/**
 * 仓库整洁性检查（零依赖，CI 与本地共用）
 *
 *   node scripts/check-docs.mjs
 *
 * 检查十一件事：
 *   1. 企业级仓库需要的文件都在（README / CHANGELOG / 社区文件 / docs / 模板）；
 *   2. README、docs/、CONTRIBUTING、SECURITY、HANDOFF 里的相对链接都能解析；
 *   3. CHANGELOG 有 [Unreleased] 段，且有与 package.json 版本一致的条目；
 *   4. package.json 元数据齐全、运行时依赖为空；
 *   5. Issue 表单（.github/ISSUE_TEMPLATE/*.yml）的必填键与 body 类型合法，否则 GitHub 会静默不显示模板；
 *   6. README 的参数表与 index.js 里 research 工具的 parameters 一致（新参数不写进 README 就是文档漂移）；
 *   7. Markdown 里标成 ```json 的示例都能解析（示例是给人复制去跑的，语法错等于没写）；
 *   8. 文档里写到的 `node scripts/*.mjs` 与 `npm run <script>` 都真实存在（脚本改名后文档没跟，用户照着跑就报错）；
 *   9. 仓库里没有真密钥（GitHub/AWS/OpenAI 等 token、私有密钥块），也没有把本机绝对路径抄进文档；
 *   10. `docs/` 下每篇文档都能从 README 的文档索引链到（新写一页却没人能发现，等于没写）；
 *   11. `.github/workflows/` 里每个 workflow 结构完整（GitHub 对坏 workflow 只是静默不跑）。
 *
 * 任何一项不通过就以非零码退出并列出具体文件，方便在 CI 里一眼看出哪里不整齐。
 * `checkRepository()` 同时被 test/repo-hygiene.test.js 直接调用，测试不落盘、不起子进程。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, posix, relative, resolve } from 'node:path'
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
  '.github/workflows/codeql.yml',
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
  'scripts/verify-release.mjs',
  'scripts/eval.mjs',
  'scripts/lib/harness.mjs',
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
  'docs/design/README.md',
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
 * 从 Markdown 里取出文档承诺可跑的 `node scripts/*.mjs` 与 `npm run <script>`。
 * 脚本改名/删掉之后文档最容易忘了跟，用户照着复制就报错。
 * @param {string} markdown
 * @returns {{ files: string[], scripts: string[] }}
 */
export function documentedCommands(markdown) {
  const files = new Set()
  const scripts = new Set()
  for (const match of markdown.matchAll(/node\s+(scripts\/[\w.-]+\.mjs)/g)) files.add(match[1])
  for (const match of markdown.matchAll(/npm\s+run\s+([\w:-]+)/g)) scripts.add(match[1])
  return { files: [...files].sort(), scripts: [...scripts].sort() }
}

/**
 * 文档里出现的脚本命令必须真的存在：`node scripts/x.mjs` 指向的文件在仓库里、
 * `npm run x` 在 package.json 的 scripts 里有。
 * @param {string} root
 * @param {{ fail: (m: string) => void, pass: (m: string) => void }} report
 */
export function checkDocumentedCommands(root, report) {
  const problems = []
  const missingFiles = new Set()
  const missingScripts = new Set()
  let total = 0

  let availableScripts = new Set()
  if (existsSync(join(root, 'package.json'))) {
    try {
      availableScripts = new Set(Object.keys(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts ?? {}))
    } catch {
      /* package.json 解析失败已在第 4 项报过 */
    }
  }

  for (const file of LINK_SCAN) {
    if (!existsSync(join(root, file))) continue
    const { files, scripts } = documentedCommands(readFileSync(join(root, file), 'utf8'))
    for (const target of files) {
      total += 1
      if (!existsSync(join(root, target))) missingFiles.add(`${target}（${file}）`)
    }
    for (const name of scripts) {
      total += 1
      if (availableScripts.size && !availableScripts.has(name)) missingScripts.add(`${name}（${file}）`)
    }
  }

  for (const target of missingFiles) problems.push(`文档里写到的脚本不存在：${target}`)
  for (const name of missingScripts) problems.push(`文档里写到的 npm script 不存在：${name}`)
  for (const problem of problems) report.fail(problem)
  if (total && !problems.length) report.pass(`文档里写到的脚本命令 ${total} 条都存在`)
}

/** 贴进仓库就会变成事故的字符串：真密钥、私有密钥块、本机绝对路径。 */
const SECRET_PATTERNS = [
  { kind: 'GitHub classic token', pattern: /ghp_[A-Za-z0-9]{20,}/ },
  { kind: 'GitHub fine-grained token', pattern: /github_pat_[A-Za-z0-9_]{20,}/ },
  { kind: 'OpenAI 风格密钥', pattern: /sk-[A-Za-z0-9]{20,}/ },
  { kind: 'AWS access key', pattern: /AKIA[0-9A-Z]{16}/ },
  { kind: '私有密钥块', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
]

const LEAK_SCAN_EXTENSIONS = new Set(['.js', '.cjs', '.mjs', '.json', '.md', '.ps1', '.sh', '.txt', '.yaml', '.yml'])
const LEAK_SCAN_SKIP = new Set(['node_modules', '.git', '.cache', 'coverage'])
// 文档里抄进自己的机器路径（盘符 + Users/Total），别人照着跑会找不到东西
const LOCAL_PATH_PATTERN = /[A-Za-z]:\\(?:Users|Total)\\/
// HANDOFF.md 是给「这台机器上的下一位维护者」的交接笔记，本机路径在那里是必要信息，
// 其余面向读者的文档（README/docs/CONTRIBUTING）必须用相对路径或占位示例。
const LOCAL_PATH_ALLOWED = new Set(['HANDOFF.md'])

/**
 * 扫一遍仓库里的文本文件，找真密钥与本机绝对路径。
 * @param {string} root
 * @returns {{ scanned: number, findings: { file: string, kind: string }[] }}
 */
export function scanLeaks(root) {
  const findings = []
  let scanned = 0

  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (LEAK_SCAN_SKIP.has(entry.name)) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      const ext = entry.name.slice(entry.name.lastIndexOf('.'))
      if (!LEAK_SCAN_EXTENSIONS.has(ext)) continue
      const rel = relative(root, full).replaceAll('\\', '/')
      let body
      try {
        body = readFileSync(full, 'utf8')
      } catch {
        continue
      }
      scanned += 1
      for (const { kind, pattern } of SECRET_PATTERNS) {
        if (pattern.test(body)) findings.push({ file: rel, kind })
      }
      if (!LOCAL_PATH_ALLOWED.has(rel) && LOCAL_PATH_PATTERN.test(body)) {
        findings.push({ file: rel, kind: '本机绝对路径（Windows 盘符 + Users/Total）' })
      }
    }
  }

  walk(root)
  return { scanned, findings }
}

/**
 * 第 9 项：仓库里不能有真密钥，也不能把本机绝对路径抄进文档。
 * @param {string} root
 * @param {{ fail: (m: string) => void, pass: (m: string) => void }} report
 */
export function checkLeaks(root, report) {
  const { scanned, findings } = scanLeaks(root)
  for (const finding of findings) report.fail(`疑似泄露（${finding.kind}）：${finding.file}`)
  if (!findings.length) report.pass(`${scanned} 个文本文件没有密钥或本机绝对路径`)
}

/**
 * 第 10 项：`docs/` 下（含子目录）的每篇文档都必须能从 README 的文档索引链到，
 * 或者从它所在目录的 `README.md` 索引链到；子目录的索引本身必须能从根 README 链到。
 * 新写一页 docs 却没人能发现，等于没写。
 * @param {string} root
 * @param {{ fail: (m: string) => void, pass: (m: string) => void }} report
 */
export function checkDocsIndex(root, report) {
  const docsDir = join(root, 'docs')
  if (!existsSync(docsDir)) return

  const pages = []
  const indexes = []
  const walk = (relDir) => {
    for (const entry of readdirSync(join(root, relDir), { withFileTypes: true })) {
      const rel = `${relDir}/${entry.name}`
      if (entry.isDirectory()) walk(rel)
      else if (entry.isFile() && entry.name.endsWith('.md')) {
        if (entry.name === 'README.md' && relDir !== 'docs') indexes.push(rel)
        else pages.push(rel)
      }
    }
  }
  walk('docs')
  pages.sort()
  if (!pages.length) return

  const readmePath = join(root, 'README.md')
  if (!existsSync(readmePath)) return

  /** 读取一个索引文件里的相对链接，按该文件所在目录解析成仓库相对路径。 */
  const linksOf = (file) => {
    const dir = posix.dirname(file)
    const body = readFileSync(join(root, file), 'utf8')
    const linked = new Set()
    LINK_PATTERN.lastIndex = 0
    let match
    while ((match = LINK_PATTERN.exec(body)) !== null) {
      const [pathPart] = match[1].split('#')
      if (!pathPart || /^(?:[a-z]+:)?\/\//i.test(pathPart)) continue
      linked.add(posix.normalize(posix.join(dir === '.' ? '' : dir, pathPart.replaceAll('\\', '/'))))
    }
    return linked
  }

  const fromRoot = linksOf('README.md')
  const orphans = []
  const orphanIndexes = []
  for (const index of indexes) {
    if (!fromRoot.has(index)) orphanIndexes.push(index)
  }
  for (const page of pages) {
    if (fromRoot.has(page)) continue
    const localIndex = `${posix.dirname(page)}/README.md`
    if (indexes.includes(localIndex) && linksOf(localIndex).has(page)) continue
    orphans.push(page)
  }

  for (const index of orphanIndexes) report.fail(`docs 子目录索引没有从 README 链到：${index}`)
  for (const page of orphans) report.fail(`docs 文档没有从 README 或其所在目录索引链到：${page}`)
  const total = pages.length + indexes.length
  if (!orphanIndexes.length && !orphans.length) {
    report.pass(`docs/${total} 篇文档都能从 README 或所在目录索引链到`)
  }
}

/**
 * 第 11 项：`.github/workflows/` 里每个 workflow 的结构契约。
 * GitHub 对坏掉的 workflow 只是静默不跑，坏了没人知道，所以这里做最粗的结构检查：
 * 顶层 name/on/jobs、每个 job 有 runs-on 或 uses、没有 tab 缩进与行尾空白。
 * @param {string} root
 * @param {{ fail: (m: string) => void, pass: (m: string) => void }} report
 */
export function checkWorkflows(root, report) {
  const dir = join(root, '.github', 'workflows')
  if (!existsSync(dir)) {
    report.fail('缺少 .github/workflows 目录')
    return
  }
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort()
  if (!files.length) {
    report.fail('.github/workflows 里没有任何 workflow 文件')
    return
  }

  let broken = 0
  for (const file of files) {
    const fail = (why) => {
      broken += 1
      report.fail(`${file}：${why}`)
    }
    const text = readFileSync(join(dir, file), 'utf8')
    if (!text.endsWith('\n')) fail('文件结尾没有换行')
    if (text.includes('\r')) fail('用了 CRLF 换行（YAML 在 runner 上容易解析失败）')
    const lines = text.split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      if (/^\t/.test(lines[index])) {
        fail(`第 ${index + 1} 行用制表符缩进（YAML 禁止 tab 缩进）`)
        break
      }
      if (/[ \t]$/.test(lines[index])) {
        fail(`第 ${index + 1} 行有行尾空白`)
        break
      }
    }
    if (!/^name:/m.test(text)) fail('缺少顶层 `name:`')
    if (!/^on:/m.test(text)) fail('缺少触发条件 `on:`')
    if (!/^jobs:/m.test(text)) {
      fail('缺少 `jobs:`')
      continue
    }
    const jobsBody = text.slice(/^jobs:/m.exec(text).index)
    const jobStarts = [...jobsBody.matchAll(/^ {2}([A-Za-z0-9_-]+):[ \t]*$/gm)]
    if (!jobStarts.length) {
      fail('`jobs:` 下没有任何 job')
      continue
    }
    for (let index = 0; index < jobStarts.length; index += 1) {
      const from = jobStarts[index].index
      const to = index + 1 < jobStarts.length ? jobStarts[index + 1].index : jobsBody.length
      const body = jobsBody.slice(from, to)
      if (!/^\s+runs-on:/m.test(body) && !/^\s+uses:/m.test(body)) {
        fail(`job \`${jobStarts[index][1]}\` 既没有 \`runs-on:\` 也没有 \`uses:\``)
      }
    }
  }
  if (!broken) {
    report.pass(`${files.length} 个 workflow 结构完整（name / on / jobs，无 tab 缩进、无行尾空白）`)
  }
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
  let linkBroken = 0
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
        linkBroken += 1
        fail(`${file} 的链接指向不存在的路径：${target}（解析为 ${relative(root, resolved)}）`)
      }
    }
  }
  if (linkTotal && !linkBroken) pass(`Markdown 相对链接 ${linkTotal} 条全部可解析`)

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

  // 8. 文档里的脚本命令真实存在 ----------------------------------------------
  checkDocumentedCommands(root, { fail, pass })

  // 9. 没有密钥、没有本机绝对路径 --------------------------------------------
  checkLeaks(root, { fail, pass })

  // 10. docs 都能从 README 链到 ----------------------------------------------
  checkDocsIndex(root, { fail, pass })

  // 11. workflow 结构 --------------------------------------------------------
  checkWorkflows(root, { fail, pass })

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