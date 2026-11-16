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
  ├─ 抓取分层：raw → web.fetch → Jina；EUR-Lex 走 Cellar XHTML；价目页失败走渲染兜底（r.jina.ai）；SO/HN 用 API 正文兜底
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
| `lib/fetch.js` | 正文抓取分层（raw / web / jina / cellar）、GitHub blob → raw 改写、正文抽取与字数门槛、pricing 渲染兜底（`createRenderFetcher`） |
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
- 每个取回结果带 `via`（`raw` / `web` / `jina` / `cellar`，sitemap 页面由管线覆盖为 `sitemap`，价目页渲染兜底为 `render`），供 `gradeSource(url, via)` 决定是否降档。

## 证据分级与排序

- 证据档位 `sourceTier`：`doc-page` > `repo-doc` > `repo-code`，另有 `official` / `paper` / `forum` / `blog` / `other` 分类用于参考标注。
- 同一页面的多语言版本、镜像（`cdn.jsdelivr.net`、`url.nodejs.cn`）、同一仓库不同 commit/分支、`.md` 与 HTML 两种格式，都按内容归一为一条来源。
- 单一来源的论断标「待验证」，来源冲突标「有争议」；不同仓库视为独立来源（不会因为同为 `github.com` 就被判成单一来源）。
- 过期页面 `looksStale`（已过期 / 不再维护 / 已归档 / deprecated / archived / end of life）在 Step 5 打 `stale` 标记，不参与置信度计算，证据抽取默认跳过。
- 一手来源门槛：standard/deep 档若全部证据都来自二手解读（没有可信域名/官方来源），置信度强制降为 `low`，并在「未解决」写明缺口。
- 置信度分两个口径（0.9.1）：**广度**用 `evidenceSiteKey()`——文档主机（`docs.*` / `help.*`，或 `sourceTier === 'doc-page'`）按 `host/首段路径` 计，github 按仓库计，其余按 host 计，所以 8 条官方文档覆盖 ≥2 个手册段即可从 `low` 升到 `medium`；**跨源确认** `confirmed` 仍用粗粒度的 `siteKey()`，同一厂商的不同文档段不会被当成互相独立确认。
- 页面兜底：模型只引用了部分页面时，没被引用的页面各补一条启发式证据（官方/通道页段落门槛 60 字符，其余 120 字符），避免「读到了却没采用」。
- 证据抽取并行：按 2 页一批（`EVIDENCE_CONCURRENCY = 2`）同时抽，单批失败（典型是双批并发下的 provider 429）记日志后回落逐页启发式；结果按批序合并，`[S#]` 编号与「参考」顺序与串行完全一致（0.9.5）。

## 置信度对齐（1.1.2）

1.1.1 的实跑里，a-rag（官方占比 90%、采用 8 条）与 b-price（官方占比 100%、采用 8 条）都报 `low`，而 `scripts/eval.mjs` 的 `expectedConfidence()` 判 `high`；用户看到的简报也比证据弱。归因结果是三处结构问题叠加，不是阈值偏紧——所以 1.1.2 **没有改任何阈值**，`expectedConfidence()` 的判定式（`high` = 占比 ≥50% 且采用 ≥5；`low` = 占比 <40% 或采用 <2；其余 `medium`）逐字保留。

