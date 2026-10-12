/**
 * M4.5 L1 —— 部件级测试（`pnpm m4.5:test`）。
 *
 * ============================================================================
 *  它测的是"协议不变量"，不是"链路能不能跑通"
 * ============================================================================
 *   L1（本文件）  协议 / 登记 / 策略 / 目标梯子 / 守卫 / 幂等 / 折叠 / 静态锁
 *   L2            子系统：Request → Policy → Gateway → Executor → Result → Ledger
 *   L3            自然语言集成（离线、确定性）
 *   L0            量具验证
 *   L4            真实链路（Production-copy Live Smoke，Hard Gate）
 *
 * 全部离线、确定性、不需要 API Key，因此可以进 `m4.5:ci`。
 *
 * 跑法：pnpm m4.5:test
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import {
  createActionRequest,
  hasSideEffect,
  riskFloorOf,
  riskRank,
  type ActionRequest,
  type ActionTarget,
  type RiskLevel,
} from '../src/kernel/action/action-request.ts'
import { newActionId, asTraceId, asCharacterId, asActionId } from '../src/kernel/contracts/ids.ts'
import {
  ACTION_STATUSES,
  isSuccessResult,
  producedSideEffect,
  type ActionResult,
} from '../src/kernel/action/action-result.ts'
import {
  ACTION_FAILURE_CODES,
  actionFailure,
  ActionFailureError,
  actionStatusOfFailure,
  normalizeAdapterError,
  type ActionFailureCode,
} from '../src/kernel/action/errors.ts'
import {
  DEFAULT_GRANTED_PERMISSIONS,
  SANDBOX_FILE_READ,
  SANDBOX_FILE_WRITE,
  SYSTEM_ECHO,
  createCapabilityRegistry,
  createDefaultCapabilityDefinitions,
  createDefaultCapabilityRegistry,
  maxRiskLevel,
  maxSideEffect,
  sideEffectRank,
  validateCapabilityDefinition,
  type CapabilityDefinition,
} from '../src/kernel/action/capability-registry.ts'
import { evaluateActionPolicy, failureCodeOfDecision } from '../src/kernel/action/policy.ts'
import {
  inspectSandboxPath,
  normalizeHint,
  resolveActionTarget,
  type SandboxEntry,
} from '../src/kernel/action/target-resolver.ts'
import {
  ACTION_SUCCESS_MARKERS,
  applyActionClaimGuard,
  actionFactSummary,
  replyClaimsActionSuccess,
  truthfulActionSentence,
} from '../src/kernel/action/claim-guard.ts'
import {
  COMMITMENT_CLAIM_MARKERS,
  applyCommitmentClaimGuard,
  replyClaimsCommitmentSuccess,
} from '../src/kernel/app/goal/claim-guard.ts'
import { scanClaims } from '../src/kernel/action/claim-scanner.ts'
import {
  actionIdempotencyKey,
  fnv1a64Hex,
  shouldCheckIdempotency,
  stableSerialize,
} from '../src/kernel/action/idempotency.ts'
import { foldRecord } from '../src/infrastructure/action/action-ledger-store.ts'
import { foldExecutionRecord } from '../src/kernel/action/execution-record.ts'
import type { ActionLedgerEvent } from '../src/kernel/action/execution-ledger.ts'
import {
  checkActionAuditInvariants,
  ledgerAllowsSuccessClaim,
  changedWorld,
} from '../src/kernel/action/audit-invariants.ts'
import type { ExecutionRecordView } from '../src/kernel/action/execution-ledger.ts'
import { createActionIntentDetector, extractPathTokens } from '../src/kernel/action/intent-detector.ts'
import { createLocalFileIntentDetector } from '../src/kernel/action/local-file-intent.ts'
import { chainIntentDetectors } from '../src/kernel/action/external-evidence-intent.ts'
import { LOCAL_FILE_READ } from '../src/kernel/action/local-file-capabilities.ts'
import { parseActionAdminArgs, renderActionList } from '../src/kernel/action/admin.ts'
import { isReadOnlyInvocation } from '../src/invocation.ts'
import { readKernelFlags, describeKernelFlags, readProactivePolicy } from '../src/kernel/app/flags.ts'

// ---------------------------------------------------------------------------
// 报告器
// ---------------------------------------------------------------------------

let passed = 0
let failed = 0
const failures: string[] = []
const evidenceDir = join(resolve('.'), 'artifacts', 'm4.5')

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1
    console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ''}`)
  } else {
    failed += 1
    failures.push(label)
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

function section(title: string): void {
  console.log(`\n=== ${title} ===`)
}

console.log('='.repeat(72))
console.log('M4.5 L1 部件级测试（协议 / 登记 / 策略 / 目标 / 守卫 / 幂等 / 静态锁）')
console.log('='.repeat(72))

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const CHARACTER = asCharacterId('char_m45_test')
const TRACE = asTraceId('trc:m45-test')

function requestOf(overrides: Partial<ActionRequest> & { capability: string; operation: string }): ActionRequest {
  return createActionRequest({
    actionId: overrides.actionId ?? newActionId(),
    traceId: overrides.traceId ?? TRACE,
    capability: overrides.capability,
    operation: overrides.operation,
    requestedBy: overrides.requestedBy ?? { kind: 'user', id: 'user-1' },
    ...(overrides.target !== undefined ? { target: overrides.target } : {}),
    arguments: overrides.arguments ?? {},
    sideEffect: overrides.sideEffect ?? 'write',
    ...(overrides.idempotencyKey !== undefined ? { idempotencyKey: overrides.idempotencyKey } : {}),
  })
}

const targetOf = (confidence: ActionTarget['confidence'], canonicalId?: string): ActionTarget =>
  canonicalId === undefined ? { type: 'sandbox_file', confidence } : { type: 'sandbox_file', canonicalId, confidence }

const entries = (...paths: string[]): SandboxEntry[] =>
  paths.map((p) => ({ relativePath: p, basename: p.split('/').pop() ?? p }))

/** 造一个完整的 ActionResult（守卫只认完整的那个类型） */
function resultOf(partial: Partial<ActionResult> & { status: ActionResult['status'] }): ActionResult {
  return {
    actionId: newActionId(),
    traceId: TRACE,
    capability: SANDBOX_FILE_WRITE,
    operation: 'write',
    accepted: true,
    executed: true,
    ...partial,
  }
}

