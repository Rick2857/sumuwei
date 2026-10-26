/**
 * **F1 最小契约的离线门**（`f1-precondition@1`，**零模型请求**）
 *
 * 契约见 [F1 最小契约](docs/architecture/Cognitive-Capability-F1-Minimal-Contract-2026-10-24.md)。
 * 本门证明的是**机制**：同一状态、同一候选池，**只改变"规则是否可用"**就能解释并复现选择变化；
 * 以及八条负控（顺序置换/未知条件/错误族/撤回/单次失败/失败码分流/独立证据/真值泄漏）。
 *
 * ⚠️ **不**声称任何收益；**不**接产品入口（守卫是场景侧注入，产品行为一字不改）。
 */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createObservingFilePlanningBed } from './file-planning-bed.ts'
import {
  F1_CONDITION_FILE, F1_CONDITION_LOCKED, F1_CONDITION_READY, F1_TARGET,
  directCandidate, makeRule, plannerInputLeaks, prepareCandidate, proposeHypothesisEvidence, qualify, ruleIdFor, selectCandidate,
  type F1ActionReceipt, type F1Candidate, type F1Qualification, type GuardState,
} from './f1-precondition-core.ts'
import type { TaskPlannerPort } from '../../src/kernel/action/task-plan.ts'

const cases = ['main-chain', 'n1-order-permutation', 'n2-unknown-condition', 'n3-wrong-family',
  'n4-withdrawal', 'n5-single-failure', 'n6-failure-code-routing', 'n7-independent-evidence', 'n8-truth-leak']

if (process.argv.includes('--list-cases')) { console.log(cases.join('\n')); process.exit(0) }
const selected = process.argv[process.argv.indexOf('--case') + 1]
assert.ok(cases.includes(selected), `unknown_case:${String(selected)}`)

let checks = 0
let trajectory = ''
const ok = (label: string, condition: boolean) => { assert.ok(condition, label); checks += 1 }

const FAMILY_A = 'f1-family-a'
/** 受信族映射（**场景侧**拥有；不来自模型）。 */
const FAMILY_MAP: Readonly<Record<string, string>> = { 'f1/a': FAMILY_A, 'f1/b': 'f1-family-b' }
const familyOfPath = (path: string) => FAMILY_MAP[path.split('/').slice(0, 2).join('/')] ?? 'f1-family-unknown'

/** 占位规划器：按给定候选的步骤原样执行（**不调用模型**）。 */
function planOf(candidate: F1Candidate): TaskPlannerPort {
  return { id: `f1-${candidate.id}`, endpointHost: 'offline', async plan() {
    return { ok: true, requestCount: 1, plan: { goal: 'f1', done: true,
      steps: candidate.steps.map(step => ({ capability: step.capability, operation: step.operation, args: { ...step.args } })) } }
  } }
}

/** 跑一次真任务，返回**真实回执**（从执行结果里取，不看规划器自述）。 */
async function runOne(bed: Awaited<ReturnType<typeof createObservingFilePlanningBed>>, path: string, content: string, candidate: F1Candidate, guard: GuardState) {
  const outcome = await bed.run(planOf(candidate), { text: `在 ${path} 写入并读回`, observe: true })
  const write = outcome.results.find(item => item.request.capability === 'sandbox.file.write')
  const receipt: F1ActionReceipt = {
    capability: 'sandbox.file.write', operation: 'write', target: path,
    status: write?.result.status === 'success' ? 'success' : 'failure',
    ...(write?.result.status === 'success' ? {} : { failureCode: write?.result.error?.code ?? 'execution_failed' }),
    binding: path, guard, familyId: familyOfPath(path),
  }
  return { outcome, receipt }
}

