/**
 * M8.5 WP9 —— 语料回放门（§16.1 门清单第二件：`pnpm m8.5:corpus:verify`）
 *
 * 规格 §5（Corpus-Spec）：Gate 层机械正确率 = **100%**——金标经假 provider
 * 回放，解析/校验/映射/提交逐条一致；§16.2 负控全响。语义阈值**不**在假
 * provider 上判（那是 WP10 真模型盲测的事）。
 *
 * 三层回放：
 *   A（纯进程，smoke 50 + gate 计分 272）：逐条真出站构造（含条目上下文）→
 *     金标脚本化信封 → 解析 → 映射；断言判定/主导族/精确增量逐条一致。
 *   B（隔离库，真 worker，gate 计分 272）：逐条真记录（含上下文事件）→
 *     真 tick（脚本化模型）→ 真放行口提交；断言终结闸回执 + IMPACT 事件
 *     的族/策略版本/精确增量逐条一致，零放行口拒绝。
 *   C（失败注入，§16.2 全响）：11 解析失败码逐码 + 传输失败重试→烧尽；
 *     断言诚实终态、零伪造结果、零 IMPACT。
 *
 * blind 层**不进本门**（heldout 纪律——永不用于离线门/指令迭代）。
 * 量具纪律：正控/负控/恢复三段式；measured_count 自检；证据落盘。
 */
import 'dotenv/config'

import { isolateDatabase } from '../src/dev/sandbox.ts'
isolateDatabase('m8.5-corpus-replay', { keep: false })

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AgentRuntime, type Character } from '@elizaos/core'
import sqlPlugin from '@elizaos/plugin-sql'

import { character } from '../src/character/index.ts'
import { initDatabase } from '../src/db/index.ts'
import { initKernel } from '../src/kernel/app/kernel.ts'
import { characterDefinitionFromCharacter } from '../src/infrastructure/runtime/seed-projection.ts'
import { ConversationRecorder } from '../src/infrastructure/runtime/conversation-recorder.ts'
import {
  createCharacterAssistantTurnIngress,
  createHumanConsoleUserTurnIngress,
} from '../src/infrastructure/runtime/conversation-attribution.ts'
import { latestConversationSequence } from '../src/infrastructure/persistence/conversation-store.ts'
import { allocateSequenceRange } from '../src/infrastructure/persistence/sequence.ts'
import { domainEventsFor, rebuildProjection } from '../src/infrastructure/persistence/event-store.ts'
import { getAffectProjection } from '../src/infrastructure/persistence/affect-store.ts'
import { listProcessedOperations } from '../src/infrastructure/persistence/job-store.ts'
import { maybeRunAffectEvaluation } from '../src/infrastructure/runtime/affect-scheduler.ts'
import { maybeRunAffectSemanticEvaluation } from '../src/infrastructure/runtime/affect-semantic-scheduler.ts'
import { affectReducerV2For } from '../src/kernel/projections/affect.ts'
import { AFFECT_RULE_DELTAS } from '../src/kernel/app/affect/patterns.ts'
import {
  buildSemanticOutbound,
  evaluateSemanticResponse,
  type SemanticModelResponseEnvelope,
} from '../src/kernel/app/affect/semantic-evaluator.ts'
import {
  AFFECT_SEMANTIC_POLICY_VERSION,
  AFFECT_SEMANTIC_REASON_TABLE,
  affectSemanticFinalizedGateKey,
  isValidAffectSemanticSpan,
  type AffectSemanticContextMessage,
  type AffectSemanticContextRole,
  type AffectSemanticContextAlias,
  type AffectSemanticTransportFailureCode,
} from '../src/kernel/contracts/affect-semantic.ts'
import { AFFECT_IMPACT } from '../src/kernel/contracts/domain-event.ts'
import { asConversationId } from '../src/kernel/contracts/index.ts'
import type {
  AffectSemanticProvider,
  AffectSemanticProviderCall,
  AffectSemanticTransportOutcome,
} from '../src/infrastructure/model/affect-semantic-provider.ts'

// ---------------------------------------------------------------------------
// 量具
// ---------------------------------------------------------------------------

type Phase = 'static' | 'positive' | 'negative' | 'recovery'
const results: Array<{ phase: Phase; id: string; label: string; expected: string; actual: string; pass: boolean }> = []
let measured = 0

function check(phase: Phase, id: string, label: string, expected: string, actual: string, pass: boolean): void {
  measured += 1
  results.push({ phase, id, label, expected, actual, pass })
  if (!pass) console.log(`FAIL [${phase}] ${id} ${label}: expected=${expected} actual=${actual}`)
}

function checkTrue(phase: Phase, id: string, label: string, value: boolean): void {
  check(phase, id, label, 'true', String(value), value === true)
}

