# @local/dsh-global-research

为 DeepSeek Harness 增加一个 `research` 工具：把一个**开放问题**当成研究任务来做，而不是把关键词丢给搜索框。

它做的事：拆题 → 生成多角度 query → 多引擎并行检索 → 去重排序 → 精读网页 → 抽证据卡 → 交叉验证 → 缺口回补 → 写成带 `[S1]` 行内引用的简报。

## 和 web_search / web_fetch 的区别

| | `web_search` | `research` |
|---|---|---|
| 输入 | 关键词 | 完整问题（含背景与要做的决定） |
| 输出 | 链接列表 | 结论、依据、方案对比、坑、置信度、未解决 |
| 过程 | 一次检索 | 拆题 + 多轮检索 + 精读 + 交叉验证 |
| 引用 | 无 | 每句关键论断带 `[S#]`，可回溯到原页 |
| 失败 | 报错 | 证据不足标 `low` + `gaps`，不编造；超预算返回 `partial` |

## 安装

```powershell
plugin_manager install_bundle target: D:\Total\dsh-global-research
```

安装后对当前 profile 的所有会话生效；新会话里模型会看到 `research` 工具。

改完代码需要重载（host 缓存模块）：

```text
plugin_manager set_plugin target: include:global-research enabled: false
plugin_manager set_plugin target: include:global-research enabled: true
```

## 用法

模型自己决定何时调用；也可以在对话里直接要求"用 research 调研……"。

```json
{
  "question": "2026 年给一个 Node.js 后端项目选包管理器：pnpm / yarn / bun 怎么选？",
  "depth": "auto",
  "focus": ["性能", "生态兼容", "迁移成本"],
  "outputLanguage": "zh"
}
```

- `question`：完整问题（含背景与要做的决定），不是关键词；上限 2000 字。
- `depth`：`auto`（默认，按问题里的对比/选型/约束词判断）/ `quick` / `standard` / `deep`。
- `focus`：评估维度，参与 query 生成与结果排序。
- `outputLanguage`：`zh` / `en` / `auto`。
- `context`（可选，≤2000 字）：追问上一轮结果时，把被指代的结论/证据原文附进来。research 看不到对话历史；带 context 的调用不走缓存。
- `researchId`（可选）：上一轮返回的会话 id（简报末尾 `> 研究会话：rs_…` 那行）。传回来即"续跑"：复用上一轮已读的页面与证据，只补新缺口，通常快 2–3 倍；30 分钟内有效，过期或不存在会静默回退成全新研究。

返回对象含 `brief`（Markdown）、`confidence`、`sources`、`gaps`、`partial`、`depthUsed`、`researchId`、`stats`；工具界面只展示简报。

简报末尾（「参考」之后）固定带一行运行统计，例如 `> 本次检索：6 个查询 · 9 个页面 · 14 条证据 · 73 秒（标准档）`——不用打开 `debugStats` 也能看到这次查了多少、抓了多少、用了多久；续跑时页面数只算新抓的，并标注 `· 复用 N 页`。同一结果重复渲染不会出现两行。Web 卡片会把这一行解析成标题下方的小字徽章。

## 预算

| depth | queries | pages | LLM 轮 | 补搜轮 | 墙钟 |
|---|---|---|---|---|---|
| quick | 2 | 3 | 6 | 0 | 90s |
| standard | 6 | 12 | 14 | 1 | 180s |
| deep | 16 | 30 | 28 | 1 | 300s |

超出预算/时间返回 `partial:true`，并在「未解决」写明剩余问题，不编造。

同一 agent 在进程内最多 5 次 `deep`，超出自动降为 `standard`（`maxDeepPerSession`）。

## 配置

`cordis.patch.yml` 里的 `config`：

| key | 默认 | 说明 |
|---|---|---|
| `depthDefault` | `auto` | 未传 `depth` 时的档位；插件设置页里可改，改动即时生效（volatile） |
| `maxDeepPerSession` | `5` | 每 agent 的 deep 次数上限 |
| `engines.ctxWeb` | `true` | 复用 Harness 的 `ctx.web.search` |
| `engines.ddgHtml` | `true` | DuckDuckGo HTML 端点，零 key（本机实测常被 challenge 页拦截） |
| `engines.tavily/brave/serper/exa` | `false` | 开启后读取 `config.keys.<name>` 或环境变量 |
| `keys.<name>` | `{}` | 付费引擎 key 的内联写法（可选，见下） |
| `pageFetcher` | `raw` | 正文抓取路径：`raw`=自带 HTTP+抽取（最忠实，默认）；`web`=只用宿主 `web.fetch`；`auto`=先 web，正文太薄再用 raw 重试 |
| `useJinaFallback` | `false` | JS 重站点用 `r.jina.ai` 兜底取正文 |
| `docHostRewrite` | `3` | sitemap `<loc>` 跨主机改写（0.6.8）：`docs.*` 文档站点的 sitemap 若仍指向旧主机，最多探测前 N 条并换成本主机；设 `0` 关闭 |
| `timeoutMs` | `120000` | 工具级超时下限；实际取 `max(配置, deep 的 300s) + 20s`，避免 deep 被工具超时先杀掉 |
| `verboseLog` | `false` | 打印引擎失败、重试等日志 |
| `debugStats` | `false` | 在简报末尾额外附「调试统计」一行（引擎、垂直源、官方直取、回补、域名），排查召回问题时用；查询数/页数/证据数/耗时已固定显示在「本次检索」行，不在这里重复 |
| `cache.enabled` | `true` | 同一问题（question/depth/focus/outputLanguage 全同）在 TTL 内复用上一次简报，不再花检索与模型额度；`partial` 结果不入缓存 |
| `cache.ttlMinutes` | `60` | 缓存有效期（1–1440 分钟） |
| `cache.maxEntries` | `16` | 进程内最多保留多少条结果（LRU 淘汰） |
| `cache.persistPath` | `''` | 缓存快照落盘路径（0.7.1）：留空=只放内存；相对路径相对 workspace（`process.cwd()`），文件不存在时静默按空缓存启动 |
| `cache.persistDebounceMs` | `500` | 落盘防抖（0–60000 毫秒）：`set/clear` 后等这么久再写临时文件并 `rename`；`0`=立即写 |
| `domainTrust.trusted` | `[]` | 额外视为一手/可信来源的域名（可写 URL，自动取 host），参与排序与一手来源门槛 |
| `domainTrust.blocked` | `[]` | 直接排除的域名（内容农场、垃圾站），排序前过滤 |

配置文件由 `lib/config.js` 校验：布尔/数字支持字符串写法，越界值夹取，未知 `engines`/`verticals` 键、非法枚举与错误类型都记 warning 后回退默认值——写错配置不会让工具直接崩掉。

### 设置页（默认深度与启停）

插件列表里点开 `@local/dsh-global-research` 这一行：

- **默认深度**：`自动 / 快速 / 标准 / 深度` 四个圆角按钮，点选即保存。该字段声明为 volatile，宿主原地更新配置、不重启插件，下一次 `research` 调用就按新档位走。
- **输入框右侧的「深度」胶囊是只读提示**：显示当前默认档位；点击只是把设置路径复制到剪贴板，不能就地改档——宿主没有向插件的 client 半开放写配置的通道，真正改档请回到本页。
- **启用 / 停用**：用行右侧的插件总开关（等价于 `pluginManager.setPluginEnabled`）；关闭后重新加载插件，工具不出现在模型工具表里，其余配置保留。
- 改动配置页后不需要重启；但**页面本身**（含客户端卡片）只在桌面应用启动时加载，`Ctrl+R` 不会重载，需要用菜单「应用 → 重新加载」或关掉窗口重开。

