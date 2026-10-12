/**
 * 用 Promptfoo 跑**全部** M3 套件（每个套件一个 YAML）。
 *
 * ============================================================================
 *  为什么需要一个脚本，而不是一条 `&&` 串起来的命令
 * ============================================================================
 * 计划书第 49 节要求每个套件一个 YAML，于是"跑全部"就是 12 次
 * `promptfoo eval` 调用。用 `&&` 串起来有三个问题：
 *
 *   1. **第一个失败就停**：而我们要的是"这一轮整套的结论" ——
 *      一个套件红之后，其余 11 个的结果同样有价值。
 *   2. **汇总要靠人看**：12 段输出里到底几个红，得自己数。
 *   3. **退出码语义丢了**：串起来的 `&&` 只能表达"有没有红"，
 *      无法区分"某条用例红了"与"硬零指标红了"（后者是 CRITICAL）。
 *
 * 因此这里逐个跑完、汇总成一张表、按最严重的结论给退出码。
 *
 * ---------------------------------------------------------------------------
 *  它不做任何判断
 * ---------------------------------------------------------------------------
 * 每个套件的通过与否**由 provider 判定**（它读的是 `scripts/eval-m3.ts`
 * 的机器可读输出，而那是套件自己的结论）。本脚本只负责：跑、汇总、报。
 *
 * 跑法：
 *   tsx scripts/run-m3-promptfoo.ts                 全部套件
 *   tsx scripts/run-m3-promptfoo.ts identity-core    只跑一个（可重复）
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { M3_SUITES } from '../evals/m3/index.ts'

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

/** 位置参数当作套件 id 过滤（与既有 CLI 手感一致） */
const wanted = process.argv.slice(2).filter((arg) => !arg.startsWith('-'))
const suites =
  wanted.length > 0 ? M3_SUITES.filter((suite) => wanted.includes(suite.id)) : M3_SUITES

if (suites.length === 0) {
  console.error(`没有匹配的套件：${wanted.join(', ')}`)
  console.error(`可用套件：${M3_SUITES.map((suite) => suite.id).join(', ')}`)
  process.exit(2)
}

/** Windows 上 npm 的 bin 垫片是 `.cmd`；`shell: true` 下两者都能跑 */
const promptfoo =
  process.platform === 'win32' ? 'node_modules\\.bin\\promptfoo.cmd' : 'node_modules/.bin/promptfoo'

// ---------------------------------------------------------------------------
// 逐个跑
// ---------------------------------------------------------------------------

interface SuiteOutcome {
  suiteId: string
  configFile: string
  exitCode: number
  /** 从 Promptfoo 的摘要块里抠出来的计数（拿不到时为 undefined） */
  passed?: number
  failed?: number
  errors?: number
  /** 抓到的关键错误行（硬零违规会以 error 形式出现） */
  errorLines: string[]
  durationMs: number
}

const outcomes: SuiteOutcome[] = []

console.log('='.repeat(72))
console.log(`M3 Promptfoo 外层回归 —— ${suites.length} 个套件`)
console.log('='.repeat(72))

