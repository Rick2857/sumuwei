/**
 * **F2 执行器守卫门**（纯函数 + CLI 子进程；**零数据库、零模型请求、零真实运行**）。
 *
 * 证明：
 * ```text
 * ① 封存绑定 8 项闭集、缺文件 = MISSING、digest 稳定且敏感
 * ② 门读数：缺一项 / 有一项 FAIL ⇒ **拒绝封存**（fail-closed）
 * ③ 漂移：任一绑定变 / 数量不符 ⇒ 逐项列出
 * ④ 授权：无封存 / 漂移 / 干封存 / 无授权文件 ⇒ 全部拒绝（闭集码）
 * ⑤ 记账：逐题 6 次上限、总量/token 上限、**usage 缺失 ⇒ 成本不可确认 ⇒ 立即停**
 * ⑥ 账本：append-only 追加/读回；不存在/损坏 ⇒ readable=false（不当成"没有"）
 * ⑦ 任务账本：已完成题可取回、在途题被标出；损坏/缺失 ⇒ readable=false
 * ⑧ 单元对账：缺账本 / 未确认成本 / 账本与报告不一致 ⇒ 成本不能确认
 * ⑨ 二次运行 ⇒ already_started
 * ⑩ 预算：6 单元 × 6 题 × 6 次 = 216 硬上限、期望 24（=物理 fetch 读数合计：A/C 各 6、B 各 0）、
 *    **预算已由用户裁定（approved=true）但运行仍需授权**、文档与常量同源
 * ⑩c 冻结的正式序列：自摘要/形状正确、与开发校准集**不相交**、手改摘要 ⇒ 拒绝
 * ⑪ CLI fail-closed：无封存 ⇒ missing_seal；干封存 ⇒ run_not_authorized；
 *    **伪造授权文件也不跑** ⇒ unit_not_implemented；runner 源码**不含**模型调用；
 *    读数**汇总包形状**（`{readings:{…}}`）也能读懂；`taskSequence` 绑定 = 冻结序列摘要
 * ```
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import {
  F2_BUDGET_PROPOSAL, F2_EXPECTED_PHYSICAL_REQUESTS_PER_UNIT, F2_EXPECTED_REQUESTS, F2_FORMAL_SEQUENCE_ID, F2_GUARD_CODES,
  F2_PER_TASK_REQUESTS, F2_REQUIRED_GATE_IDS, F2_REQUIRED_SEAL_BINDINGS, F2_UNITS,
  F2_SEAL_STATUS_AUTHORIZED, F2_SEAL_STATUS_NOT_AUTHORIZED, acquireF2StartedLock, accountF2Unit,
  appendF2AttemptLedger, appendF2TaskJournal, assertF2RunAuthorized, buildF2SealedManifest, chargeF2Usage,
  collectF2SealBindings, createF2Meter, f2GateReadingsDigest, f2SealDigest, f2SealDrift, readF2AttemptLedger,
  readF2FormalSequence, readF2TaskJournal, sha256Text, type F2AttemptLedgerEntry, type F2GateReadings,
  type F2SealBinding,
} from './f2-live-runner-guards.ts'

const OUT = resolve('artifacts/local/f2-executor-guards', `run-${Date.now()}`)
mkdirSync(OUT, { recursive: true })
const TEMP = mkdtempSync(resolve(OUT, 'tmp-'))
/** 把授权/记账结论压成一行诊断（`ok` 或闭集码）。 */
const codeOf = (verdict: { readonly ok: true } | { readonly ok: false, readonly code: string }): string =>
  verdict.ok ? 'ok' : verdict.code
