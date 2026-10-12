# 来源溯源（Source Provenance）

**阶段**：M3
**回答的问题**：**"这句话是哪一类内容"——以及它能支持什么样的结论。**
**相关**：[ADR-008](../adr/ADR-008-source-separation.md)、
[assistant-fact-firewall.md](./assistant-fact-firewall.md)、
[conversation-integrity.md](./conversation-integrity.md)

---

## 1. 为什么需要它

计划书第 0 节把要回答的问题列成九个，前六个都是来源问题：

```text
谁说了什么？
什么时候说的？
是不是用户明确说的？
是不是苏沐薇自己说的？
是不是模型猜的？
是不是系统生成的？
```

这些问题不解决，直接进入 M4 Memory 会产生一条**自我强化**的污染链：

```text
Assistant hallucination → Memory extractor → "长期事实"
   → 未来 Context → 模型更加相信 → 再次写入
```

M3 的定位是 **Memory 之前的事实防火墙**：它不建 Memory，
只保证写进账本的东西带着**正确的来源标签**。

---

## 2. 三层标签

一个事件同时带三个（互补的）来源标签：

```ts
{
  actorType: 'user' | 'character' | 'system' | 'tool',
  sourceKind: 'user_statement' | 'character_output' | 'system_instruction' | 'tool_output',
  sourceAuthority: 'USER_EXPLICIT' | 'USER_REPLY_CONFIRMATION' | 'DIRECT_INTERACTION'
                 | 'TOOL_OBSERVATION' | 'CHARACTER_GENERATION' | 'SYSTEM_INSTRUCTION',
  epistemicSource: 'user_report' | 'character_generation' | 'system_instruction' | 'tool_observation',
}
```

它们回答三个不同的问题：

| 字段 | 回答 |
|---|---|
| `actorType` | **谁**做的这件事 |
| `sourceKind` | 这属于**哪一类内容**（事实类别，不是语义类别） |
| `sourceAuthority` | 这条内容**有资格支持什么结论** |
| `epistemicSource` | 这是**哪一类认知产物**（来源标签，不是认知状态） |

### 2.1 sourceKind 由 actorType 唯一推导

```text
user      → user_statement
character → character_output
system    → system_instruction
tool      → tool_output
```

调用方**可以**显式声明（例如 `appendUserStatement` 内部声明
`user_statement`），但声明与推导不一致时**抛错**
（`source_kind_actor_mismatch`，失败关闭）。

允许声明是为了让调用点把意图写出来，从而在 review 时一眼可见；
不允许不一致是因为"来源错误的事实"一旦写进 append-only 账本就撤不回来。

### 2.2 为什么是"事实类别"而不是"语义类别"

计划书第 27 节：

> 这是事实类别，不是语义类别。

语义分类（`fact` / `opinion` / `question`）需要理解内容，因此**必然**要调模型，
于是"分类"本身变成一个会出错、会漂移、要版本化的认知过程。

来源分类只看"这条事件从哪条路径进来的"，是确定的、可判定的、不需要模型的。

### 2.3 `source_kind` 而不是 `truth = true`

计划书第 28 节给了最有说服力的例子：

```text
用户："月球是奶酪做的。"

系统能确认的只有：
  USER_REPORTED: 用户声称月球是奶酪做的。

不能自动确认：
  WORLD_FACT: 月球是奶酪做的。
```

**因此这套结构里从头到尾没有任何 `truth` 字段。**
有的只是"这条内容从哪来"。

---

## 3. 权威等级：白名单而不是黑名单

能支持**外部事实**结论的权威等级恰好三种：

```ts
const EXTERNAL_FACT_AUTHORITIES = [
  'USER_EXPLICIT',             // 用户明确陈述
  'USER_REPLY_CONFIRMATION',   // 用户在回复确认中给出的确认
  'TOOL_OBSERVATION',          // 工具的观测结果
]
```

### 3.1 为什么是白名单

新增一种 authority 时它**默认不能**支持外部事实 ——
必须显式加进这个列表才获得这个能力。

这个方向的差别在出事故时很重要：

| | 失效模式 |
|---|---|
| 黑名单 | "新东西默认有权" → 错误数据永久进账本 |
| **白名单** | "新东西默认没权" → 功能暂时不可用 |

后者可以修，前者不能。

### 3.2 `DIRECT_INTERACTION` 刻意不在白名单里

它支持的是"**这一轮真实发生过**"这个结论（对 M7 Relationship / M8 Affect 有用），
而不是"某个关于世界的事实为真"。

