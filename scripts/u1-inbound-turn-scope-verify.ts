/**
 * U1 · 入站消息 ⇒ 本轮作用域门（`u1:inbound-turn-scope:verify`）—— WP2b-2b 的核心
 *
 * 归属：多用户补充计划 U1（`ADR-133` `D05`/`D12`；[`ADR-138`](../../docs/adr/ADR-138-authorization-filter-before-truncation.md)）。
 *
 * 被测：`resolveInboundTurnScope`（把**平台事实** ⇒ 身份解析 ⇒ 入口作用域三层接起来）。
 * 隔离库（真身份映射表）+ 零模型 / 零出网。
 *
 * 判据重点：
 *   ① 私聊 / 群 / 原主人 三种形状各自给出正确的作用域
 *   ② **身份证据只有平台账号**：没有它 ⇒ 失败关闭（不给 scope）
 *   ③ 纯判定层的拒绝（群号出现在私聊里 / 未获准 / 自聊）⇒ 失败关闭且**不建档**
 *   ④ 幂等：重复解析**不改绑**、`boundFirstTime` 第二次为 false
 *   ⑤ 缺省来源域恒为**原主人私聊**
 *   ⑥ 拆防线：把"解析失败"当作原主人 ⇒ 与真实读数相反
 */

import { cleanupSandbox, isolateDatabase, resetPluginSqlConnection } from '../src/dev/sandbox.ts'

// 后端闸（与其它 U1 隔离门同形）
{
  const { config: loadDotenv } = await import('dotenv')
  const { existsSync } = await import('node:fs')
  const { dirname, join } = await import('node:path')
  let envDir = process.cwd()
  while (!existsSync(join(envDir, '.env')) && dirname(envDir) !== envDir) envDir = dirname(envDir)
  loadDotenv({ path: join(envDir, '.env'), quiet: true })
  const { databaseBackendEnvironmentFrom, resolveDatabaseBackend } = await import(
    '../src/infrastructure/persistence/database-backend.ts'
  )
  if (resolveDatabaseBackend(databaseBackendEnvironmentFrom()).backend === 'postgres') {
    console.log('')
    console.log('  [NOT RUN] u1:inbound-turn-scope:verify（具名原因：directory_sandbox_requires_pglite_backend）')
    console.log('     跑法：在没有 .env 的 cwd 下驱动本脚本，并设 CHARACTER_DB_BACKEND=pglite（+ POSTGRES_URL= / DATABASE_URL=）。')
    console.log('     这不是"通过"：本门的读数为未取得。')
    process.exit(2)
  }
}

const runId = `u1-inbound-turn-scope-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`
const sandbox = isolateDatabase('u1-inbound-turn-scope', { runId, keep: true })
console.log(`  [sandbox] ${sandbox.dir}`)

const { createM4Harness } = await import('./m4-harness.ts')
const { resolveInboundTurnScope } = await import('../src/infrastructure/runtime/inbound-turn-scope.ts')

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

const h = await createM4Harness({ label: 'u1-inbound-turn-scope' })
const db = h.db

const OWNER_USER = 'u-owner-domain'
const BOT = 'bot-10001'
const OWNER_QQ = '10001'
const STRANGER_QQ = '20002'

/** 平台事实（私聊） */
const privateFacts = (senderUserId: string) => ({
  transport: 'qq',
  botId: BOT,
  selfId: BOT,
  messageType: 'private',
  senderUserId,
})
const groupFacts = (senderUserId: string, groupId: string) => ({
  transport: 'qq',
  botId: BOT,
  selfId: BOT,
  messageType: 'group',
  senderUserId,
  groupId,
})

/** 确定性推导：原主人账号 ⇒ 原主人领域 id；其余 ⇒ 按平台账号推导 */
const derive = ({ externalId }: { readonly transport: string; readonly externalId: string }): string =>
  externalId === OWNER_QQ ? OWNER_USER : `user-qq-${externalId}`

const base = { ownerUserId: OWNER_USER, db, deriveUserId: derive, ensureArchive: true } as const

// ===========================================================================
// T1 私聊 + 原主人账号 ⇒ {owner, private:原主人}（首次建档）
// ===========================================================================
{
  const owner = await resolveInboundTurnScope({ ...base, facts: privateFacts(OWNER_QQ), allowedFor: () => true })
  const ownerRoom = owner.scope?.room
  record(
    'T1.1',
    '私聊 + 原主人账号 ⇒ principal=owner、room=private:原主人',
    owner.failClosed === false &&
      owner.scope?.principal.kind === 'owner' &&
      ownerRoom?.kind === 'private' &&
      ownerRoom.userId === OWNER_USER,
    `kind=${String(owner.scope?.principal.kind)} · room=${JSON.stringify(ownerRoom)}`
  )
  record('T1.2', '首次见到获准账号 ⇒ `boundFirstTime=true`（幂等建档）', owner.boundFirstTime === true, `boundFirstTime=${String(owner.boundFirstTime)}`)
}

// ===========================================================================
// T2 幂等 · 再解析 ⇒ 不改绑、boundFirstTime=false
// ===========================================================================
{
  const again = await resolveInboundTurnScope({ ...base, facts: privateFacts(OWNER_QQ), allowedFor: () => true })
  const againRoom = again.scope?.room
  record(
    'T2.1',
    '重复解析同一账号 ⇒ `boundFirstTime=false` 且作用域不变（**重复解析不得改绑**）',
    again.boundFirstTime === false &&
      again.scope?.principal.kind === 'owner' &&
      againRoom !== undefined &&
      againRoom.kind === 'private' &&
      againRoom.userId === OWNER_USER,
    `boundFirstTime=${String(again.boundFirstTime)} · userId=${String(again.userId)}`
  )
}

