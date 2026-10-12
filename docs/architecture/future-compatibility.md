# Future Compatibility —— 不许堵死未来的七条规则

**阶段**：M3.5 — Future Extension Compatibility
**性质**：本文件是 M3.5 的**宪法**（计划书第 5 / 95 节）
**前置**：M3 Identity & Conversation Integrity 已完成
**下一阶段**：M4 — Reliable Long-Term Memory

---

## 一句话

M3.5 不建设未来。它只确保：

> **今天为了把 Lv1/Lv2 做简单而做出的决定，
> 不会成为明天实现更高级角色智能体时必须推翻的错误假设。**

因此本阶段真正做的是（计划书第 110 节）：

```text
不是 World       而是 World Boundary
不是 NPC         而是 Entity
不是 Action System 而是 Intent
不是 Simulation   而是 Time Slot
不是 Multi-Agent  而是 Perspective Owner
```

---

## 0. 怎么用这份文件

M4 之后每个阶段开工前，**先读它**，再回答两个问题：

1. 我要加的东西，会不会让下面某条 FC 规则变得不成立？
2. 我要加的东西，有没有违反"后续阶段约束"表里属于我的那几行？

如果会，先改这份文件并写 ADR，而不是"先做出来再说"。
**这份文件与 `invariants.md` 的区别**：`invariants.md` 管的是"已经生效的系统行为"，
本文件管的是"未来的接口空间"。

---

## 1. FC-01：输入不能永久绑定 UserMessage

Character Kernel 的输入不应永久绑定：

```text
UserMessage
```

而应该可以抽象为：

```text
Observation
```

**落地点**：`src/kernel/contracts/observation.ts`，`Observation` / `ObservationType`，
由 `ConversationEvent → ConversationObservation` 适配（`conversationObservationFrom`）。

**由谁守**：`m3.5:test` FC-T02（非对话观测可被 API 接收）、`m3.5:verify`（端到端走新链路）。

---

## 2. FC-02：输出不能永久绑定 string reply

Character Kernel 的输出不应永久绑定：

```text
string reply
```

而应该抽象为：

```text
CharacterIntent
```

当前 Reply 只是其中一种 Intent（`SPEECH`）。

**落地点**：`src/kernel/contracts/intent.ts`，`CharacterIntent` / `CharacterOutput` /
`SpeechIntentPayload`；`TurnGateway.completeTurn` 的返回值里带着
`output: CharacterOutput` 与 `resolution: IntentResolution`。

**由谁守**：`m3.5:test` FC-T03（普通聊天的输出是 `CharacterOutput └─ SpeechIntent`，
且行为与 M3 一致）。

---

## 3. FC-03：Intent 与"事情真的发生"必须是两件事

```text
角色想做某事（Intent）
        ≠
事情真的发生（Result）
```

未来的完整形状：

```text
Intent
  ↓
Environment Resolver
  ↓
Result（IntentResolution）
  ↓
Observation（结果以观测的形式回到她那里）
```

**落地点**：`IntentResolver` 端口 + `IntentResolution`（`accepted` / `rejected` / `failed`）。
M3.5 唯一的实现是 `ConversationIntentResolver`（`SpeechIntent → 一条 assistant 事件`）。

**⚠️ 最容易搞错的一点**：`rejected` 与 `failed` 是**两件不同的事**：

| 状态 | 含义 | 处理方式 |
|---|---|---|
| `rejected` | 环境**明确拒绝**（门锁着） | 正常结果，应当变成一条 Observation 回到她那里 |
| `failed` | 环境想处理但失败了（IO / 网络） | 运维问题，不该被写成"世界规律" |

混起来会让她把基础设施故障当成世界规律写进 M9 的 Belief。

**由谁守**：`m3.5:test` FC-T04（`MockActionIntent` + mock 环境拒绝 → 世界哨兵零变化）。

---

## 4. FC-04：CharacterDomainEvent 永远只描述角色内部的变化

```text
ConversationEvent      表示：谁说了什么
WorldEvent             表示：世界真的发生了什么        ← M3.5 不建这张表
CharacterDomainEvent   表示：苏沐薇内部因此发生了什么变化
```

