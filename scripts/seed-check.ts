/**
 * `m3:seed-check` —— Seed 的只读自检（计划书第 18/77 节的规程第 4 步）。
 *
 * ============================================================================
 *  它回答三个问题，且**不碰任何数据库**
 * ============================================================================
 *   1. 代码里的 Seed 指纹是什么？（改过之后一眼能看出变了没）
 *   2. 它是否自洽？（版本号、结构化字段、反例是否齐全）
 *   3. 与 DSH 记录的上一次指纹相比，是否发生了"内容变了但版本没升"？
 *
 * 第 3 条靠 `docs/m3/seed-fingerprint.json`：一个进 git 的小文件。
 * 于是"改人设忘了升版本"这件事在 **PR review 时**就能被发现，
 * 而不是等到启动时才报错（那时改动已经提交了）。
 *
 * 跑法：
 *   tsx scripts/seed-check.ts            # 检查（漂移则退出码 1）
 *   tsx scripts/seed-check.ts --update   # 把当前指纹写进记录文件
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { character } from '../src/character/index.ts'
import { characterDefinitionFromCharacter } from '../src/infrastructure/runtime/seed-projection.ts'
import {
  canonicalSeedJson,
  renderSeedIdentity,
  type CharacterDefinition,
} from '../src/kernel/contracts/index.ts'
import { SEED_VERSION, SEED_CHANGE_PROTOCOL } from '../src/kernel/identity/seed.ts'
import { hashSeed, shortHash } from '../src/infrastructure/persistence/seed-hash.ts'

const RECORD_PATH = join(process.cwd(), 'docs', 'm3', 'seed-fingerprint.json')

interface FingerprintRecord {
  seedVersion: number
  seedHash: string
  /** 记录时的结构摘要（用于人工核对"到底改了哪一块"） */
  summary: {
    traits: number
    values: number
    boundaries: number
    preferences: number
    identityChars: number
  }
  recordedAt: string
  note: string
}

function summarize(def: CharacterDefinition): FingerprintRecord['summary'] {
  return {
    traits: def.personality.traits.length,
    values: def.values.length,
    boundaries: def.boundaries.length,
    preferences: def.initialPreferences?.length ?? 0,
    identityChars: def.identity.selfDescription.length,
  }
}

/** 结构自检（这些是"结构化 Seed 必须成立"的东西，与内容无关） */
function selfCheck(def: CharacterDefinition): string[] {
  const problems: string[] = []

  if (def.seedVersion < 1) problems.push(`seedVersion 必须是 >= 1 的整数，收到 ${def.seedVersion}`)
  if (def.personality.traits.length === 0) problems.push('Seed 没有任何人格倾向（traits）')
  if (def.values.length === 0) problems.push('Seed 没有任何价值取向（values）')
  if (def.boundaries.length === 0) problems.push('Seed 没有任何边界条款（boundaries）')
  if (def.identity.selfDescription.trim() === '') problems.push('Seed 的 identity.selfDescription 为空')

  for (const trait of def.personality.traits) {
    if (trait.counterExamples.length === 0) {
      problems.push(
        `倾向「${trait.trait}」没有反例：计划书第 15 节要求每条倾向都带"它不意味着什么"（防角色漫画化）`
      )
    }
    if (!Number.isFinite(trait.strength) || trait.strength < 0 || trait.strength > 1) {
      problems.push(`倾向「${trait.trait}」的强度必须在 0..1，收到 ${trait.strength}`)
    }
    if (trait.description.trim() === '') {
      problems.push(`倾向「${trait.trait}」没有描述`)
    }
  }

  for (const value of def.values) {
    if (value.tradeoffNotes.length === 0) {
      problems.push(
        `价值「${value.value}」没有权衡说明：计划书第 16 节要求说明"它在冲突时怎么权衡"，` +
          '否则它会退化成一个更硬的规则'
      )
    }
  }

  // 渲染必须是确定性的（这是 SC-001 的前提）
  const once = renderSeedIdentity(def)
  const twice = renderSeedIdentity(def)
  if (once !== twice) problems.push('renderSeedIdentity 不是确定性的（同一份 Seed 渲染出不同文本）')

  // 规范化 JSON 必须稳定
  if (canonicalSeedJson(def) !== canonicalSeedJson(def)) {
    problems.push('canonicalSeedJson 不是确定性的')
  }

  return problems
}

// ---------------------------------------------------------------------------
const update = process.argv.includes('--update')
const def = characterDefinitionFromCharacter(character as never)
const hash = hashSeed(def)
const summary = summarize(def)

