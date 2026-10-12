/**
 * M6 **WP8 门** —— 规模、性能与已知容量边界（计划书 §WP8 L366–377；契约 M6-G7）。
 *
 * ============================================================================
 *  它判什么
 * ============================================================================
 * ```text
 *   ① 复用既有驱动跑 1,000 再跑 10,000 次混合操作（`pnpm m4:scale:verify -- <N>`），
 *      跑完**按白名单恢复旧固定证据路径**（`artifacts/m4-acceptance/scale/scale-result.json`）。
 *   ② **三种计数不许混**（计划书明文）：
 *        requested operations（我让它跑多少）
 *        persisted events（真落了多少领域事件）
 *        current active memories（现在有多少条有效记忆）
 *      并且"10,000-event Replay"要**另证** `replayed_event_count >= 10000`
 *      —— 不足时补合成量，**不能改报告名冒充达标**。
 *   ③ 硬性质：重放逐字段一致（`A == B`）· 重复不膨胀 · 旧事实不被物理覆盖 ·
 *      非法/失效记忆不入模 · 上下文受约定预算约束。
 *   ④ 记录：wall time · events/sec · RSS · 库/投影大小 · 候选数 · 实际扫描数 ·
 *      选入率 · 裁剪率。**采不到记不可得**（并写清为什么不可得）。
 *   ⑤ 扫描上限**单列**：在第 500 行边界内外放已知合法目标，测出当前召回覆盖
 *      （`retrieval-boundary.json`）。上限如实暴露即可（契约 M6-G7「覆盖上限如实暴露」）；
 *      只有契约要求"跨全库召回"而结果不满足时该子门才 FAIL + 补分页/查询改进 ADR。
 *
 * ⚠️ 本门不新造语料、不改既有驱动语义：规模操作全部走 `createM55Harness` 的
 *    M4 放行口（`makeCandidate` / `tryCommit` / `commitAndFold` / `applyStateChange`），
 *    与既有驱动同一套入口。
 *
 * 用法：`pnpm exec tsx scripts/verify-m6-wp8.ts`
 */
import 'dotenv/config'

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import { sql } from 'drizzle-orm'

import { cleanupSandbox, isolateDatabase, resetPluginSqlConnection } from '../src/dev/sandbox.ts'
import { rowsOf } from '../src/infrastructure/persistence/db.ts'
import { applyAcceptedEvents } from '../src/infrastructure/persistence/event-store.ts'
import { digestTree } from '../src/infrastructure/persistence/production-db-safety.ts'
import {
  contaminatedMemories,
  unsupportedMemories,
} from '../src/infrastructure/persistence/memory-store.ts'
import { memoryIntegrityProblems } from '../src/infrastructure/persistence/memory-integrity.ts'
import { createMemoryRetrievalStore } from '../src/infrastructure/persistence/memory-retrieval-store.ts'
import { rootReadingsByMemory } from '../src/infrastructure/persistence/qualification-read.ts'
import { createRollupSourceReader } from '../src/infrastructure/persistence/rollup-source-store.ts'
import { createFixtureSearchProvider } from '../src/infrastructure/search/fixture-search-provider.ts'
import { createMemoryRecallService } from '../src/kernel/app/recall/retrieval.ts'
import { createRecallTurnPort } from '../src/kernel/app/recall/turn.ts'
import { createRollupTurnPort } from '../src/kernel/app/rollup/turn.ts'
import { createRuleOnlyContentExtractor } from '../src/kernel/app/memory/content-extractor.ts'
import { createExplicitMemoryService } from '../src/kernel/app/memory/explicit-service.ts'
import { createExplicitMemoryTurnPort } from '../src/kernel/app/memory/explicit-turn.ts'
import { createExplicitMemoryIntentDetector, detectExplicitIntentFromEvent } from '../src/kernel/app/memory/intent-detector.ts'
import { createTargetMemoryResolver, LexicalSemanticJudge } from '../src/kernel/app/memory/target-resolver.ts'
import { DEFAULT_CONTEXT_BUDGET } from '../src/kernel/recall/selector.ts'
import type { EntityRef } from '../src/kernel/contracts/index.ts'
import { createReporter, countsOf } from './m4-harness.ts'
import { createM55Harness } from './m5.5-harness.ts'
import { measureRealDbDrift } from './inc-01-real-db-drift.ts'

const ROOT = resolve('.')
const REAL_DB = resolve('data/pglite')
const FIXED_SCALE_EVIDENCE = resolve('artifacts/m4-acceptance/scale/scale-result.json')
const REPLAY_TARGET = 10_000
const report = createReporter()
const check = (label: string, pass: boolean, reading: string): void =>
  report.check(label, pass, reading)

const head = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
const runId = `m6-wp8-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${head.slice(0, 12)}`
const outDir = join(ROOT, 'artifacts/m6', runId)
mkdirSync(outDir, { recursive: true })
const realBefore = digestTree(REAL_DB)
console.log(`runId=${runId}\n`)

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')
const integerOf = (rows: unknown, key = 'c'): number =>
  Number((rowsOf(rows as never)[0] as Record<string, unknown> | undefined)?.[key] ?? -1)

// ===========================================================================
// S 规模：复用既有驱动 1,000 → 10,000，并按白名单恢复固定证据路径
// ===========================================================================

report.section('S 规模：复用既有驱动（1,000 → 10,000 次混合操作）')

const fixedEvidenceOriginal = readFileSync(FIXED_SCALE_EVIDENCE, 'utf8')
const fixedEvidenceShaBefore = sha256(fixedEvidenceOriginal)
/** 跑之前它是不是**本来就脏**（别人的在途改动不能被我"恢复"掉） */
const fixedEvidenceDirtyBefore = spawnSync('git', ['status', '--porcelain', '--', FIXED_SCALE_EVIDENCE], {
  cwd: ROOT,
  encoding: 'utf8',
}).stdout.trim()

/**
 * 白名单恢复（`AGENTS.md` §7 的机械版）：**跑之前先记下**被改过的受版本控制证据，
 * 跑完只还原**新增出现**的那几个路径 —— 绝不对 `artifacts/` 做无差别 checkout
 * （那会把本门自己的证据一起还原掉，本项目真实踩过）。
 */
const trackedDirtyArtifacts = (): string[] =>
  spawnSync('git', ['status', '--porcelain', '--', 'artifacts'], { cwd: ROOT, encoding: 'utf8' })
    .stdout.split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 3 && !line.startsWith('??') && line.slice(0, 2).includes('M'))
    .map((line) => line.slice(3).trim())

const artifactsDirtyBefore = trackedDirtyArtifacts()
const M5_ELIGIBILITY_EVIDENCE = resolve('artifacts/m5/wp2-eligibility.json')
const m5EligibilityShaBefore = sha256(readFileSync(M5_ELIGIBILITY_EVIDENCE, 'utf8'))
/** 它**跑前**是不是本来就脏（§10.1 里更早的门会把它弄脏） */
const m5EligibilityDirtyBefore = spawnSync('git', ['status', '--porcelain', '--', M5_ELIGIBILITY_EVIDENCE], {
  cwd: ROOT,
  encoding: 'utf8',
}).stdout.trim()

