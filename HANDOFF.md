# 交接：全球深度研究插件（2026-11-15 自主迭代结束）

## 一句话状态

插件可日常使用（P0–P8 + 0.6.x + 0.7.0 + 0.7.1 + 0.8.0 + 0.8.1 + 0.8.2 + 0.8.3 + 0.9.0 + 0.9.1 + 0.9.2 + 0.9.3 + 0.9.4 + 0.9.5 + 0.9.6 + 0.9.7 + 0.9.8 + 0.9.9 全部完成），**0.9.9 及以前全部已推送到 GitHub**（2026-11-16 00:22 核实：`refs/heads/main` = `199d563`，tag `v0.9.0`–`v0.9.9` 都在远端；除 `v0.9.2` 是历史遗留的轻量 tag 外均为 annotated；`v0.9.9` 由发布守门在 2026-11-16 00:22 打出，指向 `199d563`，Release run 5 自动建页 id 446190444，正文 1886 字已用 `verify-release` 核对）。GitHub Actions 已实测全绿：CI 在 Node 20/22/24 三套矩阵 + `windows smoke (node 22)` 上跑完 19 个测试文件（共 394 例）+ 全量语法检查 + 整洁性/发布一致性检查；Release workflow 已自动生成 `v0.9.5`–`v0.9.9` 五个 Release 页，加上补建的 `v0.9.0`–`v0.9.4`，**十版 Release 页齐全**，正文由 `node scripts/verify-release.mjs vX.Y.Z` 与 tag 上的 CHANGELOG 逐字核对过。**GitHub 仓库设置也已在 2026-11-15 23:12 通过 API 一次性配好**：描述与 7 个 topics、关闭 Wiki/Projects/Discussions、`main` 分支保护（必需状态检查 `test (node 20/22/24)` 与 `docs & metadata`、CODEOWNERS review、禁强推禁删分支，但不强制管理员，因此本机仍可直接 push main）、`v0.9.0`–`v0.9.4` 的 Release 已补建（六版 Release 页齐全）；Dependabot 的两个历史 PR 已是关闭状态。0.8.0 起有 `scripts/retrieval-check.mjs`：不跑完整研究、不花 LLM，就能验证「检索与选页」有没有退化；0.8.1–0.8.3 用它抓到并修掉了四处真实回归（compare 选项名带中文谓词、planner 不产出官方定向查询、不传 mode 时选型题落到 concept、价格题被 Java 文档通道劫持）。0.9.0 是「答案层」：简报首行一句话结论（带 `[S#]`/`（推断）`）、新增「## 行动清单」、方案对比裸数字兜底标 `（无来源）`。0.9.1 是**仓库规整 + 两处真实回归修复**：更新日志拆到 `CHANGELOG.md`，README 收敛为快速上手 + 索引，新增 `docs/` 四页与 `.github/`（CI / Issue 表单 / PR 模板 / Dependabot）及社区文件；同时修掉「8 条官方文档页覆盖三个手册段却判 low」（广度改按文档段计，跨源确认仍按站点计）与「对比题选项被冒号引导语/中文谓词切碎、表格全被误判无证据」（重写 `compareOptions()` 与 `countOptionHits()`）。0.9.2 是**零证据选项的定向回补**：对比题里一条可用证据都没有的选项，报告前各做一次定向检索（`<选项> <核心词>`，pricing 用 `价格 OR pricing`，最多 3 项 / 3 页），能补就删掉该 gap 并把页面放进参考，补不上才写「零证据」并注明「（已定向检索 1 次仍未获证）」。0.9.3 是**研究材料的 UI 入口**：`text` 此前只有模型传参一条路，现在设置页有「研究材料」粘贴区（配置键 `material`，≤20000 字），保存后每次 `research` 调用自动把原文当最高优先级证据、简报末尾标来源，显式 `text` 仍优先；输入框多一枚「材料 N 字」胶囊。0.9.4 还修了 0.9.2 的一处真实回归：对比题的定向回补被常规选页吃满预算后静默跳过，现在会预留最多 2 页，并把「为什么没跑」写进「未解决」与流程行（不再假装做过）。0.9.5 做了两件事：① **证据抽取并行化**（批并发 2、单批失败回落 `heuristicEvidence`）并把墙钟预算上调到 quick 120s / standard 240s / deep 360s——起因是一次 standard 价格题真实运行里「证据 86s、定向回补因剩余时间不足没跑」；② **第二批仓库规整**：新增 Release workflow（打 tag 自动按 CHANGELOG 建 Release）、`scripts/check-docs.mjs`（必需文件 / 相对链接 / CHANGELOG 版本条目 / 零依赖，已接进 CI）、`scripts/release-notes.mjs`、`.github/CODEOWNERS`，CI 的 Actions 升到 `checkout@v7`/`setup-node@v7` 且语法检查覆盖全部 `.js`/`.mjs`，Dependabot 把 Actions 更新聚成一个 PR。0.9.6 是**比价表完整性 + 定向回补打准**：`checkCompareRows()` 逐个候选校验是否独立成行（被并格补 `> 注意：…`、独立成行但价格未核实补 `（无来源）`，写 `stats.compareRowsComplete`），价格/对比题的定向 query 改成 `site:<厂商价目主机> <选项> 价格 tokens 百万`并把厂商页排到证据批最前，`validateCitations()` 对回补页放宽（未被引用也保留最多 2 条并标「已检索，未被采用」）。0.9.7 是**文案与表格对齐 + 价目页按 URL 直取**：零证据 gap 的措辞改由 `buildResult()` 按「该选项在对比表里是否已有独立行」决定——有行且是价目表写「在对比表中占位，但价格未取得（零证据）」、有行但不是价目表写「在对比表中占位，但未取得可用证据（零证据）」、没有行才保留「未纳入对比」；价格题定向回补先按 `PRICING_SEEDS` 用 `config.__fetchPage` 直取厂商价目页（正文含 `元|￥|$|/百万|1M|1000 tokens` 才算命中），抓不到才退回 `site:` 搜索，每个选项最多 1 次直取 + 1 次搜索，同一 URL（含本轮已失败过的）不重复计页预算。测试 372 例（19 个文件）。

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
- 0.9.3 研究材料粘贴区（`text` 的 UI 入口）：`lib/config.js` 新增 `material` 默认值 + `MATERIAL_MAX_CHARS = 20000` + `asMaterial()`（非字符串回落、trim、超限截断并 warning）；`lib/schema.js` 加 `material` 字段；`index.js` 区分 `textSource === 'argument' | 'material'`（显式 `text` 优先），材料来源时简报尾部写「材料来源：设置页的「研究材料」（N 字）」；`client.js` 设置页 `ConfigPanel` 加「研究材料」`textarea` + 「保存材料」/「清空」+ summary 显示材料字数，`makeComposerControl` 加「材料 N 字」胶囊；`test/{config,card,wiring}.test.js` +7（337 → 344），`createHooks()` 补 `runEffects()`；hash 在此文件改写后生成，未回填
- 0.9.4 定向回补预留页位 + 跳过标注：`lib/pipeline.js` 的 Step 4 选页在 `isCompareRun()` 且 `compareOptions()` ≥2 项时预留最多 2 页（`targetedRefillReserve = min(2, max(0, pageBudget - usedPrimaryPages - reserve - refillReserve - 1))`，与官方文档 `refillReserve` 叠加、至少留 1 个常规搜索位），`wantedSearch` 与 Step 5b 官方链接余量都扣掉它，`gapRefill()` 新增 `reservePages` 参数（gap 轮不能吃这份预留）；`targetedOptionRefill()` 在任何守卫之前先建报告（`optionsTried` = 进入回补的零证据选项数），预算/墙钟守卫分别写 `skipped: 'budget' | 'time'`，跑了才把 `optionsTried` 收敛成实际发出 query 的数；compare 的 gap 分三支（`已定向检索 1 次仍未获证` / `页预算耗尽，未做定向检索` / `剩余时间不足，未做定向检索`），`lib/brief.js` 的 `targetedRefillSuffix` 与 `index.js` 的 debugStats 行同步写「定向回补跳过（预算不足/时间不足）」；`stats.targetedRefill` 增 `skipped`/`triedOptions`/`resolvedOptions`；`test/pipeline.test.js` +1、改写 1（345 例）；hash 在此文件改写后生成，未回填
- 0.9.5 证据抽取并行化 + 墙钟预算 + 第二批仓库规整：`lib/pipeline.js` 新增 `EVIDENCE_CONCURRENCY = 2` 与 `extractEvidenceInBatches()`（单批失败回落 `heuristicEvidence`，`extractEvidence(..., { tally })` 记账）；`DEPTH_PROFILES.wallMs` quick/standard/deep = 120000/240000/360000，`index.js` 工具超时下限随 deep 到 380s；仓库侧新增 `.github/workflows/release.yml`、`scripts/check-docs.mjs`、`scripts/release-notes.mjs`、`.github/CODEOWNERS`、`test/repo-hygiene.test.js`，`ci.yml` 升 v7 并全量语法检查，Dependabot 聚组；提交 `c9ddf22`，annotated tag `v0.9.5`
- `2aa5d12` fix(ci)：Release workflow 的补建路径（`workflow_dispatch` 补 v0.9.0–v0.9.4 时检出 main、只校验 tag 存在与 CHANGELOG 小节；旧 tag 树里没有 `scripts/release-notes.mjs`，原写法必然失败）
- `d2d0322` docs(repo)：`docs/release.md` 第 12 步写清补建路径，`CHANGELOG.md` 的 `[Unreleased]` 记录该修复；`dc040ff` 为 0.9.5 的文档同步提交
- 0.9.6 比价表完整性 + 定向回补打准：`lib/brief.js` 新增 `checkCompareRows()`（每候选独立成行校验 + `（无来源）` 标注 + `> 注意：…` 提示 + `stats.compareRowsComplete`），`validateCitations()` 新增第三参 `{ refillUrls, maxKept }` 保留最多 2 条未采用的回补页并标 `（已检索，未被采用）`；`lib/pipeline.js` 新增 `PRICING_HOSTS`/`pricingHostFor()`/`pricingTargetQueries()`/`pricingHostOfUrl()`/`isPricingEvidencePage()`/`isPricingScenario()`，`targetedOptionRefill()` 改用 `site:<厂商价目主机> <选项> 价格 tokens 百万` 并把厂商价目页排到证据批最前；`lib/prompts.js` 的 compare 模式加「每候选独立一行、禁止并格、缺价写 `未核实（无来源）` 并保留该行」；测试 360 例（19 个文件，+8）；hash 在此文件改写后生成，未回填
- 0.9.7 零证据文案跟随对比表 + 价目页直取：`lib/brief.js` 新增 `ZERO_EVIDENCE_ROW_TEXT`/`ZERO_EVIDENCE_ROW_GENERIC_TEXT`，`zeroEvidenceGapText(option, { hasRow, priceTable })` 三态（有行价目表 / 有行非价目表 / 无行），`checkCompareRows()` 的 sink 增 `owned`/`priceTable`（表体含 `元|百万|tokens|price` 等即认作价目表，修掉 `输入价` 列名不匹配 `PRICE_COLUMN` 的漏判），`buildResult()` 用 `sink.owned` 重写简报与 `gaps` 里已写入的 zero-evidence 行（保留「已定向检索 1 次仍未获证」等后缀）；`lib/pipeline.js` 新增 `PRICING_SEEDS`（`{pattern,url}` 映射，与 `lib/strategies.js` 里同名 URL 列表是两件事，注释已写明）/`pricingSeedFor()`/`hasPricingSeedText()`，`targetedOptionRefill()` 在 pricing 场景先直取厂商价目页、失败回落搜索，`sourceFailures`/`officialFetchFailures` 里已失败的 URL 不再重抓（省 1 页预算 + 最多 15s 超时）；测试 372 例（19 个文件，+4）；hash 在此文件改写后生成，未回填
- 0.9.8 价目行证据（`pricing`）：根因是 0.9.7 抓到的豆包官方价目页进了参考却零证据——价格在表格里，`heuristicEvidence()` 的段落门槛（120 字／官方页 60 字）把几十字的表格行整段丢掉，而 `htmlToText()` 又把 `</tr>` 拍成一个换行、`<td>` 拍成一个空格。现在 `heuristicEvidence()` 返回数组：先进老规则的长段落，再按行补价目行（`isPricingEvidencePage(page)` 或 `page.via === 'seed'` 才扫，行内需含 token 单价，每行截 120 字、每页最多 8 条、`type: 'pricing'`，`quote` 是原始行）。价目行会断言成 `claim`（`doubao-pro-32k 输入 0.0008 元/千 tokens，输出 0.002 元/千 tokens`，单位按页面原样保留、不二次换算），只有带 token 单位或紧跟 `输入`/`输出`/`缓存命中` 的价才进 claim，`199 元/月` 这类套餐价进不去；`groupEvidence()` 对 `pricing` 只在 claim 完全相同时合并（否则一页所有型号会被相似度并成一行）；`optionMatches()` 对 `pricing` 把页面标题纳入匹配（行里是型号 `doubao-pro-32k`，选项是 `豆包`），价目页直取命中的页现在标 `via: 'seed'`（抓取器原来只会写 `web`/`jina`/`raw`）。测试 `test/pipeline.test.js` 83 → 90（+7）；hash 在此文件改写后生成，未回填
- 发布守门批次（`e29db51`/`feb701a`/`796d712`）：`check-docs` 增加 Issue 表单结构校验（坏模板 GitHub 只是静默不显示）、`check-release` 增加「CHANGELOG 小节非空且不重复」（空正文会让 Release 页空白）、Release workflow 增加「tag 指向的提交必须是 `main` 祖先」的校验；2026-11-15 23:36 补打 annotated `v0.9.6`（`796d712`）与 `v0.9.7`（`9205223`），两个 Release 页由 workflow 自动生成
- 发布守门批次二（`8db1bfe`/`faf5b4b`/`59a9a77`/`333aafc`）：CI 加 `windows smoke (node 22)`、`.gitignore` 忽略 `tmp-*`/`probe-*.mjs`/`.tmp/`；`check-docs` 增加「README 参数表 ↔ 工具 `parameters` 一致」「`json` 示例可解析」「文档里的脚本命令真实存在」三项；新增 `scripts/verify-release.mjs` 核对 Release 正文与 tag 上的 CHANGELOG；2026-11-15 23:56 发布守门补打 annotated `v0.9.8`（`faf5b4b`），Release 页自动生成（id 446175002），正文与 tag 上的 CHANGELOG 逐字一致
- 文档入口：`README.md`（用法）→ `docs/architecture.md`（管线与通道）→ `docs/configuration.md`（全部配置）→ `docs/development.md`（测试与调试）→ `docs/release.md`（发布清单）
- 仓库规整审计记录：`D:\Total\docs\superpowers\specs\2026-11-15-repo-hygiene-audit.md`（改前状态、改了什么、验证证据、只能手工的 5 项、每版固定动作）
- 测试：19 个文件逐个跑，**全部通过**（0.9.8，`node scripts/test-all.mjs`，或 `node test/<file>.test.js` 让 node:test 在进程内跑；`node --test test/` 与 `node --test test/<file>` 在沙箱都会 EPERM；具体以脚本输出为准，本版 `test/pipeline.test.js` 一个文件 83 → 90）

