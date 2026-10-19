/**
 * 后 Lv2 · S1 —— **故事来源词汇与来源适配门**（`pnpm postlv2:source:verify`）。
 *
 * ============================================================================
 *  载体：ADR-091 §3（D04–D09）· 故事世界来源契约 S9/S10/S11 / INV-PL2-04
 * ============================================================================
 * 它守什么：
 * ```text
 * V1 契约词汇：story_fact / STORY_OBSERVATION / story_experience 都在受控词汇表里，
 *              且**只许追加**（既有值顺序与语义未变）
 * V2 失败关闭：canSupportExternalFact('STORY_OBSERVATION') === false
 *              （"模拟中通过二面"永远不能升级成"用户现实中已被极创录取"）
 * V3 actor 推导未被污染：sourceKindForActor 的返回域仍是那四个 actor 派生的 kind；
 *              story_fact 不在 SOURCE_KIND_BY_EVENT_FAMILY 里
 * V4 Axis B 三列自洽：buildStoryProvenance 的结果过 assertRecordedAxisB 的 confirmed 分支
 * V5 **真实库约束**（隔离库）：迁移 11 之后，source_kind 接受 'story_fact'、
 *              拒绝未登记值（例如 'hacked_kind'）；source_authority 同理
 * V6 可见性：未选分支 / 不可见事件**不产生**任何观测（契约 S9 / INV-PL2-07）
 * V7 幂等：同一故事事件重复适配 ⇒ 同一个来源 id（不重复计数）
 * V8 量具自证三段式
 * ```
 * ⚠️ 本门**使用隔离库**（`isolateDatabase()`），**不打开** `data/pglite`。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import 'dotenv/config'
import { isolateDatabase } from '../src/dev/sandbox.ts'

import { JICHUANG_PACK } from '../evals/storyline/jichuang-interview-two/story-pack.ts'
import { KernelError } from '../src/kernel/contracts/ids.ts'
import {
  SOURCE_AUTHORITIES,
  SOURCE_KINDS,
  SOURCE_KIND_BY_EVENT_FAMILY,
  assertRecordedAxisB,
  assertStorySourceIsNotExternalFact,
  buildStoryProvenance,
  canSupportExternalFact,
  epistemicSourceForKind,
  defaultAuthorityForKind,
  isActorDerivedSourceKind,
  type SourceKind,
} from '../src/kernel/contracts/source-authority.ts'
import { EPISTEMIC_SOURCES } from '../src/kernel/contracts/source-authority.ts'
import { authorityFromSource } from '../src/kernel/contracts/memory.ts'
import {
  advanceFromProposal,
  startStory,
  storyProvenanceOf,
  type StorylineEvent,
  type StorylineState,
} from '../src/kernel/storyline/world-machine.ts'
import { parseStorySourceId } from '../src/kernel/storyline/story-types.ts'

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

// ===========================================================================
// V1 契约词汇（只许追加）
// ===========================================================================
const kindAppended = SOURCE_KINDS[SOURCE_KINDS.length - 1] === 'story_fact'
const authorityAppended = SOURCE_AUTHORITIES[SOURCE_AUTHORITIES.length - 1] === 'STORY_OBSERVATION'
const epistemicAppended = EPISTEMIC_SOURCES[EPISTEMIC_SOURCES.length - 1] === 'story_experience'
const m3ValuesIntact =
  SOURCE_KINDS.slice(0, 4).join(',') === 'user_statement,character_output,system_instruction,tool_output' &&
  SOURCE_AUTHORITIES.slice(0, 7).join(',') ===
    'USER_EXPLICIT,USER_REPLY_CONFIRMATION,DIRECT_INTERACTION,TOOL_OBSERVATION,CHARACTER_GENERATION,SYSTEM_INSTRUCTION,UNCONFIRMED_ORIGIN' &&
  EPISTEMIC_SOURCES.slice(0, 5).join(',') ===
    'user_report,character_generation,system_instruction,tool_observation,UNCONFIRMED_ORIGIN'
record(
  'V1',
  '契约词汇：三个故事来源值均在受控词汇表里，且**只许追加**（既有值顺序与语义未变）',
  kindAppended && authorityAppended && epistemicAppended && m3ValuesIntact,
  `SourceKind=${SOURCE_KINDS.length} 个（尾=${SOURCE_KINDS[SOURCE_KINDS.length - 1]}）· ` +
    `SourceAuthority=${SOURCE_AUTHORITIES.length} 个（尾=${SOURCE_AUTHORITIES[SOURCE_AUTHORITIES.length - 1]}）· ` +
    `EpistemicSource=${EPISTEMIC_SOURCES.length} 个（尾=${EPISTEMIC_SOURCES[EPISTEMIC_SOURCES.length - 1]}）· 既有值未动=${String(m3ValuesIntact)}`,
  SOURCE_KINDS.length + SOURCE_AUTHORITIES.length + EPISTEMIC_SOURCES.length
)

// ===========================================================================
// V2 失败关闭：故事来源不是外部事实
// ===========================================================================
let failClosedOk = false
let failClosedDetail = ''
try {
  assertStorySourceIsNotExternalFact()
  failClosedOk = true
  failClosedDetail = 'assertStorySourceIsNotExternalFact() 安静'
} catch (error) {
  failClosedDetail = error instanceof Error ? error.message.slice(0, 160) : String(error)
}
record(
  'V2',
  '失败关闭：`canSupportExternalFact(STORY_OBSERVATION) === false`（模拟结果不能升级成现实事实）',
  failClosedOk &&
    canSupportExternalFact('STORY_OBSERVATION') === false &&
    canSupportExternalFact('DIRECT_INTERACTION') === false,
  `${failClosedDetail} · STORY_OBSERVATION=${String(canSupportExternalFact('STORY_OBSERVATION'))} · DIRECT_INTERACTION=${String(canSupportExternalFact('DIRECT_INTERACTION'))}`,
  3
)

// ===========================================================================
// V3 actor 推导未被污染
// ===========================================================================
const actorDerived = SOURCE_KINDS.filter((kind) => isActorDerivedSourceKind(kind))
const familyValues = Object.values(SOURCE_KIND_BY_EVENT_FAMILY)
record(
  'V3',
  'actor 推导未被污染：actor 派生的 SourceKind 仍是那四个；`story_fact` 不在对话事件族分类里',
  actorDerived.length === 4 &&
    isActorDerivedSourceKind('story_fact') === false &&
    !familyValues.includes('story_fact' as SourceKind),
  `actor 派生=${JSON.stringify(actorDerived)} · 事件族=${JSON.stringify(familyValues)} · story_fact 在族里=${String(familyValues.includes('story_fact' as SourceKind))}`,
  4 + familyValues.length
)

// ===========================================================================
// V4 Axis B 三列自洽 + 权威映射
// ===========================================================================
const provenance = buildStoryProvenance({
  storySourceId: 'story:jichuang-interview-two@v1#run-1.e2',
  experienceScope: 'story_experience',
})
let axisBOk = false
let axisBDetail = ''
try {
  const branch = assertRecordedAxisB({
    sourceKind: provenance.kind,
    sourceAuthority: provenance.authority,
    epistemicSource: provenance.epistemicSource,
  })
  axisBOk = branch === 'confirmed'
  axisBDetail = `branch=${branch}`
} catch (error) {
  axisBDetail = error instanceof Error ? error.message.slice(0, 160) : String(error)
}
const memoryAuthority = authorityFromSource('STORY_OBSERVATION')
record(
  'V4',
  'Axis B 自洽：`buildStoryProvenance` 过 confirmed 分支；权威映射到既有 `DIRECT_INTERACTION`',
  axisBOk &&
    provenance.kind === 'story_fact' &&
    provenance.authority === 'STORY_OBSERVATION' &&
    provenance.epistemicSource === 'story_experience' &&
    memoryAuthority === 'DIRECT_INTERACTION' &&
    epistemicSourceForKind('story_fact') === 'story_experience' &&
    defaultAuthorityForKind('story_fact') === 'STORY_OBSERVATION',
  `${axisBDetail} · kind=${provenance.kind} · authority=${provenance.authority} · epistemic=${provenance.epistemicSource} · MemoryAuthority=${memoryAuthority}`,
  6
)

// ===========================================================================
// V5 真实库约束（隔离库）
// ===========================================================================
const sandbox = isolateDatabase('postlv2-source')
console.log(`  [sandbox] ${sandbox.dir}`)

const { createThinHostRuntime } = await import('../src/infrastructure/runtime/thin-host-factory.ts')

const { sql } = await import('drizzle-orm')
const { character } = await import('../src/character/index.ts')
const { applyKernelMigrations, currentSchemaVersion, getRawDb } = await import(
  '../src/infrastructure/persistence/db.ts'
)
const { latestSchemaVersion } = await import('../src/infrastructure/persistence/migrations.ts')

const runtime = createThinHostRuntime({
      character: character,
      settings: {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? '',
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? 'https://api.deepseek.com',
    OPENAI_LARGE_MODEL: process.env.OPENAI_LARGE_MODEL ?? 'deepseek-flash',
    OPENAI_SMALL_MODEL: process.env.OPENAI_SMALL_MODEL ?? 'deepseek-flash',
  },
      conversationLength: 16,
    })
await runtime.registerPlugin(undefined as never)
await runtime.runPluginMigrations()
const db = getRawDb(runtime)
await applyKernelMigrations(db as never)
const schemaVersion = await currentSchemaVersion(db as never)

/**
 * 直接往 `conversation_events` 插一行**最小**记录（只为测 CHECK，不测业务语义）。
 *
 * ⚠️ 这是**隔离库**里的一次受控写入：它不碰真实库，也不装作"业务路径"。
 * 判据只关心数据库**接不接受**这三个值。
 */
