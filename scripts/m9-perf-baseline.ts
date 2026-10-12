/**
 * M9 线**性能基线探针**（`pnpm m9:perf:baseline`）—— `TD-17` 拆项里的"M9 那一半"。
 *
 * ============================================================================
 *  它回答什么、**不**回答什么
 * ============================================================================
 * ```text
 * 回答：在隔离库 + 固定规模下，三条面的**墙钟分位**与**每次操作的 DB 调用数 / 返回行数**：
 *   ① 形成（`appendDomainEvent` + `applyMemoryEvent`：一条 reported Memory 落事件 + 折叠）
 *   ② 查询（`listBeliefsByStatus`：信念域读路径）
 *   ③ 上下文回查（`buildBeliefContextSection`：资格回查 + 遮蔽 + 去重 + 渲染）
 * **不**回答：任何 SLA 判定。`TD-17` 的原话是"SLA 未冻结" ⇒ 本门**只出读数**，
 * 不设阈值、不判 PASS/FAIL（控制段失败与 `measured_count = 0` 除外）。
 * ```
 *
 * ============================================================================
 *  三段式（只针对**计时与计数这个量具**，不是对被测系统）
 * ============================================================================
 * ```text
 * 正控：三条面各测 N 次 ⇒ 每次 `dbCalls > 0`（否则说明我没量到东西，不许当"很快"）
 * 负控：在 DB 句柄上**注入 3ms/次**的延迟 ⇒ 「查询」面的 p95 必须**至少抬高一个注入量**，
 *       而 `dbCalls/op` **必须不变**（证明量具看得见注入的开销，且计数没被注入污染）
 * 恢复：把注入关掉 ⇒ p95 必须**低于注入档**（相对比较，不设绝对阈值 —— 本机噪声不可控）
 * ```
 *
 * ⚠️ 零模型 / 零出网；只开 `isolateDatabase()` 的一次性沙箱，**绝不打开真实库**。
 */

import 'dotenv/config'
import { isolateDatabase } from '../src/dev/sandbox.ts'
import { AgentRuntime } from '@elizaos/core'
import sqlPlugin from '@elizaos/plugin-sql'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { character } from '../src/character/index.ts'
import { initDatabase } from '../src/db/index.ts'
import { initKernel } from '../src/kernel/app/kernel.ts'
import { characterDefinitionFromCharacter } from '../src/infrastructure/runtime/seed-projection.ts'
import { createHumanConsoleUserTurnIngress } from '../src/infrastructure/runtime/conversation-attribution.ts'
import { seedBeliefOrigin, maybeRunBeliefEvaluation, maybeRunBeliefMemoryReconciliation } from '../src/infrastructure/runtime/belief-scheduler.ts'
import { appendConversationEvent } from '../src/infrastructure/persistence/conversation-store.ts'
import { appendDomainEvent } from '../src/infrastructure/persistence/event-store.ts'
import { applyMemoryEvent } from '../src/infrastructure/persistence/memory-store.ts'
import { listBeliefsByStatus } from '../src/infrastructure/persistence/belief-store.ts'
import { buildBeliefContextSection } from '../src/infrastructure/runtime/adapters.ts'
import { getRawDb, rowsOf } from '../src/infrastructure/persistence/db.ts'
import { MEMORY_REDUCER_VERSION, MEMORY_SCHEMA_VERSION, conversationEvidence, type MemoryRecord } from '../src/kernel/contracts/memory.ts'
import { asConversationId, entityRef } from '../src/kernel/contracts/index.ts'
import type { AcceptedDomainEvent } from '../src/kernel/policies/validator.ts'
import { DOMAIN_EVENT_SCOPE } from '../src/kernel/contracts/domain-event.ts'
import { createM9RunId, openM9RunDir, writeM9Manifest } from './m9-evidence.ts'

const REPO_ROOT = process.cwd()
const USER = 'm9-perf-user'
const USER_ENTITY = entityRef('user', USER)
const ITERATIONS = 20
const WARMUPS = 3
const INJECTED_DELAY_MS = 3

