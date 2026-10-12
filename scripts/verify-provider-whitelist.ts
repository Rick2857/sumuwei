/**
 * Provider 白名单验证：为什么需要它、它省了什么、它消掉了哪个报错。
 *
 * ============================================================================
 *  这条测试守的是两件具体的事
 * ============================================================================
 *   1. **SETTINGS provider 的启动噪声不会回来。**
 *      bootstrap 的 SETTINGS provider 把 DM 房间当成"首次引导"，去找
 *      "属于该用户的、metadata.settings 已初始化的 world"。我们的 world 是
 *      用角色身份建的，所以它必然抛：
 *
 *        [PLUGIN:BOOTSTRAP:PROVIDER:SETTINGS] No world found for user during onboarding
 *        [PLUGIN:BOOTSTRAP:PROVIDER:SETTINGS] Critical error in settings provider
 *          (error=No server ownership found for onboarding)
 *
 *      它只提供"服务器/世界级配置"，本项目从不使用，出错后返回空文本、
 *      不影响其余 provider（回复与记忆都正常）—— 但它每次启动刷两条 error，
 *      会掩盖真正的错误。
 *
 *   2. **新链路的 prompt 不被工具调用体系污染。**
 *      不加白名单时 ACTIONS / ACTION_STATE / CHOICE / PROVIDERS 会占掉
 *      约 3500 字符（工具调用的提示词，苏沐薇现在没有任何 action），
 *      还会诱导模型朝"输出动作"的方向走。
 *
 * 跑法：node_modules/.bin/tsx scripts/verify-provider-whitelist.ts
 */

import 'dotenv/config'

import {
  AgentRuntime,
  ChannelType,
  stringToUuid,
  type Character,
  type Memory,
  type UUID,
} from '@elizaos/core'
import sqlPlugin from '@elizaos/plugin-sql'
import bootstrapPlugin from '@elizaos/plugin-bootstrap'

import { isolateDatabase } from '../src/dev/sandbox.ts'
isolateDatabase('provider-whitelist')

import { character } from '../src/character/index.ts'
import { initDatabase } from '../src/db/index.ts'
import { buildTurnContext } from '../src/context/builder.ts'
import { CONVERSATION_PROVIDERS, buildWhitelistedContext } from '../src/infrastructure/runtime/adapters.ts'
import { createPersistentCharacterPlugin } from '../src/plugin/persistent-character.ts'

