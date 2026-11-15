# 架构

本文说明 `research` 工具的内部结构与关键机制。面向想改代码或判断它为什么给出某个结论的人；只想使用请回 [README](../README.md)。

## 一图流

```text
research(question, depth, focus, mode, context, researchId, text, saveTo)
  │
  ├─ 拆题 / 生成 query（模板 + 模型规划：中文语义、英文技术、官方定向）
  ├─ 检索：付费引擎(Tavily/Brave/Serper/Exa) → ctx.web.search → DuckDuckGo HTML
  │        垂直源直连：GitHub / StackExchange / npm / PyPI / arXiv / OpenAlex / HN
  ├─ URL 直取：用户贴的 URL 与 planner 给的官方 URL 优先抓
  ├─ 抓取分层：raw → web.fetch → Jina；EUR-Lex 走 Cellar XHTML；SO/HN 用 API 正文兜底
  ├─ 证据卡 + 引用接地（原文匹配）+ 交叉验证（多域名 / 立场）
  ├─ 缺口回补（含官方 / 法规定向 query）
  ├─ 零证据选项定向回补（每个选项 1 条 `<选项> <核心词>` query，最多 3 项 / 3 页）
  └─ 合成简报：结论 / 依据 / 对比 / 坑 / 置信度 / 未解决 / 参考 + 统计行
```

## 模块职责

| 文件 | 职责 |
|---|---|
| `index.js` | 插件入口：`apply()` 注册 `research` 工具、`research-protocol` skill、host 侧 `render` |
| `client.js` | Web 端卡片：经 client slot `tool.call.toolview` 注册 key `research`，解析简报渲染徽章与阶段 chip |
| `lib/pipeline.js` | 管线主体（十步）、预算控制、检索计划、回补、页面调度、结果组装 |
| `lib/strategy.js` | 问题分类 `classify()`：`questionKind` 与 `mode` 推定、价格词覆盖、信号版本 |
| `lib/strategies.js` | 各 `questionKind` 的策略包：query 模板、来源权重、`sourcePlan.channels`、必出章节、校验规则 |
| `lib/sources.js` | sitemap 定向爬取：探测、解析、关键词打分、路径先验、跨主机改写 |
| `lib/fetch.js` | 正文抓取分层（raw / web / jina / cellar）、GitHub blob → raw 改写、正文抽取与字数门槛 |
| `lib/engines.js` | 搜索源适配与失败隔离：付费引擎解析、DDG HTML 解析、challenge/4xx 自动禁用 |
| `lib/verticals.js` | 垂直源选择与解析：按问题打分取前 2 个，API 正文兜底 |
| `lib/brief.js` | 简报结构：必出章节、置信度、冲突三分、参考渲染、统计行 |
| `lib/assertions.js` | 断言层：从证据抽数值断言、实体归组、冲突判定（含单位不可换算） |
| `lib/prompts.js` | 模型提示词：拆题、检索计划、证据抽取、合成、答案先行与行动清单约束 |
| `lib/util.js` | URL 规范化与内容去重（`canonicalKey`）、官方域名判定（`isOfficialDomain`）、域名信任（`domainTrust`）、过期识别（`looksStale`）、证据档位（`sourceTier`） |
| `lib/cache.js` | 结果缓存：key 归一、TTL、LRU、原子落盘、坏快照容错 |
| `lib/config.js` | 配置校验：类型强转、越界夹取、未知键 warning |
| `lib/sessions.js` | `researchId` 续跑会话：页面与证据复用，30 分钟过期 |
| `lib/schema.js` / `lib/llm.js` | 模型输出结构与调用封装 |

## 检索计划（query 规划）

拆题后先让模型出 6–10 条检索计划（中文 2–3、英文 2–3、官方域名定向 2–3），再与确定性模板合并、去重后截断到该档预算。

- 模板只能生成「问题原句 + 官方」，拿不到英文原文与 EUR-Lex 这类一手源，所以模型规划是标准档/深档的必需项。
- 检索计划可给 1–2 个它确信存在的官方 URL，工具直接抓取并校验，读不通就跳过。
- planner 可给每条 query 标类别（`中文语义` / `英文技术` / `官方定向`），简报统计行会输出三类计数；缺省按形状兜底（`site:` → 官方定向，含中文 → 中文语义，其余 → 英文技术）。

