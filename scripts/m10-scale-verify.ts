/**
 * M10 WP9-A —— **规模门**（`pnpm m10:scale:verify`）。
 *
 * ============================================================================
 *  本门测什么（计划 §12 WP9 的出口判据里属"规模"的那几条）
 * ============================================================================
 * ```text
 * G46  第 1 / 第 51 / **最老仍 active** 的目标都**按 ID 可读**（不因尾窗消失）
 *      任意抽样重建一致
 *      无跨用户目标
 *      **不能用规模截断掩盖未取消承诺**
 * U-06 族读取成本曲线（ADR-076 `D24` 要求 WP9 实测；`listGoals` 是**全表前缀过滤**）
 * ```
 *
 * ============================================================================
 *  三条硬性质
 * ============================================================================
 * ① **池子是"物化"的，不是"提议"的**：为了把规模做上去，大多数目标是**直接**
 *    用 `applyGoalRows` 从合成事件落库的 —— 这与"提案 → 放行口 → 落库"是**两条**
 *    路径。本门**明确**登记这一点（见 §池子怎么造的），**不**声称"规模池走完了授权链"。
 *    授权链本身由 `m10:e2e:verify` 与 `m10:test` 覆盖。
 * ② **性能读数不设 PASS/FAIL 阈值**（计划 §12 WP9 原文："性能未达单列，不降功能门"）：
 *    本门**报曲线**并断言"曲线被真的量到了"（`measured_count > 0`），
 *    **不**因为慢就判 FAIL，也**不**因为快就判 PASS。
 * ③ **零分母不是 PASS**：所有比例型读数都先断言分母 > 0。
 *
 * ⚠️ `isolateDatabase()` 一次性沙箱库；真实库**从不被打开**。零模型 / 零出网。
 */

import 'dotenv/config'

import { isolateDatabase } from '../src/dev/sandbox.ts'
isolateDatabase('m10-scale', { keep: false })

import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'

import { AgentRuntime } from '@elizaos/core'
import sqlPlugin from '@elizaos/plugin-sql'

import { createM10RunId, openM10RunDir, writeM10Manifest } from './m10-evidence.ts'
import { character } from '../src/character/index.ts'
import { initDatabase } from '../src/db/index.ts'
import { getRawDb } from '../src/infrastructure/persistence/db.ts'
import {
  applyAcceptedEvents,
  domainEventsFor,
} from '../src/infrastructure/persistence/event-store.ts'
import { createProcessedOperationStore } from '../src/infrastructure/persistence/job-store.ts'
import {
  applyGoalRows,
  createGoalStateLookup,
  listGoalStates,
  rebuildGoalProjections,
} from '../src/infrastructure/persistence/goal-store.ts'
import type { CharacterId, DomainEvent } from '../src/kernel/contracts/index.ts'
import {
  COMMITMENT_ACCEPTED,
  COMMITMENT_CANCELLED,
  COMMITMENT_FULFILLED,
  GOAL_CANCELLED,
  GOAL_COMPLETED,
  GOAL_CREATED,
  GOAL_DOMAIN_EVENT_TYPES,
  GOAL_PAUSED,
  GOAL_RESUMED,
  GOAL_REVISED,
  GOAL_SUPERSEDED,
  createFullDomainEventRegistry,
} from '../src/kernel/contracts/domain-event.ts'
import type { CommitmentState, GoalRowState, GoalState } from '../src/kernel/contracts/goal.ts'
import { isCommitmentTerminal, isGoalTerminal } from '../src/kernel/contracts/goal.ts'
import type { AcceptedDomainEvent } from '../src/kernel/policies/validator.ts'
import { goalProposalOf, validateGoalProposal } from '../src/kernel/policies/goal-validator.ts'

const REPO_ROOT = resolve(process.cwd())
const CHARACTER_A = 'char_m10_scale_a' as CharacterId
const CHARACTER_B = 'char_m10_scale_b' as CharacterId
const USER_ID = 'm10-scale-user'
const M10_T0 = 2_500_000_000_000

