/**
 * ⓓ **受控重建真实库的 `goal:%` 投影** + 由 INC-01 状态机产出 post-close verified snapshot。
 *
 * ============================================================================
 *  这是**生产数据写入**（`F-WP5-10` 的岔路口 ⓓ，2026-10-13 用户裁定）
 * ============================================================================
 *  **为什么要做**：`F-WP5-10` 让真实库的 `goal:%` 行带着**历史膨胀的 `revision`**
 *  （19 行里 18 行；Δ合计 563）。代码侧的闸已修（`foldGoalRowsInMemory` 的幂等闸），
 *  但闸**只堵未来、不改历史**。而迁移线的 `PG-G06` 的 `G06.1f` 比的是
 *  "**恢复出来的行** vs **重建出来的行**" ⇒ 源里带着历史污染值，它永远红。
 *  又因为 `PG-G05` 要求**源与目标逐表内容相同**，不能在目标侧偷偷重建 ⇒
 *  **只能在源（真实库）上受控重建一次**，然后取新快照。
 *
 * ============================================================================
 *  安全边界（一样都不能省）
 * ============================================================================
 * ```text
 *   ① 必须显式 `--apply`（不带 ⇒ **干跑**，打印计划后退出 2；**不碰库**）
 *   ② 只对**真实库目录**生效（`isProductionDir`）；其它目录一律拒绝
 *   ③ 走 INC-01 生产状态机（`prepareProductionOpen`）：租约 → pre-open verified snapshot
 *      → token → 打开 → **关库后** post-close verified snapshot → RELEASED(cleanClose)
 *   ④ 重建在**一个事务**里（`rebuildGoalProjections` 自带 `inTransaction`）⇒ 中途失败回滚
 *   ⑤ 事后**读回并核对 A == B**（用真代码折叠一遍，逐行比 revision / 序号 / lastId / state）
 *      —— 不核对就不算成功；核对不过 ⇒ 退出码 4（不是 0）
 *   ⑥ 只打印**行键尾与计数**，不打印任何 state 正文
 * ```
 *
 * 跑法：
 * ```bash
 * pnpm postgresql:goal-rebuild:apply            # 干跑（安全）
 * pnpm postgresql:goal-rebuild:apply --apply    # 真的重建（生产数据写入）
 * ```
 */
import 'dotenv/config'

import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

/*
 * ⚠️ `dotenv/config` **必须在最前面**（第一版漏了它）：`productionSnapshotRootOf()` 读的是
 *    `process.env.PGLITE_SNAPSHOT_DIR`，而 `.env` 把它指向
 *    `./data/snapshots/desktop-actions-activation-20261009`（**子目录**）。
 *    不加载 `.env` ⇒ 解析成默认根 `data/snapshots` ⇒ post-close 快照会落进**另一个**根，
 *    而生产核心的"最后一份 verified 快照"链**不会**看到它 —— 那是"看起来做了快照、
 *    其实没接上"的典型形态。
 */

const APPLY = process.argv.includes('--apply')

const { isProductionDir } = await import('../src/dev/sandbox.ts')
const { productionDataDirOf, productionSnapshotRootOf, prepareProductionOpen, lastVerifiedSnapshotId } =
  await import('../src/infrastructure/persistence/production-open-guard.ts')
const { allowProductionDatabase, initDatabase } = await import('../src/db/index.ts')
const { getRawDb } = await import('../src/infrastructure/persistence/db.ts')
const { domainEventsFor, rowToDomainEvent } = await import(
  '../src/infrastructure/persistence/event-store.ts'
)
const { rebuildGoalProjections } = await import('../src/infrastructure/persistence/goal-store.ts')
const { GOAL_HANDLED_EVENT_TYPES, foldGoalRowsInMemory, goalEventTargets } = await import(
  '../src/kernel/projections/goal.ts'
)

const dataDir = productionDataDirOf()
const sandboxed = process.env.PROJECT_LG_SANDBOX !== undefined
const isProduction = !sandboxed && isProductionDir(dataDir)

const stamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 17)
const OUT_DIR = resolve(`artifacts/post-lv2/postgresql-migration/goal-rebuild-${stamp}`)

if (!isProduction) {
  console.error(`拒绝：本程序**只**对真实库目录生效。dataDir=${dataDir}（sandboxed=${String(sandboxed)}）`)
  process.exit(2)
}

if (!APPLY) {
  console.log('干跑（没有 --apply）—— **不会打开任何数据库**')
  console.log(`  目标真实库 : ${dataDir}`)
  console.log(`  快照根     : ${productionSnapshotRootOf()}`)
  console.log(`  将要做     : 走 INC-01 状态机打开 → 事务内 rebuildGoalProjections(goal:%) →`)
  console.log(`               逐行核对 A==B → 关库 → post-close verified snapshot`)
  console.log(`  操作类别   : goal_projection_rebuild`)
  console.log(`  上一份快照 : ${lastVerifiedSnapshotId(productionSnapshotRootOf()) ?? '(none)'}`)
  console.log('')
  console.log('要真的执行，加 --apply（那是一次**生产数据写入**）。')
  process.exit(2)
}

