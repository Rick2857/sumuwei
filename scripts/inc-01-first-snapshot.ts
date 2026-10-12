/**
 * INC-01 **首次真实快照**（`pnpm inc-01:first-snapshot`）—— 计划书 §WP6 的 `G9`。
 *
 * ============================================================================
 *  它做什么
 * ============================================================================
 * ```text
 *   ① 测真实库的完整内容树摘要（before）+ 列出已有的 verified 快照
 *   ② 运行**一次** `pnpm db:snapshot`（只读源；健康探针只在 %TEMP% 副本上）
 *   ③ 再测一次摘要（after）+ 重新列出快照
 *   ④ 断言：退出码 0 · before == after（快照**只读**源）· 新快照的 manifest
 *            源摘要 == before · 目录 + manifest 都在 · 易失文件 postmaster.pid 未被改动
 *   ⑤ 把 retention 剪掉的旧快照**如实列出来**
 * ```
 *
 * ⚠️ 这一步是**破坏性状态切换之外的**动作：它不打开真实库、不改名任何东西，
 *    但**会**按 `INC01-D4` 的保留策略删掉超出窗口的旧快照 —— 因此它必须由用户当轮授权。
 *    本脚本**只**运行一条命令；它自己不做任何删除、不做任何重试。
 *
 * 用法：
 *   pnpm inc-01:first-snapshot --list   # 只列现状（不跑快照）
 *   pnpm inc-01:first-snapshot          # 真的执行一次
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { digestTree } from '../src/infrastructure/persistence/production-db-safety.ts'
import { DEFAULT_SNAPSHOT_ROOT } from '../src/infrastructure/persistence/production-open-guard.ts'
import { orphanSnapshotManifests } from './inc-01-real-db-drift.ts'

const ROOT = resolve('.')
const REAL_DB = resolve('data/pglite')
const ART = join(ROOT, 'artifacts/incidents/inc-01')

/**
 * ⚠️ **保留窗口刻意放宽，让这一步不删任何东西。**
 *
 * 计划书 §6.10 把"删除旧快照"列为**需要单独授权**的动作，而 `db:snapshot` 的缺省
 * `keep = 3` 会顺手剪掉超出窗口的旧快照（现在有十几份，其中包括 WP0 基线那一份）。
 * ⇒ 本次首次真实快照用 `--keep 30`（远大于现有份数）：`INC01-D4` 的"不足 n 份不得清理"
 * 因此保证**零删除**。将来要回到缺省 3 必须另行授权。
 */
const KEEP_WITHOUT_DELETION = '30'
const COMMAND = `pnpm db:snapshot --keep ${KEEP_WITHOUT_DELETION}`

function verifiedSnapshots(): { id: string; digest: string; files: number }[] {
  if (!existsSync(DEFAULT_SNAPSHOT_ROOT)) return []
  const found: { id: string; digest: string; files: number }[] = []
  for (const name of readdirSync(DEFAULT_SNAPSHOT_ROOT)) {
    if (!name.startsWith('pglite-') || !name.endsWith('.manifest.json')) continue
    try {
      const parsed = JSON.parse(readFileSync(join(DEFAULT_SNAPSHOT_ROOT, name), 'utf8')) as Record<string, unknown>
      if (typeof parsed.snapshotId === 'string' && typeof parsed.nonVolatileTreeSha256 === 'string') {
        found.push({
          id: parsed.snapshotId,
          digest: parsed.nonVolatileTreeSha256,
          files: Number(parsed.fileCount ?? 0),
        })
      }
    } catch {
      /* 坏 manifest 不算 verified */
    }
  }
  return found.sort((a, b) => a.id.localeCompare(b.id))
}

function postmasterStamp(): string {
  const path = join(REAL_DB, 'postmaster.pid')
  if (!existsSync(path)) return 'MISSING'
  const stat = statSync(path)
  return `${stat.size}:${stat.mtimeMs}`
}

const before = digestTree(REAL_DB)
const snapshotsBefore = verifiedSnapshots()
const postmasterBefore = postmasterStamp()

console.log('首次真实快照前：')
console.log(`  真实库     : ${REAL_DB}`)
console.log(`  文件 / 字节: ${before.measuredCount} / ${before.totalBytes}`)
console.log(`  非易失摘要 : ${before.treeSha256}`)
console.log(`  postmaster : ${postmasterBefore}`)
console.log(`  已有快照   : ${snapshotsBefore.length} 份`)
for (const snapshot of snapshotsBefore) {
  console.log(`    · ${snapshot.id}（${snapshot.files} 文件 · ${snapshot.digest.slice(0, 16)}…）`)
}

if (process.argv.includes('--list')) {
  console.log('\n（--list：没有执行快照。）')
  process.exit(0)
}

console.log('\n执行：' + COMMAND + '\n' + '─'.repeat(80))
const child = spawnSync(COMMAND, {
  cwd: ROOT,
  stdio: 'inherit',
  shell: true,
  timeout: 3_600_000,
  env: process.env,
})
const exitCode = child.status ?? -1
console.log('─'.repeat(80))

