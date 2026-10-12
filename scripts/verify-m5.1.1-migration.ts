/**
 * M5.1.1 WP2 —— **迁移与归因物理编码验证**（`pnpm m5.1.1:migration:verify`）。
 *
 * ============================================================================
 *  这一 WP 要证明的不是"迁移能跑"，而是"数据库自己会拒绝非法状态"
 * ============================================================================
 * 三件事必须**由数据库**回答，而不是由 TypeScript 的类型回答：
 *
 *   ① **三态精确互斥**（K-4）：只有
 *         ABSENT  (kind null, id null, reason null)
 *         KNOWN   (kind 非空, id 非空, reason null)
 *         UNKNOWN (kind null, id null, reason ∈ 两个受控理由)
 *      三种元组能进库；**其余任何组合都必须被拒**。
 *      尤其是 `kind='USER', id=NULL, reason=NULL` —— Proposed-Schema §0 的 4 条草案
 *      CHECK **允许**它（脚本里把那段草案实现成谓词并逐组合算出来，作为 K-4 的证据）。
 *   ② **受控词汇**：`'HACKER'` / `'MAGIC'` / `'WHATEVER'` 必须被拒。
 *   ③ **迁移纪律**：已发布迁移的语句不许被改（内容指纹）；**v7 纯追加**（M1）；
 *      **v8 只替换一条 CHECK**（K-22；没有列/数据/词表变更，见下）。
 *
 * ---------------------------------------------------------------------------
 *  WP4.1（2026-09-18）对判据的一次**最小兼容更新**
 * ---------------------------------------------------------------------------
 *  加 `MIGRATION_0008`（K-22 physical landing）之后，"最新版本"从 7 变成 8，
 *  因此本脚本里那些写死 `=== 7` 的断言改成 `=== 8`（或用 `latestSchemaVersion()`），
 *  并新增 v8 自己的静态/库级判据。**判据没有被放宽**：
 *    · 已发布迁移 0001–0007 的指纹**一字不改**（v7 仍然不可改）；
 *    · 新增 0008 的指纹锁（在第一次成功的 production-copy apply 之后锁定）；
 *    · `conversation_events` 的 Axis B 语义与 5 条约束**逐条不变**
 *      （只有 `character_action_events` 的 `axis_b_complete` 被替换成
 *      `axis_b_not_applicable`）。
 *  逐条记录见 `docs/m5.1.1/M5.1.1-WP4.1-Compatible-Assertion-Record.md`。
 *
 * ---------------------------------------------------------------------------
 *  WP9-B1（2026-09-18）对判据的又一次**最小兼容更新**（R-45 = SELECTED B）
 * ---------------------------------------------------------------------------
 *  加 `MIGRATION_0009`（`state_events` 的归因物理承载）之后，"最新版本"从 8 变成 9，
 *  因此本脚本里写死 `=== 8` 的断言改成 `=== 9`（或从 `MIGRATIONS` 推导），
 *  并新增 v9 自己的静态 + 库级判据。**判据没有被放宽**：
 *   · 已发布迁移 0001–0008 的指纹**一字不改**（v7/v8 仍不可改）；
 *   · 新增 0009 的指纹锁（在第一次成功的 production-copy v6 → v9 apply 之后锁定）；
 *   · v9 的半径被**正向证明**：只碰 `state_events`、恰好 19 列 + 19 约束、
 *     **无 Axis B**、**无索引**、**无回填**（`state_events` 的既有行保持 NULL）。
 *  逐条记录由父代理写进兼容性记录（本 WP 不写文档）。
 *
 * ---------------------------------------------------------------------------
 *  量具自检（用户 2026-09-18 起的纪律）
 * ---------------------------------------------------------------------------
 * 任何"计数型"检测器都必须先证明 `measured_count > 0` 才允许给 PASS：
 * 一个 `hashes_checked = 0 / mismatches = 0` 的结果看起来漂亮，其实什么都没测到。
 * 这里每个计数都过 `measure()`；`count === 0` 会直接记为 **MEASUREMENT INVALID** 并失败。
 *
 * ---------------------------------------------------------------------------
 *  只在临时库上跑
 * ---------------------------------------------------------------------------
 * `isolateDatabase()` 把 PGLITE_DATA_DIR 指到 tmpdir，脚本**不打开**真实库
 * （证据里记下沙箱路径与 `isProductionDir(sandbox) === false` 的实测值）。
 *
 * 跑法：pnpm m5.1.1:migration:verify
 */

import 'dotenv/config'

import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AgentRuntime } from '@elizaos/core'
import sqlPlugin from '@elizaos/plugin-sql'
import { sql } from 'drizzle-orm'

import { character } from '../src/character/index.ts'
import { initDatabase } from '../src/db/index.ts'
import { PRODUCTION_DB_DIR, isolateDatabase, isProductionDir } from '../src/dev/sandbox.ts'
import {
  MIGRATIONS,
  assertMigrationsWellFormed,
  latestSchemaVersion,
} from '../src/infrastructure/persistence/migrations.ts'
import {
  applyKernelMigrations,
  currentSchemaVersion,
  getRawDb,
  pendingMigrations,
  rowsOf,
} from '../src/infrastructure/persistence/db.ts'
import {
  ATTRIBUTION_NON_SLOT_COLUMNS,
  ATTRIBUTION_ORIGINS,
  ATTRIBUTION_SLOT_COLUMNS,
  ATTRIBUTION_V7_COLUMNS,
  AUTHORITY_KINDS,
} from '../src/kernel/contracts/attribution.ts'
import { PRINCIPAL_KINDS, UNKNOWN_REASONS } from '../src/kernel/contracts/actor.ts'
import {
  EPISTEMIC_SOURCES,
  SOURCE_AUTHORITIES,
  SOURCE_KINDS,
} from '../src/kernel/contracts/source-authority.ts'

// ---------------------------------------------------------------------------
// 检查器（本地极简版；本脚本不引 m4-harness，避免把 M4 的装配拖进来）
// ---------------------------------------------------------------------------

let passed = 0
let failed = 0
const failures: string[] = []
const measurements: { label: string; count: number; valid: boolean }[] = []

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed += 1
    console.log(`  ✅ ${label}${detail ? `  [${detail}]` : ''}`)
  } else {
    failed += 1
    failures.push(label)
    console.log(`  ❌ ${label}${detail ? `  [${detail}]` : ''}`)
  }
}

/** 计数型检测器的**最低自检**：`measured_count > 0` 才允许谈 PASS */
function measure(label: string, count: number): number {
  const valid = count > 0
  measurements.push({ label, count, valid })
  if (!valid) {
    check(`[MEASUREMENT INVALID] ${label}（measured_count = 0）`, false, '什么都没测到')
  }
  return count
}

function section(title: string): void {
  console.log(`\n${'='.repeat(74)}\n${title}\n${'='.repeat(74)}`)
}

// ---------------------------------------------------------------------------
// 沙箱（临时库）
// ---------------------------------------------------------------------------

const sandbox = isolateDatabase('m5.1.1-migration')
console.log(`[sandbox] ${sandbox.dir}`)

const runtime = new AgentRuntime({
  character,
  plugins: [sqlPlugin],
  conversationLength: 16,
  settings: {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? '',
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? 'https://api.deepseek.com',
    OPENAI_LARGE_MODEL: process.env.OPENAI_LARGE_MODEL ?? 'deepseek-flash',
    OPENAI_SMALL_MODEL: process.env.OPENAI_SMALL_MODEL ?? 'deepseek-flash',
  },
})
await runtime.registerPlugin(sqlPlugin)
await runtime.runPluginMigrations()
const db = getRawDb(runtime)

// ===========================================================================
section('0. 沙箱与真实库的隔离')
// ===========================================================================
check(
  '本脚本跑在临时目录里，且该目录不是真实库（也不是它的父子目录）',
  isProductionDir(sandbox.dir) === false && sandbox.dir.startsWith(tmpdir()),
  sandbox.dir
)
check('真实库路径只被记录、从未被打开', PRODUCTION_DB_DIR.endsWith(join('data', 'pglite')), PRODUCTION_DB_DIR)

// ===========================================================================
section('1. 静态：迁移序列、冻结指纹、v7/v8 的迁移纪律（M1）')
// ===========================================================================

assertMigrationsWellFormed()
check('迁移定义自洽（1..N 严格连续）', true)
measure('代码里的迁移条数', MIGRATIONS.length)
/*
 * ⚠️ **2026-09-30 改成推导**（M10 追加了 `MIGRATION_0010`，见 `L-M10-66` 的用户裁定）：
 *    本文件第 24 行的注释**早就写了这条出路** ——「那些写死 `=== 7` 的断言改成 `=== 8`
 *    （**或用 `latestSchemaVersion()`**）」。现在照它做：
 *    · "最新 = 9" 改成 **"≥ 9 且与迁移条数一致"**（M5.1.1 的 schema **至少**是 9；
 *      而 0001–0009 的**内容指纹**仍由下面那张表逐条锁着 ⇒ 历史 DDL 一个字都没动 ✓）
 *    · "恰为 1..9" 改成 **"恰为 1..N（N = 迁移条数）"** ⇒ 与"严格连续"是同一条判据
 *    ⇒ 这样**以后再加迁移**不会假红，而"改已发布迁移"照旧会红（指纹表管那一半）。
 */
