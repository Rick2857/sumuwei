/**
 * **F2 序列门（真实 CLI 子进程）**：验证"真实路径"的接线，而不是函数各自能跑。
 *
 * ```text
 * complete：`--run` 六单元 → 每单元**独立子进程 + 独立 lg_test_ 库**（db 名逐个核对）；
 *           物理请求 = 6 单元 × 6 题（假 fetch 计量）；请求账本/任务账本/started.lock 齐备
 * budget  ：F2_GATE_REQUESTS_CAP=3 ⇒ 第一个单元就用尽 ⇒ 序列 STOPPED（budget_requests），
 *           累计口径**以账本为准**（不靠内存计数器）
 * crash   ：F2_GATE_CRASH_AFTER_TASKS=2 ⇒ 子进程模拟崩溃（exit≠0）⇒ 任务账本 finished≥2 且 inFlight=1
 * rerun   ：同一运行目录再跑 ⇒ `already_started`（一次封存只允许一次运行）
 * single  ：`--unit A-cf` 单单元路径同样走隔离库 + 账本
 * ```
 * ⚠️ 全程零真实模型请求：`F2_GATE_TEST_HARNESS=1 + F2_GATE_FAKE_FETCH=1` ⇒ CLI 子进程用**假 fetch**。
 */
import { existsSync, mkdirSync, readFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { runPreparedPgGate, runPreparedPgGateInInstance } from '../postgresql/test-harness.ts'

const SCRIPT = 'scripts/cognitive/f2-sequence-verify.ts'

// ===========================================================================
//  子进程：跑 CLI 的真实执行路径（父/子进程链由 CLI 自己 spawn）
// ===========================================================================
if (process.env.LG_F2_SEQ_CHILD === '1') {
  const out = String(process.env.LG_F2_SEQ_OUT)
  mkdirSync(out, { recursive: true })
  const cli = (args: string[], env: Record<string, string>): { status: number | null, stdout: string, stderr: string } => {
    const result = spawnSync(process.execPath,
      ['--import', './node_modules/tsx/dist/loader.mjs', 'scripts/cognitive/f2-live-runner.ts', ...args],
      { encoding: 'utf8', timeout: 900_000, env: { ...process.env, ...env } })
    return { status: result.status, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') }
  }
  /** 每个场景**自己的封存目录**（startMarker 不同 ⇒ 锁身份不同；同一场景内复用同一封存）。 */
  const sealDirOf = (name: string): string => resolve(out, `seal-${name}`)
  const prepareSeal = (name: string): string => {
    const dir = sealDirOf(name)
    mkdirSync(dir, { recursive: true })
    const sealed = spawnSync(process.execPath,
      ['--import', './node_modules/tsx/dist/loader.mjs', 'scripts/cognitive/f2-live-runner.ts', '--seal'],
      { encoding: 'utf8', env: {
        ...process.env, F2_EXECUTOR_DIR: dir, F2_GATE_READINGS_JSON: String(process.env.LG_F2_SEQ_READINGS),
        F2_SOURCE_FINGERPRINT: 'fp-gate', F2_IMAGE_ID: 'sha256:gate-image',
        OPENAI_BASE_URL: 'https://gate.invalid/v1', OPENAI_SMALL_MODEL: 'gate-model',
      } })
    if (sealed.status !== 0) throw new Error(`seal failed for ${name}`)
    const sealPath = resolve(dir, 'f2-seal.json')
    const manifest = JSON.parse(readFileSync(sealPath, 'utf8')) as Record<string, unknown>
    writeFileSync(sealPath, JSON.stringify({ ...manifest, status: 'SEALED_RUN_AUTHORIZED' }))
    writeFileSync(resolve(dir, 'f2-run-authorization.json'), JSON.stringify({ authorized: true }))
    return dir
  }
  const baseEnv = (runDir: string, sealDir: string): Record<string, string> => ({
    F2_EXECUTOR_DIR: sealDir,
    F2_GATE_READINGS_JSON: String(process.env.LG_F2_SEQ_READINGS),
    F2_SOURCE_FINGERPRINT: 'fp-gate', F2_IMAGE_ID: 'sha256:gate-image',
    OPENAI_API_KEY: 'gate-fake-key', OPENAI_BASE_URL: 'https://gate.invalid/v1', OPENAI_SMALL_MODEL: 'gate-model',
    F2_GATE_TEST_HARNESS: '1', F2_GATE_FAKE_FETCH: '1',
    /* ⚠️ 门实例账号**没有** CREATEROLE ⇒ 门里用 `reuse-instance`（每单元仍独立子进程/文件根）。 */
    F2_GATE_NO_DB_PROVISION: '1',
    LG_F2_ADMIN_URL: String(process.env.LG_TEST_PG_URL ?? ''),
    F2_FILES_ROOT: resolve(out, `files-${runDir.replace(/[^a-zA-Z0-9]/g, '')}`),
    F2_RUN_DIR: resolve(out, runDir),
  })
  /** 并发启动两个单单元运行（同一封存、不同运行目录）⇒ 锁只放行一个。 */
  const concurrent = async (): Promise<{ first: { status: number | null, stdout: string }, second: { status: number | null, stdout: string } }> => {
    const { spawn } = await import('node:child_process')
    const sealDir = prepareSeal('concurrent')
    const runOne = (name: string) => new Promise<{ status: number | null, stdout: string }>((resolvePromise) => {
      const child = spawn(process.execPath,
        ['--import', './node_modules/tsx/dist/loader.mjs', 'scripts/cognitive/f2-live-runner.ts', '--unit', 'A-cf'],
        { env: { ...process.env, ...baseEnv(name, sealDir) }, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      child.stdout.on('data', chunk => { stdout += String(chunk) })
      child.on('close', code => resolvePromise({ status: code, stdout }))
    })
    const results = await Promise.all([runOne('run-concurrent-a'), runOne('run-concurrent-b')])
    return { first: results[0]!, second: results[1]! }
  }
  const scenarios: Record<string, () => { status: number | null, stdout: string, stderr: string }> = {
    /* 完整六单元（自己的封存） */
    complete: () => cli(['--run'], baseEnv('run-complete', prepareSeal('complete'))),
    /* 累计预算：只给 3 次请求 ⇒ 第一个单元就用尽 */
    budget: () => cli(['--run'], { ...baseEnv('run-budget', prepareSeal('budget')), F2_GATE_REQUESTS_CAP: '3' }),
    /* 崩溃：完成 2 题后模拟崩溃（不写 finished 的那一题留在 inFlight） */
    crash: () => cli(['--run'], { ...baseEnv('run-crash', prepareSeal('crash')), F2_GATE_CRASH_AFTER_TASKS: '2' }),
    /* 重跑：同一封存、**同一个**运行目录 ⇒ 必须拒绝 */
    rerun: () => cli(['--run'], baseEnv('run-complete', sealDirOf('complete'))),
    /* 重跑负控②：同一封存、**换一个**运行目录 ⇒ 也必须拒绝（锁在固定位置） */
    'rerun-other-dir': () => cli(['--run'], baseEnv('run-other', sealDirOf('complete'))),
    /* 单单元路径 */
    single: () => cli(['--unit', 'A-cf'], baseEnv('run-single', prepareSeal('single'))),
    /* 真实建库路径：门实例账号没有 CREATEROLE ⇒ 必须 fail-closed（**不**降级成复用） */
    provision: () => cli(['--run'], { ...baseEnv('run-provision', prepareSeal('provision')), F2_GATE_NO_DB_PROVISION: '' }),
    /* 清理失败负控：**首单元**清理被注入失败 ⇒ 立刻停止，不启动第二单元、不再发请求 */
    'cleanup-fail': () => cli(['--run'], { ...baseEnv('run-cleanup-fail', prepareSeal('cleanup-fail')), F2_GATE_FAIL_CLEANUP_UNIT: 'A-cf' }),
  }
  const scenario = String(process.env.LG_F2_SEQ_SCENARIO)
  const result = scenario === 'concurrent'
    ? { status: 0, stdout: JSON.stringify(await concurrent()), stderr: '' }
    : scenarios[scenario]!()
  writeFileSync(resolve(out, `cli-${scenario}.json`), JSON.stringify(result, null, 2) + '\n', 'utf8')
  process.exit(0)
}

// ===========================================================================
//  父进程：准备封存 + 编排 CLI 场景 + 断言
// ===========================================================================
const out = resolve('artifacts/local/f2-sequence', `run-${Date.now()}`)
mkdirSync(out, { recursive: true })
const checks: string[] = []
const check = (name: string, value: unknown, detail = ''): void => {
  if (!value) throw new Error(`${name}${detail === '' ? '' : ` — ${detail}`}`)
  checks.push(name)
  console.log(`PASS ${name}${detail === '' ? '' : ` — ${detail}`}`)
}
const adminUrl = (process.env.LG_F2_ADMIN_URL ?? process.env.LG_SIM_PGTEST_ADMIN_URL ?? '').trim()
const spawnScenario = async (scenario: string): Promise<void> => {
  process.env.LG_F2_SEQ_CHILD = '1'
  process.env.LG_F2_SEQ_SCENARIO = scenario
  process.env.LG_F2_SEQ_OUT = out
  if (adminUrl !== '') await runPreparedPgGateInInstance(adminUrl, `f2-seq-${scenario}`, SCRIPT)
  else await runPreparedPgGate(`f2-seq-${scenario}`, SCRIPT)
  delete process.env.LG_F2_SEQ_CHILD
  delete process.env.LG_F2_SEQ_SCENARIO
  delete process.env.LG_F2_SEQ_OUT
}

const { F2_REQUIRED_GATE_IDS, buildF2SealedManifest, collectF2SealBindings, F2_BUDGET_PROPOSAL } = await import('./f2-live-runner-guards.ts')
const readings = JSON.stringify(Object.fromEntries(F2_REQUIRED_GATE_IDS.map(id => [id, 'PASS'])))
process.env.LG_F2_SEQ_READINGS = readings

try {
  /* 每个场景在**自己的封存目录**里准备"已授权"封存（startMarker 不同 ⇒ 锁身份不同）。
     ⚠️ 锁现在固定在 <封存目录>/locks/<startMarker>.lock，不随运行目录变。 */
  const cliOf = (dir: string) => JSON.parse(readFileSync(resolve(out, dir), 'utf8').replace(/^\uFEFF/, '')) as {
    status: number | null, stdout: string, stderr: string
  }
  const seqOf = (dir: string, file = 'sequence-report.json') => JSON.parse(readFileSync(resolve(out, dir, file), 'utf8').replace(/^\uFEFF/, '')) as {
    status: string
    code?: string
    totals: { units: number, tasks: number, achieved: number, physicalRequests: number, tokens: number, expectedTasks: number, finishedTasks: number, inFlightTasks: number, notRunTasks: number }
    budget: { usedRequests: number }
    units: readonly {
      unit: string, provisionedDb: string, childExitCode: number | null
      report?: { db?: { name: string } }
      ledger: { readable: boolean, requests: number, inFlight: number }
      journal: { finished: number, inFlight: number }
      cleanup: { required: boolean, dbRemaining: number | null, roleRemaining: number | null, error?: string }
      tasks: { expected: number, finished: number, inFlight: readonly string[], notRun: readonly string[] }
    }[]
  }

  /* ② complete：六单元（reuse-instance，门实例账号无 CREATEROLE） */
  await spawnScenario('complete')
  const seqComplete = seqOf('run-complete')
  check('complete：序列 COMPLETE（六单元全部跑完）',
    seqComplete.status === 'COMPLETE' && seqComplete.totals.units === 6, `${seqComplete.status}/${String(seqComplete.totals.units)} 单元`)
  check('complete：**每单元一个独立子进程**（6 个 unit 报告 + 6 份 child 报告，全部 exit=0）',
    seqComplete.units.length === 6 && seqComplete.units.every(item => item.childExitCode === 0)
    && seqComplete.units.every(item => existsSync(resolve(out, 'run-complete', `child-${item.unit}.json`))),
    seqComplete.units.map(item => item.unit).join(','))
  check('complete：**库身份核对通过**（lg_test_ 前缀；门内 reuse-instance 模式，见边界）',
    seqComplete.units.every(item => (item.report?.db?.name ?? '').startsWith('lg_test_'))
    && seqComplete.units.every(item => (item.provisionedDb ?? '').startsWith('reused-instance')),
    seqComplete.units.map(item => `${item.unit}:${item.report?.db?.name ?? '?'}`).join(','))
  check('complete：物理请求 = **4 个模型单元 × 6**（B 两单元脚本⇒0；累计 **24**）',
    seqComplete.totals.physicalRequests === 24, String(seqComplete.totals.physicalRequests))
  check('complete：每单元请求账本可读、无在途、累计 = **24**（脚本臂 0 条）',
    seqComplete.units.every(item => item.ledger.readable && item.ledger.inFlight === 0)
    && seqComplete.budget.usedRequests === 24, `used=${String(seqComplete.budget.usedRequests)}`)
  check('complete：**账本即时落盘**后无"有 started 没 finished"的在途尝试',
    seqComplete.units.every(item => item.ledger.inFlight === 0 && item.ledger.requests === item.ledger.requests))
  check('complete：started.lock 在**固定锁目录**（<封存目录>/locks/<startMarker>.lock）',
    existsSync(resolve(out, 'seal-complete', 'locks')))
  check('complete：任务账本记录 6 单元 × 6 题（finished=36）且分母 = 36',
    (readFileSync(resolve(out, 'run-complete', 'tasks.jsonl'), 'utf8').match(/"kind":"task_finished"/g) ?? []).length === 36
    && seqComplete.totals.expectedTasks === 36 && seqComplete.totals.finishedTasks === 36)
  check('complete：reuse-instance 模式不要求清理（cleanup.required=false）',
    seqComplete.units.every(item => item.cleanup.required === false))

  /* ③ budget：累计预算以账本为准 */
  await spawnScenario('budget')
  const seqBudget = seqOf('run-budget')
  check('budget：首个单元用尽额度 ⇒ 序列 STOPPED（budget_requests）',
    seqBudget.status === 'STOPPED' && seqBudget.code === 'budget_requests', `${seqBudget.status}/${String(seqBudget.code)}`)
  check('budget：累计口径以账本为准（物理请求 ≤ 3，未超全局上限）；未运行题如实标注',
    seqBudget.totals.physicalRequests <= 3 && seqBudget.totals.expectedTasks === 36
    && seqBudget.totals.notRunTasks >= 30, `phys=${String(seqBudget.totals.physicalRequests)} notRun=${String(seqBudget.totals.notRunTasks)}`)

  /* ④ provision：真实"每单元建库"要求账号有 CREATEROLE/CREATEDB；门实例没有 ⇒ 必须 fail-closed */
  await spawnScenario('provision')
  const provisionRun = seqOf('run-provision')
  check('provision：账号无建库权限 ⇒ `db_prepare_failed`（**不**静默降级成复用实例）',
    provisionRun.status === 'STOPPED' && provisionRun.code === 'db_prepare_failed', `${provisionRun.status}/${String(provisionRun.code)}`)

  /* ⑤ crash：崩溃后账本留痕 + 父报告用任务账本恢复完整题行（分母不缩） */
  await spawnScenario('crash')
  const crashCli = cliOf('cli-crash.json')
  const seqCrash = seqOf('run-crash')
  const journalLines = existsSync(resolve(out, 'run-crash', 'tasks.jsonl'))
    ? readFileSync(resolve(out, 'run-crash', 'tasks.jsonl'), 'utf8') : ''
  const crashFinished = (journalLines.match(/"kind":"task_finished"/g) ?? []).length
  const crashStarted = (journalLines.match(/"kind":"task_started"/g) ?? []).length
  check('crash：子进程**非零退出**（模拟崩溃），任务账本保留已完成题',
    crashCli.status !== 0 && crashFinished === 2, `exit=${String(crashCli.status)} finished=${String(crashFinished)}`)
  check('crash：在途题被标出（started − finished = 1）',
    crashStarted - crashFinished === 1, `started=${String(crashStarted)} finished=${String(crashFinished)}`)
  check('crash：**父报告用任务账本恢复**崩溃前已完成题（单元报告缺失也算数）',
    seqCrash.units.length === 1 && seqCrash.units[0]?.report === undefined
    && seqCrash.units[0]?.tasks.finished === 2 && seqCrash.totals.finishedTasks === 2,
    `report=${String(seqCrash.units[0]?.report)} finished=${String(seqCrash.units[0]?.tasks.finished)}`)
  check('crash：正式测量**分母不缩**（36 题），并分别标注在途/未运行',
    seqCrash.totals.expectedTasks === 36 && seqCrash.totals.inFlightTasks === 1 && seqCrash.totals.notRunTasks === 33
    && seqCrash.units[0]?.tasks.inFlight.length === 1,
    `inFlight=${String(seqCrash.totals.inFlightTasks)} notRun=${String(seqCrash.totals.notRunTasks)}`)
  check('crash：序列标 STOPPED（崩溃不是"完成"）', seqCrash.status === 'STOPPED')

  /* ⑤b 清理失败负控：首单元清理失败 ⇒ 立刻停止（保留账本/题行；第二单元**没有启动**） */
  await spawnScenario('cleanup-fail')
  const seqCleanupFail = seqOf('run-cleanup-fail')
  const cleanupFailLedgerA = existsSync(resolve(out, 'run-cleanup-fail', 'ledger-A-cf.jsonl'))
  const cleanupFailLedgerNext = existsSync(resolve(out, 'run-cleanup-fail', 'ledger-A-af.jsonl'))
  const cleanupFailChildNext = existsSync(resolve(out, 'run-cleanup-fail', 'child-A-af.json'))
  check('cleanup-fail：序列 STOPPED（db_cleanup_failed），**只跑了首单元**',
    seqCleanupFail.status === 'STOPPED' && seqCleanupFail.code === 'db_cleanup_failed'
    && seqCleanupFail.units.length === 1 && seqCleanupFail.units[0]?.unit === 'A-cf',
    `${seqCleanupFail.status}/${String(seqCleanupFail.code)} units=${String(seqCleanupFail.units.length)}`)
  check('cleanup-fail：首单元账本与题行**保留**（可对账）',
    cleanupFailLedgerA && seqCleanupFail.units[0]?.ledger.readable === true
    && seqCleanupFail.units[0]?.tasks.finished === 6 && seqCleanupFail.totals.finishedTasks === 6,
    `ledger=${String(cleanupFailLedgerA)} finished=${String(seqCleanupFail.totals.finishedTasks)}`)
  check('cleanup-fail：清理失败被记录（dbRemaining=1、error=gate_simulated_cleanup_failure）',
    seqCleanupFail.units[0]?.cleanup.dbRemaining === 1
    && seqCleanupFail.units[0]?.cleanup.error === 'gate_simulated_cleanup_failure')
  check('cleanup-fail：**第二单元没有启动**（无 ledger-A-af / 无 child-A-af），物理请求停在首单元 6 次',
    !cleanupFailLedgerNext && !cleanupFailChildNext
    && seqCleanupFail.totals.physicalRequests === 6, `phys=${String(seqCleanupFail.totals.physicalRequests)}`)

  /* ⑥ rerun 负控①：同一封存、**同一运行目录** ⇒ 拒绝 */
  await spawnScenario('rerun')
  const rerunCli = cliOf('cli-rerun.json')
  const seqRerun = seqOf('run-complete', 'sequence-refused.json')
  check('rerun：同一封存 + 同一目录 ⇒ 拒绝重跑（already_started）',
    seqRerun.status === 'REFUSED' && seqRerun.code === 'already_started'
    && `${rerunCli.stdout}${rerunCli.stderr}`.includes('already_started'), `${seqRerun.status}/${String(seqRerun.code)}`)

  /* ⑥b rerun 负控②：同一封存、**换运行目录** ⇒ 仍拒绝（锁在固定位置） */
  await spawnScenario('rerun-other-dir')
  const rerunOther = seqOf('run-other', 'sequence-refused.json')
  check('rerun：同一封存 + **换一个运行目录** ⇒ 仍拒绝（锁按 startMarker 固定）',
    rerunOther.status === 'REFUSED' && rerunOther.code === 'already_started', `${rerunOther.status}/${String(rerunOther.code)}`)

  /* ⑥c 并发启动：同一封存两个进程同时起 ⇒ **只放行一次** */
  await spawnScenario('concurrent')
  const concurrent = cliOf('cli-concurrent.json')
  const pair = JSON.parse(concurrent.stdout) as { first: { status: number | null }, second: { status: number | null } }
  const codes = [pair.first.status, pair.second.status].sort()
  check('concurrent：同一封存**并发启动** ⇒ 恰好一个放行、一个 already_started',
    codes.length === 2 && codes[0] === 0 && codes[1] === 3, JSON.stringify(codes))

  /* ⑦ single：单单元路径 */
  await spawnScenario('single')
  const seqSingle = seqOf('run-single')
  check('single：`--unit A-cf` 单单元也走隔离库 + 账本（COMPLETE）',
    seqSingle.status === 'COMPLETE' && seqSingle.totals.units === 1
    && (seqSingle.units[0]?.report?.db?.name ?? '').startsWith('lg_test_') && seqSingle.units[0]?.ledger.readable === true,
    `${seqSingle.status}/${String(seqSingle.totals.units)}`)

  writeFileSync(resolve(out, 'verification.json'), JSON.stringify({
    status: 'PASS', schema: 'f2-sequence@1', measuredAt: new Date().toISOString(), checks,
    scenarios: ['complete', 'budget', 'crash', 'rerun', 'single'],
    budgetCaps: { requestsCap: F2_BUDGET_PROPOSAL.requestsCap, tokensCap: F2_BUDGET_PROPOSAL.tokensCapEstimate },
    boundary: [
      '本门零真实模型请求：CLI 子进程用**假 fetch**（F2_GATE_TEST_HARNESS + F2_GATE_FAKE_FETCH）',
      '六单元每单元一个独立子进程 + 独立 lg_test_ 库；累计预算以请求账本为准',
      '崩溃只验证"账本留痕 + 拒绝重跑"；恢复必须重新授权 + 重新封存',
      'gate_fake_fetch 只证明接线，**不构成**收益读数',
    ],
  }, null, 2))
  console.log(`F2 序列门：${String(checks.length)}/${String(checks.length)}；${out}`)
} catch (error) {
  writeFileSync(resolve(out, 'verification.json'), JSON.stringify({
    status: 'FAIL', schema: 'f2-sequence@1', measuredAt: new Date().toISOString(), checks,
    error: error instanceof Error ? error.message : String(error),
  }, null, 2))
  throw error
}
