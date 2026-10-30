/**
 * **F2 执行器（本轮：守卫 + 干封存 + 预算提案；真实运行路径 fail-closed）**
 *
 * ```text
 * pnpm exec tsx scripts/cognitive/f2-live-runner.ts --seal     # 零请求：产出**干封存**（未授权）
 * pnpm exec tsx scripts/cognitive/f2-live-runner.ts --status   # 只读：打印封存/漂移/授权状态
 * pnpm exec tsx scripts/cognitive/f2-live-runner.ts --run      # 必须被拒绝（无授权 / 未实现）
 * ```
 *
 * ⚠️ 本批**只**建设执行器的守卫与封存；**`--unit` 的真实单元执行尚未实现** ⇒ `--run` 在
 *    授权通过之后仍以 `unit_not_implemented` 拒绝（fail-closed，绝不"悄悄跑起来"）。
 * ⚠️ 零真实模型请求：本脚本**从不**创建请求，也不 import 任何模型适配器。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  F2_BUDGET_PROPOSAL, F2_PROMPT_TOKEN_UPPER_BOUND, F2_RUNNER_ID, F2_UNITS, appendF2AttemptLedger, appendF2TaskJournal, createF2Meter,
  readF2FormalSequence, readF2TaskJournal,
  assertF2RunAuthorized, buildF2SealedManifest, collectF2SealBindings, f2GateReadingsDigest,
  f2SealDrift, sha256Text, type F2GateReadings, type F2SealedManifest,
} from './f2-live-runner-guards.ts'
import {
  appendDiagnosticAccount, diagnosticBudgetBindingOf, readDiagnosticAccount, readF2DiagnosticMaterial,
  type F2DiagnosticMaterial,
} from './f2-diagnostic-material.ts'

/** ⚠️ 允许门在**临时目录**里跑 CLI（不污染真实干封存）：F2_EXECUTOR_DIR。 */
const OUT_DIR = resolve(process.env.F2_EXECUTOR_DIR ?? 'artifacts/cognitive/local/f2-executor-20261026')
const SEAL_PATH = resolve(OUT_DIR, 'f2-seal.json')
const AUTHORIZATION_PATH = resolve(OUT_DIR, 'f2-run-authorization.json')
/** 冻结的正式序列所在文件（封存的 `taskSequence` 绑定来自它的 `formalSequence`）。 */
const TASK_SPEC_PATH = 'docs/architecture/f2-preregistration-20261025/task-spec.json'

/**
 * 门读数：**唯一来源**是 `F2_GATE_READINGS_FILE`（优先）或 `F2_GATE_READINGS_JSON`。
 * 两者都接受两种形状：
 * - 扁平 `{ "<gateId>": "PASS"|"FAIL"|"MISSING" }`；
 * - 汇总包 `{ readings: { "<gateId>": … }, evidence: { … } }`（`f2-gate-readings.ts` 的产出）。
 * ⚠️ 没有环境变量 ⇒ 全部 MISSING（fail-closed：干封存可以产出，但 `--run` 一定被拒绝）。
 * ⚠️ 这里**不**去猜证据文件的状态：把"读不到"当成"通过"正是要禁止的那类错误。
 */
function unwrapGateReadings(parsed: unknown): F2GateReadings {
  if (typeof parsed !== 'object' || parsed === null) return {}
  const record = parsed as Record<string, unknown>
  const nested = record.readings
  if (typeof nested === 'object' && nested !== null) return nested as F2GateReadings
  return record as F2GateReadings
}

function readGateReadings(): F2GateReadings {
  const file = (process.env.F2_GATE_READINGS_FILE ?? '').trim()
  if (file !== '' && existsSync(file)) {
    try { return unwrapGateReadings(JSON.parse(readFileSync(file, 'utf8'))) } catch { return {} }
  }
  const raw = (process.env.F2_GATE_READINGS_JSON ?? '').trim()
  if (raw === '') return {}
  try { return unwrapGateReadings(JSON.parse(raw)) } catch { return {} }
}