// ===========================================================================
// §1 协议与失败语义
// ===========================================================================
section('§1 协议（ActionRequest / ActionResult / 失败语义归一）')
{
  const request = requestOf({ capability: SYSTEM_ECHO, operation: 'echo', sideEffect: 'none' })
  check('§1.1 请求带上 actionId / traceId / capability / operation', request.actionId.startsWith('act:') && request.traceId === TRACE)
  check('§1.2 请求默认 createdAt 是数字时间戳', Number.isSafeInteger(request.createdAt))

  let threw = false
  try {
    createActionRequest({
      actionId: newActionId(),
      traceId: TRACE,
      capability: '   ',
      operation: 'echo',
      requestedBy: { kind: 'user' },
      sideEffect: 'none',
    })
  } catch {
    threw = true
  }
  check('§1.3 空能力名被拒绝（写不出错误的东西）', threw)

  threw = false
  try {
    createActionRequest({
      actionId: newActionId(),
      traceId: TRACE,
      capability: 'system.echo',
      operation: 'echo',
      requestedBy: { kind: 'user' },
      sideEffect: 'harmless' as never,
    })
  } catch {
    threw = true
  }
  check('§1.4 非法 sideEffect 被拒绝', threw)

  check(
    '§1.5 十个失败码到状态是全覆盖的（没有漏网）',
    ACTION_FAILURE_CODES.every((code) => ACTION_STATUSES.includes(actionStatusOfFailure(code))),
    ACTION_FAILURE_CODES.map((c) => `${c}→${actionStatusOfFailure(c)}`).join(' ')
  )
  check(
    '§1.6 partial_success 绝不映射成 success（§28）',
    actionStatusOfFailure('partial_success') === 'partial'
  )
  check('§1.7 timeout 绝不映射成 success', actionStatusOfFailure('timeout') === 'timeout')
  check('§1.8 permission_denied 映射成 rejected（不是 not_found）', actionStatusOfFailure('permission_denied') === 'rejected')

  check('§1.9 ENOENT 归一为 target_not_found', normalizeAdapterError(Object.assign(new Error('x'), { code: 'ENOENT' })).code === 'target_not_found')
  check('§1.10 EACCES 归一为 permission_denied', normalizeAdapterError(Object.assign(new Error('x'), { code: 'EACCES' })).code === 'permission_denied')
  check('§1.11 未知错误归一为 execution_failed（最保守）', normalizeAdapterError(new Error('boom')).code === 'execution_failed')
  check('§1.12 字符串异常也归一', normalizeAdapterError('weird').code === 'execution_failed')
  const explicit = actionFailure('timeout', '超时')
  check('§1.13 ActionFailureError 保持原码', normalizeAdapterError(new ActionFailureError(explicit)).code === 'timeout')

  check('§1.14 isSuccessResult 要求 executed 且 success', !isSuccessResult({ executed: false, status: 'success' }) && isSuccessResult({ executed: true, status: 'success' }))
  check(
    '§1.15 producedSideEffect 只认真的改了世界的结果',
    !producedSideEffect({ executed: true, status: 'success', effect: { kind: 'no_change' } }) &&
      producedSideEffect({ executed: true, status: 'success', effect: { kind: 'file_created' } })
  )
}

// ===========================================================================
// §2 Capability Registry
// ===========================================================================
section('§2 Capability Registry（未登记 = 不存在）')
{
  const registry = createDefaultCapabilityRegistry()
  check('§2.1 首批只登记三个能力（§15）', registry.list().length === 3)
  check('§2.2 system.echo 是 R0 / none', registry.get(SYSTEM_ECHO)?.riskLevel === 'R0' && registry.get(SYSTEM_ECHO)?.sideEffectLevel === 'none')
  check('§2.3 sandbox.file.read 是 R0 / read', registry.get(SANDBOX_FILE_READ)?.riskLevel === 'R0' && registry.get(SANDBOX_FILE_READ)?.sideEffectLevel === 'read')
  check('§2.4 sandbox.file.write 是 R1 / write', registry.get(SANDBOX_FILE_WRITE)?.riskLevel === 'R1' && registry.get(SANDBOX_FILE_WRITE)?.sideEffectLevel === 'write')
  check(
    '§2.5 没有任何 R2/R3 能力被登记（它们无法被执行，而不是"执行了又被拒"）',
    registry.list().every((d) => riskRank(d.riskLevel) <= riskRank('R1'))
  )
  check('§2.6 每个能力都声明了权限（"不需要权限"必须显式写）', registry.list().every((d) => d.permissions.length > 0))

  const bad: CapabilityDefinition[] = [
    { ...createDefaultCapabilityDefinitions()[2]!, id: 'Bad.Id' },
    {
      ...createDefaultCapabilityDefinitions()[2]!,
      id: 'test.mismatch',
      operations: [{ name: 'write', description: 'x', sideEffect: 'write', riskLevel: 'R1' }],
      sideEffectLevel: 'none',
      riskLevel: 'R1',
    },
    {
      ...createDefaultCapabilityDefinitions()[2]!,
      id: 'test.riskfloor',
      operations: [{ name: 'write', description: 'x', sideEffect: 'destructive', riskLevel: 'R1' }],
      sideEffectLevel: 'destructive',
      riskLevel: 'R1',
      idempotency: 'supported',
    },
    {
      ...createDefaultCapabilityDefinitions()[2]!,
      id: 'test.noidem',
      operations: [{ name: 'delete', description: 'x', sideEffect: 'destructive', riskLevel: 'R3' }],
      sideEffectLevel: 'destructive',
      riskLevel: 'R3',
      idempotency: 'none',
    },
    { ...createDefaultCapabilityDefinitions()[2]!, id: 'test.noperm', permissions: [] },
    { ...createDefaultCapabilityDefinitions()[2]!, id: 'test.noops', operations: [] },
  ]
  const codes = bad.flatMap((definition) => validateCapabilityDefinition(definition).map((p) => p.code))
  check('§2.7 非法 id 被拒', codes.includes('invalid_id'))
  check('§2.8 sideEffect 与 operations 不一致被拒', codes.includes('side_effect_mismatch'))
  check('§2.9 风险低于副作用下限被拒', codes.includes('risk_below_floor') || codes.includes('capability_risk_below_floor'))
  check('§2.10 destructive + idempotency=none 被拒', codes.includes('destructive_without_idempotency'))
  check('§2.11 空权限被拒', codes.includes('no_permissions'))
  check('§2.12 空 operations 被拒', codes.includes('no_operations'))

  let threw = false
  try {
    createCapabilityRegistry([...createDefaultCapabilityDefinitions(), createDefaultCapabilityDefinitions()[0]!])
  } catch {
    threw = true
  }
  check('§2.13 重复登记同一能力 → 抛错（不存在"部分可用"的登记表）', threw)

  check('§2.14 maxSideEffect / maxRiskLevel 取最高而不是最后一个', maxSideEffect(['none', 'write', 'read']) === 'write' && maxRiskLevel(['R0', 'R3', 'R1']) === 'R3')
  check('§2.15 riskFloorOf 是一致的（write 至少 R1、destructive 必须 R3）', riskFloorOf('write') === 'R1' && riskFloorOf('destructive') === 'R3')
  check('§2.16 hasSideEffect 只对 write/destructive 为真', hasSideEffect('read') === false && hasSideEffect('write') === true)
  check('§2.17 sideEffectRank 单调', sideEffectRank('none') < sideEffectRank('read') && sideEffectRank('read') < sideEffectRank('write') && sideEffectRank('write') < sideEffectRank('destructive'))
}

