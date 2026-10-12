/**
 * PolicyEngine —— **意图 ≠ 权限**（M4.5 §25 / ADR-030 / INV-M45-02）。
 *
 * ============================================================================
 *  一切都是纯函数
 * ============================================================================
 * 策略不读时间、不读环境、不碰磁盘。它的输入是一份**已经解析好的**
 * 请求 + 目标 + 声明 + 授权清单，输出是一个可断言的 `PolicyDecision`。
 *
 * 这样做的直接收益：
 *
 *   · "什么情况下会被拒绝"可以在离线被**穷举**（L1 测试全分支）
 *   · 每一条判定都能写进账本（"为什么允许"必须可回答）
 *   · `dry-run` / 权限收紧 / 风险上限变更不需要改一行业务代码
 *
 * 判定顺序是刻意的：越靠前的检查越"结构性"（能力存不存在），
 * 越靠后的越"情境性"（目标够不够确定）。
 */

import type { ActionRequest, RiskLevel, TargetConfidence } from './action-request.ts'
import { hasSideEffect, riskRank } from './action-request.ts'
import type { CapabilityDefinition, OperationDefinition } from './capability-registry.ts'
import type { ActionFailureCode } from './errors.ts'

export type PolicyDecisionCode =
  | 'allowed'
  | 'capability_not_registered'
  | 'unknown_operation'
  | 'missing_permission'
  | 'risk_exceeds_limit'
  | 'target_out_of_scope'
  | 'target_uncertain'
  | 'target_ambiguous'
  | 'target_not_found'
  | 'idempotency_key_required'
  | 'dry_run_no_side_effect'

export interface PolicyCheck {
  name: string
  ok: boolean
  detail: string
}

/**
 * "目标在不在范围内"这件事的**措辞**（第二批：本机文件域）。
 *
 * ============================================================================
 *  为什么这是一份可注入的措辞，而不是一句写死的话
 * ============================================================================
 * 第一批只有一个域（沙箱），因此第 ⑥ 步的两句话是写死的。第二批引入了
 * **本机全盘域**，而计划书 §2.1 第 2 点逐字要求：
 * 「全盘目标携带真实的本地路径域证据，Policy/trace **不能把它错误描述为
 * '沙箱范围内'**」。
 *
 * 于是把措辞抽成三个字段，**缺省值就是原来的三句**（逐字不变）：
 * ```text
 * 旧能力不传 ⇒ 与第一批完全一致（M4.5 的 135 条断言一个字节都不动）
 * 本机域传 ⇒ 说"已授权的本机文件域（不是沙箱）"
 * ```
 * ⚠️ 它只改**措辞**，不改任何判定：放行/拒绝的**结论**与 `code` 都不受它影响。
 *    一份能改结论的措辞会让"为什么允许"重新变成不可回答的问题。
 */
export interface ActionPolicyScopeWording {
  /** 第 ⑥ 步通过时的 detail */
  inScope: string
  /** 第 ⑥ 步不通过时的 detail */
  outOfScope: string
  /** 第 ⑥ 步不通过时的 decision.message（用户可见的那一句） */
  outOfScopeMessage: string
}

const SANDBOX_SCOPE_WORDING: ActionPolicyScopeWording = {
  inScope: '在沙箱范围内',
  outOfScope: '目标越出沙箱范围（未触碰真实文件系统）',
  outOfScopeMessage: '目标在沙箱范围之外，拒绝执行',
}

export interface PolicyDecision {
  allowed: boolean
  code: PolicyDecisionCode
  message: string
  /** 这个决定依据的风险等级（未登记能力时为 `undefined`） */
  riskLevel?: RiskLevel
  /** 逐条判定的留痕（进账本） */
  checks: readonly PolicyCheck[]
}

