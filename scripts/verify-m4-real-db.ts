/**
 * 真库验收：迁移 0005 应用之后，逐条核对**四张新表**与**既有数据**。
 *
 * ============================================================================
 *  为什么不能只看 CLI 的输出
 * ============================================================================
 * `pnpm memory:list` 打印"（没有匹配的记忆）" —— 而那句话在两种完全不同的
 * 世界里**长得一模一样**：
 *
 *   A. 迁移成功、四张表存在、只是还没有记忆
 *   B. 迁移其实没生效（`create table if not exists` 因为某个原因没跑），
 *      而 CLI 读了一张空表或走了兜底
 *
 * 计划书第 55 节的那条原则在**迁移**上同样适用：
 * 失败不许长得像成功。所以这份脚本直接查 schema 与计数。
 *
 * ---------------------------------------------------------------------------
 *  ⚠️ 迁移 0005 一旦应用即冻结
 * ---------------------------------------------------------------------------
 * 语句用的是 `create table if not exists`，因此之后对 0005 的任何修改
 * 在沙箱测试里全部通过、在真库上**静默无效**。
 * 这是 M4 最容易造成"测试全绿而生产没变"的地方。
 * 这份脚本的存在意义就是：**应用之后立刻证明表真的建出来了**。
 *
 * 跑法：tsx scripts/verify-m4-real-db.ts
 */

import 'dotenv/config'

import { AgentRuntime, stringToUuid, type Character, type Plugin } from '@elizaos/core'
import sqlPlugin from '@elizaos/plugin-sql'
import openaiPlugin from '@elizaos/plugin-openai'
import bootstrapPlugin from '@elizaos/plugin-bootstrap'

import { character } from '../src/character/index.ts'
import { latestSchemaVersion } from '../src/infrastructure/persistence/migrations.ts'
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
import {
  currentSchemaVersion,
  exec,
  getRawDb,
} from '../src/infrastructure/persistence/db.ts'
import { createPersistentCharacterPlugin } from '../src/plugin/persistent-character.ts'
import { openAiCompatiblePlugin } from '../src/providers/openai-compatible.ts'

/*
 * ============================================================================
 *  ⚠️ 这里显式放行真实库 —— 但"只读"是**构造上**成立的，不是靠自觉
 * ============================================================================
 * 第一版没有放行，于是 `initDatabase` 里的 `assertDatabaseAccessAllowed()`
 * **正确地拒绝了我**：
 *
 *     拒绝写入真实对话库（…\data\pglite）。
 *     实验脚本必须在独立副本上运行：在文件顶部调用 isolateDatabase()
 *
 * 那个守卫是对的设计（实验脚本默认不该碰真实库），所以我**不**绕过它 ——
 * 而是满足它的前提，并把"这份脚本只读"变成一条机械约束：
 * 下面那个 `rows()` 会**拒绝任何非 SELECT 语句**。
 *
 * 只调用 `allowProductionDatabase()` 而不加这条约束，
 * 等于把守卫整个关掉，换成一个注释里的承诺 ——
 * 而注释里的承诺在半年后加一行 `delete` 时不会拦任何人。
 */
allowProductionDatabase()

/**
 * 唯一的数据访问口：**只允许 SELECT**。
 *
 * 所有核对语句都必须走这里，因此"这份脚本不写库"是**可执行的约束**
 * 而不是约定。任何 `insert` / `update` / `delete` / `create` / `drop`
 * 都会在这里当场抛错。
 */
async function rows(sql: string): Promise<Record<string, unknown>[]> {
  const head = sql.trim().slice(0, 12).toLowerCase()
  if (!head.startsWith('select')) {
    throw new Error(
      `verify-m4-real-db 是**只读**验收脚本，拒绝执行非 SELECT 语句：${sql.slice(0, 120)}\n` +
        '（这条约束是刻意的：它让"不写真实库"成为构造上的性质，而不是约定）'
    )
  }
  return exec(db, sql, 'm4-real-db-acceptance')
}

/*
 * ⚠️ 这里**不** import `src/main.ts`。
 *
 * 它在模块加载时会无条件执行 `main()`，因此任何 import 它
 * 都会顺带跑一遍完整的 CLI（包括 preflight 与对话初始化）。
 * 我在第一版里正是这么写的 —— 而那时脚本"看起来能用"，
 * 只是会多做一大堆事。
 *
 * 下面用与 `main.ts` **相同**的装配路径打开真库
 * （同一组插件、同一个 `initDatabase`）。刻意不用 `isolateDatabase`：
 * 这份脚本要验收的就是**真库本身**。
 */

console.log('='.repeat(72))
console.log('M4 真库验收（迁移 0005 之后）')
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

