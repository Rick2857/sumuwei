# Observation / Intent Boundary —— 角色 Kernel 的两端

**阶段**：M3.5 WP3/WP4（计划书第 10–24 / 43 / 68 / 87–90 节）
**代码**：`src/kernel/contracts/observation.ts`、`src/kernel/contracts/intent.ts`、
`src/infrastructure/runtime/conversation-intent-resolver.ts`、`src/kernel/app/turn-gateway.ts`

---

## 1. 一张图

```text
        输入侧（Observation）                   输出侧（Intent）
        ─────────────────────                   ────────────────
              Environment                             Environment
                  │                                       ▲
                  ▼                                       │
            Observation  ──►  Character Kernel  ──►  CharacterIntent
                                  │      │
                            Identity   Context
```

Kernel 的两端各由一个抽象守着：

| 端 | 抽象 | 为什么必须有 |
|---|---|---|
| 输入 | `Observation` | 否则未来任何非对话输入只能**伪装成用户消息** |
| 输出 | `CharacterIntent` | 否则 `Runtime API` 被 `string` 锁死，且 Intent 与 Result 纠缠 |

---

## 2. 输入侧：Observation

```ts
interface Observation {
  id: ObservationId
  characterId: CharacterId        // 谁的感知
  source: EntityRef               // 这条信息从哪来
  type: ObservationType
  content: unknown
  sourceEventIds: string[]        // 刻意是 string[]：未来的 WorldEvent id 不是 ConversationEventId
  occurredAt?: Timestamp
  recordedAt: Timestamp
  metadata?: Record<string, unknown>
}
```

### 2.1 铁律：Observation ≠ 事实（计划书第 14 节）

Observation 表示的是：

```text
某种信息进入了她的感知范围
```

它**不代表**内容客观正确。某人告诉她"门外没人"，正确的 Observation 是：

```text
某人说"门外没人"          ✅
```

不是：

```text
门外真的没人              ❌
```

这是 M9 Belief 的地基。**写进类型注释**而不是只写文档，是因为它是那种
"当时看起来只是措辞、两年后变成架构灾难"的区别。

### 2.2 M3.5 只产出一种

```text
User Message → ConversationEvent → ConversationObservation → Kernel
```

`M3_5_PRODUCIBLE_OBSERVATION_TYPES = ['CONVERSATION_OBSERVATION']`（恰一种）。
其余五种（`WORLD_` / `TOOL_` / `SOCIAL_` / `SYSTEM_` / `ENVIRONMENT_`）
**只登记**，由 FC-T02 守着"M3.5 没有产出它们"。

### 2.3 Observation 的 id 是确定性的

```text
obs:<sourceEventId>
```

同一条事件永远得到同一个 Observation id。于是重放、幂等与
"这条 Observation 从哪来"三件事同时成立，而不需要"随机 id + 一张对照表"。

### 2.4 不落库（计划书第 84 节）

Observation 由 `ConversationEvent` **派生**，因此 M3.5 **不建 `observations` 表**。
`character_traces` 只记 `observation_id` / `observation_type` 两个引用。

真正需要世界观测时再决定是否持久化 —— 那时的问题（怎么存 world observation）
与今天的问题（她听到了什么）不一样，提前建表只会存下一堆语义未定的行。

### 2.5 非对话观测：能接收，但还不能渲染

计划书第 76 节的验收标准是「确认 Character API 可以接收。**但不要求模型实际处理**」。
M3.5 严格照此实现：

| 能力 | M3.5 |
|---|---|
| 构造一个 `ENVIRONMENT_OBSERVATION` | ✅ |
| `characterTurnContextOf` 接收它 | ✅ |
| 它被渲染成"对方刚刚说：…" | ❌ **失败关闭**（`observation_not_renderable_as_input`） |
| 它被渲染进 prompt（需要新的 section 种类） | ❌ 属于后续阶段（第 43 节明确 M3.5 不增加 section） |

"渲染它"看起来只是少做了一步，但**正是这一步不做**，
才保证了今天不可能存在"世界事件伪装成用户消息"的 prompt 路径。

---

## 3. 输出侧：CharacterIntent

```ts
interface CharacterIntent {
  id: IntentId
  characterId: CharacterId
  type: CharacterIntentType        // M3.5 只产出 SPEECH
  sourceObservationIds: ObservationId[]   // "她为什么要做这件事"
  payload: unknown                 // SPEECH → SpeechIntentPayload { text, target? }
  createdAt: Timestamp
}

interface CharacterOutput { intents: CharacterIntent[] }   // M3.5 恒为恰好一条
```

### 3.1 `CharacterOutput` 存在的唯一理由

**以后不要改返回结构。**

如果今天 Kernel 对外仍只返回 `string`，那么未来第一个非语言行为出现时，
Runtime API 必须从 `Promise<string>` 变成 `Promise<Something>` ——
那是一个破坏性变更，会牵动装配层、评测装置、trace 与全部调用点。

今天多一层 `{ intents: [...] }`，成本是一个对象；收益是那个变更永远不必发生。

由 `assertM3_5OutputInvariant` 在运行期守住"恰好一条且必须是 SPEECH"。

