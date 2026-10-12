/**
 * SC-007 Telemetry Failure —— Phoenix 不可用时，苏沐薇必须照常说话。
 *
 * ============================================================================
 *  为什么这条是不可谈判的
 * ============================================================================
 * 观测系统出问题的方式通常不是"崩了"，而是"变慢"或"偶发超时"。
 * 如果它跑在聊天主链上，用户会看到的是**她开始不回话**——
 * 而真正的原因在一个跟角色毫无关系的地方（收集器重启、磁盘满、网络抖动）。
 *
 * plan 第 49 节把这条写成硬规则：
 *
 *     Telemetry unavailable ≠ Character unavailable
 *
 * 本场景用**指向必然失败的端口**（127.0.0.1:1）的 Phoenix 适配器来验证：
 *   1. 对话照常完成，回复不是空的
 *   2. 事件、投影、trace 全部照常写入（证据不依赖遥测）
 *   3. 导出确实失败过（否则这个场景什么都没测到）
 *   4. 遥测失败**没有**污染 trace 的 error 字段
 *      （trace.error 只应该记 Slow Path 的问题，不该记遥测的问题）
 */

import { runScenario, type Scenario } from '../harness/runner.ts'
import { getTrace } from '../../src/infrastructure/persistence/trace-store.ts'
import { asTraceId } from '../../src/kernel/contracts/index.ts'

export const SC_007: Scenario = {
  id: 'SC-007',
  description: 'Phoenix 离线时角色仍能正常聊天，且事实/状态/证据全部照常落库',
  initial_state: { freshCharacter: true },
  tags: ['telemetry', 'resilience'],
  version: 1,
  turns: ['喂，你在吗。', '刚才好像有点卡。'],
  assertions: [
    {
      id: 'G1-chat-still-works',
      description: 'Phoenix 不可达时，两轮对话都必须正常产出回复',
      check: (run) => {
        if (run.replies.length !== 2) throw new Error(`预期 2 条回复，实际 ${run.replies.length}`)
        for (const [index, reply] of run.replies.entries()) {
          if (reply.trim() === '') throw new Error(`第 ${index + 1} 轮回复为空（遥测拖垮了主链？）`)
        }
      },
    },
    {
      id: 'G2-evidence-unaffected',
      description: '事实账本、领域事件、投影都照常写入（证据不依赖遥测）',
      check: (run, ctx) => {
        if (ctx.agent.conversationEvents.length !== 4) {
          throw new Error(`预期 4 条对话事件，实际 ${ctx.agent.conversationEvents.length}`)
        }
        if (run.domainEvents.length !== 2) {
          throw new Error(`预期 2 条领域事件，实际 ${run.domainEvents.length}`)
        }
        const lastRevision = run.projectionRevisions[run.projectionRevisions.length - 1]
        if (lastRevision < 2) {
          throw new Error(`投影 revision 只到 ${lastRevision}，说明折叠没跑（遥测拖垮了慢路径？）`)
        }
      },
    },
    {
      id: 'G3-export-actually-failed',
      description: '导出确实尝试过并失败过（否则场景无效）',
      check: (_run, ctx) => {
        const summary = ctx.agent.telemetryRecorder.exportSummary()
        if (summary.attempts === 0) {
          throw new Error('没有任何导出尝试：遥测没有真的被触发，本场景无效')
        }
        if (summary.failures === 0) {
          throw new Error('导出全部成功：本场景需要的是"后端不可用"的处境')
        }
      },
    },
    {
      id: 'G4-trace-error-not-polluted',
      description: 'trace.error 不得记录遥测故障（只记 Slow Path 的问题）',
      check: async (_run, ctx) => {
        const traces = await ctx.kernel.stores.traceWriter.recent(ctx.characterId, 10)
        if (traces.length === 0) throw new Error('没有任何 trace')

        for (const trace of traces) {
          if (trace.error && /telemetry|phoenix|fetch|ECONN|abort/i.test(trace.error)) {
            throw new Error(`遥测故障污染了 trace.error：${trace.error}`)
          }
          if (trace.status !== 'completed') {
            throw new Error(`trace ${trace.traceId} 状态是 ${trace.status}`)
          }
        }
      },
    },
    {
      id: 'G5-noop-path-also-works',
      description: '显式关闭遥测时行为必须与开启失败时一致（都不影响业务）',
      check: async (_run, ctx) => {
        // 直接验证 Noop 适配器：它必须是一个"什么都不做但一切正常"的实现
        const { createNoopTelemetry } = await import('../../src/infrastructure/telemetry/port.ts')
        const noop = createNoopTelemetry()
        if (noop.name !== 'noop') throw new Error(`Noop 适配器名字不对：${noop.name}`)
        const handle = noop.startTrace({
          traceId: asTraceId('trc:test'),
          characterId: ctx.characterId,
          inputEventId: ctx.agent.conversationEvents[0].id,
          // M3：身份快照字段是必填的（每一轮都要能查到"用了哪版人格"）
          identitySourceRefs: ['character-definition:test@1'],
          contextSectionIds: [],
          droppedSectionIds: [],
          sourceConversationEventIds: [],
          selectedMemoryIds: [],
          projectionRevisionsAtStart: {},
          projectionRevisionsAtEnd: {},
          domainEventIds: [],
          actionIds: [],
          postTurnJobIds: [],
          processorVersions: {},
          steps: [],
          status: 'running',
          startedAt: Date.now(),
        })
        handle.end() // 不该抛
        handle.error('x') // 不该抛
        await noop.finish({} as never) // 不该抛
        await noop.shutdown()
        if (noop.exports().length !== 0) throw new Error('Noop 不该产生导出记录')
      },
    },
    {
      id: 'G6-trace-persisted-despite-telemetry',
      description: 'Trace 是业务数据：遥测挂了，character_traces 里仍然完整',
      check: async (_run, ctx) => {
        const traces = await ctx.kernel.stores.traceWriter.recent(ctx.characterId, 10)
        for (const trace of traces) {
          const reloaded = await getTrace(ctx.kernel.stores.db, trace.traceId)
          if (!reloaded) throw new Error(`trace ${trace.traceId} 读不回来`)
          if (reloaded.contextCompilerVersion === undefined) {
            throw new Error('trace 丢了 Context 版本（遥测挂了不该影响业务字段）')
          }
        }
      },
    },
  ],
}

export default SC_007
