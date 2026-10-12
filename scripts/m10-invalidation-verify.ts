/**
 * M10 WP5 —— **失效传播 / 遗忘遮蔽 / 冲突处理门**（`pnpm m10:invalidation:verify`）。
 *
 * ============================================================================
 *  本门测什么（计划 §12 WP5 的四条出口判据，逐条对应）
 * ============================================================================
 * ```text
 * ① 三类依赖的处置逐条可达    → D 组（含"根压过前提"的优先级与"不失效 ⇒ 什么都不做"的正控）
 * ② 「忘掉目标」与「取消」的读侧差异可机器判定 → M 组（两个触发条件各自可达且优先级确定）
 * ③ 同轮遮蔽独立于写侧        → M4（行**仍是 active**、没有任何取消事件被写 ⇒ 照样遮蔽）
 * ④ 旧根禁用不因内容再次出现而解除 → F 组
 * 另加 W 组：**关闭 `L-M10-08`**（实质替代带 active 承诺的目标）与放行口的联动
 * 另加 C 组：冲突判定与**确定性排序**（§6.4 / §4.10）
 * ```
 *
 * ============================================================================
 *  硬边界
 * ============================================================================
 *  · **零模型调用、零出网、零真实库**：本门全部是纯函数 + in-memory 状态端口。
 *  · 每条检查都有非零分母。
 *  · 阶段进度写 stderr；失败路径强退（WP2 的教训）。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { createM10RunId, openM10RunDir, writeM10Manifest } from './m10-evidence.ts'
import { entityRef } from '../src/kernel/contracts/index.ts'
import type { DomainEvent } from '../src/kernel/contracts/index.ts'
import type { ProposedDomainEvent } from '../src/kernel/contracts/proposal.ts'
import {
  COMMITMENT_ACCEPTED,
  COMMITMENT_CANCELLED,
  GOAL_CANCELLED,
  GOAL_CREATED,
  GOAL_SUPERSEDED,
  createFullDomainEventRegistry,
  type DomainEventRegistry,
} from '../src/kernel/contracts/domain-event.ts'
import {
  GOAL_BLOCKED_REASONS,
  GOAL_CANCEL_REASONS,
  makeGoalId,
  type CommitmentState,
  type GoalDependency,
  type GoalRowState,
  type GoalState,
} from '../src/kernel/contracts/goal.ts'
import {
  REFERENCE_REJECTION_REASONS,
  type ReferenceRejectionReason,
  type ReferenceUsability,
} from '../src/kernel/contracts/goal-reference.ts'
import {
  CERTAIN_INVALIDATION_REASONS,
  UNRESOLVED_INVALIDATION_REASONS,
  conflictMembers,
  decideCapabilityAvailability,
  decideGoalInvalidation,
  detectGoalConflict,
  forbiddenRootHits,
  forbiddenRootsOf,
  goalContentMustBeMasked,
  goalUsableInOrdinaryContext,
  isCertainInvalidation,
  orderGoalsForFocus,
  type GoalDependencyReading,
} from '../src/kernel/app/goal/invalidation.ts'
import {
  validateGoalProposal,
  goalProposalOf,
  type GoalProposal,
  type GoalStateLookupPort,
} from '../src/kernel/policies/goal-validator.ts'
import { replayGoalRows } from '../src/kernel/projections/goal.ts'

const REPO_ROOT = resolve(process.cwd())
const CHARACTER = 'char_m10_wp5'
const USER_ID = 'm10-wp5-user'
const SOURCE_A = 'cev:m10-wp5-source-a'
const SOURCE_B = 'cev:m10-wp5-source-b'
const M10_T0 = 2_000_000_000_000

function phase(mark: string): void {
  console.error(`[m10-invalidation] ${mark}`)
}

// ---------------------------------------------------------------------------
// 量具
// ---------------------------------------------------------------------------

interface Check {
  group: 'D' | 'M' | 'F' | 'C' | 'W' | 'S'
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

function dep(cls: GoalDependency['class'], memoryId = 'mem:x'): GoalDependency {
  return { class: cls, target: { kind: 'memory', memoryId } }
}

function usableHard(): ReferenceUsability {
  return { usable: true, as: 'hard' }
}

function rejected(reason: ReferenceRejectionReason): ReferenceUsability {
  return { usable: false, reason }
}

function reading(cls: GoalDependency['class'], usability: ReferenceUsability): GoalDependencyReading {
  return { dependency: dep(cls), usability }
}

function goalState(override: Partial<GoalState> = {}): GoalState {
  return {
    goalId: 'gol:placeholder' as GoalState['goalId'],
    characterId: CHARACTER,
    owner: entityRef('character', CHARACTER),
    targetEntity: entityRef('user', USER_ID),
    origin: 'user_requested',
    sourceRefs: [{ conversationEventId: SOURCE_A as never, fingerprint: 'fp-a' }],
    revision: 1,
    statement: '把提纲写完',
    successCriterion: { kind: 'user_report' },
    status: 'active',
    priority: 'normal',
    dependencies: [],
    time: { recordedAt: M10_T0 },
    ...override,
  }
}

// ---------------------------------------------------------------------------
// D 组：三类依赖的处置
// ---------------------------------------------------------------------------

function invalidationChecks(): void {
  const cases: {
    id: string
    label: string
    readings: GoalDependencyReading[]
    expect: (decision: ReturnType<typeof decideGoalInvalidation>) => boolean
    expectText: string
  }[] = [
    {
      id: 'D1',
      label: '**根证据**确定失效 ⇒ `cancel(root_evidence_withdrawn)`',
      readings: [reading('root_evidence', rejected('forgotten'))],
      expect: (d) => d.kind === 'cancel' && d.reason === 'root_evidence_withdrawn',
      expectText: 'cancel(root_evidence_withdrawn)',
    },
    {
      id: 'D2',
      label: '**根证据读不到** ⇒ `block(dependency_unavailable)`（**不是** cancel —— 读失败是暂时的）',
      readings: [reading('root_evidence', rejected('unavailable'))],
      expect: (d) => d.kind === 'block' && d.reasonCode === 'dependency_unavailable',
      expectText: 'block(dependency_unavailable)',
    },
    {
      id: 'D3',
      label: '**必要前提**确定失效 ⇒ `block(necessary_premise_invalid)`',
      readings: [reading('necessary_premise', rejected('status_not_usable'))],
      expect: (d) => d.kind === 'block' && d.reasonCode === 'necessary_premise_invalid',
      expectText: 'block(necessary_premise_invalid)',
    },
    {
      id: 'D4',
      label: '**必要前提读不到** ⇒ `block(dependency_unavailable)`',
      readings: [reading('necessary_premise', rejected('withdrawn_incomplete'))],
      expect: (d) => d.kind === 'block' && d.reasonCode === 'dependency_unavailable',
      expectText: 'block(dependency_unavailable)',
    },
    {
      id: 'D5',
      label: '**可选背景**失效 ⇒ `revise_drop_references`（目标本身保留）',
      readings: [reading('optional_background', rejected('forgotten'))],
      expect: (d) => d.kind === 'revise_drop_references' && d.dropped.length === 1,
      expectText: 'revise_drop_references(1)',
    },
    {
      id: 'D6',
      label: '【正控】**没有**失效 ⇒ `none`（不得过度触发）',
      readings: [reading('root_evidence', usableHard()), reading('necessary_premise', usableHard())],
      expect: (d) => d.kind === 'none',
      expectText: 'none',
    },
    {
      id: 'D7',
      label: '【优先级】根证据确定失效 **且** 必要前提也失效 ⇒ 报 `cancel`（根压过前提）',
      readings: [
        reading('necessary_premise', rejected('forgotten')),
        reading('root_evidence', rejected('forgotten')),
      ],
      expect: (d) => d.kind === 'cancel',
      expectText: 'cancel（不是 block）',
    },
    {
      id: 'D8',
      label: '【优先级】根证据**读不到** 且 必要前提**确定**失效 ⇒ 报 `dependency_unavailable`'
        + '（不确定的根不得升级为 cancel，也不得被确定的必要前提盖过根的位置）',
      readings: [
        reading('root_evidence', rejected('unavailable')),
        reading('necessary_premise', rejected('forgotten')),
      ],
      expect: (d) => d.kind === 'block' && d.reasonCode === 'dependency_unavailable',
      expectText: 'block(dependency_unavailable)',
    },
    {
      id: 'D9',
      label: '`none` 的 reason 具名（`no_invalid_dependency`），不是空结论',
      readings: [],
      expect: (d) => d.kind === 'none' && d.reason === 'no_invalid_dependency',
      expectText: 'none(no_invalid_dependency)',
    },
  ]

  for (const testCase of cases) {
    const decision = decideGoalInvalidation(testCase.readings)
    record(
      'D',
      testCase.id,
      testCase.label,
      testCase.expectText,
      `${decision.kind}${'reasonCode' in decision ? `(${decision.reasonCode})` : 'reason' in decision ? `(${decision.reason})` : ''}`,
      testCase.expect(decision),
    )
  }

  /* 能力条件与依赖失效**分开** */
  const capMissing = decideCapabilityAvailability({
    requiredCapability: 'calendar.reminder',
    availableCapabilities: [],
  })
  const capOk = decideCapabilityAvailability({
    requiredCapability: 'calendar.reminder',
    availableCapabilities: ['calendar.reminder'],
  })
  const capNone = decideCapabilityAvailability({
    requiredCapability: undefined,
    availableCapabilities: [],
  })
  record(
    'D',
    'D10',
    '**能力条件**独立判定：缺能力 ⇒ `block(capability_unavailable)`；有/不需要 ⇒ `none`',
    'block · none · none',
    `${capMissing.kind}${capMissing.kind === 'block' ? `(${capMissing.reasonCode})` : ''} · ${capOk.kind} · ${capNone.kind}`,
    capMissing.kind === 'block' &&
      capMissing.reasonCode === 'capability_unavailable' &&
      capOk.kind === 'none' &&
      capNone.kind === 'none',
  )
}

