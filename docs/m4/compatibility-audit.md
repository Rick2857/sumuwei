# M4 — M3.5 预留位消耗审计（WP1 交付物）

**阶段**：M4 — Reliable Long-Term Memory
**性质**：审计 + 设计裁定。本文件**只审计、不改代码**。
**前置**：M3.5 的 [`compatibility-audit.md`](../m3.5/compatibility-audit.md) 已经回答了
「当前地基里哪些地方把未来堵死了」；本文件回答下一句：
「**M4 真的去消费那些预留位时，够不够？**」
**基线 commit**：`31b9aa5`

> 与 M3.5 那份审计的关系：M3.5 是**往前看**（未来会不会被堵死），
> 本文件是**往后看**（现在真要用了，那个插座通电吗）。
> 因此判定标准不同——M3.5 用「够不够容纳未来」，本文件用
> 「**今天能不能真的跑起来**」。

---

## 0. 一句话结论

**M4 的七个消费点里，五个够用、一个需要加、一个需要新机制。**

真正需要新机制的那一条**不是缺字段，而是缺"一个概念不能再被一个对象表达"**：

```text
M2.5 的 Projection 假设：一个角色 = 一种投影 = 一行。
M4 的 Memory 需要：    一个角色 = 每条记忆各自一行 = N 行，各自独立乐观锁、独立重放。
```

这条不解决，M4 的 `rebuildMemory(memoryId)`（计划书第 73 节）就写不出来。
裁定见 §5 F1。

**没有任何一条要求推翻既有结构。** M4 仍然是"只加不改"。

---

## 1. 审计范围

对以下七个 M4 消费点逐一核对「计划书要求什么 → 现状提供什么 → 够不够」：

| # | M4 消费点 | 计划书节 | 消费的 M3.5 / M2.5 预留位 |
|---|---|---|---|
| F1 | Memory 当前状态如何持久化与重放 | 72–74 | `character_projections` / `ProjectionReducer` / `rebuildProjection` |
| F2 | 六种 `MEMORY_*` 领域事件如何登记 | 70–71 | `DomainEventRegistry` / `REGISTERED_DOMAIN_EVENT_TYPES` |
| F3 | Memory 提案的 `operation` 用什么词面 | 49 | `ProposalOperation` |
| F4 | Memory 写入的幂等键怎么算 | 68–69 | `computeIdempotencyKey()` / `idempotencyKeyFor()` |
| F5 | owner / subject / source 三者如何进 schema | 6–9、21 | `EntityRef` / `entityRefEquals` |
| F6 | 权威等级如何决定"能不能建用户事实" | 22–27、148 | `SourceAuthority` / `canSupportExternalFact()` / `canEvidenceExternalFact()` |
| F7 | 后台抽取的触发、水位与断点续跑 | 65、162–163 | `TriggerKind` / `CharacterJob` / `ProcessorWatermark` |

判定四类（沿用 M3.5 的口径，新增第五类）：

- `SAFE` —— 结构已经能容纳，**不修改**
- `NEEDS_ADDITIVE_CHANGE` —— 缺一个可选参数 / 一个登记项，改法是"加"
- `NEEDS_ADAPTER` —— 现有形状够用，但要在边界加一层转换，**不推翻原结构**
- `NEEDS_NEW_MACHINERY` —— **既有抽象的前提不成立**，需要一个新的、与既有并列的机制
- `DO_NOT_CHANGE_NOW` —— 当前零需求，只登记为未来边界

---

## 2. SAFE

| # | 对象 | 证据 | 为什么够用 |
|---|---|---|---|
| S1 | `EntityRef` 承载 owner / subjects / source | `entity.ts` `{ id: EntityId; kind: EntityKind }` + `entityRefEquals()` | 计划书第 6 节明确 **不得** 设计 `memory.userId`。`EntityRef` 自带 `kind`，因此"名字叫 kitchen 的角色"与"厨房这个地点"在数据上可区分——这正是 M3.5 留它的理由。M4 **一次都不需要**新的实体类型 |
| S2 | `SourceAuthority` 决定权威等级 | `source-authority.ts` 六种 + `canSupportExternalFact()`（白名单） | 计划书第 25–27 节的六级权威与它**同构**；白名单（而不是黑名单）保证"新权威默认不能建立外部事实" |
| S3 | `EventTime` 承载 `recordedAt` / `occurredAt` | `time.ts` + 迁移 0004 的两列 | 计划书第 37 节"严格沿用 M3.5"直接落地；"不知道"与"就是现在"在数据上已可区分 |
| S4 | 迁移框架 | `migrations.ts` 的 `MIGRATIONS` + `assertMigrationsWellFormed()` + `pendingMigrations()` | M4 追加 0005 即可，闸门与预览/应用两步流程零改动 |
| S5 | `TraceStepKind` 的开放联合 | `trace.ts` 末尾 `| (string & {})` | M4 的 13 个 step kind **不需要迁移**；`verify-m3-phoenix.ts` 用 `includes()` 校验，加性扩展不破它 |
| S6 | 数据库隔离与沙箱 | `src/dev/sandbox.ts` + `db/index.ts` 的写保护闸 | M4 的全部新测试直接沿用，不需要新的安全机制 |
| S7 | 遥测的"永不抛"镜像口 | `turn-gateway.ts` 的 `TelemetryMirror` | Memory trace 挂在同一个口上，后端离线不可能影响她的说话 |

