/**
 * **ADR-151 步骤 C 的门**：形成来源的**决策逻辑**（`write-precondition`）。
 *
 * 零模型、零数据库：只验**失败码分流、条件同现、对照、反例、资格口径**。
 * ⚠️ 本门**不**验 EBL 提案/登记的接线（那是步骤 C 的剩余部分，C2）。
 */
import assert from 'node:assert/strict'
import {
  WRITE_PRECONDITION_ACTION, WRITE_PRECONDITION_EVIDENCE_FAILURE_CODE, WRITE_PRECONDITION_EXCLUDED_FAILURE_CODES,
  classifyWritePreconditionEvidence, classifyWritePreconditionObservation, type WritePreconditionReceipt,
} from '../../src/kernel/contracts/write-precondition.ts'

let checks = 0
let trajectory = ''
const ok = (label: string, condition: boolean) => { assert.ok(condition, label); checks += 1 }

const CONDITION = 'f1-guard.txt'
const LOCKED = 'locked'
const family = 'f1/a'
const observed = (value: string) => ({ conditionPath: CONDITION, value })
const failure = (target: string, episodeId: string, designId: string, code: string, condition?: string): WritePreconditionReceipt => ({
  capability: WRITE_PRECONDITION_ACTION.capability, operation: WRITE_PRECONDITION_ACTION.operation,
  target, episodeId, designId, status: 'failure', failureCode: code,
  ...(condition === undefined ? {} : { conditionObserved: observed(condition) }),
})
const success = (target: string, episodeId: string, designId: string, condition?: string): WritePreconditionReceipt => ({
  capability: WRITE_PRECONDITION_ACTION.capability, operation: WRITE_PRECONDITION_ACTION.operation,
  target, episodeId, designId, status: 'success',
  ...(condition === undefined ? {} : { conditionObserved: observed(condition) }),
})
const classify = (receipts: readonly WritePreconditionReceipt[]) =>
  classifyWritePreconditionEvidence({ receipts, familyId: family, conditionPath: CONDITION, mustNotEqual: LOCKED })

// ---------------------------------------------------------------------------
// ① 失败码分流：9 个排除码 + 非证据码 **一律不算**；只有 `validation_failed` 算
// ---------------------------------------------------------------------------
ok('excluded_codes_exactly_nine', WRITE_PRECONDITION_EXCLUDED_FAILURE_CODES.length === 9)
for (const code of WRITE_PRECONDITION_EXCLUDED_FAILURE_CODES) {
  const verdict = classify([failure('f1/a/o1', 'e1', 'd1', code, LOCKED), failure('f1/a/o2', 'e2', 'd2', code, LOCKED)])
  ok(`rejects_${code}`, verdict.kind === 'no_evidence')
}
ok('evidence_code_is_validation_failed', WRITE_PRECONDITION_EVIDENCE_FAILURE_CODE === 'validation_failed')
ok('other_code_not_evidence', classify([failure('f1/a/o1', 'e1', 'd1', 'some_other_code', LOCKED)]).kind === 'no_evidence')
ok('missing_failure_code_not_evidence', classify([failure('f1/a/o1', 'e1', 'd1', 'unknown' as string, LOCKED)]).kind !== 'candidate')

// ---------------------------------------------------------------------------
// ② 条件同现：条件**未知** ⇒ 归因不了（不猜）
// ---------------------------------------------------------------------------
ok('condition_unknown_is_not_evidence', classify([failure('f1/a/o1', 'e1', 'd1', 'validation_failed')]).kind === 'no_evidence')
ok('condition_observed_not_violated_is_not_evidence',
  classify([failure('f1/a/o1', 'e1', 'd1', 'validation_failed', 'ready')]).kind === 'no_evidence')
ok('condition_other_path_is_not_evidence',
  classify([{ ...failure('f1/a/o1', 'e1', 'd1', 'validation_failed', LOCKED), conditionObserved: { conditionPath: 'other.txt', value: LOCKED } }]).kind === 'no_evidence')

