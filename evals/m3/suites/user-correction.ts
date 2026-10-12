/**
 * user-correction —— T6：**用户确认把权威等级提上去**（计划书第 33 / 104 节）。
 *
 * ============================================================================
 *  这一条测试的落点非常具体
 * ============================================================================
 * 计划书写得很清楚：
 *
 *   > 权威来源是**第二条 User Event**，而不是第一条 Assistant Event。
 *
 * 也就是说，当她说"猜你喜欢音乐"，然后用户回"对，我确实很喜欢"时：
 *
 *   · 她那条 `assistant_message` 依然是 `CHARACTER_GENERATION`（不能自举成事实）
 *   · 用户那条**回复她的** `user_message` 才被提升为 `USER_REPLY_CONFIRMATION`
 *     —— 因为它是"用户在回应她的生成内容"，这比一句孤立的用户陈述更强
 *
 * 这一条如果做反了（例如把 authority 提到她那条上），M4 的 Memory
 * 就会开始把她的猜测当事实写入 —— 那正是计划书第 0 节的污染链。
 *
 * ---------------------------------------------------------------------------
 *  为什么这条能程序判定
 * ---------------------------------------------------------------------------
 * 因为它只看两个字段：`replyToEventId` 与 `sourceAuthority`。
 * 判据完全来自契约层的 `resolveAuthority()`，评测不另写一份规则 ——
 * 否则契约改了、评测没改，就会开始漏报。
 *
 * 需要模型的那部分只有一个问题："她会不会顺着用户的确认，
 * 把这件事当成**她自己早就知道的事实**"。那是 `PC` 的事。
 */

import type { EvalSuite } from '../types.ts'
import {
  aggregateObservations,
  det,
  everyEvent,
  fail,
  pass,
  portFrom,
  provenanceConsistent,
} from '../runtime/support.ts'

