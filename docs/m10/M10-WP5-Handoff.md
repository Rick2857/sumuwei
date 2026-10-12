# M10 WP5 交接单

- 日期：2026-09-29
- 工作包：WP5（依赖失效、Goal 遗忘与冲突处理）
- 状态：**COMPLETE** —— 门 `m10:invalidation:verify` = **PASS 37/37**
- 依据：[`ADR-076`](../adr/ADR-076-m10-goals-and-commitments.md) §4.6 · §5 · §6.4 · §4.10 · `D09` · `D10`
  · **§4.8.2**（本轮追加的两个原因值与 `L-M10-08` 的裁定）
- 前置：[`M10-WP4-Handoff.md`](M10-WP4-Handoff.md)（语义提案链就绪）
- 本轮**没有**：打开真实库 · 调模型 · 出网

---

## 1. 交付了什么

| 交付物 | 位置 | 作用 |
|---|---|---|
| 失效 / 遮蔽 / 冲突判定 | [`src/kernel/app/goal/invalidation.ts`](../../src/kernel/app/goal/invalidation.ts) | 三类依赖处置 + 优先级 · **确定 vs 读不到**两张表 · 读侧遮蔽（纯函数）· 旧根禁用 · 冲突判定 · 确定性排序 |
| 契约追加 | [`src/kernel/contracts/goal.ts`](../../src/kernel/contracts/goal.ts) | `GoalBlockedReason += 'dependency_unavailable'` · `GoalCancelReason += 'goal_superseded'`（**只追加**） |
| 放行口 | [`src/kernel/policies/goal-validator.ts`](../../src/kernel/policies/goal-validator.ts) | `hasPairedCommitmentCancellation()` —— 取消**与实质替代**都要求配对取消承诺（**关闭 `L-M10-08`**） |
| 门 | [`scripts/m10-invalidation-verify.ts`](../../scripts/m10-invalidation-verify.ts) → `pnpm m10:invalidation:verify` | 37 项（6 组） |
| 改动面映射 | [`scripts/gates/affected-map.ts`](../../scripts/gates/affected-map.ts) | M10 行补 `m10:invalidation:verify` |

### 1.1 门读数（`m10:invalidation:verify` = PASS 37/37）

| 组 | 项数 | 它对应哪条出口判据 |
|---|---|---|
| `D` 三类依赖的处置 | 10 | ① **逐条可达** + 优先级（根压过前提）+ **正控**（不失效 ⇒ `none`）+ 能力条件独立 |
| `M` 读侧遮蔽 | 6 | ② 「忘掉」与「取消」的读侧差异可判定 ③ **独立于写侧** |
| `F` 旧根禁用 | 4 | ④ **不因内容再次出现而解除** |
| `C` 冲突与排序 | 8 | §6.4 冲突判定（对称、两类）+ §4.10 确定性排序（不依赖输入顺序） |
| `W` `L-M10-08` 写侧联动 | 4 | 实质替代的配对要求 + 折叠结果（**不顺延**）+ 取消路径回归 |
| `S` 结构性 | 5 | 两个原因值并存 · 分类表全覆盖不重叠 · 单一判据 · 不 import SQL |

### 1.2 相关回归

| 门 | 读数 |
|---|---|
| `pnpm typecheck` | EXIT 0 |
| `pnpm m10:test` | **PASS 48/48**（放行口本轮被改动 ⇒ 必跑） |
| `pnpm m10:source:verify` | **PASS 40/40** |
| `pnpm m10:inputs:verify` | **PASS 25/25** |
| `pnpm gates:verify` | **PASS 48 项 / 0 失败** |
| `pnpm fast:offline` | **34 道 · PASS 34 · FAIL 0** |
| 真实库 | **从未被打开**（本门 `databaseScope = not-applicable`） |

### 1.3 证据（**两代**，与 WP0–WP4 同一纪律）

| 代 | runId | head | 说明 |
|---|---|---|---|
| 2（**权威**） | `artifacts/m10/m10-wp5-invalidation-20260929-408b8809e73f-b216/` | `408b8809`（WP5 文档提交） | 产生它的代码可被 head 定位（代码在其祖提交 `7e5315d0`） |
| 2（**权威**·另三门复跑） | `…-408b8809e73f-` 下的 `m10-wp3-test-*f8e9` / `m10-wp4-source-*47f5` / `m10-wp2-inputs-*b0b1` | `408b8809` | 48/48 · 40/40 · 25/25（放行口改动后仍绿） |
| 1（历史） | `artifacts/m10/m10-wp5-invalidation-20260929-fe3352f6be7a-*`（3 个） | `fe3352f6` | 两次 FAIL + 一次 PASS 的迭代档（第一次 W4 漏了旧目标的建立事件 ⇒ 孤儿事件按设计 no-op）。保留、不回写 |

---

## 2. 本轮裁定的两件事（都进了 ADR-076 §4.8.2）

### 2.1 `L-M10-08` 关闭：**承诺不顺延**

```text
实质替代（GOAL_SUPERSEDED）一个带 active 承诺的目标
  ⇒ 同一提案里必须作废该承诺（COMMITMENT_CANCELLED，reason='goal_superseded'）
  ⇒ 否则拒绝 goal_orphan_commitment
  ⇒ 新目标**没有**承诺；要新承诺必须重新受理（新身份）
```

**为什么**：承诺是对**旧对象 / 旧成功条件**答应的，而"实质替代"的定义就是那两者变了。
顺延 = 在用户没有重新同意的情况下重新划定一个正式义务 ⇒ §4.2 明令禁止。