function checkEqual<T>(phase: Phase, id: string, label: string, expected: T, actual: T): void {
  check(phase, id, label, JSON.stringify(expected), JSON.stringify(actual), Object.is(expected, actual))
}

// ---------------------------------------------------------------------------
// ① 语料装载（smoke + gate 计分层；blind 不进本门）
// ---------------------------------------------------------------------------

interface CorpusEntry {
  id: string
  layer: string
  category: string
  tags?: string[]
  context?: Array<{ role: string; text: string }>
  message: string
  gold: { decision: string; family?: string }
  note?: string
  status?: string
}

const CORPUS_ROOT = join(process.cwd(), 'evals', 'm8.5', 'corpus')

function loadJsonl(relative: string): CorpusEntry[] {
  const entries: CorpusEntry[] = []
  const lines = readFileSync(join(CORPUS_ROOT, relative), 'utf8').split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    entries.push(JSON.parse(trimmed) as CorpusEntry)
  }
  return entries
}

const smokeEntries = loadJsonl('smoke.jsonl')
const gateFiles = readdirSync(join(CORPUS_ROOT, 'gate'), { withFileTypes: true })
  .filter((d) => d.name.endsWith('.jsonl'))
  .map((d) => d.name)
  .sort()
const gateEntries = gateFiles.flatMap((name) => loadJsonl(join('gate', name)))
const gateScored = gateEntries.filter((e) => e.status !== 'pending-ruling')
const tierAEntries = [...smokeEntries, ...gateScored]

checkEqual('static', 'S1', '语料形状：smoke = 50（规格 §1 配额）', 50, smokeEntries.length)
checkTrue('static', 'S2', '语料形状：gate ≥ 250 且计分 ≥ 250（pending-ruling 不计分）',
  gateEntries.length >= 250 && gateScored.length >= 250)
checkEqual('static', 'S3', '回放面：Tier A = smoke + gate 计分（322）', 322, tierAEntries.length)
checkEqual('static', 'S4', '回放面：Tier B = gate 计分（272）', 272, gateScored.length)
checkTrue('static', 'S5', 'heldout 纪律：本门不读 blind.jsonl',
  !JSON.stringify(gateFiles).includes('blind') && tierAEntries.every((e) => e.layer !== 'blind'))

// ---------------------------------------------------------------------------
// ② 金标 → 脚本化模型输出（机械回放的"模型侧"）
// ---------------------------------------------------------------------------

/** 为 (decision, family) 选一个冻结词表里的自洽 reasonCode */
function reasonCodeFor(decision: string, family?: string): string {
  const spec = AFFECT_SEMANTIC_REASON_TABLE.find(
    (s) => s.decision === decision && (decision === 'IMPACT' ? s.family === family : true),
  )
  if (spec === undefined) throw new Error(`reasonCode 缺失：${decision}/${String(family)}`)
  return spec.code
}

/** 在消息里找第一个合法 span（避开代理对；机械引用只需"存在"） */
function safeSpan(message: string): { start: number; end: number } {
  for (let end = 2; end <= message.length; end += 1) {
    const span = { start: 0, end }
    if (isValidAffectSemanticSpan(span, message)) return span
  }
  throw new Error(`消息无法定位合法 span：${message}`)
}

/** 金标 → 合法模型输出体（判定/族来自金标；span/reasonCode 程序构造） */
function goldBody(entry: CorpusEntry): string {
  const { decision, family } = entry.gold
  if (decision === 'IMPACT') {
    if (family === undefined) throw new Error(`IMPACT 金标缺族：${entry.id}`)
    return JSON.stringify({
      decision, target: 'CHARACTER',
      candidates: [{ family, span: safeSpan(entry.message) }],
      contextRefs: [], reasonCode: reasonCodeFor(decision, family),
    })
  }
  return JSON.stringify({
    decision, target: 'CHARACTER', candidates: [], contextRefs: [],
    reasonCode: reasonCodeFor(decision),
  })
}

/** 条目上下文 → 出站请求的窗口消息（语料"最旧在前" ⇒ 反转成 m-1=最近） */
function contextWindowOf(entry: CorpusEntry): AffectSemanticContextMessage[] {
  if (entry.context === undefined) return []
  const newestFirst = [...entry.context].reverse().slice(0, 6)
  return newestFirst.map((c, index) => ({
    role: (c.role === 'assistant' ? 'assistant' : 'user') as AffectSemanticContextRole,
    text: c.text,
    alias: `m-${String(index + 1)}` as AffectSemanticContextAlias,
  }))
}

// ---------------------------------------------------------------------------
// ③ Tier A：全量解析/映射回放（纯进程；smoke + gate 计分逐条）
// ---------------------------------------------------------------------------

