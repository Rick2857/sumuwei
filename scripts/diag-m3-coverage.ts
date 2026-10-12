/**
 * 诊断：M3 套件里"需要模型"与"离线可跑"的用例分布。
 *
 * 为什么需要它：M3 的 Gate 分两档（计划书第 144–146 节）——
 * PR smoke 只跑离线档，Release Gate 才跑人格档。
 * 于是"某一档实际覆盖了多少用例"是一个会**静默漂移**的数字：
 * 某天有人把 `requiresModel` 标错，那一档就会悄悄少跑几条，
 * 而两边看起来都是绿的。
 *
 * 这个脚本把分布摊开，让"哪一档覆盖了什么"是一个可核对的清单。
 *
 * 跑法：tsx scripts/diag-m3-coverage.ts
 */

import { M3_SUITES } from '../evals/m3/index.ts'
import { M3_HARD_ZERO_METRICS } from '../evals/m3/types.ts'

let liveCases = 0
let offlineCases = 0
let liveChecks = 0
let offlineChecks = 0
let judgeChecks = 0
let deterministicChecks = 0

console.log('='.repeat(78))
console.log('M3 评测覆盖分布')
console.log('='.repeat(78))
console.log('')
console.log('  套件                      用例(live/离线)   检查(确定性/judge)   硬零指标')
console.log('  ' + '-'.repeat(74))

for (const suite of M3_SUITES) {
  const live = suite.cases.filter((item) => item.requiresModel).length
  const offline = suite.cases.length - live
  liveCases += live
  offlineCases += offline

  let deterministic = 0
  let judge = 0
  for (const item of suite.cases) {
    for (const check of item.checks) {
      if (check.kind === 'deterministic') deterministic += 1
      else judge += 1
    }
  }
  deterministicChecks += deterministic
  judgeChecks += judge

  // 这个套件里有哪些检查算进硬零指标
  const hardZero = new Set<string>()
  for (const item of suite.cases) {
    for (const check of item.checks) {
      const metric = (check as { metric?: string }).metric
      if (metric && (M3_HARD_ZERO_METRICS as readonly string[]).includes(metric)) {
        hardZero.add(metric)
      }
    }
  }

  console.log(
    `  ${suite.id.padEnd(24)}  ${String(`${live}/${offline}`).padStart(8)}` +
      `        ${String(`${deterministic}/${judge}`).padStart(10)}` +
      `        ${hardZero.size > 0 ? [...hardZero].join(',') : '—'}`
  )
}

liveChecks += 0
console.log('')
console.log(`  用例合计：${liveCases + offlineCases} 条（需要模型 ${liveCases}｜离线 ${offlineCases}）`)
console.log(
  `  检查合计：${deterministicChecks + judgeChecks} 条` +
    `（确定性 ${deterministicChecks}｜judge ${judgeChecks}）`
)
console.log('')
console.log('  两档各自覆盖：')
console.log(
  `    pnpm eval:m3        离线档 → ${offlineCases} 条用例；` +
    `所有用例里的 ${deterministicChecks} 条确定性检查`
)
console.log(
  `    pnpm eval:m3:live   真实模型档 → ${liveCases} 条用例；` +
    `${judgeChecks} 条 judge 检查（离线档里它们一律 skipped）`
)
console.log('')
console.log(
  `  硬零指标（无条件判定，不需要 baseline）：${(M3_HARD_ZERO_METRICS as readonly string[]).join(', ')}`
)
console.log('')
console.log('='.repeat(78))

void liveChecks