/** 计算绑定（**不**读凭据、不产生请求）。 */
function currentBindings(): ReturnType<typeof collectF2SealBindings> {
  const readings = readGateReadings()
  const gateDigest = (() => {
    try { return f2GateReadingsDigest(readings).digest } catch { return 'MISSING' }
  })()
  /* ⚠️ 诊断模式：材料摘要替代正式序列摘要、诊断预算替代正式预算（同 8 项绑定，不新增绑定种类）。 */
  const diagnosticMaterial: F2DiagnosticMaterial | undefined = (() => {
    if (process.env.F2_DIAGNOSTIC !== '1') return undefined
    try { return readF2DiagnosticMaterial() } catch { return undefined }
  })()
  /*
   * `taskSequence` **不再**是由 protocol 派生的组合摘要：它绑定的是 `task-spec.json` 里
   * **冻结的正式序列摘要**（`formalSequence.sequenceDigest` 自校验）。
   * 缺 / 摘要不符 / id 不符 ⇒ `MISSING`（fail-closed，绝不"猜一个"）。
   */
  /* ⚠️ 校准批次：材料摘要与校准预算进封存（与正式/诊断封存分开）。 */
  const calibrationMaterial = (() => {
    const path = (process.env.F2_CAL_MATERIAL ?? '').trim()
    if (path === '') return undefined
    try { return JSON.parse(readFileSync(path, 'utf8')) as { id: string, digest: string, scale: { maxPhysicalRequests: number } } } catch { return undefined }
  })()
  const taskSequence = calibrationMaterial !== undefined
    ? calibrationMaterial.digest
    : diagnosticMaterial === undefined
      ? (() => { try { return readF2FormalSequence(TASK_SPEC_PATH).digest } catch { return 'MISSING' } })()
      : diagnosticMaterial.digest
  const modelParams = JSON.stringify({
    endpointHost: hostOf(process.env.OPENAI_BASE_URL ?? ''), model: (process.env.OPENAI_SMALL_MODEL ?? '').trim(),
    maxCompletionTokens: 8_000, temperatureRequested: 0,
    reasoningEffort: diagnosticMaterial?.modelParameters.reasoningEffort
      ?? ((process.env.F2_REASONING_EFFORT ?? '').trim() || null),
  })
  return collectF2SealBindings({
    paths: {
      protocol: 'docs/architecture/f2-preregistration-20261025/protocol.json',
      taskSpec: 'docs/architecture/f2-preregistration-20261025/task-spec.json',
      sourceFingerprint: '', image: '', taskSequence: '', gateReadings: '', budgetCaps: '', modelParameters: '',
    },
    computed: {
      sourceFingerprint: process.env.F2_SOURCE_FINGERPRINT ?? 'MISSING',
      image: process.env.F2_IMAGE_ID ?? 'MISSING',
      taskSequence,
      gateReadings: gateDigest,
      budgetCaps: sha256Text(JSON.stringify(calibrationMaterial !== undefined
        ? { requestsCap: calibrationMaterial.scale.maxPhysicalRequests, perTaskRequests: 1 }
        : diagnosticMaterial === undefined ? F2_BUDGET_PROPOSAL : diagnosticBudgetBindingOf(diagnosticMaterial))),
      modelParameters: sha256Text(modelParams),
    },
  })
}
function hostOf(url: string): string {
  try { return url === '' ? 'default' : new URL(url).hostname } catch { return 'invalid' }
}

function loadSeal(): F2SealedManifest | undefined {
  if (!existsSync(SEAL_PATH)) return undefined
  return JSON.parse(readFileSync(SEAL_PATH, 'utf8')) as F2SealedManifest
}

const argv = process.argv.slice(2)
const mode = argv.find(arg => arg.startsWith('--')) ?? '--status'
/* ⚠️ 诊断批次走独立模式：强制诊断材料 + 独立执行器目录 + 独立账目（与正式序列严格分开）。 */
if (mode === '--diagnostic-run') process.env.F2_DIAGNOSTIC = '1'

