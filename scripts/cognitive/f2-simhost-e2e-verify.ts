/**
 * **simhost 完整零网络组合验收（真实 CLI → 六个独立库 → 任务执行 → 账本对账 → 删除确认）**。
 *
 * 用户要求：现有建库门只测建库，**没有**把"真实 CLI 跑六单元 + 真库 + 账本 + 删除"串起来。
 * 本门在 simhost pgtest **超级用户实例**上、用**假 fetch**（零模型请求）跑一次完整 `--run`：
 * ```text
 * ① 伪造"已授权"封存（仅门内）+ 13 门读数 fixture
 * ② 真实 CLI --run：per-unit-admin（每单元真建库），假 fetch 供模型响应
 * ③ 断言：6 单元 COMPLETE、6 个不同库 + 6 个不同角色、每库身份与分配名一致、
 *          每单元独立文件根、请求账本 24 条（B 臂 0）、任务账本 36 题、锁在固定目录
 * ④ 断言：每单元清理结果为 db=0/role=0，且系统目录里**没有**本 run 的残留库/角色
 * ```
 * ⚠️ 需要 `LG_SIM_PGTEST_ADMIN_URL`（超级用户）；零真实模型请求。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const out = resolve('artifacts/local/f2-simhost-e2e', `run-${Date.now()}`)
mkdirSync(out, { recursive: true })
const checks: string[] = []
const check = (name: string, value: unknown, detail = ''): void => {
  if (!value) throw new Error(`${name}${detail === '' ? '' : ` — ${detail}`}`)
  checks.push(name)
  console.log(`PASS ${name}${detail === '' ? '' : ` — ${detail}`}`)
}
const adminUrl = (process.env.LG_SIM_PGTEST_ADMIN_URL ?? process.env.LG_F2_ADMIN_URL ?? '').trim()
const cliPath = 'scripts/cognitive/f2-live-runner.ts'
const sealDir = resolve(out, 'seal')
const runDir = resolve(out, 'run')
const filesRoot = resolve(out, 'files')
mkdirSync(sealDir, { recursive: true })

const spawnCli = (args: string[], env: Record<string, string>) => {
  const result = spawnSync(process.execPath, ['--import', './node_modules/tsx/dist/loader.mjs', cliPath, ...args], {
    encoding: 'utf8', timeout: 1_800_000, env: { ...process.env, ...env },
  })
  return { status: result.status, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') }
}

try {
  if (adminUrl === '') throw new Error('需要超级用户 admin 连接串（LG_SIM_PGTEST_ADMIN_URL）')
  const { F2_REQUIRED_GATE_IDS } = await import('./f2-live-runner-guards.ts')
  const readings = JSON.stringify(Object.fromEntries(F2_REQUIRED_GATE_IDS.map(id => [id, 'PASS'])))
  const baseEnv: Record<string, string> = {
    F2_EXECUTOR_DIR: sealDir, F2_GATE_READINGS_JSON: readings,
    F2_SOURCE_FINGERPRINT: 'fp-simhost-e2e', F2_IMAGE_ID: 'sha256:simhost-e2e',
    OPENAI_BASE_URL: 'https://gate.invalid/v1', OPENAI_SMALL_MODEL: 'gate-model', OPENAI_API_KEY: 'gate-fake-key',
    F2_GATE_TEST_HARNESS: '1', F2_GATE_FAKE_FETCH: '1',
    LG_F2_ADMIN_URL: adminUrl, F2_FILES_ROOT: filesRoot, F2_RUN_DIR: runDir,
  }

  /* ① 干封存 → 伪造为已授权（仅门内） */
  const seal = spawnCli(['--seal'], baseEnv)
  if (seal.status !== 0) throw new Error(`封存失败：${seal.stderr.slice(-400)}`)
  const sealPath = resolve(sealDir, 'f2-seal.json')
  const manifest = JSON.parse(readFileSync(sealPath, 'utf8')) as Record<string, unknown>
  writeFileSync(sealPath, JSON.stringify({ ...manifest, status: 'SEALED_RUN_AUTHORIZED' }))
  writeFileSync(resolve(sealDir, 'f2-run-authorization.json'), JSON.stringify({ authorized: true }))
  const startMarker = String((manifest as { startMarker?: unknown }).startMarker ?? '')
  check('准备：临时封存已伪造为"已授权"（仅门内）且带 startMarker', startMarker !== '')

  const pgPre = (await import('pg')).default
  const adminPre = new pgPre.Pool({ connectionString: adminUrl, max: 1 })
  const preDb = await adminPre.query("select count(*)::int as count from pg_database where datname like 'lg_test_f2_%'")
  const preRole = await adminPre.query("select count(*)::int as c from pg_roles where rolname like 'lg_test_owner_%'")
  await adminPre.end()
  const baseline = { db: Number(preDb.rows[0]?.count ?? -1), role: Number(preRole.rows[0]?.c ?? -1) }

  /* ② 真实 CLI --run（真建库 + 假 fetch） */
  const run = spawnCli(['--run'], baseEnv)
  const report = JSON.parse(readFileSync(resolve(runDir, 'sequence-report.json'), 'utf8').replace(/^\uFEFF/, '')) as {
    status: string, code?: string
    totals: { units: number, physicalRequests: number, expectedTasks: number, finishedTasks: number, inFlightTasks: number, notRunTasks: number }
    budget: { usedRequests: number }
    units: readonly {
      unit: string, provisionedDb: string, provisionedRole: string | null, childExitCode: number | null
      report?: { db?: { name: string, user: string } }
      ledger: { readable: boolean, requests: number, inFlight: number }
      journal: { finished: number }
      cleanup: { required: boolean, dbRemaining: number | null, roleRemaining: number | null, error?: string }
      tasks: { finished: number }
    }[]
  }
  writeFileSync(resolve(out, 'sequence-report.json'), JSON.stringify(report, null, 2))
  writeFileSync(resolve(out, 'cli-stdout.txt'), `${run.stdout}\n--- stderr ---\n${run.stderr}`)

  check('CLI：--run 退出码 0 且序列 COMPLETE（六单元）',
    run.status === 0 && report.status === 'COMPLETE' && report.totals.units === 6,
    `exit=${String(run.status)} ${report.status}/${String(report.totals.units)}`)
  const databases = report.units.map(item => item.provisionedDb)
  const roles = report.units.map(item => item.provisionedRole ?? '')
  check('隔离：**六个不同库**（每单元真建库）且库名都以 lg_test_ 开头',
    new Set(databases).size === 6 && databases.every(name => name.startsWith('lg_test_')), databases.join(','))
  check('隔离：**六个不同角色**（每单元专属）',
    new Set(roles).size === 6 && roles.every(name => name.startsWith('lg_test_owner_')), roles.join(','))
  check('隔离：每个子进程 `current_database()` 与分配库名一致',
    report.units.every(item => (item.report?.db?.name ?? '') === item.provisionedDb),
    report.units.map(item => `${item.unit}:${item.report?.db?.name ?? '?'}`).join(','))
  check('隔离：每个子进程连接用户 = 分配角色',
    report.units.every(item => (item.report?.db?.user ?? '') === item.provisionedRole))
  check('隔离：每单元**独立文件根**（六个目录都存在且互不相同）',
    report.units.every(item => existsSync(resolve(filesRoot, item.unit)))
    && new Set(report.units.map(item => resolve(filesRoot, item.unit))).size === 6)
  check('任务：六单元合计完成 36 题、分母 36、无在途/未运行',
    report.totals.expectedTasks === 36 && report.totals.finishedTasks === 36
    && report.totals.inFlightTasks === 0 && report.totals.notRunTasks === 0)
  check('账本：物理请求累计 24（B 两单元脚本 0）、账本可读且无在途尝试',
    report.totals.physicalRequests === 24 && report.budget.usedRequests === 24
    && report.units.every(item => item.ledger.readable && item.ledger.inFlight === 0),
    `phys=${String(report.totals.physicalRequests)} used=${String(report.budget.usedRequests)}`)
  check('任务账本：每单元 6 题已完成（六单元 36 行）',
    report.units.every(item => item.tasks.finished === 6)
    && (readFileSync(resolve(runDir, 'tasks.jsonl'), 'utf8').match(/"kind":"task_finished"/g) ?? []).length === 36)
  check('锁：started.lock 在固定目录（<封存目录>/locks/<startMarker>.lock）',
    existsSync(resolve(sealDir, 'locks', `${startMarker}.lock`)))
  check('清理：每单元清理结果都是 db=0、role=0 且无错误',
    report.units.every(item => item.cleanup.required
      && item.cleanup.dbRemaining === 0 && item.cleanup.roleRemaining === 0 && item.cleanup.error === undefined),
    JSON.stringify(report.units.map(item => [item.cleanup.dbRemaining, item.cleanup.roleRemaining])))

  /* ④ 系统目录：本 run 的库/角色**确实都没了** */
  const pg = (await import('pg')).default
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 })
  const dbLeft = await admin.query('select datname from pg_database where datname = any($1::text[])', [databases])
  const roleLeft = await admin.query('select rolname from pg_roles where rolname = any($1::text[])', [roles])
  const strayDb = await admin.query("select count(*)::int as count from pg_database where datname like 'lg_test_f2_%'")
  const strayRole = await admin.query("select count(*)::int as c from pg_roles where rolname like 'lg_test_owner_%'")
  await admin.end()
  check('目录确认：本 run 的六个库与六个角色都已删除',
    dbLeft.rows.length === 0 && roleLeft.rows.length === 0,
    `db=${String(dbLeft.rows.length)} role=${String(roleLeft.rows.length)}`)
  check('目录确认：本次运行**没有新增**残留（实例里既有残留不计入，前后增量必须为 0）',
    Number(strayDb.rows[0]?.count) === baseline.db && Number(strayRole.rows[0]?.c) === baseline.role,
    `baseline(db=${String(baseline.db)},role=${String(baseline.role)}) -> after(db=${String(strayDb.rows[0]?.count)},role=${String(strayRole.rows[0]?.c)})`)

  writeFileSync(resolve(out, 'verification.json'), JSON.stringify({
    status: 'PASS', schema: 'f2-simhost-e2e@1', measuredAt: new Date().toISOString(), checks,
    sequence: { status: report.status, units: report.totals.units, physicalRequests: report.totals.physicalRequests, finishedTasks: report.totals.finishedTasks, expectedTasks: report.totals.expectedTasks },
    instances: { databases, roles, filesRoot, startMarker, leftoverBaseline: baseline },
    boundary: [
      '零真实模型请求：模型响应由假 fetch 提供（F2_GATE_FAKE_FETCH=1）',
      '封存是门内伪造的"已授权"，只用于驱动真实 CLI 路径；不代表运行授权',
      '本门只证明"真实 CLI + 真库 + 账本 + 删除"这条组合链；真实模型行为仍未观察',
    ],
  }, null, 2))
  console.log(`F2 simhost 组合验收：${String(checks.length)}/${String(checks.length)}；${out}`)
} catch (error) {
  writeFileSync(resolve(out, 'verification.json'), JSON.stringify({
    status: 'FAIL', schema: 'f2-simhost-e2e@1', measuredAt: new Date().toISOString(), checks,
    error: error instanceof Error ? error.message : String(error),
  }, null, 2))
  throw error
}
