/*
 * F2 最小接点 R4 门：**逐路径授权**（纯函数 · 零模型请求 · 零数据库）。
 *
 * 必须证明：
 *  ① 只读路径（缓存源 / 权威源）可读；**写源文件被拒**
 *  ② 限次读（族级标记）**执行前计数**、第二次被拒；**写标记被拒**
 *  ③ 可写路径（目标）可写、可读回；**其它路径读写都拒**
 *  ④ **重挂不能扩大范围、不能重置计数**（幂等且不可扩）
 *  ⑤ **缺省不挂** ⇒ 不产生任何限制（旧入口行为逐字不变）
 */
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  applySourceScopedPaths,
  createTaskAuthorizationRegistry,
  type TaskAuthorization,
} from '../../src/kernel/action/task-authorization.ts'

const OUT_DIR = resolve('artifacts/local/f2-source-scope-auth')
const CACHE = 'f1/a/obj-01.cache'
const SOURCE = 'f1/a/obj-01.src'
const MARKER = 'f1/a/.freshness'
const TARGET = 'f1/a/obj-01.txt'
const OTHER = 'f1/a/obj-02.txt'

const checks: Array<{ label: string, pass: boolean, detail: string }> = []
const check = (label: string, pass: boolean, detail = ''): void => {
  checks.push({ label, pass, detail })
  assert.ok(pass, `${label}${detail === '' ? '' : ` — ${detail}`}`)
}

const registry = createTaskAuthorizationRegistry({})
let seq = 0
const open = (): TaskAuthorization => registry.issue({
  conversationKey: 'scope-test',
  originalText: 'F2 任务（逐路径授权门）',
  triggeringEventId: `evt-${String(++seq)}`,
  allowedCapabilities: ['sandbox.file.read', 'sandbox.file.write'],
  maxRiskLevel: 'low' as never,
})

const scope = { readOnly: [CACHE, SOURCE], limitedReads: [{ path: MARKER, maxReads: 1 }], writable: [TARGET] } as const

/**
 * 与任务环里同一条判定（**镜像**）：写 ⇒ 只许可写路径；读 ⇒ 只读 / 限次 / 可写(读回)；其它 ⇒ 拒。
 * 返回 'allow' | 'deny' | 'limit'，并在限次读时调用 registry 计数（**执行前**）。
 */
const step = (task: TaskAuthorization, operation: 'read' | 'write', path: string): 'allow' | 'deny' | 'limit' => {
  const scoped = task.sourceScopedPaths
  if (scoped === undefined) return 'allow'
  const inReadOnly = scoped.readOnly.includes(path)
  const limited = scoped.limitedReads.find(item => item.path === path)
  const inWritable = scoped.writable.includes(path)
  const allowed = operation === 'write' ? inWritable : (inReadOnly || inWritable || limited !== undefined)
  if (!allowed) return 'deny'
  if (operation === 'read' && limited !== undefined && !inReadOnly && !inWritable) {
    return registry.noteSourceScopedRead(task.taskId, path) ? 'allow' : 'limit'
  }
  return 'allow'
}

// ⑤ 缺省不挂 ⇒ 无限制（旧行为）
const plain = open()
check('⑤ 未挂范围 ⇒ 任何路径都放行（旧入口行为逐字不变）',
  step(plain, 'read', OTHER) === 'allow' && step(plain, 'write', OTHER) === 'allow' && plain.sourceScopedPaths === undefined)

const task = open()
check('挂载成功（首次）', applySourceScopedPaths(task, scope) === true && task.sourceScopedPaths !== undefined)

// ① 只读路径可读；写源文件被拒
check('① 缓存源可读、权威源可读', step(task, 'read', CACHE) === 'allow' && step(task, 'read', SOURCE) === 'allow')
check('①b **写源文件被拒**', step(task, 'write', CACHE) === 'deny' && step(task, 'write', SOURCE) === 'deny')

// ② 限次读：执行前计数、第二次被拒；写标记被拒
check('② 族标记第一次可读（计数在执行前 +1）', step(task, 'read', MARKER) === 'allow')
check('②b 族标记**第二次被拒**（限次生效）', step(task, 'read', MARKER) === 'limit')
check('②c **写标记被拒**', step(task, 'write', MARKER) === 'deny')

// ③ 目标可写 + 可读回；其它路径拒绝
check('③ 目标可写', step(task, 'write', TARGET) === 'allow')
check('③b 目标可**读回**', step(task, 'read', TARGET) === 'allow')
check('③c 其它路径**读被拒**', step(task, 'read', OTHER) === 'deny')
check('③d 其它路径**写被拒**', step(task, 'write', OTHER) === 'deny')

// ④ 重挂：同范围幂等、扩大被拒且不改、计数不重置
const attemptsBefore = { ...task.sourceScopedPaths!.attempts }
check('④ 同范围重挂 ⇒ 幂等 true（保留计数）',
  applySourceScopedPaths(task, scope) === true &&
  JSON.stringify(task.sourceScopedPaths!.attempts) === JSON.stringify(attemptsBefore))
check('④b 扩大范围（多一个可读路径）⇒ **被拒**且原范围不变',
  applySourceScopedPaths(task, { ...scope, readOnly: [CACHE, SOURCE, OTHER] }) === false &&
  task.sourceScopedPaths!.readOnly.length === 2 && !task.sourceScopedPaths!.readOnly.includes(OTHER))
check('④c 扩大 maxReads（1→2）⇒ **被拒**且不改',
  applySourceScopedPaths(task, { ...scope, limitedReads: [{ path: MARKER, maxReads: 2 }] }) === false &&
  task.sourceScopedPaths!.limitedReads[0]!.maxReads === 1)
check('④d 扩大可写路径 ⇒ **被拒**且不改',
  applySourceScopedPaths(task, { ...scope, writable: [TARGET, OTHER] }) === false &&
  !task.sourceScopedPaths!.writable.includes(OTHER))
check('④e **重挂不重置计数**：标记仍被拒（第二次读）', step(task, 'read', MARKER) === 'limit')

mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(resolve(OUT_DIR, 'verification.json'), `${JSON.stringify({
  schema: 'f2-source-scope-auth-gate@1',
  status: 'PASS',
  checks,
  boundaries: [
    '本门是**纯函数**门（镜像任务环的判定；零模型、零数据库、零文件系统）',
    '它证明逐路径授权的**语义与计数器/幂等性**；**不**证明真实 ActionTurn 主链已跑通（那是本批下一段）',
  ],
}, null, 2)}\n`, 'utf8')
console.log(`F2 最小接点 R4 门：${String(checks.length)} 项检查全部通过（零模型请求）`)
for (const item of checks) console.log(`PASS ${item.label}${item.detail === '' ? '' : ` — ${item.detail}`}`)
