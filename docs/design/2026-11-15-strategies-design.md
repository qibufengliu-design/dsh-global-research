# 分类驱动 + 策略包重构设计

- 状态：设计定稿，待实施（不写实现代码）
- 日期：2026-11-15
- 对象：`@local/dsh-global-research`（`D:\Total\dsh-global-research`，v0.4.0，163 例测试全绿）
- 范围：`lib/pipeline.js`、`lib/brief.js`、`lib/verticals.js`、`lib/util.js`、`lib/cache.js`、`index.js`、新增 `lib/strategy.js`
- 一句话：把散落在 6 处的"这是什么类型的问题"收编成一次 `classify()`，把"这种类型该怎么查、怎么写"变成可覆盖的数据包 `resolveStrategy()`；管线只多收一个参数。

---

## 1. 问题陈述与目标

### 1.1 现状：六套并行判定，各判各的

| # | 判定 | 位置 | 谁在读 | 它实际在回答什么问题 |
|---|---|---|---|---|
| 1 | `autoDepth` | `lib/pipeline.js:23-30` | `resolveDepth`（`:33`） | 这个问题要多深？ |
| 2 | `LEGAL_HINTS` | `lib/pipeline.js:702` | `:439`、`:559`、`:719` | 这是不是法规问题？ |
| 3 | `pickVerticals` | `lib/verticals.js:67-88` | `lib/pipeline.js:396` | 该问 GitHub 还是 arXiv？ |
| 4 | `isTimeSensitive` | `lib/util.js:223-227` | `index.js:221` | 能不能吃缓存？ |
| 5 | `codeish` | `lib/pipeline.js:48` | `buildQueries` 内联 | 该加 `site:github.com` 吗？ |
| 6 | `looksLikeFollowUp` | `lib/pipeline.js:123-127` | `:574` | 这是省略式追问吗？ |

六套判定互不知情，同一句话在不同阶段可以拿到互相矛盾的结论。真实反例（现网即可复现）：

> "欧盟《网络弹性法案》（CRA）对自建 MQTT broker 的合规义务有哪些？"

- `LEGAL_HINTS` → 是法规问题（合规、CRA），于是保留 2 个页面槽去找 EUR-Lex 原文（`:438-442`）；
- `codeish`（`:48`，`api|sdk|库|包|…` 命中）→ 判定为代码问题，给每条子问题加 `site:github.com`（`:49`），把一手法规挤出召回；
- `pickVerticals` → `DEV_HINTS` 命中，选中 github + stackexchange（`verticals.js:69-72`）；
- `autoDepth` → 无对比/选型词、focus < 2、约束词不足 → `standard`，而法规问题恰恰是最需要 `deep` 的；
- `synthPrompt` 走默认 explain 分支（`prompts.js:106-112`），不强制「存在冲突」段，也不要求"以官方原文为准"。

一个问句，四个阶段三种定性。**这不是靠再加一处 `if` 能修的**：任何新规则都必须同时知道另外五处怎么想，否则第七套判定出现，冲突面从 15 对涨到 21 对。

### 1.2 已有结构性缺陷（本设计一并处理）

- **死变量**：`lib/pipeline.js:239` 的 `resolvedMode` 计算后从未被读；`:617` 直接透传未归一化的 `mode`。非法 mode 会原样进 `synthPrompt`（落入 explain 分支），等于 mode 从未被校验。
- **缓存串味**：`lib/cache.js:12` 的 `cacheKey({question,depth,focus,language})` 无 mode，`index.js:222` 也没传 → `compare` / `track` / `evaluate` / `explain` 同一问句共享同一条缓存，改 mode 不失效。现存 bug。
- **深度无单一入口**：`DEPTH_PROFILES` 有 3 处按 key 索引（`pipeline.js:35`、`:242`、`index.js:191`）+ 16 处读已解析的 `profile.*` 字段（`pages`3/`queries`3/`wallMs`3/`synthTokens`3/`batch`2/`llmCalls`1/`gapRounds`1）。16 处全部经同一个 `const profile`，所以"bias 只调一次"在结构上成立——但前提是 bias 落在 `resolveDepth` 内部，不能散在字段上。
- **证据抽取两份**：`pipeline.js:523-547`（主循环）与 `:775-793`（`gapRefill` 内）是同一段逻辑的两次拷贝，第二份少了 `:544` 的 `logger`。
- **`ensureSections` 写死**：`brief.js:316` 硬编码「置信度 / 未解决 / 下一步建议 / 存在冲突」，无法按问题类型要求「方案对比」或「时间线依据」。
- **`kind` 命名冲突已存在**：`index.js:196` 的 `presentCall` 已有 `kind: 'read'`（卡片类型）。本设计的输出字段必须叫 `questionKind`，否则同名字段在卡片层与结果层语义相反。

### 1.3 目标（可验收）