## sourcePlan 通道

「取哪些源」由策略包声明，而不是散落在管线里的硬编码。通道形状：

```js
{ id, method: 'sitemap' | 'direct' | 'api', hosts: [...], bases: [...], seeds: [...], maxPages }
```

| 通道 | 适用 questionKind | method | 目标 | maxPages |
|---|---|---|---|---|
| `official-docs` | tech-selection / learning | sitemap | bases 带 tags 按题排序：`spring-ai/reference`、`spring-boot`、`docs.langchain4j.dev`、`docs.spring.io`；learning 用 `react.dev` / `nodejs.org` / `docs.python.org` | 3 |
| `pricing` | fresh-data / pricing | direct | 厂商价目页 seeds：`api-docs.deepseek.com`、`help.aliyun.com`、`bigmodel.cn`、`www.volcengine.com` | 4 |
| `standards` | legal | direct | `prisma-statement.org`、`cochrane.org`、`eric.ed.gov`、`owasp.org`、`eur-lex.europa.eu` | 2 |
| `papers` | contested | api | `arxiv.org`、`openalex.org`、`pmc.ncbi.nlm.nih.gov` | 2 |

`pricing` 的 `seeds` 只在价格类问题出现（`resolveStrategy` 对非价格问题会剥掉），否则发布/EOL 类问题会把整档页预算花在厂商价目页上。只要问题命中价格词，`resolveStrategy` 会删掉 `official-docs` 通道并把 `pricing` 提前——避免「问 API 价格、答了一页 Java 文档」。

## sitemap 定向爬取

`crawlSitemap` 的探测顺序：

1. 站点根：`/sitemap.xml` → `/sitemap_index.xml` → `/sitemap-index.xml`；
2. base 目录下同名文件（相对 `baseUrl` 目录解析，去重后不重复请求）。

命中条件不看状态码而看内容：返回体必须含 `<urlset>` 或 `<sitemapindex>` 且真解析出 `<loc>`，否则（含 200 但内容是 HTML 的软 404）继续下一个候选。命中 `sitemapindex` 时再展开一层子 sitemap，子 `<loc>` 相对 index URL 解析。

打分规则：

- 按问题关键词（latin token + CJK 短片段）对路径分词打分；
- 路径先验：含 `/reference/`、`/docs/`、`/api/`、`/guide/`、`/guides/`、`/manual/`、`/learn/` 记 +3；含 `/blog/`、`/news/`、`/press/`、`/events/`、`/changelog/`、`/tag/` 记 −3；
- `<lastmod>` 早于 3 年再 −2；
- 关键词至少命中一个仍是硬门槛（路径形状本身不算证据），最终得分 ≤0 的条目直接丢弃，不抓回来占页预算。

跨主机改写：站点换域名后常继续发旧 sitemap。`crawlSitemap` 返回前检查 `<loc>` 与 base 主机是否不同，只有 base 是 `docs.*` 文档主机且两边都是文档类域名时才改写，最多探测前 `docHostRewrite`（默认 3）条，5s 超时，2xx/3xx 才替换。

约束：候选数去重后 ≤6，命中 index 再允许 2 次展开（合计最多 8 次请求），请求间隔 ≥400ms，单次整体预算 12s，失败返回 `{ ok: false, reason }`，不抛异常；不解析 robots.txt（已知限制）。

## 抓取与正文

抓取路径由 `pageFetcher` 控制，默认 `raw`（插件内置 HTTP + 正文抽取，实测最忠实）；`auto` 只在宿主 `web.fetch` 返回正文 ≥400 字时采用，否则用 raw 重试并取更长者。

