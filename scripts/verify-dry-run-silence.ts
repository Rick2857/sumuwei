/**
 * 干跑（--test）必须**一个字都不写**，包括 M2.5 的新表。
 *
 * 为什么值得单独一条测试：
 *   M2.5 之后"测试不写入记忆"这条规矩要多覆盖四张表
 *   （conversation_events / character_domain_events / character_projections
 *    / character_traces）。少守一张，用户就会在某天发现
 *   "我只是试了一句，怎么她的经历里多了一条"。
 *
 * 本脚本在**沙箱**里跑完整的真实模型链路（--test 语义），
 * 然后逐表比对前后行数。
 *
 * 跑法：node_modules/.bin/tsx scripts/verify-dry-run-silence.ts
 */

import 'dotenv/config'

import { AgentRuntime, type Character } from '@elizaos/core'
import sqlPlugin from '@elizaos/plugin-sql'
import { sql } from 'drizzle-orm'

import { isolateDatabase } from '../src/dev/sandbox.ts'
isolateDatabase('dry-run-silence')

import { character } from '../src/character/index.ts'
import { initDatabase } from '../src/db/index.ts'
import { rowsOf } from '../src/infrastructure/persistence/db.ts'
import { initKernel } from '../src/kernel/app/kernel.ts'
import { TurnGateway } from '../src/kernel/app/turn-gateway.ts'
import type { ActionTurnPort } from '../src/kernel/action/action-turn.ts'
import { ConversationRecorder } from '../src/infrastructure/runtime/conversation-recorder.ts'
import { characterDefinitionFromCharacter } from '../src/infrastructure/runtime/seed-projection.ts'
import { asConversationId, newTraceId } from '../src/kernel/contracts/index.ts'
import { recentContextLinesFrom, renderCriticalStateSection } from '../src/infrastructure/runtime/adapters.ts'
import { initCharacterState } from '../src/state/init.ts'
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

console.log('='.repeat(72))
console.log('干跑静默性验证：--test 不写任何一张表（含 M2.5 的四张新表）')
console.log('='.repeat(72))

const TABLES = [
  'memories',
  'character_states',
  'state_events',
  'conversation_events',
  'character_domain_events',
  'character_projections',
  'character_traces',
  'processed_operations',
  'character_jobs',
]

const userId = '00000000-0000-4000-8000-0000000000aa'
const definition = characterDefinitionFromCharacter(character, { now: 0 })
const runtime = new AgentRuntime({
  character: character as Character,
  plugins: [createPersistentCharacterPlugin({ characterId: definition.id, userId })] as never,
  settings: {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? '',
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? 'https://api.deepseek.com',
    OPENAI_LARGE_MODEL: process.env.OPENAI_LARGE_MODEL ?? 'deepseek-flash',
  },
})

await initDatabase(runtime, sqlPlugin)
await runtime.initialize()
await initCharacterState(runtime, String(definition.id), userId)
// 注意：initKernel 收的是 **runtime**（它自己去找底层句柄），
// 而不是 db —— 传 db 会让 getRawDb 找不到 adapter。
const kernel = await initKernel(runtime, { definition })
const db = kernel.stores.db

const snapshot = async (): Promise<Record<string, number>> => {
  const out: Record<string, number> = {}
  for (const table of TABLES) {
    try {
      const rows = rowsOf(await db.execute(sql.raw(`select count(*)::int as c from ${table}`)))
      out[table] = Number(rows[0]?.c ?? 0)
    } catch {
      out[table] = -1 // 表不存在
    }
  }
  return out
}

const conversationId = asConversationId(`dm-${definition.slug}-dryrun`)

// 先做一轮**真实**对话（dryRun=false），确认新链路确实会写库
const writeRecorder = new ConversationRecorder({
  db: kernel.stores.db,
  characterId: kernel.characterId,
  conversationId,
  dryRun: false,
  userName: 'Alex',
  characterName: definition.name,
})
let seq = 1
/*
 * M4.5：干跑必须**不执行动作**。
 *
 * 用一个**计数用的假端口**来验证这件事：它不碰文件系统、不写账本，
 * 只记录"turn-gateway 有没有来问过它"。
 *
 * 这样测的是**结构**（干跑分支根本没调用动作路径），
 * 而不是"某个能力恰好没写文件"—— 后者会被"什么都没做"骗过。
 */