1. **单一出口**：全仓只有 `classify()` 能回答"这是什么类型的问题"；`autoDepth` / `isTimeSensitive` / `looksLikeFollowUp` / `codeish` / `LEGAL_HINTS` / `pickVerticals` 的判定词表全部迁入 `lib/strategy.js`，其余位置只读它的输出。
2. **策略即数据**：`resolveStrategy()` 返回纯对象，字段默认值**逐字镜像**现有硬编码常量；改策略 = 改一个对象的字段，不是改管线。
3. **零新增 LLM 调用**：分类是纯正则/计分，不花 token，不引入额外延迟（目标 < 1ms）。
4. **旧行为 = golden**：不传 strategy 时，`runResearch` / `buildResult` 的输出与今天逐字节相同。
5. **可解释**：分类结果带 `signals[]` 与 `confidence`，能进 `stats` 与日志，出问题时能回答"为什么判成这个类"。

---

## 2. 七个 questionKind

### 2.0 判定算法（`classify()` 内部）

1. 把 `question + focus.join(' ')` 拼成 `text`；`subQuestions` 只参与 `codeish` 的附加计分，不改变 kind。
2. 每个 kind 有一张**信号表**（`SIGNALS[kind] = [{ id, re, weight }]`），逐条 `test` 累加。
3. 加成项：`focus.length >= 2` → tech-selection +2；`/^[必须需限]/` 计数 `>= 2` → tech-selection +1；`mode` 显式值 → tech-selection(`compare` +3 / `evaluate` +1)、fresh-data(`track` +2)。
4. **平局与优先级**（越具体越靠前，法规优先是安全考虑）：
   `legal > troubleshoot > contested > fresh-data > tech-selection > learning > concept`。
5. **门槛**：`top < 2` → 落 `concept`，`confidence = 0.35`；`top ∈ {2}` → 0.5；`top ∈ {3,4}` → 0.7；`top >= 5` → 0.9。`LEGAL_STRONG`（`法规|条例|指令|法案|合规|eur-lex|gdpr|ai act|cra|regulation|directive|compliance`）单条命中即权重 +3，因此法规问题不会被门槛压回 concept。
6. 词表**逐字搬运**现有常量（`DEEP_SIGNALS` `:20`、`QUICK_SIGNALS` `:21`、`LEGAL_HINTS` `:702`、`TIME_SENSITIVE` `util.js:223`、`BUG_HINTS` `verticals.js:15`、`codeish` `:48`、`looksLikeFollowUp` `:126`），新词表只补 `contested` / `learning` 两个现有缺失的类。搬运时保留原正则的怪癖（见 §4.1），否则 golden 漂移。

### 2.1 tech-selection 技术选型

- **命中词**：`DEEP_SIGNALS` 全集——`对比|选型|调研|方案|迁移|替代|是否值得|取舍|优劣|benchmark|\bvs\.?\b|compare|comparison|migrate|migration|alternatives?|trade-?offs?|which .* should`（权重 3；`对比|选型|vs|compare` 为强词）
- **focus 加成**：`focus.length >= 2` → +2（镜像 `autoDepth:25`）；`mode === 'compare'` → +3
- **query 模板**：`A vs B benchmark 2026`、`X alternatives`、`X migration guide`、`X 迁移 成本`、`A 与 B 对比 优缺点`
- **来源偏好**：`github`、`stackexchange`、`hn`、`docs`（`verticals.prefer`）；官方文档优先于博客
- **必出章节**：`## 方案对比`（≥2 方案表）、`## 坑与风险`、`## 结论`（含适用条件）
- **校验规则**：对比表行数 ≥ 2；结论必须写成"在 X 条件下选 A，在 Y 条件下选 B"；只有单一方案时降档并在「## 未解决」写明候选不足
- **置信度门槛**：`gate = medium`（`high` 需 `confirmed >= 2` 且 `primaryDomains >= 2`）
- **策略差量**：`mode: 'compare'`、`depth.bias: +1`、`synthesis.requireConflict: false`、`verticals.prefer: ['github','stackexchange','hn','docs']`

### 2.2 fresh-data 时效数据

- **命中词**：`TIME_SENSITIVE` 全集——`最新|当前|目前|现在|今年|本月|本周|今天|刚刚|发布|上线|价格|定价|收费|支持到|EOL|过期|停止维护|latest|current|today|this (week|month|year)|release[ds]?|price|pricing|cost|end of life|deprecated`（权重 3）
- **focus 加成**：无（时效是问题属性，不是评估维度）；`mode === 'track'` → +2
- **query 模板**：`X release notes`、`X LTS schedule`、`X pricing 2026`、`site:<vendor 官方域> X`、`X EOL dates`
- **来源偏好**：官方发布页 / 定价页 / 版本表（`official`），`publishedAt` 必须参与排序与展示
- **必出章节**：`## 依据`（每条带日期或标"日期未确认"）、`## 置信度`
- **校验规则**：复用 `synthPrompt:150` 的减法算式硬规则；无日期的时效论断不得写成现在时；`isTimeSensitive = true` → 缓存整体跳过（沿用 `index.js:221`）
- **置信度门槛**：`gate = medium`；`high` 需 ≥1 官方域且最新证据 `ageDays <= 365`
- **策略差量**：`depth.bias: 0`、`synthesis.dateRule: true`、`validation.staleDays: 365`

