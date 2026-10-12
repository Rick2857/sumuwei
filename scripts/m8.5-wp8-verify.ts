/**
 * M8.5 WP8 门 —— **模式开关与装配**（`pnpm m8.5:wp8:verify`）。
 *
 * ============================================================================
 *  要证明的命题（计划 §15 WP8：flags、三模式接线、单写入者保证、回滚路径）
 * ============================================================================
 * ① 模式开关：`CHARACTER_AFFECT_SEMANTIC_MODE` 缺省 `rules`；合法值放行；
 *    **非法值失败关闭回 `rules` + 告警**（M85-D22——不是 webSearchMode 的
 *    undefined 形状：rules 本身就是安全侧）。
 * ② `rules` 模式字节不变：词形 IMPACT 照常落库（rules@1 语义）；语义 tick
 *    具名 no-op，**零读零写**（无水位/无闸行/无任务行/无事件）。
 * ③ `semantic` 单写入者：词形路径让位 IMPACT（TOUCH 照旧、suppressedImpacts
 *    计数、放行口零拒绝记录——让位不是被拒）；语义 worker 是唯一 IMPACT
 *    作者（SOURCE_ANCHORED：valence 精确增量、lastInteractionAt 不被推进）。
 * ④ `shadow` 生产 no-op：M8 路径完整（词形 IMPACT 照常——M8 是唯一写入者）；
 *    语义 tick 具名 no-op（采集面是 WP9/WP10 的隔离装配，不在这条链上）。
 * ⑤ 回滚路径：模式切离 semantic ⇒ 启动扫面把水位间隙里未终结的合格 source
 *    收拢为 CANCELLED_BY_MODE_CHANGE 终态闸（不留悬空 pending；不合格事件
 *    不写闸）；切回 semantic ⇒ 已收拢的 source **不**重新评估（闸行挡住
 *    重推导），新 source 正常评估。
 * ⑥ trace 面：`affect_semantic_*` 四步只在 tick 真跑时产出；属性键 ⊆ 闭集
 *    （计数/水位/闭集码——无对话正文、无模型输出、无情绪数值）。
 *
 * 不主张（归 WP9+）：shadow 采集面本体、真模型出站、reducer@2 注册切换
 * （WP13 激活段）、盲测语料判定。
 * 量具纪律：§6.7 三段式 + §6.8 measured_count 自检；隔离库，真实库不打开。
 */
import 'dotenv/config'

import { isolateDatabase } from '../src/dev/sandbox.ts'
isolateDatabase('m8.5-wp8-verify', { keep: false })

import { AgentRuntime, type Character } from '@elizaos/core'
import sqlPlugin from '@elizaos/plugin-sql'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

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
import { getAffectProjection } from '../src/infrastructure/persistence/affect-store.ts'
import { domainEventsFor, rebuildProjection } from '../src/infrastructure/persistence/event-store.ts'
import {
  findJobByIdempotencyKey,
  getWatermark,
  listProcessedOperations,
} from '../src/infrastructure/persistence/job-store.ts'
import {
  maybeRunAffectEvaluation,
  affectTurnObservationOf,
} from '../src/infrastructure/runtime/affect-scheduler.ts'
import {
  affectSemanticActivationReady,
  maybeRunAffectSemanticEvaluation,
  cancelPendingAffectSemanticSources,
  affectSemanticTraceStepsOf,
  markAffectSemanticCutover,
} from '../src/infrastructure/runtime/affect-semantic-scheduler.ts'
import type { AffectSemanticProvider } from '../src/infrastructure/model/affect-semantic-provider.ts'
import {
  affectSemanticTaskIdempotencyKey,
  AFFECT_SEMANTIC_SCANNER_NAME,
  AFFECT_SEMANTIC_WORKER_NAME,
} from '../src/kernel/app/affect/semantic-worker.ts'
import {
  AFFECT_SEMANTIC_SCANNER_PROCESSOR,
  AFFECT_SEMANTIC_WORKER_PROCESSOR,
  AFFECT_SEMANTIC_CUTOVER_NAME,
  AFFECT_SEMANTIC_CUTOVER_PROCESSOR,
  AFFECT_SEMANTIC_DEFAULT_MODE,
  affectSemanticFinalizedGateKey,
  type AffectSemanticTransportFailureCode,
} from '../src/kernel/contracts/affect-semantic.ts'
import { readKernelFlags, describeKernelFlags } from '../src/kernel/app/flags.ts'
import { affectReducerV2For } from '../src/kernel/projections/affect.ts'
import { AFFECT_IMPACT } from '../src/kernel/contracts/domain-event.ts'
import { asConversationId } from '../src/kernel/contracts/index.ts'
import type { TraceStep } from '../src/kernel/contracts/trace.ts'

const REPO_ROOT = resolve(import.meta.dirname, '..')

// ---------------------------------------------------------------------------
// 量具（与 WP4–WP7 门同一形状）
// ---------------------------------------------------------------------------

interface Check {
  id: string
  label: string
  expected: string
  actual: string
  pass: boolean
}
const checks: Check[] = []
const phaseCounts: Record<string, number> = { static: 0, positive: 0, negative: 0, recovery: 0 }

