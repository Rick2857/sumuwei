/**
 * **S8 / ADR-094 `R-1.1`（口径 ①）+ `R-1.2`（接线形状）** —— 生产装配。
 *
 * ============================================================================
 *  它把四件已经实现并验过的东西装到一起
 * ============================================================================
 * ```text
 * 世界账本（WP2） + 独立水位（D03=A） + 生产入口（D02） + 消费回路（D03=A）
 *   ⇒ 一个"开关打开时才会构造、且**真的被调用**"的生产组件
 * ```
 *
 * ⚠️ **本文件的诚实边界（2026-10-04 修订：三个消费者**都已接通**，但"通了"≠"有东西可消费"）：
 * ```text
 * affect        ✅ 已按 R-1.2 接通（放行口 = validateAffectProposal；落库 = applyAcceptedEvents）
 * relationship   ✅ 已接通（`edfdb195`：放行口 = validateRelationshipProposal；两个 EntityRef）
 * reflection     ✅ 已接通（`7bde509e`：经 `R-3` 程序渲染器 → runReflectionWindow）
 * ```
 * ⚠️ **仍然成立的那半**：三个 step 都在 `consumeOnce()` 的 steps 数组里，但
 * **入口侧没有任何调用者**（`ingestChoice` 在生产里未被调用）⇒ `storyline_commits` 永远 0 行
 * ⇒ 消费回路每次都是"无可消费项"，水位停在 0。**那不是"没接线"，是"没有东西可消费"** ——
 * 立案见 `docs/post-lv2/S8-Consumption-Entry-Gap.md`（`L-S8-30`）。
 *
 * ⏩ **2026-10-07 修订（上面那半已过时；只追加，不改写原文）**：入口**已经存在** ——
 * ```text
 * 开局      src/main.ts:7316 → runStoryStartCommand（postlv2:s8:start:verify 守它）
 * 同轮选择  src/main.ts:3775-3778 → resolveDailyTurn（ADR-115）/ resolveChoiceTurn（ADR-107）
 *           → runStoryDailyTurn / runStoryChoiceTurn → commitStoryTurn
 * ```
 * · **直接**入口 `ingestChoice` 仍然没有调用者 —— 但它**不再是唯一入口**。
 * · 实测反证（隔离库 + 离线 fixture）：`pnpm postlv2:s8:daily:e2e` 断言 `storyline_commits`
 *   **恰好 3 行**（`STORY_STARTED` + 2×`CHOICE_COMMITTED`，choice `ask_scope` / `go_prepare`），
 *   且三个消费者水位 = 提交数。证据 `artifacts/post-lv2/s8-daily-e2e-20261007070734382/result.json`（`status: PASS`）。
 * · ⇒ "`storyline_commits` 永远 0 行"这句**已不成立**。仍**不主张**生产真实库已有行
 *   （真实库从未被打开）；`L-S8-30` 是否销账由维护线按读数裁定，**本注释不自行销账**。
 * 未消费的消费者**不推进水位**，因此不会"假装消费过"（`D13` 的至多一次仍然成立）。
 *
 * ⚠️ 依赖方向：本文件在 infrastructure，可以用 SQL 层；kernel 侧只给它纯契约。
 */

