/**
 * 后 Lv2 · WP2d —— **故事来源能否成为证据根**（`pnpm postlv2:source-root:verify`）。
 *
 * ============================================================================
 *  载体：ADR-091 `D05`/`D06` · 故事世界来源契约 `S7`/`S9`/`S10`
 * ============================================================================
 * 这个门要回答一个**具体的、可判定的**问题：
 *
 * ```text
 * 一条以"故事观测"为证据的记忆，能不能在**真实**的 Memory 放行口上被受理？
 * 受理之后，它还能不能拿到**根证据资格**（`rootReadingsByMemory` 读得出来）？
 * ```
 *
 * ⚠️ 它不是"实现注册表"，而是**量具**：无论答案是有还是没有，它都如实记下来。
 * 这是计划 §10"WP0 若发现需超出既有来源适配的冻结语义变更，应按实际范围重估并报告"
 * 那条纪律的落地 —— 先量，再决定要不要动冻结面。
 *
 * 全离线：隔离库 + 真实 `createMemoryMutationValidator`；不发模型请求。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import 'dotenv/config'
import { isolateDatabase } from '../src/dev/sandbox.ts'

import { asCharacterId, asConversationId } from '../src/kernel/contracts/ids.ts'
import { JICHUANG_PACK } from '../evals/storyline/jichuang-interview-two/story-pack.ts'
import { advanceFromProposal, startStory } from '../src/kernel/storyline/world-machine.ts'
import { worldObservationsOf } from '../src/kernel/storyline/world-observation.ts'

const REPO_ROOT = resolve(process.cwd())

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

const sandbox = isolateDatabase('postlv2-source-root')
console.log(`  [sandbox] ${sandbox.dir}`)

const { createM4Harness } = await import('./m4-harness.ts')
const { stringToUuid } = await import('@elizaos/core')
const { evidenceRef, EVIDENCE_KINDS } = await import('../src/kernel/contracts/memory.ts')
const { rootReadingsByMemory } = await import(
  '../src/infrastructure/persistence/qualification-read.ts'
)

const h = await createM4Harness({ label: 'postlv2-source-root' })
const characterId = asCharacterId(h.characterId)
const conversationId = asConversationId('postlv2-source-root')
const userId = stringToUuid('user-Alex')

// ===========================================================================
// R1 适配器本身：真实故事步 → 观测集（可见性 / 幂等 / 来源身份）
// ===========================================================================
const seed = startStory({ pack: JICHUANG_PACK, runId: 'run-root', now: 1 })
const step = advanceFromProposal(JICHUANG_PACK, seed.state, {
  proposedBy: 'user_choice',
  choiceId: 'ask_scope',
  expectedRevision: seed.state.revision,
  expectedStoryVersion: JICHUANG_PACK.storyVersion,
})
if (!step.ok) throw new Error(`故事步被拒：${step.code} ${step.detail}`)

const render = (eventId: string): string => `（已提交的剧情事件：${eventId}）`
const observations = worldObservationsOf({ state: step.state, renderText: render })
const again = worldObservationsOf({ state: step.state, renderText: render })
const idsUnique = new Set(observations.map((item) => item.storySourceId)).size === observations.length
const deterministic = JSON.stringify(again) === JSON.stringify(observations)
record(
  'R1',
  '适配器：真实故事步 → 观测集；来源 id 唯一且**确定性**（同一状态两次适配逐字节相同）',
  observations.length > 0 && idsUnique && deterministic,
  `观测=${observations.length} 条 · id 唯一=${String(idsUnique)} · 确定性=${String(deterministic)} · id=${observations.map((o) => o.storySourceId).join(' , ')}`,
  observations.length + 2
)

/*
 * 负控①：**经历集合里有、可见集合里没有** ⇒ 拒绝
 * ⚠️ 这一支才是可达的：`experiencedEventIds` 是从 `visibleEventIds` 派生的，
 *    因此"可见但未经历"要**手工构造**才能出现（那是"数据不变量被破坏"的形态）。
 */
let invisibleRefused = false
let invisibleCode = 'none'
try {
  worldObservationsOf({
    state: {
      ...step.state,
      visibleEventIds: [],
      experiencedEventIds: [...step.state.experiencedEventIds],
    },
    renderText: render,
  })
} catch (error) {
  invisibleRefused = true
  invisibleCode = (error as { code?: string }).code ?? 'unknown'
}
record(
  'R2',
  '负控①：经历集合有、可见集合没有 ⇒ **拒绝**（"她其实没看见"与"我们没渲染"必须可区分）',
  invisibleRefused && invisibleCode === 'world_observation_not_visible',
  `拒绝=${String(invisibleRefused)} · code=${invisibleCode}`,
  2
)