/*
 * `initDatabase` 会把待应用的迁移跑掉。真库此刻已在 v5，
 * 因此这一步是 no-op —— 但**如果它抱怨有待应用迁移**，
 * 那正是我们要知道的事（说明 0005 没真的应用上）。
 *
 * INC-01 WP6：本脚本也是**真实库 opener** —— 因此它必须先走生产状态机
 * （租约 → pre-open verified snapshot → 拿 token → 打开）。
 * 不是真实库目录（副本 / 沙箱）时不走状态机。
 */
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
}

const db = getRawDb(runtime)


// ---------------------------------------------------------------------------
// 0. schema 版本
// ---------------------------------------------------------------------------

console.log('')
console.log('0. schema 版本')
const version = await currentSchemaVersion(db)
/*
 * ⚠️ M4.5 起这条判据不再写死 5。
 *
 * 真库的 schema 升级是一个**显式动作**（`pnpm migrate:apply`），
 * 因此它可能落后于代码（那是正常的、被设计过的状态）。
 * 要守的性质是"迁移 0005 已经应用"，而不是"版本号恰好是 5" ——
 * 后者会在每次新增迁移时变成一条与 M4 无关的假红。
 */
check(
  'kernel schema 版本 ≥ 5（迁移 0005 已应用）',
  version >= 5,
  `version=${version}（代码最新 ${latestSchemaVersion()}；真库升级是显式动作）`
)

// ---------------------------------------------------------------------------
// 1. 四张新表存在
// ---------------------------------------------------------------------------

console.log('')
console.log('1. 迁移 0005 的四张表')
const expectedTables = [
  'memory_records',
  'memory_subject_links',
  'memory_evidence_links',
  'memory_events',
]
const tableRows = await rows(
  `select table_name from information_schema.tables where table_schema = 'public'`
)
const present = new Set(tableRows.map((r) => String(r.table_name)))
for (const table of expectedTables) {
  check(`表 ${table} 存在`, present.has(table))
}

// ---------------------------------------------------------------------------
// 2. 索引（含那条决定去重正确性的部分唯一索引）
// ---------------------------------------------------------------------------

console.log('')
console.log('2. 索引')
const indexRows = await rows(
  `select indexname, indexdef from pg_indexes where schemaname = 'public'`
)
const indexes = new Map(indexRows.map((r) => [String(r.indexname), String(r.indexdef)]))

for (const name of [
  'memory_records_owner_status',
  'memory_records_owner_type',
  'memory_records_owner_canonical',
  'memory_records_canonical',
  'memory_records_fingerprint',
  'memory_records_recorded_at',
  'memory_records_processor',
  'memory_records_active_fingerprint',
  'memory_subject_links_lookup',
  'memory_evidence_links_lookup',
  'memory_evidence_links_memory',
  'memory_evidence_links_root',
  'memory_events_domain_event',
]) {
  check(`索引 ${name} 存在`, indexes.has(name))
}

/*
 * ⚠️ 部分唯一索引的**谓词**必须核对，不能只看它存在。
 *
 * 这条索引的谓词是 `where status = 'active'`（**小写**，与领域里的
 * `MemoryStatus` 一致）。若哪天有人把状态值改成大写而没改这里，
 * 索引会变成"谓词永远不成立" —— 它**仍然存在**、`pg_indexes` 里看得见、
 * 但**不约束任何行**，于是去重第一层在数据库层静默失效。
 *
 * 这类"存在但不生效"的守卫正是本项目反复防的东西，所以这里查谓词本身。
 */
