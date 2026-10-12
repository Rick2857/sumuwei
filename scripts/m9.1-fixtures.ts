/**
 * M9.1 夹具库（WP2）—— R/P 矩阵量具的共享底座。
 *
 * ============================================================================
 *  这是什么
 * ============================================================================
 * [ADR-072](../docs/adr/ADR-072-m9.1-restatement-revival-and-withdrawn-masking.md)
 * 与 [验收契约](../docs/m9.1/M9.1-Acceptance-Contract.md) 冻结的量具共享件：
 *
 *   · `openScenario()`        —— 每场景独立隔离库 + 生产同形装配（turn 端口单次执行）
 *   · 四层分歧检测器           —— F-4 的响应真话 oracle（纯函数）
 *   · 泄漏检测器               —— F-1 的最终 prompt oracle（纯函数）
 *   · 撤销集纯核 + 薄读        —— D16/D17 的参考语义（WP4 生产端口的对照实现）
 *   · 重放分歧检测器           —— R07/R08 的 A==B oracle（纯函数）
 *
 * ⚠️ 量具纪律（AGENTS §6.2/6.7）：检测器必须经「正控安静 / 负控必响 / 恢复再安静」
 *    三段式验证（`pnpm m9.1:measurement:verify`）；计数型检测器自检 `measured_count > 0`。
 *    本库只放**可复用**件；每个门的场景编排放各自 `scripts/m9.1-*.ts`。
 */
import 'dotenv/config'

import { applyAcceptedEvents } from '../src/infrastructure/persistence/event-store.ts'
import { domainEventsForMemory } from '../src/infrastructure/persistence/memory-store.ts'
import type { MemoryRebuildResult } from '../src/infrastructure/persistence/memory-store.ts'
import { memoryIntegrityProblems } from '../src/infrastructure/persistence/memory-integrity.ts'
import { rootReadingsByMemory } from '../src/infrastructure/persistence/qualification-read.ts'
import { createMemoryRetrievalStore } from '../src/infrastructure/persistence/memory-retrieval-store.ts'
import { createMemoryRecallService } from '../src/kernel/app/recall/retrieval.ts'
import { createRecallTurnPort } from '../src/kernel/app/recall/turn.ts'
import {
  createExplicitMemoryService,
  type ExplicitMemoryOutcome,
  type ExplicitMemoryService,
} from '../src/kernel/app/memory/explicit-service.ts'
import { createExplicitMemoryTurnPort, type ExplicitMemoryTurnResult } from '../src/kernel/app/memory/explicit-turn.ts'
import { createRuleOnlyContentExtractor } from '../src/kernel/app/memory/content-extractor.ts'
import { createTargetMemoryResolver, LexicalSemanticJudge } from '../src/kernel/app/memory/target-resolver.ts'
import { createRecallRequest } from '../src/kernel/contracts/recall.ts'
import { DEFAULT_CONTEXT_BUDGET } from '../src/kernel/recall/selector.ts'
import type { EvidenceRef, MemoryRecord } from '../src/kernel/contracts/memory.ts'
import { conversationEvidence, createMemoryCandidate } from '../src/kernel/contracts/memory.ts'
import { entityRef } from '../src/kernel/contracts/entity.ts'
import { asCharacterId, newTraceId } from '../src/kernel/contracts/ids.ts'
import { createM4Harness, M4_T0, type M4Harness } from './m4-harness.ts'
import type { MemoryMutationValidator } from '../src/kernel/policies/memory-validator.ts'
import type { MemoryCandidate } from '../src/kernel/contracts/memory.ts'
import type { DomainEvent } from '../src/kernel/contracts/domain-event.ts'
import type { AcceptedDomainEvent } from '../src/kernel/policies/validator.ts'

// ---------------------------------------------------------------------------
// 场景装配（与 WP0 基线量具同一形状；每场景独立隔离库）
// ---------------------------------------------------------------------------