**实现上不新增概念**：与"取消目标"共用 `hasPairedCommitmentCancellation()`。
门 `W4` 用真事件流折叠验证结果：旧目标 `superseded` · 旧承诺 `cancelled` · 新目标 `commitment === null`。

### 2.2 **读不到 ≠ 失效**：读失败只允许 `blocked`，绝不允许 `cancelled`

```text
确定失效（forgotten / root_missing / revision_changed / status_not_usable / foreign / overlaid）
    ⇒ 有资格触发 cancel 或 block
读不到（unavailable / withdrawn_incomplete）
    ⇒ 一律 blocked('dependency_unavailable')，**绝不** cancel
```

**为什么这条必须写死**："宁过遮不漏"在**遮蔽**上成立（读侧、可逆），
但**不**在 `cancelled` 上成立（写侧、append-only、不可逆）。
拿一次读失败销毁一个合法目标 = 让一次数据库抖动抹掉用户的约定。
门 `D2`（根证据读不到 ⇒ block）与 `D8`（根读不到 + 前提确定失效 ⇒ 仍是 block）把它钉住。

⚠️ **S3 是这条的守卫**：以后往 `ReferenceRejectionReason` 里新增一个值却忘了分类
（确定 / 读不到），那条检查会**红**。这是有意设计的绊线 ——
它防的正是"新加一个 reason，默认落进错了的那一半"。

---

## 3. 三类依赖的处置与优先级（逐条）

| 类 | 失效后的处置 | 事件 |
|---|---|---|
| `root_evidence` | 目标**失去使用资格**：读侧立即整项遮蔽 + 写侧记撤回原因 | `cancel(root_evidence_withdrawn)` |
| `necessary_premise` | `blocked` + 具名原因；用户确认前不自动重新执行 | `block(necessary_premise_invalid)` |
| `optional_background` | 丢引用、重新规划；**目标保留** | `revise_drop_references` |
| （任一类的）**读不到** | `blocked('dependency_unavailable')`（可逆、不销毁） | `block(dependency_unavailable)` |
| 能力不满足 | 独立判定，与依赖失效分开（能力恢复**不需要**重新确认依据） | `block(capability_unavailable)` |

**优先级**（判据的一部分）：根证据**确定**失效 > 根证据读不到 > 必要前提确定失效 >
必要前提读不到 > 只剩可选背景 > 无失效。
⚠️ 根证据压过必要前提 —— 前者是"这个目标根本不该存在"，后者是"它现在做不了"。
并列会让同一个世界状态给出两种结论。

---

## 4. 读侧遮蔽为什么能"独立于写侧"

```text
触发条件①  最近一次取消原因是 explicit_forget
触发条件②  该目标的**任一来源事件**落在**当前**撤销集里
```

**条件②完全不要求任何取消事件已经被写。** 门 `M4` 用一个
`status='active'`、`cancelReason` 未定义、但来源在撤销集里的行来证明这一点：
写侧一个字节都没动，遮蔽照样生效。

**这是 M9 的 F-1（呈现层遗忘泄漏）同族的缺陷面**：若遮蔽要靠写侧先跑，
那么写侧失败 / 后台没跑 / 正在重建的那一轮就会泄漏。本层的读侧判定是**纯函数**，
所以那条通路不存在。

⚠️ 它**不**声称"忘掉 = 物理擦除"（append-only 审计照旧）；它回答的是
"这一项能不能进普通上下文与普通查询"。

---

## 5. 具名限制（交给 WP11 的 Known-Limitations）

| 编号（建议） | 限制 | 依据 / 现状 |
|---|---|---|
| `L-M10-14` | 冲突判定只覆盖**两类可机器判定**的情形（同对象同描述 + 不同机器可判 criterion / 两个 active） | §6.4 的其余情形（"看起来冲突"）需要语义判断 ⇒ 属 WP10。**不**在这里猜 |
| `L-M10-15` | `orderGoalsForFocus` 只做**排序**，不做"至多 1 焦点 / 至多 3 项入模"的**裁剪** | 裁剪依赖 ContextCompiler 的预算与 section 渲染 ⇒ 是 WP7 的事。本步只给确定性顺序 |
| `L-M10-16` | `detectGoalConflict` 用**原话归一化**（trim + 去空白）判"同描述" | 改述过的同一件事**不会**被判成冲突（那需要语义等价判断）。方向是**保守**的（少报冲突，不误合并记录） |
| `L-M10-17` | 读侧遮蔽只覆盖**目标自身**的来源，不覆盖"目标的 `statement` 复制了被忘取值" | §5 第 1 条要求"整项退出普通上下文"，已做到；但若某个**未被撤销**的来源里间接包含该取值，v1 **不**做取值级比对（那需要值级追踪）。与 M9 的 `L-M9-13` 同族 |

---

## 6. 下一步入口

**WP6：兑现与回复事实。**

```text
输入  ADR-076 §4.5（三种达成依据 + criterion 闭集）· §4.11（两个崩溃窗口）· `D11`–`D13` · `D26`
      + WP3 的放行口（`GOAL_COMPLETED` / `COMMITMENT_FULFILLED` 已就绪）
      + WP4 的 `report_complete` 映射（已接上 `user_report`）
载体  src/kernel/app/goal/completion.ts + 有界 reconciliation
出口  三种依据互不替代；`conversation_output` 必须绑定**已落库**的 assistant event；
      迟到结果按 `expectedRevision` 判 stale；两个崩溃窗口各有恢复路径且**无二次副作用**
门    m10:completion:verify（新增）
前置  `U-04`（Q4 的端到端探针：落盘成功 / 落盘失败两种形状）
```

**不要**在 WP6 里顺手做 WP7 的上下文接线或 WP8 的量具三段式 —— 契约 §5 的"落地 WP"列是边界。
