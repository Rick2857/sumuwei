/**
 * M9 WP9 —— **Live 读回子**（只读；被 m9-live-level1.ts spawn，也可独立执行）。
 *
 * 读什么（信念域在**生产副本**上的全部程序读数，零模型调用）：
 * ```text
 *  · Memory 全量（predicate/qualifier/value/status/authority/type——槽位占用真相）
 *  · Belief 全量（proposition.predicate/scopeKey/value · status · epistemicKind ·
 *    supportLevel · evidenceRootIds · dependsOnMemoryIds · ruleId）
 *  · BELIEF_ORIGIN（originated/cutoverSequence）
 *  · 两条处理线的水位（belief-interaction-evaluator / belief-memory-reconciler）
 *    与 job 状态分布
 *  · 账本：总数 + 最大序号 + 末尾 N 条
 *  · BELIEF_* 域事件：类型分布 + ORIGIN 的 cutover
 *  · trace：总数 · 含 belief section 的条数 · 末尾 N 条的 belief_context 步
 *    属性（outcome/candidate_count/used_count/used_belief_ids）
 * ```
 *
 * 纪律（m8-live-read 同款）：只开隔离/副本库（双闸；生产路径拒绝）；
 * 作为子进程执行；读不到 = 如实报 null，绝不填 0 冒充量到。
 *
 * 用法：tsx scripts/m9-live-read.ts --db-dir <副本> --out <json> [--tail 30] [--traces 24]
 */
import { existsSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { isProductionDir, PRODUCTION_DB_DIR } from '../src/dev/sandbox.ts'

export interface M9LiveReading {
  readonly ok: boolean
  readonly reason?: string
  readonly memories: readonly {
    readonly id: string
    readonly status: string
    readonly type: string
    readonly authority: string
    readonly predicate: string | null
    readonly value: string | null
    readonly qualifiers: string | null
  }[]
  readonly beliefs: readonly {
    readonly beliefId: string
    readonly predicate: string
    readonly scopeKey: string
    readonly value: string
    readonly status: string
    readonly epistemicKind: string
    readonly supportLevel: string
    readonly rootCount: number
    readonly memDepCount: number
    readonly ruleId: string
    readonly supersedesBeliefId: string | null
  }[]
  readonly origin: { readonly originated: boolean; readonly cutoverSequence: number | null } | null
  readonly watermarks: {
    readonly interaction: number | null
    readonly memoryReconciler: number | null
  }
  readonly jobs: { readonly processor: string; readonly total: number; readonly byStatus: Record<string, number> }[]
  readonly ledger: {
    readonly conversationEvents: number | null
    readonly latestSequence: number | null
    readonly tail: readonly { readonly id: string; readonly sequence: number; readonly type: string; readonly actorType: string; readonly content: string }[]
  }
  readonly beliefEvents: {
    readonly total: number
    readonly byType: Record<string, number>
    readonly originCutoverSequence: number | null
  } | null
  readonly traces: {
    readonly total: number
    readonly withBeliefSection: number
    readonly tail: readonly {
      readonly traceId: string
      readonly sections: readonly string[]
      readonly beliefContextAttributes: Record<string, string | number | boolean> | null
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
    return Array.isArray(parsed) ? ((parsed.filter((s) => s !== null && typeof s === 'object') as Record<string, unknown>[])) : []
  } catch {
    return []
  }
}

export async function readAll(dbDir: string, tail: number, traceTail: number): Promise<M9LiveReading> {
  /* 两个变量必须在碰数据库之前设好（initDatabase 的真实库闸看它们） */
  process.env.PGLITE_DATA_DIR = dbDir
  process.env.PROJECT_LG_SANDBOX = dbDir

  const { createThinHostRuntime } = await import('../src/infrastructure/runtime/thin-host-factory.ts')
  
  const { character } = await import('../src/character/index.ts')
  const { initDatabase } = await import('../src/db/index.ts')
  const { getRawDb, exec } = await import('../src/infrastructure/persistence/db.ts')
  const { asCharacterId } = await import('../src/kernel/contracts/ids.ts')
  const { createNativeMemoryStore } = await import('../src/infrastructure/persistence/memory-store.ts')
  const { listBeliefsByStatus, getBeliefOrigin } = await import(
    '../src/infrastructure/persistence/belief-store.ts'
  )
  const { getWatermark } = await import('../src/infrastructure/persistence/job-store.ts')
  const { BELIEF_INTERACTION_EVALUATOR_NAME, BELIEF_INTERACTION_EVALUATOR_VERSION } = await import(
    '../src/kernel/app/belief/evaluator.ts'
  )
  const { BELIEF_MEMORY_RECONCILER_NAME, BELIEF_MEMORY_RECONCILER_VERSION } = await import(
    '../src/kernel/app/belief/job.ts'
  )
  const { entityRef } = await import('../src/kernel/contracts/index.ts')
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

  /* ---- Memory 全量（owner = character；含非 active——历史不丢失） ---- */
  const memoryStore = createNativeMemoryStore(db)
  const owner = entityRef('character', String(characterId))
  const memoryRecords = await memoryStore.list({ owner, limit: 2000 })
  const memories = memoryRecords.map((m) => {
    if (m.content.kind === 'claim') {
      return {
        id: String(m.id),
        status: String(m.status),
        type: String(m.type),
        authority: String(m.authority),
        predicate: m.content.predicate,
        value: String(m.content.value),
        qualifiers: m.content.qualifiers === undefined ? null : JSON.stringify(m.content.qualifiers),
      }
    }
    return {
      id: String(m.id),
      status: String(m.status),
      type: String(m.type),
      authority: String(m.authority),
      predicate: null,
      value: `(episode) ${m.content.summary.slice(0, 40)}`,
      qualifiers: null,
    }
  })

  /* ---- Belief 全量（四种状态都在——修订链可审计） ---- */
  const beliefStates = await listBeliefsByStatus(db, characterId, ['active', 'disputed', 'superseded', 'retracted'])
  const beliefs = beliefStates.map((b) => ({
    beliefId: String(b.beliefId),
    predicate: b.proposition.predicate,
    scopeKey: b.proposition.scopeKey,
    value: String(b.proposition.value),
    status: String(b.status),
    epistemicKind: String(b.epistemicKind),
    supportLevel: String(b.supportLevel),
    rootCount: b.evidenceRootIds.length,
    memDepCount: b.dependsOnMemoryIds.length,
    ruleId: b.ruleId,
    supersedesBeliefId: b.supersedesBeliefId === undefined ? null : String(b.supersedesBeliefId),
  }))

  /* ---- ORIGIN ---- */
  const originRow = await getBeliefOrigin(db, characterId)
  const origin =
    originRow === undefined
      ? null
      : { originated: originRow.state.originated, cutoverSequence: originRow.state.cutoverSequence }

  /* ---- 水位（两条处理线） ---- */
  const interactionWm = await getWatermark(db, characterId, BELIEF_INTERACTION_EVALUATOR_NAME, BELIEF_INTERACTION_EVALUATOR_VERSION)
  const memoryWm = await getWatermark(db, characterId, BELIEF_MEMORY_RECONCILER_NAME, BELIEF_MEMORY_RECONCILER_VERSION)
  const watermarks = {
    interaction: interactionWm?.processedThroughSequence ?? null,
    memoryReconciler: memoryWm?.processedThroughSequence ?? null,
  }

  /* ---- job 分布（两条处理线） ---- */
  const jobs: { processor: string; total: number; byStatus: Record<string, number> }[] = []
  for (const [name, version] of [
    [BELIEF_INTERACTION_EVALUATOR_NAME, BELIEF_INTERACTION_EVALUATOR_VERSION],
    [BELIEF_MEMORY_RECONCILER_NAME, BELIEF_MEMORY_RECONCILER_VERSION],
  ] as const) {
    const rows = await exec(
      db,
      sql`select status, count(*)::int as n from character_jobs where processor = ${name} and processor_version = ${String(version)} group by status`,
      'M9 live 读数：job 分布'
    )
    const byStatus: Record<string, number> = {}
    let total = 0
    for (const row of rows) {
      const n = Number(row.n)
      byStatus[String(row.status)] = n
      total += n
    }
    jobs.push({ processor: String(name), total, byStatus })
  }

  /* ---- 账本 ---- */
  const ledgerRows = await exec(
    db,
    sql`select count(*)::int as total, coalesce(max(sequence), 0)::int as latest from conversation_events where character_id = ${String(characterId)}`,
    'M9 live 读数：账本计数'
  )
  const ledgerRow = ledgerRows[0]
  const tailRows = await exec(
    db,
    sql`select id, sequence, type, actor_type, content from conversation_events
        where character_id = ${String(characterId)}
        order by sequence desc limit ${sql.raw(String(Math.max(1, tail)))}`,
    'M9 live 读数：账本末尾'
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

  /* ---- BELIEF_* 域事件 ---- */
  const beliefRows = await exec(
    db,
    sql`select id, sequence, type, payload from character_domain_events
        where character_id = ${String(characterId)} and type like 'BELIEF_%'
        order by sequence asc`,
    'M9 live 读数：BELIEF 域事件'
  )
  const byType: Record<string, number> = {}
  let originCutoverSequence: number | null = null
  for (const row of beliefRows) {
    const type = String(row.type)
    byType[type] = (byType[type] ?? 0) + 1
    if (type === 'BELIEF_ORIGIN') {
      try {
        const payload = typeof row.payload === 'string' ? (JSON.parse(row.payload) as Record<string, unknown>) : (row.payload as Record<string, unknown>)
        if (typeof payload.cutoverSequence === 'number') originCutoverSequence = payload.cutoverSequence
      } catch {
        /* 读不到就保持 null——如实 */
      }
    }
  }
  const beliefEvents = { total: beliefRows.length, byType, originCutoverSequence }

  /* ---- trace ---- */
  const traceRows = await exec(
    db,
    sql`select trace_id, context_section_ids, steps, started_at from character_traces
        where character_id = ${String(characterId)} order by started_at asc`,
    'M9 live 读数：trace 清单'
  )
  let withBelief = 0
  for (const row of traceRows) {
    if (sectionsOf(row.context_section_ids).includes('belief')) withBelief += 1
  }
  const tailTraces = traceRows.slice(-Math.max(1, traceTail))
  const traceTailReadings = tailTraces.map((row) => {
    const steps = stepsOf(row.steps)
    const beliefContext = steps.find((s) => String(s.kind) === 'belief_context')
    const attributes = beliefContext?.attributes
    return {
      traceId: String(row.trace_id ?? ''),
      sections: sectionsOf(row.context_section_ids),
      beliefContextAttributes:
        attributes !== null && attributes !== undefined && typeof attributes === 'object'
          ? (attributes as Record<string, string | number | boolean>)
          : null,
    }
  })

  return {
    ok: true,
    memories,
    beliefs,
    origin,
    watermarks,
    jobs,
    ledger: {
      conversationEvents: ledgerRow === undefined ? null : Number(ledgerRow.total),
      latestSequence: ledgerRow === undefined ? null : Number(ledgerRow.latest),
      tail: ledgerTail,
    },
    beliefEvents,
    traces: { total: traceRows.length, withBeliefSection: withBelief, tail: traceTailReadings },
    readAt: new Date().toISOString(),
  }
}

const isMain = process.argv[1] !== undefined && /m9-live-read\.ts$/.test(process.argv[1])
if (isMain) {
  const dbDir = argValue('--db-dir')
  const out = argValue('--out')
  const tail = Number(argValue('--tail') ?? '30')
  const traceTail = Number(argValue('--traces') ?? '24')
  if (dbDir === undefined || out === undefined) {
    console.error('用法：tsx scripts/m9-live-read.ts --db-dir <副本> --out <json> [--tail 30] [--traces 24]')
    process.exit(2)
  }
  const resolved = resolve(dbDir)
  const fail = (reason: string): void => {
    writeFileSync(out, `${JSON.stringify({ ok: false, reason, readAt: new Date().toISOString() }, null, 2)}\n`, 'utf8')
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
      `  Memory ${String(reading.memories.length)} · Belief ${String(reading.beliefs.length)}（active ${String(reading.beliefs.filter((b) => b.status === 'active').length)}）· origin ${reading.origin === null ? '无' : `cutover=${String(reading.origin.cutoverSequence)}`} · 水位 交互=${String(reading.watermarks.interaction)} 记忆=${String(reading.watermarks.memoryReconciler)} · trace ${String(reading.traces?.total)}（belief ${String(reading.traces?.withBeliefSection)}）`
    )
  } catch (error) {
    fail(`读取失败：${error instanceof Error ? error.message : String(error)}`)
    process.exit(3)
  }
}
