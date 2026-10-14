/**
 * AffectSemanticScheduler —— M8.5 语义慢路径的**生产调度装配**（WP8）。
 *
 * ============================================================================
 *  它是什么
 * ============================================================================
 * 把 WP4–WP7 的 detached 组件接成一条生产链：
 *
 * ```text
 * completeTurn 之后（轮后槽位，非阻塞通知——计划 §8.1）
 *   → maybeRunAffectSemanticEvaluation（本文件；幂等、不抛）
 *     → runAffectSemanticWorkerTick（WP6 worker：发现→入队→模型→终态→水位）
 *       ├── callModel   = WP5 provider（原生 fetch、闭集错误、硬超时）
 *       └── commitOutcome = WP7 commit 端口（真放行口 + 事件/闸行同事务）
 * ```
 *
 * 模式（§4.2 单写入者——M85-D22）：
 * · `semantic` ⇒ 跑 tick；M8 词形路径由 main.ts 以 `suppressImpacts` 让位
 *   IMPACT（TOUCH/ORIGIN 照旧——结构性入口不动）。
 * · `rules` / `shadow` ⇒ tick 自身返回具名 no-op（零读零写）；`shadow` 的
 *   隔离采集面是 WP9/WP10 装配，**不在这里**偷偷跑。
 *
 * 回滚路径（§4.2"回滚是一项具名模式切换"）：模式切离 `semantic` 后，
 * 启动时用 `cancelAffectSemanticPendingSources` 把水位间隙里未终结的合格
 * source 收拢为 CANCELLED_BY_MODE_CHANGE 终态（不留悬空待办）。
 *
 * 纪律（与 M8 调度同源）：
 * · 失败不抛（调用方是"用户刚说完话"，聊天不被后台故障打断）；
 * · 每 Character 串行（并发守卫由 main.ts 持有——同一时刻至多一个 tick）；
 * · 模型调用不持事务（worker 内部短事务认领→调用→短事务终态）；
 * · trace 步只带计数与闭集码（`affectSemanticTraceStepsOf`——属性纪律）。
 */
import {
  asCharacterId,
  asJobId,
  type CharacterId,
  type ConversationEventId,
} from '../../kernel/contracts/index.ts'
import {
  AFFECT_SEMANTIC_CUTOVER_NAME,
  AFFECT_SEMANTIC_CUTOVER_PROCESSOR,
  AFFECT_SEMANTIC_SCANNER_PROCESSOR,
  AFFECT_SEMANTIC_WORKER_PROCESSOR,
  type AffectSemanticMode,
} from '../../kernel/contracts/affect-semantic.ts'
import {
  AFFECT_SEMANTIC_SCANNER_NAME,
  AFFECT_SEMANTIC_WORKER_NAME,
  AFFECT_SEMANTIC_TASK_TRIGGER_KIND,
  runAffectSemanticWorkerTick,
  cancelAffectSemanticPendingSources,
  type AffectSemanticCancellationSweep,
  type AffectSemanticWorkerPorts,
  type AffectSemanticWorkerTick,
  type AffectSemanticModelCallOutcome,
  affectSemanticTaskIdempotencyKey,
} from '../../kernel/app/affect/semantic-worker.ts'
import {
  createAffectSemanticCommitPort,
  type AffectSemanticEvidenceLookup,
} from '../../kernel/app/affect/semantic-commit.ts'
import { processorEventViewOf } from '../../kernel/app/memory/extractor.ts'
import { createFullDomainEventRegistry } from '../../kernel/contracts/domain-event.ts'
import { affectReducerV2For } from '../../kernel/projections/affect.ts'
import type { TraceStep } from '../../kernel/contracts/trace.ts'
import type { AffectSemanticProvider } from '../model/affect-semantic-provider.ts'
import {
  conversationEventsInRange,
  latestCharacterEventSequence,
} from '../persistence/conversation-store.ts'
import { applyAcceptedEvents, domainEventsFor } from '../persistence/event-store.ts'
import { getAffectProjection } from '../persistence/affect-store.ts'
import { AFFECT_IMPACT } from '../../kernel/contracts/domain-event.ts'
import {
  AFFECT_RULES_VERSION,
  type AffectImpactPayload,
} from '../../kernel/contracts/affect.ts'
import {
  advanceWatermark,
  enqueueJob,
  findJobByIdempotencyKey,
  finishJob,
  getWatermark,
  hasProcessedOperation,
  markJobRunning,
} from '../persistence/job-store.ts'
import type { RawDb } from '../persistence/db.ts'

/** 分页读账本的页大小（与 M8 调度同值） */
const PAGE_SIZE = 2000

