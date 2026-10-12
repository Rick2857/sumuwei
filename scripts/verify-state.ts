/**
 * L1-M2 验收：证明「持久状态 → 模型行为」这条链路真的成立。
 *
 * 方案里这一步的要求很明确（L1-M2 验收标准）：
 *   > 修改数据库里的 valence / trust 后，苏沐薇的回答会明显发生符合逻辑的变化。
 * 并且特别强调：**先手工改状态，不要一开始就写自动更新**。
 * 因为必须先证明 state → behavior 成立，之后才有资格证明 experience → state。
 *
 * 本脚本做对照实验：同一句话，分别在 trust 高 / 低 两种状态下问她，
 * 比较回答的差异。状态全部经数据库读写，不再内存里造假。
 *
 * 跑法：node_modules/.bin/tsx scripts/verify-state.ts
 */
import 'dotenv/config'

// ⚠️ 实验必须隔离：这一行必须在任何会碰数据库的 import 之前。
//    详见 src/dev/sandbox.ts（规矩：实验一律在独立副本上跑，绝不污染真实对话库）
import { isolateDatabase } from '../src/dev/sandbox.ts'
isolateDatabase('verify-state-seq')

import { AgentRuntime, ChannelType, ModelType, stringToUuid, type Memory, type Plugin, type UUID } from '@elizaos/core'
import bootstrapPlugin from '@elizaos/plugin-bootstrap'
import openaiPlugin from '@elizaos/plugin-openai'
import sqlPlugin from '@elizaos/plugin-sql'

import { character } from '../src/character/index.ts'
import { buildTurnContext } from '../src/context/builder.ts'
import { initDatabase } from '../src/db/index.ts'
import { createPersistentCharacterPlugin } from '../src/plugin/persistent-character.ts'
import { openAiCompatiblePlugin } from '../src/providers/openai-compatible.ts'
import { initCharacterState } from '../src/state/init.ts'
import { renderInspector } from '../src/state/inspector.ts'
import { markInteraction, setStateVariable } from '../src/state/repository.ts'

const USER_NAME = process.env.USER_NAME ?? 'Alex'
const characterId = character.id ?? character.name
const userId = stringToUuid(`user-${USER_NAME}`)

const runtime = new AgentRuntime({
  character,
  conversationLength: Number(process.env.CONVERSATION_LENGTH ?? 16),
  settings: {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? '',
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? 'https://api.deepseek.com',
    OPENAI_LARGE_MODEL: process.env.OPENAI_LARGE_MODEL ?? 'deepseek-flash',
    OPENAI_SMALL_MODEL: process.env.OPENAI_SMALL_MODEL ?? 'deepseek-flash',
  },
  plugins: [
    openaiPlugin,
    bootstrapPlugin,
    openAiCompatiblePlugin,
    createPersistentCharacterPlugin({ characterId, userId }),
  ] as Plugin[],
})

await initDatabase(runtime, sqlPlugin)
await initCharacterState(runtime, characterId, userId)
await runtime.initialize()

// --- 造一个干净的对话环境 ---
const agentId = runtime.agentId as UUID
const agentEntityId = stringToUuid(`agent-entity-${characterId}`)
const worldId = stringToUuid(`world-${characterId}`)
// ⚠️ 用独立房间：验收绝不能跑在真实对话房间里，否则低信任状态下生成的
//    「你是谁」这类回复会写进真实历史，长期污染后续对话（详见 verify-state-clean.ts 注释）
const roomId = stringToUuid(`room-verify-seq-${USER_NAME}`)

await runtime.ensureWorldExists({ id: worldId, name: `${character.name}'s World`, agentId })
await runtime.ensureEntity({ id: agentEntityId, names: [character.name], agentId, metadata: {} })
await runtime.ensureEntity({ id: userId, names: [USER_NAME], agentId, metadata: {} })
await runtime.ensureRoomExists({ id: roomId, name: 'verify', source: 'cli', type: ChannelType.DM, worldId })
await runtime.ensureParticipantInRoom(agentEntityId, roomId)
await runtime.ensureParticipantInRoom(userId, roomId)

let turn = 0

/** 跑一轮真实对话（消息落库 + 状态锚点推进 + 组装上下文 + 调模型） */
async function ask(question: string): Promise<string> {
  turn += 1
  const message: Memory = {
    // 一次性 id：验收不写脏历史，避免影响后续对话
    id: stringToUuid(`verify-${Date.now()}-${turn}`),
    entityId: userId,
    agentId,
    roomId,
    worldId,
    content: { text: question, source: 'cli', channelType: ChannelType.DM },
  }
  await runtime.createMemory(message, 'messages', true)
  await markInteraction(runtime, characterId, userId)

  const ctx = await buildTurnContext(runtime, message)
  const providerNames = ctx.contributions.map((c) => c.name)
  console.log(
    `    [上下文] ${providerNames.join(', ')} | prompt ${ctx.prompt.length} 字符`
  )
  if (!providerNames.includes('CHARACTER_STATE')) {
    throw new Error('CHARACTER_STATE provider 没有进入上下文，验收无效')
  }

  const reply = await runtime.useModel(ModelType.TEXT_LARGE, { prompt: ctx.prompt })
  return typeof reply === 'string' ? reply : String(reply)
}

async function setState(variable: 'trust' | 'closeness' | 'valence' | 'arousal', value: number, reason: string) {
  const { before, after } = await setStateVariable(runtime, characterId, userId, variable, value, reason)
  console.log(
    `  [改状态] ${variable}: ${before[variable].toFixed(2)} → ${after[variable].toFixed(2)}（v${before.version} → v${after.version}）`
  )
}

const QUESTION = '我有件比较重要的事情想告诉你。'

console.log('\n================ Inspector（初始）================')
console.log(await renderInspector(runtime, characterId, userId, { events: 3 }))

console.log('\n================ 实验 A：高信任（trust = 0.85）================')
await setState('trust', 0.85, '验收实验 A：设定为高信任基线')
console.log(`  问：${QUESTION}`)
const replyHigh = await ask(QUESTION)
console.log(`  苏沐薇：${replyHigh}`)

console.log('\n================ 实验 B：低信任（trust = 0.15）================')
await setState('trust', 0.15, '验收实验 B：人为压低信任，观察回复是否变化')
console.log(`  问：${QUESTION}`)
const replyLow = await ask(QUESTION)
console.log(`  苏沐薇：${replyLow}`)

console.log('\n================ 实验 C：低亲近 + 负面情绪 ================')
await setState('trust', 0.85, '恢复信任，单独考察亲近与情绪')
await setState('closeness', 0.2, '验收实验 C：设定为疏远')
await setState('valence', -0.7, '验收实验 C：设定为明显负面情绪')
await setState('arousal', 0.7, '验收实验 C：设定为情绪激动')
console.log(`  问：${QUESTION}`)
const replyCold = await ask(QUESTION)
console.log(`  苏沐薇：${replyCold}`)

console.log('\n================ Inspector（最终）================')
console.log(await renderInspector(runtime, characterId, userId, { events: 8 }))

console.log('\n================ 验收结论 ================')
console.log(`A（trust 0.85）：${replyHigh}`)
console.log(`B（trust 0.15）：${replyLow}`)
console.log(`C（疏远+负面+激动）：${replyCold}`)
console.log(
  `\nA 与 B 是否不同：${replyHigh.trim() === replyLow.trim() ? '❌ 相同（状态未影响行为）' : '✅ 不同'}`
)

await runtime.stop()
process.exit(0)
