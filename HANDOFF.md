# 交接：全球深度研究插件（2026-11-15 自主迭代结束）

## 一句话状态

插件可日常使用（P0–P8 + 0.6.x + 0.7.0 + 0.7.1 + 0.8.0 + 0.8.1 + 0.8.2 + 0.8.3 + 0.9.0 + 0.9.1 + 0.9.2 全部完成），**0.9.1 及之前已全部推送到 GitHub**（2026-11-15 用 `git ls-remote` 核实：`refs/heads/main` 与当时本地 HEAD 一致）；0.9.2 是本地提交，**尚未推送**。0.8.0 起有 `scripts/retrieval-check.mjs`：不跑完整研究、不花 LLM，就能验证「检索与选页」有没有退化；0.8.1–0.8.3 用它抓到并修掉了四处真实回归（compare 选项名带中文谓词、planner 不产出官方定向查询、不传 mode 时选型题落到 concept、价格题被 Java 文档通道劫持）。0.9.0 是「答案层」：简报首行一句话结论（带 `[S#]`/`（推断）`）、新增「## 行动清单」、方案对比裸数字兜底标 `（无来源）`。0.9.1 是**仓库规整 + 两处真实回归修复**：更新日志拆到 `CHANGELOG.md`，README 收敛为快速上手 + 索引，新增 `docs/` 四页与 `.github/`（CI / Issue 表单 / PR 模板 / Dependabot）及社区文件；同时修掉「8 条官方文档页覆盖三个手册段却判 low」（广度改按文档段计，跨源确认仍按站点计）与「对比题选项被冒号引导语/中文谓词切碎、表格全被误判无证据」（重写 `compareOptions()` 与 `countOptionHits()`）。0.9.2 是**零证据选项的定向回补**：对比题里一条可用证据都没有的选项，报告前各做一次定向检索（`<选项> <核心词>`，pricing 用 `价格 OR pricing`，最多 3 项 / 3 页），能补就删掉该 gap 并把页面放进参考，补不上才写「零证据」并注明「（已定向检索 1 次仍未获证）」。

## 仓库与版本

- 本地：`D:\Total\dsh-global-research`（git，工作树干净）
- 远端：https://github.com/qibufengliu-design/dsh-global-research
- 本地提交（自旧到新）：
  - `d5faf38` 0.6.0 来源通道 sourcePlan + sitemap 爬取 + text 直投
  - `2cbe17f` 0.6.1 四数流程行 + 冲突三分法
  - `bfcb27b` 0.6.2 逐页证据兜底 + 官方采用比
  - `c630089` 0.6.3 官方域名扩充 + 定价种子页 + 币种列
  - `5975896` 0.6.4 sitemap 三候选路径 + index 展开 + 软 404
  - `aaa10cb` 0.6.5 过期源降权 + sitemap 路径偏好
  - `0e5d941` 0.6.6 过期源不得充当论据
  - `73e9722` 0.6.7 base 相对 sitemap 发现（docs.spring.io/spring-ai 等终于能爬）
  - `0b71c46` 0.6.8 sitemap 跨主机改写 + 按题选文档 base
  - `14402f7` 0.7.0 证据排序层：具体 API/参考页排在仓库源码之前
  - `bf91614` docs: handoff 0.7.0 commit hash
  - 0.7.1（本次提交）零证据对比提示 + 缓存落盘 + planner 查询三分类；hash 在此文件改写后生成，未回填
  - 0.8.0（本次提交）检索回归脚本 `scripts/retrieval-check.mjs` + 纯函数单测；hash 在此文件改写后生成，未回填
  - 0.8.1（本次提交）compare 选项名截断 + planner 官方定向查询兜底（`officialBackstopQueries`）；hash 在此文件改写后生成，未回填
  - 0.8.2（本次提交）不传 mode 时 classify 自认选型/对比题（`COMPARE_HINTS`/`TECH_HINTS`/`hasOptionList` + `classify().mode`）；hash 在此文件改写后生成，未回填
  - 0.8.3（本次提交）价格题 → 新 kind `pricing`（`PRICING_HINTS` 词表 + `PRICE_COMPARE_HINTS` + `PRICE_DECISIVE_KINDS` 优先级），`resolveStrategy` 对价格词问题删掉 `official-docs` 通道；hash 在此文件改写后生成，未回填
  - 0.9.0（本次提交）答案层：`synthPrompt` 首行 `**一句话：…**` + `[S#]`/`（推断）` 标注 + 新增「## 行动清单」；`lib/brief.js` 的 `ensureActionChecklist`/`requiredSectionsFor`/`markUnsourcedNumbers`（compare 缺清单降档、裸数字标 `（无来源）`）；hash 在此文件改写后生成，未回填
  - 0.9.1 仓库规整 + 两处真实回归：① 规整——`CHANGELOG.md` 从 README 拆出（20 条历史）；README 重写为「快速上手 + 文档索引」；新增 `CONTRIBUTING.md` / `CODE_OF_CONDUCT.md` / `SECURITY.md` / `.editorconfig` / `.gitattributes` / `.github/**` / `docs/{architecture,configuration,development,release}.md` / `scripts/test-all.mjs`；`package.json` 补 `repository`/`homepage`/`bugs`/`author`/`scripts.test`；② A 题——`lib/util.js` 新增 `evidenceSiteKey()`（文档主机按 `host/首段` 计广度），`lib/brief.js` 的 `strong` 改用它、`confirmed` 仍用 `siteKey`，8 条官方文档 `low → medium`；③ B 题——`lib/pipeline.js` 的 `compareOptions()` 先取末个冒号后的部分再切分并丢弃引导语段，`countOptionHits()` 按核心 token（拉丁词边界 + 版本后缀 / 中文 ≥2 字子串）匹配，零证据 gap 与「无证据」行只给核心名 ≥2 字且命中 0 的选项
