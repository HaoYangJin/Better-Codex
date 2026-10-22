# Big-Repo 项目工作流

此协议是客户端遵循的协作流程，不是拦截所有 Git 操作的权限系统。用户本轮限制、项目规则及平台权限优先。普通问答、规划和只读评审不创建任务，不提交、不推送。

## 新项目接入

新接入默认 delivery=commit、client=none、profile=core、showcase=none。只保存 .big-repo/config.json 与运行目录，不修改用户现有 README 或客户端说明。

```sh
python scripts/project_workflow.py init --repo /path/to/project --dry-run
python scripts/project_workflow.py init --repo /path/to/project --check "实际验证命令"
# 用户显式选择持续客户端入口和远端交付
python scripts/project_workflow.py init --repo /path/to/project --update --client codex --delivery pr
```

--delivery merge 仅在用户明确开启时使用。--client 支持 none、codex、claude、both；不从当前客户端猜测用户允许修改哪些说明文件。托管段按实际策略生成，commit 不授权远端写入，pr 不授权合并。

--showcase local/public 需要 full 资源；公开展示先验证仓库公开性。--public 是 public 展示的兼容参数，不能与冲突选项同时使用。创建公开远端不自动启用公开展示。资源集合变更使用 upgrade；core 来源不能提供 full 资源，升级到 full 须从完整插件运行，缺少资源时写入前拒绝。

create 在已有文件上保留内容，仅在缺少 README 时建立最小入口。创建远端必须明确 --repository owner/project，默认 private。--dry-run 不写文件、不初始化 Git、不创建远端。缺少验证和 CI 返回 needs-configuration，不当作接入成功。

## 每轮交付

显式启用客户端入口的项目按配置执行。首次接入之后可直接提出开发需求，客户端先 status，复用未完成任务或用 begin 记录实际目标和允许路径。未启用入口时，可显式请求技能或运行工具。没有任务时不巡检、不设置定时任务。

```sh
python scripts/project_workflow.py begin --repo . --objective "实际需求" --allowed-path "实际范围"
# 开发；只按已选择的展示策略同步相关内容；按项目约定精确提交
python scripts/project_workflow.py check --repo .
# 必须是真实独立审查，绑定完整最终 SHA
python scripts/project_workflow.py review --repo . --head FULL_FINAL_SHA --reviewer ACTUAL_REVIEWER
python scripts/project_workflow.py deliver --repo . --title "准确标题" --body-file /outside/pr-body.md
```

commit 仅完成本地提交；pr 推送并交付 PR；merge 在本地验证、独立审查、所有登记及其他可见 CI 成功，且平台 CLEAN、可合并、支持 squash 后，锁定最终 head SHA 合并。不使用 --admin，不删除分支。等待只读观察；失败在任务范围内修复、重验及复审。结果不确定先查询，禁止盲目重试写入；不能把创建 PR 当作已合并。

验证证据、策略记录和审查登记均为 caller-attested，不是防篡改证明。直接运行 Git 的操作不受这些脚本拦截，平台保护和客户端权限需另行配置。任务/日志保存在 Git 元数据 big-repo 目录，不提交、不伪造；已有工作、分支与 PR 保留。

## 升级、停用与恢复

status 显示交付策略、运行版本、资源集合、客户端入口及确认状态，不在无任务时创建状态目录。旧配置需要一次显式确认，不因旧默认值推断自动合并授权。

```sh
python scripts/project_workflow.py upgrade --repo . --delivery commit --client none --profile core --dry-run
python scripts/project_workflow.py upgrade --repo . --delivery commit --client none --profile core
python scripts/project_workflow.py disconnect --repo . --dry-run
python scripts/project_workflow.py disconnect --repo .
python .big-repo/workflow.py status --repo .
```

有活动任务时拒绝升级或停用；先用原运行目录完成，或按用户指令 cancel --reason 后再开始。旧配置、日志、任务身份和 PR 关联保留。运行目录暂存后替换并备份；初始化会写入 `.big-repo/workflow.py` 稳定入口，即使运行目录正在切换或暂时缺失，也可用它执行 status 和原生命周期操作。遇到非托管文件、异常标记或恢复冲突拒绝覆盖。status 显示 recovery-required 时，先重试 upgrade 或 disconnect 完成恢复；init、begin 与 deliver 不在半写入状态下继续。中断后重试相同生命周期操作，恢复前核对登记内容与现场；不通过删除备份、状态或旧证据绕过门槛。

disconnect 只移除有效托管段并停用接入；不删除 README、运行目录、日志、分支或 PR。重新启用需显式 init --update。1.x 先用 init --migrate 完成命名空间迁移，再按上述策略确认；未闭合的旧任务先用原版完成或显式取消。

版本发布仍为 explicit-request；只有明确授权具体版本后才执行标签及 Release。维护 PR 自动合并不等于发布授权；部署、全局安装、可见性变更另需授权。
