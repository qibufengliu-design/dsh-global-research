# 设计文档索引（design notes）

这些文档记录了插件从 0.x 到 1.0 的设计推理、实验与回归证据。**它们是历史记录，不是当前行为的规范**；当前行为以代码、`README.md`、`docs/architecture.md` 与 `CHANGELOG.md` 为准。

| 文档 | 内容 | 时效 |
|---|---|---|
| [global-research-design](2026-11-14-global-research-design.md) | 最初的需求与 P1 设计：工具接口、8 步管线、预算表、失败处理 | 0.1 基线，接口已多次演进 |
| [cross-domain-scan](2026-11-15-cross-domain-scan.md) | 跨学科方法普查：10 领域 26 项方法论、已在用但没命名的 16 处、负结果 7 条、待核实 14 条（已回填 7/6/1） | 0.6 前后的输入 |
| [strategies-design](2026-11-15-strategies-design.md) | 策略引擎：7 类 questionKind、classify/resolveStrategy、8 个接入点、PR 迁移计划 | 0.5 的依据 |
| [source-plan-design](2026-11-15-source-plan-design.md) | `sourcePlan` 取源通道分层（引擎 / 通道 / 取源方式），渲染兜底的门控与降档 | 0.6 |
| [p5-research-hardening](2026-11-15-p5-research-hardening.md) | P5 加固清单：缓存时效、追问续跑、过程可见、导出、失败分层、研究类型、检索质量 | 0.6–0.9 |
| [regression-0.6](2026-11-15-regression-0.6.md) | 0.6–1.0 的真实网络回归记录（A/B/C 三题，含四数、来源构成、结论） | 每版更新，最新在 1.0.x |
| [repo-hygiene-audit](2026-11-15-repo-hygiene-audit.md) | 仓库整洁性审计与 CI 门禁的由来 | 发布准备期 |

阅读顺序建议：`global-research-design` → `strategies-design` → `source-plan-design` → `p5-research-hardening` → `regression-0.6`。

> 这些文件原先在 `docs/design/`（工作区级），1.0.2 起镜像进仓库，方便迁移后追溯；原位置可能仍有更新版本，以仓库镜像为准的约定见 `HANDOFF.md`。