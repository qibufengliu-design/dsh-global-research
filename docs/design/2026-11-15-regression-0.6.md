# 0.6.0 三问回归记录（2026-11-15）

## 方法

- 版本：0.6.0（commit `d5faf38`，sourcePlan 已合入、Top1/Top5 未做）
- 插件重载：`disable → enable include:global-research`，内存缓存清空，避免读到 0.5.x 旧结果
- 三个独立子代理各跑一次 `research`，depth=standard，**不传** `context` / `researchId`
- 记录：耗时、confidence、来源域名、官方域名命中、「存在冲突」段、统计行、结论可操作性

## 结果

| # | 问题 | 耗时 | confidence | 来源 | 官方域名命中 | 冲突段 | 四数行 |
|---|---|---|---|---|---|---|---|
| A | Java 后端 RAG 框架选型（Spring AI / LangChain4j / Haystack） | 140s | low | 6（全 github.com） | **0** | 无 | 无（0.6.1 才加） |
| B | DeepSeek / 通义 / 豆包 API 定价对比 | 104s | low | 9（github×5、火山×1、deepseek×1、千问×1、segmentfault×1） | 官方价目页 1、官方域 2 | 无 | 无 |
| C | 十几人团队该不该拆微服务 | 151s | medium | 7（github、arxiv、博客×5） | 0 | **有**（三种人数口径并存） | 无 |

## 发现

### 1. 官方页「读到了却没被采用」（A、B 都出现）

- A：`docs.spring.io` 被读取 3 页，最终 6 条来源全是 github.com；简报自述「另有 3 个页面未采用（github.com、docs.spring.io）」。
- B：`help.aliyun.com` 被读取但未采用，官方价目页只剩 deepseek 一条。
- 根因：`extractEvidence` 只在**整批模型返回为空**时才跑启发式兜底；模型从别的页返回 ≥1 条后，没被抽到的页永不兜底。官方文档页段落短，最容易漏。

**修复（0.6.2, `bfcb27b`）**：逐页兜底（对任何没产出证据的页跑 `heuristicEvidence`）+ 官方/声明通道页阈值 120→60 字 + `官方采用 x/y` 进四数行。261 测试全绿。

### 2. pricing / official-docs 通道「声明了没接线」

- B：`bigmodel.cn` 0 命中，阿里官方价目页未进参考，豆包只有文章页。
- `OFFICIAL_DOMAINS` 不含 `docs.spring.io` / `help.aliyun.com` / `bigmodel.cn` / `volcengine.com` / `platform.qianwenai.com`，厂商官方页永远算不出「官方」。

**修复（0.6.3，进行中）**：扩充官方域名表；`pricing` 通道接 `seeds` 直取、`official-docs` 接 `bases` 多根 sitemap；价格表强制「币种/单位」列。

### 3. 币种混用未标注（B）

DeepSeek 以美元标价（$0.15/$0.3），阿里/豆包以人民币（0.3/0.6、6/30 元），合成时没有强制币种列，导致无法横向比较。

**修复（0.6.3）**：`synthPrompt` 硬规则 + 断言层把「单位不可换算」归「口径差异」。

### 4. 冲突段触发不均（A/B 无、C 有）

C 里出现三种人数口径（百人规模 / 超 10 人 / 5–50 人），说明断言冲突在「同一属性多值」时有效；A/B 的差异更多是**实体/币种不同**，属于「口径差异」，0.6.1 三分法正是为此而加。

### 5. 官方来源缺失（A 最严重）

Java 生态选型完全依赖 GitHub 社区仓库，`langchain4j.dev` / `spring.io` 未进参考。0.6.2 + 0.6.3 两轮修复后需复测同一问题。

## 0.6.3 复测（同日 18:50，插件重载后）