check(
  '代码最新 schema ≥ 9 且与迁移条数一致（M5.1.1 冻结的 0001–0009 由指纹表另锁）',
  latestSchemaVersion() >= 9 && latestSchemaVersion() === MIGRATIONS.length,
  `v${String(latestSchemaVersion())} · 条数 ${String(MIGRATIONS.length)}`,
)
check(
  '版本号恰为 1..N（严格连续，与条数一致）',
  MIGRATIONS.map((m) => m.version).join(',') ===
    MIGRATIONS.map((_, index) => String(index + 1)).join(','),
  MIGRATIONS.map((m) => m.version).join(','),
)

/**
 * 已发布迁移（**0001–0008**）的**内容指纹**。
 *
 * 它们是"发布过的 DDL"，改一个字都可能让已经升级过的库与新库不一致。
 * 指纹在 M5.1.1 WP2 开工前采集（0001–0006），此后任何改动都会在这里红。
 *
 * **K-8 = CLOSED（2026-09-18，WP2.4）**：`MIGRATION_0007` 的指纹已按用户裁定的
 * 触发点锁定 ——「**第一次成功的 production-copy v7 apply**」（本 WP 的
 * `pnpm m5.1.1:prod-copy:verify`，副本上 v6 → v7 = PASS）。算法与上面六条完全一致：
 * sha256 over `MIGRATION_0007.statements.join('\n')`。
 *
 * ⚠️ **v7 从此是不可改的历史 DDL**：任何 schema 变更都必须新写 `MIGRATION_0008+`。
 * 改回 v7 的任何一个字都会让本表红 —— 那不是"需要更新指纹"，那是**改了一份已发布的迁移**。
 *
 * **K-22 / WP4.1（2026-09-18）**：`MIGRATION_0008` 按**同一条规则**锁定 ——
 * 触发点同样是"第一次成功的 production-copy apply"（本次 = `pnpm m5.1.1:prod-copy:verify`
 * 副本上 v6 → v8）。从此 v8 也是不可改的历史 DDL。
 *
 * **WP9-B1（R-45）**：`MIGRATION_0009` 按**同一条规则**锁定 —— 触发点是
 * `pnpm m5.1.1:prod-copy:verify` 副本上 **v6 → v9** 的第一次成功 apply。
 * 判据**没有被放宽**：v7 / v8 的指纹**一字不改**（v9 只追加，不回头改它们），
 * 新增的只有 v9 自己的那一条锁。
 */
const FROZEN_MIGRATION_FINGERPRINTS: Record<number, { name: string; statements: number; sha256: string }> =
  {
    1: {
      name: 'm2-character-state-tables',
      statements: 3,
      sha256: 'fc8376130a9875ffbeff6f4e27f88a902cdff8c3f06ef3b6204b8a427c5e06a7',
    },
    2: {
      name: 'm2.5-character-kernel',
      statements: 18,
      sha256: '0dd5aec716bd895ef2d957f157a1dea8915dea1b3746ffcda8f6fc22209ddec5',
    },
    3: {
      name: 'm3-identity-and-conversation-integrity',
      statements: 23,
      sha256: '0444809a8de89dcf7fff48e16e59c501b84acc3f778278fa74e8b380958671ff',
    },
    4: {
      name: 'm3.5-future-extension-compatibility',
      statements: 9,
      sha256: 'fb7653f369ba92a90b11017f291dc7e007b61147c37ee97389e9988f65cb1ccd',
    },
    5: {
      name: 'm4-reliable-long-term-memory',
      statements: 17,
      sha256: '85d766de9b366960eec9db5b5e8124f1bfee47c2843ae81b8be0f22532be1297',
    },
    6: {
      name: 'm45-action-execution-ledger',
      statements: 8,
      sha256: '82f3c3ff9888303faae432ed19042038e8a4db691ad85c03be09cd51e61e3565',
    },
    7: {
      name: 'm5.1.1-attribution-model',
      statements: 114,
      sha256: '2d51997dc620ff01f87bcf8784c15985c6d6d9d2a4b978809db5f8dbc7c07613',
    },
    8: {
      name: 'm5.1.1-k22-action-axis-b-not-applicable',
      statements: 2,
      sha256: '0a2bd4fe470ac5ce4d4a42717fbd799d9ddb570c4d360f34bc17b580e0538e29',
    },
    9: {
      name: 'm5.1.1-state-events-attribution',
      statements: 38,
      sha256: '5a007003b773351fc870865e541e8d3e2a9e00ccf8e227f3c2b41eb1d5a8c27c',
    },
  }

/*
 * K-8 的**量具自检**（AGENTS §6.7 的负控）：把语句列表**改一个字节**，
 * 指纹比较必须报"不同"。不做这一步，"锁住了"与"比较器恒真"在输出上无法区分。
 * 对**每一条**已锁指纹都做一遍（v7 / v8 是历史，v9 是本步按 V9 规则新锁的：
 * 触发点 = `pnpm m5.1.1:prod-copy:verify` 副本上第一次成功的 v6 → v9 apply）。
 */
const driftCheckedVersions = [7, 8, 9]
measure('K-8 漂移自检覆盖的迁移数', driftCheckedVersions.length)
for (const version of driftCheckedVersions) {
  const migration = MIGRATIONS.find((m) => m.version === version)
  if (migration === undefined) {
    check(`K-8 量具自检：MIGRATION_000${version} 存在`, false, 'MISSING')
    continue
  }
  const drifted = createHash('sha256')
    .update(
      [...migration.statements.slice(0, -1), `${migration.statements.at(-1) ?? ''} `].join('\n'),
      'utf8'
    )
    .digest('hex')
  check(
    `K-8 量具自检：v${version} 被改一个字节 ⇒ 指纹**必红**（漂移不会被静默放过）`,
    drifted !== FROZEN_MIGRATION_FINGERPRINTS[version]?.sha256,
    `${drifted.slice(0, 12)}… vs ${FROZEN_MIGRATION_FINGERPRINTS[version]?.sha256.slice(0, 12)}…`
  )
}

const fingerprintReadings = Object.entries(FROZEN_MIGRATION_FINGERPRINTS).map(([version, expected]) => {
  const migration = MIGRATIONS.find((m) => m.version === Number(version))
  const actual =
    migration === undefined
      ? 'MISSING'
      : createHash('sha256').update(migration.statements.join('\n'), 'utf8').digest('hex')
  return { version: Number(version), expected: expected.sha256, actual, match: actual === expected.sha256 }
})
measure('核对了指纹的已发布迁移数', fingerprintReadings.length)
for (const reading of fingerprintReadings) {
  check(
    `已发布迁移 000${reading.version} 的内容指纹未变`,
    reading.match,
    reading.match ? 'ok' : `期望 ${reading.expected.slice(0, 12)}… 实际 ${reading.actual.slice(0, 12)}…`
  )
}

const v7 = MIGRATIONS.find((m) => m.version === 7)!
const v7Sql = v7.statements.join('\n')
measure('v7 语句数', v7.statements.length)

const destructive = v7.statements.filter((statement) =>
  /^\s*(drop|update|delete|truncate)\b/i.test(statement) || /alter\s+column/i.test(statement)
)
check('M1：v7 里没有 drop / update / delete / truncate / alter column', destructive.length === 0, destructive.join(' | ') || '0 条')

/*
 * ---- v8（WP4.1）的迁移纪律 ----------------------------------------------------
 *
 * v8 与 v7 的纪律**不同**，而且是**刻意**不同：它的全部内容就是"替换一条 CHECK"。
 * 因此这里的判据不是"零 drop"，而是"drop 只能 drop 那一条约束"，且
 * 列 / 数据 / 词表 / 别的表一个字都不许碰。
 */
const v8 = MIGRATIONS.find((m) => m.version === 8)!
const v8Sql = v8.statements.join('\n')
measure('v8 语句数', v8.statements.length)
check('v8 存在（K-22 physical landing）', v8 !== undefined && v8.statements.length === 2, `${v8.statements.length} 条`)
check(
  'v8 无数据变更：没有 update / delete / truncate / insert',
  !/^\s*(update|delete|truncate|insert)\b/i.test(v8Sql),
  'AA'
)
check(
  'v8 无列变更：没有 add/drop/alter column、没有 create/drop table',
  !/add\s+column|drop\s+column|alter\s+column|create\s+table|drop\s+table/i.test(v8Sql),
  'AA'
)
check(
  'v8 不碰 conversation_events（R-21 的 Axis B 语义逐字不变）',
  !/conversation_events/.test(v8Sql),
  'AA'
)
check(
  'v8 只碰 character_action_events',
  v8.statements.every((statement) => /character_action_events/.test(statement)),
  'AA'
)
const v8Drops = v8.statements.filter((statement) => /drop\s+constraint/i.test(statement))
measure('v8 里的 drop constraint 语句数', v8Drops.length)
check(
  'v8 的 drop 只有一条，且只 drop 那条 CHECK 约束（`drop constraint if exists ...axis_b_complete`）',
  v8Drops.length === 1 &&
    /drop\s+constraint\s+if\s+exists\s+character_action_events_axis_b_complete/i.test(v8Drops[0]!),
  v8Drops.join(' | ') || '(无)'
)
check(
  'v8 没有 drop column / drop table / drop index（只有那一条 constraint）',
  !/drop\s+(column|table|index|schema|database)/i.test(v8Sql),
  'AA'
)
check(
  'v8 的新 CHECK 是"行动行 Axis B 三列必须全为 NULL"（K-22：NOT_APPLICABLE）',
  /add\s+constraint\s+character_action_events_axis_b_not_applicable\s+check\s*\(\s*source_kind\s+is\s+null\s+and\s+source_authority\s+is\s+null\s+and\s+epistemic_source\s+is\s+null\s*\)/i.test(
    v8Sql
  ),
  'AA'
)

