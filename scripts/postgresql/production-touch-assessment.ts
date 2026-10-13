/**
 * PostgreSQL 迁移：**"真实库有没有被改动过"的内容评估**（只读、可复用）。
 *
 * ============================================================================
 *  用途
 * ============================================================================
 *  当某个环节**可能**碰过 `data/pglite` 时，需要的不是"看 mtime 变了没有"，
 *  而是"**内容**变了没有"。本工具用 WP4/WP5 已经建好的量具回答后者：
 *
 * ```text
 *   ① 把**候选目录**（例如 data/pglite）**复制**到 %TEMP%（源目录只读、只被 cpSync）
 *   ② 用 `openPgliteSnapshot` 打开**副本**（拒绝直接打开 data/pglite）
 *   ③ 同一套逐表规范化摘要，与**参照快照**逐表比较
 *   ⇒ 结论是"内容一致 / 哪几张表不一致"，而不是"时间戳变了"
 * ```
 *
 *  ⚠️ 为什么 mtime 不够：PGlite 启动本身会写 `pg_control` / WAL / `pg_xact` 等
 *     **集群级**文件（mtime 必变），而用户数据可能一个字都没动。
 *     反过来也可能：有人清了 mtime。⇒ 判据必须落在**内容**上。
 *
 *  ⚠️ 本工具**只读**源目录：`cpSync` 读它，从不打开它。
 *
 * 跑法：pnpm tsx scripts/postgresql/production-touch-assessment.ts
 *   环境变量：LG_PG_ASSESS_CANDIDATE（缺省 data/pglite）
 *             LG_PG_ASSESS_REFERENCE（缺省 WP0 那个 verified 快照）
 */
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { openPgliteSnapshot } from './pglite-reader.ts'
import { compareTableDigests, tableDigest, type TableDigest } from './row-digest.ts'

const CANDIDATE = resolve(process.env.LG_PG_ASSESS_CANDIDATE ?? 'data/pglite')
const REFERENCE = resolve(
  process.env.LG_PG_ASSESS_REFERENCE ??
    'data/snapshots/desktop-actions-activation-20261009/pglite-2026-10-13T12-02-14-409Z-90cae4d22dcd'
)

interface Side {
  tables: Map<string, { rows: number; digest: TableDigest; columns: number; primaryKey: string[] }>
  attestation: unknown
  /** 副本里是否发现上电残留的 `postmaster.pid`（⇒ 说明源目录是**不洁净关闭**的） */
  stalePostmasterPid: boolean
}

/** 复制一份目录并只打开副本（源目录只读） */
function copyAside(source: string, label: string): { copy: string; stalePostmasterPid: boolean } {
  const workDir = join(tmpdir(), `lg-assess-${label}-${Date.now().toString(36)}`)
  rmSync(workDir, { recursive: true, force: true })
  mkdirSync(workDir, { recursive: true })
  const copy = join(workDir, 'copy')
  cpSync(source, copy, { recursive: true })
  let stale = false
  const pid = join(copy, 'postmaster.pid')
  if (existsSync(pid)) {
    stale = true
    // ⚠️ 只在**副本**里挪走它：源目录一个字节都不动
    renameSync(pid, `${pid}.assess-aside`)
  }
  return { copy, stalePostmasterPid: stale }
}

async function readSide(directory: string, label: string): Promise<Side> {
  const { copy, stalePostmasterPid } = copyAside(directory, label)
  const session = await openPgliteSnapshot({ sourceDir: copy })
  const tables = new Map<string, { rows: number; digest: TableDigest; columns: number; primaryKey: string[] }>()
  try {
    for (const table of await session.listTables()) {
      const key = `${table.schema}.${table.name}`
      const reading = await session.readTable(table.schema, table.name)
      tables.set(key, {
        rows: reading.rows.length,
        columns: reading.columns.length,
        primaryKey: reading.primaryKey,
        digest: tableDigest({ table: key, rows: reading.rows, columns: reading.columns, primaryKey: reading.primaryKey }),
      })
    }
    return { tables, attestation: await session.close(), stalePostmasterPid }
  } finally {
    rmSync(resolve(copy, '..'), { recursive: true, force: true })
  }
}

function treeSize(root: string): { files: number; bytes: number } {
  let files = 0
  let bytes = 0
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else {
        files += 1
        bytes += statSync(full).size
      }
    }
  }
  walk(root)
  return { files, bytes }
}

async function main(): Promise<void> {
  if (!existsSync(join(CANDIDATE, 'PG_VERSION'))) throw new Error(`候选目录不是 PGlite 库：${CANDIDATE}`)
  if (!existsSync(join(REFERENCE, 'PG_VERSION'))) throw new Error(`参照快照不是 PGlite 库：${REFERENCE}`)

  console.log(`候选（被评估的目录）: ${CANDIDATE}`)
  console.log(`参照（应当相同的）  : ${REFERENCE}`)
  console.log('')

  const [candidate, reference] = [await readSide(CANDIDATE, 'candidate'), await readSide(REFERENCE, 'reference')]

  const candidateKeys = [...candidate.tables.keys()].sort()
  const referenceKeys = [...reference.tables.keys()].sort()
  const missing = referenceKeys.filter((k) => !candidate.tables.has(k))
  const extra = candidateKeys.filter((k) => !reference.tables.has(k))

  const mismatched: string[] = []
  for (const key of referenceKeys) {
    const a = reference.tables.get(key)
    const b = candidate.tables.get(key)
    if (a === undefined || b === undefined) continue
    const result = compareTableDigests(a.digest, b.digest)
    if (!result.match) mismatched.push(`${key}:${result.reason ?? '?'}`)
  }

  console.log(`表数 候选=${candidateKeys.length} 参照=${referenceKeys.length}`)
  console.log(`参照有而候选没有：${missing.length === 0 ? '(none)' : missing.join(', ')}`)
  console.log(`候选有而参照没有：${extra.length === 0 ? '(none)' : extra.join(', ')}`)
  console.log(`内容不一致的表  ：${mismatched.length === 0 ? '(none)' : mismatched.join(', ')}`)
  console.log('')
  console.log(`候选目录里有上电残留 postmaster.pid：${candidate.stalePostmasterPid}`)
  console.log(`参照快照里有上电残留 postmaster.pid：${reference.stalePostmasterPid}`)
  console.log(`候选目录物理规模（**不是**判据）：${JSON.stringify(treeSize(CANDIDATE))}`)
  console.log('')
  console.log(`自证（候选副本）: ${JSON.stringify(candidate.attestation)}`)
  console.log(`自证（参照副本）: ${JSON.stringify(reference.attestation)}`)
  console.log('')
  const verdict = missing.length === 0 && extra.length === 0 && mismatched.length === 0
  console.log(
    verdict
      ? '✅ 结论：候选目录的**表内容**与参照快照逐表相同（集群级文件的 mtime 变化不构成内容变化）'
      : '❌ 结论：候选目录的**表内容**与参照快照**不同** —— 见上面逐表清单'
  )
  if (!verdict) process.exitCode = 1
}

await main()