- **一个「官方」定义**：`lib/util.js` 的 `isPrimarySource(url)` = `isOfficialDomain(url) || sourceTier(url) ∈ {doc-page, doc-index, repo-doc}`，与评测的官方口径同源。1.1.1 之前管线只看 `isOfficialDomain()` 白名单，`kubernetes.io/docs`、`haystack.deepset.ai/docs`、`dev.mysql.com/doc`、`pnpm.io/docs` 这类「厂商文档但域名不在白名单」的页面在评测里算官方、在管线里不算，于是 `hasPrimaryClusters()` 判成无一手来源、`primaryMissingCap: 'low'` 把结论压到 `low`，`stats.officialAdopted` 也少算。现在 `isOfficialPage()`、`hasPrimaryClusters()`、decision 闸门与 `computeConfidence()` 都用这一个定义；`.gov` / `.edu` / TRUSTED 域名仍按「高质量来源」计，一手门槛不变（manual/standard/deep 全部二手 → `low` 并写「未解决」缺口）。
- **基准来自交付的证据，而不是 cluster 的确认状态**：`computeConfidence(clusters, gates)` 新增可选 `gates.evidence = { adopted, official }`，由 `evidenceConfidence(official, adopted)` 按上表给出基准。原因是真实运行里同一厂商的文档页只对应一个域名，`confirmed`（≥2 个独立域名确认）几乎总是够不上，广度最多把结果抬到 `medium`——而「采用了几条、其中几条是一手」根本没进入函数。没有快照的调用方（单元测试、插件 API）仍走 0.9.1 起的原矩阵，行为逐字不变。
- **闸门在基准之后，顺序不变**：`disputed` → decision 闸门 → `zeroEvidence` → `missingPrimary` → `missingSections` → 包级 `gate`。每条闸门都只能把证据档降下来、绝不能被证据档抬过去：有未解决冲突封顶 `medium`（无已确认论断则 `low`）、比较/比价有零证据选项封顶 `medium`、缺一手来源按 `primaryMissingCap`、缺必需段落降一档、包级上限取最严值。
- **包级上限收缩**：`tech-selection` 与 `pricing` 1.1.1 时无条件 `gate: 'medium'`，high 永远不可达（a-rag / b-price 正是这两类），这一版移除；比较表/价目完整性的关切由 `zeroEvidence` 闸门、缺段降档与 `checkCompareRows()` 度量。`fresh-data` 的时效上限、decision 包的上限保留。
- **判据偏软只对 decision 降档，且封顶 `medium`**：`validateCriteria()` 现在接受 `questionKind`，「## 判据」本就是 decision 题的必需段落，因此 soft（>50% 行缺可量化阈值）只在 decision 生效；生效时是「封顶 medium」（high → medium），不是继续下调——「- 判据偏软：N/M 条缺少可量化阈值…」照写，但一条散文判据不会把有 8 条官方来源的结论压成 `low`。不传 `questionKind` 的直接调用保持 1.1.0 行为。
- **简报与对象对齐**：`ensureSections()` 只在「## 置信度」缺段时写入，1.1.1 因此出现过简报写 `medium`、`result.confidence` 是 `low` 的分裂；`buildResult()` 现在用 `alignConfidenceSection()` 把该段重写成最终档位，两者永远同值。

判定表（构造用例，同一批 clusters 分别走 1.1.1 矩阵与 1.1.2 证据口径）：

| 构造用例 | 1.1.1 | 1.1.2 |
| --- | --- | --- |
| 全官方 8 条（采用 8 / 官方 8） | low | **high** |
| 全二手 8 条（采用 8 / 官方 0） | medium | **low** |
| 官方 3 条 + 二手 5 条（37.5%） | medium | **low** |
| 全官方 8 条 + 1 条未解决冲突 | medium | medium（冲突封顶） |
| 全官方 8 条 + 1 个零证据选项 | low | medium（选项缺口封顶） |

`--offline` 总分 82.1 → 88.1，10 题置信度全部与 `expectedConfidence()` 一致、0 条置信度备注；`--real --only a-rag,b-price` 总分 97.0（a-rag 94.0、b-price 100.0，均 `high`）、0 条备注。因为两侧共用同一个官方口径与同一组阈值，评测判据与产品判定是「按构造一致」，而不是各自调参后碰巧相同。

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

## pricing 渲染兜底（1.1.0）

豆包、千问、DeepSeek 等厂商的官方价目页是 JS 壳：常规抓取（raw / web）只能拿到页头和导航，正文不足 400 字，于是价目题最该读的一页恰好读不到。1.1.0 给 pricing 通道加了一层**独立的渲染兜底**，而不是把渲染变成全局抓取路径——渲染走第三方 reader（`https://r.jina.ai/<原始URL>`，`accept: text/plain`，20s 超时），慢、贵，且内容经过二次转写，只适合「没有它就拿不到价格」的那一个页面。

