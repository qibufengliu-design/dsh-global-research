# 交接：全球深度研究插件（1.0.0，最终交接版）

## 一句话状态

`research` 工具已达 1.0.0：把一个开放问题做成**带 `[S#]` 引用、可核查、可复跑**的研究简报，零第三方依赖。0.6 → 1.0 的能力线已收口（策略引擎与取源通道、证据分级与排序、答案层、运维自检），**接口、简报结构、置信度口径、预算模型冻结**；做不到的部分集中写在 [LIMITATIONS.md](LIMITATIONS.md)。本版没有功能改动，代码等同 0.10.1（`bdf39ed`），只做版本收口与文档整理。

## 仓库与版本

- 本地：`D:\Total\dsh-global-research`（git，`package.json.version` = `1.0.0`）
- 远端：<https://github.com/qibufengliu-design/dsh-global-research>
- 版本事实来源：`package.json.version`；`scripts/retrieval-check.mjs` 的 `VERSION` 与它同步（自检输出里会打印版本），其余地方不重复写版本号。
- 历史：0.6.0 起按「一版一提交 + annotated tag `vX.Y.Z`」发布，`v0.9.0`–`v0.10.0` 均已推送到远端；`1.0.0` 的 tag 在发布清单第 9 步打（见 [docs/release.md](docs/release.md)）。
- 变更历史全在 [CHANGELOG.md](CHANGELOG.md)（1.0.0 小节是 0.6 → 1.0 的能力线汇总），本文不复制。

## 怎么跑

