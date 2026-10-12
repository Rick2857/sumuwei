# ADR-015：CharacterIntent 是 Character Kernel 的输出边界

- **状态**：已接受（M3.5）
- **日期**：2026-09-17
- **相关**：计划书第 15 – 19 / 22 / 69 / 70 / 77 / 85 节
- **代码**：`src/kernel/contracts/intent.ts`、
  `src/infrastructure/runtime/conversation-intent-resolver.ts`

---

## 背景

M3 的 Kernel 最终输出是一个字符串（`Assistant Response`）。

计划书第 70 节指出了它的代价：

> 即使底层模型仍返回 `string`，Character Domain 对外最好返回 `CharacterOutput`。
> 避免以后 Runtime API 直接被 `string` 锁死。

具体地说，如果 Kernel 对外一直是 `Promise<string>`，那么未来第一个非语言行为
（"她走过去把窗关上"）出现时，Runtime API 必须变成 `Promise<Something>` ——
那是一个**破坏性**变更，会牵动装配层、评测装置、trace 与全部调用点。

---

## 决策

**引入 `CharacterIntent` / `CharacterOutput` 作为输出边界；
M3.5 仍然只产出 `SPEECH`，行为与 M3 完全一致。**

### 1. 形状

```ts
interface CharacterIntent {
  id: IntentId
  characterId: CharacterId
  type: CharacterIntentType                  // M3.5 只产出 SPEECH
  sourceObservationIds: ObservationId[]      // "她为什么要做这件事"（可为空 = 合成轮次）
  payload: unknown                           // SPEECH → { text, target? }
  createdAt: Timestamp
}

interface CharacterOutput { intents: CharacterIntent[] }   // M3.5 恒为恰好一条
```

### 2. `CharacterOutput` 的包装不是为了现在，而是为了以后

今天多一层 `{ intents: [...] }`，成本是一个对象；收益是返回结构**永远不必改**。

由 `assertM3_5OutputInvariant` 在**运行期**守住"恰好一条且必须是 SPEECH" ——
把"这个阶段不做"变成跑得起来的断言，而不是文档里的一句承诺。

### 3. `target` 是 `EntityRef` 而不是 `UserId`

```ts
interface SpeechIntentPayload { text: string; target?: EntityRef }
```

今天 `target` 恒为用户；但"对谁说"在类型上就该是"对某个实体说"，
否则未来对角色 B 说话时**必须改这个接口**，而接口一改，
所有产出 SpeechIntent 的地方都要动。

`target` 不是装饰字段：`ConversationIntentResolver` 会校验
`{ kind:'user', id }` 与本轮会话的用户一致，不一致就 `rejected`
（`speech_target_mismatch`）。在多角色世界里，把话发给错误的人是最严重的错误之一
（它会把 A 的对话写进 B 的历史）。

### 4. 类型登记与"可产出"分开

```text
登记：SPEECH / ACTION / MOVEMENT / INTERACTION / TOOL_USE / WAIT
可产出：SPEECH（恰一种）
```

与 Observation 同一个模式。**构造器允许造出非 SPEECH 的 intent**，
因为"能造出来"是写 FC-T04 那条测试（证明 Intent 不会自动改世界）的前提。

### 5. 落库路径：唯一的 Resolver 是"对话"

```text
SpeechIntent → ConversationIntentResolver → 一条 assistant 事件
```

不建 `character_intents` 表（计划书第 85 节）：SpeechIntent 最终形成 assistant 事件，
trace 里只记 `intent_id` / `intent_type` 两个引用。

Resolver 的写入上下文（会话 / 序号 / 回复谁）在**构造时**绑定 —— 一轮一个实例，
因为端口签名 `resolve(intent)` 没有额外参数（计划书第 21 节），
而未来的 Environment Resolver 完全不需要知道我们的会话序号。

---

## 被否决的备选方案

### 方案 A：不引入 Intent，直接把 `replyText` 落库（保持 M3 原样）

**否决理由**：这是"最省事"的方案，但它把两个不该耦合的东西焊在一起：
"她想说什么"与"这句话变成了一条事件"。而这个耦合点正是未来
FC-03（Intent ≠ Result）要拆开的地方 —— 拆的时候会牵动整条 Fast Path。

### 方案 B：让 Resolver 直接返回事件对象

**否决理由**：`IntentResolution` 应当只持有**引用**（`resultRefs`），
而不是结果本身。未来的 Environment Resolver 会返回世界对象引用，
"结果永远是去别处查的，而不是这里的一份快照"这条要现在就立起来。

实现上通过 `resolveWithEvent`（实现比端口多暴露一点）满足 Trace 对
`outputEventId` 的需求 —— 端口保持最小。

### 方案 C：`characterSequence` 可选，缺省用 `conversationSequence`

**否决理由**：角色级序号是持久层**原子分配**的资源，绝不能被 Resolver 猜。
缺省值会在某个没人注意的路径上悄悄发射一个序号，
而序号空洞是最难事后解释的数据形态。

最终做成**必填**，并且只在"真的可能落库"的分支构造 Resolver。

### 方案 D：干脆现在就实现 ActionIntent 的运行链路

**否决理由**：计划书第 3 / 17 / 21 节明确禁止。
`ACTION` 在枚举里登记，但没有任何 Resolver 处理它 ——
FC-T04 用 mock 环境证明"被拒绝的 ActionIntent 不改变任何世界状态"。

---

## 后果

### 正面

- 输出结构可扩展，未来的非语言行为不需要改 Runtime API。
- `Intent` 与 `Result` 在类型上分开，`rejected` 与 `failed` 的语义差异被保留。
- trace 能回答"她想做什么、那件事变成了什么"。

### 代价

- Fast Path 多了一层对象构造（一次 `createSpeechIntent` + 一次 Resolver 构造）。
- `OutgoingTurn` 增加了两个字段。缓解：纯加性，既有 3 个调用点不受影响。

---

## 怎么验证这条决策还成立

| 检查 | 由谁守 |
|---|---|
| 普通聊天的输出是 `CharacterOutput └─ SpeechIntent` | `m3.5:test` FC-T03 |
| `SpeechIntent` 经 Resolver 变成一条 assistant 事件 | FC-T03 + `m3.5:verify` §6 |
| 输出不变量拦住非 SPEECH / 多条 intent | FC-T03 |
| M3.5 只产出 SPEECH | FC-T03（`M3_5_PRODUCIBLE_INTENT_TYPES`） |
| 行为与 M3 一致（prompt 逐字节不变） | FC-T08 |
| 不建 `character_intents` 表 | FC-T04 符号守卫 |
| 端到端落库 | `m3.5:verify` §6 |
