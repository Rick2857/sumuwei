/**
 * M10.1 WP2 —— **提案与同意门**（`m10.1:policy:verify`）。
 *
 * ============================================================================
 *  它证明什么（**全部离线**：不连模型、不连数据库、不读真实库）
 * ============================================================================
 * ```text
 * P1 ⭐ **同提案 create+commit 真的能走通**（这是 (A) 存在的理由）：
 *    `GOAL_CREATED` + `COMMITMENT_ACCEPTED` 在**同一个提案**里 ⇒ 放行口 accepted；
 *    承诺的 `goalId` 等于目标**派生出来的** id；`commitmentId` 由程序派生；
 *    `actor`/`beneficiary` 是**程序事实**（本角色 + 当前 active user），不是提案方给的占位。
 * P2 **判据闭集是硬的**：判据用 `user_report` ⇒ 放行口**拒**（`commitment_criterion_unacceptable`）
 *    —— 这条就是"**R-26 那类约定现在记不下来**"的机器证明。
 * P3 **不带承诺时行为不变**：同一个 create 草案不带 `commitment` ⇒ 只有 **1** 个 target。
 * P4 **构造器（约定 → 草案）**：可表达判据 ⇒ 产出草案，且 `origin` 按**谁提出**映射
 *    （她提出 ⇒ `character_proposed` + `proposedByAssistantEventId`；用户提出 ⇒ `user_requested`）。
 * P5 **构造器的具名拒绝**：不给判据 / 判据不在闭集 / 描述超长 / 无效 span ⇒ 各自具名理由。
 * P6 **约定层负控不产出提案**：WP1 的结构负控逐条 `ok:false` ⇒ 构造器**根本不会被调用**。
 * P7 **非零分母**：每类计数都 > 0。
 * ```
 */

import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { createM11RunId, openM11RunDir, writeM11Manifest, M11_MANIFEST_VERSION } from './m11-evidence.ts'
import { createFullDomainEventRegistry } from '../src/kernel/contracts/domain-event.ts'
import {
  COMMITMENT_ACCEPTABLE_CRITERIA,
  validateGoalProposal,
  type GoalValidatorDeps,
} from '../src/kernel/policies/goal-validator.ts'
import { draftToProgramProposal, type DraftToProgramInput } from '../src/kernel/app/goal/understanding.ts'
import type { GoalCommitmentSummary } from '../src/kernel/app/goal/turn.ts'
import { validateGoalProposalDraft, type GoalProposalDraft } from '../src/kernel/contracts/goal-proposal.ts'
import type { CommitmentStatus, GoalRowState, GoalSuccessCriterion } from '../src/kernel/contracts/goal.ts'
import { entityRef } from '../src/kernel/contracts/index.ts'
import {
  AGREEMENT_PROPOSAL_REJECT_REASONS,
  AGREEMENT_REPRESENTABLE_CRITERION_KINDS,
  buildAgreementProposal,
} from '../src/kernel/app/agreement/proposal.ts'
import {
  assembleAgreementWindow,
  type AgreementRawEntry,
} from '../src/kernel/app/agreement/inputs.ts'
import { validateAgreementDraft, type AcceptedAgreement } from '../src/kernel/contracts/agreement-input.ts'
import { buildAgreementCorpus } from '../evals/m10.1/agreement-corpus.ts'

const REPO_ROOT = resolve(process.cwd())
const CHARACTER_ID = 'char_m10_1_policy'
const ACTIVE_USER = 'user_m10_1_policy'
const SOURCE_EVENT = 'cev:user:1'
const T0 = 1_960_000_000_000

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

/** 离线 deps：目标表**空**（正是"同提案新建目标"要考的场景） */
const deps: GoalValidatorDeps = {
  registry: createFullDomainEventRegistry(),
  processed: { hasProcessed: async (): Promise<boolean> => false },
  state: {
    getGoal: async (): Promise<undefined> => undefined,
    listGoals: async (): Promise<never[]> => [],
  },
  policy: { characterId: CHARACTER_ID, activeUserId: ACTIVE_USER },
}

