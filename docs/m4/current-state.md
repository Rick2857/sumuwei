# M4 开工现状盘点（WP1 前置交付物）

**阶段**：M4 — Reliable Long-Term Memory
**性质**：只读盘点。本文件不改任何代码、不改任何数据。
**前置**：M3.5 — Future Extension Compatibility 已完成并收口
**基线 commit**：`31b9aa5`（`m3.5(docs): 兼容性审计 / 5 篇架构文档 / ADR-013~019 / 两份架构笔记 / 验收报告`）
**分支**：`main`，工作区干净，**无任何 M4 代码**
**一句话结论**：M4 是**从零开始**——`Memory` 这一整套（契约 / 表 / 端口 / 处理器 / 测试）全都不存在；
而它需要复用的地基（EntityRef / SourceAuthority / EventTime / DomainEventRegistry / Job / Watermark / Trace / 迁移框架 / 沙箱隔离）**全部就位**。

> 这份盘点的用途不是"总结得好看"，而是让 M4 的每一步都能回答
> 「我是加在什么东西上面的、它现在真实的样子是什么」。
> 因此下面每一个数字都是**本次实测**，每一条"不存在"都给出了搜索证据。

---

## 1. schema 现状

### 1.1 迁移版本：**4**

`src/infrastructure/persistence/migrations.ts` 的 `MIGRATIONS` 为 `0001..0004`，
`assertMigrationsWellFormed()` 强制版本从 1 起**严格连续**。

| 版本 | name | 内容 |
|---|---|---|
| 0001 | `m2-character-state-tables` | M2 的 `character_states` / `state_events`（登记为迁移，语义不变） |
| 0002 | `m2.5-character-kernel` | Kernel 六张 + 可靠性三张 + 状态两张 |
| 0003 | `m3-identity-and-conversation-integrity` | Seed 结构化 / Seed 历史 / 用户身份 / 会话身份 / 事件 provenance 扩列 |
| 0004 | `m3.5-future-extension-compatibility` | 时间两列 ×2 表 / `trigger_kind` / trace 四个语义槽 |

**对 M4 的含义**：M4 的迁移编号必须是 **0005**，且必须是**只增**（计划书第 199 节：
"新 Schema 必须全部使用正式 Migration，而不是偷偷改变"）。

### 1.2 真实库实测（在**副本**上读，真实库未被打开写入）

跑法：`npx tsx scripts/inspect-production-copy.ts`
（该脚本自身 `cpSync` 到临时目录后再读，见 `scripts/inspect-production-copy.ts` 文件头）

```text
总表数：34
迁移版本：4
  #1 m2-character-state-tables            @ 2026/9/16 08:41:33
  #2 m2.5-character-kernel                @ 2026/9/16 08:41:33
  #3 m3-identity-and-conversation-integrity  @ 2026/9/16 15:57:14
  #4 m3.5-future-extension-compatibility     @ 2026/9/16 18:26:36
✅ M2.5 的十张表全部存在
✅ M3 的四张新表也都在（迁移 0003 已应用）
✅ Seed 结构化表示已装载（v3）
```

**她的真实数据**（这就是 M4 要建立长期记忆的那份历史）：

| 表 | 条数 | 说明 |
|---|---|---|
| `memories`（`type='messages'`） | 6 | M1/M2 路径的原文，"她能记得的" |
| `character_states` | 1 | M2 的情绪/关系快照 |
| `conversation_events` | 8 | M2.5 事实账本（**append-only**） |
| `character_domain_events` | 2 | M2.5 变化历史 |
| `character_projections` | 1 | 诊断投影 |
| `character_traces` | 2 | 运行证据 |
| `user_identities` | 1 | M3 稳定身份 |
| `user_identity_mappings` | 1 | transport → UserId |
| `conversation_identities` | 1 | 会话 ↔ 参与者 |
| `character_definition_versions` | 1 | Seed 历史 |

**两条对 M4 有直接影响的观察**：

