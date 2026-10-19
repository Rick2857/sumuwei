/**
 * M5.1.1 / Phase 4b 前置 —— **真实库 v9 迁移后验证**（只读）
 *
 * ============================================================================
 *  这道门回答什么（用户 2026-09-19 的 `D-1 = ②`）
 * ============================================================================
 * 用户在 `4b` 预检的 `D-1` 上选了 **「先将真实库迁移至 v9，再考虑激活 4b」**。
 * 本脚本在迁移**之后**、**只读地**回答三个问题：
 *
 * ```text
 *   ① 迁移真的到了 v9 吗（版本 / 迁移表 / 待应用 = 0）
 *   ② 既有业务行**逐字未变**吗（身份摘要与 WP10-B 在**副本上**记录的 before 值相同）
 *   ③ 迁移有没有**伪造归因**（D01 的核心：任何一行都不得凭空长出一个人类来源）
 * ```
 *
 * ③ 是这里最重要的一条：迁移 0007 追加了 19 个归因列，而 WP3 的**回填是 BLOCKED 的**。
 *   ⇒ 真库上这些列必须**全为 NULL**。一旦有非 NULL，就意味着"迁移顺手编了一个来源" ——
 *   那正是 `DR-6`（只有鉴证的归因算数）要禁止的事，而且它会**不可回收**地污染真实历史。
 *
 * ============================================================================
 *  ⚠️ 这是**唯一**可以打开真实库的验收脚本之一；"只读"是**构造上**成立的
 * ============================================================================
 * 与 `scripts/verify-m4-real-db.ts` 同一范式：显式 `allowProductionDatabase()`，
 * 然后用一个**只允许 SELECT** 的 `rows()` 闸把所有查询关起来。
 * 只写"这份脚本不写库"的注释而不加闸，等于把守卫关掉换一个承诺 ——
 * 而承诺在有人顺手加一行 `update` 时不会拦任何人。
 *
 * 跑法：`pnpm m5.1.1:phase4b:db-v9`
 */

import type { Character, Plugin } from '../src/infrastructure/runtime/eliza-types.ts'
import { createThinHostRuntime } from '../src/infrastructure/runtime/thin-host-factory.ts'
import 'dotenv/config'

import { createHash } from 'node:crypto'

import { stringToUuid } from '../src/kernel/contracts/uuid.ts'


import { sql } from 'drizzle-orm'

import { character } from '../src/character/index.ts'
import { allowProductionDatabase, initDatabase } from '../src/db/index.ts'
import { isProductionDir } from '../src/dev/sandbox.ts'
import {
  lastVerifiedSnapshotId,
  prepareProductionOpen,
  productionDataDirOf,
  productionSnapshotRootOf,
  type ProductionOpenHandle,
} from '../src/infrastructure/persistence/production-open-guard.ts'
import {
  closeDatabaseConnection,
  createRuntimeShutdown,
  isDatabaseClosed,
  stopRuntimeServices,
} from '../src/infrastructure/persistence/runtime-shutdown.ts'
import { currentSchemaVersion, getRawDb, rowsOf } from '../src/infrastructure/persistence/db.ts'
import { latestSchemaVersion } from '../src/infrastructure/persistence/migrations.ts'
import {
  contaminatedMemories,
  unqualifiedUserFacts,
  unsupportedMemories,
} from '../src/infrastructure/persistence/memory-store.ts'
import { entityRef } from '../src/kernel/contracts/index.ts'
import { openAiCompatiblePlugin } from '../src/providers/openai-compatible.ts'
import { createPersistentCharacterPlugin } from '../src/plugin/persistent-character.ts'

allowProductionDatabase()

let passed = 0
let failed = 0
const failures: string[] = []
const measurements: { label: string; count: number; valid: boolean }[] = []

function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed += 1
    console.log(`  ✅ ${label}${detail ? `  [${detail}]` : ''}`)
  } else {
    failed += 1
    failures.push(`${label} :: ${detail}`)
    console.log(`  ❌ ${label}${detail ? `  [${detail}]` : ''}`)
  }
}

