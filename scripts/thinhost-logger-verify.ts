/**
 * 门：本地 `logger` 的行为（M12 · W2）。
 *
 * ============================================================================
 *  它守的是什么（**两个方向**，缺一不可）
 * ============================================================================
 * ① **不许变成静默的 no-op。**
 *    默认 sink 什么都不做（与上游同形），但**"这些日志去了哪"必须可查**：
 *    `recentLogs()` 环形缓冲 + `setLogSink()` 注入口。
 *    ⇒ 断言：写入后 `recentLogs()` **读得到**，且级别与文本逐条正确。
 *
 * ② **不许静默改变去向。**
 *    断言默认 sink **不写 stdout**（那是行为变更，超出 M12 范围）；
 *    同时断言注入 sink 后**确实**能拿到 —— 证明"将来要落 journal 时只改一处"。
 *
 * ③ API 面收敛：只暴露 `debug/info/warn/error`，且**不**接受多参数。
 *    `src/` 内 132 处调用全是单参数（实测），多参数一律按"只取第一个"处理并如实记。
 *
 * ⚠️ 判据纪律：负控不可省 —— 一个"什么都不做且什么都不记"的实现能过 ①的一半，
 *    所以 ① 必须断言**读回内容**，而不是"调用没抛异常"。
 */

import { logger, recentLogs, setLogSink, resetLogSink, type LogLevel } from '../src/infrastructure/telemetry/logger.ts'

