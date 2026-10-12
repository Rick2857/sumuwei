# Entity Model —— 谁可以是一件事的"对象"

**阶段**：M3.5 WP2（计划书第 6–9 / 47 / 48 节）
**代码**：`src/kernel/contracts/entity.ts`、`src/kernel/contracts/ids.ts`

---

## 1. 问题：M3 之后还剩一个写死的地方

M3 把"谁"这件事解决得很好（`actor.ts` 的身份分层），但 `ActorRef` 只覆盖四种 actor：

```ts
interface ActorRef { actorId: string; actorType: 'user' | 'character' | 'system' | 'tool' }
```

一旦出现"她与某个对象的关系"，签名里就只剩两个选择：

```ts
relationship(characterId: CharacterId, target: CharacterId)   // 写死了"目标必须是角色"
belief(characterId: CharacterId, about: string)               // 丢掉了类型安全
```

而计划书第 47 节要求：**所有新增数据结构必须通过 "Second Character Test"**。

---

## 2. 答案：EntityRef

```ts
interface EntityRef { id: EntityId; kind: EntityKind }
```

`id` 与 `kind` **一起**才构成"谁"。同一个 id 配不同 kind 不相等 ——
"名字叫 kitchen 的角色"与"厨房这个地点"必须能区分。

### kind 的取值

```text
M3.5 启用：      user / character / system / tool
仅登记不产出：    npc / group / location / object / organization
```

启用与登记分开是刻意的：

- `M3_5_ACTIVE_ENTITY_KINDS` 回答"**现在**哪些实体真的存在"
- `M3_5_RESERVED_ENTITY_KINDS` 回答"**允许**哪些实体存在"

**由谁守**：`m3.5:test` FC-T01。

### 为什么采用小写（审计决策 D1）

计划书第 7 节用大写 `USER / CHARACTER / SYSTEM / TOOL` 举例，这里采用小写。

理由不是美观：M3 的 `ActorType` 已经是小写，而且它**已经写进了数据库列**
（`conversation_events.actor_type`）与既有事件行。两套大小写会需要一张对照表 ——
而任何手工对照表都会在某天被漏写一个分支，那正是 M3 反复强调的"字典是愿望"。

采用同一套字面量之后，`ActorRef ↔ EntityRef` 是**恒等映射**，不可能出错。

---

## 3. 为什么不是"把所有 ID 都改成 EntityId"

计划书第 8 节说得很直接：**不要过度重构**。

```ts
CharacterDefinition.characterId   // 仍然是 CharacterId
ActorRef.actorId                  // 仍然是 string
ConversationId / ConversationEventId / DomainEventId   // 一个字都不改
```

理由：`CharacterId` 表达的是"**这是角色**"，比"这是个实体"**强**。
用弱的类型描述强的语义，是为了通用而丢掉信息。

`EntityRef` 只出现在**跨实体关系**的位置：

```text
actor / target / observer / subject / perspectiveOwner
```

也就是"这里可以是任何东西"的那些位置。**只有在那里，弱类型才是正确的。**

---

## 4. 为什么 ActorRef 不改写成 `extends EntityRef`

计划书第 9 节给了两个选项（`interface ActorRef extends EntityRef {}` 或 Adapter），
M3.5 选择 **Adapter**：

```ts
fromActor(actor: ActorRef): EntityRef     // 恒等映射
toActorRef(entity: EntityRef): ActorRef   // 仅四种 actor kind；其余抛错
```

理由：`ActorRef.actorId` 是**无品牌 `string`**，而 `EntityId` 是品牌类型。
让 `ActorRef` 继承 `EntityRef` 会触发一次全仓 cast —— 而 cast 是
**看不见的契约变更**（它让类型系统在那些位置停止工作，而且没有 review 痕迹）。

`toActorRef` 对非 actor 实体（地点、组织）**失败关闭**而不是硬塞一个 `'system'`：
把地点冒充成系统组件，是"来源伪造"的另一种形式。

---

## 5. Perspective Owner（M9 的地基，M3.5 只有一个类型别名）

```ts
type PerspectiveOwnerId = EntityId

interface EntityRelationKey { owner: EntityId; target: EntityId }
```

计划书第 25 / 27 / 105 节要求：未来所有
`Belief` / `Knowledge` / `Perspective` / `Relationship` / `Memory`
都必须带 `perspectiveOwnerId`。

于是：

```text
苏沐薇认为 X        →  { perspectiveOwnerId: char_sumuwei, ... }
角色 B 认为 Y       →  { perspectiveOwnerId: char_B, ... }
```

天然可以共存，而且"世界真相"是第三样东西（它不属于任何视角）。

**M3.5 不实现任何 store**：这里只有类型别名与约定。
由 `m3.5:test` FC-T05 守着，并且 FC-T05 会断言 `src/kernel/contracts/` 下
不存在任何 `belief` 文件 —— 防止有人"顺手"把 M9 的东西提前做了。

---

## 6. Second Character Test（计划书第 48 节）

开发者静态检查：假设同时存在 `char_sumuwei` 与 `char_B`，问：

| 问题 | M3.5 的答案 | 由谁守 |
|---|---|---|
| `ConversationEvent` 还能工作吗？ | 能。`characterId` 本来就是参数，不写死 | FC-T01 第 5 条用例 |
| `Relationship` 未来能表达二者关系吗？ | 能。`EntityRelationKey{owner,target}` | FC-T01（类型）+ 文档约束 |
| `Belief` 能属于不同角色吗？ | 能。`perspectiveOwnerId` | FC-T05 |
| `Memory` 能区分 owner 吗？ | 能。M4 的约束表已写明必须带 owner/subject/source | `future-compatibility.md` §8 |
| `Intent` 能有不同 actor 吗？ | 能。`CharacterIntent.characterId` | FC-T03 |
| `Observation` 能指定 recipient 吗？ | 能。`Observation.characterId` | FC-T02 |

**如果必须大改 schema：M3.5 设计不通过。** 现在的答案是"都不需要大改"。