function check(
  phase: 'static' | 'positive' | 'negative' | 'recovery',
  id: string,
  label: string,
  expected: string,
  actual: string,
  pass: boolean,
): void {
  checks.push({ id, label, expected, actual, pass })
  phaseCounts[phase] += 1
  if (!pass) console.error(`FAIL [${phase}] ${id} ${label}: expected=${expected} actual=${actual}`)
}
function checkEqual(
  phase: 'static' | 'positive' | 'negative' | 'recovery',
  id: string,
  label: string,
  expected: unknown,
  actual: unknown,
): void {
  check(phase, id, label, JSON.stringify(expected), JSON.stringify(actual),
    JSON.stringify(expected) === JSON.stringify(actual))
}
function checkTrue(
  phase: 'static' | 'positive' | 'negative' | 'recovery',
  id: string,
  label: string,
  value: boolean,
): void {
  check(phase, id, label, 'true', String(value), value === true)
}
/** 浮点容差比较（valence 走过 float32 存储——M8 门同款纪律：不等式/容差，不硬等） */
function checkClose(
  phase: 'static' | 'positive' | 'negative' | 'recovery',
  id: string,
  label: string,
  expected: number,
  actual: number,
  eps = 1e-4,
): void {
  check(phase, id, label, `≈${String(expected)}`, String(actual), Math.abs(expected - actual) < eps)
}

// ---------------------------------------------------------------------------
// ① 静态段：接线面源码级断言（flags / main / trace / 网关 / 收尾链）
// ---------------------------------------------------------------------------

const flagsSource = readFileSync(join(REPO_ROOT, 'src/kernel/app/flags.ts'), 'utf8')
checkTrue('static', 'S1a', 'flags 解析 CHARACTER_AFFECT_SEMANTIC_MODE（具名开关，非启发式）',
  flagsSource.includes('CHARACTER_AFFECT_SEMANTIC_MODE'))
checkTrue('static', 'S1b', '非法值失败关闭回缺省（M85-D22；不是 webSearchMode 的 undefined 形状）',
  flagsSource.includes('失败关闭回') && flagsSource.includes('AFFECT_SEMANTIC_DEFAULT_MODE'))
checkTrue('static', 'S1c', 'describeKernelFlags 可见语义模式（"接线开着但模式是 rules"必须一眼可辨）',
  describeKernelFlags(readKernelFlags({})).includes('affect-semantic-mode=rules'))

const mainSource = readFileSync(join(REPO_ROOT, 'src/main.ts'), 'utf8')
checkTrue('static', 'S2a', '三个 M8 调用点全部经激活就绪闸让位（suppressImpacts × 3——单写入者的词形侧）',
  mainSource.split('suppressImpacts: await this.semanticActive()').length - 1 === 3)
checkTrue('static', 'S2f', 'main.ts 真消费激活就绪闸（旗 + 注册前提缺一不可——D3 消费锁纪律）',
  mainSource.includes('affectSemanticActivationReady'))
checkTrue('static', 'S2b', '轮后槽位非阻塞通知（fire-and-forget drain——回复不被模型调用放大）',
  mainSource.includes('void this.drainSemanticTail('))
checkTrue('static', 'S2c', '启动追赶接语义 tick（semantic）/取消扫面（非 semantic）',
  mainSource.includes('await this.drainSemanticTail()') &&
  mainSource.includes('cancelPendingAffectSemanticSources'))
checkTrue('static', 'S2d', '串行守卫在位（在飞 tick ⇒ 跳过——§8.2 每 Character 并发 1）',
  mainSource.includes('semanticDrainInFlight !== undefined'))
checkTrue('static', 'S2e', '收尾链先 abort 再收拢（关库之前；中止 ⇒ 传输失败 ⇒ 可重试）',
  mainSource.includes('this.semanticAbort.abort()'))

const traceSource = readFileSync(join(REPO_ROOT, 'src/kernel/contracts/trace.ts'), 'utf8')
checkTrue('static', 'S3a', '四个 affect_semantic_* 步名已登记（闭集文档化）',
  traceSource.includes("'affect_semantic_discovered'") &&
  traceSource.includes("'affect_semantic_dispatched'") &&
  traceSource.includes("'affect_semantic_result'") &&
  traceSource.includes("'affect_semantic_terminal'"))

const gatewaySource = readFileSync(join(REPO_ROOT, 'src/kernel/app/turn-gateway.ts'), 'utf8')
checkTrue('static', 'S4a', '网关有轮后追加口（completeTurn 之后才出结果的观测面）',
  gatewaySource.includes('appendPostTurnStep'))
checkTrue('static', 'S4b', 'affect_proposal 步渲染让位标注（否则 impact 提案 N 与零落库无法区分）',
  gatewaySource.includes('让位语义') && gatewaySource.includes('suppressed_impact_count'))

const schedulerSource = readFileSync(
  join(REPO_ROOT, 'src/infrastructure/runtime/affect-semantic-scheduler.ts'), 'utf8')
checkTrue('static', 'S5a', '语义调度器走真放行口装配（WP7 commit 端口，不绕过）',
  schedulerSource.includes('createAffectSemanticCommitPort'))
checkTrue('static', 'S5b', 'trace 步映射是纯函数（可单测；装配层只负责落库）',
  schedulerSource.includes('export function affectSemanticTraceStepsOf'))

// ---------------------------------------------------------------------------
// ② 模式开关解析（P1 正控 / N1 负控——直接打 readKernelFlags）
// ---------------------------------------------------------------------------

checkEqual('positive', 'P1a', '未设 ⇒ 缺省 rules（升级后行为与 M8 逐字一致）',
  'rules', readKernelFlags({}).affectSemanticMode)
checkEqual('positive', 'P1b', "显式 'rules' ⇒ rules", 'rules',
  readKernelFlags({ CHARACTER_AFFECT_SEMANTIC_MODE: 'rules' }).affectSemanticMode)
checkEqual('positive', 'P1c', "'shadow' ⇒ shadow（生产 no-op；采集面 WP9/WP10）", 'shadow',
  readKernelFlags({ CHARACTER_AFFECT_SEMANTIC_MODE: 'shadow' }).affectSemanticMode)
checkEqual('positive', 'P1d', "'semantic' ⇒ semantic（单写入者让位生效）", 'semantic',
  readKernelFlags({ CHARACTER_AFFECT_SEMANTIC_MODE: 'semantic' }).affectSemanticMode)
