# 跨领域方法普查：六个失效点，十个学科，哪些真能借

> 对象：`D:\Total\dsh-global-research` v0.5.3
> 目的：不是罗列理论，而是回答"哪个领域解决过我们这个问题、具体改哪个函数、代价多大、怎么证明有效"。
> 方法：先拿插件自己的 `research` 工具当探针（7 次调用，见 §1），失败再 `web_search` 补齐；每条结论标注证据等级，拿不到原文的标 `待核实`。
> 本文只写文档，不改代码。

---

## 0. 一页结论

1. **最值得立刻做的三件事**（都在 Top 5 里）：① 检索流程四数（命中→去重→读取→采用），把"12 页为什么只引 5 条"变成报告里的一行字，成本 40 行；② 转载指纹（同一段引文跨站出现即折叠），这是唯一能真正压住"独立来源虚高"的低成本手段；③ 置信度校准闭环（Brier/ECE），没有它，后面所有置信度改动都是盲改。
2. **最大的认知修正**：我们不是缺新框架，而是**代码里已经有六个学科的半成品**（§4 逐条列了 16 处）——canonicalKey ≈ 记录链接的 blocking key、`isNearTitle` ≈ 近似重复检测、`computeConfidence` 的 gates ≈ GRADE 降级域、`claimPerSource` ≈ "同源多值即表格"的误报防护。正确动作是"把半成品做完并命名"，不是再造一套。
3. **最不该借的**：N-版本编程（3× 成本，且共模失效实证严重）、ACH 全套（实验显示不改善判断）、I² 硬阈值（小样本有偏）、英文概率词（"likely" 被读成 70%）。
4. **一次自我打脸**：用 `research` 查"安全工程"那一次，7 条引用**全部答偏**（欧盟声明 + 两篇无关 arXiv）。这正好复现了弱点 1——一手来源覆盖不足不是猜测，是插件自己实测出来的。
5. **最该承认的结构性缺陷**：`statsOf`（`lib/pipeline.js:1013-1047`）里根本没有"去重后命中数"这个字段。少了它，弱点 5 无论怎么修报告都算不清账。

---

## 1. 方法：拿 research 当探针（7 次调用记录）

这一步本身是压力测试：如果插件连"PRISMA 2020 有几个条目"这种有标准答案的方法学问题都取不到一手源，那它对 Java 官方文档、厂商价目页的失败就不是偶然。

| # | 查的领域 | 档位 | 结果 | 引用数 | 反推的一手源 | 关键缺口 |
|---|---|---|---|---|---|---|
| 1 | 循证医学/系统综述 | standard | confidence medium，105s，4 簇，触发 1 次补缺 | 6 | 3（PMC 论文 ×2、Cochrane 手册） | PRISMA 27 条目的**条目号与原文**没取到；GRADE 每域降几档没取到 |
| 2 | 论证理论 + 情报分析 | standard | confidence low | 2 | 1（ACH 实证论文） | Toulmin 原文措辞、ACH 步骤、Admiralty 分级全缺 |
| 3 | 判断与决策/校准 | standard | confidence low | 4 | 0（两条 github 文档、两条 issue） | 最优停止、SPRT 停止边界零覆盖 |
| 4 | 计量文献学/引文网络 | standard | confidence low | 3 | 2（arXiv 论文） | Fellegi-Sunter、Price 指数、重复发表阈值全缺 |
| 5 | 软件工程（N-版本/属性测试） | deep | confidence low，`partial=true` | 5 | 1（arXiv 预印本） | 差分测试无权威定义；N-版本具体数字只有二手 |
| 6 | **安全工程（威胁建模/注入）** | standard | **完全答偏**：7 条引用分别是欧盟对外行动署声明、金融 LLM 的 GQA→MLA、关系抽取 | 7 | 0 | STRIDE、OWASP、间接注入、防御有效率——零覆盖 |
| 7 | 人机交互（不确定性呈现） | standard | confidence medium | 3 | 3（两篇 PMC 系统综述、IPCC 章） | Hullman、Bonneau、渐进披露未取到 |

**统计**：7 次调用、约 35 条引用，其中约 10 条是官方/论文一手页面；1 次整场答偏；7 次 confidence 全部 ≤ medium（其中 5 次 low）。`research` 报告自己的 gaps 里反复出现"未核实 XX 原文"——这正是插件在真实任务里的表现。

**这说明什么**：`research` 对"方法学/标准条文"这类**结构化一手文档**的召回，和对 Java 文档、厂商价目页的召回是同一个病：搜索层能命中二手解读，抓取层拿不到权威原文。所以本文里凡涉及"标准第几条"的地方，能引经典文献就引经典，引不到就老实标 `待核实`。

---

## 2. 六个弱点在代码里的位置（后面表格的"落点"都指这里）

| 弱点 | 代码位置 | 现状 |
|---|---|---|
| ① 一手来源覆盖不足 | `lib/pipeline.js:898-918`（`primaryTargetQueries`，只按 legal/npm/github 三种类型给 site: 查询）、`:920-972`（`gapRefill` 最多抓 4 页） | 官方域是硬编码白名单（`lib/util.js:205-215`），没覆盖 Java/Spring/云厂商 |
| ② 独立来源计数虚高 | `lib/pipeline.js:187-203`（`groupEvidence`：≥2 个不同 `siteKey` 即 confirmed）；`lib/util.js:286-324`（`dedupeHits` 只按 canonicalKey + 标题 Jaccard） | 判定"独立"只看 host/repo，不看正文是否同源 |
| ③ 置信度未校准 | `lib/brief.js:143-193`（`computeConfidence`）；`client.js:16-20`（只显示三档色块） | 规则可解释，但没有"预测 vs 实际"的记录，Brier 未知 |
| ④ 冲突二分 | `lib/assertions.js:900`（`analyzeAssertions` 只返回 `{conflicts, divergences}`） | 来源自相矛盾在 `claimPerSource:755-784` 被静默丢弃，用户看不到 |
| ⑤ 参考数 ≠ 读取页数 | `lib/pipeline.js:1013-1047`（`statsOf` 没有"去重后命中数"）；`lib/brief.js:271-294`（`unusedPageLine` 只报未采用总数） | 已用"另有 N 页未采用"打补丁，但没有排除理由，也算不出漏斗 |
| ⑥ 固定预算 | `lib/pipeline.js:16-20`（`DEPTH_PROFILES`：quick 3 页 / standard 12 页 / deep 30 页，`gapRounds` 固定 0/1/1） | 没有"边际收益递减"的判据，只有墙钟和配额 |

---

## 3. 领域普查

三张表，列固定。`难度` 用 低/中/高；`收益` 里带数字的，能测的写测法，纯估算的标 `估算`。

### 3.1 证据合成与来源判定（循证医学、统计学、计量文献学、情报分析）