// ---------------------------------------------------------------------------
// ③ 资格口径（**复用既有政策**：≥2 binding / ≥2 episode / ≥2 design + ≥1 对照）
// ---------------------------------------------------------------------------
const twoEvidence = [failure('f1/a/o1', 'e1', 'd1', 'validation_failed', LOCKED), failure('f1/a/o2', 'e2', 'd2', 'validation_failed', LOCKED)]
const single = classify([twoEvidence[0]!])
ok('single_binding_insufficient', single.kind === 'insufficient_independence'
  && single.kind === 'insufficient_independence' && single.missing.includes('bindings'))
const noControl = classify(twoEvidence)
ok('two_bindings_without_control_insufficient', noControl.kind === 'insufficient_independence'
  && noControl.kind === 'insufficient_independence' && noControl.missing.includes('control'))
const withControl = classify([...twoEvidence, success('f1/a/o3', 'e3', 'd3', 'ready')])
ok('two_bindings_plus_control_is_candidate', withControl.kind === 'candidate')
if (withControl.kind === 'candidate') {
  ok('candidate_carries_family', withControl.hypothesis.familyId === family)
  ok('candidate_carries_condition', withControl.hypothesis.conditionPath === CONDITION && withControl.hypothesis.mustNotEqual === LOCKED)
  ok('candidate_carries_action', withControl.hypothesis.action.capability === 'sandbox.file.write' && withControl.hypothesis.action.operation === 'write')
  ok('candidate_lists_bindings', withControl.evidenceBindings.join(',') === 'f1/a/o1,f1/a/o2')
  ok('candidate_lists_control', withControl.controlBindings.join(',') === 'f1/a/o3')
}
// 同一对象重复 ⇒ 仍是 1 个 binding
const sameObjectTwice = classify([failure('f1/a/o1', 'e1', 'd1', 'validation_failed', LOCKED), failure('f1/a/o1', 'e2', 'd2', 'validation_failed', LOCKED), success('f1/a/o3', 'e3', 'd3', 'ready')])
ok('same_object_repeated_is_one_binding', sameObjectTwice.kind === 'insufficient_independence'
  && sameObjectTwice.kind === 'insufficient_independence' && sameObjectTwice.missing.includes('bindings'))
// 同一 episode 两次 ⇒ episode 不独立
const sameEpisode = classify([failure('f1/a/o1', 'e1', 'd1', 'validation_failed', LOCKED), failure('f1/a/o2', 'e1', 'd2', 'validation_failed', LOCKED), success('f1/a/o3', 'e3', 'd3', 'ready')])
ok('same_episode_is_not_independent', sameEpisode.kind === 'insufficient_independence'
  && sameEpisode.kind === 'insufficient_independence' && sameEpisode.missing.includes('episodes'))
// 同一 design 两次 ⇒ design 不独立
const sameDesign = classify([failure('f1/a/o1', 'e1', 'd1', 'validation_failed', LOCKED), failure('f1/a/o2', 'e2', 'd1', 'validation_failed', LOCKED), success('f1/a/o3', 'e3', 'd3', 'ready')])
ok('same_design_is_not_independent', sameDesign.kind === 'insufficient_independence'
  && sameDesign.kind === 'insufficient_independence' && sameDesign.missing.includes('designs'))

// ---------------------------------------------------------------------------
// ④ 反例：条件被违反却成功 ⇒ 规则被反驳（**优先于**资格判定）
// ---------------------------------------------------------------------------
const refuted = classify([...twoEvidence, success('f1/a/o4', 'e4', 'd4', LOCKED)])
ok('counterexample_refutes', refuted.kind === 'refuted')
if (refuted.kind === 'refuted') ok('counterexample_binding_listed', refuted.counterexampleBindings.join(',') === 'f1/a/o4')
ok('counterexample_beats_candidate', classify([...twoEvidence, success('f1/a/o3', 'e3', 'd3', 'ready'), success('f1/a/o4', 'e4', 'd4', LOCKED)]).kind === 'refuted')

