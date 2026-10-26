/**
 * 覆盖参照登记器（2026-10-23 · P2.1 第四批）
 *
 * ⚠️ **它只登记"人已经复核过的参照"**：`find()` 只返回 `humanReview = APPROVED`
 *    的条目 ⇒ 未复核的代理标注**永远进不了证据链**，覆盖保持 `unknown`。
 *
 * ⚠️ **缺省没有登记器**：不配置目录 ⇒ 没有任何参照 ⇒ 覆盖命题在运行时恒为
 *    `unknown`。这是**事实状态**，不是"覆盖良好"。
 *
 * ⚠️ 参照条目按**路径**索引，但**有效性由字节指纹决定**：适配器会用当前字节
 *    复算 SHA-256，与参照登记的指纹不符 ⇒ 不出覆盖回执（覆盖未知）。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  readDocumentCoverageReference,
  type DocumentCoverageReference,
} from '../../kernel/contracts/document-coverage.ts'

export interface DocumentCoverageReferenceEntry {
  /** 参照登记的**原始路径**（与行动参数里的 path 逐字一致）。 */
  readonly path: string
  readonly reference: DocumentCoverageReference
}

export interface DocumentCoverageReferencePort {
  /** 只返回**真人复核通过**的参照。 */
  find(rawPath: string): DocumentCoverageReference | undefined
  /** 全部登记条目（含未复核的），只用于诊断与门。 */
  entries(): readonly DocumentCoverageReferenceEntry[]
}

function parseEntry(value: unknown): DocumentCoverageReferenceEntry | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const v = value as Record<string, unknown>
  if (typeof v.path !== 'string' || v.path.length === 0) return undefined
  const reference = readDocumentCoverageReference(v.reference)
  return reference ? { path: v.path, reference } : undefined
}

export function createMemoryDocumentCoverageReferencePort(
  entries: readonly DocumentCoverageReferenceEntry[],
): DocumentCoverageReferencePort {
  const usable = entries.filter(entry => entry.reference.humanReview === 'APPROVED')
  return {
    find(rawPath) { return usable.find(entry => entry.path === rawPath)?.reference },
    entries() { return entries },
  }
}

/**
 * 从目录读取登记条目。
 *
 * ⚠️ 目录缺省不存在 ⇒ 空登记器（覆盖恒 `unknown`）。
 * ⚠️ 非法条目**被跳过**并计数，不静默变成"通过"。
 */
export function createDocumentCoverageReferencePort(options: { directory?: string } = {}): DocumentCoverageReferencePort {
  const entries: DocumentCoverageReferenceEntry[] = []
  const skipped: number[] = []
  const directory = options.directory
  if (directory !== undefined && directory.length > 0) {
    for (const file of readdirSync(resolve(directory)).filter(name => name.endsWith('.json')).sort()) {
      let parsed: unknown
      try { parsed = JSON.parse(readFileSync(join(resolve(directory), file), 'utf8')) }
      catch { skipped.push(1); continue }
      const list = Array.isArray(parsed) ? parsed : [parsed]
      for (const item of list) {
        const entry = parseEntry(item)
        if (entry) entries.push(entry)
        else skipped.push(1)
      }
    }
  }
  const port = createMemoryDocumentCoverageReferencePort(entries)
  return { find: rawPath => port.find(rawPath), entries: () => port.entries() }
}