1. **真实历史很短（8 条对话事件），但有真实数据**。
   含义：M4 的 Gate（计划书第 217 节"随机抽数十条正式 Memory 人工审计"）
   在真实库上**今天抽不出数十条**。因此审计对象必须是
   ①`evals/m4` 场景在沙箱里产出的记忆 + ②真实库随日常使用增长的部分。
   这一点必须在验收报告里如实写明，不能用沙箱数据冒充实库数据。

2. **`character_domain_events` 目前只有 2 条**，两条都来自诊断处理器
   （`TEST_CHARACTER_SIGNAL`）。M4 的 `MEMORY_*` 会是这张表里**第一批有业务语义**的事件。

### 1.3 M4 需要的表：**全部不存在**

| 计划书要求的表 | 现状 | 证据 |
|---|---|---|
| `memory_records` | **不存在** | 全仓 `grep -i memori` 只命中 ElizaOS 自带的 `memories` 表与注释 |
| `memory_evidence_links` | **不存在** | 同上 |
| `memory_events`（若需要） | **不存在**，且计划书第 155 节说"若 Domain Event 已统一保存，不一定需要独立表" | 同上 |

> ⚠️ **一个必须写下来的坑**：`src/db/index.ts` 的启动自检要求
> `agents / memories / rooms / participants / entities / worlds` 六张表存在，
> 其中 `memories` 是 **ElizaOS 自己的消息表**（1.7.2 把消息统一放在 `memories`，按 `type='message'` 区分）。
>
> **M4 的 `memory_records` 与它没有任何关系**，不得复用、不得 JOIN、不得把它当作 Memory Store。
> 这条要写进 `memory-backend-contract.md`，否则半年后一定会有人把它们混起来。

---

## 2. 代码现状

### 2.1 M4 要复用的地基：全部就位

| 能力 | 位置 | 现状 |
|---|---|---|
| 通用实体引用 `EntityRef` | `src/kernel/contracts/entity.ts` | ✅ `entityRef()` / `entityRefEquals()` / `entityLabel()` / `fromActor()` / `toActorRef()` |
| 实体种类 | 同上 | ✅ 9 种登记（4 种启用 + 5 种仅登记），`M3_5_RESERVED_ENTITY_KINDS` 明确"登记了但没有产出" |
| 来源权威 `SourceAuthority` | `src/kernel/contracts/source-authority.ts` | ✅ 6 种 + `canSupportExternalFact()` 白名单 + `resolveAuthority()` |
| 事件时间 `EventTime` | `src/kernel/contracts/time.ts` | ✅ `recordedAt` / `occurredAt` / `logicalTime`（后者 M3.5 拒绝非空） |
| 领域事件登记表 | `src/kernel/contracts/domain-event.ts` | ✅ `DomainEventRegistry` 是**工厂**而非单例（S2，M3.5 审计结论） |
| 提案契约 | `src/kernel/contracts/proposal.ts` | ✅ `operation` 已含 `create/update/supersede/retract/delete/merge/reinforce`（**正是 M4 需要的词面**） |
| 唯一放行口 | `src/kernel/policies/validator.ts` | ✅ 失败关闭、幂等双保险、payload 上限、allowlist |
| 变更链 | `src/infrastructure/persistence/event-store.ts` | ✅ `applyAcceptedEvents()` 单事务：序号 → 插事件 → 幂等记录 → 纯 reduce → 乐观锁写投影 |
| Job / 幂等 / 水位 | `job-store.ts` + `contracts/job.ts` | ✅ 三张表齐备；`computeIdempotencyKey()` 已把 `processorVersion` 编进键 |
| Trace | `contracts/trace.ts` + `trace-store.ts` | ✅ `TraceStepKind` 末尾是 `| (string & {})`，**新增 step kind 不需要迁移**（M3.5 审计 S5） |
| 遥测镜像 | `turn-gateway.ts` 的 `TelemetryMirror` | ✅ 三个永不抛的方法；"遥测挂了不可能传播成异常"是类型层保证 |
| 数据库隔离 | `src/dev/sandbox.ts` | ✅ 三层：默认临时目录 + 真实库路径硬拒绝 + `resetPluginSqlConnection()` 清 PGlite 单例 |
| 迁移闸 | `src/db/index.ts` | ✅ 真实库有待应用迁移时**普通命令拒绝启动**，必须 `pnpm migrate` → `pnpm migrate:apply` |

