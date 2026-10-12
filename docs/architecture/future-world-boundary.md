# Future World Boundary —— 世界、角色与结果的边界

**阶段**：M3.5（计划书第 97 节）
**性质**：这份最短，但它是最重要的那份

---

## 0. 六句话（计划书第 97 节原文）

```text
当前项目不实现 World Kernel。

Character Kernel 不拥有世界事实。

未来 Environment 将通过 Observation
向 Character 提供可感知信息。

Character 只能生成 Intent。

Environment 决定 Intent 的结果。

结果再通过 Observation 返回 Character。
```

下面是对这六句话的展开。**任何与它们冲突的设计都是错的**，
无论它看起来多方便。

---

## 1. 现在的真实运行链路（M3.5 完成后的全部现实）

```text
用户说话
   ↓
ConversationEvent（事实账本）
   ↓
ConversationObservation（她感知到了这句话）
   ↓
Character Kernel（身份 / 上下文 / 事件）
   ↓
SpeechIntent（她想说什么）
   ↓
ConversationIntentResolver（唯一的 Resolver）
   ↓
assistant 事件 + 用户收到回复
```

**这就是全部。** M3.5 没有增加任何"世界"，也没有增加任何自主行为。
新增的只是把上面这条链**用正确的名词**表达出来。

---

## 2. 未来的形状（M3.5 只保证接口接得上）

```text
                     World（未来才建）
                        │
                        │ ① 世界向角色提供可感知信息
                        ▼
                   Observation
                        │
                        ▼
        ┌───────────────────────────────┐
        │       Character Kernel        │
        │  Identity / Events / Context  │
        │  Memory / Relationship / …    │
        └───────────────┬───────────────┘
                        │ ② 角色只能**提议**
                        ▼
                  CharacterIntent
                        │
                        ▼
              Environment Resolver
                        │ ③ 环境决定能不能
                        ▼
                 IntentResolution
                        │
                        ▼
                  Result / World state
                        │ ④ 结果以观测的形式回来
                        └──────────► Observation（回到①）
```

---

## 3. 三条不可以让渡的职责

### 3.1 角色不拥有世界事实

`character_domain_events` 这一张表**永远**只描述"苏沐薇内部发生了什么变化"。

它不描述门有没有开、灯有没有亮、箱子里有没有钥匙。
那些属于 World（未来的表，今天不存在）。

**为什么这条必须写死**：这张表会被 M9 的 Belief、M11 的 Reflection 与 M4 的
Memory 反复读取。一旦它里面混进了"世界事实"，那么
"她以为门开了"与"门真的开了"就会在**最底层**变成同一行数据 ——
之后任何再精细的设计都救不回来。

**机守着它的东西**：`assertCharacterInternalScope`（唯一受理点：`policies/validator.ts`），
`m3.5:test` FC-T04。

### 3.2 角色只能产生 Intent，不能直接改世界

**不存在的代码**：`world.update(...)` / `setWorldState(...)` / 任何"她想什么世界就发生什么"的路径。

**存在的代码**：`IntentResolver` 端口（`resolve(intent) → IntentResolution`），
以及 M3.5 唯一的实现 `ConversationIntentResolver`（它只做一件事：
把一句话落成一条 assistant 事件）。

**为什么**：如果角色能直接 UPDATE world，那会一次性破坏
因果、规则、多角色冲突、权限、世界真实性（计划书第 24 节）。

### 3.3 结果必须经环境返回，而不是角色自己假定

`Intent("打开门")` **不等于** `门已打开`。

"她做了某件事"与"那件事发生了"之间**必须**有一个 Environment Resolver。
M3.5 不实现任何 Environment Resolver —— 只留下端口与
`accepted` / `rejected` / `failed` 三种结果状态。

结果回来时**仍然是 Observation**（"门打不开"是一条观测），
于是它自动继承 FC-06 的语义：观测不是事实。

---

## 4. 三种 Event 的最终职责（计划书第 40 节）

```text
ConversationEvent        谁说了什么                  ✅ M3 已实现
WorldEvent               世界真的发生了什么            ❌ M3.5 不建表、不建服务
CharacterDomainEvent     苏沐薇内部因此发生了什么变化    ✅ M2.5 已实现
```

M3.5 结束时真正运行的是**第一类和第三类**；第二类只有文档约定
（`DomainEventScope` 里登记了 `'WORLD'` 这个名字，但永不启用）。

---

## 5. 这份边界保护的是什么

如果今天不写清楚，最可能发生的是下面这条路径：

```text
某天需要"她意识到外面下雨了"
   ↓
最省事的做法：造一条假的 user_message："外面下雨了"
   ↓
账本里出现一条"用户说的话"（来源类别、权威等级、reply graph 全部错）
   ↓
M4 的 Memory 把它当成用户陈述 → 形成一条错误记忆
   ↓
M9 的 Belief 把它当成她确信的世界事实
   ↓
几十轮之后，她"记得"用户曾告诉她一件从未发生过的事
```

而且这条链**无法修复**：事实账本是 append-only 的。

M3.5 的作用就是在第一步就把这条路堵上，代价是几十行类型与一篇文档。
