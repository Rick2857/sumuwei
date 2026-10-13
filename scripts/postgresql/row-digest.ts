/**
 * PostgreSQL 迁移 WP4：**规范化行摘要与比较器**（`PG-G09` 的核心）。
 *
 * ============================================================================
 *  它解决什么问题
 * ============================================================================
 *  迁移的完整性检查要回答："源库与目标库的**同一批逻辑数据**是不是一致？"
 *  而它们来自**两个不同的驱动**（PGlite / 真 PostgreSQL），同一份逻辑值会以
 *  不同形状到达 JS：
 *
 * ```text
 *   bigint    PGlite 可能给 number 5；真 PG 的 pg 驱动**默认给字符串 "5"**
 *   jsonb     键序可能不同
 *   numeric   可能给 "1.50" 或 "1.5"
 *   时间      可能给 Date 或字符串
 *   bytea     可能给 Buffer 或 hex 字符串
 * ```
 *
 *  ⇒ 直接 `JSON.stringify(row)` 比出来的是**驱动的编码差异**，不是数据差异。
 *    那就是"看起来合理但量的是别的东西"。
 *
 * ---------------------------------------------------------------------------
 *  ⚠️ 规范化必须**按列类型**做（不能只按 JS 值的形状）
 * ---------------------------------------------------------------------------
 *  只按 JS 形状归一化会造出**假相等**：
 *
 * ```text
 *   bigint 列里的 5  → "5"
 *   text   列里的 "5" → "5"      ← 两者撞在一起 ⇒ 一个 bigint 5 与一个 text "5"
 *                                  会被判成"相同"，而它们根本不是同一个值
 * ```
 *
 *  ⇒ `normalizeByType(value, dataType)` 先看**列的 SQL 类型**，再决定怎么归一。
 *    这条有专门的负控（见 `PG-G09` 的 `G09.2e`）。
 *
 * ---------------------------------------------------------------------------
 *  比较策略（计划 §6.6 逐字）
 * ---------------------------------------------------------------------------
 *  · **有主键**：按主键排序 → 逐行摘要 → 拼成整表摘要
 *    ⇒ 能同时回答"主键集合是否一致"与"内容是否一致"（两个不同的具名原因）
 *  · **无主键**：**稳定行多重集**比较（行摘要排序后哈希）
 *    ⇒ "不只比总数"：删一行加一行总数不变，但多重集变了
 */

import { createHash } from 'node:crypto'

/** 一个列的规格（比较器只需要名字与 SQL 类型） */
export interface ColumnSpec {
  name: string
  /** `information_schema.columns.data_type` 的取值（如 `bigint` / `jsonb` / `text`） */
  dataType: string
}

/** 不一致的**具名**原因（互不相同，便于定位） */
export type TableMismatchReason =
  /** 行数不同 */
  | 'row_count_differs'
  /** 主键集合不同（有主键的表） */
  | 'primary_key_set_differs'
  /** 内容摘要不同（主键相同、值不同） */
  | 'content_digest_differs'
  /** 行多重集不同（无主键的表） */
  | 'multiset_differs'

export interface TableDigest {
  table: string
  /** 比较策略（有主键 / 无主键） */
  strategy: 'primary-key' | 'multiset'
  rowCount: number
  /** 主键集合的摘要（无主键时为 undefined） */
  primaryKeyDigest?: string
  /** 内容的摘要 */
  contentDigest: string
  /** 整表摘要（比较器实际比的是它） */
  digest: string
}

export interface TableComparison {
  table: string
  match: boolean
  reason?: TableMismatchReason
  source: TableDigest
  target: TableDigest
}

// ---------------------------------------------------------------------------
// 归一化
// ---------------------------------------------------------------------------

const NULL_MARK = '\u0000null'

/** 该 SQL 类型是否属于"整数/小数"家族 */
function isNumericType(dataType: string): boolean {
  const t = dataType.toLowerCase()
  return (
    t === 'bigint' ||
    t === 'int8' ||
    t === 'integer' ||
    t === 'int' ||
    t === 'int4' ||
    t === 'smallint' ||
    t === 'int2' ||
    t === 'numeric' ||
    t === 'decimal' ||
    t === 'real' ||
    t === 'double precision' ||
    t === 'float4' ||
    t === 'float8'
  )
}

/** 该 SQL 类型是否属于 JSON 家族 */
function isJsonType(dataType: string): boolean {
  const t = dataType.toLowerCase()
  return t === 'json' || t === 'jsonb'
}

/** 该 SQL 类型是否属于时间家族 */
function isTemporalType(dataType: string): boolean {
  const t = dataType.toLowerCase()
  return t.startsWith('timestamp') || t === 'date' || t === 'time' || t.startsWith('time ')
}