/*
 * 负控②：**可见集合里有、经历集合里没有** ⇒ 拒绝（INV-PL2-07 的phantom 形态）
 * ⚠️ 这一支需要**手工**破坏不变量才能出现（正常状态里两个集合由同一个折叠路径产生、恒等）。
 *    因此它是"如果有人把可见集合写坏了"的守卫，而不是日常路径。
 */
let phantomRefused = false
let phantomCode = 'none'
try {
  worldObservationsOf({
    state: {
      ...step.state,
      visibleEventIds: [...step.state.visibleEventIds, 'ending_passed_together'],
    },
    renderText: render,
  })
} catch (error) {
  phantomRefused = true
  phantomCode = (error as { code?: string }).code ?? 'unknown'
}
record(
  'R3',
  '负控②：可见集合里混进**未经历**的事件 ⇒ 适配器**拒绝**（不是悄悄过滤掉）',
  phantomRefused && phantomCode === 'world_observation_phantom_visibility',
  `拒绝=${String(phantomRefused)} · code=${phantomCode}`,
  2
)

// 负控③：不同 runId / version ⇒ 不同来源身份（两次重开是**两次**经历）
const rerun = startStory({ pack: JICHUANG_PACK, runId: 'run-root-2', now: 1 })
const rerunStep = advanceFromProposal(JICHUANG_PACK, rerun.state, {
  proposedBy: 'user_choice',
  choiceId: 'ask_scope',
  expectedRevision: rerun.state.revision,
  expectedStoryVersion: JICHUANG_PACK.storyVersion,
})
if (!rerunStep.ok) throw new Error('第二次故事步被拒')
const rerunObservations = worldObservationsOf({ state: rerunStep.state, renderText: render })
const sameEventDifferentRun =
  rerunObservations[0]!.eventId === observations[0]!.eventId &&
  rerunObservations[0]!.storySourceId !== observations[0]!.storySourceId
record(
  'R4',
  '负控③：同一条剧情事件在**两次重开**里得到**不同**来源身份（不会被折进同一次经历）',
  sameEventDifferentRun,
  `事件=${observations[0]!.eventId} · run-1=${observations[0]!.storySourceId} · run-2=${rerunObservations[0]!.storySourceId}`,
  2
)

// ===========================================================================
// R5 契约面：EvidenceKind 里**没有**"故事来源"这一类
// ===========================================================================
record(
  'R5',
  '契约面读数：`EvidenceKind` 的登记值（故事来源只能借 `observation` 这一类）',
  true,
  `EvidenceKind=${JSON.stringify([...EVIDENCE_KINDS])}`,
  EVIDENCE_KINDS.length
)

// ===========================================================================
// R6 **真实放行口**：以故事观测为证据的记忆提案能不能被受理
// ===========================================================================
const observationRef = evidenceRef('observation', observations[0]!.storySourceId)
/*
 * ⚠️ 这里**不伪造**一条对话事件来"让它过"：本门要量的正是
 * "只有故事观测做证据"这种真实形态。若放行口拒绝它，那就是**发现**，不是本门的失败。
 *
 * 候选由 harness 的 `makeCandidate` 构造（与其它 M4 门同一条路径），
 * 提交走 `h.tryCommit`（它返回**拒绝码**而不是抛错 —— 与本门"先量再判"的姿态一致）。
 */
const candidate = h.makeCandidate(
  'episode',
  {
    kind: 'episode',
    summary: '我们一起把二面的范围写成了三条备忘。',
    occurredAt: 1,
    participants: [{ kind: 'user', id: String(userId) }],
    /*
     * ⚠️ `eventRefs` 是 episode 内容的**必填**字段（`createMemoryCandidate` 会展开它）。
     * 第一版漏了 ⇒ 构造期抛 `eventRefs is not iterable`，门在 R6 之前就断了。
     * 这里填**故事来源 id**：那正是本门要量的形态（故事事件作为这次经历的引用）。
     */
    eventRefs: [observations[0]!.storySourceId],
  } as never,
  {
    sourceRefs: [observationRef],
    evidenceRootIds: [observations[0]!.storySourceId],
    authority: 'DIRECT_INTERACTION',
    epistemicStatus: 'asserted',
    subjects: [{ kind: 'user', id: String(userId) }],
    importance: 0.5,
    confidence: 0.6,
  } as never
)

