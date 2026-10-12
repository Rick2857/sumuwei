/**
 * M4 强制终止（Hard Kill）验收（附件 M4-T22 / M4-T23；工程计划书第 143–148 节）。
 *
 * ============================================================================
 *  为什么这条**必须写明范围**（否则它会变成一条不可判定的测试）
 * ============================================================================
 * `verify-m4-restart.ts` 的头部已经把这件事讲清楚了：
 *
 *     ❌ 它**不**验证"进程被 kill -9 之后数据还在" —— 那是 PGlite / WAL 的
 *        持久化语义，不是 M4 的语义。混进来会让失败原因不可判定
 *        （是 M4 丢了记忆，还是嵌入库没 flush？）
 *
 * 本脚本**尊重**那条边界，因此把两件事**分开断言**，并明确各自归谁：
 *
 *   A. **库仍然可用**（归 PGlite/WAL）：被强杀之后，数据目录还能打开、
 *      schema 完整、事务没有留下半条状态。这一条失败 = 嵌入库层面的问题。
 *
 *   B. **M4 的一致性契约**（归 M4）：强杀**不可能**留下"投影与事件流不一致"。
 *      具体检查三件：
 *        · 每条 `memory_records` 都能从自己的事件流重放出相同状态（`A == B`）
 *        · 每条投影都有至少一条 `memory_events`（不存在"有投影没事件"）
 *        · **事件已提交但尚未折叠**的那条缝隙（附件 M4-T23 的故障注入形态）
 *          必须**可恢复**：对每个孤儿事件重新折叠必须成功，之后整体回到一致
 *
 *   B 的第 3 条是这条 Gate 真正有价值的部分。它诚实承认 M4 的写入是
 *   `appendDomainEvent`（一个事务）+ `applyMemoryEvent`（另一个事务）两步，
 *   因此**存在**一个"事件在、投影没有"的窗口；而 M4 的承诺是
 *   **那个窗口可以被重放/重试补上**，不是"窗口不存在"。
 *
 *   ⚠️ 如实记录：本脚本**不**断言"被强杀时正在写的那一条记忆一定还在"。
 *      它可能整个事务回滚掉（对话事件都没提交），那是允许的 ——
 *      M4 丢的不是"她记得的东西"，而是"那一轮还没提交的写入"。
 *
 * 跑法：pnpm m4:hardkill:verify
 */

import 'dotenv/config'

// ⚠️ 必须在任何会碰数据库的 import 之前（见 src/dev/sandbox.ts 的说明）
import {
  cleanupSandbox,
  isolateDatabase,
  isProductionDir,
  resetPluginSqlConnection,
} from '../src/dev/sandbox.ts'

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { sql } from 'drizzle-orm'

import {
  buildStandardCorpus,
  countsOf,
  createM4Harness,
  createReporter,
  M4_T0,
} from './m4-harness.ts'
import { rowsOf } from '../src/infrastructure/persistence/db.ts'
import { latestSchemaVersion } from '../src/infrastructure/persistence/migrations.ts'
import {
  recoverMemoryProjections,
  unfoldedMemoryEvents,
} from '../src/infrastructure/persistence/memory-recovery.ts'
import { memoryIdOfEvent } from '../src/kernel/projections/memory.ts'
import {
  contaminatedMemories,
  unsupportedMemories,
} from '../src/infrastructure/persistence/memory-store.ts'

// ---------------------------------------------------------------------------
// 子进程分支：写到手被砍掉为止
// ---------------------------------------------------------------------------
const phaseIndex = process.argv.indexOf('--phase')
const isChild = phaseIndex !== -1 && process.argv[phaseIndex + 1] === 'write'

if (isChild) {
  const dir = process.env.HARDKILL_DIR
  const marker = process.env.HARDKILL_MARKER
  if (dir === undefined || marker === undefined) {
    console.error('子进程缺少 HARDKILL_DIR / HARDKILL_MARKER')
    process.exit(2)
  }
  if (isProductionDir(dir)) {
    console.error(`拒绝在真实库上做强制终止实验：${dir}`)
    process.exit(2)
  }
  process.env.PGLITE_DATA_DIR = dir
  process.env.PROJECT_LG_SANDBOX = dir

  await resetPluginSqlConnection()
  const child = await createM4Harness({ label: 'hardkill-child' })
  // ① 先落一份**完整**的语料：被砍掉之前，库里已经有正确的数据
  await buildStandardCorpus(child)
  // ② 通知父进程"可以砍了"
  writeFileSync(marker, String(process.pid), 'utf8')
  // ③ 继续写，等着被强杀（这一步刻意不 sleep：让 kill 落在真实写入中间）
  let i = 0
  for (;;) {
    i += 1
    const evidence = await child.recordUserEvidence(`hardkill 持续写入第 ${i} 条`)
    await child.commitAndFold(
      child.makeCandidate(
        'preference',
        {
          kind: 'claim',
          subject: child.user,
          predicate: `hardkill.slot.${i}`,
          value: `v${i}`,
        } as never,
        { sourceRefs: [evidence.ref] }
      ),
      M4_T0 + i
    )
    if (i > 100_000) break
  }
}

