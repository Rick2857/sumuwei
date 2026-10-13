/**
 * PostgreSQL 迁移 WP4：**在线备份**的清单、校验与**具名拒收**。
 *
 * ============================================================================
 *  这道模块解决两件在计划里被分开写、但其实是同一件事的要求
 * ============================================================================
 *  计划 §4/WP4 的交付物里有 "manifest、数据摘要" 与 "损坏备份拒收"；
 *  验收契约 `PG-G07` 的 `G07.3` / `G07.4` 把它写成
 *
 * ```text
 *   G07.3  篡改备份 ⇒ 拒收（**具名原因**）
 *   G07.4  截断备份 ⇒ 拒收（**具名原因**）
 * ```
 *
 *  ⇒ 判据不能只是"`sha256` 不匹配"。它必须是**能分开的**：
 *     "文件短了" 与 "内容被改了但长度没变" 是两种不同的损坏，
 *     给出同一个原因就等于没有诊断力。所以这里是一条**有序**的检查链，
 *     每条给**互不相同**的具名原因（顺序见 `verifyBackupFile` 的注释）。
 *
 * ---------------------------------------------------------------------------
 *  ⚠️ 一条真实的边界：清单是从**文件自身**算出来的
 * ---------------------------------------------------------------------------
 *  `parsePlainDump` 只读 SQL 文本，不连数据库。于是清单有两条性质：
 *    · 好的一面：`verifyBackupFile` 是**纯文件检查** ⇒ 拒收发生在**恢复之前**
 *      （这一点由 `PG-G07` 门显式断言：拒收时目标库必须还不存在）；
 *    · 要如实说的：`rows` 来自 `COPY … FROM stdin;` 块的行数，
 *      这依赖 "COPY 文本格式把行内换行转义成 `\n`"（见 `L-PGW4-08`）。
 *      真出现一个含**裸换行**的 COPY 块，行数就会被多算 —— 那会让
 *      "结构校验"变成假的红，而不是假的绿（宁可假红）。
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'

import type { PgIdentity } from './pg-exec.ts'

/** `pg_dump` 认得出的结尾行（plain 格式逐字如此） */
export const DUMP_END_MARKER = '-- PostgreSQL database dump complete'
/** `pg_dump` plain 格式的抬头 */
export const DUMP_HEADER = '-- PostgreSQL database dump'

export interface DumpTableEntry {
  /** `schema.table`（**逐字**取自 dump，含引号形式） */
  name: string
  /** 该表 `COPY` 块的数据行数 */
  rows: number
  /** 该 `COPY` 块内容的摘要（不含块首尾两行） */
  blockDigest: string
}

export interface BackupManifest {
  format: 'pg_dump-plain'
  /** 备份文件的**相对**路径（绝对路径不进证据文件） */
  file: string
  bytes: number
  sha256: string
  capturedAtUtc: string
  capturedAtUtc8: string
  /** `-- Dumped by pg_dump version X` 读回来的值（不是写死的常量） */
  pgDumpVersion: string | null
  /** `-- Dumped from database version X` */
  dumpedFromVersion: string | null
  /** `PG-G07.7`：备份**源**身份（与恢复目标身份分开记） */
  sourceIdentity: PgIdentity
  tables: DumpTableEntry[]
  totalRows: number
  /** 对 `tables`（排序后）的规范化摘要 —— 这就是交付物里的"数据摘要" */
  contentDigest: string
  endMarkerPresent: boolean
  dumpArgs: string[]
}

export type BackupRefusalReason =
  | 'backup_file_missing'
  | 'backup_empty'
  | 'backup_header_missing'
  | 'backup_truncated'
  | 'backup_digest_mismatch'
  | 'backup_structure_mismatch'

export type BackupVerification =
  | { ok: true; bytes: number; sha256: string; totalRows: number; contentDigest: string }
  | { ok: false; reason: BackupRefusalReason; detail: string }