{
  let outboundOk = 0
  let parseOk = 0
  let decisionMatch = 0
  let familyMatch = 0
  let deltaExact = 0
  const mismatches: string[] = []
  const decisionTally = new Map<string, number>()

  for (const entry of tierAEntries) {
    const request = {
      characterAlias: character.name,
      context: contextWindowOf(entry),
      currentMessage: entry.message,
    }
    const outbound = buildSemanticOutbound(request)
    if (!outbound.ok) {
      mismatches.push(`${entry.id}: input_budget_exceeded`)
      continue
    }
    outboundOk += 1
    const envelope: SemanticModelResponseEnvelope = {
      content: goldBody(entry), finishReason: 'stop', hasToolCalls: false,
    }
    const outcome = evaluateSemanticResponse(envelope, request)
    if (outcome.kind !== 'judgment') {
      mismatches.push(`${entry.id}: parse_failed=${outcome.failure}`)
      continue
    }
    parseOk += 1
    const { judgment, mapping } = outcome
    decisionTally.set(judgment.decision, (decisionTally.get(judgment.decision) ?? 0) + 1)
    if (judgment.decision === entry.gold.decision) decisionMatch += 1
    else mismatches.push(`${entry.id}: decision ${judgment.decision} ≠ ${entry.gold.decision}`)
    if (entry.gold.decision === 'IMPACT') {
      const expectedDelta = AFFECT_RULE_DELTAS[entry.gold.family as keyof typeof AFFECT_RULE_DELTAS]
      if (mapping.dominantFamily === entry.gold.family) familyMatch += 1
      else mismatches.push(`${entry.id}: family ${String(mapping.dominantFamily)} ≠ ${String(entry.gold.family)}`)
      if (
        mapping.delta !== undefined && expectedDelta !== undefined &&
        mapping.delta.deltaValence === expectedDelta.deltaValence &&
        mapping.delta.deltaArousal === expectedDelta.deltaArousal &&
        mapping.policyVersion === AFFECT_SEMANTIC_POLICY_VERSION
      ) deltaExact += 1
      else mismatches.push(`${entry.id}: delta/policy 不精确`)
    }
  }

  checkEqual('positive', 'A1', 'Tier A：全部条目出站构造成功（含上下文；零预算超限）',
    tierAEntries.length, outboundOk)
  checkEqual('positive', 'A2', 'Tier A：金标体全部通过严格解析（零解析失败）',
    tierAEntries.length, parseOk)
  checkEqual('positive', 'A3', 'Tier A：判定逐条一致（机械正确率 100%）',
    tierAEntries.length, decisionMatch)
  const impactTotal = tierAEntries.filter((e) => e.gold.decision === 'IMPACT').length
  checkEqual('positive', 'A4', 'Tier A：IMPACT 主导族逐条一致（金标族 = 全序裁定族）',
    impactTotal, familyMatch)
  checkEqual('positive', 'A5', 'Tier A：IMPACT 增量逐条精确（冻结表查表 + 语义策略版本）',
    impactTotal, deltaExact)
  checkEqual('positive', 'A6', 'Tier A：IMPACT 判定计数与金标一致',
    impactTotal, decisionTally.get('IMPACT') ?? 0)
  if (mismatches.length > 0) {
    console.log(`  Tier A 不一致清单（前 10）：${mismatches.slice(0, 10).join(' · ')}`)
  }
}

// ---------------------------------------------------------------------------
// ④ 隔离库引导 + 建档 + 受控 rebuild @2（WP13 激活段的机制面，WP8 门同款）
// ---------------------------------------------------------------------------

const runtime = new AgentRuntime({ character: character as Character, plugins: [], settings: {} })
await initDatabase(runtime, sqlPlugin)
await runtime.initialize()
const kernel = await initKernel(runtime, {
  definition: characterDefinitionFromCharacter(character),
})
const characterId = kernel.characterId
const db = kernel.stores.db

const USER = 'm85-corpus-user'
const CONV = asConversationId('m85-corpus-conv')
const CONV2 = asConversationId('m85-corpus-conv-failures')
const recorder = new ConversationRecorder({
  db, characterId, conversationId: CONV, dryRun: false, userName: USER,
  characterName: character.name, transport: 'm8.5-corpus-replay',
  attribution: [createHumanConsoleUserTurnIngress(), createCharacterAssistantTurnIngress()],
  userId: USER, userRef: USER,
})
const failureRecorder = new ConversationRecorder({
  db, characterId, conversationId: CONV2, dryRun: false, userName: USER,
  characterName: character.name, transport: 'm8.5-corpus-replay',
  attribution: [createHumanConsoleUserTurnIngress(), createCharacterAssistantTurnIngress()],
  userId: USER, userRef: USER,
})

