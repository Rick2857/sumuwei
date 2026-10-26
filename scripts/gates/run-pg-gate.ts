/**
 * 用**一次性 PostgreSQL** 跑一道门（S-2，2026-10-20）
 *
 * ============================================================================
 *  为什么用它，而不是 `pnpm <gate>`
 * ============================================================================
 *  仓库的门用 `isolateDatabase()`，它只能隔离 PGlite 的目录；而后端是
 *  `postgres`（`.env` 里就是）时，**没给测试目标就失败关闭**。
 *  而 PGlite 自 M10 起也**不再是底座**（迁移 #10 的 `vector(384)` 需要 pgvector）。
 *
 *  ⇒ 唯一的门底座是**一次性 PostgreSQL**：`runPreparedPgGate` 会
 *    ① 起一个一次性容器（pgvector 镜像，`project-lg.test` 标签、独立卷、只绑 loopback）
 *    ② 建 `lg_test_<id>` 库 + 专用角色 + 装 vector/pgcrypto/fuzzystrmatch
 *    ③ **准备阶段显式应用 LG 迁移**（不是在启动期建表）
 *    ④ 在子进程里跑门体，并把测试库 URL 放进 `LG_TEST_PG_URL`
 *
 * ============================================================================
 *  用法
 * ============================================================================
 *  ```bash
 *  pnpm gates:pg --kernel:verify          # 按 pnpm 脚本名
 *  pnpm gates:pg --kernel:verify -- <额外参数…>
 *  ```
 *
 *  ⚠️ 只支持**单道门**（脚本必须是 `tsx scripts/<file>.ts` 形状）。
 *    整条链请用 `pnpm gates:pg-chain`。
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runPreparedPgGate, runPreparedPgGateInInstance } from '../postgresql/test-harness.ts'

const REPO = resolve(fileURLToPath(new URL('../../', import.meta.url)))

const args = process.argv.slice(2)
if (args.length === 0) {
  console.error('用法：pnpm gates:pg --<pnpm 脚本名>')
  console.error('例：  pnpm gates:pg --kernel:verify')
  process.exit(2)
}

const name = args[0].replace(/^--/, '')
const scripts = JSON.parse(readFileSync(resolve(REPO, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }
const command = scripts.scripts?.[name]
if (command === undefined) {
  console.error(`❌ package.json 里没有脚本 "${name}"`)
  process.exit(2)
}

// 只接受 `tsx scripts/<file>.ts`（或带 `&&` 的单条）—— 链请用 gates:pg-chain
const match = /^tsx\s+(scripts\/[A-Za-z0-9._\/-]+\.ts)$/.exec(command.trim())
if (match === null) {
  console.error(`❌ 脚本 "${name}" 不是单道门：${command}`)
  console.error('   单道门应是 `tsx scripts/<file>.ts`；整条链请用 pnpm gates:pg-chain')
  process.exit(2)
}
const script = match[1]!

console.log(`▸ 用一次性 PostgreSQL 跑：${name} → ${script}`)
console.log('  （一次性容器 + lg_test_ 库 + 准备阶段显式应用 LG 迁移）\n')

/*
 * ⚠️ **仿真内执行分支**（2026-10-21 · 认知能力建设计划 P0）
 *
 *   给定 `LG_SIM_PGTEST_ADMIN_URL` 时，门体改为跑在**仿真里的专用隔离实例**
 *   （compose 服务 `pgtest`）上，而不是"本机自己起一次性容器"。
 *   准备阶段的语义**完全相同**（`lg_test_` 库 + 显式迁移 + 身份核对）。
 *
 *   ⇒ 宿主模式（不给这个变量）逐字保留既有行为。
 */
const simAdminUrl = (process.env.LG_SIM_PGTEST_ADMIN_URL ?? '').trim()

/*
 * ⚠️ `runPreparedPgGate` 会把 **`process.argv.slice(2)` 原样转发**给门体。
 *    而本脚本自己的参数（`--kernel:verify`）不是门的参数：
 *    严格解析 argv 的门会直接炸（实测：`eval-m3.ts` 报
 *    "未知参数：--eval:m3"，看起来像门的故障，其实是**转发污染**）。
 *    ⇒ 调用前把 argv 清成"只有 node 与脚本路径"，结束后还原。
 *    （门体跑在**子进程**里，所以这里动 argv 不会影响本进程之后的逻辑。）
 */
const savedArgv = process.argv.slice(2)
process.argv = [process.argv[0]!, process.argv[1]!]
/*
 * ⚠️ 默认**放宽**门体超时到 600s：`runPreparedPgGate` 的默认是 120s，
 *    而 `m4.5:measurement:verify` 这类门在一次性容器上会超过它
 *    ⇒ 子进程被杀 ⇒ 报 `actual: null`，看起来像"断言失败"，其实是**超时**
 *    （实测踩过，2026-10-20）。调用方显式设了就用调用方的。
 */
process.env.LG_PG_GATE_TIMEOUT_MS ??= '600000'
try {
  const label = name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()
  if (simAdminUrl !== '') {
    console.log('  （仿真内执行：隔离实例 = 专用 pgtest 实例；门体跑在 simhost 里）\n')
    await runPreparedPgGateInInstance(simAdminUrl, label, script)
  } else {
    await runPreparedPgGate(label, script)
  }
} finally {
  process.argv = [process.argv[0]!, process.argv[1]!, ...savedArgv]
}
console.log(`\n✅ ${name} 在一次性 PostgreSQL 上通过`)