// ---------------------------------------------------------------------------
// 父进程分支
// ---------------------------------------------------------------------------
const report = createReporter()
const sandbox = isolateDatabase('m4-hardkill', { keep: true })
const evidenceDir = join(process.cwd(), 'artifacts', 'm4-acceptance', 'hardkill')
const marker = join(sandbox.dir, '__hardkill-child-ready')
const moduleDir = process.cwd()

console.log('='.repeat(72))
console.log('M4 强制终止验收（Hard Kill）')
console.log('='.repeat(72))
console.log(`实验库：${sandbox.dir}`)

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// 用 `node <tsx-cli>` 直接起子进程 —— **不走 shell**。
// 走 shell 时（`shell: true` + tsx.cmd）拿到的是 cmd.exe 的 pid，
// `taskkill /F /PID` 杀掉的是 shell 而 node 子进程还活着 ——
// 那样"强制终止"根本没发生，而测试会显示通过。
const tsxCli = join(moduleDir, 'node_modules', 'tsx', 'dist', 'cli.mjs')
if (!existsSync(tsxCli)) {
  console.error(`找不到 tsx CLI：${tsxCli}`)
  process.exit(2)
}

const childProcess = spawn(
  process.execPath,
  [tsxCli, join(moduleDir, 'scripts', 'verify-m4-hardkill.ts'), '--phase', 'write'],
  {
    env: {
      ...process.env,
      HARDKILL_DIR: sandbox.dir,
      HARDKILL_MARKER: marker,
      PGLITE_DATA_DIR: sandbox.dir,
      PROJECT_LG_SANDBOX: sandbox.dir,
    },
    stdio: 'ignore',
    cwd: moduleDir,
  }
)

const childPid = childProcess.pid
console.log(`子进程 pid：${childPid}（持续写入，等待强杀）`)

report.section('1. 制造"写入进行中被强制终止"')
const deadline = Date.now() + 120_000
while (!existsSync(marker) && Date.now() < deadline) await sleep(150)
report.check('子进程已经完成初始语料并进入持续写入', existsSync(marker))
if (!existsSync(marker)) {
  childProcess.kill('SIGKILL')
  report.finish('M4 强制终止验收')
}

// 让它继续写一会儿，使 kill 更可能落在事务中间
await sleep(700)

const kill = spawnSync('taskkill', ['/PID', String(childPid), '/F'], { encoding: 'utf8' })
const childExit = await new Promise<number | null>((resolve) => {
  const timer = setTimeout(() => resolve(null), 15_000)
  childProcess.on('exit', (code) => {
    clearTimeout(timer)
    resolve(code)
  })
})
report.check(
  '强制终止命令执行成功（任务管理器语义：/F）',
  kill.status === 0 || kill.stdout.includes('成功') || kill.stdout.toLowerCase().includes('success'),
  String(kill.stdout ?? '').trim().split('\n')[0]
)
report.check('子进程确实已经退出（不是"以为杀掉了"）', childExit !== null, `exit=${String(childExit)}`)

// ---------------------------------------------------------------------------
// 2. 库仍然可用（PGlite / WAL 的账）
// ---------------------------------------------------------------------------
report.section('2. 库仍然可用（归 PGlite / WAL，不归 M4）')
await resetPluginSqlConnection()
const h = await createM4Harness({ label: 'hardkill-verify' })
const owner = h.owner

const schemaVersion = Number(
  rowsOf(
    await h.db.execute(sql`select coalesce(max(version),0) as v from character_schema_migrations`)
  )[0]?.v ?? 0
)
report.check('强杀之后数据库可以打开', Number.isFinite(schemaVersion))
/*
 * ⚠️ **2026-09-21 由 M6 WP6b 更正判据**（与 `verify-m4-real-db.ts` 里同一条更正同型）：
 * 这里原来硬编码 `schemaVersion === 5` —— 那是 M4 年代的读数。
 * 之后仓库又发布了 v6…v9（真实库已于 2026-09-19 迁到 v9），
 * 于是"== 5"在任何**新建的**隔离库上必然为假（隔离库会自动升到最新）。
 * 这条断言的**本意**是"迁移记录没被强杀写坏"，正确的形状是
 * **等于代码里的最新版本**，而不是等于某个历史常量。
 */
