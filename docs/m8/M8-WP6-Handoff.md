# M8 WP6 交接单 —— 同轮有界应用 + 降级 + trace 六步 + 回复真相

> 状态：**DONE**（2026-09-26）
> 计划：[`M8-Execution-Plan.md`](M8-Execution-Plan.md) §10 WP6
> 证据：`pnpm m8:wp6:verify` = **PASS 12/12**（权威读数
> `artifacts/m8/m8-wp6-verify-20260926-ba7acbfe9c69-c851/`，
> `--supersedes …-d90f`；两跑 FAIL 在案见 §4）
> 回归：`kernel:test` 26/0 · `kernel:verify` 25/0 · `m3:verify` · `m3.5:verify` ·
> `eval:telemetry` · `eval:otlp` · `m3.5:test` 30/0（prompt 基线逐字节不变）·
> `eval:scenarios` 7/0 · `eval:dryrun` 17/0 · `eval:providers` · `m4:test` 258/0 ·
> `m4.5:test` 135/0 —— **12 道门全 EXIT 0**
> 下一站：WP7（测量门 + e2e + 长轨迹 + Live Smoke + 盲审材料）

## 1. 交付物

| 交付物 | 位置 | 内容 |
|---|---|---|
| 调度观测 | `src/infrastructure/runtime/affect-scheduler.ts` | flushed 结果携带审计计数（window/qualifiedEvents/touchProposals/impactProposals/matchedRuleIds/deduplicated/projectionChanges）；**生产映射** `affectTurnObservationOf(scheduling, appliedThisTurn)` → kernel 侧 `AffectTurnObservation`（failed 带 error + window + tailEvents；拒码只留 code 不留正文） |
| 观测契约 | `src/kernel/app/turn-gateway.ts` | `AffectTurnObservation` 接口（kernel 不能 import 基础设施类型 ⇒ 契约长在网关）；`CompileTurnInput.affectEvaluation`（不传 ⇒ 零 affect 步 ⇒ 基线不变） |
| trace 六步 | `src/kernel/app/turn-gateway.ts` | `compileTurn` 内：五步轮内观测（eligibility→proposal→validation→event→projection，**先于** `buildContextCompilerV2`）+ `affect_context`（packet 之后，记 section included/dropped/not_generated + applied_this_turn）；`appendStep` 私有、dryRun 守卫、trace 缺行静默跳过 |
| step 契约 | `src/kernel/contracts/trace.ts` | 6 个 `TraceStepKind` 字面量（开放 union 追加，不破坏既有 kind） |
| 阶段映射 | `src/kernel/contracts/observability.ts` | `TRACE_STEP_STAGE` 追加 6 行：轮内五步 → `'turn'`，affect_context → `'context'`（**不开第 13 阶段**，`OBSERVABILITY_STAGES.length===12` 的 M5.1 门不动） |
| 审计计数 | `src/kernel/app/affect/job.ts` | `AffectEvaluationOutcome` 扩展 `qualifiedEvents`/`touchProposals`/`impactProposals`/`matchedRuleIds`（**只留 id/计数**——trace 纪律）；`auditCountsOf` 从 `proposal.payload` 读（不是 `.audit`） |
| 同轮装配 | `src/main.ts` | send()：捕获 `affectScheduling` → `affectTurnObservationOf` → `compileTurn` 透传 `affectEvaluation`；`describeAffectScheduling` flushed 分支补"幂等命中 N" |
| 部件门 | `scripts/m8-wp6-verify.ts` | 三段式 12 项（正控 5 / 负控 3 / 恢复 2 / 静态锁 2），隔离库 + **真实 TurnGateway**（真 ingress + 真 trace 写入）+ **store 失败注入**（db 代理拦 `insert into character_domain_events`） |
| package.json | `m8:wp6:verify` | 点状追加 |

## 2. 关键语义（实现锚点，全部指向 ADR-066）

- **同轮时序**（§6.3）：`beginTurn`（用户事件落账）→ `maybeRunAffectEvaluation`
  （同步、确定性、无 LLM、有界）→ 渲染（读到**含本轮**的投影）→ `compileTurn`
  （六步 trace 在这一刻落树）。G1/G2 的机器证明：section `sourceRefs[0]`
  === `projection:affect:r<评估后 revision>`——"注入块只在提交成功之后编译"。
