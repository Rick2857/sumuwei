/**
 * M7 WP6-B —— **轨迹状态读数器**（只读；可被运行器 spawn，也可独立执行）。
 *
 * 读什么（freeze sheet §3 ① 的全部程序读数，零模型调用）：
 * ```text
 *  · 关系投影本体：trust/closeness（全精度）/ originated / lastInteractionAt /
 *    在案指控 / revision / reducerVersion
 *  · 调度水位：processor_watermarks 里 relationship-evaluator 的 processedThroughSequence
 *  · job 记录：character_jobs 里 relationship-evaluator 的条数与状态分布
 *  · 账本：conversation_events 总数 + 最大序号（该 character）
 *  · trace：总数 · 含 relationship section 的条数 · 指定轮（从末条回数）的 section 名单
 * ```
 *
 * 纪律：
 *  · 只开**隔离库**（PGLITE_DATA_DIR + PROJECT_LG_SANDBOX 双闸；生产路径拒绝）；
 *  · 作为子进程执行（进程退出即释放持有——不与下一轮 spawn 抢锁）；
 *  · 读不到 = 如实报 null/原因，绝不填 0 冒充"量到了"（AGENTS §6.8）。
 *
 * 用法（独立）：tsx scripts/m7-trajectory-read.ts --db-dir <沙箱> --out <json>
 *               [--from-end 0] [--user-name Alex]
 */
import { existsSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { isProductionDir, PRODUCTION_DB_DIR } from '../src/dev/sandbox.ts'

interface PickedTraceReading {
  readonly fromEnd: number
  readonly sections: readonly string[]
  readonly traceId: string | null
}

export interface M7TrajectoryReading {
  readonly ok: boolean
  readonly reason?: string
  readonly projection: {
    readonly originated: boolean
    readonly trust: number | null
    readonly closeness: number | null
    readonly revision: number | null
    readonly accusationsInCase: number
    readonly lastInteractionAt: number | null
    readonly reducerVersion: string | null
  } | null
  readonly watermark: number | null
  readonly jobs: { readonly total: number; readonly byStatus: Record<string, number> } | null
  readonly ledger: { readonly conversationEvents: number | null; readonly latestSequence: number | null }
  readonly domainEvents: { readonly total: number | null; readonly latestSequence: number | null } | null
  readonly traces: {
    readonly total: number
    readonly withRelationshipSection: number
    readonly picked: PickedTraceReading | null
  } | null
  readonly readAt: string
}

const argValue = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

function sectionsOf(raw: unknown): string[] {
  try {
    const parsed = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

export async function readAll(dbDir: string, fromEnd: number, userName: string): Promise<M7TrajectoryReading> {
  /* 两个变量必须在碰数据库之前设好（initDatabase 的真实库闸看它们） */
  process.env.PGLITE_DATA_DIR = dbDir
  process.env.PROJECT_LG_SANDBOX = dbDir

  const { AgentRuntime, stringToUuid } = await import('@elizaos/core')
  const sqlPlugin = (await import('@elizaos/plugin-sql')).default
  const { character } = await import('../src/character/index.ts')
  const { initDatabase } = await import('../src/db/index.ts')
  const { getRawDb, exec } = await import('../src/infrastructure/persistence/db.ts')
  const { asCharacterId } = await import('../src/kernel/contracts/ids.ts')
  const { entityRef } = await import('../src/kernel/contracts/entity.ts')
  const { getRelationshipProjection } = await import('../src/infrastructure/persistence/relationship-store.ts')
  const { getWatermark } = await import('../src/infrastructure/persistence/job-store.ts')
  const { RELATIONSHIP_EVALUATOR_NAME, RELATIONSHIP_EVALUATOR_VERSION } = await import(
    '../src/kernel/app/relationship/evaluator.ts'
  )
  const { sql } = await import('drizzle-orm')

  const characterId = asCharacterId(character.id ?? character.name)
  const userId = stringToUuid(`user-${userName}`)

  const runtime = new AgentRuntime({
    character: character as never,
    plugins: [sqlPlugin],
    conversationLength: 16,
    settings: {
      OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? 'placeholder',
      OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? '',
    },
  } as never)
  await initDatabase(runtime, sqlPlugin)
  const db = getRawDb(runtime)

  /* ---- 投影（全精度） ---- */
  const projectionRow = await getRelationshipProjection(db, characterId, entityRef('user', userId))
  const projection =
    projectionRow === undefined
      ? null
      : {
          originated: projectionRow.state.originated,
          trust: projectionRow.state.trust,
          closeness: projectionRow.state.closeness,
          revision: projectionRow.revision,
          accusationsInCase: projectionRow.state.accusationsInCase.length,
          lastInteractionAt: projectionRow.state.lastInteractionAt,
          reducerVersion: projectionRow.reducerVersion,
        }

  /* ---- 水位 ---- */
  const watermarkRow = await getWatermark(db, characterId, RELATIONSHIP_EVALUATOR_NAME, RELATIONSHIP_EVALUATOR_VERSION)
  const watermark = watermarkRow?.processedThroughSequence ?? 0

  /* ---- job 记录 ---- */
  const jobRows = await exec(
    db,
    sql`select status, count(*)::int as n from character_jobs where processor = ${RELATIONSHIP_EVALUATOR_NAME} group by status`,
    'M7 读数：job 分布'
  )
  const byStatus: Record<string, number> = {}
  let jobTotal = 0
  for (const row of jobRows) {
    const n = Number(row.n)
    byStatus[String(row.status)] = n
    jobTotal += n
  }
  const jobs = { total: jobTotal, byStatus }

  /* ---- 账本 ---- */
  const ledgerRows = await exec(
    db,
    sql`select count(*)::int as total, coalesce(max(sequence), 0)::int as latest from conversation_events where character_id = ${String(characterId)}`,
    'M7 读数：账本计数'
  )
  const ledgerRow = ledgerRows[0]
  /* ---- 域事件（§8.5：TEST_CHARACTER_SIGNAL 每轮一条 ⇒ 域事件数是
   * "无意外域事件"的机器面；只数总数与最大序号，不读内容） ---- */
  const domainRows = await exec(
    db,
    sql`select count(*)::int as total, coalesce(max(sequence), 0)::int as latest from character_domain_events where character_id = ${String(characterId)}`,
    'M7 读数：域事件计数'
  )
  const domainRow = domainRows[0]

  /* ---- trace：总数 · relationship section 计数 · 指定轮 section 名单 ---- */
  const traceRows = await exec(
    db,
    sql`select trace_id, context_section_ids, started_at from character_traces where character_id = ${String(characterId)} order by started_at asc`,
    'M7 读数：trace 清单'
  )
  let withRelationship = 0
  for (const row of traceRows) {
    if (sectionsOf(row.context_section_ids).includes('relationship')) withRelationship += 1
  }
  const pickedRow = traceRows[traceRows.length - 1 - Math.max(0, fromEnd)]
  const picked: PickedTraceReading | null =
    pickedRow === undefined
      ? null
      : {
          fromEnd: Math.max(0, fromEnd),
          sections: sectionsOf(pickedRow.context_section_ids),
          traceId: String(pickedRow.trace_id ?? '') || null,
        }

  return {
    ok: true,
    projection,
    watermark,
    jobs,
    ledger: {
      conversationEvents: ledgerRow === undefined ? null : Number(ledgerRow.total),
      latestSequence: ledgerRow === undefined ? null : Number(ledgerRow.latest),
    },
    domainEvents: {
      total: domainRow === undefined ? null : Number(domainRow.total),
      latestSequence: domainRow === undefined ? null : Number(domainRow.latest),
    },
    traces: { total: traceRows.length, withRelationshipSection: withRelationship, picked },
    readAt: new Date().toISOString(),
  }
}

const isMain = process.argv[1] !== undefined && /m7-trajectory-read\.ts$/.test(process.argv[1])
if (isMain) {
  const dbDir = argValue('--db-dir')
  const out = argValue('--out')
  const fromEnd = Number(argValue('--from-end') ?? '0')
  const userName = argValue('--user-name') ?? 'Alex'
  if (dbDir === undefined || out === undefined) {
    console.error('用法：tsx scripts/m7-trajectory-read.ts --db-dir <沙箱> --out <json> [--from-end 0] [--user-name Alex]')
    process.exit(2)
  }
  const resolved = resolve(dbDir)
  const fail = (reason: string): void => {
    writeFileSync(out ?? '-', `${JSON.stringify({ ok: false, reason, readAt: new Date().toISOString() }, null, 2)}\n`, 'utf8')
  }
  if (!existsSync(resolved)) {
    fail(`沙箱目录不存在：${resolved}`)
    process.exit(3)
  }
  if (isProductionDir(resolved) || resolved === resolve(PRODUCTION_DB_DIR)) {
    fail('拒绝：该路径被判成生产库')
    process.exit(3)
  }
  try {
    const reading = await readAll(resolved, fromEnd, userName)
    writeFileSync(out, `${JSON.stringify(reading, null, 2)}\n`, 'utf8')
    console.log(
      `  投影 ${reading.projection === null ? '（未建档）' : `t=${String(reading.projection.trust)} c=${String(reading.projection.closeness)} r${String(reading.projection.revision)} 在案${String(reading.projection.accusationsInCase)}`} · 水位 ${String(reading.watermark)} · 账本 ${String(reading.ledger.conversationEvents)}/${String(reading.ledger.latestSequence)} · 域事件 ${String(reading.domainEvents?.total)}/${String(reading.domainEvents?.latestSequence)} · trace ${String(reading.traces?.total)}（rel ${String(reading.traces?.withRelationshipSection)}）`
    )
  } catch (error) {
    fail(`读取失败：${error instanceof Error ? error.message : String(error)}`)
    process.exit(3)
  }
}