- **门控（全部满足才渲染）**：只给 `pricing` 通道的 seed 页与价目页定向回补；`depth` 必须是 `standard` / `deep`（quick 的页预算与墙钟容不下 20s 渲染）；`config.renderFallback !== false`；URL host 命中渲染白名单；`config.__fetchRaw` 存在。常规抓取先跑，只有失败或正文 < `MIN_USEFUL`（400 字）才进入兜底。
- **白名单**：`DEFAULT_RENDER_HOSTS` = `volcengine.com`、`help.aliyun.com`、`api-docs.deepseek.com`、`platform.moonshot.cn`、`open.bigmodel.cn`、`bigmodel.cn`，按**主机后缀**匹配（`help.aliyun.com` 命中自身与子域，不命中 `nothelp.aliyun.com`），可用 `config.renderHosts` 覆盖。白名单只描述「已知是 JS 壳的价目页」，不是信任名单。
- **独立预算 `RENDER_BUDGET = 2`**：一次运行最多 2 次渲染，与页预算互不占用——渲染的是同一个页面，不该再花一个页槽。预算在**请求发出前**扣（`state.renderUsed += 1`）：超时和 500 同样耗掉了这次请求，若只在成功时扣，一串坏渲染会让一次运行无限变慢。用尽后其余 seed 走常规路径，失败照旧进 `sourceFailures` / 官方价目页缺口。
- **失败不抛**：`createRenderFetcher` 返回原抓取失败并附 `renderReason`（HTTP 码、字数不足、主机不在白名单、未配置 raw fetcher…），管线把 `renderReason` 留在失败记录上，便于解释「为什么这页仍然没读到」。
- **降档与标记**：渲染取回的页面 `via: 'render'`，`gradeSource()` 把它**降一档**（官方 → 论文 → 仓库 → 论坛 → 百科 → 网页，最低保持「网页」）：URL 仍然是厂商官网，但经过代理转写的内容不保证与原文逐字一致，价格表可能缺列或缺币种，不能再按一手来源计。参考行在该来源后标「（渲染取回）」，`via` 随证据卡一路带到 `参考`，不进入正文断言。
- **可见性**：`stats.renderUsed` 记录本次渲染次数，四数行（`检索流程`）在 > 0 时追加 ` · 渲染兜底 N`，不渲染的运行保持原样一行不变。1.1.1 起同时记 `stats.renderAdopted`（最终被采用、带 `via: 'render'` 的来源数，来自 `citedOnly(finalSources)`）：`renderUsed > 0` 而 `renderAdopted === 0` 时四数行写「· 渲染兜底 N（未采用）」——1.1.0 实跑里流程行报了「渲染兜底 1」，参考区却没有对应的「（渲染取回）」标记，因为那一次渲染取回的页面最终没被引用；计数与参考标记不一致会让人以为参考漏标。任一渲染页被采用就仍写原样（该页在参考里自带标记），`stats` 里没有 `renderAdopted`（旧调用方/旧缓存）时不加注，保持 1.1.0 输出。

## 类别映射与清理边界（0.9.10）

0.9.6 的「比价表完整性」默认每张对比表都有价格轴，于是判断题（C 题「微服务该不该拆」）也拿到一列「价格」，每行都写「未核实」——一个填不出来、却读起来像结论的列。0.9.9 起列由问题类别决定；0.9.10 补上两条漏网：**没被分类出来的判断题**（`classify()` 对 C 题 8 个类别全 0 分、回落 `concept`，`source: 'fallback'`）照样要拿到中性偏成本列，**`（无来源）`** 只许留在纯数量格。