// ---------------------------------------------------------------------------
// ⑤ 无关动作不参与（非写动作不进证据）
// ---------------------------------------------------------------------------
ok('non_write_action_ignored', classify([{ ...failure('f1/a/o1', 'e1', 'd1', 'validation_failed', LOCKED), capability: 'sandbox.file.read' }]).kind === 'no_evidence')
// 族键非法 ⇒ 失败关闭
ok('bad_family_rejected', (() => {
  try { classifyWritePreconditionEvidence({ receipts: [], familyId: 'bad id', conditionPath: CONDITION, mustNotEqual: LOCKED }); return false } catch { return true }
})())

// ---------------------------------------------------------------------------
// ⑥ **产品接线用的那一份判定**（`classifyWritePreconditionObservation`）
//    —— C2 的读面**调用**它 ⇒ 纯函数门的断言**覆盖**产品路径（不会各自漂移）
// ---------------------------------------------------------------------------
const reading = (input: {
  status: 'success' | 'failure' | 'rejected' | 'cancelled'
  failureCode?: string
  value?: string
  trusted?: boolean
  executed?: boolean
}) => classifyWritePreconditionObservation({
  status: input.status,
  ...(input.failureCode === undefined ? {} : { failureCode: input.failureCode }),
  ...(input.value === undefined ? {} : { conditionObserved: observed(input.value) }),
  conditionPath: CONDITION, mustNotEqual: LOCKED,
  executed: input.executed !== false,
  conditionTrusted: input.trusted !== false,
})
ok('reading_evidence_only_on_evidence_code', reading({ status: 'failure', failureCode: 'validation_failed', value: LOCKED }).kind === 'evidence')
ok('reading_evidence_needs_executed', reading({ status: 'failure', failureCode: 'validation_failed', value: LOCKED, executed: false }).kind === 'excluded')
ok('reading_control_when_success_without_violation', reading({ status: 'success', value: 'ready' }).kind === 'control')
ok('reading_counterexample_when_success_with_violation', reading({ status: 'success', value: LOCKED }).kind === 'counterexample')
ok('reading_unknown_when_condition_missing', reading({ status: 'failure', failureCode: 'validation_failed' }).kind === 'unknown')
ok('reading_unknown_when_marker_not_trusted', reading({ status: 'failure', failureCode: 'validation_failed', value: LOCKED, trusted: false }).kind === 'unknown')
ok('reading_excluded_for_every_other_code', WRITE_PRECONDITION_EXCLUDED_FAILURE_CODES.every(code =>
  reading({ status: 'failure', failureCode: code, value: LOCKED }).kind === 'excluded'))
ok('reading_excluded_for_unknown_code', reading({ status: 'failure', failureCode: 'not_in_the_closed_set', value: LOCKED }).kind === 'excluded')
ok('reading_rejected_is_excluded', reading({ status: 'rejected', failureCode: 'permission_denied', value: LOCKED }).kind === 'excluded')
ok('reading_cancelled_is_excluded', reading({ status: 'cancelled', failureCode: 'cancelled', value: LOCKED }).kind === 'excluded')
ok('reading_control_is_complete_and_has_no_value', (() => {
  const result = reading({ status: 'success', value: 'ready' })
  return result.kind === 'control' && result.complete === true && result.value === undefined
})())
ok('reading_excluded_is_never_complete', (() => {
  const result = reading({ status: 'failure', failureCode: 'permission_denied', value: LOCKED })
  return result.kind === 'excluded' && result.complete === false && result.value === undefined
})())

trajectory = `excluded=${String(WRITE_PRECONDITION_EXCLUDED_FAILURE_CODES.length)} candidate=${String(withControl.kind)} refuted=${String(refuted.kind)}`
console.log(`ADR-151 步骤C门（形成来源·决策逻辑）：${String(checks)} 项检查全部通过（零模型）。${trajectory}`)