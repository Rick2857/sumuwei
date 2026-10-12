/**
 * M11 WP4 —— **审查与生命周期门**（`m11:policy:verify`）。
 *
 * ============================================================================
 *  本门要测的命题
 * ============================================================================
 * ```text
 * ① **候选已登记 ≠ 解释获采纳**：`REFLECTION_PROPOSED` 落 pending；
 *    只有 `reviewReflection()` 给出 accepted 才会变状态（`D03`/`D28`）。
 * ② **模型不自批**（`D08`）：判定只由程序事实决定 —— 结构与行为两向都测。
 * ③ **失败关闭**：来源不可用 / 门槛不够 / 未解决冲突 / 重复审查 ⇒ 各自**具名**拒收。
 * ④ **状态机**：rejected / retracted **不许翻案**（§4.3），折叠层也拒绝非法边。
 * ⑤ **回放**：从事件重建投影与原状态逐字段一致；`REFLECTION_ORIGIN` 不产生记录行。
 * ```
 *
 * ⚠️ 本门**零模型调用**：草案是固定字符串，判定是纯函数 —— 它不回答"模型写得好不好"。
 */

import 'dotenv/config'

import { isolateDatabase } from '../src/dev/sandbox.ts'

// ⚠️ 必须在**任何**碰数据库的 import 之前（AGENTS §7）
isolateDatabase('m11-policy-verify', { keep: false })

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
import { createFullDomainEventRegistry } from '../src/kernel/contracts/domain-event.ts'
import {
  ADAPTIVE_SELF_REVISED,
  REFLECTION_INVALIDATED,
  REFLECTION_ORIGIN,
  REFLECTION_PROPOSED,
  REFLECTION_REVIEWED,
  isReflectionDomainEventType,
  validateReflectionReviewedPayload,
  type ReflectionInvalidationCause,
} from '../src/kernel/contracts/reflection-events.ts'
import { REFLECTION_DRAFT_SCHEMA_VERSION, REFLECTION_DRAFT_SCOPE } from '../src/kernel/contracts/reflection.ts'
import {
  REFLECTION_POLICY_VERSION,
  reviewReflection,
  reviewTransitionAllowed,
  validateReflectionProposal,
  type ReflectionProposal,
  type ReflectionReviewFacts,
} from '../src/kernel/policies/reflection-validator.ts'
import {
  applyReflectionRows,
  getReflectionRecord,
  listReflectionRecords,
  listReflectionRows,
  rebuildReflectionProjections,
} from '../src/infrastructure/persistence/reflection-store.ts'
import {
  applyAcceptedEvents,
  domainEventsFor,
} from '../src/infrastructure/persistence/event-store.ts'
import { createDomainPolicyValidator, assertValidatorAccepted } from '../src/kernel/policies/validator.ts'
import { getConversationEvent } from '../src/infrastructure/persistence/conversation-store.ts'
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

const DRAFT_BASE = {
  schemaVersion: REFLECTION_DRAFT_SCHEMA_VERSION,
  focusQuestion: '对象不明确时她是否在反复确认？',
  explanation: '三个不同会话都出现了同一种来回确认。',
  supportHandles: ['ce:1', 'ce:2', 'ce:3'],
  counterHandles: [],
  scope: REFLECTION_DRAFT_SCOPE,
} as const

