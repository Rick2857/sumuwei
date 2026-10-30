/**
 * ToolGateway —— **唯一执行入口**（M4.5 §13 / ADR-030）。
 *
 * ============================================================================
 *  固定顺序，且每一段都留下账本
 * ============================================================================
 * ```text
 * ACTION_REQUESTED      ← 先记"她想做什么"（哪怕后面被拒）
 * 目标解析（未登记能力连这一步都不做 → 零 IO）
 * ACTION_TARGET_RESOLVED
 * 策略判定
 * ACTION_AUTHORIZED / ACTION_REJECTED
 * 幂等检查（命中则重放，不再执行）
 * ACTION_STARTED
 * 适配器执行
 * ACTION_SUCCEEDED / ACTION_FAILED / ACTION_PARTIAL / ACTION_CANCELLED
 * ```
 *
 * 四条硬性质：
 *
 *   1. **策略拒绝时适配器一次都不会被调用**（阴性控制可断言调用计数为 0）
 *   2. **未登记能力不做任何 IO**：连"沙箱里有什么"都不去读
 *   3. **账本写失败则不执行**：没有证据的执行是不允许的（宁可拒绝）
 *   4. **幂等命中只重放成功过的后置状态**，不重放"没做成的"
 */

import type { CharacterId, Timestamp } from '../contracts/ids.ts'
import { KernelError } from '../contracts/ids.ts'
import type { ActionRequest, ActionTarget, RiskLevel } from './action-request.ts'
import type { ActionEffect, ActionEvidence } from './action-request.ts'
import type { ActionResult, ActionStatus } from './action-result.ts'
import type { GatewayCapabilityFacts, ObservedCapabilityResult } from './capability-facts.ts'
import type { CapabilityRegistry, OperationDefinition } from './capability-registry.ts'
import type { ActionFailure } from './errors.ts'
import { ActionFailureError, actionFailure, normalizeAdapterError } from './errors.ts'
import type { AdapterOutcome, CapabilityAdapter } from './executor-port.ts'
import { evidenceOf, isAdapterFailure } from './executor-port.ts'
import type { ActionLedgerEvent, ActionEventType, ExecutionLedgerPort, ExecutionRecordView } from './execution-ledger.ts'
import { actionIdempotencyKey, shouldCheckIdempotency } from './idempotency.ts'
import type { PolicyDecision } from './policy.ts'
import { evaluateActionPolicy, failureCodeOfDecision } from './policy.ts'
import type { ActionPolicyScopeWording } from './policy.ts'
import {
  ACTION_ATTRIBUTION_EXEMPTIONS,
  NECESSITY_MATRIX,
  actionAttributionFamilyOf,
  attestActionActorFromDecisionPoint,
  attestActionAuthorityFromPolicy,
  attestActionExecutorFromAdapter,
  buildTrustedActionAttribution,
  isNamedExemptionInitiatorEvidence,
  namedExemptionViolation,
  type AuthorityRef,
  type TrustedActionAttributionContext,
  type TrustedActionPrincipalEvidence,
} from '../contracts/attribution.ts'
import type { PrincipalRef } from '../contracts/actor.ts'

export interface TargetResolution {
  target: ActionTarget
  scopeViolation: boolean
}

/**
 * ADR-146：一次**已过策略**的委派（由装配层实现；网关只负责"调不调它"）。
 *
 * ⚠️ 它**不接受**风险额度字段 —— 额度在 `pre.decision` 里已经判完了
 *    （`D02`：线上不携带额度；把已决定过的权限判断交回对端改是倒退）。
 */
export interface AdapterDelegator {
  /** 把这次调用发出去；抛异常 ⇒ 委派失败（**不是**"那就本地做吧"） */
  send(request: ActionRequest, decision: PolicyDecision): Promise<AdapterOutcome>
}

