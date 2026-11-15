# 配置

配置写在 profile 的 `cordis.patch.yml` 里，由 `lib/config.js` 校验：布尔/数字支持字符串写法，越界值夹取，未知 `engines` / `verticals` 键、非法枚举与错误类型都记 warning 后回退默认值——写错配置不会让工具直接崩掉。

```yaml
# cordis.patch.yml（profile 级 patch）
- insert:
    - id: global-research
      name: '@local/dsh-global-research'
      config:
        depthDefault: auto
        engines: { ctxWeb: true, ddgHtml: true, tavily: true }
        keys: { tavily: 'tvly-...' }
        cache: { enabled: true, ttlMinutes: 60, maxEntries: 16, persistPath: '.cache/research.json' }
```

## 全部配置键

| key | 默认 | 说明 |
|---|---|---|
| `depthDefault` | `auto` | 未传 `depth` 时的档位；插件设置页里可改，改动即时生效（volatile） |
| `maxDeepPerSession` | `5` | 每 agent 的 `deep` 次数上限 |
| `material` | `''` | 设置页「研究材料」粘贴区保存的原文（≤20000 字）。每次 `research` 调用自动把它当最高优先级证据（不落盘、不进缓存 key）；显式传 `text` 时以 `text` 为准 |
| `engines.ctxWeb` | `true` | 复用 Harness 的 `ctx.web.search` |
| `engines.ddgHtml` | `true` | DuckDuckGo HTML 端点，零 key（本机实测常被 challenge 页拦截） |
| `engines.tavily` / `brave` / `serper` / `exa` | `false` | 开启后读取 `config.keys.<name>` 或环境变量 |
| `keys.<name>` | `{}` | 付费引擎 key 的内联写法（可选，见下） |
| `pageFetcher` | `raw` | 正文抓取路径：`raw` = 自带 HTTP + 抽取（最忠实，默认）；`web` = 只用宿主 `web.fetch`；`auto` = 先 web，正文太薄再用 raw 重试 |
| `useJinaFallback` | `false` | JS 重站点用 `r.jina.ai` 兜底取正文 |
| `docHostRewrite` | `3` | sitemap `<loc>` 跨主机改写：`docs.*` 文档站点的 sitemap 若仍指向旧主机，最多探测前 N 条并换成本主机；设 `0` 关闭 |
| `timeoutMs` | `120000` | 工具级超时下限；实际取 `max(配置, deep 的 360s) + 20s`，避免 deep 被工具超时先杀掉 |
| `verboseLog` | `false` | 打印引擎失败、重试等日志 |
| `debugStats` | `false` | 在简报末尾额外附「调试统计」一行（引擎、垂直源、官方直取、回补、域名），排查召回问题时用 |
| `cache.enabled` | `true` | 同一问题在 TTL 内复用上一次简报，不再花检索与模型额度；`partial` 结果不入缓存 |
| `cache.ttlMinutes` | `60` | 缓存有效期（1–1440 分钟） |
| `cache.maxEntries` | `16` | 进程内最多保留多少条结果（LRU 淘汰） |
| `cache.persistPath` | `''` | 缓存快照落盘路径：留空 = 只放内存；相对路径相对 workspace（`process.cwd()`），文件不存在时静默按空缓存启动 |
| `cache.persistDebounceMs` | `500` | 落盘防抖（0–60000 毫秒）：`set/clear` 后等这么久再写临时文件并 `rename`；`0` = 立即写 |
| `domainTrust.trusted` | `[]` | 额外视为一手/可信来源的域名（可写 URL，自动取 host），参与排序与一手来源门槛 |
| `domainTrust.blocked` | `[]` | 直接排除的域名（内容农场、垃圾站），排序前过滤 |
| `verticals.github` / `arxiv` / `stackexchange` / `npm` / `hn` / `pypi` | 全 `true` | 垂直源开关 |

## 付费引擎

免费额度够个人用：Brave 2,000 次/月、Tavily 1,000 credits/月、Serper 2,500 次（一次性）、Exa $10/月。

key 两种放法，任选其一：

```yaml
# 1) 环境变量（重启 DSH 后生效）
# TAVILY_API_KEY / BRAVE_API_KEY / SERPER_API_KEY / EXA_API_KEY
```

```yaml
# 2) 内联在 config.keys（本机 profile 私有，不进仓库）
config:
  engines: { brave: true, tavily: true }
  keys: { brave: 'BSA...', tavily: 'tvly-...' }
```

`config.keys.<name>` 优先于环境变量。开启后检索按「付费引擎 → ctx-web → ddg」合并，付费引擎的结果排在前面，标题与摘要更完整；`stats.engines` 列出本次实际用到的引擎，`stats.engineErrors` 是失败次数。

被 challenge 页拦截或返回 HTTP 4xx 的引擎会在本次进程内自动禁用，不会在每条 query 上重复浪费墙钟。