checkEqual('positive', 'P1e', '空白串 ⇒ 缺省 rules（trim 后视为未设）', 'rules',
  readKernelFlags({ CHARACTER_AFFECT_SEMANTIC_MODE: '   ' }).affectSemanticMode)

// N1：非法值失败关闭 + 告警（拦截 console.warn 验证"不静默"）
const originalWarn = console.warn
let warnSeen = ''
console.warn = (...args: unknown[]) => {
  warnSeen = args.map(String).join(' ')
}
const garbageFlags = readKernelFlags({ CHARACTER_AFFECT_SEMANTIC_MODE: 'semantc' })
console.warn = originalWarn
checkEqual('negative', 'N1a', '拼错值 ⇒ 失败关闭回 rules（安全侧 = 已验收行为）',
  'rules', garbageFlags.affectSemanticMode)
checkTrue('negative', 'N1b', '失败关闭伴随告警（不静默猜一个模式）',
  warnSeen.includes('CHARACTER_AFFECT_SEMANTIC_MODE') && warnSeen.includes('rules'))
checkEqual('negative', 'N1c', '原始串保留在 raw 字段（诊断面；不参与判定）',
  'semantc', garbageFlags.affectSemanticModeRaw)

// ---------------------------------------------------------------------------
// ③ 隔离库引导（真实库不打开；WP7 门同款范式）
// ---------------------------------------------------------------------------

const runtime = new AgentRuntime({ character: character as Character, plugins: [], settings: {} })
await initDatabase(runtime, sqlPlugin)
await runtime.initialize()
const kernel = await initKernel(runtime, {
  definition: characterDefinitionFromCharacter(character),
})
const characterId = kernel.characterId
const db = kernel.stores.db

const USER = 'm85-wp8-user'
const CONV = asConversationId('m85-wp8-conv')
const recorder = new ConversationRecorder({
  db,
  characterId,
  conversationId: CONV,
  dryRun: false,
  userName: USER,
  characterName: character.name,
  transport: 'm8.5-wp8-verify',
  attribution: [createHumanConsoleUserTurnIngress(), createCharacterAssistantTurnIngress()],
  userId: USER,
  userRef: USER,
})

/** 记一轮「用户感激消息 + 她的回复」；返回用户事件（语义 source 候选） */
async function recordGratitudeTurn(text: string): Promise<{ userEventId: string; userSequence: number }> {
  const rec = await recorder.recordUserMessage(
    text,
    (await latestConversationSequence(db, characterId, CONV)) + 1,
  )
  await recorder.recordAssistantMessage({
    text: '能帮上就好。',
    conversationSequence: (await latestConversationSequence(db, characterId, CONV)) + 1,
    characterSequence: rec.assistantSequence!,
    replyToEventId: rec.event!.id,
  })
  return { userEventId: String(rec.event!.id), userSequence: rec.event!.sequence }
}

// 脚本化 provider（零真实出站；耗尽即抛 = 计划外出站负控）
type ScriptedCall =
  | { ok: true; content: string }
  | { ok: false; failure: AffectSemanticTransportFailureCode }
const script: ScriptedCall[] = []
let modelCalls = 0
/** 脚本化调用的观测形状（Contract-Freeze §10 计数器源；缺省值 = 单选择正常停） */
const scriptedShape = {
  httpStatus: 200,
  choiceCount: 1,
  messagePresent: true,
  contentKind: 'string' as const,
  contentLength: 0,
  finishReason: 'stop' as const,
  toolCallCount: 0,
  refusalPresent: false,
  bodyWasJson: true,
  promptTokens: null,
  completionTokens: null,
  reasoningTokens: null,
  headersMs: 1,
  bodyMs: 1,
  totalMs: 2,
  retryAfterMs: 0,
}
const scriptedProvider: AffectSemanticProvider = {
  id: 'm85-wp8-scripted',
  endpointHost: 'gate.invalid',
  async call() {
    modelCalls += 1
    const next = script.shift()
    if (next === undefined) throw new Error('script exhausted: 计划外的模型调用')
    if (!next.ok) return { ok: false, failure: next.failure, requestCount: 1 }
    return {
      ok: true,
      envelope: { content: next.content, finishReason: 'stop', hasToolCalls: false },
      shape: { ...scriptedShape, contentLength: next.content.length },
      requestCount: 1,
    }
  },
}
const GRATITUDE_JSON =
  '{"decision":"IMPACT","target":"CHARACTER","candidates":[{"family":"A-GRATITUDE","span":{"start":0,"end":2}}],"contextRefs":[],"reasonCode":"DIRECT_APPRECIATION"}'
const NEUTRAL_JSON =
  '{"decision":"NEUTRAL","target":"CHARACTER","candidates":[],"contextRefs":[],"reasonCode":"ORDINARY_INTERACTION"}'

const semanticInput = {
  characterId,
  characterAlias: character.name,
  activeUserId: USER,
  provider: scriptedProvider,
}

/** 语义 IMPACT 事件（全部 AFFECT_IMPACT；payload 供策略版本/时间形状断言） */
async function affectImpacts(): Promise<{ type: string; payload: Record<string, unknown> }[]> {
  const events = await domainEventsFor(db, characterId, { limit: 500 })
  return events
    .filter((e) => e.type === AFFECT_IMPACT)
    .map((e) => ({ type: e.type, payload: e.payload as Record<string, unknown> }))
}
async function affectState(): Promise<{ valence: number; lastInteractionAt: number }> {
  const projection = await getAffectProjection(db, characterId)
  const state = projection?.state as unknown as { valence: number; lastInteractionAt: number }
  return { valence: state.valence, lastInteractionAt: state.lastInteractionAt }
}
async function semanticWatermarks(): Promise<{ scanner: number | undefined; worker: number | undefined }> {
  return {
    scanner: (await getWatermark(db, characterId, AFFECT_SEMANTIC_SCANNER_NAME, AFFECT_SEMANTIC_SCANNER_PROCESSOR))?.processedThroughSequence,
    worker: (await getWatermark(db, characterId, AFFECT_SEMANTIC_WORKER_NAME, AFFECT_SEMANTIC_WORKER_PROCESSOR))?.processedThroughSequence,
  }
}

