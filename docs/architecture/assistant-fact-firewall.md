# Assistant Fact Firewall

**阶段**：M3
**回答的问题**：**"她自己生成的经历"会不会变成"她真实的过去"。**
**相关**：[ADR-009](../adr/ADR-009-assistant-output-is-not-fact.md)、
[source-provenance.md](./source-provenance.md)

---

## 1. 被拦下的到底是什么

用户：**你小时候喜欢什么？**

苏沐薇（模型生成）：**我小时候很喜欢下雨。**

如果没有防火墙：

```text
Ledger: assistant_message "我小时候很喜欢下雨。"
        ↓
M4 Memory Extractor 看到一条"关于苏沐薇过去"的陈述
        ↓
CharacterHistoricalFact: 苏沐薇小时候喜欢下雨
        ↓
下一轮进 Context
        ↓
模型看到"我小时候喜欢下雨"，于是继续引用它
        ↓
她开始有一个自己编出来的人生，而系统每一句都当成真的
```

计划书第 31 节的原文正是这个例子，并给出了期望行为：

> Ledger 应保存 `AssistantEvent content="我小时候很喜欢下雨。"`
> 但是**不能**生成 `CharacterHistoricalFact: 苏沐薇小时候喜欢下雨`。
> 因为没有真实历史 Evidence。

---

## 2. 三种处理方式，只有一种是对的

| 做法 | 结果 |
|---|---|
| 不记她的话 | 丢掉真实发生过的事实；而且 reply graph 会断（用户无法确认她说过的话） |
| 记下来，但当作事实 | 上面那条污染链 |
| **记下来，标清来源** | ✅ 她的话是一个可查的事实（"她说过这句"），但不是关于世界的事实 |

M3 选第三种，而且把它做成**类型与纯函数层面的事实**，而不是约定。

---

## 3. 实现：三个层次

### 3.1 事件层（落库时就有正确标签）

```ts
sourceKind      = 'character_output'
sourceAuthority = 'CHARACTER_GENERATION'
epistemicSource = 'character_generation'
```

这三个值由 `actorType === 'character'` **唯一推导**，
调用方声明不一致时抛错。因此"她的话被写成用户的话"在结构上不可能。

### 3.2 判定层（一个纯函数）

```ts
canSupportExternalFact('CHARACTER_GENERATION')  // → false
```

这是 M3 最关键的一条纯函数。它的调用点**必须**是所有
"把对话内容提升为某种长期知识"的地方 —— M4 的 Memory Extractor 会是第一个。

它住在契约层、由 `kernel-tests-conversation.ts` 直接守住，
因此它是**可证明的 0**，而不是"跑了一百次没看到"。

涉及的三条：

```ts
canEvidenceExternalFact(event)   // 这个事件能否充当外部事实证据
isSelfExpressionOnly(event)      // 她自己的话只构成自我表达
isDirectInteraction(event)       // 这一轮真实发生过（Relationship/Affect 用）
```

### 3.3 上下文层（提示词规则）

`integrity-rules` section（不可裁剪）里有一条：

```text
- 不要声称拥有没有发生过的真实经历。
```

它是**第二道**保险：即使某个未来模块忘了检查来源，
提示词里也明确禁止这种行为。但它的地位是"补充"而不是"依赖" ——
提示词可以被绕过，纯函数不能。

---

## 4. 权威如何被提升（唯一合法路径）

```text
苏沐薇：你好像很喜欢猫。
        └─ assistant 事件，权威 = CHARACTER_GENERATION（不能支持外部事实）

用户：  对，我特别喜欢。
        └─ user 事件，且它 reply 到上面那条 assistant 事件
        └─ 权威 = USER_REPLY_CONFIRMATION（可以支持外部事实）
```

判定：

```ts
resolveAuthority({ kind: 'user_statement', repliedToKind: 'character_output' })
```

**由 reply graph 驱动，不做语义判断。** 因此它是确定的、可测试的、
不需要模型的。

### 4.1 这条设计刻意带来的代价

它依赖 reply graph 的正确性。因此 M3 把 assistant 事件的
`replyToEventId` 变成**必填**，并对目标做四条校验
（存在 / 同角色 / 同会话 / 更早）。

**宁可她偶尔"没被确认"，也不要错误确认。** 方向是刻意选的：
- 漏一次确认 → 少形成一条偏好记忆（可接受，M4 可以再观察）
- 错一次确认 → 一条错误的事实永久进账本（不可逆）

### 4.2 直接互动不是外部事实

`DIRECT_INTERACTION` **不在**外部事实白名单里，这一条容易被误读，
所以在这里再写一次：

| 结论 | 需要什么权威 |
|---|---|
| "这一轮真实发生过"（关系真的推进了一次） | `DIRECT_INTERACTION` |
| "他喜欢猫"（关于世界的事实为真） | `USER_EXPLICIT` / `USER_REPLY_CONFIRMATION` / `TOOL_OBSERVATION` |

用户说一句"月球是奶酪做的"，这一轮**确实发生过**（关系上的证据成立），
但"月球是奶酪做的"**不是**世界事实。

---

## 5. 系统与工具同样被隔离

### 5.1 系统指令不得成为角色经历（计划书第 84 节）

```text
系统提示："请以简洁方式回答。"
```

不能未来成为："苏沐薇记得有人曾要求自己简洁。"

因此 `SYSTEM_INSTRUCTION` 与 `conversation experience` 分开：
前者是 `system_instruction`，后者是 `DIRECT_INTERACTION`。
一句话就把两件事混起来，会让她的"经历"里长出无数条技术性提示。

### 5.2 工具输出不能自动成为用户事实（第 85 节）

```text
工具：profile lookup returned X
```

它可以成为 `tool_observation`（一种观测），但**不能**标记为 `user_report`。

这条路径现在就建好（`appendToolEvent` 已在端口上），
理由与 `tool` actor 的引入相同：**账本 append-only，补不了历史。**
现在多一个方法成本为零，以后补一次迁移的成本是"一批来源错误的旧数据"。

---

## 6. 可观测性：污染率是一个可查的数字

```text
AssistantToFactContaminationRate =
    assistant 生成的内容被错误分类成外部/用户事实的条数
  / 被测试的 assistant 生成内容条数
```

**M3 Gate 要求：在 deterministic source pipeline 中为 0。**

它被列为硬零指标（`M3_HARD_ZERO_METRICS`），
与另外三条同类：

```text
SeedMutationViolationCount         普通聊天改了 Seed
ConversationEventLossRate          处理了却没记进账本
EventOrderingErrorRate             序号冲突或倒序
```

共同点：**纯确定性，不涉及模型行为。** 因此"第一次跑不通"就说明代码有问题，
不存在"等 baseline 再判定"这回事。

---

## 7. 不变量与守它的测试

| 不变量 | 守它的测试 |
|---|---|
| 她的输出不能支持外部事实 | `kernel-tests-conversation.ts`（T4/T5） |
| 白名单恰为三种 | 同上（"白名单是封闭的"） |
| 用户确认由 reply graph 提升 | 同上 + `verify-m3-persistence.ts` T6 |
| 落库后她的话仍是 `CHARACTER_GENERATION` | `verify-m3-persistence.ts` §4 |
| 系统事件是 `system_instruction` | 同上 T7 |
| 工具事件是 `tool_observation` | 同上 T8 |
| 悬空 reply 目标被拒绝 | 同上 + `kernel-tests-conversation.ts` |
| 硬零指标无条件判定 | `evals/m3/thresholds.ts` |
| 领域层不 import 模型 SDK | `pnpm kernel:test` 依赖方向检查 |
