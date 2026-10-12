/**
 * M10.1 WP3 —— **到期门**（`m10.1:expiry:verify`）。
 *
 * ============================================================================
 *  它证明什么（**全部离线**：不连模型、不连数据库）
 * ============================================================================
 * ```text
 * E1 **正控**：未结清承诺 + 目标截止时间**已过** ⇒ 恰好产出 **1** 个 `COMMITMENT_EXPIRED`
 *    target；载荷 `basis='due_at_passed'` · `dueAt` = 目标的 · `expiredAt` = 程序时钟 ·
 *    `expectedRevision` = 承诺当前 revision。
 * E2 **放行口接受**：把 E1 的 target 交给**真放行口**（行状态 = 该目标+承诺）⇒ accepted。
 * E3 **折叠成终态**：把接受后的事件交给**真 reducer** ⇒ 承诺 `status='expired'` 且 revision +1
 *    （到期**不抹掉** scope/criterion —— "她曾经承担过什么"必须留着）。
 * E4 **不到期**：截止时间在未来 ⇒ **0** 个 target。
 * E5 **没截止不到期**：目标没有 `time.dueAt` ⇒ **0** 个 target（不得凭空到期）。
 * E6 **终态不重复**：承诺已是 `fulfilled` ⇒ **0** 个 target（幂等边界）。
 * E7 ⭐ **到期 ≠ 失约（可执行约束）**：载荷字段集**恰好**等于闭集
 *    （没有 `reason` / `violationRuleId` / 任何"谁没做到"的字段）。
 * E8 **放行口也会挡"凭空到期"**：目标没有 dueAt 时，即使硬塞一个 target 也会被拒。
 * E9 **确定性**：同一输入跑两次 ⇒ 逐字段相同（纯函数、不读挂钟）。
 * E10 **非零分母**。
 * ```
 */

import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { createM11RunId, openM11RunDir, writeM11Manifest, M11_MANIFEST_VERSION } from './m11-evidence.ts'
import { createFullDomainEventRegistry } from '../src/kernel/contracts/domain-event.ts'
import {
  validateGoalProposal,
  type GoalValidatorDeps,
} from '../src/kernel/policies/goal-validator.ts'
import { goalProposalOf } from '../src/kernel/policies/goal-validator.ts'
import { reduceGoalRow } from '../src/kernel/projections/goal.ts'
import {
  COMMITMENT_EXPIRED_PAYLOAD_KEYS,
  planCommitmentExpiries,
} from '../src/kernel/app/goal/expiry.ts'
import type { GoalRowState } from '../src/kernel/contracts/goal.ts'
import type { DomainEvent } from '../src/kernel/contracts/domain-event.ts'
import { entityRef } from '../src/kernel/contracts/entity.ts'

const REPO_ROOT = resolve(process.cwd())
const CHARACTER_ID = 'char_m10_1_expiry'
const ACTIVE_USER = 'user_m10_1_expiry'
const DUE_AT = 1_960_000_000_000
const NOW = DUE_AT + 60_000

interface Check {
  id: string
  label: string
  pass: boolean
  detail: string
}
const checks: Check[] = []
const record = (id: string, label: string, pass: boolean, detail: string): void => {
  checks.push({ id, label, pass, detail })
  console.log(`  ${pass ? '✅' : '❌'} ${id} ${label} —— ${detail}`)
}

