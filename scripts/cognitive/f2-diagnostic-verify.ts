/**
 * **四题诊断执行门（零网络 · 假 fetch）**：验证执行入口**准确消费**冻结的 `diagnostic-4q.json`。
 *
 * ```text
 * ① 恰好四题（A-d41/A-d42/C-d41/C-d42），**没有**正式题目（obj-31…obj-36）；
 * ② 封存绑定的是**诊断材料摘要**与**诊断预算**（24 / 120,000），不是正式序列/正式预算；
 * ③ 请求前预留：每个物理请求在账本里都是 started 先于 finished；
 * ④ 无 usage ⇒ 立即停止；客户端 abort ⇒ 立即停止（诊断模式不用政策 A 继续）；
 * ⑤ 换封存**不重置**累计额度（accounting.jsonl 跨封存累计）。
 * ```
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const SCRIPT = 'scripts/cognitive/f2-diagnostic-verify.ts'
const material = JSON.parse(readFileSync('docs/architecture/f2-preregistration-20261025/diagnostic-4q.json', 'utf8')) as {
  id: string, digest: string, family: string, tasks: { unit: string, object: string }[], formation: unknown[],
  budget: { additionalPhysicalRequestsCap: number, cumulativeTokenStopThreshold: number, perTaskRequests: number },
}
const budgetBinding = { requestsCap: material.budget.additionalPhysicalRequestsCap, tokensCap: material.budget.cumulativeTokenStopThreshold, perTaskRequests: material.budget.perTaskRequests }
const out = resolve('artifacts/local/f2-diagnostic', `run-${Date.now()}`)
mkdirSync(out, { recursive: true })
const checks: string[] = []
const check = (name: string, value: unknown, detail = ''): void => {
  if (!value) throw new Error(`${name}${detail === '' ? '' : ` — ${detail}`}`)
  checks.push(name)
  console.log(`PASS ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

/* ⚠️ PG 门子进程模式：父进程用 runPreparedPgGate 准备一次性库并重启本脚本。 */
if (process.env.LG_F2_DIAG_GATE_CHILD !== '1') {
  process.env.LG_F2_DIAG_GATE_CHILD = '1'
  const { runPreparedPgGate } = await import('../postgresql/test-harness.ts')
  await runPreparedPgGate('f2-diagnostic-verify', SCRIPT)
  process.exit(0)
}

const readingsJson = JSON.parse(readFileSync('artifacts/cognitive/local/f2-executor-20261026/gate-readings.json', 'utf8')) as { readings: Record<string, string> }
const readings = JSON.stringify(readingsJson.readings ?? {})
const scenarioOut = (tag: string) => resolve(out, tag)
const cliEnv = (tag: string, extra: Record<string, string>) => ({
  ...process.env,
  F2_DIAGNOSTIC: '1', F2_EXECUTOR_DIR: out, F2_GATE_READINGS_JSON: readings,
  F2_SOURCE_FINGERPRINT: 'fp-diag-gate', F2_IMAGE_ID: 'sha256:diag-gate',
  OPENAI_BASE_URL: 'https://gate.invalid/v1', OPENAI_SMALL_MODEL: 'gate-model', OPENAI_API_KEY: 'gate-fake-key',
  F2_GATE_TEST_HARNESS: '1', F2_GATE_FAKE_FETCH: '1', F2_GATE_NO_DB_PROVISION: '1',
  LG_F2_ADMIN_URL: String(process.env.LG_TEST_PG_URL ?? ''),
  F2_FILES_ROOT: resolve(scenarioOut(tag), 'files'), F2_RUN_DIR: resolve(scenarioOut(tag), 'run'),
  ...extra,
})
const run = (tag: string, args: string[], extra: Record<string, string> = {}) => {
  mkdirSync(scenarioOut(tag), { recursive: true })
  const result = spawnSync(process.execPath, ['--import', './node_modules/tsx/dist/loader.mjs', 'scripts/cognitive/f2-live-runner.ts', ...args], { encoding: 'utf8', env: cliEnv(tag, extra), timeout: 900_000 })
  return { status: result.status, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') }
}
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

/** 每一步：新封存（干）→ 置为已授权 → 写授权 → 运行 → 删授权。 */
const authorizedRun = (tag: string, extra: Record<string, string>, sealName: string) => {
  rmSync(resolve(out, 'f2-seal.json'), { force: true })
  const sealed = run(tag, ['--seal'])
  if (sealed.status !== 0) throw new Error(`--seal 失败：${sealed.stderr.slice(-300)}`)
  const sealPath = resolve(out, 'f2-seal.json')
  const seal = JSON.parse(readFileSync(sealPath, 'utf8')) as { startMarker: string, bindings: { id: string, value: string }[] }
  writeFileSync(sealPath, JSON.stringify({ ...seal, status: 'SEALED_RUN_AUTHORIZED' }, null, 2))
  writeFileSync(resolve(out, 'f2-run-authorization.json'), JSON.stringify({ authorized: true, scope: 'diagnostic-4q' }))
  const executed = run(tag, ['--diagnostic-run', '--'], extra)
  rmSync(resolve(out, 'f2-run-authorization.json'), { force: true })
  return { seal, sealName, ...executed }
}
const reportOf = (path: string) => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) as {
  status: string, code?: string, totals: { units: number, finishedTasks: number, expectedTasks: number, physicalRequests: number, tokens: number, recoveredTasks: number, notRunTasks: number },
  budget: { requestsCap: number, tokensCap: number, usedRequests: number, usedTokens: number },
  units: { unit: string, tasks: { expected: number, finished: number, notRun: readonly string[] } }[],
}
const accountOf = () => {
  const path = resolve(out, 'accounting.jsonl')
  const entries = existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
  return { entries, requests: entries.reduce((s: number, e: { requests?: number }) => s + Number(e.requests ?? 0), 0), tokens: entries.reduce((s: number, e: { tokens?: number }) => s + Number(e.tokens ?? 0), 0) }
}

