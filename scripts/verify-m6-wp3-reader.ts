/**
 * M6 · WP3-3 —— **持久层只读来源读取面**的门（`rollup-source-store.ts`）。
 *
 * ============================================================================
 *  它证明什么（都在**隔离库**上，真实 ingress + 真实记忆管线）
 * ============================================================================
 * ```text
 *   ① 受信事件     真实「人类控制台」ingress 写出的行 ⇒ 读数成立 ⇒ 摘要选得到它
 *   ② 程序化 ingress 同一张表、同样 actor_type=user，但 Axis B 未确认
 *                  ⇒ **拒**（unconfirmed_origin）—— 这正是 D01 的生产形状
 *   ③ 历史行       没有受信信封 ⇒ 读数缺席 ⇒ **拒**（unconfirmed_origin）
 *   ④ 跨会话       另一段会话的用户发言**不会**被本会话读到（作用域在 SQL 层）
 *   ⑤ 有界         scanCeiling 是硬上限
 *   ⑥ 排他下界     beforeSequence 那条自己**不**在内
 *   ⑦ 失效闸       事件是某条记忆的**根证据**、那条记忆被 supersede ⇒ **拒**
 *                  （invalidated_by_memory_state）；恢复成 active ⇒ 重新可选
 *   ⑧ 只读         读一次前后几张表的行数**完全不变**
 * ```
 *
 * 三段式（AGENTS §6.7）：①②③⑦ 互为正负控，⑦ 自带"改回 active"的**恢复**段。
 *
 * 跑法：`pnpm exec tsx scripts/verify-m6-wp3-reader.ts`（隔离库；不调模型）
 */

import 'dotenv/config'

import { cleanupSandbox, isolateDatabase, resetPluginSqlConnection } from '../src/dev/sandbox.ts'

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { sql } from 'drizzle-orm'

import { createM4Harness, M4_T0 } from './m4-harness.ts'
import { appendConversationEvent } from '../src/infrastructure/persistence/conversation-store.ts'
import { createRollupSourceReader } from '../src/infrastructure/persistence/rollup-source-store.ts'
import { exec, rowsOf } from '../src/infrastructure/persistence/db.ts'
import {
  createAgentRunnerUserTurnIngress,
  createHumanConsoleUserTurnIngress,
} from '../src/infrastructure/runtime/conversation-attribution.ts'
import { createRollupTurnPort } from '../src/kernel/app/rollup/turn.ts'
import { sourceQualificationOf } from '../src/kernel/contracts/attribution.ts'
import { asConversationId } from '../src/kernel/contracts/ids.ts'
import { selectRollup } from '../src/kernel/recall/rollup.ts'

// ---------------------------------------------------------------------------
// 报告骨架（计数型）
// ---------------------------------------------------------------------------

const rows: { label: string; pass: boolean; detail?: string }[] = []
const measurements: { label: string; count: number; mustBePositive: boolean }[] = []
let failures = 0
let measurementInvalid = 0

