/**
 * M8.5 WP11 —— **1×500 长轨迹门**（`pnpm with-test-model pnpm m8.5:long:verify`）：
 * §19 行 6 —— v/a 夹紧真实触达 + **混合版本重放对账（A==B）**。
 *
 * ============================================================================
 *  轨迹结构（总 500 轮；语料指纹进证据）
 * ============================================================================
 *  · 规则时代（300 轮，零模型出站）：m8-long 冻结轨迹（m8-long-corpus@1）的
 *    前 300 个非注入轮——词形 IMPACT/TOUCH 以 @1 折叠进账本（含敌意块触
 *    夹紧）。这段是**混合账本的 @1 半边**。
 *  · 激活演练（§22.2 机器面）：受控 rebuild @2（A==B #1）+ markAffectSemanticCutover
 *    + 就绪闸。此后规则时代的全部来源永久落在切换边界之前。
 *  · 语义时代（200 轮，真模型）：文本取自盲测语料（blind.jsonl，冻结；
 *    按 gold 选向——暖/敌意/修复/中性/不确定/出域/操纵/上下文），逐轮 drain。
 *    敌意块以**语义增量**把 v 真实推到 −1、a 推到 1（夹紧由 @2 reducer 执行）。
 *
 * ---------------------------------------------------------------------------
 *  断言面（§19 行 6 逐条）
 * ---------------------------------------------------------------------------
 *  L1 轨迹：总轮数 500；两时代轮数与语料指纹在案。
 *  L2 轴界：全程 −1≤v≤1、0≤a≤1（每轮）。
 *  L3 夹紧：语义时代 v 真到 −1（且暖段到过 +1）、a 真到 1——**语义增量**触达，
 *     不是词形代劳。
 *  L4 单计：每个 source 的语义 IMPACT ≤ 1（崩溃/重试/收拢全程不双计）；
 *     收拢后无未终结语义工作。
 *  L5 混合重放 A==B：rebuildAffectProjectionV2（@2 重放整条混合账本——
 *     @1 时代词形事件 + @2 时代语义事件）与在线投影逐字段一致；
 *     折叠事件数 = 在线 revision（"投影是缓存"，不变量②）。
 *  L6 对账：AFFECT 域事件总数 === ORIGIN(1) + 各评估窗 createdEvents 之和
 *     + 语义 committed 总数（无重复无丢失）。
 *  L7 间隙负控：词形已落 IMPACT 的语义时代 source ⇒ 语义发现跳过
 *     （零出站、零语义 IMPACT、零闸）。
 *  L8 邻域独立：M7 relationship 投影在语义时代 revision 不动（@2 只碰 affect）。
 *
 * ---------------------------------------------------------------------------
 *  纪律
 * ---------------------------------------------------------------------------
 *  · 全真实时钟（第一次跑的实错：gateway recorder 的 createdAt 无法注入合成
 *    时钟，合成 tick now 与真实 createdAt 相减 ⇒ 语义 source 全部 EXPIRED。
 *    真实时延/时序证据本就在 e2e 门；本门的衰减/间隔读数不重复主张——
 *    读时衰减与长间隔归属 m8-long（规则时代已证）。
 *  · 传输失败是预期常态（盲测实测 ~1%）：不逐轮断言 commit——失败由下一轮
 *    drain 接住（每轮真实耗时 ≥ 2s ⇒ 重试间隔自然满足）；聚合计数与
 *    终局普查（L4/L6）承担对账。
 *  · 证据只落计数/闭集码/轴值——不落消息正文、不落模型输出（§6.3）。
 *  · 失败关闭：无测试凭证拒跑（exit 2）。
 *  · 隔离库（isolateDatabase）；真实库永不打开。
 */
import type { Character } from '../src/infrastructure/runtime/eliza-types.ts'
import { createThinHostRuntime } from '../src/infrastructure/runtime/thin-host-factory.ts'
import 'dotenv/config'

import { isolateDatabase } from '../src/dev/sandbox.ts'
isolateDatabase('m8.5-long-verify', { keep: false })