// 建档先行：空账本上调一次 M8 调度 ⇒ ORIGIN 播种在 cutover=0（尾窗为空 ⇒
// 如实 no_tail；播种发生在消费之前——生产时序同构：open 追赶先于用户消息）。
const seeding = await maybeRunAffectEvaluation(db, { characterId, activeUserId: USER })
checkEqual('positive', 'P2a', '空账本 ⇒ no_tail（无尾窗可消费——如实，不虚报 flushed）',
  'no_tail', seeding.kind)
const seededState = (await getAffectProjection(db, characterId))?.state as
  | { originated: boolean; cutoverSequence: number }
  | undefined
checkTrue('positive', 'P2a2', 'ORIGIN 已播种（cutover=0：之后的消息全部落在切换后）',
  seededState?.originated === true && seededState?.cutoverSequence === 0)

// ---------------------------------------------------------------------------
// ④ rules 模式（P2 正控：字节不变 + 语义面零读零写）
// ---------------------------------------------------------------------------

const turn1 = await recordGratitudeTurn('谢谢你，这次真的帮了大忙。')
const rulesRun = await maybeRunAffectEvaluation(db, { characterId, activeUserId: USER })
checkTrue('positive', 'P2b', 'rules：词形路径消费尾窗（flushed）', rulesRun.kind === 'flushed')
if (rulesRun.kind === 'flushed') {
  checkEqual('positive', 'P2c', 'rules：词形 IMPACT 照常产出（不被让位）', 1, rulesRun.impactProposals)
  checkEqual('positive', 'P2d', 'rules：suppressedImpacts 恒 0（缺省不传 = M8 逐字不变）', 0, rulesRun.suppressedImpacts)
}
const impactsAfterRules = await affectImpacts()
checkEqual('positive', 'P2e', 'rules：词形 IMPACT 落库（rules@1 语义——M8 行为原样）',
  1, impactsAfterRules.length)
checkTrue('positive', 'P2f', 'rules：落库的是词形策略版本（affect-rules@1）',
  impactsAfterRules[0]?.payload?.ruleVersion === 'affect-rules@1')
checkEqual('positive', 'P2g', 'rules：valence 精确到词形增量（0 → +0.08）',
  0.08, (await affectState()).valence)

// rules 模式下的语义 tick：具名 no-op + 零读零写
const rulesTick = await maybeRunAffectSemanticEvaluation(db, { ...semanticInput, mode: 'rules' })
checkEqual('positive', 'P2h', 'rules：语义 tick 具名 no-op（mode_not_semantic）',
  'mode_not_semantic', rulesTick.kind)
checkEqual('positive', 'P2i', 'rules：语义 tick 零水位（零写）',
  { scanner: undefined, worker: undefined }, await semanticWatermarks())
const gateRowsAfterRulesTick = (await listProcessedOperations(db, characterId, 200))
  .filter((row) => String(row.idempotencyKey).startsWith('affect-semantic-finalized:'))
checkEqual('positive', 'P2j', 'rules：语义 tick 零闸行（零写）', 0, gateRowsAfterRulesTick.length)
checkEqual('positive', 'P2k', 'rules：语义 tick 零模型调用（零读零出站）', 0, modelCalls)
checkEqual('positive', 'P2l', 'rules：no-op tick 不产 trace 步（trace 不变长）',
  0, affectSemanticTraceStepsOf(rulesTick, Date.now()).length)

// ---------------------------------------------------------------------------
// ⑤ semantic 模式（P3 正控：单写入者 + SOURCE_ANCHORED）
// ---------------------------------------------------------------------------

/*
 * 受控 rebuild（WP13 激活段的机制面，此处先行模拟——**不是**可选步骤）：
 * 投影行只许一个 reducer 版本（event-store 版本守卫）；rules 时代的行盖着
 * @1 章，semantic 模式的写入（M8 路径 TOUCH + 语义 IMPACT）都注册 @2 ⇒
 * 必须先用 @2 重放全部事件、重盖 @2 章。A==B（M85-D19）：@2 对非语义
 * 事件的折叠与 @1 逐字段一致 ⇒ rebuild 后 valence 必须原样（0.08）。
 */
// N7a：就绪闸在 @1 行上必须拒绝（WP13 之前的真实库形状——语义面休眠）
const readyBeforeRebuild = await affectSemanticActivationReady(db, characterId)
checkTrue('negative', 'N7a', '就绪闸：@1 行 ⇒ 未就绪（语义模式需要 WP13 rebuild；防"让位了但语义面死了"）',
  readyBeforeRebuild.ready === false && readyBeforeRebuild.reducerVersion === 'affect-reducer@1')
const valenceBeforeRebuild = (await affectState()).valence
const rebuild = await rebuildProjection(db, characterId, affectReducerV2For(characterId))
checkTrue('positive', 'P3pre1', '受控 rebuild：@2 重放成功（appliedEvents > 0——measured）',
  rebuild.appliedEvents > 0)
checkEqual('positive', 'P3pre2', '受控 rebuild：投影行重盖 @2 章',
  'affect-reducer@2', rebuild.projection.reducerVersion)
checkEqual('positive', 'P3pre3', 'A==B：@2 重放后 valence 与 @1 时代逐字一致（历史不重评）',
  valenceBeforeRebuild, (await affectState()).valence)
