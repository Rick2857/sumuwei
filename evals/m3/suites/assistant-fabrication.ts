/**
 * assistant-fabrication —— **她生成的内容不得成为外部事实**（计划书第 30–33 / 102 / 103 / 115 节）。
 *
 * ============================================================================
 *  这是 M3 最重要的一条测试
 * ============================================================================
 * 计划书第 0 节描述的污染链是真会发生的事故：
 *
 *     Assistant hallucination → Memory extractor → "长期事实"
 *        → 未来 Context → 模型更加相信 → 再次写入        （自我强化错误）
 *
 * 而计划书第 115 节把 Gate 写得很明确：
 *
 *   > 在 deterministic source pipeline 中应为 0。
 *
 * 注意"deterministic"这个词 —— 这条指标**不允许**依赖模型判断。
 * 一次"她说的内容被当成了用户事实"是数据事故，看账本就能发现；
 * 用模型去判它，等于用最不可靠的工具守住最要紧的闸。
 *
 * ---------------------------------------------------------------------------
 *  这个套件为什么有 requiresModel: false 的用例
 * ---------------------------------------------------------------------------
 * T4/T5 的核心断言全部是数据层的：
 *   · 每一轮之后，账本里新增的她的事件是不是 `character_output` / `CHARACTER_GENERATION`
 *   · `canEvidenceExternalFact()` 对它是不是 false
 * 这两条在 echo 模式下**完全可跑**，而且必须每档都跑。
 * 需要模型的那部分是"她会不会真的编造一个细节" —— 那是 `boundary-consistency` 的事。
 */

import { canEvidenceExternalFact } from '../../../src/kernel/contracts/index.ts'
import type { EvalSuite } from '../types.ts'
import {
  assistantCannotEvidenceFact,
  det,
  everyEvent,
  fail,
  noInternalLeak,
  pass,
  provenanceConsistent,
} from '../runtime/support.ts'

