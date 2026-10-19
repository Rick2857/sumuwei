/**
 * E 测试的「写入进程」：把状态写进沙箱库，然后退出。
 *
 * 与 test-persist-read.ts 成对使用，模拟「系统重启」：
 * 两个**独立的操作系统进程**，通过同一个沙箱目录交换状态。
 *
 * ⚠️ 用固定 runId，保证两个进程指向同一个沙箱目录（默认按时间戳生成会各建一个）。
 *
 * 跑法（一般由 run-tests.ts 的 E 测试调用）：
 *   node_modules/.bin/tsx scripts/test-persist-write.ts
 */
import 'dotenv/config'

import { isolateDatabase } from '../src/dev/sandbox.ts'
// keep=true：读取进程要用同一目录，所以本进程退出时不能删
isolateDatabase('persist', { runId: process.env.PERSIST_RUN_ID ?? 'default', keep: true })

import { createThinHostRuntime } from '../src/infrastructure/runtime/thin-host-factory.ts'

import { character } from '../src/character/index.ts'
import { initDatabase } from '../src/db/index.ts'
import { initCharacterState } from '../src/state/init.ts'
import { loadState, setStateVariable } from '../src/state/repository.ts'

const characterId = character.id ?? character.name
const { stringToUuid } = await import('../src/kernel/contracts/uuid.ts')
const userId = stringToUuid(
  `user-${process.env.USER_NAME ?? 'Alex'}`
)

const runtime = createThinHostRuntime({ character, settings: {} })
await initDatabase(runtime)
await initCharacterState(runtime, characterId, userId)

// 写入一组易识别的值，与初始值明显不同
await setStateVariable(runtime, characterId, userId, 'trust', 0.27, 'E 测试：跨进程写入')
const after = await setStateVariable(
  runtime,
  characterId,
  userId,
  'closeness',
  0.44,
  'E 测试：跨进程写入'
)

const final = await loadState(runtime, characterId, userId)
console.log(`WRITTEN trust=${final.trust} closeness=${final.closeness} version=${final.version}`)
console.log(`# 沙箱库：${process.env.PGLITE_DATA_DIR}`)
console.log(`# 写入后 version=${after.after.version}`)

await runtime.stop()
process.exit(0)