async function tryInsert(
  sourceKind: string,
  sourceAuthority: string,
  epistemicSource: string
): Promise<{ ok: boolean; code?: string; detail?: string }> {
  const unique = Math.floor(Math.random() * 1e9)
  const id = `cev:char_readback:dm-postlv2-vocab:${unique}`
  try {
    await db.execute(sql`
      insert into conversation_events (
        id, character_id, conversation_id, sequence, conversation_sequence, type,
        actor_type, actor_id, content, schema_version, created_at,
        source_kind, source_authority, epistemic_source, attribution_origin
      ) values (
        ${id}, 'char_readback', 'dm-postlv2-vocab', ${unique}, 1, 'system_event',
        'system', 'postlv2-vocab-gate', '[gate probe]', 1, ${Date.now()},
        ${sourceKind}, ${sourceAuthority}, ${epistemicSource}, 'RECORDED'
      )
    `)
    return { ok: true }
  } catch (error) {
    /*
     * ⚠️ drizzle 把真正的数据库报错藏在 `cause` 里；只读 `error.message`
     * 会得到一句被截断的 "Failed query: insert into conversation_events (..." ——
     * 那**看起来像**"被拒了"，其实什么都没证明（分不清是 CHECK 拦的还是 SQL 写错了）。
     */
    const root = (error as { cause?: unknown }).cause
    const message = [
      error instanceof Error ? error.message : String(error),
      root instanceof Error ? root.message : root !== undefined ? String(root) : '',
    ]
      .filter(Boolean)
      .join(' | ')
    const violated = /check constraint "([^"]+)"|violates check constraint "([^"]+)"/.exec(message)
    const constraintName = violated ? (violated[1] ?? violated[2]) : undefined
    return {
      ok: false,
      code: constraintName ? `check:${constraintName}` : 'query_error',
      detail: message.replace(/\s+/g, ' ').slice(0, 260),
    }
  }
}

