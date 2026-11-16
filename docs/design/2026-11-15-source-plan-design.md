# 0.6.0 sourcePlan 设计：按问题类别取源

- 日期：2026-11-15
- 插件：`<workspace>/dsh-global-research`（0.5.3 → 0.6.0）
- 目标：把"取哪些源"从管线里的隐式硬编码，变成策略里可声明、可测试、可逐类演进的数据模型；本期先落 **数据模型 + sitemap 执行 + via 标记 + 用户提供资料**，不改变默认路径的抓取集合。

## 1. 为什么现在做

0.5.x 的取源分散在三处：

- Step 2b：用户 URL + planner `directUrls` + `strategy.sources.officialSeeds`；
- Step 3b：按问题自动选择的垂直源（GitHub / arXiv / Stack Exchange / npm / HN / PyPI / MDN docs）；
- Step 5b：从官方页链接里再挖一层（EUR-Lex / ENISA）。

问题不是能力不够，而是**能力不可声明**：新增一个"这类问题该看哪个站"的判断，只能改管线分支，
既难复用现有 7 类 `questionKind`，也无法逐类做预算和降级。0.6.0 的做法是：

1. 策略 pack 声明 `sourcePlan`（纯数据）；
2. 管线只执行其中一个 method（`sitemap`），其余先声明不接线；
3. 取回结果统一 `via`，让证据分级知道"这条是 Jina 文本/渲染兜底来的，别按原站等级算"。

## 2. 分层

```
strategies.js   每个 questionKind 的 pack 可覆盖 sourcePlan
      │           （channels[] + renderFallback）
      ▼
strategy.js     deepMerge(STRATEGY_DEFAULTS, pack) + deepFreeze
      │          默认 pack 无通道 → 行为等价 0.5.x
      ▼
pipeline.js     Step 2a 只执行 method:'sitemap' 的通道
      │          host 先按问题主题匹配，避免爬无关的声明站
      ▼
sources.js      crawlSitemap：sitemap.xml → sitemap_index.xml
      │          parseSitemap / pickSitemapUrls 可单独测试
      ▼
fetch.js        __fetchPage 取正文；结果带 via（sitemap 由管线覆盖）
      ▼
brief.js        gradeSource(url, via)：jina/render 降一档
```

设计原则：

- **默认等价**：`STRATEGY_DEFAULTS.sourcePlan.channels = []`、`renderFallback = { allowed: false, maxCalls: 0 }`。
  `concept` pack 为空对象，解析结果仍与默认策略逐字一致（`test/strategy.test.js` 的 deepEqual 保护）。
  因而 0.5.x 的 237 例测试不需要改断言。
- **声明与执行分离**：`direct` / `api` 通道本期只是数据，Step 2b/3b 的既有逻辑不动；避免"声明了却没实现"被误当成已生效。
- **失败是数据**：sitemap 是优化项，任何失败只写 `state.sourceFailures`，不抛、不改 `partial`。

## 3. 通道表（0.6.0 声明值）

| id | questionKind | method | hosts | maxPages | renderFallback |
| --- | --- | --- | --- | --- | --- |
| `official-docs` | tech-selection, learning | `sitemap` | docs.spring.io, spring.io, langchain4j.dev, nodejs.org, docs.python.org, developer.mozilla.org | 3 | `{ allowed: true, maxCalls: 1 }` |
| `pricing` | fresh-data | `direct` | api-docs.deepseek.com, help.aliyun.com, bigmodel.cn, www.volcengine.com | 2 | `{ allowed: false, maxCalls: 0 }`（继承默认） |
| `standards` | legal | `direct` | prisma-statement.org, cochrane.org, eric.ed.gov, owasp.org, eur-lex.europa.eu | 2 | 同上 |
| `papers` | contested | `api` | arxiv.org, openalex.org, pmc.ncbi.nlm.nih.gov | 2 | 同上 |

未列出的 kind（troubleshoot / concept）继承空通道。

### 3.1 host 选择

`pickSitemapHost(hosts, text)`：

- 把 host 拆成标签（`docs.spring.io` → `docs` / `spring` / `io`），去掉通用标签（`www`、`docs`、`io`、`com` 等）；
- 用问题 + focus + 子问题计算 token 集合，命中的标签计分；
- 分数相同时保留 pack 里的原始顺序（稳定、可预测）；
- 没有任何命中 → 不爬，记 `{ reason: 'no declared host matched the question' }`。

例：问 "Spring Boot 3 配置迁移" → `docs.spring.io`；问 "Node 22 LTS" → `nodejs.org`。

### 3.2 关键词

`sitemapKeywords(question, focus, subQuestions)`：latin token（长度 ≥3）+ CJK 短片段（≤12 字），最多 10 个。
`pickSitemapUrls` 对 URL 路径分词（按 `/` 切），整段命中 +2、路径包含 +1；按分数降序、层级浅优先、长度短优先、URL 字典序稳定排序；去重后取 `limit`（默认 3）。

## 4. 预算

页预算是硬约束（`Budget.take` 超限会抛）：

- Step 2a 先看 `budget.remaining('pages')`，`wanted = min(channel.maxPages, remaining)`；`crawlSitemap` 的 `limit` 与后续 `slice` 都用 `wanted`。
- **成功取回一页才扣一格**（`budget.take('pages')`），失败页不占预算。
- Step 2b 直取前增加 `budget.remaining('pages') - directPages.length <= 0` 的守卫，避免 sitemap 已花完预算后 Step 4 的统一扣费抛 `BudgetExceeded`。
- Step 4 的搜索页位扣除 `usedPrimaryPages = directPages + sitemapPages`，并额外用 `roomForSearch = max(0, pageBudget - usedPrimaryPages)` 夹住 `selected`；
  `wantedSearch` 保留 `max(1, …)` 的旧语义，保证既有"至少选一页"的测试不回归。