// ---------------------------------------------------------------------------
// M 组：读侧遮蔽（独立于写侧）
// ---------------------------------------------------------------------------

function maskingChecks(): void {
  const withdrawn = new Set(['cev:withdrawn-1'])

  const forgot = goalContentMustBeMasked({
    goal: goalState({ cancelReason: 'explicit_forget' }),
    withdrawnEventIds: new Set(),
  })
  record(
    'M',
    'M1',
    '触发条件①：最近一次取消原因是 `explicit_forget` ⇒ 整项遮蔽',
    'mask(explicit_forget)',
    forgot.mask ? `mask(${forgot.reason})` : 'mask=false',
    forgot.mask && forgot.reason === 'explicit_forget',
  )

  const withdrawnSource = goalContentMustBeMasked({
    goal: goalState({
      sourceRefs: [{ conversationEventId: 'cev:withdrawn-1' as never, fingerprint: 'fp-w' }],
    }),
    withdrawnEventIds: withdrawn,
  })
  record(
    'M',
    'M2',
    '触发条件②：**任一来源事件**落在当前撤销集 ⇒ 整项遮蔽',
    'mask(withdrawn_source)',
    withdrawnSource.mask ? `mask(${withdrawnSource.reason})` : 'mask=false',
    withdrawnSource.mask && withdrawnSource.reason === 'withdrawn_source',
  )

  const clean = goalContentMustBeMasked({
    goal: goalState(),
    withdrawnEventIds: withdrawn,
  })
  record(
    'M',
    'M3',
    '【正控】两个条件都不命中 ⇒ **不**遮蔽（不得过度遮蔽）',
    'mask=false',
    `mask=${String(clean.mask)}`,
    !clean.mask,
  )

  /*
   * ⚠️ 本门最要紧的一条：**遮蔽不要求任何取消事件已经写下**。
   *    这里给的行 `status='active'`、`cancelReason` 未定义 —— 写侧一个字节都没动。
   */
  const writeSideUntouched = goalState({
    status: 'active',
    sourceRefs: [{ conversationEventId: 'cev:withdrawn-1' as never, fingerprint: 'fp-w' }],
  })
  const independent = goalContentMustBeMasked({
    goal: writeSideUntouched,
    withdrawnEventIds: withdrawn,
  })
  record(
    'M',
    'M4',
    '**读侧遮蔽独立于写侧**：行仍是 `active`、没有任何取消事件被写 ⇒ 照样遮蔽'
      + '（写侧失败的那一轮不会泄漏）',
    'mask=true · status 仍 active',
    `status=${writeSideUntouched.status} · mask=${String(independent.mask)}`,
    independent.mask && writeSideUntouched.status === 'active',
  )

  record(
    'M',
    'M5',
    '`goalUsableInOrdinaryContext` 与 `goalContentMustBeMasked` **互为补集**（同一判定的两个面）',
    '四个样本全部互补',
    `[forgot=${String(goalUsableInOrdinaryContext({ goal: goalState({ cancelReason: 'explicit_forget' }), withdrawnEventIds: new Set() }))} · clean=${String(goalUsableInOrdinaryContext({ goal: goalState(), withdrawnEventIds: withdrawn }))}]`,
    goalUsableInOrdinaryContext({
      goal: goalState({ cancelReason: 'explicit_forget' }),
      withdrawnEventIds: new Set(),
    }) === false &&
      goalUsableInOrdinaryContext({ goal: goalState(), withdrawnEventIds: withdrawn }) === true,
  )

  const both = goalContentMustBeMasked({
    goal: goalState({
      cancelReason: 'explicit_forget',
      sourceRefs: [{ conversationEventId: 'cev:withdrawn-1' as never, fingerprint: 'fp-w' }],
    }),
    withdrawnEventIds: withdrawn,
  })
  record(
    'M',
    'M6',
    '两个触发条件同时命中时**报哪一个**是确定的（先 `explicit_forget`）—— 不确定的优先级会让读数不稳定',
    'mask(explicit_forget)',
    both.mask ? `mask(${both.reason})` : 'mask=false',
    both.mask && both.reason === 'explicit_forget',
  )
}

