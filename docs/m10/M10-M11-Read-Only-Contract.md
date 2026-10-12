# M10 → M11 **只读契约**（`U-12`）

- 日期：2026-09-29
- 依据：计划 §19（八条交接规则 + "M11 必须能只读取得"的清单）
- 状态：**只读面已冻结**；本文**不含** M10 的成就总结（那一份是 WP11 的
  `M10-to-M11-Handoff.md`，需要 WP10 的读数才能写）
- 机器判据：`pnpm m10:m11:verify` —— 本文的每条"在哪读"都有一条检查钉住

⚠️ **`U-12` 记作"十项"，计划 §19 原文是九个分号段。**
按 `goalId` / `commitmentId` 拆开计是十项 —— 本文按**九段**列，
并在 `A1` 里把 ids 拆成两条（`goalId` 与 `commitmentId` 各自可读），
与"十项"的说法对齐。**这个数字差我不掩盖**：它是原文与登记册措辞的差，
不是我省了一项。

---

## 1. 九段只读面：**在哪读**（这是本契约的核心）

计划 §19 说"M11 必须能只读取得"这九段。**其中四段不在目标投影里** ——
这是 M11 最容易踩空的地方，因此逐段写清"读哪里"：

| # | §19 的段 | **实际在哪** | 读面（符号） |
|---|---|---|---|
| ① | `goalId` | 投影 state | `GoalState.goalId`（经 `listGoalStates` / `getGoalRow`） |
| ① | `commitmentId` | 投影 state | `CommitmentState.commitmentId`（同一行，`GoalRowState.commitment`） |
| ② | `owner` / `target` | 投影 state | `GoalState.owner` · `GoalState.targetEntity?` |
| ③ | 当前 `revision` / `status` | 投影 state | `GoalState.revision` · `.status`；`CommitmentState.revision` · `.status` **各自独立** |
| ④ | 原始设立 / 采纳来源 | 投影 state | `GoalState.origin` · `.sourceRefs`；`CommitmentState.acceptanceRefs` |
| ⑤ | **规划依据的资格** | ⚠️ **不在投影里** —— **读时重算** | `recheckGoalDependencies()` → `GoalDependencyRecheckReport.verdicts`（每个依赖键一个 `ReferenceUsability`）。`GoalState.dependencies` **只有 id 与类别** |
| ⑥ | 变更原因 | **分两处** | 取消/受阻原因在 state（`cancelReason` / `blockedReason`）；**`GOAL_REVISED` 的 `changed` 只在事件 payload 里** |
| ⑦ | 完成 / 失败 / 取消证据 | ⚠️ **目标的那半不在投影里** | 目标的 `GOAL_COMPLETED.evidenceRefs` **只在事件 payload**（reducer 不把它折进 state）；承诺的那半**在** state（`completionRefs` / `completionBasis` / `violationRuleId`） |
| ⑧ | cutover | ⚠️ **不在目标表里** | 激活记录 / 事件序号水位（WP12 的载体），不是投影字段 |
| ⑨ | 是否**实际入模** | ⚠️ **不在目标表里** —— 在 **trace** | `goal_context` trace 步的 `fact_included` / `state_included` / `state_row_ids`（`U-20` 接的线） |

### 1.1 三段 `revision`，别搞混

```text
row.revision        CharacterProjection.revision —— **投影行**被折了几次（事件计数）
goal.revision       GoalState.revision          —— 目标**正式转换**次数
commitment.revision CommitmentState.revision    —— 承诺**自己**的转换次数（与目标各自独立）
```

⚠️ 头两个**不是**同一个数（WP9-B 正是靠这个差抓到了 `applyGoalRows` 被喂全量历史的缺陷：
增量路径 `row.revision` 涨到 487，而 `goal.revision` 只有 32）。M11 若把它们当同一个，
就会得出"这个目标改过 487 次"这种荒谬结论。

### 1.2 目标没有 `evidenceRefs` 字段 —— 这是**有意的**

`GoalState` 里**没有**完成证据字段（reducer 在 `GOAL_COMPLETED` 分支只落
`status` / `revision` / `lastEventAt`）。M11 要"完成证据"必须**读事件**。
⇒ 这条由门 `A3` 钉住（结构判据），不靠本文的一句话。

---

## 2. 八条交接规则（计划 §19 逐条，M11 **必须**遵守）

| # | 规则 | 在本仓库里的含义 |
|---|---|---|
| 1 | 目标是**期望**，不是事实；承诺是**承担**，不是完成 | `GoalState` 不是证据来源；`status === 'completed'` 不构成"世界上的事办成了" |
| 2 | `completed` / `fulfilled` **必须**带 criterion 与依据类型；`user_report` 与真实执行分开 | `successCriterion` + `completionBasis`；`D12`/`D13` 冻结的一对一映射 |
| 3 | 多次取回同一 Goal/结果**不是**独立证据，不得用于"反思自证" | 读取幂等 ≠ 证据累加；M9 的 `D26` 同族纪律 |
| 4 | M11 产生**独立待审**修订；写 Memory 走 M4 · 改 Belief 走 M9 · 改 Goal 走 M10 policy，**不绕过领域归属** | 门 `B1`/`B2` 钉住"读面里没有写原语、写入口就那三个" |
| 5 | 反思若与承诺冲突，**只能提议修订**；**不得**倒改历史接受内容以免看起来失约 | 事件不可改写（append-only）；修订是新事件 |
| 6 | 引用**每次使用重查**；失效 / 取消 / 遗忘 / 隐私规则继续有效 | 第 ⑤ 段"读时重算"就是这条的实现；`forbiddenSourceEventIds` 继续生效 |
| 7 | Lv2 以后**从 Goal 生成 ActionRequest**，也必须**重取**当前权限、目标与能力；**Goal 不缓存永久执行许可** | 目标不是能力凭证；权限每次重取 |
| 8 | 代码执行 / GitHub / 微信 QQ 的持续预授权与后台不干扰要求**保留在 M6.5 能力计划**，M10 **不建设**那些适配器 | M10 的范围 = Goals + 有限 Commitments（`M10-D01`：外部能力 NONE） |

