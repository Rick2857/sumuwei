/**
 * M10 WP6 —— **完成判定 / 假兑现 / 崩溃恢复门**（`pnpm m10:completion:verify`）。
 *
 * ============================================================================
 *  本门测什么（计划 §12 WP6 的四条出口判据，逐条对应）
 * ============================================================================
 * ```text
 * ① 三种依据互不替代            → J 组（每一条依据的正控 + 别人冒充它的负控）
 * ② conversation_output 必须绑定**已落库**的 assistant event → J5 / J7
 * ③ 迟到结果按 expectedRevision 判 stale → J13（goal 与 commitment **各一条**）
 * ④ 两个崩溃窗口各有恢复路径且**无二次副作用** → P 组 + R 组 + I 组
 * ```
 *
 * ============================================================================
 *  硬边界
 * ============================================================================
 *  · **零模型调用、零出网、零真实库**：端口是**注入的读数**，判定是纯编排。
 *  · 结论**不带正文**（`S2` 结构性检查）。
 *  · 每条计数都有非零分母。
 *  · 阶段进度写 stderr；失败路径强退（WP2 的教训）。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { createM10RunId, openM10RunDir, writeM10Manifest } from './m10-evidence.ts'
import { entityRef } from '../src/kernel/contracts/index.ts'
import type { ProposedDomainEvent } from '../src/kernel/contracts/proposal.ts'
import {
  COMMITMENT_FULFILLED,
  GOAL_COMPLETED,
  createFullDomainEventRegistry,
} from '../src/kernel/contracts/domain-event.ts'
import {
  GOAL_SOURCE_REFS_MAX,
  type CommitmentState,
  type GoalCompletionBasis,
  type GoalSourceRef,
  type GoalState,
  type GoalSuccessCriterion,
} from '../src/kernel/contracts/goal.ts'
import {
  GOAL_COMPLETION_REJECTION_CODES,
  GOAL_COMPLETION_REJECTION_FACTS,
  GOAL_RECONCILIATION_MAX_ITEMS,
  checkConversationOutputStructure,
  classifyGoalCrashWindow,
  goalCompletionUnitOf,
  judgeGoalCompletion,
  planGoalReconciliation,
  type GoalActionResultReading,
  type GoalAssistantEventReading,
  type GoalCompletionInput,
  type GoalCompletionPorts,
  type GoalPendingCompletionMarker,
  type GoalUserEventReading,
} from '../src/kernel/app/goal/completion.ts'
import { goalProposalOf, validateGoalProposal } from '../src/kernel/policies/goal-validator.ts'

const REPO_ROOT = resolve(process.cwd())
const CHARACTER = 'char_m10_wp6'
const USER_ID = 'm10-wp6-user'
const USER_EVENT = 'cev:m10-wp6-user-turn'
const ASSISTANT_EVENT = 'cev:m10-wp6-assistant-turn'
const ACTION_ID = 'act:m10-wp6-1'
const M10_T0 = 2_100_000_000_000

function phase(mark: string): void {
  console.error(`[m10-completion] ${mark}`)
}

// ---------------------------------------------------------------------------
// 量具
// ---------------------------------------------------------------------------

interface Check {
  group: 'J' | 'P' | 'R' | 'I' | 'S'
  id: string
  label: string
  expected: string
  actual: string
  pass: boolean
}

const checks: Check[] = []
function record(
  group: Check['group'],
  id: string,
  label: string,
  expected: string,
  actual: string,
  pass: boolean,
): void {
  checks.push({ group, id, label, expected, actual, pass })
}

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

/** 三个列表项的正式输出（满足 `item_count: 3`） */
const THREE_ITEM_OUTPUT = ['1. 先列三章提纲', '2. 再补第二章材料', '3. 最后统一措辞'].join('\n')

function sourceRef(eventId: string): GoalSourceRef {
  return { conversationEventId: eventId as never, fingerprint: 'fp' }
}

function goalState(override: Partial<GoalState> = {}): GoalState {
  return {
    goalId: 'gol:wp6' as GoalState['goalId'],
    characterId: CHARACTER,
    owner: entityRef('character', CHARACTER),
    targetEntity: entityRef('user', USER_ID),
    origin: 'user_requested',
    sourceRefs: [sourceRef(USER_EVENT)],
    revision: 5,
    statement: '下次继续时给三个步骤',
    successCriterion: { kind: 'user_report' },
    status: 'active',
    priority: 'normal',
    dependencies: [],
    time: { recordedAt: M10_T0 },
    ...override,
  }
}

function commitmentState(override: Partial<CommitmentState> = {}): CommitmentState {
  return {
    commitmentId: 'cmt:wp6' as CommitmentState['commitmentId'],
    goalId: 'gol:wp6' as never,
    actor: entityRef('character', CHARACTER),
    beneficiary: entityRef('user', USER_ID),
    scope: '下次继续时给三个步骤',
    acceptedAt: M10_T0,
    acceptanceRefs: [sourceRef(USER_EVENT)],
    criterion: { kind: 'conversation_output', structure: { kind: 'item_count', count: 3 } },
    status: 'active',
    completionRefs: [],
    revision: 2,
    ...override,
  }
}