interface Check { id: string; ok: boolean; detail: string }
const checks: Check[] = []
function check(id: string, ok: boolean, detail: string): void {
  checks.push({ id, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} — ${detail}`)
}

// ---------------------------------------------------------------------------
// ① 四个方法都能写，且内容可读回（**不是**"调用没抛异常"）
// ---------------------------------------------------------------------------
{
  const levels: LogLevel[] = ['debug', 'info', 'warn', 'error']
  const seen: string[] = []
  for (const lv of levels) {
    logger[lv](`probe-${lv}`)
    const tail = recentLogs(1)[0]
    seen.push(tail === undefined ? 'NONE' : `${String(tail.level)}:${tail.line}`)
  }
  check(
    'L1-four-levels-recorded',
    seen.every((s, i) => s === `${levels[i]}:[${levels[i].toUpperCase()}] probe-${levels[i]}`),
    `四个级别都写进环形缓冲并可读回：${seen.join(' | ')}`
  )
}

// ---------------------------------------------------------------------------
// ② 实参转文本：Error / 非字符串 / 空值
// ---------------------------------------------------------------------------
{
  const err = new Error('boom')
  logger.error(err)
  const tail = recentLogs(1)[0]
  check(
    'L2-error-argument-stringified',
    tail !== undefined && tail.line.includes('boom'),
    `Error 实参被如实转成一行（${String(tail?.line.split('\n')[0] ?? 'NONE').slice(0, 60)}）`
  )

  logger.info({ a: 1 })
  const tail2 = recentLogs(1)[0]
  check(
    'L3-non-string-argument',
    tail2 !== undefined && tail2.line.includes('a'),
    `非字符串实参不会崩且落到缓冲（${String(tail2?.line ?? 'NONE').slice(0, 40)}）`
  )
}

// ---------------------------------------------------------------------------
// ③ 环形缓冲有界（长跑不会撑爆内存）
// ---------------------------------------------------------------------------
{
  for (let i = 0; i < 500; i += 1) logger.debug(`fill-${String(i)}`)
  const ring = recentLogs(1000)
  check(
    'L4-ring-bounded',
    ring.length <= 200,
    `写入 500 条后环形缓冲长度=${String(ring.length)}（上限 200）`
  )
  check(
    'L5-ring-keeps-latest',
    ring[ring.length - 1]?.line === '[DEBUG] fill-499',
    `缓冲保留的是最新一条（${String(ring[ring.length - 1]?.line ?? 'NONE')}）`
  )
}

// ---------------------------------------------------------------------------
// ④ **去向**必须与上游同形（2026-10-19 实测纠正后补上）
//
// ⚠️ 第一版的判据是"默认 sink 不写 stdout" ⇒ **那个前提是错的**：
//    上游 `logger.info` **确实**写 stdout、`warn`/`error` **确实**写 stderr
//    （实测：` Info       X` / ` Warn       X` / ` Error      X`）。
//    ⇒ 本实现必须同形，否则在**能看见 stdout** 的场合（本地/CLI/测试）
//    日志会凭空消失 —— 那不是"等价替换"。
// ⚠️ 生产 journal 里没有这些行，是因为核心进程被 `LgStdioClient` spawn 时
//    **stdout 走管道不转发**（与 logger 的实现无关）。
// ---------------------------------------------------------------------------
{
  // ④a 默认 sink 写 stdout（info）
  const probe = 'PROBE-INFO-DEST'
  const originalLog = console.log
  const captured: string[] = []
  console.log = (...args: unknown[]): void => {
    captured.push(args.map((a) => String(a)).join(' '))
  }
  try {
    logger.info(probe)
  } finally {
    console.log = originalLog
  }
  check(
    'L6a-info-goes-to-stdout',
    captured.some((l) => l.includes(probe)),
    `logger.info 写 stdout（捕获 ${String(captured.length)} 行：${captured.map((l) => l.slice(0, 40)).join(' | ')}）`
  )

  // ④b warn/error 写 stderr
  const originalErr = console.error
  const errLines: string[] = []
  console.error = (...args: unknown[]): void => {
    errLines.push(args.map((a) => String(a)).join(' '))
  }
  try {
    logger.warn('PROBE-WARN-DEST')
    logger.error('PROBE-ERROR-DEST')
  } finally {
    console.error = originalErr
  }
  check(
    'L6b-warn-error-go-to-stderr',
    errLines.some((l) => l.includes('PROBE-WARN-DEST')) && errLines.some((l) => l.includes('PROBE-ERROR-DEST')),
    `logger.warn/error 写 stderr（捕获 ${String(errLines.length)} 行）`
  )

  // ④c 级别前缀可读
  check(
    'L6c-level-prefix',
    recentLogs(1)[0]?.line.startsWith('[ERROR]') === true,
    `输出带级别前缀（最近一条：${String(recentLogs(1)[0]?.line.slice(0, 30) ?? 'NONE')}）`
  )
}

// ---------------------------------------------------------------------------
// ④' 注入 sink ⇒ 只影响那一处（将来要落 journal 时**只改这里**）
// ---------------------------------------------------------------------------
{
  const captured: string[] = []
  setLogSink({ write: (_lv, line) => captured.push(line) })
  logger.warn('injected-sink-probe')
  check(
    'L7-injected-sink-receives',
    captured.some((l) => l.includes('injected-sink-probe')),
    `注入 sink 后确实收到（收到 ${String(captured.length)} 条）—— 将来落 journal 只需改这一处`
  )

  // 恢复默认
  captured.length = 0
  resetLogSink()
  logger.info('after-restore')
  check(
    'L7b-sink-restorable',
    captured.length === 0,
    '可以恢复成默认 sink（写 stdout/stderr）'
  )
}

// ---------------------------------------------------------------------------
// ⑤ API 面：只有 4 个方法，没有多参数重载
// ---------------------------------------------------------------------------
{
  const api = Object.keys(logger).sort()
  check(
    'L8-api-surface',
    JSON.stringify(api) === JSON.stringify(['debug', 'error', 'info', 'warn']),
    `logger 只暴露 ${api.join('/')}（实测 src/ 内 132 处调用只用这 4 个）`
  )

  // 多参数：只取第一个，不抛异常、不丢第一条
  const before = recentLogs(1)[0]?.line ?? ''
  ;(logger.info as unknown as (...a: unknown[]) => void)('first', 'second', 3)
  const after = recentLogs(1)[0]
  check(
    'L9-multiple-args-take-first',
    before !== after?.line && after?.line === '[INFO] first',
    `多参数按"只取第一个"处理（写入=${String(after?.line ?? 'NONE')}）`
  )
}

const failed = checks.filter((c) => !c.ok)
console.log(`\n=== logger 门: ${checks.length - failed.length}/${checks.length} PASS ===`)
for (const f of failed) console.log(`FAILED: ${f.id} — ${f.detail}`)
if (failed.length > 0) process.exitCode = 1