interface Reading {
  id: string
  label: string
  n: number
  p50: number
  p95: number
  min: number
  max: number
  dbCallsPerOp: number
  rowsPerOp: number
}

const percentile = (sorted: readonly number[], fraction: number): number => {
  if (sorted.length === 0) return Number.NaN
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))
  return sorted[index] as number
}

const run = async (): Promise<void> => {
  isolateDatabase('m9-perf-baseline', { keep: false })
  const runtime = new AgentRuntime({ character: character as never, plugins: [], settings: {} } as never)
  await initDatabase(runtime, sqlPlugin as never)
  await runtime.initialize()
  const kernel = await initKernel(runtime, { definition: characterDefinitionFromCharacter(character) })
  const db = kernel.stores.db
  const characterId = kernel.characterId

  const T0 = Date.UTC(2026, 9, 4, 9, 0, 0)
  let tickMs = 0
  const tick = (): number => T0 + (tickMs += 500)

  /* ---- 计数/注入层：包在**真句柄**上，所有仓储与装配侧的读取都会经过它 ---------- */
  const raw = getRawDb(runtime) as { execute: (q: unknown) => Promise<unknown> }
  const original = raw.execute.bind(raw)
  let injectedDelayMs = 0
  let calls = 0
  let returnedRows = 0
  raw.execute = async (query: unknown): Promise<unknown> => {
    calls += 1
    if (injectedDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, injectedDelayMs))
    const result = await original(query)
    returnedRows += rowsOf(result).length
    return result
  }
  const resetCounters = (): void => {
    calls = 0
    returnedRows = 0
  }

  const userIngress = createHumanConsoleUserTurnIngress()
  /*
   * ⚠️ **两个会话**：信念的"推断形成"门槛要求跨 ≥2 会话（`L-M9-14` 的同一门槛）。
   * 只用一个会话时 `maybeRunBeliefEvaluation` 永远不形成信念 ⇒ "上下文回查"面会量到
   * **零候选的 early path** —— 那是无效测量（本探针实测踩过：信念 0 条）。
   */
  const convSeqByConv = new Map<string, number>()
  const appendUserEvent = async (content: string): Promise<string> => {
    const conversation = convSeqByConv.size % 2 === 0 ? 'm9-perf-conv-a' : 'm9-perf-conv-b'
    const seq = (convSeqByConv.get(conversation) ?? 0) + 1
    convSeqByConv.set(conversation, seq)
    const { event } = await appendConversationEvent(db, {
      characterId,
      conversationId: asConversationId(conversation),
      conversationSequence: seq,
      type: 'user_message',
      actorType: 'user',
      actorId: USER,
      content,
      createdAt: tick(),
      trustedAttribution: userIngress.attest({ characterId: String(characterId), presenterActorId: USER, userId: USER }),
    })
    return String(event.id)
  }

  let memSeq = 0
  const formMemory = async (rootEventId: string): Promise<string> => {
    memSeq += 1
    const memoryId = `mem-m9-perf-${String(memSeq).padStart(3, '0')}`
    const record: MemoryRecord = {
      id: memoryId as never,
      owner: entityRef('character', String(characterId)),
      type: 'preference',
      content: {
        kind: 'claim',
        subject: USER_ENTITY,
        predicate: 'preference.answer_length',
        value: memSeq % 2 === 0 ? 'short' : 'detailed',
        qualifiers: { context: 'technical' },
      } as never,
      subjects: [USER_ENTITY],
      epistemicStatus: 'reported',
      authority: 'EXPLICIT_USER_STATEMENT',
      importance: 0.8,
      confidence: 0.9,
      status: 'active',
      sourceRefs: [conversationEvidence(rootEventId)],
      evidenceRootIds: [rootEventId as never],
      recordedAt: tick(),
      contentFingerprint: `m9-perf-fp-${String(memSeq)}`,
      revision: 0,
      reducerVersion: MEMORY_REDUCER_VERSION,
      schemaVersion: MEMORY_SCHEMA_VERSION,
      createdAt: tick(),
    } as never
    const accepted: AcceptedDomainEvent = {
      type: 'MEMORY_CREATED',
      operation: 'create',
      payload: { memoryId, mutation: 'explicit', record },
      sourceConversationEventIds: [rootEventId as never],
      idempotencyKey: `m9-perf:memory:${String(memSeq)}`,
      processor: 'm9-perf-baseline',
      processorVersion: 'm9-perf-baseline@1',
      scope: DOMAIN_EVENT_SCOPE,
    }
    const appended = await appendDomainEvent(db, characterId, accepted, tick())
    await applyMemoryEvent(db, appended.event, tick())
    return memoryId
  }

  const origin = await seedBeliefOrigin(db, { characterId, activationId: 'm9-perf-act-1', now: tick() })
  if (origin.kind !== 'seeded' && origin.kind !== 'already') {
    console.log(`❌ 建档失败：${String(origin.kind)}`)
    process.exit(2)
  }

  /* ---- 夹具：先造 24 条带对话根的 reported Memory（形成面的输入是现成事件） ------- */
  const rootEventIds: string[] = []
  for (let i = 0; i < ITERATIONS + WARMUPS; i += 1) rootEventIds.push(await appendUserEvent(`（性能基线夹具 #${String(i + 1)}）我更喜欢简短的答复`))

  /*
   * 让信念域真的形成几条（否则"上下文回查"面量的是空集 —— 那是无效测量）。
   * 两条腿都试，都是**零模型**的确定性路径：
   *   ① `maybeRunBeliefMemoryReconciliation` ⇒ **reported** 信念（`reconciler.ts` 的 B-REPORTED 规则）
   *   ② `maybeRunBeliefEvaluation` ⇒ 推断（需要跨 ≥2 会话的门槛）
   * ⚠️ 本探针实测：只靠 ② 时**一条都不形成**（本机零模型下推断路径不产出）⇒ ① 才是可用的腿。
   */
  for (let i = 0; i < ITERATIONS + WARMUPS; i += 1) await formMemory(rootEventIds[i] as string)
  resetCounters()
  const reconciliation = await maybeRunBeliefMemoryReconciliation(db, { characterId, now: tick() })
  for (let window = 0; window < 6; window += 1) {
    await maybeRunBeliefEvaluation(db, { characterId, activeUserId: USER, now: tick() })
  }
  const beliefs = await listBeliefsByStatus(db, characterId, ['active', 'disputed'])
  console.log(
    `夹具：Memory ${String(ITERATIONS + WARMUPS)} 条 · 2 个会话 · 信念 ${String(beliefs.length)} 条` +
      `（reconciliation=${JSON.stringify(reconciliation).slice(0, 90)} · 形成面输入 = 现成对话根）`
  )
  if (beliefs.length === 0) {
    console.log(
      '⚠️ **信念 0 条** ⇒ 「上下文回查」面量到的是**零候选 early path**，不是真渲染路径 —— 本门据此判 `MEASUREMENT INVALID`（不把空集当读数）'
    )
  }

  const measure = async (id: string, label: string, op: () => Promise<unknown>): Promise<Reading> => {
    for (let i = 0; i < WARMUPS; i += 1) await op()
    const samples: number[] = []
    resetCounters()
    for (let i = 0; i < ITERATIONS; i += 1) {
      const started = process.hrtime.bigint()
      await op()
      samples.push(Number(process.hrtime.bigint() - started) / 1e6)
    }
    const sorted = [...samples].sort((a, b) => a - b)
    return {
      id,
      label,
      n: samples.length,
      p50: Number(percentile(sorted, 0.5).toFixed(3)),
      p95: Number(percentile(sorted, 0.95).toFixed(3)),
      min: Number((sorted[0] ?? Number.NaN).toFixed(3)),
      max: Number((sorted[sorted.length - 1] ?? Number.NaN).toFixed(3)),
      dbCallsPerOp: Number((calls / Math.max(1, samples.length)).toFixed(2)),
      rowsPerOp: Number((returnedRows / Math.max(1, samples.length)).toFixed(2)),
    }
  }

  /* ---- 每次"形成"都要一条**未被用过**的对话根 ⇒ 预置足够的根 -------------------- */
  let formationCursor = 0
  const formationRoots: string[] = []
  for (let i = 0; i < ITERATIONS + WARMUPS; i += 1) formationRoots.push(await appendUserEvent(`（形成面夹具 #${String(i + 1)}）我更喜欢详细的答复`))

  const readings: Reading[] = []
  readings.push(
    await measure('m9:perf:formation', '形成（appendDomainEvent + applyMemoryEvent）', async () => {
      const root = formationRoots[formationCursor % formationRoots.length] as string
      formationCursor += 1
      await formMemory(root)
    })
  )
  readings.push(
    await measure('m9:perf:query', '查询（listBeliefsByStatus active+disputed）', async () => {
      await listBeliefsByStatus(db, characterId, ['active', 'disputed'])
    })
  )
  readings.push(
    await measure('m9:perf:context', '上下文回查（buildBeliefContextSection）', async () => {
      await buildBeliefContextSection(runtime, {
        characterId: String(characterId),
        activeUserId: USER,
        selectedMemoryIds: [],
      })
    })
  )

  /* ---- 负控 / 恢复：注入延迟后重测「查询」面 ----------------------------------- */
  const baselineQuery = readings.find((reading) => reading.id === 'm9:perf:query') as Reading
  injectedDelayMs = INJECTED_DELAY_MS
  const injectedQuery = await measure('m9:perf:query(injected)', `查询 + 注入 ${String(INJECTED_DELAY_MS)}ms/次`, async () => {
    await listBeliefsByStatus(db, characterId, ['active', 'disputed'])
  })
  injectedDelayMs = 0
  const recoveredQuery = await measure('m9:perf:query(recovered)', '查询（注入已移除）', async () => {
    await listBeliefsByStatus(db, characterId, ['active', 'disputed'])
  })

  /* ---- 判定：只判**量具自身**（不判 SLA） ------------------------------------- */
  const checks: { id: string; label: string; pass: boolean; detail: string }[] = []
  const measured = readings.reduce((sum, reading) => sum + reading.n, 0)
  checks.push({
    id: 'P0',
    label: '正控：三条面各测到 N > 0 次，且每次操作的 `dbCalls > 0`',
    pass: readings.every((reading) => reading.n > 0 && reading.dbCallsPerOp > 0),
    detail: readings.map((r) => `${r.id}=${String(r.n)}/${String(r.dbCallsPerOp)}call`).join(' · '),
  })
  checks.push({
    id: 'P1',
    label: `负控：注入 ${String(INJECTED_DELAY_MS)}ms/次 ⇒ 「查询」p95 至少抬高一个注入量，且 dbCalls/op 不变`,
    pass:
      injectedQuery.p95 >= baselineQuery.p95 + INJECTED_DELAY_MS &&
      injectedQuery.dbCallsPerOp === baselineQuery.dbCallsPerOp,
    detail: `baseline p95=${String(baselineQuery.p95)} → injected p95=${String(injectedQuery.p95)}（+${String((injectedQuery.p95 - baselineQuery.p95).toFixed(2))}ms） · dbCalls ${String(baselineQuery.dbCallsPerOp)} → ${String(injectedQuery.dbCallsPerOp)}`,
  })
  checks.push({
    id: 'P2',
    label: '恢复：移除注入 ⇒ p95 回落到注入档之下',
    pass: recoveredQuery.p95 < injectedQuery.p95,
    detail: `injected p95=${String(injectedQuery.p95)} → recovered p95=${String(recoveredQuery.p95)}`,
  })
  checks.push({
    id: 'P3',
    label: '计数自检：`measured_count > 0`（0 次测量不算"很快"）',
    pass: measured > 0,
    detail: `measured_count=${String(measured)}`,
  })
  /*
   * ⚠️ **空集自检**（`AGENTS §6.8` 的同款纪律）：信念为 0 时"上下文回查"面量到的是
   * 零候选 early path ⇒ 那道面的读数**无效**（不是"很快"）。这条检查是失败关闭的。
   */
  checks.push({
    id: 'P4',
    label: '空集自检：「上下文回查」面必须有候选（信念 > 0），否则该面读数无效',
    pass: beliefs.length > 0,
    detail: `信念=${String(beliefs.length)} ⇒ 上下文面=${beliefs.length > 0 ? '真渲染路径' : '零候选 early path（INVALID）'}`,
  })
  const failed = checks.filter((check) => !check.pass)

  console.log('\n读数（隔离库 · 无模型 · 无出网；**本门不判 SLA**）')
  for (const reading of readings) {
    console.log(
      `  ${reading.id.padEnd(26)} p50=${String(reading.p50).padStart(8)}ms p95=${String(reading.p95).padStart(8)}ms ` +
        `min/max=${String(reading.min)}/${String(reading.max)}  dbCalls/op=${String(reading.dbCallsPerOp)}  rows/op=${String(reading.rowsPerOp)}`
    )
  }
  console.log(`  ${injectedQuery.id.padEnd(26)} p50=${String(injectedQuery.p50)}ms p95=${String(injectedQuery.p95)}ms（负控）`)
  console.log(`  ${recoveredQuery.id.padEnd(26)} p50=${String(recoveredQuery.p50)}ms p95=${String(recoveredQuery.p95)}ms（恢复）`)
  for (const check of checks) console.log(`  ${check.pass ? '✅' : '❌'} ${check.id} ${check.label} —— ${check.detail}`)

  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  const runId = createM9RunId({ wpId: 'perf-baseline', headShort: head })
  const dir = openM9RunDir(REPO_ROOT, runId)
  const payload = {
    schema: 'm9-perf-baseline@1',
    runId,
    head,
    scope: '形成 / 查询 / 上下文回查 三条面；隔离库；零模型；**不判 SLA**（TD-17 的"M9 半边"读数）',
    iterations: ITERATIONS,
    warmups: WARMUPS,
    injectedDelayMs: INJECTED_DELAY_MS,
    fixture: { memories: ITERATIONS + WARMUPS, beliefs: beliefs.length },
    readings,
    controls: { injectedQuery, recoveredQuery, checks },
    summary: { measuredCount: measured, checks: checks.length, failed: failed.length },
    verdict: failed.length === 0 ? 'READINGS ONLY (controls PASS)' : 'MEASUREMENT INVALID',
    disclaimer:
      '本门**只出读数、不判达标**：TD-17 的性能 SLA 尚未冻结，冻结要由用户裁定。' +
      '控制段只证明"这个量具看得见注入的开销、且计到过东西"，不证明任何性能水平。',
  }
  writeFileSync(join(dir, 'perf-baseline.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  writeM9Manifest(dir, {
    runId,
    wp: 'perf-baseline',
    head,
    headShort: head.slice(0, 12),
    branch: execFileSync('git', ['branch', '--show-current'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim(),
    date: new Date().toISOString().slice(0, 10),
    toolVersions: { node: process.version },
    testType: 'perf-baseline',
    counts: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
    phases: ['readings-only'],
    supersedes: null,
    notes: `m9:perf:baseline（读数 ${String(readings.length)} 面 × ${String(ITERATIONS)} 次；控制 ${String(checks.length - failed.length)}/${String(checks.length)}）`,
  })
  console.log(`\nrunId: ${runId}`)
  console.log(`verdict: ${payload.verdict}（控制 ${String(checks.length - failed.length)}/${String(checks.length)}）`)
  console.log(`证据：${join(dir, 'perf-baseline.json')}`)
  process.exit(failed.length === 0 ? 0 : 1)
}

run().catch((error: unknown) => {
  console.error(`❌ 探针自身失败：${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  process.exit(2)
})