- **三套列**：`lib/prompts.js` 的 `COMPARE_COLUMNS` / `compareColumnKind()` / `compareColumnsFor()` 是唯一来源——`pricing` → `方案 / 输入价 / 输出价 / 币种/口径 / 适用场景`；`tech-selection` / `architecture` / `decision` / `evaluate` → `方案 / 优势 / 风险 / 适用场景 / 成本概览`（0.9.10 起 `evaluate` 也在这里：评估题同样是判断题，没有价格轴）；其余（`learning` / `concept` / 类别未知）→ `选项 / 优势 / 风险 / 适用条件`。`synthPrompt({ questionKind })` 用这套列表写提示词，同时按类别给出缺值写法（pricing 才允许「未核实（无来源）」；成本概览允许「未核实」，但不许编价格、不许另加价格列）与「候选多时保留哪两列」。类别由调用方传入，缺省走中性列。
- **措辞升级（`effectiveCompareColumnKind(questionKind, question)`）**：先按 `compareColumnKind()` 取桶，只有当桶是中性、且问题带决策措辞（`该不该` / `要不要` / `值不值得` / `是否该` / `应不应该` / `是否值得` / `需不需要` / `该拆`）时才升级到 cost 列。作用是给「分类器没认出来、但用户在二选一」的问题一个不出现价格列的台阶；`pricing` 和已分类的类别永不被覆盖，`stats.questionKind` 也仍是分类器的原值——**这是表列决策，不是重新分类**。它只影响提示词里的表头/缺值/拥挤规则，交付层的清理仍按 `stats.questionKind` 走。真正的 `decision` 类别在 0.10.0 落地（`QUESTION_KINDS`、策略包、`## 判据`、golden 都在这一版里补齐，见下一节）；措辞升级保留，作为「调用方仍传 `concept`、或分类器还没学到的新说法」的兜底。
- **列不是硬编码的**：「N 个候选就是 N 行、每个候选独立一行、禁止并格」与类别无关，三种表头都保留；「价格」列在非 pricing 题里是错误，而不是缺省。
- **交付前的清理**：`lib/brief.js` 的 `sanitizeCompareTable(brief, { questionKind })` 在 `buildResult()` 里 `applyZeroEvidenceOptions()` 之后、`checkCompareRows()` 之前跑（类别缺省读 `stats.questionKind`）。它只处理「## 方案对比」的第一张表：数据行标签列剥掉 `（无来源）`/`(无来源)`/`（零证据）`/`（推断）`；其余每一列都先剥 `（无来源）`，**只有剥完剩下纯数字 + 单位时才保留原样**（`0.2 元/百万 tokens`、`8 人`、`99.9%`、`20–40 ms`、`3 天`；数字溯源是 `markUnsourcedNumbers()` 的契约）。文字格即便含数字（`部署 1 个包（无来源）`、`v22.11.0（无来源）`）也剥——0.9.9 的判据是 `/\d/`，只要格子里出现过数字就保留标记，这一类漏了；表头带「价格」（`价格|单价|报价|输入价|输出价|价目|pricing|price`，刻意不匹配裸「价」以免误伤「性价比」「评价」）且类别已知且不是 `pricing` 时，表头改成「成本概览」，把没有 `[S#]` 的纯数字价格格改成 `见注`（带引用的价格是证据、不是噪音，原样保留）——**行不删**，类别未知时保持原样。幂等：跑第二遍不再变化。
- **清理层与标注层的接缝**：`成本概览` 是允许写「未核实」的中性列，因此 `checkCompareRows()` 的价格列识别改走 `isPriceColumnHeader(cell)`——表头含「成本概览」时**不**当价格列，`价格`/`单价`/`费用`/`成本`（不带「概览」）/`报价` 仍然是。否则 sanitize 刚把 `未核实（无来源）` 清成 `未核实`，这一层又会按 `/成本/` 把标记加回去（0.9.9 交付里的 A 题泄漏就是这样产生的）。pricing 题的裸 `未核实` 仍按 0.9.6 契约标成 `未核实（无来源）`。
- **`（无来源）` 不再从数字入口漏进标签列**：`markUnsourcedNumbers()` 只标注第 1 列之后的单元格。标签列是候选名，「先拆 2-3 个服务」里的 `2-3` 属于名字，不是待核算的数字；模型自己写进标签列的标记由 `sanitizeCompareTable()` 剥掉。
- **调试可见性**：`debugStats` 的「调试统计」行带 `· 类型 <questionKind>`（缺省 `concept`），表头不对时先看这一项，不必手工重跑 `classify()`。
- **识别边界**：`见注` 只替换「纯数字 + 单位」且没有引用的价格格（`0.2 元/百万 tokens`、`¥0.5`、`0.0008 元/千 tokens`）。区间价（`0.2-0.3 元`）、带后缀的口径（`0.2 元/秒`、`0.2 元/次`）、整段说明（`见官网，按量计费`）都不认作纯数字，原样保留；表头若叫「费用」「单价」也会被认成价格列，但「性价比」「评价」不会；表头写「价格」而表体语义上不是价格（例如「价格弹性」）会被误改；转置表（候选做列、维度做行）不处理，因为它的第一列是维度名而不是候选名；只处理「## 方案对比」下的第一张表。措辞升级同理是启发式：`该不该` 出现在与选型无关的句子里（「该不该给实习生开权限」）也会拿到 cost 列——那是可接受的偏差，宁可多一列「成本概览」，也不要给判断题塞价格列。

## 候选解析与空格回填（1.0.1）

1.0.0 的实跑暴露了对比题的两个接缝：问题「Java 后端做 RAG 应用，Spring AI 和 LangChain4j 怎么选」拿到 7 条官方文档，表里 3 行 × 4 列却全是「无证据」，而且第三行候选是问句背景句「Java 后端做 RAG 应用」。1.0.1 在两侧各改一处，`package.json` 与预算模型不动。