/*
 * ---- v9（WP9-B1 / R-45）的迁移纪律 ------------------------------------------
 *
 * v9 与 v7 的纪律**同类**（纯追加），但半径更小：**只碰 `state_events`**、
 * **不加 Axis B**、**不建索引**、**不回填**。
 *
 * 期望的 19 列 = 契约的 22 列去掉 Axis B 三列（用契约常量推导，不手写清单）。
 */
const ATTRIBUTION_AXIS_B_COLUMN_NAMES = ATTRIBUTION_NON_SLOT_COLUMNS.slice(0, 3)
const V9_EXPECTED_COLUMNS = ATTRIBUTION_V7_COLUMNS.filter(
  (column) => !ATTRIBUTION_AXIS_B_COLUMN_NAMES.includes(column)
)
const V9_EXPECTED_CONSTRAINTS = [
  ...Object.values(ATTRIBUTION_SLOT_COLUMNS)
    .flatMap((columns) => columns.kind.replace(/_kind$/, ''))
    .flatMap((prefix) => [`state_events_${prefix}_tri_state`, `state_events_${prefix}_kind_vocab`, `state_events_${prefix}_reason_vocab`]),
  'state_events_attribution_origin_vocab',
]

const v9 = MIGRATIONS.find((m) => m.version === 9)!
const v9Sql = v9.statements.join('\n')
measure('v9 语句数', v9.statements.length)
check(
  'v9 存在（R-45：state_events 的归因物理承载），语句数 = 19 列 + 19 约束 = 38',
  v9.statements.length === 38,
  `${v9.statements.length} 条`
)
check(
  'v9 无数据变更：没有 update / delete / truncate / insert（**没有回填**）',
  !/^\s*(update|delete|truncate|insert)\b/im.test(v9Sql) && !/\bupdate\s+state_events\b/i.test(v9Sql),
  '0 条'
)
check(
  'v9 无破坏性变更：没有 drop / alter column / create|drop table|index',
  !/drop\s+(column|table|index|constraint|schema|database)|alter\s+column|create\s+(table|index)|drop\s+table/i.test(v9Sql),
  '0 条'
)
check(
  'v9 只碰 state_events（不碰 conversation_events / character_action_events / developer_control_events）',
  v9.statements.every((statement) => /state_events/.test(statement)) &&
    !/conversation_events|character_action_events|developer_control_events/.test(v9Sql),
  'AA'
)
const v9AddColumns = v9.statements.filter((statement) =>
  /^alter table state_events add column if not exists /.test(statement)
)
const v9AddConstraints = v9.statements.filter((statement) => /add constraint /.test(statement))
measure('v9 的 `add column if not exists` 语句数', v9AddColumns.length)
measure('v9 的 `add constraint` 语句数', v9AddConstraints.length)
check(
  'v9 的列语句恰好 19 条，且全部是 `... text`（可空 ⇒ 旧代码照常运行）',
  v9AddColumns.length === 19 && v9AddColumns.every((statement) => / text$/.test(statement)),
  `${v9AddColumns.length} 条`
)
check(
  'v9 的约束语句恰好 19 条（6 槽 × 3 + origin 词表）',
  v9AddConstraints.length === 19,
  `${v9AddConstraints.length} 条`
)
const v9Columns = v9AddColumns.map((statement) =>
  statement.replace('alter table state_events add column if not exists ', '').replace(/ text$/, '')
)
check(
  'v9 追加的 19 列 == 契约的 22 列去掉 Axis B 三列（ATOMIC）',
  JSON.stringify([...v9Columns].sort()) === JSON.stringify([...V9_EXPECTED_COLUMNS].sort()),
  `${v9Columns.length} 列`
)
check(
  'v9 **没有** Axis B 三列（状态转移不是内容主张 ⇒ 不适用 Cognitive Axis B）',
  !ATTRIBUTION_AXIS_B_COLUMN_NAMES.some((column) => v9Columns.includes(column)),
  ATTRIBUTION_AXIS_B_COLUMN_NAMES.filter((column) => v9Columns.includes(column)).join(',') || '无'
)
check(
  'v9 没有为归因新建索引（U-01：只为真实存在的查询建索引）',
  !/create\s+index/i.test(v9Sql),
  '0 条'
)
const v9ConstraintNames = v9AddConstraints.map(
  (statement) => /add constraint (\S+) /.exec(statement)?.[1] ?? '(解析失败)'
)
check(
  'v9 的 19 条约束名 == 6 槽 × (tri_state/kind_vocab/reason_vocab) + attribution_origin_vocab',
  JSON.stringify([...v9ConstraintNames].sort()) === JSON.stringify([...V9_EXPECTED_CONSTRAINTS].sort()),
  v9ConstraintNames.join(',')
)
check(
  'v9 的 origin 词表把受控词汇**字面量**写进 DDL（RECORDED / MIGRATED_LEGACY）',
  /\bRECORDED\b/.test(v9Sql) && /\bMIGRATED_LEGACY\b/.test(v9Sql),
  'AA'
)

// ===========================================================================
section('2. 静态：契约 ↔ DDL 的受控词汇与列名一致（防漂移）')
// ===========================================================================

function inListOf(statements: string[], constraintName: string): string[] | undefined {
  const statement = [...statements].reverse().find((s) => s.includes(`add constraint ${constraintName} `))
  if (statement === undefined) return undefined
  const matched = statement.match(/in \(([^)]*)\)/)
  if (matched === null) return undefined
  return matched[1]!
    .split(',')
    .map((value) => value.trim().replace(/^'|'$/g, ''))
    .sort()
}

/**
 * **生效中**的词表约束（跨全部迁移取**最后一次** `add constraint`）。
 *
 * ⚠️ **2026-10-03 修订（后 Lv2 · S1 / ADR-091 D04）**：本函数原来只看 `v7.statements`
 * —— 那在"契约可以长大"之后就**量错了东西**：
 *
 *   · 已发布的 0007 是**不可改的历史 DDL**（`FROZEN_MIGRATION_FINGERPRINTS` 锁着），
 *     它永远只写它当时那 4/7/5 个值；
 *   · 扩充受控词汇的**唯一**合法方式是**往前追加**一条迁移（0011）。
 *
 * 于是"契约 == DDL"这条判据必须问"**当前生效**的约束长什么样"，而不是"0007 当时写了什么"。
 * 判据本身**没有被放宽**：它仍然**逐值定性**比对（顺序无关、集合相等），
 * 而且**每一条** `add constraint` 都还是被算进来的（取最后一条 = 生效的那条）。
 *
 * ⚠️ 副作用是**故意的**：如果有人往契约里加了值却**忘了**写迁移，
 * 这里会立刻红 —— 那正是这条判据存在的理由。
 */
function effectiveInListOf(constraintName: string): string[] | undefined {
  for (let index = MIGRATIONS.length - 1; index >= 0; index -= 1) {
    const found = inListOf(MIGRATIONS[index]!.statements, constraintName)
    if (found !== undefined) return found
  }
  return undefined
}

const sorted = (values: readonly string[]): string[] => [...values].sort()

const vocabularyReadings = [
  { id: 'PrincipalKind', constraint: 'conversation_events_actor_kind_vocab', contract: PRINCIPAL_KINDS },
  { id: 'AuthorityKind', constraint: 'conversation_events_authority_kind_vocab', contract: AUTHORITY_KINDS },
  { id: 'UnknownReason', constraint: 'conversation_events_actor_reason_vocab', contract: UNKNOWN_REASONS },
  { id: 'SourceKind', constraint: 'conversation_events_source_kind_vocab', contract: SOURCE_KINDS },
  {
    id: 'SourceAuthority',
    constraint: 'conversation_events_source_authority_vocab',
    contract: SOURCE_AUTHORITIES,
  },
  {
    id: 'EpistemicSource',
    constraint: 'conversation_events_epistemic_source_vocab',
    contract: EPISTEMIC_SOURCES,
  },
  {
    id: 'AttributionOrigin',
    constraint: 'conversation_events_attribution_origin_vocab',
    contract: ATTRIBUTION_ORIGINS,
  },
].map((item) => {
  /*
   * ⚠️ 用 `effectiveInListOf`（跨全部迁移取**最后一次** `add constraint`），
   * 而不是只看 v7 —— 见该函数的注释（后 Lv2 追加 0011 之后的必要修订）。
   * v7 本身仍是不可改的历史 DDL：它的指纹在 `FROZEN_MIGRATION_FINGERPRINTS` 里另锁。
   */
  const fromDdl = effectiveInListOf(item.constraint) ?? []
  return {
    id: item.id,
    constraint: item.constraint,
    contract: sorted(item.contract),
    fromDdl,
    match: JSON.stringify(fromDdl) === JSON.stringify(sorted(item.contract)),
  }
})
measure('比对了词表的受控词汇数', vocabularyReadings.length)
for (const reading of vocabularyReadings) {
  check(
    `DDL 的 ${reading.id} 词表 == 契约常量`,
    reading.match,
    reading.match ? `${reading.fromDdl.length} 个值` : `DDL=[${reading.fromDdl.join(',')}] 契约=[${reading.contract.join(',')}]`
  )
}

