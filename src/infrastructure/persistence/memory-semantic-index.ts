/**
 * M9.5 —— **语义召回派生索引的 schema 与建表器**（`memory_semantic_*`）。
 *
 * ============================================================================
 *  为什么它**不**走 kernel 迁移链（ADR-074 的 D31）
 * ============================================================================
 * ```text
 * 这条是**设计裁定**，不是省事：
 *  ① 派生索引**不是事实权威**（ADR-074 §1）：删掉这三张表，"她记得什么"一个字段都不变
 *     —— 它们可以从事件重放重建。而 AGENTS §3 的迁移纪律是为**事实** schema 设的
 *     （"`create table if not exists` 会让后续修改静默失效"防的是**既有事实表**被悄悄改）。
 *  ② kernel 迁移链每追加一条，就会让 M5.1.1 那些"最新 schema = 9"的写死断言变红
 *     （实测约 25 处 / 20 个文件，其中 10 道门在别的环境里无法复跑）——
 *     把**可重建的派生结构**绑到**事实 schema 的版本轴**上，代价与风险不成比例。
 *  ③ 计划 §11.3 自己写的就是「**派生表**迁移」。
 *  ④ 本模块的 `index_schema_version`（该列**已在 ADR-074 §4.1 冻死**）让升级比 kernel 链
 *     **更严**：kernel 链同样不能改既有对象，而这里连"当前装的是哪一版"都是显式数据。
 * ```
 * ⚠️ **偏离计划的字面**（§12 WP4「新增迁移编号取 max+1」/§19.3「实际新编号由完整迁移链决定」）
 *    已如实登记在 `docs/m9.5/M9.5-WP4-Preflight.md` §6.5 与 ADR-074 的 D31。
 *
 * ============================================================================
 *  它与真实库的关系（**安全边界一条都没放松**）
 * ============================================================================
 * ```text
 * · 本模块只提供"建/升派生 schema"的**纯函数**；它**不打开任何数据库**。
 * · 谁调用它、在哪个库上调用，仍由既有入口决定：真实库必须走 INC-01 的
 *   租约 → pre-open verified snapshot → token 那条路（AGENTS §5.1）。
 * · 失败关闭：记到的版本比代码**新** ⇒ **拒绝**（不建、不改、不降级）。
 * ```
 *
 * 用法（调用方负责库的选择与授权）：
 * ```ts
 * const status = await semanticIndexSchemaStatus(db)
 * const result = await ensureSemanticIndexSchema(db, { now: Date.now() })
 * ```
 */

import { sql } from 'drizzle-orm'

import type { RawDb } from './db.ts'
import { rowsOf } from './db.ts'

/**
 * **代码认识的**派生 schema 版本。
 * 改这个数 = 一次有意的升级声明；升级步骤写进 `SEMANTIC_INDEX_UPGRADES`。
 */
export const SEMANTIC_INDEX_SCHEMA_VERSION = 2

/*
 * ⚠️ **DDL 常量已搬到叶子模块** `./semantic-index-ddl.ts`（2026-09-30）：
 * 它们原本就住在这里，而本模块 import 了 `./db.ts`（要 `rowsOf`），
 * `migrations.ts` 又在模块顶层读 `SEMANTIC_INDEX_DDL` ⇒ 形成
 * `本模块 → db.ts → migrations.ts → 本模块` 的环，**求值顺序**一碰就 TDZ
 * （实测 `pnpm m9.5:test` 整道门跑不起来）。断环的那一刀见那个文件的头注释。
 *
 * 这里**继续 re-export**，既有调用方（含门）一行都不用改。
 */
import { SEMANTIC_INDEX_DDL, SEMANTIC_META_ID } from './semantic-index-ddl.ts'

export { SEMANTIC_INDEX_DDL, SEMANTIC_META_ID } from './semantic-index-ddl.ts'

/**
 * 升级步骤：`from` ⇒ 该步把 schema 从 `from` 升到 `from + 1`。
 * 当前只有 v1（初建），因此为空。**将来加版本时在这里追加**，
 * 并同步 `SEMANTIC_INDEX_SCHEMA_VERSION`（`assertUpgradesWellFormed()` 会核对两者自洽）。
 */
