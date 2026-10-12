# 身份模型（Identity Model）

**阶段**：M3 — Identity & Conversation Integrity
**回答的问题**：**"谁是苏沐薇？"在系统里到底由什么回答。**
**相关**：[ADR-007](../adr/ADR-007-seed-identity-as-canonical.md)、
[ADR-010](../adr/ADR-010-versioned-seed-identity.md)、[seed-versioning.md](./seed-versioning.md)

---

## 1. 四层身份，四种生命周期

计划书第 5 节要求把身份分层，因为把它们混成一个 `name` 会带来
一类具体退化：**"重启后她还在吗"变成"那行记录还在吗"，
"换个设备还认识我吗"变成"换个 room id 就变成陌生人"。**

| 层 | 标识 | 生命周期 | 谁在改它 |
|---|---|---|---|
| CharacterIdentity | `CharacterId`（`00000000-…-0001`） | **永久** | 只有人（写代码） |
| UserIdentity | `UserId`（推导 UUID） | **永久** | 只有身份映射（一次性的） |
| ConversationIdentity | `ConversationId` | **可替换** | 建新会话时 |
| RuntimeIdentity | `RuntimeId`（`runtime_20260916_1a2b3c`） | **一次进程** | 每次启动 |

四条硬规则：

1. **`RuntimeId` 绝不作为 CharacterId 或 UserId。**
   类型上它有自己的名字（`RuntimeId`），且没有任何转换函数 ——
   想混用必须显式 cast，于是 review 时看得见。

2. **`UserId` 不随 Session / transport 变化。**
   计划书第 7 节的原文理由：
   > 否则 M4 会把 user facts 错误绑定到 session。

3. **`ConversationId` 可替换，且换它不换人。**
   计划书第 8 节：`CharacterId = stable`、`UserId = stable`、
   `ConversationId = replaceable`。

4. **transport 身份不是领域身份。**
   `qq_id` / `discord_user_id` / `websocket_connection_id` 只进
   `metadata.transportActorId`，必须**显式**经过一次
   `external_identity → UserId` 的解析。

---

## 2. 数据落点

```text
character_definitions             ← Seed Identity（唯一真源）
character_definition_versions     ← Seed 历史（不覆盖）
user_identities                   ← UserId（稳定）
user_identity_mappings            ← (transport, external_id) → UserId
conversation_identities           ← ConversationId → (CharacterId, UserId)
```

### 2.1 为什么 `user_identity_mappings` 的主键是 `(transport, external_id)`

**不是** `external_id`。原因很具体：QQ 的 `12345` 与 Discord 的 `12345`
是**两个人**。把 `external_id` 单独当主键会让两个平台的用户合并成一个人，
而"合并"这件事一旦写进事实账本（append-only）**撤不回来**。

### 2.2 为什么映射表只增不改

`bindTransportIdentity` 用 `on conflict do nothing`：
一个 transport 身份一旦绑定到某个 UserId 就**不换人**。

允许改绑的后果：历史上属于 A 的事实会突然属于 B，
而账本里没有任何痕迹说明这次改绑发生过。

---

## 3. 身份解析（ActorResolver）

```text
raw.sender.externalId  ──┐
                         ├─► 1. 查 user_identity_mappings（权威）
raw.transport          ──┘   2. 没命中 → 确定性推导 + 写入映射
                             3. 都没有 → 抛 actor_unresolved
```

三个设计点：

1. **推导规则是注入的，不是内联的。**
   M1/M2 用 `stringToUuid('user-Alex')` 推导 userId。M3 沿用**同一套规则**
   （装配层把那个函数传进来），因此既有数据不需要迁移 ——
   老消息里的 userId 与新事件里的 userId 是同一个值。
   换一套推导规则等于把用户变成另一个人。

2. **推导结果会立刻写进映射表。** 这把"推导"变成"一次性的决定"：
   以后即使推导规则变了，已有用户的身份也不会跟着变。

3. **解析失败就抛错，不猜。** 看不到 externalId 又没有已绑定映射时拒绝解析。
   凭空造一个 UserId 会把"同一个人的两段历史"**永久**劈成两半。

### 3.1 会话归属的一致性检查

`ensureConversation` 在 ConversationId 已存在时检查
`(characterId, userId)` 是否一致，不一致直接抛 `participant_mismatch`。