### 结果缓存

同一 `question` + `depth` + `focus` + `outputLanguage` 在 `cache.ttlMinutes` 内再次调用时，直接返回上次的简报（`stats.cached=true`、`cachedAgeMinutes=N`、`elapsedMs=0`），不再发起检索或模型调用；`focus` 不同即视为不同问题。默认缓存只在进程内，重启 DSH 即清空、不写磁盘；把 `cache.persistPath` 设成非空路径（如 `.cache/research.json`）才会落盘（0.7.1）：启动时读回快照、丢弃已过 TTL 的条目、按 `maxEntries` 截断，坏 JSON 只记一条日志并按空缓存继续。`partial:true` 的结果不入缓存，避免把"没跑完"的结论复用给后续提问。

**时效性问题不缓存**：问题或 focus 命中"最新 / 当前 / 现在 / 今年 / 发布 / 价格 / 版本 EOL / latest / current / release / price"等词时，跳过缓存读写——宁可多跑一次，也不给旧答案。命中缓存时简报首行会标注 `> 本结果来自 N 分钟前的缓存，可能已过时`，不会静默复用。**带 `context` 的追问也不缓存**（上下文不同，语义就不同）。

### 付费引擎（提升"搜得到"）

免费额度够个人用：Brave 2,000 次/月、Tavily 1,000 credits/月、Serper 2,500 次（一次性）、Exa $10/月。key 两种放法，任选其一：

```yaml
# cordis.patch.yml
- insert:
    - id: global-research
      name: '@local/dsh-global-research'
      config:
        engines: { brave: true, tavily: true }
        keys: { brave: 'BSA...', tavily: 'tvly-...' }   # 内联，本机 profile 私有
```

或只开开关、key 放环境变量（重启 DSH 后生效）：

```text
TAVILY_API_KEY / BRAVE_API_KEY / SERPER_API_KEY / EXA_API_KEY
```

`config.keys.<name>` 优先于环境变量。开启后检索按"付费引擎 → ctx-web → ddg"合并，付费引擎的结果排在前面，标题与摘要更完整；`stats.engines` 会列出本次实际用到的引擎，`stats.engineErrors` 是失败次数。

被 challenge 页拦截或返回 HTTP 4xx 的引擎会在本次进程内自动禁用，不会在每条 query 上重复浪费墙钟。

## 垂直源（P2）

通用引擎对"库/论文/报错"类问题召回很差：GitHub 仓库、arXiv 论文、Stack Overflow 答案往往排在二手教程后面。P2 在通用检索之后追加一步垂直 API 检索（`lib/verticals.js`）：

| 源 | 触发信号 | 接口 |
|---|---|---|
| `github` | 代码/库/报错（npm、React、SDK、bug…） | GitHub Search Issues API（优先，问"怎么用"时更贴题），无结果再退回 Repositories API 并按问题词过滤无关仓库 |
| `stackexchange` | 同上 | Stack Exchange API `/search/advanced` |
| `npm` | 同上 | npm registry search |
| `arxiv` | 论文/benchmark/RAG/模型（paper、研究…） | arXiv Atom |
| `hn` | 观点/推荐/哪个更好（worth、recommend…） | HN Algolia |
| `pypi` | Python 包/依赖（pip install、python package、requirements.txt…） | PyPI 搜索页 + `/pypi/<name>/json` 的 summary/description |

按问题文本打分取前 2 个，每个用 1–2 条最相关 query 检索，命中并入候选池，与通用结果一起排序、抓取、抽证据。默认全部开启，可在配置里单独关：

```yaml
config:
  verticals: { github: true, arxiv: true, stackexchange: true, npm: true, hn: false, pypi: true }
```

垂直源失败（超时、429、404）只记入 `stats.verticalHits`/错误计数，不影响主流程；它们与引擎一样不需要 key。`debugStats` 打开时简报末尾会显示「垂直源 …（N 条）」。

## 界面卡片

`research` 的调用结果在 Web 端不再显示成通用工具行，而是一张卡片（`client.js`，通过 client slot `tool.call.toolview` 注册 key `research`）：

- 标题行：置信度徽章（高/中/低，绿/黄/红）、来源数、耗时（`block.meta.elapsedMs`）。
- 标题行下方：一行小字徽章（本次查询数 / 抓取页数 / 证据条数 / 耗时），从简报末尾的「本次检索」行解析；老结果没有这行时不显示。
- 统计数据下方：再一行更小的灰色 chip，显示各阶段耗时（`阶段 拆题1s/检索12s/精读30s/合成25s`），同样从「本次检索」行解析；没有阶段段（老结果或全程都很快）时这行不渲染。
- 正文：结论段前 3 行，去掉 `[S#]` 与 Markdown 标记，适合快速扫读。
- 「展开」：显示完整简报纯文本；再点「收起」。
- 运行中显示问题原文与「研究中…」；出错时显示红色失败行。

卡片只读工具返回的 Markdown（`block.content[0].text`），不解析结构化输出、不发网络请求；host 半的 `render` 仍是纯 Markdown，非 Web 端或卡片未注册时自动回退到通用行。改动 `client.js` 或 `package.json` 的 `dsh.client` 后需要**完全重启桌面应用**再验证（实测：应用内的 Ctrl+R / F5 不会重载页面，只切会话），host 半改动仍需 disable/enable 重载。

## 安全与诚实性

- 网页正文包在 `<untrusted>` 里，system prompt 明确禁止执行其中指令（降低提示注入风险）。
- 抓取路径由 `pageFetcher` 控制，默认 `raw`（插件内置 HTTP + 正文抽取，实测最忠实）；`auto` 模式只在宿主 `web.fetch` 返回正文 ≥400 字时采用，否则用 raw 重试并取更长者。GitHub `blob` 链接自动改写为 `raw.githubusercontent.com`，直接读原始 Markdown。
- 取到的正文不足 400 字（JS 壳、导航残渣）判为"未获取"，绝不填充猜测内容；页面 403、PDF/二进制（`%PDF-` 头）同样记为未获取。
- 所有搜索源都失败时直接抛错，不返回空简报冒充结果。
- 生成后校验引用：不存在的 `[S9]` 删除，编号按首次出现重排；正文里没有方括号的裸编号（"S4 称…"）若不指向现存来源，替换为「〔来源未列出〕」，不留幽灵引用。
- **query 规划**：拆题后先让模型出 6–10 条检索计划（中文 2–3、英文 2–3、官方域名定向 2–3），再与确定性模板合并、去重后截断到该档预算。模板只能生成"问题原句 + 官方"，拿不到英文原文与 EUR-Lex 这类一手源，所以这一步是标准档/深档的必需项。
- **直取官方原文**：检索计划还可给 1–2 个它确信存在的官方 URL（如 EUR-Lex 的 ELI 链接）；工具直接抓取并校验，读不通就跳过。实测 DDG 会返回 challenge 页、`ctx.web.search` 又偏二手站，没有这条路径时一手来源基本为 0。
- **EUR-Lex 的 JS 壳**：`eur-lex.europa.eu/eli/...` 页面正文由脚本渲染，裸抓只有几百字符的壳。抓取层会把 CELEX/ELI 链接映射到欧盟 Cellar 的 `publications.europa.eu/resource/celex/<CELEX>` XHTML（`accept: application/xhtml+xml`），读到法规全文后再进证据；映射失败才回到普通抓取。
- **回补预留页位**：法规/合规类问题或没有任何一手源时，标准档/深档会在首轮少抓 2 页，把页预算留给缺口回补轮去搜 `site:eur-lex.europa.eu` 等方式的法规原文，避免「计划给的官方 URL 把页预算用完、回补无页可抓」。
- **一手来源门槛**：standard/deep 档若全部证据都来自二手解读（没有 `domainTrust>=2` 的官方/一手/代码仓库来源），置信度强制降为 `low`，并在「未解决」写明"缺少一手或高质量来源"，结论段必须写「初步判断（证据不足）」，禁止"已生效/必须"这类确定语气。
- 同一页面的多语言版本（`nodejs.org/fr|ja|zh-cn`）、镜像（`cdn.jsdelivr.net`、`url.nodejs.cn`）、同一仓库的不同 commit/分支、`.md` 与 HTML 两种格式，都按内容归一为一条来源，避免 S1–S7 其实只有三个实体。
- 单一来源的论断标"待验证"，来源冲突标"有争议"；`github.com/nodejs/*` 官方仓库加权，不同仓库视为独立来源（不会因为同为 github.com 就被判成单一来源）。
- 涉及"还剩多久"时，合成提示里注入今天日期，要求写出"截止日 − 今天"的算式，禁止把生命周期总长当成剩余时间。

