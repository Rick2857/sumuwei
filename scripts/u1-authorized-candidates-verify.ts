/**
 * U1 · 授权前置过滤门（`u1:authorized-candidates:verify`）—— `G18` / `ADR-138`
 *
 * 归属：[`ADR-138`](../../docs/adr/ADR-138-authorization-filter-before-truncation.md)（`ACCEPTED / DESIGN FROZEN`）。
 *
 * 它证明的是**次序**这件事：**授权过滤必须早于候选截断**（`filter → slice`，不是 `slice → filter`）。
 * 隔离库 + 零模型 / 零出网。被测函数：`filterAuthorizedMemoryCandidates`（存取层，已过 typecheck）。
 *
 * ⚠️ 这一门**不**代表 `G18` 已关闭：关闭条件是"**读取面**真的按这个次序过滤"；
 *    今天召回调用点**还没有**接它（截断仍在 `memory-retrieval-store.ts:345-348`）。
 *
 * 三段式：正控（越权候选占满前缀时合法记录仍被选出 · 同序 · 计数如实）
 *        · 负控（**换成 slice→filter 就会缩水** ⇒ 必须判红 · 缺标签对普通用户拒/对原主人可见）
 *        · 恢复（改回正确次序 ⇒ 重新填满）
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
    console.log('  [NOT RUN] u1:authorized-candidates:verify（具名原因：directory_sandbox_requires_pglite_backend）')
    console.log('     跑法：在没有 .env 的 cwd 下驱动本脚本，并设 CHARACTER_DB_BACKEND=pglite（+ POSTGRES_URL= / DATABASE_URL=）。')
    console.log('     这不是"通过"：本门的读数为未取得。')
    process.exit(2)
  }
}

const runId = `u1-authorized-candidates-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`
const sandbox = isolateDatabase('u1-authorized-candidates', { runId, keep: true })
console.log(`  [sandbox] ${sandbox.dir}`)

const { createM4Harness } = await import('./m4-harness.ts')
const {
  labelRecordScope,
  filterAuthorizedMemoryCandidates,
  ownerPrivateOriginRoom,
  scopeContextOf,
} = await import('../src/infrastructure/persistence/record-scope-store.ts')
type Principal = import('../src/kernel/contracts/scope.ts').Principal
type Room = import('../src/kernel/contracts/scope.ts').Room

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

const h = await createM4Harness({ label: 'u1-authorized-candidates' })
const db = h.db

const OWNER_ID = 'u-owner'
const userA = (): Principal => ({ kind: 'user', userId: 'u-a', verifiedBy: 'onebot_inbound' })
const owner = (): Principal => ({ kind: 'owner', userId: OWNER_ID, verifiedBy: 'config_binding' })
const priv = (id: string): Room => ({ kind: 'private', userId: id })
const grp = (id: string): Room => ({ kind: 'group', groupId: id })

/* 标签夹具：owner / 别的用户 / 别的群 / 本人两条 / 群公开一条 / **一条故意不打标** */
await labelRecordScope(db, { recordKind: 'memory', recordId: 'mem-owner', originRoom: priv(OWNER_ID), disclosure: 'private_to_origin', labeledBy: 'fixture@1' })
await labelRecordScope(db, { recordKind: 'memory', recordId: 'mem-b', originRoom: priv('u-b'), disclosure: 'private_to_origin', labeledBy: 'fixture@1' })
await labelRecordScope(db, { recordKind: 'memory', recordId: 'mem-group-other', originRoom: grp('g-2'), disclosure: 'public_to_room', labeledBy: 'fixture@1' })
await labelRecordScope(db, { recordKind: 'memory', recordId: 'mem-a1', originRoom: priv('u-a'), disclosure: 'private_to_origin', labeledBy: 'fixture@1' })
await labelRecordScope(db, { recordKind: 'memory', recordId: 'mem-a2', originRoom: priv('u-a'), disclosure: 'private_to_origin', labeledBy: 'fixture@1' })
await labelRecordScope(db, { recordKind: 'memory', recordId: 'mem-a-group', originRoom: grp('g-1'), disclosure: 'public_to_room', labeledBy: 'fixture@1' })

