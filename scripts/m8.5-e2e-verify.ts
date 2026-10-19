/**
 * M8.5 WP11 —— **e2e 真实链路门**（`pnpm with-test-model pnpm m8.5:e2e:verify`）：
 * §19 前四行验收项在**隔离库 + 真 TurnGateway + 真模型**下的证明。
 *
 * ============================================================================
 *  与既有门的分工（§16.1：本门是真实模型档，不进离线链）
 * ============================================================================
 *  · wp6/wp7/wp8 门：worker 机制与模式切换（脚本化模型，离线）——已全绿；
 *  · 本门：同一套机制在**真实传输 + 真实时延**下的时序/阻塞/恢复/顺序读数
 *    （计划 §19 行 1–4），外加 §24 ③ 间隙负控的真模型版（行 E5）。
 *  · 生产副本 Live Smoke（§19 行 5）= m8.5:live:level1（另一脚本）；
 *  · 长轨迹 1×500（§19 行 6）= m8.5:long:verify（另一脚本）。
 *
 * ---------------------------------------------------------------------------
 *  场景（全部真模型出站；文本取自盲测语料 clear-positive 条目）
 * ---------------------------------------------------------------------------
 *  E0 激活演练：rules 时代（词形 IMPACT）→ 受控 rebuild @2（A==B 逐字段）
 *     → markAffectSemanticCutover → 就绪闸 ⇒ ready（§9.3/§22.2 的机器面）。
 *  E1 慢路径时序（§19-1）：S1 编译时状态 = IMPACT 前状态；drain 后 IMPACT
 *     createdAt > completeTurn 时刻；SOURCE_ANCHORED 锚 = 来源 createdAt；
 *     S2 编译看到新状态（"最早下一轮"）。
 *  E2 聊天零阻塞（§19-2）：drain 在飞时整轮网关轮完成且不被放大
 *     （fire-and-forget 形状 = main.ts drainSemanticTail 同款）。
 *  E3 重启恢复（§19-3）：出站中止（shutdown 信号形状）⇒ 可重试、零 IMPACT、
 *     水位不越；"重启"（再 drain）⇒ 恰一条 IMPACT、闸在、水位过。
 *  E4 顺序（§8.2）：两个 source 同时待办 ⇒ 一个 drain 升序串行处置，
 *     早 source 终结先于晚 source 提交。
 *  E5 间隙负控（§24 ③ 真模型版）：词形已落 IMPACT 的边界后 source
 *     ⇒ 语义发现跳过（零出站、零语义 IMPACT、零闸）。
 *
 * ---------------------------------------------------------------------------
 *  纪律
 * ---------------------------------------------------------------------------
 *  · 真实时钟（与 m8-live 同款：时延断言用墙钟；轴值断言 ±0.04 容差覆盖
 *    秒级真实衰减）。
 *  · 证据只落计数/时延/闭集码/事件 id——不落消息正文、不落模型输出（§6.3）。
 *  · 失败关闭：无测试凭证 ⇒ 拒跑（exit 2），不产出任何"看起来跑了"的证据。
 *  · 隔离库（isolateDatabase）；真实库永不打开。
 */
import type { Character } from '../src/infrastructure/runtime/eliza-types.ts'
import { createThinHostRuntime } from '../src/infrastructure/runtime/thin-host-factory.ts'
import 'dotenv/config'

import { isolateDatabase } from '../src/dev/sandbox.ts'
isolateDatabase('m8.5-e2e-verify', { keep: false })



