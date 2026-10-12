/**
 * M10.1 WP2b —— **约定识别的执行段**（一次模型调用 + 两道闸 + 复用 M10 的写路径）。
 *
 * ============================================================================
 *  一次调用的完整路径（`D02` 的形状）
 * ============================================================================
 * ```text
 * 账本尾部（有界） → `assembleAgreementWindow`（有界 + 遮蔽先于注入）
 *   → **一次**模型调用（`AgreementDraftProvider`）
 *   → `recognizeAgreement`（形状闸 + 序号→id 解析 + WP1 的语义闸）
 *   → `buildAgreementProposal`（`AcceptedAgreement` → 目标草案）
 *   → `draftToProgramProposal`（映射；**不**新增写路径）
 *   → `validateGoalProposal`（M10 的**唯一**放行口）
 *   → 写事件 + 落投影（与 `m10-harness` 同一形状：**只把这一批新事件**交给增量折叠）
 * ```
 *
 * ============================================================================
 *  四条纪律
 * ============================================================================
 * ```text
 * ① **不猜判据**：程序侧判据由**调用方**给（v1 的约定识别只代表 `user_report`：
 *    "他到没到由他报告" —— 正是 R-26 的那类约定）。别的判据要程序能力名或可核对结构，
 *    属**程序侧构造器**的面，本 worker 不产。
 * ② **不新增写路径**：走 M10 的放行口与写入器；本模块**只**编排。
 * ③ **失败就抛**（网络/无凭证）⇒ 调度器把它落成 `failed` 且**水位不前进**（补洞）；
 *    而"模型说没有约定"（`no_agreement`）与"语义不成立"（`rejected`）**是结论，不是失败**。
 * ④ **写入顺序**：业务事件先落、水位后落（调度器）⇒ 崩溃只会**重放**，而重放被幂等键挡住。
 * ```
 */

import type { CharacterId } from '../../kernel/contracts/ids.ts'
import { createFullDomainEventRegistry, GOAL_DOMAIN_EVENT_TYPES } from '../../kernel/contracts/domain-event.ts'
import { codepointLength } from '../../kernel/contracts/agreement-input.ts'
import { assembleAgreementWindow, type AgreementRawEntry } from '../../kernel/app/agreement/inputs.ts'
import { buildAgreementProposal } from '../../kernel/app/agreement/proposal.ts'
import {
  AGREEMENT_MODEL_REJECT_REASONS,
  recognizeAgreement,
  type AgreementRecognitionReason,
} from '../../kernel/contracts/agreement-model-draft.ts'
import { draftToProgramProposal } from '../../kernel/app/goal/understanding.ts'
import { validateGoalProposal } from '../../kernel/policies/goal-validator.ts'
import { applyAcceptedEvents, domainEventsFor } from '../persistence/event-store.ts'
import { createProcessedOperationStore } from '../persistence/job-store.ts'
import { applyGoalRows, createGoalStateLookup } from '../persistence/goal-store.ts'
import type { AgreementDraftProvider } from '../model/openai-agreement-understanding.ts'
import type { LateWriteFence } from '../../kernel/app/reflection/late-write-fence.ts'
import type { RawDb } from '../persistence/db.ts'

export const AGREEMENT_PROCESSOR_ID = 'agreement-scheduler'

export type AgreementRunKind =
  | 'written'
  | 'already_applied'
  | 'no_agreement'
  | 'rejected'
  | 'invalid'
  | 'empty'
  | 'truncated'
  | 'fenced'

export interface AgreementRunResult {
  readonly kind: AgreementRunKind
  /** 具名理由（`invalid` / `rejected` 时在场） */
  readonly reason?: AgreementRecognitionReason | string
  readonly detail?: string
  readonly eventsWritten?: number
}

export interface RunAgreementWindowInput {
  readonly characterId: CharacterId
  readonly activeUserId: string
  readonly entries: readonly AgreementRawEntry[]
  readonly provider: AgreementDraftProvider
  readonly signal: AbortSignal
  readonly fence?: LateWriteFence
  readonly now: number
  readonly deadlineMs?: number
  readonly proposalIdPrefix?: string
}

