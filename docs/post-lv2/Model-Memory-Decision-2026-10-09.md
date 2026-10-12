# 轮末统一记忆判定 — 2026-10-09

设计与实现按 [ADR-123](../adr/ADR-123-post-turn-model-memory-and-semantic-only-recall.md)。新模式已按用户明确授权生产激活；只撤回指定误判，激活后已完成 QQ/皮套共享核心恢复。下文实现阶段读数保留，生产追加记录与当前运行状态见末段。

根因证据：关闭快照的隔离副本中，事件 679 的原文为“还有一件事，记得提醒我6min后手机将会充好电，给我发消息叫我拔一下插头”。它由 `explicit-memory@1` 写入，trace 显式写入在召回之前。旧意图规则未命中，根据当时已开启且当前与历史源码一致的意图链，模型兜底分支是来源推断；没有保存历史原始模型输出，不能声称复现了那次模型回答。旧内容规则把“叫我”后的动作读成称呼；importance=.80 是显式候选固定值，confidence=.80 对应规则抽取。自检验证结构与出处，不验证句子是否蕴含稳定偏好。

事件 667 的“行，以后像这样的提醒，默认是前一种”确实来自明确默认提醒方式请求，应保留。现存学校事实也应保留。全部实验只打开隔离库/副本，未撤回这两条或改写旧错误记录。

新流程：本轮正常回复并携带记忆 pending 事实 → 单个共享后台模型直接判断当前用户事件 → 原生结构/来源/目标/版本/冲突校验 → 原子提交事件、折叠、任务和水位。召回通过独立纯语义档位，不使用词面命中或失败降级。

验证命令：

```powershell
pnpm postlv2:model-memory:verify
pnpm with-test-model pnpm postlv2:model-memory:live
pnpm typecheck
pnpm with-test-model pnpm m4.5:ci:full
pnpm m5:retrieval:verify
pnpm m5:ranking:verify
```

完整回归副本源是经 manifest/digest 验证的关闭快照 `data/snapshots/audit-activation-20261009/pglite-2026-10-09T02-22-08-683Z-68d929c0cf6d`。历史 tracked 输出先备份，新输出另外归档，再恢复原字节；不把重跑覆盖成历史验收结论。

真实模型第一档：39 条中 36 通过 / 3 失败，证据 `artifacts/post-lv2/model-memory/live-1791514884708/result.json`。三项分别是 create 填空 targetId、text 取值拼接、提醒偏好使用另一个槽位。负样本未错误写入；合法默认偏好却可能无法入库/进入不兼容槽位。修复空可选字段兼容性、明确槽位约定与逐字取值要求，并将正文预算由 1600 调整为 4096，避免推理耗尽导致空正文重试。原失败档不回写。

修复后 39 条档：39/39，证据 `artifacts/post-lv2/model-memory/live-1791515120344/result.json`。追加真实/虚构经历后 41/41，证据 `artifacts/post-lv2/model-memory/live-1791515311831/result.json`。最后增加十条不直接标注“只是测试/不是事实”的语料，最终 **51/51**（16 正例、35 负例；负例原生记忆事件零新增、投影零变化），证据 `artifacts/post-lv2/model-memory/live-1791515781472/result.json`；corpus SHA-256 `7b7ec29dbeba0cab144a4129030f034bb8a21010266747137b40bb1303bcadd8`。预期标签没有按模型输出修改。

最终离线程序判据 **57/57**，证据 `artifacts/post-lv2/model-memory/offline-1791515911469/result.json`；另有真实 main 桥入口 **1/1**，证据 `artifacts/post-lv2/model-memory/main-1791515916860/result.json`。覆盖整批回滚、跨用户目标、旧版本目标、明确改回旧值的原生复活/重放一致、后台失败预算/受控恢复、重启、停机晚写隔离、失败对话不堵住后续已完成对话、纯语义失败不回退、pending 回复与提醒动作事实共存。新状态命令选择正确处理器并且零模型调用。

