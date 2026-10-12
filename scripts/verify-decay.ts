/**
 * 挂钟衰减的确定性自测（不依赖数据库与模型，纯函数验算）。
 *
 * 跑法：node_modules/.bin/tsx scripts/verify-decay.ts
 */
import { applyDecay, DEFAULT_DECAY, describeDecay } from '../src/state/decay.ts'
import { createInitialState } from '../src/state/types.ts'

let failed = 0
function check(name: string, actual: number, expected: number, tolerance = 1e-6): void {
  const ok = Math.abs(actual - expected) <= tolerance
  if (!ok) failed++
  console.log(`  ${ok ? '✅' : '❌'} ${name}: 实际 ${actual.toFixed(6)}，期望 ${expected.toFixed(6)}`)
}

function checkBool(name: string, actual: boolean, expected: boolean): void {
  const ok = actual === expected
  if (!ok) failed++
  console.log(`  ${ok ? '✅' : '❌'} ${name}: 实际 ${actual}，期望 ${expected}`)
}

const HOUR = 3_600_000
const base = createInitialState('char', 'user', 0)
const angry = { ...base, valence: -0.8, arousal: 0.9 }

console.log('=== 1. 情绪按半衰期回归中性 ===')
console.log('   兴奋值 valence=-0.8 / arousal=0.9，半衰期 4h / 5h')
{
  const r = applyDecay(angry, 4 * HOUR)
  // valence: -0.8 经过一个半衰期 → -0.4
  check('4 小时后 valence 应为 -0.4', r.state.valence, -0.4, 1e-9)
  // arousal: 0.9 * 0.5^(4/5) = 0.9 * 0.574349...
  check('4 小时后 arousal', r.state.arousal, 0.9 * Math.pow(0.5, 4 / 5), 1e-9)
  checkBool('未触发长期分开', r.applied.absenceTriggered, false)
}
{
  const r = applyDecay(angry, 12 * HOUR)
  console.log(`  12 小时后：${describeDecay(r)}`)
  check('12 小时后 valence 应为 -0.1（3 个半衰期）', r.state.valence, -0.1, 1e-9)
}

console.log('\n=== 2. 信任不随时间变化 ===')
{
  const r = applyDecay({ ...base, trust: 0.85 }, 1000 * HOUR)
  check('1000 小时后 trust 仍为 0.85', r.state.trust, 0.85)
  checkBool('trust 不在衰减变量里', 'trust' in r.applied.deltas, false)
}

console.log('\n=== 3. closeness 只在超过 24 小时无互动后下行 ===')
{
  const r23 = applyDecay(base, 23 * HOUR)
  checkBool('23 小时：未触发', r23.applied.absenceTriggered, false)
  check('23 小时：closeness 不变', r23.state.closeness, base.closeness)

  const r25 = applyDecay(base, 25 * HOUR)
  checkBool('25 小时：已触发', r25.applied.absenceTriggered, true)
  // 超出阈值 1 小时 → 1/24 天 × 0.02
  const expected = base.closeness - (1 / 24) * DEFAULT_DECAY.closenessLossPerDay
  check('25 小时：closeness 下降', r25.state.closeness, expected, 1e-9)

  const r7d = applyDecay(base, 7 * 24 * HOUR)
  const absentDays = (7 * 24 - 24) / 24
  check(
    '7 天后：closeness 已明显下降',
    r7d.state.closeness,
    base.closeness - absentDays * DEFAULT_DECAY.closenessLossPerDay,
    1e-9
  )
  console.log(`  ${describeDecay(r7d)}`)
}

console.log('\n=== 4. 衰减不可逆（不会自动回弹）===')
{
  const after7d = applyDecay(base, 7 * 24 * HOUR).state
  // 再等 1 小时，closeness 只会更低，不会回升
  const later = applyDecay(after7d, 7 * 24 * HOUR + HOUR)
  checkBool('closeness 继续下行或持平', later.state.closeness <= after7d.closeness, true)
}

console.log('\n=== 5. 版本号单调递增（每次结算 +1）===')
{
  const r = applyDecay(base, HOUR)
  check('version 0 → 1', r.state.version, 1)
}

console.log(`\n${failed === 0 ? '全部通过 ✅' : `有 ${failed} 项失败 ❌`}`)
process.exit(failed === 0 ? 0 : 1)
