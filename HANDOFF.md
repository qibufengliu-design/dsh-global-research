# 交接：全球深度研究插件（1.1.1）

## 一句话状态

`research` 工具已达 1.1（当前 `1.1.1`）：把一个开放问题做成**带 `[S#]` 引用、可核查、可复跑**的研究简报，零第三方依赖。0.6 → 1.0 的能力线已收口（策略引擎与取源通道、证据分级与排序、答案层、运维自检），1.1.0 在此基础上补了三块「可验证」：**可度量评测**（`scripts/eval.mjs` 固定 10 题分数表，可跨版本对比）、**判据校验**（`## 判据` 每条要有数字阈值，否则标「（推断）」并降档）、**pricing 渲染兜底**（JS 壳价目页走独立的 Jina 渲染预算取回，按 `via: 'render'` 降档）。1.1.1 只修 1.1.0 实跑暴露的对比题缺陷（括号内联候选清单、对比格 claim 自证、表外价格句回填、冲突段空类占位、渲染兜底计数与实际采用对齐），接口、简报结构、置信度口径、预算模型仍然冻结；做不到的部分集中写在 [LIMITATIONS.md](LIMITATIONS.md)。

**2026-11-16 01:1x 发布守门核实**：`refs/heads/main` = `06171f5`（`chore(release): 1.0.0`），tag `v1.0.0` 已推送并生成 Release id **446220562**（正文 2451 字，`node scripts/verify-release.mjs v1.0.0` 与 tag 上的 CHANGELOG 逐字一致）；三门槛 `check-docs` / `check-release` / `test-all` 全绿（19 个文件，实测 **417 例**——发布正文里写的 415 是发布那一刻的计数，之后 repo-hygiene 又加了 2 例）；CI 在 Node 20/22/24 + `windows smoke (node 22)` 上跑同一套测试，另有 CodeQL。<br>**注意**：`v1.0.0` 是**轻量 tag**（另一条线直接 `git tag` 后推送，与历史遗留的 `v0.9.2` 同类），已推送的 tag 不移动、不删除，所以这个例外只记录不修正（`v1.0.1` 从未打 tag，`v1.0.2` 同样是轻量 tag，见下条）。

**2026-11-16 08:45 发布守门核实（1.0.2）**：`refs/heads/main` = `5d719ef`（= 1.0.2 发布提交 `f8a235f` + 本文档更新），`package.json.version` = `1.0.2`；annotated/轻量 tag **`v1.0.2`** 指向 `f8a235f`（**轻量 tag**，第三例），Release 页 id **446257259**（正文 1013 字，`node scripts/verify-release.mjs v1.0.2` 与 tag 上的 CHANGELOG 逐字一致）；三门槛 `check-docs` / `check-release` / `test-all` 全绿（19 个文件，实测 **426 例**），CI 与 CodeQL 在 `5d719ef`、`f8a235f` 上均 success。<br>**1.0.1 的处置**：`4d436ed`（compare 选项解析与空格填充）当时只进了 CHANGELOG 的 `[1.0.1]` 小节，没有 bump `package.json`、也没有打 tag，所以远端没有 `v1.0.1`、也没有对应 Release 页；它的修复内容随 `v1.0.2` 一起发布（`[1.0.2]` 小节开头写明了这一点）。

**2026-11-16 10:50 发布守门核实（1.1.0）**：`refs/heads/main` = `7657960`（`chore(release): 1.1.0`）+ 本文档更新，`package.json.version` = `1.1.0`；tag **`v1.1.0`** 指向 `7657960`（**轻量 tag**，第四例），Release 页 id **446549499**（正文 1654 字，`node scripts/verify-release.mjs v1.1.0` 与 tag 上的 CHANGELOG 逐字一致）；三门槛 `check-docs` / `check-release` / `test-all` 全绿（**20 个文件、实测 458 例**；1.0.2 时为 19 文件 426 例）；CI `CI#45`（test node 20/22/24 + windows smoke + docs & metadata + analyze）与 `CodeQL#17` 在 `7657960` 上全 success。<br>**本次守门补的内容**：`[1.1.0]` 小节原本只写了评测一块、开头还留着「本版不改 `package.json`、不动 `lib/` 管线」的旧说法，已改成三块（评测 / 判据校验 / 渲染兜底）并补上渲染兜底的门控、白名单、独立预算、`via: 'render'` 降档与可见性，另加 `### 仓库` 段（评测工具链进必需文件、docs 索引检查改递归）和实测计数。

