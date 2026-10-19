/**
 * E 测试的「读取进程」：**全新的操作系统进程**，从同一个沙箱库读回状态。
 *
 * 它必须看到写入进程留下的值，才能证明状态跨进程存活
 * （也就是用户说的「重启系统后 State 不丢」）。
 *
 * ⚠️ 用与写入进程相同的 runId，否则会指向另一个空沙箱。
 *
 * 跑法（一般由 run-tests.ts 的 E 测试调用）：
 *   node_modules/.bin/tsx scripts/test-persist-read.ts
 */
import { createThinHostRuntime } from '../src/infrastructure/runtime/thin-host-factory.ts'
import 'dotenv/config'

import { isolateDatabase } from '../src/dev/sandbox.ts'
// keep=true：本进程是验证链的最后一环，退出后目录由 run-tests.ts 统一清理
isolateDatabase('persist', { runId: process.env.PERSIST_RUN_ID ?? 'default', keep: true })

import { stringToUuid } from '../src/kernel/contracts/uuid.ts'



import { character } from '../src/character/index.ts'
import { initDatabase } from '../src/db/index.ts'
import { readStateIfExists } from '../src/state/repository.ts'

const characterId = character.id ?? character.name
const userId = stringToUuid(`user-${process.env.USER_NAME ?? 'Alex'}`)

const runtime = createThinHostRuntime({
    character: character,
    settings: {},
  })
await initDatabase(runtime)

// 关键：用 readStateIfExists 而不是 loadState。
// loadState 在查不到时会按初始值**建档**，那样"重启后状态还在"会假通过——
// 读到的其实是刚刚现建出来的默认值。
const state = await readStateIfExists(runtime, characterId, userId)

if (!state) {
  console.error('READ 失败：跨进程后找不到状态行（状态丢失）')
  await runtime.stop()
  process.exit(2)
}

console.log(`READ trust=${state.trust} closeness=${state.closeness} version=${state.version}`)
console.log(`# 沙箱库：${process.env.PGLITE_DATA_DIR}`)

await runtime.stop()
process.exit(0)