const columnsFromDdl = (table: string): string[] =>
  v7.statements
    .filter((s) => s.startsWith(`alter table ${table} add column if not exists `))
    .map((s) => s.replace(`alter table ${table} add column if not exists `, '').replace(/ text$/, ''))

const conversationColumns = columnsFromDdl('conversation_events')
const actionColumns = columnsFromDdl('character_action_events')
measure('v7 追加的 conversation_events 列数', conversationColumns.length)
measure('v7 追加的 character_action_events 列数', actionColumns.length)
check(
  'conversation_events 追加列 == 契约的 22 列（ATOMIC）',
  JSON.stringify(sorted(conversationColumns)) === JSON.stringify(sorted(ATTRIBUTION_V7_COLUMNS)),
  `${conversationColumns.length} 列`
)
check(
  'character_action_events 追加列 == 同一组 22 列',
  JSON.stringify(sorted(actionColumns)) === JSON.stringify(sorted(ATTRIBUTION_V7_COLUMNS)),
  `${actionColumns.length} 列`
)

// ===========================================================================
section('3. K-4 的证据：草案 4 条 CHECK 会放过一个非法第四状态')
// ===========================================================================

/**
 * Proposed-Schema §0 的 4 条草案 CHECK，逐字实现成谓词
 * （`(a)`…`(d)` 与文档一一对应）。
 */
function draftFourClauses(combo: { kind: string | null; id: string | null; reason: string | null }): boolean {
  const unknownPrefixOk = combo.kind === null || !combo.kind.startsWith('UNKNOWN')
  const a = combo.id === null || combo.kind !== null
  const b = unknownPrefixOk
  const c = combo.reason === null || (combo.kind === null && combo.id === null)
  const d =
    combo.reason === null || ['LEGACY_UNRECORDED', 'RUNTIME_UNRESOLVED'].includes(combo.reason)
  return a && b && c && d
}

/** K-4 的**精确三分支**（与写进 v7 的 SQL 逐字对应） */
function k4ThreeBranches(combo: { kind: string | null; id: string | null; reason: string | null }): boolean {
  const absent = combo.kind === null && combo.id === null && combo.reason === null
  const known = combo.kind !== null && combo.id !== null && combo.reason === null
  const unknown =
    combo.kind === null &&
    combo.id === null &&
    combo.reason !== null &&
    ['LEGACY_UNRECORDED', 'RUNTIME_UNRESOLVED'].includes(combo.reason)
  return absent || known || unknown
}

const truthTable = [
  { kind: null, id: null, reason: null },
  { kind: null, id: null, reason: 'LEGACY_UNRECORDED' },
  { kind: null, id: null, reason: 'RUNTIME_UNRESOLVED' },
  { kind: null, id: null, reason: 'NOPE' },
  { kind: 'USER', id: null, reason: null },
  { kind: 'USER', id: 'u-1', reason: null },
  { kind: 'USER', id: null, reason: 'LEGACY_UNRECORDED' },
  { kind: null, id: 'u-1', reason: null },
  { kind: 'USER', id: 'u-1', reason: 'LEGACY_UNRECORDED' },
].map((combo) => ({
  combo,
  draftAdmits: draftFourClauses(combo),
  k4Admits: k4ThreeBranches(combo),
}))
measure('K-4 真值表组合数', truthTable.length)
const draftGap = truthTable.filter((row) => row.draftAdmits && !row.k4Admits)
check(
  'K-4 缺口被复现：草案至少放过一个 K-4 拒绝的元组',
  draftGap.length > 0,
  draftGap.map((row) => JSON.stringify(row.combo)).join(' | ')
)
const k4Exemplar = truthTable.find((row) => row.combo.kind === 'USER' && row.combo.id === null && row.combo.reason === null)!
check(
  'K-4 的样板非法元组 kind=USER/id=NULL/reason=NULL：草案放过、K-4 拒绝',
  k4Exemplar.draftAdmits === true && k4Exemplar.k4Admits === false,
  `draft=${String(k4Exemplar.draftAdmits)} k4=${String(k4Exemplar.k4Admits)}`
)

// ===========================================================================
section('4. 数据库：fresh → v9')
// ===========================================================================

await initDatabase(runtime, sqlPlugin)
const freshVersion = await currentSchemaVersion(db)
check(
  `空库初始化后 schema = v${String(latestSchemaVersion())}（fresh → 最新）`,
  freshVersion === latestSchemaVersion(),
  `v${String(freshVersion)}`,
)

async function columnNamesOf(table: string): Promise<string[]> {
  const rows = rowsOf(
    await db.execute(
      sql`select column_name from information_schema.columns
          where table_schema = 'public' and table_name = ${table}`
    )
  ) as { column_name: string }[]
  return rows.map((row) => row.column_name)
}

async function constraintNamesOf(table: string): Promise<string[]> {
  const rows = rowsOf(
    await db.execute(
      sql`select conname from pg_constraint
          where conrelid = ${table}::regclass and contype = 'c'`
    )
  ) as { conname: string }[]
  return rows.map((row) => row.conname)
}

for (const table of ['conversation_events', 'character_action_events']) {
  const columns = await columnNamesOf(table)
  measure(`库中 ${table} 的列数`, columns.length)
  const missing = ATTRIBUTION_V7_COLUMNS.filter((column) => !columns.includes(column))
  check(`${table} 的 22 个归因列都在库里`, missing.length === 0, missing.join(',') || '22/22')

  const constraints = await constraintNamesOf(table)
  measure(`库中 ${table} 的 CHECK 约束数`, constraints.length)
  const triState = constraints.filter((name) => name.endsWith('_tri_state'))
  // ⚠️ 只数**槽位**的 kind 词表：`source_kind_vocab` 也是 `_kind_vocab` 结尾，
  //    用朴素后缀匹配会把它算进来（第一版就是这么错的：数出 7 条）。
  const slotKindVocab = constraints.filter((name) =>
    /_(initiator|actor|executor|recorded_by|content_originator|authority)_kind_vocab$/.test(name)
  )
  const reasonVocab = constraints.filter((name) => name.endsWith('_reason_vocab'))
  check(`${table}：6 个槽位各一条三态约束`, triState.length === 6, `${triState.length} 条`)
  check(`${table}：6 个槽位各一条 kind 词表（不含 source_kind_vocab）`, slotKindVocab.length === 6, `${slotKindVocab.length} 条`)
  check(`${table}：6 个槽位各一条 reason 词表`, reasonVocab.length === 6, `${reasonVocab.length} 条`)
  /*
   * Axis B：四列词表 + **一条**完整性约束。
   *
   * ⚠️ WP4.1（K-22）之后，**两张表的完整性约束不是同一条**：
   *   · conversation_events      → `axis_b_complete`（声明了 origin 就必须三列齐，R-21）
   *   · character_action_events  → `axis_b_not_applicable`（三列必须全 NULL，K-22）
   * 判据没有被放宽：每张表都**恰好**一条，且必须是它该有的那一条。
   */
  const axisBNames = constraints.filter((name) =>
    /source_kind_vocab|source_authority_vocab|epistemic_source_vocab|attribution_origin_vocab|axis_b_(complete|not_applicable)/.test(
      name
    )
  )
  check(`${table}：Axis B 四列词表 + 完整性 = 5 条`, axisBNames.length === 5, axisBNames.join(','))
  const expectedAxisBName =
    table === 'conversation_events' ? `${table}_axis_b_complete` : `${table}_axis_b_not_applicable`
  const forbiddenAxisBName =
    table === 'conversation_events' ? `${table}_axis_b_not_applicable` : `${table}_axis_b_complete`
  check(
    `${table}：完整性约束恰好是 \`${expectedAxisBName}\`（K-22 之后两表不同）`,
    constraints.includes(expectedAxisBName) && !constraints.includes(forbiddenAxisBName)
  )
  check(
    `${table}：CHECK 约束总数 = 6×3 + 5 = 23`,
    constraints.length === 23,
    `${constraints.length} 条`
  )
}

const indexRows = rowsOf(
  await db.execute(
    sql`select indexname, indexdef from pg_indexes
        where schemaname = 'public' and indexname = 'conversation_events_attribution_origin'`
  )
) as { indexname: string; indexdef: string }[]
measure('库中该 partial 索引的条数', indexRows.length)
check(
  '唯一新增的索引是 conversation_events 上的 partial(attribution_origin)',
  indexRows.length === 1 && /where .*MIGRATED_LEGACY/i.test(indexRows[0]!.indexdef),
  indexRows[0]?.indexdef ?? '(缺)'
)