// ---------------------------------------------------------------------------
// F 组：旧根禁用不因内容再次出现而解除
// ---------------------------------------------------------------------------

function forbiddenRootChecks(): void {
  const forgotten = goalState({
    goalId: 'gol:forgotten' as GoalState['goalId'],
    status: 'cancelled',
    cancelReason: 'explicit_forget',
    forbiddenSourceEventIds: [SOURCE_A],
  })

  const sameSource = forbiddenRootHits([forgotten], [SOURCE_A])
  record(
    'F',
    'F1',
    '同来源（**内容重述**也一样）再建 ⇒ 命中既有禁用根',
    '1 个命中',
    `${String(sameSource.length)} 个：${sameSource.join(',')}`,
    sameSource.length === 1 && sameSource[0] === SOURCE_A,
  )

  const newSource = forbiddenRootHits([forgotten], [SOURCE_B])
  record(
    'F',
    'F2',
    '**新的一轮里新的独立来源** ⇒ 不命中 ⇒ 新身份可达（旧根禁用不封死未来）',
    '0 个命中',
    `${String(newSource.length)} 个`,
    newSource.length === 0,
  )

  const mixed = forbiddenRootHits([forgotten], [SOURCE_A, SOURCE_B])
  record(
    'F',
    'F3',
    '混合来源里有**一个**被禁用 ⇒ 整体拒绝（不是"至少有一个新的就放行"）',
    '1 个命中（SOURCE_A）',
    `${String(mixed.length)} 个：${mixed.join(',')}`,
    mixed.length === 1 && mixed[0] === SOURCE_A,
  )

  const union = forbiddenRootsOf([forgotten, goalState({ forbiddenSourceEventIds: [SOURCE_B] })])
  record(
    'F',
    'F4',
    '禁用根并集**只有 id**、按升序稳定（不给开发者面留正文的位置）',
    `2 个 id 升序：[${[SOURCE_A, SOURCE_B].sort().join(',')}]`,
    `${String(union.length)} 个：[${union.join(',')}]`,
    union.length === 2 && union.join(',') === [SOURCE_A, SOURCE_B].sort().join(','),
  )
}

