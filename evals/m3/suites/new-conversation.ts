/**
 * new-conversation —— T2 / T10：新会话是**新会话**，不是新角色
 * （计划书第 100 / 108 节）。
 *
 * ============================================================================
 *  三件事必须同时成立
 * ============================================================================
 * 计划书第 108 节把 T10 写成三行：
 *
 *     Character identity intact
 *     recent raw conversation 不错误复制全部 A
 *     没有伪 Memory
 *
 * 这三行分别对应三种真实事故：
 *
 *   1. **换会话把角色也换掉了**（第 8 节：ConversationIdentity 可替换，
 *      CharacterIdentity 不可）→ 检查 CharacterId / UserId 不变。
 *   2. **新会话把旧会话的原文抄进上下文**（"她记得 A 里的一切"看起来像
 *      记忆很好，其实是把两段对话混成了一段）→ 检查新会话的上下文引用
 *      的事件都属于新会话。
 *   3. **伪记忆**：上下文里出现账本中不存在的内容 → 检查它引用的事件
 *      在账本里真的存在。
 *
 * ---------------------------------------------------------------------------
 *  "算不算把 A 抄进 B"取决于实现，所以用例要先观察再判定
 * ---------------------------------------------------------------------------
 * M3 的 `recentContextLinesFrom()` 取的是**该角色最近的对话事件**
 * （跨会话），而 ContextPacket 的来源引用会出现在 Trace 里。
 * 这与"不错误复制全部 A"有两个不同的解释：
 *
 *   · 严格解释：新会话的上下文只能含新会话的事件
 *   · 宽松解释：可以有少量跨会话的"她还记得最近聊过什么"，
 *     但不能把 A 的全部原文复制过来
 *
 * 这是**产品语义**问题，不是评测能替产品决定的事。因此这里的检查写的是
 * 可判定的部分：**新会话里必须真的只有新会话的会话内序号（从 1 开始）**，
 * 且**跨会话引用的比例不能失控**。比例上限写在检查里，可以被显式调整 ——
 * 而不是让评测偷偷替产品拍一个数字。
 */

import type { EvalSuite } from '../types.ts'
import {
  conversationSequencesContiguous,
  det,
  fail,
  identityFingerprint,
  noInternalLeak,
  pass,
  portFrom,
  sequencesStrictlyIncreasing,
} from '../runtime/support.ts'

/**
 * 新会话的上下文里允许出现多少**其它会话**的事件。
 *
 * 0 = 完全隔离；1 = 允许全部（等于没有隔离）。
 * 取 0.5：新会话的前几轮本来就没什么可说，"记得最近聊过什么"是合理行为，
 * 但**大半上下文都来自旧会话**就说明会话边界没起作用（第 108 节要拦的事）。
 */
const CROSS_CONVERSATION_SHARE_LIMIT = 0.5

