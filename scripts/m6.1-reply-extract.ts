/**
 * M6.1 WP5：**从 `src/main.ts` 的 stdout 里取出她的回复**（唯一实现）。
 *
 * ⚠️ 为什么是单独一个模块：规则本身在 `scripts/m6.1-baseline.ts` 里已经存在，
 *    但那个文件是**进口即执行**的 CLI（顶层 `main()` + `process.exit`），
 *    import 它会直接把基线跑起来。因此把这条**纯**规则抽到这里，两边都消费它。
 *
 * 规则（实测换来的两条）：
 * ```text
 * ① 从**最后**一个 `苏沐薇:` 之后开始 —— 只取第一行会把多行回复截断（实测首轮就是三行）；
 * ② 一直取到**下一条日志行**为止 —— 尾随的 ` Info …[PLUGIN:BOOTSTRAP:…] Stopping …`
 *    不属于回复，混进去会让语义判定判到日志上。
 * 取不到标记 ⇒ 返回空串（**不是**把整段 stdout 当回复）。
 * ```
 */

export const REPLY_MARKER = '苏沐薇:'
const LOG_LINE = /^\s*(Info|Warn|Error|Debug|Trace)\s/

export function extractReply(stdout: string): string {
  const at = stdout.lastIndexOf(REPLY_MARKER)
  if (at === -1) return ''
  const kept: string[] = []
  for (const line of stdout.slice(at + REPLY_MARKER.length).split(/\r?\n/)) {
    if (LOG_LINE.test(line)) break
    kept.push(line)
  }
  return kept.join('\n').trim()
}
