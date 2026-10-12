/**
 * Goal / Commitment **完成判定器**（M10 WP6 / ADR-076 §4.5 · §4.11 · `D11`–`D13` · `D26`）。
 *
 * ============================================================================
 *  它存在的唯一理由：把"她说完成了"与"真的完成了"分开
 * ============================================================================
 * 三种达成依据**互不替代**（§4.5），且准入是**一对一**：
 * ```text
 * completionBasis 必须 === criterion.kind     （无例外）
 * ```
 *
 * ```text
 * user_report        用户报告**自己的**目标完成 —— 她的输出**永远**不能当这个依据
 * conversation_output 正式 assistant event 中存在约定产物，且**结构检查**通过
 *                     —— 只证明"结构在那儿"，**不**证明内容正确
 * action_result      对应请求**实际执行**且 succeeded —— 只看存下来的 actionId
 * ```
 *
 * ============================================================================
 *  四条硬性质
 * ============================================================================
 * ① **正文不留痕**：判定需要读 assistant 输出（结构检查必须读它），但**结论只带
 *    计数与布尔** —— `GoalCompletionVerdict` 的类型里没有 `text` 字段。
 *    因此"读过的正文"不可能被顺手写进 trace / 账本 / 开发者面。
 * ② **只消费已获原有权限的请求结果**：Goal 不额外授予能力；`action_result` 按
 *    **存下来的 actionId** 匹配，不做正文匹配（避免把正则当成判据）。
 * ③ **失败关闭**：端口抛错 ⇒ `completion_evidence_unavailable`（不是"没证据"，
 *    也不是"通过了"）。
 * ④ **迟到结果不得完成新约定**：`expectedRevision` 不符 ⇒ `revision_stale`。
 *    goal 与 commitment **各自独立**的 revision 都要判。
 *
 * ⚠️ 纯编排 + 端口：不 import SQL / 框架 / `node:*`，不读时钟。
 */

import type { SourceQualification } from '../../contracts/attribution.ts'
import type {
  CommitmentState,
  GoalCompletionBasis,
  GoalSourceRef,
  GoalState,
  GoalSuccessCriterion,
} from '../../contracts/goal.ts'
import { isCommitmentTerminal, isGoalTerminal } from '../../contracts/goal.ts'

// ---------------------------------------------------------------------------
// 端口（只给形状；读落在 infrastructure）
// ---------------------------------------------------------------------------

/** 一条**用户**对话事件的读数 */
export interface GoalUserEventReading {
  readonly id: string
  readonly characterId: string
  /** `'user'` / `'character'` / … */
  readonly actorType: string
  /** 受信归因资格（程序给出；`user_report` 要求 `ESTABLISHED`） */
  readonly qualification: SourceQualification
}

/**
 * 一条 assistant 事件的读数。
 *
 * ⚠️ `text` 是**唯一**会把正文带进本层的东西，而它只在判定的这一瞬间存在：
 *    判定结论**不带**它（性质 ①）。
 */
export interface GoalAssistantEventReading {
  readonly id: string
  readonly characterId: string
  readonly actorType: string
  /** 它回应的那条用户事件（用于"是不是这一轮的产物"） */
  readonly replyToEventId?: string
  readonly text: string
}

/** 一条 ActionResult 的读数（形状对齐 `kernel/action/action-result.ts`） */
export interface GoalActionResultReading {
  readonly actionId: string
  readonly characterId: string
  readonly capability: string
  readonly operation: string
  /** 策略是否允许 */
  readonly accepted: boolean
  /** 适配器是否真的被调用过 —— **它才是"执行了没有"** */
  readonly executed: boolean
  /** `success` / `rejected` / `failed` / `partial` / `not_found` / `ambiguous` / `timeout` / `cancelled` */
  readonly status: string
}

export interface GoalCompletionPorts {
  readonly conversation: {
    findEvents(ids: readonly string[]): Promise<readonly GoalUserEventReading[]>
  }
  readonly assistant: {
    findAssistantEvents(ids: readonly string[]): Promise<readonly GoalAssistantEventReading[]>
  }
  readonly actions: {
    findActions(ids: readonly string[]): Promise<readonly GoalActionResultReading[]>
  }
}

