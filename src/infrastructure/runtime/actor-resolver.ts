/**
 * ActorResolver —— transport 身份 → **稳定领域身份**（WP4）。
 *
 * ============================================================================
 *  计划书第 7 / 25 / 91 节
 * ============================================================================
 * 这个文件的全部意义是回答一个问题：
 *
 *   > 同一个用户在 Session A 与 Session B 里，是不是同一个人？
 *
 * 答案必须是"是"。而这个问题要成立，就必须有**一处**负责把
 * "平台侧的身份"翻译成"我们的身份"，而且那个翻译必须是**确定性**的：
 * 同一个 `(transport, externalId)` 永远得到同一个 UserId。
 *
 * ---------------------------------------------------------------------------
 *  三条刻意的设计
 * ---------------------------------------------------------------------------
 * 1. **不是哈希**。M1/M2 用 `stringToUuid('user-Alex')` 推导 userId，
 *    那不是加密哈希，只是一个确定性的字符串→UUID 映射。M3 沿用同一套
 *    推导规则（通过注入 `deriveUserId`），因此**既有数据不需要迁移**：
 *    老消息里的 userId 与新事件里的 userId 是同一个值。
 *    换一套推导规则等于把用户变成另一个人 —— 那正是本文件要防的事。
 *
 * 2. **映射表只增不改**。`user_identity_mappings` 用 `on conflict do nothing`：
 *    一个 transport 身份一旦绑定到某个 UserId 就**不换人**。
 *    如果允许改绑，历史上属于 A 的事实会突然属于 B。
 *
 * 3. **解析失败就抛错，不猜**。看不到 externalId、又没有已绑定的映射时
 *    拒绝解析，而不是"新建一个用户"。凭空造一个 UserId 会把
 *    "同一个人的两段历史"永久劈成两半。
 */

import {
  KernelError,
  participantsMismatch,
  type ConversationId,
  type Participants,
} from '../../kernel/contracts/index.ts'
import type { RawDb } from '../persistence/db.ts'
import {
  bindTransportIdentity,
  ensureConversationIdentity,
  ensureUserIdentity,
  getConversationIdentity,
  listConversationsForUser,
  resolveTransportIdentity,
} from '../persistence/identity-store.ts'

export interface ActorResolverOptions {
  db: RawDb
  /**
   * 由 `(transport, externalId)` 确定性推导 UserId。
   *
   * 注入而不是内联：M1/M2 用的是 ElizaOS 的 `stringToUuid`，
   * 而领域层/基础设施层不该 import ElizaOS。装配层把那个函数传进来，
   * 于是"用户 id 怎么算"这件事仍然只有一处（`main.ts` 的 `resolveIds`）。
   */
  deriveUserId: (input: { transport: string; externalId: string }) => string
  /** 缺省 transport（例如本项目 CLI 就是 'cli'） */
  defaultTransport?: string
}

export interface ResolvedUser {
  userId: string
  /** 本次解析是新建的？还是命中已有映射 / 推导出的？ */
  origin: 'mapping' | 'derived'
  transport: string
}

export class ActorResolver {
  private readonly options: ActorResolverOptions
  private readonly cache = new Map<string, ResolvedUser>()

  constructor(options: ActorResolverOptions) {
    this.options = options
  }