const activeFingerprint = indexes.get('memory_records_active_fingerprint') ?? ''
check(
  "部分唯一索引的谓词是 status = 'active'（与 MemoryStatus 同形）",
  /where\s*\(?status\s*=\s*'active'/i.test(activeFingerprint),
  activeFingerprint.slice(0, 200)
)
check('活跃指纹索引是 UNIQUE（不是普通索引）', /unique/i.test(activeFingerprint))

// ---------------------------------------------------------------------------
// 3. 新表可读，且**互相一致**
// ---------------------------------------------------------------------------

console.log('')
console.log('3. 新表可读且互相一致')
console.log('   （⚠️ 这里**不**断言"表为空" —— 见下方说明）')

/*
 * ============================================================================
 *  ⚠️ 第一版断言"四张表都为空"，而那是**把一个偶然状态写成了契约**
 * ============================================================================
 * 写这份脚本时真库里一条记忆都没有 —— 但那是**当时的功能缺陷**
 * 造成的（显式记忆路径没接进对话链路，见
 * `docs/milestones/M4-verification.md` §5.6），不是设计意图。
 *
 * 修好接线之后真库里出现了记忆，这条断言立刻变红 ——
 * 而它红得**没有信息量**：四张表里有数据恰恰说明系统在工作。
 *
 * 这正是我在同一节里对 `conversation_events` 明确警告过的那件事：
 * "把会**增长**的量写成等号是一条必然过期的断言"。
 * 我把它写在了下面那张表上，却忘了它同样适用于新表。
 *
 * 现在断言的是**在任何规模下都成立、而且更有价值**的性质：
 *   · 四张表都可读（迁移真的建出来了）
 *   · MI-03 的关系在真库里成立：每条记录都有证据链
 *     （这条断言在 0 条时**空过**，因此下面额外报了条数，
 *       让人能看出"这次到底验证了多少东西"）
 */
for (const table of expectedTables) {
  const countRows = await rows(`select count(*)::int as n from ${table}`)
  const n = Number(countRows[0]?.n ?? -1)
  check(`${table} 可读`, n >= 0, `count=${n}`)
}

/*
 * MI-03：每条正式记忆都必须有证据。
 *
 * ⚠️ 这条在 **0 条记忆时会空过**（两边都是 0）。因此下面把行数一并报出来，
 *    让读者能看出这次到底验证了多少 —— 一个"绿但什么都没查"的断言
 *    与"绿且查了 2 条"在报告上必须可区分。
 */
const recordsCount = await rows(`select count(*)::int as n from memory_records`)
const recordsWithEvidence = await rows(
  `select count(distinct memory_id)::int as n from memory_evidence_links`
)
const totalRecords = Number(recordsCount[0]?.n ?? -1)
const withEvidence = Number(recordsWithEvidence[0]?.n ?? -1)

check(
  'MI-03：每条记忆都有证据链（真库里成立）',
  withEvidence === totalRecords,
  `有证据的 ${withEvidence} / 共 ${totalRecords}${totalRecords === 0 ? '（本次为空过：还没有记忆）' : ''}`
)

/*
 * subject 关系：claim 类记忆必须有 subject 链接。
 * 同样是"0 条时空过"，同样报出规模。
 */
const subjectsCount = await rows(
  `select count(distinct memory_id)::int as n from memory_subject_links`
)
check(
  'claim 类记忆都有 subject 链接',
  Number(subjectsCount[0]?.n ?? -1) === totalRecords,
  `有 subject 的 ${subjectsCount[0]?.n} / 共 ${totalRecords}`
)

/*
 * `memory_events` 至少要覆盖每条记忆（每条至少有 CREATED 一条事件）。
 * 它是重放（MI-11）的前提：事件链缺了，`rebuildMemory` 就重建不出当前状态。
 */
const eventsCount = await rows(`select count(*)::int as n from memory_events`)
check(
  '每条记忆都至少有一条事件（重放的前提）',
  Number(eventsCount[0]?.n ?? -1) >= totalRecords,
  `事件 ${eventsCount[0]?.n} / 记忆 ${totalRecords}`
)

// ---------------------------------------------------------------------------
// 4. 既有数据**一字未动**
// ---------------------------------------------------------------------------

console.log('')
console.log('4. 既有数据未受影响（这是"纯新增迁移"的证明）')

/*
 * ⚠️ 断言写的是"**至少** N"而不是"等于 N"。
 *
 * 期望值取自 WP1 的现状盘点（`docs/m4/current-state.md`）：
 *   conversation_events = 8 / character_domain_events = 2
 *
 * 而把会**增长**的量写成等号是一条必然过期的断言 ——
 * M3.5 的 `schemaVersion === 4` 就是这么坏的（见
 * `docs/milestones/M4-verification.md` §4.1）。
 * 这里真正要守的是"迁移**没有删掉**历史"。
 */
const ledger = await rows(`select count(*)::int as n from conversation_events`)
check(
  'conversation_events 的历史仍在（≥ 8）',
  Number(ledger[0]?.n ?? -1) >= 8,
  `count=${ledger[0]?.n}`
)

const domainEvents = await rows(`select count(*)::int as n from character_domain_events`)
check(
  'character_domain_events 仍在（≥ 2）',
  Number(domainEvents[0]?.n ?? -1) >= 2,
  `count=${domainEvents[0]?.n}`
)

const seedRows = await rows(
  `select max(seed_version)::int as v from character_definition_versions`
)
check(
  'Seed 版本仍为 v3（MI-12：M4 的自动写入够不到 Seed）',
  Number(seedRows[0]?.v ?? -1) === 3,
  `seed_version=${seedRows[0]?.v}`
)

// ---------------------------------------------------------------------------

/*
 * INC-01 WP3（`AT3.5`）：本脚本是**真实库的只读验收** —— 它打开了真库，
 * 因此退出前必须**先关连接**再让进程结束。裸 `stop()` 不关连接
 * （事故的第三个缺口），这里换成唯一收尾句柄。
 *
 * INC-01 WP6：关闭之后由状态机做 post-close verified snapshot 并释放租约。
 */
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
  console.log(`M4 真库验收：**${checks - failures.length} / ${checks} 通过**`)
  console.log('失败项：')
  for (const f of failures) console.log(`  - ${f}`)
  console.log('='.repeat(72))
  process.exit(1)
}
console.log(`M4 真库验收：${checks} 项全部通过`)
console.log('='.repeat(72))