let validatorOutcome: { accepted: boolean; rejected: string[]; detail?: string } = {
  accepted: false,
  rejected: [],
}
try {
  const outcome = await h.tryCommit(candidate, 1)
  validatorOutcome = {
    accepted: outcome.accepted > 0 && outcome.record !== null,
    rejected: outcome.rejected,
    ...(outcome.rejected.length > 0 ? { detail: outcome.rejected.join(' , ').slice(0, 220) } : {}),
  }
} catch (error) {
  validatorOutcome = {
    accepted: false,
    rejected: ['threw'],
    detail: (error instanceof Error ? error.message : String(error)).slice(0, 220),
  }
}
record(
  'R6',
  '**真实放行口**：以故事观测（`observation` 类证据）为**唯一**证据的 episode 提案 —— 受理或拒绝，如实记录',
  true,
  `受理=${String(validatorOutcome.accepted)} · 拒绝码=${JSON.stringify(validatorOutcome.rejected)} · ${String(validatorOutcome.detail ?? '')}`,
  1
)

// ===========================================================================
// R7 根证据读取：故事来源的记忆能不能拿到根读数
// ===========================================================================
/*
 * ⚠️ 判据必须**三段式**，否则 `0 条根读数` 有两种读法而分不开：
 *   （a）这条记忆真的没有根；           （b）它有根，只是**读取口按 kind 过滤掉了**。
 * 两者在输出上完全一样（都是 0）。因此要一个**正控**：
 *   用同一个读取口读一条**以 `conversation_event` 为根**的记忆 ⇒ 它必须读得出根。
 * 只有这样，"故事来源的记忆 = 0 条"才能被读成 (b)。
 */
const storyMemoryId = String(candidate.proposedId)
const storyRoots = await (async (): Promise<number> => {
  const map = await rootReadingsByMemory(h.db, [storyMemoryId])
  return [...(map.get(storyMemoryId) ?? [])].length
})()

// 正控：一条以对话事件为**根**的真实记忆
const controlEvidence = await h.recordUserEvidence('对照组：请记住我周日要去极创工作室。')
const controlCandidate = h.makeCandidate(
  'episode',
  {
    kind: 'episode',
    summary: '对照组：用户说他周日要去极创工作室。',
    occurredAt: 2,
    participants: [{ kind: 'user', id: String(userId) }],
    eventRefs: [String(controlEvidence.ref.id)],
  } as never,
  {
    sourceRefs: [controlEvidence.ref as never],
    evidenceRootIds: [String(controlEvidence.ref.id)],
    authority: 'EXPLICIT_USER_STATEMENT',
    epistemicStatus: 'asserted',
    subjects: [{ kind: 'user', id: String(userId) }],
    importance: 0.5,
    confidence: 0.6,
  } as never
)
const controlCommit = await h.tryCommit(controlCandidate, 2)
const controlMemoryId = String(controlCandidate.proposedId)
const controlRoots = await (async (): Promise<number> => {
  const map = await rootReadingsByMemory(h.db, [controlMemoryId])
  return [...(map.get(controlMemoryId) ?? [])].length
})()

record(
  'R7',
  '**根证据读取（三段式）**：以对话事件为根的记忆读得出根（正控）；以**故事观测**为根的记忆读出 **0** 条 —— 证明读取口按 kind 过滤，而不是"这条记忆没有根"',
  controlRoots > 0 && storyRoots === 0,
  `正控（conversation_event 根）=${controlRoots} 条 · 故事来源（observation 根）=${storyRoots} 条 · ` +
    `对照提交=${String(controlCommit.accepted > 0)} · 读取口按 kind 过滤 ⇒ PL2-SR-01 成立`,
  2
)

// ===========================================================================
// R8 这个缺口**到底影响谁**（把发现的半径量准，而不是留给推测）
// ===========================================================================
/*
 * `memoryQualificationOf` 的第 1 条是 `if (!qualificationAppliesTo(type)) return 不适用`，
 * 而 `qualificationAppliesTo` 只认 `person_fact` / `preference`。
 * ⇒ "故事来源的记忆拿不到根"这件事：
 *     · 对 **episode / self_experience**（故事经历的主战场）：**不适用**资格规则，0 根不影响；
 *     · 对 **person_fact / preference**：拿到 `UNCONFIRMED_ORIGIN`（失败关闭）⇒
 *       按**未确立来源**对待（排序降档 + prompt 标签），而不是被拒或静默当作用户事实。
 * 这**恰好**是计划 §5.4 想要的语义（"模拟经历不能升级成现实事实"），
 * 所以本门把它记成"**当前行为可辩护**，但标签的语义精确性待裁"，
 * 而不是记成"必须修的缺陷"。
 */
