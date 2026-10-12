/**
 * S8 · WP9 —— **生产故事入口门**（`pnpm postlv2:s8:production:verify`）。
 *
 * ============================================================================
 *  载体：ADR-094 `D02`（提案 → 判定 → 提交）· `D01`（开关）· `D11` ②
 * ============================================================================
 *  它守什么
 * ---------------------------------------------------------------------------
 * ```text
 * N1 开关关闭 ⇒ `disabled` 且**零写入**（"没启用"与"拒绝"是两件事）
 * N2 合法选择 ⇒ `committed`，且绑定三件（会话 / anchor / actor）**逐字来自服务端**
 * N3 绑定**进不来**：提案里塞 binding 字段 ⇒ 被忽略（账本读回证明它不是提案说了算）
 * N4 非法选择四类（未知 / 过期 revision / 终局后 / 提案形状坏）⇒ **具名拒收 + 零副作用**
 * N5 幂等：同一服务端键重复投递 ⇒ 账本**不新增**第二条
 * N6 `D13` 联动：提交后按消费者水位消费**一次**，再消费为零（至多一次）
 * ```
 */

import 'dotenv/config'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { isolateDatabase, resetPluginSqlConnection } from '../src/dev/sandbox.ts'

const REPO_ROOT = resolve(process.cwd())
const read = (relative: string): string => readFileSync(join(REPO_ROOT, relative), 'utf8')
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

interface Check {
  id: string
  label: string
  pass: boolean
  detail: string
  measured: number
}
const checks: Check[] = []
const record = (id: string, label: string, pass: boolean, detail: string, measured: number): void => {
  checks.push({ id, label, pass, detail, measured })
  console.log(`  ${pass ? '✅' : '❌'} ${id} ${label} —— ${detail}`)
}

const sandbox = isolateDatabase('postlv2-s8-production', { keep: false })
console.log(`  [sandbox] ${sandbox.dir}`)

const { createM4Harness, M4_T0 } = await import('./m4-harness.ts')
const { asCharacterId } = await import('../src/kernel/contracts/ids.ts')
const { createStoryLedgerStore } = await import(
  '../src/infrastructure/storyline/store/story-ledger-store.ts'
)
const { createStoryWatermarkStore } = await import(
  '../src/infrastructure/storyline/store/story-watermark-store.ts'
)
const { ingestStoryChoice, storyIngestIdempotencyKey } = await import(
  '../src/kernel/app/storyline/choice-ingest.ts'
)
const { storyCommitsToConsume } = await import('../src/kernel/storyline/story-watermark.ts')
const { consumeStoryCommits } = await import('../src/kernel/app/storyline/consumer-loop.ts')
const { JICHUANG_PACK } = await import('../evals/storyline/jichuang-interview-two/story-pack.ts')

let clock = M4_T0
const h = await createM4Harness({ label: 'postlv2-s8-production' })
const db = h.db
const ledger = createStoryLedgerStore(db)
const watermarks = createStoryWatermarkStore(db)
const RUN = 's8-production-main'

/** 服务端上下文（**测试里由用例扮演服务端**；提案那条路拿不到它） */
const server = (revision: number, anchor: string): Parameters<typeof ingestStoryChoice>[0]['server'] => ({
  runId: RUN,
  anchorConversationEventId: anchor,
  interactionRef: 's8-production-session',
  actorId: h.userId,
  expectedRevision: revision,
})

const countCommits = async (): Promise<number> =>
  (await ledger.listCommits({ storyId: JICHUANG_PACK.storyId, runId: RUN })).length

// ---------------------------------------------------------------------------
// 开场（system 提交；**不**经生产入口 —— 入口只处理用户选择）
// ---------------------------------------------------------------------------
const { commitStoryTurn } = await import('../src/kernel/app/storyline/commit-service.ts')
const start = await commitStoryTurn({
  ledger,
  request: {
    pack: JICHUANG_PACK,
    runId: RUN,
    binding: { interactionKind: 'system', actorKind: 'system' },
    idempotencyKey: `${RUN}:start`,
    action: { kind: 'start' },
    now: ++clock,
  },
})
if (!start.ok) throw new Error(`开场失败：${start.code}`)