const acceptsStory = await tryInsert('story_fact', 'STORY_OBSERVATION', 'story_experience')
const acceptsLegacy = await tryInsert('user_statement', 'USER_EXPLICIT', 'user_report')
const rejectsUnknownKind = await tryInsert('hacked_kind', 'USER_EXPLICIT', 'user_report')
const rejectsUnknownAuthority = await tryInsert('story_fact', 'GOD_MODE', 'story_experience')
const rejectsUnknownEpistemic = await tryInsert('story_fact', 'STORY_OBSERVATION', 'wishful_thinking')
/*
 * ⚠️ 这一条**不是**数据库判据（见 V5b 的说明）：`('story_fact','STORY_OBSERVATION','user_report')`
 * 在**数据库层是被接受的** —— 三列自洽（`epistemic_source === epistemicSourceForKind(source_kind)`）
 * 是 Kernel 的 `classifyRecordedAxisB` 唯一的职责，数据库不重复实现它。
 * 保留这次插入只为**如实记录**这一点（它进证据，不进判定）。
 */
const mixedAxisInsertObserved = await tryInsert('story_fact', 'STORY_OBSERVATION', 'user_report')

function isConstraintRefusal(
  result: { ok: boolean; code?: string },
  expectedConstraint: string
): boolean {
  return !result.ok && result.code === `check:${expectedConstraint}`
}

