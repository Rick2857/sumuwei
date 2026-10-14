/**
 * U1 · 记录作用域标签门（`u1:record-scope:verify`）—— WP4 / `ADR-137` 方案 B
 *
 * 归属：多用户补充计划 U1（[ADR-137](../../docs/adr/ADR-137-record-scope-labels.md)，2026-10-14 原主人裁定方案 B）。
 *
 * 隔离库 + 零模型 / 零出网。判据围绕五件事：
 *   ① 迁移 `0019` 真的建了表（列名齐、能被查询）
 *   ② 标签**写一次**：已存在的标签不被悄悄改写（披露变更必须是另一个显式动作）
 *   ③ **保守缺省**：缺标签 ⇒ `private_to_origin` + `labelMissing=true`（**绝不**退化成公共）
 *   ④ **数据库层**的 CHECK 是活的（绕过应用层直接插非法行 ⇒ 被库拒）
 *   ⑤ 迁移**只建表**：事后 `record_scope_labels` 为空（**不**给旧记录回填）
 *
 * 三段式：正控（写读一致 / 缺省保守 / 缺标签被如实列出）· 负控（**把缺省换成公共会被判红**）· 恢复。
 */

import { cleanupSandbox, isolateDatabase, resetPluginSqlConnection } from '../src/dev/sandbox.ts'

// 后端闸（与其它 U1/S1 隔离门同形）
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
    console.log('  [NOT RUN] u1:record-scope:verify（具名原因：directory_sandbox_requires_pglite_backend）')
    console.log('     跑法：在没有 .env 的 cwd 下驱动本脚本，并设 CHARACTER_DB_BACKEND=pglite（+ POSTGRES_URL= / DATABASE_URL=）。')
    console.log('     这不是"通过"：本门的读数为未取得。')
    process.exit(2)
  }
}

const runId = `u1-record-scope-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`
const sandbox = isolateDatabase('u1-record-scope', { runId, keep: true })
console.log(`  [sandbox] ${sandbox.dir}`)

const { createM4Harness } = await import('./m4-harness.ts')
const { sql } = await import('drizzle-orm')
const { rowsOf } = await import('../src/infrastructure/persistence/db.ts')
const { latestSchemaVersion } = await import('../src/infrastructure/persistence/migrations.ts')
const {
  labelRecordScope,
  readRecordScopeLabel,
  effectiveDisclosure,
  listMemoryRecordsMissingScopeLabels,
} = await import('../src/infrastructure/persistence/record-scope-store.ts')
type DisclosureClass = import('../src/kernel/contracts/scope.ts').DisclosureClass

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

const h = await createM4Harness({ label: 'u1-record-scope' })
const db = h.db
const labelBy = 'memory-write-path@1'

// ===========================================================================
// T1 迁移真的建了表（列名齐 + schema 版本前进到 19）
// ===========================================================================
{
  const cols = rowsOf(
    await db.execute(
      sql`select column_name from information_schema.columns
          where table_schema = 'public' and table_name = 'record_scope_labels'`
    )
  ).map((row) => String(row.column_name))
  const expected = [
    'record_kind',
    'record_id',
    'origin_room_kind',
    'origin_room_id',
    'disclosure',
    'labeled_at',
    'labeled_by',
  ]
  const missing = expected.filter((name) => !cols.includes(name))
  record('T1.1', '迁移 0019 建了 record_scope_labels，且七个列都在', missing.length === 0 && cols.length === expected.length, `cols=${cols.length} · missing=${missing.join(',') || '无'}`)
  /*
   * ⚠️ 这条判据原来写死 `=== 19` ⇒ 2026-10-14 树前进到 **20**（`0020 a1-admin-jobs`）时它**假红**。
   *   "写死一个版本号"的量具会在**每次**后续迁移落地时误报，而且它训练人去改数字 ——
   *   这与 `postgresql-g02-verify.ts` 写死 18 是**同一类缺陷**（本轮已修，先例在案）。
   * 判据的**本意**是"0019 已应用 ⇒ 版本**至少**前进到 19" ⇒ 用 `>=`，不是 `===`。
   */
  const latest = latestSchemaVersion()
  record('T1.2', 'schema 版本**至少**前进到 19（0019 已应用；不写死具体版本）', latest >= 19, `latest=${String(latest)}`)
}

