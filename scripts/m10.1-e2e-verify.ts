/**
 * M10.1 WP5 —— **端到端门**（`m10.1:e2e:verify`）。
 *
 * ============================================================================
 *  它把整条链**串起来跑一遍**（全部离线：不连模型、不连数据库）
 * ============================================================================
 * ```text
 * ① **约定**（R-26 的形状："明天十点二十五楼下见"）：她提出 + 用户接受
 *    ⇒ 走 WP1 的 `validateAgreementDraft`（**必须指得到出处**）
 * ② **提案**：WP2 的构造器 → 草案（判据 = `user_report` —— 裁定 (U-03-a) 之后可表达）
 * ③ **放行口**：真 `validateGoalProposal`（行表为空 ⇒ 考同提案 create+commit）
 *    ⇒ 接受，两个事件同批（`GOAL_CREATED` + `COMMITMENT_ACCEPTED`）
 * ④ **折叠**：真 reducer ⇒ 一行（目标 + **未结清**承诺）
 * ⑤ **块**：`未结清的约定`（她**可以**正常提）——且**没有**"不要再提"
 * ⑥ ⭐ **真的过 provider**：`createCommitmentStateProvider(...).provide(...)`
 *    ⇒ 1 个 section，id = `commitment-state`（**块真的进 packet**）；
 *    额度 0 ⇒ **0 个 section**（关闭档与基线逐字相同）
 * ⑦ ⭐ **结清（fulfilled）**：真 reducer 折叠 ⇒ `已结清，不要再提`
 * ⑧ ⭐ **到期（expired）**：规划器 + 放行口 + 真 reducer ⇒ `已过期（时间到了），不要再提`
 *    （措辞**不含指控**；截止时间本身仍**没有生产来源** —— `U-04`）
 * ⑨ **R-26 的机制级对照**：结清**前**渲染出的"不要再提"行数 = 0；**后** = 1（两条读数分列）
 *    ⚠️ **行为级**读数（她是否真的不再提）**NOT RUN** —— 它需要真实模型，见 §末
 * ⑩ 确定性 + 非零分母
 * ```
 */

import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { createM11RunId, openM11RunDir, writeM11Manifest, M11_MANIFEST_VERSION } from './m11-evidence.ts'
import { createFullDomainEventRegistry } from '../src/kernel/contracts/domain-event.ts'
import { validateGoalProposal, type GoalValidatorDeps } from '../src/kernel/policies/goal-validator.ts'
import { draftToProgramProposal, type DraftToProgramInput } from '../src/kernel/app/goal/understanding.ts'
import { reduceGoalRow } from '../src/kernel/projections/goal.ts'
import { planCommitmentExpiries } from '../src/kernel/app/goal/expiry.ts'
import {
  COMMITMENT_DO_NOT_RAISE,
  COMMITMENT_SECTION_ID,
  commitmentFactRowsOf,
  createCommitmentStateProvider,
  renderCommitmentStateBlock,
} from '../src/kernel/app/goal/commitment-facts.ts'
import { buildAgreementProposal } from '../src/kernel/app/agreement/proposal.ts'
import { assembleAgreementWindow } from '../src/kernel/app/agreement/inputs.ts'
import { validateAgreementDraft } from '../src/kernel/contracts/agreement-input.ts'
import { entityRef } from '../src/kernel/contracts/entity.ts'
import type { GoalRowState } from '../src/kernel/contracts/goal.ts'
import type { DomainEvent } from '../src/kernel/contracts/domain-event.ts'

const REPO_ROOT = resolve(process.cwd())
const CHARACTER_ID = 'char_m10_1_e2e'
const ACTIVE_USER = 'user_m10_1_e2e'
const SOURCE_EVENT = 'cev:user:accept'
const T0 = 1_970_000_000_000
const quantify = (text: string): number => [...text].length

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

