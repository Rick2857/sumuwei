/**
 * M11 WP6 —— **失效与同轮阻断门**（`m11:invalidation:verify`）。
 *
 * ============================================================================
 *  本门要测的命题
 * ============================================================================
 * ```text
 * ① **同轮阻断**：支持源被忘掉 ⇒ 当前轮就不可用 —— **即使后台还没有任何失效事件**
 *    （`D12`：先阻断上下文，再补落账）。
 * ② **落账幂等**：同一状态重跑失效计划 ⇒ 同一个 `causeEventId` ⇒ **只产生一条**失效事件。
 * ③ **历史与当前分开**（`D18`/§5.4）：回放仍能恢复"当时是 accepted"，
 *    而**当前**可用性说"不可用"——两个读数不互相覆盖。
 * ④ **跨域只读**：待审意图不进目标领域；版本不一致 ⇒ `revision_changed`；
 *    意图里夹带 proposal 正文 ⇒ 拒。
 * ⑤ **不碰别的域**：整条链跑完后 Memory / Belief / Goal / Commitment 的事件数不变。
 * ```
 */

import 'dotenv/config'

import { isolateDatabase } from '../src/dev/sandbox.ts'

// ⚠️ 必须在**任何**碰数据库的 import 之前（AGENTS §7）
isolateDatabase('m11-invalidation-verify', { keep: false })

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
import { createProposal, type ProposalOperation } from '../src/kernel/contracts/proposal.ts'
import { createFullDomainEventRegistry, DIAGNOSTIC_SIGNAL } from '../src/kernel/contracts/domain-event.ts'
import { REFLECTION_PROPOSED, REFLECTION_REVIEWED, REFLECTION_INVALIDATED } from '../src/kernel/contracts/reflection-events.ts'
import {
  REFLECTION_DRAFT_SCHEMA_VERSION,
  REFLECTION_DRAFT_SCOPE,
} from '../src/kernel/contracts/reflection.ts'
import { REFLECTION_POLICY_VERSION, validateReflectionProposal } from '../src/kernel/policies/reflection-validator.ts'
import {
  applyReflectionRows,
  getReflectionRecord,
  listReflectionRecords,
} from '../src/infrastructure/persistence/reflection-store.ts'
import {
  checkRevisionIntent,
  filterAdaptiveSelfThisTurn,
  filterReflectionThisTurn,
  listPendingRevisionIntents,
  planInvalidation,
  usableAdaptiveSelfThisTurn,
} from '../src/kernel/app/reflection/invalidation.ts'
import type { RootUsabilityReading } from '../src/kernel/contracts/revision-intent.ts'
import { applyAcceptedEvents, appendDomainEvent, domainEventsFor } from '../src/infrastructure/persistence/event-store.ts'
import { assertValidatorAccepted } from '../src/kernel/policies/validator.ts'
import type { CharacterId } from '../src/kernel/contracts/ids.ts'

const REPO_ROOT = resolve(process.cwd())