把这两件事混起来，用户说一句"月球是奶酪做的"就会变成世界事实。

### 3.3 用户确认的提升由 reply graph 驱动

计划书第 33 节：

```text
苏沐薇："你好像很喜欢猫。"      ← assistant 事件，权威 = CHARACTER_GENERATION
用户：  "对，我特别喜欢。"      ← user 事件，权威 = USER_REPLY_CONFIRMATION
```

判定：

```ts
resolveAuthority({ kind: 'user_statement', repliedToKind: 'character_output' })
// → 'USER_REPLY_CONFIRMATION'
```

**关键：权威来源是第二条 User Event，而不是第一条 Assistant Event。**
她说了什么不影响事实，用户确认了什么才影响。

而且判定**完全由 reply graph 驱动，不做语义判断** ——
因此它是确定的、可测试的、不需要模型的。
代价是它依赖 reply graph 的正确性 —— 所以 M3 把 assistant 的
`replyToEventId` 变成必填，并对目标做四条校验。

---

## 4. transport metadata 不参与人格逻辑

计划书第 25 节：

> `discord_user_id` / `qq_id` / `websocket_connection_id` 属于 transport metadata，
> 而不是 Character Domain identity。

具体做法：

1. **字段改名**：M2.5 用 `metadata.source` 存渠道名（`cli` / `qq`），
   M3 改成 `metadata.transport`。
   因为 `source` 这个词已经被 `sourceKind` 占用，
   一个词两种含义是来源审计里最容易出错的地方。

2. **不明文透传**：`normalizeConversationInput` 把 transport 身份
   写进 `metadata.transportActorId` 与 `metadata.transportDisplayName`，
   而 `actor.actorId` 永远是**解析后的领域身份**。

3. **必须显式映射**：`external_identity → UserId` 是一次真实的解析
   （查 `user_identity_mappings`），不是字符串拼接。

这条的直接收益：**同一个用户换平台仍然是同一个人**，
因此 M4 可以放心地把用户事实绑在 `UserId` 上，而不是 `(userId, platform)`。

---

## 5. 完整 provenance 的七个字段

计划书第 26 节要求至少七项。它们的落点：

| 字段 | 落在哪里 |
|---|---|
| `actor_type` | 列 `actor_type` |
| `actor_id` | 列 `actor_id` |
| `event_id` | 主键 `id`（由 `(character, conversation, sequence)` 确定性推导） |
| `conversation_id` | 列 `conversation_id` |
| `timestamp` | 列 `created_at` |
| `transport` | `metadata.transport`（**不参与人格逻辑**） |
| `reply_to` | 列 `reply_to_event_id`（带四条校验 + 反向索引） |

外加 M3 新增的三列语义标签（`source_kind` / `source_authority` /
`epistemic_source`）与 `delivery_status`。

---

## 6. 未做的事（刻意留白）

| 不做 | 为什么 | 属于哪个阶段 |
|---|---|---|
| 实际 Memory Authority policy | M3 只标记，不决定"什么等级能形成什么记忆" | **M4** |
| Belief Store | 现在还没有真正的时序/关系/信念图 | M9 |
| 语义分类（这句话是事实还是观点） | 需要模型，会漂移，且 M3 不需要 | 不在计划内 |
| 来源的可信度打分 | 分数来自生成者，是循环论证 | 不在计划内 |

计划书第 130/131 节对"提前引入 MemOS / Graphiti"的否决理由与此同源：
**先保证事实来源正确（M3），再定义 Memory semantics（M4），然后才做 PoC。**

---

## 7. 不变量与守它的测试

| 不变量 | 守它的测试 |
|---|---|
| 四种 actor ↔ 四种 sourceKind 一一对应 | `kernel-tests-conversation.ts` |
| 来源声明与 actor 不一致 → 拒绝 | 同上 |
| 外部事实白名单恰为三种 | 同上（"白名单是封闭的"） |
| `DIRECT_INTERACTION` 不能支持外部事实 | 同上 |
| 用户确认由 reply graph 提升 | 同上 + `verify-m3-persistence.ts` T6 |
| 工具返回是 `tool_observation` | 同上 T8 |
| transport 身份不冒充领域身份 | `kernel-tests-conversation.ts`（归一化） |
| transport 变化不改变权威等级 | 同上 |
| 旧行来源被推导而不是留空 | 同上（`deriveSourceForLegacyRow`） |
