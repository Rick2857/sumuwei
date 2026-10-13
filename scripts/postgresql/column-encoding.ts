/**
 * PostgreSQL 迁移 WP5：**哪些列必须在 SQL 里先转成文本**（比较器两侧的**同一条判据**）。
 *
 * ============================================================================
 *  为什么这件事必须收在**一处**
 * ============================================================================
 *  全库比较的两侧来自两个驱动，同一个逻辑值可能以不同形状到达 JS：
 *
 * ```text
 *   源（PGlite）                     目标（真 PG，经 jsonb_agg）
 *   ────────────────────────────    ────────────────────────────────
 *   timestamp without tz → Date      → 无时区的 ISO 文本 "…T07:39:50.155"
 *   vector              → 数组       → pgvector 的文本 "[1,2,3]"
 *   bigint              → number     → **JSON 数字**（超过 2^53 就丢精度）
 *   numeric             → 字符串     → **JSON 数字**（超过 17 位就丢精度）
 *   real/double         → number     → JSON 数字
 *   text[]              → 数组       → JSON 数组
 * ```
 *
 *  两侧**各自**决定"要不要转文本" ⇒ 只要有一处漏了或写反了，就会变成
 *  "看起来在比数据、其实在比驱动的编码"（WP4 的 `F-WP4-01` 就是这么来的）。
 *  ⇒ 判据只写**这一处**，两个读取器都 import 它。
 *
 * ---------------------------------------------------------------------------
 *  为什么"转文本"能解决问题（而不是掩盖问题）
 * ---------------------------------------------------------------------------
 *  两条不变式：
 *
 * ```text
 *   ① 只要**两侧拿到同一段文本**，规范化函数对同一段文本的输出必然相同
 *      ⇒ 时区解释、驱动形状这些歧义**根本不进入**比较
 *   ② 转文本**不丢信息**：PostgreSQL 的类型输出函数是单射（同一存储值 ⇒ 同一文本）
 *      ⚠️ 反例正是 `numeric → JSON 数字`：那不是单射（第 18 位起被抹平）⇒ 必须避开
 * ```
 *
 *  ⚠️ **`timestamp with time zone` 刻意不转文本**：它的文本输出**依赖会话 TimeZone**
 *     （实测容器是 `Etc/UTC`，而 PGlite 的会话设置是另一件事）⇒ 转文本反而引入
 *     一个新的可变因素。它走 `Date` / ISO 那条路（带时区 ⇒ 解释无歧义）。
 */

/** 时区**无歧义**的类型：保持原样（原生形状，靠 `Date`/ISO 归一） */
const NATIVE_TYPES = new Set([
  'text',
  'character varying',
  'character',
  'uuid',
  'boolean',
  'json',
  'jsonb',
  'integer',
  'smallint',
  'timestamp with time zone',
  'time with time zone',
])

/**
 * 该列是否必须在 SQL 里先 `::text`（见文件头的不变式 ②）。
 *
 * 默认是 **`true`（转文本）** —— 这是刻意的：**不认识**的类型走"转文本"这条
 * 不会丢信息的路，而不是走"按原生形状猜"那条可能造出假绿的路。
 */
export function requiresTextEncoding(dataType: string): boolean {
  const t = dataType.trim().toLowerCase()
  if (NATIVE_TYPES.has(t)) return false
  return true
}

/** 给证据用的可读理由（避免"为什么这列要转文本"变成一个猜） */
export function textEncodingReason(dataType: string): string {
  const t = dataType.trim().toLowerCase()
  if (!requiresTextEncoding(t)) return '原生形状（时区无歧义 / 形状在两个驱动下一致）'
  if (t === 'bigint' || t === 'int8') return 'JSON 数字超过 2^53 会丢精度'
  if (t === 'numeric' || t === 'decimal') return 'JSON 数字只有 double 精度（第 18 位起被抹平）'
  if (t === 'real' || t === 'double precision' || t === 'float4' || t === 'float8') return '浮点的文本表示与 JS number 不同'
  if (t === 'vector') return 'pgvector 给文本、PGlite 给数组（分量写法可能不同）'
  if (t === 'array') return '数组字面量在两个驱动下的形状不同'
  if (t.startsWith('timestamp without') || t === 'date' || t.startsWith('time without')) {
    return '无时区类型：PGlite 给 Date（解释带上了时区），目标给无时区文本'
  }
  return '未登记的类型 ⇒ 走不丢信息的文本路径'
}