CharacterDomainEvent **不得在未来同时承担"世界事实"的职责**。

**落地点**：`DOMAIN_EVENT_SCOPE`（`'CHARACTER_INTERNAL'`）+ `assertCharacterInternalScope`，
插在 `policies/validator.ts` 的**唯一**受理点。声称 `scope: 'WORLD'` 的提案被整体拒绝。

**为什么是常量 + 校验而不是一个列**（审计决策 D2，见
[`../m3.5/compatibility-audit.md`](../m3.5/compatibility-audit.md)）：
这个值恒为同一个常量，不是数据；给常量建列会得到一个"永远同一个值、
但理论上能被写错"的列，而常量 + 校验让"写得出 WORLD 的地方在编译期与运行期都不存在"。

**由谁守**：`m3.5:test` FC-T04（scope 校验）、FC-T04 的符号守卫
（`src/` 内不得出现 `WorldStateRepository` / `SceneService` / `NPCService` /
`SimulationScheduler` / `GameMaster` 这类实现）。

---

## 5. FC-05：状态模型不得把 user 写死为唯一目标实体

Relationship / Belief / Memory 等模型**不得**把 `user` 写死为唯一目标实体。

**落地点**：`entity.ts` 的 `EntityRef`（`{ id, kind }`）与 `EntityRelationKey`
（`{ owner, target }`）。

M3 的 `ActorRef` 与 `User` / `CharacterId` **继续保留、继续使用**
（`CharacterDefinition.id` 仍是 `CharacterId`）；`EntityRef` 只出现在
**跨实体关系**的位置（actor / target / observer / subject / perspectiveOwner）。

**由谁守**：`m3.5:test` FC-T01（第二个角色 + 同 id 不同 kind 可区分）、FC-T05（perspectiveOwner）。

---

## 6. FC-06：真实世界事实与角色认知必须可以分别存在

```text
World:   箱子里有钥匙      ← 世界真相
B:       知道箱子里有钥匙
苏沐薇:   不知道
```

这三件事必须能**同时成立**。

**落地点**：M3.5 只做两件事 ——
① `EntityRef` 让"某个认知属于谁"在类型上写得出来；
② 约定 `perspectiveOwnerId: EntityId` 是未来所有 Belief / Knowledge / Perspective 的**必填**字段。

M3.5 **不建 Belief store**。

**由谁守**：`m3.5:test` FC-T05。

**⚠️ 与 Observation 的关系（计划书第 14 节）**：Observation 表示
"某种信息进入了她的感知范围"，**不代表内容客观正确**。
正确的记录是 `某人说"门外没人"`，而不是 `门外真的没人`。
这条是 M9 Belief 的地基：一旦 Observation 被当成事实，
Belief 就退化成"世界真相的副本"，而"她以为"与"实际是"就再也分不开了。

---

## 7. FC-07：现实时间 / 发生时间 / 模拟时间不得绑定为同一概念

```text
recordedAt   系统什么时候记录到它       （= 既有 createdAt ≡ created_at 列）
occurredAt   这件事什么时候发生         （可空；缺省 = 不知道）
logicalTime  模拟时间                   （可空；M3.5 必须留空）
```

**落地点**：`time.ts` 的 `EventTime` + `assertEventTime`；
`conversation_events` / `character_domain_events` 的 `occurred_at` / `logical_time` nullable 列。

**为什么现在加**（计划书第 33 节）：这些表是 **append-only** 的。
等到真的需要区分三种时间时，库里已经躺着大量只有一个 `created_at` 的行，
而那些行**无法回溯判断**当初是哪种时间 —— 迁移只能猜，猜错的代价是永久性的。

**⚠️ M3.5 不建模拟时钟**：`logicalTime` 的位置留好了，
但 `assertEventTime` 会拒绝任何非空值（`simulation_time_not_supported`）。
留字段是为了未来不必改 schema 与调用签名；拒绝写入是为了不出现
"有人写了它但没人按它排序"的半成品 —— 那比没有更危险。

**由谁守**：`m3.5:test` FC-T06、`m3.5:verify`（落库回读）。