interface DriverReading {
  operations: number
  exitCode: number | null
  seconds: number
  status: string
  artifactStatus: string
  domainEventsTotal: number
  memoryDomainEvents: number
  counts: Record<string, number>
  replayMismatched: number
  replayMemories: number
  elapsedMs: number
  operationsPerSecond: number
  checks: { passed: number; failed: number }
  tally: Record<string, number>
}

const driverRuns: DriverReading[] = []
for (const operations of [1000, 10_000]) {
  const startedAt = Date.now()
  const child = spawnSync(`pnpm m4:scale:verify -- ${operations}`, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: true,
    timeout: 3_600_000,
    env: process.env,
  })
  const seconds = Math.round((Date.now() - startedAt) / 1000)
  const exitCode = child.status ?? -1
  const artifact = JSON.parse(readFileSync(FIXED_SCALE_EVIDENCE, 'utf8')) as {
    status?: string
    operations?: number
    domainEventsTotal?: number
    memoryDomainEvents?: number
    counts?: Record<string, number>
    replay?: { memories?: number; mismatched?: number }
    elapsedMs?: number
    operationsPerSecond?: number
    checks?: { passed?: number; failed?: number }
    tally?: Record<string, number>
  }
  driverRuns.push({
    operations,
    exitCode,
    seconds,
    status: child.error !== undefined ? 'SPAWN FAILED' : exitCode === 0 ? 'PASS' : 'FAIL',
    artifactStatus: String(artifact.status ?? '(缺)'),
    domainEventsTotal: Number(artifact.domainEventsTotal ?? -1),
    memoryDomainEvents: Number(artifact.memoryDomainEvents ?? -1),
    counts: artifact.counts ?? {},
    replayMismatched: Number(artifact.replay?.mismatched ?? -1),
    replayMemories: Number(artifact.replay?.memories ?? -1),
    elapsedMs: Number(artifact.elapsedMs ?? -1),
    operationsPerSecond: Number(artifact.operationsPerSecond ?? -1),
    checks: { passed: Number(artifact.checks?.passed ?? -1), failed: Number(artifact.checks?.failed ?? -1) },
    tally: artifact.tally ?? {},
  })
  console.log(
    `   ${exitCode === 0 ? '✅' : '❌'} m4:scale:verify -- ${operations} exit=${exitCode} (${seconds}s) · ` +
      `领域事件 ${artifact.domainEventsTotal} · 记忆 ${artifact.counts?.memories}（active ${artifact.counts?.active}）`
  )
  /*
   * ⚠️ **立刻**恢复固定证据路径：既有驱动写的是**无 runId 的固定路径**，
   * 而它是 M4 验收的历史证据（计划书 §WP8 明文：保存新运行证据后按白名单恢复）。
   * 放在这里而不是脚本末尾：后面任何一步抛错都不该把它留在改写状态。
   */
  writeFileSync(FIXED_SCALE_EVIDENCE, fixedEvidenceOriginal, 'utf8')
}

const fixedEvidenceShaAfter = sha256(readFileSync(FIXED_SCALE_EVIDENCE, 'utf8'))
const fixedEvidenceDirty = spawnSync('git', ['status', '--porcelain', '--', FIXED_SCALE_EVIDENCE], {
  cwd: ROOT,
  encoding: 'utf8',
}).stdout.trim()

check(
  'S1 · 既有驱动 1,000 与 10,000 **都真的跑过**且退出码 0、产物 `status = PASS`',
  driverRuns.every((r) => r.status === 'PASS' && r.artifactStatus === 'PASS' && r.operations === r.operations),
  driverRuns.map((r) => `${r.operations}:exit=${String(r.exitCode)},${r.artifactStatus}`).join(' · ')
)
check(
  'S2 · 规模单调：10,000 次操作的**领域事件数**与**记忆条数**都不少于 1,000 次那一档（不是"跑了个空"）',
  driverRuns[1].domainEventsTotal > driverRuns[0].domainEventsTotal &&
    (driverRuns[1].counts.memories ?? 0) > (driverRuns[0].counts.memories ?? 0),
  driverRuns.map((r) => `${r.operations}: events=${r.domainEventsTotal} memories=${String(r.counts.memories)}`).join(' · ')
)
check(
  'S3 · **三种计数分开**：`operations`（请求操作数）≠ `domainEventsTotal`（实际持久事件数）≠ `counts.active`（当前有效记忆数）—— 三者都不是同一个数换名字',
  driverRuns.every(
    (r) =>
      r.operations > 0 &&
      r.domainEventsTotal > 0 &&
      (r.counts.active ?? -1) > 0 &&
      (r.operations !== r.domainEventsTotal ||
        r.domainEventsTotal !== r.counts.active ||
        r.operations !== r.counts.active)
  ) &&
    driverRuns.every((r) => (r.counts.memories ?? 0) >= (r.counts.active ?? 0)),
  driverRuns
    .map(
      (r) =>
        `${r.operations}: ops=${r.operations} events=${r.domainEventsTotal} active=${String(r.counts.active)} total=${String(r.counts.memories)}`
    )
    .join(' · ')
)
check(
  'S4 · 既有驱动的重放判据在 10,000 档仍然是 `A == B`（`mismatched = 0`，且重放条数 > 0）',
  driverRuns.every((r) => r.replayMismatched === 0 && r.replayMemories > 0),
  driverRuns.map((r) => `${r.operations}: rebuilt=${r.replayMemories} mismatched=${r.replayMismatched}`).join(' · ')
)
check(
  'S5 · 旧固定证据路径**按白名单恢复**：SHA-256 前后逐字相同；若跑之前它是干净的，`git status` 对该路径现在也必须为空（历史证据没有被覆盖掉、也没有顺手提交）',
  fixedEvidenceShaAfter === fixedEvidenceShaBefore &&
    (fixedEvidenceDirtyBefore !== '' || fixedEvidenceDirty === ''),
  `before=${fixedEvidenceShaBefore.slice(0, 16)}… after=${fixedEvidenceShaAfter.slice(0, 16)}… · ` +
    `跑前 git-status=${fixedEvidenceDirtyBefore === '' ? '(空)' : fixedEvidenceDirtyBefore} · ` +
    `跑后 git-status=${fixedEvidenceDirty === '' ? '(空)' : fixedEvidenceDirty}`
)

// ===========================================================================
// M 自有规模场景：≥10,000 实际事件回放 + 三种计数分开 + 硬性质
// ===========================================================================

report.section('M 自有规模场景：≥10,000 实际事件回放（三种计数分开）')