### 2.3 contested 争议观点

- **命中词**：继承 `verticals.js:76`——`opinion|discussion|experience|worth|should i|best|alternatives|值得|推荐|体验|看法|对比`（权重 2）+ 新增 `争议|分歧|有人说|质疑|反对|诟病|是否值得|值不值|controversial|debate|overrated|underrated|criticism|backlash`（权重 3）
- **focus 加成**：无；`mode === 'evaluate'` → +1
- **query 模板**：`X criticism`、`X limitations`、`X 争议 反对`、`X vs Y 真实体验`、`X 生产环境 踩坑`
- **来源偏好**：`hn`、`stackexchange`、`forum` 博客；官方文档只作为"官方口径"一方，不能单独定论
- **必出章节**：`## 存在冲突`（现有 `CONFLICT_HEADING`，必须有双方 `[S#]`）、`## 坑与风险`
- **校验规则**：`disputed` 簇必须逐条列出双方说法；禁止"专家认为/业界普遍认为"；只有一方有来源时写"另一方未见来源"，不得并列成平局
- **置信度门槛**：`gate = medium`；`high` 需冲突双方各有 ≥1 独立域名
- **策略差量**：`synthesis.requireConflict: true`、`verticals.prefer: ['hn','stackexchange']`、`mode: 'explain'`（不强制 compare 表）

### 2.4 legal 法规合规

- **命中词**：`LEGAL_HINTS` 逐字——`法规|条例|指令|法案|合规|认证|监管|标准原文|regulation|directive|compliance|certification|eur-lex|gdpr|ai act|\bcra\b`（权重 3，全部视为强词）
- **focus 加成**：无
- **query 模板**：`site:eur-lex.europa.eu <topic>`、`site:europa.eu <topic>`、`site:gov <topic>`、`<act name> official text`；直链优先 ELI 形式（`https://eur-lex.europa.eu/eli/reg/…/oj`）
- **来源偏好**：仅 official（`europa.eu` / `eur-lex.europa.eu` / `.gov` / 标准组织），二手解读只能补充
- **必出章节**：`## 依据`（一手原文优先）、`## 未解决`（缺一手时必须列真实缺口）
- **校验规则**：`hasPrimary === false` → `confidence` 强制 `low` 且结论首行「初步判断（证据不足）」（沿用 `pipeline.js:602-605` 与 `prompts.js:151`）；`needsLegalText` 为真时缺口回补必须发出至少 1 条 `site:eur-lex.europa.eu` query（沿用 `primaryTargetQueries` `:715-727`）
- **置信度门槛**：`gate = high`；`requirePrimaryForHigh: true`、`minPrimaryDomains: 2`、`primaryMissingCap: 'low'`
- **策略差量**：`validation.requirePrimary: true`、`pages.reserve.primary: 2`、`depth.bias: +1`、`verticals.prefer: []`（法律问题不该去 GitHub）

### 2.5 troubleshoot 排障

- **命中词**：`BUG_HINTS` 逐字——`bug|issue|error|exception|crash|regression|报错|错误|崩溃|异常|复现`（权重 3）+ 新增 `无法|失败|超时|不工作|装了没反应|报错怎么修|stack trace|traceback|not working|fails?|broken|hangs?`（权重 2）
- **focus 加成**：无；`text` 里出现代码块/堆栈特征（`\bat .+\(.+:\d+\)`、`Error:`、`Traceback`）→ +2
- **query 模板**：`<error message> <stack/framework>`、`site:stackoverflow.com <error>`、`site:github.com/<org>/<repo> issues <error>`、`<error> 解决`
- **来源偏好**：`stackexchange`、`github`（issues）、`docs`；博客最后
- **必出章节**：`## 结论`（可执行修复步骤）、`## 下一步建议`（要跑的命令/要贴的日志）
- **校验规则**：结论或依据里至少 1 条 `forum` 或 `repo` 证据（沿用 `prompts.js:154`）；没有可复现线索时在「## 未解决」写"缺少错误原文/版本号"
- **置信度门槛**：`gate = medium`
- **策略差量**：`synthesis.forumRequired: true`、`verticals.prefer: ['stackexchange','github','docs']`、`depth.bias: 0`

### 2.6 learning 学习路径