| # | 问题 | 耗时 | confidence | 来源 | 官方采用 | 冲突三分法 |
|---|---|---|---|---|---|---|
| A | RAG 选型 | 125s | medium | 5（docs.spring.io、docs.langchain4j.dev、github×3） | **2/5** | 无（Haystack 零证据） |
| B | 三家定价 | 157s | medium | 5（deepseek×2、aliyun×1、volcengine×2） | **5/8** | 有：口径差异（空）、来源自相矛盾（输出价 4 元 vs 8 元，同页） |

四数行原文：

- A：`> 检索流程：识别 133 篇 · 去重后 117 篇 · 可读 12 篇 · 采用 5 篇 · 官方采用 2/5`
- B：`> 检索流程：识别 132 篇 · 去重后 108 篇 · 可读 10 篇 · 采用 5 篇 · 官方采用 5/8`

结论：

- 官方页「读到了却没被采用」已修复（A 从 0 → 2 条官方；B 从 1 → 5 条官方域，其中 2 条是真正的价目页）。
- 四数行 + 官方采用率按预期出现，且数字自洽（识别 132 → 去重 108 → 可读 10 → 采用 5）。
- 价格题仍不可横向比较：豆包缺 token 单价、DeepSeek 分空闲/高峰两档，属证据缺口而非结构问题；「币种/单位」现写在列头括号内（可接受，未强制独立列）。
- A 的 Haystack 零证据，说明对比型问题仍可能缺一列，但简报已诚实写「无法判断」。

## 0.6.4 复测（同日 19:00）

- A（RAG 选型，standard/compare）：147s / medium / 采用 8 条（github×6、docs.spring.io×1、docs.langchain4j.dev×1）；`官方采用 2/3`；参考中**没有** spring.io 旧博客，但 `[S1]` 是自称「本项目已过期，不再维护」的 GitHub 仓库。
- 四数行：`识别 130 篇 · 去重后 120 篇 · 可读 12 篇 · 采用 8 篇 · 官方采用 2/3`。
- 判断：官方占比（工具口径）2/3 优于 0.6.3 的 2/5，但按 8 条采用来源算官方仍只有 2/8；sitemap 抓回的 spring.io 博客未被采用，说明**路径偏好缺失 + 过期源无降权**是下一个明确短板。

**0.6.5 计划**：`looksStale()` 过期源降权、sitemap 路径先验（`/reference/`、`/docs/` 加分，`/blog/` 减分）、`lastmod` 太旧降权。

## 0.6.5 复测（同日 19:08）

- A（RAG 选型，standard/compare）：141s / medium / 12 页读取、10 条采用（github 7、docs.spring.io 1、docs.langchain4j.dev 1、learn.microsoft.com 1）。
- 四数行：`识别 133 篇 · 去重后 118 篇 · 可读 12 篇 · 采用 10 篇 · 官方采用 3/4`。
- 好的一面：`[S1]` 从"过期仓库"变成 `docs.spring.io/spring-ai/reference/` 官方文档；官方采用 3/4 > 0.6.4 的 2/3。
- 坏的一面：`[S5]` 是自称"本项目已过期，不再维护"的 `zhouByte-hub/java-ai`，仍被用来支撑「Spring AI 由官方维护」的论据——0.6.5 只降了排序，没有拦住"过期源当证据"。
- 结论：**0.6.6 需做"过期源不得充当论据"**（stale 页不产出证据、参考行标注、不计入置信度门槛）。

## 0.6.6 复测（同日 19:20）

- A（RAG 选型，standard/compare）：144s / medium / 10 页、7 条采用（github 6、help.aliyun.com 1）。
- 四数行：`识别 129 篇 · 去重后 108 篇 · 可读 10 篇 · 采用 7 篇 · 官方采用 1/3`。
- 过期仓库（zhouByte-hub/java-ai 一类）**已不在参考列表**；没有 `（已过期，仅作参考）` 行 = 它被直接剔除而不是标注；「未解决」也无过期提示。
- 结论：**"过期源当论据"已修好**。剩余问题不是脏源，而是**来源结构**：github 6/7 占比高、官方只有 1 篇——dev 类问题里通用引擎把 GitHub 文件排得很高，官方 docs sitemap 在 Java 生态缺失（docs.spring.io 三候选全 404，spring.io sitemap 只有 /guides/）。
- 判定：0.6.6 可作为本轮的收尾版本；来源结构改进需要"官方文档站索引/搜索"级别的通道，不是再调权重能解决的，留待下一轮。