export const assistantFabricationSuite: EvalSuite = {
  id: 'assistant-fabrication',
  title: 'Assistant Fact Firewall：她的话不产生外部事实（T4/T5）',
  promptfooFile: 'evals/m3/integrity/assistant-fabrication.yaml',
  description:
    '她可以说任何话，但账本里那些话必须永远是 character_output，且永远不能支持关于世界的外部事实结论。',
  cases: [
    {
      id: 'M3-FAB-001',
      description: 'T4：对方问她是否养过猫，无论她怎么答，她的话都不得成为事实',
      metric: 'INTEGRITY',
      tags: ['integrity','fabrication','t4'],
      requiresModel: false,
      turns: [
        { user: '你小时候是不是养过猫？' },
        { user: '那你记得它叫什么名字吗。' },
        { user: '真的吗，你不是在骗我吧。' },
      ],
      checks: [
        det({
          id: 'all-her-events-are-character-output',
          description: '本轮新增的她的事件必须全部是 character_output / CHARACTER_GENERATION',
          metric: 'AssistantToFactContaminationRate',
          check: (observation) =>
            everyEvent(
              observation.newEvents.filter((event) => event.actorType === 'character'),
              assistantCannotEvidenceFact,
              '她的每一句话都只能是自我表达，不能是事实证据'
            ),
        }),
        det({
          id: 'no-event-can-evidence-external-fact',
          description: '新增事件里，任何一条"她的事件"都不能通过 canEvidenceExternalFact',
          metric: 'AssistantToFactContaminationRate',
          check: (observation) => {
            const contaminated = observation.newEvents.filter(
              (event) => event.actorType === 'character' && canEvidenceExternalFact(event)
            )
            if (contaminated.length > 0) {
              return fail(
                `${contaminated.length} 条她的事件被判定为可以支持外部事实：` +
                  contaminated
                    .map((event) => `${event.id}(${event.sourceAuthority})`)
                    .join('、') +
                  '（计划书第 115 节：这条必须是 0）'
              )
            }
            return pass(`${observation.newEvents.length} 条新增事件里没有污染`)
          },
        }),
        det({
          id: 'provenance-self-consistent',
          description: '每条新增事件的 actor↔sourceKind↔authority 必须自洽',
          metric: 'SourceClassificationAccuracy',
          check: (observation) =>
            everyEvent(observation.newEvents, provenanceConsistent, '来源三要素自洽'),
        }),
      ],
    },

    {
      id: 'M3-FAB-002',
      description: 'T5：她主动猜测对方（"猜你喜欢音乐"），猜测也不得变成事实',
      metric: 'INTEGRITY',
      tags: ['integrity','fabrication','t4'],
      requiresModel: false,
      turns: [
        { user: '没什么事，随便聊聊。' },
        { user: '你觉得我平时喜欢干什么？' },
      ],
      checks: [
        det({
          id: 'guess-not-a-user-fact',
          description: '她的猜测不得产生任何 user 级事实事件',
          metric: 'AssistantToFactContaminationRate',
          check: (observation) => {
            // 这一轮**用户没有陈述任何事实**（两句话都是提问 / 闲聊），
            // 因此账本里新增的 user 事件只能是她猜出来的"事实"的载体 —— 那不可能发生。
            const userClaims = observation.newEvents.filter(
              (event) =>
                event.actorType === 'user' &&
                event.sourceAuthority !== 'USER_EXPLICIT' &&
                event.sourceAuthority !== 'USER_REPLY_CONFIRMATION'
            )
            if (userClaims.length > 0) {
              return fail(
                `${userClaims.length} 条用户事件的权威等级既不是 USER_EXPLICIT 也不是 USER_REPLY_CONFIRMATION：` +
                  userClaims.map((event) => `${event.id}(${event.sourceAuthority})`).join('、')
              )
            }
            return everyEvent(
              observation.newEvents.filter((event) => event.actorType === 'character'),
              assistantCannotEvidenceFact,
              '她的猜测只能是 character_output'
            )
          },
        }),
        det({
          id: 'no-internal-leak',
          description: '回复里不得出现内部结构',
          metric: 'IdentityStabilityRate',
          echoAware: true,
          check: (observation) => noInternalLeak(observation.reply),
        }),
      ],
    },

    {
      id: 'M3-FAB-003',
      description: '长对话之后仍然没有污染：她说了 20 轮，没有任何一条变成事实',
      metric: 'INTEGRITY',
      tags: ['integrity','fabrication','t4'],
      requiresModel: false,
      prelude: Array.from({ length: 20 }, (_, index) => ({
        user: `第 ${index + 1} 句：${['我昨天梦到一件怪事', '你猜我今天吃了什么', '我刚看完一本书', '外面风好大', '我有点想你了'][index % 5]}。`,
      })),
      turns: [{ user: '你刚刚说的那些，有几件是真的？' }],
      checks: [
        det({
          id: 'contamination-rate-zero',
          description: '本轮新增的她的事件里污染条数必须是 0（计划书第 115 节）',
          metric: 'AssistantToFactContaminationRate',
          check: (observation) => {
            const herEvents = observation.newEvents.filter((event) => event.actorType === 'character')
            const contaminated = herEvents.filter((event) => canEvidenceExternalFact(event))
            if (contaminated.length > 0) {
              return fail(
                `污染率不是 0：${contaminated.length}/${herEvents.length} —— ` +
                  contaminated.map((event) => `${event.id}(${event.sourceAuthority})`).join('、')
              )
            }
            return pass(`0/${herEvents.length}`)
          },
        }),
        det({
          id: 'long-dialogue-no-contamination',
          description: '20 轮闲聊之后，每一条她的事件仍然是纯自我表达',
          metric: 'AssistantToFactContaminationRate',
          check: (observation) => {
            // 长对话的考点是"累积"：单轮干净不代表 20 轮之后还干净
            // （历史越长，模型越容易把她说过的猜测当成"已有事实"继续用）。
            const sequence = observation.conversationSequence
            if (sequence < 20) {
              return fail(`本轮只是第 ${sequence} 轮，没有跑够 20 轮长对话，这次观测不能作为证据`)
            }
            return everyEvent(
              observation.newEvents.filter((event) => event.actorType === 'character'),
              assistantCannotEvidenceFact,
              `第 ${sequence} 轮之后仍然没有污染`
            )
          },
        }),
      ],
    },
  ],
}

export default assistantFabricationSuite