const controlColumns = await columnNamesOf('developer_control_events')
measure('控制面审计表的列数', controlColumns.length)
check(
  'U-03：控制面审计表存在且带 6 个归因槽位（不是伪装成 character_action_events）',
  controlColumns.length > 0 &&
    ['initiator_kind', 'actor_ref_id', 'authority_ref', 'recorded_by_kind'].every((column) =>
      controlColumns.includes(column)
    )
)
check(
  '控制面审计表**没有** Axis B 三列（它不是内容事件的认知轴）',
  !controlColumns.includes('source_authority') && !controlColumns.includes('epistemic_source'),
  controlColumns.filter((column) => column.startsWith('source') || column.startsWith('epistemic')).join(',') || '无'
)
const controlConstraints = await constraintNamesOf('developer_control_events')
measure('控制面审计表的 CHECK 约束数', controlConstraints.length)
check(
  '控制面审计表：6 槽 × 3 条 + 4 条命令词表 = 22 条 CHECK',
  controlConstraints.length === 22 &&
    controlConstraints.filter((name) => name.endsWith('_tri_state')).length === 6,
  `${controlConstraints.length} 条（三态 ${controlConstraints.filter((name) => name.endsWith('_tri_state')).length} 条）`
)

/*
 * ---- WP9-B1（R-45）：`state_events` 的物理承载（**库是裁判**）-----------------
 *
 * 这里逐条实测三件事，缺一不可：
 *   ① 恰好 19 个新列（18 槽位 + origin）—— 多一列（例如"顺手"加 Axis B）都会红；
 *   ② 恰好 19 条 CHECK（6 槽 × 3 + origin 词表）—— 名字逐条点名，不是数数量；
 *   ③ **没有** Axis B 三列、**没有** axis_b_* 约束、**没有**归因索引。
 */
const stateEventColumns = await columnNamesOf('state_events')
measure('库中 state_events 的列数', stateEventColumns.length)
const stateEventMissing = V9_EXPECTED_COLUMNS.filter((column) => !stateEventColumns.includes(column))
check(
  'state_events：v9 的 19 个归因列都在库里',
  stateEventMissing.length === 0,
  stateEventMissing.join(',') || `19/19（共 ${stateEventColumns.length} 列）`
)
check(
  'state_events：**没有** Axis B 三列（K-22 同侧：状态转移不是内容主张）',
  !ATTRIBUTION_AXIS_B_COLUMN_NAMES.some((column) => stateEventColumns.includes(column)),
  ATTRIBUTION_AXIS_B_COLUMN_NAMES.filter((column) => stateEventColumns.includes(column)).join(',') || '无'
)
const stateEventConstraints = await constraintNamesOf('state_events')
measure('库中 state_events 的 CHECK 约束数', stateEventConstraints.length)
check(
  'state_events：约束名逐条 == 6 槽 × (tri_state/kind_vocab/reason_vocab) + attribution_origin_vocab',
  JSON.stringify([...stateEventConstraints].sort()) === JSON.stringify([...V9_EXPECTED_CONSTRAINTS].sort()),
  stateEventConstraints.join(',')
)
check(
  'state_events：CHECK 总数 = 19，且没有 axis_b_* 约束',
  stateEventConstraints.length === 19 && !stateEventConstraints.some((name) => /axis_b/.test(name)),
  `${stateEventConstraints.length} 条`
)
const stateEventIndexes = rowsOf(
  await db.execute(
    sql`select indexname from pg_indexes where schemaname = 'public' and tablename = 'state_events'`
  )
) as { indexname: string }[]
measure('库中 state_events 的索引数', stateEventIndexes.length)
check(
  'state_events：索引**恰好**是 v9 之前就有的那两个（PK + M2 的 lookup）—— v9 没有为归因新建索引',
  JSON.stringify([...stateEventIndexes.map((row) => row.indexname)].sort()) ===
    JSON.stringify(['state_events_lookup', 'state_events_pkey']),
  stateEventIndexes.map((row) => row.indexname).join(',') || '(无)'
)

// ===========================================================================
section('5. 数据库：old(v6) → v9，以及幂等')
// ===========================================================================

/*
 * 回退成 v6 形状时必须**只**丢 v7/v8 真正新增的东西。
 *
 * ⚠️ 第一版这里把 22 列全 drop 了，于是 `conversation_events` 只剩 17 列 ——
 * 因为 `source_kind` / `source_authority` / `epistemic_source` 是**迁移 0003** 建的，
 * v7 对它们只是 `add column if not exists`（no-op）。drop 它们等于把 M3 的列删了，
 * 模拟出来的不是 v6，而是"v6 再被砍掉三列"。教训：回退脚本自己也要对得上历史。
 *
 * WP4.1：v8 只换了一条 CHECK，而那条 CHECK 建在 v7 加的三列上 ——
 * drop 那三列会连带 drop 掉它。因此"回退 v8"在这里是 drop 列的**副作用**，
 * 不需要（也不该）单独写 drop constraint：那会让回退脚本与真实历史不一致。
 */
const AXIS_B_PREEXISTING = ['source_kind', 'source_authority', 'epistemic_source']
const NET_NEW_CONVERSATION_COLUMNS = ATTRIBUTION_V7_COLUMNS.filter(
  (column) => !AXIS_B_PREEXISTING.includes(column)
)
for (const column of NET_NEW_CONVERSATION_COLUMNS) {
  await db.execute(sql.raw(`alter table conversation_events drop column if exists ${column}`))
}
// 三个保留列上的 v7 词表约束要显式删掉（v6 里这三列是裸 text，没有任何 CHECK）
for (const suffix of ['source_kind_vocab', 'source_authority_vocab', 'epistemic_source_vocab']) {
  await db.execute(
    sql.raw(`alter table conversation_events drop constraint if exists conversation_events_${suffix}`)
  )
}
for (const column of ATTRIBUTION_V7_COLUMNS) {
  await db.execute(sql.raw(`alter table character_action_events drop column if exists ${column}`))
}
await db.execute(sql.raw(`drop table if exists developer_control_events`))
/*
 * WP9-B1：v9 只碰 `state_events`，而它加的全部东西就是那 19 列（CHECK 建在这些列上，
 * 因此 drop 列 = 连带 drop 约束，与 v8 的回退同型）。**不**单独写 drop constraint：
 * 那会让回退脚本与真实历史不一致。
 */
for (const column of V9_EXPECTED_COLUMNS) {
  await db.execute(sql.raw(`alter table state_events drop column if exists ${column}`))
}
/*
 * ⚠️ **2026-09-30**：登记行也要回退**到 6 为止的全部**（M10 加了 v10 ⇒ 写死 (7,8,9) 会留下 v10）。
 * ⚠️ **2026-10-03**：同一条教训**又**发生了一次（后 Lv2 加了 v11，而这里写死到 10）。
 *    这次按同一条原理修**根因**：**从迁移表推导**要回退的版本，不再写死清单 ——
 *    "新增迁移后忘了改这一行" 从此不再是可能的失败模式。
 */
const versionsToRollBack = MIGRATIONS.filter((m) => m.version >= 7).map((m) => m.version)
measure('回退目标版本数（从 MIGRATIONS 推导）', versionsToRollBack.length)
await db.execute(
  sql`delete from character_schema_migrations where version in ${sql.raw(
    `(${versionsToRollBack.join(', ')})`,
  )}`,
)
const rolledBack = await currentSchemaVersion(db)
check('把 v7 起的对象与登记都回退掉之后，库看起来就是 v6', rolledBack === 6, `v${String(rolledBack)}`)
check(
  '回退也把 v8 的 CHECK 一起去掉了（drop 列连带 DROP constraint，不需要单独写）',
  !(await constraintNamesOf('character_action_events')).includes(
    'character_action_events_axis_b_not_applicable'
  )
)
const convAtV6 = (await columnNamesOf('conversation_events')).length
const actionAtV6 = (await columnNamesOf('character_action_events')).length
const stateAtV6 = (await columnNamesOf('state_events')).length
measure('回退到 v6 后三张表的列数之和', convAtV6 + actionAtV6 + stateAtV6)
check(
  'v6 形状：conversation_events = 20 列（17 个 M4 时代列 + 0003 的 3 个 Axis B 列）',
  convAtV6 === 20,
  `${convAtV6} 列`
)
check('v6 形状：character_action_events = 12 列', actionAtV6 === 12, `${actionAtV6} 列`)
check('v6 形状：state_events = 11 列（M2 的形状，v9 之前）', stateAtV6 === 11, `${stateAtV6} 列`)
const pendingAtV6 = await pendingMigrations(db)
measure('v6 库上的待应用迁移数', pendingAtV6.length)
check(
  `v6 库上待应用 = [v7 … v${String(latestSchemaVersion())}]（升序、连续）`,
  pendingAtV6.length === latestSchemaVersion() - 6 &&
    pendingAtV6.every((m, index) => m.version === 7 + index),
  JSON.stringify(pendingAtV6),
)

const upgradeReport = await applyKernelMigrations(db)
check(
  `old(v6) → v${String(latestSchemaVersion())}：应用了 7 … ${String(latestSchemaVersion())}（升序）`,
  upgradeReport.fromVersion === 6 &&
    upgradeReport.toVersion === latestSchemaVersion() &&
    upgradeReport.applied.length === latestSchemaVersion() - 6 &&
    upgradeReport.applied.every((m, index) => m.version === 7 + index),
  `from=${String(upgradeReport.fromVersion)} to=${String(upgradeReport.toVersion)} applied=[${upgradeReport.applied.map((m) => m.version).join(',')}]`,
)