## 仓库规整（0.9.5 第二批，维护者视角）

目标是把仓库维持在「企业级开源项目」的形态：结构固定、链接不断、版本与 tag 对齐、发版自动化。

- **CI**（`.github/workflows/ci.yml`）：Node 20/22/24 矩阵跑零依赖校验 + **全部 `.js`/`.mjs` 的 `node --check`** + `node scripts/test-all.mjs`；`docs` job 跑 `node scripts/check-docs.mjs` + `node scripts/check-release.mjs`；另有 `windows smoke (node 22)` job（插件跑在 Windows 桌面端，路径/换行差异在这里兜底，目前是观察项、未加入分支保护的必需检查）。2026-11-15 实测：run #9（`dc040ff`）与 run #10（`2aa5d12`）四个 job 全部 `success`，Linux 上 352 例测试同样全绿（本机沙箱里 `node --test test/` 会 EPERM，属沙箱限制，不是代码问题）。
- **安全扫描**（`.github/workflows/codeql.yml`，2026-11-16 加）：CodeQL 扫 `javascript-typescript`，用 `security-extended` 查询集，push/PR/每周一 03:00 UTC 各跑一次；这个插件会抓任意网页再拼进提示词，注入/正则/路径类问题值得多查一轮。结果在仓库 **Security → Code scanning**。
- **整洁性检查**（`scripts/check-docs.mjs`，共十项）：必需文件齐不齐、README/docs/CONTRIBUTING/SECURITY/HANDOFF 的相对链接能不能解析、CHANGELOG 有没有 `[Unreleased]` 与当前版本条目、`package.json` 元数据是否完整且零依赖、Issue 表单（`.github/ISSUE_TEMPLATE/*.yml`）的必填键与 body 类型是否合法（写坏了 GitHub 会静默不显示模板）、README 参数表与 `index.js` 里 research 工具的 `parameters` 是否一致（新参数没写进 README 就是文档漂移）、Markdown 里标成 `json` 的示例能不能解析、文档里写到的 `node scripts/*.mjs` 与 `npm run <script>` 是否真实存在（脚本改名后文档忘了跟，用户照着跑就报错）、仓库里有没有真密钥或本机绝对路径（扫仓库里的文本文件，找 `ghp_`/`github_pat_`/`sk-`/`AKIA`/私有密钥块与 `C:\Users\`/`D:\Total\` 这类盘符路径；`HANDOFF.md` 是给本机下一位维护者的交接笔记，唯一豁免）、`docs/` 下每篇文档是不是都能从 README 的文档索引链到（新写一页却没人能发现，等于没写）。改完文档先跑它。
- **发布一致性检查**（`scripts/check-release.mjs`，2026-11-15 23:14 加）：`package.json` 版本是 x.y.z 且 CHANGELOG 有对应小节、小节从新到旧排列、没有重复或空小节（空小节会导致发 Release 时正文为空）、README 预算表与 `lib/pipeline.js` 的 `DEPTH_PROFILES` 逐字段一致、README/docs/CONTRIBUTING 里没有写死的测试例数；当前版本还没打 tag 时只给提示不判失败。已接进 CI 的 `docs & metadata` job，发布清单第 2 步与 `CONTRIBUTING.md` 也同步写了。
- **Release 自动化**（`.github/workflows/release.yml`）：推 `v*` tag 时用 `CHANGELOG.md` 里该版本的段落建 GitHub Release，发布前校验 tag 与 `package.json.version` 一致，已存在的 Release 不覆盖；历史 tag 可在 Actions 里用 `workflow_dispatch` 补建（填 tag 名即可，不重打 tag；补建路径检出 main，只校验 tag 存在与 CHANGELOG 小节）。`v0.9.5` 已由该 workflow 自动建成。
- **发布说明抽取**（`scripts/release-notes.mjs`）：`node scripts/release-notes.mjs 0.9.5` 打印该版本 CHANGELOG 段落，Release workflow 与单测共用。
- **Release 正文核对**（`scripts/verify-release.mjs`，2026-11-16 00:03 加）：`node scripts/verify-release.mjs v0.9.8` 拉 Release 页与该 **tag 提交上**的 `CHANGELOG.md` 比对正文（不拿工作区比——工作区常有下一版改动会误报）；Release 不存在或正文不一致都非零退出。`docs/release.md` 发布清单第 13 步已写。
- **Dependabot**：Actions 按周、聚成一个 PR（`open-pull-requests-limit: 3`）；npm 月度只用于捕获误引入的依赖。
- **CODEOWNERS**：`* @qibufengliu-design`，配合网页上的一次性分支保护设置。
- **规则文档**：`docs/release.md`（只打 annotated tag、已推送 tag 不移动、不写死测试数、提交身份、Actions 版本策略）与 `CONTRIBUTING.md`（PR 检查表加了 `check-docs`、tag 规则）。

## 推送

沙箱内 `git push` 需要 `sandbox_permissions: danger-full-access`（普通沙箱里 git 的凭据脚本会 `couldn't create signal pipe`）。做法：

