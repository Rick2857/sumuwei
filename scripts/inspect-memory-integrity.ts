/**
 * M5-PRE 只读盘点：**真实生产库里到底有没有"孤儿记忆"**。
 *
 * ============================================================================
 *  为什么要它
 * ============================================================================
 * `resetKernelData`（`--reset-kernel`）会删掉 `character_domain_events` 与
 * `conversation_events`，但**没有**删 `memory_records` / `memory_subject_links` /
 * `memory_evidence_links` / `memory_events`。于是在它能被 M5 的资格过滤
 * "顺手排除"之前，必须先回答一个事实问题：
 *
 *     生产库里现在**已经**存在这种行了吗？还是只是"可以产生"？
 *
 * 在沙箱里已经证明"可以产生"（见 artifacts/m5/investigation-2026-09-17.json）；
 * 这个脚本回答"已经存在吗"。
 *
 * ============================================================================
 *  安全（不可协商）
 * ============================================================================
 *   · 生产库**只复制，从不打开**（`cpSync` 到临时目录，与 inspect-production-copy.ts 同一条约定）
 *   · 脚本里**没有任何** INSERT / UPDATE / DELETE / DDL —— 全部是 SELECT
 *   · 不调用 `rebuildMemory()`（它在 A == B 时会写回投影）。
 *     等价的只读判据：`memory_events` → `character_domain_events` 是**内连接**，
 *     因此"没有活事件行" ⇔ `rebuildMemory()` 会得到 `after = null` ⇔ `equal = false`
 *   · 输出**不含记忆正文**（只有 id / 状态 / 计数 / 权威等级），可以安全进 artifacts
 *
 * 跑法：pnpm exec tsx scripts/inspect-memory-integrity.ts
 */

import type { Character } from '../src/infrastructure/runtime/eliza-types.ts'
import { createThinHostRuntime } from '../src/infrastructure/runtime/thin-host-factory.ts'
import { applyKernelMigrations as __applyKernelMigrations, getRawDb as __getRawDb } from '../src/infrastructure/persistence/db.ts'
import 'dotenv/config'

import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'



import { sql } from 'drizzle-orm'

import { character } from '../src/character/index.ts'
import { currentSchemaVersion, getRawDb, rowsOf } from '../src/infrastructure/persistence/db.ts'
import { unsupportedMemories } from '../src/infrastructure/persistence/memory-store.ts'
import { entityRef, type EntityKind } from '../src/kernel/contracts/index.ts'

const PRODUCTION_DB = resolve(process.env.PGLITE_DATA_DIR ?? 'data/pglite')
const evidenceDir = join(process.cwd(), 'artifacts', 'm5')

if (!existsSync(PRODUCTION_DB)) {
  console.error(`找不到生产库：${PRODUCTION_DB}`)
  process.exit(2)
}

const copyDir = mkdtempSync(join(tmpdir(), 'project-lg-memory-integrity-'))
const target = join(copyDir, 'pglite')

console.log('='.repeat(72))
console.log('M5-PRE 只读盘点：真实库里的 Memory 完整性（全部 SELECT）')
console.log('='.repeat(72))
console.log(`源（只复制，不打开）：${PRODUCTION_DB}`)
console.log(`副本：${target}`)

cpSync(PRODUCTION_DB, target, { recursive: true })

process.env.PGLITE_DATA_DIR = target
process.env.PROJECT_LG_SANDBOX = target // 绕过写保护闸（仍然只读）

/*
 * ⚠️ 真正要守住的不变量：**下面 `getRawDb` 打开的那个库必须是副本**。
 * （`.env` 里 `PGLITE_DATA_DIR=data/pglite` 指向真库，因此这一步不是形式主义 ——
 *  它拦住的是"忘了改 env 就打开了真库"。）
 */
if (resolve(process.env.PGLITE_DATA_DIR) !== resolve(target)) {
  throw new Error(`拒绝打开非副本库：PGLITE_DATA_DIR=${process.env.PGLITE_DATA_DIR}`)
}

const runtime = createThinHostRuntime({
    character: character,
    settings: {},
  })
await runtime.registerPlugin(undefined as never)
await await __applyKernelMigrations(__getRawDb(runtime))

const db = getRawDb(runtime)

const one = async (query: ReturnType<typeof sql>): Promise<Record<string, unknown>> => {
  const rows = rowsOf(await db.execute(query))
  return rows[0] ?? {}
}
const many = async (query: ReturnType<typeof sql>): Promise<Record<string, unknown>[]> =>
  rowsOf(await db.execute(query))

const schemaVersion = await currentSchemaVersion(db)
const tables = (
  await many(
    sql`select table_name from information_schema.tables where table_schema = 'public' order by table_name`
  )
).map((r) => String(r.table_name))

const hasMemoryTables = ['memory_records', 'memory_events', 'memory_evidence_links'].every((t) =>
  tables.includes(t)
)