**2026-11-16 11:06 发布守门核实（1.1.1）**：`refs/heads/main` = `b5ac7cd`（`chore(release): 1.1.1`），`package.json.version` = `1.1.1`；tag **`v1.1.1`** 指向 `b5ac7cd`（**轻量 tag**，第五例），Release 页 id **446562656**（正文 2655 字，`node scripts/verify-release.mjs v1.1.1` 与 tag 上的 CHANGELOG 逐字一致）；三门槛全绿（**20 个文件、实测 464 例**；1.1.0 时为 458 例）。<br>**本次守门补的内容**：`[Unreleased]` 里还留着两条「### 仓库」副本——它们已随 1.1.0 写进正式小节，而且措辞是内部协作口径（「另一条线先合入后再删」），不适合出现在对外变更日志里，已清空（提交 `80af670`）；同时 `.gitignore` 忽略仓库根目录的 `_*.mjs` 一次性脚本（`_rel.mjs` 这种发版前改版本号的小工具，正式脚本都在 `scripts/`），避免另一条线用 `git add -A` 把它带进仓库。

## 仓库与版本

- 本地：`D:\Total\dsh-global-research`（git，`package.json.version` = `1.1.1`）
- 远端：<https://github.com/qibufengliu-design/dsh-global-research>
- 版本事实来源：`package.json.version`；`scripts/retrieval-check.mjs` 的 `VERSION` 与它同步（自检输出里会打印版本），其余地方不重复写版本号。
- 历史：0.6.0 起按「一版一提交 + `vX.Y.Z` tag」发布，`v0.9.0`–`v1.1.1` 均已推送到远端，16 个版本各自有 Release 页（`v1.0.1` 从未打 tag，其修复并入 `v1.0.2`）（`v0.9.0`–`v0.9.4` 由 2026-11-15 用 API 补建，之后由 `release.yml` 在推 tag 时自动创建）。除 `v0.9.2`（历史遗留）、`v1.0.0`、`v1.0.2`、`v1.1.0`、`v1.1.1`（另一条线直接推的轻量 tag）外都是 annotated tag。
- 设计笔记归档在 [docs/design/](docs/design/README.md)（各版设计稿、真实网络回归记录、仓库审计记录，索引在该目录的 README）
- 变更历史全在 [CHANGELOG.md](CHANGELOG.md)（1.0.0 小节是 0.6 → 1.0 的能力线汇总），本文不复制。

## 怎么跑

```powershell
node scripts/test-all.mjs        # 逐文件跑全部测试（20 个文件 / 464 例，2026-11-16 实测全绿）
node scripts/check-docs.mjs      # 仓库整洁性：必需文件、链接、CHANGELOG、零依赖、参数表、JSON 示例、文档命令、密钥/本机路径、workflow 结构、docs 索引
node scripts/check-release.mjs   # 发布一致性：版本号 ↔ CHANGELOG 小节 ↔ retrieval-check 的 VERSION、预算表 ↔ DEPTH_PROFILES、文档里没有写死的例数
node scripts/verify-release.mjs vX.Y.Z   # 远端 Release 正文 ↔ 该 tag 上的 CHANGELOG 小节（逐字）
node scripts/retrieval-check.mjs --question "…" --depth standard   # 真引擎检索/选页自检，不跑 LLM
```

