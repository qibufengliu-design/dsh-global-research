# dsh-global-research 仓库规整审计（2026-11-15）

- 仓库：<https://github.com/qibufengliu-design/dsh-global-research>
- 范围：用户 m00829 改派后，本会话只负责「仓库规整性」，功能迭代归另一会话。
- 起止提交：`c9ddf22`（0.9.5 发布，含功能与第一批卫生文件）→ `dc040ff`（0.9.5 文档与交接同步）。
- 结论：代码、文档、CI、发布四条链路已闭环；剩下 5 项只能由仓库管理员在 GitHub 网页上操作（无 `gh` CLI、无 token）。

## 1. 审计前的实际状态

静态与远端 API 实测（`https://api.github.com/repos/qibufengliu-design/dsh-global-research`）：

| 项 | 状态 |
| --- | --- |
| 跟踪文件数 | 65（结构本身不散：根目录 13 项、`.github/` 7 项、`docs/` 4 页 + 3 张截图、`lib/` 16、`test/` 18、`scripts/` 2） |
| 仓库 description | `null` |
| topics | `[]` |
| homepage | `null` |
| Releases | `/releases` 返回 `[]`（5 个 tag 全无 Release） |
| 未关闭 issue/PR | 2 条，全是 Dependabot：`#1` actions/setup-node 4→7、`#2` actions/checkout 4→7（13:48 创建，长期没人处理） |
| `has_wiki` | `true`（空 Wiki 会让仓库显得没维护） |
| CI | `ci.yml` 只做零依赖校验 + `node --check index.js client.js` + 逐文件测试；actions 仍是 v4（与 Dependabot PR 冲突） |
| 文档一致性 | README 预算表仍写 90/180/300s（实际已 120/240/360s）；README、docs/development.md、docs/release.md 写死「337 例」（实际 352）；git 历史里有 `dev <dev@local>` 作者 |
| 忽略规则 | `.gitignore` 缺 `.cache/`（`lib/cache.js` 默认持久化到 `.cache/research.json`）、缺编辑器目录 |
| tag | `v0.9.2` 是轻量 tag（其余 annotated）；已推送 tag 未移动 |

## 2. 这一轮做了什么

新增：

- `scripts/check-docs.mjs`：零依赖整洁性检查器，`checkRepository(root)` 返回 `{passes, failures}`。校验 25 项必需文件、9 份 markdown 的相对链接、CHANGELOG 的 `[Unreleased]` 与当前版本小节、package.json 零依赖 + 元数据（description/license/repository/homepage/bugs/author/engines）+ scripts + files 路径存在性。
- `scripts/release-notes.mjs`：`extractReleaseNotes(markdown, version)` 从 CHANGELOG 抽版本正文，供 Release workflow 生成 notes。
- `.github/workflows/release.yml`：tag push 触发 + `workflow_dispatch`（带 tag 入参，可补建历史 Release）。校验 tag 与 package.json 版本一致 → `gh release create --notes-file`，用内置 `GITHUB_TOKEN`。
- `.github/CODEOWNERS`：`* @qibufengliu-design`。
- `test/repo-hygiene.test.js`：3 例覆盖发布说明抽取、检查器通过、检查器对空目录报失败而不是抛错。

修改：

