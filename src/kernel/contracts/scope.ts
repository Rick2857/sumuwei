/**
 * Scope —— **多用户作用域与授权契约**（补充计划 X0 / U1）。
 *
 * ============================================================================
 *  ADR-133（ACCEPTED / DESIGN FROZEN，2026-10-13 原主人逐项裁定）
 * ============================================================================
 * 本文件是 X0 契约的**代码层**：只定义语义与纯判定，不实现任何 store、不动任何表。
 *
 * 契约正文：docs/post-lv2/Multi-User-Scope-Contract.md
 *   §1 ScopeContext（身份 × 用途 × 空间）
 *   §2 权限矩阵（principal × operation）
 *   §3 可见性归属（DisclosureClass / VisibilityLabel）
 *
 * ---------------------------------------------------------------------------
 *  三条不许破的规矩（契约 §1 的 SC-01…SC-05）
 * ---------------------------------------------------------------------------
 * 1. `ScopeContext` **只能**由后端可信身份生成；入口层**不得**接受调用方自报的 principal/room。
 *    ⇒ 本文件不提供"从请求体构造 ScopeContext"的任何入口。
 * 2. 缺身份、缺用途或用途与身份不匹配 ⇒ **拒绝**（失败关闭），**不**回退默认用户。
 *    ⇒ 一切未知组合都落到具名拒绝码，没有"默认允许"。
 * 3. `system` principal 的用途**只能**是 `internal_cognition`。
 *    ⇒ 内部认知的必要读取**不**变成任何用户的查询权限。
 *
 * ⚠️ **本文件不改冻结层**：它不认识 MemoryRecord / RelationshipState / AffectState，
 *    只回答"这个三元组能不能做这个操作"。接线与过滤在 U1 的后续包。
 */

import { KernelError } from './ids.ts'

// ---------------------------------------------------------------------------
// §1 主体（Principal）
// ---------------------------------------------------------------------------

/** 原主人特权的**可信来源**。会话/cookie/请求载荷都**不**在此列。 */
export type OwnerVerifiedBy = 'config_binding' | 'admin_session'

/** 普通用户身份的可信来源。**昵称/群名片/会话 ID/自报身份都不在列**。 */
export type UserVerifiedBy = 'onebot_inbound' | 'wechat_inbound' | 'admin_session'

export interface OwnerPrincipal {
  readonly kind: 'owner'
  readonly userId: string
  readonly verifiedBy: OwnerVerifiedBy
}

export interface UserPrincipal {
  readonly kind: 'user'
  readonly userId: string
  readonly verifiedBy: UserVerifiedBy
}

/**
 * 内部认知消费者。**它们不是"某个用户"**：
 * 情绪 / 关系 / 信念 / 反思 / 目标 / 摘要 / 主动联系 / 调度。
 */
export type SystemSubsystem =
  | 'affect'
  | 'relationship'
  | 'belief'
  | 'reflection'
  | 'goal'
  | 'rollup'
  | 'proactive'
  | 'scheduler'

export interface SystemPrincipal {
  readonly kind: 'system'
  readonly subsystem: SystemSubsystem
}

export type Principal = OwnerPrincipal | UserPrincipal | SystemPrincipal

export const SYSTEM_SUBSYSTEMS: readonly SystemSubsystem[] = [
  'affect',
  'relationship',
  'belief',
  'reflection',
  'goal',
  'rollup',
  'proactive',
  'scheduler',
]

// ---------------------------------------------------------------------------
// §1 用途（Purpose）与空间（Room）
// ---------------------------------------------------------------------------

/**
 * 用途是**授权的第二个轴**，不是标签。
 *
 * - `external_query`   对外查询/回吐给用户（受可见性约束）
 * - `internal_cognition` 只用于形成角色状态，**不向任何用户回吐原文**
 * - `admin_operation`  管理通路（原主人特权 / 后台）
 */
export type Purpose = 'external_query' | 'internal_cognition' | 'admin_operation'