/** 一次窗口：装配 → 模型 → 两道闸 → 放行口 → 写 */
export async function runAgreementWindow(
  db: RawDb,
  input: RunAgreementWindowInput
): Promise<AgreementRunResult> {
  if (input.fence?.closed) return { kind: 'fenced' }

  const window = assembleAgreementWindow({ entries: input.entries })
  /*
   * ⚠️ **窗口被截断 ⇒ 本次不下结论**（WP1 的纪律：不截断后假装看全）。
   *    水位由调度器落成 `latest` ⇒ "下一次触发"自然覆盖到新的事件。
   */
  if (window.facts.windowTruncated) {
    return {
      kind: 'truncated',
      detail: `窗口超过上界（${String(window.facts.entryCount)} 条）⇒ 本次不下结论`,
    }
  }
  if (window.entries.length === 0) return { kind: 'empty' }

  /* ---- **一次**模型调用（异常直接抛：那是失败，不是结论） ---- */
  const raw = await input.provider.call({
    window,
    signal: input.signal,
    deadlineMs: input.deadlineMs ?? 25_000,
  })

  const recognition = recognizeAgreement(raw, window)
  if (!recognition.ok) {
    if (recognition.reason === 'no_agreement') {
      return { kind: 'no_agreement', detail: recognition.detail }
    }
    /* 形状层失败 = 模型输出不合法（`invalid`）；语义层失败 = 合法草案但判据不成立（`rejected`） */
    const shapeFailure = (AGREEMENT_MODEL_REJECT_REASONS as readonly string[]).includes(
      recognition.reason
    )
    return {
      kind: shapeFailure ? 'invalid' : 'rejected',
      reason: recognition.reason,
      detail: recognition.detail,
    }
  }

  const agreement = recognition.agreement
  const acceptEntry = window.entries.find((entry) => entry.id === agreement.acceptedByEventId)
  const proposedEntry = window.entries.find((entry) => entry.id === agreement.proposedByEventId)!
  const userEventId = agreement.proposedBy === 'user' ? agreement.proposedByEventId : agreement.acceptedByEventId
  const userEntry = window.entries.find(entry => entry.id === userEventId)!
  // 同一次用户接受在快路径、慢路径和重放中只记一次；新一次约定有新的用户事件。
  const stored = (await domainEventsFor(db, input.characterId)).filter((event) =>
    (GOAL_DOMAIN_EVENT_TYPES as readonly string[]).includes(String(event.type))
  )
  if (stored.some((event) => event.type === 'COMMITMENT_ACCEPTED' &&
    (event.payload as { commitment?: { acceptanceRefs?: readonly { conversationEventId: string }[] } }).commitment?.acceptanceRefs?.some(ref => String(ref.conversationEventId) === userEventId))) {
    if (input.fence?.closed) return { kind: 'fenced' }
    await applyGoalRows(db, input.characterId, stored as never, input.now)
    return { kind: 'already_applied', eventsWritten: 0 }
  }
  const span = { start: 0, end: codepointLength(userEntry.text) }
  const proposalId = `${input.proposalIdPrefix ?? 'agreement'}:${userEventId}`

  const built = buildAgreementProposal({
    agreement,
    characterId: input.characterId,
    span,
    proposalSpan: { start: 0, end: codepointLength(proposedEntry.text) },
    proposalId,
    processor: AGREEMENT_PROCESSOR_ID,
    processorVersion: 'agreement-scheduler@1',
    now: input.now,
    /*
     * ⚠️ **程序侧判据由这里给**（不从正文猜）：v1 的约定识别只代表 `user_report`
     *    —— "他到没到由他报告"（R-26 的那类约定）。
     */
    criterion: { kind: 'user_report' },
  })
  if (!built.ok) {
    return { kind: 'rejected', reason: built.reason, detail: built.detail }
  }

  const mapped = draftToProgramProposal(built.draft, {
    characterId: input.characterId,
    sourceEventId: userEventId,
    proposalId,
    processor: AGREEMENT_PROCESSOR_ID,
    processorVersion: 'agreement-scheduler@1',
    candidates: [],
    sourceText: userEntry.text,
    ...(agreement.proposedBy === 'character' ? { proposalEvidence: { eventId: proposedEntry.id, text: proposedEntry.text } } : {}),
    acceptanceEvidence: [proposedEntry, acceptEntry!].map(entry => ({ eventId: entry.id, text: entry.text })),
    now: input.now,
  })
  if (mapped.proposal === undefined) {
    return { kind: 'rejected', reason: 'no_proposal', detail: `映射没有产出提案（${mapped.operation}）` }
  }

  const lookup = createGoalStateLookup(db)
  const outcome = await validateGoalProposal(
    {
      registry: createFullDomainEventRegistry(),
      processed: createProcessedOperationStore(db),
      state: {
        getGoal: (c: string, goalId: string) => lookup.getGoal(c as never, goalId as never),
        listGoals: (c: string) => lookup.listGoals(c as never),
      } as never,
      policy: { characterId: input.characterId, activeUserId: input.activeUserId },
    },
    mapped.proposal
  )
  if (!outcome.accepted) {
    return {
      kind: 'rejected',
      reason: outcome.rejected.map((row) => String(row.code)).join(','),
      detail: outcome.rejected.map((row) => `${String(row.type)}:${String(row.code)}`).join(' · '),
    }
  }
  if (input.fence?.closed) return { kind: 'fenced' }

  /* ---- 写：事件一个事务、投影行另一个事务（`L-M10-05`，与生产同形） ---- */
  await applyAcceptedEvents(db, input.characterId, outcome.acceptedEvents as never, [], input.now)
  /*
   * ⚠️ 折叠的输入形状**照抄 `m10-harness`**（那是在生产之外唯一被证明过的写形状）：
   *    读回本域已落库事件（**按 sequence 升序**）交给增量折叠；重复投递归 `processed_operations` 挡。
   */
  const committed = (await domainEventsFor(db, input.characterId)).filter((event) =>
    (GOAL_DOMAIN_EVENT_TYPES as readonly string[]).includes(String(event.type))
  )
  await applyGoalRows(db, input.characterId, committed as never, input.now)

  return { kind: 'written', eventsWritten: outcome.acceptedEvents.length }
}