| 领域 | 可借的具体方法 | 落到插件哪个模块/函数 | 预期收益（可量化） | 代价 | 实施难度 | 证据来源 |
|---|---|---|---|---|---|---|
| 循证医学 | PRISMA 2020 的四段流程数：识别 → 去重后筛选 → 全文读取 → 纳入，每段带排除数与排除理由 | `lib/pipeline.js:1013-1047` `statsOf` 加 `hitsUnique`/`pagesRead`/`adopted`；`lib/brief.js:232-248` `appendStats` 改成一行漏斗 | 每次运行多 3 个字段、0 额外请求；把"12 页为什么只引 5 条"的排查从人工约 10 分钟/次降到 0；弱点 5 结构性消失 | 约 40-60 行，不动抓取逻辑 | 低 | PRISMA 2020 声明（27 项清单 + 流程图），BMJ 2021;372:n71，<https://www.prisma-statement.org/prisma-2020-statement> |
| 循证医学 | GRADE 的五个降级域（偏倚风险、不一致性、间接性、不精确性、发表偏倚）作为**具名降级理由**，而不是一个分数 | `lib/brief.js:143-193` `computeConfidence` 返回 `{value, reasons[]}`，每个 gate 对应一个具名域 | 把"为什么 medium"从黑箱变成可审计的 1-3 条理由；为弱点 3 的校准提供特征（先有理由，才谈得上校准） | 约 60 行，改函数签名 + `fallbackBrief` 同步 | 低 | GRADE 五降级域 + 四档 certainty，Cochrane Handbook ch.14，<https://www.cochrane.org/authors/handbooks-and-manuals/handbook/current/chapter-14> |
| 循证医学 | 重复发表/companion reports 判定：同一试验的多篇报告算 1 个独立来源 | `lib/brief.js:30-66` `assignSourceIds` 增加"同研究"合并（按 dataset/trial 标识或首作者+年份） | 直接压弱点 2；在含 companion reports 的问题上把来源数从虚高降到真实独立数 | 需要"同一研究"特征，插件当前没有；约 50 行 + 抽取规则 | 中高 | PRISMA 2020 有该条目，但**具体判定标准本次未取到**，`待核实` |
| 统计学 | I² 的正确用法：报"点估计 + 置信区间 + 研究数"，而不是用 >50% 当硬阈值；7 项研究时 I² 平均高估 12 个百分点 | 借其**纪律**：`clusters` 一致性报 `(k, 独立 host 数, 一致/不一致)` 三元组，禁止用单一数字概括 | 消除"3 个源 = 高置信"的小样本错觉；改动在报告措辞层，0 延迟 | 约 20 行（`appendReferences`/置信度段落） | 低 | 小样本 I² 偏差，<https://pmc.ncbi.nlm.nih.gov/articles/PMC4410499>（真实异质性 0 时高估 12pp，真实 80% 时低估 28pp） |
| 统计学 | capture-recapture（两来源交叉）：用两个引擎命中集的交集估计"真实独立来源数" `N̂ ≈ n1·n2/m` | `lib/util.js:286-324` `dedupeHits` 已保留每条的 `engines` 数组，可直接算三源交集；结果进 `statsOf` | 把"来源数"从计数变成带漏检估计的量；转载造成的虚高会直接体现在 m 偏大 | 约 40 行；只在 ≥2 引擎都有结果时可用 | 中 | Lincoln-Petersen 估计量（经典）；闭合总体假设需 `待核实` |
| 统计学 | 抽样偏差纪律：我们的 12 页是 `rankHits` 排序后的**便利样本**，不是随机样本 | 报告层禁令：不写"多数来源认为"，改写"本次读取的 k 个来源中 m 个" | 措辞层面立即生效，避免过度概括；可测：对 20 份历史报告做措辞审计 | 约 10 行 lint 规则 | 低 | 统计教科书级结论，`待核实` 具体出处 |
| 计量文献学 | 文献耦合/共被引（BC/CC）：两页若引用同一批外链，很可能是同一底稿的转载；CC 在基准上优于 BC、优于直接引用 | 新增 `lib/util.js` 的 `linkOverlap(a,b)`，接入 `lib/pipeline.js:187-203` 的独立性判定 | 比标题 Jaccard 更抗"换标题"；目标：20 题探针集里至少 3 题出现折叠（否则判定无收益） | 需保留每页外链（`fetch` 已抽 links，`:655-676` 在用），约 70 行 | 中 | 文献耦合/共被引泛化，arXiv 2110.15513；CC>BC>direct，arXiv 2403.09295 |
| 计量文献学 | Bradford/Price 集中度：报告"来源集中度"（前 3 个 host 占全部引用比例） | `lib/brief.js:250-263` `appendReferences` 末尾加一行；`statsOf` 加 `topHostShare` | 一眼看出是否被单一站点垄断；对"7 源里 5 源同站"这类假独立直接报警 | 约 25 行 | 低 | Bradford 定律（1934，经典）；应用示例 <https://www.elsevier.es/index.php?p=revista&pRevista=pdf-simple&pii=S2444569X25000617> |
| 计量文献学 | Fellegi-Sunter 记录链接：blocking（分块）+ m/u 权重 + 阈值决策，把去重从规则堆变成可调参的概率模型 | `lib/util.js:142-177` `canonicalKey` 就是 blocking key 的手工版；把 `isNearTitle:121` 的 0.85 换成可标定的阈值 | 去重 precision/recall 第一次可测；标题阈值从"拍的"变成"标出来的" | 需要标注对（约 200 对），约 120 行；m/u 公式本次未取到原文，`待核实` | 高 | Fellegi & Sunter 1969, JASA（经典）；公式 `待核实` |
| 情报分析 | Admiralty 两维正交：来源可靠性（A-F）× 信息可信度（1-6）。我们现在的 `domainTrust` 把两件事压成一维 | `lib/util.js:254-264` 拆成 `sourceReliability(host)` + `claimCredibility(evidence)`；`lib/brief.js:20-28` `gradeSource` 归一到可靠性维 | 官方站上的低可信度传言不再自动拿高分；可测：构造 10 条"官方域 + 无出处断言"，看是否仍被判 strong | 约 80 行，需调 `computeConfidence` 的 strong 定义 | 中 | Admiralty 分级语义（可靠性/可信度混淆问题），<https://hal.science/hal-04442314v1/document>；A-F/1-6 精确定义 `待核实` |
| 情报分析 | ACH 的**矩阵结构**（假设 × 证据，标"不一致"而非"支持"） | 每簇在报告"未解决"节列出 2-3 个竞争解释及各自被哪条证据削弱；`lib/brief.js:463` `ensureSections` 加一节 | 把 disputed 从二元变成"哪个假设被哪条证据削弱"；但**不借它的去偏承诺** | 需 LLM 额外 1 次调用（预算 14 次，紧）；约 90 行 | 高 | Heuer 1999《Psychology of Intelligence Analysis》ch.8（CIA CSI）；反证：ACH 未显著改变可信度评分，<https://pmc.ncbi.nlm.nih.gov/articles/PMC13094959> |
| 情报分析 | 关键假设检查（Key Assumptions Check）：输出"本次结论依赖的 3 个未验证假设" | `lib/brief.js` 的"未解决"节：把 `gaps` 从"缺什么来源"升级为"假设了什么" | gaps 可执行性提升；可测：人工评 20 份报告，能被验证的假设条数 | 约 30 行 + 提示词一句 | 低 | Heuer 1999（同上），结构化分析技法清单 `待核实` |

### 3.2 判定、冲突与停止（论证理论、判断与决策、最优停止）

