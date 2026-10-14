/**
 * 版本化迁移。
 *
 * ============================================================================
 *  M2.5 计划书第 60 节：所有新持久结构必须通过 Migration
 * ============================================================================
 * 禁止在应用启动时"随意 CREATE / ALTER"。
 *
 * 与既有做法的关系：
 *   · `src/state/repository.ts` 用的是 `create table if not exists` 的
 *     **幂等 DDL**（M2 的产物）。它安全但**没有历史**——没人知道
 *     它是什么时候建的、改过没有。
 *   · 这里引入 `character_schema_migrations` 表记录"执行过哪些迁移"。
 *     因此迁移 0001 的内容正好是既有那两张表的 DDL（`if not exists`，
 *     对已有库是空操作），这样**新旧库都能得到同一个最终 schema**，
 *     而旧库不会因为缺少记录而被重复执行。
 *
 * 为什么用原生 SQL 而不是 ORM schema：
 *   与既有一致 —— drizzle-orm 在本项目只是传递依赖，不能直接 import 表定义
 *   （见 src/state/repository.ts 顶部注释）。原生 DDL 语义一眼可读，
 *   也不受插件小版本影响。
 *
 * ⚠️ 迁移是**只增不改**的：已经发布过的迁移文件不许再改内容，
 *    需要改就新增一个版本号。
 */

import { KernelError } from '../../kernel/contracts/index.ts'
/* ⚠️ 0010 的 DDL **逐字复用**它（**不复制**）⇒ 迁移与拥有它的模块**不会漂开**。
   ⚠️ 必须从**叶子模块**取（2026-09-30）：从 `memory-semantic-index.ts` 取会牵出
   `db.ts → migrations.ts` 的环，而本文件的 `MIGRATION_0010` 是**模块级**对象字面量
   ⇒ 只要入口先加载那个模块就会 TDZ（实测 `pnpm m9.5:test` 整道门跑不起来）。 */
import { SEMANTIC_INDEX_DDL } from './semantic-index-ddl.ts'

/** 一条迁移：版本号必须严格递增，且一旦发布不许修改内容 */
export interface Migration {
  version: number
  name: string
  /** 依次执行的语句（幂等 DDL，允许在已存在的库上安全执行） */
  statements: string[]
}

/**
 * 0001 —— M2 已有的两张自研表（登记为迁移，语义不变）。
 */
const MIGRATION_0001: Migration = {
  version: 1,
  name: 'm2-character-state-tables',
  statements: [
    `create table if not exists character_states (
       character_id        text        not null,
       user_id             text        not null,
       valence             double precision not null default 0,
       arousal             double precision not null default 0,
       trust               double precision not null default 0,
       closeness           double precision not null default 0,
       version             integer     not null default 0,
       last_interaction_at bigint      not null,
       created_at          bigint      not null,
       updated_at          bigint      not null,
       primary key (character_id, user_id)
     )`,
    `create table if not exists state_events (
       id                text        primary key,
       character_id      text        not null,
       user_id           text        not null,
       before_state      jsonb       not null,
       delta             jsonb       not null,
       after_state       jsonb       not null,
       reason            text        not null,
       trigger           text        not null,
       state_version     integer     not null,
       message_id        text,
       created_at        bigint      not null
     )`,
    `create index if not exists state_events_lookup
       on state_events (character_id, user_id, created_at desc)`,
  ],
}

/**
 * 0002 —— M2.5 Character Kernel 的六张核心表 + 三张可靠性表。
 *
 * 与 plan 第 61/85 节的对应关系：
 *   character_definitions        CharacterDefinition（Seed Identity）
 *   conversation_events          ConversationEvent（事实账本，append-only）
 *   character_domain_events      DomainEvent（角色变化历史）
 *   character_projections        Projection（可重放的当前状态）
 *   character_jobs               Job（后台处理契约）
 *   character_traces             Trace / Receipt
 *   character_sequence_counters  单调序号分配器（**可信持久层**）
 *   processed_operations         幂等存储
 *   processor_watermarks         高水位
 *
 * Proposal 是否持久化：M2.5 不强制（plan 第 61 节）。proposal 只活在
 * 一次处理的内存里；**它的结论**（DomainEvent）才是长期数据。
 */
const MIGRATION_0002: Migration = {
  version: 2,
  name: 'm2.5-character-kernel',
  statements: [
    // ---- Seed Identity ----------------------------------------------------
    `create table if not exists character_definitions (
       id             text    primary key,
       slug           text    not null,
       name           text    not null,
       seed_version   integer not null,
       identity       text    not null,
       personality_baseline text not null,
       communication_style  text not null,
       seed_extras    jsonb,
       schema_version integer not null,
       created_at     bigint  not null,
       updated_at     bigint  not null
     )`,

    // ---- 事实账本 ---------------------------------------------------------
    `create table if not exists conversation_events (
       id                   text    primary key,
       character_id         text    not null,
       conversation_id      text    not null,
       sequence             integer not null,
       conversation_sequence integer not null,
       type                 text    not null,
       actor_type           text    not null,
       actor_id             text,
       content              text    not null,
       reply_to_event_id    text,
       metadata             jsonb,
       schema_version       integer not null,
       created_at           bigint  not null,
       constraint conversation_events_character_sequence_unique
         unique (character_id, sequence)
     )`,
    `create index if not exists conversation_events_conversation_lookup
       on conversation_events (conversation_id, sequence)`,
    `create index if not exists conversation_events_created_at
       on conversation_events (created_at)`,
    `create index if not exists conversation_events_actor
       on conversation_events (character_id, actor_type, sequence)`,

    // ---- 变化历史 ---------------------------------------------------------
    // source_conversation_event_ids 用 jsonb 数组存原始引用（保持"复数来源"语义），
    // 同时把**主来源**（第一条）冗余成列，让 (source_event) 索引可用（plan 第 63 节）。
    `create table if not exists character_domain_events (
       id                          text    primary key,
       character_id                text    not null,
       sequence                    integer not null,
       type                        text    not null,
       source_conversation_event_ids jsonb  not null,
       primary_source_event_id     text    not null,
       caused_by_domain_event_ids  jsonb,
       payload                     jsonb   not null,
       processor                   text    not null,
       processor_version           text    not null,
       idempotency_key             text    not null,
       schema_version              integer not null,
       created_at                  bigint  not null,
       constraint character_domain_events_character_sequence_unique
         unique (character_id, sequence),
       constraint character_domain_events_idempotency_unique
         unique (idempotency_key)
     )`,
    `create index if not exists character_domain_events_created_at
       on character_domain_events (character_id, created_at)`,
    `create index if not exists character_domain_events_type
       on character_domain_events (character_id, type)`,
    `create index if not exists character_domain_events_source
       on character_domain_events (primary_source_event_id)`,

    // ---- 当前状态（缓存，可重建）------------------------------------------
    `create table if not exists character_projections (
       character_id             text    not null,
       projection_type          text    not null,
       revision                 integer not null,
       reducer_version          text    not null,
       last_domain_event_id     text,
       last_domain_event_sequence integer,
       state                    jsonb   not null,
       updated_at               bigint  not null,
       primary key (character_id, projection_type)
     )`,

    // ---- 后台任务 ---------------------------------------------------------
    `create table if not exists character_jobs (
       id                  text    primary key,
       character_id        text    not null,
       processor           text    not null,
       processor_version   text    not null,
       source_from_sequence integer not null,
       source_to_sequence   integer not null,
       idempotency_key     text    not null,
       status              text    not null,
       retry_count         integer not null default 0,
       last_error          text,
       created_at          bigint  not null,
       started_at          bigint,
       finished_at         bigint
     )`,
    `create index if not exists character_jobs_status
       on character_jobs (character_id, status, created_at)`,
    // 同一个幂等键只能有一个**未失败**的任务；失败任务允许重建（重试就是新建任务）
    `create unique index if not exists character_jobs_idempotency_active
       on character_jobs (idempotency_key)
       where status in ('pending', 'running', 'completed')`,

    // ---- 运行证据 ---------------------------------------------------------
    `create table if not exists character_traces (
       trace_id                  text   primary key,
       character_id              text   not null,
       input_event_id            text   not null,
       context_compiler_version  text,
       context_section_ids       jsonb  not null default '[]'::jsonb,
       dropped_section_ids       jsonb  not null default '[]'::jsonb,
       source_conversation_event_ids jsonb not null default '[]'::jsonb,
       selected_memory_ids       jsonb  not null default '[]'::jsonb,
       projection_revisions_start jsonb not null default '{}'::jsonb,
       projection_revisions_end   jsonb not null default '{}'::jsonb,
       domain_event_ids          jsonb  not null default '[]'::jsonb,
       model_profile             text,
       output_event_id           text,
       post_turn_job_ids         jsonb  not null default '[]'::jsonb,
       processor_versions        jsonb  not null default '{}'::jsonb,
       steps                     jsonb  not null default '[]'::jsonb,
       status                    text   not null,
       error                     text,
       started_at                bigint not null,
       finished_at               bigint
     )`,
    `create index if not exists character_traces_recent
       on character_traces (character_id, started_at desc)`,

    // ---- 可靠性：序号 / 幂等 / 水位 ---------------------------------------
    `create table if not exists character_sequence_counters (
       character_id  text    primary key,
       next_sequence integer not null
     )`,
    `create table if not exists processed_operations (
       idempotency_key text   primary key,
       character_id    text   not null,
       processor       text   not null,
       processor_version text not null,
       operation       text   not null,
       domain_event_id text,
       processed_at    bigint not null
     )`,
    `create table if not exists processor_watermarks (
       character_id              text   not null,
       processor                 text   not null,
       processor_version         text   not null,
       processed_through_sequence integer not null,
       updated_at                bigint not null,
       primary key (character_id, processor, processor_version)
     )`,
  ],
}

/**
 * 0003 —— M3 Identity & Conversation Integrity 的 schema 扩展。
 *
 * ============================================================================
 *  为什么是 ALTER 而不是新建表
 * ============================================================================
 * M3 面对的是**一条已经连续的、有真实数据的账本**（生产库：
 * `memories` 4 条 / `character_events` 4 条 / 迁移 v2）。
 * 把 `character_definitions` 或 `conversation_events` 换成新表，
 * 等于让"她之前的经历"与"她之后的经历"分属两套结构 ——
 * 而 M4 的 Memory 要读的恰恰是**连续的**历史。
 *
 * 因此全部用 `add column if not exists`（幂等），旧行保持可读，
 * provenance 缺失的旧行在读取时**推导**（见 conversation-event.ts 的
 * `deriveSourceForLegacyRow`），而不是留空。
 *
 * 计划书第 123/124 节的四张表：
 *   character_definitions          —— 扩列（definition_json / seed_hash / …）
 *   character_definition_versions  —— 新增（Seed 历史，不覆盖旧版本）
 *   user_identities                —— 新增（UserId 稳定身份 + transport 映射）
 *   conversation_identities        —— 新增（ConversationId ↔ 参与者，可替换）
 *   conversation_events            —— 扩列（结构化 provenance + delivery）
 */
