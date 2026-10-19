/**
 * ActionRequest —— **唯一执行入口的输入值**（M4.5 / ADR-030）。
 *
 * ============================================================================
 *  为什么它是一个"值"，而不是一次函数调用
 * ============================================================================
 * 把"想做什么"先变成一份可检查的数据，才有三件可能：
 *
 *   1. **先判定后执行**：目标解析与策略判定发生在任何 IO 之前（ADR-032）
 *   2. **可重放**：同一个请求可以离线断言"它会被允许吗"
 *   3. **可审计**：请求本身（含目标与证据）进 Execution Ledger
 *
 * 因此这个文件里**没有任何 IO、没有任何执行** —— 只有形状与校验。
 */

import type { ActionId, Timestamp, TraceId } from '../contracts/ids.ts'
import type { ExternalEvidenceRef } from '../contracts/external-evidence.ts'

// ---------------------------------------------------------------------------
// 副作用与风险
// ---------------------------------------------------------------------------

/**
 * 副作用等级。
 *
 * 它决定**目标确定性的门槛**（ADR-032）：
 *   · `none` / `read` —— 结果不会改变世界，`weak` / `none` 目标也可以执行
 *   · `write` / `destructive` —— 必须有 `exact` / `strong` 目标才允许执行
 *
 * ⚠️ 门槛写在 `policy.ts` 里，而**根据**是这个字段。
 *    适配器不允许自己解释它。
 */
export type SideEffectLevel = 'none' | 'read' | 'write' | 'destructive'

/**
 * 风险等级（计划书 §25）。
 *
 * ```text
 * R0 = pure read
 * R1 = local reversible write
 * R2 = external reversible action
 * R3 = destructive / public / costly
 * ```
 */
export type RiskLevel = 'R0' | 'R1' | 'R2' | 'R3'

export const RISK_LEVELS: readonly RiskLevel[] = ['R0', 'R1', 'R2', 'R3']

/** 数值化排序（策略里比较大小用；字符串比大小会得到 `R10 < R2` 那类 bug） */
export function riskRank(level: RiskLevel): number {
  switch (level) {
    case 'R0':
      return 0
    case 'R1':
      return 1
    case 'R2':
      return 2
    case 'R3':
      return 3
  }
}

/**
 * 一个**副作用等级**至少对应什么风险等级。
 *
 * 这不是策略（策略在 `policy.ts`），而是**声明合法性**：
 * 一个 `destructive` 的能力如果声明自己是 R1，那份声明是错的 ——
 * 登记口据此拒绝它（ADR-031）。
 */
export function riskFloorOf(sideEffect: SideEffectLevel): RiskLevel {
  switch (sideEffect) {
    case 'none':
      return 'R0'
    case 'read':
      return 'R0'
    case 'write':
      return 'R1'
    case 'destructive':
      return 'R3'
  }
}

/** 有副作用 = 世界会因此改变。目标确定性门槛只对它生效（ADR-032）。 */
export function hasSideEffect(sideEffect: SideEffectLevel): boolean {
  return sideEffect === 'write' || sideEffect === 'destructive'
}

// ---------------------------------------------------------------------------
// 目标
// ---------------------------------------------------------------------------

/**
 * 目标确定等级（计划书 §8）。
 *
 * ⚠️ `strong` 需要**两个条件**：候选唯一 **且** 有词面相关性证据。
 *    "候选只有一个所以就是它"正是 M4/D1 的错误（ADR-032）。
 */
export type TargetConfidence = 'exact' | 'strong' | 'weak' | 'none'

/** 目标证据：为什么系统认为"目标就是它"（或"不确定"） */
export interface TargetEvidence {
  kind:
    | 'explicit_id'
    | 'exact_path'
    | 'unique_basename'
    | 'request_mention'
    | 'ambiguous_candidates'
    | 'no_candidate'
    | 'scope_violation'
  /** 人类可读说明。**不含文件内容**（计划书 §110 的隐私纪律） */
  detail: string
}

export interface ActionTarget {
  /** 目标类型，如 `sandbox_file`（未来：`message_recipient` / `task` / …） */
  type: string
  /** 稳定标识（沙箱内就是相对路径）。作用于**未解析出**时必须缺省 */
  canonicalId?: string
  displayName?: string
  confidence: TargetConfidence
  evidence?: TargetEvidence[]
}