### 2.2 M4 需要的代码：**全部不存在**

| 计划书要求 | 现状 | 搜索证据 |
|---|---|---|
| `MemoryStorePort` | **不存在** | `grep -i "MemoryStorePort\|memoryStore"` 在 `src/` 下 **0 命中** |
| `MemoryIndexPort` | **不存在** | 同上 |
| `MemoryRecord` / `MemoryCandidate` / `EvidenceRef` / `CanonicalMemoryKey` | **不存在** | `src/kernel/contracts/` 下无 `memory*.ts` |
| `MEMORY_*` 领域事件类型 | **未登记** | `REGISTERED_DOMAIN_EVENT_TYPES = [DIAGNOSTIC_SIGNAL]`，只有 `TEST_CHARACTER_SIGNAL` |
| Memory Reducer / 投影 | **不存在** | `src/kernel/projections/` 下只有 `diagnostic.ts` |
| Explicit / Background Memory 路径 | **不存在** | `src/kernel/app/` 下无 memory 目录 |
| Memory Admin CLI | **不存在** | `src/main.ts` 的 `argv.includes('--…')` 列表里没有 memory 相关项 |
| `evals/m4/` | **不存在** | `evals/` 下只有 `scenarios/` `harness/` `m3/` `m3.5/` `promptfoo/` `fixtures/` |

### 2.3 三个"名字在、实现不在"的位置（最容易误判的地方）

这三处**必须在审计里点名**，否则实现时会以为"已经有了"。

| 位置 | 实际是什么 | 对 M4 的含义 |
|---|---|---|
| `src/kernel/contracts/context.ts:47` `'memory'` section kind，`:73` `memory: 40` 优先级 | **只有枚举值与优先级**，没有任何 provider 产出它 | M4 **不实现**注入（那是 M5）。这个枚举保持登记、保持无人产出，由 `m4:test` 断言"M4 没有新增 memory section" |
| `character_traces.selected_memory_ids`（迁移 0002 就在） | **列存在，永远是 `[]`** | M4 **不填它**。M5 才填。M4 若要记录"这条 trace 相关的 memory"，用 `steps[].attributes`（计划书第 110 节的 `memory.*` 属性） |
| `src/kernel/contracts/entity.ts:194` `PerspectiveOwnerId` | **只有类型别名 + 注释**，没有 store | M4 的 `MemoryRecord.owner` 是 `EntityRef`，与 `PerspectiveOwnerId` **同源但不等同**（后者是 M9 的概念）。M4 不实现 Perspective |

### 2.4 一个重要的实测结论：`canEvidenceExternalFact()` 从未在生产路径被调用

```text
命中位置（非测试）：
  src/kernel/contracts/conversation-event.ts:363   ← 定义处
  src/kernel/contracts/source-authority.ts:202     ← canSupportExternalFact 定义处
命中位置（测试 / 评测）：
  evals/scenarios/sc-002-assistant-is-not-user.ts
  evals/m3/suites/assistant-fabrication.ts
  evals/m3/runtime/support.ts:251
  scripts/kernel-tests.ts / scripts/kernel-tests-conversation.ts
```

**M4 的 Memory Extractor 会是它的第一个生产调用者。**

这条值得写下来，因为它正好落在 M3.5 审计那条老教训上——
**"声明了字段"不等于"字段会被用到"**（`conversation-event.ts` 文件头记录的
`repliedToSourceKind` 真实缺陷：声明了、传了、忘了转发，于是正确值只活在内存里）。
因此 M4 的 Source Firewall **不能只写注释说"我们调用了它"**，
必须有一条断言直接检查"用 character 事件当证据的候选被拒绝"。