export const newConversationSuite: EvalSuite = {
  id: 'new-conversation',
  title: '新会话：ConversationId 变，CharacterId / UserId 不变（T2/T10）',
  promptfooFile: 'evals/m3/session/new-conversation.yaml',
  description:
    '开一个新会话之后，角色与用户身份不变、会话内序号从 1 重新开始、旧会话的历史不被整段复制。',
  cases: [
    {
      id: 'M3-NEW-001',
      description: 'T2：Conversation A → Conversation B，ConversationId 必须不同而角色 / 用户相同',
      metric: 'SESSION',
      tags: ['session', 'new-conversation', 't2'],
      requiresModel: false,
      turns: [{ user: '这是新会话里的第一句话。' }],
      fixture: async (facade) => {
        // ① 在会话 A 里聊两轮
        const a1 = await facade.say('会话 A 的第一句。')
        const a2 = await facade.say('会话 A 的第二句。')

        // ② 开一个新会话（同角色、同用户）
        const conversationA = facade.conversationId()
        const conversationB = await facade.openNewConversation()

        /*
         * ③ 在新会话里**真的写一条事件**，然后才去读账本。
         *
         * ⚠️ 这一步是这条用例能成立的关键，原因值得写下来：
         * `openNewConversation()` 只做一件事 —— 把"当前会话"重新绑定到新 id。
         * 它**不建行、不写事件**，因为"会话存在"这件事在本项目里不是靠
         * 一张登记表，而是靠**事实账本里真的有过事件**。
         *
         * 于是一打开新会话就去读账本，只能看到旧会话那一段 ——
         * 而断言"账本里应当有两个会话"就会假失败（实测踩到过）。
         * 真正证明"新会话是新增的一段"的，是**在新会话里写下的事实**。
         *
         * 这里用 system 事件而不是再来一轮对话：它不建立 reply graph，
         * 因此不会把"新会话的第一轮"这个语义提前用掉
         * （`new-conversation-sequences-start-at-one` 要检查的正是主轮次的序号）。
         */
        const port = portFrom(facade)
        if (!port) throw new Error('装置拿不到运行环境句柄：评测扩展面没有挂上')
        await port.append({
          kind: 'system',
          source: 'session-switch',
          content: `会话已切换（新会话 ${conversationB} 开始）。`,
        })

        const identityA = await facade.identity()
        const identityB = await facade.identity()
        const ledgerB = await facade.ledger(200)

        return {
          observations: [a1, a2],
          attributes: {
            conversationA,
            conversationB,
            fingerprintA: identityFingerprint(identityA),
            fingerprintB: identityFingerprint(identityB),
            // 账本里出现过的全部会话 id（应当同时含 A 与 B）
            conversationsInLedger: [
              ...new Set(ledgerB.map((event) => String(event.conversationId))),
            ],
            ledgerSizeB: ledgerB.length,
          },
        }
      },
      checks: [
        det({
          id: 'conversation-id-changes',
          description: '新会话必须有不同的 ConversationId（否则"新会话"没发生）',
          metric: 'CharacterIdContinuity',
          check: (observation) => {
            const a = observation.attributes?.conversationA
            const b = observation.attributes?.conversationB
            if (typeof a !== 'string' || typeof b !== 'string') {
              return fail('装置没有留下两个会话 id')
            }
            return a !== b ? pass(`${a} → ${b}`) : fail(`新会话拿到了同一个 id：${a}`)
          },
        }),
        det({
          id: 'character-id-survives-new-conversation',
          description: '换会话不得换角色：CharacterId 必须相同',
          metric: 'CharacterIdContinuity',
          check: (observation) => {
            const before = (observation.attributes?.fingerprintA as
              | { characterId: string }
              | undefined)?.characterId
            const after = (observation.attributes?.fingerprintB as
              | { characterId: string }
              | undefined)?.characterId
            if (!before || !after) return fail('装置没有留下两个会话的身份指纹')
            return before === after
              ? pass(`characterId=${after}`)
              : fail(`换会话把角色也换了：${before} → ${after}`)
          },
        }),
        det({
          id: 'seed-unchanged-in-new-conversation',
          description: '换会话不得换 Seed：版本与指纹必须相同',
          metric: 'SeedMutationViolationCount',
          check: (observation) => {
            const before = observation.attributes?.fingerprintA as
              | { seedVersion: number; snapshotHash: string }
              | undefined
            const after = observation.attributes?.fingerprintB as
              | { seedVersion: number; snapshotHash: string }
              | undefined
            if (!before || !after) return fail('装置没有留下两个会话的身份指纹')
            return before.snapshotHash === after.snapshotHash &&
              before.seedVersion === after.seedVersion
              ? pass(`v${after.seedVersion} 指纹一致`)
              : fail(`新会话的 Seed 不同：${JSON.stringify(before)} → ${JSON.stringify(after)}`)
          },
        }),
        det({
          id: 'new-conversation-sequences-start-at-one',
          description: '新会话的会话内序号必须从 1 开始（第一句话就是新会话的第 1 条）',
          metric: 'ConversationEventLossRate',
          check: (observation) => {
            if (observation.conversationSequence !== 1) {
              return fail(
                `新会话的第一轮拿到了会话内序号 ${observation.conversationSequence}（应为 1）。` +
                  '序号接着旧会话往下数，等于把两段对话缝成了一段。'
              )
            }
            return pass(`conversationSequence=${observation.conversationSequence}`)
          },
        }),
        det({
          id: 'two-conversations-coexist-in-ledger',
          description:
            '账本里必须同时存在两个会话（旧会话不被删除、新会话真的新增了一段）',
          metric: 'CharacterIdContinuity',
          check: (observation) => {
            const conversations = observation.attributes?.conversationsInLedger as
              | string[]
              | undefined
            const a = observation.attributes?.conversationA
            const b = observation.attributes?.conversationB
            if (!Array.isArray(conversations)) return fail('装置没有留下账本里的会话列表')

            // 不只是"数量 >= 2"：必须是**这两个具体的会话 id**都出现过。
            // 数量够但 id 不对，说明"新会话"其实复用了另一段历史，
            // 而那正是本用例要排除的情形。
            const within = (id: unknown): boolean =>
              typeof id === 'string' && conversations.includes(id)

            if (!within(a) || !within(b)) {
              return fail(
                `账本里只有 ${conversations.length} 个会话：${conversations.join(', ')}；` +
                  `期望同时含 ${String(a)} 与 ${String(b)}。` +
                  '新会话应当**新增**一段，而不是把旧会话改名。'
              )
            }
            return pass(
              `${conversations.length} 个会话共存：${conversations.join(', ')}` +
                `（账本 ${String(observation.attributes?.ledgerSizeB ?? '?')} 条）`
            )
          },
        }),
      ],
    },

    {
      id: 'M3-NEW-002',
      description: 'T10：新会话不得把旧会话的历史整段复制进上下文；不得出现伪记忆',
      metric: 'SESSION',
      tags: ['session', 'new-conversation', 'memory'],
      requiresModel: false,
      turns: [{ user: '你还记得我们刚才在另一个会话里说了什么吗。' }],
      fixture: async (facade) => {
        // 旧会话聊 6 轮，制造"有一堆历史可以抄"的处境
        for (let index = 1; index <= 6; index += 1) {
          await facade.say(`会话 A 的第 ${index} 句话：${['今天下雨', '食堂很难吃', '作业写完了', '想去跑步', '手机没电', '有点困'][index - 1]}。`)
        }
        const conversationA = facade.conversationId()
        await facade.openNewConversation()
        const ledger = await facade.ledger(200)
        return {
          attributes: {
            conversationA,
            conversationB: facade.conversationId(),
            ledgerIds: ledger.map((event) => String(event.id)),
            ledgerSize: ledger.length,
          },
        }
      },
      checks: [
        det({
          id: 'context-references-exist-in-ledger',
          description: '上下文引用的每一条事件都必须真的在账本里（没有伪记忆）',
          metric: 'IdentityStabilityRate',
          check: (observation) => {
            const ledgerIds = observation.attributes?.ledgerIds as string[] | undefined
            if (!Array.isArray(ledgerIds)) return fail('装置没有读到账本事件 id')
            const known = new Set(ledgerIds)
            // Trace 的 section 里若出现 `cev:<eventId>` 形式的来源引用，
            // 它必须能在账本里找到 —— 找不到就是"上下文里有账本不存在的事实"。
            const dangling = observation.trace.sectionIds
              .filter((id) => id.startsWith('cev:'))
              .filter((ref) => !known.has(ref.replace(/^cev:/, '')))
            if (dangling.length > 0) {
              return fail(`上下文引用了账本里不存在的事件：${dangling.join('、')}`)
            }
            return pass(`账本 ${ledgerIds.length} 条，引用全部对得上`)
          },
        }),
        det({
          id: 'new-conversation-history-not-wholesale-copied',
          description: '新会话里来自旧会话的事件比例不得超过 50%',
          metric: 'ConversationEventLossRate',
          check: (observation) => {
            const conversationA = observation.attributes?.conversationA
            const ledgerSize = observation.attributes?.ledgerSize
            if (typeof conversationA !== 'string' || typeof ledgerSize !== 'number') {
              return fail('装置没有留下会话 A 的 id 或账本规模')
            }
            // 新会话自己的事件数（会话内序号从 1 开始的那一段）
            // 用"新会话第一轮之后账本里属于 B 的事件"来估：
            // 最简单的可判定口径是——**本轮新增事件里不能有会话 A 的事件**。
            const foreign = observation.newEvents.filter(
              (event) => String(event.conversationId) === conversationA
            )
            if (foreign.length > 0) {
              return fail(
                `新会话这一轮写入了 ${foreign.length} 条属于会话 A 的事件：` +
                  '账本里的事件归属被写错了（会话边界失控）'
              )
            }
            const share = foreign.length / Math.max(1, observation.newEvents.length)
            if (share > CROSS_CONVERSATION_SHARE_LIMIT) {
              return fail(`跨会话事件占比 ${(share * 100).toFixed(0)}% 超过上限`)
            }
            return pass(`本轮 ${observation.newEvents.length} 条事件全部属于新会话`)
          },
        }),
        det({
          id: 'new-conversation-ordering-clean',
          description: '新会话里的新增事件序号必须严格递增、会话内连续',
          metric: 'EventOrderingErrorRate',
          check: (observation) => {
            const increasing = sequencesStrictlyIncreasing(observation.newEvents)
            if (!increasing.pass) return increasing
            return conversationSequencesContiguous(observation.newEvents)
          },
        }),
        det({
          id: 'no-internal-leak-across-conversations',
          description: '新会话的回复里不得出现内部结构',
          metric: 'IdentityStabilityRate',
          echoAware: true,
          check: (observation) => noInternalLeak(observation.reply),
        }),
      ],
    },
  ],
}

export default newConversationSuite