---

## 3. NEEDS_ADDITIVE_CHANGE

### A1. `initKernel` 需要一个可选的 registry 注入点

**现状**：`kernel.ts:178` 硬编码 `createDefaultDomainEventRegistry()`，
其返回值只含 `TEST_CHARACTER_SIGNAL`。而 `KernelHandle.registry` 又被
`applyAcceptedEvents` 之外的路径间接依赖（`runDiagnosticProcessor` 用 `kernel.validator`）。

**M4 需要**：登记六种 `MEMORY_*`。

**为什么不能直接改 `createDefaultDomainEventRegistry()`**：
`scripts/kernel-tests.ts` 断言「未登记的 Domain Event 类型 → 拒绝」，
它拿的是默认 registry。往默认表里加六个类型**不改变这条断言的真值**
（它测的是"未登记的会被拒"，不是"表里只有一项"），
但它会让"默认表 = M2.5 最小诊断集"这个语义漂移，
而 M2.5/M3 的回归套件正建立在那个语义上。

**加法**：`InitKernelOptions` 增加一个可选字段

```ts
/** 领域事件类型登记表。缺省 = M2.5 的最小诊断集（既有行为逐字节不变） */
registry?: DomainEventRegistry
```

`initKernel` 内改为 `const registry = options.registry ?? createDefaultDomainEventRegistry()`。
新增 `createMemoryDomainEventRegistry()`（只含 `MEMORY_*`），
以及装配层用的 `createFullDomainEventRegistry()`（诊断 + Memory）。

**风险**：低。默认分支的行为与现在**完全一致**，
既有调用点（`main.ts:205`、`evals/harness/runner.ts:460`、若干 scripts）
一个都不用改。

**验证**：`m4:test` 断言「不传 registry → 与 M2.5 的 26 项基线一致」+
「传 Memory registry → `MEMORY_CREATED` 被接受、未登记类型仍被拒」。

---

## 4. NEEDS_ADAPTER

### D1. `SourceAuthority` → `MemoryAuthority` 是映射，不是等同

`source-authority.ts` 的六种（`USER_EXPLICIT` / `USER_REPLY_CONFIRMATION` /
`DIRECT_INTERACTION` / `TOOL_OBSERVATION` / `CHARACTER_GENERATION` / `SYSTEM_INSTRUCTION`）
与计划书第 25 节的六种（`EXPLICIT_CORRECTION` / `EXPLICIT_USER_STATEMENT` /
`DIRECT_INTERACTION` / `TOOL_OBSERVATION` / `CHARACTER_GENERATION` / `MODEL_INFERENCE`）
**不是一一对应**：

| M3 的 `SourceAuthority` | M4 的 `MemoryAuthority` | 说明 |
|---|---|---|
| `USER_EXPLICIT` | `EXPLICIT_USER_STATEMENT` | |
| `USER_REPLY_CONFIRMATION` | `EXPLICIT_USER_STATEMENT` | **两合一**：对用户事实而言，"明确陈述"与"回复确认"的证据强度同级 |
| `DIRECT_INTERACTION` | `DIRECT_INTERACTION` | 恒等 |
| `TOOL_OBSERVATION` | `TOOL_OBSERVATION` | 恒等 |
| `CHARACTER_GENERATION` | `CHARACTER_GENERATION` | 恒等 |
| `SYSTEM_INSTRUCTION` | **无对应** | ❌ **不允许**变成任何 MemoryAuthority |

**两条硬规则**：

1. **`EXPLICIT_CORRECTION` 不能从来源推导出来。** 它只能由
   §Phase 4 的显式纠正路径**授予**——即"用户说『你之前记错了』"这个动作，
   而不是"这句话来自用户"这个事实。把二者混起来会让任何用户陈述都能覆盖旧记忆。