function portsWith(override: {
  conversation?: readonly GoalUserEventReading[]
  assistant?: readonly GoalAssistantEventReading[]
  actions?: readonly GoalActionResultReading[]
  throws?: boolean
}): GoalCompletionPorts {
  if (override.throws === true) {
    return {
      conversation: {
        findEvents: async () => {
          throw new Error('注入的读失败（负控）')
        },
      },
      assistant: {
        findAssistantEvents: async () => {
          throw new Error('注入的读失败（负控）')
        },
      },
      actions: {
        findActions: async () => {
          throw new Error('注入的读失败（负控）')
        },
      },
    }
  }
  return {
    conversation: { findEvents: async () => override.conversation ?? [] },
    assistant: { findAssistantEvents: async () => override.assistant ?? [] },
    actions: { findActions: async () => override.actions ?? [] },
  }
}

const USER_READING: GoalUserEventReading = {
  id: USER_EVENT,
  characterId: CHARACTER,
  actorType: 'user',
  qualification: 'ESTABLISHED',
}

const ASSISTANT_READING: GoalAssistantEventReading = {
  id: ASSISTANT_EVENT,
  characterId: CHARACTER,
  actorType: 'character',
  replyToEventId: USER_EVENT,
  text: THREE_ITEM_OUTPUT,
}

const ACTION_READING: GoalActionResultReading = {
  actionId: ACTION_ID,
  characterId: CHARACTER,
  capability: 'web.search',
  operation: 'search',
  accepted: true,
  executed: true,
  status: 'success',
}

const ACTION_CRITERION: Extract<GoalSuccessCriterion, { kind: 'action_result' }> = {
  kind: 'action_result',
  capability: 'web.search',
  operation: 'search',
  require: 'executed_succeeded',
}

async function judge(override: Partial<GoalCompletionInput> & { ports: GoalCompletionPorts }): Promise<
  Awaited<ReturnType<typeof judgeGoalCompletion>>
> {
  return judgeGoalCompletion({
    characterId: CHARACTER,
    target: 'goal',
    goal: goalState(),
    expectedRevision: 5,
    basis: 'user_report',
    evidenceRefs: [sourceRef(USER_EVENT)],
    turnUserEventId: USER_EVENT,
    ...override,
  })
}

function describe(verdict: Awaited<ReturnType<typeof judgeGoalCompletion>>): string {
  return verdict.ok
    ? `ok(${verdict.basis} · evidence=${String(verdict.detail.evidenceCount)})`
    : `${verdict.code}`
}

// ---------------------------------------------------------------------------
// J 组：三种依据互不替代
// ---------------------------------------------------------------------------