| 领域 | 可借的具体方法 | 落到插件哪个模块/函数 | 预期收益（可量化） | 代价 | 实施难度 | 证据来源 |
|---|---|---|---|---|---|---|
| 论证理论 | Toulmin 六部件：claim / support / warrant / backing / rebuttal / qualifier。我们现在只有 claim + stance，缺 warrant 与 qualifier | `lib/pipeline.js:217-233` `toEvidence` 加可选 `warrant`、`qualifier`；`lib/brief.js:342` `conflictLines` 按 warrant 分组 | 把"数值不同"与"前提不同"分开——这正是弱点 4 的根因；可测：构造 10 组"同值不同前提"，误报冲突数降为 0 | 约 70 行 + 提示词加两字段 | 中 | Toulmin 1958《The Uses of Argument》；六部件枚举 <https://files.eric.ed.gov/fulltext/ED584443.pdf>（"support" vs "data" 命名 `待核实`） |
| 论证理论 | 非形式逻辑的"批判性问题"（critical questions）：每种论证图式配 2-3 个必答问题，用来生成 gaps | `lib/pipeline.js:136-156` `clauseGaps` 增加"问题未答"维度；按 `questionKind` 配问题库 | gaps 从"缺来源"变成"缺条件"（如"这个价格是否含税/按 seat"），直接治伪冲突 | 问题库 4 类 × 3 问，约 60 行 | 中 | Walton 论证图式（2008）；原文本次未取到，`待核实` |
| 论证理论 | 把 rebuttal 当一等公民：反驳必须挂在被反驳的 claim 上，而不是单独成簇 | `lib/pipeline.js:187-203` `groupEvidence` 增加 `rebuts: clusterId` 字段 | 冲突节能写"A 说 X，B 说在 Y 条件下不成立"，而不是并列两条；可测：contested 策略下 rebuttal 挂接率 | 约 50 行 | 中 | Toulmin 1958（同上） |
| 判断与决策 | Brier score（二元）：`mean((p−y)²)`，常量 p=0.5 → 0.25 基线；完美预测 → 0 | 新增 `lib/calibration.js`（纯函数）+ `test/calibration.test.js`；每次运行落一条 `{predicted, correct, kind}` | 第一次能把"medium 的实际命中率"变成数字；目标：≥30 条标注后 Brier ≤0.20；弱点 3 从"未知"变"可测" | 新增文件约 120 行 + 50 题标注集（人工，约 2 天） | 中 | Brier 1950, Monthly Weather Review（经典）；公式在本次检索中见二手文档，`待核实` |
| 判断与决策 | ECE + 可靠性图：按预测概率分 10 箱，算 `abs(准确率 − 平均置信度)` 的加权和 | 同上，`ece(pairs, bins=10)`；每箱 n<30 时只报计数不报比率 | 能指出"哪个档位最不靠谱"（通常 medium 最糊）；可测：手算 fixture 对齐 | 约 40 行 | 低 | Naeini et al. 2015（ECE 提出）；分箱细节 `待核实` |
| 判断与决策 | 基准率/参考类：按 `questionKind` 统计历史命中率作先验，再让证据调整 | `lib/strategy.js:265` `classify` 的输出接一个 `baseRate` 字段；`computeConfidence` 用它做先验 | fresh-data 类天生低命中，就不该因 3 源给 high；可测：分类型 Brier 对比 | 约 60 行，依赖校准数据积累 | 中 | 参考类预测（Flyvbjerg 2006）；错参考类 100% vs 正确 5%，见本次检索 S2（二手，`待核实`） |
| 判断与决策 | "N≥30 才能谈比率"的经验法则 | 校准看板：n<30 时只显示原始计数 | 防止拿 5 个样本宣布"medium 命中率 60%" | 0 行（文档纪律） | 低 | 本次检索二手经验法则，`待核实` |
| 最优停止 | SPRT（Wald 序贯概率比）：`B < L_r = ∏ f(x_i;θ1)/f(x_i;θ0) < A`，越界即停；A、B 由 α、β 定 | `lib/pipeline.js:590-676` 的整批抓取改批式，每批 3 页算一次似然比 | 简单题提前 30-50% 停止（估算）；难题继续到墙钟；省的是页数与延迟 | 需重构页面选择循环，约 120 行，回归面大 | 高 | SPRT 公式与停止边界 <https://theses.hal.science/file/index/docid/46437/filename/tel-00005216.pdf>（Wald） |
| 最优停止 | 秘书问题 1/e：前 37% 只观察不锁定，之后遇到明显更好的才替换 | 页面排序阶段：前 `ceil(0.37·pageBudget)` 页只用于建分布，之后才允许替换已选 | 减少早锁定坏来源（实测 #4 的 `[S1]` 就是停维护仓库）；可测：重跑 7 次历史问题，看头部来源质量 | 约 60 行 | 中 | 秘书问题最优停止，Dynkin 1963 / Lindley 1961，<https://dlnext.acm.org/doi/epdf/10.1145/1980522.1980528> |
| 最优停止 | Pandora's box / Gittins 指数：每页有"打开成本"与"期望信息增益"，按指数排序 | 理想形态；当前没有每页增益的后验 | 理论最优的页面排序 | 需要先有校准数据，否则是空转 | 高 | Gittins 指数（经典）；本次检索零覆盖，`待核实` |

### 3.3 工程与呈现（软件工程、安全工程、人机交互）

| 领域 | 可借的具体方法 | 落到插件哪个模块/函数 | 预期收益（可量化） | 代价 | 实施难度 | 证据来源 |
|---|---|---|---|---|---|---|
| 软件工程 | 属性测试（QuickCheck 式不变量）：对纯函数写"永远成立"的性质 | 新增 `test/properties.test.js`：`canonicalKey` 幂等、`dedupeHits` 输出数 ≤ 输入数、`confirmed ≤ clusters ≤ evidence`、单位换算往返 | 改去重/置信度规则时的回归网；现有 114 例多是示例测试，不变量覆盖为 0 | 约 80 行测试，0 产品代码 | 低 | QuickCheck，Claessen & Hughes 2000 (ICFP)；40+ 语言重实现 |
| 软件工程 | 蜕变测试：对同一问题做"无害变换"（换问法、加 focus、换同义标题），结论应不变 | `test/` 加 metamorphic 套件，做 3 类变换 | 直接测"跨站转载换标题"是否骗过去重（弱点 2 的测法）；可测：变换前后 sources 差 ≤1 | 约 60 行测试 + 3 个 fixture | 低 | 蜕变测试，Chen/Cheung/Yiu 1998（HKUST-CS98-01）；oracle problem 由 Weyuker 1982 命名 |
| 软件工程 | N-版本编程：3 个模型各抽一次证据，多数投票 | 不接。`extractEvidence:266` 单次调用；改成 3 次即 3× `llmCalls` | 理论上少一次幻觉 | 预算 14 次调用扛不住；且共模失效实测 429 次 vs 独立预期 115.36 次 | 高（不建议） | 多版本多数投票 387.44→130.99 失败数，arXiv 2606.20158（2026-06 预印本，`待验证`）；Knight & Leveson 1986, IEEE TSE SE-12(1) |
| 安全工程 | STRIDE 六类对"检索到的页面内容"做威胁建模：注入 = Tampering + Information disclosure | `lib/fetch.js` → `lib/pipeline.js:266` 的抽取入口：页面文本进 prompt 前标记为不可信数据，剥离指令式句子 | 间接注入面收敛；可测：注入语料集（20 条）拦截率 | 约 40 行 + 语料 | 中 | Microsoft STRIDE 六类，<https://learn.microsoft.com/en-us/azure/security/develop/threat-modeling-tool-threats> |
| 安全工程 | OWASP LLM01:2026 间接注入：网页内容不得被当指令；输出走白名单 | 已有半成品：`toEvidence` 的 type/stance 白名单。补：`isGrounded:210` 后加"引文不得包含指令模式"过滤 | 高安全收益、低成本；可测：注入页面里"忽略以上指令"的句子不进证据 | 约 25 行 | 低 | OWASP Top 10 for LLM 2026, LLM01 Prompt Injection，<https://genai.owasp.org/resource/owasp-genai-llm-top-10-2026/>；Greshake et al. 2023, <https://dl.acm.org/doi/10.1145/3605764.3623985> |
| 安全工程 | 信任边界 + schema 校验：搜索 API → 页面 → LLM → 报告，每个边界校验形状 | `lib/schema.js` 已存在；把 `parseSources`/`confidenceOf`（`client.js:76-108`）的宽松正则改成 schema | 畸形输入不再穿透到 UI；可测：10 个畸形 fixture | 约 50 行 | 低 | STRIDE 衍生（信任边界），`待核实` 具体出处 |
| 人机交互 | IPCC 两层语言：定性 confidence（证据量 + 一致度）+ 量化不确定性 | `client.js:16-20` 从"一个词 + 一个颜色"改为"结论档 + k 个独立来源中 m 个一手 + 一句主要不确定性" | 10 秒内知道该不该信；可测：5 人可用性测试，误解率 | 约 60 行 UI + 文案 | 低 | IPCC 不确定性处理章（两层校准语言），本次检索 S3，`待核实` 具体页码 |
| 人机交互 | 文字概率词的系统综述：不要把 "likely" 当 70% 用——它被读成 70%（60-80%），"very likely" 90%（80-95%），个体差异大 | 文案规范：禁止英文概率词；要就给 X-in-100 或百分比 | 消除一个稳定的误读源；0 代码 | 0 行（评审清单） | 低 | 临床风险沟通系统综述，<https://pmc.ncbi.nlm.nih.gov/articles/PMC11067312>；145 个词、33 项研究，<https://pmc.ncbi.nlm.nih.gov/articles/PMC8642516> |
| 人机交互 | 不确定性的"作者不愿画"问题：不画区间是因为怕显得不可信；对策是文字化"如果这条错了，最可能错在哪" | `lib/brief.js` "未解决"节加一句 `最可能出错的环节：…` | 比 fan chart 更可能被读完；可测：报告完读率（若有埋点） | 约 20 行 + 提示词 | 低 | Hullman, "Why Authors Don't Visualize Uncertainty", IEEE TVCG 2020;26(1):130-139, <https://pubmed.ncbi.nlm.nih.gov/31425093/> |
| 人机交互 | 渐进披露：卡片只给结论 + 置信度三件套，细节折叠 | `client.js` 卡片结构；默认折叠"检索过程/冲突/未采用页面" | 首屏信息密度降；可测：首屏可读字数 | 约 40 行 | 低 | 渐进披露（progressive disclosure）；出处 `待核实` |