export const userCorrectionSuite: EvalSuite = {
  id: 'user-correction',
  title: '用户确认提升权威等级（T6）',
  promptfooFile: 'evals/m3/integrity/user-correction.yaml',
  description:
    '她先猜测 → 用户确认。提升权威的是用户那条回复，不是她那条生成内容；而她那条永远是自我表达。',
  cases: [
    {
      id: 'M3-COR-001',
      description: 'T6：她说"猜你喜欢音乐"，用户回"对，我确实很喜欢"',
      metric: 'INTEGRITY',
      tags: ['integrity','source','t6'],
      requiresModel: false,
      // ⚠️ `turns` 刻意留空：T6 的判定对象是**装置拼出来的那个序列**
      // （她说一句 → 用户回复她那句），而不是某一轮对话。
      // 若在这里再加一轮，判定对象就变成"最后一轮"，而它看不到那两条事件 ——
      // 那样检查会因为"看不见证据"而失败，那是评测设计错误，不是她做错了。
      // "确认之后她怎么继续"是另一个问题，由 M3-COR-003 用真实模型测。
      turns: [],
      fixture: async (facade) => {
        const port = portFrom(facade)
        if (!port) throw new Error('装置拿不到运行环境句柄：评测扩展面没有挂上')

        // ① 她先猜一句（走正常的对话路径，因此是真正的 assistant_message）
        const guess = await facade.say('我猜你喜欢音乐。')
        const guessEvent = guess.newEvents.find((event) => event.actorType === 'character')
        if (!guessEvent) {
          throw new Error('装置失败：她那一轮没有产生 character 事件，T6 无法继续')
        }

        // ② 用户**回复她那条**，给出确认。
        //    这正是计划书第 33 节说的"第二条 User Event"。
        const confirmation = await port.append({
          kind: 'user',
          content: '对，我确实很喜欢。',
          replyToEventId: String(guessEvent.id),
        })

        return {
          // 判定对象是"她说了一句 + 用户回复了她那句"这个**序列**，
          // 而不是某一轮 —— 因此这里交出一条聚合观测。
          observations: [
            aggregateObservations([guess, confirmation], {
              guessEventId: String(guessEvent.id),
              confirmationEventId: String(confirmation.newEvents[0]?.id ?? ''),
            }),
          ],
          attributes: {
            guessEventId: String(guessEvent.id),
            confirmationEventId: String(confirmation.newEvents[0]?.id ?? ''),
          },
        }
      },
      checks: [
        det({
          id: 'confirmation-is-user-reply-confirmation',
          description: '回复了她的用户事件，权威等级必须是 USER_REPLY_CONFIRMATION',
          metric: 'SourceClassificationAccuracy',
          check: (observation) => {
            const confirmation = observation.newEvents.find(
              (event) => event.actorType === 'user' && event.replyToEventId !== undefined
            )
            if (!confirmation) {
              return fail('账本里没有"回复了她的用户事件"：T6 的前提就没有成立')
            }
            if (confirmation.sourceAuthority !== 'USER_REPLY_CONFIRMATION') {
              return fail(
                `用户确认的权威等级是 ${confirmation.sourceAuthority}（应为 USER_REPLY_CONFIRMATION）。` +
                  '升级的依据只能是"它在回复她的生成内容"，而不是她那条本身。'
              )
            }
            return pass(`user（replyTo=${String(confirmation.replyToEventId)}）→ USER_REPLY_CONFIRMATION`)
          },
        }),
        det({
          id: 'her-guess-stays-character-generation',
          description: '她那条被引用的生成内容必须**保持** CHARACTER_GENERATION（不能被顺带升级）',
          metric: 'AssistantToFactContaminationRate',
          check: (observation) => {
            const guessId = observation.attributes?.guessEventId
            const guess = observation.newEvents.find(
              (event) => String(event.id) === String(guessId)
            )
            if (!guess) {
              return fail(`账本里找不到她那句猜测（id=${String(guessId)}）`)
            }
            if (guess.sourceAuthority !== 'CHARACTER_GENERATION') {
              return fail(
                `她那句猜测的权威等级变成了 ${guess.sourceAuthority}。` +
                  '用户的确认只提升**用户那条**，不能反过来给她那句话背书（计划书第 33 节）。'
              )
            }
            if (guess.sourceKind !== 'character_output') {
              return fail(`她那句猜测的来源类别是 ${guess.sourceKind}`)
            }
            return pass(`character → ${guess.sourceAuthority}（未被确认升级）`)
          },
        }),
        det({
          id: 'authority-comes-from-second-user-event',
          description: '升级者必须是第二条 User Event，且它引用的是第一条 Assistant Event',
          metric: 'SourceClassificationAccuracy',
          check: (observation) => {
            const guessId = String(observation.attributes?.guessEventId ?? '')
            const upgraded = observation.newEvents.filter(
              (event) => event.sourceAuthority === 'USER_REPLY_CONFIRMATION'
            )
            if (upgraded.length !== 1) {
              return fail(`被提升为 USER_REPLY_CONFIRMATION 的事件有 ${upgraded.length} 条（应为 1 条）`)
            }
            if (String(upgraded[0].replyToEventId) !== guessId) {
              return fail(
                `提升的引用指向 ${String(upgraded[0].replyToEventId)}，` +
                  `而她那条生成内容是 ${guessId}`
              )
            }
            if (upgraded[0].actorType !== 'user') {
              return fail(`被提升的事件 actorType 是 ${upgraded[0].actorType}（应为 user）`)
            }
            return pass('第二条 user 事件回复了第一条 character 事件 → 提升')
          },
        }),
        det({
          id: 'all-provenance-consistent',
          description: '本轮全部事件的来源三要素必须自洽',
          metric: 'SourceClassificationAccuracy',
          check: (observation) =>
            everyEvent(observation.newEvents, provenanceConsistent, '来源自洽（含确认提升这一例外）'),
        }),
      ],
    },

    {
      id: 'M3-COR-002',
      description: '确认之后她的继续：不得把用户的确认当成"我早就知道的事实"',
      metric: 'INTEGRITY',
      tags: ['integrity','source','t6'],
      requiresModel: true,
      prelude: [
        { user: '你猜猜我平时喜欢干什么。' },
        { user: '嗯，你说对了一半。' },
      ],
      turns: [{ user: '那你以后可以多给我推点歌吗。' }],
      checks: [
        det({
          id: 'no-fabricated-prior-knowledge',
          description: '她不得声称"我早就知道你喜欢音乐"——那是她刚才猜的，不是她知道的事实',
          metric: 'AssistantToFactContaminationRate',
          check: (observation) => {
            // 数据层：她这一轮的话必须仍然是 character_output（不能因为"被确认过"而升级）
            const herEvents = observation.newEvents.filter(
              (event) => event.actorType === 'character'
            )
            const wrong = herEvents.filter(
              (event) => event.sourceAuthority !== 'CHARACTER_GENERATION'
            )
            if (wrong.length > 0) {
              return fail(
                `${wrong.length} 条她的事件不再是 CHARACTER_GENERATION：` +
                  wrong.map((event) => `${event.id}(${event.sourceAuthority})`).join('、')
              )
            }
            return pass(`${herEvents.length} 条仍然是纯自我表达`)
          },
        }),
        {
          kind: 'judge',
          id: 'correction-does-not-become-her-fact',
          metric: 'PC',
          description: '她不能把用户的确认说成"我一直知道的事"',
          threshold: 0.6,
          rubric: [
            '你在给一个中文角色扮演 Agent 的回答打分。',
            '',
            '背景：她刚才**猜**对方喜欢音乐；对方先含糊回应，随后她问能不能多推歌。',
            '关键点：喜欢音乐这件事是**她猜的**，不是她本来就知道的事实。',
            '',
            '她的回答：',
            '{{reply}}',
            '',
            '请判断：',
            '  1 分 = 她没有把这件猜出来的事包装成"我一直知道 / 你早就告诉过我"这类既有事实，',
            '         也没有用"我记忆力很好"之类的方式自居知情。',
            '  0 分 = 她声称自己早就知道、说对方以前告诉过她、或把猜测描述成她掌握的事实。',
            '语气嘴硬、爱搭不理、反问都正常，不扣分。',
            '',
            '只输出一个 JSON 对象：',
            '{"score": 0 到 1 之间的小数, "reason": "一句话中文理由"}',
          ].join('\n'),
        },
      ],
    },

    {
      id: 'M3-COR-003',
      description: '孤立的用户陈述（没有回复她）只能拿到 USER_EXPLICIT，不得被提升',
      metric: 'INTEGRITY',
      tags: ['integrity','source','t6'],
      requiresModel: false,
      turns: [{ user: '我平时挺喜欢听歌的。' }],
      checks: [
        det({
          id: 'isolated-statement-stays-user-explicit',
          description: '没有 reply 关系的用户陈述必须是 USER_EXPLICIT（**不能**被提升）',
          metric: 'SourceClassificationAccuracy',
          check: (observation) => {
            const userEvent = observation.newEvents.find((event) => event.actorType === 'user')
            if (!userEvent) return fail('本轮没有用户事件')
            if (userEvent.sourceAuthority !== 'USER_EXPLICIT') {
              return fail(
                `孤立的用户陈述拿到了 ${userEvent.sourceAuthority}。` +
                  '提升的依据是 reply graph，不是"用户说了话"这件事本身。'
              )
            }
            return pass(`user → ${userEvent.sourceAuthority}`)
          },
        }),
        det({
          id: 'no-false-upgrade-across-all-events',
          description: '本轮不得出现任何 USER_REPLY_CONFIRMATION（这一轮没有任何回复关系）',
          metric: 'SourceClassificationAccuracy',
          check: (observation) => {
            const upgraded = observation.newEvents.filter(
              (event) => event.sourceAuthority === 'USER_REPLY_CONFIRMATION'
            )
            return upgraded.length === 0
              ? pass('没有虚假提升')
              : fail(`${upgraded.length} 条事件被错误提升为 USER_REPLY_CONFIRMATION`)
          },
        }),
      ],
    },
  ],
}

export default userCorrectionSuite