## 垂直源

通用引擎对「库 / 论文 / 报错」类问题召回很差：GitHub 仓库、arXiv 论文、Stack Overflow 答案往往排在二手教程后面。工具在通用检索之后追加一步垂直 API 检索（`lib/verticals.js`）：

| 源 | 触发信号 | 接口 |
|---|---|---|
| `github` | 代码/库/报错（npm、React、SDK、bug…） | GitHub Search Issues API（优先，问「怎么用」时更贴题），无结果再退回 Repositories API 并按问题词过滤无关仓库 |
| `stackexchange` | 同上 | Stack Exchange API `/search/advanced` |
| `npm` | 同上 | npm registry search |
| `pypi` | Python 包/依赖（pip install、python package、requirements.txt…） | PyPI 搜索页 + `/pypi/<name>/json` 的 summary/description |
| `arxiv` | 论文/benchmark/RAG/模型（paper、研究…） | arXiv Atom |
| `hn` | 观点/推荐/哪个更好（worth、recommend…） | HN Algolia |

按问题文本打分取前 2 个，每个用 1–2 条最相关 query 检索，命中并入候选池，与通用结果一起排序、抓取、抽证据。默认全部开启，可单独关：

```yaml
config:
  verticals: { github: true, arxiv: true, stackexchange: true, npm: true, hn: false, pypi: true }
```

垂直源失败（超时、429、404）只记入 `stats.verticalHits` / 错误计数，不影响主流程；它们与引擎一样不需要 key。

## 缓存

同一 `question` + `depth` + `focus` + `outputLanguage` + `text` 在 `cache.ttlMinutes` 内再次调用时，直接返回上次的简报（`stats.cached = true`、`cachedAgeMinutes = N`、`elapsedMs = 0`），不再发起检索或模型调用。

- 默认只在进程内，重启 DSH 即清空、不写磁盘；把 `cache.persistPath` 设成非空路径（如 `.cache/research.json`）才落盘：启动读回快照、丢弃已过 TTL 的条目、按 `maxEntries` 截断，坏 JSON 只记一条日志并按空缓存继续。
- `partial: true` 的结果不入缓存，避免把「没跑完」的结论复用给后续提问。
- **时效性问题不缓存**：问题或 focus 命中「最新 / 当前 / 现在 / 今年 / 发布 / 价格 / 版本 EOL / latest / current / release / price」等词时，跳过缓存读写。
- 命中缓存时简报首行标注 `> 本结果来自 N 分钟前的缓存，可能已过时`，不静默复用。
- 带 `context` 的追问也不缓存（上下文不同，语义就不同）。

## 设置页

插件列表里点开 `@local/dsh-global-research` 这一行：

- **默认深度**：`自动 / 快速 / 标准 / 深度` 四个圆角按钮，点选即保存。该字段声明为 volatile，宿主原地更新配置、不重启插件，下一次 `research` 调用就按新档位走。
- **研究材料（可选）**：一个 `textarea` 粘贴区，保存原文（≤20000 字，超限截断并提示）。保存后每次 `research` 调用自动把它当最高优先级证据，简报末尾会写「材料来源：设置页的「研究材料」」；模型显式传 `text` 时以 `text` 为准。「清空」按钮立即移除。适合贴公司内部文档、合同条款、接口说明这类检索不到的材料。
- **输入框右侧的胶囊可直接操作**：点「深度」循环切换 `auto → quick → standard → deep`，点「研究」启停插件（写的是同一份配置，需要宿主暴露 settings 通道；不可用时回退成只读提示「深度：设置页」）。保存过材料时多一枚「材料 N 字」胶囊，点击把设置路径复制到剪贴板。
- **启用 / 停用**：用行右侧的插件总开关（等价于 `pluginManager.setPluginEnabled`）；关闭后重新加载插件，工具不出现在模型工具表里，其余配置保留。
- 改配置页不需要重启；但**页面本身**（含客户端卡片）只在桌面应用启动时加载，`Ctrl+R` 不会重载，需要用菜单「应用 → 重新加载」或关掉窗口重开。

## 迁移到另一台机器

本项目是 DSH bundle 插件，不发布到 npm，按「目录 + profile patch」安装：

1. 把本目录放到新机器的插件工作区（例如 `D:\plugins\dsh-global-research`，路径随意，别放进 profile 目录里）。
2. 在 profile 的 `cordis.patch.yml` 里加一段（`keys` 留空即可先用免费引擎）：

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
4. **完全重启桌面应用**（`Ctrl+R` / `F5` 只切会话，不重新加载页面）；重启后在输入框右侧能看到「深度」胶囊、插件详情页里能看到「研究深度」设置。

API key 只放在 profile 的 patch 文件里，不进仓库；没有 key 时会退回 `ctx-web` 与 DuckDuckGo（后者在本机常被 challenge 挡住，因此推荐至少配一个 Tavily key）。