- **候选解析（`compareOptions()`，`lib/pipeline.js`）**：切分顺序改成「先比较连接词、再列表标点」——`COMPARE_CONNECTIVE`（`以及|还是|vs|对比|比较|和|与|及`）先把句子切成左右两侧，每侧再走原有的 `OPTION_SPLIT`（`|`、`/`、`、`、`，`、`,`、`vs`、`还是`）与 `cleanOptionToken()`。切出来的片段超过 24 字，或含「应用 / 场景 / 项目 / 架构 / 后端 / 系统 / 功能」这类背景词，说明这不是一份干净的候选清单，改走回退：只取「真正在比较的那个分句」（按 `，,；;。` 切句、保留含连接词的分句）里的大写开头拉丁名 + `KNOWN_OPTION_NAMES` 技术词典（最长匹配优先，`Spring AI Alibaba` 不再同时算 `Spring AI`），并丢掉 `RAG / API / LLM / SDK` 这类裸缩写与后接背景词的名字（`Java 后端`）。候选上限 5 → 3；最终不足 2 个返回 `[]`（单候选不是对比）。`OPTION_CUT` / `OPTION_TAILS` / `OPTION_NOISE` / `cleanOptionToken()` 的既有清洗规则不变，问句背景句不再产生候选，也不会再出现「Spring AI 和 LangChain4j」这种粘连名字。
- **括号内联清单优先（1.1.1）**：1.1.0 实跑题「国内四家大模型 API（DeepSeek、通义千问、豆包、Kimi）的价格怎么比，我们做一个小型 RAG 产品该选哪家」返回的是 `国内四家大模型 API（DeepSeek` / `通义千问` / `豆包`——`OPTION_SPLIT` 把括号前的背景句连同左括号一起切成了第一片，3 个上限又先于 Kimi 用完。1.1.1 在每个 source 上先扫 `INLINE_OPTION_BRACKET` 里的每组括号（全角 `（）` 与半角 `()` 两种括号、括号内 2–160 字，不嵌套）：按 `INLINE_OPTION_SEPARATOR`（`、，,／|；;`）切开、逐个 `cleanOptionToken()`、丢掉 `OPTION_GUIDE` / `BACKGROUND_OPTION_WORD` / 谓词片段，去重后某组仍有 ≥2 个名字就**直接把它当候选清单**（上限 `MAX_BRACKET_OPTIONS = 6`），并且不再对这条 source 做标点切分——括号是用户自己列的枚举，句读切分只会把清单外的背景句捡回来。含「该怎么 / 该选 / 选哪 / 哪家 / 怎么比 / 怎么选 / 如何选 / 哪个」的片段只在「以名字开头」时保留（`startsWithOptionName()`：以拉丁字母开头，或以 `KNOWN_OPTION_NAMES` 里的中文名开头），所以 `豆包、Kimi 哪家便宜` 仍出两个候选，而 `我们做一个小型 RAG 产品该选哪家` 不再成候选。括号里只写一个名字（`怎么选（Java）`）不算清单，退回原路径；原路径的 3 个上限不变（`Spring AI、LangChain4j、Haystack、Dify 该怎么选` 仍取前 3）。
- **表格补空（`fillEmptyCompareCells(table, clusters, options)`，`lib/brief.js`）**：模型把表退回成「无证据」时，用证据里已有的断言把格补上，而不是整表丢弃。定位「## 方案对比」第一张表，行归属按标签列与候选名匹配（去标记后按 `optionKey` 包含判定，命中恰好一个候选才算归属）；第 2 列起，剥掉 `（无来源）/（零证据）/（推断）` 后匹配 `无证据 / 未核实 / 待核实 / 待确认 / 未知 / 暂无 / n/a / tbd / — / ?` 的格，用**该候选**的证据断言（`cluster.claim`、`evidence[].claim/quote`、价格项 `title`，只取提及该候选的 cluster）按出现频次排序后填充，取前 60 字并附 `[S#]`。列语义按表头挑：风险列优先含「风险 / 限制 / 不支持 / 需要」的断言，适用列优先含「适合 / 适用于 / 场景」的，价格列优先含「元 / ￥ / 免费 / 计费 / tokens / price」，其余取首条断言；`成本概览` 不算价格列。没有匹配断言就保留「无证据」，不借别的候选的句子；函数幂等，且会把 `clusters` 里的旧 `S#` 按 URL/标题重映射到交付的 `sources`（`validateCitations()` 会重新编号），所以填出来的引用不会悬空。它在 `buildResult()` 里排在 `sanitizeCompareTable()` 之后、`markUnsourcedNumbers()` 之前。
- **附注与表行一致**：`zeroEvidenceGapText()` 的 `hasRow` 现在由 `checkCompareRows()` 的 `owned` ∪ `present` 决定——`present` 是「名字在表里任何位置出现过」（含被合并进 `qwen / 豆包 API` 这类行），所以「在对比表中占位」与表内容不再打架。有行的零证据选项一律写「选项「X」在对比表中占位，但关键属性未取得（零证据）」（旧文案写死「价格未取得」，而空格可能是优势/风险/适用条件），只有确实不在表里才写「在本轮证据中没有可用来源（零证据），未纳入对比」；表下附注同步为「未作为独立行出现（关键属性未取得），下表结论不含该候选」。`realignZeroEvidenceGapText()` 就地改写 pipeline 阶段先写入的 gap，两个出口保持同一句。
- **claim 自证（1.1.1）**：1.1.0 实跑里通义千问行被填进了「阿里云 AI 助手导入模型时，可选模型包括…」——那条 cluster 的 quote/title 确实提到通义千问（归属判定没错），但被复制的 `claim` 谈的是别的产品。1.1.1 在 `optionClaims()` 的 `add()` 里加一道**候选自证**：只有当这段文本自己（`cluster.claim` / `evidence[].claim` / `evidence[].quote` / 价格项 `title`）出现该候选的核心 token（`optionKey` 包含，中文 ≥2 字子串，或拉丁词边界正则）时，才允许它进入候选格。cluster 级 gate 保留但只作快筛——真正被搬进表格的是 claim，claim 必须自己提到该选项，否则等于借无关引文，宁可保留「无证据」。
- **表外价格句回填（1.1.1）**：同一实跑里 DeepSeek 行写「无证据」，而表格下方就有一句「DeepSeek 输入价 `$0.6–3.96` / 百万 tokens [S3]」。1.1.1 让 `fillEmptyCompareCells()` 扫表格行区间（首个表头到表格结束）**之外**的行：跳过标题（`#{1,6}`）、表格行（`|`）、引用块（`>`）与空行，要求该行命中 `PRICE_CLAIM`（货币/价格词）且自带至少一个 `[S#]`，剥掉行首列表符号与引用编号后存为补充句。填格时只对**价格列**（新增 `isPriceCellColumn()`：表头命中 `PRICE_COLUMN_HEADER_RE`，且不是风险列/适用列、不是 `成本概览`）启用：候选断言里没有价格句时，用提及该候选的补充句回填，引用取句内原有的 `[S#]`；提及该行的候选越少越优先（同一句不会勉强分给两个候选），风险/优势列永不使用补充句。补充句与 claim 都没有时仍保留「无证据」；函数保持幂等（填过的格不再为空）。