- **reply-truth 绑定**（§6.2）：`affect_context.applied_this_turn` 与
  `affect_event.created_event_count` / `affect_projection.revision_moved`
  **同一条 trace 树**——true（G2：applied=1 · 新建=2 · revision 前进）、
  false（N2：applied=0 · 五步 status=failed · 旧投影 + 边界行）、
  unknown（N3：干跑零落库）三态都有机器读数。
- **失败分类法不新增**（WP6 出口判据⑥）：调度器 catch → `failed`
  （不抛、不重试、不等待）——N2 证明 completeTurn 照常成功（聊天不阻断）、
  水位不动、投影保持旧值、注入块带如实边界行。
- **失败注入的精确边界**：db 代理只拦 `insert into character_domain_events`，
  评估/校验/水位读取全部照旧——失败发生在"评估完成、落库开始"的边界上，
  恰是生产里 store 故障的形状。事务回滚 ⇒ 无半写。
- **尾窗追赶不重复影响**（G3）：completeTurn 的助手回复事件被消费但
  **0 提案**（assistant 永远不是情绪证据，M8-D04），水位照常前进。
- **重启从水位出发**（G4）：水位持久 = 账本最大序号 ⇒ 新调度 `no_tail`
  （不是从最后一条文本重放）。
- **恢复补洞**（R1/R2）：去掉注入 ⇒ 失败轮的窗口连同后续事件**一次消费**
  （域事件恰 +2，无重复）；再调度 `no_tail`（不会二次消费）。
- **trace 属性纪律**：只有 id/计数/拒码/布尔——无对话正文、无情绪数值
  （valence/arousal 的值永远不进 trace）。遥测属性键对齐 AT1.4 后缀族
  （`_count`/`_ids`/`outcome` 进 span 白名单；`applied_this_turn`/
  `window_from`/`revision_to` 仅 trace 行可见——trace 行是审计面）。
- **观测映射取"最后一条"投影变化**：touch 与 impact 是两条事件 ⇒ revision
  1→2→3；映射取最后一条的 `toRevision` 才等于渲染时读到的终态 revision
  （取第一条会把"半程 revision"当终态——本门第一次运行的真实踩坑，见 §4）。

## 3. 量具读数

- 正控 5（P0/G1–G4）：播种建档（cutover=0）· 同轮时序 + 六步有序
  （五步 < context_compile < affect_context）+ packet 有块 · revision 绑定 +
  计数一致（合格 1 · 提案 2 · 新建 2 · applied=1 · A-GRATITUDE）· 轮后追赶
  0 提案 · 重启 no_tail + 水位=账本最大序号。
- 负控 3（N1–N3）：开关关闭形状（零 affect 步 + 无块 + 追赶只 1 touch）·
  store 失败注入（failed + 旧投影 + 水位不动 + 边界行 + 五步 failed +
  applied=0 + 聊天不阻断）· 干跑边界（零 trace 落库 + packet 有块 +
  观测缺位 ⇒ unknown）。
- 恢复 2（R1–R2）：补洞（新建=2 · 域事件恰+2 · v 0.08→≈0.16）·
  水位续走（no_tail · 域事件不变 · affect 事件可数 >0 = measured_count 自检）。
- 静态锁 2（S1–S2）：6 字面量在 trace.ts + 6 行在 observability.ts 阶段映射 ·
  main.ts 装配在位（`affectTurnObservationOf` 调用 + `affectEvaluation` ≥2 处）。
- `pnpm typecheck` EXIT 0。

## 4. 失败档记录（量具缺陷两跑，全部在案）

