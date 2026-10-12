# M3.5 — Future Compatibility Audit（WP1）

**阶段**：M3.5 — Future Extension Compatibility
**性质**：WP1 Gate 的交付物（计划书第 61–66 节）
**前置**：M3 Identity & Conversation Integrity 已完成并收口
**基线 commit**：`ca94e83`
**只回答一件事**：**当前地基里，哪些地方已经把"未来"堵死了？**

> 本文件只审计、不改代码。每一条都给出证据（文件 + 符号 / 行号），
> 并按计划书第 62 节的四类归档：
> `SAFE` / `NEEDS_ADDITIVE_CHANGE` / `NEEDS_ADAPTER` / `DO_NOT_CHANGE_NOW`。

---

## 0. 一句话结论

M3 结束时的地基**没有任何一处需要推翻**。

需要动的地方全部是三类低成本操作：

```text
加一个接口（EntityRef / Observation / CharacterIntent / EventTime / TriggerKind）
加一层适配器（ActorRef→EntityRef、事件→Observation、string→SpeechIntent）
加一个 nullable 列（occurred_at / logical_time / trigger_kind / trace 的四个语义槽）
```

真正**危险**的地方不是"缺功能"，而是三个**隐含假设**——它们今天都对，
但如果不写进契约，未来会被当成"系统本来就是这样"：

| 隐含假设 | 出现在哪 | 未来会怎样出事 |
|---|---|---|
| 输入一定是用户消息 | `ContextCompileInput.currentInput: string`（`context.ts:109`） | 世界事件只能伪装成 user message 进 Kernel |
| Kernel 输出一定是字符串回复 | `TurnGateway.completeTurn({ replyText })`（`turn-gateway.ts:439`） | Runtime API 被 `string` 锁死；Intent 与 Result 纠缠 |
| 事情的时间只有一个 | `ConversationEvent.createdAt`（`conversation-event.ts:141`） | "发生时间 / 记录时间 / 模拟时间"以后要靠迁移拆，而账本是 append-only |

M3.5 的七个 WP 就是把这三个假设**变成显式契约**，而不是现在就实现世界。

---

## 1. 审计范围与方法

逐文件通读了以下七块（计划书第 61 节指定的扫描面），并对每处
"写死 user / 写死 message / 写死 reply string / 写死 real timestamp /
写死 conversation-only trigger" 判定归档：

| 扫描面 | 承载文件 |
|---|---|
| Character Kernel 契约 | `src/kernel/contracts/*.ts` |
| Conversation Event | `conversation-event.ts` / `persistence/conversation-store.ts` / `ledger.ts` |
| Domain Event | `domain-event.ts` / `persistence/event-store.ts` / `policies/validator.ts` |
| Context Compiler | `context.ts` / `kernel/context/sections.ts` |
| Jobs | `job.ts` / `persistence/job-store.ts` |
| Identity | `actor.ts` / `identity-snapshot.ts` / `kernel/app/identity-service.ts` |
| Trace | `trace.ts` / `persistence/trace-store.ts` / `infrastructure/telemetry/*` |

**判定标准**：

- `SAFE` —— 结构已经能容纳未来，**不修改**
- `NEEDS_ADDITIVE_CHANGE` —— 缺一个 nullable 列 / 一个枚举值 / 一个可选字段，改法是"加"
- `NEEDS_ADAPTER` —— 现有形状够用，但需要在边界加一层转换，**不推翻原结构**
- `DO_NOT_CHANGE_NOW` —— 当前零需求，只登记为"未来边界"

---

## 2. SAFE（已满足未来需求，一个字都不改）