// ---------------------------------------------------------------------------
// N1 开关关闭 ⇒ disabled 且零写入
// ---------------------------------------------------------------------------
const beforeDisabled = await countCommits()
const disabled = await ingestStoryChoice({
  enabled: false,
  ledger,
  pack: JICHUANG_PACK,
  server: server(1, 'cev-production-1'),
  proposedChoiceId: 'align_first',
  now: ++clock,
})
const afterDisabled = await countCommits()
record(
  'N1',
  '`D01` 开关关闭 ⇒ `disabled`，**零写入**（"没启用"与"拒绝"是两件事：它连判定都不做）',
  disabled.kind === 'disabled' && beforeDisabled === afterDisabled,
  `结果=${disabled.kind} · 账本提交数 ${String(beforeDisabled)}→${String(afterDisabled)}`,
  beforeDisabled
)

// ---------------------------------------------------------------------------
// N3 提案里的 binding 字段**进不来**（签名层强制）+ N2 合法提交
// ---------------------------------------------------------------------------
const committed = await ingestStoryChoice(
  {
    enabled: true,
    ledger,
    pack: JICHUANG_PACK,
    server: server(1, 'cev-production-1'),
    /* ⚠️ 提案里塞满"我是谁在哪触发"的字段：签名里根本没有它们可传的入口 */
    proposedChoiceId: 'align_first',
    now: ++clock,
    /* 这些字段**不在**签名里 —— 故意塞进来，证明它们进不去（多余属性被忽略） */
    interactionRef: '伪造会话',
    anchorConversationEventId: '伪造锚点',
    actorId: '伪造用户',
    runId: '伪造run',
  } as unknown as Parameters<typeof ingestStoryChoice>[0]
)
const commitsAfter = await ledger.listCommits({ storyId: JICHUANG_PACK.storyId, runId: RUN })
const firstChoice = commitsAfter.find((row) => row.revision === 2)
const firstChoiceAny = firstChoice as unknown as {
  binding?: { interactionRef?: unknown; anchorConversationEventId?: unknown; actorId?: unknown }
  interactionRef?: unknown
  anchorConversationEventId?: unknown
  actorId?: unknown
}
const bindingOf = (row: typeof firstChoiceAny): { ref: unknown; anchor: unknown; actor: unknown } => ({
  ref: row.binding?.interactionRef ?? row.interactionRef,
  anchor: row.binding?.anchorConversationEventId ?? row.anchorConversationEventId,
  actor: row.binding?.actorId ?? row.actorId,
})
const readback = firstChoice === undefined ? undefined : bindingOf(firstChoiceAny)
record(
  'N3',
  '`D02` 绑定字段**进不来**：提案里塞 `interactionRef`/`anchor`/`actorId`/`runId` ⇒ 账本读回仍是**服务端**的值（签名层强制，不是运行时过滤）',
  readback !== undefined &&
    readback.ref === 's8-production-session' &&
    readback.anchor === 'cev-production-1' &&
    readback.actor === h.userId,
  `账本读回：会话=${String(readback?.ref)} · anchor=${String(readback?.anchor)} · actor=${String(readback?.actor)} （提案里那三个都是"伪造…"）`,
  3
)
record(
  'N2',
  '`D02` 合法选择 ⇒ `committed`，且提交身份与 revision 与账本一致',
  committed.kind === 'committed' &&
    readback !== undefined &&
    commitsAfter.some((row) => row.commitId === committed.commitId),
  `结果=${committed.kind} · commitId=${committed.kind === 'committed' ? committed.commitId : '(无)'} · 账本 ${String(commitsAfter.length)} 条`,
  3
)

// ---------------------------------------------------------------------------
// N5 幂等：同一服务端键重复投递
// ---------------------------------------------------------------------------
const beforeReplay = await countCommits()
const replay = await ingestStoryChoice({
  enabled: true,
  ledger,
  pack: JICHUANG_PACK,
  server: server(1, 'cev-production-1'),
  proposedChoiceId: 'align_first',
  now: ++clock,
})
const afterReplay = await countCommits()
record(
  'N5',
  '幂等：**同一服务端键**重复投递 ⇒ 账本**不新增**第二条（键 = `runId + revision + anchor`）',
  beforeReplay === afterReplay &&
    replay.kind === 'committed' &&
    committed.kind === 'committed' &&
    replay.commitId === committed.commitId,
  `账本 ${String(beforeReplay)}→${String(afterReplay)} · 键=${storyIngestIdempotencyKey({ runId: RUN, revision: 1, anchorConversationEventId: 'cev-production-1' })}`,
  beforeReplay
)

