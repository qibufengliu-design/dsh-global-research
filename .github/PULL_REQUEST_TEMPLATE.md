## 这个 PR 做了什么

<!-- 一句话说明改动与动机；关联 issue 用 "Closes #123" -->

## 改动类型

- [ ] feat：新能力
- [ ] fix：修 bug
- [ ] docs：文档
- [ ] test：测试
- [ ] refactor：不改变行为的重构
- [ ] chore / ci：工程化

## 怎么验证的

<!-- 贴命令与关键输出，例如 node scripts/test-all.mjs 的结尾统计 -->

```text
$ node scripts/test-all.mjs
✔ 18 个测试文件全部通过
```

## 检查表

- [ ] `node scripts/test-all.mjs` 全绿
- [ ] 新增行为有测试；修 bug 时先补了会失败的测试
- [ ] `dependencies` / `devDependencies` 仍为空
- [ ] `CHANGELOG.md` 已在 `Unreleased` 记录用户可见变化
- [ ] 配置项变化同步了 `lib/config.js`、`docs/configuration.md`、`test/config.test.js`
- [ ] 面向用户的文案是中文，示例可复制即跑
- [ ] 未提交密钥、个人路径或抓包数据