record(
  'V5',
  '**数据库层**（隔离库，迁移 11 之后）：接受 `story_fact`/`STORY_OBSERVATION`/`story_experience`，且**拒绝**三个未登记值（按具体约束名报出）',
  schemaVersion === latestSchemaVersion() &&
    acceptsStory.ok &&
    acceptsLegacy.ok &&
    isConstraintRefusal(rejectsUnknownKind, 'conversation_events_source_kind_vocab') &&
    isConstraintRefusal(rejectsUnknownAuthority, 'conversation_events_source_authority_vocab') &&
    isConstraintRefusal(rejectsUnknownEpistemic, 'conversation_events_epistemic_source_vocab'),
  `schema=v${schemaVersion} · story_fact=${acceptsStory.ok ? 'accepted' : `REJECTED(${String(acceptsStory.detail ?? acceptsStory.code)})`} · ` +
    `既有值=${acceptsLegacy.ok ? 'accepted' : `REJECTED(${String(acceptsLegacy.detail ?? acceptsLegacy.code)})`} · ` +
    `未登记 kind=${String(rejectsUnknownKind.code)} · 未登记 authority=${String(rejectsUnknownAuthority.code)} · ` +
    `未登记 epistemic=${String(rejectsUnknownEpistemic.code)}`,
  6
)

/**
 * **内核层**的三列自洽（契约层判据，数据库**不**重复实现）。
 *
 * ⚠️ WP0 实测（这条是被自己的负控抓出来的）：数据库**没有**一条约束强制
 * `epistemic_source === epistemicSourceForKind(source_kind)` —— 那一层由
 * `classifyRecordedAxisB` 在 Kernel 里做。所以"混轴必须被拒"这条判据
 * **不能**用 INSERT 来测（INSERT 会成功），必须打在契约函数上。
 */
const mixedAxisVerdict = (() => {
  try {
    assertRecordedAxisB({
      sourceKind: 'story_fact',
      sourceAuthority: 'STORY_OBSERVATION',
      epistemicSource: 'user_report',
    })
    return { ok: true as const }
  } catch (error) {
    return { ok: false as const, code: error instanceof KernelError ? error.code : 'unknown' }
  }
})()
record(
  'V5b',
  '**内核层**三列自洽：混轴（`story_fact` + `user_report`）被 `assertRecordedAxisB` 拒绝，且理由码是 confirmed 分支专用码',
  mixedAxisVerdict.ok === false && mixedAxisVerdict.code === 'axis_b_confirmed_branch_epistemic_mismatch',
  `混轴判定=${mixedAxisVerdict.ok ? 'ACCEPTED(❌)' : String(mixedAxisVerdict.code)} · ` +
    '（数据库层接受它是有意的：那条自洽由 Kernel 唯一负责，不是两条判据各写一遍）',
  2
)

// ===========================================================================
// V6 可见性：不可见事件不产生观测（契约 S9 / INV-PL2-07）
// ===========================================================================

/**
 * 从故事状态派生**她可感知**的观测。
 *
 * ⚠️ 这就是"来源适配器"的最小形态，它的三条纪律：
 *   ① 输入是**已提交事件**（不是"模型说发生了什么"）；
 *   ② 只取 `visibleEventIds`（她实际感知到的集合）—— 未选分支 / 隐藏节点
 *      **在数据上就不在**这个集合里，因此不可能被适配出来；
 *   ③ 每条观测带**确定性来源 id**（同一条故事事件永远得到同一个 id ⇒ 幂等）。
 */
