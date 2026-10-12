# M9 WP0-R 交接单 —— L-M8-13 M7 双缺陷修复

> 状态：**DONE**（2026-09-27）
> 计划：[`M9-Execution-Plan.md`](M9-Execution-Plan.md) §4.2 / §13 WP0-R
> 前置：[`M9-WP0-Handoff.md`](M9-WP0-Handoff.md)（准入实验 E1/E2 完整复现本缺陷）
> 销账记录：[`docs/Tech-Debt-Register.md`](../Tech-Debt-Register.md) §0d R-19
> 下一站：WP1（ADR-070 语义冻结）

## 1. 交付物

| 交付物 | 位置 | 判定 |
|---|---|---|
| 缺陷 (a) 修复：窗口/计数端口的 tool 过滤 | `src/kernel/app/relationship/job.ts` · `src/infrastructure/runtime/relationship-scheduler.ts`（`qualifiedUserEvents`） | `skippedToolEvents` 进 outcome（可审计读数） |
| 缺陷 (b) 修复：catch 落 failed + dry-run 入 try | `src/infrastructure/runtime/relationship-scheduler.ts`（消费段重构） | 形状 = affect-scheduler 的 WP7 A13 修 |
| 修复验证门 | `scripts/m9-wp0r-verify.ts`（`pnpm m9:wp0r:verify`） | **FIX VERIFIED 8/8**（runId `m9-wp0r-verify-20260927-a762d0a99882-8abd`） |
| M7/M8 门复验 | `artifacts/m7/` · `artifacts/m8/`（全部指向 `a762d0a`） | typecheck 0 · m7:test 3/3 · m7:e2e 21/21 · m7:measurement 19/19 · m8:e2e 21/21 |

提交切分：修复（`afa512b`）/ 验证门（`52987ae`）/ 量具校准（`a762d0a`）/
证据（`984dbb5`）各自独立。

## 2. 修复内容（三处生产位置）

```text
① job.ts 窗口转视图     events.filter(actorType !== 'tool') 先滤后转；
                        skippedToolEvents 计数进 RelationshipEvaluationOutcome
                        （跳过是可审计读数，不是静默丢弃——账本里 tool 事件原样可查）
② scheduler R-5 计数    qualifiedUserEvents 同款过滤（tool 事件第一关
                        type ≠ user_message 就不可能合格——跳过不放松任何保证）
③ scheduler 消费段      dry-run + 尾窗读取移入 try（"幂等且不抛"由结构保证）；
                        catch 里 finishJob(job.id, 'failed')，finishJob 自身失败
                        吞掉（主错误才是要报的）
```

**保持不变**：攒尾窗策略（零提案窗口 held 到 R-1 跨日累积 / 2000 上限强制消费）——
这是 M7 的设计（R-1 要攒、幂等键要窗口不相交），与 M8 Affect 的"每窗必消费"不同。
R6 专门验证了这一点。

## 3. 验证矩阵（8/8）

| 场景 | 期望（修复后） | 对照（修前，准入 E1/E2） |
|---|---|---|
| R1a 调度器 | tool 事件进窗口 ⇒ 完整返回（flushed） | E1b：抛 `tool_event_not_extractable_in_m4` 穿透 |
| R1b job 级 | `skippedToolEvents === 1` 如实计数 | （修前无此读数） |
| R2 消费段失败 | 行落 **failed** → 同窗重试恢复恰一次（新建=1，零重复） | E2b/E2c：行楔 running → 重试撞 `job_not_pending` 永久楔死 |
| R3 试算期失败 | 不抛 → failed → **无 job 行** → 去注入恢复 | （修前 dry-run 在 try 外，穿透） |
| R4 finish 自身失败 | 主错误如实上报（eval-write，非 finish-failed）；行留原状 = **文档化边界** | （修前无此路径） |
| R4b 边界出口 | 行转 failed 后同窗重试照常恢复（"留原状"不是死局） | — |
| R5 completed 后水位失败 | catch 把行翻 failed → 恢复**零重复**（新建=0，幂等键全命中）→ 水位补推进 | — |
| R6 攒尾窗 | 零提案 held（水位不动）→ 语义命中连同持有事件一次消费 | 策略面（不因修复改变） |

恢复路径三态（计划 §4.2 要求）全覆盖：**enqueue 前失败**（R3）/ **finish 失败**（R4/R4b）/
**completed 后 watermark 失败**（R5）。

## 4. 量具校准记录（6/8 中间档留档）

| runId | 缺陷 | 修正 |
|---|---|---|
| `m9-wp0r-verify-…-9e28`（6/8） | R1b 在 R1a 消费后用 `watermark+1..latest` 取窗 ⇒ 空窗（skippedToolEvents=0）；R4 的 `/set status = failed/` 依赖参数值渲染——drizzle 参数不进 SQL 文本（M8 的标记全匹配静态文本） | R1b 改为消费前捕获窗口界、重跑同一窗；R4 改结构标记 `/update character_jobs[\s\S]*finished_at/`（markJobRunning 是 started_at、enqueueJob 是 insert，三者可区分） |

被测对象（修复本体）在量具修正前后行为一致；修正只涉及场景取窗时机与注入标记。

## 5. 给 WP1 的输入

1. **L-M8-13 = CLOSED**：三域联合验收的前置欠账已还；M9 的 belief 评估器
   接 tool 事件或同形调度时，参照形状已在生产（job.ts 过滤 + scheduler catch 落 failed）。
2. **新可审计读数**：`RelationshipEvaluationOutcome.skippedToolEvents`——
   belief 的评估器 outcome 设计应包含同款跳过计数（跳过永远可查，不静默）。
3. **恢复路径设计输入**：三态恢复矩阵（R3/R4/R5）就是 belief 调度器的
   失败语义模板；"行留原状 + 手工自愈出口"（R4/R4b）是库已坏形状的文档化边界。
4. M7 冻结文档不回写；本修复的销账记录在登记册 §0d R-19。