- **命中词**（新增，现有六套判定都没有这一维）：`怎么学|如何学|入门|学习路线|从零|零基础|教程|手把手|先学什么|进阶|roadmap|learn|learning path|getting started|tutorial|curriculum|prerequisites`（权重 3；`入门|学习路线|roadmap|getting started|从零` 为强词）
- **focus 加成**：无
- **query 模板**：`X roadmap 2026`、`X 官方教程`、`X beginner guide`、`X 学习顺序 先学什么`、`site:developer.mozilla.org X`（语言/前端类）
- **来源偏好**：`docs`（官方教程）、`stackexchange`、`hn`；课程站只作补充
- **必出章节**：`## 依据`、`## 下一步建议`（每条能直接执行：打开哪个 URL、做哪个练习）
- **校验规则**：禁止"继续关注/保持学习"类空话（沿用 `prompts.js:153`）；每条建议必须带可打开的链接或可执行的练习
- **置信度门槛**：`gate = medium`
- **策略差量**：`synthesis.stepRequired: true`、`verticals.prefer: ['docs','stackexchange','hn']`、`depth.bias: 0`

### 2.7 concept 通用概念（兜底）

- **命中词**：`QUICK_SIGNALS` 逐字——`是什么|多少|哪一年|谁|定义|what is|who is|how many|when did`（权重 2）；`WIKI/百科/定义/原理` +1
- **focus 加成**：无（有 ≥2 focus 时已被 tech-selection +2 抢走）
- **query 模板**：`X 定义`、`X 原理`、`X wikipedia`、`X official docs`；沿用 `buildQueries` 现有三段式（`sub` / `sub+focus` / `site` 或 `官方`）
- **来源偏好**：无偏好（`verticals.prefer: []` → 沿用 `pickVerticals` HINTS 打分）
- **必出章节**：现有默认六段（结论/依据/方案对比/坑与风险/置信度/未解决/下一步建议）
- **校验规则**：现有全部硬规则（`prompts.js:147-160`）原样生效，不额外加码
- **置信度门槛**：`gate = high`（即不设上限，行为等于今天）
- **策略差量**：**全部默认值**——`concept` 与"不传 strategy"必须等价（golden 的锚点）

---

## 3. 接口签名

### 3.1 `classify(input) → Classification`

```js
classify({
  question = '',            // string，必填；空串 → concept@0.35
  focus = [],               // string[]
  mode = 'explain',         // 'explain'|'compare'|'track'|'evaluate'；非法值按 'explain' 计分
  subQuestions = [],        // 只影响 codeish 附加分
  config = {},              // 预留：未来 config.strategySignals 覆盖词表；当前不读
}) → {
  questionKind,    // 7 值之一，默认 'concept'
  confidence,      // number 0..1，默认 0.35
  scores,          // Record<kind, number>，全 0 起步
  margin,          // number，top - runnerUp，默认 0
  runnerUp,        // kind 名或 null
  signals,         // string[]，命中的信号 id，如 'kw:vs'、'focus:>=2'、'mode:compare'
  keywords,        // string[]，命中的字面词，用于 query 模板占位
  // —— 以下五个布尔是"收编"的既有判定，全部由同一份词表算出 ——
  followUp,        // 镜像 looksLikeFollowUp（pipeline.js:123-127）
  timeSensitive,   // 镜像 isTimeSensitive（util.js:223-227）
  codeish,         // 镜像 codeish（pipeline.js:48）
  legalText,       // 镜像 LEGAL_HINTS（pipeline.js:702）
  depthHint,       // 'quick'|'standard'|'deep'，镜像 autoDepth 的输出
  signalVersion,   // number，当前 1；词表变更必须 +1（进 cacheKey）
}
```

`depthHint` 的镜像规则（保证 `autoDepth` 的 3 个基线断言不变）：`top === tech-selection 且 confidence >= 0.7` → `deep`；`focus >= 2` 或 约束词 `>= 2` → `deep`；`text.length < 60 && concept 命中` → `quick`；否则 `standard`。

### 3.2 `resolveStrategy(classification, options) → Strategy`

`options = { mode, config }`；`mode` 是调用方显式传入的 `args.mode`（未传则 `undefined`，用于区分"用户没说"与"用户说 explain"）。