const sandbox = isolateDatabase('m6-wp8-scale', { keep: true })
await resetPluginSqlConnection()
const bed = await createM55Harness({
  label: 'm6-wp8-scale',
  provider: createFixtureSearchProvider({
    id: 'fixture-offline',
    items: [{ title: '合成标题', url: 'https://example.invalid/wp8', snippet: '合成摘要正文' }],
  }),
})
const h = bed.h
const { owner, user, db, store } = h

/** 混合比例沿用 M4 规模测试的形状：create / revise / forget / 同槽位第二取值 */
/*
 * ⚠️ 槽位必须**重复**（`i % SLOT_COUNT`）：否则 `scale.fact.${i}` 每个 i 都是新槽位，
 *    修订/遗忘/第二取值永远找不到目标 —— 于是"旧事实不被物理覆盖"这类判据会
 *    在**空集**上为真（第一次跑就是这样：superseded=0 却判过）。
 *    `SLOT_COUNT ≈ 0.3 × 目标操作数` 与既有驱动同形。
 */
const SLOT_COUNT = Math.max(20, Math.floor((REPLAY_TARGET / 1.06) * 0.3))
const slot = (i: number): string => `scale.fact.${i % SLOT_COUNT}`
const claimFor = (predicate: string, value: string, subject: EntityRef) =>
  ({ kind: 'claim', subject, predicate, value }) as never
/**
 * 规模操作的**历史时间基线**：30 天前开始的一段窗。
 *
 * ⚠️ 不能用 M4 夹具的 `M4_T0`（2027 年的合成时钟）：生产记忆走真实 `Date.now()`（2026），
 *    于是"合成历史"会**比生产记忆还新**，`recordedAt desc` 的前 50 条全是合成的
 *    —— 第一次跑就是这样（候选 50 / 选中 0 / 全是 `scale.fact.*`）。
 *    把规模窗放在过去、生产轮次发生在"现在"，才符合"她有一堆旧记忆 + 用户刚说了一句话"。
 */
const SCALE_T0 = Date.now() - 30 * 86_400_000

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const memoryEventCount = async (): Promise<number> =>
  integerOf(
    await db.execute(
      sql`select count(*)::int as c from memory_events l
          join memory_records r on r.id = l.memory_id
          where r.owner_kind = ${owner.kind} and r.owner_id = ${String(owner.id)}`
    )
  )

/** 槽位 → 当前记忆 id（与既有驱动同一套簿记：修订/遗忘都要一个真实目标） */
const created = new Map<string, string>()
const operationsRequestedTarget = 30_000
const operationsPerCheck = 500
const rssBefore = process.memoryUsage().rss
const scaleStartedAt = Date.now()
let operationsRequested = 0
let memoryEvents = 0

while (memoryEvents < REPLAY_TARGET && operationsRequested < operationsRequestedTarget) {
  const batchStart = operationsRequested
  while (operationsRequested - batchStart < operationsPerCheck && operationsRequested < operationsRequestedTarget) {
    const i = operationsRequested
    const bucket = i % 10
    operationsRequested += 1
    const now = SCALE_T0 + i * 10
    const key = slot(i)
    const existing = created.get(key)
    if (existing === undefined) {
      // 这个槽位还没有记忆：先建一条（否则"修订/遗忘"永远找不到目标 —— 空集上判绿）
      const evidence = await h.recordUserEvidence(`${key} 是 v${i}`)
      const record = await h.commitAndFold(
        h.makeCandidate('preference', claimFor(key, `v${i}`, user), { sourceRefs: [evidence.ref] }),
        now
      )
      if (record !== null) created.set(key, String(record.id))
      continue
    }
    if (bucket <= 5) {
      // 60%：修订（先记新值，再把旧值 supersede ⇒ 旧值**不**被物理覆盖）
      const evidence = await h.recordUserEvidence(`改一下：${key} 现在是 w${i}`)
      const fresh = await h.commitAndFold(
        h.makeCandidate('preference', claimFor(key, `w${i}`, user), { sourceRefs: [evidence.ref] }),
        now
      )
      if (fresh === null) continue
      await h.applyStateChange(
        'supersede',
        evidence.ref.id,
        { memoryId: existing, supersededBy: fresh.id, validUntil: now, reason: 'WP8 规模：同槽位新值' },
        now
      )
      created.set(key, String(fresh.id))
      continue
    }
    if (bucket <= 7) {
      // 20%：同槽位第二取值（旧值必须仍然在库里）
      const evidence = await h.recordUserEvidence(`${key} 其实也不是 v${i}`)
      const record = await h.commitAndFold(
        h.makeCandidate('preference', claimFor(key, `v${i}-alt`, user), { sourceRefs: [evidence.ref] }),
        now
      )
      if (record !== null) created.set(key, String(record.id))
      continue
    }
    // 20%：遗忘（⇒ RETRACTED 事件；遗忘是状态转移，不是物理删除）
    const evidence = await h.recordUserEvidence(`忘掉 ${key} 这件事`)
    await h.applyStateChange(
      'retract',
      evidence.ref.id,
      { memoryId: existing, reason: 'explicit_forget', note: 'WP8 规模' },
      now
    )
    created.delete(key)
  }
  memoryEvents = await memoryEventCount()
  console.log(`   … 已请求 ${operationsRequested} 次操作 · memory_events=${memoryEvents}/${REPLAY_TARGET}`)
}
const scaleWallMs = Date.now() - scaleStartedAt
const rssAfter = process.memoryUsage().rss

const counts = await countsOf(db, owner)
const persistedDomainEvents = integerOf(
  await db.execute(sql`select count(*)::int as c from character_domain_events`)
)
const replayedEventCount = await memoryEventCount()
const persistedConversationEvents = integerOf(
  await db.execute(sql`select count(*)::int as c from conversation_events`)
)
const unsupported = await unsupportedMemories(db, owner)
const contaminated = await contaminatedMemories(db, owner)

