/**
 * M11 WP3 —— **结构化候选门**（`m11:inputs:verify`）。
 *
 * ============================================================================
 *  本门要测的命题（先写命题，再写量具）
 * ============================================================================
 * ```text
 * ① **严格**：模型产出的草案只能落在闭集里；未知字段 / 未知槽 / 编造 handle /
 *    非法 JSON / 空输出 / 超长 / 版本错配 **各有具名理由**，**不合并、不当"没提议"**。
 * ② **理由码闭集真的可达**：登记表里每一条都**真的被产出过一次**（集合相等），
 *    且产出的理由**没有**一条是登记表外的（否则"闭集"只是文档上的一句话）。
 * ③ **这一层不写库**：跑完 N 份合法草案之后，Memory / Belief / Goal 与
 *    Reflection 自己的领域事件数**一个都没变**（`D04` / WP3 出口）。
 * ④ **量具自检**：三组各有非零条目；否则本次读数判 MEASUREMENT INVALID。
 * ```
 *
 * ============================================================================
 *  硬边界
 * ============================================================================
 *  · **零模型调用、零出网**：本门只用固定字符串当"模型输出"，因此它是确定性的。
 *    ⇒ 它**不**回答"模型写得好不好"—— 那是 WP10（`m11:semantic:eval`，需真模型）。
 *  · 数据库是 `isolateDatabase()` 的**一次性沙箱**（只用来测"没写库"）。
 *
 * 用法：
 *   pnpm m11:inputs:verify [--out artifacts/m11/<runId>]
 */

import 'dotenv/config'

import { isolateDatabase } from '../src/dev/sandbox.ts'

// ⚠️ 必须在**任何**碰数据库的 import 之前（AGENTS §7）
isolateDatabase('m11-inputs-verify', { keep: false })

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { createM4Harness, M4_T0 } from './m4-harness.ts'
import {
  M11_MANIFEST_VERSION,
  createM11RunId,
  openM11RunDir,
  runIdFromM11OutPath,
  writeM11Manifest,
} from './m11-evidence.ts'
import {
  REFLECTION_DRAFT_FIELD_ALLOWLIST,
  REFLECTION_DRAFT_MAX_TEXT_CODEPOINTS,
  REFLECTION_DRAFT_REJECTION_FACTS,
  REFLECTION_DRAFT_REJECTION_REASONS,
  REFLECTION_DRAFT_SCHEMA_VERSION,
  REFLECTION_DRAFT_SCOPE,
  REFLECTION_SLOTS,
  codepointLength,
  parseReflectionDraft,
  validateReflectionDraft,
  type ReflectionDraftContext,
  type ReflectionDraftRejectionReason,
  type ReflectionHandle,
} from '../src/kernel/contracts/reflection.ts'
import { domainEventsFor, appendDomainEvent } from '../src/infrastructure/persistence/event-store.ts'
import { createReflectionInputSource } from '../src/infrastructure/persistence/reflection-input-source.ts'
import {
  BELIEF_DISPUTED,
  COMMITMENT_BROKEN,
  COMMITMENT_CANCELLED,
  COMMITMENT_FULFILLED,
  DIAGNOSTIC_SIGNAL,
  GOAL_BLOCKED,
  GOAL_CANCELLED,
  GOAL_COMPLETED,
  MEMORY_DISPUTED,
  MEMORY_RETRACTED,
} from '../src/kernel/contracts/domain-event.ts'
import {
  REFLECTION_MAX_WINDOW_INPUTS,
  REFLECTION_TRIGGER_FACTS,
  REFLECTION_TRIGGER_KINDS,
  REFLECTION_WINDOW_MASKED_TEXT,
  detectReflectionTriggers,
  type ReflectionInputSource,
  type ReflectionTriggerEventReading,
  type ReflectionTriggerKind,
} from '../src/kernel/contracts/reflection-input.ts'
import { buildReflectionInput, meetsStabilityThreshold } from '../src/kernel/app/reflection/inputs.ts'
import type { CharacterId } from '../src/kernel/contracts/ids.ts'

const REPO_ROOT = resolve(process.cwd())

type Db = Parameters<typeof domainEventsFor>[0]

interface Check {
  id: string
  group: 'A' | 'B' | 'C' | 'D' | 'F' | 'G' | 'H' | 'S'
  label: string
  pass: boolean
  detail: string
}

const checks: Check[] = []

function record(id: string, group: Check['group'], label: string, pass: boolean, detail: string): void {
  checks.push({ id, group, label, pass, detail })
}

// ---------------------------------------------------------------------------
// 固定的"模型输出"（本门不调模型）
// ---------------------------------------------------------------------------

