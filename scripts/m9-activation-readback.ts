/**
 * M9 WP11 激活读回（一次性，真实库只读验收）。
 *
 * ============================================================================
 *  为什么存在
 * ============================================================================
 * 计划 §13 WP11 顺序的「真实首用后读回」：激活启动（`pnpm chat` 开库即执行
 * 信念双流追赶）之后，逐项核对可观察面是否与 Activation-Candidate §3 的
 * 预期一致。**只凭 `.env` 写好不能宣布运行验证通过**（计划原文）。
 *
 * 纪律（与 `verify-m4-real-db.ts` 同源）：
 *   · 本脚本是**真实库 opener** —— 走 INC-01 生产状态机
 *     （租约 → pre-open verified snapshot → token → 打开 → 干净关闭）；
 *   · 「只读」是**构造上**成立的：`rows()` 拒绝一切非 SELECT 语句；
 *   · 不 import `src/main.ts`（模块加载会无条件跑完整 CLI）。
 *
 * 跑法：tsx scripts/m9-activation-readback.ts
 * 预期（Activation-Candidate §3）：恰好 1 条 active reported 信念
 * （education.institution = 示例工程科技大学）· origin 已建档（cutover =
 * 启动时账本最大序号，切换前历史零重判）· 双流水位在案 · 零 BELIEF_INFERRED。
 */
import 'dotenv/config'

import { AgentRuntime, stringToUuid, type Character, type Plugin } from '@elizaos/core'
import sqlPlugin from '@elizaos/plugin-sql'
import openaiPlugin from '@elizaos/plugin-openai'
import bootstrapPlugin from '@elizaos/plugin-bootstrap'