function measure(label: string, count: number): number {
  const valid = count > 0
  measurements.push({ label, count, valid })
  if (!valid) check(`[MEASUREMENT INVALID] ${label}（measured_count = 0）`, false, '什么都没测到')
  return count
}

const characterId = character.id ?? character.name
const userId = stringToUuid('user-Alex')

console.log('='.repeat(74))
console.log('M5.1.1 Phase 4b 前置 —— 真实库 v9 迁移后验证（只读）')
console.log('='.repeat(74))

const runtime = createThinHostRuntime({
    character: character,
    settings: {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? '',
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? 'https://api.deepseek.com',
    OPENAI_LARGE_MODEL: process.env.OPENAI_LARGE_MODEL ?? 'deepseek-flash',
    OPENAI_SMALL_MODEL: process.env.OPENAI_SMALL_MODEL ?? 'deepseek-flash',
  },
    conversationLength: 16,
  })

/*
 * INC-01 WP6：本脚本也是**真实库 opener** —— 先把状态机走完
 * （租约 → pre-open verified snapshot → 拿 token → 打开）。
 * 不是真实库目录（副本 / 沙箱）时不走状态机。
 */
const realDataDir = productionDataDirOf()
const realSnapshotRoot = productionSnapshotRootOf()
const guarded = process.env.PROJECT_LG_SANDBOX === undefined && isProductionDir(realDataDir)
let openHandle: ProductionOpenHandle | undefined
if (guarded) {
  openHandle = await prepareProductionOpen({
    dataDir: realDataDir,
    snapshotRoot: realSnapshotRoot,
    operationKind: 'real_db_verify',
    deps: {
      openDatabase: async () => {
        await initDatabase(runtime)
      },
      stopServices: () => stopRuntimeServices(runtime),
      closeDatabase: async () => await closeDatabaseConnection(runtime),
      isDatabaseClosed: () => isDatabaseClosed(runtime),
      lastVerifiedSnapshotId: () => lastVerifiedSnapshotId(realSnapshotRoot),
    },
  })
  await openHandle.open()
  console.log(
    `生产状态机：${openHandle.reading.states.join(' → ')}（pre-open 快照 ${openHandle.reading.preOpenSnapshotId ?? '未记录'}）`
  )
} else {
  await initDatabase(runtime)
}
const db = getRawDb(runtime)

/**
 * 唯一的读出口：**只允许 SELECT**。
 * 任何 insert / update / delete / create / drop 在这里当场抛错 ⇒
 * "本脚本不写真实库"是**可执行的约束**，不是注释里的承诺。
 */
async function read(statement: string): Promise<Record<string, unknown>[]> {
  const head = statement.trim().slice(0, 12).toLowerCase()
  if (!head.startsWith('select') && !head.startsWith('with')) {
    throw new Error(
      `本脚本是**只读**验收脚本，拒绝执行非 SELECT 语句：${statement.slice(0, 120)}\n` +
        '（这条约束是刻意的：它让"不写真实库"成为构造上的性质）'
    )
  }
  return rowsOf(await db.execute(sql.raw(statement)))
}