export interface ActionGatewayOptions {
  ledger: ExecutionLedgerPort
  adapters: readonly CapabilityAdapter[]
  /** 装配层显式授予的权限 */
  grantedPermissions: readonly string[]
  registry: CapabilityRegistry
  /** 本次运行允许的最高风险等级 */
  maxRiskLevel: RiskLevel
  /**
   * ADR-146：**执行端委派**（可选；**不装 ⇒ 逐字旧行为**）。
   *
   * ⚠️⚠️ **它必须在网关层，不能在适配器层** ——
   *    `executor-port.ts:7` 明写适配器 `execute()` 的输入里
   *    「**没有** `requestedBy`、**没有**策略结论」。
   *    也就是说**适配器根本拿不到"允不允许"**，闸放在那里等于没有闸。
   *    ⇒ 只有网关层有 `pre.decision`，也只有这里能决定"委派还是本地"。
   *
   * ⚠️ **这个函数返回 `undefined` 就走本地适配器**（今天的行为）。
   *    实现方在"执行端不在线"时**必须**返回 `undefined` ——
   *    电脑休眠隧道断是常态（`L-146-03`），那时 `desktop.operate`
   *    直接失效就是**没通知任何人地改变了既有行为**。
   *
   * ⚠️ **委派失败绝不落回本地重做**：核心可能已提交过那一次。
   *    重做 = 同一件事做两遍（同 `lg-stdio-client.ts` 断线拒绝的纪律）。
   */
  delegator?: (request: ActionRequest, decision: PolicyDecision) => AdapterDelegator | undefined
  dryRun?: boolean
  now?: () => Timestamp
  /**
   * 目标解析器。**由装配层注入** —— 它要读沙箱目录（IO），
   * 而 Gateway 自己不做 IO（否则它无法被离线穷举）。
   */
  resolveTarget: (input: {
    request: ActionRequest
    operation: OperationDefinition | undefined
  }) => Promise<TargetResolution>
  /** 每个账本事件的观察钩子（trace / 诊断用；不允许影响执行结果） */
  onLedgerEvent?: (event: ActionLedgerEvent) => void
  /**
   * 第二批：**目标域措辞**的注入点（缺省 = 沙箱那三句，逐字不变）。
   *
   * 计划书 §2.1 第 2 点要求「Policy/trace 不能把它错误描述为'沙箱范围内'」，
   * 而策略的第 ⑥ 步在第一批里是写死的一句话。这里按**能力**给措辞：
   * 本机文件域的能力拿到"已授权的本机文件域（不是沙箱）"，其余拿到缺省。
   *
   * ⚠️ 它只改措辞，不改判定（见 `policy.ts` 的 `ActionPolicyScopeWording`）。
   */
  scopeWordingFor?: (capability: string) => ActionPolicyScopeWording | undefined
  /**
   * WP5：启用**受信行动归因**的写路径（不配 = 逐字段 legacy，零影响）。
   *
   * 一旦配置，`execute()` **必须**拿到受信 invocation 上下文（见
   * `ActionInvocationContext`）；拿不到就失败关闭 —— 这是 WP5-3 的
   * "缺受信 initiator 证据 ⇒ FAIL CLOSED"，而不是"退回 payload 自报"。
   */
  attribution?: ActionAttributionOptions
}

/** WP5：受信归因的三个产出者标识（写进证据，便于事后回答"谁鉴证的"） */
export interface ActionAttributionOptions {
  /** 决策点的 adapterId（`actor` = 这个决策点） */
  decisionPointAdapterId: string
  /** 策略评估器的 adapterId（`authority` 证据的产出者） */
  policyAdapterId?: string
  /** 执行器边界证据的 adapterId（`executor` = `SERVICE/adapter:<capability>`） */
  executorAdapterId?: string
}

/**
 * 一次调用的**受信 ingress 上下文**（WP5-2）。
 *
 * ⚠️ `initiatorEvidence` **不是** `request.requestedBy`：后者是 payload 自报的
 * 输入证据，永远不能自己变成权威 `initiator`。这个字段只能由**受信 ingress**
 * （`action-turn.ts` 的装配层）产出，而且 K-27 / WP5.1 之后它**只能**来自
 * **因果上下文**（`attestActionInitiatorFromCausalOrigin()`）、如实的"未定"
 * （`attestActionInitiatorUnresolved()`），或 ADR-098 追加的**具名豁免**
 * （`attestActionInitiatorFromNamedExemption()`）——
 * 呈现角色（`speaker`）**没有**任何构造器能把它变成具体位次。
 *
 * ⚠️ 判定点要读 `causalBasis` 才能对"具名豁免"做收窄复核（ADR-098 §3），
 *    而本字段按 WP5-2 仍是基类型 ⇒ 用 `isNamedExemptionInitiatorEvidence()`
 *    这个类型守卫去读（**不**在判定点散落类型断言，也**不**为此改窄本字段 ——
 *    那会波及 M5.1.1 已冻结的门）。
 */