export interface ParsedPlainDump {
  bytes: number
  sha256: string
  pgDumpVersion: string | null
  dumpedFromVersion: string | null
  tables: DumpTableEntry[]
  totalRows: number
  contentDigest: string
  endMarkerPresent: boolean
  headerPresent: boolean
}

/**
 * 解析一份 `pg_dump` plain 格式的 SQL **文本**。
 *
 * ⚠️ 刻意**不**用正则全文匹配 `CREATE TABLE`：那会把函数体/注释里的同名文本也算进来。
 *    这里按行扫描，只在**行首**认 `COPY <name> (…) FROM stdin;`，
 *    并用 `\.` 收尾 —— 数据行数只从**块**里数。
 */
export function parsePlainDump(sql: string): ParsedPlainDump {
  const sha256 = createHash('sha256').update(sql, 'utf8').digest('hex')
  const bytes = Buffer.byteLength(sql, 'utf8')
  const pgDumpVersion = /^-- Dumped by pg_dump version (.+)$/m.exec(sql)?.[1]?.trim() ?? null
  const dumpedFromVersion = /^-- Dumped from database version (.+)$/m.exec(sql)?.[1]?.trim() ?? null

  const tables: DumpTableEntry[] = []
  const lines = sql.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^COPY ([^\s(]+) \(/.exec(lines[index])
    if (match === null) continue
    const name = match[1]
    const block: string[] = []
    let cursor = index + 1
    // ⚠️ 找不到 `\.` 时**不**把剩余全文当成数据：那会把"文件被截断"伪装成
    //    "最后一张表有几十万行"。⇒ 空块 + 由 endMarker 缺失去报截断。
    while (cursor < lines.length && lines[cursor] !== '\\.') {
      block.push(lines[cursor])
      cursor += 1
    }
    tables.push({
      name,
      rows: block.length,
      blockDigest: createHash('sha256').update(block.join('\n'), 'utf8').digest('hex'),
    })
    index = cursor
  }

  const sorted = [...tables].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return {
    bytes,
    sha256,
    pgDumpVersion,
    dumpedFromVersion,
    tables,
    totalRows: tables.reduce((sum, table) => sum + table.rows, 0),
    contentDigest: createHash('sha256')
      .update(sorted.map((table) => `${table.name}\u0000${table.rows}\u0000${table.blockDigest}`).join('\n'), 'utf8')
      .digest('hex'),
    endMarkerPresent: sql.includes(DUMP_END_MARKER),
    headerPresent: sql.includes(DUMP_HEADER),
  }
}

/**
 * 备份清单。
 *
 * ⚠️ 关于"被 `--no-comments` 排除的那 2 条扩展注释"：实测结论是**代价为 0** ——
 *    那 2 条不是人写的，是**扩展自己的安装脚本**写的（`vector--0.8.7.sql` 末尾那句
 *    `COMMENT ON EXTENSION vector IS …`）。目标侧一装扩展就自带同样的注释；
 *    而**带上**它们反而会让恢复失败：`COMMENT ON EXTENSION` 要求扩展所有权，
 *    `vector` 非 trusted ⇒ 目标库里它归 bootstrap，迁移账号改不动
 *    （实测 `ERROR: must be owner of extension vector`，而 `ALTER EXTENSION … OWNER TO`
 *    语法不存在）。判据在 `PG-G07`：**源与目标的扩展注释逐字相同**（不是"条数相同"）。
 */
export function buildBackupManifest(input: {
  file: string
  /** 证据里记的相对路径；缺省用 `file` 本身 */
  relativeFile?: string
  sourceIdentity: PgIdentity
  dumpArgs: string[]
  capturedAt?: Date
}): BackupManifest {
  const parsed = parsePlainDump(readFileSync(input.file, 'utf8'))
  const capturedAt = input.capturedAt ?? new Date()
  return {
    format: 'pg_dump-plain',
    file: input.relativeFile ?? input.file,
    bytes: parsed.bytes,
    sha256: parsed.sha256,
    capturedAtUtc: capturedAt.toISOString(),
    capturedAtUtc8: `${capturedAt.toISOString().slice(0, 10)} ${new Date(capturedAt.getTime() + 8 * 3600_000)
      .toISOString()
      .slice(11, 19)} (UTC+8)`,
    pgDumpVersion: parsed.pgDumpVersion,
    dumpedFromVersion: parsed.dumpedFromVersion,
    sourceIdentity: input.sourceIdentity,
    tables: parsed.tables,
    totalRows: parsed.totalRows,
    contentDigest: parsed.contentDigest,
    endMarkerPresent: parsed.endMarkerPresent,
    dumpArgs: input.dumpArgs,
  }
}

/**
 * 校验一份备份文件是否与清单相符。**有序**检查链：
 *
 * ```text
 *   ① 存在吗           ⇒ backup_file_missing        （文件根本不在）
 *   ② 是空的吗         ⇒ backup_empty               （0 字节）
 *   ③ 有抬头吗         ⇒ backup_header_missing      （根本不是 plain dump）
 *   ④ 长度对得上吗     ⇒ backup_truncated           （短了 / 长了 = 字节数变了）
 *   ⑤ 有结尾行吗       ⇒ backup_truncated           （长度凑巧相同但尾部被抹）
 *   ⑥ 内容摘要对吗     ⇒ backup_digest_mismatch     （长度相同、内容被改）
 *   ⑦ 结构（表/行数）对吗 ⇒ backup_structure_mismatch
 * ```
 *
 * ⚠️ ④ 放在 ⑥ 前面是**刻意的**：截断同时也会让摘要不匹配，但"字节数变了"
 *    是更具体、更有诊断力的原因。反过来（先报摘要）会让"长度没变的内容篡改"
 *    与"截断"共用一个原因 —— 那条判据就失去区分能力了。
 */
export function verifyBackupFile(file: string, manifest: BackupManifest): BackupVerification {
  if (!existsSync(file)) {
    return { ok: false, reason: 'backup_file_missing', detail: file }
  }
  const bytes = statSync(file).size
  if (bytes === 0) {
    return { ok: false, reason: 'backup_empty', detail: `${file} 是 0 字节` }
  }
  const sql = readFileSync(file, 'utf8')
  const parsed = parsePlainDump(sql)

  if (!parsed.headerPresent) {
    return {
      ok: false,
      reason: 'backup_header_missing',
      detail: `文件里找不到「${DUMP_HEADER}」⇒ 它不是 plain 格式的 pg_dump 输出`,
    }
  }
  if (bytes !== manifest.bytes) {
    return {
      ok: false,
      reason: 'backup_truncated',
      detail: `字节数 ${bytes} ≠ 清单 ${manifest.bytes}（差 ${bytes - manifest.bytes}）`,
    }
  }
  if (manifest.endMarkerPresent && !parsed.endMarkerPresent) {
    return {
      ok: false,
      reason: 'backup_truncated',
      detail: `长度与清单相同但缺少结尾行「${DUMP_END_MARKER}」⇒ 尾部被抹过`,
    }
  }
  if (parsed.sha256 !== manifest.sha256) {
    return {
      ok: false,
      reason: 'backup_digest_mismatch',
      detail: `sha256 ${parsed.sha256.slice(0, 16)}… ≠ 清单 ${manifest.sha256.slice(0, 16)}…（长度相同 ⇒ 内容被改过）`,
    }
  }
  if (parsed.contentDigest !== manifest.contentDigest || parsed.totalRows !== manifest.totalRows) {
    return {
      ok: false,
      reason: 'backup_structure_mismatch',
      detail: `数据摘要 ${parsed.contentDigest.slice(0, 16)}…/${parsed.totalRows} 行 ≠ 清单 ${manifest.contentDigest.slice(0, 16)}…/${manifest.totalRows} 行`,
    }
  }
  return { ok: true, bytes, sha256: parsed.sha256, totalRows: parsed.totalRows, contentDigest: parsed.contentDigest }
}