/** 该 SQL 类型是否属于二进制家族 */
function isBinaryType(dataType: string): boolean {
  return dataType.toLowerCase() === 'bytea'
}

/**
 * 规范化的 JSON 文本：**键排序**、数字用规范十进制。
 *
 * ⚠️ 为什么不能直接 `JSON.stringify`：对象键序在 JS 里是插入序，
 *    而 `jsonb` 在 PG 里**不保留**键序 ⇒ 同一份 jsonb 读出来键序可能不同。
 *    `JSON.stringify` 会因此产出不同文本 ⇒ **假不等**。
 */
function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'null'
  if (typeof value === 'number') return canonicalNumber(value)
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value instanceof Date) return JSON.stringify(value.toISOString())
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(String(value))
}

/**
 * **精确**十进制规范化（`numeric` / `decimal` 用这一条，**不**走 `Number`）。
 *
 * ============================================================================
 *  为什么 numeric 不能走 `canonicalNumber`
 * ============================================================================
 *  `canonicalNumber` 内部是 `Number(value)` + `toPrecision(15)` —— 那是给
 *  **二进制浮点**（`real`/`double precision`）用的：它们本来就没有精确十进制表示，
 *  用"15 位有效数字"把浮点尾差抹掉是对的。
 *
 *  但 `numeric` 是**精确**十进制。走 `Number()` 有两个真后果：
 *
 * ```text
 *   ① 目标侧经 `json_agg` 读回时，numeric 会被写成 **JSON 数字** ⇒ JS 的 double
 *      ⇒ 超过 17 位有效数字的部分**静默丢失**（假绿：两个不同的值被判成相同）
 *   ② `toPrecision(15)` 更是把差异限制在 15 位以内 ⇒ 第 16 位起的差异**一律看不见**
 * ```
 *
 *  ⇒ `numeric` 走**纯字符串**规范化：移动小数点用字符串拼接，一位都不丢。
 *    它仍然让 `1.50` 与 `1.5` 归一（去尾随零），但 `1.00000000000000001` 与 `1` **不**归一。
 */
export function canonicalDecimal(value: number | string): string {
  const text = (typeof value === 'number' ? value.toString() : value).trim()
  const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text)
  if (match === null) return `raw:${text}`
  const intPart = match[2] ?? ''
  const fracPart = match[3] ?? ''
  if (intPart === '' && fracPart === '') return `raw:${text}`

  const exponent = match[4] === undefined ? 0 : Number(match[4])
  if (!Number.isFinite(exponent) || Math.abs(exponent) > 100_000) return `raw:${text}`

  const digits = intPart + fracPart
  const pointPosition = intPart.length + exponent
  let whole: string
  let fraction: string
  if (pointPosition <= 0) {
    whole = ''
    fraction = '0'.repeat(-pointPosition) + digits
  } else if (pointPosition >= digits.length) {
    whole = digits + '0'.repeat(pointPosition - digits.length)
    fraction = ''
  } else {
    whole = digits.slice(0, pointPosition)
    fraction = digits.slice(pointPosition)
  }
  whole = whole.replace(/^0+/, '')
  fraction = fraction.replace(/0+$/, '')
  if (whole === '' && fraction === '') return '0'
  return `${whole === '' ? '0' : whole}${fraction === '' ? '' : `.${fraction}`}`
}

/**
 * 规范十进制：去指数、去尾随零、整数不带小数点。
 *
 * 让 `1.50` 与 `1.5` 归一，让 `5` 与 `5.0` 归一 —— 但**不**让 `5` 与 `"5"`（文本）归一
 * （那由"按列类型"那一层负责区分）。
 *
 * ⚠️ 这是给**二进制浮点**（`real`/`double precision`/向量分量）用的；`numeric`
 *    请用 `canonicalDecimal`（见那里的说明：`Number()` 会静默丢精度）。
 */
export function canonicalNumber(value: number | string): string {
  const asNumber = typeof value === 'number' ? value : Number(value)
  if (Number.isNaN(asNumber)) return `NaN:${String(value)}`
  if (!Number.isFinite(asNumber)) return asNumber > 0 ? 'Infinity' : '-Infinity'
  if (Number.isInteger(asNumber)) return asNumber.toFixed(0)
  // 用 toPrecision 去掉浮点尾差，再剥掉尾随零
  let text = asNumber.toPrecision(15)
  if (text.includes('e') || text.includes('E')) text = asNumber.toString()
  if (text.includes('.')) text = text.replace(/0+$/, '').replace(/\.$/, '')
  return text
}

