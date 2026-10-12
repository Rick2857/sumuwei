/**
 * M8 WP7 —— **Live Smoke 读数器**（只读；被 `m8-live-level1.ts` spawn，也可独立执行）。
 *
 * 读什么（Level 2 开发者面在**生产副本**上的全部程序读数，零模型调用）：
 * ```text
 *  · affect 投影本体：valence/arousal（全精度）/ originated / cutoverSequence /
 *    lastInteractionAt / lastAffectEventAt / revision / reducerVersion
 *  · 调度水位：processor_watermarks 里 affect-evaluator 的 processedThroughSequence
 *  · job 记录：character_jobs 里 affect-evaluator 的状态分布
 *  · 账本：conversation_events 总数 + 最大序号 + 末尾 N 条（id/序号/类型/actor/正文）
 *  · AFFECT 域事件：全部（类型分布 + 每条的 sourceEventId/ruleId/cutover）
 *  · trace：总数 · 含 affect section 的条数 · 末尾 N 条的 affect 步与
 *    affect_context 步的 payload（appliedThisTurn 在里面）
 * ```
 *
 * 纪律（m7-trajectory-read 同款）：
 *  · 只开**隔离/副本库**（PGLITE_DATA_DIR + PROJECT_LG_SANDBOX 双闸；生产路径拒绝）；
 *  · 作为子进程执行（进程退出即释放持有）；
 *  · 读不到 = 如实报 null/原因，绝不填 0 冒充"量到了"（AGENTS §6.8）。
 *
 * 用法：tsx scripts/m8-live-read.ts --db-dir <副本> --out <json> [--tail 24] [--traces 8]
 */
import { existsSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { isProductionDir, PRODUCTION_DB_DIR } from '../src/dev/sandbox.ts'

export interface M8LiveReading {
  readonly ok: boolean
  readonly reason?: string
  readonly projection: {
    readonly originated: boolean
    readonly valence: number | null
    readonly arousal: number | null
    readonly cutoverSequence: number | null
    readonly lastInteractionAt: number | null
    readonly lastAffectEventAt: number | null
    readonly revision: number | null
    readonly reducerVersion: string | null
  } | null
  readonly watermark: number | null
  readonly jobs: { readonly total: number; readonly byStatus: Record<string, number> } | null
  readonly ledger: {
    readonly conversationEvents: number | null
    readonly latestSequence: number | null
    readonly tail: readonly {
      readonly id: string
      readonly sequence: number
      readonly type: string
      readonly actorType: string
      readonly content: string
    }[]
  }
  readonly affectEvents: {
    readonly total: number
    readonly byType: Record<string, number>
    readonly impacts: readonly {
      readonly id: string
      readonly sequence: number
      readonly sourceEventId: string | null
      readonly ruleId: string | null
    }[]
    readonly originCutoverSequence: number | null
  } | null
  readonly traces: {
    readonly total: number
    readonly withAffectSection: number
    readonly tail: readonly {
      readonly traceId: string
      readonly sections: readonly string[]
      readonly affectStepKinds: readonly string[]
      /** affect_context 步的 attributes（TraceStep 的结构化元数据是 `attributes`，不是 payload） */
      readonly affectContextAttributes: Record<string, string | number | boolean> | null
    }[]
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

function stepsOf(raw: unknown): Record<string, unknown>[] {
  try {
    const parsed = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw
    return Array.isArray(parsed) ? (parsed.filter((s) => s !== null && typeof s === 'object') as Record<string, unknown>[]) : []
  } catch {
    return []
  }
}

export async function readAll(dbDir: string, tail: number, traceTail: number): Promise<M8LiveReading> {
  /* 两个变量必须在碰数据库之前设好（initDatabase 的真实库闸看它们） */
  process.env.PGLITE_DATA_DIR = dbDir
  process.env.PROJECT_LG_SANDBOX = dbDir

  const { AgentRuntime } = await import('@elizaos/core')
  const sqlPlugin = (await import('@elizaos/plugin-sql')).default
  const { character } = await import('../src/character/index.ts')
  const { initDatabase } = await import('../src/db/index.ts')
  const { getRawDb, exec } = await import('../src/infrastructure/persistence/db.ts')
  const { asCharacterId } = await import('../src/kernel/contracts/ids.ts')
  const { getAffectProjection } = await import('../src/infrastructure/persistence/affect-store.ts')
  const { getWatermark } = await import('../src/infrastructure/persistence/job-store.ts')
  const { AFFECT_EVALUATOR_NAME, AFFECT_EVALUATOR_VERSION } = await import(
    '../src/kernel/app/affect/evaluator.ts'
  )
  const { sql } = await import('drizzle-orm')

  const characterId = asCharacterId(character.id ?? character.name)

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

  /* ---- affect 投影（全精度） ---- */
  const projectionRow = await getAffectProjection(db, characterId)
  const projection =
    projectionRow === undefined
      ? null
      : {
          originated: projectionRow.state.originated,
          valence: projectionRow.state.valence,
          arousal: projectionRow.state.arousal,
          cutoverSequence: projectionRow.state.cutoverSequence,
          lastInteractionAt: projectionRow.state.lastInteractionAt,
          lastAffectEventAt: projectionRow.state.lastAffectEventAt,
          revision: projectionRow.revision,
          reducerVersion: projectionRow.reducerVersion,
        }

  /* ---- 水位 ---- */
  const watermarkRow = await getWatermark(db, characterId, AFFECT_EVALUATOR_NAME, AFFECT_EVALUATOR_VERSION)
  const watermark = watermarkRow?.processedThroughSequence ?? null

  /* ---- job 分布 ---- */
  const jobRows = await exec(
    db,
    sql`select status, count(*)::int as n from character_jobs where processor = ${AFFECT_EVALUATOR_NAME} group by status`,
    'M8 live 读数：job 分布'
  )
  const byStatus: Record<string, number> = {}
  let jobTotal = 0
  for (const row of jobRows) {
    const n = Number(row.n)
    byStatus[String(row.status)] = n
    jobTotal += n
  }
  const jobs = { total: jobTotal, byStatus }

  /* ---- 账本：总数 + 最大序号 + 末尾 N 条 ---- */
  const ledgerRows = await exec(
    db,
    sql`select count(*)::int as total, coalesce(max(sequence), 0)::int as latest from conversation_events where character_id = ${String(characterId)}`,
    'M8 live 读数：账本计数'
  )
  const ledgerRow = ledgerRows[0]
  const tailRows = await exec(
    db,
    sql`select id, sequence, type, actor_type, content from conversation_events
        where character_id = ${String(characterId)}
        order by sequence desc limit ${sql.raw(String(Math.max(1, tail)))}`,
    'M8 live 读数：账本末尾'
  )
  const ledgerTail = tailRows
    .map((row) => ({
      id: String(row.id),
      sequence: Number(row.sequence),
      type: String(row.type),
      actorType: String(row.actor_type),
      content: String(row.content ?? ''),
    }))
    .sort((a, b) => a.sequence - b.sequence)

  /* ---- AFFECT 域事件（全部；IMPACT 逐条 + ORIGIN 的 cutover） ---- */
  const affectRows = await exec(
    db,
    sql`select id, sequence, type, payload from character_domain_events
        where character_id = ${String(characterId)} and type like 'AFFECT_%'
        order by sequence asc`,
    'M8 live 读数：AFFECT 域事件'
  )
  const byType: Record<string, number> = {}
  const impacts: {
    id: string
    sequence: number
    sourceEventId: string | null
    ruleId: string | null
  }[] = []
  let originCutoverSequence: number | null = null
  for (const row of affectRows) {
    const type = String(row.type)
    byType[type] = (byType[type] ?? 0) + 1
    let payload: unknown = null
    try {
      payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload
    } catch {
      payload = null
    }
    const payloadRecord = payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
    if (type === 'AFFECT_IMPACT') {
      impacts.push({
        id: String(row.id),
        sequence: Number(row.sequence),
        sourceEventId:
          typeof payloadRecord.sourceEventId === 'string' ? payloadRecord.sourceEventId : null,
        ruleId: typeof payloadRecord.ruleId === 'string' ? payloadRecord.ruleId : null,
      })
    }
    if (type === 'AFFECT_ORIGIN' && typeof payloadRecord.cutoverSequence === 'number') {
      originCutoverSequence = payloadRecord.cutoverSequence
    }
  }
  const affectEvents = {
    total: affectRows.length,
    byType,
    impacts,
    originCutoverSequence,
  }

  /* ---- trace：总数 · affect section 计数 · 末尾 N 条的 affect 步 ---- */
  const traceRows = await exec(
    db,
    sql`select trace_id, context_section_ids, steps, started_at from character_traces
        where character_id = ${String(characterId)} order by started_at asc`,
    'M8 live 读数：trace 清单'
  )
  let withAffect = 0
  for (const row of traceRows) {
    if (sectionsOf(row.context_section_ids).includes('affect')) withAffect += 1
  }
  const tailTraces = traceRows.slice(-Math.max(1, traceTail))
  const traceTailReadings = tailTraces.map((row) => {
    const steps = stepsOf(row.steps)
    const affectSteps = steps.filter((s) => typeof s.kind === 'string' && String(s.kind).startsWith('affect_'))
    const affectContext = affectSteps.find((s) => String(s.kind) === 'affect_context')
    const attributes = affectContext?.attributes
    return {
      traceId: String(row.trace_id ?? ''),
      sections: sectionsOf(row.context_section_ids),
      affectStepKinds: affectSteps.map((s) => String(s.kind)),
      affectContextAttributes:
        attributes !== null && attributes !== undefined && typeof attributes === 'object'
          ? (attributes as Record<string, string | number | boolean>)
          : null,
    }
  })

  return {
    ok: true,
    projection,
    watermark,
    jobs,
    ledger: {
      conversationEvents: ledgerRow === undefined ? null : Number(ledgerRow.total),
      latestSequence: ledgerRow === undefined ? null : Number(ledgerRow.latest),
      tail: ledgerTail,
    },
    affectEvents,
    traces: { total: traceRows.length, withAffectSection: withAffect, tail: traceTailReadings },
    readAt: new Date().toISOString(),
  }
}

const isMain = process.argv[1] !== undefined && /m8-live-read\.ts$/.test(process.argv[1])
if (isMain) {
  const dbDir = argValue('--db-dir')
  const out = argValue('--out')
  const tail = Number(argValue('--tail') ?? '24')
  const traceTail = Number(argValue('--traces') ?? '8')
  if (dbDir === undefined || out === undefined) {
    console.error('用法：tsx scripts/m8-live-read.ts --db-dir <副本> --out <json> [--tail 24] [--traces 8]')
    process.exit(2)
  }
  const resolved = resolve(dbDir)
  const fail = (reason: string): void => {
    writeFileSync(out ?? '-', `${JSON.stringify({ ok: false, reason, readAt: new Date().toISOString() }, null, 2)}\n`, 'utf8')
  }
  if (!existsSync(resolved)) {
    fail(`副本目录不存在：${resolved}`)
    process.exit(3)
  }
  if (isProductionDir(resolved) || resolved === resolve(PRODUCTION_DB_DIR)) {
    fail('拒绝：该路径被判成生产库')
    process.exit(3)
  }
  try {
    const reading = await readAll(resolved, tail, traceTail)
    writeFileSync(out, `${JSON.stringify(reading, null, 2)}\n`, 'utf8')
    console.log(
      `  affect 投影 ${reading.projection === null ? '（未建档）' : `v=${String(reading.projection.valence)} a=${String(reading.projection.arousal)} r${String(reading.projection.revision)} cutover=${String(reading.projection.cutoverSequence)}`} · 水位 ${String(reading.watermark)} · AFFECT 事件 ${String(reading.affectEvents?.total)}（IMPACT ${String(reading.affectEvents?.impacts.length)}）· trace ${String(reading.traces?.total)}（affect ${String(reading.traces?.withAffectSection)}）`
    )
  } catch (error) {
    fail(`读取失败：${error instanceof Error ? error.message : String(error)}`)
    process.exit(3)
  }
}
