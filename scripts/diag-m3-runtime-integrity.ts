/**
 * 诊断：运行期（ConversationRecorder 路径）到底有没有完整性校验。
 *
 * ============================================================================
 *  这个脚本是 M3 自查的证据工具，它守着一类真实缺陷
 * ============================================================================
 * M3 第一版实现齐了 `ConversationLedgerPort`（四个具名写入方法）与
 * `ConversationIntegrityService`（四条规则），但**运行期一条都没用**：
 * `ConversationRecorder` 直调仓储层的 `appendConversationEvent`。
 *
 * 后果是具体且可测的（这就是本脚本存在的理由）：
 *   · 悬空 `replyToEventId` 可以写进 append-only 账本 → **永久无法修正**
 *   · 会话内序号可以跳号 → "说到第几句"这张可读账失效
 *   · 身份表运行期 0 行 → "谁是谁"只活在内存推导里
 *
 * 而当时全部测试都是绿的 —— 因为它们测的是那个**从未被调用的类**。
 *
 * ---------------------------------------------------------------------------
 *  两类路径必须分开看（这是本脚本唯一需要解释的地方）
 * ---------------------------------------------------------------------------
 *   A. **recorder 路径**（真实对话走这条）→ 完整性规则**必须**生效
 *   B. **原始仓储层**（`appendConversationEvent`）→ 只保证行级正确，
 *      空隙必须显式 `allowSequenceGap: true` 才允许（历史回填用）
 *
 * 把两者混在一起看会得出错误结论："仓储层能跳号"不等于"她能跳号"。
 * 因此下面每条探针都标明它在测哪条路径。
 *
 * 全部在一次性副本库上跑（`isolateDatabase`），真实库不被触碰。
 *
 * 跑法：tsx scripts/diag-m3-runtime-integrity.ts
 */

import type { Character, Plugin } from '../src/infrastructure/runtime/eliza-types.ts'
import { createThinHostRuntime } from '../src/infrastructure/runtime/thin-host-factory.ts'
import 'dotenv/config'

import { isolateDatabase } from '../src/dev/sandbox.ts'

import { stringToUuid } from '../src/kernel/contracts/uuid.ts'




import { sql } from 'drizzle-orm'

import { character } from '../src/character/index.ts'
import { initDatabase } from '../src/db/index.ts'
import { initKernel } from '../src/kernel/app/kernel.ts'
import { ConversationRecorder } from '../src/infrastructure/runtime/conversation-recorder.ts'
import { characterDefinitionFromCharacter } from '../src/infrastructure/runtime/seed-projection.ts'
import { openAiCompatiblePlugin } from '../src/providers/openai-compatible.ts'
import { allocateSequenceRange } from '../src/infrastructure/persistence/sequence.ts'
import { exec } from '../src/infrastructure/persistence/db.ts'
import { appendConversationEvent } from '../src/infrastructure/persistence/conversation-store.ts'
import { asConversationId, asConversationEventId } from '../src/kernel/contracts/index.ts'

isolateDatabase('diag-m3-runtime-integrity')

const characterId = character.id ?? character.name
const userId = stringToUuid('user-Alex')

const runtime = createThinHostRuntime({
    character: character,
    settings: {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? '',
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? 'https://api.deepseek.com',
    OPENAI_LARGE_MODEL: process.env.OPENAI_LARGE_MODEL ?? 'deepseek-flash',
    OPENAI_SMALL_MODEL: process.env.OPENAI_SMALL_MODEL ?? 'deepseek-flash',
  },
    conversationLength: 16,
  })

await initDatabase(runtime)
await runtime.initialize()

const kernel = await initKernel(runtime, {
  definition: characterDefinitionFromCharacter(character as never),
})

const conversationId = asConversationId(`dm-enforcement-probe-${String(userId).slice(0, 8)}`)
const recorder = new ConversationRecorder({
  db: kernel.stores.db,
  characterId: kernel.characterId,
  conversationId,
  dryRun: false,
  userName: 'Alex',
  characterName: character.name,
  transport: 'diag',
  userId: String(userId),
  // 与生产同一条推导规则：既有历史里的 userId 就是这个值
  deriveUserId: ({ transport, externalId }) => stringToUuid(`user-${transport}-${externalId}`),
})

let ok = 0
let bad = 0
function report(label: string, good: boolean, detail: string): void {
  if (good) ok += 1
  else bad += 1
  console.log(`  ${good ? '✅' : '❌'} ${label} — ${detail}`)
}

console.log('='.repeat(76))
console.log('运行期强制探针（路径 A = recorder／路径 B = 原始仓储层）')
console.log('='.repeat(76))
console.log(`characterId    = ${String(characterId)}`)
console.log(`conversationId = ${String(conversationId)}`)

// ---------------------------------------------------------------------------
console.log('\n【路径 A】recorder —— 真实对话走这条，规则必须生效')

// A0：正常写入（后面几条探针都依赖它先建立"连续账"）
let firstUser: Awaited<ReturnType<typeof recorder.recordUserMessage>> | undefined
try {
  firstUser = await recorder.recordUserMessage('探针 A0：正常写入。', 1)
  report('A0 正常写入用户消息', firstUser.event !== undefined, String(firstUser.event?.id))
} catch (error) {
  report('A0 正常写入用户消息', false, (error as Error).message)
}

