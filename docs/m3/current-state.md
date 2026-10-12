# M3 — Current State Audit（WP1）

**阶段**：M3 — Identity & Conversation Integrity
**性质**：WP1 Gate 的交付物。本文件只回答一件事：**M3 开工时，地基实际长什么样。**
**前置**：M2.5 Architecture Foundation 已通过 Gate（见 [`../milestones/M2.5-verification.md`](../milestones/M2.5-verification.md)）
**基线 commit**：`70ea753`

---

## 0. 一句话

M2.5 建好的是"铁路"：事件账本、提案链、可重放投影、上下文单入口、Trace。
**铁路上目前只跑了一列货车**（诊断计数器，`counterDelta=1`），没有任何真正的角色能力。

M3 要做的是让**身份**与**真实对话**这两样东西第一次沿这条铁路运行，
并且在此之前先回答计划书第 0 节那九个问题。

---

## 1. M2.5 Gate 状态（M3 开工基线）

| 套件 | 基线结果 |
|---|---|
| `pnpm typecheck` | pass |
| `pnpm kernel:test` | 26/26 |
| `pnpm kernel:verify` | 25/25 |
| `pnpm eval:scenarios`（SC-001~007） | 7/7（33 条断言） |
| `pnpm eval:telemetry` | 54/54 |
| `pnpm eval:otlp` | 21/21 |
| `pnpm eval:dryrun` | 15/15 |
| `pnpm eval:providers` | 11/11 |
| `pnpm eval:promptfoo` | 7 passed (100%) |
| 生产库 schema | v2；`conversation_events` = 4（用户 2 / 她 2，已回填） |

> ⚠️ **开工时发现并已修的环境缺陷**：`package.json` 里全部脚本写的是
> `node_modules/.bin/tsx`。这是 POSIX 写法，在本机 cmd.exe 下**全部失败**
> （`'node_modules' is not recognized as an internal or external command`）。
> M2.5 当时的验收因此无法按 README 的命令复现。
> 已改为直接写 `tsx` / `promptfoo`（pnpm 会把 `node_modules/.bin` 放进 PATH）。
> 这是**环境修复**，不是架构改动。

---

## 2. 可以直接复用的组件（M3 不重写）

| 已有 | 位置 | M3 怎么用 |
|---|---|---|
| `ConversationEvent` + 序号分配 | `kernel/contracts/conversation-event.ts`、`persistence/conversation-store.ts` | 直接扩展（加 actor/tool、sourceKind、provenance），不改 append-only 语义 |
| `createConversationEvent` 的来源一致性校验 | 同上 | 复用，并作为 WP5/WP6 的第一道闸 |
| `ConversationLedgerPort` 的**事实实现** | `persistence/conversation-store.ts` | WP5 把它提升为**契约层端口**（现在只有实现，没有接口） |
| `ContextCompiler` + section 优先级/预算机制 | `kernel/contracts/context.ts` | 直接复用；M3 只加 section 与 version，不改排序/裁剪算法 |
| `CharacterRunTrace` + `character_traces` 表 | `kernel/contracts/trace.ts` | 直接扩展（加 identity 字段与 steps 种类） |
| `TelemetryPort` / Phoenix / Noop | `infrastructure/telemetry/` | 直接复用，只加 span |
| `Proposal → Validator → DomainEvent → Reducer → Projection` | `kernel/policies/validator.ts` 等 | **M3 一行不改**（M3 不新增认知数据） |
| 三层数据库隔离防护 | `src/dev/sandbox.ts`、`src/db/index.ts` | 所有 M3 测试脚本必须照样遵守 |
| `kernel-test-kit`（零依赖断言器） | `scripts/kernel-test-kit.ts` | M3 全部新测试用它 |
| canonical 场景 schema + 内外两个 runner | `evals/harness/`、`evals/promptfoo/` | M3 评测套件的**唯一**接入方式 |

---

## 3. 需要扩展的 Schema

### 3.1 `character_definitions`（现在只有 4 个自由文本列）

现状（迁移 0002）：

```sql
identity text, personality_baseline text, communication_style text, seed_extras jsonb
```

