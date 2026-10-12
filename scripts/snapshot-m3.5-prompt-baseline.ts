/**
 * 把当前代码产生的 Prompt **固化**为 M3.5 的比对基线。
 *
 * ============================================================================
 *  ⚠️ 必须在任何 M3.5 代码改动**之前**运行一次
 * ============================================================================
 * 它记录的是"M3 结束时她看到的东西"。如果先改代码再跑，基线记的就是改后的
 * prompt —— 那时 FC-T08 会永远通过，而它本该守的东西已经丢了。
 *
 * 跑法：
 *   pnpm m3.5:baseline            # 写入 evals/fixtures/m3.5/
 *   tsx scripts/snapshot-m3.5-prompt-baseline.ts --check   # 只比对，不写
 *
 * 产物：
 *   evals/fixtures/m3.5/prompt-baseline.txt        完整 prompt（逐字节比对）
 *   evals/fixtures/m3.5/prompt-baseline.meta.json  结构性事实（section / 版本 / 指纹）
 *
 * 判据的"设计说明"在 `scripts/m3.5-prompt-baseline.ts` 的文件头。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  BASELINE_FIXTURE_DIR,
  BASELINE_META_FILE,
  BASELINE_PROMPT_FILE,
  buildBaselinePrompt,
} from './m3.5-prompt-baseline.ts'

const checkOnly = process.argv.includes('--check')
const dir = join(process.cwd(), BASELINE_FIXTURE_DIR)
const promptPath = join(dir, BASELINE_PROMPT_FILE)
const metaPath = join(dir, BASELINE_META_FILE)

const result = await buildBaselinePrompt()
const metaJson = `${JSON.stringify(result.meta, null, 2)}\n`

if (checkOnly) {
  let failed = 0
  const compare = (label: string, actual: string, path: string): void => {
    if (!existsSync(path)) {
      failed += 1
      console.log(`  ❌ ${label}：夹具不存在（${path}）—— 先跑 pnpm m3.5:baseline`)
      return
    }
    const expected = readFileSync(path, 'utf8')
    /*
     * prompt 用**逐字节**比对；meta 用规范化 JSON 比对（缩进/换行不参与判据）。
     *
     * 唯一的例外是行尾：两边都先把 CRLF 归一成 LF。
     * 行尾是版本控制的产物（`core.autocrlf=true` 会把工作区检出成 CRLF），
     * 与"她看到的 prompt"无关。`.gitattributes` 给夹具钉了 LF，
     * 但编辑器保存 / zip 解压不会经过它，因此这里再兜一层。
     */
    const same =
      label === 'prompt'
        ? toLf(actual) === toLf(expected)
        : normalizeJson(actual) === normalizeJson(expected)
    if (same) {
      console.log(`  ✅ ${label}：与基线一致`)
    } else {
      failed += 1
      console.log(`  ❌ ${label}：与基线不一致`)
      if (label === 'prompt') {
        const firstDiff = firstDifference(expected, actual)
        console.log(`       第一处差异在字符 ${firstDiff}`)
        console.log(`       基线: ${JSON.stringify(expected.slice(Math.max(0, firstDiff - 40), firstDiff + 60))}`)
        console.log(`       当前: ${JSON.stringify(actual.slice(Math.max(0, firstDiff - 40), firstDiff + 60))}`)
      } else {
        console.log(`       基线: ${normalizeJson(expected)}`)
        console.log(`       当前: ${normalizeJson(actual)}`)
      }
    }
  }

  console.log('='.repeat(72))
  console.log('M3.5 Prompt 基线比对（FC-T08）')
  console.log('='.repeat(72))
  compare('prompt', result.prompt, promptPath)
  compare('meta', metaJson, metaPath)
  console.log('='.repeat(72))
  process.exit(failed === 0 ? 0 : 1)
}

mkdirSync(dir, { recursive: true })
writeFileSync(promptPath, result.prompt, 'utf8')
writeFileSync(metaPath, metaJson, 'utf8')

console.log('M3.5 Prompt 基线已写入：')
console.log(`  ${promptPath}（${result.prompt.length} 字符）`)
console.log(`  ${metaPath}`)
console.log(`  compiler=${result.meta.compilerVersion}`)
console.log(`  sections=[${result.meta.contextSectionIds.join(', ')}]`)
console.log(`  seed=v${result.meta.seedVersion} ${result.meta.seedHash.slice(0, 12)}`)

/** 行尾归一（行尾是版本控制的产物，不是 prompt 的内容） */
function toLf(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

function normalizeJson(text: string): string {  try {
    return JSON.stringify(sortKeys(JSON.parse(text) as unknown))
  } catch {
    return text
  }
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, sortKeys(record[key])])
    )
  }
  return value
}

function firstDifference(expected: string, actual: string): number {
  const limit = Math.min(expected.length, actual.length)
  for (let i = 0; i < limit; i += 1) {
    if (expected[i] !== actual[i]) return i
  }
  return limit
}
