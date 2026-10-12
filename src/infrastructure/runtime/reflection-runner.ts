/**
 * M11 WP12 —— **反思慢路径的生产执行器**（把"窗口"变成真正的业务事件）。
 *
 * ============================================================================
 *  它补的是哪一格
 * ============================================================================
 * ```text
 * WP7 建了**调度**（水位 / 任务 / 失败 / 晚写闸门），WP3/WP4/WP5 建了**各段零件**
 * （输入装配 · 严格校验 · 审查 · 事件 · 投影），WP9 的 e2e 门在**测试里**把它们串起来跑通。
 * 但 `main.ts` **从来没有**调用过 `maybeRunReflectionEvaluation` ——
 * 也就是说：**生产里没有任何东西会跑这条慢路径**（实测：全仓只有 `m11-recovery-verify.ts` 调它）。
 * ⇒ 这正是 `L-M11-10`（M10 的 `goalTokens` 从未接线）的同一类缺口，登记为 `L-M11-20`。
 *
 * 本文件把那条链**装配成生产可调用的一个函数**：窗口 → 输入 → 模型 → 严格校验 →
 * 审查 → 事件 → 投影。调度与生命周期仍归 `reflection-scheduler.ts`。
 * ```
 *
 * ============================================================================
 *  四条硬边界
 * ============================================================================
 * ```text
 * ① **不吞错**：模型/校验的失败要**如实返回**（调度层据此落 failed 且不前进水位）；
 *    这里**不**把失败写成"没有洞见"。
 * ② **一次窗口一次调用**（`D30`：每 job 1 次模型调用）—— 不做重试、不降级重问。
 * ③ **只有程序解析的根**参与门槛判定（`D14`/`D31`）：模型自报的 supportHandles 只作引用。
 * ④ **不碰别的域**：只写 `REFLECTION_*` / `ADAPTIVE_SELF_*` 事件与它们自己的投影。
 * ```
 */

import type { CharacterId } from '../../kernel/contracts/ids.ts'
import { createProposal, type ProposalOperation } from '../../kernel/contracts/proposal.ts'
import { parseReflectionDraft } from '../../kernel/contracts/reflection.ts'
import {
  ADAPTIVE_SELF_REVISED,
  REFLECTION_PROPOSED,
  REFLECTION_REVIEWED,
} from '../../kernel/contracts/reflection-events.ts'
import {
  REFLECTION_POLICY_VERSION,
  reviewReflection,
  validateReflectionProposal,
  type ReflectionReviewFacts,
} from '../../kernel/policies/reflection-validator.ts'
import { planAdaptiveSelfChange } from '../../kernel/app/reflection/adaptive-self.ts'
import { buildReflectionInput } from '../../kernel/app/reflection/inputs.ts'
import { createFullDomainEventRegistry } from '../../kernel/contracts/domain-event.ts'
import { assertValidatorAccepted } from '../../kernel/policies/validator.ts'
import type { ReflectionDraftProvider } from '../../kernel/app/reflection/draft-port.ts'
import type { AdaptiveSelfSlot } from '../../kernel/contracts/adaptive-self.ts'
import { applyAcceptedEvents, domainEventsFor } from '../persistence/event-store.ts'
import { applyReflectionRows } from '../persistence/reflection-store.ts'
import { applyAdaptiveSelfRows, listAdaptiveSelfStates } from '../persistence/adaptive-self-store.ts'
import { createReflectionInputSource } from '../persistence/reflection-input-source.ts'
import type { RawDb } from '../persistence/db.ts'
import { readReflectionSourceSnapshot } from '../persistence/reflection-source-read.ts'
import { getReflectionRecord, listReflectionRecords } from '../persistence/reflection-store.ts'
import type { LateWriteFence } from '../../kernel/app/reflection/late-write-fence.ts'
import { createHash } from 'node:crypto'

export const REFLECTION_PROCESSOR_VERSION = 'reflection-scheduler@1'

/** 三槽（闭集）：由模型建议、程序裁决 */
const SLOTS: readonly AdaptiveSelfSlot[] = [
  'clarify_when_ambiguous',
  'acknowledge_correction_first',
  'recheck_goal_before_next_step',
]