const MIGRATION_0003: Migration = {
  version: 3,
  name: 'm3-identity-and-conversation-integrity',
  statements: [
    // ---- Seed：结构化表示 + 指纹（计划书第 12/76/77 节）------------------
    // 旧的四个文本列**保留**：它们是既有渲染路径的输入，删掉会让
    // "她那句话是怎么来的"少一条可查的中间产物。
    `alter table character_definitions
       add column if not exists definition_json jsonb`,
    `alter table character_definitions
       add column if not exists seed_hash text`,
    `alter table character_definitions
       add column if not exists definition_schema_version integer not null default 1`,

    // ---- Seed 历史（计划书第 124/125 节）----------------------------------
    // 不用 UPDATE 覆盖旧 Seed：M11 的 Adaptive Self 出现后，
    // "她变了"有三种可能（真的成长 / 开发者改 Seed / 模型漂移），
    // 没有 Seed History 就无法区分。
    `create table if not exists character_definition_versions (
       character_id  text    not null,
       seed_version  integer not null,
       seed_hash     text    not null,
       definition_json jsonb not null,
       author        text,
       reason        text,
       effective_at  bigint  not null,
       primary key (character_id, seed_version)
     )`,
    `create index if not exists character_definition_versions_recent
       on character_definition_versions (character_id, seed_version desc)`,

    // ---- 用户身份（计划书第 7/25 节）--------------------------------------
    // UserId 是**稳定身份**，不随 Session / transport 变化。
    // transport 身份（qq_id / discord_user_id / websocket 连接）只是映射，
    // 因此单独一张表：一个 userId 可以有多个 transport 身份。
    `create table if not exists user_identities (
       user_id       text    primary key,
       display_name  text,
       created_at    bigint  not null,
       updated_at    bigint  not null
     )`,
    `create table if not exists user_identity_mappings (
       transport     text    not null,
       external_id   text    not null,
       user_id       text    not null,
       created_at    bigint  not null,
       primary key (transport, external_id)
     )`,
    `create index if not exists user_identity_mappings_user
       on user_identity_mappings (user_id)`,

    // ---- 会话身份（计划书第 8/38/39 节）-----------------------------------
    // ConversationId 表示"当前会话窗口"，**不是人格**，因此可替换。
    // 这张表让"同一个用户的两个会话"在数据上明确指向同一个 UserId。
    `create table if not exists conversation_identities (
       conversation_id text    not null,
       character_id    text    not null,
       user_id         text    not null,
       label           text,
       transport       text,
       created_at      bigint  not null,
       updated_at      bigint  not null,
       primary key (conversation_id)
     )`,
    `create index if not exists conversation_identities_participants
       on conversation_identities (character_id, user_id)`,

    // ---- 事件的结构化 provenance（计划书第 26–37 节）----------------------
    // ⚠️ 刻意做成列而不是继续塞 metadata 字典：字典一定会出现
    // "某个模块忘了写""某个模块键名写错"，而 M4 的 Memory 会把这些
    // 半成品当成权威来源。列是契约，字典是愿望。
    `alter table conversation_events
       add column if not exists source_kind text`,
    `alter table conversation_events
       add column if not exists source_authority text`,
    `alter table conversation_events
       add column if not exists epistemic_source text`,
    `alter table conversation_events
       add column if not exists delivery_status text`,
    `alter table conversation_events
       add column if not exists event_schema_version integer not null default 1`,
    // 按来源类别检索（"她说过哪些话""工具返回过什么"）
    `create index if not exists conversation_events_source_kind
       on conversation_events (character_id, source_kind, sequence)`,
    // reply graph 的反向查询（"这条回复在回应什么""这句话被谁回复过"）
    `create index if not exists conversation_events_reply_to
       on conversation_events (reply_to_event_id)`,

    // ---- Trace：身份快照（计划书第 72/122 节）----------------------------
    // "以后模型回答异常，第一时间检查：用的是不是错误 Seed。"
    // 因此 seed_version / seed_hash 必须**每一轮**都在 trace 里。
    `alter table character_traces
       add column if not exists seed_version integer`,
    `alter table character_traces
       add column if not exists seed_hash text`,
    `alter table character_traces
       add column if not exists runtime_id text`,
    `alter table character_traces
       add column if not exists user_id text`,
    `alter table character_traces
       add column if not exists conversation_id text`,
    `alter table character_traces
       add column if not exists identity_source_refs jsonb not null default '[]'::jsonb`,
  ],
}

/**
 * 0004 —— M3.5 Future Extension Compatibility 的 schema 扩展。
 *
 * ============================================================================
 *  全部是 `add column if not exists`，全部 nullable / 有默认值
 * ============================================================================
 * 计划书第 83 节：M3.5 **尽可能只做 additive migration**。
 * 因此这里没有 DROP、没有 RENAME、没有重写历史行。
 *
 * 四张表各加的是"未来位置"，今天一个都不需要填：
 *
 *   conversation_events     occurred_at / logical_time   （计划书第 29–34 节）
 *   character_domain_events occurred_at / logical_time   （同上）
 *   character_jobs          trigger_kind                 （计划书第 35–38 节）
 *   character_traces        observation_id / observation_type
 *                           intent_id / intent_type       （计划书第 85/89 节）
 *
 * ---------------------------------------------------------------------------
 *  为什么"今天用不到"的列值得现在加
 * ---------------------------------------------------------------------------
 * 因为上面这些表里装着**append-only 的历史**。
 * 等到真的需要区分"发生时间 / 记录时间 / 模拟时间"时，库里已经躺着
 * 大量只有一个 `created_at` 的行，而那些行**无法回溯判断**当初是哪种时间 ——
 * 迁移只能猜，猜错的代价是永久性的语义污染。
 *
 * 现在加的成本是零（旧行保持 NULL，读回来是 undefined）；未来加的成本是
 * "一次不可逆的数据语义决定"。这就是计划书第 33 节那句话的意思。
 *
 * ---------------------------------------------------------------------------
 *  ⚠️ 升级真实库需要显式动作
 * ---------------------------------------------------------------------------
 * 迁移闸（`kernel_migration_pending`）会在普通启动时拦下"有待应用迁移的真实库"，
 * 并指向 `pnpm migrate` / `pnpm migrate:apply`。这是 M3 那次事故换来的规矩：
 * **schema 升级必须是显式动作，不能在某人随手敲 `pnpm chat` 时悄悄发生。**
 *
 * 回滚方式：本迁移只加列，因此
 *   · 旧代码在新库上照常运行（旧代码的 insert 不含新列，默认值/NULL 生效）
 *   · 需要完全回退时用迁移前的库备份整体还原（本仓库不写 down 迁移）
 */
const MIGRATION_0004: Migration = {
  version: 4,
  name: 'm3.5-future-extension-compatibility',
  statements: [
    // ---- 时间模型（计划书第 29–34 节）------------------------------------
    // created_at 保持不动（= recordedAt）；这里加的是"发生时间"与预留的
    // "模拟时间"。两者都 nullable：旧行表示"不知道"，不是"等于现在"。
    `alter table conversation_events
       add column if not exists occurred_at bigint`,
    `alter table conversation_events
       add column if not exists logical_time text`,
    `alter table character_domain_events
       add column if not exists occurred_at bigint`,
    `alter table character_domain_events
       add column if not exists logical_time text`,

    // ---- 触发模型（计划书第 35–38 节）------------------------------------
    // 默认值 'conversation' 就是迁移前旧行的**真实含义**（当时唯一可能的值），
    // 因此这不是猜测性默认，而是对既有事实的如实登记。
    `alter table character_jobs
       add column if not exists trigger_kind text not null default 'conversation'`,

    // ---- Trace：感知与意图的语义槽（计划书第 85/89/90 节）----------------
    // 只存 id 与类型，不存 payload —— 与 trace 一贯的隐私原则一致
    // （正文留在 ConversationEvent 里，trace 只存引用）。
    `alter table character_traces
       add column if not exists observation_id text`,
    `alter table character_traces
       add column if not exists observation_type text`,
    `alter table character_traces
       add column if not exists intent_id text`,
    `alter table character_traces
       add column if not exists intent_type text`,
  ],
}

/**
 * 0005 —— M4 Reliable Long-Term Memory 的 schema。
 *
 * ============================================================================
 *  M4 是**纯新增**：四张新表，零 ALTER，零 DROP，零回填
 * ============================================================================
 * 与 M3（扩列）和 M3.5（加未来位置）不同，M4 没有义务改动任何既有表 ——
 * 它建立的是一个**新的领域**（长期记忆）。因此这次迁移比前三次都安全：
 * 既有的 267 项测试与真实库里的 8 条对话事件**完全不受影响**。
 *
 * ---------------------------------------------------------------------------
 *  ⚠️ 0005 在 M4 开发期内被改过一次 —— 此后它就**冻结**了
 * ---------------------------------------------------------------------------
 * `valid_until` 原来是 `bigint`，配一个字符串哨兵 `'none'` 表示"没有终点"。
 * 实测插入时直接类型报错（哨兵是字符串、列是 bigint），
 * 于是改成 `text` 承载三态（NULL / 'none' / 数字串）。
 *
 * 这次改动**没有**违反"迁移一旦发布不许改内容"，因为 0005 当时
 * **从未应用到真实库**（`data/pglite` 仍是 v4，只在临时沙箱里应用过）。
 * 版本号 5 的记录在真实库里还不存在，因此不存在"两种 0005"。
 *
 * 但这条豁免**到此为止**。一旦 `pnpm migrate:apply` 在真实库上跑过 0005：
 *
 *   · 它的 DDL 一个字都不能再改（`create table if not exists` 会让改动**静默失效**：
 *     表已存在 → 语句被跳过 → 代码以为改了、库里还是旧的）
 *   · 需要调整就必须追加 **0006**，而不是编辑 0005
 *
 * 这是"迁移是只增不改的"最容易被忽视的一种违反方式：
 * 改 0005 在**全新库**上完全正常（表被新建），只在**真实库**上失效 ——
 * 于是它逃过全部沙箱测试，只在生产上表现成"字段类型不对"。
 *
 * ---------------------------------------------------------------------------
 *  四张表，各自单一职责
 * ---------------------------------------------------------------------------
 *   memory_records          —— 当前投影（权威行）。带自己的 `revision` 乐观锁
 *   memory_subject_links    —— 一条记忆 → N 个 subject（`subjects: EntityRef[]`）
 *   memory_evidence_links   —— 一条记忆 → N 个 EvidenceRef，并标 `is_root`
 *   memory_events           —— 一条记忆 → 它的领域事件，**按序**
 *
 * ---------------------------------------------------------------------------
 *  ⚠️ 为什么 `memory_records` 不用 `character_projections`
 * ---------------------------------------------------------------------------
 * 见 `docs/m4/compatibility-audit.md` §5 F1。一句话：
 * `character_projections` 的主键是 `(character_id, projection_type)`，
 * 即"一个角色一种投影一行"；而 Memory 需要"每条记忆各自一行、
 * 各自独立乐观锁、各自独立重放"（计划书第 73 节的 `rebuildMemory(memoryId)`）。
 *
 * 强行合并成一行（`projection_type = 'memory'`，state 是 `Record<id, record>`）
 * 会让所有记忆共享一个 `revision`，于是改 A 会让 B 的重放基准失效 ——
 * 而那个缺陷**不报错**，只是让 `A == B` 在某些顺序下不成立。
 *
 * ---------------------------------------------------------------------------
 *  ⚠️ `memory_events` 不是冗余
 * ---------------------------------------------------------------------------
 * 计划书第 155 节说"若 Domain Event 已统一保存，不一定需要 `memory_events`
 * 独立表"。那条判断在**只有** `rebuildCharacterMemories` 需求时成立；
 * 一旦要有 `rebuildMemory(memoryId)`，就必须能**只取一条记忆的事件**。
 *
 * 而 `character_domain_events` 里没有 `memory_id` 列（给 append-only 的历史表
 * 加列违背 M3.5 的"只加 nullable 列、且不进 UPDATE"精神，且 memoryId 是
 * payload 内部信息），"扫全表 jsonpath"既慢又脆。
 *
 * 因此用一张**纯索引表**：它不存业务数据，只存
 * `(memory_id, domain_event_id, kind, created_at)`，把"重建一条记忆"
 * 做成 O(log n)。事实本体仍然只有 `character_domain_events` 一份。
 *
 * ---------------------------------------------------------------------------
 *  ⚠️ `valid_until` 为什么是 **text** 而不是 bigint（M4 实测踩到过）
 * ---------------------------------------------------------------------------
 * 契约（`memory.ts`）需要表达**三种**状态：
 *
 *     undefined = 不知道 / 不适用
 *     null      = 明确地"没有终点"（当前有效，且预期继续有效）
 *     number    = 失效于这个时刻
 *
 * 而 `bigint` 列只有一个 NULL。若把 `null` 与 `undefined` 都写成 NULL，
 * 那么 `MEMORY_RESTORED` 之后"应该没有终点"与"压根不知道"就同形了 ——
 * 重放一条被 restore 过的记忆会得到与首次写入**不同**的结果，
 * 而 `A == B` 是 M4 的 Gate（计划书第 74 节）。
 *
 * 因此用 text 承载三态：`NULL` = 不知道，`'none'` = 没有终点，数字串 = 那个时刻。
 * 第一版写成 `bigint` + 字符串哨兵，插入时直接类型报错
 * （"哨兵是字符串、列是 bigint"）—— 这个改动就是那次失败换来的。
 *
 * ---------------------------------------------------------------------------
 *  ⚠️ `memory_records` 与 ElizaOS 的 `memories` 表**没有任何关系**
 * ---------------------------------------------------------------------------
 * `memories` 是 ElizaOS 1.7.2 的消息表（按 `type='message'` 区分，
 * 见 `src/db/index.ts` 的启动自检）。M4 的 `memory_records` 是长期记忆投影。
 * 两者不得复用、不得 JOIN、不得互相写入 —— 这条写进
 * `docs/architecture/memory-backend-contract.md`，否则半年后一定会有人把它们混起来。
 *
 * ---------------------------------------------------------------------------
 *  回滚方式
 * ---------------------------------------------------------------------------
 * 本迁移只建新表，因此：
 *   · 旧代码在新库上照常运行（旧代码根本不认识这四张表）
 *   · 需要完全回退时用迁移前的库备份整体还原（`data/pglite.backup-m4-*`）
 *     —— 本仓库不写 down 迁移（与 0004 同一条规矩）
 */