export const SEMANTIC_INDEX_UPGRADES: Readonly<Record<number, readonly string[]>> = {
  /*
   * M9.5 / 启用计划 —— **持久游标**（2026-10-01）。
   *
   * ```text
   * 计划 §1 WP2 的第 ① 条要的是"**持久游标**"，而在此之前续跑只靠**水位**
   * ⇒ 每轮都要**重扫**源（水位只挡"已处理"，挡不住"重新枚举一遍"）。
   *
   * ⚠️ 为什么这是**派生 schema 的升级**而不是 kernel 迁移：
   *   派生 schema 有**自己的升级轴**（本常量 + `SEMANTIC_INDEX_SCHEMA_VERSION`），
   *   而 `D-31` 的"零迁移"说的是**内核迁移链** ⇒ 两者不是一件事 ✓。
   *
   * ⚠️ 只**追加**一列，不碰任何既有列/行（`add column if not exists` ⇒ 幂等）。
   * 形状：`"<createdAt>:<id>"`（枚举的稳定位置；与 `SourceCursor` 同源）。
   * ```
   */
  1: [
    `alter table memory_semantic_generations
       add column if not exists source_cursor text`,
  ],
}

/** 派生表的维度承诺（换维度 = 新版本 + `alter column`，不许就地改既有列） */
export const SEMANTIC_INDEX_DIMENSION = 384

export type SemanticIndexSchemaAction = 'create' | 'noop' | 'upgrade' | 'refuse-newer'

export interface SemanticIndexSchemaStatus {
  /** `memory_semantic_meta` 存在且可读 */
  readonly metaPresent: boolean
  /** 记到的版本（`metaPresent=false` 时为 `null`） */
  readonly recordedVersion: number | null
  /** 代码认识的版本 */
  readonly expectedVersion: number
  readonly action: SemanticIndexSchemaAction
  readonly detail: string
}

/** 升级表必须与版本常量自洽（缺一步就是"声明了版本却没有升级路径"）。 */
export function assertSemanticIndexUpgradesWellFormed(): void {
  for (let from = 1; from < SEMANTIC_INDEX_SCHEMA_VERSION; from += 1) {
    if ((SEMANTIC_INDEX_UPGRADES[from] ?? []).length === 0) {
      throw new Error(
        `派生索引声明了版本 ${String(SEMANTIC_INDEX_SCHEMA_VERSION)}，却缺少 ${String(from)}→${String(from + 1)} 的升级步骤`
      )
    }
  }
}

async function tableExists(db: RawDb, table: string): Promise<boolean> {
  const rows = rowsOf(
    await db.execute(
      sql`select count(*)::int as c from information_schema.tables
          where table_schema = 'public' and table_name = ${table}`
    )
  )
  return Number(rows[0]?.c ?? 0) > 0
}