2. **`SYSTEM_INSTRUCTION` 失败关闭。** 计划书第 84 节的例子是对的：
   系统提示"请以简洁方式回答"**不能**变成"苏沐薇记得有人曾要求自己简洁"。
   因此映射函数遇到它必须抛错，而不是回落到 `MODEL_INFERENCE`。

唯一实现处：`authorityFromSource(sourceAuthority, { isExplicitCorrection })`。

### D2. `CanonicalMemoryKey` 与 `contentFingerprint` 复用既有哈希风格

`job.ts` 的 `computeIdempotencyKey()` 用的是 FNV-1a 64 位风格手写摘要，
并留了明确理由（"不用 crypto：它在这里只是把长键压短，不是安全用途"）。

M4 的两个摘要（`canonicalKey` / `contentFingerprint`）**照抄这个形状**：
同一个 FNV-1a 实现，`stableMaterial()` 做确定性序列化（对象键排序）
后再摘要。**不引 crypto、不引第三方哈希库**。

**风险**：低。但有一个必须写进文档的后果：
**FNV-1a 不是抗碰撞哈希**，两个人可能撞键。在 Memory 这个规模下可接受
（撞键的后果是"被当成同一槽位"，由 §Phase 6 的第二、三层继续判），
但**不能**把它当作安全边界或跨租户隔离手段。

---

## 5. NEEDS_NEW_MACHINERY

### F1（核心裁定）：`character_projections` 无法表达"一个角色 N 条独立可重放的记忆"

这是本次审计里唯一一条**前提不成立**的发现，必须写清楚。

#### 现状的事实

`projection.ts` 的形状决定了三件事：

```ts
interface CharacterProjection<TState> {
  characterId: CharacterId
  projectionType: string          // ← 作用域标识
  revision: number                // ← 乐观锁
  reducerVersion: string
  lastDomainEventId?: DomainEventId
  lastDomainEventSequence?: number
  state: TState
}
```

`event-store.ts` 的 `applyAcceptedEvents()` 与 `rebuildProjection()` 都建立在一个假设上：

> **`(characterId, projectionType)` 唯一确定一行。**
> 注释里写得很明确："需要按用户区分的投影把 userId 编进来，例如
> `relationship:user:<uuid>`；不需要区分的就是 `character:self`。"

#### M4 需要的形状

计划书第 72–74 节要求：

```text
MemoryRecord = 当前 Memory Projection
rebuildMemory(memoryId)             ← 单条记忆独立重放
rebuildCharacterMemories(ownerId)   ← 整个 Memory Space 重建
```

也就是：**一个角色下 N 条记忆，每条各自一行、各自 `revision`、各自独立重放。**

#### 两个可以想到的"塞进 character_projections"的写法，都不成立

**写法甲：`projectionType = 'memory:' + memoryId`**（每记忆一行）

看起来对，但 `rebuildProjection(db, characterId, reducer)` 传入的 `reducer`
必须有**编译期常量** `projectionType`（`ProjectionReducer.projectionType` 是 `readonly`）。
于是要么每次重建现造一个 reducer 对象（`createMemoryReducer(memoryId)`）——
这其实**可行**；要么放弃。

**写法乙：`projectionType = 'memory'`**（一个角色一行，state 是 `Record<memoryId, MemoryRecord>`）

这会**毁掉 M4 最重要的性质**：所有记忆共享一个 `revision`，
于是"改记忆 A"会让"记忆 B 的重放基准"失效，
`rebuildMemory(id)` 退化成"重建全部再取一条"。
而且 `defaultIsStale()` 按 `sequence` 单调判定是**角色级**的，
多条记忆的写入会互相判成"过时"。

#### 裁定

**M4 新建 `memory_records` 作为它自己的权威投影表，并自建 `revision` 乐观锁；
不套用 `character_projections` / `applyEvent` / `rebuildProjection`。**

具体形状：

```text
memory_records
  id                 text primary key      ← 内存 id（`mem:<characterId>:<n>`）
  owner_kind/owner_id text                 ← EntityRef
  memory_type         text
  content_kind/content jsonb
  epistemic_status    text
  authority           text
  importance          real
  confidence          real
  status              text
  canonical_key       text
  content_fingerprint text
  valid_from/valid_until bigint
  occurred_at/recorded_at bigint
  superseded_by       text
  processor/processor_version text
  reducer_version        text not null     ← 「这行是用哪个版本的 reducer 算出来的」
  revision               integer not null default 0   ← 乐观锁
  schema_version         integer not null
  created_at/updated_at  bigint not null
```

