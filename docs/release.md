# 发布

## 版本号规则

遵循 [Semantic Versioning 2.0](https://semver.org/lang/zh-CN/)，`package.json.version` 是唯一事实来源：

| 变更 | 版本位 | 例子 |
|---|---|---|
| 破坏兼容：工具参数语义变化、配置键重命名/删除、返回结构不兼容、置信度口径收紧 | MAJOR | `0.10.x → 1.0.0`（`0.x` 阶段曾用 MINOR 表达破坏性变更，`1.0.0` 起不再例外） |
| 新增能力：新参数、新通道、新垂直源、新简报章节、新分类 | MINOR | `0.9.0 → 0.10.0` |
| 修 bug、调文案、改提示词、补测试、仓库结构整理 | PATCH | `0.9.0 → 0.9.1` |

`0.x` 阶段按 DSH 插件生态惯例：破坏性变更也走 MINOR，并把「破坏点」写进 `CHANGELOG.md` 的 `### Changed`。**1.0.0 起这条惯例作废**——破坏性变更必须发 MAJOR，并写进 `### Breaking`（或 `### Breaking / Behaviour`）；行为变化即使不破坏接口，也要在 CHANGELOG 里点名（如 1.0.0 的 `confidence` 口径、时效题不走缓存、抓取失败按通道区分）。

## 发布清单

每版按顺序做完，缺一项不算发布：

1. **实现 + 测试**：`node scripts/test-all.mjs` 全绿，新增行为必须有测试。测试总数以脚本输出为准，不要在任何文档里写死数字。
2. **仓库整洁性与发布一致性**：`node scripts/check-docs.mjs`（必需文件、相对链接、CHANGELOG 版本条目、零依赖、package.json 元数据、Issue 表单结构、README 参数表与工具参数一致、JSON 示例可解析、文档里写到的 `node scripts/*.mjs` 与 `npm run <script>` 真实存在、没有密钥或本机绝对路径、`docs/` 都能从 README 链到、`.github/workflows/` 结构完整）与 `node scripts/check-release.mjs`（版本号与 CHANGELOG 小节、小节顺序、小节非空且不重复、`scripts/retrieval-check.mjs` 的 `VERSION` 与 `package.json` 同步、CHANGELOG 最上面一节不得比 `package.json` 旧、README 预算表与 `lib/pipeline.js` 的 `DEPTH_PROFILES` 一致、文档里没有写死的测试例数）都要通过。

   发版节奏上「先写新小节、再 bump 版本号」是被允许的：CHANGELOG 最上面一节比 `package.json` 新时只打一条提醒（发布提交里把版本号同步上去即可），只有**比 `package.json` 旧**才算漂移、判失败。
3. **真实网络回归**：至少跑一次 `retrieval-check`（A 题：RAG 选型）与一次 B/C 题；跑不动就记录「未运行 + 原因」，不允许编造结论。结论写到仓库外的工作笔记（本机在 `docs/superpowers/specs/` 同级的项目笔记目录），不提交进仓库。
4. **版本号**：改 `package.json.version`。
5. **CHANGELOG**：在 `CHANGELOG.md` 顶部新增 `## [x.y.z] - YYYY-MM-DD`，分类用 `Added` / `Changed` / `Fixed` / `Removed` / `Security`；写清「为什么」和实测数字，不只写「优化了 X」。
6. **文档同步**：README 的参数表、配置表、特性列表；`docs/` 对应页；配置项变化必须同步 `docs/configuration.md`；能力边界有变化时同步 `LIMITATIONS.md`（README 的「边界与已知限制」链到它，不要各写一份）。
7. **零依赖**：确认 `dependencies` / `devDependencies` 为空。
8. **提交**：Conventional Commits，一个版本一个 commit；提交作者必须是仓库主人身份（见下「提交身份」）。
9. **打 tag**：`git tag -a vX.Y.Z -m "vX.Y.Z：一句话"`，与 `package.json.version` 一致。**只打 annotated tag**。
10. **推送**：`git push origin main --follow-tags`，并在推送后核对远端 HEAD。
11. **核对**：`git ls-remote origin HEAD refs/heads/main refs/tags/*` 的 `refs/heads/main` 与本地 `HEAD` 相同，tag 已在远端。
12. **Release**：推送 tag 后 `.github/workflows/release.yml` 会自动用 `CHANGELOG.md` 里该版本的条目创建 GitHub Release；历史 tag 可在 Actions 里用 `workflow_dispatch` 补建（填 tag 名，不重打 tag）。补建路径检出 `main`（脚本与完整 CHANGELOG 都在 main），只校验 tag 存在且 CHANGELOG 有对应小节，不要求旧 tag 的 `package.json` 等于当前版本。
13. **核对 Release 正文**：`node scripts/verify-release.mjs vX.Y.Z` 会拉 Release 页与**该 tag 提交上的** `CHANGELOG.md` 比对（工作区可能有下一版改动，所以不拿工作区比）。正文与 CHANGELOG 小节不一致、Release 页不存在，都会非零退出。可选 `GITHUB_TOKEN` 只为放宽 API 限流。

## tag 规则

- **只打 annotated tag**：`git tag -a vX.Y.Z -m "..."`。轻量 tag 不带作者/日期/说明，在 `git describe` 与 Release 页面上信息缺失。
- **已推送的 tag 不移动、不删除**。发布后发现问题，按 SemVer 再发一个 PATCH，而不是 `git tag -f` + `push --force`。
  - 历史例外：`v0.9.2` 是早期留下的轻量 tag，指向 `67a8613`，保留原样不重打；`v0.9.3` 指向材料粘贴区提交，紧随其后的修复另发 `v0.9.4`，见 CHANGELOG 里的说明；`v1.0.0`、`v1.0.2`、`v1.1.0`、`v1.1.1` 也是轻量 tag（2026-11-16 由另一条会话直接 `git tag` 后推送，分别指向 `06171f5`、`f8a235f`、`7657960`、`b5ac7cd`），已生成的 Release 不受影响，同样**保留不重打**——1.0.1 起恢复只打 annotated。发布守门每次遇到新的轻量 tag 都在这里追加一条，并在 HANDOFF 的守门核实段记录。
- tag 必须指向 `package.json.version` 相同的提交，`release.yml` 会在发布前校验，不一致直接失败。
- tag 必须打在 `main` 上的提交：`release.yml` 用 `git merge-base --is-ancestor` 校验，分支上的提交即使打了 tag 也不会发版。
- 不发布预发布版本（`v1.0.0-rc.1` 之类）时，不要用 `v` 之外的前缀。

## 推送环境要求

Windows 上 git 走 schannel 时需要读取凭据库，沙箱内会报：

```text
schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS (0x8009030e)
```

因此推送命令需要 `sandbox_permissions: danger-full-access`，并建议显式指定 OpenSSL 后端：

```powershell
git -c http.sslBackend=openssl push origin main --follow-tags
```

确认远端状态（同样需要凭据）：

```powershell
git -c http.sslBackend=openssl ls-remote origin HEAD refs/heads/main refs/tags/*
```

`gh` CLI 未安装、也没有 `GITHUB_TOKEN` 时，仓库设置（描述、话题、分支保护、Wiki 开关）无法脚本化，只能手工在网页上做；这一点写进每版的交接记录，不要假装已完成。Release 由 Actions 里的 `GITHUB_TOKEN` 创建，不受此限制。

## 提交身份

仓库里不允许出现 `dev@local` 这类占位作者。本机没有全局 git 身份时，在仓库内配置（跟着仓库走，不污染全局）：

```powershell
git config user.name  "qibufengliu-design"
git config user.email "qibufengliu-design@users.noreply.github.com"
```

`git log --format='%an <%ae>' | Sort-Object -Unique` 只能出现这一个身份（历史里的 `dev <dev@local>` 是早期残留，不再新增）。

## 依赖与 Actions 版本

- 运行时依赖必须为空；`devDependencies` 同样保持为空，测试全部用 Node 内置 `node:test`。
- GitHub Actions 用形如 `actions/checkout@v7` 的**主版本**引用，由 Dependabot 按周提 PR 升级（`.github/dependabot.yml` 已把 Actions 更新聚成一个 PR）。PR 当天合并或关闭，不要让队列堆积。
- 升级 Actions 主版本后，本地无法验证 CI 行为，合并前看一眼 PR 上的 CI 结果。
- CI 由五部分组成：Ubuntu 上 Node 20/22/24 三套矩阵（零依赖校验 + 全量语法检查 + 逐文件测试）、Linux 上的 `docs & metadata`（`check-docs` + `check-release`）、`windows smoke (node 22)`（同样的整洁性/发布一致性/逐文件测试，在 Windows 上再跑一遍：本插件运行在 Windows 桌面端，路径分隔符、换行符、`find` 之类的差异都在这里兜底）、以及 `codeql.yml` 的静态安全扫描（`javascript-typescript`，`security-extended` 查询集，push/PR/每周一各跑一次）。Windows job 目前是**观察项**，没有加进 `main` 的必需状态检查；CodeQL 的结果在仓库 **Security → Code scanning** 里看。

## 提交信息

```
<type>(<scope>): <subject>

<body：为什么改、改了什么、实测数字>
```

`type` 取 `feat` / `fix` / `docs` / `test` / `refactor` / `chore` / `perf` / `build` / `ci`。`scope` 可省，常用 `pipeline` / `brief` / `strategy` / `config` / `client` / `repo`。

## 发布记录

版本与对应 commit 见 `git log --oneline` 与 `git tag -n`；用户可见的能力变化见 [CHANGELOG.md](../CHANGELOG.md)。