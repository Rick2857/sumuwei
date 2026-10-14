/**
 * U1 · 写入侧打标门（`u1:write-path-labeling:verify`）—— `ADR-137` 的**写侧**
 *
 * 被测：`labelWrittenMemory`（新记忆写下时，用**本轮作用域**打上来源域）。
 * 隔离库（真标签表）+ 零模型 / 零出网。
 *
 * 判据重点：
 *   ① 打了标：来源域 = **本轮房间**（私聊 ⇒ 那个人 / 群 ⇒ 那个群），披露 = `private_to_origin`
 *   ② **写一次**：重复打标不改原标签（`already_labeled`）
 *   ③ **没有作用域 ⇒ 完全 no-op**（不打、不编来源域 ⇒ 未接线时行为逐字不变）
 *   ④ **收益**：打完标的记录随后经授权过滤器读回 —— 来源域本人**读得到**、旁人**读不到**
 *   ⑤ 拆防线：把来源域硬编码成"原主人私聊"（或提问者私聊）会把群来源记错
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
    console.log('  [NOT RUN] u1:write-path-labeling:verify（具名原因：directory_sandbox_requires_pglite_backend）')
    console.log('     跑法：在没有 .env 的 cwd 下驱动本脚本，并设 CHARACTER_DB_BACKEND=pglite（+ POSTGRES_URL= / DATABASE_URL=）。')
    console.log('     这不是"通过"：本门的读数为未取得。')
    process.exit(2)
  }
}

const runId = `u1-write-path-labeling-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`
const sandbox = isolateDatabase('u1-write-path-labeling', { runId, keep: true })
console.log(`  [sandbox] ${sandbox.dir}`)

const { createM4Harness } = await import('./m4-harness.ts')
const { labelWrittenMemory, labelReadingCreatedMemories, MEMORY_WRITE_PATH_LABELER } = await import(
  '../src/infrastructure/runtime/scope-labeling.ts'
)
const { readRecordScopeLabel, filterAuthorizedMemoryCandidates, ownerPrivateOriginRoom } = await import(
  '../src/infrastructure/persistence/record-scope-store.ts'
)
const { scopeContextOf } = await import('../src/infrastructure/persistence/record-scope-store.ts')
type ScopeContext = import('../src/kernel/contracts/scope.ts').ScopeContext

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

const h = await createM4Harness({ label: 'u1-write-path-labeling' })
const db = h.db

const OWNER = 'u-owner'
function privateScope(userId: string): ScopeContext {
  return {
    principal: { kind: 'user', userId, verifiedBy: 'onebot_inbound' },
    purpose: 'external_query',
    room: { kind: 'private', userId },
  }
}
function groupScope(groupId: string, userId = 'u-c'): ScopeContext {
  return {
    principal: { kind: 'user', userId, verifiedBy: 'onebot_inbound' },
    purpose: 'external_query',
    room: { kind: 'group', groupId },
  }
}

// ===========================================================================
// T1 私聊 + 有作用域 ⇒ 打上"那个人"的来源域
// ===========================================================================
{
  const outcome = await labelWrittenMemory({ db, scope: privateScope('u-a'), memoryId: 'mem-write-1', now: 1_700_000_000_000 })
  const label = await readRecordScopeLabel(db, 'memory', 'mem-write-1')
  record(
    'T1.1',
    '写下时打标 ⇒ 来源域 = **本轮房间**（私聊:u-a）、披露 = `private_to_origin`',
    outcome.labeled === true &&
      label?.originRoom.kind === 'private' &&
      label?.originRoom.userId === 'u-a' &&
      label?.disclosure === 'private_to_origin',
    `outcome=${outcome.reason} · room=${JSON.stringify(label?.originRoom)} · disclosure=${String(label?.disclosure)}`
  )
  record('T1.2', '`labeled_by` 记的是**写侧标记**（不是说话人）', label?.labeledBy === MEMORY_WRITE_PATH_LABELER, `labeledBy=${String(label?.labeledBy)}`)
}

// ===========================================================================
// T2 群 + 有作用域 ⇒ 来源域是**那个群**（不是提问者的私聊）
// ===========================================================================
{
  const outcome = await labelWrittenMemory({ db, scope: groupScope('g-1'), memoryId: 'mem-write-2' })
  const label = await readRecordScopeLabel(db, 'memory', 'mem-write-2')
  record(
    'T2.1',
    '群里的记忆 ⇒ 来源域 = **那个群**（不是提问者的私聊）',
    outcome.labeled === true && label?.originRoom.kind === 'group' && label?.originRoom.groupId === 'g-1',
    `room=${JSON.stringify(label?.originRoom)}`
  )
}

// ===========================================================================
// T3 写一次 · 重复打标不改原标签
// ===========================================================================
{
  const again = await labelWrittenMemory({ db, scope: privateScope('u-b'), memoryId: 'mem-write-1' })
  const label = await readRecordScopeLabel(db, 'memory', 'mem-write-1')
  record(
    'T3.1',
    '重复打标 ⇒ `already_labeled`，且**原标签逐字不变**（写一次）',
    again.labeled === false &&
      again.reason === 'already_labeled' &&
      label?.originRoom.kind === 'private' &&
      label?.originRoom.userId === 'u-a',
    `reason=${again.reason} · room=${JSON.stringify(label?.originRoom)}`
  )
}

// ===========================================================================
// T4 负控 · 没有作用域 ⇒ **完全 no-op**（不打标、不编来源域）
// ===========================================================================
{
  const skipped = await labelWrittenMemory({ db, scope: undefined, memoryId: 'mem-write-3' })
  const label = await readRecordScopeLabel(db, 'memory', 'mem-write-3')
  record(
    'T4.1',
    '没有作用域 ⇒ 不打标（`no_scope`）且**标签表里没有这一行**（不编来源域）',
    skipped.labeled === false && skipped.reason === 'no_scope' && label === undefined,
    `reason=${skipped.reason} · label=${String(label)}`
  )
  const emptyId = await labelWrittenMemory({ db, scope: privateScope('u-a'), memoryId: '   ' })
  record('T4.2', '空的 memoryId ⇒ 不打标（`empty_memory_id`）', emptyId.labeled === false && emptyId.reason === 'empty_memory_id', `reason=${emptyId.reason}`)
}

// ===========================================================================
// T5 **收益**：打完标的记录随后经授权过滤器读回 —— 本人读得到、旁人读不到
// ===========================================================================
{
  const asOwnerOfIt = await filterAuthorizedMemoryCandidates(db, {
    context: scopeContextOf({ principal: { kind: 'user', userId: 'u-a', verifiedBy: 'onebot_inbound' }, purpose: 'external_query', room: { kind: 'private', userId: 'u-a' } }),
    candidateIds: ['mem-write-1'],
    defaultOriginRoom: ownerPrivateOriginRoom(OWNER),
  })
  const asStranger = await filterAuthorizedMemoryCandidates(db, {
    context: scopeContextOf({ principal: { kind: 'user', userId: 'u-b', verifiedBy: 'onebot_inbound' }, purpose: 'external_query', room: { kind: 'private', userId: 'u-b' } }),
    candidateIds: ['mem-write-1'],
    defaultOriginRoom: ownerPrivateOriginRoom(OWNER),
  })
  record(
    'T5.1',
    '**收益**：写侧打标之后，来源域本人读得到、旁人读不到（标签真的接上了读面）',
    asOwnerOfIt.authorized.join(',') === 'mem-write-1' && asStranger.authorized.length === 0,
    `本人=${asOwnerOfIt.authorized.length} · 旁人=${asStranger.authorized.length}`
  )
}

// ===========================================================================
// T6 拆防线 · 把来源域硬编码成"原主人私聊"会把群来源记错
// ===========================================================================
{
  const real = await readRecordScopeLabel(db, 'memory', 'mem-write-2')
  const weakenedRoom = { kind: 'private' as const, userId: OWNER }
  record(
    'T6.1',
    '拆防线 · 硬编码"原主人私聊"与真实来源域（那个群）**不同** ⇒ 记错来源域会被量到',
    JSON.stringify(real?.originRoom) !== JSON.stringify(weakenedRoom) && real?.originRoom.kind === 'group',
    `real=${JSON.stringify(real?.originRoom)} · weakened=${JSON.stringify(weakenedRoom)}`
  )
}

// ===========================================================================
// T7 **自动记忆（生产主路径）**：一拍新建的 id 列表逐条打标
// ===========================================================================
{
  const outcome = await labelReadingCreatedMemories({
    db,
    scope: privateScope('u-a'),
    memoryIds: ['mem-auto-1', 'mem-auto-2', 'mem-auto-3'],
  })
  const first = await readRecordScopeLabel(db, 'memory', 'mem-auto-1')
  const third = await readRecordScopeLabel(db, 'memory', 'mem-auto-3')
  record(
    'T7.1',
    '一拍新建 3 条 ⇒ **逐条**打标（labeled=3），来源域都是本轮房间',
    outcome.labeled === 3 &&
      outcome.reason === 'labeled' &&
      first?.originRoom.kind === 'private' &&
      first?.originRoom.userId === 'u-a' &&
      third?.disclosure === 'private_to_origin',
    `labeled=${outcome.labeled} · reason=${outcome.reason}`
  )
  const again = await labelReadingCreatedMemories({ db, scope: privateScope('u-a'), memoryIds: ['mem-auto-1'] })
  record(
    'T7.2',
    '同一批再打一次 ⇒ `alreadyLabeled=1`（写一次，不覆盖）',
    again.alreadyLabeled === 1 && again.labeled === 0,
    `labeled=${again.labeled} · alreadyLabeled=${again.alreadyLabeled}`
  )
  const noIds = await labelReadingCreatedMemories({ db, scope: privateScope('u-a'), memoryIds: undefined })
  record(
    'T7.3',
    '**读数没带 id ⇒ 一条都不打**（`no_ids`）—— **不按计数瞎猜**是哪几条',
    noIds.reason === 'no_ids' && noIds.labeled === 0 && noIds.skipped === 0,
    `reason=${noIds.reason}`
  )
  const noScope = await labelReadingCreatedMemories({ db, scope: undefined, memoryIds: ['mem-auto-9'] })
  const notWritten = await readRecordScopeLabel(db, 'memory', 'mem-auto-9')
  record(
    'T7.4',
    '没有作用域（非本机入口）⇒ **全部跳过**（`no_scope`）且不写任何标签（不编来源域）',
    noScope.reason === 'no_scope' && noScope.skipped === 1 && notWritten === undefined,
    `reason=${noScope.reason} · skipped=${noScope.skipped}`
  )
}

// ===========================================================================
// T8 **覆盖面登记表**（`L-U1-WRITE-01` 的机器形态）
//
// 为什么要有它：本包的第一版**只覆盖显式记忆路径**，而结构门（只证 `main.ts` 接线点在）
// 看不见这件事 —— 是**人工对照 `.env` 与装配代码**才查出来的。
// ⇒ 把"哪条写路径**已**打标 / 哪条**已知未**打标"写成**机器可判**的一张表：
//    · 已打标的：源码里必须真的出现 `createdMemoryIds` / 打标调用（否则判红）
//    · 已知未打标的：源码里**必须还没有** —— 一旦有人补上，本门**判红**，
//      逼他回来更新这张表（先例：`RECALL_EXCLUSION_REASON_FACTS` 的"可达性登记"纪律）
// ===========================================================================
{
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const { dirname, join, resolve } = await import('node:path')
  /* ⚠️ 本门跑在**临时 cwd** 上（目录沙箱要求）⇒ 不能拿 `process.cwd()` 当仓库根 */
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

  /** 登记表：`path` 相对仓库根；`labeled` 表示"这条路径**已经**打标" */
  const WRITE_PATH_COVERAGE: readonly {
    readonly path: string
    readonly name: string
    readonly labeled: boolean
    readonly marker: string
  }[] = [
    { path: 'src/main.ts', name: '显式记忆（buildMemoryWriter）', labeled: true, marker: 'labelWrittenMemory({' },
    { path: 'src/infrastructure/runtime/automatic-memory.ts', name: '自动记忆（LangMem / 生产主路径）', labeled: true, marker: 'createdMemoryIds:' },
    { path: 'src/infrastructure/runtime/post-turn-model-memory.ts', name: '后处理模型档（生产关着）', labeled: true, marker: 'createdMemoryIds:' },
  ]

  for (const entry of WRITE_PATH_COVERAGE) {
    const source = readFileSync(join(ROOT, entry.path), 'utf8')
    const present = source.includes(entry.marker)
    record(
      `T8.${entry.labeled ? '1' : '2'}.${WRITE_PATH_COVERAGE.indexOf(entry)}`,
      entry.labeled
        ? `已打标路径 · ${entry.name}：源码里真的出现 \`${entry.marker}\``
        : `**已知未**打标路径 · ${entry.name}：源码里**还没有** \`${entry.marker}\`（补上就要来改这张表）`,
      entry.labeled ? present : !present,
      `present=${String(present)} · expected=${entry.labeled ? 'true' : 'false'}`
    )
  }
}

// ===========================================================================
// 汇总
// ===========================================================================
const failed = checks.filter((c) => !c.pass)
const passed = failed.length === 0
console.log('')
console.log(`  measured_count = ${checks.length}`)
console.log(`  ${passed ? '✅' : '❌'} u1:write-path-labeling:verify = ${passed ? 'PASS' : 'FAIL'}`)
console.log('  ⚠️ 本门只证写侧模块：`main.ts` 是否调用它由 `u1:main-wiring:verify`（结构判据）守。')
console.log('  ⚠️ **覆盖面**：只覆盖**显式记忆**路径（`ExplicitMemoryTurnPort.written`）；')
console.log('     `memoryPostTurnModelEnabled` 打开时的**后台写路径**（`PostTurnModelMemoryConsumer.tick()`）')
console.log('     **尚未打标** —— 见 `L-U1-WRITE-01`（本门不证覆盖面，此打印是为了别被读成"写侧完成了"）。')
if (!passed) {
  console.log('  失败项：')
  for (const c of failed) console.log(`    - ${c.id} ${c.label}：${c.detail}`)
}

cleanupSandbox(sandbox.dir)
await resetPluginSqlConnection()
process.exit(passed ? 0 : 1)
