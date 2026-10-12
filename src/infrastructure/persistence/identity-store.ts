/**
 * 身份表的持久化 —— UserIdentity 与 ConversationIdentity（WP4）。
 *
 * ============================================================================
 *  计划书第 7 / 8 / 25 / 91 节
 * ============================================================================
 * 三张表，三种生命周期，刻意**不合并**：
 *
 *   user_identities            UserId 是稳定身份。**不随 Session 变化。**
 *   user_identity_mappings     transport 身份 → UserId。可以有很多条。
 *   conversation_identities    ConversationId ↔ (characterId, userId)。**可替换。**
 *
 * 为什么必须分开（计划书第 7 节的原话）：
 *
 *   > 否则 M4 会把 user facts 错误绑定到 session。
 *
 * 那是一个具体的、会发生的事故：用户换一次会话，他之前说过的偏好就全丢了，
 * 因为那些事实的坐标是 (userId, conversationId) 而不是 userId。
 *
 * ---------------------------------------------------------------------------
 *  一个真实的坑：transport 改名 ≠ 换人
 * ---------------------------------------------------------------------------
 * `user_identity_mappings` 的主键是 `(transport, external_id)`，
 * **不是** `external_id`。原因：QQ 的 12345 与 Discord 的 12345 是两个人。
 * 把 external_id 单独当主键会让两个平台的用户合并成一个人 ——
 * 而"合并"这件事一旦写进事实账本（append-only）就撤不回来。
 */

import { sql } from 'drizzle-orm'

import { KernelError, type CharacterId, type ConversationId } from '../../kernel/contracts/index.ts'
import { exec, firstRow, type RawDb } from './db.ts'

// ---------------------------------------------------------------------------
// UserIdentity
// ---------------------------------------------------------------------------

export interface UserIdentityRecord {
  userId: string
  displayName?: string
  createdAt: number
  updatedAt: number
}

/**
 * 确保一个用户身份存在。
 *
 * 幂等：同一个 userId 反复调用只更新 displayName 与 updatedAt。
 * **不覆盖 createdAt** —— 那和 Seed 的 createdAt 是同一个道理：
 * "这个人什么时候第一次出现"不该因为一次改名而改变。
 */
export async function ensureUserIdentity(
  db: RawDb,
  userId: string,
  displayName?: string,
  now: number = Date.now()
): Promise<UserIdentityRecord> {
  if (userId.trim() === '') {
    throw new KernelError('validation_error', 'empty_user_id', 'UserId 不能为空')
  }
  await exec(
    db,
    sql`insert into user_identities (user_id, display_name, created_at, updated_at)
        values (${userId}, ${displayName ?? null}, ${now}, ${now})
        on conflict (user_id) do update set
          display_name = coalesce(excluded.display_name, user_identities.display_name),
          updated_at   = excluded.updated_at`,
    '确保用户身份存在'
  )
  return (await getUserIdentity(db, userId))!
}