const base: DraftToProgramInput = {
  characterId: CHARACTER_ID,
  sourceEventId: SOURCE_EVENT,
  proposalId: 'm10.1-policy-probe',
  processor: 'm10.1-policy-verify',
  processorVersion: 'm10.1-policy-verify@1',
  candidates: [],
  sourceText: '下次继续时给你三个步骤',
  now: T0,
}

const draftWithCommitment = (criterion: GoalSuccessCriterion): GoalProposalDraft => ({
  schemaVersion: 'goal-proposal@1',
  operation: 'create',
  span: { start: 0, end: 11 },
  statement: '下次继续时给你三个步骤',
  origin: 'user_requested',
  commitment: {
    scope: '下次继续时给出三个步骤',
    criterion,
    acceptanceEventIds: [SOURCE_EVENT],
  },
})

const observableCriterion: GoalSuccessCriterion = {
  kind: 'conversation_output',
  structure: { kind: 'item_count', count: 3 },
}

// ---------------------------------------------------------------------------
// P1 同提案 create+commit
// ---------------------------------------------------------------------------
const mapped = draftToProgramProposal(draftWithCommitment(observableCriterion), base)
const proposal = mapped.proposal
const outcome = proposal === undefined ? undefined : await validateGoalProposal(deps, proposal)
const events = outcome?.acceptedEvents ?? []
const goalEvent = events.find((event) => String(event.type) === 'GOAL_CREATED')
const commitmentEvent = events.find((event) => String(event.type) === 'COMMITMENT_ACCEPTED')
const goalPayload = goalEvent?.payload as { goal?: { goalId?: string } } | undefined
const commitmentPayload = commitmentEvent?.payload as
  | {
      goalId?: string
      commitment?: {
        commitmentId?: string
        goalId?: string
        actor?: { kind?: string; id?: string }
        beneficiary?: { kind?: string; id?: string }
        revision?: number
        status?: string
      }
    }
  | undefined
const derivedGoalId = String(goalPayload?.goal?.goalId ?? '')
const committedGoalId = String(commitmentPayload?.goalId ?? '')
record(
  'P1',
  '【同提案 create+commit 走通】放行口 accepted，两个事件同批；承诺的 goalId **等于**目标派生 id；commitmentId 由程序派生',
  outcome?.accepted === true &&
    events.length === 2 &&
    goalEvent !== undefined &&
    commitmentEvent !== undefined &&
    derivedGoalId !== '' &&
    committedGoalId === derivedGoalId &&
    String(commitmentPayload?.commitment?.commitmentId ?? '') !== '' &&
    String(commitmentPayload?.commitment?.commitmentId ?? '') !== '(derived-by-validator)',
  `accepted=${String(outcome?.accepted)} · 事件=${String(events.length)} · goalId 相等=${String(committedGoalId === derivedGoalId)} · 派生=${derivedGoalId.slice(0, 28)}`
)
record(
  'P2',
  '【身份是程序事实】`actor` = 本角色 · `beneficiary` = 当前 active user（**不是**提案里的占位）',
  commitmentPayload?.commitment?.actor?.kind === 'character' &&
    commitmentPayload?.commitment?.actor?.id === CHARACTER_ID &&
    commitmentPayload?.commitment?.beneficiary?.kind === 'user' &&
    commitmentPayload?.commitment?.beneficiary?.id === ACTIVE_USER,
  `actor=${JSON.stringify(commitmentPayload?.commitment?.actor)} · beneficiary=${JSON.stringify(commitmentPayload?.commitment?.beneficiary)}`
)
record(
  'P3',
  '【入账形状】承诺 `revision=1` / `status=active`（放行口归一化的结果进的是账本）',
  commitmentPayload?.commitment?.revision === 1 && commitmentPayload?.commitment?.status === 'active',
  `revision=${String(commitmentPayload?.commitment?.revision)} · status=${String(commitmentPayload?.commitment?.status)}`
)

// ---------------------------------------------------------------------------
// P4 ⭐ 闭集**已按裁定 (U-03-a) 扩类**：`user_report` 现在**被接受**
// ---------------------------------------------------------------------------
const userReportOutcome = await (async () => {
  const forced = draftToProgramProposal(draftWithCommitment({ kind: 'user_report' }), base)
  return forced.proposal === undefined ? undefined : await validateGoalProposal(deps, forced.proposal)
})()
const userReportEvents = userReportOutcome?.acceptedEvents ?? []
const userReportCommitment = userReportEvents.find((event) => String(event.type) === 'COMMITMENT_ACCEPTED')
  ?.payload as { commitment?: { criterion?: { kind?: string } } } | undefined