---

## 3. 测试基线（本次实测，全部退出码 0）

M4 的任何改动都不得让下列数字退化。这是 M4 的**回归地板**。

| 套件 | 命令 | 基线 | 耗时 |
|---|---|---|---|
| 类型与依赖方向 | `npx tsc --noEmit` | ✅ 0 错 | — |
| M2.5 域契约 | `npx tsx scripts/kernel-tests.ts` | **26 / 26** | 9ms |
| M3 身份完整性 | `npx tsx scripts/kernel-tests-identity.ts` | **25 / 25** | 4ms |
| M3 对话完整性 | `npx tsx scripts/kernel-tests-conversation.ts` | **47 / 47** | 2ms |
| M2.5 Phase C | `npx tsx scripts/verify-phase-c.ts` | **25 / 25** | — |
| M3 持久化 | `npx tsx scripts/verify-m3-persistence.ts` | **67 / 67** | — |
| 迁移闸 | `npx tsx scripts/verify-migrate-gate.ts` | **17 / 17** | — |
| M3.5 未来兼容 | `npx tsx scripts/future-compat-tests.ts` | **30 / 30** | 16ms |
| M3.5 持久化 | `npx tsx scripts/verify-m3.5-persistence.ts` | **30 / 30** | — |
| **合计（离线确定性部分）** | | **267 项** | 秒级 |

**两条与基线有关的硬约束**：

1. **FC-T08（prompt 逐字节回归）必须保持绿**。
   `evals/fixtures/m3.5/prompt-baseline.txt` 是逐字节基线，
   而 M4 会增加 trace step（`steps` 是 JSON，不进 prompt）。
   只要 M4 **不碰** `context/sections.ts` 与 `ContextCompiler`，
   这条基线就不该变。若因任何原因需要重固化，
   必须**单独提交**并在验收报告写明"为什么 prompt 必须变"——
   沿用 M3.5 `f478185`（CRLF 误报那次）的处理方式。

2. **`m3:migrate-gate` 的 17 项包含"副本上迁移被自动应用"与"真实库路径被拦"两个方向**。
   M4 加迁移 0005 之后，这条必须仍然全绿——
   它是"schema 升级是显式动作"这条规矩的守卫。

---

## 4. 真实库的操作约束（M4 Phase 1 要处理的）

### 4.1 迁移闸

真实库 `data/pglite` 当前 **schema v4**，而 M4 会把它推到 **v5**。
按现有规矩：

```text
pnpm chat / --inspect / --seed-status …   → 发现待应用迁移 → 拒绝启动，指向 pnpm migrate
pnpm migrate                              → 只读预览，不写库
pnpm migrate:apply                        → 真正应用
```

**因此 M4 不会在"某次随手启动"里悄悄改真实库 schema。** 这是 M3 那次事故换来的规矩，继续有效。

### 4.2 备份

计划书第 200–201 节要求 M4 开始建立正式的 backup / export / restore 程序。
现状里已有一个先例：`data/pglite.backup-m3.5-20260916-182624`。

**M4 Phase 1 的动作**：
1. 确认无进程占用真实库目录（检查 `postmaster.pid` 与 node 进程）。
2. 按同一命名法生成 `data/pglite.backup-m4-<YYYYMMDD-HHmmss>`。
3. 把备份路径与大小记进本文件。

### 4.2.1 Phase 1 已执行的结果

```text
执行时间 : 2026-09-16 18:46:27
备份路径 : data/pglite.backup-m4-20260916-184627
大小     : 1155 文件 / 29.1 MB（与源库逐项一致）
```

**占用判定**：`data/pglite/postmaster.pid` 首行是 `-42`，
该 pid 不存在；机器上运行中的 node 进程只有 DSH Web（3080）、
记忆核心 watchdog / web（7999）与本次命令自己。
**结论：无进程占用真实库**，可以安全复制。

