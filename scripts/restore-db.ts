/**
 * INC-01 **恢复入口**（`AT5.1`）—— **默认 dry-run**，`--apply` 需要当轮授权。
 *
 * 用法：
 *   node_modules\.bin\tsx scripts/restore-db.ts --help
 *   node_modules\.bin\tsx scripts/restore-db.ts --from <snapshot-id>
 *   node_modules\.bin\tsx scripts/restore-db.ts --from <snapshot-id> --data-dir data/pglite
 *   node_modules\.bin\tsx scripts/restore-db.ts --from <snapshot-id> --apply      # 需要授权
 *
 * 三条纪律（对应计划书 §WP5）：
 *   · **只认 snapshot ID**：`--from` 不接受任何路径（形状校验先于文件系统访问）；
 *   · dry-run 是**默认**：它只做只读校验 + 把将发生的原子改名打出来，
 *     健康探针跑在 `%TEMP%` 的一次性副本上，**快照本体永不被打开**；
 *   · **真实库上的 `--apply` 需要当轮授权**：
 *       PROJECT_LG_ALLOW_RESTORE_APPLY='<snapshotId>@<解析后的 dataDir>'
 *     布尔式开关不算授权（它挡不住"授权了别的库 / 别的快照"）。
 *
 * 退出码：0 = 成功（dry-run 校验通过 / apply 完成）；1 = 失败关闭（任何一条不通过）。
 */
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

import {
  applyRestore,
  planRestore,
  renderRestoreReading,
  writeRestoreRecord,
} from '../src/infrastructure/persistence/production-db-restore.ts'

const argv = process.argv.slice(2)

function flag(name: string): string | undefined {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}

if (argv.includes('--help') || argv.includes('-h') || argv.length === 0) {
  console.log(
    [
      'INC-01 恢复工具（默认 dry-run）：',
      '  --from <snapshot-id>      必填。**只接受快照 ID**（形如 2026-09-21T02-54-51-322Z-be957694b8a1）',
      '  --data-dir <path>         要恢复的目标库（缺省 data/pglite）',
      '  --snapshot-root <path>    快照根（缺省 data/snapshots）',
      '  --apply                   真的执行（staging → quarantine → 原子切换）',
      '',
      'dry-run 会做：ID 形状 → 快照目录 + manifest → 内容摘要 == manifest → 租约 → 目标路径 →',
      '             健康探针（**在 %TEMP% 副本上**）→ 打印将发生的原子改名。',
      '',
      'apply 额外要求（仅当目标是真实库）：',
      "  PROJECT_LG_ALLOW_RESTORE_APPLY='<snapshotId>@<解析后的 dataDir>'",
      '',
      '退出码：0 = PASS；1 = 失败关闭（现场一律保留，绝不原地覆盖、绝不代删）。',
    ].join('\n')
  )
  process.exitCode = 0
} else {
  const snapshotId = flag('--from')
  const dataDir = resolve(flag('--data-dir') ?? join('data', 'pglite'))
  const snapshotRoot = resolve(flag('--snapshot-root') ?? join('data', 'snapshots'))
  const apply = argv.includes('--apply')

  if (snapshotId === undefined) {
    console.error('FAIL --from <snapshot-id> 是必填项（只接受 ID，不接受路径）。')
    process.exitCode = 1
  } else {
    const plan = await planRestore({ snapshotRoot, snapshotId, dataDir })
    console.log(renderRestoreReading(plan))

    if (!plan.ok) {
      process.exitCode = 1
    } else if (!apply) {
      console.log('\n（dry-run：没有改动任何东西。要真的执行请加 --apply，并按需设置授权串。）')
      process.exitCode = 0
    } else {
      const result = await applyRestore(plan, {
        authorization: process.env.PROJECT_LG_ALLOW_RESTORE_APPLY,
      })
      console.log(`\n${renderRestoreReading(result)}`)

      /*
       * 取证：恢复记录写在 quarantine **旁边**（不写进任何被摘要的目录里）。
       */
      if (result.quarantinePath !== undefined && existsSync(result.quarantinePath)) {
        const recordPath = `${result.quarantinePath}.restore-record.json`
        writeRestoreRecord(result, recordPath)
        console.log(`  记录       : ${recordPath}`)
      }
      process.exitCode = result.ok ? 0 : 1
    }
  }
}