---

## 4. 我们已经有、只是没命名的框架（别重复造轮子）

| 现有实现 | 等价框架 | 学科 | 完成度 | 该补的一步 |
|---|---|---|---|---|
| `canonicalKey`（`lib/util.js:142-177`）+ `normalizeUrl`（`:82-98`） | 记录链接的 **blocking key**（分块键） | 计量文献学/统计 | 半成品：规则归一做得不错，但没有概率匹配阶段 | 加 m/u 权重与阈值，或至少把"镜像域名表"数据化 |
| `isNearTitle`（`:121-128`，Jaccard≥0.85）+ `sameTitle`（`lib/brief.js:72-78`） | 近似重复检测（shingling + Jaccard） | 信息检索 | 半成品：阈值 0.85 是拍的，从未标定 | 用标注对画 precision/recall 曲线选阈值 |
| `dedupeHits`（`:286-324`） | 记录链接的**合并阶段** | 计量文献学 | 半成品：只取"第一个非镜像"，没有冲突合并策略 | 加"字段级投票"（标题取最长、日期取最新） |
| `siteKey`（`lib/pipeline.js:159-169`） | 来源**独立性单位**的定义 | 情报分析 | 半成品：github repo 特判是手工补丁 | 把"什么算一个独立来源"写成可配置规则 |
| `groupEvidence`（`:187-203`，claim Jaccard≥0.45） | 论证聚类 / 主张同一性判定 | 论证理论 | 半成品：阈值与置信度同源未校准 | 与 Brier 校准共用一套标注数据 |
| `computeConfidence`（`lib/brief.js:143-193`）+ `gates` | **GRADE 证据分级**（certainty + 降级域） | 循证医学 | 半成品：有降级动作，不记录降级理由 | 返回 `reasons[]`，每个 gate 对应一个具名域 |
| `gradeSource`（`lib/brief.js:20-28`） | 来源类型分层（GRADE indirectness 的粗版） | 循证医学 | 半成品：6 类够用，但"官方"只按域名 | 与 Admiralty 可靠性维合并 |
| `domainTrust`（`lib/util.js:254-264`） | 来源可靠性评分（Admiralty A-F 的一维化） | 情报分析 | **已走偏**：把站点可靠与断言可信压成一维 | 拆两维（见 §3.1 第 10 行） |
| `claimPerSource`（`lib/assertions.js:755-784`） | "同源多值 = 表格/更新日志"的误报防护 | 论证理论/测量 | **已是正确做法**，只是没输出"自相矛盾"类别 | 加 `selfContradictions` 返回桶 |
| `isGrounded`（`lib/pipeline.js:210-215`） | 引文核验 / 原文回溯（quote verification） | 循证医学 | 半成品：只比对前 60 字、只查单页 | 扩大比对窗口，跨页查同句 |
| `unusedPageLine`（`lib/brief.js:271-294`） | PRISMA 流程图的**排除计数** | 循证医学 | 半成品：只有总数，没有理由分类 | 见 Top 1 |
| `clauseGaps`（`lib/pipeline.js:136-156`） | 覆盖度判定 / 停止准则的雏形 | 循证医学/最优停止 | 半成品：只用来触发补缺，不用于停止 | 见 §3.2 的 SPRT 行 |
| `gapRounds`（`lib/pipeline.js:16-20`） | 序贯分析的"轮" | 最优停止 | 半成品：固定 1 轮，不是边界 | 同上 |
| `evidenceAgeDays` + `· 旧`（`lib/util.js:271-283`、`lib/brief.js:263`） | 时效性衰减 | 情报分析 | 半成品：只标注，不参与排序（实测 #4 已暴露） | 进 `rankHits` 的负项 |
| strategy packs（`lib/strategies.js:147-152`） | 系统综述的**预注册方案**（protocol） | 循证医学 | 半成品：有 requiredSections/gates，无"偏离方案"记录 | 报告里记"本次偏离了哪条 requiredSection，为什么" |
| `validateCitations`（`lib/brief.js:80-117`） | 引用完整性校验 | 出版规范 | **已成品**（少见的完整实现） | 不动 |

**结论**：`canonicalKey` / `isNearTitle` / `dedupeHits` / `siteKey` / `computeConfidence` / `claimPerSource` / `isGrounded` / `unusedPageLine` 八个位置，分别对应记录链接、近似重复、独立性定义、证据分级、误报防护、原文核验、流程计数——**六个学科的半成品已经写在我们代码里了**。Top 5 里四项是"把它们做完"，只有校准闭环是真正新增。

---

## 5. Top 5 建议实施

评分：`影响(1-5) × 频率(1-5) ÷ 代价(1-5)`。频率口径：每次运行都发生 = 5。

| # | 项 | 影响 | 频率 | 代价 | 分 | 修的弱点 |
|---|---|---|---|---|---|---|
| 1 | 检索四数流程行 | 3 | 5 | 1 | **15.0** | ⑤ |
| 2 | 转载/引文指纹去重 | 5 | 5 | 2 | **12.5** | ② |
| 3 | 置信度校准闭环（Brier/ECE） | 5 | 5 | 3 | **8.3** | ③ |
| 4 | 一手来源雪球扩展 | 4 | 4 | 3 | **5.3** | ① |
| 5 | 冲突三分法（qualifier / selfContradiction） | 3 | 3 | 2 | **4.5** | ④ |
| 6 | 序贯停止（SPRT/批式） | 3 | 4 | 4 | 3.0 | ⑥ —— **暂缓**，见文末 |

### Top 1｜检索四数流程行（弱点 ⑤）

- **改哪**：`lib/pipeline.js:1013-1047` `statsOf` 增加 `hitsUnique`（`dedupeHits` 后长度）、`pagesRead`、`adopted`；`lib/brief.js:232-248` `appendStats` 改成 `> 本次检索：查询 6 · 命中 41 → 去重 23 → 读取 12 → 采用 5 · 8 条证据 · 96 秒（standard）`；`lib/brief.js:271-294` `unusedPageLine` 补排除理由（重复/低相关/抓取失败）。
- **约多少行**：40-60 行，不动抓取。
- **怎么证明有效**：`test/pipeline.test.js` 加不变量 `adopted ≤ pagesRead ≤ hitsUnique ≤ hits`；`test/brief.test.js` 断言四数都在、且"采用"数等于 references 条数；构造 `adopted=0` 的 fixture，行仍必须出现（不能因为没引用就不报）。再用 §1 的 7 次历史问题重跑，人工核对四数与 references 一致。

### Top 2｜转载/引文指纹去重（弱点 ②）

- **改哪**：`lib/util.js` 新增 `quoteFingerprint(text)`（去空白标点、小写、取 8-gram 集合）与 `syndicationGroups(pages)`（两页共享 ≥3 个 8-gram 且 host 不同 → 同源）；`lib/pipeline.js:187-203` `groupEvidence` 在 `siteKey` 独立性判定**之前**折叠，被折叠者记 `copies` 且不计入 confirmed；`lib/brief.js:30-66` `assignSourceIds` 折叠后只留 1 个 `[S#]`，references 加 `（另有 N 站同文：a.com, b.com）`。
- **约多少行**：90 行左右。
- **怎么证明有效**：3 个 fixture 页面，两 host 同引文不同标题 → `sources.length===1` 且 `cluster.status==='unverified'`；对照组同 host 不同引文 → 2 源；再加蜕变测试：标题改写 30%、加站点前缀后仍折叠。**收益门槛**：20 题探针集里至少 3 题出现折叠，否则判定无收益、回滚。

### Top 3｜置信度校准闭环（弱点 ③）

- **改哪**：新增 `lib/calibration.js`（纯函数 `brier(pairs)`、`ece(pairs, bins=10)`、`reliabilityTable(pairs)`）；`scripts/calibrate.mjs` 读 `test/fixtures/calibration.jsonl`（每行 `{question, predicted, correct, kind}`）；运行路径先只加"影子记录"，不改线上判断。
- **约多少行**：120 行 + 50 题标注集（人工，约 2 天）。
- **怎么证明有效**：`test/calibration.test.js`：常量 p=0.5 → Brier **恰好 0.25**；全对 → 0；手算 10 条 fixture 对齐 ECE。上线门槛：≥30 条标注后 Brier ≤0.20、ECE ≤0.10（每箱 n≥30）；未达标就把 medium 一律降为"未校准"文案。

