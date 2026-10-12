/**
 * M10 —— **共用的验收装配**（`m10:e2e:verify` / `m10:long:verify` / 后续门都用它）。
 *
 * ============================================================================
 *  它为什么存在：一处接线，不是两处
 * ============================================================================
 * `runGoalTurn()` 需要四个端口（候选 / 写入 / 放行口 / 兑现证据），其中
 * "放行口 + 写入器 + 真实库"这三者的接线有若干**易错细节**：
 *
 * ```text
 * ① 放行口给的 `AcceptedDomainEvent` 必须**原样**交给 `applyAcceptedEvents`
 *    （削成自造形状会让写入器抛 —— WP8b 真实踩过）
 * ② 事件与投影行是**两个事务**，且投影必须在事件**之后**落
 * ③ 候选必须与放行口看到的是**同一份**状态（否则 `expectedRevision` 会对不上）
 * ④ `isolateDatabase()` **必须由调用方**在碰库之前调用（本模块**不**调）
 * ```
 * 两处接线 = 迟早漂移的一处。因此本模块是**唯一**的那一份。
 *
 * ⚠️ 纯脚本层装配（`scripts/`）：可以 import 基础设施，与 `m4-harness.ts` /
 *    `m5.5-harness.ts` 同一层级与同一条纪律。
 */

import type { RawDb } from '../src/infrastructure/persistence/db.ts'
import type { CharacterId, DomainEvent } from '../src/kernel/contracts/index.ts'
import {
  GOAL_DOMAIN_EVENT_TYPES,
  createFullDomainEventRegistry,
} from '../src/kernel/contracts/domain-event.ts'
import type { GoalRowState, GoalState } from '../src/kernel/contracts/goal.ts'
import {
  applyAcceptedEvents,
  domainEventsFor,
} from '../src/infrastructure/persistence/event-store.ts'
import { createProcessedOperationStore } from '../src/infrastructure/persistence/job-store.ts'
import {
  applyGoalRows,
  createGoalStateLookup,
  listGoalStates,
} from '../src/infrastructure/persistence/goal-store.ts'
import {
  candidatesFromGoals,
  commitmentSummariesOf,
  runGoalTurn,
  type GoalTurnPorts,
  type GoalTurnResult,
} from '../src/kernel/app/goal/turn.ts'
import type {
  GoalUnderstandingProvider,
  GoalUnderstandingRuntime,
} from '../src/kernel/app/goal/understanding.ts'
import {
  goalProposalOf,
  validateGoalProposal,
  type GoalProposal,
} from '../src/kernel/policies/goal-validator.ts'

export interface M10TurnHarness {
  readonly characterId: CharacterId
  readonly ports: GoalTurnPorts
  /** 跑一轮（走完整的 理解 → 放行口 → 写） */
  turn(input: {
    readonly currentInput: string
    readonly sourceEventId: string
    readonly provider: GoalUnderstandingProvider
    readonly now: number
    readonly runtime: GoalUnderstandingRuntime
    /** 缺省 `ESTABLISHED` */
    readonly qualification?: 'ESTABLISHED' | 'UNCONFIRMED_ORIGIN'
    readonly withdrawnEventIds?: ReadonlySet<string>
    /*
     * **M10.1 / `L-M10.1-05`**：提议侧证据（她上一轮那条回复）。
     * ⚠️ 与 `main.ts` 的生产端口**同一条规则**：两件都齐才带 —— 缺一 ⇒ 一个都不带
     *    ⇒ 不提供提议侧证据（失败关闭）。夹具刻意**复制**这条规则而不是放宽它。
     */
    readonly lastAssistantEventId?: string
    readonly lastAssistantText?: string
  }): Promise<GoalTurnResult>
  /**
   * **直接**走"提案 → 放行口 → 写"（跳过语义理解）。
   *
   * ⚠️ 它存在的理由是**具体的**：`draftToProgramProposal` 给 `resume` 的缺省复核读数是
   *    `dropped: 1`（**刻意的失败关闭**，见 `C-24`）⇒ 走语义链的 resume 会被拒。
   *    要测"恢复这条**合法边**本身"，必须自己给出复核读数。
   *    这不是绕过放行口 —— 放行口**照样判**，只是提案由测试直接构造。
   */
  applyProposal(proposal: GoalProposal, now: number): Promise<{
    readonly accepted: boolean
    readonly rejectedCodes: readonly string[]
    readonly acceptedEventTypes: readonly string[]
    readonly eventsCommitted: number
    readonly rowsCommitted: number
  }>
  countEvents(): Promise<number>
  countRows(): Promise<number>
  listStates(): Promise<readonly GoalRowState[]>
  goalById(goalId: string): Promise<GoalRowState | undefined>
  /** 当前活动候选（**与放行口看到的是同一份状态**） */
  candidates(withdrawn?: ReadonlySet<string>): Promise<{
    readonly candidates: readonly { goalId: string; status: string; revision: number; statement: string }[]
    readonly goals: readonly GoalState[]
    readonly maskedCount: number
  }>
  readonly proposalOf: typeof goalProposalOf
}