const actionCalls = { nonDry: 0, dry: 0 }
const fakeActionWriter = (counter: () => void): ActionTurnPort => ({
  async handleTurn() {
    counter()
    return { kind: 'not_applicable' }
  },
})

const writeGateway = new TurnGateway({
  kernel,
  definition,
  // M3：身份来自快照（一轮一次），网关自己不读 Seed
  identity: kernel.identitySnapshot,
  recorder: writeRecorder,
  conversationSequence: () => seq,
  modelProfile: 'dry-run-silence-test',
  actionWriter: fakeActionWriter(() => (actionCalls.nonDry += 1)),
  actionEnabled: true,
})

const before = await snapshot()
const turn1 = await writeGateway.beginTurn('先把账本写起来。')
seq = turn1.conversationSequence + 1
const packet1 = await writeGateway.compileTurn({
  turn: turn1,
  currentInput: '先把账本写起来。',
  recentLines: await recentContextLinesFrom(runtime, {
    characterId: kernel.characterId,
    userName: 'Alex',
    characterName: definition.name,
    limit: 10,
  }),
  stateSection: await renderCriticalStateSection(runtime, String(kernel.characterId), userId),
})
void packet1
await writeGateway.completeTurn({ turn: turn1, replyText: '（写库那轮）', modelDurationMs: 1 })
const afterWrite = await snapshot()

check(
  '对照：非干跑确实会写账本（否则下面的"没写"说明不了问题）',
  afterWrite.conversation_events > before.conversation_events &&
    afterWrite.character_domain_events > before.character_domain_events &&
    afterWrite.character_traces > before.character_traces,
  `conversation_events ${before.conversation_events} → ${afterWrite.conversation_events}, ` +
    `domain_events ${before.character_domain_events} → ${afterWrite.character_domain_events}, ` +
    `traces ${before.character_traces} → ${afterWrite.character_traces}`,
)

// 再跑一轮**干跑**，逐表比对
const dryRecorder = new ConversationRecorder({
  db: kernel.stores.db,
  characterId: kernel.characterId,
  conversationId,
  dryRun: true,
  userName: 'Alex',
  characterName: definition.name,
})
const dryGateway = new TurnGateway({
  kernel,
  definition,
  // M3：干跑网关同样需要身份快照（它不落库，但仍要能回答"用了哪版人格"）
  identity: kernel.identitySnapshot,
  recorder: dryRecorder,
  conversationSequence: () => seq,
  modelProfile: 'dry-run-silence-test',
  dryRun: true,
  actionWriter: fakeActionWriter(() => (actionCalls.dry += 1)),
  actionEnabled: true,
})

const beforeDry = await snapshot()
const turn2 = await dryGateway.beginTurn('这句只是试试。')
const packet2 = await dryGateway.compileTurn({
  turn: turn2,
  currentInput: '这句只是试试。',
  recentLines: await recentContextLinesFrom(runtime, {
    characterId: kernel.characterId,
    userName: 'Alex',
    characterName: definition.name,
    limit: 10,
  }),
  stateSection: await renderCriticalStateSection(runtime, String(kernel.characterId), userId),
})
const outgoing2 = await dryGateway.completeTurn({
  turn: turn2,
  replyText: '（干跑那轮）',
  modelDurationMs: 1,
})
const afterDry = await snapshot()

check('干跑不写 ConversationEvent', afterDry.conversation_events === beforeDry.conversation_events)
check('干跑不写 DomainEvent', afterDry.character_domain_events === beforeDry.character_domain_events)
check('干跑不动 Projection', afterDry.character_projections === beforeDry.character_projections)
check('干跑不写 Trace', afterDry.character_traces === beforeDry.character_traces)
check('干跑不写幂等记录', afterDry.processed_operations === beforeDry.processed_operations)
check('干跑不写 job', afterDry.character_jobs === beforeDry.character_jobs)
check('干跑不改 M2 的 memories / character_states / state_events', 
  afterDry.memories === beforeDry.memories &&
  afterDry.character_states === beforeDry.character_states &&
  afterDry.state_events === beforeDry.state_events)

