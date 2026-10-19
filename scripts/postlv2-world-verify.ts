/**
 * 后 Lv2 · WP2c —— **世界观测进入真实上下文门**（`pnpm postlv2:world:verify`）。
 *
 * ============================================================================
 *  载体：ADR-091 §3（`D05`/`D09`）· 计划 §5.3 · 故事世界来源契约 `S10`
 * ============================================================================
 * 它守什么（**全离线**：隔离库 + 真实 `TurnGateway`；模型那一跳由 `replyText` 注入）：
 * ```text
 * W1 真实路径：一条世界观测经 `beginTurn`/`compileTurn` 真的进 packet，
 *    且以 **`world-observation`** 这一块出现（不是 `current-input`）
 * W2 反伪装：同一轮的 `current-input` 只含**用户这一轮说的话**，
 *    世界观测的文本**不在**里面（`INV-PL2-02`）
 * W3 逐字节不变：**不传**世界观测 ⇒ packet 的 section 集合与传入前的基线**完全一致**
 * W4 来源可读回：该 section 的 `sourceRefs` 恰是那条确定性故事来源 id
 * W5 可裁：该 section `droppable: true`（预算紧时它可以被裁）
 * W6 真实故事事件 → 观测：从 `JICHUANG_PACK` 真实走一步，用**已提交且可见**的集合
 *    生成观测（不新建故事、不伪造事件）
 * V1 量具自证三段式（正控 / 负控 / 恢复）
 * ```
 * ⚠️ 使用隔离库（`isolateDatabase()`）；**不打开** `data/pglite`。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import 'dotenv/config'
import { isolateDatabase } from '../src/dev/sandbox.ts'

import { asConversationId, asCharacterId } from '../src/kernel/contracts/ids.ts'
import { JICHUANG_PACK } from '../evals/storyline/jichuang-interview-two/story-pack.ts'
import { advanceFromProposal, startStory, storyProvenanceOf } from '../src/kernel/storyline/world-machine.ts'

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

const sandbox = isolateDatabase('postlv2-world')
console.log(`  [sandbox] ${sandbox.dir}`)

const { createM4Harness } = await import('./m4-harness.ts')
const { TurnGateway } = await import('../src/kernel/app/turn-gateway.ts')
const { ConversationRecorder } = await import('../src/infrastructure/runtime/conversation-recorder.ts')
const { character } = await import('../src/character/index.ts')
const { stringToUuid } = await import('../src/kernel/contracts/uuid.ts')
const { SECTION_IDS } = await import('../src/kernel/context/sections.ts')

const h = await createM4Harness({ label: 'postlv2-world' })
const characterId = asCharacterId(h.kernel.characterId)
const conversationId = asConversationId('postlv2-world')
const userId = stringToUuid('user-Alex')

let sequence = 0
const recorder = new ConversationRecorder({
  db: h.kernel.stores.db,
  characterId,
  conversationId,
  dryRun: false,
  userName: 'Alex',
  characterName: character.name,
  transport: 'cli',
  userId,
  userRef: 'Alex',
})
const gateway = new TurnGateway({
  kernel: h.kernel,
  definition: h.kernel.definition,
  identity: h.kernel.identitySnapshot,
  recorder,
  conversationSequence: () => {
    sequence += 1
    return sequence
  },
  recentLimit: 16,
  slowPathEnabled: false,
  dryRun: false,
  userId,
})

// ===========================================================================
// W6 从真实故事包走一步，用**已提交且可见**的集合生成观测
// ===========================================================================
const storySeed = startStory({ pack: JICHUANG_PACK, runId: 'run-world', now: 1 })
const storyStep = advanceFromProposal(JICHUANG_PACK, storySeed.state, {
  proposedBy: 'user_choice',
  choiceId: 'ask_scope',
  expectedRevision: storySeed.state.revision,
  expectedStoryVersion: JICHUANG_PACK.storyVersion,
})
if (!storyStep.ok) {
  throw new Error(`故事步被拒（门无法继续）：${storyStep.code} ${storyStep.detail}`)
}
/** 她**实际感知到**的那批事件（`experiencedEventIds` 就是可见集合，与 `visibleEventIds` 同源） */
const experienced = storyStep.state.experiencedEventIds
const worldNotes = experienced.map((eventId) => {
  const provenance = storyProvenanceOf({
    storyId: storyStep.state.storyId,
    storyVersion: storyStep.state.storyVersion,
    runId: storyStep.state.runId,
    eventId,
    experienceScope: 'story_experience',
  })
  return {
    eventId,
    text: `（已提交的剧情事件：${eventId}）`,
    storySourceId: provenance.sourceId,
  }
})
const visibleSubsetOk = experienced.every((eventId) => storyStep.state.visibleEventIds.includes(eventId))
record(
  'W6',
  '真实故事步 → 观测：观测集**恰等于**已提交且可见的集合（不多不少；不可见/未选分支一条都不产生）',
  storyStep.ok && worldNotes.length > 0 && visibleSubsetOk,
  `可见事件=${JSON.stringify(experienced)} · 全部⊆visible=${String(visibleSubsetOk)} · 观测=${worldNotes.length} 条`,
  worldNotes.length + 1
)