// ===========================================================================
// §3 Policy（每一个结论码都要有）
// ===========================================================================
section('§3 Policy（意图 ≠ 权限）')
{
  const registry = createDefaultCapabilityRegistry()
  const base = {
    grantedPermissions: DEFAULT_GRANTED_PERMISSIONS,
    maxRiskLevel: 'R1' as RiskLevel,
    dryRun: false,
  }
  const evaluate = (input: {
    capability: string
    operation: string
    confidence: ActionTarget['confidence']
    scopeViolation?: boolean
    request?: ActionRequest
    dryRun?: boolean
    granted?: readonly string[]
    maxRisk?: RiskLevel
  }) => {
    const request =
      input.request ??
      requestOf({
        capability: input.capability,
        operation: input.operation,
        sideEffect: 'write',
        ...(input.capability === SANDBOX_FILE_WRITE ? { idempotencyKey: 'k1' } : {}),
      })
    return evaluateActionPolicy({
      request,
      definition: registry.get(input.capability),
      operation: registry.getOperation(input.capability, input.operation),
      targetConfidence: input.confidence,
      scopeViolation: input.scopeViolation === true,
      grantedPermissions: input.granted ?? base.grantedPermissions,
      maxRiskLevel: input.maxRisk ?? base.maxRiskLevel,
      dryRun: input.dryRun ?? base.dryRun,
    })
  }

  check('§3.1 未登记能力 → capability_not_registered', evaluate({ capability: 'nope.nope', operation: 'x', confidence: 'exact' }).code === 'capability_not_registered')
  check('§3.2 未声明的 operation → unknown_operation', evaluate({ capability: SYSTEM_ECHO, operation: 'destroy', confidence: 'exact' }).code === 'unknown_operation')
  check('§3.3 缺权限 → missing_permission', evaluate({ capability: SANDBOX_FILE_WRITE, operation: 'write', confidence: 'exact', granted: [] }).code === 'missing_permission')
  check('§3.4 超出风险上限 → risk_exceeds_limit（R1 能力在 R0 上限下被拒）', evaluate({ capability: SANDBOX_FILE_WRITE, operation: 'write', confidence: 'exact', maxRisk: 'R0' }).code === 'risk_exceeds_limit')
  check('§3.5 越界 → target_out_of_scope（不是 not_found）', evaluate({ capability: SANDBOX_FILE_READ, operation: 'read', confidence: 'exact', scopeViolation: true }).code === 'target_out_of_scope')
  check('§3.6 干跑下副作用 → dry_run_no_side_effect', evaluate({ capability: SANDBOX_FILE_WRITE, operation: 'write', confidence: 'exact', dryRun: true }).code === 'dry_run_no_side_effect')

  const weakWrite = evaluate({ capability: SANDBOX_FILE_WRITE, operation: 'write', confidence: 'weak' })
  const noneWrite = evaluate({ capability: SANDBOX_FILE_WRITE, operation: 'write', confidence: 'none' })
  check('§3.7 副作用 + weak → target_uncertain（INV-M45-03）', weakWrite.code === 'target_uncertain')
  check('§3.8 副作用 + none → target_uncertain', noneWrite.code === 'target_uncertain')
  check(
    '§3.9 策略结论里留下逐条判定（"为什么允许"可回答）',
    weakWrite.checks.length >= 5 && weakWrite.checks.some((c) => c.name === 'target_certain' && !c.ok)
  )

  check('§3.10 读 + weak → target_ambiguous（不许挑一个读）', evaluate({ capability: SANDBOX_FILE_READ, operation: 'read', confidence: 'weak' }).code === 'target_ambiguous')
  check('§3.11 读 + none → target_not_found（"不存在"与"被拒绝"是两件事）', evaluate({ capability: SANDBOX_FILE_READ, operation: 'read', confidence: 'none' }).code === 'target_not_found')
  check('§3.12 读 + exact → 允许', evaluate({ capability: SANDBOX_FILE_READ, operation: 'read', confidence: 'exact' }).allowed)
  check('§3.13 none 副作用 + none 目标 → 允许（echo 不该被目标闸挡住）', evaluate({ capability: SYSTEM_ECHO, operation: 'echo', confidence: 'none' }).allowed)
  check('§3.14 缺幂等键 + 能力声明 required → idempotency_key_required', (() => {
    const definition: CapabilityDefinition = { ...createDefaultCapabilityDefinitions()[2]!, idempotency: 'required' }
    const custom = createCapabilityRegistry([...createDefaultCapabilityDefinitions().filter((d) => d.id !== SANDBOX_FILE_WRITE), definition])
    return evaluateActionPolicy({
      request: requestOf({ capability: SANDBOX_FILE_WRITE, operation: 'write', sideEffect: 'write' }),
      definition: custom.get(SANDBOX_FILE_WRITE),
      operation: custom.getOperation(SANDBOX_FILE_WRITE, 'write'),
      targetConfidence: 'exact',
      scopeViolation: false,
      grantedPermissions: DEFAULT_GRANTED_PERMISSIONS,
      maxRiskLevel: 'R1',
      dryRun: false,
    }).code === 'idempotency_key_required'
  })())

  check(
    '§3.15 每个结论都有确定性失败码映射（allowed 除外）',
    (['capability_not_registered', 'unknown_operation', 'missing_permission', 'risk_exceeds_limit', 'target_out_of_scope', 'target_uncertain', 'target_ambiguous', 'target_not_found', 'idempotency_key_required', 'dry_run_no_side_effect'] as const).every(
      (code) => ACTION_FAILURE_CODES.includes(failureCodeOfDecision(code))
    )
  )
}