## 测试

沙箱里 `node --test test/` 会因 spawn EPERM 失败，逐文件跑：

```powershell
Get-ChildItem test\*.test.js | ForEach-Object { node $_.FullName }
```

覆盖：URL 规范化与内容去重、预算、JSON 修复、引用校验、DDG 解析、引擎失败隔离与自动禁用、付费引擎解析与 key 来源、垂直源选择与解析（GitHub/arXiv/StackExchange/npm/HN/PyPI，含垃圾 payload、纯中文 query 跳过、SE 标签映射与 intitle 回退、单源失败隔离）、管线十步（假引擎/假抓取/假模型，含检索计划优先与 ghost citation 清理）、阶段耗时（六个阶段的整数毫秒、快跑不进简报）、官方链接挖掘与预算边界、EUR-Lex Cellar 映射与回退、EUR-Lex 摘要页/搜索页降权与 ELI 原文优先、EU 站点语言前缀归一、法规问题回补预留页位、无一手源时回补强制官方域名 query、垂直源正文兜底与选择位保护、配置校验（类型强转/夹取/未知键 warning）、域名信任名单与黑名单过滤、缓存（key 归一、TTL、LRU、命中不调模型、focus 不同绕过、可关闭）、client 卡片解析（置信度徽章/来源数/耗时/失败与运行中状态/无分段兜底/阶段 chip 与缺段不渲染）、阶段摘要格式（>0.5s、最多 4 段、按阶段顺序输出）、`apply` 注册、skill 注册与端到端 execute、sourcePlan 通道声明、sitemap 解析与关键词打分、sitemap 预算/失败隔离、sitemap base 相对发现与内容校验、跨主机 `<loc>` 改写与 `docHostRewrite` 开关、按题选择文档 base（`pickDocBases`）、证据档位（`sourceTier` 24 个 URL 的档位表与 `doc-page > repo-doc > repo-code` 排序）、tech-selection 的 doc-page 槽位与无候选不填充、用户提供资料作为证据、价格题分类与 pricing 通道 / official-docs 拦截（0.8.3）。共 320 例。

## 真实网络 e2e

单元测试全部用假引擎、假抓取和假模型，抓不到只在真实网络上出现的问题（DDG challenge、JS 壳页面、引用校验吞掉真实片段）。`scripts/e2e-real.mjs` 用真实 `fetch`、真实 `lib/engines.js` 和 `lib/fetch.js` 跑一遍 `runResearch`，只把 LLM 换成固定应答的假模型（唯一要花钱、要 provider 的依赖）：

```powershell
$env:RUN_REAL='1'; $env:TAVILY_API_KEY='tvly-...'; node scripts/e2e-real.mjs
```

- 不设 `RUN_REAL=1` 时打印 `skipped (set RUN_REAL=1)` 并以 0 退出，所以它**不在默认测试/CI 流程里**（普通的 `Get-ChildItem test\*.test.js | ForEach-Object { node $_.FullName }` 不会碰它）。
- `TAVILY_API_KEY` 可选：不设就跳过 Tavily，退回免 key 的 ddg-html + 垂直源。搜索层全被墙时脚本会 FAIL（退出码 1），不静默通过。
- 断言：`queries >= 2`、`pagesFetched >= 1`、简报含 `## 参考` 与 `> 本次检索`、全程不抛错；成功打印一行 `PASS e2e-real: queries=… pages=… clusters=… sources=… engine=… elapsed=…s`，失败打印 `FAIL e2e-real: …` 并退出 1。
- 加 `E2E_VERBOSE=1` 可看到引擎失败、证据批次与卡住的环节。

## 路线图

- **P1（已完成）**：管线骨架、证据卡、交叉验证、引用校验、简报渲染、安装与端到端验收。
- **P2（已完成）**：付费引擎 Tavily（真实 key 实测：检索层从"中文二手站为主"变为官方 release 表 / nodejs.org / GitHub 原始文件可命中；Brave 因注册需绑卡未启用）+ 垂直源 GitHub / arXiv / StackExchange / npm / HN（自动选择、失败隔离、API 正文兜底、排序后保留至少一个垂直源引用、统计行）。Stack Overflow 召回调优（2026-11-14）：只发拉丁词 query、纯中文跳过、全文无结果时回退 `intitle` 标题搜索，并把页面来源标进证据提示，最终冒烟里 SO 已进入「参考」并出现在依据第 5 条。
- **P3（已完成 2026-11-14）**：`research-protocol` skill 随插件注册（何时调用、怎么读 confidence/gaps、深档何时开子代理）；缺口回补增强——当整轮证据没有任何一手/官方来源时，回补轮即使已有 4 个以上证据簇也会触发，并强制追加 `site:eur-lex.europa.eu` / `site:europa.eu`（法规类）、`site:npmjs.com`（包类）、`site:github.com`（仓库类）的确定性 query；回补抓到的页面若含官方链接（如政策页 → EUR-Lex ELI），会用剩余页预算继续下钻一层。Stack Overflow 召回再加"问题关键词→标签映射"（react-hooks / reactjs / python / node.js 等 30+ 规则），先按标签搜、无结果再退回无标签全文与 intitle。
- **P4（已完成 2026-11-14）**：结果缓存（同问题 TTL 内复用简报，LRU 上限，`partial` 不入缓存，命中不调模型）、按域名的信任名单/黑名单配置（参与 `domainTrust` 与排序前过滤）、PyPI 垂直源直连、配置校验（`lib/config.js`：类型强转、越界夹取、未知键与非法枚举 warning）、UI 卡片（`client.js` 经 `tool.call.toolview` 注册 `research`：置信度徽章、来源数与耗时、结论摘要、展开全文；host 端 `render` 仍返回纯 Markdown 作回退）。

## P5 新增能力（2026-11-15）

- **时间敏感问题不缓存**：问题含「最新/现在/价格/EOL/latest/current/release」等词时跳过缓存；普通缓存命中会在简报首行提示「本结果来自 N 分钟前的缓存」。
- **追问续跑**：`researchId` 复用上一轮已读页面与证据，只补新缺口（30 分钟内有效）；省略式追问建议同时带 `context`。
- **过程可见**：简报末尾固定一行 `> 本次检索：N 个查询 · M 个页面 · K 条证据 · T 秒（档位）`，卡片解析成四个小徽章；行尾再追加 ` · 阶段 拆题Xs/检索Ys/精读Zs/合成Ws`（只列 >0.5s 的阶段，最多 4 段），卡片把这一段渲染成第二行灰色小 chip。
- **结果导出**：`saveTo` 把简报写成 Markdown（含参考与统计行）；不传则不落盘。
- **研究类型**：`mode: explain | compare | track | evaluate`，compare 强制对比表与适用条件，track 强制带日期的时间线，evaluate 输出约束→匹配度→风险。
- **URL 直取**：问题里贴的 URL 会优先直接抓取，不再要求是官方域名。
- **证据分级**：参考条目标注 官方 / 论文 / 仓库 / 论坛 / 百科 / 网页；`high` 置信度要求至少 2 个独立一手来源。
- **论文源**：新增 OpenAlex 垂直源（免 key），命中带年份与被引次数。
- **检索质量**：中文长问句额外切 ≤12 字片段做 query；planner 没给英文 query 时自动补拉丁词 query。