## 成本概览列语义（1.0.2）

1.0.1 的空格回填把 `成本概览` 划进「其余取首条断言」，于是 1.0.1 实跑的对比题「Java 后端做 RAG 应用，Spring AI 和 LangChain4j 怎么选」两个成本格被填成能力描述（「Advisors API 用于拦截增强」）并带 `[S#]`——读起来像成本数据，实际没有一句谈钱。1.0.2 把 `成本概览` / `成本` / `价格概览` 单列为成本列（风险列、适用列优先），只接受含成本语义的断言（`元 / ￥ / $ / 美元 / 人民币 / 免费 / 计费 / 按量 / tokens / 千次 / 每百万 / price / cost / billing / quota / 额度`）；一条都匹配不上时写「未取得（无成本数据）」，不再借该候选的首条断言。整列都是这个占位时，表下空一行补「> 成本概览仅在有价目/计费证据时填充；本轮未取得，可参考「未解决」中的缺口。」，按整行幂等。优势 / 风险 / 适用场景列与 `输入价` / `输出价` / `单价` 这类真价格列的行为都不变（真价格列仍按 `PRICE_CLAIM` 优先取价目断言，`pricing` 题的交付不变）。

## decision 类别（0.10.0）

0.9.10 的 C 题（「我们团队 8 个人，微服务该不该拆」）是全 0 分回落 `concept`，靠措辞升级拿到 cost 列——表列对了，问题类别还是错的：提示词没要求给判断，检索也没往阈值/反例上找。0.10.0 把「该不该 / 要不要 / 值不值得」做成真类别。

