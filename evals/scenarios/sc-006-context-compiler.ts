/**
 * SC-006 Context Compiler —— 主角色调用不得存在绕过编译器的路径。
 *
 * ============================================================================
 *  这条是"可解释性"的守门人
 * ============================================================================
 * 只要存在一条 `systemPrompt += memory` 的旁路，Trace 立刻失去意义：
 * 你会看到"这一轮用了 3 个 section"，而实际上模型还看到了别的 2000 字。
 *
 * 因此本场景检查的是**结构性事实**，而不是某次输出：
 *   1. 每一轮都必须产出 ContextPacket，且带 compilerVersion
 *   2. section id 必须落在受控清单里（说明它经过注册，不是随手加的）
 *   3. 每一轮的 trace 都能定位到：输入事件 / Context 版本 / 输出事件
 *   4. Seed 与当前输入这两块**永远不被裁掉**
 */

import { IDENTITY_SECTION_IDS, runScenario, type Scenario } from '../harness/runner.ts'
import { recentConversationEvents } from '../../src/infrastructure/persistence/conversation-store.ts'
import { getTrace } from '../../src/infrastructure/persistence/trace-store.ts'
import { asTraceId } from '../../src/kernel/contracts/index.ts'
import { SECTION_IDS } from '../../src/kernel/context/sections.ts'

const ALLOWED_SECTIONS = new Set(Object.values(SECTION_IDS))

export const SC_006: Scenario = {
  id: 'SC-006',
  description: '每次主角色调用都经过 ContextCompiler，且能定位输入事件 / Context 版本 / 输出事件',
  initial_state: { freshCharacter: true },
  tags: ['context', 'traceability'],
  version: 1,
  turns: ['早上好。', '我昨天没睡好。'],
  assertions: [
    {
      id: 'F1-every-turn-has-packet',
      description: '每一轮都有带 compilerVersion 的 ContextPacket',
      check: (run) => {
        if (run.packets.length !== 2) throw new Error(`预期 2 个 packet，实际 ${run.packets.length}`)
        for (const [index, packet] of run.packets.entries()) {
          if (!packet.compilerVersion.startsWith('context-compiler@')) {
            throw new Error(`第 ${index + 1} 轮的编译器版本不合法：${packet.compilerVersion}`)
          }
          if (packet.sections.length === 0) {
            throw new Error(`第 ${index + 1} 轮的 packet 没有任何 section`)
          }
          if (packet.estimatedTokens <= 0) {
            throw new Error(`第 ${index + 1} 轮的 token 估算为 0（量化器没生效）`)
          }
        }
      },
    },
    {
      id: 'F2-sections-are-registered',
      description: '出现的 section id 必须在注册清单里',
      check: (run) => {
        for (const packet of run.packets) {
          for (const section of packet.sections) {
            if (!ALLOWED_SECTIONS.has(section.id as (typeof SECTION_IDS)[keyof typeof SECTION_IDS])) {
              throw new Error(
                `出现了未注册的 section id：${section.id}（说明有人绕过 section 机制直接往 prompt 里塞东西）`
              )
            }
          }
        }
      },
    },
    {
      id: 'F3-required-sections-never-dropped',
      description: '身份 section 与 current-input 永远不被裁掉',
      check: (run) => {
        for (const [index, packet] of run.packets.entries()) {
          const ids = packet.sections.map((s) => s.id)
          // M3：身份锚点的 id 变成 identity-core（v1 编译器仍用 seed-identity）。
          // 这条断言检的是"锚点必须在且不可裁"，所以两个 id 都算数。
          const identityId = IDENTITY_SECTION_IDS.find((id) => ids.includes(id))
          if (!identityId) {
            throw new Error(
              `第 ${index + 1} 轮缺少身份 section（identity-core / seed-identity 都不在）`
            )
          }
          if (!ids.includes(SECTION_IDS.currentInput)) {
            throw new Error(`第 ${index + 1} 轮缺少 current-input`)
          }
          for (const required of [identityId, SECTION_IDS.currentInput]) {
            if (packet.droppedSectionIds.includes(required)) {
              throw new Error(`第 ${index + 1} 轮把 ${required} 裁掉了`)
            }
          }
        }
      },
    },
    {
      id: 'F4-prompt-contains-packet-text',
      description: 'prompt 必须由 packet 组装（而非另一条拼接路径）',
      check: (run) => {
        for (const [index, turn] of run.packets.entries()) {
          const prompt = run.prompts[index]
          // packet.text 是唯一的变量内容来源：它必须原样出现在 prompt 里
          if (!prompt.includes(turn.text)) {
            throw new Error(
              `第 ${index + 1} 轮的 prompt 里找不到 packet.text（说明存在第二条拼接路径）`
            )
          }
        }
      },
    },
    {
      id: 'F5-trace-locates-everything',
      description: '每轮 trace 都能定位输入事件、Context 版本、输出事件',
      check: async (_run, ctx) => {
        const events = await recentConversationEvents(ctx.kernel.stores.db, {
          characterId: ctx.characterId,
          conversationId: ctx.conversationId,
          limit: 50,
        })
        const assistantEvents = events.filter((e) => e.actorType === 'character')
        if (assistantEvents.length !== 2) {
          throw new Error(`预期 2 条助手事件，实际 ${assistantEvents.length}`)
        }

        for (const event of assistantEvents) {
          const traceId = event.metadata?.traceId
          if (typeof traceId !== 'string') {
            throw new Error(`助手事件 ${event.id} 没有记录 traceId`)
          }
          const trace = await getTrace(ctx.kernel.stores.db, asTraceId(traceId))
          if (!trace) throw new Error(`trace ${traceId} 不存在`)
          if (trace.status !== 'completed') {
            throw new Error(`trace ${traceId} 状态是 ${trace.status}`)
          }
          if (!trace.contextCompilerVersion?.startsWith('context-compiler@')) {
            throw new Error(`trace ${traceId} 没有记录 Context 编译器版本`)
          }
          if (trace.contextSectionIds.length === 0) {
            throw new Error(`trace ${traceId} 没有记录任何 section`)
          }
          if (String(trace.inputEventId).startsWith('cev:dry-run')) {
            throw new Error(`trace ${traceId} 的输入事件是占位 id（说明没接上真实事件）`)
          }
          if (!trace.outputEventId) {
            throw new Error(`trace ${traceId} 没有记录输出事件`)
          }
          if (trace.projectionRevisionsAtStart === undefined) {
            throw new Error(`trace ${traceId} 没有记录起始投影版本`)
          }
        }
      },
    },
  ],
}

export default SC_006