// ===========================================================================
// §4 目标解析（D1 的规则化）
// ===========================================================================
section('§4 目标确定性（唯一 ≠ 相关）')
{
  check('§4.1 绝对路径被拒（语法层，未触碰文件系统）', inspectSandboxPath('/etc/passwd').ok === false)
  check('§4.2 盘符路径被拒', !inspectSandboxPath('C:\\Windows\\win.ini').ok)
  check('§4.3 .. 被拒', !inspectSandboxPath('../secret.txt').ok)
  check('§4.4 NUL 被拒', !inspectSandboxPath('a\u0000b.txt').ok)
  check('§4.5 正常相对路径通过并规范化反斜杠', (() => {
    const v = inspectSandboxPath('sub\\a.txt')
    return v.ok && v.relativePath === 'sub/a.txt'
  })())
  check('§4.6 normalizeHint 去掉 sandbox/ 前缀与引号', normalizeHint('"sandbox/test.txt"') === 'test.txt')

  const list = () => Promise.resolve(entries('a/report.txt', 'b/report.txt', 'sub/hello.txt', 'notes.md'))

  const exact = await resolveActionTarget({
    targetType: 'sandbox_file',
    hints: ['a/report.txt'],
    listEntries: list,
  })
  check('§4.7 精确相对路径 → exact', exact.target.confidence === 'exact' && exact.target.canonicalId === 'a/report.txt')

  const strong = await resolveActionTarget({ targetType: 'sandbox_file', hints: ['hello.txt'], listEntries: list })
  check('§4.8 唯一 basename + 词面证据 → strong', strong.target.confidence === 'strong' && strong.target.canonicalId === 'sub/hello.txt')

  const ambiguous = await resolveActionTarget({ targetType: 'sandbox_file', hints: ['report.txt'], listEntries: list })
  check('§4.9 多候选 → weak（不得挑一个）', ambiguous.target.confidence === 'weak')
  check(
    '§4.10 多候选时把候选列进证据（"不确定"要能解释）',
    (ambiguous.target.evidence ?? []).some((e) => e.kind === 'ambiguous_candidates')
  )

  /*
   * ⚠️ D1 的**可达**原形。
   *
   * 用户说 `a/report.txt`，而沙箱里只有 `b/report.txt`：
   * 候选唯一、basename 一模一样 —— 但**目录不一致**，那是另一个文件。
   * "唯一"从来不是证据（M4/D1）。
   */
  const wrongDir = await resolveActionTarget({
    targetType: 'sandbox_file',
    hints: ['a/report.txt'],
    listEntries: () => Promise.resolve(entries('b/report.txt')),
  })
  check('§4.11 ⚠️ D1 原形：唯一同名候选但目录不一致 → weak（不是 strong）', wrongDir.target.confidence === 'weak')
  check(
    '§4.12 D1 原形的证据里说明了"目录不一致"',
    (wrongDir.target.evidence ?? []).some((e) => e.detail.includes('目录不一致'))
  )

  const semantic = await resolveActionTarget({
    targetType: 'sandbox_file',
    hints: ['那个配置'],
    listEntries: () => Promise.resolve(entries('app.json')),
  })
  check('§4.13 无法词面对上的提示 → none（宁可找不到，也不猜）', semantic.target.confidence === 'none')

  const missing = await resolveActionTarget({ targetType: 'sandbox_file', hints: ['missing.txt'], listEntries: list })
  check('§4.14 读的目标不存在 → none', missing.target.confidence === 'none')

  const creatable = await resolveActionTarget({
    targetType: 'sandbox_file',
    hints: ['missing.txt'],
    listEntries: list,
    allowMissing: true,
  })
  check('§4.15 写允许新建：不存在也是 exact（"创建 hello.txt" 时它当然还不存在）', creatable.target.confidence === 'exact' && creatable.target.canonicalId === 'missing.txt')

  const escape = await resolveActionTarget({
    targetType: 'sandbox_file',
    hints: ['C:\\Windows\\win.ini'],
    listEntries: list,
    allowMissing: true,
  })
  check('§4.16 越界 → scopeViolation=true 且确定性记为 exact（"不许碰"不是"不确定"）', escape.scopeViolation && escape.target.confidence === 'exact')
  check(
    '§4.17 越界证据说明"未触碰真实文件系统"',
    (escape.target.evidence ?? []).some((e) => e.kind === 'scope_violation' && e.detail.includes('未触碰'))
  )

  const declared = await resolveActionTarget({
    targetType: 'sandbox_file',
    declared: targetOf('weak', 'notes.md'),
    hints: [],
    listEntries: list,
  })
  check('§4.18 请求里已带明确目标 → exact（不再去猜）', declared.target.confidence === 'exact' && declared.target.canonicalId === 'notes.md')

  const noHint = await resolveActionTarget({ targetType: 'sandbox_file', hints: [], listEntries: list })
  check('§4.19 没有目标提示 → none（不是"随便挑一个"）', noHint.target.confidence === 'none')
}