### Top 4｜一手来源雪球扩展（弱点 ①）

- **改哪**：`lib/pipeline.js:898-918` `primaryTargetQueries` 按 `questionKind` 扩官方域（java→`docs.oracle.com`/`dev.java.net`；spring→`spring.io`/`docs.spring.io`；aws→`docs.aws.amazon.com`；azure→`learn.microsoft.com`；k8s→`kubernetes.io`）；`lib/pipeline.js:920-972` `gapRefill` 加 backward snowball：复用 `:655-676` 已读页 links 的官方域筛选，允许 2 跳；`officialFetchFailures` 进 gap 文案。
- **约多少行**：80 行。
- **怎么证明有效**：fixture 页面 links 含 `docs.oracle.com` → 被加入 refill 队列；配额满时不加；抓取失败时 gap 行出现具体域名。重跑 §1 的 7 题，记录"一手来源命中率"从当前约 2/7 提升到 ≥5/7（目标，估算）。

### Top 5｜冲突三分法（弱点 ④）

- **改哪**：`lib/assertions.js:755-784` `claimPerSource` 增加 `selfContradictions` 返回桶（桶内 distinct>1 且时间相同/未知 → 现在直接丢弃，改为记录）；新增 `qualifier` 抽取（`beta|preview|GA|as of 20\d\d|仅限|不含税|per seat`）；`lib/assertions.js:900` `analyzeAssertions` 返回三元组；`lib/brief.js:378` `assertionConflictLines`：qualifier 不同 → 写"条件不同"而非"冲突"，selfContradiction 单独一行 `- 来源自相矛盾：[S2] 同一页给出 128K 与 256K（已弃用较旧值）`。
- **约多少行**：70 行。
- **怎么证明有效**：`test/assertions.test.js`：单源两值 → 进 `selfContradictions`、不进 `conflicts`；两源 qualifier 不同 → `divergences`；真冲突（同条件不同值）照旧进 `conflicts`。三条断言同时绿才算过。

### 第 6 项为什么不进 Top 5（弱点 ⑥）

序贯停止（SPRT / 秘书问题）理论收益明确，但当前 `runResearch` 是**整批抓取**（`:590-676` 一次选完 12 页再统一抽取），要做停止就得先改成批式（3 页一批、每批重排、每批判停），回归面覆盖缓存、复用、补缺、置信度四条路径。**影响 3 × 频率 4 ÷ 代价 4 = 3.0**，低于第 5 名。等 Top 3 的校准数据到位、能估"每页信息增益"之后再上，才不是拍脑袋设阈值。

---

## 6. 不建议借的（负结果，省得以后有人再提）

| 候选 | 为什么否决 |
|---|---|
| N-版本编程（3 模型多数投票） | 3× `llmCalls`（现 14 次），且共模失效实测 429 次 vs 独立假设预期 115.36 次（arXiv 2606.20158，预印本待验证）。对"证据抽取"这种同分布错误，投票去不掉。 |
| ACH 全套（矩阵 + 打分 −3..+3） | 在线实验（159 人）显示 ACH **未显著改变**可信度评分或证据选择（<https://pmc.ncbi.nlm.nih.gov/articles/PMC13094959>）。只借"列竞争假设"的结构，不借"能去偏"的承诺。 |
| I² 硬阈值（>50% 即高异质性） | 7 项研究时 I² 平均高估 12pp、真实 80% 时低估 28pp（<https://pmc.ncbi.nlm.nih.gov/articles/PMC4410499>）。借"报区间"的纪律，不借阈值。 |
| 英文文字概率词（likely / probable） | "likely" 被读成 70%（60-80%），"very likely" 90%（80-95%），且 145 个词在 33 项研究里语义漂移（<https://pmc.ncbi.nlm.nih.gov/articles/PMC11067312>、<https://pmc.ncbi.nlm.nih.gov/articles/PMC8642516>）。 |
| 不确定性可视化（fan chart / 区间图） | Hullman 指出作者本就不愿画，因为怕显得不可信（<https://pubmed.ncbi.nlm.nih.gov/31425093/>）。报告里用文字 + 数字，不画图。 |
| Gittins 指数 / Pandora's box 排序 | 需要每页"期望信息增益"的先验，我们现在连后验（校准数据）都没有，上了就是空转。 |
| Fellegi-Sunter 完整概率模型 | 方向对（`canonicalKey` 就是它的 blocking 阶段），但要 200 对标注 + m/u 参数估计，当前 ROI 不如 Top 2 的指纹折叠。等校准数据到位再上。 |

---

## 7. 证据状态

### 7.1 可点击的一手/官方来源（本文引用的）

- PRISMA 2020 声明（27 项清单 + 流程图）：<https://www.prisma-statement.org/prisma-2020-statement>；BMJ 2021;372:n71，doi:10.1136/bmj.n71
- GRADE 五降级域 + 四档 certainty：Cochrane Handbook ch.14，<https://www.cochrane.org/authors/handbooks-and-manuals/handbook/current/chapter-14>
- PRISMA 2020 论文页（PMC）：<https://pmc.ncbi.nlm.nih.gov/articles/PMC8007028>
- I² 小样本偏差：<https://pmc.ncbi.nlm.nih.gov/articles/PMC4410499>
- ACH 实证反例：<https://pmc.ncbi.nlm.nih.gov/articles/PMC13094959>
- 临床风险沟通中的文字概率词：<https://pmc.ncbi.nlm.nih.gov/articles/PMC11067312>、<https://pmc.ncbi.nlm.nih.gov/articles/PMC8642516>
- Toulmin 模型（ERIC 全文 PDF）：<https://files.eric.ed.gov/fulltext/ED584443.pdf>
- STRIDE 六类：<https://learn.microsoft.com/en-us/azure/security/develop/threat-modeling-tool-threats>
- OWASP LLM Top 10 2026（LLM01 注入）：<https://genai.owasp.org/resource/owasp-genai-llm-top-10-2026/>
- 间接注入原始论文：<https://dl.acm.org/doi/10.1145/3605764.3623985>
- Hullman 不确定性可视化：<https://pubmed.ncbi.nlm.nih.gov/31425093/>
- 文献耦合/共被引：<https://arxiv.org/abs/2110.15513>、<https://arxiv.org/abs/2403.09295>
- N-版本编程（预印本，待验证）：<https://arxiv.org/abs/2606.20158>
- SPRT 公式与边界：<https://theses.hal.science/file/index/docid/46437/filename/tel-00005216.pdf>
- Admiralty 分级语义：<https://hal.science/hal-04442314v1/document>
- 秘书问题 1/e：<https://dlnext.acm.org/doi/epdf/10.1145/1980522.1980528>
- Bradford 定律应用：<https://www.elsevier.es/index.php?p=revista&pRevista=pdf-simple&pii=S2444569X25000617>
- ACH 原始出处（CIA）：Heuer & Richards, *Psychology of Intelligence Analysis*, 1999, ch.8（本次经 <https://www.euintelligenceacademy.eu/sites/eia/files/EIA_REPORT_2013.pdf> 转引）

### 7.2 核实结果（2026-11-15 回填）

原 14 条 `待核实` 已逐条尝试抓取一手正文。状态定义：`已核实` = 读到一手正文并逐字摘录；`付费墙` = 一手确已定位但被付费墙/借阅墙/反爬/仅纸质挡住，未取正文；`仍缺` = 未定位到可用一手（含条文本身不公开的情况）。"关键原文摘录"一律为 fetch 到的页面里逐字存在的短句。

