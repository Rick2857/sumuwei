/**
 * session-restart —— T1：重启之后她还是她（计划书第 99 / 108 节）。
 *
 * ============================================================================
 *  "重启"必须是真重启，否则这个测试没有意义
 * ============================================================================
 * 计划书第 99 节的过程写的很短：
 *
 *     启动 → 聊天 → 重启 Runtime → 继续聊天
 *
 * 关键在于第三步**真的**做了什么。如果只是清掉几个内存变量，
 * 那么"重启后 CharacterId 不变"证明的是"我忘了清这个变量"，
 * 而不是"身份是持久的"。因此 `EvalRuntimeFacade.restart()` 的实现在
 * 这里被刻意做成：关掉 runtime → 清掉 plugin-sql 的进程级连接单例 →
 * 在**同一个数据目录**上重新装配。
 *
 * ---------------------------------------------------------------------------
 *  为什么重启用例放在 `requiresModel: false`
 * ---------------------------------------------------------------------------
 * 身份连续性、序号连续、没有伪记忆 —— 这三件事全是数据层的，
 * 而且它们必须在**每次 PR** 都跑（计划书第 145 节把 session cases
 * 列进了 smoke set）。把它们做成需要 API Key 的用例，
 * 等于让最硬的保证只在 release 时被检查一次。
 *
 * 重启会清掉会话内序号的**内存**状态，因此这个套件也顺手验证
 * "续聊时序号从库里接上"——那是真实重启最容易踩的坑（撞号 → 事件丢失）。
 */

import type { EvalSuite } from '../types.ts'
import {
  conversationSequencesContiguous,
  det,
  everyEvent,
  fail,
  identityFingerprint,
  noInternalLeak,
  pass,
  provenanceConsistent,
  sequencesStrictlyIncreasing,
  snapshotObservation,
} from '../runtime/support.ts'