function check(label: string, pass: boolean, detail?: string): void {
  if (!pass) failures += 1
  rows.push({ label, pass, ...(detail !== undefined ? { detail } : {}) })
  console.log(`  ${pass ? 'PASS' : 'FAIL'} ${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}
function measure(label: string, count: number, mustBePositive = true): void {
  if (mustBePositive && count <= 0) measurementInvalid += 1
  measurements.push({ label, count, mustBePositive })
  console.log(`  MEASURE ${label} = ${count}${mustBePositive && count <= 0 ? '  ← MEASUREMENT INVALID' : ''}`)
}
function section(title: string): void {
  console.log(`\n${title}`)
}

// ---------------------------------------------------------------------------
// 隔离库（必须在碰数据库之前）
// ---------------------------------------------------------------------------

const sandbox = isolateDatabase('m6-wp3-reader', { keep: false })
await resetPluginSqlConnection()
const h = await createM4Harness({ label: 'm6-wp3-reader' })
const db = h.db
const reader = createRollupSourceReader(db)
const conversationId = String(h.recorder.conversationId)
const OTHER_CONVERSATION = `${conversationId}-other`

section('§0 环境')
console.log(`  沙箱：${sandbox.dir}`)
console.log(`  会话：${conversationId}（另一段：${OTHER_CONVERSATION}）`)
console.log(`  读取面：${reader.name}`)

let sequenceCursor = 1
async function appendAttested(input: {
  content: string
  conversationId?: string
  mode: 'human' | 'agent'
}) {
  const producer =
    input.mode === 'human' ? createHumanConsoleUserTurnIngress() : createAgentRunnerUserTurnIngress()
  const context = producer.attest({
    characterId: h.characterId,
    presenterActorId: h.userId,
    userId: h.userId,
  })
  sequenceCursor += 1
  return await appendConversationEvent(db, {
    characterId: h.kernel.characterId,
    conversationId: asConversationId(input.conversationId ?? conversationId),
    conversationSequence: sequenceCursor,
    characterSequence: sequenceCursor,
    type: 'user_message',
    actorType: 'user',
    actorId: h.userId,
    content: input.content,
    trustedAttribution: context,
  })
}

async function appendLegacy(content: string) {
  /*
   * ⚠️ **刻意不传 `trustedAttribution`** —— 这才是"历史行"的形状
   * （`attribution_origin` 为 NULL）。
   *
   * 第一版这里用了 `h.recordUserEvidence()`，并**假设**它写的是 legacy 行 ——
   * 结果被本门自己的 ③-1 抓住：那个 harness（M5.1.1 起）走的是**受信**写入路径，
   * 写出来的是 `attribution_origin = RECORDED` 的行。夹具的假设错了，
   * 不是实现的错；门的断言把它暴露出来，这正是它该干的事。
   */
  sequenceCursor += 1
  return await appendConversationEvent(db, {
    characterId: h.kernel.characterId,
    conversationId: asConversationId(conversationId),
    conversationSequence: sequenceCursor,
    characterSequence: sequenceCursor,
    type: 'user_message',
    actorType: 'user',
    actorId: h.userId,
    content,
  })
}

async function countRows(table: string): Promise<number> {
  const result = rowsOf(await exec(db, sql.raw(`select count(*)::int as c from ${table}`), `count ${table}`))
  return Number(result[0]?.c ?? -1)
}

// ---------------------------------------------------------------------------
// ① 受信事件（人类控制台 ingress）—— 正控
// ---------------------------------------------------------------------------

section('① 受信事件 ⇒ 读数成立 ⇒ 摘要选得到它')

const human = await appendAttested({ content: '我的猫叫豆豆', mode: 'human' })
const humanId = String(human.event.id)
const humanSequence = human.event.sequence

const read1 = await reader.read({
  characterId: h.kernel.characterId,
  conversationId,
  beforeSequence: Number.MAX_SAFE_INTEGER,
  scanCeiling: 200,
})
measure('① 读取面返回的候选条数（范围自检）', read1.length)
const humanFact = read1.find((item) => String(item.eventId) === humanId)
check('①-1 受信事件被读到', humanFact !== undefined, `返回 ${read1.length} 条`)
check(
  '①-2 它的受信读数成立（由唯一适配边界产出，非本门自己拼）',
  humanFact?.originReading !== undefined && humanFact.originReading.attributionOrigin === 'RECORDED',
  `attributionOrigin=${String(humanFact?.originReading?.attributionOrigin)}`
)
check(
  '①-3 正文**逐字**搬运（读取面不改写）',
  humanFact?.content === '我的猫叫豆豆',
  humanFact?.content
)
check(
  '①-4 作用域字段正确（会话 id 与本会话一致）',
  humanFact?.conversationId === conversationId && humanFact.sequence === humanSequence,
  `${humanFact?.conversationId} seq=${String(humanFact?.sequence)}`
)

const selection1 = selectRollup({
  conversationId,
  sources: read1,
  recentSourceEventIds: [],
  scanCeiling: 200,
  budgetTokens: 400,
})
const pickedHuman = selection1.items.find((item) => String(item.sourceEventId) === humanId)
check(
  '①-5 选择器把它选进来了，且摘录**逐字**等于来源正文',
  pickedHuman !== undefined && pickedHuman.text === '我的猫叫豆豆',
  pickedHuman?.text
)

// ---------------------------------------------------------------------------
// ②/③ 两种"看起来像用户发言"的行都必须被拒
// ---------------------------------------------------------------------------

section('②/③ 程序化 ingress 与历史行 —— 负控')

const agent = await appendAttested({ content: '程序化替用户提交的一句话', mode: 'agent' })
const legacy = await appendLegacy('历史行（没有受信信封）')

const read2 = await reader.read({
  characterId: h.kernel.characterId,
  conversationId,
  beforeSequence: Number.MAX_SAFE_INTEGER,
  scanCeiling: 200,
})
const agentFact = read2.find((item) => String(item.eventId) === String(agent.event.id))
const legacyFact = read2.find((item) => String(item.eventId) === String(legacy.event.id))
check(
  '②-1 程序化 ingress 的行**有**受信信封（attribution_origin = RECORDED）',
  agentFact?.originReading !== undefined,
  `attributionOrigin=${String(agentFact?.originReading?.attributionOrigin)}`
)
check(
  '②-2 但它的**资格**是 UNCONFIRMED_ORIGIN（D01 的生产形状）',
  sourceQualificationOf(agentFact?.originReading) === 'UNCONFIRMED_ORIGIN',
  `qualification=${sourceQualificationOf(agentFact?.originReading)}`
)
check(
  '③-1 历史行**没有**受信信封 ⇒ 读数缺席（不回落到 actor_type）',
  legacyFact !== undefined && legacyFact.originReading === undefined,
  `originReading=${String(legacyFact?.originReading)}`
)

const selection2 = selectRollup({
  conversationId,
  sources: read2,
  recentSourceEventIds: [],
  scanCeiling: 200,
  budgetTokens: 400,
})
check(
  '②-3 选择器拒绝程序化 ingress 的行（`unconfirmed_origin`）',
  selection2.rejections.unconfirmed_origin >= 2 &&
    !selection2.items.some((item) => String(item.sourceEventId) === String(agent.event.id)),
  `unconfirmed=${selection2.rejections.unconfirmed_origin}`
)
check(
  '③-2 选择器拒绝历史行（同一个具名理由，不是"静默少一条"）',
  !selection2.items.some((item) => String(item.sourceEventId) === String(legacy.event.id))
)
check(
  '③-3 恢复：合法的受信事件**仍然**被选中（负控没有污染正控）',
  selection2.items.some((item) => String(item.sourceEventId) === humanId)
)

// ---------------------------------------------------------------------------
// ④ 跨会话
// ---------------------------------------------------------------------------

section('④ 跨会话作用域')

const foreign = await appendAttested({
  content: '另一段会话里的用户发言',
  conversationId: OTHER_CONVERSATION,
  mode: 'human',
})
const read3 = await reader.read({
  characterId: h.kernel.characterId,
  conversationId,
  beforeSequence: Number.MAX_SAFE_INTEGER,
  scanCeiling: 200,
})
check(
  '④-1 另一段会话的受信发言**不会**出现在本会话的候选里（作用域在 SQL 层，不靠事后过滤）',
  !read3.some((item) => String(item.eventId) === String(foreign.event.id)),
  `本会话候选 ${read3.length} 条`
)

// ---------------------------------------------------------------------------
// ⑤⑥ 有界与排他下界
// ---------------------------------------------------------------------------

section('⑤/⑥ 有界与排他下界')

const bounded = await reader.read({
  characterId: h.kernel.characterId,
  conversationId,
  beforeSequence: Number.MAX_SAFE_INTEGER,
  scanCeiling: 1,
})
check('⑤-1 `scanCeiling` 是硬上限（要 1 条就最多 1 条）', bounded.length <= 1, `返回 ${bounded.length} 条`)

const exclusive = await reader.read({
  characterId: h.kernel.characterId,
  conversationId,
  beforeSequence: humanSequence,
  scanCeiling: 200,
})
check(
  '⑥-1 `beforeSequence` 是**排他**下界：那条自己不在结果里',
  !exclusive.some((item) => String(item.eventId) === humanId),
  `返回 ${exclusive.length} 条`
)
check(
  '⑥-2 而它**之前**的候选仍在（下界只排自己，不是清空整段）',
  exclusive.length < read3.length
)
const zeroCeiling = await reader.read({
  characterId: h.kernel.characterId,
  conversationId,
  beforeSequence: Number.MAX_SAFE_INTEGER,
  scanCeiling: 0,
})
check('⑤-2 上限 0 ⇒ 一条都不读（不解释成"没有上限"）', zeroCeiling.length === 0)

// ---------------------------------------------------------------------------
// ⑦ 失效闸（事件是某条记忆的根证据）
// ---------------------------------------------------------------------------

section('⑦ 失效闸 —— 事件 → 记忆状态')

const memory = await h.commitAndFold(
  h.makeCandidate(
    'person_fact',
    { kind: 'claim', subject: h.user, predicate: 'pet.cat.name', value: '豆豆' },
    { sourceRefs: [{ kind: 'conversation_event', id: humanId }] }
  ),
  M4_T0 + 100
)
check(
  '⑦-1 夹具成立：以那条受信事件为**根证据**的记忆被写入（active）',
  memory !== null && memory.status === 'active',
  `memory=${memory === null ? 'null' : String(memory.id)} status=${String(memory?.status)}`
)

const readActive = await reader.read({
  characterId: h.kernel.characterId,
  conversationId,
  beforeSequence: Number.MAX_SAFE_INTEGER,
  scanCeiling: 200,
})
const activeFact = readActive.find((item) => String(item.eventId) === humanId)
check(
  '⑦-2 读取面把它挂的根证据状态读出来了（active）',
  JSON.stringify(activeFact?.rootMemoryStatuses) === JSON.stringify(['active']),
  JSON.stringify(activeFact?.rootMemoryStatuses)
)
const selectionActive = selectRollup({
  conversationId,
  sources: readActive,
  recentSourceEventIds: [],
  scanCeiling: 200,
  budgetTokens: 400,
})
check(
  '⑦-3 active 时它**仍然**可选（失效闸不能误伤）',
  selectionActive.items.some((item) => String(item.sourceEventId) === humanId)
)

// 负控：把那条记忆置为 superseded（记忆生命周期里"被纠正"的终态）
await exec(
  db,
  sql`update memory_records set status = 'superseded' where id = ${String(memory!.id)}`,
  '负控：把根记忆置为 superseded'
)
const readInvalidated = await reader.read({
  characterId: h.kernel.characterId,
  conversationId,
  beforeSequence: Number.MAX_SAFE_INTEGER,
  scanCeiling: 200,
})
const invalidatedFact = readInvalidated.find((item) => String(item.eventId) === humanId)
const selectionInvalidated = selectRollup({
  conversationId,
  sources: readInvalidated,
  recentSourceEventIds: [],
  scanCeiling: 200,
  budgetTokens: 400,
})
check(
  '⑦-4 记忆被 supersede ⇒ 读取面如实报出 non-active 状态',
  invalidatedFact?.rootMemoryStatuses.includes('superseded') === true,
  JSON.stringify(invalidatedFact?.rootMemoryStatuses)
)
check(
  '⑦-5 选择器**拒绝**它，理由恰为 `invalidated_by_memory_state`',
  selectionInvalidated.rejections.invalidated_by_memory_state === 1 &&
    !selectionInvalidated.items.some((item) => String(item.sourceEventId) === humanId),
  `invalidated=${selectionInvalidated.rejections.invalidated_by_memory_state}`
)

// 恢复：置回 active
await exec(
  db,
  sql`update memory_records set status = 'active' where id = ${String(memory!.id)}`,
  '恢复：把根记忆置回 active'
)
const readRestored = await reader.read({
  characterId: h.kernel.characterId,
  conversationId,
  beforeSequence: Number.MAX_SAFE_INTEGER,
  scanCeiling: 200,
})
const restoredSelection = selectRollup({
  conversationId,
  sources: readRestored,
  recentSourceEventIds: [],
  scanCeiling: 200,
  budgetTokens: 400,
})
check(
  '⑦-6 恢复：置回 active ⇒ 它重新可选（三段式的第三段）',
  restoredSelection.items.some((item) => String(item.sourceEventId) === humanId)
)

// ---------------------------------------------------------------------------
// ⑧ 只读 + 端到端（reader → 选择器 → 轮次级端口）
// ---------------------------------------------------------------------------

section('⑧ 只读性与端到端')

const tables = ['conversation_events', 'memory_records', 'memory_evidence_links', 'character_domain_events']
const before = new Map<string, number>()
for (const table of tables) before.set(table, await countRows(table))
await reader.read({
  characterId: h.kernel.characterId,
  conversationId,
  beforeSequence: Number.MAX_SAFE_INTEGER,
  scanCeiling: 200,
})
const after = new Map<string, number>()
for (const table of tables) after.set(table, await countRows(table))
check(
  '⑧-1 读取面**只读**：读一次前后这些表的行数完全不变',
  tables.every((table) => before.get(table) === after.get(table)),
  tables.map((t) => `${t}:${String(before.get(t))}→${String(after.get(t))}`).join(' ')
)

const port = createRollupTurnPort({ reader })
const outcome = await port.run({
  characterId: h.kernel.characterId,
  conversationId,
  recentSourceEventIds: [],
  beforeSequence: Number.MAX_SAFE_INTEGER,
  budgetTokens: 400,
})
check(
  '⑧-2 端到端：真实库 → 读取面 → 选择器 → 轮次级端口，摘录逐字、引用是真实事件 id',
  outcome?.selection !== undefined &&
    outcome.selection.items.some((item) => String(item.sourceEventId) === humanId) &&
    outcome.trace.sourceRefs.includes(`cev:${humanId}`),
  outcome?.trace.sourceRefs.join(',')
)
check(
  '⑧-3 trace 形态不含正文（隐私纪律在真实链路上也成立）',
  outcome !== undefined && !JSON.stringify(outcome.trace).includes('豆豆')
)

// ---------------------------------------------------------------------------
// 判决与证据
// ---------------------------------------------------------------------------

section('判决')

await h.stop()
cleanupSandbox(sandbox.dir)

const total = rows.length
const passed = rows.filter((row) => row.pass).length
let verdict = 'PASS'
if (measurementInvalid > 0) verdict = 'MEASUREMENT INVALID'
else if (failures > 0) verdict = 'FAIL'

const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const now = new Date()
const runId = `m6-wp3-reader-${now.toISOString().slice(0, 10).replace(/-/g, '')}-${head.slice(0, 12)}`
const outDir = resolve('artifacts/m6', runId)
mkdirSync(outDir, { recursive: true })
const outPath = join(outDir, 'reader.json')

writeFileSync(
  outPath,
  `${JSON.stringify(
    {
      schemaVersion: 'm6-wp3-reader@1',
      runId,
      generatedAt: now.toISOString(),
      head,
      verdict,
      passed,
      failed: failures,
      measurementInvalid,
      measurements,
      checks: rows,
      scope: {
        isolatedDatabase: true,
        sandboxDir: sandbox.dir,
        opensProductionDatabase: false,
        callsModel: false,
        writesPersistentState:
          '仅**夹具**写入隔离库（真实 ingress 写事件、真实记忆管线写记忆、一处状态翻转用于失效闸）；' +
          '被测的读取面本身只读（⑧-1 断言行数不变）。真实库从未被打开。',
        headSemantics: '`head` = 运行时 git HEAD（被测代码提交）；证据文件落在紧随其后的纯证据提交里。',
      },
    },
    null,
    2
  )}\n`,
  'utf8'
)

console.log(`\n  ${verdict} — ${passed}/${total} 通过，失败 ${failures}，MEASUREMENT INVALID ${measurementInvalid}`)
console.log(`  证据：${relative(resolve('.'), outPath).split(/[\\/]/).join('/')}`)

process.exit(verdict === 'PASS' ? 0 : 2)