```powershell
cd D:\Total\dsh-global-research
git -c http.sslBackend=openssl push origin main --follow-tags
git -c http.sslBackend=openssl ls-remote origin HEAD refs/heads/main refs/tags/*   # 核对远端
```

凭据管理器（GCM）会弹出一次授权；若用 PAT，则 `https://qibufengliu-design:<PAT>@github.com/...`。

**0.9.1 起**每个版本都打 annotated tag `vX.Y.Z`（与 `package.json.version` 一致）并 `--follow-tags` 推送；`git ls-remote` 的 `refs/heads/main` 必须等于本地 `HEAD` 才算推送完成。

**改不了的部分**：本机没装 `gh`、也没有 `GITHUB_TOKEN`/`GH_TOKEN`，所以远端仓库设置（描述、topics、分支保护、Wiki 开关、关闭历史 Dependabot PR）只能手工在网页上做，无法脚本化。Release 不在此列：0.9.5 起由 `.github/workflows/release.yml` 用 Actions 自带的 `GITHUB_TOKEN` 创建。

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

17. **材料入口 + 定向回补不再静默跳过**（0.9.3）：① 材料入口——`text` 此前只能模型传参，现在设置页有「研究材料」粘贴区（配置键 `material`，≤20000 字，保存后每次 `research` 调用自动当最高优先级证据，简报标「材料来源」，显式 `text` 仍优先）；② 定向回补预留页位——0.9.2 的 B 题回归里，standard 档 12 页预算在常规选页就吃满，`targetedOptionRefill` 撞 `no page budget left` 直接 return，流程行没有「定向回补」段、「未解决」也没有「已定向检索」，等于静默失效。现在 Step 4 对 compare 题（`compareOptions()` ≥2 项）预留最多 2 页（与官方文档 `refillReserve` 叠加、至少留 1 个常规搜索位），`gapRefill` 也拿不到这份预留；回补无论跑没跑都会写 `stats.targetedRefill.skipped`（`budget`/`time`/`null`）与 `optionsTried`，gap 与流程行按「预算耗尽 / 时间不足 / 跑了仍没补上」三种说法分别写清。实测价格对比题 standard 档 `pagesFetched 11`（3 种子 + 7 常规 + 1 豆包定向页），豆包不再进「未解决」。