record(
  'P4',
  '【⭐ 裁定 (U-03-a)：`user_report` 被接受】"双方约定"那类（判据 = 他到没到，只能由对方报告）现在**能**成为承诺；事件里 `criterion.kind = user_report`',
  userReportOutcome?.accepted === true &&
    userReportEvents.length === 2 &&
    userReportCommitment?.commitment?.criterion?.kind === 'user_report',
  `accepted=${String(userReportOutcome?.accepted)} · 事件=${String(userReportEvents.length)} · criterion=${String(userReportCommitment?.commitment?.criterion?.kind)} · 闭集=${COMMITMENT_ACCEPTABLE_CRITERIA.join('/')}`
)

// ---------------------------------------------------------------------------
// P4b 闭集**仍然设闸**：未知判据类仍然被拒（扩类 ≠ 取消闸门）
// ---------------------------------------------------------------------------
const unknownKindOutcome = await (async () => {
  const forced = draftToProgramProposal(draftWithCommitment({ kind: 'made_up_kind' } as never), base)
  return forced.proposal === undefined ? undefined : await validateGoalProposal(deps, forced.proposal)
})()
const unknownReasons = (unknownKindOutcome?.rejected ?? []).map((row) => String(row.code))
record(
  'P4b',
  '【闭集仍然设闸】未知判据类（`made_up_kind`）仍然被**拒** —— 扩的是**闭集内容**，不是取消闸门（⚠️ 实测它被**更早**的载荷校验挡下：`goal_proposal_invalid_shape`，语义分支根本走不到）',
  unknownKindOutcome?.accepted === false &&
    (unknownReasons.includes('commitment_criterion_unacceptable') ||
      unknownReasons.includes('goal_proposal_invalid_shape')),
  `accepted=${String(unknownKindOutcome?.accepted)} · 理由=${JSON.stringify(unknownReasons)}`
)

// ---------------------------------------------------------------------------
// P5 不带承诺 ⇒ 行为不变（只有 1 个 target）
// ---------------------------------------------------------------------------
const withoutCommitment = draftToProgramProposal(
  {
    schemaVersion: 'goal-proposal@1',
    operation: 'create',
    span: { start: 0, end: 11 },
    statement: '下次继续时给你三个步骤',
    origin: 'user_requested',
  },
  base
)
const singleOutcome =
  withoutCommitment.proposal === undefined
    ? undefined
    : await validateGoalProposal(deps, withoutCommitment.proposal)
record(
  'P5',
  '【不带承诺时行为不变】同一个 create 草案不带 `commitment` ⇒ 只有 **1** 个 target，事件仍是 `GOAL_CREATED`',
  (withoutCommitment.proposal?.targetEvents.length ?? 0) === 1 &&
    singleOutcome?.accepted === true &&
    (singleOutcome?.acceptedEvents.length ?? 0) === 1,
  `targets=${String(withoutCommitment.proposal?.targetEvents.length)} · accepted=${String(singleOutcome?.accepted)} · 事件=${String(singleOutcome?.acceptedEvents.length)}`
)

