# ADR-013：通用实体引用（EntityRef），而不是把所有 ID 都改成 EntityId

- **状态**：已接受（M3.5）
- **日期**：2026-09-17
- **相关**：计划书第 6 / 7 / 8 / 9 / 47 / 48 节
- **代码**：`src/kernel/contracts/entity.ts`、`src/kernel/contracts/ids.ts`

---

## 背景

M3 的身份分层解决了"谁"的问题（`ActorRef`：user / character / system / tool），
但它只覆盖四种 actor。一旦出现"她与某个对象的关系"，签名里就只剩两个选择：

```ts
relationship(characterId: CharacterId, target: CharacterId)   // 写死了"目标必须是角色"
belief(characterId: CharacterId, about: string)               // 丢掉了类型安全
```

计划书第 47 节要求所有新增数据结构通过 "Second Character Test"：
明天加入第二个角色时，底层 Event / Relationship / Belief 是否需要推翻。

同时计划书第 8 节又说得很直接：**不要过度重构**。

两条要求张力明显：既要为"任何实体"留位置，又不能把已有的强类型 ID 全部削弱。

---

## 决策

**引入 `EntityRef`，但只用在跨实体关系的位置；既有 ID 类型一个都不删、不改。**

### 1. `EntityRef = { id: EntityId, kind: EntityKind }`

`id` 与 `kind` 一起构成"谁"。同一个 id 配不同 kind **不相等**
（"名字叫 kitchen 的角色"与"厨房"必须能区分）。

### 2. `EntityKind` 采用与 `ActorType` **同一套小写字面量**

```text
启用：      user / character / system / tool
仅登记：    npc / group / location / object / organization
```

于是 `ActorRef ↔ EntityRef` 是**恒等映射**，而不是一张手工对照表。

> 计划书第 7 节列举时用的是大写（`USER / CHARACTER / …`）。
> 这里采用小写不是因为美观：`ActorType` 已经是小写，而且**已经写进数据库列**
> （`conversation_events.actor_type`）与既有事件行。
> 两套大小写会需要一张对照表，而任何手工对照表都会在某天被漏写一个分支 ——
> 那正是 M3 反复强调的"字典是愿望"。

### 3. 保留强类型 ID

```ts
CharacterDefinition.characterId                    // 仍然是 CharacterId
ConversationId / ConversationEventId / DomainEventId   // 一个字都不改
ActorRef.actorId                                   // 仍然是 string
```

`CharacterId` 表达的是"**这是角色**"，比"这是个实体"**强**。
用弱类型描述强语义，是为了通用而丢掉信息。
`EntityRef` 只出现在 `actor` / `target` / `observer` / `subject` / `perspectiveOwner`
这些"这里可以是任何东西"的位置。

### 4. `ActorRef` 不继承 `EntityRef`，改用 Adapter

```ts
fromActor(actor: ActorRef): EntityRef     // 恒等映射
toActorRef(entity: EntityRef): ActorRef   // 仅四种 actor kind；其余抛错
```

`toActorRef` 对非 actor 实体（地点、组织）**失败关闭**，而不是硬塞 `'system'` ——
把地点冒充成系统组件，是"来源伪造"的另一种形式。

---

## 被否决的备选方案

### 方案 A：把所有 ID 都改成 `EntityId`

**否决理由**：
① 计划书第 8 节明确反对过度重构；
② 品牌类型是编译期的信息，把 `CharacterId` 降级成 `EntityId` 之后，
"这里必须是角色"这件事就只能靠**注释**保证；
③ 它会触发全仓替换，而全仓替换无法 review。

### 方案 B：`interface ActorRef extends EntityRef {}`

**否决理由**：`ActorRef.actorId` 是无品牌 `string`，`EntityId` 是品牌类型。
让前者继承后者会要求全仓 cast —— 而 cast 是**看不见的契约变更**
（它让类型系统在那些位置停止工作，而且没有 review 痕迹）。

计划书第 9 节给了两个选项（继承或 Adapter），这里选 Adapter 正是这个原因。

### 方案 C：只登记 M3.5 真正启用的四种 kind（不登记 npc / location / …）

**否决理由**：与 M3 提前登记 `tool` actor 是同一个判断
（`actor.ts` 文件头第 17–24 行）。`kind` 会进 `EntityRef`，而 `EntityRef`
会进事件、记忆、关系与 belief —— **那些数据是 append-only 的**。
今天用 `'character'` 冒充一个城市场景，明天就再也分不清
"这真的是一条角色数据，还是一条被压扁的场景数据"。

登记一个**不会被产出**的枚举值成本是零（不进任何表、不产生任何行为），
收益是让"到底允许哪些实体"永远只有一个答案。

---

## 后果

### 正面

- 第二个角色、NPC、地点、组织的**关系**在类型上写得出来，底层 schema 不需要推翻。
- 既有代码零改动（`ActorRef` / `CharacterId` / `ConversationId` 全部保留）。
- `EntityKind` 的启用与登记分开，M3.5 "没有产出未来实体"这件事可被测试断言。

### 代价

- 出现了两套"身份"表示：`ActorRef`（对话发言者）与 `EntityRef`（任意实体）。
  缓解：只有两个转换函数（`fromActor` / `toActorRef`），且 `toActorRef` 失败关闭。
- `EntityRef` 比裸 `CharacterId` 啰嗦。缓解：它只出现在跨实体关系处，
  而不是所有地方。

---

## 怎么验证这条决策还成立

| 检查 | 由谁守 |
|---|---|
| `EntityRef` 可以表示第二个角色 | `m3.5:test` FC-T01 |
| 同 id 不同 kind 不相等 | FC-T01 |
| `ActorRef ↔ EntityRef` 往返是恒等映射 | FC-T01 |
| 非 actor 实体不能冒充发言者 | FC-T01（`entity_kind_not_an_actor`） |
| M3.5 没有产出保留的实体种类 | FC-T01（`M3_5_ACTIVE_ENTITY_KINDS` 恰 4 种） |
| 既有强类型 ID 仍在使用 | `kernel:test` / `kernel:test:conversation` 全部通过（未改动） |
| M3.5 不实现 Belief store | FC-T05 |