const MIGRATION_0005: Migration = {
  version: 5,
  name: 'm4-reliable-long-term-memory',
  statements: [
    // ---- 当前投影（权威行）------------------------------------------------
    // `revision` 与 `reducer_version` 是"投影不是真相"的可执行证明：
    //   · revision 让写入必须带期望版本（乐观锁，旧 Worker 不能覆盖新状态）
    //   · reducer_version 让"改了折叠语义"必须先 rebuild 再继续
    `create table if not exists memory_records (
       id                  text    primary key,
       owner_kind          text    not null,
       owner_id            text    not null,
       memory_type         text    not null,
       content_kind        text    not null,
       content             jsonb   not null,
       epistemic_status    text    not null,
       authority           text    not null,
       importance          real    not null,
       confidence          real    not null,
       status              text    not null,
       canonical_key       text,
       content_fingerprint text    not null,
       valid_from          bigint,
       valid_until         text,
       occurred_at         bigint,
       recorded_at         bigint  not null,
       superseded_by       text,
       processor           text,
       processor_version   text,
       reducer_version     text    not null,
       revision            integer not null default 0,
       schema_version      integer not null,
       created_at          bigint  not null,
       updated_at          bigint  not null
     )`,

    // 计划书第 156 节的六条索引，逐条落地
    //   (owner_id, status)  —— M5 召回要"这个角色当前有哪些有效记忆"
    //   (owner_id, type)    —— "她关于用户的偏好有哪些"
    //   (owner_id, canonical_key) —— 冲突检测的主查询（第 76 节第二层去重）
    //   (recorded_at)       —— 时间线视图
    //   (processor, processor_version) —— 计划书第 67 节：
    //        "找出所有 @1 产生的 Memory" 进行 audit / reprocess / retract
    `create index if not exists memory_records_owner_status
       on memory_records (owner_kind, owner_id, status)`,
    `create index if not exists memory_records_owner_type
       on memory_records (owner_kind, owner_id, memory_type)`,
    `create index if not exists memory_records_owner_canonical
       on memory_records (owner_kind, owner_id, canonical_key)`,
    `create index if not exists memory_records_canonical
       on memory_records (canonical_key)`,
    `create index if not exists memory_records_fingerprint
       on memory_records (content_fingerprint)`,
    `create index if not exists memory_records_recorded_at
       on memory_records (recorded_at)`,
    `create index if not exists memory_records_processor
       on memory_records (processor, processor_version)`,

    // 计划书第 75 节去重第一层 + 幂等兜底：
    // 同一个内容指纹 + 同一条 ACTIVE 只允许存在一行。
    // 部分唯一索引（只覆盖 active）让"被 supersede 过的旧条"不阻塞新条 ——
    // 否则"我喜欢咖啡 → 我戒咖啡了 → 我又开始喝咖啡"的第三条会撞上第一条的键。
    `create unique index if not exists memory_records_active_fingerprint
       on memory_records (owner_kind, owner_id, content_fingerprint)
       where status = 'active'`,

    // ---- subject 关系表（计划书第 8 节）-----------------------------------
    // 用关系表而不是把 subjects 塞进 content 的 JSON：
    // 计划书第 158 节的理由是"纯 JSON 会很痛苦" —— 而 subject 恰恰是
    // `listBySubject(owner, subject)` 这个查询口要按它检索的列。
    `create table if not exists memory_subject_links (
       memory_id    text not null,
       subject_kind text not null,
       subject_id   text not null,
       primary key (memory_id, subject_kind, subject_id)
     )`,
    `create index if not exists memory_subject_links_lookup
       on memory_subject_links (subject_kind, subject_id)`,

    // ---- evidence 关系表（计划书第 157–158 节）----------------------------
    // 必须能回答"从这条 ConversationEvent 反查它产生了哪些 Memory"，
    // 因此 evidence_id 上必须有索引（`listBySource`）。
    // `is_root` 落地计划书第 40–41 节：根证据与派生证据在同一个表里可区分。
    `create table if not exists memory_evidence_links (
       memory_id     text    not null,
       evidence_kind text    not null,
       evidence_id   text    not null,
       is_root       boolean not null default false,
       primary key (memory_id, evidence_kind, evidence_id)
     )`,
    `create index if not exists memory_evidence_links_lookup
       on memory_evidence_links (evidence_kind, evidence_id)`,
    `create index if not exists memory_evidence_links_memory
       on memory_evidence_links (memory_id)`,
    `create index if not exists memory_evidence_links_root
       on memory_evidence_links (memory_id) where is_root`,

    // ---- 每条记忆的事件流（计划书第 73 节）--------------------------------
    // `(memory_id, sequence)` 主键让"按序取一条记忆的全部事件"是唯一形状；
    // `sequence` 是**角色级领域事件序号**（不是这条记忆的本地序号）——
    // 用它排序才能与 `character_domain_events` 的全序一致，
    // 而 Replay 的正确性依赖那个顺序。
    `create table if not exists memory_events (
       memory_id       text    not null,
       domain_event_id text    not null,
       sequence        integer not null,
       kind            text    not null,
       created_at      bigint  not null,
       primary key (memory_id, sequence)
     )`,
    `create index if not exists memory_events_domain_event
       on memory_events (domain_event_id)`,
  ],
}

/**
 * 0006 —— M4.5：Execution Ledger（她**做过什么**）。
 *
 * ============================================================================
 *  ADR-034：执行事实与记忆是两本账
 * ============================================================================
 * 这张表**不是** memory_records，也不是 conversation_events：
 *
 *   · memory_records        她知道什么（长期）
 *   · conversation_events   她与用户之间发生了什么（事实账本）
 *   · character_action_events **她对世界做了什么**（本表）
 *
 * 混进任何一边都会产生具体的坏结果：
 *   · 混进记忆 → 沙箱里一次实验写入会变成永久人格记忆
 *   · 混进对话 → `--history` 开始显示工具调用，记忆的证据反查被污染
 *
 * ---------------------------------------------------------------------------
 *  形状：append-only 事件流，而不是可变行
 * ---------------------------------------------------------------------------
 * `ExecutionRecord`（§19）是这些事件折叠出来的**视图**，不是表里的一行。
 * 因此这里没有 UPDATE / DELETE —— 与 `conversation_events` 同一条纪律。
 *
 * `status` 只在**终态事件**上非空。这一列的存在有一个非常具体的目的：
 * **按状态过滤必须能发生在 SQL 里**（`action:list --status X`）。
 * 若过滤只能读回来再 filter，"量具自己读错状态"就会再次发生（M4.1 的
 * `activeValues()` 正是这么错的）。详见 ADR-035。
 *
 * ---------------------------------------------------------------------------
 *  回滚方式
 * ---------------------------------------------------------------------------
 * 只建新表 + 加一列。旧代码在新库上照常运行（它不认识这两者）。
 * 需要完全回退时用迁移前的库备份整体还原 —— 本仓库不写 down 迁移。
 */
const MIGRATION_0006: Migration = {
  version: 6,
  name: 'm45-action-execution-ledger',
  statements: [
    `create table if not exists character_action_events (
       action_id        text    not null,
       sequence         integer not null,
       character_id     text    not null,
       trace_id         text,
       event_type       text    not null,
       status           text,
       capability       text    not null,
       operation        text    not null,
       idempotency_key  text,
       payload          jsonb   not null default '{}'::jsonb,
       schema_version   integer not null default 1,
       created_at       bigint  not null,
       primary key (action_id, sequence)
     )`,

    // 时间线 / 列表视图
    `create index if not exists character_action_events_character_seq
       on character_action_events (character_id, sequence)`,
    // §20 的反查：一条 trace 串起哪些动作
    `create index if not exists character_action_events_trace
       on character_action_events (trace_id)`,
    // 按状态过滤（L0 量具验证的核心查询）
    `create index if not exists character_action_events_status
       on character_action_events (character_id, status)`,
    // 幂等查询
    `create index if not exists character_action_events_idempotency
       on character_action_events (character_id, idempotency_key)`,
    // 按能力过滤
    `create index if not exists character_action_events_capability
       on character_action_events (character_id, capability)`,

    // trace 侧的反向引用：这一轮她做了什么（STOP-05 的判据来源）
    `alter table character_traces
       add column if not exists action_ids jsonb not null default '[]'::jsonb`,

    /*
     * **独立的序号计数器**。
     *
     * 刻意不复用 `character_sequence_counters`：那个计数器是
     * ConversationEvent / DomainEvent 的**角色级全序**依据（M2.5/M3 的不变量），
     * 让动作去推进它，会让"这一轮的动作"改变对话事件的序号分布 ——
     * 而既有回归断言正建立在那个分布上。
     *
     * 动作内部只需要"同一 action 内单调"，因此单独一行、单独一个计数器。
     */
    `create table if not exists character_action_sequence_counters (
       character_id  text    primary key,
       next_sequence integer not null
     )`,
  ],
}

// ---------------------------------------------------------------------------
// M5.1.1 · 迁移 0007 —— 归因（ADR-042）的物理承载
// ---------------------------------------------------------------------------

/**
 * 三态槽位的**物理编码**（列名 + 词汇域）。
 *
 * 注意两处刻意的列名：
 *   · `actor_ref_id` 而不是 `actor_id` —— 避免遮蔽 legacy 列 `actor_type/actor_id`
 *   · `authority_ref` 而不是 `authority_id` —— 它指向策略/能力，不是位次
 */
const ATTRIBUTION_PHYSICAL_SLOTS = [
  {
    slot: 'initiator',
    kind: 'initiator_kind',
    id: 'initiator_id',
    reason: 'initiator_unknown_reason',
    domain: 'PRINCIPAL',
  },
  {
    slot: 'actor',
    kind: 'actor_kind',
    id: 'actor_ref_id',
    reason: 'actor_unknown_reason',
    domain: 'PRINCIPAL',
  },
  {
    slot: 'executor',
    kind: 'executor_kind',
    id: 'executor_id',
    reason: 'executor_unknown_reason',
    domain: 'PRINCIPAL',
  },
  {
    slot: 'recorded_by',
    kind: 'recorded_by_kind',
    id: 'recorded_by_id',
    reason: 'recorded_by_unknown_reason',
    domain: 'PRINCIPAL',
  },
  {
    slot: 'content_originator',
    kind: 'content_originator_kind',
    id: 'content_originator_id',
    reason: 'content_originator_unknown_reason',
    domain: 'PRINCIPAL',
  },
  {
    slot: 'authority',
    kind: 'authority_kind',
    id: 'authority_ref',
    reason: 'authority_unknown_reason',
    domain: 'AUTHORITY',
  },
] as const