/*
 * M4.5：**干跑不执行动作**（计划书 §61 第 9 条的对偶面）。
 *
 * ⚠️ 判据是"turn-gateway 有没有去调用动作端口"，而不是"某个文件有没有被写"：
 *    后者会被"这一轮恰好没有动作意图"骗过。前者是结构性的 ——
 *    干跑分支里那段代码根本不会被执行。
 */
check(
  '对照：非干跑确实会走动作路径（否则下面的"没走"说明不了问题）',
  actionCalls.nonDry === 1,
  `nonDry=${actionCalls.nonDry}`,
)
check(
  '干跑**完全不调用**动作端口（干跑下不会写任何文件）',
  actionCalls.dry === 0,
  `dry=${actionCalls.dry}`,
)

// 但干跑必须**仍然编译上下文**（否则 --test 就看不到新路径的 prompt 了）
check(
  '干跑仍产出完整 ContextPacket（能观察 prompt）',
  packet2.sections.length > 0 && packet2.compilerVersion.startsWith('context-compiler@'),
  `sections=[${packet2.sections.map((s) => s.id).join(', ')}] ${packet2.compilerVersion}`,
)
check(
  '干跑的返回值里带回了 section 信息（调用方仍可打印）',
  outgoing2.trace.contextSectionIds.length > 0,
  outgoing2.trace.contextSectionIds.join(','),
)
check(
  '干跑的输入事件是显式占位而不是编造的真实 id',
  String(outgoing2.trace.inputEventId).includes('dry-run'),
  String(outgoing2.trace.inputEventId),
)

const diff = TABLES.filter((t) => afterDry[t] !== beforeDry[t])
check('九张表逐一比对：全部零变化', diff.length === 0, diff.length ? `变了：${diff.join(', ')}` : '零变化')

// ---------------------------------------------------------------------------
// 回归：**只编译、不 beginTurn** 时绝不能写库（`--dump-prompt` 的处境）
// ---------------------------------------------------------------------------
// 这里曾经出过一个把命令挂死的 bug：
//   `--dump-prompt` 复用 `compileTurn` 编译上下文，但从未 beginTurn，
//   而 compileTurn 里的 appendStep 会去 UPDATE 一条不存在的 trace →
//   抛 `trace_not_found`，命令不返回、文件不落盘（实测挂 240 秒）。
//
// 因此这条用例专门构造"合成轮次"（userEvent / assistantSequence 皆 undefined），
// 走一遍真实网关与只读网关，两边都必须不写库。
console.log('\n=== 回归：合成轮次（无 beginTurn）不得写库 ===')
const synthetic = async (gateway: TurnGateway, tag: string): Promise<string> => {
  const packet = await gateway.compileTurn({
    turn: {
      userEvent: undefined,
      assistantSequence: undefined,
      conversationSequence: 1,
      traceId: newTraceId(),
    },
    currentInput: `合成轮次 ${tag}`,
    recentLines: [],
    stateSection: undefined,
  })
  return packet.compilerVersion
}

const beforeSynthetic = await snapshot()
const realVersion = await synthetic(writeGateway, '真实网关')
check(
  '真实网关在合成轮次下不抛错（trace 不存在时跳过写 step，而不是报错）',
  realVersion.startsWith('context-compiler@'),
  realVersion,
)
const dryVersion = await synthetic(dryGateway, '只读网关')
check('只读网关在合成轮次下正常返回', dryVersion.startsWith('context-compiler@'), dryVersion)
const afterSynthetic = await snapshot()
const syntheticDiff = TABLES.filter((t) => afterSynthetic[t] !== beforeSynthetic[t])
check(
  '合成轮次结束后九张表仍然零变化（--dump-prompt 是只读命令）',
  syntheticDiff.length === 0,
  syntheticDiff.length ? `变了：${syntheticDiff.join(', ')}` : '零变化',
)

console.log(`\n${'='.repeat(72)}`)
console.log(`干跑静默性：${passed} 通过 / ${failed} 失败`)
console.log('='.repeat(72))

await runtime.stop()
process.exit(failed === 0 ? 0 : 1)