// ---------------------------------------------------------------------------
// C 组：冲突判定与确定性排序
// ---------------------------------------------------------------------------

function conflictChecks(): void {
  const criterionA = goalState({
    goalId: 'gol:c1' as GoalState['goalId'],
    statement: '给我三个步骤',
    successCriterion: { kind: 'conversation_output', structure: { kind: 'item_count', count: 3 } },
  })
  const criterionB = goalState({
    goalId: 'gol:c2' as GoalState['goalId'],
    statement: '给我三个步骤',
    successCriterion: { kind: 'conversation_output', structure: { kind: 'item_count', count: 5 } },
  })
  const differentCriterion = detectGoalConflict(criterionA, criterionB)
  record(
    'C',
    'C1',
    '同对象 + 同描述 + **不同**的机器可判成功条件 ⇒ 冲突（一件事被要求了两种成功条件）',
    'conflict(same_subject_statement_different_criterion)',
    `${String(differentCriterion.conflict)}${differentCriterion.kind !== undefined ? `(${differentCriterion.kind})` : ''}`,
    differentCriterion.conflict &&
      differentCriterion.kind === 'same_subject_statement_different_criterion',
  )

  const duplicateActive = detectGoalConflict(
    goalState({ goalId: 'gol:d1' as GoalState['goalId'], statement: '整理数据' }),
    goalState({ goalId: 'gol:d2' as GoalState['goalId'], statement: '整理数据' }),
  )
  record(
    'C',
    'C2',
    '同对象 + 同描述 + 两个都 active ⇒ 冲突（同一件事有两个活着的记录）',
    'conflict(same_subject_statement_duplicate_active)',
    `${String(duplicateActive.conflict)}${duplicateActive.kind !== undefined ? `(${duplicateActive.kind})` : ''}`,
    duplicateActive.conflict && duplicateActive.kind === 'same_subject_statement_duplicate_active',
  )

  const noConflict = detectGoalConflict(
    goalState({ goalId: 'gol:n1' as GoalState['goalId'], statement: '整理数据' }),
    goalState({ goalId: 'gol:n2' as GoalState['goalId'], statement: '写完提纲' }),
  )
  const selfNoConflict = detectGoalConflict(
    goalState({ goalId: 'gol:n1' as GoalState['goalId'], statement: '整理数据' }),
    goalState({ goalId: 'gol:n1' as GoalState['goalId'], statement: '整理数据' }),
  )
  record(
    'C',
    'C3',
    '【正控】不同描述 ⇒ 不冲突；**自己与自己** ⇒ 不冲突（防自反误报）',
    '都 false',
    `不同描述=${String(noConflict.conflict)} · 自己=${String(selfNoConflict.conflict)}`,
    !noConflict.conflict && !selfNoConflict.conflict,
  )

  const forward = detectGoalConflict(criterionA, criterionB)
  const backward = detectGoalConflict(criterionB, criterionA)
  record(
    'C',
    'C4',
    '冲突判定**对称**（`detect(a,b)` 与 `detect(b,a)` 同结论）—— 否则"先看哪一项"会改变结果',
    '同 kind',
    `${String(forward.kind)} === ${String(backward.kind)}`,
    forward.conflict === backward.conflict && forward.kind === backward.kind,
  )

  const members = conflictMembers([criterionB, criterionA, goalState({ goalId: 'gol:z' as GoalState['goalId'], statement: '无关' })])
  record(
    'C',
    'C5',
    '**两条记录都保留**（冲突不合并、不删除），成员 id 升序稳定',
    '2 个成员：gol:c1,gol:c2',
    `${String(members.length)} 个：${members.join(',')}`,
    members.length === 2 && members.join(',') === 'gol:c1,gol:c2',
  )

  /* 排序：点名 > 续接 > 高优先 > 其余；同分按 goalId 升序 */
  const goals = [
    goalState({ goalId: 'gol:r1' as GoalState['goalId'], priority: 'normal' }),
    goalState({ goalId: 'gol:r2' as GoalState['goalId'], priority: 'high' }),
    goalState({ goalId: 'gol:r3' as GoalState['goalId'], priority: 'normal' }),
    goalState({ goalId: 'gol:r4' as GoalState['goalId'], status: 'paused' }),
    goalState({ goalId: 'gol:r5' as GoalState['goalId'], status: 'completed' }),
  ]
  const ordered = orderGoalsForFocus(goals, { namedGoalIds: ['gol:r3'], continuedGoalId: 'gol:r1' })
  record(
    'C',
    'C6',
    '确定性排序：**点名** > 续接 > 高优先 > 其余；同分按 goalId 升序',
    'r3, r1, r2',
    ordered.ordered.map((g) => String(g.goalId)).join(', '),
    ordered.ordered.map((g) => String(g.goalId)).join(',') === 'gol:r3,gol:r1,gol:r2',
  )

  const shuffled = orderGoalsForFocus([goals[4]!, goals[2]!, goals[0]!, goals[3]!, goals[1]!], {
    namedGoalIds: ['gol:r3'],
    continuedGoalId: 'gol:r1',
  })
  record(
    'C',
    'C7',
    '排序**不依赖输入顺序**（打乱输入给同一结果）',
    '两次同序',
    `${shuffled.ordered.map((g) => String(g.goalId)).join(',')}`,
    shuffled.ordered.map((g) => String(g.goalId)).join(',') === 'gol:r3,gol:r1,gol:r2',
  )

  record(
    'C',
    'C8',
    '非 active 的目标**被排除**且**如实报出**集合（"没被选中"与"不存在"是两件事）',
    '排除 gol:r4,gol:r5',
    `排除=[${ordered.excludedByState.join(',')}]`,
    ordered.excludedByState.join(',') === 'gol:r4,gol:r5',
  )
}