---

## 3. 只读面的**边界**（机器判据，不是承诺）

```text
① **读面里没有写原语**：`listGoalStates` / `getGoalRow` / `listGoalRows` /
   `replayGoalRows` / `buildDeveloperGoalDto` / `buildDeveloperGoalList` 的函数体里
   不得出现 `insertProjection` / `saveProjection` / `deleteProjection` / `inTransaction`
   （判结构先去掉注释 ⇒ 写着"这里不写库"的注释不会把它自己打成违规）
② **写入口就那三个**：M10 领域里走事务的导出函数 = `applyAcceptedEvents` ·
   `applyGoalRows` · `rebuildGoalProjections`。新增第四个 ⇒ 本门变红
③ **隐私边界继续有效**：开发者面（M11 最可能读的那个面）走 `goalContentMustBeMasked`；
   被遮蔽的行**没有** `statement` / `nextStep`（`DeveloperGoalMaskedDto` 的**类型里**就没有）
```

⚠️ 边界 ③ 对 M11 特别要紧：**M11 若从开发者面读目标，读到的是遮蔽后的形状。**
要正文必须走领域侧（`listGoalStates`）并自己承担隐私规则的检查 ——
这条**不是**本契约新加的，是 M10 既有的隐私边界；写在这里是因为
"下游从哪个面读"这个选择本身就有隐私后果。

---

## 4. 本契约**不**主张什么

```text
· 它**不**总结 M10 的成就（那是 WP11 的 M10-to-M11-Handoff.md，等 WP10 读数）
· 它**不**冻结 DTO 的最终形状 —— U-12 的原话是"形状以只读 + 不新增写入口为界"。
  下面这些形状是**现状**，M11 若要改必须走 M10 的契约修订，不得在下游自行改
· 它**不**替 M11 决定怎么用这些面（"反思"的语义是 M11 的领域）
```

## 5. 现状形状（M11 可依赖；改它们 = 改 M10 契约）

```text
读面（领域侧，全量）
  listGoalStates(db, characterId)   → GoalRowState[]          （含 goal + commitment）
  getGoalRow(db, characterId, key)  → 行 | undefined
  listGoalRows(db, characterId)     → CharacterProjection[]   （含 row.revision）
  replayGoalRows(events)            → Map<行键, GoalRowState>  （纯重放，不碰库）
  createGoalStateLookup(db)         → GoalStateLookupPort      （放行口用的只读端口）

读面（开发者侧，**遮蔽后**）
  buildDeveloperGoalDto / buildDeveloperGoalList → DeveloperGoalDto（判别联合）
  DEVELOPER_GOAL_CAPABILITY_FACTS / DEVELOPER_GOAL_FORBIDDEN_EXPORT_PATTERNS

读面（trace）
  goal_eligibility / goal_proposal / goal_validation / goal_event / goal_context
  —— 只有操作名 / 具名码 / 计数 / id，**没有正文**（`R1`–`R3` 是机器判据）

读面（输入资格，**读时重算**）
  recheckGoalDependencies(ports, deps, options) → GoalDependencyRecheckReport
    .verdicts: Map<依赖键, ReferenceUsability>
    .measuredCount —— 0 ⇒ 调用方**必须**判 MEASUREMENT INVALID（AGENTS §6.8）

写面（**M11 不得调用**；列在这里是为了让"边界在哪"可见）
  目标领域**自己的**写入口（`goal-store.ts`，恰好 **2** 个）
    applyGoalRows · rebuildGoalProjections
  共享的**账本追加**（`event-store.ts`，**多领域共用**：affect / job /
  memory-recovery 都走它 —— 它**不是**目标领域的写入口）
    applyAcceptedEvents
```

### 5.1 ⚠️ 这条区分是门 `B2a` 逼出来的

契约初稿把写入口写成"三个"（把 `applyAcceptedEvents` 也算进目标领域）。
门一跑就红：`goal-store.ts` 里走事务的导出函数**只有两个** ——
`applyAcceptedEvents` 住在 `event-store.ts`，是**共享**的账本追加。

```text
✅ 目标领域自己的写入口   2 个（都在 goal-store.ts）
✅ 共享的账本追加        1 个（event-store.ts，多领域共用）
❌ 把它们并成"目标领域的三个写入口"  ← 初稿的错，而且错的是**契约文**不是代码
```

⇒ 这不是称呼问题：M11 若要判断"我有没有绕过领域归属"，它需要知道
**哪两个**是目标领域的写入口；把共享账本混进来会让这条边界看起来比实际宽。
现在两条检查分开钉：`B2a`（领域侧恰好 2 个）· `B2b`（共享追加只有一份，且目标领域没有重造）。