import type { CharacterId, Timestamp } from '../../kernel/contracts/ids.ts'
import { createFullDomainEventRegistry } from '../../kernel/contracts/domain-event.ts'
import { validateAffectProposal } from '../../kernel/policies/affect-validator.ts'
import { validateRelationshipProposal } from '../../kernel/policies/relationship-validator.ts'
import { affectReducerFor } from '../../kernel/projections/affect.ts'
import { relationshipReducerFor } from '../../kernel/projections/relationship.ts'
import {
  buildStoryAffectProposals,
  buildStoryRelationshipProposals,
} from '../../kernel/app/storyline/state-evaluators.ts'
import { consumeStoryCommits, type StoryConsumeOutcome } from '../../kernel/app/storyline/consumer-loop.ts'
import { ingestStoryChoice, type StoryIngestOutcome } from '../../kernel/app/storyline/choice-ingest.ts'
import {
  runStoryChoiceTurn,
  type StoryChoiceTurnOutcome,
} from '../../kernel/app/storyline/choice-turn.ts'
import type { StoryChoiceDecisionPort } from '../../kernel/app/storyline/choice-decision.ts'
import { cliStoryInteractionRef } from '../../kernel/app/storyline/run-lifecycle.ts'
import { runStoryDailyTurn, type StoryDailyTurnOutcome } from '../../kernel/app/storyline/daily-turn.ts'
import { worldObservationsOf } from '../../kernel/storyline/world-observation.ts'
import type { StoryContentPack } from '../../kernel/storyline/story-types.ts'
import { createStoryLedgerStore } from '../storyline/store/story-ledger-store.ts'
import { createStoryWatermarkStore } from '../storyline/store/story-watermark-store.ts'
import { entityRef } from '../../kernel/contracts/entity.ts'
import { getAffectProjection } from '../persistence/affect-store.ts'
import { getRelationshipProjection } from '../persistence/relationship-store.ts'
import { getDomainEvent } from '../persistence/event-store.ts'
import { applyAcceptedEvents } from '../persistence/event-store.ts'
import { hasProcessedOperation } from '../persistence/job-store.ts'
import type { RawDb } from '../persistence/db.ts'
import { runReflectionWindow } from './reflection-runner.ts'
import { latestDomainEventSequence } from '../persistence/reflection-input-source.ts'
import { renderStoryVisibleEvents, renderStoryDailyScene } from '../../content/storyline/jichuang-interview-two/render.ts'

export interface StoryCognitionOptions {
  readonly db: RawDb
  readonly characterId: CharacterId
  readonly pack: StoryContentPack
  readonly now: () => Timestamp
  /** 关系轴的当前用户（服务端给） */
  readonly userId: string
  /**
   * 反思消费要用的 provider —— **必填注入**（装配层不自己 new）。
   * 让"消费回路会不会发模型请求"成为显式决定；门注入离线件，生产注入真 provider。
   */
  readonly provider: unknown
  /** 反思窗口是否启用有限采纳（透传给 `runReflectionWindow`） */
  readonly adaptiveEnabled?: boolean
}

export interface StoryCognition {
  readonly enabled: true
  resolveDailyTurn(input: {
    readonly anchorConversationEventId: string
    readonly actorId: string
    readonly interactionRef: string
    readonly currentInput: string
    readonly recentLines: readonly string[]
    readonly decision?: { readonly port: StoryChoiceDecisionPort; readonly deadlineMs: number }
  }): Promise<StoryDailyTurnOutcome>
  ingestChoice(input: {
    readonly server: Parameters<typeof ingestStoryChoice>[0]['server']
    readonly proposedChoiceId: unknown
  }): Promise<StoryIngestOutcome>
  /** 跑一圈消费回路（受开关控制的调用方负责按调度调用它） */
  consumeOnce(): Promise<StoryConsumeOutcome>
  /**
   * **同轮"剧情选择解析"**（`ADR-107` `R-1b`）。
   *
   * ⚠️ 它是 `main.ts` 接触故事世界的**唯一**新入口 —— 刻意**不**让 `main.ts` 自己
   *    `createStoryLedgerStore()` / `import choice-turn`：那样会把故事账本的 SQL 适配器
   *    拉进 `main.ts` 的边界，而 `m3.5:test` 的 `FC-T04`（"世界/故事实现只允许住在
   *    具名模块边界内"，`ADR-091 §2`）**正是**在守这件事（它的负控用
   *    `src/main.ts` + `story-ledger-store.ts` 的合成依赖做反例）。
   *    ⇒ 让边界模块**多一个方法**，而不是让 `main.ts` 多两条依赖。
   *
   * ⚠️ `decision` 缺省 = **开关关**：`enabled:false` ⇒ 连端口都不碰，直接 `disabled`。
   */
  resolveChoiceTurn(input: {
    readonly anchorConversationEventId: string
    readonly actorId: string
    readonly currentInput: string
    readonly recentLines: readonly string[]
    readonly decision?: { readonly port: StoryChoiceDecisionPort; readonly deadlineMs: number }
  }): Promise<StoryChoiceTurnOutcome>
}