// ---------------------------------------------------------------------------
// ① 约定（R-26 的形状）
// ---------------------------------------------------------------------------
const window = assembleAgreementWindow({
  entries: [
    /*
     * ⚠️ 用**用户提出 + 她接受**这条形状（裁定 (U-03-a)/(b) 之后它同样是"双方合意"）。
     *    为什么不用"她提出"那条：实测**它会被放行口拒**（`goal_proposal_ambiguous_target`）——
     *    `character_proposed` 要求**两组**带 span 的引用（提议侧 + 采纳侧，D28），
     *    而装配层（`understanding.ts` 的 create 分支）**只造一个** `sourceRef`。
     *    ⇒ 这是 M10 层面的缺口，已登记为 `L-M10.1-04`（见 WP5 交接单）；
     *      修它需要一个"**提议侧指纹**"约定（提议原话不在输入形状里），属**设计决定**，不半修。
     */
    { id: SOURCE_EVENT, actorType: 'user', sequence: 1, text: '明天十点二十五楼下见吧。' },
    { id: 'cev:char:2', actorType: 'character', sequence: 2, text: '行。' },
  ],
})
const agreementVerdict = validateAgreementDraft(
  {
    kind: 'mutual_agreement',
    content: '明天十点二十五在楼下见',
    criterion: '他到楼下（由他报告）',
    proposedByEventId: SOURCE_EVENT,
    acceptedByEventId: 'cev:char:2',
  },
  window
)
record(
  'E1',
  '【① 约定】双方合意（**用户提出 + 她接受**）通过 WP1 校验，**出处可解析**',
  agreementVerdict.ok === true &&
    agreementVerdict.value.proposedByEventId === SOURCE_EVENT &&
    agreementVerdict.value.acceptedByEventId === 'cev:char:2' &&
    agreementVerdict.value.proposedBy === 'user',
  agreementVerdict.ok
    ? `出处=${agreementVerdict.value.proposedByEventId} + ${agreementVerdict.value.acceptedByEventId} · 提出者=${agreementVerdict.value.proposedBy}`
    : `拒绝=${agreementVerdict.reason}`
)

// ---------------------------------------------------------------------------
// ② 提案（判据 = user_report）
// ---------------------------------------------------------------------------
const built = buildAgreementProposal({
  agreement: agreementVerdict.ok ? agreementVerdict.value : (undefined as never),
  characterId: CHARACTER_ID,
  span: { start: 0, end: 8 },
  proposalId: 'm10.1-e2e',
  processor: 'm10.1-e2e-verify',
  processorVersion: 'm10.1-e2e-verify@1',
  now: T0,
  criterion: { kind: 'user_report' },
})
record(
  'E2',
  '【② 提案】构造器产出草案：`user_report` 判据**可表达**（裁定 (U-03-a)），且带承诺',
  built.ok === true && built.draft.commitment?.criterion.kind === 'user_report',
  built.ok ? `判据=${built.draft.commitment?.criterion.kind} · origin=${built.draft.origin}` : `拒绝=${built.reason}`
)

// ---------------------------------------------------------------------------
// ③ 放行口（同提案 create+commit）
// ---------------------------------------------------------------------------
const base: DraftToProgramInput = {
  characterId: CHARACTER_ID,
  sourceEventId: SOURCE_EVENT,
  proposalId: 'm10.1-e2e',
  processor: 'm10.1-e2e-verify',
  processorVersion: 'm10.1-e2e-verify@1',
  candidates: [],
  sourceText: '明天十点二十五，楼下。',
  now: T0,
}
const mapped = built.ok ? draftToProgramProposal(built.draft, base) : undefined
const deps: GoalValidatorDeps = {
  registry: createFullDomainEventRegistry(),
  processed: { hasProcessed: async (): Promise<boolean> => false },
  state: {
    getGoal: async (): Promise<undefined> => undefined,
    listGoals: async (): Promise<never[]> => [],
  },
  policy: { characterId: CHARACTER_ID, activeUserId: ACTIVE_USER },
}
const outcome =
  mapped?.proposal === undefined ? undefined : await validateGoalProposal(deps, mapped.proposal)