- **信号分两档**（`lib/strategy.js`，`SIGNAL_VERSION` 4）：强档 `DECISION_HINTS`（`该不该` / `要不要` / `值不值得` / `是否该` / `应不应该` / `需不需要` / `是否应该` / `值得吗` / `该拆` / `该上` / `该迁` / `要不要拆` / `要不要上` / `该不该用` / `值不值得用`）权重 5，命中即过 2 分接受线；辅助档 `DECISION_CONTEXT_HINTS`（`团队` / `多少人` / `规模` / `预算` / `成本` / `风险` / `权衡` / `取舍`）权重 1，只做加权、单独永远不足以命名类别（`团队规模多大` 仍是别的类别）。
- **固定优先级**（`KIND_PRIORITY`）：`legal → troubleshoot → contested → fresh-data → pricing → decision → tech-selection → learning → concept`。`decision` 排在 `pricing` 之后：带价的问题由价目页决定，`该不该买 X，多少钱` 仍是 `pricing`（价格覆盖逻辑不变）。排在 `tech-selection` 之前：`该不该用 React` 只有一个选项，是二选一判断而不是选型（选型表要求每个候选独立一行，单候选会退化成一行表的假对比）；**只有真正并列比较（`A 还是 B 哪个好`）才是 `tech-selection`**，这类问法里没有 `该不该`/`要不要`，两套词表不相交。同分时按 `KIND_PRIORITY` 的先后决定（`rankScores()`）。
- **策略包**（`lib/strategies.js`）：`queries.extraTemplates` = `{q} 何时该拆 微服务` / `{q} 团队规模 阈值` / `{q} 反例 失败` / `{q} trade-offs`（沿用 `{q}` / `{year}` 语法，定向 query 排在计划最前）；`sourcePlan.channels: []` 是显式声明——判断依据来自原则与经验，不硬绑官方文档通道，也避免把决策题拖进文档爬取；`depth.bias` 与 `concept` 同档（0），不额外加深；`mode` 缺省 `explain`。
- **提示词**（`lib/prompts.js`）：`synthPrompt({ questionKind: 'decision' })` 换成「决策型」输出结构，且优先于 `mode`（对比模式也不能把它变回对比结构）：① 「## 结论」第一行必须二选一写「该」或「不该」，允许「在 X 条件下该、在 Y 条件下不该」但必须落到一个主判断，不许用「取决于」代替判断；② 「## 判据」列可量化阈值（团队人数、发布频率、故障定位时长、回滚成本…），一条一行写成「阈值 + 为什么是这条线」，没来源的标「（推断）」；③ 反例：什么情况下判断会反过来；④ 行动清单，每条可直接执行。对比表列仍走 cost 桶。
- **判据接地**（`lib/brief.js` `groundCriteria(brief, sources)`，0.10.1）：「## 判据」的每一行 `- ` 若既不带 `[S#]`、也没自己写「（推断）/（无来源）」，交付前在行尾补「（推断）」——提示词只是提示，模型照样会写「每周发布 ≥ 3 次 → 进入拆分评估」而不标来源，这些阈值多半是二手页面转述的经验值。段不存在不动、`- 无` 占位不算判据、幂等；`[S#]` 只有出现在 `sources` 表里才算接地（否则编号会被 `validateCitations()` 删掉，成了假引用）。它在 `buildResult()` 里排在 `ensureSections()` 之后、清理层之前，下游看到的就是接地后的文本。
- **判据校验（`lib/brief.js` `validateCriteria(brief, { confidence })`，1.1.0）**：判据接地只管补来源标记，判断不了这一条到底能不能判定——「看情况」「需要评估」只要占住「## 判据」也算合格。校验器逐条 `- ` 行（`- 无` 占位跳过且不计入分母）要求命中可判定特征：数字（含 `%` / `倍` / `个月` / `人` / `s` / `ms` / `天` / `次`，中文数字带单位如「八人」「三次」「两倍」同样算），或比较/阈值词 `≥ ≤ > < 超过 高于 低于 至少 最多 不超过 以内 以上 以下 达到 少于 多于`；行内 `[S#]` 先剥掉，引用编号本身不算数量证据。不命中的行补「（推断）」（已带来源或已带标记的行不重复标）并计入软行。当软行超过一半（`weak / total > 0.5`）且置信度是 `high` / `medium` 时降一档（high→medium、medium→low），「## 置信度」写成新档位，并在「未解决」里加一条 `- 判据偏软：N/M 条缺少可量化阈值，结论按证据强度下调`——这条同时是幂等标记，第二次经过既不再降档也不重复追加。返回 `{ brief, weak, total, downgraded }`，`downgraded` 只表示本次是否真的降档；没有「## 判据」的简报逐字节返回（非 decision 题不付代价）。`buildResult()` 在 `groundCriteria()` 之后调用它，返回对象的 `confidence` 与简报里的「## 置信度」都用降档后的值。
- **决策闸门**（`computeConfidence(..., questionKind)`，0.10.1）：`decision` 题要先下判断，二手来源只能描述权衡、不能替团队决定，因此存活证据里没有 `domainTrust >= 3` 的 hostname（官方/一手）时最高只给 `medium`，且 `strong.size < 2`（独立站点广度不足）时降到 `low`；有官方/一手来源则判级与其它类别完全一致（`high` 仍需 `primary.size >= 2`）。闸门排在基础判级之后、`missingPrimary`/`missingSections`/`gate` 之前，只会往下压，不会抬高；其它类别行为不变。判定表（decision，无一手来源）：广度高（`strong.size >= 2`）→ `medium`；广度高且基础判级是 `low` → `low`；广度不足（`strong.size < 2`）→ `low`；无一手来源时不可能 `high`。
- **必出章节**（`lib/brief.js`）：`requiredSectionsFor({ questionKind: 'decision' })` = `## 行动清单` + `## 判据`（`DECISION_CRITERIA_HEADING`，缺省占位 `- 无`）。声明在答案层而不是策略包里，避免同一段落有两个 owner；模型漏写时 `missingSections()` 先看到它，pipeline 传 `missingSections: true` 给 `computeConfidence()` → 降一档，`ensureSections()` 再在「## 置信度」前补 `## 判据` + `- 无`。`## 判据` 不在 `ALWAYS_SECTIONS` 里，所以只有 decision 题会追它。

