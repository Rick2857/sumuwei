/**
 * U1 · 录制器逐消息身份门（`u1:recorder-identity:verify`）
 *
 * 归属：多用户补充计划 U1 / WP2b-2a（[ADR-133](../../docs/adr/ADR-133-multi-user-scope-and-authorization.md) `D04`/`D05`）。
 *
 * ⚠️ 全部在 `isolateDatabase()` 的**一次性 %TEMP% 沙箱**里；`data/pglite` **从不被打开**。
 * ⚠️ 零模型调用、零出网。
 * ⚠️ 三段式：现状回归（不给身份 ⇒ 逐字节同今天）· 逐消息身份 · **三处失败关闭都不回退为配置里的单用户** · 拆防线必须判红。
 */

import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cleanupSandbox, isolateDatabase, isProductionDir, resetPluginSqlConnection } from '../src/dev/sandbox.ts'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
void REPO_ROOT

// ---------------------------------------------------------------------------
// 后端闸（与 u1:identity-store:verify 同形）：本门用目录沙箱（PGlite）
// ---------------------------------------------------------------------------
{
  const { config: loadDotenv } = await import('dotenv')
  const { existsSync } = await import('node:fs')
  const { dirname: dn, join: jn } = await import('node:path')
  let envDir = process.cwd()
  while (!existsSync(jn(envDir, '.env')) && dn(envDir) !== envDir) envDir = dn(envDir)
  loadDotenv({ path: jn(envDir, '.env'), quiet: true })
  const { databaseBackendEnvironmentFrom, resolveDatabaseBackend } = await import(
    '../src/infrastructure/persistence/database-backend.ts'
  )
  if (resolveDatabaseBackend(databaseBackendEnvironmentFrom()).backend === 'postgres') {
    console.log('')
    console.log('  ⛔ u1:recorder-identity:verify = NOT RUN（具名原因：directory_sandbox_requires_pglite_backend）')
    console.log('     本门用**目录沙箱**（PGlite）；`.env` 的 CHARACTER_DB_BACKEND=postgres 会让 initDatabase 重读 .env。')
    console.log('     跑法：在没有 .env 的 cwd 下驱动本脚本，并设 CHARACTER_DB_BACKEND=pglite（+ POSTGRES_URL=\'\' / DATABASE_URL=\'\'）。')
    console.log('     ⚠️ 这不是"通过"：本门的读数为**未取得**。')
    process.exit(2)
  }
}

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

const runId = `u1-recorder-identity-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`
const sandbox = isolateDatabase('u1-recorder-identity', { runId, keep: true })
console.log(`  [sandbox] ${sandbox.dir}`)

const { createM4Harness } = await import('./m4-harness.ts')
const { sql } = await import('drizzle-orm')
const { rowsOf } = await import('../src/infrastructure/persistence/db.ts')
const { ConversationRecorder } = await import('../src/infrastructure/runtime/conversation-recorder.ts')
const { asConversationId, asCharacterId } = await import('../src/kernel/contracts/ids.ts')
const { resolveInboundIdentityWithStore } = await import(
  '../src/infrastructure/runtime/inbound-identity-resolver.ts'
)

const h = await createM4Harness({ label: 'u1-recorder-identity' })
const db = h.db
const CHARACTER = asCharacterId('char_sumuwei')
const OWNER_USER = 'u-owner-fixture'
const OWNER_QQ = '90001'

/** 装配层给的"逐消息解析器"：复用 U1-WP2b-1 的读写链（真实映射表 + 幂等建档） */
const resolveInboundUserId = async (input: { externalId: string }): Promise<string> => {
  const resolution = await resolveInboundIdentityWithStore(
    {
      transport: 'qq',
      botId: 'bot-fixture',
      selfId: 'bot-fixture',
      messageType: 'private',
      senderUserId: input.externalId,
    },
    {
      db,
      ownerUserId: OWNER_USER,
      allowedFor: () => true,
      deriveUserId: (x) => `u-${x.transport}-${x.externalId}`,
      ensureArchive: true,
    }
  )
  if (!resolution.outcome.ok) {
    throw new Error(`fixture 解析失败：${resolution.outcome.code}`)
  }
  return resolution.outcome.value.userId
}

function makeRecorder(options: {
  conversationId: string
  userId?: string
  userRef?: string
  withResolver?: boolean
}): InstanceType<typeof ConversationRecorder> {
  return new ConversationRecorder({
    db,
    characterId: CHARACTER,
    conversationId: asConversationId(options.conversationId),
    dryRun: false,
    userName: 'fixture-user',
    characterName: '苏沐薇',
    transport: 'qq',
    ...(options.userId === undefined ? {} : { userId: options.userId }),
    ...(options.userRef === undefined ? {} : { userRef: options.userRef }),
    ...(options.withResolver === true ? { resolveInboundUserId } : {}),
  })
}

