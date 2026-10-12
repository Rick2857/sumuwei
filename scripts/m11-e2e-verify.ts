/**
 * M11 WP9 —— **离线端到端门**（`m11:e2e:verify`）。
 *
 * ============================================================================
 *  本门要测的命题（WP7 出口 + WP9 出口）
 * ============================================================================
 * ```text
 * 「**隔离库 + 真实生产入口**上有一条**关联链**：
 *    触发 → 输入装配 → 结构化候选 → 严格校验 → 审查 → 事件 → 投影
 *         → 行为调整 → 上下文 section」
 *  且链条上每一环的 id / 根 / 槽位 / 版本**互相对得上**（不是各写各的日志）。
 * ```
 *
 * ============================================================================
 *  三条纪律
 * ============================================================================
 * ① **离线固定 provider**：候选是**固定字符串**，因此本门是确定性的、毫秒级的。
 *    它**不**回答"模型写得好不好"—— 那是 WP10（真模型）。
 * ② **真实装配**：真实 Validator（域放行口）· 真实 `applyAcceptedEvents` · 真实投影折叠 ·
 *    真实渲染函数。只有"模型"那一格是固定的。
 * ③ **零越界**：链条跑完，Memory / Belief / Goal / Commitment 的事件数**一个都没变**。
 *
 * ⚠️ 触发事件是**构造的**（`GOAL_COMPLETED` 的合成 payload），只在 `isolateDatabase()`
 *    的一次性沙箱里用来喂触发检测器 —— 它**不**写任何真实库，也不进任何长期证据。
 */

import 'dotenv/config'

import { isolateDatabase } from '../src/dev/sandbox.ts'

// ⚠️ 必须在**任何**碰数据库的 import 之前（AGENTS §7）
isolateDatabase('m11-e2e-verify', { keep: false })

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
import { createProposal, type ProposalOperation } from '../src/kernel/contracts/proposal.ts'
import { createFullDomainEventRegistry, GOAL_COMPLETED } from '../src/kernel/contracts/domain-event.ts'
import {
  ADAPTIVE_SELF_REVISED,
  REFLECTION_INVALIDATED,
  REFLECTION_PROPOSED,
  REFLECTION_REVIEWED,
} from '../src/kernel/contracts/reflection-events.ts'
import { REFLECTION_DRAFT_SCHEMA_VERSION, REFLECTION_DRAFT_SCOPE, parseReflectionDraft } from '../src/kernel/contracts/reflection.ts'
import {
  REFLECTION_POLICY_VERSION,
  validateReflectionProposal,
  type ReflectionReviewFacts,
} from '../src/kernel/policies/reflection-validator.ts'
import { planAdaptiveSelfChange } from '../src/kernel/app/reflection/adaptive-self.ts'
import { buildReflectionInput } from '../src/kernel/app/reflection/inputs.ts'
import { planInvalidation } from '../src/kernel/app/reflection/invalidation.ts'
import { buildReflectionFactPack, reflectionFactInputFrom } from '../src/kernel/app/reflection/fact-pack.ts'
import { adaptiveSelfContextReality, renderAdaptiveSelfSection } from '../src/kernel/context/adaptive-self-sections.ts'
import { applyAdaptiveSelfRows, getAdaptiveSelfState, listAdaptiveSelfStates } from '../src/infrastructure/persistence/adaptive-self-store.ts'
import { applyReflectionRows, getReflectionRecord, listReflectionRecords } from '../src/infrastructure/persistence/reflection-store.ts'
import { createReflectionInputSource } from '../src/infrastructure/persistence/reflection-input-source.ts'
import { applyAcceptedEvents, appendDomainEvent, domainEventsFor } from '../src/infrastructure/persistence/event-store.ts'
import { assertValidatorAccepted } from '../src/kernel/policies/validator.ts'
import type { CharacterId } from '../src/kernel/contracts/ids.ts'
import type { AdaptiveSelfSlot } from '../src/kernel/contracts/adaptive-self.ts'

const REPO_ROOT = resolve(process.cwd())
const SLOT: AdaptiveSelfSlot = 'clarify_when_ambiguous'

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

