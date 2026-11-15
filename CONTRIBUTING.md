# 贡献指南

感谢你有兴趣改进 `dsh-global-research`。这是一个零依赖的 DSH bundle 插件，目标是把「开放问题」变成可核查的研究简报。

## 行为准则

参与本项目即表示你同意遵守 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。

## 报告问题

- **Bug / 检索质量差 / 简报格式异常** → 用 [Bug 模板](.github/ISSUE_TEMPLATE/bug_report.yml)，务必附上问题原文、`depth`、`stats` 与能复现的 `retrieval-check` 输出。
- **功能请求** → 用 [功能模板](.github/ISSUE_TEMPLATE/feature_request.yml)，说明要解决的场景而不是只要一个 API。
- **安全问题** → **不要**开公开 issue，走 [SECURITY.md](SECURITY.md)。

## 开发环境

要求 Node.js ≥ 20（CI 覆盖 20 / 22 / 24），

```powershell
git clone https://github.com/qibufengliu-design/dsh-global-research.git
cd dsh-global-research
node scripts/test-all.mjs      # 337 例应全绿
```

本项目零依赖，不需要 `npm install`。

## 开发流程

1. 从 `main` 开分支：`feat/<简述>`、`fix/<简述>`、`docs/<简述>`、`test/<简述>`。
2. **先写测试再改实现**（可用假引擎 / 假抓取 / 假模型，`test/` 里已有大量范例）。
3. 实现保持零依赖：新能力优先用 Node 内置模块。
4. 更新 `CHANGELOG.md`（`## [Unreleased]` 段）与相关文档。
5. 本地全绿后提交 PR，并在 PR 描述里写清「为什么改、怎么验证」。

## 提交信息

使用 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/)：

```text
<type>(<scope>): <subject>

<body：为什么改、改了什么、实测数字>
```

`type`：`feat` / `fix` / `docs` / `test` / `refactor` / `chore` / `perf` / `build` / `ci`。

## PR 检查表

- [ ] `node scripts/test-all.mjs` 全绿
- [ ] 新增行为有对应测试；修 bug 先补一条会失败的测试
- [ ] `dependencies` / `devDependencies` 仍为空
- [ ] `CHANGELOG.md` 已更新（用户可见变化写进 `Unreleased`）
- [ ] 配置项变化同步了 `lib/config.js`、`docs/configuration.md`、`test/config.test.js`
- [ ] 面向用户的文案是中文，示例可复制即跑
- [ ] 没有提交密钥、`.env`、个人路径或抓包数据

## 代码约定

- ESM，`import` / `export`，不引入第三方依赖。
- 注释解释「为什么」，不复述「做什么」。
- 面向用户的输出（简报、错误信息）用中文；内部标识符用英文。
- 改动 `client.js` 需要完全重启桌面应用验证，不要只按 `Ctrl+R`。

## 发布

维护者发布流程见 [docs/release.md](docs/release.md)。