try {
  mkdirSync(resolve(out, 'files'), { recursive: true })
  /* ① 封存绑定诊断材料与诊断预算 */
  mkdirSync(resolve(out, 'normal', 'files'), { recursive: true })
  const first = authorizedRun('normal', {}, 'seal-1')
  const sealPath = resolve(out, 'f2-seal.json')
  const sealNow = JSON.parse(readFileSync(sealPath, 'utf8')) as { bindings: { id: string, value: string }[] }
  const bindingOf = (id: string) => sealNow.bindings.find(item => item.id === id)?.value ?? ''
  check('① 封存绑定**诊断材料摘要**（taskSequence == material.digest）',
    bindingOf('taskSequence') === material.digest, `${bindingOf('taskSequence').slice(0, 16)} vs ${material.digest.slice(0, 16)}`)
  check('① 封存绑定**诊断预算**（budgetCaps == sha256(24 / 120000 / 6)）',
    bindingOf('budgetCaps') === sha256(JSON.stringify(budgetBinding)))

  const report = reportOf(resolve(out, 'normal', 'run', 'sequence-report.json'))
  check('② 恰好**四题**（A-d41 / A-d42 / C-d41 / C-d42），且每单元只有 1 题',
    report.totals.units === 4 && report.totals.expectedTasks === 4 && report.totals.finishedTasks === 4
    && report.units.map(unit => unit.unit).join(',') === 'A-d41,A-d42,C-d41,C-d42'
    && report.units.every(unit => unit.tasks.expected === 1), JSON.stringify(report.units.map(unit => [unit.unit, unit.tasks.expected])))
  check('② **没有正式题目**（obj-31…obj-36 不出现）',
    !JSON.stringify(report).includes('obj-3'), JSON.stringify(report.totals))
  check('② 预算取诊断额度（requestsCap=24、tokensCap=120000）',
    report.budget.requestsCap === 24 && report.budget.tokensCap === 120000, JSON.stringify(report.budget))

  /* ③ 请求前预留：账本行顺序 started → finished */
  const ledgerFiles = report.units.map(unit => resolve(out, 'normal', 'run', `ledger-${unit.unit}.jsonl`))
  const reservationOk = ledgerFiles.every(file => {
    if (!existsSync(file)) return false
    const kinds = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => (JSON.parse(line) as { kind: string }).kind)
    for (let index = 0; index < kinds.length; index += 2) {
      if (kinds[index] !== 'attempt_started' || kinds[index + 1] !== 'attempt_finished') return false
    }
    return kinds.length > 0 && kinds.length % 2 === 0
  })
  check('③ 每个物理请求**先写 started 再写 finished**（**发出前记账**，不等于已预留 token；4 题 = 4 次物理请求）',
    reservationOk && report.totals.physicalRequests === 4, `physical=${String(report.totals.physicalRequests)}`)

  const afterFirst = accountOf()
  check('③ 账目落盘：accounting.jsonl 记录本次 4 请求', afterFirst.entries.length === 1 && afterFirst.requests === 4,
    JSON.stringify({ entries: afterFirst.entries.length, requests: afterFirst.requests }))

  /* ③b 发出前**预留**：余量 < prompt 上界 + 8000 ⇒ **fetch 不被调用**；足够时才放行 */
  {
    const { createF2Meter, F2_PROMPT_TOKEN_UPPER_BOUND } = await import('./f2-live-runner-guards.ts')
    const tight = createF2Meter({
      requestsCap: 24, tokensCap: F2_PROMPT_TOKEN_UPPER_BOUND + 8_000 - 1, perTaskRequests: 6,
      maxCompletionTokens: 8_000, reservationTokens: F2_PROMPT_TOKEN_UPPER_BOUND, now: () => 1,
    })
    const tightAdmission = tight.beforeRequest('probe')
    check('③b **余量不足**（< prompt 上界 + 8000）⇒ 拒绝且**零尝试**（fetch 不会被调用）',
      tightAdmission.ok === false && tightAdmission.code === 'budget_tokens' && tight.attempts.length === 0,
      JSON.stringify({ ok: tightAdmission.ok, code: (tightAdmission as { code?: string }).code, attempts: tight.attempts.length }))
    const loose = createF2Meter({
      requestsCap: 24, tokensCap: F2_PROMPT_TOKEN_UPPER_BOUND + 8_000, perTaskRequests: 6,
      maxCompletionTokens: 8_000, reservationTokens: F2_PROMPT_TOKEN_UPPER_BOUND, now: () => 1,
    })
    check('③b **额度足够** ⇒ 放行（预留后才允许发出）', loose.beforeRequest('probe').ok === true)
  }

  /* ④ 无 usage ⇒ 立即停止（**独立运行目录**，证明假 fetch 真被调用、无恢复、只发生首次尝试） */
  const usedBeforeNoUsage = accountOf().requests
  const noUsage = authorizedRun('no-usage', { F2_GATE_FAKE_USAGE: 'absent' }, 'seal-2')
  const reportNoUsage = reportOf(resolve(out, 'no-usage', 'run', 'sequence-report.json'))
  const noUsageLedger = resolve(out, 'no-usage', 'run', 'ledger-A-d41.jsonl')
  const noUsageAttempts = readFileSync(noUsageLedger, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { kind: string })
  const noUsageJournal = readFileSync(resolve(out, 'no-usage', 'run', 'tasks.jsonl'), 'utf8').trim().split('\n').filter(Boolean)
    .map(line => JSON.parse(line) as { kind: string })
  check('④ **无 usage ⇒ 立即停止**（cost_unverifiable、序列 STOPPED、只启动首个单元）',
    noUsage.status !== 0 && reportNoUsage.status === 'STOPPED' && reportNoUsage.code === 'cost_unverifiable'
    && reportNoUsage.totals.units === 1,
    `${reportNoUsage.status}/${String(reportNoUsage.code)} units=${String(reportNoUsage.totals.units)}`)
  check('④ **假 fetch 真被调用**（账本有 attempt_started + attempt_finished，且物理请求 ≥1）',
    noUsageAttempts[0]?.kind === 'attempt_started' && noUsageAttempts[1]?.kind === 'attempt_finished'
    && reportNoUsage.totals.physicalRequests === 1,
    `attempts=${String(noUsageAttempts.length)} physical=${String(reportNoUsage.totals.physicalRequests)}`)
  check('④ **没有恢复旧题**（recoveredTasks=0），只结束被尝试的那 1 题、后续 3 题未启动',
    reportNoUsage.totals.recoveredTasks === 0 && reportNoUsage.totals.finishedTasks === 1
    && reportNoUsage.totals.notRunTasks === 3
    && noUsageJournal.filter(entry => entry.kind === 'task_started').length === 1,
    JSON.stringify({ recovered: reportNoUsage.totals.recoveredTasks, finished: reportNoUsage.totals.finishedTasks, notRun: reportNoUsage.totals.notRunTasks, started: noUsageJournal.filter(entry => entry.kind === 'task_started').length }))

  /* ⑤ abort ⇒ 立即停止（诊断模式不使用政策 A 继续） */
  const abortRun = authorizedRun('abort', { F2_GATE_FAKE_ABORT: '1' }, 'seal-3')
  const reportAbort = reportOf(resolve(out, 'abort', 'run', 'sequence-report.json'))
  const abortLedger = resolve(out, 'abort', 'run', 'ledger-A-d41.jsonl')
  const abortAttempts = readFileSync(abortLedger, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { kind: string })
  check('⑤ **客户端 abort ⇒ 立即停止**（cost_unverifiable；诊断模式 maxBoundedAborts=0）',
    abortRun.status !== 0 && reportAbort.status === 'STOPPED' && reportAbort.code === 'cost_unverifiable'
    && reportAbort.totals.units === 1 && reportAbort.totals.recoveredTasks === 0,
    `${reportAbort.status}/${String(reportAbort.code)} units=${String(reportAbort.totals.units)}`)
  const abortUnit = JSON.parse(readFileSync(resolve(out, 'abort', 'run', 'unit-A-d41.json'), 'utf8')) as {
    totals: { physicalRequests: number, boundedAbortEvents: number }
  }
  check('⑤ abort 发生在**发出前记账之后**：账本 started+finished(bounded)、单元报告**无成功物理请求**',
    abortAttempts[0]?.kind === 'attempt_started' && abortAttempts.length === 2
    && abortUnit.totals.physicalRequests === 0 && abortUnit.totals.boundedAbortEvents === 1,
    `attempts=${String(abortAttempts.length)} physical=${String(abortUnit.totals.physicalRequests)} bounded=${String(abortUnit.totals.boundedAbortEvents)}`)

  /* ⑥ 换封存不重置累计额度（共享预算账户、**各自运行目录**；且不重复计旧账） */
  const beforeCumulative = accountOf()
  const cumulative = authorizedRun('cumulative', {}, 'seal-4')
  const reportCumulative = reportOf(resolve(out, 'cumulative', 'run', 'sequence-report.json'))
  const afterCumulative = accountOf()
  check('⑥ **换封存仍扣除已用额度**（本次 requestsCap = 24 − 已用）',
    reportCumulative.budget.requestsCap === 24 - beforeCumulative.requests,
    `cap=${String(reportCumulative.budget.requestsCap)} usedBefore=${String(beforeCumulative.requests)}`)
  check('⑥ **不重复计旧账**：累计 = 各次运行之和（accounting 条目数与请求数一致）',
    afterCumulative.entries.length === beforeCumulative.entries.length + 1
    && afterCumulative.requests === beforeCumulative.requests + reportCumulative.totals.physicalRequests,
    JSON.stringify({ entries: afterCumulative.entries.length, requests: afterCumulative.requests, before: beforeCumulative.requests, thisRun: reportCumulative.totals.physicalRequests }))
  check('⑥ 累计额度用尽后**拒绝**下一次运行（diagnostic_budget_exhausted，零请求）', (() => {
    const path = resolve(out, 'accounting.jsonl')
    writeFileSync(path, readFileSync(path, 'utf8') + JSON.stringify({ at: new Date().toISOString(), startMarker: 'test-fill', units: 0, requests: 24, tokens: 0, status: 'TEST' }) + '\n')
    const refused = authorizedRun('exhausted', {}, 'seal-5')
    return refused.status !== 0 && /diagnostic_budget_exhausted/.test(`${refused.stderr}${refused.stdout}`)
  })())

  writeFileSync(resolve(out, 'verification.json'), JSON.stringify({
    status: 'PASS', schema: 'f2-diagnostic-verify@1', measuredAt: new Date().toISOString(), checks,
    material: { id: material.id, digest: material.digest, units: material.tasks.map(task => task.unit), budget: budgetBinding },
    account: afterCumulative,
    boundary: ['零真实模型请求（假 fetch）', '诊断模式独立执行器目录/封存/账目；不与正式序列混用', '诊断停止规则：无 usage 或 abort 即停；累计额度不清零'],
  }, null, 2) + '\n', 'utf8')
  console.log(`F2 四题诊断执行门：${String(checks.length)}/${String(checks.length)}；${out}`)
} catch (error) {
  writeFileSync(resolve(out, 'verification.json'), JSON.stringify({ status: 'FAIL', schema: 'f2-diagnostic-verify@1', measuredAt: new Date().toISOString(), checks, error: error instanceof Error ? error.message : String(error) }, null, 2) + '\n', 'utf8')
  throw error
}