**备份可读性已实测通过**（跑法：`npx tsx scripts/verify-m4-backup.ts`）：

```text
备份可读性：8 通过 / 0 失败
  ✅ 备份可以打开，且能读出 schema 版本           — schema v4
  ✅ schema 版本 = 4（与备份前的真实库一致）
  ✅ 四个迁移记录齐全
  ✅ Kernel 十张 + M3 四张表全部存在               — 34 张表
  ✅ 事实账本非空（她的历史在备份里）              — 8 条对话事件
  ✅ Seed 历史非空
  ✅ 能读出具体事件正文（证明内容未损坏）          — #1 [user] 你好，又是新的一天…
  ✅ Seed 结构化表示与指纹都在                     — v3 947686bde031…
```

> **为什么"复制了 1155 个文件"还不够**：PGlite 是嵌入式 Postgres，
> 数据文件、WAL 与 `pg_control` 必须自洽。**在数据库运行期间复制**、
> 或复制了一个陈旧的 `postmaster.pid`，都可能得到一个字节数完全正确、
> 但打不开的备份。备份的唯一用途是"出事了能回到过去"，
> 因此它必须在**需要它之前**就被证明可读。
>
> `scripts/verify-m4-backup.ts` 的设计刻意做成了"不碰真实库、也不碰原备份"：
> 它把备份**再复制一份**到临时目录，在副本上打开，因此
> 验证动作本身不会污染留底。


### 4.3 一个实测观察（不是故障，但要知道）

`data/pglite/postmaster.pid` 存在，内容首行是 pid、第二行是 `/tmp/pglite/base`。
该路径是**可移植性产物**（库曾经在别处被创建或复制过），
PGlite 启动时会自行处理，本轮只读体检已证明它能正常打开。

**含义**：判断"有没有进程占着真实库"时**不能只看这个文件存在与否**，
必须结合"文件里的 pid 是否还活着"与"是否有 node 进程在跑"一起判断。
M4 Phase 1 会按这个口径判断。

---

## 5. 这份盘点怎么验证还成立

| 检查 | 由谁守 |
|---|---|
| 迁移版本仍是"从 1 起严格连续" | `migrations.ts` 的 `assertMigrationsWellFormed()`（启动即跑） |
| M4 的表是**新增**的，没有偷偷改既有表 | `m4:verify` §迁移（比对 `memory_*` 表存在 + 既有表列未变） |
| `memory_records` 与 ElizaOS 的 `memories` 没有混用 | `m4:verify` §后端契约（断言 M4 的读路径不出现 `from memories`） |
| M4 没有实现自动召回 | `m4:test` 断言 `context.ts` 的 `'memory'` section 仍无人产出、`selectedMemoryIds` 仍为 `[]` |
| 上面的测试基线没有退化 | `pnpm m3.5:ci` 必须保持退出码 0 |
| 本文件的数字没有过期 | 每次 M4 提交前重跑一次并更新（本文件是清单，不是历史文档） |

---

## 6. 结论 → Phase 映射

| M4 Phase | 本文件提供的依据 |
|---|---|
| Phase 1 备份 | §4.1 / §4.2 / §4.3 |
| Phase 2 Domain Model | §2.1（EntityRef / SourceAuthority / EventTime 就位）、§2.2（契约不存在） |
| Phase 3 Event/Reducer/Store + 迁移 0005 | §1.1（下一个版本号是 0005）、§1.3（表全不存在）、§2.3（三个"名字在实现不在"的位置） |
| Phase 4 Explicit | §2.1（`operation` 词面已覆盖）、§2.2（路径不存在） |
| Phase 5 Background | §2.4（`canEvidenceExternalFact` 从未被生产调用——M4 是第一个用户） |
| Phase 8 Trace & Eval | §3（回归地板）、§2.3（`selectedMemoryIds` 不填） |
| Phase 12 Gate | §1.2 的观察 1（真实库记忆条数不足以独立满足"抽数十条"审计） |