import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
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
  markAffectSemanticCutover,
  maybeRunAffectSemanticEvaluation,
} from '../src/infrastructure/runtime/affect-semantic-scheduler.ts'
import { createOpenAiAffectSemanticProvider } from '../src/infrastructure/model/affect-semantic-provider.ts'
import {
  renderAffectSection,
  renderCriticalStateSection,
  seedRelationshipOrigin,
} from '../src/infrastructure/runtime/adapters.ts'
import {
  getAffectProjection,
  rebuildAffectProjectionV2,
} from '../src/infrastructure/persistence/affect-store.ts'
import { getRelationshipProjection } from '../src/infrastructure/persistence/relationship-store.ts'
import { domainEventsFor } from '../src/infrastructure/persistence/event-store.ts'
import { AFFECT_IMPACT } from '../src/kernel/contracts/domain-event.ts'
import {
  AFFECT_SEMANTIC_POLICY_VERSION,
  affectSemanticFinalizedGateKey,
  type AffectSemanticImpactPayload,
} from '../src/kernel/contracts/affect-semantic.ts'
import type { AffectImpactPayload } from '../src/kernel/contracts/affect.ts'
import { asConversationId } from '../src/kernel/contracts/index.ts'
import {
  buildM8Trajectory,
  checkM8TrajectoryInvariants,
  M8_LONG_CORPUS_VERSION,
  type M8TurnScript,
} from './m8-long-trajectory.ts'

const REPO_ROOT = resolve(import.meta.dirname, '..')
const BLIND_CORPUS_PATH = join(REPO_ROOT, 'evals', 'm8.5', 'corpus', 'blind.jsonl')

/** 语义时代文本的选向规格：类别 × gold 过滤（盲测语料冻结标签） */
interface BlindEntry {
  id: string
  category: string
  message: string
  gold: { decision: string; family?: string }
}

function loadBlindCorpus(): { entries: BlindEntry[]; fingerprint: string } {
  const raw = readFileSync(BLIND_CORPUS_PATH, 'utf8')
  const entries: BlindEntry[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const parsed = JSON.parse(trimmed) as BlindEntry
    entries.push(parsed)
  }
  return { entries, fingerprint: createHash('sha256').update(raw).digest('hex').slice(0, 16) }
}