## 冲突三分

简报的「## 存在冲突」分三类，**哪类有真实条目就只写哪类**，三类都空则整段不出现（1.1.1 起不再给空类写 `- 无` 占位）：

- **事实冲突**：同一实体同一属性出现两个不同值，或同一断言出现支持/反驳两方。
- **口径差异**：不同实体或不同单位（元 / 美元、上下文窗口 vs 输出上限）的数字，写清为什么不可直接比较，最多 2 条。
- **来源自相矛盾**：同一 URL 的证据里同属性出现两个不同值；同一页面列出三个及以上取值视为表格/变更记录，不报矛盾。

价格题强制标币种：不同币种不得直接比较大小、不得合并排序或得出「更便宜」，汇率没在证据里出现就不自行折算。

1.1.1 的实跑暴露了占位与条目并存：同一段「## 存在冲突」里既有 `- 无`，下面又列着两条「来源自相矛盾」。`conflictSectionText()` 原先把三类**都**写出来、空类补 `- 无`，于是「事实冲突 - 无」与「来源自相矛盾 两条」同时出现，读起来像自相矛盾。1.1.1 改成只拼非空类；`unitMismatch`（同一口径换算失败）仍单独触发本节，其口径类行意外为空时保留一条 `- 无` 作防御。另外模型自己写的 `## 存在冲突` 若正文只有 `###` 标题和 `- 无`/`无` 占位（`conflictBodyIsPlaceholder()`），`appendConflictSection()` / `ensureSections()` 会用确定性发现（三类结果，含 `findSelfContradictions()`）原地替换整段——1.1.0 里已有的标题会让这两处整段跳过，模型写的 `- 无` 就把真实发现压掉了。替换后正文有真实条目，二次经过不再命中（幂等）。

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
- 必出章节按 `questionKind` / `mode` 声明，缺段降一档置信度；`ensureSections()` 补占位，`requiredSectionsFor()` 合并策略包声明。`decision` 题额外欠一段「## 判据」（可量化阈值清单，缺省 `- 无`），「decision 类别（0.10.0）」一节里的「决策型」提示词就是为它写的。
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
- `api` 通道仅声明不执行；`renderFallback` 只接线到 pricing 通道（`DEFAULT_RENDER_HOSTS` 内的价目页、standard/deep 档、`RENDER_BUDGET = 2`），其他通道没有渲染兜底。
- 不读 `robots.txt`，只做 `crawl-delay` 之外的请求间隔控制。
- 同一项目内部 sitemap 仍是「第一个成功即停」，问题同时命中多个项目时按 tag 得分取优。