其它约束：

- 单站最多 2 次 sitemap HTTP（`/sitemap.xml`、`/sitemap_index.xml`）；`sitemapindex` 跟一层子 map 也计入，因此子 map 只跟一个。
- 两次请求之间至少 400ms（测试里以 ≥300ms 的宽松下限断言）。
- Step 2a 不使用 `__fetchPage` 之外的新依赖；正文仍走既有抓取器（raw/web/jina/cellar）。

## 5. 渲染兜底门槛

`renderFallback: { allowed, maxCalls }` 是**声明式门槛**，不是"打开就渲染"：

- 默认 `false / 0`；只有文档站通道 `official-docs` 为 `true / 1`。
- 语义：该通道允许在正文抓不到时用渲染兜底补 1 次，且只补 1 次。
- 0.6.0 **没有接线**渲染器：`allowed` 目前只作为数据被解析/冻结，可被后续版本读取。
  这样做是为了先把预算与降档规则定清楚，避免渲染兜底成为新的慢路径。
- `via === 'render'` 已在 `gradeSource` 里按降一档处理，后续接线时无需再改证据分级。

## 6. via 标记与证据降档

`lib/fetch.js` 的返回值统一带 `via`：

| 路径 | via |
| --- | --- |
| 原生 HTTP / `fetchRaw` | `raw` |
| `ctx.web.fetch` 主路径 | `web` |
| web 失败后的兜底 | `web` |
| Jina Reader 成功 | `jina` |
| Cellar 官方全文 | `cellar` |
| sitemap 抓回（管线覆盖） | `sitemap` |
| 用户提供正文（管线构造） | `user` |

`gradeSource(url, via)` 保持单参兼容；`via === 'jina'` 或 `'render'` 时，`官方` / `论文` 各降一档：

```
官方 → 论文 → 仓库 → 论坛 → 百科 → 网页
```

只降这两档，`仓库/论坛/百科/网页` 不变：Jina 只是抽取通道，不该把 GitHub 仓库降成"网页"。

## 7. 用户提供资料

- 工具参数 `text`（string，≤20000 字，可选）。
- 非空时构造一页：`{ url: 'user-provided', title: '用户提供的资料', text, engine: 'user', provided: true, ok: true, via: 'user' }`，
  在 Step 5 放到 `state.pages` 首位。
- `buildQueries` 照常运行（资料是补充证据，不替代检索）。
- 该页不占页预算、不计入 `pagesFetched` / `newPagesFetched` / `hosts`；`onState` 不把它推给卡片。
- `cacheKey` 纳入 `text`（trim + 折叠空白后 sha256 前 16 位），不同正文不会共用缓存；不落盘。
- 证据合成分批：第一批包含该页，引用编号仍由 `assignSourceIds` 统一分配，`result.sources[0].url === 'user-provided'`。

## 8. 统计与可观测性

- `statsOf` 新增 `sitemapPages`（`engine === 'sitemap'` 且 ok 的页数）、`sourceFailures`（数组长度）。
- `hosts` / `pagesFetched` 排除用户提供页。
- 调试统计行追加 `· sitemap N`，有失败时追加 `（失败 M）`；`OUTPUT_SCHEMA.stats` 同步声明两个 number。

## 9. 已知限制

1. **只探站点根**：`crawlSitemap` 固定 `new URL('/sitemap.xml', baseUrl)` / `sitemap_index.xml`。
   实测 `https://docs.spring.io/sitemap.xml` 与 `sitemap_index.xml` 均 404；Spring 文档 sitemap 在
   `https://docs.spring.io/spring-boot/sitemap.xml`（200）。host 级通道抓不到子路径 sitemap。
   后续要么允许 host 带路径，要么在 2 次预算内加"HTML `<link rel=sitemap>`"探测。
2. **不解析 robots.txt**：不读 `Sitemap:` 声明，也不遵守 `Disallow`；只用固定路径 + 400ms 间隔 + 单站 2 次请求做最低限度的礼貌抓取。
3. **sitemapindex 只跟一层**：嵌套更深的站点会漏。
4. **路径分词粗糙**：只按 `/` 切段，不做词干化/同义词；关键词全是 CJK 时依赖 URL 里恰好含有该片段，召回有限。
5. **direct / api 通道未执行**：声明值暂时不改变抓取行为。
6. **renderFallback 未接线**：目前只是数据 + 降档支持。
7. **`crawlSitemap` 成功但无匹配页**返回 `ok: true, urls: []`（不是失败）；管线因此不会记 `sourceFailures`，但也没有页面进预算。

## 10. 测试映射

| 文件 | 覆盖 |
| --- | --- |
| `test/sources.test.js` | 解析、sitemapindex 嵌套、相对 loc、关键词打分/去重/limit、成功路径 1 次请求、index 跟子图、404 失败原因与 2 次请求、缺参不抛 |
| `test/pipeline.test.js` | docs 类走 sitemap 且受页预算夹取、非 docs 不触发、sitemap 失败不中断、用户 text 作为首个证据且不计入 fetched |
| `test/brief.test.js` | jina/render 降档、raw 不变、非官方不受影响、`assignSourceIds` 透传 via |
| `test/cache.test.js` | text 参与 key、空白折叠、不同正文不同 key |
| `test/strategy.test.js` / `test/strategy-packs.test.js` | 默认 pack 与 concept 的 `sourcePlan` 与旧行为等价 |

运行方式（沙箱里 `node --test` 会 EPERM）：

```powershell
Get-ChildItem test\*.test.js | ForEach-Object { node $_.FullName }
```

0.6.0 完成时共 17 个测试文件、251 例全绿。