/**
 * **只读诊断：她为什么重复同一句话**（`pnpm diagnose:repeat`）。
 *
 * ============================================================================
 *  它做什么
 * ============================================================================
 * ```text
 * 只读打开**真实库**（INC-01 状态机），把"重复同一句回复"可能涉及的每一层读数**逐层**打印：
 *   ① 最近的对话事件（谁说的、第几轮、内容摘要）—— 看"她的回复有没有被写回 / 轮次有没有推进"
 *   ② 最近的 trace 步（模型调用、失败、守卫）—— 看"是不是模型那一步出了问题"
 *   ③ 记忆里有没有那句话（以及它是不是被撤回 / 被遮蔽）
 *   ④ 会话摘要（M6 rollup）里有没有那句话
 *   ⑤ M11 本域的读数（水位 / 反思事件 / 定时任务有没有 failed）
 *   ⑥ 关键开关（从 `.env` **文本**读，不读 process.env）
 * ```
 * ⚠️ 「只读」是**构造上**的：`rows()` 拒绝一切非 SELECT。
 * ⚠️ 不打印任何 key；记忆正文按**截断**打印（诊断需要看到那句话，但不需要整段历史）。
 */

import 'dotenv/config'

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { cpSync, mkdtempSync } from 'node:fs'

import { createThinHostRuntime } from '../src/infrastructure/runtime/thin-host-factory.ts'
import { stringToUuid } from '../src/kernel/contracts/uuid.ts'
import type { Character, Plugin } from '../src/infrastructure/runtime/eliza-types.ts'

import { character } from '../src/character/index.ts'
import { allowProductionDatabase, initDatabase } from '../src/db/index.ts'
import { isProductionDir } from '../src/dev/sandbox.ts'
import {
  lastVerifiedSnapshotId,
  prepareProductionOpen,
  productionDataDirOf,
  productionSnapshotRootOf,
} from '../src/infrastructure/persistence/production-open-guard.ts'
import {
  closeDatabaseConnection,
  createRuntimeShutdown,
  isDatabaseClosed,
  stopRuntimeServices,
} from '../src/infrastructure/persistence/runtime-shutdown.ts'
import { exec, getRawDb, type RawDb } from '../src/infrastructure/persistence/db.ts'
import { createPersistentCharacterPlugin } from '../src/plugin/persistent-character.ts'
import { openAiCompatiblePlugin } from '../src/providers/openai-compatible.ts'

const REPO_ROOT = resolve(process.cwd())
allowProductionDatabase()

let db: RawDb
async function rows(sql: string): Promise<Record<string, unknown>[]> {
  if (!sql.trim().slice(0, 12).toLowerCase().startsWith('select')) {
    throw new Error(`只读脚本，拒绝非 SELECT：${sql.slice(0, 120)}`)
  }
  return await exec(db, sql, 'diagnose-repeat')
}
const cut = (value: unknown, n = 90): string =>
  String(value ?? '').replace(/\s+/g, ' ').slice(0, n)

const NEEDLE = process.argv.find((item) => item.startsWith('--needle='))?.slice(9) ?? '十点二十五'

const characterId = character.id ?? character.name
const userId = stringToUuid('user-Alex')
const runtime = createThinHostRuntime({
  character: character,
  conversationLength: 16,
  settings: {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? '',
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? 'https://api.deepseek.com',
    OPENAI_LARGE_MODEL: process.env.OPENAI_LARGE_MODEL ?? 'deepseek-flash',
    OPENAI_SMALL_MODEL: process.env.OPENAI_SMALL_MODEL ?? 'deepseek-flash',
  },
})

const realDataDir = productionDataDirOf()
/*
 * ⚠️ `--copy`：**租约被占用时也能诊断**。
 *    实测：用户正在聊天时，真实库租约被那个进程持有 ⇒ `lease_failed`（这是 INV-DB-01 的**正确**行为，
 *    拿不到就立刻失败、不去抢）。诊断不该要求用户先关掉聊天 ⇒ 复制一份到 %TEMP% 再读副本。
 *    源目录**只被 `cpSync` 读**，从不作为数据库打开；副本是沙箱路径 ⇒ 不需要生产 token。
 *    ⚠️ 副本可能是**写入中的瞬时快照**（他正在聊）⇒ 读数只能当"近实时"，不能当"当前精确值"。
 */
