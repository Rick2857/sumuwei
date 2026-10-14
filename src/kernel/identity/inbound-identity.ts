/**
 * Inbound Identity —— **逐消息可信身份解析**（多用户补充计划 U1 / WP2a）。
 *
 * ============================================================================
 *  ADR-133 `D04` / `D05`（ACCEPTED / DESIGN FROZEN）逐字落地
 * ============================================================================
 * 契约正文：docs/post-lv2/Multi-User-Scope-Contract.md §1（身份解析规则）
 *
 * 三条不许破的规矩：
 * 1. **平台账号是唯一的身份依据**：`(transport, externalId)`。
 *    昵称 / 群名片 / 会话 ID / 聊天中自报身份 / 客户端 owner 字段 / 模型声称 —— 一律不作依据。
 * 2. **不得回退为原主人**：未获准、未映射、字段不一致 ⇒ **具名拒绝**，绝不落到 owner。
 * 3. **群号只决定空间**，绝不写进 userId。
 *
 * ⚠️ 本文件是**纯层**：零 IO、零表、零 store。映射表查询与"首次建档是否写库"
 *    由调用方（WP2b 的接线）决定；本文件只把"该不该解析成谁"变成可判定的结果。
 *
 * ⚠️ 输入类型里**故意没有** nickname / card / conversationId 字段 ——
 *    这样"用昵称当身份"在**类型上**就做不到，而不是靠纪律记住。
 */

import type { Principal, Room } from '../contracts/scope.ts'

// ---------------------------------------------------------------------------
// 输入：已校验的平台事实
// ---------------------------------------------------------------------------

/**
 * 平台入站事实。
 *
 * ⚠️ 这些字段必须来自**已校验的** OneBot 事件（`post_type='message'` 等前置闸已在客户端）。
 *    本文件的职责是"在已校验的事实上定身份"，**不**替代客户端的协议校验。
 */
export interface InboundPlatformFacts {
  /** 传输层。当前闭集只有 `'qq'`（多平台是独立里程碑） */
  readonly transport: string
  /** 配置里的机器人账号（`QQ_BOT_ID`） */
  readonly botId: string
  /** 事件里的 `self_id` */
  readonly selfId: string
  /** `message_type`：`'private'` / `'group'`（其余值一律拒） */
  readonly messageType: string
  /** 事件的 `user_id` —— **唯一的平台账号依据** */
  readonly senderUserId: string
  /** `packet.sender.user_id`（若提供，必须与 `senderUserId` 一致：二次核对） */
  readonly senderUserIdInSender?: string
  /** 群号（**只在 group 消息里允许出现**） */
  readonly groupId?: string
  /** `sub_type`（仅登记，不参与身份判定；`friend` 之外的值由客户端决定是否拒） */
  readonly subType?: string
}

/**
 * 解析策略（由装配根提供**程序事实**，不来自请求）。
 */
