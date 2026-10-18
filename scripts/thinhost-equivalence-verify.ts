/**
 * 门：薄宿主语义等价（换实现不换接口）
 *
 * ============================================================================
 *  它证明什么
 * ============================================================================
 * E1  薄宿主**不执行任何 DDL**：`registerPlugin()` 之后 adapter 就绪，
 *     `runPluginMigrations()` **具名抛错**（不是静默 no-op）。
 * E2  ElizaOS 侧的 `initDatabase()` 在已就绪库上**跳过**启动 DDL（S1，两宿主共享）。
 * E3  消息镜像的读写语义与旧宿主**同形**：写入后可按 roomId 读回，
 *     `unique=true` 的重复 id 被**静默丢弃**（旧宿主 onConflictDoNothing 同形）。
 * E4  `ensure*` 四件套**幂等**：连跑两次不报错、行数不翻倍。
 * E5  薄宿主 `initialize()` 后**没有**上游守卫定时器，也**没有**常驻轮询
 *     （Timeout 计数为 0）—— 这是稳态 CPU 从 1.019% 降到 0.009% 的机制。
 * E6  旧链路 `composeState()` 在薄宿主下**失败关闭**（抛具名错），
 *     绝不返回空 prompt（否则她会变成另一个人且无任何告警）。
 *
 * ============================================================================
 *  为什么不跑在生产库上
 * ============================================================================
 * 本门**只**在隔离 PGlite 上跑。`assertDatabaseAccessAllowed()` 会拒绝任何
 * 指向生产的尝试 —— 那是它的本职，本门不改它、不绕过它。
 *
 * ⚠️ 判据纪律（L-QQP-09 同型坑）：本门**不**按源码文本匹配，只**真跑**。
 */

/**
 * 薄宿主语义等价门 —— 跑在**真实 PostgreSQL** 上（隔离测试库）。
 *
 * ⚠️ 为什么用真实 PG 而不是 PGlite：
 *    生产后端就是 PostgreSQL（`.env` 的 CHARACTER_DB_BACKEND=postgres），
 *    而薄宿主要自己持有一个 `pg.Pool`。在 PGlite 上验证会漏掉
 *    "PG 特有的类型/时区/连接池语义"这一整类问题 —— 那正是替换最容易翻车的地方。
 *
 * 用法：`--pg-url <隔离测试库 URL>`（**必须**带 `lg_test_` 前缀，否则门自拒）
 */

import { AgentRuntime, stringToUuid, type Plugin } from '@elizaos/core'
import sqlPlugin from '@elizaos/plugin-sql'
import pg from 'pg'

