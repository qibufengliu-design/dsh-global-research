# 发布

## 版本号规则

遵循 [Semantic Versioning 2.0](https://semver.org/lang/zh-CN/)，`package.json.version` 是唯一事实来源：

| 变更 | 版本位 | 例子 |
|---|---|---|
| 破坏兼容：工具参数语义变化、配置键重命名/删除、返回结构不兼容 | MAJOR | `1.0.0` 之前仍用 MINOR 表达（`0.x` 段） |
| 新增能力：新参数、新通道、新垂直源、新简报章节、新分类 | MINOR | `0.9.0 → 0.10.0` |
| 修 bug、调文案、改提示词、补测试、仓库结构整理 | PATCH | `0.9.0 → 0.9.1` |

`0.x` 阶段按 DSH 插件生态惯例：破坏性变更也走 MINOR，并把「破坏点」写进 `CHANGELOG.md` 的 `### Changed`。

## 发布清单

每版按顺序做完，缺一项不算发布：

1. **实现 + 测试**：`node scripts/test-all.mjs` 全绿（当前 334 例），新增行为必须有测试。
2. **真实网络回归**：至少跑一次 `retrieval-check`（A 题：RAG 选型）与一次 B/C 题；跑不动就记录「未运行 + 原因」，不允许编造结论。结论写到 `D:\Total\docs\superpowers\specs\` 下的回归文档。
3. **版本号**：改 `package.json.version`。
4. **CHANGELOG**：在 `CHANGELOG.md` 顶部新增 `## [x.y.z] - YYYY-MM-DD`，分类用 `Added` / `Changed` / `Fixed` / `Removed` / `Security`；写清「为什么」和实测数字，不只写「优化了 X」。
5. **文档同步**：README 的参数表、配置表、特性列表；`docs/` 对应页；配置项变化必须同步 `docs/configuration.md`。
6. **零依赖**：确认 `dependencies` / `devDependencies` 为空。
7. **提交**：Conventional Commits，一个版本一个 commit。
8. **打 tag**：`git tag -a vX.Y.Z -m "vX.Y.Z"`，与 `package.json.version` 一致。
9. **推送**：`git push origin main --follow-tags`，并在推送后核对远端 HEAD。
10. **核对**：`git ls-remote origin` 的 `refs/heads/main` 与本地 `HEAD` 相同，tag 已在远端。

## 推送环境要求

Windows 上 git 走 schannel 时需要读取凭据库，沙箱内会报：

```text
schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS (0x8009030e)
```

因此推送命令需要 `sandbox_permissions: danger-full-access`，并建议显式指定 OpenSSL 后端：

```powershell
git -c http.sslBackend=openssl push origin main --follow-tags
```

确认远端状态（同样需要凭据）：

```powershell
git -c http.sslBackend=openssl ls-remote origin HEAD refs/heads/main refs/tags/*
```

`gh` CLI 未安装、也没有 `GITHUB_TOKEN` 时，仓库设置（描述、话题、分支保护、Release 页面）无法脚本化，只能手工在网页上做；这一点写进每版的交接记录，不要假装已完成。

## 提交信息

```
<type>(<scope>): <subject>

<body：为什么改、改了什么、实测数字>
```

`type` 取 `feat` / `fix` / `docs` / `test` / `refactor` / `chore` / `perf` / `build` / `ci`。`scope` 可省，常用 `pipeline` / `brief` / `strategy` / `config` / `client` / `repo`。

## 发布记录

版本与对应 commit 见 `git log --oneline` 与 `git tag -n`；用户可见的能力变化见 [CHANGELOG.md](../CHANGELOG.md)。