const HANDLES: readonly ReflectionHandle[] = [
  { kind: 'conversation_event', id: 'ce:1' },
  { kind: 'conversation_event', id: 'ce:2' },
  { kind: 'memory', id: 'mem:A' },
]

const CONTEXT: ReflectionDraftContext = { handles: HANDLES }

function legalDraftJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: REFLECTION_DRAFT_SCHEMA_VERSION,
    focusQuestion: '她是否在多个会话里因为对象不明确而反复确认？',
    explanation: '三次不同会话都出现了同一种来回确认，且对象都不明确。',
    supportHandles: ['ce:1', 'ce:2'],
    counterHandles: ['mem:A'],
    scope: REFLECTION_DRAFT_SCOPE,
    ...overrides,
  })
}

/** 跑一次"原始文本 → 草案"，返回理由码（合法时返回 `(ok)`）。 */
function reasonOf(rawText: string, context: ReflectionDraftContext = CONTEXT): string {
  const result = parseReflectionDraft(rawText, context)
  return result.ok ? '(ok)' : result.reason
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  let out: string | undefined
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--out') out = args[++i]
    else throw new Error(`未知参数：${JSON.stringify(args[i])}`)
  }

  const h = await createM4Harness({ label: 'm11-inputs-verify' })
  const db = h.db

  /*
   * 先把计数器的分母打非零：一条**无关**的领域事件（诊断信号）。
   * 没有它，D2 的"没写库"就是"0 → 0"，而那与"计数器根本不工作"无法区分。
   */
  const evidence = await h.recordUserEvidence('这是一条让事件计数器非零的真实对话事件。')
  await appendDomainEvent(
    db,
    h.kernel.characterId as CharacterId,
    {
      type: DIAGNOSTIC_SIGNAL,
      operation: 'm11-inputs-probe',
      payload: { counterDelta: 1 },
      sourceConversationEventIds: [evidence.event.id],
      idempotencyKey: 'm11-inputs-verify:counter-probe',
      processor: 'm11-inputs-verify',
      processorVersion: 'm11-inputs-verify@1',
      scope: 'CHARACTER_INTERNAL',
    },
    M4_T0 + 10
  )

  // -------------------------------------------------------------------------
  // A 组 —— 正控：合法草案必须通过，且往返后逐字一致
  // -------------------------------------------------------------------------
  const legal = parseReflectionDraft(legalDraftJson(), CONTEXT)
  record(
    'A1',
    'A',
    '【正控】合法草案通过，且字段逐字往返（含 support / counter 两个集合）',
    legal.ok &&
      legal.draft.focusQuestion.length > 0 &&
      legal.draft.supportHandles.join(',') === 'ce:1,ce:2' &&
      legal.draft.counterHandles.join(',') === 'mem:A',
    legal.ok ? `ok · support=${JSON.stringify(legal.draft.supportHandles)}` : `被拒：${legal.reason}`
  )

  const withSlot = parseReflectionDraft(
    legalDraftJson({ suggestedSlot: REFLECTION_SLOTS[0] }),
    CONTEXT
  )
  record(
    'A2',
    'A',
    '【正控】可选的建议槽位被接受（三槽闭集里的一员）',
    withSlot.ok && withSlot.draft.suggestedSlot === REFLECTION_SLOTS[0],
    withSlot.ok ? `slot=${String(withSlot.draft.suggestedSlot)}` : `被拒：${withSlot.reason}`
  )

  const withIntent = parseReflectionDraft(
    legalDraftJson({ revisionIntent: { domain: 'goal', targetId: 'goal-1', expectedRevision: 3 } }),
    CONTEXT
  )
  record(
    'A3',
    'A',
    '【正控】可选的跨域待审意图被接受（只提议，不提交）',
    withIntent.ok && withIntent.draft.revisionIntent?.expectedRevision === 3,
    withIntent.ok ? `intent=${JSON.stringify(withIntent.draft.revisionIntent)}` : `被拒：${withIntent.reason}`
  )

  const directObject = validateReflectionDraft(JSON.parse(legalDraftJson()) as unknown, CONTEXT)
  record(
    'A4',
    'A',
    '【正控】`validateReflectionDraft` 对**已解析**对象同样通过（解析与校验是两层，不互相顶替）',
    directObject.ok,
    directObject.ok ? 'ok' : `被拒：${directObject.reason}`
  )

  // -------------------------------------------------------------------------
  // B 组 —— 负控：每一条理由都必须**真的**被产出一次
  // -------------------------------------------------------------------------
  const produced: ReflectionDraftRejectionReason[] = []
  const expect = (rawText: string, reason: ReflectionDraftRejectionReason, id: string, label: string): void => {
    const actual = reasonOf(rawText)
    if (actual !== '(ok)') produced.push(actual as ReflectionDraftRejectionReason)
    record(id, 'B', label, actual === reason, `实到=${actual} · 期望=${reason}`)
  }

  expect('{ "schemaVersion": "reflection-draft@1", "focusQuestion": "x"', 'draft_invalid_json', 'B1', '【负控】被截断的 JSON ⇒ `draft_invalid_json`')
  expect('[]', 'draft_invalid_json', 'B2', '【负控】顶层是数组 ⇒ `draft_invalid_json`')
  expect(
    JSON.stringify({
      schemaVersion: REFLECTION_DRAFT_SCHEMA_VERSION,
      focusQuestion: 'x',
      supportHandles: [],
      counterHandles: [],
      scope: REFLECTION_DRAFT_SCOPE,
    }),
    'draft_empty',
    'B3',
    '【负控】缺 explanation ⇒ `draft_empty`'
  )
  expect(legalDraftJson({ explanation: '   ' }), 'draft_empty', 'B4', '【负控】解释只有空白 ⇒ `draft_empty`')
  expect(legalDraftJson({ rootCount: 3 }), 'draft_unknown_field', 'B5', '【负控】模型自报**根数** ⇒ `draft_unknown_field`（`D06` 的核心）')
  expect(legalDraftJson({ authority: 'user_statement' }), 'draft_unknown_field', 'B6', '【负控】模型自报 `authority` ⇒ `draft_unknown_field`')
  expect(
    legalDraftJson({ explanation: '很长的解释。'.repeat(80) }),
    'draft_too_long',
    'B7',
    `【负控】解释超过 ${String(REFLECTION_DRAFT_MAX_TEXT_CODEPOINTS)} 码点 ⇒ \`draft_too_long\``
  )
  expect(legalDraftJson({ suggestedSlot: 'always_be_nice' }), 'unknown_slot', 'B8', '【负控】自创槽位 ⇒ `unknown_slot`')
  expect(legalDraftJson({ supportHandles: ['ce:1', 'ce:FRABRICATED'] }), 'handle_not_provided', 'B9', '【负控】编造支持 handle ⇒ `handle_not_provided`')
  expect(legalDraftJson({ counterHandles: ['mem:NOT-GIVEN'] }), 'handle_not_provided', 'B10', '【负控】编造反例 handle ⇒ `handle_not_provided`')
  expect(legalDraftJson({ schemaVersion: 'reflection-draft@9' }), 'draft_schema_unknown', 'B11', '【负控】形状版本不认识 ⇒ `draft_schema_unknown`（与"JSON 坏了"分开）')
  expect(legalDraftJson({ scope: 'always' }), 'draft_empty', 'B12', '【负控】scope 想扩成"永远这样做" ⇒ 拒收')

  // -------------------------------------------------------------------------
  // C 组 —— 闭集自检：产出的理由集合 == 登记表（既不多也不少）
  // -------------------------------------------------------------------------
  const producedSet = new Set(produced)
  const registered = new Set<string>(REFLECTION_DRAFT_REJECTION_REASONS)
  const missing = [...registered].filter((reason) => !producedSet.has(reason as ReflectionDraftRejectionReason))
  const extra = [...producedSet].filter((reason) => !registered.has(reason))
  record(
    'C1',
    'C',
    '【量具自检】登记表里的 7 条理由**全部**被 B 组真的产出过（闭集可达，不是文档上的一句话）',
    missing.length === 0,
    `缺=${JSON.stringify(missing)} · 实到=${JSON.stringify([...producedSet])}`
  )
  record(
    'C2',
    'C',
    '【量具自检】产出的理由**没有**一条在登记表之外（不存在"没登记却在用"的码）',
    extra.length === 0,
    `多出=${JSON.stringify(extra)}`
  )
  record(
    'C3',
    'C',
    '每条理由都有可达性事实（`REFLECTION_DRAFT_REJECTION_FACTS` 与闭集一一对应）',
    REFLECTION_DRAFT_REJECTION_REASONS.every((reason) => {
      const fact = REFLECTION_DRAFT_REJECTION_FACTS[reason]
      return fact !== undefined && fact.reachable && fact.producer !== '' && fact.howToReach !== ''
    }),
    `登记条数=${String(REFLECTION_DRAFT_REJECTION_REASONS.length)} · 事实条数=${String(Object.keys(REFLECTION_DRAFT_REJECTION_FACTS).length)}`
  )

  // -------------------------------------------------------------------------
  // D 组 —— 这一层**不写库**（WP3 的出口条件之一）
  // -------------------------------------------------------------------------
  const countByGroup = async (): Promise<Record<string, number>> => {
    const events = await domainEventsFor(db, h.kernel.characterId)
    const counts: Record<string, number> = { memory: 0, belief: 0, goal: 0, commitment: 0, reflection: 0, other: 0 }
    for (const event of events) {
      const type = String(event.type)
      if (type.startsWith('MEMORY_')) counts.memory += 1
      else if (type.startsWith('BELIEF_')) counts.belief += 1
      else if (type.startsWith('GOAL_')) counts.goal += 1
      else if (type.startsWith('COMMITMENT_')) counts.commitment += 1
      else if (type.startsWith('REFLECTION_') || type.startsWith('ADAPTIVE_SELF_')) counts.reflection += 1
      else counts.other += 1
    }
    return counts
  }

  const before = await countByGroup()
  let accepted = 0
  for (let i = 0; i < 20; i += 1) {
    const result = parseReflectionDraft(
      legalDraftJson({ focusQuestion: `第 ${String(i)} 次：对象是否不明确？` }),
      CONTEXT
    )
    if (result.ok) accepted += 1
  }
  const after = await countByGroup()
  const deltas = Object.fromEntries(
    Object.keys(before).map((key) => [key, (after[key] ?? 0) - (before[key] ?? 0)])
  ) as Record<string, number>

  record(
    'D1',
    'D',
    '【正控·非零】20 份合法草案全部通过（否则"没写库"可以靠"什么都没做"通过）',
    accepted === 20,
    `accepted=${String(accepted)}/20`
  )
  record(
    'D2',
    'D',
    '跑完 20 份草案后：Memory / Belief / Goal / Commitment / Reflection 的事件数**一个都没变**（WP3 出口）',
    Object.values(deltas).every((delta) => delta === 0),
    `deltas=${JSON.stringify(deltas)} · before=${JSON.stringify(before)}`
  )
  /*
   * ⚠️ `before` 全零会让 D2 变成"0 → 0"——那与"计数器根本不工作"在输出上**长得一样**
   *    （AGENTS §6.8）。所以先写一条**无关的**领域事件把计数器打非零，
   *    再断言它**没有**在跑草案期间变化。
   */
  record(
    'D6',
    'D',
    '【量具自检】计数器本身非零（先写入一条无关的领域事件 ⇒ "0 → 0"不再是可接受的读数）',
    (before.other ?? 0) > 0 && deltas.other === 0,
    `before.other=${String(before.other ?? 0)} · delta.other=${String(deltas.other ?? 0)}`
  )

  // 结构判据：这一层里**没有**写原语（"没写库"不靠运行时巧合，靠结构）
  const contractSrc = readFileSync(join(REPO_ROOT, 'src/kernel/contracts/reflection.ts'), 'utf8')
  const stripped = contractSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  const writePrimitives = ['insertProjection', 'saveProjection', 'deleteProjection', 'applyAcceptedEvents', 'appendDomainEvent', 'inTransaction']
  const found = writePrimitives.filter((primitive) => stripped.includes(primitive))
  record(
    'D3',
    'D',
    '结构判据：草案契约里**没有**写原语（去注释后仍为零命中）',
    found.length === 0,
    `命中=${JSON.stringify(found)}`
  )
  record(
    'D4',
    'D',
    '结构判据：字段闭集里**没有**程序事实字段（根数 / 归属 / 版本 / 权限）',
    !REFLECTION_DRAFT_FIELD_ALLOWLIST.some((field) =>
      ['rootCount', 'roots', 'owner', 'revision', 'authority', 'confidence', 'evidenceIds'].includes(field)
    ),
    `allowlist=${JSON.stringify(REFLECTION_DRAFT_FIELD_ALLOWLIST)}`
  )
  record(
    'D5',
    'D',
    '码点计数不是 UTF-16 长度（一个 emoji 算 1 个码点，否则 300 的上界会被悄悄提前触发）',
    codepointLength('😀') === 1 && codepointLength('中') === 1 && codepointLength('ab') === 2,
    `emoji=${String(codepointLength('😀'))} · 汉字=${String(codepointLength('中'))}`
  )

  // -------------------------------------------------------------------------
  // F 组 —— 触发检测与门槛（**纯函数**，构造读数；不碰库、不调模型）
  // -------------------------------------------------------------------------
  const triggerFor = (type: string, reason?: string): ReflectionTriggerKind | undefined =>
    detectReflectionTriggers([
      { id: 'de:1', type, sequence: 1, ...(reason === undefined ? {} : { reason }), sourceConversationEventIds: [] },
    ])[0]?.kind

  const mappedTypes: { type: string; kind: ReflectionTriggerKind }[] = [
    { type: GOAL_COMPLETED, kind: 'goal_outcome' },
    { type: GOAL_BLOCKED, kind: 'goal_outcome' },
    { type: GOAL_CANCELLED, kind: 'goal_outcome' },
    { type: COMMITMENT_FULFILLED, kind: 'commitment_outcome' },
    { type: COMMITMENT_BROKEN, kind: 'commitment_outcome' },
    { type: COMMITMENT_CANCELLED, kind: 'commitment_outcome' },
    { type: MEMORY_DISPUTED, kind: 'registered_conflict' },
    { type: BELIEF_DISPUTED, kind: 'registered_conflict' },
  ]
  const mappedOk = mappedTypes.filter((row) => triggerFor(row.type) === row.kind)
  record(
    'F1',
    'F',
    '【表覆盖】映射表里的每种事件类型都真的产出它登记的那个触发',
    mappedOk.length === mappedTypes.length,
    `${String(mappedOk.length)}/${String(mappedTypes.length)} · 实到=${JSON.stringify(mappedTypes.map((row) => `${row.type}→${String(triggerFor(row.type))}`))}`
  )

  const retractedCases: { reason: string; kind: ReflectionTriggerKind | undefined }[] = [
    { reason: 'explicit_correction', kind: triggerFor(MEMORY_RETRACTED, 'explicit_correction') },
    { reason: 'explicit_forget', kind: triggerFor(MEMORY_RETRACTED, 'explicit_forget') },
    { reason: 'audit', kind: triggerFor(MEMORY_RETRACTED, 'audit') },
  ]
  record(
    'F2',
    'F',
    '【细分】`MEMORY_RETRACTED` 按 reason 分列：更正 ⇒ `user_correction` · 遗忘 ⇒ `safety_invalidation` · **audit ⇒ 不触发**',
    retractedCases[0]?.kind === 'user_correction' &&
      retractedCases[1]?.kind === 'safety_invalidation' &&
      retractedCases[2]?.kind === undefined,
    `实到=${JSON.stringify(retractedCases)}`
  )

  const reachedKinds = new Set<ReflectionTriggerKind>(
    [...mappedTypes.map((row) => row.kind), 'user_correction', 'safety_invalidation']
  )
  const detectable = REFLECTION_TRIGGER_KINDS.filter(
    (kind) => REFLECTION_TRIGGER_FACTS[kind].v1Detectable
  )
  /*
   * ⚠️ **判据修正（2026-10-03，S8/WP5）**：本项原来隐含一条假设 ——
   * "登记为 `v1Detectable` 的触发**全部**由 `detectReflectionTriggers` 从领域事件产出"。
   *
   * ADR-093 `D10` 追加了第七种触发 `story_outcome`，它的来源是**世界账本**，
   * 由 `buildReflectionInput` 的 `storyOutcomes` 入口产出（**不是**领域事件）——
   * 于是上面那条假设不再成立，但**判据的实质没变**：登记为可达的，必须真的有一条
   * 已实现的产出路径；`user_feedback` 必须**不可达**。
   *
   * ⇒ 修正为"两条已实现来源的并集"：
   * ```text
   * detectReflectionTriggers（领域事件）  ∪  buildReflectionInput(storyOutcomes)（世界账本）
   * ```
   * 并且**显式**断言 `story_outcome` 确实由故事入口登记（`detector` 字段可查），
   * 免得"把某个不可达的触发偷偷标成可达"。
   */
  const storyProduced: ReflectionTriggerKind = 'story_outcome'
  record(
    'F3',
    'F',
    '【可达性自检】登记为"v1 可检测"的触发种类**全部**真的可达（领域事件 ∪ 世界账本两条来源）；`user_feedback` 不可达且事实表如实登记',
    detectable
      .filter((kind) => kind !== storyProduced)
      .every((kind) => reachedKinds.has(kind)) &&
      REFLECTION_TRIGGER_FACTS[storyProduced].detector.includes('storyOutcomes') &&
      !reachedKinds.has('user_feedback') &&
      REFLECTION_TRIGGER_FACTS.user_feedback.v1Detectable === false,
    `可达（领域事件侧）=${JSON.stringify([...reachedKinds])} · 登记可检测=${JSON.stringify(detectable)} · story_outcome 产出路径=${REFLECTION_TRIGGER_FACTS[storyProduced].detector} · user_feedback 可达=${String(reachedKinds.has('user_feedback'))}`
  )

  record(
    'F4',
    'F',
    '【负控】不在表里的领域事件类型**不产生**任何触发（不是"猜一个"）',
    triggerFor('DIAGNOSTIC_SIGNAL') === undefined && triggerFor('MEMORY_CREATED') === undefined,
    `DIAGNOSTIC_SIGNAL=${String(triggerFor('DIAGNOSTIC_SIGNAL'))} · MEMORY_CREATED=${String(triggerFor('MEMORY_CREATED'))}`
  )

  // 构造一个内存 source（**不只是**真实库：这样超限与窗口边界可确定性地测）
  const fakeSource = (events: ReflectionTriggerEventReading[]): ReflectionInputSource => ({
    async domainEventsSince(afterSequence, limit) {
      return events.filter((event) => event.sequence > afterSequence).slice(0, limit)
    },
    async conversationActors(ids) {
      return ids.map((id) => ({ id, actorType: 'user', sequence: 7, text: `用户说过（${id}）` }))
    },
  })

  const noTrigger = await buildReflectionInput(fakeSource([]), {
    characterId: 'char_x',
    cutoverSequence: 0,
    watermark: 0,
  })
  record(
    'F5',
    'F',
    '【负控】窗口里没有触发 ⇒ 装配返回 `undefined`（调用方据此**不调用模型**，`D15`）',
    noTrigger === undefined,
    `返回=${noTrigger === undefined ? 'undefined' : '有输入'}`
  )

  const manyEvents: ReflectionTriggerEventReading[] = Array.from({ length: 60 }, (_, i) => ({
    id: `de:${String(i)}`,
    type: GOAL_COMPLETED,
    sequence: i + 1,
    sourceConversationEventIds: [`cev:${String(i)}`],
  }))
  const bounded = await buildReflectionInput(fakeSource(manyEvents), {
    characterId: 'char_x',
    cutoverSequence: 0,
    watermark: 0,
  })
  record(
    'F6',
    'F',
    `【有界】60 条触发事件 ⇒ 窗口不超过 ${String(REFLECTION_MAX_WINDOW_INPUTS)} 且如实标记 \`windowTruncated\`（不假装看全）`,
    bounded !== undefined &&
      bounded.window.length <= REFLECTION_MAX_WINDOW_INPUTS &&
      bounded.windowTruncated === true &&
      bounded.handles.length === bounded.window.length,
    bounded === undefined
      ? '没构造出输入'
      : `window=${String(bounded.window.length)} · truncated=${String(bounded.windowTruncated)} · handles=${String(bounded.handles.length)}`
  )

  const hinted = await buildReflectionInput(fakeSource(manyEvents.slice(0, 1)), {
    characterId: 'char_x',
    cutoverSequence: 0,
    watermark: 0,
    classHints: { 'cev:0': 'user_report' },
  })
  record(
    'F7',
    'F',
    '【标签】程序事实优先：`classHints` 给的 `user_report` 覆盖默认的 `user_statement`（模型不自己归类）',
    hinted !== undefined && hinted.window.some((entry) => entry.sourceClass === 'user_report'),
    hinted === undefined ? '没构造出输入' : `window=${JSON.stringify(hinted.window.map((e) => `${e.id}:${e.sourceClass}`))}`
  )

  // 门槛（`D10`）——手算用例
  const verdicts = {
    ok: meetsStabilityThreshold({ rootCount: 3, conversationCount: 2, unresolvedConflict: false }),
    twoRoots: meetsStabilityThreshold({ rootCount: 2, conversationCount: 5, unresolvedConflict: false }),
    oneRoot: meetsStabilityThreshold({ rootCount: 1, conversationCount: 5, unresolvedConflict: false }),
    oneSession: meetsStabilityThreshold({ rootCount: 3, conversationCount: 1, unresolvedConflict: false }),
    conflict: meetsStabilityThreshold({ rootCount: 3, conversationCount: 2, unresolvedConflict: true }),
  }
  record(
    'F8',
    'F',
    '【手算】稳定门槛：3 根/2 会话/无冲突 ⇒ 达标；其余四种各自给出**具名**理由码',
    verdicts.ok.met === true &&
      verdicts.twoRoots.met === false &&
      verdicts.twoRoots.reason === 'threshold_not_met' &&
      verdicts.oneRoot.met === false &&
      verdicts.oneRoot.reason === 'single_root_only' &&
      verdicts.oneSession.met === false &&
      verdicts.oneSession.reason === 'single_session_only' &&
      verdicts.conflict.met === false &&
      verdicts.conflict.reason === 'conflicting_support',
    `ok=${String(verdicts.ok.met)} · 2根=${String(verdicts.twoRoots.met ? 'met' : verdicts.twoRoots.reason)} · ` +
      `1根=${String(verdicts.oneRoot.met ? 'met' : verdicts.oneRoot.reason)} · ` +
      `1会话=${String(verdicts.oneSession.met ? 'met' : verdicts.oneSession.reason)} · ` +
      `冲突=${String(verdicts.conflict.met ? 'met' : verdicts.conflict.reason)}`
  )

  // -------------------------------------------------------------------------
  // G 组 —— **真实库**喂真实适配器
  // -------------------------------------------------------------------------
  const realSource = createReflectionInputSource(db, { characterId: h.kernel.characterId as CharacterId })

  const realRows = await realSource.domainEventsSince(0, 10)
  record(
    'G1',
    'G',
    '【真实库】水位之后的领域事件真的读得出来（非零），且**每条都在**窗口上界之内',
    realRows.length > 0 && realRows.length <= 10,
    `读回 ${String(realRows.length)} 条 · types=${JSON.stringify(realRows.map((row) => row.type))}`
  )

  const boundedRead = await realSource.domainEventsSince(0, 1)
  record(
    'G2',
    'G',
    '【有界】`limit` **下推到 SQL**：要 1 条就只回 1 条（不是查全量再切片）',
    boundedRead.length === 1,
    `limit=1 ⇒ 读回 ${String(boundedRead.length)} 条`
  )

  const realInput = await buildReflectionInput(realSource, {
    characterId: String(h.kernel.characterId),
    cutoverSequence: 0,
    watermark: 0,
  })
  record(
    'G3',
    'G',
    '【负控·真实库】诊断信号不是触发 ⇒ 真实窗口**不误触发**（`undefined`）',
    realInput === undefined,
    `返回=${realInput === undefined ? 'undefined' : JSON.stringify(realInput.triggers)}`
  )

  const beforeG = await countByGroup()
  for (let i = 0; i < 5; i += 1) {
    await buildReflectionInput(realSource, {
      characterId: String(h.kernel.characterId),
      cutoverSequence: 0,
      watermark: 0,
    })
  }
  const afterG = await countByGroup()
  const deltasG = Object.fromEntries(
    Object.keys(beforeG).map((key) => [key, (afterG[key] ?? 0) - (beforeG[key] ?? 0)])
  ) as Record<string, number>
  record(
    'G4',
    'G',
    '【零写入】真实输入链跑 5 次之后：所有领域事件数**一个都没变**（含非零分母自检）',
    Object.values(deltasG).every((delta) => delta === 0) && (beforeG.other ?? 0) > 0,
    `deltas=${JSON.stringify(deltasG)} · before.other=${String(beforeG.other ?? 0)}`
  )

  const inputSrc = readFileSync(join(REPO_ROOT, 'src/kernel/app/reflection/inputs.ts'), 'utf8')
  const inputStripped = inputSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  const inputWrites = ['insertProjection', 'saveProjection', 'deleteProjection', 'applyAcceptedEvents', 'appendDomainEvent', 'inTransaction'].filter(
    (primitive) => inputStripped.includes(primitive)
  )
  record(
    'G5',
    'G',
    '结构判据：输入装配模块里**没有**写原语（"输入链不写库"是结构性质，不是运行时巧合）',
    inputWrites.length === 0,
    `命中=${JSON.stringify(inputWrites)}`
  )

  // -------------------------------------------------------------------------
  // H 组 —— **有界正文与遮蔽先于注入**（`L-M11-14` 的修复判据）
  // -------------------------------------------------------------------------
  const canary = 'CANARY_FORGOTTEN_VALUE_7749'
  const textEvents: ReflectionTriggerEventReading[] = [
    {
      id: 'de:t1',
      type: 'GOAL_COMPLETED',
      sequence: 1,
      sourceConversationEventIds: ['ce:text'],
    },
  ]
  const textSource: ReflectionInputSource = {
    async domainEventsSince(afterSequence, limit) {
      return textEvents.filter((event) => event.sequence > afterSequence).slice(0, limit)
    },
    async conversationActors(ids) {
      return ids.map((id) => ({
        id,
        actorType: 'user',
        sequence: 9,
        conversationId: 'input-source-session',
        text: `${canary} 这一句很长`.repeat(40),
      }))
    },
  }
  const unmasked = await buildReflectionInput(textSource, {
    characterId: 'char_x',
    cutoverSequence: 0,
    watermark: 0,
  })
  const conversationEntry = unmasked?.window.find((entry) => entry.kind === 'conversation_event')
  const domainEntry = unmasked?.window.find((entry) => entry.kind === 'domain_event')
  record('H5', 'H', '实际会话只从对话读数传播；不为领域事件推定会话',
    conversationEntry?.conversationId === 'input-source-session' && domainEntry?.conversationId === undefined,
    `conversationId=${String(conversationEntry?.conversationId)}`)
  record(
    'H1',
    'H',
    '【有界正文】对话条目的正文**存在**且 ≤300 码点（模型有东西可反思 —— WP3 第一版缺这一格，`L-M11-14`）',
    conversationEntry !== undefined &&
      conversationEntry.text.length > 0 &&
      [...conversationEntry.text].length <= 300,
    `长度=${String(conversationEntry === undefined ? -1 : [...conversationEntry.text].length)}`
  )
  record(
    'H2',
    'H',
    '【领域事件只给类型名】领域事件条目的正文**恰好**是 `（程序事件：<type>）`（payload / 其它内容无处可进）',
    domainEntry !== undefined && domainEntry.text === '（程序事件：GOAL_COMPLETED）',
    `text=${JSON.stringify(domainEntry?.text)}`
  )
  const masked = await buildReflectionInput(textSource, {
    characterId: 'char_x',
    cutoverSequence: 0,
    watermark: 0,
    maskedIds: new Set(['ce:text']),
  })
  const maskedEntry = masked?.window.find((entry) => entry.kind === 'conversation_event')
  record(
    'H3',
    'H',
    '【遮蔽先于注入】被遮蔽的来源：条目正文**只是**那个常量标记，且**整份输入**里搜不到 canary',
    maskedEntry !== undefined &&
      maskedEntry.text === REFLECTION_WINDOW_MASKED_TEXT &&
      !JSON.stringify(masked).includes(canary),
    `标记一致=${String(maskedEntry?.text === REFLECTION_WINDOW_MASKED_TEXT)} · 全份含 canary=${String(JSON.stringify(masked).includes(canary))}`
  )
  record(
    'H4',
    'H',
    '【负控·对照】同一条来源在**不**遮蔽时 canary **确实**出现（证明 H3 不是因为"根本读不到正文"而通过）',
    JSON.stringify(unmasked).includes(canary),
    `未遮蔽时含 canary=${String(JSON.stringify(unmasked).includes(canary))}`
  )

  // -------------------------------------------------------------------------
  // S 组 —— 量具自检
  // -------------------------------------------------------------------------
  const byGroup = { A: 0, B: 0, C: 0, D: 0, F: 0, G: 0, H: 0 }
  for (const c of checks) if (c.group !== 'S') byGroup[c.group] += 1
  record(
    'S1',
    'S',
    '六组都测到**非零**条目（否则本次读数判 MEASUREMENT INVALID，不是 PASS）',
    Object.values(byGroup).every((count) => count > 0),
    Object.entries(byGroup)
      .map(([group, count]) => `${group}=${String(count)}`)
      .join(' · ')
  )

  // -------------------------------------------------------------------------
  // 落盘
  // -------------------------------------------------------------------------
  const failed = checks.filter((c) => !c.pass)
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  const runId =
    out === undefined ? createM11RunId({ wpId: 'wp3', headShort: head }) : runIdFromM11OutPath(REPO_ROOT, out)
  const dir = openM11RunDir(REPO_ROOT, runId)

  const payload = {
    schema: 'm11-inputs-verify@1',
    manifestVersion: M11_MANIFEST_VERSION,
    runId,
    head,
    databaseScope: 'isolated-sandbox',
    modelCalls: 0,
    measuredCount: checks.length,
    reasonsProduced: [...producedSet].sort(),
    checks,
    summary: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
    verdict: failed.length === 0 ? 'PASS' : 'FAIL',
  }
  writeFileSync(join(dir, 'inputs-verify.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  writeM11Manifest(dir, {
    runId,
    wp: 'wp3',
    head,
    headShort: head.slice(0, 12),
    branch: 'codex/m11-execution-plan',
    date: new Date().toISOString().slice(0, 10),
    toolVersions: { node: process.version },
    testType: 'inputs',
    counts: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
    phases: ['single'],
    supersedes: null,
    notes: 'm11:inputs:verify（结构化候选：闭集 + 理由码可达 + 零写入）',
  })

  console.log(`runId: ${runId}`)
  for (const c of checks) console.log(`  ${c.pass ? '✅' : '❌'} ${c.id} ${c.label} —— ${c.detail}`)
  console.log(`verdict: ${failed.length === 0 ? 'PASS' : 'FAIL'}（${String(checks.length - failed.length)}/${String(checks.length)}）`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((error: unknown) => {
  console.error('m11:inputs:verify 抛错（不是被拒，是执行器坏了）：', error)
  process.exit(1)
})