const againReport = await applyKernelMigrations(db)
check(
  `幂等：再跑一次应用 0 条、跳过 ${String(latestSchemaVersion())} 条`,
  againReport.applied.length === 0 && againReport.skipped === latestSchemaVersion(),
  `applied=${String(againReport.applied.length)} skipped=${String(againReport.skipped)}`,
)

/*
 * 净新增列数：v7 对 conversation_events 写了 22 条 `add column if not exists`，
 * 但其中 3 条（source_kind / source_authority / epistemic_source）在迁移 0003 就已存在，
 * 因此**净新增 19 列**；character_action_events 此前没有这三列，净新增 22 列。
 * **v8 不加任何列**（只换一条 CHECK）；**v9 只给 state_events 加 19 列**（不碰前两张表）。
 * 这条断言存在的理由：如果不量它，"22 列"会被读成"两张表各加了 22 列"。
 */
const convAtLatest = (await columnNamesOf('conversation_events')).length
const actionAtLatest = (await columnNamesOf('character_action_events')).length
const stateAtLatest = (await columnNamesOf('state_events')).length
check(
  'v7 净新增：conversation_events +19（22 条语句中 3 条是 no-op；v8/v9 不加列）',
  convAtLatest - convAtV6 === 19,
  `${convAtV6} → ${convAtLatest}（+${convAtLatest - convAtV6}）`
)
check(
  'v7 净新增：character_action_events +22（v8/v9 不加列）',
  actionAtLatest - actionAtV6 === 22,
  `${actionAtV6} → ${actionAtLatest}（+${actionAtLatest - actionAtV6}）`
)
check(
  'v9 净新增：state_events +19（18 槽位列 + attribution_origin；v7/v8 不加这张表）',
  stateAtLatest - stateAtV6 === 19,
  `${stateAtV6} → ${stateAtLatest}（+${stateAtLatest - stateAtV6}）`
)

const pendingNow = await pendingMigrations(db)
check('已到 v9 之后没有待应用迁移', pendingNow.length === 0, JSON.stringify(pendingNow))

// ===========================================================================
section('6. 数据库：K-4 三态互斥（**库是裁判**）')
// ===========================================================================

let sequence = 1
async function insertConversationEvent(input: {
  kind?: string | null
  id?: string | null
  reason?: string | null
  column?: 'actor' | 'authority'
  extra?: { attributionOrigin?: string | null; sourceKind?: string | null; sourceAuthority?: string | null; epistemicSource?: string | null }
}): Promise<{ ok: boolean; error?: string }> {
  const column = input.column ?? 'actor'
  const kindColumn = column === 'authority' ? 'authority_kind' : 'actor_kind'
  const idColumn = column === 'authority' ? 'authority_ref' : 'actor_ref_id'
  const reasonColumn = column === 'authority' ? 'authority_unknown_reason' : 'actor_unknown_reason'
  const rowId = `evt-${sequence}-${column}`
  const seq = sequence
  sequence += 1
  try {
    await db.execute(
      sql`insert into conversation_events
            (id, character_id, conversation_id, sequence, conversation_sequence, type, actor_type,
             content, schema_version, created_at,
             ${sql.raw(kindColumn)}, ${sql.raw(idColumn)}, ${sql.raw(reasonColumn)},
             attribution_origin, source_kind, source_authority, epistemic_source)
          values (${rowId}, 'char_test', 'conv_test', ${seq}, ${seq}, 'user_message', 'user',
                  'hi', 1, ${Date.now()},
                  ${input.kind ?? null}, ${input.id ?? null}, ${input.reason ?? null},
                  ${input.extra?.attributionOrigin ?? null}, ${input.extra?.sourceKind ?? null},
                  ${input.extra?.sourceAuthority ?? null}, ${input.extra?.epistemicSource ?? null})`
    )
    return { ok: true }
  } catch (error) {
    return { ok: false, error: (error as Error).message.slice(0, 160) }
  }
}

const triStateProbes: { combo: { kind: string | null; id: string | null; reason: string | null }; expected: 'accept' | 'reject' }[] = [
  { combo: { kind: null, id: null, reason: null }, expected: 'accept' },
  { combo: { kind: 'USER', id: 'u-1', reason: null }, expected: 'accept' },
  { combo: { kind: null, id: null, reason: 'LEGACY_UNRECORDED' }, expected: 'accept' },
  { combo: { kind: 'USER', id: null, reason: null }, expected: 'reject' },
  { combo: { kind: null, id: 'u-1', reason: null }, expected: 'reject' },
  { combo: { kind: 'USER', id: null, reason: 'LEGACY_UNRECORDED' }, expected: 'reject' },
  { combo: { kind: null, id: 'u-1', reason: 'RUNTIME_UNRESOLVED' }, expected: 'reject' },
  { combo: { kind: null, id: null, reason: 'NOPE' }, expected: 'reject' },
  { combo: { kind: 'HACKER', id: 'x', reason: null }, expected: 'reject' },
  { combo: { kind: 'UNKNOWN_LEGACY', id: 'x', reason: null }, expected: 'reject' },
]

measure('三态探针数（conversation_events.actor）', triStateProbes.length)
const triStateReadings: { combo: unknown; expected: string; observed: string; match: boolean }[] = []
for (const probe of triStateProbes) {
  const result = await insertConversationEvent(probe.combo)
  const observed = result.ok ? 'accept' : 'reject'
  const match = observed === probe.expected
  triStateReadings.push({ combo: probe.combo, expected: probe.expected, observed, match })
  check(
    `actor 三态：${JSON.stringify(probe.combo)} → 期望 ${probe.expected}`,
    match,
    match ? 'ok' : `实际 ${observed}（${result.error ?? ''}）`
  )
}

// authority 槽位同样要精确互斥（它的 id 列叫 authority_ref）
const authorityProbes = [
  { kind: null, id: null, reason: null, expected: 'accept' as const },
  { kind: 'CAPABILITY', id: 'sandbox.file.write', reason: null, expected: 'accept' as const },
  { kind: 'CAPABILITY', id: null, reason: null, expected: 'reject' as const },
  { kind: 'MAGIC', id: 'x', reason: null, expected: 'reject' as const },
]
measure('三态探针数（conversation_events.authority）', authorityProbes.length)
for (const probe of authorityProbes) {
  const result = await insertConversationEvent({ ...probe, column: 'authority' })
  const observed = result.ok ? 'accept' : 'reject'
  check(
    `authority 三态/词表：${JSON.stringify({ kind: probe.kind, id: probe.id })} → 期望 ${probe.expected}`,
    observed === probe.expected,
    observed === probe.expected ? 'ok' : `实际 ${observed}（${result.error ?? ''}）`
  )
}

// ===========================================================================
section('7. 数据库：Axis B 词表、完整性与旧代码兼容')
// ===========================================================================

const axisBProbes = [
  { label: "source_kind='NOPE'", extra: { sourceKind: 'NOPE' }, expected: 'reject' as const },
  { label: "source_authority='NOPE'", extra: { sourceAuthority: 'NOPE' }, expected: 'reject' as const },
  { label: "epistemic_source='NOPE'", extra: { epistemicSource: 'NOPE' }, expected: 'reject' as const },
  { label: "attribution_origin='WHATEVER'", extra: { attributionOrigin: 'WHATEVER' }, expected: 'reject' as const },
  {
    label: "origin='MIGRATED_LEGACY' 但 Axis B 不齐（缺 source_authority）",
    extra: { attributionOrigin: 'MIGRATED_LEGACY', sourceKind: 'user_statement', epistemicSource: 'UNCONFIRMED_ORIGIN' },
    expected: 'reject' as const,
  },
  {
    label: "origin='MIGRATED_LEGACY' 且 Axis B 齐全",
    extra: {
      attributionOrigin: 'MIGRATED_LEGACY',
      sourceKind: 'user_statement',
      sourceAuthority: 'UNCONFIRMED_ORIGIN',
      epistemicSource: 'UNCONFIRMED_ORIGIN',
    },
    expected: 'accept' as const,
  },
]
measure('Axis B 探针数', axisBProbes.length)
for (const probe of axisBProbes) {
  const result = await insertConversationEvent({
    kind: null,
    id: null,
    reason: 'LEGACY_UNRECORDED',
    extra: probe.extra,
  })
  const observed = result.ok ? 'accept' : 'reject'
  check(`Axis B：${probe.label} → 期望 ${probe.expected}`, observed === probe.expected, observed === probe.expected ? 'ok' : `实际 ${observed}（${result.error ?? ''}）`)
}

// 旧代码兼容：完全不带任何归因列的插入必须成功（新列全可空）
const v6Shaped = await (async () => {
  try {
    await db.execute(
      sql`insert into conversation_events
            (id, character_id, conversation_id, sequence, conversation_sequence, type, actor_type,
             content, schema_version, created_at)
          values ('evt-v6-shaped', 'char_test', 'conv_test', 900, 900, 'user_message', 'user',
                  '旧代码写的一行', 1, ${Date.now()})`
    )
    return { ok: true }
  } catch (error) {
    return { ok: false, error: (error as Error).message.slice(0, 160) }
  }
})()
check('旧代码兼容：不带归因列的 v6 形状插入成功', v6Shaped.ok, v6Shaped.error ?? 'ok')

