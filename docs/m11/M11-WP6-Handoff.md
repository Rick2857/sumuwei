# M11 WP6 交接单

- 日期：2026-10-01
- 工作包：WP6（跨域待审修订、撤回与同轮阻断）
- 状态：**COMPLETE** —— 同轮阻断 + 确定性失效规划 + 只读待审面 + 结构锁四件落地；
  门 `m11:invalidation:verify` = **PASS 18/18**（零模型调用）
- 设计权威：[ADR-085](../adr/ADR-085-m11-reflection-and-bounded-adaptive-self.md) `D07` / `D12` / `D13` · §5
- 证据（两代，**都保留**）：
  - **权威代** `artifacts/m11/m11-wp6-20261001-982b2ad99b69-127e/`（**18/18**，head = 实现提交）
  - `artifacts/m11/m11-wp6-20261001-b13ada257f02-c915/`（18/18，脚本未提交）
- 本轮**没有**：打开真实库（`isolateDatabase()` 一次性沙箱）· 调模型（`modelCalls: 0`）· 出网 · 改 DDL

---

## 1. 交付的代码

| 文件 | 内容 |
|---|---|
| [`contracts/revision-intent.ts`](../../src/kernel/contracts/revision-intent.ts) | 待审意图形状（**没有** proposal 正文字段）· 域闭集 · 根资格读数 · 同轮可用性判定 · 失效计划形状 |
| [`app/reflection/invalidation.ts`](../../src/kernel/app/reflection/invalidation.ts) | `filterAdaptiveSelfThisTurn()` / `filterReflectionThisTurn()`（**同步**，不等后台）· `planInvalidation()`（**确定性**）· `listPendingRevisionIntents()` / `checkRevisionIntent()`（只读待审面） |

### 1.1 两条时间尺度（`D12` 的落点）

```text
当前轮（同步）：根被忘掉/撤回/版本漂移 ⇒ **立刻**不可用 —— 此时后台可能一条失效事件都没有
后台（异步）  ：追加 `REFLECTION_INVALIDATED` + 更新投影 —— 把"为什么失效"落成可审计的记录
⇒ 顺序不可颠倒：只做后台那一步 = 在窗口里继续用一个**已被遗忘的依据**作答
```

### 1.2 三个刻意的判断

```text
① 遮蔽（`source_privacy_masked`）与"读不到"（`unavailable`）**不构成永久失效** ——
   两者都是**暂时**的，不该把一条已采纳的反思永久废掉。只有遗忘 / 撤回 / 版本漂移才落账。
② 失效计划是**确定性**的：`causeEventId` 取**排序后第一个**被挡的根 ⇒
   同一状态重跑给出同一个计划 ⇒ 域内幂等键稳定。
③ `rejected` / `retracted` 的意图**不进**待审面 —— "已经不该处理" ≠ "还没处理"。
```

---

## 2. 门（`m11:invalidation:verify` = **PASS 18/18**）

```text
A 同轮阻断 5：源被忘掉 ⇒ 当前轮即不可用且**后台零失效事件** · 批量过滤分列 ·
             反思本身同规则 · **拿不到读数 = 不可用**（失败关闭）· 遮蔽 ≠ 永久失效
B 失效落账 2：根顺序不同 ⇒ 同一个计划（确定性）· 同一计划投递两次 ⇒ 第二次在**放行口**
             被 `duplicate_operation` 拒，账本**只有一条**事件
C 历史/当前 2：回放仍读到"当时是 accepted"，当前可用性说不可用（两个读数并存）· 失效原因留在读数里
D 待审面 5：已采纳的反思带出意图 · 版本一致/过期/目标缺失三态 · 夹带 proposal 正文被拒 ·
            越界域与 rejected/retracted 不进面 · **失效后意图从待审面消失**
E 跨域锁 3：跑 10 轮后 Memory/Belief/Goal/Commitment 事件数**一个都没变**（分母非零）·
            本域写入确实发生 · 失效模块里没有旧域写入口
S 量具自检 1
```

⚠️ 门自己抓到一处**测试设计错误**（不是产品缺陷）：第一版把"重复投递"写成 `emit`（断言通过），
于是第二次投递在放行口被拒时**整个门抛错**。改成断言"第二次被 `duplicate_operation` 拒"后，
读数比原来更强 —— **重复是在放行口被拒的，不是被静默去重的**。

---

## 3. 下一轮（WP7：任务、水位、恢复与真实入口）

```text
jobs 持久登记 · 双流水位 · 触发过滤 · 合并区间 · 串行模型任务 · 真实 abort ·
**late-write fence**（`L-M11-11`：仓库里今天没有这道闸 ⇒ M11 要自己建）· 受控关闭与重启恢复
门 `m11:recovery:verify`：tool/assistant 事件不楔死 · catch 落 failed · 同窗恢复可达 ·
重复补跑无重复业务事件 · 崩溃窗事件/投影对账 · **关闭后晚返回零写入**
```

---

## 4. 受影响旧门的回归读数

```text
kernel:test EXIT 0 · kernel:verify EXIT 0 · m4:test 258/0 · m4:verify 142/0
m11:lineage:verify 34/34 · m11:inputs:verify 39/39 · m11:policy:verify 25/25 · m11:adaptive:verify 22/22
m11:invalidation:verify 18/18
```

⚠️ 这是**受影响门**读数，不是全量回归；WP11 仍须按计划 §13 跑完整清单（含 `m4.5:ci`）。
