/**
 * L1-M2 严格验收：单变量对照实验。
 *
 * 前一版验收（scripts/verify-state.ts）走的是连续多轮会话，
 * 因此 A/B 两组的差异**可能来自对话轮次而非 trust 本身**——那样就无法证明因果。
 *
 * 本脚本消除该混淆：
 *   1. 每组实验使用**独立的 roomId**，Recent Messages 里没有任何历史
 *   2. 每组只问一次，问题完全相同
 *   3. 每组之间唯一变化的就是 CharacterState
 *   4. 打印她实际看到的「状态块」原文，让因果链可见
 *
 * 跑法：node_modules/.bin/tsx scripts/verify-state-clean.ts
 */
import 'dotenv/config'

// ⚠️ 实验必须隔离：这一行必须在任何会碰数据库的 import 之前。
//    详见 src/dev/sandbox.ts（规矩：实验一律在独立副本上跑，绝不污染真实对话库）
import { isolateDatabase } from '../src/dev/sandbox.ts'
isolateDatabase('verify-state-clean')

import {
  AgentRuntime,
  ChannelType,
  ModelType,
  stringToUuid,
  type Memory,
  type Plugin,
  type UUID,
} from '@elizaos/core'
import bootstrapPlugin from '@elizaos/plugin-bootstrap'
import openaiPlugin from '@elizaos/plugin-openai'
import sqlPlugin from '@elizaos/plugin-sql'

import { character } from '../src/character/index.ts'
import { buildTurnContext } from '../src/context/builder.ts'
import { initDatabase } from '../src/db/index.ts'
import { createPersistentCharacterPlugin } from '../src/plugin/persistent-character.ts'
import { openAiCompatiblePlugin } from '../src/providers/openai-compatible.ts'
import { initCharacterState } from '../src/state/init.ts'
import { renderStateBlock, resolveCurrentState } from '../src/state/provider.ts'
import { setStateVariable } from '../src/state/repository.ts'

const USER_NAME = process.env.USER_NAME ?? 'Alex'
const characterId = character.id ?? character.name
const userId = stringToUuid(`user-${USER_NAME}`)

