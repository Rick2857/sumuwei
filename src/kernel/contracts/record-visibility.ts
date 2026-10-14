/**
 * Record Visibility —— **一条记录能不能被这个人读到**（多用户补充计划 U1 / **WP5 的判定核心**）。
 *
 * ============================================================================
 *  它把两件已经存在的东西**组合**成读取面唯一该调的那一个函数
 * ============================================================================
 * ```text
 * ① 授权三元组（`ADR-133` `D06`）：`evaluateScopeAccess` —— 谁 · 什么用途 · 哪个空间
 * ② 归属与披露（`ADR-137` / X0 §3）：`visibilityAllows` —— 这条记录的来源域与披露类别
 *
 * 读取面（召回候选 / 入模组装 / Recent / 摘要 / 附件 / trace / 导出 …）
 * **只该调这一个函数**，而不是各自拼两遍 —— 拼两遍必然漂移（"两个装配会漂移"的老教训）。
 * ```
 *
 * ⚠️ **缺标签 ⇒ 最保守**（`ADR-137` `R-WP4-3`、X0 `VL-01`）：按 `private_to_origin` 处理，
 *    并在返回值里**如实标出** `labelMissing`（调用方要能计数/报告，而不是把它当成"有标签"）。
 *    **绝不**退化成"公共"或"同群可见"。
 *
 * ⚠️ 纯层：零 IO、不认识 store、不认识 Room 表 —— 标签由调用方传入（从 `record_scope_store` 读）。
 * ⚠️ 它**不**回答"能不能出现在候选里"以外的任何问题，也**不**动 reducer / 事件 / 记录形状。
 */

import {
  evaluateScopeAccess,
  visibilityAllows,
  type Principal,
  type Purpose,
  type Room,
  type ScopeAccessInput,
  type ScopeContext,
  type ScopeDecision,
  type ScopeOperation,
  type VisibilityLabel,
} from './scope.ts'

export interface RecordVisibilityQuery {
  /** 服务端生成的作用域三元组（**不许**来自请求载荷） */
  readonly context: ScopeContext
  /** 这条记录的标签；`undefined` = 没有标签 ⇒ 走最保守缺省 */
  readonly label: VisibilityLabel | undefined
  /** 记录**写入时**的来源域（缺标签时靠它保守处理） */
  readonly originRoom: Room
  /** 空间是否在授权集（群白名单 / 私聊归属）——由程序事实提供，缺省 = 未授权 */
  readonly roomAuthorized?: boolean
  /** 披露条件是否满足（`explicit_shared` 需要它）；缺省 = 不满足 */
  readonly askerRelationshipConditionMet?: boolean
}

export interface RecordVisibilityDecision {
  readonly allowed: boolean
  /** 授权侧的具名结论（`allowed` / 七个拒绝码之一） */
  readonly scopeCode: ScopeDecision['code']
  /** 可见性侧的结论（人类可读的理由） */
  readonly visibilityReason: string
  /** 缺标签 ⇒ true（调用方据此计数/报告；**不影响** allowed 的保守性） */
  readonly labelMissing: boolean
  /** 两侧的逐条留痕 */
  readonly checks: ScopeDecision['checks']
}

/** 记录来源域 + 提问者空间 ⇒ 该用哪个授权操作（`ADR-133` §2 的矩阵格） */
export function readOperationFor(input: {
  readonly viewer: Principal
  readonly viewerRoom: Room
  readonly originRoom: Room
  readonly label: VisibilityLabel | undefined
}): ScopeOperation {
  /*
   * 内部消费者走**它自己的那一格**（`internal_cognition_read`）：
   * 矩阵里 `system × read_other_private_memory = deny`（"不得把原文回吐给任何用户"），
   * 内部认知读取是**另一格** —— 混用会把"内部可用"读成"可以回吐"。
   */
  if (input.viewer.kind === 'system') return 'internal_cognition_read'
  const room = input.label?.originRoom ?? input.originRoom
  if (room.kind === 'private') {
    return input.viewer.userId === room.userId ? 'read_own_private_memory' : 'read_other_private_memory'
  }
  // 群来源：提问者**在同一个群**才算"当前群资料"，否则是"别的群的资料"
  const sameGroup = input.viewerRoom.kind === 'group' && input.viewerRoom.groupId === room.groupId
  return sameGroup ? 'read_current_group_material' : 'read_other_group_material'
}

/**
 * **唯一**的读取判定（授权 × 可见性）。
 *
 * `allowed = 授权放行 && 可见性放行` —— **两个都要过**；
 * 缺标签时可见性侧按 `private_to_origin` 判（保守），并置 `labelMissing=true`。
 */