const scalar = async (statement: string): Promise<number> => {
  const rows = await read(statement)
  const first = rows[0] ?? {}
  return Number(Object.values(first)[0] ?? 0)
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

// ---------------------------------------------------------------------------
// §1 schema 版本
// ---------------------------------------------------------------------------

console.log('\n=== §1 schema 版本 ===')

const version = await currentSchemaVersion(db)
const latest = latestSchemaVersion()
measure('kernel 迁移条数', latest)
check('真实库 schema = 9（用户 D-1 = ② 的目标）', version === 9, `当前 ${version} · 代码最新 ${latest}`)
check('代码与库一致（没有待应用迁移）', version === latest, `${version} vs ${latest}`)

const migrationRows = await read('select version, name from character_schema_migrations order by version asc')
measure('character_schema_migrations 行数', migrationRows.length)
check(
  '迁移表恰好 1..9 连续（追加式迁移的硬形状）',
  migrationRows.length === 9 && migrationRows.every((row, index) => Number(row.version) === index + 1),
  migrationRows.map((row) => `v${String(row.version)}`).join(',')
)
check(
  'v7/v8/v9 就是本次应用的三条',
  migrationRows[6]?.name === 'm5.1.1-attribution-model' &&
    migrationRows[7]?.name === 'm5.1.1-k22-action-axis-b-not-applicable' &&
    migrationRows[8]?.name === 'm5.1.1-state-events-attribution',
  ['v7', 'v8', 'v9'].join(',')
)

// ---------------------------------------------------------------------------
// §2 既有业务行逐字未变（与 WP10-B 在**副本上**记录的 before 值比）
// ---------------------------------------------------------------------------

console.log('\n=== §2 既有业务行逐字未变（身份摘要 vs WP10-B 的 before 值）===')

/*
 * ⚠️ 摘要口径与 `verify-m5.1.1-wp10b-production-copy.ts:222-244` **逐字相同**：
 *    身份列 → `String(row[c] ?? '')` → 制表符连接 → 换行连接 → sha256。
 *    口径不同的话，"前后一致"就只是"两个不同的量恰好都没变"，证明不了任何东西。
 */
const IDENTITY_COLUMNS: Record<string, string[]> = {
  conversation_events: ['id', 'conversation_id', 'conversation_sequence', 'type', 'actor_type'],
  character_action_events: ['action_id', 'sequence', 'event_type'],
  state_events: ['id', 'trigger', 'state_version'],
}

/** WP10-B 在 production-copy 上记录的 before 值（canonical） */
const EXPECTED_BEFORE: Record<string, { rows: number; digest: string }> = {
  conversation_events: {
    rows: 28,
    digest: 'd5277b5979060751191672e19feb573a08682ac8ed0153aaea647bc27d2ff1d3',
  },
  character_action_events: {
    rows: 0,
    digest: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  },
  state_events: {
    rows: 1,
    digest: 'c6ae3092fb4e497266683e11e0ae44c85172500afad3edaf82a928e675924e19',
  },
}

const actual: Record<string, { rows: number; digest: string }> = {}
for (const [table, columns] of Object.entries(IDENTITY_COLUMNS)) {
  const rows = await read(`select ${columns.join(', ')} from ${table} order by ${columns.join(', ')}`)
  actual[table] = {
    rows: rows.length,
    digest: sha256(rows.map((row) => columns.map((c) => String(row[c] ?? '')).join('\t')).join('\n')),
  }
}

measure(
  '比对的表数',
  Object.keys(actual).length
)
for (const [table, reading] of Object.entries(actual)) {
  const expected = EXPECTED_BEFORE[table]
  check(
    `${table}：行数与身份摘要与迁移前**逐字相同**`,
    expected !== undefined && reading.rows === expected.rows && reading.digest === expected.digest,
    `${reading.rows} 行 / ${reading.digest.slice(0, 12)}（期望 ${String(expected?.rows)} 行 / ${String(expected?.digest).slice(0, 12)}）`
  )
}

// ---------------------------------------------------------------------------
// §3 ⚠️ 有没有凭空长出来的归因（D01 的核心）
// ---------------------------------------------------------------------------

console.log('\n=== §3 不得伪造归因（迁移只许追加列，不许编来源）===')

const ATTRIBUTION_TABLES = ['conversation_events', 'character_action_events', 'state_events']
for (const table of ATTRIBUTION_TABLES) {
  const withOrigin = await scalar(
    `select count(*) as c from ${table} where attribution_origin is not null`
  )
  check(
    `${table}：没有任何一行带 \`attribution_origin\`（回填是 BLOCKED 的）`,
    withOrigin === 0,
    `${withOrigin} 行非 NULL`
  )
  const userOriginators = await scalar(
    `select count(*) as c from ${table} where content_originator_kind = 'USER'`
  )
  check(
    `${table}：没有任何一行声称 \`contentOriginator = USER\`（**不得**凭空造出"用户说的"）`,
    userOriginators === 0,
    `${userOriginators} 行`
  )
}

const legacyOrigin = await scalar(
  `select count(*) as c from conversation_events where attribution_origin = 'MIGRATED_LEGACY'`
)
check(
  '全库没有 `MIGRATED_LEGACY`（本次迁移**不是**回填；WP3 的回填仍然 BLOCKED）',
  legacyOrigin === 0,
  `${legacyOrigin} 行`
)

// ---------------------------------------------------------------------------
// §4 列形状（追加式迁移的机械证明）
// ---------------------------------------------------------------------------

console.log('\n=== §4 列形状 ===')

const columns = await read(
  `select column_name from information_schema.columns
   where table_schema = 'public' and table_name = 'conversation_events'
   order by column_name asc`
)
const columnNames = columns.map((row) => String(row.column_name))
measure('conversation_events 的列数', columnNames.length)
check(
  'conversation_events 的列数 = 39（17 旧 + 3 M3 + 19 v7 净新增 —— 与 WP10-B 的副本读数同口径）',
  columnNames.length === 39,
  `${columnNames.length} 列`
)
for (const column of ['attribution_origin', 'content_originator_kind', 'actor_kind', 'initiator_kind']) {
  check(`列存在：conversation_events.${column}`, columnNames.includes(column))
}

// ---------------------------------------------------------------------------
// §5 记忆面未被触碰（N-3 的前置：authority 逐字节未变）
// ---------------------------------------------------------------------------

console.log('\n=== §5 记忆面未被触碰（N-3 的前置）===')

const memoryRows = await read('select id, memory_type, authority, status from memory_records order by id asc')
measure('memory_records 行数', memoryRows.length)
check(
  'memory_records 仍是 2 条，且 authority 仍是 EXPLICIT_USER_STATEMENT（迁移**没有**动它）',
  memoryRows.length === 2 && memoryRows.every((row) => row.authority === 'EXPLICIT_USER_STATEMENT'),
  memoryRows.map((row) => `${String(row.memory_type)}=${String(row.authority)}`).join(' · ')
)
const linkRows = await read('select memory_id, evidence_kind, evidence_id from memory_evidence_links order by memory_id asc')
measure('memory_evidence_links 行数', linkRows.length)
check('memory_evidence_links 仍是 2 条', linkRows.length === 2, `${linkRows.length} 条`)

// 污染探针（DR-9：判据一字未改）
const owner = entityRef('character', characterId)
const contaminated = await contaminatedMemories(db, owner)
const unsupported = await unsupportedMemories(db, owner)
measure('contaminatedMemories 探针扫过的记忆条数（= memory_records 行数）', memoryRows.length)
check(
  '既有污染探针仍然 = 0（新增的资格状态**不得**被算成污染）',
  contaminated.length === 0,
  `${contaminated.length} 条`
)
check(
  '证据完整性探针仍然 = 0（迁移没有弄丢任何 evidence link）',
  unsupported.length === 0,
  `${unsupported.length} 条`
)

// ---------------------------------------------------------------------------
// §5b ★ Phase 4b：真库上的**当前资格**读数（N-3 的真实语料证据）
// ---------------------------------------------------------------------------

console.log('\n=== §5b ★ Phase 4b：真库上的当前资格读数（N-3 / N-6）===')

/*
 * 这一段回答两个问题，两个都必须为真才算 4b 在真库上"如预期"：
 *
 * ```text
 * ① 资格派生**没有**动库：跑前后 `(authority, status)` 摘要逐字相同（N-3）
 * ② 真库今天**全部**用户事实的资格都是 UNCONFIRMED_ORIGIN
 *    （历史行没有受信信封 —— 那正是 D01 想要的诚实状态，`DR-12` 之前不许关闭 D01）
 * ```
 */
const memoryIdentityDigest = async (): Promise<string> => {
  const rows = await read(
    'select id, memory_type, authority, status from memory_records order by id asc'
  )
  return sha256(rows.map((row) => `${String(row.id)}|${String(row.authority)}|${String(row.status)}`).join('\n'))
}

const qualificationOwner = entityRef('character', characterId)
const digestBeforeQualification = await memoryIdentityDigest()
const qualification = await unqualifiedUserFacts(db, qualificationOwner)
const digestAfterQualification = await memoryIdentityDigest()

measure('资格探针扫过的用户事实条数', qualification.scanned)
check(
  '★ N-3（真实库）：跑完资格派生之后 `memory_records` 的 (authority, status) 摘要**逐字节未变**',
  digestAfterQualification === digestBeforeQualification,
  digestBeforeQualification.slice(0, 16)
)
check(
  '★ N-6（真实库）：探针确实扫到了条目（`measured_count > 0`）',
  qualification.scanned > 0,
  `scanned=${qualification.scanned}`
)
check(
  '★ 真实语料：**全部**用户事实的资格 = UNCONFIRMED_ORIGIN（历史行没有受信信封）',
  qualification.counts.unconfirmedOrigin === qualification.scanned &&
    qualification.counts.established === 0 &&
    qualification.counts.contradictedOrigin === 0,
  JSON.stringify(qualification.counts)
)
check(
  '★ 两个探针**不合并**：污染仍 = 0，而"资格未确立" = 全部（它们是两个不同的问题）',
  contaminated.length === 0 && qualification.unqualified.length === qualification.scanned,
  `contaminated=${contaminated.length} · unqualified=${qualification.unqualified.length}/${qualification.scanned}`
)

// ---------------------------------------------------------------------------
// §6 只读闸的**负控**（证明"不写库"是构造上的，不是承诺）
// ---------------------------------------------------------------------------

console.log('\n=== §6 只读闸的负控（正控 / 负控 / 恢复三段式）===')

let rejected = false
let rejectionMessage = ''
try {
  await read('update conversation_events set content = content')
} catch (error) {
  rejected = true
  rejectionMessage = String((error as Error).message).slice(0, 80)
}
check('负控：`update` 语句被只读闸当场拒绝', rejected, rejectionMessage || '(没有抛错 —— 闸失效了)')

let selectAllowed = false
try {
  await read('select 1 as one')
  selectAllowed = true
} catch {
  selectAllowed = false
}
check('恢复：`select` 仍然放行（闸没有把读也挡掉）', selectAllowed)

// ---------------------------------------------------------------------------
// 收尾
// ---------------------------------------------------------------------------

/*
 * INC-01 WP3（`AT3.5`）：与 `verify-m4-real-db.ts` 同一条理由 ——
 * 这个只读验收打开了真库，退出前必须先关连接。
 *
 * INC-01 WP6：关闭之后由状态机做 post-close verified snapshot 并释放租约。
 */
await createRuntimeShutdown(runtime, {
  afterRun: async (reading) => {
    if (openHandle === undefined) return
    const result = await openHandle.finish({
      closed: reading.closed,
      detail: reading.note,
      afterClose: true,
    })
    console.log(
      `生产状态机收尾：${result.states.join(' → ')}（cleanClose=${String(result.cleanClose)}，post-close 快照 ${result.postCloseSnapshotId ?? '未记录'}）`
    )
  },
}).shutdown()

console.log('\n=== §7 量具自检 ===')
check(
  '量具有效：扫描范围非空 + 每个计数型读数都 > 0',
  measurements.length > 0 && measurements.every((m) => m.valid),
  `${measurements.length} 个读数`
)

console.log('\n' + '='.repeat(74))
console.log(`真库 v9 迁移后验证：${passed} 通过 / ${failed} 失败`)
if (failures.length > 0) console.log(`失败项：${failures.join(' | ')}`)
console.log('='.repeat(74))
process.exit(failed === 0 ? 0 : 1)