export interface Rig {
  h: M4Harness
  /** 本 rig 的 validator（含 getRecord + features 开关——与 main.ts 生产装配同形） */
  validator: MemoryMutationValidator
  /** 显式记忆服务本体（R05 同事件重放等低层场景用） */
  service: ExplicitMemoryService
  /**
   * 用**真实规则抽取器**构造候选（与 explicit-service 的 buildCandidate 逐字段同形：
   * 证据=conversationEvidence(eventId)、authority=EXPLICIT_USER_STATEMENT、
   * importance=0.8、epistemicStatus=reported、processor=explicit-memory@1）。
   * R05②/R06/R07 需要 validator 级驱动（绕开服务的同步 validate→commit→fold），
   * 候选形状必须与生产一致，否则测的是另一个东西。
   */
  candidateFor(text: string, eventId: string): Promise<MemoryCandidate>
  /** 提交已放行事件并折叠（runMutation 第 2/3 步的同形实现） */
  commitAccepted(accepted: readonly AcceptedDomainEvent[], now?: number): Promise<DomainEvent[]>
  /** 走生产 turn 端口处理一句话（单次执行；outcome 用包装捕获） */
  say(text: string): Promise<{ turn?: ExplicitMemoryTurnResult; outcome?: ExplicitMemoryOutcome; eventId: string }>
  /** 召回（L3 资格面） */
  recall(query: string): Promise<{ selected: string[]; candidates: number; eligible: number }>
  /** 某记忆的事件序（L1 事件面） */
  trail(id: string): Promise<{ types: string[]; created: number }>
  dispose(): Promise<void>
}

export interface RigOptions {
  /** D12 复活发射闸（缺省 false = off 模式；契约 §0 的开关矩阵） */
  restatementRevival?: boolean
  /**
   * R11 失败注入（服务构造期注入，只影响本 rig；隔离库内合法）：
   *   · failCommitEvents —— commitEvents 抛错（提交失败）
   *   · failFold         —— 折叠抛错（事件已落库、投影失败）
   */
  failCommitEvents?: boolean
  failFold?: boolean
}

