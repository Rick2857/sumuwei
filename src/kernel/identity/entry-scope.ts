/**
 * Entry Scope —— **一条入站通道该用哪个作用域三元组**（多用户补充计划 U1 / WP5 接线的最后一环）。
 *
 * ============================================================================
 *  它解决什么
 * ============================================================================
 * ```text
 * 召回/读面在**装配时**构造一次，而"这一轮是谁在问、在哪个空间问"是**每轮**的事实。
 * 本模块把"入口的程序事实"翻译成 `ScopeContext` + 缺标签时的保守来源域：
 *
 *   入口（QQ 私聊 / QQ 群 / 皮套 / CLI）+ 服务端解析出的身份 + 群绑定
 *      ⇒ { scope?, defaultOriginRoom, failClosed, reason }
 *
 * ⚠️ **它只认程序事实**：`ownerUserId`（配置绑定）、`resolvedInboundUserId`（入站身份解析，
 *    见 `inbound-identity.ts`）都由**服务端**给出；**没有任何一条来自请求载荷/模型输出**。
 * ```
 *
 * ============================================================================
 *  三条不许破的边界（`ADR-133` `D05`/`D12`、X0 契约）
 * ============================================================================
 * ```text
 * ① **身份不明 ⇒ 失败关闭**：解析不出入站用户 ⇒ **不给 scope**（读面因此全拒），
 *    而不是"当作原主人"。这条是本模块存在的首要理由。
 * ② **群必须有名字**：群入口拿不到 `groupId` ⇒ 失败关闭（无法为"一个叫不出名字的空间"授权）。
 * ③ **群不等于私聊**：群入口的作用域 `room` **始终**是那个群；即便提问者就是原主人，
 *    也不因此获得"以私聊身份读群资料来源"的资格。
 * ```
 *
 * ⚠️ 纯层：零 IO、不认识 transport、不认识 store。
 */

import type { Principal, Room, ScopeContext } from '../contracts/scope.ts'

/** 入口种类（闭集；调用方负责把自己的 transport 映射到这里） */
export type EntryKind = 'qq_private' | 'qq_group' | 'avatar_local' | 'cli_local'

export const ENTRY_KINDS: readonly EntryKind[] = ['qq_private', 'qq_group', 'avatar_local', 'cli_local']

export interface EntryScopeInput {
  readonly entryKind: EntryKind
  /** 本机绑定的原主人 user id（**配置事实**；取不到就别调本函数） */
  readonly ownerUserId: string
  /**
   * 服务端解析出的**入站用户** id（`resolveInboundIdentityWithStore` 的结果）。
   *
   * `undefined` = **没有证据**（映射缺失 / 解析失败）⇒ 私聊入口失败关闭。
   */
  readonly resolvedInboundUserId?: string
  /** 群入口的群 id（**程序事实**；群入口取不到 ⇒ 失败关闭） */
  readonly groupId?: string
  /** 这个群是否在**授权集**里（群白名单是程序事实；缺省 = 未授权） */
  readonly groupAuthorized?: boolean
}

export interface EntryScopeOutcome {
  /** 缺省 `undefined` = **不给作用域** ⇒ 读面的授权器应全拒（失败关闭） */
  readonly scope?: ScopeContext
  /** 缺标签时按哪个来源域保守处理（`ADR-138` `D02`：原主人私聊） */
  readonly defaultOriginRoom: Room
  readonly roomAuthorized?: boolean
  readonly failClosed: boolean
  /** 人读理由（失败关闭时**必须**具名） */
  readonly reason: string
}

const ownerPrincipal = (ownerUserId: string): Principal => ({
  kind: 'owner',
  userId: ownerUserId,
  verifiedBy: 'config_binding',
})

const userPrincipal = (userId: string): Principal => ({
  kind: 'user',
  userId,
  verifiedBy: 'onebot_inbound',
})

/**
 * 把一个入口翻译成 `ScopeContext`。
 *
 * ```text
 * qq_private  身份 == 原主人 ⇒ {owner, external_query, private:owner}
 *             身份 != 原主人 ⇒ {user,  external_query, private:<该用户>}
 *             身份不明       ⇒ **失败关闭**（不给 scope）
 * qq_group    有 groupId ⇒ {身份, external_query, group:<groupId>} + roomAuthorized=白名单
 *             （身份不明 ⇒ **仍失败关闭**：群里也要知道是谁在问）
 *             无 groupId ⇒ 失败关闭
 * avatar_local / cli_local  ⇒ {owner, external_query, private:owner}（本机就是原主人在用）
 * ```
 */
export function resolveEntryScope(input: EntryScopeInput): EntryScopeOutcome {
  const ownerRoom: Room = { kind: 'private', userId: input.ownerUserId }

  if (!ENTRY_KINDS.includes(input.entryKind)) {
    return { defaultOriginRoom: ownerRoom, failClosed: true, reason: `未登记的入口种类：${String(input.entryKind)}` }
  }
  if (input.ownerUserId.trim() === '') {
    return { defaultOriginRoom: ownerRoom, failClosed: true, reason: '取不到本机绑定的原主人 user id' }
  }

  /* 本机入口（皮套 / CLI）：操作者就是原主人 —— 那是**程序事实**，不是推断 */
  if (input.entryKind === 'avatar_local' || input.entryKind === 'cli_local') {
    return {
      scope: { principal: ownerPrincipal(input.ownerUserId), purpose: 'external_query', room: ownerRoom },
      defaultOriginRoom: ownerRoom,
      failClosed: false,
      reason: `${input.entryKind}：本机操作者 = 原主人`,
    }
  }

  const resolved = input.resolvedInboundUserId
  if (resolved === undefined || resolved.trim() === '') {
    return {
      defaultOriginRoom: ownerRoom,
      failClosed: true,
      reason: '入站身份没有解析出来（映射缺失 / 解析失败）—— 不当作原主人，失败关闭',
    }
  }

  if (input.entryKind === 'qq_private') {
    const isOwner = resolved === input.ownerUserId
    return {
      scope: {
        principal: isOwner ? ownerPrincipal(input.ownerUserId) : userPrincipal(resolved),
        purpose: 'external_query',
        room: isOwner ? ownerRoom : { kind: 'private', userId: resolved },
      },
      defaultOriginRoom: ownerRoom,
      failClosed: false,
      reason: isOwner ? '私聊：已绑定为原主人' : '私聊：该用户自己的空间',
    }
  }

  /* qq_group */
  const groupId = input.groupId
  if (groupId === undefined || groupId.trim() === '') {
    return {
      defaultOriginRoom: ownerRoom,
      failClosed: true,
      reason: '群入口拿不到 groupId —— 不为"叫不出名字的空间"授权',
    }
  }
  const isOwner = resolved === input.ownerUserId
  return {
    scope: {
      principal: isOwner ? ownerPrincipal(input.ownerUserId) : userPrincipal(resolved),
      purpose: 'external_query',
      /* ⚠️ 群入口的 room **始终**是那个群（不因提问者是原主人而变成私聊） */
      room: { kind: 'group', groupId },
    },
    defaultOriginRoom: ownerRoom,
    roomAuthorized: input.groupAuthorized === true,
    failClosed: false,
    reason: isOwner ? `群 ${groupId}：提问者是原主人（但空间仍是该群）` : `群 ${groupId}：普通成员`,
  }
}