- 沙箱里 `node --test test/` 会 spawn `EPERM`，所以统一走 `scripts/test-all.mjs`（逐文件 spawn、`stdio: 'inherit'`）。
- `retrieval-check` 用假模型跑完整 `runResearch`，输出四数与 `docPage/repoCode/other` 拆分、前 10 条 URL 及档位；采用 0 条退出码 1。怀疑「检索变差」先跑它，别先跑完整研究。
- 重载插件（改 host 侧代码后，对当前 profile 生效）：
  ```text
  plugin_manager set_plugin target: include:global-research enabled: false
  plugin_manager set_plugin target: include:global-research enabled: true
  ```
  改 `client.js`（卡片 / 输入框胶囊 / 设置页）必须**完全重启桌面应用**，`Ctrl+R` 只切会话不会重载页面。

## 目录结构要点

| 路径 | 内容 |
|---|---|
| `index.js` | 工具注册与执行：参数校验、缓存键、`researchId` 会话、`saveTo` 落盘、`text` 直取、debugStats |
| `client.js` | Web 端卡片、输入框胶囊、插件设置页（默认深度、研究材料粘贴区） |
| `lib/pipeline.js` | 管线主体（分类 → 规划 → 检索 → 选页 → 抓取 → 证据 → 回补 → 合成 → 交付），`DEPTH_PROFILES` 预算表 |
| `lib/strategies.js` / `lib/strategy.js` | 问题类别、固定优先级、`sourcePlan` 取源通道、query 模板、信号词 |
| `lib/brief.js` | 简报结构：必出章节、`ensureSections`、引用校验、置信度、对比表完整性、判据接地 |
| `lib/sources.js` / `lib/engines.js` / `lib/verticals.js` | 宿主引擎 + DuckDuckGo/付费引擎、GitHub/arXiv/SE/npm/HN/PyPI 垂直源、sitemap 与官方通道 |
| `lib/fetch.js` | 抓取三层（raw → host `web.fetch` → Jina），`via` 标记，失败原因按通道拼接 |
| `lib/assertions.js` | 数值断言（价格/版本/日期/百分比/人数/容量）与实体归一、三类冲突 |
| `lib/prompts.js` | 拆题 / 规划 / 合成提示词，按类别与 `mode` 派生输出结构 |
| `lib/cache.js` / `lib/sessions.js` | 结果缓存（内存 + 可选落盘）、追问会话（`researchId`） |
| `lib/config.js` / `lib/schema.js` / `lib/util.js` | 配置校验与默认值、工具 schema、URL 与站点键等纯函数 |
| `scripts/` | `test-all` / `check-docs` / `check-release` / `retrieval-check` / `release-notes` / `verify-release` / `eval`（+ `lib/harness.mjs` 共享装配） / `e2e-real` |
| `test/` | 20 个 `*.test.js`，Node 内置 `node:test`，无网络 |
| `docs/` | `architecture` / `configuration` / `development` / `release` 四页 + `design/` 设计归档（索引在各自的 README） |
| `.github/` | `ci.yml`（Node 20/22/24 矩阵 + windows smoke + docs job）、`codeql.yml`、`release.yml`（推 tag 自动建 Release） |

## 已实现能力（按层）

**取源层**

- 问题分类到 8 个类别（`concept` / `compare` / `tech-selection` / `pricing` / `learning` / `fresh-data` / `evaluate` / `decision`），固定优先级决定同分归属；每个类别声明自己的 `sourcePlan` 通道与 query 模板。
- 官方域名白名单 30+ 厂商，官方文档 / 价目页 / 标准 / 论文 / 仓库优先；`site:<host>` 官方定向查询兜底，sitemap 定向爬取（含 base 相对路径、跨主机改写、`/docs/ /reference/ /guides/` 偏好）。
- 垂直源直连（GitHub / Stack Exchange / npm / PyPI / arXiv / OpenAlex / HN），价格题直取已知厂商价目页。
- 三层抓取：裸 HTTP → 宿主 `web.fetch` → Jina Reader；JS 壳、登录墙、PDF 一律判「未获取」，绝不填充猜测内容。
- 价目题的 JS 壳价目页另有独立渲染兜底（1.1.0）：常规抓取失败或正文 < 400 字时走 `r.jina.ai` 取正文，`config.renderFallback` 可整层关闭、`config.renderHosts` 覆盖白名单（默认六家厂商主机后缀），`RENDER_BUDGET = 2` 与页预算互不占用；取回的页面 `via: 'render'` 降一档并标「（渲染取回）」。