/* ---- 显式放行（中央闸仍要求 pre-open token）---- */
allowProductionDatabase()

const { AgentRuntime } = await import('@elizaos/core')
const sqlPlugin = (await import('@elizaos/plugin-sql')).default
const { character } = await import('../src/character/index.ts')

const runtime = new AgentRuntime({ character: character as never, plugins: [], settings: {} })

const { stopRuntimeServices, closeDatabaseConnection, isDatabaseClosed, createRuntimeShutdown } =
  await import('../src/infrastructure/persistence/runtime-shutdown.ts')

let handle: Awaited<ReturnType<typeof prepareProductionOpen>> | undefined

const canonical = (value: unknown): string => {
  if (value === null || value === undefined) return 'null'
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}}`
  }
  return JSON.stringify(value)
}
const short = (value: unknown): string =>
  createHash('sha256').update(canonical(value)).digest('hex').slice(0, 12)

interface Reading {
  goalRows: number
  goalDigest: string
  goalStatuses: string
  allProjectionsDigest: string
  domainEvents: number
  revisions: Record<string, number>
}

let ok = false
let reason: string | undefined
let before: Reading | undefined
let after: Reading | undefined
let rebuild: { appliedEvents: number; previousRowCount: number } | undefined
let aEqualsB: Record<string, unknown> | undefined

try {
  handle = await prepareProductionOpen({
    dataDir,
    snapshotRoot: productionSnapshotRootOf(),
    operationKind: 'goal_projection_rebuild',
    deps: {
      openDatabase: async () => {
        await initDatabase(runtime, sqlPlugin)
      },
      stopServices: () => stopRuntimeServices(runtime),
      closeDatabase: async () => await closeDatabaseConnection(runtime),
      isDatabaseClosed: () => isDatabaseClosed(runtime),
      lastVerifiedSnapshotId: () => lastVerifiedSnapshotId(productionSnapshotRootOf()),
    },
  })
  await handle.open()
  console.log(`[inc-01] 生产状态机：${handle.reading.states.join(' → ')}`)
  if (handle.reading.preOpenSnapshotId !== undefined) {
    console.log(`[inc-01] pre-open verified snapshot：${handle.reading.preOpenSnapshotId}`)
  }

  const db = getRawDb(runtime)
  const one = async (sqlText: string): Promise<string> => {
    const rows = (await (db as unknown as { execute: (q: string) => Promise<unknown> }).execute(sqlText)) as
      | { rows?: Record<string, unknown>[] }
      | Record<string, unknown>[]
    const list = Array.isArray(rows) ? rows : (rows.rows ?? [])
    const first = list[0]
    return first === undefined ? '' : String(Object.values(first)[0] ?? '')
  }

  const characterId = await one('select character_id from character_projections limit 1')
  if (characterId === '') throw new Error('读不出 character_id ⇒ 不知道要重建谁的投影')

  const readState = async (): Promise<Reading> => {
    const goalRows = Number(await one("select count(*) from character_projections where projection_type like 'goal:%'"))
    const goalDigest = await one(
      "select coalesce(md5(string_agg(projection_type||'|'||revision::text||'|'||reducer_version||'|'||coalesce(last_domain_event_id,'-')||'|'||coalesce(last_domain_event_sequence::text,'-'), ',' order by projection_type)),'(none)') from character_projections where projection_type like 'goal:%'"
    )
    const goalStatuses = await one(
      "select coalesce(string_agg(projection_type||'='||coalesce(state->>'status','-'), ',' order by projection_type),'(none)') from character_projections where projection_type like 'goal:%'"
    )
    const allProjectionsDigest = await one(
      "select coalesce(md5(string_agg(projection_type||'|'||revision::text, ',' order by projection_type)),'(none)') from character_projections"
    )
    const domainEvents = Number(await one('select count(*) from character_domain_events'))
    const revisionRows = await one(
      "select coalesce(string_agg(projection_type||'|'||revision::text, ' ; ' order by projection_type),'(none)') from character_projections where projection_type like 'goal:%'"
    )
    const revisions: Record<string, number> = {}
    for (const part of revisionRows.split(' ; ')) {
      const [key, revision] = part.split('|')
      if (key !== undefined && revision !== undefined && key !== '') revisions[key] = Number(revision)
    }
    return { goalRows, goalDigest, goalStatuses, allProjectionsDigest, domainEvents, revisions }
  }

  before = await readState()
  console.log('')
  console.log(`重建前：goal 行 ${before.goalRows} · 领域事件 ${before.domainEvents}`)
  console.log(`        goal 摘要 ${before.goalDigest}`)

  /* ---- 有界写：一个事务（中途失败回滚）---- */
  const result = await rebuildGoalProjections(db as never, characterId as never)
  rebuild = { appliedEvents: result.appliedEvents, previousRowCount: result.previousRowCount }

  after = await readState()
  console.log(`重建后：goal 行 ${after.goalRows} · 领域事件 ${after.domainEvents}`)
  console.log(`        goal 摘要 ${after.goalDigest}`)

  /* ---- ★ 读回核对 A == B：用真代码从事件流折叠一遍，逐行比 ---- */
  const events = await domainEventsFor(db as never, characterId as never)
  const relevant = events.filter(
    (event) =>
      (GOAL_HANDLED_EVENT_TYPES as readonly string[]).includes(event.type) &&
      goalEventTargets(event, characterId)
  )
  const cache = new Map<string, { revision: number; state: unknown; lastDomainEventId?: string; lastDomainEventSequence?: number }>()
  foldGoalRowsInMemory(cache as never, relevant)

  const storedRows = (await (db as unknown as { execute: (q: string) => Promise<unknown> }).execute(
    "select projection_type, revision, last_domain_event_id, last_domain_event_sequence, state from character_projections where projection_type like 'goal:%'"
  )) as { rows?: Record<string, unknown>[] } | Record<string, unknown>[]
  const stored = Array.isArray(storedRows) ? storedRows : (storedRows.rows ?? [])

  const mismatches: string[] = []
  for (const row of stored) {
    const key = String(row.projection_type)
    const folded = cache.get(key)
    if (folded === undefined) {
      mismatches.push(`${key.slice(-12)}: 折叠里没有这一行`)
      continue
    }
    if (Number(row.revision) !== folded.revision) {
      mismatches.push(`${key.slice(-12)}: revision 存 ${String(row.revision)} / 折叠 ${folded.revision}`)
    }
    if (String(row.last_domain_event_id ?? '') !== String(folded.lastDomainEventId ?? '')) {
      mismatches.push(`${key.slice(-12)}: lastId 不同`)
    }
    if (Number(row.last_domain_event_sequence ?? -1) !== Number(folded.lastDomainEventSequence ?? -2)) {
      mismatches.push(`${key.slice(-12)}: 序号不同`)
    }
    if (short(row.state) !== short(folded.state)) {
      mismatches.push(`${key.slice(-12)}: state 摘要不同`)
    }
  }
  aEqualsB = {
    storedRows: stored.length,
    foldedRows: cache.size,
    relevantEvents: relevant.length,
    mismatches: mismatches.slice(0, 10),
    mismatchCount: mismatches.length,
  }

  ok =
    before.goalRows === after.goalRows &&
    before.domainEvents === after.domainEvents &&
    mismatches.length === 0 &&
    cache.size === stored.length
  reason = ok
    ? undefined
    : `读回核对未通过（goal 行 ${String(before.goalRows)}→${String(after.goalRows)}；` +
      `事件 ${String(before.domainEvents)}→${String(after.domainEvents)}；不符 ${mismatches.length} 处）`
} catch (error) {
  reason = error instanceof Error ? error.message : String(error)
} finally {
  const reading = {
    program: 'postgresql:goal-rebuild:apply',
    authorization: 'ⓓ 在真实库上受控重建 goal:% + 取新快照（2026-10-13 用户裁定）',
    atUtc: new Date().toISOString(),
    atUtc8: `${new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 19).replace('T', ' ')} (UTC+8)`,
    dataDir,
    operationKind: 'goal_projection_rebuild',
    ok,
    reason,
    before,
    after,
    rebuild,
    aEqualsB,
    states: handle?.reading.states,
    preOpenSnapshotId: handle?.reading.preOpenSnapshotId,
    postCloseSnapshotId: handle?.reading.postCloseSnapshotId,
    cleanClose: handle?.reading.cleanClose,
  }
  mkdirSync(OUT_DIR, { recursive: true })
  writeFileSync(resolve(OUT_DIR, 'goal-rebuild.json'), JSON.stringify(reading, null, 2), 'utf8')

  try {
    await createRuntimeShutdown(runtime, {
      afterRun: async (shutdownReading) => {
        if (handle !== undefined) {
          await handle.finish({
            closed: shutdownReading.closed,
            detail: `goal:% 受控重建（ok=${String(ok)}）`,
            afterClose: true,
          })
        }
      },
    }).shutdown()
  } catch (error) {
    console.error(`收尾失败：${error instanceof Error ? error.message : String(error)}`)
    ok = false
  }

  const final = {
    ...reading,
    states: handle?.reading.states,
    postCloseSnapshotId: handle?.reading.postCloseSnapshotId,
    cleanClose: handle?.reading.cleanClose,
  }
  writeFileSync(resolve(OUT_DIR, 'goal-rebuild.json'), JSON.stringify(final, null, 2), 'utf8')

  console.log('')
  console.log(`结果：${ok ? '✅ 重建并核对通过' : `❌ 未通过（${reason ?? '?'}）`}`)
  console.log(`  状态机        : ${(final.states ?? []).join(' → ')}`)
  console.log(`  pre-open 快照 : ${final.preOpenSnapshotId ?? '(none)'}`)
  console.log(`  post-close 快照: ${final.postCloseSnapshotId ?? '(none)'}`)
  console.log(`  cleanClose    : ${String(final.cleanClose)}`)
  console.log(`  A==B 核对     : ${JSON.stringify(aEqualsB)}`)
  console.log(`  读数          : ${OUT_DIR}/goal-rebuild.json`)
}

process.exit(ok ? 0 : 4)