```js
{
  questionKind: 'concept',   // = classification.questionKind
  signalVersion: 1,          // = classification.signalVersion
  confidence: 0.35,          // = classification.confidence，不重算
  reason: 'fallback:no-signal',  // 命中信号摘要；只进 stats/日志，不进简报正文
  mode: 'explain',           // 显式 mode 优先；否则取 kind 的建议值
  depth: {
    bias: 0,                 // -1|0|1，只在 resolveDepth 对由 auto 派生的 requested 加一次
    floor: 'quick',          // 下限（不加 bias 时的合法域）
    ceiling: 'deep',         // 上限；仍受 maxDeepPerSession 二次 clamp
  },
  queries: {
    siteTargets: [],         // [] = 沿用 :49 的 `site:github.com` / `官方` 二选一（镜像）
    primaryTargets: [],      // [] = 沿用 primaryTargetQueries() 现分支（镜像）
    perSubVariants: ['sub', 'sub+focus', 'site|official'],  // 镜像 buildQueries:41-50
    latinBoost: true,        // 镜像 :60-63
    maxLen: 100,             // 镜像 :55 与 :339
  },
  verticals: { prefer: [], deny: [], limit: 2 },  // [] = 沿用 HINTS 打分；2 = 镜像 :85
  pages: {
    reserve: { vertical: 1, primary: 2 },   // 镜像 :433
    refillReserve: 2,                        // 镜像 :440-442
    officialHop: true,                       // 镜像 :502-516 与 :763-773
    refillMax: 4,                            // 镜像 :753
  },
  evidence: {
    heuristicFallback: true, // 镜像 :539-545
    fallbackLog: true,       // 镜像 :544 的 logger（第二份拷贝缺它，抽取时必须保留）
    maxPerPage: 6,           // 镜像 evidencePrompt:53
    types: ['official','docs','repo','paper','forum','blog','news'],  // 镜像 :172
    groundMinChars: 12,      // 镜像 isGrounded:155
  },
  synthesis: {
    sections: null,          // null = 沿用 ensureSections 现硬编码；数组 = 参数化后的必出章节
    requireConflict: false,  // contested → true
    dateRule: false,         // fresh-data → true
    forumRequired: false,    // troubleshoot → true
    stepRequired: true,      // 镜像 ensureSections:344-346
  },
  validation: {
    requirePrimary: false,   // legal → true
    minSources: 1,           // 镜像现状（validateCitations 无下限）
    staleDays: 730,          // 镜像 appendReferences:216-217
  },
  confidence: {
    gate: 'high',            // 允许的最高档；'low' 时直接封顶
    requirePrimaryForHigh: true,  // 镜像 computeConfidence:150
    minPrimaryDomains: 2,         // 镜像 :147-150
    primaryMissingCap: 'low',     // 镜像 pipeline:602-605
  },
}
```

**默认值即镜像**：上表每个字面量都能在右侧注明的行找到出处；`concept` 不覆盖任何字段，因此"`concept` 策略" ≡ "不传 strategy"。

### 3.3 配套签名（与 §4 的接入点一一对应）

```js
resolveDepth({ depth, question, focus, config, deepUsed = 0, strategy })  // 新参 strategy，可选
buildQueries(subQuestions, focus, question, limit, strategy)              // 新参 strategy，可选
pickVerticals({ question, focus, subQuestions = [], enabled = {}, prefer = [], deny = [], limit = 2 })  // 三个新键，默认空/2 = 旧行为
extractEvidence(batch, strategy)   // 新增，返回 evidence[]；strategy 可选
ensureSections(brief, confidence, gaps, conflicts = [], sections)         // 第 5 参；不传 = 旧行为；不改名
cacheKey({ question, depth, focus, language, mode, questionKind, signalVersion })  // 后三个可选
```

---

## 4. 八个接入点

全部是**加参数**，不改调用顺序、不新增分支流程、不移动阶段边界。

| # | 文件:行 | 改法 |
|---|---|---|
| 1 | `index.js:221-233` | 缓存判定前先算 `const classification = classify({ question, focus, mode: args?.mode, config })` 与 `const strategy = resolveStrategy(classification, { mode: args?.mode, config })`；`timeSensitive` 改读 `classification.timeSensitive`；`cacheKey` 增传 `mode`、`questionKind`、`signalVersion`（修 §1.2 串味）。仍是"先算 key 再 get"，无一行业务流程变动。 |
| 2 | `index.js:243-259` | `runResearch({ ... })` 增传 `classification`、`strategy` 两个字段；`OUTPUT_SCHEMA` 增 `questionKind`（非 required，`enum` 七值）。`presentCall` 的 `kind:'read'` 与 `args` 一律不动。 |
| 3 | `lib/pipeline.js:23-30` + `:32-36` | `autoDepth` 函数体改为 `return classify({ question, focus }).depthHint`（签名与导出不变，`test/brief.test.js:161-166` 继续过）；`DEPTH_PROFILES` 与 16 处 `profile.*` 全部不动；`resolveDepth` 增收 `strategy`，只在 `requested` 上把 `bias` 加一次，然后 `floor/ceiling` clamp，再走 `maxDeepPerSession` 二次 clamp。`:191` 的 `DEPTH_PROFILES.deep.wallMs` 是工具超时上界，**不加 bias**。 |
| 4 | `lib/pipeline.js:39-65` + `:123-127` + `:574` | `buildQueries` 增第 5 参 `strategy`：`codeish` 改读 `strategy?.codeish`（缺省回落 `:48` 的本地正则）；`site` 目标与变体顺序取自 `strategy.queries`。`looksLikeFollowUp` 保留导出（3 个测试在用），但 `:574` 的调用改读 `classification.followUp`。 |
| 5 | `lib/pipeline.js:396-401` + `lib/verticals.js:67-88` | `pickVerticals` 增 `prefer / deny / limit`：`prefer` 非空时先按 prefer 顺序取并跳过 `deny`，不足 `limit` 再用现有 HINTS 打分补位；`prefer` 为空时**完全走现有打分**（22 例垂直源测试不动）。管线只把 `strategy.verticals` 三个键摊进去。 |
| 6 | `lib/pipeline.js:438-442` + `:559-560` + `:715-727` | 三处 `LEGAL_HINTS.test(...)` 改读 `strategy.legalText`（分类时算好，不再重复 test）；`primaryTargetQueries(question, focus, strategy)` 增第 3 参，`primaryTargets` 非空时用它，空则走现有 `:719-726` 分支。`LEGAL_HINTS` 常量迁入 `strategy.js`。 |
| 7 | `lib/pipeline.js:518-547` 与 `:775-793` | 抽出 `extractEvidence(batch, strategy)` 放在 `:518` 之前：内部完成 `clampLlm` → `jsonCall(evidencePrompt)` → `toEvidence` 过滤 → `items.length === 0` 时 `heuristicEvidence` 回退与 `logger`（保留 `:544` 那行）。两处调用各缩成一行 `state.clusters = mergeClusters(state.clusters, groupEvidence(await extractEvidence(batch, strategy)))`。这是唯一"提炼函数"的接入点，因为两份拷贝不抽就无法按 kind 切策略。 |
| 8 | `lib/brief.js:316-348` + `:350-365` | `ensureSections(brief, confidence, gaps, conflicts = [], sections)`：`sections` 为 `[{ heading, fallback }]` 数组，缺段时按序补（`fallback` 为空则补占位"不适用/未发现"）；`sections == null` 时执行现有硬编码逻辑，逐字不变。`buildResult` 增收 `questionKind` 与 `strategy`，把 `strategy.synthesis.sections` 传入，并在返回对象上写 `questionKind`。**`buildResult` 不把 questionKind 写进 brief 正文**（否则 golden 与卡片切片都变）。 |

