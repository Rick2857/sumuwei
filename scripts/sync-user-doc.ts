/**
 * 把项目内的权威版说明书同步到桌面。
 *
 * ============================================================================
 *  为什么需要这个脚本
 * ============================================================================
 * 用户要求的桌面说明书（C:\Users\user\Desktop\苏沐薇-使用说明.txt）在项目之外，
 * 不纳入版本管理。为了让"两份文件"不产生"该信哪个"的问题，约定：
 *
 *   docs\苏沐薇-使用说明.txt           ← 权威源，干净 UTF-8，进 git，有历史
 *   桌面\苏沐薇-使用说明.txt           ← 投影，由本脚本生成，带 UTF-8 BOM
 *
 * 因此**只改权威源**，然后跑本脚本同步。不要直接编辑桌面那份——
 * 它下次同步就会被覆盖。
 *
 * ---------------------------------------------------------------------------
 *  写成通知文件时的一个坑：BOM
 * ---------------------------------------------------------------------------
 * 中文 txt 若不带 UTF-8 BOM，部分编辑器（旧版记事本、某些国产编辑器）
 * 会按 GBK 猜测解码，整篇变成乱码（`鑻忔矏钖?`）。
 * 而仓库里的文件带 BOM 又会让 diff 变脏。
 * 所以：源文件无 BOM，投影文件写 BOM。本脚本负责这个转换。
 *
 * 用法：
 *   node_modules/.bin/tsx scripts/sync-user-doc.ts           # 同步
 *   node_modules/.bin/tsx scripts/sync-user-doc.ts --check   # 只检查是否漂移
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { homedir } from 'node:os'

/** 权威源（项目内，进 git） */
const SOURCE = resolve('docs/苏沐薇-使用说明.txt')
/** 投影目标（桌面） */
const TARGET = resolve(
  process.env.USERPROFILE ?? homedir(),
  'Desktop/苏沐薇-使用说明.txt'
)

/** 去掉可能的 BOM，得到纯文本 */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

const checkOnly = process.argv.includes('--check')

if (!existsSync(SOURCE)) {
  console.error(`❌ 找不到权威源：${SOURCE}`)
  process.exit(1)
}

const canonical = stripBom(readFileSync(SOURCE, 'utf8'))
const targetRaw = existsSync(TARGET) ? readFileSync(TARGET, 'utf8') : undefined
const targetText = targetRaw === undefined ? undefined : stripBom(targetRaw)

const inSync = targetText !== undefined && targetText.replace(/\r\n/g, '\n') === canonical.replace(/\r\n/g, '\n')

if (checkOnly) {
  if (inSync) {
    console.log('✅ 桌面版与权威源一致，无需同步')
    process.exit(0)
  }
  console.log('❌ 桌面版与权威源**不一致**（有人直接改了桌面那份，或忘了同步）')
  console.log(`   权威源: ${SOURCE}`)
  console.log(`   桌面版: ${TARGET}`)
  console.log('   修正方式：node_modules/.bin/tsx scripts/sync-user-doc.ts')
  process.exit(1)
}

// 写投影：UTF-8 with BOM，保证任何编辑器都不会乱码
const withBom = new TextEncoder().encode('\ufeff' + canonical)
writeFileSync(TARGET, withBom)

console.log(`✅ 已同步到桌面：${TARGET}`)
console.log(`   来源：${SOURCE}`)
console.log(`   大小：${withBom.length} 字节（UTF-8 with BOM）`)
console.log('   注意：以后只改项目内那份，改完再跑一次本脚本。')
