/**
 * AffectSemanticWorker —— M8.5 语义评估的**慢路径任务编排**（WP6 / ADR-068 §8）。
 *
 * ============================================================================
 *  它管什么（计划 §8 的机器化）
 * ============================================================================
 * ```text
 * tick = 发现（扫描水位推进）→ 补发现（水位间隙里的未终结 source）→ 逐任务处理
 *        （认领 → 时龄检查 → 出站 → 模型 → 解析 → 原子终态）→ 完成水位推进
 * ```
 *
 * 三个水位（Contract-Freeze §5；处理器名在 contracts 冻结）：
 * · `affect-semantic-scanner@1` —— 扫到哪了。可越过：不合格事件、已入队事件、
 *   扫描期过期终态。**不可**越过：入队失败的事件（失败 ⇒ 本轮不推进，补洞）。
 * · `affect-semantic-worker@1` —— 语义完成到哪了。**只**可越过有持久终态
 *   （终结闸行）的合格 source；一个未终结 source 楔住它（§8.4 的不变量）。
 * · `affect-semantic-impact@1` —— 最后一次成功 IMPACT 的 source 序号（审计）。
 *
 * ---------------------------------------------------------------------------
 *  队列的可恢复性（§8.1：内存通知不是工作真相）
 * ---------------------------------------------------------------------------
 * 待处理队列**每轮从持久状态重推导**：`(workerWm, scannerWm]` 区间里的合格
 * source ∧ 无终结闸行。进程崩溃 ⇒ 下一轮 tick 从间隙补发现——不依赖任何
 * 内存队列或通知存活。
 *
 * ---------------------------------------------------------------------------
 *  终态与终结闸（M85-D20；机制在 WP6 第一批落地）
 * ---------------------------------------------------------------------------
 * 每个终态 = 一行 `processed_operations`（键 `affect-semantic-finalized:<id>`，
 * operation = 紧凑回执编码）+ 可选 AFFECT_IMPACT 事件，**同一事务**：
 * 闸缺失 + 重评 + 判定漂移 = 同一来源双重 IMPACT——闸必须与终态原子。
 *
 * 状态机（§8.4）：DISCOVERED → CLAIMED → EVALUATING →（VALIDATED）→
 * COMMITTED / NO_IMPACT / RETRYABLE_FAILED(→CLAIMED，次数受限) /
 * TERMINAL_FAILED / EXPIRED / CANCELLED_BY_MODE_CHANGE / SOURCE_INVALIDATED。
 * 任务行（character_jobs）承载在飞状态：pending=DISCOVERED、running=CLAIMED/
 * EVALUATING、failed=RETRYABLE_FAILED（部分唯一索引允许重建 ⇒ 重试有活路）。
 * 尝试计数 = 任务行 retryCount（enqueueJob 既有语义，零迁移）。
 *
 * ---------------------------------------------------------------------------
 *  重试政策（§8.3 冻结值）
 * ---------------------------------------------------------------------------
 * · 只有**传输失败**（4 码闭集）可重试；解析失败（11 码）确定性 ⇒ 直接终态。
 * · 每 source 最多 2 次尝试（含首次）；重试最短间隔 2,000ms（端口回传的
 *   lastAttemptAt 即上次尝试时刻；间隔未到 ⇒ 本轮跳过，不烧模型）。
 * · Retry-After 提示（rate_limited）与最短间隔取大者，且只在任务寿命内有效。
 * · 时龄 > 120,000ms ⇒ EXPIRED（不出站、不重试）——很久前的闲聊不在
 *   重启后突然改变当前情绪。
 *
 * ---------------------------------------------------------------------------
 *  模式（§4.2 单写入者）
 * ---------------------------------------------------------------------------
 * 本 worker 只在 `semantic` 模式下运行。`rules` ⇒ 零读零写（词形路径独占）；
 * `shadow` 的评估采集是 WP9/WP10 装配的隔离评测面（不写生产闸/水位），
 * 不在本 worker 里偷偷跑。模式切换取消（CANCELLED_BY_MODE_CHANGE）与
 * 来源失效（SOURCE_INVALIDATED）的回执编码走同一条 commitOutcome 原子路径。
 *
 * ---------------------------------------------------------------------------
 *  纪律
 * ---------------------------------------------------------------------------
 * · 模型调用期间**不持有数据库事务**（短事务认领 → 调用 → 短事务终态）。
 * · 每 Character 串行、sourceSequence 升序；一个可重试 source 楔住队列
 *   （后续不越过——§8.3"后续 source 不越过较早未终结 source"）。
 * · 失败不抛（调度层失败关闭，聊天不被后台故障打断——与 M8 调度同源）。
 * · 不打印模型输出/用户正文；结果只带闭集码与计数（trace 纪律）。
 */