export const PURPOSES: readonly Purpose[] = [
  'external_query',
  'internal_cognition',
  'admin_operation',
]

/** 交流空间。**群号只决定空间，绝不写进 userId**（契约 D04）。 */
export type Room =
  | { readonly kind: 'private'; readonly userId: string }
  | { readonly kind: 'group'; readonly groupId: string }

export interface ScopeContext {
  readonly principal: Principal
  readonly purpose: Purpose
  readonly room: Room
}

// ---------------------------------------------------------------------------
// §1 判定形状
// ---------------------------------------------------------------------------

/**
 * 具名拒绝码（**闭集**）。顺序即判定顺序（契约 §2 末的 ①–⑥）。
 *
 * ⚠️ 每个码都必须**可复现**：门里对每个码都有一个只触发它的用例。
 */
export type ScopeDenyCode =
  | 'invalid_context' // 形状不合法（缺字段/空 id/未知枚举）
  | 'identity_unverified' // ① principal 不可信
  | 'purpose_not_granted' // ② 用途与身份不匹配
  | 'room_not_authorized' // ③ 空间不在授权集（群白名单/私聊归属）
  | 'operation_not_permitted' // ④ 该格不允许
  | 'condition_not_met' // ⑤ 条件不满足（印象门槛 / 原主人例外 / 额度）
  | 'scope_leak' // ⑥ 目标不属于本主体

export interface ScopeCheck {
  readonly name: string
  readonly ok: boolean
  readonly detail: string
}

export interface ScopeDecision {
  readonly allowed: boolean
  readonly code: 'allowed' | ScopeDenyCode
  readonly detail: string
  readonly checks: readonly ScopeCheck[]
}

/**
 * 契约 §2 的 operation 闭集。
 *
 * ⚠️ 它是**授权面**，不是能力注册表：这里多一个操作，就多一格必须给出判定的矩阵。
 */
export type ScopeOperation =
  | 'read_own_private_memory'
  | 'read_other_private_memory'
  | 'read_current_group_material'
  | 'read_other_group_material'
  | 'impression_query'
  | 'perceive_affect_state'
  | 'read_affect_cause'
  | 'write_own_memory'
  | 'write_other_memory'
  | 'modify_relationship'
  | 'modify_persona'
  | 'create_or_reset_archive'
  | 'high_risk_tool'
  | 'controlled_query_tool'
  | 'limited_roleplay'
  | 'admin_read'
  | 'admin_operate'
  | 'internal_cognition_read'

export const SCOPE_OPERATIONS: readonly ScopeOperation[] = [
  'read_own_private_memory',
  'read_other_private_memory',
  'read_current_group_material',
  'read_other_group_material',
  'impression_query',
  'perceive_affect_state',
  'read_affect_cause',
  'write_own_memory',
  'write_other_memory',
  'modify_relationship',
  'modify_persona',
  'create_or_reset_archive',
  'high_risk_tool',
  'controlled_query_tool',
  'limited_roleplay',
  'admin_read',
  'admin_operate',
  'internal_cognition_read',
]

/** 一格判定：放行 / 拒绝 / **条件放行**（条件由调用方以程序事实提供，缺省=拒绝） */
export type MatrixCell = 'allow' | 'deny' | 'conditional'

/**
 * 权限矩阵（契约 §2 的表，**逐格**）。
 *
 * ⚠️ 这张表是**唯一权威**：判定函数不写死任何一格，只查表 + 套条件。
 *    门的"矩阵完整性"判据保证：任何 operation 在任一 principal 下都有格（缺格=拒绝，不是默认允许）。
 */