const after = digestTree(REAL_DB)
const snapshotsAfter = verifiedSnapshots()
const postmasterAfter = postmasterStamp()

const addedSnapshots = snapshotsAfter.filter((item) => !snapshotsBefore.some((old) => old.id === item.id))
const removedSnapshots = snapshotsBefore.filter((item) => !snapshotsAfter.some((now) => now.id === item.id))
const newSnapshot = addedSnapshots[0]
const newManifestPath = newSnapshot === undefined ? undefined : join(DEFAULT_SNAPSHOT_ROOT, `pglite-${newSnapshot.id}.manifest.json`)

const problems: string[] = []
if (exitCode !== 0) problems.push(`${COMMAND} 退出码 ${exitCode}`)
if (before.treeSha256 !== after.treeSha256) problems.push('真实库摘要前后不一致（快照应当是只读的）')
if (before.measuredCount === 0 || after.measuredCount === 0) problems.push('measured_count = 0 ⇒ MEASUREMENT INVALID')
if (addedSnapshots.length !== 1) problems.push(`新增快照数 ${addedSnapshots.length}（期望 1）`)
if (removedSnapshots.length !== 0) {
  problems.push(`**删掉了 ${removedSnapshots.length} 份旧快照**（本次刻意用 --keep ${KEEP_WITHOUT_DELETION} 以免未授权删除）`)
}
if (newSnapshot !== undefined && newSnapshot.digest !== before.treeSha256) {
  problems.push(`新快照的源摘要 ${newSnapshot.digest.slice(0, 16)}… != 快照前的真实库摘要 ${before.treeSha256.slice(0, 16)}…`)
}
if (newSnapshot !== undefined && !existsSync(join(DEFAULT_SNAPSHOT_ROOT, `pglite-${newSnapshot.id}`))) {
  problems.push('新快照的目录不存在（只有 manifest）')
}
if (newManifestPath !== undefined && !existsSync(newManifestPath)) problems.push('新快照的 manifest 不存在')
if (postmasterBefore !== postmasterAfter) {
  problems.push(`易失文件 postmaster.pid 被动过（${postmasterBefore} → ${postmasterAfter}）⇒ 说明有东西**打开了**真实库`)
}

const verdict = problems.length === 0 ? 'PASS' : 'FAIL'

mkdirSync(ART, { recursive: true })
writeFileSync(
  join(ART, 'first-real-snapshot.json'),
  `${JSON.stringify(
    {
      incident: 'INC-01',
      wp: 'WP6',
      gate: 'G9 Real Source Safety',
      generatedAt: new Date().toISOString(),
      head: spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(),
      verdict,
      command: COMMAND,
      keepUsed: Number(KEEP_WITHOUT_DELETION),
      keepReason:
        '计划书 §6.10 把"删除旧快照"列为需要单独授权的动作，而 db:snapshot 的缺省 keep=3 会剪掉旧快照 ⇒ 本次刻意放宽到 30，零删除。',
      exitCode,
      realDb: {
        path: REAL_DB.replace(/\\/g, '/'),
        filesBefore: before.measuredCount,
        bytesBefore: before.totalBytes,
        digestBefore: before.treeSha256,
        filesAfter: after.measuredCount,
        bytesAfter: after.totalBytes,
        digestAfter: after.treeSha256,
        unchanged: before.treeSha256 === after.treeSha256,
        postmasterPidBefore: postmasterBefore,
        postmasterPidAfter: postmasterAfter,
      },
      newSnapshot: newSnapshot ?? null,
      snapshotsBefore,
      snapshotsAfter,
      orphanManifestsBefore: orphanSnapshotManifests().length,
      prunedByRetention: removedSnapshots,
      problems,
      scope: {
        openedRealDatabase: false,
        healthProbeOnDisposableCopyOnly: true,
        ranOnce: true,
        note: '只运行一次 `pnpm db:snapshot`；本脚本自己不做删除、不做重试。',
      },
    },
    null,
    2
  )}\n`,
  'utf8'
)

console.log('\n首次真实快照后：')
console.log(`  文件 / 字节: ${after.measuredCount} / ${after.totalBytes}`)
console.log(`  非易失摘要 : ${after.treeSha256}`)
console.log(`  前后一致   : ${before.treeSha256 === after.treeSha256 ? '是' : '**否**'}`)
console.log(`  新快照     : ${newSnapshot === undefined ? '（没有）' : `${newSnapshot.id}（${newSnapshot.files} 文件）`}`)
console.log(`  保留策略剪掉: ${removedSnapshots.length === 0 ? '（无）' : removedSnapshots.map((s) => s.id).join(', ')}`)
console.log(`\nG9 首次真实快照：${verdict}${problems.length === 0 ? '' : `\n  ${problems.join('\n  ')}`}`)
console.log('证据：artifacts/incidents/inc-01/first-real-snapshot.json')
process.exitCode = verdict === 'PASS' ? 0 : 1