## 0.5 新增能力（2026-11-15）

- **策略引擎**：单一 `questionKind` 分类器收编原先 6 套隐式判定；7 类问题（tech-selection / fresh-data / contested / legal / troubleshoot / learning / concept）各有 query 模板、来源权重、必出章节与校验规则，`concept` 与默认策略的行为逐字不变。
- **冲突检测**：结构冲突看论点是否相反，数值冲突看价格/版本/日期/容量在属性归一后是否并列（如「输出上限 384K vs 256K」）；数值冲突排在「## 存在冲突」最前面。数值冲突按**实体**（模型/产品名）分组比较，跨实体的差异不报冲突，而是在「未解决」写成「口径差异：…不可直接比较」。
- **参考完整性**：参考末尾追加「另有 N 个页面被读取但未采用（域名）」，把读过却没进参考的页面在明面上交代掉。
- **一手来源**：价格类问题自动直取厂商价目页（DeepSeek / 阿里云 / 智谱 / 火山），取不到的写进「未解决」的「官方价目页未取到：域名」，不静默跳过。

## 0.6.0：按问题类别取源（sourcePlan / sitemap 定向爬取 / 用户提供资料）

0.6.0 把"取哪些源"从 Step 2b/3b 的隐式硬编码，改成策略里可声明的 `sourcePlan`。分三层：

1. **策略层**（`lib/strategies.js`）：每个 `questionKind` 的 pack 可声明 `sourcePlan.channels`，通道形状为
   `{ id, method: 'sitemap' | 'direct' | 'api', hosts: [...], maxPages }`，外加
   `renderFallback: { allowed, maxCalls }`。默认策略的 `sourcePlan` 是空通道数组 + `renderFallback: { allowed: false, maxCalls: 0 }`，
   因此默认路径的抓取集合与 0.5.x 完全一致（由既有测试保护）。
2. **执行层**（`lib/pipeline.js` Step 2a）：0.6.3 起真正接线。`method: 'sitemap'` 的通道按 `bases` 数组依次爬站点根，
   第一个能返回 sitemap 的根胜出（失败只记 `sourceFailures` 并继续下一个根）；没有 `bases` 时退回按问题匹配 `hosts` 的旧行为。
   0.6.8 起 `bases` 可写成 `{ base, tags }`，`pickDocBases(question, focus, bases)` 先按 tags 与问题 token 的重合度排序
   （多词 tag 要求全部 token 命中，如 `spring-ai` → `spring` + `ai`），无 tags 的通用 base 排最后且只在无命中时优先，
   最多试 2 个 base（`max: 2`）：Spring AI 的 RAG 问题先进 `spring-ai/reference/`，Spring Boot 的 JPA 问题先进 `spring-boot`。
   `method: 'direct'` 的通道按 `seeds`（真实 URL 数组）直取，最多 `channel.maxPages` 条，页面标记 `engine: 'channel:<id>'`。
   `api` 通道仍是声明（留给后续版本）。
3. **取回层**（`lib/fetch.js`）：每个取回结果统一带 `via`（`raw` / `web` / `jina` / `cellar`，sitemap 页面由管线覆盖为 `sitemap`），
   供 `gradeSource(url, via)` 决定是否降档。

通道表（0.6.3 接线后）：

| 通道 | 适用 questionKind | method | 目标 | maxPages |
| --- | --- | --- | --- | --- |
| `official-docs` | tech-selection / learning | sitemap | bases 带 tags，按问题排序（0.6.8）：spring-ai/reference（spring-ai/ai/rag/vector）、spring-boot（spring-boot/boot/web/jpa）、docs.langchain4j.dev（langchain4j/llm/rag/agent）、通用 docs.spring.io；learning 用 react.dev / nodejs.org / docs.python.org | 3 |
| `pricing` | fresh-data / pricing（0.8.3） | direct | seeds: api-docs.deepseek.com、help.aliyun.com、bigmodel.cn、www.volcengine.com 的价目页 | 4 |
| `standards` | legal | direct | hosts: prisma-statement.org, cochrane.org, eric.ed.gov, owasp.org, eur-lex.europa.eu | 2 |
| `papers` | contested | api | hosts: arxiv.org, openalex.org, pmc.ncbi.nlm.nih.gov | 2 |

`pricing` 的 `seeds` 只在价格类问题出现（`resolveStrategy` 对非价格问题会剥掉通道上的 `seeds`），否则发布/EOL 类问题会把
整档页预算花在厂商价目页上。

**sitemap 定向爬取**（`lib/sources.js`）：`crawlSitemap` 先探站点根（`/sitemap.xml` → `/sitemap_index.xml` → `/sitemap-index.xml`，
0.6.4 起含连字符形式），再探 **base 目录下**的同名文件（0.6.7：`sitemap.xml` → `sitemap_index.xml` → `sitemap-index.xml`，
相对 `baseUrl` 所在目录解析，去重后不会重复请求）。`paths` 参数可覆盖为纯根相对候选。
命中条件不看状态码而看内容：返回体必须含 `<urlset>` 或 `<sitemapindex>` 且真解析出 `<loc>`，否则（含 200 但内容是 HTML 的软 404）
继续下一个候选。命中 `sitemapindex` 时再额外花请求展开子 sitemap（只跟一层），子 `<loc>` 相对 **index URL** 解析，
因此 `/docs/` 下的 `sitemap-0.xml` 仍落在 `/docs/` 里。解析 `<loc>` 后按问题关键词（latin token + CJK 短片段）对路径分词打分，取前 N 条。

约束：候选数 = 根 3 条 + base 3 条（去重后 ≤6），最坏全 404 时 6 次请求；命中 index 再允许 2 次展开（合计最多 8 次），
请求间隔 ≥400ms，单次整体预算 12s，失败返回 `{ ok: false, reason }` 不抛异常；不解析 robots.txt（已知限制）。

**sitemap 路径偏好**（0.6.5）：在关键词打分之上加路径先验——路径含 `/reference/`、`/docs/`、`/api/`、`/guide/`、`/guides/`、
`/manual/`、`/learn/` 记 +3；含 `/blog/`、`/news/`、`/press/`、`/events/`、`/changelog/`、`/tag/` 记 −3。
`parseSitemapEntries` 额外保留 `<lastmod>`，早于 3 年的条目再 −2（`parseSitemap` 仍返回纯 URL 数组，保持兼容）。
关键词至少命中一个仍是硬门槛（路径形状本身不算证据），最终得分 ≤0 的条目直接丢弃而不是抓回来占页预算：
实测 `spring.io` 的 7475 条 `<loc>` 里没有 `/reference/`、`/docs/` 路径，0.6.4 会挑中三条 2015–2018 的 `/blog/` 旧文，
0.6.5 改为挑出 `guides/gs/spring-boot`、`guides/gs/spring-boot-docker`、`guides/gs/spring-boot-for-azure`。