---

## 8. 后续阶段约束（计划书第 73 / 103–106 节）

开工前请对着自己那一行设计。**这些约束现在是契约**（写进类型/文档），
不是建议。

| 阶段 | 约束 | 现在的落地点 |
|---|---|---|
| **M4 Memory** | Memory schema 必须能表达 `owner` / `subject` / `source entity` / `source observation 或 event`，**不得**写死 `characterId + userFact` | `EntityRef`、`perspectiveOwnerId` 约定、`sourceEventIds`（本文件 FC-05/06） |
| **M5 Retrieval** | 检索接口必须是 `retrieve(query: RetrievalQuery)`，**不能只有 `string`**；`RetrievalQuery` 至少含 `characterId` / `observation?` / `text?` / `subjects?: EntityRef[]` / `scope?` / `limit?` | `Observation`（FC-01）、`EntityRef`（FC-05） |
| **M5.5 Search** | `ExternalEvidence` 在 Kernel 看来属于 **Observation/Evidence**，**不能自动成为 Memory** | `ObservationType.TOOL_OBSERVATION` / `sourceAuthority` 白名单 |
| **M7 Relationship** | 必须是 `owner → target`（`EntityRelationKey`），**不允许** `RelationshipState { userTrust: number }` 这种把 user 写死的形状 | `EntityRelationKey`（FC-05）；M1/M2 的 `src/state/types.ts` 属"暂不改"（`compatibility-audit.md` N1/N2） |
| **M8 Affect** | Affect **属于 Character**，不属于 Conversation | `characterId` 语义（M3 已成立） |
| **M9 Belief** | 必须带 `perspectiveOwnerId`；`World truth` / `B knows` / `苏沐薇 doesn't know` 同时可表达 | FC-06；`Observation ≠ 事实`（第 14 节） |
| **M10 Goal** | 必须支持 `targetEntity?` / `contextRef?`，不得假定目标永远与"和用户聊天"有关 | `EntityRef`（FC-05）、FC-03（Goal 的实现要通过 Intent 产生效果） |
| **M11 Reflection** | **只能**修改 Character internal state；**不能**修改 World truth | FC-04（scope + 无世界写入口） |

---

## 9. 现在**明确不做**的事（做之前必须先改这份文件）

```text
World Kernel / Game Master / Scene Engine / NPC Manager
Simulation Tick / Location System / Inventory System / Physics
Autonomous Life / Multiple Active Characters
World Database / Scene Database / World Event Resolver / 复杂 Scheduler
角色自主长期行动
```

也不引入 `Concordia runtime` / `AI Town runtime`（只作架构参考，
见 [`../research/concordia-notes.md`](../research/concordia-notes.md) 与
[`../research/ai-town-notes.md`](../research/ai-town-notes.md)）。

**失控停止条件**（计划书第 102 节，已变成自动化断言）：
如果在 `src/` 里出现 `SceneService` / `WorldStateRepository` / `NPCService` /
`SimulationScheduler`，`pnpm m3.5:test` 会直接失败。

---

## 10. 相关文档

| 文档 | 回答什么 |
|---|---|
| [`entity-model.md`](./entity-model.md) | EntityRef 与 ActorRef 什么关系？为什么不是把所有 ID 都改成 EntityId？ |
| [`observation-intent-boundary.md`](./observation-intent-boundary.md) | Kernel 的输入/输出边界是怎么划的？Intent 与 Result 为什么必须分开？ |
| [`future-world-boundary.md`](./future-world-boundary.md) | 世界进来以后，谁负责什么？（这份最短也最重要） |
| [`temporal-model.md`](./temporal-model.md) | 三种时间分别是什么？为什么现在就要加列？ |
| [`invariants.md`](./invariants.md) | 不许破的规则（含 M3.5 追加的 21–27 条） |
| [`../m3.5/compatibility-audit.md`](../m3.5/compatibility-audit.md) | 审计：哪些地方本来会堵死未来？ |
| [`../adr/`](../adr/) | ADR-013 ~ ADR-019（M3.5 的七条决策） |
