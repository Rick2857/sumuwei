# ADR-121 — 审计前三项修复与自动记忆受控恢复

2026-10-08 · ACCEPTED FOR IMPLEMENTATION。授权：用户“先做1，2，3”，并选择同时引入 AIRI / LiveKit / Pipecat / MaiBot 的借鉴机制；语音性能验收和人格收益评测暂缓。

本裁定追加 ADR-117 D03 的开发者恢复程序，不改写原设计、不取消三次失败关闭。核心事实、既有 validator/reducer、生产配置、旧 failed jobs 和水位保留。

1. 依赖按直接/传递/开发工具修补；pnpm 12 的覆盖定义在 workspace YAML。无修补版本的公告保留并核查可达性，不伪造全绿。
2. 图片/学习/编排/恢复有离线门和 affected 规则。学习离线档不检查外部资产，证据明确 NOT RUN；升级全量门时保留已审核离线专项门，不自动拉资产/出站门。
3. 自动记忆开发者健康视图只 SELECT：最后成功时间、实际未消费事件数、水位、当前失败源、失败/恢复次数。日志不含原文或 provider 错误正文。
4. 显式本地 operator 请求需指定当前阻塞源序号。默认仅预览；`--apply` 只授予原源一次额外尝试，最多三次恢复授权。重启、普通通知、模型输出不产生恢复授权。
5. 授权用既有 character_jobs 的专用处理器 `automatic-memory-operator-recovery@1` 和 system trigger 记录；源范围固定、键幂等、授权完成事务化。不新增 schema，不推进处理水位，不重新解释旧源资格。
6. 正常消费者读取持久授权后可执行原生候选流程。失败用掉这次尝试后再次停止；成功仍必须通过证据、冲突、更正/遗忘、事务和关闭 fence。旧失败行不删除、不改 completed。
7. 控制命令只从 `src/main.ts` 的既有 DB owner/安全启动链进入，不注册为角色工具，不提供任意 SQL/路径。真实库持有者仍排他；修复后验收只用隔离库，不自行修复生产水位或重启生产核心。首次测试误打开真实库另见[隔离事故记录](../audit/2026-10-08-recovery-test-isolation-incident.md)，不凭后续绿门关闭。

命令：`pnpm memory:automatic:status`；预览 `pnpm memory:automatic:retry --source-sequence=<健康视图的序号>`；应用时追加 `--apply`。已有 owner 在运行时先按正常操作流程停止该 owner，命令不绕过租约。

OSS 借鉴已纳入本次实现授权，采用以下边界机制：

- AIRI：客户端 `interrupt()` 的 `silenced` 与 `done` 分开。先停本地音频，再等待受控 `/lg/interrupt` 的核心取消判决；ACK 不代表模型结束或已提交事实回滚。
- LiveKit：一个片段共享一个播放完成 promise，只有实际音频节点结束才记 played；终态片段禁止重开。128 个片段终态标识与 16 条中断读数有界保留。
- Pipecat：Python 语音 inbox 上限 64，中断立即清掉积压并唤醒等待者，不等正式轮次完成；取消任务按 requestId 幂等、最多保留 64 项，等待核心判决最多 5 秒，超时如实 failed。
- MaiBot：独立实现少量相关记忆注入。原有用户/角色作用域、来源资格、相关性、冲突与去重先执行；正式主程序每轮注入最多 3 条，token 预算同时生效。新增 `INJECTION_LIMIT`（budget 阶段）区分条数限制与 token 不足，trace 覆盖全部候选。原生记忆写入、更正、遗忘、完整管理员列表不变；未传此选项的历史夹具保持原行为。没有复制 GPL 代码或引入印象型事实来源。

不引入四套运行框架，不改既有 TTS 缓冲参数，不跑语音性能验收或人格收益评测。历史审计、FAIL/INVALID/NOT RUN 和已接受的放行风险不回写。实现来源和功能读数另记交付报告。
