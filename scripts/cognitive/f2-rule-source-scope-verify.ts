/*
 * F2 最小接点 R1 门：**来源作用域**（纯函数 · 零模型请求 · 零数据库）。
 *
 * 必须证明：
 *  ① 合法来源作用域通过；**非法值被拒**（闭集、失败关闭）
 *  ② **缺省 = 不限来源**，旧规则行为**逐字不变**（构造结果与 id 都与未加该字段时一致）
 *  ③ ⚠️ **只差来源的两条规则必须是不同的 id**（内容寻址必须包含来源）
 *  ④ 来源作用域**不改变** `requires` 的两键闭集（不把来源塞进 requires）
 */
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  transitionRuleId,
  validateRestrictedTransitionRule,
  validateWriteRequirement,
  WRITE_SOURCE_SCOPES,
} from '../../src/kernel/contracts/world-model-transition.ts'

const OUT_DIR = resolve('artifacts/local/f2-rule-source-scope')
const base = {
  version: 'v1',
  kind: 'write_requires_condition' as const,
  action: { capability: 'sandbox.file.write', operation: 'write' },
  conditions: { family: 'f1/a' },
  requires: { conditionPath: 'f1/a/.freshness', mustNotEqual: 'stale' },
  binding: { claimId: 'claim-1', ruleVersion: 'v1', evidenceFingerprint: 'fp-evidence' },
}

const checks: Array<{ label: string, pass: boolean, detail: string }> = []
const check = (label: string, pass: boolean, detail = ''): void => {
  checks.push({ label, pass, detail })
  assert.ok(pass, `${label}${detail === '' ? '' : ` — ${detail}`}`)
}

check('① 来源作用域闭集恰好两个（cache / authoritative）',
  WRITE_SOURCE_SCOPES.length === 2 && WRITE_SOURCE_SCOPES[0] === 'cache' && WRITE_SOURCE_SCOPES[1] === 'authoritative')

// ① 合法值通过
const cacheScoped = validateRestrictedTransitionRule({ ...base, sourceScope: 'cache' })
check('①b 合法来源作用域（cache）通过并保留', cacheScoped.sourceScope === 'cache')

// ①c 非法值被拒
let badRejected = false
try { validateRestrictedTransitionRule({ ...base, sourceScope: 'trusted' }) } catch { badRejected = true }
check('①c 非法来源作用域（闭集外）**被拒**', badRejected)

// ② 缺省 = 不限来源；旧规则逐字不变
const noScope = validateRestrictedTransitionRule({ ...base })
check('② 缺省不写 sourceScope（undefined）⇒ 与未加该字段时**结构一致**',
  noScope.sourceScope === undefined &&
  Object.keys(noScope).sort().join(',') === ['action', 'binding', 'conditions', 'id', 'kind', 'requires', 'version'].sort().join(','))
const legacyId = transitionRuleId({ ...base })
check('②b 旧规则（无来源）的 id 与**不含该字段的旧材料**一致（内容寻址未变）',
  noScope.id === 'wmt:62b3e4f6754e5436' && legacyId === 'wmt:62b3e4f6754e5436', `id=${legacyId}`)

// ③ 只差来源 ⇒ 不同 id
const cacheId = validateRestrictedTransitionRule({ ...base, sourceScope: 'cache' }).id
const authId = validateRestrictedTransitionRule({ ...base, sourceScope: 'authoritative' }).id
check('③ ⚠️ 只差**来源作用域**的两条规则**必须是不同 id**（内容寻址包含来源）',
  cacheId !== authId && noScope.id !== cacheId && noScope.id !== authId,
  `none=${noScope.id.slice(0, 12)} cache=${cacheId.slice(0, 12)} auth=${authId.slice(0, 12)}`)

// ③b 同来源 ⇒ 同 id（幂等）
check('③b 同来源 ⇒ 同 id（内容寻址稳定）',
  validateRestrictedTransitionRule({ ...base, sourceScope: 'cache' }).id === cacheId)

// ④ requires 仍是两键闭集；来源不得塞进 requires
let requiresKeyRejected = false
try {
  validateWriteRequirement('write_requires_condition', { conditionPath: 'f1/a/.freshness', mustNotEqual: 'stale', sourceScope: 'cache' } as never)
} catch { requiresKeyRejected = true }
check('④ 来源**不得**塞进 `requires`（仍只允许两键；额外字段硬拒）', requiresKeyRejected)

mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(resolve(OUT_DIR, 'verification.json'), `${JSON.stringify({
  schema: 'f2-rule-source-scope-gate@1',
  status: 'PASS',
  checks,
  boundaries: [
    '本门是**契约门**（纯函数、零模型、零数据库、零文件系统）',
    '它证明来源作用域的**形状/内容寻址/向后兼容**；**不**证明否决谓词已按归属生效（那是 R2，仍未接）',
  ],
}, null, 2)}\n`, 'utf8')
console.log(`F2 最小接点 R1 门：${String(checks.length)} 项检查全部通过（零模型请求）`)
for (const item of checks) console.log(`PASS ${item.label}${item.detail === '' ? '' : ` — ${item.detail}`}`)