```powershell
node scripts/test-all.mjs        # 逐文件跑全部测试（19 个文件 / 415 例，2026-11-16 实测全绿）
node scripts/check-docs.mjs      # 仓库整洁性：必需文件、链接、CHANGELOG、零依赖、参数表、无密钥/本机路径、workflow 结构
node scripts/check-release.mjs   # 发布一致性：版本号 ↔ CHANGELOG 小节、预算表 ↔ DEPTH_PROFILES、文档里没有写死的例数
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
| `scripts/` | `test-all` / `check-docs` / `check-release` / `retrieval-check` / `release-notes` / `verify-release` / `e2e-real` |
| `test/` | 19 个 `*.test.js`，Node 内置 `node:test`，无网络 |
| `docs/` | `architecture` / `configuration` / `development` / `release` 四页，README 是索引 |
| `.github/` | `ci.yml`（Node 20/22/24 矩阵 + windows smoke + docs job）、`codeql.yml`、`release.yml`（推 tag 自动建 Release） |

## 已实现能力（按层）

**取源层**

- 问题分类到 8 个类别（`concept` / `compare` / `tech-selection` / `pricing` / `learning` / `fresh-data` / `evaluate` / `decision`），固定优先级决定同分归属；每个类别声明自己的 `sourcePlan` 通道与 query 模板。
- 官方域名白名单 30+ 厂商，官方文档 / 价目页 / 标准 / 论文 / 仓库优先；`site:<host>` 官方定向查询兜底，sitemap 定向爬取（含 base 相对路径、跨主机改写、`/docs/ /reference/ /guides/` 偏好）。
- 垂直源直连（GitHub / Stack Exchange / npm / PyPI / arXiv / OpenAlex / HN），价格题直取已知厂商价目页。
- 三层抓取：裸 HTTP → 宿主 `web.fetch` → Jina Reader；JS 壳、登录墙、PDF 一律判「未获取」，绝不填充猜测内容。

**证据层**

- 证据必须能在抓到的正文里匹配到才保留；悬空引用删除或标「〔来源未列出〕」，编号按首次出现重排。
- `sourceTier()` 分档排序（doc-page +4 / doc-index +2 / repo-doc +1 / repo-code −2 / forum −1 / blog −2），tech-selection / learning / compare 留 doc-page 槽位；过期/归档页降权且不参与置信度。
- 数值断言抽取 → 按实体归一 → 三类冲突（事实冲突 / 口径差异 / 来源自相矛盾）；抽不到就检测不到，不声称「没有矛盾」只是「没检出矛盾」。
- 定向回补：零证据选项各发一次定向 query（价格题先用 `site:<价目主机>` 并直取 seed URL），compare 题选页预留最多 2 页，跑没跑都写进 `stats.targetedRefill` / 流程行 / `gaps`。
- `confidence` = 多源一致性，不是事实正确率：广度按 `evidenceSiteKey()` 计（文档主机按 `host/首段`，跨源确认仍按站点），`decision` 题无一手 hostname 封顶 `medium`。

**答案层**

- 首行 `**一句话：…**`（带 `[S#]` 或「（推断）」），随后「## 结论」「## 方案对比」「## 行动清单」「## 坑与风险」「## 未解决」「## 参考」；`decision` 题额外要「## 判据」并补「（推断）」标注。
- 必出章节按类别声明，缺段补占位并降一档置信度；比价表逐候选独立成行校验，缺价写 `未核实（无来源）` 并保留该行。
- 四数流程行 + 缓存年龄 + 研究会话 id，交付物自带审计信息。

**运维层**

- 缓存默认 60 分钟、内存、可选落盘；时效性问题不走缓存；命中缓存在首行标注时长。
- `researchId` 续跑（30 分钟）、`saveTo` 导出 Markdown、`text` / 设置页「研究材料」作为最高优先级证据。
- `test-all` / `check-docs` / `check-release` / `retrieval-check` / `verify-release` 五个脚本 + CI 三套 Node 矩阵 + CodeQL + 推 tag 自动建 Release。

## 已知缺口（不是 bug，是数据/结构限制）

1. **豆包价目表的通用档价**：火山方舟价目页把「通用/批量/缓存命中」分多档，抓到的常常只有其中一档（或只有型号列而单位在表头），缺档会在「未解决」写「未取得」，不会拿套餐价冒充 token 单价；最快补救是把对应行贴进 `text`。
2. **Haystack 没有可抓的官方文档**：`deepset`/Haystack 的官方文档站要么跳转要么无站点地图，检索只能落到 GitHub 仓库与二手教程，官方采用比偏低——这是数据缺口，不是选页逻辑错。
3. **非文档官方页的广度只按 host 计**：`evidenceSiteKey()` 对 `doc-page` 才拆到 `host/首段`；官方首页、定价页、产品页这类非文档页仍按整站计一处，同一厂商多个官方页面不会被当成多个独立来源（保守方向，宁可给低一档）。
4. **中文并列不切分「和 / 与」**：对比选项切分认 `|` `/` `、` `，` `vs` `还是`，不认「A 和 B」「A 与 B」；这类问法可能被当成单候选（表退化成一行）或走错类别，写成并列形式即可。
5. **`## 判据` 没有校验器**：提示词要求每条判据可判定（数字阈值或明确二选一条件），但 `missingSections()` 只检查段落是否存在；模型写「看情况」不会被拦，只会因缺段/无来源降一档。

## 下一步可选方向

1. **相关性闸门**（收益最大）：`rankHits` 里用「问题 token ↔ 标题 + URL 路径」重合度做降档，价格题额外要求路径含 `pricing|价格|定价|model`。0.9.6 的回归证据显示档位分（doc-page +4）会压过相关性，选进来的官方文档页有 4/10 与问题无关。目标：相关 docPage 不掉、非价目页掉出前 10，且既有断言不破。
2. **价目表「单位在表头」的继承**：`heuristicEvidence()` 目前要求 token 单价在同一行内（金额 + 币种 + 单位），遇到 `模型 | 输入 | 输出` + 表头写 `元/千 tokens` 就抽不到。做法是把表头单位向下继承给数据行，仍拒绝套餐价。
3. **判据校验器**：给「## 判据」加最小检查（含数字阈值 / 二选一条件，否则补「（推断）」或降档），把提示词契约变成可回归的断言——这是 1.0 之后最容易被用户感知的一处「说了但没做到」。
4. **中文并列关系切分**：`compareOptions()` 补「和 / 与 / 及 / 跟」，并加句级回归（`pnpm 和 yarn 哪个好`、`A 与 B 的差异`），避免单候选假对比。
5. **真实网络复测**：单测只钉住纯函数与端到端假模型路径，还没有系统复跑 C 题（`我们团队 8 个人，微服务该不该拆`）、豆包价格题与 RAG 选型题。复跑看三件事：`stats.questionKind` 是否真为 `decision`、判据是否给到带阈值的条目、价目行是否真进了 claim。跑不动就记录「未运行 + 原因」，不编结论。

## 发布与推送

发布清单（版本号、CHANGELOG、check-docs/check-release、打 annotated tag、推送、核对 Release 正文）见 [docs/release.md](docs/release.md)；仓库设置类操作（描述、topics、分支保护）在没装 `gh`、没有 `GITHUB_TOKEN` 的机器上只能网页手工做，不要假装已完成。推送需要能读到凭据库：Windows 上沙箱内 `git push` 会 `SEC_E_NO_CREDENTIALS`，做法（`-c http.sslBackend=openssl`、`--follow-tags`、推送后 `ls-remote` 核对 `refs/heads/main`）也写在那一页。