const copyMode = process.argv.includes('--copy')
if (copyMode) {
  const copyDir = mkdtempSync(join(tmpdir(), 'm11-diag-copy-'))
  cpSync(realDataDir, copyDir, { recursive: true })
  process.env.PGLITE_DATA_DIR = copyDir
  process.env.PROJECT_LG_SANDBOX = copyDir
  console.log(`⚠️ 副本模式：源=${realDataDir}`)
  console.log(`             副本=${copyDir}（源只被读；副本会被打开）`)
}
if (!isProductionDir(realDataDir) && !copyMode) {
  console.error(`拒绝：目标不是生产目录（${realDataDir}）`)
  process.exit(2)
}
const handle = copyMode
  ? undefined
  : await prepareProductionOpen({
      dataDir: realDataDir,
      snapshotRoot: productionSnapshotRootOf(),
      operationKind: 'real_db_verify',
      deps: {
        openDatabase: async () => {
          await initDatabase(runtime)
        },
        stopServices: () => stopRuntimeServices(runtime),
        closeDatabase: async () => await closeDatabaseConnection(runtime),
        isDatabaseClosed: () => isDatabaseClosed(runtime),
        lastVerifiedSnapshotId: () => lastVerifiedSnapshotId(productionSnapshotRootOf()),
      },
    })
if (handle !== undefined) {
  await handle.open()
  console.log(
    `生产状态机：${handle.reading.states.join(' → ')}（pre-open 快照 ${handle.reading.preOpenSnapshotId ?? '未记录'}）`
  )
} else {
  await initDatabase(runtime)
}
db = getRawDb(runtime)
console.log(`诊断关键词：${NEEDLE}`)

console.log('\n=== ① 最近 16 条对话事件（谁说的 / 第几轮 / 内容摘要） ===')
for (const row of (
  await rows(
    `select sequence, conversation_sequence, actor_type, type, content, created_at
       from conversation_events
      where character_id = '${characterId}'
      order by sequence desc
      limit 16`
  )
).reverse()) {
  console.log(
    `  #${String(row.sequence)} c${String(row.conversation_sequence)} ${String(row.actor_type).padEnd(9)} ${String(row.type).padEnd(18)} ${cut(row.content)}`
  )
}

console.log('\n=== ② 最近 6 轮的 trace：**每轮实际注入了哪些来源**（这是"她为什么总提同一件事"的直接证据） ===')
/*
 * ⚠️ `character_traces` **没有** `sequence` 列（`trace_id` 是主键、`steps` 是 jsonb）——
 *    第一版按 `sequence` 排序 ⇒ 查询报错。按 `started_at`（有索引）排。
 */
for (const row of await rows(
  `select trace_id, status, started_at, context_section_ids, selected_memory_ids, output_event_id
     from character_traces
    where character_id = '${characterId}'
    order by started_at desc
    limit 6`
)) {
  const sections = (row.context_section_ids ?? []) as string[]
  const memories = (row.selected_memory_ids ?? []) as string[]
  console.log(`  trace ${String(row.trace_id).slice(0, 22)} ${String(row.status).padEnd(6)}`)
  console.log(`        sections(${String(sections.length)})=${sections.join(', ')}`)
  console.log(`        选中的记忆(${String(memories.length)})=${memories.join(', ').slice(0, 100)}`)
  /*
   * ⚠️ 直接点名"会不会反复提同一件事"的三类来源：
   *    · `rollup*` —— M6 会话摘要（**每轮注入**，最容易把一句话钉住）
   *    · `goal*`   —— M10 目标/承诺（事实块在有操作时挂；状态块走 goalTokens）
   *    · `adaptive-self` —— M11 行为策略块（本轮刚激活）
   */
  for (const [label, prefix] of [
    ['rollup/摘要', 'rollup'],
    ['goal/目标承诺', 'goal'],
    ['adaptive-self/行为策略', 'adaptive-self'],
  ] as const) {
    const hit = sections.filter((id) => id.startsWith(prefix))
    if (hit.length > 0) console.log(`        ⚠️ 注入了 ${label}：${hit.join(', ')}`)
  }
}

console.log(`\n=== ③ 记忆里含「${NEEDLE}」的行 ===`)
/*
 * ⚠️ `memory_records.content` 是 **jsonb**（`LIKE` 对它无效）且没有 `character_id`：
 *    按 `owner_kind='character'` + `content::text` 匹配。
 */
const memoryHits = await rows(
  `select id, status, memory_type, content::text as content_text, valid_from from memory_records
    where owner_kind = 'character' and owner_id = '${characterId}'
      and content::text like '%${NEEDLE}%'
    order by valid_from desc nulls last limit 8`
)
if (memoryHits.length === 0) console.log('  （没有命中）')
for (const row of memoryHits) {
  console.log(`  ${String(row.status).padEnd(12)} ${String(row.memory_type).padEnd(12)} ${cut(row.content_text)}`)
}
console.log(
  `  该角色记忆总数：${JSON.stringify(
    await rows(
      `select status, count(*)::int as n from memory_records
        where owner_kind = 'character' and owner_id = '${characterId}' group by status`
    )
  )}`
)