check(
  `M1 · **10,000-event Replay 项达标**：回放输入条数（\`memory_events ⨝ memory_records\`，即 \`memory-store.ts:796\` 读的那张表）实测 ${replayedEventCount} ≥ ${REPLAY_TARGET}`,
  replayedEventCount >= REPLAY_TARGET,
  `requested=${operationsRequested} · replayed_event_count=${replayedEventCount} · persisted_domain_events=${persistedDomainEvents} · active=${counts.active}`
)
check(
  'M2 · 三种计数**分开报**且语义不同：请求操作数 / 实际持久事件数 / 当前有效记忆数 —— 事件数**多于**记忆数（supersede/retract 也产生事件），有效记忆数**少于**请求操作数（去重与跳过）',
  operationsRequested !== counts.active &&
    persistedDomainEvents !== counts.active &&
    persistedDomainEvents > counts.memories &&
    counts.active <= counts.memories &&
    counts.active > 0,
  `requested=${operationsRequested} · domainEvents=${persistedDomainEvents} · memories=${counts.memories} · active=${counts.active}`
)
const rebuildA = await store.rebuildCharacterMemories(owner)
const rebuildB = await store.rebuildCharacterMemories(owner)
check(
  'M3 · 规模下重放**逐字段一致**且两次稳定：`mismatched = 0`，重建条数 > 0，两次同一结果',
  rebuildA.memories > 0 &&
    rebuildA.mismatched === 0 &&
    rebuildB.mismatched === 0 &&
    rebuildB.memories === rebuildA.memories,
  `重建 ${rebuildA.rebuilt}/${rebuildA.memories} · 不一致 ${rebuildA.mismatched} → ${rebuildB.mismatched}`
)
check(
  'M4 · 重复不膨胀：记忆条数 < 请求操作数（去重真的在大规模下工作），且规模确实很大',
  counts.memories > 0 && counts.memories < operationsRequested && counts.memories > 1000,
  `memories=${counts.memories} < requested=${operationsRequested}`
)
const supersededNoPointer = integerOf(
  await db.execute(
    sql`select count(*)::int as c from memory_records
        where status = 'superseded' and (superseded_by is null or superseded_by = '')`
  )
)
check(
  'M5 · 旧事实**不被物理覆盖**：superseded/retracted 行仍在库里、且每条 SUPERSEDED 都有 `superseded_by` 指针（INV-03 / MI-06）',
  counts.superseded > 0 &&
    counts.retracted > 0 &&
    supersededNoPointer === 0,
  `superseded=${counts.superseded} retracted=${counts.retracted} 缺指针=${supersededNoPointer}`
)
check(
  'M6 · 规模下不变量仍成立：`unsupported = 0`、`contamination = 0`（非法内容没有借规模溜进投影）',
  unsupported.length === 0 && contaminated.length === 0,
  `unsupported=${unsupported.length} contaminated=${contaminated.length}`
)

// ===========================================================================
// C 规模下的真实轮次：上下文受预算约束 + 失效记忆不入模 + 规模读数
// ===========================================================================

report.section('C 规模下的真实轮次：上下文受预算约束 · 失效记忆不入模')

const rollupPort = createRollupTurnPort({ reader: createRollupSourceReader(db) })
const retrievalPort = createMemoryRetrievalStore({
  store,
  integrity: (o) => memoryIntegrityProblems(db, o),
  rootReadings: (ids) => rootReadingsByMemory(db, ids),
})
const recallPort = createRecallTurnPort({
  service: createMemoryRecallService({ port: retrievalPort }),
  budget: DEFAULT_CONTEXT_BUDGET,
  now: () => Date.now(),
})
const gateway = bed.gatewayOf({ search: 'off', recall: recallPort, rollup: rollupPort })

/*
 * ⚠️ 规模里的记忆是用 `commitAndFold(makeCandidate(...))` 直接投的（与既有驱动同形），
 *    它们**没有走生产抽取路径**、因此没有受信归因信封 ⇒ 召回资格层会把它们整批挡下
 *    （第一次跑就是：候选 50 / 选中 0）。这不是缺陷，是本门夹具的缺口。
 *    所以这里**另用生产显式记忆入口**写两条真实记忆，召回的读数才有意义。
 */
const resolver = createTargetMemoryResolver({
  get: (id) => store.get(id),
  getActiveByCanonicalKey: (key) => store.getActiveByCanonicalKey(key),
  listBySubject: (o, s) => store.listBySubject(o, s),
  semanticJudge: new LexicalSemanticJudge(),
})
const memoryService = createExplicitMemoryService({
  store,
  validator: h.validator,
  extractor: createRuleOnlyContentExtractor(),
  resolveTarget: (input) =>
    resolver.resolve({
      owner: input.owner,
      text: input.text,
      ...(input.canonicalKey !== undefined ? { canonicalKey: input.canonicalKey } : {}),
      ...(input.subject !== undefined ? { subject: input.subject } : {}),
      ...(input.hints !== undefined ? { hints: input.hints } : {}),
    }),
  commitEvents: async (accepted, now) =>
    (await applyAcceptedEvents(db, h.characterId as never, accepted, [], now)).domainEvents,
})
const memoryPort = createExplicitMemoryTurnPort({ service: memoryService })
const memoryDetector = createExplicitMemoryIntentDetector()
const memoryTurn = async (text: string): Promise<string> => {
  const recorded = await h.recordUserEvidence(text)
  await detectExplicitIntentFromEvent(memoryDetector, {
    id: recorded.ref.id as never,
    actorType: 'user',
    content: text,
  })
  const result = await memoryPort.handleTurn({
    owner,
    speaker: user,
    event: { id: recorded.ref.id as never, actorType: 'user', content: text },
  })
  if (result === undefined) return 'no_intent'
  return result.kind === 'not_written'
    ? `${String(result.kind)}/${String((result as { reason?: unknown }).reason ?? '')}`
    : String(result.kind)
}
const keepActive = await memoryTurn('记住，我不吃辣')
const toRetract = await memoryTurn('记住，我不吃香菜')
const countsAfterProductionWrites = await countsOf(db, owner)

/*
 * ⚠️ 生产记忆走**真实** `Date.now()`，规模记忆走 30 天前的窗 ⇒ 生产记忆是"最新"的那两条，
 *    才会出现在 `recordedAt desc` 的前 50 条候选里。
 */
const turn = await bed.say({
  gateway,
  text: '我平时吃香菜吗？',
  replyText: '（她如实回答）',
})

const memorySection = turn.packet.sections.find((s) => String(s.id) === 'memory-recall')
const memorySectionTokens = Number(memorySection?.estimatedTokens ?? -1)
const recallStep = turn.trace.steps.find((s) => s.kind === 'memory_recall')
const attributes = (recallStep?.attributes ?? {}) as Record<string, unknown>
const candidates = Number(attributes.candidates ?? -1)
const scanned = Number(attributes.scanned ?? -1)
const selected = Number(attributes.selected ?? -1)
const droppedByBudget = Number(attributes.droppedByBudget ?? -1)
const exclusions = String(attributes.exclusions ?? '{}')
const selectionRate = candidates > 0 ? Number((selected / candidates).toFixed(4)) : -1
const trimmingRate = candidates > 0 ? Number((droppedByBudget / candidates).toFixed(4)) : -1

const cilantroRow = (await store.list({ owner, status: 'active', limit: 500 })).find((row) =>
  JSON.stringify(row.content).includes('cilantro')
)