// ---------------------------------------------------------------------------
// P6 构造器：正控（可表达判据）+ origin 映射
// ---------------------------------------------------------------------------
const agreementFor = (proposedBy: 'character' | 'user'): AcceptedAgreement => ({
  content: '下次继续时给你三个步骤',
  criterion: '下次继续时给出三个步骤',
  proposedByEventId: proposedBy === 'character' ? 'cev:char:1' : 'cev:user:1',
  proposedBy,
  acceptedByEventId: proposedBy === 'character' ? 'cev:user:2' : 'cev:char:2',
  acceptedBy: proposedBy === 'character' ? 'user' : 'character',
})
const built = buildAgreementProposal({
  agreement: agreementFor('character'),
  characterId: CHARACTER_ID,
  span: { start: 0, end: 12 },
  proposalId: 'm10.1-policy-built',
  processor: 'm10.1-policy-verify',
  processorVersion: 'm10.1-policy-verify@1',
  now: T0,
  criterion: observableCriterion,
})
const builtUser = buildAgreementProposal({
  agreement: agreementFor('user'),
  characterId: CHARACTER_ID,
  span: { start: 0, end: 12 },
  proposalId: 'm10.1-policy-built-user',
  processor: 'm10.1-policy-verify',
  processorVersion: 'm10.1-policy-verify@1',
  now: T0,
  criterion: observableCriterion,
})
record(
  'P6',
  '【构造器·origin 映射】她提出 ⇒ `character_proposed` + `proposedByAssistantEventId`；用户提出 ⇒ `user_requested`（且都不带那个字段）',
  built.ok === true &&
    built.draft.origin === 'character_proposed' &&
    built.draft.proposedByAssistantEventId === 'cev:char:1' &&
    (built.draft.commitment?.acceptanceEventIds?.length ?? 0) === 2 &&
    builtUser.ok === true &&
    builtUser.draft.origin === 'user_requested' &&
    builtUser.draft.proposedByAssistantEventId === undefined,
  `她提出=${built.ok ? built.draft.origin : String(built.reason)} · 用户提出=${builtUser.ok ? builtUser.draft.origin : String(builtUser.reason)}`
)

// ---------------------------------------------------------------------------
// P7 构造器的具名拒绝
// ---------------------------------------------------------------------------
const refusals: { id: string; expected: string; got: string }[] = []
const tryRefuse = (id: string, expected: string, overrides: Partial<Parameters<typeof buildAgreementProposal>[0]>) => {
  const verdict = buildAgreementProposal({
    agreement: agreementFor('character'),
    characterId: CHARACTER_ID,
    span: { start: 0, end: 12 },
    proposalId: 'm10.1-policy-refuse',
    processor: 'm10.1-policy-verify',
    processorVersion: 'm10.1-policy-verify@1',
    now: T0,
    criterion: observableCriterion,
    ...overrides,
  })
  refusals.push({ id, expected, got: verdict.ok ? 'accepted' : verdict.reason })
}
tryRefuse('no-criterion', 'criterion_not_representable', { criterion: undefined })
/*
 * ⚠️ **裁定 (U-03-a) 之后**：`user_report` **不再是**拒绝项（它现在可表达）。
 *    这里换成"**未知类**"的负控 —— 构造器的前置闸依然要拦住闭集外的东西。
 */
tryRefuse('unknown-kind', 'criterion_not_representable', { criterion: { kind: 'made_up_kind' } as never })
tryRefuse('long-statement', 'statement_too_long', {
  agreement: { ...agreementFor('character'), content: '长'.repeat(501) },
})
tryRefuse('bad-span', 'missing_span', { span: { start: 5, end: 5 } })
tryRefuse('long-scope', 'scope_too_long', {
  agreement: { ...agreementFor('character'), criterion: '判'.repeat(301) },
})
const refusalFailures = refusals.filter((row) => row.got !== row.expected)
record(
  'P7',
  '【构造器具名拒绝】负控**逐条**给出预期理由（不是"被拒了"就算）',
  refusalFailures.length === 0 && AGREEMENT_PROPOSAL_REJECT_REASONS.length >= 5,
  `不符=${JSON.stringify(refusalFailures)} · 理由闭集=${String(AGREEMENT_PROPOSAL_REJECT_REASONS.length)}`
)

// ---------------------------------------------------------------------------
// P8 约定层负控 ⇒ 构造器根本不会被调用
// ---------------------------------------------------------------------------
const corpus = buildAgreementCorpus().filter((item) => item.layer === 'structural')
const negatives = corpus.filter((item) => item.expected.kind === 'rejected')
const negativeResults = negatives.map((item) => {
  const window = assembleAgreementWindow({ entries: item.window as readonly AgreementRawEntry[] })
  const verdict = validateAgreementDraft(item.draft, window)
  return { caseId: item.caseId, blocked: verdict.ok === false, reason: verdict.ok ? 'accepted' : verdict.reason }
})
const leaked = negativeResults.filter((row) => !row.blocked)
record(
  'P8',
  '【约定层负控不产出提案】结构负控逐条在**约定层**就被挡下 ⇒ 构造器不会被调用（不会有"半个提案"）',
  leaked.length === 0 && negatives.length >= 6,
  `负控 ${String(negatives.length)} 条 · 漏过=${JSON.stringify(leaked)}`
  )