**证据层**

- 证据必须能在抓到的正文里匹配到才保留；悬空引用删除或标「〔来源未列出〕」，编号按首次出现重排。
- `sourceTier()` 分档排序（doc-page +4 / doc-index +2 / repo-doc +1 / repo-code −2 / forum −1 / blog −2），tech-selection / learning / compare 留 doc-page 槽位；过期/归档页降权且不参与置信度。
- 数值断言抽取 → 按实体归一 → 三类冲突（事实冲突 / 口径差异 / 来源自相矛盾）；抽不到就检测不到，不声称「没有矛盾」只是「没检出矛盾」。
- 定向回补：零证据选项各发一次定向 query（价格题先用 `site:<价目主机>` 并直取 seed URL），compare 题选页预留最多 2 页，跑没跑都写进 `stats.targetedRefill` / 流程行 / `gaps`。
- `confidence` = 多源一致性，不是事实正确率：广度按 `evidenceSiteKey()` 计（文档主机按 `host/首段`，跨源确认仍按站点），`decision` 题无一手 hostname 封顶 `medium`。

**答案层**

- 首行 `**一句话：…**`（带 `[S#]` 或「（推断）」），随后「## 结论」「## 方案对比」「## 行动清单」「## 坑与风险」「## 未解决」「## 参考」；`decision` 题额外要「## 判据」并补「（推断）」标注。
- 判据校验（1.1.0）：`validateCriteria()` 要求每条 `- ` 判据带数字或比较/阈值词，否则补「（推断）」；软行过半且置信度 `high`/`medium` 时降一档，「## 置信度」同步改写，「未解决」写明「判据偏软：N/M 条…」。
- 必出章节按类别声明，缺段补占位并降一档置信度；比价表逐候选独立成行校验，缺价写 `未核实（无来源）` 并保留该行。
- 四数流程行 + 缓存年龄 + 研究会话 id，交付物自带审计信息。

**运维层**

- 缓存默认 60 分钟、内存、可选落盘；时效性问题不走缓存；命中缓存在首行标注时长。
- `researchId` 续跑（30 分钟）、`saveTo` 导出 Markdown、`text` / 设置页「研究材料」作为最高优先级证据。
- `test-all` / `check-docs` / `check-release` / `retrieval-check` / `verify-release` / `eval` 六个脚本 + CI 三套 Node 矩阵 + windows smoke + CodeQL + 推 tag 自动建 Release。
- `scripts/eval.mjs` 固定 10 题分数表（`--offline` 秒级自检、`--real` 真引擎真抓取、`--baseline prev.json` 低 3 分以上退出码 1），报告格式与权重是与用户对齐的对外契约；改评分口径要升版本并写进 CHANGELOG。

## 已知缺口（不是 bug，是数据/结构限制）

1. **豆包价目表的通用档价**：火山方舟价目页把「通用/批量/缓存命中」分多档，抓到的常常只有其中一档（或只有型号列而单位在表头），缺档会在「未解决」写「未取得」，不会拿套餐价冒充 token 单价；最快补救是把对应行贴进 `text`。
2. **Haystack 没有可抓的官方文档**：`deepset`/Haystack 的官方文档站要么跳转要么无站点地图，检索只能落到 GitHub 仓库与二手教程，官方采用比偏低——这是数据缺口，不是选页逻辑错。
3. **非文档官方页的广度只按 host 计**：`evidenceSiteKey()` 对 `doc-page` 才拆到 `host/首段`；官方首页、定价页、产品页这类非文档页仍按整站计一处，同一厂商多个官方页面不会被当成多个独立来源（保守方向，宁可给低一档）。
4. **中文并列不切分「和 / 与」**：对比选项切分认 `|` `/` `、` `，` `vs` `还是`，不认「A 和 B」「A 与 B」；这类问法可能被当成单候选（表退化成一行）或走错类别，写成并列形式即可。
5. ~~**`## 判据` 没有校验器**~~（1.1.0 已补）：`validateCriteria()` 逐条要求数字/比较词，缺的补「（推断）」，过半软行且置信度 `high`/`medium` 时降一档并在「未解决」写明 `判据偏软：N/M 条…`。仍然只是**文本启发式**，不是语义判断——写得像阈值但实际不可判定的条目仍会通过。

