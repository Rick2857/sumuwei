/**
 * M8.5 WP0 —— **零 DDL 承载实验**（`pnpm exec tsx scripts/m8.5-wp0-carryability.ts`）。
 *
 * ============================================================================
 *  要证明的命题（执行计划 §11 / §2.3"目标 NONE，WP0 待证明"）
 * ============================================================================
 * 现有通用表（M2.5 Job 体系）能否承载 M8.5 语义路径的全部持久化需求：
 *  ① character_jobs：语义评估任务的生命周期（pending/running/completed/failed
 *     + retry_count + 区间幂等键 + 部分唯一索引挡重复排期）。
 *  ② processor_watermarks：**三水位**（扫描 / 语义完成 / 最后成功影响）以
 *     不同 (processor, processor_version) 组合共存；只进不退守卫真实生效。
 *  ③ processed_operations：**跨版本稳定终结闸**
 *     `affect-semantic-finalized:<sourceEventId>`（键与 processor/version 无关）
 *     + 紧凑闭集回执编码进 `operation` TEXT 列；`on conflict do nothing` 幂等；
 *     `domain_event_id` 在 COMMITTED 时携带 IMPACT 事件 id。
 *
 * ⚠️ WP0 发现（本实验的动因）：character_jobs **没有 payload 列**——
 *    语义回执不能设计成"job payload"；终结闸行（processed_operations）承载
 *    紧凑回执、trace 步骤承载明细，是零 DDL 前提下的候选拆分（WP1 冻结）。
 *    本实验用原始 SQL 写闸行，证明**表能承载**；生产写入函数
 *    `recordProcessedOperation`（job-store 追加，非 DDL）归 WP6。
 *
 * 量具纪律（AGENTS.md §6）：正控（写了能读到）+ 负控（没写必须读不到 /
 * 回退必须被拒）+ measured_count 自检（0 检查 = INVALID，不是 PASS）。
 * 隔离库：本文件顶部 isolateDatabase；真实库不打开。
 */
import 'dotenv/config'

import { isolateDatabase } from '../src/dev/sandbox.ts'
isolateDatabase('m8.5-wp0-carryability', { keep: false })