export async function getUserIdentity(
  db: RawDb,
  userId: string
): Promise<UserIdentityRecord | undefined> {
  const rows = await exec(
    db,
    sql`select * from user_identities where user_id = ${userId} limit 1`,
    '读取用户身份'
  )
  const row = firstRow<{ user_id: string; display_name: string | null; created_at: number; updated_at: number }>(rows)
  if (!row) return undefined
  return {
    userId: String(row.user_id),
    ...(row.display_name ? { displayName: String(row.display_name) } : {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

/** 把一个 transport 身份绑定到 UserId（幂等；重复绑定同一个不变） */
export async function bindTransportIdentity(
  db: RawDb,
  input: { transport: string; externalId: string; userId: string },
  now: number = Date.now()
): Promise<void> {
  if (input.transport.trim() === '' || input.externalId.trim() === '') {
    throw new KernelError(
      'validation_error',
      'empty_transport_identity',
      'transport 与 externalId 都不能为空（空的映射没有意义，只会掩盖配置错误）'
    )
  }
  await exec(
    db,
    sql`insert into user_identity_mappings (transport, external_id, user_id, created_at)
        values (${input.transport}, ${input.externalId}, ${input.userId}, ${now})
        on conflict (transport, external_id) do nothing`,
    '绑定 transport 身份'
  )
}

/**
 * 解析一个 transport 身份。
 *
 * ⚠️ 返回 `undefined` 表示"没绑定过"，而**不是**"新建一个"。
 * 建不建档是调用方（ActorResolver）的决定：它可能有自己的确定性推导规则
 * （本项目 CLI 就是"用 userName 推导 UUID"）。
 * 这里只回答"这个映射存在吗"，不做猜测。
 */
export async function resolveTransportIdentity(
  db: RawDb,
  transport: string,
  externalId: string
): Promise<string | undefined> {
  const rows = await exec(
    db,
    sql`select user_id from user_identity_mappings
        where transport = ${transport} and external_id = ${externalId} limit 1`,
    '解析 transport 身份'
  )
  const value = firstRow<{ user_id: string }>(rows)?.user_id
  return value === undefined || value === null ? undefined : String(value)
}

/** 一个用户绑定了哪些 transport 身份（诊断用：回答"他来过哪些平台"） */
export async function listTransportIdentities(
  db: RawDb,
  userId: string
): Promise<{ transport: string; externalId: string }[]> {
  const rows = await exec(
    db,
    sql`select transport, external_id from user_identity_mappings
        where user_id = ${userId} order by transport, external_id`,
    '列出 transport 身份'
  )
  return rows.map((row) => ({
    transport: String(row.transport),
    externalId: String(row.external_id),
  }))
}

// ---------------------------------------------------------------------------
// ConversationIdentity
// ---------------------------------------------------------------------------

export interface ConversationIdentityRecord {
  conversationId: ConversationId
  characterId: CharacterId
  userId: string
  label?: string
  transport?: string
  createdAt: number
  updatedAt: number
}

/**
 * 确保一个会话身份存在。
 *
 * 计划书第 91 节的 Gate 就是靠这张表判定：
 *   same user + different conversation → same UserId
 *
 * 因此 `user_id` 是**必填**的：一个不知道属于谁的会话，
 * 在未来会让 M4 无法把任何事实绑定到人。
 */
export async function ensureConversationIdentity(
  db: RawDb,
  input: {
    conversationId: ConversationId | string
    characterId: CharacterId | string
    userId: string
    label?: string
    transport?: string
  },
  now: number = Date.now()
): Promise<ConversationIdentityRecord> {
  await exec(
    db,
    sql`insert into conversation_identities
          (conversation_id, character_id, user_id, label, transport, created_at, updated_at)
        values (${String(input.conversationId)}, ${String(input.characterId)}, ${input.userId},
                ${input.label ?? null}, ${input.transport ?? null}, ${now}, ${now})
        on conflict (conversation_id) do update set
          character_id = excluded.character_id,
          user_id      = excluded.user_id,
          label        = coalesce(excluded.label, conversation_identities.label),
          transport    = coalesce(excluded.transport, conversation_identities.transport),
          updated_at   = excluded.updated_at`,
    '确保会话身份存在'
  )
  return (await getConversationIdentity(db, input.conversationId))!
}

export async function getConversationIdentity(
  db: RawDb,
  conversationId: ConversationId | string
): Promise<ConversationIdentityRecord | undefined> {
  const rows = await exec(
    db,
    sql`select * from conversation_identities where conversation_id = ${String(conversationId)} limit 1`,
    '读取会话身份'
  )
  const row = firstRow<{
    conversation_id: string
    character_id: string
    user_id: string
    label: string | null
    transport: string | null
    created_at: number
    updated_at: number
  }>(rows)
  if (!row) return undefined
  return {
    conversationId: String(row.conversation_id) as ConversationId,
    characterId: String(row.character_id) as CharacterId,
    userId: String(row.user_id),
    ...(row.label ? { label: String(row.label) } : {}),
    ...(row.transport ? { transport: String(row.transport) } : {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

/** 某个用户在某个角色下开过哪些会话（计划书 T2/T10 的判定材料） */
export async function listConversationsForUser(
  db: RawDb,
  characterId: CharacterId | string,
  userId: string
): Promise<ConversationIdentityRecord[]> {
  const rows = await exec(
    db,
    sql`select * from conversation_identities
        where character_id = ${String(characterId)} and user_id = ${userId}
        order by created_at asc`,
    '列出用户的会话'
  )
  return rows.map((row) => ({
    conversationId: String(row.conversation_id) as ConversationId,
    characterId: String(row.character_id) as CharacterId,
    userId: String(row.user_id),
    ...(row.label ? { label: String(row.label) } : {}),
    ...(row.transport ? { transport: String(row.transport) } : {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }))
}