// 脚本化 provider（零真实出站；耗尽即抛 = 计划外出站负控）。
// 三态条目：合法体（字符串）/ 信封形状（失败注入需要 null content 等）/ 传输失败。
type ScriptedCall =
  | { ok: true; content: string }
  | { ok: true; envelope: SemanticModelResponseEnvelope }
  | { ok: false; failure: AffectSemanticTransportFailureCode }
const script: ScriptedCall[] = []
let modelCalls = 0
const scriptedShape = {
  httpStatus: 200, choiceCount: 1, messagePresent: true, contentKind: 'string' as const,
  contentLength: 0, finishReason: 'stop' as const, toolCallCount: 0, refusalPresent: false,
  bodyWasJson: true, promptTokens: null, completionTokens: null, reasoningTokens: null,
  headersMs: 1, bodyMs: 1, totalMs: 2, retryAfterMs: 0,
}
const scriptedProvider: AffectSemanticProvider = {
  id: 'm85-corpus-scripted',
  endpointHost: 'gate.invalid',
  async call(_input: AffectSemanticProviderCall): Promise<AffectSemanticTransportOutcome> {
    modelCalls += 1
    const next = script.shift()
    if (next === undefined) throw new Error('script exhausted: 计划外的模型调用')
    if (!next.ok) return { ok: false, failure: next.failure, requestCount: 1 }
    if ('envelope' in next) {
      return {
        ok: true,
        envelope: next.envelope,
        shape: { ...scriptedShape, contentLength: next.envelope.content?.length ?? 0 },
        requestCount: 1,
      }
    }
    return {
      ok: true,
      envelope: { content: next.content, finishReason: 'stop', hasToolCalls: false },
      shape: { ...scriptedShape, contentLength: next.content.length },
      requestCount: 1,
    }
  },
}
const NEUTRAL_BODY = goldBody({ id: 'fixture', layer: 'gate', category: 'neutral', message: '好。', gold: { decision: 'NEUTRAL' } })

const semanticInput = {
  characterId,
  characterAlias: character.name,
  activeUserId: USER,
  provider: scriptedProvider,
}

// 建档（cutover=0）+ 受控 rebuild @2（版本守卫：语义提交恒走 @2 折叠）
const seeding = await maybeRunAffectEvaluation(db, { characterId, activeUserId: USER })
checkEqual('positive', 'B0a', '建档：空账本 ⇒ no_tail（播种先于消费）', 'no_tail', seeding.kind)
const rebuild = await rebuildProjection(db, characterId, affectReducerV2For(characterId))
checkTrue('positive', 'B0b', '受控 rebuild @2：重放成功 + 行重盖 @2 章',
  rebuild.appliedEvents > 0 && rebuild.projection.reducerVersion === 'affect-reducer@2')

// ---------------------------------------------------------------------------
// ⑤ Tier B：真 worker 提交回放（gate 计分 272 逐条；含上下文事件）
// ---------------------------------------------------------------------------

const tStart = Date.now()
const TICK_NOW = tStart + 60_000

interface RecordedItem {
  entry: CorpusEntry
  eventId: string
}
const recordedItems: RecordedItem[] = []
let lastUserEventId: string | undefined
let contextEntriesRecorded = 0
let contextAssistantsSkipped = 0

async function recordInConv(
  rec: ConversationRecorder, conv: typeof CONV, text: string,
): Promise<{ eventId: string; sequence: number }> {
  const outcome = await rec.recordUserMessage(text, (await latestConversationSequence(db, characterId, conv)) + 1)
  return { eventId: String(outcome.event!.id), sequence: outcome.event!.sequence }
}

function countContextUsers(entries: CorpusEntry[]): number {
  let n = 0
  for (const e of entries) for (const c of e.context ?? []) if (c.role !== 'assistant') n += 1
  return n
}

for (const entry of gateScored) {
  // 上下文事件先行（user → 成为 source，脚本判 NEUTRAL；assistant → 回复图挂最近用户事件）
  for (const c of entry.context ?? []) {
    if (c.role === 'assistant') {
      if (lastUserEventId === undefined) {
        contextAssistantsSkipped += 1 // 首条即 assistant：回复图无锚可挂——Tier A 已覆盖其上下文机制
        continue
      }
      const seq = (await latestConversationSequence(db, characterId, CONV)) + 1
      // 助手事件需要自己的角色序号（角色序号空间 ≠ 会话序号空间；撞号 = 主键冲突）
      const range = await allocateSequenceRange(db, characterId, 1)
      await recorder.recordAssistantMessage({
        text: c.text,
        conversationSequence: seq,
        characterSequence: range.start,
        replyToEventId: lastUserEventId as never,
      })
      contextEntriesRecorded += 1
    } else {
      const rec = await recordInConv(recorder, CONV, c.text)
      lastUserEventId = rec.eventId
      script.push({ ok: true, content: NEUTRAL_BODY })
      contextEntriesRecorded += 1
    }
  }
  // 目标消息（语义 source；脚本 = 金标体）
  const rec = await recordInConv(recorder, CONV, entry.message)
  lastUserEventId = rec.eventId
  script.push({ ok: true, content: goldBody(entry) })
  recordedItems.push({ entry, eventId: rec.eventId })
}