const latest = latestSchemaVersion()
report.check(
  `schema 版本 == 代码最新（v${latest}；迁移记录没被写坏）`,
  schemaVersion === latest,
  `v${schemaVersion}（latest=v${latest}）`
)

const counts = await countsOf(h.db, owner)
console.log(
  `  强杀之后的库：记忆 ${counts.memories}（active ${counts.active} / superseded ${counts.superseded} / ` +
    `retracted ${counts.retracted} / disputed ${counts.disputed}）｜对话事件 ${counts.conversationEvents}｜` +
    `MEMORY_* 事件 ${counts.domainEvents}`
)
report.check(
  '强杀之前的完整语料仍然在（事件 / 记忆都不是 0）',
  counts.conversationEvents > 0 && counts.memories > 0 && counts.domainEvents > 0
)

// ---------------------------------------------------------------------------
// 3. M4 的一致性契约
// ---------------------------------------------------------------------------
report.section('3. M4 的一致性契约（归 M4）')

// 3a. 每条投影都能从自己的事件流重放
const rebuild = await h.store.rebuildCharacterMemories(owner)
report.check(
  '每条记忆都能从自己的事件流重放得到相同状态（`A == B`）',
  rebuild.mismatched === 0,
  `重建 ${rebuild.rebuilt}/${rebuild.memories}，不一致 ${rebuild.mismatched}`
)
if (rebuild.mismatched > 0) {
  for (const detail of rebuild.details.filter((d) => !d.equal).slice(0, 5)) {
    console.log(`     · ${String(detail.memoryId)} 差异字段：${detail.differences.join(', ')}`)
  }
}

// 3b. 不存在"有投影、没事件"
const projectedWithoutEvents = Number(
  rowsOf(
    await h.db.execute(
      sql`select count(*)::int as c from memory_records r
          where not exists (select 1 from memory_events l where l.memory_id = r.id)`
    )
  )[0]?.c ?? -1
)
report.check(
  '不存在"有投影但没有事件"的记忆（无半条 revision）',
  projectedWithoutEvents === 0,
  `${projectedWithoutEvents} 条`
)

// 3c. 真实强杀留下的缺口：**如实报告条数**，不假装它一定 > 0
//
// ⚠️ 强杀落在哪两条语句之间是**时序相关**的：它可能正好落在
//    `appendDomainEvent` 与 `applyMemoryEvent` 之间（留下孤儿），
//    也可能落在两次提交之间（什么都不留）。
//    因此"孤儿数 > 0"是一条**会偶发变红**的断言 —— 不能写。
//    真正的恢复路径由下面 3d 的**确定性注入**来验。
const crashOrphans = await unfoldedMemoryEvents(h.db)
console.log(`  强杀留下的"已提交但未折叠"事件：${crashOrphans.length} 条（时序相关，非必然 > 0）`)

// 3d. **确定性**地注入一条"只提交、不折叠"的事件，验生产补折叠函数
//
// `h.emit()` 走真实放行口、写真实领域事件，但**刻意不折叠** ——
// 这正是崩溃窗口里那个中间状态。这样"该不该被补上"不依赖强杀落在哪里。
report.section('3d. 生产补折叠函数（memory-recovery）')
const injectedEvidence = await h.recordUserEvidence('（补折叠测试）注入一条只提交不折叠的事件')
const injectedEvents = await h.emit(
  h.makeCandidate(
    'preference',
    {
      kind: 'claim',
      subject: h.user,
      predicate: 'food.preference.cilantro',
      value: 'injected-orphan',
    } as never,
    { sourceRefs: [injectedEvidence.ref] }
  ),
  M4_T0 + 9000
)
const injectedEvent = injectedEvents[0]
const injectedMemoryId = memoryIdOfEvent(injectedEvent)!

const beforeRecovery = await h.store.get(injectedMemoryId)
report.check(
  '注入的领域事件确实**没有**投影（否则这个测试是空转）',
  beforeRecovery === null,
  String(injectedMemoryId)
)
const unfoldedBefore = await unfoldedMemoryEvents(h.db)
report.check(
  '探针能看到这条未折叠事件（缺口的可观测形态）',
  unfoldedBefore.some((e) => String(e.id) === String(injectedEvent.id)),
  `未折叠 ${unfoldedBefore.length} 条`
)