18. **证据抽取并行 + 预算放宽**（0.9.5）：standard 价格题的真实耗时是「拆题 26s / 检索 49s / 证据 86s / 合成 14s」，证据阶段成了瓶颈，且定向回补因「剩余时间不足」没跑。现在逐页证据抽取按 2 页一批并行（`EVIDENCE_CONCURRENCY = 2`，单批失败回落 `heuristicEvidence`，结果与串行一致、可复现），墙钟预算提到 quick 120s / standard 240s / deep 360s；`index.js` 的工具超时下限跟着 deep 到 380s，避免 deep 档被工具超时先杀掉。

19. **比价表完整性 + 定向回补打准**（0.9.6）：0.9.5 的真实 standard 价格题（148s）暴露两件事——回补报「解决 1」但豆包单价仍缺（`volcengine.com` 页读到又被引用校验剔掉），对比表把 `qwen` 和 `豆包 API` 并成一格。现在：① `checkCompareRows()` 逐个候选检查是否**独立成行**，被并格的候选在表后补 `> 注意：<候选> 未作为独立行出现（价格未取得），下表结论不含该候选。`，独立成行但价格是 `未核实/未知/—` 的补 `（无来源）`，结果写 `stats.compareRowsComplete`；② 价格/对比场景的定向 query 改为 `site:<厂商价目主机> <选项> 价格 tokens 百万`（`PRICING_HOSTS` 覆盖豆包/千问/DeepSeek/Kimi/GLM），命中厂商主机的页排进证据批最前；③ `validateCitations()` 对**回补页**放宽：未被引用时保留最多 2 条并在参考里标 `（已检索，未被采用）`（采用率仍只算被引用的）；④ compare 提示词写死「每候选独立一行、禁止并格、缺价写 `未核实（无来源）` 且保留该行」。