/** Axis B 三列 + origin（**Axis B 没有 Absent 态**：要么不给 origin，要么三列齐） */
const ATTRIBUTION_AXIS_B_COLUMNS = ['source_kind', 'source_authority', 'epistemic_source'] as const
const ATTRIBUTION_ORIGIN_COLUMN = 'attribution_origin'

/*
 * ⚠️ 下面这些受控词汇是**字面量**，刻意**不** import 契约里的常量。
 *
 * 理由：已发布的迁移必须**冻结**。如果 DDL 从活的常量派生，那么将来契约加一个值时，
 * 同一个迁移在**新库**上会生成不同的约束 —— 于是不同的库对"什么值合法"给出不同答案
 * （"同一份代码在不同库上有不同约束"是最难查的一类事故）。
 *
 * 代价是字面量可能与契约漂移 —— 因此 `pnpm m5.1.1:migration:verify` 里有一条
 * 断言把这些字面量与契约定量比对：漂移会变成可检测的失败，而不是静默的库间差异。
 */
const PRINCIPAL_KIND_VALUES = [
  'USER',
  'CHARACTER',
  'SYSTEM',
  'SERVICE',
  'TOOL',
  'EXTERNAL_ACTOR',
] as const
const AUTHORITY_KIND_VALUES = [
  'POLICY',
  'CAPABILITY',
  'SYSTEM_RULE',
  'USER_CONSENT',
  'BREAK_GLASS',
] as const
const UNKNOWN_REASON_VALUES = ['LEGACY_UNRECORDED', 'RUNTIME_UNRESOLVED'] as const
const SOURCE_KIND_VALUES = [
  'user_statement',
  'character_output',
  'system_instruction',
  'tool_output',
] as const
const SOURCE_AUTHORITY_VALUES = [
  'USER_EXPLICIT',
  'USER_REPLY_CONFIRMATION',
  'DIRECT_INTERACTION',
  'TOOL_OBSERVATION',
  'CHARACTER_GENERATION',
  'SYSTEM_INSTRUCTION',
  'UNCONFIRMED_ORIGIN',
] as const
const EPISTEMIC_SOURCE_VALUES = [
  'user_report',
  'character_generation',
  'system_instruction',
  'tool_observation',
  'UNCONFIRMED_ORIGIN',
] as const
const ATTRIBUTION_ORIGIN_VALUES = ['RECORDED', 'MIGRATED_LEGACY'] as const

/** 控制面审计的命令词表（U-03 的承载；值取自 developer-control.ts 的受控词汇） */
const CONTROL_COMMAND_TYPE_VALUES = ['RUN_DIAGNOSTIC', 'RUN_AUDIT'] as const
const CONTROL_OUTCOME_VALUES = [
  'rejected',
  'accepted',
  'attempted',
  'executed',
  'verified',
] as const
const CONTROL_DISPOSITION_VALUES = [
  'succeeded',
  'failed',
  'timed_out',
  'cancelled',
  'none',
] as const
const CONTROL_VERIFICATION_VALUES = [
  'verified',
  'failed',
  'not_attempted',
  'not_applicable',
] as const

const sqlValueList = (values: readonly string[]): string =>
  values.map((value) => `'${value}'`).join(', ')

/** 22 个追加列（18 个槽位列 + Axis B 三列 + origin）—— 两张事件表各一份 */
function v7AttributionColumnStatements(table: string): string[] {
  const columns = [
    ...ATTRIBUTION_PHYSICAL_SLOTS.flatMap((slot) => [slot.kind, slot.id, slot.reason]),
    ...ATTRIBUTION_AXIS_B_COLUMNS,
    ATTRIBUTION_ORIGIN_COLUMN,
  ]
  return columns.map((column) => `alter table ${table} add column if not exists ${column} text`)
}

/**
 * **19 个追加列**（18 个槽位列 + `attribution_origin`）—— v9 给 `state_events` 用。
 *
 * 为什么**不**直接用 `v7AttributionColumnStatements`：那个生成器按设计产出
 * **22** 列（多了 Axis B 三列）。v7 的语句文本是不可改的历史，因此这里另写一个
 * **只去掉 Axis B 三列**的小生成器 —— 它复用**同一个**
 * `ATTRIBUTION_PHYSICAL_SLOTS`，所以列名不可能与 v7 漂移。
 *
 * 与 `v7AttributionCheckStatements(table, { axisB: false })` 配对使用
 * （18 条槽位 CHECK + 手写的那 1 条 origin 词表 = 19 条）。
 */
function v9StateEventAttributionColumnStatements(table: string): string[] {
  const columns = [
    ...ATTRIBUTION_PHYSICAL_SLOTS.flatMap((slot) => [slot.kind, slot.id, slot.reason]),
    ATTRIBUTION_ORIGIN_COLUMN,
  ]
  return columns.map((column) => `alter table ${table} add column if not exists ${column} text`)
}

/**
 * 三态 + 受控词汇的 CHECK（K-4）。
 *
 * ============================================================================
 *  **约束数量不是架构不变量；三态精确互斥才是**
 * ============================================================================
 * Proposed-Schema §0 的 4 条草案 CHECK **允许**一个非法第四状态：
 *
 *     kind = 'USER', id = NULL, unknown_reason = NULL
 *
 * （分支 `id is null or kind is not null` 通过；`kind not like 'UNKNOWN%'` 通过；
 *  两条 reason 分支都通过 —— 于是一行"只说了种类、没说标识、也没说为什么不知道"
 *  的数据可以进库，而它既不是 Known、也不是 Unknown、也不是 Absent。）
 *
 * 因此这里冻结成**一条精确的三分支 CHECK**：只有恰好落在三态之一才通过，
 * 其余**任何**元组都被数据库拒绝。词表再用**独立**的 CHECK 钉住
 * （不依赖 TypeScript 的 enum —— 数据库自己也要会拒绝 `'HACKER'` / `'MAGIC'`）。
 */
function v7AttributionCheckStatements(table: string, options: { axisB: boolean }): string[] {
  const statements: string[] = []

  for (const slot of ATTRIBUTION_PHYSICAL_SLOTS) {
    const kindDomain = slot.domain === 'AUTHORITY' ? AUTHORITY_KIND_VALUES : PRINCIPAL_KIND_VALUES
    statements.push(
      `alter table ${table} add constraint ${table}_${slot.slot}_tri_state check (` +
        `(${slot.kind} is null and ${slot.id} is null and ${slot.reason} is null) or ` +
        `(${slot.kind} is not null and ${slot.id} is not null and ${slot.reason} is null) or ` +
        `(${slot.kind} is null and ${slot.id} is null and ${slot.reason} in ` +
        `(${sqlValueList(UNKNOWN_REASON_VALUES)})))`
    )
    statements.push(
      `alter table ${table} add constraint ${table}_${slot.slot}_kind_vocab check (` +
        `${slot.kind} is null or ${slot.kind} in (${sqlValueList(kindDomain)}))`
    )
    // 与三分支 CHECK 的第三支**重复**，但刻意保留：词表约束不该只藏在一条复合 CHECK 里，
    // 否则将来有人简化那条 CHECK 时，词汇保护会**静默**消失。
    statements.push(
      `alter table ${table} add constraint ${table}_${slot.slot}_reason_vocab check (` +
        `${slot.reason} is null or ${slot.reason} in (${sqlValueList(UNKNOWN_REASON_VALUES)}))`
    )
  }

  if (options.axisB) {
    statements.push(
      `alter table ${table} add constraint ${table}_source_kind_vocab check (` +
        `source_kind is null or source_kind in (${sqlValueList(SOURCE_KIND_VALUES)}))`,
      `alter table ${table} add constraint ${table}_source_authority_vocab check (` +
        `source_authority is null or source_authority in (${sqlValueList(SOURCE_AUTHORITY_VALUES)}))`,
      `alter table ${table} add constraint ${table}_epistemic_source_vocab check (` +
        `epistemic_source is null or epistemic_source in (${sqlValueList(EPISTEMIC_SOURCE_VALUES)}))`,
      `alter table ${table} add constraint ${table}_attribution_origin_vocab check (` +
        `${ATTRIBUTION_ORIGIN_COLUMN} is null or ${ATTRIBUTION_ORIGIN_COLUMN} in ` +
        `(${sqlValueList(ATTRIBUTION_ORIGIN_VALUES)}))`,
      // Axis B 没有 Absent 态：一旦声明了 origin，三列就必须齐（M7 的库级形式）。
      // 尚未回填的旧行 origin 为 NULL，因此这条不会拦住 v6 -> v7 的既有数据。
      `alter table ${table} add constraint ${table}_axis_b_complete check (` +
        `${ATTRIBUTION_ORIGIN_COLUMN} is null or (` +
        `source_kind is not null and source_authority is not null and epistemic_source is not null))`
    )
  }

  return statements
}

/**
 * 0007 —— M5.1.1：归因槽位 + Axis B + 控制面审计承载（**纯追加**）。
 *
 * 范围（WP2）：只建立**物理承载能力**。不写任何运行时逻辑、不改读出侧语义、
 * 不动 Fact Firewall、不碰 MemoryAuthority。
 *
 * 内含三件事：
 *   ① 两张事件表各追加 22 列（全部可空 → 旧代码在 v7 库上照常运行）
 *   ② 每个槽位一条**精确三分支** CHECK + 词表 CHECK（K-4）；
 *      Axis B 四列 + "声明了 origin 就必须三列齐"
 *   ③ 一个 partial 索引（U-01：只为**已存在**的审计查询建索引，只建这一个）
 *   ④ U-03 的最小物理表示：`developer_control_events`（专用 append-only 审计承载；
 *      **不**伪装成 character_action_events，也不给它建索引）
 *
 * ⚠️ 这里**没有** DB 级"回填行不得有具体 content_originator"的约束：
 *    那是迁移门 M4 的**计数判据**（WP3），不是写入期形状问题 ——
 *    在 DDL 里表达它会把"历史回填规则"和"物理编码"混成一层。
 */