// ---------------------------------------------------------------------------
// P10 ⭐ **模型面能不能表达一条承诺**（`R-29` 的修复；正控）
// ---------------------------------------------------------------------------
/*
 * ⚠️ 为什么必须在这里、且必须**从模型形状开始**：
 *    P1–P6 走的都是 `buildAgreementProposal`（**程序侧**构造器）——它造的草案**绕过**草案校验器。
 *    于是"闭集表里没有 `commitment`"这个缺口在**所有**门里都看不见（实测：M11.1 联调才发现，
 *    报 `unknown_field`）。本组从**模型会产出的那个普通对象**开始，先过 `validateGoalProposalDraft`。
 */
const sourceTextForModel = base.sourceText
/** 模型会产出的形状：**只有** `scope` + `criterion`，没有也不许有 id */
const modelShapedRaw = {
  schemaVersion: 'goal-proposal@1',
  operation: 'create',
  span: { start: 0, end: 11 },
  statement: '下次继续时给出三个步骤',
  origin: 'user_requested',
  commitment: { scope: '下次继续时给出三个步骤', criterion: { kind: 'user_report' } },
}
const modelDraftVerdict = validateGoalProposalDraft(modelShapedRaw, {
  sourceText: sourceTextForModel,
  candidateGoalIds: [],
})
record(
  'P10',
  '【⭐ 模型面能表达承诺】`validateGoalProposalDraft` **接受**带 `commitment`（只有 `scope`+`criterion`）的草案 —— 闭集表不再漏这个字段（`R-29` 的修复）',
  modelDraftVerdict.ok === true,
  modelDraftVerdict.ok ? '接受' : `拒绝=${modelDraftVerdict.reason}：${modelDraftVerdict.detail}`
)

const modelMapped = modelDraftVerdict.ok
  ? draftToProgramProposal(modelDraftVerdict.draft, { ...base, proposalId: 'm10.1-policy-model' })
  : undefined
const modelOutcome =
  modelMapped?.proposal === undefined ? undefined : await validateGoalProposal(deps, modelMapped.proposal)
const modelEvents = modelOutcome?.acceptedEvents ?? []
const modelCommitmentEvent = modelEvents.find(
  (event) => String(event.type) === 'COMMITMENT_ACCEPTED',
)
const modelAcceptanceRefs =
  (
    modelCommitmentEvent?.payload as
      | {
          commitment?: {
            acceptanceRefs?: readonly {
              conversationEventId?: unknown
              span?: unknown
              fingerprint?: unknown
            }[]
          }
        }
      | undefined
  )?.commitment?.acceptanceRefs ?? []
record(
  'P11',
  '【模型面走通整条链】放行口**接受**两个事件；承诺的 `acceptanceRefs` = **1 条且来自程序事实**（本轮那条用户事件，带真 span 与真指纹）—— 模型没写任何 id',
  modelOutcome?.accepted === true &&
    modelEvents.length === 2 &&
    modelAcceptanceRefs.length === 1 &&
    String(modelAcceptanceRefs[0]?.conversationEventId) === SOURCE_EVENT &&
    modelAcceptanceRefs[0]?.span !== undefined &&
    modelAcceptanceRefs[0]?.fingerprint !== undefined,
  `accepted=${String(modelOutcome?.accepted)} · 事件=${String(modelEvents.length)} · refs=${String(
    modelAcceptanceRefs.length
  )} · 出处=${String(modelAcceptanceRefs[0]?.conversationEventId)}`
)