| # | 项目 | 状态 | 一手出处（URL） | 关键原文摘录（≤40 字） | 备选二手来源 |
|---|---|---|---|---|---|
| 1 | PRISMA 2020 的 27 条目逐条文本与编号 | 已核实 | <https://r.jina.ai/https://www.ncbi.nlm.nih.gov/pmc/articles/PMC8007028/>（PLoS Med 2021;18(3):e1003583，Table 1 含全部 27 项与 10a/10b、13a–13f、16a/16b、20a–20d、23a–23d、24a–24c 子项） | `Identify the report as a systematic review.` | prisma-statement.org 的 checklist 页正文是 Squarespace 空壳，清单本体为 PDF 附件（`/s/PRISMA_2020_checklist.pdf`），web_fetch 读不了 |
| 2 | GRADE 每个降级域具体降几档 | 已核实 | <https://r.jina.ai/https://training.cochrane.org/handbook/current/chapter-14>（Cochrane Handbook v6.5 ch.14；Table 14.2.a/14.2.b） | `Serious limitations, downgrade one level.` | 同页 Table 14.2.a 另有 `Very serious limitations, downgrade two levels.`——即"严重降 1 档、非常严重降 2 档"是明文规则，不是推断 |
| 3 | Toulmin 六部件中第二部件的命名（support 还是 data） | 付费墙 | *The Uses of Argument*（CUP, 1958），archive.org 借阅墙：<https://archive.org/details/usesofargument0000toul> | 未获取正文 | Lumen 教科书（已 fetch 正文）：<https://courses.lumenlearning.com/elpaso-englishcomp/chapter/toulmins-argument-model/> → `The grounds (or data) is the basis of real persuasion`；同页 `The backing (or support) for an argument gives additional support to the warrant`。结论：第二部件 = **Data/Grounds**，"support" 是 **backing** 的同义词，不是第二部件名 |
| 4 | Walton 论证图式清单与批判性问题原文 | 付费墙 | *Argumentation Schemes*（Walton/Reed/Macagno, CUP 2008, xii+443pp），出版社 frontmatter PDF <https://assets.cambridge.org/97805217/23749/frontmatter/9780521723749_frontmatter.pdf> 返回 403（jina 报 `Suspicious action: Domain resolved to non-public IP`） | 未获取正文 | UvA 学位论文（仅检索摘要可见，未 fetch 正文）：`in which is listed 60 argument schemes, along with their associated critical questions`；Chris Reed 本人论文（检索摘要）：`the list of 60+ schemes in chapter 9` |
| 5 | ACH 的具体步骤与矩阵打分（−3..+3） | 已核实（步骤） / −3..+3 无一手支持 | <https://web.archive.org/web/20070613032237/https://www.cia.gov/library/center-for-the-study-of-intelligence/csi-publications/books-and-monographs/psychology-of-intelligence-analysis/art11.html>（Heuer 1999, *Psychology of Intelligence Analysis*, ch.8） | `ACH is an eight-step procedure grounded in basic insights from cognitive psychology` | 八步全文已抓取（见下方注 A）。**该章没有 −3..+3 记分**：原文只说 `a general notation such as plus or minus`，评判规则是 `The hypotheses with the fewest minuses is probably the most likely one.` |
| 6 | Admiralty 的 A–F / 1–6 精确定义 | 已核实（转引） | 美军 FM 2-22.3 *Human Intelligence Collector Operations*（2006-09，384 页，`Approved for public release; distribution is unlimited.`）附录 B Table B-1/B-2 的**逐字转录**：<https://r.jina.ai/https://ki4hdu.com/preppernotes/source-and-information-reliability-matrix/>（页首自注 `From Army FM 2-22.3 Appendix B`）。注：FAS 原 PDF <https://r.jina.ai/https://irp.fas.org/doddir/army/fm2-22-3.pdf> 已确认目录含 `APPENDIX B SOURCE AND INFORMATION RELIABILITY MATRIX`，但 jina 抽取在 ch.3 处顺序截断，附录 B 未能直取；英军 JWP 2-00 / NATO AJP-2.1 Ed.B(2016) / STANAG 2511 属限分发 | `No basis exists for evaluating the reliability of the source` | 镜像页给出 B-1 全 6 行（`A Reliable` `No doubt of authenticity, trustworthiness, or competency; has a history of complete reliability` … `E Unreliable` `Lacking in authenticity, trustworthiness, and competency; history of invalid information`）与 B-2 全 6 行（`1 Confirmed` `Confirmed by other independent sources; logical in itself; consistent with other information on the subject` … `Doubtfully True` `Not confirmed; possible but not logical` … `6 Cannot Be Judged` `No basis exists for evaluating the validity of the information`）。NATO AJP-2.1 版另有两处独立转录可交叉验证：JDM 2025 Table 1 <https://doi.org/10.1017/jdm.2025.10007>、FIRST.org <https://www.first.org/global/sigs/cti/curriculum/source-evaluation> |
| 7 | Brier (1950) 与 ECE (Naeini 2015) 原始论文公式 | 已核实（ECE）/ 付费墙*（Brier） | ECE（已读一手全文）：<https://r.jina.ai/https://pmc.ncbi.nlm.nih.gov/articles/PMC4410090/>（Naeini/Cooper/Hauskrecht, AAAI 2015, PMC4410090）；Brier：`doi:10.1175/1520-0493(1950)078<0001:VOFEIT>2.0.CO;2`，AMS 站 Cloudflare 人机验证（`405 Method Not Allowed`），全文未取 | `ECE = \sum_{i = 1}^{K} P(i) \cdot \|o_{i} - e_{i}\|` | ECE 同页另有 `predictions are sorted and partitioned into K fixed number of bins (K = 10 in our experiments)`、`o i is the true fraction of positive instances in bin i`。Brier 公式由 NOAA 官方技术备忘录逐字复现：<https://r.jina.ai/https://repository.library.noaa.gov/view/noaa/6391/noaa_6391_DS1.pdf> → `One common way of measuring skill in probability forecasting is the Brier score (Brier , 1950),`，公式 `B = [Σ(F_i − O_i)²]/N`（OCR 行，F=预报概率、O=0 或 1、N=样本数），引文 `Monthly Weather Review, 78, 1-3`；NWS 官方词汇表：<https://r.jina.ai/https://www.weather.gov/media/owp/oh/rfcdev/docs/Glossary_Forecast_Verification_Metrics.pdf> → `The mean square error of probabilistic two-category forecasts`。**第二处独立机构转述**：AMS 2023 MWR 论文（`MWR-D-22-0268.1`）给出 `BS = (1/N) Σ (f_i − o_i)^2` 并引 Brier 1950——该处由主代理用浏览器取得；本会话经 jina 访问 `journals.ametsoc.org/downloadpdf/...` 仍只返回 `Let's confirm you are human` + `405 Method Not Allowed`，未能自行复现，故 Brier 1950 原文仍算未取 |
| 8 | 秘书问题 Dynkin 1963 / Lindley 1961 原文 | 付费墙 | Dynkin, *Soviet Math. Doklady* 1963 与 Lindley, *JRSS* 1961 均未定位到可读电子入口（旧刊，无开放正文） | 未获取正文 | Wikipedia「Secretary problem」已 fetch（三级）：`The optimal stopping rule prescribes always rejecting the first ∼n/e applicants`、`about 37%`；Ferguson 1989 "Who solved the Secretary problem?" 是可用综述线索，未 fetch |
| 9 | Price 指数的精确定义 | 付费墙 | Price, *Little Science, Big Science*（Columbia UP, 1963）——仅纸质，无公开电子版 | 未获取正文 | MetricGate（计算器文档站，非同行评议，已 fetch 正文）：<https://metricgate.com/docs/price-square-root-law/> → `it is the percentage of references younger than the window`，`PI = 100 × R_recent/R_total`，窗口默认 5 年 |
| 10 | Fellegi-Sunter 1969 的 m/u 权重公式 | 付费墙 | JASA 1969;64(328):1183–1210，<https://www.jstor.org/stable/2286061>（JSTOR 付费墙；学校 EDS 代理 302 到 `/login?error=dailyLimit`） | 未获取正文 | TU Delft 硕士论文全文（已 fetch，186 页）：<https://repository.tudelft.nl/file/File_2277475f-0c47-48df-9841-922c2302ddff> → `m(y) := P (Y = y\|M = 1)`、`u(y) := P (Y = y\|M = 0)`、`λ(y) := P(Y=y\|M=1)/P(Y=y\|M=0) = m(y)/u(y)`（式 3-5/3-9/3-12） |
| 11 | capture-recapture 闭合总体假设是否适用于"搜索引擎命中集" | 仍缺 | —（**不存在**直接论述该问题的文献；文献只是把 CR 用在搜索结果上，未讨论假设检验） | 未获取正文 | 同 TU Delft 论文 2-8-4（已 fetch）：`Capture-Recapture methods were developed to estimate the size of a closed animal population`、`This estimator assumes that the datasets are independently observed from each other`。→ 两个前提（闭合、独立观察）的原文可引，但"搜索引擎命中集满足/不满足"是**推论**，不能写成文献结论 |
| 12 | Lim & Dey 2009、progressive disclosure 的确切出处 | 已核实（progressive disclosure）/ Lim & Dey 付费墙* | <https://www.nngroup.com/articles/progressive-disclosure/>（Jakob Nielsen, 2006-12-03） | `Progressive disclosure defers advanced or rarely used features to a secondary screen` | Lim & Dey 2009（UbiComp '09，`doi:10.1145/1620545.1620576`）ACM 页 403 `Just a moment...`，MSR 出版页 404 → **该半条未取正文** |
| 13 | Knight & Leveson 1986 的具体失败率数字 | 付费墙 | IEEE TSE, SE-12(1):96–109, Jan 1986（IEEE Xplore 付费墙，未取正文） | 未获取正文 | KTH 课程摘要 PDF（已 fetch 正文）：<https://r.jina.ai/https://www.csc.kth.se/utbildning/kth/kurser/DA2210/vettig12/Seminarier/KnightLeveson.pdf> → `21 were successful for more than 99% of the test cases`、`6 reported no failure whatsoever`、`more than one program failed was substantially more than expected`（27 版本 / 100 万次测试） |
| 14 | "抽样偏差纪律"的教科书级出处 | 已核实 | <https://r.jina.ai/https://openstax.org/books/introductory-statistics/pages/1-2-data-sampling-and-variation-in-data-and-sampling>（OpenStax, *Introductory Statistics* §1.2，CC-BY 教科书） | `some members of the population are not as likely to be chosen as others` | 同节还有 `A sample that is not representative of the population is biased.` 与便利抽样/自选样本的具体告诫 |