console.log(`\n=== ④ 投影里含「${NEEDLE}」的行（会话摘要 / 目标 / 承诺 / 关系 / 情绪 / 行为策略） ===`)
const projectionHits = await rows(
  `select projection_type, revision, updated_at, state from character_projections
    where character_id = '${characterId}'
    order by updated_at desc limit 40`
)
let projectionHitCount = 0
for (const row of projectionHits) {
  const text = JSON.stringify(row.state ?? {})
  if (!text.includes(NEEDLE)) continue
  projectionHitCount += 1
  console.log(`  ⚠️ ${String(row.projection_type)} (rev ${String(row.revision)}) —— ${cut(text, 220)}`)
}
if (projectionHitCount === 0) {
  console.log(`  （没有任何投影行含「${NEEDLE}」）`)
  console.log(`  现有投影类型：${JSON.stringify(projectionHits.map((row) => String(row.projection_type)).slice(0, 20))}`)
}

console.log('\n=== ⑤ M11 本域 + 任务面（激活之后的状态） ===')
for (const row of await rows(
  `select processor, processor_version, processed_through_sequence from processor_watermarks
    where processor = 'reflection-scheduler'`
)) {
  console.log(`  水位：${JSON.stringify(row)}`)
}
console.log(
  `  反思/调整事件：${JSON.stringify(
    await rows(
      `select type, count(*)::int as n from character_domain_events
        where type like 'REFLECTION%' or type like 'ADAPTIVE_SELF%' group by type`
    )
  )}`
)
console.log(
  `  任务面：${JSON.stringify(
    await rows(
      `select processor, status, count(*)::int as n from character_jobs
        where character_id = '${characterId}' group by processor, status order by processor`
    )
  )}`
)

console.log(`\n=== ⑦ 那句话在对话里出现过几次（按序号，含说话者） ===`)
const occurrences = await rows(
  `select sequence, conversation_sequence, actor_type, content from conversation_events
    where character_id = '${characterId}' and content like '%${NEEDLE}%'
    order by sequence asc`
)
const byActor: Record<string, number> = {}
for (const row of occurrences) {
  const actor = String(row.actor_type)
  byActor[actor] = (byActor[actor] ?? 0) + 1
}
console.log(`  命中 ${String(occurrences.length)} 条 · 按说话者：${JSON.stringify(byActor)}`)
for (const row of occurrences) {
  console.log(`  #${String(row.sequence)} c${String(row.conversation_sequence)} ${String(row.actor_type).padEnd(9)} ${cut(row.content, 110)}`)
}
console.log(
  `\n  对话总轮次：${JSON.stringify(
    await rows(
      `select actor_type, count(*)::int as n from conversation_events
        where character_id = '${characterId}' group by actor_type`
    )
  )}`
)
console.log(
  `  ⚠️ 注入窗口有多长：`.concat(
    JSON.stringify(
      await rows(`select count(*)::int as n from conversation_events where character_id = '${characterId}'`)
    )
  )
)

console.log('\n=== ⑥ 关键开关（从 `.env` 文本读） ===')
const envPath = join(REPO_ROOT, '.env')
const envText = existsSync(envPath) ? readFileSync(envPath, 'utf8') : ''
for (const key of [
  'CHARACTER_REFLECTION_ENABLED',
  'CHARACTER_ADAPTIVE_SELF_ENABLED',
  'CHARACTER_ADAPTIVE_SELF_TOKENS',
  'CHARACTER_ROLLUP_TOKENS',
  'CHARACTER_GOALS_ENABLED',
  'CHARACTER_BELIEF_ENABLED',
  'CHARACTER_MEMORY_SEMANTIC_MODE',
  'CHARACTER_AFFECT_SEMANTIC_MODE',
]) {
  const match = new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`, 'm').exec(envText)
  console.log(`  ${key} = ${match === null ? '(未设置)' : match[1]!.trim()}`)
}

await createRuntimeShutdown(runtime, {
  afterRun: async (reading) => {
    if (handle === undefined) {
      console.log(`\n副本模式收尾：closed=${String(reading.closed)}（未走生产状态机）`)
      return
    }
    const result = await handle.finish({ closed: reading.closed, detail: reading.note, afterClose: true })
    console.log(
      `\n生产状态机收尾：${result.states.join(' → ')}（cleanClose=${String(result.cleanClose)}）`
    )
  },
}).shutdown()