const MIGRATION_0007: Migration = {
  version: 7,
  name: 'm5.1.1-attribution-model',
  statements: [
    // ---- ① conversation_events 追加列 ------------------------------------
    ...v7AttributionColumnStatements('conversation_events'),

    // ---- ② conversation_events 的三态与词表 ------------------------------
    ...v7AttributionCheckStatements('conversation_events', { axisB: true }),

    // ---- ③ 唯一的索引（U-01：真实存在的审计查询才建索引）-----------------
    `create index if not exists conversation_events_attribution_origin
       on conversation_events (attribution_origin)
       where attribution_origin = 'MIGRATED_LEGACY'`,

    // ---- ④ character_action_events 追加同一组列 --------------------------
    ...v7AttributionColumnStatements('character_action_events'),
    ...v7AttributionCheckStatements('character_action_events', { axisB: true }),

    // ---- ⑤ U-03：控制面审计的专用 append-only 承载 -----------------------
    /*
     * 为什么是**新表**而不是复用 character_action_events（U-03 明文禁止伪装）：
     * 控制命令不是角色行动，它的 `actor` 是控制面（SERVICE）、`authority` 是
     * CAPABILITY/POLICY，而"她做了什么"的账本不该混进开发者的运维动作。
     * 归因槽位与事件表同形（统一语义），必要性由写入侧按矩阵执行。
     */
    `create table if not exists developer_control_events (
       command_id        text    not null,
       sequence          integer not null,
       character_id      text    not null,
       trace_id          text,
       command_type      text    not null,
       outcome           text,
       disposition       text,
       verification      text,
       reason_code       text,
       transport         text,
       initiator_kind    text,
       initiator_id      text,
       initiator_unknown_reason text,
       actor_kind        text,
       actor_ref_id      text,
       actor_unknown_reason text,
       executor_kind     text,
       executor_id       text,
       executor_unknown_reason text,
       recorded_by_kind  text,
       recorded_by_id    text,
       recorded_by_unknown_reason text,
       content_originator_kind text,
       content_originator_id text,
       content_originator_unknown_reason text,
       authority_kind    text,
       authority_ref     text,
       authority_unknown_reason text,
       payload           jsonb   not null default '{}'::jsonb,
       schema_version    integer not null default 1,
       created_at        bigint  not null,
       primary key (command_id, sequence)
     )`,
    ...v7AttributionCheckStatements('developer_control_events', { axisB: false }),
    `alter table developer_control_events add constraint developer_control_events_command_type_vocab
       check (command_type in (${sqlValueList(CONTROL_COMMAND_TYPE_VALUES)}))`,
    `alter table developer_control_events add constraint developer_control_events_outcome_vocab
       check (outcome is null or outcome in (${sqlValueList(CONTROL_OUTCOME_VALUES)}))`,
    `alter table developer_control_events add constraint developer_control_events_disposition_vocab
       check (disposition is null or disposition in (${sqlValueList(CONTROL_DISPOSITION_VALUES)}))`,
    `alter table developer_control_events add constraint developer_control_events_verification_vocab
       check (verification is null or verification in (${sqlValueList(CONTROL_VERIFICATION_VALUES)}))`,
  ],
}

/**
 * 0008 —— M5.1.1 / WP4.1：**K-22 physical landing**
 * （`character_action_events` 的 Cognitive Axis B **不适用**）。
 *
 * ============================================================================
 *  为什么需要 v8（v7 的实测阻塞）
 * ============================================================================
 * v7 给**两张**事件表加了同一条 `axis_b_complete`：
 *
 *     attribution_origin is null or (source_kind is not null
 *                                    and source_authority is not null
 *                                    and epistemic_source is not null)
 *
 * 对 `conversation_events` 这是对的（R-21：声明了 origin 的行必须落在两个合法分支之一）。
 * 对 `character_action_events` 它**强制伪造**：行动行一旦声明 `attribution_origin`
 * （例如 `'RECORDED'`），就必须同时编出 Cognitive Axis B 三列 ——
 * 而 `SourceKind` 的四个取值全是**对话内容类别**
 * （`user_statement` / `character_output` / `system_instruction` / `tool_output`），
 * 没有任何一个描述"一次行动"。唯一能填的办法就是把 initiator / actor / executor
 * 映射成 `SourceKind` —— 那正是 K-22 冻结语义**明令禁止**的方向。
 *
 * ============================================================================
 *  冻结语义（K-22：Action attribution is NOT Cognitive Axis B）
 * ============================================================================
 * `character_action_events` 的 Cognitive Axis B **不适用（N/A）**，而且是**全局**不适用
 * （不是逐行的选择）。因此本表上这三列**唯一**允许的取值是 NULL：
 *
 *     source_kind is null and source_authority is null and epistemic_source is null
 *
 * **NULL 在这里不是"还没记"**：它是本表上唯一合法状态，由成文契约显式定义为 N/A
 * （`attribution.ts` 的 `ACTION_AXIS_B_SEMANTICS` / `isCognitiveAxisBApplicable`），
 * 并由本迁移的 CHECK **穷尽**（没有第二种合法形状）—— 因此不需要第二个 marker 列，
 * 也不存在"NULL 到底是哪一种含义"的歧义。
 *
 * 行动侧的归因**照样**可以记（七个槽位里除 Axis B 之外的六个 + `attribution_origin`），
 * 并且**照样**可查、可审计 —— 只是不假装自己是认知来源。
 *
 * ============================================================================
 *  这条迁移**不**做什么（爆炸半径）
 * ============================================================================
 *  · 不碰 `conversation_events`（R-21 的 Axis B 语义逐字不变）
 *  · 不加列、不删列、不改列（没有 add/drop/alter column）
 *  · 不碰数据（没有 update / insert / delete / truncate）
 *  · 不碰词表（四个词表 CHECK 原样保留；新 CHECK 使它们在行动表上恒真）
 *  · 不碰 `developer_control_events`（它本来就没有 Axis B 列）
 *  · 不改 `MIGRATION_0007`（指纹已锁：v7 是不可改的历史 DDL）
 *
 * 唯一被替换的对象是 `character_action_events` 上的**一条** CHECK：
 * 旧的 `character_action_events_axis_b_complete` → 新的
 * `character_action_events_axis_b_not_applicable`。
 * 已存在的行 Axis B 三列全是 NULL ⇒ **全部**满足新 CHECK
 * （apply 前 / 后的行数相同，逐行值不变；WP4.1 的门逐条实测）。
 *
 * ============================================================================
 *  为什么这一条替换不算"破坏性"
 * ============================================================================
 * 真值表（行动表，只看 Axis B 三列 + origin）：
 *
 *   origin  Axis B        v7        v8        说明
 *   NULL    NULL          accept    accept    既有行 / 旧代码写的行
 *   any     部分非空       reject    reject    三态本身不允许半填
 *   any     三列全非空     accept    **reject**  ← 唯一的收紧：行动行不得携带 Axis B
 *   any     三列全 NULL    v7 在 origin 非空时 reject / v8 accept ← 唯一的放宽（K-22 的目标形状）
 *
 * 放宽的那一格正是 K-22 要表达的形状；收紧的那一格正是 K-22 要禁止的形状
 * （"假装自己是认知来源"）。既有数据一格都没被拒。
 *
 * 回滚：drop 新 CHECK + 重新 add 旧 CHECK（v7 的语句文本是冻结的公开历史），
 * 或在 apply 前用库备份整体还原 —— 本仓库不写 down 迁移。
 */
const MIGRATION_0008: Migration = {
  version: 8,
  name: 'm5.1.1-k22-action-axis-b-not-applicable',
  statements: [
    `alter table character_action_events
       drop constraint if exists character_action_events_axis_b_complete`,
    `alter table character_action_events
       add constraint character_action_events_axis_b_not_applicable check (
         source_kind is null and source_authority is null and epistemic_source is null)`,
  ],
}

/**
 * 0009 —— M5.1.1 / WP9-B1：**`state_events` 的归因物理承载**（R-45 = SELECTED B，纯追加）。
 *
 * ============================================================================
 *  为什么需要 v9（用户裁定 R-45）
 * ============================================================================
 * 首启时 `src/state/init.ts` 写下的那条 `state_events`（`trigger='init'`）是今天
 * **唯一**一个"结构上本来就是系统自行发起"的真实产品行为。R-45 = SELECTED B：
 * 让它成为**第一条生产真实、可归属的系统来源状态转移**。
 *
 * v7 只给了**两张事件表**归因承载（`conversation_events` / `character_action_events`），
 * `state_events` 没有。想让它携带 `Known(SYSTEM/<component>)`，物理承载必须先存在 ——
 * 这就是本条迁移的全部内容。
 *
 * ============================================================================
 *  这条迁移**做**什么
 * ============================================================================
 *  ① `state_events` 追加 **19 列**（18 个槽位列 + `attribution_origin`），全部可空；
 *  ② 6 个槽位各 **3 条** CHECK（精确三分支 `_tri_state` + `_kind_vocab` + `_reason_vocab`）；
 *  ③ `attribution_origin` 的一条受控词汇 CHECK（`state_events_attribution_origin_vocab`）。
 *
 * 列名与 v7 **逐字相同**（同一个 `ATTRIBUTION_PHYSICAL_SLOTS` 生成器），
 * 因此 `storedAttributionOfRow()` 这一个 canonical 读取器对三张表通用。
 *
 * ============================================================================
 *  这条迁移**不**做什么（爆炸半径）
 * ============================================================================
 *  · **不加 Axis B 列**：`source_kind` / `source_authority` / `epistemic_source` 一个都不加。
 *    状态转移**不是**内容主张 ⇒ 它不适用 Cognitive Axis B（与 `developer_control_events`
 *    同形；那个表连 Axis B 列都没有，且这是**全局**判定，不是逐行选择）。
 *    ⇒ 因此这里也**没有** `axis_b_complete` / `axis_b_not_applicable` 这类约束。
 *  · **不建索引**：今天**没有**任何针对 `state_events` 归因列的查询；v7 的规则是
 *    "只为真实存在的审计查询建索引"（U-01），所以一个都不建。
 *    （另有两个门断言"全库归因相关索引**恰好** 1 个 = v7 的那个 partial 索引"。）
 *  · **不回填历史行**：没有 `update` / `insert` / `delete` / `truncate`。
 *    既有行（含首启那条 `trigger='init'`）**保持 NULL 归因列**、**不带信封**
 *    （`attribution_origin is null` = "从未记录过归因"，与"记录了但每格 Absent"
 *    是**两件不同的事**）。**绝不**从 `trigger='init'` 反推一个 initiator。
 *  · **不碰** v7 / v8（它们的指纹已锁，是不可改的历史 DDL）、不碰其它任何表、不碰数据。
 *
 * 回滚：`drop` 这 19 列（连带它们的 CHECK），或整库还原 —— 本仓库不写 down 迁移。
 */
const MIGRATION_0009: Migration = {
  version: 9,
  name: 'm5.1.1-state-events-attribution',
  statements: [
    // ---- ① 19 列（18 槽位 + origin；**没有** Axis B） -----------------------
    ...v9StateEventAttributionColumnStatements('state_events'),

    // ---- ② 6 个槽位的三态与词表（与 v7 同一套生成器、同一套词汇）-----------
    ...v7AttributionCheckStatements('state_events', { axisB: false }),

    /*
     * ---- ③ origin 词表 ----------------------------------------------------
     *
     * `v7AttributionCheckStatements(..., { axisB: false })` 刻意**不**产出这条
     * （v7 只在 `axisB: true` 的分支里给 origin 建词表）。但 `state_events` 有
     * `attribution_origin` 列 ⇒ 它必须有词表，否则"RECORDED / MIGRATED_LEGACY"
     * 这个受控词汇在库侧就没有守卫。
     *
     * 与 v7 的 `*_attribution_origin_vocab` **同名后缀、逐字同形**（见
     * `v7AttributionCheckStatements` 的 axisB 分支），并复用同一个模块私有字面量
     * `ATTRIBUTION_ORIGIN_VALUES`（已发布迁移的词汇是**字面量**，刻意不从活契约派生；
     * `pnpm m5.1.1:migration:verify` 会把字面量与契约定量比对，漂移会红）。
     */
    `alter table state_events add constraint state_events_attribution_origin_vocab check (` +
      `${ATTRIBUTION_ORIGIN_COLUMN} is null or ${ATTRIBUTION_ORIGIN_COLUMN} in ` +
      `(${sqlValueList(ATTRIBUTION_ORIGIN_VALUES)}))`,
  ],
}

