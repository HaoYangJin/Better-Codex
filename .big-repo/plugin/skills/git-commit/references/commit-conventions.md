# 提交说明规范

以 [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/) 为格式基础。

## 格式

```text
type(scope): 简述变更结果

可选正文：解释原因、影响及验证情况。

可选页脚
```

scope 可省略。中文或英文摘要均可，保持同一项目语言一致。

## 本仓库使用的类型

| 类型 | 用途 |
| --- | --- |
| feat | 新增能力 |
| fix | 修复问题 |
| docs | 文档和说明 |
| refactor | 保持外部行为的结构调整 |
| perf | 性能改进 |
| test | 测试变更 |
| build | 构建或依赖 |
| ci | 持续集成 |
| style | 不影响含义的格式调整 |
| chore | 其他维护 |
| revert | 撤销指定改动 |

这些扩展类型是本仓库约定，不是上游规范全部强制要求的类型。

## 示例

```text
docs(commit): 补充暂存区检查步骤
feat(skills): 新增技能编写工作流
fix(template): 修正提交模板的段落间隔
```

不兼容变更在类型后添加 !，或使用 BREAKING CHANGE 页脚；正文说明迁移方法：

```text
feat(skills)!: 将技能资源迁移到独立目录

使用方需要复制整个技能目录。

BREAKING CHANGE: 原有单文件安装方式不再包含必需资源。
```

## 本地约定

摘要建议控制在 72 个字符以内，描述结果，避免“更新”“修改文件”等无法说明目的的摘要。
正文只记录真实验证结果；关联问题时使用实际存在的编号。
