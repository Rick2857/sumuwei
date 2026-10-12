/**
 * M9.5 —— 派生索引的 **DDL 叶子模块**（`memory_semantic_*` 的建表语句）。
 *
 * ============================================================================
 *  为什么它必须是一个**没有 import** 的叶子模块（2026-09-30 实测的循环依赖）
 * ============================================================================
 * ```text
 * 原本这些常量住在 `memory-semantic-index.ts` 里，而那个模块 import 了 `./db.ts`
 * （要 `rowsOf`）。同时 `migrations.ts` 又在**模块顶层**读 `SEMANTIC_INDEX_DDL`
 * （`MIGRATION_0010` 的 `statements` 是模块级对象字面量）⇒ 于是存在一个环：
 *
 *     memory-semantic-index.ts  →  db.ts  →  migrations.ts  →  memory-semantic-index.ts
 *
 * 环本身不致命，**致命的是求值顺序**：只要入口先 import `memory-semantic-index.ts`，
 * 就会走到 migrations.ts 的模块体**先于** DDL 常量完成初始化 ⇒
 * `ReferenceError: Cannot access 'SEMANTIC_INDEX_DDL' before initialization`（TDZ）。
 *
 * 实测：`pnpm m9.5:test` 因此**整道门跑不起来**（`scripts/m9.5-contract-tests.ts`
 * 第 31 行先 import `memory-semantic-index.ts`）—— 而 `pnpm m9.5:gates` 仍是 PASS，
 * 因为它按设计**只读已落盘的旧证据**（与 `L-M10-59` 同一个形状）。
 *
 * ⇒ 修法：把 DDL 常量搬到**不 import 任何东西**的叶子里，
 *   让 `migrations.ts` 从**叶子**取（而不是从那个会牵出 db.ts 的模块取）⇒ 环断开。
 *   `memory-semantic-index.ts` 继续 **re-export**，既有调用方一行都不用改。
 * ```
 *
 * ⚠️ 本文件**不许 import 任何东西**（连 `node:*` 也不行）：它是断环的那一刀。
 */

/** `memory_semantic_meta` 的单例行主键（防止出现两行"当前版本"） */
export const SEMANTIC_META_ID = 'semantic-index'

/**
 * 建表语句 —— **唯一来源**。建表器与 `pnpm m9.5:index:verify` / `pnpm m9.5:migration:verify`
 * 都从这里取，避免"门里那份 DDL 与生产那份不一致"的漂移。
 *
 * 全部是 `create … if not exists`：**幂等**，且**不触碰任何既有对象**
 * （没有 `alter` / `update` / `insert` / `delete`，所以不回填、不改既有行）。
 */
export const SEMANTIC_INDEX_DDL: readonly string[] = [
  `create table if not exists memory_semantic_meta (
     id                   text    primary key,
     index_schema_version integer not null,
     updated_at           bigint  not null,
     constraint memory_semantic_meta_singleton check (id = '${SEMANTIC_META_ID}'),
     constraint memory_semantic_meta_version_positive check (index_schema_version > 0)
   )`,

  `create table if not exists memory_semantic_generations (
     generation_id            text    primary key,
     namespace                text    not null,
     model_fingerprint        text    not null,
     renderer_version         text    not null,
     dimension                integer not null,
     index_schema_version     integer not null,
     build_state              text    not null,
     processed_watermark      integer not null default 0,
     eligible_source_count    integer not null default 0,
     pending_count            integer not null default 0,
     failed_count             integer not null default 0,
     excluded_by_policy_count integer not null default 0,
     created_at               bigint  not null,
     published_at             bigint,
     constraint memory_semantic_generations_state_vocab
       check (build_state in ('building','published','unavailable')),
     constraint memory_semantic_generations_dimension_positive check (dimension > 0)
   )`,

  `create table if not exists memory_semantic_index (
     namespace             text    not null,
     memory_id             text    not null,
     source_revision       integer not null,
     generation_id         text    not null,
     model_fingerprint     text    not null,
     renderer_version      text    not null,
     content_hash          text    not null,
     tokenizer_fingerprint text    not null,
     pooling               text    not null,
     normalize             boolean not null,
     dtype                 text    not null,
     dimension             integer not null,
     embedding             vector(384) not null,
     created_at            bigint  not null,
     primary key (namespace, memory_id, source_revision, model_fingerprint, generation_id),
     constraint memory_semantic_index_dimension_matches check (dimension = 384)
   )`,

  `create index if not exists memory_semantic_index_scope
     on memory_semantic_index (namespace, generation_id, memory_id)`,

  `create table if not exists memory_semantic_failures (
     generation_id   text    not null,
     memory_id       text    not null,
     reason          text    not null,
     attempts        integer not null default 1,
     last_attempt_at bigint  not null,
     primary key (generation_id, memory_id)
   )`,
]
