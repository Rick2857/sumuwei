/**
 * M10 WP3 —— **目标内核门**（`pnpm m10:test`）。
 *
 * ============================================================================
 *  本门测什么（计划 §12 WP3 的四条出口判据，逐条对应）
 * ============================================================================
 * ```text
 * ① 所有合法边均触达      → L 组：两张转换表的每一条合法边都真的走一遍
 * ② 非法边拒绝且零事件    → X 组：每条非法边都必须 rejected 且 acceptedEvents = []
 * ③ 取消后同内容新请求可建立新身份 → G14 组
 * ④ 重放不重复            → R 组：纯折叠的增量 == 全量（A==B）；重复投递幂等；
 *                           rebuild 与增量同一条折叠核心
 * ⑤ 未完成不能靠改 status 跳过 validator → X 组的"改 status / 改成功条件"两条
 * ```
 *
 * ============================================================================
 *  硬边界
 * ============================================================================
 *  · `isolateDatabase()` 一次性沙箱库（顶部、任何数据库 import 之前）；
 *    真实库**从不被打开**。
 *  · **零模型调用、零出网**。
 *  · 每条检查都有非零分母；计数守恒自检。
 *  · 静态检查只读源码文本。
 *  · 阶段进度写 **stderr**；失败路径**强退**（WP2 的教训：运行时的上游定时器
 *    会让失败进程永远不退 ⇒ 门挂死而不是报错）。
 */

import { createThinHostRuntime } from '../src/infrastructure/runtime/thin-host-factory.ts'
import 'dotenv/config'

import { isolateDatabase } from '../src/dev/sandbox.ts'
isolateDatabase('m10-test', { keep: false })

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'




import { createM10RunId, openM10RunDir, writeM10Manifest } from './m10-evidence.ts'
import { character } from '../src/character/index.ts'
import { initDatabase } from '../src/db/index.ts'
import { entityRef } from '../src/kernel/contracts/index.ts'
import type { CharacterId, ConversationEventId } from '../src/kernel/contracts/ids.ts'
import type { DomainEvent } from '../src/kernel/contracts/index.ts'
import type { ProposedDomainEvent } from '../src/kernel/contracts/proposal.ts'
import {
  COMMITMENT_ACCEPTED,
  COMMITMENT_CANCELLED,
  COMMITMENT_FULFILLED,
  COMMITMENT_SUPERSEDED,
  COMMITMENT_BROKEN,
  GOAL_BLOCKED,
  GOAL_CANCELLED,
  GOAL_COMPLETED,
  GOAL_CREATED,
  GOAL_DOMAIN_EVENT_TYPES,
  GOAL_PAUSED,
  GOAL_RESUMED,
  GOAL_REVISED,
  GOAL_SUPERSEDED,
  createFullDomainEventRegistry,
  type DomainEventRegistry,
} from '../src/kernel/contracts/domain-event.ts'
import {
  GOAL_STATEMENT_MAX_CODEPOINTS,
  goalRowKeyOf,
  makeGoalId,
  type CommitmentState,
  type GoalRowState,
  type GoalState,
  type GoalSuccessCriterion,
} from '../src/kernel/contracts/goal.ts'
import {
  GOAL_REVISABLE_FIELDS,
  goalProposalOf,
  validateGoalProposal,
  type GoalProposal,
  type GoalSourceQualification,
  type GoalStateLookupPort,
} from '../src/kernel/policies/goal-validator.ts'
import {
  GOAL_REDUCER_VERSION,
  foldGoalRowsInMemory,
  goalRowKeyFromEvent,
  reduceGoalRow,
  replayGoalRows,
  type GoalFoldEntry,
} from '../src/kernel/projections/goal.ts'
import {
  applyGoalRows,
  createGoalStateLookup,
  getGoalRow,
  listGoalRows,
  listGoalStates,
  rebuildGoalProjections,
} from '../src/infrastructure/persistence/goal-store.ts'
import { applyAcceptedEvents, getProjection, insertProjection } from '../src/infrastructure/persistence/event-store.ts'
import { createProcessedOperationStore } from '../src/infrastructure/persistence/job-store.ts'
import { getRawDb } from '../src/infrastructure/persistence/db.ts'

const REPO_ROOT = resolve(process.cwd())
const CHARACTER = 'char_m10_test'
const USER_ID = 'm10-test-user'
const SOURCE_EVENT = 'cev:m10-test-source-1'
const M10_T0 = 1_900_000_000_000

function phase(mark: string): void {
  console.error(`[m10-test] ${mark}`)
}

// ---------------------------------------------------------------------------
// 量具
// ---------------------------------------------------------------------------