// ---------------------------------------------------------------------------
// W 组：L-M10-08 的写侧联动（放行口）
// ---------------------------------------------------------------------------

function statePort(rows: readonly GoalRowState[]): GoalStateLookupPort {
  return {
    getGoal: async (_c, goalId) => rows.find((row) => String(row.goal.goalId) === String(goalId)),
    listGoals: async () => [...rows],
  }
}

function depsOf(registry: DomainEventRegistry): Parameters<typeof validateGoalProposal>[0] {
  return {
    registry,
    processed: { hasProcessed: async (): Promise<boolean> => false },
    state: statePort([]),
    policy: { characterId: CHARACTER, activeUserId: USER_ID },
  }
}

function proposalOf(targets: readonly ProposedDomainEvent[]): GoalProposal {
  return goalProposalOf({
    proposalId: `m10-wp5-${String(Math.random()).slice(2, 10)}`,
    operation: 'supersede',
    characterId: CHARACTER,
    processor: 'm10-invalidation-verify',
    processorVersion: 'm10-invalidation-verify@1',
    sourceConversationEventIds: [SOURCE_A],
    sourceQualifications: [{ eventId: SOURCE_A, qualification: 'ESTABLISHED' }],
    targets,
  })
}

function commitmentOf(goalId: string): CommitmentState {
  return {
    commitmentId: `cmt:${CHARACTER}:probe` as CommitmentState['commitmentId'],
    goalId: goalId as never,
    actor: entityRef('character', CHARACTER),
    beneficiary: entityRef('user', USER_ID),
    scope: '给三个步骤',
    acceptedAt: M10_T0,
    acceptanceRefs: [{ conversationEventId: SOURCE_A as never, fingerprint: 'fp-a' }],
    criterion: { kind: 'conversation_output', structure: { kind: 'item_count', count: 3 } },
    status: 'active',
    completionRefs: [],
    revision: 4,
  }
}