export interface ReflectionRunnerInput {
  readonly characterId: CharacterId
  readonly activeUserId?: string
  readonly adaptiveEnabled?: boolean
  readonly fence?: LateWriteFence
  readonly signal?: AbortSignal
  /** Tests may shorten the frozen 20s bound; no caller can increase it. */
  readonly deadlineMs?: number
  /** 本轮窗口的水位下界（调度层给） */
  readonly watermark: number
  /** The scheduler's captured upper boundary; later events belong to a later job. */
  readonly throughSequence?: number
  readonly eligibleDomainEventIds?: readonly string[]
  /** 生产用的模型端口（缺省由调用方注入；这里**不**自己读 env） */
  readonly provider: ReflectionDraftProvider
  readonly now?: () => number
  /**
   * 可选拒收读数，供隔离控制使用；只能收紧当前持久读面的资格，不能授予资格。
   */
  readonly sourceVerdicts?: readonly {
    readonly handleId: string
    readonly usable: boolean
    readonly reason?: 'source_forgotten' | 'source_retracted' | 'source_version_changed' | 'unavailable'
  }[]
  /**
   * **把本次窗口的全部根都判为不可用**（带具名原因）。
   *
   * ⚠️ 为什么不用 `sourceVerdicts` 就够：装配层给的 handle id 是**带前缀**的
   *    （`cev:<uuid>:…`），而调用方手里往往只有原始 id ⇒ 逐个映射会静默失配
   *    （实测：撤回族的场景因此被**采纳**了）。这一格表达的是"本窗口的来源整体不可用"，
   *    语义清楚、不会失配。缺省 undefined = 使用真实持久资格读数。
   */
  readonly allSourcesUnusableReason?:
    | 'source_forgotten'
    | 'source_retracted'
    | 'source_version_changed'
    | 'unavailable'
  /** 本窗口是否存在**未解决的反例**（`D10` 的第三条件）。缺省 false。 */
  readonly unresolvedConflict?: boolean
}

export interface ReflectionRunnerOutcome {
  readonly kind: 'no_trigger' | 'format_invalid' | 'rejected' | 'accepted'
  /** 真的写进去的事件条数（用于对账） */
  readonly eventsWritten: number
  readonly reflectionId: string | null
  readonly detail: string
}

/**
 * 跑**一个窗口**的完整链。
 *
 * ⚠️ 抛错 = 基础设施坏了（写库失败等）⇒ 由调度层落 `failed` 且**不前进水位**；
 *    "模型给了无效输出"**不**抛，而是如实返回 `format_invalid`。
 */