/** 造一行（目标 + 可选承诺）；`dueAt` 传 `undefined` = 该目标**没有**截止时间 */
function rowOf(options: {
  goalId: string
  dueAt?: number
  commitmentStatus?: 'active' | 'fulfilled' | 'cancelled' | 'expired'
  revision?: number
  /** 承诺的接受依据（真承诺**非空** —— 放行口要求操作引用对话来源） */
  acceptanceEventIds?: readonly string[]
}): GoalRowState {
  const revision = options.revision ?? 1
  return {
    goal: {
      goalId: options.goalId as never,
      characterId: CHARACTER_ID,
      owner: entityRef('character', CHARACTER_ID),
      origin: 'user_requested',
      sourceRefs: [],
      revision: 1,
      statement: '明天十点二十五楼下见',
      successCriterion: { kind: 'user_report' },
      status: 'active',
      priority: 'normal',
      dependencies: [],
      time: {
        recordedAt: DUE_AT - 3_600_000,
        ...(options.dueAt === undefined ? {} : { dueAt: options.dueAt }),
      },
    },
    commitment:
      options.commitmentStatus === undefined
        ? null
        : {
            commitmentId: `cmt:${options.goalId}` as never,
            goalId: options.goalId as never,
            actor: entityRef('character', CHARACTER_ID),
            beneficiary: entityRef('user', ACTIVE_USER),
            scope: '在楼下见',
            acceptedAt: DUE_AT - 3_600_000,
            acceptanceRefs: (options.acceptanceEventIds ?? ['cev:user:accept']).map((id) => ({
              conversationEventId: id as never,
              fingerprint: `fp:${id}`,
            })),
            criterion: { kind: 'user_report' },
            status: options.commitmentStatus,
            completionRefs: [],
            revision,
          },
  }
}

const depsWith = (rows: readonly GoalRowState[]): GoalValidatorDeps => ({
  registry: createFullDomainEventRegistry(),
  processed: { hasProcessed: async (): Promise<boolean> => false },
  state: {
    getGoal: async (_characterId, goalId) =>
      rows.find((row) => String(row.goal.goalId) === String(goalId)),
    listGoals: async (): Promise<never[]> => rows as never,
  },
  policy: { characterId: CHARACTER_ID, activeUserId: ACTIVE_USER },
})

// ---------------------------------------------------------------------------
// E1 正控：截止已过 ⇒ 恰好 1 个 target，载荷字段对
// ---------------------------------------------------------------------------
const overdueRow = rowOf({ goalId: 'gol:overdue', dueAt: DUE_AT, commitmentStatus: 'active' })
const planned = planCommitmentExpiries({ characterId: CHARACTER_ID, rows: [overdueRow], now: NOW })
const first = planned[0]
const payload = (first?.target.payload ?? {}) as Record<string, unknown>
record(
  'E1',
  '【正控】未结清承诺 + 目标截止**已过** ⇒ 恰好 1 个 `COMMITMENT_EXPIRED`；`basis=due_at_passed` · `dueAt`=目标的 · `expiredAt`=程序时钟 · `expectedRevision`=当前 revision',
  planned.length === 1 &&
    first?.target.type === 'COMMITMENT_EXPIRED' &&
    payload.basis === 'due_at_passed' &&
    Number(payload.dueAt) === DUE_AT &&
    Number(payload.expiredAt) === NOW &&
    Number(payload.expectedRevision) === 1,
  `planned=${String(planned.length)} · type=${String(first?.target.type)} · basis=${String(payload.basis)} · dueAt=${String(payload.dueAt)} · expiredAt=${String(payload.expiredAt)}`
)

// ---------------------------------------------------------------------------
// E2/E3 放行口接受 + 折叠成终态
// ---------------------------------------------------------------------------
const proposal = goalProposalOf({
  proposalId: 'm10.1-expiry-probe',
  operation: 'create',
  characterId: CHARACTER_ID,
  processor: 'm10.1-expiry-verify',
  processorVersion: 'm10.1-expiry-verify@1',
  sourceConversationEventIds: [...first!.sourceEventIds],
  sourceQualifications: first!.sourceEventIds.map((id) => ({ eventId: id, qualification: 'ESTABLISHED' as const })),
  targets: [first!.target],
})
const outcome = await validateGoalProposal(depsWith([overdueRow]), proposal)
record(
  'E2',
  '【放行口接受】真放行口（行状态 = 该目标+承诺）接受这条到期事件',
  outcome.accepted === true && outcome.acceptedEvents.length === 1,
  `accepted=${String(outcome.accepted)} · 事件=${String(outcome.acceptedEvents.length)} · 拒绝=${JSON.stringify(outcome.rejected.map((r) => r.code))}`
)