三个配套表（各自单一职责，不冗余）：

| 表 | 职责 | 对应计划书 |
|---|---|---|
| `memory_subject_links` | 一条记忆 → N 个 subject（`subjects: EntityRef[]` 的关系化） | 第 8 节 |
| `memory_evidence_links` | 一条记忆 → N 个 `EvidenceRef`，并标 `is_root` | 第 9、157、158 节 |
| `memory_events` | 一条记忆 → 它的全部领域事件，**按序** | 第 73 节（`rebuildMemory` 的输入） |

**`memory_events` 这张表是必须的，不是冗余**：计划书第 155 节说
"若 Domain Event 已统一保存，不一定需要 `memory_events` 独立表"——
但那是**在只有 `rebuildCharacterMemories` 需求的前提下**成立的。
一旦要有 `rebuildMemory(memoryId)`，就必须能**只取一条记忆的事件**。
`character_domain_events` 里没有 `memory_id` 列（给 append-only 历史表加列
违背 M3.5 的"只加 nullable 列、且不进 UPDATE"精神，且 memoryId 是 payload 内部信息），
而"扫全表 jsonpath"既慢又脆。因此用一张**纯索引表**（不存业务数据，
只存 `(memory_id, domain_event_id, kind, created_at)`）把这件事做成 O(log n)。

#### 与既有机制的关系（必须写清楚，避免被认为是"另起一套"）

| 既有机制 | M4 是否复用 | 理由 |
|---|---|---|
| `character_domain_events` | ✅ **完全复用** | 它仍然是 Memory 变化的**唯一事实来源**。Memory 可重放的依据就是它 |
| `processed_operations` | ✅ **完全复用** | 幂等的最终裁判 |
| `DomainEventRegistry` | ✅ 复用（见 §3 A1） | 类型登记 |
| `DomainPolicyValidator` | ⚠️ **部分复用，见 §6 F4** | 它的幂等键推导不适用于"一批候选 → N 条记忆" |
| `character_jobs` / `processor_watermarks` | ✅ 完全复用 | 后台抽取 |
| `character_projections` | ❌ **不复用** | 见上面的裁定 |
| `applyEvent()` / `rebuildProjection()` | ❌ **不复用**，但**照抄它的乐观锁形状** | `saveProjection()` 的做法（先读 → 带 `revision` 条件写 → `returning` 确认影响行数）在 `memory-store.ts` 里重写一份，语义一致 |

**"照抄乐观锁形状"这句话要落到代码里**：`memory-store.ts` 的写路径必须
与 `saveProjection` 一样**先读后带条件写再确认影响行数**，
且失败时抛 `revision_conflict`（沿用 `KernelErrorKind`，不发明新的错误种类）。

**风险与代价**：

- 代价：M4 有两套投影机制（`character_projections` 给角色级单例，
  `memory_records` 给每条记忆）。这是**真实的多余**，必须在
  `memory-backend-contract.md` 与 ADR 里写明，不能让后来者以为它们可以合并。
- 缓解：两者的**语义**是一致的（投影是缓存、可重建、带 reducer 版本），
  因此将来若要统一，统一的是存储而不是概念。

---

## 6. NEEDS_ADDITIVE_CHANGE（续）

### F2. 六种 `MEMORY_*` 的登记与 payload 契约

计划书第 70 节列了六种，其中 `MEMORY_RESTORED` 明确"可以先定义但不一定需要 UI"。

**M4 全部登记并全部实现**（含 `RESTORED`）。理由：
`RESTORED` 是 `RETRACTED` 的逆操作，而"用户说『我记错了，其实是对的』"
在真实对话里会发生；只登记不实现会留下一条**写着但不能用**的路径，
而"写了等于做了"正是 M3.5 审计反复点名的陷阱。

payload 契约（每个类型一个 `validatePayload`，沿用 `DomainEventTypeSpec`）：

| 类型 | payload 关键字段 |
|---|---|
| `MEMORY_CREATED` | `memoryId` / `record`（完整首版快照）/ `mutation`（显式还是后台） |
| `MEMORY_MERGED` | `winnerId` / `loserIds[]` / `reason` |
| `MEMORY_SUPERSEDED` | `memoryId` / `supersededBy` / `validUntil` / `reason` |
| `MEMORY_RETRACTED` | `memoryId` / `reason`（`explicit_forget` / `explicit_correction` / `audit`） |
| `MEMORY_DISPUTED` | `memoryId` / `conflictingMemoryIds[]` / `evidence` |
| `MEMORY_RESTORED` | `memoryId` / `reason` |