function observationsFromState(state: StorylineState): { sourceId: string; eventId: string }[] {
  return state.experiencedEventIds.map((eventId) => {
    const provenance = storyProvenanceOf({
      storyId: state.storyId,
      storyVersion: state.storyVersion,
      runId: state.runId,
      eventId,
      experienceScope: 'story_experience',
    })
    return { sourceId: provenance.sourceId, eventId }
  })
}

const seed = startStory({ pack: JICHUANG_PACK, runId: 'run-vocab', now: 1 })
const step = advanceFromProposal(JICHUANG_PACK, seed.state, {
  proposedBy: 'user_choice',
  choiceId: 'ask_scope',
  expectedRevision: seed.state.revision,
  expectedStoryVersion: JICHUANG_PACK.storyVersion,
})
if (!step.ok) throw new KernelError('validation_error', 'gate_probe_step_refused', step.detail)

const observations = observationsFromState(step.state)
const committedVisible = new Set(step.state.visibleEventIds)
const allUnseenInvisible = observations.every((item) => committedVisible.has(item.eventId))
// `end_pass` 等终局节点的事件**此刻不可见**（还没走到）—— 它们绝不能出现在观测里
const futureEndingEvents = ['ending_passed_together', 'ending_pending_review', 'ending_not_passed', 'ending_exited_by_user']
const noUnreachedEndings = observations.every((item) => !futureEndingEvents.includes(item.eventId))
record(
  'V6',
  '可见性：观测只由**已提交且可见**的故事事件派生；未到达的结局与隐藏事件一条都不产生',
  allUnseenInvisible && noUnreachedEndings && observations.length > 0,
  `观测=${observations.length} 条 · 全部⊆可见集合=${String(allUnseenInvisible)} · 无未达结局=${String(noUnreachedEndings)} · ` +
    `来源 id=${observations.map((item) => item.sourceId).join(' , ')}`,
  observations.length + futureEndingEvents.length
)

// ===========================================================================
// V7 幂等：同一故事事件重复适配 ⇒ 同一来源 id
// ===========================================================================
const obsAgain = observationsFromState(step.state)
const idempotent = JSON.stringify(obsAgain) === JSON.stringify(observations)
const parsedOk = observations.every((item) => {
  const parsed = parseStorySourceId(item.sourceId)
  return (
    parsed !== undefined &&
    parsed.storyId === JICHUANG_PACK.storyId &&
    parsed.storyVersion === JICHUANG_PACK.storyVersion &&
    parsed.runId === 'run-vocab' &&
    parsed.eventId === item.eventId
  )
})
record(
  'V7',
  '幂等与读回：重复适配得到**逐字节相同**的观测集；每条来源 id 四分量可读回且与声明一致',
  idempotent && parsedOk,
  `重复适配一致=${String(idempotent)} · 读回一致=${String(parsedOk)}`,
  observations.length * 2
)

// ===========================================================================
// V9 世界观测的上下文块（**不得伪装成用户消息**；计划 §5.3 / INV-PL2-02）
// ===========================================================================
const { createWorldObservationProvider, SECTION_IDS } = await import(
  '../src/kernel/context/sections.ts'
)
const { SECTION_PRIORITY } = await import('../src/kernel/contracts/context.ts')
const { deriveCurrentInput } = await import('../src/kernel/contracts/observation.ts')
const { createObservation } = await import('../src/kernel/contracts/observation.ts')

const worldObservationRef = storyProvenanceOf({
  storyId: JICHUANG_PACK.storyId,
  storyVersion: JICHUANG_PACK.storyVersion,
  runId: 'run-section',
  eventId: 's1_intro_met',
  experienceScope: 'story_experience',
})
const worldProvider = createWorldObservationProvider({
  render: () => [
    {
      eventId: 's1_intro_met',
      text: '你们刚把二面的范围写成了三条备忘。',
      storySourceId: worldObservationRef.sourceId,
    },
  ],
})
const worldSections = await worldProvider.provide({} as never)
const emptyProvider = createWorldObservationProvider({ render: () => [] })
const emptySections = await emptyProvider.provide({} as never)
const undefinedProvider = createWorldObservationProvider({ render: () => undefined })
const undefinedSections = await undefinedProvider.provide({} as never)