- 0.9.2 零证据选项定向回补：`lib/pipeline.js` 新增 `TARGETED_REFILL`（`maxOptions:3 / maxPages:3 / maxHitsPerOption:2 / minRemainingMs:30000`）、`targetedCoreTerm(strategy)` 与 `targetedOptionRefill()`；compare 零证据阶段先回补再写 gap，`stats.targetedRefill {optionsTried,pagesFetched,optionsResolved}`、流程行 `· 定向回补 N 项（解决 M）`、debugStats 同步；`test/pipeline.test.js` +3（补上 / 补不上 / 预算与墙钟双守卫），既有 4 条断言随行尾新段与定向 query 微调；hash 在此文件改写后生成，未回填
- 文档入口：`README.md`（用法）→ `docs/architecture.md`（管线与通道）→ `docs/configuration.md`（全部配置）→ `docs/development.md`（测试与调试）→ `docs/release.md`（发布清单）
- 测试：18 个文件逐个跑，**337 例全绿**（`node scripts/test-all.mjs`，或 `node test/<file>.test.js` 让 node:test 在进程内跑；`node --test test/` 与 `node --test test/<file>` 在沙箱都会 EPERM）

## 推送

沙箱内 `git push` 需要 `sandbox_permissions: danger-full-access`（普通沙箱里 git 的凭据脚本会 `couldn't create signal pipe`）。做法：

```powershell
cd D:\Total\dsh-global-research
git -c http.sslBackend=openssl push origin main --follow-tags
git -c http.sslBackend=openssl ls-remote origin HEAD refs/heads/main refs/tags/*   # 核对远端
```

凭据管理器（GCM）会弹出一次授权；若用 PAT，则 `https://qibufengliu-design:<PAT>@github.com/...`。

**0.9.1 起**每个版本都打 annotated tag `vX.Y.Z`（与 `package.json.version` 一致）并 `--follow-tags` 推送；`git ls-remote` 的 `refs/heads/main` 必须等于本地 `HEAD` 才算推送完成。

**改不了的部分**：本机没装 `gh`、也没有 `GITHUB_TOKEN`/`GH_TOKEN`，所以远端仓库设置（描述、topics、分支保护、Release 页面、Issue 标签）只能手工在网页上做，无法脚本化。

## 这轮做了什么（用户可感）