import {
  AFFECT_SEMANTIC_CUTOVER_NAME,
  AFFECT_SEMANTIC_CUTOVER_PROCESSOR,
  AFFECT_SEMANTIC_MAX_AGE_MS,
  AFFECT_SEMANTIC_MAX_ATTEMPTS,
  AFFECT_SEMANTIC_RETRY_MIN_INTERVAL_MS,
  AFFECT_SEMANTIC_SCAN_BATCH_SIZE,
  AFFECT_SEMANTIC_SCANNER_PROCESSOR,
  AFFECT_SEMANTIC_WORKER_PROCESSOR,
  AFFECT_SEMANTIC_IMPACT_PROCESSOR,
  affectSemanticFinalizedGateKey,
  encodeAffectSemanticCommittedReceipt,
  encodeAffectSemanticNoImpactReceipt,
  encodeAffectSemanticTerminalReceipt,
  isAffectSemanticTransportFailure,
  type AffectSemanticMode,
  type AffectSemanticTransportFailureCode,
} from '../../contracts/affect-semantic.ts'
import {
  affectEvidenceVerdictOf,
  type AffectDelta,
  type AffectRuleFamily,
  type AffectState,
} from '../../contracts/affect.ts'
import type { ConversationEvent } from '../../contracts/conversation-event.ts'
import type { CharacterId, ConversationEventId } from '../../contracts/ids.ts'
import { processorEventViewOf } from '../memory/extractor.ts'
import {
  assembleSemanticContextWindow,
  buildSemanticOutbound,
  evaluateSemanticResponse,
  type SemanticModelResponseEnvelope,
} from './semantic-evaluator.ts'

// ---------------------------------------------------------------------------
// 身份与键
// ---------------------------------------------------------------------------

/**
 * 水位处理器的名字/版本拆分（job-store 口径：name 裸名 + version 带 @1；
 * contracts 冻结的是完整版本串——此处按 M8 先例拆开使用）。
 */
export const AFFECT_SEMANTIC_SCANNER_NAME = 'affect-semantic-scanner' as const
export const AFFECT_SEMANTIC_WORKER_NAME = 'affect-semantic-worker' as const
export const AFFECT_SEMANTIC_IMPACT_NAME = 'affect-semantic-impact' as const

/** 任务行触发种类：对话驱动（既有闭集值；不新造 trigger kind） */
export const AFFECT_SEMANTIC_TASK_TRIGGER_KIND = 'conversation' as const

/** 任务级幂等键：每 source 一个任务（跨尝试稳定；failed 行允许重建） */
export const AFFECT_SEMANTIC_TASK_KEY_PREFIX = 'affect-semantic-task:'
export function affectSemanticTaskIdempotencyKey(sourceEventId: ConversationEventId): string {
  return `${AFFECT_SEMANTIC_TASK_KEY_PREFIX}${String(sourceEventId)}`
}

/** 上下文回看的账本窗口（装配器再按会话/30min/≤6 收紧；这里只给候选） */
const CONTEXT_LOOKBACK_EVENTS = 50

// ---------------------------------------------------------------------------
// 端口（装配层注入；本层不认识 SQL——与 M8 AffectJobPorts 同源）
// ---------------------------------------------------------------------------

/** 一个待处理 source 的持久坐标（全部来自账本，不含正文推导物） */
export interface AffectSemanticSourceRef {
  readonly sourceEventId: ConversationEventId
  readonly sourceSequence: number
  readonly conversationId: string
  /** source 发生时间（毫秒 epoch；时龄与 SOURCE_ANCHORED 的锚） */
  readonly sourceAt: number
  readonly content: string
}

export interface AffectSemanticCommitInput {
  readonly source: AffectSemanticSourceRef
  /** 缺省 = 无 IMPACT 终态（NO_IMPACT / EXPIRED / …） */
  readonly impact?: {
    readonly family: AffectRuleFamily
    readonly delta: AffectDelta
    readonly sourceAt: number
  }
  /** 事件落地时终结闸携带的回执（COMMITTED / NO_IMPACT 编码） */
  readonly receipt: string
  /** 事件被放行口拒绝时终结闸改带的回执（TERMINAL_FAILED 编码） */
  readonly fallbackReceipt: string
  readonly now: number
}

export type AffectSemanticCommitOutcome =
  | {
      readonly kind: 'committed'
      readonly createdCount: number
      readonly deduplicatedCount: number
      readonly extraRecordedCount: number
    }
  | {
      readonly kind: 'no_impact'
      readonly extraRecordedCount: number
    }
  | {
      readonly kind: 'rejected'
      /** 放行口拒码（闭集；只进计数与 trace，不带 message 正文） */
      readonly rejectionCodes: string[]
      readonly extraRecordedCount: number
    }

