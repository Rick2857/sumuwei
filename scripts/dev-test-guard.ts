/**
 * 闸门自测（故意违规）：本脚本**不调用** isolateDatabase，
 * 因此 initDatabase 应当直接拒绝运行。
 *
 * 期望：抛错并提示实验必须隔离。
 * 跑法：node_modules/.bin/tsx scripts/dev-test-guard.ts
 */
import 'dotenv/config'

import { AgentRuntime } from '@elizaos/core'
import sqlPlugin from '@elizaos/plugin-sql'

import { character } from '../src/character/index.ts'
import { initDatabase } from '../src/db/index.ts'

// 模拟"忘了隔离"的脚本：直接指向真实库
process.env.PGLITE_DATA_DIR = './data/pglite'

const runtime = new AgentRuntime({ character, plugins: [] })

try {
  await initDatabase(runtime, sqlPlugin)
  console.log('❌ 闸门失效：本应拒绝，却成功连上了真实库')
  process.exit(1)
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e)
  if (msg.includes('拒绝写入真实对话库')) {
    console.log('✅ 闸门生效，已拒绝访问真实库。原始信息：')
    console.log(msg.split('\n').map((l) => '   ' + l).join('\n'))
    process.exit(0)
  }
  console.log('⚠️ 报了别的错（不算通过）：' + msg)
  process.exit(1)
}