/** 从类别池里按 gold 过滤后循环取 n 条（不足则循环；指纹在案 ⇒ 可复现） */
function pickTexts(
  entries: BlindEntry[],
  spec: Array<{ category: string; decision?: string }>,
  count: number,
  excludeIds: string[] = []
): string[] {
  const pool: string[] = []
  for (const s of spec) {
    for (const e of entries) {
      if (e.category !== s.category) continue
      if (excludeIds.includes(e.id)) continue
      if (s.decision !== undefined && e.gold.decision !== s.decision) continue
      pool.push(e.message)
    }
  }
  if (pool.length === 0) throw new Error(`长轨迹：语料池为空——${JSON.stringify(spec)}`)
  const out: string[] = []
  for (let i = 0; i < count; i += 1) out.push(pool[i % pool.length])
  return out
}

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
const near = (a: number, b: number, tolerance = 1e-9): boolean => Math.abs(a - b) <= tolerance

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if ((process.env.OPENAI_API_KEY ?? '').trim() === '') {
    console.error('REFUSED: OPENAI_API_KEY 缺失——本门是真模型档，不产出无凭证证据。')
    console.error('用法：pnpm with-test-model pnpm m8.5:long:verify')
    process.exit(2)
  }

  // ---- 开跑闸：m8-long 语料不变量先于一切读数（INV-M45-06）----
  const { turns: m8Turns } = buildM8Trajectory()
  const invariants = checkM8TrajectoryInvariants(m8Turns)
  if (!invariants.ok) {
    console.error('MEASUREMENT INVALID：m8-long 语料不变量破损——')
    for (const problem of invariants.problems) console.error(`  - ${problem}`)
    process.exit(1)
  }
  const rulesTurns: M8TurnScript[] = m8Turns
    .filter((t) => t.kind !== 'failure_retry')
    .slice(0, 300)
  const blind = loadBlindCorpus()

  // ---- 语义时代轨迹（200 轮；块序 = 暖 → 探针 → 敌意夹紧 → 修复 → 中性 → 弃权 → 间隙负控）----
  // ⚠️ 全真实时钟（第一次跑的实错：gateway 的 recorder 用真实时钟盖 createdAt，
  // 合成 tick now 与之相减 ⇒ 每个语义 source age≈26h ⇒ 全部 EXPIRED、零评估。
  // 12h 合成跳变随之取消——读时衰减读数归属 m8-long（规则时代已证），此处不重复主张。）
  const semanticTexts: Array<{ text: string; kind: string }> = []
  const pushBlock = (texts: string[], kind: string): void => {
    for (const text of texts) semanticTexts.push({ text, kind })
  }
  pushBlock(pickTexts(blind.entries, [
    { category: 'gratitude', decision: 'IMPACT' },
    { category: 'warm-contact', decision: 'IMPACT' },
  ], 50), 'warm')
  semanticTexts.push({ text: pickTexts(blind.entries, [{ category: 'neutral' }], 1)[0], kind: 'restart_probe' })
  pushBlock(pickTexts(blind.entries, [
    { category: 'hostile', decision: 'IMPACT' },
    // b-host-010 = WP12 待人审残差（不稳定翻转项）——不做夹紧驱动
  ], 15, ['b-host-010']), 'hostile')
  pushBlock(pickTexts(blind.entries, [
    { category: 'repair', decision: 'IMPACT' },
    { category: 'comfort', decision: 'IMPACT' },
  ], 30), 'recovery')
  pushBlock(pickTexts(blind.entries, [{ category: 'neutral' }], 46), 'neutral')
  pushBlock(pickTexts(blind.entries, [
    { category: 'uncertain' },
    { category: 'out-of-scope' },
    { category: 'manipulation' },
    { category: 'context' },
  ], 57), 'abstain')
  // 间隙负控位（裸记录 + 词形写入者；文本保证词形命中）
  const INTERLUDE_TEXT = '你整理的东西永远这么清楚，谢谢你。'
  semanticTexts.push({ text: INTERLUDE_TEXT, kind: 'interlude' })

  const TOTAL_TURNS = rulesTurns.length + semanticTexts.length

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
  const USER = 'm85-long-user'
  const conversationId = asConversationId('m85-long-conv')

  const provider = createOpenAiAffectSemanticProvider()

  // 全真实时钟（见语义轨迹注释：recorder 的 createdAt 无法注入合成时钟）
  let now = Date.now()

  await seedAffectOrigin(db, { characterId, activationId: 'm85-long-act-1', now })
  await seedRelationshipOrigin(runtime, String(characterId), USER, now)

  const recorder = new ConversationRecorder({
    db,
    characterId,
    conversationId,
    dryRun: false,
    userName: USER,
    characterName: character.name,
    transport: 'm8.5-long-verify',
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

  // ---- 全程跟踪量 ----
  let expectedCreatedTotal = 0 // L6：各评估窗 createdEvents 之和（词形 TOUCH/IMPACT）
  let semanticCommittedTotal = 0 // L6：语义 IMPACT 事件数（每 commit 恰 1 事件）
  let boundsViolations = 0 // L2
  let semanticEraStarted = false
  let semanticVMin = 0
  let semanticVMax = 0
  let semanticAMax = 0
  let clampHitPositive = false // L3：语义暖段 v 到过 +1
  let clampHitNegative = false // L3：语义敌意段 v 到过 −1
  let clampHitArousal = false // L3：语义敌意段 a 到过 1
  let restartProbesOk = 0
  let semanticModelCalls = 0
  let semanticTransportFailures = 0
  let semanticNoImpact = 0
  const semanticImpactBySource = new Map<string, number>() // L4
  let interludeSkipped = 0 // L7
  let interludeModelCalls = -1 // L7：间隙负控 drain 的模型调用数（-1 = 未到）
  let interludeSourceEventId = ''
  let interludeKeywordImpacts = 0

  const keywordEval = (options: { suppress: boolean; version: 1 | 2 }) =>
    maybeRunAffectEvaluation(db, {
      characterId,
      activeUserId: USER,
      now,
      ...(options.suppress ? { suppressImpacts: true } : {}),
      affectReducerVersion: options.version,
    })

  const semanticDrain = () =>
    maybeRunAffectSemanticEvaluation(db, {
      characterId,
      characterAlias: character.name,
      activeUserId: USER,
      mode: 'semantic',
      provider,
      now,
    })

  const projectionNow = async () => (await getAffectProjection(db, characterId))?.state

  /** 轴界检查（L2）+ 语义时代夹紧跟踪（L3） */
  const trackBounds = async (): Promise<void> => {
    const projection = await getAffectProjection(db, characterId)
    if (projection === undefined) {
      boundsViolations += 1
      return
    }
    const { valence, arousal } = projection.state
    if (valence < -1 - 1e-9 || valence > 1 + 1e-9 || arousal < -1e-9 || arousal > 1 + 1e-9) {
      boundsViolations += 1
    }
    if (semanticEraStarted) {
      semanticVMin = Math.min(semanticVMin, valence)
      semanticVMax = Math.max(semanticVMax, valence)
      semanticAMax = Math.max(semanticAMax, arousal)
      if (near(valence, 1, 1e-6)) clampHitPositive = true
      if (near(valence, -1, 1e-6)) clampHitNegative = true
      if (near(arousal, 1, 1e-6)) clampHitArousal = true
    }
  }

  /** 记录词形评估窗的 createdEvents（L6 对账面） */
  const accountKeywordWindow = (outcome: Awaited<ReturnType<typeof maybeRunAffectEvaluation>>): void => {
    if (outcome.kind === 'flushed') expectedCreatedTotal += outcome.createdEvents
  }

  // ===========================================================================
  // 规则时代（300 轮；@1 折叠；零模型出站）
  // ===========================================================================

  for (const turn of rulesTurns) {
    now = Date.now()
    const gatewayTurn = await gateway.beginTurn(turn.userText)
    gatewaySeq = gatewayTurn.conversationSequence + 2
    const scheduling = await keywordEval({ suppress: false, version: 1 })
    accountKeywordWindow(scheduling)
    if (turn.checkpoint) {
      await gateway.compileTurn({
        turn: gatewayTurn,
        currentInput: turn.userText,
        recentLines: [],
        stateSection: await renderCriticalStateSection(runtime, String(characterId), USER),
        affectSection: await renderAffectSection(runtime, String(characterId), now, true),
        clockEpochMs: now,
      })
    }
    await gateway.completeTurn({ turn: gatewayTurn, replyText: '嗯，我在听。' })
    const post = await keywordEval({ suppress: false, version: 1 })
    accountKeywordWindow(post)
    await trackBounds()
  }

  // ===========================================================================
  // 激活演练（§22.2 机器面；混合账本的中点）
  // ===========================================================================

  const projectionBeforeRebuild = await getAffectProjection(db, characterId)
  const rebuild = await rebuildAffectProjectionV2(db, characterId, now)
  const projectionAfterRebuild = await getAffectProjection(db, characterId)
  record('A-DRILL-1', '激活演练：受控 rebuild @2 成功（重盖 @2 章）',
    'affect-reducer@2', rebuild.projection.reducerVersion,
    rebuild.projection.reducerVersion === 'affect-reducer@2')
  record('A-DRILL-2', '激活演练：A==B #1（@2 重放规则时代账本与 @1 在线逐字段一致）',
    'valence/arousal/revision/lastInteractionAt 全等',
    `v ${String(projectionBeforeRebuild?.state.valence)}→${String(projectionAfterRebuild?.state.valence)} · ` +
    `a ${String(projectionBeforeRebuild?.state.arousal)}→${String(projectionAfterRebuild?.state.arousal)} · ` +
    `rev ${String(projectionBeforeRebuild?.revision)}→${String(projectionAfterRebuild?.revision)}`,
    projectionBeforeRebuild !== undefined && projectionAfterRebuild !== undefined &&
      near(projectionBeforeRebuild.state.valence, projectionAfterRebuild.state.valence) &&
      near(projectionBeforeRebuild.state.arousal, projectionAfterRebuild.state.arousal) &&
      projectionBeforeRebuild.revision === projectionAfterRebuild.revision &&
      projectionBeforeRebuild.state.lastInteractionAt === projectionAfterRebuild.state.lastInteractionAt)
  const cutover = await markAffectSemanticCutover(db, characterId, now)
  record('A-DRILL-3', '激活演练：切换边界 = 激活时账本尾（> 0）',
    '> 0', String(cutover.cutoverSequence), cutover.cutoverSequence > 0)

  const relationshipBeforeSemantic = await getRelationshipProjection(db, characterId, {
    kind: 'user',
    id: USER,
  } as never)

  semanticEraStarted = true

  // ===========================================================================
  // 语义时代（200 轮；@2 折叠；真模型逐轮 drain）
  // ===========================================================================

  for (const step of semanticTexts) {
    now = Date.now()

    // 间隙负控位：裸记录（不走轮内词形消费）+ 词形写入者独占消费
    if (step.kind === 'interlude') {
      const turn = await gateway.beginTurn(step.text)
      gatewaySeq = turn.conversationSequence + 2
      await gateway.completeTurn({ turn, replyText: '小事一桩。' })
      const userEvent = turn.userEvent
      if (userEvent === undefined) throw new Error('长轨迹：interlude 轮未落用户事件')
      interludeSourceEventId = String(userEvent.id)
      const keywordWriter = await keywordEval({ suppress: false, version: 2 })
      accountKeywordWindow(keywordWriter)
      const interludeDrain = await semanticDrain()
      if (interludeDrain.kind === 'ran') {
        interludeSkipped = interludeDrain.skippedKeywordFinalized
        interludeModelCalls = interludeDrain.modelCalls
        semanticModelCalls += interludeDrain.modelCalls
        semanticCommittedTotal += interludeDrain.committed
        semanticNoImpact += interludeDrain.noImpact
      }
      await trackBounds()
      continue
    }

    const gatewayTurn = await gateway.beginTurn(step.text)
    gatewaySeq = gatewayTurn.conversationSequence + 2
    const userEvent = gatewayTurn.userEvent
    if (userEvent === undefined) throw new Error('长轨迹：语义轮未落用户事件')
    const scheduling = await keywordEval({ suppress: true, version: 2 })
    accountKeywordWindow(scheduling)
    await gateway.completeTurn({ turn: gatewayTurn, replyText: '嗯，我在听。' })
    const post = await keywordEval({ suppress: true, version: 2 })
    accountKeywordWindow(post)

    const drain = await semanticDrain()
    if (drain.kind === 'ran') {
      semanticModelCalls += drain.modelCalls
      semanticCommittedTotal += drain.committed
      semanticNoImpact += drain.noImpact
      const failures = Object.values(drain.transportFailures).reduce((a, b) => a + b, 0)
      semanticTransportFailures += failures
    }

    // 重启探针：主 drain 之后再 drain ⇒ 无新工作（本轮 source 已终结；
    // "重启 = 状态从盘上来，不漂移"的语义面读数）
    if (step.kind === 'restart_probe') {
      const probe = await semanticDrain()
      if (probe.kind === 'no_tail' || (probe.kind === 'ran' && probe.processed === 0)) {
        restartProbesOk += 1
      }
    }
    await trackBounds()
  }

  // ---- 收拢：drain 到静默（≤ 5 轮；真实 2.1s 间隔放行重试）----
  let settleRounds = 0
  let settled = false
  while (settleRounds < 5 && !settled) {
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 2_100))
    now = Date.now()
    const settle = await semanticDrain()
    settleRounds += 1
    if (settle.kind === 'no_tail' || (settle.kind === 'ran' && settle.processed === 0)) {
      settled = true
    } else if (settle.kind === 'ran') {
      semanticModelCalls += settle.modelCalls
      semanticCommittedTotal += settle.committed
      semanticNoImpact += settle.noImpact
    }
  }

  // ===========================================================================
  // 收口断言
  // ===========================================================================

  // L4：每 source 语义 IMPACT ≤ 1（从账本反查——不信任计数器）
  const allImpacts = (await domainEventsFor(db, characterId, { limit: 2000 }))
    .filter((e) => e.type === AFFECT_IMPACT)
    .map((e) => ({
      payload: e.payload as Partial<AffectImpactPayload> & Partial<AffectSemanticImpactPayload>,
    }))
  const semanticImpacts = allImpacts.filter(
    (i) => i.payload.ruleVersion === AFFECT_SEMANTIC_POLICY_VERSION
  )
  for (const i of semanticImpacts) {
    const key = String(i.payload.sourceEventId)
    semanticImpactBySource.set(key, (semanticImpactBySource.get(key) ?? 0) + 1)
  }
  const maxPerSource = Math.max(0, ...semanticImpactBySource.values())
  record('L4', '单计：每个 source 的语义 IMPACT ≤ 1（全程不双计）',
    'max ≤ 1', `max=${String(maxPerSource)} · sources=${String(semanticImpactBySource.size)} · impacts=${String(semanticImpacts.length)}`,
    maxPerSource <= 1)
  record('L4b', '收拢：drain 到静默（≤ 5 轮内）',
    'settled', `settled=${String(settled)} rounds=${String(settleRounds)}`, settled)

  // L7：间隙负控
  const interludeSemanticImpacts = interludeSourceEventId === ''
    ? []
    : semanticImpacts.filter((i) => String(i.payload.sourceEventId) === interludeSourceEventId)
  interludeKeywordImpacts = allImpacts.filter(
    (i) =>
      String(i.payload.sourceEventId) === interludeSourceEventId &&
      i.payload.ruleVersion !== AFFECT_SEMANTIC_POLICY_VERSION
  ).length
  record('L7', '间隙负控：词形已终结的语义时代 source 永不语义重评',
    'skip≥1 · 词形IMPACT=1 · 语义IMPACT=0 · 该drain零出站',
    `skip=${String(interludeSkipped)} · 词形=${String(interludeKeywordImpacts)} · 语义=${String(interludeSemanticImpacts.length)} · 出站=${String(interludeModelCalls)}`,
    interludeSkipped >= 1 &&
      interludeKeywordImpacts === 1 &&
      interludeSemanticImpacts.length === 0 &&
      interludeModelCalls === 0)

  // L6：域事件对账
  const affectEvents = (await domainEventsFor(db, characterId, { limit: 2000 }))
    .filter((e) => String(e.type).startsWith('AFFECT_'))
  const touchCount = affectEvents.filter((e) => String(e.type) === 'AFFECT_TOUCH').length
  const impactCount = affectEvents.filter((e) => String(e.type) === 'AFFECT_IMPACT').length
  record('L6', '对账：AFFECT 域事件总数 === ORIGIN(1) + 词形窗 createdEvents + 语义 committed',
    `1+${String(expectedCreatedTotal)}+${String(semanticCommittedTotal)}`,
    `实际 总=${String(affectEvents.length)} ORIGIN=${String(affectEvents.length - touchCount - impactCount)} TOUCH=${String(touchCount)} IMPACT=${String(impactCount)} · 词形窗=${String(expectedCreatedTotal)} 语义committed=${String(semanticCommittedTotal)}`,
    affectEvents.length === 1 + expectedCreatedTotal + semanticCommittedTotal)

  // L3：语义时代夹紧
  record('L3', '夹紧：语义增量真实触达（v 到过 +1 与 −1 · a 到过 1）',
    'clamp(+v)=是 clamp(−v)=是 clamp(a)=是',
    `v∈[${semanticVMin.toFixed(3)},${semanticVMax.toFixed(3)}] aMax=${semanticAMax.toFixed(3)} · ` +
    `clamp(+v)=${String(clampHitPositive)} clamp(−v)=${String(clampHitNegative)} clamp(a)=${String(clampHitArousal)}`,
    clampHitPositive && clampHitNegative && clampHitArousal)

  // L2：轴界
  record('L2', '轴界：全程 −1≤v≤1 且 0≤a≤1（每轮检查；语义时代读数在 L3 行）',
    '越界=0', `越界=${String(boundsViolations)}`, boundsViolations === 0)

  // L5：混合重放 A==B（THE 对账）
  const online = await getAffectProjection(db, characterId)
  const rebuild2 = await rebuildAffectProjectionV2(db, characterId, now)
  const rebuilt = rebuild2.projection
  const rebuildEqual =
    online !== undefined &&
    rebuilt.revision === online.revision &&
    near(rebuilt.state.valence, online.state.valence, 1e-12) &&
    near(rebuilt.state.arousal, online.state.arousal, 1e-12) &&
    rebuilt.state.cutoverSequence === online.state.cutoverSequence &&
    rebuilt.state.originated === online.state.originated &&
    rebuilt.state.lastInteractionAt === online.state.lastInteractionAt &&
    String(rebuilt.lastDomainEventId ?? '') === String(online.lastDomainEventId ?? '')
  record('L5', '混合重放 A==B：@2 重放整条混合账本（@1 词形事件 + @2 语义事件）与在线投影逐字段一致',
    'rebuild === online（v/a/cutover/originated/lastInteractionAt/lastEventId/revision 全等）',
    `rev ${String(online?.revision)}→${String(rebuilt.revision)} · ` +
    `v ${String(online?.state.valence)}→${String(rebuilt.state.valence)} · ` +
    `a ${String(online?.state.arousal)}→${String(rebuilt.state.arousal)} · 相等=${String(rebuildEqual)} · 折叠事件=${String(rebuild2.appliedEvents)}`,
    rebuildEqual && rebuild2.appliedEvents === online?.revision)

  // L8：邻域独立
  const relationshipAfter = await getRelationshipProjection(db, characterId, {
    kind: 'user',
    id: USER,
  } as never)
  record('L8', '邻域独立：M7 relationship 投影在语义时代 revision 不动',
    `rev ${String(relationshipBeforeSemantic?.revision)} 不变`,
    `rev ${String(relationshipAfter?.revision)}`,
    relationshipBeforeSemantic !== undefined &&
      relationshipAfter !== undefined &&
      relationshipBeforeSemantic.revision === relationshipAfter.revision)

  // L1：轨迹
  record('L1', '轨迹：总轮数 500（规则 300 + 语义 200）· 语料指纹在案',
    `500 · ${M8_LONG_CORPUS_VERSION} + blind@${blind.fingerprint}`,
    `${String(TOTAL_TURNS)} · ${M8_LONG_CORPUS_VERSION} + blind@${blind.fingerprint}（规则 ${String(rulesTurns.length)} + 语义 ${String(semanticTexts.length)}）`,
    TOTAL_TURNS === 500 && rulesTurns.length === 300 && semanticTexts.length === 200)

  // ===========================================================================
  // 量具自检（§6.8）+ 证据
  // ===========================================================================

  const measured = {
    rulesTurns: rulesTurns.length,
    semanticTurns: semanticTexts.length,
    semanticImpacts: semanticImpacts.length,
    semanticNoImpact,
    semanticModelCalls,
    restartProbesOk,
  }
  const measuredInvalid = Object.values(measured).some((n) => n === 0)
  if (measuredInvalid) {
    console.error(`MEASUREMENT INVALID: measured_count 含 0 —— ${JSON.stringify(measured)}`)
  }
  const failed = checks.filter((c) => !c.pass)
  const verdict = failed.length === 0 && !measuredInvalid ? 'PASS' : 'FAIL'

  const runId = `long-${new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 17)}`
  const artifactDir = join(REPO_ROOT, 'artifacts', 'm8.5', runId)
  mkdirSync(artifactDir, { recursive: true })
  const evidence = {
    gate: 'm8.5:long:verify',
    verdict,
    total: checks.length,
    failed: failed.length,
    measured,
    corpus: { m8Long: M8_LONG_CORPUS_VERSION, blindFingerprint: blind.fingerprint },
    axis: {
      semanticVMin,
      semanticVMax,
      semanticAMax,
      clampHitPositive,
      clampHitNegative,
      clampHitArousal,
    },
    checks,
    provider: { id: provider.id, endpointHost: provider.endpointHost },
  }
  writeFileSync(join(artifactDir, 'long-verify.json'), JSON.stringify(evidence, null, 2))

  console.log('='.repeat(72))
  console.log(`M8.5 长轨迹门（1×500 混合账本）：${verdict}（${checks.length - failed.length}/${checks.length}）`)
  console.log(`  语义 IMPACT=${String(semanticImpacts.length)} · no_impact=${String(semanticNoImpact)} · 模型调用=${String(semanticModelCalls)} · 传输失败=${String(semanticTransportFailures)}`)
  console.log(`  轴读数：v∈[${semanticVMin.toFixed(3)},${semanticVMax.toFixed(3)}] aMax=${semanticAMax.toFixed(3)}`)
  console.log(`  证据：artifacts/m8.5/${runId}/long-verify.json`)
  console.log('='.repeat(72))
  process.exit(verdict === 'PASS' ? 0 : 1)
}

void main()