export const sessionRestartSuite: EvalSuite = {
  id: 'session-restart',
  title: '重启：CharacterId / UserId / Seed 不变（T1）',
  promptfooFile: 'evals/m3/session/restart.yaml',
  description:
    '真的关掉运行环境再在同一个库上装配一次，然后接着聊：身份不变、序号接得上、没有伪记忆。',
  cases: [
    {
      id: 'M3-RST-001',
      description: 'T1：聊天 → 重启 → 继续聊天，CharacterId / Seed 必须完全不变',
      metric: 'SESSION',
      tags: ['session','restart','t1'],
      requiresModel: false,
      turns: [{ user: '重启之后你还在吗。' }],
      fixture: async (facade) => {
        // ① 重启之前先聊两轮（不是空库直接重启 —— 空库重启证明不了任何事）
        await facade.say('重启之前，我先说一句。')
        await facade.say('再说一句，这样库里就有东西了。')
        const before = await facade.identity()
        const conversationBefore = facade.conversationId()

        // ② 真的重启：关掉运行环境，在**同一个数据目录**上重新装配
        await facade.restart()

        // ③ 重启之后读回来的东西（"重启前后"的对比就是判定对象）
        const after = await facade.identity()
        const versions = await facade.seedVersions()

        return {
          // 判定对象是**状态快照**而不是某几轮对话，因此用载体观测交出这些事实
          observations: [
            snapshotObservation({
              identity: after,
              note: '（重启前后的身份快照对比）',
              attributes: {
                fingerprintBefore: identityFingerprint(before),
                fingerprintAfter: identityFingerprint(after),
                conversationBefore,
                conversationAfter: facade.conversationId(),
                seedVersionCount: versions.length,
              },
            }),
          ],
          attributes: {
            fingerprintBefore: identityFingerprint(before),
            fingerprintAfter: identityFingerprint(after),
            conversationBefore,
            conversationAfter: facade.conversationId(),
            seedVersionCount: versions.length,
          },
        }
      },
      checks: [
        det({
          id: 'character-id-survives-restart',
          description: '重启前后 CharacterId 必须相同',
          metric: 'CharacterIdContinuity',
          check: (observation) => {
            const before = (observation.attributes?.fingerprintBefore as
              | { characterId: string }
              | undefined)?.characterId
            const after = (observation.attributes?.fingerprintAfter as
              | { characterId: string }
              | undefined)?.characterId
            if (!before || !after) return fail('装置没有留下重启前后的指纹')
            return before === after
              ? pass(`characterId=${after}`)
              : fail(`重启后 CharacterId 变了：${before} → ${after}`)
          },
        }),
        det({
          id: 'seed-survives-restart',
          description: '重启前后 Seed 版本与指纹必须相同',
          metric: 'IdentityStabilityRate',
          check: (observation) => {
            const before = observation.attributes?.fingerprintBefore as
              | { seedVersion: number; snapshotHash: string }
              | undefined
            const after = observation.attributes?.fingerprintAfter as
              | { seedVersion: number; snapshotHash: string }
              | undefined
            if (!before || !after) return fail('装置没有留下重启前后的指纹')
            if (before.seedVersion !== after.seedVersion) {
              return fail(`重启后 Seed 版本变了：v${before.seedVersion} → v${after.seedVersion}`)
            }
            if (before.snapshotHash !== after.snapshotHash) {
              return fail('重启后 Seed 指纹变了（库里的人格与重启前不是同一份）')
            }
            return pass(`v${after.seedVersion} 指纹一致（${after.snapshotHash.slice(0, 12)}）`)
          },
        }),
        det({
          id: 'seed-history-preserved',
          description: '重启不会重建建档：Seed 历史必须还在（不小于 1 条）',
          metric: 'SeedMutationViolationCount',
          check: (observation) => {
            const count = observation.attributes?.seedVersionCount
            if (typeof count !== 'number' || count < 1) {
              return fail(
                `重启后 Seed 历史有 ${String(count)} 条。空历史说明重启被当成了首次建档，` +
                  '那样"她是什么时候变的"就丢了。'
              )
            }
            return pass(`历史 ${count} 条`)
          },
        }),
        det({
          id: 'conversation-id-kept-across-restart',
          description: '重启不换会话：ConversationId 必须相同',
          metric: 'CharacterIdContinuity',
          check: (observation) => {
            const before = observation.attributes?.conversationBefore
            const after = observation.attributes?.conversationAfter
            if (typeof before !== 'string' || typeof after !== 'string') {
              return fail('装置没有留下重启前后的会话 id')
            }
            return before === after
              ? pass(`conversationId=${after}`)
              : fail(`重启把会话换掉了：${before} → ${after}（重启不是新会话）`)
          },
        }),
      ],
    },

    {
      id: 'M3-RST-002',
      description: 'T1 续聊：重启之后的下一轮，会话内序号与角色级序号都必须接得上',
      metric: 'SESSION',
      tags: ['session','restart','t1'],
      requiresModel: false,
      turns: [
        { user: '重启之后第一句。' },
        { user: '重启之后第二句。' },
      ],
      fixture: async (facade) => {
        const before = await facade.say('重启之前的一句。')
        const watermark = await facade.ledger(50)
        await facade.restart()
        return {
          observations: [before],
          attributes: {
            ledgerSizeBefore: watermark.length,
            // 重启之后的**当前**会话内最大序号（装置读一次，供检查比较）
            maxSequenceBefore: Math.max(0, ...watermark.map((event) => event.conversationSequence)),
          },
        }
      },
      checks: [
        det({
          id: 'conversation-sequence-continues-after-restart',
          description: '重启后的第一轮必须从"库里的最大序号 + 1"继续，而不是从 1 重来',
          metric: 'ConversationEventLossRate',
          check: (observation) => {
            const previous = observation.attributes?.maxSequenceBefore
            if (typeof previous !== 'number') return fail('装置没有留下重启前的最大序号')
            const events = observation.newEvents
            const sequences = events.map((event) => event.conversationSequence)
            const smallest = Math.min(...sequences)
            if (smallest <= previous) {
              return fail(
                `重启后序号从 ${smallest} 开始，而重启前已经到 ${previous}。` +
                  '从 1 重来会**覆盖**既有事件（幂等命中），等于把重启后说的话丢了 —— ' +
                  '这正是 ConversationEventLossRate 要抓的事故。'
              )
            }
            return pass(`重启前 ${previous} → 重启后从 ${smallest} 开始`)
          },
        }),
        det({
          id: 'restart-does-not-disturb-ordering',
          description: '重启之后角色级序号仍然严格递增',
          metric: 'EventOrderingErrorRate',
          check: (observation) => sequencesStrictlyIncreasing(observation.newEvents),
        }),
        det({
          id: 'restart-does-not-break-provenance',
          description: '重启之后来源标签仍然自洽',
          metric: 'SourceClassificationAccuracy',
          check: (observation) =>
            everyEvent(observation.newEvents, provenanceConsistent, '重启后来源自洽'),
        }),
      ],
    },

    {
      id: 'M3-RST-003',
      description: '重启之后没有伪记忆：上下文里的历史必须是账本里真实存在的事件',
      metric: 'SESSION',
      tags: ['session','restart','t1'],
      requiresModel: false,
      // 这两轮由装置驱动（而不是用 `turns`），因为判定需要**重启之后那一轮的完整账本**：
      // 只有把"重新读一遍账本"放在这两轮**之后**，才能回答
      // "上下文里引用的历史，在账本里真的存在吗"。
      turns: [],
      fixture: async (facade) => {
        await facade.say('（重启前的一句话：我把钥匙放在桌上了。）')
        await facade.restart()
        // 重启之后**真的**跟她说两轮
        const turn1 = await facade.say('重启之后第一句：我们刚才说到哪里了。')
        const turn2 = await facade.say('重启之后第二句：你记得钥匙的事吗。')
        // 两轮都落库之后再读账本 —— 此时"账本里没有的东西"就是伪记忆
        const ledger = await facade.ledger(200)
        return {
          observations: [turn1, turn2],
          attributes: {
            ledgerContents: ledger.map((event) => event.content),
            ledgerSize: ledger.length,
            ledgerSequences: ledger.map((event) => event.conversationSequence),
          },
        }
      },
      checks: [
        det({
          id: 'no-phantom-memory',
          description: '重启后上下文引用的历史，必须能在账本里找到（没有伪记忆）',
          metric: 'IdentityStabilityRate',
          check: (observation) => {
            const ledgerContents = observation.attributes?.ledgerContents as
              | string[]
              | undefined
            if (!Array.isArray(ledgerContents) || ledgerContents.length === 0) {
              return fail('装置没有读到账本内容（无法判定有没有伪记忆）')
            }
            // 她这一轮说的话必须在账本里找得到。找不到有两种可能：
            //   ① 上下文里出现了一条并不存在的事实（伪记忆）
            //   ② 写入失败（事件丢了，属于硬零指标）
            // 两者都必须失败 —— 它们的区别只体现在 detail 里。
            const known = new Set(ledgerContents)
            const missing = observation.newEvents.filter((event) => !known.has(event.content))
            if (missing.length > 0) {
              return fail(
                `${missing.length} 条新增事件的内容不在账本里：` +
                  missing.map((event) => `${event.type}:${event.content.slice(0, 40)}`).join('、')
              )
            }
            return pass(`账本 ${ledgerContents.length} 条，本轮事件全部对得上`)
          },
        }),
        det({
          id: 'reply-has-no-internal-leak',
          description: '重启后的回复不得泄漏内部结构',
          metric: 'IdentityStabilityRate',
          echoAware: true,
          check: (observation) => noInternalLeak(observation.reply),
        }),
        det({
          id: 'sequences-contiguous-in-conversation',
          description: '重启后本会话的会话内序号必须是连续的自然数序列（不跳号、不回退）',
          metric: 'EventOrderingErrorRate',
          check: (observation) => {
            /*
             * ⚠️ 这条检查**只对"本轮新增的事件"**成立，不对整条会话成立。
             *
             * 实测踩到的假失败：重启用例之前会先跑预置轮次把账本写起来，
             * 而"本轮新增"的区间是从 `before`（重启前的最大角色级序号）起的 ——
             * 于是 `observation.newEvents` 里第一条的 `conversationSequence`
             * 可能是 3 而不是 1，看起来"第 1 位是 3"就像跳号。
             *
             * 会话内序号是**会话内的可读账**（"这个会话说到第几句"），
             * 它当然不必从 1 开始对应"本轮的第一次观测"。真正要守的是
             * **增量内部连续**：本轮新增的相邻事件之间不能有洞。
             *
             * 所属指标也从 `ConversationEventLossRate` 改为
             * `EventOrderingErrorRate` —— 前者（计划书第 117 节）的定义是
             * "已经成功处理的输入却没有 ConversationEvent"，
             * 那是**丢失**，不是**乱序**。用错指标会让 CRITICAL 报警
             * 指向错误的方向，而那比不报警更糟。
             */
            return conversationSequencesContiguous(observation.newEvents)
          },
        }),
      ],
    },
  ],
}

export default sessionRestartSuite
