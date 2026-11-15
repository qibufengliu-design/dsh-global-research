# 交接：全球深度研究插件（2026-11-15 自主迭代结束）

## 一句话状态

插件可日常使用（P0–P8 + 0.6.x 全部完成），**已推送到 GitHub**（`main` = `73e9722` 之后随 0.6.8 再推一次）。

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
- 测试：17 个文件逐个跑，**290 例全绿**（`node --test test/` 在沙箱会 EPERM，只能逐文件跑）

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

## 已知缺口（不是 bug，是数据/结构限制）

- 厂商 token 单价（如豆包）在官网 JS 渲染页后面，纯 HTTP 拿不到；`text` 参数可让用户贴正文直接进证据（0.6.0 新增）。
- compare 模式下某个选项可能零证据（例如 Haystack），简报会在「未解决」里提示，但不会编造。
- 输入框只能显示/复制设置路径，不能就地切档（bundle 插件无 host 写通道；要做得改 Dynamic Cordis，见 README「设置页」）。

## 下次接着做

- 推送 6 个提交；
- 可选：`text` 参数做 UI 入口、"某选项零证据"显式提示、缓存落盘。
- 运行手册与细节：`D:\Total\docs\superpowers\specs\2026-11-15-regression-0.6.md`、`2026-11-15-p5-research-hardening.md`、`2026-11-15-cross-domain-scan.md`。