- `.github/workflows/ci.yml`：actions 升 `checkout@v7` / `setup-node@v7`；新增「全量语法检查」（`find` 出所有 `.js`/`.mjs` 逐个 `node --check`）；docs job 改为 `node scripts/check-docs.mjs`。
- `.github/dependabot.yml`：github-actions 按周 + 聚组（`groups: github-actions: patterns ['*']`）+ `open-pull-requests-limit: 3`；npm 月度 1 条。
- `.gitignore`：补 `.cache/`、`*.tmp`、`.vscode/`、`.idea/`。
- `docs/release.md`：发布清单 12 步（加整洁性检查与自动 Release）、新增「tag 规则」（只打 annotated、已推送不移动不删、v0.9.2 为历史轻量例外、tag 必须与 package.json 一致）、「提交身份」（固定 `qibufengliu-design <qibufengliu-design@users.noreply.github.com>`，禁 `dev@local`）、「依赖与 Actions 版本」。
- `CONTRIBUTING.md`：开发命令加 `check-docs`，去掉写死例数，加 git 身份配置；PR 检查表加整洁性、文档不写死数字、只打 annotated tag。
- `README.md`：预算墙钟 120/240/360s；开发段改「逐文件跑全部测试」；新增 Release 徽章。
- `docs/configuration.md`（`timeoutMs` deep 下限 360s）、`docs/development.md`（去写死例数）、`docs/architecture.md`（证据抽取 2 页一批并行 + 单批失败回落启发式）。
- `CHANGELOG.md`：0.9.5 增加「### 仓库」段。
- `HANDOFF.md`：状态句、0.9.5 条目、新增「仓库规整」节、远端手工清单、0.9.6 计划（相关性闸门原型备份在 `D:\Total\.tmp-gate-backup\`）。

## 3. 验证证据

- `node scripts/check-docs.mjs`：通过（25 项必需文件、26 条相对链接、版本 0.9.5、零依赖、元数据完整、scripts 齐全、files 路径存在）。
- `node scripts/test-all.mjs`：19 个测试文件 **352 例全绿**。
- GitHub Actions：
  - `CI` run #9（id `43726960329`，对 `dc040ff`）：`docs & metadata` 成功；`test (node 20/22/24)` 的零依赖校验与全量语法检查均成功（逐文件测试进行中，本地同一套测试已全绿）。
  - `Release` run #1（id `43726606506`）：成功，创建 Release **v0.9.5**（id `446132607`，notes 来自 CHANGELOG 0.9.5 段）。
- 远端 refs：`refs/heads/main` = `dc040ff`；`v0.9.0`–`v0.9.5` 六个 tag 均在远端。

## 4. 只能手工做的 5 项（无 token / 无 gh CLI）

1. 仓库设置：Description 建议 `DeepSeek Harness 的 research 工具：把开放问题做成带引用、可核查的研究简报（零依赖）`；Topics 建议 `deepseek-harness dsh-plugin research web-search rag citation nodejs`。
2. 分支保护（Settings → Branches，保护 `main`）：Require status checks → `test (node 20)`、`test (node 22)`、`test (node 24)`、`docs & metadata`；Require review from Code Owners；禁止 force push / 删除分支。
3. Settings → 关闭 Wiki 与 Projects（仓库不用它们，空着显乱）。
4. 处理 Dependabot PR `#1`（setup-node 4→7）与 `#2`（checkout 4→7）：`ci.yml` 已直接升到 v7，两个 PR 直接关闭即可。
5. 补建历史 Release：Actions → Release → Run workflow，依次填 `v0.9.0`、`v0.9.1`、`v0.9.2`、`v0.9.3`、`v0.9.4`（notes 自动从 CHANGELOG 抽）。v0.9.5 已由 tag push 自动创建。

## 5. 之后每次发版的固定动作

```powershell
cd D:\Total\dsh-global-research
node scripts/check-docs.mjs
node scripts/test-all.mjs
# 改 package.json version + CHANGELOG 新小节，然后：
git add -A
git commit -m "chore(release): x.y.z"
git tag -a vX.Y.Z -m "vX.Y.Z"
git -c http.sslBackend=openssl push origin main --follow-tags   # 需 danger-full-access
git -c http.sslBackend=openssl ls-remote origin refs/heads/main 'refs/tags/vX.Y.Z'
```

tag push 会自动跑 Release workflow 生成 Release 页；CI 会跑 19 个测试文件的三套 Node 矩阵。
## 远端设置执行记录（2026-11-15 23:12，GitHub API，token 未落盘）

| 项 | 结果 |
|---|---|
| 仓库描述 | 已设置：DeepSeek Harness 插件：把开放问题做成带引用、可核查的研究简报（零依赖） |
| topics | 7 个：citations / deepseek / dsh-plugin / nodejs / rag / research / web-search |
| has_wiki / has_projects / has_discussions | 全部 false |
| main 分支保护 | 200 OK；必需检查 test (node 20/22/24) + docs & metadata；CODEOWNERS review；禁强推/禁删分支；enforce_admins=false（保留直推 main 的能力） |
| Release | v0.9.0–v0.9.4 补建成功（201，id 446142062/446142081/446142089/446142095/446142106）；v0.9.5 原已存在 |
| Dependabot PR #1 #2 | 查询时已是关闭状态，无需处理 |

执行后用 GitHub API 回读校验：description 非空、topics 7 条、分支保护 contexts 与 CODEOWNERS 均生效、releases 列表含 v0.9.0–v0.9.5 六条。