console.log('='.repeat(72))
console.log('Seed 自检（只读，不碰数据库）')
console.log('='.repeat(72))
console.log('')
console.log(`  角色      : ${def.name}（${def.slug}）`)
console.log(`  seed 版本 : v${def.seedVersion}`)
console.log(`  seed 指纹 : ${hash}`)
console.log(`  短指纹    : ${shortHash(hash)}`)
console.log(
  `  结构      : traits ${summary.traits} / values ${summary.values} / ` +
    `boundaries ${summary.boundaries} / preferences ${summary.preferences}`
)
console.log(`  渲染长度  : ${renderSeedIdentity(def).length} 字符`)

// --- 结构自检 --------------------------------------------------------------
console.log('')
console.log('## 结构自检')
const problems = selfCheck(def)
if (problems.length === 0) {
  console.log('  ✅ 全部通过')
} else {
  for (const problem of problems) console.log(`  ❌ ${problem}`)
}

// --- 与记录比对 ------------------------------------------------------------
console.log('')
console.log('## 与上一次记录比对')
let recorded: FingerprintRecord | undefined
if (existsSync(RECORD_PATH)) {
  try {
    recorded = JSON.parse(readFileSync(RECORD_PATH, 'utf8')) as FingerprintRecord
  } catch (error) {
    console.log(`  ⚠️ 记录文件无法解析：${(error as Error).message}`)
  }
}

let drift = false
if (!recorded) {
  console.log('  （还没有记录文件，本次用 --update 建立基线）')
} else {
  console.log(`  记录版本 : v${recorded.seedVersion}（${shortHash(recorded.seedHash)}）`)
  console.log(`  当前版本 : v${def.seedVersion}（${shortHash(hash)}）`)

  if (recorded.seedHash === hash) {
    console.log('  ✅ 内容与记录完全一致')
  } else if (recorded.seedVersion === def.seedVersion) {
    // 这正是"改人设忘了升版本"—— 必须在 review 时被发现
    drift = true
    console.log('  ❌ 内容变了但 seedVersion 没变')
    console.log('')
    console.log('     这是 Seed 维护里的经典事故（"她怎么悄悄变了"）。')
    console.log('     修法：升 SEED_VERSION、在 provenance 写明 author/reason、写 ADR。')
    console.log('')
    console.log(SEED_CHANGE_PROTOCOL.split('\n').map((l) => `     ${l}`).join('\n'))
  } else if (def.seedVersion < recorded.seedVersion) {
    drift = true
    console.log('  ❌ seedVersion 回退（只增不减）')
  } else {
    console.log('  ✅ 版本已升，指纹随之变化（这是一次正规的 Seed 变更）')
    const before = recorded.summary
    const after = summary
    const changes: string[] = []
    if (before.traits !== after.traits) changes.push(`traits ${before.traits} → ${after.traits}`)
    if (before.values !== after.values) changes.push(`values ${before.values} → ${after.values}`)
    if (before.boundaries !== after.boundaries) {
      changes.push(`boundaries ${before.boundaries} → ${after.boundaries}`)
    }
    if (before.preferences !== after.preferences) {
      changes.push(`preferences ${before.preferences} → ${after.preferences}`)
    }
    if (before.identityChars !== after.identityChars) {
      changes.push(`identity 字数 ${before.identityChars} → ${after.identityChars}`)
    }
    if (changes.length > 0) console.log(`     结构变化：${changes.join('，')}`)
    if (def.seedVersion !== SEED_VERSION) {
      console.log(`     ⚠️ 注意：库里的 SEED_VERSION 常量是 v${SEED_VERSION}，而定义是 v${def.seedVersion}`)
    }
  }
}

// --- 写记录 ----------------------------------------------------------------
if (update) {
  const record: FingerprintRecord = {
    seedVersion: def.seedVersion,
    seedHash: hash,
    summary,
    recordedAt: new Date().toISOString(),
    note: '由 tsx scripts/seed-check.ts --update 生成。改动 Seed 后必须同步更新它（它是 PR 期的漂移检测）。',
  }
  mkdirSync(dirname(RECORD_PATH), { recursive: true })
  writeFileSync(RECORD_PATH, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  console.log('')
  console.log(`  ✅ 已写入记录：${RECORD_PATH.replace(process.cwd(), '')}`)
}

console.log('')
console.log('='.repeat(72))

const failed = problems.length > 0 || drift
process.exit(failed ? 1 : 0)