`maxPayloadBytes`：`MEMORY_CREATED` 带完整快照，给 **32 KiB**；
其余给 **4 KiB**（沿用既有兜底值）。

### F3. `ProposalOperation` 够用，但 M4 只用其中的五个

`proposal.ts` 已有 `create / update / supersede / retract / delete / merge / reinforce`。

计划书第 49 节的 `PolicyDecision` 是 `CREATE / MERGE / SUPERSEDE / RETRACT / MARK_DISPUTED / REJECT`。

**映射**：

| PolicyDecision | 领域事件 | `operation` |
|---|---|---|
| `CREATE` | `MEMORY_CREATED` | `create` |
| `MERGE` | `MEMORY_MERGED` | `merge` |
| `SUPERSEDE` | `MEMORY_SUPERSEDED` | `supersede` |
| `RETRACT` | `MEMORY_RETRACTED` | `retract` |
| `MARK_DISPUTED` | `MEMORY_DISPUTED` | ⚠️ **无对应** |
| `REJECT` | （无事件） | — |

`MARK_DISPUTED` 没有对应的 `ProposalOperation`。

**裁定：给 `ProposalOperation` 加一个 `dispute` 值。**

理由不是"看着整齐"，而是 `operation` 进幂等键
（`computeIdempotencyKey` 的第五个分量）。两个不同的 `PolicyDecision`
算出**同一个幂等键**会让"重试"与"新操作"无法区分——
这正是 `proposal.ts` 注释里写的、它必须是受控枚举的原因。

用 `update` 代替 `dispute` 会有两个后果：
① `MEMORY_DISPUTED` 与"普通内容更新"在幂等层不可区分；
② 未来 M9 Belief 的 `DISPUTED` 也无词可用。

**`delete` 与 `reinforce` M4 不使用**（`delete` 是"删除原始数据"，
计划书第 58–59 节明确它是数据治理问题、M4 默认不做；
`reinforce` 属于 M9 之后的"证据加强"，M4 不实现）。

**风险**：低。`ProposalOperation` 是联合类型，加一个值不改任何既有代码路径。

### F4（重要）：`idempotencyKeyFor()` 对 Memory 路径是错的

**现状**：

```ts
// proposal.ts / validator.ts 调用它
idempotencyKeyFor(proposal) →
  computeIdempotencyKey({ characterId, processor, processorVersion,
                          sourceFromSequence: min(源事件序号),
                          sourceToSequence:   max(源事件序号),
                          operation: target.operation })
```

**问题**：幂等键里**没有"这是哪条记忆"这个分量**。

一次后台抽取会从**同一段事件区间**产出**多条**候选（计划书第 43 节：
"未来的 Memory Extractor 一轮对话常常同时产出多条候选"）。
若这批候选都以 `operation='create'` 提交，
`idempotencyKeyFor()` 会给它们算出**同一个键**。

后果是致命的，而且**失败方式是静默的**：

```text
同一批事件里的 3 条记忆，第 1 条成功写入后，
`processed_operations` 记下了那个键；
第 2、3 条提交时，Validator 的幂等检查命中 → 判为 duplicate_operation → 被丢弃。
系统看起来"一切正常"，但那两条记忆**永远丢失了**。
```

这不是理论问题：`processed_operations` 的主键是 `idempotency_key`，
而 `character_domain_events` 上还有 `idempotency_key` 的**唯一约束**
（`character_domain_events_idempotency_unique`），
所以就算绕过 Validator 也会在写库时撞唯一键。

**裁定：M4 不使用 `DomainPolicyValidator.validate()` 作为 Memory 的放行口，
而是新建 `MemoryMutationValidator`。**

这是一个**刻意的重复**，必须说明理由，否则会被认为是"两套校验"：

| 关注点 | `DomainPolicyValidator` | `MemoryMutationValidator` |
|---|---|---|
| 来源事件存在性 + 归属 | ✅ 复用它的两个查询口 | 同（共用 `ProposalSourceLookup`） |
| payload 上限 | ✅ 复用 | 同（共用 registry 的 `maxPayloadBytes`） |
| scope 必须是 `CHARACTER_INTERNAL` | ✅ 复用 `assertCharacterInternalScope` | 同 |
| **幂等键推导** | ❌ **不适用**（见上） | ✅ **按 (memoryId, operation) 算** |
| **权威是否够建用户事实** | ❌ 它没有这个概念 | ✅ `assertMemoryAuthorityAllows()` |
| **证据是否带根** | ❌ | ✅ `assertMemoryEvidence()` |
| **值不值得记** | ❌ | ✅ Value Gate |

**新的幂等键**：

