/**
 * 后 Lv2 · **`S7` 语义读数**（`pnpm postlv2:s7:live`）—— 计划里那个一直 `NOT RUN` 的东西。
 *
 * ============================================================================
 *  它回答契约 §1 `S7` 的**后半句**
 * ============================================================================
 * ```text
 *   一段**她真的经历过**的故事经历，经**正式 Memory 链**提交之后，
 *   在**新会话**（未加载故事全文）的**普通聊天**里，能不能被检索追忆？
 * ```
 * 机制面四跳（适配 → 放行口受理 → 召回取得到 → 溯源读回）已在 §0.3b 实测；
 * 本脚本量的是**最后那一跳的语义**。
 *
 * ---------------------------------------------------------------------------
 *  两阶段语义（**必须跨进程/跨 runtime** 才叫"新会话"）
 * ---------------------------------------------------------------------------
 * ```text
 * 阶段一：生产库**副本** → 折叠故事 → 取世界观测 → 经正式 Memory 链提交 episode
 * 阶段二：**重开**（新 runtime / 新会话 / **不**加载故事）→ 真实召回读面 → 同 ID 对账
 * ```
 * ⚠️ 判据取**真实召回读面**，**不**取她的措辞 —— 措辞层没有启发式守卫是 `DR-11`
 *    的既有立场；靠读她的句子下结论就是这个仓库反复禁止的那类推断。
 *
 * ⚠️ 安全：真实库**只被 `cpSync` 复制，从未被打开**（与 `m11.1-production-preview` 同范式）。
 */

import 'dotenv/config'

import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

import { isolateDatabase, PRODUCTION_DB_DIR } from '../src/dev/sandbox.ts'

/* ⚠️ `isolateDatabase` 必须在**任何会碰数据库的东西之前**调用（AGENTS.md §7） */
const sandbox = isolateDatabase('postlv2-s7-live', { keep: true })

const REPO_ROOT = resolve(process.cwd())

console.log('='.repeat(74))
console.log('后 Lv2 · S7 语义读数（生产库副本 + 新会话普通聊天）')
console.log('='.repeat(74))

/* ===========================================================================
 * 阶段零：把生产库**复制**成副本
 * =========================================================================== */
const copySource = PRODUCTION_DB_DIR
const copyTarget = sandbox.dir
if (!existsSync(join(copyTarget, 'PG_VERSION'))) {
  mkdirSync(copyTarget, { recursive: true })
  cpSync(copySource, copyTarget, { recursive: true })
  console.log(`生产库已**复制**（未打开）：${copySource}\n                     → ${copyTarget}`)
} else {
  console.log(`副本已存在（复用）：${copyTarget}`)
}

/* --- 动态 import：与离线门同一范式（isolateDatabase 之后才装数据库相关模块） --- */
const { createM4Harness } = await import('./m4-harness.ts')
const { startStory, advanceFromProposal } = await import('../src/kernel/storyline/world-machine.ts')
const { worldObservationsOf } = await import('../src/kernel/storyline/world-observation.ts')
const { JICHUANG_PACK } = await import('../evals/storyline/jichuang-interview-two/story-pack.ts')
const { asCharacterId } = await import('../src/kernel/contracts/ids.ts')
const { entityRef } = await import('../src/kernel/contracts/entity.ts')
const { createMemoryRetrievalStore } = await import(
  '../src/infrastructure/persistence/memory-retrieval-store.ts'
)
const { createMemoryRecallService } = await import('../src/kernel/app/recall/retrieval.ts')
const { createRecallRequest } = await import('../src/kernel/contracts/recall.ts')
const { rootReadingsByMemory } = await import(
  '../src/infrastructure/persistence/qualification-read.ts'
)
const { memoryIntegrityProblems } = await import(
  '../src/infrastructure/persistence/memory-integrity.ts'
)
const { DEFAULT_CONTEXT_BUDGET } = await import('../src/kernel/recall/selector.ts')
const { stringToUuid } = await import('@elizaos/core')

const userId = stringToUuid('user-Alex')

/* ===========================================================================
 * 阶段一：折叠故事 → 取世界观测 → 经**正式 Memory 链**提交 episode
 * =========================================================================== */