export interface ActionInvocationContext {
  readonly initiatorEvidence: TrustedActionPrincipalEvidence
  /**
   * 第二批：**任务级的风险额度**（缺省 = 组装层的 `maxRiskLevel`）。
   *
   * 它存在的唯一理由是计划书 §4 末段那句话：浏览器 R2 只在**已授权的浏览器任务**里成立，
   * 而"不为运行浏览器把所有聊天的风险上限统一升为 R2/R3"。
   *
   * ⚠️ 谁能设它：**只有任务执行环**，而且只能取自一份程序签发的任务授权
   *    （`task-authorization.ts`）。模型**没有**任何字段能把它写出来 ——
   *    它不在 `ActionRequest.arguments` 里，只在受信 ingress 的 invocation 上。
   * ⚠️ 它只能**收窄或等价**于任务授权里那个值（调用点负责），不能凭空放大：
   *    "把上限升到 R3"需要一个新的、显式的裁定，不是一个可选参数。
   */
  readonly riskBudgetOverride?: RiskLevel
}

export interface ActionGateway {
  /** Read-only current instance facts; optional for existing injected/test gateways. */
  readCapabilityFacts?(): GatewayCapabilityFacts
  execute(
    characterId: CharacterId,
    request: ActionRequest,
    invocation?: ActionInvocationContext
  ): Promise<ActionResult>
  /**
   * 只判定、不执行。
   *
   * 与 `execute` 共用**同一段**判定代码，因此"预检查说可以、
   * 真执行却拒绝"这类不一致在结构上不会出现。
   * 它**不写账本**，也永远不调用适配器。
   */
  evaluate(
    characterId: CharacterId,
    request: ActionRequest
  ): Promise<{ decision: PolicyDecision; target: ActionTarget; scopeViolation: boolean }>
  /**
   * 第二批：把**同一个**目标解析函数暴露给任务执行环。
   *
   * ==========================================================================
   *  为什么不能让任务环自己再拿一份
   * ==========================================================================
   * 计划书 §2.2 的链路要求任务步骤"逐步 ActionRequest →**既有** Registry / Policy /
   * Gateway / Adapter"。如果任务环自己再构造一个 `resolveTarget`，那"任务能碰什么"
   * 就成了**第二个权威** —— 而 ADR-031/032 的全部意义就是它只有一个。
   *
   * ⚠️ 它**只**是 `options.resolveTarget` 的转发：没有第二份实现，也没有第二份判据。
   */
  resolveTargetFor(input: {
    request: ActionRequest
    operation: OperationDefinition | undefined
  }): Promise<TargetResolution>
}

interface Preflight {
  decision: PolicyDecision
  target: ActionTarget
  scopeViolation: boolean
  targetResolved: boolean
}

/** 只有"成功达成过的后置状态"才允许被幂等重放 */
function replayable(previous: ExecutionRecordView): boolean {
  if (!previous.executed) return false
  return previous.status === 'success' || previous.status === 'partial'
}