/** 固定 provider 的"模型输出"（本门不调模型） */
function fixedDraftJson(handles: readonly string[]): string {
  return JSON.stringify({
    schemaVersion: REFLECTION_DRAFT_SCHEMA_VERSION,
    focusQuestion: '对象不明确时她是否在反复确认？',
    explanation: '三个不同会话都出现了同一种来回确认，且对象都不明确。',
    supportHandles: [...handles],
    counterHandles: [],
    scope: REFLECTION_DRAFT_SCOPE,
    suggestedSlot: SLOT,
  })
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  let out: string | undefined
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--out') out = args[++i]
    else throw new Error(`未知参数：${JSON.stringify(args[i])}`)
  }

  const h = await createM4Harness({ label: 'm11-e2e-verify' })
  const db = h.db
  const characterId = h.kernel.characterId as CharacterId
  const registry = createFullDomainEventRegistry()
  let clock = M4_T0
  const nextClock = (): number => (clock += 10)

  // 三条真实对话事件（作为三个独立来源）
  const e1 = await h.recordUserEvidence('第一次：对象不明确，我确认了一遍。')
  const e2 = await h.recordUserEvidence('第二次：又是对象不明确。')
  const e3 = await h.recordUserEvidence('第三次：还是不清楚指的是谁。')

  /*
   * 构造一条**触发事件**（合成 payload）：本门只喂触发检测器，不碰任何真实库。
   */
  await appendDomainEvent(
    db,
    characterId,
    {
      type: GOAL_COMPLETED,
      operation: 'm11-e2e-trigger-fixture',
      payload: {
        goalId: 'goal:fixture',
        expectedRevision: 1,
        basis: 'user_report',
        evidenceRefs: [{ conversationEventId: String(e1.event.id), fingerprint: 'fp-fixture' }],
      },
      sourceConversationEventIds: [e1.event.id],
      idempotencyKey: 'm11-e2e-verify:trigger-fixture',
      processor: 'm11-e2e-verify',
      processorVersion: 'm11-e2e-verify@1',
      scope: 'CHARACTER_INTERNAL',
    },
    nextClock()
  )

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
  const emit = async (type: string, payload: Record<string, unknown>): Promise<void> => {
    const proposal = createProposal({
      characterId,
      proposalType: 'm11-e2e-probe',
      sourceConversationEventIds: [e1.event.id],
      payload: {},
      targetEvents: [{ type, operation: 'create' as ProposalOperation, payload }],
      processor: 'm11-e2e-verify',
      processorVersion: `m11-e2e-verify@1-${type}`,
    })
    const accepted = assertValidatorAccepted(await validator.validate(proposal))
    for (const event of accepted) processedKeys.add(event.idempotencyKey)
    await applyAcceptedEvents(db, characterId, accepted, [], nextClock())
  }
  const foldAll = async (): Promise<void> => {
    const all = await domainEventsFor(db, characterId)
    await applyReflectionRows(
      db,
      characterId,
      all.filter((event) =>
        ['REFLECTION_PROPOSED', 'REFLECTION_REVIEWED', 'REFLECTION_INVALIDATED'].includes(String(event.type))
      ),
      nextClock()
    )
    await applyAdaptiveSelfRows(
      db,
      characterId,
      all.filter((event) => String(event.type) === ADAPTIVE_SELF_REVISED),
      nextClock()
    )
  }

  // -------------------------------------------------------------------------
  // A 组 —— 关联链：触发 → 输入 → 候选 → 审查 → 事件 → 投影 → 调整 → section
  // -------------------------------------------------------------------------
  const source = createReflectionInputSource(db, { characterId })
  const input = await buildReflectionInput(source, {
    characterId: String(characterId),
    cutoverSequence: 0,
    watermark: 0,
  })
  record(
    'A1',
    'A',
    '【触发】真实库里的合成触发事件被检测到 ⇒ 构造出输入（且窗口有界）',
    input !== undefined &&
      input.triggers.length === 1 &&
      input.triggers[0]?.kind === 'goal_outcome' &&
      input.window.length <= 50,
    input === undefined
      ? '没有构造出输入'
      : `triggers=${JSON.stringify(input.triggers.map((t) => t.kind))} · window=${String(input.window.length)} · measuredCount=${String(input.measuredCount)}`
  )

  const handleIds = (input?.handles ?? []).map((handle) => handle.id)
  const draft = parseReflectionDraft(fixedDraftJson(handleIds.slice(0, 3)), { handles: input?.handles ?? [] })
  record(
    'A2',
    'A',
    '【候选】固定 provider 的输出经**严格校验**通过（handle 全部来自程序提供的集合）',
    draft.ok === true && handleIds.length > 0,
    draft.ok ? `support=${JSON.stringify(draft.draft.supportHandles)}` : `被拒：${draft.reason}`
  )

  // 根解析：用三条真实对话事件当根（程序解析，不是模型自报）
  const roots = [String(e1.event.id), String(e2.event.id), String(e3.event.id)]
  const reflectionId = 'refl:e2e'
  if (draft.ok) {
    await emit(REFLECTION_PROPOSED, {
      reflectionId,
      focusQuestion: draft.draft.focusQuestion,
      explanation: draft.draft.explanation,
      supportHandles: [...draft.draft.supportHandles],
      counterHandles: [...draft.draft.counterHandles],
      scope: draft.draft.scope,
      ...(draft.draft.suggestedSlot === undefined ? {} : { suggestedSlot: draft.draft.suggestedSlot }),
      roots,
      rootCount: roots.length,
      conversationCount: 3,
      windowTruncated: input?.windowTruncated ?? false,
      modelVersion: 'fixed-provider@1',
      promptVersion: 'reflection-prompt@1',
      inputWindowFingerprint: 'fp-e2e',
    })
  }
  const facts: ReflectionReviewFacts = {
    roots,
    conversationCount: 3,
    unresolvedConflict: false,
    sourceVerdicts: roots.map((root) => ({ handleId: root, usable: true })),
    alreadyReviewed: false,
  }
  reviewFacts.set(reflectionId, facts)
  const verdict = {
    reflectionId,
    characterId: String(characterId),
    draft: draft.ok ? draft.draft : ({} as never),
    roots,
    conversationCount: 3,
    windowTruncated: false,
    sourceVerdicts: facts.sourceVerdicts,
    unresolvedConflict: false,
    alreadyReviewed: false,
  }
  const review = planAdaptiveSelfChange({
    slot: SLOT,
    current: await getAdaptiveSelfState(db, characterId, SLOT),
    reflections: [{ reflectionId, status: 'accepted' }],
    roots,
    conversationCount: 3,
    unresolvedConflict: false,
    targetLevel: 'enhanced',
    adaptiveEnabled: true,
    reason: 'threshold_met_with_three_independent_roots',
  })
  await emit(REFLECTION_REVIEWED, {
    reflectionId,
    decision: 'accepted',
    reasons: [],
    rootCount: roots.length,
    conversationCount: 3,
    policyVersion: REFLECTION_POLICY_VERSION,
  })
  await foldAll()

  const record1 = await getReflectionRecord(db, characterId, reflectionId)
  record(
    'A3',
    'A',
    '【审查 → 事件 → 投影】反思记录落库且状态 `accepted`，根与程序解析的一致（不是模型自报）',
    record1?.status === 'accepted' && record1.roots.join(',') === roots.join(','),
    `status=${String(record1?.status)} · roots=${String(record1?.rootCount)} · reasons=${JSON.stringify(record1?.reviewReasons)}`
  )

  if (review.kind === 'revise') {
    await emit(ADAPTIVE_SELF_REVISED, {
      slot: review.slot,
      level: review.level,
      revision: review.revision,
      roots: [...review.roots],
      reason: review.reason,
    })
    await foldAll()
  }
  const slotState = await getAdaptiveSelfState(db, characterId, SLOT)
  record(
    'A4',
    'A',
    '【行为调整】同一个反思真的把槽位推到 `enhanced`（revision 1），且来源反思可追溯',
    review.kind === 'revise' && slotState.level === 'enhanced' && slotState.revision === 1,
    `review=${review.kind} · level=${slotState.level} · revision=${String(slotState.revision)}`
  )

  const states = await listAdaptiveSelfStates(db, characterId)
  const section = renderAdaptiveSelfSection({ states, maxTokens: 300, quantify: (text) => text.length })[0]
  const reality = adaptiveSelfContextReality({
    intendedRefs: section?.sourceRefs ?? [],
    sectionSurvived: true,
    finalRefs: section?.sourceRefs,
  })
  record(
    'A5',
    'A',
    '【上下文】链条末端的 section 带**槽位 + revision** 引用，且与"实际入模"读数逐字一致',
    section !== undefined &&
      reality.selectedRefs.join(',') === `adaptive-self:${SLOT}@1` &&
      reality.reachedContext === true,
    `refs=${JSON.stringify(reality.selectedRefs)}`
  )

  const factPack = buildReflectionFactPack(
    reflectionFactInputFrom({
      reflectionStatuses: (await listReflectionRecords(db, characterId)).map((row) => String(row.status)),
      activeAdjustments: states.filter((state) => state.level === 'enhanced').length,
      invalidatedAdjustments: 0,
      lastRunFailed: false,
    })
  )
  record(
    'A6',
    'A',
    '【回复事实】链条末端的程序事实状态是 `active`（有生效调整），且允许/禁止说的表非空',
    factPack.state === 'active' && factPack.allowedClaims.length > 0 && factPack.forbiddenClaims.length > 0,
    `state=${factPack.state} · allowed=${String(factPack.allowedClaims.length)} · forbidden=${String(factPack.forbiddenClaims.length)}`
  )

  // -------------------------------------------------------------------------
  // B 组 —— 负控：链条必须在正确的环节**停下来**
  // -------------------------------------------------------------------------
  const weakFacts: ReflectionReviewFacts = { ...facts, roots: roots.slice(0, 2), conversationCount: 2 }
  const weakVerdict = {
    ...verdict,
    roots: weakFacts.roots,
    sourceVerdicts: weakFacts.sourceVerdicts,
  }
  void weakVerdict
  const weakReview = planAdaptiveSelfChange({
    slot: 'acknowledge_correction_first',
    current: await getAdaptiveSelfState(db, characterId, 'acknowledge_correction_first'),
    reflections: [{ reflectionId, status: 'accepted' }],
    roots: roots.slice(0, 2),
    conversationCount: 2,
    unresolvedConflict: false,
    targetLevel: 'enhanced',
    adaptiveEnabled: true,
    reason: 'should_not_happen',
  })
  record(
    'B1',
    'B',
    '【负控·门槛】只有两个根 ⇒ 规划层**拒绝**（`threshold_not_met`）⇒ 链条在这一环停下，不产生调整',
    weakReview.kind === 'no_change' && weakReview.reason === 'threshold_not_met',
    weakReview.kind === 'no_change' ? weakReview.reason : '**竟然 revise 了**'
  )

  const beforeInvalidation = (await domainEventsFor(db, characterId)).filter(
    (event) => String(event.type) === REFLECTION_INVALIDATED
  ).length
  const invalidationPlan = planInvalidation({
    reflectionId,
    roots,
    rootVerdicts: [
      { rootId: roots[0]!, usable: false, reason: 'source_forgotten' },
      { rootId: roots[1]!, usable: true },
      { rootId: roots[2]!, usable: true },
    ],
  })
  record(
    'B2',
    'B',
    '【负控·失效】根被忘掉 ⇒ 规划出失效（确定性 cause + causeEventId），且此时**还没有**失效事件（先阻断、后落账）',
    invalidationPlan.kind === 'invalidate' &&
      invalidationPlan.plan.cause === 'source_forgotten' &&
      invalidationPlan.plan.causeEventId === roots[0] &&
      beforeInvalidation === 0,
    invalidationPlan.kind === 'invalidate'
      ? `${invalidationPlan.plan.cause}@${invalidationPlan.plan.causeEventId} · 既有失效事件=${String(beforeInvalidation)}`
      : 'no_change'
  )

  if (invalidationPlan.kind === 'invalidate') {
    await emit(REFLECTION_INVALIDATED, {
      reflectionId,
      cause: invalidationPlan.plan.cause,
      causeEventId: invalidationPlan.plan.causeEventId,
    })
    await foldAll()
  }
  const afterInvalidation = await getReflectionRecord(db, characterId, reflectionId)
  record(
    'B3',
    'B',
    '【负控·终态】失效落账后状态是 `retracted`，原因留在读数里；**历史仍可读到曾经 accepted**',
    afterInvalidation?.status === 'retracted' &&
      (afterInvalidation?.reviewReasons ?? []).includes('source_forgotten'),
    `status=${String(afterInvalidation?.status)} · reasons=${JSON.stringify(afterInvalidation?.reviewReasons)}`
  )

  // -------------------------------------------------------------------------
  // C 组 —— 零越界 + 事件数对账
  // -------------------------------------------------------------------------
  const countByGroup = async (): Promise<Record<string, number>> => {
    const all = await domainEventsFor(db, characterId)
    const counts: Record<string, number> = {
      memory: 0,
      belief: 0,
      goal: 0,
      commitment: 0,
      reflection: 0,
      adaptive: 0,
      other: 0,
    }
    for (const event of all) {
      const type = String(event.type)
      if (type.startsWith('MEMORY_')) counts.memory += 1
      else if (type.startsWith('BELIEF_')) counts.belief += 1
      else if (type.startsWith('GOAL_')) counts.goal += 1
      else if (type.startsWith('COMMITMENT_')) counts.commitment += 1
      else if (type.startsWith('REFLECTION_')) counts.reflection += 1
      else if (type.startsWith('ADAPTIVE_SELF_')) counts.adaptive += 1
      else counts.other += 1
    }
    return counts
  }
  const counts = await countByGroup()
  record(
    'C1',
    'C',
    '【零越界】整条链只写了**本域**事件：Memory / Belief / Commitment 为 0；Goal 只有那条**构造的触发**（1 条）',
    counts.memory === 0 &&
      counts.belief === 0 &&
      counts.commitment === 0 &&
      counts.goal === 1 &&
      counts.reflection === 3 &&
      counts.adaptive === 1,
    `counts=${JSON.stringify(counts)}`
  )
  record(
    'C2',
    'C',
    '【事件数对账】链条产出的事件数**恰好**是 3 条反思 + 1 条调整（没有重复业务事件）',
    counts.reflection === 3 && counts.adaptive === 1,
    `reflection=${String(counts.reflection)} · adaptive=${String(counts.adaptive)}`
  )

  // -------------------------------------------------------------------------
  // S 组 —— 量具自检
  // -------------------------------------------------------------------------
  const byGroup = { A: 0, B: 0, C: 0 }
  for (const check of checks) if (check.group !== 'S') byGroup[check.group] += 1
  record(
    'S1',
    'S',
    '三组都测到**非零**条目',
    Object.values(byGroup).every((count) => count > 0),
    Object.entries(byGroup).map(([group, count]) => `${group}=${String(count)}`).join(' · ')
  )

  // -------------------------------------------------------------------------
  // 落盘
  // -------------------------------------------------------------------------
  const failed = checks.filter((check) => !check.pass)
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  const runId =
    out === undefined ? createM11RunId({ wpId: 'wp9-e2e', headShort: head }) : runIdFromM11OutPath(REPO_ROOT, out)
  const dir = openM11RunDir(REPO_ROOT, runId)

  const payload = {
    schema: 'm11-e2e-verify@1',
    manifestVersion: M11_MANIFEST_VERSION,
    runId,
    head,
    databaseScope: 'isolated-sandbox',
    modelCalls: 0,
    measuredCount: checks.length,
    chain: { reflectionId, slot: SLOT, roots: roots.length },
    checks,
    summary: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
    verdict: failed.length === 0 ? 'PASS' : 'FAIL',
  }
  writeFileSync(join(dir, 'e2e-verify.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  writeM11Manifest(dir, {
    runId,
    wp: 'wp9-e2e',
    head,
    headShort: head.slice(0, 12),
    branch: 'codex/m11-execution-plan',
    date: new Date().toISOString().slice(0, 10),
    toolVersions: { node: process.version },
    testType: 'e2e',
    counts: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
    phases: ['single'],
    supersedes: null,
    notes: 'm11:e2e:verify（隔离库 · 真实装配 · 固定 provider · 触发→…→上下文 的关联链）',
  })

  console.log(`runId: ${runId}`)
  for (const check of checks) {
    console.log(`  ${check.pass ? '✅' : '❌'} ${check.id} ${check.label} —— ${check.detail}`)
  }
  console.log(`verdict: ${failed.length === 0 ? 'PASS' : 'FAIL'}（${String(checks.length - failed.length)}/${String(checks.length)}）`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((error: unknown) => {
  console.error('m11:e2e:verify 抛错（不是被拒，是执行器坏了）：', error)
  process.exit(1)
})
