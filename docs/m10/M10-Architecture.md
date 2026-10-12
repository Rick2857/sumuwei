# M10 Architecture —— 目标与承诺域（Goals & Commitments）

- 日期：2026-09-29
- 状态：**描述"已建成的设计"**。⚠️ 本文件**不含**任何语义/人审/live 结论 ——
  那三槽的读数由 WP10/WP11 另出（见 [`M10-Known-Limitations.md`](M10-Known-Limitations.md) §1.2）。
- 权威设计载体：[`ADR-076`](../adr/ADR-076-m10-goals-and-commitments.md)（`ACCEPTED / DESIGN FROZEN`）
  + [`M10-Acceptance-Contract.md`](M10-Acceptance-Contract.md)（`DESIGN FROZEN`）。
  **冲突时以 ADR 与契约为准**，本文件是它们的**可读入口**，不是第二份权威。

---

## 1. 一句话

目标是**期望**，承诺是**承担**：M10 让"我们定个目标吧"这类话变成**可查、可审计、可撤销**
的正式记录，并且**只有程序**能决定它是否成立 —— 模型可以提议，不能接受。

## 2. 分层与依赖方向

```text
src/kernel/contracts/goal.ts            纯类型与闭集（状态 / 操作 / 判据 / 拒因 / 依赖类别）
src/kernel/contracts/goal-proposal.ts   草案契约（模型**唯一**能产出的形状 + 字段允许表）
src/kernel/contracts/goal-reference.ts  M9.5 交接的引用形状（MemoryReference / BeliefReference）
src/kernel/projections/goal.ts          折叠（`goal-fold@1`）—— **纯 reducer**
src/kernel/policies/goal-validator.ts   **唯一放行口**（提案 → 事件）
src/kernel/app/goal/inputs.ts           读侧输入资格（真实 revision / 读时重查 / 撤销集）
src/kernel/app/goal/understanding.ts    有界语义理解（草案 → 程序提案）
src/kernel/app/goal/turn.ts             **唯一编排入口**（一轮的全过程）
src/kernel/app/goal/invalidation.ts     失效 · 遗忘 · 冲突（`detectGoalConflict`）· 焦点排序（`orderGoalsForFocus`）
src/kernel/app/goal/completion.ts       兑现判定 · 崩溃窗口 · 回复结构检查
src/kernel/app/goal/developer-face.ts   开发者只读面（**遮蔽后**的 DTO）
src/kernel/context/goal-sections.ts     两条上下文段（事实块 + 状态块）
src/infrastructure/persistence/goal-store.ts        投影与重建（**唯一** SQL 处）
src/infrastructure/persistence/goal-input-store.ts  输入端口（Memory/Belief 的只读查询）
evals/m10/                                语料 · 折叠 oracle · 度量机 · 人审计分
scripts/                                  23 个 `m10-*.ts`：
                                          **2 个库**（m10-evidence = 证据层 · m10-harness = 轮次接线）
                                          **18 道门** · **2 个探针**（baseline · wp0-admission）
                                          **1 个人驱动工具**（m10-review-score，跑不起来的命令不当门）
```

**依赖方向**：`infrastructure → domain`，绝不反向。
`src/kernel/**` 里出现 `@elizaos/*` / `drizzle-orm` / `node:*` 会让 `pnpm kernel:test`
的分组「Kernel 边界（依赖方向）」直接失败（`src/kernel/app/` 是唯一例外）。

⚠️ `app/goal/**` 里**没有** SQL：库访问全部经端口（`GoalWritePort` / 只读端口 /
`GoalStateLookupPort`）。那是"编排可被离线门驱动"的前提 —— 门能注入真库端口或假端口。

---

## 3. 语义模型

### 3.1 两个状态机住在**一行**里（`D03`）

```text
GoalRowState = { goal: GoalState, commitment: CommitmentState | null }
投影行键      = `goal:<goalId>`（复用 `character_projections`，**零迁移**）
```