## 下一步可选方向

1. **相关性闸门**（收益最大）：`rankHits` 里用「问题 token ↔ 标题 + URL 路径」重合度做降档，价格题额外要求路径含 `pricing|价格|定价|model`。0.9.6 的回归证据显示档位分（doc-page +4）会压过相关性，选进来的官方文档页有 4/10 与问题无关。目标：相关 docPage 不掉、非价目页掉出前 10，且既有断言不破。
2. **价目表「单位在表头」的继承**：`heuristicEvidence()` 目前要求 token 单价在同一行内（金额 + 币种 + 单位），遇到 `模型 | 输入 | 输出` + 表头写 `元/千 tokens` 就抽不到。做法是把表头单位向下继承给数据行，仍拒绝套餐价。
4. **中文并列关系切分**：`compareOptions()` 补「和 / 与 / 及 / 跟」，并加句级回归（`pnpm 和 yarn 哪个好`、`A 与 B 的差异`），避免单候选假对比。
5. **真实网络复测**：单测只钉住纯函数与端到端假模型路径，还没有系统复跑 C 题（`我们团队 8 个人，微服务该不该拆`）、豆包价格题与 RAG 选型题。复跑看三件事：`stats.questionKind` 是否真为 `decision`、判据是否给到带阈值的条目、价目行是否真进了 claim。跑不动就记录「未运行 + 原因」，不编结论。

## 发布与推送

发布清单（版本号、CHANGELOG、`check-docs` / `check-release`、打 annotated tag、推送、`verify-release` 核对 Release 正文）见 [docs/release.md](docs/release.md)。

- **tag 规则**：只打 annotated tag；已推送的 tag 不移动、不删除；tag 必须打在 `main` 的发布提交上（`release.yml` 用 `git merge-base --is-ancestor` 校验）；tag 名必须等于 `v` + `package.json.version`。历史例外四个：`v0.9.2`、`v1.0.0`、`v1.0.2`、`v1.1.0` 是轻量 tag（都是另一条线直接 `git tag` 推的），只记录不修正。
- **推送**：Windows 沙箱里 `git push` 读不到凭据库（`SEC_E_NO_CREDENTIALS 0x8009030e`），要带 `sandbox_permissions: danger-full-access` 并用 `git -c http.sslBackend=openssl -c credential.interactive=never push origin main`；偶发挂起时设 `GIT_TERMINAL_PROMPT=0`。推完用 GitHub API（`/branches/main`、`/releases`、`/actions/runs`）核对——沙箱里 `git ls-remote` 也常挂。
- **远端仓库设置**：描述、7 个 topics、关闭 Wiki/Projects/Discussions、`main` 分支保护（必需检查 `test (node 20/22/24)` + `docs & metadata`、CODEOWNERS review、禁强推禁删）、被动关闭的两个 Dependabot PR，都是 2026-11-15 23:12 用一次性的 GitHub token 通过 API 配好的；执行记录在 `D:\Total\docs\superpowers\specs\2026-11-15-repo-hygiene-audit.md`。**那个 token 已在对话里明文暴露，必须撤销并换细粒度 token**；本机没有 `gh`、没有常驻 `GITHUB_TOKEN`，所以要改设置仍得网页手工或临时给 token。
- `windows smoke (node 22)` 目前是观察项，**还没加入分支保护必需检查**（加它需要网页操作或临时 token）。