record(
  'E3',
  '【③ 放行口】真放行口接受同提案 create+commit ⇒ 两个事件同批',
  outcome?.accepted === true &&
    outcome.acceptedEvents.length === 2 &&
    outcome.acceptedEvents.map((event) => String(event.type)).sort().join(',') ===
      'COMMITMENT_ACCEPTED,GOAL_CREATED',
  `accepted=${String(outcome?.accepted)} · 事件=${JSON.stringify(outcome?.acceptedEvents.map((event) => String(event.type)))} · 拒绝=${JSON.stringify(outcome?.rejected.map((row) => `${row.type}:${row.code}`))}`
)

// ---------------------------------------------------------------------------
// ④ 折叠
// ---------------------------------------------------------------------------
const asDomainEvent = (event: { type: unknown; payload: unknown }, createdAt: number): DomainEvent =>
  ({
    id: `evt:${String(event.type)}:${String(createdAt)}` as never,
    type: String(event.type),
    characterId: CHARACTER_ID as never,
    payload: event.payload,
    createdAt,
  }) as unknown as DomainEvent

let row: GoalRowState | undefined
if (outcome?.accepted === true) {
  for (const [index, event] of outcome.acceptedEvents.entries()) {
    row = reduceGoalRow(row, asDomainEvent(event, T0 + index))
  }
}
const factRows = row === undefined ? [] : commitmentFactRowsOf([row])
record(
  'E4',
  '【④ 折叠】真 reducer 折叠出**一行**（目标 + **未结清**承诺），事实行映射出 1 行',
  row !== undefined && row.commitment?.status === 'active' && factRows.length === 1,
  `commitment.status=${String(row?.commitment?.status)} · 事实行=${String(factRows.length)}`
)

// ---------------------------------------------------------------------------
// ⑤ 未结清 ⇒ 可以正常提（**不**误伤）
// ---------------------------------------------------------------------------
const pendingBlock = renderCommitmentStateBlock({ rows: factRows, maxTokens: 400, quantify })[0]
const pendingText = pendingBlock?.content ?? ''
record(
  'E5',
  '【⑤ 未结清】块里是「未结清的约定」· **没有**"不要再提"（她可以正常提）',
  pendingText.includes('未结清的约定') && !pendingText.includes(COMMITMENT_DO_NOT_RAISE),
  `含"未结清"=${String(pendingText.includes('未结清的约定'))} · 含"不要再提"=${String(pendingText.includes(COMMITMENT_DO_NOT_RAISE))}`
)

// ---------------------------------------------------------------------------
// ⑥ ⭐ 真的过 provider（块真的进 packet；额度 0 ⇒ 0 个）
// ---------------------------------------------------------------------------
const providerInput = { characterId: CHARACTER_ID as never, currentInput: '嗯', now: T0 }
const injectedSections = await createCommitmentStateProvider({
  rows: async () => factRows,
  maxTokens: 300,
  quantify,
}).provide(providerInput)
const offSections = await createCommitmentStateProvider({
  rows: async () => factRows,
  maxTokens: 0,
  quantify,
}).provide(providerInput)
record(
  'E6',
  '【⑥ ⭐ 真的过 provider】额度 300 ⇒ **1** 个 section 且 id = `commitment-state`（块真的进 packet）；额度 **0** ⇒ **0** 个（关闭档与基线逐字相同）',
  injectedSections.length === 1 &&
    injectedSections[0]?.id === COMMITMENT_SECTION_ID &&
    offSections.length === 0,
  `注入=${String(injectedSections.length)}（id=${String(injectedSections[0]?.id)}）· 关闭=${String(offSections.length)}`
)