```text
GoalState       6 个状态：active · paused · blocked · completed · cancelled · superseded
                终态 3 个：completed · cancelled · superseded（**不可迁移**）
CommitmentState 5 个状态：active · fulfilled · broken · cancelled · superseded
                **最多一个**承诺（v1 有意限制：多承诺需要额外一致性机制）
```

⚠️ **两个 `revision` 各自独立**：`goal.revision` 与 `commitment.revision` 互不影响；
再加上投影行自己的 `row.revision`（折了几次），一共**三个不同的数**。
（把它们当同一个会得出"这个目标改过 487 次"这种荒谬结论 —— WP9-B 正是靠这个差抓到了缺陷。）

### 3.2 草案契约是**唯一的模型输出面**（`D07`）

```text
模型能产出：一份**有界草案** —— 操作名 + 原话 span + 该操作的少量字段
字段允许表  `GOAL_DRAFT_FIELD_ALLOWLIST`：每个操作**只**允许它该有的字段
            （例：`pause` 上不许出现 `statement`）
span 校验   必须落在**本轮原话**内，且长度与操作相符
⇒ 越界的输出 = `invalid_output`（具名），**不是**被静默裁剪
```

`statement: ['create','revise']` —— 这处曾经是 `['create']`，与内核的
`GOAL_REVISABLE_FIELDS`（含 `statement`）**自相矛盾**，导致"用户要求改描述"
在草案层**根本无法表达**（WP9-B 的 10 轮修订全部 `invalid_output` 抓到）。现已一致。

### 3.3 来源资格来自**上游两个域**（`D06` / M9.5 交接）

```text
Memory 依赖 ⇒ MemoryReference（**真实 revision**）+ 读时重查
Belief 依赖 ⇒ BeliefReference（投影版本 + epistemic 标签）+ 读时重查
撤销集      ⇒ `computeWithdrawnEvidence()` —— **每次复核重算，不缓存**
```

**读时重算**是 `D06` 的要害：缓存会让"上一轮的更正"被绕过。
撤销集本身由 **M9.1 的端口原样复用**（`computeWithdrawnEvidence` 住在
`src/infrastructure/persistence/withdrawn-evidence.ts` —— **不是** M10 新造的，
M10 只**每次复核都重算**它，见 `goal-input-store.ts`）。

---

## 4. 事件与生命周期

### 4.1 事件集（**13 个**）

```text
目标 8：GOAL_CREATED · REVISED · PAUSED · RESUMED · BLOCKED · COMPLETED · CANCELLED · SUPERSEDED
承诺 5：COMMITMENT_ACCEPTED · FULFILLED · BROKEN · CANCELLED · SUPERSEDED
```

### 4.2 转移表（`goal-fold@1`）

折叠是**纯函数**：`reduceGoalRow(state, event) → state`。非法组合一律 **no-op**
（**状态不变且 `revision` 不动**）—— 这条由 oracle 门 `O4` 逐组合钉住。

```text
active   →(PAUSED) paused · (BLOCKED) blocked · (REVISED) active · (COMPLETED/CANCELLED/SUPERSEDED) 终态
paused   →(RESUMED) active · (BLOCKED) blocked · …
blocked  →(RESUMED) active（**保留 preservedStatus**）· …
终态     → 无出边（**不可迁移**）—— 唯一的出路是"新身份"（新 id）
```

**"取消后同内容新请求"能建立新身份**（`D05`：Goal ID 含来源/操作身份，不是内容键）
—— 否则被取消的目标会**永不复活**（那是 M4 冻结层在 `F-4` 上的同款坑）。

### 4.3 取消与承诺取消是**两条**事件

`GOAL_CANCELLED` **不**顺带取消承诺；"必须配对"是**放行口**的判据
（`hasPairedCommitmentCancellation()`，`L-M10-08` 的裁定：取消**与实质替代**都要求配对，
**承诺不顺延**）。⇒ 审计能分别回答"目标为什么结束"与"承诺为什么结束"。