// ---------------------------------------------------------------------------
// 拒绝码（闭集；四条是 WP6 追加，见 ADR-076 §4.8.3）
// ---------------------------------------------------------------------------

export type GoalCompletionRejectionCode =
  | 'completion_evidence_missing'
  | 'completion_evidence_kind_mismatch'
  | 'completion_evidence_revision_stale'
  | 'completion_evidence_not_executed'
  | 'completion_evidence_failed'
  | 'completion_structure_check_failed'
  /* --- WP6 追加的四条 --- */
  | 'completion_target_not_found'
  | 'completion_target_terminal'
  | 'completion_source_not_established'
  | 'completion_evidence_unavailable'

export const GOAL_COMPLETION_REJECTION_CODES: readonly GoalCompletionRejectionCode[] = [
  'completion_evidence_missing',
  'completion_evidence_kind_mismatch',
  'completion_evidence_revision_stale',
  'completion_evidence_not_executed',
  'completion_evidence_failed',
  'completion_structure_check_failed',
  'completion_target_not_found',
  'completion_target_terminal',
  'completion_source_not_established',
  'completion_evidence_unavailable',
]

/** 每个码的**可达性事实**（沿用 `memory-record-status.ts` 的既有纪律） */
export interface GoalCompletionRejectionFact {
  readonly reachable: boolean
  readonly producer: string
  readonly blocker?: string
}

export const GOAL_COMPLETION_REJECTION_FACTS: Readonly<
  Record<GoalCompletionRejectionCode, GoalCompletionRejectionFact>
> = {
  completion_evidence_missing: {
    reachable: true,
    producer: 'judgeGoalCompletion · evidenceRefs 为空 / 引用的对象查不到',
  },
  completion_evidence_kind_mismatch: {
    reachable: true,
    producer: 'judgeGoalCompletion · basis ≠ criterion.kind / 证据角色不对（如拿她的输出当 user_report）',
  },
  completion_evidence_revision_stale: {
    reachable: true,
    producer: 'judgeGoalCompletion · expectedRevision 与目标 / 承诺**各自**的当前 revision 不符',
  },
  completion_evidence_not_executed: {
    reachable: true,
    producer: 'judgeGoalCompletion · accepted=true 但 executed=false',
  },
  completion_evidence_failed: {
    reachable: true,
    producer: 'judgeGoalCompletion · status ∈ {rejected, failed, partial, timeout, cancelled, …}',
  },
  completion_structure_check_failed: {
    reachable: true,
    producer: 'judgeGoalCompletion · conversation_output 的结构检查不过（计数不足 / 标记缺失）',
  },
  completion_target_not_found: {
    reachable: true,
    producer: 'judgeGoalCompletion · 目标不存在 / 承诺不存在 / target 与实参不符',
  },
  completion_target_terminal: {
    reachable: true,
    producer: 'judgeGoalCompletion · 目标或承诺已是终态',
  },
  completion_source_not_established: {
    reachable: true,
    producer: 'judgeGoalCompletion · user_report 的证据事件归因不是 ESTABLISHED',
  },
  completion_evidence_unavailable: {
    reachable: true,
    producer: 'judgeGoalCompletion · 任一端口抛错（**失败关闭**，不当"没证据"）',
  },
}

// ---------------------------------------------------------------------------
// 输入 / 结论
// ---------------------------------------------------------------------------

export type GoalCompletionTarget = 'goal' | 'commitment'

export interface GoalCompletionInput {
  readonly ports: GoalCompletionPorts
  readonly characterId: string
  /** 要判的是目标还是承诺 */
  readonly target: GoalCompletionTarget
  readonly goal: GoalState
  /** `target === 'commitment'` 时必填 */
  readonly commitment?: CommitmentState | null
  /** 目标与承诺**各自独立** —— 调用方按 `target` 给对应的当前 revision */
  readonly expectedRevision: number
  readonly basis: GoalCompletionBasis
  readonly evidenceRefs: readonly GoalSourceRef[]
  /** 该轮的用户事件 id（`conversation_output` 要求 assistant 事件回应它） */
  readonly turnUserEventId: string
}