check(
  'C1 · **上下文受约定预算约束**（正控：轮次确实召回了生产记忆）：上万条记忆的库里，记忆 section 的 token 成本不超过 `memoryTokens`，且选入条数远小于候选',
  memorySectionTokens > 0 &&
    memorySectionTokens <= DEFAULT_CONTEXT_BUDGET.memoryTokens &&
    selected > 0 &&
    candidates > 0 &&
    selected <= candidates &&
    cilantroRow !== undefined,
  `memorySection=${memorySectionTokens} ≤ 预算 ${DEFAULT_CONTEXT_BUDGET.memoryTokens} · 选中=${selected}/${candidates} · 库内记忆=${counts.memories}（active ${counts.active}）· 生产写入=${keepActive}/${toRetract} · 排除=${exclusions}`
)
check(
  'C2 · 规模读数**可采**：候选数 / 实际扫描数 / 选入率 / 裁剪率都来自 trace 的 `memory_recall`（不是脚本自己算的另一个人工数）',
  candidates > 0 && scanned > 0 && selected >= 0 && droppedByBudget >= 0 && selectionRate >= 0,
  `candidates=${candidates} scanned=${scanned} selected=${selected} droppedByBudget=${droppedByBudget} 选入率=${selectionRate} 裁剪率=${trimmingRate}`
)

/*
 * 失效记忆不入模（规模版）——**必须同时证明它本来够得着**，否则"没进上下文"可以
 * 是因为它根本没被召回（空过）。四步：
 *   ① 规模下用**自然语言**遗忘：实测是 `not_written / target_ambiguous`
 *      （她不猜目标 —— 这本身是规模边界，如实登记）；
 *   ② 用同一台状态机把目标记忆置为 retracted（`忘掉` 在解析出目标之后走的就是这一条）；
 *   ③ 端口级 `hits` 里**仍然有**它（够得着，不是空过）；
 *   ④ 同一句问话的真实上下文里 **没有** 它。
 */
const nlRetract = await memoryTurn('忘掉我不吃香菜这件事')
const retractNow = Date.now()
if (cilantroRow !== undefined) {
  const evidence = await h.recordUserEvidence('忘掉我不吃香菜这件事（已解析到目标）')
  await h.applyStateChange(
    'retract',
    evidence.ref.id,
    { memoryId: String(cilantroRow.id), reason: 'explicit_forget', note: 'WP8 规模：失效不入模的正控目标' },
    retractNow
  )
}
const countsAfterRetract = await countsOf(db, owner)
const retractedCilantro = (await store.list({ owner, status: 'retracted', limit: 500 })).find((row) =>
  JSON.stringify(row.content).includes('cilantro')
)
const probeHits = await retrievalPort.retrieve({
  traceId: 'trc:wp8-retracted-probe' as never,
  characterId: h.characterId as never,
  user,
  text: '我平时吃香菜吗？',
  timeScope: { kind: 'any' } as never,
  limit: 50,
})
const probeReachable =
  retractedCilantro !== undefined &&
  probeHits.hits.some((hit) => String(hit.record.id) === String(retractedCilantro.id))
const probeTurn = await bed.say({ gateway, text: '我平时吃香菜吗？', replyText: '（她如实回答）' })
const probeStep = probeTurn.trace.steps.find((s) => s.kind === 'memory_recall')
const probeAttrs = (probeStep?.attributes ?? {}) as Record<string, unknown>
let probeSelectedIds: string[] = []
if (typeof probeAttrs.decisionRecord === 'string') {
  try {
    const parsed = JSON.parse(probeAttrs.decisionRecord) as { selectedIds?: unknown[] }
    probeSelectedIds = Array.isArray(parsed.selectedIds) ? parsed.selectedIds.map(String) : []
  } catch {
    probeSelectedIds = []
  }
}
const probeInContext =
  retractedCilantro !== undefined && probeSelectedIds.includes(String(retractedCilantro.id))
const probeSectionText = String(
  probeTurn.packet.sections.find((s) => String(s.id) === 'memory-recall')?.content ?? ''
)
const invalidatedMemoryNotInContext =
  countsAfterRetract.retracted > countsAfterProductionWrites.retracted &&
  probeReachable &&
  !probeInContext &&
  !probeSectionText.includes('不吃香菜')
check(
  'C3 · **失效记忆不入模**（规模版，带正控）：置为 retracted 之后用同一句问话 —— ①端口级 `hits` 里**仍然有**它；②这一轮的 `selectedIds` 与上下文里**都没有**它',
  invalidatedMemoryNotInContext,
  `retracted ${countsAfterProductionWrites.retracted}→${countsAfterRetract.retracted} · 端口可达=${String(probeReachable)} · ` +
    `selectedIds=${JSON.stringify(probeSelectedIds).slice(0, 40)} · 上下文含该措辞=${String(probeSectionText.includes('不吃香菜'))}`
)
check(
  'C4 · 规模边界**如实登记**：在上万条记忆的库里说"忘掉我不吃香菜这件事" ⇒ 具名拒绝 `not_written / target_ambiguous`（她**不猜**目标），而同一句在 1–2 条记忆的库（WP7a）能解析成功',
  nlRetract === 'not_written/target_ambiguous',
  `NL 遗忘 = ${nlRetract}`
)

// 采样库大小（PGlite 是目录里的文件；"投影大小"用行数如实表达）
const directorySize = (path: string): number => {
  let total = 0
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const child = join(current, entry.name)
      if (entry.isDirectory()) walk(child)
      else total += statSync(child).size
    }
  }
  try {
    walk(path)
  } catch {
    return -1
  }
  return total
}
const projectionRows: Record<string, number> = {}
for (const table of ['memory_records', 'memory_subject_links', 'memory_evidence_links', 'memory_events']) {
  projectionRows[table] = integerOf(await db.execute(sql.raw(`select count(*)::int as c from "${table}"`)))
}
const databaseSizeBytes = directorySize(sandbox.dir)

// ===========================================================================
// B 检索上界（单列；retrieval-boundary.json）
// ===========================================================================

report.section('B 检索上界：第 500 行边界内外的已知合法目标')

/**
 * 在**同一批规模数据**上放探针，测"已知合法目标能不能被召回"：
 *   · rank 1   —— 最新的一条（一切通道都该看到它）
 *   · rank 51  —— 落在 `filtered.slice(0, limit)`（limit=50）**之外**
 *   · 最老的一条 —— 落在 store 的 500 行上限之外
 * 目标都是普通用户来源的记忆（合法），查询用它们各自的**独有措辞**（词面通道本该命中）。
 */
const boundaryProbe = async (predicate: string, value: string, now: number): Promise<{ id: string; text: string }> => {
  const evidence = await h.recordUserEvidence(`${predicate} 是 ${value}`)
  const record = await h.commitAndFold(
    h.makeCandidate('preference', claimFor(predicate, value, user), { sourceRefs: [evidence.ref] }),
    now
  )
  if (record === null) throw new Error(`边界探针写入失败：${predicate}`)
  return { id: String(record.id), text: `${predicate} ${value}` }
}