/** 模型面的**四条**负控（各自要给出**具名**理由，不是"被拒了"就算） */
const modelLayerCases: { id: string; expected: string; raw: unknown }[] = [
  {
    id: 'inner-id',
    expected: 'unknown_field',
    raw: {
      ...modelShapedRaw,
      commitment: {
        scope: '下次继续时给出三个步骤',
        criterion: { kind: 'user_report' },
        acceptanceEventIds: [SOURCE_EVENT],
      },
    },
  },
  {
    id: 'action-result',
    expected: 'enum_value_unknown',
    raw: {
      ...modelShapedRaw,
      commitment: {
        scope: '下次继续时给出三个步骤',
        criterion: {
          kind: 'action_result',
          capability: 'filesystem.write',
          operation: 'write',
          require: 'executed_succeeded',
        },
      },
    },
  },
  {
    id: 'on-query',
    expected: 'field_present_for_operation',
    raw: { ...modelShapedRaw, operation: 'query' },
  },
  {
    id: 'scope-too-long',
    expected: 'text_too_long',
    raw: {
      ...modelShapedRaw,
      commitment: { scope: '长'.repeat(301), criterion: { kind: 'user_report' } },
    },
  },
]
const modelLayerResults = modelLayerCases.map((testCase) => {
  const verdict = validateGoalProposalDraft(testCase.raw, {
    sourceText: sourceTextForModel,
    candidateGoalIds: [],
  })
  return {
    id: testCase.id,
    expected: testCase.expected,
    got: verdict.ok ? 'accepted' : verdict.reason,
  }
})
const modelLayerMisses = modelLayerResults.filter((row) => row.got !== row.expected)
record(
  'P12',
  '【模型面负控×4】内层写 id ⇒ `unknown_field` · 判据用 `action_result` ⇒ `enum_value_unknown` · 挂在 `query` 上 ⇒ `field_present_for_operation` · `scope` 超界 ⇒ `text_too_long`（**逐条**给具名理由）',
  modelLayerMisses.length === 0 && modelLayerResults.length === 4,
  `不符=${JSON.stringify(modelLayerMisses)} · 实测=${JSON.stringify(modelLayerResults.map((row) => `${row.id}:${row.got}`))}`
)

/**
 * P13 **程序面没被动**：构造器给的草案（**带** id）仍然映射出 **2 条** `acceptanceRefs`
 * —— 模型面那条回落**没有**改程序侧的形状（同一个类型两个调用方，各自成立）。
 *
 * ⚠️ 用 `builtUser`（用户提出）而不是 `built`（她提出）：后者的**目标**还要过 D28
 *    （两组带 `span` 的引用）⇒ 那与本条要判的"承诺侧出处"是两件事，混在一起会让读数含混。
 */
const builtUserMapped = builtUser.ok
  ? draftToProgramProposal(builtUser.draft, { ...base, proposalId: 'm10.1-policy-program' })
  : undefined
const builtUserOutcome =
  builtUserMapped?.proposal === undefined
    ? undefined
    : await validateGoalProposal(deps, builtUserMapped.proposal)
const builtUserEvents = builtUserOutcome?.acceptedEvents ?? []
const builtUserCommitment = builtUserEvents.find(
  (event) => String(event.type) === 'COMMITMENT_ACCEPTED'
)
const builtUserRefs =
  (
    builtUserCommitment?.payload as
      | { commitment?: { acceptanceRefs?: readonly { conversationEventId?: unknown }[] } }
      | undefined
  )?.commitment?.acceptanceRefs ?? []
record(
  'P13',
  '【程序面未被动】构造器那条路仍是 **2 条** `acceptanceRefs`（且是**程序给的那两个 id**）：模型面的回落只补"模型不知道的那一条"',
  builtUserOutcome?.accepted === true &&
    builtUserRefs.length === 2 &&
    builtUserRefs.some((ref) => String(ref.conversationEventId) === SOURCE_EVENT),
  `refs=${String(builtUserRefs.length)} · 出处=${JSON.stringify(builtUserRefs.map((ref) => String(ref.conversationEventId)))}`
)

/**
 * P14/P15 **兑现的生产者**（`COMMITMENT_FULFILLED` 在 M10 里没有生产者 ⇒ 本步补上的接入点）。
 *
 * ⚠️ 为什么必须在这里判：`report_complete` 走真放行口时，目标身上那条**未结清**的
 *    `user_report` 承诺必须**同提案**补一条兑现 —— 否则"结清"在生产里不可达，
 *    M10.1 的目标 ③（已结清 ⇒ 不要再提）就永远走不到。
 */