/** 结论（**不带任何正文** —— 性质 ①） */
export type GoalCompletionVerdict =
  | {
      readonly ok: true
      readonly target: GoalCompletionTarget
      readonly basis: GoalCompletionBasis
      /** 只带**计数与角色**，不带内容 */
      readonly detail: {
        readonly evidenceCount: number
        readonly checkedItems?: number
        readonly matchedMarkers?: number
      }
    }
  | {
      readonly ok: false
      readonly code: GoalCompletionRejectionCode
      readonly detail: string
    }

// ---------------------------------------------------------------------------
// 结构检查（闭集；**确定性、可解释**，不做语义判断）
// ---------------------------------------------------------------------------

/** 列表项的行首形态：编号（`1.` / `1、` / `1)`）或项目符号（`-` / `*` / `•`） */
const LIST_ITEM_LINE = /^\s*(?:\d+[.、)]|[-*•])\s+\S/

/**
 * `conversation_output` 的结构检查。
 *
 * ```text
 * item_count   输出里的**列表项数** ≥ count
 * marker_set   每一个标记都**逐字**出现在输出里
 * ```
 *
 * ⚠️ 它**只**回答"结构在不在"。内容是否正确、建议是否有用，**不在**这里判
 *    （那是人审 / 语义评测的事）；本函数的存在是为了让"程序能证明的那一部分"
 *    与"程序证明不了的那一部分"**分得开**。
 */
export function checkConversationOutputStructure(
  criterion: Extract<GoalSuccessCriterion, { kind: 'conversation_output' }>,
  text: string,
): { readonly ok: true; readonly checkedItems: number; readonly matchedMarkers: number } | {
  readonly ok: false
  readonly detail: string
} {
  if (criterion.structure.kind === 'item_count') {
    const items = text.split(/\r?\n/).filter((line) => LIST_ITEM_LINE.test(line)).length
    if (items < criterion.structure.count) {
      return {
        ok: false,
        detail: `约定的列表项数 ${String(criterion.structure.count)}，实际认出 ${String(items)} 项`,
      }
    }
    return { ok: true, checkedItems: items, matchedMarkers: 0 }
  }
  const markers = criterion.structure.markers
  const missing = markers.filter((marker) => !text.includes(marker))
  if (missing.length > 0) {
    return { ok: false, detail: `约定的标记缺失 ${String(missing.length)} 个（不列出具体文本）` }
  }
  return { ok: true, checkedItems: 0, matchedMarkers: markers.length }
}

// ---------------------------------------------------------------------------
// 判定
// ---------------------------------------------------------------------------

function fail(code: GoalCompletionRejectionCode, detail: string): GoalCompletionVerdict {
  return { ok: false, code, detail }
}

/**
 * 判一次完成。
 *
 * 顺序：目标 / 承诺存在 → 非终态 → **revision 相符** → basis 与 criterion 一对一
 * → 依据非空 → basis 专属检查。任一端口抛错 ⇒ `completion_evidence_unavailable`。
 */