function proposedPayload(input: {
  reflectionId: string
  roots: string[]
  conversationCount: number
  explanation?: string
}): Record<string, unknown> {
  return {
    reflectionId: input.reflectionId,
    focusQuestion: DRAFT_BASE.focusQuestion,
    explanation: input.explanation ?? DRAFT_BASE.explanation,
    supportHandles: [...DRAFT_BASE.supportHandles],
    counterHandles: [...DRAFT_BASE.counterHandles],
    scope: REFLECTION_DRAFT_SCOPE,
    roots: input.roots,
    rootCount: input.roots.length,
    conversationCount: input.conversationCount,
    windowTruncated: false,
    modelVersion: 'fixed-provider@1',
    promptVersion: 'reflection-prompt@1',
    inputWindowFingerprint: 'fp-0001',
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  let out: string | undefined
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--out') out = args[++i]
    else throw new Error(`未知参数：${JSON.stringify(args[i])}`)
  }

  const h = await createM4Harness({ label: 'm11-policy-verify' })
  const db = h.db
  const characterId = h.kernel.characterId as CharacterId
  const registry = createFullDomainEventRegistry()
  let clock = M4_T0
  const nextClock = (): number => (clock += 10)

  // 真实对话事件（作为来源；Validator 要求来源存在且属于本角色）
  const evidence = await h.recordUserEvidence('这是一条用于反思审查验证的真实对话事件。')
  const sourceId = evidence.event.id

  /*
   * ⚠️ 本门走的是**本域自己的放行口**（`validateReflectionProposal`），不是通用那个。
   *    理由是实测逼出来的（`D26`）：通用幂等键只含 `character|processor|version|source|operation`
   *    ⇒ 同一窗口的两条 `REFLECTION_PROPOSED` 会算出**同一个键**、第二条被静默去重、
   *    两条不同的反思**塌成一条**。本域放行口用 `reflectionUnitOperationOf()` 自带单元串。
   */
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

  /** 走**真实放行口**产出一条反思事件（payload 校验 + registry + 域内幂等 + scope 全过）。 */
  const emit = async (
    type: string,
    payload: Record<string, unknown>,
    facts?: ReflectionReviewFacts
  ): Promise<void> => {
    const reflectionId = typeof payload.reflectionId === 'string' ? payload.reflectionId : undefined
    if (reflectionId !== undefined && facts !== undefined) reviewFacts.set(reflectionId, facts)
    const proposal = createProposal({
      characterId,
      proposalType: 'm11-policy-probe',
      sourceConversationEventIds: [sourceId],
      payload: {},
      targetEvents: [
        {
          type,
          operation: 'create' as ProposalOperation,
          payload,
        },
      ],
      processor: 'm11-policy-verify',
      processorVersion: `m11-policy-verify@1-${type}`,
    })
    const accepted = assertValidatorAccepted(await validator.validate(proposal))
    for (const event of accepted) processedKeys.add(event.idempotencyKey)
    await applyAcceptedEvents(db, characterId, accepted, [], nextClock())
  }

  /** 同 `emit`，但**不**断言通过（用于"夹带采纳"这类**必须被拒**的负控） */
  const emitRaw = async (
    type: string,
    payload: Record<string, unknown>,
    facts?: ReflectionReviewFacts
  ): Promise<string[]> => {
    const reflectionId = typeof payload.reflectionId === 'string' ? payload.reflectionId : undefined
    if (reflectionId !== undefined && facts !== undefined) reviewFacts.set(reflectionId, facts)
    const proposal = createProposal({
      characterId,
      proposalType: 'm11-policy-probe',
      sourceConversationEventIds: [sourceId],
      payload: {},
      targetEvents: [{ type, operation: 'create' as ProposalOperation, payload }],
      processor: 'm11-policy-verify',
      processorVersion: `m11-policy-verify@1-${type}`,
    })
    const outcome = await validator.validate(proposal)
    return outcome.rejected.map((r) => r.code)
  }

  /**
   * **绕过放行口**直接落一条事件（只用于测**折叠层**的纵深防御）。
   *
   * ⚠️ 这是刻意为之：如果只测"放行口拒了"，就不知道折叠层是否**也**拒绝非法边 ——
   *    而纵深防御的每一条都要各自被证明（放行口不是唯一防线，折叠层也不是）。
   */
  const emitDirect = async (type: string, payload: Record<string, unknown>): Promise<void> => {
    await applyAcceptedEvents(
      db,
      characterId,
      [
        {
          type,
          operation: `m11-policy-direct:${type}`,
          payload,
          sourceConversationEventIds: [sourceId],
          idempotencyKey: `m11-policy-direct:${type}:${String(payload.reflectionId ?? '')}:${String(clock)}`,
          processor: 'm11-policy-verify-direct',
          processorVersion: 'm11-policy-verify-direct@1',
          scope: 'CHARACTER_INTERNAL',
        },
      ],
      [],
      nextClock()
    )
  }

  const foldAll = async (): Promise<void> => {
    const events = await domainEventsFor(db, characterId)
    const reflectionEvents = events.filter((event) => isReflectionDomainEventType(event.type))
    await applyReflectionRows(db, characterId, reflectionEvents, nextClock())
  }

  // -------------------------------------------------------------------------
  // A 组 —— 候选 ≠ 采纳
  // -------------------------------------------------------------------------
  await emit(REFLECTION_ORIGIN, {
    activationId: 'act-m11-policy',
    cutoverSequence: 1,
    policyVersion: REFLECTION_POLICY_VERSION,
  })
  await emit(REFLECTION_PROPOSED, proposedPayload({ reflectionId: 'refl:A', roots: ['ce:1', 'ce:2', 'ce:3'], conversationCount: 2 }))
  await foldAll()

  const afterPropose = await getReflectionRecord(db, characterId, 'refl:A')
  record(
    'A1',
    'A',
    '【正控】`REFLECTION_PROPOSED` 落库 ⇒ 记录状态是 **pending**（候选**不等于**采纳）',
    afterPropose !== undefined && afterPropose.status === 'pending',
    `status=${String(afterPropose?.status)} · roots=${JSON.stringify(afterPropose?.roots)}`
  )
  record(
    'A2',
    'A',
    '`REFLECTION_ORIGIN` **不**产生记录行（否则"有几条反思"永远至少是 1）',
    (await listReflectionRecords(db, characterId)).length === 1,
    `记录数=${String((await listReflectionRecords(db, characterId)).length)}`
  )

  const proposalOf = (input: Partial<ReflectionProposal>): ReflectionProposal => ({
    reflectionId: 'refl:A',
    characterId: String(characterId),
    draft: {
      schemaVersion: REFLECTION_DRAFT_SCHEMA_VERSION,
      focusQuestion: DRAFT_BASE.focusQuestion,
      explanation: DRAFT_BASE.explanation,
      supportHandles: [...DRAFT_BASE.supportHandles],
      counterHandles: [],
      scope: REFLECTION_DRAFT_SCOPE,
    },
    roots: ['ce:1', 'ce:2', 'ce:3'],
    conversationCount: 2,
    windowTruncated: false,
    sourceVerdicts: [
      { handleId: 'ce:1', usable: true },
      { handleId: 'ce:2', usable: true },
      { handleId: 'ce:3', usable: true },
    ],
    unresolvedConflict: false,
    alreadyReviewed: false,
    ...input,
  })

  const accepted = reviewReflection(proposalOf({}))
  await emit(
    REFLECTION_REVIEWED,
    {
      reflectionId: 'refl:A',
      decision: accepted.decision,
      reasons: [...accepted.reasons],
      rootCount: accepted.rootCount,
      conversationCount: accepted.conversationCount,
      policyVersion: accepted.policyVersion,
    },
    {
      roots: ['ce:1', 'ce:2', 'ce:3'],
      conversationCount: 2,
      unresolvedConflict: false,
      sourceVerdicts: [
        { handleId: 'ce:1', usable: true },
        { handleId: 'ce:2', usable: true },
        { handleId: 'ce:3', usable: true },
      ],
      alreadyReviewed: false,
    }
  )
  await foldAll()
  const afterReview = await getReflectionRecord(db, characterId, 'refl:A')
  record(
    'A3',
    'A',
    '【正控】三根 / 两会话 / 无冲突 / 来源全可用 ⇒ **accepted**，状态真的翻到 accepted（两个状态可分辨）',
    accepted.decision === 'accepted' && afterReview?.status === 'accepted' && (afterReview?.reviewReasons.length ?? -1) === 0,
    `decision=${accepted.decision} · status=${String(afterReview?.status)} · reasons=${JSON.stringify(afterReview?.reviewReasons)}`
  )
  record(
    'A4',
    'A',
    '采纳记录里的根是**程序解析**的那些（不是模型自报）：rootCount=3 且与 payload 逐字一致',
    afterReview !== undefined &&
      afterReview.rootCount === 3 &&
      afterReview.roots.join(',') === 'ce:1,ce:2,ce:3',
    `roots=${JSON.stringify(afterReview?.roots)} · rootCount=${String(afterReview?.rootCount)}`
  )
  record(
    'A5',
    'A',
    '生命周期可审计：记录的 `lifecycleEventIds` 同时含 PROPOSED 与 REVIEWED 两个事件 id',
    (afterReview?.lifecycleEventIds.length ?? 0) === 2,
    `lifecycle=${JSON.stringify(afterReview?.lifecycleEventIds.length)} 条`
  )

  // -------------------------------------------------------------------------
  // B 组 —— 失败关闭与"模型不自批"
  // -------------------------------------------------------------------------
  const cases: { id: string; label: string; proposal: Partial<ReflectionProposal>; expect: string }[] = [
    {
      id: 'B1',
      label: '【负控】只有 2 个有效独立根 ⇒ `threshold_not_met`（不当"勉强采纳"）',
      proposal: { roots: ['ce:1', 'ce:2'] },
      expect: 'threshold_not_met',
    },
    {
      id: 'B2',
      label: '【负控】恰好 1 个根 ⇒ `single_root_only`（与"根数不够"分开）',
      proposal: { roots: ['ce:1'] },
      expect: 'single_root_only',
    },
    {
      id: 'B3',
      label: '【负控】三根只落在一个会话 ⇒ `single_session_only`',
      proposal: { conversationCount: 1 },
      expect: 'single_session_only',
    },
    {
      id: 'B4',
      label: '【负控】存在**未解决的直接冲突** ⇒ `conflicting_support`（相反证据不被平均掉）',
      proposal: { unresolvedConflict: true },
      expect: 'conflicting_support',
    },
    {
      id: 'B5',
      label: '【负控】来源被遗忘 ⇒ `source_forgotten`',
      proposal: {
        sourceVerdicts: [
          { handleId: 'ce:1', usable: true },
          { handleId: 'ce:2', usable: false, reason: 'source_forgotten' },
          { handleId: 'ce:3', usable: true },
        ],
      },
      expect: 'source_forgotten',
    },
    {
      id: 'B6',
      label: '【负控】来源版本漂移 ⇒ `source_version_changed`（读不到也归这一族）',
      proposal: {
        sourceVerdicts: [
          { handleId: 'ce:1', usable: false, reason: 'unavailable' },
          { handleId: 'ce:2', usable: true },
          { handleId: 'ce:3', usable: true },
        ],
      },
      expect: 'source_version_changed',
    },
    {
      id: 'B7',
      label: '【负控】重复审查 ⇒ `duplicate_review`',
      proposal: { alreadyReviewed: true },
      expect: 'duplicate_review',
    },
  ]
  const produced = new Set<string>()
  for (const probe of cases) {
    const outcome = reviewReflection(proposalOf(probe.proposal))
    for (const reason of outcome.reasons) produced.add(reason)
    record(probe.id, 'B', probe.label, outcome.decision === 'rejected' && outcome.reasons.includes(probe.expect), `reasons=${JSON.stringify(outcome.reasons)}`)
  }

  // B8 —— 模型自批：行为向（同样的程序事实 ⇒ 同样的判定，多一个"模型自称"字段也不变）
  const withClaim = reviewReflection(
    proposalOf({ ...({ modelClaims: { confidence: 0.99, reliable: true, requestApproval: true } } as object) })
  )
  record(
    'B8',
    'B',
    '【负控·行为】草案额外携带"模型自称置信度 99% / 请批准"**不改变**判定（程序事实说了算）',
    withClaim.decision === accepted.decision && withClaim.reasons.length === accepted.reasons.length,
    `带自称=${withClaim.decision}/${JSON.stringify(withClaim.reasons)} · 不带=${accepted.decision}/${JSON.stringify(accepted.reasons)}`
  )

  // B9 —— 模型自批：结构向（策略源码里没有"模型自评"这类输入）
  const policySrc = readFileSync(join(REPO_ROOT, 'src/kernel/policies/reflection-validator.ts'), 'utf8')
  const policyStripped = policySrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  const claimTokens = ['confidence', 'selfAssessed', 'modelSaysReliable', 'approvedByModel']
  const claimHits = claimTokens.filter((token) => policyStripped.includes(token))
  record(
    'B9',
    'B',
    '【负控·结构】放行口里**没有**任何"模型自评"字段（去注释后零命中）—— 自批在**类型上**不可能',
    claimHits.length === 0,
    `命中=${JSON.stringify(claimHits)}`
  )

  // B10 —— 非法边：rejected / retracted 不许翻案
  record(
    'B10',
    'B',
    '【负控·状态机】`rejected → accepted` 与 `retracted → accepted` 都是**非法边**（要重新成立就走新记录）',
    !reviewTransitionAllowed('rejected', 'accepted') && !reviewTransitionAllowed('retracted', 'accepted'),
    `rejected→accepted=${String(reviewTransitionAllowed('rejected', 'accepted'))} · retracted→accepted=${String(reviewTransitionAllowed('retracted', 'accepted'))}`
  )

  // B11 —— 折叠层也拒绝非法边（拒收后的 accepted 事件不改状态）
  await emit(REFLECTION_PROPOSED, proposedPayload({ reflectionId: 'refl:B', roots: ['ce:1', 'ce:2'], conversationCount: 1 }), {
    roots: ['ce:1', 'ce:2'],
    conversationCount: 1,
    unresolvedConflict: false,
    sourceVerdicts: [{ handleId: 'ce:1', usable: true }],
    alreadyReviewed: false,
  })
  const rejectedVerdict = reviewReflection(proposalOf({ reflectionId: 'refl:B', roots: ['ce:1', 'ce:2'] }))
  await emit(
    REFLECTION_REVIEWED,
    {
      reflectionId: 'refl:B',
      decision: rejectedVerdict.decision,
      reasons: [...rejectedVerdict.reasons],
      rootCount: rejectedVerdict.rootCount,
      conversationCount: rejectedVerdict.conversationCount,
      policyVersion: rejectedVerdict.policyVersion,
    },
    {
      roots: ['ce:1', 'ce:2'],
      conversationCount: 1,
      unresolvedConflict: false,
      sourceVerdicts: [{ handleId: 'ce:1', usable: true }],
      alreadyReviewed: false,
    }
  )
  await foldAll()
  const reflB = await getReflectionRecord(db, characterId, 'refl:B')
  // 再投一条 accepted（**绕过放行口**直接落事件）—— 折叠层必须拒绝这条非法边
  await emitDirect(REFLECTION_REVIEWED, {
    reflectionId: 'refl:B',
    decision: 'accepted',
    reasons: [],
    rootCount: 3,
    conversationCount: 2,
    policyVersion: REFLECTION_POLICY_VERSION,
  })
  await foldAll()
  const reflBAfter = await getReflectionRecord(db, characterId, 'refl:B')
  record(
    'B11',
    'B',
    '【负控·折叠层】已 rejected 的记录遇到后来的 accepted 事件：状态**仍是 rejected**（非法边不折叠，也不抛）',
    reflB?.status === 'rejected' && reflBAfter?.status === 'rejected',
    `${String(reflB?.status)} → ${String(reflBAfter?.status)}`
  )

  // B12 —— 失效是终态
  await emit(REFLECTION_INVALIDATED, {
    reflectionId: 'refl:A',
    cause: 'source_forgotten' satisfies ReflectionInvalidationCause,
    causeEventId: String(sourceId),
  })
  await emitDirect(REFLECTION_REVIEWED, {
    reflectionId: 'refl:A',
    decision: 'accepted',
    reasons: [],
    rootCount: 3,
    conversationCount: 2,
    policyVersion: REFLECTION_POLICY_VERSION,
  })
  await foldAll()
  const reflAAfter = await getReflectionRecord(db, characterId, 'refl:A')
  record(
    'B12',
    'B',
    '【负控·终态】失效之后不能"复活"成 accepted：状态停在 `retracted`，且失效原因留在读数里',
    reflAAfter?.status === 'retracted' && (reflAAfter?.reviewReasons ?? []).includes('source_forgotten'),
    `status=${String(reflAAfter?.status)} · reasons=${JSON.stringify(reflAAfter?.reviewReasons)}`
  )

  // B13 —— 夹带采纳在**放行口**就被拒（模型自批的第二道防线）
  const smuggled = await emitRaw(
    REFLECTION_REVIEWED,
    {
      reflectionId: 'refl:B',
      decision: 'accepted',
      reasons: [],
      rootCount: 3,
      conversationCount: 2,
      policyVersion: REFLECTION_POLICY_VERSION,
    },
    {
      roots: ['ce:1', 'ce:2'],
      conversationCount: 1,
      unresolvedConflict: false,
      sourceVerdicts: [{ handleId: 'ce:1', usable: true }],
      alreadyReviewed: false,
    }
  )
  record(
    'B13',
    'B',
    '【负控·放行口】发射方夹带一个 accepted（而策略判 rejected）⇒ **放行口**以 `not_fact_authority` 拒收',
    smuggled.includes('not_fact_authority'),
    `拒绝码=${JSON.stringify(smuggled)}`
  )

  // -------------------------------------------------------------------------
  // C 组 —— 回放与确定性
  // -------------------------------------------------------------------------
  const beforeRebuild = await listReflectionRecords(db, characterId)
  const events = (await domainEventsFor(db, characterId)).filter((event) =>
    isReflectionDomainEventType(event.type)
  )
  const rebuilt = await rebuildReflectionProjections(db, characterId, events, nextClock())
  const afterRebuild = await listReflectionRecords(db, characterId)
  record(
    'C1',
    'C',
    '【回放】从事件全量重建投影：与重建前**逐字段一致**（投影确实是派生的）',
    JSON.stringify(beforeRebuild) === JSON.stringify(afterRebuild) && rebuilt.previousRowCount === beforeRebuild.length,
    `重建前 ${String(beforeRebuild.length)} 条 / 重建后 ${String(afterRebuild.length)} 条 · 一致=${String(JSON.stringify(beforeRebuild) === JSON.stringify(afterRebuild))}`
  )
  record(
    'C2',
    'C',
    '【确定性】重建不产生额外事件（只折叠**已提交**事件，不调 provider、不重新生成候选）',
    rebuilt.appliedEvents === events.length,
    `折叠事件=${String(rebuilt.appliedEvents)} · 库中反思事件=${String(events.length)}`
  )

  // -------------------------------------------------------------------------
  // D 组 —— 结构判据（读面与放行口）
  // -------------------------------------------------------------------------
  const storeSrc = readFileSync(join(REPO_ROOT, 'src/infrastructure/persistence/reflection-store.ts'), 'utf8')
  const storeStripped = storeSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  /*
   * ⚠️ 判据作用域（第三次踩同一类坑）：**按函数体**切片，而不是"从某个函数到文件末尾"——
   *    后者会把后面的 `rebuildReflectionProjections`（它**本来就应该**有写原语）一起扫进来，
   *    于是"读面干净"永远判 ❌。
   */
  const functionBodyOf = (source: string, name: string): string => {
    const start = source.indexOf(`export async function ${name}`)
    if (start < 0) return ''
    const rest = source.slice(start)
    const nextExport = rest.indexOf('\nexport ', 1)
    return nextExport < 0 ? rest : rest.slice(0, nextExport)
  }
  const readFaces = ['listReflectionRows', 'listReflectionRecords', 'getReflectionRecord']
    .map((name) => functionBodyOf(storeStripped, name))
    .join('\n')
  const writePrimitives = ['insertProjection', 'saveProjection', 'deleteProjection', 'inTransaction']
  const readHits = writePrimitives.filter((primitive) => readFaces.includes(primitive))
  record(
    'D1',
    'D',
    '结构判据：**读面**（三个读函数的函数体）里没有写原语 —— 与 M10 只读契约同形',
    readFaces.length > 0 && readHits.length === 0,
    `扫描到的读函数体=${String(readFaces.length)} 字节 · 命中=${JSON.stringify(readHits)}`
  )
  const policyWrites = ['insertProjection', 'saveProjection', 'deleteProjection', 'applyAcceptedEvents', 'appendDomainEvent', 'inTransaction'].filter(
    (primitive) => policyStripped.includes(primitive)
  )
  record(
    'D2',
    'D',
    '结构判据：放行口是**纯**的（没有查询、没有事务、没有写入）',
    policyWrites.length === 0,
    `命中=${JSON.stringify(policyWrites)}`
  )
  record(
    'D3',
    'D',
    'payload 校验：`REFLECTION_REVIEWED` 的 accepted **不得**带理由码（结构判据）',
    (() => {
      try {
        validateReflectionReviewedPayload({
          reflectionId: 'refl:X',
          decision: 'accepted',
          reasons: ['threshold_not_met'],
          rootCount: 3,
          conversationCount: 2,
          policyVersion: REFLECTION_POLICY_VERSION,
        })
        return false
      } catch {
        return true
      }
    })(),
    'accepted + 理由码 ⇒ 抛错（"有问题的采纳"在形状上不存在）'
  )

  // -------------------------------------------------------------------------
  // S 组 —— 量具自检
  // -------------------------------------------------------------------------
  const byGroup = { A: 0, B: 0, C: 0, D: 0 }
  for (const c of checks) if (c.group !== 'S') byGroup[c.group] += 1
  record(
    'S1',
    'S',
    '四组都测到**非零**条目，且拒收理由覆盖了门槛 / 冲突 / 来源 / 重复四族',
    Object.values(byGroup).every((count) => count > 0) &&
      ['threshold_not_met', 'conflicting_support', 'source_forgotten', 'duplicate_review'].every((code) =>
        produced.has(code)
      ),
    `A=${String(byGroup.A)} · B=${String(byGroup.B)} · C=${String(byGroup.C)} · D=${String(byGroup.D)} · 拒收码=${JSON.stringify([...produced].sort())}`
  )
  record(
    'S2',
    'S',
    '登记的五条事件类型里，本门**真的用到了**四条（`ADAPTIVE_SELF_REVISED` 归 WP5）',
    [REFLECTION_ORIGIN, REFLECTION_PROPOSED, REFLECTION_REVIEWED, REFLECTION_INVALIDATED].every((type) =>
      events.some((event) => event.type === type)
    ) && !events.some((event) => event.type === ADAPTIVE_SELF_REVISED),
    `用到=${JSON.stringify([...new Set(events.map((event) => String(event.type)))].sort())}`
  )

  // -------------------------------------------------------------------------
  // 落盘
  // -------------------------------------------------------------------------
  const failed = checks.filter((c) => !c.pass)
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  const runId =
    out === undefined ? createM11RunId({ wpId: 'wp4', headShort: head }) : runIdFromM11OutPath(REPO_ROOT, out)
  const dir = openM11RunDir(REPO_ROOT, runId)

  const payload = {
    schema: 'm11-policy-verify@1',
    manifestVersion: M11_MANIFEST_VERSION,
    runId,
    head,
    databaseScope: 'isolated-sandbox',
    modelCalls: 0,
    measuredCount: checks.length,
    reasonCodesProduced: [...produced].sort(),
    reflectionRows: (await listReflectionRows(db, characterId)).length,
    checks,
    summary: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
    verdict: failed.length === 0 ? 'PASS' : 'FAIL',
  }
  writeFileSync(join(dir, 'policy-verify.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  writeM11Manifest(dir, {
    runId,
    wp: 'wp4',
    head,
    headShort: head.slice(0, 12),
    branch: 'codex/m11-execution-plan',
    date: new Date().toISOString().slice(0, 10),
    toolVersions: { node: process.version },
    testType: 'policy',
    counts: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
    phases: ['single'],
    supersedes: null,
    notes: 'm11:policy:verify（审查 + 生命周期 + 回放；零模型调用）',
  })

  console.log(`runId: ${runId}`)
  for (const c of checks) console.log(`  ${c.pass ? '✅' : '❌'} ${c.id} ${c.label} —— ${c.detail}`)
  console.log(`verdict: ${failed.length === 0 ? 'PASS' : 'FAIL'}（${String(checks.length - failed.length)}/${String(checks.length)}）`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((error: unknown) => {
  console.error('m11:policy:verify 抛错（不是被拒，是执行器坏了）：', error)
  process.exit(1)
})
