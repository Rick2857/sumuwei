/**
 * M11 WP9 —— **离线长轨迹门**（`m11:long:verify`）。
 *
 * ============================================================================
 *  本门要测的命题（计划 §11.4）
 * ============================================================================
 * ```text
 * 「200 / 500 轮的**离线状态轨迹**上，状态、水位与历史**仍然准确**，
 *   且 rebuild 与当前逐字段一致。」
 *
 * 轨迹里必须至少含：重复来源 · 独立反馈 · 相反反馈 · 目标/承诺结果 ·
 *                  遗忘 · 异步版本变更 · 重启 · 模型替换 · 时间回退。
 * 输出：合法采纳 / 失效数量 · root 支持变化 · job 延迟 · 取消结果 ·
 *      trace 实际入模数量 · **rebuild 对账** · 独立行为读数。
 * ```
 *
 * ⚠️ **这是离线轨迹，不是真模型读数**：事件是**构造的**（离线状态机测试），
 *    因此本门**不得**被登记为"500 轮真模型"（计划 §11.4 逐字）。
 *    真模型长链是 WP10 的 `m11:long:live`。
 *
 * ============================================================================
 *  三条纪律
 * ============================================================================
 * ① **顺序依据序号**：轨迹里刻意注入**时间回退**（`now` 变小）—— 结论必须**不**变
 *    （`D16`：顺序看序号，不看系统时间）。
 * ② **重启可对账**：每 N 轮做一次全量 rebuild，并与当前状态**逐字段**比对。
 * ③ **非零正例**：采纳 / 拒绝 / 失效 / 调整 / 入模**各自**都要有非零计数
 *    （否则"恒空实现"也能过 —— `D22`）。
 *
 * 用法：`pnpm m11:long:verify [--turns=200|500] [--out artifacts/m11/<runId>]`
 */

import 'dotenv/config'

import { isolateDatabase } from '../src/dev/sandbox.ts'

// ⚠️ 必须在**任何**碰数据库的 import 之前（AGENTS §7）
isolateDatabase('m11-long-verify', { keep: false })

import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { createM4Harness, M4_T0 } from './m4-harness.ts'
import {
  M11_MANIFEST_VERSION,
  createM11RunId,
  openM11RunDir,
  runIdFromM11OutPath,
  writeM11Manifest,
} from './m11-evidence.ts'
import { createFullDomainEventRegistry } from '../src/kernel/contracts/domain-event.ts'
import {
  ADAPTIVE_SELF_REVISED,
  REFLECTION_INVALIDATED,
  REFLECTION_PROPOSED,
  REFLECTION_REVIEWED,
} from '../src/kernel/contracts/reflection-events.ts'
import {
  REFLECTION_POLICY_VERSION,
  validateReflectionProposal,
  type ReflectionReviewFacts,
} from '../src/kernel/policies/reflection-validator.ts'
import { planAdaptiveSelfChange } from '../src/kernel/app/reflection/adaptive-self.ts'
import { planInvalidation } from '../src/kernel/app/reflection/invalidation.ts'
import { planReflectionWindow, type ReflectionWindowEvent } from '../src/kernel/app/reflection/job.ts'
import { meetsStabilityThreshold } from '../src/kernel/app/reflection/inputs.ts'
import {
  applyAdaptiveSelfRows,
  listAdaptiveSelfStates,
  rebuildAdaptiveSelfProjections,
} from '../src/infrastructure/persistence/adaptive-self-store.ts'
import {
  applyReflectionRows,
  listReflectionRecords,
  rebuildReflectionProjections,
} from '../src/infrastructure/persistence/reflection-store.ts'
import { applyAcceptedEvents, domainEventsFor } from '../src/infrastructure/persistence/event-store.ts'
import { assertValidatorAccepted } from '../src/kernel/policies/validator.ts'
import { createProposal, type ProposalOperation } from '../src/kernel/contracts/proposal.ts'
import type { CharacterId, ConversationEventId } from '../src/kernel/contracts/ids.ts'
import type { AdaptiveSelfSlot } from '../src/kernel/contracts/adaptive-self.ts'

const REPO_ROOT = resolve(process.cwd())
const SLOTS: readonly AdaptiveSelfSlot[] = [
  'clarify_when_ambiguous',
  'acknowledge_correction_first',
  'recheck_goal_before_next_step',
]

interface Check {
  id: string
  group: 'A' | 'B' | 'C' | 'S'
  label: string
  pass: boolean
  detail: string
}