**跨主机 `<loc>` 改写**（0.6.8）：站点换域名后常常继续发旧 sitemap。`docs.langchain4j.dev/sitemap.xml` 里的 `<loc>`
仍指向 `langchain4j.github.io/tutorials/chat-memory`（实测 404），而同一路径在 `docs.langchain4j.dev` 上是 200。
`crawlSitemap` 返回前会检查 `<loc>` 主机与 base 主机是否不同：只有 base 是 `docs.*` 文档主机、且两边都是
`.dev`/`.io` 这类文档类域名时才改写，最多探测前 `docHostRewrite`（默认 3）条，用 5s 超时取 `base origin + 原 path`，
2xx/3xx 才替换，失败保留原 `<loc>`；CDN、多域站点不受影响，`docHostRewrite: 0` 可整体关闭。
探测复用同一 `fetchRaw`，仍走 ≥400ms 间隔与 12s 预算。

**旧源降权**（0.6.5）：`looksStale(text)` 识别「已过期 / 不再维护 / 已归档 / deprecated / archived / end of life」等自我声明，
`rankHits` 对命中的条目 −3，若同时 `publishedAt` 早于 3 年再 −1；`groupEvidence` 之前不做任何过滤，
因此唯一来源仍会进简报，只有候选数超过页预算时才会被挤出 `selected`。竖向来源的保留槽位也不会再把 stale 条目硬塞回来。

**预算与失败**：sitemap 抓回的页面走同一条 `__fetchPage`，成功一页扣一格页预算（`budget.take('pages')`），
预算不够就少抓；失败只记 `stats.sourceFailures`（数量）和内部 `{channel, host, reason}`，不中断管线。
`official-docs` 通道最多试 2 个 base（0.6.8），每个 base 最多 6 条候选 + 2 次 index 展开，再加上 ≤3 次主机改写探测，
最坏约 2×(6+2)+3 = 19 次轻量请求，仍远低于页预算开销；实际多数站点第 1 个候选就命中。
非 docs 类问题不会触发 sitemap；默认策略没有通道，所以也不会慢。

**渲染兜底门槛**：`renderFallback.allowed` 只在文档站通道（`official-docs`）为 `true`、`maxCalls: 1`，其余为 `false / 0`。
0.6.0 只落数据模型与校验门槛，**渲染器本身尚未接入**（见已知限制）。

**用户提供资料**：`research` 新增可选 `text`（≤20000 字）。传入时作为最高优先级证据页
（`url: 'user-provided'`、`title: '用户提供的资料'`、`engine: 'user'`）放在证据列表首位，检索仍照常运行；
`text` 参与 cacheKey，不同正文不会串缓存；不落盘。

已知限制：

- `spring.io` 的 sitemap 入口是 `spring.io/sitemap-index.xml`（连字符），0.6.4 起能命中：真实网络验证
  `crawlSitemap({ baseUrl: 'https://spring.io' })` 返回 `ok: true`，经 `sitemap-index.xml` 展开到 `sitemap-0.xml`（7475 条 `<loc>`）。
- `docs.spring.io` 的站点根没有 sitemap（`/sitemap.xml`、`/sitemap_index.xml`、`/sitemap-index.xml` 实测全 404），
  但 **文档目录下有**：0.6.7 实测 `https://docs.spring.io/spring-ai/reference/sitemap.xml` 200 / 132191 字节，
  `https://docs.spring.io/spring-boot/sitemap.xml` 200 / 13687546 字节。`crawlSitemap({ baseUrl: 'https://docs.spring.io/spring-ai/reference/' })`
  因此能返回 `ok: true` 与该目录下的 3 条 URL。
- 通道的 `bases` 现在带 tags 并按题排序（0.6.8），Spring AI / Spring Boot / LangChain4j 不会再互相串；
  但同一项目内部仍是「第一个成功即停」——`docs.spring.io/spring-boot/sitemap.xml` 有 13.7MB、候选里 `spring-boot`
  排在 `spring-ai` 之后只是 tag 排序的结果，问题里两个词同时出现时仍以 tag 得分高者为准。
- `docs.langchain4j.dev` 的 sitemap 实测仍指向 `langchain4j.github.io`（换域名后的旧数据）；0.6.8 会在返回前把前几条
  改写到 docs 主机并验证 2xx/3xx，没探测到的条目仍可能指向旧主机。
- `sitemapindex` 只跟一层，嵌套更深的站点会少抓（候选耗尽时按失败返回）。
- `api` 通道仅声明不执行；`renderFallback` 未接线。
- 不读 robots.txt，也不做 crawl-delay 之外的站点限速。

## 安装与迁移到另一台机器

本项目是 DSH bundle 插件，不发布到 npm，按“目录 + profile patch”安装：

1. 把本目录放到新机器的插件工作区（例如 `D:\\Total\\dsh-global-research`）。
2. 在 profile 的 `cordis.patch.yml` 里加一行（`keys` 留空即可先用免费引擎）：

```yaml
- id: global-research
  name: "@local/dsh-global-research"
  config:
    engines:
      tavily: true
    keys:
      tavily: "tvly-替换成你自己的key"
    debugStats: false
```

3. 用 `plugin_manager.install_bundle` 指向该目录，或把 profile 依赖指向本地路径（`link:D:/Total/dsh-global-research`）。
4. **完全重启桌面应用**（Ctrl+R / F5 只切会话，不重新加载页面）；重启后在输入框右侧能看到「深度」胶囊、插件详情页里能看到「研究深度」设置。

API key 只放在 profile 的 patch 文件里，不进仓库；没有 key 时会退回 `ctx-web` 与 DuckDuckGo（后者在本机常被 challenge 挡住，因此推荐至少配一个 Tavily key）。

## 截图

![research 卡片](docs/screenshots/01-card.png)

![插件设置页：研究深度](docs/screenshots/02-settings.png)

![输入框右侧的深度胶囊](docs/screenshots/03-composer.png)

## 简报结构（0.6.1）

简报在「## 参考」之前带一行检索流程，数字全部来自本轮真实计数，不做估算：

```text
> 检索流程：识别 20 篇 · 去重后 12 篇 · 可读 9 篇 · 采用 3 篇
```

- **识别 N 篇**：引擎、垂直源、sitemap、直接 URL 与用户提供资料在去重前的原始命中数。
- **去重后 M 篇**：按规范化 URL（去 `www`、镜像域名归一）合并后的候选数。
- **可读 K 篇**：实际抓取成功（`page.ok`）的页面数，含补缺轮抓到的页面。
- **采用 J 篇**：最终进入「## 参考」的来源数。

`quick` 档同样输出。续跑（resume）时 N/M 只记本轮新抓、K/J 保持总量，行尾补一句复用页数：

```text
> 检索流程：识别 3 篇 · 去重后 3 篇 · 可读 12 篇 · 采用 5 篇（续跑：复用 9 页）
```

0.6.2 起，只要本轮读到过官方/定向通道页，行尾再补一段官方采用率（未读到则不出现，保持旧格式）：

```text
> 检索流程：识别 20 篇 · 去重后 12 篇 · 可读 9 篇 · 采用 3 篇 · 官方采用 1/3
```

`官方` 指官方域名（`isOfficialDomain`）或经 sitemap 定向通道抓到的页面；`x/y` 表示这些可读页里有 `x` 页最终进了「## 参考」。读到了却没采用，是证据抽取漏了，而不是检索没抓到——0.6.2 的逐页兜底专门修这一点：模型只引用了部分页面时，没被引用的页面也会各补一条启发式证据（官方/通道页段落门槛 60 字符，其余 120 字符）。

0.7.1 起，planner 标了 query 类别时（`planPrompt` 返回 `{q, kind}`），行尾再补一段查询构成；没有 query 或旧格式不出现，前面四数/官方采用段一字不变：