console.log('\n=== 阶段一：故事经历 → 正式 Memory 链 ===')

const h = await createM4Harness({ label: 'postlv2-s7-live' })
const characterId = asCharacterId(String(h.characterId))

const seed = startStory({ pack: JICHUANG_PACK, runId: 's7live', now: 1_800_000_000_000 })
const step = advanceFromProposal(JICHUANG_PACK, seed.state, {
  proposedBy: 'user_choice',
  choiceId: 'ask_scope',
  expectedRevision: seed.state.revision,
  expectedStoryVersion: JICHUANG_PACK.storyVersion,
})
if (!step.ok) {
  console.error(`❌ 故事步被拒：${step.code} ${step.detail}`)
  process.exit(2)
}
console.log(`故事折叠到节点 ${String(step.state.currentNodeId)}（revision ${step.state.revision}）`)

const render = (eventId: string): string => `（已提交的剧情事件：${eventId}）`
const observations = worldObservationsOf({ state: step.state, renderText: render })
console.log(`世界观测 = ${observations.length} 条`)
if (observations.length === 0) {
  console.error('❌ 没有世界观测 ⇒ 本读数**没有对象**，MEASUREMENT INVALID')
  process.exit(2)
}
const firstObservation = observations[0]!

/*
 * ⚠️ 记忆内容写成**她真的会经历到的东西**（不是"测试数据"）：
 *    这样阶段二问起来才有语义可言。
 */
const storySummary = '我们一起准备极创工作室的二面：她看过我的简历，我们约好二面聊项目。'
const candidate = h.makeCandidate(
  'episode',
  {
    kind: 'episode',
    summary: storySummary,
    occurredAt: 1_800_000_000_000,
    participants: [{ kind: 'user', id: String(userId) }],
    eventRefs: [firstObservation.storySourceId],
  } as never,
  {
    sourceRefs: [{ kind: 'observation', id: firstObservation.storySourceId } as never],
    evidenceRootIds: [firstObservation.storySourceId],
    /*
     * ⚠️ **必须是 `MemoryAuthority`，不是 `SourceAuthority`**。
     * 第一版我写了 `'USER_EXPLICIT'`（那是 `SourceAuthority`），
     * 因为 `as never` 把类型检查挡住了 —— 于是运行期在资格层抛
     * `unknown_memory_authority`，整条召回被中断。
     * 正确值由 `authorityFromSource('STORY_OBSERVATION')` 给出 = `DIRECT_INTERACTION`。
     */
    authority: 'DIRECT_INTERACTION',
    epistemicStatus: 'asserted',
    subjects: [{ kind: 'user', id: String(userId) }],
    importance: 0.7,
    confidence: 0.7,
  } as never
)
const commit = await h.tryCommit(candidate, 1)
const storyMemoryId = String(candidate.proposedId)
console.log(
  `episode 提交：受理=${String(commit.accepted > 0)} · 拒绝码=${JSON.stringify(commit.rejected ?? [])}\n` +
    `  memoryId = ${storyMemoryId}\n  storySourceId = ${firstObservation.storySourceId}`
)

const rootMap = await rootReadingsByMemory(h.db, [storyMemoryId])
const rootCount = [...(rootMap.get(storyMemoryId) ?? [])].length
console.log(`根读数 = ${rootCount} 条（\`PL2-SR-01\`：故事来源没有持久根 ⇒ 预期 0）`)

/* 阶段一收尾：关库（唯一实现） */
await h.stop()

/* ===========================================================================
 * 阶段二：**重开**（新 harness / 新会话 / 不加载故事）→ 真实召回读面
 * =========================================================================== */
console.log('\n=== 阶段二：新会话普通聊天（真实召回读面）===')

const h2 = await createM4Harness({ label: 'postlv2-s7-live-2' })
/*
 * ⚠️ 阶段二**只**问一句普通人会问的话。
 * 我们**不**把故事事实塞进任何地方 —— 这正是排除"prompt 里给了答案"的关键。
 */
const QUESTION = '对了，我们之前是不是聊过我找工作的事？'