export function decideRecordVisibility(query: RecordVisibilityQuery): RecordVisibilityDecision {
  const labelMissing = query.label === undefined
  // The audience is the entire group, even when the speaker owns a private record.
  const sourceRoom = query.label?.originRoom ?? query.originRoom
  if (query.context.purpose === 'external_query' && query.context.room.kind === 'group' && sourceRoom.kind === 'private') {
    return { allowed: false, scopeCode: 'scope_leak', visibilityReason: '私聊来源不得向全群披露', labelMissing, checks: [] }
  }
  const operation = readOperationFor({
    viewer: query.context.principal,
    viewerRoom: query.context.room,
    originRoom: query.originRoom,
    label: query.label,
  })

  const origin = query.label?.originRoom ?? query.originRoom
  const accessInput: ScopeAccessInput = {
    context: query.context,
    operation,
    /*
     * 私聊来源的"涉他"读取必须**显式给出对象**（矩阵第 ⑥ 步）：
     * 不给 ⇒ `scope_leak`（"涉他操作必须显式给对象"）。对象就是**来源域的那个人** ——
     * 它不是请求方提供的，而是记录标签里的程序事实。
     */
    ...(origin.kind === 'private' ? { targetUserId: origin.userId } : {}),
    ...(query.roomAuthorized === undefined ? {} : { roomAuthorized: query.roomAuthorized }),
    ...(query.askerRelationshipConditionMet === undefined
      ? {}
      : { conditionMet: query.askerRelationshipConditionMet }),
  }
  const scope = evaluateScopeAccess(accessInput)

  const visibility = visibilityAllows({
    label: query.label,
    originRoom: query.originRoom,
    viewer: query.context.principal,
    viewerRoom: query.context.room,
    ...(query.askerRelationshipConditionMet === undefined
      ? {}
      : { askerRelationshipConditionMet: query.askerRelationshipConditionMet }),
  })

  return {
    allowed: scope.allowed && visibility.allowed,
    scopeCode: scope.code,
    visibilityReason: visibility.reason,
    labelMissing,
    checks: scope.checks,
  }
}

/**
 * **原主人特权**的读取判定（`ADR-133` `D12` / 契约 §3 的"独立通路"）。
 *
 * ```text
 * ⚠️ 特权**不是**把 `decideRecordVisibility` 放宽给 owner —— 那样"是主人"就变成了一条静默的旁路。
 *    它必须**显式**：principal 必须是 owner、用途必须是 admin_operation、而且**必须带审计条目**
 *    （`auditCaseId` 非空）。缺任何一项 ⇒ 拒绝（失败关闭），且拒绝理由具名。
 * ⚠️ 缺标签仍然如实标出（`labelMissing`）—— 特权读得到内容，**不**改变"这条没有归属标签"的事实。
 * ```
 */
export function decideOwnerPrivilegedRecordRead(query: {
  readonly context: ScopeContext
  readonly label: VisibilityLabel | undefined
  readonly originRoom: Room
  readonly auditCaseId: string
}): RecordVisibilityDecision & { readonly privileged: boolean } {
  const labelMissing = query.label === undefined
  const base = {
    visibilityReason: '原主人特权通路（独立、带审计）',
    labelMissing,
    checks: [] as ScopeDecision['checks'],
  }
  if (query.context.principal.kind !== 'owner') {
    return { allowed: false, scopeCode: 'identity_unverified', privileged: false, ...base, visibilityReason: '特权通路只对原主人开放' }
  }
  if (query.context.purpose !== 'admin_operation') {
    return { allowed: false, scopeCode: 'purpose_not_granted', privileged: false, ...base, visibilityReason: '特权读取必须走 admin_operation 用途' }
  }
  if (typeof query.auditCaseId !== 'string' || query.auditCaseId.trim() === '') {
    return { allowed: false, scopeCode: 'condition_not_met', privileged: false, ...base, visibilityReason: '缺审计条目（auditCaseId）—— 没有审计就没有特权' }
  }
  return { allowed: true, scopeCode: 'allowed', privileged: true, ...base }
}

/**
 * 便捷读法：读取面**唯一**该问的问题。
 *
 * ⚠️ `purpose` 由调用方给（对外查询 / 内部认知）；**内部认知**也不因此绕过归属 ——
 *    它只是"允许她用"，不等于"允许回吐给用户"（那是 ① 里的用途与 ② 里的披露共同决定的）。
 */
export function canReadRecord(input: {
  readonly principal: Principal
  readonly purpose: Purpose
  readonly viewerRoom: Room
  readonly label: VisibilityLabel | undefined
  readonly originRoom: Room
  readonly roomAuthorized?: boolean
  readonly askerRelationshipConditionMet?: boolean
}): RecordVisibilityDecision {
  return decideRecordVisibility({
    context: { principal: input.principal, purpose: input.purpose, room: input.viewerRoom },
    label: input.label,
    originRoom: input.originRoom,
    ...(input.roomAuthorized === undefined ? {} : { roomAuthorized: input.roomAuthorized }),
    ...(input.askerRelationshipConditionMet === undefined
      ? {}
      : { askerRelationshipConditionMet: input.askerRelationshipConditionMet }),
  })
}