1. **按问题类别取源**：不同问题类型声明各自的来源通道（官方文档 / 价目页 / 标准 / 论文 / 论坛 / 仓库），不再只有"通用搜索"。
2. **官方文档真的会进参考**：docs.spring.io / docs.langchain4j.dev / help.aliyun.com / bigmodel.cn 等 17+ 厂商域名被认定为官方；价格类问题会去官方价目页并强制标币种（不同币种不换算）。
3. **可审计的过程行**：`> 检索流程：识别 N 篇 · 去重后 M 篇 · 可读 K 篇 · 采用 J 篇 · 官方采用 x/y`。
4. **冲突三分**：事实冲突 / 口径差异 / 来源自相矛盾，不再把"不同口径"当成"事实矛盾"。
5. **旧源降权**：标题含"已过期/不再维护/archived"的降 3 分；sitemap 选页优先 `/docs/ /reference/ /guides/`，避开 `/blog/`；`lastmod` 超 3 年再降权。
6. **证据排序层**（0.7.0）：`sourceTier(url)` 给每页分档（doc-page +4 / doc-index +2 / repo-doc +1 / repo-code −2 / forum −1 / blog −2），`rankHits` 叠加档位分；tech-selection / learning / compare 下还留一个 doc-page 槽位。回归 A 里「8 条采用 5 条是仓库」的问题由此修掉。
7. **零证据选项说清楚**（0.7.1）：用户比的选项若一条证据都没有，不再从表里悄悄消失——表里该行写 `无证据`，`gaps` 与「## 未解决」都留同一句。
8. **缓存可落盘**（0.7.1，默认关）：`cache.persistPath` 非空时启动读回、`set/clear` 防抖原子写；过期条目与坏快照都不会污染进程。
9. **检索计划可审计**（0.7.1）：planner 给每条 query 标 semantic/technical/official，`> 检索流程：` 行尾多一段 `· 查询 中文语义 a / 英文技术 b / 官方定向 c`。
10. **检索回归可复跑**（0.8.0）：`node scripts/retrieval-check.mjs --question "…" [--focus "a,b"] [--depth standard] [--json]` 用真实引擎 + 真实抓页器和假模型跑完整 `runResearch`，输出四数、采用来源的 `docPage/repoCode/other` 拆分、垂直源命中与前 10 条 URL 及档位；采用 0 条退出码 1。tavily key 先取 `TAVILY_API_KEY`，再取桌面 profile 的 `keys.tavily`（裸值/引号都认），都没有就只跑 ddg-html 并说明。单测不联网，只测纯函数 `summarize/exitCodeFor/tavilyKeyFromPatch/parseArgs`。
11. **两处真实回归修掉**（0.8.1，都是上面那个脚本抓出来的）：对比题的问题尾巴不再污染选项名（`Haystack 该` → `Haystack`，`compareOptions` 按 `该怎么/怎么/如何/哪个/…` 第一次匹配截断，逗号前缀取拉丁段）；planner 只回中文/英文查询时，用策略里已声明的官方通道 `bases`/`seeds` 兜底生成最多 2 条 `site:<host> <core-term>`（占 `profile.queries` 预算，满了替换最后一条 technical），`官方定向 0` 不再出现，`stats.queriesByKind` 与最终查询一致。
12. **不传 mode 也认得出选型/对比题**（0.8.2）：`classify()` 新增对比措辞（`该怎么选|怎么选|哪个好|差异|区别|…`）+ 技术栈提示（`java|spring|node|react|…|数据库|框架|中间件`）与三选项列表（`A、B、C` / `A/B/C`）；两者同时命中 → `tech-selection` 且建议 `compare`，只命中措辞 → 仍归 `tech-selection`（不新增 `comparison` kind）。`runResearch` 没收到 mode 时不再默认 `'explain'`，而是用 `classify().mode`；`index.js` 用有效 mode 算缓存键，`stats` 增加 `mode`。实测同一条 RAG 选题在**不带 `--mode`** 时 `docPage` 5 → 10、官方定向 0 → 2。
13. **价格题别再被 Java 文档劫持**（0.8.3）：新增第八个 kind `pricing`（`QUESTION_KINDS`/`KIND_PRIORITY` + 策略包，只声明 `pricing` 直取通道）。`PRICING_HINTS` 覆盖 `价格|定价|收费|多少钱|便宜|成本|费用|单价|价位|报价|计费|免费额度|每百万|per token|/1k tokens|price|pricing|cost|billing` 等；命中价格词 `classify()` +6 并覆盖 `tech-selection`，法律/排障/争议题仍优先（`PRICE_DECISIVE_KINDS`），显式 `llmKind` 仍最终生效；`PRICE_COMPARE_HINTS`（`哪家便宜|对比|比较|cheaper|compare`…）命中时建议 `mode:'compare'`。`resolveStrategy` 再加一道兜底：问题命中价格词就删掉 `official-docs` 通道（即使硬传 `tech-selection`）。实测「国内大模型 API 价格对比…哪家便宜」从 0.8.2 的前 9 条全为 spring/langchain4j 文档页，变成 `adopted tiers: docPage 10`、前 10 条全是 DeepSeek/阿里云/火山价目页；A 题（RAG 选型）仍是 `docPage 10` + 官方查询 2 条，未被打扰。`SIGNAL_VERSION` 2 → 3。

14. **答案层**（0.9.0）：简报第一行固定为 `**一句话：<结论>**`（≤80 字、有推荐对象就点名、每个可核查判断带 `[S#]`、无来源写 `（推断）`、证据不足先写 `**（证据不足，以下为初步判断）**`）；新增「## 行动清单」（3–5 条动词开头、≤60 字，compare 至少 1 条试点/验证，位置在方案对比之后、坑与风险之前，漏写补 `- 无` 并降档）；`markUnsourcedNumbers()` 给「## 方案对比」里没有 `[S#]` 的裸数字补 `（无来源）`（不删数字、幂等）。`requiredSectionsFor()` 把 compare / tech-selection / learning 的清单列为必需段，concept / track 只补占位。

