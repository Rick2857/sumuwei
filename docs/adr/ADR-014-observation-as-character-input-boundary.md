# ADR-014：Observation 是 Character Kernel 的输入边界

- **状态**：已接受（M3.5）
- **日期**：2026-09-17
- **相关**：计划书第 10 – 14 / 49 / 68 / 76 / 84 节
- **代码**：`src/kernel/contracts/observation.ts`、`src/kernel/app/turn-gateway.ts`

---

## 背景

M3 结束时 Character Kernel 的输入是"用户消息"。今天完全够用，
因为它确实是唯一一种输入。但计划书第 13 节指出它会变成危险的技术债：

> 否则 Character Kernel 永远是 `generateReply(userMessage)`，
> 未来世界事件进入时只能**伪装成用户消息**。

如果让未来的世界事件伪装成 `user_message`，会一次性破坏三件事：

1. **事实账本** —— 来源类别（`sourceKind`）、权威等级（`sourceAuthority`）、
   reply graph 全部跟着错，而账本是 **append-only**，改不回来
2. **人格评测** —— 她"回应了用户"，但根本没有用户说话
3. **可解释性** —— 事后无法区分"用户真的说了这句话"与"系统替用户说了"

---

## 决策

**引入 `Observation` 作为 Kernel 的输入边界；M3.5 只产出其中一种。**

### 1. 形状（计划书第 10 节）

```ts
interface Observation {
  id: ObservationId
  characterId: CharacterId      // 谁的感知
  source: EntityRef             // 这条信息从哪来
  type: ObservationType
  content: unknown              // 刻意不透明：未来世界的 payload 今天不可能知道
  sourceEventIds: string[]      // 刻意 string[]：WorldEvent id 不是 ConversationEventId
  occurredAt?: Timestamp
  recordedAt: Timestamp
  metadata?: Record<string, unknown>
}
```

`sourceEventIds` 是 `string[]` 而**不是** `ConversationEventId[]`：
后者会让未来的世界事件**被迫**登记成对话事件 —— 又一个伪装通道。

### 2. 只有一种真正产出

```text
User Message → ConversationEvent → ConversationObservation → Kernel
```

`M3_5_PRODUCIBLE_OBSERVATION_TYPES = ['CONVERSATION_OBSERVATION']`（恰一种）。
其余五种（`WORLD_` / `TOOL_` / `SOCIAL_` / `SYSTEM_` / `ENVIRONMENT_`）
只登记在受控枚举里（计划书第 12 节）。

### 3. `Observation ≠ 事实`（计划书第 14 节）

某人告诉她"门外没人"，正确的记录是：

```text
某人说"门外没人"      ✅
门外真的没人          ❌
```

这条**写进类型注释，而不只是文档** —— 它是 M9 Belief 的地基。

### 4. Observation 的 id 由来源事件确定性派生

```text
obs:<sourceEventId>
```

同一条事件永远得到同一个 Observation id，因此重放、幂等与
"这条 Observation 从哪来"三件事同时成立，而不需要"随机 id + 对照表"。

### 5. 不落库（计划书第 84 节）

Observation 由事件**派生**，M3.5 **不建 `observations` 表**。
`character_traces` 只记 `observation_id` / `observation_type` 两个引用。

### 6. 非对话观测：能被接收，但不能被渲染（计划书第 76 节的严格执行）

| 能力 | M3.5 |
|---|---|
| 构造 `ENVIRONMENT_OBSERVATION` | ✅ |
| `characterTurnContextOf` 接收它 | ✅ |
| 渲染成"对方刚刚说：…" | ❌ **失败关闭**（`observation_not_renderable_as_input`） |
| 渲染进 prompt（需要新 section 种类） | ❌ 后续阶段（第 43 节明确 M3.5 不加 section） |

"渲染它"看起来只是少做一步，但**正是这一步不做**，
才保证了今天不可能存在"世界事件伪装成用户消息"的 prompt 路径。

---

## 被否决的备选方案

### 方案 A：把 Observation 的类型做成开放 `string`

**否决理由**：与 M3 的 `DomainEventType` 处理方式不一致。
`DomainEventRegistry` 的存在理由正是"某个模块手滑写出一个新类型、
悄悄改变了系统语义"。Kernel 的**输入**语义比领域事件类型更不该被悄悄改。

因此采用同一模式：已知值全部登记 + 一张"现在允许产出哪些"的表。

### 方案 B：按对话事件种类拆成多种 Observation

（`USER_OBSERVATION` / `CHARACTER_OBSERVATION` / `SYSTEM_OBSERVATION`）

**否决理由**："用户说的"与"她自己说的"是同一类**感知方式**（都是对话），
区别在 `source.kind` 与 `content.sourceKind`。
拆成两种会让"对话"这个概念在没人注意的时候裂成两半，
而未来任何"我要处理所有对话观测"的代码都要同时改两处。

### 方案 C：为测试在生产枚举里加一个 `ENVIRONMENT_TEST`

计划书第 76 节的例子用了这个字面量。

**否决理由**：往受控登记表里塞一个只为测试存在的假值，
会让"已登记的类型"这份清单失去意义。
FC-T02 改用已登记的 `ENVIRONMENT_OBSERVATION`（它本来就是为这类输入准备的），
测试标签放 `metadata.testTag` —— **意图完全一致，污染为零**。

### 方案 D：干跑路径也造一个"合成观测"

**否决理由**：干跑不写事件，因此账本里没有"发生过的对话"可供观测。
那时造一个 `sourceEventIds: []` 的观测，等于为了一次测试弄出一个
**没有来源的感知** —— 而"凭空的来源"正是这一层要阻止的事。
下游对 `observation === undefined` 有明确处理（intent 的来源为空）。

---

## 后果

### 正面

- 未来世界事件有正规入口，不必伪装。
- `character_traces` 能回答"她这一轮感知到了什么、从哪来"。
- 不新增表、不新增服务、不新增依赖。

### 代价

- Observation 每轮都要构造一次（成本是一个纯函数调用 + 一次 id 拼接）。
- 出现了"能被接收但不能被渲染"的中间状态。缓解：这个状态有明确的错误码
  （`observation_render_not_supported`），而不是静默失败。

---

## 怎么验证这条决策还成立

| 检查 | 由谁守 |
|---|---|
| 非对话观测可被 API 接收 | `m3.5:test` FC-T02 |
| 非对话观测不能被渲染成用户文本 | FC-T02（`observation_not_renderable_as_input`） |
| 观测由事件确定性派生 | FC-T02 |
| 未登记的观测类型被拒绝 | FC-T02 |
| Observation 不落库（无 `observations` 表） | FC-T04 符号守卫 |
| 端到端一轮真实对话走新链路 | `m3.5:verify` §6 |
| prompt 逐字节不变 | FC-T08 |