const report: Record<string, unknown> = {
  testId: 'M5-PRE / real-db memory integrity inventory',
  generatedAt: new Date().toISOString(),
  source: PRODUCTION_DB,
  schemaVersion,
  readOnly: 'SELECT only；生产库只复制不打开；未调用 rebuildMemory（保持零写入）',
  hasMemoryTables,
}

console.log(`\n=== 1. schema ===`)
console.log(`迁移版本：${schemaVersion}`)
console.log(hasMemoryTables ? '✅ M4 的记忆表已存在' : '⏳ M4 的记忆表不存在（迁移 0005 未应用）')

if (!hasMemoryTables) {
  console.log('\n结论：生产库还没有 M4 记忆表 → 不存在孤儿记忆问题（无从产生）。')
  await runtime.stop()
  rmSync(copyDir, { recursive: true, force: true })
  process.exit(0)
}

// ---------------------------------------------------------------------------
// 2. 计数
// ---------------------------------------------------------------------------

const totals = await one(sql`select
  count(*)::int as total,
  count(*) filter (where status = 'active')::int as active,
  count(*) filter (where status = 'superseded')::int as superseded,
  count(*) filter (where status = 'retracted')::int as retracted,
  count(*) filter (where status = 'disputed')::int as disputed
  from memory_records`)

const linkKinds = await many(sql`select evidence_kind, count(*)::int as c
  from memory_evidence_links group by evidence_kind order by evidence_kind`)

console.log(`\n=== 2. 记忆与证据 ===`)
console.log(
  `memory_records: total=${Number(totals.total ?? 0)} active=${Number(totals.active ?? 0)} ` +
    `superseded=${Number(totals.superseded ?? 0)} retracted=${Number(totals.retracted ?? 0)} ` +
    `disputed=${Number(totals.disputed ?? 0)}`
)
console.log(`evidence link 种类：${linkKinds.map((r) => `${r.evidence_kind}=${r.c}`).join(', ') || '(无)'}`)

report['memoryRecords'] = totals
report['evidenceLinkKinds'] = linkKinds

// ---------------------------------------------------------------------------
// 3. 悬空引用（真正要回答的问题）
// ---------------------------------------------------------------------------

/** 指向已不存在的对话事件的 evidence link（只有 conversation_event 这类有真源表可查） */
const danglingEvidence = await one(sql`select count(*)::int as c
  from memory_evidence_links l
  left join conversation_events e on e.id = l.evidence_id
  where l.evidence_kind = 'conversation_event' and e.id is null`)

/** 指向已不存在的领域事件的 per-memory 事件流行 */
const danglingEvents = await one(sql`select count(*)::int as c
  from memory_events me
  left join character_domain_events e on e.id = me.domain_event_id
  where e.id is null`)

/**
 * 每条记忆的"活"证据 / 活事件。
 *
 * ⚠️ 判据必须是 `liveEvidenceCountAfterReset` 的形状（内连接后计数），
 * 不是 `wasAnyEvidenceDeleted`（见用户 2026-09-17 的裁定）：
 * 一条记忆有两条证据、只失效一条**不算**孤儿。
 */
const perMemory = await one(sql`with live_events as (
    select me.memory_id, count(*)::int as c
    from memory_events me
    join character_domain_events e on e.id = me.domain_event_id
    group by me.memory_id
  ), live_evidence as (
    select l.memory_id, count(*)::int as c
    from memory_evidence_links l
    join conversation_events e on e.id = l.evidence_id
    where l.evidence_kind = 'conversation_event'
    group by l.memory_id
  )
  select
    (select count(*)::int from memory_records r
       where not exists (select 1 from live_events le where le.memory_id = r.id))
      as memories_without_live_events,
    (select count(*)::int from memory_records r
       where not exists (select 1 from live_evidence lv where lv.memory_id = r.id))
      as memories_without_live_evidence,
    (select count(*)::int from memory_records r
       where exists (select 1 from live_events le where le.memory_id = r.id)
         and not exists (select 1 from live_evidence lv where lv.memory_id = r.id))
      as memories_replayable_but_evidenceless`)

console.log(`\n=== 3. 悬空引用 ===`)
console.log(`dangling_evidence_links（指向已不存在的对话事件）: ${Number(danglingEvidence.c ?? 0)}`)
console.log(`dangling_memory_events（指向已不存在的领域事件）: ${Number(danglingEvents.c ?? 0)}`)
console.log(`memories_without_live_events   （= rebuildMemory 会 equal=false）: ${Number(perMemory.memories_without_live_events ?? 0)}`)
console.log(`memories_without_live_evidence                          : ${Number(perMemory.memories_without_live_evidence ?? 0)}`)
console.log(`memories_replayable_but_evidenceless                    : ${Number(perMemory.memories_replayable_but_evidenceless ?? 0)}`)

report['danglingEvidenceLinks'] = Number(danglingEvidence.c ?? 0)
report['danglingMemoryEvents'] = Number(danglingEvents.c ?? 0)
report['perMemory'] = perMemory

// ---------------------------------------------------------------------------
// 4. 用**生产同一套**探针再问一次（证明它看不见 —— 或者看得见）
// ---------------------------------------------------------------------------

