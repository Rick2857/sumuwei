# M8 WP5 交接单 —— 上下文接线（flags / sections / gateway / adapters / main）

> 状态：**DONE**（2026-09-26）
> 计划：[`M8-Execution-Plan.md`](M8-Execution-Plan.md) §10 WP5
> 证据：`pnpm m8:wp5:verify` = **PASS 17/17**（首跑即过；
> `artifacts/m8/m8-wp5-verify-20260926-a82080865706-b5dc/`）
> 回归：`m3.5:test` 30/0（**prompt 基线逐字节不变**）· `m4:test` 258/0 ·
> `m4.5:test` 135/0 · `kernel:test` 26/0 · `kernel:verify` 25/0 ·
> `eval:scenarios` 7/0 · `eval:dryrun` 17/0 · `eval:providers` EXIT 0
> 下一站：WP6（同轮有界应用 + 降级 + trace + 回复真相）

## 1. 交付物

| 交付物 | 位置 | 内容 |
|---|---|---|
| 开关 | `src/kernel/app/flags.ts` | `affectContextEnabled`（env `CHARACTER_AFFECT_CONTEXT_ENABLED`，**缺省 false**，M8-D14）+ 摘要行 `affect-context=on/off` |
| 注入块 | `src/kernel/context/sections.ts` | `SECTION_IDS.affect` · `createAffectProvider`（priority **52**，droppable）· `BuildCompilerOptions.renderAffect` · v2 编译器接线（关系 55 之后、时间 58 之前） |
| 网关 | `src/kernel/app/turn-gateway.ts` | `CompileTurnInput.affectSection`（不传 ⇒ 0 个 section ⇒ 基线逐字节不变）→ 两处 `buildContextCompilerV2` 调用点同装配 |
| 适配器 | `src/infrastructure/runtime/adapters.ts` | `renderAffectSection`（投影 → `effectiveAffect` 读时衰减 → `renderAffectGuidance`，永不写回；`appliedThisTurn` 透传）· `renderAffectReadback`（三段式只读读回）· `renderCriticalStateSection` 增加 `affectAxes` 透传 |
| 桥接 | `src/state/provider.ts` | `renderStateBlock`/`deriveBehaviorGuidance` 增加 `affectAxes`（缺省 true = M2 形态逐字不变；false = 情绪小节+轴行+情绪行为行退役——M8-D12） |
| 装配 | `src/main.ts` | open()：建档检查+中断恢复+开机追赶（`maybeRunAffectEvaluation` 一入口三件事，干跑不执行）· send()：**同轮评估**（beginTurn 后、编译前）+ `affectAppliedThisTurn` + 注入 + 轮后幂等补消费 · `--dump-prompt`：同形只读装配（`appliedThisTurn='unknown'`）· `--inspect`：三段式读回 |
| 部件门 | `scripts/m8-wp5-verify.ts` | 三段式 17 项（正控 9 / 负控 5 / 恢复 3），隔离库 + 真实 store/scheduler/编译器 |
| package.json | `m8:wp5:verify` | 点状追加 |

## 2. 关键语义（实现锚点，全部指向 ADR-066）

- **同轮时序**（§6.3，send() 内的硬顺序）：`beginTurn`（用户事件落账）→
  `maybeRunAffectEvaluation`（同步、确定性、无 LLM）→ 渲染 stateSection /
  relationshipSection / **affectSection**（读到的是含本轮的投影）→
  `compileTurn`。"用户刚说完的话"影响"这一轮"的注入块。
- **reply-truth 渲染面**（§6.2）：`affectAppliedThisTurn`——
  flushed/no_tail ⇒ `true`；failed ⇒ `false`（渲染器追加如实边界行
  "本轮情绪处理未完成——以上是上一份有效状态…"）；干跑 ⇒ `'unknown'`
  （不评估不落库 ⇒ 无法主张"本轮已应用"）。
- **桥接无双权威**（M8-D12 + §8.1 冻结形态）：`affectAxes=false` 只退役
  情绪轴；**关系轴归 M7 的 `relationshipAxes` 管，M8 不碰**（M8-D10）。
  两开关全开 ⇒ legacy 状态块两轴全退役，语义由 affect(52)/relationship(55)
  两个注入块唯一承载。开关全关 ⇒ 与 M6.1 逐字一致（m3.5:test 守着）。
- **安静机制**：未建档 / 开关关 / render 返回空 ⇒ 0 个 section ⇒
  M3.5 基线与合成轮次逐字节不变（P8/N5/m3.5:test 三重证据）。
- **措辞纪律**（§8.1）：45 个状态变体网格扫描——零轴名
  （valence/arousal/效价/唤醒）、除"距上次互动"锚点行外零数字；
  行为行与 M2 `deriveBehaviorGuidance` 情绪子集**逐字一致**（P3）。
- **消费静态锁**（D3 教训）：`main.ts` 中 `affectContextEnabled` 实测
  8 处消费（open 追赶 / send 同轮 / 桥接 / 注入 / 轮后 / dump-prompt…），
  门内断言 ≥ 4。

## 3. 量具读数

- 正控 9：确定性 · 中性档位 · 行为行逐字移植 · provider 信封（52/droppable/
  安静）· 开关+静态锁 · 全链路（播种→渲染→编译，52 排在 55 后）·
  播种幂等 · 装配一致（基线无 affect）· reply-truth 边界行。
- 负控 5：措辞网格（45 变体零泄漏）· 回滚形态（M2 逐字）· 桥接形态
  （情绪退役/关系原样）· 双桥接（两轴全退役）· 未建档安静+读回如实。
- 恢复 3：删行 ⇒ undefined → rebuild → 渲染逐字节一致 · 读回三段式 ·
  负控后全链路重走干净。
- `pnpm typecheck` EXIT 0。

## 4. 失败档记录

无（本门首跑即 PASS；WP4 的失败档见
[`M8-WP4-Handoff.md`](M8-WP4-Handoff.md) §4）。

## 5. 给 WP6 的输入

1. **同轮应用的落库路径已就绪**：send() 里的 `maybeRunAffectEvaluation`
   就是 WP6 要测的同轮应用本体——WP6 补的是 **trace 透传**（traceId 进
   runAffectEvaluation 的 job 记录）与 **6 类 trace step**
   （affect_eligibility / proposal / validation / event / projection →
   'turn'，affect_context → 'context'）。
2. **降级路径已就绪**：失败 ⇒ `scheduling.kind==='failed'` ⇒
   `affectAppliedThisTurn=false` ⇒ 边界行（P9 已证渲染面）；WP6 补的是
   **失败注入实验**（让评估器/放行口/落库各失败一次，验证旧投影 +
   affectApplied=false + 聊天不阻断）。
3. **回复真相**：`affectAppliedThisTurn` 需要进 reply-truth 链
   （`applyResponseTruthPolicy` 同款纪律——"没成功就没成功口吻"）；
   当前它只影响注入块边界行，WP6 决定是否加回复守卫。
4. **轮后补消费已在位**：send() 尾部的幂等补消费（她的回复事件 ⇒
   0 提案但水位前进）；WP6 的 e2e 要断言尾窗有界。
5. **干跑边界**：`--test` 不评估不落库（渲染 `'unknown'`）；WP7 的
   e2e 用真实 TurnGateway + 隔离库（非干跑）才能量到同轮应用。
6. **装配一致性红线**：`--dump-prompt` 与真实链路必须同一 Affect 装配
   （§8.2"不允许第二套渲染"）——改任何一边都要回头核对本门 P6/P8。