20. **零证据文案跟随表格 + 价目页直取**（0.9.7）：0.9.6 的真实 standard 价格题（87s/low）里，表格已经给豆包留了独立行（价格 `无证据`），「## 未解决」却仍写「未纳入对比」，同一份简报自相矛盾；同时定向回补抓到的两条 volcengine 页是 `article/…` 与 `ai.` 模型页，已知价目页 `https://www.volcengine.com/docs/82379/1099320` 从未被优先抓。现在：① 文案在 `buildResult()` 里定稿（表在那时才存在）——`checkCompareRows()` 把「已有独立行」的候选名写进 `sink.owned`，价目表看表体单位而不是列名，有行写「在对比表中占位，但价格未取得（零证据）」/非价目表写「…但未取得可用证据（零证据）」，无行才写「未纳入对比」，`gaps` 与简报同步改；② 价格题回补先按 `PRICING_SEEDS` 直取厂商价目页（`volcengine.com/docs/82379/1099320`、`help.aliyun.com/zh/model-studio/models`、`api-docs.deepseek.com/quick_start/pricing`、`platform.moonshot.cn`、`open.bigmodel.cn/pricing`），正文含价格单位才算命中，命中即跳过该选项的搜索；③ 同一 URL 不重复计预算（`state.pages`/`state.refillPages` 已含的跳过，本轮已失败过的 URL 也不再重抓）。