- GitHub `blob` 链接自动改写为 `raw.githubusercontent.com`，直接读原始 Markdown。
- 正文不足 400 字判为「未获取」；403、PDF/二进制（`%PDF-` 头）同样记为未获取。
- `eur-lex.europa.eu/eli/...` 正文由脚本渲染，抓取层把 CELEX/ELI 链接映射到 Cellar 的 `publications.europa.eu/resource/celex/<CELEX>` XHTML（`accept: application/xhtml+xml`），映射失败才回退普通抓取。
- 每个取回结果带 `via`（`raw` / `web` / `jina` / `cellar`，sitemap 页面由管线覆盖为 `sitemap`），供 `gradeSource(url, via)` 决定是否降档。

## 证据分级与排序

- 证据档位 `sourceTier`：`doc-page` > `repo-doc` > `repo-code`，另有 `official` / `paper` / `forum` / `blog` / `other` 分类用于参考标注。
- 同一页面的多语言版本、镜像（`cdn.jsdelivr.net`、`url.nodejs.cn`）、同一仓库不同 commit/分支、`.md` 与 HTML 两种格式，都按内容归一为一条来源。
- 单一来源的论断标「待验证」，来源冲突标「有争议」；不同仓库视为独立来源（不会因为同为 `github.com` 就被判成单一来源）。
- 过期页面 `looksStale`（已过期 / 不再维护 / 已归档 / deprecated / archived / end of life）在 Step 5 打 `stale` 标记，不参与置信度计算，证据抽取默认跳过。
- 一手来源门槛：standard/deep 档若全部证据都来自二手解读（没有可信域名/官方来源），置信度强制降为 `low`，并在「未解决」写明缺口。
- 置信度分两个口径（0.9.1）：**广度**用 `evidenceSiteKey()`——文档主机（`docs.*` / `help.*`，或 `sourceTier === 'doc-page'`）按 `host/首段路径` 计，github 按仓库计，其余按 host 计，所以 8 条官方文档覆盖 ≥2 个手册段即可从 `low` 升到 `medium`；**跨源确认** `confirmed` 仍用粗粒度的 `siteKey()`，同一厂商的不同文档段不会被当成互相独立确认。
- 页面兜底：模型只引用了部分页面时，没被引用的页面各补一条启发式证据（官方/通道页段落门槛 60 字符，其余 120 字符），避免「读到了却没采用」。
- 证据抽取并行：按 2 页一批（`EVIDENCE_CONCURRENCY = 2`）同时抽，单批失败（典型是双批并发下的 provider 429）记日志后回落逐页启发式；结果按批序合并，`[S#]` 编号与「参考」顺序与串行完全一致（0.9.5）。

## 价目页定向与比价表完整性（0.9.6）

比价题（`pricing` / compare）在报告前会对零证据选项做一次定向回补（0.9.2 起），0.9.6 把这套链路收紧了：

- **厂商价目站映射**：`PRICING_HOSTS` 把 `豆包|doubao|火山方舟` → `volcengine.com`、`qwen|通义|千问` → `help.aliyun.com`、`deepseek` → `api-docs.deepseek.com`、`kimi|moonshot` → `platform.moonshot.cn`、`glm|智谱` → `open.bigmodel.cn`；`pricingHostFor()` 取映射，`pricingTargetQueries()` 把回补 query 从「<选项> 官方 价格」改成 `site:<host> <选项> 价格 tokens 百万`，没有映射的选项回落「<选项> API 价格 每百万 tokens」。
- **回补页优先吃证据预算**：`pricingHostsFirst()` / `pricingFirst()` 把命中厂商主机的页排到证据批最前——墙钟取消只影响靠后的批次，页进了 `pages` 却排在末尾等于没进证据。
- **引用校验只对回补页放宽**：`validateCitations(brief, sources, { refillUrls, maxKept = 2 })` 不再无条件丢弃未被引用的来源；属于定向回补页的保留最多 2 条，并在「参考」标「（已检索，未被采用）」。`adoptedSources` / `adoptedUrls` / `officialAdopted` 仍只统计真正被引用的（`citedOnly`），采用率不会被虚高。
- **比价表完整性**：`checkCompareRows(brief, { options, stats })` 解析「## 方案对比」第一张表，按候选逐个确认是否**独立成行**。被并格（如 `qwen / 豆包 API`）的候选在表后补「> 注意：<候选> 未作为独立行出现（价格未取得），下表结论不含该候选。」；独立成行但价格列是 `未核实 / 未知 / —` 的补「（无来源）」。结果写 `stats.compareRowsComplete`。合成提示词同时加硬规则：每个候选必须独立一行，禁止用 `/`、`、`、`与`、`和` 合并候选。