// ---------------------------------------------------------------------------
// ⑦ ⭐ 结清（fulfilled）
// ---------------------------------------------------------------------------
const commitmentId = String(row?.commitment?.commitmentId ?? '')
const fulfilledEvent = asDomainEvent(
  {
    type: 'COMMITMENT_FULFILLED',
    payload: {
      characterId: CHARACTER_ID,
      commitmentId,
      goalId: String(row?.goal.goalId ?? ''),
      expectedRevision: row?.commitment?.revision ?? 1,
      resultRefs: [{ conversationEventId: SOURCE_EVENT, fingerprint: 'fp:arrived' }],
      basis: 'user_report',
    },
  },
  T0 + 10
)
const fulfilledRow = row === undefined ? undefined : reduceGoalRow(row, fulfilledEvent)
const fulfilledRows = fulfilledRow === undefined ? [] : commitmentFactRowsOf([fulfilledRow])
const closedBlock = renderCommitmentStateBlock({ rows: fulfilledRows, maxTokens: 400, quantify })[0]
const closedText = closedBlock?.content ?? ''
record(
  'E7',
  '【⑦ ⭐ 结清（fulfilled）】真 reducer ⇒ `fulfilled`；块里出现「已结清，**不要再提**」',
  fulfilledRow?.commitment?.status === 'fulfilled' &&
    closedText.includes('已结清') &&
    closedText.includes(COMMITMENT_DO_NOT_RAISE),
  `status=${String(fulfilledRow?.commitment?.status)} · 含"不要再提"=${String(closedText.includes(COMMITMENT_DO_NOT_RAISE))}`
)

// ---------------------------------------------------------------------------
// ⑧ ⭐ 到期（expired）
// ---------------------------------------------------------------------------
const DUE_AT = T0 + 3_600_000
const overdueRow: GoalRowState = {
  ...(row as GoalRowState),
  goal: { ...(row as GoalRowState).goal, time: { recordedAt: T0, dueAt: DUE_AT } },
}
const planned = planCommitmentExpiries({
  characterId: CHARACTER_ID,
  rows: [overdueRow],
  now: DUE_AT + 60_000,
})
const expiryProposal =
  planned[0] === undefined
    ? undefined
    : (() => {
        const depsWithRow: GoalValidatorDeps = {
          ...deps,
          state: {
            getGoal: async () => overdueRow,
            listGoals: async (): Promise<never[]> => [overdueRow] as never,
          },
        }
        return depsWithRow
      })()
const expiryOutcome =
  planned[0] === undefined || expiryProposal === undefined
    ? undefined
    : await validateGoalProposal(expiryProposal, {
        proposalId: 'm10.1-e2e-expiry' as never,
        characterId: CHARACTER_ID as never,
        proposalType: 'goal-operation',
        sourceConversationEventIds: [...planned[0].sourceEventIds] as never,
        payload: { operation: 'create' },
        targetEvents: [planned[0].target],
        processor: 'm10.1-e2e-verify',
        processorVersion: 'm10.1-e2e-verify@1',
        status: 'created',
        createdAt: 0,
        sourceQualifications: planned[0].sourceEventIds.map((id) => ({
          eventId: id,
          qualification: 'ESTABLISHED' as const,
        })),
      })
const expiredRow =
  expiryOutcome?.accepted === true && expiryOutcome.acceptedEvents[0] !== undefined
    ? reduceGoalRow(overdueRow, asDomainEvent(expiryOutcome.acceptedEvents[0], DUE_AT + 60_000))
    : undefined
const expiredText =
  renderCommitmentStateBlock({
    rows: expiredRow === undefined ? [] : commitmentFactRowsOf([expiredRow]),
    maxTokens: 400,
    quantify,
  })[0]?.content ?? ''