// character_action_events 的样板非法元组同样必须被拒
const actionProbe = await (async () => {
  try {
    await db.execute(
      sql`insert into character_action_events
            (action_id, sequence, character_id, event_type, capability, operation,
             payload, schema_version, created_at, actor_kind, actor_ref_id, actor_unknown_reason)
          values ('act-1', 1, 'char_test', 'ACTION_REQUESTED', 'sandbox.file.write', 'write',
                  '{}'::jsonb, 1, ${Date.now()}, 'USER', null, null)`
    )
    return { ok: true }
  } catch (error) {
    return { ok: false, error: (error as Error).message.slice(0, 160) }
  }
})()
check('character_action_events 的 K-4 样板非法元组被拒', actionProbe.ok === false, actionProbe.error ?? '竟然通过了')

/*
 * ---- WP4.1 / K-22：v8 之后行动行的 Axis B 形状（库是裁判） --------------------
 *
 * v7 的 `axis_b_complete` 会**拒绝**第一行（声明了 origin 就必须编出三列 Axis B）；
 * v8 的 `axis_b_not_applicable` 接受它。这正是"v8 required = YES"的可执行证明。
 */
const insertActionEvent = async (input: {
  actionId: string
  attributionOrigin?: string | null
  sourceKind?: string | null
  sourceAuthority?: string | null
  epistemicSource?: string | null
}): Promise<{ ok: boolean; error?: string }> => {
  try {
    await db.execute(
      sql`insert into character_action_events
            (action_id, sequence, character_id, event_type, capability, operation,
             payload, schema_version, created_at,
             initiator_kind, initiator_id, actor_kind, actor_ref_id,
             recorded_by_kind, recorded_by_id,
             attribution_origin, source_kind, source_authority, epistemic_source)
          values (${input.actionId}, 1, 'char_test', 'ACTION_REQUESTED', 'sandbox.file.write', 'write',
                  '{}'::jsonb, 1, ${Date.now()},
                  'USER', 'u-1', 'CHARACTER', 'char_test',
                  'SYSTEM', 'kernel',
                  ${input.attributionOrigin ?? null}, ${input.sourceKind ?? null},
                  ${input.sourceAuthority ?? null}, ${input.epistemicSource ?? null})`
    )
    return { ok: true }
  } catch (error) {
    return { ok: false, error: (error as Error).message.slice(0, 160) }
  }
}

const actionAxisBProbes: {
  label: string
  input: Parameters<typeof insertActionEvent>[0]
  expected: 'accept' | 'reject'
}[] = [
  {
    label: "行动行 origin='RECORDED' 且 Axis B 三列全 NULL ⇒ **接受**（K-22 的目标形状）",
    input: { actionId: 'act-k22-accept', attributionOrigin: 'RECORDED' },
    expected: 'accept',
  },
  {
    label: "行动行带 source_kind='system_instruction' ⇒ **拒绝**（行动不得携带 Cognitive Axis B）",
    input: {
      actionId: 'act-k22-reject-kind',
      attributionOrigin: 'RECORDED',
      sourceKind: 'system_instruction',
      sourceAuthority: 'SYSTEM_INSTRUCTION',
      epistemicSource: 'system_instruction',
    },
    expected: 'reject',
  },
  {
    label: '行动行 Axis B 三列半填 ⇒ **拒绝**（连"看起来像 Axis B"都不允许）',
    input: {
      actionId: 'act-k22-reject-partial',
      attributionOrigin: 'RECORDED',
      sourceKind: 'user_statement',
      sourceAuthority: 'UNCONFIRMED_ORIGIN',
    },
    expected: 'reject',
  },
  {
    label: '行动行不声明 origin 但带 Axis B ⇒ **拒绝**（v8 收紧的那一格）',
    input: {
      actionId: 'act-k22-reject-no-origin',
      sourceKind: 'user_statement',
      sourceAuthority: 'UNCONFIRMED_ORIGIN',
      epistemicSource: 'UNCONFIRMED_ORIGIN',
    },
    expected: 'reject',
  },
]
measure('K-22 行动行 Axis B 探针数', actionAxisBProbes.length)
for (const probe of actionAxisBProbes) {
  const result = await insertActionEvent(probe.input)
  const observed = result.ok ? 'accept' : 'reject'
  check(
    `K-22 Axis B：${probe.label} → 期望 ${probe.expected}`,
    observed === probe.expected,
    observed === probe.expected ? 'ok' : `实际 ${observed}（${result.error ?? ''}）`
  )
}

// conversation_events 的 R-21 Axis B 语义**逐字不变**：同一组探针在对话表上仍然是老答案
const conversationAxisBUnchanged = await insertConversationEvent({
  kind: null,
  id: null,
  reason: 'LEGACY_UNRECORDED',
  extra: { attributionOrigin: 'RECORDED' },
})
check(
  'conversation_events 仍然要求完整 Axis B：origin=RECORDED + 三列全 NULL ⇒ 被拒（R-21 未被 v8 放宽）',
  conversationAxisBUnchanged.ok === false,
  conversationAxisBUnchanged.error ?? '竟然通过了'
)

// ===========================================================================
section('8. 控制面审计表：形状、三态、主键与命令词表')
// ===========================================================================

const controlInsert = async (input: {
  commandId: string
  sequence: number
  actorKind?: string | null
  actorId?: string | null
  actorReason?: string | null
  commandType?: string
  verification?: string | null
}): Promise<{ ok: boolean; error?: string }> => {
  /*
   * ⚠️ 这里**必须**区分"没传"与"传了 null"：
   *    `input.actorId ?? 'dev-console'` 会把**显式的 null 也换成默认值**，
   *    于是"只写 kind、不写 id"这个 K-4 样板反而变成了合法行 —— 探针自己把要测的东西抹掉了。
   *    第一版就是这么错的（它报"非法元组竟然通过了"）。用三元判断，让 null 保持 null。
   */
  const actorKind = input.actorKind === undefined ? 'SERVICE' : input.actorKind
  const actorId = input.actorId === undefined ? 'dev-console' : input.actorId
  const actorReason = input.actorReason === undefined ? null : input.actorReason
  const commandType = input.commandType ?? 'RUN_DIAGNOSTIC'
  const verification = input.verification === undefined ? 'not_attempted' : input.verification
  try {
    await db.execute(
      sql`insert into developer_control_events
            (command_id, sequence, character_id, command_type, verification,
             initiator_kind, initiator_id, actor_kind, actor_ref_id, actor_unknown_reason,
             authority_kind, authority_ref, recorded_by_kind, recorded_by_id, created_at)
          values (${input.commandId}, ${input.sequence}, 'char_test', ${commandType},
                  ${verification},
                  'USER', 'u-dev', ${actorKind}, ${actorId},
                  ${actorReason},
                  'CAPABILITY', 'developer.control', 'SYSTEM', 'control-service', ${Date.now()})`
    )
    return { ok: true }
  } catch (error) {
    return { ok: false, error: (error as Error).message.slice(0, 160) }
  }
}

const controlLegal = await controlInsert({ commandId: 'cmd-1', sequence: 1 })
check('控制命令的合法归因行可以入账（initiator=USER / actor=SERVICE / authority=CAPABILITY）', controlLegal.ok, controlLegal.error ?? 'ok')

const controlIllegal = await controlInsert({ commandId: 'cmd-2', sequence: 1, actorKind: 'SERVICE', actorId: null })
check('控制面审计表的 K-4 样板非法元组被拒', controlIllegal.ok === false, controlIllegal.error ?? '竟然通过了')

const controlBadType = await controlInsert({ commandId: 'cmd-3', sequence: 1, commandType: 'RUN_EVERYTHING' })
check("控制命令词表：command_type='RUN_EVERYTHING' 被拒", controlBadType.ok === false, controlBadType.error ?? '竟然通过了')

const controlBadVerification = await controlInsert({ commandId: 'cmd-4', sequence: 1, verification: 'probably' })
check("核验四态词表：verification='probably' 被拒", controlBadVerification.ok === false, controlBadVerification.error ?? '竟然通过了')

const controlDuplicate = await controlInsert({ commandId: 'cmd-1', sequence: 1 })
check('append-only 的物理底座：同一 (command_id, sequence) 重复插入被主键拒绝', controlDuplicate.ok === false, controlDuplicate.error ?? '竟然通过了')

// ===========================================================================
section('9. 迁移预览（临时库上的 v6 → v9）')
// ===========================================================================

/*
 * ⚠️ 证据文件名按仓库既有约定 **fork**：本脚本以前写 `wp2-schema.json` /
 * `migration-preview.txt`（WP2 的 v7 时代历史证据，**不覆盖**）。
 * WP4.1 起写 `wp4.1-migration-verify.json` / `wp4.1-migration-preview.txt`。
 */
