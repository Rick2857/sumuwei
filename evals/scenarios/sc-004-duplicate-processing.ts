/**
 * SC-004 Duplicate Processing —— 同一件事被处理两次，副作用只能有一次。
 *
 * ============================================================================
 *  为什么这不是理论问题
 * ============================================================================
 * 后台任务一定会重跑：网络断开、进程被杀、用户重开窗口、定时任务重叠。
 * 每一次重跑都可能拿到**同一批证据**。
 *
 * 如果重跑会再写一条"她经历了一次这件事"，那么：
 *   · 关系分会被重复加（一天之内 trust 涨到顶）
 *   · 记忆会出现两条一字不差的副本
 *   · 反思会看到"多次证据"（其实是同一次）
 *
 * 所以幂等必须在**三个层次**同时成立，本场景逐层验证：
 *   1. 事实层：同一个会话内序号重复写入 = 幂等命中，不产生第二行
 *   2. 提案层：同一 (processor, version, 事件范围, 操作) 的幂等键稳定，
 *      Validator 见到已处理过的键会拒绝
 *   3. 投影层：重复处理 domain event 不会让计数变成 2
 */

import { runScenario, type Scenario } from '../harness/runner.ts'
import { hasProcessedOperation } from '../../src/infrastructure/persistence/job-store.ts'
import {
  appendConversationEvent,
  countConversationEvents,
} from '../../src/infrastructure/persistence/conversation-store.ts'
import { rebuildDiagnostic, runDiagnosticProcessor } from '../harness/runner.ts'
import {
  asConversationId,
  createProposal,
  idempotencyKeyFor,
} from '../../src/kernel/contracts/index.ts'
import { DIAGNOSTIC_PROCESSOR_NAME, DIAGNOSTIC_PROCESSOR_VERSION } from '../../src/kernel/app/turn-gateway.ts'

