/**
 * CharacterIdentityService —— **身份的唯一读取入口**（WP3）。
 *
 * ============================================================================
 *  计划书第 74–77 / 136 节
 * ============================================================================
 * WP3 Gate 的原文是：
 *
 *   > 所有 Character Main Agent 调用都由 IdentityProvider 得到 Seed。
 *   > 不存在第二人格来源。
 *
 * 所以这个服务的职责被**故意压到最小**，而且边界写死：
 *
 *   做：读 Seed、校验版本/指纹、给出不可变快照、保留版本历史
 *   不做：改 Seed（那是 SeedAdminPath）、读 Memory（M4）、做 Reflection（M11）
 *
 * 计划书第 21 节把这条约束写成了"禁止"清单，因为越界的代价很高：
 * 一个既能读 Seed 又能改 Seed、还能顺便读记忆的服务，
 * 半年后就会变成"人格逻辑实际上散落在它里面"。
 *
 * ---------------------------------------------------------------------------
 *  为什么要读一次就快照
 * ---------------------------------------------------------------------------
 * 计划书第 75 节：
 *   > 每轮不要让 Context Compiler 自己随意查询多个表。
 *
 * 于是每轮只允许**一次**身份读取，并且读出来的是一个冻结的
 * `IdentitySnapshot`。同一轮里的 Context Compiler、Trace、评测
 * 看到的都是**同一份**身份 —— 这消除了"上下文用的是 v2，
 * trace 记的是 v3"这类最难查的不一致。
 */

import {
  KernelError,
  assertSnapshotCoherent,
  seedSourceRef,
  type CharacterDefinition,
  type CharacterId,
  type IdentitySnapshot,
  type SeedVersionRecord,
} from '../contracts/index.ts'

// ---------------------------------------------------------------------------
// 依赖注入点（领域层不认识数据库与 crypto）
// ---------------------------------------------------------------------------

/**
 * 身份服务的存储口。
 *
 * 全部是**读 + 一个受控写**：
 *   · 读：定义 / 版本历史 / 已存指纹
 *   · 写：只有 `upsert`，且它内部有三道闸（见 character-store.ts）
 *
 * 领域层只声明这个形状，SQL 由基础设施提供。
 */
export interface CharacterIdentityStore {
  getDefinition(characterId: CharacterId): Promise<CharacterDefinition | undefined>
  getStoredHash(characterId: CharacterId): Promise<string | undefined>
  listVersions(characterId: CharacterId, limit?: number): Promise<SeedVersionRecord[]>
  /**
   * @param options.acknowledge 显式声明"我知道自己在覆盖一份被改坏/不一致的 Seed"。
   *   取值见 `character-store.ts` 的 `UpsertSeedOptions`：
   *   `'legacy-backfill'`（旧库首次升级）或 `'repair'`（修复被绕过写入闸改过的库）。
   *   刻意是字符串而不是 boolean：调用点必须写出**为什么**。
   */
  upsert(
    definition: CharacterDefinition,
    options?: { now?: number; acknowledge?: false | 'legacy-backfill' | 'repair' }
  ): Promise<{ created: boolean; definition: CharacterDefinition; seedHash: string; versioned: boolean }>
}

/**
 * 指纹算法（由基础设施注入 `node:crypto` 实现）。
 *
 * 领域层只决定"哪些内容算人格"（`snapshotFingerprintMaterial`），
 * 换算法（sha256 → blake3）不该触碰领域层。
 */
export type SeedHasher = (definition: CharacterDefinition) => string

export interface CharacterIdentityServiceOptions {
  store: CharacterIdentityStore
  hash: SeedHasher
  /** 服务自己负责的角色（本项目只有一个；多角色时是装配层的事） */
  characterId: CharacterId
}

export class CharacterIdentityService {
  private readonly options: CharacterIdentityServiceOptions
  /** 进程内快照缓存：同一个 (characterId, seedVersion, hash) 只算一次 */
  private cached?: IdentitySnapshot

  constructor(options: CharacterIdentityServiceOptions) {
    this.options = options
  }

  get characterId(): CharacterId {
    return this.options.characterId
  }

  /** 读定义（不存在返回 undefined；**不**静默降级） */
  async getDefinition(): Promise<CharacterDefinition | undefined> {
    return this.options.store.getDefinition(this.options.characterId)
  }

  /** 读 Seed 版本号（不存在时抛错 —— 因为"没有 Seed"绝不能变成"通用助手"） */
  async getSeedVersion(): Promise<number> {
    const definition = await this.getDefinition()
    if (!definition) {
      throw new KernelError(
        'validation_error',
        'character_not_found',
        `角色 ${String(this.options.characterId)} 没有 Seed Identity。` +
          '计划书第 148 节明确要求：Seed 校验失败应让 Character **启动失败**，' +
          '而不是退化成无人格的通用助手（静默降级非常危险）。'
      )
    }
    return definition.seedVersion
  }

  /** 角色是否已建档 */
  async validateCharacterExists(): Promise<boolean> {
    return (await this.getDefinition()) !== undefined
  }