### 4.1 行号核对（与审计稿的差异，实施时以此表为准）

| 审计稿 | 实测 | 说明 |
|---|---|---|
| `autoDepth`(pipeline:20) | `:23-30` | `:20` 是 `DEEP_SIGNALS` 常量本身 |
| `pickVerticals`(verticals:13-21) | `verticals.js:67-88` | `:13-21` 是 `DEV_HINTS`/`RESEARCH_HINTS`/`DOCS_HINTS` 等词表 |
| `isTimeSensitive`(util:223) | `util.js:225-227` | `:223` 是 `TIME_SENSITIVE` 常量 |
| `looksLikeFollowUp`(:126) | 声明 `:123`，正则 `:126` | 两者都对，指代不同 |
| `LEGAL_HINTS`(:702) / `codeish`(:48) / `ensureSections`(brief:316) | 一致 | — |
| `prompts.js`（127 行） | **167 行** | `synthPrompt` 已含 mode 四分支（`:106-112`）与 8 条硬规则（`:147-160`），设计要按现状盘 |
| `DEPTH_PROFILES` 被 13 处直读 | 3 处 key 索引 + 16 处 `profile.*` 字段读 | 3 处是 `pipeline.js:35`、`:242`、`index.js:191`；16 处明细见 §1.2 |
| （未提） | `DEPTH_PROFILES.*.candidates`（12/40/80）是死字段 | 全仓无读取点，实施时保留不动、不纳入策略 |

### 4.2 为什么 bias 一处就够

`runResearch` 里所有深度相关读数都过同一个 `const profile = DEPTH_PROFILES[resolvedDepth]`（`:242`），`gapRefill` 拿的是同一个对象引用（`:565` 传入）。因此 bias 只要落在 `resolveDepth` 返回的 `resolvedDepth` 上，16 处字段读自动生效，无需在字段层再乘系数——这也正是"不改 `DEPTH_PROFILES` 结构"的原因。

---

## 5. 退化与兼容

| 场景 | 行为 | 依据 |
|---|---|---|
| `classify` 无信号 / `top < 2` | `questionKind = 'concept'`，`confidence = 0.35`，策略取全默认 | `concept` ≡ 旧行为 |
| `resolveStrategy` 收到未知 kind（调用方手写/旧快照） | 按 `concept` 出策略，并在 `reason` 记 `fallback:unknown-kind` | 未知不崩、不猜 |
| 策略字段缺失（部分对象/旧版本对象） | 逐字段回落 `STRATEGY_DEFAULTS`（深合并，只补不覆盖） | "字段缺失 → 回退现有常量" |
| `strategy == null`（旧调用方、单测直接调 `runResearch`） | 管线走现有代码路径；`resolveDepth` 用 `autoDepth`，`buildQueries` 用本地 `codeish`，`extractEvidence` 用默认回退 | 旧行为 = golden |
| `mode` 非法值 | `classify` 按 explain 计分；`resolveStrategy.mode` 归一为 `explain`（修 §1.2 死变量，同时把归一结果真正喂给 `synthPrompt`） | 与 `synthPrompt` 的默认分支一致 |
| 缓存 | `cacheKey` 增 mode/kind/version → 升级后老键全部 miss，一次性重跑成本；不做迁移（进程内缓存，重启即空） | 可接受的代价，修的是串味 bug |
| 卡片/渲染 | 结果新增 `questionKind` 字段，不改 `brief` 正文字节；`client.js:67-74` 按 `## ` 切章节，策略新增章节必须复用现有八个 heading 文案 | 不改 heading 文案 |

