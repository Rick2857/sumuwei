/**
 * M6.1 —— 真实库的**只读**读数辅助：最新 mtime 扫描。
 *
 * ============================================================================
 *  它为什么单独成模块
 * ============================================================================
 * ```text
 * ① 计划书 §6.3 要求每次运行前后记"真实库摘要**与 mtime**"，两个都要：
 *      摘要（digestTree）= **内容**证据，更强；
 *      mtime            = "有没有被碰过"的独立信号（内容相同也可能被碰过）。
 * ② 它必须能被**独立的门**测到 —— 如果它只写在 `m6.1-baseline.ts` 里，
 *    那个文件是"顶层就 `main()`"的 CLI，import 它就会跑整场基线。
 *    ⇒ 抽成模块，让门能对着**真函数**做三段式（正控 / 负控 / 恢复），
 *      而不是对着一个抄来的副本测（那是"量具测了错的对象"）。
 * ```
 *
 * ⚠️ 纪律：只 `readdir` + `stat`，**绝不打开数据库**；扫到 0 个文件 ⇒ 抛错
 *    （"没测到"不能显示成"没变化"）。
 */

import { readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

export interface MtimeReadout {
  readonly files: number
  readonly newestMtimeMs: number
  /** 相对 root 的路径（正斜杠），便于人核对是哪个文件 */
  readonly newestPath: string
}

export function newestMtimeMs(root: string): MtimeReadout {
  let files = 0
  let newest = -1
  let newestPath = ''
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(abs)
        continue
      }
      const stat = statSync(abs)
      files += 1
      if (stat.mtimeMs > newest) {
        newest = stat.mtimeMs
        newestPath = relative(root, abs).split(/[\\/]/).join('/')
      }
    }
  }
  walk(root)
  if (files === 0) {
    throw new Error(`MEASUREMENT INVALID：${root} 未 stat 到任何文件（measured_count = 0）`)
  }
  return { files, newestMtimeMs: newest, newestPath }
}