/** 越权候选**占满前缀**：前三条 u-a 都读不到，合法的那两条排在后面 */
const CANDIDATES = ['mem-owner', 'mem-b', 'mem-group-other', 'mem-a1', 'mem-unlabeled', 'mem-a2', 'mem-a-group']

// ===========================================================================
// T1 正控 · 过滤早于截断：同序 + 计数如实 + limit 被填满
// ===========================================================================
{
  const outcome = await filterAuthorizedMemoryCandidates(db, {
    context: scopeContextOf({ principal: userA(), purpose: 'external_query', room: priv('u-a') }),
    candidateIds: CANDIDATES,
    defaultOriginRoom: ownerPrivateOriginRoom(OWNER_ID),
  })
  const filled = outcome.authorized.slice(0, 2)
  record(
    'T1.1',
    '前三条越权候选占满前缀 ⇒ 合法的两条**仍然**被选出，且 `limit=2` **被填满**',
    filled.length === 2 && filled[0] === 'mem-a1' && filled[1] === 'mem-a2',
    `authorized=${outcome.authorized.join(',')} · slice(2)=${filled.join(',')}`
  )
  record(
    'T1.2',
    '返回**与传入候选同序**（过滤不重排）',
    outcome.authorized.join(',') === 'mem-a1,mem-a2',
    `authorized=${outcome.authorized.join(',')}`
  )
  record(
    'T1.3',
    '缩水**可观测**：denied=5、其中因缺标签而拒的=1（不静默）',
    outcome.denied === 5 && outcome.deniedForMissingLabel === 1,
    `denied=${outcome.denied} · deniedForMissingLabel=${outcome.deniedForMissingLabel}`
  )
  record(
    'T1.4',
    '逐条留痕只记 id 与否决码（**不记正文**）',
    outcome.reasons.length === CANDIDATES.length &&
      outcome.reasons.every((item) => typeof item.recordId === 'string' && typeof item.scopeCode === 'string'),
    `reasons=${outcome.reasons.length}`
  )
}

// ===========================================================================
// T2 负控（拆防线）· 换成 `slice → filter` 就会缩水
// ===========================================================================
{
  const limitation = 2
  // 旧次序：先按 limit 截断，**再**过滤 —— 这正是 `G18` 登记的缺口形状
  const oldOrder = CANDIDATES.slice(0, limitation)
  const oldOutcome = await filterAuthorizedMemoryCandidates(db, {
    context: scopeContextOf({ principal: userA(), purpose: 'external_query', room: priv('u-a') }),
    candidateIds: oldOrder,
    defaultOriginRoom: ownerPrivateOriginRoom(OWNER_ID),
  })
  const newOutcome = await filterAuthorizedMemoryCandidates(db, {
    context: scopeContextOf({ principal: userA(), purpose: 'external_query', room: priv('u-a') }),
    candidateIds: CANDIDATES,
    defaultOriginRoom: ownerPrivateOriginRoom(OWNER_ID),
  })
  const newSliced = newOutcome.authorized.slice(0, limitation)
  record(
    'T2.1',
    '拆防线 · `slice(2) → filter` 得到 **0 条**，而 `filter → slice(2)` 得到 **2 条** ⇒ 次序就是被量的那件事',
    oldOutcome.authorized.length === 0 && newSliced.length === 2,
    `old=${oldOutcome.authorized.length} 条 · new=${newSliced.length} 条`
  )
  record(
    'T2.2',
    '恢复 · 正确次序恒定给满（两次调用结果一致，只读且幂等）',
    newOutcome.authorized.join(',') === newSliced.join(',') && newSliced.length === 2,
    `authorized=${newOutcome.authorized.join(',')}`
  )
}

