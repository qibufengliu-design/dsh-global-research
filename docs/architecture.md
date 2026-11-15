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