  /**
   * 解析用户身份。
   *
   * 顺序刻意如此：
   *   1. 查映射表（已绑定过 → 直接用，这是**权威**）
   *   2. 没有就按确定性规则推导，并把结果**写进映射表**
   *
   * 第 2 步的"写进映射表"很重要：它把"推导"变成"一次性的决定"。
   * 以后即使推导规则变了，已有用户的身份也不会跟着变。
   */
  async resolveUser(input: {
    transport?: string
    externalId?: string
    displayName?: string
  }): Promise<ResolvedUser> {
    const transport = input.transport ?? this.options.defaultTransport ?? 'cli'
    const externalId = input.externalId
    if (!externalId || externalId.trim() === '') {
      throw new KernelError(
        'validation_error',
        'actor_unresolved',
        `无法解析用户身份：transport=${transport} 没有提供 externalId。` +
          '归一化器刻意不猜 —— 凭空造一个 UserId 会把同一个人的两段历史永久劈开。'
      )
    }

    const cacheKey = `${transport}\u0000${externalId}`
    const cached = this.cache.get(cacheKey)
    if (cached) return cached

    const mapped = await resolveTransportIdentity(this.options.db, transport, externalId)
    if (mapped) {
      const resolved: ResolvedUser = { userId: mapped, origin: 'mapping', transport }
      this.cache.set(cacheKey, resolved)
      return resolved
    }

    const userId = this.options.deriveUserId({ transport, externalId })
    await ensureUserIdentity(this.options.db, userId, input.displayName)
    await bindTransportIdentity(this.options.db, { transport, externalId, userId })
    const resolved: ResolvedUser = { userId, origin: 'derived', transport }
    this.cache.set(cacheKey, resolved)
    return resolved
  }

  /**
   * 确保会话身份存在，并返回它的参与者三元组。
   *
   * ⚠️ 这里做一次**一致性检查**：如果同一个 ConversationId 已经属于
   * 另一个 (character, user)，直接抛错。
   *
   * 为什么这是硬错误而不是"覆盖一下"：会话 id 冲突意味着两条不同的
   * 对话历史会被写进同一个坐标，而事实账本是 append-only 的 ——
   * 覆盖之后无法分辨哪条属于谁。
   */
  async ensureConversation(input: {
    conversationId: ConversationId | string
    characterId: string
    userId: string
    label?: string
    transport?: string
  }): Promise<Participants> {
    const existing = await getConversationIdentity(this.options.db, input.conversationId)
    if (existing) {
      if (String(existing.characterId) !== String(input.characterId)) {
        throw participantsMismatch('characterId', String(existing.characterId), String(input.characterId))
      }
      if (existing.userId !== input.userId) {
        throw participantsMismatch('userId', existing.userId, input.userId)
      }
      return {
        characterId: existing.characterId,
        userId: existing.userId,
        conversationId: existing.conversationId,
      }
    }

    const record = await ensureConversationIdentity(this.options.db, {
      conversationId: input.conversationId,
      characterId: input.characterId,
      userId: input.userId,
      ...(input.label ? { label: input.label } : {}),
      ...(input.transport ? { transport: input.transport } : {}),
    })
    return {
      characterId: record.characterId,
      userId: record.userId,
      conversationId: record.conversationId,
    }
  }

  /**
   * 同一个用户的全部会话（计划书第 91 节的 Gate 判定材料）。
   *
   * 测试 T2/T10 靠它证明：换会话之后 CharacterId 与 UserId 不变，
   * 只有 ConversationId 变。
   */
  async conversationsOf(characterId: string, userId: string) {
    return listConversationsForUser(this.options.db, characterId, userId)
  }
}

/**
 * 把 ActorResolver 适配成 `IdentityResolving`（归一化器需要的形状）。
 *
 * 单独一个函数而不是让归一化器直接依赖类：归一化器只该认识接口
 * （它要能被纯内存的测试实现替换）。
 */
export function identityResolvingFrom(resolver: ActorResolver): {
  resolveCharacter(ref: string | undefined): string | undefined
  resolveConversation(
    characterId: string,
    ref: string | undefined
  ): Promise<string | undefined> | string | undefined
  resolveUser(input: {
    transport?: string
    externalId?: string
    displayName?: string
  }): Promise<string | undefined>
} {
  return {
    // 角色解析在 M3 是"原样透传"：本项目只有一个角色，
    // 而多角色路由是装配层的事。保留这个钩子是为了让归一化器的形状
    // 在 M3 之后不需要改。
    resolveCharacter: (ref) => ref,
    resolveConversation: (_characterId, ref) => ref,
    resolveUser: async (input) => {
      try {
        const resolved = await resolver.resolveUser(input)
        return resolved.userId
      } catch {
        // 归一化器会把 undefined 转成 `actor_unresolved` 错误，
        // 这里不再包一层：错误码应该只有一处定义。
        return undefined
      }
    },
  }
}
