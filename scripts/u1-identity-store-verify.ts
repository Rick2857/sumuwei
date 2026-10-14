/**
 * U1 · 身份解析读写链门（`u1:identity-store:verify`）
 *
 * 归属：多用户补充计划 U1 / WP2b-1（[ADR-133](../../docs/adr/ADR-133-multi-user-scope-and-authorization.md) `D04`/`D05`）。
 *
 * ⚠️ 全部在 `isolateDatabase()` 的**一次性 %TEMP% 沙箱**里；`data/pglite` **从不被打开**。
 * ⚠️ 零模型调用、零出网。
 * ⚠️ 三段式（正控 / 负控 / 拆防线+恢复），含**并发首次消息**的 G14 负控。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cleanupSandbox, isolateDatabase, isProductionDir, resetPluginSqlConnection } from '../src/dev/sandbox.ts'

/** 证据落盘**相对脚本位置**（不依赖 cwd：本门可能被从别的目录驱动）。 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

interface Check {
  readonly id: string
  readonly label: string
  readonly pass: boolean
  readonly detail: string
}

const checks: Check[] = []
const record = (id: string, label: string, pass: boolean, detail: string): void => {
  checks.push({ id, label, pass, detail })
  console.log(`  ${pass ? '✅' : '❌'} ${id} ${label} —— ${detail}`)
}

// ---------------------------------------------------------------------------
// 后端闸：本门用的是**目录沙箱**（PGlite）。
//
// ⚠️ 2026-10-13 实测的**环境条件**（不是本门的缺陷）：当 `.env` 里
//    `CHARACTER_DB_BACKEND=postgres` 时，`assertDatabaseAccessAllowed()`
//    会**重新读 `.env`**（`src/db/index.ts:231`）⇒ 目录沙箱会被 PG 身份核对拒绝
//    （`db_identity_mismatch` / `postgres_url_without_backend`）。
//    同一门在**无 `.env` 的 cwd** 下用 `CHARACTER_DB_BACKEND=pglite` 驱动即可通过。
//
// 这里给出**具名原因**并**非零退出**（不"绿着跳过"），而不是抛一个看不懂的 harness 错误。
// ---------------------------------------------------------------------------
{
  // ⚠️ 必须**先按仓库同款方式加载 `.env`**（`src/db/index.ts:231` 用的就是 dotenv.config），
  //    否则这里读到的 process.env 还没有 CHARACTER_DB_BACKEND，闸会误判成 pglite。
  const { config: loadDotenv } = await import('dotenv')
  const { existsSync } = await import('node:fs')
  let envDir = process.cwd()
  while (!existsSync(join(envDir, '.env')) && dirname(envDir) !== envDir) envDir = dirname(envDir)
  loadDotenv({ path: join(envDir, '.env'), quiet: true })

  const { databaseBackendEnvironmentFrom, resolveDatabaseBackend } = await import(
    '../src/infrastructure/persistence/database-backend.ts'
  )
  const resolution = resolveDatabaseBackend(databaseBackendEnvironmentFrom())
  if (resolution.backend === 'postgres') {
    console.log('')
    console.log('  ⛔ u1:identity-store:verify = NOT RUN（具名原因：directory_sandbox_requires_pglite_backend）')
    console.log('     .env 的 CHARACTER_DB_BACKEND=postgres ⇒ isolateDatabase() 走 PostgreSQL 分支，')
    console.log('     而本门用**目录沙箱**（PGlite）；且 initDatabase 会在 cwd 的祖先目录重读 .env。')
    console.log('     两种可用跑法：')
    console.log('       ① 在**没有 .env 的 cwd** 下驱动本脚本，并设 CHARACTER_DB_BACKEND=pglite（本轮实测的跑法）；')
    console.log('       ② 把本门接到 PG lane（测试库 URL + LG_TEST_DATABASE_PREFIX）—— 尚未接线。')
    console.log('     ⚠️ 这不是"通过"：本门的读数为**未取得**。')
    process.exit(2)
  }
}

// ---------------------------------------------------------------------------
// 隔离（必须在任何会碰数据库的 import 之前）
// ---------------------------------------------------------------------------
const runId = `u1-identity-store-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`
const sandbox = isolateDatabase('u1-identity-store', { runId, keep: true })
console.log(`  [sandbox] ${sandbox.dir}`)

const { createM4Harness } = await import('./m4-harness.ts')
const { sql } = await import('drizzle-orm')
const { rowsOf } = await import('../src/infrastructure/persistence/db.ts')
const {
  countTransportMappings,
  resolveInboundIdentityWithStore,
} = await import('../src/infrastructure/runtime/inbound-identity-resolver.ts')
type InboundPlatformFacts = import('../src/kernel/identity/inbound-identity.ts').InboundPlatformFacts

const BOT = 'bot-u1-fixture'
const OWNER = 'u-owner-fixture'
const deriveUserId = (input: { transport: string; externalId: string }): string => `u-${input.transport}-${input.externalId}`

const factsOf = (overrides: Partial<InboundPlatformFacts> = {}): InboundPlatformFacts => ({
  transport: 'qq',
  botId: BOT,
  selfId: BOT,
  messageType: 'private',
  senderUserId: '30001',
  subType: 'friend',
  ...overrides,
})

const h = await createM4Harness({ label: 'u1-identity-store' })
const db = h.db

const allowAll = (): boolean => true
const allowThese = (ids: readonly string[]) => (input: { externalId: string }): boolean => ids.includes(input.externalId)

async function countIdentities(): Promise<number> {
  const rows = rowsOf(await db.execute(sql.raw('select count(*)::int as c from user_identities')))
  return Number(rows[0]?.c ?? 0)
}

// ===========================================================================
// T0 隔离与量具自检
// ===========================================================================
record(
  'T0.1',
  '沙箱不是生产库目录',
  isProductionDir(sandbox.dir) === false && sandbox.dir.includes('u1-identity-store'),
  `dir=${sandbox.dir}`
)
const initialMappings = await countTransportMappings(db, 'qq')
const initialIdentities = await countIdentities()
record(
  'T0.2',
  '量具分母自检：初始映射行数与身份行数都是可读的确定值',
  Number.isInteger(initialMappings) && Number.isInteger(initialIdentities),
  `mappings=${initialMappings} · identities=${initialIdentities}`
)
record(
  'T0.3',
  '起始态为空（新沙箱）',
  initialMappings === 0 && initialIdentities === 0,
  `mappings=${initialMappings} · identities=${initialIdentities}`
)

// ===========================================================================
// T1 负控：拒绝路径**不写任何行**
// ===========================================================================
{
  const before = await countTransportMappings(db, 'qq')
  const r = await resolveInboundIdentityWithStore(factsOf(), {
    db,
    ownerUserId: OWNER,
    allowedFor: () => false, // 未获准
    deriveUserId,
    ensureArchive: true,
  })
  const after = await countTransportMappings(db, 'qq')
  record(
    'T1.1',
    '未获准 ⇒ not_allowed，且**不写任何行**',
    r.outcome.ok === false && r.outcome.code === 'not_allowed' && after === before,
    r.outcome.ok ? '意外放行' : `${r.outcome.code} · mappings ${before}→${after}`
  )
}
{
  const before = await countTransportMappings(db, 'qq')
  const r = await resolveInboundIdentityWithStore(
    factsOf({ selfId: 'bot-attacker' }),
    { db, ownerUserId: OWNER, allowedFor: allowAll, deriveUserId, ensureArchive: true }
  )
  const after = await countTransportMappings(db, 'qq')
  record(
    'T1.2',
    'self_id ≠ botId ⇒ bot_account_mismatch，且**不写任何行**',
    r.outcome.ok === false && r.outcome.code === 'bot_account_mismatch' && after === before,
    r.outcome.ok ? '意外放行' : `${r.outcome.code} · mappings ${before}→${after}`
  )
}
{
  const before = await countTransportMappings(db, 'qq')
  const r = await resolveInboundIdentityWithStore(
    factsOf({ groupId: 'g-1' }),
    { db, ownerUserId: OWNER, allowedFor: allowAll, deriveUserId, ensureArchive: true }
  )
  const after = await countTransportMappings(db, 'qq')
  record(
    'T1.3',
    '私聊带 group_id ⇒ group_id_forbidden，且**不写任何行**',
    r.outcome.ok === false && r.outcome.code === 'group_id_forbidden' && after === before,
    r.outcome.ok ? '意外放行' : `${r.outcome.code} · mappings ${before}→${after}`
  )
}
{
  const before = await countTransportMappings(db, 'qq')
  const r = await resolveInboundIdentityWithStore(factsOf(), {
    db,
    ownerUserId: OWNER,
    allowedFor: allowThese([]), // 白名单为空
    deriveUserId,
    ensureArchive: true,
  })
  const after = await countTransportMappings(db, 'qq')
  record(
    'T1.4',
    '**绝不回退为原主人**：未获准的陌生人不得产生 owner/任意行',
    r.outcome.ok === false && after === before && after === 0,
    r.outcome.ok ? `意外放行 owner=${String(r.outcome.value.isOwner)}` : `${r.outcome.code} · mappings=${after}`
  )
}

// ===========================================================================
// T2 正控：首次幂等建档
// ===========================================================================
const A = '30001'
{
  const r = await resolveInboundIdentityWithStore(factsOf({ senderUserId: A }), {
    db,
    ownerUserId: OWNER,
    allowedFor: allowThese([A]),
    deriveUserId,
    ensureArchive: true,
    displayName: 'fixture-a',
  })
  const mappings = await countTransportMappings(db, 'qq')
  const identities = await countIdentities()
  record(
    'T2.1',
    '获准首见 ⇒ first_seen + 幂等建档（映射 1 行 / 身份 1 行）',
    r.outcome.ok && r.outcome.value.disposition === 'first_seen' && r.outcome.value.userId === `u-qq-${A}` &&
      r.boundFirstTime === true && mappings === 1 && identities === 1,
    r.outcome.ok ? `${r.outcome.value.disposition} · ${r.outcome.value.userId} · mappings=${mappings} · identities=${identities}` : `${r.outcome.code}`
  )
}
{
  const r = await resolveInboundIdentityWithStore(factsOf({ senderUserId: A }), {
    db,
    ownerUserId: OWNER,
    allowedFor: allowThese([A]),
    deriveUserId,
    ensureArchive: true,
  })
  const mappings = await countTransportMappings(db, 'qq')
  record(
    'T2.2',
    '重复解析同一账号 ⇒ mapped + **不新建**（仍 1 行）、不重复解析身份',
    r.outcome.ok && r.outcome.value.disposition === 'mapped' && r.boundFirstTime === false && mappings === 1,
    r.outcome.ok ? `${r.outcome.value.disposition} · mappings=${mappings}` : `${r.outcome.code}`
  )
}
{
  const r = await resolveInboundIdentityWithStore(
    factsOf({ senderUserId: A, messageType: 'group', groupId: 'g-777' }),
    { db, ownerUserId: OWNER, allowedFor: allowThese([A]), deriveUserId, ensureArchive: true }
  )
  const mappings = await countTransportMappings(db, 'qq')
  record(
    'T2.3',
    '同一账号在群里 ⇒ 同一 userId、room=group、**不新建映射**',
    r.outcome.ok && r.outcome.value.userId === `u-qq-${A}` &&
      r.outcome.value.room.kind === 'group' && r.outcome.value.room.groupId === 'g-777' && mappings === 1,
    r.outcome.ok ? `${r.outcome.value.userId} · ${JSON.stringify(r.outcome.value.room)} · mappings=${mappings}` : `${r.outcome.code}`
  )
}

// ===========================================================================
// T3 并发首次消息（G14 负控的核心）
// ===========================================================================
const CONCURRENT_ID = '30042'
{
  const before = await countTransportMappings(db, 'qq')
  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      resolveInboundIdentityWithStore(factsOf({ senderUserId: CONCURRENT_ID }), {
        db,
        ownerUserId: OWNER,
        allowedFor: allowThese([CONCURRENT_ID]),
        deriveUserId,
        ensureArchive: true,
      })
    )
  )
  const after = await countTransportMappings(db, 'qq')
  const allOk = results.every((r) => r.outcome.ok && r.outcome.value.userId === `u-qq-${CONCURRENT_ID}`)
  record(
    'T3.1',
    '并发首次消息 ×8 ⇒ 全部解析成功且**同一 userId**',
    allOk,
    results.map((r) => (r.outcome.ok ? r.outcome.value.userId : r.outcome.code)).join(',')
  )
  record(
    'T3.2',
    '**G14 负控**：并发建档后映射行数**恰好 +1**（不是 8）',
    after === before + 1,
    `mappings ${before}→${after}（期望 ${before + 1}）`
  )
}

// ===========================================================================
// T4 原主人识别（配置绑定的账号）
// ===========================================================================
{
  const ownerQq = '40001'
  const r = await resolveInboundIdentityWithStore(factsOf({ senderUserId: ownerQq }), {
    db,
    ownerUserId: `u-qq-${ownerQq}`,
    allowedFor: allowThese([ownerQq]),
    deriveUserId,
    ensureArchive: true,
  })
  record(
    'T4.1',
    '配置绑定的账号 ⇒ isOwner + principal.kind=owner + verifiedBy=config_binding',
    r.outcome.ok && r.outcome.value.isOwner === true && r.outcome.value.principal.kind === 'owner' &&
      r.outcome.value.principal.verifiedBy === 'config_binding',
    r.outcome.ok
      ? `${r.outcome.value.principal.kind}/${r.outcome.value.principal.kind === 'system' ? 'n/a' : r.outcome.value.principal.verifiedBy}`
      : `${r.outcome.code}`
  )
}

// ===========================================================================
// T5 三段式：拆掉"白名单"这道防线必须判红
// ===========================================================================
{
  const before = await countTransportMappings(db, 'qq')
  // 故意把白名单函数写成"谁都可以" —— 这正是"拆掉防线"的形状
  const weakened = await resolveInboundIdentityWithStore(factsOf({ senderUserId: '50099' }), {
    db,
    ownerUserId: OWNER,
    allowedFor: () => true,
    deriveUserId,
    ensureArchive: true,
  })
  const after = await countTransportMappings(db, 'qq')
  record(
    'T5.1',
    '拆防线 · 白名单恒真 ⇒ 会为陌生账号**真的建档**（证明"获准闸"在被量）',
    weakened.outcome.ok === true && after === before + 1,
    `mappings ${before}→${after}`
  )
  // 恢复：把白名单写回真实规则 ⇒ 同一输入被拒且不写
  const beforeRestore = await countTransportMappings(db, 'qq')
  const restored = await resolveInboundIdentityWithStore(factsOf({ senderUserId: '50099' }), {
    db,
    ownerUserId: OWNER,
    allowedFor: allowThese(['30001']),
    deriveUserId,
    ensureArchive: true,
  })
  const afterRestore = await countTransportMappings(db, 'qq')
  record(
    'T5.2',
    '恢复 · 同一账号在真实白名单下被拒，且**不再写行**',
    restored.outcome.ok === false && restored.outcome.code === 'not_allowed' && afterRestore === beforeRestore,
    restored.outcome.ok ? '意外放行' : `${restored.outcome.code} · mappings ${beforeRestore}→${afterRestore}`
  )
}

// ===========================================================================
// T6 不写侧：ensureArchive=false 只解析
// ===========================================================================
{
  const before = await countTransportMappings(db, 'qq')
  const r = await resolveInboundIdentityWithStore(factsOf({ senderUserId: '60077' }), {
    db,
    ownerUserId: OWNER,
    allowedFor: allowThese(['60077']),
    deriveUserId,
    ensureArchive: false,
  })
  const after = await countTransportMappings(db, 'qq')
  record(
    'T6.1',
    'ensureArchive=false ⇒ 解析成功但**不写**（由调用方决定）',
    r.outcome.ok && r.outcome.value.disposition === 'first_seen' && r.boundFirstTime === false && after === before,
    r.outcome.ok ? `first_seen · mappings ${before}→${after}` : `${r.outcome.code}`
  )
}

// ===========================================================================
// 证据与收尾
// ===========================================================================
const failed = checks.filter((c) => !c.pass)
const passed = failed.length === 0
const evidenceDir = join(REPO_ROOT, 'artifacts', 'post-lv2', runId)
mkdirSync(evidenceDir, { recursive: true })
writeFileSync(
  join(evidenceDir, 'u1-identity-store-verify.json'),
  `${JSON.stringify(
    {
      runId,
      gate: 'u1:identity-store:verify',
      sandbox: sandbox.dir,
      measuredCount: checks.length,
      failed: failed.length,
      checks,
      note: '全离线：一次性 %TEMP% 沙箱；零模型、零出网；data/pglite 从不被打开。',
    },
    null,
    2
  )}\n`,
  'utf8'
)

console.log('')
console.log(`  measured_count = ${checks.length}`)
console.log(`  ${passed ? '✅' : '❌'} u1:identity-store:verify = ${passed ? 'PASS' : 'FAIL'}`)
console.log(`  证据：${evidenceDir}/u1-identity-store-verify.json`)

cleanupSandbox(sandbox.dir)
await resetPluginSqlConnection()
process.exit(passed ? 0 : 1)