const acceptedEvent = outcome.acceptedEvents[0]
const folded = acceptedEvent === undefined
  ? undefined
  : reduceGoalRow(overdueRow, {
      id: 'evt:expired' as never,
      type: String(acceptedEvent.type),
      characterId: CHARACTER_ID as never,
      payload: acceptedEvent.payload,
      createdAt: NOW,
    } as unknown as DomainEvent)
record(
  'E3',
  '【折叠成终态】真 reducer ⇒ `status=expired` 且 revision +1；**scope/criterion 原样保留**（到期不抹掉"她曾承担过什么"）',
  folded?.commitment?.status === 'expired' &&
    folded.commitment.revision === 2 &&
    folded.commitment.scope === '在楼下见' &&
    folded.commitment.criterion.kind === 'user_report',
  `status=${String(folded?.commitment?.status)} · revision=${String(folded?.commitment?.revision)} · scope 保留=${String(folded?.commitment?.scope === '在楼下见')}`
)

// ---------------------------------------------------------------------------
// E4/E5/E6 三个"不到期"
// ---------------------------------------------------------------------------
const futurePlanned = planCommitmentExpiries({
  characterId: CHARACTER_ID,
  rows: [rowOf({ goalId: 'gol:future', dueAt: NOW + 60_000, commitmentStatus: 'active' })],
  now: NOW,
})
const noDuePlanned = planCommitmentExpiries({
  characterId: CHARACTER_ID,
  rows: [rowOf({ goalId: 'gol:no-due', commitmentStatus: 'active' })],
  now: NOW,
})
const terminalPlanned = planCommitmentExpiries({
  characterId: CHARACTER_ID,
  rows: [rowOf({ goalId: 'gol:done', dueAt: DUE_AT, commitmentStatus: 'fulfilled', revision: 2 })],
  now: NOW,
})
record(
  'E4',
  '【不到期】截止时间在**未来** ⇒ 0 个 target',
  futurePlanned.length === 0,
  `planned=${String(futurePlanned.length)}`
)
record(
  'E5',
  '【没截止不到期】目标没有 `time.dueAt` ⇒ 0 个 target（**不得凭空到期**）',
  noDuePlanned.length === 0,
  `planned=${String(noDuePlanned.length)}`
)
record(
  'E6',
  '【终态不重复】承诺已是 `fulfilled` ⇒ 0 个 target（幂等边界）',
  terminalPlanned.length === 0,
  `planned=${String(terminalPlanned.length)}`
)

// ---------------------------------------------------------------------------
// E7 ⭐ 到期 ≠ 失约：载荷字段集**恰好**等于闭集
// ---------------------------------------------------------------------------
const actualKeys = Object.keys(payload).sort()
const expectedKeys = [...COMMITMENT_EXPIRED_PAYLOAD_KEYS].sort()
const accusationLike = actualKeys.filter((key) =>
  ['reason', 'violationRuleId', 'blame', 'breach', 'accusation'].includes(key)
)
record(
  'E7',
  '【⭐ 到期 ≠ 失约（可执行约束）】载荷字段集**恰好**等于闭集；**没有** reason / violationRuleId / blame 之类字段',
  JSON.stringify(actualKeys) === JSON.stringify(expectedKeys) && accusationLike.length === 0,
  `实际=${JSON.stringify(actualKeys)} · 闭集=${JSON.stringify(expectedKeys)} · 指控类字段=${JSON.stringify(accusationLike)}`
)

