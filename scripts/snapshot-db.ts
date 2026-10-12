/**
 * INC-01 **手动快照入口**（`AT2.5`）—— 与隔离门**共用同一个实现**（`production-db-safety.ts`），
 * 不另写一套复制逻辑。
 *
 * 用法：
 *   node_modules\.bin\tsx scripts/snapshot-db.ts --help
 *   node_modules\.bin\tsx scripts/snapshot-db.ts --dry-run
 *   node_modules\.bin\tsx scripts/snapshot-db.ts [--data-dir data/pglite] [--keep 3]
 *
 * 纪律（对应计划 `INC01-D2`/`D3`/`D4`）：
 *   · 必须先取得该 dataDir 的**跨进程独占租约**；拿不到立即失败（不等待、不覆盖）；
 *   · 只**读**源；健康验证只打开 `%TEMP%` 里的一次性副本；
 *   · manifest 写在快照目录**之外**（写进去会改变快照自身摘要）；
 *   · 输出只含 snapshot ID / 文件数 / 总字节 / 摘要前缀 / schema 版本 / PASS-FAIL，
 *     **不含任何库内容**。
 *
 * ⚠️ `--dry-run` 也不写任何文件：它只取租约、算源摘要、预告将要发生什么。
 *    （取租约本身会写 owner record —— 那是取证，不是数据。）
 */
import { join, resolve } from 'node:path'

import {
  acquireProductionLease,
  createVerifiedSnapshot,
  digestTree,
} from '../src/infrastructure/persistence/production-db-safety.ts'

const argv = process.argv.slice(2)

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(
    [
      'INC-01 手动快照（真实库）：',
      '  --data-dir <path>   源目录（缺省 data/pglite）',
      '  --snapshot-root <path>  快照根（缺省 data/snapshots）',
      '  --keep <n>          保留份数（缺省 3；不足 n 份不清理）',
      '  --dry-run           只取租约 + 算摘要 + 预告，不写快照',
      '',
      '退出码：0 = PASS；非 0 = 失败关闭（拿不到租约 / 源变化 / 副本校验失败 / 健康验证失败）。',
    ].join('\n')
  )
  process.exitCode = 0
} else {
  const flag = (name: string): string | undefined => {
    const index = argv.indexOf(name)
    return index >= 0 ? argv[index + 1] : undefined
  }
  const dataDir = resolve(flag('--data-dir') ?? 'data/pglite')
  const snapshotRoot = resolve(flag('--snapshot-root') ?? join('data', 'snapshots'))
  const keepRaw = Number(flag('--keep') ?? '3')
  const keep = Number.isSafeInteger(keepRaw) && keepRaw >= 1 ? keepRaw : 3
  const dryRun = argv.includes('--dry-run')

  let lease
  try {
    lease = await acquireProductionLease({ dataDir, operationKind: 'manual_snapshot' })
  } catch (error) {
    console.error(
      `FAIL 无法取得独占租约：${(error as { code?: string }).code ?? 'error'} ${error instanceof Error ? error.message : String(error)}`
    )
    process.exitCode = 1
  }

  if (lease !== undefined) {
    try {
      if (dryRun) {
        const digest = digestTree(dataDir)
        console.log(
          [
            'DRY RUN（未写任何快照）',
            `  source            : ${dataDir}`,
            `  snapshot root     : ${snapshotRoot}`,
            `  keep              : ${keep}`,
            `  measuredCount     : ${digest.measuredCount}`,
            `  totalBytes        : ${digest.totalBytes}`,
            `  digest prefix     : ${digest.treeSha256.slice(0, 12)}`,
            `  excludedPaths     : ${JSON.stringify(digest.excludedPaths)}`,
          ].join('\n')
        )
        process.exitCode = 0
      } else {
        const result = await createVerifiedSnapshot({
          sourceDir: dataDir,
          snapshotRoot,
          lease,
          keep,
        })
        if (result.ok && result.manifest !== undefined) {
          console.log(
            [
              'PASS',
              `  snapshotId        : ${result.snapshotId}`,
              `  files             : ${result.manifest.fileCount}`,
              `  totalBytes        : ${result.manifest.totalBytes}`,
              `  digest prefix     : ${result.manifest.nonVolatileTreeSha256.slice(0, 12)}`,
              `  schemaVersion(s)  : ${JSON.stringify(result.manifest.schemaVersions)}`,
              `  pruned            : ${JSON.stringify(result.prunedSnapshots ?? [])}`,
            ].join('\n')
          )
          process.exitCode = 0
        } else {
          console.error(`FAIL ${String(result.failure)} :: ${String(result.detail)}`)
          process.exitCode = 1
        }
      }
    } finally {
      await lease.release({ cleanClose: process.exitCode === 0 })
    }
  }
}
