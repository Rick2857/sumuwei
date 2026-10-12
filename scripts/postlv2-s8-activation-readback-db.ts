/**
 * **S8 / ADR-094 `D08`（活库半边）** —— 真实库只读读回
 * （`pnpm postlv2:s8:activation-readback:db`）。
 *
 * ============================================================================
 *  它是什么
 * ============================================================================
 *  激活（迁移 v11–v13 + `.env` 开关）之后的**活库侧**核对：
 * ```text
 * B1 kernel schema 版本 ≥ 13（S8 的两条迁移真的应用上了）
 * B2 三张 S8 表在（storyline_commits / storyline_observations / storyline_consumer_watermarks）
 * B3 三张表的行数（读出来，不设阈值 —— 激活时就是 0 也是事实）
 * B4 水位行按消费者列出（未消费 ⇒ 0 行，那是**读数**不是失败）
 * B5 只读性自证：`rows()` 拒绝一切非 SELECT；且本脚本不写任何文件
 * ```
 *
 * ⚠️ **口径纪律**（`verify-m4-real-db.ts:194-200` 的教训）：
 *    **不**写死"版本恰好是 13" —— 那会在每次新增迁移时变成假红。
 *    要守的是"**≥ 13**，即 S8 的两条迁移已经应用"。
 * ⚠️ 本脚本是**真实库 opener** ⇒ 走 INC-01 生产状态机
 *    （租约 → pre-open verified snapshot → token → 打开 → 干净关闭）。
 * ⚠️ 它**不 import `src/main.ts`**（模块加载会无条件跑完整 CLI）。
 */

import 'dotenv/config'

import { AgentRuntime, stringToUuid, type Character, type Plugin } from '@elizaos/core'
import sqlPlugin from '@elizaos/plugin-sql'
import openaiPlugin from '@elizaos/plugin-openai'
import bootstrapPlugin from '@elizaos/plugin-bootstrap'

import { character } from '../src/character/index.ts'
import { allowProductionDatabase, initDatabase } from '../src/db/index.ts'
import { createPersistentCharacterPlugin } from '../src/plugin/persistent-character.ts'
import { openAiCompatiblePlugin } from '../src/providers/openai-compatible.ts'
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
import { sql } from 'drizzle-orm'

/** 唯一的数据访问口：**只允许 SELECT**（构造上的只读） */
async function rows(db: { execute: (q: unknown) => Promise<unknown> }, statement: string): Promise<Record<string, unknown>[]> {
  const head = statement.trim().toLowerCase()
  if (!head.startsWith('select')) {
    throw new Error(`postlv2-s8-activation-readback:db 是**只读**脚本，拒绝非 SELECT：${statement.slice(0, 120)}`)
  }
  return rowsOf(await db.execute(sql.raw(statement)))
}

interface Check {
  id: string
  label: string
  pass: boolean
  detail: string
  measured: number
}
const checks: Check[] = []
const record = (id: string, label: string, pass: boolean, detail: string, measured: number): void => {
  checks.push({ id, label, pass, detail, measured })
  console.log(`  ${pass ? '✅' : '❌'} ${id} ${label} —— ${detail}`)
}

console.log('='.repeat(72))
console.log('S8 生产激活读回（**活库侧**；只读）')
console.log('='.repeat(72))

allowProductionDatabase()

const characterId = character.id ?? character.name
const userId = stringToUuid('user-Alex')
const runtime = new AgentRuntime({
  character: character as Character,
  plugins: [
    openaiPlugin,
    bootstrapPlugin,
    openAiCompatiblePlugin,
    createPersistentCharacterPlugin({ characterId, userId }),
  ] as Plugin[],
  conversationLength: 16,
  settings: {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? '',
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? 'https://api.deepseek.com',
    OPENAI_LARGE_MODEL: process.env.OPENAI_LARGE_MODEL ?? 'deepseek-flash',
    OPENAI_SMALL_MODEL: process.env.OPENAI_SMALL_MODEL ?? 'deepseek-flash',
  },
})

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
        await initDatabase(runtime, sqlPlugin)
      },
      stopServices: () => stopRuntimeServices(runtime),
      closeDatabase: async () => await closeDatabaseConnection(runtime),
      isDatabaseClosed: () => isDatabaseClosed(runtime),
      lastVerifiedSnapshotId: () => lastVerifiedSnapshotId(realSnapshotRoot),
    },
  })
  await openHandle.open()
  console.log(`   生产状态机：${openHandle.reading.states.join(' → ')}（pre-open 快照 ${openHandle.reading.preOpenSnapshotId ?? '未记录'}）`)
} else {
  await initDatabase(runtime, sqlPlugin)
}