// ---------------------------------------------------------------------------
// 端口工厂（真存储；形状与 WP6 门的生产装配段逐字段同源——门测的不是副本）
// ---------------------------------------------------------------------------

export interface AffectSemanticSchedulerAssembly {
  readonly characterId: CharacterId
  /** 角色别名（出站指令里的"谁是你"——WP4 冻结面） */
  readonly characterAlias: string
  /** 唯一 active user（M8-D11 口径） */
  readonly activeUserId: string
  readonly allowedUserIds?: readonly string[]
  /** WP5 provider（原生 fetch；装配层构造一次） */
  readonly provider: AffectSemanticProvider
}

export function createAffectSemanticWorkerPorts(
  db: RawDb,
  assembly: AffectSemanticSchedulerAssembly
): AffectSemanticWorkerPorts {
  const { characterId, activeUserId, provider } = assembly
  const evidence: AffectSemanticEvidenceLookup = {
    findEvents: async (ids) => {
      const wanted = new Set(ids.map((id) => String(id)))
      const events = await conversationEventsInRange(db, characterId, 1, 1_000_000, PAGE_SIZE)
      return events
        .filter((event) => wanted.has(String(event.id)))
        .map((event) => {
          const view = processorEventViewOf(event)
          return {
            id: event.id,
            characterId: event.characterId,
            sequence: event.sequence,
            type: view.type,
            trustedOrigin: view.trustedOrigin,
          }
        })
    },
  }
  const commitOutcome = createAffectSemanticCommitPort({
    allowedUserIds: assembly.allowedUserIds,
    characterId,
    activeUserId,
    registry: createFullDomainEventRegistry(),
    evidence,
    processed: { hasProcessed: (key: string) => hasProcessedOperation(db, key) },
    affect: {
      getAffectState: async (cid: CharacterId) => (await getAffectProjection(db, cid))?.state,
    },
    apply: async (accepted, extras, now) => {
      const applied = await applyAcceptedEvents(
        db,
        characterId,
        accepted,
        [affectReducerV2For(characterId)],
        now,
        { extraProcessedOperations: extras },
      )
      return {
        createdCount: applied.createdCount,
        deduplicatedCount: applied.deduplicatedCount,
        extraRecordedCount: applied.extraRecordedCount,
      }
    },
  })
  /*
   * §24 ③ 跨模式边界（WP11 补）：词形写入者已落 IMPACT 的 source 集合。
   * 判别 = AFFECT_IMPACT 事件 payload.ruleVersion === 'affect-rules@1'
   * （语义 IMPACT 的 ruleVersion 是 affect-semantic-policy@1——不会误伤）。
   * 事件与消费同事务落库 ⇒ durable，无崩溃窗口。
   */
  const keywordImpactedSourceIds = async (): Promise<ReadonlySet<string>> => {
    const events = await domainEventsFor(db, characterId)
    const ids = new Set<string>()
    for (const event of events) {
      if (event.type !== AFFECT_IMPACT) continue
      const payload = event.payload as Partial<AffectImpactPayload> | undefined
      if (payload?.ruleVersion !== AFFECT_RULES_VERSION) continue
      if (payload.sourceEventId !== undefined) ids.add(String(payload.sourceEventId))
    }
    return ids
  }
  return {
    characterAlias: assembly.characterAlias,
    latestSequence: (cid) => latestCharacterEventSequence(db, cid),
    loadEventsInRange: (cid, from, to) => conversationEventsInRange(db, cid, from, to, PAGE_SIZE),
    getAffectState: async (cid) => (await getAffectProjection(db, cid))?.state,
    hasProcessed: (key) => hasProcessedOperation(db, key),
    keywordImpactedSourceIds,
    getWatermark: async (processor, version) =>
      (await getWatermark(db, characterId, processor, version))?.processedThroughSequence,
    advanceWatermark: async (processor, version, through, now) => {
      await advanceWatermark(db, characterId, processor, version, through, now)
    },
    enqueueTask: async (source, now) => {
      const key = affectSemanticTaskIdempotencyKey(source.sourceEventId)
      // 重试间隔对**上一次尝试**计时：入队前先读旧行 createdAt（WP6 冻结语义）
      const existing = await findJobByIdempotencyKey(db, key)
      const result = await enqueueJob(db, {
        characterId,
        processor: AFFECT_SEMANTIC_WORKER_NAME,
        processorVersion: AFFECT_SEMANTIC_WORKER_PROCESSOR,
        sourceFromSequence: source.sourceSequence,
        sourceToSequence: source.sourceSequence,
        idempotencyKey: key,
        triggerKind: AFFECT_SEMANTIC_TASK_TRIGGER_KIND,
        now,
      })
      return {
        jobId: String(result.job.id),
        created: result.created,
        retryCount: result.job.retryCount,
        lastAttemptAt: existing?.createdAt ?? result.job.createdAt,
      }
    },
    markTaskRunning: async (jobId, now) => {
      await markJobRunning(db, asJobId(jobId), now)
    },
    finishTask: async (jobId, status, opts, now) => {
      await finishJob(db, asJobId(jobId), status, { error: opts?.error, now })
    },
    commitOutcome,
    callModel: async (
      outboundText: string,
      signal?: AbortSignal
    ): Promise<AffectSemanticModelCallOutcome> =>
      provider.call({ outboundText, signal }),
  }
}