| # | 对象 | 证据 | 为什么它已经是对的 |
|---|---|---|---|
| S1 | `ContextCompiler` 的 section/provider 机制 | `context.ts` 的 `ContextSectionProvider` / `ContextSection[]` / `SECTION_PRIORITY`；`sections.ts` 的 `buildContextCompilerV2` | 计划书第 43 节要求编译器接收 `ContextSection[]` 而不是固定几个字符串参数 —— **现在就是**。新增 Memory / Relationship / Belief section 只需注册一个 provider，排序与裁剪算法零改动 |
| S2 | `DomainEventRegistry`（类型受控登记表） | `domain-event.ts:132` `class DomainEventRegistry` / `createDefaultDomainEventRegistry()` | M4–M11 每新增一种认知事件只改一处登记表；且刻意做成工厂而非单例，测试能拿干净表 |
| S3 | `ConversationLedgerPort` | `ledger-port.ts:138` `interface ConversationLedgerPort` | **没有** `append(event)` 万能口、**没有** update/delete、**没有** `sequence` / `actorType` / `sourceKind` 参数 —— "来源写错"在类型层面写不出来。未来加 `TOOL_/WORLD_` 来源仍复用同一套 |
| S4 | `sourceAuthority` / `epistemicSource` 结构化列 | `conversation-event.ts` 的 provenance 三列 + `source-authority.ts` | 「她自己说的不能变成外部事实」（铁律 6）已是列级契约；`TOOL_OBSERVATION` 也已在白名单里，未来接 Tool 不需要改历史语义 |
| S5 | `TraceStep` 的 `steps` JSON 列 + `(string & {})` 开放 kind | `trace.ts:59` `TraceStepKind`（末尾 `| (string & {})`） | 新增 step kind **不需要迁移**，`verify-m3-phoenix.ts:283` 用 `includes()` 校验，加性扩展不会破它 |
| S6 | `Projection` / `Reducer` 模型 | `projection.ts` / `projections/diagnostic.ts` / `event-store.ts` | 「投影不是真相，可重放」与"未来认知模块"完全同构；M4+ 只是多注册 reducer |
| S7 | `character_traces` 的 `projection_revisions_start/end` | `migrations.ts` 0002 段 | 「这轮开始时她是什么状态」已可回答；未来加 Affect/Belief 投影自动进同两列 |
| S8 | 数据库隔离三层防护 | `src/dev/sandbox.ts` / `src/db/index.ts` | M3.5 全部新测试沿用即可，不需要新的安全机制 |
| S9 | `EntityKind` 的**枚举来源** `ActorType` | `actor.ts:66` `type ActorType = 'user'\|'character'\|'system'\|'tool'` | 四种值恰好是 M3.5 要启用的四种 EntityKind；`tool` 在 M3 提前登记（`actor.ts` 文件头第 17–24 行有理由说明）正是"不堵未来"的先例 |

---

## 3. NEEDS_ADDITIVE_CHANGE（加一个可空列 / 一个可选字段）

| # | 对象 | 现状证据 | M3.5 加法 | 风险 |
|---|---|---|---|---|
| A1 | `conversation_events` 只有 `created_at` | `conversation-event.ts:141` `createdAt: Timestamp`；`migrations.ts` 0002/0003 无 occurred 列 | `occurred_at bigint` + `logical_time text`（nullable） | 低：`select *` + NULL→undefined；旧行不回填 |
| A2 | `character_domain_events` 同上 | `domain-event.ts:91` `createdAt: Timestamp` | 同上两列 | 低 |
| A3 | Job 只由对话事件驱动 | `job.ts:29` `sourceFromSequence/sourceToSequence`（闭区间）；`job-store.ts` 无 trigger 列 | `trigger_kind text not null default 'conversation'` | 低：默认值即旧语义 |
| A4 | Trace 没有"感知/意图"语义槽 | `trace.ts` 的 `CharacterRunTrace`：有 `inputEventId`/`outputEventId`，没有 observation/intent | 四个 nullable 列：`observation_id` / `observation_type` / `intent_id` / `intent_type` | 低（对齐 M3 给 trace 加 identity 列的做法） |
| A5 | `TraceStepKind` 的八步树没有 Observaton / Intent 节点 | `turn-gateway.ts:346` 起（beginTurn 四步）、`turn-gateway.ts:521` 起（completeTurn 四步） | 三个新 kind：`observation_adapt` / `intent_create` / `intent_resolve` | 低：`steps` 是 JSON，无迁移 |
| A6 | Domain Event 没有"职责范围"标记 | `domain-event.ts:49` `interface DomainEvent` 无 scope | 常量 `DOMAIN_EVENT_SCOPE='CHARACTER_INTERNAL'` + 校验 | 低（**决策见 §6 D2**：不建列） |

---

## 4. NEEDS_ADAPTER（现有形状保留，在边界加转换）

