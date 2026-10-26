/**
 * **ADR-151 步骤 D 的门**：**否决真值表**与**规则翻译**（零模型 · 零数据库 · 零文件系统）。
 *
 * 它证明的是**判定逻辑**：
 * ① **否决真值表**（六行，方向不许写反）；
 * ② **规则翻译**（族作用域命题 → `write_requires_condition` 规则，含内容寻址）；
 * ③ **候选过滤**（只否决执行写的候选；全部被否决 ⇒ 不许记成目标达成；与候选顺序无关）；
 * ④ **规划后、执行前规则失效** ⇒ 计划被拒（既有 `verifyPlanRulesStillUsable`）。
 *
 * ⚠️ 本门**不**证明产品链跑得通（那是步骤 D 的**集成门**：
 *    `scripts/cognitive/f1-precondition-veto-integration-verify.ts`，隔离 PostgreSQL + 真实 Gateway）。
 */
import assert from 'node:assert/strict'
import {
  applyPreconditionVeto, decideWritePreconditionVeto,
  WRITE_PRECONDITION_VETO_REASONS, type WritePreconditionVetoDecision,
} from '../../src/kernel/contracts/write-precondition.ts'
import { sandboxWriteFamilyScope } from '../../src/kernel/contracts/write-family.ts'
import { buildTransitionRule } from '../../src/infrastructure/runtime/world-model-transition.ts'
import { verifyPlanRulesStillUsable } from '../../src/kernel/contracts/cognitive-collaboration.ts'
import type { UsableRuleSnapshot } from '../../src/kernel/contracts/cognitive-collaboration.ts'

let checks = 0
const ok = (label: string, condition: boolean) => { assert.ok(condition, label); checks += 1 }

const FAMILY = 'f1/a'
const SCOPE = sandboxWriteFamilyScope(FAMILY)
const CONDITION_PATH = 'f1-guard.txt'
const LOCKED = 'locked'
const READY = 'ready'
const RULE = {
  id: 'wmt:rule-demo',
  version: 'ebl:demo',
  scope: SCOPE,
  requires: { conditionPath: CONDITION_PATH, mustNotEqual: LOCKED },
}

/** 一次判定（只把真值表的那几个输入摆出来）。 */
const decide = (input: {
  enabled?: boolean
  rule?: typeof RULE
  targetFamilyId?: string
  conditionValue?: string
  conditionSource?: string
}): WritePreconditionVetoDecision => decideWritePreconditionVeto({
  enabled: input.enabled !== false,
  ...(input.rule === undefined ? {} : { rule: input.rule }),
  ...(input.targetFamilyId === undefined ? {} : { targetFamilyId: input.targetFamilyId }),
  ...(input.conditionValue === undefined ? {} : { conditionValue: input.conditionValue }),
  ...(input.conditionSource === undefined ? {} : { conditionSource: input.conditionSource }),
})

// ---------------------------------------------------------------------------
// ① **否决真值表**（六行；方向：观测值 == mustNotEqual 才否决）
// ---------------------------------------------------------------------------
ok('veto_reasons_closed_set', WRITE_PRECONDITION_VETO_REASONS.length === 6)
const switchedOff = decide({ enabled: false, rule: RULE, targetFamilyId: FAMILY, conditionValue: LOCKED })
ok('switch_off_never_vetoes', switchedOff.veto === false && switchedOff.reason === 'switch_off')
const noRule = decide({ targetFamilyId: FAMILY, conditionValue: LOCKED })
ok('no_qualified_rule_never_vetoes', noRule.veto === false && noRule.reason === 'rule_not_qualified')
const wrongFamily = decide({ rule: RULE, targetFamilyId: 'f1/b', conditionValue: LOCKED })
ok('family_mismatch_never_vetoes', wrongFamily.veto === false && wrongFamily.reason === 'family_mismatch')
const unknown = decide({ rule: RULE, targetFamilyId: FAMILY })
ok('condition_unknown_never_vetoes', unknown.veto === false && unknown.reason === 'condition_unknown')
const satisfied = decide({ rule: RULE, targetFamilyId: FAMILY, conditionValue: READY })
ok('condition_satisfied_never_vetoes', satisfied.veto === false && satisfied.reason === 'condition_not_violated')
const violated = decide({ rule: RULE, targetFamilyId: FAMILY, conditionValue: LOCKED, conditionSource: 'act:read-1' })
ok('condition_violated_vetoes', violated.veto === true && violated.reason === 'precondition_violated')
ok('veto_records_rule_and_source', violated.ruleId === RULE.id && violated.ruleVersion === RULE.version
  && violated.conditionPath === CONDITION_PATH && violated.conditionSource === 'act:read-1'
  && violated.observedValue === LOCKED)
ok('no_family_never_vetoes', decide({ rule: RULE, conditionValue: LOCKED }).veto === false)
// ⚠️ **方向**：条件**成立**（值 ≠ mustNotEqual）⇒ 不否决；**被违反**（值 == mustNotEqual）⇒ 否决。
ok('direction_not_inverted', satisfied.veto === false && violated.veto === true)