/**
 * **迁移 0010 —— 语义索引表**（2026-09-30 用户裁定 `L-M10-66` = 「(a) 新增内核迁移」）。
 *
 * ============================================================================
 *  为什么会有这一条（`L-M10-66` 的原样）
 * ============================================================================
 * ```text
 * `memory_semantic_generations`（与 `memory_semantic_meta`）**原先不在任何内核迁移里**：
 * 建它们的是 `ensureSemanticIndexSchema()`，而它**只被 M9.5 自己的实验室脚本调用**
 * （`m9.5-calibration-verify` / `m9.5-lexical-calibration` / …），
 * **没有任何启动路径调用它** ⇒ 没建过索引的库上**这张表不存在**
 * ⇒ 语义召回在生产里会**永远如实降级成 `not_indexed`**（不挂、不骗，但**功能等于关着**）。
 * ```
 *
 * ⚠️ **它同时覆盖了一处设计决策**：`ADR-076` 的 `M10-D15` 逐字写着
 *    「复用通用事件 / 投影；**迁移目标 NONE**（WP0 实测支持）… 不够再追加迁移，绝不改旧 DDL」
 *    —— **用户 2026-09-30 裁定走 (a)**，即"不够了、追加一条"：
 *    这是 `D15` 里**本来就写着的那条出路**（"不够再追加迁移"），不是绕过它 ✓。
 *
 * ============================================================================
 *  半径（与既有迁移同一条纪律）
 * ============================================================================
 * ```text
 * · **只** `create table if not exists`（DDL **逐字复用** `SEMANTIC_INDEX_DDL` ⇒ 不会与模块漂开）
 * · **不碰** 0001–0009 的任何内容（它们的指纹已锁，是不可改的历史 DDL）
 * · **不碰** 任何既有表 / 行（**零 backfill**）
 * · **不写** `memory_semantic_meta` 的版本行 —— 那本登记簿归 `ensureSemanticIndexSchema()`
 *   独家维护（版本只在**一处**写 ⇒ 不会出现两个说法）。实测其状态判定：
 *   "表在、但没有版本登记" ⇒ `action: 'create'` ⇒ 首次调用会把版本行补上 ✓
 * ```
 *
 * ⚠️ **它修的是"表不存在"这个结构性缺陷**，**不是**"索引已经建好"：
 *    索引的**构建**仍属 M9.5 的线（标定 / 激活），本迁移**不**代它完成。
 *
 * 回滚：`drop` 这两张表（或整库还原）—— 本仓库不写 down 迁移。
 */
const MIGRATION_0010: Migration = {
  version: 10,
  name: 'm10-semantic-index-tables',
  statements: [...SEMANTIC_INDEX_DDL],
}

// ---------------------------------------------------------------------------
// 0011 —— 后 Lv2 · S1：Axis B 受控词汇追加故事来源（**纯追加 + 约束重建**）
// ---------------------------------------------------------------------------

/**
 * `0011` 新增的三个**受控词汇值**（ADR-091 `D04`）。
 *
 * ⚠️ 与 `SOURCE_KIND_VALUES` 等上面的字面量同样理由：这里也写**字面量**。
 * 它们是"这一版迁移写进库里的东西"，不是"当前契约的样子"。
 */
const V11_STORY_SOURCE_KIND_VALUES = ['story_fact'] as const
const V11_STORY_SOURCE_AUTHORITY_VALUES = ['STORY_OBSERVATION'] as const
const V11_STORY_EPISTEMIC_SOURCE_VALUES = ['story_experience'] as const

/**
 * 0007 在**哪张表**上建了 Axis B 三列的词表约束。
 *
 * ⚠️ 只有 `conversation_events` 一张（WP0 实测：`character_domain_events`
 * **没有** Axis B 三列 —— 它们只加在 `conversation_events`（v7 的 22 列）
 * 与 `character_action_events`（v7 的 22 列、v8 又标成 NOT_APPLICABLE）上；
 * 给不存在的表加约束会直接失败）。
 *
 * 这条约束只在**这一张**表上需要扩宽，因为**只有它能承载 `story_fact`** ——
 * 故事观测要进认知链时必须有一条对话/观测侧的行来背书它。
 */
const V11_AXIS_B_VOCAB_TABLES = ['conversation_events'] as const

/**
 * 重建 Axis B 三个词表约束，把它们**扩展**到含故事来源。
 *
 * ============================================================================
 *  为什么必须是"drop + add"而不是改 0007
 * ============================================================================
 * 0007 的语句文本是**已发布的历史 DDL**（`FROZEN_MIGRATION_FINGERPRINTS` 逐条锁着）：
 * 改它一个字，已经升级过的库与新库对"什么值合法"就会给出不同答案 —— 那是最难查的一类事故。
 * 因此扩展只能**往前追加**：新迁移把约束换成更宽的那一版。
 *
 * ⚠️ **宽度是单调的**：这里只**添加**值，永远不删。
 * 删值会让库里已有的行变成非法，而 append-only 的表不允许"事后反悔"。
 *
 * ⚠️ `drop constraint if exists` 是**幂等**的：迁移本身由版本表保证只跑一次，
 * 但幂等让"手工重跑 / 副本升级"这类操作不会因为约束已换过而炸掉。
 */
function v11AxisBWideningStatements(): string[] {
  const statements: string[] = []
  const widened: readonly { column: string; suffix: string; values: readonly string[] }[] = [
    { column: 'source_kind', suffix: 'source_kind_vocab', values: [...SOURCE_KIND_VALUES, ...V11_STORY_SOURCE_KIND_VALUES] },
    {
      column: 'source_authority',
      suffix: 'source_authority_vocab',
      values: [...SOURCE_AUTHORITY_VALUES, ...V11_STORY_SOURCE_AUTHORITY_VALUES],
    },
    {
      column: 'epistemic_source',
      suffix: 'epistemic_source_vocab',
      values: [...EPISTEMIC_SOURCE_VALUES, ...V11_STORY_EPISTEMIC_SOURCE_VALUES],
    },
  ]
  for (const table of V11_AXIS_B_VOCAB_TABLES) {
    for (const item of widened) {
      statements.push(`alter table ${table} drop constraint if exists ${table}_${item.suffix}`)
      statements.push(
        `alter table ${table} add constraint ${table}_${item.suffix} check (` +
          `${item.column} is null or ${item.column} in (${sqlValueList(item.values)}))`
      )
    }
  }
  return statements
}

/**
 * 0011 —— 后 Lv2 · S1（世界线的**来源词汇**）。
 *
 * 范围：只把三个 Axis B 词表扩展到含 `story_fact` / `STORY_OBSERVATION` /
 * `story_experience`。**不改**任何列、不加表、不动 Fact Firewall、
 * 不动 `SOURCE_KIND_BY_EVENT_FAMILY`（故事来源不是对话事件族）。
 *
 * ⚠️ **本迁移不做**的事（都要单独裁）：
 *   · 不激活任何开关（`CHARACTER_*` 一个都不碰）；
 *   · 不写任何行（没有数据迁移，没有回填）；
 *   · 不打开真实库（应用与否由既有程序与用户授权决定）。
 *
 * 回滚：`drop constraint` + 用 0007 的窄词表重建。**没有** down 迁移 ——
 * 与 0008/0009 同一条纪律（本仓库不写 down）。
 */
const MIGRATION_0011: Migration = {
  version: 11,
  name: 'post-lv2-story-source-vocab',
  statements: [...v11AxisBWideningStatements()],
}

/**
 * `0012` —— 后 Lv2 · S8：**世界提交的持久账本**（ADR-093 `D01`）。
 *
 * ============================================================================
 *  它解决什么
 * ============================================================================
 * `PL2-SR-01`（ADR-092）实测到：世界事实**没有自己的持久账本**，权威只在运行期状态与
 * 快照里 ⇒ 故事经历到不了根解析，也到不了各类消费者。本迁移补上两张表：
 *
 * ```text
 * storyline_commits        一次**已提交**的世界变更（提交身份 = 根身份）
 * storyline_observations   剧情可见条目 → 承载它的那次提交
 * ```
 *
 * ⚠️ **为什么观测要单独一张表**：一次提交可以产生**多个**可见条目，而"一个提交
 * 产生多个可见条目，不能因此变成多个独立根"（计划书 §3.1）必须在**数据层**可判定
 * —— 做法就是让所有观测都指向同一个 `parent_commit_id`（`S8-A03`）。
 *
 * ⚠️ **本迁移不做**的事：
 *   · 不激活任何开关（`CHARACTER_*` 一个都不碰）；
 *   · 不写任何行（没有数据迁移、没有回填 —— 旧来源**不回填**，按 `story_root_unconfirmed` 拒收）；
 *   · 不打开真实库（应用与否由既有程序与用户授权决定，WP9 另裁）；
 *   · 不加外键（本仓库既有 DDL 一律不用 FK：append-only 表靠**显式完整性探针**分工，
 *     结构性缺口由门报出来，而不是靠级联删除掩盖）。
 *
 * 回滚：`drop table`。**没有** down 迁移 —— 与 0008/0009/0011 同一条纪律。
 */
const V12_STORY_EVENT_TYPE_VALUES = [
  'STORY_STARTED',
  'STAGE_ENTERED',
  'CHOICE_COMMITTED',
  'VARIABLE_CHANGED',
  'EXPERIENCE_OBSERVED',
  'ENDING_REACHED',
  'RUN_EXITED',
] as const

/** 世界事件类型的词表约束（`story-types.ts` 的受控登记表在 DDL 侧的形态） */
function v12EventTypeCheck(table: string): string {
  return (
    `alter table ${table} add constraint ${table}_event_type_vocab check (` +
    `event_type in (${sqlValueList([...V12_STORY_EVENT_TYPE_VALUES])}))`
  )
}

const MIGRATION_0012: Migration = {
  version: 12,
  name: 'post-lv2-s8-story-ledger',
  statements: [
    `create table if not exists storyline_commits (
       commit_id                    text    primary key,
       story_id                     text    not null,
       story_version                integer not null,
       run_id                       text    not null,
       revision                     integer not null,
       event_id                     text    not null,
       event_type                   text    not null,
       choice_id                    text,
       from_node_id                 text    not null,
       to_node_id                   text    not null,
       stage                        text    not null,
       variables_after              jsonb   not null,
       new_visible_events           jsonb   not null,
       ending                       text,
       ending_rule                  text,
       content_digest               text    not null,
       committed_at                 bigint  not null,
       recorded_at                  bigint  not null,
       interaction_kind             text    not null,
       interaction_ref              text,
       anchor_conversation_event_id text,
       actor_kind                   text    not null,
       actor_id                     text,
       idempotency_key              text    not null,
       schema_version               integer not null,
       constraint storyline_commits_run_revision_unique
         unique (story_id, story_version, run_id, revision),
       constraint storyline_commits_idempotency_unique unique (idempotency_key),
       constraint storyline_commits_revision_positive check (revision >= 1),
       constraint storyline_commits_story_version_positive check (story_version >= 1),
       constraint storyline_commits_interaction_kind_vocab
         check (interaction_kind in ('user_choice', 'system')),
       constraint storyline_commits_actor_kind_vocab check (actor_kind in ('user', 'system')),
       /*
        * 绑定形状（ADR-093 D01 的"服务端保存可信参与者与真实交互归属"在 DDL 侧的形态）：
        *   user_choice ⇒ 必须有会话 + 触发对话事件，且 actor 必须是 user
        *   system      ⇒ **不得**夹带会话（否则"后台推进"会看起来像一次真实会话，S8-A14）
        * 与 kernel 的 assertStoryCommitBinding 是**同一条判据的两次表达**（失败关闭，不互相替代）。
        */
       constraint storyline_commits_binding_shape check (
         (interaction_kind = 'user_choice'
            and interaction_ref is not null
            and anchor_conversation_event_id is not null
            and actor_kind = 'user')
         or
         (interaction_kind = 'system'
            and interaction_ref is null)
       )
     )`,

    `create index if not exists storyline_commits_run
       on storyline_commits (story_id, run_id, revision)`,

    /*
     * `D05`/`R-4`：故事根的因果身份键落在**触发它的真实对话事件**上
     * ⇒ "同一次选择的对话根与故事根同键"这条查询必须走得动。
     */
    `create index if not exists storyline_commits_anchor
       on storyline_commits (anchor_conversation_event_id)`,

    `create table if not exists storyline_observations (
       observation_id   text    primary key,
       parent_commit_id text    not null,
       story_id         text    not null,
       story_version    integer not null,
       run_id           text    not null,
       event_id         text    not null,
       created_at       bigint  not null,
       constraint storyline_observations_event_unique
         unique (story_id, story_version, run_id, event_id)
     )`,

    `create index if not exists storyline_observations_parent
       on storyline_observations (parent_commit_id)`,

    /** 词表约束用 `drop + add` 追加（与 `0011` 扩 Axis B 同形、幂等、只加不删） */
    `alter table storyline_commits drop constraint if exists storyline_commits_event_type_vocab`,
    v12EventTypeCheck('storyline_commits'),
  ],
}

