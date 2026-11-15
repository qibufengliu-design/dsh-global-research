# 安全策略

## 支持版本

| 版本 | 支持状态 |
|---|---|
| 0.9.x | ✅ 接收安全修复 |
| < 0.9 | ❌ 不再维护，请升级 |

## 报告漏洞

**请不要开公开 issue。**

通过 GitHub 的私密渠道报告：

1. 打开 <https://github.com/qibufengliu-design/dsh-global-research/security/advisories/new>
2. 写清：受影响版本、复现步骤、影响范围、修复建议（可选）

如果无法使用 Security Advisory，可先开一个**不含细节**的 issue，说明「需要私下联系」，维护者会提供渠道。

## 响应约定

- 48 小时内确认收到；
- 7 天内给出初步评估（是否影响、严重程度）；
- 修复版本发布后在 `CHANGELOG.md` 的 `### Security` 记录，并在 Advisory 中公开细节；
- 在修复发布前不公开漏洞细节。

## 本项目关心的安全面

- **提示注入**：抓到的网页正文属于不可信内容，统一包在 `<untrusted>` 中，system prompt 明确禁止执行其中指令。
- **凭据泄漏**：付费引擎 key 只允许放在 profile 的 `cordis.patch.yml` 或环境变量里，仓库内不得出现真实 key。
- **抓取面**：抓取只对用户问题与检索计划产生的 URL 发起请求；不支持自定义请求头、Cookie、内网地址穿透。不读取 `robots.txt` 是已知设计边界（见 `docs/architecture.md` 的「已知限制」）。
- **落盘数据**：缓存快照（`cache.persistPath`）与 `saveTo` 写入的是研究结果，不含 API key；`text` 参数不落盘。

## 已知边界（不算漏洞）

- 检索结果可能包含恶意网页的 **文本**——它们只会作为证据被引用，不会被执行；简报会标注来源域名。
- 免费引擎（DuckDuckGo HTML）可能返回 challenge 页，此时按「未获取」处理，不重试到死。
- 不保证对抗性网页不污染结论；重要决策请自行核对「参考」里的原始链接。