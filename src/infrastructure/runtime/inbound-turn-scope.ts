/**
 * Inbound Turn Scope —— **一条入站消息 ⇒ 本轮的作用域**（多用户补充计划 U1 / WP2b-2b 的核心）。
 *
 * ============================================================================
 *  它把三件已经有门的东西接起来
 * ============================================================================
 * ```text
 * ① 平台事实（`InboundPlatformFacts`：`user_id` / `message_type` / 群号）
 * ② 身份解析（`resolveInboundIdentityWithStore` —— 映射表 + 首次幂等建档）
 * ③ 入口 ⇒ 作用域（`resolveEntryScope` —— 四种入口 + 五条失败关闭）
 *      ⇒ { scope?, defaultOriginRoom, roomAuthorized?, failClosed, reason, boundFirstTime }
 * ```
 *
 * ⚠️ **本模块只做"翻译与失败关闭"**：它不写事件、不召回、不认识 transport。
 *    调用方（装配层）拿 `scope` 传给 `compileTurn`；`failClosed === true` ⇒ **不给 scope**，
 *    读面的授权器因此**全拒且计数可观测**（"忘了传身份"不可能变成静默放行）。
 *
 * ⚠️ 身份证据**只有**平台账号（`senderUserId`）——没有它就失败关闭，
 *    **绝不**回落到"原主人"或"上一次的说话人"（那正是群串号与提权的形状）。
 */

import type { InboundPlatformFacts } from '../../kernel/identity/inbound-identity.ts'
import { resolveEntryScope, type EntryKind, type EntryScopeOutcome } from '../../kernel/identity/entry-scope.ts'
import type { Room, ScopeContext } from '../../kernel/contracts/scope.ts'
import { resolveInboundIdentityWithStore } from './inbound-identity-resolver.ts'
import type { RawDb } from '../persistence/db.ts'

export interface InboundTurnScopeInput {
  readonly facts: InboundPlatformFacts
  /** 配置里绑定的原主人 UserId（**程序事实**） */
  readonly ownerUserId: string
  readonly db: RawDb
  /** 群白名单判定（程序事实）；缺省 = 未授权 */
  readonly groupAuthorized?: boolean
  /**
   * 这个平台账号是否**获准**与角色对话（程序事实：绑定清单 / 白名单）。
   * 缺省不传 ⇒ 纯判定层按"未提供"处理（见 `inbound-identity.ts` 的判定顺序）。
   */
  readonly allowedFor?: (input: { readonly transport: string; readonly externalId: string }) => boolean
  /** 首次遇到获准账号时的确定性推导（幂等建档用） */
  readonly deriveUserId?: (input: { readonly transport: string; readonly externalId: string }) => string
  /** 是否允许首次见到获准账号时**幂等建档**（缺省 false：只解析不写） */
  readonly ensureArchive?: boolean
  readonly displayName?: string
  readonly now?: () => number
}

export interface InboundTurnScopeOutcome extends EntryScopeOutcome {
  /** 本次是否发生**首次绑定**（写侧动作；失败关闭时恒为 false） */
  readonly boundFirstTime: boolean
  /** 平台账号（诊断用；**不是**身份） */
  readonly externalId?: string
  /** 领域 UserId（解析成功才有） */
  readonly userId?: string
  /** 该账号是否就是本机绑定的原主人 */
  readonly isOwner?: boolean
}

/**
 * 一条入站消息 ⇒ 本轮作用域。
 *
 * 失败关闭的**所有**出口都带具名理由（人读），并且**都不给 scope**：
 * ```text
 * · 没有平台账号证据（`senderUserId` 空）
 * · 身份解析被拒（任何 `IdentityRejectionCode`：未获准 / 群号不该出现 / 自聊 / self_id 不符 …）
 * · 入口那一层的失败关闭（群无名 / 取不到原主人 id …）
 * ```
 */
export async function resolveInboundTurnScope(input: InboundTurnScopeInput): Promise<InboundTurnScopeOutcome> {
  const ownerRoom: Room = { kind: 'private', userId: input.ownerUserId }

  const resolution = await resolveInboundIdentityWithStore(input.facts, {
    db: input.db,
    ownerUserId: input.ownerUserId,
    ...(input.deriveUserId === undefined ? {} : { deriveUserId: input.deriveUserId }),
    ...(input.ensureArchive === undefined ? {} : { ensureArchive: input.ensureArchive }),
    ...(input.allowedFor === undefined ? {} : { allowedFor: input.allowedFor }),
    ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
    ...(input.now === undefined ? {} : { now: input.now }),
  })

  if (!resolution.outcome.ok) {
    return {
      defaultOriginRoom: ownerRoom,
      failClosed: true,
      boundFirstTime: false,
      reason: `入站身份未解析：${resolution.outcome.code}（${resolution.outcome.detail}）`,
    }
  }

  const identity = resolution.outcome.value
  const entryKind: EntryKind = identity.room.kind === 'group' ? 'qq_group' : 'qq_private'
  const entry = resolveEntryScope({
    entryKind,
    ownerUserId: input.ownerUserId,
    resolvedInboundUserId: identity.userId,
    ...(identity.room.kind === 'group' ? { groupId: identity.room.groupId } : {}),
    ...(input.groupAuthorized === undefined ? {} : { groupAuthorized: input.groupAuthorized }),
  })

  return {
    ...entry,
    boundFirstTime: resolution.boundFirstTime,
    externalId: identity.externalId,
    userId: identity.userId,
    isOwner: identity.isOwner,
  }
}