`pnpm typecheck` EXIT 0；`pnpm with-test-model pnpm m4.5:ci:full` EXIT 0（包含完整 `m4.5:ci`；Live Smoke **56/56**，本次源为经验证关闭快照的副本，不能称本轮生产连接实测），约 724 秒。M5 retrieval 28/28、ranking 27/27，test/eligibility/e2e 全部 EXIT 0；恢复旧消费者的门 16/16；受影响门选择器 19/19；文档同步/清单校验均 EXIT 0。完整回归证据归档在 `artifacts/post-lv2/local/model-memory-gates-1791515169476/`，补充召回门在 `artifacts/post-lv2/local/model-memory-gates-1791515968232/`；各目录 `result.json` 列出历史输出恢复的精确白名单。

工作树包含本轮之前的其它改动，以上是当前工作树的隔离验证，不是干净发布候选的发行证明；实现验证阶段未改生产配置。本次仍未提交、打标签或合并。

隔离入口验证会故意挂起后台模型，直到桥收到 TURN_RESULT 才放行，证明回复无需等待模型结束；再读回一个新处理器写入、旧处理器水位为零、confidence=.96，证明没有偷偷走旧链或固定 .80。

限制：有限语料的单次模型成绩不等于永不误判。51 条验收端点使用 `.env.test` 的 ark/deepseek-v4.1-flash，生产模型由正式配置另定；末段的生产模型检查只覆盖四项，自然长期收益未验证。最多 12 行参考和 50 条当前用户记忆，可能看不到更远指代；原文 text 约束不允许跨句补全新事实；目标不明确不操作。失败预算耗尽会挡住后续源事件，必须查看状态并明确授权重试。模型失效时仍返回本轮回复，但记忆不能宣称完成。

2026-10-09 用户明确授权后，已将 `.env` 的 `CHARACTER_MEMORY_WRITE_MODE` 设为 `post_turn_model`、`CHARACTER_MEMORY_RECALL_MODE` 设为 `semantic_only`，其它配置键与 `.env.qq` 不变。历史错误 `preferred.address=拔一下插头` 经官方 CLI 精确撤回，领域事件 `dev:00000000-0000-4000-8000-000000000001:791`，reason=audit；其余三条记忆逐字段不变、学校与默认提醒偏好仍 active，原始对话保留。该操作没有变更 schema 或删除其它记录。

生产端点 `https://api.deepseek.com / deepseek-flash` 的四项直接提案检查 **4/4**，覆盖原始“叫我拔插头”提醒、学校事实/假设和“前一种”默认提醒指代；没有打开或写入生产库，不是自然用户对话。共享核心启动建立新水位 785；受控关闭 EXIT 0 / cleanClose=true 后，在经验证关闭快照 `2026-10-09T03-34-07-451Z-6b957062b6ab` 的隔离副本中读回：ready、pendingEvents=0、failures=0，新处理器没有历史任务或自然首轮。最终恢复共享核心并确认两个模式与 QQ/皮套就绪，证据 [production-activation-20261009/verification.json](../../artifacts/post-lv2/model-memory/production-activation-20261009/verification.json)。**激活已执行；自然首轮与长期收益仍未观测。**本次可用性与精确撤回证据不关闭既有 `AUD-ISO-01` 的历史影响边界。

2026-10-09 16:14（UTC+8）用户要求“现在先关一下核心”。检查时前次 supervisor/core/avatar PID 49384/38732/32944 已全部不存在，未发现其它正式核心/外壳进程，6751/6752/12394 无监听。官方 `pnpm coexist:stop` 已写入停机哨兵，当前运行状态 **STOPPED**；但最后 owner 没有 cleanClose/endedAt，最后日志没有 RELEASED 或核心退出码，故**正常关库未确认**。最新 manifest 仍是前次启动的 `2026-10-09T03-35-10-430Z-6b957062b6ab`，本次没有新关闭快照。没有重新启动、打开数据库或修改 owner 来补齐证据。记录见 [production-shutdown-20261009/verification.json](../../artifacts/post-lv2/model-memory/production-shutdown-20261009/verification.json)；先前激活成功读数保留，不代表当前仍运行。