async function judgementChecks(): Promise<void> {
  const cases: {
    id: string
    label: string
    expected: string
    run: () => Promise<Awaited<ReturnType<typeof judgeGoalCompletion>>>
    pass: (v: Awaited<ReturnType<typeof judgeGoalCompletion>>) => boolean
  }[] = [
    {
      id: 'J1',
      label: '【正控】`user_report` + 用户事件 + 归因 ESTABLISHED ⇒ 通过',
      expected: 'ok(user_report)',
      run: () => judge({ ports: portsWith({ conversation: [USER_READING] }) }),
      pass: (v) => v.ok && v.basis === 'user_report',
    },
    {
      id: 'J2',
      label: '【负控·**她的输出不能自我确认**】拿 assistant 事件当 `user_report` 依据 ⇒ `kind_mismatch`',
      expected: 'completion_evidence_kind_mismatch',
      run: () =>
        judge({
          ports: portsWith({
            conversation: [
              { ...USER_READING, actorType: 'character', id: ASSISTANT_EVENT },
            ],
          }),
          evidenceRefs: [sourceRef(ASSISTANT_EVENT)],
        }),
      pass: (v) => !v.ok && v.code === 'completion_evidence_kind_mismatch',
    },
    {
      id: 'J3',
      label: '【负控】`user_report` 的归因不是 ESTABLISHED ⇒ `source_not_established`',
      expected: 'completion_source_not_established',
      run: () =>
        judge({
          ports: portsWith({
            conversation: [{ ...USER_READING, qualification: 'UNCONFIRMED_ORIGIN' }],
          }),
        }),
      pass: (v) => !v.ok && v.code === 'completion_source_not_established',
    },
    {
      id: 'J4',
      label: '【正控】`conversation_output` + **已落库**的 assistant 事件 + 结构达标（3 项）⇒ 通过'
        + '，且结论只带计数',
      expected: 'ok(conversation_output · evidence=1 · items=3)',
      run: () =>
        judge({
          ports: portsWith({ assistant: [ASSISTANT_READING] }),
          goal: goalState({
            successCriterion: {
              kind: 'conversation_output',
              structure: { kind: 'item_count', count: 3 },
            },
          }),
          basis: 'conversation_output',
          evidenceRefs: [sourceRef(ASSISTANT_EVENT)],
        }),
      pass: (v) =>
        v.ok &&
        v.basis === 'conversation_output' &&
        v.detail.evidenceCount === 1 &&
        v.detail.checkedItems === 3,
    },
    {
      id: 'J5',
      label: '【负控·**未落盘的输出不能算交付**】assistant 事件查不到 ⇒ `evidence_missing`',
      expected: 'completion_evidence_missing',
      run: () =>
        judge({
          ports: portsWith({ assistant: [] }),
          goal: goalState({
            successCriterion: {
              kind: 'conversation_output',
              structure: { kind: 'item_count', count: 3 },
            },
          }),
          basis: 'conversation_output',
          evidenceRefs: [sourceRef(ASSISTANT_EVENT)],
        }),
      pass: (v) => !v.ok && v.code === 'completion_evidence_missing',
    },
    {
      id: 'J6',
      label: '【负控】结构不达标（约定 3 项，输出只有 2 项）⇒ `structure_check_failed`',
      expected: 'completion_structure_check_failed',
      run: () =>
        judge({
          ports: portsWith({
            assistant: [{ ...ASSISTANT_READING, text: '1. 一\n2. 二' }],
          }),
          goal: goalState({
            successCriterion: {
              kind: 'conversation_output',
              structure: { kind: 'item_count', count: 3 },
            },
          }),
          basis: 'conversation_output',
          evidenceRefs: [sourceRef(ASSISTANT_EVENT)],
        }),
      pass: (v) => !v.ok && v.code === 'completion_structure_check_failed',
    },
    {
      id: 'J7',
      label: '【负控】交付产物回应的**不是这一轮** ⇒ `kind_mismatch`（轮次不符）',
      expected: 'completion_evidence_kind_mismatch',
      run: () =>
        judge({
          ports: portsWith({
            assistant: [{ ...ASSISTANT_READING, replyToEventId: 'cev:some-other-turn' }],
          }),
          goal: goalState({
            successCriterion: {
              kind: 'conversation_output',
              structure: { kind: 'item_count', count: 3 },
            },
          }),
          basis: 'conversation_output',
          evidenceRefs: [sourceRef(ASSISTANT_EVENT)],
        }),
      pass: (v) => !v.ok && v.code === 'completion_evidence_kind_mismatch',
    },
    {
      id: 'J8',
      label: '`marker_set` 结构检查：标记齐全 ⇒ 通过；缺一个 ⇒ 失败（与 `item_count` 并列的第二种结构）',
      expected: '2/2 分支正确',
      run: async () => {
        const criterion: Extract<GoalSuccessCriterion, { kind: 'conversation_output' }> = {
          kind: 'conversation_output',
          structure: { kind: 'marker_set', markers: ['提纲', '材料'] },
        }
        const okVerdict = checkConversationOutputStructure(criterion, '先写提纲，再补材料')
        const badVerdict = checkConversationOutputStructure(criterion, '先写提纲')
        return okVerdict.ok && !badVerdict.ok
          ? ({ ok: true, target: 'goal', basis: 'conversation_output', detail: { evidenceCount: 1 } } as never)
          : ({ ok: false, code: 'completion_structure_check_failed', detail: 'x' } as never)
      },
      pass: (v) => v.ok,
    },
    {
      id: 'J9',
      label: '【正控】`action_result` + executed && success ⇒ 通过',
      expected: 'ok(action_result)',
      run: () =>
        judge({
          ports: portsWith({ actions: [ACTION_READING] }),
          goal: goalState({ successCriterion: ACTION_CRITERION }),
          basis: 'action_result',
          evidenceRefs: [sourceRef(ACTION_ID)],
        }),
      pass: (v) => v.ok && v.basis === 'action_result',
    },
    {
      id: 'J10',
      label: '【负控·`G29`】`accepted=true` 但 `executed=false` ⇒ `not_executed`'
        + '（策略允许 ≠ 真的执行了）',
      expected: 'completion_evidence_not_executed',
      run: () =>
        judge({
          ports: portsWith({ actions: [{ ...ACTION_READING, executed: false }] }),
          goal: goalState({ successCriterion: ACTION_CRITERION }),
          basis: 'action_result',
          evidenceRefs: [sourceRef(ACTION_ID)],
        }),
      pass: (v) => !v.ok && v.code === 'completion_evidence_not_executed',
    },
    {
      id: 'J11',
      label: '【负控·`G30`】`failed` / `timeout` / `partial` ⇒ `evidence_failed`（都不代替完成）',
      expected: '3/3 都是 completion_evidence_failed',
      run: async () => {
        const statuses = ['failed', 'timeout', 'partial']
        const verdicts = await Promise.all(
          statuses.map((status) =>
            judge({
              ports: portsWith({ actions: [{ ...ACTION_READING, status }] }),
              goal: goalState({ successCriterion: ACTION_CRITERION }),
              basis: 'action_result',
              evidenceRefs: [sourceRef(ACTION_ID)],
            }),
          ),
        )
        const allFailed = verdicts.every((v) => !v.ok && v.code === 'completion_evidence_failed')
        return allFailed
          ? ({ ok: true, target: 'goal', basis: 'action_result', detail: { evidenceCount: 1 } } as never)
          : ({ ok: false, code: 'completion_evidence_failed', detail: 'x' } as never)
      },
      pass: (v) => v.ok,
    },
    {
      id: 'J12',
      label: '【负控·`G31`】动作的 capability/operation 与 criterion 不符 ⇒ `kind_mismatch`'
        + '（按存下来的 id 匹配，不做正文匹配）',
      expected: 'completion_evidence_kind_mismatch',
      run: () =>
        judge({
          ports: portsWith({ actions: [{ ...ACTION_READING, operation: 'other-op' }] }),
          goal: goalState({ successCriterion: ACTION_CRITERION }),
          basis: 'action_result',
          evidenceRefs: [sourceRef(ACTION_ID)],
        }),
      pass: (v) => !v.ok && v.code === 'completion_evidence_kind_mismatch',
    },
    {
      id: 'J13',
      label: '【负控】动作属于**别的角色** ⇒ `kind_mismatch`（隔离）',
      expected: 'completion_evidence_kind_mismatch',
      run: () =>
        judge({
          ports: portsWith({ actions: [{ ...ACTION_READING, characterId: 'char_other' }] }),
          goal: goalState({ successCriterion: ACTION_CRITERION }),
          basis: 'action_result',
          evidenceRefs: [sourceRef(ACTION_ID)],
        }),
      pass: (v) => !v.ok && v.code === 'completion_evidence_kind_mismatch',
    },
    {
      id: 'J14',
      label: '【负控·`G32`·**目标**】迟到结果（expectedRevision 不符）⇒ `revision_stale`',
      expected: 'completion_evidence_revision_stale',
      run: () => judge({ ports: portsWith({ conversation: [USER_READING] }), expectedRevision: 4 }),
      pass: (v) => !v.ok && v.code === 'completion_evidence_revision_stale',
    },
    {
      id: 'J15',
      label: '【负控·`G32`·**承诺**】承诺有**自己独立**的 revision：goal 的 5 对了也不够 ⇒ `revision_stale`',
      expected: 'completion_evidence_revision_stale（用承诺的 revision=2 判）',
      run: () =>
        judge({
          ports: portsWith({ assistant: [ASSISTANT_READING] }),
          target: 'commitment',
          commitment: commitmentState({ revision: 2 }),
          expectedRevision: 5,
          basis: 'conversation_output',
          evidenceRefs: [sourceRef(ASSISTANT_EVENT)],
        }),
      pass: (v) => !v.ok && v.code === 'completion_evidence_revision_stale',
    },
    {
      id: 'J16',
      label: '【负控】basis 与 criterion **不匹配** ⇒ `kind_mismatch`（一对一，无例外）',
      expected: 'completion_evidence_kind_mismatch',
      run: () =>
        judge({
          ports: portsWith({ actions: [ACTION_READING] }),
          goal: goalState({ successCriterion: ACTION_CRITERION }),
          basis: 'user_report',
          evidenceRefs: [sourceRef(ACTION_ID)],
        }),
      pass: (v) => !v.ok && v.code === 'completion_evidence_kind_mismatch',
    },
    {
      id: 'J17',
      label: '【负控】目标已是终态 ⇒ `target_terminal`',
      expected: 'completion_target_terminal',
      run: () =>
        judge({
          ports: portsWith({ conversation: [USER_READING] }),
          goal: goalState({ status: 'completed' }),
        }),
      pass: (v) => !v.ok && v.code === 'completion_target_terminal',
    },
    {
      id: 'J18',
      label: '【负控】判承诺但目标上**没有**承诺 ⇒ `target_not_found`',
      expected: 'completion_target_not_found',
      run: () =>
        judge({ ports: portsWith({}), target: 'commitment', commitment: null }),
      pass: (v) => !v.ok && v.code === 'completion_target_not_found',
    },
    {
      id: 'J19',
      label: '【负控】依据为空 ⇒ `evidence_missing`',
      expected: 'completion_evidence_missing',
      run: () => judge({ ports: portsWith({ conversation: [USER_READING] }), evidenceRefs: [] }),
      pass: (v) => !v.ok && v.code === 'completion_evidence_missing',
    },
    {
      id: 'J20',
      label: '【负控·**失败关闭**】端口抛错 ⇒ `evidence_unavailable`'
        + '（不是"没证据"，也**不是**通过）',
      expected: 'completion_evidence_unavailable',
      run: () => judge({ ports: portsWith({ throws: true }) }),
      pass: (v) => !v.ok && v.code === 'completion_evidence_unavailable',
    },
    {
      id: 'J21',
      label: '【负控】目标不属于本角色 ⇒ `target_not_found`',
      expected: 'completion_target_not_found',
      run: () =>
        judge({
          ports: portsWith({ conversation: [USER_READING] }),
          goal: goalState({ characterId: 'char_other' }),
        }),
      pass: (v) => !v.ok && v.code === 'completion_target_not_found',
    },
  ]

  for (const testCase of cases) {
    const verdict = await testCase.run()
    record('J', testCase.id, testCase.label, testCase.expected, describe(verdict), testCase.pass(verdict))
  }
}