export const SC_004: Scenario = {
  id: 'SC-004',
  description: '重复处理同一批证据：事实层 / 提案层 / 投影层都只能生效一次',
  initial_state: { freshCharacter: true },
  tags: ['idempotency', 'reliability'],
  version: 1,
  turns: ['我下周要搬家。'],
  assertions: [
    {
      id: 'D1-conversation-event-idempotent',
      description: '同一会话内序号重复写入不得产生第二行',
      check: async (_run, ctx) => {
        const before = await countConversationEvents(ctx.kernel.stores.db, ctx.characterId)
        const userEvent = ctx.agent.conversationEvents[0]

        const again = await appendConversationEvent(ctx.kernel.stores.db, {
          characterId: ctx.characterId,
          conversationId: ctx.conversationId,
          conversationSequence: userEvent.conversationSequence,
          type: 'user_message',
          actorType: 'user',
          actorId: 'Alex',
          content: '我下周要搬家。',
        })

        if (again.appended) throw new Error('重复写入被当成了新事件')
        if (String(again.event.id) !== String(userEvent.id)) {
          throw new Error(`幂等命中却返回了不同的事件 id：${String(again.event.id)}`)
        }

        const after = await countConversationEvents(ctx.kernel.stores.db, ctx.characterId)
        if (after !== before) {
          throw new Error(`事件总数从 ${before} 变成了 ${after}（产生了重复行）`)
        }
      },
    },
    {
      id: 'D2-idempotency-key-stable',
      description: '同一批证据 + 同一 Processor + 同一版本 ⇒ 幂等键完全相同',
      check: async (_run, ctx) => {
        const userEvent = ctx.agent.conversationEvents.find((e) => e.actorType === 'user')!
        const make = () =>
          createProposal({
            characterId: ctx.characterId,
            proposalType: 'diagnostic-signal',
            sourceConversationEventIds: [userEvent.id],
            payload: { note: 'x' },
            targetEvents: [
              { type: 'TEST_CHARACTER_SIGNAL', operation: 'signal', payload: { counterDelta: 1 } },
            ],
            processor: DIAGNOSTIC_PROCESSOR_NAME,
            processorVersion: DIAGNOSTIC_PROCESSOR_VERSION,
          })

        const a = idempotencyKeyFor(make())[0]
        const b = idempotencyKeyFor(make())[0]
        if (a !== b) throw new Error(`两次计算的幂等键不同：${a} vs ${b}`)

        // 换了 Processor 版本就必须是**新的**键（否则 Prompt 改了也重跑不了）
        const versioned = idempotencyKeyFor(
          createProposal({
            characterId: ctx.characterId,
            proposalType: 'diagnostic-signal',
            sourceConversationEventIds: [userEvent.id],
            payload: { note: 'x' },
            targetEvents: [
              { type: 'TEST_CHARACTER_SIGNAL', operation: 'signal', payload: { counterDelta: 1 } },
            ],
            processor: DIAGNOSTIC_PROCESSOR_NAME,
            processorVersion: `${DIAGNOSTIC_PROCESSOR_VERSION}-next`,
          })
        )[0]
        if (versioned === a) {
          throw new Error('processorVersion 没有进幂等键：改版本后无法重新处理')
        }
      },
    },
    {
      id: 'D3-validator-rejects-processed-key',
      description: 'Validator 见到已处理过的幂等键必须拒绝（duplicate_operation）',
      check: async (_run, ctx) => {
        const userEvent = ctx.agent.conversationEvents.find((e) => e.actorType === 'user')!
        const proposal = createProposal({
          characterId: ctx.characterId,
          proposalType: 'diagnostic-signal',
          sourceConversationEventIds: [userEvent.id],
          payload: { note: '重放' },
          targetEvents: [
            { type: 'TEST_CHARACTER_SIGNAL', operation: 'signal', payload: { counterDelta: 1 } },
          ],
          processor: DIAGNOSTIC_PROCESSOR_NAME,
          processorVersion: DIAGNOSTIC_PROCESSOR_VERSION,
        })

        // 这个键在第一轮真实对话里已经被用掉了
        const key = idempotencyKeyFor(proposal)[0]
        const processed = await hasProcessedOperation(ctx.kernel.stores.db, key)
        if (!processed) {
          throw new Error(`幂等键 ${key} 没有被登记（正常对话应该已经登记过）`)
        }

        const outcome = await ctx.kernel.validator.validate(proposal)
        if (outcome.accepted) throw new Error('Validator 放行了已经处理过的操作')
        if (outcome.rejected[0]?.code !== 'duplicate_operation') {
          throw new Error(`拒绝码应为 duplicate_operation，实际 ${outcome.rejected[0]?.code}`)
        }
      },
    },
    {
      id: 'D4-processor-rerun-no-duplicate-effect',
      description: '重跑同一个 Processor 不产生新领域事件，投影计数不变',
      check: async (_run, ctx) => {
        const before = await rebuildDiagnostic(ctx.kernel)
        const userEvent = ctx.agent.conversationEvents.find((e) => e.actorType === 'user')!

        const result = await runDiagnosticProcessor({
          characterId: ctx.characterId,
          events: [userEvent],
          kernel: ctx.kernel,
        })
        if (result.domainEventIds.length > 0) {
          throw new Error('重跑产生了新的领域事件（幂等被破坏）')
        }

        const after = await rebuildDiagnostic(ctx.kernel)
        if (after.counter !== before.counter) {
          throw new Error(`投影被重复折叠：${before.counter} → ${after.counter}`)
        }
      },
    },
    {
      id: 'D5-domain-event-count-matches-user-turns',
      description: '整个场景跑完，领域事件数 = 用户轮次（不多不少）',
      check: (run, ctx) => {
        const userTurns = ctx.agent.conversationEvents.filter(
          (e) => e.actorType === 'user'
        ).length
        if (run.domainEvents.length !== userTurns) {
          throw new Error(
            `领域事件数 ${run.domainEvents.length} 与用户轮次数 ${userTurns} 不一致` +
              '（要么漏了，要么重复了）'
          )
        }
        const keys = run.domainEvents.map((e) => e.idempotencyKey)
        if (new Set(keys).size !== keys.length) {
          throw new Error('领域事件里出现重复的幂等键')
        }
      },
    },
  ],
}

export default SC_004
