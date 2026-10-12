/**
 * S8 · WP6 —— **失效 / 重复 / 恢复**门（`pnpm postlv2:s8:lifecycle:verify`）。
 *
 * ============================================================================
 *  载体：计划书 WP6 退出条件 · ADR-093 `D12`/`D13` · 验收契约
 *        `S8-A31` `S8-A32` `S8-A34` `S8-A36`
 * ============================================================================
 *  退出条件逐条对应
 * ---------------------------------------------------------------------------
 * ```text
 * · 失效后旧反思/槽位**不再入模**                     → L3（撤回 → 复用 WP5 的入模读数）
 * · replay / 换 run / 重启**不复活**                  → L4（投影 rebuild 后重读）
 * · 同一提交对各消费者**至多一次**已提交影响           → L5（幂等键撞键，零新增事件）
 * · 撤回**不**物理删除原始世界历史                     → L6（账本行数逐字相同）
 * ```
 *
 * ⚠️ 全部在 `isolateDatabase()` 的**一次性沙箱**里；`data/pglite` **从不被打开**。
 * ⚠️ 零真实模型调用（provider 是离线固定件）。
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

const sandbox = isolateDatabase('postlv2-s8-lifecycle', { keep: false })
console.log(`  [sandbox] ${sandbox.dir}`)

const { createM4Harness, M4_T0 } = await import('./m4-harness.ts')
const { asConversationId } = await import('../src/kernel/contracts/ids.ts')
const { ConversationRecorder } = await import('../src/infrastructure/runtime/conversation-recorder.ts')
const {
  createHumanConsoleUserTurnIngress,
  createCharacterAssistantTurnIngress,
} = await import('../src/infrastructure/runtime/conversation-attribution.ts')
const { runReflectionWindow } = await import('../src/infrastructure/runtime/reflection-runner.ts')
const { readUsableAdaptiveSelfStates, readCurrentReflectionFactPack } = await import(
  '../src/infrastructure/runtime/reflection-current-state.ts'
)
const { listReflectionRecords } = await import('../src/infrastructure/persistence/reflection-store.ts')
const { listAdaptiveSelfStates } = await import(
  '../src/infrastructure/persistence/adaptive-self-store.ts'
)
const { rebuildAdaptiveSelfProjections } = await import(
  '../src/infrastructure/persistence/adaptive-self-store.ts'
)
const { appendDomainEvent, domainEventsFor } = await import(
  '../src/infrastructure/persistence/event-store.ts'
)
const { latestDomainEventSequence } = await import(
  '../src/infrastructure/persistence/reflection-input-source.ts'
)
const { TurnGateway } = await import('../src/kernel/app/turn-gateway.ts')
const { DEFAULT_CONTEXT_BUDGET } = await import('../src/kernel/recall/selector.ts')
const { REFLECTION_DRAFT_SCHEMA_VERSION, REFLECTION_DRAFT_SCOPE } = await import(
  '../src/kernel/contracts/reflection.ts'
)
const { createReflectionLineageLookup } = await import(
  '../src/infrastructure/persistence/reflection-lineage-read.ts'
)
const { expandLineage } = await import('../src/kernel/app/reflection/lineage.ts')
const { createStoryLedgerStore } = await import(
  '../src/infrastructure/storyline/store/story-ledger-store.ts'
)
const { commitStoryTurn } = await import('../src/kernel/app/storyline/commit-service.ts')
const { JICHUANG_PACK } = await import('../evals/storyline/jichuang-interview-two/story-pack.ts')
const { storySourceRefOf } = await import('../src/kernel/contracts/source-authority.ts')
const { STORY_EXPERIENCE_RETRACTED } = await import('../src/kernel/contracts/story-events.ts')
const { storyStateEligibilityOf } = await import('../src/kernel/app/storyline/state-evaluators.ts')
const { storyCommitsToConsume } = await import('../src/kernel/storyline/story-watermark.ts')
const { createStoryWatermarkStore } = await import(
  '../src/infrastructure/storyline/store/story-watermark-store.ts'
)
const { sql } = await import('drizzle-orm')
const { rowsOf } = await import('../src/infrastructure/persistence/db.ts')

let clock = M4_T0
const h = await createM4Harness({ label: 'postlv2-s8-lifecycle' })
const characterId = h.kernel.characterId
const db = h.db
const ledger = createStoryLedgerStore(db)

// ---------------------------------------------------------------------------
// 前置：3 次真实选择跨 2 个真实会话 + 一次真实反思（复用 WP5 的链）
// ---------------------------------------------------------------------------
const recorders = [0, 1].map(
  (index) =>
    new ConversationRecorder({
      db,
      characterId,
      conversationId: asConversationId(`s8-lifecycle-s${String(index)}`),
      dryRun: false,
      userId: h.userId,
      userName: 'Alex',
      characterName: '苏沐薇',
      transport: 'postlv2-s8-lifecycle',
      attribution: [createHumanConsoleUserTurnIngress(), createCharacterAssistantTurnIngress()],
    })
)
const anchors: string[] = []
for (let index = 0; index < 3; index += 1) {
  const recorded = await recorders[index % 2]!.recordUserMessage(
    `隔离用故事语料第 ${String(index)} 条。`,
    Math.floor(index / 2) + 1
  )
  anchors.push(String(recorded.event!.id))
}

const RUN = 's8-lifecycle-main'
await commitStoryTurn({
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
for (const [index, choiceId] of ['align_first', 'go_prepare', 'split_by_strength'].entries()) {
  const outcome = await commitStoryTurn({
    ledger,
    request: {
      pack: JICHUANG_PACK,
      runId: RUN,
      binding: {
        interactionKind: 'user_choice',
        interactionRef: `s8-lifecycle-s${String(index % 2)}`,
        anchorConversationEventId: anchors[index]!,
        actorKind: 'user',
        actorId: h.userId,
      },
      idempotencyKey: `${RUN}:r${String(index + 1)}`,
      action: { kind: 'choice', choiceId, expectedRevision: index + 1 },
      now: ++clock,
    },
  })
  if (!outcome.ok) throw new Error(`前置失败：${outcome.code}`)
}
const commits = await ledger.listCommits({ storyId: JICHUANG_PACK.storyId, runId: RUN })
const eligible = commits.filter(
  (item) => storyStateEligibilityOf({ commit: item, anchorSequence: 1 }).eligible
)
const storyRefs = eligible.map((item) =>
  storySourceRefOf({ sourceId: item.commitId, experienceScope: 'story_experience' })
)
const handles = storyRefs.map((ref) => ({ kind: 'story_event' as const, id: ref.sourceId }))

const provider = {
  name: 's8-lifecycle-offline',
  version: 's8-lifecycle@1',
  async call(call: { handles: readonly { id: string }[] }) {
    return {
      schemaVersion: REFLECTION_DRAFT_SCHEMA_VERSION,
      focusQuestion: '对象含糊时是否先核对？',
      explanation: '候选解释（不是外部事实）。',
      supportHandles: call.handles.map((row) => row.id),
      counterHandles: [],
      scope: REFLECTION_DRAFT_SCOPE,
      suggestedSlot: 'clarify_when_ambiguous' as const,
    }
  },
}

async function appendTrigger(key: string, refs: readonly { sourceId: string }[]): Promise<number> {
  const before = await latestDomainEventSequence(db, characterId)
  await appendDomainEvent(
    db,
    characterId,
    {
      type: 'GOAL_COMPLETED',
      operation: 's8-lifecycle-fixture',
      payload: {
        goalId: `goal:${key}`,
        basis: 'user_report',
        expectedRevision: 1,
        sourceStoryRefs: refs.map((ref) => ({ sourceId: ref.sourceId })),
      },
      sourceConversationEventIds: [],
      idempotencyKey: `s8-lifecycle:${key}`,
      processor: 's8-lifecycle',
      processorVersion: 's8-lifecycle@1',
      scope: 'CHARACTER_INTERNAL',
    } as never,
    ++clock
  )
  return before
}

async function adaptiveSelfSectionCount(budget: number): Promise<number> {
  const gateway = new TurnGateway({
    kernel: h.kernel,
    definition: h.kernel.definition,
    identity: h.kernel.identitySnapshot,
    recorder: h.recorder,
    conversationSequence: h.nextTurnSequence,
    recentLimit: 16,
    slowPathEnabled: false,
    userId: h.userId,
    recallBudget: { ...DEFAULT_CONTEXT_BUDGET, adaptiveSelfTokens: budget },
  })
  const turn = await gateway.beginTurn('隔离入口：帮我核对当前对象。')
  const packet = await gateway.compileTurn({
    turn,
    currentInput: '隔离入口：帮我核对当前对象。',
    recentLines: [],
    buildAdaptiveSelfStates: () => readUsableAdaptiveSelfStates(db, characterId, h.userId),
    buildReflectionFactPack: () => readCurrentReflectionFactPack(db, characterId, h.userId),
  })
  await gateway.completeTurn({ turn, replyText: '（离线占位回复）', modelDurationMs: 0 })
  return packet.sections.filter((row) => row.id === 'adaptive-self').length
}

async function ledgerCounts(): Promise<{ commits: number; observations: number }> {
  const commitRows = rowsOf(await db.execute(sql.raw('select count(*)::int as c from storyline_commits')))
  const observationRows = rowsOf(
    await db.execute(sql.raw('select count(*)::int as c from storyline_observations'))
  )
  return {
    commits: Number(commitRows[0]?.c ?? 0),
    observations: Number(observationRows[0]?.c ?? 0),
  }
}

// ---------------------------------------------------------------------------
// L1 失效前：撤回集合为空 ⇒ 3 根可用，且**真实采纳 + 实际入模**成立
// ---------------------------------------------------------------------------
const lookup = createReflectionLineageLookup(db, { characterId })
const beforeLineage = await expandLineage(lookup, handles, { characterId: String(characterId) })
const triggerWatermark = await appendTrigger('before', storyRefs)
const beforeOutcome = await runReflectionWindow(db, {
  characterId,
  activeUserId: h.userId,
  watermark: triggerWatermark,
  adaptiveEnabled: true,
  provider: provider as never,
  now: () => ++clock,
})
const beforeSection = await adaptiveSelfSectionCount(300)
record(
  'L1',
  '正控（失效前）：撤回集合为空 ⇒ 3 个故事根可用；真实反思 accepted；槽位采纳后 **实际入模** 有 section',
  beforeLineage.rootCount === 3 &&
    beforeLineage.rejections.length === 0 &&
    beforeOutcome.kind === 'accepted' &&
    beforeSection === 1,
  `根=${String(beforeLineage.rootCount)} 拒收=${JSON.stringify(beforeLineage.rejections.map((r) => r.reason))} · 反思=${beforeOutcome.kind} · section=${String(beforeSection)}`,
  beforeLineage.rootCount + beforeSection + 1
)

// ---------------------------------------------------------------------------
// L6 撤回**不**物理删除世界账本
// ---------------------------------------------------------------------------
const beforeCounts = await ledgerCounts()
const withdrawnRef = storyRefs[0]!
await appendDomainEvent(
  db,
  characterId,
  {
    type: STORY_EXPERIENCE_RETRACTED,
    operation: 's8-lifecycle-retraction',
    payload: {
      characterId: String(characterId),
      withdrawnStoryRefs: [withdrawnRef],
      reason: 'user_withdrew',
      withdrawnAt: ++clock,
      note: '隔离用例：用户撤回这段体验的认知使用资格',
    },
    sourceConversationEventIds: [],
    idempotencyKey: 's8-lifecycle:retract-1',
    processor: 's8-lifecycle',
    processorVersion: 's8-lifecycle@1',
    scope: 'CHARACTER_INTERNAL',
  } as never,
  ++clock
)
const afterCounts = await ledgerCounts()
record(
  'L6',
  '`D12`：撤回**不**物理删除世界历史 —— `storyline_commits` / `storyline_observations` 行数逐字相同',
  beforeCounts.commits === afterCounts.commits &&
    beforeCounts.observations === afterCounts.observations,
  `提交 ${String(beforeCounts.commits)}→${String(afterCounts.commits)} · 观测 ${String(beforeCounts.observations)}→${String(afterCounts.observations)}`,
  beforeCounts.commits + afterCounts.observations
)

// ---------------------------------------------------------------------------
// L2 读时判定：撤回的提交 ⇒ `story_root_withdrawn`（具名拒收，不是"悄悄少一个根"）
// ---------------------------------------------------------------------------
const lookupAfter = createReflectionLineageLookup(db, { characterId })
const afterLineage = await expandLineage(lookupAfter, handles, { characterId: String(characterId) })
const withdrawnOnly = await expandLineage(
  lookupAfter,
  [{ kind: 'story_event' as const, id: withdrawnRef.sourceId }],
  { characterId: String(characterId) }
)
record(
  'L2',
  '`D12` 读时判定：被撤回的提交单独解析 ⇒ `story_root_withdrawn`；混合集合里它也被剔除（不是"悄悄少一个根"）',
  withdrawnOnly.rootCount === 0 &&
    withdrawnOnly.rejections.some((r) => r.reason === 'story_root_withdrawn') &&
    afterLineage.rootCount === 2 &&
    afterLineage.rejections.some((r) => r.reason === 'story_root_withdrawn'),
  `单独=根${String(withdrawnOnly.rootCount)}/${JSON.stringify(withdrawnOnly.rejections.map((r) => r.reason))} · 混合=根${String(afterLineage.rootCount)}/${JSON.stringify(afterLineage.rejections.map((r) => r.reason))}`,
  2
)

// ---------------------------------------------------------------------------
// L3 失效后：旧槽位**不再入模**
// ---------------------------------------------------------------------------
const sectionAfterRetraction = await adaptiveSelfSectionCount(300)
const usableAfter = await readUsableAdaptiveSelfStates(db, characterId, h.userId)
const enhancedAfter = usableAfter.filter((state) => state.level === 'enhanced')
record(
  'L3',
  '`S8-A36`：撤回之后旧槽位**不再入模**（`adaptive-self` section = 0；且"可用状态"里不再有 enhanced）',
  sectionAfterRetraction === 0 && enhancedAfter.length === 0,
  `section=${String(sectionAfterRetraction)} · 可用 enhanced 槽=${String(enhancedAfter.length)} · 全部槽=${JSON.stringify(usableAfter.map((state) => `${state.slot}:${state.level}`))}`,
  2
)

// ---------------------------------------------------------------------------
// L4 replay / rebuild **不复活**
// ---------------------------------------------------------------------------
const events = await domainEventsFor(db, characterId)
await rebuildAdaptiveSelfProjections(db, characterId, events as never)
const sectionAfterRebuild = await adaptiveSelfSectionCount(300)
const usableAfterRebuild = await readUsableAdaptiveSelfStates(db, characterId, h.userId)
const lineageAfterRebuild = await expandLineage(createReflectionLineageLookup(db, { characterId }), handles, {
  characterId: String(characterId),
})
record(
  'L4',
  '`S8-A34`：投影 rebuild 之后**仍不**入模（撤回是读时判定 ⇒ 重建无法复活它）',
  sectionAfterRebuild === 0 &&
    usableAfterRebuild.filter((state) => state.level === 'enhanced').length === 0 &&
    lineageAfterRebuild.rejections.some((r) => r.reason === 'story_root_withdrawn'),
  `rebuild 后 section=${String(sectionAfterRebuild)} · enhanced=${String(usableAfterRebuild.filter((s) => s.level === 'enhanced').length)} · 追根拒收=${JSON.stringify(lineageAfterRebuild.rejections.map((r) => r.reason))}`,
  2
)

// ---------------------------------------------------------------------------
// L5 `D13` 至多一次：同一触发材料重放 ⇒ 零新增事件
// ---------------------------------------------------------------------------
const beforeReplay = (await domainEventsFor(db, characterId)).length
const replayOutcome = await runReflectionWindow(db, {
  characterId,
  activeUserId: h.userId,
  watermark: triggerWatermark,
  adaptiveEnabled: true,
  provider: provider as never,
  now: () => ++clock,
})
const afterReplay = (await domainEventsFor(db, characterId)).length
record(
  'L5',
  '`S8-A31`/`D13` 至多一次：同一窗口重放 ⇒ **零**新增领域事件（既有输入已处理，保持终态；不再次请求模型）',
  beforeReplay === afterReplay && replayOutcome.eventsWritten === 0,
  `领域事件 ${String(beforeReplay)}→${String(afterReplay)} · 重放结果=${replayOutcome.kind} · eventsWritten=${String(replayOutcome.eventsWritten)}`,
  beforeReplay
)

// ---------------------------------------------------------------------------
// L7 `D13`/`D03=A` 独立水位：三个消费者各走各的，互不阻挡、互不跳过
// ---------------------------------------------------------------------------
const watermarkStore = createStoryWatermarkStore(db)
const watermarkScope = { storyId: JICHUANG_PACK.storyId, runId: RUN }
/*
 * ⚠️ 夹具必须**逐级**推进：水位是"这个消费者按顺序消费到第几条"，
 * 从 0 直接推到 2 就是**跳号**（第一条永远没人消费）—— 那正是 `D13` 要防的事，
 * 所以 L8 判它 gap 是**对的**。第一版这里每个消费者只推一次且 revision 各不相同，
 * 于是后两个消费者都撞上 gap（门当场读出来：advanced=[true,false,false]）。
 * 正确的"独立"读法是：**各自逐级走，走到不同的终点**。
 */
