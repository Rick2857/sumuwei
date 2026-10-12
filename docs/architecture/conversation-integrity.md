# 对话完整性（Conversation Integrity）

**阶段**：M3
**回答的问题**：**"谁说了什么、什么时候说的、属于哪个会话"能不能被相信。**
**相关**：[source-provenance.md](./source-provenance.md)、
[ADR-008](../adr/ADR-008-source-separation.md)

---

## 1. 一句话

事实账本的价值取决于**写进去的东西是对的**。
对话完整性就是把"对"这件事从"靠自觉"变成"结构上写不出错的"。

计划书第 79 节的原话：

> 不允许业务代码直接 insert ConversationEvent。否则未来会出现：
> 某个模块忘记 sequence / 某个模块 actorType 写错 / 某个模块没写 provenance。

---

## 2. 写入路径只有一个形状

```text
transport（CLI / HTTP / QQ / …）
      │  RawConversationInput（宽进）
      ▼
MessageNormalizer（纯逻辑 + 注入的身份解析）
      │  NormalizedConversationInput（严出）
      ▼
ActorResolver（transport 身份 → UserId）
      ▼
ConversationIntegrityService（四条规则，失败关闭）
      ▼
ConversationLedgerPort（四个具名方法）
      ▼
conversation_events（append-only）
```

### 2.1 为什么归一化是纯函数

计划书第 23 节：

> 不要让 Discord Message / QQ Message / Web Message / Internal Runtime Message
> 直接进入 Character Kernel。

归一化器只做三件事，而且**只做**这三件：

1. 把各种形状收敛成 `NormalizedConversationInput`
2. 把 transport 身份与领域身份分开（**不自己解析**，通过注入的
   `IdentityResolving` 钩子）
3. 缺什么就明确报错，不猜

### 2.2 为什么端口没有通用 `append`

`ConversationLedgerPort` 只有四个方法：

```ts
appendUserStatement(input)      // 用户说了话
appendCharacterOutput(input)    // 她说了话
appendSystemEvent(input)        // 系统通知
appendToolEvent(input)          // 工具返回
```

**没有** `append(event)` 这种万能入口，因此：

| 想写错的东西 | 为什么写不出来 |
|---|---|
| `actorType` | 由你调用的**方法**决定 |
| `sourceKind` | 由 actorType 推导，声明不一致时抛错 |
| `sequence` | 由持久层原子分配，参数里没有这个字段 |

"来源写错"这件事从"靠自觉"变成"类型层面写不出来"。

---

## 3. 四条完整性规则

### 规则 1：会话内序号必须连续 +1

```text
incoming <= currentMax        → duplicate（幂等命中，**不是错误**）
incoming >  currentMax + 1    → reject: conversation_sequence_gap
otherwise                     → accept
```

**为什么不允许跳号**：会话内序号是**可读的账**
（"这个会话说到第几句"），跳号会让它失去这个用途。

**对比：角色级序号允许有空洞。** 它是坐标不是计数器 ——
一次交互预分配两个序号，模型失败时第二个就空着，这是正常的。

**为什么幂等优先**：重试是正常现象（网络抖动、进程重启），
而"重试导致报错"会让上层要么吞异常、要么重写逻辑。

### 规则 2：事件坐标必须与调用方期望一致

```text
事件里的 (characterId, conversationId)  ==  调用方声明的期望值？
```

这条检查容易被写成"两处都取自同一个变量"从而永远通过 ——
那样它就只是装饰。因此签名里 `characterId` 与 `expectedCharacterId`
是**两个独立的入参**。

### 规则 3：actor 与事件类型必须匹配

| 事件类型 | 必须的 actorType |
|---|---|
| `user_message` | `user` |
| `assistant_message` | `character` |
| `system_event` | `system` |
| `tool_event` | `tool` |

这条规则在**两处**实现（`createConversationEvent` 的构造期检查 +
`validateActorConsistency` 的写入前检查），这是**故意的**：
它们检查同一件事，但不共享失败方式。
构造期那道是"任何路径都绕不过的最后一道"，写入前那道给出**稳定错误码**。

### 规则 4：reply graph 必须可解析

计划书第 34 节：

> 对于用户："对。" —— 没有 Reply Graph 很难理解："对什么？"

四条子规则：