// ---------------------------------------------------------------------------
// E8 放行口也会挡"凭空到期"（目标没有 dueAt 时硬塞一个 target）
// ---------------------------------------------------------------------------
const forged = goalProposalOf({
  proposalId: 'm10.1-expiry-forged',
  operation: 'create',
  characterId: CHARACTER_ID,
  processor: 'm10.1-expiry-verify',
  processorVersion: 'm10.1-expiry-verify@1',
  sourceConversationEventIds: ['cev:user:accept'],
  sourceQualifications: [{ eventId: 'cev:user:accept', qualification: 'ESTABLISHED' as const }],
  targets: [
    {
      type: 'COMMITMENT_EXPIRED',
      operation: 'create',
      payload: {
        characterId: CHARACTER_ID,
        commitmentId: 'cmt:gol:no-due',
        goalId: 'gol:no-due',
        expectedRevision: 1,
        expiredAt: NOW,
        dueAt: DUE_AT,
        basis: 'due_at_passed',
      },
      scope: 'CHARACTER_INTERNAL',
    },
  ],
})
const noDueRow = rowOf({ goalId: 'gol:no-due', commitmentStatus: 'active' })
const forgedOutcome = await validateGoalProposal(depsWith([noDueRow]), forged)
record(
  'E8',
  '【放行口也挡】目标**没有**截止时间时，硬塞一条到期 target 也会被拒（`completion_evidence_missing`）',
  forgedOutcome.accepted === false &&
    forgedOutcome.rejected.some((row) => String(row.code) === 'completion_evidence_missing'),
  `accepted=${String(forgedOutcome.accepted)} · 理由=${JSON.stringify(forgedOutcome.rejected.map((r) => r.code))}`
)

// ---------------------------------------------------------------------------
// E9 确定性
// ---------------------------------------------------------------------------
const again = planCommitmentExpiries({ characterId: CHARACTER_ID, rows: [overdueRow], now: NOW })
record(
  'E9',
  '【确定性】同一输入跑两次 ⇒ 逐字段相同（纯函数、不读挂钟）',
  JSON.stringify(planned) === JSON.stringify(again),
  `两次相同=${String(JSON.stringify(planned) === JSON.stringify(again))}`
)

// ---------------------------------------------------------------------------
// E10 非零分母
// ---------------------------------------------------------------------------
const denominators = {
  plannedTargets: planned.length,
  acceptedEvents: outcome.acceptedEvents.length,
  negativeCases: 3,
  payloadKeys: actualKeys.length,
}
record(
  'E10',
  '【非零分母】四类计数全部 > 0（`0 检查 / 0 不一致` 不算 PASS）',
  Object.values(denominators).every((value) => value > 0),
  JSON.stringify(denominators)
)

const failed = checks.filter((check) => !check.pass)
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
const runId = createM11RunId({ wpId: 'm10-1-wp3-expiry', headShort: head })
const dir = openM11RunDir(REPO_ROOT, runId, 'artifacts/m10.1')
const summary = {
  schema: 'm10.1-expiry-verify@1',
  manifestVersion: M11_MANIFEST_VERSION,
  runId,
  head,
  payloadKeyClosedSet: COMMITMENT_EXPIRED_PAYLOAD_KEYS,
  denominators,
  checks,
  summary: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
  verdict: failed.length === 0 ? 'PASS' : 'FAIL',
  disclaimer:
    '本门只证明**到期语义**（时间事实、非指控、放行口与折叠都认）。它**不**证明"生产里已经会扫描到期" —— ' +
    '扫描的装配与结清事实块进 prompt 属 WP4；也不主张"她因此不再重复提"（那是 WP4 的对照读数）。',
}
writeFileSync(join(dir, 'expiry-verify.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
writeM11Manifest(dir, {
  runId,
  wp: 'm10-1-wp3-expiry',
  head,
  headShort: head.slice(0, 12),
  branch: 'codex/m11-execution-plan',
  date: new Date().toISOString().slice(0, 10),
  toolVersions: { node: process.version },
  testType: 'expiry-verify',
  counts: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
  phases: ['offline'],
  supersedes: null,
  notes: 'm10.1:expiry:verify（到期 = 时间事实；载荷字段闭集；离线）',
})

console.log(`runId: ${runId}`)
console.log(`verdict: ${failed.length === 0 ? 'PASS' : 'FAIL'}（${String(checks.length - failed.length)}/${String(checks.length)}）`)
process.exit(failed.length === 0 ? 0 : 1)