// ---------------------------------------------------------------------------
// ② **规则翻译**（族作用域命题 → `write_requires_condition`）
// ---------------------------------------------------------------------------
const snapshot = (overrides: Partial<UsableRuleSnapshot> = {}): UsableRuleSnapshot => ({
  claimId: 'ebl:demo', predicate: 'write_precondition_holds', expected: true, claimVersion: 1,
  policy: 'epistemic-policy@3', subjectId: 'Alex', scope: SCOPE, environment: 'sandbox-filesystem@1',
  conditions: { condition_path: CONDITION_PATH, must_not_equal: LOCKED },
  ruleVersion: 'ebl:demo', sources: [], evidenceFingerprint: 'fp', status: 'validated', usable: true,
  ...overrides,
})
const translated = buildTransitionRule(snapshot())
ok('precondition_claim_translates', 'rule' in translated)
if ('rule' in translated) {
  const rule = translated.rule
  ok('translated_kind_is_new_kind', rule.kind === 'write_requires_condition')
  ok('translated_action_is_the_write', rule.action.capability === 'sandbox.file.write' && rule.action.operation === 'write')
  ok('translated_requires_carries_shape', rule.requires?.conditionPath === CONDITION_PATH && rule.requires?.mustNotEqual === LOCKED)
  ok('translated_has_no_extra_conditions', Object.keys(rule.conditions).length === 0)
  ok('translated_binds_claim_version_fingerprint', rule.binding.claimId === 'ebl:demo'
    && rule.binding.ruleVersion === 'ebl:demo' && rule.binding.evidenceFingerprint === 'fp')
  const other = buildTransitionRule(snapshot({ conditions: { condition_path: 'other.txt', must_not_equal: LOCKED } }))
  ok('translated_id_is_content_addressed',
    'rule' in other && other.rule.id !== rule.id)
  const changed = buildTransitionRule(snapshot({ conditions: { condition_path: CONDITION_PATH, must_not_equal: READY } }))
  ok('translated_id_changes_with_value',
    'rule' in changed && changed.rule.id !== rule.id)
}
ok('unusable_snapshot_is_not_translated', !('rule' in buildTransitionRule(snapshot({ usable: false, status: 'suspended' }))))
ok('non_family_scope_is_not_translated', !('rule' in buildTransitionRule(snapshot({ scope: 'sandbox_readback' }))))
ok('bad_condition_shape_is_not_translated', !('rule' in buildTransitionRule(snapshot({ conditions: { encoding: 'utf8' } }))))
ok('other_predicate_still_uses_readback_kind', (() => {
  const other = buildTransitionRule(snapshot({ predicate: 'readback_matches', scope: 'sandbox_readback', conditions: { encoding: 'utf8' } }))
  return 'rule' in other && other.rule.kind === 'write_then_read_same_bytes'
})())

// ---------------------------------------------------------------------------
// ③ **候选过滤**（只否决执行写的候选；全否决 ⇒ 不许记成目标达成；与顺序无关）
// ---------------------------------------------------------------------------
const candidates = [
  { id: '0', writes: true },
  { id: '1', writes: true },
  { id: '2', writes: false },
]
const filter = applyPreconditionVeto({ decision: violated, candidates, writesIntoFamily: item => item.writes })
ok('veto_removes_writing_candidates', filter.eligible.map(item => item.id).join(',') === '2'
  && filter.vetoed.map(item => item.id).join(',') === '0,1')
ok('all_vetoed_means_empty_eligible', (() => {
  const onlyWrites = candidates.filter(item => item.writes)
  const result = applyPreconditionVeto({ decision: violated, candidates: onlyWrites, writesIntoFamily: item => item.writes })
  return result.eligible.length === 0 && result.vetoed.length === onlyWrites.length
})())
ok('no_veto_keeps_every_candidate', (() => {
  const result = applyPreconditionVeto({ decision: satisfied, candidates, writesIntoFamily: item => item.writes })
  return result.eligible.length === candidates.length && result.vetoed.length === 0
})())
ok('veto_is_independent_of_candidate_order', (() => {
  const permuted = [...candidates].reverse()
  const result = applyPreconditionVeto({ decision: violated, candidates: permuted, writesIntoFamily: item => item.writes })
  return result.vetoed.map(item => item.id).sort().join(',') === '0,1'
    && result.eligible.map(item => item.id).join(',') === '2'
})())

// ---------------------------------------------------------------------------
// ④ **规划后、执行前规则失效** ⇒ 计划被拒（既有纪律，不新造）
// ---------------------------------------------------------------------------
const snapshotPort = (usable: boolean, status: string) => ({
  async current (claimId: string) {
    return claimId === 'ebl:demo'
      ? { ...snapshot(), usable, status, ...(usable ? {} : { invalidatedReason: 'not_usable' as const }) }
      : undefined
  },
  async list () { return [] },
})
const dependency = { claimId: 'ebl:demo', ruleVersion: 'ebl:demo', evidenceFingerprint: 'fp' }
ok('plan_is_allowed_while_rule_is_usable',
  (await verifyPlanRulesStillUsable({ dependencies: [dependency], snapshot: snapshotPort(true, 'validated') })).ok === true)
const invalidated = await verifyPlanRulesStillUsable({ dependencies: [dependency], snapshot: snapshotPort(false, 'suspended') })
ok('plan_is_refused_after_rule_invalidated', invalidated.ok === false && invalidated.reason === 'not_usable')

console.log(`F1 步骤D门（否决真值表·规则翻译）：${String(checks)} 项检查全部通过（零模型）。`
  + `veto=${String(violated.reason)} no_veto=${String(satisfied.reason)} unknown=${String(unknown.reason)}`)
