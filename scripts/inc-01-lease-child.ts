/**
 * INC-01 WP1 测试用的**持锁子进程**（不是生产入口，不打开任何数据库）。
 *
 * 用法：
 *   node_modules\.bin\tsx scripts/inc-01-lease-child.ts hold <dataDir> [ownerRecordDir]
 *   node_modules\.bin\tsx scripts/inc-01-lease-child.ts try  <dataDir> [ownerRecordDir]
 *
 * 单行协议（stdout）：
 *   `ACQUIRED <pid> <pipe>`            —— 成功取得租约（hold 模式会保持存活）
 *   `REJECTED <code> [message]`        —— 失败关闭（第二个进程必须走这条）
 *
 * 退出码：0 = ACQUIRED 后正常收尾；3 = production_db_in_use；4 = 其它租约错误；2 = 用法错误。
 * `hold` 模式下收到 IPC `shutdown` / SIGINT / SIGTERM 会做 **clean release**；
 * 被 `taskkill /F` 强杀则不会 —— 这正是"强杀释放由 OS 完成"那条测试要观察的。
 */
import { acquireProductionLease, ProductionDbInUseError } from '../src/infrastructure/persistence/production-db-safety.ts'

const mode = process.argv[2]
const dataDir = process.argv[3]
const ownerRecordDir = process.argv[4]

if ((mode !== 'hold' && mode !== 'try') || dataDir === undefined) {
  console.error('usage: inc-01-lease-child.ts <hold|try> <dataDir> [ownerRecordDir]')
  process.exitCode = 2
} else {
  try {
    const lease = await acquireProductionLease({
      dataDir,
      operationKind: 'manual_snapshot',
      ...(ownerRecordDir !== undefined ? { ownerRecordDir } : {}),
    })
    console.log(`ACQUIRED ${process.pid} ${lease.pipeName}`)

    if (mode === 'try') {
      await lease.release({ cleanClose: true })
      process.exitCode = 0
    } else {
      const shutdown = async (): Promise<void> => {
        await lease.release({ cleanClose: true })
        process.exitCode = 0
      }
      process.on('SIGINT', () => void shutdown())
      process.on('SIGTERM', () => void shutdown())
      process.on('message', () => void shutdown())
      // 保持存活；不主动退出（由测试决定何时结束）
      setInterval(() => undefined, 1000)
    }
  } catch (error) {
    if (error instanceof ProductionDbInUseError) {
      console.log(`REJECTED ${error.code}`)
      process.exitCode = 3
    } else {
      const code = (error as { code?: string }).code ?? 'error'
      console.log(`REJECTED ${code} ${error instanceof Error ? error.message : String(error)}`)
      process.exitCode = 4
    }
  }
}