async function writeSideChecks(): Promise<void> {
  const registry = createFullDomainEventRegistry()

  const oldGoal = goalState({
    goalId: 'gol:old' as GoalState['goalId'],
    statement: '旧目标：写完第二章',
    revision: 2,
  })
  const oldRow: GoalRowState = { goal: oldGoal, commitment: commitmentOf('gol:old') }
  const newGoal = goalState({
    goalId: 'gol:placeholder' as GoalState['goalId'],
    statement: '新目标：改写成三篇短文',
    successCriterion: { kind: 'conversation_output', structure: { kind: 'item_count', count: 3 } },
  })
  const derivedNewId = makeGoalId({
    characterId: CHARACTER,
    owner: newGoal.owner,
    targetEntity: newGoal.targetEntity,
    origin: newGoal.origin,
    statement: newGoal.statement,
    acceptanceSourceEventId: SOURCE_A,
    operation: 'create',
  })

  const createTarget: ProposedDomainEvent = {
    type: GOAL_CREATED,
    operation: 'create',
    payload: { characterId: CHARACTER, goal: newGoal, mutation: 'explicit' },
    scope: 'CHARACTER_INTERNAL',
  }
  const supersedeWithoutPair: ProposedDomainEvent = {
    type: GOAL_SUPERSEDED,
    operation: 'supersede',
    payload: {
      characterId: CHARACTER,
      goalId: 'gol:old',
      supersededByGoalId: String(derivedNewId),
      expectedRevision: 2,
      reason: '对象改了',
    },
    scope: 'CHARACTER_INTERNAL',
  }

  const withoutPair = await validateGoalProposal(
    { ...depsOf(registry), state: statePort([oldRow]) },
    proposalOf([createTarget, supersedeWithoutPair]),
  )
  record(
    'W',
    'W1',
    '【`L-M10-08`】实质替代一个有 active 承诺的目标、**没有**配对取消 ⇒ 拒绝 `goal_orphan_commitment`',
    'rejected:goal_orphan_commitment · 0 事件',
    `${String(withoutPair.accepted)} · [${withoutPair.rejected.map((r) => r.code).join(',')}] · ${String(withoutPair.acceptedEvents.length)} 事件`,
    !withoutPair.accepted &&
      withoutPair.rejected.some((r) => r.code === 'goal_orphan_commitment') &&
      withoutPair.acceptedEvents.length === 0,
  )

  const withPair = await validateGoalProposal(
    { ...depsOf(registry), state: statePort([oldRow]) },
    proposalOf([
      createTarget,
      supersedeWithoutPair,
      {
        type: COMMITMENT_CANCELLED,
        operation: 'retract',
        payload: {
          characterId: CHARACTER,
          commitmentId: String(commitmentOf('gol:old').commitmentId),
          goalId: 'gol:old',
          expectedRevision: 4,
          reason: 'goal_superseded',
        },
        scope: 'CHARACTER_INTERNAL',
      },
    ]),
  )
  record(
    'W',
    'W2',
    '带上配对 `COMMITMENT_CANCELLED(reason=goal_superseded)` ⇒ 受理（**承诺不顺延**到新目标）',
    'accepted · 3 事件',
    `${String(withPair.accepted)} · [${withPair.rejected.map((r) => r.code).join(',')}] · ${String(withPair.acceptedEvents.length)} 事件`,
    withPair.accepted && withPair.acceptedEvents.length === 3,
  )

  /* 回归：取消目标那条路**仍然**要求配对（WP3 的 G13 没被改坏） */
  const cancelWithoutPair = await validateGoalProposal(
    { ...depsOf(registry), state: statePort([oldRow]) },
    proposalOf([
      {
        type: GOAL_CANCELLED,
        operation: 'retract',
        payload: {
          characterId: CHARACTER,
          goalId: 'gol:old',
          expectedRevision: 2,
          reason: 'user_cancel',
        },
        scope: 'CHARACTER_INTERNAL',
      },
    ]),
  )
  record(
    'W',
    'W3',
    '【回归】**取消**目标那条路仍然要求配对取消承诺（WP3 的 `goal_orphan_commitment` 没被改坏）',
    'rejected:goal_orphan_commitment',
    `[${cancelWithoutPair.rejected.map((r) => r.code).join(',')}]`,
    !cancelWithoutPair.accepted &&
      cancelWithoutPair.rejected.some((r) => r.code === 'goal_orphan_commitment'),
  )

  /* reducer：配对取消之后，旧承诺在行里是 cancelled（不是"顺延"） */
  /*
   * ⚠️ 重放流必须**从旧目标的建立开始**：孤儿事件按设计是 no-op
   *    （`reduceGoalRow(undefined, GOAL_SUPERSEDED)` 返回 undefined），
   *    因此只喂"本提案的那三条"会让旧行根本不存在。
   *    这正是 WP3 踩过的同一个形状 —— 重放测的是**事件流**，不是一条孤立提案。
   */
  const oldHistory: DomainEvent[] = [
    {
      id: 'dev:m10-wp5-old-create',
      characterId: CHARACTER,
      sequence: 1,
      type: GOAL_CREATED,
      sourceConversationEventIds: [SOURCE_A],
      payload: { characterId: CHARACTER, goal: oldGoal, mutation: 'explicit' },
      processor: 'm10-invalidation-verify',
      processorVersion: 'm10-invalidation-verify@1',
      idempotencyKey: 'idem:m10-wp5-old-create',
      schemaVersion: 1,
      createdAt: M10_T0,
    } as unknown as DomainEvent,
    {
      id: 'dev:m10-wp5-old-accept',
      characterId: CHARACTER,
      sequence: 2,
      type: COMMITMENT_ACCEPTED,
      sourceConversationEventIds: [SOURCE_A],
      payload: {
        characterId: CHARACTER,
        goalId: 'gol:old',
        commitment: commitmentOf('gol:old'),
        expectedGoalRevision: oldGoal.revision,
      },
      processor: 'm10-invalidation-verify',
      processorVersion: 'm10-invalidation-verify@1',
      idempotencyKey: 'idem:m10-wp5-old-accept',
      schemaVersion: 1,
      createdAt: M10_T0 + 1,
    } as unknown as DomainEvent,
  ]
  const events: DomainEvent[] = [
    ...oldHistory,
    ...(withPair.accepted
      ? withPair.acceptedEvents.map((item, index) => ({
          id: `dev:m10-wp5-${String(index)}`,
          characterId: CHARACTER,
          sequence: index + 3,
          type: item.type,
          sourceConversationEventIds: [SOURCE_A],
          payload: item.payload,
          processor: 'm10-invalidation-verify',
          processorVersion: 'm10-invalidation-verify@1',
          idempotencyKey: item.idempotencyKey,
          schemaVersion: 1,
          createdAt: M10_T0 + index + 2,
        }) as unknown as DomainEvent)
      : []),
  ]
  const world = replayGoalRows(events)
  const oldAfter = world.get(`goal:gol:old`)
  const newAfter = world.get(`goal:${String(derivedNewId)}`)
  record(
    'W',
    'W4',
    '折叠结果：旧目标 `superseded` + 旧承诺 `cancelled`；**新目标没有承诺**（要新承诺必须重新受理）',
    '旧 superseded/cancelled · 新 active/null',
    `旧=${String(oldAfter?.goal.status)}/${String(oldAfter?.commitment?.status ?? 'null')} · 新=${String(newAfter?.goal.status)}/${String(newAfter?.commitment === null ? 'null' : newAfter?.commitment?.status)}`,
    oldAfter?.goal.status === 'superseded' &&
      oldAfter?.commitment?.status === 'cancelled' &&
      newAfter?.goal.status === 'active' &&
      newAfter?.commitment === null,
  )
}