async function countMappings(): Promise<number> {
  const rows = rowsOf(await db.execute(sql.raw("select count(*)::int as c from user_identity_mappings where transport='qq'")))
  return Number(rows[0]?.c ?? 0)
}

async function mappingOwnerOf(externalId: string): Promise<string | undefined> {
  const rows = rowsOf(
    await db.execute(sql`select user_id from user_identity_mappings where transport='qq' and external_id=${externalId}`)
  )
  return rows[0]?.user_id === undefined ? undefined : String(rows[0].user_id)
}

// ===========================================================================
// T0 隔离与量具自检
// ===========================================================================
record('T0.1', '沙箱不是生产库目录', isProductionDir(sandbox.dir) === false, `dir=${sandbox.dir}`)
record('T0.2', '起始态没有映射行', (await countMappings()) === 0, `mappings=${await countMappings()}`)

// ===========================================================================
// T1 现状回归：不给身份 ⇒ 与今天逐字节相同
// ===========================================================================
{
  const recorder = makeRecorder({ conversationId: 'dm-fixture-owner', userId: OWNER_USER, userRef: OWNER_QQ })
  const userId = await recorder.ensureIdentity()
  const mapped = await mappingOwnerOf(OWNER_QQ)
  record(
    'T1.1',
    '不给身份 ⇒ ensureIdentity 仍返回配置里的 userId，并把 userRef 绑定到它',
    userId === OWNER_USER && mapped === OWNER_USER,
    `userId=${userId} · mapping[${OWNER_QQ}]=${String(mapped)}`
  )
}
{
  // 传了身份、但装配层没给解析器 ⇒ **具名拒绝**（不静默回退）
  const before = await countMappings()
  const recorder = makeRecorder({ conversationId: 'dm-fixture-nofallback', userId: OWNER_USER })
  let code = 'NO_THROW'
  try {
    await recorder.ensureIdentityFor({ externalId: '70001' })
  } catch (error) {
    code = (error as { code?: string }).code ?? 'unknown'
  }
  const after = await countMappings()
  record(
    'T1.2',
    '**失败关闭①**：传了身份但没解析器 ⇒ inbound_identity_resolver_missing，且不写任何行',
    code === 'inbound_identity_resolver_missing' && after === before,
    `code=${code} · mappings ${before}→${after}`
  )
}
{
  const before = await countMappings()
  const recorder = makeRecorder({ conversationId: 'dm-fixture-empty', userId: OWNER_USER, withResolver: true })
  let code = 'NO_THROW'
  try {
    await recorder.ensureIdentityFor({ externalId: '   ' })
  } catch (error) {
    code = (error as { code?: string }).code ?? 'unknown'
  }
  record(
    'T1.3',
    '**失败关闭②**：平台账号为空 ⇒ inbound_identity_external_id_empty',
    code === 'inbound_identity_external_id_empty' && (await countMappings()) === before,
    `code=${code}`
  )
}
{
  const before = await countMappings()
  const recorder = new ConversationRecorder({
    db,
    characterId: CHARACTER,
    conversationId: asConversationId('dm-fixture-emptyself'),
    dryRun: false,
    userName: 'fixture-user',
    characterName: '苏沐薇',
    transport: 'qq',
    userId: OWNER_USER,
    resolveInboundUserId: async () => '   ',
  })
  let code = 'NO_THROW'
  try {
    await recorder.ensureIdentityFor({ externalId: '70002' })
  } catch (error) {
    code = (error as { code?: string }).code ?? 'unknown'
  }
  record(
    'T1.4',
    '**失败关闭③**：解析器返回空 userId ⇒ inbound_identity_user_id_empty',
    code === 'inbound_identity_user_id_empty' && (await countMappings()) === before,
    `code=${code}`
  )
}

