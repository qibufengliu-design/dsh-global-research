# 交接：全球深度研究插件（2026-11-15 自主迭代结束）

## 一句话状态

插件可日常使用（P0–P8 + 0.6.x + 0.7.0 + 0.7.1 + 0.8.0 全部完成），**已推送到 GitHub**（`main` 随 0.6.8 推过；0.7.0、0.7.1、0.8.0 尚未推）。0.8.0 起有 `scripts/retrieval-check.mjs`：不跑完整研究、不花 LLM，就能验证「检索与选页」有没有退化。

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
- 测试：18 个文件逐个跑，**310 例全绿**（`node --test test/` 与 `node --test test/<file>` 在沙箱都会 EPERM，只能 `node test/<file>.test.js` 让 node:test 在进程内跑）

## 推送

沙箱内 `git push` 需要 `sandbox_permissions: danger-full-access`（普通沙箱里 git 的凭据脚本会 `couldn't create signal pipe`）。做法：

```powershell
cd D:\Total\dsh-global-research
git -c http.sslBackend=openssl push origin main
```

凭据管理器（GCM）会弹出一次授权；若用 PAT，则 `https://qibufengliu-design:<PAT>@github.com/...`。

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

## 已知缺口（不是 bug，是数据/结构限制）

- 厂商 token 单价（如豆包）在官网 JS 渲染页后面，纯 HTTP 拿不到；`text` 参数可让用户贴正文直接进证据（0.6.0 新增）。
- 零证据判定是「选项名 token 在 claim/证据文本里是否出现」，同义词（如 Haystack 写作 `haystack-ai`）可能漏判；漏判只会多一行提示，不会编造证据。
- 输入框只能显示/复制设置路径，不能就地切档（bundle 插件无 host 写通道；要做得改 Dynamic Cordis，见 README「设置页」）。

## 下次接着做

- 推送本地提交（0.7.0 之后又多了 0.7.1 与 0.8.0 的 2 个）；
- 日常自检：怀疑「检索变差」时先跑 `node scripts/retrieval-check.mjs --question "…"`，看 `docPage/repoCode` 拆分与四数，别先跑完整研究（0.8.0）。
- 可选：`text` 参数做 UI 入口。
- 运行手册与细节：`D:\Total\docs\superpowers\specs\2026-11-15-regression-0.6.md`、`2026-11-15-p5-research-hardening.md`、`2026-11-15-cross-domain-scan.md`。