const commitmentRowOf = (status: CommitmentStatus, criterionKind: 'user_report' | 'conversation_output'): GoalRowState => ({
  goal: {
    goalId: 'gol:m10-1-policy-done' as never,
    characterId: CHARACTER_ID,
    owner: entityRef('character', CHARACTER_ID),
    origin: 'user_requested',
    sourceRefs: [{ conversationEventId: SOURCE_EVENT as never, fingerprint: 'fp-accept' }],
    revision: 1,
    statement: '下次继续时给出三个步骤',
    successCriterion: { kind: 'user_report' },
    status: 'active',
    priority: 'normal',
    dependencies: [],
    time: { recordedAt: T0 },
  } as never,
  commitment: {
    commitmentId: 'cmt:m10-1-policy' as never,
    goalId: 'gol:m10-1-policy-done' as never,
    actor: entityRef('character', CHARACTER_ID),
    beneficiary: entityRef('user', ACTIVE_USER),
    scope: '下次继续时给出三个步骤',
    acceptedAt: T0,
    acceptanceRefs: [{ conversationEventId: SOURCE_EVENT as never, fingerprint: 'fp-accept' }],
    criterion:
      criterionKind === 'user_report'
        ? { kind: 'user_report' }
        : ({ kind: 'conversation_output', structure: { kind: 'item_count', count: 3 } } as never),
    status,
    completionRefs: [],
    revision: 1,
  } as never,
})

const depsWithRow = (row: GoalRowState): GoalValidatorDeps => ({
  ...deps,
  state: {
    getGoal: async () => row,
    listGoals: async () => [row],
  },
})

const REPORT_DRAFT: GoalProposalDraft = {
  schemaVersion: 'goal-proposal@1',
  operation: 'report_complete',
  span: { start: 0, end: 4 },
  targetGoalId: 'gol:m10-1-policy-done',
}
const commitmentSummary = (
  criterionKind: 'user_report' | 'conversation_output',
  status: CommitmentStatus
): GoalCommitmentSummary => ({
  goalId: 'gol:m10-1-policy-done',
  commitmentId: 'cmt:m10-1-policy',
  revision: 1,
  criterionKind,
  status,
})

/** 跑一次"结清"：给定行与承诺摘要 ⇒ 事件类型表 */
const runClosure = async (input: {
  readonly row: GoalRowState
  readonly commitments?: readonly GoalCommitmentSummary[]
}): Promise<{ readonly accepted: boolean; readonly codes: readonly string[]; readonly types: readonly string[]; readonly refs: readonly unknown[] }> => {
  const mapped = draftToProgramProposal(REPORT_DRAFT, {
    ...base,
    proposalId: 'm10.1-policy-closure',
    /* 候选集必须与放行口看到的是**同一份**（否则映射直接抛：那是"两个推导点"） */
    candidates: [
      {
        goalId: 'gol:m10-1-policy-done',
        status: 'active',
        priority: 'normal',
        statement: '下次继续时给出三个步骤',
        revision: 1,
      },
    ],
    ...(input.commitments === undefined ? {} : { targetCommitments: input.commitments }),
  })
  if (mapped.proposal === undefined) return { accepted: false, codes: ['no_proposal'], types: [], refs: [] }
  const outcome = await validateGoalProposal(depsWithRow(input.row), mapped.proposal)
  const events = outcome.acceptedEvents
  const fulfilled = events.find((event) => String(event.type) === 'COMMITMENT_FULFILLED')
  return {
    accepted: outcome.accepted,
    codes: outcome.rejected.map((row) => String(row.code)),
    types: events.map((event) => String(event.type)).sort(),
    refs:
      (fulfilled?.payload as { resultRefs?: readonly unknown[] } | undefined)?.resultRefs ?? [],
  }
}

const closurePositive = await runClosure({
  row: commitmentRowOf('active', 'user_report'),
  commitments: [commitmentSummary('user_report', 'active')],
})
record(
  'P14',
  '【⭐ 兑现的生产者】目标身上挂着**未结清**的 `user_report` 承诺 ⇒ `report_complete` **同提案**补 `COMMITMENT_FULFILLED`（两个事件同批 · `resultRefs` 是本轮那条用户事件）',
  closurePositive.accepted &&
    closurePositive.types.join(',') === 'COMMITMENT_FULFILLED,GOAL_COMPLETED' &&
    closurePositive.refs.length === 1,
  `accepted=${String(closurePositive.accepted)} · 事件=${JSON.stringify(closurePositive.types)} · refs=${String(
    closurePositive.refs.length
  )} · 拒绝=${JSON.stringify(closurePositive.codes)}`
)