开关策略：不新增配置项。`index.js` 总是传 strategy 进来；需要回滚时删掉 §4 第 1、2 行的两个入参即可回到 PR1 的收编态（PR1 本身不改行为）。

---

## 6. 迁移步骤（3 个 PR）

### PR1 — 收编判定（零行为变更，~250 行新增 + ~80 行删改）

1. 新建 `lib/strategy.js`：`SIGNALS` 词表（六套常量逐字迁入）、`classify()`、`QUESTION_KINDS`、`SIGNAL_VERSION`。
2. `pipeline.js` 的 `autoDepth` / `buildQueries` 内联 `codeish` / `looksLikeFollowUp` / `LEGAL_HINTS` 改为委托 `classify()`。`util.js` 的 `isTimeSensitive` 与 `TIME_SENSITIVE` 常量迁入 `strategy.js`，`util.js` 只保留一行 `export { isTimeSensitive } from './strategy.js'`。**依赖方向固定为 `util → strategy`，`strategy.js` 不 import `util.js`**（自带 clamp/占位小工具），因此无循环 import；`util.test.js` 与该函数的既有调用方（`index.js:16`）导入路径不变。
3. **验收**：全仓只有一个地方 `test()` 这些正则；163 例全绿；额外加 7 例分类断言（§7 的 T1–T7）；`autoDepth` 三个基线断言逐字不变。

### PR2 — 策略生效（~120 行，行为变更只发生在非 concept 类）

1. `lib/strategy.js` 增 `STRATEGY_DEFAULTS` 与 `resolveStrategy()`；7 个 kind 的差量表按 §2 落地。
2. 接 §4 的 1–7 号接入点；`resolveDepth` 的 bias clamp 顺序固定为 `requested + bias → floor/ceiling → maxDeepPerSession`。
3. `cacheKey` 增 mode/kind/version（修 bug），`index.js` 传参。
4. **验收**：`questionKind === 'concept'` 与 `strategy == null` 两条路径对同一输入产出逐字节相同的 `buildResult`（A/B 快照测试）；`compare/track/explain` 三个 cacheKey 互不相同；163 例全绿。
5. 回滚：删 1、2 号入参即回 PR1。

### PR3 — 断言冲突与参考完整性（~80 行）

1. `ensureSections` 第 5 参 `sections` 参数化（`sections == null` 走旧逻辑，逐字不变）；`buildResult` 传 `strategy.synthesis.sections` 并输出 `questionKind`。
2. 新增 `assertStrategy(result, strategy)`（`lib/brief.js` 或 `lib/strategy.js`）：按 §2 的"校验规则"检查——compare 表是否存在且 ≥2 行、contested 是否真有「## 存在冲突」、legal 是否 `hasPrimary`、troubleshoot 是否引用了 forum/repo、`[S#]` 是否全部可解析、来源数是否 `>= validation.minSources`；违规不改写正文，只追加到 `gaps` 并把 `confidence` 按 `gate` 封顶。
3. **验收**：12 个测试文件全绿（含新增）；legal 无一手场景 `confidence === 'low'` 且 gaps 含"缺少一手或高质量来源"。

---

## 7. 测试计划（新增 14 例 + 163 基线不破）

| ID | 文件 | 断言 | 覆盖接入点 |
|---|---|---|---|
| T1 | `test/strategy.test.js`（新） | `classify('pnpm vs yarn，2026 该选哪个')` → `tech-selection`，`depthHint === 'deep'`，`signals` 含 `kw:vs` | 1、3 |
| T2 | 同上 | 法规+选型混问（"CRA 对自建 broker 的合规要求，Vercel 是否满足"）→ `legal` 胜出，`codeish === true` 但 `verticals.prefer === []` | 2.0 优先级、5 |
| T3 | 同上 | `classify('现在 Node 最新 LTS 是哪个版本')` → `fresh-data`，`timeSensitive === true` | 4 |
| T4 | 同上 | `classify('有人说 2026 年不值得再学 jQuery，你怎么看')` → `contested`，策略 `requireConflict === true` | 2.3 |
| T5 | 同上 | 带 `Error: spawn EPERM` + 堆栈的排障问 → `troubleshoot`，`forumRequired === true` | 2.5 |
| T6 | 同上 | `classify('从零学 Kubernetes 的学习路线')` → `learning`（现有六套判定都没有这个词表，回归"新增类也能命中"） | 2.6 |
| T7 | 同上 | 未知/空/超短问（"嗯"）→ `concept`，并断言 `resolveStrategy(concept)` 深等于 `STRATEGY_DEFAULTS` | 5 |
| T8 | 同上 | **词表等价性**：对 `[DEEP_SIGNALS, QUICK_SIGNALS, LEGAL_HINTS, TIME_SENSITIVE, BUG_HINTS, codeish, followUp]` 各取 3 条样例，旧实现与 `classify` 的布尔结果 100% 相同（防搬运漂移） | PR1 |
| T9 | 同上 | `resolveStrategy` bias 只生效一次：显式 `depth:'quick'` 不被降级；`auto` + legal（bias +1）在 `deepUsed >= maxDeepPerSession` 时被 clamp 回 `standard` | 3 |
| T10 | `test/cache.test.js` | `cacheKey(..., mode:'compare') !== cacheKey(..., mode:'track') !== cacheKey(..., mode:'explain')`；`questionKind/signalVersion` 变化也换 key | 1（修现存 bug） |
| T11 | `test/pipeline.test.js` | 同一 batch 分别走主循环与 `gapRefill`：`extractEvidence` 产出的 evidence 数组逐字段相等，且 0 条时回退 heuristic 并打日志 | 7 |
| T12 | `test/brief.test.js` | `ensureSections(b, c, g, [], [{heading:'## 方案对比', fallback:'不适用'}])` 缺段补齐；不传第 5 参时输出与旧快照 `assert.equal` | 8 |
| T13 | `test/pipeline.test.js` | golden：`strategy=null` 与 `kind='concept'` 的 strategy，对同一 question 产出 `assert.deepEqual(result)`（除 `elapsedMs` 等时间字段） | 5 |
| T14 | `test/verticals.test.js` | `pickVerticals({prefer:['docs'], deny:['github'], limit:1})` 命中 docs；`prefer` 为空时结果与现有 22 例一致 | 5 |

