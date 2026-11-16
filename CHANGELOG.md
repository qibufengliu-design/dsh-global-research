# Changelog

本文件记录本项目的所有重要变更。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本 2.0.0](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 仓库

- 设计笔记归档到 `docs/design/`：0.1 以来的七篇设计稿、真实网络回归记录与仓库审计记录集中到一处，并加 [目录索引](docs/design/README.md)；根目录不再散落设计稿（另一条线先合入后再删根目录副本的那次提交把这件事做完了）。
- `check-docs` 的文档索引检查改为递归：`docs/` 子目录里的页面必须能从根 README 或所在目录的 `README.md` 索引链到，子目录索引本身也必须从根 README 链到；`docs/design/README.md` 同时纳入链接扫描与 JSON 示例检查。

## [1.1.1]

> 1.1.1 修 1.1.0 实跑暴露的四个对比题缺陷，全部落在既有函数内部，`package.json`、接口、预算模型与简报结构不变。实测题：`国内四家大模型 API（DeepSeek、通义千问、豆包、Kimi）的价格怎么比，我们做一个小型 RAG 产品该选哪家`（standard / compare）。

### Fixed

- **括号内联清单优先（`compareOptions()`，`lib/pipeline.js`）**：1.1.0 把「国内四家大模型 API（DeepSeek」当成候选、且 3 个上限先于 Kimi 用完，正确候选应是括号里的四个名字。新增 `INLINE_OPTION_BRACKET`（`[（(]…[）)]`）扫描：括号内容按 `、，,／|；;` 切开、逐个走 `cleanOptionToken()`、丢掉引导词/背景词/谓词片段，某组仍有 ≥2 个名字就直接作为候选清单（上限 `MAX_BRACKET_OPTIONS = 6`）且不再对这条 source 做标点切分；含「该怎么 / 该选 / 选哪 / 哪家 / 怎么比」的片段只在以名字开头时保留（`startsWithOptionName()`），背景句不再成为候选。单名括号退回原路径，原路径 3 个上限不变。
- **对比格 claim 自证（`fillEmptyCompareCells()` / `optionClaims()`，`lib/brief.js`）**：通义千问行曾被塞进「阿里云 AI 助手导入模型时，可选模型包括…」——cluster 归属正确（quote 提到了该厂商），但被复制的 claim 谈的是别的产品。现在一段文本必须**自己**出现该候选的核心 token（`mentionsOption()`：`optionKey` 包含 / 中文 ≥2 字子串 / 拉丁词边界）才能进候选格，cluster 级 gate 只作快筛；提不到就保留「无证据」，不借无关引文。
- **表外价格句回填（`fillEmptyCompareCells()`）**：DeepSeek 行写「无证据」而表下就有 `$0.6–3.96 / 百万 tokens [S3]`。现在扫描表格行区间外的非标题、非表格、非引用行，要求命中 `PRICE_CLAIM` 且自带 `[S#]`，只用于价格列（新增 `isPriceCellColumn()`：`PRICE_COLUMN_HEADER_RE` 命中且不是风险/适用/`成本概览` 列），按「提及候选名 + 含货币价格词」归属、提及候选越少越优先，引用沿用句内 `[S#]`；风险/优势列仍不用它，函数幂等。
- **冲突段不再写空类占位（`conflictSectionText()` / `appendConflictSection()` / `ensureSections()`，`lib/brief.js`）**：1.1.1 实跑同一段里既写 `- 无` 又列着两条「来源自相矛盾」——原先三类全写、空类补 `- 无`，`findSelfContradictions()` 的结果与占位并存。现在只拼非空的类，三类都空整段不出现（`unitMismatch` 仍单独触发，口径行意外为空时保留一条 `- 无` 防御）。另外模型自己写的 `## 存在冲突` 若正文只有 `###` 标题与 `- 无`/`无`（`conflictBodyIsPlaceholder()`），这两处会用确定性发现原地替换整段，不再因为标题已存在就跳过（幂等）。
- **渲染兜底计数与实际采用对齐（`lib/pipeline.js` + `formatRetrievalFlow()`，`lib/brief.js`）**：1.1.1 实跑流程行写「渲染兜底 1」而参考区没有「（渲染取回）」标记，原因是那一次渲染页最终未被引用。新增 `stats.renderAdopted`（`citedOnly(finalSources)` 里 `via: 'render'` 的数量），`renderUsed > 0` 且 `renderAdopted === 0` 时流程行写 ` · 渲染兜底 N（未采用）`；有渲染页被采用仍写原样，`stats` 不含 `renderAdopted` 时不加注（兼容旧缓存/旧调用方）。

### Tests

- `test/pipeline.test.js` 新增 3 例：括号清单解析（实测题 → `['DeepSeek','通义千问','豆包','Kimi']`、ASCII 三选、单名括号不算清单）、谓词片段不当候选（`豆包、Kimi 哪家便宜…` → 2 个名字、Java 后端题仍 3 个、括号里的旁白被忽略）、渲染兜底「（未采用）」注记（`renderAdopted: 0` 加注、`: 1` 不加注、缺省不加注）。既有 1.1.0 流程行断言保持通过。
- `test/brief.test.js` 新增 3 例：claim 未提选项 → 该行保持「无证据」、换成提到候选的 claim 后正常填充并带 `[S1]`；表外价格句回填 DeepSeek 输入价（带 `[S3]`，风险列仍「无证据」，不串到通义千问行，二次调用字节相同）；只有 `- 无` 的「## 存在冲突」被 `findSelfContradictions()` 结果替换（来源自相矛盾行出现、段内无 `- 无`、幂等）。
- 冲突段既有 4 例改为 1.1.1 契约（新增 `conflictSectionOf()` helper）：空类标题不出现、段内无 `- 无`；纯 entity 口径差异仍走未解决注记；「同一页面两个不同值」只出「来源自相矛盾」不出「事实冲突」。
- `node scripts/test-all.mjs` 全绿（20 个测试文件）。

### 文档

- `docs/architecture.md`：「候选解析与空格回填（1.0.1）」补「括号内联清单优先（1.1.1）」「claim 自证（1.1.1）」「表外价格句回填（1.1.1）」三条；「pricing 渲染兜底」补 `stats.renderAdopted` 与「（未采用）」；「冲突三分」改为「有真实条目才写该类」，并补 1.1.1 的占位替换规则。

## [1.1.0]

> 1.1.0 是三块「从可信走向可验证」的收口：① 可度量评测——把「这次改动到底变好还是变差」从肉眼判断变成一张分数表（`scripts/eval.mjs`、`scripts/lib/harness.mjs`、`test/eval.test.js`）；② 判据校验——decision 题的「## 判据」每条必须给出数字阈值或比较词，否则补「（推断）」并在过半时降一档置信度；③ pricing 渲染兜底——JS 壳价目页走独立的 Jina 渲染预算取回，并按 `via: 'render'` 降档。版本号从 1.0.2 升到 1.1.0；管线只在 pricing 通道增加了渲染兜底一层，既有接口、简报结构、置信度口径与预算模型不变。

### Added

- **评测脚本（`scripts/eval.mjs`）**：固定 10 条语料（选型 / 价格 / 决策 / 时效 / 排错 / 法规 / 学习 / 论文），每条产出 `{id, kind, sources, officialRatio, tableFillRate, sectionsComplete, fourNumbers, confidence, seconds, score, notes[]}`。权重：来源质量 30、表格填充 20、段完整 15、四数 10、置信度合理性 15、时效/预算 10；不适用的指标剔除后按剩余权重归一，所以每题仍是 0–100 分，总分取均值。
- **两种模式**：`--offline` 用内置 fixture（不联网，自检评分器与简报装配）；`--real` 走真引擎 + 真抓取，合成用确定性模板（不调 LLM），结果可复现。`--json` 落盘报告、`--only` 选题、`--baseline` 逐题对比（总分低 3 分以上退出码 1，可直接进 CI）。
- **共享装配（`scripts/lib/harness.mjs`）**：把 `retrieval-check` 里的取 key（`tavilyKeyFromPatch` / `resolveTavilyKey`）、建 engines、建 `fetchPage` 抽成模块，评测与体检共用同一套装配；`retrieval-check.mjs` 改为从这里导入，导出与输出保持不变。
- README 新增「评测」小节（怎么跑、权重含义、如何比较版本）；`docs/development.md` 补「评测」一节，并把 `scripts/eval.mjs` / `scripts/lib/harness.mjs` 写进目录结构。
- **判据校验（`lib/brief.js` `validateCriteria()`）**：decision 题的「## 判据」不再只查段是否存在。逐条 `- ` 行必须给出数字或比较/阈值词（`≥ ≤ > < 超过 至少 以上 以内` 等，中文数字带单位也认），否则补「（推断）」并计为软行；软行超过一半且置信度是 `high` / `medium` 时降一档（high→medium、medium→low），「## 置信度」同步改写，并在「未解决」追加 `- 判据偏软：N/M 条缺少可量化阈值，结论按证据强度下调`（幂等）。没有「## 判据」的简报原样返回；`buildResult()` 的返回对象给出降档后的 `confidence`。
- **pricing 渲染兜底（`lib/fetch.js` `createRenderFetcher()` + `lib/pipeline.js`）**：厂商的官方价目页多是 JS 壳（常规抓取只拿到页头和导航、正文不足 400 字），价目题最该读的一页恰好读不到。新增独立的渲染兜底：走 `https://r.jina.ai/<原始URL>`（`accept: text/plain`，20s 超时）取正文，只在 `pricing` 通道、`standard`/`deep` 档、主机命中渲染白名单、常规抓取失败或正文 < `MIN_USEFUL_CHARS`（400 字）时才触发，`config.renderFallback === false` 可整层关闭。
- **渲染白名单与预算**：`DEFAULT_RENDER_HOSTS` = `volcengine.com` / `help.aliyun.com` / `api-docs.deepseek.com` / `platform.moonshot.cn` / `open.bigmodel.cn` / `bigmodel.cn`（按主机后缀匹配），`config.renderHosts` 可覆盖；`RENDER_BUDGET = 2` 与页预算互相独立、在请求发出前扣减（超时和 500 同样计数），失败不抛错，原因写进 `renderReason` 与 `sourceFailures`。
- **渲染页降档**：`via: 'render'` 的页面由 `gradeSource()` 降一档（官方 → 论文 → 仓库 → 论坛 → 百科 → 网页，最低「网页」），参考行标「（渲染取回）」；`stats.renderUsed` 与流程行 ` · 渲染兜底 N` 可核对本次是否用了渲染。
- `docs/architecture.md` 新增「pricing 渲染兜底（1.1.0）」一节（门控、白名单、独立预算、失败原因、降档与可见性），`docs/configuration.md` 补 `renderFallback` / `renderHosts`。

### 仓库

- `scripts/check-docs.mjs` 的必需文件表增加 `scripts/eval.mjs` 与 `scripts/lib/harness.mjs`：评测工具链是 1.1.0 起的对外契约，被删或改名要立刻在整洁性检查里报出来。
- docs 索引检查改为递归并索引感知：`docs/**/*.md` 必须能从根 README 或其所在目录的 `README.md` 索引导航到，子目录索引本身必须从根 README 链到（应用在没有索引的情况下归档 `docs/design/` 的那次整理上，首跑当场抓出缺失链接）。

### Tests

- 新增 `test/eval.test.js`：语料与权重固定、官方来源占比（仓库代码文件不算官方）、表格填充率与「缺表 / 不适用」的区别、decision 必需段缺失、四数缺失与 `adopted=0`、置信度差一档与差两档的记分、baseline 差值判定与缺题、参数解析，以及 offline 端到端（10 题都出分、表格可读、与自身比较不回归）。`node scripts/test-all.mjs` 全绿。
- 新增判据校验用例：全部命中阈值不降档、过半软行补「（推断）」并降一档且改写「## 置信度」、已有标记不重复、引用行不叠标记、`- 无` 不计分母、无判据段原样返回、幂等，以及 `buildResult()` 端到端返回降档后的置信度。
- 新增渲染兜底用例（`test/fetch.test.js` / `test/pipeline.test.js`）：白名单后缀匹配与 `nothelp.aliyun.com` 反例、正文不足 400 字才走渲染、`renderFallback: false` 整层关闭、预算在请求前扣减、超时/500 不抛错只记原因、`via: 'render'` 降一档、流程行出现 ` · 渲染兜底 N`。
- 全量：`node scripts/test-all.mjs` → **20 个测试文件、458 例全绿**（2026-11-16 发布守门实测；1.0.2 时为 19 文件 426 例）。

## [1.0.2] - 2026-11-16

> 1.0.1 实跑暴露了一个判断题缺陷：对比题「Java 后端做 RAG 应用，Spring AI 和 LangChain4j 怎么选」的表头是 `| 方案 | 优势 | 风险 | 适用场景 | 成本概览 |`，两个「成本概览」格却被填成能力描述（如「Advisors API 用于拦截增强」）并带 `[S#]`——读者会把它当成成本数据。本版把「成本概览」列从「其余列」里单独拿出来：只接受含成本语义的断言，没有就写「未取得（无成本数据）」，整列都缺时表下补一行说明。**不改 `package.json`**（接口与预算模型不变）。

### Fixed

- **成本列语义（`lib/brief.js` 的 `fillEmptyCompareCells` / `pickClaimForColumn`）**：表头匹配 `成本概览` / `成本` / `价格概览`（且不是风险/适用列）的列视为成本列，只接受含成本语义的断言——`元`、`￥`、`$`、`美元`、`人民币`、`免费`、`计费`、`按量`、`tokens`/`token`、`千次`、`每百万`、`price`、`cost`、`billing`、`quota`、`额度`；找不到这样的断言就写固定占位「未取得（无成本数据）」，不再回落到该选项的首条断言（那通常是能力描述）。优势 / 风险 / 适用场景列保持 1.0.1 的按列取断言规则；输入价 / 输出价 / 单价这类真价格列仍按 `PRICE_CLAIM` 优先取价目断言。
- **表下附注（`COST_OVERVIEW_NOTE`）**：整张表所有「成本概览」格都是「未取得（无成本数据）」时，在表下空一行补 `> 成本概览仅在有价目/计费证据时填充；本轮未取得，可参考「未解决」中的缺口。`；只要有任一格填到成本断言就不写。附注按整行幂等，重复调用不会叠行。

### Tests

- 新增 4 例：无成本断言时成本格写占位且不出现能力描述（并检查优势/风险/适用列仍是 1.0.1 行为）、有成本断言时正常填充且不写占位与附注、只有部分行缺成本时不写附注、pricing 题的真价格列（输入价/输出价 + `buildResult` 端到端）不出现成本占位与附注。测试总数 422 → **426 例（19 个测试文件）**，`node scripts/test-all.mjs` 全绿。

## [1.0.1] - 2026-11-16

> 1.0.0 实跑暴露了一个对比题缺陷：问题「Java 后端做 RAG 应用，Spring AI 和 LangChain4j 怎么选」（standard / compare）拿到 9 条参考、其中 7 条官方（docs.langchain4j.dev ×5、docs.spring.io ×2），对比表 3 行 × 4 列却全是「无证据」；第一行候选是问句背景句「Java 后端做 RAG 应用」，第三行与表下附注「未作为独立行出现」自相矛盾，`confidence` 被压到 `low`。本版修候选解析、把已有证据填回空格、让附注与表行一致，**不改 `package.json`**（1.0.0 的接口与预算模型不变）。

### Fixed

- **候选解析（`compareOptions`）**：先按比较连接词切左右（`和 / 与 / 还是 / vs / 对比 / 比较 / 以及 / 及`），再按原有 `OPTION_SPLIT` 与 `cleanOptionToken` 规则清洗。切出的片段超过 24 字、或含「应用 / 场景 / 项目 / 架构 / 后端 / 系统 / 功能」这类背景词时，回退到「大写开头的拉丁产品名 + 已知技术词典」，且只在真正做对比的那个分句里取名字——问句背景句不再成为候选。候选上限从 5 收到 3，单个候选不算对比（返回 `[]`）。`OPTION_CUT`、`OPTION_TAILS`、`OPTION_NOISE` 的既有行为保留。
- **表格补空（`fillEmptyCompareCells`）**：`## 方案对比` 里「无证据 / 未核实 / 待核实 / 空」的格，用该选项在证据里的高频断言（`claim` 前 60 字 + `[S#]`）填充；列语义按关键词挑——风险列优先含「风险 / 限制 / 不支持 / 需要」，适用列优先含「适合 / 适用于 / 场景」，其余取首条断言；找不到匹配断言就保留「无证据」，不借别人的句子。该函数幂等，并会把 `clusters` 里旧的来源 id 按 URL/标题重映射到交付的 `sources`，避免填出悬空引用。
- **附注一致性（`zeroEvidenceGapText` / `realignZeroEvidenceGapText` / `checkCompareRows`）**：零证据附注只在候选确实不在表中时写「在本轮证据中没有可用来源（零证据），未纳入对比」；候选在表中有行（含被合并进 `qwen / 豆包 API` 这类行）时写「选项「X」在对比表中占位，但关键属性未取得（零证据）」。表下附注同步改成「未作为独立行出现（关键属性未取得）」。
- 行为变更：零证据文案不再写死价格（旧文案「价格未取得 / 未取得可用证据」统一为「关键属性未取得」），因为空格可能出现在优势、风险、适用条件等任意列。

### Tests

- 新增 5 例：连接词切分与背景句剔除、超过 24 字/多候选/单候选的回退、空单元格按列语义填充、填充幂等且不借用他人断言、附注与表行（独立行 / 合并行 / 无表）一致，以及 `buildResult` 端到端填充后引用 id 不悬空。测试总数 417 → **422 例（19 个测试文件）**，`node scripts/test-all.mjs` 全绿。

## [1.0.0] - 2026-11-16

> 0.5 是「能查」，0.6 是「按问题类型去对的源」，0.7 是「选页排序」，0.8 是「检索可复跑的自检」，0.9 是「答案层」，0.10 是「判断题」。1.0.0 是这条线的收口：**能力集不再扩张，工具参数、简报结构、置信度口径与预算模型固定下来**，从这一版起按 SemVer 判断兼容性（`docs/release.md` 里 `0.x` 阶段「破坏性变更也走 MINOR」的惯例到此结束）。
> 本版没有功能改动：代码等同 0.10.1（`bdf39ed`），只做版本收口、能力线汇总、`LIMITATIONS.md` 首次成文、`HANDOFF.md` 改写为最终交接版。测试从 0.6 时代的 187 例长到 **415 例（19 个测试文件）**，`node scripts/test-all.mjs` 全绿。

### Highlights（0.6 → 1.0 能力线）

- **策略引擎与 `sourcePlan` 取源通道**：问题先归入 8 个类别（`concept` / `compare` / `tech-selection` / `pricing` / `learning` / `fresh-data` / `evaluate` / `decision`），固定优先级决定同分归属；每个类别声明自己的取源通道、query 模板、深度偏移与 `mode` 缺省值。官方域名白名单 + `site:` 定向 + sitemap 定向爬取 + GitHub / Stack Exchange / npm / PyPI / arXiv / OpenAlex / HN 垂直源，都在这一层收敛。
- **四数检索流程行**：每次交付都打印「计划 / 发出 / 采用 / 抓取失败 + 定向回补 + 缓存年龄」这几个数，把「检索做了什么」从黑盒变成可核对的审计行。
- **三类冲突**：数值断言按实体归一后，区分事实冲突、口径差异（同一指标不同定义/单位）、来源自相矛盾；分不开的写进「未解决」，不硬判一个赢家。
- **数值断言与实体归一**：抽价格、版本、日期、百分比、人数、容量，按模型/产品/套餐实体对齐后再比较；跨实体差异不误报冲突，只标「口径差异，不可直接比较」。
- **定向回补**：零证据选项各发一次定向 query（价格题先 `site:<价目主机>` 并直取 seed URL），compare 题给定向页预留选页槽位；跑没跑、为什么跳过，都进 `stats.targetedRefill`、流程行与 `gaps`。
- **证据分级与 doc-page 排序**：`sourceTier()` 六档（doc-page / doc-index / repo-doc / repo-code / forum / blog），过期页与归档页降权且不参与置信度；`tech-selection` / `learning` / `compare` 保留 doc-page 槽位，比较题的表列按选项逐一校验。
- **答案层：一句话结论 + 判据 / 行动清单**：首行 `**一句话：…**` 带 `[S#]` 或「（推断）」，固定「结论 / 方案对比 / 行动清单 / 坑与风险 / 未解决 / 参考」；`decision` 题强制给主判断（该 / 不该，不许「取决于」代替）并单列「## 判据」写可量化阈值，无出处的标「（推断）」。
- **`researchId` 续跑**：会话 30 分钟有效，追问复用上一轮的来源表与证据，不必从头再搜。
- **缓存时效与落盘**：默认 60 分钟内存缓存，可选落盘；时效类问题不走缓存，命中缓存在首行标注缓存年龄。
- **导出 `saveTo`**：把最终简报写成 Markdown 落到指定路径，内容与返回给模型的一致。
- **`text` 直取与设置页「研究材料」**：贴进来的正文（价目表、内部文档）作为最高优先级证据，优先于网络检索结果。
- **`retrieval-check` 真引擎自检**：假模型跑完整检索/选页链路，输出档位分布、前 10 条 URL 与退出码，怀疑「检索变差」时先跑它。
- **测试规模**：187 例（0.6）→ **415 例 / 19 个测试文件**（1.0.0，以 `node scripts/test-all.mjs` 输出为准），零第三方依赖，全部用 Node 内置 `node:test`。

### Breaking / Behaviour

- **`confidence` 更严，属破坏性口径变更**：`decision` 题若没有任何一手（`domainTrust >= 3`）来源，最高只给 `medium`，广度不足（`strong.size < 2`）再降 `low`；广度按 `evidenceSiteKey()` 计——文档主机拆到 `host/首段`，同一站点的多个文档段算多个来源，但非文档页仍按整站计一处。依赖旧的「两篇博客即可 `high`」结论的下游需要重新评估。
- **时效性问题不走缓存**：`fresh-data` 类与显式要求最新信息的问题跳过缓存，同一问题短时间连问两次会拿到两份独立检索结果。
- **错误信息新增 `via` 区分**：抓取失败时不再只说「fetch failed」，而是按三层通道（裸 HTTP → 宿主 `web.fetch` → Jina）分别记原因并拼在一起，`via` 标明实际成功/失败的通道，便于区分「站点挂了」与「解析器不支持」。

### Known limitations

- 见 [LIMITATIONS.md](LIMITATIONS.md)：数值口径、平台条款、文档覆盖、语言分句、判据校验等做不到的地方、原因与绕法。1.0.0 冻结的是接口与结构，不是这些边界。

## [0.10.1] - 2026-11-16

> 0.10.0 把 C 题（`我们团队 8 个人，微服务该不该拆`）分成了 `decision`，也要求「## 判据」写可量化阈值。回归跑出来的两处漏水都在交付层，不在分类层：其一，判据阈值全是二手页面（github / dev.to / 厂商博客）的说法，提示词要求「无来源的标（推断）」，模型照写数值却没标，简报里于是出现一串看起来有出处的阈值——**没有任何 `[S#]`，也没有任何「（推断）」**；其二，`官方定向 0` 的那次运行仍拿到 `medium`：两条博客域名 `domainTrust` 为 2，刚好过 `strong.size >= 2` 的广度闸门，而 `computeConfidence()` 当时不知道这是一道要下判断的题。本版做两件小事：**判据接地**（`groundCriteria()` 给无引用、无自标来源的判据行补「（推断）」）与**决策类置信度闸门**（`decision` 题没有一手 hostname 时最高 `medium`，广度不足再降 `low`）。

### Added

- **`groundCriteria(brief, sources)`**（`lib/brief.js` 新导出）：在「## 判据」段内逐条检查 `- ` 开头的行——不含 `[S数字]`、也不含 `（推断）`/`(推断)`/`（无来源）`/`(无来源)` 的，行尾追加 `（推断）`；`- 无` 占位不算判据，跳过；段不存在原样返回；幂等（第二遍不再变化）。`[S#]` 为 `grounds` 的条件是该 id 在 `sources` 表里（表为空时不追究），避免「引用了一个会被 `validateCitations()` 删掉的编号」把假引用当成接地。判据段边界到下一个 `^## ` 标题为止，段外的 `[S#]` 与「（无来源）」不受影响。
- **`buildResult()` 在 `ensureSections()` 之后调用 `groundCriteria()`**：接地发生在 `applyZeroEvidenceOptions()`、`sanitizeCompareTable()`、`markUnsourcedNumbers()` 之前，下游所有层看到的是已接地的文本，交付层不需要第二套判定。

### Changed

- **决策类置信度闸门**（`lib/brief.js` `computeConfidence(clusters, gates, questionKind)`）：新增可选第三参数 `questionKind`（也接受 `gates.questionKind` / `gates.kind`）。当类别为 `decision` 且存活证据里**没有任何 `domainTrust >= 3` 的 hostname**（官方/一手来源）时，基础判级结果最高只到 `medium`，不得给 `high`；若同时 `strong.size < 2`（独立站点广度不足），降为 `low`。闸门在基础判级之后、`missingPrimary` / `missingSections` / `gate` 之前生效，三条既有降档规则照旧叠加，所以最终 verdict 只会更低、不会被这里抬高。其余类别（`concept` / `compare` / `pricing` / `tech-selection` / …）行为完全不变。
- **`lib/pipeline.js` 传参**：三处 `computeConfidence()` 调用（主路径、`missingSections` 重算、catch 兜底）都补上 `state.questionKind`，决策题不再需要调用方手工传 gates 才能拿到闸门。
- `docs/architecture.md` 的「decision 类别」一节补两句：判据接地与决策闸门的判定表。

### Tests

- `test/brief.test.js` 59 → 63（+4）：判据无引用补「（推断）」、已有 `[S#]`（且在 sources 内）不动、`- 无` 占位与段外文本不动、已写「（推断）/（无来源）」不重复；幂等；无判据段逐字节原样返回；`decision` 无一手 hostname 时 `high → medium`、广度不足 `→ low`、有官方/一手来源时维持 `high`、其它类别不受影响（位置参数与 `gates.questionKind` / `gates.kind` 三种传法都覆盖）。
- `test/pipeline.test.js` 90 → 91（+1）：C 题端到端跑 `runResearch({ depth: 'quick' })`，两条博客页面证据下 `stats.questionKind === 'decision'`、`confidence === 'low'`（旧行为是 `medium`）；交付文本里无引用的判据行带「（推断）」，带 `[S1]` 的判据行原样保留。
- `node scripts/test-all.mjs` 19 个测试文件全绿。

## [0.10.0] - 2026-11-16

> 0.9.10 把 C 题（`我们团队 8 个人，微服务该不该拆`）的**表列**修对了，**类别**还是错的：`classify()` 对它 8 个类别全 0 分、回落 `concept`（confidence 0.35），cost 列靠 `effectiveCompareColumnKind()` 按措辞升级——那是给「分类器没认出来」的问题垫的一级台阶，不是分类。后果不止表头：提示词没有要求先给判断，检索也没把 query 花在阈值和反例上，出来的简报读起来像概念介绍。本版把这一级台阶补成真类别：`QUESTION_KINDS` 增 `decision`，两档信号词，固定优先级，决策型提示词，必出章节「## 判据」。
>
> 一条刻意的边界：`decision` 认的是**二选一判断**（该/不该、要不要、值不值得），不是选型。`该不该用 React` 只有一个候选 → `decision`；`React 还是 Vue 哪个好` 才是 `tech-selection`。两套词表不相交（后者不含 `该不该`/`要不要`），所以不存在「选型题被吸走」的路径；带价的问题仍归 `pricing`（`该不该买 X，多少钱`）。

### Added

- **`decision` 问题类别**：`lib/strategies.js` 的 `QUESTION_KINDS` 增 `'decision'`，`SIGNAL_VERSION` 3 → 4（缓存 key 随信号形状变）。0.9.10 的 C 题现在分类为 `decision`、`scores.decision = 6`、confidence 0.9。
- **两档信号词**：`lib/strategy.js` 新导出 `DECISION_HINTS`（强档，权重 5：`该不该` / `要不要` / `值不值得` / `是否该` / `应不应该` / `需不需要` / `是否应该` / `值得吗` / `该拆` / `该上` / `该迁` / `要不要拆` / `要不要上` / `该不该用` / `值不值得用`）与 `DECISION_CONTEXT_HINTS`（辅助档，权重 1：`团队` / `多少人` / `规模` / `预算` / `成本` / `风险` / `权衡` / `取舍`）。强档命中即过 2 分接受线；辅助档只加权，单独永远不足以命名类别（`团队规模多大` 不会变成 `decision`）。
- **`decision` 策略包**：`lib/strategies.js` 新包。`queries.extraTemplates` = `{q} 何时该拆 微服务` / `{q} 团队规模 阈值` / `{q} 反例 失败` / `{q} trade-offs`（沿用既有 `{q}` / `{year}` 语法，定向 query 排计划最前）；`sourcePlan.channels: []` 是显式声明（判断依据来自原则与经验，不硬绑官方文档通道）；`depth.bias` 与 `concept` 同档（0），不额外加深；`mode` 缺省 `explain`。
- **决策型提示词**：`lib/prompts.js` 的 `synthPrompt({ questionKind: 'decision' })` 增加 `输出结构（决策型）`，且**优先于 `mode`**：①「## 结论」第一行必须二选一写「该」或「不该」（允许「在 X 条件下该、在 Y 条件下不该」，但必须落到一个主判断，不许用「取决于」代替）；②「## 判据」列可量化阈值（团队人数、发布频率、故障定位时长、回滚成本…），一条一行写成「阈值 + 为什么是这条线」，无来源的标「（推断）」；③ 反例：什么情况下判断会反过来；④ 行动清单，每条可直接执行。
- **`## 判据` 必出章节**：`lib/brief.js` 新导出 `DECISION_CRITERIA_HEADING`（`'## 判据'`）与占位 `- 无`；`requiredSectionsFor({ questionKind: 'decision' })` = `## 行动清单` + `## 判据`；`CHECKLIST_REQUIRED_KINDS` 增 `'decision'`。

### Changed

- **固定优先级**：`KIND_PRIORITY` 插入 `decision`，位置 `… fresh-data → pricing → decision → tech-selection → learning → concept`。`decision` 在 `pricing` 之后（价格题由价目页决定，价格覆盖逻辑不变）；在 `tech-selection` 之前（`该不该用 React` 只有一个选项，是判断不是选型，选型表要求每个候选独立一行，单候选会退化成假对比）。同分时 `rankScores()` 按 `KIND_PRIORITY` 的先后定，不靠表顺序碰运气。
- **`## 判据` 缺失补 `- 无` 并降一档**：`requiredSectionsFor()` 声明后，`missingSections()` 会先看到它 → pipeline 传 `missingSections: true` 给 `computeConfidence()` 降一档；随后 `ensureSections()` 在「## 置信度」前补 `## 判据` + `- 无`。`## 判据` 不在 `ALWAYS_SECTIONS` 里，所以只有 `decision` 题会追这段。`lib/pipeline.js` 无需改动（既有 `requiredSections` 通路已经跑通）。
- **表列仍走 cost，不覆盖已分类类别**：`decision` 本来就在 `COST_COMPARE_KINDS` 里，`compareColumnKind('decision') === 'cost'`、`effectiveCompareColumnKind('decision', q) === 'cost'`；措辞升级保留，但降级为「调用方仍传 `concept`、或分类器还没学到的新说法」的兜底，`pricing` 与已分类类别永不被覆盖。
- `docs/architecture.md` 新增「decision 类别（0.10.0）」一节（信号分档、优先级理由、空 channels、决策型提示词、`## 判据` 的降档与补位），并把 0.9.10 里「真正的 `decision` 类别留到 1.0.0」改成 0.10.0 已落地。

### Tests

- `test/strategy.test.js` 13 → 16（+3）：C 题 → `decision` 且 `scores.decision === 6` / 强档+辅助档信号都在；辅助档单独不足以命名类别；`该不该买 X，多少钱` 仍 `pricing`；`该不该用 React` → `decision`；句级回归 `如何学习 Java` → `learning`、`A 和 B 哪个好` → `tech-selection`、`多少钱` → `pricing`、`React 还是 Vue 哪个好` → `tech-selection`；`decision` 包 `sourcePlan.channels` 为空、`depth.bias` 与 `concept` 相同、四条定向 query 精确展开并排在计划最前。
- `test/strategy-packs.test.js` 16 → 17（+1）：`decision` 的阈值/反例 query 领跑 `buildQueries` 计划，`concept` 不产生定向 query。
- `test/prompts.test.js` 11 → 12（+1）：决策型结构、该/不该二选一、`## 判据`、反例、行动清单、可判定判据规则；`mode: 'compare'` 下仍是决策型且不出现「对比型」；cost 表头且无价格列；其他类别不长出 `## 判据`。0.9.10 的「措辞升级」测试保留，注释改成「调用方仍传 generic 类别」的回归。
- `test/brief.test.js` 58 → 59（+1）：`requiredSectionsFor('decision')` 含 `## 判据` / 占位 `- 无`；缺失时 `missingSections()` 报出、`ensureSections()` 在置信度前补 `## 判据\n- 无` 且不重复；模型写好的判据原样保留；`concept` 仍为 `null`、`learning` 不长判据；缺段的置信度降一档（`high` → `medium`）。
- Golden：仓库里没有 `test/golden-*` 文件（只有注释里的 golden 说法），本版无 golden diff；C 题、`如何学习 Java`、`A 和 B 哪个好`、`多少钱` 的结果由上面的句级回归测试钉住。
- `node scripts/test-all.mjs` 19 个文件全绿（本机沙箱内 `node --test` 无法 spawn，逐文件直接执行）。

## [0.9.10] - 2026-11-16

> 0.9.9 收口时还剩两处没到位。其一，C 题（`我们团队 8 个人，微服务该不该拆`）的表头仍是 `| 选项 | 优势 | 风险 | 适用条件 |`——但它并不是「映射漏了 architecture/decision」（`architecture`/`decision` 在 0.9.9 就已经在 cost 桶里），而是这道题压根没被分类成那些类别：`classify()` 对它的 8 个类别分数全是 0、回落到 `concept`（confidence 0.35，signals `['fallback:no-signal']`），概念题按设计走中性列。其二，A 题（tech-selection）表头已经正确，但「成本概览」三格仍写「未核实（无来源）」：`sanitizeCompareTable()` 确实把 `未核实（无来源）` 清成了 `未核实`，随后 `checkCompareRows()` 按 `/成本/` 把「成本概览」认成价格列，又把标记加了回去——同一层的 `/\d/` 判据另有一处漏：只要格子里出现过数字就保留标记，于是「部署 1 个包（无来源）」这类文字格也留了下来。本版做两件事：**中性类别 + 决策措辞升级到 cost 列**，以及**「（无来源）」只留在纯数量格**。
>
> 必须记住的一条边界：**这一版没有让分类器认识判断类问题**。`classify()` 对 C 题仍返回 `concept`（`source: 'fallback'`、confidence 0.35），cost 列是由 `effectiveCompareColumnKind()` 按问题措辞升级出来的；`stats.questionKind` 保持 `concept`，只有调试统计行会把它打印出来。真正的 `decision` 类别要和 `QUESTION_KINDS`、sourcePlan、默认章节、golden 一起改，留到 **1.0.0** 单独做。

### Added

- **`effectiveCompareColumnKind(questionKind, question)`**：`lib/prompts.js` 新导出。先按 `compareColumnKind()` 得到桶，只有当桶是中性（`generic`）且问题带决策措辞（`该不该` / `要不要` / `值不值得` / `是否该` / `应不应该` / `是否值得` / `需不需要`）时才升级到 cost 列。`pricing` 和已分类的类别永不被措辞覆盖；`stats.questionKind` 仍保留分类器的原值——这是「表列决策」，不是重新分类。
- **`isPriceColumnHeader(cell)`**：`lib/brief.js` 新导出。`成本概览` 是 0.9.9 给判断题引入的中性成本列，允许直接写「未核实」，所以不算 `checkCompareRows()` 要标注的价格列；`价格` / `单价` / `费用` / `成本`（不带「概览」）/ `报价` 仍然是价格列。
- **调试统计行带类别**：`index.js` 的 `debugStats` 行在「引擎 …」后插 `· 类型 <questionKind>`（缺省 `concept`）。以后再出现「表头不对」，不必先手工跑一遍 `classify()` 才能知道这轮被分成了什么；`statsOf()` 本来就有 `questionKind`，流水线侧无需改动。

### Changed

- **`evaluate` 进 cost 桶**：评估题同样是判断题、没有价格轴，此前落到了 generic。`compareColumnKind('evaluate')` 现在返回 `cost`，表头为 `| 方案 | 优势 | 风险 | 适用场景 | 成本概览 |`；C 题这类「中性类别 + 决策措辞」也走同一套列，不再出 `| 选项 | 优势 | 风险 | 适用条件 |`。
- **`sanitizeCompareTable()` 的剥离边界改成「纯数量」**：除标签列外，单元格先剥掉 `（无来源）`，只有剥完剩下的是纯数字 + 单位（`0.2 元/百万 tokens`、`8 人`、`99.9%`、`20–40 ms`、`3 天`，含 `20–40` 这样的区间）时才保留原样——数字携带来源标记是 `markUnsourcedNumbers()` 的契约。文字格即便含数字（`部署 1 个包（无来源）`、`v22.11.0（无来源）`）也剥掉；`未核实（无来源）` → `未核实`。类别未知时表头仍保持原样。
- **`checkCompareRows()` 不再把 `（无来源）` 加回 `成本概览` 列**（转置表的 `成本概览` 行同理）：0.9.9 交付里那条 `未核实（无来源）`，就是 sanitize 清干净之后由这一层按 `/成本/` 重新标注的。pricing 题的价格列仍按 0.9.6 契约把 `未核实` 标成 `未核实（无来源）`，plain `成本` 列也仍按价格列处理。
- `docs/architecture.md` 补「类别映射与清理边界」：表头由谁决定、措辞升级的适用范围、`（无来源）` 的保留条件，以及为什么 `成本概览` 不在清理层被重新标注。

### Tests

- `test/prompts.test.js` 10 → 11（+1）：C 题同题面 + `questionKind: 'concept'` 出 cost 表头且不出 generic；四种决策措辞各断言一次；非决策的中性题仍走 generic；`pricing` 不被措辞覆盖；`compareColumnKind('evaluate') === 'cost'`。0.9.9 的类别循环里 `evaluate` 从 generic 组挪到 cost 组。
- `test/brief.test.js` 56 → 58（+2）：纯数量格保留 `（无来源）`、文字格（含数字）剥掉、`未核实（无来源）` → `未核实`、二次调用幂等；`buildResult()` 端到端不再出现 `未核实（无来源）`（带 `compareOptions`，确保这一条是真回归而不是空表），pricing 表的裸 `未核实` 仍被标注，`isPriceColumnHeader('成本') === true` / `isPriceColumnHeader('成本概览') === false`。
- `node scripts/test-all.mjs` 全绿（本机沙箱内 `node --test` 无法 spawn，逐文件直接执行）。

## [0.9.9] - 2026-11-15

> 起因是 0.9.7 的一道判断题（C 题「微服务该不该拆」）：它输出了「## 方案对比」，但表里带一列「价格」，每行都是「未核实」——这道题没有价格轴，那一列既填不出来、又读起来像一条结论；更糟的是第 3 行标签直接是「先拆 2-3 个服务（无来源）」，溯源标记漏进了标签列，候选名从此对不上任何选项。本版做两件事：**表列跟着问题类别走**，以及**溯源标记不许出现在标签列**。版本号仍写在 `package.json` 的 0.9.8，由发布 commit 统一 bump。

### Added

- **按类别定义对比表列**：`lib/prompts.js` 新导出 `COMPARE_COLUMNS`、`compareColumnKind(questionKind)`、`compareColumnsFor(questionKind)`。`pricing` → `| 方案 | 输入价 | 输出价 | 币种/口径 | 适用场景 |`；`tech-selection` / `architecture` / `decision` → `| 方案 | 优势 | 风险 | 适用场景 | 成本概览 |`（成本概览允许「未核实」，但不得编造价格或另加价格列）；其余（`learning` / `evaluate` / 未知）→ `| 选项 | 优势 | 风险 | 适用条件 |`。
- **`synthPrompt()` 可选 `questionKind`**：表头、缺值写法和「候选多时保留哪两列」都按类别派生；不传时回落到中性列，不再默认出现「价格」列。「N 个候选就是 N 行、每个候选独立一行、禁止并格」的硬规则与类别无关，三种表头都保留。
- **`sanitizeCompareTable(brief, { questionKind })`**：`lib/brief.js` 新导出（连同 `COST_OVERVIEW_HEADER`、`PRICE_SEE_NOTE`）。标签列剥掉 `（无来源）`/`(无来源)`/`（零证据）`/`（推断）`；非数值单元格（不含数字）剥掉 `（无来源）`，含数字的格保留标记；表头带「价格」且类别已知且不是 `pricing` 时，表头改成「成本概览」，没有 `[S#]` 的纯数字价格格改成「见注」（带引用的价格是证据，原样保留）——**不删行**，类别未知时保持原样。

### Changed

- **`buildResult()` 接收 `questionKind`**：在 `applyZeroEvidenceOptions()` 之后、`checkCompareRows()` 之前调用 `sanitizeCompareTable()`；参数缺省时读 `stats.questionKind`（`buildStats()` 本来就带了这一项，所以流水线侧无需改动）。
- **`markUnsourcedNumbers()` 不再标注第一列**：标签列放的是候选名，「先拆 2-3 个服务」里的 `2-3` 是名字的一部分、不是待核算的数字；此前它被补上 `（无来源）`，正是泄漏进标签列的那条路径（模型自己写进标签列的标记由 `sanitizeCompareTable()` 剥掉）。
- `docs/architecture.md` 增「对比表列与类别」小节，写清三套列、`见注` 的含义与识别边界。

### Tests

- `test/prompts.test.js` 9 → 10（+1）：三种表头各断言一次（pricing / tech-selection·architecture·decision / learning·evaluate·缺省），并断言非 pricing 提示词里不出现「价格」表头、每个候选独立一行的规则仍在。原有断言全部保留，`synthArgs()` 显式给了 `questionKind: 'pricing'`（题面本来就是价差题）。
- `test/brief.test.js` 53 → 56（+3）：标签列与非数值格剥标记、数字格保留标记；非 pricing 题「价格」列改「成本概览」且不删行、`pricing` 与类别未知时不动列；幂等 + 经 `buildResult()` 的端到端清理。
- `node scripts/test-all.mjs` 19 个文件全绿（本机沙箱内 `node --test` 无法 spawn，逐文件直接执行）。

## [0.9.8] - 2026-11-15

> 起因是 0.9.7 的一次 standard 价格对比题：豆包 seed 页 `https://www.volcengine.com/docs/82379/1099320` 抓到了、进了参考（S5，官方），正文却「只有页头，无可提取明细」——零证据。根因是价格在表格里：`heuristicEvidence()` 要求段落 ≥120 字（官方页 60 字），而表格每行只有几十字，且 `htmlToText()` 把 `</tr>` 拍成一个换行、`<td>` 拍成一个空格，于是整张价目表被字数门槛整段丢掉。本版做的是「价目行也算证据」：短行只要带 token 单价，就逐行抽成 `pricing` 证据并断言成可核对的 claim。

### Added

- **价目行证据**：`lib/pipeline.js` 的 `heuristicEvidence(page, { minChars })` 增加价目行分支。当 `isPricingEvidencePage(page)` 或 `page.via === 'seed'` 时，按行扫描正文，接受含 token 单价的短行（`0.0008 元/千 tokens`、`每 100 万 tokens`、`输入：0.002 元`、`$0.5 per 1M input tokens` 等），每行截 120 字、每页最多 8 条，`type: 'pricing'`，`quote` 保留原始行（只压空白、不重写）。
- **价目行断言化**：抽取时把「模型名 + 输入价 + 输出价」拼成 `claim`（`doubao-pro-32k 输入 0.0008 元/千 tokens，输出 0.002 元/千 tokens`），单位按页面原样保留（千 / 百万 / 十亿），不做二次换算；只有价格带 token 单位或紧跟在 `输入` / `输出` / `缓存命中` 标签后才会成为 claim，否则退回原行。
- `heuristicEvidence()` 内部新增 `pricingRowEvidence()` / `paragraphEvidence()` / `isPriceTableBlock()` 等私有辅助：一块「两行以上价格、且没有句末标点」的正文被判定为价格表，不再被当成一段可引用的段落。

### Changed

- **长段落仍优先，价目行追加**：`heuristicEvidence()` 由「返回一条证据」改成「返回数组」，顺序固定为「先长段落（老规则不变），再价目行」；两者都有时都保留，不互相替换。同一页若判成价格表，则不再额外生成一条「整表」段落 claim。
- **价目证据不按相似度并簇**：`groupEvidence()` 对 `pricing` 类型的证据只在 claim 完全相同时才合并——所有价目行的句式都一样（`输入 …，输出 …`），按 0.45 的相似度会把这页所有模型并进第一行，后面的型号就被藏在一个 claim 后面。
- **中文厂商名也能命中自己的价目页**：`optionMatches()`（`countOptionHits()` 的实现）对 `pricing` 证据把页面标题一并纳入匹配范围，因为价目行里写的是代号（`doubao-pro-32k`），而选项写的是厂商名（`豆包`）；`豆包大模型价格 - 火山引擎` 这样的标题让官方价目页能算作该选项的证据。
- **seed 直取的页标记为 `seed`**：0.9.7 的价目页直取把 `config.__fetchPage` 抓到的页直接塞进 `state.pages`，`via` 仍是抓取器写的 `web`/`jina`/`raw`；现在这一页额外标 `via: 'seed'`，让「不是厂商价目主机、但被当价目页直取」的页面也能走价目行扫描（`via` 只被 `isOfficialPage`（sitemap）、`gradeSource`（jina/render）与价目扫描读取，别处行为不变）。
- 三处调用点跟着改成数组语义：逐页兜底（`found = heuristicEvidence(...)` + `items.push(...found)`）、定向回补的 seed 直取路径、批量兜底循环；`statsOf()` 的「有价目特征却无可提取明细」诊断也改看数组长度。

### Tests

- `test/pipeline.test.js` +7：价目表产出多条 `pricing` 证据且 claim 含型号与两个价（`|` 竖线与空格两种拍平结果产出一致的 claim，quote 仍落在正文里）；`via: 'seed'` 的页即使主机不是价目站也扫描、同正文的普通页不扫；导航短行（`首页 | 产品 | 文档`）不产证据；长段落占第一条、价目行追加在后面；12 行只取 8 条且 quote ≤120 字；`专业版套餐 199 元/月` 这类套餐价不会被当成 token 单价；端到端一条——价目页直取命中后，该页在参考里是 `type: 'pricing'` 的来源且豆包选项被判定为已解决（这正是 0.9.7 里「进了参考却零证据」的现场）。
- 测试总数：`test/pipeline.test.js` 83 → 90（+7）；`node scripts/test-all.mjs` 19 个文件全绿。

## [0.9.7] - 2026-11-15

> 起因是 0.9.6 的一次 standard 价格对比题（87s/low）暴露的两处真实不一致：①表格已经正常（qwen / 豆包 / deepseek 三行独立，豆包行在但价格写 `无证据`），「## 未解决」却仍写「选项「豆包」在本轮证据中没有可用来源（零证据），未纳入对比」——同一份简报自相矛盾；②定向回补「解决 0」：抓到的两条 volcengine 页是 `volcengine.com/article/…` 与 `ai.volcengine.com/model`，都不是价目页，而已知价目页 `https://www.volcengine.com/docs/82379/1099320` 从未被优先抓取。本版做的是「文案跟表格对齐 + 价目页直接按 URL 取」。

### Added

- **价目页索引**：`lib/pipeline.js` 新导出 `PRICING_SEEDS`（`{ pattern, url }` 表）：`豆包|doubao|火山方舟` → `https://www.volcengine.com/docs/82379/1099320`、`qwen|通义|千问` → `https://help.aliyun.com/zh/model-studio/models`、`deepseek` → `https://api-docs.deepseek.com/quick_start/pricing`、`kimi|moonshot` → `https://platform.moonshot.cn`、`glm|智谱|chatglm` → `https://open.bigmodel.cn/pricing`；配套 `pricingSeedFor(option)` 与 `hasPricingSeedText(text)`（正文命中 `元|￥|$|/百万|1M|1000 tokens` 才算价目页）。
- **gap 文案的三种形态**：`lib/brief.js` 新导出 `ZERO_EVIDENCE_ROW_TEXT` / `ZERO_EVIDENCE_ROW_GENERIC_TEXT`，`zeroEvidenceGapText(option, { hasRow, priceTable })` 按「是否独立成行 + 是否价格表」选词：价格表 `在对比表中占位，但价格未取得（零证据）`；非价格表 `在对比表中占位，但未取得可用证据（零证据）`；无行仍是旧的「未纳入对比」。

### Changed

- **定向回补先直取价目页**：pricing 场景下 `targetedOptionRefill()` 先用 `config.__fetchPage` 打开该选项对应的 `PRICING_SEEDS` URL（占 1 个页预算），正文有价格特征就作为证据页插到最前、并跳过该选项的 `site:` 搜索（一条 seed = 该选项这一轮的整次重试）；404 / 不可读 / 正文无价格特征才回落到 `pricingTargetQueries()` 的检索。每选项仍是 1 seed + 1 query 上限。
- **不重复花预算**：seed 与搜索命中的 URL 先按 `canonicalKey` 跟 `state.pages` / `state.refillPages` 比对，已读过的不再抓取、不重复计页；本轮已失败过的 URL（`state.sourceFailures` / `state.officialFetchFailures`，典型是 Step 2b 已经 404 的 seed）也不再重试——同样的请求几秒后不会有不同结果，只会多花一个页预算和一次抓取超时。
- **文案在 `buildResult()` 收口**：比价表在合成之后才存在，所以 pipeline 的零证据 gap 仍按旧措辞生成（0.9.2 的 `（已定向检索 1 次仍未获证）` 等后缀照旧追加），由 `buildResult()` 在 `checkCompareRows` 之后用 `sink.owned` / `sink.priceTable` 改写为「占位」措辞——`realignZeroEvidenceGapText()` 同时处理 `brief` 与结果里的 `gaps`，`zeroEvidenceGapText()` 不传参时行为不变。
- **价格表识别看单位不只看表头**：`checkCompareRows()` 现在还会扫描整张表是否出现价格单位（`元/￥/$/百万/tokens/price/...`）——`| 方案 | 输入价 | 备注 |` 这类表头不含 `价格|单价|费用|成本|报价` 的比价表也能被识别为价格表，否则「价格未取得」会被误写成通用措辞。

### Tests

- `test/pipeline.test.js` +4：价目页索引与「什么算价目页正文」；seed 直取命中（seed URL 进 `sources`、`targetedRefill.optionsResolved >= 1`、不再发 `site:` 检索）；seed 仍 404 时回落检索（失败的 seed 不计 `pagesFetched`）；本轮已读过的价目页不会被重抓（同一 URL 全程只取 1 次）。
- `test/brief.test.js`：零证据三种措辞（价格表 / 非价格表 / 无行）断言。
- 测试总数 372（19 个测试文件，本版新增 4 例），`node scripts/test-all.mjs` 全绿。

## [0.9.6] - 2026-11-15

> 起因是 0.9.5 的一次 standard 价格对比题（148s）暴露的两个真实回归：①「定向回补 1 项（解决 1）」确实跑了，但解决的不是豆包——`volcengine.com` 的定价页被读取、又被引用校验剔除，豆包单价仍缺；②「## 方案对比」只剩 deepseek-flash / deepseek-v4-pro 两行 + 一条合并行「qwen / 豆包 API」（价格列「未核实」、无 `[S#]`），候选被并格吞掉。本版做的是「表完整性校验 + 定向检索打准 + 别再把补到的页丢掉」。

### Added

- **比价表完整性校验**：`lib/brief.js` 新增 `checkCompareRows(brief, { options, stats, sink })`——解析「## 方案对比」表，按候选逐个确认是否**独立成行**。被合并进 `qwen / 豆包 API` 这类单元格的候选，在表后补一行 `> 注意：豆包 未作为独立行出现（价格未取得），下表结论不含该候选。`；独立成行但价格列为 `未核实 / 未知 / —` 的补 `（无来源）`（本来就写 `无证据` 的不重复标）。返回布尔并写 `stats.compareRowsComplete`，`buildResult()` 在合并段之后调用（`compareOptions` 由 `pipeline` 传入）。
- `lib/pipeline.js` 新导出 `PRICING_HOSTS` / `pricingHostFor()` / `pricingTargetQueries()` / `pricingHostOfUrl()` / `isPricingEvidencePage()` / `isPricingScenario()`：`豆包|doubao|火山方舟` → `volcengine.com`、`qwen|通义|千问` → `help.aliyun.com`、`deepseek` → `api-docs.deepseek.com`、`kimi|moonshot` → `platform.moonshot.cn`、`glm|智谱` → `open.bigmodel.cn`。

### Changed

- **定向回补按厂商价目站检索**：pricing/compare 场景下 `targetedOptionRefill()` 的 query 从通用 `${option} 官方 价格` 改为 `site:<host> ${option} 价格 tokens 百万`（没有映射的选项回落 `${option} API 价格 每百万 tokens`），仍是每选项 1 条、最多 3 个选项；命中厂商主机的页排到证据批最前（`pricingHostsFirst()` / `pricingFirst()`），因为墙钟取消只影响靠后的批次——页进了 `pages` 但排在末尾，等于没进证据。
- **引用校验只对回补页放宽**：`validateCitations(brief, sources, { refillUrls, maxKept = 2 })` 不再无条件丢弃未被引用的来源——属于定向回补页的保留最多 2 条，`参考` 里标 `（已检索，未被采用）`；`adoptedSources`/`adoptedUrls`/`officialAdopted` 只算真正被引用的（`citedOnly`），采用率不会被虚高。
- **合成提示词硬规则**：compare 模式明确「每个候选必须独立一行，禁止用 `/`、`、`、`与`、`和` 把两个候选合并进同一格（如「qwen / 豆包 API」）；拿不到价格的候选写「未核实（无来源）」并保留该行」；表格行数上限从「最多 3 行」改为「N 个候选 N 行」，非对比表仍最多 3 行。

### 仓库

- **Release 补建路径修正**（`2aa5d12`）：`workflow_dispatch` 补建历史 Release 时原本会检出 `main` 却按旧 tag 校验 `package.json` 版本，且旧 tag 树里没有 `scripts/release-notes.mjs`，导致 v0.9.0–v0.9.4 补建必然失败。现在 dispatch 路径检出 `main`、只校验 tag 存在且 `CHANGELOG.md` 有对应小节；push tag 路径仍检出 tag 并校验版本一致。
- **发布一致性检查**：新增 `scripts/check-release.mjs`（版本号与 CHANGELOG 小节、小节从新到旧、README 预算表与 `lib/pipeline.js` 的 `DEPTH_PROFILES` 逐字段一致、文档里没有写死的测试例数），接进 CI 的 `docs & metadata` job；`test/repo-hygiene.test.js` 加 5 例。
- **整洁性检查扩到 Issue 表单**：`scripts/check-docs.mjs` 现在还会校验 `.github/ISSUE_TEMPLATE/*.yml` 的必填键、`body[].type` 白名单与 id 唯一性——写坏的模板 GitHub 不报错、只是静默不显示。
- **README**：界面节补上设置页与研究材料胶囊两张截图（此前只有卡片截图被引用），文档索引表补 `CONTRIBUTING` / `SECURITY` / `CODE_OF_CONDUCT`。

### Tests

- `test/brief.test.js` +4：`checkCompareRows` 三类（合并行→提示、缺价格→`（无来源）`、正常表与转置表→不动且幂等）+ 回补未被引用来源的保留与标注。
- `test/prompts.test.js` +1（并格禁令用例）并改写 1（行数上限断言改为「每行一个方案」）。
- `test/pipeline.test.js` +3（映射表、场景判定、厂商价目页识别），4 个既有定向回补用例改为断言 `site:` query。
- 测试总数 360（19 个测试文件，本版新增 8 例），`node scripts/test-all.mjs` 全绿。

## [0.9.5] - 2026-11-15

> 起因是一次 standard「国内大模型 API 价格对比」真实运行：180s 预算下拆题 26s / 检索 49s / **证据 86s** / 合成 14s，定向回补因「剩余时间不足」没跑，最终「可读 10 篇 · 采用 1 篇、豆包零证据」。本版把证据提取并行化并上调墙钟，同时补上「采用率为什么是 1」的诊断信号。

### Added

- **证据提取可观测**：`stats.evidenceBatches` / `evidenceModelItems` / `evidenceHeuristicItems`（按批 index 计数，重试不重复计），debugStats 行新增 `· 证据 批 b / 模型 m / 启发式 h`——「采用 1」到底是「模型没给论断」还是「页面太薄」，一眼可分；`extractEvidence()` 新增可选 `tally` 参数。
- **采用率诊断**：「参考」里在 `- 另有 N 个页面被读取但未采用（域名）` 之后补一行原因分布 `- 未采用原因：低于字数门槛 X 段 · 模型未给论断 Y 段 · 已过期 Z 段 · 引用校验剔除 U 段；另有 F 篇抓取失败`（0 项省略）。`stats` 相应新增 `fetchFailed` / `droppedNoEvidence` / `droppedBelowMinChars` / `droppedModelNoClaim` / `droppedStale` / `droppedUncited`，按页逐一分类（复用 `heuristicEvidence()` 的 60/120 字门槛），`readable` 改为按 `canonicalKey` 去重后计数。

### Changed

- **证据阶段并行（性能）**：`lib/pipeline.js` 新增 `EVIDENCE_CONCURRENCY = 2` 与 `extractEvidenceInBatches()`，主证据阶段和 `gapRefill()` 都改为「最多 2 批在飞」，结果按批 index 回填后按顺序 `groupEvidence()` + `mergeClusters()`，`[S#]` 编号与「参考」顺序与串行完全一致。standard 的 10 页（batch 3→4 批）理论耗时从 ~4×t 降到 ~2×t：0.9.3 实测 86s → 预计 ~45-50s。
- **单批失败不再拖垮整轮**：证据 `jsonCall` 包了 try/catch，非 abort 的失败（典型是双批并发下的 provider 429）记日志后按逐页启发式兜底，与「模型没给论断」同一条降级路径；`signal` aborted 仍原样抛出，墙钟取消语义不变。
- **墙钟预算上调**：`DEPTH_PROFILES.wallMs` quick 90s→120s、standard 180s→240s、deep 300s→360s（保持 quick<standard<deep）；`index.js` 工具超时仍是 `max(config.timeoutMs, deep.wallMs) + 20s`，下限随之到 380s。
- **定向回补时间守卫 30s→45s**：并新增降级路径——剩余 <45s 但 ≥20s 且还有页预算时只跑 1 条 query、最多 1 页（`TARGETED_REFILL.degradedMinRemainingMs = 20000`），跑完即停；剩余 <20s 才仍写「剩余时间不足」跳过标注。

### 仓库

- **Release 自动化**：新增 `.github/workflows/release.yml`——推 `v*` tag 时用 `CHANGELOG.md` 里该版本的段落创建 GitHub Release；发布前校验 tag 与 `package.json.version` 一致，已存在的 Release 不覆盖（可重复触发）；历史 tag 可用 `workflow_dispatch` 补建。配套 `scripts/release-notes.mjs` 负责抽取版本段落。
- **整洁性检查**：新增 `scripts/check-docs.mjs`（必需文件、Markdown 相对链接、CHANGELOG 版本条目、`package.json` 元数据与零依赖），接进 CI 的 `docs` job；`test/repo-hygiene.test.js` 3 例覆盖段落抽取与检查逻辑。
- **CI 与依赖**：Actions 升到 `actions/checkout@v7` / `actions/setup-node@v7`（与 Dependabot 提的 #1、#2 对齐），语法检查从两个入口文件扩到全部 `.js`/`.mjs`；`.github/CODEOWNERS` 就位；Dependabot 把 Actions 更新聚成一个 PR、npm 只保留「误引入依赖」的月检。
- **规则与忽略**：`docs/release.md` 改为「只打 annotated tag、已推送 tag 不移动、文档不写死测试数、提交身份要求、Actions 版本策略」；`CONTRIBUTING.md` 的 PR 检查表加 `check-docs` 与 tag 规则；`.gitignore` 补 `.cache/`（缓存默认落盘位置）与编辑器目录。

### Tests

- `test/pipeline.test.js` +4、改写 1：并发提取（假模型观测到同时 2 批在飞，完成顺序与批次顺序不同、合并结果仍按批序）、单批失败降级为启发式、30s 余量降级为 1 条 query、`droppedNoEvidence`/原因分布统计与简报原因句；0.9.3 的墙钟跳过用例 skew 改按 360s 预算计。
- `test/strategy.test.js`：墙钟断言改为 120000/240000/360000，并加 quick<standard<deep 顺序断言。
- 测试总数 352（19 个测试文件，本版新增 4 例），`node scripts/test-all.mjs` 全绿。

## [0.9.4] - 2026-11-15

> `v0.9.3` 的 tag 指向材料粘贴区提交（`dc0b8a0`）；本版是紧随其后的定向回补修复（`e1f4286`）。已推送的 tag 不移动，按 SemVer 另发一个补丁版本。

### Added

- `stats.targetedRefill` 增 `skipped`（`'budget'` / `'time'` / `null`）与 `triedOptions` / `resolvedOptions`：回补即使一条 query 都没发，也会留下「为什么没跑」的记录（`optionsTried` 计进入回补的零证据选项数，预算为 0 时也计）。

### Changed

- **跳过不再静默**：「未解决」里的零证据 gap 按 `skipped` 分三支——跑了但没补上仍是「（已定向检索 1 次仍未获证）」，因预算跳过写「（页预算耗尽，未做定向检索）」，因墙钟跳过写「（剩余时间不足，未做定向检索）」；`> 检索流程：` 行尾与 `debugStats` 行同步写「· 定向回补跳过（预算不足）」/「（时间不足）」，不再把「没跑」说成「跑了」。

### Fixed

- **定向回补被预算静默跳过（0.9.2 回归）**：B 题「国内大模型 API 价格对比…」里 12 页预算在常规选页就被吃满，`targetedOptionRefill` 撞上 `no page budget left` 直接 return，于是流程行没有「定向回补」段、「未解决」也没有「已定向检索」，看起来像没做这件事。`lib/pipeline.js` 的 Step 4 选页现在对 `isCompareRun()` 且 `compareOptions()` 解析出 ≥2 个选项的题预留最多 2 页给定向回补（`targetedRefillReserve`，与既有官方文档 `refillReserve` **叠加**而不是替换，且至少留 1 个常规搜索位），`wantedSearch` 与 Step 5b 官方链接余量都扣掉它；Step 8 的 `gapRefill()` 新增 `reservePages` 参数，gap 轮也不能吃掉这份预留。单测里 standard 档价格对比题从「回补被跳过」变成 `pagesFetched 11`（3 张种子页 + 7 张常规页 + 1 张定向页）；2026-11-15 真实网络复测（A/B，standard）回补不再静默跳过：A 题 `targeted refill resolved: LangChain4j`，B 题回补已发出（ddg-html 超时，本次未获新证，gap 如实写「已定向检索 1 次仍未获证」）。

### Tests

- `test/pipeline.test.js` +1、改写 1：新增「compare runs keep page slots for the directed retry」——常规选页本来会把 12 页预算吃满（`budgetFillingEngine()` 每条计划 query 回 12 条不同域、不同标题的命中），预留生效后定向回补仍抓到定向页，断言 `targetedRefill.skipped === null`、`pagesFetched === 11`、该选项不再进 gap 且页面进 `sources`；原「页预算/墙钟双守卫」用例改为断言跳过标注（budget → gap 含「页预算耗尽，未做定向检索」、流程行含「定向回补跳过（预算不足）」、`optionsTried >= 1`；time → 「剩余时间不足，未做定向检索」/「（时间不足）」），另两例的 `deepEqual` 补 `skipped: null` 并断言简报不含「定向回补跳过」。测试总数 344 → 345。

## [0.9.3] - 2026-11-15

### Added

- **研究材料粘贴区（`text` 的 UI 入口）**：此前 `text` 只能由模型在调用时传参，人在界面上没有入口。设置页新增「研究材料」`textarea`（新配置键 `material`，≤20000 字，超限截断并提示），保存后每次 `research` 调用自动把原文当最高优先级证据；简报末尾追加「材料来源：设置页的「研究材料」（N 字）。它只在本次调用里当证据用；清空设置后不再自动带上」；显式 `text` 仍优先，调用日志会标明来源。
- 输入框右侧多一枚「材料 N 字」胶囊（仅存在材料时出现），点击复制设置路径；设置页 summary 显示「默认深度：X · 材料 N 字」。
- `lib/config.js` 新增 `asMaterial(value, fallback, warnings)`（非字符串回落默认、trim、超限截断 + warning）与 `MATERIAL_MAX_CHARS = 20000`；`lib/schema.js` 增 `material` 字段（设置页可直接改）。

### Changed

- 修正文档里「深度胶囊是只读提示」的过期说法（0.9.1 起胶囊已可直接切换档位、启停插件），`README.md` 与 `docs/configuration.md` 同步更新。

### Tests

- `test/config.test.js` +1：`material` 默认空串、trim、纯空白视为未设置、20050 字截成 20000 并 warning、非字符串回落默认。
- `test/card.test.js` +4：summary 显示材料字数；粘贴→「草稿 N 字」→「保存材料」写入 `[{ op: 'set', path: ['material'], value }]` 且带 revision；「清空」写入空串；composer 在 settings 含材料时渲染「材料 N 字」胶囊（`createHooks()` 新增 `runEffects()` 以执行记录下来的 effect）。
- `test/wiring.test.js`：`fakeHarness()` 支持覆盖 config、记录每次给模型的 prompt；+2 用例——未传 `text` 时设置里的材料进入 prompt 且简报带来源提示，显式 `text` 覆盖材料时 prompt 里只有传参内容。测试总数 337 → 344。

## [0.9.2] - 2026-11-15

### Added

- **零证据选项的定向回补**：此前 B 题「国内大模型 API 价格对比：qwen、豆包、deepseek 哪家便宜」里豆包一条可用单价都没有，「未解决」只写「零证据」，没有任何补救。现在 compare 的零证据阶段（`lib/pipeline.js` 新增 `targetedOptionRefill()`）先给每个零证据选项（≤3 个）做**一次**定向检索：query 为 `<选项> <核心词>`，核心词取 `strategy.queries.extraTemplates[0]` 的意图（pricing → `价格 OR pricing`、official-docs → `官方 文档 OR official docs`、其余 → `官方 OR official`），query 里带选项原文；`searchAll` 取前 2 条非同域且未抓过的链接，`budget.take('pages', …)` 后 `pageFetcher` 抓取，成功页并入 `state.pages` 并跑 `heuristicEvidence()`（复用 0.6.2 的逐页兜底），证据经 `groupEvidence` + `mergeClusters` 后重算该选项命中数。
- `stats.targetedRefill: { optionsTried, pagesFetched, optionsResolved }`；`> 检索流程：` 行尾追加 `· 定向回补 N 项（解决 M）`（仅 tried>0 时）；`debugStats` 行同步加一段。

### Changed

- 补上了：删掉该选项的「零证据」gap，抓到的页面进入 `sources`（引用层照旧只保留被引用的来源）；仍为 0：保留原 gap 句子并追加 `（已定向检索 1 次仍未获证）`，让「零证据」不再读起来像没人查过。
- 预算安全：整段最多 3 个选项 / 3 页 / 3 次查询，页数取 `min(3, profile.pages, budget.remaining('pages'))`；墙钟余量 <30s 或已中止直接跳过；定向查询不占 `profile.queries`（计划预算已用尽，沿用 `gapRefill` 先例）；任何失败不抛异常，只记 `state.refillQueries`。

### Tests

- `test/pipeline.test.js` +3：豆包零证据 + 定向页可抓 → 不再进 gaps、页面进 sources、`optionsResolved === 1`；定向检索全空 → gap 保留且含「已定向检索 1 次仍未获证」、`optionsResolved === 0`；页预算耗尽或墙钟余量 <30s → 一次定向查询都不发。
- 既有 4 条断言随新行为微调：`官方定向` 正则去掉行尾锚点（流程行末尾多了定向回补段）、计划查询计数排除 ` OR ` 定向 query、0.7.1 零证据用例的假页面不再提到 `bun`（否则定向回补真把 bun 补上了）。测试总数 334 → 337。

## [0.9.1] - 2026-11-15

### Changed

- **仓库结构规整为开源产品形态**：更新日志从 `README.md` 拆出到本文件；README 收敛为「快速上手 + 索引」，管线细节、通道表、配置全表移入 `docs/`。
- 新增 `CONTRIBUTING.md`、`CODE_OF_CONDUCT.md`、`SECURITY.md`、`.editorconfig`、`.gitattributes`。
- 新增 `.github/`：CI（Node 20/22/24 矩阵 + 零依赖校验）、Issue 表单、PR 模板、Dependabot。
- 新增 `docs/architecture.md`、`docs/configuration.md`、`docs/development.md`、`docs/release.md`。
- `package.json` 补齐 `repository` / `homepage` / `bugs` / `author` / `scripts.test`，`files` 补上 `docs` / `CHANGELOG.md` / `LICENSE`。
- 新增 `scripts/test-all.mjs`：一条命令逐文件跑完全部测试（沙箱里 `node --test test/` 会 EPERM）。

### Added

- 首个 git tag：本版本起按 `vX.Y.Z` 打 tag，与 `package.json.version` 一致。

### Fixed

- **置信度广度只数域名（A 题）**：8 条官方文档页（`docs.spring.io` 7 条、`docs.langchain4j.dev` 1 条）覆盖了三个不同手册段，`computeConfidence()` 的 `strong` 集合却仍按 `siteKey()` 的 host 计，只有 1 个成员，于是「官方采用 8/12」被印成 `confidence: low`。`lib/util.js` 新增 `evidenceSiteKey(url)`：文档主机（`docs.*` / `help.*` 等，或 `sourceTier === 'doc-page'`）按 `host/首段路径` 计——`docs.spring.io/spring-ai` 与 `docs.spring.io/spring-boot` 是两个广度单位，同一段的两页仍是一个；github 按仓库计；其余按 host 计。`lib/brief.js` 只在 `strong`（广度）里改用它，`confirmed`（跨源确认）继续用原 `siteKey`，同一厂商的文档不会被当成互相独立确认。A 题由 `low` 升到 `medium`（仍不到 `high`：没有跨源确认、没有第二类一手源）。
  - 保守取舍：文档主机判定**没有**直接用 `isOfficialDomain`——那会把 `ec.europa.eu/a`、`/b`、`/c` 这类同一监管站点的不同路径数成三个广度单位，并打破 0.6.6 的过期源回归（每簇只剩一条 live 证据时必须仍是 `low`）。
- **对比表被误判「全部无证据」、选项名被切碎（B 题）**：价格题「国内大模型 API 价格对比：qwen、豆包、deepseek 哪家便宜」的三行全被改写成「无证据」，同时「未解决」里切出 `选项「国内大模型 API 价格对比：qwen」`、`选项「豆包」`、`选项「deepseek 哪家便宜」`。`lib/pipeline.js` 的 `compareOptions()` 先取最后一个 `：`/`:` 之后的部分，再按 `|` `/` `、` `，` `vs` `还是` 切分并丢弃含 `对比|价格|选型|哪个|怎么|如何` 的引导语段；`countOptionHits()` 改为按选项核心 token 匹配（拉丁词边界，允许 `qwen` 命中 `qwen2.5` 的版本后缀；中文按 ≥2 字子串），只有核心名 ≥2 字且命中 0 次的选项才写零证据 gap 与「无证据」行，清洗失败的段直接丢弃、不再产生假 gap。
- **测试**：`test/brief.test.js` +1（文档段广度 `low → medium`、同段不重复计）；`test/pipeline.test.js` +4（B 题原串解析出 `['qwen','豆包','deepseek']`、核心 token 命中、端到端只把豆包行改成「无证据」、`evidenceSiteKey` 的段/仓库/host 三种键）。原 `A、B、C 该怎么选`、`bun vs pnpm` 用例不改仍通过。
- 测试总数 334（0.9.0 的 329 + 5）。

## [0.9.0] - 2026-11-15

- **答案层：第一行必须是一句话结论**：`lib/prompts.js` 的 `synthPrompt` 现在把「## 结论」的首行钉成 `**一句话：<结论>**`（≤80 字，有推荐对象就点名，如「选 Node 22 LTS」），之后才是 2–4 句前提/依据；结论段里每个可核查判断的末尾必须紧跟 `[S#]`，没有来源的判断显式写 `（推断）`。证据不足（无一手源或零定量）时，先在前面单独一行写 `**（证据不足，以下为初步判断）**` 再给一句话结论；旧的「初步判断（证据不足）」措辞已删除，避免模型把免责声明和结论写进同一行。
- **新增「## 行动清单」段**：3–5 条，每条 `- ` 开头、动词开头、≤60 字、能直接执行；位置固定在「## 步骤」/「## 方案对比」之后、「## 坑与风险」之前；compare 类至少 1 条写「怎么小范围验证或试点」。`lib/brief.js` 的 `ensureSections()` 总会确保这一段存在：模型漏写时补 `## 行动清单\n- 无`，并且和既有缺段逻辑一致地参与降档。
  - 新增导出 `requiredSectionsFor({ mode, questionKind, base })`：compare / tech-selection / learning 把行动清单当必需段（缺了降一档置信度），concept / track 等只补占位不降档；它会和策略包自己声明的 `brief.requiredSections` 合并，`lib/pipeline.js` 的 `requiredSections` 改走这个函数。
- **定量对比的数字有出处**：`synthPrompt` 要求「## 方案对比」表的数字列每一行数字后都带 `[S#]`；`lib/brief.js` 新增 `markUnsourcedNumbers()`，在 `buildResult()` 里做一次兜底——表格行里没有 `[S#]` 的裸数字，在该单元格追加 `（无来源）` 而不是删掉数字，重复执行不会叠标记（幂等）。
- **测试**：`test/prompts.test.js` 断言一句话格式、推断标注、行动清单位置/条数/动词/试点要求、数字出处指令；`test/brief.test.js` 断言缺段补 `- 无` 与段位、compare 必需 / concept 可选、裸数字兜底与幂等；`test/pipeline.test.js` 断言端到端（假模型）在 `> 检索流程：` 之后确实出现 `## 行动清单` 且段序为 方案对比 → 行动清单 → 坑与风险，compare 缺段降档、concept 不降档；`test/strategy-packs.test.js` 的 legacy 段序断言随新段更新。
- 测试总数 329（新增 9：prompts +3、brief +3、pipeline +3；strategy-packs 的 legacy 段序断言按 0.9.0 段序改写 1 例，数量不变）。

## [0.8.3] - 2026-11-15

- **价格题不再被判成选型题，也不再被 Java 文档通道劫持**：0.8.2 实测 `node scripts/retrieval-check.mjs --question "国内大模型 API 价格对比：qwen、豆包、deepseek 哪家便宜" --depth standard` 得到 `adopted: docPage 9`，前 9 条全是 `docs.langchain4j.dev` / `docs.spring.io` 的 Java 文档页——问题里的「对比」命中对比措辞、「大模型」命中技术栈，于是 `classify()` 判成 `tech-selection`，走 `official-docs` 通道；问的是 API 价格，答的是 Java 手册。
  - `lib/strategies.js` 新增第八个 kind `pricing`（`QUESTION_KINDS` 里排在 `fresh-data` 之后，`KIND_PRIORITY` 里在 `tech-selection` 之前），并给它一个策略包：`queries.extraTemplates`（`{q} 价格对比 {year}`、`{q} api pricing per token`）、只声明 `pricing` 一条 `direct` 通道（hosts `api-docs.deepseek.com` / `help.aliyun.com` / `bigmodel.cn` / `www.volcengine.com`，seeds 复用 `PRICING_SEEDS`，`maxPages 4`）、`synthesis.dateRule`、`validation.staleDays 365`、`gates.gate 'medium'`。
  - `lib/strategy.js` 的 `PRICING_HINTS` 扩到价格/成本词表：`价格|定价|收费|多少钱|便宜|成本|费用|单价|价位|报价|计费|免费额度|每百万|每 tokens|per token|/1k tokens|price|pricing|cost|billing`（保留原有 `售价|费率|按量|元/|美元/|百万 tokens` 等）。`classify()` 命中价格词给 `pricing` **+6 并覆盖** `tech-selection`（信号 `kw:pricing:override`），即使同时出现 Spring / LLM / LangChain4j / RAG；`legal` / `troubleshoot` / `contested` 仍是更高优先级（`PRICE_DECISIVE_KINDS`：「CRA 合规要花多少钱」还是合规题），显式 `llmKind` 覆盖仍然最终生效。
  - **对比措辞 → `compare`**：新增 `PRICE_COMPARE_HINTS`（`哪家便宜|谁便宜|哪个更划算|价格…对比|对比|比较|cheaper|cheapest|compare`）；价格题命中时 `classify().mode` 建议 `compare`，否则 `explain`（「Spring AI 收费吗」→ `pricing` + `explain`）。
  - **文档通道兜底**：`resolveStrategy()` 只要问题命中价格词（`isPricingQuestion(question)`），无论调用方传的 `questionKind` 是什么，都会把 `official-docs` 从 `sourcePlan.channels` 里删掉、并把 `pricing` 通道提到最前——即使硬传 `questionKind:'tech-selection'`，「Spring AI 和 LangChain4j 收费对比」也只解析出 `pricing` 通道、0 个文档站；没有价格词时行为逐字不变（`tech-selection` 仍解析出 `['official-docs']`，其余 kind 的 `officialSeeds` 仍为空）。
  - `classify()` 的返回值多一个 `pricing` 布尔；`SIGNAL_VERSION` 2 → 3（分类信号形状变了，简报缓存键随之失效）。
- **实测（不带 `--mode`）**：

  ```text
  $ node scripts/retrieval-check.mjs --question "国内大模型 API 价格对比：qwen、豆包、deepseek 哪家便宜" --depth standard
  retrieval-check 0.8.3 · 2026-11-15T13:10:42.596Z
  focus: 未指定 · depth: standard · mode: compare（classify 推定）

  identified 54 · deduped 47 · readable 12 · adopted 10
  adopted tiers: docPage 10 · repoCode 0 · other 0  (doc-index 0 / repo-doc 0 / forum 0 / blog 0 / other 0)
  queries: 6（语义 4 / 技术 0 / 官方 2） · engineErrors 7 · clusters 12
  ```

  前 10 条采用来源全部是厂商价目页/价格文档（`api-docs.deepseek.com/quick_start/pricing`、`help.aliyun.com/zh/model-studio/models`、`www.volcengine.com/docs/82379/1099320`、`help.aliyun.com/zh/model-studio/model-pricing` 等），**`docs.spring.io` / `docs.langchain4j.dev` 一条都没有**。对照的 A 题（`Java 后端做 RAG 应用，Spring AI、LangChain4j、Haystack 该怎么选`）保持原样：

  ```text
  retrieval-check 0.8.3 · 2026-11-15T13:11:39.832Z
  adopted tiers: docPage 10 · repoCode 0 · other 0  (doc-index 0 / repo-doc 0 / forum 0 / blog 0 / other 0)
  queries: 6（语义 4 / 技术 0 / 官方 2） · engineErrors 6 · clusters 11
  ```

  即「价格题修好了、选型题没被打扰」：A 题仍是 `tech-selection` + `compare`、官方查询 2 条、采用 `docs.spring.io/spring-ai` / `docs.langchain4j.dev`。
- 测试总数 320（新增 2：`test/strategy.test.js` 的分类与通道断言——价格题→`pricing`+`compare`、「Spring AI 收费吗」→`pricing`+`explain`、「两家价格谁便宜」→`pricing`+`compare`、法律题仍压过价格词、pricing 包 channels 含 `pricing` 不含 `official-docs`、硬传 `tech-selection` 同样被拦、A 题 channels 仍是 `['official-docs']`、词表覆盖 `免费额度`/`每百万 token`/`per token`/`/1k tokens`/`成本`；`test/pipeline.test.js` 的端到端——价格题不产生 `site:docs.spring.io` 查询、会产生 `site:` 官方价目页查询、不触发 sitemap）。

## [0.8.2] - 2026-11-15

- **不传 `mode` 也能认出选型/对比题**：实测同一条问题「Java 后端做 RAG 应用，Spring AI、LangChain4j、Haystack 该怎么选」在不传 `mode` 时被 `classify()` 判成 `concept`（`signals:["fallback:no-signal"]`），`sourcePlan.channels` 因此为空：没有官方定向查询、`docPage` 只有 5 条；显式 `mode:'compare'` 才落到 `tech-selection` 包（`docPage` 10 条、官方查询 2 条）。用户日常不会传 `mode`，所以分类器必须自己认出来。
  - `lib/strategy.js` 新增 `COMPARE_HINTS`（`该怎么选|怎么选|选哪个|哪个好|哪个更|如何选择|二选一|三选一|还是用|选型|对比|比较|差异|区别|which (one )?should i|\bvs\.?\b`）、`TECH_HINTS`（`java|spring|node|react|vue|python|go|rust|rag|llm|数据库|框架|中间件` 等，刻意比 `DEV_HINTS` 窄）和 `hasOptionList()`（`A、B、C` 或 `A/B/C` 三个并列选项自身也算对比信号）。命中对比措辞**且**命中技术栈 → `tech-selection` +3；只命中对比措辞（如「HBase 和 Cassandra 哪个好」）→ 仍归 `tech-selection` +2。**没有新增 `comparison` kind**：七个 kind 的优先级、策略包与缓存维度都保持不变，而 `tech-selection` 包本来就是做对比的策略（`mode:compare`、`## 方案对比`），把它当成无效词表之外的对照答案。
  - `classify()` 现在返回 `mode`：显式传入的 mode 永远优先；没传时，落进 `tech-selection` 的对比题建议 `compare`，其余仍是 `explain`。显式 `mode:'explain'`（或其他非 compare 模式）不会被二次猜测，对比信号也不参与打分——用户明确说了要什么。
  - `lib/pipeline.js` 的 `runResearch({ mode })` 默认值从 `'explain'` 改为不设默认：没传就保持 `undefined` 交给分类器，`resolvedMode = 显式 mode ?? classify().mode`；`stats` 新增 `mode`（有效模式）。`index.js` 先分类一次（纯函数、无 IO），把 `classification` 传给 pipeline，并用**有效 mode** 算缓存键：隐式 compare 与旧的 explain 条目不会互相命中，而 concept 题的键与 0.8.1 逐字节相同。
- **实测（不带 `--mode`）**：`node scripts/retrieval-check.mjs --question "Java 后端做 RAG 应用，Spring AI、LangChain4j、Haystack 该怎么选" --depth standard`

  ```text
  adopted tiers: docPage 10 · repoCode 0 · other 0  (doc-index 0 / repo-doc 0 / forum 0 / blog 0 / other 0)
  queries: 6（语义 4 / 技术 0 / 官方 2） · engineErrors 6 · clusters 11
  ```

  `docPage` 5 → 10，官方查询 0 → 2，且脚本头现在打印 `mode: compare（classify 推定）`（`--json` 的 `mode` 也改为有效模式）。`SIGNAL_VERSION` 1 → 2（分类信号形状变了）。
- 测试总数 318（新增 2：`test/strategy.test.js` 的分类规则——该问题→`tech-selection`+`compare`、`A、B、C 该怎么选`→`tech-selection`(对比)+`options:>=3`、无技术词「HBase 和 Cassandra 哪个好」按规则归 `tech-selection`、显式 explain/track 不被覆盖；`test/pipeline.test.js` 的不传 mode 端到端——`stats.questionKind/mode`、`queriesByKind.official ≥ 1`、`site:` 查询与 `官方定向` 行）。

## [0.8.1] - 2026-11-15

- **compare 选项名不再带上中文谓词**：真实输出曾出现 `选项「Haystack 该」在本轮证据中没有可用来源（零证据），未纳入对比`——问题以 `Haystack 该怎么选` 结尾时，按 `|` `/` `、` `vs` `还是` 切出的最后一段把谓词一起带进了选项名，于是 `countOptionHits` 用「Haystack 该」去比对证据，命中必然为 0，零证据提示和对比表都写错名字。`lib/pipeline.js` 的 `cleanOptionToken` 现在对每个候选先按 `/(该怎么|怎么|如何|哪个|哪一种?|选哪个|怎么选|呢|吗|？|\?|。|，|,)/` 的**第一个**匹配截断再 `trim()`，并处理「Java 后端做 RAG 应用，Spring AI」这类逗号前缀（取逗号后带拉丁字母的那段），截断后为空、超过 24 字或全是噪声标点的候选直接丢弃；去重与 ≤5 不变。同一问题现在得到 `Spring AI / LangChain4j / Haystack`，`A、B、C 该怎么选` 得到 `A / B / C`（单个拉丁字母保留），`X vs Y 哪个好` 得到 `X / Y`，`只有 A` 不作为对比题处理。
- **planner 漏掉 `official` 时的兜底查询**：真实输出曾出现 `查询 中文语义 3 / 英文技术 3 / 官方定向 0`——`planPrompt` 要求「2–3 条定向官方域名 query」，但模型只回中文/英文时，合并后的查询里没有一条 `site:`，策略里声明的官方文档站一次都没被定向到。`lib/pipeline.js` 的查询合并处在 `queriesByKind.official === 0` 且 `strategy.sourcePlan.channels` 含 `official-docs` / `pricing` / `standards` 时，从该通道**已声明**的 `bases` / `seeds` 取前 2 个 host（不碰 `hosts`，避免把 standards 名单猜成检索目标），生成 `site:<host> <core-term>` 追加到查询尾部；core-term 取 `latinTopic(question + focus)`，没有拉丁词时取问题前 20 字。追加受 `profile.queries` 上限约束（按 depth 为 2 / 6 / 16），满了先换掉**最后一条 `technical`**；planner 一条 technical 都没给（报告里的情形：6 条全是中文语义）时换掉最后一条任意类查询——总数不变，`official` 不再是 0。计数归入 `official`，`stats.queriesByKind` 与最终实际发出的查询逐条对齐（`> 检索流程：` 行不会再出现 `官方定向 0`）。prompt 措辞未改；`concept`/默认策略没有官方通道，行为保持原样。
- **回归脚本可复现 `mode`**（0.8.1）：`scripts/retrieval-check.mjs` 增 `--mode explain|compare|track|evaluate`。此前脚本不传 `mode`，真实报告里的 `官方定向 0` 走的是 `compare → tech-selection` 包（策略声明了 official-docs 通道），脚本却总是落回 `concept`（无官方通道），既复现不出也验证不了这条修复；现在 `--mode compare` 能跑同一条路径（输出头多一段 `· mode:`，JSON 也多一个 `mode` 字段）。
- 测试总数 316（新增 6：`compareOptions` 的谓词截断与逗号前缀、零证据 gap 用截断后的选项名、planner 只给 semantic/technical 时兜底出 `site:` 且不改总数、全是语义且预算已满时仍然出官方查询、已有一条 official 时不重复追加、`officialBackstopQueries` 只认已声明的 bases/seeds 与无官方通道时为空；`--mode` 并入原有 parseArgs 用例）。

## [0.8.0] - 2026-11-15

- **可复跑的检索回归脚本**：`scripts/retrieval-check.mjs` 把**真实引擎 + 真实抓页器**接进 `runResearch`，只把模型换成假客户端，于是「检索与选页」成为唯一变量——不必每次跑完整 2 分钟研究，也不需要可用的 LLM key：

  ```bash
  node scripts/retrieval-check.mjs --question "Java 后端做 RAG 应用，Spring AI、LangChain4j、Haystack 该怎么选"
  npm run retrieval-check -- --question "…" --focus "迁移成本,生态" --depth deep --json
  ```

  - 引擎：先读 `TAVILY_API_KEY`；没有则从 `~/.dsh/profiles/desktop/cordis.patch.yml` 的 `keys:` 段读 `tavily`（引号值与裸值都认，`engines.tavily: true` 这类同名字段不会被误读）；两处都没有就只跑 `ddg-html` 并在 stderr 说明「DuckDuckGo 一拦爬虫整轮就会失败」。
  - 输出（human）：四数 `identified · deduped · readable · adopted`；**采用来源按档位拆分** `docPage / repoCode / other`（括号里给全档位 doc-index / repo-doc / forum / blog / other 明细）；`verticals` 与「垂直源命中」数；`queries`（含语义/技术/官方分类）、`engineErrors`、`clusters`；前 10 条采用 URL 及 `sourceTier(url)`；耗时；`RESULT: PASS/FAIL`。
  - `--json` 时只把 JSON 打到 stdout（日志仍走 stderr），便于存档前后对比；`--depth` 默认 `standard`（实测一次约 14 s）。
  - 退出码：采用数 `< 1` 时为 `1`。它只回答「选页有没有全丢」，不判断内容质量——假模型给固定简报（`## 结论` + `[S1]…[S10]`），所以采用数跟着真实选出的页面走，`docPage/repoCode` 的拆分才是回归信号（0.7.0 的回归 A 就是「github 5 条、文档 2 条」）。
  - 为什么用假模型：`lib/llm.js` 只有一个 `stream()` 入口，没有 `call(prompt)`；脚本实现了同形状的假客户端，按 prompt 分派——`检索计划` 回 `{"queries":[{"q":"<问题>","kind":"semantic"}],"directUrls":[]}`，`拆解` 回固定 `subQuestions`（不写 `criteria`，让 focus 生效），证据回 `[]`（随后照常走逐页启发式兜底），其余回固定简报。
- **脚本纯函数可单测**：统计与参数解析拆成 `summarize(sources, stats)`（四数 + 档位分桶 + 前 10 条）、`exitCodeFor(summary)`、`tavilyKeyFromPatch(text)`、`parseArgs(argv)`，`test/retrieval-check.test.js` 不联网只 import 这些函数。
- 测试总数 310（新增 retrieval-check 5：档位分桶与四数一致、`stats.adopted` 兜底与 top10 截断、退出码判定、`tavilyKeyFromPatch` 引号/裸值/`engines.tavily` 不误读、`parseArgs` 的 `--flag value` 与 `--flag=value`）。

## [0.7.1] - 2026-11-15

- **零证据选项显式提示**：compare 模式（以及 `tech-selection` 一类对比式选型）在合成前先算每个候选选项的证据覆盖。`lib/pipeline.js` 的 `compareOptions(question, focus)` 从问题与评估维度里按 `|`、`/`、`、`、`vs`、`还是` 切出候选（去重、最多 5 个），`countOptionHits` 用选项 token 与 cluster 的 claim/证据文本比对；命中为 0 的选项追加进 `gaps`：`选项「X」在本轮证据中没有可用来源（零证据），未纳入对比`，同时写进 `stats` 之外的结果字段供简报兜底。`lib/brief.js` 的 `applyZeroEvidenceOptions` 再把「## 方案对比」表里该选项行的其余单元格改写为 `无证据`（模型漏写这行时补一行；整段没有表格时退化成 bullet），并在「## 未解决」保留同一句。改表发生在 `validateCitations` 之前，被清掉的 `[S#]` 不会留在参考里；函数幂等。
- **缓存落盘（默认关闭）**：`config.cache.persistPath`（默认 `''`，空=只放内存，相对路径相对 workspace）与 `persistDebounceMs`（默认 500，0=立即写）。`ResearchCache` 增 `load()`：启动时读回 JSON、校验结构、丢弃过期条目并按 `maxEntries` 截断；`save()` 防抖写临时文件再 `rename`，`set/clear` 自动触发；`flush()` 供测试与退出前等待。坏快照只经 `onError` 记日志，不让插件启动失败；空路径完全不碰文件系统。
- **planner 查询三分类**：`planPrompt` 要求 `{"queries":[{"q","kind"}],"directUrls":[],"reason":"..."}`，`kind ∈ semantic|technical|official`（中文语义 / 英文技术 / `site:` 官方定向）。旧格式的裸字符串 query 照常可用并默认按 `semantic` 计；缺 kind 时 `lib/pipeline.js` 按形状兜底（`site:`→official、含中文→semantic、其余→technical），`stats.queriesByKind` 计数，`> 检索流程：` 行尾追加 `· 查询 中文语义 a / 英文技术 b / 官方定向 c`（仅当总数 > 0，四数行原有格式不变）。
- 测试总数 305（新增 cache 4：落盘重建读回、过期条目不读回、空路径不写文件、坏快照容错；config 1：落盘配置校验；brief 2：流程行 query mix、无证据表改写；prompts 1：plan 的 kind 字段；pipeline 3：kind 计数与流程行、旧字符串格式、compare 零证据选项）。

## [0.7.0] - 2026-11-15

- **证据排序层**：`lib/util.js` 新增 `sourceTier(url)`，只按 URL 的形状判定这一页是什么证据，返回 `doc-page` | `doc-index` | `repo-doc` | `repo-code` | `forum` | `blog` | `other`：

  | 档位 | 判定 | 排序权重 |
  | --- | --- | --- |
  | `doc-page` | 文档站的具体页：路径段 ≥2 且含 `/reference/`、`/api/`、`/docs/`、`/guide/`、`/guides/`、`/tutorials/`、`/manual/`、`/learn/`；或 `docs.*` 一类文档主机上 ≥2 段的页（`docs.python.org/3/library/json.html`） | `+4` |
  | `doc-index` | 文档站根、只有一段路径的文档页 | `+2` |
  | `repo-doc` | `github.com` 的 `blob/tree`，且是 `.md/.mdx/.adoc/.rst` 或路径含 `/docs/` | `+1` |
  | `repo-code` | `github.com` 的 `blob` 源码文件（`.java .kt .py .ts .js .tsx .jsx .go .rs .rb .php .cs .scala .c .h .cpp`） | `−2` |
  | `forum` | `stackoverflow.com`、`news.ycombinator.com`、`reddit.com`、`*.discourse.*` | `−1` |
  | `blog` | 路径含 `/blog/`、`/news/`、`/press/`、`/changelog/` | `−2` |
  | `other` | 其余（含仓库首页、站点根之外的普通页、非法 URL） | `0` |

  判定顺序是 github → forum → doc-page → blog → 文档主机 → doc-index：仓库里的 `docs/*.md` 仍算仓库文档而不是厂商文档页，`spring.io/news` 仍算公告而不是文档索引。
- **`rankHits` 叠加档位权重**：原有官方域名 `+2`、github 相关性闸门 `+2`、stale `−3`、站点根 `−4`、EUR-Lex `±2` 全部保留，档位分加在官方分后面（厂商文档页既是官方又是文档页，两个理由都该计分）。效果是「具体 API/参考页」不再被引擎票数决定：构造命中里 `docs.spring.io/spring-ai/reference/api/chatclient.html`（1 个引擎）得 **13.8**，`github.com/…/ChatClient.java`（2 个引擎、域名可信、仓库名命中问题）得 **9.9**，领先 3.9；去掉档位项则是 9.8 : 11.9，仓库反超 2.1——这正是回归 A 里"官方文档进得了候选却压不过仓库"的数值来源。
- **Step 4 槽位保护**：`strategy.kind`（或 `questionKind`）属于 `tech-selection`、`learning`、`compare` 之一，或 `mode` 是 `compare` 时，只要候选里存在 `doc-page`，`selected` 里至少保留 1 条：先换掉 `repo-code` 位（把文档挤出去的就是它），否则换最后一个非 doc-page 位，两个 vertical 保护位不动。没有 doc-page 候选时不做任何填充——是**替换**不是追加，页预算不变。
- 回归依据：真实网络回归 A（RAG 选型）8 条采用来源里 github 5 条、docs.spring.io 2 条、langchain4j 1 条。
- 测试总数 294（新增 util 2：24 个 URL 的档位表、`doc-page > repo-doc > repo-code` 排序；pipeline 2：tech-selection 保留 doc-page 槽位、无 doc-page 候选时不填充；另修 strategy-packs 的旧排序夹具——`forum −1` 现在会改变那两条 URL 的先后）。

## [0.6.8] - 2026-11-15

- **跨主机 `<loc>` 改写**：`crawlSitemap` 返回前最多把前 `DOC_HOST_REWRITE_MAX`（默认 3）条跨主机条目换成 base 主机同路径版本。
  只在 base 是 `docs.*` 文档主机、且两侧都是 `.dev`/`.io` 文档类域名时启用；逐条 5s 探测，2xx/3xx 才替换，失败保留原 `<loc>`。
  `config.docHostRewrite`（0–3，默认 3，`0` 关闭）暴露给调用方，README 配置表已列出。
- **按题选择文档 base**：`official-docs` 通道的 `bases` 改为 `{ base, tags }`，`pickDocBases(question, focus, bases, { max: 2 })`
  按 tags 与问题 token 的重合度排序（多词 tag 要求全部 token 命中），通用 base 排最后，最多试 2 个；
  Spring AI 的 RAG 问题先到 `spring-ai/reference/`，Spring Boot 的 JPA 问题先到 `spring-boot`，不再互相串。
- **真实网络验证**：`crawlSitemap({ baseUrl: 'https://docs.langchain4j.dev/' })` → `ok: true`，返回的 3 条 URL 已改写为
  `docs.langchain4j.dev/tutorials/...`，对改写后的地址取回 200（原始 `langchain4j.github.io/tutorials/chat-memory` 实测 404）；
  `docs.spring.io` 上 Spring AI 问题经 `pickDocBases` 选中 `https://docs.spring.io/spring-ai/reference/` 作为第一个 base。
- 测试总数 290（新增 sources 4：改写成功、探测失败保留原值、`docHostRewrite: 0` 不探测、非文档主机不改写；
  pipeline 3：Spring AI 题序、Spring Boot 题序、无 tag 命中回退通用根）。

## [0.6.7] - 2026-11-15

- **base 相对 sitemap 发现**：`SITEMAP_PATHS` 拆成 `ROOT_SITEMAP_PATHS`（`/sitemap.xml` 等，站点根）与
  `BASE_SITEMAP_PATHS`（`sitemap.xml` 等，相对 `baseUrl` 目录）；先试根、再试 base，按解析后的 URL 去重，
  所以裸域名仍只花 3 次请求。`SITEMAP_PATHS` 保留为根候选的别名，`paths` 参数覆盖行为不变（纯根相对）。
- **内容校验**：200 不再等于命中——返回体必须同时含 `<urlset>`/`<sitemapindex>` 且解析出至少一个 `<loc>`，
  否则记 `not a sitemap` 并继续下一个候选（200 + HTML 的软 404 因此也能穿过）。
- **index 展开用子 map 自己所在目录**：子 `<loc>` 相对 index URL 解析，`/docs/` 下的 `sitemap-0.xml` 不会再被拼到站点根；
  子图不是 `<urlset>` 或没有 `<loc>` 时继续后面的候选而不是整轮失败。
- **请求上限**：候选 ≤6（根 3 + base 3，去重），加最多 2 次 index 展开，最坏 8 次请求、间隔 ≥400ms、整体 12s 预算。
- 真实网络验证：`crawlSitemap({ baseUrl: 'https://docs.spring.io/spring-ai/reference/', keywords: ['chat','memory','vector','advisors'] })`
  → `ok: true`，`sitemapUrl` 为该目录下的 `sitemap.xml`，3 条 URL 均在 `docs.spring.io/spring-ai/reference/` 下；
  `docs.langchain4j.dev` → `ok: true`，走根 `sitemap.xml`（其 `<loc>` 指向 `langchain4j.github.io`）。
- 测试总数 283（新增 sources 3：base 相对命中、200 HTML 软 404、index 子图按父目录解析）。

## [0.6.6] - 2026-11-15

- **过期页打标**：`lib/pipeline.js` 新增 `markStalePages(pages)`，Step 5 读完（含 5b 官方链接）后给每页写 `page.stale = looksStale(title + ' ' + snippet)`；用户提供的资料豁免（用户自己选的，不是工具挑的）。
- **证据层拦截**：`extractEvidence` 新增 `allowStale`（默认 false），模型引用与启发式兜底都跳过 `page.stale === true` 的页；只有全部可读页都过期时才允许使用，并在证据卡上带 `stale: true`。补缺轮（`gapRefill`）同一规则。
- **提示词标注**：`lib/prompts.js` 的 `evidencePrompt` 页头加 `，⚠ 已过期/停维护`，并加一条规则：这类页面只能用于历史背景，不能支撑当前状态/维护方/选型。
- **置信度折扣**：`lib/brief.js` `computeConfidence` 用存活证据重算 cluster 状态并排除过期来源的 confirmed/primary 计数（无过期卡片的 cluster 行为不变）。
- **冲突与缺口**：Step 9 与 catch 路径在 `analyzeAssertions` / `findSelfContradictions` 之前剔除 `stale` 证据（缺证据 ≠ 冲突）；新增「「属性」仅有过期来源，已剔除」（≤2 条）与 `唯一可读来源已过期（host）` 两类缺口。
- **参考行标注**：`appendReferences` 对过期来源行尾补 `（已过期，仅作参考）`。
- 测试总数 280（新增 pipeline 2、brief 2、prompts 1）。

## [0.6.5] - 2026-11-15

- **旧源降权**：`lib/util.js` 新增 `looksStale(text)`（已过期 / 不再维护 / 已归档 / deprecated / archived / end of life 等）；
  `rankHits` 命中 −3，且 `publishedAt` 早于 3 年再 −1。证据侧不过滤（`groupEvidence` 前不动），只在 selection 阶段排到最后：
  候选数超过页预算时才被挤出，唯一来源仍会进简报。
- **竖向保留槽位**不再把 stale 条目硬塞回 `selected`（`lib/pipeline.js` Step 4）。
- **sitemap 路径偏好**：`pickSitemapUrls` 对 `/reference/`、`/docs/`、`/api/`、`/guide/`、`/guides/`、`/manual/`、`/learn/`
  路径 +3，对 `/blog/`、`/news/`、`/press/`、`/events/`、`/changelog/`、`/tag/` 路径 −3；得分 ≤0 的条目丢弃。
- **`<lastmod>` 支持**：新增 `parseSitemapEntries` 返回 `{ loc, lastmod }`（`parseSitemap` 保持纯 URL 数组兼容），
  `lastmod` 早于 3 年再 −2。
- 真实网络验证：`crawlSitemap({ baseUrl: 'https://spring.io' })` 由 0.6.4 的三条 2015–2018 `/blog/` 旧文
  改为 `guides/gs/spring-boot`、`guides/gs/spring-boot-docker`、`guides/gs/spring-boot-for-azure`（spring.io 的 sitemap 里没有
  `/reference/`、`/docs/` 路径）；`docs.spring.io` 仍三条候选全 404。
- 测试总数 275。

## [0.6.4] - 2026-11-15

- **sitemap 路径候选**：`crawlSitemap` 从「`sitemap.xml` / `sitemap_index.xml` 两条、最多 2 次请求」改为有序候选
  `sitemap.xml` → `sitemap_index.xml` → `sitemap-index.xml`（`SITEMAP_PATHS` 导出，`paths` 参数可覆盖）。全 404 时正好 3 次请求；
  命中 `sitemapindex` 再允许 1 次展开子图（合计最多 4 次）。
- **软 404 不算命中**：候选是否成功改由 `parseSitemap` 的 `<loc>` 数决定，返回 `text/xml` 的 HTML 错误页会继续下一个候选。
- 真实网络验证：`crawlSitemap({ baseUrl: 'https://spring.io' })` → `ok: true`，`sitemap-index.xml` → `sitemap-0.xml`（7475 条 `<loc>`），
  按 `spring/boot/configuration` 命中 3 条 spring.io 页面；`docs.spring.io` 三条候选仍全 404（`ok: false`）。
- 测试总数 269。

## [0.6.3] - 2026-11-15

- **官方域名表扩充**：`OFFICIAL_DOMAINS` 加入厂商官方文档/价目页（`docs.spring.io`、`spring.io`、`langchain4j.dev`、`help.aliyun.com`、`bigmodel.cn`、`volcengine.com`、`api-docs.deepseek.com`、`docs.aws.amazon.com`、`cloud.google.com`、`learn.microsoft.com`、`react.dev`、`vuejs.org`、`docs.djangoproject.com`、`docs.python.org`、`developer.mozilla.org`、`nodejs.org`、`platform.qianwenai.com` 等）；`isOfficialDomain` 仍是 host 后缀匹配（子域也算）。价格/文档题不再「官方采用恒为 0」。
- **`pricing` 通道接线**：`sourcePlan` 的 `direct` 通道按 `seeds` 真实直取（DeepSeek / 阿里云百炼 / 智谱 / 火山方舟 四张价目页，全部先 curl 确认 200），页面标 `engine: 'channel:<id>'`，失败进 `sourceFailures` 不中断管线；`maxPages` 4。
- **`official-docs` 通道按 `bases` 回退**：sitemap 通道依次尝试声明的站点根（如 `docs.spring.io` → `docs.spring.io/spring-boot` → `docs.spring.io/spring-ai`），第一个成功即停，失败逐个记录后继续。
- **价格题强制标币种**：`synthPrompt` 要求价格表有「币种/单位」列；不同币种不得直接比较/排序，必须在「## 未解决」写「币种不同，未换算」。断言层的不可换算价格对只进 `### 口径差异`，并且 0.6.3 起单独出现也会生成该段（以前只有事实冲突或自相矛盾才会建段）。
- 只对价格类问题启用 `pricing.seeds`（`resolveStrategy` 会为非价格问题剥掉通道上的 `seeds`），避免发布/EOL 类问题把页预算花在价目页上；测试总数 266。

## [0.6.2] - 2026-11-15

- **逐页证据兜底**：`extractEvidence` 不再「整批为空才兜底」。模型只抽到部分页面时，任何没有产出证据的页面都会各自跑一次 `heuristicEvidence`，官方文档页不会因为别的页返了 1 条证据就被整批丢弃；`policy.heuristicFallback === false` 仍可整体关闭。
- **官方/通道页放宽阈值**：`heuristicEvidence(page, { minChars })` 支持阈值；`page.via === 'sitemap'` 或 `isOfficialDomain(page.url)` 时用 60 字符，其余保持 120，仍要过 `NAV_NOISE` 过滤。
- **官方采用率**：`statsOf` 新增 `officialReadable` / `officialAdopted`，「> 检索流程：」行尾追加 `· 官方采用 x/y`（`y > 0` 时才追加），读到没采用不再无声。
- 不改 `gradeSource` / 置信度公式，不动 `sourcePlan` / sitemap 逻辑；测试总数 261。

## [0.6.1] - 2026-11-15

- **检索四数流程行**：简报在「## 参考」前输出 `> 检索流程：识别 N 篇 · 去重后 M 篇 · 可读 K 篇 · 采用 J 篇`，`statsOf` 新增 `identified` / `deduped` / `readable` / `adopted`；`quick` 档同样输出，续跑标注复用页数。
- **冲突三分法**：「## 存在冲突」内分 `### 事实冲突` / `### 口径差异` / `### 来源自相矛盾`，空类写 `- 无`，三类全空不出现该段；新增 `findSelfContradictions(pages)` 识别同一页面内同属性自相矛盾（三值以上视为表格，不报）。
- 不改 `gradeSource` 与置信度公式，不动 `sourcePlan` / sitemap 逻辑；测试总数 257。

## [0.6.0] - 2026-11-15

- **sourcePlan**：策略按 `questionKind` 声明取源通道（official-docs / pricing / standards / papers），默认策略保持空通道、抓取集合不变。
- **sitemap 定向爬取**：`lib/sources.js` 解析 `sitemap.xml` / `sitemapindex`，按问题关键词给路径打分选页；Step 2a 只对 docs 类问题执行，计入页预算，失败隔离。
- **via 标记与降档**：取回结果统一带 `via`；经 Jina / 渲染兜底拿到的官方或论文来源在参考里降一档。
- **用户提供资料**：`text` 参数把正文作为最高优先级证据，参与缓存 key，不落盘。
- 新增 `test/sources.test.js`，测试总数 251。

## [0.5.3] - 2026-11-15

- **数值冲突按实体分组**：以模型/产品名为实体分组比较，跨实体的差异不再误报冲突，改在「未解决」写明「口径差异：…不可直接比较」（237 例测试全绿）。

## [0.4.0] - 2026-11-15

- **过程可见**：简报统计行末尾追加 `阶段 拆题/检索/精读/合成` 耗时，卡片下方渲染为四个小标签。
- **真实网络 e2e**：新增 `scripts/e2e-real.mjs`（`RUN_REAL=1` 触发），真实抓取 + 假合成，断言可跑通并产出引用。

## [0.3.0] - 2026-11-15

- 新增 **docs 垂直源**：React/Node/TS 类问题直连 MDN 搜索，Spring 与 Python 类问题直接给出官方文档入口。
- GitHub 源增加 **code search 回退**：issues 与仓库都空时按代码片段找"别人怎么写"。
- 付费引擎增加 **配额保护**：Tavily/Brave/Serper/Exa 有进程内用量上限，超限自动禁用并在 `stats.engineQuota` 暴露。

## [0.2.0] - 2026-11-15

- **准确性**：证据按发布日期加权（≤1 年加分、>2 年降权并标「旧」）；同一事实出现分歧时强制输出「## 存在冲突」段，列出双方与来源，不抹平。
- **有效性**：简报固定输出「## 下一步建议」（要跑的命令 / 要读的链接 / 要问的问题）。
- **产品化**：结果卡片支持一键复制 Markdown、来源折叠区（可点链接）、运行中转圈、失败与空结果态。
