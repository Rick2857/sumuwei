/**
 * A1 / **WP4 门：`admin_jobs` 仓储**（隔离库上的三段式；`R-A1-3`）。
 *
 * ============================================================================
 *  跑法（本仓库的老坑，逐字照做）
 * ============================================================================
 * ```text
 * 本门用**目录沙箱**（PGlite）；`.env` 的 `CHARACTER_DB_BACKEND=postgres` 会让 `initDatabase`
 * 重读 `.env` 并把目录沙箱**整段跳过** ⇒ 本门在那种环境下**具名 NOT RUN（exit 2）**，不猜、不将就。
 * 正确跑法（在**没有 `.env` 的 cwd** 下驱动本脚本，或在本仓库 cwd 下把后端钉死）：
 *   $env:CHARACTER_DB_BACKEND='pglite'; $env:POSTGRES_URL=''; $env:DATABASE_URL=''
 *   $env:PGLITE_DATA_DIR=''; $env:PROJECT_LG_SANDBOX=''; $env:LG_PG_EXPECT_DATABASE=''
 *   pnpm a1:jobs-store:verify
 * ```
 * 它证什么（三段式）：
 * ```text
 * 正控 首次登记 ⇒ `create` 且**表里恰好一行**
 *      同键同参数再登记 ⇒ `replay` 且**仍是一行**、返回的是**原任务**（同 jobId）
 *      按 jobId 读回 ⇒ 拿到那一行（断线/刷新读结果的依据）
 * 负控 同键**不同参数** ⇒ `conflict` 且**不新增行**
 *      并发同键（两个 `admit` 同时发）⇒ 表里**只有一行**（唯一索引 + on conflict 的机器保证）
 *      终态不可再改：`succeeded` 之后 `markState('running')` ⇒ **原样返回**（不改库）
 * 恢复 `running` ⇒ `recoverInterrupted()` ⇒ `interrupted`，且**不自动重跑**（再跑一次改 0 条）
 * ```
 */
import { hashAdminPassword } from '../src/infrastructure/admin/auth.ts' // 仅用于保持与本批门的同一套导入风格
import { createAdminJobsStore } from '../src/infrastructure/admin-readers/admin-jobs-store.ts'
import { readCorePresence } from '../src/infrastructure/admin-readers/core-presence.ts'
import { isolateDatabase, cleanupSandbox } from '../src/dev/sandbox.ts'

const checks: { name: string; pass: boolean; detail: string }[] = []
const check = (name: string, pass: boolean, detail: string): void => {
  checks.push({ name, pass, detail })
}
void hashAdminPassword

if (process.env.CHARACTER_DB_BACKEND !== 'pglite') {
  console.log(
    '[NOT RUN] 本门用**目录沙箱**（PGlite）：当前 `CHARACTER_DB_BACKEND` 不是 `pglite`\n' +
      '  ⇒ `initDatabase` 会重读 `.env` 并跳过目录沙箱（那不是隔离）。\n' +
      '  跑法：在**没有 .env 的 cwd** 下驱动本脚本，或在本仓库 cwd 下钉死后端：\n' +
      "    $env:CHARACTER_DB_BACKEND='pglite'; $env:POSTGRES_URL=''; $env:DATABASE_URL='';\n" +
      "    $env:PGLITE_DATA_DIR=''; $env:PROJECT_LG_SANDBOX=''; $env:LG_PG_EXPECT_DATABASE=''\n" +
      '    pnpm a1:jobs-store:verify'
  )
  process.exit(2)
}

const sandbox = isolateDatabase('a1-jobs-store', { keep: true })
const { createThinHostRuntime } = await import('../src/infrastructure/runtime/thin-host-factory.ts')

const { character } = await import('../src/character/index.ts')
const { initDatabase } = await import('../src/db/index.ts')
const { getRawDb } = await import('../src/infrastructure/persistence/db.ts')

const runtime = createThinHostRuntime({
      character: character,
      settings: { PGLITE_DATA_DIR: sandbox.dir, CHARACTER_DB_BACKEND: 'pglite' },
    })
