/**
 * 只读逻辑快照：她的**业务数据**有没有变化。
 *
 * 为什么不用文件指纹？
 *   pglite 每次打开数据库都会改动内部文件（postmaster.pid、WAL、内部统计），
 *   即使一个业务数据都没写，文件指纹也会变。因此判断"是否被影响"必须看
 *   **逻辑数据**：状态行的四个值 + version、消息条数、状态事件条数。
 *
 * 绝不写任何数据（只有 SELECT）。
 * 跑法：node_modules/.bin/tsx scripts/snapshot-state.ts            # 打印
 *       node_modules/.bin/tsx scripts/snapshot-state.ts --save    # 写入 data/snapshot.json
 *       node_modules/.bin/tsx scripts/snapshot-state.ts --diff data/snapshot.json  # 与快照比对
 */
import 'dotenv/config'

import { readFileSync, writeFileSync } from 'node:fs'

import { AgentRuntime, stringToUuid } from '@elizaos/core'
import sqlPlugin from '@elizaos/plugin-sql'
import { sql } from 'drizzle-orm'

import { character } from '../src/character/index.ts'
import { allowProductionDatabase, initDatabase } from '../src/db/index.ts'
import { isProductionDir } from '../src/dev/sandbox.ts'
import {
  lastVerifiedSnapshotId,
  prepareProductionOpen,
  productionDataDirOf,
  productionSnapshotRootOf,
  type ProductionOpenHandle,
} from '../src/infrastructure/persistence/production-open-guard.ts'
import {
  closeDatabaseConnection,
  createRuntimeShutdown,
  isDatabaseClosed,
  stopRuntimeServices,
} from '../src/infrastructure/persistence/runtime-shutdown.ts'

// 只读快照：显式放行到真实库，但全程只有 SELECT
allowProductionDatabase()

export interface StateSnapshot {
  takenAt: string
  state: {
    valence: number
    arousal: number
    trust: number
    closeness: number
    version: number
    lastInteractionAt: number
  } | null
  memoryCount: number
  messageCount: number
  stateEventCount: number
}

export async function takeSnapshot(): Promise<StateSnapshot> {
  const runtime = new AgentRuntime({ character, plugins: [] })

  /*
   * INC-01 WP6：本脚本也是**真实库 opener** —— 因此它必须和生产路径走同一条状态机
   * （租约 → pre-open verified snapshot → 拿 token → 打开）。
   * 不是真实库目录（副本 / 沙箱）时不走状态机。
   */
  const dataDir = productionDataDirOf()
  const snapshotRoot = productionSnapshotRootOf()
  const guarded = process.env.PROJECT_LG_SANDBOX === undefined && isProductionDir(dataDir)
  let handle: ProductionOpenHandle | undefined

  if (guarded) {
    handle = await prepareProductionOpen({
      dataDir,
      snapshotRoot,
      operationKind: 'state_snapshot',
      deps: {
        openDatabase: async () => {
          await initDatabase(runtime, sqlPlugin)
        },
        stopServices: () => stopRuntimeServices(runtime),
        closeDatabase: async () => await closeDatabaseConnection(runtime),
        isDatabaseClosed: () => isDatabaseClosed(runtime),
        lastVerifiedSnapshotId: () => lastVerifiedSnapshotId(snapshotRoot),
      },
    })
    await handle.open()
  } else {
    await initDatabase(runtime, sqlPlugin)
  }

  const holder = runtime as unknown as {
    adapter?: { db?: { execute: (q: unknown) => Promise<unknown> } }
  }
  const db = holder.adapter?.db
  if (!db) throw new Error('拿不到数据库句柄')

  const rowsOf = (r: unknown) =>
    (((r as { rows?: unknown[] })?.rows ?? r) as Record<string, unknown>[]) ?? []

  const characterId = character.id ?? character.name
  const userId = stringToUuid(`user-${process.env.USER_NAME ?? 'Alex'}`)

  const s = rowsOf(
    await db.execute(
      sql`select valence, arousal, trust, closeness, version, last_interaction_at
          from character_states where character_id = ${characterId} and user_id = ${userId}`
    )
  )[0]

  const memoryCount = Number(
    rowsOf(await db.execute(sql`select count(*)::int as c from memories`))[0]?.c ?? 0
  )
  const messageCount = Number(
    rowsOf(
      await db.execute(sql`select count(*)::int as c from memories where type = 'messages'`)
    )[0]?.c ?? 0
  )
  const stateEventCount = Number(
    rowsOf(await db.execute(sql`select count(*)::int as c from state_events`))[0]?.c ?? 0
  )

  /*
   * INC-01 WP3（`AT3.5`）：**不再只 `stop()`** —— 那条路径不关数据库连接
   * （事故的第三个缺口）。这里走唯一的收尾句柄：`stop → close → closed check`。
   * 之后脚本才 `process.exit(0)`，因此退出**不会越过关闭**。
   *
   * INC-01 WP6：关闭之后由状态机做 post-close verified snapshot 并释放租约。
   */
  await createRuntimeShutdown(runtime, {
    afterRun: async (reading) => {
      if (handle === undefined) return
      await handle.finish({ closed: reading.closed, detail: reading.note, afterClose: true })
    },
  }).shutdown()

  return {
    takenAt: new Date().toISOString(),
    state: s
      ? {
          valence: Number(s.valence),
          arousal: Number(s.arousal),
          trust: Number(s.trust),
          closeness: Number(s.closeness),
          version: Number(s.version),
          lastInteractionAt: Number(s.last_interaction_at),
        }
      : null,
    memoryCount,
    messageCount,
    stateEventCount,
  }
}

/** 两个快照是否一致（业务数据层面） */
export function sameSnapshot(a: StateSnapshot, b: StateSnapshot): boolean {
  return JSON.stringify({ ...a, takenAt: '' }) === JSON.stringify({ ...b, takenAt: '' })
}

function render(s: StateSnapshot): string {
  const st = s.state
  return [
    `  状态: ${st ? `valence=${st.valence} arousal=${st.arousal} trust=${st.trust} closeness=${st.closeness} v${st.version}` : '(无状态行)'}`,
    `  最后互动: ${st ? new Date(st.lastInteractionAt).toLocaleString('zh-CN', { hour12: false }) : '-'}`,
    `  memories 行数: ${s.memoryCount}（其中 messages ${s.messageCount}）`,
    `  state_events 行数: ${s.stateEventCount}`,
  ].join('\n')
}

// --- CLI ---
const args = process.argv.slice(2)
const snapshot = await takeSnapshot()

if (args.includes('--save')) {
  const path = 'data/snapshot.json'
  writeFileSync(path, JSON.stringify(snapshot, null, 2), 'utf8')
  console.log(`快照已保存到 ${path}`)
  console.log(render(snapshot))
} else if (args.includes('--diff')) {
  const refPath = args[args.indexOf('--diff') + 1] ?? 'data/snapshot.json'
  const ref = JSON.parse(readFileSync(refPath, 'utf8')) as StateSnapshot
  console.log(`与 ${refPath} 比对：`)
  console.log('  参照快照：')
  console.log(render(ref))
  console.log('  当前：')
  console.log(render(snapshot))
  console.log(
    `\n  结论：${sameSnapshot(ref, snapshot) ? '✅ 业务数据完全一致' : '❌ 业务数据已变化'}`
  )
} else {
  console.log(render(snapshot))
}

process.exit(0)
