/**
 * Inbound Identity Resolver —— **映射表 / 首次建档**（多用户补充计划 U1 / WP2b-1）。
 *
 * ============================================================================
 *  ADR-133 `D04` / `D05`（ACCEPTED / DESIGN FROZEN）
 * ============================================================================
 * 本文件把纯判定层（`src/kernel/identity/inbound-identity.ts`）接到**既有**的身份表上：
 *
 *   user_identity_mappings   (transport, external_id) → user_id   ← 唯一的账号依据
 *   user_identities          user_id 的稳定存在
 *
 * ⚠️ **本文件不改任何入口行为**：目前**没有**调用者把它接进生产链路（那是 WP2b-2）。
 *    它的存在使"按消息解析身份"从纯函数变成**可实测**的读写链。
 *
 * ⚠️ 三条纪律（与 ADR-133 一致）：
 *   1. **不猜**：映射表没有 + 没有确定性推导 ⇒ 具名拒绝（不回退为原主人）。
 *   2. **幂等**：首次建档走 `on conflict do nothing`；并发首次消息**仍然只有一行**。
 *   3. **失败关闭**：`allowed` 缺省即未获准；任何拒绝路径**不写任何行**。
 */

import {
  resolveInboundIdentity,
  type InboundIdentityOutcome,
  type InboundPlatformFacts,
} from '../../kernel/identity/inbound-identity.ts'
import { bindTransportIdentity, ensureUserIdentity, resolveTransportIdentity } from '../persistence/identity-store.ts'
import { exec, firstRow, type RawDb } from '../persistence/db.ts'
import { sql } from 'drizzle-orm'

export interface ResolveInboundIdentityWithStoreOptions {
  readonly db: RawDb
  /** 配置里绑定的原主人 UserId（判定 principal.kind） */
  readonly ownerUserId: string
  /**
   * 平台账号是否**获准**（白名单 / 已批准）。**缺省 = 未获准**（失败关闭）。
   * ⚠️ 这里传的是**程序事实**（白名单表/配置），**不是**请求里的自报值。
   */
  readonly allowedFor?: (input: { readonly transport: string; readonly externalId: string }) => boolean
  /** 首次遇到获准账号时的确定性推导（ADR-133 `D05`） */
  readonly deriveUserId?: (input: { readonly transport: string; readonly externalId: string }) => string
  /**
   * 首次遇到获准账号时，是否**幂等建档**（写 `user_identities` + `user_identity_mappings`）。
   * 缺省 `false`：只解析、不写 —— 让调用方显式决定写。
   */
  readonly ensureArchive?: boolean
  /** 诊断用显示名（仅当 `ensureArchive` 时写入；缺省不写） */
  readonly displayName?: string
  readonly now?: () => number
}

export interface InboundIdentityResolution {
  readonly outcome: InboundIdentityOutcome
  /** 本次是否发生了**首次绑定**（写侧动作）；解析失败或已映射时为 `false` */
  readonly boundFirstTime: boolean
}

/**
 * 从**已校验的平台事实**解析身份，必要时幂等建档。
 *
 * 顺序：先读映射表（一次 `select`）→ 交给纯判定层 → （仅当获准且首次）幂等写两行。
 */
export async function resolveInboundIdentityWithStore(
  facts: InboundPlatformFacts,
  options: ResolveInboundIdentityWithStoreOptions
): Promise<InboundIdentityResolution> {
  const externalId = typeof facts.senderUserId === 'string' ? facts.senderUserId : ''
  const mappedUserId = externalId === ''
    ? undefined
    : await resolveTransportIdentity(options.db, facts.transport, externalId)

  const outcome = resolveInboundIdentity(facts, {
    ownerUserId: options.ownerUserId,
    ...(mappedUserId === undefined ? {} : { mappedUserId }),
    ...(options.deriveUserId === undefined ? {} : { deriveUserId: options.deriveUserId }),
    ...(options.allowedFor === undefined
      ? {}
      : { allowed: options.allowedFor({ transport: facts.transport, externalId }) }),
  })
  if (!outcome.ok) return { outcome, boundFirstTime: false }

  // 已映射 ⇒ 不写任何东西（**重复解析不得改绑**）
  if (outcome.value.disposition === 'mapped' || options.ensureArchive !== true) {
    return { outcome, boundFirstTime: false }
  }

  // 首次建档：幂等两行。`bindTransportIdentity` 是 on conflict do nothing ⇒ 并发下仍只有一行。
  const now = options.now?.() ?? Date.now()
  await ensureUserIdentity(options.db, outcome.value.userId, options.displayName, now)
  await bindTransportIdentity(
    options.db,
    { transport: facts.transport, externalId: outcome.value.externalId, userId: outcome.value.userId },
    now
  )
  return { outcome, boundFirstTime: true }
}

/**
 * 诊断用：某个 transport 下**映射行数**。
 *
 * 判据用途：并发首次消息 / 重复解析后，这个数必须**恰好等于**不同平台账号的个数
 * （G14 的负控要求"同一 QQ 只有一行"）。
 */
export async function countTransportMappings(db: RawDb, transport: string): Promise<number> {
  const rows = await exec(
    db,
    sql`select count(*)::int as c from user_identity_mappings where transport = ${transport}`,
    '统计映射行数'
  )
  return Number(firstRow<{ c: number }>(rows)?.c ?? 0)
}