const owners = await many(
  sql`select distinct owner_kind, owner_id from memory_records order by owner_kind, owner_id`
)

const probe: { owner: string; unsupported: number }[] = []
for (const row of owners) {
  const owner = entityRef(String(row.owner_kind) as EntityKind, String(row.owner_id))
  const problems = await unsupportedMemories(db, owner)
  probe.push({ owner: `${row.owner_kind}:${row.owner_id}`, unsupported: problems.length })
}

console.log(`\n=== 4. 生产探针（unsupportedMemories，只数 link 行）===`)
for (const item of probe) console.log(`  ${item.owner}: unsupported=${item.unsupported}`)
report['unsupportedMemoriesProbe'] = probe

// ---------------------------------------------------------------------------
// 5. 逐条抽样（只列 id / 状态 / 权威，**不含正文**）
// ---------------------------------------------------------------------------

const orphans = await many(sql`with live_events as (
    select me.memory_id
    from memory_events me
    join character_domain_events e on e.id = me.domain_event_id
    group by me.memory_id
  ), live_evidence as (
    select l.memory_id
    from memory_evidence_links l
    join conversation_events e on e.id = l.evidence_id
    where l.evidence_kind = 'conversation_event'
    group by l.memory_id
  )
  select r.id, r.memory_type, r.status, r.authority, r.recorded_at,
         (select count(*)::int from memory_events me where me.memory_id = r.id) as event_rows,
         (select count(*)::int from memory_evidence_links l where l.memory_id = r.id) as link_rows
  from memory_records r
  where not exists (select 1 from live_events le where le.memory_id = r.id)
     or not exists (select 1 from live_evidence lv where lv.memory_id = r.id)
  order by r.recorded_at asc
  limit 50`)

console.log(`\n=== 5. 可疑行（最多 50 条，不含正文）===`)
if (orphans.length === 0) {
  console.log('  （无）')
} else {
  for (const row of orphans) {
    console.log(
      `  ${row.id}  ${row.memory_type}/${row.status} authority=${row.authority} ` +
        `event_rows=${row.event_rows} link_rows=${row.link_rows}`
    )
  }
}
report['suspectRows'] = orphans

// ---------------------------------------------------------------------------
// 6. 结论
// ---------------------------------------------------------------------------

/*
 * ============================================================================
 *  判据（M5-PRE 之后按"状态"而不是"行数"定义）
 * ============================================================================
 *   损坏 = 无活证据的记忆 + 无活事件流的记忆 + 悬空 memory_events 行
 *                            ↑ 这三样必须为 0
 *
 *   `dangling_evidence_links` **单列**：
 *     若它属于**仍有活证据**的记忆，那是"用户显式抹掉那段历史"的痕迹 ——
 *     删它会破 MI-11 的 A == B，所以刻意保留（见 memory-integrity.ts 的说明）。
 *     它必须被看见，但不是"库坏了"。
 */
const corruptionCount =
  Number(perMemory.memories_without_live_events ?? 0) +
  Number(perMemory.memories_without_live_evidence ?? 0) +
  Number(danglingEvents.c ?? 0)

const danglingEvidenceCount = Number(danglingEvidence.c ?? 0)

const verdict =
  corruptionCount === 0
    ? danglingEvidenceCount === 0
      ? 'CLEAN'
      : 'CLEAN_WITH_EXPLAINED_EVIDENCE_ERASURE'
    : 'ORPHANS_PRESENT'

console.log(`\n=== 6. 结论 ===`)
if (verdict === 'CLEAN') {
  console.log('  ✅ 干净：0 孤儿 / 0 悬空 memory_events / 0 悬空 evidence link')
  console.log('     → 修完 resetKernelData 即可继续 M5 WP1')
} else if (verdict === 'CLEAN_WITH_EXPLAINED_EVIDENCE_ERASURE') {
  console.log(
    `  ⚠️ 状态完好（0 孤儿 / 0 不可 replay），但有 ${danglingEvidenceCount} 条` +
      '指向已删会话的 evidence link —— 那是被显式抹掉的历史痕迹，不是损坏'
  )
} else {
  console.log(
    `  ❌ 存在状态损坏：孤儿 ${Number(perMemory.memories_without_live_evidence ?? 0)}、` +
      `不可 replay ${Number(perMemory.memories_without_live_events ?? 0)}、` +
      `悬空 memory_events ${Number(danglingEvents.c ?? 0)} → 需要按正式语义修复（禁止手工删）`
  )
}
report['verdict'] = verdict

mkdirSync(evidenceDir, { recursive: true })
writeFileSync(
  join(evidenceDir, 'real-db-inventory.json'),
  `${JSON.stringify(report, null, 2)}\n`,
  'utf8'
)
console.log(`\n证据已写入：artifacts/m5/real-db-inventory.json`)

await runtime.stop()
rmSync(copyDir, { recursive: true, force: true })
console.log(`（副本已清理：${copyDir}）`)
process.exit(0)