## 零证据文案与价目页直取（0.9.7）

0.9.6 的真实 standard 价格题暴露了两处不一致：表里已经给豆包留了独立行（价格 `无证据`），「## 未解决」却仍写「未纳入对比」；定向回补抓到的两条 volcengine 页是文章页与模型页，已知价目页从未被优先抓。

- **文案在表格之后定稿**：`checkCompareRows()` 的 sink 增 `owned`（真正独立成行的候选）与 `priceTable`（表体含 `元|￥|$|百万|1M|tokens|price` 等即认，不只认列名——`输入价` 不匹配 `PRICE_COLUMN`）。`buildResult()` 在表格生成后调 `zeroEvidenceGapText(option, { hasRow, priceTable })`：有行且是价目表 → 「选项「X」在对比表中占位，但价格未取得（零证据）」；有行但不是价目表 → 「…但未取得可用证据（零证据）」；没有行 → 仍是「在本轮证据中没有可用来源（零证据），未纳入对比」。pipeline 阶段先写入的 gap 由 `realignZeroEvidenceGapText()` 就地重写，保留「（已定向检索 1 次仍未获证）」这类后缀，简报与 `gaps` 两个出口同步。
- **价目页按 URL 直取**：`PRICING_SEEDS` 是 `{ pattern, url }` 映射（豆包/火山方舟 → `volcengine.com/docs/82379/1099320`、qwen/通义 → `help.aliyun.com/zh/model-studio/models`、deepseek → `api-docs.deepseek.com/quick_start/pricing`、kimi → `platform.moonshot.cn`、glm → `open.bigmodel.cn/pricing`），`pricingSeedFor()` 按选项取 URL。`targetedOptionRefill()` 在 pricing 场景先 `config.__fetchPage` 直取，正文命中 `hasPricingSeedText()`（`元|￥|$|/百万|1M|1000 tokens`）才作为证据页排到最前并视为该选项已解决；否则退回 `site:` 搜索。每个选项最多 1 次直取 + 1 次搜索。
- **去重与预算**：`state.pages` / `state.refillPages` 已有的 URL 先入 `fetched` 集合，直取与搜索命中都跳过、不重复计页；本轮已经在 `sourceFailures` / `officialFetchFailures` 里失败过的 seed 不再重抓（`unreachable` 集合），避免同一轮为同一个 404 反复花预算。注意 `lib/strategies.js` 里的同名 `PRICING_SEEDS` 是给 direct 通道的 URL 列表，与这里的「选项 → 价目页」映射不是一回事。

## 类别映射与清理边界（0.9.10）

0.9.6 的「比价表完整性」默认每张对比表都有价格轴，于是判断题（C 题「微服务该不该拆」）也拿到一列「价格」，每行都写「未核实」——一个填不出来、却读起来像结论的列。0.9.9 起列由问题类别决定；0.9.10 补上两条漏网：**没被分类出来的判断题**（`classify()` 对 C 题 8 个类别全 0 分、回落 `concept`，`source: 'fallback'`）照样要拿到中性偏成本列，**`（无来源）`** 只许留在纯数量格。