// ===========================================================================
// T2 迁移**只建表**：不回填（事后表为空）
// ===========================================================================
{
  const rows = rowsOf(await db.execute(sql.raw('select count(*)::int as c from record_scope_labels')))
  record('T2.1', '迁移后 record_scope_labels 为空（**没有**给旧记录回填 origin）', Number(rows[0]?.c ?? -1) === 0, `rows=${String(rows[0]?.c)}`)
}

// ===========================================================================
// T3 正控 · 写读一致
// ===========================================================================
{
  const created = await labelRecordScope(db, {
    recordKind: 'memory',
    recordId: 'mem-scope-fixture',
    originRoom: { kind: 'private', userId: 'u-a' },
    disclosure: 'private_to_origin',
    labeledBy: labelBy,
    now: 1_700_000_000_000,
  })
  const label = await readRecordScopeLabel(db, 'memory', 'mem-scope-fixture')
  record(
    'T3.1',
    '写一行标签 ⇒ 读回逐字一致（kind/id/room/disclosure/labeled_by）',
    created.created === true &&
      label?.recordKind === 'memory' &&
      label?.recordId === 'mem-scope-fixture' &&
      label?.originRoom.kind === 'private' &&
      label?.originRoom.userId === 'u-a' &&
      label?.disclosure === 'private_to_origin' &&
      label?.labeledBy === labelBy,
    `label=${JSON.stringify(label)}`
  )
}

// ===========================================================================
// T4 负控 · 标签**写一次**：已存在的标签不被悄悄改写
// ===========================================================================
{
  const again = await labelRecordScope(db, {
    recordKind: 'memory',
    recordId: 'mem-scope-fixture',
    originRoom: { kind: 'group', groupId: 'g-x' },
    disclosure: 'public_to_room',
    labeledBy: 'some-other-writer@1',
  })
  const label = await readRecordScopeLabel(db, 'memory', 'mem-scope-fixture')
  record(
    'T4.1',
    '重复写同一记录 ⇒ created=false，且**原标签逐字不变**（披露变更不是重写这一行）',
    again.created === false && label?.disclosure === 'private_to_origin' && label?.originRoom.kind === 'private',
    `created=${String(again.created)} · disclosure=${String(label?.disclosure)} · room=${String(label?.originRoom.kind)}`
  )
}

// ===========================================================================
// T5 保守缺省（缺标签 ⇒ private_to_origin + labelMissing，**绝不**公共）
// ===========================================================================
{
  const missing = effectiveDisclosure(undefined)
  const present = effectiveDisclosure(await readRecordScopeLabel(db, 'memory', 'mem-scope-fixture'))
  const absent = effectiveDisclosure(await readRecordScopeLabel(db, 'memory', 'no-such-record'))
  record(
    'T5.1',
    '缺标签 ⇒ private_to_origin + labelMissing=true',
    missing.disclosure === 'private_to_origin' && missing.labelMissing === true,
    `disclosure=${missing.disclosure} · labelMissing=${String(missing.labelMissing)}`
  )
  record(
    'T5.2',
    '有标签 ⇒ 用它且 labelMissing=false；查不到的行也落到同一条保守缺省',
    present.disclosure === 'private_to_origin' && present.labelMissing === false && absent.labelMissing === true,
    `present.missing=${String(present.labelMissing)} · absent.missing=${String(absent.labelMissing)}`
  )
}

// ===========================================================================
// T6 负控（拆防线）· 把缺省换成"公共"必须被判红
// ===========================================================================
{
  // 弱化版：缺标签时按"同群可见"处理 —— 这正是"最保守"那条防线被拆掉的形状
  const weakened = (label: unknown): DisclosureClass =>
    label === undefined ? 'public_to_room' : (label as { disclosure: DisclosureClass }).disclosure
  const conservative = effectiveDisclosure(undefined)
  record(
    'T6.1',
    '拆防线 · 缺省换成 public_to_room ⇒ **与真实判定不同**（证明"保守缺省"是被量到的）',
    weakened(undefined) !== conservative.disclosure,
    `weakened=${weakened(undefined)} · real=${conservative.disclosure}`
  )
  record('T6.2', '恢复 · 真实判定仍是 private_to_origin', effectiveDisclosure(undefined).disclosure === 'private_to_origin', 'private_to_origin')
}