checkEqual('positive', 'B1', 'Tier B：272 条目标消息全部落账（合格 source）',
  272, recordedItems.length)
checkTrue('positive', 'B2', 'Tier B：上下文事件如实记录（或全语料本就无上下文）',
  contextEntriesRecorded > 0 || countContextUsers(gateScored) === 0)

// tick 循环直到排干（批量 32；固定 now ⇒ 零过期、确定性）
const expectedModelCalls = script.length
let lastTick: Awaited<ReturnType<typeof maybeRunAffectSemanticEvaluation>> | undefined
let tickCount = 0
let totalCommitted = 0
let totalNoImpact = 0
let totalRejected = 0
let totalTerminal = 0
for (;;) {
  const tick = await maybeRunAffectSemanticEvaluation(db, { ...semanticInput, mode: 'semantic', now: TICK_NOW })
  tickCount += 1
  if (tick.kind === 'ran') {
    totalCommitted += tick.committed
    totalNoImpact += tick.noImpact
    totalRejected += tick.rejectedByValidator
    totalTerminal += tick.terminalFailed
  }
  if (tick.kind !== 'ran') { lastTick = tick; break }
  if (tickCount > 50) throw new Error('tick 循环超界（50 轮未排干——扫描批量或水位异常）')
}

const goldImpactCount = gateScored.filter((e) => e.gold.decision === 'IMPACT').length
const goldNoImpactCount = gateScored.length - goldImpactCount

checkEqual('positive', 'B3', 'Tier B：tick 排干（no_tail 收口）', 'no_tail', lastTick?.kind)
checkEqual('positive', 'B4', 'Tier B：committed = 金标 IMPACT 条数（逐条提交）',
  goldImpactCount, totalCommitted)
checkEqual('positive', 'B5', 'Tier B：no_impact = 金标非 IMPACT + 上下文 user source（NEUTRAL 判定）',
  goldNoImpactCount + countContextUsers(gateScored), totalNoImpact)
checkEqual('positive', 'B6', 'Tier B：零放行口拒绝（机械正确率 100%——金标映射全部合法）',
  0, totalRejected)
checkEqual('positive', 'B7', 'Tier B：零终态失败（主回放无失败注入）', 0, totalTerminal)
checkEqual('positive', 'B8', 'Tier B：模型调用 = 脚本条数（零计划外出站）',
  expectedModelCalls, modelCalls)

// 逐条断言：终结闸回执 + IMPACT 事件（族/策略版本/精确增量/来源绑定）
async function readGateRows(): Promise<Map<string, string>> {
  const rows = await listProcessedOperations(db, characterId, 3_000)
  return new Map(
    rows
      .filter((row) => String(row.idempotencyKey).startsWith('affect-semantic-finalized:'))
      .map((row) => [String(row.idempotencyKey), String(row.operation)]),
  )
}
async function readImpactBySource(): Promise<Map<string, Record<string, unknown>>> {
  const events = await domainEventsFor(db, characterId, { limit: 10_000 })
  return new Map(
    events
      .filter((e) => e.type === AFFECT_IMPACT)
      .map((e) => [String((e.payload as Record<string, unknown>).sourceEventId), e.payload as Record<string, unknown>]),
  )
}

const gateRowBySource = await readGateRows()
const impactBySource = await readImpactBySource()

let receiptMatch = 0
let impactPayloadMatch = 0
let noImpactClean = 0
const tierBMismatches: string[] = []
for (const { entry, eventId } of recordedItems) {
  const receipt = gateRowBySource.get(affectSemanticFinalizedGateKey(eventId as never))
  if (entry.gold.decision === 'IMPACT') {
    const family = entry.gold.family as string
    const expectedPrefix = `affect-semantic@1|COMMITTED|${family}|fp=`
    if (receipt !== undefined && receipt.startsWith(expectedPrefix) && /^[0-9a-f]{16}$/.test(receipt.slice(expectedPrefix.length))) {
      receiptMatch += 1
    } else tierBMismatches.push(`${entry.id}: 回执 ${String(receipt)}`)
    const payload = impactBySource.get(eventId)
    const expectedDelta = AFFECT_RULE_DELTAS[family as keyof typeof AFFECT_RULE_DELTAS]
    if (
      payload !== undefined &&
      payload.ruleId === family &&
      payload.ruleVersion === AFFECT_SEMANTIC_POLICY_VERSION &&
      (payload.delta as { deltaValence: number }).deltaValence === expectedDelta.deltaValence &&
      (payload.delta as { deltaArousal: number }).deltaArousal === expectedDelta.deltaArousal &&
      payload.timingKind === 'SOURCE_ANCHORED'
    ) {
      impactPayloadMatch += 1
    } else tierBMismatches.push(`${entry.id}: IMPACT 负载不精确`)
  } else {
    const expectedPrefix = `affect-semantic@1|NO_IMPACT|${entry.gold.decision}|fp=`
    if (receipt !== undefined && receipt.startsWith(expectedPrefix)) receiptMatch += 1
    else tierBMismatches.push(`${entry.id}: 回执 ${String(receipt)}`)
    if (!impactBySource.has(eventId)) noImpactClean += 1
    else tierBMismatches.push(`${entry.id}: 非 IMPACT 金标却落了 IMPACT`)
  }
}
checkEqual('positive', 'B9', 'Tier B：终结闸回执逐条一致（COMMITTED 带族+指纹 / NO_IMPACT 带判定）',
  gateScored.length, receiptMatch)