export async function runReflectionWindow(
  db: RawDb,
  input: ReflectionRunnerInput
): Promise<ReflectionRunnerOutcome> {
  const now = input.now ?? (() => Date.now())
  if (input.fence?.closed || input.signal?.aborted) throw new Error('late_write_fenced')
  const source = createReflectionInputSource(db, { characterId: input.characterId, throughSequence: input.throughSequence,
    eligibleDomainEventIds: input.eligibleDomainEventIds })
  const built = await buildReflectionInput(source, {
    characterId: String(input.characterId),
    cutoverSequence: 0,
    watermark: input.watermark,
  })
  // ① 没有触发 ⇒ **不调用模型**（`D15`）
  if (built === undefined) {
    return { kind: 'no_trigger', eventsWritten: 0, reflectionId: null, detail: '窗口里没有触发事件' }
  }

  const captured = await readReflectionSourceSnapshot(db, input.characterId, built.handles, { activeUserId: input.activeUserId })
  if (!captured.usable) {
    return { kind: 'rejected', eventsWritten: 0, reflectionId: null, detail: '来源当前不可用；捕获前停止出站' }
  }

  // Own output events can advance latestSequence after a crash; they are not new experiences.
  const inputFingerprint = `m111-input@1:${createHash('sha256').update(JSON.stringify(built.window.map(row => [row.id, row.kind, row.revision, row.sourceClass]))).digest('hex')}`
  const maxTrigger = Math.max(...built.triggers.map(trigger => trigger.sequence))
  const providedIds = new Set(built.handles.map(handle => handle.id))
  const findSameInput = async (store: RawDb) => (await listReflectionRecords(store, input.characterId)).find(record => {
    if (record.generatedBy.inputWindowFingerprint === inputFingerprint) return true
    // Read old fingerprints without rewriting their evidence or reversing their terminal state.
    const legacy = /^fp:(\d+)-(\d+)$/.exec(record.generatedBy.inputWindowFingerprint)
    return legacy !== null && Number(legacy[1]) === built.watermarkFrom && Number(legacy[2]) >= maxTrigger &&
      record.supportHandles.length > 0 && record.supportHandles.every(id => providedIds.has(id))
  })
  const prior = await findSameInput(db)
  if (prior !== undefined) return { kind: prior.status === 'accepted' ? 'accepted' : 'rejected', eventsWritten: 0,
    reflectionId: prior.reflectionId, detail: `既有输入已处理，保持${prior.status}；不再次请求模型` }

  // ② 一次窗口一次调用（`D30`）
  const budgetMs = Math.min(20_000, Math.max(1, input.deadlineMs ?? 20_000))
  const controller = new AbortController()
  const signal = input.signal === undefined ? controller.signal : AbortSignal.any([controller.signal, input.signal])
  let abortListener: () => void = () => {}
  const deadline = new Promise<never>((_resolve, reject) => {
    abortListener = () => reject(new Error('reflection_provider_cancelled_or_deadline'))
    signal.addEventListener('abort', abortListener, { once: true })
  })
  const timer = setTimeout(() => controller.abort(), budgetMs)
  let raw: unknown
  try {
  if (signal.aborted) throw new Error('reflection_provider_cancelled')
  raw = await Promise.race([input.provider.call({
    characterId: String(input.characterId),
    window: built.window,
    handles: built.handles,
    counterHandles: [],
    triggerReasonCodes: built.triggers.map((trigger) => trigger.kind),
    sourceConversationCount: captured.conversationCount,
    deadlineMs: budgetMs,
    signal,
  }), deadline])
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abortListener)
  }

  // ③ 严格校验（模型自报的引用只作引用；结构不合规 ⇒ 如实返回）
  const parsed = parseReflectionDraft(typeof raw === 'string' ? raw : JSON.stringify(raw), {
    handles: built.handles,
  })
  if (!parsed.ok) {
    return {
      kind: 'format_invalid',
      eventsWritten: 0,
      reflectionId: null,
      detail: `严格校验拒绝：${parsed.reason}`,
    }
  }

  if (db.transaction === undefined) throw new Error('reflection_commit_transaction_unavailable')
  return await db.transaction(async (tx) => {
  const assertWritable = () => {
    if (input.fence?.closed || input.signal?.aborted) {
      input.fence?.noteRefused()
      throw new Error('late_write_fenced')
    }
  }
  assertWritable()
  const committedDuringCall = await findSameInput(tx)
  if (committedDuringCall !== undefined) return { kind: committedDuringCall.status === 'accepted' ? 'accepted' : 'rejected', eventsWritten: 0,
    reflectionId: committedDuringCall.reflectionId, detail: '同一输入已提交；不重复写入' }
  const selectedHandles = built.handles.filter(handle => parsed.draft.supportHandles.includes(handle.id))
  const currentSources = await readReflectionSourceSnapshot(tx, input.characterId, selectedHandles, { activeUserId: input.activeUserId, lock: true })
  const counterHandles = built.handles.filter(handle => parsed.draft.counterHandles.includes(handle.id))
  const counterSources = counterHandles.length === 0 ? undefined : await readReflectionSourceSnapshot(tx, input.characterId, counterHandles, { activeUserId: input.activeUserId, lock: true })
  const roots = [...currentSources.roots]
  const conversationCount = currentSources.conversationCount
  if (roots.length === 0) return { kind: 'rejected', eventsWritten: 0, reflectionId: null, detail: '没有可解析的支持根' }
  const changed = [currentSources, counterSources].some(snapshot => snapshot !== undefined &&
    Object.entries(snapshot.revisions).some(([id, revision]) => captured.revisions[id] !== revision))
  if (!currentSources.usable || counterSources?.usable === false || changed) return { kind: 'rejected', eventsWritten: 0, reflectionId: null, detail: '提交前来源失效或版本漂移；不保存过期草案' }
  const registry = createFullDomainEventRegistry()
  const processedKeys = new Set<string>()
  const reviewFacts = new Map<string, ReflectionReviewFacts>()
  const emit = async (
    type: string,
    payload: Record<string, unknown>,
    from: string
  ): Promise<boolean> => {
    assertWritable()
    const proposal = createProposal({
      characterId: input.characterId,
      proposalType: 'reflection-slow-path',
      sourceConversationEventIds: [from as never],
      payload: {},
      targetEvents: [{ type, operation: 'create' as ProposalOperation, payload }],
      processor: 'reflection-slow-path',
      processorVersion: `${REFLECTION_PROCESSOR_VERSION}-${type}`,
    })
    const outcome = await validateReflectionProposal(
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
    if (!outcome.accepted) return false
    for (const event of outcome.acceptedEvents) processedKeys.add(event.idempotencyKey)
    assertWritable()
    await applyAcceptedEvents(tx, input.characterId, outcome.acceptedEvents, [], now())
    return true
  }

  // ④ **程序解析**的根（不是模型自报的）
  const sourceEventId = String(roots[0] ?? 'unknown')
  const reflectionId = `refl:${String(built.watermarkTo)}:${String(roots.length)}`
  const existing = await getReflectionRecord(tx, input.characterId, reflectionId)
  if (existing !== undefined) return { kind: 'rejected', eventsWritten: 0, reflectionId, detail: `既有identity终态保持：${existing.status}` }
  const facts: ReflectionReviewFacts = {
    roots,
    conversationCount,
    unresolvedConflict: currentSources.unresolvedConflict || input.unresolvedConflict === true || parsed.draft.counterHandles.length > 0 || built.triggers.some(trigger => trigger.kind === 'registered_conflict'),
    // 当前读面决定资格；测试覆盖只能追加拒收。
    sourceVerdicts: roots.map((root) => {
      if (input.allSourcesUnusableReason !== undefined) {
        return { handleId: root, usable: false, reason: input.allSourcesUnusableReason }
      }
      const verdict = input.sourceVerdicts?.find((row) => row.handleId === root)
      if (verdict?.usable === false) return verdict
      if (changed || !currentSources.usable) return { handleId: root, usable: false, reason: 'source_version_changed' }
      return currentSources.sourceVerdicts.find(row => row.handleId === root) ?? { handleId: root, usable: false, reason: 'unavailable' }
    }),
    alreadyReviewed: false,
  }
  reviewFacts.set(reflectionId, facts)

  const proposed = await emit(
    REFLECTION_PROPOSED,
    {
      reflectionId,
      focusQuestion: parsed.draft.focusQuestion,
      explanation: parsed.draft.explanation,
      supportHandles: [...parsed.draft.supportHandles],
      counterHandles: [...parsed.draft.counterHandles],
      scope: parsed.draft.scope,
      ...(parsed.draft.suggestedSlot === undefined ? {} : { suggestedSlot: parsed.draft.suggestedSlot }),
      ...(parsed.draft.revisionIntent === undefined ? {} : { revisionIntent: parsed.draft.revisionIntent }),
      roots,
      rootCount: roots.length,
      conversationCount,
      windowTruncated: built.windowTruncated,
      modelVersion: input.provider.version,
      promptVersion: input.provider.promptVersion ?? 'reflection-prompt@1',
      inputWindowFingerprint: inputFingerprint,
    },
    sourceEventId
  )
  if (!proposed) {
    return { kind: 'rejected', eventsWritten: 0, reflectionId, detail: '提案被放行口拒绝' }
  }

  const review = reviewReflection({
    reflectionId,
    characterId: String(input.characterId),
    draft: parsed.draft,
    roots,
    conversationCount,
    windowTruncated: built.windowTruncated,
    sourceVerdicts: facts.sourceVerdicts,
    /*
     * ⚠️ **必须用 `facts.unresolvedConflict`**（调用方给的窗口事实），不是写死的 `false`：
     *    写死会让"有未解决反例"的场景被**采纳**（实测：冲突族 2/2 被采纳，
     *    材料因此**测不到**"该拒的拒了没有"）。
     */
    unresolvedConflict: facts.unresolvedConflict,
    alreadyReviewed: false,
  })
  const reviewed = await emit(
    REFLECTION_REVIEWED,
    {
      reflectionId,
      decision: review.decision,
      reasons: [...review.reasons],
      rootCount: review.rootCount,
      conversationCount: review.conversationCount,
      policyVersion: REFLECTION_POLICY_VERSION,
    },
    sourceEventId
  )
  if (!reviewed) throw new Error('reflection_review_rejected_before_commit')

  let written = 2
  /*
   * ⑤ 合法调整：**只在审查通过、且模型建议的槽位在闭集内**时尝试。
   *    ⚠️ 裁决权在程序（`planAdaptiveSelfChange`），不在模型。
   */
  const suggested = parsed.draft.suggestedSlot
  if (review.decision === 'accepted' && suggested !== undefined && SLOTS.includes(suggested)) {
    const states = await listAdaptiveSelfStates(tx, input.characterId)
    const current = states.find((state) => state.slot === suggested)!
    const plan = planAdaptiveSelfChange({
      slot: suggested,
      current,
      reflections: [{ reflectionId, status: 'accepted' }],
      roots,
      conversationCount,
      unresolvedConflict: facts.unresolvedConflict,
      targetLevel: 'enhanced',
      adaptiveEnabled: input.adaptiveEnabled === true,
      reason: `slow_path_window_${String(built.watermarkTo)}`,
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
        sourceEventId
      )
      if (ok) written += 1
    }
  }

  // ⑥ 折叠（投影是派生的 ⇒ 写完就折，读面立刻一致）
  assertWritable()
  const all = await domainEventsFor(tx, input.characterId)
  await applyReflectionRows(
    tx,
    input.characterId,
    all.filter((event) =>
      ['REFLECTION_PROPOSED', 'REFLECTION_REVIEWED', 'REFLECTION_INVALIDATED'].includes(String(event.type))
    ),
    now()
  )
  await applyAdaptiveSelfRows(
    tx,
    input.characterId,
    all.filter((event) => String(event.type) === ADAPTIVE_SELF_REVISED),
    now()
  )

  assertWritable()
  return {
    kind: review.decision === 'accepted' ? 'accepted' : 'rejected',
    eventsWritten: written,
    reflectionId,
    detail:
      review.decision === 'accepted'
        ? `采纳（根 ${String(roots.length)}）`
        : `拒绝：${review.reasons.join(',')}`,
  }
  })
}