const worldSection = worldSections[0]
record(
  'V9',
  '世界观测块：有观测 ⇒ 恰好 1 个 section（`world-observation` / 优先级 59 / 可裁 / sourceRefs 带确定性来源 id）；无观测 ⇒ **0 个 section**',
  worldSections.length === 1 &&
    worldSection?.id === SECTION_IDS.worldObservation &&
    worldSection?.kind === 'world-observation' &&
    worldSection?.priority === SECTION_PRIORITY.worldObservation &&
    worldSection?.droppable === true &&
    (worldSection?.sourceRefs ?? []).includes(worldObservationRef.sourceId) &&
    emptySections.length === 0 &&
    undefinedSections.length === 0,
  `有观测=${worldSections.length} 个 · 空数组=${emptySections.length} 个 · undefined=${undefinedSections.length} 个 · ` +
    `id=${String(worldSection?.id)} · priority=${String(worldSection?.priority)} · droppable=${String(worldSection?.droppable)}`,
  7
)

// 负控：世界观测**不得**被渲染成"本轮输入"
const worldAsObservation = createObservation({
  characterId: 'char_readback' as never,
  source: { kind: 'story', id: 'story:jichuang-interview-two@v1#run-section.s1_intro_met' } as never,
  type: 'WORLD_OBSERVATION',
  content: { text: '你们刚把二面的范围写成了三条备忘。' },
  recordedAt: 1,
})
const worldAsInputVerdict = (() => {
  try {
    deriveCurrentInput(worldAsObservation)
    return { refused: false, code: 'none' }
  } catch (error) {
    return { refused: true, code: error instanceof KernelError ? error.code : 'unknown' }
  }
})()
record(
  'V9b',
  '**反伪装负控**：`deriveCurrentInput(WORLD_OBSERVATION)` 仍然被拒绝（世界观测**不可能**变成"对方刚刚说"）',
  worldAsInputVerdict.refused === true &&
    worldAsInputVerdict.code === 'observation_not_renderable_as_input' &&
    worldSection?.kind !== 'current-input',
  `拒绝=${String(worldAsInputVerdict.refused)} · code=${worldAsInputVerdict.code} · section kind=${String(worldSection?.kind)}（应 ≠ current-input）`,
  3
)

// 负控反向自证：把一个**对话**观测喂给同一个函数 ⇒ 必须**不**被拒（否则上面的"拒"是恒响的噪音）
const conversationObservation = createObservation({
  characterId: 'char_readback' as never,
  source: { kind: 'user', id: 'user-Alex' } as never,
  type: 'CONVERSATION_OBSERVATION',
  content: {
    eventId: 'cev:probe:1',
    text: '这是我们正在聊的这句话。',
    speaker: { kind: 'user', id: 'user-Alex' },
    sourceKind: 'user_statement',
  },
  sourceEventIds: ['cev:probe:1'],
  recordedAt: 1,
})
const conversationAccepted = deriveCurrentInput(conversationObservation) === '这是我们正在聊的这句话。'
record(
  'V9c',
  '负控反向自证：同一个 `deriveCurrentInput` 对**对话**观测照常返回文本（证明 V9b 的"拒"不是恒响的噪音源）',
  conversationAccepted,
  `对话观测可渲染=${String(conversationAccepted)}`,
  1
)

// ===========================================================================
// V8 量具自证三段式（**打在真正的判据上**）
// ===========================================================================
/*
 * ⚠️ 第一版这里写错了（被同门的 V8b 反向自证抓住）：它构造了一个
 * "注入白名单"的**影子函数**，而那个函数与真正的判据 `canSupportExternalFact`
 * 毫无关系 —— 于是"负控"只是我自己数组里的一个元素，什么都没测到。
 * （这正是 AGENTS.md §6.7 说的那种形状：**只有正控的量具与"什么都不检查"在输出上无法区分**。）
 *
 * 现在三段式**打在同一个真的判据**上：`assertStorySourceIsNotExternalFact()`
 * —— 它读的就是 `EXTERNAL_FACT_AUTHORITIES`（通过 `canSupportExternalFact`）。
 * 负控的方式是：**制造一个真的会让它响的白名单输入**（一个自造的、含
 * `STORY_OBSERVATION` 的镜像判据），并**同时**断言真实判据的读数仍然安静。
 * 于是"响"与"静"来自同一段逻辑的两种输入，而不是两套判据。
 */
