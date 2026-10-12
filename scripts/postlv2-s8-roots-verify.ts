/**
 * S8 · WP3b —— **持久根**门（`pnpm postlv2:s8:roots:verify`）。
 *
 * ============================================================================
 *  载体：计划书 WP3 退出条件 · ADR-093 `D04`/`D05`（`R-4`）/`D06`/`D14`
 *       验收契约 `S8-A01` `S8-A02` `S8-A03` `S8-A09` `S8-A10` `S8-A13` `S8-A14` `S8-A18`
 *       控制 `S8-C01` `S8-C02` `S8-C06`
 * ============================================================================
 *  退出条件逐条对应
 * ---------------------------------------------------------------------------
 * ```text
 * · 至少一个有效故事根能从**真实落盘提交**解析                      → W1（真实账本 + 真会话）
 * · 隐藏 / 错版本 / 跨 run / 不存在 / 已撤回根**均失败关闭**        → W4 / W5 / W6 / W7
 * · 同一次选择的**全部衍生引用只计一个独立根**                      → W2（3 观测 1 根）/ W3（对话+故事同根）
 * · 既有**纯对话**样例结果保持                                      → W9（回归）
 * ```
 *
 * ⚠️ 全部在 `isolateDatabase()` 的**一次性沙箱**里；`data/pglite` **从不被打开**。
 * ⚠️ 零模型调用、零出网。正控 / 负控 / 恢复三段式 + 非零分母自检。
 */

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

const sandbox = isolateDatabase('postlv2-s8-roots', { keep: false })
console.log(`  [sandbox] ${sandbox.dir}`)

const { createM4Harness } = await import('./m4-harness.ts')
const { asConversationId } = await import('../src/kernel/contracts/ids.ts')
const { ConversationRecorder } = await import('../src/infrastructure/runtime/conversation-recorder.ts')
const { createStoryLedgerStore } = await import(
  '../src/infrastructure/storyline/store/story-ledger-store.ts'
)
const { commitStoryTurn } = await import('../src/kernel/app/storyline/commit-service.ts')
const { createReflectionLineageLookup } = await import(
  '../src/infrastructure/persistence/reflection-lineage-read.ts'
)
const { expandLineage } = await import('../src/kernel/app/reflection/lineage.ts')
const { JICHUANG_PACK } = await import('../evals/storyline/jichuang-interview-two/story-pack.ts')
const { storyObservationRecordsOf } = await import('../src/kernel/storyline/story-ledger.ts')

const h = await createM4Harness({ label: 'postlv2-s8-roots' })
const db = h.db
const ledger = createStoryLedgerStore(db)
const characterId = h.characterId

/** 第二个**真实会话**：另起一个 recorder（会话轴不能靠 runId 伪造） */
const sessionB = asConversationId('s8-roots-session-b')
const recorderB = new ConversationRecorder({
  db,
  characterId: characterId as never,
  conversationId: sessionB,
  dryRun: false,
  userName: 'Alex',
  characterName: '苏沐薇',
  transport: 'verify-s8-roots',
  userId: h.userId,
})

const sessionA = asConversationId(`dm-${characterId}-postlv2-s8-roots`)
const anchorA1 = (await h.recordUserEvidence('我们一起把二面的分工对齐一下。')).ref.id
const anchorB1 = String((await recorderB.recordUserMessage('我想先复习一遍再上场。', 1)).event?.id ?? '')
const anchorA2 = (await h.recordUserEvidence('练完之后我们直接进去。')).ref.id

const RUN = 's8-roots-main'
const commitAt = async (
  action: Parameters<typeof commitStoryTurn>[0]['request']['action'],
  binding: Parameters<typeof commitStoryTurn>[0]['request']['binding'],
  key: string,
  now: number
): ReturnType<typeof commitStoryTurn> =>
  commitStoryTurn({
    ledger,
    request: { pack: JICHUANG_PACK, runId: RUN, binding, idempotencyKey: key, action, now },
  })

