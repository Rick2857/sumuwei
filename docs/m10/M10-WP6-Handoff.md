# M10 WP6 交接单

- 日期：2026-09-29
- 工作包：WP6（兑现与回复事实）
- 状态：**COMPLETE** —— 门 `m10:completion:verify` = **PASS 43/43**
- 依据：[`ADR-076`](../adr/ADR-076-m10-goals-and-commitments.md) §4.5 · §4.11 · **§4.8.3**（本轮追加）
  · `D11`–`D13` · `D26`
- 前置：[`M10-WP5-Handoff.md`](M10-WP5-Handoff.md)
- 本轮**没有**：打开真实库 · 调模型 · 出网

---

## 1. 交付了什么

| 交付物 | 位置 | 作用 |
|---|---|---|
| 完成判定器 | [`src/kernel/app/goal/completion.ts`](../../src/kernel/app/goal/completion.ts) | 三依据判定 · 结构检查（闭集）· 两个崩溃窗口分类 · 有界 reconciliation · 补记身份 |
| 门 | [`scripts/m10-completion-verify.ts`](../../scripts/m10-completion-verify.ts) → `pnpm m10:completion:verify` | 43 项（5 组） |
| 契约追加 | [`docs/adr/ADR-076`](../adr/ADR-076-m10-goals-and-commitments.md) §4.8.3 | 四条完成拒绝码 + 窗口优先级 + 禁止项具名 |
| 改动面映射 | [`scripts/gates/affected-map.ts`](../../scripts/gates/affected-map.ts) | M10 行补 `m10:completion:verify` |

### 1.1 门读数（`m10:completion:verify` = PASS 43/43）

| 组 | 项数 | 它对应哪条出口判据 |
|---|---|---|
| `J` 三依据互不替代 | 21 | ① 每条依据的正控 + **冒充它的负控** + 迟到 + 失败关闭 |
| `P` 两个崩溃窗口 | 6 | ④ 各自可达 + 恢复动作具名 + **禁止项具名** + 优先级 + 正控 |
| `R` 有界 reconciliation | 5 | ④ 上界 32 · 超出如实报出 · **来源是 pending_markers（不扫历史）** · 确定性 · 空集不是错误 |
| `I` 无二次副作用 | 5 | ④ 身份串确定 · 含 revision · 含结果引用 · registry 拒空依据 · **放行口第二次被拒** |
| `S` 结构性 | 6 | 拒绝码全覆盖可达 · 不 import SQL · **结论不带正文** · 读 `actorType` · 上界是具名常量且无历史读取入口 |

### 1.2 相关回归

| 门 | 读数 |
|---|---|
| `pnpm typecheck` | EXIT 0 |
| `pnpm m10:test` | **PASS 48/48** |
| `pnpm m10:source:verify` | **PASS 40/40** |
| `pnpm m10:invalidation:verify` | **PASS 37/37** |
| `pnpm m10:inputs:verify` | **PASS 25/25** |
| `pnpm gates:verify` | **PASS 48 项 / 0 失败** |
| `pnpm fast:offline` | **34 道 · PASS 34 · FAIL 0** |
| 真实库 | **从未被打开**（本门 `databaseScope = not-applicable`） |

### 1.3 证据（**两代**，与 WP0–WP5 同一纪律）

| 代 | runId | head | 说明 |
|---|---|---|---|
| 2（**权威**） | `artifacts/m10/m10-wp6-completion-20260929-8e3a89518b21-c78e/` | `8e3a8951`（WP6 文档提交） | 产生它的代码可被 head 定位（代码在其祖提交 `74363e24`） |
| 2（**权威**·另四门复跑） | `…-8e3a89518b21-` 下的 `m10-wp3-test-*24d8` / `m10-wp4-source-*c2fc` / `m10-wp5-invalidation-*f8ef` / `m10-wp2-inputs-*06fb` | `8e3a8951` | 48/48 · 40/40 · 37/37 · 25/25 |
| 1（历史） | `artifacts/m10/m10-wp6-completion-20260929-289ee129d1c1-3e47/` | `289ee129` | 跑的时候 WP6 代码还没提交 ⇒ head 指不到它。保留、不回写 |

⚠️ **本轮门第一次跑就 PASS（43/43），没有 FAIL 档**。
这与 WP2–WP5 不同（那几轮都先被门抓出至少一处缺陷）—— 本轮的形状是
"把 WP3/WP5 已经冻结的判据**组合**起来"，而不是引入新的状态机；
判定层的每一支都能在写的时候对着既有契约核。
**不**因此声称"WP6 没有缺陷"：真正的装配级缺陷要等 WP8 的网关级 e2e 才能暴露
（见 §5 与 `U-04`）。

---

## 2. 三条在实现里定形的东西

### 2.1 **读过的正文不留痕**（结构性，不是纪律）

判定 `conversation_output` 必须读 assistant 输出（结构检查要数列表项 / 找标记），
但 `GoalCompletionVerdict` 的类型里**没有** `text` 字段 —— 成功时只带
`{ evidenceCount, checkedItems, matchedMarkers }`。

⇒ "读过的正文被顺手写进 trace"在**类型上**不可能，而不是"我们记得不要写"。
门 `S3` 直接读类型声明来钉它。

### 2.2 **"她的输出不能自我确认"落在代码里**