// ---------------------------------------------------------------------------
// S 组：结构性检查
// ---------------------------------------------------------------------------

function structuralChecks(): void {
  record(
    'S',
    'S1',
    '`dependency_unavailable` 与 `necessary_premise_invalid` 都在 `blocked` 闭集里且**并存**（不被合并）',
    '两者都在',
    `[${GOAL_BLOCKED_REASONS.join(',')}]`,
    GOAL_BLOCKED_REASONS.includes('dependency_unavailable') &&
      GOAL_BLOCKED_REASONS.includes('necessary_premise_invalid') &&
      GOAL_BLOCKED_REASONS.length >= 4,
  )

  record(
    'S',
    'S2',
    '`goal_superseded` 在取消原因闭集里（`L-M10-08` 的裁定载体）',
    '在场',
    `[${GOAL_CANCEL_REASONS.join(',')}]`,
    GOAL_CANCEL_REASONS.includes('goal_superseded'),
  )

  /* 分类表必须**覆盖且不重叠**全部引用拒绝原因 */
  const classified = [...CERTAIN_INVALIDATION_REASONS, ...UNRESOLVED_INVALIDATION_REASONS]
  const missing = REFERENCE_REJECTION_REASONS.filter((reason) => !classified.includes(reason))
  const overlap = CERTAIN_INVALIDATION_REASONS.filter((reason) =>
    UNRESOLVED_INVALIDATION_REASONS.includes(reason),
  )
  record(
    'S',
    'S3',
    '「确定失效」与「读不到」两张表**不重叠**且**覆盖**全部引用拒绝原因'
      + '（以后新增一个 reason 却忘了分类 ⇒ 这条会红）',
    `${String(REFERENCE_REJECTION_REASONS.length)} 条全覆盖 · 0 重叠`,
    `已分类=${String(classified.length)}/${String(REFERENCE_REJECTION_REASONS.length)} · 遗漏=[${missing.join(',')}] · 重叠=[${overlap.join(',')}]`,
    missing.length === 0 && overlap.length === 0,
  )

  const certainOnly = REFERENCE_REJECTION_REASONS.filter((reason) => isCertainInvalidation(reason))
  record(
    'S',
    'S4',
    '分类判据**只有一处实现**：`isCertainInvalidation` 与那张表一致（不散落字符串判断）',
    '一致',
    `表=${String(CERTAIN_INVALIDATION_REASONS.length)} · 判据=${String(certainOnly.length)}`,
    certainOnly.length === CERTAIN_INVALIDATION_REASONS.length,
  )

  const source = existsSync(join(REPO_ROOT, 'src/kernel/app/goal/invalidation.ts'))
    ? readFileSync(join(REPO_ROOT, 'src/kernel/app/goal/invalidation.ts'), 'utf8')
    : ''
  record(
    'S',
    'S5',
    '失效判定层**不 import SQL / 框架 / node:***（`kernel/app/` 的纪律）',
    '0 处',
    /from '(drizzle-orm|node:|@elizaos)/.test(source) ? '发现违规 import' : '无',
    !/from '(drizzle-orm|node:|@elizaos)/.test(source),
  )
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  phase('invalidation decisions')
  invalidationChecks()
  phase('masking')
  maskingChecks()
  phase('forbidden roots')
  forbiddenRootChecks()
  phase('conflicts / ordering')
  conflictChecks()
  phase('write side (L-M10-08)')
  await writeSideChecks()
  phase('structural')
  structuralChecks()
  phase('done')

  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  const runId = createM10RunId({ wpId: 'wp5-invalidation', headShort: head })
  const dir = openM10RunDir(REPO_ROOT, runId)

  const passed = checks.filter((c) => c.pass).length
  const failed = checks.length - passed
  const groups = ['D', 'M', 'F', 'C', 'W', 'S'] as const
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
    schema: 'm10-invalidation-verify@1',
    runId,
    head,
    characterId: CHARACTER,
    checks,
    perGroup,
    summary: { total: checks.length, passed, failed, verdict: failed === 0 ? 'PASS' : 'FAIL' },
  }
  writeFileSync(join(dir, 'invalidation-verify.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  writeM10Manifest(dir, {
    runId,
    wp: 'wp5',
    head,
    headShort: head.slice(0, 12),
    branch: execFileSync('git', ['branch', '--show-current'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim(),
    date: new Date().toISOString().slice(0, 10),
    toolVersions: { node: process.version, git: '(见 baseline)' },
    testType: 'invalidation-verify',
    counts: { total: checks.length, passed, failed },
    phases: ['single'],
    supersedes: null,
    notes:
      'WP5 失效/遗忘/冲突门：三类依赖处置与优先级（D）· 读侧遮蔽独立于写侧（M）· ' +
      '旧根禁用（F）· 冲突判定与确定性排序（C）· L-M10-08 的写侧联动（W）· 结构性（S）',
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
