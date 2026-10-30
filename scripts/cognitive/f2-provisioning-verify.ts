/**
 * **F2 真实建库路径验收门（simhost pgtest 超级用户实例 · 零模型请求）**。
 *
 * 用户要求：不能只凭函数返回认定清理成功 —— 必须在**具备建库权限**的实例上：
 * ```text
 * ① 六个单元各自**不同**的 `lg_test_*` 库 + **不同**角色（真实建库路径，非 reuse-instance）
 * ② 每个库**初始为空**（public schema 无表）；每个单元有**独立文件根**（空目录）
 * ③ 正常结束 ⇒ 清理后查 `pg_database` / `pg_roles` 确认为 0
 * ④ 故障退出（抛错后的 finally）⇒ 同样清理并查目录确认
 * ```
 * ⚠️ 本门**不**跑任务环、不发模型请求：只验收建库/清理这条真实路径。
 * ⚠️ 需要超级用户 admin 连接串：`LG_SIM_PGTEST_ADMIN_URL`（pgtest.ts 注入）。
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const out = resolve('artifacts/local/f2-provisioning', `run-${Date.now()}`)
mkdirSync(out, { recursive: true })
const checks: string[] = []
const check = (name: string, value: unknown, detail = ''): void => {
  if (!value) throw new Error(`${name}${detail === '' ? '' : ` — ${detail}`}`)
  checks.push(name)
  console.log(`PASS ${name}${detail === '' ? '' : ` — ${detail}`}`)
}
const adminUrl = (process.env.LG_SIM_PGTEST_ADMIN_URL ?? process.env.LG_F2_ADMIN_URL ?? '').trim()

/** ⚠️ 断言失败时也要清理**已创建**的库/角色（清理必须在失败路径上发生，否则门自己会泄漏）。 */
const created: Awaited<ReturnType<typeof import('./f2-sequence-runner.ts').provisionF2UnitDatabase>>[] = []
try {
  if (adminUrl === '') throw new Error('需要超级用户 admin 连接串（LG_SIM_PGTEST_ADMIN_URL）')
  const pg = (await import('pg')).default
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 })
  const { provisionF2UnitDatabase, cleanupF2UnitDatabase } = await import('./f2-sequence-runner.ts')
  const units = ['A-cf', 'A-af', 'B-cf', 'B-af', 'C-cf', 'C-af']

  /* ① 真实建库：六个单元各自不同库 + 不同角色 */
  const provisioned = [] as Awaited<ReturnType<typeof provisionF2UnitDatabase>>[]
  for (const unit of units) provisioned.push(await provisionF2UnitDatabase(admin, adminUrl, unit))
  created.push(...provisioned)
  const databases = provisioned.map(item => item.database)
  const roles = provisioned.map(item => item.role)
  check('建库：六个单元各自**不同**的 lg_test_* 库（真实建库路径）',
    databases.length === 6 && new Set(databases).size === 6 && databases.every(name => name.startsWith('lg_test_f2_')),
    databases.join(','))
  check('建库：六个单元各自**不同**角色', roles.length === 6 && new Set(roles).size === 6, roles.join(','))
  const dbCatalog = await admin.query('select datname from pg_database where datname = any($1::text[])', [databases])
  const roleCatalog = await admin.query('select rolname from pg_roles where rolname = any($1::text[])', [roles])
  check('建库：系统目录里六个库与六个角色**确实存在**',
    dbCatalog.rows.length === 6 && roleCatalog.rows.length === 6,
    `db=${String(dbCatalog.rows.length)} role=${String(roleCatalog.rows.length)}`)

  /* ② 每个库初始为空 + 独立空文件根 */
  const tableCounts: number[] = []
  const businessRows: number[] = []
  const dbNames: string[] = []
  for (const item of provisioned) {
    const probe = new pg.Pool({ connectionString: item.url, max: 1 })
    const identity = await probe.query('select current_database() as db')
    dbNames.push(String(identity.rows[0]?.db))
    const tables = await probe.query("select count(*)::int as count from information_schema.tables where table_schema = 'public'")
    tableCounts.push(Number(tables.rows[0]?.count ?? -1))
    /* 真实路径在建库后会**应用 Kernel 迁移** ⇒ 期望"schema 已就绪、但没有业务数据"。 */
    const names = await probe.query("select table_name from information_schema.tables where table_schema = 'public'")
    let rows = 0
    for (const row of names.rows as { table_name?: string }[]) {
      const name = String(row.table_name ?? '')
      /* 迁移元数据表（drizzle journal / migration ledger）不算业务数据。 */
      if (/migration|journal|drizzle/i.test(name)) continue
      if (!/(state|event|record|memory|ledger|turn|character)/i.test(name)) continue
      try {
        const counted = await probe.query(`select count(*)::int as count from public."${name.replace(/"/g, '""')}"`)
        rows += Number(counted.rows[0]?.count ?? 0)
      } catch { /* 视图/无权限：不计 */ }
    }
    businessRows.push(rows)
    await probe.end()
  }
  check('隔离：每个连接看到的都是**自己那个库**（current_database 与分配名一致）',
    dbNames.length === 6 && dbNames.every((name, index) => name === databases[index]), dbNames.join(','))
  check('初始状态：每个新库 **schema 已就绪**（迁移已应用，public 有表）',
    tableCounts.length === 6 && tableCounts.every(count => count > 0), tableCounts.join(','))
  check('初始状态：每个新库**没有业务数据**（核心表行数合计 0）',
    businessRows.length === 6 && businessRows.every(count => count === 0), businessRows.join(','))

  const roots = units.map(unit => resolve(out, `files-${unit}`))
  for (const root of roots) mkdirSync(root, { recursive: true })
  check('文件根：六个单元各自**独立目录**且初始为空',
    new Set(roots).size === 6 && roots.every(root => existsSync(root) && readdirSync(root).length === 0))

  /* ③ 正常结束 ⇒ 清理并**查目录确认** */
  for (const item of provisioned) await item.pool.end()
  const normalCleanup = []
  for (const item of provisioned) normalCleanup.push(await cleanupF2UnitDatabase(admin, item.database, item.role))
  check('清理（正常）：每个库/角色的清理结果都是 db=0、role=0，且无错误',
    normalCleanup.length === 6 && normalCleanup.every(item => item.dbRemaining === 0 && item.roleRemaining === 0 && item.error === undefined),
    JSON.stringify(normalCleanup.map(item => [item.dbRemaining, item.roleRemaining])))
  const afterNormalDb = await admin.query('select count(*)::int as count from pg_database where datname = any($1::text[])', [databases])
  const afterNormalRole = await admin.query('select count(*)::int as c from pg_roles where rolname = any($1::text[])', [roles])
  check('清理（正常）：系统目录确认**六个库与六个角色都已删除**',
    Number(afterNormalDb.rows[0]?.count) === 0 && Number(afterNormalRole.rows[0]?.c) === 0,
    `db=${String(afterNormalDb.rows[0]?.count)} role=${String(afterNormalRole.rows[0]?.c)}`)

  /* ④ 故障退出：抛错也要在 finally 里清理，并查目录确认 */
  const faulty = await provisionF2UnitDatabase(admin, adminUrl, 'fault')
  created.push(faulty)
  await faulty.pool.end()
  let faultError: string | undefined
  try {
    throw new Error('simulated failure before normal cleanup')
  } catch (error) {
    faultError = error instanceof Error ? error.message : String(error)
  } finally {
    const verified = await cleanupF2UnitDatabase(admin, faulty.database, faulty.role)
    check('清理（故障）：finally 里的清理结果为 db=0、role=0 且无错误',
      verified.dbRemaining === 0 && verified.roleRemaining === 0 && verified.error === undefined,
      JSON.stringify(verified))
    const afterFaultDb = await admin.query('select count(*)::int as count from pg_database where datname = $1', [faulty.database])
    const afterFaultRole = await admin.query('select count(*)::int as c from pg_roles where rolname = $1', [faulty.role])
    check('清理（故障）：系统目录确认库与角色**都已删除**（不是凭函数返回）',
      Number(afterFaultDb.rows[0]?.count) === 0 && Number(afterFaultRole.rows[0]?.c) === 0,
      `db=${String(afterFaultDb.rows[0]?.count)} role=${String(afterFaultRole.rows[0]?.c)}`)
  }
  check('故障路径确实被触发（用来证明 finally 清理不是白跑）', faultError !== undefined, faultError)

  await admin.end()
  writeFileSync(resolve(out, 'verification.json'), JSON.stringify({
    status: 'PASS', schema: 'f2-provisioning@1', measuredAt: new Date().toISOString(), checks,
    instances: { adminHost: new URL(adminUrl).host, databases, roles },
    boundary: [
      '本门零真实模型请求：只验收建库/清理路径',
      '库与角色名随运行不同（每次新建），本记录只是本次实测',
      'reuse-instance 模式不建库；真实路径必须通过本门（或等价验收）',
    ],
  }, null, 2))
  console.log(`F2 建库验收门：${String(checks.length)}/${String(checks.length)}；${out}`)
} catch (error) {
  /* ⚠️ 失败路径清理：把 created 里还没删的库/角色删掉并**查目录确认**（不吞错）。 */
  try {
    const pgModule = (await import('pg')).default
    const admin = new pgModule.Pool({ connectionString: adminUrl, max: 2 })
    const leftover: string[] = []
    for (const item of created) {
      await item.pool.end().catch(() => undefined)
      const verified = await (await import('./f2-sequence-runner.ts')).cleanupF2UnitDatabase(admin, item.database, item.role)
      if (verified.dbRemaining !== 0 || verified.roleRemaining !== 0) leftover.push(`${item.database}:${item.role}`)
    }
    await admin.end()
    if (leftover.length > 0) console.error(`失败路径仍有残留：${leftover.join(',')}`)
    else console.error(`失败路径已清理 created=${String(created.length)}`)
  } catch (cleanupError) {
    console.error(`失败路径清理出错：${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`)
  }
  writeFileSync(resolve(out, 'verification.json'), JSON.stringify({
    status: 'FAIL', schema: 'f2-provisioning@1', measuredAt: new Date().toISOString(), checks,
    error: error instanceof Error ? error.message : String(error),
  }, null, 2))
  throw error
}