export async function openScenario(label: string, options: RigOptions = {}): Promise<Rig> {
  const { isolateDatabase, resetPluginSqlConnection } = await import('../src/dev/sandbox.ts')
  await resetPluginSqlConnection()
  isolateDatabase(`m9.1-${label}`, { keep: false })
  const h = await createM4Harness({ label: `m91-${label}` })
  const { owner, user, db, store } = h

  /*
   * 本地 validator（与 main.ts 生产装配同形：含 getRecord + features 开关）。
   * 不复用 h.validator —— 那个没有 getRecord（去重第二层确定性半边与复活
   * 发射都不生效），而 m4-harness.ts 是跨里程碑共享的验收装配，不在 M9.1 动它。
   */
  const { createMemoryMutationValidator } = await import('../src/kernel/policies/memory-validator.ts')
  const { findEventRefs } = await import('../src/infrastructure/persistence/conversation-store.ts')
  const { hasProcessedOperation } = await import('../src/infrastructure/persistence/job-store.ts')
  const validator = createMemoryMutationValidator({
    registry: h.kernel.registry,
    sources: { findEvents: (ids) => findEventRefs(db, ids as never) },
    processed: { hasProcessed: (key) => hasProcessedOperation(db, key) },
    lookup: {
      findActiveByFingerprint: async (input) => {
        const found = await store.getActiveByFingerprint(input.owner, input.fingerprint)
        return found === null ? undefined : { memoryId: found.id }
      },
      findActiveByCanonicalKey: async (input) =>
        (await store.getActiveByCanonicalKey(input.canonicalKey)).map((r) => ({
          memoryId: r.id,
        })),
      getRecord: async (id) => (await store.get(id)) ?? undefined,
    },
    features: { restatementRevivalEnabled: options.restatementRevival === true },
  })

  const resolver = createTargetMemoryResolver({
    get: (id) => store.get(id),
    getActiveByCanonicalKey: (key) => store.getActiveByCanonicalKey(key),
    listBySubject: (o, s) => store.listBySubject(o, s),
    semanticJudge: new LexicalSemanticJudge(),
  })
  const service = createExplicitMemoryService({
    store:
      options.failFold === true
        ? {
            apply: async () => {
              throw new Error('R11 注入：折叠失败（事件已落库）')
            },
          }
        : store,
    validator,
    extractor: createRuleOnlyContentExtractor(),
    resolveTarget: (input) =>
      resolver.resolve({
        owner: input.owner,
        text: input.text,
        ...(input.canonicalKey !== undefined ? { canonicalKey: input.canonicalKey } : {}),
        ...(input.subject !== undefined ? { subject: input.subject } : {}),
        ...(input.hints !== undefined ? { hints: input.hints } : {}),
      }),
    commitEvents:
      options.failCommitEvents === true
        ? async () => {
            throw new Error('R11 注入：提交失败')
          }
        : async (accepted, now) =>
            (await applyAcceptedEvents(db, h.characterId as never, accepted, [], now)).domainEvents,
    conflict: {
      recordsInCanonicalSlot: async ({ canonicalKey }) => {
        const active = await store.getActiveByCanonicalKey(canonicalKey)
        const disputed = (await store.list({ owner, status: 'disputed', limit: 500 })).filter(
          (record) => record.canonicalKey === canonicalKey
        )
        return [...active, ...disputed]
      },
    },
  })

  /* 服务层 outcome 捕获：每句话只经 turn 端口执行一次（契约 §0 通用约定） */
  const captured: { outcome?: ExplicitMemoryOutcome } = {}
  const capturingService: ExplicitMemoryService = {
    remember: (request) => service.remember(request),
    correct: (request) => service.correct(request),
    forget: (request) => service.forget(request),
    dispute: (request) => service.dispute(request),
    handle: async (request) => {
      const outcome = await service.handle(request)
      captured.outcome = outcome
      return outcome
    },
  }
  const turnPort = createExplicitMemoryTurnPort({ service: capturingService })

  const recallPort = createRecallTurnPort({
    service: createMemoryRecallService({
      port: createMemoryRetrievalStore({
        store,
        integrity: (o) => memoryIntegrityProblems(db, o),
        rootReadings: (ids) => rootReadingsByMemory(db, ids),
      }),
    }),
    budget: DEFAULT_CONTEXT_BUDGET,
    now: () => M4_T0 + 20_000,
  })

  return {
    h,
    validator,
    service,
    async candidateFor(text, eventId) {
      const extracted = await createRuleOnlyContentExtractor().extract({
        text,
        owner,
        speaker: user,
      })
      if (extracted === undefined) throw new Error(`candidateFor：规则抽取器没能解析「${text}」`)
      const evidence = conversationEvidence(eventId)
      return createMemoryCandidate({
        owner,
        type: extracted.type,
        content: extracted.content,
        subjects: extracted.subjects,
        sourceRefs: [evidence],
        evidenceRootIds: [evidence.id],
        epistemicStatus: 'reported',
        authority: 'EXPLICIT_USER_STATEMENT',
        importance: 0.8,
        confidence: extracted.confidence,
        processor: 'explicit-memory',
        processorVersion: 'explicit-memory@1',
      })
    },
    async commitAccepted(accepted, now) {
      const events = (
        await applyAcceptedEvents(db, h.characterId as never, accepted, [], now ?? Date.now())
      ).domainEvents
      for (const event of events) {
        await store.apply(event)
      }
      return events
    },
    async say(text) {
      captured.outcome = undefined
      const recorded = await h.recordUserEvidence(text)
      const turn = await turnPort.handleTurn({
        owner,
        speaker: user,
        event: { id: recorded.ref.id as never, actorType: 'user', content: text },
      })
      return { turn, outcome: captured.outcome, eventId: recorded.ref.id }
    },
    async recall(query) {
      const outcome = await recallPort.run(
        createRecallRequest({
          traceId: newTraceId(),
          characterId: asCharacterId(h.characterId),
          user: entityRef('user', String(user.id)),
          query: { text: query, source: 'user_message' },
          intent: 'current_fact',
          contextBudget: { memoryTokens: DEFAULT_CONTEXT_BUDGET.memoryTokens },
        })
      )
      return {
        selected: outcome.record.selectedIds.map(String),
        candidates: outcome.record.metrics.candidateCount,
        eligible: outcome.record.metrics.eligibleCount,
      }
    },
    async trail(id) {
      const events = await domainEventsForMemory(db, id as never)
      return {
        types: events.map((e) => e.type.replace('MEMORY_', '')),
        created: events.filter((e) => e.type === 'MEMORY_CREATED').length,
      }
    },
    async dispose() {
      await h.stop()
    },
  }
}

// ---------------------------------------------------------------------------
// F-4 四层分歧检测器（纯函数；契约 §1 各行的 L1–L4 oracle）
// ---------------------------------------------------------------------------

export interface FourLayerReadings {
  /** L4 服务层：outcome.ok */
  outcomeOk: boolean
  /** L2 投影层：折叠后的记录状态（记录不存在 = undefined） */
  foldedStatus: string | undefined
  /** L3 资格层：该记忆当前可召回 */
  recallable: boolean
  /** L4 翻译层：turn.kind */
  turnKind: string | undefined
}