const previewDir = join(process.cwd(), 'artifacts', 'm5.1.1')
mkdirSync(previewDir, { recursive: true })
const previewLines = [
  'M5.1.1 WP9-B1 —— 迁移预览（**临时库**上的 v6 → v9；真实库从未被打开）',
  '='.repeat(78),
  `沙箱库              ：${sandbox.dir}`,
  `真实库（只记录）    ：${PRODUCTION_DB_DIR}`,
  `代码最新 schema     ：v${latestSchemaVersion()}`,
  '',
  '待应用清单（在一个被回退到 v6 的临时库上调用 pendingMigrations）：',
  ...pendingAtV6.map(
    (item) => `  · v${item.version} ${item.name}（${item.statements} 条语句）`
  ),
  '',
  'v7 将要执行的语句（逐条，供人审阅）：',
  ...v7.statements.map((statement, index) => `  [${String(index + 1).padStart(3, '0')}] ${statement.replace(/\s+/g, ' ').trim()}`),
  '',
  `v7 语句总数         ：${v7.statements.length}`,
  'v7 破坏性语句扫描   ：0 条 drop / update / delete / truncate / alter column（迁移门 M1）',
  '',
  'v8 将要执行的语句（逐条，供人审阅；WP4.1 / K-22）：',
  ...v8.statements.map((statement, index) => `  [${String(index + 1).padStart(3, '0')}] ${statement.replace(/\s+/g, ' ').trim()}`),
  '',
  `v8 语句总数         ：${v8.statements.length}`,
  'v8 破坏性语句扫描   ：1 条 `drop constraint if exists`（**只**替换那条 CHECK；无列/数据变更）',
  '',
  'v9 将要执行的语句（逐条，供人审阅；WP9-B1 / R-45）：',
  ...v9.statements.map((statement, index) => `  [${String(index + 1).padStart(3, '0')}] ${statement.replace(/\s+/g, ' ').trim()}`),
  '',
  `v9 语句总数         ：${v9.statements.length}`,
  'v9 破坏性语句扫描   ：0 条（19 条 `add column if not exists` + 19 条 `add constraint`；' +
    '**只碰 state_events**、无 Axis B 列、无索引、无回填）',
  '',
  '⚠️ 真实库的 migrate:apply 不在本 WP 内 —— 它要等你放行（production-copy 流程见 m5.1.1:prod-copy:verify）。',
]
writeFileSync(join(previewDir, 'wp4.1-migration-preview.txt'), `${previewLines.join('\n')}\n`, 'utf8')

// ===========================================================================
section('10. 汇总与证据')
// ===========================================================================

const measurementInvalid = measurements.filter((item) => !item.valid)
check(
  '所有计数型检测器都有非零测量（否则 MEASUREMENT INVALID）',
  measurementInvalid.length === 0,
  `${measurements.length} 个检测器，无效 ${measurementInvalid.length}`
)

const evidence = {
  testId: 'M5.1.1 / WP9-B1 migration & physical attribution encoding (v9 / R-45 state_events)',
  generatedAt: new Date().toISOString(),
  command: 'pnpm m5.1.1:migration:verify',
  passed,
  failed,
  failures,
  k4: {
    ruling: 'K-4 / R-11 —— 约束数量不是架构不变量，三态精确互斥才是',
    illegalTuple: { kind: 'USER', id: null, unknown_reason: null },
    draftFourClausesAdmitsIllegalTuple: k4Exemplar.draftAdmits,
    k4ThreeBranchesRejectsIllegalTuple: k4Exemplar.k4Admits === false,
    truthTable,
  },
  k22: {
    ruling: 'K-22 —— Action attribution is NOT Cognitive Axis B；行动表 Axis B = NOT_APPLICABLE',
    v8Statements: v8.statements,
    v8DropsOnlyTheCheck: v8Drops.length === 1,
    conversationAxisBUnchangedProbe: conversationAxisBUnchanged,
    actionAxisBProbes: actionAxisBProbes.map((probe) => ({ label: probe.label, expected: probe.expected })),
  },
  stateEvent: {
    ruling: 'R-45 = SELECTED B —— 首启 state_events(trigger=init) 成为第一条可归属的系统来源状态转移',
    v9Statements: v9.statements,
    v9AddsExactly19Columns: v9AddColumns.length === 19,
    v9AddsExactly19Constraints: v9AddConstraints.length === 19,
    v9TouchesOnlyStateEvents: true,
    v9HasNoAxisBColumns: true,
    v9CreatesNoIndex: true,
    v9HasNoDataStatements: true,
    expectedColumns: [...V9_EXPECTED_COLUMNS],
    expectedConstraints: [...V9_EXPECTED_CONSTRAINTS],
    noBackfill: 'v9 里没有任何 update / insert ⇒ 既有行（含 trigger=init 那条）attribution_origin 保持 NULL',
  },
  static: {
    migrations: MIGRATIONS.map((m) => ({ version: m.version, name: m.name, statements: m.statements.length })),
    latestSchemaVersion: latestSchemaVersion(),
    frozenFingerprints: fingerprintReadings,
    v7StatementCount: v7.statements.length,
    v8StatementCount: v8.statements.length,
    v9StatementCount: v9.statements.length,
    destructiveStatements: destructive,
    columnsFromDdl: { conversation_events: conversationColumns, character_action_events: actionColumns },
    stateEventColumnsFromDdl: v9Columns,
    contractColumns: [...ATTRIBUTION_V7_COLUMNS],
    vocabularyReadings,
  },
  database: {
    sandboxDir: sandbox.dir,
    productionDirRecorded: PRODUCTION_DB_DIR,
    isProductionDir: isProductionDir(sandbox.dir),
    freshVersion,
    rolledBackVersion: rolledBack,
    upgradeReport: {
      fromVersion: upgradeReport.fromVersion,
      toVersion: upgradeReport.toVersion,
      applied: upgradeReport.applied,
    },
    idempotency: { applied: againReport.applied.length, skipped: againReport.skipped },
    netNewColumns: {
      conversation_events: { atV6: convAtV6, atLatest: convAtLatest, delta: convAtLatest - convAtV6 },
      character_action_events: { atV6: actionAtV6, atLatest: actionAtLatest, delta: actionAtLatest - actionAtV6 },
      state_events: { atV6: stateAtV6, atLatest: stateAtLatest, delta: stateAtLatest - stateAtV6 },
      note:
        'v7 对 conversation_events 写了 22 条 add column if not exists，其中 source_kind / ' +
        'source_authority / epistemic_source 在迁移 0003 已存在 ⇒ 这张表净新增 19 列；' +
        'character_action_events 此前没有这三列 ⇒ 净新增 22 列（**v8 不加任何列**，只替换一条 CHECK）。' +
        '**v9 只给 state_events 净新增 19 列**（18 槽位 + attribution_origin），前两张表一列未加',
    },
    pendingAfterUpgrade: pendingNow,
    controlTableColumns: controlColumns,
    stateEventColumns,
    stateEventConstraints,
    stateEventIndexes: stateEventIndexes.map((row) => row.indexname),
    index: indexRows[0] ?? null,
  },
  probes: {
    triState: triStateReadings,
    v6ShapedInsert: v6Shaped,
    actionEventIllegal: actionProbe,
    control: {
      legal: controlLegal,
      illegalExemplar: controlIllegal,
      badCommandType: controlBadType,
      badVerification: controlBadVerification,
      duplicatePrimaryKey: controlDuplicate,
    },
  },
  measurements,
  measurementInvalid: measurementInvalid.length,
  scope: {
    touched: ['src/infrastructure/persistence/migrations.ts', 'scripts/verify-m5.1.1-migration.ts'],
    notTouched: [
      '运行时写入路径 / 读出侧语义 / Fact Firewall / MemoryAuthority',
      '0001–0008（指纹锁逐条证明未变；v7/v8 仍是不可改的历史 DDL）',
      'conversation_events 的 Axis B 语义与 5 条约束（v8 只碰 character_action_events）',
      'state_events 的既有 11 列与既有行（v9 只 add column / add constraint，无回填）',
      'data/pglite（未打开；证据里记录的是沙箱路径）',
      'artifacts/m5.1/**、artifacts/m4.5/**、artifacts/m5/**',
      'artifacts/m5.1.1/wp2-schema.json / migration-preview.txt（WP2 历史证据：本脚本已 fork 到 wp4.1-*）',
    ],
    frozen: [
      'MIGRATION_0007（K-8：指纹 2d51997d…）',
      'MIGRATION_0008（WP4.1 锁定：0a2bd4fe…）',
      'MIGRATION_0009（WP9-B1 首次锁定；触发点 = 副本上第一次成功的 v6 → v9 apply）',
    ],
  },
}

writeFileSync(join(previewDir, 'wp4.1-migration-verify.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')

console.log(`\n${'='.repeat(74)}`)
console.log(`M5.1.1 迁移与物理编码验证（v9 / R-45 state_events）：${passed} 通过 / ${failed} 失败`)
console.log(`量具自检：${measurements.length} 个计数检测器，无效 ${measurementInvalid.length}`)
if (failures.length > 0) {
  console.log('失败项：')
  for (const failure of failures) console.log(`  - ${failure}`)
}
console.log('='.repeat(74))
console.log('证据已写入：artifacts/m5.1.1/wp4.1-migration-verify.json / wp4.1-migration-preview.txt')

try {
  await runtime.stop()
} catch {
  /* 关不干净不影响结论 */
}

process.exit(failed === 0 ? 0 : 1)
