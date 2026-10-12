/**
 * 诊断：Seed 渲染一致性。
 *
 * 为什么需要它：SC-001 的 A3 断言报"库里的 Seed 渲染结果与代码定义不一致"，
 * 而那句报错本身**不告诉你差在哪**。排查 Seed 问题时最容易走错的路是
 * 直接猜"是不是有人改了人设" —— 正确的第一步是**把两份渲染结果逐行对照**。
 *
 * 本脚本完全离线、不碰真实库（用纯内存对比）。
 *
 * 跑法：tsx scripts/diag-seed-diff.ts
 */

import { character } from '../src/character/index.ts'
import { characterDefinitionFromCharacter } from '../src/infrastructure/runtime/seed-projection.ts'
import {
  canonicalSeedJson,
  renderSeedIdentity,
  seedFingerprint,
  type CharacterDefinition,
} from '../src/kernel/contracts/index.ts'
import { hashSeed } from '../src/infrastructure/persistence/seed-hash.ts'

/** 逐行差异（只报真正不同的行，附行号） */
function diffLines(a: string, b: string, labelA: string, labelB: string): string[] {
  const left = a.split('\n')
  const right = b.split('\n')
  const out: string[] = []
  const max = Math.max(left.length, right.length)
  for (let i = 0; i < max; i += 1) {
    if (left[i] !== right[i]) {
      out.push(`第 ${i + 1} 行：`)
      out.push(`  ${labelA}: ${JSON.stringify(left[i] ?? '(缺)')}`)
      out.push(`  ${labelB}: ${JSON.stringify(right[i] ?? '(缺)')}`)
    }
  }
  return out
}

/** 逐字段差异（用于定位"是内容不同还是元数据不同"） */
function diffFields(a: CharacterDefinition, b: CharacterDefinition): string[] {
  const out: string[] = []
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof CharacterDefinition>
  for (const key of keys) {
    const va = JSON.stringify(a[key])
    const vb = JSON.stringify(b[key])
    if (va !== vb) {
      out.push(`字段 ${String(key)}：`)
      out.push(`  代码定义: ${va}`)
      out.push(`  库内定义: ${vb}`)
    }
  }
  return out
}

const withNowZero = characterDefinitionFromCharacter(character as never, { now: 0 })
const withRealNow = characterDefinitionFromCharacter(character as never)

console.log('='.repeat(72))
console.log('Seed 渲染一致性诊断')
console.log('='.repeat(72))

console.log('\n## 指纹与 hash')
console.log(`  代码定义(now=0)     hash=${hashSeed(withNowZero)}`)
console.log(`  代码定义(now=真实)  hash=${hashSeed(withRealNow)}`)
console.log(`  两者 hash 相同？    ${hashSeed(withNowZero) === hashSeed(withRealNow)}`)

const textA = renderSeedIdentity(withNowZero)
const textB = renderSeedIdentity(withRealNow)
console.log(`  两者渲染文本相同？  ${textA === textB}`)

console.log('\n## 渲染文本差异（now=0 vs now=真实）')
const lineDiffs = diffLines(textA, textB, 'now=0', 'now=真实')
if (lineDiffs.length === 0) console.log('  （无差异）')
else console.log(lineDiffs.map((l) => `  ${l}`).join('\n'))

console.log('\n## 字段差异（now=0 vs now=真实）')
const fieldDiffs = diffFields(withNowZero, withRealNow)
if (fieldDiffs.length === 0) console.log('  （无差异）')
else console.log(fieldDiffs.map((l) => `  ${l}`).join('\n'))

console.log('\n## canonical JSON 是否相同')
console.log(`  ${canonicalSeedJson(withNowZero) === canonicalSeedJson(withRealNow)}`)

console.log('\n## 渲染文本长度')
console.log(`  now=0    ${textA.length} 字符`)
console.log(`  now=真实 ${textB.length} 字符`)

console.log('\n## fingerprint（领域侧的指纹材料）是否相同')
console.log(`  ${seedFingerprint(withNowZero) === seedFingerprint(withRealNow)}`)

console.log('\n## 渲染文本前 40 行（now=0，用于人工核对）')
console.log(textA.split('\n').slice(0, 40).map((l) => `  | ${l}`).join('\n'))

console.log('\n' + '='.repeat(72))
