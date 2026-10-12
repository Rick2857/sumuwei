# ADR-034：Execution Ledger 与 Memory 是两本账

- **状态**：已接受（M4.5）
- **日期**：2026-09-17
- **相关**：M4.5 计划书 §18 / §19 / §22 / §23 / §44；INV-M45-05
- **代码**：`src/kernel/action/execution-ledger.ts`、
  `src/infrastructure/action/action-ledger-store.ts`、migration 0006

---

## 背景

M4 建立了 Memory：她**知道什么**。

M4.5 第一次建立 Execution：她**做过什么**。

两者最容易被合并的地方是一句话：

```text
"她刚才写了一个文件" → 顺手记成一条记忆
```

这个合并看起来方便，实际会同时污染两边：

| 污染 | 后果 |
|---|---|
| 执行事实进记忆 | 一次 `data/action-sandbox` 下的临时写操作会进入长期人格记忆 |
| 记忆被当成执行证据 | "记忆里写着 X" 会被读成"外部世界现在是 X"（违反 §23） |

计划书 §22 因此定了一条硬边界：

```text
Action Result ≠ Memory
Action Result → Memory Candidate → Memory Policy → Memory Write
```

---

## 决策

**执行事实进 Execution Ledger（独立的一本账），不进 Memory。
只有显式经过记忆候选与记忆策略的东西才可能成为记忆 —— 而 M4.5 不做这条转换。**

### 1. 账本是 append-only 的事件流，不是可变行

```text
character_action_events(action_id, trace_id, character_id, sequence, type, payload, ...)
```

事件类型（§44）：

```text
ACTION_REQUESTED / ACTION_TARGET_RESOLVED / ACTION_AUTHORIZED / ACTION_REJECTED
ACTION_STARTED / ACTION_SUCCEEDED / ACTION_FAILED / ACTION_PARTIAL / ACTION_CANCELLED
```

`ExecutionRecord`（§19）是这些事件的**折叠结果**，不是数据库里的一行。
做法与 Memory 完全一致（事件 + 纯 fold + 可重放），因此：

- 没有 UPDATE / DELETE —— 端口上根本没有这两个方法
- 折叠是纯函数，可以离线对同一事件流重放两次比对
- "为什么她做了这件事"可以沿 `trace_id` 一次查全

### 2. 具名写入，杜绝"万能 append"

`ExecutionLedgerPort` 只有具名方法
（`recordRequested` / `recordAuthorized` / `recordSucceeded` / …），
没有 `append(event)`。这与 `ConversationLedgerPort` 是同一条理由：

> 一个万能入口会让"某个模块忘了写 traceId / status 写错"变成可能。

### 3. traceId 贯穿，且可反查

从用户轮次到最终回复，`traceId` 一路带着：

```text
User turn → ActionRequest → Policy → Execution → ActionResult → Ledger → Response
```

`character_traces.action_ids` 让"这一轮她做了什么"从 trace 一条记录
就能读到；反向从 ledger 的 `trace_id` 索引能查到全部动作。
两条路都能走通，因此 §20 的"完整反查"是可验证的。

### 4. 与 Memory 的物理隔离是刻意的

- **不同的表**：`character_action_events` vs `memory_records / memory_events`
- **不同的端口**：`ExecutionLedgerPort` vs `MemoryStorePort`
- **不同的口径**：动作按"发生"记；记忆按"她知道"记
- **不共享幂等键空间**：动作的幂等键活在动作账本里（见 ADR-030 方案 C）

### 5. Memory 侧一个字都不改

M4/M4.1 的 Memory Kernel（store / validator / reducer / 显式路径）
在 M4.5 中**不被修改**。执行结果**不会**自动变成记忆候选，
`CHARACTER_MEMORY_BACKGROUND_ENABLED` 仍然 NOT-WIRED。

未来若要记住"我曾为用户创建某文件"，那是**另一个 milestone**，
并且必须显式走 `Action Result → Memory Candidate → Memory Policy → Memory Write`。

---

## 被否决的备选方案

### 方案 A：动作直接写 Memory 领域事件

**否决理由**：见背景。它会让沙箱里的每一次实验性写操作都变成
永久人格记忆，且不可回撤（记忆写入的设计是不可回溯修正的）。

### 方案 B：ExecutionRecord 存成一张可变表（每阶段 UPDATE）

**否决理由**：那就没有"证据链"，只有"最后状态"。§32 要求
"每个 executed Action 必须有 ActionResult"、"每个 success claim
必须能追到成功 ActionResult" —— 这些断言需要一个可折叠的事件流。

### 方案 C：复用 `conversation_events`（appendToolEvent）

**否决理由**：对话账本是**她与用户之间**的事实。动作是**她对世界**的事实。
混进去之后 `--history` 会开始显示工具调用，而记忆的证据反查会被
工具行污染（M4 对"证据必须指向真实对话"有明确要求）。

---

## 后果

### 正面

- "她做过什么"与"她知道什么"可以分别审计、分别清理、分别做保留策略。
- 折叠 + 重放让账本可以自证：`action:replay` 类断言（同事件流 → 同记录）。
- 未来加任何能力都不需要碰 Memory。

### 代价

- 多一张表、多一个端口、多一套折叠。
- "她记得自己做过这件事"不会自动发生 —— 这是**刻意的**，不是缺陷。

---

## 怎么验证这条决策还成立

| 检查 | 由谁守 |
|---|---|
| 执行 10 次动作后 memory 计数不变 | `m4.5:verify`「Action 不写 Memory」 |
| 端口无 update/delete（类型层面） | 代码评审 + `m4.5:test` 静态扫描 |
| 同事件流折叠两次结果相同 | `m4.5:test`「fold 确定性」 |
| 每个 executed 动作有 ActionResult、有 traceId | `m4.5:audit`（`checkActionAuditInvariants`） |
| `action:trace <traceId>` 能串起完整链 | L2 + L4 S8 |
