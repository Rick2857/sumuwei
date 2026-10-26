/**
 * **ADR-151 步骤 A 的门**：规则表达（`write_requires_condition` + `write_precondition_holds`）。
 *
 * 零模型、零数据库、零文件系统：只验**闭集与形状**。
 * 断言的是"能被接受什么 / 必须被拒绝什么"，**不**验解释器（那是步骤 D）。
 */
import assert from 'node:assert/strict'
import {
  TRANSITION_RULE_KINDS, WRITE_REQUIREMENT_KEYS, transitionRuleId, validateRestrictedTransitionRule, validateWriteRequirement,
} from '../../src/kernel/contracts/world-model-transition.ts'
import { EBL_TOOL_PREDICATES } from '../../src/kernel/contracts/epistemic-belief.ts'

let checks = 0
let trajectory = ''
const ok = (label: string, condition: boolean) => { assert.ok(condition, label); checks += 1 }
const throws = (fn: () => unknown, code: string): boolean => {
  try { fn(); return false } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const actual = (error as { code?: unknown }).code
    return message.includes(code) || actual === code
  }
}

const binding = { claimId: 'ebl:test', ruleVersion: 'v1', evidenceFingerprint: 'fp-1' }
const base = { version: 'v1', action: { capability: 'sandbox.file.write', operation: 'write' }, conditions: { encoding: 'utf8' }, binding }
const newRule = () => ({ ...base, kind: 'write_requires_condition', requires: { conditionPath: 'f1-guard.txt', mustNotEqual: 'locked' } })
const oldRule = () => ({ ...base, kind: 'write_then_read_same_bytes' })

// ---------------------------------------------------------------------------
// ① 闭集
// ---------------------------------------------------------------------------
ok('kind_set_has_exactly_two', TRANSITION_RULE_KINDS.length === 2
  && TRANSITION_RULE_KINDS.includes('write_then_read_same_bytes') && TRANSITION_RULE_KINDS.includes('write_requires_condition'))
ok('requirement_keys_closed', WRITE_REQUIREMENT_KEYS.length === 2
  && WRITE_REQUIREMENT_KEYS.includes('conditionPath') && WRITE_REQUIREMENT_KEYS.includes('mustNotEqual'))

// ---------------------------------------------------------------------------
// ② 接受：枚举形状
// ---------------------------------------------------------------------------
const accepted = validateRestrictedTransitionRule(newRule())
ok('accepts_enumerated_shape', accepted.kind === 'write_requires_condition'
  && accepted.requires?.conditionPath === 'f1-guard.txt' && accepted.requires?.mustNotEqual === 'locked')
ok('id_is_content_addressed', typeof accepted.id === 'string' && accepted.id.startsWith('wmt:'))
ok('old_kind_still_accepted', validateRestrictedTransitionRule(oldRule()).kind === 'write_then_read_same_bytes')
ok('old_kind_has_no_requires', validateRestrictedTransitionRule(oldRule()).requires === undefined)

// ---------------------------------------------------------------------------
// ③ 拒绝：额外字段 / 表达式 / 缺字段 / 旧种类带 requires / 未知种类
// ---------------------------------------------------------------------------
ok('rejects_extra_key', throws(() => validateRestrictedTransitionRule({
  ...newRule(), requires: { ...newRule().requires, operator: 'gt' },
}), 'transition_rule_requires_extra_keys'))
ok('rejects_expression_object', throws(() => validateRestrictedTransitionRule({
  ...newRule(), requires: { expr: 'guard === locked' },
}), 'transition_rule_requires_extra_keys'))
ok('rejects_non_string_path', throws(() => validateRestrictedTransitionRule({
  ...newRule(), requires: { conditionPath: 42, mustNotEqual: 'locked' },
}), 'transition_rule_requires_bad_path'))
ok('rejects_non_string_value', throws(() => validateRestrictedTransitionRule({
  ...newRule(), requires: { conditionPath: 'f1-guard.txt', mustNotEqual: null },
}), 'transition_rule_requires_bad_value'))
ok('rejects_missing_requires', throws(() => validateRestrictedTransitionRule({
  ...base, kind: 'write_requires_condition',
}), 'transition_rule_missing_requires'))
ok('rejects_requires_on_old_kind', throws(() => validateRestrictedTransitionRule({
  ...oldRule(), requires: { conditionPath: 'f1-guard.txt', mustNotEqual: 'locked' },
}), 'transition_rule_unexpected_requires'))
ok('rejects_unknown_kind', throws(() => validateRestrictedTransitionRule({
  ...base, kind: 'write_always_succeeds',
}), 'transition_rule_bad_kind'))
ok('direct_validator_rejects_old_kind_requires', throws(() => validateWriteRequirement('write_then_read_same_bytes', { conditionPath: 'a', mustNotEqual: 'b' }),
  'transition_rule_unexpected_requires'))

// ---------------------------------------------------------------------------
// ④ 否定条件进**内容寻址**：条件变 ⇒ id 必须变
// ---------------------------------------------------------------------------
const otherValue = validateRestrictedTransitionRule({ ...newRule(), requires: { conditionPath: 'f1-guard.txt', mustNotEqual: 'blocked' } })
const otherPath = validateRestrictedTransitionRule({ ...newRule(), requires: { conditionPath: 'other-guard.txt', mustNotEqual: 'locked' } })
ok('id_changes_with_value', otherValue.id !== accepted.id)
ok('id_changes_with_path', otherPath.id !== accepted.id && otherPath.id !== otherValue.id)
ok('id_stable_for_same_content', transitionRuleId({ ...newRule() } as never) === accepted.id)

// ---------------------------------------------------------------------------
// ⑤ 谓词闭集（**单一事实源**：`EBL_TOOL_PREDICATES`）
// ---------------------------------------------------------------------------
ok('new_predicate_in_tool_set', (EBL_TOOL_PREDICATES as readonly string[]).includes('write_precondition_holds'))
ok('existing_predicates_kept', (EBL_TOOL_PREDICATES as readonly string[]).includes('readback_matches')
  && (EBL_TOOL_PREDICATES as readonly string[]).includes('document_extracts'))
ok('tool_set_closed_at_three', EBL_TOOL_PREDICATES.length === 3)
ok('unknown_predicate_not_in_tool_set', !(EBL_TOOL_PREDICATES as readonly string[]).includes('write_always_holds'))
trajectory = `kind=${TRANSITION_RULE_KINDS.join('|')} requires=${WRITE_REQUIREMENT_KEYS.join('|')} id=${accepted.id.slice(0, 12)}…`
console.log(`ADR-151 步骤A门（规则表达）：${String(checks)} 项检查全部通过（零模型）。${trajectory}`)