import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { character } from '../src/character/index.ts'
import { initDatabase } from '../src/db/index.ts'
import { initKernel } from '../src/kernel/app/kernel.ts'
import { characterDefinitionFromCharacter } from '../src/infrastructure/runtime/seed-projection.ts'
import { TurnGateway } from '../src/kernel/app/turn-gateway.ts'
import { ConversationRecorder } from '../src/infrastructure/runtime/conversation-recorder.ts'
import {
  createCharacterAssistantTurnIngress,
  createHumanConsoleUserTurnIngress,
} from '../src/infrastructure/runtime/conversation-attribution.ts'
import {
  maybeRunAffectEvaluation,
  seedAffectOrigin,
} from '../src/infrastructure/runtime/affect-scheduler.ts'
import {
  affectSemanticActivationReady,
  markAffectSemanticCutover,
  maybeRunAffectSemanticEvaluation,
} from '../src/infrastructure/runtime/affect-semantic-scheduler.ts'
import { createOpenAiAffectSemanticProvider } from '../src/infrastructure/model/affect-semantic-provider.ts'
import {
  renderAffectSection,
  renderCriticalStateSection,
} from '../src/infrastructure/runtime/adapters.ts'
import {
  rebuildAffectProjectionV2,
  getAffectProjection,
} from '../src/infrastructure/persistence/affect-store.ts'
import { domainEventsFor } from '../src/infrastructure/persistence/event-store.ts'
import { getWatermark, listProcessedOperations } from '../src/infrastructure/persistence/job-store.ts'
import {
  AFFECT_IMPACT,
} from '../src/kernel/contracts/domain-event.ts'
import {
  AFFECT_SEMANTIC_POLICY_VERSION,
  AFFECT_SEMANTIC_WORKER_PROCESSOR,
  affectSemanticFinalizedGateKey,
  type AffectSemanticImpactPayload,
} from '../src/kernel/contracts/affect-semantic.ts'
import { AFFECT_SEMANTIC_WORKER_NAME } from '../src/kernel/app/affect/semantic-worker.ts'
import type { AffectImpactPayload } from '../src/kernel/contracts/affect.ts'
import { asConversationId } from '../src/kernel/contracts/index.ts'

const REPO_ROOT = resolve(import.meta.dirname, '..')

// ---------------------------------------------------------------------------
// 冻结文本（盲测语料 clear-positive；committed 进仓库 = 可复现，非用户内容）
// ---------------------------------------------------------------------------

/** rules 时代 + E5 间隙负控：含「谢谢你」⇒ 词形必命中（A-GRATITUDE） */
const TEXT_KEYWORD_GRATITUDE = '你整理的东西永远这么清楚，谢谢你。'
/** E1/E2 语义主文本：无词形标记 ⇒ 词形零命中（运行时以 suppressedImpacts=0 复证） */
const TEXT_SEMANTIC_ONLY = '你上次陪我聊到凌晨，我一直记着。'
const TEXT_SEMANTIC_ONLY_2 = '我同事都羡慕我有个这么靠谱的帮手。'
const TEXT_SEMANTIC_ONLY_3 = '刚才那番话点醒我了，收获很大。'
const TEXT_SEMANTIC_ONLY_4 = '跟你聊完心里踏实多了，真的。'
const TEXT_SEMANTIC_ONLY_5 = '这个问题你讲得比谁都明白。'

// ---------------------------------------------------------------------------
// 检查条目
// ---------------------------------------------------------------------------