问题：M3 的 Seed 必须**结构化**（trait/strength/behavioral_examples/counter_examples、
value/priority/tradeoff_notes、boundaries、preferences），并对规范化内容算 hash。
四个自由文本列无法承载，也无法算"这次到底改了哪一条"。

M3 的处理：

```sql
alter table character_definitions
  add column definition_json jsonb,        -- CharacterDefinition v2 的规范化真源
  add column seed_hash text,               -- canonical JSON → sha256
  add column definition_schema_version integer not null default 1
```

旧的 4 个文本列**保留**（`renderSeedIdentity` 的既有投影仍读它们，
`SC-001` 的逐字节稳定性不受影响），但 `definition_json` 是新的**权威表示**，
两者由同一份 v2 定义**派生**，不允许各自手工维护。

新增 `character_definition_versions`（计划书第 124 节：Seed 也要保留历史版本）：

```sql
character_definition_versions(character_id, seed_version, seed_hash, definition_json, created_at)
```

> 为什么必须现在建：M11 的 Adaptive Self 出现后，"她变了"有三种可能
> （真的成长 / 开发者改 Seed / 模型漂移）。没有 Seed 历史，这三种无法区分。

### 3.2 `conversation_events`（来源与归属信息不足）

现状：

```sql
actor_type text   -- 'user' | 'character' | 'system'  ← 缺 tool
metadata jsonb    -- 自由字典：source / userId / traceId / modelProfile 混在一起
```

M3 需要的是**结构化 provenance**，而不是"往 metadata 里再塞一个键"：

```sql
alter table conversation_events
  add column source_kind   text,   -- user_statement | character_output | system_instruction | tool_output
  add column source_authority text, -- USER_EXPLICIT | ... | CHARACTER_GENERATION | SYSTEM_INSTRUCTION
  add column epistemic_source text, -- user_report | character_generation | system_instruction | tool_observation
  add column delivery_status  text, -- generated | delivered | failed （计划书第 37 节）
  add column event_schema_version integer not null default 1,
  add column reply_to_event_id ... -- 已存在，M3 起强制校验存在性与同会话性
```

> ⚠️ 刻意**不**把 provenance 塞进 `metadata`：一旦它是自由字典，
> 就一定会出现"某个模块忘了写""某个模块写错键名"，而 M4 的 Memory 会
> 把这些半成品当权威来源。列是契约，字典是愿望。

### 3.3 新增两张身份表

```sql
user_identities          -- UserId 是稳定身份；transport 身份（qq/discord/…）只是映射
conversation_identities  -- ConversationId ↔ (characterId, userId)，可替换
```

对应计划书第 7/8/25 节：**transport identity ≠ domain identity**。

---

## 4. 需要新增的 Service

| 新增 | 层 | 职责（严格限定） |
|---|---|---|
| `CharacterIdentityService` | application | `getDefinition` / `getSeedVersion` / `validateCharacterExists` / `buildIdentitySnapshot` / `listSeedVersions` |
| `SeedAdminPath` | application | **唯一**的 Seed 写入口（普通聊天路径拿不到它） |
| `MessageNormalizer` | domain（纯函数） | `NormalizedConversationInput` ← 任意 transport 形状 |
| `ActorResolver` | domain + infrastructure | external identity → `UserId`；不碰人格 |
| `ConversationIntegrityService` | application | append 前置校验：sequence / actor / reply graph / 会话归属 |
| `ConversationLedgerPort` | domain（接口） | 把已有的仓储实现提升为端口，业务代码只能从这里写事件 |
| `SourceFirewall` | domain（纯函数） | `SourceKind` / `SourceAuthority` / 升级规则 |
| `IdentityContextProvider` | domain（纯函数） | Seed → ContextSection（`identity-core`） |
| `IntegrityRulesProvider` | domain（纯函数） | 固定短规则 → ContextSection（`integrity-rules`） |

---

## 5. 现有 Prompt 拼接点（必须收敛到单入口）

M3 开工时通往模型的路有**两条**：

| 路径 | 入口 | 状态 |
|---|---|---|
| 新链路（ContextCompiler v1） | `kernel/context/sections.ts` → `composePromptFromPacket` | **默认 on**（`CHARACTER_CONTEXT_COMPILER_V1`） |
| 旧链路（M1 composeState + messageHandlerTemplate） | `context/builder.ts` → `buildTurnContext` | `=0` 时生效，或 `--dump-prompt --legacy` 对照 |