| runId | verdict | 缺陷 | 修复 |
|---|---|---|---|
| `…-8e84aa12227e-513f` | FAIL 9/12 | ① drizzle `sql` 模块的字符串块是 `StringChunk` 且 **`value` 是字符串数组**——按裸字符串过滤静默匹配零条 ⇒ 失败注入不生效（N2 假 flushed、R1 假无窗）② 观测映射取了**第一条**投影变化（半程 revision）⇒ G2 revision 绑定红 | ② 改取最后一条 `affect:character` 变化（`affect-scheduler.ts` 生产代码修复） |
| `…-8e84aa12227e-d90f` | FAIL 10/12 | ② 已修；① 仍在（`value: string` 断言仍不匹配数组） | ① `sqlTextOf` 处理 `value: string \| string[]`（量具修复） |
| `…-ba7acbfe9c69-56e3` | PASS 12/12 | 无 supersedes 标记的中间读数 | — |
| `…-ba7acbfe9c69-c851` | **PASS 12/12** | —（权威读数，`--supersedes …-d90f`） | — |

教训登记：**负控失效是最危险的量具缺陷**——注入不生效时 N2 不会红着报
"注入没拦到"，而是绿着报"调度成功"。本门的防线是 R1 的**计数断言**
（域事件恰 +2）：注入若失效，失败轮的窗口会被提前消费，R1 的
`新建=2` 与 `域事件 6→6` 必然对不上 ⇒ 双红。这条防线本身值得复用。

另：本 WP 期间曾用 PowerShell `-replace + Set-Content` 改写量具源文件，
把整文件中文变成乱码（AGENTS §7 的既有警告，真实复现）——已用 `write`
工具整文件重写恢复。教训：**任何**源文件改动都走 read/edit/write 工具。

## 5. 已知行为（非缺陷，WP7 需带着）

1. **失败轮的 job 行永远停在 running**：调度器 catch 路径不 `finishJob`
   （与 M7 同形）。恢复轮的窗口若与失败轮不同（尾窗长了）⇒ 新 job 键 ⇒
   新行；旧行留作失败尝试的如实记录。同窗重建（M7-WP6 已测的路径）不变。
2. **stale running job 不阻塞**：`enqueueJob` 同键返回既有行（created=false），
   不等待、不重启——失败分类法"不新增阻塞等待"的另一半。
3. **`applied_this_turn`/`window_from`/`revision_to` 不进遥测 span**
   （键不在 AT1.4 白名单）——`projectAttributes` 如实报告 filtered，
   trace 行全量保留。要进 span 需换 `_count` 后缀键（当前无此需求）。
4. **观测映射在 infrastructure 层**（`affect-scheduler.ts`）而非 main.ts
   ——WP6 门测的是生产函数本体，不是 main.ts 里的复制品（测试副本陷阱，
   WP6 设计期自纠）。main.ts 只调用。
5. **HEAD 在本 WP 期间被其它会话推进**（`8e84aa1`→`ba7acbf`，非 M8 路径：
   tech-debt register / memory fix / flags fix）——M8 领土文件未受影响，
   权威读数的 manifest 记录 `ba7acbfe9c69`。

## 6. 给 WP7 的输入

1. **e2e 骨架已就绪**：本门的真网关模式（ConversationRecorder 双 ingress +
   `gatewaySeq` 递进 + beginTurn→评估→渲染→compileTurn→completeTurn）
   就是 WP7 e2e 的骨架——WP7 换真模型 provider + 断言**回复正文**
   与 trace 的绑定（Level 1 + Level 2）。
2. **失败注入量具已验证**：`withFailingDomainEventInserts`（StringChunk
   数组语义）可直接复用；WP7 的失败注入 e2e 建议再补**评估器抛错**与
   **放行口拒收**两个注入点（本门只注入了 store 写入口）。
3. **长轨迹 1×500**：WP7 要量的是"500 轮里 touch/impact/衰减的累积形状"
   ——本门已证单轮确定性；长轨迹重点看水位推进无空洞 + 衰减读数
   （`effectiveAffect` 读时）与投影 revision 单调前进。
4. **Live Smoke 形态**：生产副本 + 双开关全开（M8-D12/D13）——注入块
   52 号 + 边界行措辞是盲审要点；`applied_this_turn` 的三态在真实链路
   只会出现 true/false（unknown 仅干跑）。
5. **量具有效性**：本门 R1 的"计数断言防线"（§4 教训）应写进 WP7 的
   量具验证节——负控必须有不依赖注入本身的第二道独立断言。