export function createStoryCognition(options: StoryCognitionOptions): StoryCognition {
  const { db, characterId, pack } = options
  const ledger = createStoryLedgerStore(db)
  const watermarks = createStoryWatermarkStore(db)

  /**
   * **affect** 的消费步骤 —— 与 `affect-scheduler.ts:184-203` 逐字同构：
   * 构造提案 → **过唯一放行口** → 放行后落事件 → 回路再推进水位。
   */
  const affectStep = {
    consumer: 'affect' as const,
    consume: async ({ commit, commits, at }: { commit: { revision: number; commitId: string }; commits: readonly never[]; at: Timestamp }) => {
      /*
       * ⚠️ 候选按 `StoryStateCandidate`（`{commit, anchorSequence}`）构造；
       *    `buildStoryAffectProposals` 内部会自己算 `variablesBefore`（`state-evaluators.ts:174`），
       *    **不要**在这里重复算一遍（第一版就是那么写的，签名根本没有那个参数）。
       * ⚠️ 提案里的 `unit` 不在提案顶层（它在 audit 里）⇒ 幂等靠放行口的 `processed`
       *    守卫（`hasProcessedOperation`），与 `affect-scheduler` 同一条路。
       */
      const proposals = buildStoryAffectProposals({
        characterId,
        candidates: (commits as readonly { commit: never; anchorSequence: number }[]).map((row) => ({
          commit: row.commit,
          anchorSequence: 1,
        })),
        commits: commits as never,
      })
      if (proposals.length === 0) return { ok: true as const }
      const deps = {
        registry: createFullDomainEventRegistry(),
        evidence: { findEvents: async () => [] },
        processed: { hasProcessed: (key: string) => hasProcessedOperation(db, key) },
        affect: { getAffectState: async (cid: CharacterId) => (await getAffectProjection(db, cid))?.state },
        policy: { activeUserId: '' },
      }
      for (const proposal of proposals) {
        const outcome = await validateAffectProposal(deps as never, proposal as never)
        /* ⚠️ 放行口拒收 ⇒ **不**落事件、**不**推进水位（回路见 `ok:false` 就停在这个消费者上） */
        if (!outcome.accepted) {
          return { ok: false as const, code: outcome.rejected[0]?.code ?? 'affect_rejected' }
        }
        await applyAcceptedEvents(db, characterId, outcome.acceptedEvents, [affectReducerFor(characterId)], at)
      }
      return { ok: true as const }
    },
  }

  /**
   * **relationship** 的消费步骤 —— 与 `adapters.ts:376-393` 的 deps 形状逐字同构。
   *
   * ⚠️ 两次实测教训写在这里，免得下次重踩：
   * ```text
   * ① `relationshipReducerFor(owner, target)` 要**两个** EntityRef（不是 1 个）——
   *    "Expected 2 arguments, but got 1" 就是它。
   * ② `events.getDomainEvent` 的 deps 形状是**包一层**：入参 `{toString()}`，出参 `{id, type}`。
   * ```
   */
  const relationshipStep = {
    consumer: 'relationship' as const,
    consume: async ({ commits, at }: { commits: readonly never[]; at: Timestamp }) => {
      const targetUserId = String(options.userId)
      const proposals = buildStoryRelationshipProposals({
        characterId,
        targetUserId,
        candidates: (commits as readonly { commit: never; anchorSequence: number }[]).map((row) => ({
          commit: row.commit,
          anchorSequence: 1,
        })),
        commits: commits as never,
      })
      if (proposals.length === 0) return { ok: true as const }
      const deps = {
        registry: createFullDomainEventRegistry(),
        evidence: { findEvents: async () => [] },
        processed: { hasProcessed: (key: string) => hasProcessedOperation(db, key) },
        relationships: {
          getRelationshipState: async (id: CharacterId, key: { target: string }) =>
            (await getRelationshipProjection(db, id, entityRef('user', key.target)))?.state,
        },
        events: {
          getDomainEvent: async (id: { toString(): string }) => {
            const event = await getDomainEvent(db, id as never)
            return event === undefined ? undefined : { id: event.id, type: event.type }
          },
        },
        policy: { activeUserId: targetUserId },
      }
      for (const proposal of proposals) {
        const outcome = await validateRelationshipProposal(deps as never, proposal as never)
        if (!outcome.accepted) {
          return { ok: false as const, code: outcome.rejected[0]?.code ?? 'relationship_rejected' }
        }
        await applyAcceptedEvents(
          db,
          characterId,
          outcome.acceptedEvents,
          [
            relationshipReducerFor(
              entityRef('character', String(characterId)),
              entityRef('user', targetUserId)
            ),
          ],
          at
        )
      }
      return { ok: true as const }
    },
  }

  /**
   * **reflection** 的消费步骤（`ADR-094 R-3` 的渲染器 + `ADR-093 D10`）。
   *
   * ```text
   * 每条提交 ⇒ 用**渲染器**把 newVisibleEvents 变成正文 ⇒ ReflectionStoryOutcome[]
   *          ⇒ runReflectionWindow（它自带至多一次保护：input fingerprint）
   * ```
   *
   * ⚠️ **provider 是必填注入**（`StoryCognitionOptions.provider`）：装配层**不**自己 new 一个 ——
   *    这样"消费回路里到底会不会发模型请求"是一个**显式**决定，而不是藏在默认值里。
   *    门注入离线固定件；生产 `main.ts` 注入真 provider。
   * ⚠️ `watermark` 取**当前**领域事件序号 ⇒ 这一轮窗口只含**故事**条目，
   *    **不**把历史对话事件重新拉进来（对话驱动的反思仍归既有调度器，各有各的水位）。
   */
  const reflectionStep = {
    consumer: 'reflection' as const,
    consume: async ({ commits, at }: { commits: readonly never[]; at: Timestamp }) => {
      const outcomes = (
        commits as readonly {
          commitId: string
          revision: number
          eventType: string
          newVisibleEvents?: readonly string[]
        }[]
      ).map((commit) => ({
        commitId: commit.commitId,
        revision: commit.revision,
        eventType: commit.eventType,
        /* ⚠️ 正文**只能**来自内容资产的渲染器（`R-3`）；未知 id 抛错，不回退占位符 */
        text: renderStoryVisibleEvents(commit.newVisibleEvents ?? []),
      }))
      if (outcomes.length === 0) return { ok: true as const }
      const watermark = await latestDomainEventSequence(db, characterId)
      const outcome = await runReflectionWindow(db, {
        characterId,
        activeUserId: String(options.userId),
        adaptiveEnabled: options.adaptiveEnabled,
        provider: options.provider,
        watermark,
        storyOutcomes: outcomes,
        now: () => at,
      } as never)
      if (outcome.kind !== 'accepted' && outcome.kind !== 'no_trigger') {
        return { ok: false as const, code: `reflection_${outcome.kind}` }
      }
      return { ok: true as const }
    },
  }

  return {
    enabled: true,
    resolveDailyTurn: async (input) => await runStoryDailyTurn({
      enabled: input.decision !== undefined, ledger, pack,
      dailyRunId: `daily-v${pack.storyVersion}-${String(characterId).replace(/-/g, '')}`,
      server: { runId: '', expectedRevision: 0, actorId: input.actorId,
        interactionRef: input.interactionRef, anchorConversationEventId: input.anchorConversationEventId },
      currentInput: input.currentInput, recentLines: input.recentLines,
      narrativeOf: (state) => renderStoryDailyScene(state, pack.nodes.find(node => node.id === state.currentNodeId)?.choices ?? []),
      observationsOf: (state) => {
        const notes = worldObservationsOf({ state, renderText: (id) => renderStoryVisibleEvents([id]) })
        // 每条经历保留自己的来源；只在当前可见条目附上未发生的候选。
        return notes.map((note, index) => index !== notes.length - 1 ? note : {
          ...note, text: renderStoryDailyScene({ ...state, visibleEventIds: [note.eventId] },
            pack.nodes.find(node => node.id === state.currentNodeId)?.choices ?? []),
        })
      },
      ...(input.decision === undefined ? {} : { port: input.decision.port }),
      deadlineMs: input.decision?.deadlineMs ?? 8000, now: options.now(),
    }),
    ingestChoice: (input) =>
      ingestStoryChoice({
        enabled: true,
        ledger,
        pack,
        server: input.server,
        proposedChoiceId: input.proposedChoiceId,
        now: options.now(),
      }),
    /*
     * **同轮选择解析**（`ADR-107` `R-1b`）：账本与内容包都在本模块的闭包里，
     * 正文用**内容资产的渲染器**（`R-3`）现算 ⇒ `main.ts` 只多一句调用，不多一条故事依赖。
     */
    resolveChoiceTurn: async (input) =>
      await runStoryChoiceTurn({
        /* ⚠️ 没有端口 = 开关关（"没启用"与"装配漏了"是两件事，见 `choice-turn.ts` 的 ④） */
        enabled: input.decision !== undefined,
        ledger,
        pack,
        server: {
          runId: '',
          anchorConversationEventId: input.anchorConversationEventId,
          /*
           * ⚠️ 会话引用在**这里**拼（而不是让 `main.ts` 拼好传进来）：
           *    它是"谁是真实会话"这件事的**服务端判定**，且 `main.ts` 不许 import
           *    故事边界模块（`m3.5:test` 的 `FC-T04`）。见 `cliStoryInteractionRef` 的边界注释。
           */
          interactionRef: cliStoryInteractionRef(input.actorId),
          actorId: input.actorId,
          expectedRevision: 0,
        },
        currentInput: input.currentInput,
        recentLines: input.recentLines,
        narrativeOf: (state) => renderStoryVisibleEvents(state.visibleEventIds),
        ...(input.decision === undefined
          ? {}
          : { port: input.decision.port, deadlineMs: input.decision.deadlineMs }),
        now: options.now(),
      }),
    consumeOnce: async () => {
      /*
       * ⚠️ **不写死 runId**（`L-S8-28` 的修复）：第一版硬编码 `'main'` ⇒
       *    只要真实 run 叫别的名字，`listCommits` 就返回空 ⇒ 两个消费者都"跑到底"
       *    却一条都没消费（水位停在 0）。那种失败与"规则没触发"在读数上几乎一样。
       *    ⇒ 改为**遍历该故事账本里的全部已知 run**（`listRuns`），各 run 各有自己的水位。
       */
      const runs = await ledger.listRuns(pack.storyId)
      if (runs.length === 0) {
        return { progress: [], drained: true }
      }
      const outcomes = []
      for (const runId of runs) {
        outcomes.push(
          await consumeStoryCommits({
            ledger,
            watermarks,
            storyId: pack.storyId,
            runId,
        /*
         * ⚠️ **2026-10-04 修订：三个消费者都在这条数组里**（affect `R-1.2` · relationship `edfdb195` ·
         *    reflection `7bde509e`）。数组本身不再是"只接 affect"——那是本条注释的旧文。
         * ⚠️ 真正让水位停在 0 的不是这里，而是**入口侧没有调用者**（`ingestChoice` 在生产里未被调用
         *    ⇒ `storyline_commits` 永远 0 行）—— 见 `docs/post-lv2/S8-Consumption-Entry-Gap.md`（`L-S8-30`）。
         *    ⏩ **2026-10-07**：这半已过时（入口 = `main.ts:3775-3778` 的
         *    `resolveDailyTurn` / `resolveChoiceTurn`，开局 = `main.ts:7316`）；`postlv2:s8:daily:e2e`
         *    在隔离库里实测 `storyline_commits` 恰好 3 行。详见本文件顶部的 ⏩ 修订段。
         */
            steps: [affectStep as never, relationshipStep as never, reflectionStep as never],
            now: options.now,
          })
        )
      }
      const progress = outcomes.flatMap((outcome) => outcome.progress)
      return { progress, drained: outcomes.every((outcome) => outcome.drained) }
    },
  }
}