import { AgentRuntime, type Character } from '@elizaos/core'
import sqlPlugin from '@elizaos/plugin-sql'
import { execSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { character } from '../src/character/index.ts'
import { initDatabase } from '../src/db/index.ts'
import { initKernel } from '../src/kernel/app/kernel.ts'
import { characterDefinitionFromCharacter } from '../src/infrastructure/runtime/seed-projection.ts'
import { sql } from 'drizzle-orm'
import { exec } from '../src/infrastructure/persistence/db.ts'
import {
  advanceWatermark,
  enqueueJob,
  finishJob,
  getJob,
  getWatermark,
  hasProcessedOperation,
  listProcessedOperations,
  markJobRunning,
} from '../src/infrastructure/persistence/job-store.ts'
import { asCharacterId, type CharacterId } from '../src/kernel/contracts/index.ts'

const REPO_ROOT = resolve(import.meta.dirname, '..')

// ---------------------------------------------------------------------------
// 检查条目（§6.8：measured_count 自检——0 检查 = INVALID）
// ---------------------------------------------------------------------------

interface Check {
  id: string
  label: string
  expected: string
  actual: string
  pass: boolean
}
const checks: Check[] = []
function record(id: string, label: string, expected: string, actual: string, pass: boolean): void {
  checks.push({ id, label, expected, actual, pass })
}

// ---------------------------------------------------------------------------
// 拟议身份（WP1 冻结正式名；这里验证的是键位形状，不是最终命名）
// ---------------------------------------------------------------------------

const SCAN_PROCESSOR = 'affect-semantic-scanner'
const SCAN_VERSION = 'affect-semantic-scanner@1'
const COMPLETION_PROCESSOR = 'affect-semantic-worker'
const COMPLETION_VERSION = 'affect-semantic-worker@1'
const IMPACT_PROCESSOR = 'affect-semantic-impact'
const IMPACT_VERSION = 'affect-semantic-impact@1'
const EVALUATOR_PROCESSOR = 'affect-semantic-evaluator'
const EVALUATOR_VERSION = 'affect-semantic-evaluator@1'

/** 终结闸键（§11.4：与 processor/version 无关的稳定键） */
function finalizedGateKey(sourceEventId: string): string {
  return `affect-semantic-finalized:${sourceEventId}`
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const runtime = new AgentRuntime({ character: character as Character, plugins: [], settings: {} })
  await initDatabase(runtime, sqlPlugin)
  await runtime.initialize()
  const kernel = await initKernel(runtime, {
    definition: characterDefinitionFromCharacter(character),
  })
  const db = kernel.stores.db
  const characterId: CharacterId = kernel.characterId

  // ---- ① character_jobs：生命周期 + 区间幂等 --------------------------------
  const jobKey = `m85-wp0-carryability:${EVALUATOR_PROCESSOR}:job-1`
  const first = await enqueueJob(db, {
    characterId,
    processor: EVALUATOR_PROCESSOR,
    processorVersion: EVALUATOR_VERSION,
    sourceFromSequence: 101,
    sourceToSequence: 101,
    idempotencyKey: jobKey,
  })
  record('C1a', '任务入队：新建', 'created=true', `created=${String(first.created)}`, first.created)
  record(
    'C1b',
    '任务入队：triggerKind=conversation（M3.5 断言通过）',
    'triggerKind=conversation',
    `triggerKind=${first.job.triggerKind ?? '(缺省)'}`,
    first.job.triggerKind === 'conversation',
  )

  const dup = await enqueueJob(db, {
    characterId,
    processor: EVALUATOR_PROCESSOR,
    processorVersion: EVALUATOR_VERSION,
    sourceFromSequence: 101,
    sourceToSequence: 101,
    idempotencyKey: jobKey,
  })
  record(
    'C1c',
    '区间幂等键：同键重排 ⇒ 不新建（部分唯一索引语义）',
    'created=false',
    `created=${String(dup.created)}`,
    dup.created === false,
  )

  await markJobRunning(db, first.job.id)
  const running = await getJob(db, first.job.id)
  record(
    'C2a',
    '生命周期：pending → running',
    'status=running',
    `status=${running?.status ?? '(missing)'}`,
    running?.status === 'running',
  )
  await finishJob(db, first.job.id, 'completed')
  const done = await getJob(db, first.job.id)
  record(
    'C2b',
    '生命周期：running → completed（含 finished_at）',
    'status=completed + finished_at 非空',
    `status=${done?.status ?? '(missing)'}, finished_at=${done?.finishedAt ?? '(空)'}`,
    done?.status === 'completed' && done.finishedAt !== undefined,
  )

  // ---- ② processor_watermarks：三水位共存 + 只进不退 ------------------------
  await advanceWatermark(db, characterId, SCAN_PROCESSOR, SCAN_VERSION, 42)
  await advanceWatermark(db, characterId, COMPLETION_PROCESSOR, COMPLETION_VERSION, 41)
  await advanceWatermark(db, characterId, IMPACT_PROCESSOR, IMPACT_VERSION, 40)
  const scanWm = await getWatermark(db, characterId, SCAN_PROCESSOR, SCAN_VERSION)
  const completionWm = await getWatermark(db, characterId, COMPLETION_PROCESSOR, COMPLETION_VERSION)
  const impactWm = await getWatermark(db, characterId, IMPACT_PROCESSOR, IMPACT_VERSION)
  record(
    'C3a',
    '三水位：以不同 (processor, version) 共存且互不覆盖',
    'scan=42, completion=41, impact=40',
    `scan=${scanWm?.processedThroughSequence ?? '(缺)'}, completion=${completionWm?.processedThroughSequence ?? '(缺)'}, impact=${impactWm?.processedThroughSequence ?? '(缺)'}`,
    scanWm?.processedThroughSequence === 42 &&
      completionWm?.processedThroughSequence === 41 &&
      impactWm?.processedThroughSequence === 40,
  )

  let regressionRejected = false
  let regressionError = ''
  try {
    await advanceWatermark(db, characterId, COMPLETION_PROCESSOR, COMPLETION_VERSION, 39)
  } catch (error) {
    regressionRejected = true
    regressionError = error instanceof Error ? error.message : String(error)
  }
  record(
    'C3b',
    '水位只进不退：回退必须被拒（负控）',
    'throw',
    regressionRejected ? `throw（${regressionError.slice(0, 60)}）` : '未抛——回退被静默接受！',
    regressionRejected,
  )
  const afterRegression = await getWatermark(db, characterId, COMPLETION_PROCESSOR, COMPLETION_VERSION)
  record(
    'C3c',
    '水位回退被拒后值不变',
    'completion=41',
    `completion=${afterRegression?.processedThroughSequence ?? '(缺)'}`,
    afterRegression?.processedThroughSequence === 41,
  )

  // ---- ③ processed_operations：终结闸 + 紧凑回执编码 ------------------------
  // 生产写入函数 recordProcessedOperation 归 WP6；这里用与 event-store 同形的
  // 原始 SQL 证明**表能承载**（on conflict do nothing 幂等）。
  const sourceId = 'ce-00000101'
  const gateKey = finalizedGateKey(sourceId)
  const insertGate = async (operation: string, domainEventId: string | null): Promise<void> => {
    await exec(
      db,
      sql`insert into processed_operations
            (idempotency_key, character_id, processor, processor_version, operation,
             domain_event_id, processed_at)
          values (${gateKey}, ${characterId}, ${EVALUATOR_PROCESSOR}, ${EVALUATOR_VERSION},
                  ${operation}, ${domainEventId}, ${Date.now()})
          on conflict (idempotency_key) do nothing`,
      '写入终结闸（WP0 实验）',
    )
  }
  // NO_IMPACT 终态：无域事件，回执编码进 operation
  await insertGate('affect-semantic@1|NO_IMPACT|NEUTRAL', null)
  await insertGate('affect-semantic@1|COMMITTED|A-GRATITUDE', 'de-00000001') // 同键重写 ⇒ 必须被忽略
  const gateRead = await hasProcessedOperation(db, gateKey)
  record(
    'C4a',
    '终结闸：写入后 hasProcessedOperation=true',
    'true',
    String(gateRead),
    gateRead === true,
  )
  const gateRows = (await listProcessedOperations(db, characterId, 500)).filter(
    (r) => r.idempotencyKey === gateKey,
  )
  record(
    'C4b',
    '终结闸：同键重写被 on conflict 忽略（单行）',
    'rows=1',
    `rows=${gateRows.length}`,
    gateRows.length === 1,
  )
  record(
    'C4c',
    '终结闸：首写编码保留（重写不覆盖）',
    "operation=affect-semantic@1|NO_IMPACT|NEUTRAL, domain_event_id=空",
    `operation=${gateRows[0]?.operation ?? '(缺)'}, domain_event_id=${gateRows[0]?.domainEventId ?? '(空)'}`,
    gateRows[0]?.operation === 'affect-semantic@1|NO_IMPACT|NEUTRAL' &&
      gateRows[0]?.domainEventId === undefined,
  )

  // COMMITTED 终态：另一来源，携带 IMPACT 事件 id
  const sourceId2 = 'ce-00000102'
  const gateKey2 = finalizedGateKey(sourceId2)
  await exec(
    db,
    sql`insert into processed_operations
          (idempotency_key, character_id, processor, processor_version, operation,
           domain_event_id, processed_at)
        values (${gateKey2}, ${characterId}, ${EVALUATOR_PROCESSOR}, ${EVALUATOR_VERSION},
                ${'affect-semantic@1|COMMITTED|A-GRATITUDE'}, ${'de-00000042'}, ${Date.now()})
        on conflict (idempotency_key) do nothing`,
    '写入终结闸（WP0 实验，COMMITTED 形）',
  )
  const committedRow = (await listProcessedOperations(db, characterId, 500)).find(
    (r) => r.idempotencyKey === gateKey2,
  )
  record(
    'C5a',
    'COMMITTED 闸行：family 编码 + domain_event_id 往返完整',
    "operation=affect-semantic@1|COMMITTED|A-GRATITUDE, domain_event_id=de-00000042",
    `operation=${committedRow?.operation ?? '(缺)'}, domain_event_id=${committedRow?.domainEventId ?? '(缺)'}`,
    committedRow?.operation === 'affect-semantic@1|COMMITTED|A-GRATITUDE' &&
      committedRow?.domainEventId === 'de-00000042',
  )

  // 负控：未写闸的来源必须读不到（检测器真的在检测，不是恒真）
  const absentGate = await hasProcessedOperation(db, finalizedGateKey('ce-99999999'))
  record(
    'C5b',
    '终结闸负控：未写闸的来源 hasProcessedOperation=false',
    'false',
    String(absentGate),
    absentGate === false,
  )

  // ---- ④ 共存互扰：闸行与水位同库共存 ----------------------------------------
  await advanceWatermark(db, characterId, COMPLETION_PROCESSOR, COMPLETION_VERSION, 101)
  const coWm = await getWatermark(db, characterId, COMPLETION_PROCESSOR, COMPLETION_VERSION)
  const coGate = await hasProcessedOperation(db, gateKey)
  record(
    'C6a',
    '共存：闸行写入后水位照常推进（互不干扰）',
    'completion=101 且闸仍在',
    `completion=${coWm?.processedThroughSequence ?? '(缺)'}, gate=${String(coGate)}`,
    coWm?.processedThroughSequence === 101 && coGate === true,
  )

  // ---- 证据落盘 + 判定 --------------------------------------------------------
  const allPass = checks.length > 0 && checks.every((c) => c.pass)
  const summary = {
    milestone: 'M8.5',
    workPackage: 'WP0',
    experiment: 'zero-ddl-carryability',
    verdict: allPass ? 'PASS' : checks.length === 0 ? 'MEASUREMENT INVALID' : 'FAIL',
    measuredCount: checks.length,
    passed: checks.filter((c) => c.pass).length,
    failed: checks.filter((c) => !c.pass).length,
    head: execSync('git rev-parse HEAD', { cwd: REPO_ROOT }).toString().trim(),
    isolatedDatabase: true,
    realDbOpened: false,
    checks,
  }

  const runId = `wp0-carryability-${new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-')}`
  const runDir = join(REPO_ROOT, 'artifacts', 'm8.5', runId)
  mkdirSync(runDir, { recursive: true })
  const evidencePath = join(runDir, 'carryability.json')
  writeFileSync(evidencePath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')

  for (const c of checks) {
    const mark = c.pass ? '  ✅' : '  ❌'
    console.log(`${mark} ${c.id} ${c.label} — 期望 ${c.expected}，实际 ${c.actual}`)
  }
  console.log('----------------------------------------------------------------------------')
  console.log(
    `M8.5 WP0 承载实验：${summary.verdict}（${summary.passed}/${summary.measuredCount} 通过，` +
      `${summary.failed} 失败）`,
  )
  console.log(`证据：${evidencePath}`)
  process.exitCode = allPass ? 0 : 1
}

main().catch((error) => {
  console.error('[m8.5-wp0-carryability] 未预期失败：', error)
  process.exitCode = 1
})