// ===========================================================================
// T3 缺标签的保守缺省（`ADR-138` `D02`）：普通用户不可见、**原主人可见**
// ===========================================================================
{
  const asStranger = await filterAuthorizedMemoryCandidates(db, {
    context: scopeContextOf({ principal: userA(), purpose: 'external_query', room: priv('u-a') }),
    candidateIds: ['mem-unlabeled'],
    defaultOriginRoom: ownerPrivateOriginRoom(OWNER_ID),
  })
  const asOwner = await filterAuthorizedMemoryCandidates(db, {
    context: scopeContextOf({ principal: owner(), purpose: 'external_query', room: priv(OWNER_ID) }),
    candidateIds: ['mem-unlabeled'],
    defaultOriginRoom: ownerPrivateOriginRoom(OWNER_ID),
  })
  record(
    'T3.1',
    '缺标签 + 普通用户 ⇒ 不可见，且计入 `deniedForMissingLabel`',
    asStranger.authorized.length === 0 && asStranger.deniedForMissingLabel === 1,
    `authorized=${asStranger.authorized.length} · missing=${asStranger.deniedForMissingLabel}`
  )
  record(
    'T3.2',
    '缺标签 + **原主人** ⇒ 可见（缺省来源域 = 原主人私聊 ⇒ 旧档案不因没标签而对主人失明）',
    asOwner.authorized.join(',') === 'mem-unlabeled',
    `authorized=${asOwner.authorized.join(',')} · code=${asOwner.reasons[0]?.scopeCode}`
  )
  record(
    'T3.3',
    '缺标签**不是**"当成提问者的私聊"：原主人以外的人（含别的普通用户）一律不可见',
    asStranger.authorized.length === 0 && asOwner.authorized.length === 1,
    `stranger=${asStranger.authorized.length} · owner=${asOwner.authorized.length}`
  )
}

// ===========================================================================
// T4 群来源：同群 + 已授权 ⇒ 可见；别的群 / 私聊里 ⇒ 不可见
// ===========================================================================
{
  const inGroup = await filterAuthorizedMemoryCandidates(db, {
    context: scopeContextOf({ principal: userA(), purpose: 'external_query', room: grp('g-1') }),
    candidateIds: ['mem-a-group', 'mem-group-other'],
    defaultOriginRoom: ownerPrivateOriginRoom(OWNER_ID),
    roomAuthorized: true,
  })
  record(
    'T4.1',
    '同群（g-1）+ 群已授权 ⇒ 只看得到 g-1 那条；g-2 那条仍不可见',
    inGroup.authorized.join(',') === 'mem-a-group' && inGroup.denied === 1,
    `authorized=${inGroup.authorized.join(',')} · denied=${inGroup.denied}`
  )
  const unauthorizedRoom = await filterAuthorizedMemoryCandidates(db, {
    context: scopeContextOf({ principal: userA(), purpose: 'external_query', room: grp('g-1') }),
    candidateIds: ['mem-a-group'],
    defaultOriginRoom: ownerPrivateOriginRoom(OWNER_ID),
    roomAuthorized: false,
  })
  record(
    'T4.2',
    '群**未获授权** ⇒ 同群那条也不可见（room_not_authorized）',
    unauthorizedRoom.authorized.length === 0,
    `authorized=${unauthorizedRoom.authorized.length} · code=${unauthorizedRoom.reasons[0]?.scopeCode}`
  )
}

// ===========================================================================
// T5 边界：空候选 ⇒ 空结果，不查库、不炸
// ===========================================================================
{
  const empty = await filterAuthorizedMemoryCandidates(db, {
    context: scopeContextOf({ principal: userA(), purpose: 'external_query', room: priv('u-a') }),
    candidateIds: [],
    defaultOriginRoom: ownerPrivateOriginRoom(OWNER_ID),
  })
  record('T5.1', '空候选 ⇒ 空结果（且不报错）', empty.authorized.length === 0 && empty.denied === 0, 'authorized=0')
}

// ===========================================================================
// 汇总
// ===========================================================================
const failed = checks.filter((c) => !c.pass)
const passed = failed.length === 0
console.log('')
console.log(`  measured_count = ${checks.length}`)
console.log(`  ${passed ? '✅' : '❌'} u1:authorized-candidates:verify = ${passed ? 'PASS' : 'FAIL'}`)
console.log('  ⚠️ 本门**不**关闭 G18：读取面尚未接线（截断仍在 memory-retrieval-store.ts:345-348）。')
if (!passed) {
  console.log('  失败项：')
  for (const c of failed) console.log(`    - ${c.id} ${c.label}：${c.detail}`)
}

cleanupSandbox(sandbox.dir)
await resetPluginSqlConnection()
process.exit(passed ? 0 : 1)