export interface AffectSemanticWorkerPorts {
  readonly characterAlias: string
  /** 账本最大序号（扫描窗口上界） */
  latestSequence(characterId: CharacterId): Promise<number>
  /** 读账本区间事件（升序；含归因信封） */
  loadEventsInRange(
    characterId: CharacterId,
    fromSequence: number,
    toSequence: number
  ): Promise<ConversationEvent[]>
  /** 情绪投影（建档与 cutover 边界） */
  getAffectState(characterId: CharacterId): Promise<AffectState | undefined>
  /** 幂等查询（终结闸在场判定） */
  hasProcessed(idempotencyKey: string): Promise<boolean>
  /**
   * 已被**词形写入者**落过 IMPACT 的 source id 集合（§24 ③ 防双重计分）。
   *
   * 跨模式边界（semantic ↔ rules/shadow 往返）的机械载体：词形 IMPACT 是
   * 另一写入者对该 source 的终态处置——语义面永不重评（重评 = 同一来源
   * 双重 IMPACT）。判别在装配层（payload.ruleVersion = affect-rules@1）；
   * worker 只消费集合。durable（事件同事务落库）⇒ 崩溃窗口为零——
   * 位置式边界（切换时推水位）在"切换后崩溃"下有洞，证据式没有。
   */
  keywordImpactedSourceIds(): Promise<ReadonlySet<string>>
  getWatermark(processor: string, processorVersion: string): Promise<number | undefined>
  advanceWatermark(
    processor: string,
    processorVersion: string,
    throughSequence: number,
    now: number
  ): Promise<void>
  /** 入队/复用任务行（retryCount = 此前尝试数；lastAttemptAt = 最近一次尝试时刻） */
  enqueueTask(
    source: { sourceEventId: ConversationEventId; sourceSequence: number },
    now: number
  ): Promise<{
    jobId: string
    created: boolean
    retryCount: number
    /** 最近一次尝试的时刻（重试间隔对此计时；首次任务 = 本轮 now） */
    lastAttemptAt: number
  }>
  markTaskRunning(jobId: string, now: number): Promise<void>
  finishTask(
    jobId: string,
    status: 'completed' | 'failed',
    opts?: { error?: string },
    now?: number
  ): Promise<void>
  /** 原子终态：可选 IMPACT 事件 + 终结闸行，同一事务（WP6 第一批机制） */
  commitOutcome(input: AffectSemanticCommitInput): Promise<AffectSemanticCommitOutcome>
  /** 模型调用（WP5 provider；不持事务）。结构形状——provider 结果直接可赋值 */
  callModel(
    outboundText: string,
    signal?: AbortSignal
  ): Promise<AffectSemanticModelCallOutcome>
}

/**
 * 模型调用的最小结构形状（WP5 provider 的 `AffectSemanticTransportOutcome`
 * 结构性满足本类型——worker 不依赖 infrastructure 类型，装配层零适配）。
 */
export type AffectSemanticModelCallOutcome =
  | {
      readonly ok: true
      readonly envelope: SemanticModelResponseEnvelope
      readonly requestCount: number
    }
  | {
      readonly ok: false
      readonly failure: AffectSemanticTransportFailureCode
      readonly requestCount: number
      readonly retryAfterMs?: number
    }

// ---------------------------------------------------------------------------
// tick 结局（闭集计数；trace 友好——WP8 映射）
// ---------------------------------------------------------------------------

export type AffectSemanticWorkerTick =
  | { kind: 'mode_not_semantic'; mode: AffectSemanticMode }
  | { kind: 'not_originated' }
  | { kind: 'no_tail'; scannerWatermark: number; latest: number }
  | {
      kind: 'ran'
      scannerWatermark: number
      workerWatermark: number
      latest: number
      /** 本轮扫描事件数 */
      scanned: number
      /** 不合格事件数（type ≠ user_message） */
      skippedNotUserMessage: number
      /** 不合格事件数（资格/归因/cutover 判定不过） */
      skippedUnqualified: number
      /** 扫描期即过期（时龄超限，未入队未出站） */
      expiredAtScan: number
      /** 已有终结闸（崩溃恢复跳过） */
      alreadyFinalized: number
      /** 已被词形写入者落过 IMPACT（§24 ③ 跨模式边界——永不重评，防双重计分） */
      skippedKeywordFinalized: number
      /** 序号 ≤ semanticCutoverSequence（§24 ③ 位置边界——切换前来源永不评估） */
      skippedPreCutover: number
      /** 入队（含复用崩溃遗留行） */
      enqueued: number
      /** 本轮处理的待办 source 数 */
      processed: number
      committed: number
      noImpact: number
      /** 放行口拒绝 ⇒ TERMINAL_FAILED 终态 */
      rejectedByValidator: number
      terminalFailed: number
      expiredAtProcess: number
      sourceInvalidated: number
      /** 可重试但本轮未再试（间隔未到/尝试预算留给下一轮） */
      retryableDeferred: number
      /** 尝试预算烧尽 ⇒ TERMINAL_FAILED */
      retryExhausted: number
      modelCalls: number
      /** 传输失败按闭集码计数 */
      transportFailures: Partial<Record<AffectSemanticTransportFailureCode, number>>
      /** 解析失败按闭集码计数（确定性，不重试） */
      parseFailures: Record<string, number>
      /** 出站预算超限（input_budget_exceeded；确定性终态） */
      budgetExceeded: number
    }

// ---------------------------------------------------------------------------
// tick
// ---------------------------------------------------------------------------

export interface AffectSemanticWorkerTickInput {
  readonly characterId: CharacterId
  /** 唯一 active user（M8-D11 口径） */
  readonly activeUserId: string
  readonly allowedUserIds?: readonly string[]
  readonly mode: AffectSemanticMode
  readonly now?: number
  /** shutdown 信号（透传给模型调用；中止 ⇒ 传输 timeout ⇒ 可重试路径） */
  readonly signal?: AbortSignal
}

/** 单事件资格判定（复用唯一实现；trustedOrigin 走受信读数派生——ADR-043 DR-6） */
function sourceQualified(
  event: ConversationEvent,
  policy: { activeUserId: string; allowedUserIds?: readonly string[]; cutoverSequence: number | null }
): boolean {
  if (event.type !== 'user_message') return false
  const view = processorEventViewOf(event)
  const verdict = affectEvidenceVerdictOf(
    [
      {
        id: event.id,
        sequence: event.sequence,
        type: view.type,
        actorId: event.actorId,
        trustedOrigin: view.trustedOrigin,
      },
    ],
    policy
  )
  return verdict.ok
}