| # | 对象 | 现状证据 | 适配器 | 为什么不推翻原结构 |
|---|---|---|---|---|
| D1 | `ActorRef` 与通用实体不是同一形状 | `actor.ts:68` `{ actorId: string; actorType: ActorType }` | `fromActor(actor) → EntityRef` / `toActorRef(entity) → ActorRef` | `actorId` 是无品牌 `string`，已在数十处 SQL/日志中使用；品牌化会触发全仓 cast，违反计划书第 8 节「不要过度重构」。计划书第 9 节明确允许 Adapter 方案 |
| D2 | Kernel 的输入是 **user 文本** | `context.ts:109` `currentInput: string`；`turn-gateway.ts:293` `beginTurn(userText: string)` | `ConversationEvent → ConversationObservation`，再由 Observation **派生** `currentInput` | 派生保证 prompt **逐字节不变**（FC-T08）；同时 Kernel 概念上不再只接受 user string |
| D3 | Kernel 的输出是 **string** | `turn-gateway.ts:439` `completeTurn({ replyText: string })` | `replyText → SpeechIntent → CharacterOutput`；落库经 `ConversationIntentResolver` | 与 D2 同一个道理：`string` 仍存在于最外层（模型确实返回文本），但**领域边界**上不再是它 |
| D4 | Job 的触发是用"序号区间"表达的 | `job.ts:29` | `triggerOf(job) → { kind, sourceRefs }` | 计划书第 38 节要求保留 `source_event_range` 并加 Adapter，"避免破坏 M2.5 已完成实现" |
| D5 | 工具输出走的是 ConversationEvent 的 `tool_event` | `conversation-event.ts:64` `'tool_event'`；`conversation-recorder.ts` 的 `recordToolOutput` | 未来 `ToolOutput → TOOL_OBSERVATION` | 计划书第 46 节：**当前不要求所有 Tool 都改造**，建立 Adapter 即可 |
| D6 | 模型调用由调用方发起（网关只给 packet） | `turn-gateway.ts:394` `compileTurn` → `promptFor(packet)` | 无需改动；Intent 创建发生在 `completeTurn` | 这是 M2.5 刻意的"Context 单入口"设计，M3.5 不应破坏 |

---

## 5. DO_NOT_CHANGE_NOW（登记为未来边界，本阶段零实现）

| # | 对象 | 证据 | 为什么现在不动 | 未来归属 |
|---|---|---|---|---|
| N1 | `src/state/types.ts` 的 `CharacterState.userId` | `state/types.ts:37` `interface CharacterState`（含 `userId: string`） | 这是 M1/M2 的**状态层**，M3 的 Kernel 并未依赖它做认知；动它会改掉 M2 已验收的行为 | M7 Relationship（概念上改为 `owner → target`）；约束写入 `future-compatibility.md` |
| N2 | `RelationshipState` 只有一个隐式对象 | `state/types.ts:32` `interface RelationshipState { trust; closeness; ... }`（无 owner/target） | M3.5 不实现 Relationship（计划书第 27 节：**M7 不允许** `userTrust` 这种写死形状，但那是 M7 的验收项） | M7 |
| N3 | WorldEvent 表 / World Kernel | 全仓不存在 | 计划书第 39/41/97 节：**不建表、不建服务**，只写 ADR 与文档 | 更远（Lv3+） |
| N4 | Observation / Intent 的持久化 | 全仓不存在 | 计划书第 84/85 节：Observation 可由 ConversationEvent **派生**；SpeechIntent 最终形成 assistant 事件，**不新建表** | 真正出现 ActionIntent / World Observation 时再定 |
| N5 | Memory / Retrieval 接口 | `context.ts:46` 只有预留的 `'memory'` section kind | 计划书第 26/44 节：M4/M5 的范围，M3.5 只写**设计约束** | M4 / M5 |
| N6 | Belief / 模拟时间 / Goal 运行时 | 全仓不存在 | 计划书第 25/28/32 节：M3.5 只留 `perspectiveOwnerId` 约定与 `logicalTime?` 槽位 | M9 / M10 |
| N7 | M1/M2 的 `memories` 表路径 | `migrations.ts` 0001 段；`RECENT_MESSAGES` provider | M2.5 已确立「Adapter > Migration > Rewrite」，继续并行，不动 | 不排期 |
| N8 | ElizaOS Runtime 的扩展边界 | `src/infrastructure/runtime/adapters.ts`（唯一跨越点） | 计划书第 57 节：Observation/Intent Adapter **也应位于插件/Adapter 层**，不要侵入 ElizaOS Core | 持续 |

---

## 6. 审计中做出的三个判断（写进 ADR）

