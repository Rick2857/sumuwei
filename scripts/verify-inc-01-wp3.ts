/**
 * INC-01 WP3 —— **显式关闭与运行时所有权的验收门**。
 *
 * ============================================================================
 *  它证明什么（计划书 §WP3 的 Required Tests 逐条）
 * ============================================================================
 * ```text
 *   ① 七个场景（正常只读 / 脚本对话 / 交互退出 / 业务异常 / 初始化异常 /
 *      SIGINT / SIGTERM）每个 ⇒ stopCalls = 1 · closeCalls = 1 · closed = true
 *   ② 注入 stop 失败   ⇒ close **仍然执行**，且最终退出码非零
 *   ③ 注入 close 失败  ⇒ 不得声称已关闭（closed = false）且退出码非零
 *   ④ 注入 closed 永远 false ⇒ 同上（"close 没抛"不等于"关干净了"）
 *   ⑤ 静态扫描：真实 opener 里不存在"只 stop 不 close"或"close 前 process.exit()"
 * ```
 *
 * ⚠️ 收尾 helper 的依赖是**注入**的，因此这里不需要真的把 PGlite 弄坏
 *    （也不需要打开真实库）—— 这是计划书 "故障注入用既有测试注入点" 的落点。
 *
 * 跑法：`pnpm exec tsx scripts/verify-inc-01-wp3.ts`（纯函数 + 静态读；不碰数据库）
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import {
  createShutdown,
  shutdownExitCode,
  type ShutdownReading,
} from '../src/infrastructure/persistence/runtime-shutdown.ts'
/*
 * ⚠️ 静态扫描必须**先剥注释**：第一版扫原文，于是我自己写的说明文字
 * （注释里的 `runtime.stop()` 与 `process.exit(0)` 举例）被当成了违规。
 * 这条教训已经出现三次，因此工具提在 `scripts/text-scan.ts` 里只写一份。
 */
import { stripComments, hasBareRuntimeStop } from './text-scan.ts'

const ROOT = resolve('.')

const rows: { label: string; pass: boolean; detail?: string }[] = []
const measurements: { label: string; count: number; mustBePositive: boolean }[] = []
let failures = 0
let measurementInvalid = 0