## 已知缺口（不是 bug，是数据/结构限制）

- 厂商 token 单价（如豆包）在官网 JS 渲染页后面，纯 HTTP 拿不到；`text` 参数可让用户贴正文直接进证据（0.6.0 新增）。
- 零证据判定是「选项核心 token 在 claim/证据文本里是否出现」（0.9.1 起：拉丁词边界 + 允许版本后缀，中文 ≥2 字子串），同义词（如 Haystack 写作 `haystack-ai`）与更长的中文别名（如「豆包大模型」写作「豆包」以外的叫法）仍可能漏判；漏判只会多一行提示，不会编造证据。0.9.2 起每个零证据选项会先做一次定向检索（`<选项> <核心词>`）——它能补上「planner 没给这个 vendor 查询」的情况，但补不了「官网价目页在 JS/登录墙后面」：定向检索仍失败时，gap 会明确写「已定向检索 1 次仍未获证」，此时贴正文（`text` 参数）或贴 URL 仍是最快的补救。0.9.3 起 compare 题选页时会预留页位，回补真的有机会跑；万一预算或墙钟仍不允许，gap 会写清是「页预算耗尽，未做定向检索」还是「剩余时间不足，未做定向检索」，而不是假装查过。
- 价目页直取（0.9.7）本质是「一个 seed URL 换掉一次搜索」，代价是：`seed` 命中条件只要求正文含 `元|￥|$|/百万|1M|1000 tokens`，所以只讲计费口径、不给具体单价的文档也会命中并跳过该选项的搜索（原搜索可能找到别的页）；seed 改版成 404 时会白花 1 页预算（最多 15s 超时一次），但同一轮里 Step 2b 已经失败过的 seed 不会再抓（记在 `sourceFailures`/`officialFetchFailures`），所以不会反复拖慢；若厂商把价目页做成 JS 渲染，直取同样拿不到正文——`text` 参数仍是最快补救。
- 价目行证据（0.9.8）只能看见「拍平后仍带 token 单价」的行：`htmlToText()` 把每个 `<tr>` 拍成一行、每个 `<td>` 拍成一个空格，所以判定靠的是「金额 + 币种 + token 单位」这三个要素在行内同时出现（`\s*` 连接、`每|/|per` 分隔符可选），而不是依赖 `|`；若某厂商把单价单独放一列且单位写在表头（`模型 | 输入 | 输出` + 表头写 `元/千 tokens`），行内没有单位，仍然抽不到——这是刻意保守：宁可零证据，也不把「199 元/月」的套餐价写成 token 单价。英文页 `$0.5 per 1M input tokens` 可识别，但 `per token`（不带 1M/1K）不识别。
- composer 胶囊依赖宿主 settings 通道：可用时点「深度」直接切档（`auto → quick → standard → deep`）、点「研究」启停；宿主未暴露时回退成只读提示「深度：设置页」。长文本材料只能在设置页粘贴区编辑，输入框只显示「材料 N 字」并可复制设置路径。
- `checkCompareRows()`（0.9.6）只认「## 方案对比」下的第一张表、且要求有表头 + 分隔行：候选名必须出现在该行**第一列**（或转置表的表头列）才算「独立成行」，别名对不上（`deepseek-flash` vs 正文里的 `DeepSeek V3.2`）会误报「未作为独立行」；没有 `## 方案对比` 标题、没有分隔行、或名字只出现在备注列的表，既不提示也不进 `stats.compareRowsComplete` 判定（当作「没有可比价表」）。`无证据` 行不补 `（无来源）`（它已经说明了没有证据）。