if (selected === 'main-chain') {
  // -------------------------------------------------------------------------
  // 完整链：真实观察 → 假设 → 独立验证取得资格 → 新对象消费 → Gateway 执行 → 反例失效
  // -------------------------------------------------------------------------
  const bed = await createObservingFilePlanningBed('f1-gate-main', {
    markerFile: F1_CONDITION_FILE, lockedValue: F1_CONDITION_LOCKED,
  })
  try {
    // 准备：族 f1/a 里三个**不同对象**（o1/o2 处于 locked、o3 处于 ready）⇒ 独立 binding 来自不同对象。
    const receipts: F1ActionReceipt[] = []
    const controls: F1ActionReceipt[] = []
    for (const [objectPath, guard] of [['f1/a/o1.txt', F1_CONDITION_LOCKED], ['f1/a/o2.txt', F1_CONDITION_LOCKED], ['f1/a/o3.txt', F1_CONDITION_READY]] as const) {
      writeFileSync(resolve(bed.root, F1_CONDITION_FILE), guard)   // 场景状态（守卫读取它）
      const { receipt } = await runOne(bed, objectPath, `content-${objectPath}`, directCandidate(objectPath, `content-${objectPath}`), guard)
      if (guard === F1_CONDITION_LOCKED) { receipts.push(receipt) } else { controls.push(receipt) }
    }
    ok('locked_direct_write_fails', receipts.every(item => item.status === 'failure'))
    ok('locked_failure_code_is_validation_failed', receipts.every(item => item.failureCode === 'validation_failed'))
    ok('ready_direct_write_succeeds', controls.every(item => item.status === 'success'))
    // 假设 + 资格（≥2 个不同 binding + 一个对照）
    const evidence = proposeHypothesisEvidence(receipts)
    ok('hypothesis_from_receipts_only', evidence.length === 2)
    const rule = makeRule(FAMILY_A)
    const qualification = qualify({ evidence, controlSuccesses: controls, counterexamples: [] }, rule)
    ok('qualified_after_two_bindings_and_control', qualification.usable === true)
    // 消费：同一状态、同一候选池，仅改变"规则是否可用"（对象是族内新对象 o4.txt）
    const objectPath = 'f1/a/o4.txt'
    const candidates: F1Candidate[] = [directCandidate(objectPath, 'c-new'), prepareCandidate(objectPath, 'c-new', F1_CONDITION_FILE)]
    const withRule = selectCandidate({ candidates, rule, qualification, objectFamilyId: FAMILY_A, guard: F1_CONDITION_LOCKED, withdrawn: false })
    ok('with_rule_selects_prepare', withRule.selected === 'prepare' && withRule.reason === 'rule_qualified_veto_direct')
    const withoutRule = selectCandidate({ candidates, rule, qualification: { usable: false, bindings: 2, reason: 'counterexample' }, objectFamilyId: FAMILY_A, guard: F1_CONDITION_LOCKED, withdrawn: false })
    ok('without_rule_selects_direct', withoutRule.selected === 'direct' && withoutRule.reason === 'not_qualified')
    // Gateway 实际执行（准备候选真的能成：先清锁、再写、再读回）
    writeFileSync(resolve(bed.root, F1_CONDITION_FILE), F1_CONDITION_LOCKED)
    const executed = await runOne(bed, objectPath, 'c-new', prepareCandidate(objectPath, 'c-new', F1_CONDITION_FILE), F1_CONDITION_LOCKED)
    ok('prepare_candidate_executes_successfully', executed.outcome.results.length === 3
      && executed.outcome.results.filter(item => item.request.capability === 'sandbox.file.write').every(item => item.result.status === 'success'))
    // 反例：locked 下直接写**成功** ⇒ 规则被反例命中 ⇒ 不可用（停止消费）
    const counterexample: F1ActionReceipt = { capability: 'sandbox.file.write', operation: 'write', target: 'f1/a/o9.txt',
      status: 'success', binding: 'f1/a/o9.txt', guard: F1_CONDITION_LOCKED, familyId: FAMILY_A }
    const afterCounter = qualify({ evidence, controlSuccesses: controls, counterexamples: [counterexample] }, rule)
    ok('counterexample_blocks_use', afterCounter.usable === false && afterCounter.reason === 'counterexample')
    const afterCounterSelection = selectCandidate({ candidates, rule, qualification: afterCounter, objectFamilyId: FAMILY_A, guard: F1_CONDITION_LOCKED, withdrawn: false })
    ok('counterexample_restores_default_order', afterCounterSelection.selected === 'direct' && afterCounterSelection.reason === 'not_qualified')
    trajectory = `chain: evidence=${String(evidence.length)} bindings=${String(qualification.usable ? qualification.bindings : 0)} withRule=${withRule.selected} withoutRule=${withoutRule.selected} executed=${String(executed.outcome.results.length)} counterexample->${afterCounterSelection.selected}`
  } finally { await bed.stop() }
} else if (selected === 'n1-order-permutation') {
  const rule = makeRule(FAMILY_A)
  const qualification: F1Qualification = { usable: true, bindings: 2, rule, reason: 'qualified' }
  const a: F1Candidate[] = [directCandidate(F1_TARGET, 'x'), prepareCandidate(F1_TARGET, 'x', F1_CONDITION_FILE)]
  const b: F1Candidate[] = [prepareCandidate(F1_TARGET, 'x', F1_CONDITION_FILE), directCandidate(F1_TARGET, 'x')]
  const first = selectCandidate({ candidates: a, rule, qualification, objectFamilyId: FAMILY_A, guard: F1_CONDITION_LOCKED, withdrawn: false })
  const second = selectCandidate({ candidates: b, rule, qualification, objectFamilyId: FAMILY_A, guard: F1_CONDITION_LOCKED, withdrawn: false })
  ok('permuted_pool_same_choice', first.selected === 'prepare' && second.selected === 'prepare')
  // 条件 ready 时两种顺序都回默认（默认=池中第一条）⇒ 证明"跟规则、不跟位置"
  const readyFirst = selectCandidate({ candidates: a, rule, qualification, objectFamilyId: FAMILY_A, guard: F1_CONDITION_READY, withdrawn: false })
  const readySecond = selectCandidate({ candidates: b, rule, qualification, objectFamilyId: FAMILY_A, guard: F1_CONDITION_READY, withdrawn: false })
  ok('ready_falls_back_to_each_pools_first', readyFirst.selected === 'direct' && readySecond.selected === 'prepare')
  trajectory = `n1: locked->${first.selected}/${second.selected} ready->${readyFirst.selected}/${readySecond.selected}`
} else if (selected === 'n2-unknown-condition') {
  const rule = makeRule(FAMILY_A)
  const qualification: F1Qualification = { usable: true, bindings: 2, rule, reason: 'qualified' }
  const candidates = [directCandidate(F1_TARGET, 'x'), prepareCandidate(F1_TARGET, 'x', F1_CONDITION_FILE)]
  const unknown = selectCandidate({ candidates, rule, qualification, objectFamilyId: FAMILY_A, guard: 'unknown', withdrawn: false })
  ok('unknown_condition_no_veto', unknown.selected === 'direct' && unknown.reason === 'unknown_condition_no_veto')
  ok('unknown_condition_veto_list_empty', unknown.vetoed.length === 0)
  trajectory = `n2: ${unknown.selected} (${unknown.reason})`
} else if (selected === 'n3-wrong-family') {
  const rule = makeRule(FAMILY_A)
  const qualification: F1Qualification = { usable: true, bindings: 2, rule, reason: 'qualified' }
  const candidates = [directCandidate(F1_TARGET, 'x'), prepareCandidate(F1_TARGET, 'x', F1_CONDITION_FILE)]
  const other = selectCandidate({ candidates, rule, qualification, objectFamilyId: 'f1-family-b', guard: F1_CONDITION_LOCKED, withdrawn: false })
  ok('other_family_refuses_rule', other.selected === 'direct' && other.reason === 'family_mismatch')
  ok('rule_identity_carries_family', rule.ruleId.includes(FAMILY_A) && ruleIdFor(FAMILY_A) !== ruleIdFor('f1-family-b'))
  trajectory = `n3: ${other.selected} (${other.reason})`
} else if (selected === 'n4-withdrawal') {
  const rule = makeRule(FAMILY_A)
  const qualification: F1Qualification = { usable: true, bindings: 2, rule, reason: 'qualified' }
  const candidates = [directCandidate(F1_TARGET, 'x'), prepareCandidate(F1_TARGET, 'x', F1_CONDITION_FILE)]
  const withdrawn = selectCandidate({ candidates, rule, qualification, objectFamilyId: FAMILY_A, guard: F1_CONDITION_LOCKED, withdrawn: true })
  ok('withdrawn_stops_consumption', withdrawn.selected === 'direct' && withdrawn.reason === 'rule_withdrawn')
  trajectory = `n4: ${withdrawn.selected} (${withdrawn.reason})`
} else if (selected === 'n5-single-failure') {
  const rule = makeRule(FAMILY_A)
  const evidence = proposeHypothesisEvidence([{ capability: 'sandbox.file.write', operation: 'write', target: F1_TARGET,
    status: 'failure', failureCode: 'validation_failed', binding: 'f1/a/o1', guard: F1_CONDITION_LOCKED, familyId: FAMILY_A }])
  const controls: F1ActionReceipt[] = [{ capability: 'sandbox.file.write', operation: 'write', target: F1_TARGET,
    status: 'success', binding: 'f1/a/o2', guard: F1_CONDITION_READY, familyId: FAMILY_A }]
  const q = qualify({ evidence, controlSuccesses: controls, counterexamples: [] }, rule)
  ok('single_failure_not_qualified', q.usable === false && q.reason === 'insufficient_bindings' && q.bindings === 1)
  const candidates = [directCandidate(F1_TARGET, 'x'), prepareCandidate(F1_TARGET, 'x', F1_CONDITION_FILE)]
  const s = selectCandidate({ candidates, rule, qualification: q, objectFamilyId: FAMILY_A, guard: F1_CONDITION_LOCKED, withdrawn: false })
  ok('single_failure_keeps_default', s.selected === 'direct')
  trajectory = `n5: bindings=${String(q.bindings)} ${s.selected}`
} else if (selected === 'n6-failure-code-routing') {
  // 只有 validation_failed 算证据：其余失败码（含 permission_denied/timeout）一律不算
  for (const code of ['permission_denied', 'timeout', 'cancelled', 'unsupported', 'partial_success', 'target_not_found', 'target_ambiguous', 'target_uncertain', 'execution_failed']) {
    const evidence = proposeHypothesisEvidence([{ capability: 'sandbox.file.write', operation: 'write', target: F1_TARGET,
      status: 'failure', failureCode: code, binding: 'f1/a/o1', guard: F1_CONDITION_LOCKED, familyId: FAMILY_A }])
    ok(`rejects_${code}`, evidence.length === 0)
  }
  const accepted = proposeHypothesisEvidence([{ capability: 'sandbox.file.write', operation: 'write', target: F1_TARGET,
    status: 'failure', failureCode: 'validation_failed', binding: 'f1/a/o1', guard: F1_CONDITION_LOCKED, familyId: FAMILY_A }])
  ok('accepts_validation_failed', accepted.length === 1)
  const notLocked = proposeHypothesisEvidence([{ capability: 'sandbox.file.write', operation: 'write', target: F1_TARGET,
    status: 'failure', failureCode: 'validation_failed', binding: 'f1/a/o1', guard: F1_CONDITION_READY, familyId: FAMILY_A }])
  ok('requires_locked_condition', notLocked.length === 0)
  trajectory = `n6: 9 other codes rejected, validation_failed accepted (guard=locked only)`
} else if (selected === 'n7-independent-evidence') {
  const rule = makeRule(FAMILY_A)
  const sameObject: F1ActionReceipt[] = [1, 2, 3].map(() => ({ capability: 'sandbox.file.write', operation: 'write', target: F1_TARGET,
    status: 'failure', failureCode: 'validation_failed', binding: 'f1/a/o1', guard: F1_CONDITION_LOCKED, familyId: FAMILY_A }))
  const evidence = proposeHypothesisEvidence(sameObject)
  const controls: F1ActionReceipt[] = [{ capability: 'sandbox.file.write', operation: 'write', target: F1_TARGET,
    status: 'success', binding: 'f1/a/o2', guard: F1_CONDITION_READY, familyId: FAMILY_A }]
  const q = qualify({ evidence, controlSuccesses: controls, counterexamples: [] }, rule)
  ok('repeated_same_object_is_one_binding', q.bindings === 1 && q.usable === false)
  const twoObjects = proposeHypothesisEvidence([
    { capability: 'sandbox.file.write', operation: 'write', target: F1_TARGET, status: 'failure', failureCode: 'validation_failed', binding: 'f1/a/o1', guard: F1_CONDITION_LOCKED, familyId: FAMILY_A },
    { capability: 'sandbox.file.write', operation: 'write', target: F1_TARGET, status: 'failure', failureCode: 'validation_failed', binding: 'f1/a/o2', guard: F1_CONDITION_LOCKED, familyId: FAMILY_A },
  ])
  const q2 = qualify({ evidence: twoObjects, controlSuccesses: controls, counterexamples: [] }, rule)
  ok('two_objects_qualified', q2.usable === true && q2.bindings === 2)
  trajectory = `n7: same-object bindings=${String(q.bindings)} -> two-object bindings=${String(q2.bindings)}`
} else if (selected === 'n8-truth-leak') {
  const clean = { text: '在 f1-target.txt 写入并读回', executed: [], allowedCapabilities: ['sandbox.file.write'], knownDirectories: [], facts: { encode: 'utf8' } }
  ok('clean_input_no_leak', plannerInputLeaks(clean).length === 0)
  const leaked = { ...clean, guardImplementation: 'wp' }
  ok('extra_key_detected', plannerInputLeaks(leaked).length >= 1)
  const leakedText = { ...clean, text: '在 f1-target.txt 写入并读回（守卫会返回 validation_failed）' }
  ok('failure_code_in_text_detected', plannerInputLeaks(leakedText).some(item => item.includes('contains:')))
  const leakedRule = { ...clean, facts: { ruleId: ruleIdFor('f1-family-a') } }
  ok('rule_id_detected', plannerInputLeaks(leakedRule).some(item => item.includes('contains:ruleId')))
  trajectory = `n8: clean=0 leaky>=1`
}

console.log(`F1 最小契约离线门[${selected}]：${String(checks)} 项检查全部通过（零模型请求）。${trajectory}`)