/**
 * 建一个目标域的轮次装配。
 *
 * ⚠️ 调用方必须先 `isolateDatabase()` 并 `initDatabase()`，再把 `db` 传进来。
 */
export function createM10TurnHarness(options: {
  readonly db: RawDb
  readonly characterId: CharacterId
  readonly userId: string
  /** 候选标签（默认用 `statement`） */
  readonly labelOf?: (goal: GoalState) => string
}): M10TurnHarness {
  const { db, characterId, userId } = options
  const registry = createFullDomainEventRegistry()
  const processed = createProcessedOperationStore(db)
  const lookup = createGoalStateLookup(db)
  const labelOf = options.labelOf ?? ((goal: GoalState) => goal.statement)

  const statePort = {
    getGoal: (c: CharacterId, goalId: string) => lookup.getGoal(c, goalId as never),
    listGoals: (c: CharacterId) => lookup.listGoals(c),
  }

  /**
   * 放行口给的事件**原样**留在这里，供写入器用。
   *
   * ⚠️ 这是夹具的便利写法（产品装配里两者由同一个调用点串起来）。
   *    见 `L-M10-35`。
   */
  let lastAccepted: readonly unknown[] = []
  let lastAcceptedTypes: readonly string[] = []

  /**
   * 本轮**刚受理**的那些事件的幂等键。
   *
   * ⚠️ **这是本 harness 最关键的一处细节**（WP9-B 的长轨迹门抓到）：
   *    `applyGoalRows` 是**增量**折叠（它把已存在的行读进 cache，再把你给的
   *    **那一批**事件折上去）。把**全部历史**喂给它 ⇒ 每个事件被重复折一次
   *    ⇒ `goal.revision` **膨胀**。
   *
   *    实测：200 轮轨迹里 32 个事件、32 次 `applyGoalRows` ⇒ revision **487**
   *    （而全量重放只有 **32**）。**长轨迹门就是靠这个差异发现的**，
   *    而 `m10:e2e:verify` 当时**读不出**它 —— 因为它的检查里**没有一条看 revision**。
   *    ⇒ 教训有两层：① 增量写入口必须只喂**新事件**；
   *      ② 门要**至少有一条**检查盯着"会累积的那个字段"。
   */
  let lastAcceptedKeys: readonly string[] = []

  const passThrough: GoalTurnPorts['passThrough'] = {
    validate: async (proposal: GoalProposal) => {
      const outcome = await validateGoalProposal(
        {
          registry,
          processed,
          state: statePort as never,
          policy: { characterId, activeUserId: userId },
        },
        proposal,
      )
      lastAccepted = outcome.acceptedEvents
      lastAcceptedTypes = outcome.acceptedEvents.map((event) => event.type)
      lastAcceptedKeys = outcome.acceptedEvents.map((event) =>
        String((event as { idempotencyKey?: string }).idempotencyKey ?? ''),
      )
      return {
        accepted: outcome.accepted,
        rejectedCodes: outcome.rejected.map((r) => r.code),
        acceptedEventTypes: lastAcceptedTypes,
        acceptedEvents: outcome.acceptedEvents,
      }
    },
  }

  const commit = async (now: number): Promise<{ events: number; rows: number }> => {
    await applyAcceptedEvents(db, characterId, lastAccepted as never, [], now)
    const all = (await domainEventsFor(db, characterId)).filter((event) =>
      (GOAL_DOMAIN_EVENT_TYPES as readonly string[]).includes(event.type),
    )
    /*
     * ⚠️ **只把这一批新事件**交给增量折叠（见 `lastAcceptedKeys` 的注释）。
     *    事件必须按 sequence 升序 —— `domainEventsFor` 已保证。
     */
    const fresh = all.filter((event) =>
      lastAcceptedKeys.includes(String((event as { idempotencyKey?: string }).idempotencyKey ?? '')),
    )
    await applyGoalRows(db, characterId, fresh as readonly DomainEvent[], now)
    return { events: lastAccepted.length, rows: all.length }
  }

  const writer: GoalTurnPorts['writer'] = {
    commit: async ({ now }) => {
      const result = await commit(now)
      return { eventsCommitted: result.events, rowsCommitted: result.rows }
    },
  }

  const ports: GoalTurnPorts = {
    candidates: {
      readCandidates: async (c) => {
        const states = await listGoalStates(db, c as never)
        const built = candidatesFromGoals({
          goals: states.map((row) => row.goal),
          withdrawnEventIds: new Set<string>(),
          labelOf,
        })
        /* M10.1：兑现的生产者（与生产装配同一形状：只给**可见**目标的承诺） */
        return {
          ...built,
          commitments: commitmentSummariesOf({ rows: states, visible: built.goals }),
        }
      },
    },
    writer,
    passThrough,
    completion: {
      conversation: {
        findEvents: async (ids) =>
          ids.map((id) => ({
            id: String(id),
            characterId,
            actorType: 'user',
            qualification: 'ESTABLISHED' as const,
          })),
      },
      assistant: { findAssistantEvents: async () => [] },
      actions: { findActions: async () => [] },
    },
  }

  const statesOf = async (): Promise<readonly GoalRowState[]> => listGoalStates(db, characterId)

  return {
    characterId,
    ports,
    proposalOf: goalProposalOf,
    async turn(input) {
      return runGoalTurn(
        {
          characterId,
          currentInput: input.currentInput,
          sourceEventId: input.sourceEventId,
          sourceQualification: input.qualification ?? 'ESTABLISHED',
          withdrawnEventIds: input.withdrawnEventIds ?? new Set<string>(),
          now: input.now,
          provider: input.provider,
          runtime: input.runtime,
          ...(input.lastAssistantEventId === undefined || input.lastAssistantText === undefined
            ? {}
            : {
                lastAssistantEventId: input.lastAssistantEventId,
                lastAssistantText: input.lastAssistantText,
              }),
        },
        ports,
      )
    },
    async applyProposal(proposal, now) {
      const verdict = await passThrough.validate(proposal)
      if (!verdict.accepted) {
        return {
          accepted: false,
          rejectedCodes: verdict.rejectedCodes,
          acceptedEventTypes: [],
          eventsCommitted: 0,
          rowsCommitted: 0,
        }
      }
      const result = await commit(now)
      return {
        accepted: true,
        rejectedCodes: [],
        acceptedEventTypes: verdict.acceptedEventTypes,
        eventsCommitted: result.events,
        rowsCommitted: result.rows,
      }
    },
    async countEvents() {
      const stored = await domainEventsFor(db, characterId)
      return stored.filter((event) =>
        (GOAL_DOMAIN_EVENT_TYPES as readonly string[]).includes(event.type),
      ).length
    },
    async countRows() {
      return (await statesOf()).length
    },
    listStates: statesOf,
    async goalById(goalId) {
      return lookup.getGoal(characterId, goalId as never)
    },
    async candidates(withdrawn) {
      const states = await statesOf()
      return candidatesFromGoals({
        goals: states.map((row) => row.goal),
        withdrawnEventIds: withdrawn ?? new Set<string>(),
        labelOf,
      })
    },
  }
}

/** 离线固定 provider（**绝不出网**） */
export function fixedProvider(raw: unknown | (() => unknown) | 'throw'): GoalUnderstandingProvider {
  return {
    name: 'm10-fixed-provider',
    version: 'm10-fixed-provider@1',
    call: async () => {
      if (raw === 'throw') throw new Error('注入的 provider 抛错（离线负控）')
      return typeof raw === 'function' ? raw() : raw
    },
  }
}

/** 确定性 runtime：不调真实定时器 */
export function deterministicRuntime(): GoalUnderstandingRuntime {
  let clock = 1_000
  return { now: () => clock++, withDeadline: async (work) => ({ kind: 'ok', value: await work() }) }
}