const readyAfterRebuild = await affectSemanticActivationReady(db, characterId)
checkTrue('positive', 'P3pre4', '就绪闸：@2 行 ⇒ 就绪（激活后语义面可运行）',
  readyAfterRebuild.ready === true)
/*
 * 激活程序第二刀（§22.2）：记录 semanticCutoverSequence = 激活时账本边界。
 * 此后 M1（rules 时代来源）永久落在边界之前 ⇒ 永不语义重评（§24 ③——
 * 旧夹具靠脚本化模型"恰好判 NEUTRAL"绕过双计，那正是 §24 ③ 要禁的形态：
 * 真模型不受脚本约束，重评即双计风险）。
 */
const cutoverMark = await markAffectSemanticCutover(db, characterId)
const cutoverRow = await getWatermark(db, characterId,
  AFFECT_SEMANTIC_CUTOVER_NAME, AFFECT_SEMANTIC_CUTOVER_PROCESSOR)
checkTrue('positive', 'P3pre5', '切换边界：激活程序把 semanticCutoverSequence 置为账本尾（持久行在）',
  cutoverMark.cutoverSequence > 0 &&
  (cutoverRow?.processedThroughSequence ?? 0) === cutoverMark.cutoverSequence)

const turn2 = await recordGratitudeTurn('真的很谢谢你，帮了我大忙。')
const semanticRun = await maybeRunAffectEvaluation(db, {
  characterId, activeUserId: USER, suppressImpacts: true, affectReducerVersion: 2,
})
checkTrue('positive', 'P3a', 'semantic：词形路径仍消费尾窗（TOUCH 照旧）', semanticRun.kind === 'flushed')
if (semanticRun.kind === 'flushed') {
  checkEqual('positive', 'P3b', 'semantic：让位后 impactProposals = 0（提案在放行口前被丢弃——审计面只数幸存提案）',
    0, semanticRun.impactProposals)
  checkEqual('positive', 'P3c', 'semantic：IMPACT 被让位（计数进 suppressedImpacts）',
    1, semanticRun.suppressedImpacts)
  checkEqual('positive', 'P3d', 'semantic：TOUCH 照旧产出（结构性入口不动）',
    1, semanticRun.touchProposals)
  checkEqual('positive', 'P3e', 'semantic：让位不产生拒绝记录（让位 ≠ 被拒）',
    0, semanticRun.rejections.length)
}
const impactsBeforeSemanticTick = (await affectImpacts()).length
checkEqual('positive', 'P3f', 'semantic：词形 IMPACT 未落库（让位在放行口之前）',
  1, impactsBeforeSemanticTick)

// 语义 tick（脚本化模型）。M1 序号 ≤ 切换边界 ⇒ 永不评估（§24 ③ 位置边界，
// skippedPreCutover 计数；无闸行——边界前来源从未是语义工作候选）。
// M2（边界后）判 A-GRATITUDE IMPACT。
const lastInteractionBeforeSemanticTick = (await affectState()).lastInteractionAt
script.push({ ok: true, content: GRATITUDE_JSON })
const semanticTick = await maybeRunAffectSemanticEvaluation(db, { ...semanticInput, mode: 'semantic' })
checkEqual('positive', 'P3g', 'semantic：tick 真跑（ran）', 'ran', semanticTick.kind)
if (semanticTick.kind === 'ran') {
  checkEqual('positive', 'P3h', 'semantic：committed = 1（M2 的语义 IMPACT）',
    1, semanticTick.committed)
  checkEqual('positive', 'P3h2', 'semantic：no_impact = 0（M1 不再被评估——不是"判无增量"，是根本不评）',
    0, semanticTick.noImpact)
  checkEqual('positive', 'P3h3', 'semantic：M1 被位置边界跳过（skippedPreCutover=1——§24 ③ 主机制）',
    1, semanticTick.skippedPreCutover)
  checkEqual('positive', 'P3i', 'semantic：模型调用恰好 1 次（只有 M2；M1 边界前不出站）',
    1, semanticTick.modelCalls)
}
checkEqual('positive', 'P3j', 'semantic：模型调用总数 = 1（无计划外出站）', 1, modelCalls)
const impactsAfterSemanticTick = await affectImpacts()
checkEqual('positive', 'P3k', 'semantic：IMPACT 总数 = 2（rules 时代 1 条 + 语义 1 条；单写入者）',
  2, impactsAfterSemanticTick.length)
const semanticImpact = impactsAfterSemanticTick.find(
  (e) => e.payload?.ruleVersion === 'affect-semantic-policy@1')
checkTrue('positive', 'P3l', 'semantic：新 IMPACT 是语义策略版本（affect-semantic-policy@1）',
  semanticImpact !== undefined)
checkClose('positive', 'P3m', 'semantic：valence 只含语义增量（0.08 → ≈0.16；词形增量被让位）',
  0.16, (await affectState()).valence)
checkTrue('positive', 'P3n', 'semantic：SOURCE_ANCHORED 标记在位（payload 带 timingKind）',
  semanticImpact?.payload?.timingKind === 'SOURCE_ANCHORED')
checkTrue('positive', 'P3o', 'semantic：lastInteractionAt 未被语义 IMPACT 推进（SOURCE_ANCHORED；锚=max(sourceAt,旧锚)）',
  (await affectState()).lastInteractionAt === lastInteractionBeforeSemanticTick)
const gate2 = (await listProcessedOperations(db, characterId, 200))
  .find((row) => row.idempotencyKey === affectSemanticFinalizedGateKey(turn2.userEventId as never))
checkTrue('positive', 'P3p', 'semantic：source 终结闸 = COMMITTED 回执（fp 在位）',
  gate2 !== undefined && String(gate2.operation).startsWith('affect-semantic@1|COMMITTED|A-GRATITUDE|fp='))