// ===========================================================================
// T7 数据库层 CHECK 是活的（绕过应用层直接插非法行 ⇒ 被库拒）
// ===========================================================================
{
  const attempts: { id: string; label: string; statement: string }[] = [
    { id: 'T7.1', label: '非法 disclosure', statement: `insert into record_scope_labels values ('memory','bad-1','private','u-a','public','1','w@1')` },
    { id: 'T7.2', label: '非法 record_kind', statement: `insert into record_scope_labels values ('attachment','bad-2','private','u-a','private_to_origin','1','w@1')` },
    { id: 'T7.3', label: '非法 origin_room_kind', statement: `insert into record_scope_labels values ('memory','bad-3','public','u-a','private_to_origin','1','w@1')` },
    { id: 'T7.4', label: '空的 origin_room_id', statement: `insert into record_scope_labels values ('memory','bad-4','private','','private_to_origin','1','w@1')` },
    { id: 'T7.5', label: '空的 labeled_by', statement: `insert into record_scope_labels values ('memory','bad-5','private','u-a','private_to_origin','1','')` },
  ]
  for (const attempt of attempts) {
    let rejected = false
    try {
      await db.execute(sql.raw(attempt.statement))
    } catch {
      rejected = true
    }
    record(attempt.id, `库层 CHECK 拒绝：${attempt.label}`, rejected, rejected ? '被库拒（失败关闭）' : '**竟然写进去了**')
  }
  // 应用层也拒（不给"绕过应用层就没人管"留缝）
  let appRejected = false
  try {
    await labelRecordScope(db, {
      recordKind: 'memory',
      recordId: 'mem-app-invalid',
      originRoom: { kind: 'private', userId: 'u-a' },
      disclosure: 'nope' as DisclosureClass,
      labeledBy: labelBy,
    })
  } catch {
    appRejected = true
  }
  record('T7.6', '应用层也拒非法 disclosure（两层都要有）', appRejected, appRejected ? '被拒' : '竟然通过')
}

// ===========================================================================
// T8 完整性报告：没有标签的活记录被**如实列出**（不静默、不回填）
// ===========================================================================
{
  // 直接插一条 memory_records（唯一目的是让"缺标签"这件事有对象；不是生产写入路径）
  await db.execute(
    sql.raw(`insert into memory_records
      (id, owner_kind, owner_id, memory_type, content_kind, content, epistemic_status, authority,
       importance, confidence, status, content_fingerprint, recorded_at, reducer_version,
       schema_version, created_at, updated_at)
      values ('mem-scope-unlabeled','character','char_sumuwei','person_fact','claim','{}'::jsonb,
              'unconfirmed','USER_EXPLICIT',0.5,0.5,'active','fp-scope-fixture',1,'memory-reducer@1',1,1,1)`)
  )
  const before = await listMemoryRecordsMissingScopeLabels(db, 20)
  record(
    'T8.1',
    '缺标签的记忆出现在完整性报告里（total ≥ 1 且样例含它）',
    before.total >= 1 && before.sample.includes('mem-scope-unlabeled'),
    `total=${before.total} · sample=${before.sample.join(',')}`
  )
  await labelRecordScope(db, {
    recordKind: 'memory',
    recordId: 'mem-scope-unlabeled',
    originRoom: { kind: 'private', userId: 'u-a' },
    disclosure: 'private_to_origin',
    labeledBy: labelBy,
  })
  const after = await listMemoryRecordsMissingScopeLabels(db, 20)
  record(
    'T8.2',
    '给它补上标签 ⇒ 不再出现在报告里（报告是"如实列出"，不是"回填"）',
    !after.sample.includes('mem-scope-unlabeled') && after.total === before.total - 1,
    `total ${before.total}→${after.total}`
  )
}

// ===========================================================================
// 汇总
// ===========================================================================
const failed = checks.filter((c) => !c.pass)
const passed = failed.length === 0
console.log('')
console.log(`  measured_count = ${checks.length}`)
console.log(`  ${passed ? '✅' : '❌'} u1:record-scope:verify = ${passed ? 'PASS' : 'FAIL'}`)
if (!passed) {
  console.log('  失败项：')
  for (const c of failed) console.log(`    - ${c.id} ${c.label}：${c.detail}`)
}

cleanupSandbox(sandbox.dir)
await resetPluginSqlConnection()
process.exit(passed ? 0 : 1)