const checks: string[] = []
const check = (name: string, value: unknown, detail = ''): void => {
  assert.ok(value, `${name}${detail === '' ? '' : ` — ${detail}`}`)
  checks.push(name)
  console.log(`PASS ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

try {
  // ------------------------------------------------------------------
  // ① 绑定：8 项闭集、缺文件 = MISSING、digest 稳定/敏感
  // ------------------------------------------------------------------
  const paths = Object.fromEntries(F2_REQUIRED_SEAL_BINDINGS.map(id => [id, resolve(TEMP, `missing-${id}.json`)])) as
    Record<(typeof F2_REQUIRED_SEAL_BINDINGS)[number], string>
  writeFileSync(paths.protocol, '{"protocolId":"x"}')
  const incomplete = collectF2SealBindings({ paths })
  check('① 绑定是**8 项闭集**（顺序固定、没有多余项）',
    incomplete.length === 8 && F2_REQUIRED_SEAL_BINDINGS.every((id, index) => incomplete[index]?.id === id))
  check('① 缺文件的绑定记 **MISSING**（不当成"没变"，也不近似成通过）',
    incomplete.filter(item => item.value === 'MISSING').length === 7
    && incomplete.find(item => item.id === 'protocol')?.value !== 'MISSING')
  const same = collectF2SealBindings({ paths })
  check('① digest **稳定**（同输入同 digest）', f2SealDigest(incomplete) === f2SealDigest(same))
  const mutated = collectF2SealBindings({ paths, computed: { image: 'sha256:changed' } })
  check('① digest **敏感**（任一绑定变 ⇒ digest 变）', f2SealDigest(mutated) !== f2SealDigest(incomplete))

  // ------------------------------------------------------------------
  // ② 门读数 fail-closed
  // ------------------------------------------------------------------
  const allPass = Object.fromEntries(F2_REQUIRED_GATE_IDS.map(id => [id, 'PASS'])) as F2GateReadings
  const passed = f2GateReadingsDigest(allPass)
  check('② 全部 PASS ⇒ 给出摘要且**逐门登记**', passed.passed.length === F2_REQUIRED_GATE_IDS.length
    && /^[0-9a-f]{64}$/.test(passed.digest))
  const missingOne = { ...allPass } as Record<string, string>
  delete missingOne[F2_REQUIRED_GATE_IDS[3]!]
  check('② **缺一项门读数** ⇒ 拒绝封存（f2_seal_gate_missing）',
    (() => { try { f2GateReadingsDigest(missingOne as unknown as F2GateReadings); return false } catch (error) {
      return String((error as Error).message).startsWith('f2_seal_gate_missing') } })())
  const failedOne = { ...allPass, [F2_REQUIRED_GATE_IDS[0]!]: 'FAIL' }
  check('② **有一门 FAIL** ⇒ 拒绝封存（f2_seal_gate_failed）',
    (() => { try { f2GateReadingsDigest(failedOne as unknown as F2GateReadings); return false } catch (error) {
      return String((error as Error).message).startsWith('f2_seal_gate_failed') } })())

  // ------------------------------------------------------------------
  // ③ 漂移：任一绑定 / 数量 / digest
  // ------------------------------------------------------------------
  const bindings = collectF2SealBindings({ paths })
  const dry = buildF2SealedManifest({ bindings, sealedAt: '2026-10-26T00:00:00.000Z' })
  check('③ 干封存状态 = **SEALED_NOT_AUTHORIZED_TO_RUN**', dry.status === F2_SEAL_STATUS_NOT_AUTHORIZED)
  const authorized = buildF2SealedManifest({ bindings, sealedAt: '2026-10-26T00:00:00.000Z', authorized: true })
  check('③ 只有**显式** authorized 才是 SEALED_RUN_AUTHORIZED', authorized.status === F2_SEAL_STATUS_AUTHORIZED)
  check('③ 无漂移 ⇒ 空数组', f2SealDrift(dry, bindings).length === 0)
  const drifted = F2_REQUIRED_SEAL_BINDINGS.map(id => {
    const changed: F2SealBinding[] = bindings.map(item => item.id === id ? { ...item, value: 'changed' } : item)
    return f2SealDrift(dry, changed)
  })
  check('③ **每一个**绑定变化都被逐项列出（8/8）',
    drifted.every((problems, index) => problems.includes(F2_REQUIRED_SEAL_BINDINGS[index]!)))
  check('③ 绑定数量不符 ⇒ bindings_count', f2SealDrift(dry, bindings.slice(0, 7)).includes('bindings_count'))
  check('③ digest 不一致单独可辨', f2SealDrift({ ...dry, digest: 'deadbeef' }, bindings).includes('digest'))

  // ------------------------------------------------------------------
  // ④ 授权
  // ------------------------------------------------------------------
  check('④ 没有封存 ⇒ missing_seal',
    codeOf(assertF2RunAuthorized({ manifest: undefined, drift: [], authorizationPresent: true })) === 'missing_seal')
  check('④ 有漂移 ⇒ seal_drift（优先于授权）',
    codeOf(assertF2RunAuthorized({ manifest: dry, drift: ['image'], authorizationPresent: true })) === 'seal_drift')
  check('④ 干封存 + 授权文件在场 ⇒ 仍 run_not_authorized',
    codeOf(assertF2RunAuthorized({ manifest: dry, drift: [], authorizationPresent: true })) === 'run_not_authorized')
  check('④ 已授权封存 + 无授权文件 ⇒ run_not_authorized',
    codeOf(assertF2RunAuthorized({ manifest: authorized, drift: [], authorizationPresent: false })) === 'run_not_authorized')
  check('④ 已授权封存 + 授权文件 ⇒ 放行', assertF2RunAuthorized({ manifest: authorized, drift: [], authorizationPresent: true }).ok === true)

  // ------------------------------------------------------------------
  // ⑤ 请求记账
  // ------------------------------------------------------------------
  const meter = createF2Meter({ requestsCap: F2_BUDGET_PROPOSAL.requestsCap, tokensCap: 1_000_000,
    perTaskRequests: F2_PER_TASK_REQUESTS, maxCompletionTokens: 1_200, now: () => 1 })
  const firstSix = Array.from({ length: 6 }, () => meter.beforeRequest('t1'))
  const seventh = meter.beforeRequest('t1')
  check('⑤ 逐题上限 6：前 6 次放行、**第 7 次被拒**且**不计数**',
    firstSix.every(item => item.ok) && !seventh.ok && codeOf(seventh) === 'task_request_cap'
    && meter.state().requests === 6)
  check('⑤ 换任务重计（别的题还能发）', meter.beforeRequest('t2').ok === true)
  const chargeOk = meter.charge('t1', 'candidate', { total_tokens: 100, prompt_tokens: 60, completion_tokens: 40 })
  check('⑤ usage 完整 ⇒ costConfirmed=true、按 total_tokens 扣', chargeOk.costConfirmed && chargeOk.charged === 100)
  const chargeBad = createF2Meter({ requestsCap: 10, tokensCap: 1_000_000, perTaskRequests: 6,
    maxCompletionTokens: 1_200, now: () => 1 })
  chargeBad.beforeRequest('t1')
  const partial = chargeBad.charge('t1', 'candidate', { prompt_tokens: 50 })
  check('⑤ usage 缺失 ⇒ costConfirmed=false、按**已知下限**扣（prompt + max_tokens）',
    partial.costConfirmed === false && partial.charged === 50 + 1_200 && partial.stopCode === 'cost_unverifiable')
  check('⑤ 成本不可确认之后 ⇒ **后续请求一律被拒**（不继续花钱）',
    !chargeBad.beforeRequest('t1').ok && codeOf(chargeBad.beforeRequest('t1')) === 'cost_unverifiable')
  const requestCapMeter = createF2Meter({ requestsCap: 3, tokensCap: 1_000_000, perTaskRequests: 6, maxCompletionTokens: 100, now: () => 1 })
  for (let index = 0; index < 3; index += 1) requestCapMeter.beforeRequest(`t${String(index)}`)
  check('⑤ 总量上限被尊重（第 4 次 ⇒ budget_requests）', codeOf(requestCapMeter.beforeRequest('t9')) === 'budget_requests')
  const tokenCapMeter = createF2Meter({ requestsCap: 10, tokensCap: 100, perTaskRequests: 6, maxCompletionTokens: 1_000, now: () => 1 })
  tokenCapMeter.beforeRequest('t1')
  tokenCapMeter.charge('t1', 'candidate', { total_tokens: 150 })
  check('⑤ token 上限被尊重（超了 ⇒ budget_tokens）', codeOf(tokenCapMeter.beforeRequest('t1')) === 'budget_tokens')
  check('⑤ **usage 缺失按 max_tokens 保守计**（不是补 0）',
    chargeF2Usage({}, 1_200).charged === 1_200 && chargeF2Usage({}, 1_200).costConfirmed === false)

  // ------------------------------------------------------------------
  // ⑥⑦ 账本
  // ------------------------------------------------------------------
  const ledgerPath = resolve(TEMP, 'attempt-ledger.jsonl')
  appendF2AttemptLedger(ledgerPath, { kind: 'attempt_started', taskId: 't1', at: 1 })
  appendF2AttemptLedger(ledgerPath, { kind: 'attempt_finished', taskId: 't1', charged: 100, costConfirmed: true, at: 1 })
  appendF2AttemptLedger(ledgerPath, { kind: 'attempt_started', taskId: 't1', at: 2 })
  appendF2AttemptLedger(ledgerPath, { kind: 'attempt_finished', taskId: 't1', charged: 30, costConfirmed: false, at: 2 })
  const ledger = readF2AttemptLedger(ledgerPath)
  check('⑥ 请求账本 append-only：读回 4 行（2 尝试×started/finished）、请求 2、token 130、未确认 1、无在途',
    ledger.readable && ledger.entries.length === 4
    && ledger.requests === 2 && ledger.tokens === 130 && ledger.unconfirmed === 1 && ledger.inFlight === 0)
  check('⑥ 账本**不存在** ⇒ readable=false（不把"读不出"当"没有题"）', readF2AttemptLedger(resolve(TEMP, 'nope.jsonl')).readable === false)
  writeFileSync(resolve(TEMP, 'broken.jsonl'), '{not json}\n')
  check('⑥ 账本**损坏** ⇒ readable=false', readF2AttemptLedger(resolve(TEMP, 'broken.jsonl')).readable === false)

  const journalPath = resolve(TEMP, 'tasks-u.jsonl')
  appendF2TaskJournal(journalPath, { kind: 'task_started', unit: 'A-cf', taskId: 'task-1', at: 1 })
  appendF2TaskJournal(journalPath, { kind: 'task_finished', unit: 'A-cf', taskId: 'task-1', at: 2, row: { achieved: true } })
  appendF2TaskJournal(journalPath, { kind: 'task_started', unit: 'A-cf', taskId: 'task-2', at: 3 })
  const journal = readF2TaskJournal(journalPath)
  check('⑦ 任务账本：已完成题**可取回**、在途题被标出',
    journal.readable && journal.finished.length === 1 && journal.finished[0]?.taskId === 'task-1'
    && journal.inFlightTaskIds.length === 1 && journal.inFlightTaskIds[0] === 'task-2')
  writeFileSync(resolve(TEMP, 'broken-tasks.jsonl'), '{bad}\n')
  check('⑦ 任务账本损坏/缺失 ⇒ readable=false', readF2TaskJournal(resolve(TEMP, 'broken-tasks.jsonl')).readable === false
    && readF2TaskJournal(resolve(TEMP, 'none.jsonl')).readable === false)

  // ------------------------------------------------------------------
  // ⑧ 单元对账
  // ------------------------------------------------------------------
  const cleanLedgerPath = resolve(TEMP, 'clean-ledger.jsonl')
  appendF2AttemptLedger(cleanLedgerPath, { kind: 'attempt_started', taskId: 't1', at: 1 })
  appendF2AttemptLedger(cleanLedgerPath, { kind: 'attempt_finished', taskId: 't1', charged: 100, costConfirmed: true, at: 1 })
  const cleanLedger = readF2AttemptLedger(cleanLedgerPath)
  const clean = accountF2Unit({ unit: 'A-cf', reportTaskIds: ['t1'], ledger: cleanLedger, journal })
  check('⑧ 干净 ⇒ costConfirmed；已完成题按账本取回', clean.costConfirmed === true && clean.recoveredTasks.includes('task-1'))
  const unconfirmed = accountF2Unit({ unit: 'A-cf', reportTaskIds: ['t1'],
    ledger: readF2AttemptLedger(ledgerPath), journal })
  check('⑧ **未确认成本** ⇒ cost_unverifiable（不可当已对账）', unconfirmed.codes.includes('cost_unverifiable'))
  const unreportedLedger: F2AttemptLedgerEntry[] = [
    { kind: 'attempt_started', taskId: 't-extra', at: 1 },
    { kind: 'attempt_finished', taskId: 't-extra', charged: 5, costConfirmed: true, at: 1 },
  ]
  const unreportedPath = resolve(TEMP, 'unreported.jsonl')
  for (const entry of unreportedLedger) appendF2AttemptLedger(unreportedPath, entry)
  check('⑧ 账本里有**未进报告**的已确认成本 ⇒ unit_mismatch',
    accountF2Unit({ unit: 'A-cf', reportTaskIds: ['t1'], ledger: readF2AttemptLedger(unreportedPath), journal })
      .codes.includes('unit_mismatch'))
  check('⑧ 账本/任务账本不可读 ⇒ 各自具名码（不混淆）',
    accountF2Unit({ unit: 'A-cf', reportTaskIds: [], ledger: readF2AttemptLedger(resolve(TEMP, 'no1')), journal: readF2TaskJournal(resolve(TEMP, 'no2')) })
      .codes.includes('ledger_unreadable')
    && accountF2Unit({ unit: 'A-cf', reportTaskIds: [], ledger: readF2AttemptLedger(resolve(TEMP, 'no1')), journal: readF2TaskJournal(resolve(TEMP, 'no2')) })
      .codes.includes('journal_unreadable'))

  // ------------------------------------------------------------------
  // ⑨ 二次运行
  // ------------------------------------------------------------------
  const lockDir = resolve(TEMP, 'lock')
  const first = acquireF2StartedLock(lockDir, dry.startMarker)
  const second = acquireF2StartedLock(lockDir, dry.startMarker)
  check('⑨ 二次运行 ⇒ already_started', 'path' in first && 'code' in second && second.code === 'already_started')

  // ------------------------------------------------------------------
  // ⑨b 即时账本 + 在途 ⇒ 成本未知 + 锁绑定封存身份
  // ------------------------------------------------------------------
  {
    const hooked: string[] = []
    const hookedMeter = createF2Meter({
      requestsCap: 10, tokensCap: 100_000, perTaskRequests: 6, maxCompletionTokens: 1_200, now: () => 1,
      onAttempt: entry => hooked.push(entry.kind),
    })
    hookedMeter.beforeRequest('t-live')
    const startedBeforeFetch = hooked.length === 1 && hooked[0] === 'attempt_started'
    hookedMeter.charge('t-live', 'candidate', { total_tokens: 50 })
    check('⑨b 账本**即时落盘**：beforeRequest 先写 started（fetch 前），charge 后写 finished',
      startedBeforeFetch && hooked[1] === 'attempt_finished' && hooked.length === 2, hooked.join(','))

    const inFlightPath = resolve(TEMP, 'ledger-inflight.jsonl')
    appendF2AttemptLedger(inFlightPath, { kind: 'attempt_started', taskId: 't1', at: 1 })
    const inFlightLedger = readF2AttemptLedger(inFlightPath)
    const inFlightAccount = accountF2Unit({
      unit: 'u', reportTaskIds: ['t1'], ledger: inFlightLedger,
      journal: { readable: true, started: ['t1'], finished: [], inFlightTaskIds: ['t1'] },
    })
    check('⑨b **缺结算**（有 started 没 finished）⇒ 记为在途且成本不可确认',
      inFlightLedger.readable && inFlightLedger.inFlight === 1 && inFlightLedger.unconfirmed >= 1)
    check('⑨b 在途账本 ⇒ 对账给出 cost_unverifiable（不当成 0 成本）',
      inFlightAccount.costConfirmed === false && inFlightAccount.codes.includes('cost_unverifiable'),
      inFlightAccount.codes.join(','))

    const lockBase = resolve(TEMP, 'lock-identity')
    const firstLock = acquireF2StartedLock(lockBase, 'marker-a')
    const sameAgain = acquireF2StartedLock(lockBase, 'marker-a')
    const otherMarker = acquireF2StartedLock(lockBase, 'marker-b')
    check('⑨b 锁**绑定封存身份**（路径含 startMarker；不同封存独立；同封存二次 ⇒ already_started）',
      'path' in firstLock && firstLock.path.includes('marker-a')
      && 'code' in sameAgain && sameAgain.code === 'already_started'
      && 'path' in otherMarker && otherMarker.path.includes('marker-b'))
  }

  // ------------------------------------------------------------------
  // ⑨c 有界 abort（政策 A）：账本标记 bounded ⇒ 不算未确认、对账仍通过
  // ------------------------------------------------------------------
  {
    const boundedPath = resolve(TEMP, 'ledger-bounded.jsonl')
    appendF2AttemptLedger(boundedPath, { kind: 'attempt_started', taskId: 't1', at: 1 })
    appendF2AttemptLedger(boundedPath, { kind: 'attempt_finished', taskId: 't1', charged: 4_096, costConfirmed: false, bounded: true, reason: 'client_abort', at: 2 })
    const boundedLedger = readF2AttemptLedger(boundedPath)
    const boundedAccount = accountF2Unit({
      unit: 'u', reportTaskIds: ['t1'], ledger: boundedLedger,
      journal: { readable: true, started: ['t1'], finished: [], inFlightTaskIds: [] },
    })
    check('⑨c 有界 abort 账本：unconfirmed=0、boundedUnconfirmed=1、对账**仍确认**',
      boundedLedger.readable && boundedLedger.unconfirmed === 0 && boundedLedger.boundedUnconfirmed === 1
      && boundedAccount.costConfirmed === true, JSON.stringify({ unconfirmed: boundedLedger.unconfirmed, bounded: boundedLedger.boundedUnconfirmed, codes: boundedAccount.codes }))
  }

  // ------------------------------------------------------------------
  // ⑩ 预算提案
  // ------------------------------------------------------------------
  check('⑩ 预算：6 单元 × 6 题 × 6 次 = **216** 硬上限；期望 **24** = 物理 fetch 读数合计（A/C 各 6、B 各 0；不超上限）',
    F2_BUDGET_PROPOSAL.units === 6 && F2_BUDGET_PROPOSAL.measurementTasks === 36
    && F2_BUDGET_PROPOSAL.formationTasks === 24 && F2_BUDGET_PROPOSAL.requestsCap === 216
    && F2_BUDGET_PROPOSAL.requestsExpected === F2_EXPECTED_REQUESTS
    && F2_BUDGET_PROPOSAL.requestsExpected === 24
    && F2_EXPECTED_REQUESTS === Object.values(F2_EXPECTED_PHYSICAL_REQUESTS_PER_UNIT).reduce<number>((total, calls) => total + calls, 0)
    && F2_BUDGET_PROPOSAL.requestsExpected <= F2_BUDGET_PROPOSAL.requestsCap)
  check('⑩ 预算已由用户裁定（approved=true）但**运行仍需授权**（runAuthorizationRequired=true）',
    F2_BUDGET_PROPOSAL.approved === true && F2_BUDGET_PROPOSAL.runAuthorizationRequired === true
    && F2_BUDGET_PROPOSAL.approvedAt === '2026-10-26')
  check('⑩ 守卫码是**闭集**（没有为此新增码）', F2_GUARD_CODES.length === 12 && new Set(F2_GUARD_CODES).size === 12)
  /*
   * ⑩b **文档与常量不许漂移**：`budget-proposal.json` 是给人看的冻结材料，
   * 常量是机器执行的口径 ⇒ 两者必须同源，否则"提案"与"守卫"会各说一套。
   */
  const budgetDoc = JSON.parse(readFileSync('docs/architecture/f2-preregistration-20261025/budget-proposal.json', 'utf8')) as {
    approved: boolean
    protocolId: string
    status: string
    approval: { runAuthorizationRequired: boolean }
    scope: { units: number, measurementTasks: number, formationTasks: number, unitIds: string[] }
    caps: { requestsCap: number, tokensCapEstimate: number, requestsPerTask: number, requestsPerUnit: number }
    expected: { requestsExpected: number, perUnitPhysicalRequests: Record<string, number> }
    formalSequence: { id: string, sequenceDigest: string }
  }
  check('⑩b `budget-proposal.json` 与常量同源（单元/题数/上限/期望/预算已裁定但运行未授权）',
    budgetDoc.approved === F2_BUDGET_PROPOSAL.approved && budgetDoc.approved === true
    && budgetDoc.protocolId === 'f2-preregistration@3'
    && budgetDoc.approval.runAuthorizationRequired === true
    && budgetDoc.scope.units === F2_BUDGET_PROPOSAL.units
    && budgetDoc.scope.measurementTasks === F2_BUDGET_PROPOSAL.measurementTasks
    && budgetDoc.scope.formationTasks === F2_BUDGET_PROPOSAL.formationTasks
    && budgetDoc.scope.unitIds.length === F2_BUDGET_PROPOSAL.units
    && budgetDoc.caps.requestsCap === F2_BUDGET_PROPOSAL.requestsCap
    && budgetDoc.caps.tokensCapEstimate === F2_BUDGET_PROPOSAL.tokensCapEstimate
    && budgetDoc.caps.requestsPerTask === F2_BUDGET_PROPOSAL.perTaskRequests
    && budgetDoc.caps.requestsPerUnit === F2_BUDGET_PROPOSAL.requestsCap / F2_BUDGET_PROPOSAL.units
    && budgetDoc.expected.requestsExpected === F2_BUDGET_PROPOSAL.requestsExpected
    && JSON.stringify(budgetDoc.expected.perUnitPhysicalRequests) === JSON.stringify(F2_EXPECTED_PHYSICAL_REQUESTS_PER_UNIT))

  // ------------------------------------------------------------------
  // ⑩c 冻结的正式序列（task-spec.json#formalSequence）
  // ------------------------------------------------------------------
  const TASK_SPEC = 'docs/architecture/f2-preregistration-20261025/task-spec.json'
  const formal = readF2FormalSequence(TASK_SPEC)
  const formationObjects = formal.sequence.formation.map(item => (item as { object: string }).object)
  const measurementObjects = formal.sequence.measurement.map(item => (item as { object: string }).object)
  check('⑩c 正式序列自摘要/形状正确（id、4 形成题、6 测量题、6 单元、caps 与预算一致）',
    formal.sequence.id === F2_FORMAL_SEQUENCE_ID
    && formal.digest === formal.sequence.sequenceDigest
    && formationObjects.length === 4 && measurementObjects.length === 6
    && formal.sequence.units.length === F2_UNITS.length
    && formal.sequence.units.every((unit, index) => unit === F2_UNITS[index]?.unit)
    && formal.sequence.caps.perTaskRequests === F2_BUDGET_PROPOSAL.perTaskRequests
    && formal.sequence.caps.perTaskActions === F2_BUDGET_PROPOSAL.perTaskActions
    && formal.sequence.caps.perTaskPlans === F2_BUDGET_PROPOSAL.perTaskPlans)
  check('⑩c 正式序列与开发校准集**不相交**（obj-f1..f4 / obj-07..12 不得参与正式测量）',
    !formationObjects.some(object => /obj-f[1-4]$/.test(object))
    && measurementObjects.every(object => {
      const number = Number(/(\d+)$/.exec(object)?.[1] ?? 'NaN')
      return !(number >= 7 && number <= 12)
    })
    && new Set([...formationObjects, ...measurementObjects]).size === 10)
  const corruptedSpec = resolve(TEMP, 'task-spec-corrupt.json')
  writeFileSync(corruptedSpec, JSON.stringify({
    formalSequence: { ...formal.sequence, sequenceDigest: 'deadbeef' },
  }))
  let corruptRejected = false
  try { readF2FormalSequence(corruptedSpec) } catch { corruptRejected = true }
  check('⑩c 序列摘要被手改 ⇒ **拒绝**（失败关闭，不猜序列）', corruptRejected)

  // ------------------------------------------------------------------
  // ⑪ CLI fail-closed（子进程；**零请求**）
  // ------------------------------------------------------------------
  const cli = (args: string[], env: Record<string, string> = {}) => spawnSync(process.execPath,
    ['--import', './node_modules/tsx/dist/loader.mjs', 'scripts/cognitive/f2-live-runner.ts', ...args],
    { encoding: 'utf8', timeout: 120_000, env: { ...process.env, ...env } })
  const cliDir = resolve(TEMP, 'cli')
  const runWithoutSeal = cli(['--run'], { F2_EXECUTOR_DIR: cliDir })
  check('⑪ 无封存 ⇒ `--run` 拒绝（missing_seal，退出码 3）',
    runWithoutSeal.status === 3 && String(runWithoutSeal.stderr).includes('missing_seal'),
    String(runWithoutSeal.stderr).trim().slice(0, 80))
  const readings = JSON.stringify(Object.fromEntries(F2_REQUIRED_GATE_IDS.map(id => [id, 'PASS'])))
  const sealed = cli(['--seal'], {
    F2_EXECUTOR_DIR: cliDir, F2_GATE_READINGS_JSON: readings,
    F2_SOURCE_FINGERPRINT: 'fp-test', F2_IMAGE_ID: 'sha256:test-image',
  })
  const sealFile = resolve(cliDir, 'f2-seal.json')
  check('⑪ 全绿门读数 ⇒ `--seal` 产出**干封存**（status=未授权、退出码 0）',
    sealed.status === 0 && existsSync(sealFile)
    && (JSON.parse(readFileSync(sealFile, 'utf8')) as { status: string }).status === F2_SEAL_STATUS_NOT_AUTHORIZED)
  const runDry = cli(['--run'], { F2_EXECUTOR_DIR: cliDir, F2_GATE_READINGS_JSON: readings,
    F2_SOURCE_FINGERPRINT: 'fp-test', F2_IMAGE_ID: 'sha256:test-image' })
  check('⑪ 干封存 ⇒ `--run` 拒绝（run_not_authorized）',
    runDry.status === 3 && String(runDry.stderr).includes('run_not_authorized'))
  writeFileSync(resolve(cliDir, 'f2-run-authorization.json'), JSON.stringify({ forged: true }))
  const runForged = cli(['--run'], { F2_EXECUTOR_DIR: cliDir, F2_GATE_READINGS_JSON: readings,
    F2_SOURCE_FINGERPRINT: 'fp-test', F2_IMAGE_ID: 'sha256:test-image' })
  check('⑪ **伪造授权文件也不跑**（干封存仍是 run_not_authorized；未实现路径 unit_not_implemented）',
    runForged.status === 3
    && (String(runForged.stderr).includes('run_not_authorized') || String(runForged.stderr).includes('unit_not_implemented')),
    String(runForged.stderr).trim().slice(0, 80))
  rmSync(resolve(cliDir, 'f2-run-authorization.json'), { force: true })
  const statusOut = cli(['--status'], { F2_EXECUTOR_DIR: cliDir })
  check('⑪ `--status` 只读可用且**报告不可运行**', statusOut.status === 0
    && String(statusOut.stdout).includes('可运行=否'))
  /*
   * ⑪b **门读数汇总包也要能被读懂**：`f2-gate-readings.ts` 产出的是
   * `{ readings: {…}, evidence: {…} }`（带证据的汇总包）。如果 runner 只认扁平形状，
   * 干封存会静默得到 `gateReadings=MISSING` —— 这正是本批实际踩到的坑，必须留一条回归。
   */
  const nestedDir = resolve(TEMP, 'cli-nested')
  const nestedFile = resolve(nestedDir, 'gate-readings.json')
  mkdirSync(nestedDir, { recursive: true })
  writeFileSync(nestedFile, JSON.stringify({
    generatedAt: new Date().toISOString(), readings: JSON.parse(readings) as F2GateReadings, evidence: {},
  }))
  const nestedSeal = cli(['--seal'], {
    F2_EXECUTOR_DIR: nestedDir, F2_GATE_READINGS_FILE: nestedFile,
    F2_SOURCE_FINGERPRINT: 'fp-test', F2_IMAGE_ID: 'sha256:test-image',
  })
  const nestedSealJson = JSON.parse(readFileSync(resolve(nestedDir, 'f2-seal.json'), 'utf8')) as {
    bindings: { id: string, value: string }[]
  }
  const nestedStatus = cli(['--status'], {
    F2_EXECUTOR_DIR: nestedDir, F2_GATE_READINGS_FILE: nestedFile,
    F2_SOURCE_FINGERPRINT: 'fp-test', F2_IMAGE_ID: 'sha256:test-image',
  })
  check('⑪b 汇总包形状的读数文件 ⇒ 门读数绑定**不是** MISSING（干封存 + 零漂移）；taskSequence 绑定 = 冻结序列摘要',
    nestedSeal.status === 0
    && nestedSealJson.bindings.find(item => item.id === 'gateReadings')?.value !== 'MISSING'
    && nestedSealJson.bindings.find(item => item.id === 'taskSequence')?.value === formal.digest
    && nestedStatus.status === 0 && String(nestedStatus.stdout).includes('漂移=无')
    && String(nestedStatus.stdout).includes('可运行=否'), String(nestedStatus.stdout).trim().slice(0, 120))
  const runnerSource = readFileSync('scripts/cognitive/f2-live-runner.ts', 'utf8')
  check('⑪ runner 源码**不含**模型调用 / 网络调用（零请求的结构保证）',
    !/infrastructure\/model|fetch\(|XMLHttpRequest|chat\.completions/i.test(runnerSource))
  check('⑪ 守卫模块也不发请求', !/fetch\(/i.test(readFileSync('scripts/cognitive/f2-live-runner-guards.ts', 'utf8')))
  check('⑪ 门读数生成器也不发请求（本批新增的第三个零请求脚本）',
    !/infrastructure\/model|fetch\(|XMLHttpRequest|chat\.completions/i.test(readFileSync('scripts/cognitive/f2-gate-readings.ts', 'utf8')))

  writeFileSync(resolve(OUT, 'verification.json'), JSON.stringify({
    status: 'PASS', schema: 'f2-executor-guards@1', measuredAt: new Date().toISOString(), checks,
    budgetProposal: F2_BUDGET_PROPOSAL, boundary: [
      '本门零数据库、零模型请求、零真实运行',
      'CLI 子进程只在**临时目录**里跑（不覆盖真实干封存）',
      '真实单元执行**未实现** ⇒ 即使授权在场也 fail-closed（unit_not_implemented）',
    ],
  }, null, 2))
  console.log(`F2 执行器守卫门：${String(checks.length)}/${String(checks.length)}；${OUT}`)
} catch (error) {
  writeFileSync(resolve(OUT, 'verification.json'), JSON.stringify({ status: 'FAIL', checks,
    error: error instanceof Error ? error.message : 'unknown' }, null, 2))
  throw error
} finally {
  rmSync(TEMP, { recursive: true, force: true })
}