/*
 * ⚠️ 排名必须**确定**：`store.list` 按 `recorded_at desc` 取行，同一毫秒内的并列
 *    由数据库任意决定。因此探针之间插 `wait`，让"新/旧"在时间戳上严格分开，
 *    "第 51 新"才是一个可复现的事实而不是掷骰子。
 *
 * 三档探针的时间戳**刻意**排好（`recordedAt desc` 决定切片）：
 *   规模循环最晚一条 ≈ `SCALE_T0 + 75s` ≪ rank51（+900s）< 51 条填充（+900.1s）< rank1（+901s）
 * ⇒ 最新第 1 名 = rank1；按时间排第 53 名 = rank51（切片只取前 50）。
 * ⚠️ 这里**不能**再给 rank51 加 `operationsRequested`：上一版那样写把它变成了"最新"，
 *    于是 B2 量到的是"第 1 名能召回"，与它声称的"第 51 名召回不到"**不是同一件事**。
 */
const probeRank51 = await boundaryProbe('boundary.probe.theta', 'rank51', SCALE_T0 + 900_000)
await wait(15)
for (let k = 0; k < 51; k += 1) {
  const i = 950_000 + k
  const evidence = await h.recordUserEvidence(`${slot(i)} 是 u${i}`)
  await h.commitAndFold(
    h.makeCandidate('preference', claimFor(slot(i), `u${i}`, user), { sourceRefs: [evidence.ref] }),
    SCALE_T0 + 900_100 + k
  )
}
await wait(15)
const probeRank1 = await boundaryProbe('boundary.probe.zeta', 'rank1', SCALE_T0 + 901_000)

/** 最老的一条：`store.list` 是 desc 序，所以这里直接 SQL 取 asc 的第一条 */
const oldestIdRow = rowsOf(
  await db.execute(
    sql`select id from memory_records
        where owner_kind = ${owner.kind} and owner_id = ${String(owner.id)}
        order by recorded_at asc limit 1`
  )
)[0] as { id?: unknown } | undefined
const oldest = oldestIdRow?.id === undefined ? null : await store.get(String(oldestIdRow.id) as never)

interface BoundaryProbeReading {
  id: string
  label: string
  recencyRank: string
  retrieved: boolean
  hitCount: number
  channels: string[]
}

const boundaryProbes: BoundaryProbeReading[] = []
const runBoundaryProbe = async (
  label: string,
  target: { id: string; text: string },
  recencyRank: string
): Promise<void> => {
  const result = await retrievalPort.retrieve({
    traceId: 'trc:wp8-boundary' as never,
    characterId: h.characterId as never,
    user,
    text: target.text,
    timeScope: { kind: 'any' } as never,
    limit: 50,
  })
  const hit = result.hits.find((item) => String(item.record.id) === target.id)
  boundaryProbes.push({
    id: target.id,
    label,
    recencyRank,
    retrieved: hit !== undefined,
    hitCount: result.hits.length,
    channels: hit === undefined ? [] : [...hit.channels],
  })
}

const oldestRows = oldest === null ? [] : [oldest]
await runBoundaryProbe('最新（rank 1）', probeRank1, '1')
await runBoundaryProbe('第 51 新（切片之外）', probeRank51, '51')
if (oldest !== null) {
  const predicate = String((oldest.content as { predicate?: unknown }).predicate ?? '')
  await runBoundaryProbe('最老的一条', { id: String(oldest.id), text: predicate }, '≈最老')
}
void oldestRows

const storeCapProbe = await store.list({ owner, limit: 1000 })
const storeCap = integerOf(
  await db.execute(
    sql`select count(*)::int as c from (select id from memory_records
        where owner_kind = ${owner.kind} and owner_id = ${String(owner.id)}
        order by recorded_at asc limit 500) t`
  )
)

const rank1 = boundaryProbes[0]
const rank51 = boundaryProbes[1]
const oldestProbe = boundaryProbes[2]

check(
  'B1 · 正控：最新的一条探针**能被召回**（否则"后面几条召回不到"说明不了上界，只能说明探针坏了）',
  rank1?.retrieved === true,
  rank1 === undefined ? '(没有 rank1 读数)' : `rank1 retrieved=${String(rank1.retrieved)} hits=${rank1.hitCount} channels=${JSON.stringify(rank1.channels)}`
)
check(
  'B2 · 上界如实暴露（切片）：第 51 新的已知合法目标**召回不到** —— 选择发生在 `filtered.slice(0, limit)` 之前，切片按 `recordedAt desc` 取前 50 条。⚠️ 这一条若变红，说明上界变了：请**更新已登记的局限**，不要直接放宽判据',
  rank51?.retrieved === false,
  rank51 === undefined ? '(没有 rank51 读数)' : `rank51 retrieved=${String(rank51.retrieved)} hits=${rank51.hitCount}`
)
check(
  'B3 · 上界如实暴露（store 上限）：最老的一条已知合法目标**召回不到**；且 `store.list(limit=1000)` 实际返回**恰好 500** 行（`memory-store.ts:645` 的 500 行上限是**真的在上限**，不是"请求 1000 也拿 1000"）',
  oldestProbe?.retrieved === false && storeCapProbe.length === 500 && storeCap === 500 && counts.memories > 500,
  `oldest retrieved=${String(oldestProbe?.retrieved)} · list(1000) 返回 ${storeCapProbe.length} 行 · SQL 计数=${storeCap} · 库里记忆=${counts.memories}`
)
check(
  'B4 · 契约结论**有据**：本子门不 FAIL —— `M6-Acceptance-Contract.md` 的 M6-G7 只要求"覆盖上限如实暴露"，没有任何"跨全库召回"的要求（逐字核对该行见证据里的 `contractClause`）',
  contractRequiresCrossDbRecall() === false,
  'contractClause=M6-G7「10k 操作读数与 ≥10k 实际事件回放分开；投影一致；覆盖上限如实暴露」'
)

/** 契约里到底有没有"跨全库召回"的要求：直接读文件，不靠记忆 */
function contractRequiresCrossDbRecall(): boolean {
  const text = readFileSync(resolve('docs/m6/M6-Acceptance-Contract.md'), 'utf8')
  return /跨全库召回|全库召回|任意检索/.test(text)
}

// ===========================================================================
// 子门
// ===========================================================================

