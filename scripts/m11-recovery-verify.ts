/**
 * M11 WP7 —— **任务、水位、恢复与晚写闸门**（`m11:recovery:verify`）。
 *
 * ============================================================================
 *  本门要测的命题
 * ============================================================================
 * ```text
 * ① **不楔死**：tool / assistant 事件被跳过，但水位**越过它们**（否则窗口永远含它）。
 * ② **可恢复**：run 抛错 ⇒ 任务行**如实落 failed**、水位**不前进**；下一次同窗重试可达。
 * ③ **不重跑已完成的活**：同窗已完成 ⇒ 只补水位（`recovered`），不产生第二份业务事件。
 * ④ **late-write fence 真实生效**：关闭之后到达的结果**零写入**（事件 / 投影 / 水位）。
 * ⑤ **合并不丢失效**：两个待处理区间合并只扩大范围，必须失效的集合取并集。
 * ```
 */

import 'dotenv/config'

import { isolateDatabase } from '../src/dev/sandbox.ts'

// ⚠️ 必须在**任何**碰数据库的 import 之前（AGENTS §7）
isolateDatabase('m11-recovery-verify', { keep: false })

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { createM4Harness, M4_T0 } from './m4-harness.ts'
import {
  M11_MANIFEST_VERSION,
  createM11RunId,
  openM11RunDir,
  runIdFromM11OutPath,
  writeM11Manifest,
} from './m11-evidence.ts'
import {
  mergePendingWindows,
  planReflectionWindow,
  type ReflectionWindowEvent,
  type ReflectionWindowPlan,
} from '../src/kernel/app/reflection/job.ts'
import {
  createLateWriteFence,
  guardedWrite,
  withLateWriteFence,
} from '../src/kernel/app/reflection/late-write-fence.ts'
import {
  REFLECTION_PROCESSOR,
  maybeRunReflectionEvaluation,
} from '../src/infrastructure/runtime/reflection-scheduler.ts'
import { getWatermark, listJobs } from '../src/infrastructure/persistence/job-store.ts'
import { appendDomainEvent, domainEventsFor } from '../src/infrastructure/persistence/event-store.ts'
import { DIAGNOSTIC_SIGNAL } from '../src/kernel/contracts/domain-event.ts'
import type { CharacterId } from '../src/kernel/contracts/ids.ts'

const REPO_ROOT = resolve(process.cwd())

interface Check {
  id: string
  group: 'A' | 'B' | 'C' | 'D' | 'S'
  label: string
  pass: boolean
  detail: string
}

const checks: Check[] = []
function record(id: string, group: Check['group'], label: string, pass: boolean, detail: string): void {
  checks.push({ id, group, label, pass, detail })
}