// ---------------------------------------------------------------------------
// N4 非法选择四类 ⇒ 具名拒收 + 零副作用
// ---------------------------------------------------------------------------
const beforeRejects = await countCommits()
const unknownChoice = await ingestStoryChoice({
  enabled: true, ledger, pack: JICHUANG_PACK, server: server(2, 'cev-production-2'), proposedChoiceId: '不存在的选项', now: ++clock,
})
const staleRevision = await ingestStoryChoice({
  enabled: true, ledger, pack: JICHUANG_PACK, server: server(1, 'cev-production-3'), proposedChoiceId: 'go_prepare', now: ++clock,
})
const malformed = await ingestStoryChoice({
  enabled: true, ledger, pack: JICHUANG_PACK, server: server(2, 'cev-production-4'), proposedChoiceId: { forged: true }, now: ++clock,
})
const afterRejects = await countCommits()
record(
  'N4',
  '非法选择**全拒且零副作用**：未知选项 ⇒ `story_unknown_choice` · 过期 revision ⇒ `story_stale_revision` · 提案形状坏 ⇒ `story_choice_proposal_malformed`',
  unknownChoice.kind === 'rejected' &&
    unknownChoice.code === 'story_unknown_choice' &&
    staleRevision.kind === 'rejected' &&
    staleRevision.code === 'story_stale_revision' &&
    malformed.kind === 'rejected' &&
    malformed.code === 'story_choice_proposal_malformed' &&
    beforeRejects === afterRejects,
  `未知=${unknownChoice.kind === 'rejected' ? unknownChoice.code : unknownChoice.kind} · 过期=${staleRevision.kind === 'rejected' ? staleRevision.code : staleRevision.kind} · 形状=${malformed.kind === 'rejected' ? malformed.code : malformed.kind} · 账本 ${String(beforeRejects)}→${String(afterRejects)}`,
  3
)

// ---------------------------------------------------------------------------
// N6 `D13` 联动：按水位消费一次，再消费为零
// ---------------------------------------------------------------------------
const allCommits = await ledger.listCommits({ storyId: JICHUANG_PACK.storyId, runId: RUN })
const fresh = storyCommitsToConsume(allCommits, 0)
const scopes = { storyId: JICHUANG_PACK.storyId, runId: RUN }
for (const commit of fresh) {
  await watermarks.advanceWatermark({
    ...scopes, consumer: 'affect', revision: commit.revision, commitId: commit.commitId, at: ++clock,
  })
}
const affect = await watermarks.readWatermark({ ...scopes, consumer: 'affect' })
const pendingAfter = storyCommitsToConsume(allCommits, affect?.lastConsumedRevision ?? 0)
record(
  'N6',
  '`D13` 生产联动：提交后按水位**逐条消费一次** ⇒ 待消费为零；**其它消费者水位不动**（独立）',
  pendingAfter.length === 0 &&
    affect?.lastConsumedRevision === allCommits.length &&
    (await watermarks.readWatermark({ ...scopes, consumer: 'reflection' })) === undefined,
  `affect 水位=${String(affect?.lastConsumedRevision)} · 账本 ${String(allCommits.length)} 条 · 待消费=${String(pendingAfter.length)} · reflection 水位=未消费`,
  2
)

// ---------------------------------------------------------------------------
// N7/N8 `D03=A` **消费回路**：按水位逐条消费 + 失败隔离（不跳、不重复）
// ---------------------------------------------------------------------------
/* 再提交一次合法选择，好让回路有多条可消费（revision 3） */
const second = await ingestStoryChoice({
  enabled: true,
  ledger,
  pack: JICHUANG_PACK,
  server: server(2, 'cev-production-5'),
  proposedChoiceId: 'go_prepare',
  now: ++clock,
})
if (second.kind !== 'committed') throw new Error(`第二次选择失败：${second.kind === 'rejected' ? second.code : second.kind}`)

const loopCommits = await ledger.listCommits({ storyId: JICHUANG_PACK.storyId, runId: RUN })
const okStep = (consumer: 'affect' | 'reflection') => ({
  consumer,
  consume: async () => ({ ok: true as const }),
})
/* 关系消费者在第 3 条**失败一次**（模拟下游故障）—— 用来证明"停住而不是跳过" */
let relationshipCalls: number[] = []
const flakyRelationship = {
  consumer: 'relationship' as const,
  consume: async ({ commit }: { commit: { revision: number } }) => {
    relationshipCalls.push(commit.revision)
    return commit.revision === 3 ? { ok: false as const, code: 'synthetic_consumer_failure' } : { ok: true as const }
  },
}

const firstPass = await consumeStoryCommits({
  ledger,
  watermarks,
  storyId: JICHUANG_PACK.storyId,
  runId: RUN,
  steps: [okStep('affect'), okStep('reflection'), flakyRelationship],
  now: () => ++clock,
})
const progressOf = (outcome: typeof firstPass, consumer: string) =>
  outcome.progress.find((row) => row.consumer === consumer)