/** 只读：当前派生 schema 的状态与"下一步该做什么"。 */
export async function semanticIndexSchemaStatus(db: RawDb): Promise<SemanticIndexSchemaStatus> {
  const metaPresent = await tableExists(db, 'memory_semantic_meta')
  if (!metaPresent) {
    return {
      metaPresent: false,
      recordedVersion: null,
      expectedVersion: SEMANTIC_INDEX_SCHEMA_VERSION,
      action: 'create',
      detail: 'memory_semantic_meta 不存在 ⇒ 尚未建过派生 schema',
    }
  }
  const rows = rowsOf(
    await db.execute(
      sql`select index_schema_version from memory_semantic_meta where id = ${SEMANTIC_META_ID}`
    )
  )
  if (rows.length === 0) {
    return {
      metaPresent: true,
      recordedVersion: null,
      expectedVersion: SEMANTIC_INDEX_SCHEMA_VERSION,
      action: 'create',
      detail: '表在但没有单例行 ⇒ 视为未建（建表器会补）',
    }
  }
  const recorded = Number(rows[0]?.index_schema_version ?? 0)
  if (recorded > SEMANTIC_INDEX_SCHEMA_VERSION) {
    return {
      metaPresent: true,
      recordedVersion: recorded,
      expectedVersion: SEMANTIC_INDEX_SCHEMA_VERSION,
      action: 'refuse-newer',
      detail:
        `记到的派生 schema 版本 ${String(recorded)} 比代码认识的 ${String(SEMANTIC_INDEX_SCHEMA_VERSION)} 更新` +
        '⇒ **失败关闭**：不建、不改、不降级（代码比数据旧时升级会破坏数据）',
    }
  }
  if (recorded < SEMANTIC_INDEX_SCHEMA_VERSION) {
    return {
      metaPresent: true,
      recordedVersion: recorded,
      expectedVersion: SEMANTIC_INDEX_SCHEMA_VERSION,
      action: 'upgrade',
      detail: `记到 ${String(recorded)} ⇒ 需要升到 ${String(SEMANTIC_INDEX_SCHEMA_VERSION)}`,
    }
  }
  return {
    metaPresent: true,
    recordedVersion: recorded,
    expectedVersion: SEMANTIC_INDEX_SCHEMA_VERSION,
    action: 'noop',
    detail: `已在 v${String(recorded)}`,
  }
}

export interface EnsureSemanticIndexResult {
  readonly action: SemanticIndexSchemaAction
  readonly before: SemanticIndexSchemaStatus
  readonly after: SemanticIndexSchemaStatus | null
  readonly statementsRun: number
  readonly committed: boolean
}

export interface EnsureSemanticIndexOptions {
  readonly now?: number
  /**
   * **仅测试用**：在第 N 条语句之后注入一次失败（N 从 1 起）。
   * 用来证明"中途失败 ⇒ 无半成状态"（T32 同族）。生产调用方不得传它。
   */
  readonly failAfterStatement?: number
}

/**
 * 建立或升级派生 schema。
 *
 * 四条性质（`pnpm m9.5:migration:verify` 逐条出证据）：
 *  ① **幂等**：已是最新 ⇒ `noop`，一条语句都不跑；
 *  ② **事务内**：任何一步失败 ⇒ 回滚，**不留半成状态**；
 *  ③ **失败关闭**：记到的版本比代码新 ⇒ `refuse-newer`，**不动任何东西**；
 *  ④ **半径最小**：只 `create … if not exists`，**不碰**任何既有表/行（无 backfill）。
 */