```text
> 检索流程：识别 20 篇 · 去重后 12 篇 · 可读 9 篇 · 采用 3 篇 · 官方采用 1/3 · 查询 中文语义 4 / 英文技术 3 / 官方定向 2
```

三类计数之和等于 `stats.queries`；类别由模型给出，缺省按形状兜底（`site:`→官方定向、含中文→中文语义、其余→英文技术）。

冲突不再是一个平铺列表，而是三分：

```text
## 存在冲突
### 事实冲突
- 输出上限：384K tokens（[S1]） · 256K tokens（[S2]）
- Node 22 输出上限（支持）— [S1] nodejs.org
### 口径差异
- 输出上限：65536 tokens（[S1]） / 131072 tokens（[S2]）（对象不同，不可直接比较）
### 来源自相矛盾
- 输出上限：384K tokens / 256K tokens（[S1] 同一页面内说法不一致）
```

- **事实冲突**：同一实体同一属性出现两个不同值，或同一断言出现支持/反驳两方。
- **口径差异**：不同实体或不同单位（元 / 美元、上下文窗口 vs 输出上限）的数字，写清为什么不可直接比较，最多 2 条。
- **来源自相矛盾**：同一 URL 的证据里同属性出现两个不同值；同一页面列出三个及以上取值视为表格/变更记录，不报矛盾。

某一类为空时该小标题下写 `- 无`。三类都为空时整段不出现，保持与 0.6.0 一致的简报；只有「不同对象」的口径差异时仍按旧行为写进「## 未解决」的一条注记。0.6.3 起，**单位不可换算**（如 0.15 美元/百万 tokens 与 0.3 元/百万 tokens）本身就会让这一段出现，写在 `### 口径差异` 里，不再因为事实冲突为空而被丢掉。

**价格题强制标币种**（0.6.3）：`synthPrompt` 规定价格表必须有一列「币种/单位」；不同币种不得直接比较大小、不得合并排序或得出「更便宜」，「## 未解决」里要写明「币种不同，未换算」；汇率没在证据里出现就不自行折算。断言层也同样处理：不可换算的价格对（元 vs 美元）标 `unitMismatch`，只进 `### 口径差异`，不进 `### 事实冲突`。

**过期源不能充当论据**（0.6.6）：页面标题或摘要自称已过期/不再维护/已归档（`looksStale`）时，Step 5 读完就给它打 `stale` 标记，随后：

- 证据抽取直接跳过这些页，`[S5]` 不会再是「本项目已过期」的仓库；只有全部可读页都过期时才会退回使用它们，并在证据上标 `stale: true`，同时在「## 未解决」写 `唯一可读来源已过期（host）`。
- 给模型的证据提示词里，这类页面的页头带 `，⚠ 已过期/停维护`，并明确不许用它支撑当前状态、维护方或选型的论断。
- 过期来源不计入置信度：`computeConfidence` 不再把它们算进 confirmed / primary 计数（域名可信度 `domainTrust` 只看域名，会把「过期仓库」错算成可信 github 源），一份全靠过期来源的简报最多是 `low`。
- 若某条数字断言因此失去全部来源，不报冲突（缺证据 ≠ 冲突），但在「## 未解决」留一行「「属性」仅有过期来源，已剔除」，最多 2 条。
- 万一过期页仍进了「## 参考」（全页过期或已被采用），该行行尾标 `（已过期，仅作参考）`。

## 更新日志

### 0.9.0（2026-11-15）

- **答案层：第一行必须是一句话结论**：`lib/prompts.js` 的 `synthPrompt` 现在把「## 结论」的首行钉成 `**一句话：<结论>**`（≤80 字，有推荐对象就点名，如「选 Node 22 LTS」），之后才是 2–4 句前提/依据；结论段里每个可核查判断的末尾必须紧跟 `[S#]`，没有来源的判断显式写 `（推断）`。证据不足（无一手源或零定量）时，先在前面单独一行写 `**（证据不足，以下为初步判断）**` 再给一句话结论；旧的「初步判断（证据不足）」措辞已删除，避免模型把免责声明和结论写进同一行。
- **新增「## 行动清单」段**：3–5 条，每条 `- ` 开头、动词开头、≤60 字、能直接执行；位置固定在「## 步骤」/「## 方案对比」之后、「## 坑与风险」之前；compare 类至少 1 条写「怎么小范围验证或试点」。`lib/brief.js` 的 `ensureSections()` 总会确保这一段存在：模型漏写时补 `## 行动清单\n- 无`，并且和既有缺段逻辑一致地参与降档。
  - 新增导出 `requiredSectionsFor({ mode, questionKind, base })`：compare / tech-selection / learning 把行动清单当必需段（缺了降一档置信度），concept / track 等只补占位不降档；它会和策略包自己声明的 `brief.requiredSections` 合并，`lib/pipeline.js` 的 `requiredSections` 改走这个函数。
- **定量对比的数字有出处**：`synthPrompt` 要求「## 方案对比」表的数字列每一行数字后都带 `[S#]`；`lib/brief.js` 新增 `markUnsourcedNumbers()`，在 `buildResult()` 里做一次兜底——表格行里没有 `[S#]` 的裸数字，在该单元格追加 `（无来源）` 而不是删掉数字，重复执行不会叠标记（幂等）。
- **测试**：`test/prompts.test.js` 断言一句话格式、推断标注、行动清单位置/条数/动词/试点要求、数字出处指令；`test/brief.test.js` 断言缺段补 `- 无` 与段位、compare 必需 / concept 可选、裸数字兜底与幂等；`test/pipeline.test.js` 断言端到端（假模型）在 `> 检索流程：` 之后确实出现 `## 行动清单` 且段序为 方案对比 → 行动清单 → 坑与风险，compare 缺段降档、concept 不降档；`test/strategy-packs.test.js` 的 legacy 段序断言随新段更新。
- 测试总数 329（新增 9：prompts +3、brief +3、pipeline +3；strategy-packs 的 legacy 段序断言按 0.9.0 段序改写 1 例，数量不变）。

### 0.8.3（2026-11-15）

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

### 0.8.2（2026-11-15）

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

### 0.8.1（2026-11-15）