// ---------------------------------------------------------------------------
// 效果与证据
// ---------------------------------------------------------------------------

/** 副作用**实际**发生在哪里（`ActionResult.effect`） */
export interface ActionEffect {
  kind:
    | 'none'
    | 'echo'
    | 'file_created'
    | 'file_overwritten'
    | 'content_read'
    | 'no_change'
    /**
     * post-Lv2 / ADR-110 `D05`：**一条消息交给外部通道了**。
     *
     * ⚠️ 逐字读法：它说的是"**已交给外壳去投递**"，**不**是"对方收到了"。
     *    平台结局（`api_accepted` / `failed_confirmed` / `delivery_unknown`）由回执写进
     *    通知实例，**不**回写账本 —— 账本是"她做过什么"的账，不是平台状态表。
     * ⚠️ 指纹用的是**正文指纹**（`notificationTextFingerprint`），正文本身**永不进账本**（`D09`）。
     */
    | 'message_sent'
    /**
     * A1 / WP4：**登记了一个后台任务**（管理控制台 `admin.jobs.admit` / `register`）。
     *
     * ⚠️ 逐字读法：它说的是"**已登记**"，**不**是"已执行"。今天**没有执行器**去跑它
     *    ⇒ 状态停在 `pending`；界面文案是「已提交（尚未执行）」（`jobStateLabel('pending')`）。
     *    把"已登记"说成"已完成"就是本仓库最忌讳的那种表述漂移。
     * ⚠️ `fingerprint` 用的是 **jobId**；**参数取值永不进账本**（与 `D09` 同一条纪律）。
     * ⚠️ 先例：`message_sent` 当初就是为 QQ 投递**新增**的 —— 这个闭集是**按需扩**的，
     *    不是"只能来自最初那批用例"。
     */
    | 'job_registered'
    /**
     * ADR-146：**委派给 PC 执行端执行**。
     *
     * ⚠️ 逐字读法：它说的是"**已把请求交出去**"，**不**是"PC 那边做完了"。
     *    执行结局（`completed` / `rejected` / `failed_confirmed` / `unknown`）
     *    由 `ACTION_RESULT` 回执持有，**不回写**这条 —— 与 `message_sent` 同一条纪律：
     *    账本是"她做过什么"的账，不是远端状态表。
     * ⚠️ 按上面 `message_sent` 的先例**新增**（"这个闭集按需扩"），不是替换既有值。
     */
    | 'action_delegated'
    /** PC execution receipt confirmed completion before the terminal ledger event. */
    | 'action_completed_remote'
  /** 人类可读说明 */
  detail?: string
  /** 机器可比对的指纹（如文件内容的 sha256 前缀）—— "外部状态真的变了吗"的判据 */
  fingerprint?: string
  bytes?: number
}

/** 结果证据：凭什么说它成功了 / 失败了 */
export interface ActionEvidence {
  kind: 'filesystem' | 'adapter' | 'ledger' | 'policy'
  detail: string
  /** 可选引用（相对路径、事件 id、actionId…） */
  ref?: string
  /**
   * M5.5（ADR-045 `D-8`）：**外部证据的引用** —— 没有 `snippet`，只有
   * id / provider / 来源 / 时间 / 指纹 / 标签。
   *
   * ⚠️ 账本落的就是这个对象：它是"摘要正文不进账本"的**结构性**保证，
   *    而不是"写日志时记得别带正文"。
   */
  externalEvidence?: ExternalEvidenceRef
}

// ---------------------------------------------------------------------------
// 请求本体
// ---------------------------------------------------------------------------