**注 A（ACH 八步，逐字）**：1 `Identify the possible hypotheses to be considered...`；2 `Make a list of significant evidence and arguments for and against each hypothesis.`；3 `Prepare a matrix with hypotheses across the top and evidence down the side.`；4 `Refine the matrix.`；5 `Proceed by trying to disprove the hypotheses rather than prove them.`；6 `Analyze how sensitive your conclusion is to a few critical items of evidence.`；7 `Report conclusions.`；8 `Identify milestones for future observation...`（全文见注 5 的一手 URL）。

#### 口径说明

- **统计（定稿）**：已核实 7 条（#1 #2 #5 #6 #7 #12 #14；其中 #5 只有八步、#6 是转引、#7 只有 ECE 一半、#12 只有 progressive disclosure 一半）/ 付费墙 6 条（#3 #4 #8 #9 #10 #13）/ 仍缺 1 条（#11）。
- **`*` 的含义**：该行只有一部分取到正文。#7 的 `*` 指 Brier 一半仍缺（ECE 已一手核实）；#12 的 `*` 指 Lim & Dey 一半仍缺。#6 已不再带 `*`：附录 B 的 12 条描述已逐字拿到（经第三方转录）。
- **可以放宽为"结构借用"**（只借流程/名目，不引用原文措辞）：#1（27 项分段结构）、#2（"严重降 1 档、非常严重降 2 档"已是明文，可直接用）、#5（八步流程，可直接用）、#6（A–F/1–6 的 12 条描述可用，写法限定为"据 FM 2-22.3 附录 B（第三方逐字转录）"）、#14（抽样偏差定义，可直接用）、#12（progressive disclosure 定义，可直接用）。
- **仍不能写进代码/不能当条文引用**：#3（原书未读到，第二部件命名只能引 Lumen 教科书）、#4（60 图式与 CQ 原文全在付费书内）、#6 的**一手原 PDF**（附录 B 的 12 条描述内容可视为确定，但本项目没有直接打开过 FAS 那份 PDF 的 B-1 页，标注只能写"据 FM 2-22.3 附录 B（第三方逐字转录）"或"据 NATO AJP-2.1（2016）转引"，不能写"我们核对了原 PDF"）、#7 的 Brier 一半（公式由 NOAA TM 与 AMS 2023 论文两处独立转述一致，仍无 1950 原文；ECE 一半已一手核实，可直接用）、#8（1/e 结果只能引三级/综述）、#9（Price 指数只有计算器站定义）、#10（m/u 只能引学位论文的整理版）、#13（失败率数字只能引 KTH 摘要）、#12 的 Lim & Dey 一半。
- **必须改口径的两处**：(a) #5 的 **−3..+3 记分不是 Heuer 原文**，属 ACH 软件/PARC 变体，文中不能写成"Heuer 的 ACH 打分"；(b) #11 的"闭合总体假设不适用于搜索引擎命中集"是**本文推论**，只能写成"本文认为"，不能挂文献。
- 一手的真实瓶颈是**发布形态**而非检索能力：本次 6 条付费墙里，5 条是纸本书/旧刊（#3 #8 #9 #10 #13），1 条是出版社反爬墙（#4）；#6 已闭环——FM 2-22.3 附录 B 的逐字表经第三方转录取得，原 PDF 只差"我们自己翻到 B-1 页"这一步。

## 7.3 回填记录（2026-11-15）

本轮工具约束（下次续做前先读）：`web_fetch` **不支持 PDF**；`pwsh` 无外网（`Invoke-WebRequest` → `基础连接已经关闭`、`curl` → `SEC_E_NO_CREDENTIALS`），故不能下载 PDF 本地解析；**唯一可读 PDF 的通道是 `https://r.jina.ai/<原始URL>`**（返回 markdown 正文，有速率限制）。

成功入口（可复现）：
- `https://r.jina.ai/https://www.ncbi.nlm.nih.gov/pmc/articles/PMC8007028/` → PRISMA 2020 全文 + Table 1。
- `https://r.jina.ai/https://training.cochrane.org/handbook/current/chapter-14` → GRADE 四档与降级表（注意：`training.cochrane.org` 直连会跨域重定向失败，必须走 jina）。
- `https://web.archive.org/web/20070613032237/https://www.cia.gov/library/.../psychology-of-intelligence-analysis/art11.html` → ACH 八步（CIA 现行站点 404，快照可用）。
- `https://r.jina.ai/https://openstax.org/books/introductory-statistics/pages/1-2-data-sampling-and-variation-in-data-and-sampling` → 抽样偏差定义（直连 openstax 只返回页头就被截断）。
- `https://www.nngroup.com/articles/progressive-disclosure/` → 定义句。
- `https://r.jina.ai/https://repository.tudelft.nl/file/File_2277475f-0c47-48df-9841-922c2302ddff` → m/u 与 capture-recapture 假设（一手 JASA 付费墙下的最佳整理版）。
- `https://r.jina.ai/https://www.csc.kth.se/utbildning/kth/kurser/DA2210/vettig12/Seminarier/KnightLeveson.pdf` → Knight & Leveson 数字。
- `https://metricgate.com/docs/price-square-root-law/` → Price 指数公式（低权威，仅二手）。
- `https://en.wikipedia.org/api/rest_v1/page/html/Admiralty_code`、`.../Secretary_problem` → 三级源兜底（Wikipedia REST HTML 可读，正文 HTML 版比 /wiki/ 页面好抓）。
- `https://r.jina.ai/https://pmc.ncbi.nlm.nih.gov/articles/PMC4410090/` → Naeini 2015 ECE 一手全文（AAAI 站被 Anubis 墙挡，PMC 有免费版；定位办法见下条）。
- `https://api.semanticscholar.org/graph/v1/paper/DOI:10.1609/aaai.v29i1.9602?fields=title,openAccessPdf,externalIds` → **通用招法：被反爬墙挡住的会议论文，先用 Semantic Scholar Graph API 查 `externalIds` 里的 `PubMedCentral`/`ArXiv` 号，再去对应开放仓储取**（本次靠它从 DOI 拿到 PMC4410090）。
- `https://r.jina.ai/https://repository.library.noaa.gov/view/noaa/6391/noaa_6391_DS1.pdf` → NOAA TM NWS ER-61 复现 Brier 公式与 1950 年引文（.gov 机构转述，非一手）。
- `https://r.jina.ai/https://www.weather.gov/media/owp/oh/rfcdev/docs/Glossary_Forecast_Verification_Metrics.pdf` → NWS 官方 verification 词汇表里的 Brier Score 定义。
- `https://www.first.org/global/sigs/cti/curriculum/source-evaluation` → Admiralty 6×6 全 12 条描述（FIRST.org，文末自注转引 FM 2-22.3）。
- `https://r.jina.ai/http://resolve-he.cambridge.org/core/services/aop-cambridge-core/content/view/E67548E8010A47345C3439D45D9EC6B3/S1930297525100077a.pdf/effect_of_source_reliability_and_information_credibility_on_judgments_of_information_quality_in_intelligence_analysis.pdf` → JDM 2025 开放获取论文，Table 1 逐字转录「NATO AJP-2.1 source reliability and information credibility scales」（**注：这条 PDF 必须走这种 resolve-he.cambridge.org 形式，`www.cambridge.org` 直链会 302**）。
- `https://r.jina.ai/https://ki4hdu.com/preppernotes/source-and-information-reliability-matrix/` → **#6 闭环入口**：FM 2-22.3 附录 B 的 Table B-1/B-2 逐字全表，页首自注 `From Army FM 2-22.3 Appendix B`（第三方学习笔记镜像，故状态写"已核实（转引）"）。**给大 PDF 找附录时，先搜"附录名 + 表名"的笔记/课程镜像，比整本抽取快得多。**
- `https://journals.ametsoc.org/downloadpdf/view/journals/mwre/151/6/MWR-D-22-0268.1.pdf`（AMS 2023 MWR）→ 本会话仍是 `Let's confirm you are human` + `405`，但主代理用浏览器读到 `BS = (1/N) Σ (f_i − o_i)^2`，作为 Brier 公式的第二处独立机构转述（已在 §7.2 #7 注明出处归属）。

