/**
 * IdentitySnapshot —— **这一轮她用的是哪一版人格**。
 *
 * ============================================================================
 *  计划书第 74–77 / 122 节
 * ============================================================================
 * 计划书对 Context Compiler 提了一条明确的约束：
 *
 *   > 每轮不要让 Context Compiler 自己随意查询多个表。
 *
 * 所以身份读取被收进 `CharacterIdentityService`，它对外只交出一个
 * **不可变的快照**：定义 + 版本 + 指纹。于是：
 *
 *   · Context Compiler 只认识 `IdentitySnapshot`，不认识数据库
 *   · Trace 记下 `snapshotHash`，事后可以回答"她当时读到的到底是哪一版"
 *   · 评测可以拿它做确定性断言（seedVersion / seedHash 不变）
 *
 * ---------------------------------------------------------------------------
 *  为什么 snapshotHash 是必须的
 * ---------------------------------------------------------------------------
 * 计划书第 76 节给了一个非常具体的场景：
 *
 *   > 配置文件被偷偷修改但版本没更新 → 可以检测出来。
 *
 * 这不是假想。M2.5 的 `upsertCharacterDefinition` 已经会拒绝
 * "内容变了不升版本"，但它只能拒绝**经过代码**的写入。
 * 有了 hash，**读取方**也能发现不一致：库里存的 hash 与
 * 从 definition_json 重算出来的 hash 不同 → 说明有人直接改了库。
 * 前者是写入闸，后者是读取闸，两者都需要。
 */

import { KernelError, type CharacterId, type Timestamp } from './ids.ts'
import type { CharacterDefinition } from './character-definition.ts'
import { canonicalSeedJson, seedFingerprint } from './character-definition.ts'

export interface IdentitySnapshot {
  characterId: CharacterId
  /** Seed 的内容版本（改一个字就 +1） */
  seedVersion: number
  /** 定义本身（只读使用；**不得**被调用方改写后回写） */
  definition: CharacterDefinition
  /**
   * 规范化 Seed 的指纹材料（十六进制 sha256，由基础设施层算出）。
   *
   * 领域层只负责"指纹材料是什么"（`seedFingerprint`），
   * 具体 hash 算法由基础设施决定 —— 领域层不 import `node:crypto`。
   */
  snapshotHash: string
  /** 生成快照的时间（**不进 hash**：取一次快照不该改变人格指纹） */
  capturedAt: Timestamp
}

/**
 * Seed 引用字符串 —— ContextTrace 里出现的形状。
 *
 * 形如 `character-definition:sumuwei@3`。刻意是**人类可读**的：
 * 排查"她为什么这样说"时，第一眼要能看到版本，
 * 而不是先去解一个 UUID。
 */
export function seedSourceRef(characterId: CharacterId | string, seedVersion: number): string {
  return `character-definition:${String(characterId)}@${seedVersion}`
}

/** 从 sourceRef 解析回 (id, version)。仅供测试与诊断入口使用。 */
export function parseSeedSourceRef(ref: string): { characterId: string; seedVersion: number } | undefined {
  const match = /^character-definition:(.+)@(\d+)$/.exec(ref)
  if (!match) return undefined
  return { characterId: match[1], seedVersion: Number(match[2]) }
}

/**
 * 快照的指纹材料。
 *
 * ⚠️ 刻意**不复用** `seedFingerprint()`：后者是"Seed 是什么"的定义，
 * 而快照指纹还要绑定 charactedId 与版本，因为 Trace 需要的是
 * "她这一轮读到的这一份**具体**身份"，包含"是哪个角色的第几版"。
 *
 * 两者的关系：快照材料 = 角色坐标 ⊕ 内容指纹。
 */
export function snapshotFingerprintMaterial(def: CharacterDefinition): string {
  return [String(def.id), String(def.seedVersion), canonicalSeedJson(def)].join('\u0000')
}

/** 领域侧的内容指纹（不含角色坐标），供校验"库里存的是不是同一份内容" */
export function contentFingerprint(def: CharacterDefinition): string {
  return seedFingerprint(def)
}

/**
 * 校验一个快照内部自洽（**失败关闭**）。
 *
 * 计划书第 77 节：任何 Seed 修改都必须同时改变 version / updatedAt / hash，
 * 否则**拒绝启动或者报警**。
 *
 * 这里能做的是"快照自己是不是自洽"：版本号与定义里的版本必须一致。
 * "hash 与内容是否一致"需要重新计算 hash（基础设施层），
 * 因此由 `CharacterIdentityService` 在构造快照时一并检查。
 */
export function assertSnapshotCoherent(snapshot: IdentitySnapshot): void {
  if (snapshot.definition.seedVersion !== snapshot.seedVersion) {
    throw new KernelError(
      'validation_error',
      'identity_snapshot_version_mismatch',
      `IdentitySnapshot 自相矛盾：快照声明 v${snapshot.seedVersion}，` +
        `但定义里是 v${snapshot.definition.seedVersion}。` +
        '这说明有人在不升版本的前提下改了 Seed（计划书第 77 节）。'
    )
  }
  if (String(snapshot.definition.id) !== String(snapshot.characterId)) {
    throw new KernelError(
      'validation_error',
      'identity_snapshot_character_mismatch',
      `IdentitySnapshot 自相矛盾：快照声明 ${String(snapshot.characterId)}，` +
        `定义里是 ${String(snapshot.definition.id)}`
    )
  }
  if (snapshot.snapshotHash.trim() === '') {
    throw new KernelError(
      'validation_error',
      'identity_snapshot_missing_hash',
      'IdentitySnapshot 缺少 snapshotHash：没有指纹就无法回答"她当时用的是哪一版"'
    )
  }
}

/**
 * Seed 历史条目（计划书第 124/125 节）。
 *
 * **不要**用 UPDATE 把旧 Seed 覆盖掉。因为未来 M11 的 Adaptive Self 出现后，
 * "她变了"有三种可能：真的成长 / 开发者改 Seed / 模型漂移。
 * 没有 Seed History，这三种无法区分。
 */
export interface SeedVersionRecord {
  characterId: CharacterId
  seedVersion: number
  seedHash: string
  definition: CharacterDefinition
  /** 本版本生效的时间 */
  effectiveAt: Timestamp
  /** 本次修改的作者与原因（来自 definition.provenance） */
  author?: string
  reason?: string
}