// A1：悬空 reply
try {
  await recorder.recordAssistantMessage({
    text: '在回应一条不存在的事件。',
    conversationSequence: 2,
    characterSequence: 9001,
    replyToEventId: asConversationEventId('cev:does-not-exist-at-all'),
  })
  report('A1 悬空 reply 被拒', false, '写入成功了 —— 规则未生效')
} catch (error) {
  report('A1 悬空 reply 被拒', true, (error as { code?: string }).code ?? (error as Error).message)
}

// A2：assistant 不带 reply
try {
  await recorder.recordAssistantMessage({
    text: '没有 reply。',
    conversationSequence: 2,
    characterSequence: 9001,
  })
  report('A2 assistant 缺 reply 被拒', false, '写入成功了 —— 规则未生效')
} catch (error) {
  report('A2 assistant 缺 reply 被拒', true, (error as { code?: string }).code ?? (error as Error).message)
}

// A3：会话内序号跳号
try {
  await recorder.recordUserMessage('跳号。', 50)
  report('A3 序号跳号被拒', false, '写入成功了 —— 规则未生效')
} catch (error) {
  report('A3 序号跳号被拒', true, (error as { code?: string }).code ?? (error as Error).message)
}

// A4：伪造来源（由 createConversationEvent 的旧闸守着）
try {
  await appendConversationEvent(kernel.stores.db, {
    characterId: kernel.characterId,
    conversationId,
    conversationSequence: 2,
    type: 'user_message',
    actorType: 'character',
    actorId: String(characterId),
    content: '她冒充用户说了句话。',
  })
  report('A4 伪造来源被拒', false, '写入成功了')
} catch (error) {
  report('A4 伪造来源被拒', true, (error as { code?: string }).code ?? (error as Error).message)
}

// A5：连续写入必须照常成功（别把闸做成把正常路径也拦掉）
try {
  const next = await recorder.recordUserMessage('探针 A5：连续写入。', 2)
  report('A5 连续写入不被误拦', next.event !== undefined, String(next.event?.id))
} catch (error) {
  report('A5 连续写入不被误拦', false, (error as Error).message)
}

// A6：身份必须落库
for (const [table, where] of [
  ['user_identities', `user_id = '${String(userId)}'`],
  ['conversation_identities', `conversation_id = '${String(conversationId)}'`],
] as const) {
  const rows = await exec(
    kernel.stores.db,
    sql.raw(`select count(*)::int as c from ${table} where ${where}`),
    `统计 ${table}`
  )
  const count = Number(rows[0]?.c ?? 0)
  report(`A6 ${table} 已落库`, count > 0, `${count} 行`)
}

// ---------------------------------------------------------------------------
console.log('\n【路径 B】原始仓储层 —— 唯一需要 allowSequenceGap 才允许空隙的地方')

try {
  await appendConversationEvent(kernel.stores.db, {
    characterId: kernel.characterId,
    conversationId,
    conversationSequence: 90,
    type: 'system_event',
    actorType: 'system',
    actorId: 'diag',
    content: '未声明就跳号。',
  })
  report('B1 未声明 allowSequenceGap 的跳号被拒', false, '写入成功了 —— 闸未生效')
} catch (error) {
  report('B1 未声明 allowSequenceGap 的跳号被拒', true, (error as { code?: string }).code ?? '被拒')
}

try {
  const explicit = await appendConversationEvent(
    kernel.stores.db,
    {
      characterId: kernel.characterId,
      conversationId,
      conversationSequence: 90,
      type: 'system_event',
      actorType: 'system',
      actorId: 'diag',
      content: '显式声明的跳号（历史回填式）。',
    },
    { allowSequenceGap: true }
  )
  report(
    'B2 显式 allowSequenceGap 才允许，且如实上报 sequenceGap',
    explicit.appended === true && explicit.sequenceGap === true,
    `appended=${explicit.appended} sequenceGap=${String(explicit.sequenceGap)}`
  )
} catch (error) {
  report('B2 显式 allowSequenceGap 才允许', false, (error as Error).message)
}

// ---------------------------------------------------------------------------
console.log('\n【附加】幂等不能被这次收口弄坏')
const range = await allocateSequenceRange(kernel.stores.db, kernel.characterId, 2)
void range
const replay = await recorder.recordUserMessage('探针 A0：正常写入。', 1)
report(
  '同坐标重写仍是幂等命中（不是跳号错误）',
  replay.event !== undefined && String(replay.event.id) === String(firstUser?.event?.id),
  `appended=${String(replay.event?.id)}`
)

// ---------------------------------------------------------------------------
console.log(`\n${'='.repeat(76)}`)
console.log(`探针结果：${ok} 通过 / ${bad} 失败`)
if (bad === 0) {
  console.log('✅ 运行期强制生效：真实对话路径上四条规则都在守，身份也真的落库了')
} else {
  console.log('❌ 有探针未通过 —— 上面每条都标了它在测哪条路径，据此定位')
}
console.log('='.repeat(76))

await runtime.stop()
process.exit(bad === 0 ? 0 : 1)