// ---------------------------------------------------------------------------
// P 组：两个崩溃窗口
// ---------------------------------------------------------------------------

function crashWindowChecks(): void {
  const windowA = classifyGoalCrashWindow({
    mutationCommitted: true,
    replyPersisted: false,
    resultPersisted: false,
    fulfillmentCommitted: false,
  })
  record(
    'P',
    'P1',
    '**窗口 A**（变更已提交、回复未落盘）⇒ `window_a`，恢复动作 = **读回并如实解释**',
    'window_a · read_back_and_explain',
    `${windowA.window}${windowA.action !== undefined ? ` · ${windowA.action}` : ''}`,
    windowA.window === 'window_a' && windowA.action === 'read_back_and_explain',
  )

  record(
    'P',
    'P2',
    '窗口 A **禁止**补造 assistant 事件（那会把"她可能没看到"变成"她一定看到了"）',
    'mustNot 含 fabricate_assistant_event',
    JSON.stringify(windowA.mustNot ?? []),
    (windowA.mustNot ?? []).includes('fabricate_assistant_event'),
  )

  const windowB = classifyGoalCrashWindow({
    mutationCommitted: true,
    replyPersisted: true,
    resultPersisted: true,
    fulfillmentCommitted: false,
  })
  record(
    'P',
    'P3',
    '**窗口 B**（结果已落盘、兑现未提交）⇒ `window_b`，恢复动作 = **幂等补记**',
    'window_b · idempotent_backfill',
    `${windowB.window}${windowB.action !== undefined ? ` · ${windowB.action}` : ''}`,
    windowB.window === 'window_b' && windowB.action === 'idempotent_backfill',
  )

  record(
    'P',
    'P4',
    '窗口 B **禁止**重新生成产物、**禁止**重发副作用（否则完成一次要做两遍）',
    'mustNot 含 regenerate_artifact 与 resend_side_effect',
    JSON.stringify(windowB.mustNot ?? []),
    (windowB.mustNot ?? []).includes('regenerate_artifact') &&
      (windowB.mustNot ?? []).includes('resend_side_effect'),
  )

  const none = classifyGoalCrashWindow({
    mutationCommitted: true,
    replyPersisted: true,
    resultPersisted: true,
    fulfillmentCommitted: true,
  })
  record(
    'P',
    'P5',
    '【正控】四件事都完成 ⇒ `none`（不得过度触发恢复）',
    'none',
    none.window,
    none.window === 'none',
  )

  const both = classifyGoalCrashWindow({
    mutationCommitted: true,
    replyPersisted: false,
    resultPersisted: true,
    fulfillmentCommitted: false,
  })
  record(
    'P',
    'P6',
    '【优先级】两个窗口同时在场 ⇒ **先收敛 B**（补记是幂等的、不产生新的用户可见动作）',
    'window_b',
    both.window,
    both.window === 'window_b',
  )
}