const accusationWords = ['失约', '违约', '没做到', '没履行', '不守约', '失信']
record(
  'E8',
  '【⑧ ⭐ 到期（expired）】规划器 + 真放行口 + 真 reducer ⇒ `expired`；块里「已过期（**时间到了**），不要再提」，**不含指控词**',
  expiredRow?.commitment?.status === 'expired' &&
    expiredText.includes('已过期') &&
    expiredText.includes(COMMITMENT_DO_NOT_RAISE) &&
    accusationWords.every((word) => !expiredText.includes(word)),
  `status=${String(expiredRow?.commitment?.status)} · 含"已过期"=${String(expiredText.includes('已过期'))} · 指控词命中=${JSON.stringify(accusationWords.filter((word) => expiredText.includes(word)))}`
)

// ---------------------------------------------------------------------------
// ⑨ R-26 的**机制级**对照（两条读数分列）
// ---------------------------------------------------------------------------
const beforeCount = (pendingText.match(new RegExp(COMMITMENT_DO_NOT_RAISE, 'g')) ?? []).length
const afterCount = (closedText.match(new RegExp(COMMITMENT_DO_NOT_RAISE, 'g')) ?? []).length
record(
  'E9',
  '【⑨ R-26 机制级对照】结清**前**"不要再提"行数 = **0**；**后** = **1**（两条读数**分列**）',
  beforeCount === 0 && afterCount === 1,
  `前=${String(beforeCount)} · 后=${String(afterCount)}（⚠️ **行为级**读数 = NOT RUN，需真实模型）`
)

// ---------------------------------------------------------------------------
// ⑩ 确定性 + 非零分母
// ---------------------------------------------------------------------------
const twice = renderCommitmentStateBlock({ rows: factRows, maxTokens: 400, quantify })[0]
record(
  'E10',
  '【⑩ 确定性】同一输入两次 ⇒ 逐字段相同',
  JSON.stringify([pendingBlock]) === JSON.stringify([twice]),
  `两次相同=${String(JSON.stringify([pendingBlock]) === JSON.stringify([twice]))}`
)
const denominators = {
  acceptedEvents: outcome?.acceptedEvents.length ?? 0,
  factRows: factRows.length,
  injectedSections: injectedSections.length,
  closureReadings: beforeCount + afterCount,
}
record(
  'E11',
  '【非零分母】四类计数全部 > 0（`0 检查 / 0 不一致` 不算 PASS）',
  Object.values(denominators).every((value) => value > 0),
  JSON.stringify(denominators)
)

/*
 * ---------------------------------------------------------------------------
 * E12/E13 ⭐ **"她提出"那条路**（`L-M10.1-04` 的修复）：
 *   提议侧引用需要**那条提议原话的指纹** —— 由调用方以 `proposalEvidence` 提供，
 *   且**id 必须与草案相符**（窄规则）；不给/不相符 ⇒ 仍按 D28 拒（**失败关闭**）。
 * ---------------------------------------------------------------------------
 */
const herBuilt = buildAgreementProposal({
  agreement: {
    content: '明天十点二十五在楼下见',
    criterion: '他到楼下（由他报告）',
    proposedByEventId: 'cev:char:propose',
    proposedBy: 'character',
    acceptedByEventId: SOURCE_EVENT,
    acceptedBy: 'user',
  },
  characterId: CHARACTER_ID,
  span: { start: 0, end: 8 },
  proposalId: 'm10.1-e2e-her',
  processor: 'm10.1-e2e-verify',
  processorVersion: 'm10.1-e2e-verify@1',
  now: T0,
  criterion: { kind: 'user_report' },
})
const herMapped =
  herBuilt.ok === true
    ? draftToProgramProposal(herBuilt.draft, {
        ...base,
        proposalId: 'm10.1-e2e-her',
        proposalEvidence: { eventId: 'cev:char:propose', text: '明天十点二十五，楼下。' },
      })
    : undefined
const herOutcome =
  herMapped?.proposal === undefined ? undefined : await validateGoalProposal(deps, herMapped.proposal)