function sourceRefOf(event: ConversationEvent): AffectSemanticSourceRef {
  return {
    sourceEventId: event.id,
    sourceSequence: event.sequence,
    conversationId: String(event.conversationId),
    sourceAt: Number(event.createdAt),
    content: event.content,
  }
}

/**
 * 跑一次语义 worker tick。幂等且**不抛**（失败关闭进计数；与 M8 调度同纪律）。
 *
 * `semantic` 模式专用；`rules`/`shadow` 返回具名 no-op（见文件头"模式"节）。
 */
export async function runAffectSemanticWorkerTick(
  ports: AffectSemanticWorkerPorts,
  input: AffectSemanticWorkerTickInput
): Promise<AffectSemanticWorkerTick> {
  const now = input.now ?? Date.now()

  if (input.mode !== 'semantic') {
    return { kind: 'mode_not_semantic', mode: input.mode }
  }

  const state = await ports.getAffectState(input.characterId)
  if (state === undefined || !state.originated) {
    return { kind: 'not_originated' }
  }
  const policy = {
    activeUserId: input.activeUserId,
    allowedUserIds: input.allowedUserIds,
    cutoverSequence: state.cutoverSequence,
  }

  const counters = {
    scanned: 0,
    skippedNotUserMessage: 0,
    skippedUnqualified: 0,
    expiredAtScan: 0,
    alreadyFinalized: 0,
    skippedKeywordFinalized: 0,
    skippedPreCutover: 0,
    enqueued: 0,
    processed: 0,
    committed: 0,
    noImpact: 0,
    rejectedByValidator: 0,
    terminalFailed: 0,
    expiredAtProcess: 0,
    sourceInvalidated: 0,
    retryableDeferred: 0,
    retryExhausted: 0,
    modelCalls: 0,
    budgetExceeded: 0,
  }
  const transportFailures: Partial<Record<AffectSemanticTransportFailureCode, number>> = {}
  const parseFailures: Record<string, number> = {}

  const scannerWmStart =
    (await ports.getWatermark(AFFECT_SEMANTIC_SCANNER_NAME, AFFECT_SEMANTIC_SCANNER_PROCESSOR)) ?? 0
  const workerWmStart =
    (await ports.getWatermark(AFFECT_SEMANTIC_WORKER_NAME, AFFECT_SEMANTIC_WORKER_PROCESSOR) ?? 0)
  const latest = await ports.latestSequence(input.characterId)
  if (latest <= scannerWmStart && workerWmStart >= scannerWmStart) {
    return { kind: 'no_tail', scannerWatermark: scannerWmStart, latest }
  }

  // §24 ③ 跨模式边界集合（懒加载：无候选时零查询——稳态 no_tail 不付查询成本）
  let keywordImpacted: ReadonlySet<string> | undefined
  const keywordImpactedSet = async (): Promise<ReadonlySet<string>> => {
    keywordImpacted ??= await ports.keywordImpactedSourceIds()
    return keywordImpacted
  }
  // §24 ③ 位置边界（semanticCutoverSequence——§22.2/§23/M85-D20 的冻结机制；
  // 水位行承载，缺省 0 = 无边界）。序号 ≤ 边界 ⇒ 永不语义评估。
  const semanticCutover =
    (await ports.getWatermark(AFFECT_SEMANTIC_CUTOVER_NAME, AFFECT_SEMANTIC_CUTOVER_PROCESSOR)) ?? 0

  // ---- ① 发现：推进扫描水位（不合格 / 已终结 / 过期 / 入队都算处置完毕）----
  const scanTo = Math.min(latest, scannerWmStart + AFFECT_SEMANTIC_SCAN_BATCH_SIZE)
  if (scanTo > scannerWmStart) {
    const events = await ports.loadEventsInRange(input.characterId, scannerWmStart + 1, scanTo)
    for (const event of events) {
      counters.scanned += 1
      if (event.type !== 'user_message') {
        counters.skippedNotUserMessage += 1
        continue
      }
      if (!sourceQualified(event, policy)) {
        counters.skippedUnqualified += 1
        continue
      }
      // §24 ③ 位置边界：切换前来源永不语义重评（防双重计分的主机制）
      if (event.sequence <= semanticCutover) {
        counters.skippedPreCutover += 1
        continue
      }
      const gateKey = affectSemanticFinalizedGateKey(event.id)
      if (await ports.hasProcessed(gateKey)) {
        counters.alreadyFinalized += 1
        continue
      }
      // §24 ③：词形写入者已落 IMPACT 的 source 永不语义重评（防双重计分；
      // 词形 IMPACT = 另一写入者的终态处置，等效"已终结"——扫描水位可越过）
      if ((await keywordImpactedSet()).has(String(event.id))) {
        counters.skippedKeywordFinalized += 1
        continue
      }
      // 时龄超限：直接 EXPIRED 终态（不入队、不出站——§8.3）
      if (now - Number(event.createdAt) > AFFECT_SEMANTIC_MAX_AGE_MS) {
        await ports.commitOutcome({
          source: sourceRefOf(event),
          receipt: encodeAffectSemanticTerminalReceipt('EXPIRED'),
          fallbackReceipt: encodeAffectSemanticTerminalReceipt('EXPIRED'),
          now,
        })
        counters.expiredAtScan += 1
        continue
      }
      await ports.enqueueTask(
        { sourceEventId: event.id, sourceSequence: event.sequence },
        now
      )
      counters.enqueued += 1
    }
    await ports.advanceWatermark(
      AFFECT_SEMANTIC_SCANNER_NAME,
      AFFECT_SEMANTIC_SCANNER_PROCESSOR,
      scanTo,
      now
    )
  }

  // ---- ② 补发现：从水位间隙重推导待办（崩溃恢复；内存队列不是真相）----
  const scannerWm = scanTo > scannerWmStart ? scanTo : scannerWmStart
  const pending: {
    source: AffectSemanticSourceRef
    jobId: string
    retryCount: number
    lastAttemptAt: number
  }[] = []
  // 连续已终结前缀：完成水位可以安全推进到的位置（§8.4 不变量——
  // 只许越过有持久终态的合格 source；第一个未终结合格 source 楔住它）。
  let contiguousTerminal = workerWmStart
  let advanceBlocked = false
  if (scannerWm > workerWmStart) {
    const gapEvents = await ports.loadEventsInRange(input.characterId, workerWmStart + 1, scannerWm)
    for (const event of gapEvents) {
      const qualified =
        event.type === 'user_message' && sourceQualified(event, policy)
      // §24 ③ 位置边界：边界前 source 在间隙重推导里等效已终结（不楔、不入队）
      if (qualified && event.sequence <= semanticCutover) {
        if (!advanceBlocked) contiguousTerminal = event.sequence
        continue
      }
      const finalized = qualified
        ? await ports.hasProcessed(affectSemanticFinalizedGateKey(event.id))
        : false
      // §24 ③：词形已终结的 source 在间隙重推导里等效已终结（不楔完成水位、
      // 不入队——否则往返切换后 worker 水位被永久楔死）。计数只在发现段
      // （与 alreadyFinalized 同语义：每 source 恰一次；间隙是重推导不是首见）。
      const keywordDone = qualified && !finalized
        ? (await keywordImpactedSet()).has(String(event.id))
        : false
      if (keywordDone) {
        if (!advanceBlocked) contiguousTerminal = event.sequence
        continue
      }
      if (qualified && !finalized) {
        // 未终结合格 source：楔住完成水位，但继续收集后续待办（本轮升序处理）
        advanceBlocked = true
        const task = await ports.enqueueTask(
          { sourceEventId: event.id, sourceSequence: event.sequence },
          now
        )
        pending.push({ source: sourceRefOf(event), ...task })
        continue
      }
      if (!advanceBlocked) contiguousTerminal = event.sequence
    }
  }
  // 扫描期终态（EXPIRED 等）与崩溃前已终结的 source：水位补推进（只许前进）
  let workerWm = workerWmStart
  if (contiguousTerminal > workerWm) {
    workerWm = contiguousTerminal
    await ports.advanceWatermark(
      AFFECT_SEMANTIC_WORKER_NAME,
      AFFECT_SEMANTIC_WORKER_PROCESSOR,
      workerWm,
      now
    )
  }
  // ---- ③ 逐任务处理（升序串行；一个未终结 source 楔住队列）----
  pending.sort((a, b) => a.source.sourceSequence - b.source.sourceSequence)
  for (const task of pending) {
    const source = task.source
    // 提交前重新校验（§6.2：资格可能已变——失效则 SOURCE_INVALIDATED，不提交）
    const fresh = await ports.loadEventsInRange(
      input.characterId,
      source.sourceSequence,
      source.sourceSequence
    )
    const freshEvent = fresh.find((e) => String(e.id) === String(source.sourceEventId))
    if (freshEvent === undefined || !sourceQualified(freshEvent, policy)) {
      await ports.commitOutcome({
        source,
        receipt: encodeAffectSemanticTerminalReceipt('SOURCE_INVALIDATED'),
        fallbackReceipt: encodeAffectSemanticTerminalReceipt('SOURCE_INVALIDATED'),
        now,
      })
      await ports.finishTask(task.jobId, 'completed', undefined, now)
      counters.sourceInvalidated += 1
      counters.processed += 1
      workerWm = Math.max(workerWm, source.sourceSequence)
      await ports.advanceWatermark(
        AFFECT_SEMANTIC_WORKER_NAME,
        AFFECT_SEMANTIC_WORKER_PROCESSOR,
        workerWm,
        now
      )
      continue
    }

    // 时龄（认领时再查一次：排队也计入时龄——§8.3）
    if (now - source.sourceAt > AFFECT_SEMANTIC_MAX_AGE_MS) {
      await ports.commitOutcome({
        source,
        receipt: encodeAffectSemanticTerminalReceipt('EXPIRED'),
        fallbackReceipt: encodeAffectSemanticTerminalReceipt('EXPIRED'),
        now,
      })
      await ports.finishTask(task.jobId, 'completed', undefined, now)
      counters.expiredAtProcess += 1
      counters.processed += 1
      workerWm = Math.max(workerWm, source.sourceSequence)
      await ports.advanceWatermark(
        AFFECT_SEMANTIC_WORKER_NAME,
        AFFECT_SEMANTIC_WORKER_PROCESSOR,
        workerWm,
        now
      )
      continue
    }

    // 重试间隔未到：本轮跳过（不烧模型；队列在此楔住——后续不越过）
    if (now - task.lastAttemptAt < AFFECT_SEMANTIC_RETRY_MIN_INTERVAL_MS && task.retryCount > 0) {
      counters.retryableDeferred += 1
      break
    }

    // ---- 认领（短事务）→ 出站 → 模型（无事务）→ 解析 → 终态（短事务）----
    await ports.markTaskRunning(task.jobId, now)
    counters.processed += 1

    const contextCandidates = await ports.loadEventsInRange(
      input.characterId,
      Math.max(1, source.sourceSequence - CONTEXT_LOOKBACK_EVENTS),
      source.sourceSequence - 1
    )
    const window = assembleSemanticContextWindow({
      conversationId: source.conversationId,
      sourceSequence: source.sourceSequence,
      sourceAt: source.sourceAt,
      candidates: contextCandidates,
    })
    const outbound = buildSemanticOutbound({
      characterAlias: ports.characterAlias,
      currentMessage: source.content,
      context: window.messages,
    })
    if (!outbound.ok) {
      // 出站预算超限：确定性失败 ⇒ TERMINAL_FAILED（不重试、无 IMPACT）
      await ports.commitOutcome({
        source,
        receipt: encodeAffectSemanticTerminalReceipt('TERMINAL_FAILED'),
        fallbackReceipt: encodeAffectSemanticTerminalReceipt('TERMINAL_FAILED'),
        now,
      })
      await ports.finishTask(task.jobId, 'completed', undefined, now)
      counters.budgetExceeded += 1
      workerWm = Math.max(workerWm, source.sourceSequence)
      await ports.advanceWatermark(
        AFFECT_SEMANTIC_WORKER_NAME,
        AFFECT_SEMANTIC_WORKER_PROCESSOR,
        workerWm,
        now
      )
      continue
    }

    const transport = await ports.callModel(outbound.outbound.text, input.signal)
    counters.modelCalls += 1

    if (!transport.ok) {
      const code = transport.failure
      transportFailures[code] = (transportFailures[code] ?? 0) + 1
      const attemptsUsed = task.retryCount + 1
      const ageStillFine = now - source.sourceAt <= AFFECT_SEMANTIC_MAX_AGE_MS
      if (attemptsUsed < AFFECT_SEMANTIC_MAX_ATTEMPTS && ageStillFine) {
        // 可重试：任务行落 failed（部分唯一索引允许重建）；下一轮补发现再试
        await ports.finishTask(task.jobId, 'failed', { error: code }, now)
        counters.retryableDeferred += 1
        break // 队列楔住：后续 source 不越过较早未终结 source
      }
      await ports.commitOutcome({
        source,
        receipt: encodeAffectSemanticTerminalReceipt('TERMINAL_FAILED'),
        fallbackReceipt: encodeAffectSemanticTerminalReceipt('TERMINAL_FAILED'),
        now,
      })
      await ports.finishTask(task.jobId, 'completed', undefined, now)
      counters.retryExhausted += 1
      workerWm = Math.max(workerWm, source.sourceSequence)
      await ports.advanceWatermark(
        AFFECT_SEMANTIC_WORKER_NAME,
        AFFECT_SEMANTIC_WORKER_PROCESSOR,
        workerWm,
        now
      )
      continue
    }

    const evaluated = evaluateSemanticResponse(transport.envelope, {
      characterAlias: ports.characterAlias,
      currentMessage: source.content,
      context: window.messages,
    })
    if (evaluated.kind === 'parse_failed') {
      // 解析失败（11 码闭集）：确定性 ⇒ TERMINAL_FAILED，不重试
      parseFailures[evaluated.failure] = (parseFailures[evaluated.failure] ?? 0) + 1
      await ports.commitOutcome({
        source,
        receipt: encodeAffectSemanticTerminalReceipt('TERMINAL_FAILED'),
        fallbackReceipt: encodeAffectSemanticTerminalReceipt('TERMINAL_FAILED'),
        now,
      })
      await ports.finishTask(task.jobId, 'completed', undefined, now)
      counters.terminalFailed += 1
      workerWm = Math.max(workerWm, source.sourceSequence)
      await ports.advanceWatermark(
        AFFECT_SEMANTIC_WORKER_NAME,
        AFFECT_SEMANTIC_WORKER_PROCESSOR,
        workerWm,
        now
      )
      continue
    }

    const judgment = evaluated.judgment
    const mapping = evaluated.mapping
    if (
      judgment.decision === 'IMPACT' &&
      mapping.decision === 'IMPACT' &&
      mapping.dominantFamily !== undefined &&
      mapping.delta !== undefined
    ) {
      const committedReceipt = encodeAffectSemanticCommittedReceipt(
        mapping.dominantFamily,
        outbound.outbound.fingerprint
      )
      const commit = await ports.commitOutcome({
        source,
        impact: {
          family: mapping.dominantFamily,
          delta: mapping.delta,
          sourceAt: source.sourceAt,
        },
        receipt: committedReceipt,
        fallbackReceipt: encodeAffectSemanticTerminalReceipt('TERMINAL_FAILED'),
        now,
      })
      if (commit.kind === 'committed') {
        counters.committed += 1
        // 最后成功影响水位（审计面；只许前进）
        await ports.advanceWatermark(
          AFFECT_SEMANTIC_IMPACT_NAME,
          AFFECT_SEMANTIC_IMPACT_PROCESSOR,
          source.sourceSequence,
          now
        )
      } else if (commit.kind === 'rejected') {
        counters.rejectedByValidator += 1
      } else {
        // commitOutcome 对带 impact 的输入只会回 committed/rejected——防御性计数
        counters.terminalFailed += 1
      }
    } else {
      const decision =
        judgment.decision === 'NEUTRAL' || judgment.decision === 'UNCERTAIN'
          ? judgment.decision
          : 'OUT_OF_SCOPE'
      const commit = await ports.commitOutcome({
        source,
        receipt: encodeAffectSemanticNoImpactReceipt(decision, outbound.outbound.fingerprint),
        fallbackReceipt: encodeAffectSemanticTerminalReceipt('TERMINAL_FAILED'),
        now,
      })
      if (commit.kind === 'no_impact') counters.noImpact += 1
      else counters.terminalFailed += 1
    }
    await ports.finishTask(task.jobId, 'completed', undefined, now)
    workerWm = Math.max(workerWm, source.sourceSequence)
    await ports.advanceWatermark(
      AFFECT_SEMANTIC_WORKER_NAME,
      AFFECT_SEMANTIC_WORKER_PROCESSOR,
      workerWm,
      now
    )
  }

  return {
    kind: 'ran',
    scannerWatermark: scannerWm,
    workerWatermark: workerWm,
    latest,
    ...counters,
    transportFailures,
    parseFailures,
  }
}