export function createActionGateway(options: ActionGatewayOptions): ActionGateway {
  const now = options.now ?? (() => Date.now())
  const adapterByCapability = new Map<string, CapabilityAdapter>()
  for (const adapter of options.adapters) {
    if (adapterByCapability.has(adapter.capabilityId)) {
      throw new Error(`重复注册适配器：${adapter.capabilityId}`)
    }
    adapterByCapability.set(adapter.capabilityId, adapter)
  }

  async function record(write: () => Promise<ActionLedgerEvent>): Promise<ActionLedgerEvent> {
    const event = await write()
    options.onLedgerEvent?.(event)
    return event
  }

  const attributionOptions = options.attribution
  const policyAdapterId = attributionOptions?.policyAdapterId ?? 'action-policy'
  const executorAdapterId = attributionOptions?.executorAdapterId ?? 'action-adapter'

  /**
   * ADR-098：复核"这次具名豁免**确实**只落在它声明的那一格上"。
   *
   * ⚠️ 判据本体是**纯函数**（`namedExemptionViolation`，在契约模块里），
   *    这样它可以被门用**构造输入**逐条验证；这里只负责"抛错"（失败关闭，
   *    不静默降级成"没有豁免"—— 那会让"用了豁免但没生效"变成没人看得见的事）。
   */
  function assertNamedExemptionIsNarrow(request: ActionRequest, principal: PrincipalRef | null): void {
    const operation = options.registry.getOperation(request.capability, request.operation)
    const violation = namedExemptionViolation({
      principal,
      capability: request.capability,
      operation: request.operation,
      registeredSideEffect: operation?.sideEffect,
    })
    if (violation !== undefined) {
      throw new KernelError('validation_error', violation.code, violation.detail)
    }
  }

  /**
   * 这一阶段**当时**已确立的归因快照（WP5-5：阶段不可变；早期行永不被改写）。
   *
   * "哪些槽位该不该有"**只**读冻结的 `NECESSITY_MATRIX` —— Gateway 里
   * **没有**第二张事件类型矩阵（WP5-6）。
   */
  function stageAttribution(input: {
    characterId: CharacterId
    type: ActionEventType
    request: ActionRequest
    invocation: ActionInvocationContext | undefined
    /** 策略结论给出的授权依据（只有"被允许"的那条路才有） */
    authorizationBasis?: AuthorityRef
    /** 执行器是否**已经**被绑定到这次执行（false = 这一阶段没有执行器事实） */
    executorBound: boolean
  }): TrustedActionAttributionContext | undefined {
    if (attributionOptions === undefined) return undefined
    const initiatorEvidence = input.invocation?.initiatorEvidence
    if (initiatorEvidence === undefined) {
      /*
       * WP5-3：事件类型需要已知 initiator、而受信证据缺失 ⇒ **失败关闭**。
       * 不退回落 payload 的 `requestedBy`（那是自报），也不写一条没有归因的行 ——
       * 那两种做法都会让"谁发起的"重新变成猜测。
       */
      throw new KernelError(
        'validation_error',
        'action_attribution_evidence_missing',
        `动作事件 ${input.type} 需要受信 initiator 证据，但本次调用没有提供 ` +
          '（ActionInvocationContext.initiatorEvidence）—— 失败关闭，不退回 payload 自报（WP5-3）'
      )
    }

    const family = actionAttributionFamilyOf(input.type)
    const row = NECESSITY_MATRIX[family]
    /*
     * ========================================================================
     *  ADR-098：**具名豁免的收窄在判定点强制**（不在调用点自觉）
     * ========================================================================
     * 调用点"我只用它做只读检索"不算收窄。豁免必须在这里被**复核**：
     * ```text
     * ① 身份必须在**闭集**里（不在 ⇒ 具名拒绝：不允许匿名豁免）
     * ② 能力 + 操作必须与声明**逐字相同**（豁免只对那一种操作有效）
     * ③ 声明的副作级别必须是 `read`，且**实际登记的操作**也必须是 `read`
     * ```
     * ⚠️ 任何一条不满足都**抛错**（失败关闭）—— 不静默降级成"没有豁免"，
     *    因为那会让"用了豁免但没生效"变成一件没人看得见的事。
     */
    if (isNamedExemptionInitiatorEvidence(initiatorEvidence)) {
      assertNamedExemptionIsNarrow(input.request, initiatorEvidence.principal)
    }
    const authorityEvidence =
      row.authority === 'ABSENT'
        ? undefined
        : input.authorizationBasis !== undefined
          ? attestActionAuthorityFromPolicy({
              adapterId: policyAdapterId,
              authority: input.authorizationBasis,
            })
          : attestActionAuthorityFromPolicy({
              adapterId: policyAdapterId,
              authority: null,
              unresolvedReason: 'RUNTIME_UNRESOLVED',
            })

    const executorEvidence =
      row.executor === 'ABSENT'
        ? undefined
        : input.executorBound
          ? attestActionExecutorFromAdapter({
              adapterId: executorAdapterId,
              principal: {
                kind: 'SERVICE',
                id: `adapter:${input.request.capability}`,
              } as PrincipalRef,
            })
          : attestActionExecutorFromAdapter({
              adapterId: executorAdapterId,
              principal: null,
              unresolvedReason: 'RUNTIME_UNRESOLVED',
            })

    return buildTrustedActionAttribution({
      eventType: input.type,
      characterId: String(input.characterId),
      initiatorEvidence,
      actorEvidence: attestActionActorFromDecisionPoint({
        adapterId: attributionOptions.decisionPointAdapterId,
        principal: {
          kind: 'SERVICE',
          id: attributionOptions.decisionPointAdapterId,
        } as PrincipalRef,
      }),
      ...(executorEvidence !== undefined ? { executorEvidence } : {}),
      ...(authorityEvidence !== undefined ? { authorityEvidence } : {}),
    })
  }

  async function preflight(
    request: ActionRequest,
    invocation?: ActionInvocationContext
  ): Promise<Preflight> {
    const definition = options.registry.get(request.capability)
    const operation = options.registry.getOperation(request.capability, request.operation)
    /*
     * 第二批：唯一的两个注入点。
     *   · `scopeWording` —— 只改"在不在范围内"的**措辞**（不改判定）
     *   · `riskBudget`   —— 任务级额度，缺省即组装层上限（普通聊天逐字不变）
     */
    const scopeWording = options.scopeWordingFor?.(request.capability)
    const riskBudget = invocation?.riskBudgetOverride ?? options.maxRiskLevel

    /*
     * 未登记能力 / 未知操作：**不做任何 IO**。
     * 这是"未登记 = 不存在"的一种具体表现：连目标解析都不发生。
     */
    if (definition === undefined || operation === undefined) {
      const decision = evaluateActionPolicy({
        request,
        definition,
        operation,
        targetConfidence: 'none',
        scopeViolation: false,
        grantedPermissions: options.grantedPermissions,
        maxRiskLevel: riskBudget,
        dryRun: options.dryRun === true,
        ...(scopeWording !== undefined ? { scopeWording } : {}),
      })
      return {
        decision,
        target: { type: 'unknown', confidence: 'none' },
        scopeViolation: false,
        targetResolved: false,
      }
    }

    const resolution = await options.resolveTarget({ request, operation })
    const decision = evaluateActionPolicy({
      request,
      definition,
      operation,
      targetConfidence: resolution.target.confidence,
      scopeViolation: resolution.scopeViolation,
      grantedPermissions: options.grantedPermissions,
      maxRiskLevel: riskBudget,
      dryRun: options.dryRun === true,
      ...(scopeWording !== undefined ? { scopeWording } : {}),
    })

    return {
      decision,
      target: resolution.target,
      scopeViolation: resolution.scopeViolation,
      targetResolved: true,
    }
  }

  async function evaluate(
    _characterId: CharacterId,
    request: ActionRequest
  ): Promise<{ decision: PolicyDecision; target: ActionTarget; scopeViolation: boolean }> {
    const pre = await preflight(request)
    return { decision: pre.decision, target: pre.target, scopeViolation: pre.scopeViolation }
  }

  async function execute(
    characterId: CharacterId,
    request: ActionRequest,
    invocation?: ActionInvocationContext
  ): Promise<ActionResult> {
    const startedAt = now()

    /**
     * 这一阶段的归因快照（WP5-5）。`authorizationBasis` **只有**"策略已允许"的
     * 那几条路才给；矩阵说 authority 该是 Absent 的族会把它丢掉（不靠调用点记规矩）。
     */
    const stage = (
      type: ActionEventType,
      extra: { authorizationBasis?: AuthorityRef; executorBound: boolean }
    ): TrustedActionAttributionContext | undefined =>
      stageAttribution({ characterId, type, request, invocation, ...extra })
    const withAttribution = (
      context: TrustedActionAttributionContext | undefined
    ): { attribution?: TrustedActionAttributionContext } =>
      context === undefined ? {} : { attribution: context }
    /** 被允许之后的授权依据：能力已登记 + 其声明权限已由装配层授予 */
    const capabilityBasis: AuthorityRef = {
      kind: 'CAPABILITY',
      ref: request.capability,
    } as AuthorityRef

    // ⓪ 先落"她想做什么" —— 即使后面被拒，这次请求也必须可查
    await record(() =>
      options.ledger.appendRequested({
        characterId,
        request,
        ...withAttribution(stage('ACTION_REQUESTED', { executorBound: false })),
      })
    )

    const pre = await preflight(request, invocation)

    if (pre.targetResolved) {
      await record(() =>
        options.ledger.appendTargetResolved({
          characterId,
          request,
          target: pre.target,
          scopeViolation: pre.scopeViolation,
          ...withAttribution(stage('ACTION_TARGET_RESOLVED', { executorBound: false })),
        })
      )
    }

    const base = {
      actionId: request.actionId,
      traceId: request.traceId,
      capability: request.capability,
      operation: request.operation,
    }

    // ① 策略拒绝
    if (!pre.decision.allowed) {
      const failure = actionFailure(failureCodeOfDecision(pre.decision.code), pre.decision.message, {
        decision: pre.decision.code,
      })
      const status = statusOfDenial(failure)
      await record(() =>
        options.ledger.appendRejected({
          characterId,
          request,
          target: pre.target,
          decision: pre.decision,
          failure,
          status,
          // WP5-6：**被拒 = 未获授权** ⇒ authority 必须 Absent（矩阵说了算）
          ...withAttribution(stage('ACTION_REJECTED', { executorBound: false })),
        })
      )
      return {
        ...base,
        accepted: false,
        executed: false,
        status,
        evidence: [
          { kind: 'policy', detail: pre.decision.message, ref: pre.decision.code },
          ...pre.decision.checks.map((c) => ({
            kind: 'policy' as const,
            detail: `${c.name}=${c.ok ? 'ok' : 'fail'} (${c.detail})`,
          })),
        ],
        error: failure,
        startedAt,
        finishedAt: now(),
      }
    }

    const definition = options.registry.get(request.capability)!
    const operation = options.registry.getOperation(request.capability, request.operation)!
    void operation

    /*
     * 幂等键在这里**算一次**，后面所有事件都带同一个值。
     *
     * ⚠️ 它不能算在 `ACTION_REQUESTED` 上：那一步发生在**目标解析之前**
     *    （未登记能力连解析都不做），而键依赖已解析的目标。
     *    因此账本里第一个带键的事件是 `ACTION_AUTHORIZED` ——
     *    折叠会从任一事件上把它读出来，不存在"键丢了"这回事。
     */
    const effectiveKey = shouldCheckIdempotency(definition.idempotency)
      ? actionIdempotencyKey({
          capability: request.capability,
          operation: request.operation,
          ...(pre.target.canonicalId !== undefined ? { targetId: pre.target.canonicalId } : {}),
          args: request.arguments,
          ...(request.idempotencyKey !== undefined ? { provided: request.idempotencyKey } : {}),
        })
      : undefined

    await record(() =>
      options.ledger.appendAuthorized({
        characterId,
        request,
        target: pre.target,
        decision: pre.decision,
        ...(effectiveKey !== undefined ? { effectiveIdempotencyKey: effectiveKey } : {}),
        // 授权在**它真的存在**的那一刻被记录（WP5-5）
        ...withAttribution(
          stage('ACTION_AUTHORIZED', {
            authorizationBasis: capabilityBasis,
            executorBound: false,
          })
        ),
      })
    )

    /*
     * ② 幂等：命中"成功过的后置状态"则重放，**不再执行**。
     *
     * ⚠️ 刻意**不**重放没做成的那种（rejected / not_found / failed …）：
     *    那些情况下世界并没有被改变，用户重试时正确的行为是**再试一次**，
     *    而不是把上一次的失败原样再回答一遍。
     */
    if (effectiveKey !== undefined) {
      const previous = await options.ledger.findByIdempotencyKey(characterId, effectiveKey)
      if (previous !== undefined && replayable(previous)) {
        const replayed: ActionResult = {
          ...base,
          accepted: previous.accepted,
          executed: true,
          status: previous.status,
          ...(previous.effect !== undefined ? { effect: previous.effect } : {}),
          ...(previous.progress !== undefined ? { progress: previous.progress } : {}),
          evidence: [
            ...previous.evidence,
            {
              kind: 'ledger',
              detail: `幂等命中：这次没有产生新的副作用（原 action ${String(previous.actionId)}）`,
              ref: String(previous.actionId),
            },
          ],
          idempotentReplay: true,
          startedAt,
          finishedAt: now(),
        }
        if (previous.status === 'partial') {
          const progress = previous.progress ?? { completed: 0, total: 0 }
          await record(() =>
            options.ledger.appendPartial({
              characterId,
              request,
              target: pre.target,
              ...(replayed.effect !== undefined ? { effect: replayed.effect } : {}),
              evidence: replayed.evidence ?? [],
              progress,
              effectiveIdempotencyKey: effectiveKey,
              /*
               * 幂等重放：这一次**没有**把工作交给任何执行器（WP5-5 / WP5-9）。
               * executor 仍然要"表态"（矩阵：ALLOWED_UNKNOWN），但内容是
               * `Unknown(RUNTIME_UNRESOLVED)` —— 不是"某个执行器做的"。
               */
              ...withAttribution(
                stage('ACTION_PARTIAL', {
                  authorizationBasis: capabilityBasis,
                  executorBound: false,
                })
              ),
            })
          )
        } else {
          await record(() =>
            options.ledger.appendSucceeded({
              characterId,
              request,
              target: pre.target,
              ...(replayed.effect !== undefined ? { effect: replayed.effect } : {}),
              evidence: replayed.evidence ?? [],
              idempotentReplay: true,
              effectiveIdempotencyKey: effectiveKey,
              ...withAttribution(
                stage('ACTION_SUCCEEDED', {
                  authorizationBasis: capabilityBasis,
                  executorBound: false,
                })
              ),
            })
          )
        }
        return replayed
      }
    }

    // ③ 执行
    const adapter = adapterByCapability.get(request.capability)
    if (adapter === undefined) {
      const failure = actionFailure(
        'unsupported',
        `能力 ${request.capability} 已登记但没有适配器 —— 这是装配错误，不是用户错误`
      )
      await record(() =>
        options.ledger.appendFailed({
          characterId,
          request,
          target: pre.target,
          failure,
          status: 'rejected',
          ...(effectiveKey !== undefined ? { effectiveIdempotencyKey: effectiveKey } : {}),
          // 没有适配器 = 装配错误，**什么都没执行** ⇒ executor 未定
          ...withAttribution(
            stage('ACTION_FAILED', {
              authorizationBasis: capabilityBasis,
              executorBound: false,
            })
          ),
        })
      )
      return {
        ...base,
        accepted: true,
        executed: false,
        status: 'rejected',
        error: failure,
        startedAt,
        finishedAt: now(),
      }
    }

    await record(() =>
      options.ledger.appendStarted({
        characterId,
        request,
        target: pre.target,
        ...(effectiveKey !== undefined ? { effectiveIdempotencyKey: effectiveKey } : {}),
        /*
         * 执行阶段开始：执行器**在这一刻**被绑定（但"绑定了"不等于"执行成功" ——
         * WP5-9：Known executor DOES NOT imply executed）。
         */
        ...withAttribution(
          stage('ACTION_STARTED', {
            authorizationBasis: capabilityBasis,
            executorBound: true,
          })
        ),
      })
    )

    let outcome: AdapterOutcome
    try {
      /*
       * ADR-146：委派 vs 本地 —— **在这里**二选一，而不是在适配器里。
       * ⚠️ `delegator` 返回 `undefined`（没装 / 执行端不在线）⇒ 走下面那条，逐字旧行为。
       * ⚠️ 注意它拿到的是 **`pre.decision`** —— 那份判定**已经在上一步跑完了**，
       *    所以委派**不重算**任何东西，它只是"把已经允许的事换个地方做"。
       */
      const delegator = options.delegator?.(request, pre.decision)
      if (delegator !== undefined) {
        outcome = await delegator.send(request, pre.decision)
      } else {
        outcome = await adapter.execute({
          actionId: request.actionId,
          operation: request.operation,
          target: pre.target,
          args: request.arguments,
          /* ADR-110 `D05`：幂等键**原样**转给适配器（它不在 args 里，模型写不出来） */
          ...(request.idempotencyKey === undefined ? {} : { idempotencyKey: request.idempotencyKey }),
          now,
        })
      }
    } catch (error) {
      const failure =
        error instanceof ActionFailureError ? error.failure : normalizeAdapterError(error)
      const status = statusOfAdapterFailure(failure)
      const keyArg = effectiveKey !== undefined ? { effectiveIdempotencyKey: effectiveKey } : {}
      if (status === 'cancelled') {
        await record(() =>
          options.ledger.appendCancelled({
            characterId,
            request,
            target: pre.target,
            failure,
            ...keyArg,
            ...withAttribution(
              stage('ACTION_CANCELLED', {
                authorizationBasis: capabilityBasis,
                executorBound: true,
              })
            ),
          })
        )
      } else {
        await record(() =>
          options.ledger.appendFailed({
            characterId,
            request,
            target: pre.target,
            failure,
            status,
            ...keyArg,
            ...withAttribution(
              stage('ACTION_FAILED', {
                authorizationBasis: capabilityBasis,
                executorBound: true,
              })
            ),
          })
        )
      }
      return {
        ...base,
        accepted: true,
        executed: true,
        status,
        evidence: [{ kind: 'adapter', detail: `适配器抛出：${failure.code}` }],
        error: failure,
        startedAt,
        finishedAt: now(),
      }
    }

    if (isAdapterFailure(outcome)) {
      const status = statusOfAdapterFailure(outcome.failure)
      await record(() =>
        options.ledger.appendFailed({
          characterId,
          request,
          target: pre.target,
          failure: outcome.failure,
          status,
          ...(effectiveKey !== undefined ? { effectiveIdempotencyKey: effectiveKey } : {}),
          ...withAttribution(
            stage('ACTION_FAILED', {
              authorizationBasis: capabilityBasis,
              executorBound: true,
            })
          ),
        })
      )
      return {
        ...base,
        accepted: true,
        executed: true,
        status,
        error: outcome.failure,
        startedAt,
        finishedAt: now(),
      }
    }

    const evidence = evidenceOf(outcome)

    // ④ 部分成功（§28）：**不能**降级成 success
    if (outcome.partial !== undefined) {
      const progress = outcome.partial
      await record(() =>
        options.ledger.appendPartial({
          characterId,
          request,
          target: pre.target,
          ...(outcome.effect !== undefined ? { effect: outcome.effect } : {}),
          evidence,
          progress: {
            completed: progress.completed,
            total: progress.total,
            ...(progress.detail !== undefined ? { detail: progress.detail } : {}),
          },
          ...(effectiveKey !== undefined ? { effectiveIdempotencyKey: effectiveKey } : {}),
          ...withAttribution(
            stage('ACTION_PARTIAL', {
              authorizationBasis: capabilityBasis,
              executorBound: true,
            })
          ),
        })
      )
      return {
        ...base,
        accepted: true,
        executed: true,
        status: 'partial',
        ...(outcome.effect !== undefined ? { effect: outcome.effect } : {}),
        /*
         * M5.5：外部证据只在**当轮内存**里继续往下走（唯一载体是 ActionResult）。
         * 账本那边收的是 `evidence[]` 里的引用 —— 见下面 appendPartial 的 evidence。
         */
        ...(outcome.externalEvidence !== undefined
          ? { externalEvidence: outcome.externalEvidence }
          : {}),
        /*
         * 实用能力加装：**当轮内容**的当轮内存载体（含正文）。
         * 账本那边收的仍然只有 `evidence[]` —— 正文不经帐本，边界靠类型（见契约文件头）。
         */
        ...(outcome.turnContent !== undefined ? { turnContent: outcome.turnContent } : {}),
        evidence,
        progress: {
          completed: progress.completed,
          total: progress.total,
          ...(progress.detail !== undefined ? { detail: progress.detail } : {}),
        },
        error: actionFailure(
          'partial_success',
          progress.detail ?? `完成 ${progress.completed}/${progress.total}`
        ),
        startedAt,
        finishedAt: now(),
      }
    }

    await record(() =>
      options.ledger.appendSucceeded({
        characterId,
        request,
        target: pre.target,
        ...(outcome.effect !== undefined ? { effect: outcome.effect } : {}),
        evidence,
        ...(effectiveKey !== undefined ? { effectiveIdempotencyKey: effectiveKey } : {}),
        ...withAttribution(
          stage('ACTION_SUCCEEDED', {
            authorizationBasis: capabilityBasis,
            executorBound: true,
          })
        ),
      })
    )

    return {
      ...base,
      accepted: true,
      executed: true,
      status: 'success',
      ...(outcome.effect !== undefined ? { effect: outcome.effect } : {}),
      /* M5.5：外部证据的**当轮内存载体**（含摘要）；账本只收引用（上面的 evidence） */
      ...(outcome.externalEvidence !== undefined
        ? { externalEvidence: outcome.externalEvidence }
        : {}),
      /* 实用能力加装：当轮内容的**当轮内存载体**（含正文）；账本只收引用 */
      ...(outcome.turnContent !== undefined ? { turnContent: outcome.turnContent } : {}),
      evidence,
      startedAt,
      finishedAt: now(),
    }
  }

  const lastResults = new Map<string, ObservedCapabilityResult>()
  return {
    async execute(characterId, request, invocation) {
      const result = await execute(characterId, request, invocation)
      if (options.registry.has(result.capability)) lastResults.set(result.capability, {
        actionId: String(result.actionId), operation: result.operation, status: result.status,
        accepted: result.accepted, executed: result.executed, idempotentReplay: result.idempotentReplay === true,
        observedAt: now(),
      })
      return result
    },
    readCapabilityFacts: () => ({ adapterIds: [...adapterByCapability.keys()],
      grantedPermissions: [...options.grantedPermissions], maxRiskLevel: options.maxRiskLevel, dryRun: options.dryRun === true,
      lastResults: Object.fromEntries([...lastResults].map(([id, result]) => [id, { ...result }])) }),
    evaluate,
    /*
     * 第二批：**转发**给同一个 `options.resolveTarget`（不是第二份实现）。
     * 它存在的唯一目的是让任务执行环用上装配层交给 Gateway 的那一份，
     * 从而"任务能碰什么"与"单动作能碰什么"永远是同一个答案。
     */
    resolveTargetFor: (input) => options.resolveTarget(input),
  }
}

/** 拒绝时的状态：`not_found` / `ambiguous` 与 `rejected` 对用户是不同的信息 */
export function statusOfDenial(failure: ActionFailure): ActionStatus {
  switch (failure.code) {
    case 'target_not_found':
      return 'not_found'
    case 'target_ambiguous':
    case 'target_uncertain':
      return 'ambiguous'
    default:
      return 'rejected'
  }
}

export function statusOfAdapterFailure(failure: ActionFailure): ActionStatus {
  switch (failure.code) {
    case 'target_not_found':
      return 'not_found'
    case 'target_ambiguous':
    case 'target_uncertain':
      return 'ambiguous'
    case 'timeout':
      return 'timeout'
    case 'cancelled':
      return 'cancelled'
    case 'partial_success':
      return 'partial'
    case 'validation_failed':
    case 'permission_denied':
    case 'unsupported':
      return 'rejected'
    case 'execution_failed':
      return 'failed'
  }
}

export type { ActionEffect, ActionEvidence }