checkEqual('positive', 'B10', 'Tier B：IMPACT 事件负载逐条精确（族/策略版本/冻结增量/SOURCE_ANCHORED）',
  goldImpactCount, impactPayloadMatch)
checkEqual('positive', 'B11', 'Tier B：非 IMPACT 金标零 IMPACT 落库（弃权不改轴）',
  goldNoImpactCount, noImpactClean)
if (tierBMismatches.length > 0) {
  console.log(`  Tier B 不一致清单（前 10）：${tierBMismatches.slice(0, 10).join(' · ')}`)
}
checkEqual('positive', 'B12', 'Tier B：IMPACT 事件总数 = 金标 IMPACT 条数（无多余写入）',
  goldImpactCount, impactBySource.size)

// ---------------------------------------------------------------------------
// ⑥ Tier C：失败注入全响（§16.2；11 解析码逐码 + 传输重试→烧尽）
// ---------------------------------------------------------------------------

const failureEnvelopes: Array<{ code: string; envelope: SemanticModelResponseEnvelope }> = [
  { code: 'tool_calls', envelope: { content: NEUTRAL_BODY, finishReason: 'stop', hasToolCalls: true } },
  { code: 'refusal', envelope: { content: NEUTRAL_BODY, finishReason: 'content_filter', hasToolCalls: false } },
  { code: 'truncated', envelope: { content: NEUTRAL_BODY, finishReason: 'length', hasToolCalls: false } },
  { code: 'missing_content', envelope: { content: null, finishReason: 'stop', hasToolCalls: false } },
  { code: 'response_too_large', envelope: { content: 'x'.repeat(16_385), finishReason: 'stop', hasToolCalls: false } },
  { code: 'json_parse_failed', envelope: { content: '这不是JSON', finishReason: 'stop', hasToolCalls: false } },
  {
    code: 'schema_failed',
    envelope: {
      content: JSON.stringify({ decision: 'NEUTRAL', target: 'CHARACTER', candidates: [], contextRefs: [], reasonCode: 'ORDINARY_INTERACTION', confidence: 0.9 }),
      finishReason: 'stop', hasToolCalls: false,
    },
  },
  {
    code: 'decision_candidate_mismatch',
    envelope: {
      content: JSON.stringify({ decision: 'IMPACT', target: 'CHARACTER', candidates: [], contextRefs: [], reasonCode: 'DIRECT_APPRECIATION' }),
      finishReason: 'stop', hasToolCalls: false,
    },
  },
  {
    code: 'span_out_of_bounds',
    envelope: {
      content: JSON.stringify({ decision: 'IMPACT', target: 'CHARACTER', candidates: [{ family: 'A-GRATITUDE', span: { start: 0, end: 999 } }], contextRefs: [], reasonCode: 'DIRECT_APPRECIATION' }),
      finishReason: 'stop', hasToolCalls: false,
    },
  },
  {
    code: 'span_splits_surrogate',
    envelope: {
      content: JSON.stringify({ decision: 'IMPACT', target: 'CHARACTER', candidates: [{ family: 'A-GRATITUDE', span: { start: 0, end: 1 } }], contextRefs: [], reasonCode: 'DIRECT_APPRECIATION' }),
      finishReason: 'stop', hasToolCalls: false,
    },
  },
]