export async function judgeGoalCompletion(
  input: GoalCompletionInput,
): Promise<GoalCompletionVerdict> {
  /* ---- 目标 / 承诺的存在与终态 ---- */
  if (String(input.goal.characterId) !== input.characterId) {
    return fail('completion_target_not_found', '目标不属于本角色')
  }
  if (input.target === 'commitment') {
    if (input.commitment === undefined || input.commitment === null) {
      return fail('completion_target_not_found', '这一轮判的是承诺，但目标上没有承诺')
    }
    if (isCommitmentTerminal(input.commitment.status)) {
      return fail(
        'completion_target_terminal',
        `承诺已是终态 ${input.commitment.status}（幂等由 processed_operations 负责，不靠再发一次）`,
      )
    }
  } else {
    if (isGoalTerminal(input.goal.status)) {
      return fail('completion_target_terminal', `目标已是终态 ${input.goal.status}`)
    }
  }

  /* ---- 各自独立的乐观锁 ---- */
  const currentRevision =
    input.target === 'commitment'
      ? (input.commitment as CommitmentState).revision
      : input.goal.revision
  if (input.expectedRevision !== currentRevision) {
    return fail(
      'completion_evidence_revision_stale',
      `期望 revision=${String(input.expectedRevision)}，当前 ${String(currentRevision)}` +
        '（迟到结果不得完成新约定）',
    )
  }

  /* ---- basis 与 criterion 一对一 ---- */
  const criterion =
    input.target === 'commitment'
      ? (input.commitment as CommitmentState).criterion
      : input.goal.successCriterion
  if (input.basis !== criterion.kind) {
    return fail(
      'completion_evidence_kind_mismatch',
      `依据 ${input.basis} 与 criterion ${criterion.kind} 不匹配（一对一，无例外）`,
    )
  }

  /* ---- 依据非空 ---- */
  if (input.evidenceRefs.length === 0) {
    return fail('completion_evidence_missing', '完成必须带依据（evidenceRefs 非空）')
  }
  const ids = input.evidenceRefs.map((ref) => String(ref.conversationEventId))

  try {
    switch (input.basis) {
      case 'user_report': {
        const events = await input.ports.conversation.findEvents(ids)
        const byId = new Map(events.map((event) => [String(event.id), event]))
        const found = ids.map((id) => byId.get(id)).filter((event) => event !== undefined)
        if (found.length === 0) {
          return fail('completion_evidence_missing', '引用的对话事件查不到')
        }
        /*
         * ⚠️ **她的输出永远不能当 user_report**：依据事件必须是**用户**发的。
         *    这条把"我已经帮你做完了"那类自述彻底挡在门外（§9.1）。
         */
        const foreignActor = found.filter((event) => event.actorType !== 'user')
        if (foreignActor.length > 0) {
          return fail(
            'completion_evidence_kind_mismatch',
            `user_report 的依据必须是**用户**的对话事件（收到 ${found.map((e) => e.actorType).join(',')}）` +
              '—— 她的输出不能自我确认',
          )
        }
        const foreignOwner = found.filter(
          (event) => String(event.characterId) !== input.characterId,
        )
        if (foreignOwner.length > 0) {
          return fail('completion_evidence_kind_mismatch', '依据事件属于别的角色')
        }
        const unqualified = found.filter((event) => event.qualification !== 'ESTABLISHED')
        if (unqualified.length > 0) {
          return fail(
            'completion_source_not_established',
            `user_report 的归因不是 ESTABLISHED（收到 ${unqualified.map((e) => e.qualification).join(',')}）`,
          )
        }
        return {
          ok: true,
          target: input.target,
          basis: input.basis,
          detail: { evidenceCount: found.length },
        }
      }

      case 'conversation_output': {
        const events = await input.ports.assistant.findAssistantEvents(ids)
        if (events.length === 0) {
          return fail(
            'completion_evidence_missing',
            '引用的 assistant 事件查不到（**未落盘**的输出不能作为交付证据）',
          )
        }
        const event = events[0]!
        if (String(event.characterId) !== input.characterId) {
          return fail('completion_evidence_kind_mismatch', '交付产物属于别的角色')
        }
        if (event.actorType === 'user') {
          return fail(
            'completion_evidence_kind_mismatch',
            'conversation_output 的依据必须是角色自己的正式输出',
          )
        }
        if (
          event.replyToEventId === undefined ||
          String(event.replyToEventId) !== String(input.turnUserEventId)
        ) {
          return fail(
            'completion_evidence_kind_mismatch',
            '交付产物不是对这一轮输入的回应（轮次不符）',
          )
        }
        const structure = checkConversationOutputStructure(
          criterion as Extract<GoalSuccessCriterion, { kind: 'conversation_output' }>,
          event.text,
        )
        if (!structure.ok) {
          return fail('completion_structure_check_failed', structure.detail)
        }
        return {
          ok: true,
          target: input.target,
          basis: input.basis,
          detail: {
            evidenceCount: events.length,
            checkedItems: structure.checkedItems,
            matchedMarkers: structure.matchedMarkers,
          },
        }
      }

      case 'action_result': {
        const actions = await input.ports.actions.findActions(ids)
        if (actions.length === 0) {
          return fail('completion_evidence_missing', '引用的 ActionResult 查不到')
        }
        const action = actions[0]!
        if (String(action.characterId) !== input.characterId) {
          return fail('completion_evidence_kind_mismatch', '动作属于别的角色')
        }
        const expected = criterion as Extract<GoalSuccessCriterion, { kind: 'action_result' }>
        if (
          String(action.capability) !== expected.capability ||
          String(action.operation) !== expected.operation
        ) {
          return fail(
            'completion_evidence_kind_mismatch',
            `动作与 criterion 不符（期望 ${expected.capability}/${expected.operation}，` +
              `收到 ${action.capability}/${action.operation}）`,
          )
        }
        /* 顺序要紧：先判"执行了没有"，再判"成功没有" —— 两者是两个可区分的码 */
        if (!action.executed) {
          return fail(
            'completion_evidence_not_executed',
            `accepted=${String(action.accepted)} 但 executed=false（策略允许 ≠ 真的执行了）`,
          )
        }
        if (action.status !== 'success') {
          return fail(
            'completion_evidence_failed',
            `动作状态是 ${action.status}（partial / timeout / failed 都不能代替完成）`,
          )
        }
        return {
          ok: true,
          target: input.target,
          basis: input.basis,
          detail: { evidenceCount: actions.length },
        }
      }

      default:
        return fail(
          'completion_evidence_kind_mismatch',
          `未知的依据类型 ${String(input.basis)}`,
        )
    }
  } catch (error) {
    /*
     * ⚠️ **失败关闭**：读不到不是"没证据"，也不是"通过了"。
     *    它是第三种事实，有自己的码。
     */
    return fail(
      'completion_evidence_unavailable',
      `证据读取失败：${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

// ---------------------------------------------------------------------------
// 两个崩溃窗口（§4.11）
// ---------------------------------------------------------------------------

/**
 * 一轮结束时**如实**收集到的事实。
 *
 * ⚠️ 它们是**事实**（程序读出来的），不是推断：`replyPersisted` 的含义是
 *    "那条 assistant 事件真的在库里"，不是"我们打算写它"。
 */
export interface GoalTurnFacts {
  /** 承诺 / 目标变更已提交？ */
  readonly mutationCommitted: boolean
  /** 该轮的 assistant 事件是否**已落盘** */
  readonly replyPersisted: boolean
  /** 已落盘的结果引用存在（对话产物或 ActionResult）？ */
  readonly resultPersisted: boolean
  /** 兑现 / 完成事件是否已提交？ */
  readonly fulfillmentCommitted: boolean
}

export type GoalCrashWindow =
  | 'none'
  /** A：变更已提交、回复**未**落盘 —— "用户已收到确认"**未知** */
  | 'window_a'
  /** B：结果已落盘、兑现事件**未**提交 */
  | 'window_b'

export interface GoalCrashWindowVerdict {
  readonly window: GoalCrashWindow
  /** 恢复动作（具名） */
  readonly action?: 'read_back_and_explain' | 'idempotent_backfill'
  /** 恢复时**禁止**做的事（具名，不合并） */
  readonly mustNot?: readonly string[]
}

/**
 * 分辨两个崩溃窗口（§4.11）。
 *
 * ```text
 * window A  变更已提交、回复未落盘
 *           ⇒ 恢复动作：下一轮**读回并如实解释**（记录在、用户是否看到**未知**）
 *           ⇒ **禁止**补造 assistant 事件（那会把"她可能没看到"变成"她一定看到了"）
 * window B  结果已落盘、兑现事件未提交
 *           ⇒ 恢复动作：按**持久结果引用**做幂等补记
 *           ⇒ **禁止**重新生成产物；**禁止**重发副作用（否则完成一次要做两遍）
 * ```
 *
 * ⚠️ 优先级：**B 先于 A**。若两者同时在场（结果已落盘但兑现没提交，且回复也没落盘），
 *    先收敛 B 是安全的 —— 补记是幂等的、不产生新的用户可见动作；而 A 的处置
 *    （读回并解释）依赖"这一轮到底有没有真的发生"，那要等 B 收敛后才有定论。
 */
export function classifyGoalCrashWindow(facts: GoalTurnFacts): GoalCrashWindowVerdict {
  if (facts.resultPersisted && !facts.fulfillmentCommitted) {
    return {
      window: 'window_b',
      action: 'idempotent_backfill',
      mustNot: ['regenerate_artifact', 'resend_side_effect'],
    }
  }
  if (facts.mutationCommitted && !facts.replyPersisted) {
    return {
      window: 'window_a',
      action: 'read_back_and_explain',
      mustNot: ['fabricate_assistant_event'],
    }
  }
  return { window: 'none' }
}

// ---------------------------------------------------------------------------
// 有界 reconciliation（**不扫会话历史** —— D23 的绊线）
// ---------------------------------------------------------------------------

/**
 * 单次调用最多处理多少个待收敛项（§4.11 的冻结值）。
 *
 * ⚠️ 它同时是 **`D23` 绊线的机器判据**的一部分：本模块的 reconciliation
 *    **只**由显式 pending 标记驱动，因此"要处理多少"与"会话历史有多长"无关。
 */
export const GOAL_RECONCILIATION_MAX_ITEMS = 32

/**
 * 一个**待收敛项**（由投影行里的显式 pending 标记给出）。
 *
 * ⚠️ 它是**标记**，不是"扫出来的候选"：写入方在提交变更时留下它，
 *    恢复方只读它。因此本层**没有**"从会话历史里找找看"的代码路径。
 */
export interface GoalPendingCompletionMarker {
  readonly goalId: string
  readonly target: GoalCompletionTarget
  readonly expectedRevision: number
  readonly basis: GoalCompletionBasis
  readonly evidenceRefs: readonly GoalSourceRef[]
  readonly recordedAt: number
}

export interface GoalReconciliationPlan {
  readonly items: readonly GoalPendingCompletionMarker[]
  /** 因超上界而未进入本次计划的条数（**如实报出**，不静默丢弃） */
  readonly truncated: number
  /** 计划的来源（**必须是** `pending_markers`：换一个值就意味着换了机制） */
  readonly source: 'pending_markers'
}

export function planGoalReconciliation(
  markers: readonly GoalPendingCompletionMarker[],
  options: { readonly maxItems?: number } = {},
): GoalReconciliationPlan {
  const max = options.maxItems ?? GOAL_RECONCILIATION_MAX_ITEMS
  /* 确定性：按 `recordedAt` 升序，同刻按 goalId 升序 —— 不依赖输入顺序 */
  const sorted = [...markers].sort((a, b) => {
    if (a.recordedAt !== b.recordedAt) return a.recordedAt - b.recordedAt
    return String(a.goalId) < String(b.goalId) ? -1 : String(a.goalId) > String(b.goalId) ? 1 : 0
  })
  return {
    items: sorted.slice(0, max),
    truncated: Math.max(0, sorted.length - max),
    source: 'pending_markers',
  }
}

/**
 * 同一个待收敛项**两次补记**是否给出同一个身份（⇒ 第二次会被 `processed_operations` 拒）。
 *
 * ⚠️ 这是"无二次副作用"的**结构**依据：身份由
 *    `(目标, revision, 依据类型, 第一条结果引用)` 决定（`D26`），
 *    与**跑了几次**无关。
 */
export function goalCompletionUnitOf(marker: GoalPendingCompletionMarker): string {
  const firstRef = marker.evidenceRefs[0]?.conversationEventId ?? ''
  if (marker.target === 'commitment') {
    return `commitment-fulfilled:${marker.goalId}:${String(marker.expectedRevision)}:${String(firstRef)}`
  }
  return `goal-completed:${marker.goalId}:${String(marker.expectedRevision)}`
}