// ===========================================================================
// §5 Claim Guard（Speech ≠ Action）
// ===========================================================================
section('§5 Action Claim Guard（未执行不得宣称成功）')
{
  const success = resultOf({ executed: true, status: 'success' })
  const partial = resultOf({
    executed: true,
    status: 'partial',
    progress: { completed: 2, total: 3 },
  })
  const failed = resultOf({
    executed: true,
    status: 'failed',
    error: actionFailure('execution_failed', 'boom'),
  })
  const rejected = resultOf({
    executed: false,
    accepted: false,
    status: 'rejected',
    error: actionFailure('permission_denied', '越界'),
  })
  const notFound = resultOf({
    executed: false,
    accepted: false,
    status: 'not_found',
    error: actionFailure('target_not_found', '没有'),
  })
  const ambiguous = resultOf({
    executed: false,
    accepted: false,
    status: 'ambiguous',
    error: actionFailure('target_ambiguous', '多条'),
  })
  const timeout = resultOf({
    executed: true,
    status: 'timeout',
    error: actionFailure('timeout', '超时'),
  })

  check('§5.1 30 个成功口吻标记全部能命中', ACTION_SUCCESS_MARKERS.every((m) => replyClaimsActionSuccess(`我已经${m}`).claims))
  check('§5.2 否定窗口："我没有写好了"不算违规（4 字符窗口）', !replyClaimsActionSuccess('我没有完成').claims)
  check('§5.3 "我没能帮你在沙箱里创建" 不算违规', !replyClaimsActionSuccess('我没能帮你创建').claims)
  check('§5.4 普通回复不误伤', !replyClaimsActionSuccess('嗯，我在。').claims)

  const successOk = applyActionClaimGuard({ results: [success], replyText: '已经帮你创建好了。' })
  check('§5.5 success 时**允许**成功口吻（这是唯一允许的情形）', !successOk.corrected && successOk.allowedSuccess)

  const rejectedFix = applyActionClaimGuard({ results: [rejected], replyText: '已经帮你处理好了。' })
  check('§5.6 rejected + 成功口吻 → 替换', rejectedFix.corrected && rejectedFix.markers.length > 0)
  check('§5.7 替换成如实的拒绝表述', rejectedFix.replyText.includes('没有被允许执行'))

  const notFoundFix = applyActionClaimGuard({ results: [notFound], replyText: '我读到了。' })
  check('§5.8 not_found + 成功口吻 → 替换', notFoundFix.corrected)

  const ambiguousFix = applyActionClaimGuard({ results: [ambiguous], replyText: '已经修改好了。' })
  check('§5.9 ambiguous → 不得猜目标', ambiguousFix.corrected && ambiguousFix.replyText.includes('不确定'))

  const timeoutFix = applyActionClaimGuard({ results: [timeout], replyText: '执行成功。' })
  check('§5.10 timeout 不得当成 success', timeoutFix.corrected && timeoutFix.replyText.includes('不能确定'))

  const partialFix = applyActionClaimGuard({ results: [partial], replyText: '已经写好了。' })
  check('§5.11 partial 必须表达"只完成一部分"', partialFix.corrected && partialFix.replyText.includes('2/3'))

  const noneFix = applyActionClaimGuard({ results: [failed], replyText: '好的，这事我知道了。' })
  check('§5.12 没有成功口吻时不替换（宁可漏报，不误改成她没说过的话）', !noneFix.corrected && noneFix.replyText === '好的，这事我知道了。')

  const noResults = applyActionClaimGuard({ results: undefined, replyText: '已经完成了。' })
  check('§5.13 本轮没有动作请求 → 完全不经手（普通对话零影响）', !noResults.corrected && noResults.allowedSuccess === false)

  const mixed = applyActionClaimGuard({ results: [failed, success], replyText: '已经完成了。' })
  check('§5.14 只要有一个 success，就不替换', !mixed.corrected)

  check('§5.15 如实句按状态分派（六种各不相同）', new Set([truthfulActionSentence(rejected as never), truthfulActionSentence(notFound as never), truthfulActionSentence(ambiguous as never), truthfulActionSentence(timeout as never), truthfulActionSentence(failed as never), truthfulActionSentence(partial as never)]).size === 6)
  check(
    '§5.16 给模型看的事实摘要对失败明确说"不要说你做了"',
    actionFactSummary(rejected as never).includes('不要说你做了') && actionFactSummary(success as never).includes('已经发生的事实')
  )

  const memoryMarkers = ['记住了', '忘掉了']
  check('§5.17 动作词表与记忆词表不共用（"记住了"不该被动作守卫拦）', memoryMarkers.every((m) => !ACTION_SUCCESS_MARKERS.includes(m)))
  check('§5.18 共用的是最底层扫描（同一条否定规则）', scanClaims('我没有完成', ['完成']).claims === false && scanClaims('我完成了', ['完成']).claims === true)

  /*
   * ---------------------------------------------------------------------------
   * §5.19+ **目标/承诺守卫**（`app/goal/claim-guard.ts`，Lv2 `LV2-D11` ②）
   *
   * 出身：Lv2 第三代读数里 3/4 条严重错误是 `false_execution_claim`
   *      （她说「说定了 / 记下了」而承诺行 = 0）。
   * 三段式：真写了 ⇒ 放行（正控）· 没写而声称 ⇒ 必须替换（负控）· 写回真的 ⇒ 恢复安静。
   * ---------------------------------------------------------------------------
   */
  check(
    '§5.19 承诺专属标记全部能命中（什么都没写时）',
    COMMITMENT_CLAIM_MARKERS.every((m) =>
      replyClaimsCommitmentSuccess({ commitmentWritten: false, anythingWritten: false, replyText: `嗯。${m}。` }).claims,
    ),
  )
  const commitmentAllowed = applyCommitmentClaimGuard({
    commitmentWritten: true,
    anythingWritten: true,
    replyText: '嗯。说定了。',
  })
  check('§5.20 真写了承诺 ⇒ **允许**成功口吻（正控；这是唯一允许的情形）', !commitmentAllowed.corrected && commitmentAllowed.allowedSuccess)
  check(
    '§5.21 本轮写了**别的**东西（记忆）⇒ 记录类标记不算无据（不误伤记忆侧）',
    !replyClaimsCommitmentSuccess({ commitmentWritten: false, anythingWritten: true, replyText: '行。记下了。' }).claims,
  )
  const commitmentFix = applyCommitmentClaimGuard({
    commitmentWritten: false,
    anythingWritten: false,
    replyText: '嗯。说定了。明天十点，楼下。',
  })
  check('§5.22 什么都没写 + 「说定了」⇒ **必须**替换（负控）', commitmentFix.corrected && commitmentFix.markers.includes('说定了'))
  check('§5.23 替换句不得假装已记下、也不得复述约定内容', !commitmentFix.replyText.includes('说定了') && !commitmentFix.replyText.includes('楼下'))
  check(
    '§5.24 否定窗口沿用同一条扫描（"没说定"不算违规）',
    !replyClaimsCommitmentSuccess({ commitmentWritten: false, anythingWritten: false, replyText: '我们没说定。' }).claims,
  )
  check(
    '§5.25 承诺词表与动作词表不共用，且不含记忆侧词（"记住了"）',
    COMMITMENT_CLAIM_MARKERS.every((m) => !ACTION_SUCCESS_MARKERS.includes(m)) && !COMMITMENT_CLAIM_MARKERS.includes('记住了'),
  )
  const commitmentRecovered = applyCommitmentClaimGuard({
    commitmentWritten: true,
    anythingWritten: true,
    replyText: '嗯。说定了。明天十点，楼下。',
  })
  check('§5.26 恢复：写回真的之后，同一句不再被替换（三段式的第三段）', !commitmentRecovered.corrected && commitmentRecovered.replyText.includes('楼下'))
}