## 0.6.6 三问复测（同日 19:22–19:26，全部 fresh cache）

| 问题 | 档位/模式 | 耗时 | 置信度 | 采用来源 | 官方采用 | 关键观察 |
|---|---|---|---|---|---|---|
| B 国内大模型价格 | standard/compare | 152s | low | 6（官方 5、github 1） | **5/7** | 每个单价都带 [S#]、有「价格（币种/单位）」列、"不得跨行比较"；检出**来源自相矛盾 2 条**（deepseek 同页 0.66 vs 1.98 美元）；Kimi 零证据、币种不折算 → 只够"单价快照"，不足以下"谁最便宜" |
| C 8 人团队要不要拆微服务 | standard/explain | 108s | medium | 6（github 4、daily.dev 1、腾讯云 1） | 0/3 | 结论"先做 Spring Modulith 模块化单体"站得住；有「下一步建议」+ 可执行判据（10 万行 / 部署 >30 分钟阈值）；无冲突段；未解决 4 条都具体（代码行数、部署频率、Boot 4.0.x、是否已占 CPU） |
| A RAG 选型 | standard/compare | 144s | medium | 7（github 6、help.aliyun 1） | 1/3 | 过期仓库已剔除；但官方文档仍只有 1 条 |

**结论**：0.6.6 的"脏源清理"三问都成立（过期仓库不进参考、价格带引用与币种、微服务建议不越界）。剩余短板集中在**来源结构**：dev 类问题官方文档占比低（Java 生态无可用 sitemap），价格类问题受厂商页面不一致与 JS 渲染限制（结构对了，数据仍缺）。这两项需要"官方文档站索引/搜索"与"厂商结构化价格 API"级通道，留待下一轮。

## 0.6.8 复测（同日 19:45）

- A（RAG 选型，standard/compare）：148s / medium / 12 页读取、8 条采用（github 5、docs.spring.io 2、docs.langchain4j.dev 1）。
- 四数行：`识别 136 篇 · 去重后 99 篇 · 可读 12 篇 · 采用 8 篇 · 官方采用 3/6`。
- **首次出现真实 API 参考页**：`docs.spring.io/spring-ai/reference/api/etl-pipeline.html`（S8）；S7/S4 仍是站点根。
- 无过期仓库、无 `（已过期，仅作参考）`。
- 结论：官方从 1/3 → **3/6**（候选翻倍、分子 ×3），但 8 条里 github 仍占 5 条。ROOT+base 相对 sitemap（0.6.7）与按题选 base / 跨主机改写（0.6.8）这两步是有效的，但**只提升到"官方文档能进候选并被采用"**，尚未把 github 压下去——这是下一轮真正的题目（需要在证据排序层给"具体 API 页 vs 仓库源码"更细的权重，而不是再加通道）。

## 复测计划

1. 0.6.3 合并后重载插件；
2. 用**同三问**再跑一次（A 用 `mode=compare`、B 用 `mode=compare`）；
3. 检查指标：官方域名命中数、`官方采用 x/y`、四数行是否出现、「口径差异」是否出现、耗时是否 ≤ 上次 +20%；
4. 回归记录追加到本文档，并在 README 更新能力说明。

## 备注

- 三问的耗时 104–151s 均在 standard 180s 墙钟内，无超时/降级。
- C 的简报已可拿去和团队讨论（判据可核对），A/B 仍是 low，不适合直接决策——这与「一手来源缺失」直接相关。

## 0.9.1 复测（2026-11-15 21:55，`e40972d`，retrieval-check 真实网络）

方法：`node scripts/retrieval-check.mjs --question "…" --depth standard`（真实引擎 + 真实抓页器，LLM 用假模型，所以只衡量检索与选页，不含合成质量）。tavily key 来自桌面 profile patch，ddg-html 首次 `EAGAIN`/超时。

| # | 问题 | 耗时 | identified→deduped→readable→adopted | 采用档位 | 官方定向查询 | 结果 |
|---|---|---|---|---|---|---|
| A | Java 后端 RAG 选型（Spring AI / LangChain4j / Haystack） | 54.6s | 65 → 41 → 12 → 10 | docPage **9** · repoCode 0 · other 1 | 2 | PASS |
| B | 国内大模型 API 价格对比（qwen / 豆包 / deepseek） | 55.5s | 64 → 50 → 12 → 10 | docPage **10** · repoCode 0 · other 0 | 2 | PASS |

A 前 10 条采用来源：`docs.spring.io/spring-ai/reference/{index,concepts,1.1/api/vectordbs/apache-cassandra}.html`、`docs.spring.io/spring-data-redis/reference/.../ByteUtils.html`、`docs.spring.io/spring-ai/docs/current/api`、`docs.spring.io/spring-integration/reference/6.2.11/dsl.html`、`docs.spring.io/spring-framework/reference/6.2/core/beans/java.html`、`docs.langchain4j.dev/tutorials/{rag,spring-boot-integration}`、`github.com/agentscope-ai/agentscope-java/issues/2110`（other）。

B 前 10 条：`api-docs.deepseek.com/quick_start/pricing`（含 zh-cn 版）、`help.aliyun.com/zh/model-studio/{models,model-pricing}`、`www.volcengine.com/docs/82379/1099320`、`help.aliyun.com/en/model-studio/{llms.txt,deepseek-api,qwen-code}`、`help.aliyun.com/en/analyticdb/analyticdb-for-mysql/create-an-inference-service-based-on-analyticdb-ray`、`help.aliyun.com/en/mobi/qwq-deepseek-rag-app`。

### 结论

1. **用户第 1 条要求（具体 API/参考页优先于仓库源码）已达成**：0.6.x 时 A 题「8 条采用 5 条是 github」、官方 3/6；0.9.1 是 **docPage 9–10 / repoCode 0**，A 题只余 1 条 github issue。0.7.0 的 `sourceTier` 档位 + doc-page 槽位 + 0.9.1 的 `evidenceSiteKey` 广度修正是有效的。
2. **暴露出新的副作用：档位压制了相关性**。A 的 9 条 doc-page 里有 4 条与问题无关（`spring-data-redis` 的 `ByteUtils` API 页、`spring-integration` DSL、`spring-framework` beans、`spring-ai/docs/current/api` 索引页）；B 的 10 条里有 4 条是阿里云非价目产品页（AnalyticDB Ray、qwq-deepseek-rag-app、qwen-code、llms.txt）。这正是「只按站点档位排序、不看页面与问题是否同题」的代价：档位把 `docs.spring.io` 全站当成高价值候选，于是同厂商的**任意** API 页都能挤掉更贴题的二手页。
3. **A 的 Haystack 仍零证据**（`zero-evidence options: Haystack`），与 0.7.1 的行为一致：只在表里写「无证据」，不编造。B 的「豆包」同样零证据（厂商价目页未命中/未抓取）。
4. **抓取层健康**：12/12 可读，无 PDF/403/JS 壳失败；ddg-html 6 次超时全部被 tavily 兜住（`engineErrors 6`），不影响 `adopted`。`targeted refill skipped: no page budget left` 两题都出现——standard 档 12 页预算在首轮被 sitemap/垂直源用满，缺口回补轮无页可抓；这是已知取舍（0.6.0 起「回补预留页位」只在法规/无一手源时触发）。
5. **下一步（0.9.2）**：给采用层加**相关性闸门**——问题 tokens 与 `标题 + URL 路径` 的重合度低于阈值时降档（而不是只信站点档位），价格题额外要求路径含 `pricing|价格|定价|model` 一类词。目标是「A 的 4 条无关 docPage 掉出前 10」「B 的非价目产品页降权」，同时不破坏 334 例现有断言。

## 0.9.2 复测（2026-11-15 22:05，`67a8613`，retrieval-check 真实网络）

方法同上（`node scripts/retrieval-check.mjs --question "…" --depth standard`，真实引擎 + 真实抓页器 + 假模型）。这一版新增「零证据选项定向回补」，重点看它有没有在真实页预算下触发。

| # | 问题 | 耗时 | identified→deduped→readable→adopted | 采用档位 | 零证据选项 | 定向回补 | 结果 |
|---|---|---|---|---|---|---|---|
| A | Java 后端 RAG 选型（Spring AI / LangChain4j / Haystack） | 55.2s | 65 → 36 → 12 → 10 | docPage **10** · repoCode 0 · other 0 | Haystack | skipped（`no page budget left`） | PASS |
| B | 通义千问、豆包、DeepSeek 的 API 价格对比，谁更便宜 | 57.0s | 65 → 55 → 12 → 10 | docPage **10** · repoCode 0 · other 0 | 通义千问、豆包、**谁更便宜** | skipped（`no page budget left`） | PASS |

A 前 10 条：`docs.spring.io/spring-ai/reference/{index,concepts,1.1/api/vectordbs/apache-cassandra}.html`、`spring-data-redis .../ByteUtils.html`、`spring-ai/docs/current/api`、`spring-integration 6.2.11/dsl.html`、`spring-framework 6.2/core/beans/java.html`、`docs.langchain4j.dev/tutorials/{rag,spring-boot-integration}`、`docs.spring.io/spring-boot/reference/htmlsingle`。

B 前 10 条：`api-docs.deepseek.com/quick_start/pricing`（含 zh 版）、`help.aliyun.com/zh/model-studio/models`、`www.volcengine.com/docs/82379/1099320`、`help.aliyun.com/en/model-studio/deepseek-api`、`api-docs.deepseek.com/guides/build_a_chatbot`、`help.aliyun.com/zh/model-studio/deepseek-api`、`help.aliyun.com/api-gateway/...deepseek-integration`、`api-docs.deepseek.com/quick_start/agent_integrations/codex`。

### 结论

1. **定向回补在 standard 档没有真正生效**：两题都是 `targeted refill skipped: no page budget left`。standard 的 12 页预算在首轮（sitemap / 垂直源 / 通用搜索）就被用满，回补阶段 `budget.remaining('pages')` 为 0，`optionsTried` 实际是 0——行为正确（不越预算），但产品意图（「零证据也要试着补一次」）没有兑现。0.9.5 要做「回补预留页位」，并把 `stats.targetedRefill.optionsTried > 0` 写成回归信号。
2. **B 题的选项识别多出一个 `谁更便宜`**：`compareOptions()` 的谓词裁剪覆盖了「哪家便宜」但没覆盖「谁更便宜 / 哪家更便宜」这类收尾从句，于是问题尾巴被当成第四个选项（零证据，写入 gaps）。0.9.5 补谓词 + 单测。
3. **相关性闸门的需求更清楚了**：A 的 10 条仍是「spring 系文档页」全占（含 4 条与 RAG 选型无关的 API/beans/DSL 页），B 的 10 条里阿里云非价目页（`models`、`api-gateway` 集成页）压着价目页。0.9.4 的相关性闸门（见 HANDOFF「0.9.4 计划」）比 0.9.2 更值得先做。
4. **抓取与引擎健康**：12/12 可读；ddg-html 6 次超时全部被 tavily 兜住；无 PDF/403/JS 壳失败。
5. **文档/仓库**：0.9.3 把 `text` 的 UI 入口补上（设置页「研究材料」粘贴区 + composer 材料胶囊），所以「零证据时贴正文」从只能用 API 变成界面上能操作。
## 0.9.4 复测（2026-11-15 22:24，`3101ccc`（代码 `e1f4286`），retrieval-check 真实网络）

方法同上（`node scripts/retrieval-check.mjs --question "…" --depth standard`，真实引擎 + 真实抓页器 + 假模型）。本版重点：0.9.2 的「零证据选项定向回补」在 standard 档被 12 页预算饿死（两题都是 `skipped`），0.9.4 为 compare 题在 Step 4 预留最多 2 页，并让跳过不再静默。0.9.3（研究材料粘贴区）只动设置页与 `text` 来源，不影响检索选页，因此不单独跑回归。

| # | 问题 | 耗时 | identified→deduped→readable→adopted | 采用档位 | 零证据选项 | 定向回补 | 结果 |
|---|---|---|---|---|---|---|---|
| A | Java 后端 RAG 选型（Spring AI / LangChain4j / Haystack） | 64.8s | 73 → 43 → 11 → 10 | docPage **9** · repoCode 0 · other 1 | LangChain4j、Haystack | **resolved: LangChain4j** | PASS |
| B | 通义千问、豆包、DeepSeek 的 API 价格对比，谁更便宜 | 65.4s | 73 → 62 → 10 → 9 | docPage **8** · repoCode 0 · other 1 | 通义千问、豆包、**谁更便宜** | 已发出（ddg-html 超时），未获新证 | PASS |

A 前 10 条：`docs.spring.io/spring-ai/reference/{index,concepts,1.1/api/vectordbs/apache-cassandra}.html`、`spring-data-redis .../ByteUtils.html`、`spring-ai/docs/current/api`、`spring-integration 6.2.11/dsl.html`、`spring-framework 6.2/core/beans/java.html`、`docs.langchain4j.dev/tutorials/rag`、`spring-boot current/reference/htmlsingle`、`github.com/langchain4j/langchain4j`（other）。
B 前 9 条：`api-docs.deepseek.com/quick_start/pricing`（含 zh-cn）、`help.aliyun.com/zh/model-studio/models`、`www.volcengine.com/docs/82379/1099320`、`help.aliyun.com/en/model-studio/deepseek-api`、`api-docs.deepseek.com/guides/build_a_chatbot`、`help.aliyun.com/zh/model-studio/deepseek-api`、`help.aliyun.com/en/api-gateway/...deepseek-integration`、`api-docs.deepseek.com/zh-cn/quick_start/pricing`、`github.com/timerloggedout-spec/termux-monorepo/issues/109`（other）。

### 结论

1. **定向回补真的跑起来了**：A 题 `targeted refill resolved: LangChain4j`（0.9.2 时同题是 `skipped: no page budget left`）；两题流程行都出现了回补段，不再静默跳过。说明「预留页位」这一改动在真实网络下有效。
2. **单测口径 ≠ 真实网络**：0.9.4 的单测里价格对比题是 `pagesFetched 11`、豆包 resolved；本次真实网络 B 题回补 query 已发出，但 `ddg-html` 超时、`https://bigmodel.cn/pricing` 直取不可读，豆包仍未获新证，gap 如实写「（已定向检索 1 次仍未获证）」。CHANGELOG 里已把两种口径分开写，不把单测结果当实测。
3. **相关性闸门仍未做（0.9.5 主线）**：A 的 9 条 docPage 里仍有 4 条与「RAG 选型」无关（`spring-data-redis ByteUtils`、`spring-ai/docs/current/api` 索引页、`spring-integration 6.2.11/dsl`、`spring-framework 6.2/core/beans/java`）；B 的 8 条 docPage 里仍有非价目页（`model-studio/models`、api-gateway 集成页），另有 1 条无关 GitHub issue 被当作 other 采用。档位（doc-page +4）依然压过相关性。
4. **B 仍把「谁更便宜」当成第 4 个选项**（零证据）→ `compareOptions()` 的收尾从句裁剪是 0.9.6 的事。
5. **抓取/引擎健康**：ddg-html 两题各 6 次超时，全部被 tavily 兜住（`engineErrors 6`），不影响 adopted；readable 11 / 10，无 PDF、403、JS 壳噪声；无过期仓库页。
6. **下一版（0.9.5）**：采用层相关性闸门——问题 tokens 与 `标题 + URL 路径` 重合度低于阈值时降档（而不是直接丢），价格题额外要求路径含 `pricing|价格|定价|model`；目标 A 的无关 docPage 掉出前 10、B 的非价目页降权，并把 `docPage`/`repoCode` 档位做成 retrieval-check 的回归断言（用户第 1 条要求的量化）。

## 0.9.3 复测（2026-11-15 22:20，价格题，真实研究）

- 现象：定向回补**成功触发**但解决的不是豆包；「## 方案对比」出现并格行 `qwen / 豆包 API`（价格列「未核实」且无 [S#]）；豆包 token 单价仍缺。
- 原因：定向回补 query 太泛（`<选项> 官方 价格`），没落到厂商价目页；合成模型在行数上限 3 行的约束下把两个候选并成一行。
- 决策：0.9.6 做「比价表行完整性校验 + 价目页定向构造」，0.9.7 做「价目页直取 + 零证据文案一致性」。

## 0.9.5 复测（2026-11-15 22:53，价格题，真实研究）

- 145s→148s、medium；`定向回补 1 项（解决 1）` 首次真正执行（0.9.3 的页位预留在真实网络生效）。
- 但「方案对比」仍然只有 deepseek 两行 + 并格行；豆包未补上（volcengine 页被读取但引用校验剔除，未采用）。
- 判断：并发证据提取（证据 86s→24s）与 240s 墙钟生效，剩下的问题在**合成行结构**与**价目页选取**。

## 0.9.6 复测（2026-11-15 23:15，价格题，真实研究）

- 87s、low；`定向回补 1 项（解决 0）`；表格三行独立（qwen / 豆包 / DeepSeek），豆包独立行但 `无证据`。
- 新增问题：「未解决」仍写"未纳入对比"，与表格里有独立行矛盾；参考里出现 `（已检索，未被采用）` 两条 volcengine 页（引用校验放宽生效）。
- 决策：0.9.7 修文案一致性与价目页 seed 直取。

## 0.9.6 复测（A 题，2026-11-15 23:17）

- 81s、medium；参考 6 条里 **5 条官方文档**（docs.spring.io×4、docs.langchain4j×1）+ github 1 条；官方采用 5/9；三行独立；行动清单 5 条。
- 判断：A 题（选型）已稳定在"官方文档为主"，0.7.0 的来源层排序在真实网络有效。

## 0.9.7 复测（2026-11-15 23:37，价格题，真实研究）

- 102s、medium；`定向回补 1 项（解决 0）`；豆包 seed `volcengine.com/docs/82379/1099320` **已抓到并进参考（S5，官方）**，但正文"只有页头、无可提取明细"。
- 文案一致性修复生效：未解决写 `选项「豆包」在对比表中占位，但价格未取得（零证据）`。
- 决策：0.9.8 让价目页的**表格短行**也能成为证据（pricing row extraction）。

## 0.9.7 复测（C 题，2026-11-15 23:39）

- 62s、medium、5 条来源（官方 2）；方案对比 4 行、行动清单 5 条、结论可用（8 人先模块化单体）。
- 新增两处小瑕疵：判断题的对比表仍带「价格」列（应为"成本概览"）；`（无来源）` 标签外泄进第一列标签。
- 决策：0.9.9 做「按 questionKind 决定对比表列」+「（无来源）只允许出现在数值单元格」。