const recallService = createMemoryRecallService({
  port: createMemoryRetrievalStore({
    store: h2.store,
    integrity: (owner: unknown) => memoryIntegrityProblems(h2.db, owner as never),
    rootReadings: (ids) => rootReadingsByMemory(h2.db, ids),
  }),
})
const recallOutcome = await recallService.retrieveCandidates(
  createRecallRequest({
    traceId: 'trace:s7-live-recall' as never,
    characterId: String(characterId),
    user: entityRef('user', String(userId)),
    query: { text: QUESTION },
    intent: 'current_fact',
    contextBudget: { memoryTokens: DEFAULT_CONTEXT_BUDGET.memoryTokens },
  })
)
const hit = recallOutcome.candidates.find((item) => String(item.memoryId) === storyMemoryId)
const recalled = hit !== undefined
const sourcesSurvived =
  hit !== undefined &&
  (hit.sourceRefs ?? []).some((ref) => String(ref.id) === firstObservation.storySourceId)

/*
 * 正控：**同一批**候选里，说明召回口本身是好的（不是"什么都没召回到"）。
 * 没有正控的"取到了"与"读取口坏了但恰好命中"分不开 —— 本工程的老教训。
 */
const positiveControl = recallOutcome.candidates.length > 0

/* ---------------------------------------------------------------------------
 * 第二轮：**真模型**跑完一整轮（这才是"普通聊天里她真的看得见"的那个读数）
 * ---------------------------------------------------------------------------
 * ⚠️ 关键判据：**这条故事记忆有没有真的进她这一轮看到的 prompt**。
 *    取的是**编译出来的 prompt**（`gateway.promptFor(packet)`），不是"我们以为它进了"。
 * ⚠️ 她的**措辞不作判据**（`DR-11`）：措辞只作为**可人工复核的样本**留档。
 */
console.log('\n--- 真模型一整轮（新会话、普通问句、不注入任何故事事实）---')
const { TurnGateway } = await import('../src/kernel/app/turn-gateway.ts')
const { callModelText } = await import('../src/infrastructure/runtime/adapters.ts')
const { ConversationRecorder } = await import(
  '../src/infrastructure/runtime/conversation-recorder.ts'
)
const { createHumanConsoleUserTurnIngress, createCharacterAssistantTurnIngress } = await import(
  '../src/infrastructure/runtime/conversation-attribution.ts'
)
const { character } = await import('../src/character/index.ts')
const { asConversationId } = await import('../src/kernel/contracts/ids.ts')

const liveConversationId = asConversationId('postlv2-s7-new-session')
const recorder = new ConversationRecorder({
  db: h2.db,
  characterId: String(characterId),
  conversationId: liveConversationId,
  dryRun: false,
  userId: h2.userId,
  userName: 'Alex',
  characterName: character.name,
  transport: 'postlv2-s7-live',
  attribution: [createHumanConsoleUserTurnIngress(), createCharacterAssistantTurnIngress()],
} as never)

/*
 * ⚠️ **必须接 `recall` 端口** —— 第一版我漏了它，于是 `TurnGateway` 的
 * `recallForTurn` 直接返回 `not_searched / port_not_wired`（turn-gateway.ts:2475），
 * 记忆区块自然是空的。**那是我测试台的缺陷，不是产品的** ——
 * 它差点被我写成"入模这一跳坏了"的结论。
 * 现在按生产同一形状接线（与 `main.ts:1074` 的 `recall: this.buildRecallTurnPort()` 同源）。
 */
const { createRecallTurnPort } = await import('../src/kernel/app/recall/turn.ts')
const recallPort = createRecallTurnPort({
  service: recallService,
  budget: DEFAULT_CONTEXT_BUDGET,
  now: () => Date.now(),
})

const gateway = new TurnGateway({
  kernel: h2.kernel,
  definition: h2.kernel.definition,
  identity: h2.kernel.identitySnapshot,
  recorder,
  conversationSequence: () => 1,
  recentLimit: 16,
  slowPathEnabled: false,
  userId: h2.userId,
  recall: recallPort,
  recallEnabled: true,
  recallBudget: { ...DEFAULT_CONTEXT_BUDGET },
} as never)