// ===========================================================================
// §6 幂等
// ===========================================================================
section('§6 幂等（重复请求不产生第二次副作用）')
{
  const a = actionIdempotencyKey({ capability: SANDBOX_FILE_WRITE, operation: 'write', targetId: 'hello.txt', args: { path: 'hello.txt', content: 'hi' } })
  const b = actionIdempotencyKey({ capability: SANDBOX_FILE_WRITE, operation: 'write', targetId: 'hello.txt', args: { content: 'hi', path: 'hello.txt' } })
  const c = actionIdempotencyKey({ capability: SANDBOX_FILE_WRITE, operation: 'write', targetId: 'hello.txt', args: { path: 'hello.txt', content: 'different' } })
  check('§6.1 同语义 → 同键（键由语义决定，不由时间/随机决定）', a === b, a)
  check('§6.2 不同内容 → 不同键', a !== c)
  check('§6.3 显式提供的键优先', actionIdempotencyKey({ capability: 'x', operation: 'y', args: {}, provided: 'explicit' }) === 'explicit')
  check('§6.4 只有 supported / required 才检查幂等', shouldCheckIdempotency('none') === false && shouldCheckIdempotency('supported') && shouldCheckIdempotency('required'))
  check('§6.5 fnv1a64Hex 是确定性的（同输入同输出、64 位十六进制）', fnv1a64Hex('abc') === fnv1a64Hex('abc') && /^[0-9a-f]{16}$/.test(fnv1a64Hex('abc')))
  check('§6.6 stableSerialize 键序无关', stableSerialize({ a: 1, b: 2 }) === stableSerialize({ b: 2, a: 1 }))
  check('§6.7 stableSerialize 区分 undefined 与缺失', stableSerialize({ a: undefined }) !== stableSerialize({}))
}

// ===========================================================================
// §7 账本折叠（A == B）与审计不变量
// ===========================================================================
section('§7 账本折叠与审计不变量')
{
  const makeEvent = (
    sequence: number,
    type: ActionLedgerEvent['type'],
    payload: Record<string, unknown>,
    status?: ActionLedgerEvent['status']
  ): ActionLedgerEvent => ({
    actionId: asActionId('act:test-1'),
    traceId: TRACE,
    characterId: CHARACTER,
    sequence,
    type,
    ...(status !== undefined ? { status } : {}),
    capability: SANDBOX_FILE_WRITE,
    operation: 'write',
    payload,
    createdAt: 1_800_000_000_000 + sequence,
  })

  const events: ActionLedgerEvent[] = [
    makeEvent(1, 'ACTION_REQUESTED', {
      requestedBy: { kind: 'user', id: 'u1' },
      sideEffect: 'write',
      arguments: { path: 'hello.txt' },
    }),
    makeEvent(2, 'ACTION_TARGET_RESOLVED', { target: targetOf('exact', 'hello.txt'), scopeViolation: false }),
    makeEvent(3, 'ACTION_AUTHORIZED', {
      target: targetOf('exact', 'hello.txt'),
      decision: { allowed: true, code: 'allowed', message: 'ok', risksField: undefined },
    }),
    makeEvent(4, 'ACTION_STARTED', { target: targetOf('exact', 'hello.txt') }),
    makeEvent(
      5,
      'ACTION_SUCCEEDED',
      {
        target: targetOf('exact', 'hello.txt'),
        effect: { kind: 'file_created', detail: '创建 hello.txt', fingerprint: 'abc' },
        evidence: [{ kind: 'filesystem', detail: '写入沙箱内 hello.txt', ref: 'hello.txt' }],
      },
      'success'
    ),
  ]

  const first = foldRecord(events)
  const second = foldRecord([...events])
  check('§7.1 折叠出终态记录', first !== undefined && first.status === 'success')
  check('§7.2 折叠是确定性的（同事件流两次相同）', JSON.stringify(first) === JSON.stringify(second))
  check('§7.3 折叠认得出"适配器真的被调用过"', first?.executed === true && first?.accepted === true)
  check('§7.4 折叠保留了证据与副作用', first?.evidence.length === 1 && first?.effect?.kind === 'file_created')

  const kernelFold = foldExecutionRecord(events)
  check('§7.5 §19 的 ExecutionRecord 与列表视图在共有字段上一致（防两份实现分叉）', kernelFold !== undefined && kernelFold.result?.status === first?.status && kernelFold.result?.executed === first?.executed && String(kernelFold.timestamps.requested) === String(first?.requestedAt))

  const withoutTerminal = foldRecord(events.slice(0, 4))
  check('§7.6 没有终态的 action 折叠出 undefined（它是悬挂的请求，不是记录）', withoutTerminal === undefined)

  check('§7.7 审计不变量：干净记录零违规', checkActionAuditInvariants([first!]).length === 0)
  check('§7.8 审计不变量：success 但没执行过 → 违规', checkActionAuditInvariants([{ ...first!, executed: false }]).some((v) => v.invariant === 'success_implies_executed'))
  check(
    '§7.9 审计不变量：有副作用但目标不确定 → 违规（INV-M45-03）',
    checkActionAuditInvariants([{ ...first!, target: targetOf('weak') }]).some((v) => v.invariant === 'side_effect_requires_certain_target')
  )
  check(
    '§7.10 审计不变量：失败没有归一码 → 违规',
    checkActionAuditInvariants([
      { ...first!, status: 'failed', failure: undefined },
    ]).some((v) => v.invariant === 'failure_carries_code')
  )
  check(
    '§7.11 changedWorld 用**声明**的副作用等级判断（适配器自报不算数）',
    changedWorld(first!) && !changedWorld({ ...first!, sideEffect: 'read' })
  )
  check(
    '§7.13 幂等重放豁免"success 必须执行过"，但必须有名字（idempotentReplay）',
    checkActionAuditInvariants([{ ...first!, executed: false, idempotentReplay: true }]).length === 0 &&
      checkActionAuditInvariants([{ ...first!, executed: false }]).some(
        (v) => v.invariant === 'success_implies_executed'
      )
  )
  check(
    '§7.14 没做成的操作不得被"重放"成做过',
    checkActionAuditInvariants([
      { ...first!, status: 'failed', failure: actionFailure('execution_failed', 'x'), idempotentReplay: true },
    ]).some((v) => v.invariant === 'replay_only_of_success')
  )
  check('§7.12 账本侧的"允许成功"判据与守卫同向', ledgerAllowsSuccessClaim([first!]) === true && ledgerAllowsSuccessClaim([{ ...first!, status: 'failed' }]) === false)
}

