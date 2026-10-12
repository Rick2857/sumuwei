/**
 * 内容指纹 —— **基础设施实现**（M5.5）。
 *
 * kernel 侧只声明形状（`ContentFingerprinter`），因为它不得 import `node:crypto`。
 * 指纹的用途是让"这一轮引用的是哪条证据"可以跨进程复核：
 *
 *   · 进账本 / trace 的**只有** `contentFingerprint`
 *   · 摘要正文永远不落库（ADR-045 `D-8`）
 *
 * ⚠️ 它不是安全机制（不是签名、不是 MAC）：它只回答"同一条内容"。
 *    取前 16 个十六进制字符（64 bit）是为了让它在账本里短到可读，
 *    碰撞概率对本用途（同一轮里的几条搜索结果）足够低。
 */

import { createHash } from 'node:crypto'

import type { ContentFingerprinter } from '../../kernel/contracts/external-evidence.ts'

export function createSha256Fingerprinter(hexLength = 16): ContentFingerprinter {
  return (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex').slice(0, hexLength)
}