// ===========================================================================
// T2 逐消息身份：按平台账号解析，且**不回退**
// ===========================================================================
const A_QQ = '71001'
{
  const recorder = makeRecorder({
    conversationId: 'dm-fixture-a',
    userId: OWNER_USER, // 配置里的单用户仍然在 —— 它**不得**被用
    withResolver: true,
  })
  const userId = await recorder.ensureIdentityFor({ externalId: A_QQ, displayName: 'A' })
  const mapped = await mappingOwnerOf(A_QQ)
  const resolvedIsNotConfiguredUser = userId !== OWNER_USER
  record(
    'T2.1',
    '逐消息解析 ⇒ 返回**平台账号**解析出的 userId（不是配置里的单用户）',
    userId === `u-qq-${A_QQ}` && resolvedIsNotConfiguredUser,
    `userId=${userId}`
  )
  record('T2.2', '该账号的映射行指向同一个人', mapped === userId, `mapping[${A_QQ}]=${String(mapped)}`)
  record(
    'T2.3',
    '**没有回退**：配置里的单用户**没有**得到这个账号的映射行',
    mapped !== OWNER_USER,
    `mapping[${A_QQ}]=${String(mapped)} · ownerUser=${OWNER_USER}`
  )
  // 会话身份绑定到解析出的人
  const conv = rowsOf(
    await db.execute(sql`select user_id from conversation_identities where conversation_id=${'dm-fixture-a'}`)
  )
  record('T2.4', 'conversation_identities 绑定到解析出的人', String(conv[0]?.user_id ?? '') === userId, `conv=${String(conv[0]?.user_id)}`)
}
{
  // 同一账号在**另一个会话**⇒ 同一 userId（计划书第 91 节的 Gate）
  const before = await countMappings()
  const other = makeRecorder({ conversationId: 'dm-fixture-a2', withResolver: true })
  const userId = await other.ensureIdentityFor({ externalId: A_QQ })
  record(
    'T2.5',
    '同一账号跨会话 ⇒ **同一 userId**，且不新建映射行',
    userId === `u-qq-${A_QQ}` && (await countMappings()) === before,
    `userId=${userId} · mappings ${before}→${await countMappings()}`
  )
}

// ===========================================================================
// T3 端到端：recordUserMessage 带身份 ⇒ 事件 actor 是解析出的人
// ===========================================================================
{
  const recorder = makeRecorder({ conversationId: 'dm-fixture-a3', withResolver: true })
  const outcome = await recorder.recordUserMessage('你好', 1, undefined, { externalId: A_QQ })
  const actor = outcome.event?.actorId
  record(
    'T3.1',
    'recordUserMessage(带身份) ⇒ 事件的 actor 是解析出的 userId',
    actor === `u-qq-${A_QQ}`,
    `actorId=${String(actor)}`
  )
}
{
  // 不给身份 ⇒ 走既有路径（配置里的 userId）
  const recorder = makeRecorder({ conversationId: 'dm-fixture-owner2', userId: OWNER_USER })
  const outcome = await recorder.recordUserMessage('你好', 1)
  record(
    'T3.2',
    'recordUserMessage(不带身份) ⇒ 走既有路径（配置里的 userId）',
    outcome.event?.actorId === OWNER_USER,
    `actorId=${String(outcome.event?.actorId)}`
  )
}

// ===========================================================================
// T4 三段式：拆掉"逐消息解析"这道防线必须判红
// ===========================================================================
{
  const attackerQq = '79999'
  // 弱化版：忽略平台账号，直接把"配置里的单用户"当成这个人 —— 正是"拆掉防线"的形状
  const weakened = makeRecorder({ conversationId: 'dm-weak', userId: OWNER_USER })
  const weakenedUserId = await weakened.ensureIdentity()
  record(
    'T4.1',
    '拆防线 · 忽略平台账号直接落配置里的单用户 ⇒ **陌生人会被记成主人**（证明防线在被量）',
    weakenedUserId === OWNER_USER && (await mappingOwnerOf(attackerQq)) === undefined,
    `weakendUserId=${weakenedUserId}`
  )
  const restored = makeRecorder({ conversationId: 'dm-restored', userId: OWNER_USER, withResolver: true })
  const restoredUserId = await restored.ensureIdentityFor({ externalId: attackerQq })
  const restoredIsNotSingleUser = restoredUserId !== OWNER_USER
  record(
    'T4.2',
    '恢复 · 真实逐消息解析把同一输入解析成**它自己的**身份',
    restoredUserId === `u-qq-${attackerQq}` && restoredIsNotSingleUser,
    `userId=${restoredUserId}`
  )
}

// ===========================================================================
// 汇总与收尾
// ===========================================================================
const failed = checks.filter((c) => !c.pass)
const passed = failed.length === 0
console.log('')
console.log(`  measured_count = ${checks.length}`)
console.log(`  ${passed ? '✅' : '❌'} u1:recorder-identity:verify = ${passed ? 'PASS' : 'FAIL'}`)
console.log(`  mappings(final)=${await countMappings()}`)
if (!passed) {
  console.log('  失败项：')
  for (const c of failed) console.log(`    - ${c.id} ${c.label}：${c.detail}`)
}

cleanupSandbox(sandbox.dir)
await resetPluginSqlConnection()
process.exit(passed ? 0 : 1)