/**
 * **按列类型**归一化一个值 ⇒ 规范文本，**带类型家族标签**。
 *
 * ============================================================================
 *  ⚠️ 为什么要带标签（本轮被自己的负控抓到的一个真缺陷）
 * ============================================================================
 *  第一版**不带标签**，于是 `bigint 5` 与 `text "5"` 都归一成 `"5"` ——
 *  `G09.1b` 那条负控当场把它抓出来：
 *
 * ```text
 *   FAIL  bigint 5 与 text "5" 归一成了同一个（5）⇒ 比较器会造出假相等
 * ```
 *
 *  那是**真的会出错**：一个 bigint 列里的 5 与一个 text 列里的 "5" 会被判成"相同"。
 *  ⇒ 现在每个值前面带一个**家族标签**（`n:` 数字 / `s:` 文本 / `j:` JSON / …），
 *    标签之间用一个控制字符隔开（不会与内容撞）。
 *
 *  ⚠️ 标签是**家族级**而不是**精确 SQL 类型级**：`bigint` 与 `integer` 都算 `n`。
 *    理由：比较器比的是**同一张表的同一批逻辑数据**（两侧用同一份列规格），
 *    而"源列是 bigint、目标列是 integer"属于**schema 差异**，由表清单/schema 比较去管，
 *    不该在这里表现成"每一行都不同"的噪声。
 */
export function normalizeByType(value: unknown, dataType: string): string {
  const family = familyOf(dataType)
  if (value === null || value === undefined) return NULL_MARK
  return `${family}\u0001${canonicalValueOf(value, dataType, family)}`
}

/** 类型家族标签（见 `normalizeByType` 的说明） */
function familyOf(dataType: string): string {
  const t = dataType.toLowerCase()
  if (isNumericType(t)) return 'n'
  if (isJsonType(t)) return 'j'
  if (isTemporalType(t)) return 't'
  if (isBinaryType(t)) return 'x'
  if (t === 'boolean' || t === 'bool') return 'b'
  if (t.startsWith('vector')) return 'v'
  return 's'
}

function canonicalValueOf(value: unknown, dataType: string, family: string): string {
  const t = dataType.toLowerCase()

  // ① 整数家族：一律走 BigInt，避免 number 精度与大整数字符串的分叉
  if (family === 'n') {
    if (t === 'bigint' || t === 'int8') {
      // pg 驱动默认把 int8 给成**字符串**；PGlite 可能给 number ⇒ 两者都要能进 BigInt
      if (typeof value === 'bigint') return value.toString()
      if (typeof value === 'number') {
        if (!Number.isInteger(value)) return canonicalNumber(value)
        return BigInt(value).toString()
      }
      const text = String(value).trim()
      try {
        return BigInt(text).toString()
      } catch {
        return canonicalNumber(text)
      }
    }
    if (t === 'integer' || t === 'int' || t === 'int4' || t === 'smallint' || t === 'int2') {
      return canonicalNumber(Number(value))
    }
    // ⚠️ `numeric` / `decimal` 是**精确**十进制 ⇒ 走纯字符串规范化，不经过 `Number`
    //    （见 `canonicalDecimal` 的说明：`Number()` 会把第 16 位起的差异静默抹掉）。
    if (t === 'numeric' || t === 'decimal') {
      return canonicalDecimal(typeof value === 'string' ? value : String(value))
    }
    return canonicalNumber(typeof value === 'number' ? value : String(value))
  }

  // ② JSON 家族：规范键序
  if (family === 'j') {
    if (typeof value === 'string') {
      // 有的驱动会把 jsonb 给成字符串 ⇒ 先解析再规范化（解析不了就按原文）
      try {
        return canonicalJson(JSON.parse(value))
      } catch {
        return `raw:${value}`
      }
    }
    return canonicalJson(value)
  }

  // ③ 时间家族：统一成 ISO（Date 或字符串都收）
  if (family === 't') {
    if (value instanceof Date) return value.toISOString()
    const text = String(value)
    const parsed = new Date(text)
    return Number.isNaN(parsed.getTime()) ? `raw:${text}` : parsed.toISOString()
  }

  // ④ 二进制：统一成小写 hex
  if (family === 'x') {
    if (value instanceof Uint8Array) return Buffer.from(value).toString('hex')
    const text = String(value)
    return text.startsWith('\\x') ? text.slice(2).toLowerCase() : text.toLowerCase()
  }

  // ⑤ 布尔：PG 的 t/f 与 JS 的 true/false 归一
  if (family === 'b') {
    if (typeof value === 'boolean') return value ? 't' : 'f'
    const text = String(value).toLowerCase()
    return text === 't' || text === 'true' || text === '1' ? 't' : 'f'
  }

  // ⑥ 向量：数组或 `[1,2,3]` 文本都归一成规范数组
  if (family === 'v') {
    if (Array.isArray(value)) return `[${value.map((v) => canonicalNumber(Number(v))).join(',')}]`
    const text = String(value)
    try {
      const parsed = JSON.parse(text) as unknown
      if (Array.isArray(parsed)) {
        return `[${parsed.map((v) => canonicalNumber(Number(v))).join(',')}]`
      }
    } catch {
      /* 落回原文 */
    }
    return `raw:${text}`
  }

  // ⑦ 其余（text/varchar/uuid/…）：原样
  if (typeof value === 'object') return canonicalJson(value)
  return String(value)
}