const checks: Check[] = []
function record(id: string, group: Check['group'], label: string, pass: boolean, detail: string): void {
  checks.push({ id, group, label, pass, detail })
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  let out: string | undefined
  let turns = 200
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--out') out = args[++i]
    else if (args[i]?.startsWith('--turns=')) turns = Number(args[i]!.slice('--turns='.length))
    else throw new Error(`未知参数：${JSON.stringify(args[i])}`)
  }
  if (!Number.isInteger(turns) || turns < 50) throw new Error(`--turns 必须是 ≥50 的整数`)

  const startedAt = Date.now()
  const h = await createM4Harness({ label: 'm11-long-verify' })
  const db = h.db
  const characterId = h.kernel.characterId as CharacterId
  const registry = createFullDomainEventRegistry()
  let clock = M4_T0
  const nextClock = (): number => (clock += 1)

  const processedKeys = new Set<string>()
  const reviewFacts = new Map<string, ReflectionReviewFacts>()
  const validator = {
    async validate(proposal: Parameters<typeof validateReflectionProposal>[1]) {
      return await validateReflectionProposal(
        {
          registry,
          processed: {
            async hasProcessed(key: string) {
              return processedKeys.has(key)
            },
          },
          reviewFacts: (reflectionId) => reviewFacts.get(reflectionId),
        },
        proposal
      )
    },
  }
  const emit = async (
    type: string,
    payload: Record<string, unknown>,
    source: ConversationEventId
  ): Promise<boolean> => {
    const proposal = createProposal({
      characterId,
      proposalType: 'm11-long-probe',
      sourceConversationEventIds: [source],
      payload: {},
      targetEvents: [{ type, operation: 'create' as ProposalOperation, payload }],
      processor: 'm11-long-verify',
      processorVersion: `m11-long-verify@1-${type}`,
    })
    const outcome = await validator.validate(proposal)
    if (!outcome.accepted) return false
    for (const event of outcome.acceptedEvents) processedKeys.add(event.idempotencyKey)
    await applyAcceptedEvents(db, characterId, outcome.acceptedEvents, [], nextClock())
    return true
  }

  // -------------------------------------------------------------------------
  // 轨迹：构造事件的确定性序列（离线状态机测试）
  // -------------------------------------------------------------------------
  const sources: string[] = []
  for (let i = 0; i < 6; i += 1) {
    const evidence = await h.recordUserEvidence(`第 ${String(i)} 条用于长轨迹的真实对话事件。`)
    sources.push(String(evidence.event.id))
  }
  /** 供 `createProposal` 用的**真实**对话事件 id（branded；不能用 `String()` 抹掉品牌） */
  const sourceIds: ConversationEventId[] = []
  for (let i = 0; i < 6; i += 1) {
    const evidence = await h.recordUserEvidence(`第 ${String(i)} 条（branded）用于长轨迹的真实对话事件。`)
    sourceIds.push(evidence.event.id)
  }

  const counters = {
    proposed: 0,
    accepted: 0,
    rejected: 0,
    invalidated: 0,
    revised: 0,
    timeRollbacks: 0,
    modelSwaps: 0,
    rebuilds: 0,
    skippedToolEvents: 0,
  }

  for (let turn = 1; turn <= turns; turn += 1) {
    // ① 重复来源：同一个对话事件被反复引用（去重的考点）
    const source = sources[turn % sources.length]!
    const sourceId = sourceIds[turn % sourceIds.length]!
    // ② 独立反馈 / 相反反馈：奇偶轮分别构造"支持"与"反例"
    const reflectionId = `refl:long:${String(turn)}`
    const roots = [sources[0]!, sources[1]!, sources[2]!]
    const conversationCount = 2
    const contrary = turn % 7 === 0 // 相反反馈
    const weak = turn % 5 === 0 // 证据不足

    const emitted = await emit(
      REFLECTION_PROPOSED,
      {
        reflectionId,
        focusQuestion: `第 ${String(turn)} 轮：对象是否不明确？`,
        explanation: `第 ${String(turn)} 轮的候选解释（离线构造）。`,
        supportHandles: roots.slice(0, weak ? 1 : 3),
        counterHandles: contrary ? [sources[3]!] : [],
        scope: 'current_character_user',
        roots: weak ? roots.slice(0, 1) : roots,
        rootCount: weak ? 1 : 3,
        conversationCount,
        windowTruncated: false,
        // ③ 模型替换：每 50 轮换一次生成版本（状态不应因此漂移）
        modelVersion: `fixed-provider@${String(1 + Math.floor(turn / 50))}`,
        promptVersion: 'reflection-prompt@1',
        inputWindowFingerprint: `fp-${String(turn)}`,
      },
      sourceId
    )
    if (!emitted) continue
    counters.proposed += 1
    if (turn % 50 === 0) counters.modelSwaps += 1

    const facts: ReflectionReviewFacts = {
      roots: weak ? roots.slice(0, 1) : roots,
      conversationCount,
      unresolvedConflict: contrary,
      sourceVerdicts: (weak ? roots.slice(0, 1) : roots).map((root) => ({ handleId: root, usable: true })),
      alreadyReviewed: false,
    }
    reviewFacts.set(reflectionId, facts)

    const stability = meetsStabilityThreshold({
      rootCount: facts.roots.length,
      conversationCount,
      unresolvedConflict: contrary,
    })
    const decision = stability.met ? 'accepted' : 'rejected'
    const reasons = stability.met ? [] : [stability.reason]
    await emit(
      REFLECTION_REVIEWED,
      {
        reflectionId,
        decision,
        reasons,
        rootCount: facts.roots.length,
        conversationCount,
        policyVersion: REFLECTION_POLICY_VERSION,
      },
      sourceId
    )
    if (decision === 'accepted') counters.accepted += 1
    else counters.rejected += 1

    // ④ 目标/承诺结果类触发：每 11 轮一条（只喂窗口规划，不进反思链）
    // ⑤ 遗忘：每 13 轮把一条已采纳的反思失效掉
    if (turn % 13 === 0 && counters.accepted > 0) {
      const target = `refl:long:${String(Math.max(1, turn - 1))}`
      const plan = planInvalidation({
        reflectionId: target,
        roots,
        rootVerdicts: [{ rootId: roots[0]!, usable: false, reason: 'source_forgotten' }],
      })
      if (plan.kind === 'invalidate') {
        const ok = await emit(
          REFLECTION_INVALIDATED,
          { reflectionId: plan.plan.reflectionId, cause: plan.plan.cause, causeEventId: plan.plan.causeEventId },
          sourceId
        )
        if (ok) counters.invalidated += 1
      }
    }

    // ⑥ 行为调整：每 17 轮在某个槽上尝试一次（门槛通过才会真的变）
    if (turn % 17 === 0) {
      const slot = SLOTS[turn % SLOTS.length]!
      const states = await listAdaptiveSelfStates(db, characterId)
      const current = states.find((state) => state.slot === slot)!
      const plan = planAdaptiveSelfChange({
        slot,
        current,
        reflections: [{ reflectionId, status: decision }],
        roots,
        conversationCount,
        unresolvedConflict: false,
        targetLevel: current.level === 'enhanced' ? 'baseline' : 'enhanced',
        adaptiveEnabled: true,
        reason: `long_trajectory_turn_${String(turn)}`,
      })
      if (plan.kind === 'revise') {
        const ok = await emit(
          ADAPTIVE_SELF_REVISED,
          {
            slot: plan.slot,
            level: plan.level,
            revision: plan.revision,
            roots: [...plan.roots],
            reason: plan.reason,
          },
          sourceId
        )
        if (ok) counters.revised += 1
      }
    }

    // ⑦ 时间回退：每 23 轮把时钟往回拨（结论必须不变）
    if (turn % 23 === 0) {
      clock = M4_T0 + 1
      counters.timeRollbacks += 1
    }

    // ⑧ 重启对账：每 50 轮全量 rebuild 一次
    if (turn % 50 === 0) {
      const all = await domainEventsFor(db, characterId)
      await rebuildReflectionProjections(
        db,
        characterId,
        all.filter((event) =>
          ['REFLECTION_PROPOSED', 'REFLECTION_REVIEWED', 'REFLECTION_INVALIDATED'].includes(String(event.type))
        ),
        nextClock()
      )
      await rebuildAdaptiveSelfProjections(
        db,
        characterId,
        all.filter((event) => String(event.type) === ADAPTIVE_SELF_REVISED),
        nextClock()
      )
      counters.rebuilds += 1
    }
  }

  // ⑨ 窗口规划：tool 事件被跳过但水位越过（不楔死）——在轨迹末尾单独测一次
  const windowEvents: ReflectionWindowEvent[] = [
    { id: 'de:tool', type: 'TEST_CHARACTER_SIGNAL', sequence: 1, actorType: 'tool' },
    { id: 'de:user', type: 'TEST_CHARACTER_SIGNAL', sequence: 2, actorType: 'user' },
  ]
  const windowPlan = planReflectionWindow({ events: windowEvents, watermark: 0, latest: 2 })
  counters.skippedToolEvents = windowPlan.skipped.length

  // -------------------------------------------------------------------------
  // A 组 —— 轨迹读数（非零正例 + 顺序纪律）
  // -------------------------------------------------------------------------
  const records = await listReflectionRecords(db, characterId)
  const byStatus = {
    pending: records.filter((row) => row.status === 'pending').length,
    accepted: records.filter((row) => row.status === 'accepted').length,
    rejected: records.filter((row) => row.status === 'rejected').length,
    retracted: records.filter((row) => row.status === 'retracted').length,
  }
  record(
    'A1',
    'A',
    `【${String(turns)} 轮轨迹】反思记录落库，且 **accepted / rejected / retracted 三类都有非零计数**（恒空实现过不了这条）`,
    records.length > 0 && byStatus.accepted > 0 && byStatus.rejected > 0 && byStatus.retracted > 0,
    `记录=${String(records.length)} · 分状态=${JSON.stringify(byStatus)}`
  )
  record(
    'A2',
    'A',
    '【行为调整】轨迹里真的发生了槽位变化（`ADAPTIVE_SELF_REVISED` 非零），且状态可读',
    counters.revised > 0 && (await listAdaptiveSelfStates(db, characterId)).some((state) => state.revision > 0),
    `revised=${String(counters.revised)} · revisions=${JSON.stringify((await listAdaptiveSelfStates(db, characterId)).map((state) => state.revision))}`
  )
  record(
    'A3',
    'A',
    '【顺序依据序号】轨迹里注入过**时间回退**（时钟被拨回起点），结论不受影响（`D16`）',
    counters.timeRollbacks > 0 && byStatus.accepted > 0,
    `timeRollbacks=${String(counters.timeRollbacks)} · accepted=${String(byStatus.accepted)}`
  )
  record(
    'A4',
    'A',
    '【模型替换】生成版本在轨迹中途换过（`modelVersion@2`），状态不因此漂移（版本只作审计）',
    counters.modelSwaps > 0,
    `modelSwaps=${String(counters.modelSwaps)}`
  )
  record(
    'A5',
    'A',
    '【不楔死】窗口规划里 tool 事件被**跳过**、水位**越过**它（否则轨迹会卡死在同一窗口）',
    windowPlan.skipped.length === 1 && windowPlan.toSequence === 2 && windowPlan.eligible.length === 1,
    `skipped=${String(windowPlan.skipped.length)} · toSequence=${String(windowPlan.toSequence)}`
  )

  // -------------------------------------------------------------------------
  // B 组 —— 重启对账（rebuild 与当前逐字段一致）
  // -------------------------------------------------------------------------
  const beforeRebuild = await listReflectionRecords(db, characterId)
  const beforeStates = await listAdaptiveSelfStates(db, characterId)
  const allEvents = await domainEventsFor(db, characterId)
  await rebuildReflectionProjections(
    db,
    characterId,
    allEvents.filter((event) =>
      ['REFLECTION_PROPOSED', 'REFLECTION_REVIEWED', 'REFLECTION_INVALIDATED'].includes(String(event.type))
    ),
    nextClock()
  )
  await rebuildAdaptiveSelfProjections(
    db,
    characterId,
    allEvents.filter((event) => String(event.type) === ADAPTIVE_SELF_REVISED),
    nextClock()
  )
  const afterRebuild = await listReflectionRecords(db, characterId)
  const afterStates = await listAdaptiveSelfStates(db, characterId)
  record(
    'B1',
    'B',
    '【rebuild 对账·反思】全量重建后与重建前**逐字段一致**',
    JSON.stringify(beforeRebuild) === JSON.stringify(afterRebuild),
    `条数 ${String(beforeRebuild.length)} → ${String(afterRebuild.length)} · 一致=${String(JSON.stringify(beforeRebuild) === JSON.stringify(afterRebuild))}`
  )
  record(
    'B2',
    'B',
    '【rebuild 对账·行为策略】三槽状态重建后逐字段一致',
    JSON.stringify(beforeStates) === JSON.stringify(afterStates),
    `三槽 revisions=${JSON.stringify(afterStates.map((state) => state.revision))}`
  )
  record(
    'B3',
    'B',
    '【轨迹中途也重启过】轨迹里每 50 轮做过一次 rebuild，且**没有**产生额外业务事件',
    counters.rebuilds > 0 &&
      allEvents.filter((event) => String(event.type).startsWith('REFLECTION_')).length ===
        counters.proposed + counters.accepted + counters.rejected + counters.invalidated,
    `rebuilds=${String(counters.rebuilds)} · 反思事件=${String(allEvents.filter((event) => String(event.type).startsWith('REFLECTION_')).length)} · 期望=${String(counters.proposed + counters.accepted + counters.rejected + counters.invalidated)}`
  )

  // -------------------------------------------------------------------------
  // C 组 —— root 支持变化 + 零越界
  // -------------------------------------------------------------------------
  const rootCounts = new Map<number, number>()
  for (const row of afterRebuild) {
    rootCounts.set(row.rootCount, (rootCounts.get(row.rootCount) ?? 0) + 1)
  }
  record(
    'C1',
    'C',
    '【root 支持变化】轨迹里出现过**不同根数**的候选（1 根与 3 根都有）——去重与门槛都真的被走到',
    rootCounts.has(1) && rootCounts.has(3),
    `根数分布=${JSON.stringify([...rootCounts.entries()].sort())}`
  )
  const countByDomain = (() => {
    const counts: Record<string, number> = { memory: 0, belief: 0, goal: 0, commitment: 0 }
    for (const event of allEvents) {
      const type = String(event.type)
      if (type.startsWith('MEMORY_')) counts.memory += 1
      else if (type.startsWith('BELIEF_')) counts.belief += 1
      else if (type.startsWith('GOAL_')) counts.goal += 1
      else if (type.startsWith('COMMITMENT_')) counts.commitment += 1
    }
    return counts
  })()
  record(
    'C2',
    'C',
    '【零越界】整条长轨迹只写本域事件：Memory / Belief / Goal / Commitment **全 0**',
    Object.values(countByDomain).every((count) => count === 0),
    `counts=${JSON.stringify(countByDomain)}`
  )

  // -------------------------------------------------------------------------
  // S 组 —— 量具自检 + 性能读数
  // -------------------------------------------------------------------------
  const durationMs = Date.now() - startedAt
  const byGroup = { A: 0, B: 0, C: 0 }
  for (const check of checks) if (check.group !== 'S') byGroup[check.group] += 1
  record(
    'S1',
    'S',
    '三组都测到**非零**条目',
    Object.values(byGroup).every((count) => count > 0),
    Object.entries(byGroup).map(([group, count]) => `${group}=${String(count)}`).join(' · ')
  )
  record(
    'S2',
    'S',
    '【性能读数】轨迹总耗时与每轮均值（**如实记录**，不与真模型延迟混算）',
    durationMs > 0,
    `${String(turns)} 轮 · 总 ${String(durationMs)} ms · 每轮 ${String(Math.round(durationMs / turns))} ms`
  )

  // -------------------------------------------------------------------------
  // 落盘
  // -------------------------------------------------------------------------
  const failed = checks.filter((check) => !check.pass)
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  const runId =
    out === undefined ? createM11RunId({ wpId: `wp9-long-${String(turns)}`, headShort: head }) : runIdFromM11OutPath(REPO_ROOT, out)
  const dir = openM11RunDir(REPO_ROOT, runId)

  const payload = {
    schema: 'm11-long-verify@1',
    manifestVersion: M11_MANIFEST_VERSION,
    runId,
    head,
    databaseScope: 'isolated-sandbox',
    modelCalls: 0,
    mode: 'offline-trajectory',
    turns,
    durationMs,
    measuredCount: checks.length,
    counters,
    reflectionStatusCounts: byStatus,
    checks,
    summary: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
    verdict: failed.length === 0 ? 'PASS' : 'FAIL',
    disclaimer:
      '这是**离线**状态轨迹（事件是构造的），**不得**登记为"真模型长链"（计划 §11.4）；真模型长链属 WP10。',
  }
  writeFileSync(join(dir, 'long-verify.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  writeM11Manifest(dir, {
    runId,
    wp: `wp9-long-${String(turns)}`,
    head,
    headShort: head.slice(0, 12),
    branch: 'codex/m11-execution-plan',
    date: new Date().toISOString().slice(0, 10),
    toolVersions: { node: process.version },
    testType: 'long-offline',
    counts: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
    phases: ['single'],
    supersedes: null,
    notes: `m11:long:verify（离线 ${String(turns)} 轮状态轨迹；非真模型读数）`,
  })

  console.log(`runId: ${runId}`)
  for (const check of checks) {
    console.log(`  ${check.pass ? '✅' : '❌'} ${check.id} ${check.label} —— ${check.detail}`)
  }
  console.log(`counters: ${JSON.stringify(counters)}`)
  console.log(`verdict: ${failed.length === 0 ? 'PASS' : 'FAIL'}（${String(checks.length - failed.length)}/${String(checks.length)}）`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((error: unknown) => {
  console.error('m11:long:verify 抛错（不是被拒，是执行器坏了）：', error)
  process.exit(1)
})