// ---------------------------------------------------------------------------
// 激活就绪闸（注册级前提——WP13 之前语义面在真实库上保持休眠）
// ---------------------------------------------------------------------------

/**
 * 语义模式能否**真正**在这条链上运行（启动时问一次；进程内注册不变 ⇒ 稳定）。
 *
 * 两个前提，缺一不可：
 * ① 情绪链已建档（语义 worker 读 cutover/资格——未建档时 tick 本就 no-op）；
 * ② 投影行盖的是 **@2 章**——语义 IMPACT 的 SOURCE_ANCHORED 折叠只在 @2
 *    reducer 里存在，而 event-store 的版本守卫禁止在 @1 行上做任何 @2 写入。
 *    @2 章 = WP13 激活段的受控 rebuild 盖的章。
 *
 * 为什么要有这道闸（WP8 设计裁定，进交接单）：没有它，WP13 之前把
 * `CHARACTER_AFFECT_SEMANTIC_MODE=semantic` 设上会得到**坏中间态**——
 * 词形 IMPACT 已被让位、语义 IMPACT 却被版本守卫全部拒绝 ⇒ 情绪 valence
 * 冻结、无人写入。闸让这个状态不可能出现：未激活 ⇒ 装配层**不让位**
 * （M8 全路径照常）+ 语义 worker 不跑 + 一次性告警。这是启动前提的
 * **失败关闭**（确定性判据：注册状态），不是运行时自动回落（M85-D01
 * 禁的是"模型失败 ⇒ 偷偷回词形"——两回事）。
 */
export async function affectSemanticActivationReady(
  db: RawDb,
  characterId: CharacterId | string
): Promise<{ ready: boolean; reducerVersion: string | undefined; reason: string }> {
  const cid =
    typeof characterId === 'string' ? asCharacterId(characterId) : characterId
  const projection = await getAffectProjection(db, cid)
  if (projection === undefined || !projection.state.originated) {
    return {
      ready: false,
      reducerVersion: projection?.reducerVersion,
      reason: '情绪链未建档（affect 投影不存在或未 originated）',
    }
  }
  if (projection.reducerVersion !== 'affect-reducer@2') {
    return {
      ready: false,
      reducerVersion: projection.reducerVersion,
      reason: `affect 投影行是 ${projection.reducerVersion}——语义模式需要 @2 章（WP13 激活段的受控 rebuild）`,
    }
  }
  return { ready: true, reducerVersion: projection.reducerVersion, reason: 'affect-reducer@2 已注册' }
}

// ---------------------------------------------------------------------------
// 调度入口（幂等、不抛；模式面由 worker 自持——rules/shadow = 具名 no-op）
// ---------------------------------------------------------------------------

export async function maybeRunAffectSemanticEvaluation(
  db: RawDb,
  input: {
    characterId: CharacterId | string
    characterAlias: string
    activeUserId: string
    allowedUserIds?: readonly string[]
    mode: AffectSemanticMode
    provider: AffectSemanticProvider
    /** shutdown 信号（透传模型调用；中止 ⇒ 传输失败 ⇒ 可重试路径） */
    signal?: AbortSignal
    now?: number
  }
): Promise<AffectSemanticWorkerTick> {
  const characterId =
    typeof input.characterId === 'string' ? asCharacterId(input.characterId) : input.characterId
  const ports = createAffectSemanticWorkerPorts(db, {
    allowedUserIds: input.allowedUserIds,
    characterId,
    characterAlias: input.characterAlias,
    activeUserId: input.activeUserId,
    provider: input.provider,
  })
  /*
   * 失败不抛的分工：worker tick 自身失败关闭进计数（WP6 纪律——不抛）；
   * 装配层的意外（如进程收尾时库已关的竞态）**向上传播**，由调用方的
   * drain 兜底接住记日志——不在这里冒充任何具名结局（"没成功就没成功
   * 口吻"：一个 mode_not_semantic 壳子里藏 assemblyError 是撒谎）。
   */
  return await runAffectSemanticWorkerTick(ports, {
    allowedUserIds: input.allowedUserIds,
    characterId,
    activeUserId: input.activeUserId,
    mode: input.mode,
    now: input.now,
    signal: input.signal,
  })
}