/** 检出「报成功但认知未修改」类分歧；空数组 = 四层一致 */
export function detectResponseTruthDivergence(r: FourLayerReadings): string[] {
  const problems: string[] = []
  if (r.outcomeOk && r.foldedStatus !== undefined && r.foldedStatus !== 'active') {
    problems.push(`false_success: ok=true 但折叠状态=${String(r.foldedStatus)}（INV-CI-13）`)
  }
  if (r.outcomeOk && r.foldedStatus === 'active' && !r.recallable) {
    problems.push('active_not_recallable: 投影 active 但资格层不可召回（层间矛盾）')
  }
  if (r.turnKind === 'written' && !(r.outcomeOk && r.foldedStatus === 'active')) {
    problems.push('written_without_effective_write: turn=written 但无有效写入（假成功口吻）')
  }
  return problems
}

// ---------------------------------------------------------------------------
// F-1 泄漏检测器（纯函数；契约 §2 各行的 L5 oracle）
// ---------------------------------------------------------------------------

/** 检出最终 prompt 中出现的被撤取值；空数组 = 无泄漏 */
export function detectWithdrawnLeak(packetText: string, withdrawnValues: readonly string[]): string[] {
  return withdrawnValues.filter((value) => packetText.includes(value))
}

// ---------------------------------------------------------------------------
// 撤销集（D16/D17）：语义权威已上移到 contracts（WP4 生产端口与量具共用同一份）
// ---------------------------------------------------------------------------

export type {
  WithdrawnReason,
  WithdrawnSetResult,
  WithdrawnRecordInput,
  SupersededBySlot,
} from '../src/kernel/contracts/withdrawn-evidence.ts'
export {
  WITHDRAWN_CHAIN_LIMIT,
  withdrawnSetCore,
} from '../src/kernel/contracts/withdrawn-evidence.ts'
import type { WithdrawnReason, WithdrawnSetResult } from '../src/kernel/contracts/withdrawn-evidence.ts'

// ---------------------------------------------------------------------------
// 重放分歧检测器（纯函数；R07/R08 的 A==B oracle）
// ---------------------------------------------------------------------------

/** 检出在线折叠与从零重放、或与预期状态之间的分歧；空数组 = 一致 */
export function detectReplayDivergence(result: MemoryRebuildResult, expectedStatus?: string): string[] {
  const problems: string[] = []
  if (!result.equal) problems.push(`rebuild_not_equal: ${result.differences.join(',')}`)
  const afterStatus = result.after === null ? '(null)' : String(result.after.status)
  if (expectedStatus !== undefined && afterStatus !== expectedStatus) {
    problems.push(`status_mismatch: rebuild=${afterStatus} expected=${expectedStatus}`)
  }
  return problems
}

// ---------------------------------------------------------------------------
// 撤销集薄读（真实 DB → 纯核输入）
// ---------------------------------------------------------------------------

/**
 * 读取 retracted 记录的撤回原因（原因只在 MEMORY_RETRACTED 事件 payload——WP0 实测）。
 * 保留为独立导出：单记录诊断用；**集合语义请走 computeWithdrawnSet**（它委托
 * 生产端口，保证量具与生产同一读取路径——含 P08 的「撤回时来源」事件面路径）。
 */
export async function retractionReasonOf(h: M4Harness, memoryId: string): Promise<WithdrawnReason | undefined> {
  const events = await domainEventsForMemory(h.db, memoryId as never)
  const retraction = [...events].reverse().find((e) => e.type === 'MEMORY_RETRACTED')
  if (retraction === undefined) return undefined
  return (retraction.payload as { reason?: WithdrawnReason }).reason
}

/** 真实 DB 上的撤销集计算：**委托生产端口**（D16 单一事实源——量具与生产同语义） */
export async function computeWithdrawnSet(h: M4Harness): Promise<WithdrawnSetResult> {
  const { computeWithdrawnEvidence } = await import(
    '../src/infrastructure/persistence/withdrawn-evidence.ts'
  )
  return computeWithdrawnEvidence(h.db, h.store, h.owner)
}

/** 记录 → 四层读数（供检测器；recall 结果由调用方给出） */
export function fourLayerReadingsOf(
  outcome: ExplicitMemoryOutcome | undefined,
  record: MemoryRecord | undefined,
  recallSelected: readonly string[]
): FourLayerReadings {
  const memoryId = outcome?.ok ? String(outcome.memoryId) : undefined
  return {
    outcomeOk: outcome?.ok === true,
    foldedStatus: record === undefined ? undefined : String(record.status),
    recallable: memoryId !== undefined && recallSelected.includes(memoryId),
    turnKind: undefined,
  }
}