const wmSteps = [
  { consumer: 'affect' as const, revision: 1 },
  { consumer: 'relationship' as const, revision: 1 },
  { consumer: 'reflection' as const, revision: 1 },
  { consumer: 'affect' as const, revision: 2 },
  { consumer: 'relationship' as const, revision: 2 },
  { consumer: 'affect' as const, revision: 3 },
]
const wmResults = []
for (const step of wmSteps) {
  wmResults.push(
    await watermarkStore.advanceWatermark({
      ...watermarkScope,
      consumer: step.consumer,
      revision: step.revision,
      commitId: eligible[step.revision - 1]!.commitId,
      at: ++clock,
    })
  )
}
const wmListed = await watermarkStore.listWatermarks(watermarkScope)
const wmByConsumer = new Map(wmListed.map((row) => [row.consumer, row.lastConsumedRevision]))
record(
  'L7',
  '`D13`/`D03=A` **独立水位**：三个消费者各走各的（1/2/3），一条推进**不**动别人的水位（互不阻挡、互不跳过）',
  wmResults.every((row) => row.advanced) &&
    wmByConsumer.get('reflection') === 1 &&
    wmByConsumer.get('relationship') === 2 &&
    wmByConsumer.get('affect') === 3 &&
    wmListed.length === 3,
  `水位：${JSON.stringify([...wmByConsumer.entries()].map(([c, r]) => `${c}=${String(r)}`))} · 行数=${String(wmListed.length)} · 每次 advanced=${JSON.stringify(wmResults.map((row) => row.advanced))}`,
  3
)