/** 模式切换取消扫面的装配入口（回滚路径；启动追赶时模式 ≠ semantic 用） */
export async function cancelPendingAffectSemanticSources(
  db: RawDb,
  input: {
    characterId: CharacterId | string
    characterAlias: string
    activeUserId: string
    provider: AffectSemanticProvider
    now?: number
  }
): Promise<AffectSemanticCancellationSweep> {
  const characterId =
    typeof input.characterId === 'string' ? asCharacterId(input.characterId) : input.characterId
  const ports = createAffectSemanticWorkerPorts(db, {
    characterId,
    characterAlias: input.characterAlias,
    activeUserId: input.activeUserId,
    provider: input.provider,
  })
  // 扫面自身幂等不抛（worker 同纪律）；装配层意外同上向上传播。
  return await cancelAffectSemanticPendingSources(ports, {
    characterId,
    activeUserId: input.activeUserId,
    now: input.now,
  })
}

/**
 * 激活程序的切换边界记录（§22.2）：把 `semanticCutoverSequence` 置为当前
 * 账本尾（只进不退）。受控 rebuild（@2 章）之后、首个 semantic 启动之前调用
 * ——激活时刻之前的全部来源从此永不语义重评（M8-D05 同构）。
 *
 * 激活 ADR 另行记录文档值（§22.2 的审计面）；本函数是机器面。WP11 副本演练
 * 与 WP13 生产激活共用。
 */
export async function markAffectSemanticCutover(
  db: RawDb,
  characterId: CharacterId | string,
  now: number = Date.now()
): Promise<{ cutoverSequence: number }> {
  const cid =
    typeof characterId === 'string' ? asCharacterId(characterId) : characterId
  const latest = await latestCharacterEventSequence(db, cid)
  if (latest > 0) {
    await advanceWatermark(db, cid, AFFECT_SEMANTIC_CUTOVER_NAME, AFFECT_SEMANTIC_CUTOVER_PROCESSOR, latest, now)
  }
  return { cutoverSequence: latest }
}

// ---------------------------------------------------------------------------
// tick → trace 步（WP1 冻结的四步；属性纪律：只有计数与闭集码）
// ---------------------------------------------------------------------------

/**
 * 把一次 tick 的结局映射成 `affect_semantic_*` 四步（计划 §15 WP1 冻结名）。
 *
 * 只在 `kind === 'ran'` 时产出步骤：no-op 结局（mode_not_semantic / no_tail /
 * not_originated）不追加——`rules`/`shadow` 的轮次 trace 不因此变长。
 * 装配层负责落库（`gateway.appendPostTurnStep`）；本函数纯映射，可单测。
 */