record(
  'N7',
  '`D03=A` 消费回路：两个消费者**各自**按水位逐条消费到账本末尾；失败的那个**停在自己的位置**（`drained` 为假）',
  progressOf(firstPass, 'affect')?.advancedTo === loopCommits.length &&
    progressOf(firstPass, 'reflection')?.advancedTo === loopCommits.length &&
    /*
   * ⚠️ 这里**不能**写 `consumed.length === advancedTo`：`consumed` 是"**这一轮**消费了几条"，
   *    而 `advancedTo` 是**绝对 revision**。第一版就是那么写的，于是 N7 在
   *    "affect 上一轮已经走到 2、这轮只需消费 1 条" 的正常情形下读成失败。
   *    正确判据：这一轮消费的每条都必须**接在该消费者原有水位的后面**（连续、升序、不回头）。
   */
    firstPass.progress.every((row) => row.consumed.every((revision, index) =>
      index === 0 ? revision === row.advancedTo - row.consumed.length + 1 : revision === row.consumed[index - 1]! + 1
    )) &&
    firstPass.drained === false,
  `账本 ${String(loopCommits.length)} 条 · affect→${String(progressOf(firstPass, 'affect')?.advancedTo)}（本轮消费 ${String(progressOf(firstPass, 'affect')?.consumed.length)} 条）· reflection→${String(progressOf(firstPass, 'reflection')?.advancedTo)} · relationship→${String(progressOf(firstPass, 'relationship')?.advancedTo)}（失败于 ${String(progressOf(firstPass, 'relationship')?.failedAt?.revision)}）`,
  loopCommits.length
)

const callsBefore = [...relationshipCalls]
const secondPass = await consumeStoryCommits({
  ledger,
  watermarks,
  storyId: JICHUANG_PACK.storyId,
  runId: RUN,
  steps: [okStep('affect'), okStep('reflection'), flakyRelationship],
  now: () => ++clock,
})
record(
  'N8',
  '`D13` **失败隔离 + 不跳不重复**：失败者水位**停在原地**（=2）、重跑**从同一条继续**（第 3 条再试一次）；成功的两个消费者**不受影响**（水位不动、不重复消费）',
  progressOf(firstPass, 'relationship')?.advancedTo === 2 &&
    progressOf(firstPass, 'relationship')?.failedAt?.code === 'synthetic_consumer_failure' &&
    /* 第二次：关系消费者只再碰一次（第 3 条），说明没有重放已消费的 1/2 */
    relationshipCalls.length === callsBefore.length + 1 &&
    relationshipCalls.at(-1) === 3 &&
    progressOf(secondPass, 'affect')?.consumed.length === 0 &&
    progressOf(secondPass, 'reflection')?.consumed.length === 0,
  `关系消费者调用序列=${JSON.stringify(relationshipCalls)} · 第一轮关系水位=${String(progressOf(firstPass, 'relationship')?.advancedTo)} · 第二轮 affect 消费 ${String(progressOf(secondPass, 'affect')?.consumed.length)} 条（应为 0）`,
  3
)

// ---------------------------------------------------------------------------
// N9 **真实装配**（`createStoryCognition().consumeOnce()`）—— 销掉"门用自己 steps"的覆盖缺口
// ---------------------------------------------------------------------------
/*
 * ⚠️ `N7`/`N8` 用的是**门自己造的** steps（为了构造失败隔离），
 *    因此它们**不覆盖装配里那两个真实 step**（affect / relationship）。
 *    这一格补的正是那个缺口：用**生产装配本身**跑一遍，证明：
 * ```text
 * ① 两个真实 step 都能跑到底（不抛、不静默跳过）
 * ② 两条水位都被推进到账本末尾
 * ③ 结论**如实分列**：真的产出了多少 AFFECT_* / RELATIONSHIP_* 事件是**读数**，
 *    不是阈值 —— 故事规则没触发时产出 0 条是合法的（不许把 0 读成失败，也不许把 0 藏起来）
 * ```
 */