const turn = await gateway.beginTurn(QUESTION)
const packet = await gateway.compileTurn({ turn, currentInput: QUESTION, recentLines: [] } as never)
const prompt = gateway.promptFor(packet)
const modelCall = await callModelText(h2.runtime, prompt)
const liveReply = modelCall.text
await gateway.completeTurn({ turn, replyText: liveReply } as never)

/*
 * 诊断：**这一轮真正入模的是哪几条记忆**。
 * ⚠️ 不看这个就只能说"没进 prompt"，说不出**为什么** —— 而"为什么"决定该怎么办。
 * 判据只读 id 与计数（**不**把内容写进证据）。
 */
/*
 * ⚠️ **不要从 packet 里猜字段名**（第一版按 `section.text` 取，全报 0 字符 ——
 *    与"prompt 有 3271 字符"自相矛盾）。判据直接取自**编译出来的 prompt 本身**，
 *    它是她**真的会读到**的那一份，也是唯一不会读错的来源。
 */
const memoryBlockStart = prompt.indexOf('记忆') >= 0 ? prompt.indexOf('记忆') : -1
const promptHasMemoryHeader = /记忆|记忆片段|MEMORY/.test(prompt)
/* 她的回复里有没有出现这段经历的关键词（**只作观察**，不作判据） */
const replyMentionsStory =
  /简历|二面|极创|面试|找工作/.test(liveReply)
/* 真正写入 prompt 的记忆正文：用"内容有没有出现"来判，而不是字段名 */
const memoryInPrompt =
  prompt.includes(storySummary) ||
  prompt.includes(firstObservation.storySourceId) ||
  prompt.includes(storyMemoryId) ||
  prompt.includes('她看过我的简历')

/*
 * 诊断：**这一轮 recall 端口的完整决策链**。
 * ⚠️ 这是回答"为什么没进 prompt"的**唯一权威来源** ——
 *    端口把每条候选恰好放进一支（资格拒 / 排序淘汰 / 选中 / 预算裁掉），
 *    少了它就只能猜。我们只读 **id 与理由码**，不读正文。
 */
const recallTurnOutcome = await recallPort.run(
  createRecallRequest({
    traceId: 'trace:s7-live-turn' as never,
    characterId: String(characterId),
    user: entityRef('user', String(userId)),
    query: { text: QUESTION },
    intent: 'current_fact',
    contextBudget: { memoryTokens: DEFAULT_CONTEXT_BUDGET.memoryTokens },
  })
)
const traceRecord = recallTurnOutcome.trace as unknown as {
  selectedIds?: readonly string[]
  decisions?: readonly { memoryId?: string; eligible?: boolean; reason?: string }[]
  exclusionHistogram?: Record<string, number>
}
console.log('\n--- recall 端口决策链（诊断）---')
console.log(
  `扫描 ${String((recallTurnOutcome.trace as unknown as { scanned?: number }).scanned)} 行 · ` +
    `宽召回 ${String((recallTurnOutcome.trace as unknown as { candidateCount?: number }).candidateCount)} 条 · ` +
    `过资格 ${String((recallTurnOutcome.trace as unknown as { eligibleCount?: number }).eligibleCount)} 条 · ` +
    `入选 ${String((recallTurnOutcome.trace as unknown as { selectedIds?: readonly string[] }).selectedIds?.length ?? 0)} 条`
)
console.log(`淘汰直方图 = ${JSON.stringify(traceRecord.exclusionHistogram ?? {})}`)
console.log(
  `**显式召回（同一个问题）**：候选 ${recallOutcome.candidates.length} 条 · ` +
    `含故事记忆 = ${String(recallOutcome.candidates.some((c) => String(c.memoryId) === storyMemoryId))}`
)
console.log(
  `故事记忆在（端口）选中里 = ${String((traceRecord.selectedIds ?? []).map(String).includes(storyMemoryId))}`
)

console.log(`prompt 长度 = ${prompt.length} 字符`)
console.log(`prompt 里有记忆区块表头 = ${String(promptHasMemoryHeader)}（位置 ${memoryBlockStart}）`)
console.log(`故事记忆进入她的 prompt = ${String(memoryInPrompt)}`)
console.log(`她的回复提到故事关键词 = ${String(replyMentionsStory)}（**仅观察**）`)
console.log(`她的回复（**仅样本，不作判据**）：${liveReply.slice(0, 200)}`)