export function affectSemanticTraceStepsOf(
  tick: AffectSemanticWorkerTick,
  startedAt: number
): TraceStep[] {
  if (tick.kind !== 'ran') return []
  const finishedAt = Date.now()
  const base = { startedAt, finishedAt, status: 'ok' as const }
  const transportFailureEntries = Object.entries(tick.transportFailures).filter(
    ([, count]) => (count ?? 0) > 0,
  )
  const parseFailureEntries = Object.entries(tick.parseFailures).filter(([, count]) => count > 0)
  const terminalCount =
    tick.terminalFailed + tick.expiredAtProcess + tick.sourceInvalidated + tick.retryExhausted
  return [
    {
      ...base,
      kind: 'affect_semantic_discovered',
      label:
        `语义扫描：${String(tick.scanned)} 条（不合格 ${String(tick.skippedNotUserMessage + tick.skippedUnqualified)} · ` +
        `过期 ${String(tick.expiredAtScan)} · 已终结 ${String(tick.alreadyFinalized)} · ` +
        `词形已终结 ${String(tick.skippedKeywordFinalized)} · 边界前 ${String(tick.skippedPreCutover)} · ` +
        `入队 ${String(tick.enqueued)}）` +
        ` · 水位 ${String(tick.scannerWatermark)}→${String(tick.workerWatermark)}`,
      attributes: {
        scanned: tick.scanned,
        skipped_not_user_message: tick.skippedNotUserMessage,
        skipped_unqualified: tick.skippedUnqualified,
        expired_at_scan: tick.expiredAtScan,
        already_finalized: tick.alreadyFinalized,
        skipped_keyword_finalized: tick.skippedKeywordFinalized,
        skipped_pre_cutover: tick.skippedPreCutover,
        enqueued: tick.enqueued,
        scanner_watermark: tick.scannerWatermark,
        worker_watermark: tick.workerWatermark,
      },
    },
    {
      ...base,
      kind: 'affect_semantic_dispatched',
      label:
        `语义出站：模型 ${String(tick.modelCalls)} 次` +
        (transportFailureEntries.length > 0
          ? ` · 传输失败 ${transportFailureEntries.map(([code, n]) => `${code}:${String(n)}`).join(',')}`
          : '') +
        (parseFailureEntries.length > 0
          ? ` · 解析失败 ${parseFailureEntries.map(([code, n]) => `${code}:${String(n)}`).join(',')}`
          : '') +
        (tick.budgetExceeded > 0 ? ` · 预算超限 ${String(tick.budgetExceeded)}` : ''),
      attributes: {
        model_calls: tick.modelCalls,
        transport_failures: transportFailureEntries
          .map(([code, n]) => `${code}:${String(n)}`)
          .join(','),
        parse_failures: parseFailureEntries.map(([code, n]) => `${code}:${String(n)}`).join(','),
        budget_exceeded: tick.budgetExceeded,
      },
    },
    {
      ...base,
      kind: 'affect_semantic_result',
      label:
        `语义结果：处理 ${String(tick.processed)}（committed ${String(tick.committed)} · ` +
        `no_impact ${String(tick.noImpact)} · 放行口拒绝 ${String(tick.rejectedByValidator)} · ` +
        `延后重试 ${String(tick.retryableDeferred)}）`,
      attributes: {
        processed: tick.processed,
        committed: tick.committed,
        no_impact: tick.noImpact,
        rejected_by_validator: tick.rejectedByValidator,
        retryable_deferred: tick.retryableDeferred,
      },
    },
    {
      ...base,
      kind: 'affect_semantic_terminal',
      label:
        terminalCount > 0
          ? `语义终态：TERMINAL_FAILED ${String(tick.terminalFailed)} · EXPIRED ${String(tick.expiredAtProcess)} · ` +
            `来源失效 ${String(tick.sourceInvalidated)} · 重试烧尽 ${String(tick.retryExhausted)}`
          : '语义终态：无异常终结',
      attributes: {
        terminal_failed: tick.terminalFailed,
        expired_at_process: tick.expiredAtProcess,
        source_invalidated: tick.sourceInvalidated,
        retry_exhausted: tick.retryExhausted,
      },
    },
  ]
}

/** 一行式摘要（启动追赶/轮后日志——"这次语义面发生了什么"一眼可见） */
export function describeAffectSemanticTick(tick: AffectSemanticWorkerTick): string {
  if (tick.kind === 'mode_not_semantic') return `模式 ${tick.mode} ⇒ no-op`
  if (tick.kind === 'not_originated') return '未建档 ⇒ no-op'
  if (tick.kind === 'no_tail') {
    return `无尾窗（scanner=${String(tick.scannerWatermark)} latest=${String(tick.latest)}）`
  }
  return (
    `扫描 ${String(tick.scanned)}（入队 ${String(tick.enqueued)} · 词形已终结 ${String(tick.skippedKeywordFinalized)} · ` +
    `边界前 ${String(tick.skippedPreCutover)}）· ` +
    `处理 ${String(tick.processed)}（committed ${String(tick.committed)} · no_impact ${String(tick.noImpact)} · ` +
    `拒绝 ${String(tick.rejectedByValidator)}）· 模型 ${String(tick.modelCalls)} 次 · ` +
    `水位 ${String(tick.scannerWatermark)}/${String(tick.workerWatermark)}`
  )
}

/** 扫面结局的一行式摘要（回滚日志） */
export function describeAffectSemanticSweep(sweep: AffectSemanticCancellationSweep): string {
  if (sweep.kind === 'no_pending') {
    return `无待办（scanner=${String(sweep.scannerWatermark)} worker=${String(sweep.workerWatermark)}）`
  }
  return (
    `取消 ${String(sweep.cancelled)}（间隙合格 ${String(sweep.qualifiedInGap)} · ` +
    `此前已终结 ${String(sweep.alreadyFinalized)} · 词形已终结 ${String(sweep.skippedKeywordFinalized)} · ` +
    `边界前 ${String(sweep.skippedPreCutover)}）` +
    `· 水位推进到 ${String(sweep.scannerWatermark)} · 切换边界 → ${String(sweep.cutoverAdvancedTo)}`
  )
}