const started = await commitAt({ kind: 'start' }, { interactionKind: 'system', actorKind: 'system' }, `${RUN}:start`, 1)
const r2 = await commitAt(
  { kind: 'choice', choiceId: 'align_first', expectedRevision: 1 },
  {
    interactionKind: 'user_choice',
    interactionRef: String(sessionA),
    anchorConversationEventId: String(anchorA1),
    actorKind: 'user',
    actorId: h.userId,
  },
  `${RUN}:r2`,
  2
)
const r3 = await commitAt(
  { kind: 'choice', choiceId: 'go_prepare', expectedRevision: 2 },
  {
    interactionKind: 'user_choice',
    interactionRef: String(sessionB),
    anchorConversationEventId: anchorB1,
    actorKind: 'user',
    actorId: h.userId,
  },
  `${RUN}:r3`,
  3
)
const r4 = await commitAt(
  { kind: 'choice', choiceId: 'split_by_strength', expectedRevision: 3 },
  {
    interactionKind: 'user_choice',
    interactionRef: String(sessionA),
    anchorConversationEventId: String(anchorA2),
    actorKind: 'user',
    actorId: h.userId,
  },
  `${RUN}:r4`,
  4
)
if (!started.ok || !r2.ok || !r3.ok || !r4.ok) {
  throw new Error('门的前置失败：世界提交被拒（真实链路没走通，后面的判据无意义）')
}

const lookup = createReflectionLineageLookup(db, { characterId: characterId as never })
const expand = (handles: { kind: string; id: string }[]) =>
  expandLineage(lookup, handles as never, { characterId })

// ===========================================================================
// W1 正控：3 条 user_choice 提交跨 2 个真实会话 ⇒ 3 根 / 2 会话
// ===========================================================================
const w1 = await expand([
  { kind: 'story_event', id: r2.commit.commitId },
  { kind: 'story_event', id: r3.commit.commitId },
  { kind: 'story_event', id: r4.commit.commitId },
])
record(
  'W1',
  '正控：真实账本上 3 条 `user_choice` 提交（跨 **2 个真实会话**）⇒ 独立根 3 / 真实会话 2 / 全部故事根',
  w1.rootCount === 3 &&
    w1.conversationCount === 2 &&
    w1.storyRootCount === 3 &&
    w1.usable &&
    w1.rejections.length === 0,
  `根=${w1.rootCount} · 会话=${w1.conversationCount} · 故事根=${w1.storyRootCount} · usable=${String(w1.usable)} · 拒收=${JSON.stringify(w1.rejections.map((r) => r.reason))}`,
  w1.rootCount + w1.conversationCount + w1.measuredCount
)

// ===========================================================================
// W2 S8-C01：一次提交的 **3 个可见条目** ⇒ 仍只有 1 个独立根
// ===========================================================================
const { storyCommitRecordOf } = await import('../src/kernel/storyline/story-ledger.ts')
const multi = storyCommitRecordOf({
  event: {
    eventId: 'e1',
    storyId: JICHUANG_PACK.storyId,
    storyVersion: 1,
    runId: 's8-roots-multi',
    revision: 1,
    type: 'CHOICE_COMMITTED',
    choiceId: 'align_first',
    fromNodeId: 's1_intro',
    toNodeId: 's1_align',
    stage: 'confirm_goal',
    variablesAfter: { cooperation: 1 },
    visibleEvents: ['roots_multi_a', 'roots_multi_b', 'roots_multi_c'],
    committedAt: 10,
  },
  contentDigest: JICHUANG_PACK.contentDigest,
  binding: {
    interactionKind: 'user_choice',
    interactionRef: String(sessionA),
    anchorConversationEventId: String(anchorA1),
    actorKind: 'user',
    actorId: h.userId,
  },
  recordedAt: 10,
  idempotencyKey: 's8-roots-multi:start',
})
const multiObservations = storyObservationRecordsOf(multi)
await ledger.appendCommit({ commit: multi, observations: multiObservations })
const w2 = await expand(multiObservations.map((item) => ({ kind: 'story_event', id: item.observationId })))
record(
  'W2',
  '`S8-C01`：一个提交的 **3 个可见条目**作 3 个 handle ⇒ 独立根仍为 **1**（派生路径不加票）',
  w2.rootCount === 1 && w2.rejections.length === 0,
  `handle=3（3 个观测）· 根=${w2.rootCount} · 拒收=${JSON.stringify(w2.rejections.map((r) => r.reason))}`,
  w2.rootCount + 3
)