export async function ensureSemanticIndexSchema(
  db: RawDb,
  options: EnsureSemanticIndexOptions = {}
): Promise<EnsureSemanticIndexResult> {
  assertSemanticIndexUpgradesWellFormed()
  const before = await semanticIndexSchemaStatus(db)
  /*
   * ⚠️ **不许盲信版本行**（2026-10-01 修的真缺陷，`d1347ab1`）：
   *
   * ```text
   * 历史缺陷让库**自称当前版本却缺对象**（新建路径没跑升级链，却无条件写了当前版本号）。
   * 而它**卡住**了：下次 ensure 看到 `recordedVersion === 当前` ⇒ 走 `noop` ⇒ 永远补不上。
   * ⇒ 这里**实测**"当前版本应有的对象在不在"；不在就按"需要从 0 升级"处理 ⇒ **自愈**。
   * ⚠️ 只在 `noop` 这一支做这个检查（正常路径上它不该被触发，也不该改变幂等语义）。
   * ```
   */
  let repairFromZero = false
  if (before.action === 'noop') {
    const cursorColumn = rowsOf(
      await db.execute(
        sql`select 1 as one from information_schema.columns
             where table_name = 'memory_semantic_generations' and column_name = 'source_cursor'
             limit 1`
      )
    )
    if (cursorColumn.length === 0) repairFromZero = true
  }
  if (before.action === 'refuse-newer') {
    return { action: before.action, before, after: before, statementsRun: 0, committed: false }
  }
  if (before.action === 'noop' && !repairFromZero) {
    return { action: before.action, before, after: before, statementsRun: 0, committed: false }
  }

  const statements: string[] = [...SEMANTIC_INDEX_DDL]
  /*
   * ⚠️ **新建路径也必须跑升级链**（2026-10-01 修的真缺陷）：
   *
   * ```text
   * 原来只有 `action === 'upgrade'` 才 push 升级语句，而版本号**无条件**写成当前值
   * ⇒ **新建的库自称 v2，却没有 v2 的那一列**（`SEMANTIC_INDEX_DDL` 是 v1 的形状）。
   * 实测症状：`column "source_cursor" of relation "memory_semantic_generations" does not exist`；
   * 而真实库已经被写成"v2 但缺列"，且因为 `recordedVersion === 当前` ⇒ 走 `noop` ⇒ **永远补不上**。
   * ```
   * ⇒ 现在：**create 与 upgrade 都跑**（`from = recordedVersion ?? 0`）——
   *   建表（`if not exists`，幂等）之后立刻把 0→当前 的升级补齐，版本号才是**真凭据**。
   */
  if (before.action === 'create' || before.action === 'upgrade' || repairFromZero) {
    const from = repairFromZero ? 0 : (before.recordedVersion ?? 0)
    for (let version = from; version < SEMANTIC_INDEX_SCHEMA_VERSION; version += 1) {
      statements.push(...(SEMANTIC_INDEX_UPGRADES[version] ?? []))
    }
  }
  /* 版本登记：初建时插入，升级时更新。放在**最后** —— 版本号是"全部对象都到位了"的凭据。 */
  const now = options.now ?? Date.now()
  statements.push(
    before.metaPresent && before.recordedVersion !== null
      ? `update memory_semantic_meta set index_schema_version = ${String(SEMANTIC_INDEX_SCHEMA_VERSION)}, ` +
          `updated_at = ${String(now)} where id = '${SEMANTIC_META_ID}'`
      : `insert into memory_semantic_meta (id, index_schema_version, updated_at) ` +
          `values ('${SEMANTIC_META_ID}', ${String(SEMANTIC_INDEX_SCHEMA_VERSION)}, ${String(now)}) ` +
          `on conflict (id) do update set index_schema_version = excluded.index_schema_version, ` +
          `updated_at = excluded.updated_at`
  )

  let run = 0
  await db.execute(sql.raw('begin'))
  try {
    for (const statement of statements) {
      run += 1
      await db.execute(sql.raw(statement))
      if (options.failAfterStatement !== undefined && run >= options.failAfterStatement) {
        throw new Error(`[test-injection] 在第 ${String(run)} 条语句之后注入失败`)
      }
    }
    await db.execute(sql.raw('commit'))
  } catch (error) {
    try {
      await db.execute(sql.raw('rollback'))
    } catch {
      /* 数据库可能已自行中止事务；这里只关心"不留半成" */
    }
    throw error
  }

  return {
    action: before.action,
    before,
    after: await semanticIndexSchemaStatus(db),
    statementsRun: run,
    committed: true,
  }
}

// ---------------------------------------------------------------------------
// 向量校验（D28）—— 单实现，WP3/WP5/WP6 一律调这里，不各写一份
// ---------------------------------------------------------------------------

/**
 * 发布前自检。返回**具名**失败原因，或 `null` 表示可发布。
 *
 * ⚠️ 这四条**不能**交给数据库代劳：实测数据库**接受**零范数向量，
 * 余弦距离静默变 `NaN` 而不报错（`pnpm m9.5:poc --part vector` 的 `zero-vector-cosine`）。
 */
export function validateSemanticVector(
  vector: readonly number[],
  dimension: number = SEMANTIC_INDEX_DIMENSION
): string | null {
  if (vector.length !== dimension) {
    return `invalid_vector:dimension(${String(vector.length)}!=${String(dimension)})`
  }
  if (!vector.every((value) => Number.isFinite(value))) return 'invalid_vector:nan_or_inf'
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))
  if (!(norm > 0)) return 'invalid_vector:zero_norm'
  if (Math.abs(norm - 1) > 1e-3) return `invalid_vector:not_normalized(${norm.toFixed(6)})`
  return null
}