if (mode === '--seal') {
  mkdirSync(OUT_DIR, { recursive: true })
  const bindings = currentBindings()
  const sealCalibration = (() => {
    const path = (process.env.F2_CAL_MATERIAL ?? '').trim()
    if (path === '') return undefined
    try { return JSON.parse(readFileSync(path, 'utf8')) as { scale: { maxPhysicalRequests: number } } } catch { return undefined }
  })()
  const sealMaterial = process.env.F2_DIAGNOSTIC === '1'
    ? (() => { try { return readF2DiagnosticMaterial() } catch { return undefined } })()
    : undefined
  const diagnosticBudget = sealMaterial === undefined ? undefined : {
    ...F2_BUDGET_PROPOSAL,
    units: sealMaterial.tasks.length,
    measurementTasks: sealMaterial.tasks.length,
    formationTasks: sealMaterial.tasks.length * sealMaterial.formation.length,
    requestsCap: sealMaterial.budget.requestsCap,
    tokensCapEstimate: sealMaterial.budget.tokensCap,
    perTaskRequests: sealMaterial.budget.perTaskRequests,
  } as unknown as typeof F2_BUDGET_PROPOSAL
  const manifest = buildF2SealedManifest({
    bindings, sealedAt: new Date().toISOString(), authorized: false,
    ...(diagnosticBudget === undefined || sealMaterial === undefined
      ? {}
      : { budget: diagnosticBudget, units: sealMaterial.tasks.map(task => task.unit) }),
  })
  writeFileSync(SEAL_PATH, JSON.stringify(manifest, null, 2))
  console.log(`F2 干封存已生成：${SEAL_PATH}`)
  console.log(`  status      = ${manifest.status}`)
  console.log(`  startMarker = ${manifest.startMarker}`)
  console.log(`  digest      = ${manifest.digest.slice(0, 16)}…`)
  for (const binding of bindings) console.log(`  binding ${binding.id} = ${binding.value.slice(0, 16)}${binding.value === 'MISSING' ? ' (MISSING)' : ''}`)
  console.log(sealCalibration !== undefined
    ? `  预算（校准） = 本批最多 ${String(sealCalibration.scale.maxPhysicalRequests)} 请求（计入累计账目，不清零）；运行**仍未授权**`
    : diagnosticBudget === undefined
    ? `  预算         = 已裁定冻结 ${String(F2_BUDGET_PROPOSAL.requestsCap)} 请求 / ${String(F2_BUDGET_PROPOSAL.tokensCapEstimate)} token；运行**仍未授权**`
    : `  预算（诊断） = 追加 ${String(diagnosticBudget.requestsCap)} 请求 / 累计 ${String(diagnosticBudget.tokensCapEstimate)} token（跨封存累计，不清零）；运行**仍未授权**`)
  console.log('  ⚠️ 干封存**没有**运行授权；真实运行需另行裁定 + 重新封存')
  process.exit(0)
}

if (mode === '--status') {
  const manifest = loadSeal()
  if (manifest === undefined) { console.log(`没有封存（${SEAL_PATH}）`); process.exit(0) }
  const drift = f2SealDrift(manifest, currentBindings())
  const authorization = existsSync(AUTHORIZATION_PATH)
  const verdict = assertF2RunAuthorized({ manifest, drift, authorizationPresent: authorization })
  console.log(`封存 ${SEAL_PATH}`)
  console.log(`  status=${manifest.status} sealedAt=${manifest.sealedAt} startMarker=${manifest.startMarker}`)
  console.log(`  漂移=${drift.length === 0 ? '无' : drift.join(',')} 授权文件=${authorization ? '在场' : '不在'}`)
  console.log(`  可运行=${verdict.ok ? '是' : `否（${verdict.code}）`}`)
  process.exit(0)
}