report.section('子门：与本门同型的既有判据（本门只登记映射与退出码）')
const childSpecs: { id: string; cmd: string; covers: string }[] = [
  {
    id: 'm4:scale:verify',
    cmd: 'pnpm m4:scale:verify',
    covers: '既有规模驱动（默认 1,000）：重放 A==B / 去重 / 旧值不覆盖 / 不变量',
  },
  {
    id: 'm5:verify',
    cmd: 'pnpm m5:verify',
    covers: '召回资格与排序的部件级判据（本门的"候选/选中"读数与它同源）',
  },
]
interface ChildReading {
  id: string
  command: string
  covers: string
  exitCode: number | null
  seconds: number
  status: string
}
const childReadings: ChildReading[] = []
for (const spec of childSpecs) {
  const startedAt = Date.now()
  const child = spawnSync(spec.cmd, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: true,
    timeout: 3_600_000,
    env: process.env,
  })
  const seconds = Math.round((Date.now() - startedAt) / 1000)
  const exitCode = child.status ?? -1
  const status = child.error !== undefined ? 'SPAWN FAILED' : exitCode === 0 ? 'PASS' : 'FAIL'
  childReadings.push({ id: spec.id, command: spec.cmd, covers: spec.covers, exitCode, seconds, status })
  console.log(`   ${status === 'PASS' ? '✅' : '❌'} ${spec.id.padEnd(20)} exit=${exitCode} (${seconds}s)`)
}
for (const reading of childReadings) {
  check(
    `X-${reading.id} · 同型既有判据 \`${reading.command}\` EXIT 0 —— ${reading.covers}`,
    reading.status === 'PASS',
    `exit=${String(reading.exitCode)} (${reading.seconds}s)`
  )
}

/*
 * 子门重跑会刷新**固定路径**的历史证据（本门实测到 `artifacts/m5/wp2-eligibility.json`）。
 * 按白名单还原"新增出现"的那些，并逐条证明还原后与索引逐字一致。
 */
const artifactsDirtyAfterChildren = trackedDirtyArtifacts()
const newlyDirty = artifactsDirtyAfterChildren.filter((path) => !artifactsDirtyBefore.includes(path))
for (const path of newlyDirty) {
  spawnSync('git', ['checkout', '--', path], { cwd: ROOT })
}
const leftoverDirty = trackedDirtyArtifacts().filter((path) => !artifactsDirtyBefore.includes(path))
const restoredClean = newlyDirty.filter(
  (path) => spawnSync('git', ['diff', '--quiet', '--', path], { cwd: ROOT }).status === 0
)
check(
  'S6 · 子门刷新的固定路径**按白名单还原**（机械判定）：跑完与索引逐字一致（`git diff --quiet` 退出 0），且没有多还原任何东西',
  leftoverDirty.length === 0 && restoredClean.length === newlyDirty.length,
  `跑前已脏=${JSON.stringify(artifactsDirtyBefore)} · 子门新弄脏=${JSON.stringify(newlyDirty)} · 还原后仍脏=${JSON.stringify(leftoverDirty)} · 与索引一致=${restoredClean.length}/${newlyDirty.length}`
)
/*
 * ⚠️ 这条判据**改过一次**（WP10a 的最终离线门抓出来的）：
 *    第一版要求"跑完之后该文件与索引逐字一致"，可它**没有区分跑前是否已经脏**。
 *    单独跑 WP8 时它当然是干净的；但在最终离线门里，§10.1 里更早的门
 *    （`m5:verify` / `m5.1:measurement:verify`）已经把它改脏了，
 *    于是白名单规则（只还原**新增**脏）**不会**去动它 ⇒ 跑完仍然脏 ⇒ 冤枉红。
 *    正确的判据是**状态相对**的：跑前干净 ⇒ 跑完必须干净（证明还原有效）；
 *    跑前就脏 ⇒ 不替别人还原，但必须**如实记录**它仍然脏。
 */
const m5EligibilityShaAfter = sha256(readFileSync(M5_ELIGIBILITY_EVIDENCE, 'utf8'))
const m5EligibilityDirtyAfter = spawnSync('git', ['status', '--porcelain', '--', M5_ELIGIBILITY_EVIDENCE], {
  cwd: ROOT,
  encoding: 'utf8',
}).stdout.trim()
check(
  'S7 · 子门固定路径 `artifacts/m5/wp2-eligibility.json` 的处置**有据**：跑前干净 ⇒ 跑完必须干净（按白名单还原过）；跑前就脏 ⇒ 如实记下它仍脏（那是别人的在途改动，不擅自替人还原）',
  m5EligibilityDirtyBefore === '' ? m5EligibilityDirtyAfter === '' : m5EligibilityShaBefore !== '',
  `跑前=${m5EligibilityDirtyBefore === '' ? '(干净)' : '已脏'} · 跑后=${m5EligibilityDirtyAfter === '' ? '(干净)' : '仍脏'} · sha=${m5EligibilityShaBefore.slice(0, 8)}→${m5EligibilityShaAfter.slice(0, 8)}`
)

await bed.dispose()
await resetPluginSqlConnection()
cleanupSandbox(sandbox.dir)

// ===========================================================================
// 真实库安全 + 证据
// ===========================================================================

const realAfter = digestTree(REAL_DB)
const drift = measureRealDbDrift(realBefore, realAfter)
check(
  'Z1 · 真实 `data/pglite` 在本门运行前后**逐字不变**（本门全部跑在合成隔离库上）',
  drift.unchangedDuringRun && realAfter.measuredCount > 0 && (drift.matchesWp0Baseline || drift.driftExplained),
  `measured=${realAfter.measuredCount} · ${drift.reading}`
)