record(
  'E12',
  '【⭐ "她提出"那条路（`L-M10.1-04` 的修复）】给出**提议侧证据**（id 与草案相符）⇒ 放行口**接受**：两组带 `span` 的引用齐备（D28 满足）',
  herOutcome?.accepted === true &&
    herOutcome.acceptedEvents.length === 2 &&
    herBuilt.ok === true &&
    herBuilt.draft.origin === 'character_proposed',
  `accepted=${String(herOutcome?.accepted)} · 事件=${String(herOutcome?.acceptedEvents.length)} · origin=${String(herBuilt.ok ? herBuilt.draft.origin : herBuilt.reason)} · 拒绝=${JSON.stringify(herOutcome?.rejected.map((row) => String(row.code)))}`
)

const herNoEvidenceMapped =
  herBuilt.ok === true
    ? draftToProgramProposal(herBuilt.draft, { ...base, proposalId: 'm10.1-e2e-her2' })
    : undefined
const herNoEvidenceOutcome =
  herNoEvidenceMapped?.proposal === undefined
    ? undefined
    : await validateGoalProposal(deps, herNoEvidenceMapped.proposal)
const herNoEvidenceCodes = (herNoEvidenceOutcome?.rejected ?? []).map((row) => String(row.code))
record(
  'E13',
  '【负控】**不给**提议侧证据 ⇒ 仍被 D28 拒（`goal_proposal_ambiguous_target`）—— 修复**没有**放宽判据，只是把证据接上了',
  herNoEvidenceOutcome?.accepted === false && herNoEvidenceCodes.includes('goal_proposal_ambiguous_target'),
  `accepted=${String(herNoEvidenceOutcome?.accepted)} · 理由=${JSON.stringify(herNoEvidenceCodes)}`
)

const failed = checks.filter((check) => !check.pass)
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
const runId = createM11RunId({ wpId: 'm10-1-wp5-e2e', headShort: head })
const dir = openM11RunDir(REPO_ROOT, runId, 'artifacts/m10.1')
const payload = {
  schema: 'm10.1-e2e-verify@1',
  manifestVersion: M11_MANIFEST_VERSION,
  runId,
  head,
  closureReadings: { doNotRaiseBeforeClosure: beforeCount, doNotRaiseAfterClosure: afterCount },
  denominators,
  checks,
  summary: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
  verdict: failed.length === 0 ? 'PASS' : 'FAIL',
  notRun: [
    {
      id: 'behavioral-comparison',
      why: 'R-26 的**行为级**对照（结清后她是否真的不再提）需要**真实模型**跑对话轮次；本门是离线的，只证明**机制**（块里出现"不要再提"）。',
      howToRun: '按 WP6 的 live 车道：真实模型 + 两个档（A：结清前/无块；B：结清后/有块），数 N 轮里的提及次数，两条读数分列。',
    },
  ],
  disclaimer:
    '本门把整条链（约定 → 提案 → 放行口 → 折叠 → 块 → provider 注入 → 结清/到期）**离线**串起来跑通。' +
    '它**不**主张生产已激活（要配 `CHARACTER_COMMITMENT_TOKENS` 非 0，属独立裁定），' +
    '也**不**主张"她不再重复提"（那是**行为级**读数，NOT RUN）。',
}
writeFileSync(join(dir, 'e2e-verify.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
writeM11Manifest(dir, {
  runId,
  wp: 'm10-1-wp5-e2e',
  head,
  headShort: head.slice(0, 12),
  branch: 'codex/m11-execution-plan',
  date: new Date().toISOString().slice(0, 10),
  toolVersions: { node: process.version },
  testType: 'e2e-verify',
  counts: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
  phases: ['offline'],
  supersedes: null,
  notes: 'm10.1:e2e:verify（约定→承诺→块→注入→结清/到期；行为级对照 NOT RUN）',
})

console.log(`runId: ${runId}`)
console.log(`verdict: ${failed.length === 0 ? 'PASS' : 'FAIL'}（${String(checks.length - failed.length)}/${String(checks.length)}）`)
process.exit(failed.length === 0 ? 0 : 1)