export interface ActionPolicyInput {
  request: ActionRequest
  definition: CapabilityDefinition | undefined
  operation: OperationDefinition | undefined
  /** 目标确定等级。**没有目标**时是 `none` */
  targetConfidence: TargetConfidence
  /** 目标是否越出沙箱范围（由 TargetResolver 判定，见 ADR-032） */
  scopeViolation: boolean
  /** 装配层显式授予的权限 */
  grantedPermissions: readonly string[]
  /** 这次运行允许的最高风险等级 */
  maxRiskLevel: RiskLevel
  /** 干跑：任何副作用都不允许发生 */
  dryRun: boolean
  /**
   * 第二批：目标域的措辞（缺省 = 沙箱那三句，逐字不变）。
   * ⚠️ **只改措辞，不改判定**。
   */
  scopeWording?: ActionPolicyScopeWording
}

function decide(
  allowed: boolean,
  code: PolicyDecisionCode,
  message: string,
  checks: readonly PolicyCheck[],
  riskLevel?: RiskLevel
): PolicyDecision {
  return riskLevel === undefined
    ? { allowed, code, message, checks }
    : { allowed, code, message, riskLevel, checks }
}

/** 目标确定性允许副作用的两级（ADR-032） */
const SIDE_EFFECT_CONFIDENCE: readonly TargetConfidence[] = ['exact', 'strong']