// ---------------------------------------------------------------------------
// L8 只许前进 / 不许跳号 —— 拒收时**零写入**
// ---------------------------------------------------------------------------
const beforeL8 = JSON.stringify(await watermarkStore.listWatermarks(watermarkScope))
const notForward = await watermarkStore.advanceWatermark({
  ...watermarkScope,
  consumer: 'affect',
  revision: 3,
  commitId: eligible[2]!.commitId,
  at: ++clock,
})
const gap = await watermarkStore.advanceWatermark({
  ...watermarkScope,
  consumer: 'reflection',
  revision: 3,
  commitId: eligible[2]!.commitId,
  at: ++clock,
})
const afterL8 = JSON.stringify(await watermarkStore.listWatermarks(watermarkScope))
record(
  'L8',
  '水位**只许前进、不许跳号**：重放同一 revision ⇒ `story_watermark_not_forward`；跳号（1→3）⇒ `story_watermark_gap`；两种拒收**都零写入**',
  notForward.advanced === false &&
    notForward.reason === 'story_watermark_not_forward' &&
    gap.advanced === false &&
    gap.reason === 'story_watermark_gap' &&
    beforeL8 === afterL8,
  `重放=${notForward.advanced ? 'advanced(不该)' : notForward.reason} · 跳号=${gap.advanced ? 'advanced(不该)' : gap.reason} · 拒收前后水位逐字相同=${String(beforeL8 === afterL8)}`,
  2
)