// ---------------------------------------------------------------------------
// R 组：有界 reconciliation
// ---------------------------------------------------------------------------

function markerOf(index: number): GoalPendingCompletionMarker {
  return {
    goalId: `gol:${String(index).padStart(3, '0')}`,
    target: 'goal',
    expectedRevision: 1,
    basis: 'user_report',
    evidenceRefs: [sourceRef(USER_EVENT)],
    recordedAt: M10_T0 + index,
  }
}

function reconciliationChecks(): void {
  const markers = Array.from({ length: 45 }, (_, index) => markerOf(index))

  const plan = planGoalReconciliation(markers)
  record(
    'R',
    'R1',
    `单次计划有**硬上界**（${String(GOAL_RECONCILIATION_MAX_ITEMS)} 项）`,
    `${String(GOAL_RECONCILIATION_MAX_ITEMS)} 项`,
    `${String(plan.items.length)} 项 / 输入 ${String(markers.length)}`,
    plan.items.length === GOAL_RECONCILIATION_MAX_ITEMS &&
      GOAL_RECONCILIATION_MAX_ITEMS === 32,
  )

  record(
    'R',
    'R2',
    '超出上界的部分**如实报出**（`truncated`），不静默丢弃',
    `truncated = ${String(markers.length - GOAL_RECONCILIATION_MAX_ITEMS)}`,
    `truncated=${String(plan.truncated)}`,
    plan.truncated === markers.length - GOAL_RECONCILIATION_MAX_ITEMS,
  )

  record(
    'R',
    'R3',
    '计划来源是 `pending_markers` —— **不是**扫会话历史（`D23` 绊线的机器判据）',
    'pending_markers',
    plan.source,
    plan.source === 'pending_markers',
  )

  const deterministic = planGoalReconciliation([...markers].reverse())
  record(
    'R',
    'R4',
    '计划**确定性**：按 `recordedAt` 升序（同刻按 goalId）—— 打乱输入给同一批项',
    '两次同序',
    `${plan.items.map((m) => m.goalId).join(',') === deterministic.items.map((m) => m.goalId).join(',')}`,
    plan.items.map((m) => m.goalId).join(',') ===
      deterministic.items.map((m) => m.goalId).join(','),
  )

  const empty = planGoalReconciliation([])
  record(
    'R',
    'R5',
    '空的待收敛集合 ⇒ 空计划（**不是**错误，也不是"扫了一遍什么都没找到"）',
    '0 项 · truncated=0 · 仍是 pending_markers',
    `${String(empty.items.length)} 项 · truncated=${String(empty.truncated)} · ${empty.source}`,
    empty.items.length === 0 && empty.truncated === 0 && empty.source === 'pending_markers',
  )
}