```text
computeIdempotencyKey({
  characterId,
  processor, processorVersion,
  sourceFromSequence, sourceToSequence,   // 仍然编进键：不同批次的同一条事实是新操作
  operation: `${operation}:${memoryId}`,  // ← 加 discriminator
})
```

`memoryId` 由候选**确定性**派生（`makeMemoryId(characterId, seq)` 里 seq 取
候选在其批次内的稳定序号 + 规范化后的槽位键），
因此**同一批事件 + 同一 processor 版本重跑 → 同一个 memoryId → 同一个幂等键**，
而同一批里的不同候选**各自不同**。幂等的两层（本表 + Validator）因此同时成立：

1. 同一条事实重跑 → 撞键 → 静默跳过（正确）
2. 同一批里不同事实 → 键不同 → 都能写入（修正）

**风险**：中。这是 M4 最容易做错的一处，因此它必须有**专门的测试**：
`m4:test` 断言「同一批事件里的 3 条候选 → 3 个不同的幂等键 → 3 条记忆」
与「同一批重跑 → 仍是 3 条、不新增」。

### F7. `trigger_kind = conversation` 够用；水位需要"补洞"而不是"单调覆盖"

**触发**：`assertTriggerEnabledInM3_5()` 只允许 `conversation` / `system`。
M4 的 `MemoryExtractionJob` 由 assistant 事件提交后触发 → `conversation` ✅ 够用。
**不改这个守卫**（计划书第 65 节明确要求 `triggerKind = conversation`）。

**水位**：`assertWatermarkAdvances()` **只允许前进**（回退会重复处理）。

计划书第 162–163 节的场景：

```text
Job A = [100,105]  失败
Job B = [106,110]  成功 → 水位推进到 110
Job A = [100,105]  重试成功 → 想推进到 105，但 105 < 110 → assertWatermarkAdvances 抛错
```

这不是水位机制的缺陷，而是**它的定义**：水位表示"它之前全部完成"，所以
110 在 100–105 没完成时**本来就该是 100–105 的结果**，而现在变成 110 是错的。

**裁定：水位由"无洞前缀"驱动，不由"已完成的最大值"驱动。**

```text
advanceWatermarkTo(characterId, processor, version) 的实现：
  1. 取所有 completed 的 job 区间（按 source_from_sequence 升序）
  2. 从 1 开始找**连续覆盖**的前缀（能接上就没有洞）
  3. 只把水位推进到那个前缀的末端
  4. 没有洞时，等价于"已完成的最大 toSequence"
```

这样：
- Job B 单独成功 → 前缀在 100 处断开（100–105 未完成）→ 水位**停在原处**，不误报"110 已处理"；
- Job A 重试成功 → 前缀连续到 110 → 水位一次推进到 110。

**`assertWatermarkAdvances` 一个字都不改**——它仍然拒绝回退，
只是现在**传入的值本身就不会回退**。

**风险**：低，但有一个必须处理的边界：
**"没有洞"的判定需要 job 区间从 1 开始连续**。
真实库的 `character_jobs` 可能为空（新角色），此时前缀为 0，水位不推进。

---

## 7. DO_NOT_CHANGE_NOW

| # | 对象 | 证据 | 为什么 M4 不动 | 归属 |
|---|---|---|---|---|
| N1 | `context.ts` 的 `'memory'` section kind 与 `memory: 40` 优先级 | `context.ts:47 / :73` | 计划书第 0、3 节：M4 不做召回、不做注入。这个枚举**保持登记、保持无人产出** | M5 |
| N2 | `character_traces.selected_memory_ids` | 迁移 0002 就在，永远 `[]` | M5 才填。M4 用 `steps[].attributes` 记 `memory.*`（计划书第 110 节） | M5 |
| N3 | `PerspectiveOwnerId` | `entity.ts:194` 只有类型别名 | M4 不实现 Perspective。`MemoryRecord.owner` 是 `EntityRef`，与它同源但不同概念 | M9 |
| N4 | `MemoryIndexPort` | 计划书第 91 节：第一版允许 `NoopMemoryIndex` | M4 **定义接口 + 提供 Noop**，不实现向量/混合检索 | M5 |
| N5 | `Commitment` 类型 | 计划书第 15 节明确不加入 | M4 可以"以 Episode 保存这次互动"，但不建 Commitment Engine | M10 |
| N6 | `relationship relevance` / `emotional salience` / `goal relevance` | 计划书第 51 节明确不加 | `evaluateImportance()` 只综合四项 | 对应模块出现时 |
| N7 | Graphiti / 向量库 | 计划书第 86 节"不接生产" | M4 只借 temporal/provenance **思想**，不引依赖 | M5+ PoC |
| N8 | ElizaOS 自带 `memories` 表 | `db/index.ts:182` 启动自检要求它存在 | 它是**消息表**（`type='message'`），与 M4 的 `memory_records` 无关 | 永不合并 |