| 情形 | 错误码 |
|---|---|
| `assistant_message` 没有 `replyToEventId` | `reply_target_required` |
| 目标不存在 | `reply_target_missing` |
| 目标属于别的角色 | `reply_target_foreign_character` |
| 目标属于别的会话 | `reply_target_other_conversation` |
| 目标不比本事件更早 | `reply_target_not_earlier` |

**为什么 assistant 的 reply 是必填**：她说的每一句话都在回应什么 ——
这不是可选的元数据，而是"这句话是什么意思"的必要信息。

**为什么悬空引用是硬错误**：reply graph 的悬空引用是**永久性**的
（append-only 撤不回来）。一条指向不存在事件的回复，
会让未来任何"这句话在回应什么"的推理都得到错误答案，
而且**没人知道它是错的**。

---

## 4. 生命周期：先落 Event，再调模型

计划书第 35 节：

```text
receive → normalize → resolve actor → allocate sequence
        → persist event → acknowledge persistence → run agent
```

> 推荐：**先落 Event，再调用模型。** 避免模型成功回复但输入没有保存。

计划书第 36 节（她的输出）：

```text
model output → validate output → associate trace → allocate sequence
             → persist assistant event → send to transport
```

> 理想情况：**先确保内部记录，再对外发送。**

两条顺序都是硬要求，理由相同：**账本是真实历史，模型调用是会失败的网络操作。**
反过来的话，一次失败的模型调用会留下一段"用户说了话但我们没记住"的历史空洞。

### 4.1 生成 ≠ 送达（计划书第 37 节）

模型成功生成 `Hello` 但网络发送失败时，对话历史必须能表达
`generated=true delivered=false`。

因此 `deliveryStatus` 的**默认值是 `generated`**，不是 `delivered` ——
写进账本**不等于**送到用户手里。

这是 `conversation_events` 上**唯一**允许 UPDATE 的一列，
且只改这一列：正文、来源、序号、时间都不在那个 SQL 里出现。
内容的 append-only 语义不受影响。

---

## 5. 会话语义：切换不等于新建角色

计划书第 38/39 节：

| 事件 | CharacterId | UserId | ConversationId |
|---|---|---|---|
| 重启 Runtime | 不变 | 不变 | 不变 |
| 新建会话 | 不变 | 不变 | **变** |
| 换渠道（cli → qq） | 不变 | 不变 | 可变 |

以及第 39 节的一条重要约束：

> M3 不应为了模拟 Memory：把所有历史都塞进新 Session。

因此新会话的 `recent-conversation` section **从空开始**。
跨会话的连续性是 M4 Memory 的事 ——
用"把旧历史全塞进新会话"来假装记得，会制造出假的记忆。

---

## 6. 数据落点

迁移 0003 给 `conversation_events` 加了五列（**不是**放进 `metadata`）：

```sql
source_kind            text
source_authority       text
epistemic_source       text
delivery_status        text
event_schema_version   integer not null default 1
```

加上两个索引：

```sql
(character_id, source_kind, sequence)   -- "她说过哪些话" / "工具返回过什么"
(reply_to_event_id)                     -- "这句话被谁回复过"
```

### 6.1 旧行怎么办

迁移 0003 之前的行（本项目真实库里有 4 条）这些列是 `null`。
读取时**推导**而不是留空（`deriveSourceForLegacyRow`），
推导规则与 `createConversationEvent` 完全一致。

理由：账本里**不允许存在来源未知的事件**。
一条来源为 `null` 的事实，对 M4 的 Memory 来说比一条"来源正确推导"的事实
危险得多 —— 前者会被当成"可能是什么都行"，后者至少与写入路径同源。

---

## 7. 不变量与守它的测试

| 不变量 | 守它的测试 |
|---|---|
| type 与 actorType 必须匹配 | `kernel-tests-conversation.ts`、`kernel:test` |
| 会话内序号连续、无跳号 | `kernel-tests-conversation.ts` |
| 重复写是幂等命中而不是错误 | `verify-m3-persistence.ts` §4 |
| reply graph 可解析（四条子规则） | `kernel-tests-conversation.ts` |
| 事件不得跨角色 / 跨会话漂移 | 同上 |
| 同用户两会话：角色与用户不变、会话变 | `verify-m3-persistence.ts` §5（T2） |
| 投递状态可更新但正文不变 | 同上 §4 |
| 归一化不做身份猜测 | `kernel-tests-conversation.ts` |
| 事件无损、序号正确 | `eval:scenarios` SC-003 / SC-004 |