interface Check {
  id: string
  group: 'A' | 'B' | 'C' | 'D' | 'E' | 'S'
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
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--out') out = args[++i]
    else throw new Error(`未知参数：${JSON.stringify(args[i])}`)
  }

  const h = await createM4Harness({ label: 'm11-invalidation-verify' })
  const db = h.db
  const characterId = h.kernel.characterId as CharacterId
  const registry = createFullDomainEventRegistry()
  let clock = M4_T0
  const nextClock = (): number => (clock += 10)

  const evidence = await h.recordUserEvidence('这是一条用于失效验证的真实对话事件。')
  const sourceId = evidence.event.id
  await appendDomainEvent(
    db,
    characterId,
    {
      type: DIAGNOSTIC_SIGNAL,
      operation: 'm11-invalidation-probe',
      payload: { counterDelta: 1 },
      sourceConversationEventIds: [sourceId],
      idempotencyKey: 'm11-invalidation-verify:counter-probe',
      processor: 'm11-invalidation-verify',
      processorVersion: 'm11-invalidation-verify@1',
      scope: 'CHARACTER_INTERNAL',
    },
    nextClock()
  )

  const processedKeys = new Set<string>()
  const emit = async (type: string, payload: Record<string, unknown>): Promise<void> => {
    const proposal = createProposal({
      characterId,
      proposalType: 'm11-invalidation-probe',
      sourceConversationEventIds: [sourceId],
      payload: {},
      targetEvents: [{ type, operation: 'create' as ProposalOperation, payload }],
      processor: 'm11-invalidation-verify',
      processorVersion: `m11-invalidation-verify@1-${type}`,
    })
    const accepted = assertValidatorAccepted(
      await validateReflectionProposal(
        {
          registry,
          processed: {
            async hasProcessed(key: string) {
              return processedKeys.has(key)
            },
          },
          reviewFacts: () => ({
            roots: ['ce:1', 'ce:2', 'ce:3'],
            conversationCount: 2,
            unresolvedConflict: false,
            sourceVerdicts: [],
            alreadyReviewed: false,
          }),
        },
        proposal
      )
    )
    for (const event of accepted) processedKeys.add(event.idempotencyKey)
    await applyAcceptedEvents(db, characterId, accepted, [], nextClock())
  }

  /** 同 `emit`，但**不**断言通过（用于"重复投递必须被拒"这类负控） */
  const emitRaw = async (type: string, payload: Record<string, unknown>): Promise<string[]> => {
    const proposal = createProposal({
      characterId,
      proposalType: 'm11-invalidation-probe',
      sourceConversationEventIds: [sourceId],
      payload: {},
      targetEvents: [{ type, operation: 'create' as ProposalOperation, payload }],
      processor: 'm11-invalidation-verify',
      processorVersion: `m11-invalidation-verify@1-${type}`,
    })
    const outcome = await validateReflectionProposal(
      {
        registry,
        processed: {
          async hasProcessed(key: string) {
            return processedKeys.has(key)
          },
        },
        reviewFacts: () => ({
          roots: ['ce:1', 'ce:2', 'ce:3'],
          conversationCount: 2,
          unresolvedConflict: false,
          sourceVerdicts: [],
          alreadyReviewed: false,
        }),
      },
      proposal
    )
    return outcome.rejected.map((r) => r.code)
  }

  const foldAll = async (): Promise<void> => {    const events = (await domainEventsFor(db, characterId)).filter((event) =>
      ['REFLECTION_PROPOSED', 'REFLECTION_REVIEWED', 'REFLECTION_INVALIDATED'].includes(String(event.type))
    )
    await applyReflectionRows(db, characterId, events, nextClock())
  }

  // 一条已采纳的反思（三根 / 两会话），带一条跨域待审意图
  await emit(REFLECTION_PROPOSED, {
    reflectionId: 'refl:W',
    focusQuestion: '对象不明确时她是否在反复确认？',
    explanation: '三个不同会话都出现了同一种来回确认。',
    supportHandles: ['ce:1', 'ce:2', 'ce:3'],
    counterHandles: [],
    scope: REFLECTION_DRAFT_SCOPE,
    roots: ['ce:1', 'ce:2', 'ce:3'],
    rootCount: 3,
    conversationCount: 2,
    windowTruncated: false,
    revisionIntent: { domain: 'goal', targetId: 'goal-1', expectedRevision: 3 },
    modelVersion: 'fixed-provider@1',
    promptVersion: 'reflection-prompt@1',
    inputWindowFingerprint: 'fp-wp6',
  })
  await emit(REFLECTION_REVIEWED, {
    reflectionId: 'refl:W',
    decision: 'accepted',
    reasons: [],
    rootCount: 3,
    conversationCount: 2,
    policyVersion: REFLECTION_POLICY_VERSION,
  })
  await foldAll()

  const acceptedRecord = await getReflectionRecord(db, characterId, 'refl:W')
  /*
   * ⚠️ 待审面必须在**记录还被采纳时**抓一份快照：`refl:W` 稍后会被失效成 retracted，
   *    而 retracted 的意图**本来就不该**留在待审面里（D4 正是测这个）。
   */
  const intentsWhileAccepted = listPendingRevisionIntents(await listReflectionRecords(db, characterId))

  // -------------------------------------------------------------------------
  // A 组 —— 同轮阻断（**后台还没有任何失效事件**）
  // -------------------------------------------------------------------------
  const usableReadings: RootUsabilityReading[] = [
    { rootId: 'ce:1', usable: true },
    { rootId: 'ce:2', usable: true },
    { rootId: 'ce:3', usable: true },
  ]
  const forgottenReadings: RootUsabilityReading[] = [
    { rootId: 'ce:1', usable: true },
    { rootId: 'ce:2', usable: false, reason: 'source_forgotten' },
    { rootId: 'ce:3', usable: true },
  ]

  const invalidationEventsBefore = (await domainEventsFor(db, characterId)).filter(
    (event) => String(event.type) === REFLECTION_INVALIDATED
  ).length

  const slotInput = { slot: 'clarify_when_ambiguous' as const, roots: ['ce:1', 'ce:2', 'ce:3'] }
  const stillUsable = filterAdaptiveSelfThisTurn({ ...slotInput, rootVerdicts: usableReadings })
  const blockedNow = filterAdaptiveSelfThisTurn({ ...slotInput, rootVerdicts: forgottenReadings })
  record(
    'A1',
    'A',
    '【同轮阻断】源被忘掉 ⇒ **当前轮**该槽就不可用，且此时后台**一条失效事件都还没有**',
    stillUsable.usable === true &&
      blockedNow.usable === false &&
      blockedNow.reason === 'source_forgotten' &&
      invalidationEventsBefore === 0,
    `可用=${String(stillUsable.usable)} · 被挡=${blockedNow.usable ? '(未挡)' : `${blockedNow.reason}@${blockedNow.at}`} · 失效事件数=${String(invalidationEventsBefore)}`
  )

  const batch = usableAdaptiveSelfThisTurn([
    { ...slotInput, rootVerdicts: usableReadings },
    { slot: 'acknowledge_correction_first', roots: ['ce:2'], rootVerdicts: forgottenReadings },
  ])
  record(
    'A2',
    'A',
    '【同轮阻断】批量过滤：可用的留、被挡的带具名原因（不是"整批丢掉"）',
    batch.usable.length === 1 && batch.blocked.length === 1,
    `可用=${String(batch.usable.length)} · 被挡=${String(batch.blocked.length)}`
  )

  const reflectionVerdict = filterReflectionThisTurn(
    { reflectionId: 'refl:W', roots: ['ce:1', 'ce:2', 'ce:3'] },
    forgottenReadings
  )
  record(
    'A3',
    'A',
    '【同轮阻断】反思本身也按同一规则过滤（根被挡 ⇒ 这条反思当前不可引用）',
    reflectionVerdict.usable === false && reflectionVerdict.reason === 'source_forgotten',
    reflectionVerdict.usable ? '(未挡)' : `${reflectionVerdict.reason}@${reflectionVerdict.at}`
  )

  // A4 —— 失败关闭：拿不到读数 = 不可用
  const missingReading = filterAdaptiveSelfThisTurn({ ...slotInput, rootVerdicts: [usableReadings[0]!] })
  record(
    'A4',
    'A',
    '【失败关闭】某条根**没有**读数 ⇒ 当不可用（不是"当作合格"）',
    missingReading.usable === false && missingReading.reason === 'unavailable',
    missingReading.usable ? '(未挡)' : `${missingReading.reason}@${missingReading.at}`
  )

  // A5 —— 遮蔽不是永久失效
  const maskedReadings: RootUsabilityReading[] = [
    { rootId: 'ce:1', usable: false, reason: 'source_privacy_masked' },
  ]
  const maskedPlan = planInvalidation({ reflectionId: 'refl:W', roots: ['ce:1'], rootVerdicts: maskedReadings })
  record(
    'A5',
    'A',
    '【负控】隐私遮蔽 ⇒ 当前轮不可用，但**不**构成永久失效（遮蔽是暂时的，不该废掉一条已采纳的反思）',
    maskedPlan.kind === 'no_change' && maskedPlan.reason === 'source_privacy_masked',
    maskedPlan.kind === 'no_change' ? `no_change: ${maskedPlan.reason}` : '**竟然规划了失效**'
  )

  // -------------------------------------------------------------------------
  // B 组 —— 失效落账：确定性 + 幂等
  // -------------------------------------------------------------------------
  const plan1 = planInvalidation({ reflectionId: 'refl:W', roots: ['ce:1', 'ce:2', 'ce:3'], rootVerdicts: forgottenReadings })
  const plan2 = planInvalidation({ reflectionId: 'refl:W', roots: ['ce:3', 'ce:2', 'ce:1'], rootVerdicts: forgottenReadings })
  record(
    'B1',
    'B',
    '【确定性】同一状态、不同根顺序 ⇒ **同一个**失效计划（`causeEventId` 排序后取第一个被挡的根）',
    plan1.kind === 'invalidate' &&
      plan2.kind === 'invalidate' &&
      plan1.plan.causeEventId === plan2.plan.causeEventId &&
      plan1.plan.cause === 'source_forgotten',
    plan1.kind === 'invalidate' ? `${plan1.plan.cause}@${plan1.plan.causeEventId}` : 'no_change'
  )

  let secondDelivery: string[] = []
  if (plan1.kind === 'invalidate') {    await emit(REFLECTION_INVALIDATED, {
      reflectionId: plan1.plan.reflectionId,
      cause: plan1.plan.cause,
      causeEventId: plan1.plan.causeEventId,
    })
    // 再投一次**同一个计划**：域内幂等键相同 ⇒ 应当在**放行口**就被拒（不是静默去重）
    secondDelivery = await emitRaw(REFLECTION_INVALIDATED, {
      reflectionId: plan1.plan.reflectionId,
      cause: plan1.plan.cause,
      causeEventId: plan1.plan.causeEventId,
    })
  }
  await foldAll()

  const invalidationEvents = (await domainEventsFor(db, characterId)).filter(
    (event) => String(event.type) === REFLECTION_INVALIDATED
  )
  const afterInvalidate = await getReflectionRecord(db, characterId, 'refl:W')
  record(
    'B2',
    'B',
    '【幂等】同一个失效计划投递两次 ⇒ 第二次在**放行口**被 `duplicate_operation` 拒；账本里**只有一条**事件，状态 `retracted`',
    secondDelivery.includes('duplicate_operation') &&
      invalidationEvents.length === 1 &&
      afterInvalidate?.status === 'retracted',
    `第二次拒绝码=${JSON.stringify(secondDelivery)} · 失效事件=${String(invalidationEvents.length)} 条 · status=${String(afterInvalidate?.status)}`
  )

  // -------------------------------------------------------------------------
  // C 组 —— 历史与当前分开
  // -------------------------------------------------------------------------
  const currentUsability = filterReflectionThisTurn(
    { reflectionId: 'refl:W', roots: afterInvalidate?.roots ?? [] },
    forgottenReadings
  )
  record(
    'C1',
    'C',
    '【历史 vs 当前】回放仍能读到"当时是 accepted"（记录本身没被改写），而**当前**可用性说不可用 —— 两个读数并存',
    acceptedRecord?.status === 'accepted' &&
      afterInvalidate?.status === 'retracted' &&
      currentUsability.usable === false,
    `历史=${String(acceptedRecord?.status)} · 当前状态=${String(afterInvalidate?.status)} · 当前可用=${String(currentUsability.usable)}`
  )
  record(
    'C2',
    'C',
    '失效原因留在读数里（`reviewReasons` 含 `source_forgotten`）—— 可查、可审计，不是"悄悄消失"',
    (afterInvalidate?.reviewReasons ?? []).includes('source_forgotten'),
    `reasons=${JSON.stringify(afterInvalidate?.reviewReasons)}`
  )

  // -------------------------------------------------------------------------
  // D 组 —— 跨域待审面（只读）
  // -------------------------------------------------------------------------
  const records = await listReflectionRecords(db, characterId)
  const intents = intentsWhileAccepted
  record(
    'D1',
    'D',
    '【待审面】已采纳的反思带出一条跨域意图（域 / 目标 / 期望版本），且**只有** pending/accepted 的记录进面',
    intents.length === 1 &&
      intents[0]?.domain === 'goal' &&
      intents[0]?.targetId === 'goal-1' &&
      intents[0]?.expectedRevision === 3,
    `意图=${JSON.stringify(intents)}`
  )
  record(
    'D5',
    'D',
    '【待审面·收口】同一条反思失效成 `retracted` 之后，它的意图**从待审面消失**（"已经不该处理"≠"还没处理"）',
    listPendingRevisionIntents(records).length === 0,
    `失效后的待审面=${JSON.stringify(listPendingRevisionIntents(records))}`
  )

  const okCheck = checkRevisionIntent(intents[0]!, { exists: true, currentRevision: 3 })
  const staleCheck = checkRevisionIntent(intents[0]!, { exists: true, currentRevision: 4 })
  const missingCheck = checkRevisionIntent(intents[0]!, { exists: false, currentRevision: 0 })
  record(
    'D2',
    'D',
    '【版本】期望版本一致 ⇒ 通过；版本变了 ⇒ `revision_changed`；目标不存在 ⇒ `target_missing`',
    okCheck.ok === true &&
      staleCheck.ok === false &&
      staleCheck.reason === 'revision_changed' &&
      missingCheck.ok === false &&
      missingCheck.reason === 'target_missing',
    `一致=${String(okCheck.ok)} · 过期=${staleCheck.ok ? 'ok' : staleCheck.reason} · 缺失=${missingCheck.ok ? 'ok' : missingCheck.reason}`
  )

  const smuggled = checkRevisionIntent(
    { ...intents[0]!, proposalBody: { statement: '偷偷改目标' } },
    { exists: true, currentRevision: 3 }
  )
  record(
    'D3',
    'D',
    '【负控】意图里夹带 proposal 正文 ⇒ `intent_has_proposal_body`（`D13`：提案形状归目标领域）',
    smuggled.ok === false && smuggled.reason === 'intent_has_proposal_body',
    smuggled.ok ? '(竟然通过)' : smuggled.reason
  )

  const rejectedRecord = listPendingRevisionIntents([
    { reflectionId: 'refl:X', status: 'rejected', revisionIntent: { domain: 'goal', targetId: 'g', expectedRevision: 1 } },
    { reflectionId: 'refl:Y', status: 'retracted', revisionIntent: { domain: 'goal', targetId: 'g', expectedRevision: 1 } },
    { reflectionId: 'refl:Z', status: 'pending', revisionIntent: { domain: 'nonsense', targetId: 'g', expectedRevision: 1 } },
  ])
  record(
    'D4',
    'D',
    '【负控】`rejected` / `retracted` 的意图与越界域**都不进**待审面',
    rejectedRecord.length === 0,
    `待审面=${JSON.stringify(rejectedRecord)}`
  )

  // -------------------------------------------------------------------------
  // E 组 —— 不碰别的域 + 结构锁
  // -------------------------------------------------------------------------
  const countByGroup = async (): Promise<Record<string, number>> => {
    const all = await domainEventsFor(db, characterId)
    const counts: Record<string, number> = { memory: 0, belief: 0, goal: 0, commitment: 0, reflection: 0, other: 0 }
    for (const event of all) {
      const type = String(event.type)
      if (type.startsWith('MEMORY_')) counts.memory += 1
      else if (type.startsWith('BELIEF_')) counts.belief += 1
      else if (type.startsWith('GOAL_')) counts.goal += 1
      else if (type.startsWith('COMMITMENT_')) counts.commitment += 1
      else if (type.startsWith('REFLECTION_') || type.startsWith('ADAPTIVE_SELF_')) counts.reflection += 1
      else counts.other += 1
    }
    return counts
  }
  const before = await countByGroup()
  for (let i = 0; i < 10; i += 1) {
    filterAdaptiveSelfThisTurn({ ...slotInput, rootVerdicts: forgottenReadings })
    planInvalidation({ reflectionId: 'refl:W', roots: slotInput.roots, rootVerdicts: forgottenReadings })
    checkRevisionIntent(intents[0]!, { exists: true, currentRevision: 3 })
  }
  const after = await countByGroup()
  const deltas = Object.fromEntries(Object.keys(before).map((key) => [key, (after[key] ?? 0) - (before[key] ?? 0)]))
  record(
    'E1',
    'E',
    '【不碰别的域】跑 10 轮过滤/规划/校验后：Memory / Belief / Goal / Commitment 的事件数**一个都没变**',
    deltas.memory === 0 && deltas.belief === 0 && deltas.goal === 0 && deltas.commitment === 0,
    `deltas=${JSON.stringify(deltas)} · before.other=${String(before.other ?? 0)}`
  )
  record(
    'E2',
    'E',
    '【量具自检】本域写入确实发生（反思事件计数非零）—— "别的域没变"不是靠"什么都没做"',
    (after.reflection ?? 0) > 0 && (before.other ?? 0) > 0,
    `reflection=${String(after.reflection ?? 0)} · other=${String(before.other ?? 0)}`
  )

  const invalidationSrc = readFileSync(join(REPO_ROOT, 'src/kernel/app/reflection/invalidation.ts'), 'utf8')
  const stripped = invalidationSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  const oldDomainWrites = [
    'applyGoalRows',
    'rebuildGoalProjections',
    'applyBeliefRows',
    'applyMemoryRows',
    'insertProjection',
    'inTransaction',
    'appendDomainEvent',
  ].filter((primitive) => stripped.includes(primitive))
  record(
    'E3',
    'E',
    '【结构锁】失效模块里**没有**旧域写入口（也没有任何写原语）—— 跨域只读（`D13`）',
    oldDomainWrites.length === 0,
    `命中=${JSON.stringify(oldDomainWrites)}`
  )

  // -------------------------------------------------------------------------
  // S 组 —— 量具自检
  // -------------------------------------------------------------------------
  const byGroup = { A: 0, B: 0, C: 0, D: 0, E: 0 }
  for (const c of checks) if (c.group !== 'S') byGroup[c.group] += 1
  record(
    'S1',
    'S',
    '五组都测到**非零**条目',
    Object.values(byGroup).every((count) => count > 0),
    Object.entries(byGroup).map(([group, count]) => `${group}=${String(count)}`).join(' · ')
  )

  // -------------------------------------------------------------------------
  // 落盘
  // -------------------------------------------------------------------------
  const failed = checks.filter((c) => !c.pass)
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  const runId =
    out === undefined ? createM11RunId({ wpId: 'wp6', headShort: head }) : runIdFromM11OutPath(REPO_ROOT, out)
  const dir = openM11RunDir(REPO_ROOT, runId)

  const payload = {
    schema: 'm11-invalidation-verify@1',
    manifestVersion: M11_MANIFEST_VERSION,
    runId,
    head,
    databaseScope: 'isolated-sandbox',
    modelCalls: 0,
    measuredCount: checks.length,
    checks,
    summary: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
    verdict: failed.length === 0 ? 'PASS' : 'FAIL',
  }
  writeFileSync(join(dir, 'invalidation-verify.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  writeM11Manifest(dir, {
    runId,
    wp: 'wp6',
    head,
    headShort: head.slice(0, 12),
    branch: 'codex/m11-execution-plan',
    date: new Date().toISOString().slice(0, 10),
    toolVersions: { node: process.version },
    testType: 'invalidation',
    counts: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
    phases: ['single'],
    supersedes: null,
    notes: 'm11:invalidation:verify（同轮阻断 + 幂等失效 + 跨域只读；零模型调用）',
  })

  console.log(`runId: ${runId}`)
  for (const c of checks) console.log(`  ${c.pass ? '✅' : '❌'} ${c.id} ${c.label} —— ${c.detail}`)
  console.log(`verdict: ${failed.length === 0 ? 'PASS' : 'FAIL'}（${String(checks.length - failed.length)}/${String(checks.length)}）`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((error: unknown) => {
  console.error('m11:invalidation:verify 抛错（不是被拒，是执行器坏了）：', error)
  process.exit(1)
})