/**
 * **S8 / ADR-093 `D13` · ADR-094 `D03`（裁定 = A）** —— 故事消费的**独立水位**。
 *
 * ```text
 * 每条 (consumer, story_id, run_id) 一行 ⇒ 三个消费者各走各的水位，互不阻挡、互不跳过
 * 只许前进、不许跳号由**代码**判（见 kernel/storyline/story-watermark.ts 的 nextStoryWatermark），
 *   这里只用 CHECK 兜住"非负"与"词表"两条**结构性**约束
 * 消费者闭集用 CHECK 锁住：新增消费者必须同时改 `STORY_CONSUMERS` 与这条约束
 *   （只改一边 ⇒ 写入被拒，正是想要的失败方向）
 * ```
 */
const MIGRATION_0013: Migration = {
  version: 13,
  name: 'post-lv2-s8-story-consumer-watermarks',
  statements: [
    `create table if not exists storyline_consumer_watermarks (
       consumer                text    not null,
       story_id                text    not null,
       run_id                  text    not null,
       last_consumed_revision  integer not null,
       last_commit_id          text,
       consumed_at             bigint  not null,
       updated_at              bigint  not null,
       schema_version          integer not null,
       primary key (consumer, story_id, run_id),
       constraint storyline_watermarks_revision_nonneg check (last_consumed_revision >= 0),
       constraint storyline_watermarks_schema_version_positive check (schema_version >= 1),
       constraint storyline_watermarks_consumer_vocab
         check (consumer in ('affect', 'relationship', 'reflection')),
       /*
        * 水位 0 = "还没消费任何一条" ⇒ 此时**不得**带提交身份
        * （带了说明写入方把"没消费"和"消费了第 0 条"混为一谈）。
        */
       constraint storyline_watermarks_commit_iff_consumed
         check ((last_consumed_revision = 0) = (last_commit_id is null))
     )`,
    `create index if not exists storyline_watermarks_by_run
       on storyline_consumer_watermarks (story_id, run_id)`,
  ],
}

/**
 * 0014 —— post-Lv2 / **QQ 主动联系**：通知意图 + 通知实例（ADR-110 `D07`）。
 *
 * ============================================================================
 *  为什么必须是**两张**表（而不是复用 `character_jobs`）
 * ============================================================================
 * ```text
 * notification_intents      本人要求过的一件事（提醒）或一次许可登记（关心）+ 排期
 * notification_occurrences  某一次**具体的**外发尝试（含交付真相与平台回执）
 * ```
 * `character_jobs` 只管"处理尝试的运行状态"，**`job.completed` 不等于已送达** ——
 * 把交付真相塞进 `last_error`/`status` 会把两种事实混成一种（ADR-110 `D07`）。
 *
 * ============================================================================
 *  三条**结构性**不变量（都写成 CHECK，而不是"写入方记得别写错"）
 * ============================================================================
 * ```text
 * ① 提醒必有正文与来源；关心两者皆无
 *    （关心没有用户请求、候选正文只活在实例行上）
 * ② api_accepted ⇔ platform_message_id 有值
 *    （"接口接受"这件事的**唯一**凭据就是那个回执 id；没有它就不许记成接受）
 * ③ 候选长度的上下界
 *    （有界正文是硬要求：它要发到真人手机上）
 * ```
 * 先例：`storyline_consumer_watermarks` 的 `(last_consumed_revision = 0) = (last_commit_id is null)`
 * （同一种"两种状态互斥且穷尽"的写法）。
 *
 * ============================================================================
 *  ⚠️ 两条**刻意不做**的事
 * ============================================================================
 * ```text
 * · **不用外键** —— 本仓库既有 DDL 一律不用 FK（0001–0013 的约定）
 * · **不照抄** `character_action_events_idempotency` 那种**非唯一**索引：
 *   发送幂等靠实例行的主键/唯一键**兜底**，不靠"折叠 + 查询"
 * ```
 */
const MIGRATION_0014: Migration = {
  version: 14,
  name: 'post-lv2-qq-proactive-notifications',
  statements: [
    // ---- 通知意图 --------------------------------------------------------
    `create table if not exists notification_intents (
       id                  text    primary key,
       character_id        text    not null,
       owner_ref           text    not null,
       conversation_ref    text    not null,
       kind                text    not null,
       status              text    not null,
       source_refs         jsonb   not null,
       has_source          boolean not null,
       scheduled_at        bigint  not null,
       timezone            text    not null,
       plan_version        integer not null,
       permission_version  text    not null,
       policy_version      text    not null,
       text                text,
       text_fingerprint    text,
       dedupe_key          text    not null,
       created_at          bigint  not null,
       updated_at          bigint  not null,
       schema_version      integer not null,
       constraint notification_intents_kind_vocab check (kind in ('reminder', 'care')),
       constraint notification_intents_status_vocab
         check (status in ('pending', 'delivered', 'cancelled', 'expired', 'missed')),
       constraint notification_intents_plan_version_positive check (plan_version >= 1),
       constraint notification_intents_schema_version_positive check (schema_version >= 1),
       /*
        * ① 提醒必有正文与来源；关心两者皆无。
        *    "关心"没有用户请求（所以没有来源），它的候选正文只活在实例行上。
        */
       constraint notification_intents_reminder_has_text
         check ((kind = 'reminder') = (text is not null)),
       constraint notification_intents_reminder_has_source
         check ((kind = 'reminder') = has_source),
       constraint notification_intents_fingerprint_iff_text
         check ((text is null) = (text_fingerprint is null))
     )`,
    /*
     * "同一件事不许排两次"：**部分唯一索引**只覆盖 `pending`。
     * ⚠️ 与 `character_jobs_idempotency_active` 同一个形状与同一个理由：
     *    终态（delivered/cancelled/expired/missed）不挡住"本人后来又要了一次"。
     */
    `create unique index if not exists notification_intents_active_dedupe
       on notification_intents (dedupe_key)
       where status = 'pending'`,
    `create index if not exists notification_intents_due
       on notification_intents (character_id, status, scheduled_at)`,

    // ---- 通知实例 --------------------------------------------------------
    `create table if not exists notification_occurrences (
       occurrence_key        text    primary key,
       intent_id             text,
       character_id          text    not null,
       kind                  text    not null,
       state                 text    not null,
       due_at                bigint  not null,
       attempt               integer not null,
       candidate_text        text,
       candidate_fingerprint text,
       candidate_length      integer,
       assistant_event_id    text,
       platform_message_id   text,
       reason_code           text,
       permission_version    text    not null,
       policy_version        text    not null,
       created_at            bigint  not null,
       updated_at            bigint  not null,
       schema_version        integer not null,
       constraint notification_occurrences_kind_vocab check (kind in ('reminder', 'care')),
       constraint notification_occurrences_state_vocab
         check (state in ('pending', 'evaluating', 'prepared', 'dispatching', 'api_accepted',
                          'skipped', 'cancelled', 'expired', 'failed_confirmed', 'delivery_unknown')),
       constraint notification_occurrences_attempt_positive check (attempt >= 1),
       constraint notification_occurrences_schema_version_positive check (schema_version >= 1),
       /*
        * ② "接口接受"的唯一凭据是平台回执 id：两者**同真同假**。
        *    反过来也成立 —— 不许带着 message_id 却说自己没被接受。
        */
       constraint notification_occurrences_accepted_iff_message_id
         check ((state = 'api_accepted') = (platform_message_id is not null)),
       constraint notification_occurrences_candidate_pairing
         check ((candidate_text is null) = (candidate_fingerprint is null)),
       constraint notification_occurrences_candidate_length_pairing
         check ((candidate_text is null) = (candidate_length is null)),
       constraint notification_occurrences_candidate_length_bounds
         check (candidate_length is null or (candidate_length >= 1 and candidate_length <= 500)),
       /* 提醒的实例必须挂在一条意图上；关心的实例不挂（它由机会键锚定） */
       constraint notification_occurrences_reminder_has_intent
         check (kind = 'care' or intent_id is not null)
     )`,
    `create index if not exists notification_occurrences_by_intent
       on notification_occurrences (intent_id, due_at)`,
    /*
     * 额度与"跨日"读的索引：`(character_id, kind, due_at)` 让"某角色某类在某日窗口里发了几条"
     * 只扫一小段；状态过滤交给列本身（十个状态里只有四个占额）。
     */
    `create index if not exists notification_occurrences_quota
       on notification_occurrences (character_id, kind, state, due_at)`,
    /* 重启时找遗留 `dispatching`（ADR-110 D08 表格最后一行） */
    `create index if not exists notification_occurrences_by_state
       on notification_occurrences (state, updated_at)`,
  ],
}

/**
 * 0015 —— post-Lv2 / **QQ 主动联系**：用户控制面（ADR-110 `D13`）。
 *
 * ============================================================================
 *  为什么"暂停"必须**落库**（而不是一个开关变量）
 * ============================================================================
 * 计划 §8 WP3 的通过条件里有"**重启不漏恢复**"，§6 又有"停用后未外发项停止"。
 * 若暂停只活在内存里，一次重启就会让"她正在暂停"变成"她又在发了" ——
 * 那不是配置问题，而是**违逆本人明确意图**。⇒ 单行状态表。
 *
 * ============================================================================
 *  结构性不变量：三件事**同真同假**
 * ============================================================================
 * ```text
 * paused ⇔ paused_at is not null ⇔ pause_reason is not null
 * ```
 * · "暂停了但不知道从什么时候起、为什么" ⇒ 拒绝（那是不可审计的暂停）
 * · "恢复了却还留着暂停时刻/理由" ⇒ 拒绝（那会让"现在到底停没停"有两种答案）
 * 先例：`storyline_consumer_watermarks` 的 `(rev = 0) = (commit_id is null)`。
 */
const MIGRATION_0015: Migration = {
  version: 15,
  name: 'post-lv2-qq-proactive-control',
  statements: [
    `create table if not exists notification_control (
       character_id       text    primary key,
       paused             boolean not null,
       paused_at          bigint,
       pause_reason       text,
       permission_version text    not null,
       policy_version     text    not null,
       updated_at         bigint  not null,
       schema_version     integer not null,
       constraint notification_control_pause_pairing
         check (paused = (paused_at is not null)),
       constraint notification_control_pause_reason_pairing
         check ((paused_at is null) = (pause_reason is null)),
       constraint notification_control_schema_version_positive check (schema_version >= 1)
     )`,
    /*
     * 暂停必须带理由（不能只有时刻）：`pause_pairing` 已经保证"有 paused_at 就 paused"，
     * 这条再保证"有 paused_at 就有原因"。
     */
    `alter table notification_control
       add constraint notification_control_pause_needs_reason
       check (paused_at is null or (pause_reason is not null and length(trim(pause_reason)) > 0))`,
  ],
}

/**
 * post-Lv2 / ADR-110 `D03`：关心的 **`defer`（"过一会儿再说"）要能落库**。
 *
 * ============================================================================
 *  为什么必须是**新迁移**而不是改 0014
 * ============================================================================
 * ```text
 * 0014 的 DDL 已经发布过，`create table if not exists` 会让"改了既有 DDL"
 * **静默失效**（已应用的库不会再跑一遍）⇒ 只能往后追加一条。
 * ```
 * ⚠️ **加列而不是加表**：这一格与实例行是**一对一**的（一次机会最多一个改期），
 *    单开一张表就要自己维护外键般的配对关系，而配对正是"一行一列"已经免费保证的事。
 * ⚠️ `add column if not exists`：迁移在**已存在的库**上会重跑（幂等），
 *    没有 `if not exists` 会让第二次启动直接报错。
 * ⚠️ 只加列、**不**加约束：`deferred_until` 的语义是"到那个时刻之前别再问"，
 *    它与 `state` 是**正交**的（一个实例行可以在任何非终态上带着一个改期时刻），
 *    在这里写 `check` 会把"正交"表达成"耦合"，日后想放宽就得再写一条迁移。
 */
