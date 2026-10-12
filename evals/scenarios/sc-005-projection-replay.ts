/**
 * SC-005 Projection Replay —— 删掉当前状态，重新算一遍，必须一模一样。
 *
 * ============================================================================
 *  这条是"Projection 是缓存而不是事实本体"的唯一可执行证明
 * ============================================================================
 * 如果删掉投影就再也算不回来，说明某个地方把**状态本身**当成了真相：
 *   · 可能有人在 reducer 之外改过状态
 *   · 可能 reducer 有副作用（读时间、随机、写库）
 *   · 可能事件没有被完整记录
 *
 * 三种情况都会让"她的过去"变成不可复现的黑箱。所以这条必须硬性通过。
 *
 * 检查点：
 *   1. 删掉投影 → rebuild → 状态与 revision 与删除前完全一致
 *   2. 反复 rebuild 结果稳定（幂等）
 *   3. reducer 记录的最后事件序号 = 领域事件最大序号（没有漏折叠）
 */

import { runScenario, type Scenario } from '../harness/runner.ts'
import { rebuildDiagnostic } from '../harness/runner.ts'
import {
  deleteProjection,
  domainEventsFor,
  getProjection,
} from '../../src/infrastructure/persistence/event-store.ts'
import { DIAGNOSTIC_PROJECTION_TYPE } from '../../src/kernel/projections/diagnostic.ts'

export const SC_005: Scenario = {
  id: 'SC-005',
  description: '删除 Projection 后 replay 重建，得到与删除前完全相同的状态',
  initial_state: { freshCharacter: true },
  tags: ['replay', 'projection', 'event-sourcing'],
  version: 1,
  turns: ['今天天气不错。', '你在做什么。', '我有点想你了。'],
  assertions: [
    {
      id: 'E1-rebuild-identical',
      description: 'rebuild 后的 state 与 revision 必须与删除前一致',
      check: async (_run, ctx) => {
        const before = await getProjection<{ counter: number; payloadBytes: number }>(
          ctx.kernel.stores.db,
          ctx.characterId,
          DIAGNOSTIC_PROJECTION_TYPE
        )
        if (!before) throw new Error('投影不存在：正常对话应该已经折叠出投影')

        const deleted = await deleteProjection(
          ctx.kernel.stores.db,
          ctx.characterId,
          DIAGNOSTIC_PROJECTION_TYPE
        )
        if (deleted !== 1) throw new Error(`删除投影影响了 ${deleted} 行（预期 1）`)

        const rebuilt = await rebuildDiagnostic(ctx.kernel)
        if (rebuilt.revision !== before.revision) {
          throw new Error(`rebuild 后 revision 不同：${before.revision} → ${rebuilt.revision}`)
        }
        if (rebuilt.counter !== (before.state as { counter: number }).counter) {
          throw new Error(
            `rebuild 后 counter 不同：${(before.state as { counter: number }).counter} → ${rebuilt.counter}`
          )
        }
      },
    },
    {
      id: 'E2-rebuild-is-idempotent',
      description: '连续 rebuild 三次结果完全稳定',
      check: async (_run, ctx) => {
        const first = await rebuildDiagnostic(ctx.kernel)
        const second = await rebuildDiagnostic(ctx.kernel)
        const third = await rebuildDiagnostic(ctx.kernel)
        if (JSON.stringify(first) !== JSON.stringify(second)) {
          throw new Error(`第一次与第二次 rebuild 结果不同：${JSON.stringify([first, second])}`)
        }
        if (JSON.stringify(second) !== JSON.stringify(third)) {
          throw new Error('第三次 rebuild 与第二次不同：reducer 不是确定性的')
        }
      },
    },
    {
      id: 'E3-rebuild-consumed-all-events',
      description: '重建时消费的事件数 = 领域事件总数，最后一个序号也对得上',
      check: async (_run, ctx) => {
        const events = await domainEventsFor(ctx.kernel.stores.db, ctx.characterId)
        const projection = await getProjection<{ counter: number }>(
          ctx.kernel.stores.db,
          ctx.characterId,
          DIAGNOSTIC_PROJECTION_TYPE
        )
        if (!projection) throw new Error('投影不存在')

        if (projection.revision !== events.length) {
          throw new Error(
            `投影 revision=${projection.revision} 与领域事件数 ${events.length} 不一致（有事件没被折叠）`
          )
        }
        const maxSequence = events.reduce((max, e) => Math.max(max, e.sequence), 0)
        if (projection.lastDomainEventSequence !== maxSequence) {
          throw new Error(
            `投影记录的最后一个序号是 ${String(projection.lastDomainEventSequence)}，` +
              `实际最大是 ${maxSequence}`
          )
        }
      },
    },
    {
      id: 'E4-reducer-version-recorded',
      description: '投影必须记录算出它的 reducer 版本（否则改了算法无从追溯）',
      check: async (_run, ctx) => {
        const projection = await getProjection<{ counter: number }>(
          ctx.kernel.stores.db,
          ctx.characterId,
          DIAGNOSTIC_PROJECTION_TYPE
        )
        if (!projection) throw new Error('投影不存在')
        if (!projection.reducerVersion.includes('@')) {
          throw new Error(`reducerVersion 格式不对：${projection.reducerVersion}`)
        }
        if (projection.reducerVersion !== ctx.kernel.diagnosticReducer.version) {
          throw new Error('投影记录的 reducer 版本与当前注册的版本不一致')
        }
      },
    },
  ],
}

export default SC_005
