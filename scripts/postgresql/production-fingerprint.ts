/**
 * 真实库目录的**轻量指纹**（只 `readdir` + `stat`：**不读内容、不打开库**）。
 *
 * ============================================================================
 *  它为什么存在（`PG-ISO-01` 的产物）
 * ============================================================================
 *  2026-10-13 的事故里，`PG-G06` 的核心**静默回退成 PGlite 适配器**、打开了真实库
 *  `data/pglite` 并写了集群级文件（`pg_control` / WAL / `pg_xact` / `postmaster.pid` …）。
 *  当时唯一的发现方式是门自己的身份核对；而"真实库有没有被动过"**此前靠我每轮收尾手工看**。
 *
 *  ⇒ 本函数把那一行变成**门内可断言的读数**：文件数 + `(路径,大小)` 摘要 + 最新 mtime，
 *    前后各取一次，要求**逐字相同**。此后**每道新门都带这条**。
 *
 *  ⚠️ 为什么不用"内容摘要"：算全目录内容摘要要读 ~49MB，每道门都做一次太贵；
 *    而"文件数 + 每个文件的大小 + 最新 mtime"已经能抓到"被打开过并写过集群文件"这一类
 *    （事故当时的实测就是 mtime 变了而**大小没变**，所以 mtime 那一项是必需的）。
 *    要判**内容**是否变了，用 `production-touch-assessment.ts`（逐表规范化摘要）。
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const PRODUCTION_DB_DIR = resolve('data/pglite')

export interface ProductionDirFingerprint {
  files: number
  bytes: number
  digest: string
  newestMtimeMs: number
}

export function productionDirFingerprint(
  root: string = PRODUCTION_DB_DIR
): ProductionDirFingerprint {
  const entries: string[] = []
  let bytes = 0
  let newest = 0
  const walk = (dir: string, rel: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      const next = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (entry.isDirectory()) walk(full, next)
      else {
        const info = statSync(full)
        bytes += info.size
        newest = Math.max(newest, info.mtimeMs)
        entries.push(`${next}\u0000${info.size}`)
      }
    }
  }
  if (!existsSync(root)) return { files: 0, bytes: 0, digest: '(absent)', newestMtimeMs: 0 }
  walk(root, '')
  entries.sort()
  return {
    files: entries.length,
    bytes,
    digest: createHash('sha256').update(entries.join('\n')).digest('hex'),
    newestMtimeMs: newest,
  }
}

/** 前后两次指纹必须**逐字相同**；不同就抛（调用方在门里包成一条断言） */
export function assertProductionDirUnchanged(
  before: ProductionDirFingerprint,
  after: ProductionDirFingerprint
): void {
  if (after.files !== before.files) throw new Error(`真实库文件数变了：${before.files} → ${after.files}`)
  if (after.digest !== before.digest) throw new Error('真实库 (路径,大小) 摘要变了')
  if (after.newestMtimeMs !== before.newestMtimeMs) {
    throw new Error(
      `真实库有文件被写过（最新 mtime 变了）：${new Date(before.newestMtimeMs).toISOString()} → ${new Date(after.newestMtimeMs).toISOString()}`
    )
  }
}