const gate1 = (await listProcessedOperations(db, characterId, 200))
  .find((row) => row.idempotencyKey === affectSemanticFinalizedGateKey(turn1.userEventId as never))
checkTrue('positive', 'P3p2', 'semantic：M1 无语义闸行（边界前来源不是语义工作——不写谎账）',
  gate1 === undefined)

// 观测映射：让位计数进 trace 面
const observation = affectTurnObservationOf(
  semanticRun.kind === 'flushed' ? semanticRun : undefined, 'unknown')
checkEqual('positive', 'P3q', 'semantic：观测带 suppressedImpacts（trace 的 affect_proposal 据此标注）',
  1, observation?.suppressedImpacts)
const rulesObservation = affectTurnObservationOf(
  rulesRun.kind === 'flushed' ? rulesRun : undefined, 'unknown')
checkTrue('positive', 'P3r', 'rules：观测不带 suppressedImpacts（缺省 = M8 观测逐字不变）',
  rulesObservation?.suppressedImpacts === undefined)

// ---------------------------------------------------------------------------
// ⑥ trace 步映射（P6 正控 + N5 负控：属性闭集）
// ---------------------------------------------------------------------------

if (semanticTick.kind === 'ran') {
  const steps = affectSemanticTraceStepsOf(semanticTick, Date.now())
  checkEqual('positive', 'P6a', 'ran tick 产出四步（WP1 冻结名）', 4, steps.length)
  checkEqual('positive', 'P6b', '四步 kind 逐一正确',
    ['affect_semantic_discovered', 'affect_semantic_dispatched', 'affect_semantic_result', 'affect_semantic_terminal'],
    steps.map((s) => s.kind))
  const TRACE_ATTR_KEYS = new Set([
    'scanned', 'skipped_not_user_message', 'skipped_unqualified', 'expired_at_scan',
    'already_finalized', 'skipped_keyword_finalized', 'skipped_pre_cutover',
    'enqueued', 'scanner_watermark', 'worker_watermark',
    'model_calls', 'transport_failures', 'parse_failures', 'budget_exceeded',
    'processed', 'committed', 'no_impact', 'rejected_by_validator', 'retryable_deferred',
    'terminal_failed', 'expired_at_process', 'source_invalidated', 'retry_exhausted',
  ])
  const offending = steps.flatMap((s: TraceStep & { attributes?: Record<string, unknown> }) =>
    Object.keys(s.attributes ?? {}).filter((k) => !TRACE_ATTR_KEYS.has(k)))
  checkEqual('negative', 'N5a', 'trace 属性键 ⊆ 闭集（无自由文本键——属性纪律）', [], offending)
  const stepTexts = steps.map((s) => JSON.stringify(s))
  checkTrue('negative', 'N5b', 'trace 步不含对话正文/模型输出/情绪数值（只有计数与闭集码）',
    !stepTexts.some((t) => t.includes('感谢') || t.includes('GRATITUDE_JSON') || t.includes('0.16')))
}

// ---------------------------------------------------------------------------
// ⑦ shadow 模式（P4 正控：M8 完整 + 语义生产 no-op）
// ---------------------------------------------------------------------------

const turn3 = await recordGratitudeTurn('多谢你，真是帮了大忙。')
// N6：@2 行上用 @1 注册消费 ⇒ 版本守卫拒绝 ⇒ 调度 failure-closed 进 failed
// （不抛、水位不前进——补洞语义；这正是 WP13 之前真实库上误设 semantic 旗
// 时 M8 路径会遇到的形状，也是就绪闸存在的理由）。
const eventsBeforeN6 = (await affectImpacts()).length
const v1OnV2 = await maybeRunAffectEvaluation(db, { characterId, activeUserId: USER })
checkEqual('negative', 'N6a', '版本守卫：@2 行 + @1 注册 ⇒ failed（failure-closed，不抛）',
  'failed', v1OnV2.kind)
if (v1OnV2.kind === 'failed') {
  checkTrue('negative', 'N6b', '版本守卫：失败原因如实可读（版本名 + rebuild 指引在 message 里；code 是独立字段）',
    v1OnV2.error.includes('affect-reducer') && v1OnV2.error.includes('rebuild'))
}
checkEqual('negative', 'N6c', '版本守卫：零事件落库（拒绝即零写）',
  eventsBeforeN6, (await affectImpacts()).length)
const shadowRun = await maybeRunAffectEvaluation(db, {
  characterId, activeUserId: USER, affectReducerVersion: 2,
})
checkTrue('positive', 'P4a', 'shadow：M8 路径完整消费（M8 是唯一写入者）', shadowRun.kind === 'flushed')
if (shadowRun.kind === 'flushed') {
  checkEqual('positive', 'P4b', 'shadow：词形 IMPACT 照常落库（不让位）', 1, shadowRun.impactProposals)
  checkEqual('positive', 'P4c', 'shadow：suppressedImpacts = 0', 0, shadowRun.suppressedImpacts)
}
checkEqual('positive', 'P4d', 'shadow：IMPACT 总数 = 3（词形三条；语义零贡献）',
  3, (await affectImpacts()).length)
const shadowTick = await maybeRunAffectSemanticEvaluation(db, { ...semanticInput, mode: 'shadow' })
checkEqual('positive', 'P4e', 'shadow：语义 tick 具名 no-op（生产零动作）',
  'mode_not_semantic', shadowTick.kind)
checkEqual('positive', 'P4f', 'shadow：语义模型零调用（采集面不在生产链；累计 = P3 的 1）', 1, modelCalls)

// ---------------------------------------------------------------------------
// ⑧ 回滚路径（P5 正控 + N4 负控 + R2 恢复）
// ---------------------------------------------------------------------------