const { qualificationAppliesTo, memoryQualificationOf } = await import(
  '../src/kernel/recall/qualification.ts'
)
const { COGNITIVE_QUALIFICATION_RULE_VERSION } = await import(
  '../src/kernel/contracts/attribution.ts'
)
const storyQualification = memoryQualificationOf({
  memoryType: 'episode',
  rootReadings: [],
  ruleVersion: COGNITIVE_QUALIFICATION_RULE_VERSION,
})
const storyFactQualification = memoryQualificationOf({
  memoryType: 'person_fact',
  rootReadings: [],
  ruleVersion: COGNITIVE_QUALIFICATION_RULE_VERSION,
})
record(
  'R8',
  '缺口半径：`episode` **不适用**资格规则（0 根无影响，返回 `undefined`）；`person_fact` 在 0 根下取 `UNCONFIRMED_ORIGIN`（失败关闭 = 与计划 §5.4 同向）',
  qualificationAppliesTo('episode') === false &&
    qualificationAppliesTo('person_fact') === true &&
    storyQualification === undefined &&
    storyFactQualification === 'UNCONFIRMED_ORIGIN',
  `episode 适用=${String(qualificationAppliesTo('episode'))} → ${String(storyQualification)}（不适用 = undefined）· ` +
    `person_fact 适用=${String(qualificationAppliesTo('person_fact'))} → ${String(storyFactQualification)}`,
  4
)

// ===========================================================================
// R9 **真实召回**：故事来源的 episode 能不能被检索到（S7 的"可追忆"面）
// ===========================================================================
/*
 * R6 证明"能进库"、R7/R8 证明"根读数拿不到但半径有限"。还差**最后一跳**：
 * 这条记忆在真实召回链上**能不能被取出来**？取不出来 ⇒ "结束故事后仍能追忆"
 * 就是一句空话；取得出来 ⇒ episode 面的 `S7` 在**机制**上成立（语义质量另判）。
 *
 * ⚠️ 全离线：真实 `createMemoryRetrievalStore` + 真实 `createMemoryRecallService`，
 *    不发模型请求。查询词用**故事里她真的感知到的那句话**（不是随便造的词）。
 */
const { createMemoryRetrievalStore } = await import(
  '../src/infrastructure/persistence/memory-retrieval-store.ts'
)
const { createMemoryRecallService } = await import('../src/kernel/app/recall/retrieval.ts')
const { createRecallRequest } = await import('../src/kernel/contracts/recall.ts')
const { entityRef } = await import('../src/kernel/contracts/entity.ts')
const { DEFAULT_CONTEXT_BUDGET } = await import('../src/kernel/recall/selector.ts')
const { memoryIntegrityProblems } = await import(
  '../src/infrastructure/persistence/memory-integrity.ts'
)

const recallService = createMemoryRecallService({
  port: createMemoryRetrievalStore({
    store: h.store,
    integrity: (owner) => memoryIntegrityProblems(h.db, owner),
    rootReadings: (ids) => rootReadingsByMemory(h.db, ids),
  }),
})
const owner = h.owner
const recallOutcome = await recallService.retrieveCandidates(
  createRecallRequest({
    traceId: 'trace:postlv2-source-root-recall' as never,
    characterId: String(h.characterId),
    user: entityRef('user', String(h.user.id)),
    query: { text: '我们一起把二面的范围写成了三条备忘' },
    intent: 'current_fact',
    contextBudget: { memoryTokens: DEFAULT_CONTEXT_BUDGET.memoryTokens },
  })
)
const storyCandidate = recallOutcome.candidates.find(
  (candidate) => String(candidate.memoryId) === storyMemoryId
)
const recalledStoryMemory = storyCandidate !== undefined
record(
  'R9',
  '**真实召回**：故事来源的 episode 能被检索到（S7 的"可追忆"在**机制**上成立；语义质量另判）',
  recalledStoryMemory,
  `候选=${recallOutcome.candidates.length} 条 · 含故事来源记忆=${String(recalledStoryMemory)} · ` +
    `候选 id=${JSON.stringify(recallOutcome.candidates.map((c) => String(c.memoryId)))}`,
  Math.max(1, recallOutcome.candidates.length)
)