interface Check {
  id: string
  ok: boolean
  detail: string
}
const checks: Check[] = []
function check(id: string, ok: boolean, detail: string): void {
  checks.push({ id, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} — ${detail}`)
}
function report(title: string): number {
  const failed = checks.filter((c) => !c.ok)
  console.log(`\n=== thinhost 语义等价 · ${title}: ${checks.length - failed.length}/${checks.length} PASS ===`)
  for (const f of failed) console.log(`FAILED: ${f.id} — ${f.detail}`)
  if (failed.length > 0) process.exitCode = 1
  return failed.length
}

// ===========================================================================
// 安全轨：本门**只**允许隔离测试库（lg_test_ 前缀）。给错目标当场自拒。
// ===========================================================================
const pgUrl = (() => {
  const arg = process.argv.find((a) => a.startsWith('--pg-url='))
  return arg === undefined ? '' : arg.slice('--pg-url='.length)
})()
if (pgUrl === '') {
  console.error('必须提供 --pg-url=<隔离测试库 URL>')
  process.exit(2)
}
const dbName = decodeURIComponent(new URL(pgUrl).pathname.replace(/^\//, ''))
if (!dbName.startsWith('lg_test_')) {
  console.error(`拒绝：目标库名 "${dbName}" 不带 lg_test_ 前缀。本门不得指向生产库。`)
  process.exit(3)
}
if (dbName === 'sumuwei') {
  console.error('拒绝：sumuwei 是生产库。')
  process.exit(3)
}
console.log(`目标隔离测试库：${dbName}`)

const IDENTITY_KEYS = [
  'LG_PG_EXPECT_USER',
  'LG_PG_EXPECT_DATABASE_PREFIX',
  'LG_PG_EXPECT_USER_PREFIX',
  'LG_PRODUCTION_POSTGRES_URL',
  'LG_TEST_DATABASE_PREFIX',
] as const
process.env.CHARACTER_DB_BACKEND = 'postgres'
process.env.POSTGRES_URL = pgUrl
process.env.LG_PG_EXPECT_DATABASE = dbName
process.env.PGLITE_DATA_DIR = ''
delete process.env.PROJECT_LG_SANDBOX
for (const k of IDENTITY_KEYS) process.env[k] = ''

const { character } = await import('../src/character/index.ts')
const { initDatabase, allowKernelMigration } = await import('../src/db/index.ts')
const { closeDatabaseConnection } = await import('../src/infrastructure/persistence/runtime-shutdown.ts')
const { ThinHostRuntime, thinLogger } = await import('../src/infrastructure/runtime/thin-host.ts')

// ⚠️ 必须显式放行 Kernel 迁移，否则 `initDatabase` 会**正确地**拒绝
//    （`kernel_migration_pending`：schema 变更必须是显式动作）。
//    本门跑在一次性隔离测试库上，所以放行是安全的 —— 生产库走不到这里。
//    （这个拒绝不是故障，是既有纪律第一次生效；记录在此免得下一个人以为是 bug。）
allowKernelMigration()

const agentId = stringToUuid('agent-thinhost-equiv')
const roomId = stringToUuid('room-thinhost-equiv')
const userId = stringToUuid('user-thinhost-equiv')
const worldId = stringToUuid('world-thinhost-equiv')

// ===========================================================================
// 先用旧宿主（ElizaOS）把库建起来 —— 它负责建表，这正是旧行为
// ===========================================================================
const legacy = new AgentRuntime({
  character: character as never,
  plugins: [],
  conversationLength: 10,
  settings: { POSTGRES_URL: pgUrl, CHARACTER_DB_BACKEND: 'postgres' },
})
let legacyDdlRuns = 0
{
  const original = legacy.runPluginMigrations.bind(legacy)
  ;(legacy as unknown as { runPluginMigrations: () => Promise<void> }).runPluginMigrations =
    async () => {
      legacyDdlRuns += 1
      await original()
    }
}
const ready = await initDatabase(legacy, sqlPlugin as Plugin)
// ⚠️ 断言必须**自洽**：只有当目标库是**空的**时，"首次开库跑 1 次 DDL"才成立。
//    如果编排脚本已经先建过库（S1 的"表齐就跳过"会正确地跳过），
//    那 legacyDdlRuns=0 是**正确行为**，不是缺陷。
//    ⇒ 断言"跑 DDL 的次数与库是否已就绪一致"，而不是死写 1 次。
const pluginTablesPresent = ['agents', 'memories', 'rooms', 'participants', 'entities', 'worlds'].every(
  (t) => ready.tables.includes(t)
)
const expectedDdl = pluginTablesPresent ? 0 : 1
check(
  'E2-legacy-ddl-decision',
  legacyDdlRuns === expectedDdl,
  pluginTablesPresent
    ? `库已就绪（${String(ready.tables.length)} 张表）⇒ 旧宿主正确跳过启动 DDL（${String(legacyDdlRuns)} 次）`
    : `空库 ⇒ 旧宿主应跑 1 次启动 DDL（实测 ${String(legacyDdlRuns)} 次），建 ${String(ready.tables.length)} 张表`
)
await closeDatabaseConnection(legacy)

// ===========================================================================
// 薄宿主：自持一个真实 pg.Pool（生产同款驱动）
// ===========================================================================
const pool = new pg.Pool({ connectionString: pgUrl, max: 2 })

const thin = new ThinHostRuntime({
  character: { name: character.name, id: character.id },
  agentId,
  settings: { POSTGRES_URL: pgUrl, CHARACTER_DB_BACKEND: 'postgres' },
  pool: pool as never,
  logger: thinLogger(),
})

// --- E1a：registerPlugin 之后 adapter 就绪 ---
await thin.registerPlugin(sqlPlugin)
check('E1a-adapter-ready', thin.adapter !== undefined && typeof thin.adapter.db.execute === 'function', 'registerPlugin 后 adapter 具备 db.execute')

// --- E1b：runPluginMigrations 必须具名抛错 ---
let ddlRefused = false
let ddlCode = ''
try {
  await thin.runPluginMigrations()
} catch (error) {
  ddlRefused = true
  ddlCode = (error as { code?: string }).code ?? ''
}
check('E1b-startup-ddl-refused', ddlRefused && ddlCode === 'thin_host_refuses_startup_ddl', `runPluginMigrations 具名拒绝（code=${ddlCode || 'none'}）`)

// --- E5：initialize 后没有守卫定时器 / 没有常驻轮询 ---
await thin.initialize()
const handles: Record<string, number> = {}
for (const r of process.getActiveResourcesInfo()) handles[r] = (handles[r] ?? 0) + 1
check('E5-no-guard-timers', (handles.Timeout ?? 0) === 0, `initialize 后 Timeout=${handles.Timeout ?? 0}（旧宿主为 2）`)

// --- E4 前置：按**真实启动顺序**先建 world/entity/room/participant ---
// ⚠️ 第一次跑这个门时漏了它 ⇒ `insert or update on table "memories" violates
//    foreign key constraint "memories_entity_id_entities_id_fk"`。
//    旧宿主在 `main.ts:3760-3779` 正是这么做的（ensure* 先于任何消息写入）。
//    ⇒ 门必须照抄那个顺序，否则测的是"不可能发生的调用序列"。
await thin.ensureEntity({ id: agentId, names: [character.name], agentId })
await thin.ensureEntity({ id: userId, names: ['测试用户'], agentId })
await thin.ensureRoomExists({ id: roomId, name: 'dm-test', source: 'cli', type: 'DM', worldId })
await thin.ensureParticipantInRoom(agentId, roomId)
await thin.ensureParticipantInRoom(userId, roomId)

// --- E3：消息镜像读写 + unique 静默丢弃 ---
const m1 = { id: stringToUuid('msg-thinhost-1'), entityId: userId, agentId, roomId, worldId, content: { text: '你好' }, createdAt: Date.now() }
await thin.createMemory(m1 as never, 'messages', true)
const read1 = await thin.getMemories({ tableName: 'messages', roomId, count: 100 })
check('E3-write-read-roundtrip', read1.length === 1 && read1[0]?.content?.text === '你好', `写入后读回 ${String(read1.length)} 条，内容=${String(read1[0]?.content?.text ?? '')}`)

// 重复插入同一 id（unique=true）⇒ 应被静默丢弃，行数不变
await thin.createMemory(m1 as never, 'messages', true)
const read2 = await thin.getMemories({ tableName: 'messages', roomId, count: 100 })
check('E3-unique-idempotent', read2.length === 1, `重复 id 后仍 ${String(read2.length)} 条（unique 语义与旧宿主同形）`)

// --- E4：ensure* 幂等（连跑两次，行数不得翻倍）---
await thin.ensureEntity({ id: userId, names: ['测试用户'], agentId })
await thin.ensureRoomExists({ id: roomId, name: 'dm-test', source: 'cli', type: 'DM', worldId })
await thin.ensureParticipantInRoom(userId, roomId)

const counts = await thin.getMemories({ tableName: 'messages', roomId, count: 100 })
const parts = await (async () => {
  const r = (await pool.query(
    'select entity_id, count(*)::int as c from participants where room_id = $1 group by entity_id order by entity_id',
    [roomId]
  )) as { rows?: { entity_id: string; c: number }[] }
  return r.rows ?? []
})()
// ⚠️ 第一版断言写成"participants 总行数 == 1"，那是**门写错了**：
//    启动顺序里已经为 agent 和 user 各登记过一次（这是真实启动行为），
//    总数自然是 2。真正要证明的是"**同一个人**重复登记不新增行"。
const byEntity = new Map(parts.map((r) => [r.entity_id, r.c]))
const userRows = byEntity.get(userId) ?? 0
const agentRows = byEntity.get(agentId) ?? 0
check(
  'E4-ensure-idempotent',
  userRows === 1 && agentRows === 1,
  `重复登记后：user ${String(userRows)} 行、agent ${String(agentRows)} 行（各自应恰好 1）`
)

// --- E6：旧链路 composeState 必须失败关闭 ---
let csRefused = false
let csCode = ''
try {
  await thin.composeState({})
} catch (error) {
  csRefused = true
  csCode = (error as { code?: string }).code ?? ''
}
check('E6-legacy-fails-closed', csRefused && csCode === 'thin_host_no_legacy_providers', `composeState 失败关闭（code=${csCode || 'none'}），未返回空 prompt`)

void counts
await thin.stop()
try {
  await pool.end()
} catch {
  /* 收尾失败不影响已取得的断言 */
}

const failed = report('薄宿主 vs 旧宿主')
process.exit(failed > 0 ? 1 : 0)