---

## 8. 审计中做出的四个判断（写进 ADR）

### J1. 为什么 Memory 不套用 `character_projections`（→ ADR-023 / ADR-026）

见 §5 F1。一句话：**既有抽象的前提（一个角色一种投影一行）与 M4 的需求
（每条记忆各自一行、各自重放）不兼容**，而强行兼容会毁掉 M4 最重要的可重放性质。

### J2. 为什么新建 `MemoryMutationValidator` 而不是改 `DomainPolicyValidator`（→ ADR-020）

见 §6 F4。一句话：**`DomainPolicyValidator` 的幂等键推导在多候选场景下会静默丢数据**，
而那个缺陷不会报错、只会少记——这正是本项目最不能接受的一类缺陷。

改 `DomainPolicyValidator` 本身不可行：它被 M2.5/M3 的提案链路使用，
其幂等语义是"一个提案 = 一个工作单元"，
而 Memory 抽取是"一个批次 = N 个独立工作单元"。两者是不同的工作单元定义。

### J3. 为什么给 `ProposalOperation` 加 `dispute`（→ ADR-024）

见 §6 F3。一句话：**`operation` 进幂等键**，
用 `update` 代替会让"标记为争议"与"内容更新"在幂等层不可区分。

### J4. 为什么 `SYSTEM_INSTRUCTION` 不能映射成任何 `MemoryAuthority`（→ ADR-029）

见 §4 D1。一句话：系统提示"请简洁回答"不能变成"她记得有人要求过自己简洁"
（计划书第 84 节），这条与"assistant 输出不能建立用户事实"是同一条铁律的两个方向。

---

## 9. 审计结论 → M4 Phase 映射

| 条目 | 判定 | 落到哪个 Phase |
|---|---|---|
| S1–S7 | `SAFE` | 全部：直接用，不修改 |
| A1 registry 注入点 | `NEEDS_ADDITIVE_CHANGE` | Phase 2 |
| D1 权威映射 | `NEEDS_ADAPTER` | Phase 2 + Phase 5 |
| D2 FNV-1a 摘要 | `NEEDS_ADAPTER` | Phase 2 |
| **F1 Memory 自己的投影表** | **`NEEDS_NEW_MACHINERY`** | **Phase 3** |
| F2 六种事件登记 | `NEEDS_ADDITIVE_CHANGE` | Phase 2 |
| F3 `dispute` 操作值 | `NEEDS_ADDITIVE_CHANGE` | Phase 2 |
| **F4 Memory 自己的幂等键与放行口** | **`NEEDS_ADDITIVE_CHANGE`（高风险）** | **Phase 3 + Phase 6** |
| F7 水位补洞 | `NEEDS_ADAPTER` | Phase 5 |
| N1–N8 | `DO_NOT_CHANGE_NOW` | 全部：不实现，写文档 |

**没有任何一条落在 `NEEDS_REWRITE`。** M4 可以"只加不改"——
加四张新表、加一个 registry 工厂、加一个 validator、
加一个操作枚举值、加一个水位推进函数。既有的 267 项基线不动。

---

## 11. 审阅记录（实现完成后的回看）

审阅按"不预设自己做对了"的方式逐条核对实现，**实证**抓出三处缺陷
（详见提交 `59f1e67` 与 `verify-m4-persistence.ts` §3.5）：

| # | 缺陷 | 与本审计的关系 |
|---|---|---|
| R1 | `recordedAt` 取自校验时刻而非事件时刻，同一行出现 `recordedAt > createdAt` | **本审计没覆盖到**：F1 只审了"投影放哪儿"，没审"快照里哪些字段会被 reducer 覆盖" |
| R2 | 同一事实从不同证据抽到两次时，第二次的 `MEMORY_CREATED` 带的是**第一条**的快照，事件流与证据对不上 | **本审计覆盖了但判轻了**：§6 F4 只说了"幂等键要带 discriminator"，没说"重复创建时快照该用谁的"。去重第一层（计划书第 75 节）落地后才真正关闭 |
| R3 | `createMemoryCandidate` 直接改写调用方的 `content` 对象 | **本审计没覆盖到**：它是纯代码卫生问题，契约审计看不出来 |

### Phase 4（显式路径）实现后新增的记录