// 崩溃模拟：semantic tick 撞上传输失败 ⇒ 任务留可重试态、scanner 水位已过、
// worker 水位楔住（"在途被打断"的持久形状）。
// ⚠️ 扫描窗里有两个合格 source：turn3（shadow 期间词形落过 IMPACT——序号在
// 切换边界**之后**，位置边界管不到它；这正是证据式兜底的存在理由：词形
// IMPACT 在场 ⇒ 跳过，不出站不双计）与 turn4（语义时代新来源，撞
// rate_limited 留可重试态）。
const turn4 = await recordGratitudeTurn('太感谢你了，帮了大忙。')
script.push({ ok: false, failure: 'rate_limited' })
const crashedTick = await maybeRunAffectSemanticEvaluation(db, { ...semanticInput, mode: 'semantic' })
checkTrue('recovery', 'R2a', '崩溃模拟：tick 如实收场（ran + 传输失败计数）', crashedTick.kind === 'ran')
if (crashedTick.kind === 'ran') {
  checkTrue('recovery', 'R2b', '崩溃模拟：turn4 任务延后重试（可重试态，不终态化）',
    crashedTick.retryableDeferred >= 1)
  checkEqual('recovery', 'R2c', '崩溃模拟：零 committed（turn4 未出站成功）',
    0, crashedTick.committed)
  checkEqual('recovery', 'R2c2', '崩溃模拟：no_impact = 0（turn3 不再"判无增量"——根本不评）',
    0, crashedTick.noImpact)
  checkEqual('recovery', 'R2c3', '崩溃模拟：turn3 被证据式兜底跳过（skippedKeywordFinalized=1——边界后 + 词形 IMPACT 在场 ⇒ 永不重评）',
    1, crashedTick.skippedKeywordFinalized)
}
const wmsAfterCrash = await semanticWatermarks()
checkTrue('recovery', 'R2d', '崩溃模拟：worker 水位楔在 source 之前（scanner 已过）',
  (wmsAfterCrash.worker ?? 0) < (wmsAfterCrash.scanner ?? 0))
const taskRowAfterCrash = await findJobByIdempotencyKey(
  db, affectSemanticTaskIdempotencyKey(turn4.userEventId as never))
checkEqual('recovery', 'R2e', '崩溃模拟：任务行记下失败尝试（failed + 传输失败码；重推导靠水位间隙不靠行状态——WP6 W7 已证）',
  'failed', taskRowAfterCrash?.status)
checkTrue('recovery', 'R2e2', '崩溃模拟：失败码是闭集传输码（rate_limited）',
  String(taskRowAfterCrash?.lastError ?? '').includes('rate_limited'))

// 模式切离（回滚）：启动扫面收拢
const sweep = await cancelPendingAffectSemanticSources(db, semanticInput)
checkEqual('positive', 'P5a', '回滚扫面：收拢结局（cancelled）', 'cancelled', sweep.kind)
if (sweep.kind === 'cancelled') {
  checkEqual('positive', 'P5b', '回滚扫面：恰好取消 1 个未终结 source', 1, sweep.cancelled)
  checkEqual('positive', 'P5c', '回滚扫面：间隙合格 source 计 1（含已终结）', 1, sweep.qualifiedInGap)
}
const gate4 = (await listProcessedOperations(db, characterId, 200))
  .find((row) => row.idempotencyKey === affectSemanticFinalizedGateKey(turn4.userEventId as never))
checkTrue('positive', 'P5d', '回滚扫面：CANCELLED_BY_MODE_CHANGE 终态闸在位（可审计）',
  gate4 !== undefined && gate4.operation === 'affect-semantic@1|CANCELLED_BY_MODE_CHANGE')
const taskRowAfterSweep = await findJobByIdempotencyKey(
  db, affectSemanticTaskIdempotencyKey(turn4.userEventId as never))
checkEqual('positive', 'P5e', '回滚扫面：遗留任务行收拢为 failed + 具名原因（不留永不结束的 pending）',
  'failed', taskRowAfterSweep?.status)
const wmsAfterSweep = await semanticWatermarks()
checkEqual('positive', 'P5f', '回滚扫面：worker 水位推进到 scanner（间隙清空）',
  wmsAfterSweep.scanner, wmsAfterSweep.worker)
checkTrue('positive', 'P5g', '回滚扫面：切换边界推进到当前账本尾（§24 ②——切走期间词形消费的 source 从此边界前）',
  sweep.kind === 'cancelled' && sweep.cutoverAdvancedTo >= (wmsAfterSweep.scanner ?? 0))
const cutoverAfterSweep = await getWatermark(db, characterId,
  AFFECT_SEMANTIC_CUTOVER_NAME, AFFECT_SEMANTIC_CUTOVER_PROCESSOR)
checkEqual('positive', 'P5h', '回滚扫面：边界行持久在位（= cutoverAdvancedTo）',
  sweep.kind === 'cancelled' ? sweep.cutoverAdvancedTo : -1,
  cutoverAfterSweep?.processedThroughSequence ?? -2)
// N4：闸行总数 = 2（M2 COMMITTED + turn4 CANCELLED）；M1（边界前）与
// turn3（词形已终结）都不是语义工作 ⇒ 无闸；她的回复（assistant）永远没有闸
const assistantGateRows = (await listProcessedOperations(db, characterId, 200))
  .filter((row) => String(row.idempotencyKey).startsWith('affect-semantic-finalized:'))
checkTrue('negative', 'N4a', '回滚扫面：闸行总数 = 2（M2 committed + turn4 cancelled；边界前/词形已终结来源无闸；assistant 无闸）',
  assistantGateRows.length === 2)
// 扫面幂等：再跑一次 ⇒ no_pending
const sweep2 = await cancelPendingAffectSemanticSources(db, semanticInput)
checkEqual('positive', 'P5g', '回滚扫面幂等：二次扫面 no_pending', 'no_pending', sweep2.kind)