- **三套列**：`lib/prompts.js` 的 `COMPARE_COLUMNS` / `compareColumnKind()` / `compareColumnsFor()` 是唯一来源——`pricing` → `方案 / 输入价 / 输出价 / 币种/口径 / 适用场景`；`tech-selection` / `architecture` / `decision` / `evaluate` → `方案 / 优势 / 风险 / 适用场景 / 成本概览`（0.9.10 起 `evaluate` 也在这里：评估题同样是判断题，没有价格轴）；其余（`learning` / `concept` / 类别未知）→ `选项 / 优势 / 风险 / 适用条件`。`synthPrompt({ questionKind })` 用这套列表写提示词，同时按类别给出缺值写法（pricing 才允许「未核实（无来源）」；成本概览允许「未核实」，但不许编价格、不许另加价格列）与「候选多时保留哪两列」。类别由调用方传入，缺省走中性列。
- **措辞升级（`effectiveCompareColumnKind(questionKind, question)`）**：先按 `compareColumnKind()` 取桶，只有当桶是中性、且问题带决策措辞（`该不该` / `要不要` / `值不值得` / `是否该` / `应不应该` / `是否值得` / `需不需要` / `该拆`）时才升级到 cost 列。作用是给「分类器没认出来、但用户在二选一」的问题一个不出现价格列的台阶；`pricing` 和已分类的类别永不被覆盖，`stats.questionKind` 也仍是分类器的原值——**这是表列决策，不是重新分类**。它只影响提示词里的表头/缺值/拥挤规则，交付层的清理仍按 `stats.questionKind` 走。真正的 `decision` 类别（要动 `QUESTION_KINDS`、sourcePlan、默认章节、golden）留到 1.0.0。
- **列不是硬编码的**：「N 个候选就是 N 行、每个候选独立一行、禁止并格」与类别无关，三种表头都保留；「价格」列在非 pricing 题里是错误，而不是缺省。
- **交付前的清理**：`lib/brief.js` 的 `sanitizeCompareTable(brief, { questionKind })` 在 `buildResult()` 里 `applyZeroEvidenceOptions()` 之后、`checkCompareRows()` 之前跑（类别缺省读 `stats.questionKind`）。它只处理「## 方案对比」的第一张表：数据行标签列剥掉 `（无来源）`/`(无来源)`/`（零证据）`/`（推断）`；其余每一列都先剥 `（无来源）`，**只有剥完剩下纯数字 + 单位时才保留原样**（`0.2 元/百万 tokens`、`8 人`、`99.9%`、`20–40 ms`、`3 天`；数字溯源是 `markUnsourcedNumbers()` 的契约）。文字格即便含数字（`部署 1 个包（无来源）`、`v22.11.0（无来源）`）也剥——0.9.9 的判据是 `/\d/`，只要格子里出现过数字就保留标记，这一类漏了；表头带「价格」（`价格|单价|报价|输入价|输出价|价目|pricing|price`，刻意不匹配裸「价」以免误伤「性价比」「评价」）且类别已知且不是 `pricing` 时，表头改成「成本概览」，把没有 `[S#]` 的纯数字价格格改成 `见注`（带引用的价格是证据、不是噪音，原样保留）——**行不删**，类别未知时保持原样。幂等：跑第二遍不再变化。
- **清理层与标注层的接缝**：`成本概览` 是允许写「未核实」的中性列，因此 `checkCompareRows()` 的价格列识别改走 `isPriceColumnHeader(cell)`——表头含「成本概览」时**不**当价格列，`价格`/`单价`/`费用`/`成本`（不带「概览」）/`报价` 仍然是。否则 sanitize 刚把 `未核实（无来源）` 清成 `未核实`，这一层又会按 `/成本/` 把标记加回去（0.9.9 交付里的 A 题泄漏就是这样产生的）。pricing 题的裸 `未核实` 仍按 0.9.6 契约标成 `未核实（无来源）`。
- **`（无来源）` 不再从数字入口漏进标签列**：`markUnsourcedNumbers()` 只标注第 1 列之后的单元格。标签列是候选名，「先拆 2-3 个服务」里的 `2-3` 属于名字，不是待核算的数字；模型自己写进标签列的标记由 `sanitizeCompareTable()` 剥掉。
- **调试可见性**：`debugStats` 的「调试统计」行带 `· 类型 <questionKind>`（缺省 `concept`），表头不对时先看这一项，不必手工重跑 `classify()`。
- **识别边界**：`见注` 只替换「纯数字 + 单位」且没有引用的价格格（`0.2 元/百万 tokens`、`¥0.5`、`0.0008 元/千 tokens`）。区间价（`0.2-0.3 元`）、带后缀的口径（`0.2 元/秒`、`0.2 元/次`）、整段说明（`见官网，按量计费`）都不认作纯数字，原样保留；表头若叫「费用」「单价」也会被认成价格列，但「性价比」「评价」不会；表头写「价格」而表体语义上不是价格（例如「价格弹性」）会被误改；转置表（候选做列、维度做行）不处理，因为它的第一列是维度名而不是候选名；只处理「## 方案对比」下的第一张表。措辞升级同理是启发式：`该不该` 出现在与选型无关的句子里（「该不该给实习生开权限」）也会拿到 cost 列——那是可接受的偏差，宁可多一列「成本概览」，也不要给判断题塞价格列。