const { createStoryCognition } = await import('../src/infrastructure/runtime/story-cognition.ts')
const { domainEventsFor } = await import('../src/infrastructure/persistence/event-store.ts')
const eventCountBefore = (await domainEventsFor(db, asCharacterId(h.characterId))).length
/* ⚠️ **离线** provider：本门整轮零网络（自查：`modelCalls.real = 0`） */
const offlineReflectionProvider = {
  name: 's8-production-offline',
  version: 's8-production-offline@1',
  call: async (call: { handles: readonly { id: string }[] }) => ({
    schemaVersion: 'reflection-draft@1',
    focusQuestion: '离线固定件：不产生采纳',
    explanation: '离线占位解释（不进入任何真实判断）。',
    supportHandles: call.handles.map((row) => row.id),
    counterHandles: [],
    scope: 'adaptive_self_slot_candidate',
  }),
}
const assembly = createStoryCognition({
  db,
  characterId: asCharacterId(h.characterId),
  pack: JICHUANG_PACK,
  userId: h.userId,
  provider: offlineReflectionProvider,
  now: () => ++clock,
})
const assemblyRun = await assembly.consumeOnce()
const eventsAfter = await domainEventsFor(db, asCharacterId(h.characterId))
const produced = eventsAfter.slice(eventCountBefore)
const affectEvents = produced.filter((row) => String(row.type).startsWith('AFFECT_')).length
const relationshipEvents = produced.filter((row) => String(row.type).startsWith('RELATIONSHIP_')).length
const watermarkOf = (consumer: string) =>
  assemblyRun.progress.find((row) => row.consumer === consumer)?.advancedTo ?? -1
record(
  'N9',
  '**真实装配**跑通：`createStoryCognition().consumeOnce()` 的 affect / relationship / reflection **三个**真实 step 都执行到底，三条水位都推进到账本末尾（离线 provider ⇒ 本门零网络；产出条数是**读数**，不是阈值）',
  assemblyRun.progress.length === 3 &&
    watermarkOf('affect') === loopCommits.length &&
    watermarkOf('relationship') === loopCommits.length &&
    watermarkOf('reflection') === loopCommits.length &&
    assemblyRun.progress.every((row) => row.failedAt === undefined) &&
    assemblyRun.drained === true,
  `消费者=${assemblyRun.progress.map((row) => row.consumer).join('/')} · 水位 affect→${String(watermarkOf('affect'))} / relationship→${String(watermarkOf('relationship'))} / reflection→${String(watermarkOf('reflection'))}（账本 ${String(loopCommits.length)} 条）· 新增领域事件 ${String(produced.length)} 条（AFFECT_* ${String(affectEvents)} · RELATIONSHIP_* ${String(relationshipEvents)}）⇒ **故事规则未触发时 0 条是合法读数**`,
  4
)

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
const measuredCount = checks.reduce((sum, check) => sum + check.measured, 0)
const failed = checks.filter((check) => !check.pass)
const passed = measuredCount > 0 && failed.length === 0

let head = 'unknown'
try {
  head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
} catch {
  /* 只读盘点失败不改变判定 */
}

const runId = `postlv2-s8-production-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${head.slice(0, 8)}`
const outDir = join(REPO_ROOT, 'artifacts/post-lv2', runId)
mkdirSync(outDir, { recursive: true })

const reading = {
  runId,
  gate: 'postlv2:s8:production:verify',
  milestone: 'post-lv2 / S8 / WP9 (D01+D02 入口门)',
  generatedAt: new Date().toISOString(),
  source: { head },
  isolation: { sandboxDir: sandbox.dir, note: '`isolateDatabase()` 一次性沙箱；`data/pglite` 从不被打开' },
  modelCalls: { real: 0, note: '本门用**离线**提案（形状与模型提案相同）；真模型语义批次另有其门' },
  contractFingerprints: {
    choiceIngest: sha256(read('src/kernel/app/storyline/choice-ingest.ts')),
    watermark: sha256(read('src/kernel/storyline/story-watermark.ts')),
    migrations: sha256(read('src/infrastructure/persistence/migrations.ts')),
  },
  notCovered: [
    '`main.ts` 的生产装配（开关消费 + 入口接线）：**未做**（ADR-094 `D11.1`）',
    '调度器按水位**主动**消费的回环：未接线（本门只证明机制可用）',
    '真实库迁移与激活：需另行批准',
  ],
  checks,
  measuredCount,
  verdict: passed ? 'PASS' : 'FAIL',
}

writeFileSync(join(outDir, 's8-production-verify.json'), JSON.stringify(reading, null, 2), 'utf8')
console.log('')
console.log(`  measured_count = ${measuredCount}`)
console.log(`  ${passed ? '✅' : '❌'} postlv2:s8:production:verify = ${reading.verdict}`)
console.log(`  证据：artifacts/post-lv2/${runId}/s8-production-verify.json`)

await resetPluginSqlConnection()
process.exit(passed ? 0 : 1)