### D1. 为什么 `EntityKind` 用**小写**而不是计划书第 7 节的大写

计划书第 7 节列举 `USER / CHARACTER / SYSTEM / TOOL`（大写）。
但 M3 的 `ActorType` 已经是小写（`actor.ts:66`），且它已经进了**数据库列 `actor_type`**
与既有事件行。M3.5 让 `EntityKind` 采用同一套小写值，于是
`ActorRef.actorType` 与 `EntityRef.kind` 是**同一套字面量**，映射是恒等映射而不是翻译表。

若改用大写，就需要一张"大写 ↔ 小写"的对照表，而**任何一张手工对照表都会在
某天被漏写一个分支**——那正是 M3 反复强调的"字典是愿望"。
命名大小写不是语义问题，但它是**未来的 bug 来源**，因此选择零翻译。

### D2. 为什么"CharacterDomainEvent 的职责范围"做成**常量 + 校验**而不是新列

计划书第 42 节建议给 DomainEvent 增加 `scope`。M3 给 provenance 加列的理由是
「字典一定会漏写 / 写错键名」（`conversation-event.ts` 文件头）。
但那条理由在 `scope` 上**不成立**：M3.5 的 CharacterDomainEvent **恒为**
`CHARACTER_INTERNAL`，它是一个常量，不是数据。

给常量建列只会得到一个"永远同一个值、但理论上可以被写错"的列；
而常量 + 写入点校验反而更强：**写得出 `WORLD` 的地方在编译期与运行期都不存在**。
`'WORLD'` 仍然登记在 `DomainEventScope` 里（这样未来加 WorldEvent 时它已经有名有姓），
但 `assertCharacterInternalScope()` 会拒绝任何非 `CHARACTER_INTERNAL` 的值。

### D3. 为什么 `ObservationType` 用**封闭联合 + 已登记表**，而不是开放 `string`

计划书第 12 节要求"只写入文档和 extensible enum"。
`DomainEventType` 是 `string` + 登记表（`domain-event.ts:47`），M3.5 沿用同一模式：
已知值全部登记（CONVERSATION + 五种未来值），
`M3_5_PRODUCIBLE_OBSERVATION_TYPES` 只放 `CONVERSATION_OBSERVATION`。

计划书第 76 节（FC-T02）举例用了 `type=ENVIRONMENT_TEST` 这个字面量。
M3.5 **不**把它加进领域枚举 —— 为一个测试在生产枚举里塞一个假值，
会让"已登记的类型"这份清单失去意义。FC-T02 改用已登记的
`ENVIRONMENT_OBSERVATION`（它本来就是为"灯熄灭了"这类输入准备的），
测试标签放 `metadata.testTag`。**意图完全一致，污染为零。**

---

## 7. 审计结论 → WP 映射

| WP | 对应本文件条目 |
|---|---|
| WP2 EntityRef | D1（Adapter 方案） |
| WP3 Observation Contract | D2（输入边界） |
| WP4 CharacterIntent Contract | D3（输出边界） |
| WP5 Time / Trigger Compatibility | A1 / A2 / A3 / A4 / A5 / A6 + D4 |
| WP6 M4–M11 Future Constraints | N1 / N2 / N5 / N6（写成 `future-compatibility.md` 的约束表） |
| WP7 Compatibility Tests & Documentation | 全部条目对应的 FC-T01–T08 与 `m3.5:verify` |

**没有任何一条落在 `NEEDS_REWRITE`。** 这是 M3.5 可以"只加不改"的前提。

---

## 8. 怎么验证这份审计还成立

| 检查 | 由谁守 |
|---|---|
| 领域层仍然不依赖基础设施/Runtime/SQL | `kernel:test` → 「Kernel 边界（依赖方向）」 |
| `ActorRef` 的四种值仍是 EntityKind 的子集 | `m3.5:test` → FC-T01 |
| Kernel 仍能输出 `CharacterOutput` 而不是裸 string | `m3.5:test` → FC-T03 |
| 不存在世界/场景/NPC/调度器代码 | `m3.5:test` → FC-T04 的符号守卫 |
| 审计里登记的"未来边界"没有被偷偷实现 | `docs/architecture/future-compatibility.md` 的阶段对照表 + review |
| 审计结论本身没有过期 | 本文件随每个里程碑更新；若某条从 SAFE 变成 NOT_SAFE，必须写 ADR |