const closureNoSummary = await runClosure({ row: commitmentRowOf('active', 'user_report') })
const closureWrongCriterion = await runClosure({
  row: commitmentRowOf('active', 'conversation_output'),
  commitments: [commitmentSummary('conversation_output', 'active')],
})
const closureAlreadyTerminal = await runClosure({
  row: commitmentRowOf('fulfilled', 'user_report'),
  commitments: [commitmentSummary('user_report', 'fulfilled')],
})
record(
  'P15',
  '【负控×3】**不给摘要**（失败关闭）· 判据是 `conversation_output`（一句"我到了"不许兑现它）· 承诺**已是终态** ⇒ 三条都**不补**兑现',
  closureNoSummary.types.join(',') === 'GOAL_COMPLETED' &&
    closureWrongCriterion.types.join(',') === 'GOAL_COMPLETED' &&
    (closureAlreadyTerminal.types.join(',') === 'GOAL_COMPLETED' ||
      closureAlreadyTerminal.codes.includes('goal_terminal_state')),
  `无摘要=${JSON.stringify(closureNoSummary.types)} · 判据不符=${JSON.stringify(
    closureWrongCriterion.types
  )} · 已终态=${JSON.stringify(closureAlreadyTerminal.types)}/${JSON.stringify(closureAlreadyTerminal.codes)}`
)

// ---------------------------------------------------------------------------
// P9 非零分母
// ---------------------------------------------------------------------------
const denominators = {
  acceptedEvents: events.length,
  userReportAccepted: userReportEvents.length,
  unknownKindRejections: unknownReasons.length,
  builderPositives: Number(built.ok) + Number(builtUser.ok),
  builderRefusals: refusals.length,
  agreementNegatives: negatives.length,
  modelLayerCases: modelLayerResults.length,
  modelAcceptanceRefs: modelAcceptanceRefs.length,
}
record(
  'P9',
  '【非零分母】五类计数全部 > 0（`0 检查 / 0 不一致` 不算 PASS）',
  Object.values(denominators).every((value) => value > 0),
  JSON.stringify(denominators)
)

const failed = checks.filter((check) => !check.pass)
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
const runId = createM11RunId({ wpId: 'm10-1-wp2', headShort: head })
const dir = openM11RunDir(REPO_ROOT, runId, 'artifacts/m10.1')
const payload = {
  schema: 'm10.1-policy-verify@1',
  manifestVersion: M11_MANIFEST_VERSION,
  runId,
  head,
  commitmentClosedSet: COMMITMENT_ACCEPTABLE_CRITERIA,
  agreementRepresentableKinds: AGREEMENT_REPRESENTABLE_CRITERION_KINDS,
  denominators,
  builderRefusals: refusals,
  agreementNegativeResults: negativeResults,
  checks,
  summary: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
  verdict: failed.length === 0 ? 'PASS' : 'FAIL',
  disclaimer:
    '本门**离线**驱动真放行口（目标表为空）⇒ 它证明的是"同提案 create+commit 能走通、身份由程序算、' +
    '判据闭集是硬的"。它**不**主张"承诺在生产里已经生效"（那要等到接线与真实链读数）。',
}
writeFileSync(join(dir, 'policy-verify.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
writeM11Manifest(dir, {
  runId,
  wp: 'm10-1-wp2',
  head,
  headShort: head.slice(0, 12),
  branch: 'codex/m11-execution-plan',
  date: new Date().toISOString().slice(0, 10),
  toolVersions: { node: process.version },
  testType: 'policy-verify',
  counts: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
  phases: ['offline'],
  supersedes: null,
  notes: `m10.1:policy:verify（同提案 create+commit 走通 · 判据闭集是硬的 · 离线）`,
})

console.log(`runId: ${runId}`)
console.log(`verdict: ${failed.length === 0 ? 'PASS' : 'FAIL'}（${String(checks.length - failed.length)}/${String(checks.length)}）`)
process.exit(failed.length === 0 ? 0 : 1)