/*
 * R9b：召回出来的候选**还带着故事来源引用吗**？
 * ⚠️ 这是"追忆时能说明它来自哪一次极创二面体验"（计划 §5.4 表格最后一列）的机器形态：
 *    如果候选的 `sourceRefs` 里丢了那条 `story:<id>@v<n>#<run>.<event>`，
 *    那么"她记得"与"她记得这是哪次经历"就是两件事，而后者正是本工程要保住的。
 */
const candidateSourceRefs = [...(storyCandidate?.sourceRefs ?? [])].map(
  (ref) => `${ref.kind}:${ref.id}`
)
const sourceRefSurvivedRecall = candidateSourceRefs.includes(
  `observation:${observations[0]!.storySourceId}`
)
record(
  'R9b',
  '**来源随召回一起出来**：候选的 `sourceRefs` 仍带那条确定性故事来源 id（可回答"这是哪一次体验"）',
  sourceRefSurvivedRecall,
  `候选 sourceRefs=${JSON.stringify(candidateSourceRefs)}`,
  Math.max(1, candidateSourceRefs.length)
)

// ===========================================================================
// R10/R11 边界自检（ADR-092 `D04`：把"结构性不可能"钉成机器判据）
// ===========================================================================
/*
 * `PL2-SR-01` 的裁定**依赖**一条不可能性：对话事件**不可能**带 `sourceKind = 'story_fact'`
 * （`assertSourceConsistency` 的输入域是 `ActorType`，而 `story_fact` 不在 actor 派生的四个值里）。
 * 因此本裁定**拒绝**了"让故事事件也写一条对话侧的行"这个候选修法。
 *
 * ⚠️ 下面两条判据的作用是：**如果哪天有人把这条不可能性改掉了，裁定会被当场推翻**，
 *    而不是静默失效。判据本身是**负控**（构造一次真实的拒绝），不是"没人这么写"。
 */
const { canWriteStoryFactAsConversationEvent, storySourceAxes } = await import(
  '../src/kernel/storyline/world-observation.ts'
)
const { createConversationEvent } = await import('../src/kernel/contracts/conversation-event.ts')

let storyAsConversationRefused = false
let storyAsConversationCode = 'none'
try {
  createConversationEvent({
    characterId,
    conversationId,
    conversationSequence: 1,
    sequence: 1,
    type: 'system_event',
    actorType: 'system',
    actorId: 'story-runtime',
    content: '（剧情里发生了一件事）',
    sourceKind: 'story_fact',
  } as never)
} catch (error) {
  storyAsConversationRefused = true
  storyAsConversationCode = (error as { code?: string }).code ?? 'unknown'
}
record(
  'R10',
  '**边界负控**：真实事件构造器**拒绝**把 `story_fact` 声明成对话事件的来源（ADR-092 `D01` 的那条不可能性）',
  storyAsConversationRefused &&
    storyAsConversationCode === 'source_kind_actor_mismatch' &&
    canWriteStoryFactAsConversationEvent() === false,
  `拒绝=${String(storyAsConversationRefused)} · code=${storyAsConversationCode} · canWrite=${String(canWriteStoryFactAsConversationEvent())}`,
  3
)

// 正向自证：同一个构造器对**合法**的 actor 派生来源照常接受（证明上面的"拒"不是恒响）
let legitimateAccepted = false
let legitimateCode = 'none'
try {
  createConversationEvent({
    characterId,
    conversationId,
    conversationSequence: 2,
    sequence: 2,
    type: 'system_event',
    actorType: 'system',
    actorId: 'postlv2-probe',
    content: '（一条合法的系统事件）',
  } as never)
  legitimateAccepted = true
} catch (error) {
  legitimateCode = (error as { code?: string }).code ?? 'unknown'
}
const axes = storySourceAxes()
record(
  'R11',
  '负控反向自证 + 三轴归位：合法系统事件照常被接受；故事来源在三根轴上各归各位（记忆证据借 `observation`、对话来源**不可用**、认知类别 `story_experience`）',
  legitimateAccepted &&
    axes.memoryEvidenceKind === 'observation' &&
    axes.conversationEventSourceKind === 'NOT_AVAILABLE' &&
    axes.epistemicSource === 'story_experience',
  `合法事件接受=${String(legitimateAccepted)}（code=${legitimateCode}）· 三轴=${JSON.stringify(axes)}`,
  4
)