export function evaluateActionPolicy(input: ActionPolicyInput): PolicyDecision {
  const { request, definition, operation } = input
  const checks: PolicyCheck[] = []

  // ① 能力必须登记（ADR-031：登记是"能力存在"的唯一来源）
  if (definition === undefined) {
    checks.push({
      name: 'capability_registered',
      ok: false,
      detail: `${request.capability} 没有登记 —— 未登记不是"默认允许"`,
    })
    return decide(
      false,
      'capability_not_registered',
      `能力 ${request.capability} 没有登记，拒绝执行`,
      checks
    )
  }
  checks.push({ name: 'capability_registered', ok: true, detail: definition.version })

  // ② 操作必须在声明里出现
  if (operation === undefined) {
    checks.push({
      name: 'operation_declared',
      ok: false,
      detail: `${definition.id} 没有声明 operation ${request.operation}`,
    })
    return decide(
      false,
      'unknown_operation',
      `${definition.id} 不支持操作 ${request.operation}`,
      checks,
      definition.riskLevel
    )
  }
  checks.push({
    name: 'operation_declared',
    ok: true,
    detail: `${operation.name} (${operation.riskLevel}/${operation.sideEffect})`,
  })

  // ③ 权限：**全部**声明权限都必须被显式授予（fail-closed）
  const missing = definition.permissions.filter((p) => !input.grantedPermissions.includes(p))
  if (missing.length > 0) {
    checks.push({
      name: 'permissions_granted',
      ok: false,
      detail: `缺少权限：${missing.join(', ')}`,
    })
    return decide(
      false,
      'missing_permission',
      `没有被授予 ${missing.join(', ')}，拒绝执行`,
      checks,
      operation.riskLevel
    )
  }
  checks.push({
    name: 'permissions_granted',
    ok: true,
    detail: definition.permissions.join(' '),
  })

  // ④ 风险上限
  if (riskRank(operation.riskLevel) > riskRank(input.maxRiskLevel)) {
    checks.push({
      name: 'risk_within_limit',
      ok: false,
      detail: `${operation.riskLevel} 超过上限 ${input.maxRiskLevel}`,
    })
    return decide(
      false,
      'risk_exceeds_limit',
      `风险等级 ${operation.riskLevel} 超过本次允许的上限 ${input.maxRiskLevel}`,
      checks,
      operation.riskLevel
    )
  }
  checks.push({
    name: 'risk_within_limit',
    ok: true,
    detail: `${operation.riskLevel} ≤ ${input.maxRiskLevel}`,
  })

  // ⑤ 干跑：副作用一律不发生
  if (input.dryRun && hasSideEffect(operation.sideEffect)) {
    checks.push({
      name: 'dry_run',
      ok: false,
      detail: '干跑模式下不允许任何副作用',
    })
    return decide(
      false,
      'dry_run_no_side_effect',
      '当前是干跑模式，副作用被禁止',
      checks,
      operation.riskLevel
    )
  }
  checks.push({ name: 'dry_run', ok: true, detail: input.dryRun ? '干跑（无副作用）' : '正常模式' })

  // ⑥ 越界
  const wording = input.scopeWording ?? SANDBOX_SCOPE_WORDING
  if (input.scopeViolation) {
    checks.push({
      name: 'target_in_scope',
      ok: false,
      detail: wording.outOfScope,
    })
    return decide(
      false,
      'target_out_of_scope',
      wording.outOfScopeMessage,
      checks,
      operation.riskLevel
    )
  }
  checks.push({ name: 'target_in_scope', ok: true, detail: wording.inScope })

  /*
   * ⑦ 目标确定性（INV-M45-03）。
   *
   * 读与写的门槛在**存在性**上分叉，但在"不确定性"上一致：
   *   · 副作用 + weak/none → 拒绝（不许猜）
   *   · 读 + weak        → 拒绝（多候选，不许挑一个）
   *   · 读 + none        → not_found（目标不存在，不是"被拒绝"）
   *   · none 副作用      → 放行（echo 这类不动世界的操作不该被目标闸挡住）
   */
  const sideEffect = hasSideEffect(operation.sideEffect)
  if (sideEffect) {
    if (!SIDE_EFFECT_CONFIDENCE.includes(input.targetConfidence)) {
      checks.push({
        name: 'target_certain',
        ok: false,
        detail: `目标确定性 ${input.targetConfidence}，有副作用的操作要求 exact / strong`,
      })
      return decide(
        false,
        'target_uncertain',
        `目标不确定（${input.targetConfidence}），拒绝执行有副作用的操作`,
        checks,
        operation.riskLevel
      )
    }
  } else if (operation.sideEffect === 'read') {
    if (input.targetConfidence === 'none') {
      checks.push({ name: 'target_certain', ok: false, detail: '目标不存在' })
      return decide(
        false,
        'target_not_found',
        '目标不存在，没有可读的东西',
        checks,
        operation.riskLevel
      )
    }
    if (input.targetConfidence === 'weak') {
      checks.push({ name: 'target_certain', ok: false, detail: '目标不唯一，读哪一个不确定' })
      return decide(
        false,
        'target_ambiguous',
        '目标不唯一，拒绝猜一个来读',
        checks,
        operation.riskLevel
      )
    }
  }
  checks.push({
    name: 'target_certain',
    ok: true,
    detail: `确定性 ${input.targetConfidence}（sideEffect=${operation.sideEffect}）`,
  })

  // ⑧ 幂等键（能力声明 required 时）
  if (definition.idempotency === 'required' && request.idempotencyKey === undefined) {
    checks.push({
      name: 'idempotency_key',
      ok: false,
      detail: `${definition.id} 要求幂等键但没有提供`,
    })
    return decide(
      false,
      'idempotency_key_required',
      `${definition.id} 要求 idempotencyKey`,
      checks,
      operation.riskLevel
    )
  }
  checks.push({
    name: 'idempotency_key',
    ok: true,
    detail: request.idempotencyKey ?? `未声明（能力声明为 ${definition.idempotency}）`,
  })

  return decide(
    true,
    'allowed',
    `允许执行 ${definition.id}@${definition.version} 的 ${operation.name}`,
    checks,
    operation.riskLevel
  )
}

/**
 * 策略结论 → 失败码的**唯一映射**。
 *
 * 放在这里而不是调用点：`permission_denied` 与 `target_not_found`
 * 对用户是不同的信息（"我不被允许" vs "它不存在"），
 * 而后者若被前者吞掉，S5 与 S3 就无法区分。
 */
export function failureCodeOfDecision(code: PolicyDecisionCode): ActionFailureCode {
  switch (code) {
    case 'capability_not_registered':
    case 'unknown_operation':
      return 'unsupported'
    case 'missing_permission':
    case 'risk_exceeds_limit':
    case 'target_out_of_scope':
    case 'dry_run_no_side_effect':
      return 'permission_denied'
    case 'target_uncertain':
      return 'target_uncertain'
    case 'target_ambiguous':
      return 'target_ambiguous'
    case 'target_not_found':
      return 'target_not_found'
    case 'idempotency_key_required':
      return 'validation_failed'
    case 'allowed':
      throw new Error('allowed 不是失败，不能映射为失败码')
  }
}