`user_report` 分支显式检查依据事件的 `actorType`：不是 `user` ⇒
`completion_evidence_kind_mismatch`（门 `J2`）。`conversation_output` 分支反向检查
事件**不能**是 `user`，且 `replyToEventId` 必须等于**这一轮**的用户事件（门 `J7`）。

⇒ 三依据的"互不替代"不是文档约定，是两条方向相反的 `actorType` / 轮次检查。

### 2.3 **`executed` 与 `status` 是两个可区分的码**

```text
accepted=true, executed=false  ⇒ completion_evidence_not_executed   （G29：策略允许 ≠ 真的执行了）
executed=true,  status≠success ⇒ completion_evidence_failed          （G30：partial/timeout 不代替完成）
```

顺序是判据：先"执行了没有"，再"成功没有"。合并成一个"不成功"会丢掉
"策略允许但它根本没跑"这一层 —— 而那正是最容易被她当成"我做了"的情形。

---

## 3. 两个崩溃窗口（§4.11 的落成）

| 窗口 | 识别条件 | 恢复动作 | **禁止** |
|---|---|---|---|
| A | 变更已提交 **且** 回复未落盘 | `read_back_and_explain` | `fabricate_assistant_event` |
| B | 结果已落盘 **且** 兑现未提交 | `idempotent_backfill` | `regenerate_artifact` · `resend_side_effect` |

**优先级：B 先于 A**（ADR §4.8.3 的补充裁定）。两者同时在场时先收敛 B ——
补记是幂等的、不产生新的用户可见动作；而 A 的处置依赖"这一轮到底有没有真的发生"，
那要等 B 收敛后才有定论。顺序反了会**先向用户解释一件尚未确定的事**。

**"禁止做的事"是返回值**（`mustNot`），因此可被机器断言（门 `P2`/`P4`），
而不是一句写在注释里的注意事项。

---

## 4. 有界 reconciliation：`D23` 绊线的机器判据

```text
上界         32 项/次（GOAL_RECONCILIATION_MAX_ITEMS）
驱动来源     投影行里的**显式 pending 标记**
来源字段     plan.source === 'pending_markers'   ← 换一个值就意味着换了机制
超出部分     truncated 如实报出（不静默丢弃）
确定性       按 recordedAt 升序（同刻按 goalId）；打乱输入给同一批项
```

门 `S5` 额外做了一次**静态**检查：判定层的源码里**没有**
`conversationEventsInRange` / `recentConversationEvents` 这类读历史的入口 ——
这正是 ADR-076 `D23` 的绊线（"任何扫描不得回溯会话历史"）。

---

## 5. 具名限制（交给 WP11 的 Known-Limitations）

| 编号（建议） | 限制 | 依据 / 现状 |
|---|---|---|
| `L-M10-18` | `conversation_output` 的结构检查只认**列表项行首形态**与**逐字标记**两种 | 任何"更聪明的结构判断"都会变成语义判据 —— 而语义判据要有自己的量具（WP10）。方向保守：判不过就**不**完成 |
| `L-M10-19` | `action_result` 只按 `(capability, operation, executed, status)` 匹配，**不**读回执行效果 | 读回效果需要每个能力自己的判据（属能力包，不是目标域）。`require: 'executed_succeeded'` 是 v1 冻结的口径 |
| `L-M10-20` | 判定器**不会**自己去找依据；调用方必须给出 `evidenceRefs` 与 `turnUserEventId` | "自动找证据"会变成隐式的窗口扫描（`D23` 绊线）。装配层负责把这一轮的产物引用递进来 |
| `L-M10-21` | `classifyGoalCrashWindow` 的输入是**四个布尔事实**，判定器不自己去读它们 | 读它们需要网关级装配（轮次、落盘、兑现各自的提交点）⇒ 属 WP8 的端到端。本步只冻结**判定** |
| `L-M10-22` | 部分进展（`partial` 的 `progress`）**只**如实报告，**不**折算成"完成了百分之多少" | §9.1 要求"不把全部完成写绿；部分进展可查"。折算会造出一个没有依据的完成度数字 |

---

## 6. 下一步入口

**WP7：Context、trace 与开发者只读面。**

```text
输入  ADR-076 §6（隐私与可观察性）· §4.12（配置与开关）· `D08`（至多 1 焦点 / 1 nextStep /
      3 项入模）· `D22`（45 平局）· `D27`（goalTokens 缺省 0）· `D29`（事实块位置与不可裁级别）
      + WP5 的 orderGoalsForFocus（**裁剪**在本步落地）
      + 契约 §3 的 G37–G44
载体  src/kernel/context/sections.ts 的目标 section provider + contracts/context.ts 的
      goalTokens/ContextCategory + trace 五个具名步骤 + developer 只读 DTO
出口  预算与重编译正确 · off 档 prompt 基线不漂移 · 计数守恒可机器校验 ·
      trace 不含正文 · 开发者面只读且执行与聊天相同的遗忘资格
门    m10:context:verify + m10:observability:verify（新增两门）
```

⚠️ **`U-04` 的真正落点不是本步**：WP6 已交付**判定层**的两窗口分类（门 `P1`–`P6`），
而"落盘成功 / 落盘失败两种形状"的**网关级**探针需要一个可注入 provider 的完整一轮
⇒ 归 **WP8 的 `m10:e2e:verify`**。这一点已登记在 [未决项](M10-Unresolved-Decisions.md) 的 `U-04`。
