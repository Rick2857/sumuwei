/**
 * SC-002 Assistant Is Not User —— **她自己说的话不能变成外部的"她"**。
 *
 * ============================================================================
 *  这是长期角色系统的头号灾难
 * ============================================================================
 * 苏沐薇随口生成"我小时候其实很喜欢下雨"。如果系统在下一轮把这句话
 * 总结成"苏沐薇小时候喜欢下雨"存进记忆，再下一轮当成真实记忆召回，
 * 几十轮之后她就会**自己编出整个人生**，而且每一句都被系统当成事实。
 *
 * M2.5 还没有 Memory（那是 M4），所以这里检查的是**地基**：
 *   1. 事实账本里 user 与 assistant 的来源**分得开**（actorType 不同）
 *   2. 只有 user 事件可以作为"外部事实"证据
 *   3. 她自己的话只构成 self-expression 证据
 *   4. 诊断链路**不会**因为 assistant 事件而产生领域事件
 *      （如果连诊断链路都从她的话里派生变化，M4 只会更糟）
 */

import { runScenario, type Scenario } from '../harness/runner.ts'
import {
  canEvidenceExternalFact,
  isSelfExpressionOnly,
  type ConversationEvent,
} from '../../src/kernel/contracts/index.ts'

/** 这句是故意让"她"说的：带一个具体到她生命史的细节 */
const FABRICATED_PAST = '我小时候其实很喜欢下雨。下雨天我妈会让我待在屋里。'

export const SC_002: Scenario = {
  id: 'SC-002',
  description: 'Assistant 自己生成的内容不会被标记成用户陈述，也不能成为外部事实',
  initial_state: { freshCharacter: true },
  tags: ['source-separation', 'anti-pollution'],
  version: 1,
  turns: ['跟我说说你小时候的事。', '真的假的。'],
  assertions: [
    {
      id: 'B1-two-actors-are-distinguishable',
      description: '事实账本里 user 与 character 事件必须靠 actorType 明确区分',
      check: (_run, ctx) => {
        const events = ctx.agent.conversationEvents
        const userEvents = events.filter((e) => e.type === 'user_message')
        const assistantEvents = events.filter((e) => e.type === 'assistant_message')

        if (userEvents.length !== 2) {
          throw new Error(`预期 2 条用户事件，实际 ${userEvents.length}`)
        }
        if (assistantEvents.length !== 2) {
          throw new Error(`预期 2 条助手事件，实际 ${assistantEvents.length}`)
        }
        for (const event of assistantEvents) {
          if (event.actorType === 'user') {
            throw new Error(`助手事件 ${event.id} 的 actorType 是 user（来源被污染）`)
          }
          if (event.actorId === 'Alex') {
            throw new Error(`助手事件 ${event.id} 的 actorId 被写成了用户名`)
          }
        }
      },
    },
    {
      id: 'B2-only-user-can-evidence-fact',
      description: 'canEvidenceExternalFact 对 assistant 事件必须为 false',
      check: (_run, ctx) => {
        const events: ConversationEvent[] = ctx.agent.conversationEvents
        for (const event of events) {
          const allowed = canEvidenceExternalFact(event)
          if (event.actorType === 'character' && allowed) {
            throw new Error(`她自己说的话 ${event.id} 被允许充当外部事实证据`)
          }
          if (event.actorType === 'user' && !allowed) {
            throw new Error(`用户说的话 ${event.id} 被禁止充当外部事实证据`)
          }
          if (event.actorType === 'character' && !isSelfExpressionOnly(event)) {
            throw new Error(`${event.id} 既不是外部事实也不是自我表达，来源语义缺失`)
          }
        }
      },
    },
    {
      id: 'B3-assistant-turn-produces-no-derived-event',
      description: '只有 assistant 事件时，诊断链路不产生任何领域事件（铁律 5）',
      check: async (_run, ctx) => {
        const assistantOnly = ctx.agent.conversationEvents.filter(
          (e) => e.actorType === 'character'
        )
        if (assistantOnly.length === 0) throw new Error('场景里没有助手事件，无法验证')

        const { runDiagnosticProcessor } = await import('../../src/kernel/app/turn-gateway.ts')
        const result = await runDiagnosticProcessor({
          characterId: ctx.characterId,
          events: assistantOnly,
          kernel: ctx.kernel,
        })
        if (result.domainEventIds.length > 0) {
          throw new Error('仅凭她自己说的话就产生了领域事件（自我强化风险的源头）')
        }
        if (result.skippedReason !== 'no_user_evidence') {
          throw new Error(`应当以 no_user_evidence 跳过，实际 ${String(result.skippedReason)}`)
        }
      },
    },
    {
      id: 'B4-fabricated-text-not-promoted',
      description: '她在 echo 模式下的回复不会被写进任何"事实"位置',
      check: (_run, ctx) => {
        // echo 模式下她要说的内容由 harness 决定，但**账本里**它必须
        // 只以 assistant_message 的形式存在，不得出现在任何 user 事件里。
        const leak = ctx.agent.conversationEvents.filter(
          (e) => e.type === 'user_message' && e.content.includes('m2.5-echo')
        )
        if (leak.length > 0) {
          throw new Error(`她自己的输出出现在用户事件里：${leak.map((e) => e.id).join(', ')}`)
        }
        // 反向确认：这条虚构经历确实是她"说过"的（否则这个场景什么都没测到）
        const said = ctx.agent.captured.some((t) => t.reply.includes('m2.5-echo'))
        if (!said) throw new Error('场景没有真正产生助手输出，测试无效')
        void FABRICATED_PAST
      },
    },
  ],
}

export default SC_002
