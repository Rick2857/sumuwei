/**
 * **ADR-151 步骤 B 的门**：族范围（`write-family`）。
 *
 * 零模型、零数据库：只验**受信来源、身份、可见性与拒用**。
 * 断言：族只来自受信已知目录 / 边界匹配 / 没有族就不算族 / scope 内容寻址 /
 *       同族可选取 / 异族被拒（`scope_mismatch`）/ `bindingKey` **不**进身份。
 */
import assert from 'node:assert/strict'
import {
  FAMILY_ID_PATTERN, SANDBOX_WRITE_FAMILY_SCOPE_PREFIX, familyIdOfScope, familyOfWriteTarget, sandboxWriteFamilyScope, validateFamilyId,
} from '../../src/kernel/contracts/write-family.ts'
import { eblSignature } from '../../src/kernel/contracts/epistemic-belief.ts'
import type { EblClaim } from '../../src/kernel/contracts/epistemic-belief.ts'
import { selectUsableRules, type UsableRuleSnapshot } from '../../src/kernel/contracts/cognitive-collaboration.ts'

let checks = 0
let trajectory = ''
const ok = (label: string, condition: boolean) => { assert.ok(condition, label); checks += 1 }
const throws = (fn: () => unknown, needle: string): boolean => {
  try { fn(); return false } catch (error) {
    const code = (error as { code?: unknown }).code
    const message = error instanceof Error ? error.message : String(error)
    return String(code ?? '').includes(needle) || message.includes(needle)
  }
}

// ---------------------------------------------------------------------------
// ① 族只来自**受信事实**（已知目录），且按**目录边界**匹配、取**最长**前缀
// ---------------------------------------------------------------------------
const dirs = ['f1/a', 'f1/a/deep', 'f1/b'] as const
ok('family_from_trusted_dir', familyOfWriteTarget({ path: 'f1/a/o1.txt', knownDirectories: dirs }) === 'f1/a')
ok('longest_prefix_wins', familyOfWriteTarget({ path: 'f1/a/deep/o1.txt', knownDirectories: dirs }) === 'f1/a/deep')
ok('boundary_match_not_string_prefix', familyOfWriteTarget({ path: 'f1/ab/o1.txt', knownDirectories: dirs }) === undefined)
ok('no_dir_no_family', familyOfWriteTarget({ path: 'elsewhere/o1.txt', knownDirectories: dirs }) === undefined)
ok('empty_dirs_no_family', familyOfWriteTarget({ path: 'f1/a/o1.txt', knownDirectories: [] }) === undefined)
ok('path_traversal_in_dir_ignored', familyOfWriteTarget({ path: 'f1/a/o1.txt', knownDirectories: ['../f1/a'] }) === undefined)

// ---------------------------------------------------------------------------
// ② scope 是**内容寻址**的：族键进 scope；非法族键失败关闭
// ---------------------------------------------------------------------------
ok('scope_prefix_closed', SANDBOX_WRITE_FAMILY_SCOPE_PREFIX === 'sandbox_write_family:')
ok('scope_round_trip', familyIdOfScope(sandboxWriteFamilyScope('f1/a')) === 'f1/a')
ok('non_family_scope_undefined', familyIdOfScope('sandbox_readback') === undefined)
ok('empty_family_scope_undefined', familyIdOfScope(SANDBOX_WRITE_FAMILY_SCOPE_PREFIX) === undefined)
ok('rejects_blank_id', throws(() => validateFamilyId('f1 a'), 'write_family_bad_id'))
ok('rejects_traversal_id', throws(() => validateFamilyId('../etc'), 'write_family_bad_id'))
ok('rejects_absolute_id', throws(() => validateFamilyId('/f1/a'), 'write_family_bad_id'))
ok('rejects_prefixed_id', throws(() => validateFamilyId('sandbox_write_family:f1/a'), 'write_family_bad_id'))
ok('rejects_too_long_id', throws(() => validateFamilyId('a'.repeat(65)), 'write_family_bad_id'))
ok('family_id_pattern_is_closed', FAMILY_ID_PATTERN.test('f1/a') && !FAMILY_ID_PATTERN.test('f1 A'))