### 3.2 `target` 是 EntityRef 而不是 UserId

```ts
interface SpeechIntentPayload { text: string; target?: EntityRef }
```

今天 `target` 恒为用户；但"对谁说"在类型上就应该是"对某个实体说" ——
否则未来对角色 B 说话时必须改这个接口，而接口一改，
所有产出 SpeechIntent 的地方都要动。

而且 `target` 是**载荷**的：`ConversationIntentResolver` 会校验
`{ kind:'user', id }` 与本轮会话的用户一致，不一致就 `rejected`
（`speech_target_mismatch`）。把话发给错误的人在多角色世界里是最严重的错误之一。

---

## 4. Intent ≠ Result（计划书第 20 / 21 / 23 节）

```ts
interface IntentResolver { resolve(intent): Promise<IntentResolution> }

interface IntentResolution {
  intentId: IntentId
  status: 'accepted' | 'rejected' | 'failed'
  resultRefs?: string[]
  reason?: string
  resolvedAt: Timestamp
}
```

### 4.1 两种"没成功"必须分开

| 状态 | 含义 | 正确处理 |
|---|---|---|
| `rejected` | 环境**明确拒绝**（门锁着） | 正常结果 → 应当变成 Observation 回到她那里 |
| `failed` | 处理过程失败（IO / 网络） | 运维问题 → 不该被写成"世界规律" |

把两者混成"没成功"，会让她把基础设施故障当成世界规律写进 M9 的 Belief。

### 4.2 Fast Path 落库失败仍然抛出（M3 行为保留）

`ConversationIntentResolver` 有一条刻意的不对称：

```text
落库失败（reply 目标悬空 / 序号跳号 / DB 报错）  → 抛出
路由不到处理器（非 SPEECH intent）              → rejected
```

理由："用户收到了回复但她的话没进账本"意味着事实账本与用户实际经历分叉，
而账本是 append-only 的，事后再补也补不回"当时"那个顺序。

### 4.3 端口最小，实现可以更多

端口签名是 `resolve(intent)`（计划书第 21 节），**没有**写入上下文参数 ——
因为未来的 Environment Resolver 完全不需要知道我们的会话序号。

而 Trace 需要 `outputEventId`，因此实现多暴露一个
`resolveWithEvent(intent) → { resolution, event? }`。
装配处（`TurnGateway`）按"拿得到就拿、拿不到就只记 resolution"处理。

写入上下文（哪个会话、第几号、回复谁）在**构造时**绑定：一轮一个 Resolver 实例。

---

## 5. 上下文单入口仍然是单入口

M3.5 让 `ContextCompiler` 的输入从"一个 message 字符串"升级为
`CharacterTurnContext`：

```ts
interface CharacterTurnContext {
  characterId: CharacterId
  observation?: Observation
  conversationId?: ConversationId
  currentInput?: string        // 由 observation 派生（有对话观测时）
}
```

`characterTurnContextOf` 是**唯一**入口，四条规则：

1. 没有 observation → 必须给 `currentInput`（合成轮次，与 M3 一致）
2. 对话观测 → 文本由 `deriveCurrentInput` 派生；显式传入必须一致，
   否则 `observation_input_mismatch`（失败关闭）
3. 非对话观测 → 不接受显式文本（`observation_not_renderable_as_input`）
4. 都没有 → `turn_without_input`

**关键点是"派生而不是并列"**：`currentInput` 由 Observation 算出来，
因此"她看到的输入"与"账本里的输入"在结构上不可能分叉。

---

## 6. Trace：把"感知"与"意图"变成可查的事实（计划书第 89 / 90 节）

```text
character.run
├── message_normalize
├── actor_resolve
├── conversation_persist_input
├── observation_adapt            ← M3.5：她感知到什么、从哪来
├── identity_load
├── context_compile
├── model_generate
├── output_validate
├── intent_create                ← M3.5：她想做什么
├── intent_resolve               ← M3.5：那件事变成了什么
├── conversation_persist_output
└── （turn_summary）
```

`character_traces` 增四个 nullable 列：`observation_id` / `observation_type` /
`intent_id` / `intent_type`（**只存引用，不存内容** —— 与 M2.5 的隐私原则一致）。

`intent_create` 与 `intent_resolve` 分成两步的唯一理由：它俩真的是两件事。
合成一步之后，"她说了话但没落进账本"与"她压根没想说话"在 trace 上无法区分。

---

## 7. 与 M3 的兼容性

M3.5 的硬件约束是**用户体验完全不变**（计划书第 18 / 92 节）：

- `main.ts` 的对话路径与输出**一行没改**
- prompt **逐字节不变** —— 由 `evals/fixtures/m3.5/prompt-baseline.txt` +
  `m3.5:test` FC-T08 守着
- 人格逻辑（Seed / Source Firewall / IdentityProvider / Conversation Integrity）**未触碰**
- M3 的全部测试通过（仅 1 条断言从 `=== 3` 放宽为 `>= 3`，理由见
  [`../milestones/M3.5-verification.md`](../milestones/M3.5-verification.md)）