/** 池子规模（够大以暴露"尾窗"类缺陷，又能在一次门里跑完） */
const POOL_SIZE = 120
/** `U-06` 曲线要采的点 */
const READ_COST_POINTS = [25, 50, 100, 200] as const

function phase(mark: string): void {
  console.error(`[m10-scale] ${mark}`)
}

// ---------------------------------------------------------------------------
// 量具
// ---------------------------------------------------------------------------

interface Check {
  group: 'S' | 'R' | 'K' | 'Z'
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

/** 每类读取的实测耗时（给曲线用；**不进 PASS/FAIL**） */
const readCost: {
  n: number
  listGoalsMs: number
  getGoalMs: number
  rows: number
  totalRowsAtMeasurement: number
}[] = []

// ---------------------------------------------------------------------------
// 合成事件（**物化池子**用；不是授权路径）
// ---------------------------------------------------------------------------

/**
 * 合成一条 `AcceptedDomainEvent`（**物化池子**用；不是授权路径）。
 *
 * ⚠️ 第一版**只**调了 `applyGoalRows`（只写投影行、不写事件）⇒ `rebuild` 把整池
 *    重放成 **0 行**（因为事件表里一条都没有）。**这正是铁律 ② 在起作用**：
 *    投影是派生的 —— 没有事件的行不是"数据"，是**孤儿**。
 *    ⇒ 物化必须**两件都写**：事件 + 投影行。
 */
function acceptedOf(
  characterId: CharacterId,
  index: number,
  goal: GoalState,
): AcceptedDomainEvent {
  return {
    type: GOAL_CREATED,
    operation: 'create',
    payload: { characterId, goal, mutation: 'explicit' },
    sourceConversationEventIds: [],
    idempotencyKey: `idem:m10-scale-${String(characterId)}-${String(index)}`,
    processor: 'm10-scale-verify',
    processorVersion: 'm10-scale-verify@1',
    scope: 'CHARACTER_INTERNAL' as never,
  }
}

function goalSnapshot(
  characterId: CharacterId,
  index: number,
  status: GoalState['status'] = 'active',
): GoalState {
  return {
    goalId: `gol:scale-${String(index).padStart(4, '0')}` as GoalState['goalId'],
    characterId,
    owner: { kind: 'character', id: String(characterId) } as GoalState['owner'],
    origin: 'user_requested',
    sourceRefs: [{ conversationEventId: `cev:scale-${String(index)}` as never, fingerprint: `fp-${String(index)}` }],
    revision: 1,
    statement: `规模池目标 #${String(index)}`,
    successCriterion: { kind: 'user_report' },
    status,
    priority: index % 7 === 0 ? 'high' : 'normal',
    dependencies: [],
    time: { recordedAt: M10_T0 + index },
  }
}

function commitmentOf(characterId: CharacterId, goalId: string): CommitmentState {
  return {
    commitmentId: `cmt:scale-${goalId}` as CommitmentState['commitmentId'],
    goalId: goalId as never,
    actor: { kind: 'character', id: String(characterId) } as CommitmentState['actor'],
    beneficiary: { kind: 'user', id: USER_ID } as CommitmentState['beneficiary'],
    scope: '给三个步骤',
    acceptedAt: M10_T0,
    acceptanceRefs: [{ conversationEventId: 'cev:scale-c' as never, fingerprint: 'fp' }],
    criterion: { kind: 'conversation_output', structure: { kind: 'item_count', count: 3 } },
    status: 'active',
    completionRefs: [],
    revision: 1,
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  phase('boot isolated database')
  const runtime = new AgentRuntime({ character, plugins: [] })
  await initDatabase(runtime, sqlPlugin)
  const db = getRawDb(runtime)
  const registry = createFullDomainEventRegistry()

  /* =======================================================================
   * 池子怎么造的（**如实登记**）
   * ===================================================================== */
  phase(`materialize pool (${String(POOL_SIZE)} goals for A, 20 for B)`)
  const acceptedA: AcceptedDomainEvent[] = []
  for (let index = 0; index < POOL_SIZE; index += 1) {
    acceptedA.push(acceptedOf(CHARACTER_A, index + 1, goalSnapshot(CHARACTER_A, index)))
  }
  const acceptedB: AcceptedDomainEvent[] = []
  for (let index = 0; index < 20; index += 1) {
    acceptedB.push(acceptedOf(CHARACTER_B, index + 1, goalSnapshot(CHARACTER_B, 900 + index)))
  }
  /*
   * ⚠️ 终态目标**不能**用 `GOAL_CREATED` 直接造成 `cancelled`
   *    （放行口与折叠器都要求新建即 `active`：`不存在 → active`）。
   *    因此它是"先建后取消"两步 —— 这也是真实链路里的唯一形状。
   *
   * ⚠️ 它的 `index` 必须**不与池子重叠**：第一版复用了 77，于是它与池里的
   *    `gol:scale-0077` **是同一个 id**，折叠成同一行 ⇒ 行数少 1 而**不报错**。
   *    "规模池里的 id 撞车"正是这个工作包要暴露的那类问题。
   */
  const terminalIndex = 500
  acceptedA.push(acceptedOf(CHARACTER_A, POOL_SIZE + 1, goalSnapshot(CHARACTER_A, terminalIndex)))

  await applyAcceptedEvents(db, CHARACTER_A, acceptedA, [], M10_T0 + 5_000)
  await applyAcceptedEvents(db, CHARACTER_B, acceptedB, [], M10_T0 + 5_000)
  await applyGoalRows(
    db,
    CHARACTER_A,
    (await domainEventsFor(db, CHARACTER_A)).filter((event) =>
      (GOAL_DOMAIN_EVENT_TYPES as readonly string[]).includes(event.type),
    ) as readonly DomainEvent[],
    M10_T0 + 10_000,
  )
  await applyGoalRows(
    db,
    CHARACTER_B,
    (await domainEventsFor(db, CHARACTER_B)).filter((event) =>
      (GOAL_DOMAIN_EVENT_TYPES as readonly string[]).includes(event.type),
    ) as readonly DomainEvent[],
    M10_T0 + 10_000,
  )
  /* 再把它取消（真事件，不是"造一个 cancelled 的 created"） */
  await applyAcceptedEvents(
    db,
    CHARACTER_A,
    [
      {
        type: GOAL_CANCELLED,
        operation: 'retract',
        payload: {
          characterId: CHARACTER_A,
          goalId: String(goalSnapshot(CHARACTER_A, terminalIndex).goalId),
          expectedRevision: 1,
          reason: 'user_cancel',
        },
        sourceConversationEventIds: [],
        idempotencyKey: 'idem:m10-scale-terminal-cancel',
        processor: 'm10-scale-verify',
        processorVersion: 'm10-scale-verify@1',
        scope: 'CHARACTER_INTERNAL' as never,
      },
    ],
    [],
    M10_T0 + 15_000,
  )
  await applyGoalRows(
    db,
    CHARACTER_A,
    (await domainEventsFor(db, CHARACTER_A)).filter((event) =>
      (GOAL_DOMAIN_EVENT_TYPES as readonly string[]).includes(event.type),
    ) as readonly DomainEvent[],
    M10_T0 + 20_000,
  )

  const rowsA = await listGoalStates(db, CHARACTER_A)
  const rowsB = await listGoalStates(db, CHARACTER_B)
  record(
    'S',
    'S1',
    `**池子物化**：A 角色 ${String(POOL_SIZE)}+1 行 · B 角色 20 行`
      + '（⚠️ 走的是 `applyGoalRows` **直接落库**，不是授权链 —— 授权链由 `m10:e2e:verify` 覆盖）',
    `${String(POOL_SIZE + 1)} 行 + 20 行`,
    `${String(rowsA.length)} 行 + ${String(rowsB.length)} 行 · 事件 ${String(acceptedA.length)}+${String(acceptedB.length)}+1(取消)`,
    rowsA.length === POOL_SIZE + 1 && rowsB.length === 20,
  )

  const lookup = createGoalStateLookup(db)

  /* =======================================================================
   * G46：第 1 / 第 51 / 最老仍 active 按 ID 可读
   * ===================================================================== */
  phase('G46 read by id: 1st / 51st / oldest-still-active')

  const sorted = [...rowsA].sort((a, b) =>
    String(a.goal.goalId) < String(b.goal.goalId) ? -1 : 1,
  )
  const first = sorted[0]!
  const fiftyFirst = sorted[50]!
  const oldestActive = sorted.find((row) => row.goal.status === 'active')!

  const firstRead = await lookup.getGoal(CHARACTER_A, first.goal.goalId)
  const fiftyFirstRead = await lookup.getGoal(CHARACTER_A, fiftyFirst.goal.goalId)
  const oldestActiveRead = await lookup.getGoal(CHARACTER_A, oldestActive.goal.goalId)

  record(
    'S',
    'S2',
    '【G46】**第 1 项**按 ID 可读（不因它在"尾窗"之外而消失）',
    '逐字段一致',
    `${String(first.goal.goalId)} 读到=${String(firstRead !== undefined)}`,
    firstRead !== undefined &&
      JSON.stringify(firstRead) === JSON.stringify(first),
  )
  record(
    'S',
    'S3',
    '【G46】**第 51 项**按 ID 可读（`G46` 点名的那一项）',
    '逐字段一致',
    `${String(fiftyFirst.goal.goalId)} 读到=${String(fiftyFirstRead !== undefined)}`,
    fiftyFirstRead !== undefined &&
      JSON.stringify(fiftyFirstRead) === JSON.stringify(fiftyFirst),
  )
  record(
    'S',
    'S4',
    '【G46】**最老仍 active** 项按 ID 可读',
    '逐字段一致',
    `${String(oldestActive.goal.goalId)}（${oldestActive.goal.status}）读到=${String(oldestActiveRead !== undefined)}`,
    oldestActiveRead !== undefined &&
      JSON.stringify(oldestActiveRead) === JSON.stringify(oldestActive),
  )

  /* =======================================================================
   * 任意抽样重建一致
   * ===================================================================== */
  phase('arbitrary-sample rebuild identical')

  const storedEvents = (await domainEventsFor(db, CHARACTER_A)).filter((event) =>
    (GOAL_DOMAIN_EVENT_TYPES as readonly string[]).includes(event.type),
  )
  const beforeRebuild = JSON.stringify(rowsA)
  const rebuild = await rebuildGoalProjections(db, CHARACTER_A, M10_T0 + 20_000)
  const afterRows = await listGoalStates(db, CHARACTER_A)
  const afterRebuild = JSON.stringify(afterRows)
  /* 抽样：取 12 项（**确定性抽样**，避免"这次刚好抽到没问题的那几个"） */
  const sample = sorted.filter((_, index) => index % 10 === 0).slice(0, 12)
  const byId = new Map(afterRows.map((row) => [String(row.goal.goalId), row]))
  const sampleMismatch = sample.filter(
    (row) => JSON.stringify(byId.get(String(row.goal.goalId))) !== JSON.stringify(row),
  )
  record(
    'S',
    'S5',
    '**任意抽样重建一致**：全量重放后整池逐字段相同，且抽样的 12 项逐字一致',
    'A==B · 抽样 0 处不符',
    `全量相同=${String(beforeRebuild === afterRebuild)} · 重放事件=${String(rebuild.appliedEvents)} · ` +
      `抽样 ${String(sample.length)} 项 · 不符 ${String(sampleMismatch.length)}`,
    beforeRebuild === afterRebuild &&
      rebuild.appliedEvents > 0 &&
      sample.length === 12 &&
      sampleMismatch.length === 0,
  )
  record(
    'S',
    'S6',
    '`rebuild` 的事件数 ≈ 池子事件数（**分母非零**：不靠"没重放"通过）',
    `${String(storedEvents.length)} 个目标事件`,
    `重放 ${String(rebuild.appliedEvents)}`,
    rebuild.appliedEvents >= storedEvents.length,
  )

  /* =======================================================================
   * 无跨用户目标
   * ===================================================================== */
  phase('no cross-character goals')

  const bIds = new Set(rowsB.map((row) => String(row.goal.goalId)))
  const leakAtoB = afterRows.filter((row) => bIds.has(String(row.goal.goalId)))
  const bReadOfAGoal = await lookup.getGoal(CHARACTER_B, first.goal.goalId)
  record(
    'K',
    'K1',
    '**无跨用户目标**：A 的行里没有 B 的 id，且用 B 去读 A 的目标读不到',
    '0 处泄漏 · B 读 A = undefined',
    `A 含 B id=${String(leakAtoB.length)} 处 · B 读 A=${String(bReadOfAGoal === undefined)}`,
    leakAtoB.length === 0 && bReadOfAGoal === undefined,
  )

  /* =======================================================================
   * 不能用规模截断掩盖未取消承诺
   * ===================================================================== */
  phase('scale must not hide uncancelled commitments')

  /*
   * ⚠️ 两件事**分开判**：
   *   ① **不变量**：任何**终态**目标上不得挂着 **non-terminal** 承诺（孤儿约定）
   *   ② **放行口在规模下仍然拒绝**孤儿场景（不是"池子大了就放过"）
   */
  const orphanRows = (await listGoalStates(db, CHARACTER_A)).filter(
    (row: GoalRowState) =>
      isGoalTerminal(row.goal.status) &&
      row.commitment !== null &&
      !isCommitmentTerminal(row.commitment.status),
  )
  record(
    'K',
    'K2',
    '**不变量**：规模池里 **0** 个"终态目标 + non-terminal 承诺"的孤儿'
      + '（"池子大"不得成为放过孤儿约定的理由）',
    '0 个孤儿',
    `${String(orphanRows.length)} 个`,
    orphanRows.length === 0,
  )

  /* 真的往放行口投一次孤儿场景（在**这个规模**下） */
  const orphanGoalId = String(sorted[5]!.goal.goalId)
  const orphanProposal = goalProposalOf({
    proposalId: 'm10-scale-orphan',
    operation: 'cancel',
    characterId: CHARACTER_A,
    processor: 'm10-scale-verify',
    processorVersion: 'm10-scale-verify@1',
    sourceConversationEventIds: ['cev:scale-orphan'],
    sourceQualifications: [{ eventId: 'cev:scale-orphan', qualification: 'ESTABLISHED' }],
    targets: [
      {
        type: GOAL_CANCELLED,
        operation: 'retract',
        payload: {
          characterId: CHARACTER_A,
          goalId: orphanGoalId,
          expectedRevision: sorted[5]!.goal.revision,
          reason: 'user_cancel',
        },
        scope: 'CHARACTER_INTERNAL',
      },
    ],
  })

  /* 先给这一项挂一个 active 承诺（直接物化），再让放行口判取消 */
  const commitmentEvents: DomainEvent[] = [
    {
      id: 'dev:m10-scale-commitment',
      characterId: CHARACTER_A,
      sequence: 9001,
      type: COMMITMENT_ACCEPTED,
      sourceConversationEventIds: [],
      payload: {
        characterId: CHARACTER_A,
        goalId: orphanGoalId,
        commitment: commitmentOf(CHARACTER_A, orphanGoalId),
        expectedGoalRevision: sorted[5]!.goal.revision,
      },
      processor: 'm10-scale-verify',
      processorVersion: 'm10-scale-verify@1',
      idempotencyKey: 'idem:m10-scale-commitment',
      schemaVersion: 1,
      createdAt: M10_T0 + 30_000,
    } as unknown as DomainEvent,
  ]
  await applyGoalRows(db, CHARACTER_A, commitmentEvents, M10_T0 + 30_000)

  const outcome = await validateGoalProposal(
    {
      registry,
      processed: createProcessedOperationStore(db),
      state: {
        getGoal: (c: CharacterId, goalId: string) => lookup.getGoal(c, goalId as never),
        listGoals: (c: CharacterId) => lookup.listGoals(c),
      } as never,
      policy: { characterId: CHARACTER_A, activeUserId: USER_ID },
    },
    orphanProposal,
  )
  record(
    'K',
    'K3',
    '**放行口在规模下仍拒绝孤儿**：给池里第 6 项挂 active 承诺后单独取消它 ⇒ '
      + '`goal_orphan_commitment`，且**零事件**',
    'rejected:goal_orphan_commitment · 0 事件',
    `${String(outcome.accepted)} · [${outcome.rejected.map((r) => r.code).join(',')}] · ${String(outcome.acceptedEvents.length)} 事件`,
    !outcome.accepted &&
      outcome.rejected.some((r) => r.code === 'goal_orphan_commitment') &&
      outcome.acceptedEvents.length === 0,
  )

  /* =======================================================================
   * U-06：族读取成本曲线（**只报，不设阈值**）
   * ===================================================================== */
  phase('U-06 family read cost curve (measure only)')

  /*
   * ⚠️ **第一版这里是个量具缺陷**：我按 25/50/100/200 采了四个点，
   *    但每个点读的都是**同一个 121 行的池子** ⇒ 我量的是同一件事四次，
   *    曲线是平的只是因为它本来就不该变。**"数字看起来合理、量的是错的东西"**
   *    正是本仓库最贵的缺陷形状（AGENTS §6 第 9 条）。
   *
   * ⇒ 现在为每个采样点**真的建一个不同规模的池子**（各自的角色），
   *    再用同一个 `listGoals` 量它。
   *
   * ⚠️ 它们共用**一张表**，因此后采的点看到的表更大 —— 这本身是信息
   *    （若 `listGoals` 是全表扫描，成本会随**总表**而不是"本角色行数"走）。
   *    读数里两个数都记，让这个区分是可见的。
   */
  for (const point of READ_COST_POINTS) {
    const poolCharacter = `char_m10_scale_n${String(point)}` as CharacterId
    const poolAccepted: AcceptedDomainEvent[] = []
    for (let index = 0; index < point; index += 1) {
      poolAccepted.push(
        acceptedOf(poolCharacter, index + 1, {
          ...goalSnapshot(poolCharacter, index),
          goalId: `gol:n${String(point)}-${String(index).padStart(4, '0')}` as GoalState['goalId'],
          statement: `成本池${String(point)} #${String(index)}`,
        }),
      )
    }
    await applyAcceptedEvents(db, poolCharacter, poolAccepted, [], M10_T0 + 40_000 + point)
    await applyGoalRows(
      db,
      poolCharacter,
      (await domainEventsFor(db, poolCharacter)).filter((event) =>
        (GOAL_DOMAIN_EVENT_TYPES as readonly string[]).includes(event.type),
      ) as readonly DomainEvent[],
      M10_T0 + 40_000 + point,
    )

    const poolLookup = createGoalStateLookup(db)
    const t0 = performance.now()
    const list = await poolLookup.listGoals(poolCharacter)
    const t1 = performance.now()
    const targetId = list[0]!.goal.goalId
    const g0 = performance.now()
    await poolLookup.getGoal(poolCharacter, targetId)
    const g1 = performance.now()

    /* 同时记"此刻全表有多少行"（与"本角色多少行"分开报） */
    const totalRowsNow = (await listGoalStates(db, CHARACTER_A)).length
      + (await listGoalStates(db, CHARACTER_B)).length

    readCost.push({
      n: point,
      listGoalsMs: Number((t1 - t0).toFixed(3)),
      getGoalMs: Number((g1 - g0).toFixed(3)),
      rows: list.length,
      totalRowsAtMeasurement: totalRowsNow,
    })
  }

  const perItem = readCost.map((point) => ({
    n: point.n,
    usPerItem: Number(((point.listGoalsMs * 1000) / Math.max(1, point.rows)).toFixed(1)),
  }))
  record(
    'R',
    'R1',
    '【U-06】**族读取成本曲线已实测**（`D24`：`listGoals` 是全表前缀过滤）——'
      + '每个采样点**真的建了不同规模的池子**（第一版四个点读的是同一个池子 ⇒ 量错了）',
    '每个采样点都有非零读数且 `rows` 随 n 增长',
    readCost
      .map((p) => `n=${String(p.n)}→list=${String(p.listGoalsMs)}ms(${String(p.rows)}行)/get=${String(p.getGoalMs)}ms`)
      .join(' · '),
    readCost.length === READ_COST_POINTS.length &&
      readCost.every((p, index) => p.rows === READ_COST_POINTS[index] && p.listGoalsMs >= 0),
  )
  record(
    'R',
    'R2',
    '【U-06】**单项读取与池子规模无关**（`getGoal` 是主键读）：其耗时不随规模上升',
    'getGoal 保持常数级（< 5ms）',
    `getGoal: ${readCost.map((p) => String(p.getGoalMs)).join(' / ')} ms`,
    readCost.every((p) => p.getGoalMs < 5),
  )
  record(
    'R',
    'R3',
    '【U-06】曲线的**每项成本**（µs/行）已算出并留存 —— 它才是 `L-M10-06`'
      + '（放行口每次校验都调 `listGoals`）的量化依据。'
      + '⚠️ 若成本随**总表**而非"本角色行数"走，那是**更严重**的发现，读数里两个数都记',
    '非零分母 · 两个规模数都记',
    perItem.map((p) => `n=${String(p.n)}→${String(p.usPerItem)}µs/行`).join(' · ') +
      ` · 总表=${readCost.map((p) => String(p.totalRowsAtMeasurement)).join('/')}`,
    perItem.length > 0 && perItem.every((p) => Number.isFinite(p.usPerItem)),
  )

  /* =======================================================================
   * Z：计量自检
   * ===================================================================== */
  const finalRows = await listGoalStates(db, CHARACTER_A)
  record(
    'Z',
    'Z1',
    '**`measured_count > 0` 自检**：池子真的建了、读取真的量到了、重放真的跑了'
      + '（"0 行 / 0 ms"与"全部通过"在输出上长得一样）',
    '行 > 0 · 成本采样 > 0 · 重放 > 0',
    `行 ${String(finalRows.length)} · 成本采样 ${String(readCost.length)} · 重放 ${String(rebuild.appliedEvents)}`,
    finalRows.length > 0 && readCost.length > 0 && rebuild.appliedEvents > 0,
  )

  phase('done')
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  const runId = createM10RunId({ wpId: 'wp9-scale', headShort: head })
  const dir = openM10RunDir(REPO_ROOT, runId)

  const passed = checks.filter((c) => c.pass).length
  const failed = checks.length - passed
  const groups = ['S', 'R', 'K', 'Z'] as const
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
    schema: 'm10-scale-verify@1',
    runId,
    head,
    characterId: CHARACTER_A,
    poolSize: POOL_SIZE,
    /** ⚠️ 物化说明：规模池走的是 `applyGoalRows`，**不是**授权链 */
    poolMaterialization: 'applyGoalRows-from-synthesized-events',
    readCostCurve: readCost,
    perItemMicros: perItem,
    checks,
    perGroup,
    summary: { total: checks.length, passed, failed, verdict: failed === 0 ? 'PASS' : 'FAIL' },
  }
  writeFileSync(join(dir, 'scale-verify.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  writeM10Manifest(dir, {
    runId,
    wp: 'wp9',
    head,
    headShort: head.slice(0, 12),
    branch: execFileSync('git', ['branch', '--show-current'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim(),
    date: new Date().toISOString().slice(0, 10),
    toolVersions: { node: process.version, git: '(见 baseline)' },
    testType: 'scale-verify',
    counts: { total: checks.length, passed, failed },
    phases: ['single'],
    supersedes: null,
    notes:
      'WP9-A 规模门：G46 三项按 ID 可读 · 抽样重建一致 · 无跨用户 · ' +
      '规模不得掩盖未取消承诺 · U-06 族读取成本曲线（只报不设阈值）。隔离库，零模型。',
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
  console.log(
    `U-06 曲线（只报）：${readCost.map((p) => `${String(p.n)}→${String(p.listGoalsMs)}ms`).join(' · ')}`,
  )
  process.exitCode = failed === 0 ? 0 : 1
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})

void GOAL_PAUSED
void GOAL_RESUMED
void GOAL_REVISED
void GOAL_SUPERSEDED
void GOAL_COMPLETED
void COMMITMENT_CANCELLED
void COMMITMENT_FULFILLED
void applyAcceptedEvents