// ---------------------------------------------------------------------------
// I 组：无二次副作用（结构与放行口两层）
// ---------------------------------------------------------------------------

async function idempotencyChecks(): Promise<void> {
  const marker = markerOf(1)
  const commitmentMarker: GoalPendingCompletionMarker = {
    ...marker,
    target: 'commitment',
    evidenceRefs: [sourceRef(ASSISTANT_EVENT)],
  }

  /*
   * ⚠️ **I1/I3 曾经是恒真的**（M10 WP11 轮次的判据审计抓到，已修）：
   *
   * ```text
   * 原判据（I1）：goalCompletionUnitOf(marker) === goalCompletionUnitOf(marker)
   *   ⇒ 纯函数、**同一个参数**、同一个表达式里调两次 ⇒ **恒真**
   * 原判据（I3）：同上再 `&& ...includes(ASSISTANT_EVENT)`
   *   ⇒ 只有后半句是真的；前半句恒真
   * ```
   * 而它们的标签声称的是"**两次补记** ⇒ 同一个身份串" —— 那需要**两次独立的构造**
   * 或一条**负控**才算测到，而原判据两样都没有。
   *
   * ⇒ 现在钉住 `D26` 的**身份构成**（`(目标, revision, 依据类型, 第一条结果引用)`），
   *   并各带负控（换 revision / 换目标 / 换结果引用 ⇒ 必须换身份）。
   *   ⚠️ 用**组合串**比对而不是写死字面量：同样强，但不会因为 `markerOf` 的 id 形状变了而误红。
   */
  const unit1 = goalCompletionUnitOf(marker)
  const unitRebuilt = goalCompletionUnitOf(markerOf(1))
  const unitOtherRevision = goalCompletionUnitOf({
    ...marker,
    expectedRevision: marker.expectedRevision + 1,
  })
  const unitOtherGoal = goalCompletionUnitOf(markerOf(2))
  record(
    'I',
    'I1',
    '同一个待收敛项两次补记 ⇒ **同一个身份串**，且它**就是** `(目标, revision)` 的组合（`D26`）——'
      + '与"跑了几次"无关。**负控**：换 `revision` ⇒ 换身份 · 换目标 ⇒ 换身份',
    '独立构造同值（=组合串）· 换 revision 异值 · 换目标异值',
    `${unit1} · 换revision=${unitOtherRevision} · 换目标=${unitOtherGoal}`,
    unit1 === unitRebuilt &&
      unit1 === `goal-completed:${marker.goalId}:${String(marker.expectedRevision)}` &&
      unit1 !== unitOtherRevision &&
      unit1 !== unitOtherGoal,
  )

  record(
    'I',
    'I2',
    '目标完成的身份串含 `expectedRevision`（`D26`：补记自带确定性事件身份，不依赖内容去重）',
    '含 revision',
    goalCompletionUnitOf(marker),
    goalCompletionUnitOf(marker).includes(String(marker.expectedRevision)) &&
      goalCompletionUnitOf(marker).startsWith('goal-completed:'),
  )

  /* ⚠️ I3 的恒真前半句已去掉，理由与修法同 I1（见上）；这里钉住**第一条结果引用**进身份 */
  const unitCommitment = goalCompletionUnitOf(commitmentMarker)
  const unitCommitmentOtherRef = goalCompletionUnitOf({
    ...commitmentMarker,
    evidenceRefs: [sourceRef(USER_EVENT)],
  })
  record(
    'I',
    'I3',
    '承诺兑现在身份串里还含**第一条结果引用**（不同结果 = 不同身份，同一结果重投 = 同身份）',
    '含结果引用（=组合串）· 换引用异值',
    `${unitCommitment} · 换引用=${unitCommitmentOtherRef}`,
    unitCommitment.includes(ASSISTANT_EVENT) &&
      unitCommitment ===
        `commitment-fulfilled:${commitmentMarker.goalId}:${String(commitmentMarker.expectedRevision)}:${ASSISTANT_EVENT}` &&
      unitCommitment !== unitCommitmentOtherRef,
  )

  /* registry 层：兑现 / 完成事件的必填依据 */
  const registry = createFullDomainEventRegistry()
  const commitmentEmptyRefs = (() => {
    try {
      registry.get(COMMITMENT_FULFILLED)!.validatePayload({
        characterId: CHARACTER,
        commitmentId: 'cmt:x',
        goalId: 'gol:x',
        expectedRevision: 1,
        resultRefs: [],
        basis: 'conversation_output',
      })
      return true
    } catch {
      return false
    }
  })()
  const goalEmptyRefs = (() => {
    try {
      registry.get(GOAL_COMPLETED)!.validatePayload({
        characterId: CHARACTER,
        goalId: 'gol:x',
        expectedRevision: 1,
        basis: 'user_report',
        evidenceRefs: [],
      })
      return true
    } catch {
      return false
    }
  })()
  record(
    'I',
    'I4',
    'registry 层**拒绝空依据**：`GOAL_COMPLETED` / `COMMITMENT_FULFILLED` 的 evidenceRefs / resultRefs 必须非空',
    '两条都抛',
    `goal 接受空依据=${String(goalEmptyRefs)} · commitment 接受空依据=${String(commitmentEmptyRefs)}`,
    !goalEmptyRefs && !commitmentEmptyRefs,
  )

  /* 放行口层：同一补记第二次被 `processed_operations` 拒（**真的无二次副作用**） */
  const completedTarget: ProposedDomainEvent = {
    type: GOAL_COMPLETED,
    operation: 'reinforce',
    payload: {
      characterId: CHARACTER,
      goalId: 'gol:wp6',
      expectedRevision: 5,
      basis: 'user_report',
      evidenceRefs: [sourceRef(USER_EVENT)],
    },
    scope: 'CHARACTER_INTERNAL',
  }
  const seen = new Set<string>()
  const processed = {
    hasProcessed: async (key: string): Promise<boolean> => {
      if (seen.has(key)) return true
      seen.add(key)
      return false
    },
  }
  const deps = {
    registry,
    processed,
    state: {
      getGoal: async () => ({ goal: goalState(), commitment: null }),
      listGoals: async () => [{ goal: goalState(), commitment: null }],
    },
    policy: { characterId: CHARACTER, activeUserId: USER_ID },
  }
  const proposal = goalProposalOf({
    proposalId: 'm10-completion-probe',
    operation: 'complete',
    characterId: CHARACTER,
    processor: 'm10-completion-verify',
    processorVersion: 'm10-completion-verify@1',
    sourceConversationEventIds: [USER_EVENT],
    sourceQualifications: [{ eventId: USER_EVENT, qualification: 'ESTABLISHED' }],
    targets: [completedTarget],
  })
  const first = await validateGoalProposal(deps, proposal)
  const second = await validateGoalProposal(deps, proposal)
  record(
    'I',
    'I5',
    '放行口层：同一次补记**第二次被拒**（`goal_duplicate_operation`，零事件）'
      + '—— 这才是"补记无二次副作用"的可执行形式',
    'first=accepted · second=duplicate · 0 事件',
    `first=${String(first.accepted)} · second=[${second.rejected.map((r) => r.code).join(',')}] · ${String(second.acceptedEvents.length)} 事件`,
    first.accepted &&
      !second.accepted &&
      second.rejected.some((r) => r.code === 'goal_duplicate_operation') &&
      second.acceptedEvents.length === 0,
  )
}