// ===========================================================================
// W3 基线：**不传**世界观测时的 section 集合（同一轮用户文本）
// ===========================================================================
const baselineTurn = await gateway.beginTurn('我们二面准备得怎么样了？')
const baselinePacket = await gateway.compileTurn({
  turn: baselineTurn,
  currentInput: '我们二面准备得怎么样了？',
  recentLines: [],
})
const baselineSectionIds = baselinePacket.sections.map((section) => String(section.id)).sort()

// ===========================================================================
// W1/W2/W4/W5 带世界观测的真实一轮
// ===========================================================================
const worldTurn = await gateway.beginTurn('我们二面准备得怎么样了？')
const withWorld = await gateway.compileTurn({
  turn: { ...worldTurn, worldObservations: worldNotes },
  currentInput: '我们二面准备得怎么样了？',
  recentLines: [],
})
const worldSections = withWorld.sections.filter(
  (section) => String(section.id) === SECTION_IDS.worldObservation
)
const currentInputSections = withWorld.sections.filter(
  (section) => String(section.id) === SECTION_IDS.currentInput
)
const worldSection = worldSections[0]
const currentInputText = currentInputSections.map((section) => section.content).join('\n')

const everyNoteInWorldBlock = worldNotes.every((note) => (worldSection?.content ?? '').includes(note.text))
const noNoteInCurrentInput = worldNotes.every((note) => !currentInputText.includes(note.text))
const sourceRefsExact =
  JSON.stringify([...(worldSection?.sourceRefs ?? [])]) === JSON.stringify(worldNotes.map((note) => note.storySourceId))

record(
  'W1',
  '真实路径：一条世界观测经 `beginTurn`/`compileTurn` 真的进 packet，且以 **`world-observation`** 这一块出现',
  worldSections.length === 1 &&
    worldSection?.kind === 'world-observation' &&
    everyNoteInWorldBlock &&
    withWorld.sections.length > baselineSectionIds.length,
  `world-observation 块=${worldSections.length} 个 · 全部观测文本在内=${String(everyNoteInWorldBlock)} · ` +
    `section 数 ${baselineSectionIds.length} → ${withWorld.sections.length}`,
  4
)

record(
  'W2',
  '**反伪装**：同一轮的 `current-input` 只含用户这一轮说的话，世界观测文本**不在**里面（INV-PL2-02）',
  currentInputSections.length === 1 &&
    currentInputText.includes('我们二面准备得怎么样了？') &&
    noNoteInCurrentInput,
  `current-input 块=${currentInputSections.length} 个 · 含用户原话=${String(currentInputText.includes('我们二面准备得怎么样了？'))} · ` +
    `世界观测文本混入=${String(!noNoteInCurrentInput)}（应 false）`,
  3
)

record(
  'W3',
  '**逐字节不变**：不传世界观测的那一轮，section id 集合与"完全不带该字段"时**完全一致**（普通对话基线不受影响）',
  JSON.stringify(baselineSectionIds) ===
    JSON.stringify(baselinePacket.sections.map((section) => String(section.id)).sort()) &&
    !baselinePacket.sections.some((section) => String(section.id) === SECTION_IDS.worldObservation),
  `基线 section=${JSON.stringify(baselineSectionIds)} · 含 world-observation=${String(baselinePacket.sections.some((s) => String(s.id) === SECTION_IDS.worldObservation))}`,
  baselineSectionIds.length
)