- **compare 选项名不再带上中文谓词**：真实输出曾出现 `选项「Haystack 该」在本轮证据中没有可用来源（零证据），未纳入对比`——问题以 `Haystack 该怎么选` 结尾时，按 `|` `/` `、` `vs` `还是` 切出的最后一段把谓词一起带进了选项名，于是 `countOptionHits` 用「Haystack 该」去比对证据，命中必然为 0，零证据提示和对比表都写错名字。`lib/pipeline.js` 的 `cleanOptionToken` 现在对每个候选先按 `/(该怎么|怎么|如何|哪个|哪一种?|选哪个|怎么选|呢|吗|？|\?|。|，|,)/` 的**第一个**匹配截断再 `trim()`，并处理「Java 后端做 RAG 应用，Spring AI」这类逗号前缀（取逗号后带拉丁字母的那段），截断后为空、超过 24 字或全是噪声标点的候选直接丢弃；去重与 ≤5 不变。同一问题现在得到 `Spring AI / LangChain4j / Haystack`，`A、B、C 该怎么选` 得到 `A / B / C`（单个拉丁字母保留），`X vs Y 哪个好` 得到 `X / Y`，`只有 A` 不作为对比题处理。
- **planner 漏掉 `official` 时的兜底查询**：真实输出曾出现 `查询 中文语义 3 / 英文技术 3 / 官方定向 0`——`planPrompt` 要求「2–3 条定向官方域名 query」，但模型只回中文/英文时，合并后的查询里没有一条 `site:`，策略里声明的官方文档站一次都没被定向到。`lib/pipeline.js` 的查询合并处在 `queriesByKind.official === 0` 且 `strategy.sourcePlan.channels` 含 `official-docs` / `pricing` / `standards` 时，从该通道**已声明**的 `bases` / `seeds` 取前 2 个 host（不碰 `hosts`，避免把 standards 名单猜成检索目标），生成 `site:<host> <core-term>` 追加到查询尾部；core-term 取 `latinTopic(question + focus)`，没有拉丁词时取问题前 20 字。追加受 `profile.queries` 上限约束（按 depth 为 2 / 6 / 16），满了先换掉**最后一条 `technical`**；planner 一条 technical 都没给（报告里的情形：6 条全是中文语义）时换掉最后一条任意类查询——总数不变，`official` 不再是 0。计数归入 `official`，`stats.queriesByKind` 与最终实际发出的查询逐条对齐（`> 检索流程：` 行不会再出现 `官方定向 0`）。prompt 措辞未改；`concept`/默认策略没有官方通道，行为保持原样。
- **回归脚本可复现 `mode`**（0.8.1）：`scripts/retrieval-check.mjs` 增 `--mode explain|compare|track|evaluate`。此前脚本不传 `mode`，真实报告里的 `官方定向 0` 走的是 `compare → tech-selection` 包（策略声明了 official-docs 通道），脚本却总是落回 `concept`（无官方通道），既复现不出也验证不了这条修复；现在 `--mode compare` 能跑同一条路径（输出头多一段 `· mode:`，JSON 也多一个 `mode` 字段）。
- 测试总数 316（新增 6：`compareOptions` 的谓词截断与逗号前缀、零证据 gap 用截断后的选项名、planner 只给 semantic/technical 时兜底出 `site:` 且不改总数、全是语义且预算已满时仍然出官方查询、已有一条 official 时不重复追加、`officialBackstopQueries` 只认已声明的 bases/seeds 与无官方通道时为空；`--mode` 并入原有 parseArgs 用例）。

### 0.8.0（2026-11-15）

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

### 0.7.1（2026-11-15）

- **零证据选项显式提示**：compare 模式（以及 `tech-selection` 一类对比式选型）在合成前先算每个候选选项的证据覆盖。`lib/pipeline.js` 的 `compareOptions(question, focus)` 从问题与评估维度里按 `|`、`/`、`、`、`vs`、`还是` 切出候选（去重、最多 5 个），`countOptionHits` 用选项 token 与 cluster 的 claim/证据文本比对；命中为 0 的选项追加进 `gaps`：`选项「X」在本轮证据中没有可用来源（零证据），未纳入对比`，同时写进 `stats` 之外的结果字段供简报兜底。`lib/brief.js` 的 `applyZeroEvidenceOptions` 再把「## 方案对比」表里该选项行的其余单元格改写为 `无证据`（模型漏写这行时补一行；整段没有表格时退化成 bullet），并在「## 未解决」保留同一句。改表发生在 `validateCitations` 之前，被清掉的 `[S#]` 不会留在参考里；函数幂等。
- **缓存落盘（默认关闭）**：`config.cache.persistPath`（默认 `''`，空=只放内存，相对路径相对 workspace）与 `persistDebounceMs`（默认 500，0=立即写）。`ResearchCache` 增 `load()`：启动时读回 JSON、校验结构、丢弃过期条目并按 `maxEntries` 截断；`save()` 防抖写临时文件再 `rename`，`set/clear` 自动触发；`flush()` 供测试与退出前等待。坏快照只经 `onError` 记日志，不让插件启动失败；空路径完全不碰文件系统。
- **planner 查询三分类**：`planPrompt` 要求 `{"queries":[{"q","kind"}],"directUrls":[],"reason":"..."}`，`kind ∈ semantic|technical|official`（中文语义 / 英文技术 / `site:` 官方定向）。旧格式的裸字符串 query 照常可用并默认按 `semantic` 计；缺 kind 时 `lib/pipeline.js` 按形状兜底（`site:`→official、含中文→semantic、其余→technical），`stats.queriesByKind` 计数，`> 检索流程：` 行尾追加 `· 查询 中文语义 a / 英文技术 b / 官方定向 c`（仅当总数 > 0，四数行原有格式不变）。
- 测试总数 305（新增 cache 4：落盘重建读回、过期条目不读回、空路径不写文件、坏快照容错；config 1：落盘配置校验；brief 2：流程行 query mix、无证据表改写；prompts 1：plan 的 kind 字段；pipeline 3：kind 计数与流程行、旧字符串格式、compare 零证据选项）。

### 0.7.0（2026-11-15）

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

### 0.6.8（2026-11-15）

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

### 0.6.7（2026-11-15）

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

### 0.6.6（2026-11-15）

- **过期页打标**：`lib/pipeline.js` 新增 `markStalePages(pages)`，Step 5 读完（含 5b 官方链接）后给每页写 `page.stale = looksStale(title + ' ' + snippet)`；用户提供的资料豁免（用户自己选的，不是工具挑的）。
- **证据层拦截**：`extractEvidence` 新增 `allowStale`（默认 false），模型引用与启发式兜底都跳过 `page.stale === true` 的页；只有全部可读页都过期时才允许使用，并在证据卡上带 `stale: true`。补缺轮（`gapRefill`）同一规则。
- **提示词标注**：`lib/prompts.js` 的 `evidencePrompt` 页头加 `，⚠ 已过期/停维护`，并加一条规则：这类页面只能用于历史背景，不能支撑当前状态/维护方/选型。
- **置信度折扣**：`lib/brief.js` `computeConfidence` 用存活证据重算 cluster 状态并排除过期来源的 confirmed/primary 计数（无过期卡片的 cluster 行为不变）。
- **冲突与缺口**：Step 9 与 catch 路径在 `analyzeAssertions` / `findSelfContradictions` 之前剔除 `stale` 证据（缺证据 ≠ 冲突）；新增「「属性」仅有过期来源，已剔除」（≤2 条）与 `唯一可读来源已过期（host）` 两类缺口。
- **参考行标注**：`appendReferences` 对过期来源行尾补 `（已过期，仅作参考）`。
- 测试总数 280（新增 pipeline 2、brief 2、prompts 1）。

### 0.6.5（2026-11-15）

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

### 0.6.4（2026-11-15）

- **sitemap 路径候选**：`crawlSitemap` 从「`sitemap.xml` / `sitemap_index.xml` 两条、最多 2 次请求」改为有序候选
  `sitemap.xml` → `sitemap_index.xml` → `sitemap-index.xml`（`SITEMAP_PATHS` 导出，`paths` 参数可覆盖）。全 404 时正好 3 次请求；
  命中 `sitemapindex` 再允许 1 次展开子图（合计最多 4 次）。
- **软 404 不算命中**：候选是否成功改由 `parseSitemap` 的 `<loc>` 数决定，返回 `text/xml` 的 HTML 错误页会继续下一个候选。
- 真实网络验证：`crawlSitemap({ baseUrl: 'https://spring.io' })` → `ok: true`，`sitemap-index.xml` → `sitemap-0.xml`（7475 条 `<loc>`），
  按 `spring/boot/configuration` 命中 3 条 spring.io 页面；`docs.spring.io` 三条候选仍全 404（`ok: false`）。
- 测试总数 269。

### 0.6.3（2026-11-15）