let passed = 0
let failed = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (ok) {
    passed += 1
    console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    failed += 1
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/** 捕获 provider 的 error 日志（bootstrap 用 logger.error） */
const onboardingErrors: string[] = []
const originalError = console.error
console.error = (...args: unknown[]): void => {
  const text = args.map((a) => (typeof a === 'string' ? a : '')).join(' ')
  if (text.includes('onboarding') || text.includes('settings provider')) onboardingErrors.push(text)
  originalError(...args)
}

console.log('='.repeat(72))
console.log('Provider 白名单验证')
console.log('='.repeat(72))

const userId = stringToUuid('user-Alex')
const runtime = new AgentRuntime({
  character: character as Character,
  settings: {},
  plugins: [
    bootstrapPlugin,
    createPersistentCharacterPlugin({ characterId: character.id ?? character.name, userId }),
  ] as never,
})
await initDatabase(runtime, sqlPlugin)
await runtime.initialize()

const agentId = runtime.agentId as UUID
const worldId = stringToUuid('world-whitelist')
const roomId = stringToUuid('room-whitelist')
const agentEntityId = stringToUuid('agent-entity-whitelist')

await runtime.ensureWorldExists({ id: worldId, name: 'w', agentId })
await runtime.ensureEntity({ id: agentEntityId, names: [character.name], agentId, metadata: {} })
await runtime.ensureEntity({ id: userId, names: ['Alex'], agentId, metadata: {} })
await runtime.ensureRoomExists({
  id: roomId,
  name: 'r',
  source: 'cli',
  type: ChannelType.DM,
  worldId,
})
await runtime.ensureParticipantInRoom(agentEntityId, roomId)
await runtime.ensureParticipantInRoom(userId, roomId)

const makeMessage = (tag: string): Memory => ({
  // ⚠️ 每次换 id：composeState 按 message.id 缓存 state，
  //    复用同一个 id 会让后一次调用直接拿到前一次的 provider 结果。
  id: stringToUuid(`whitelist-${tag}`),
  entityId: userId,
  agentId,
  roomId,
  worldId,
  content: { text: '你好。', source: 'cli', channelType: ChannelType.DM },
})

// ---------------------------------------------------------------------------
console.log('\n=== 1. 注册的 provider（了解全貌）===')
const roster = runtime.providers.map((p) => p.name).sort()
console.log(`  共 ${roster.length} 个：${roster.join(', ')}`)

// ---------------------------------------------------------------------------
console.log('\n=== 2. 复现：不加白名单时会发生什么 ===')
onboardingErrors.length = 0
const full = await buildTurnContext(runtime, makeMessage('full'))
const fullNames = full.contributions.map((c) => c.name)
console.log(`  贡献：${full.contributions.map((c) => `${c.name}(${c.chars})`).join(', ')}`)
console.log(`  prompt ${full.prompt.length} 字符`)

check(
  '复现了 SETTINGS 的 onboarding 报错（否则下面的"消失"说明不了问题）',
  onboardingErrors.length > 0,
  `${onboardingErrors.length} 条`,
)
check('全量模式下 SETTINGS 确实进了上下文', fullNames.includes('SETTINGS'))
check(
  '全量模式包含工具调用体系（ACTIONS / PROVIDERS / ACTION_STATE / CHOICE）',
  ['ACTIONS', 'PROVIDERS', 'ACTION_STATE', 'CHOICE'].every((n) => fullNames.includes(n)),
  fullNames.filter((n) => ['ACTIONS', 'PROVIDERS', 'ACTION_STATE', 'CHOICE'].includes(n)).join(', '),
)

// ---------------------------------------------------------------------------
console.log('\n=== 3. 白名单：只跑对话需要的 provider ===')
onboardingErrors.length = 0
const limited = await buildWhitelistedContext(runtime, makeMessage('limited'))
const limitedNames = limited.contributions.map((c) => c.name)
console.log(`  贡献：${limited.contributions.map((c) => `${c.name}(${c.chars})`).join(', ')}`)
console.log(`  prompt ${limited.prompt.length} 字符`)

check(
  '白名单模式下 SETTINGS 不再进上下文',
  !limitedNames.includes('SETTINGS'),
  limitedNames.join(', '),
)
check(
  'onboarding 报错消失（这是本次修复的直接目标）',
  onboardingErrors.length === 0,
  onboardingErrors.length === 0 ? '零报错' : onboardingErrors[0].slice(0, 100),
)
check(
  '工具调用体系的 provider 被排除',
  !['ACTIONS', 'PROVIDERS', 'ACTION_STATE', 'CHOICE'].some((n) => limitedNames.includes(n)),
  limitedNames.join(', '),
)
check(
  '对话必需的 provider 都在',
  ['CHARACTER', 'CHARACTER_STATE', 'RECENT_MESSAGES'].every((n) => limitedNames.includes(n)),
  limitedNames.join(', '),
)
check(
  '白名单只含已登记的 provider 名（没有拼写错误导致的静默缺失）',
  CONVERSATION_PROVIDERS.every((name) => limitedNames.includes(name)),
  `声明 ${CONVERSATION_PROVIDERS.length} 个，实际出现 ${limitedNames.length} 个`,
)

// ---------------------------------------------------------------------------
console.log('\n=== 4. 省下的量 ===')
const saved = full.prompt.length - limited.prompt.length
check(
  '白名单显著缩短 prompt（省下的主要是工具调用提示词）',
  saved > 2000,
  `${full.prompt.length} → ${limited.prompt.length}（省 ${saved} 字符，约 ${((saved / full.prompt.length) * 100).toFixed(0)}%）`,
)
check(
  '省下的部分不含人设与状态（那些必须保留）',
  limited.prompt.includes('苏沐薇') || limitedNames.includes('CHARACTER'),
  'CHARACTER 仍在',
)

// ---------------------------------------------------------------------------
console.log('\n=== 5. 确定性：同一白名单连续跑，组成稳定 ===')
const again = await buildWhitelistedContext(runtime, makeMessage('limited-2'))
check(
  '两次白名单组装的 provider 组成一致',
  JSON.stringify(again.contributions.map((c) => c.name)) === JSON.stringify(limitedNames),
  again.contributions.map((c) => c.name).join(', '),
)

console.error = originalError
console.log(`\n${'='.repeat(72)}`)
console.log(`Provider 白名单验证：${passed} 通过 / ${failed} 失败`)
console.log('='.repeat(72))

await runtime.stop()
process.exit(failed === 0 ? 0 : 1)