// ---------------------------------------------------------------------------
// L9 至多一次：同一批提交 + 同一水位 ⇒ 待消费集合逐字相同；推进后不再重复
// ---------------------------------------------------------------------------
const allCommits = await ledger.listCommits({ storyId: JICHUANG_PACK.storyId, runId: RUN })
const affectWatermark = wmByConsumer.get('affect') ?? 0
const pending = storyCommitsToConsume(allCommits, affectWatermark)
const pendingReplay = storyCommitsToConsume(allCommits, affectWatermark)
const afterAdvance = storyCommitsToConsume(allCommits, 4)
record(
  'L9',
  '`D13` **至多一次**：重放同一批 ⇒ 待消费集合逐字相同；水位走到底 ⇒ 待消费为**空**（同一提交不会对同一消费者二次生效）',
  pending.length === allCommits.filter((row) => row.revision > affectWatermark).length &&
    JSON.stringify(pending) === JSON.stringify(pendingReplay) &&
    afterAdvance.length === 0,
  `affect 水位=${String(affectWatermark)} ⇒ 待消费 ${String(pending.length)} 条 · 重放一致=${String(JSON.stringify(pending) === JSON.stringify(pendingReplay))} · 走到底待消费=${String(afterAdvance.length)} · 账本共 ${String(allCommits.length)} 条`,
  allCommits.length
)

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
const measuredCount = checks.reduce((sum, check) => sum + check.measured, 0)
const failed = checks.filter((check) => !check.pass)
const gateValid = measuredCount > 0
const passed = gateValid && failed.length === 0

