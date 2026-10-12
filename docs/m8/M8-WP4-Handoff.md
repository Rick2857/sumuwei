# M8 WP4 交接单 —— 持久化、调度与接线

> 状态：**DONE**（2026-09-26）
> 计划：[`M8-Execution-Plan.md`](M8-Execution-Plan.md) §10 WP4
> 证据：`pnpm m8:wp4:verify` = **PASS 14/14**
> （`artifacts/m8/m8-wp4-verify-20260926-a82080865706-53a7/`，取代链见 §4）
> 同步翻转：`pnpm m8:wp2:contracts` = **PASS 55/55**（S3 判据翻转，
> `…-6eb0` 取代 `…-ab75`）
> 下一站：WP5（上下文面：flags / sections / turn-gateway / adapters / main.ts）

## 1. 交付物

| 交付物 | 位置 | 内容 |
|---|---|---|
| 投影存取 | `src/infrastructure/persistence/affect-store.ts` | `getAffectProjection`（未建档=undefined）+ `rebuildAffectProjection`（**事务包装**——删+写同事务，修 M7 同位缺陷；`affectEventTargets` 目标过滤：payload 指向别人的事件不折进本行） |
| 调度装配 | `src/infrastructure/runtime/affect-scheduler.ts` | `createAffectJobPorts`（真存储端口）· `seedAffectOrigin`（建档：0/0 + cutover=账本最大序号，走唯一放行口，幂等）· `recoverAffectCutoverWatermark`（中断播种恢复：从投影状态重读 cutover 补推进）· `maybeRunAffectEvaluation`（建档检查→恢复→尾窗非空即消费） |
| 注册表接线 | `src/kernel/contracts/domain-event.ts` | `createFullDomainEventRegistry()` 接入 `createAffectDomainEventRegistry()` 三类（S3 翻转） |
| S3 判据翻转 | `scripts/m8-wp2-contracts.ts` | S3 从"不含 AFFECT"翻转为"含全部 AFFECT"（WP2 交接预告的翻转，已出证据） |
| 部件门 | `scripts/m8-wp4-verify.ts` | 三段式 14 项（正控 8 / 负控 3 / 恢复 3），隔离库 + 真实 store/scheduler/ledger/受信归因 |
| package.json | `m8:wp4:verify` | 点状追加 |

## 2. 关键语义（实现锚点，全部指向 ADR-066）

- **无攒尾窗**（与 M7 调度的关键差异）：M8 规则全部逐事件即时（M8-D08），
  不存在"攒够才触发"的规则 ⇒ 尾窗非空即消费；全不合格尾窗（只有她的回复/
  别的用户）0 提案但水位照常前进（持有只会让尾窗无界生长）。
- **M8-D05 不重放**（P4）：播种时 cutover = 当时账本最大序号；切换前的
  合格消息（**含触发词**）永远不产生 touch/impact——3 条切换前感谢消息
  在播种后零事件，切换后 1 条感谢消息正常产出。
- **播种失败 ⇒ 不消费**：未建档时消费会让 touch 全部被拒（affect_not_originated）
  且水位前进后这批交互**永久丢失**——失败关闭，尾窗留给下一轮。
- **中断播种恢复**（R1）：ORIGIN 落库（事务内：事件+投影+幂等）与
  advanceWatermark 是两步；中间崩溃 ⇒ 投影已建档但水位在 0 ⇒
  `recoverAffectCutoverWatermark` 从 `state.cutoverSequence` 补推进；幂等。
- **两层幂等的实库证明**（N1）：已消费区间重跑 ⇒ 领域键（range 置零）
  全命中 duplicate ⇒ createdCount=0、投影逐字不动。
- **arousal 钳取**（P5 实测）：A-GRATITUDE 的 arousal delta −0.03 从 0 起
  **钳在下界 0**（arousal ∈ [0,1]，valence ∈ [−1,1]）——冷静类规则在
  arousal=0 时是 no-op，这是设计内行为。
- **事务重建**（R2）：删行 → `rebuildAffectProjection` → 逐字段一致；
  外来事件（payload 指向别人）被目标过滤排除（账本 affect 事件 − applied = 1）。

## 3. 量具读数

- 正控 8：播种（建档/幂等/唯一 ORIGIN/走放行口）· 不重放 · 尾窗消费
  （touch+impact+冻结 delta+钳取）· 水位前进 · 中性只 touch · 接线（S3）。
- 负控 3：区间重跑全 duplicate · 非 active user 0 提案 · 目标过滤。
- 恢复 3：中断播种恢复（→cutover=5，重复 no-op）· 删行重建一致 ·
  负控后新感谢消息 v 0.08→≈0.16。
- `pnpm typecheck` EXIT 0 · `pnpm kernel:test` 26/0 · `pnpm kernel:verify` 25/0 ·
  `pnpm m8:wp2:contracts` PASS 55/55（S3 翻转后重跑）。

## 4. 失败档记录（如实登记）

| runId | 判定 | 原因 | 处置 |
|---|---|---|---|
| `m8-wp4-verify-…-1b18` | FAIL 9/14 | **四项判据/夹具错误**（非实现缺陷）：① P5/P7 期望 arousal=−0.03，实际钳在下界 0（[0,1] 轴的设计内行为）；② R1 夹具 cutover=0 ⇒ 无可恢复量；③ R2 期望 skippedForeign≥1，但目标过滤发生在 relevant 阶段（skippedForeign 只计乱序跳过）——改用账本差集计数；④ R3 文本"太感谢你了"不含任何冻结词形（'谢谢你'/'多谢'/'辛苦了'）⇒ 只 touch | 修判据与夹具；重跑 PASS（`--supersedes …-1b18`） |
| `m8-wp2-contracts-…-6b9f` | PASS 55/55 | **取代指针错误**：`--supersedes` 误指向不存在的 `…-6a02`（真实 WP2 终档是 `…-ab75`） | 留档；重跑 `…-6eb0 --supersedes …-ab75` 更正链，6eb0 的 reason 里注明 6b9f 指针错误 |

## 5. 给 WP5 的输入

1. **调度入口已就绪**：main.ts 的 open() 链路调
   `maybeRunAffectEvaluation(db, { characterId, activeUserId, now })`——
   它内部完成建档检查（含播种）+ 中断恢复 + 尾窗消费，一个入口三件事，
   失败不抛（`kind: 'failed'` 如实报告）。
2. **activeUserId 的生产推导**：`resolveIds(userName).userId`
   （= `stringToUuid('user-'+userName)`）——与受信归因的 principal id 同源，
   WP4 门里用 ledger 的 userId 直通验证了这条链。
3. **读面 API**：`getAffectProjection(db, characterId)` →
   `CharacterProjection<AffectState>`；`effectiveAffect(state, now)`（contracts）
   做读时衰减——**永不写回**。Context section 用这两个；渲染用
   `renderAffectGuidance`（WP2 已冻结，无原始数值）。
4. **同轮应用（WP6）的落库路径**：send() 里同步跑
   `runAffectEvaluation(ports, { …, traceId })`（ports = createAffectJobPorts），
   或直接复用 `maybeRunAffectEvaluation`（它幂等且不抛）——区别只在
   traceId 透传；WP6 决定接线形态。
5. **重建入口**：`rebuildAffectProjection(db, characterId)`（事务包装）——
   `--inspect` 的 Level 2 读回与运维面用它；不要用通用
   `rebuildProjection`（无目标过滤）。