为什么是硬错误而不是"覆盖一下"：会话 id 冲突意味着两条不同的对话历史
会被写进同一个坐标，而事实账本 append-only —— 覆盖之后无法分辨哪条属于谁。

---

## 4. 身份如何进入每一轮

```text
启动
  └─ initKernel()
       ├─ upsertCharacterDefinition()      ← 三道写闸（见 seed-versioning.md）
       ├─ CharacterIdentityService         ← 唯一身份读取入口
       └─ buildIdentitySnapshot()          ← 一轮一次，冻结
              │
              ▼
        IdentitySnapshot { characterId, seedVersion, definition, snapshotHash }
              │
              ├──► TurnGateway（构造 Trace：seed_version / seed_hash / identity_source_refs）
              ├──► buildContextCompilerV2（identity-core section）
              ├──► CharacterRunTrace（每一轮都记）
              └──► 评测（确定性断言）
```

### 4.1 为什么是"快照"而不是"读定义"

计划书第 75 节：
> 每轮不要让 Context Compiler 自己随意查询多个表。

`IdentitySnapshot` 是不可变的，因此同一轮里的 Context Compiler、Trace、
评测看到的是**同一份**身份 —— 这消除了"上下文用的是 v2，trace 记的是 v3"
这类最难查的不一致。

### 4.2 快照的三道检查（失败关闭）

```text
1. 角色必须存在
      → character_not_found（**不静默降级成通用助手**，计划书第 148 节）

2. 快照内部自洽（版本号 / 角色 id / 有指纹）
      → identity_snapshot_version_mismatch
      → identity_snapshot_character_mismatch
      → identity_snapshot_missing_hash

3. 库里的内容指纹 == 库里记录的指纹
      → seed_hash_mismatch（**这是读取闸**，见 ADR-010）
```

第 3 条是 M3 新增的。写入闸只能拦"经过代码的写入"，
有人直接 `UPDATE character_definitions` 时它完全看不见 ——
而那正是"她怎么悄悄变了"最可能的形态。

---

## 5. 每一轮 Trace 里的身份字段

计划书第 122 节说得直接：

> 以后模型回答异常，第一时间检查：用的是不是错误 Seed。

因此 `character_traces` 表有：

```text
seed_version          ← 这一轮用的是哪一版
seed_hash             ← 这一轮读到的**具体内容**的指纹
identity_source_refs  ← ["character-definition:sumuwei@2"]
runtime_id            ← 哪一次程序运行（只用于诊断）
user_id               ← 稳定用户身份（不是 Session）
conversation_id       ← 本轮所属会话
```

以及计划书第 71 节的 run tree：

```text
character.run
├── message_normalize
├── actor_resolve
├── conversation_persist_input     ← 先落 Event，再调模型
├── identity_load                  ← Seed 在哪一步被读进来
├── context_compile
├── model_generate
├── output_validate
├── conversation_persist_output
└── transport_deliver              （CLI 下就是"打印出来"）
```

---

## 6. 如何自查（只读命令）

```bash
pnpm exec tsx src/main.ts --seed-status     # Seed 版本 / 指纹 / 历史 / 与代码比对
pnpm exec tsx src/main.ts --kernel-status   # 身份快照 + 账本 + 投影 + 最近 trace
pnpm exec tsx src/main.ts --dump-prompt     # 她这一轮真正看到的完整 prompt（含身份 section）
```

三个命令都**完全只读**：不写 Seed、不写历史、不推进任何时间戳。

---

## 7. 身份相关的不变量与守它的测试

| 不变量 | 守它的测试 |
|---|---|
| CharacterId 不随重启/会话/模型变化 | `kernel-tests-identity.ts`、`verify-m3-persistence.ts` T1 |
| UserId 不随会话变化 | `verify-m3-persistence.ts` T2 |
| 新增会话不产生新角色/新用户 | 同上 |
| transport 身份不冒充领域身份 | `kernel-tests-conversation.ts`（归一化） |
| 同一 (transport, externalId) 恒定解析到同一 UserId | `verify-m3-persistence.ts` §5 |
| 身份 section 每轮都在且不可裁 | `eval:scenarios` SC-001 / SC-006 + 跨场景不变量 |
| 缺 Seed 时启动失败而不是降级 | `kernel-tests-identity.ts`（`character_not_found` 分支） |
| 域层不 import ElizaOS | `pnpm kernel:test` 依赖方向检查 |