const runtime = new AgentRuntime({
  character,
  conversationLength: 16,
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

const agentId = runtime.agentId as UUID
const agentEntityId = stringToUuid(`agent-entity-${characterId}`)
const worldId = stringToUuid(`world-${characterId}`)
await runtime.ensureWorldExists({ id: worldId, name: `${character.name}'s World`, agentId })
await runtime.ensureEntity({ id: agentEntityId, names: [character.name], agentId, metadata: {} })
await runtime.ensureEntity({ id: userId, names: [USER_NAME], agentId, metadata: {} })

const QUESTION = '我有件比较重要的事情想告诉你。'

/**
 * 一次干净的单轮：独立房间、无历史、只问一次。
 * 注意**不落库消息**，因此不存在任何历史污染，Recent Messages 必然为空。
 */
async function cleanTurn(label: string, roomTag: string): Promise<string> {
  // ⚠️ 验收必须使用**独立于真实对话的房间**（verify-* 前缀）。
  //
  // 踩过的坑：早期版本让验收跑在 `room-dm-{USER}`（真实聊天房间）里，
  // 于是在 trust=0.15 状态下生成的「你是谁」「我又不认识你」这类回复
  // 被写进了真实历史。等状态恢复正常后，**她自己的那些话仍留在上下文里**，
  // 把她继续往"陌生人"方向拉——形成污染自增强，真实对话再也回不到正常状态。
  //
  // 结论：验收与真实对话必须数据隔离。
  const roomId = stringToUuid(`room-verify-clean-${roomTag}-${USER_NAME}`)
  await runtime.ensureRoomExists({
    id: roomId,
    name: `clean-${roomTag}`,
    source: 'cli',
    type: ChannelType.DM,
    worldId,
  })
  await runtime.ensureParticipantInRoom(agentEntityId, roomId)
  await runtime.ensureParticipantInRoom(userId, roomId)

  const message: Memory = {
    id: stringToUuid(`clean-msg-${roomTag}-${Date.now()}`),
    entityId: userId,
    agentId,
    roomId,
    worldId,
    content: { text: QUESTION, source: 'cli', channelType: ChannelType.DM },
  }

  const ctx = await buildTurnContext(runtime, message)
  const hasHistory = ctx.contributions.find((c) => c.name === 'RECENT_MESSAGES')
  console.log(`\n----- ${label} -----`)
  console.log(`  上下文 provider：${ctx.contributions.map((c) => c.name).join(', ')}`)
  console.log(`  RECENT_MESSAGES 贡献字符数：${hasHistory?.chars ?? 0}（0 表示确无历史）`)

  const reply = await runtime.useModel(ModelType.TEXT_LARGE, { prompt: ctx.prompt })
  return typeof reply === 'string' ? reply : String(reply)
}

async function setState(variable: 'trust' | 'closeness' | 'valence' | 'arousal', value: number, reason: string) {
  const { before, after } = await setStateVariable(runtime, characterId, userId, variable, value, reason)
  console.log(`  [改状态] ${variable}: ${before[variable].toFixed(2)} → ${after[variable].toFixed(2)}`)
}

const results: { label: string; state: string; reply: string }[] = []

async function runGroup(
  label: string,
  roomTag: string,
  mutations: [('trust' | 'closeness' | 'valence' | 'arousal'), number, string][]
): Promise<void> {
  for (const [v, value, reason] of mutations) await setState(v, value, reason)

  const { state } = await resolveCurrentState(runtime, characterId, userId)
  const stateSummary = `trust=${state.trust.toFixed(2)} closeness=${state.closeness.toFixed(2)} valence=${state.valence.toFixed(2)} arousal=${state.arousal.toFixed(2)}`

  const reply = await cleanTurn(label, roomTag)
  results.push({ label, state: stateSummary, reply })
  console.log(`  苏沐薇：${reply}`)
}

console.log(`\n统一提问（每组唯一变量为 CharacterState）：${QUESTION}`)
console.log(`当前状态块示例：\n${renderStateBlock((await resolveCurrentState(runtime, characterId, userId)).state).split('\n').slice(0, 12).join('\n')}\n`)

await runGroup('A 高信任 / 亲近', 'a', [
  ['trust', 0.85, '严格验收 A：高信任'],
  ['closeness', 0.6, '严格验收 A：日常亲近'],
  ['valence', 0, '严格验收 A：情绪中性'],
  ['arousal', 0, '严格验收 A：情绪平静'],
])

await runGroup('B 低信任（仅此项与 A 不同）', 'b', [
  ['trust', 0.15, '严格验收 B：低信任（唯一变量）'],
])

await runGroup('C 疏远（仅此项与 A 不同）', 'c', [
  ['trust', 0.85, '严格验收 C：恢复信任'],
  ['closeness', 0.2, '严格验收 C：疏远（唯一变量）'],
])

await runGroup('D 负面且激动（仅此项与 A 不同）', 'd', [
  ['closeness', 0.6, '严格验收 D：恢复亲近'],
  ['valence', -0.7, '严格验收 D：负面情绪'],
  ['arousal', 0.7, '严格验收 D：情绪激动'],
])

console.log('\n\n================== 严格验收结论 ==================')
for (const r of results) {
  console.log(`\n【${r.label}】`)
  console.log(`  状态：${r.state}`)
  console.log(`  回复：${r.reply}`)
}

const unique = new Set(results.map((r) => r.reply.trim()))
console.log(
  `\n四组回复的取值个数：${unique.size}/4 —— ${
    unique.size === 4 ? '✅ 四组各不相同，状态确实在驱动行为' : unique.size > 1 ? '✅ 至少部分不同' : '❌ 完全相同'
  }`
)

await runtime.stop()
process.exit(0)