失败入口与原因（勿重复）：
- `https://files.eric.ed.gov/fulltext/ED584443.pdf`：直连=PDF 不支持；jina 两次返回 `Title:` 空 + `Markdown Content:` 空（HTTP 200 零正文）→ Toulmin ERIC 路线作废。
- `https://archive.org/download/usesofargument0000toul/...djvu.txt`：`cross-origin redirect to https://dn760101.eu.archive.org`；直连该域名 `TypeError: fetch failed`。
- `https://www.cia.gov/resources/csi/books-monographs/psychology-of-intelligence-analysis/` → **404**（CIA 改版）；`https://www.au.af.mil/au/awc/awcgate/psych-intel/` → `fetch failed`。
- `https://r.jina.ai/https://hal.science/hal-04442314v1/document`（§7.1 里那条 Admiralty 链接）→ **Anubis 反爬墙**（`Making sure you're not a bot!` + Proof-of-Work），即 §7.1 该链接实际不可读。
- `https://r.jina.ai/https://cradpdf.drdc-rddc.gc.ca/PDFS/unc351/p812555_A1b.pdf`（DRDC《STANDARDS FOR EVALUATING SOURCE RELIABILITY...》，含 Admiralty 全表）→ HTTP 422 + `page.goto: Timeout 15000ms exceeded`。
- `https://r.jina.ai/https://journals.ametsoc.org/downloadpdf/...1520-0493_1950_078_0001_vofeit_2_0_co_2.pdf`（Brier 1950）→ Cloudflare `Let's confirm you are human`，jina 报 `405 Method Not Allowed`。
- `https://r.jina.ai/https://ojs.aaai.org/index.php/AAAI/article/download/9602/9461`（ECE Naeini 2015）→ Anubis 墙，jina 亦不可过，返回缓存快照。
- `https://www.jstor.org/stable/2286061`（Fellegi-Sunter）/ `https://library.cnu.ac.kr/eds/detail/edsjsr_edsjsr.10.2307.2286061` → 前者付费墙，后者 302 到 `/login?error=dailyLimit`。
- `https://acm-stag.literatumonline.com/doi/10.1145/1620545.1620576`（Lim & Dey 2009）→ 403 `Just a moment...`；`https://www.microsoft.com/en-us/research/publication/assessing-demand-for-mobile-information-needs-...` → 404。
- `https://r.jina.ai/https://sites.stat.washington.edu/adobra/Files/Papers/Webpaper.pdf`（Dobra 等，搜索引擎 + capture-recapture）→ jina 返回 `Title: Webpaper.dvi` + 空正文（DVI 生成 PDF 无文本层）。
- `https://link.springer.com/book/10.1007/978-1-4020-4938-5` → `cross-origin redirect to https://idp.springer.com`（302 未跟随）。
- `https://r.jina.ai/https://assets.cambridge.org/97805217/23749/frontmatter/9780521723749_frontmatter.pdf`（Walton 2008 frontmatter）→ 403 `Suspicious action: Domain resolved to non-public IP: 10.9.74.155`。
- `https://r.jina.ai/http://arg.tech/people/chris/publications/2017/flap2017.pdf`（Chris Reed 论文，含 "60+ schemes"）→ 422 `net::ERR_BLOCKED_BY_CLIENT`。

第二轮（追 #6 / #7）新增失败入口：
- `https://r.jina.ai/https://journals.ametsoc.org/view/journals/mwre/78/1/1520-0493_1950_078_0001_vofeit_2_0_co_2.xml`（Brier 1950 的 XML 视图）→ `Title: Human Verification` + `405 Method Not Allowed` + `you need to verify that you're not a robot by solving a CAPTCHA puzzle`。**AMS 站点把所有视图（PDF/XML/HTML）统一放在 Cloudflare 人机验证后，jina 也过不去，Brier 原文路线到此为止。**
- `https://r.jina.ai/https://acm-stag.literatumonline.com/doi/10.5555/2888116.2888120`（ECE 的 ACM 镜像）→ `Just a moment...` + `Performing security verification`。
- `https://r.jina.ai/https://arxiv.org/pdf/1411.0161` → HTTP 200 但**是无关论文**（Honeine, *Entropy of Overcomplete Kernel Dictionaries*），Naeini 2015 的 arXiv 号不是 1411.0161，勿再试。
- `https://r.jina.ai/https://www.dni.gov/files/documents/ICD/ICD-206.pdf` → HTTP 200（Final URL `https://archive.dni.gov/files/documents/ICD/ICD-206.pdf`）、8 页、但 `Markdown Content:` 为空（无文本层）。ICD 206 也不含 A–F/1–6 表。
- `https://www.globalsecurity.org/intell/library/policy/army/fm/2-22-3/` → **403 Forbidden**；`.../fm/2-22-3/index.html` → **404**；`https://irp.fas.org/doddir/army/fm2-22-3/`（想找分章 HTML）→ **404 NoSuchKey**（FAS 只存整本 PDF）。
- `https://r.jina.ai/https://irp.fas.org/doddir/army/fm2-22-3.pdf` 的**已知限制**：文件本身 HTTP 200、384 页、确实有 `APPENDIX B SOURCE AND INFORMATION RELIABILITY MATRIX`，但 jina 顺序抽取在 ch.3（约 3-5 页）后 `(Content truncated)`，**附录 B 永远进不了抽取窗口**。要拿附录 B 只能下载 PDF 后本地按页提取——当前环境两条路都断（web_fetch 不支持 PDF；pwsh 无外网）。**后续已由第三方逐字转录镜像补上（见上条 ki4hdu.com），#6 不再需要此路。**

下次优先级建议（定稿）：**#6 已闭环（转引）**——A–F/1–6 的 12 条逐字表已拿到，只备注"第三方逐字转录、未直取原 PDF 的 B-1 页"，不必再投入。**#7 只剩 AMS 原文，可放弃**——Brier 公式已由 NOAA TM NWS ER-61 与 AMS 2023 MWR 两处独立机构转述一致，1950 原文被 Cloudflare 永久挡在门外，放弃直取；ECE 一半已一手核实。剩余可做的只有三件：**#4 Walton**（需纸质书或 Google Books 预览里 chapter 9 的 60 图式清单）、**#8 秘书问题**（试 Ferguson 1989 "Who solved the Secretary problem?" 综述，含 Dynkin/Lindley 原始结论）、**#10/#13**（若学校图书馆有 JSTOR/IEEE 权限，一次登录即可补 m/u 与失败率原表）。**#11 属"文献不存在"，不要再去搜**，只能在文中写成推论。