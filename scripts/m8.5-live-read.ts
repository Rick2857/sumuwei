/**
 * M8.5 WP11 —— **Live Smoke 读数器**（只读；被 `m8.5-live-level1.ts` spawn，也可独立执行）。
 *
 * 在 m8-live-read 的读数面上追加 M8.5 的语义面（零模型调用）：
 * ```text
 *  · 语义三水位：scanner / worker / impact（processedThroughSequence）
 *  · 切换边界水位：affect-semantic-cutover@1（semanticCutoverSequence）
 *  · 语义终结闸：processed_operations 里 affect-semantic-finalized:* 的
 *    operation（终态回执：NO_IMPACT / EXPIRED / CANCELLED_BY_MODE_CHANGE / …）
 *  · 语义任务行：character_jobs 里 affect-semantic-worker 的状态分布
 *  · AFFECT IMPACT 逐条带 ruleVersion（affect-rules@1 词形 vs
 *    affect-semantic-policy@1 语义——单写入者与让位的直接证据）
 *  · trace 末尾 N 条的 affect 步 + affect_semantic_* 步
 * ```
 *
 * 纪律（m8-live-read 同款）：
 *  · 只开**隔离/副本库**（PGLITE_DATA_DIR + PROJECT_LG_SANDBOX 双闸；生产路径拒绝）；
 *  · 作为子进程执行（进程退出即释放持有）；
 *  · 读不到 = 如实报 null/原因，绝不填 0 冒充"量到了"（AGENTS §6.8）。
 *
 * 用法：tsx scripts/m8.5-live-read.ts --db-dir <副本> --out <json> [--tail 24] [--traces 10]
 */
import { existsSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { isProductionDir, PRODUCTION_DB_DIR } from '../src/dev/sandbox.ts'

export interface M85LiveReading {
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
  readonly keywordWatermark: number | null
  readonly semanticWatermarks: {
    readonly scanner: number | null
    readonly worker: number | null
    readonly impact: number | null
    readonly cutover: number | null
  } | null
  readonly semanticJobs: { readonly total: number; readonly byStatus: Record<string, number> } | null
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
      readonly ruleVersion: string | null
    }[]
  } | null
  readonly semanticGates: readonly {
    readonly idempotencyKey: string
    readonly operation: string | null
  }[]
  readonly traces: {
    readonly total: number
    readonly withAffectSection: number
    readonly withSemanticSteps: number
    readonly tail: readonly {
      readonly traceId: string
      readonly sections: readonly string[]
      readonly affectStepKinds: readonly string[]
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
    return Array.isArray(parsed)
      ? (parsed.filter((s) => s !== null && typeof s === 'object') as Record<string, unknown>[])
      : []
  } catch {
    return []
  }
}