---

## 5. 一轮的处理链

```text
TurnGateway
  └─ runGoalTurn()                    ← 唯一编排入口（`app/goal/turn.ts`）
       ├─ 读候选（只读端口，**走遮蔽**）
       ├─ understandGoalProposal()    有界输入 → provider → 严格校验（**不吞失败**）
       ├─ draftToProgramProposal()    草案 → 程序提案
       ├─ validateGoalProposal()      **唯一放行口**：授权 / 合法边 / 乐观锁 / 幂等
       ├─ 写：领域事件 + 投影行        （**两个事务**，见 `L-M10-05`）
       └─ 出：结论 + 程序事实 + 五个 trace 读数（**只有码/计数/id**）
```

### 5.1 四条硬性质（都是判据，不是注释）

```text
① **它不吞失败**：传输失败 / 非法输出 / 读不到依赖 / 来源不合格**各有具名结论**，
   **绝不**退化成"她没提目标"（那是本层存在要防的最坏失败模式）
② **它不越权**：授权与合法边全部由**放行口**判；编排只**搬运**结论
③ **它不抛**：任何一步失败都变成 `GoalTurnResult` 里的一格
   （抛出去会让网关其余部分一起死，而"目标域出问题"不该拖垮整轮对话）
④ **读数不含正文**：五个 trace 读数只有操作名、具名码、计数与 id
```

### 5.2 放行口是**唯一**能产生事件的地方（`D07`）

```text
validateGoalProposal(ports, proposal) → { accepted, acceptedEvents, rejected[] }
  三个阶段：结构 → 身份与幂等 → 语义（授权 / 状态可及 / 乐观锁 / 配对取消）
  幂等：`processed_operations` 的幂等键（`(type, goalId, expectedRevision)` 一类的单元）
  ⇒ 重复投递**第二次**得 `goal_duplicate_operation`，且**零事件**
```

### 5.3 写入的两种形状

```text
增量：applyGoalRows(db, characterId, **这一批新事件**, now)
      ⚠️ 它是**增量**折叠（读现有行 → 折这批 → 写回差量）
      ⇒ 喂**全量历史**会 inflate `row.revision`（WP9-B 实测 487 vs 32）
重建：rebuildGoalProjections(db, characterId, now)
      事务内删全部 `goal:%` 行 → 全量重放 → 重插（中途崩溃 ⇒ 回滚，旧行仍在）
共享：applyAcceptedEvents（`event-store.ts`，**多领域共用**的账本追加）
```

---

## 6. 上下文与 trace

### 6.1 两条 section（`D22` / `D27` / `D29`）

| section | id | kind | priority | 可裁 | 何时挂 |
|---|---|---|---|---|---|
| **事实块** | `goal-fact` | `instruction` | `currentInput-3` = **97** | **否** | **有操作就挂**（与额度无关） |
| **状态块** | `goal-state` | `goals` | **45** | 是 | 走 `ContextBudget.goalTokens`，缺省 **0** ⇒ **根本不挂** |

```text
`D08`：至多 1 焦点 / 1 个 nextStep / 至多 **3** 项入模
`D22`：45 与外部证据的 45 平局 ⇒ 按 id 升序 ⇒ **external-evidence 先**（既有常量不动）
`D27`：`goalTokens` 缺省 0，**没有影子默认** —— "今天不注入目标"是一个真实配置
`D29`：没有操作 ⇒ 事实块产 **0 个 section**（prompt 与基线安静）
```

⚠️ 事实块**不可裁**是有意的：它是"程序对本轮做了什么"的答案，被裁掉就等于
她可以随便说。它也是 `reply-truth` 在目标域的落点。

### 6.2 五个 trace 读数（`goal_eligibility` / `proposal` / `validation` / `event` / `context`）

