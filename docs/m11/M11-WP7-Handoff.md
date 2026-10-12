# M11 WP7 交接单

- 日期：2026-10-01
- 工作包：WP7（任务、水位、恢复与真实入口）
- 状态：**COMPLETE** —— 窗口规划 + 慢路径调度 + **late-write fence** 三件落地；
  门 `m11:recovery:verify` = **PASS 17/17**（零模型调用）
- 设计权威：[ADR-085](../adr/ADR-085-m11-reflection-and-bounded-adaptive-self.md) `D15` / `D16` / `D17` · §7.1–§7.3
- 证据（两代，**都保留**）：
  - **权威代** `artifacts/m11/m11-wp7-20261001-3d57e3b8e211-18f5/`（**17/17**，head = 实现提交）
  - `artifacts/m11/m11-wp7-20261001-7ab5d3808a63-7ac6/`（17/17，脚本未提交）
- 本轮**没有**：打开真实库（`isolateDatabase()` 一次性沙箱）· 调模型（`modelCalls: 0`）· 出网 · 改 DDL

---

## 1. 交付的代码

| 文件 | 内容 |
|---|---|
| [`app/reflection/job.ts`](../../src/kernel/app/reflection/job.ts) | `planReflectionWindow()`（水位 → 有界窗口 → 水位上界；**跳过 tool/assistant 但越过它们**）· `mergePendingWindows()`（只扩大 + `mustInvalidate` 取并集） |
| [`app/reflection/late-write-fence.ts`](../../src/kernel/app/reflection/late-write-fence.ts) | `createLateWriteFence()` · `guardedWrite()` · `withLateWriteFence()`（**拒绝是返回值，不是异常**；`refusedCount` 可观测） |
| [`infrastructure/runtime/reflection-scheduler.ts`](../../src/infrastructure/runtime/reflection-scheduler.ts) | `maybeRunReflectionEvaluation()`：水位门 → `enqueueJob` → `markJobRunning` → run → `finishJob` → `advanceWatermark`；**catch ⇒ failed 且水位不前进**；同窗已完成 ⇒ `recovered`（只补水位） |

### 1.1 `L-M11-11` 已销账：仓库里**第一次**有 late-write fence

```text
WP0 的侦察逐字：`grep fence|late_write` 在 `src/` **零命中**。
本步把 `D17` 的要求落成一道**真的闸**（不是注释）：
  · 关闭是一次性、单向的（没有 `open()` —— 重开会把一次关机变成一次竞态）；
  · 拒绝是**返回值** `late_write_fenced`（抛异常会让"被挡下"与"执行器坏了"长得一样）；
  · `refusedCount` 可观测（否则"闸在工作"与"闸从没被触发过"无法区分）；
  · C3 用**真实库**证明：结果在关闭**之后**回来 ⇒ commit 被挡 ⇒ 账本事件数**一个都没变**。
```

### 1.2 三条事故教训各自有负控

```text
① tool / assistant 跳过但水位**越过**它们（A2）—— 不跳过 ⇒ 窗口永远含它 ⇒ 永久楔死
② catch ⇒ 任务行如实落 `failed` + 水位**不前进**（B3）—— 留 running ⇒ 同窗重试撞 job_not_pending
③ 失败之后同窗重试**可达**（B4，水位 3 → 5）—— "补洞"真的走得通
```

---

## 2. 门（`m11:recovery:verify` = **PASS 17/17**）

```text
A 窗口规划 5：无尾巴 ⇒ 不调模型 · tool/assistant 跳过但越过 · 60 条 ⇒ 只消费 50 且 truncated ·
            合并不丢失效（范围取并 + mustInvalidate 取并集）· requiresInvalidation 进 mustInvalidate
B 调度 5：有尾巴 ⇒ 真跑一次且水位前进 · 水位已到 ⇒ no_tail（runs 不增）·
          run 抛错 ⇒ 任务落 failed + 水位停在 3 · 失败后重跑 ⇒ 成功且水位到 5 ·
          同窗已完成 ⇒ 不重跑（runs 不增）
C 晚写闸门 3：关闭前放行 / 关闭后返回 `late_write_fenced` + refusedCount=1 · close 幂等且**没有** open ·
            **真实库零写入**（分母非零：1 → 1）
D 结构 3：调度器真的调了 `finishJob(…, 'failed')`（去注释后命中）· **不自己 setTimeout/setInterval** ·
          调度本身不产生反思事件
S 量具自检 1
```

⚠️ 本轮又遇到一次"**0 → 0**"陷阱：C3 第一版的账本计数是 0，于是"零写入"与"计数器不工作"无法区分。
修法：先写一条无关的领域事件把分母打到 1（与 WP3/WP5/WP6 同一条纪律，已写进交接单）。

---

## 3. 下一轮（WP8：ContextCompiler、回复事实与开发者面）

```text
唯一预算传递（`ContextBudget.adaptiveSelfTokens`，缺省 0）· 现有 `adaptive-self` section（优先级 44）·
程序事实包（五态）· reflection/adaptive trace · 隐私 DTO · 程序状态与回复绑定
门 `m11:context:verify`：最终 packet 与 trace 逐 id/revision 相同 · 预算 0 无 section ·
被裁不算入模 · 待审/失败/已采纳但未调整/生效/撤回各自表述正确
⚠️ `D34`：新额度必须**真的接线**（照 `rollupTokens` 形状）+ 静态回归锁
```

---

## 4. 受影响旧门的回归读数

```text
kernel:test EXIT 0 · kernel:verify EXIT 0 · m4:test 258/0 · m4:verify 142/0
m11:lineage:verify 34/34 · m11:inputs:verify 39/39 · m11:policy:verify 25/25 ·
m11:adaptive:verify 22/22 · m11:invalidation:verify 18/18 · m11:recovery:verify 17/17
```

⚠️ 这是**受影响门**读数，不是全量回归；WP11 仍须按计划 §13 跑完整清单（含 `m4.5:ci`）。