// ---------------------------------------------------------------------------
// S 组：结构性检查
// ---------------------------------------------------------------------------

function structuralChecks(): void {
  const unknown = GOAL_COMPLETION_REJECTION_CODES.filter(
    (code) => GOAL_COMPLETION_REJECTION_FACTS[code] === undefined,
  )
  const unreachable = GOAL_COMPLETION_REJECTION_CODES.filter(
    (code) => !GOAL_COMPLETION_REJECTION_FACTS[code].reachable,
  )
  record(
    'S',
    'S1',
    '拒绝码闭集与可达性事实表**键一致**，且**全部可达**（每一条都有负控）',
    `${String(GOAL_COMPLETION_REJECTION_CODES.length)} 条全覆盖 · 0 不可达`,
    `无事实=${unknown.join(',') || '无'} · 不可达=${unreachable.join(',') || '无'}`,
    unknown.length === 0 && unreachable.length === 0,
  )

  const source = existsSync(join(REPO_ROOT, 'src/kernel/app/goal/completion.ts'))
    ? readFileSync(join(REPO_ROOT, 'src/kernel/app/goal/completion.ts'), 'utf8')
    : ''
  record(
    'S',
    'S2',
    '判定层**不 import** SQL / 框架 / `node:*`（`kernel/app/` 的纪律）',
    '0 处',
    /from '(drizzle-orm|node:|@elizaos)/.test(source) ? '发现违规 import' : '无',
    !/from '(drizzle-orm|node:|@elizaos)/.test(source),
  )

  /* 结论**不带正文**：把 verdict 的类型声明读出来看有没有 text 字段 */
  const verdictBlock = source.slice(
    source.indexOf('export type GoalCompletionVerdict'),
    source.indexOf('export type GoalCompletionVerdict') + 900,
  )
  record(
    'S',
    'S3',
    '`GoalCompletionVerdict` 的类型里**没有** `text` / `content` 字段（读过的正文不可能被顺手写进 trace）',
    '0 个正文字段',
    /readonly (text|content|body)\s*:/.test(verdictBlock) ? '发现正文字段' : '无',
    !/readonly (text|content|body)\s*:/.test(verdictBlock),
  )

  record(
    'S',
    'S4',
    '判定器**读 `actorType`**（"她的输出不能自我确认"落在代码里，不只在文档里）',
    `actorType 出现 ≥ 3 次`,
    `${String((source.match(/actorType/g) ?? []).length)} 次`,
    (source.match(/actorType/g) ?? []).length >= 3,
  )

  record(
    'S',
    'S5',
    '有界 reconciliation 的上界是**具名常量**且与"会话历史长度"无关（没有扫描历史的入口）',
    `常量 = ${String(GOAL_RECONCILIATION_MAX_ITEMS)} · 无 history 读取`,
    `常量在场=${String(source.includes('GOAL_RECONCILIATION_MAX_ITEMS'))} · 出现 ` +
      `conversationEventsInRange/recentConversationEvents=${String(/conversationEventsInRange|recentConversationEvents/.test(source))}`,
    source.includes('GOAL_RECONCILIATION_MAX_ITEMS') &&
      !/conversationEventsInRange|recentConversationEvents/.test(source),
  )

  record(
    'S',
    'S6',
    '语料/门声明的证据引用上界与契约一致（`GOAL_SOURCE_REFS_MAX` 没有被本层偷偷放宽）',
    '常量仍在',
    `GOAL_SOURCE_REFS_MAX=${String(GOAL_SOURCE_REFS_MAX)}`,
    GOAL_SOURCE_REFS_MAX === 8,
  )
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  phase('judgement (J)')
  await judgementChecks()
  phase('crash windows (P)')
  crashWindowChecks()
  phase('reconciliation (R)')
  reconciliationChecks()
  phase('idempotency (I)')
  await idempotencyChecks()
  phase('structural (S)')
  structuralChecks()
  phase('done')

  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  const runId = createM10RunId({ wpId: 'wp6-completion', headShort: head })
  const dir = openM10RunDir(REPO_ROOT, runId)

  const passed = checks.filter((c) => c.pass).length
  const failed = checks.length - passed
  const groups = ['J', 'P', 'R', 'I', 'S'] as const
  const perGroup = Object.fromEntries(
    groups.map((g) => [
      g,
      {
        total: checks.filter((c) => c.group === g).length,
        passed: checks.filter((c) => c.group === g && c.pass).length,
      },
    ]),
  )

  const payload = {
    schema: 'm10-completion-verify@1',
    runId,
    head,
    characterId: CHARACTER,
    checks,
    perGroup,
    summary: { total: checks.length, passed, failed, verdict: failed === 0 ? 'PASS' : 'FAIL' },
  }
  writeFileSync(join(dir, 'completion-verify.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  writeM10Manifest(dir, {
    runId,
    wp: 'wp6',
    head,
    headShort: head.slice(0, 12),
    branch: execFileSync('git', ['branch', '--show-current'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim(),
    date: new Date().toISOString().slice(0, 10),
    toolVersions: { node: process.version, git: '(见 baseline)' },
    testType: 'completion-verify',
    counts: { total: checks.length, passed, failed },
    phases: ['single'],
    supersedes: null,
    notes:
      'WP6 完成判定门：三种依据互不替代与假兑现负控（J）· 两个崩溃窗口（P）· ' +
      '有界 reconciliation（R）· 无二次副作用（I）· 结构性（S）。零模型 / 零数据库。',
    databaseScope: 'not-applicable',
    mode: 'offline',
  })

  console.log(`runId: ${runId}`)
  for (const c of checks) {
    console.log(`  ${c.pass ? '✅' : '❌'} ${c.id} [${c.group}] ${c.label}`)
    console.log(`      期望 ${c.expected} · 实测 ${c.actual}`)
  }
  console.log(`verdict: ${payload.summary.verdict}（${String(passed)}/${String(checks.length)}）`)
  console.log(`分组：${groups.map((g) => `${g}=${String(perGroup[g].passed)}/${String(perGroup[g].total)}`).join(' · ')}`)
  process.exitCode = failed === 0 ? 0 : 1
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})
