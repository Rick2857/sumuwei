/**
 * M6 —— **离线套件聚合**（`pnpm m6:verify --suite <...>`）。
 *
 * ============================================================================
 *  三条纪律（计划书 §9.1）
 * ============================================================================
 * 1. **必须显式选择套件**：不给 `--suite` 就拒绝运行。理由：M6 的套件里有
 *    "读隔离库 + 起 kernel"这类要几十秒的项，默认一口气全跑会让"跑一下看看"
 *    变成一次真实开销；而**默认跑步该由人说出来**。
 * 2. **不偷偷调用模型或搜索**：本文件只 spawn 三个**离线**脚本（见 `M6_SUITES`），
 *    并且**静态断言**它们不含模型/搜索调用面 —— 于是"以后有人把 Live 塞进这里"
 *    会让这条断言变红，而不是悄悄烧掉一次真实出站。
 * 3. **每个套件的退出码如实汇总**：一个失败就是整体失败；不做"平均分"。
 *
 * 用法：
 *   pnpm m6:verify --suite parts     # 摘要纯逻辑部件门
 *   pnpm m6:verify --suite wiring    # 接线门（packet 级）
 *   pnpm m6:verify --suite reader    # 只读来源读取面门（隔离库）
 *   pnpm m6:verify --suite all
 */

import { spawnSync } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import { M6_SUITES, auditSuiteScripts, resolveSuiteSelection } from './m6-command-surface.ts'

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

const ROOT = resolve('.')
const selection = resolveSuiteSelection(process.argv.slice(2))
if (!selection.ok) {
  console.error(`[m6:verify] ${selection.code}：${selection.message}`)
  process.exit(2)
}

const audit = auditSuiteScripts(ROOT, (path) => readFileSync(path, 'utf8'))
const forbidden = audit.filter((item) => item.offenders.length > 0)
if (forbidden.length > 0) {
  console.error('[m6:verify] 拒绝运行：登记表里出现了模型/搜索调用面')
  for (const item of forbidden) console.error(`  ${item.script}: ${item.offenders.join(', ')}`)
  process.exit(2)
}

console.log(`\nM6 离线套件：${selection.suites.join(' → ')}（不调用模型、不搜索）`)
console.log('─'.repeat(88))

const results: { suite: string; script: string; exitCode: number }[] = []
for (const name of selection.suites) {
  const suite = M6_SUITES.find((item) => item.name === name)
  if (suite === undefined) continue
  console.log(`\n▶ ${suite.name} — ${suite.label}`)
  const result = spawnSync('pnpm', ['exec', 'tsx', suite.script], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: true,
  })
  const exitCode = result.status === null ? 1 : result.status
  results.push({ suite: suite.name, script: suite.script, exitCode })
  console.log(`◀ ${suite.name} 退出码 = ${exitCode}`)
}

console.log('\n' + '─'.repeat(88))
for (const result of results) {
  console.log(`  ${result.exitCode === 0 ? '✅' : '❌'} ${result.suite.padEnd(10)} exit=${result.exitCode}`)
}
const overall = results.every((result) => result.exitCode === 0) ? 'PASS' : 'FAIL'

const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const now = new Date()
const runId = `m6-verify-${now.toISOString().slice(0, 10).replace(/-/g, '')}-${head.slice(0, 12)}`
const outDir = join(ROOT, 'artifacts/m6', runId)
mkdirSync(outDir, { recursive: true })
const outPath = join(outDir, 'verify.json')
writeFileSync(
  outPath,
  `${JSON.stringify(
    {
      schemaVersion: 'm6-verify@1',
      runId,
      generatedAt: now.toISOString(),
      head,
      verdict: overall,
      requestedSuites: selection.suites,
      results,
      counts: {
        executed: results.length,
        completed: results.filter((r) => r.exitCode === 0).length,
        skipped: 0,
        failed: results.filter((r) => r.exitCode !== 0).length,
      },
      scope: {
        opensProductionDatabase: false,
        callsModel: false,
        runsSearch: false,
        note:
          '离线套件聚合：只 spawn 登记表里的离线脚本。每个套件把证据写进自己的 runId 目录；' +
          '本文件只记退出码，**不**复制它们的结论（避免第二份 verdict）。',
      },
    },
    null,
    2
  )}\n`,
  'utf8'
)

console.log(`\n  **m6:verify = ${overall}**`)
console.log(`  证据：${relative(ROOT, outPath).split(/[\\/]/).join('/')}\n`)

process.exit(overall === 'PASS' ? 0 : 2)