import { character } from '../src/character/index.ts'
import { allowProductionDatabase, initDatabase } from '../src/db/index.ts'
import { isProductionDir } from '../src/dev/sandbox.ts'
import {
  lastVerifiedSnapshotId,
  prepareProductionOpen,
  productionDataDirOf,
  productionSnapshotRootOf,
  type ProductionOpenHandle,
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

/*
 * ⚠️ 显式放行真实库 + 只读机械约束（verify-m4-real-db 同款，见彼处注释）。
 */
allowProductionDatabase()

let db: RawDb

/** 唯一数据访问口：只允许 SELECT（构造上的只读，不是约定）。 */
async function rows(sql: string): Promise<Record<string, unknown>[]> {
  const head = sql.trim().slice(0, 12).toLowerCase()
  if (!head.startsWith('select')) {
    throw new Error(
      `m9-activation-readback 是**只读**验收脚本，拒绝执行非 SELECT 语句：${sql.slice(0, 120)}`
    )
  }
  return exec(db, sql, 'm9-activation-readback')
}

console.log('='.repeat(72))
console.log('M9 WP11 激活读回（真实库，只读）')
console.log('='.repeat(72))

const failures: string[] = []
let checks = 0

function check(label: string, ok: boolean, detail = ''): void {
  checks += 1
  if (ok) {
    console.log(`  ✅ ${label}${detail ? `  — ${detail}` : ''}`)
  } else {
    console.log(`  ❌ ${label}${detail ? `  — ${detail}` : ''}`)
    failures.push(label)
  }
}

const characterId = character.id ?? character.name
const userId = stringToUuid('user-Alex')

const runtime = new AgentRuntime({
  character: character as Character,
  plugins: [
    openaiPlugin,
    bootstrapPlugin,
    openAiCompatiblePlugin,
    createPersistentCharacterPlugin({ characterId, userId }),
  ] as Plugin[],
  conversationLength: 16,
  settings: {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? '',
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? 'https://api.deepseek.com',
    OPENAI_LARGE_MODEL: process.env.OPENAI_LARGE_MODEL ?? 'deepseek-flash',
    OPENAI_SMALL_MODEL: process.env.OPENAI_SMALL_MODEL ?? 'deepseek-flash',
  },
})

const realDataDir = productionDataDirOf()
const realSnapshotRoot = productionSnapshotRootOf()
const guarded = process.env.PROJECT_LG_SANDBOX === undefined && isProductionDir(realDataDir)
let openHandle: ProductionOpenHandle | undefined
if (guarded) {
  openHandle = await prepareProductionOpen({
    dataDir: realDataDir,
    snapshotRoot: realSnapshotRoot,
    operationKind: 'real_db_verify',
    deps: {
      openDatabase: async () => {
        await initDatabase(runtime, sqlPlugin)
      },
      stopServices: () => stopRuntimeServices(runtime),
      closeDatabase: async () => await closeDatabaseConnection(runtime),
      isDatabaseClosed: () => isDatabaseClosed(runtime),
      lastVerifiedSnapshotId: () => lastVerifiedSnapshotId(realSnapshotRoot),
    },
  })
  await openHandle.open()
  console.log(
    `   生产状态机：${openHandle.reading.states.join(' → ')}（pre-open 快照 ${openHandle.reading.preOpenSnapshotId ?? '未记录'}）`
  )
} else {
  await initDatabase(runtime, sqlPlugin)
  console.log('   ⚠️ 非生产目录（沙箱/副本）——未走生产状态机（本脚本设计面向真库）')
}

db = getRawDb(runtime)

// ---------------------------------------------------------------------------
// 1. origin 建档行
// ---------------------------------------------------------------------------

console.log('')
console.log('1. BELIEF_ORIGIN 建档')
const originRows = await rows(
  `select state from character_projections
   where character_id = ${sqlLit(characterId)} and projection_type = 'belief:origin'`
)
if (originRows.length === 0) {
  check('belief:origin 行存在', false, '未建档——激活启动未发生或追赶失败')
} else {
  const origin = originRows[0]?.state as Record<string, unknown> | undefined
  const cutover = Number(origin?.cutoverSequence ?? -1)
  check('belief:origin 行存在', true)
  check(
    'cutoverSequence 为正整数（切换边界在案）',
    Number.isInteger(cutover) && cutover > 0,
    `cutover=${cutover} · activationId=${String(origin?.activationId ?? '?')} · policy=${String(origin?.policyVersion ?? '?')}`
  )
}

// ---------------------------------------------------------------------------
// 2. 信念行（预期：恰好 1 条 active reported）
// ---------------------------------------------------------------------------

console.log('')
console.log('2. 信念投影行')
const beliefRows = await rows(
  `select projection_type, state from character_projections
   where character_id = ${sqlLit(characterId)} and projection_type like 'belief:%'
     and projection_type <> 'belief:origin' and projection_type not like 'belief:evidence:%'
   order by projection_type`
)
const beliefs = beliefRows.map((r) => ({
  key: String(r.projection_type),
  state: (r.state ?? {}) as Record<string, unknown>,
}))
const active = beliefs.filter((b) => String(b.state.status ?? '') === 'active')
check(
  '恰好 1 条 active 信念（Activation-Candidate §3 预期）',
  active.length === 1,
  `belief 行总数=${beliefs.length} · active=${active.length}`
)
if (active.length === 1) {
  const b = active[0]!.state
  const prop = (b.proposition ?? {}) as Record<string, unknown>
  check(
    '该信念为 reported（真实历史合格记忆回放形成）',
    String(b.epistemicKind ?? '') === 'reported',
    `kind=${String(b.epistemicKind ?? '?')} · status=${String(b.status ?? '?')}`
  )
  console.log(
    `     命题：predicate=${String(prop.predicate ?? '?')} · value=${JSON.stringify(prop.value)} · scope=${String(prop.scopeKey ?? '?')}`
  )
  console.log(
    `     依赖记忆：${JSON.stringify(b.dependsOnMemoryIds)} · support=${String(b.supportLevel ?? '?')}`
  )
  check(
    '命题落在 education 槽（唯一合格记忆：education.institution）',
    String(prop.predicate ?? '').startsWith('education.'),
    `predicate=${String(prop.predicate ?? '?')}`
  )
}

// ---------------------------------------------------------------------------
// 3. 域事件（BELIEF_*）
// ---------------------------------------------------------------------------

console.log('')
console.log('3. BELIEF_* 域事件')
const eventRows = await rows(
  `select type, count(*)::int as n from character_domain_events
   where character_id = ${sqlLit(characterId)} and type like 'BELIEF_%'
   group by type order by type`
)
const eventCounts = new Map(eventRows.map((r) => [String(r.type), Number(r.n)]))
const originEvents = eventCounts.get('BELIEF_ORIGIN') ?? 0
const formedEvents = eventCounts.get('BELIEF_FORMED') ?? 0
const inferredEvents = eventCounts.get('BELIEF_INFERRED') ?? 0
check('BELIEF_ORIGIN 事件 ≥ 1（建档已入账本）', originEvents >= 1, `count=${originEvents}`)
check('BELIEF_FORMED 事件 ≥ 1（reported 形成已入账本）', formedEvents >= 1, `count=${formedEvents}`)
check(
  'BELIEF_INFERRED = 0（旧对话历史零重判——cutover 语义）',
  inferredEvents === 0,
  `count=${inferredEvents}`
)

// ---------------------------------------------------------------------------
// 4. 双流水位
// ---------------------------------------------------------------------------

console.log('')
console.log('4. 处理器水位')
const watermarkRows = await rows(
  `select processor, processor_version, processed_through_sequence, updated_at
   from processor_watermarks
   where character_id = ${sqlLit(characterId)} and processor like 'belief-%'
   order by processor`
)
const watermarks = new Map(watermarkRows.map((r) => [String(r.processor), Number(r.processed_through_sequence)]))
const interactionWm = watermarks.get('belief-interaction-evaluator')
const memoryWm = watermarks.get('belief-memory-reconciler')
check(
  'belief-interaction-evaluator 水位在案',
  interactionWm !== undefined,
  `through=${interactionWm ?? '?'}`
)
check(
  'belief-memory-reconciler 水位在案',
  memoryWm !== undefined,
  `through=${memoryWm ?? '?'}`
)
if (originRows.length > 0 && interactionWm !== undefined) {
  const cutover = Number((originRows[0]?.state as Record<string, unknown>)?.cutoverSequence ?? -1)
  check(
    '交互流水位 = cutover（启动时切换前无待消费窗口）',
    interactionWm === cutover,
    `watermark=${interactionWm} · cutover=${cutover}`
  )
}
if (memoryWm !== undefined) {
  const maxMemoryEvent = await rows(
    `select coalesce(max(sequence), 0)::int as m from character_domain_events
     where character_id = ${sqlLit(characterId)} and type like 'MEMORY_%'`
  )
  const m = Number(maxMemoryEvent[0]?.m ?? 0)
  check(
    'Memory 流水位 ≥ Memory 事件最大序号（回放完毕；水位空间 = 全域事件序号，越过非 Memory 事件推进）',
    memoryWm >= m,
    `watermark=${memoryWm} · max(MEMORY_*)=${m}`
  )
}

// ---------------------------------------------------------------------------
// 5. 背书记忆仍在（激活不改动 Memory 域）
// ---------------------------------------------------------------------------

console.log('')
console.log('5. 背书记忆（education.institution）')
const memoryRows = await rows(
  `select id, status, content from memory_records
   where content->>'predicate' like 'education.%' order by recorded_at`
)
for (const r of memoryRows) {
  const content = (r.content ?? {}) as Record<string, unknown>
  console.log(
    `     ${String(r.id)} · ${String(r.status)} · ${String(content.predicate ?? '?')} = ${JSON.stringify(content.value)}`
  )
}
check(
  'education.institution 记忆仍为 active（激活零改动 Memory 域）',
  memoryRows.some((r) => String(r.status) === 'active'),
  `education 记忆 ${memoryRows.length} 条`
)

// ---------------------------------------------------------------------------

await createRuntimeShutdown(runtime, {
  afterRun: async (reading) => {
    if (openHandle === undefined) return
    const result = await openHandle.finish({
      closed: reading.closed,
      detail: reading.note,
      afterClose: true,
    })
    console.log(
      `   生产状态机收尾：${result.states.join(' → ')}（cleanClose=${String(result.cleanClose)}，post-close 快照 ${result.postCloseSnapshotId ?? '未记录'}）`
    )
  },
}).shutdown()

console.log('')
console.log('='.repeat(72))
if (failures.length > 0) {
  console.log(`M9 WP11 激活读回：**${checks - failures.length} / ${checks} 通过**`)
  console.log('失败项：')
  for (const f of failures) console.log(`  - ${f}`)
  console.log('='.repeat(72))
  process.exit(1)
}
console.log(`M9 WP11 激活读回：${checks} 项全部通过`)
console.log('='.repeat(72))

/** SQL 字符串字面量（本脚本只读，输入全部来自代码常量，无注入面） */
function sqlLit(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}