await h2.stop()

/* ===========================================================================
 * 读数与证据
 * =========================================================================== */
const semanticRecallPassed = recalled && sourcesSurvived && positiveControl && memoryInPrompt
const verdict = semanticRecallPassed
  ? 'PASS'
  : /* ⚠️ 分列：**召回层通过、入模层没通过** —— 这是两种不同的失败，不许合成一个"FAIL" */
    recalled && sourcesSurvived
    ? 'FAIL_RECALLED_BUT_NOT_IN_PROMPT'
    : 'FAIL_NOT_RECALLED'
const readings = {
  storyNode: String(step.state.currentNodeId),
  observationCount: observations.length,
  storyMemoryId,
  storySourceId: firstObservation.storySourceId,
  commitAccepted: commit.accepted > 0,
  commitRejected: (commit.rejected ?? []) as string[],
  qualifiedRootCount: rootCount,
  question: QUESTION,
  recallCandidateCount: recallOutcome.candidates.length,
  positiveControl,
  storyMemoryRecalled: recalled,
  storySourceSurvivedRecall: sourcesSurvived,
  /* ⭐ 这一条才是"她真的看得见"：故事记忆进了她这一轮**实际看到的 prompt** */
  memoryInPrompt,
  promptChars: prompt.length,
  promptHasMemoryHeader,
  memoryBlockStart,
  /* 观察（不作判据）：她的话里有没有出现这段经历的关键词 */
  replyMentionsStory,
  /** 她的自述与她**实际看到的东西**是否一致（措辞仍不作判据，只作一致性观察） */
  liveReplySaysNoRecord: /没有.*记录|没法确认|没有能对得上|没记录|什么事。你说清楚/.test(liveReply),
  /* ⚠️ **样本**，不作判据（DR-11） */
  liveReplySample: liveReply,
  liveReplyChars: liveReply.length,
}
console.log('\n=== 读数 ===')
console.log(JSON.stringify(readings, null, 2))

let head = 'unknown'
try {
  head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
} catch {
  /* 只读盘点失败不改变判定 */
}
const runId = `postlv2-s7-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${head.slice(0, 8)}`
const outDir = join(REPO_ROOT, 'artifacts/post-lv2', runId)
mkdirSync(outDir, { recursive: true })
const artifact = {
  runId,
  gate: 'postlv2:s7:live',
  milestone: 'post-lv2 / S7 semantic reading (new session, ordinary question)',
  generatedAt: new Date().toISOString(),
  source: { head },
  environment: {
    database: '生产库**副本**（cpSync；真实库从未被打开）',
    productionDir: copySource,
    sandboxCopyDir: copyTarget,
    model: process.env.OPENAI_LARGE_MODEL ?? 'unknown',
    endpointHost: (() => {
      try {
        return new URL(process.env.OPENAI_BASE_URL ?? '').toString()
      } catch {
        return 'unknown'
      }
    })(),
  },
  readings,
  verdict,
  notClaimed: [
    '不主张措辞自然：判据是**真实召回读面 + prompt 实际内容**，不是她的句子（DR-11）',
    '不主张情绪/关系更新：那是 S8，本脚本不碰',
    '不主张真实库状态：全程只读**副本**',
    '不主张 `person_fact`/`preference` 面：那被 `PL2-SR-01` 挡住（故事来源没有持久根）',
  ],
}
writeFileSync(join(outDir, 's7-live.json'), JSON.stringify(artifact, null, 2), 'utf8')

console.log('')
console.log(`  ${semanticRecallPassed ? '✅' : '❌'} postlv2:s7:live = ${artifact.verdict}`)
console.log(
  `  同 ID 对账：memoryId 命中=${String(recalled)} · 确定性故事来源随召回出来=${String(sourcesSurvived)} · 正控(有候选)=${String(positiveControl)}`
)
console.log(`  证据：artifacts/post-lv2/${runId}/s7-live.json`)
process.exit(semanticRecallPassed ? 0 : 1)