interface Check {
  id: string
  label: string
  expected: string
  actual: string
  pass: boolean
}
const checks: Check[] = []
function record(id: string, label: string, expected: string, actual: string, pass: boolean): void {
  checks.push({ id, label, expected, actual, pass })
  if (!pass) console.error(`FAIL [${id}] ${label}: expected=${expected} actual=${actual}`)
}
function checkEqual(id: string, label: string, expected: unknown, actual: unknown): void {
  record(id, label, JSON.stringify(expected), JSON.stringify(actual),
    JSON.stringify(expected) === JSON.stringify(actual))
}
function checkTrue(id: string, label: string, value: boolean): void {
  record(id, label, 'true', String(value), value === true)
}
function checkClose(id: string, label: string, expected: number, actual: number, tol = 0.04): void {
  record(id, label, `≈${expected.toFixed(3)}±${tol}`, actual.toFixed(4), Math.abs(expected - actual) <= tol)
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // ---- 失败关闭：无凭证拒跑（with-test-model 负责注入测试端点） ----
  if ((process.env.OPENAI_API_KEY ?? '').trim() === '') {
    console.error('REFUSED: OPENAI_API_KEY 缺失——本门是真模型档，不产出无凭证证据。')
    console.error('用法：pnpm with-test-model pnpm m8.5:e2e:verify')
    process.exit(2)
  }

  const runtime = createThinHostRuntime({
    character: character,
    settings: {},
  })
  await initDatabase(runtime)
  await runtime.initialize()
  const kernel = await initKernel(runtime, {
    definition: characterDefinitionFromCharacter(character),
  })
  const db = kernel.stores.db
  const characterId = kernel.characterId
  const USER = 'm85-e2e-user'
  const conversationId = asConversationId('m85-e2e-conv')

  const provider = createOpenAiAffectSemanticProvider()
  const semanticDrain = (options: { signal?: AbortSignal } = {}) =>
    maybeRunAffectSemanticEvaluation(db, {
      characterId,
      characterAlias: character.name,
      activeUserId: USER,
      mode: 'semantic',
      provider,
      now: Date.now(),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    })

  // ---- 建档（@1；真实时钟）----
  await seedAffectOrigin(db, { characterId, activationId: 'm85-e2e-act-1', now: Date.now() })

  const recorder = new ConversationRecorder({
    db,
    characterId,
    conversationId,
    dryRun: false,
    userName: USER,
    characterName: character.name,
    transport: 'm8.5-e2e-verify',
    attribution: [createHumanConsoleUserTurnIngress(), createCharacterAssistantTurnIngress()],
    userId: USER,
    userRef: USER,
  })
  let gatewaySeq = 1
  const gateway = new TurnGateway({
    kernel,
    definition: kernel.definition,
    identity: kernel.identitySnapshot,
    recorder,
    conversationSequence: () => gatewaySeq,
    recentLimit: 16,
    slowPathEnabled: false,
    dryRun: false,
    userId: USER,
  })

  const projectionNow = async () => (await getAffectProjection(db, characterId))?.state
  const impactsOf = async () => {
    const events = await domainEventsFor(db, characterId)
    return events
      .filter((e) => e.type === AFFECT_IMPACT)
      .map((e) => ({
        createdAt: Number(e.createdAt),
        payload: e.payload as Partial<AffectImpactPayload> & Partial<AffectSemanticImpactPayload>,
      }))
  }
  const semanticImpactsFor = async (sourceEventId: string) =>
    (await impactsOf()).filter(
      (i) =>
        String(i.payload.sourceEventId) === sourceEventId &&
        i.payload.ruleVersion === AFFECT_SEMANTIC_POLICY_VERSION
    )
  const workerWatermark = async () =>
    (await getWatermark(db, characterId, AFFECT_SEMANTIC_WORKER_NAME, AFFECT_SEMANTIC_WORKER_PROCESSOR))
      ?.processedThroughSequence ?? 0
  const gateOf = async (sourceEventId: string) =>
    (await listProcessedOperations(db, characterId, 500))
      .find((row) => row.idempotencyKey === affectSemanticFinalizedGateKey(sourceEventId as never))

  /**
   * 一次网关轮。`shape`：
   *  · 'rules'    —— 激活前：词形全路径（不抑制，@1 折叠）；
   *  · 'semantic' —— 激活后：词形 TOUCH 照旧 + IMPACT 让位（@2 折叠）。
   * 返回墙钟读数与编译时投影（时序断言的锚）。
   */
  async function gatewayTurn(
    text: string,
    replyText: string,
    shape: 'rules' | 'semantic'
  ): Promise<{
    userEventId: string
    userSequence: number
    userCreatedAt: number
    completeTurnEndMs: number
    stateAtCompile: number | null
    turnDurationMs: number
  }> {
    const startedMs = Date.now()
    const turn = await gateway.beginTurn(text)
    gatewaySeq = turn.conversationSequence + 2
    const stateAtCompile = (await projectionNow())?.valence ?? null
    const scheduling = await maybeRunAffectEvaluation(db, {
      characterId,
      activeUserId: USER,
      now: Date.now(),
      ...(shape === 'semantic'
        ? { suppressImpacts: true, affectReducerVersion: 2 as const }
        : { affectReducerVersion: 1 as const }),
    })
    if (scheduling.kind === 'failed') {
      throw new Error(`e2e: 轮内词形评估失败——${scheduling.error}`)
    }
    const section = await renderAffectSection(runtime, String(characterId), Date.now(), true)
    await gateway.compileTurn({
      turn,
      currentInput: text,
      recentLines: [],
      stateSection: await renderCriticalStateSection(runtime, String(characterId), USER),
      affectSection: section,
      clockEpochMs: Date.now(),
    })
    await gateway.completeTurn({ turn, replyText })
    // 轮后幂等补消费（回复事件进尾窗；semantic 形状下 TOUCH 照旧）
    const post = await maybeRunAffectEvaluation(db, {
      characterId,
      activeUserId: USER,
      now: Date.now(),
      ...(shape === 'semantic'
        ? { suppressImpacts: true, affectReducerVersion: 2 as const }
        : { affectReducerVersion: 1 as const }),
    })
    if (post.kind === 'failed') {
      throw new Error(`e2e: 轮后词形评估失败——${post.error}`)
    }
    const userEvent = turn.userEvent
    if (userEvent === undefined) throw new Error('e2e: beginTurn 未落用户事件')
    return {
      userEventId: String(userEvent.id),
      userSequence: userEvent.sequence,
      userCreatedAt: Number(userEvent.createdAt),
      completeTurnEndMs: Date.now(),
      stateAtCompile,
      turnDurationMs: Date.now() - startedMs,
    }
  }

  // ===========================================================================
  // E0 激活演练（§9.3 + §22.2 机器面）
  // ===========================================================================

  const rulesTurn = await gatewayTurn(TEXT_KEYWORD_GRATITUDE, '不客气。', 'rules')
  const impactsAfterRules = await impactsOf()
  checkEqual('E0a', 'rules 时代：词形 IMPACT 恰一条（affect-rules@1）', 1, impactsAfterRules.length)
  const projectionBeforeRebuild = await getAffectProjection(db, characterId)
  const stateBeforeRebuild = projectionBeforeRebuild?.state
  const readyBefore = await affectSemanticActivationReady(db, characterId)
  checkTrue('E0b', '就绪闸：@1 行 ⇒ 未就绪（激活前语义面休眠）', readyBefore.ready === false)

  const rebuild = await rebuildAffectProjectionV2(db, characterId, Date.now())
  const projectionAfterRebuild = await getAffectProjection(db, characterId)
  const stateAfterRebuild = projectionAfterRebuild?.state
  checkEqual('E0c', '受控 rebuild：投影行重盖 @2 章', 'affect-reducer@2', rebuild.projection.reducerVersion)
  checkTrue('E0d', 'A==B：@2 重放与 @1 时代逐字段一致（valence/arousal/lastInteractionAt/revision）',
    stateBeforeRebuild !== undefined && stateAfterRebuild !== undefined &&
    stateBeforeRebuild.valence === stateAfterRebuild.valence &&
    stateBeforeRebuild.arousal === stateAfterRebuild.arousal &&
    stateBeforeRebuild.lastInteractionAt === stateAfterRebuild.lastInteractionAt &&
    projectionBeforeRebuild?.revision === projectionAfterRebuild?.revision)
  const cutover = await markAffectSemanticCutover(db, characterId, Date.now())
  checkTrue('E0e', '切换边界：semanticCutoverSequence 置为账本尾（> 0）', cutover.cutoverSequence > 0)
  const readyAfter = await affectSemanticActivationReady(db, characterId)
  checkTrue('E0f', '就绪闸：@2 行 ⇒ ready（语义面可运行）', readyAfter.ready === true)

  // ===========================================================================
  // E1 慢路径时序（§19-1）
  // ===========================================================================

  const s1 = await gatewayTurn(TEXT_SEMANTIC_ONLY, '嗯，我也记得。', 'semantic')
  const valenceBeforeDrain = (await projectionNow())?.valence ?? 0
  const drain1Started = Date.now()
  const drain1 = await semanticDrain()
  const drain1Ms = Date.now() - drain1Started
  checkEqual('E1a', 'drain 真跑（ran）', 'ran', drain1.kind)
  if (drain1.kind === 'ran') {
    checkTrue('E1b', 'S1 语义 IMPACT 落库（真模型判 clear-positive；文本无词形标记 ⇒ 增量只能来自语义）',
      drain1.committed >= 1)
    checkEqual('E1c', 'S1 词形零命中复证（suppressedImpacts=0——语义唯一写入者）',
      0, drain1.skippedKeywordFinalized)
  }
  const s1Impacts = await semanticImpactsFor(s1.userEventId)
  checkEqual('E1d', 'S1 语义 IMPACT 恰一条', 1, s1Impacts.length)
  if (s1Impacts.length === 1) {
    const impact = s1Impacts[0]
    /*
     * 时序断言的口径（探针 m8.5-e2e-probe 实测）：IMPACT 的 created_at = drain
     * tick 的 now = drain 调用时刻，与 completeTurnEnd 只隔一次投影读（毫秒级）
     * ⇒ 同毫秒相等是时钟粒度，不是时序违例。用 ≥（"不早于回复定稿"）；
     * 因果序——"S1 的回复不可能看到这条 IMPACT"——由 E1i 的编译时状态证明。
     */
    record('E1e', '时序：IMPACT createdAt 不早于 completeTurn 时刻（慢路径在回复定稿之后；同毫秒=时钟粒度）',
      `>= ${String(s1.completeTurnEndMs)}`, `${String(impact.createdAt)} (Δ=${String(impact.createdAt - s1.completeTurnEndMs)}ms)`,
      impact.createdAt >= s1.completeTurnEndMs)
    checkTrue('E1f', 'SOURCE_ANCHORED：锚 = 来源 createdAt（不是提交时刻）',
      impact.payload.sourceAt === s1.userCreatedAt)
    checkEqual('E1g', '策略版本 = affect-semantic-policy@1', AFFECT_SEMANTIC_POLICY_VERSION, impact.payload.ruleVersion)
    checkTrue('E1h', '时序：IMPACT createdAt > 编译时刻（S1 的回复用的是 IMPACT 前状态）',
      impact.createdAt > s1.completeTurnEndMs - s1.turnDurationMs)
  }
  const valenceAfterDrain = (await projectionNow())?.valence ?? 0
  checkTrue('E1i', 'S1 编译时状态 = IMPACT 前状态（本轮回复未被慢路径污染）',
    Math.abs((s1.stateAtCompile ?? 0) - valenceBeforeDrain) < 1e-9)
  checkTrue('E1j', 'drain 后状态移动（语义增量真实触达）',
    Math.abs(valenceAfterDrain - valenceBeforeDrain) > 0.01)
  // S2 编译看到新状态（"最早下一轮"）
  const s2 = await gatewayTurn(TEXT_SEMANTIC_ONLY_2, '哈哈，谢谢。', 'semantic')
  checkClose('E1k', 'S2 编译时 valence ≈ IMPACT 后状态（±0.04 容差覆盖真实衰减）',
    valenceAfterDrain, s2.stateAtCompile ?? -1)
  // S2 的 source 留给 E2 用（尚无 drain）

  // ===========================================================================
  // E2 聊天零阻塞（§19-2）
  // ===========================================================================

  const drain2Started = Date.now()
  const drain2Promise = semanticDrain() // fire-and-forget（main.ts 同款形状）
  const s3 = await gatewayTurn(TEXT_SEMANTIC_ONLY_3, '嗯，我在。', 'semantic')
  const s3Ended = Date.now()
  const drain2 = await drain2Promise
  const drain2Ended = Date.now()
  const drain2Ms = drain2Ended - drain2Started
  checkTrue('E2a', '网关轮在 drain 完成前完成（回复路径不被模型调用阻塞）', s3Ended < drain2Ended)
  checkTrue('E2b', `网关轮墙钟 < 2000ms（实测 ${s3.turnDurationMs}ms；drain ${drain2Ms}ms）`,
    s3.turnDurationMs < 2000)
  checkTrue('E2c', 'drain 时延 > 网关轮时延（模型调用真实在飞）', drain2Ms > s3.turnDurationMs)
  if (drain2.kind === 'ran') {
    checkTrue('E2d', '在飞 drain 处置了 S2 的 source（committed ≥ 1）', drain2.committed >= 1)
  }
  const s2Impacts = await semanticImpactsFor(s2.userEventId)
  checkEqual('E2e', 'S2 语义 IMPACT 恰一条（在飞 drain 不丢工作）', 1, s2Impacts.length)
  // 掉队者收拢：S3 出生在 drain2 的发现窗之后（fire-and-forget 的真实形状——
  // "可能不止延后一轮"）。下一次 drain 必须接住它；否则它会混进 E3 的恢复窗。
  const settleDrain = await semanticDrain()
  checkTrue('E2f', '掉队者收拢：S3 被下一次 drain 接住（committed ≥ 1）',
    settleDrain.kind === 'ran' && settleDrain.committed >= 1)
  const s3Impacts = await semanticImpactsFor(s3.userEventId)
  checkEqual('E2g', 'S3 语义 IMPACT 恰一条（在飞期间出生的 source 不丢不重）', 1, s3Impacts.length)

  // ===========================================================================
  // E3 重启恢复（§19-3）
  // ===========================================================================

  const s4 = await gatewayTurn(TEXT_SEMANTIC_ONLY_4, '能帮到你就好。', 'semantic')
  const abortController = new AbortController()
  const abortTimer = setTimeout(() => abortController.abort(), 300)
  const abortedDrain = await semanticDrain({ signal: abortController.signal })
  clearTimeout(abortTimer)
  checkEqual('E3a', '中止 drain 如实收场（ran + 传输失败计数）', 'ran', abortedDrain.kind)
  if (abortedDrain.kind === 'ran') {
    checkTrue('E3b', '中止映射为闭集传输码 timeout（可重试路径）',
      (abortedDrain.transportFailures.timeout ?? 0) >= 1)
    checkTrue('E3c', '零 committed（中止不产生半截 IMPACT）', abortedDrain.committed === 0)
  }
  const s4ImpactsAborted = await semanticImpactsFor(s4.userEventId)
  checkEqual('E3d', '中止后 S1..S4 语义 IMPACT 零新增（S4 零贡献）', 0, s4ImpactsAborted.length)
  checkTrue('E3e', '完成水位楔在 S4 之下（不越过未终结 source）',
    (await workerWatermark()) < s4.userSequence)
  // "重启"：下一进程的启动追赶（无信号、新鲜调用）
  await new Promise((resolve) => setTimeout(resolve, 2100)) // 重试最短间隔 2000ms
  const recoveryDrain = await semanticDrain()
  checkEqual('E3f', '重启追赶真跑（ran）', 'ran', recoveryDrain.kind)
  if (recoveryDrain.kind === 'ran') {
    checkTrue('E3g', '恢复后恰一次提交（不重复计分）', recoveryDrain.committed === 1)
  }
  const s4ImpactsRecovered = await semanticImpactsFor(s4.userEventId)
  checkEqual('E3h', 'S4 语义 IMPACT 恰一条（崩溃-恢复不双计）', 1, s4ImpactsRecovered.length)
  checkTrue('E3i', 'S4 终结闸在位（COMMITTED 回执）', (await gateOf(s4.userEventId)) !== undefined)
  checkTrue('E3j', '完成水位越过 S4', (await workerWatermark()) >= s4.userSequence)

  // ===========================================================================
  // E4 顺序（§8.2：早 source 终结先于晚 source 提交）
  // ===========================================================================

  const s5 = await gatewayTurn(TEXT_SEMANTIC_ONLY_5, '谢谢你说这话。', 'semantic')
  const s6 = await gatewayTurn(TEXT_SEMANTIC_ONLY, '我也很开心。', 'semantic')
  const orderedDrain = await semanticDrain()
  checkEqual('E4a', '单 drain 处置两个待办 source（ran）', 'ran', orderedDrain.kind)
  if (orderedDrain.kind === 'ran') {
    checkEqual('E4b', '两个 source 各恰一次提交', 2, orderedDrain.committed)
    checkEqual('E4c', '模型调用 = 2（升序串行，无并发）', 2, orderedDrain.modelCalls)
  }
  const s5Gate = await gateOf(s5.userEventId)
  const s6Impacts = await semanticImpactsFor(s6.userEventId)
  checkTrue('E4d', 'S5 终结闸在场（先处置）', s5Gate !== undefined)
  if (s5Gate !== undefined && s6Impacts.length === 1) {
    checkTrue('E4e', '顺序：S5 终结时刻 ≤ S6 提交时刻（§8.2 不变量）',
      Number(s5Gate.processedAt) <= s6Impacts[0].createdAt)
  }
  checkTrue('E4f', '完成水位越过 S6', (await workerWatermark()) >= s6.userSequence)

  // ===========================================================================
  // E5 间隙负控（§24 ③ 真模型版：词形已终结的边界后 source 永不语义重评）
  // ===========================================================================

  /*
   * S7 裸记录（beginTurn/completeTurn，**不走** gatewayTurn 的轮内词形消费）：
   * 间隙形状 = source 出生后只被词形写入者消费。若走 gatewayTurn，轮内评估
   * （suppressImpacts）会先消费尾部，词形写入者无事可做（第一次跑的实错）。
   */
  const s7Turn = await gateway.beginTurn(TEXT_KEYWORD_GRATITUDE)
  gatewaySeq = s7Turn.conversationSequence + 2
  await gateway.completeTurn({ turn: s7Turn, replyText: '小事一桩。' })
  const s7UserEvent = s7Turn.userEvent
  if (s7UserEvent === undefined) throw new Error('e2e: S7 beginTurn 未落用户事件')
  const s7 = {
    userEventId: String(s7UserEvent.id),
    userSequence: s7UserEvent.sequence,
  }
  // 模拟 shadow 间隙的词形写入者：不抑制（词形 IMPACT 落库、@2 折叠）
  const keywordInterlude = await maybeRunAffectEvaluation(db, {
    characterId,
    activeUserId: USER,
    now: Date.now(),
    affectReducerVersion: 2,
  })
  checkTrue('E5a', '间隙词形写入者活着（flushed；@2 行上 @2 折叠——回滚路径）',
    keywordInterlude.kind === 'flushed')
  const s7KeywordImpacts = (await impactsOf()).filter(
    (i) => String(i.payload.sourceEventId) === s7.userEventId &&
      i.payload.ruleVersion !== AFFECT_SEMANTIC_POLICY_VERSION
  )
  checkEqual('E5b', 'S7 词形 IMPACT 恰一条（间隙写入者的终态处置）', 1, s7KeywordImpacts.length)
  const interludeDrain = await semanticDrain()
  checkEqual('E5c', '语义 drain 真跑（ran）', 'ran', interludeDrain.kind)
  if (interludeDrain.kind === 'ran') {
    checkTrue('E5d', 'S7 被证据式兜底跳过（skippedKeywordFinalized ≥ 1——零出站）',
      interludeDrain.skippedKeywordFinalized >= 1)
    checkEqual('E5e', '本轮零模型调用（跳过不出站）', 0, interludeDrain.modelCalls)
  }
  const s7SemanticImpacts = await semanticImpactsFor(s7.userEventId)
  checkEqual('E5f', 'S7 语义 IMPACT = 0（同一 source 不双计）', 0, s7SemanticImpacts.length)
  checkTrue('E5g', 'S7 无语义闸（不是语义工作，不写谎账）', (await gateOf(s7.userEventId)) === undefined)

  // ===========================================================================
  // 汇总 + 量具自检（§6.8）+ 证据
  // ===========================================================================

  const totalSemanticImpacts = (await impactsOf()).filter(
    (i) => i.payload.ruleVersion === AFFECT_SEMANTIC_POLICY_VERSION
  ).length
  const measured = {
    rulesImpacts: impactsAfterRules.length,
    rebuildAppliedEvents: rebuild.appliedEvents,
    semanticImpacts: totalSemanticImpacts,
    drains: 6,
  }
  const measuredInvalid = Object.values(measured).some((n) => n === 0)
  if (measuredInvalid) {
    console.error(`MEASUREMENT INVALID: measured_count 含 0 —— ${JSON.stringify(measured)}`)
  }
  const failed = checks.filter((c) => !c.pass)
  const verdict = failed.length === 0 && !measuredInvalid ? 'PASS' : 'FAIL'

  const runId = `e2e-${new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 17)}`
  const artifactDir = join(REPO_ROOT, 'artifacts', 'm8.5', runId)
  mkdirSync(artifactDir, { recursive: true })
  const evidence = {
    gate: 'm8.5:e2e:verify',
    verdict,
    total: checks.length,
    failed: failed.length,
    measured,
    timings: {
      drain1Ms,
      drain2Ms,
      s3TurnMs: s3.turnDurationMs,
    },
    checks,
    provider: { id: provider.id, endpointHost: provider.endpointHost },
  }
  writeFileSync(join(artifactDir, 'e2e-verify.json'), JSON.stringify(evidence, null, 2))

  console.log('='.repeat(72))
  console.log(`M8.5 e2e 真实链路门：${verdict}（${checks.length - failed.length}/${checks.length}）`)
  console.log(`  语义 IMPACT 总数：${String(totalSemanticImpacts)} · drain 时延：${drain1Ms}ms / ${drain2Ms}ms`)
  console.log(`  证据：artifacts/m8.5/${runId}/e2e-verify.json`)
  console.log('='.repeat(72))
  process.exit(verdict === 'PASS' ? 0 : 1)
}

void main()
