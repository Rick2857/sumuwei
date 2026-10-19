/**
 * 诊断：库内 Seed vs 代码 Seed（A3 断言的逐行对照）。
 *
 * 与 `diag-seed-diff.ts` 的区别：那个只比较**两份代码定义**，
 * 这个真的起一个隔离 runtime + 迁移，把**库读回来的那一份**与代码定义对照。
 *
 * 完全在一次性副本库上跑（`isolateDatabase`），真实库绝不被碰。
 *
 * 跑法：tsx scripts/diag-seed-db-diff.ts
 */

import 'dotenv/config'

import { isolateDatabase } from '../src/dev/sandbox.ts'

import { createThinHostRuntime } from '../src/infrastructure/runtime/thin-host-factory.ts'
import type { Character, Plugin } from '../src/infrastructure/runtime/eliza-types.ts'
import { stringToUuid } from '../src/kernel/contracts/uuid.ts'

import { character } from '../src/character/index.ts'
import { initDatabase } from '../src/db/index.ts'
import { initKernel } from '../src/kernel/app/kernel.ts'
import { createPersistentCharacterPlugin } from '../src/plugin/persistent-character.ts'
import { openAiCompatiblePlugin } from '../src/providers/openai-compatible.ts'
import { characterDefinitionFromCharacter } from '../src/infrastructure/runtime/seed-projection.ts'
import { renderSeedIdentity, canonicalSeedJson } from '../src/kernel/contracts/index.ts'
import { hashSeed } from '../src/infrastructure/persistence/seed-hash.ts'

isolateDatabase('diag-seed-db-diff')

const userId = stringToUuid('user-Alex')
const runtime = createThinHostRuntime({
  character: character,
  conversationLength: 16,
  settings: {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? '',
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? 'https://api.deepseek.com',
    OPENAI_LARGE_MODEL: process.env.OPENAI_LARGE_MODEL ?? 'deepseek-flash',
    OPENAI_SMALL_MODEL: process.env.OPENAI_SMALL_MODEL ?? 'deepseek-flash',
  },
})

await initDatabase(runtime)
await runtime.initialize()

// 与 harness 完全同一条路径：不带 now（所以 createdAt 是真实时间）
const kernel = await initKernel(runtime, {
  definition: characterDefinitionFromCharacter(character as never),
})

// A3 用的 expected：带 now=0
const expected = characterDefinitionFromCharacter(character as never, { now: 0 })

const stored = kernel.definition
const storedText = renderSeedIdentity(stored)
const expectedText = renderSeedIdentity(expected)

console.log('='.repeat(72))
console.log('库内 Seed vs 代码 Seed 对照')
console.log('='.repeat(72))
console.log(`\n  库内：seedVersion=${stored.seedVersion} schemaVersion=${stored.schemaVersion}`)
console.log(`        createdAt=${stored.createdAt} updatedAt=${stored.updatedAt}`)
console.log(`        hash=${hashSeed(stored)}`)
console.log(`  代码：seedVersion=${expected.seedVersion} schemaVersion=${expected.schemaVersion}`)
console.log(`        createdAt=${expected.createdAt} updatedAt=${expected.updatedAt}`)
console.log(`        hash=${hashSeed(expected)}`)

console.log(`\n  hash 相同？        ${hashSeed(stored) === hashSeed(expected)}`)
console.log(`  canonical 相同？   ${canonicalSeedJson(stored) === canonicalSeedJson(expected)}`)
console.log(`  渲染文本相同？     ${storedText === expectedText}`)
console.log(`  渲染长度：库 ${storedText.length} / 代码 ${expectedText.length}`)

const left = storedText.split('\n')
const right = expectedText.split('\n')
console.log('\n## 逐行差异')
let diffCount = 0
for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
  if (left[i] !== right[i]) {
    diffCount += 1
    console.log(`  第 ${i + 1} 行：`)
    console.log(`    库内: ${JSON.stringify(left[i] ?? '(缺)')}`)
    console.log(`    代码: ${JSON.stringify(right[i] ?? '(缺)')}`)
  }
}
if (diffCount === 0) console.log('  （无差异）')

console.log('\n## 结构差异（JSON 层，忽略时间字段）')
const a = JSON.parse(canonicalSeedJson(stored)) as Record<string, unknown>
const b = JSON.parse(canonicalSeedJson(expected)) as Record<string, unknown>
for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
  const va = JSON.stringify(a[key])
  const vb = JSON.stringify(b[key])
  if (va !== vb) {
    console.log(`  字段 ${key}：`)
    console.log(`    库内: ${va}`)
    console.log(`    代码: ${vb}`)
  }
}

console.log('\n' + '='.repeat(72))
await runtime.stop()
process.exit(0)