let head = 'unknown'
let porcelain: string[] = []
try {
  head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  porcelain = execFileSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
} catch {
  /* 只读盘点失败不改变判定 */
}

const runId = `postlv2-s8-lifecycle-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${head.slice(0, 8)}`
const outDir = join(REPO_ROOT, 'artifacts/post-lv2', runId)
mkdirSync(outDir, { recursive: true })

const reading = {
  runId,
  gate: 'postlv2:s8:lifecycle:verify',
  milestone: 'post-lv2 / S8 / WP6',
  generatedAt: new Date().toISOString(),
  source: { head, workingTreeDirty: porcelain.length > 0, workingTreePorcelain: porcelain.slice(0, 60) },
  isolation: { sandboxDir: sandbox.dir, note: '`isolateDatabase()` 一次性沙箱；`data/pglite` 从不被打开' },
  modelCalls: { real: 0, note: 'provider 是离线固定件' },
  contractFingerprints: {
    storyEvents: sha256(read('src/kernel/contracts/story-events.ts')),
    lineageRead: sha256(read('src/infrastructure/persistence/reflection-lineage-read.ts')),
    lineageResolver: sha256(read('src/kernel/app/reflection/lineage.ts')),
  },
  notCovered: [
    '**独立故事水位**（每消费者一条）本身尚未接线：本门证的是"同一窗口重放零新增"，不是"多消费者各自的水位推进"',
    '迟到结果覆盖新 revision（需要 revision 竞赛夹具）= 未做',
    '真进程重启（WP2 的 store 门已覆盖账本侧；本门覆盖投影 rebuild 侧）',
    '真模型语义评测与行为对照（WP7）',
  ],
  checks,
  measuredCount,
  verdict: gateValid ? (passed ? 'PASS' : 'FAIL') : 'MEASUREMENT INVALID',
}

writeFileSync(join(outDir, 's8-lifecycle-verify.json'), JSON.stringify(reading, null, 2), 'utf8')
console.log('')
console.log(`  measured_count = ${measuredCount}`)
console.log(`  ${passed ? '✅' : '❌'} postlv2:s8:lifecycle:verify = ${reading.verdict}`)
console.log(`  证据：artifacts/post-lv2/${runId}/s8-lifecycle-verify.json`)

await resetPluginSqlConnection()
process.exit(passed ? 0 : 1)