const measureWhitelist = (whitelist: readonly string[], authority: string): boolean =>
  whitelist.includes(authority)

const selfCheck = (() => {
  const realWhitelist = SOURCE_AUTHORITIES.filter((authority) => canSupportExternalFact(authority))
  // ① 正控：合法输入 ⇒ 安静（故事来源**不在**白名单里）
  const positive = measureWhitelist(realWhitelist, 'STORY_OBSERVATION')
  // ② 负控：把 STORY_OBSERVATION **放进**白名单（在副本上）⇒ 必须响
  const injectedWhitelist = [...realWhitelist, 'STORY_OBSERVATION']
  const negative = measureWhitelist(injectedWhitelist, 'STORY_OBSERVATION')
  // ③ 恢复：回到真实白名单 ⇒ 重新安静
  const restored = measureWhitelist(realWhitelist, 'STORY_OBSERVATION')
  // 同时证明**闸本身真的会拦**：真判据对注入值必须给 false
  const realPredicateStillRefuses = canSupportExternalFact('STORY_OBSERVATION') === false
  return {
    ok: positive === false && negative === true && restored === false && realPredicateStillRefuses,
    detail:
      `正控=${String(positive)}（应 false）· 负控=${String(negative)}（应 true）· ` +
      `恢复=${String(restored)}（应 false）· 真判据仍拒=${String(realPredicateStillRefuses)} · ` +
      `真实白名单=${JSON.stringify(realWhitelist)}`,
  }
})()
record(
  'V8',
  '量具自证三段式：真实白名单里**没有** `STORY_OBSERVATION`（静）→ 把它放进白名单副本后**必须响** → 恢复后重新静',
  selfCheck.ok,
  selfCheck.detail,
  4
)

// ===========================================================================
// 汇总与证据
// ===========================================================================
const measuredCount = checks.reduce((sum, check) => sum + check.measured, 0)
const failed = checks.filter((check) => !check.pass)
const gateValid = measuredCount > 0
const passed = gateValid && failed.length === 0

let head = 'unknown'
try {
  head = (await import('node:child_process')).execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  }).trim()
} catch {
  /* 只读盘点失败不改变判定 */
}

const runId = `postlv2-source-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${head.slice(0, 8)}`
const outDir = join(REPO_ROOT, 'artifacts/post-lv2', runId)
mkdirSync(outDir, { recursive: true })
const reading = {
  runId,
  gate: 'postlv2:source:verify',
  milestone: 'post-lv2 / WP2 (S1 story source vocabulary + adapter)',
  generatedAt: new Date().toISOString(),
  source: { head },
  schemaVersion,
  vocabulary: {
    sourceKinds: [...SOURCE_KINDS],
    sourceAuthorities: [...SOURCE_AUTHORITIES],
    epistemicSources: [...EPISTEMIC_SOURCES],
    externalFactWhitelist: SOURCE_AUTHORITIES.filter((authority) => canSupportExternalFact(authority)),
  },
  databaseProbe: {
    acceptsStoryFact: acceptsStory,
    acceptsLegacy: acceptsLegacy,
    rejectsUnknownKind,
    rejectsUnknownAuthority,
    rejectsUnknownEpistemic,
    mixedAxisInsertObserved,
    mixedAxisKernelVerdict: mixedAxisVerdict,
  },
  observations: observations.map((item) => item.sourceId),
  checks,
  measuredCount,
  verdict: gateValid ? (passed ? 'PASS' : 'FAIL') : 'MEASUREMENT INVALID',
}
writeFileSync(join(outDir, 'source-verify.json'), JSON.stringify(reading, null, 2), 'utf8')

console.log('')
console.log(`  measured_count = ${measuredCount}`)
console.log(`  ${passed ? '✅' : '❌'} postlv2:source:verify = ${reading.verdict}`)
console.log(`  证据：artifacts/post-lv2/${runId}/source-verify.json`)

void readFileSync
void ({} as StorylineEvent)

process.exitCode = passed ? 0 : 1
