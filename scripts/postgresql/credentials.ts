/**
 * PostgreSQL 迁移：**试验凭据的读取**（所有 PG 门共用一处）。
 *
 * ============================================================================
 *  为什么要单独一个模块（本轮踩到的一个真陷阱）
 * ============================================================================
 *  凭据文件 `artifacts/post-lv2/local/pg-migration/pg-trial.env` 是 PowerShell
 *  `Set-Content -Encoding utf8` 写的 ⇒ **带 UTF-8 BOM**（前 3 字节 `EF BB BF`）。
 *
 *  于是 `readFileSync(file, 'utf8').split(/\r?\n/)` 拿到的**第一个 key** 是
 *
 * ```text
 *   "\uFEFFLG_PG_BOOTSTRAP_USER"     ← 多了一个不可见字符
 * ```
 *
 *  ⚠️ 后果是**静默的**：`credentials.LG_PG_BOOTSTRAP_USER` 是 `undefined`，
 *    而各道门当时都写着 `?? 'lg_bootstrap'` 兜底 ⇒ **门照样绿**，
 *    只是"读到了配置"这件事其实没发生。
 *    （本轮一个没有兜底的探针当场失败：`FATAL: role ... does not exist` / 建库 rc=2。）
 *
 *  ⇒ 修法两条一起做：
 *    ① **读的时候剥 BOM**（对任何来源都稳）；
 *    ② 这个读取只写**一处** —— 免得将来又有人复制一份没剥 BOM 的版本。
 *
 *  ⚠️ 顺带一条纪律：**兜底默认值会把"读不到"变成"看起来读到了"**。
 *    这里刻意**不**给 key 兜底（`LG_PG_BOOTSTRAP_USER` 读不到就是 `undefined`），
 *    由调用方显式决定怎么办 —— 而不是悄悄用一个默认值把它盖过去。
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export type PgCredentials = Record<string, string>

/** 凭据文件的**唯一**路径来源 */
export const PG_CREDENTIALS_FILE = resolve('artifacts/post-lv2/local/pg-migration/pg-trial.env')

/** 剥掉 UTF-8 BOM（若存在）。`Set-Content -Encoding utf8` 会加上它。 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/**
 * 读凭据。文件不存在 ⇒ `undefined`（调用方据此报 notRun）。
 *
 * ⚠️ **不给任何 key 兜底**（见文件头注释）：读不到就是读不到。
 */
export function loadPgCredentials(file: string = PG_CREDENTIALS_FILE): PgCredentials | undefined {
  if (!existsSync(file)) return undefined
  const credentials: PgCredentials = {}
  for (const line of stripBom(readFileSync(file, 'utf8')).split(/\r?\n/)) {
    const index = line.indexOf('=')
    if (index <= 0) continue
    credentials[line.slice(0, index).trim()] = line.slice(index + 1)
  }
  return credentials
}

/** 容器名（可被 `LG_PG_CONTAINER` 覆盖） */
export const PG_CONTAINER = process.env.LG_PG_CONTAINER ?? 'lg-postgresql-trial'
/** 宿主端口（可被 `LG_PG_HOST_PORT` 覆盖） */
export const PG_HOST_PORT = process.env.LG_PG_HOST_PORT ?? '55432'

/** 试验实例需要的全部 key */
const REQUIRED_KEYS = [
  'LG_PG_BOOTSTRAP_USER',
  'LG_PG_BOOTSTRAP_PASSWORD',
  'LG_PG_BOOTSTRAP_DB',
  'LG_PG_MIGRATE_PASSWORD',
  'LG_PG_RUNTIME_PASSWORD',
  'LG_PG_READONLY_PASSWORD',
  'LG_PG_TEST_PASSWORD',
] as const

/**
 * 缺了哪些 key（空数组 = 齐备）。
 *
 * ⚠️ 存在的理由就是"**别用兜底默认值**"：`credentials.X ?? 'lg_bootstrap'` 这种写法
 *    会把"**读不到配置**"变成"**看起来读到了**"（本轮那个 BOM 陷阱就是这么被盖住的）。
 *    ⇒ 让调用方**显式**看到缺什么，并把它写进 notRun 的原因里。
 */
export function missingCredentialKeys(credentials: PgCredentials | undefined): string[] {
  if (credentials === undefined) return [...REQUIRED_KEYS]
  return REQUIRED_KEYS.filter((key) => {
    const value = credentials[key]
    return value === undefined || value.trim() === ''
  })
}
