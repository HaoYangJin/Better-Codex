# 展示草稿说明

本文件是模板目录，不可整段原样复制到正式 README。只选择已有真实数据、资源和授权的部分，替换大写占位符；当前私有仓库不使用公开统计媒体。

## 增长与活动（公开且明确选择时）

```markdown
![Star History](https://api.star-history.com/svg?repos=OWNER%2FREPO&type=Date)
[文字入口：星标历史](https://www.star-history.com/#OWNER/REPO&Date)
```

## 状态展示（核实实际分支与工作流）

```markdown
[![CI](https://github.com/OWNER/REPO/actions/workflows/WORKFLOW.yml/badge.svg?branch=BRANCH)](https://github.com/OWNER/REPO/actions/workflows/WORKFLOW.yml)
```

私有项目改用仓库内静态图片，显示其制作日期；不得冒充实时验证状态。

## 项目门面（确保素材存在）

```html
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/demo-dark.png">
  <img src="assets/demo-light.png" alt="实际功能演示">
</picture>
```

## 快速体验

```markdown
[本地示例](https://github.com/HaoYangJin/Big-Repo/blob/v2.1.0/templates/examples/README.md)
[在线体验](https://github.com/HaoYangJin/Big-Repo/blob/v2.1.0/templates/VERIFIED_DEMO_URL)
```

没有核实的在线体验时删除第二行；新建部署不属于文档生成的隐含授权。

## 社区参与

```markdown
[参与贡献](https://github.com/HaoYangJin/Big-Repo/blob/v2.1.0/templates/CONTRIBUTING.md)
[适合入门的任务](https://github.com/OWNER/REPO/issues?q=is%3Aissue%20is%3Aopen%20label%3A%22good%20first%20issue%22)
```

只有实际使用该标签时保留任务链接。贡献者名单必须核对真实记录。

## 项目故事

```markdown
| 日期 | 已核实的版本或里程碑 | 来源 |
| --- | --- | --- |
| ACTUAL_DATE | ACTUAL_EVENT | ACTUAL_SOURCE |
```

没有发布记录时改为明确标注的未来路线图，不能把计划事件写成已完成。