const db = getRawDb(runtime)

/* B1 schema 版本（**≥ 13**，不写死恰好 13） */
const version = await currentSchemaVersion(db)
record(
  'B1',
  'kernel schema 版本 **≥ 13**（S8 的 `#12`/`#13` 已应用）',
  Number(version) >= 13,
  `活库 version=${String(version)} · 代码最新=${String(latestSchemaVersion())}`,
  1
)

/* B2/B3 三张表在 + 行数 */
const tables = [
  ['storyline_commits', '提交账本'],
  ['storyline_observations', '观测'],
  ['storyline_consumer_watermarks', '独立水位'],
] as const
for (const [table, label] of tables) {
  const exists = await rows(
    db,
    `select table_name from information_schema.tables where table_schema = 'public' and table_name = '${table}'`
  )
  let count = -1
  if (exists.length > 0) {
    const counted = await rows(db, `select count(*)::int as c from ${table}`)
    count = Number(counted[0]?.c ?? -1)
  }
  record(
    `B2-${table}`,
    `${label}表 \`${table}\` 在（S8 迁移真的建了表）`,
    exists.length === 1,
    `在=${String(exists.length === 1)} · 行数=${String(count)}（**读出来而已，不设阈值**）`,
    1 + (count >= 0 ? 1 : 0)
  )
}

/* B4 水位行（按消费者列出） */
const watermarks = await rows(
  db,
  'select consumer, count(*)::int as rows, coalesce(max(last_consumed_revision), 0)::int as max_revision from storyline_consumer_watermarks group by consumer order by consumer'
)
record(
  'B4',
  '水位行按消费者列出（**未消费 ⇒ 0 行是读数，不是失败** —— 今天只接了 `affect` 一路，且首个真实对话轮尚未发生）',
  true,
  watermarks.length === 0
    ? '水位表为空（0 行）'
    : watermarks.map((row) => `${String(row.consumer)}:行${String(row.rows)}/最大r${String(row.max_revision)}`).join(' · '),
  Math.max(1, watermarks.length)
)

/* B5 只读性自证：非 SELECT 必须被拒 */
let guardHeld = false
try {
  await rows(db, 'delete from storyline_consumer_watermarks')
} catch {
  guardHeld = true
}
record('B5', '只读性自证：`rows()` **拒绝**非 SELECT 语句（构造上只读，不是靠自觉）', guardHeld, `非 SELECT 被拒=${String(guardHeld)}`, 1)

const measuredCount = checks.reduce((sum, check) => sum + check.measured, 0)
const failed = checks.filter((check) => !check.pass)
const passed = measuredCount > 0 && failed.length === 0

/*
 * 干净关闭：`stop → close → closed check` **只有一处实现**（`runtime-shutdown.ts`，INV-DB-06）；
 * 生产状态机的收尾走 `openHandle.finish(...)`（与 `verify-m4-real-db.ts:405-416` 同形）。
 */
const shutdown = createRuntimeShutdown({
  runtime,
  afterRun: async (reading: { closed: boolean; note?: string }) => {
    if (openHandle === undefined) return
    const result = await openHandle.finish({
      closed: reading.closed,
      detail: reading.note,
      afterClose: true,
    })
    console.log(
      `   生产状态机收尾：${result.states.join(' → ')}（cleanClose=${String(result.cleanClose)}）`
    )
  },
})
const closed = await shutdown.shutdown()

console.log('')
console.log(`  measured_count = ${measuredCount}`)
console.log(`  ${passed ? '✅' : '❌'} postlv2:s8:activation-readback:db（**活库侧，只读**）= ${passed ? 'PASS' : 'FAIL'}`)
console.log('  ⚠️ 本脚本**不**写文件、**不**写库；它只把活库当前状态读出来。')
process.exit(passed ? 0 : 1)