const failureSourceIds: string[] = []
// forged_context_ref 必须是 CONV2 首条（无先前事件 ⇒ m-1 未分配）
{
  const rec = await recordInConv(failureRecorder, CONV2, '这条引用了不存在的上下文。')
  failureSourceIds.push(rec.eventId)
  script.push({
    ok: true,
    envelope: {
      content: JSON.stringify({ decision: 'NEUTRAL', target: 'CHARACTER', candidates: [], contextRefs: ['m-1'], reasonCode: 'ORDINARY_INTERACTION' }),
      finishReason: 'stop', hasToolCalls: false,
    },
  })
}
for (const failure of failureEnvelopes) {
  const message = failure.code === 'span_splits_surrogate' ? '𝄞这条会拆开代理对。' : `这条触发${failure.code}。`
  const rec = await recordInConv(failureRecorder, CONV2, message)
  failureSourceIds.push(rec.eventId)
  script.push({ ok: true, envelope: failure.envelope })
}
// 传输失败重试对（最后记录 ⇒ 队列楔住不影响前面的解析失败）
const transportRec = await recordInConv(failureRecorder, CONV2, '这条会撞上传输失败。')
const transportSourceId = transportRec.eventId

// Tier C 用新鲜 now（Tier B 耗时不可知 ⇒ 不能复用 TICK_NOW）
const TICK_NOW_C = Date.now() + 60_000

// tick 循环直到传输 source 首次尝试：IMPACT 域事件消耗序号计数器 ⇒ 会话序号
// 空间有 ~272 个洞（M6.1 冻结单 §11 的"空洞"），扫描每轮只推进 32 个序号，
// 失败源可能跨多轮 tick 才全部触达（生产每轮 ≤2 个洞，无此规模效应）——
// 解析失败码在**全部 Tier C 轮次上累计**断言。
script.push({ ok: false, failure: 'rate_limited' })
let failTick1: Awaited<ReturnType<typeof maybeRunAffectSemanticEvaluation>> | undefined
const tierCParseFailures: Record<string, number> = {}
let tierCTerminal = 0
let tierCCommitted = 0
let cTicks = 0
for (;;) {
  const tick = await maybeRunAffectSemanticEvaluation(db, { ...semanticInput, mode: 'semantic', now: TICK_NOW_C })
  cTicks += 1
  if (tick.kind === 'ran') {
    for (const [code, count] of Object.entries(tick.parseFailures)) {
      tierCParseFailures[code] = (tierCParseFailures[code] ?? 0) + count
    }
    tierCTerminal += tick.terminalFailed
    tierCCommitted += tick.committed
    if (tick.retryableDeferred > 0) { failTick1 = tick; break }
  } else {
    failTick1 = tick
    break
  }
  if (cTicks > 30) throw new Error('Tier C tick 循环超界（30 轮未触达传输 source——序号洞异常）')
}
checkTrue('negative', 'C1', 'Tier C：真跑并触达传输 source（ran + 可重试楔住）',
  failTick1?.kind === 'ran' && failTick1.retryableDeferred === 1)
checkEqual('negative', 'C2', 'Tier C：11 解析失败码逐码可达（跨轮累计，每码恰一次）',
  11, Object.values(tierCParseFailures).reduce((a, b) => a + b, 0))
checkEqual('negative', 'C2b', 'Tier C：逐码清单 = 11 码各一次（无重复无遗漏）',
  11, Object.keys(tierCParseFailures).length)
checkEqual('negative', 'C3', 'Tier C：解析失败 ⇒ 诚实终态（terminalFailed = 11，不重试不伪造）',
  11, tierCTerminal)
checkEqual('negative', 'C5', 'Tier C：零 committed（失败注入零伪造结果）', 0, tierCCommitted)
// 间隔已过 ⇒ 第 2 次尝试烧尽 ⇒ TERMINAL_FAILED
script.push({ ok: false, failure: 'rate_limited' })
const failTick2 = await maybeRunAffectSemanticEvaluation(db, { ...semanticInput, mode: 'semantic', now: TICK_NOW_C + 3_000 })
checkTrue('negative', 'C6', 'Tier C tick2：真跑（ran）', failTick2.kind === 'ran')
if (failTick2.kind === 'ran') {
  checkEqual('negative', 'C7', 'Tier C：尝试预算烧尽 ⇒ TERMINAL_FAILED（≤2 次尝试）',
    1, failTick2.retryExhausted)
}

// 失败 source 的闸行与 IMPACT 清点（重读——Tier C 的闸行在 tick 之后才存在）
const gateRowsAfterFailures = await readGateRows()
const impactAfterFailures = await readImpactBySource()
const failureIds = [...failureSourceIds, transportSourceId]
const terminalReceipts = failureIds.map((eventId) =>
  gateRowsAfterFailures.get(affectSemanticFinalizedGateKey(eventId as never)))
checkTrue('negative', 'C8', 'Tier C：全部失败 source 都有诚实终态闸（TERMINAL_FAILED 回执，无指纹无族）',
  terminalReceipts.every((r) => r === 'affect-semantic@1|TERMINAL_FAILED'))