```text
阶段映射：前四个 → 'turn' · `goal_context` → 'context'
属性纪律：只有操作名 / 具名码 / 计数 / id —— **没有正文**（门 `T2` 把整条 trace 序列化搜正文）
失败关闭：端口抛错 ⇒ 五步**全部**记 `port_threw`（不是 `absent`）
          "读不到结论" ≠ "确实没有"
入模 id  **只来自最终 packet**（section 被预算裁掉时不得把"计划选中"标成"已入模"）
```

### 6.3 网关接线是一个**端口**（`U-20`）

```text
编译输入新增可选 `runGoalTurn?`：不传 ⇒ 不调用、不挂 section、trace 不变长
两条 section 推进 `extraProviders`（**没有改 sections.ts** ⇒ 零 prompt 组装改动）
装配层负责把编排连同四个端口接好 —— 网关不重拼那条链
```

---

## 7. 持久化与恢复

### 7.1 **零迁移**（`D15`）

```text
复用 `character_projections`，主键 (character_id, projection_type)
"一族多行"：`goal:<goalId>` —— 一族 = 一个目标（含它的承诺）
⇒ 迁移目标 = **NONE**；不动任何已发布的 DDL（0001–0009 冻结）
```

### 7.2 投影是派生的（铁律 ② 的落点）

```text
增量与重建走**同一条折叠核心**（`foldGoalRows`）⇒ "投影是缓存"是可执行的，不是信条
重建对账：重建前后**逐字段一致**（门 `S5`；注入 `N12` 把"删行后不重放"变成红的）
```

### 7.3 崩溃窗口（`D26`）

```text
两个窗口：**落盘成功但未提交兑现** / **兑现提交但未落盘**
判定器 `classifyGoalCrashWindow` 的两个窗口与它们的 `mustNot` **都是返回值**
待收敛标记经**序列化往返**仍在（门 `C3`）
⚠️ `D26`：兑现补记**不能**依赖内容去重（`duplicate_content` 会先于幂等键命中）
   ⇒ 补记必须自带**确定性事件身份**
```

---

## 8. 量具与门（18 道）

| 分组 | 门 |
|---|---|
| 契约与输入 | `m10:inputs:verify`（25）· `m10:test`（48）· `m10:source:verify`（40） |
| 语义与失效 | `m10:invalidation:verify`（37）· `m10:completion:verify`（43） |
| 上下文与观测 | `m10:context:verify`（26）· `m10:observability:verify`（19） |
| **量具自证** | `m10:measurement:verify`（**51**，覆盖 **13/16** 道门，`N1`–`N13`） |
| 端到端与规模 | `m10:e2e:verify`（19）· `m10:scale:verify`（13）· `m10:long:verify`（11） |
| **独立复核** | `m10:oracle:verify`（9，声明式转移表 vs 命令式 reducer） |
| 接线与下游 | `m10:gateway:verify`（12）· `m10:m11:verify`（11） |
| WP10 离线 | `m10:semantic:dry`（13）· `m10:review:materials`（13） |
| 文档一致性 | `m10:docs:verify`（10） |
| 探针（**有意不登记**） | `m10:baseline` · `m10:wp0:admission` |

**三条贯穿全部门的纪律**：

```text
① 正控 + 负控 + 恢复（AGENTS §6.7）：只做正控的量具与"什么都不检查"在输出上无法区分
② `measured_count > 0` 自检（§6.8）：0 检查 / 0 失败 = **MEASUREMENT INVALID**，不是 PASS
③ 门要**报**不要**崩**：每个新门首次运行自查 `x[i]!`（这条踩过三次）
```

`m10:measurement:verify` 的注入覆盖 13/16 道门（每道一处**被测面**上的具名缺陷）；
第 13 道 `m10:preflight` **没有可注入的产品面**（它读 `.env*` 键名 —— "注入缺陷"
等于改坏本机配置），正反控在门内由 `P8`/`P9` 覆盖。

---

## 9. 安全与隐私边界