export interface InboundIdentityPolicy {
  /** 配置里绑定的原主人 UserId（`QQ_OWNER_ID` → 领域 UserId）；用于判定 principal.kind */
  readonly ownerUserId: string
  /** 映射表解析结果（`user_identity_mappings(transport, external_id)`）；`undefined` = 没绑定过 */
  readonly mappedUserId?: string
  /** 首次遇到获准账号时的**确定性推导**（ADR-133 `D05`：幂等建档） */
  readonly deriveUserId?: (input: { readonly transport: string; readonly externalId: string }) => string
  /**
   * 这个平台账号是否**获准**（白名单 / 已批准）。
   * ⚠️ **缺省 = 未获准**（失败关闭）：不传就是不放行。
   */
  readonly allowed?: boolean
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

/** 具名拒绝码（闭集）。每个码都必须在门里**可复现**。 */
export type IdentityRejectionCode =
  | 'unsupported_transport'
  | 'missing_bot_facts'
  | 'bot_account_mismatch'
  | 'unsupported_message_type'
  | 'missing_sender'
  | 'sender_mismatch'
  | 'group_id_required'
  | 'group_id_forbidden'
  | 'not_allowed'
  | 'unmapped_identity'

export const IDENTITY_REJECTION_CODES: readonly IdentityRejectionCode[] = [
  'unsupported_transport',
  'missing_bot_facts',
  'bot_account_mismatch',
  'unsupported_message_type',
  'missing_sender',
  'sender_mismatch',
  'group_id_required',
  'group_id_forbidden',
  'not_allowed',
  'unmapped_identity',
]

export interface ResolvedInboundIdentity {
  /** 平台账号（唯一依据） */
  readonly externalId: string
  /** 领域 UserId */
  readonly userId: string
  /** 交流空间（群号只在这里） */
  readonly room: Room
  readonly isOwner: boolean
  readonly principal: Principal
  /** `'mapped'` = 映射表已有；`'first_seen'` = 用确定性推导（调用方据此幂等建档） */
  readonly disposition: 'mapped' | 'first_seen'
}

export type InboundIdentityOutcome =
  | { readonly ok: true; readonly value: ResolvedInboundIdentity }
  | { readonly ok: false; readonly code: IdentityRejectionCode; readonly detail: string }

const SUPPORTED_TRANSPORTS: readonly string[] = ['qq']
const SUPPORTED_MESSAGE_TYPES: readonly string[] = ['private', 'group']

function reject(code: IdentityRejectionCode, detail: string): InboundIdentityOutcome {
  return { ok: false, code, detail }
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

/**
 * **唯一**的身份解析（ADR-133 `D04`/`D05`）。
 *
 * 失败关闭：任何一步不成立 ⇒ 具名拒绝，**不**回退为原主人、**不**猜测。
 * 判定顺序即文档顺序。
 */
export function resolveInboundIdentity(
  facts: InboundPlatformFacts,
  policy: InboundIdentityPolicy
): InboundIdentityOutcome {
  // ① 传输层必须是闭集里的值
  if (!SUPPORTED_TRANSPORTS.includes(facts.transport)) {
    return reject('unsupported_transport', `未支持的 transport：${String(facts.transport)}`)
  }

  // ② 机器人账号：两侧都要有，且必须相等（防"另一个机器人连上来"冒充）
  if (!nonEmpty(facts.botId) || !nonEmpty(facts.selfId)) {
    return reject('missing_bot_facts', 'botId / selfId 缺失（无法确认这是本机器人的事件）')
  }
  if (facts.botId !== facts.selfId) {
    return reject('bot_account_mismatch', `self_id=${facts.selfId} 与配置 botId=${facts.botId} 不一致`)
  }

  // ③ 消息类型闭集
  if (!SUPPORTED_MESSAGE_TYPES.includes(facts.messageType)) {
    return reject('unsupported_message_type', `未支持的 message_type：${String(facts.messageType)}`)
  }

  // ④ 发言者账号必须存在（**这是唯一身份依据**）
  if (!nonEmpty(facts.senderUserId)) {
    return reject('missing_sender', 'senderUserId 为空（无身份依据）')
  }

  // ⑤ 二次核对：`packet.sender.user_id` 若提供，必须与 `user_id` 一致
  if (facts.senderUserIdInSender !== undefined && facts.senderUserIdInSender !== facts.senderUserId) {
    return reject(
      'sender_mismatch',
      `sender.user_id=${facts.senderUserIdInSender} 与 user_id=${facts.senderUserId} 不一致`
    )
  }

  // ⑥ 空间：群消息必须有 groupId；私聊**不许**带 groupId
  if (facts.messageType === 'group') {
    if (!nonEmpty(facts.groupId)) {
      return reject('group_id_required', '群消息缺 group_id（无法确定交流空间）')
    }
  } else if (facts.groupId !== undefined) {
    return reject('group_id_forbidden', `私聊事件带 group_id=${String(facts.groupId)}（形状矛盾）`)
  }

  // ⑦ 获准闸：**缺省 = 未获准**
  if (policy.allowed !== true) {
    return reject('not_allowed', '该平台账号未获准（白名单/批准），失败关闭')
  }

  // ⑧ 映射表 → 首次推导；两者都没有 ⇒ 拒绝（**不**回退为原主人）
  const externalId = facts.senderUserId
  let userId = policy.mappedUserId
  let disposition: 'mapped' | 'first_seen' = 'mapped'
  if (!nonEmpty(userId)) {
    if (policy.deriveUserId === undefined) {
      return reject('unmapped_identity', '映射表没有该账号，且没有确定性推导（不猜、不回退）')
    }
    userId = policy.deriveUserId({ transport: facts.transport, externalId })
    disposition = 'first_seen'
    if (!nonEmpty(userId)) {
      return reject('unmapped_identity', '确定性推导返回空 UserId（不猜、不回退）')
    }
  }

  // ⑨ 空间与主体
  const room: Room =
    facts.messageType === 'group'
      ? { kind: 'group', groupId: String(facts.groupId) }
      : { kind: 'private', userId }

  const isOwner = userId === policy.ownerUserId
  const principal: Principal = isOwner
    ? { kind: 'owner', userId, verifiedBy: 'config_binding' }
    : { kind: 'user', userId, verifiedBy: 'onebot_inbound' }

  return {
    ok: true,
    value: { externalId, userId, room, isOwner, principal, disposition },
  }
}

/**
 * 便捷读法：解析结果 → 该用哪个 `ScopeContext` 用途。
 *
 * ⚠️ 它**只**给"外部查询"这一个用途：入口收到的用户消息永远是 external_query。
 *    `internal_cognition` / `admin_operation` 由各自的可信链路自己构造，
 *    **不得**从入口事实推导（契约 `SC-01`）。
 */
export function inboundPurpose(): 'external_query' {
  return 'external_query'
}