// ---------------------------------------------------------------------------
// 行 / 表摘要
// ---------------------------------------------------------------------------

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

/**
 * 一行摘要：按**列名排序**后逐列归一化。
 *
 * ⚠️ 按列名排序而不是按查询返回顺序：不同驱动/不同 SELECT 的列序可能不同，
 *    而那是**无关**差异。
 */
export function rowDigest(row: Record<string, unknown>, columns: readonly ColumnSpec[]): string {
  const sorted = [...columns].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const parts = sorted.map((c) => `${c.name}=${normalizeByType(row[c.name], c.dataType)}`)
  return sha256(parts.join('\u0001'))
}

/**
 * 整表摘要。
 *
 * · 给了 `primaryKey` ⇒ `strategy='primary-key'`：按主键排序，
 *   并**分别**给出"主键集合摘要"与"内容摘要" ⇒ 能把
 *   "少了/多了行" 与 "同一行的值变了" 分成两个具名原因。
 * · 没给 ⇒ `strategy='multiset'`：行摘要**排序后**哈希（稳定行多重集）。
 */
export function tableDigest(input: {
  table: string
  rows: readonly Record<string, unknown>[]
  columns: readonly ColumnSpec[]
  primaryKey?: readonly string[]
}): TableDigest {
  const { table, rows, columns } = input
  const primaryKey = input.primaryKey ?? []

  if (primaryKey.length === 0) {
    const rowHashes = rows.map((r) => rowDigest(r, columns)).sort()
    const digest = sha256(rowHashes.join('\n'))
    return {
      table,
      strategy: 'multiset',
      rowCount: rows.length,
      contentDigest: digest,
      digest,
    }
  }

  const keyOf = (row: Record<string, unknown>): string =>
    primaryKey
      .map((k) => {
        const spec = columns.find((c) => c.name === k)
        return normalizeByType(row[k], spec?.dataType ?? 'text')
      })
      .join('\u0002')

  const entries = rows
    .map((row) => ({ key: keyOf(row), hash: rowDigest(row, columns) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))

  const primaryKeyDigest = sha256(entries.map((e) => e.key).join('\n'))
  const contentDigest = sha256(entries.map((e) => `${e.key}=${e.hash}`).join('\n'))

  return {
    table,
    strategy: 'primary-key',
    rowCount: rows.length,
    primaryKeyDigest,
    contentDigest,
    digest: sha256(`${primaryKeyDigest}\u0003${contentDigest}`),
  }
}

/**
 * 比较两个表的摘要。
 *
 * 判据顺序是刻意的：先比"行数"、再比"主键集合"、最后比"内容" ——
 * 这样给出的原因是**最具体的那一个**（而不是笼统的"摘要不同"）。
 */
export function compareTableDigests(source: TableDigest, target: TableDigest): TableComparison {
  const base = { table: source.table, source, target }
  if (source.rowCount !== target.rowCount) {
    return { ...base, match: false, reason: 'row_count_differs' }
  }
  if (source.strategy === 'primary-key' && target.strategy === 'primary-key') {
    if (source.primaryKeyDigest !== target.primaryKeyDigest) {
      return { ...base, match: false, reason: 'primary_key_set_differs' }
    }
    if (source.contentDigest !== target.contentDigest) {
      return { ...base, match: false, reason: 'content_digest_differs' }
    }
    return { ...base, match: true }
  }
  if (source.strategy === 'multiset' && target.strategy === 'multiset') {
    if (source.contentDigest !== target.contentDigest) {
      return { ...base, match: false, reason: 'multiset_differs' }
    }
    return { ...base, match: true }
  }
  // 策略不同（一边给了主键一边没给）⇒ 不能声称一致
  return { ...base, match: false, reason: 'content_digest_differs' }
}

/** 整批比较：返回逐表结论与总判定 */
export function compareTables(
  pairs: readonly { source: TableDigest; target: TableDigest }[]
): { allMatch: boolean; comparisons: TableComparison[]; mismatched: string[] } {
  const comparisons = pairs.map((p) => compareTableDigests(p.source, p.target))
  const mismatched = comparisons.filter((c) => !c.match).map((c) => `${c.table}:${c.reason ?? '?'}`)
  return { allMatch: mismatched.length === 0, comparisons, mismatched }
}