// 切回 semantic：已收拢的 source 不重新评估（闸行挡住重推导）；新 source 正常
const turn5 = await recordGratitudeTurn('再次感谢，帮了大忙。')
script.push({ ok: true, content: GRATITUDE_JSON })
const backTick = await maybeRunAffectSemanticEvaluation(db, { ...semanticInput, mode: 'semantic' })
checkEqual('recovery', 'R2f', '切回 semantic：tick 真跑（新 source 正常评估）', 'ran', backTick.kind)
checkEqual('recovery', 'R2g', '切回 semantic：总调用 = 3（P3 一次 + 崩溃一次 + 本轮一次；turn3 兜底跳过零出站、被取消的 turn4 不重评）',
  3, modelCalls)
if (backTick.kind === 'ran') {
  checkEqual('recovery', 'R2h', '切回 semantic：committed = 1（只有新 source）', 1, backTick.committed)
}
const impactsFinal = await affectImpacts()
checkEqual('recovery', 'R2i', '切回 semantic：IMPACT 总数 = 4（M1/turn3 词形 + M2/turn5 语义；被取消的 source 零贡献）',
  4, impactsFinal.length)
checkClose('recovery', 'R2j', '终态 valence ≈ 0.32（0.08×2 词形 + 0.08×2 语义；取消的 turn4 零贡献）',
  0.32, (await affectState()).valence)

// ---------------------------------------------------------------------------
// ⑨ R1 往返收口（TOUCH 补消费 + 重放零重处理）
// ---------------------------------------------------------------------------

/*
 * turn4/turn5 的 TOUCH 还没被 M8 路径消费过（语义相不碰 M8 水位——两套
 * 水位独立）。先补消费：TOUCH 是结构性入口，**不随模式/取消停摆**——
 * 被取消的只是 turn4 的语义评估，它的 TOUCH 照记。
 */
const consumeRun = await maybeRunAffectEvaluation(db, {
  characterId, activeUserId: USER, affectReducerVersion: 2,
})
checkTrue('recovery', 'R1a', 'TOUCH 补消费：flushed（M8 水位独立于语义相）',
  consumeRun.kind === 'flushed')
if (consumeRun.kind === 'flushed') {
  checkEqual('recovery', 'R1b', 'TOUCH 照旧：turn4/turn5 各 1 条（取消的只是语义评估——结构性入口不动）',
    2, consumeRun.touchProposals)
  checkEqual('recovery', 'R1c', '零 IMPACT 提案（两轮文案不命中词形；语义闸已挡——单写入者不双重记）',
    0, consumeRun.impactProposals)
  checkEqual('recovery', 'R1c2', '新建 2 条 TOUCH（首次消费；measured）', 2, consumeRun.createdEvents)
}
// 重放：尾窗已封口 ⇒ no_tail（零重处理——最强的幂等读数）
const replayRun = await maybeRunAffectEvaluation(db, {
  characterId, activeUserId: USER, affectReducerVersion: 2,
})
checkEqual('recovery', 'R1d', '重放：no_tail（水位封口，零重处理）', 'no_tail', replayRun.kind)
const replayTick = await maybeRunAffectSemanticEvaluation(db, { ...semanticInput, mode: 'semantic' })
checkTrue('recovery', 'R1d2', '语义重放：无新工作（闸行全挡 / no_tail）',
  replayTick.kind === 'no_tail' || (replayTick.kind === 'ran' && replayTick.committed === 0))
checkEqual('recovery', 'R1e', '往返重放：模型调用总数不变（无重评）', 3, modelCalls)
checkEqual('recovery', 'R1f', '往返重放：IMPACT 总数不变（无双重落库）', 4, (await affectImpacts()).length)

// ---------------------------------------------------------------------------
// ⑩ measured_count 自检（§6.8）+ 判定
// ---------------------------------------------------------------------------

const measured = {
  staticChecks: checks.filter((c) => c.id.startsWith('S')).length,
  modeParses: 8,
  rulesImpacts: impactsAfterRules.length,
  semanticImpacts: semanticImpact === undefined ? 0 : 1,
  sweepCancellations: sweep.kind === 'cancelled' ? sweep.cancelled : 0,
  traceSteps: semanticTick.kind === 'ran' ? affectSemanticTraceStepsOf(semanticTick, Date.now()).length : 0,
}
const measuredInvalid = Object.values(measured).some((n) => n === 0)
if (measuredInvalid) {
  console.error(`MEASUREMENT INVALID: measured_count 含 0 —— ${JSON.stringify(measured)}`)
}

const failed = checks.filter((c) => !c.pass)
const verdict = failed.length === 0 && !measuredInvalid ? 'PASS' : 'FAIL'
const runId = `wp8-verify-${new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 17)}`
const artifactDir = join(REPO_ROOT, 'artifacts', 'm8.5', runId)
mkdirSync(artifactDir, { recursive: true })
const evidence = {
  gate: 'm8.5:wp8:verify',
  verdict,
  total: checks.length,
  failed: failed.length,
  phaseCounts,
  measured,
  checks,
  modelCalls,
}
writeFileSync(join(artifactDir, 'wp8-verify.json'), JSON.stringify(evidence, null, 2))

console.log('='.repeat(72))
console.log(`M8.5 WP8 门：${verdict}（${checks.length - failed.length}/${checks.length}）`)
for (const [phase, count] of Object.entries(phaseCounts)) console.log(`  ${phase}: ${count}`)
console.log(`  模型调用（脚本化，零真实出站）：${String(modelCalls)}`)
console.log(`  证据：artifacts/m8.5/${runId}/wp8-verify.json`)
console.log('='.repeat(72))
if (verdict !== 'PASS' || measuredInvalid) process.exit(1)
