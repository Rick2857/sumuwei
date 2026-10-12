/**
 * SC-003 Event Order —— 快速连续发消息，序号必须严格正确。
 *
 * ============================================================================
 *  为什么"序号"值得单独一个场景
 * ============================================================================
 * 序号是后面一切的地基：
 *   · Watermark（我处理到哪了）
 *   · 乱序 Worker 判定（这条是不是过时了）
 *   · Replay（按什么顺序折叠）
 *   · Rollup（哪一段对话已经被压缩过）
 *
 * 只要它出现重复或回退，"她的一段经历被覆盖"就是静默发生的 ——
 * 事后完全查不出来。所以这里刻意用**并发**发消息来压它。
 *
 * 同时验证：`SELECT MAX(sequence)+1` 这种写法在并发下必然出问题，
 * 而 `on conflict do update ... returning` 不会。
 */

import { runScenario, type Scenario } from '../harness/runner.ts'
import { rebuildDiagnostic } from '../harness/runner.ts'
import { recentConversationEvents } from '../../src/infrastructure/persistence/conversation-store.ts'

const RAPID = [
  '在吗。',
  '我跟你说个事。',
  '算了没事。',
  '你今天有课吗。',
  '我下午要去一趟图书馆。',
  '晚上一起吃饭吗。',
  '不回就算了。',
  '我真服了。',
]

export const SC_003: Scenario = {
  id: 'SC-003',
  description: '连续快速发消息时角色级序号严格递增、无重复、无回退；并发写入也不撞号',
  initial_state: { freshCharacter: true },
  tags: ['sequence', 'concurrency', 'reliability'],
  version: 1,
  turns: RAPID,
  assertions: [
    {
      id: 'C1-sequence-strictly-increasing',
      description: '账本里的序号必须严格递增且两两不同',
      check: (_run, ctx) => {
        const sequences = ctx.agent.conversationEvents.map((e) => e.sequence)
        if (sequences.length !== RAPID.length * 2) {
          throw new Error(`预期 ${RAPID.length * 2} 条事件，实际 ${sequences.length}`)
        }
        for (let i = 1; i < sequences.length; i += 1) {
          if (sequences[i] <= sequences[i - 1]) {
            throw new Error(`序号非严格递增：#${sequences[i - 1]} → #${sequences[i]}`)
          }
        }
        if (new Set(sequences).size !== sequences.length) {
          throw new Error('序号出现重复')
        }
      },
    },
    {
      id: 'C2-exchange-adjacency',
      description: '同一轮的用户事件与助手事件必须相邻（便于"这一轮"的界定）',
      check: (_run, ctx) => {
        const events = ctx.agent.conversationEvents
        for (let i = 0; i + 1 < events.length; i += 2) {
          const user = events[i]
          const assistant = events[i + 1]
          if (user.type !== 'user_message' || assistant.type !== 'assistant_message') {
            throw new Error(`第 ${i / 2 + 1} 轮的事件顺序不对：${user.type} → ${assistant.type}`)
          }
          if (assistant.sequence !== user.sequence + 1) {
            throw new Error(
              `第 ${i / 2 + 1} 轮的助手事件序号不相邻：#${user.sequence} → #${assistant.sequence}`
            )
          }
          if (String(assistant.replyToEventId) !== String(user.id)) {
            throw new Error(`第 ${i / 2 + 1} 轮的助手事件没有正确引用用户事件`)
          }
        }
      },
    },
    {
      id: 'C3-concurrent-allocation-no-collision',
      description: '并发分配序号不撞号（替代 SELECT MAX+1 的关键证据）',
      check: async (_run, ctx) => {
        const { allocateSequence } = await import(
          '../../src/infrastructure/persistence/sequence.ts'
        )
        const results = await Promise.all(
          Array.from({ length: 30 }, () => allocateSequence(ctx.kernel.stores.db, ctx.characterId))
        )
        if (new Set(results).size !== results.length) {
          throw new Error(`并发分配出现重复序号：${results.join(',')}`)
        }
        const sorted = [...results].sort((a, b) => a - b)
        if (sorted[sorted.length - 1] - sorted[0] !== sorted.length - 1) {
          throw new Error(`并发分配不连续（出现空洞）：${sorted[0]}..${sorted[sorted.length - 1]}`)
        }
      },
    },
    {
      id: 'C4-read-back-order-stable',
      description: '从库里读回来的顺序与写入顺序一致',
      check: async (_run, ctx) => {
        const events = await recentConversationEvents(ctx.kernel.stores.db, {
          characterId: ctx.characterId,
          conversationId: ctx.conversationId,
          limit: 100,
        })
        const sequences = events.map((e) => e.sequence)
        for (let i = 1; i < sequences.length; i += 1) {
          if (sequences[i] <= sequences[i - 1]) {
            throw new Error('读取顺序不稳定')
          }
        }
        const contents = events.filter((e) => e.type === 'user_message').map((e) => e.content)
        for (const [index, text] of RAPID.entries()) {
          if (contents[index] !== text) {
            throw new Error(`第 ${index + 1} 句读回来时顺序不对：${contents[index]}`)
          }
        }
      },
    },
    {
      id: 'C5-projection-matches-event-count',
      description: '诊断投影的计数与用户事件条数一致（顺序正确 ⇒ 折叠次数正确）',
      check: async (_run, ctx) => {
        const rebuilt = await rebuildDiagnostic(ctx.kernel)
        if (rebuilt.counter !== RAPID.length) {
          throw new Error(
            `投影计数应为 ${RAPID.length}，实际 ${rebuilt.counter}（有事件被跳过或重复折叠）`
          )
        }
      },
    },
  ],
}

export default SC_003