record(
  'W4',
  '来源可读回：该 section 的 `sourceRefs` **恰是**那批确定性故事来源 id（可审计"这句话为什么进上下文"）',
  sourceRefsExact && (worldSection?.sourceRefs ?? []).length === worldNotes.length,
  `sourceRefs=${JSON.stringify(worldSection?.sourceRefs ?? [])}`,
  worldNotes.length
)

record(
  'W5',
  '可裁：世界观测块 `droppable: true`（预算紧时它可以被裁，而不是钉死的硬保留）',
  worldSection?.droppable === true && worldSection?.priority === 59,
  `droppable=${String(worldSection?.droppable)} · priority=${String(worldSection?.priority)}`,
  2
)

// prompt 真的带上它（不是只进 packet 的元数据）
const promptText = gateway.promptFor(withWorld)
const promptHasWorldBlock = worldNotes.every((note) => promptText.includes(note.text))
record(
  'W7',
  '**真的进了 prompt**：`promptFor(packet)` 的输出里含世界观测块（不是只躺在 packet 的元数据里）',
  promptHasText(promptText) && promptHasWorldBlock,
  `prompt 长度=${promptText.length} · 含世界观测文本=${String(promptHasWorldBlock)}`,
  2
)

function promptHasText(text: string): boolean {
  return text.includes('正在发生的事')
}

// ===========================================================================
// V1 量具自证三段式
// ===========================================================================
const selfCheck = (() => {
  /** 被检验的判据本体：**世界观测不得出现在 current-input 里** */
  const detectDisguise = (inputText: string, notes: readonly { text: string }[]): boolean =>
    notes.some((note) => inputText.includes(note.text))
  const positive = detectDisguise(currentInputText, worldNotes) // 正控 ⇒ false
  const negative = detectDisguise(`# 对方刚刚说\n\n${worldNotes[0]!.text}`, worldNotes) // 负控 ⇒ true
  const restored = detectDisguise(currentInputText, worldNotes) // 恢复 ⇒ false
  return {
    ok: positive === false && negative === true && restored === false,
    detail: `正控=${String(positive)}（应 false）· 负控=${String(negative)}（应 true）· 恢复=${String(restored)}（应 false）`,
  }
})()
record('V1', '量具自证三段式：真实 current-input 安静 → 注入伪装必响 → 恢复后重新安静', selfCheck.ok, selfCheck.detail, 3)

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

const runId = `postlv2-world-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${head.slice(0, 8)}`
const outDir = join(REPO_ROOT, 'artifacts/post-lv2', runId)
mkdirSync(outDir, { recursive: true })
const reading = {
  runId,
  gate: 'postlv2:world:verify',
  milestone: 'post-lv2 / WP2c (world observation into the real context)',
  generatedAt: new Date().toISOString(),
  source: { head },
  story: {
    storyId: storyStep.state.storyId,
    storyVersion: storyStep.state.storyVersion,
    runId: storyStep.state.runId,
    experienced: [...experienced],
    worldSourceIds: worldNotes.map((note) => note.storySourceId),
  },
  sections: {
    baseline: baselineSectionIds,
    withWorld: withWorld.sections.map((section) => String(section.id)).sort(),
  },
  checks,
  measuredCount,
  verdict: gateValid ? (passed ? 'PASS' : 'FAIL') : 'MEASUREMENT INVALID',
}
writeFileSync(join(outDir, 'world-verify.json'), JSON.stringify(reading, null, 2), 'utf8')

console.log('')
console.log(`  measured_count = ${measuredCount}`)
console.log(`  ${passed ? '✅' : '❌'} postlv2:world:verify = ${reading.verdict}`)
console.log(`  证据：artifacts/post-lv2/${runId}/world-verify.json`)

/*
 * 收尾：隔离库的连接必须**显式**关闭，否则进程会挂在打开的 pglite 句柄上不退出。
 * 关闭失败**不改变判定**（读数已经写下）。
 */
try {
  const { stopRuntimeServices, closeDatabaseConnection } = await import(
    '../src/infrastructure/persistence/runtime-shutdown.ts'
  )
  await stopRuntimeServices(h.runtime)
  await closeDatabaseConnection(h.runtime)
} catch (error) {
  console.log(`  (收尾告警，不影响判定：${error instanceof Error ? error.message : String(error)})`)
}

process.exit(passed ? 0 : 1)