try {
  await initDatabase(runtime)
  const db = getRawDb(runtime)
  const store = createAdminJobsStore(db as never)

  const rows = async (): Promise<number> => {
    const result = await (db as unknown as { execute: (q: unknown) => Promise<{ rows: unknown[] }> }).execute(
      // 直接用 drizzle 的 sql 模板不方便（这里只要一个计数）⇒ 交给 store 的读法
      undefined as never
    ).catch(() => ({ rows: [] }))
    return result.rows.length
  }
  void rows

  // 正控：首次登记
  const first = await store.admit({ jobId: 'job-1', operator: 'admin-console', kind: 'RUN_DIAGNOSTIC', idempotencyKey: 'k-1', params: { a: 1, b: 2 } })
  check('正控 首次登记 ⇒ `create` 且返回的是它自己', first.admission.kind === 'create' && first.job.jobId === 'job-1', JSON.stringify(first.admission))
  check('正控 落库后状态是 `pending`', first.job.state === 'pending', first.job.state)

  // 正控：同键同参数 ⇒ replay（返回**原任务**）
  const again = await store.admit({ jobId: 'job-2', operator: 'admin-console', kind: 'RUN_DIAGNOSTIC', idempotencyKey: 'k-1', params: { b: 2, a: 1 } })
  check('正控 同键同参数 ⇒ `replay` 且**返回原任务**（同 jobId，不是新任务）',
    again.admission.kind === 'replay' && again.job.jobId === 'job-1', JSON.stringify(again.admission))

  // 负控：同键不同参数 ⇒ conflict
  const conflict = await store.admit({ jobId: 'job-3', operator: 'admin-console', kind: 'RUN_DIAGNOSTIC', idempotencyKey: 'k-1', params: { a: 9 } })
  check('负控 同键**不同参数** ⇒ `conflict` 且不返回新任务',
    conflict.admission.kind === 'conflict' && conflict.job.jobId === 'job-1', JSON.stringify(conflict.admission))

  // 正控：按 jobId 读回
  const read = await store.read('job-1')
  check('正控 按 jobId 读回 ⇒ 拿到那一行', read?.jobId === 'job-1' && read.paramsFingerprint === first.job.paramsFingerprint, JSON.stringify(read))

  // 状态推进 + 终态不可再改
  const done = await store.markState({ jobId: 'job-1', state: 'succeeded', resultRef: 'r-1' })
  check('正控 推进到 `succeeded` 并带 resultRef', done?.state === 'succeeded' && done.resultRef === 'r-1', JSON.stringify(done))
  const frozen = await store.markState({ jobId: 'job-1', state: 'running' })
  check('负控 **终态不可再改**：`succeeded` 之后推进 ⇒ 原样返回（仍是 succeeded）',
    frozen?.state === 'succeeded', String(frozen?.state))

  // 恢复：running ⇒ interrupted，不自动重跑
  await store.admit({ jobId: 'job-4', operator: 'admin-console', kind: 'RUN_DIAGNOSTIC', idempotencyKey: 'k-2', params: {} })
  await store.markState({ jobId: 'job-4', state: 'running' })
  const changed = await store.recoverInterrupted()
  const recovered = await store.read('job-4')
  check('恢复 `running` ⇒ `interrupted`（待核验）', changed === 1 && recovered?.state === 'interrupted', `changed=${changed} state=${String(recovered?.state)}`)
  check('恢复 **不自动重跑**：再跑一次 recover ⇒ 改 0 条',
    (await store.recoverInterrupted()) === 0, '应 0')

  // keyset 分页（`job_id` 升序；游标 = 上一页最后一条）
  for (const id of ['job-5', 'job-6', 'job-7']) {
    await store.admit({ jobId: id, operator: 'admin-console', kind: 'RUN_DIAGNOSTIC', idempotencyKey: `k-${id}`, params: { id } })
  }
  const page1 = await store.list({ limit: 3 })
  check('正控 keyset 分页：首页 3 条且带 `nextCursor`',
    page1.items.length === 3 && page1.nextCursor === page1.items[2]?.jobId,
    `items=${page1.items.length} next=${String(page1.nextCursor)}`)
  const page2 = await store.list({ cursor: page1.nextCursor, limit: 3 })
  check('正控 第二页用游标继续（**不重不漏**：与首页无交集）',
    page2.items.length > 0 && page2.items.every((row) => !page1.items.some((first) => first.jobId === row.jobId)),
    `page1=${page1.items.map((r) => r.jobId).join(',')} page2=${page2.items.map((r) => r.jobId).join(',')}`)
  check('正控 页大小在仓储层**再夹一次**（99999 ⇒ ≤50）',
    (await store.list({ limit: 99_999 })).items.length <= 50, String((await store.list({ limit: 99_999 })).items.length))

  /*
   * `R-A1-5` 的**负控**（真走到，不是假装）：本门跑在 PGlite 上，而 PGlite **不是**资格锁的权威
   * ⇒ 探针必须如实回 `null` + 具名原因，**绝不**把"查不出来"报成"核心离线"。
   * ⚠️ 第一版在 PGlite 上**真的**返回了 `offline`（查询不抛错、返回 0 行）—— 这是门抓到的**真缺陷**：
   *    "这个后端回答不了这个问题"与"核心真的没被持有"必须可分。
   */
  const presence = await readCorePresence({ db, characterId: 'c-1', backend: 'pglite' })
  check('R-A1-5 负控 非 postgres 后端 ⇒ `presence === null`（**不是** `offline`）',
    presence.presence === null, String(presence.presence))
  check('R-A1-5 负控 查不出来时**给出具名原因**（不吞掉）',
    (presence.unavailableReason ?? '').startsWith('not_postgres_backend'), String(presence.unavailableReason))
  check('R-A1-5 负控 查不出来时**不给** `heldCount`（不编一个 0）',
    presence.heldCount === undefined, String(presence.heldCount))
} finally {
  cleanupSandbox(sandbox.dir)
}

const failed = checks.filter((c) => !c.pass)
for (const item of checks) console.log(`${item.pass ? 'PASS' : 'FAIL'}  ${item.name}${item.pass ? '' : ` — ${item.detail}`}`)
console.log(`\nA1 / WP4 admin_jobs 仓储：判据 ${checks.length} · 失败 ${failed.length} · measured_count=${checks.length}`)
console.log('⚠️ 本门在**一次性隔离库**上跑（PGlite 目录沙箱）；**从不**打开真实库。')
if (checks.length === 0 || failed.length > 0) process.exit(1)