```text
① 正文不进 trace / 不进开发者面的遮蔽分支（`DeveloperGoalMaskedDto` 的**类型里**没有
   `statement`，不是"记得别填"）
② 遗忘**独立于取消**（`D10`）：`explicit_forget` ⇒ `forbiddenSourceEventIds` 非空
   新的 `create` 命中即拒（复用 M9 的 B28 机制）
③ 读侧遮蔽覆盖目标**自身**的来源；不做取值级比对（`L-M10-17`，与 M9 的 `L-M9-13` 同族）
④ 撤销集有**任一具名缺口** ⇒ 引用一律不可用（**宁过遮不漏**，M9.1 `D19`）
⑤ 没有后门写入口：开发者面**只**上报可用性事实；`DEVELOPER_GOAL_FORBIDDEN_EXPORT_PATTERNS`
   是机器判据
```

### 9.1 只读面（M11 的边界）

九段只读面"在哪读"逐段写在
[`M10-M11-Read-Only-Contract.md`](M10-M11-Read-Only-Contract.md) ——
⚠️ **其中四段不在目标投影里**（依赖资格读时重算 · 变更原因分两处 ·
**目标的**完成证据只在事件 payload · cutover 在激活记录 · 是否入模在 trace）。

---

## 10. 与相邻域的边界

| 相邻域 | 本域**不做**什么 | 分工 |
|---|---|---|
| M4 Memory | 不写记忆、不查记忆 | 依赖经**只读端口**取；写入仍走 M4 |
| M9 Belief | 不改信念 | 依赖经只读端口取（投影版本 + epistemic 标签） |
| M9.5 引用复核 | 不改它的两个 fixture（它们是**可执行契约**） | M10 新建生产路径（`captureMemoryReference` / `recheckGoalDependencies`） |
| M4.5 行动 | 不执行动作、不读回执行效果 | `action_result` 只按四元组匹配（`L-M10-19`） |
| M5/M6 上下文 | 不动既有常量与预算规则 | 复用 `goals: 45`（**M3 契约预留**），只追加两条 section |
| M6.5 能力计划 | **不建设**代码执行 / GitHub / 微信 QQ 的适配器 | 计划 §19 规则 8 逐字 |
| M7/M8 状态 | 不读关系与情绪状态 | 目标域与它们**无依赖** |
| M11/Lv2 | 不产生待审修订、不做反思 | 见只读契约的八条规则 |

---

## 11. 三条跨里程碑不变量的落点

```text
① 她生成的内容永远不能自动变成外部事实
   ⇒ 目标的完成判据里 `user_report` 与**真实执行**分开（`D12`/`D13`）；
     `fulfilled` 必须有真实结果，`partial`/`timeout` **不代替**；
     不能用 assistant 自述当证据。

② 投影是派生的：删掉能从事件重放出来，结果逐字段一致
   ⇒ 增量与重建走同一条折叠核心；门 `S5`/`R` 组对账；
     注入 `N12`（删行后不重放）把它变成红的。

③ 有副作用就必须有目标确定性、有账本、有 traceId；没成功就没成功口吻
   ⇒ 唯一放行口 + `processed_operations` 幂等 + 五个 trace 读数；
     端口抛错记 `port_threw` 而不是 `absent`。
```

---

## 12. 已知架构级边界

**54 条**（`L-M10-01`…`L-M10-54`）集中在
[`M10-Known-Limitations.md`](M10-Known-Limitations.md)，每条带范围与处置。
架构上最要紧的两条：

```text
`L-M10-48`  装配层**还没有**把 `runGoalTurn` 接到 `main.ts`
            ⇒ **激活之前，生产轮次根本不会调用目标域**（WP12 的一部分）
`L-M10-09`  语料金标没有独立的第二双眼睛 ⇒ 语义指标的**分母**未验（`U-15`，需用户）
```

开放登记项 **3 条**（`U-01` / `U-11` / `U-15`）在
[`M10-Unresolved-Decisions.md`](M10-Unresolved-Decisions.md) 里跟踪 ——
本文件**不**重复登记（一件事只在一处跟踪）。