for (const suite of suites) {
  const configFile = join(process.cwd(), suite.promptfooFile)
  if (!existsSync(configFile)) {
    console.error(`\n❌ ${suite.id}：配置不存在（${suite.promptfooFile}）`)
    console.error('   先跑：pnpm eval:m3:promptfoo:build')
    outcomes.push({
      suiteId: suite.id,
      configFile: suite.promptfooFile,
      exitCode: 2,
      errorLines: ['配置不存在'],
      durationMs: 0,
    })
    continue
  }

  process.stdout.write(`\n⏳ ${suite.id} … `)
  const started = Date.now()
  /*
   * ⚠️ `shell: true` 下参数是**字符串拼进命令行**的，因此含空格的路径必须自己加引号。
   *
   * 实测踩到过：本仓库路径是 `…\Desktop\project LG`（**含空格**），
   * 不加引号时 cmd.exe 把它切成两个参数，promptfoo 收到的是
   * `…\Desktop\project`，于是报
   * "No configuration file found at C:\Users\user\Desktop\project" ——
   * 而那句报错读起来像是"配置文件没生成"，很容易往错的方向查。
   *
   * 既有那两个 provider（`evals/promptfoo/provider.cjs` 与 M3 的那个）
   * 之所以没踩到，是因为它们传的参数里不含空格（`scenarioId` / `suiteId`）。
   */
  const quotedConfig = `"${configFile}"`
  const result = spawnSync(promptfoo, ['eval', '-c', quotedConfig, '--no-cache'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    shell: true,
    env: { ...process.env },
    maxBuffer: 64 * 1024 * 1024,
  })
  const durationMs = Date.now() - started

  const combined = stripAnsi(`${String(result.stdout ?? '')}\n${String(result.stderr ?? '')}`)

  /*
   * Promptfoo 的摘要块形如：
   *
   *     Results:
   *       ✓ 1 passed (100%)
   *       0 failed (0%)
   *       0 errors (0%)
   *
   * 三行**各自独立**，因此要分别抓 —— 第一版用
   * `/(\d+) passed, (\d+) failed, (\d+) errors/` 去匹配一行，
   * 结果永远匹配不到，于是每个套件都显示"0 passed / 0 failed"
   * 却又是绿的：那正是"报告看起来正常、实际上什么都没量到"。
   */
  const passedMatch = /(\d+)\s+passed\b/i.exec(combined)
  const failedMatch = /(\d+)\s+failed\b/i.exec(combined)
  const errorsMatch = /(\d+)\s+errors?\b/i.exec(combined)

  // 只抓**我们的**错误语义：硬零违规与套件整体 ok=false。
  // 不加区分地抓 "error" 会连 PowerShell 自己的噪声
  // （`NativeCommandError`、`+ FullyQualifiedErrorId`）一起抓进来 ——
  // 那种噪声在 stderr 里必然出现，会把每次都判成红。
  const errorLines = combined
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /CRITICAL|硬零指标|硬零指标不为 0|套件整体 ok=false/.test(line))
    .slice(0, 8)

  outcomes.push({
    suiteId: suite.id,
    configFile: suite.promptfooFile,
    exitCode: result.status ?? 1,
    ...(passedMatch ? { passed: Number(passedMatch[1]) } : {}),
    ...(failedMatch ? { failed: Number(failedMatch[1]) } : {}),
    ...(errorsMatch ? { errors: Number(errorsMatch[1]) } : {}),
    errorLines,
    durationMs,
  })

  const passed = passedMatch ? Number(passedMatch[1]) : 0
  const failed = failedMatch ? Number(failedMatch[1]) : 0
  const errors = errorsMatch ? Number(errorsMatch[1]) : 0
  const critical = errorLines.length > 0
  // 判据用 Promptfoo 自己的计数，而不是只信退出码：
  // 退出码可能被外围环境改写，而"1 passed / 0 failed / 0 errors"是它的结论。
  const green = failed === 0 && errors === 0 && passed > 0 && !critical
    console.log(
      `${green ? '✅' : critical ? '🔴' : '❌'} ` +
        `${passed} passed / ${failed} failed / ${errors} errors（${(durationMs / 1000).toFixed(1)}s）`
    )
}

/** 去掉 ANSI 颜色码（Promptfoo 的表格输出带颜色，会干扰正则与肉眼核对） */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, '')
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

console.log('')
console.log('='.repeat(72))
console.log('M3 Promptfoo 汇总')
console.log('='.repeat(72))

const width = Math.max(...outcomes.map((outcome) => outcome.suiteId.length))
for (const outcome of outcomes) {
  const passed = outcome.passed ?? 0
  const failed = outcome.failed ?? 0
  const errors = outcome.errors ?? 0
  const critical = outcome.errorLines.length > 0
  const mark = critical ? '🔴 CRITICAL' : failed === 0 && errors === 0 && passed > 0 ? '✅' : '❌'
  console.log(
    `  ${outcome.suiteId.padEnd(width)}  ${String(passed).padStart(2)} passed / ` +
      `${String(failed).padStart(2)} failed / ${String(errors).padStart(2)} errors  ${mark}`
  )
  for (const line of outcome.errorLines) console.log(`      ${line.slice(0, 160)}`)
}

const red = outcomes.filter(
  (outcome) =>
    outcome.errorLines.length > 0 ||
    (outcome.failed ?? 0) > 0 ||
    (outcome.errors ?? 0) > 0 ||
    (outcome.passed ?? 0) === 0 ||
    outcome.exitCode === 2
)

console.log('')
console.log(
  `  套件：${outcomes.length - red.length}/${outcomes.length} 全绿｜` +
    `用例：${outcomes.reduce((total, outcome) => total + (outcome.passed ?? 0), 0)} passed / ` +
    `${outcomes.reduce((total, outcome) => total + (outcome.failed ?? 0), 0)} failed`
)
if (red.length > 0) {
  console.log('')
  console.log('  未全绿的套件：')
  for (const outcome of red) console.log(`    · ${outcome.suiteId}（exit ${outcome.exitCode}）`)
}
console.log('='.repeat(72))

process.exit(red.length === 0 ? 0 : 1)