/** 传输失败码闭集守卫（供装配层与门校验） */
export function isAffectSemanticTransportFailureCode(
  value: string
): value is AffectSemanticTransportFailureCode {
  return isAffectSemanticTransportFailure(value)
}

// ---------------------------------------------------------------------------
// 模式切换取消扫面（§8.4 CANCELLED_BY_MODE_CHANGE 的生产装配面——WP8）
// ---------------------------------------------------------------------------

export type AffectSemanticCancellationSweep =
  | {
      kind: 'no_pending'
      scannerWatermark: number
      workerWatermark: number
      /** §24 ②：本次扫面把 semanticCutoverSequence 推进到的账本序号 */
      cutoverAdvancedTo: number
    }
  | {
      kind: 'cancelled'
      scannerWatermark: number
      workerWatermark: number
      /** 间隙里的合格 source 总数（含此前已终结的） */
      qualifiedInGap: number
      /** 本次写下的 CANCELLED 终态闸行数 */
      cancelled: number
      /** 已有终态（此前运行已处置）⇒ 跳过 */
      alreadyFinalized: number
      /** 词形写入者已落 IMPACT ⇒ 跳过（§24 ③——不是"被取消的语义工作"，不写闸） */
      skippedKeywordFinalized: number
      /** 序号 ≤ semanticCutoverSequence ⇒ 跳过（§24 ③ 位置边界——从未是语义工作候选） */
      skippedPreCutover: number
      /** §24 ②：本次扫面把 semanticCutoverSequence 推进到的账本序号 */
      cutoverAdvancedTo: number
    }