const event = (sequence: number, actorType = 'user', requiresInvalidation = false): ReflectionWindowEvent => ({
  id: `de:${String(sequence)}`,
  type: 'TEST_CHARACTER_SIGNAL',
  sequence,
  actorType,
  requiresInvalidation,
})

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  let out: string | undefined
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--out') out = args[++i]
    else throw new Error(`未知参数：${JSON.stringify(args[i])}`)
  }

  const h = await createM4Harness({ label: 'm11-recovery-verify' })
  const db = h.db
  const characterId = h.kernel.characterId as CharacterId
  const evidence = await h.recordUserEvidence('这是一条用于慢路径恢复验证的真实对话事件。')

  // -------------------------------------------------------------------------
  // A 组 —— 窗口规划（纯）
  // -------------------------------------------------------------------------
  const noTail = planReflectionWindow({ events: [], watermark: 10, latest: 10 })
  record(
    'A1',
    'A',
    '【不调模型】没有尾巴（latest ≤ watermark）⇒ `hasTail = false`（`D15`）',
    noTail.hasTail === false && noTail.eligible.length === 0,
    `hasTail=${String(noTail.hasTail)}`
  )

  const withTool = planReflectionWindow({
    events: [event(1, 'tool'), event(2, 'user'), event(3, 'assistant'), event(4, 'user')],
    watermark: 0,
    latest: 4,
  })
  record(
    'A2',
    'A',
    '【不楔死】窗口里有 tool / assistant 事件：它们被**跳过**，但 `toSequence` **越过**它们（水位会前进）',
    withTool.skipped.length === 2 &&
      withTool.eligible.length === 2 &&
      withTool.toSequence === 4 &&
      withTool.skipped.some((row) => row.reason === 'tool_event_not_eligible') &&
      withTool.skipped.some((row) => row.reason === 'assistant_speech_not_eligible'),
    `skipped=${JSON.stringify(withTool.skipped)} · eligible=${String(withTool.eligible.length)} · toSequence=${String(withTool.toSequence)}`
  )

  const many = Array.from({ length: 60 }, (_, i) => event(i + 1, 'user'))
  const bounded = planReflectionWindow({ events: many, watermark: 0, latest: 60 })
  record(
    'A3',
    'A',
    '【有界】60 条合格事件 ⇒ 只消费 50 条且如实标 `truncated`（上界只到最后一个被消费的事件）',
    bounded.eligible.length === 50 && bounded.truncated === true && bounded.toSequence === 50,
    `eligible=${String(bounded.eligible.length)} · truncated=${String(bounded.truncated)} · toSequence=${String(bounded.toSequence)}`
  )

  const merged = mergePendingWindows(
    { fromSequence: 5, toSequence: 8, mustInvalidate: ['de:6'] },
    { fromSequence: 2, toSequence: 12, mustInvalidate: ['de:11'] }
  )
  record(
    'A4',
    'A',
    '【合并不丢失效】两个区间合并：范围取并、`mustInvalidate` 取**并集**（不丢任何一条必须失效）',
    merged.fromSequence === 2 &&
      merged.toSequence === 12 &&
      merged.mustInvalidate.join(',') === 'de:11,de:6',
    `from=${String(merged.fromSequence)} · to=${String(merged.toSequence)} · mustInvalidate=${JSON.stringify(merged.mustInvalidate)}`
  )

  const invalidationEvent = planReflectionWindow({
    events: [event(1, 'user', true), event(2, 'user', false)],
    watermark: 0,
    latest: 2,
  })
  record(
    'A5',
    'A',
    '【必须失效】标了 `requiresInvalidation` 的事件进 `mustInvalidate`（`D12` 的后台那一步有输入）',
    invalidationEvent.mustInvalidate.join(',') === 'de:1',
    `mustInvalidate=${JSON.stringify(invalidationEvent.mustInvalidate)}`
  )

  // -------------------------------------------------------------------------
  // B 组 —— 调度（隔离库 + 真实 job store / 水位）
  // -------------------------------------------------------------------------
  let latest = 0
  let runs = 0
  let failNext = false
  const ports = {
    async latestSequence() {
      return latest
    },
    async readWindow(from: number, to: number): Promise<readonly ReflectionWindowEvent[]> {
      return Array.from({ length: Math.max(0, to - from) }, (_, i) => event(from + i + 1, 'user'))
    },
    async run(_window: ReflectionWindowPlan) {
      runs += 1
      if (failNext) throw new Error('provider exploded（本门注入的失败）')
    },
  }
  const schedulerInput = {
    characterId,
    processorVersion: 'reflection-scheduler@1',
    cutoverSequence: 0,
    ports,
    now: M4_T0,
  }

  latest = 3
  /*
   * ⚠️ **判据更新（2026-10-01，WP12）**：调度器的首次调用语义**故意**变了 ——
   *    水位行不存在时**预置 cutover 且本次不消费**（`cutover_preset`），
   *    而不是"从 cutover 起读并消费"。
   *    为什么：只 no_tail 不建行 ⇒ 水位永远建不起来、慢路径**永不运行**；
   *    按 0 起读 ⇒ **回判全部历史**（违反 `D33`）。预置是这两件事唯一的交点。
   *    ⇒ 旧判据（首次即 `ran`）量的是**改之前**的语义，必须跟着改，并**补上**预置那一条。
   */
  const preset = await maybeRunReflectionEvaluation(db, schedulerInput)
  const watermarkAfterPreset = await getWatermark(db, characterId, REFLECTION_PROCESSOR, 'reflection-scheduler@1')
  record(
    'B1',
    'B',
    '【首次 = 预置 cutover（`D33`）】水位行不存在 ⇒ 预置成调用方给的 cutover，**本次不消费**、**不调用模型**',
    preset.kind === 'cutover_preset' &&
      watermarkAfterPreset?.processedThroughSequence === 0 &&
      runs === 0,
    `kind=${preset.kind} · watermark=${String(watermarkAfterPreset?.processedThroughSequence)} · runs=${String(runs)}`
  )

  const first = await maybeRunReflectionEvaluation(db, schedulerInput)
  const watermarkAfterFirst = await getWatermark(db, characterId, REFLECTION_PROCESSOR, 'reflection-scheduler@1')
  record(
    'B1b',
    'B',
    '【正控·预置之后才消费】第二次有尾巴 ⇒ 真的跑了一次，且水位前进到窗口上界',
    first.kind === 'ran' && first.toSequence === 3 && watermarkAfterFirst?.processedThroughSequence === 3,
    `kind=${first.kind} · toSequence=${first.kind === 'ran' ? String(first.toSequence) : '-'} · watermark=${String(watermarkAfterFirst?.processedThroughSequence)}`
  )

  const second = await maybeRunReflectionEvaluation(db, schedulerInput)
  record(
    'B2',
    'B',
    '【不重跑】水位已到 ⇒ 再一次是 `no_tail`（**不调用模型**）',
    second.kind === 'no_tail' && runs === 1,
    `kind=${second.kind} · runs=${String(runs)}`
  )

  // B3 —— 失败：任务落 failed、水位不前进
  latest = 5
  failNext = true
  const failed = await maybeRunReflectionEvaluation(db, schedulerInput)
  const watermarkAfterFail = await getWatermark(db, characterId, REFLECTION_PROCESSOR, 'reflection-scheduler@1')
  const jobsAfterFail = await listJobs(db, characterId)
  const failedJobs = jobsAfterFail.filter((job) => job.status === 'failed')
  record(
    'B3',
    'B',
    '【失败可恢复】run 抛错 ⇒ 任务行**如实落 failed**、水位**不前进**（尾窗留给下一轮）',
    failed.kind === 'failed' &&
      failedJobs.length === 1 &&
      watermarkAfterFail?.processedThroughSequence === 3,
    `kind=${failed.kind} · failed 任务=${String(failedJobs.length)} · watermark=${String(watermarkAfterFail?.processedThroughSequence)}`
  )

  // B4 —— 同窗重试可达（failed 的幂等键允许重建）
  failNext = false
  const retry = await maybeRunReflectionEvaluation(db, { ...schedulerInput, now: M4_T0 + 60_000 })
  const watermarkAfterRetry = await getWatermark(db, characterId, REFLECTION_PROCESSOR, 'reflection-scheduler@1')
  record(
    'B4',
    'B',
    '【同窗恢复可达】失败之后重跑：能重建任务并成功 ⇒ 水位前进到 5（"补洞"真的走得通）',
    retry.kind === 'ran' && retry.toSequence === 5 && watermarkAfterRetry?.processedThroughSequence === 5,
    `kind=${retry.kind} · watermark=${String(watermarkAfterRetry?.processedThroughSequence)}`
  )

  // B5 —— 已完成的窗口只补水位，不重跑
  const runsBefore = runs
  latest = 5
  await maybeRunReflectionEvaluation(db, schedulerInput)
  record(
    'B5',
    'B',
    '【不重跑已完成的活】水位与最新序号相同 ⇒ `no_tail`，`run` 调用次数**不增**',
    runs === runsBefore,
    `runs ${String(runsBefore)} → ${String(runs)}`
  )

  // -------------------------------------------------------------------------
  // C 组 —— late-write fence（`L-M11-11`：仓库里今天没有这道闸）
  // -------------------------------------------------------------------------
  const fence = createLateWriteFence()
  const beforeClose = await guardedWrite(fence, async () => 'written')
  fence.close()
  const afterClose = await guardedWrite(fence, async () => 'should-not-happen')
  record(
    'C1',
    'C',
    '【闸门】关闭前放行、关闭后返回 `late_write_fenced`（拒绝是**返回值**，不是异常）',
    beforeClose.ok === true &&
      afterClose.ok === false &&
      afterClose.reason === 'late_write_fenced' &&
      fence.refusedCount === 1 &&
      fence.closed === true,
    `关闭前=${String(beforeClose.ok)} · 关闭后=${afterClose.ok ? 'ok' : afterClose.reason} · refusedCount=${String(fence.refusedCount)}`
  )

  const closeTwice = createLateWriteFence()
  closeTwice.close()
  closeTwice.close()
  record(
    'C2',
    'C',
    '【幂等·单向】`close()` 可重复调用且**没有** `open()`（重开会把一次关机变成一次竞态）',
    closeTwice.closed === true && !('open' in closeTwice),
    `closed=${String(closeTwice.closed)} · hasOpen=${String('open' in closeTwice)}`
  )

  // C3 —— 真实库：晚返回的结果**零写入**
  /*
   * ⚠️ 先把事件计数器的分母打非零：否则"零写入"是 "0 → 0"，
   *    而那与"计数器根本不工作"在输出上**长得一样**（AGENTS §6.8）。
   */
  await appendDomainEvent(
    db,
    characterId,
    {
      type: DIAGNOSTIC_SIGNAL,
      operation: 'm11-recovery-probe',
      payload: { counterDelta: 1 },
      sourceConversationEventIds: [evidence.event.id],
      idempotencyKey: 'm11-recovery-verify:counter-probe',
      processor: 'm11-recovery-verify',
      processorVersion: 'm11-recovery-verify@1',
      scope: 'CHARACTER_INTERNAL',
    },
    M4_T0 + 400
  )
  const beforeEvents = (await domainEventsFor(db, characterId)).length
  const lateFence = createLateWriteFence()
  const lateWrite = await withLateWriteFence({
    fence: lateFence,
    produce: async () => {
      // "provider 晚返回"：结果**已经**产生了
      lateFence.close() // 关库发生在结果回来**之后**
      return { counterDelta: 1 }
    },
    commit: async (payload) => {
      await appendDomainEvent(
        db,
        characterId,
        {
          type: DIAGNOSTIC_SIGNAL,
          operation: 'late-write-probe',
          payload,
          sourceConversationEventIds: [evidence.event.id],
          idempotencyKey: `m11-recovery-verify:late-write:${String(beforeEvents)}`,
          processor: 'm11-recovery-verify',
          processorVersion: 'm11-recovery-verify@1',
          scope: 'CHARACTER_INTERNAL',
        },
        M4_T0 + 500
      )
      return 'committed'
    },
  })
  const afterEvents = (await domainEventsFor(db, characterId)).length
  record(
    'C3',
    'C',
    '【零写入·真实库】结果在关闭**之后**才回来 ⇒ commit 被挡下，账本事件数**一个都没变**（`D17`）',
    lateWrite.ok === false &&
      lateWrite.reason === 'late_write_fenced' &&
      afterEvents === beforeEvents &&
      beforeEvents > 0 &&
      lateFence.refusedCount === 1,
    `结果=${lateWrite.ok ? 'committed' : lateWrite.reason} · 事件数 ${String(beforeEvents)} → ${String(afterEvents)}（分母非零=${String(beforeEvents > 0)}）`
  )

  // -------------------------------------------------------------------------
  // D 组 —— 结构判据
  // -------------------------------------------------------------------------
  const schedulerSrc = readFileSync(
    join(REPO_ROOT, 'src/infrastructure/runtime/reflection-scheduler.ts'),
    'utf8'
  )
  const stripped = schedulerSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  record(
    'D1',
    'D',
    '【结构·不楔死】调度器里**真的**调了 `finishJob(…, \'failed\')`（注释不算）',
    stripped.includes("finishJob(tx, jobId, 'failed'") && stripped.includes('writeWhileOpen(db, input.fence'),
    `事务内failed=${String(stripped.includes("finishJob(tx, jobId, 'failed'"))} · close保护=${String(stripped.includes('writeWhileOpen(db, input.fence'))}`
  )
  record(
    'D2',
    'D',
    '【结构·单一时钟源】调度器**不**自己 `setTimeout` / `setInterval`（不是第二套后台服务）',
    !stripped.includes('setTimeout') && !stripped.includes('setInterval'),
    `setTimeout=${String(stripped.includes('setTimeout'))} · setInterval=${String(stripped.includes('setInterval'))}`
  )
  const businessEvents = (await domainEventsFor(db, characterId)).filter((event) =>
    String(event.type).startsWith('REFLECTION_')
  ).length
  record(
    'D3',
    'D',
    '【不写业务事件】调度本身**不产生**反思事件（它只登记任务、跑窗口、推水位）',
    businessEvents === 0,
    `反思事件=${String(businessEvents)}`
  )

  // -------------------------------------------------------------------------
  // S 组 —— 量具自检
  // -------------------------------------------------------------------------
  const byGroup = { A: 0, B: 0, C: 0, D: 0 }
  for (const c of checks) if (c.group !== 'S') byGroup[c.group] += 1
  record(
    'S1',
    'S',
    '四组都测到**非零**条目',
    Object.values(byGroup).every((count) => count > 0),
    Object.entries(byGroup).map(([group, count]) => `${group}=${String(count)}`).join(' · ')
  )

  // -------------------------------------------------------------------------
  // 落盘
  // -------------------------------------------------------------------------
  const failedChecks = checks.filter((c) => !c.pass)
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  const runId =
    out === undefined ? createM11RunId({ wpId: 'wp7', headShort: head }) : runIdFromM11OutPath(REPO_ROOT, out)
  const dir = openM11RunDir(REPO_ROOT, runId)

  const payload = {
    schema: 'm11-recovery-verify@1',
    manifestVersion: M11_MANIFEST_VERSION,
    runId,
    head,
    databaseScope: 'isolated-sandbox',
    modelCalls: 0,
    measuredCount: checks.length,
    checks,
    summary: { total: checks.length, passed: checks.length - failedChecks.length, failed: failedChecks.length },
    verdict: failedChecks.length === 0 ? 'PASS' : 'FAIL',
  }
  writeFileSync(join(dir, 'recovery-verify.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  writeM11Manifest(dir, {
    runId,
    wp: 'wp7',
    head,
    headShort: head.slice(0, 12),
    branch: 'codex/m11-execution-plan',
    date: new Date().toISOString().slice(0, 10),
    toolVersions: { node: process.version },
    testType: 'recovery',
    counts: { total: checks.length, passed: checks.length - failedChecks.length, failed: failedChecks.length },
    phases: ['single'],
    supersedes: null,
    notes: 'm11:recovery:verify（窗口/水位/失败恢复/晚写闸门；零模型调用）',
  })

  console.log(`runId: ${runId}`)
  for (const c of checks) console.log(`  ${c.pass ? '✅' : '❌'} ${c.id} ${c.label} —— ${c.detail}`)
  console.log(`verdict: ${failedChecks.length === 0 ? 'PASS' : 'FAIL'}（${String(checks.length - failedChecks.length)}/${String(checks.length)}）`)
  process.exit(failedChecks.length === 0 ? 0 : 1)
}

main().catch((error: unknown) => {
  console.error('m11:recovery:verify 抛错（不是被拒，是执行器坏了）：', error)
  process.exit(1)
})
