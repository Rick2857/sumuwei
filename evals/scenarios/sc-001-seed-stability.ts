/**
 * SC-001 Seed Stability —— 多轮无关对话之后，她还是同一个苏沐薇。
 *
 * ============================================================================
 *  这条为什么是第一条
 * ============================================================================
 * 一个"持续存在的角色"最先要证明的事，不是她记得多少，而是
 * **她没有被对话改写成别人**。
 *
 * 检查点：
 *   1. 大量轮次之后，进入上下文的 Seed 文本**逐字节不变**
 *      （Seed 渲染是纯函数，所以这必须成立；若哪天不成立，说明有人
 *       把可变内容混进了 Seed）
 *   2. 每一轮的 seed-identity section 都没有被预算裁掉
 *   3. 重开进程（同一数据目录）后 Seed 仍是同一版本、同一内容
 *      —— "重启后她还是她"
 */

import { openKernelOnExistingDir } from '../harness/reopen.ts'
import { identitySectionOf, runScenario, type Scenario } from '../harness/runner.ts'
import { SEED_VERSION } from '../../src/kernel/identity/seed.ts'
import { characterDefinitionFromCharacter } from '../../src/infrastructure/runtime/seed-projection.ts'
import { renderSeedIdentity, seedFingerprint } from '../../src/kernel/contracts/index.ts'
import { character } from '../../src/character/index.ts'

/** 轮数可用环境变量放大：CI 用 40，长跑验收用 100/300（见 verification 报告） */
const TURNS = Number(process.env.M2_5_LONG_TURNS ?? 40)

const UNRELATED_TOPICS = [
  '今天食堂的菜好难吃。',
  '我下周三要考高数。',
  '刚才路过操场看到有人在打球。',
  '你觉得代码写注释重要吗。',
  '手机快没电了。',
  '今天有点困。',
]

export const SC_001: Scenario = {
  id: 'SC-001',
  description: '多轮无关对话后姓名 / 人格 / 语言风格不漂移，重启后仍是同一 Seed',
  initial_state: { freshCharacter: true },
  tags: ['identity', 'seed', 'continuity'],
  version: 1,
  presetTurns: Array.from({ length: TURNS }, (_, i) => UNRELATED_TOPICS[i % UNRELATED_TOPICS.length]),
  turns: ['你还在吗。'],
  assertions: [
    {
      id: 'A1-seed-section-present',
      description: `全部 ${TURNS + 1} 轮的上下文里都必须有未被裁掉的身份 section`,
      check: (_run, ctx) => {
        const turns = ctx.agent.captured
        if (turns.length !== TURNS + 1) {
          throw new Error(`预期 ${TURNS + 1} 轮记录，实际 ${turns.length} 轮`)
        }
        for (const [index, turn] of turns.entries()) {
          // M3：身份锚点的 id 变成 identity-core（v1 编译器仍用 seed-identity）。
          // 断言要检的是"人格锚点必须在"，不是某个固定名字。
          const identity = identitySectionOf(turn.packet)
          if (!identity) {
            throw new Error(`第 ${index + 1} 轮的上下文缺少身份 section`)
          }
          if (turn.packet.droppedSectionIds.includes(identity.id)) {
            throw new Error(`第 ${index + 1} 轮的 ${identity.id} 被预算裁掉了`)
          }
          if (identity.droppable !== false) {
            throw new Error(`第 ${index + 1} 轮的 ${identity.id} 没有标 droppable=false`)
          }
        }
      },
    },
    {
      id: 'A2-seed-text-byte-identical',
      description: '每一轮 prompt 里的 Seed 文本与其他轮逐字节相同',
      check: (_run, ctx) => {
        const rendered = ctx.agent.captured.map(
          (turn) => identitySectionOf(turn.packet)?.content ?? ''
        )
        const first = rendered[0]
        if (first === '') throw new Error('第一轮的身份 section 内容为空')
        for (const [index, text] of rendered.entries()) {
          if (text !== first) {
            throw new Error(`第 ${index + 1} 轮的 Seed 文本与第一轮不同（人格漂移）`)
          }
        }
      },
    },
    {
      id: 'A3-seed-version-unchanged',
      description: 'Seed 版本与渲染结果必须与代码里的定义一致',
      check: async (_run, ctx) => {
        const expected = characterDefinitionFromCharacter(character as never, { now: 0 })
        if (ctx.kernel.definition.seedVersion !== SEED_VERSION) {
          throw new Error(
            `Seed 版本漂移：库里 v${ctx.kernel.definition.seedVersion}，代码 v${SEED_VERSION}`
          )
        }
        const stored = renderSeedIdentity(ctx.kernel.definition)
        const expectedText = renderSeedIdentity(expected)
        if (stored !== expectedText) {
          throw new Error('库里的 Seed 渲染结果与代码定义不一致（有人偷偷改了人设？）')
        }
      },
    },
    {
      id: 'A4-reopen-keeps-identity',
      description: '重开进程（同一数据目录）后 Seed 指纹、版本、对话历史都还在',
      check: async (_run, ctx) => {
        const reopened = await openKernelOnExistingDir(ctx.agent.dataDir)
        try {
          const before = seedFingerprint(ctx.kernel.definition)
          const after = seedFingerprint(reopened.kernel.definition)
          if (before !== after) {
            throw new Error('重启后 Seed 指纹变了')
          }
          if (reopened.kernel.seedCreated) {
            throw new Error('重启时被当成首次建档（说明 Seed 没有真正落库）')
          }
          const events = await reopened.countConversationEvents()
          if (events !== ctx.agent.conversationEvents.length) {
            throw new Error(
              `重启后对话事件数不对：库里 ${events}，本次运行写了 ${ctx.agent.conversationEvents.length}`
            )
          }
          await reopened.close()
        } finally {
          await reopened.close()
        }
      },
    },
  ],
}

export default SC_001