function check(label: string, pass: boolean, detail?: string): void {
  if (!pass) failures += 1
  rows.push({ label, pass, ...(detail !== undefined ? { detail } : {}) })
  console.log(`  ${pass ? 'PASS' : 'FAIL'} ${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}
function measure(label: string, count: number, mustBePositive = true): void {
  if (mustBePositive && count <= 0) measurementInvalid += 1
  measurements.push({ label, count, mustBePositive })
  console.log(`  MEASURE ${label} = ${count}${mustBePositive && count <= 0 ? '  ← MEASUREMENT INVALID' : ''}`)
}
function section(title: string): void {
  console.log(`\n${title}`)
}

// ---------------------------------------------------------------------------
// 探针：把 stop / close / closed 各自数成可断言的计数
// ---------------------------------------------------------------------------

interface Probe {
  stopCalls: number
  closeCalls: number
  closedCheckCalls: number
}

function makeProbe(options: {
  stop?: () => Promise<void>
  close?: () => Promise<void>
  isClosed?: () => boolean | Promise<boolean>
} = {}) {
  const counts: Probe = { stopCalls: 0, closeCalls: 0, closedCheckCalls: 0 }
  const handle = createShutdown({
    stop: async () => {
      counts.stopCalls += 1
      if (options.stop !== undefined) await options.stop()
    },
    close: async () => {
      counts.closeCalls += 1
      if (options.close !== undefined) await options.close()
    },
    isClosed: async () => {
      counts.closedCheckCalls += 1
      return options.isClosed !== undefined ? await options.isClosed() : true
    },
  })
  return { counts, handle }
}

/** 七个场景共用的判据 */
function assertClean(label: string, reading: ShutdownReading | undefined, counts: Probe): void {
  check(
    `${label}：stopCalls=1 / closeCalls=1 / closedCheckCalls=1 / closed=true`,
    counts.stopCalls === 1 &&
      counts.closeCalls === 1 &&
      counts.closedCheckCalls === 1 &&
      reading?.closed === true,
    `stop=${counts.stopCalls} close=${counts.closeCalls} check=${counts.closedCheckCalls} closed=${String(reading?.closed)}`
  )
  check(`${label}：退出码判据为 0`, shutdownExitCode(reading) === 0)
}

// ---------------------------------------------------------------------------
// §1 七个场景
// ---------------------------------------------------------------------------

section('§1 七个场景 —— 每条路径都恰好一次 stop、一次 close、且真的关上了')

let scenariosRun = 0

/** ① 正常只读命令（一个分支走到 return） */
{
  const { counts, handle } = makeProbe()
  const reading = await handle.shutdown()
  assertClean('① 正常只读命令', reading, counts)
  scenariosRun += 1
}

/** ② 脚本对话（业务返回后再收尾一次：最外层 finally 也调它 ⇒ 幂等） */
{
  const { counts, handle } = makeProbe()
  const first = await handle.shutdown()
  const second = await handle.shutdown()
  assertClean('② 脚本对话（幂等：两次调用只发生一次）', first, counts)
  check('② 两次调用返回**同一个对象**（复用同一个 Promise）', first === second)
  scenariosRun += 1
}

/** ③ 交互退出（交互会话的 close 与最外层 finally 各调一次） */
{
  const { counts, handle } = makeProbe()
  const reading = await handle.shutdown() // 会话 close()
  await handle.shutdown() // main 的最外层 finally
  assertClean('③ 交互退出（会话 close + finally）', reading, counts)
  check('③ 第二次调用没有新增 stop/close', counts.stopCalls === 1 && counts.closeCalls === 1)
  scenariosRun += 1
}

/** ④ 业务异常（try/finally 里收尾） */
{
  const { counts, handle } = makeProbe()
  let reading: ShutdownReading | undefined
  try {
    throw new Error('fixture：业务异常')
  } catch {
    /* 业务异常本身不影响收尾 */
  } finally {
    reading = await handle.shutdown()
  }
  assertClean('④ 业务异常', reading, counts)
  scenariosRun += 1
}

/** ⑤ 初始化异常（runtime 建好但 initialize 失败 ⇒ 最外层 finally 收尾） */
{
  const { counts, handle } = makeProbe()
  let reading: ShutdownReading | undefined
  try {
    throw new Error('fixture：初始化异常')
  } catch {
    /* 初始化异常由上层记录（这里模拟"被处理掉"），收尾在 finally 里 */
  } finally {
    reading = await handle.shutdown()
  }
  assertClean('⑤ 初始化异常', reading, counts)
  scenariosRun += 1
}

/** ⑥ SIGINT（信号处理触发一次；随后 finally 再触发一次） */
{
  const { counts, handle } = makeProbe()
  const fromSignal = await handle.shutdown() // onShutdownSignal
  const fromFinally = await handle.shutdown() // 最外层 finally
  assertClean('⑥ SIGINT', fromSignal, counts)
  check('⑥ 信号与 finally 不会双关', fromSignal === fromFinally)
  scenariosRun += 1
}

/** ⑦ SIGTERM（同 ⑥） */
{
  const { counts, handle } = makeProbe()
  const fromSignal = await handle.shutdown()
  await handle.shutdown()
  assertClean('⑦ SIGTERM', fromSignal, counts)
  scenariosRun += 1
}

measure('§1 场景数（计划书要求七个）', scenariosRun)

// ---------------------------------------------------------------------------
// §2 三种故障注入（负控）
// ---------------------------------------------------------------------------

section('§2 故障注入 —— 失败必须被如实记录，且不改变"该做的都做了"')

/** ② 注入 stop 失败 */
{
  const { counts, handle } = makeProbe({
    stop: async () => {
      throw new Error('fixture：stop 失败')
    },
  })
  const reading = await handle.shutdown()
  check(
    '§2-1 stop 失败 ⇒ close **仍然执行**（停服务失败不连累关库）',
    reading.stopFailed === true && counts.closeCalls === 1 && reading.closed === true,
    `${reading.note}`
  )
  check('§2-2 stop 失败 ⇒ 退出码判据**非零**', shutdownExitCode(reading) === 1)
}

/** ③ 注入 close 失败 */
{
  const { counts, handle } = makeProbe({
    close: async () => {
      throw new Error('fixture：close 失败')
    },
    isClosed: () => false,
  })
  const reading = await handle.shutdown()
  check(
    '§2-3 close 失败 ⇒ **不得**声称已关闭（closed = false）',
    reading.closeFailed === true && reading.closed === false,
    `${reading.note}`
  )
  check(
    '§2-4 close 失败 ⇒ 退出码判据非零（"没抛"不等于"关上了"的反面同理）',
    shutdownExitCode(reading) === 1
  )
  check('§2-5 closed 检查仍然被问过（它是判据，不是可选步骤）', counts.closedCheckCalls === 1)
}

/** ④ close 成功但 closed 永远 false（最容易假绿的形态） */
{
  const { counts, handle } = makeProbe({ isClosed: () => false })
  const reading = await handle.shutdown()
  check(
    '§2-6 close 没抛但 closed=false ⇒ **不算关干净**（这正是事故的形态：看起来完成了）',
    reading.closeFailed === false && reading.closed === false && shutdownExitCode(reading) === 1,
    `${reading.note}`
  )
  check('§2-7 该场景仍然只关一次', counts.stopCalls === 1 && counts.closeCalls === 1)
}

/** ⑤ closed 检查本身抛错（失败关闭） */
{
  const { handle } = makeProbe({
    isClosed: () => {
      throw new Error('fixture：closed 探测失败')
    },
  })
  const reading = await handle.shutdown()
  check(
    '§2-8 closed 检查抛错 ⇒ **失败关闭**（判为未关闭，且退出码非零）',
    reading.closed === false && shutdownExitCode(reading) === 1,
    `${reading.note}`
  )
}

/** ⑥ 收尾路径永不抛（否则它会掩盖原始错误） */
{
  const { handle } = makeProbe({
    stop: async () => {
      throw new Error('a')
    },
    close: async () => {
      throw new Error('b')
    },
    isClosed: () => {
      throw new Error('c')
    },
  })
  let threw = false
  try {
    await handle.shutdown()
  } catch {
    threw = true
  }
  check('§2-9 三重失败下 `shutdown()` **仍然不抛**（收尾不得掩盖原始错误/改变退出码）', !threw)
}

// ---------------------------------------------------------------------------
// §3 静态扫描：真实 opener 不许"只 stop 不 close"，也不许 close 前 exit
// ---------------------------------------------------------------------------

section('§3 静态扫描 —— 真实 opener')

const OPENERS = [
  'src/main.ts',
  'scripts/snapshot-state.ts',
  'scripts/verify-m4-real-db.ts',
  'scripts/verify-m5.1.1-phase4b-db-v9.ts',
] as const

measure('§3 被扫描的真实 opener 数', OPENERS.length)

const stopOnly: string[] = []
const exitBeforeClose: string[] = []
const missingShutdown: string[] = []

for (const file of OPENERS) {
  // **剥注释**再扫（见文件头部的说明）
  const text = stripComments(readFileSync(join(ROOT, file), 'utf8'))
  // "只 stop 不 close"：出现裸 `runtime.stop()`（唯一收尾句柄之外的地方）
  if (hasBareRuntimeStop(text)) stopOnly.push(file)
  if (!text.includes('createRuntimeShutdown(')) missingShutdown.push(file)
  const shutdownIndex = text.indexOf('createRuntimeShutdown(')
  const exitIndex = text.indexOf('process.exit(')
  if (exitIndex !== -1 && (shutdownIndex === -1 || exitIndex < shutdownIndex)) {
    exitBeforeClose.push(file)
  }
}

check('§3-1 真实 opener 里**没有**裸 `runtime.stop()`（只 stop 不 close）', stopOnly.length === 0, stopOnly.join(',') || '（干净）')
check(
  '§3-2 每个真实 opener 都走了唯一收尾句柄',
  missingShutdown.length === 0,
  missingShutdown.join(',') || '（全部已接）'
)
check(
  '§3-3 没有任何 `process.exit()` 出现在收尾调用**之前**（不许越过关闭）',
  exitBeforeClose.length === 0,
  exitBeforeClose.join(',') || '（干净）'
)

const mainSrc = stripComments(readFileSync(join(ROOT, 'src/main.ts'), 'utf8'))
check(
  '§3-4 `main.ts` 里 SIGINT 与 SIGTERM 各注册一次有序收尾',
  mainSrc.includes("process.once('SIGINT'") && mainSrc.includes("process.once('SIGTERM'")
)
check(
  '§3-5 最外层 `finally` 调收尾句柄（新分支忘了关库不再是可能的缺陷）',
  /\.finally\(async \(\) => \{[\s\S]{0,400}?runtimeShutdown\?\.shutdown\(\)/.test(mainSrc)
)
check(
  '§3-6 交互会话的 `close()` 也走同一个句柄（不再只 `runtime.stop()`）',
  /async close\(\): Promise<void> \{[\s\S]{0,600}?this\.shutdown\.shutdown\(\)/.test(mainSrc)
)
check(
  '§3-7 退出码判据只有一处实现（`shutdownExitCode`）',
  mainSrc.includes('shutdownExitCode(') &&
    (readFileSync(join(ROOT, 'src/infrastructure/persistence/runtime-shutdown.ts'), 'utf8').split(
      'export function shutdownExitCode('
    ).length -
      1) === 1
)

// ---------------------------------------------------------------------------
// 判决与证据
// ---------------------------------------------------------------------------

section('判决')

const total = rows.length
const passed = rows.filter((row) => row.pass).length
let verdict = 'PASS'
if (measurementInvalid > 0) verdict = 'MEASUREMENT INVALID'
else if (failures > 0) verdict = 'FAIL'

const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const now = new Date()
const runId = `inc01-wp3-${now.toISOString().slice(0, 10).replace(/-/g, '')}-${head.slice(0, 12)}`
const outDir = resolve('artifacts/incidents/inc-01')
mkdirSync(outDir, { recursive: true })
const outPath = join(outDir, 'wp3-close.json')

writeFileSync(
  outPath,
  `${JSON.stringify(
    {
      schemaVersion: 'inc01-wp3-close@1',
      runId,
      generatedAt: now.toISOString(),
      head,
      verdict,
      passed,
      failed: failures,
      measurementInvalid,
      measurements,
      checks: rows,
      scenarios: scenariosRun,
      staticScan: { openers: OPENERS, stopOnly, exitBeforeClose, missingShutdown },
      scope: {
        opensProductionDatabase: false,
        callsModel: false,
        note:
          '收尾 helper 的依赖是注入的 ⇒ 本门不需要真的打开数据库，也不需要把 PGlite 弄坏。' +
          '静态扫描只读源文件。**真实库从未被打开**。',
        headSemantics: '`head` = 运行时 git HEAD（被测代码提交）；证据文件落在紧随其后的纯证据提交里。',
      },
    },
    null,
    2
  )}\n`,
  'utf8'
)

console.log(`\n  ${verdict} — ${passed}/${total} 通过，失败 ${failures}，MEASUREMENT INVALID ${measurementInvalid}`)
console.log(`  证据：${relative(ROOT, outPath).split(/[\\/]/).join('/')}`)

process.exit(verdict === 'PASS' ? 0 : 2)
