/**
 * M9 WP9 语料冻结前探针（一次性，不进门清单）。
 *
 * 目的：live 语料要冻结在**真实历史未占用**的槽位上（§15.3：探针清单
 * 事先冻结，不临时挑）。本探针把生产库**复制**到临时目录（真实库只做
 * 树摘要，从不打开——M8 live 同款纪律），在副本上跑一次信念双流追赶，
 * 然后列出：
 *   ① 全部 Memory（predicate/qualifier/value/status）——reported 语料的槽位来源；
 *   ② 追赶后形成的全部 Belief（slot/kind/value/status）——真实历史会占掉哪些键。
 *
 * 零模型调用；只写临时副本；结束打印真实库前后树摘要对照。
 */
import 'dotenv/config'

import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { PRODUCTION_DB_DIR, isProductionDir } from '../src/dev/sandbox.ts'
import { digestTree } from '../src/infrastructure/persistence/production-db-safety.ts'

const ROOT = resolve(import.meta.dirname, '..')

if (!existsSync(PRODUCTION_DB_DIR)) {
  console.error(`找不到真实库：${PRODUCTION_DB_DIR}`)
  process.exit(2)
}
const realDbBefore = digestTree(PRODUCTION_DB_DIR)

const work = mkdtempSync(join(tmpdir(), 'm9-live-probe-'))
const dbDir = join(work, 'pglite')
cpSync(PRODUCTION_DB_DIR, dbDir, { recursive: true })
if (isProductionDir(dbDir) || resolve(dbDir) === resolve(PRODUCTION_DB_DIR)) {
  throw new Error('拒绝：副本路径被判成生产库')
}
process.env.PGLITE_DATA_DIR = dbDir
process.env.PROJECT_LG_SANDBOX = dbDir
process.env.CHARACTER_BELIEF_ENABLED = 'true'

async function main(): Promise<void> {
  const { createThinHostRuntime } = await import('../src/infrastructure/runtime/thin-host-factory.ts')
  const { character } = await import('../src/character/index.ts')
  const { initDatabase } = await import('../src/db/index.ts')
  const { initKernel } = await import('../src/kernel/app/kernel.ts')
  const { characterDefinitionFromCharacter } = await import(
    '../src/infrastructure/runtime/seed-projection.ts'
  )
  const { maybeRunBeliefEvaluation, maybeRunBeliefMemoryReconciliation } = await import(
    '../src/infrastructure/runtime/belief-scheduler.ts'
  )
  const { createNativeMemoryStore } = await import(
    '../src/infrastructure/persistence/memory-store.ts'
  )
  const { listBeliefsByStatus, getBeliefOrigin } = await import(
    '../src/infrastructure/persistence/belief-store.ts'
  )
  const { entityRef } = await import('../src/kernel/contracts/index.ts')
  const { resolveIds } = await import('../src/main.ts')

  const runtime = createThinHostRuntime({ character, settings: {} })
  await initDatabase(runtime)
  await runtime.initialize()
  const kernel = await initKernel(runtime, {
    definition: characterDefinitionFromCharacter(character),
  })
  const db = kernel.stores.db
  const cid = kernel.characterId
  const userName = process.env.USER_NAME ?? 'Alex'
  const { userId } = resolveIds(userName)

  /* ① Memory 全量（owner = character；只看槽位形状） */
  const store = createNativeMemoryStore(db)
  const owner = entityRef('character', String(cid))
  const memories = await store.list({ owner, limit: 2000 })
  console.log(`\n=== Memory 全量：${String(memories.length)} 条（user=${userName}） ===`)
  for (const m of memories) {
    if (m.content.kind === 'claim') {
      const q = m.content.qualifiers ? ` @${JSON.stringify(m.content.qualifiers)}` : ''
      console.log(
        `  [${m.status}] ${m.content.subject.kind}:${String(m.content.subject.id)} ` +
          `${m.content.predicate}${q} = ${String(m.content.value)} (${m.type}/${String(m.authority)})`,
      )
    } else {
      console.log(`  [${m.status}] (episode) ${m.content.summary.slice(0, 40)}…`)
    }
  }

  /* ② 信念双流追赶（副本上；真实历史的重放结果） */
  const scheduling = await maybeRunBeliefEvaluation(db, {
    characterId: cid,
    activeUserId: userId,
    activationId: 'probe-catchup',
  })
  console.log(`\n=== 交互流追赶：${scheduling.kind} ===`)
  let memoryScheduling = await maybeRunBeliefMemoryReconciliation(db, { characterId: cid })
  console.log(`=== Memory 流追赶：${memoryScheduling.kind} ===`)
  let guard = 0
  while (memoryScheduling.kind === 'flushed' && guard < 50) {
    memoryScheduling = await maybeRunBeliefMemoryReconciliation(db, { characterId: cid })
    guard++
  }
  console.log(`（Memory 流翻页 ${String(guard)} 次至收敛：${memoryScheduling.kind}）`)

  const origin = await getBeliefOrigin(db, cid)
  console.log(
    `origin: ${origin === undefined ? '无' : `cutover=${String(origin.state.cutoverSequence)}`}`,
  )
  const active = await listBeliefsByStatus(db, cid, ['active', 'disputed'])
  console.log(`\n=== 追赶后 active/disputed 信念：${String(active.length)} 条 ===`)
  for (const b of active) {
    console.log(
      `  [${String(b.status)}] ${b.proposition.predicate} @${b.proposition.scopeKey} = ` +
        `${String(b.proposition.value)} (${String(b.epistemicKind)}; ` +
        `roots=${String(b.evidenceRootIds.length)}; memDeps=${String(b.dependsOnMemoryIds.length)})`,
    )
  }

  const realDbAfter = digestTree(PRODUCTION_DB_DIR)
  const untouched =
    realDbBefore.treeSha256 === realDbAfter.treeSha256 &&
    realDbBefore.measuredCount === realDbAfter.measuredCount
  console.log(
    `\n真实库树摘要：前 ${realDbBefore.treeSha256.slice(0, 16)}…(${String(realDbBefore.measuredCount)} 文件) / ` +
      `后 ${realDbAfter.treeSha256.slice(0, 16)}…(${String(realDbAfter.measuredCount)} 文件) ⇒ ` +
      `${untouched ? '✅ 逐字相同（未碰）' : '❌ 不一致'}`,
  )
  rmSync(work, { recursive: true, force: true })
  process.exit(untouched ? 0 : 3)
}

await main()