/**
 * **兼容 / 输入证据**字段的形状（**不是**权威归因）。
 *
 * ⚠️ 它**不是** `initiator`：`requestedBy` 是请求方自报的输入证据，
 *    权威 `initiator` 只能由受信 ingress 产出的证据建立（WP5-2 / WP5-4）。
 *    这个字段保留是为了兼容既有调用点与 payload —— 它**不再**是 RECORDED 行的
 *    权威来源。
 *
 * WP5-4（2026-09-18）：**补上 `tool`**。冻结的 §3.3 分类早就写着
 * "其 kind 只有 user|character|system（**缺 tool**）⇒ 部分确定" ——
 * 也就是说"工具发起的动作"在兼容契约里**表达不出来**。这里只做**最小扩展**：
 * 加一个取值，而**不**建立 `PrincipalKind → ActionRequester` 的投影
 * （那会变成第二份权威；权威槽位由 `attribution.ts` 承担）。
 */
export interface ActionRequester {
  kind: 'user' | 'character' | 'system' | 'tool'
  id?: string
}

export interface ActionRequest {
  actionId: ActionId
  traceId: TraceId

  /** 能力 id，如 `sandbox.file.write`（必须已在 CapabilityRegistry 登记） */
  capability: string
  /** 能力内的操作名，如 `write` */
  operation: string

  requestedBy: ActionRequester

  /**
   * 目标。**可以缺省** —— 那表示"请求方还没给出目标"，
   * 由 TargetResolver 从参数与文本里解析（ADR-032）。
   */
  target?: ActionTarget

  /** 结构化参数（路径、内容…）。**不含密钥**：它会进账本 */
  arguments: Record<string, unknown>

  sideEffect: SideEffectLevel

  /**
   * 幂等键（计划书 §26）。
   *
   * `undefined` 表示"这次调用没有声明幂等语义"，由 Gateway 按能力的
   * `idempotency` 声明决定怎么办：
   *   · `none`      → 允许缺省
   *   · `supported` → 缺省时由 Gateway 从参数推导（相同请求 → 相同键）
   *   · `required`  → 缺省即拒绝（`validation_failed`）
   */
  idempotencyKey?: string

  createdAt: Timestamp
}

// ---------------------------------------------------------------------------
// 构造与校验
// ---------------------------------------------------------------------------

export interface NewActionRequest {
  actionId: ActionId
  traceId: TraceId
  capability: string
  operation: string
  requestedBy: ActionRequester
  target?: ActionTarget
  arguments?: Record<string, unknown>
  sideEffect: SideEffectLevel
  idempotencyKey?: string
  createdAt?: Timestamp
}

/**
 * 构造一个请求。
 *
 * 校验是**最小必要**的：只拒绝"写不出正确东西"的形状
 * （空能力名 / 空操作名 / 非法副作用等级）。
 * 更细的判定（能力是否存在、目标够不够确定、权限够不够）
 * 属于 Gateway 与 Policy —— 它们的结论要**进账本**，
 * 而在这里抛错就什么都不会被记下来。
 */
export function createActionRequest(input: NewActionRequest): ActionRequest {
  if (input.capability.trim() === '') {
    throw new Error('ActionRequest.capability 不能为空')
  }
  if (input.operation.trim() === '') {
    throw new Error('ActionRequest.operation 不能为空')
  }
  if (!['none', 'read', 'write', 'destructive'].includes(input.sideEffect)) {
    throw new Error(`ActionRequest.sideEffect 非法：${String(input.sideEffect)}`)
  }
  if (
    input.requestedBy.kind !== 'user' &&
    input.requestedBy.kind !== 'character' &&
    input.requestedBy.kind !== 'system' &&
    input.requestedBy.kind !== 'tool'
  ) {
    throw new Error(`ActionRequest.requestedBy.kind 非法：${String(input.requestedBy.kind)}`)
  }

  return {
    actionId: input.actionId,
    traceId: input.traceId,
    capability: input.capability,
    operation: input.operation,
    requestedBy: input.requestedBy,
    ...(input.target !== undefined ? { target: input.target } : {}),
    arguments: input.arguments ?? {},
    sideEffect: input.sideEffect,
    ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
    createdAt: input.createdAt ?? Date.now(),
  }
}

/** 供账本与日志使用的稳定摘要（**不序列化 Live 对象**，只取叶子字段） */
export function describeActionTarget(target: ActionTarget | undefined): string {
  if (target === undefined) return '(no target)'
  const id = target.canonicalId ?? target.displayName ?? '(unnamed)'
  return `${target.type}:${id} (${target.confidence})`
}