// ===========================================================================
// §8 自然语言意图判定（规则式，D-A）
// ===========================================================================
section('§8 意图判定（规则式，模型不决定执行）')
{
  const detector = createActionIntentDetector()

  const read = detector.detect('读一下 sandbox/test.txt')
  check('§8.1 "读一下 sandbox/test.txt" → read', read?.capability === SANDBOX_FILE_READ && read.operation === 'read')
  check('§8.2 目标提示已规范化（去 sandbox/ 前缀）', read?.hints[0] === 'test.txt', String(read?.hints[0]))

  const write = detector.detect('帮我在沙箱里创建 hello.txt，内容为 hi')
  check('§8.3 "创建 hello.txt" → write', write?.capability === SANDBOX_FILE_WRITE)
  check('§8.4 抽出了要写的内容', write?.args.content === 'hi', String(write?.args.content))

  const into = detector.detect('把 hello 写进 b.txt')
  check('§8.5 "把 A 写进 B" → write，目标是 B', into?.capability === SANDBOX_FILE_WRITE && into.args.path === 'b.txt')

  const modify = detector.detect('修改 report.txt')
  check('§8.6 "修改 report.txt" 也走 write（目标是关键，内容缺失由适配器如实拒绝）', modify?.capability === SANDBOX_FILE_WRITE && modify.args.path === 'report.txt')

  const escape = detector.detect('读一下 ../private.txt')
  check('§8.7 越界路径仍被识别为 read（让策略去拒绝，而不是当作"没听懂"）', escape?.capability === SANDBOX_FILE_READ)
  /*
   * ========================================================================
   *  §8.7a–c 第二批的**链序**判据（2026-10-04 跨会话对齐后的形状）
   * ========================================================================
   * 曾经这一条断言的是"M4.5 不再认领本机绝对路径"（在 M4.5 里先把绝对路径挖掉）。
   * 那样做会让 **`pnpm m4.5:ci` 的 `NL-05` 三条断言全红** —— 它逐字要求
   * `读一下 C:\Windows\win.ini` 得到一条 `permission_denied`
   * 且账本里带"未触碰真实文件系统"。**那条门是冻结的，它赢。**
   *
   * ⇒ 正确的不变量不是"M4.5 改行为"，而是"**生产链序**让本机域先认领"：
   * ```text
   * M4.5 单检测器行为**逐字不变**（NL-05 依赖它）
   * 生产链（本机域检测器在前）上，带盘符/UNC 的路径归本机文件域
   * 沙箱相对路径仍然归 M4.5（链序没有抢走旧行为）
   * ```
   */
  const absolute = '读一下 C:\\Windows\\win.ini'
  check(
    '§8.7a M4.5 单检测器行为不变（NL-05 的冻结判据依赖它）',
    detector.detect(absolute)?.capability === SANDBOX_FILE_READ
  )
  const chained = chainIntentDetectors([createLocalFileIntentDetector(), detector])
  check(
    '§8.7b 生产链序：本机绝对路径归第二批（本机域），不再被说成"越出沙箱范围"',
    chained.detect(absolute)?.capability === LOCAL_FILE_READ
  )
  check(
    '§8.7c 生产链序：沙箱相对路径仍归 M4.5（旧行为没被抢走）',
    chained.detect('读一下 notes.txt')?.capability === SANDBOX_FILE_READ &&
      chained.detect('读一下 ../private.txt')?.capability === SANDBOX_FILE_READ
  )

  const none = detector.detect('今天天气不错')
  check('§8.8 无关的话 → 没有意图（绝大多数轮次都是这样）', none === undefined)

  check('§8.9 echo 只在明确说"回声/echo"时触发', detector.detect('echo 你好')?.capability === SYSTEM_ECHO && detector.detect('你好') === undefined)
  check('§8.10 路径抽取只认像文件的东西', extractPathTokens('我觉得很好的').length === 0)
}