// ===========================================================================
// 汇总与证据
// ===========================================================================
const measuredCount = checks.reduce((sum, check) => sum + check.measured, 0)
const failedChecks = checks.filter((check) => !check.pass)
const gateValid = measuredCount > 0
const passed = gateValid && failedChecks.length === 0

let head = 'unknown'
try {
  head = (await import('node:child_process')).execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  }).trim()
} catch {
  /* 只读盘点失败不改变判定 */
}

const runId = `postlv2-source-root-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${head.slice(0, 8)}`
const outDir = join(REPO_ROOT, 'artifacts/post-lv2', runId)
mkdirSync(outDir, { recursive: true })
const reading = {
  runId,
  gate: 'postlv2:source-root:verify',
  milestone: 'post-lv2 / WP2d (can a story observation be a memory root?)',
  generatedAt: new Date().toISOString(),
  source: { head },
  evidenceKinds: [...EVIDENCE_KINDS],
  observation: {
    storySourceId: observations[0]!.storySourceId,
    eventId: observations[0]!.eventId,
    count: observations.length,
  },
  validatorOutcome,
  rootReadingCount: storyRoots,
  rootReadingControl: {
    conversationRootedMemoryRoots: controlRoots,
    controlCommitted: controlCommit.accepted > 0,
  },
  /*
   * ⚠️ **发现**（结构，不是推测）：`rootReadingsByMemory` 的 SQL 里写死
   *   `l.evidence_kind = 'conversation_event'`
   * ⇒ "只有 observation 类根"的记忆**永远**拿到 0 条根读数，
   *   于是它拿不到 person_fact / preference 的资格。
   *   这与 Observation **不落库**（M3.5 §84）是同一条事实的两面：
   *   观测是**内存中的派生视图**，它不能作为一个**持久根**被引用。
   */
  structuralFinding: {
    id: 'PL2-SR-01',
    /** ADR-092 `POSTLV2-SR-01-20261003-01`：接受现状 + 把边界钉成机器判据 */
    ruling: 'docs/adr/ADR-092-pl2-sr-01-story-durable-root-ruling.md',
    summary:
      '故事来源的**持久根**在当前架构里没有位置：observation 不落库，而根读取口只认 conversation_event',
    consequence:
      '以故事经历为唯一来源的记忆会拿到 0 条根读数 ⇒ person_fact / preference 无法取得资格；' +
      'episode / self_experience 不适用资格规则（无影响）',
    reader: 'src/infrastructure/persistence/qualification-read.ts（rootReadingsByMemory）',
    decided: {
      accepted: '接受现状 + 把边界钉成机器判据（canWriteStoryFactAsConversationEvent / storySourceAxes；门 R10/R11）',
      rejected:
        '复用 conversation_event —— 结构性不可能（createConversationEvent 的 assertSourceConsistency 只接 ActorType），' +
        '实际做法只能是伪装（INV-PL2-02）',
      deferred: '新建持久根类别（需故事事件表 + 根解析 + 各评估器输入面 + 迁移与冻结面回归）',
    },
    residuals: ['L-PL2-01 标签精确性', 'L-PL2-02 候选 1 的四项前置', 'L-PL2-03 无持久故事账本'],
  },
  checks,
  measuredCount,
  verdict: gateValid ? (passed ? 'PASS' : 'FAIL') : 'MEASUREMENT INVALID',
}
writeFileSync(join(outDir, 'source-root-verify.json'), JSON.stringify(reading, null, 2), 'utf8')

console.log('')
console.log(`  measured_count = ${measuredCount}`)
console.log(`  ${passed ? '✅' : '❌'} postlv2:source-root:verify = ${reading.verdict}`)
console.log(`  ℹ️ 结构发现 PL2-SR-01 **已裁定**（ADR-092）：接受现状 + 边界机器化；候选 2 拒绝、候选 1 推迟（详见证据 JSON 与 ADR）`)
console.log(`  证据：artifacts/post-lv2/${runId}/source-root-verify.json`)

try {
  await h.stop()
} catch (error) {
  console.log(`  (收尾告警，不影响判定：${error instanceof Error ? error.message : String(error)})`)
}

void conversationId
process.exit(passed ? 0 : 1)