15. **两处真实回归**（0.9.1）：① **置信度广度**——A 题 8 条官方文档（`docs.spring.io` 7 / `docs.langchain4j.dev` 1）覆盖三个手册段却判 `low`，因为广度集合用 `siteKey()` 只数 host；`lib/util.js` 新增 `evidenceSiteKey(url)`（文档主机或 `doc-page` → `host/首段`，github → 仓库，其余 → host），`lib/brief.js` 的 `strong` 改用它、`confirmed` 仍用 `siteKey`，同一厂商文档不算独立确认，A 题 `low → medium`。② **对比选项**——价格题三行全被判「无证据」且选项名带冒号引导语/中文谓词；`compareOptions()` 先取最后一个 `：`/`:` 之后的内容再按 `|` `/` `、` `，` `vs` `还是` 切分、丢弃含 `对比|价格|选型|哪个|怎么|如何` 的段，`countOptionHits()` 按核心 token 匹配（拉丁词边界 + `qwen` → `qwen2.5` 版本后缀、中文 ≥2 字子串），零证据只写给核心名 ≥2 字且命中 0 的选项。

16. **零证据选项定向回补**（0.9.2）：B 题「国内大模型 API 价格对比：qwen、豆包、deepseek 哪家便宜」里豆包没有任何可用单价时，过去只在「未解决」写「零证据」、不做补救。现在 compare 报告前对每个零证据选项（≤3 个）各发 1 条定向 query `<选项> <核心词>`（核心词按 `strategy.queries.extraTemplates[0]` 的意图取：pricing → `价格 OR pricing`、official-docs → `官方 文档 OR official docs`、default → `官方 OR official`），`searchAll` 取前 2 条非同域且未抓过的链接，`budget.take('pages', …)` 后抓取；抓到的页跑 `heuristicEvidence()`（复用 0.6.2 逐页兜底）并入 `state.clusters`，再重算命中数：补上 → 删 gap、页面进 sources；仍为 0 → 原 gap 追加「（已定向检索 1 次仍未获证）」。整段上限 3 项 / 3 页 / 3 次查询，页数取 `min(3, profile.pages, budget.remaining('pages'))`，墙钟余量 <30s 或中止直接跳过，定向 query 不占 `profile.queries`（沿用 `gapRefill` 先例），失败只记 `state.refillQueries` 不抛异常；`stats.targetedRefill` + 流程行 `· 定向回补 N 项（解决 M）` 让这件事可审计。

## 已知缺口（不是 bug，是数据/结构限制）

- 厂商 token 单价（如豆包）在官网 JS 渲染页后面，纯 HTTP 拿不到；`text` 参数可让用户贴正文直接进证据（0.6.0 新增）。
- 零证据判定是「选项核心 token 在 claim/证据文本里是否出现」（0.9.1 起：拉丁词边界 + 允许版本后缀，中文 ≥2 字子串），同义词（如 Haystack 写作 `haystack-ai`）与更长的中文别名（如「豆包大模型」写作「豆包」以外的叫法）仍可能漏判；漏判只会多一行提示，不会编造证据。0.9.2 起每个零证据选项会先做一次定向检索（`<选项> <核心词>`）——它能补上「planner 没给这个 vendor 查询」的情况，但补不了「官网价目页在 JS/登录墙后面」：定向检索仍失败时，gap 会明确写「已定向检索 1 次仍未获证」，此时贴正文（`text` 参数）或贴 URL 仍是最快的补救。
- 输入框只能显示/复制设置路径，不能就地切档（bundle 插件无 host 写通道；要做得改 Dynamic Cordis，见 README「设置页」）。

## 下次接着做

- 日常自检：怀疑「检索变差」时先跑 `node scripts/retrieval-check.mjs --question "…"`，看 `docPage/repoCode` 拆分与四数，别先跑完整研究（0.8.0）；`queries:` 行的「官方定向」是否为 0 是 0.8.1 的专项信号；价格题（0.8.3）看前 10 条 URL 是否全在厂商价目页、有没有混进 `docs.spring.io` / `docs.langchain4j.dev`。
- **P1 剩余**：① `text` 参数的 UI 入口（粘贴资料直接进证据，host 半已支持，缺 client 入口）；② 证据排序量化（把 `docPage 10 / repoCode 0` 之类的采用档位做成回归断言，而不只看一眼）。
- **远端仓库设置（需手工，脚本做不了）**：仓库描述、topics（`dsh` `dsh-plugin` `research` `deepseek`）、`main` 分支保护（要求 CI 通过）、0.9.0 / 0.9.1 / 0.9.2 的 GitHub Release（可直接引用 `CHANGELOG.md` 对应段落）；0.9.2 的 tag `v0.9.2` 与 `--follow-tags` 推送尚未执行。
- 可在网页上给首个 Release 附截图（`docs/screenshots/`）。
- 运行手册与细节：`D:\Total\docs\superpowers\specs\2026-11-15-regression-0.6.md`、`2026-11-15-p5-research-hardening.md`、`2026-11-15-cross-domain-scan.md`。