/**
 * 静态扫描的**共用文本工具**。
 *
 * ============================================================================
 *  为什么它必须只有一处
 * ============================================================================
 * 已经有三道门因为"扫原文"而假红过，红的原因**全部**是同一类：
 * 注释里出现了被扫的记号（我自己写的说明文字）。
 *
 * ```text
 *   m6:measurement 的套件审计   把注释里的举例 `fetch(` 当成真实调用
 *   M6 WP5 的"派生只有一处"      把注释里的函数名数成第二个调用点
 *   INC-01 WP3 的"不许裸 stop"   把注释里的 `runtime.stop()` 当成违规
 * ```
 * 因此"剥掉注释再数"这件事只写一份。
 *
 * ⚠️ **反过来也有正当的一类门**：`m5.1.1:phase4a:verify` 的针**故意**扫原文、
 *    连注释都算 —— 因为它的命题是"这个名字不许出现在别处"。它**不**用本模块，
 *    这是刻意的：两种判据不该被同一个工具统一掉。
 */

/**
 * 剥掉 `//` 行注释与 `/* … *​/` 块注释，只留下**代码形状**。
 *
 * 不追求完整的 TS 词法分析：对"数一个记号是不是真的出现在代码里"够用。
 * 已知边界：字符串里的 `//` 会被当成注释起点（`'https://…'` 这类）；
 * 需要连字符串一起剥时用 `stripStringsAndComments()`。
 */
export function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/**
 * 再剥掉字符串字面量、模板串（在注释已经去掉的基础上）。
 *
 * 用于"数一个记号是不是真的被**调用**"（例如 `fetch(`）——
 * 一个门完全可能**读**另一个文件里的 `fetch(`（那是字符串，不是调用）。
 */
export function stripStringsAndComments(text: string): string {
  return stripComments(text)
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
}

/** Runtime close discipline; stopping a sidecar/scheduler is a different operation. */
export function hasBareRuntimeStop(text: string): boolean {
  return /\bruntime(?:\.|\?\.)stop\s*\(/.test(stripStringsAndComments(text))
}
