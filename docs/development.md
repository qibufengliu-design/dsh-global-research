# 开发

## 环境要求

- **Node.js ≥ 20**（开发与回归实测用 24.x；CI 覆盖 20 / 22 / 24）
- 零运行时依赖：`dependencies` 与 `devDependencies` 都为空，`npm install` 不是必需步骤
- Git、PowerShell（Windows）或任意 POSIX shell
- 真实网络回归还需要至少一个可用的搜索源（推荐免费的 Tavily key）

## 目录结构

```text
dsh-global-research/
├── index.js            # 插件入口：注册 research 工具、skill、host render
├── client.js           # Web 端卡片（tool.call.toolview → research）
├── cordis.patch.yml     # bundle patch 声明
├── lib/                # 管线与算法（16 个模块，见 docs/architecture.md）
├── test/               # 18 个测试文件，逐文件可独立运行
├── scripts/
│   ├── test-all.mjs        # 一条命令跑完全部测试
│   ├── retrieval-check.mjs # 只看「取到了什么源」的检索体检
│   └── e2e-real.mjs        # 真实网络端到端（默认跳过）
├── docs/               # 架构、配置、开发、发布文档与截图
└── .github/            # CI、Issue 表单、PR 模板
```

## 测试

```powershell
node scripts/test-all.mjs        # 全部 334 例，逐文件 spawn，失败即非零退出
node test\pipeline.test.js       # 单文件调试
node --check index.js client.js  # 语法检查
```

> 沙箱里 `node --test test/` 会因 spawn EPERM 失败，所以测试是**逐文件**跑的（`test-all.mjs` 也是这么实现的，用 `stdio: 'inherit'`）。

覆盖范围见 [README 的开发节](../README.md#开发) 与各测试文件顶部注释；改代码后如果新增行为，必须同时补测试，不允许只改实现。

## 真实网络体检

`scripts/retrieval-check.mjs` 只跑检索与抓取，不调模型，用来回答「这条问题取到了哪些源」：

```powershell
node scripts/retrieval-check.mjs --question "Java 后端做 RAG 应用，Spring AI、LangChain4j、Haystack 该怎么选" --depth standard
node scripts/retrieval-check.mjs --question "国内大模型 API 价格对比" --mode compare --json
```

输出形如：

```text
retrieval-check 0.9.1 · 2026-11-15T13:10:42.596Z
focus: 未指定 · depth: standard · mode: compare（classify 推定）

identified 54 · deduped 47 · readable 12 · adopted 10
adopted tiers: docPage 10 · repoCode 0 · other 0  (doc-index 0 / repo-doc 0 / forum 0 / blog 0 / other 0)
queries: 6（语义 4 / 技术 0 / 官方 2） · engineErrors 7 · clusters 12
```

`--json` 只把 JSON 打到 stdout，日志留在 stderr。参数：`--question`（必填）、`--focus`、`--depth`、`--mode`、`--json`、`--help`。

## 真实网络 e2e

`scripts/e2e-real.mjs` 用真实 `fetch`、真实 `lib/engines.js` 与 `lib/fetch.js` 跑一遍管线，只把 LLM 换成固定应答的假模型：

```powershell
$env:RUN_REAL='1'; $env:TAVILY_API_KEY='tvly-...'; node scripts/e2e-real.mjs
```

- 不设 `RUN_REAL=1` 时打印 `skipped (set RUN_REAL=1)` 并以 0 退出，因此**不在默认测试/CI 流程里**。
- `TAVILY_API_KEY` 可选：不设就跳过 Tavily，退回免 key 的 ddg-html + 垂直源；搜索层全被墙时脚本 FAIL（退出码 1），不静默通过。
- 断言：`queries >= 2`、`pagesFetched >= 1`、简报含 `## 参考` 与 `> 本次检索`、全程不抛错。
- `E2E_VERBOSE=1` 可看到引擎失败、证据批次与卡住的环节。

回归结论记录在 `D:\Total\docs\superpowers\specs\` 下（仓库外的工作笔记），发布前每个版本至少跑一次 A 题（RAG 选型）与一次 B/C 题。

## 调试

- `verboseLog: true`：打印引擎失败、重试。
- `debugStats: true`：简报末尾附「调试统计」（引擎、垂直源、官方直取、回补、域名）。
- 简报末尾的 `> 本次检索：…` 行给出查询数、页数、证据数、耗时与阶段耗时，先看它判断卡在哪一步。
- `stats.engines` / `stats.engineErrors` / `stats.sourceFailures` 定位是检索没召回，还是抓取失败。

## 改完代码怎么生效

| 改动位置 | 生效方式 |
|---|---|
| `lib/`、`index.js`（host 半） | `plugin_manager set_plugin target: include:global-research enabled: false` → `true` |
| `client.js`、`package.json` 的 `dsh.client` | **完全重启桌面应用**（`Ctrl+R` / `F5` 只切会话） |
| `cordis.patch.yml`、配置默认值 | 重载插件；`depthDefault` 等 volatile 字段由设置页直接改写 |

## 代码约定

- ESM（`import` / `export`），不引入任何第三方依赖——新能力优先用 Node 内置模块实现。
- 新增配置键必须同时改 `lib/config.js`（校验 + 默认值）、`docs/configuration.md`、`test/config.test.js`。
- 面向用户的文案用中文；代码注释解释「为什么」，不复述「做什么」。
- 行为变更必须同步：实现 + 测试 + `CHANGELOG.md` + 相关文档；版本号按 [docs/release.md](release.md) 递增。

## 提交与 PR

见 [CONTRIBUTING.md](../CONTRIBUTING.md)。简版：一个改动一个 commit（Conventional Commits），PR 前本地 `node scripts/test-all.mjs` 全绿。