## 下次接着做

- 日常自检：怀疑「检索变差」时先跑 `node scripts/retrieval-check.mjs --question "…"`，看 `docPage/repoCode` 拆分与四数，别先跑完整研究（0.8.0）；`queries:` 行的「官方定向」是否为 0 是 0.8.1 的专项信号；价格题（0.8.3）看前 10 条 URL 是否全在厂商价目页、有没有混进 `docs.spring.io` / `docs.langchain4j.dev`。
- **P1 剩余**：① ~~`text` 参数的 UI 入口~~ 已在 0.9.3 完成（设置页「研究材料」粘贴区 + composer 材料胶囊）；② 证据排序量化（把 `docPage 10 / repoCode 0` 之类的采用档位做成回归断言，而不只看一眼）。
- **0.9.8 剩余（真实网络复测）**：单测只证明了「价目行能抽成 `pricing` 证据、长段落不被顶掉、导航短行不误收、上限 8 条、套餐价不误判」五条路径，还没在真实网络上重跑那道豆包价格题。复测要看三件事：①参考里的 `https://www.volcengine.com/docs/82379/1099320` 是否真的贡献了 ≥1 条 claim（而不是只有页头）；②豆包行在「## 方案对比」里是否从 `无证据` 变成带具体单价；③`pricing` 证据引用的行是否仍是价目页原文（不是被拼接坏的行）。若火山把价目表换成「单位写在表头、单元格只有数字」的排法，行内就看不到 token 单位，会退回零证据——此时把该行原文贴进 `text` 参数仍是最快补救；若表里同时出现「总价/套餐价」，只有带 token 单位或紧跟 `输入`/`输出`/`缓存命中` 的价才会进 claim，其余只按原行保留。
- **0.9.6 计划（相关性闸门，已有 0.9.2/0.9.4 回归证据）**：A 题 adopted 10 条里仍有 4 条与问题无关的文档页（`spring-data-redis … ByteUtils`、`spring-integration 6.2.11/dsl`、`spring-framework 6.2/core/beans/java`、`spring-ai/docs/current/api`），B 题 10 条里 4 条是阿里云非价目页（`analyticdb-ray`、`qwq-deepseek-rag-app`、`qwen-code`、`llms.txt`）——档位（doc-page +4）压过了相关性。做法：`rankHits` 里加「问题 token 与标题+URL 路径」重合度的**相关性闸门**（低于阈值降档而不是直接丢），价格题额外要求路径含 `pricing|价格|定价|model`；目标是 A 的相关 docPage 增加、B 的非价目页掉出前 10，且既有断言不破。原型（`relevanceModel()` + `TIER_OFFTOPIC_WEIGHT`）在并发会话改写历史时被卷走又撤掉，草稿备份在仓库外的 `D:\Total\.tmp-gate-backup\`，重做时可直接取用。
- **0.9.5/0.9.6 剩余（定向回补的收尾从句）**：~~回补预留页位~~ 已在 0.9.4 完成（compare 题 Step 4 预留最多 2 页、`gapRefill` 不能吃这份预留，`stats.targetedRefill.skipped`/`optionsTried` 现在是回归信号——价格题 standard 档应当能看到 `skipped: null`；2026-11-15 真实网络复测 A 题 `targeted refill resolved: LangChain4j`，B 题回补已发出但 ddg-html 超时未获新证）。还剩：`compareOptions()` 没覆盖「谁更便宜 / 哪家更便宜」这类收尾从句，B 题会把 `谁更便宜` 当成第四个选项——补谓词表 + 单测，并顺带核对 0.9.4 的预留不会把常规页挤到「相关性闸门」修好之前更难选（预留只在 compare 题生效，非 compare 题预算不变）。
- **远端仓库设置（2026-11-15 23:12 已用 GitHub API 配好）**：
  - About：描述「DeepSeek Harness 插件：把开放问题做成带引用、可核查的研究简报（零依赖）」；topics `citations` `deepseek` `dsh-plugin` `nodejs` `rag` `research` `web-search`；homepage 留空。
  - 功能开关：Wiki / Projects / Discussions 全部关闭（文档走 `docs/`，问答走 Issues）。
  - `main` 分支保护：必需状态检查 `test (node 20)`、`test (node 22)`、`test (node 24)`、`docs & metadata`；Require review from Code Owners（`CODEOWNERS` = `* @qibufengliu-design`）；禁止 force push 与删除分支；**不勾「Include administrators」**——否则本机与自动化都无法直接 push `main`，这是有意的取舍。后来新增的 `windows smoke (node 22)` 还没加进必需检查（要改需网页上补一条或再用一次 API，当前没有 token）。
  - Release：`v0.9.0`–`v0.9.4` 已补建（正文取自各版 CHANGELOG），`v0.9.5`/`v0.9.6`/`v0.9.7` 由 workflow 在推 tag 时自动创建（2026-11-15 23:36，id 446132607 / 446161812 / 446161815），七个 Release 页齐全。
  - Dependabot 的 `#1`（setup-node 4→7）、`#2`（checkout 4→7）已是关闭状态，CI 里直接用了 v7。
  - tag 现状：`v0.9.0`–`v0.9.7` 均已推送，除 `v0.9.2`（历史遗留的轻量 tag，不重打，见 `CHANGELOG.md` 的 0.9.4 说明）外都是 annotated。`v0.9.6` 的 tag 是发布守门在 2026-11-15 23:36 补打的（指向 `796d712`，该提交的 `package.json` 正是 0.9.6）：0.9.6 发布时漏打 tag，代码与 CHANGELOG 本就在 main 上，补 tag 后 Release 页随之生成，无需重发版本。
  - 以后要改这些设置：有 token 时用 GitHub API（`PATCH /repos/…`、`PUT /repos/…/branches/main/protection`、`POST /repos/…/releases`），没有就网页手工；改动后把证据写回本节。
- 可在网页上给首个 Release 附截图（`docs/screenshots/`）。
- 运行手册与细节：`D:\Total\docs\superpowers\specs\2026-11-15-regression-0.6.md`、`2026-11-15-p5-research-hardening.md`、`2026-11-15-cross-domain-scan.md`。