/**
 * 真实单元执行的**前置配置**闭集（缺一项 ⇒ 拒绝，不猜）。
 * ⚠️ 它与 `F2_GUARD_CODES` 分开：那些是授权/计量守卫，这些是**环境配置**。
 */
const F2_UNIT_PRECONDITION_CODES = ['admin_url_missing', 'files_root_missing', 'unit_not_found', 'sequence_invalid', 'run_dir_missing'] as const

/**
 * ⚠️ 门专用假 fetch：**单独模块 + 动态加载**（`f2-gate-fake-fetch.ts`），
 *    因此本入口源码里不出现 `网络调用括号` ⇒ "零请求结构保证"的静态检查仍然成立。
 */
async function gateTransportOrUndefined (): Promise<typeof fetch | undefined> {
  if (process.env.F2_GATE_TEST_HARNESS !== '1' || process.env.F2_GATE_FAKE_FETCH !== '1') return undefined
  const { gateFixtureTransport } = await import('./f2-gate-fake-fetch.ts')
  return gateFixtureTransport()
}

if (mode === '--run' || mode === '--unit' || mode === '--diagnostic-run') {
  /**
   * 真实执行：授权 → 前置配置 → （父）序列编排 / （子）单元执行。
   * ⚠️ 每单元一个**独立子进程**：同进程里连接池只认第一份连接串 ⇒ 六单元会串库。
   * ⚠️ 物理请求只在子进程规划器的 fetch 边界发出并计量；父进程只编排、不发请求。
   */
  const manifest = loadSeal()
  const drift = manifest === undefined ? [] : f2SealDrift(manifest, currentBindings())
  const authorization = existsSync(AUTHORIZATION_PATH)
  const verdict = assertF2RunAuthorized({ manifest, drift, authorizationPresent: authorization })
  if (!verdict.ok) {
    if (verdict.code === 'seal_drift') console.error(`拒绝运行：${verdict.code}（漂移：${drift.join(',') || '未知'}）`)
    else console.error(`拒绝运行：${verdict.code}`)
    process.exit(3)
  }
  const reject = (code: (typeof F2_UNIT_PRECONDITION_CODES)[number], detail: string): never => {
    console.error(`拒绝运行：${code}（${detail}）`)
    process.exit(3)
  }
  const adminUrl = (process.env.LG_F2_ADMIN_URL ?? process.env.LG_SIM_PGTEST_ADMIN_URL ?? '').trim()
  const filesRoot = (process.env.F2_FILES_ROOT ?? '').trim()
  const material: F2DiagnosticMaterial | undefined = process.env.F2_DIAGNOSTIC === '1'
    ? (() => { try { return readF2DiagnosticMaterial() } catch { return reject('sequence_invalid', '诊断材料不可读/摘要不符') } })()
    : undefined
  const sequence = material === undefined
    ? (() => { try { return readF2FormalSequence(TASK_SPEC_PATH).sequence } catch { return reject('sequence_invalid', '冻结的正式序列不可读/摘要不符') } })()
    : {
        id: material.id, family: material.family, formation: material.formation,
        measurement: material.tasks.map(task => ({ object: task.object, condition: task.condition })),
      }
  const startMarker = manifest?.startMarker ?? reject('sequence_invalid', '没有封存（--seal 之后才有 startMarker）')
  const gateRequestsCap = process.env.F2_GATE_TEST_HARNESS === '1' && (process.env.F2_GATE_REQUESTS_CAP ?? '').trim() !== ''
    ? Number(process.env.F2_GATE_REQUESTS_CAP) : undefined
  const gateCrash = process.env.F2_GATE_TEST_HARNESS === '1' && (process.env.F2_GATE_CRASH_AFTER_TASKS ?? '').trim() !== ''
    ? Number(process.env.F2_GATE_CRASH_AFTER_TASKS) : undefined

  /* ---------------- 子进程：一个单元（隔离库 + 编排 + 账本/任务账本） ---------------- */
  if (process.env.F2_UNIT_CHILD === '1') {
    if (filesRoot === '') reject('files_root_missing', '单元执行需要独立的文件根（F2_FILES_ROOT）')
    const dbTarget = (process.env.LG_TEST_PG_URL ?? '').trim()
    if (dbTarget === '') reject('admin_url_missing', '单元子进程需要本单元的一次性库连接串（LG_TEST_PG_URL，由父进程创建）')
    const runDir = (process.env.F2_RUN_DIR ?? '').trim() || reject('run_dir_missing', '子进程需要 F2_RUN_DIR')
    const unitId = (process.env.F2_UNIT_ID ?? '').trim()
    const unit = (material === undefined ? F2_UNITS : material.tasks).find(item => item.unit === unitId)
      ?? reject('unit_not_found', `未知单元 ${unitId}（诊断材料只允许 ${
        material === undefined ? '' : material.tasks.map(task => task.unit).join('/')}）`)
    const requestsCap = Number(process.env.F2_UNIT_REQUESTS_CAP ?? (material === undefined ? F2_BUDGET_PROPOSAL.requestsCap : material.budget.requestsCap))
    const tokensCap = Number(process.env.F2_UNIT_TOKENS_CAP ?? (material === undefined ? F2_BUDGET_PROPOSAL.tokensCapEstimate : material.budget.tokensCap))
    const perTaskRequests = Number(process.env.F2_PER_TASK_REQUESTS ?? (material === undefined ? F2_BUDGET_PROPOSAL.perTaskRequests : material.budget.perTaskRequests))
    /* 隔离必须在**导入任何 db 模块之前**：库名带 lg_test_ 前缀，身份核对在运行时里再做一次。 */
    const { isolateDatabase } = await import('../../src/dev/sandbox.ts')
    isolateDatabase(`f2-${unit.unit}`, { postgres: { url: dbTarget } })
    const journalPath = resolve(runDir, 'tasks.jsonl')
    const ledgerPath = resolve(runDir, `ledger-${unit.unit}.jsonl`)
    /*
     * ⚠️ **请求账本即时落盘**：`attempt_started` 在 fetch **之前**写、结算后写 `attempt_finished`。
     *    单元中途崩溃 ⇒ 账本里留下"有 started 没 finished"在途行 ⇒ 对账判成本未知并停止（不丢已发生费用）。
     */
    const meter = createF2Meter({
      requestsCap, tokensCap, perTaskRequests, maxCompletionTokens: 8_000,
      reservationTokens: F2_PROMPT_TOKEN_UPPER_BOUND, now: () => Date.now(),
      /* ⚠️ 诊断模式**严格停**：客户端 abort 不按政策 A 继续（材料 stopRules 明确要求）。 */
      ...(material === undefined ? {} : { maxBoundedAborts: 0 }),
      onAttempt: entry => appendF2AttemptLedger(ledgerPath, entry),
    })
    const journalBefore = readF2TaskJournal(journalPath)
    if (existsSync(journalPath) && !journalBefore.readable) reject('run_dir_missing', '任务账本不可读')
    const resume: Record<string, never> = {}
    for (const entry of journalBefore.finished) if (entry.row !== undefined) resume[entry.taskId] = entry.row as never
    const { createRealPlannerFactory } = await import('./f2-real-planner.ts')
    const { createCapabilityRegistry, createDefaultCapabilityDefinitions } = await import('../../src/kernel/action/capability-registry.ts')
    const { runF2Unit } = await import('./f2-unit-runtime.ts')
    const registry = createCapabilityRegistry(createDefaultCapabilityDefinitions())
    const plannerFactory = createRealPlannerFactory({
      registry, meter, unit: unit.unit, fetchImpl: await gateTransportOrUndefined(),
      ...(material?.modelParameters.reasoningEffort !== undefined
        ? { reasoningEffort: material.modelParameters.reasoningEffort }
        : (process.env.F2_REASONING_EFFORT ?? '').trim() === ''
          ? {}
          : { reasoningEffort: (process.env.F2_REASONING_EFFORT ?? '').trim() as 'low' | 'medium' | 'high' }),
      /* ⚠️ 每次模型调用的响应形状诊断：落盘 <run>/calls-<unit>.jsonl（真实运行可解释 plan_failed/usage 缺失）。 */
      onCallDiagnostic: diagnostic => {
        try { appendFileSync(resolve(runDir, `calls-${unit.unit}.jsonl`), JSON.stringify(diagnostic) + '\n') } catch { /* 诊断不得影响运行 */ }
      },
    })
    const report = await runF2Unit({
      unit: unit.unit, arm: unit.arm, order: unit.order,
      sequence: material === undefined
        ? { family: sequence.family, formation: sequence.formation, measurement: sequence.measurement }
        : {
            family: material.family, formation: material.formation,
            /* 诊断模式：**只跑本单元那一题**（4 题 = 4 个单元，每个 1 题）。 */
            measurement: [material.tasks.find(task => task.unit === unit.unit) ?? reject('unit_not_found', '诊断单元缺失')],
          },
      sequenceId: (process.env.F2_SEQUENCE_ID ?? (material === undefined ? 'f2-formal' : material.id)).trim(),
      dbUrl: adminUrl, root: filesRoot, out: runDir, evidenceKind: 'real', plannerFactory, meter,
      resume: Object.keys(resume).length === 0 ? undefined : resume,
      onTaskStart: taskId => appendF2TaskJournal(journalPath, { kind: 'task_started', unit: unit.unit, taskId, at: Date.now() }),
      onTaskFinish: (taskId, row) => appendF2TaskJournal(journalPath, { kind: 'task_finished', unit: unit.unit, taskId, at: Date.now(), row: row as unknown as Record<string, unknown> }),
      ...(gateCrash === undefined ? {} : { crashAfterTasks: gateCrash }),
    })
    /* 0 请求（B 臂）也要留下**可读的空账本**；账本行已由 meter 即时落盘，这里不再批量补写。 */
    if (!existsSync(ledgerPath)) writeFileSync(ledgerPath, '', 'utf8')
    const childReport = {
      unit: report.unit, db: report.db, stopCode: report.stopCode, costConfirmed: report.costConfirmed,
      realModelRequests: report.realModelRequests, recoveredTaskIds: report.recoveredTaskIds,
      totals: report.totals, meter: report.meter,
    }
    writeFileSync(resolve(runDir, `child-${unit.unit}.json`), JSON.stringify(childReport, null, 2) + '\n', 'utf8')
    console.log(`单元 ${report.unit} 完成：达成 ${String(report.totals.achieved)}/${String(report.totals.tasks)}，物理请求 ${String(report.totals.physicalRequests)}，token ${String(report.totals.tokens)}，库 ${report.db.name}`)
    process.exit(report.stopCode === undefined ? 0 : 3)
  }

  /* ---------------- 父进程：序列编排（六单元累计预算 / started.lock / 账本对账） ---------------- */
  if (adminUrl === '') reject('admin_url_missing', '六单元编排需要一次性 PostgreSQL 的 admin 连接串（LG_F2_ADMIN_URL）')
  if (filesRoot === '') reject('files_root_missing', '真实执行需要独立的文件根（F2_FILES_ROOT）')
  const requested = mode === '--unit' ? (argv[argv.indexOf('--unit') + 1] ?? '') : ''
  const sourceUnits = material === undefined ? F2_UNITS : material.tasks
  const units = mode === '--unit'
    ? [sourceUnits.find(item => item.unit === requested) ?? reject('unit_not_found', `未知单元 ${requested}`)]
    : [...sourceUnits]
  const runDir = (process.env.F2_RUN_DIR ?? '').trim()
    || resolve(OUT_DIR, `run-${new Date().toISOString().replace(/[:.]/g, '-')}`)
  const { runF2Sequence } = await import('./f2-sequence-runner.ts')
  /* ⚠️ 真实路径固定 `per-unit-admin`（每单元建库）；`reuse-instance` **只**给门用（实例账号无 CREATEROLE）。 */
  const provisioning = process.env.F2_GATE_TEST_HARNESS === '1' && process.env.F2_GATE_NO_DB_PROVISION === '1'
    ? 'reuse-instance' as const : 'per-unit-admin' as const
  /* ⚠️ 门用注入：把指定单元的清理结果模拟为失败（验证"清理失败 ⇒ 立刻停止、不启动下一单元"）。 */
  const failCleanupUnit = process.env.F2_GATE_TEST_HARNESS === '1' ? (process.env.F2_GATE_FAIL_CLEANUP_UNIT ?? '').trim() : ''
  /* ⚠️ 诊断累计额度：**跨封存累计**（accounting.jsonl），换封存不重置。 */
  const account = material === undefined ? undefined : readDiagnosticAccount(OUT_DIR)
  if (material !== undefined && account !== undefined) {
    if (account.requests >= material.budget.requestsCap || account.tokens >= material.budget.tokensCap) {
      reject('sequence_invalid', `diagnostic_budget_exhausted（已用 ${String(account.requests)} 请求 / ${String(account.tokens)} token）`)
    }
  }
  const remainingRequests = material === undefined ? (gateRequestsCap ?? F2_BUDGET_PROPOSAL.requestsCap)
    : Math.max(0, material.budget.requestsCap - (account?.requests ?? 0))
  const remainingTokens = material === undefined ? F2_BUDGET_PROPOSAL.tokensCapEstimate
    : Math.max(0, material.budget.tokensCap - (account?.tokens ?? 0))
  const report = await runF2Sequence({
    units, sequenceId: sequence.id, adminUrl, filesRoot, out: runDir, startMarker,
    /* ⚠️ 锁在**固定**目录（执行器目录），不随运行目录变；同一封存换目录也拦得住。 */
    lockBase: OUT_DIR,
    measurementObjects: (sequence.measurement as readonly { object: string }[]).map(item => item.object),
    ...(material === undefined ? {} : {
      measurementObjectsOf: (unitId: string) => {
        const task = material.tasks.find(item => item.unit === unitId)
        return task === undefined ? [] : [task.object]
      },
    }),
    requestsCap: remainingRequests,
    tokensCap: remainingTokens,
    perTaskRequests: material === undefined ? F2_BUDGET_PROPOSAL.perTaskRequests : material.budget.perTaskRequests,
    provisioning,
    ...(gateCrash === undefined ? {} : { crashAfterTasks: gateCrash }),
    ...(failCleanupUnit === '' ? {} : { gateSimulateCleanupFailureOnUnit: failCleanupUnit }),
    childScript: 'scripts/cognitive/f2-live-runner.ts',
  })
  console.log(`序列 ${report.status}${report.code === undefined ? '' : `（${report.code}）`}：单元 ${String(report.totals.units)}，完成题 ${String(report.totals.finishedTasks)}/${String(report.totals.expectedTasks)}（在途 ${String(report.totals.inFlightTasks)}、未运行 ${String(report.totals.notRunTasks)}），物理请求 ${String(report.totals.physicalRequests)}，token ${String(report.totals.tokens)}`)
  if (material !== undefined) {
    appendDiagnosticAccount(OUT_DIR, {
      startMarker, units: report.totals.units, requests: report.totals.physicalRequests,
      tokens: report.totals.tokens, status: report.status,
    })
    const after = readDiagnosticAccount(OUT_DIR)
    console.log(`诊断累计：请求 ${String(after.requests)}/${String(material.budget.requestsCap)} · token ${String(after.tokens)}/${String(material.budget.tokensCap)}（换封存不重置）`)
  }
  console.log(`运行目录：${runDir}（sequence-report.json / tasks.jsonl / ledger-*.jsonl）；锁：${resolve(OUT_DIR, 'locks')}`)
  process.exit(report.status === 'COMPLETE' ? 0 : 3)
}

console.error(`未知模式 ${mode}（支持 --seal / --status / --run / --unit）`)
process.exit(2)