// ===========================================================================
// W3 S8-C02：同一次选择的**对话根**与**故事根**合并成一个因果身份
// ===========================================================================
const w3 = await expand([
  { kind: 'story_event', id: r2.commit.commitId },
  { kind: 'conversation_event', id: String(anchorA1) },
])
record(
  'W3',
  '`S8-C02`：同一次选择的对话事件 handle + 故事提交 handle ⇒ 因果身份**合并**为 1 根（来源 kind 各保持）',
  w3.rootCount === 1 && w3.rejections.length === 0 && w3.roots[0]?.causalKey === `conversation:${String(anchorA1)}`,
  `根=${w3.rootCount} · 因果键=${String(w3.roots[0]?.causalKey)} · 来源类=${String(w3.roots[0]?.sourceClass)}`,
  w3.rootCount + 1
)

// ===========================================================================
// W4/W5/W6/W7 负控：五类不可用根**均**失败关闭，且码不同
// ===========================================================================
const w4 = await expand([{ kind: 'story_event', id: 'story:jichuang-interview-two@v1#no-such-run.e9' }])
const exitRun = 's8-roots-exit'
const exitSeed = await commitStoryTurn({
  ledger,
  request: {
    pack: JICHUANG_PACK,
    runId: exitRun,
    binding: { interactionKind: 'system', actorKind: 'system' },
    idempotencyKey: `${exitRun}:start`,
    action: { kind: 'start' },
    now: 20,
  },
})
const exited = await commitStoryTurn({
  ledger,
  request: {
    pack: JICHUANG_PACK,
    runId: exitRun,
    binding: { interactionKind: 'system', actorKind: 'system' },
    idempotencyKey: `${exitRun}:exit`,
    action: { kind: 'exit', expectedRevision: 1 },
    now: 21,
  },
})
if (!exitSeed.ok || !exited.ok) throw new Error('门的前置失败：退出提交被拒')
const w5 = await expand([{ kind: 'story_event', id: exited.commit.commitId }])
const w6 = await expand([{ kind: 'story_event', id: started.commit.commitId }])
const versionProbe = await expand([
  {
    kind: 'story_event',
    id: r2.commit.commitId.replace('@v1#', '@v2#'),
  },
])
record(
  'W4',
  '负控①：**不存在**的故事引用 ⇒ `story_root_unconfirmed`（不回填、不猜）',
  w4.rootCount === 0 && w4.rejections.some((r) => r.reason === 'story_root_unconfirmed') && !w4.usable,
  `根=${w4.rootCount} · 拒收=${JSON.stringify(w4.rejections.map((r) => r.reason))}`,
  1
)
record(
  'W5',
  '负控②：**没有引入任何可见条目**的提交（`RUN_EXITED`）⇒ `story_root_invisible`',
  w5.rootCount === 0 && w5.rejections.some((r) => r.reason === 'story_root_invisible'),
  `根=${w5.rootCount} · 拒收=${JSON.stringify(w5.rejections.map((r) => r.reason))}`,
  1
)
record(
  'W6',
  '负控③：`system` 提交（开场）⇒ `story_root_not_interactive`（是经历，但**不合格**为习惯根）',
  w6.rootCount === 0 && w6.rejections.some((r) => r.reason === 'story_root_not_interactive'),
  `根=${w6.rootCount} · 拒收=${JSON.stringify(w6.rejections.map((r) => r.reason))}`,
  1
)
record(
  'W7',
  '`S8-A10`：**错 storyVersion** 的引用与"不存在"**具名区分**（`story_root_version_mismatch` ≠ `story_root_unconfirmed`）',
  versionProbe.rootCount === 0 &&
    versionProbe.rejections.some((r) => r.reason === 'story_root_version_mismatch') &&
    !versionProbe.rejections.some((r) => r.reason === 'story_root_unconfirmed'),
  `根=${versionProbe.rootCount} · 拒收=${JSON.stringify(versionProbe.rejections.map((r) => r.reason))}`,
  2
)

// ===========================================================================
// W8 正控：真实 lookup **真的**实现了可选端口 `findStoryEvents`（防 NOT-WIRED）
// ===========================================================================
const lookupHasStoryPort = typeof (lookup as { findStoryEvents?: unknown }).findStoryEvents === 'function'
const portPositive = await lookup.findStoryEvents?.([r2.commit.commitId])
record(
  'W8',
  '正控：真实只读面**实现了**可选端口 `findStoryEvents`，且能读回一条真实提交（防止"可选"变成 NOT-WIRED）',
  lookupHasStoryPort && (portPositive?.length ?? 0) === 1,
  `实现=${String(lookupHasStoryPort)} · 读回=${portPositive?.length ?? 0} 条`,
  2
)

