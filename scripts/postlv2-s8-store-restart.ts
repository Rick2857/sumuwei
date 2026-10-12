/**
 * S8 · WP2 —— **真实进程重启**的账本读回端（`pnpm postlv2:s8:store:verify` 的子进程）。
 *
 * ============================================================================
 *  它为什么必须是一个**独立进程**
 * ============================================================================
 * 计划书 WP2 的退出条件逐字写着"**关闭进程后**重新打开隔离库，提交、可见观测、
 * revision 和折叠状态逐项对账"。同一个进程里重连（`resetPluginSqlConnection`）
 * 证明不了这件事：进程级单例、内存缓存都还在。
 * 因此本文件是**另一个进程**：它只做一件事 —— 打开**同一个隔离目录**，把账本读回来，
 * 把对账读数写进指定文件，然后退出。
 *
 * ⚠️ 它**不碰 `storyline_*` 两张表**：只 `select`。父进程会在调用前后各数一次行数，
 *    "重启读回没有写账本"这句话由父进程核对，不由本文件的自我声明保证。
 * ⚠️ 它**不碰真实库**：目录由父进程经 `--run-id` 传入，`isolateDatabase` 会拒绝
 *    任何与 `data/pglite` 重叠的路径。
 *
 * 用法（父进程调用）：
 *   tsx scripts/postlv2-s8-store-restart.ts --run-id <id> --out <path>
 */

import { writeFileSync } from 'node:fs'
import { argv } from 'node:process'

import { isolateDatabase } from '../src/dev/sandbox.ts'

function argOf(name: string): string {
  const index = argv.indexOf(`--${name}`)
  if (index < 0 || argv[index + 1] === undefined) {
    throw new Error(`缺少必需参数 --${name}`)
  }
  return argv[index + 1]!
}

const runId = argOf('run-id')
const outPath = argOf('out')

// ⚠️ 顺序关键：必须在任何会碰数据库的 import **之前**隔离（sandbox.ts 的说明）。
const sandbox = isolateDatabase('postlv2-s8-store', { runId, keep: true })

const { AgentRuntime } = await import('@elizaos/core')
const sqlPlugin = (await import('@elizaos/plugin-sql')).default
const { sql } = await import('drizzle-orm')
const { character } = await import('../src/character/index.ts')
const { initDatabase } = await import('../src/db/index.ts')
const { getRawDb, rowsOf } = await import('../src/infrastructure/persistence/db.ts')
const { createStoryLedgerStore } = await import(
  '../src/infrastructure/storyline/store/story-ledger-store.ts'
)
const { loadStoryRun, reconcileStoryRun } = await import(
  '../src/kernel/app/storyline/commit-service.ts'
)
const { JICHUANG_PACK } = await import('../evals/storyline/jichuang-interview-two/story-pack.ts')

const runtime = new AgentRuntime({
  character: character as never,
  plugins: [sqlPlugin] as never,
  settings: { OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? '' },
})
await initDatabase(runtime, sqlPlugin as never)

const db = getRawDb(runtime)
const ledger = createStoryLedgerStore(db)

const runs = await ledger.listRuns(JICHUANG_PACK.storyId)
const reconciliations: Record<string, unknown> = {}
for (const run of runs) {
  reconciliations[run] = await reconcileStoryRun({ ledger, pack: JICHUANG_PACK, runId: run })
}

const mainRun = await loadStoryRun({ ledger, pack: JICHUANG_PACK, runId: 's8-store-main' })

/** 账本行数（供父进程核对"重启读回没有写账本"） */
const countRows = async (table: string): Promise<number> => {
  const rows = rowsOf(
    await db.execute(sql.raw(`select count(*)::int as c from ${table}`))
  )
  return Number(rows[0]?.c ?? 0)
}

writeFileSync(
  outPath,
  JSON.stringify(
    {
      sandboxDir: sandbox.dir,
      pid: process.pid,
      runs,
      reconciliations,
      counts: {
        commits: await countRows('storyline_commits'),
        observations: await countRows('storyline_observations'),
      },
      mainRun: mainRun.ok
        ? {
            revision: mainRun.state.revision,
            currentNodeId: mainRun.state.currentNodeId,
            stage: mainRun.state.stage,
            variables: mainRun.state.variables,
            visibleEventIds: mainRun.state.visibleEventIds,
            terminal: mainRun.state.terminal,
            commitIds: mainRun.commits.map((commit) => commit.commitId),
            eventTypes: mainRun.commits.map((commit) => commit.eventType),
            bindings: mainRun.commits.map((commit) => commit.binding),
          }
        : { error: `${mainRun.code}: ${mainRun.detail}` },
    },
    null,
    2
  ),
  'utf8'
)

console.log(`[s8-store-restart] pid=${process.pid} 读回 run=${runs.length} 个 · 写出 ${outPath}`)
process.exit(0)