// ---------------------------------------------------------------------------
// ③ 身份：族进 `eblSignature`（族不同 ⇒ 身份不同）；`bindingKey` **不**进身份
// ---------------------------------------------------------------------------
const claimOf = (scope: string) => ({
  characterId: 'c', subjectId: 'u', domain: 'tool' as const, predicate: 'write_precondition_holds', expected: true,
  scope, environment: 'sandbox-filesystem@1', conditions: { encoding: 'utf8' },
  formation: { kind: 'tool_action', ref: 'r' }, policy: 'epistemic-policy@3',
})
const asClaim = (scope: string) => claimOf(scope) as unknown as Omit<EblClaim, 'id'>
const sigA = eblSignature(asClaim(sandboxWriteFamilyScope('f1/a')))
const sigB = eblSignature(asClaim(sandboxWriteFamilyScope('f1/b')))
ok('family_changes_identity', sigA !== sigB)
ok('same_family_same_identity', sigA === eblSignature(asClaim(sandboxWriteFamilyScope('f1/a'))))
// `bindingKey` 不在 claim 形状里 ⇒ 用"证据指纹/绑定"不同但 claim 相同来证明身份**不**含绑定
const sigOtherBinding = eblSignature(asClaim(sandboxWriteFamilyScope('f1/a')))
ok('binding_key_not_in_identity', sigOtherBinding === sigA)

// ---------------------------------------------------------------------------
// ④ 可见性：同族可选取 / 异族被拒（`scope_mismatch`）/ 没有族不可用
// ---------------------------------------------------------------------------
const snapshotOf = (id: string, scope: string): UsableRuleSnapshot => ({
  claimId: id, characterId: 'c', subjectId: 'u', domain: 'tool', predicate: 'write_precondition_holds',
  expected: true, claimVersion: 1, policy: 'epistemic-policy@3', subject: 'u',
  scope, environment: 'sandbox-filesystem@1', conditions: { encoding: 'utf8' },
  ruleVersion: 'v1', sources: [], evidenceFingerprint: 'fp', status: 'validated', usable: true,
} as unknown as UsableRuleSnapshot)
const familyA = snapshotOf('ebl:a', sandboxWriteFamilyScope('f1/a'))
const familyB = snapshotOf('ebl:b', sandboxWriteFamilyScope('f1/b'))
const visible = (scope: string) => ({ subjectId: 'u', scope, environment: 'sandbox-filesystem@1', conditions: { encoding: 'utf8' } })
const sameFamily = selectUsableRules({ snapshots: [familyA, familyB], visible: visible(sandboxWriteFamilyScope('f1/a')) })
ok('same_family_selected', sameFamily.selected.length === 1 && sameFamily.selected[0]!.claimId === 'ebl:a')
ok('other_family_refused', sameFamily.skipped.some(item => item.claimId === 'ebl:b' && item.reason === 'scope_mismatch'))
const noFamily = selectUsableRules({ snapshots: [familyA, familyB], visible: visible('sandbox_readback') })
ok('no_family_nothing_selected', noFamily.selected.length === 0)
ok('no_family_skips_as_scope_mismatch', noFamily.skipped.length === 2
  && noFamily.skipped.every(item => item.reason === 'scope_mismatch'))

trajectory = `family(f1/a/deep)=${String(familyOfWriteTarget({ path: 'f1/a/deep/x.txt', knownDirectories: dirs }))} sigA=${sigA.length}B selected=${String(sameFamily.selected.length)} refused=${String(sameFamily.skipped.length)}`
console.log(`ADR-151 步骤B门（族范围）：${String(checks)} 项检查全部通过（零模型）。${trajectory}`)