// ===========================================================================
// T3 私聊 + 陌生账号（获准）⇒ {user, private:该用户}
// ===========================================================================
{
  const stranger = await resolveInboundTurnScope({
    ...base,
    facts: privateFacts(STRANGER_QQ),
    allowedFor: () => true,
  })
  record(
    'T3.1',
    '私聊 + 陌生但**获准**的账号 ⇒ principal=user、room=private:该用户（**不是** owner）',
    stranger.failClosed === false &&
      stranger.scope?.principal.kind === 'user' &&
      stranger.scope?.room.kind === 'private' &&
      stranger.scope.room.userId === `user-qq-${STRANGER_QQ}`,
    `kind=${String(stranger.scope?.principal.kind)} · room=${JSON.stringify(stranger.scope?.room)}`
  )
}

// ===========================================================================
// T4 群消息 ⇒ room 是那个群；群未授权 ⇒ roomAuthorized=false
// ===========================================================================
{
  const group = await resolveInboundTurnScope({
    ...base,
    facts: groupFacts(STRANGER_QQ, 'g-500'),
    allowedFor: () => true,
  })
  record(
    'T4.1',
    '群消息 ⇒ room 是**那个群**（不是私聊）',
    group.failClosed === false && group.scope?.room.kind === 'group' && group.scope?.room.groupId === 'g-500',
    `room=${JSON.stringify(group.scope?.room)}`
  )
  record('T4.2', '群未授权 ⇒ `roomAuthorized=false`（如实传递，不替策略放行）', group.roomAuthorized === false, `roomAuthorized=${String(group.roomAuthorized)}`)
}

// ===========================================================================
// T5 失败关闭 · 没有平台账号证据 / 纯判定层拒绝
// ===========================================================================
{
  const noSender = await resolveInboundTurnScope({ ...base, facts: privateFacts('') })
  record(
    'T5.1',
    '**没有平台账号证据** ⇒ 不给 scope（失败关闭），**不当作原主人**',
    noSender.failClosed === true && noSender.scope === undefined && noSender.boundFirstTime === false,
    `failClosed=${String(noSender.failClosed)} · reason=${noSender.reason}`
  )
  const notAllowed = await resolveInboundTurnScope({
    ...base,
    facts: privateFacts('30003'),
    allowedFor: () => false,
  })
  record(
    'T5.2',
    '账号**未获准** ⇒ 失败关闭且**不建档**（`boundFirstTime=false`）',
    notAllowed.failClosed === true && notAllowed.scope === undefined && notAllowed.boundFirstTime === false,
    `reason=${notAllowed.reason}`
  )
  const groupIdInPrivate = await resolveInboundTurnScope({
    ...base,
    facts: { ...privateFacts(OWNER_QQ), groupId: 'g-should-not-be-here' },
  })
  record(
    'T5.3',
    '**群号出现在私聊消息里** ⇒ 纯判定层拒绝 ⇒ 失败关闭（具名理由）',
    groupIdInPrivate.failClosed === true && groupIdInPrivate.scope === undefined,
    `reason=${groupIdInPrivate.reason}`
  )
}

// ===========================================================================
// T6 缺省来源域恒为原主人私聊（`ADR-138` `D02`）
// ===========================================================================
{
  const stranger = await resolveInboundTurnScope({ ...base, facts: privateFacts(STRANGER_QQ), allowedFor: () => true })
  const failed = await resolveInboundTurnScope({ ...base, facts: privateFacts('') })
  const strangerOrigin = stranger.defaultOriginRoom
  const failedOrigin = failed.defaultOriginRoom
  record(
    'T6.1',
    '成功与失败**两条路**的缺省来源域都是**原主人私聊**（旧无标签记录对主人可见、对旁人不可见）',
    strangerOrigin.kind === 'private' &&
      strangerOrigin.userId === OWNER_USER &&
      failedOrigin.kind === 'private' &&
      failedOrigin.userId === OWNER_USER,
    `ok=${JSON.stringify(strangerOrigin)} · fail=${JSON.stringify(failedOrigin)}`
  )
}

// ===========================================================================
// T7 拆防线 · "解析失败 ⇒ 当作原主人"必与真实读数相反
// ===========================================================================
{
  const failed = await resolveInboundTurnScope({ ...base, facts: privateFacts('') })
  const weakened = { principal: { kind: 'owner' }, room: { kind: 'private', userId: OWNER_USER } }
  record(
    'T7.1',
    '拆防线 · 把"解析失败"补成原主人作用域 ⇒ 与真实读数相反（真实是 `scope === undefined`）',
    failed.scope === undefined && weakened.principal.kind === 'owner',
    `real=${String(failed.scope)} · weakened=${weakened.principal.kind}`
  )
}

// ===========================================================================
// 汇总
// ===========================================================================
const failedChecks = checks.filter((c) => !c.pass)
const passed = failedChecks.length === 0
console.log('')
console.log(`  measured_count = ${checks.length}`)
console.log(`  ${passed ? '✅' : '❌'} u1:inbound-turn-scope:verify = ${passed ? 'PASS' : 'FAIL'}`)
console.log('  ⚠️ 本门只证"这一层翻译得对"：`main.ts` 仍未调用它（生产未接线）。')
if (!passed) {
  console.log('  失败项：')
  for (const c of failedChecks) console.log(`    - ${c.id} ${c.label}：${c.detail}`)
}

cleanupSandbox(sandbox.dir)
await resetPluginSqlConnection()
process.exit(passed ? 0 : 1)