**结论（WP1 Gate 的关键判定）**：

- 默认配置下**只有一条**活跃路径，且它就是 ContextCompiler。→ 满足 WP7 的前提。
- 旧链路保留，但 M3 必须让它**不可被无意启用**：`--dump-prompt --legacy` 只读，
  且 Trace 里 `contextCompilerVersion` 会写成 `legacy-composeState`（已实现），
  因此"某轮绕过了编译器"在数据上可被发现。
- **没有发现第三条或未知的第二人格来源**（见下节）。

---

## 6. 现有人格来源（单一真源审计）

| 来源 | 位置 | M3 处置 |
|---|---|---|
| `src/character/苏沐薇.ts` | ElizaOS `Character`（bio/adjectives/style/topics） | **保留为唯一的人写源**；它经 `seed-projection.ts` 投影成领域 Seed |
| `src/character/index.ts` | 导出上者 | 同上 |
| `src/kernel/identity/seed.ts` | 领域侧 Seed 构造与 `SEED_VERSION` | M3 升级为 v2 结构化构造器 |
| `character_definitions` 表 | 持久化 Seed | 唯一长期真源（启动时由代码投影写入，版本只升不降） |
| `src/state/provider.ts` 的 CHARACTER_STATE | **状态**，不是人格 | 不属 Seed（铁律：状态 ≠ 人格） |
| bootstrap 的 `CHARACTER` provider | ElizaOS 从 `character` 对象自动生成 | ⚠️ **潜在第二人格源**：它不经过我们的 ContextCompiler |

### 6.1 ⚠️ 唯一的真实风险点（必须写进 M3 验收）

旧链路（`composeState`）会把 ElizaOS 的 `CHARACTER` provider 输出拼进 prompt，
而那是**从同一个 `character` 对象生成的另一份人格文本**。它现在不活跃
（默认走新链路），但只要 `CHARACTER_CONTEXT_COMPILER_V1=0`，M3 的全部身份保证立刻失效。

M3 的处置（不删旧链路，因为它是对照能力）：

1. `docs/m3/identity-model.md` 明确写出"旧链路不提供 M3 的身份保证"。
2. 新增可执行检查：**默认配置下每轮 Trace 的 `contextCompilerVersion` 必须是
   `context-compiler@2`**，否则该套件失败（SC-M3 场景之一）。
3. `--dump-prompt --legacy` 输出里加一行显式警告。

---

## 7. 现有 Event 入口（写入事实账本的路径）

| 入口 | 位置 | 写的 actorType |
|---|---|---|
| `ConversationRecorder.recordUserMessage` | `infrastructure/runtime/conversation-recorder.ts` | `user` |
| `ConversationRecorder.recordAssistantMessage` | 同上 | `character` |
| `ConversationRecorder.recordSystemEvent` | 同上 | `system` |
| `applyBackfill`（历史回填） | `persistence/backfill.ts` | `user` / `character` |
| 直接调用 `appendConversationEvent` | 仓储导出 | **任意**（M3 要收口） |

M3 的处置：`appendConversationEvent` 降级为**基础设施内部**函数，
业务侧只能经 `ConversationLedgerPort`（计划书第 79 节），
且该端口**不接受** `type`/`actorType`/`sourceKind` 的自由组合——
它只接受"用户说了话""她说了话""系统通知""工具返回"四种具名操作。

---

## 8. WP1 Gate 判定

| Gate 条件 | 结论 |
|---|---|
| M2.5 Gate 仍然全绿 | ✅（见 §1；脚本路径缺陷已修后全部可复现） |
| 现有入口已找到 | ✅（§5 两条 Prompt 路径；§7 五个事件入口） |
| 现有人格来源已找到 | ✅（§6 六个来源，单一真源已确认） |
| 没有未知第二 Prompt source | ✅ 结构上只有两条路径，且默认只活跃一条；§6.1 的 ElizaOS `CHARACTER` provider 是**已知**风险，已列处置 |

**WP1 通过。** 可以进入 WP2。