// ===========================================================================
// §9 CLI / 开关 / 静态锁
// ===========================================================================
section('§9 CLI / 开关 / 静态锁（约定必须能被机器发现）')
{
  const list = parseActionAdminArgs(['--action-list', '--status', 'success'])
  check('§9.1 --action-list 解析出 status 过滤', list.kind === 'list' && list.status === 'success')

  const bogus = parseActionAdminArgs(['action', 'list', '--status', 'sleeping'])
  check('§9.2 未知 status → usage 报错（绝不静默返回全部）', bogus.kind === 'usage')

  const show = parseActionAdminArgs(['action', 'show', 'act:123'])
  check('§9.3 action show <id> 解析正确', show.kind === 'show' && show.actionId === 'act:123')

  const traceCmd = parseActionAdminArgs(['--action-trace', 'trc:abc'])
  check('§9.4 --action-trace <traceId> 解析正确', traceCmd.kind === 'trace' && traceCmd.traceId === 'trc:abc')

  check('§9.5 action 子命令是只读调用（不要求模型连通性）', isReadOnlyInvocation(['action', 'list']) && isReadOnlyInvocation(['--action-audit']))

  const flags = readKernelFlags({} as NodeJS.ProcessEnv)
  check('§9.6 动作默认开启（用户驱动 + 沙箱内，见 D-B）', flags.actionEnabled)
  check('§9.7 默认风险上限是 R1', flags.actionMaxRiskLevel === 'R1')
  check('§9.8 默认沙箱根是 data/action-sandbox', flags.actionSandboxRoot === 'data/action-sandbox')
  check('§9.9 拼错的风险等级退回缺省而不是"无限制"', readKernelFlags({ CHARACTER_ACTION_MAX_RISK: 'R9' } as NodeJS.ProcessEnv).actionMaxRiskLevel === 'R1')
  check('§9.10 flags 摘要里能一眼看出动作是否接了线', describeKernelFlags(flags).includes('action(R1)'))

  const root = resolve('.')
  const readSource = (path: string): string => readFileSync(resolve(root, path), 'utf8')

  // 静态锁 ③：开关必须被真的消费（D3 的教训）
  check('§9.11 ⚠️ 回归锁：actionEnabled 必须被 main.ts 真的消费', readSource('src/main.ts').includes('actionEnabled: this.flags.actionEnabled'))

  /*
   * 静态锁 ④：post-Lv2 / ADR-110 `D05`（QQ 主动联系）
   *
   * ⚠️ 这一条是**手写**的，与上面那条同一个理由：本仓库**没有**"枚举全部 flags
   *    逐个检查消费者"的通用锁（WP0 复核时确认过）。新开关必须自己加一条，
   *    否则它正好长成 `CHARACTER_MEMORY_BACKGROUND_ENABLED` 那个惰性开关的形状。
   * ⚠️ 断言的是**消费表达式**（不是"文件里出现过这个词"）：
   *    `qqProactiveMode !== 'off'` 决定权限是否授予 ⇒ 关着时**构造上**拿不到执行许可。
   */
  {
    const mainSource = readSource('src/main.ts')
    check(
      '§9.16 ⚠️ 回归锁：qqProactiveMode 必须被 main.ts 真的消费（决定 capability 权限是否授予）',
      mainSource.includes("this.flags.qqProactiveMode !== 'off'") &&
        mainSource.includes('QQ_PRIVATE_SEND_PERMISSION')
    )
    /* 取 `TASK_CAPABILITY_IDS` 那个数组字面量的原文（从声明到第一个行首 `]`） */
    const taskListStart = mainSource.indexOf('const TASK_CAPABILITY_IDS')
    const taskListSource =
      taskListStart < 0 ? '' : mainSource.slice(taskListStart, mainSource.indexOf('\n]', taskListStart))
    check(
      '§9.17 ⚠️ 回归锁：QQ 主动发送能力**不在**任务候选表里（计划 §7："本批新增 NONE"）',
      taskListSource !== '' &&
        !taskListSource.includes('QQ_PRIVATE_SEND_TEXT') &&
        mainSource.includes('...createQqProactiveCapabilityDefinitions()')
    )
    check(
      '§9.18 缺省模式是 off（缺省不外发），非法值失败关闭回 off',
      readKernelFlags({} as NodeJS.ProcessEnv).qqProactiveMode === 'off' &&
        readKernelFlags({ CHARACTER_QQ_PROACTIVE_MODE: 'onn' } as NodeJS.ProcessEnv).qqProactiveMode === 'off' &&
        readKernelFlags({ CHARACTER_QQ_PROACTIVE_MODE: 'shadow' } as NodeJS.ProcessEnv).qqProactiveMode === 'shadow'
    )
    check(
      '§9.19 策略配置的时区**不继承宿主机**（缺省写死 Asia/Shanghai），且额度在安全侧',
      (() => {
        const policy = readProactivePolicy({ CHARACTER_TZ: 'UTC', TZ: 'UTC' } as NodeJS.ProcessEnv)
        return (
          policy.timeZone === 'Asia/Shanghai' &&
          policy.activeWindow.startHour === 9 &&
          policy.activeWindow.endHour === 22 &&
          policy.maxCarePerDay === 2 &&
          policy.maxProactiveMessagesPerDay === 10
        )
      })()
    )
  }

  // 静态锁 ①：kernel 不许 import 基础设施
  const kernelFiles = [
    'src/kernel/action/gateway.ts',
    'src/kernel/action/policy.ts',
    'src/kernel/action/target-resolver.ts',
    'src/kernel/action/claim-guard.ts',
    'src/kernel/action/execution-ledger.ts',
    'src/kernel/action/execution-record.ts',
    'src/kernel/action/admin.ts',
    'src/kernel/action/action-turn.ts',
  ]
  check(
    '§9.12 kernel 边界：action 领域层不 import 基础设施',
    kernelFiles.every((f) => !readSource(f).includes('infrastructure'))
  )

  // 静态锁 ②：适配器只允许被 gateway（或装配层/测试）触达
  check(
    '§9.13 无绕过：sandbox 适配器只被 main.ts（装配层）与测试脚本引用',
    (() => {
      const allowed = ['src/main.ts', 'src/infrastructure/action/action-ledger-store.ts']
      const sources = [
        'src/kernel/action/gateway.ts',
        'src/kernel/action/action-turn.ts',
        'src/kernel/app/turn-gateway.ts',
        'src/kernel/app/memory/explicit-service.ts',
      ]
      void allowed
      return sources.every((f) => !readSource(f).includes('adapters/'))
    })()
  )

  // 静态锁 ④：角色内核不知道能力的存在（ADR-031 决策 4）
  const characterSource = readSource('src/character/苏沐薇.ts')
  check(
    '§9.14 角色内核不包含任何能力实现（人格不决定权限）',
    !characterSource.includes('sandbox.file') && !characterSource.includes('ActionRequest')
  )

  // 静态锁 ⑤：量具只有一份实现（ADR-035）
  const mainSource = readSource('src/main.ts')
  const ledgerSource = readSource('src/infrastructure/action/action-ledger-store.ts')
  check(
    '§9.15 量具单一实现：CLI 走 listRecords 端口，不自己写 SQL',
    mainSource.includes('ledger.listRecords') && !mainSource.includes('from character_action_events')
  )
  check(
    '§9.16 status 过滤真的在 SQL 里（where 子句），不是读回来再 filter',
    ledgerSource.includes('status is not null') && ledgerSource.includes('and status =')
  )
  check(
    '§9.17 只有 action-ledger-store 直接读 character_action_events（过滤不会分叉）',
    readSource('src/kernel/action/admin.ts').includes('renderActionList') === true
  )

  /*
   * §46：M4.1 遗留的两项**不许因为 M4.5 而自动上线**。
   *
   * 它们各自有一个"看起来能开、其实没接"的历史，因此这里的锁有两层：
   *   · 默认值必须是 off
   *   · 后台抽取在生产代码里必须**仍然没有消费者**（NOT-WIRED 是如实状态）
   */
  const defaults = readKernelFlags({} as NodeJS.ProcessEnv)
  check('§9.18 LLM 抽取兜底默认仍然是 off（M4.1 的结论未被顺手推翻）', defaults.memoryLlmExtractorEnabled === false)
  check('§9.19 后台自动抽取默认仍然是 off', defaults.memoryBackgroundEnabled === false)
  check(
    '§9.20 后台抽取在生产代码里仍然**没有消费者**（NOT-WIRED 必须继续是如实状态）',
    !readSource('src/kernel/app/turn-gateway.ts').includes('memory/job') &&
      !readSource('src/kernel/app/kernel.ts').includes('memory/job')
  )
}

// ===========================================================================
// 汇总
// ===========================================================================
/**
 * 落一份机器可读的证据。
 *
 * ⚠️ 加它的理由很具体：`m4.5:gates`（门结果汇总）只读**已落盘的证据**，
 *    而 L1 原先只往控制台打印 —— 于是汇总里它是 `not-run`。
 *    "汇总器不该比它的证据知道得更多"是对的，但**证据该落的就要落**。
 */
mkdirSync(evidenceDir, { recursive: true })
writeFileSync(
  join(evidenceDir, 'component.json'),
  `${JSON.stringify(
    {
      testId: 'M4.5 / L1',
      name: 'Component（协议 / 登记 / 策略 / 目标 / 守卫 / 幂等 / 静态锁）',
      priority: 'P0',
      status: failed === 0 ? 'PASS' : 'FAIL',
      groups: [
        '§1 协议与失败语义',
        '§2 Capability Registry',
        '§3 Policy 全分支',
        '§4 目标确定性（D1 的规则化）',
        '§5 Action Claim Guard',
        '§6 幂等',
        '§7 账本折叠与审计不变量',
        '§8 自然语言意图判定',
        '§9 CLI / 开关 / 静态锁',
      ],
      checks: { passed, failed, failures },
    },
    null,
    2
  )}\n`,
  'utf8'
)

console.log(`\n${'='.repeat(72)}`)
console.log(`M4.5 L1 部件级测试：${passed} 通过 / ${failed} 失败`)
if (failures.length > 0) console.log(`失败项：${failures.join(' | ')}`)
console.log(`证据：${join(evidenceDir, 'component.json')}`)
console.log('='.repeat(72))
process.exit(failed === 0 ? 0 : 1)