/**
 * 把水位间隙里**未终结**的合格 source 全部收拢为 CANCELLED_BY_MODE_CHANGE
 * 终态（回滚路径——计划 §4.2"回滚是一项具名模式切换"的收尾面）。
 *
 * 何时跑：启动追赶时模式 ≠ `semantic`（上一运行是语义模式、本次切走）。
 * 不跑在 `semantic` 模式下——那个模式下间隙由 worker tick 正常处置。
 *
 * 除收拢外，扫面还做 §24 ② 的**切换边界记录**：把 semanticCutoverSequence
 * 推进到当前账本尾（只进不退）。切走期间词形消费过的 source 从此永久落在
 * 边界之前 ⇒ 切回 semantic 后永不重评（§24 ③ 位置边界的主写入面）。
 *
 * 语义（与 tick 的间隙再推导同一套资格/闸逻辑）：
 * · 合格 ∧ 无终态闸 ⇒ `commitOutcome` 写 CANCELLED 闸行（无 IMPACT——
 *   取消不是评估，不产生情绪影响）+ 收拢遗留任务行（failed + 具名原因；
 *   闸行挡住一切后续重推导，任务行只是审计残留，不留"永不结束的 pending"）；
 * · 合格 ∧ 已有闸 ⇒ 跳过（计数 alreadyFinalized）；
 * · 合格 ∧ 词形已落 IMPACT ⇒ 跳过不写闸（另一写入者的终态，不是语义工作）；
 * · 合格 ∧ 序号 ≤ cutover 边界 ⇒ 跳过不写闸（从未是语义工作候选）；
 * · 不合格事件 ⇒ 不写闸（它们本来就不该有终态闸）。
 * 收拢完成后 worker 水位推进到 scanner 水位（间隙内不再有未终结合格 source）。
 *
 * 幂等且不抛（与 tick 同纪律）；重复跑 ⇒ 全部 alreadyFinalized。
 */