四处缺陷，都是**测试全绿时不存在、但要靠具体语料才暴露**的：

| # | 缺陷 | 为什么危险 |
|---|---|---|
| P4-1 | 抽取器的规则匹配按**表的书写顺序**，于是 `education.institution` 被 `education.status` 永久遮蔽 —— 任何含"大学"的句子都被记成 `undergraduate` | 不报错、不丢事实，只是**记错了**（"她的学校是示科"→"她在读本科"） |
| P4-2 | 抽取器的"取值在线索词之前"分支把线索词切掉了 —— `示例工程科技大学` 被抽成 `示例工程科技` | 少两个字，长度合理、不报错，只是**学校名字不对** |
| P4-3 | `parseChoiceIndex` 用 `/\d+/`，于是模型回答 `-1` 被解析成"选了第 1 条" | **否定被读成肯定**（与"不要再记"被读成"记住"同一个形状） |
| P4-4 | `correct` 规则的关键词漏了计划书第 175 节原句里的 `改一下` | 不丢事实，但把这句最常见的纠正**静默降级**成模型分类路径 |

P4-1 / P4-2 / P4-3 的共性：**它们都不报错**，只让数据错或者让快路径降级。
这正是 M4 反复强调的那类缺陷——所以每一条都补了断言，而不是改完就算。

### 两个由用户裁定的边界（2026-09-16）

**决定 1：陈述式告知不写入。**

「我们现在上的大学是示例工程科技大学」这种**没有指令词**的告知，
不会被显式路径捕获（规则不命中 → 分类器缺省不调模型 → 无意图）。
用户选择**保持这条边界**，而不是把陈述也当作显式意图。

理由（用户选定）：把陈述算作显式意图等于取消"显式"与"闲聊"的界限，
而记忆一旦写入就不可回溯修正。这类"从日常对话里自动发现值得记的事"
属于后台抽取路径（计划书第 63 节），那条路径的开关默认关闭。

**这条要写进 `memory-lifecycle.md`**，否则将来会有人把它当成缺陷去"修"。

**决定 2：目标解析接语义判别器。**

"忘掉我上大学这件事"不带槽位键时会退化成 subject 模糊匹配，
于是回报 `target_ambiguous`（用户被追问"哪一条"）。
用户选择**接上判别器**（计划书第 57 节的第 5 级本来就允许），
而不是让它报歧义。

已实现：`LlmSemanticJudge`（生产，调模型）+ `LexicalSemanticJudge`（离线，词面唯一命中）。
两个前置条件由 `createTargetMemoryResolver` 保证：
候选数 ≤ 5、且只在第 4 步打分分不出胜负时才调用 —— 因此它**不是**每条消息的固定开销。
判别器返回候选集外的 id 会**抛错**（不接受它凭空决定一条记忆）。

另外修正一处**本审计自己的数字错误**：

`0005` 迁移的注释里写"真实库里的 86 条对话事件"，而 Phase 1 的实测是 **8 条**。
那个 86 是写注释时凭印象打的，没有经过任何实测核对。

教训与 M3.5 那条 `schemaVersion === 4` 完全相同：
**文档与注释里的数字要么来自实测、要么必须标注是估值。**
一个未经核对的数字一旦被写下来，后来的人就会把它当事实引用
（这一个已经在**两个文件**里出现过：迁移注释，以及本文件 §1 的说明）。
现在两处都已按 Phase 1 的实测数字改正。

---

## 10. 怎么验证这份审计还成立

| 检查 | 由谁守 |
|---|---|
| 不传 registry 时 M2.5 行为逐字节不变 | `m4:test` + `pnpm kernel:test`（26 项） |
| `MEMORY_CREATED` 被接受、未登记类型仍被拒 | `m4:test` |
| `EXPLICIT_CORRECTION` 不能由"来源是用户"推导出来 | `m4:test` §权威 |
| `SYSTEM_INSTRUCTION` → 抛错（不是回落） | `m4:test` §权威 |
| **同一批事件里 N 条候选 → N 个不同幂等键 → N 条记忆** | `m4:test` §幂等（这是 F4 的守卫） |
| **同一批重跑 → 条数不变** | `m4:verify` §幂等 |
| `rebuildMemory(id)` 只取该条记忆的事件 | `m4:verify` §重放 |
| 水位在"中间有洞"时不误报 | `m4:verify` §水位补洞 |
| M4 没有实现自动召回 | `m4:test` §边界（`'memory'` section 仍无人产出） |
| 审计条目没有过期 | 本文件随每个 M4 Phase 更新；某条从 SAFE 变成别的必须写 ADR |