const recovery = await recoverMemoryProjections(h.db)
report.check(
  '生产补折叠函数把它补上了（失败 0，且扫到的都处理了）',
  recovery.failed === 0 &&
    recovery.refolded + recovery.alreadyReflected === recovery.scanned &&
    recovery.refolded >= 1,
  `扫描 ${recovery.scanned}：补折叠 ${recovery.refolded} / 仅补登记 ${recovery.alreadyReflected} / 失败 ${recovery.failed}`
)
const afterRecovery = await h.store.get(injectedMemoryId)
report.check(
  '补折叠之后投影真的存在，且状态正确',
  afterRecovery !== null && afterRecovery.status === 'active',
  `status=${String(afterRecovery?.status)}`
)
report.check(
  '补折叠**不改**重放判定（A == B 仍然成立）',
  (await h.store.rebuildCharacterMemories(owner)).mismatched === 0
)

// 负控：补折叠必须**幂等** —— 否则它会变成一个永远在报"有缺口"的东西
const recoveryAgain = await recoverMemoryProjections(h.db)
report.check(
  '负控：再扫一次是 0 条（幂等，不会重复折叠也不会永远报缺口）',
  recoveryAgain.scanned === 0 && recoveryAgain.refolded === 0,
  `扫描 ${recoveryAgain.scanned}`
)
report.check(
  '负控：探针在补折叠之后归零',
  (await unfoldedMemoryEvents(h.db)).length === 0
)

// 3e. 补折叠之后：不再有孤儿，且整体仍然一致
const orphansAfter = (await unfoldedMemoryEvents(h.db)).length
report.check('恢复之后不再有未折叠事件', orphansAfter === 0, `${orphansAfter} 条`)

const rebuildAfter = await h.store.rebuildCharacterMemories(owner)
report.check(
  '恢复之后整体仍然 `A == B`',
  rebuildAfter.mismatched === 0,
  `不一致 ${rebuildAfter.mismatched}`
)

// 3d. 不变量
const unsupported = await unsupportedMemories(h.db, owner)
report.check('unsupported = 0（MI-03）', unsupported.length === 0, `${unsupported.length} 条`)
const contaminated = await contaminatedMemories(h.db, owner)
report.check('contamination = 0', contaminated.length === 0, `${contaminated.length} 条`)

const duplicateActive = rowsOf(
  await h.db.execute(
    sql`select owner_kind, owner_id, content_fingerprint, count(*)::int as c
        from memory_records where status = 'active'
        group by owner_kind, owner_id, content_fingerprint having count(*) > 1`
  )
)
report.check(
  '强杀没有造成重复记忆（活跃指纹仍然唯一）',
  duplicateActive.length === 0,
  `${duplicateActive.length} 组重复`
)

// ---------------------------------------------------------------------------
// 4. 落证据
// ---------------------------------------------------------------------------
mkdirSync(evidenceDir, { recursive: true })
writeFileSync(
  join(evidenceDir, 'hardkill-result.json'),
  `${JSON.stringify(
    {
      testId: 'M4-T22/T23',
      name: 'Hard Kill + Crash Between Event and Projection',
      priority: 'P1',
      status: report.failed === 0 ? 'PASS' : 'FAIL',
      scope: {
        asserted:
          'DB opens after force-kill; no half revision; project-without-event impossible; ' +
          'committed-but-unfolded events are recoverable by the PRODUCTION recovery function ' +
          '(deterministically injected, not left to kill timing)',
        notAsserted:
          'that the write in flight at kill time survives (it may legitimately roll back); ' +
          'this is not an M4 semantic, it is PGlite/WAL durability',
      },
      childPid,
      killStdout: String(kill.stdout ?? '').trim(),
      schemaVersion,
      countsAfterKill: counts,
      crashOrphansFound: crashOrphans.length,
      crashOrphansNote: '时序相关：强杀落在哪两条语句之间决定它是否为 0，因此不断言 > 0',
      injectedOrphan: {
        domainEventId: String(injectedEvent.id),
        memoryId: String(injectedMemoryId),
        hadNoProjectionBefore: beforeRecovery === null,
      },
      recovery: {
        scanned: recovery.scanned,
        refolded: recovery.refolded,
        alreadyReflected: recovery.alreadyReflected,
        failed: recovery.failed,
        idempotentSecondScan: recoveryAgain.scanned,
      },
      replay: { memories: rebuild.memories, mismatched: rebuild.mismatched },
      checks: { passed: report.passed, failed: report.failed, failures: report.failures },
    },
    null,
    2
  )}\n`,
  'utf8'
)

await h.stop()
await resetPluginSqlConnection()
cleanupSandbox(sandbox.dir)

report.finish('M4 强制终止验收')