export async function readAll(dbDir: string, tail: number, traceTail: number): Promise<M85LiveReading> {
  /* 两个变量必须在碰数据库之前设好（initDatabase 的真实库闸看它们） */
  process.env.PGLITE_DATA_DIR = dbDir
  process.env.PROJECT_LG_SANDBOX = dbDir

  const { createThinHostRuntime } = await import('../src/infrastructure/runtime/thin-host-factory.ts')
  
  const { character } = await import('../src/character/index.ts')
  const { initDatabase } = await import('../src/db/index.ts')
  const { getRawDb, exec } = await import('../src/infrastructure/persistence/db.ts')
  const { asCharacterId } = await import('../src/kernel/contracts/ids.ts')
  const { getAffectProjection } = await import('../src/infrastructure/persistence/affect-store.ts')
  const { getWatermark } = await import('../src/infrastructure/persistence/job-store.ts')
  const { AFFECT_EVALUATOR_NAME, AFFECT_EVALUATOR_VERSION } = await import(
    '../src/kernel/app/affect/evaluator.ts'
  )
  const {
    AFFECT_SEMANTIC_SCANNER_PROCESSOR,
    AFFECT_SEMANTIC_WORKER_PROCESSOR,
    AFFECT_SEMANTIC_IMPACT_PROCESSOR,
    AFFECT_SEMANTIC_CUTOVER_NAME,
    AFFECT_SEMANTIC_CUTOVER_PROCESSOR,
  } = await import('../src/kernel/contracts/affect-semantic.ts')
  const {
    AFFECT_SEMANTIC_SCANNER_NAME,
    AFFECT_SEMANTIC_WORKER_NAME,
    AFFECT_SEMANTIC_IMPACT_NAME,
  } = await import('../src/kernel/app/affect/semantic-worker.ts')
  const { sql } = await import('drizzle-orm')

  const characterId = asCharacterId(character.id ?? character.name)

  const runtime = createThinHostRuntime({
      character: character,
      settings: {
      OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? 'placeholder',
      OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? '',
    },
      conversationLength: 16,
    })
  await initDatabase(runtime)
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

  /* ---- 水位：词形 + 语义三水位 + 切换边界 ---- */
  const keywordWatermarkRow = await getWatermark(db, characterId, AFFECT_EVALUATOR_NAME, AFFECT_EVALUATOR_VERSION)
  const keywordWatermark = keywordWatermarkRow?.processedThroughSequence ?? null
  const scannerRow = await getWatermark(db, characterId, AFFECT_SEMANTIC_SCANNER_NAME, AFFECT_SEMANTIC_SCANNER_PROCESSOR)
  const workerRow = await getWatermark(db, characterId, AFFECT_SEMANTIC_WORKER_NAME, AFFECT_SEMANTIC_WORKER_PROCESSOR)
  const impactRow = await getWatermark(db, characterId, AFFECT_SEMANTIC_IMPACT_NAME, AFFECT_SEMANTIC_IMPACT_PROCESSOR)
  const cutoverRow = await getWatermark(db, characterId, AFFECT_SEMANTIC_CUTOVER_NAME, AFFECT_SEMANTIC_CUTOVER_PROCESSOR)
  const semanticWatermarks = {
    scanner: scannerRow?.processedThroughSequence ?? null,
    worker: workerRow?.processedThroughSequence ?? null,
    impact: impactRow?.processedThroughSequence ?? null,
    cutover: cutoverRow?.processedThroughSequence ?? null,
  }

  /* ---- 语义任务行分布 ---- */
  const semanticJobRows = await exec(
    db,
    sql`select status, count(*)::int as n from character_jobs where processor = ${AFFECT_SEMANTIC_WORKER_NAME} group by status`,
    'M8.5 live 读数：语义任务分布'
  )
  const semanticByStatus: Record<string, number> = {}
  let semanticJobTotal = 0
  for (const row of semanticJobRows) {
    const n = Number(row.n)
    semanticByStatus[String(row.status)] = n
    semanticJobTotal += n
  }
  const semanticJobs = { total: semanticJobTotal, byStatus: semanticByStatus }

  /* ---- 账本：总数 + 最大序号 + 末尾 N 条 ---- */
  const ledgerRows = await exec(
    db,
    sql`select count(*)::int as total, coalesce(max(sequence), 0)::int as latest from conversation_events where character_id = ${String(characterId)}`,
    'M8.5 live 读数：账本计数'
  )
  const ledgerRow = ledgerRows[0]
  const tailRows = await exec(
    db,
    sql`select id, sequence, type, actor_type, content from conversation_events
        where character_id = ${String(characterId)}
        order by sequence desc limit ${sql.raw(String(Math.max(1, tail)))}`,
    'M8.5 live 读数：账本末尾'
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

  /* ---- AFFECT 域事件（IMPACT 逐条带 ruleVersion） ---- */
  const affectRows = await exec(
    db,
    sql`select id, sequence, type, payload from character_domain_events
        where character_id = ${String(characterId)} and type like 'AFFECT_%'
        order by sequence asc`,
    'M8.5 live 读数：AFFECT 域事件'
  )
  const byType: Record<string, number> = {}
  const impacts: {
    id: string
    sequence: number
    sourceEventId: string | null
    ruleId: string | null
    ruleVersion: string | null
  }[] = []
  for (const row of affectRows) {
    const type = String(row.type)
    byType[type] = (byType[type] ?? 0) + 1
    if (type !== 'AFFECT_IMPACT') continue
    let payload: unknown = null
    try {
      payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload
    } catch {
      payload = null
    }
    const payloadRecord = payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
    impacts.push({
      id: String(row.id),
      sequence: Number(row.sequence),
      sourceEventId:
        payloadRecord.sourceEventId === undefined || payloadRecord.sourceEventId === null
          ? null
          : String(payloadRecord.sourceEventId),
      ruleId:
        payloadRecord.ruleId === undefined || payloadRecord.ruleId === null
          ? null
          : String(payloadRecord.ruleId),
      ruleVersion:
        payloadRecord.ruleVersion === undefined || payloadRecord.ruleVersion === null
          ? null
          : String(payloadRecord.ruleVersion),
    })
  }
  const affectEvents = { total: affectRows.length, byType, impacts }

  /* ---- 语义终结闸（processed_operations；operation = 终态回执） ---- */
  const gateRows = await exec(
    db,
    sql`select idempotency_key, operation from processed_operations
        where character_id = ${String(characterId)}
          and processor = ${AFFECT_SEMANTIC_WORKER_NAME}
          and idempotency_key like 'affect-semantic-finalized:%'
        order by processed_at asc`,
    'M8.5 live 读数：语义终结闸'
  )
  const semanticGates = gateRows.map((row) => ({
    idempotencyKey: String(row.idempotency_key),
    operation: row.operation === undefined || row.operation === null ? null : String(row.operation),
  }))

  /* ---- trace：总数 · affect section · 语义四步 · 末尾 N 条 ---- */
  const traceRows = await exec(
    db,
    sql`select trace_id, context_section_ids, steps, started_at from character_traces
        where character_id = ${String(characterId)} order by started_at asc`,
    'M8.5 live 读数：trace 清单'
  )
  let withAffect = 0
  let withSemanticSteps = 0
  for (const row of traceRows) {
    if (sectionsOf(row.context_section_ids).includes('affect')) withAffect += 1
    if (stepsOf(row.steps).some((s) => String(s.kind ?? '').startsWith('affect_semantic'))) {
      withSemanticSteps += 1
    }
  }
  const tailTraces = traceRows.slice(-Math.max(1, traceTail))
  const traceTailReadings = tailTraces.map((row) => {
    const steps = stepsOf(row.steps)
    const affectSteps = steps.filter((s) => String(s.kind ?? '').startsWith('affect_'))
    const affectContext = affectSteps.find((s) => String(s.kind ?? '') === 'affect_context')
    const attributes =
      affectContext !== undefined &&
      affectContext.attributes !== undefined &&
      typeof affectContext.attributes === 'object'
        ? (affectContext.attributes as Record<string, string | number | boolean>)
        : null
    return {
      traceId: String(row.trace_id ?? ''),
      sections: sectionsOf(row.context_section_ids),
      affectStepKinds: affectSteps.map((s) => String(s.kind ?? '')),
      affectContextAttributes: attributes,
    }
  })
  const traces = {
    total: traceRows.length,
    withAffectSection: withAffect,
    withSemanticSteps,
    tail: traceTailReadings,
  }

  const reading: M85LiveReading = {
    ok: true,
    projection,
    keywordWatermark,
    semanticWatermarks,
    semanticJobs,
    ledger: {
      conversationEvents: ledgerRow === undefined ? null : Number(ledgerRow.total),
      latestSequence: ledgerRow === undefined ? null : Number(ledgerRow.latest),
      tail: ledgerTail,
    },
    affectEvents,
    semanticGates,
    traces,
    readAt: new Date().toISOString(),
  }
  return reading
}

const isMain = process.argv[1] !== undefined && /m8\.5-live-read\.ts$/.test(process.argv[1])
if (isMain) {
  const dbDir = argValue('--db-dir')
  const out = argValue('--out')
  const tail = Number(argValue('--tail') ?? '24')
  const traceTail = Number(argValue('--traces') ?? '10')
  if (dbDir === undefined || out === undefined) {
    console.error('用法：tsx scripts/m8.5-live-read.ts --db-dir <副本> --out <json> [--tail 24] [--traces 10]')
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
      `  affect 投影 ${reading.projection === null ? '（未建档）' : `v=${String(reading.projection.valence)} a=${String(reading.projection.arousal)} r${String(reading.projection.revision)} @${reading.projection.reducerVersion}`} · 词形水位 ${String(reading.keywordWatermark)} · 语义水位 s${String(reading.semanticWatermarks?.scanner)}/w${String(reading.semanticWatermarks?.worker)}/i${String(reading.semanticWatermarks?.impact)} · 边界 ${String(reading.semanticWatermarks?.cutover)} · 闸 ${String(reading.semanticGates.length)} · IMPACT ${String(reading.affectEvents?.impacts.length)}（语义 ${String(reading.affectEvents?.impacts.filter((i) => i.ruleVersion === 'affect-semantic-policy@1').length)}）`
    )
  } catch (error) {
    fail(`读取失败：${error instanceof Error ? error.message : String(error)}`)
    process.exit(3)
  }
}