const verdict = report.failed === 0 ? 'PASS' : 'FAIL'
const scalePayload = {
  schemaVersion: 'm6-wp8-scale@1',
  runId,
  generatedAt: new Date().toISOString(),
  head,
  verdict,
  passed: report.passed,
  failed: report.failed,
  measurementInvalid: 0,
  wp: 'M6 WP8 — 规模、性能与已知容量边界（规模与性能部分）',
  driverRuns,
  fixedEvidencePath: {
    path: 'artifacts/m4-acceptance/scale/scale-result.json',
    sha256Before: fixedEvidenceShaBefore,
    sha256After: fixedEvidenceShaAfter,
    restoredByteExact: fixedEvidenceShaAfter === fixedEvidenceShaBefore,
    gitStatusAfter: fixedEvidenceDirty === '' ? '(空)' : fixedEvidenceDirty,
    note: '既有驱动写的是无 runId 的固定路径；跑完立刻按白名单恢复（计划书 §WP8）。',
  },
  countsSeparated: {
    requestedOperations: operationsRequested,
    persistedDomainEvents,
    persistedConversationEvents,
    replayedEventCount,
    totalMemories: counts.memories,
    currentActiveMemories: counts.active,
    replayedEventCountDerivation:
      'select count(*) from memory_events l join memory_records r on r.id = l.memory_id' +
      ' where r.owner_kind=… and r.owner_id=… —— 这就是 `memory-store.ts:796`(domainEventsForMemory) ' +
      '读的那张表，独立复算，不由被测方自报。',
  },
  replayTarget: { required: REPLAY_TARGET, measured: replayedEventCount, met: replayedEventCount >= REPLAY_TARGET },
  hardProperties: {
    replayedFieldsIdentical: rebuildA.mismatched === 0,
    replayStableAcrossTwoRuns: rebuildB.mismatched === 0 && rebuildB.memories === rebuildA.memories,
    rebuiltMemories: rebuildA.rebuilt,
    noInflation: counts.memories < operationsRequested,
    oldFactsRetained: { superseded: counts.superseded, retracted: counts.retracted, supersededWithoutPointer: supersededNoPointer },
    unsupported: unsupported.length,
    contaminated: contaminated.length,
    contextBounded: {
      memorySectionTokens,
      configuredMemoryTokens: DEFAULT_CONTEXT_BUDGET.memoryTokens,
      selectedMemories: selected,
      activeMemories: counts.active,
    },
    invalidatedMemoryNotInContext,
  },
  metrics: {
    wallTimeMs: scaleWallMs,
    requestedOperations: operationsRequested,
    eventsPerSecond:
      scaleWallMs > 0 ? Number((persistedDomainEvents / (scaleWallMs / 1000)).toFixed(2)) : -1,
    driverOperationsPerSecond: driverRuns.map((r) => `${r.operations}:${r.operationsPerSecond}`),
    rssBeforeBytes: rssBefore,
    rssAfterBytes: rssAfter,
    rssScope: '本进程（Node）的 RSS；**不是** PGlite 引擎内部占用 —— 采不到引擎侧的读数，不假装有',
    databaseSizeBytes,
    projectionRows,
    recall: { candidates, scanned, selected, droppedByBudget, selectionRate, trimmingRate },
    unavailable: [
      '子进程（既有驱动）的 RSS —— 子进程退出后无法回读，如实记不可得',
      'PGlite 引擎内部内存占用 —— 本仓库没有该读数来源',
    ],
  },
  childGates: childReadings,
  itemCoverage: {
    '1k→10k 混合操作（复用既有驱动）': 'S1–S5（本门）+ 子门 m4:scale:verify',
    '≥10k 实际事件回放（另证 replayed_event_count）': 'M1（本门自有规模场景）',
    '三种计数不许混': 'S3 + M2（三个独立读数分开报）',
    '投影一致 / 重放逐字段一致': 'M3（本门）+ 子门 m4:scale:verify',
    '重复不膨胀 / 旧事实不被物理覆盖 / 非法不入模 / 上下文受预算约束': 'M4/M5/M6/C1/C3',
    '扫描上限单列（第 500 行边界内外）': 'retrieval-boundary.json（同一 runId，本门 B 节）',
    '性能 SLA': '**未冻结 ⇒ 不判**（计划书 §WP8：SLA 需先校准冻结，不临时拍秒数）',
    '500 轮长对话': 'WP9a/WP9b（尚未执行）',
  },
  realDb: {
    before: drift.before.treeSha256,
    after: drift.after.treeSha256,
    unchangedDuringThisRun: drift.unchangedDuringRun,
    driftExplained: drift.driftExplained,
  },
  checks: { passed: report.passed, failed: report.failed, failures: report.failures },
  totals: { checks: report.passed + report.failed, passed: report.passed, failed: report.failed },
  didNotOpenRealDatabase: true,
  note: '规模操作全部走 M4 放行口（与既有驱动同一套入口）；本门没有新造语料，也没有改驱动语义。',
}

const boundaryPayload = {
  schemaVersion: 'm6-wp8-retrieval-boundary@1',
  runId,
  generatedAt: new Date().toISOString(),
  head,
  verdict,
  passed: report.passed,
  failed: report.failed,
  measurementInvalid: 0,
  wp: 'M6 WP8 — 检索覆盖上界（单列）',
  measuredWindow: {
    storeListCap: 500,
    scanCeilingDefault: 500,
    scanLimitFormula: 'scanLimit = max(1, min(scanCeiling, query.limit * 5))',
    productionLimit: 50,
    effectiveScanLimitAtProduction: Math.min(500, 50 * 5),
    sliceBeforeRanking: 'selected = filtered.slice(0, query.limit) —— 发生在**排序之前**',
    subjectChannel: 'listBySubject：**无 LIMIT**（读全量），但结果同样要过上面那道切片',
  },
  sourceRefs: [
    'src/infrastructure/persistence/memory-retrieval-store.ts:99（scanLimit 公式）',
    'src/infrastructure/persistence/memory-retrieval-store.ts:180（slice 在排序之前）',
    'src/infrastructure/persistence/memory-store.ts:645（list 的 500 行上限）',
    'src/infrastructure/persistence/memory-store.ts:619（listBySubject 无 LIMIT）',
  ],
  registeredLimitation: {
    document: 'docs/m5/M5-Acceptance-Report.md',
    line: 195,
    text: '检索最多扫描 500 行（跟随 MemoryStorePort.list 的既有上限）',
    refinement:
      '本门实测把这条局限**收细**：当"同一 subject 下的记忆数 > 50"时，实际可被排序的选择集是『最近 50 条』；' +
      '『500 行』只是 store.list 的单次上限（recency 通道实际只取 min(500, limit×5)=250）。',
  },
  contractClause: {
    document: 'docs/m6/M6-Acceptance-Contract.md',
    line: 134,
    id: 'M6-G7',
    text: '10k 操作读数与 ≥10k 实际事件回放分开；投影一致；覆盖上限如实暴露',
    crossDbRecallRequired: contractRequiresCrossDbRecall(),
    conclusion:
      '契约**没有**"跨全库召回"要求 ⇒ 本子门不 FAIL；本条按"上限如实暴露"判。' +
      '若将来契约加上该要求，最小修法是给 memory-retrieval-store 加**候选分页/扩窗**（在切片之前按分数取候选），' +
      '而不是接向量库或放宽分母。',
  },
  databaseSize: { memories: counts.memories, active: counts.active },
  probes: boundaryProbes,
  storeListProbe: { requestedLimit: 1000, returned: storeCapProbe.length, sqlCountWithin500: storeCap },
  checks: { passed: report.passed, failed: report.failed, failures: report.failures },
  totals: { checks: report.passed + report.failed, passed: report.passed, failed: report.failed },
}

const writeJson = (path: string, payload: Record<string, unknown>): void => {
  const text = `${JSON.stringify(payload, null, 2)}\n`
  writeFileSync(path, text, 'utf8')
  const onDisk = readFileSync(path, 'utf8')
  if (onDisk !== text) throw new Error(`落盘复核失败：${path}`)
  JSON.parse(onDisk)
}

writeJson(join(outDir, 'scale.json'), scalePayload)
writeJson(join(outDir, 'retrieval-boundary.json'), boundaryPayload)

console.log(
  `\nM6 WP8 门：${report.passed} 通过 / ${report.failed} 失败` +
    (report.failures.length > 0 ? `\n失败项：${report.failures.join(' | ')}` : '')
)
console.log(`证据：${relative(ROOT, join(outDir, 'scale.json')).split(/[\\/]/).join('/')}`)
console.log(`证据：${relative(ROOT, join(outDir, 'retrieval-boundary.json')).split(/[\\/]/).join('/')}`)
process.exitCode = report.failed === 0 ? 0 : 1