export const SCOPE_MATRIX: Readonly<Record<Principal['kind'], Readonly<Partial<Record<ScopeOperation, MatrixCell>>>>> = {
  owner: {
    read_own_private_memory: 'allow',
    read_other_private_memory: 'allow', // 原主人特权：走独立入口 + 审计（§D12）
    read_current_group_material: 'allow',
    read_other_group_material: 'allow',
    impression_query: 'allow',
    perceive_affect_state: 'allow',
    read_affect_cause: 'allow',
    write_own_memory: 'allow',
    write_other_memory: 'conditional', // 受控、留痕
    modify_relationship: 'deny', // MAINTENANCE_INJECTION 失败关闭（M7）
    modify_persona: 'deny', // 须独立流程 + 版本/指纹
    create_or_reset_archive: 'conditional', // 原主人具名、可信、留审计的管理通路
    high_risk_tool: 'allow', // 按既有授权轴（policy.ts），本矩阵只回答"principal 层面"
    controlled_query_tool: 'allow',
    limited_roleplay: 'allow',
    admin_read: 'allow',
    admin_operate: 'allow',
    internal_cognition_read: 'allow',
  },
  user: {
    read_own_private_memory: 'allow',
    read_other_private_memory: 'deny',
    // ⚠️ "仅当前群"这个条件**由判定顺序 ③（room 授权）承担**：矩阵格是 allow，
    //    群白名单/成员资格由 `roomAuthorized` 提供；缺省=未授权 ⇒ 失败关闭。
    //    不把同一条件再写成 conditional（那会变成重复计数）。
    read_current_group_material: 'allow',
    read_other_group_material: 'deny',
    impression_query: 'conditional', // 门槛：originated 且有效 trust>0.4 AND closeness>0.4
    perceive_affect_state: 'allow',
    read_affect_cause: 'deny',
    write_own_memory: 'allow',
    write_other_memory: 'deny',
    modify_relationship: 'deny',
    modify_persona: 'deny',
    create_or_reset_archive: 'deny', // 唯一存档：普通用户不得开第二档
    high_risk_tool: 'deny',
    controlled_query_tool: 'conditional', // 额度/并发受部署总账约束
    limited_roleplay: 'conditional', // 关系相符范围（双 >0.25）
    admin_read: 'deny',
    admin_operate: 'deny',
    internal_cognition_read: 'deny',
  },
  system: {
    read_own_private_memory: 'deny', // system 没有"自己的"私聊
    read_other_private_memory: 'deny', // **不得**把原文回吐给任何用户
    // 空间授权同样由 ③ 承担（见 user 侧注释）
    read_current_group_material: 'allow',
    read_other_group_material: 'conditional',
    impression_query: 'deny', // 不是查询面
    perceive_affect_state: 'allow',
    read_affect_cause: 'conditional', // 内部可读成因，但不回吐
    write_own_memory: 'deny', // 写入走既有归属链，不由 system 直写
    write_other_memory: 'deny',
    modify_relationship: 'deny', // 只由真实互动事件驱动
    modify_persona: 'deny',
    create_or_reset_archive: 'deny',
    high_risk_tool: 'deny',
    controlled_query_tool: 'deny',
    limited_roleplay: 'deny',
    admin_read: 'deny',
    admin_operate: 'deny',
    internal_cognition_read: 'allow',
  },
}

// ---------------------------------------------------------------------------
// §1 判定输入
// ---------------------------------------------------------------------------

export interface OwnerExceptionGrant {
  /** 只认**原主人亲自、可信身份**下的明确授权（契约 D22 / S0 `EX-1`） */
  readonly granted: true
  /** 具体用例/风险/范围/有效期的记录 id（留审计） */
  readonly caseId: string
}

export interface ScopeAccessInput {
  readonly context: ScopeContext
  readonly operation: ScopeOperation
  /** 操作对象（读他人/写他人时必填）；缺失即拒绝，不猜 */
  readonly targetUserId?: string
  /** 空间是否在授权集（群白名单 / 私聊归属）——由程序事实提供，缺省=未授权 */
  readonly roomAuthorized?: boolean
  /** 条件是否满足（印象门槛 / 演戏门槛 / 额度）——由程序事实提供，缺省=不满足 */
  readonly conditionMet?: boolean
  /** 原主人具名例外（仅 `create_or_reset_archive` 用） */
  readonly ownerException?: OwnerExceptionGrant
}