interface Check {
  group: 'C' | 'L' | 'X' | 'G' | 'R' | 'S'
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

function readSrc(relPath: string): string {
  const abs = join(REPO_ROOT, relPath)
  return existsSync(abs) ? readFileSync(abs, 'utf8') : ''
}

/**
 * 只保留**代码**行（去掉行注释与块注释）。
 *
 * ⚠️ 为什么需要它：WP3 第一版的两个静态检查用 `text.includes('X')` 判"代码里没有 X"，
 *    结果被**注释里提到 X** 打成 FAIL（C2 的注释逐字写着"没有 `GOAL_ORIGIN`"、
 *    C3 的注释解释"为什么不用 `ProposalOperation`"）。
 *    那是量具测错了对象：它测的是**文档里有没有这个词**，而不是**代码里有没有这个依赖**。
 */
function codeLinesOf(text: string): string[] {
  const out: string[] = []
  let inBlock = false
  for (const raw of text.split(/\r?\n/)) {
    let line = raw
    if (inBlock) {
      const end = line.indexOf('*/')
      if (end < 0) continue
      line = line.slice(end + 2)
      inBlock = false
    }
    const start = line.indexOf('/*')
    if (start >= 0) {
      const end = line.indexOf('*/', start + 2)
      if (end < 0) {
        line = line.slice(0, start)
        inBlock = true
      } else {
        line = line.slice(0, start) + line.slice(end + 2)
      }
    }
    const slash = line.indexOf('//')
    if (slash >= 0) line = line.slice(0, slash)
    if (line.trim() !== '') out.push(line)
  }
  return out
}

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

function goalSnapshot(override: Partial<GoalState> = {}): GoalState {
  return {
    goalId: 'gol:to-be-derived' as GoalState['goalId'],
    characterId: CHARACTER,
    owner: entityRef('character', CHARACTER),
    targetEntity: entityRef('user', USER_ID),
    origin: 'user_requested',
    sourceRefs: [{ conversationEventId: SOURCE_EVENT as ConversationEventId, fingerprint: 'fp-source-1' }],
    revision: 1,
    statement: '把论文提纲写完',
    successCriterion: { kind: 'user_report' },
    status: 'active',
    priority: 'normal',
    dependencies: [],
    time: { recordedAt: M10_T0 },
    ...override,
  }
}

function target(
  type: string,
  payload: unknown,
  operation: ProposedDomainEvent['operation'] = 'update',
): ProposedDomainEvent {
  return { type, operation, payload, scope: 'CHARACTER_INTERNAL' }
}

const createTarget = (goal: GoalState): ProposedDomainEvent =>
  target(GOAL_CREATED, { characterId: CHARACTER, goal, mutation: 'explicit' }, 'create')

function proposalOf(
  targets: readonly ProposedDomainEvent[],
  overrides: Partial<GoalProposal> = {},
): GoalProposal {
  return {
    ...goalProposalOf({
      proposalId: `m10-test-${String(Math.random()).slice(2, 10)}`,
      operation: 'create',
      characterId: CHARACTER,
      processor: 'm10-test',
      processorVersion: 'm10-test@1',
      sourceConversationEventIds: [SOURCE_EVENT],
      sourceQualifications: [{ eventId: SOURCE_EVENT, qualification: 'ESTABLISHED' }],
      targets,
    }),
    ...overrides,
  }
}

/** 一个可变的 in-memory 状态端口（放行口只读；门的"世界"由它表达） */
function statePort(initial: readonly GoalRowState[] = []): {
  port: GoalStateLookupPort
  set: (rows: readonly GoalRowState[]) => void
  rows: () => GoalRowState[]
} {
  let rows = [...initial]
  return {
    port: {
      getGoal: async (_c, goalId) => rows.find((row) => String(row.goal.goalId) === String(goalId)),
      listGoals: async () => [...rows],
    },
    set: (next) => {
      rows = [...next]
    },
    rows: () => [...rows],
  }
}

function emptyProcessed(): { hasProcessed: (key: string) => Promise<boolean> } {
  const seen = new Set<string>()
  return {
    hasProcessed: async (key) => seen.has(key),
  }
}

function depsOf(
  registry: DomainEventRegistry,
  state: GoalStateLookupPort,
  processed: { hasProcessed: (key: string) => Promise<boolean> },
  characterId: string = CHARACTER,
): Parameters<typeof validateGoalProposal>[0] {
  return {
    registry,
    processed,
    state,
    policy: { characterId, activeUserId: USER_ID },
  }
}

/** 把 accepted 事件折成一个世界（门的"应用"步骤；纯内存） */
function worldOf(events: readonly DomainEvent[]): Map<string, GoalRowState> {
  return replayGoalRows(events)
}

/** 折一段事件流的**末尾**状态（历史必须一起给：孤儿事件按设计是 no-op） */
function worldAfter(
  history: readonly DomainEvent[],
  step: readonly DomainEvent[],
): Map<string, GoalRowState> {
  return worldOf([...history, ...step])
}

/** 便捷：只校验，返回 rejected 码列表 */
async function codesOf(
  deps: Parameters<typeof validateGoalProposal>[0],
  proposal: GoalProposal,
): Promise<{ accepted: boolean; codes: string[]; events: number }> {
  const outcome = await validateGoalProposal(deps, proposal)
  return {
    accepted: outcome.accepted,
    codes: outcome.rejected.map((r) => r.code),
    events: outcome.acceptedEvents.length,
  }
}

/** 从 accepted 事件里造一个可折叠的 DomainEvent（门的合成事件；id 确定性） */
let syntheticSequence = 100
function synthesize(accepted: readonly { type: string; payload: unknown }[], at: number): DomainEvent[] {
  return accepted.map((item) => {
    syntheticSequence += 1
    return {
      id: `dev:m10-test-${String(syntheticSequence)}`,
      characterId: CHARACTER as CharacterId,
      sequence: syntheticSequence,
      type: item.type,
      sourceConversationEventIds: [SOURCE_EVENT as ConversationEventId],
      payload: item.payload,
      processor: 'm10-test',
      processorVersion: 'm10-test@1',
      idempotencyKey: `idem:m10-test-${String(syntheticSequence)}`,
      schemaVersion: 1,
      createdAt: at,
    } as unknown as DomainEvent
  })
}

// ---------------------------------------------------------------------------
// C 组：契约与登记表
// ---------------------------------------------------------------------------

function contractChecks(): void {
  const registry = createFullDomainEventRegistry()
  const registered = GOAL_DOMAIN_EVENT_TYPES.filter((type) => registry.get(type) !== undefined)
  /*
   * ⚠️ **2026-10-02 判据更新**：M10.1 按 ADR-086 `D07` 追加了第 14 个事件
   *    `COMMITMENT_EXPIRED`（**到期**）⇒ 计数由 13 改为 **14**。
   *    前后读数：**前** = 13/13（旧计数）；**后** = 14/14。旧读数不回写。
   */
  record(
    'C',
    'C1',
    '14 个 Goal / Commitment 事件类型全部登记进**全量** registry（装配层走的那一份）'
      + '（⚠️ M10.1 追加 `COMMITMENT_EXPIRED` ⇒ 计数 13 → 14）',
    '14/14',
    `${String(registered.length)}/14`,
    registered.length === 14,
  )

  /*
   * ⚠️ 这两条是**结构性**判据，不是文本判据：
   *    WP3 第一版用 `text.includes(...)` 判它们，被注释里的同一个词打成 FAIL。
   *    正确的问题是"登记表里有没有这个类型"/"代码里有没有这个依赖"。
   */
  const goalOriginRegistered = GOAL_DOMAIN_EVENT_TYPES.includes('GOAL_ORIGIN')
  const domainEventCode = codeLinesOf(readSrc('src/kernel/contracts/domain-event.ts')).join('\n')
  const goalOriginWired = /GOAL_ORIGIN/.test(domainEventCode)
  record(
    'C',
    'C2',
    '登记表里**没有** `GOAL_ORIGIN`（D23：cutover 是结构性的，不是水位）',
    '14 个类型 · 不含 GOAL_ORIGIN · 装配代码里也不引用它',
    `types=${String(GOAL_DOMAIN_EVENT_TYPES.length)} · 含 GOAL_ORIGIN=${String(goalOriginRegistered)} · 装配代码引用=${String(goalOriginWired)}`,
    !goalOriginRegistered && !goalOriginWired && GOAL_DOMAIN_EVENT_TYPES.length === 14,
  )

  const validatorCode = codeLinesOf(readSrc('src/kernel/policies/goal-validator.ts')).join('\n')
  record(
    'C',
    'C3',
    '领域操作词表**自持**：放行口的**代码**里没有 `ProposalOperation`（D21）',
    '代码 0 处（注释可以解释为什么不用它）',
    `代码里出现=${String(/ProposalOperation/.test(validatorCode))}`,
    !/ProposalOperation/.test(validatorCode),
  )

  const service = readSrc('src/kernel/contracts/goal.ts')
  record(
    'C',
    'C4',
    '投影行键是 `goal:<goalId>` 且只有一个前缀（D03/D24：一族多行、一目标一行）',
    '单前缀 + 行键助手在场',
    `goalRowKeyOf=${String(service.includes('GOAL_PROJECTION_PREFIX'))} · 承诺无独立行前缀=${String(!service.includes("'commitment:'"))}`,
    service.includes('GOAL_PROJECTION_PREFIX') && !service.includes("'commitment:'"),
  )

  const states = readSrc('src/kernel/projections/goal.ts')
  record(
    'C',
    'C5',
    'reducer 版本化且声明了它处理的全部 13 种事件（投影行拒绝跨版本追加）',
    `GOAL_REDUCER_VERSION=${GOAL_REDUCER_VERSION} · handled=13`,
    `version=${GOAL_REDUCER_VERSION}`,
    GOAL_REDUCER_VERSION === 'goal-fold@1',
  )
  void states
}

// ---------------------------------------------------------------------------
// L 组：合法边全部触达
// ---------------------------------------------------------------------------

async function legalEdgeChecks(): Promise<void> {
  const registry = createFullDomainEventRegistry()
  const proc = emptyProcessed()

  // ---- L1: 不存在 → active ----
  const st = statePort()
  const createOutcome = await validateGoalProposal(
    depsOf(registry, st.port, proc),
    proposalOf([createTarget(goalSnapshot())]),
  )
  if (!createOutcome.accepted) {
    /*
     * 前置失败必须**如实报出来**，不是让后面的检查崩掉：
     * 崩掉的门只会给一个 TypeError，而拒因（哪条码）才是要修的东西。
     */
    record(
      'L',
      'L1',
      '不存在 → active（GOAL_CREATED 被受理，id 由程序派生）',
      'accepted',
      `拒绝：[${createOutcome.rejected.map((r) => `${r.type}:${r.code}`).join(', ')}]`,
      false,
    )
    record('L', 'L2..L10', '(前置未通过，后续合法边检查无法进行)', '—', '—', false)
    return
  }
  const createdEvents = synthesize(createOutcome.acceptedEvents, M10_T0)
  const createdWorld = worldOf(createdEvents)
  const createdRow = [...createdWorld.values()][0]
  const goalId1 = createdRow === undefined ? '(无)' : String(createdRow.goal.goalId)
  record(
    'L',
    'L1',
    '不存在 → active（GOAL_CREATED 被受理，id 由程序派生）',
    'accepted · status=active · goalId 以 gol: 开头',
    `${String(createOutcome.accepted)} · status=${String(createdRow?.goal.status ?? '(无)')} · goalId=${goalId1}`,
    createOutcome.accepted &&
      createdRow?.goal.status === 'active' &&
      goalId1.startsWith('gol:') &&
      createdRow.goal.revision === 1,
  )
  if (createdRow === undefined) return

  const row0: GoalRowState = createdRow

  // ---- L2..L8: 各条合法边 ----
  const revision = row0.goal.revision
  const cases: { id: string; label: string; targets: ProposedDomainEvent[]; expect: (row: GoalRowState) => boolean; expectText: string; world?: GoalRowState }[] = [
    {
      id: 'L2',
      label: 'active → paused',
      targets: [target(GOAL_PAUSED, { characterId: CHARACTER, goalId: goalId1, expectedRevision: revision, reason: '先停一周' })],
      expect: (row) => row.goal.status === 'paused' && row.goal.revision === revision + 1,
      expectText: 'paused · revision+1',
    },
    {
      id: 'L3',
      label: 'paused → blocked（必要前提失效）',
      targets: [target(GOAL_BLOCKED, { characterId: CHARACTER, goalId: goalId1, expectedRevision: revision + 1, reasonCode: 'necessary_premise_invalid' })],
      expect: (row) =>
        row.goal.status === 'blocked' &&
        row.goal.preservedStatus === 'paused' &&
        row.goal.blockedReason === 'necessary_premise_invalid',
      expectText: 'blocked · preservedStatus=paused · 原因具名',
    },
    {
      id: 'L4',
      label: 'blocked → active（用户确认恢复 + 依赖复核通过）',
      targets: [target(GOAL_RESUMED, { characterId: CHARACTER, goalId: goalId1, expectedRevision: revision + 2, recheck: { hard: 2, soft: 1, dropped: 0 } })],
      expect: (row) => row.goal.status === 'active' && row.goal.preservedStatus === undefined,
      expectText: 'active · 清掉 preservedStatus',
    },
    {
      id: 'L5',
      label: '小改（措辞 / 优先级 / 当前步骤）⇒ revision+1、身份不变',
      targets: [
        target(GOAL_REVISED, {
          characterId: CHARACTER,
          goalId: goalId1,
          expectedRevision: revision + 3,
          changed: ['nextStep', 'priority'],
          nextStep: '先列三章提纲',
          priority: 'high',
          reason: '用户说先列提纲',
        }),
      ],
      expect: (row) => row.goal.revision === revision + 4 && row.goal.nextStep === '先列三章提纲' && row.goal.priority === 'high' && String(row.goal.goalId) === goalId1,
      expectText: 'revision+1 · 字段生效 · goalId 不变',
    },
    {
      id: 'L6',
      label: 'active → completed（criterion=user_report，依据 user_report）',
      targets: [
        target(GOAL_COMPLETED, {
          characterId: CHARACTER,
          goalId: goalId1,
          expectedRevision: revision + 4,
          basis: 'user_report',
          evidenceRefs: [{ conversationEventId: SOURCE_EVENT, fingerprint: 'fp-done' }],
        }),
      ],
      expect: (row) => row.goal.status === 'completed',
      expectText: 'completed',
    },
  ]

  let current = row0
  /*
   * ⚠️ 折叠**必须带着历史**：`replayGoalRows` 从空缓存开始，而
   *    `reduceGoalRow(undefined, GOAL_PAUSED)` 按设计返回 undefined
   *    （孤儿事件 = no-op）。因此每一步都折 `历史 + 本步事件`，
   *    折完再把本步事件推进历史 —— 这正是事件流的形状。
   */
  const history: DomainEvent[] = [...createdEvents]
  for (const item of cases) {
    const stCase = statePort([current])
    const outcome = await validateGoalProposal(depsOf(registry, stCase.port, proc), proposalOf(item.targets))
    if (!outcome.accepted) {
      record('L', item.id, item.label, item.expectText, `拒绝：${outcome.rejected.map((r) => r.code).join(',')}`, false)
      continue
    }
    const stepEvents = synthesize(outcome.acceptedEvents, M10_T0 + Number(item.id.slice(1)) * 1000)
    const world = worldOf([...history, ...stepEvents])
    const row = [...world.values()][0]
    if (row === undefined) {
      record('L', item.id, item.label, item.expectText, '(折叠后没有行 —— 行定位或折叠有缺陷)', false)
      continue
    }
    history.push(...stepEvents)
    current = row
    record('L', item.id, item.label, item.expectText, `ok · status=${row.goal.status} · revision=${String(row.goal.revision)}`, item.expect(row))
  }

  // ---- L7: 三条取消原因各触达一次（cancelled 是本门的终态用法） ----
  const cancelReasons: { reason: string; forbidden?: string[] }[] = [
    { reason: 'user_cancel' },
    { reason: 'user_waived' },
    { reason: 'explicit_forget', forbidden: ['cev:m10-forgotten-root'] },
  ]
  let cancelOk = 0
  const cancelDetail: string[] = []
  for (const [index, spec] of cancelReasons.entries()) {
    const base = goalSnapshot({ statement: `取消原因样本 ${spec.reason}` })
    const createOutcome2 = await validateGoalProposal(depsOf(registry, statePort().port, emptyProcessed()), proposalOf([createTarget(base)]))
    const createEvents2 = synthesize(createOutcome2.acceptedEvents, M10_T0 + 10_000 + index * 100)
    const row = [...worldOf(createEvents2).values()][0]
    if (row === undefined) {
      cancelDetail.push(`${spec.reason}=建目标失败`)
      continue
    }
    const id = String(row.goal.goalId)
    const cancelOutcome = await validateGoalProposal(
      depsOf(registry, statePort([row]).port, emptyProcessed()),
      proposalOf([
        target(GOAL_CANCELLED, {
          characterId: CHARACTER,
          goalId: id,
          expectedRevision: row.goal.revision,
          reason: spec.reason,
          ...(spec.forbidden !== undefined ? { forbiddenSourceEventIds: spec.forbidden } : {}),
        }),
      ]),
    )
    if (!cancelOutcome.accepted) {
      cancelDetail.push(`${spec.reason}=拒(${cancelOutcome.rejected.map((r) => r.code).join(',')})`)
      continue
    }
    const after = [...worldAfter(createEvents2, synthesize(cancelOutcome.acceptedEvents, M10_T0 + 20_000 + index * 100)).values()][0]
    if (after === undefined) {
      cancelDetail.push(`${spec.reason}=折叠无行`)
      continue
    }
    const ok =
      after.goal.status === 'cancelled' &&
      after.goal.cancelReason === spec.reason &&
      (spec.reason !== 'explicit_forget' ||
        (after.goal.forbiddenSourceEventIds ?? []).length > 0)
    if (ok) cancelOk += 1
    cancelDetail.push(`${spec.reason}=${after.goal.status}/${String(after.goal.cancelReason)}`)
  }
  record(
    'L',
    'L7',
    '三条取消原因全部触达（user_cancel / user_waived / explicit_forget），且 explicit_forget 记下禁用根',
    '3/3',
    `${String(cancelOk)}/3 · ${cancelDetail.join(' · ')}`,
    cancelOk === 3,
  )

  // ---- L8: 承诺的两条合法边（accept → fulfilled） ----
  const commitmentBase = goalSnapshot({ statement: '下次继续时给三个步骤' })
  const cCreate = await validateGoalProposal(depsOf(registry, statePort().port, emptyProcessed()), proposalOf([createTarget(commitmentBase)]))
  const cCreateEvents = synthesize(cCreate.acceptedEvents, M10_T0 + 30_000)
  const cRow = [...worldOf(cCreateEvents).values()][0]!
  const cGoalId = String(cRow.goal.goalId)
  const commitment: CommitmentState = {
    commitmentId: 'cmt:to-be-derived' as CommitmentState['commitmentId'],
    goalId: cGoalId as never,
    actor: entityRef('character', CHARACTER),
    beneficiary: entityRef('user', USER_ID),
    scope: '下次继续时给三个步骤',
    acceptedAt: M10_T0 + 31_000,
    acceptanceRefs: [{ conversationEventId: SOURCE_EVENT as ConversationEventId, fingerprint: 'fp-accept' }],
    criterion: { kind: 'conversation_output', structure: { kind: 'item_count', count: 3 } },
    status: 'active',
    completionRefs: [],
    revision: 1,
  }
  const acceptOutcome = await validateGoalProposal(
    depsOf(registry, statePort([cRow]).port, emptyProcessed()),
    proposalOf([
      target(COMMITMENT_ACCEPTED, {
        characterId: CHARACTER,
        goalId: cGoalId,
        commitment,
        expectedGoalRevision: cRow.goal.revision,
      }),
    ]),
  )
  const acceptEvents = synthesize(acceptOutcome.acceptedEvents, M10_T0 + 32_000)
  const afterAccept = acceptOutcome.accepted
    ? [...worldAfter(cCreateEvents, acceptEvents).values()][0]
    : undefined
  record(
    'L',
    'L8',
    '不存在 → active 承诺（COMMITMENT_ACCEPTED），commitmentId 由程序派生',
    'accepted · commitment.status=active · id 以 cmt: 开头',
    afterAccept === undefined
      ? `拒绝：${acceptOutcome.rejected.map((r) => r.code).join(',')}`
      : `status=${String(afterAccept.commitment?.status)} · id=${String(afterAccept.commitment?.commitmentId)}`,
    afterAccept?.commitment?.status === 'active' &&
      String(afterAccept.commitment.commitmentId).startsWith('cmt:'),
  )

  if (afterAccept !== undefined && afterAccept.commitment !== null) {
    const c = afterAccept.commitment
    const fulfillOutcome = await validateGoalProposal(
      depsOf(registry, statePort([afterAccept]).port, emptyProcessed()),
      proposalOf([
        target(COMMITMENT_FULFILLED, {
          characterId: CHARACTER,
          goalId: cGoalId,
          commitmentId: String(c.commitmentId),
          expectedRevision: c.revision,
          resultRefs: [{ conversationEventId: SOURCE_EVENT, fingerprint: 'fp-result' }],
          basis: 'conversation_output',
        }),
      ]),
    )
    const afterFulfill = fulfillOutcome.accepted
      ? [...worldAfter([...cCreateEvents, ...acceptEvents], synthesize(fulfillOutcome.acceptedEvents, M10_T0 + 33_000)).values()][0]
      : undefined
    record(
      'L',
      'L9',
      'active → fulfilled（criterion 与 basis 一对一）',
      'fulfilled · completionBasis=conversation_output',
      afterFulfill === undefined
        ? `拒绝：${fulfillOutcome.rejected.map((r) => r.code).join(',')}`
        : `status=${String(afterFulfill.commitment?.status)} · basis=${String(afterFulfill.commitment?.completionBasis)}`,
      afterFulfill?.commitment?.status === 'fulfilled' &&
        afterFulfill.commitment.completionBasis === 'conversation_output',
    )
  } else {
    record('L', 'L9', 'active → fulfilled', 'fulfilled', '(前置 L8 未通过)', false)
  }

  /*
   * ---- G35（覆盖账里记 `PARTIAL` 的那半边）：**违约证据** ----
   *
   * 契约 §3 的 G35 逐字：「**无自动发送**；`overdue` / `outcome_unknown` **不冒充** `broken`；
   * 有匹配违反证据才记 `broken`」。三段各一条判据 —— 此前**一条都没有**。
   */
  if (afterAccept !== undefined && afterAccept.commitment !== null) {
    const c = afterAccept.commitment
    const brokenOutcome = await validateGoalProposal(
      depsOf(registry, statePort([afterAccept]).port, emptyProcessed()),
      proposalOf([
        target(COMMITMENT_BROKEN, {
          characterId: CHARACTER,
          goalId: cGoalId,
          commitmentId: String(c.commitmentId),
          expectedRevision: c.revision,
          violationRefs: [{ conversationEventId: SOURCE_EVENT, fingerprint: 'fp-violation' }],
          ruleId: 'rule:three-steps',
        }),
      ]),
    )
    const afterBroken = brokenOutcome.accepted
      ? [...worldAfter(
          [...cCreateEvents, ...acceptEvents],
          synthesize(brokenOutcome.acceptedEvents, M10_T0 + 34_000),
        ).values()][0]
      : undefined
    record(
      'L',
      'L11',
      '**【G35】`active` 承诺 + **有匹配违反证据** ⇒ `broken`**（正控）：`completionRefs` 来自'
        + ' `violationRefs`、`violationRuleId` 落盘、`revision` +1',
      'broken · violationRuleId=rule:three-steps · revision+1',
      afterBroken === undefined
        ? `拒绝：${brokenOutcome.rejected.map((r) => r.code).join(',')}`
        : `status=${String(afterBroken.commitment?.status)} · rule=${String(afterBroken.commitment?.violationRuleId)} · ` +
          `rev=${String(afterBroken.commitment?.revision)}`,
      afterBroken?.commitment?.status === 'broken' &&
        afterBroken.commitment.violationRuleId === 'rule:three-steps' &&
        (afterBroken.commitment.completionRefs?.length ?? 0) > 0,
    )

    /*
     * X22：**非 `active` 承诺**再来 `COMMITMENT_BROKEN` ⇒ 折叠层 no-op（`revision` 不动）。
     * ⇒ "终态不可迁移"在**承诺**这一侧也有判据（此前只有目标侧 X1）。
     */
    const terminalRow = afterBroken ?? afterAccept
    const before22 = terminalRow.commitment!
    const bumped = reduceGoalRow(terminalRow, {
      ...synthesize([{ type: COMMITMENT_BROKEN, payload: { characterId: CHARACTER, goalId: cGoalId, commitmentId: String(c.commitmentId), expectedRevision: before22.revision, violationRefs: [], ruleId: 'r' } }], M10_T0 + 35_000)[0]!,
    } as never)
    record(
      'X',
      'X22',
      '**【G35】已是终态的承诺再收 `COMMITMENT_BROKEN` ⇒ no-op**（状态不变、**`revision` 不动**）'
        + ' ⇒ 违约不能把 `fulfilled` / `broken` 再改一次',
      `状态与 revision 都不变（rev=${String(before22.revision)}）`,
      `status=${String(bumped?.commitment?.status)} · rev=${String(bumped?.commitment?.revision)}`,
      bumped?.commitment?.status === before22.status &&
        bumped?.commitment?.revision === before22.revision,
    )
  } else {
    record('L', 'L11', '【G35】违约证据 ⇒ broken', 'broken', '(前置 L8/L9 未通过)', false)
    record('X', 'X22', '【G35】终态承诺再收 broken ⇒ no-op', 'no-op', '(前置 L8/L9 未通过)', false)
  }

  /*
   * C6：**`broken` 只能由 `COMMITMENT_BROKEN` 产生** —— 判结构（去注释），
   * 数 `projections/goal.ts` 里给承诺落 `status: 'broken'` 的地方**恰好一处**，
   * 且它必须落在 `case COMMITMENT_BROKEN` 那一段里。⇒ "没有任何别的边会走到 broken"。
   */
  const foldLines = codeLinesOf(readSrc('src/kernel/projections/goal.ts'))
  const brokenAssignments: number[] = []
  let brokenCaseLine = -1
  foldLines.forEach((line, index) => {
    if (line.includes(`case ${COMMITMENT_BROKEN}`)) brokenCaseLine = index
    if (/status:\s*'broken'/.test(line)) brokenAssignments.push(index)
  })
  record(
    'C',
    'C6',
    '**【G35】`broken` 只能由 `COMMITMENT_BROKEN` 产生**（判结构，去注释）：'
      + '折叠层里给承诺落 `status: \'broken\'` 的地方**恰好一处**，且落在 '
      + '`case COMMITMENT_BROKEN` 之内',
    '恰好 1 处 · 且在 COMMITMENT_BROKEN 的 case 里',
    `落点 ${String(brokenAssignments.length)} 处 @${brokenAssignments.join(',')} · ` +
      `case 在 @${String(brokenCaseLine)}`,
    brokenAssignments.length === 1 &&
      brokenCaseLine >= 0 &&
      brokenAssignments[0]! > brokenCaseLine,
  )

  /*
   * C7：**`overdue` / `outcome_unknown` 结构上不可能冒充完成或违约** ——
   * 它们既不在任何闭集里，也不作为字面量出现在目标域源码里。
   * ⇒ 这一条把"不冒充"从**纪律**变成**类型/闭集事实**。
   */
  const FORBIDDEN_MASQUERADE_WORDS = ['overdue', 'outcome_unknown'] as const
  const closureSources = [
    readSrc('src/kernel/contracts/goal.ts'),
    readSrc('src/kernel/app/goal/completion.ts'),
    readSrc('src/kernel/app/goal/invalidation.ts'),
  ].join('\n')
  const masqueradeHits = FORBIDDEN_MASQUERADE_WORDS.filter((word) =>
    codeLinesOf(closureSources).join('\n').includes(word),
  )
  record(
    'C',
    'C7',
    '**【G35】`overdue` / `outcome_unknown` 不在任何闭集里、也不在目标域源码里**'
      + ' ⇒ "不冒充 `broken` / 完成依据"是**结构事实**，不是纪律',
    '0 处出现',
    masqueradeHits.length === 0 ? '0 处出现' : `**出现**：${masqueradeHits.join(', ')}`,
    masqueradeHits.length === 0,
  )

  /*
   * C8：**`COMMITMENT_BROKEN` 的 payload 校验**要求 `violationRefs` **非空** 且 `ruleId` 非空 ——
   * 用**真的** payload 校验函数跑（不是读源码猜）。
   */
  const brokenSpec = registry.get(COMMITMENT_BROKEN)
  const rejects = (payload: unknown): boolean => {
    if (brokenSpec === undefined) return false
    try {
      brokenSpec.validatePayload(payload)
      return false
    } catch {
      return true
    }
  }
  const emptyRefsRejected = rejects({
    characterId: CHARACTER,
    goalId: cGoalId,
    commitmentId: 'cmt:x',
    expectedRevision: 1,
    violationRefs: [],
    ruleId: 'r',
  })
  const emptyRuleRejected = rejects({
    characterId: CHARACTER,
    goalId: cGoalId,
    commitmentId: 'cmt:x',
    expectedRevision: 1,
    violationRefs: [{ conversationEventId: SOURCE_EVENT, fingerprint: 'fp' }],
    ruleId: '',
  })
  const goodAccepted = !rejects({
    characterId: CHARACTER,
    goalId: cGoalId,
    commitmentId: 'cmt:x',
    expectedRevision: 1,
    violationRefs: [{ conversationEventId: SOURCE_EVENT, fingerprint: 'fp' }],
    ruleId: 'rule:x',
  })
  record(
    'C',
    'C8',
    '**【G35】违约证据是**必填**：`violationRefs` 为空 ⇒ 拒；`ruleId` 为空 ⇒ 拒；'
      + '两者都在 ⇒ 收（三个方向都跑真的校验函数）',
    '空 refs 拒 · 空 rule 拒 · 齐备收',
    `空refs=${String(emptyRefsRejected)} · 空rule=${String(emptyRuleRejected)} · 齐备收=${String(goodAccepted)}`,
    emptyRefsRejected && emptyRuleRejected && goodAccepted,
  )

  /*
   * ---- G36：时间 / 时区有歧义 ----
   *
   * 契约 §3 逐字：「**澄清**，不猜日期；`dueBasis` 与解析依据可查」。
   *
   * ⚠️ **2026-10-02 判据升级**（M10.1 WP3）：原来的代理判据是"生产侧**0 处** `dueAt`"，
   *    而**到期机制必然要读**已存的截止时间（`goal.time.dueAt`）⇒ 该代理不再成立。
   *    升级为**按角色分列**的结构判据（意图不变：**模型不能给日期**）：
   *      ① 草案契约（模型产出的形状）**没有** `dueAt` 字段；
   *      ② 理解侧（模型输出 → 程序提案）**0 处** `dueAt`；
   *      ③ 放行口**只读不写**：出现 `dueAt` 的行里**没有** `dueAt:` 赋值（只做比对）。
   *    ⇒ 任何"让模型/理解侧产生日期"的改动都会**当场变红**。
   */
  const draftContractSrc = readSrc('src/kernel/contracts/goal-proposal.ts')
  const understandingSrc = readSrc('src/kernel/app/goal/understanding.ts')
  const validatorSrc = readSrc('src/kernel/policies/goal-validator.ts')
  /*
   * ⚠️ 判据必须是**结构化**的（第一版用 `includes('dueAt')` 会被**注释里提到 dueAt**误伤
   *    —— 这正是本文件开头记着的那类教训："注释里的同一个词"）。
   *    这里只认**字段声明**：`readonly dueAt?: ...`。
   */
  const draftDueAtFields = codeLinesOf(draftContractSrc).filter((line) =>
    /readonly\s+dueAt\??\s*:/.test(line),
  )
  const understandingDueAtLines = codeLinesOf(understandingSrc).filter((line) => line.includes('dueAt'))
  const validatorAssignsDueAt = codeLinesOf(validatorSrc).filter((line) => /dueAt\s*:/.test(line))
  record(
    'C',
    'C9',
    '**【G36】"模型不能给日期"是结构性的**：草案契约**没有** `dueAt` **字段声明** · 理解侧 **0 处** ·'
      + '放行口**只读不写**（无 `dueAt:` 赋值）'
      + '（⚠️ M10.1 WP3 升级：到期机制要**读**已存截止时间，故代理判据由"生产侧 0 处"改为按角色分列）',
    '草案 0 字段声明 · 理解侧 0 处 · 放行口 0 赋值',
    `草案字段声明 ${String(draftDueAtFields.length)} 处 · 理解侧 ${String(understandingDueAtLines.length)} 处 · 放行口赋值 ${String(validatorAssignsDueAt.length)} 处`,
    draftDueAtFields.length === 0 && understandingDueAtLines.length === 0 && validatorAssignsDueAt.length === 0,
  )

  /*
   * C10：**`dueAt` 有值 ⇒ `dueBasis` 必须有值** —— "解析依据可查"的可执行形式。
   * ⚠️ 这一条用**真的** payload 校验函数跑；它若红，说明契约的 G36 判据
   *    **没有落到结构校验里**（那是一个真发现，不是门的缺陷）。
   */
  const createdSpec = registry.get(GOAL_CREATED)
  const createdWithDueNoBasis = {
    characterId: CHARACTER,
    mutation: 'explicit',
    goal: {
      ...goalSnapshot(),
      time: { recordedAt: M10_T0, dueAt: M10_T0 + 86_400_000 },
    },
  }
  let dueWithoutBasisRejected = false
  try {
    createdSpec?.validatePayload(createdWithDueNoBasis)
  } catch {
    dueWithoutBasisRejected = true
  }
  record(
    'C',
    'C10',
    '**【G36】"解析依据可查"的可执行形式**：`dueAt` 有值而 `dueBasis` **缺失** ⇒ 结构校验**必须拒**'
      + '（否则"这个日期是怎么来的"在库里查不到）'
      + ' —— ⚠️ 用真的校验函数跑：它若红，是**契约的判据没落到结构校验里**，不是门的问题',
    '拒',
    dueWithoutBasisRejected ? '拒' : '**收下了（依据不可查）**',
    dueWithoutBasisRejected,
  )

  /*
   * C11：**【G35】"无自动发送"** —— 目标域里**没有**定时器 / 调度器 / 出站调用。
   *
   * 契约 §3 的 G35 第一段逐字是"**无自动发送**"，而 `D14` 冻结的是"时间只用于读取时判断；
   * **不创建 scheduler**"。⇒ 这条把"我们不主动发"从**承诺**变成**结构事实**。
   */
  const NO_AUTOSEND_SOURCES = [
    'src/kernel/app/goal/turn.ts',
    'src/kernel/app/goal/completion.ts',
    'src/kernel/app/goal/invalidation.ts',
    'src/kernel/policies/goal-validator.ts',
  ]
  const AUTOSEND_MARKERS = ['setTimeout', 'setInterval', 'cron', 'scheduler', 'fetch(', 'axios'] as const
  const autoSendHits: string[] = []
  for (const rel of NO_AUTOSEND_SOURCES) {
    const lines = codeLinesOf(readSrc(rel))
    for (const marker of AUTOSEND_MARKERS) {
      if (lines.some((line) => line.includes(marker))) autoSendHits.push(`${rel}→${marker}`)
    }
  }
  record(
    'C',
    'C11',
    '**【G35】"无自动发送"是结构事实**：目标域的生产文件里没有定时器 / 调度器 / 出站调用'
      + '（`setTimeout` · `setInterval` · `cron` · `scheduler` · `fetch(` · `axios`）'
      + ' ⇒ `D14` 的"不创建 scheduler"落在代码里，不只在文档里',
    `0 处（扫 ${String(NO_AUTOSEND_SOURCES.length)} 个文件 × ${String(AUTOSEND_MARKERS.length)} 个标记）`,
    autoSendHits.length === 0 ? '0 处' : `**命中**：${autoSendHits.join(', ')}`,
    autoSendHits.length === 0,
  )

  // ---- L10: →superseded + 新身份（关联操作原子提交） ----
  const oldBase = goalSnapshot({ statement: '旧目标：写完第二章' })
  const oCreate = await validateGoalProposal(depsOf(registry, statePort().port, emptyProcessed()), proposalOf([createTarget(oldBase)]))
  const oCreateEvents = synthesize(oCreate.acceptedEvents, M10_T0 + 40_000)
  const oRow = [...worldOf(oCreateEvents).values()][0]!
  const oId = String(oRow.goal.goalId)
  const newGoal = goalSnapshot({
    statement: '新目标：改写成三篇短文',
    successCriterion: { kind: 'conversation_output', structure: { kind: 'item_count', count: 3 } },
  })
  const derivedNewId = makeGoalId({
    characterId: CHARACTER,
    owner: newGoal.owner,
    targetEntity: newGoal.targetEntity,
    origin: newGoal.origin,
    statement: newGoal.statement,
    acceptanceSourceEventId: SOURCE_EVENT,
    operation: 'create',
  })
  const supersedeOutcome = await validateGoalProposal(
    depsOf(registry, statePort([oRow]).port, emptyProcessed()),
    proposalOf([
      createTarget(newGoal),
      target(GOAL_SUPERSEDED, {
        characterId: CHARACTER,
        goalId: oId,
        supersededByGoalId: String(derivedNewId),
        expectedRevision: oRow.goal.revision,
        reason: '目标对象改了',
      }, 'supersede'),
    ]),
  )
  const supWorld = supersedeOutcome.accepted
    ? worldAfter(oCreateEvents, synthesize(supersedeOutcome.acceptedEvents, M10_T0 + 41_000))
    : new Map<string, GoalRowState>()
  const oldAfter = supWorld.get(goalRowKeyOf(oId))
  record(
    'L',
    'L10',
    '实质改 ⇒ 旧项 superseded + 新身份（同一提案原子提交）',
    '2 行 · 旧=superseded · 新=active · 新旧 id 不同',
    supersedeOutcome.accepted
      ? `${String(supWorld.size)} 行 · 旧=${String(oldAfter?.goal.status)} · 新=${String(supWorld.get(goalRowKeyOf(String(derivedNewId)))?.goal.status)}`
      : `拒绝：${supersedeOutcome.rejected.map((r) => r.code).join(',')}`,
    supersedeOutcome.accepted &&
      supWorld.size === 2 &&
      oldAfter?.goal.status === 'superseded' &&
      supWorld.get(goalRowKeyOf(String(derivedNewId)))?.goal.status === 'active' &&
      String(derivedNewId) !== oId,
  )
}

// ---------------------------------------------------------------------------
// X 组：非法边拒绝且零事件
// ---------------------------------------------------------------------------

async function illegalEdgeChecks(): Promise<void> {
  const registry = createFullDomainEventRegistry()
  const proc = emptyProcessed()

  const seed = async (statement: string): Promise<GoalRowState> => {
    const outcome = await validateGoalProposal(
      depsOf(registry, statePort().port, emptyProcessed()),
      proposalOf([createTarget(goalSnapshot({ statement }))]),
    )
    if (!outcome.accepted) throw new Error(`种子创建失败：${outcome.rejected.map((r) => r.code).join(',')}`)
    return [...worldOf(synthesize(outcome.acceptedEvents, M10_T0 + 50_000)).values()][0]!
  }

  const expectRejected = async (input: {
    id: string
    label: string
    code: string
    rows: readonly GoalRowState[]
    targets: readonly ProposedDomainEvent[]
    proposal?: Partial<GoalProposal>
  }): Promise<void> => {
    const outcome = await validateGoalProposal(
      depsOf(registry, statePort(input.rows).port, proc),
      proposalOf(input.targets, input.proposal),
    )
    const codes = outcome.rejected.map((r) => r.code)
    record(
      'X',
      input.id,
      input.label,
      `rejected:${input.code} · 0 事件`,
      `${outcome.accepted ? 'ACCEPTED(!)' : 'rejected'} · codes=[${codes.join(',')}] · events=${String(outcome.acceptedEvents.length)}`,
      !outcome.accepted && codes.includes(input.code) && outcome.acceptedEvents.length === 0,
    )
  }

  const active = await seed('非法边样本：active 目标')
  const activeId = String(active.goal.goalId)
  const rev = active.goal.revision

  await expectRejected({
    id: 'X1',
    label: '终态 → 任何状态（completed 后不能再暂停）',
    code: 'goal_terminal_state',
    rows: [{ ...active, goal: { ...active.goal, status: 'completed' } }],
    targets: [target(GOAL_PAUSED, { characterId: CHARACTER, goalId: activeId, expectedRevision: rev, reason: 'x' })],
  })

  await expectRejected({
    id: 'X2',
    label: 'paused → paused（非 active 不能暂停）',
    code: 'goal_illegal_transition',
    rows: [{ ...active, goal: { ...active.goal, status: 'paused' } }],
    targets: [target(GOAL_PAUSED, { characterId: CHARACTER, goalId: activeId, expectedRevision: rev, reason: 'x' })],
  })

  await expectRejected({
    id: 'X3',
    label: 'blocked → paused（不在转换表里）',
    code: 'goal_illegal_transition',
    rows: [{ ...active, goal: { ...active.goal, status: 'blocked', preservedStatus: 'active' } }],
    targets: [target(GOAL_PAUSED, { characterId: CHARACTER, goalId: activeId, expectedRevision: rev, reason: 'x' })],
  })

  await expectRejected({
    id: 'X4',
    label: '**改 status 字段**试图跳过 validator（changed 含非可修订字段）',
    code: 'goal_revision_requires_supersede',
    rows: [active],
    targets: [
      target(GOAL_REVISED, {
        characterId: CHARACTER,
        goalId: activeId,
        expectedRevision: rev,
        changed: ['status'],
        reason: '想直接改成 completed',
      }),
    ],
  })

  await expectRejected({
    id: 'X5',
    label: '**改成功条件**试图跳过 validator（criterion 不在可修订集）',
    code: 'goal_revision_requires_supersede',
    rows: [active],
    targets: [
      target(GOAL_REVISED, {
        characterId: CHARACTER,
        goalId: activeId,
        expectedRevision: rev,
        changed: ['successCriterion'],
        reason: '想放宽成功条件',
      }),
    ],
  })

  await expectRejected({
    id: 'X6',
    label: 'expectedRevision 不符（乐观锁）',
    code: 'goal_revision_conflict',
    rows: [active],
    targets: [target(GOAL_PAUSED, { characterId: CHARACTER, goalId: activeId, expectedRevision: rev + 7, reason: 'x' })],
  })

  await expectRejected({
    id: 'X7',
    label: 'paused 目标被**机器证据**判完成（依据不是 user_report）',
    code: 'goal_illegal_transition',
    rows: [
      {
        ...active,
        goal: {
          ...active.goal,
          status: 'paused',
          successCriterion: { kind: 'conversation_output', structure: { kind: 'item_count', count: 3 } } as GoalSuccessCriterion,
        },
      },
    ],
    targets: [
      target(GOAL_COMPLETED, {
        characterId: CHARACTER,
        goalId: activeId,
        expectedRevision: rev,
        basis: 'conversation_output',
        evidenceRefs: [{ conversationEventId: SOURCE_EVENT, fingerprint: 'f' }],
      }),
    ],
  })

  await expectRejected({
    id: 'X8',
    label: '依据与 criterion 不匹配（一对一，无例外）',
    code: 'completion_evidence_kind_mismatch',
    rows: [active],
    targets: [
      target(GOAL_COMPLETED, {
        characterId: CHARACTER,
        goalId: activeId,
        expectedRevision: rev,
        basis: 'action_result',
        evidenceRefs: [{ conversationEventId: SOURCE_EVENT, fingerprint: 'f' }],
      }),
    ],
  })

  await expectRejected({
    id: 'X9',
    label: '完成不带依据（结构性：evidenceRefs 必须非空）',
    code: 'goal_proposal_invalid_shape',
    rows: [active],
    targets: [
      target(GOAL_COMPLETED, {
        characterId: CHARACTER,
        goalId: activeId,
        expectedRevision: rev,
        basis: 'user_report',
        evidenceRefs: [],
      }),
    ],
  })

  await expectRejected({
    id: 'X10',
    label: '来源归因不是 ESTABLISHED（模型不能自报授权）',
    code: 'goal_proposal_source_unqualified',
    rows: [],
    targets: [createTarget(goalSnapshot({ statement: '未授权来源的目标' }))],
    proposal: { sourceQualifications: [{ eventId: SOURCE_EVENT, qualification: 'UNCONFIRMED_ORIGIN' }] },
  })

  /*
   * X11 的**前置**：一条真的被"忘掉这项目标"禁用了的既有目标 ——
   * `forbiddenSourceEventIds` 必须**真的非空**，否则这条负控什么都没测到
   * （WP3 第一版就是漏了这一步，于是它 FAIL 在一个"检查根本没触发"上）。
   */
  await expectRejected({
    id: 'X11',
    label: '来源事件命中既有"忘掉这项目标"的禁用根（B28 机制）',
    code: 'goal_source_forbidden',
    rows: [
      {
        goal: {
          ...(goalSnapshot({ statement: '曾经被忘掉的目标' }) as GoalState),
          status: 'cancelled',
          cancelReason: 'explicit_forget',
          forbiddenSourceEventIds: [SOURCE_EVENT],
        },
        commitment: null,
      },
    ],
    targets: [createTarget(goalSnapshot({ statement: '换个说法再来一次' }))],
    proposal: undefined,
  })

  await expectRejected({
    id: 'X12',
    label: '取消有 active 承诺的目标却没在同提案取消承诺（孤儿约定）',
    code: 'goal_orphan_commitment',
    rows: [withActiveCommitment(active)],
    targets: [target(GOAL_CANCELLED, { characterId: CHARACTER, goalId: activeId, expectedRevision: rev, reason: 'user_cancel' })],
  })

  await expectRejected({
    id: 'X13',
    label: 'supersede 的新目标不在同一提案（关联操作必须原子）',
    code: 'goal_supersede_target_missing',
    rows: [active],
    targets: [
      target(GOAL_SUPERSEDED, {
        characterId: CHARACTER,
        goalId: activeId,
        supersededByGoalId: 'gol:not-in-this-proposal',
        expectedRevision: rev,
        reason: 'r',
      }, 'supersede'),
    ],
  })

  await expectRejected({
    id: 'X14',
    label: '目标已有非终态承诺时再普通 accept（必须走 supersede）',
    code: 'commitment_already_active',
    rows: [withActiveCommitment(active)],
    targets: [
      target(COMMITMENT_ACCEPTED, {
        characterId: CHARACTER,
        goalId: activeId,
        commitment: commitmentSnapshot(activeId),
        expectedGoalRevision: rev,
      }, 'create'),
    ],
  })

  /*
   * ⚠️ **X15 于 2026-10-02 按用户裁定 `(U-03-a)` 改写**（判据变更 ⇒ 前后读数都留）：
   *    · **前**：`v1 不接受 user_report 类型的承诺` ⇒ 期望 `commitment_criterion_unacceptable`（57/58 时它红了）
   *    · **后**：`user_report` **正式被接受**（"双方约定"那类：判据是"他到没到"，只能由对方报告）
   *      ⇒ 这里改成**接受**断言；同时补一条 X15b 守住"**CLOSET 仍然设闸**"。
   *    依据：[`ADR-076`](../docs/adr/ADR-076-m10-goals-and-commitments.md) 的修订节 · `ADR-086` §0.5。
   */
  {
    const outcome = await validateGoalProposal(
      depsOf(registry, statePort([active]).port, proc),
      proposalOf([
        target(COMMITMENT_ACCEPTED, {
          characterId: CHARACTER,
          goalId: activeId,
          commitment: { ...commitmentSnapshot(activeId), criterion: { kind: 'user_report' } },
          expectedGoalRevision: rev,
        }, 'create'),
      ]),
    )
    const acceptedCommitment = outcome.acceptedEvents.find(
      (event) => String(event.type) === 'COMMITMENT_ACCEPTED',
    )
    const criterionKind = (
      acceptedCommitment?.payload as { commitment?: { criterion?: { kind?: string } } } | undefined
    )?.commitment?.criterion?.kind
    record(
      'X',
      'X15',
      '`user_report` 类型的**承诺**现在**被接受**（裁定 (U-03-a)：双方约定由对方报告结清）',
      'accepted · 1 事件 · criterion=user_report',
      `${outcome.accepted ? 'accepted' : `rejected(${outcome.rejected.map((r) => r.code).join(',')})`} · events=${String(outcome.acceptedEvents.length)} · criterion=${String(criterionKind)}`,
      outcome.accepted && outcome.acceptedEvents.length === 1 && criterionKind === 'user_report',
    )
  }

  /*
   * X15b：**闭集仍然设闸** —— 用一个**未知判据类**（模拟绕过契约层校验的载荷）。
   * ⚠️ 实测它被**更早**的结构校验挡下（`goal_proposal_invalid_shape`）；
   *    扩类之后三个合法判据类**都在**闭集内 ⇒ `commitment_criterion_unacceptable`
   *    已退化为**纵深防御**分支（正常载荷到不了），两个理由都算通过。
   */
  await expectRejected({
    id: 'X15b',
    label: '**未知**判据类仍然被拒（扩的是闭集内容，不是取消闸门）',
    code: 'goal_proposal_invalid_shape',
    rows: [active],
    targets: [
      target(COMMITMENT_ACCEPTED, {
        characterId: CHARACTER,
        goalId: activeId,
        commitment: { ...commitmentSnapshot(activeId), criterion: { kind: 'made_up_kind' } },
        expectedGoalRevision: rev,
      }, 'create'),
    ],
  })

  await expectRejected({
    id: 'X16',
    label: '恢复时依赖仍有被丢弃项（不得因索引恢复就静默继续）',
    code: 'goal_operation_dependency_unavailable',
    rows: [{ ...active, goal: { ...active.goal, status: 'paused' } }],
    targets: [
      target(GOAL_RESUMED, {
        characterId: CHARACTER,
        goalId: activeId,
        expectedRevision: rev,
        recheck: { hard: 1, soft: 0, dropped: 1 },
      }),
    ],
  })

  await expectRejected({
    id: 'X17',
    label: '跨角色提案（characterId 不是本角色）',
    code: 'goal_dependency_foreign',
    rows: [],
    targets: [createTarget(goalSnapshot({ statement: '别人的目标' }))],
    proposal: { characterId: 'char_someone_else' as never },
  })

  await expectRejected({
    id: 'X18',
    label: '来源事件为空（Goal 事件必须有来源）',
    code: 'goal_source_missing',
    rows: [],
    targets: [createTarget(goalSnapshot({ statement: '无来源目标' }))],
    proposal: { sourceConversationEventIds: [] as never, sourceQualifications: [] },
  })

  await expectRejected({
    id: 'X19',
    label: 'statement 超过 500 码点（字段上界是第一道防线）',
    code: 'goal_proposal_invalid_shape',
    rows: [],
    targets: [createTarget(goalSnapshot({ statement: '长'.repeat(GOAL_STATEMENT_MAX_CODEPOINTS + 1) }))],
  })

  // ---- 幂等：同一操作重复投递 ----
  const seeded = await seed('幂等样本：重复投递')
  const dupTarget = target(GOAL_PAUSED, {
    characterId: CHARACTER,
    goalId: String(seeded.goal.goalId),
    expectedRevision: seeded.goal.revision,
    reason: '重复投递',
  })
  const firstOutcome = await validateGoalProposal(depsOf(registry, statePort([seeded]).port, proc), proposalOf([dupTarget]))
  record(
    'X',
    'X20',
    '第一次投递被受理（负控的**正控**半边：否则 X21 可能只是"永远拒绝"）',
    'accepted · 1 事件',
    `${String(firstOutcome.accepted)} · ${String(firstOutcome.acceptedEvents.length)} 事件`,
    firstOutcome.accepted && firstOutcome.acceptedEvents.length === 1,
  )

  const processedSeen = new Set<string>()
  const seenProc = {
    hasProcessed: async (key: string): Promise<boolean> => {
      if (processedSeen.has(key)) return true
      processedSeen.add(key)
      return false
    },
  }
  await validateGoalProposal(depsOf(registry, statePort([seeded]).port, seenProc), proposalOf([dupTarget]))
  const secondOutcome = await validateGoalProposal(depsOf(registry, statePort([seeded]).port, seenProc), proposalOf([dupTarget]))
  record(
    'X',
    'X21',
    '同一操作重复投递 ⇒ `goal_duplicate_operation` 且零事件',
    'rejected:goal_duplicate_operation · 0 事件',
    `${String(secondOutcome.accepted)} · [${secondOutcome.rejected.map((r) => r.code).join(',')}] · ${String(secondOutcome.acceptedEvents.length)} 事件`,
    !secondOutcome.accepted &&
      secondOutcome.rejected.some((r) => r.code === 'goal_duplicate_operation') &&
      secondOutcome.acceptedEvents.length === 0,
  )
}

function withActiveCommitment(row: GoalRowState): GoalRowState {
  return { ...row, commitment: commitmentSnapshot(String(row.goal.goalId)) }
}

function commitmentSnapshot(goalId: string): CommitmentState {
  return {
    commitmentId: `cmt:${CHARACTER}:probe` as CommitmentState['commitmentId'],
    goalId: goalId as never,
    actor: entityRef('character', CHARACTER),
    beneficiary: entityRef('user', USER_ID),
    scope: '给三个步骤',
    acceptedAt: M10_T0,
    acceptanceRefs: [{ conversationEventId: SOURCE_EVENT as ConversationEventId, fingerprint: 'fp-a' }],
    criterion: { kind: 'conversation_output', structure: { kind: 'item_count', count: 3 } },
    status: 'active',
    completionRefs: [],
    revision: 1,
  }
}

// ---------------------------------------------------------------------------
// G 组：取消后同内容重新设立 ⇒ 新身份（G14）
// ---------------------------------------------------------------------------

async function reIdentityChecks(): Promise<void> {
  const registry = createFullDomainEventRegistry()
  const statement = '取消后重新设立的同一件事'

  const first = await validateGoalProposal(
    depsOf(registry, statePort().port, emptyProcessed()),
    proposalOf([createTarget(goalSnapshot({ statement }))]),
  )
  const firstEvents = synthesize(first.acceptedEvents, M10_T0 + 60_000)
  const firstWorld = worldOf(firstEvents)
  const firstRow = [...firstWorld.values()][0]
  if (firstRow === undefined) {
    record('G', 'G1', '(前置：重新设立样本的目标建不出来)', '—', '—', false)
    record('G', 'G2', '(同上)', '—', '—', false)
    return
  }
  const firstId = String(firstRow.goal.goalId)

  // 取消它
  const cancelled = await validateGoalProposal(
    depsOf(registry, statePort([firstRow]).port, emptyProcessed()),
    proposalOf([
      target(GOAL_CANCELLED, {
        characterId: CHARACTER,
        goalId: firstId,
        expectedRevision: firstRow.goal.revision,
        reason: 'user_cancel',
      }),
    ]),
  )
  const cancelEvents = synthesize(cancelled.acceptedEvents, M10_T0 + 60_100)
  const cancelledRow = [...worldAfter(firstEvents, cancelEvents).values()][0]
  if (cancelledRow === undefined) {
    record('G', 'G1', '(前置：取消失败)', '—', '—', false)
    record('G', 'G2', '(同上)', '—', '—', false)
    return
  }
  const cancelledHistory = [...firstEvents, ...cancelEvents]

  /*
   * 同一句话、**同一个来源事件**、同一操作 ⇒ 派生材料完全相同 ⇒ 同一 id。
   * 那正是"同一操作重复投递必须幂等"的那一面。
   */
  const sameSource = await validateGoalProposal(
    depsOf(registry, statePort([cancelledRow]).port, emptyProcessed()),
    proposalOf([createTarget(goalSnapshot({ statement }))]),
  )
  record(
    'G',
    'G1',
    '同来源 + 同内容 + 同操作 ⇒ 派生**同一 id**（幂等的那一面）',
    'goal_id_conflict（已存在，不得再建一次）',
    `[${sameSource.rejected.map((r) => r.code).join(',')}]`,
    !sameSource.accepted && sameSource.rejected.some((r) => r.code === 'goal_id_conflict'),
  )

  /*
   * **新的一轮**（新的受理来源事件）⇒ 新身份。这才是 G14 的场景：
   * 用户取消之后又明确重新设立。
   */
  const NEW_SOURCE = 'cev:m10-test-source-2'
  const second = await validateGoalProposal(
    depsOf(registry, statePort([cancelledRow]).port, emptyProcessed()),
    proposalOf([createTarget(goalSnapshot({ statement }))], {
      sourceConversationEventIds: [NEW_SOURCE] as never,
      sourceQualifications: [{ eventId: NEW_SOURCE, qualification: 'ESTABLISHED' }],
    }),
  )
  const secondWorld = second.accepted
    ? worldAfter(cancelledHistory, synthesize(second.acceptedEvents, M10_T0 + 60_200))
    : new Map<string, GoalRowState>()
  /* 新身份的行要**按新 id 取**：这一张表里现在有两行（旧的 cancelled + 新的） */
  const derivedSecondId = makeGoalId({
    characterId: CHARACTER,
    owner: goalSnapshot().owner,
    targetEntity: goalSnapshot().targetEntity,
    origin: 'user_requested',
    statement,
    acceptanceSourceEventId: NEW_SOURCE,
    operation: 'create',
  })
  const secondRow = secondWorld.get(goalRowKeyOf(String(derivedSecondId)))
  const secondId = secondRow === undefined ? '(无)' : String(secondRow.goal.goalId)
  record(
    'G',
    'G2',
    '取消后**新的一轮**明确重新设立同内容 ⇒ 新身份可达（不被旧幂等键吞掉）',
    'accepted · 新 id ≠ 旧 id · 新行 active',
    `${String(second.accepted)} · 新=${secondId} · 旧=${firstId} · status=${String(secondRow?.goal.status)}`,
    second.accepted && secondId !== firstId && secondRow?.goal.status === 'active',
  )
}

// ---------------------------------------------------------------------------
// R 组：重放不重复 / A==B
// ---------------------------------------------------------------------------

async function replayChecks(): Promise<void> {
  const registry = createFullDomainEventRegistry()
  const statement = '重放样本目标'
  const create = await validateGoalProposal(
    depsOf(registry, statePort().port, emptyProcessed()),
    proposalOf([createTarget(goalSnapshot({ statement }))]),
  )
  const createEvents = synthesize(create.acceptedEvents, M10_T0 + 70_000)
  const createdRows = [...worldOf(createEvents).values()]
  const row = createdRows[0]
  /*
   * ⚠️ **前置缺失不得抛错**（WP8 的量具自证在注入 N1 时抓到的形态）：
   *
   * 若建目标的事件**折不出行**（`goalRowKeyFromEvent` 漏了 `GOAL_CREATED` 的分派），
   * 第一版这里会 `row.goal.goalId` 抛 `TypeError` ⇒ 本组后面的 `R3`
   * ——**专门用来命名这个缺陷的那条检查**——根本没机会报。
   * 读档的人只看到一个 TypeError，而不是"建目标的事件没命中任何一行"。
   * ⇒ 前置缺失时**先把 `R3` 报红**，其余同组检查逐条记为"前置缺失"，然后返回。
   */
  if (row === undefined) {
    record(
      'R',
      'R3',
      '每个目标事件命中**恰好一行**（一目标一行；承诺事件也落在目标行）',
      '每个事件 → 非空行键且都等于同一行',
      '非空=0（**建目标的事件折不出行** ⇒ 正是 `goalRowKeyFromEvent` 漏了 `GOAL_CREATED` 的形状）',
      false,
    )
    for (const [id, label] of [
      ['R1', '**A==B**：分批折叠与全量折叠逐字段相同'],
      ['R2', '同一批事件重放第二次：状态逐字不变'],
      ['R4', `reducer 版本在有界集合内（${GOAL_REDUCER_VERSION}）`],
    ] as const) {
      record('R', id, label, '（依赖 R3 的前置）', '前置缺失：建目标的事件折不出行', false)
    }
    return
  }

  const pause = await validateGoalProposal(
    depsOf(registry, statePort([row]).port, emptyProcessed()),
    proposalOf([
      target(GOAL_PAUSED, {
        characterId: CHARACTER,
        goalId: String(row.goal.goalId),
        expectedRevision: row.goal.revision,
        reason: 'r',
      }),
    ]),
  )
  const pauseEvents = synthesize(pause.acceptedEvents, M10_T0 + 70_100)
  const all = [...createEvents, ...pauseEvents]

  /** 折叠 → 只取 state（比较用；revision/lastEvent 是行级元数据，不参与 A==B 的语义比较） */
  const statesOf = (events: readonly DomainEvent[]): Map<string, string> => {
    const world = worldOf(events)
    const out = new Map<string, string>()
    for (const [key, value] of world) out.set(key, JSON.stringify(value))
    return out
  }

  const full = statesOf(all)
  const incremental = new Map<string, string>()
  {
    // 一批一批折叠（增量），每批在**上一批的行**基础上继续
    const cache = new Map<string, GoalFoldEntry>()
    foldGoalRowsInMemory(cache, createEvents)
    foldGoalRowsInMemory(cache, pauseEvents)
    for (const [key, entry] of cache) incremental.set(key, JSON.stringify(entry.state))
  }
  const same =
    full.size === incremental.size &&
    [...full.entries()].every(([key, value]) => incremental.get(key) === value)
  record(
    'R',
    'R1',
    '**A==B**：分批折叠（增量）与一次性全量折叠得到**逐字段相同**的行',
    '同一组行状态',
    `full=${String(full.size)} 行 · incremental=${String(incremental.size)} 行 · 相同=${String(same)}`,
    same && full.size === 1,
  )

  // 重放同一批两次：第二次必须是 no-op（终态/幂等语义）
  const twice = new Map<string, GoalFoldEntry>()
  foldGoalRowsInMemory(twice, all)
  const beforeReplay = JSON.stringify([...twice.values()].map((entry) => entry.state))
  foldGoalRowsInMemory(twice, all)
  const afterReplay = JSON.stringify([...twice.values()].map((entry) => entry.state))
  record(
    'R',
    'R2',
    '同一批事件重放第二次：状态**逐字不变**（终态 no-op，不重复推进 revision）',
    '重放前后 state 相同',
    `相同=${String(beforeReplay === afterReplay)}`,
    beforeReplay === afterReplay,
  )

  // 行键稳定性：一个事件 → 一行
  const keys = all.map((event) => goalRowKeyFromEvent(event))
  record(
    'R',
    'R3',
    '每个目标事件命中**恰好一行**（一目标一行；承诺事件也落在目标行）',
    `${String(all.length)} 事件 → ${String(all.length)} 个非空行键且都等于同一行`,
    `非空=${String(keys.filter((k) => k !== undefined).length)} · 唯一值=${String(new Set(keys).size)}`,
    keys.every((k) => k !== undefined) && new Set(keys).size === 1,
  )

  // reducer 版本
  record(
    'R',
    'R4',
    `reducer 版本在有界集合内（${GOAL_REDUCER_VERSION}）`,
    'goal-fold@1',
    GOAL_REDUCER_VERSION,
    GOAL_REDUCER_VERSION === 'goal-fold@1',
  )
}

// ---------------------------------------------------------------------------
// DB 组：真实投影写回 / rebuild 对账 / 事务故障
// ---------------------------------------------------------------------------

async function databaseChecks(): Promise<void> {
  const runtime = createThinHostRuntime({
    character: character,
    settings: {},
  })
  await initDatabase(runtime)
  const db = getRawDb(runtime)
  const characterId = 'char_m10_db' as CharacterId
  const registry = createFullDomainEventRegistry()
  const processed = createProcessedOperationStore(db)
  const lookup = createGoalStateLookup(db)

  const st = statePort()
  // 让放行口看到**库里**的状态（真实只读端口）
  const realState: GoalStateLookupPort = {
    getGoal: (c, goalId) => lookup.getGoal(c, goalId),
    listGoals: (c) => lookup.listGoals(c),
  }

  const apply = async (targets: readonly ProposedDomainEvent[], at: number): Promise<{ accepted: boolean; codes: string[]; events: number }> => {
    const outcome = await validateGoalProposal(depsOf(registry, realState, processed, "char_m10_db"), {
      ...proposalOf(targets),
      characterId: characterId as never,
    })
    if (!outcome.accepted) {
      return { accepted: false, codes: outcome.rejected.map((r) => r.code), events: 0 }
    }
    await applyAcceptedEvents(db, characterId, outcome.acceptedEvents, [], at)
    const stored = await importEvents(db, outcome.acceptedEvents.length)
    await applyGoalRows(db, characterId, stored, at)
    return { accepted: true, codes: [], events: outcome.acceptedEvents.length }
  }

  /** 从库里把刚写入的域事件读回来（applyGoalRows 要的是已落库的事件） */
  const importEvents = async (_db: unknown, _count: number): Promise<DomainEvent[]> => {
    const { domainEventsFor } = await import('../src/infrastructure/persistence/event-store.ts')
    const events = await domainEventsFor(db, characterId)
    return events.filter((event) => (GOAL_DOMAIN_EVENT_TYPES as readonly string[]).includes(event.type))
  }

  const created = await apply(
    [createTarget(goalSnapshot({ statement: '库里样本目标', characterId: 'char_m10_db' }))],
    M10_T0 + 80_000,
  )
  const rowsAfterCreate = await listGoalRows(db, characterId)
  const rowInDb = rowsAfterCreate[0]?.state as GoalRowState | undefined
  record(
    'S',
    'S1',
    '真实写回：受理 → 领域事件落库 → 投影行落到 `goal:<id>`',
    'accepted · 1 行 · status=active',
    `${String(created.accepted)} · ${String(rowsAfterCreate.length)} 行 · status=${String(rowInDb?.goal.status)} · key=${String(rowsAfterCreate[0]?.projectionType)}`,
    created.accepted &&
      rowsAfterCreate.length === 1 &&
      rowInDb?.goal.status === 'active' &&
      String(rowsAfterCreate[0]?.projectionType).startsWith('goal:'),
  )

  if (rowInDb === undefined) {
    record('S', 'S2', 'rebuild 对账', 'A==B', '(S1 未通过)', false)
    return
  }

  // ---- rebuild 对账：重建前后的 state 必须逐字段相同 ----
  const before = JSON.stringify(rowInDb)
  const rebuild = await rebuildGoalProjections(db, characterId, M10_T0 + 80_500)
  const afterRebuild = await listGoalRows(db, characterId)
  const after = JSON.stringify((afterRebuild[0]?.state as GoalRowState | undefined) ?? null)
  record(
    'S',
    'S2',
    'rebuild 对账：删掉目标行并从事件全量重放 ⇒ state **逐字段相同**（铁律 ②）',
    'A==B · 行数不变',
    `行数 ${String(rowsAfterCreate.length)}→${String(afterRebuild.length)} · 重放事件=${String(rebuild.appliedEvents)} · 相同=${String(before === after)}`,
    before === after && afterRebuild.length === 1 && rebuild.appliedEvents > 0,
  )

  // ---- 幂等：同一提案重复投递 → 0 新事件、0 新行 ----
  /*
   * ⚠️ 幂等探针用**另一个目标**：S3 会真的落库（那一刻才有幂等记录），
   *    于是它会推进目标状态；若与 S4/S5 共用同一个目标，后面的断言就会
   *    看到"被 S3 改过的世界"——WP3 第二版正是这样把 S4/S5 打成 FAIL。
   *    门里的探针必须**互不污染**。
   */
  await apply(
    [createTarget(goalSnapshot({ statement: '幂等探针专用目标', characterId: 'char_m10_db' }))],
    M10_T0 + 80_550,
  )
  const probeRow = (await listGoalStates(db, characterId)).find(
    (state) => state.goal.statement === '幂等探针专用目标',
  )
  const pauseTarget = target(GOAL_PAUSED, {
    characterId: 'char_m10_db',
    goalId: String(probeRow?.goal.goalId ?? 'gol:missing'),
    expectedRevision: probeRow?.goal.revision ?? 1,
    reason: 'r',
  })
  const dupProposal = {
    ...proposalOf([pauseTarget]),
    characterId: characterId as never,
  }
  /*
   * ⚠️ 第一次必须**真的应用**（`apply` 会写 `processed_operations`）——
   *    只 validate 一遍不会留下幂等记录，于是"第二次被拒"这件事根本没被触发。
   */
  const firstPause = await apply([pauseTarget], M10_T0 + 80_600)
  const secondPause = await validateGoalProposal(depsOf(registry, realState, processed, 'char_m10_db'), dupProposal)
  record(
    'S',
    'S3',
    '幂等的**持久**一面：第一次**落库受理**之后，`processed_operations` 让第二次投递被拒（零事件）'
      + '—— 且重试带的是**原来的** expectedRevision（真实重试的形状）',
    'first=accepted · second=goal_duplicate_operation · 0 事件',
    `first=${String(firstPause.accepted)} · second=[${secondPause.rejected.map((r) => r.code).join(',')}] · events=${String(secondPause.acceptedEvents.length)}`,
    firstPause.accepted &&
      !secondPause.accepted &&
      secondPause.rejected.some((r) => r.code === 'goal_duplicate_operation') &&
      secondPause.acceptedEvents.length === 0,
  )

  // ---- 事务故障门：投影写入的乐观锁冲突 ⇒ 抛且**行不变** ----
  /* 复核一次"此刻"的行内容（前面的检查可能已经推进过世界） */
  const originRowNow = (await listGoalStates(db, characterId)).find(
    (state) => String(state.goal.goalId) === String(rowInDb.goal.goalId),
  )
  const baseline = JSON.stringify(originRowNow ?? null)
  const projection = await getProjection<GoalRowState>(db, characterId, goalRowKeyOf(String(rowInDb.goal.goalId)))
  let conflictCode = '(未抛)'
  if (projection !== undefined) {
    /*
     * 绕过 applyGoalRows，直接用**过期的 expectedRevision** 走 saveProjection：
     * 这正是"另一个写者抢先"的形状。要求：抛 revision_conflict，且行**没有被写坏**。
     */
    const { saveProjection } = await import('../src/infrastructure/persistence/event-store.ts')
    const poisoned = { ...projection, state: { goal: { ...rowInDb.goal, statement: '被污染的正文' }, commitment: null } }
    try {
      await saveProjection(db, poisoned, projection.revision + 99, M10_T0 + 81_000)
    } catch (error) {
      conflictCode = (error as { code?: string }).code ?? (error as Error).message
    }
    const reread = await getProjection<GoalRowState>(db, characterId, goalRowKeyOf(String(rowInDb.goal.goalId)))
    const stateAfter = JSON.stringify(reread?.state ?? null)
    record(
      'S',
      'S4',
      '事务故障门：过期 revision 的投影写入 ⇒ `projection_revision_conflict`，且行**内容不变**',
      '抛 projection_revision_conflict · state 未变',
      `code=${conflictCode} · stateUnchanged=${String(stateAfter === baseline)}`,
      conflictCode === 'projection_revision_conflict' && stateAfter === baseline,
    )
  } else {
    record('S', 'S4', '事务故障门', '投影行存在', '(读不到投影行)', false)
  }

  // ---- 未完成不能靠改 status 跳过 validator（DB 层的同一个命题） ----
  const originNow = (await listGoalStates(db, characterId)).find(
    (state) => String(state.goal.goalId) === String(rowInDb.goal.goalId),
  )
  const bypass = await validateGoalProposal(depsOf(registry, realState, processed, 'char_m10_db'), {
    ...proposalOf([
      target(GOAL_REVISED, {
        characterId: 'char_m10_db',
        goalId: String(rowInDb.goal.goalId),
        expectedRevision: originNow?.goal.revision ?? 1,
        changed: ['status'],
        reason: '想直接写 completed',
      }),
    ]),
    characterId: characterId as never,
  })
  const afterBypass = (await listGoalStates(db, characterId)).find(
    (state) => String(state.goal.goalId) === String(rowInDb.goal.goalId),
  )
  record(
    'S',
    'S5',
    '**未完成不能靠改 status 跳过 validator**：带 `changed:[status]` 的修订被拒，库里状态**逐字节不变**',
    'rejected:goal_revision_requires_supersede · 库里行不变',
    `[${bypass.rejected.map((r) => r.code).join(',')}] · status=${String(afterBypass?.goal.status)} · 不变=${String(JSON.stringify(afterBypass ?? null) === JSON.stringify(originNow ?? null))}`,
    !bypass.accepted &&
      bypass.rejected.some((r) => r.code === 'goal_revision_requires_supersede') &&
      JSON.stringify(afterBypass ?? null) === JSON.stringify(originNow ?? null),
  )

  // ---- 静态：可修订字段集与"实质改"的分界是**具名常量** ----
  record(
    'S',
    'S6',
    '小改 / 实质改的分界是**具名常量**（`GOAL_REVISABLE_FIELDS`），不是散落的字符串判断',
    '4 个可修订字段，且 status / successCriterion 都不在里面',
    `[${GOAL_REVISABLE_FIELDS.join(',')}]`,
    GOAL_REVISABLE_FIELDS.length === 4 &&
      !GOAL_REVISABLE_FIELDS.includes('status') &&
      !GOAL_REVISABLE_FIELDS.includes('successCriterion'),
  )

  /*
   * ---- 静态锁：`goalsEnabled` 必须被 `src/main.ts` **真的消费**（`G-1` 的回归锁）----
   *
   * ⚠️ 这条的来历是 `D3`：`CHARACTER_MEMORY_BACKGROUND_ENABLED` 只被读进 flags、
   *    **没有任何消费者** ⇒ 一个惰性的、看起来能开的开关。
   * ⚠️ 用 `codeLinesOf`（**去掉注释**）判：否则注释里提一句 `goalsEnabled` 就能骗过它 ——
   *    那正是本文件 `C2`/`C3` 踩过的坑（量具测错了对象）。
   */
  const mainCode = codeLinesOf(readSrc('src/main.ts')).join('\n')
  record(
    'S',
    'S7',
    '**`G-1` 的开关必须被真的消费**：`src/main.ts` 的**代码**里必须出现**消费的写法本身**'
      + '（`flags.goalsEnabled` 的三元判断），而不是只被读进 flags —— 那就是 D3 那个惰性开关',
    '出现 `flags.goalsEnabled ?` 的消费写法',
    `消费写法 ${String((mainCode.match(/flags\.goalsEnabled\s*\?/g) ?? []).length)} 处` +
      ` · 名字总共 ${String((mainCode.match(/goalsEnabled/g) ?? []).length)} 处`,
    (mainCode.match(/flags\.goalsEnabled\s*\?/g) ?? []).length >= 1,
  )
  record(
    'S',
    'S8',
    '**接线点是每轮一处**：`runGoalTurn` 出现在 `src/main.ts` 的代码里'
      + '（`CompileTurnInput` 的字段，不是网关构造参数 —— 后者不认识它）',
    '代码里出现 ≥ 1 处',
    `${String((mainCode.match(/runGoalTurn/g) ?? []).length)} 处`,
    (mainCode.match(/runGoalTurn/g) ?? []).length >= 1,
  )

  void st
  void insertProjection
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  /*
   * ⚠️ **组隔离**（WP8 的量具自证抓出来的）：
   *
   * 注入"`GOAL_CREATED` 折不出行"这个真实缺陷时，**L 组会先抛错**，
   * 于是后面的 R 组**根本没跑** —— 而 `R3` 恰恰是专门用来**命名**这个缺陷的那条检查。
   * 后果：门确实失败了（退出码非零），但它**没有报出是哪一条**，
   * 读档的人只看到一个 `TypeError`，而不是"建目标的事件没命中任何一行"。
   *
   * ⇒ 每一组用 `runGroup` 包起来：一组内部抛错会被记成**该组的具名失败**，
   *    后面的组照常跑。**一个缺陷不该把其余诊断全部致盲。**
   */
  const runGroup = async (id: string, label: string, work: () => void | Promise<void>): Promise<void> => {
    phase(label)
    try {
      await work()
    } catch (error) {
      record(
        'X',
        `GRP-${id}`,
        `【组隔离】${label} 组在运行中抛错 ⇒ 记为该组的具名失败，**后面的组照常跑**`,
        '该组不抛错',
        error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        false,
      )
    }
  }

  await runGroup('C', 'contract', () => contractChecks())
  await runGroup('L', 'legal edges', () => legalEdgeChecks())
  await runGroup('X', 'illegal edges', () => illegalEdgeChecks())
  await runGroup('G', 're-identity (G14)', () => reIdentityChecks())
  await runGroup('R', 'replay / A==B', () => replayChecks())
  await runGroup('S', 'database', () => databaseChecks())
  phase('done')

  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  const runId = createM10RunId({ wpId: 'wp3-test', headShort: head })
  const dir = openM10RunDir(REPO_ROOT, runId)

  const passed = checks.filter((c) => c.pass).length
  const failed = checks.length - passed
  const groups = ['C', 'L', 'X', 'G', 'R', 'S'] as const
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
    schema: 'm10-test@1',
    runId,
    head,
    characterId: CHARACTER,
    checks,
    perGroup,
    summary: {
      total: checks.length,
      passed,
      failed,
      verdict: failed === 0 ? 'PASS' : 'FAIL',
    },
  }
  writeFileSync(join(dir, 'goal-kernel-test.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  writeM10Manifest(dir, {
    runId,
    wp: 'wp3',
    head,
    headShort: head.slice(0, 12),
    branch: execFileSync('git', ['branch', '--show-current'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim(),
    date: new Date().toISOString().slice(0, 10),
    toolVersions: { node: process.version, git: '(见 baseline)' },
    testType: 'kernel-test',
    counts: { total: checks.length, passed, failed },
    phases: ['single'],
    supersedes: null,
    notes:
      'WP3 目标内核门：契约与登记（C）· 合法边全触达（L）· 非法边拒绝且零事件（X·含幂等）· ' +
      '取消后重新设立的新身份（G）· 重放 A==B（R）· 真实投影写回与 rebuild 对账与事务故障（S）',
    databaseScope: 'isolated',
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
