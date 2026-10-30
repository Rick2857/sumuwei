/**
 * `logger` 的本地实现 —— 从 ElizaOS 独立出来（M12 · W2）。
 *
 * ============================================================================
 *  ⚠️⚠️ 上游**确实**写 stdout/stderr（2026-10-19 实测纠正）
 * ============================================================================
 * 第一版这里写的是"上游的 Adze sink 不落 stdout" ⇒ **那是错的**，已更正。
 * 实测（`@elizaos/core@1.7.2` 真实调用）：
 *
 * ```text
 *   logger.info('X')  → stdout: ` Info       X`
 *   logger.warn('X')  → stderr: ` Warn       X`
 *   logger.error('X') → stderr: ` Error      X`
 * ```
 *
 * ⚠️ **那为什么生产 journal 里一条 `Info` 都没有**（实测 2766 行，0 条）？
 *   因为生产核心是 `src/main.ts --bridge --qq-private`，由
 *   `LgStdioClient` **spawn** 起来，而它的 **stdout 走管道**（桥接协议用）、
 *   **不转发** ⇒ 子进程的 console 输出**到不了 journal**。
 *   ⇒ journal 里那 2090 行 `_TRANSPORT=stdout` 是**外壳**（`scripts/qq/chat.ts`）打的。
 *   ⇒ 这与 logger 的实现**无关** —— 但它解释了第一版那个错误结论的来源。
 *
 * ⚠️ **正因为如此，本实现必须与上游同形地写 stdout/stderr**：
 *   在**能看见 stdout** 的场合（本地开发、CLI 工具、测试、管道不转发时），
 *   不写就是**真实的行为差异**（日志凭空消失）⇒ 那不是"等价替换"。
 *
 * ============================================================================
 *  API 面（实测，2026-10-19）
 * ============================================================================
 * `src/` 内共 **132 处**调用，**只有 4 个方法**、**全部单参数**：
 *   info 88 · warn 30 · debug 12 · error 6
 * ⇒ 本实现只提供这 4 个方法；**不**实现上游那些用不到的
 * （trace / fatal / success / fail / log / verbose / child / scope …）。
 *   少做不是偷懒：多出来的方法**没有调用者**，而每多一个就多一处会漂移的地方。
 *
 * ⚠️ 参数用 `unknown` 而不是 `string`：实测存在
 *    `logger.error(err instanceof Error ? err.message : String(err))`
 *    与 `logger.info(describeKernelFlags(flags))` 这类**非字符串**实参。
 *    上游签名是 `(obj, msg, ...args)`，本实现只取第一个实参并**如实字符串化**。
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'diagnostic'

export interface Logger {
  debug(message: unknown): void
  info(message: unknown): void
  warn(message: unknown): void
  error(message: unknown): void
  /**
   * ADR-156 / P3-E：**生产可见的诊断读数**（写 stderr）。
   *
   * ⚠️ 它**不是** warn/error 级别（不改变告警语义），只是换个出口：
   *    生产核心的 stdout 是桥接协议管道（不转发），stderr 被外壳转发 ⇒
   *    走 stderr 的读数在生产真的能被看到。
   */
  diagnostic(message: unknown): void
}

/** 单一出口 —— 将来要落 journal 时**只改这里** */
export interface LogSink {
  write(level: LogLevel, line: string): void
}

/**
 * 默认 sink：**与上游同形**地写 stdout / stderr。
 *
 * ⚠️ 分流与上游一致：`warn` / `error` ⇒ **stderr**；`debug` / `info` ⇒ **stdout**。
 *   （Node 的 `console.warn` / `console.error` 本来就写 stderr。）
 *
 * 📌 注入别的 sink 时**只影响那一处**（生产若要落 journal，写一个落文件的 sink 即可，
 *    136 处调用点一行都不用改 —— 这就是把 logger 收进本仓库的实际收益）。
 */
const consoleSink: LogSink = {
  write: (level, line) => {
    /*
     * ⚠️ `diagnostic` 也走 **stderr**（ADR-156 / P3-E）：它不是告警级别，
     *    只是"换个出口"—— 生产核心的 stdout 是桥接协议管道（不转发），
     *    而 stderr 被外壳转发到 journal ⇒ 走 stderr 的诊断在生产**真的能被看到**。
     */
    if (level === 'error' || level === 'warn' || level === 'diagnostic') console.error(line)
    else console.log(line)
  },
}

let sink: LogSink = consoleSink

export function setLogSink(next: LogSink): void {
  sink = next
}

export function currentLogSink(): LogSink {
  return sink
}

/** 恢复默认 sink（写 stdout/stderr） */
export function resetLogSink(): void {
  sink = consoleSink
}

/** 最近 N 条日志（供门与诊断读取；**不**替代 stdout 输出） */
const RING_SIZE = 200
const ring: { level: LogLevel; line: string; at: number }[] = []

export function recentLogs(limit = RING_SIZE): readonly { level: LogLevel; line: string; at: number }[] {
  return ring.slice(Math.max(0, ring.length - limit))
}

/**
 * 把实参转成一行文本。
 *
 * ⚠️ **不用 `String(x)` 了** —— 门 `thinhost-logger-verify` 的 L3 抓到：
 *   `logger.info({a:1})` 会变成 `[object Object]`，信息**全丢**
 *   （实测发现，不是推断；`src/` 里有 `logger.info(describeKernelFlags(flags))`
 *    这类非字符串实参）。
 *   ⇒ 对象/数组走 `JSON.stringify`，失败时回落到 `String()`。
 *
 * ⚠️ `Error` 单独处理：它有 `message`/`stack`，`JSON.stringify` 对它多半给 `{}`。
 * ⚠️ 循环引用会让 `JSON.stringify` 抛 ⇒ 必须兜住，不能让日志把进程带崩。
 */
function toLine(message: unknown): string {
  if (message instanceof Error) {
    return message.stack ?? `${message.name}: ${message.message}`
  }
  if (typeof message === 'string') return message
  if (message === null) return 'null'
  if (message === undefined) return 'undefined'
  const t = typeof message
  if (t === 'object' || t === 'function') {
    try {
      const json = JSON.stringify(message)
      if (json !== undefined) return json
    } catch {
      // 循环引用 / BigInt —— 落到下面
    }
    return String(message)
  }
  return String(message)
}

function emit(level: LogLevel, message: unknown): void {
  // ⚠️ 格式：`[LEVEL] 正文`（上游是 Adze 的 ` Info       正文`；只改格式，不改去向）
  const line = `[${level.toUpperCase()}] ${toLine(message)}`
  ring.push({ level, line, at: Date.now() })
  if (ring.length > RING_SIZE) ring.shift()
  sink.write(level, line)
}

export const logger: Logger = {
  debug: (m) => emit('debug', m),
  info: (m) => emit('info', m),
  warn: (m) => emit('warn', m),
  error: (m) => emit('error', m),
  diagnostic: (m) => emit('diagnostic', m),
}
