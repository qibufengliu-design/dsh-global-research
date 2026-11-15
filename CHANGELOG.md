# Changelog

本文件记录本项目的所有重要变更。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本 2.0.0](https://semver.org/lang/zh-CN/)。

## [Unreleased]

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