// ---------------------------------------------------------------------------
// 判定
// ---------------------------------------------------------------------------

function deny(code: ScopeDenyCode, detail: string, checks: ScopeCheck[]): ScopeDecision {
  return { allowed: false, code, detail, checks }
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

/** 形状校验（**不**从外部数据构造，只校验已经被装配根构造出来的三元组） */
export function scopeContextProblems(context: ScopeContext): string[] {
  const problems: string[] = []
  const { principal, purpose, room } = context
  if (principal === undefined || typeof principal !== 'object') {
    problems.push('principal 缺失')
    return problems
  }
  if (!PURPOSES.includes(purpose)) problems.push(`purpose 未知：${String(purpose)}`)
  if (principal.kind === 'owner') {
    if (!isNonEmpty(principal.userId)) problems.push('owner.userId 为空')
  } else if (principal.kind === 'user') {
    if (!isNonEmpty(principal.userId)) problems.push('user.userId 为空')
  } else if (principal.kind === 'system') {
    if (!SYSTEM_SUBSYSTEMS.includes(principal.subsystem)) {
      problems.push(`system.subsystem 未知：${String(principal.subsystem)}`)
    }
  } else {
    problems.push(`principal.kind 未知：${String((principal as { kind?: unknown }).kind)}`)
  }
  if (room === undefined || typeof room !== 'object') {
    problems.push('room 缺失')
  } else if (room.kind === 'private') {
    if (!isNonEmpty(room.userId)) problems.push('room.private.userId 为空')
  } else if (room.kind === 'group') {
    if (!isNonEmpty(room.groupId)) problems.push('room.group.groupId 为空')
  } else {
    problems.push(`room.kind 未知：${String((room as { kind?: unknown }).kind)}`)
  }
  return problems
}

/**
 * 构造一个 `ScopeContext`。
 *
 * ⚠️ 它**只**做形状校验：调用方必须已经在可信链上确定了身份（装配根/入口解析器），
 *    **不得**把请求体里的字段直接喂进来（契约 `SC-01`）。
 */
export function scopeContextOf(context: ScopeContext): ScopeContext {
  const problems = scopeContextProblems(context)
  if (problems.length > 0) {
    throw new KernelError('validation_error', 'scope_context_invalid', problems.join('；'))
  }
  return context
}

/**
 * **唯一**授权判定（契约 §2 的 ①–⑥ 顺序，失败即拒，不继续）。
 *
 * 失败关闭：未知 principal / 未知 purpose / 未知 operation / 缺条件 ⇒ 拒绝。
 */
export function evaluateScopeAccess(input: ScopeAccessInput): ScopeDecision {
  const checks: ScopeCheck[] = []
  const { context, operation } = input

  // ⓪ 形状
  const shapeProblems = scopeContextProblems(context)
  if (shapeProblems.length > 0) {
    checks.push({ name: 'context_shape', ok: false, detail: shapeProblems.join('；') })
    return deny('invalid_context', '作用域三元组形状不合法', checks)
  }
  if (!SCOPE_OPERATIONS.includes(operation)) {
    checks.push({ name: 'operation_registered', ok: false, detail: `未知操作：${String(operation)}` })
    return deny('invalid_context', '操作未登记（未登记不是默认允许）', checks)
  }
  checks.push({ name: 'context_shape', ok: true, detail: `${context.principal.kind}/${context.purpose}/${context.room.kind}` })

  // ① 身份可信：`verifiedBy` 必须在闭集内。**自报/伪造的身份在这里被拒**（契约 `SC-01`）。
  if (context.principal.kind !== 'system') {
    const verifiedBy = (context.principal as { verifiedBy?: unknown }).verifiedBy
    const allowed =
      context.principal.kind === 'owner'
        ? verifiedBy === 'config_binding' || verifiedBy === 'admin_session'
        : verifiedBy === 'onebot_inbound' || verifiedBy === 'wechat_inbound' || verifiedBy === 'admin_session'
    if (!allowed) {
      checks.push({ name: 'identity_verified', ok: false, detail: `verifiedBy 不可信：${String(verifiedBy)}` })
      return deny('identity_unverified', '身份来源不可信（不接受自报身份）', checks)
    }
    checks.push({ name: 'identity_verified', ok: true, detail: `verifiedBy=${String(verifiedBy)}` })
  } else {
    checks.push({
      name: 'identity_verified',
      ok: true,
      detail: `内部消费者 ${context.principal.subsystem}`,
    })
  }

  // ② 用途与身份匹配
  if (context.principal.kind === 'system' && context.purpose !== 'internal_cognition') {
    checks.push({ name: 'purpose_matches_principal', ok: false, detail: 'system 的用途只能是 internal_cognition' })
    return deny('purpose_not_granted', '内部消费者不得持对外查询/管理用途', checks)
  }
  if (context.principal.kind === 'user' && context.purpose === 'admin_operation') {
    checks.push({ name: 'purpose_matches_principal', ok: false, detail: '普通用户不得持 admin_operation' })
    return deny('purpose_not_granted', '普通用户没有管理通路', checks)
  }
  checks.push({ name: 'purpose_matches_principal', ok: true, detail: context.purpose })

  // ③ 空间授权（条件格必须显式提供）
  const cell = SCOPE_MATRIX[context.principal.kind][operation]
  const needsRoom = operation.startsWith('read_') && context.room.kind === 'group'
  if (needsRoom) {
    if (input.roomAuthorized !== true) {
      checks.push({ name: 'room_authorized', ok: false, detail: '群空间未获授权（白名单撤销即失败关闭）' })
      return deny('room_not_authorized', '当前空间不在授权集', checks)
    }
    checks.push({ name: 'room_authorized', ok: true, detail: `group=${context.room.groupId}` })
  } else {
    checks.push({ name: 'room_authorized', ok: true, detail: '非群读取面' })
  }

  // ④ 矩阵格
  if (cell === undefined) {
    checks.push({ name: 'matrix_cell', ok: false, detail: `${context.principal.kind} × ${operation} 没有格` })
    return deny('operation_not_permitted', '矩阵没有这一格（缺格=拒绝）', checks)
  }
  if (cell === 'deny') {
    checks.push({ name: 'matrix_cell', ok: false, detail: `${context.principal.kind} × ${operation} = deny` })
    return deny('operation_not_permitted', '该主体不允许此操作', checks)
  }
  checks.push({ name: 'matrix_cell', ok: true, detail: `${context.principal.kind} × ${operation} = ${cell}` })

  // ⑤ 条件（conditional 必须显式满足；owner 的开档例外另算）
  if (cell === 'conditional') {
    if (operation === 'create_or_reset_archive') {
      if (input.ownerException?.granted !== true || !isNonEmpty(input.ownerException.caseId)) {
        checks.push({ name: 'condition_met', ok: false, detail: '缺原主人具名例外（含 caseId）' })
        return deny('condition_not_met', '开档/重置需要原主人具名、可信、留审计的例外', checks)
      }
      checks.push({ name: 'condition_met', ok: true, detail: `ownerException=${input.ownerException.caseId}` })
    } else {
      if (input.conditionMet !== true) {
        checks.push({ name: 'condition_met', ok: false, detail: '条件未满足或未提供（缺省=不满足）' })
        return deny('condition_not_met', '条件未满足', checks)
      }
      checks.push({ name: 'condition_met', ok: true, detail: '条件已满足' })
    }
  } else {
    checks.push({ name: 'condition_met', ok: true, detail: '无条件格' })
  }

  // ⑥ 目标归属（读/写他人时必须显式给 target，且私聊读面不得越到别人身上）
  if (input.targetUserId !== undefined) {
    if (context.principal.kind === 'system') {
      checks.push({ name: 'target_scope', ok: true, detail: 'internal_cognition 的 target 只作来源引用' })
    } else if (operation === 'read_own_private_memory' || operation === 'write_own_memory') {
      if (input.targetUserId !== context.principal.userId) {
        checks.push({ name: 'target_scope', ok: false, detail: 'target 不是本主体（自读/自写越界）' })
        return deny('scope_leak', '目标不属于本主体', checks)
      }
      checks.push({ name: 'target_scope', ok: true, detail: 'target=本主体' })
    } else {
      checks.push({ name: 'target_scope', ok: true, detail: `target=${input.targetUserId}` })
    }
  } else if (
    (operation === 'read_other_private_memory' || operation === 'write_other_memory') &&
    context.principal.kind !== 'system'
  ) {
    checks.push({ name: 'target_scope', ok: false, detail: '缺 targetUserId（不猜）' })
    return deny('scope_leak', '涉他操作必须显式给出对象', checks)
  } else {
    checks.push({ name: 'target_scope', ok: true, detail: '不涉他' })
  }

  return { allowed: true, code: 'allowed', detail: `允许：${context.principal.kind} × ${operation}`, checks }
}

// ---------------------------------------------------------------------------
// 已裁定的门槛常量（原主人 2026-10-13；**一处定义**，不许散落）
// ---------------------------------------------------------------------------

export interface RelationshipThreshold {
  readonly trust: number
  readonly closeness: number
}

/**
 * 印象查询门槛（X0 `R-X0-1`，**已确定**）：`originated` 且有效值**严格大于** 0.4。
 * ⚠️ 恰好等于 0.4 **不通过**。
 */
export const IMPRESSION_THRESHOLD: RelationshipThreshold = { trust: 0.4, closeness: 0.4 }

/**
 * 关系性演戏门槛（S0 `R-S0-4`，2026-10-13 **候选值**，原主人标注"尚未确定"）。
 * ⇒ S1 读数后复验；本常量**不**主张已定稿。
 */
export const ROLEPLAY_THRESHOLD: RelationshipThreshold = { trust: 0.25, closeness: 0.25 }

/**
 * 新用户**首次幂等建档**的初始关系值（X0，**已确定**）：0.2 / 0.2。
 *
 * ⚠️ 它**不是** M7 的 `SETTING_BASELINE`（0.85/0.60）；落库方式必须另立 ADR（ADR-133 §5）。
 */
export const NEW_USER_INITIAL_RELATIONSHIP: RelationshipThreshold = { trust: 0.2, closeness: 0.2 }

/**
 * "关系是否达到该门槛"——**纯函数，一处实现**（印象与演戏共用）。
 *
 * 形状刻意只吃三个字段（不 import RelationshipState），使判定可独立测试：
 * 调用方从读时有效值（含衰减）取数，**不**从事件重算。
 */
export function meetsRelationshipThreshold(
  state: { readonly originated: boolean; readonly trust: number; readonly closeness: number },
  threshold: RelationshipThreshold
): boolean {
  if (state.originated !== true) return false
  if (!Number.isFinite(state.trust) || !Number.isFinite(state.closeness)) return false
  return state.trust > threshold.trust && state.closeness > threshold.closeness
}

// ---------------------------------------------------------------------------
// §3 可见性归属（DisclosureClass / VisibilityLabel）
// ---------------------------------------------------------------------------

/**
 * 披露类别（契约 §3）。
 *
 * ⚠️ 缺标签 ⇒ 按 `private_to_origin` 处理（最保守），**不**提升为公共。
 */
export type DisclosureClass =
  | 'private_to_origin'
  | 'explicit_shared'
  | 'public_to_room'
  | 'character_internal'

export const DISCLOSURE_CLASSES: readonly DisclosureClass[] = [
  'private_to_origin',
  'explicit_shared',
  'public_to_room',
  'character_internal',
]

export interface VisibilityLabel {
  /** 写入时的来源域（**不是** subject：内容讲谁 ≠ 谁能读） */
  readonly originRoom: Room
  readonly disclosure: DisclosureClass
}

/** 缺标签时的保守缺省（契约 `VL-01`） */
export function defaultVisibilityLabel(originRoom: Room): VisibilityLabel {
  return { originRoom, disclosure: 'private_to_origin' }
}

export function visibilityLabelProblems(label: VisibilityLabel): string[] {
  const problems: string[] = []
  if (!DISCLOSURE_CLASSES.includes(label.disclosure)) {
    problems.push(`disclosure 未知：${String(label.disclosure)}`)
  }
  if (label.originRoom === undefined || typeof label.originRoom !== 'object') {
    problems.push('originRoom 缺失')
  } else if (label.originRoom.kind === 'private' && !isNonEmpty(label.originRoom.userId)) {
    problems.push('originRoom.private.userId 为空')
  } else if (label.originRoom.kind === 'group' && !isNonEmpty(label.originRoom.groupId)) {
    problems.push('originRoom.group.groupId 为空')
  }
  return problems
}

/**
 * 一条记录能否被 `viewer` 在当前 room 读到（契约 §3 的铁律，纯函数）。
 *
 * ⚠️ 它只回答**可见性**；"谁可以查询"仍要过 `evaluateScopeAccess`。
 */
export function visibilityAllows(input: {
  readonly label: VisibilityLabel | undefined
  readonly originRoom: Room
  readonly viewer: Principal
  readonly viewerRoom: Room
  readonly askerRelationshipConditionMet?: boolean
}): { allowed: boolean; reason: string } {
  const label = input.label ?? defaultVisibilityLabel(input.originRoom)
  const problems = visibilityLabelProblems(label)
  if (problems.length > 0) return { allowed: false, reason: `标签不合法：${problems.join('；')}` }

  // 内部认知面永不原文外泄（对**人**一律拒；system 的读取由 evaluateScopeAccess 单独判）
  if (label.disclosure === 'character_internal' && input.viewer.kind !== 'system') {
    return { allowed: false, reason: 'character_internal 不向人回吐原文' }
  }

  // 原主人走独立通路；可见性层不因"是主人"而放行私聊原文（特权在授权层 + 审计）
  if (label.disclosure === 'private_to_origin') {
    if (input.viewer.kind === 'system') return { allowed: true, reason: '内部认知用途' }
    const owner = label.originRoom
    /*
     * ⚠️ **来源域本人**包含两种 principal：`user`（普通用户读自己的）与 `owner`
     * （**原主人读自己的**）。后者是**单用户时期全部档案**的读者 —— 缺标签的旧记录
     * 按"原主人私聊"保守处理（`ADR-138` `D02`），若这里只认 `user`，
     * 旧记录会对**所有人**（包括原主人）都不可见，那不是保守，是坏掉。
     * ⚠️ 它**不**放宽"主人读**别人**的私聊来源"—— 那条仍走独立带审计的特权通路。
     */
    const viewerUserId = input.viewer.userId
    if (viewerUserId !== undefined && owner.kind === 'private' && owner.userId === viewerUserId) {
      return { allowed: true, reason: '来源域本人' }
    }
    return { allowed: false, reason: 'private_to_origin：非来源域本人' }
  }

  if (label.disclosure === 'public_to_room') {
    if (label.originRoom.kind === 'group' && input.viewerRoom.kind === 'group' &&
        label.originRoom.groupId === input.viewerRoom.groupId) {
      return { allowed: true, reason: '同一群空间' }
    }
    return { allowed: false, reason: 'public_to_room：不在同一群空间' }
  }

  // explicit_shared：需调用方给出"提问者条件已满足"的程序事实（缺省=不放行）
  if (label.disclosure === 'explicit_shared') {
    if (input.askerRelationshipConditionMet === true) {
      return { allowed: true, reason: '显式分享且条件已满足' }
    }
    return { allowed: false, reason: 'explicit_shared：条件未满足或未提供' }
  }

  return { allowed: false, reason: `未知披露类别：${String(label.disclosure)}` }
}