- **官方域名表扩充**：`OFFICIAL_DOMAINS` 加入厂商官方文档/价目页（`docs.spring.io`、`spring.io`、`langchain4j.dev`、`help.aliyun.com`、`bigmodel.cn`、`volcengine.com`、`api-docs.deepseek.com`、`docs.aws.amazon.com`、`cloud.google.com`、`learn.microsoft.com`、`react.dev`、`vuejs.org`、`docs.djangoproject.com`、`docs.python.org`、`developer.mozilla.org`、`nodejs.org`、`platform.qianwenai.com` 等）；`isOfficialDomain` 仍是 host 后缀匹配（子域也算）。价格/文档题不再「官方采用恒为 0」。
- **`pricing` 通道接线**：`sourcePlan` 的 `direct` 通道按 `seeds` 真实直取（DeepSeek / 阿里云百炼 / 智谱 / 火山方舟 四张价目页，全部先 curl 确认 200），页面标 `engine: 'channel:<id>'`，失败进 `sourceFailures` 不中断管线；`maxPages` 4。
- **`official-docs` 通道按 `bases` 回退**：sitemap 通道依次尝试声明的站点根（如 `docs.spring.io` → `docs.spring.io/spring-boot` → `docs.spring.io/spring-ai`），第一个成功即停，失败逐个记录后继续。
- **价格题强制标币种**：`synthPrompt` 要求价格表有「币种/单位」列；不同币种不得直接比较/排序，必须在「## 未解决」写「币种不同，未换算」。断言层的不可换算价格对只进 `### 口径差异`，并且 0.6.3 起单独出现也会生成该段（以前只有事实冲突或自相矛盾才会建段）。
- 只对价格类问题启用 `pricing.seeds`（`resolveStrategy` 会为非价格问题剥掉通道上的 `seeds`），避免发布/EOL 类问题把页预算花在价目页上；测试总数 266。

### 0.6.2（2026-11-15）

- **逐页证据兜底**：`extractEvidence` 不再「整批为空才兜底」。模型只抽到部分页面时，任何没有产出证据的页面都会各自跑一次 `heuristicEvidence`，官方文档页不会因为别的页返了 1 条证据就被整批丢弃；`policy.heuristicFallback === false` 仍可整体关闭。
- **官方/通道页放宽阈值**：`heuristicEvidence(page, { minChars })` 支持阈值；`page.via === 'sitemap'` 或 `isOfficialDomain(page.url)` 时用 60 字符，其余保持 120，仍要过 `NAV_NOISE` 过滤。
- **官方采用率**：`statsOf` 新增 `officialReadable` / `officialAdopted`，「> 检索流程：」行尾追加 `· 官方采用 x/y`（`y > 0` 时才追加），读到没采用不再无声。
- 不改 `gradeSource` / 置信度公式，不动 `sourcePlan` / sitemap 逻辑；测试总数 261。

### 0.6.1（2026-11-15）

- **检索四数流程行**：简报在「## 参考」前输出 `> 检索流程：识别 N 篇 · 去重后 M 篇 · 可读 K 篇 · 采用 J 篇`，`statsOf` 新增 `identified` / `deduped` / `readable` / `adopted`；`quick` 档同样输出，续跑标注复用页数。
- **冲突三分法**：「## 存在冲突」内分 `### 事实冲突` / `### 口径差异` / `### 来源自相矛盾`，空类写 `- 无`，三类全空不出现该段；新增 `findSelfContradictions(pages)` 识别同一页面内同属性自相矛盾（三值以上视为表格，不报）。
- 不改 `gradeSource` 与置信度公式，不动 `sourcePlan` / sitemap 逻辑；测试总数 257。

### 0.6.0（2026-11-15）

- **sourcePlan**：策略按 `questionKind` 声明取源通道（official-docs / pricing / standards / papers），默认策略保持空通道、抓取集合不变。
- **sitemap 定向爬取**：`lib/sources.js` 解析 `sitemap.xml` / `sitemapindex`，按问题关键词给路径打分选页；Step 2a 只对 docs 类问题执行，计入页预算，失败隔离。
- **via 标记与降档**：取回结果统一带 `via`；经 Jina / 渲染兜底拿到的官方或论文来源在参考里降一档。
- **用户提供资料**：`text` 参数把正文作为最高优先级证据，参与缓存 key，不落盘。
- 新增 `test/sources.test.js`，测试总数 251。

### 0.5.3（2026-11-15）

- **数值冲突按实体分组**：以模型/产品名为实体分组比较，跨实体的差异不再误报冲突，改在「未解决」写明「口径差异：…不可直接比较」（237 例测试全绿）。

### 0.4.0（2026-11-15）

- **过程可见**：简报统计行末尾追加 `阶段 拆题/检索/精读/合成` 耗时，卡片下方渲染为四个小标签。
- **真实网络 e2e**：新增 `scripts/e2e-real.mjs`（`RUN_REAL=1` 触发），真实抓取 + 假合成，断言可跑通并产出引用。

### 0.3.0（2026-11-15）

- 新增 **docs 垂直源**：React/Node/TS 类问题直连 MDN 搜索，Spring 与 Python 类问题直接给出官方文档入口。
- GitHub 源增加 **code search 回退**：issues 与仓库都空时按代码片段找"别人怎么写"。
- 付费引擎增加 **配额保护**：Tavily/Brave/Serper/Exa 有进程内用量上限，超限自动禁用并在 `stats.engineQuota` 暴露。

### 0.2.0（2026-11-15）

- **准确性**：证据按发布日期加权（≤1 年加分、>2 年降权并标「旧」）；同一事实出现分歧时强制输出「## 存在冲突」段，列出双方与来源，不抹平。
- **有效性**：简报固定输出「## 下一步建议」（要跑的命令 / 要读的链接 / 要问的问题）。
- **产品化**：结果卡片支持一键复制 Markdown、来源折叠区（可点链接）、运行中转圈、失败与空结果态。

## 常见问题

**为什么查不到某个官网的价格/参数？**
官网多是 JS 渲染或登录墙。直接把 URL 贴进问题里，工具会优先直取该页（`URL 直取`），不依赖搜索引擎召回。

**为什么 confidence 经常是 low？**
low 表示关键结论缺少一手或独立来源，简报会写出缺口。这不是失败，而是诚实标注；按「未解决」补一轮 research 或给 URL 通常能升到 medium/high。

**要花钱吗？**
本体免费。检索默认走 `ctx-web` 与 DuckDuckGo；DuckDuckGo 在很多网络下会被 challenge 拦截，所以建议配一个免费的 Tavily key（每月 1000 次）。

**会编造引用吗？**
不会。证据必须能在抓到的正文里匹配到才保留；引用编号会被校验，悬空的 `[S#]` 会被删掉或标为「来源未列出」。

**数据会上传吗？**
只把问题与抓到的正文片段交给本机配置的模型；缓存与追问会话只在内存里，30 分钟过期，不落盘。

## 架构（一图流）

```
research(question, depth, focus, mode, context, researchId, saveTo)
   │
   ├─ 拆题 → 生成 query（模板 + 模型规划，中英双语/定向官方站）
   ├─ 检索：付费引擎(Tavily/Brave/Serper/Exa) → ctx-web → DDG；垂直源直连(GitHub/arXiv/OpenAlex/SE/npm/HN/PyPI)
   ├─ URL 直取：用户贴的 URL 与 planner 给的官方 URL 优先抓
   ├─ 抓取分层：raw → web.fetch → Jina；EUR-Lex 走 Cellar XHTML；SO/HN 用 API 正文兜底
   ├─ 证据卡 + 引用接地（原文匹配）+ 交叉验证（多域名/立场）
   ├─ 缺口回补（含官方/法规定向 query）
   └─ 合成简报：结论/依据/对比/坑/置信度/未解决/参考 + 统计行
```

## 开发

```bash
node test/*.test.js     # 逐文件跑（node --test 在沙箱里会 spawn EPERM）
node --check index.js client.js
```

改完代码后必须 `plugin_manager` 里 disable → enable 重载；client 半（卡片/胶囊）需要**完全重启桌面应用**才生效。