/**
 * Seed 指纹的密码学实现（基础设施层）。
 *
 * ============================================================================
 *  为什么 hash 不在领域层算
 * ============================================================================
 * 领域层（`src/kernel/**`，`app/` 以外）**不许** import `node:crypto`
 * ——它有一条静态测试守着（依赖方向必须单向）。
 *
 * 但"指纹"这件事又必须只有一个定义。所以拆成两半：
 *
 *   领域层：`canonicalSeedJson(def)`  —— 决定**指纹材料是什么**
 *   基础设施：`hashSeed(def)`          —— 决定**用什么算法算**
 *
 * 这样换算法（sha256 → blake3）只需改这里，而"哪些内容算人格"这件事
 * 仍然由领域层单独决定。两者分开还有一个好处：
 * 单测可以在不碰 crypto 的情况下断言规范化是确定的。
 */

import { createHash } from 'node:crypto'

import { snapshotFingerprintMaterial, type CharacterDefinition } from '../../kernel/contracts/index.ts'

/** 规范化 Seed 的 sha256（十六进制）。内容版本变了它一定变。 */
export function hashSeed(def: CharacterDefinition): string {
  return createHash('sha256').update(snapshotFingerprintMaterial(def), 'utf8').digest('hex')
}

/** 任意字符串的 sha256（用于 snapshot / 幂等键等） */
export function sha256Hex(material: string): string {
  return createHash('sha256').update(material, 'utf8').digest('hex')
}

/**
 * 短指纹：人类可读的 12 位前缀。
 *
 * 用在命令行与日志里（`seed v3 (hash a1b2c3d4e5f6)`）——
 * 完整的 64 位十六进制在终端里只会让人跳过不看。
 */
export function shortHash(hash: string): string {
  return hash.slice(0, 12)
}
