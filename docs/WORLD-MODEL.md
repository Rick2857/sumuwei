# 可选的行动预测与反思结果上下文

两个扩展默认关闭，由部署者在自己的配置中选择开启。它们采用世界模型论文中的预测/实际结果反馈思路，没有实现可执行规则学习、多假设搜索或递归规则更新的完整生产闭环。Lv2.5 故事仍是另一个独立可选功能，本次不改变其开关或内容。

## 配置与边界

```dotenv
CHARACTER_ACTION_FORECAST_ENABLED=true
CHARACTER_ACTION_FORECAST_TIMEOUT_MS=20000
CHARACTER_REFLECTION_OUTCOME_COMPARISON_ENABLED=true
```

行动预测还需要已有任务编排入口与模型配置。每次预测消耗原 maxPlans 预算，不扩展授权、动作数量或任务时限。执行始终走原 TaskPlan 校验和 ActionGateway；模型只给闭集核对条件。核对不符会阻止依赖后续步骤并重新规划，未解决反驳也会阻止空计划声明完成。没有读回信息时仍可能无法判断，这不是成功证明。

反思比较还需要原 reflection/adaptive 开关与上下文预算。目标或承诺意图不是预测，结局受阻只提示复核成功判据。比较不增加句柄、独立根或触发，不降低三独立根、两真实会话、无未解决冲突与先采纳后调整的门槛。辅助来源须受既有支持根覆盖，提交前复核、遗忘过滤与槽位回退继续生效，不修改人格或 Seed。关闭比较时系统与用户提示词保持原基线。

回滚只需把两个新开关设为 false 并重启自己的服务；历史事件和投影保留，原记忆/反思失效规则仍适用。不要删除数据库来回滚。

## 验证与证据限度

`pnpm worldmodel:forecast:verify`、`pnpm worldmodel:reflection:verify` 与 `pnpm worldmodel:gates --verify` 不访问模型或数据库。`pnpm worldmodel:reflection:e2e` 使用 Docker 的独立 PostgreSQL 容器、卷和随机端口，预先需要测试床指定的 pgvector 镜像；缺少条件失败关闭，没有 PGlite 回退。它覆盖真采纳链、真实上下文 packet 和来源失效负控，使用离线 provider。

工具规划器复测八例：正确完成均为 3/8，误报完成 5/8→2/8；真实 API 调用 17→24，总 token 31967→41944，累计耗时 57.3→95.5 秒。适配器是脚本固定件，语料已被检查，不能推广到真实工具或独立泛化收益。反思草案对照 16 次调用中 7 次触及 20 秒期限，采集 FAIL，没有行为增益结论。完整行为留出、真人体验与长期效果仍未完成。原始模型/数据库/运行记录未随源码公开，当前公开检出的实测范围见 PUBLIC-VERIFICATION。

模型测试按 [v2 协议](world-model/World-Model-Continuation-Protocol-v2.md)，使用发行检出自己的 .env.test，通过 with-test-model 显式运行两个 :ab 命令。PASS 表示采集完整，不等于收益通过。聚合门按域显示执行状态；源指纹缺失/漂移、后端不符与传输失败均不接纳。首次检出没有证据时 NOT RUN 是正确结果。