const MIGRATION_0016: Migration = {
  version: 16,
  name: 'post-lv2-qq-proactive-care-defer',
  statements: [
    `alter table notification_occurrences
       add column if not exists deferred_until bigint`,
    /*
     * 改期的**查询口**：tick 每次都要问"现在有没有一条还压着的改期"，
     * 所以按 (character_id, deferred_until) 建索引，而不是全表扫。
     */
    `create index if not exists notification_occurrences_deferred_lookup
       on notification_occurrences (character_id, deferred_until)`,
  ],
}

/** Existing reminders retain their original QQ destination. Source conversation stays independent. */
const MIGRATION_0017: Migration = {
  version: 17,
  name: 'reminder-delivery-channel',
  statements: [
    `alter table notification_intents add column if not exists delivery_channel text not null default 'qq_private'
       check (delivery_channel in ('qq_private', 'avatar', 'cli'))`,
  ],
}

/**
 * ★ S3/S4（ADR-129 `D05`/`D07`）：把"要不要重复"与"已投递几次"**落库**。
 *
 * ============================================================================
 *  为什么非落库不可
 * ============================================================================
 *  `D07` 要求失败/未回应的情形**含跨重启**适用 ⇒ 重复状态不能只活在内存里
 *  （进程一停就丢 = 重启后又变成"没续发"，而用户明明要求过"直到我回复"）。
 *
 * ```text
 * notification_intents.repeat_mode        'once' | 'until_reply' | null（null = 旧行，行为等同 once）
 * notification_occurrences.repeat_attempt 这条提醒**已投递过的次数**（首次 = 1；≥10 停）
 * ```
 *
 * ⚠️ 与 `0016` 同一条纪律：**只加列 +（闭集）约束**，不把"正交"表达成耦合。
 *     `repeat_mode` 的闭集**允许 null**（旧行从不重复）⇒ 写成 `is null or in (…)`（先例 `0017`）。
 *     `repeat_attempt` 不加约束（先例 `0016` 的 `deferred_until`）。
 */
const MIGRATION_0018: Migration = {
  version: 18,
  name: 'reminder-repeat-mode-and-attempt',
  statements: [
    `alter table notification_intents add column if not exists repeat_mode text
       check (repeat_mode is null or repeat_mode in ('once', 'until_reply'))`,
    `alter table notification_occurrences add column if not exists repeat_attempt integer`,
  ],
}

/**
 * **多用户补充计划 U1 / WP4（`ADR-137` 方案 B，2026-10-14 原主人裁定）**：
 * 记录的**归属 + 披露**标签放在 `memory_records` **之外**。
 *
 * ```text
 * MemoRecord / 事件 payload **一字不改**：标签是**授权元数据**，不是记录内容
 *   ⇒ `rebuildMemory()` **不**重算标签（重建前后标签行逐字节不变）
 *   ⇒ 迁移**不**给旧记录回填 origin（宁可按最保守的 private_to_origin，也不编一个来源）
 * ```
 *
 * ⚠️ `record_kind` 首版只有 `'memory'`（留种类，便于日后扩到附件/日志）；
 *    它**不是**外键：标签行与被标记录是两条独立事实（谁先谁后都合法，缺标签时按缺省保守处理）。
 */
const MIGRATION_0019: Migration = {
  version: 19,
  name: 'u1-record-scope-labels',
  statements: [
    `create table if not exists record_scope_labels (
       record_kind       text   not null,
       record_id         text   not null,
       origin_room_kind  text   not null,
       origin_room_id    text   not null,
       disclosure        text   not null,
       labeled_at        bigint not null,
       labeled_by        text   not null,
       primary key (record_kind, record_id),
       check (record_kind in ('memory')),
       check (origin_room_kind in ('private', 'group')),
       check (origin_room_id <> ''),
       check (disclosure in ('private_to_origin', 'explicit_shared', 'public_to_room', 'character_internal')),
       check (labeled_by <> '')
     )`,
    /* 按"来源域"反查：`U1` 需要回答"这个 room 里有哪些记录" */
    `create index if not exists record_scope_labels_by_origin
       on record_scope_labels (record_kind, origin_room_kind, origin_room_id)`,
  ],
}

/**
 * A1 / WP4：管理后台的**最小任务记录**（`ADR-135` `R-A1-3`，用户 2026-10-14 批准 + 同日授权应用）。
 *
 * ```text
 * 承载    job_id / operator（可信操作者）/ kind / idempotency_key / params_fingerprint /
 *         state（闭集，与 `admin-ports/jobs.ts` 的 `JOB_STATES` **逐字一致**）/ result_ref / 时间戳
 * 幂等    靠**唯一约束**（`idempotency_key` 唯一索引），不是靠提示词或进程内缓存
 * 状态    check 里写死闭集 ⇒ 库层兜一次（与端口层同一份语义；门里有交叉判据）
 * ⚠️ 它**不**保证外部副作用恰好一次（`R-A1-3` 逐字）：持久记录只保证"同一幂等键不会开出第二个任务"
 * ```
 */
const MIGRATION_0020: Migration = {
  version: 20,
  name: 'a1-admin-jobs',
  statements: [
    `create table if not exists admin_jobs (
       job_id              text   primary key,
       operator            text   not null,
       kind                text   not null,
       idempotency_key     text   not null,
       params_fingerprint  text   not null,
       state               text   not null,
       result_ref          text,
       created_at          bigint not null,
       updated_at          bigint not null,
       check (operator <> ''),
       check (kind <> ''),
       check (idempotency_key <> ''),
       check (params_fingerprint <> ''),
       check (state in ('pending', 'running', 'succeeded', 'failed', 'interrupted'))
     )`,
    /* 幂等键唯一：**这就是**"重复提交返回原任务"的机器保证 */
    `create unique index if not exists admin_jobs_idempotency
       on admin_jobs (idempotency_key)`,
    /* 按状态看"还在跑/中断待核验"的任务 */
    `create index if not exists admin_jobs_state
       on admin_jobs (state, updated_at)`,
  ],
}

const MIGRATION_0021: Migration = {
  version: 21,
  name: 'multi-user-conversation-rooms',
  statements: [
    `create table if not exists conversation_rooms (
      conversation_id text primary key, character_id text not null,
      room_kind text not null check (room_kind in ('private','group')),
      room_id text not null check (room_id <> ''))`,
    `create index if not exists conversation_rooms_room on conversation_rooms (character_id, room_kind, room_id)`,
    `create table if not exists room_participants (
      character_id text not null, room_kind text not null check (room_kind in ('private','group')),
      room_id text not null check (room_id <> ''), user_id text not null check (user_id <> ''),
      primary key (character_id, room_kind, room_id, user_id))`,
    `create table if not exists scope_read_audit (
      audit_id text primary key, operator_id text not null, target_ids jsonb not null,
      purpose text not null, created_at bigint not null)`,
    // Keep content fingerprints/reducers unchanged; new IDs already encode the source room.
    // Legacy IDs share their original uniqueness domain. Rebuild retains the same IDs.
    `drop index if exists memory_records_active_fingerprint`,
    `create unique index memory_records_active_fingerprint
      on memory_records (owner_kind, owner_id, content_fingerprint,
        coalesce(substring(id from ':room-[a-f0-9]{16}$'), 'legacy')) where status = 'active'`,
  ],
}

const MIGRATION_0022: Migration = {
  version: 22, name: 'multi-user-scoped-read-rls',
  statements: [
    `alter table memory_records enable row level security`,
    `alter table memory_records force row level security`,
    `create policy memory_scope_read on memory_records for select using (
      coalesce(current_setting('lg.scope_mode', true), '') <> 'external_query' or (
        exists (select 1 from record_scope_labels l where l.record_kind='memory' and l.record_id=memory_records.id
          and l.origin_room_kind=current_setting('lg.room_kind', true) and l.origin_room_id=current_setting('lg.room_id', true)
          and l.disclosure in ('private_to_origin','public_to_room'))
        or (current_setting('lg.room_kind', true)='private' and current_setting('lg.room_id', true)=current_setting('lg.owner_user_id', true)
          and not exists (select 1 from record_scope_labels l where l.record_kind='memory' and l.record_id=memory_records.id))
        or (current_setting('lg.room_kind',true)='private' and current_setting('lg.room_id',true)=current_setting('lg.owner_user_id',true)
          and exists (select 1 from scope_read_audit a join record_scope_labels l on a.target_ids ? l.origin_room_id
            where a.audit_id=current_setting('lg.scope_audit_id',true) and a.operator_id=current_setting('lg.owner_user_id',true)
              and l.record_kind='memory' and l.origin_room_kind='private' and l.record_id=memory_records.id))))`,
    `create policy memory_scope_insert on memory_records for insert with check (true)`,
    `create policy memory_scope_update on memory_records for update using (true) with check (true)`,
    `create policy memory_scope_delete on memory_records for delete using (true)`,
    `alter table conversation_events enable row level security`,
    `alter table conversation_events force row level security`,
    `create policy conversation_scope_read on conversation_events for select using (
      coalesce(current_setting('lg.scope_mode', true), '') <> 'external_query' or (
        exists (select 1 from conversation_rooms r where r.conversation_id=conversation_events.conversation_id
          and r.room_kind=current_setting('lg.room_kind', true) and r.room_id=current_setting('lg.room_id', true))
        or (current_setting('lg.room_kind', true)='private' and current_setting('lg.room_id', true)=current_setting('lg.owner_user_id', true)
          and not exists (select 1 from conversation_rooms r where r.conversation_id=conversation_events.conversation_id))
        or (current_setting('lg.room_kind',true)='private' and current_setting('lg.room_id',true)=current_setting('lg.owner_user_id',true)
          and exists (select 1 from scope_read_audit a join conversation_rooms r on a.target_ids ? r.room_id
            where a.audit_id=current_setting('lg.scope_audit_id',true) and a.operator_id=current_setting('lg.owner_user_id',true)
              and r.room_kind='private' and r.conversation_id=conversation_events.conversation_id))))`,
    `create policy conversation_scope_insert on conversation_events for insert with check (true)`,
    `create policy conversation_scope_update on conversation_events for update using (true) with check (true)`,
  ],
}

/** 全部迁移，按版本升序。新增迁移**只许往后追加**。 */
export const MIGRATIONS: readonly Migration[] = [
  MIGRATION_0001,
  MIGRATION_0002,
  MIGRATION_0003,
  MIGRATION_0004,
  MIGRATION_0005,
  MIGRATION_0006,
  MIGRATION_0007,
  MIGRATION_0008,
  MIGRATION_0009,
  MIGRATION_0010,
  MIGRATION_0011,
  MIGRATION_0012,
  MIGRATION_0013,
  MIGRATION_0014,
  MIGRATION_0015,
  MIGRATION_0016,
  MIGRATION_0017,
  MIGRATION_0018,
  MIGRATION_0019,
  MIGRATION_0020,
  MIGRATION_0021,
  MIGRATION_0022,
]

export function latestSchemaVersion(): number {
  return MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0)
}

export function assertMigrationsWellFormed(): void {
  let previous = 0
  for (const migration of MIGRATIONS) {
    if (migration.version !== previous + 1) {
      throw new KernelError(
        'validation_error',
        'migration_version_gap',
        `迁移版本必须从 1 起严格连续递增：期望 ${previous + 1}，收到 ${migration.version}`
      )
    }
    if (migration.statements.length === 0) {
      throw new KernelError(
        'validation_error',
        'migration_empty',
        `迁移 ${migration.version}（${migration.name}）没有任何语句`
      )
    }
    previous = migration.version
  }
}