export async function cancelAffectSemanticPendingSources(
  ports: AffectSemanticWorkerPorts,
  input: {
    characterId: CharacterId
    /** 唯一 active user（资格判定） */
    activeUserId: string
    now?: number
  }
): Promise<AffectSemanticCancellationSweep> {
  const now = input.now ?? Date.now()

  const scannerWatermark =
    (await ports.getWatermark(AFFECT_SEMANTIC_SCANNER_NAME, AFFECT_SEMANTIC_SCANNER_PROCESSOR)) ?? 0
  const workerWatermark =
    (await ports.getWatermark(AFFECT_SEMANTIC_WORKER_NAME, AFFECT_SEMANTIC_WORKER_PROCESSOR)) ?? 0
  /*
   * §24 ②"切换时刻记录切换边界"：切离扫面把 semanticCutoverSequence 推进到
   * 当前账本尾（只进不退）。此后切回 semantic 时，切走期间词形消费过的全部
   * source 都在边界之前 ⇒ 永不语义重评。重启（仍在 semantic）不跑扫面 ⇒
   * 边界不动 ⇒ 在途语义工作不丢——这就是"切换"与"重启"的判别面。
   *
   * ⚠️ 顺序：先收拢在途语义工作，**最后**才推边界——先推会把间隙里待收拢的
   * source 一并埋进"边界前"（它们是在途语义工作，不是切换后词形消费）。
   */
  const latest = await ports.latestSequence(input.characterId)
  const advanceCutover = async (): Promise<number> => {
    if (latest > 0) {
      await ports.advanceWatermark(
        AFFECT_SEMANTIC_CUTOVER_NAME,
        AFFECT_SEMANTIC_CUTOVER_PROCESSOR,
        latest,
        now
      )
    }
    return latest
  }
  if (scannerWatermark <= workerWatermark) {
    const cutoverAdvancedTo = await advanceCutover()
    return { kind: 'no_pending', scannerWatermark, workerWatermark, cutoverAdvancedTo }
  }
  // 未建档 ⇒ 语义评估从未跑过（水位间隙只可能来自既有语义运行）；
  // 防御性失败关闭：不写任何闸行，如实报告。
  const state = await ports.getAffectState(input.characterId)
  if (state === undefined || !state.originated) {
    const cutoverAdvancedTo = await advanceCutover()
    return { kind: 'no_pending', scannerWatermark, workerWatermark, cutoverAdvancedTo }
  }
  const policy = {
    activeUserId: input.activeUserId,
    cutoverSequence: state.cutoverSequence,
  }
  const semanticCutover =
    (await ports.getWatermark(AFFECT_SEMANTIC_CUTOVER_NAME, AFFECT_SEMANTIC_CUTOVER_PROCESSOR)) ?? 0

  const gapEvents = await ports.loadEventsInRange(
    input.characterId,
    workerWatermark + 1,
    scannerWatermark
  )
  // §24 ③ 同款：词形已终结 / 边界前的 source 不写 CANCELLED 闸（它们不是
  // "被取消的语义工作"——写闸会撒谎；前者是另一写入者的终态，后者从未是
  // 语义工作的候选）。
  const keywordImpacted = await ports.keywordImpactedSourceIds()
  let qualifiedInGap = 0
  let cancelled = 0
  let alreadyFinalized = 0
  let skippedKeywordFinalized = 0
  let skippedPreCutover = 0
  for (const event of gapEvents) {
    if (event.type !== 'user_message') continue
    if (!sourceQualified(event, policy)) continue
    qualifiedInGap += 1
    if (event.sequence <= semanticCutover) {
      skippedPreCutover += 1
      continue
    }
    const gateKey = affectSemanticFinalizedGateKey(event.id)
    if (await ports.hasProcessed(gateKey)) {
      alreadyFinalized += 1
      continue
    }
    if (keywordImpacted.has(String(event.id))) {
      skippedKeywordFinalized += 1
      continue
    }
    await ports.commitOutcome({
      source: sourceRefOf(event),
      receipt: encodeAffectSemanticTerminalReceipt('CANCELLED_BY_MODE_CHANGE'),
      fallbackReceipt: encodeAffectSemanticTerminalReceipt('CANCELLED_BY_MODE_CHANGE'),
      now,
    })
    // 收拢遗留任务行（如有）：闸行已挡住重推导；任务行如实记"未完成 + 原因"，
    // 不留永不结束的 pending（M8 WP7 同款审计纪律）。
    const task = await ports.enqueueTask(
      { sourceEventId: event.id, sourceSequence: event.sequence },
      now
    )
    await ports.finishTask(task.jobId, 'failed', { error: 'cancelled_by_mode_change' }, now)
    cancelled += 1
  }
  await ports.advanceWatermark(
    AFFECT_SEMANTIC_WORKER_NAME,
    AFFECT_SEMANTIC_WORKER_PROCESSOR,
    scannerWatermark,
    now
  )
  // 收拢完毕 ⇒ 最后记录切换边界（顺序见函数头注释）
  const cutoverAdvancedTo = await advanceCutover()
  return {
    kind: 'cancelled',
    scannerWatermark,
    workerWatermark,
    qualifiedInGap,
    cancelled,
    alreadyFinalized,
    skippedKeywordFinalized,
    skippedPreCutover,
    cutoverAdvancedTo,
  }
}