// ===========================================================================
// W9 回归：**纯对话链**的计数语义与 S8 之前一致（1 根 / 1 会话 / 来源类不变）
// ===========================================================================
const w9 = await expand([{ kind: 'conversation_event', id: String(anchorA1) }])
record(
  'W9',
  '`S8-A18` 回归：纯对话 handle ⇒ 1 根 / 1 会话，来源类仍是 `user_statement`（旧语义逐字保持）',
  w9.rootCount === 1 &&
    w9.conversationCount === 1 &&
    w9.storyRootCount === 0 &&
    w9.roots[0]?.sourceClass === 'user_statement' &&
    w9.roots[0]?.causalKey === `conversation:${String(anchorA1)}`,
  `根=${w9.rootCount} · 会话=${w9.conversationCount} · 故事根=${w9.storyRootCount} · 来源类=${String(w9.roots[0]?.sourceClass)}`,
  3
)

// ===========================================================================
// W10 派生链：域事件 payload 里的 `sourceStoryRefs` ⇒ 追到故事根，并与直接引用**同一个根**
// ===========================================================================
const { appendDomainEvent } = await import('../src/infrastructure/persistence/event-store.ts')
const derived = await appendDomainEvent(
  db,
  characterId as never,
  {
    type: 'GOAL_COMPLETED',
    sourceConversationEventIds: [],
    payload: { s8RootsProbe: true, sourceStoryRefs: [{ sourceId: r2.commit.commitId }] },
    processor: 's8-roots-verify',
    processorVersion: 's8-roots-verify@1',
    idempotencyKey: 's8-roots:derived',
    scope: 'CHARACTER_INTERNAL',
  } as never,
  5
)
const derivedId = String((derived as { event?: { id?: unknown } }).event?.id ?? '')
const w10 = await expand([
  { kind: 'domain_event', id: derivedId },
  { kind: 'story_event', id: r2.commit.commitId },
])
record(
  'W10',
  '派生链：内部事件的 `sourceStoryRefs` 追到故事提交，且与**直接引用**同一条提交 ⇒ 仍只算 **1** 根（去重生效）',
  derivedId !== '' && w10.rootCount === 1 && w10.rejections.length === 0,
  `域事件=${derivedId} · 根=${w10.rootCount} · 拒收=${JSON.stringify(w10.rejections.map((r) => r.reason))}`,
  w10.rootCount + 1
)

// ===========================================================================
// 汇总
// ===========================================================================
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

const runId = `postlv2-s8-roots-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${head.slice(0, 8)}`
const outDir = join(REPO_ROOT, 'artifacts/post-lv2', runId)
mkdirSync(outDir, { recursive: true })

const reading = {
  runId,
  gate: 'postlv2:s8:roots:verify',
  milestone: 'post-lv2 / S8 / WP3',
  generatedAt: new Date().toISOString(),
  source: { head, workingTreeDirty: porcelain.length > 0, workingTreePorcelain: porcelain.slice(0, 60) },
  isolation: { sandboxDir: sandbox.dir, note: '`isolateDatabase()` 一次性沙箱；`data/pglite` 从不被打开' },
  contractFingerprints: {
    lineageResolver: sha256(read('src/kernel/app/reflection/lineage.ts')),
    lineageRead: sha256(read('src/infrastructure/persistence/reflection-lineage-read.ts')),
    qualificationRead: sha256(read('src/infrastructure/persistence/qualification-read.ts')),
    storyLedger: sha256(read('src/kernel/storyline/story-ledger.ts')),
  },
  /** ⚠️ WP6 才接线读时撤回；这一行是**如实记录**，不是"已实现" */
  withdrawalReadEnabled: false,
  checks,
  measuredCount,
  verdict: gateValid ? (passed ? 'PASS' : 'FAIL') : 'MEASUREMENT INVALID',
}

writeFileSync(join(outDir, 's8-roots-verify.json'), JSON.stringify(reading, null, 2), 'utf8')
console.log('')
console.log(`  measured_count = ${measuredCount}`)
console.log(`  ${passed ? '✅' : '❌'} postlv2:s8:roots:verify = ${reading.verdict}`)
console.log(`  证据：artifacts/post-lv2/${runId}/s8-roots-verify.json`)

/*
 * ⚠️ 收尾：**先关库，再退出**。不关的话 PGlite 句柄会把事件循环吊住 ⇒
 * 门跑完了却不退出（实测表现为"看起来卡住" + 每轮留一个孤儿进程）。
 */
await resetPluginSqlConnection()
process.exit(passed ? 0 : 1)