const failureImpactCount = failureIds.filter((eventId) => impactAfterFailures.has(eventId)).length
checkEqual('negative', 'C9', 'Tier C：失败注入零 IMPACT（12 个失败 source 全部零落库）',
  0, failureImpactCount)

// ---------------------------------------------------------------------------
// ⑦ 恢复段：幂等重放（排干后再 tick ⇒ no_tail + 零模型调用）
// ---------------------------------------------------------------------------

const modelCallsBeforeReplay = modelCalls
let replayTick: Awaited<ReturnType<typeof maybeRunAffectSemanticEvaluation>> | undefined
let rTicks = 0
for (;;) {
  const tick = await maybeRunAffectSemanticEvaluation(db, { ...semanticInput, mode: 'semantic', now: TICK_NOW_C + 5_000 })
  rTicks += 1
  if (tick.kind !== 'ran') { replayTick = tick; break }
  if (rTicks > 10) throw new Error('恢复段 tick 循环超界（10 轮未排干）')
}
checkEqual('recovery', 'R1', '重放：排干后收口 no_tail（水位封口，零重处理）',
  'no_tail', replayTick?.kind)
checkEqual('recovery', 'R2', '重放：零新增模型调用（闸行全挡）',
  modelCallsBeforeReplay, modelCalls)
const finalImpacts = (await domainEventsFor(db, characterId, { limit: 10_000 }))
  .filter((e) => e.type === AFFECT_IMPACT).length
checkEqual('recovery', 'R3', '重放：IMPACT 总数不变（无双重落库）', goldImpactCount, finalImpacts)
const finalState = (await getAffectProjection(db, characterId))?.state as { valence: number } | undefined
checkTrue('recovery', 'R4', '终态健康：valence 在夹界内（长序列累积后仍合法）',
  finalState !== undefined && finalState.valence >= -1 && finalState.valence <= 1)

// ---------------------------------------------------------------------------
// 收口：measured_count 自检 + 证据落盘
// ---------------------------------------------------------------------------

const passCount = results.filter((r) => r.pass).length
const failCount = results.length - passCount
const phaseCounts: Record<Phase, number> = { static: 0, positive: 0, negative: 0, recovery: 0 }
for (const r of results) phaseCounts[r.phase] += 1
const phasesNonEmpty =
  phaseCounts.static > 0 && phaseCounts.positive > 0 && phaseCounts.negative > 0 && phaseCounts.recovery > 0
const measuredValid = measured > 0 && measured === results.length
const corpusValid = tierAEntries.length === 322 && gateScored.length === 272

const runId = `corpus-replay-${new Date().toISOString().replaceAll(/[-:TZ.]/g, '').slice(0, 17)}`
const outDir = join(process.cwd(), 'artifacts', 'm8.5', runId)
mkdirSync(outDir, { recursive: true })
const evidence = {
  gate: 'm8.5:corpus:verify',
  verdict: failCount === 0 && phasesNonEmpty && measuredValid && corpusValid ? 'PASS' : 'FAIL',
  measured_count: measured,
  pass: passCount,
  fail: failCount,
  phases: phaseCounts,
  self_check: phasesNonEmpty && measuredValid && corpusValid ? 'OK（四段均非空 + 计数自洽 + 语料配额核对）' : 'INVALID',
  replay: {
    tierA: { entries: tierAEntries.length, smoke: smokeEntries.length, gateScored: gateScored.length },
    tierB: {
      targets: recordedItems.length, contextEntries: contextEntriesRecorded,
      contextAssistantsSkipped, ticks: tickCount,
      committed: totalCommitted, noImpact: totalNoImpact, rejected: totalRejected,
    },
    tierC: {
      parseCodes: 11, transportRetry: 2, ticks: cTicks, replayTicks: rTicks,
      parseFailuresByCode: tierCParseFailures,
      terminalFailed: tierCTerminal,
    },
    modelCalls,
  },
  results: results.map((r) => ({ ...r, pass: r.pass ? 1 : 0 })),
}
writeFileSync(join(outDir, 'corpus-replay.json'), JSON.stringify(evidence, null, 2), 'utf8')

console.log('========================================================================')
console.log(`M8.5 语料回放门：${evidence.verdict}（${String(passCount)}/${String(results.length)}）`)
console.log(`  static: ${String(phaseCounts.static)} · positive: ${String(phaseCounts.positive)} · negative: ${String(phaseCounts.negative)} · recovery: ${String(phaseCounts.recovery)}`)
console.log(`  Tier A（解析/映射）: ${String(tierAEntries.length)} 条 · Tier B（提交）: ${String(recordedItems.length)} 条 · 模型调用（脚本化，零真实出站）: ${String(modelCalls)}`)
console.log(`  证据：${join('artifacts', 'm8.5', runId, 'corpus-replay.json')}`)
console.log('========================================================================')
if (evidence.verdict !== 'PASS') process.exit(1)