基线守护：实施每步跑 `node --test test/`，要求 163 例逐条不破；`test/brief.test.js:161-166`（`autoDepth`/`resolveDepth`）与 `test/verticals.test.js`（22 例）是首要回归面。**只加断言，不改既有断言**。

---

## 8. 明确不做的事

1. **不新增 LLM 调用**：分类与策略解析是纯函数，零 token、零网络、零额外阶段计时。
2. **不改 `DEPTH_PROFILES` 的结构与数值**：不加字段、不缩放、不按 kind 造新档位；bias 只影响"选哪一档"。
3. **不改 heading 文案与顺序**：`CONFLICT_HEADING`/`NEXT_STEPS_HEADING`（`brief.js:11-12`）与八个 `## ` 标题逐字不动，`client.js:67-74` 的解析依赖它们。
4. **不重命名 `ensureSections`**，不动前 4 个参数顺序；只加第 5 参。
5. **不引入 `kind` 字段**：输出一律 `questionKind`；`presentCall` 的 `kind:'read'` 与卡片侧字段不改。
6. **不改工具参数表面**：不新增 `questionKind`/`strategy` 入参，`mode` 仍四值；分类对调用方不可见（只进 `stats`/日志/结果字段）。
7. **不重写 `evidencePrompt` / `synthPrompt` 的正文结构**：策略只决定"哪些已有规则被强制/校验"，不改模板文字，不改 `≤120 字`、`≤6 条/页` 等既有约束。
8. **不引入向量/embedding/小模型分类器**：纯正则 + 计分，保确定性、可测、可解释。
9. **不改缓存存储结构与 TTL**：只改 key 的构成；`ResearchCache` 内部不动。
10. **不动 `validateCitations` 的编号与清理算法**：策略只新增"事后断言 + gaps 追加"，不改写简报正文的引用编号。
11. **不改 `lib/fetch.js`、`lib/engines.js`、`lib/sessions.js`、`client.js`**：本次重构不碰抓取层与渲染层。
12. **不为 `concept` 类加任何新约束**：它是 golden 锚点，行为必须与今天完全一致。

---

## 实施记录（2026-11-15 完成）

- **提交**：PR1 `3820ff5`（收编判定，零行为变更）、PR2 `ed414f0`（策略生效）、PR3 `2cec9d2`（断言冲突与参考完整性）；后续 P6 `5a57a3e`（证据保数字、表格值入参考、官方价目页直取）、P7 `72b4f8d`（数值容量冲突 + 属性归一）。
- **测试**：163 例基线全绿，最终 **228 例**；新增 `test/strategy.test.js`（11 例）与 `test/strategy-packs.test.js`（16 例），其余为断言、简报、管线用例的扩充。
- **三问回归**：
  - 参考完整性 **3/3**：三问的参考末尾都出现了「另有 N 个页面被读取但未采用（域名）」。
  - 冲突 **1/3**：结构冲突只在 1 问上命中；数值冲突已补齐——价格/版本/日期/容量在属性归一后并列（如「输出上限 384K vs 256K」），并在「## 存在冲突」里排在结构冲突之前。
  - 一手来源：只有 DeepSeek 价目页能直取成功；阿里云 / 智谱 / 火山三家仍缺（抓取失败会以「官方价目页未取到：域名」写进「未解决」）。
- P8（7793d8d）：数值冲突加实体维度，跨实体口径进未解决；237 测试；发布 0.5.3