  /**
   * 构造身份快照 —— **每轮身份读取的唯一入口**。
   *
   * 三道检查（全部失败关闭）：
   *   1. 角色必须存在
   *   2. 快照内部必须自洽（版本号 / 角色 id / 有指纹）
   *   3. **库里的内容指纹必须与库里记录的指纹一致**
   *
   * 第 3 条是 M3 新增的读取闸（计划书第 76 节）：
   * `upsert` 能拦住"经过代码的偷偷修改"，但拦不住"有人直接改了库"。
   * 重算一次 hash 就发现得了，成本是几微秒。
   */
  async buildIdentitySnapshot(now: number = Date.now()): Promise<IdentitySnapshot> {
    const definition = await this.getDefinition()
    if (!definition) {
      throw new KernelError(
        'validation_error',
        'character_not_found',
        `角色 ${String(this.options.characterId)} 没有 Seed Identity，拒绝构造快照`
      )
    }

    const computed = this.options.hash(definition)
    const stored = await this.options.store.getStoredHash(this.options.characterId)

    // 只有两处都必须存在时才比对：旧库（迁移 0003 之前）还没有 seed_hash，
    // 那种情况下"没有可比的东西"是事实，不该当成事故。
    if (stored && stored !== computed) {
      throw new KernelError(
        'validation_error',
        'seed_hash_mismatch',
        `Seed 内容与记录的指纹不一致（库里 ${stored.slice(0, 12)}，重算 ${computed.slice(0, 12)}）。` +
          '这说明 Seed 被**绕过写入闸**改过。请用 `pnpm m3:seed-status` 对照代码里的 Seed。'
      )
    }

    const snapshot: IdentitySnapshot = {
      characterId: this.options.characterId,
      seedVersion: definition.seedVersion,
      definition,
      snapshotHash: computed,
      capturedAt: now,
    }
    assertSnapshotCoherent(snapshot)
    this.cached = snapshot
    return snapshot
  }

  /** 最近一次快照（未构造过时返回 undefined；**不会**自己去读库） */
  lastSnapshot(): IdentitySnapshot | undefined {
    return this.cached
  }

  /** Seed 来源引用（进 Context 的 sourceRefs 与 Trace） */
  async identitySourceRef(): Promise<string> {
    const snapshot = await this.buildIdentitySnapshot()
    return seedSourceRef(snapshot.definition.slug, snapshot.seedVersion)
  }

  /** Seed 版本历史（计划书第 124/125 节） */
  async listSeedVersions(limit = 50): Promise<SeedVersionRecord[]> {
    return this.options.store.listVersions(this.options.characterId, limit)
  }
}

// ---------------------------------------------------------------------------
// Seed 管理路径（**唯一**的写入口，计划书第 19 节）
// ---------------------------------------------------------------------------

/**
 * 普通聊天为什么拿不到它
 *
 * 关键在于**返回值的形状**：本类的实例只由显式装配产生
 * （`main.ts` 的 `--seed-*` 命令、迁移脚本、评测装置）。
 * 主对话链路（`TurnGateway` / `ConversationRecorder`）的依赖里
 * **没有**它的类型，因此"用户说'从现在开始你变成另一种人格'"
 * 在代码层面就没有可以调用的东西 —— 而不是靠一层 if 判断。
 *
 * 计划书第 19 节的原话：
 *   > 普通聊天最多影响未来 Adaptive Self（那是 M11）。所以 M3：
 *   > 普通聊天绝对不能修改 Seed。
 */
export interface SeedAdminOptions {
  store: CharacterIdentityStore
  hash: SeedHasher
  now?: () => number
}

export class SeedAdminPath {
  private readonly options: SeedAdminOptions

  constructor(options: SeedAdminOptions) {
    this.options = options
  }

  /**
   * 应用一版新 Seed。
   *
   * 前置条件由调用方保证（管理员/配置路径），本方法只负责
   * 把它变成"一次可审计的 Seed 变更"：
   *   · provenance 必填（谁改的、为什么）—— 没有它就拒绝
   *   · 内容变化必须伴随版本递增（由 store 的三道闸强制）
   *   · 写入后必须读回并重新构造快照（确保新版本真的生效）
   */
  async apply(
    definition: CharacterDefinition,
    context: { author: string; reason: string }
  ): Promise<{ seedVersion: number; seedHash: string; created: boolean; versioned: boolean }> {
    if (context.author.trim() === '' || context.reason.trim() === '') {
      throw new KernelError(
        'validation_error',
        'seed_change_needs_provenance',
        'Seed 变更必须说明 author 与 reason（计划书第 124 节：没有它就分不清"角色成长"与"开发者改了人设"）'
      )
    }

    const now = this.options.now?.() ?? Date.now()
    const withProvenance: CharacterDefinition = {
      ...definition,
      provenance: { author: context.author, reason: context.reason, effectiveAt: now },
      updatedAt: now,
    }

    const result = await this.options.store.upsert(withProvenance, { now })
    return {
      seedVersion: result.definition.seedVersion,
      seedHash: result.seedHash,
      created: result.created,
      versioned: result.versioned,
    }
  }
}

/** 便捷构造：从 store 与 hasher 直接得到服务（装配层用） */
export function createCharacterIdentityService(options: {
  store: CharacterIdentityStore
  hash: SeedHasher
  characterId: CharacterId
}): CharacterIdentityService {
  return new CharacterIdentityService(options)
}