## 冲突三分

简报的「## 存在冲突」分三类，某一类为空时写 `- 无`，三类都空则整段不出现：

- **事实冲突**：同一实体同一属性出现两个不同值，或同一断言出现支持/反驳两方。
- **口径差异**：不同实体或不同单位（元 / 美元、上下文窗口 vs 输出上限）的数字，写清为什么不可直接比较，最多 2 条。
- **来源自相矛盾**：同一 URL 的证据里同属性出现两个不同值；同一页面列出三个及以上取值视为表格/变更记录，不报矛盾。

价格题强制标币种：不同币种不得直接比较大小、不得合并排序或得出「更便宜」，汇率没在证据里出现就不自行折算。

## 简报结构

```text
> 检索流程：识别 20 篇 · 去重后 12 篇 · 可读 9 篇 · 采用 3 篇 · 官方采用 1/3 · 查询 中文语义 4 / 英文技术 3 / 官方定向 2

## 结论（****一句话：…**** + 2–4 句依据）
## 依据 / ## 方案对比 / ## 步骤
## 行动清单（3–5 条，动词开头）
## 坑与风险
## 存在冲突（三类）
## 本题未解决
## 参考（每条标档位与域名）
> 本次检索：6 个查询 · 9 个页面 · 14 条证据 · 73 秒（标准档） · 阶段 拆题1s/检索12s/精读30s/合成25s
```

- 「识别 / 去重后 / 可读 / 采用」四个数字全部来自本轮真实计数，不做估算；续跑时只记本轮新抓，行尾补 `（续跑：复用 N 页）`。
- 必出章节按 `questionKind` / `mode` 声明，缺段降一档置信度；`ensureSections()` 补占位，`requiredSectionsFor()` 合并策略包声明。
- 行动清单固定在「方案对比 / 步骤」之后、「坑与风险」之前；compare 类至少 1 条写「怎么小范围验证或试点」。
- 定量对比表的数字列每行带 `[S#]`，缺失时 `markUnsourcedNumbers()` 追加「（无来源）」而不是删数字（幂等）。
- 对比题的选项名先剥离冒号引导语再切分（`compareOptions()`），零证据的表行/缺口只给核心名 ≥2 字且命中 0 次的选项（`countOptionHits()` 按核心 token 匹配，拉丁词边界且允许版本后缀、中文 ≥2 字子串）；清洗失败的片段直接丢弃，不产生假 gap（0.9.1）。

## 缓存与续跑

- 缓存 key：`question` + `depth` + `focus` + `outputLanguage` + `text`；`focus` 或 `text` 不同即视为不同问题。
- `partial: true` 的结果不入缓存；时效性问题（最新 / 当前 / 价格 / EOL / latest / price…）跳过缓存读写。
- 命中缓存时 `stats.cached = true`、`cachedAgeMinutes = N`、`elapsedMs = 0`，简报首行标注「本结果来自 N 分钟前的缓存，可能已过时」。
- `persistPath` 非空才落盘：启动读回快照、丢弃过期条目、按 `maxEntries` 截断，坏 JSON 只记日志并按空缓存继续；写入走临时文件 + `rename`，`persistDebounceMs` 防抖。
- `researchId` 续跑复用已读页面与证据，30 分钟内有效，过期或不存在静默回退为全新研究。

## 已知限制

- `sitemapindex` 只跟一层，嵌套更深的站点会少抓。
- `api` 通道仅声明不执行；`renderFallback` 未接线。
- 不读 `robots.txt`，只做 `crawl-delay` 之外的请求间隔控制。
- 同一项目内部 sitemap 仍是「第一个成功即停」，问题同时命中多个项目时按 tag 得分取优。