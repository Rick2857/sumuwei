/**
 * M4 验收脚本的**共享装配**。
 *
 * ============================================================================
 *  为什么要有这个文件（而不是每个脚本各抄一遍）
 * ============================================================================
 * M4 的验收脚本（restore / isolation / scale / hardkill）都需要同一套东西：
 *
 *     完整内核（含 MEMORY_* registry）+ MemoryStore + 放行口 + 真实账本写入器
 *
 * 抄四遍的代价不是"多打几个字"，而是**四份装配会漂移** ——
 * 某一份忘了传 `registry`，它测出来的就是另一个系统
 * （M4-verification §5.6 缺口② 正是这么发生的：生产内核没注册 MEMORY_*）。
 *
 * 因此装配**只写一遍**，且**照抄生产装配**（`src/main.ts` 的 buildKernel / buildGateway）：
 * registry 是全集、幂等口接 `processed_operations`、去重口接 store 的真实查询。
 *
 * ---------------------------------------------------------------------------
 *  它**不是**生产代码
 * ---------------------------------------------------------------------------
 * 只被 `scripts/verify-m4-*.ts` 引用。生产装配仍然是 `src/main.ts`，
 * 本文件不导出任何东西给 `src/`。
 */

import { createHash } from 'node:crypto'

import { AgentRuntime, stringToUuid, type Character, type Plugin } from '@elizaos/core'
import sqlPlugin from '@elizaos/plugin-sql'
import openaiPlugin from '@elizaos/plugin-openai'
import bootstrapPlugin from '@elizaos/plugin-bootstrap'
import { sql } from 'drizzle-orm'

import { character } from '../src/character/index.ts'
import { initDatabase } from '../src/db/index.ts'
import { getRawDb, rowsOf } from '../src/infrastructure/persistence/db.ts'
import { initKernel } from '../src/kernel/app/kernel.ts'
import { createPersistentCharacterPlugin } from '../src/plugin/persistent-character.ts'
import { openAiCompatiblePlugin } from '../src/providers/openai-compatible.ts'
import { characterDefinitionFromCharacter } from '../src/infrastructure/runtime/seed-projection.ts'
import { findEventRefs } from '../src/infrastructure/persistence/conversation-store.ts'
import { ConversationRecorder } from '../src/infrastructure/runtime/conversation-recorder.ts'
import { applyAcceptedEvents } from '../src/infrastructure/persistence/event-store.ts'
import {
  applyMemoryEvent,
  createNativeMemoryStore,
  memoryCounts,
  type MemoryStorePort,
} from '../src/infrastructure/persistence/memory-store.ts'
import { createMemoryMutationValidator } from '../src/kernel/policies/memory-validator.ts'
import {
  asConversationId,
  createFullDomainEventRegistry,
  createMemoryCandidate,
  entityRef,
  type ConversationEvent,
  type EntityRef,
  type MemoryCandidate,
  type MemoryRecord,
  type NewMemoryCandidate,
} from '../src/kernel/contracts/index.ts'
import {
  createCharacterAssistantTurnIngress,
  createHumanConsoleUserTurnIngress,
  type ConversationAttributionProducer,
} from '../src/infrastructure/runtime/conversation-attribution.ts'

// ---------------------------------------------------------------------------
// 检查器
// ---------------------------------------------------------------------------

export interface Reporter {
  check: (label: string, condition: boolean, detail?: string) => void
  section: (title: string) => void
  readonly passed: number
  readonly failed: number
  readonly failures: readonly string[]
  finish: (title: string) => never
}

export function createReporter(): Reporter {
  let passed = 0
  let failed = 0
  const failures: string[] = []

  return {
    check(label, condition, detail = '') {
      if (condition) {
        passed += 1
        console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ''}`)
      } else {
        failed += 1
        failures.push(label)
        console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`)
      }
    },
    section(title) {
      console.log(`\n=== ${title} ===`)
    },
    get passed() {
      return passed
    },
    get failed() {
      return failed
    },
    get failures() {
      return failures
    },
    finish(title) {
      console.log(`\n${'='.repeat(72)}`)
      console.log(`${title}：${passed} 通过 / ${failed} 失败`)
      if (failures.length > 0) console.log(`失败项：${failures.join(' | ')}`)
      console.log('='.repeat(72))
      process.exit(failed === 0 ? 0 : 1)
    },
  }
}

// ---------------------------------------------------------------------------
// 规范化快照（附录第 39 / 40 节：CanonicalSemanticSnapshot）
// ---------------------------------------------------------------------------

/**
 * 稳定序列化：对象键排序，数组保序。
 *
 * 只包含**有角色意义**的数据；`updatedAt` / 运行期临时时间戳等非语义字段
 * 不进快照，否则 Replay / Restore 会因为"重算的那一秒不同"产生假失败
 * （附件第 40 节明确要求过滤这些字段）。
 */
export function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort()) out[key] = stableValue(source[key])
    return out
  }
  // `undefined` 与 `null` 在契约里是**两个不同状态**，必须可区分
  return value === undefined ? '__undefined__' : value
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(stableValue(value))
}

/** `validUntil` 的三态（undefined / null / number）不能压成两种 */
export function encodeValidUntil(value: number | null | undefined): string {
  if (value === undefined) return '__undefined__'
  if (value === null) return '__null__'
  return String(value)
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

export interface CanonicalEntry {
  logicalId: string
  owner: string
  type: string
  status: string
  authority: string
  epistemicStatus: string
  canonicalKey: string | null
  contentFingerprint: string
  normalizedContent: unknown
  importance: number
  confidence: number
  validFrom: number | null
  validUntil: string
  occurredAt: number | null
  recordedAt: number
  supersededBy: string | null
  revision: number
  /** 它取代了谁（revision 链的一侧） */
  revisionEdges: string[]
  subjects: string[]
  sourceRefs: string[]
  evidenceRootIds: string[]
}

export function toCanonicalEntry(record: MemoryRecord): CanonicalEntry {
  return {
    logicalId: String(record.id),
    owner: `${record.owner.kind}:${String(record.owner.id)}`,
    type: record.type,
    status: record.status,
    authority: record.authority,
    epistemicStatus: record.epistemicStatus,
    canonicalKey: record.canonicalKey ?? null,
    contentFingerprint: record.contentFingerprint,
    normalizedContent: record.content,
    importance: record.importance,
    confidence: record.confidence,
    validFrom: record.validFrom ?? null,
    validUntil: encodeValidUntil(record.validUntil),
    occurredAt: record.occurredAt ?? null,
    recordedAt: record.recordedAt,
    supersededBy: record.supersededBy === undefined ? null : String(record.supersededBy),
    revision: record.revision,
    revisionEdges: (record.supersedes ?? []).map(String).sort(),
    subjects: record.subjects.map((s) => `${s.kind}:${String(s.id)}`).sort(),
    sourceRefs: record.sourceRefs.map((r) => `${r.kind}:${String(r.id)}`).sort(),
    evidenceRootIds: [...record.evidenceRootIds].map(String).sort(),
  }
}

export interface CanonicalSnapshot {
  hash: string
  entries: CanonicalEntry[]
}

export async function snapshotOf(
  store: MemoryStorePort,
  owner: EntityRef
): Promise<CanonicalSnapshot> {
  /*
   * 不带 status 过滤 = 全部状态（含 superseded / retracted / disputed）。
   * 只比 ACTIVE 会让"历史是否被恢复"完全不被检查 ——
   * 而"旧版本还在不在"恰恰是 M4 最关心的事之一。
   */
  const records = await store.list({ owner, limit: 500 })
  const entries = records
    .map(toCanonicalEntry)
    .sort((a, b) => a.logicalId.localeCompare(b.logicalId))
  return { hash: sha256(stableStringify(entries)), entries }
}

export interface Counts {
  memories: number
  active: number
  superseded: number
  retracted: number
  disputed: number
  subjectLinks: number
  evidenceLinks: number
  evidenceRoots: number
  memoryEvents: number
  domainEvents: number
  conversationEvents: number
}

export async function countsOf(
  db: ReturnType<typeof getRawDb>,
  owner: EntityRef
): Promise<Counts> {
  const counts = await memoryCounts(db, owner)
  const one = async (query: ReturnType<typeof sql>): Promise<number> =>
    Number(rowsOf(await db.execute(query))[0]?.c ?? 0)

  return {
    memories: counts.total,
    active: counts.active,
    superseded: counts.superseded,
    retracted: counts.retracted,
    disputed: counts.disputed,
    subjectLinks: await one(sql`select count(*)::int as c from memory_subject_links`),
    evidenceLinks: await one(sql`select count(*)::int as c from memory_evidence_links`),
    evidenceRoots: await one(
      sql`select count(*)::int as c from memory_evidence_links where is_root`
    ),
    memoryEvents: await one(sql`select count(*)::int as c from memory_events`),
    domainEvents: await one(
      sql`select count(*)::int as c from character_domain_events where type like 'MEMORY_%'`
    ),
    conversationEvents: await one(sql`select count(*)::int as c from conversation_events`),
  }
}

// ---------------------------------------------------------------------------
// 装配
// ---------------------------------------------------------------------------

export interface M4Harness {
  runtime: AgentRuntime
  db: ReturnType<typeof getRawDb>
  store: MemoryStorePort
  owner: EntityRef
  user: EntityRef
  characterId: string
  /** M5 WP6：内核句柄（构造真实 TurnGateway 需要它） */
  kernel: Awaited<ReturnType<typeof initKernel>>
  /** M5 WP6：轮次 recorder（TurnGateway 需要它的 conversationId） */
  recorder: ConversationRecorder
  /** M5 WP6：本 harness 的用户 id（构造 RecallRequest 的 subject 作用域） */
  userId: string
  /** 写一条用户陈述进**真实账本**，返回它的证据引用 */
  recordUserEvidence: (
    text: string
  ) => Promise<{
    ref: { kind: 'conversation_event'; id: string }
    assistantSequence: number
    /** M5 WP6：真实写入的那条用户事件（构造真实轮次用） */
    event: ConversationEvent
    /** M5 WP6：它在会话内的序号（`IncomingTurn.conversationSequence`） */
    conversationSequence: number
  }>
  makeCandidate: (
    type: NewMemoryCandidate['type'],
    content: NewMemoryCandidate['content'],
    overrides: Partial<NewMemoryCandidate> & { sourceRefs: NewMemoryCandidate['sourceRefs'] }
  ) => MemoryCandidate
  commitAndFold: (candidate: MemoryCandidate, now: number) => Promise<MemoryRecord | null>
  /** 只提交、不折叠 —— 用于"提交流水线"类断言 */
  commit: (candidate: MemoryCandidate, now: number) => Promise<MemoryRecord | null>
  /**
   * 提交但**不抛错**：返回拒绝码。
   *
   * 「失败关闭」类断言（畸形候选、owner 闸、越权）需要**看到拒绝码**，
   * 而 `commit()` 抛错的形状只适合"这条必须成功"的语料构造。
   * 混用两种形状会让脚本里既有 try/catch 又有断言，读起来分不清
   * "预期失败"与"意外失败"。
   */
  tryCommit: (
    candidate: MemoryCandidate,
    now: number,
    override?: { owner?: EntityRef; operation?: 'create' | 'supersede' | 'retract' | 'dispute' | 'restore' }
  ) => Promise<{ record: MemoryRecord | null; rejected: string[]; accepted: number }>
  /** 放行口本体（需要直接构造非常规提案时使用） */
  validator: ReturnType<typeof createMemoryMutationValidator>
  /** 直接用已有事件折叠一次（幂等断言用） */
  foldEvent: (event: Parameters<typeof applyMemoryEvent>[1]) => Promise<MemoryRecord | null>
  /** 把一条候选变成已落库的领域事件（不折叠） */
  emit: (
    candidate: MemoryCandidate,
    now: number
  ) => Promise<Awaited<ReturnType<typeof applyAcceptedEvents>>['domainEvents']>
  applyStateChange: (
    operation: 'supersede' | 'retract' | 'dispute' | 'restore',
    triggeredByEventId: string,
    target: Record<string, unknown>,
    now: number
  ) => Promise<MemoryRecord | null>
  /** 造一个**新的 subject**（用于 subject 级隔离测试） */
  newSubject: (seed: string) => EntityRef
  /** M5 WP7：会话内序号的下一个值（`TurnGateway.beginTurn` 需要它） */
  nextTurnSequence: () => number
  stop: () => Promise<void>
}

export const M4_T0 = 1_800_000_000_000

export async function createM4Harness(options: {
  label: string
  characterId?: string
  userId?: string
  /**
   * M5.1.1 / Phase 4a（ADR-043 `DR-6`）：本夹具**扮演哪一个生产入口**。
   *
   * ============================================================================
   *  为什么这个参数必须存在，而且必须显式指名
   * ============================================================================
   * `DR-6` 说得很清楚：**只有被鉴证的归因**才能建立来源资格，调用方自报的
   * `provenance` 不算。因此夹具不能"声明一个来源" —— 它只能选择
   * **站在哪个真实的写入入口上**，然后由那个入口自己的鉴证逻辑产出归因：
   *
   * ```text
   *   缺省 = createHumanConsoleUserTurnIngress()  夹具代表"用户本人直接说"
   *          createAgentRunnerUserTurnIngress()  夹具代表"程序化替用户提交"（D01 形状）
   * ```
   *
   * ⚠️ 它**不是** runtime flag：本文件是 `scripts/` 里的验收装配，不导出任何东西
   *    给 `src/`，生产侧的入口模式仍然只由 `main.ts` 的 `conversationEntryModeOf(argv)`
   *    从真实进程事实推导（没有任何载荷能选它）。
   */
  userIngress?: ConversationAttributionProducer
  /**
   * M6.1 WP5：**记录器也干跑**（缺省 `false` ⇒ 既有调用方行为逐字节不变）。
   *
   * ============================================================================
   *  为什么"网关 dryRun"还不够
   * ============================================================================
   * M6.1 WP5 的 P5 判据是"干跑一轮、九张表零变化"。第一版只把
   * `TurnGateway` 设成干跑，于是 `conversation_events` **仍然变了** —— 因为
   * 用户消息是 `ConversationRecorder` 写的，而它**有自己的** `dryRun`。
   * 生产里 `main.ts` 两个都设；夹具只设一个，测出来的就不是生产行为。
   *
   * ⚠️ 这是一个**如实**的发现，不是把判据放宽：判据保留"九张表全不变"，
   *    改的是夹具——让它能表达生产的真实形状。
   */
  recorderDryRun?: boolean
  /**
   * **放行口的功能开关**（Lv2 / `LV2-D10` ③ 追加）。
   *
   * 生产的注入口是 `main.ts:1656`（`features: { restatementRevivalEnabled }`）。
   * 缺省**不传** ⇒ 与既有行为逐字节相同（所有既有门不受影响）。
   */
  validatorFeatures?: {
    readonly restatementRevivalEnabled?: boolean
  }
}): Promise<M4Harness> {
  const characterId = options.characterId ?? (character.id ?? character.name)
  const userId = options.userId ?? stringToUuid('user-Alex')

  const runtime = new AgentRuntime({
    character: character as Character,
    plugins: [
      openaiPlugin,
      bootstrapPlugin,
      openAiCompatiblePlugin,
      createPersistentCharacterPlugin({ characterId, userId }),
    ] as Plugin[],
    conversationLength: 16,
    settings: {
      OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? '',
      OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? 'https://api.deepseek.com',
      OPENAI_LARGE_MODEL: process.env.OPENAI_LARGE_MODEL ?? 'deepseek-flash',
      OPENAI_SMALL_MODEL: process.env.OPENAI_SMALL_MODEL ?? 'deepseek-flash',
    },
  })

  await initDatabase(runtime, sqlPlugin)
  await runtime.initialize()

  const kernel = await initKernel(runtime, {
    definition: characterDefinitionFromCharacter(character),
    // ⚠️ 必须传全集 registry —— 少这一行，MEMORY_* 一个都登记不上，
    //    每条提案都会在放行口被拒（M4-verification §5.6 缺口②）
    registry: createFullDomainEventRegistry(),
  })

  const db = getRawDb(runtime)
  const store = createNativeMemoryStore(db)
  const owner = entityRef('character', characterId)
  const user = entityRef('user', userId)

  const validator = createMemoryMutationValidator({
    registry: kernel.registry,
    sources: { findEvents: (ids) => findEventRefs(db, ids as never) },
    /*
     * ⚠️ **Lv2 / `LV2-D10` ③（2026-10-02）**：生产在 `main.ts:1656` 把
     * `features: { restatementRevivalEnabled: … }` 注入放行口 deps（`memory-validator.ts:732`），
     * 而本夹具第一版**没有**这个字段 ⇒ "同内容重述复活"（M9.1 `D03`）在**任何**用本夹具的
     * 批次里都是**关的**。补一个**可选**入口：**缺省不传 ⇒ 行为逐字节不变**（既有门不受影响）；
     * Lv2 的装配按生产配置显式传 `true`。
     */
    ...(options.validatorFeatures === undefined ? {} : { features: options.validatorFeatures }),
    processed: {
      hasProcessed: async (key) => {
        const rows = await db.execute(
          sql`select 1 as one from processed_operations where idempotency_key = ${key} limit 1`
        )
        return rowsOf(rows).length > 0
      },
    },
    lookup: {
      /*
       * ⚠️ **Lv2 / `ADR-088` §6.8（2026-10-02）**：生产在这里还有一条 `getRecord`
       *    （`src/main.ts:1646/3537` 逐字：`async (id) => (await store.get(id)) ?? undefined`），
       *    而本夹具**一直没有**它 ⇒ 放行口的"复活发射闸"**第 ④ 条前置**永远不满足
       *    （`memory-validator.ts:731-734`：`features.restatementRevivalEnabled && lookup.getRecord !== undefined`）
       *    ⇒ 同内容重述**永不复活**（M9 的 `F-4` 症状）在**任何用本夹具的批次里都被固化**。
       *    实测：Lv2 `C05-04` 的二分得到 `already_applied`，而生产装配"天然满足"这一条。
       *    ⇒ 补上它；**对既有门行为中性**：复活还要 `features.restatementRevivalEnabled === true`，
       *      而那条开关在本夹具缺省**不传**（只有 Lv2 装配显式传 true）。
       */
      getRecord: async (id) => (await store.get(id)) ?? undefined,
      findActiveByFingerprint: async ({ owner: o, fingerprint }) => {
        const found = await store.getActiveByFingerprint(o, fingerprint)
        return found === null ? undefined : { memoryId: found.id }
      },
      findActiveByCanonicalKey: async ({ owner: o, canonicalKey }) => {
        const found = await store.getActiveByCanonicalKey(canonicalKey)
        return found
          .filter((r) => String(r.owner.id) === String(o.id) && r.owner.kind === o.kind)
          .map((r) => ({ memoryId: r.id }))
      },
    },
  })

  const recorder = new ConversationRecorder({
    db,
    characterId: kernel.characterId,
    conversationId: asConversationId(`dm-${characterId}-${options.label}`),
    dryRun: options.recorderDryRun === true,
    userName: 'Alex',
    characterName: character.name,
    transport: `verify-m4-${options.label}`,
    /*
     * M5.1.1 / Phase 4a（ADR-043 `DR-6` / `DR-7`）—— **K-28 接线点在夹具侧的对应物**。
     *
     * 与 `src/main.ts:532` 同一行、同一个理由：不接这一行，写出来的行一律是
     * legacy（归因列为 NULL），于是 `processorEventViewOf()` 取不到
     * 受信读数，事实类候选会被 Phase 4a 的来源资格闸**失败关闭**地拒掉。
     *
     * 夹具缺省代表"交互式人类控制台"（本 harness 就是 `pnpm chat` 的替身），
     * 需要 D01 反例的用例显式传 `userIngress: createAgentRunnerUserTurnIngress()`。
     *
     * ⚠️ 她的输出那条通道**与人口模式无关**（`conversationAttributionForEntryMode`
     *    也是两个模式都装它），所以它必须一起装上 —— 只装用户那条会让
     *    `assistant_message` 行退回 legacy，从而把"她的输出 = 来源已确立但不是人"
     *    这个反例悄悄变成"没有信封"。
     */
    attribution: [
      options.userIngress ?? createHumanConsoleUserTurnIngress(),
      createCharacterAssistantTurnIngress(),
    ],
  })

  let conversationSequence = 0

  const recordUserEvidence: M4Harness['recordUserEvidence'] = async (text) => {
    conversationSequence += 1
    const { event, assistantSequence } = await recorder.recordUserMessage(
      text,
      conversationSequence
    )
    if (event === undefined || assistantSequence === undefined) {
      throw new Error('写入用户证据失败：recorder 返回了 undefined（dryRun 未关闭？）')
    }
    return {
      ref: { kind: 'conversation_event', id: String(event.id) },
      assistantSequence,
      // M5 WP6：把事件本身也交出来 —— 运行时门要构造**真实的一轮**
      // （`completeTurn` 要求 assistant 事件带 replyToEventId，合成轮次做不到）
      event,
      conversationSequence,
    }
  }

  const makeCandidate: M4Harness['makeCandidate'] = (type, content, overrides) =>
    createMemoryCandidate({
      owner,
      type,
      content,
      subjects: content.kind === 'claim' ? [content.subject] : content.participants,
      epistemicStatus: 'reported',
      authority: 'EXPLICIT_USER_STATEMENT',
      importance: 0.8,
      confidence: 0.9,
      processor: 'memory-extractor',
      processorVersion: 'memory-extractor@1',
      ...overrides,
      sourceRefs: overrides.sourceRefs,
      evidenceRootIds: overrides.evidenceRootIds ?? overrides.sourceRefs.map((ref) => ref.id),
    } as NewMemoryCandidate)

  const commit: M4Harness['commit'] = async (candidate, now) => {
    const outcome = await validator.validate({
      characterId: kernel.characterId,
      owner: candidate.owner,
      candidates: [candidate],
      mutation: 'explicit',
      operation: 'create',
    })
    if (outcome.rejected.length > 0) {
      throw new Error(`提案被拒：${outcome.rejected.map((r) => r.code).join(',')}`)
    }
    const applied = await applyAcceptedEvents(db, kernel.characterId, outcome.accepted, [], now)
    let record: MemoryRecord | null = null
    for (const event of applied.domainEvents) {
      const result = await applyMemoryEvent(db, event, event.createdAt)
      record = result.record
    }
    return record
  }

  const emit: M4Harness['emit'] = async (candidate, now) => {
    const outcome = await validator.validate({
      characterId: kernel.characterId,
      owner: candidate.owner,
      candidates: [candidate],
      mutation: 'explicit',
      operation: 'create',
    })
    if (outcome.rejected.length > 0) {
      throw new Error(`提案被拒：${outcome.rejected.map((r) => r.code).join(',')}`)
    }
    const applied = await applyAcceptedEvents(db, kernel.characterId, outcome.accepted, [], now)
    return applied.domainEvents
  }

  const tryCommit: M4Harness['tryCommit'] = async (candidate, now, override) => {
    const outcome = await validator.validate({
      characterId: kernel.characterId,
      owner: override?.owner ?? candidate.owner,
      candidates: [candidate],
      mutation: 'explicit',
      operation: override?.operation ?? 'create',
    } as never)
    if (outcome.rejected.length > 0) {
      return {
        record: null,
        rejected: outcome.rejected.map((r) => String(r.code)),
        accepted: outcome.accepted.length,
      }
    }
    const applied = await applyAcceptedEvents(db, kernel.characterId, outcome.accepted, [], now)
    let record: MemoryRecord | null = null
    for (const event of applied.domainEvents) {
      const result = await applyMemoryEvent(db, event, event.createdAt)
      record = result.record
    }
    return { record, rejected: [], accepted: outcome.accepted.length }
  }

  const applyStateChange: M4Harness['applyStateChange'] = async (
    operation,
    triggeredByEventId,
    target,
    now
  ) => {
    const outcome = await validator.validate({
      characterId: kernel.characterId,
      owner,
      candidates: [],
      mutation: 'explicit',
      operation,
      triggeredByEventId,
      target,
    } as never)
    if (outcome.rejected.length > 0) {
      throw new Error(`${operation} 被拒：${outcome.rejected.map((r) => r.code).join(',')}`)
    }
    const applied = await applyAcceptedEvents(db, kernel.characterId, outcome.accepted, [], now)
    let record: MemoryRecord | null = null
    for (const event of applied.domainEvents) {
      const result = await applyMemoryEvent(db, event, event.createdAt)
      record = result.record
    }
    return record
  }

  return {
    runtime,
    db,
    store,
    owner,
    user,
    characterId: String(kernel.characterId),
    /**
     * M5 WP6：把内核与 recorder 也暴露出来。
     *
     * 理由：M5 的运行时门要构造**真实的 `TurnGateway`**
     * （`compileTurn` 那一条），而它需要 `KernelHandle` + `ConversationRecorder`。
     * 之前没有任何脚本这样做（只有 `main.ts` 装配网关），于是这里补上 ——
     * 否则 M5 的门就只能测"provider 单独工作"，测不到"接进真实链路"。
     */
    kernel,
    recorder,
    userId,
    recordUserEvidence,
    makeCandidate,
    commitAndFold: commit,
    commit,
    tryCommit,
    emit,
    validator,
    foldEvent: (event) => applyMemoryEvent(db, event, event.createdAt).then((r) => r.record),
    applyStateChange,
    newSubject: (seed: string) => entityRef('user', stringToUuid(seed)),
    /**
     * M5 WP7：**一轮**的会话内序号（`TurnGateway.beginTurn` 需要它）。
     *
     * ⚠️ 一轮占**两个**序号：用户事件用它，助手事件用 `+1`
     *    （见 `completeTurn` 里 `conversationSequence + 1`）。
     *    第一版写成"每次 +1"，于是第二轮的序号撞上了上一轮的**助手事件** ——
     *    `recordUserMessage` 的幂等探测把那条回复当成了本轮输入，
     *    表现为 `observation_input_mismatch: derived='（自动回复）'`。
     *    所以这里一次前进 2，并返回**用户那一格**。
     */
    nextTurnSequence: () => {
      conversationSequence += 2
      return conversationSequence - 1
    },
    stop: async () => {
      await runtime.stop()
    },
  }
}

// ---------------------------------------------------------------------------
// 语料：M4 恢复 / 隔离 / 规模测试共用的"四种状态全覆盖"语料
// ---------------------------------------------------------------------------

export interface CorpusResult {
  revisionPair: [string, string]
  retractedId: string
  disputedId: string
  episodeId: string | null
  personFactId: string
}

/**
 * 造一份覆盖 create / supersede / retract / dispute / episode 的语料。
 *
 * 五种形状对应 reducer 的五条分支；只造"新建"的语料
 * 会让 Replay / Restore 的验证**看起来通过而其实没测到状态转移**。
 */
export async function buildStandardCorpus(
  h: M4Harness,
  subject: EntityRef = h.user
): Promise<CorpusResult> {
  const claim = (predicate: string, value: string) =>
    ({ kind: 'claim', subject, predicate, value }) as never

  // ① person_fact
  const eduEvidence = await h.recordUserEvidence('我现在上的大学是示例工程科技大学')
  const edu = (await h.commitAndFold(
    h.makeCandidate(
      'person_fact',
      claim('education.institution', '示例工程科技大学'),
      { sourceRefs: [eduEvidence.ref] }
    ),
    M4_T0 + 100
  ))!

  // ② preference → 同槽位新值 → supersede（revision 链）
  const cilantroEvidence = await h.recordUserEvidence('记住，我不吃香菜')
  const cilantro = (await h.commitAndFold(
    h.makeCandidate('preference', claim('food.avoid.cilantro', 'avoid'), {
      sourceRefs: [cilantroEvidence.ref],
    }),
    M4_T0 + 200
  ))!
  const canEatEvidence = await h.recordUserEvidence('那个改一下，我现在能吃香菜了')
  const canEat = (await h.commitAndFold(
    h.makeCandidate('preference', claim('food.avoid.cilantro', 'like'), {
      sourceRefs: [canEatEvidence.ref],
    }),
    M4_T0 + 300
  ))!
  await h.applyStateChange(
    'supersede',
    canEatEvidence.ref.id,
    {
      memoryId: cilantro.id,
      supersededBy: canEat.id,
      validUntil: M4_T0 + 300,
      reason: '用户说现在能吃香菜了',
    },
    M4_T0 + 300
  )

  // ③ retract（forget）
  const osEvidence = await h.recordUserEvidence('我平时主要用 Windows')
  const osRecord = (await h.commitAndFold(
    h.makeCandidate('person_fact', claim('device.primary', 'Windows'), {
      sourceRefs: [osEvidence.ref],
    }),
    M4_T0 + 400
  ))!
  const forgetEvidence = await h.recordUserEvidence('忘掉我平时用 Windows 这件事')
  await h.applyStateChange(
    'retract',
    forgetEvidence.ref.id,
    { memoryId: osRecord.id, reason: 'explicit_forget', note: '用户要求忘掉' },
    M4_T0 + 500
  )

  // ④ dispute
  const colorEvidence = await h.recordUserEvidence('我最喜欢蓝色')
  const color = (await h.commitAndFold(
    h.makeCandidate('preference', claim('preference.color.favorite', 'blue'), {
      sourceRefs: [colorEvidence.ref],
    }),
    M4_T0 + 600
  ))!
  const colorConflict = await h.recordUserEvidence('我从来不喜欢蓝色')
  await h.applyStateChange(
    'dispute',
    colorConflict.ref.id,
    {
      memoryId: color.id,
      conflictingMemoryIds: [],
      reason: '前几天说最喜欢蓝色，今天说从来不喜欢蓝色',
    },
    M4_T0 + 700
  )

  // ⑤ episode（没有 canonical key，走另一条 reducer 分支）
  const tripEvidence = await h.recordUserEvidence('昨天我们聊了整整一个下午')
  const trip = await h.commitAndFold(
    h.makeCandidate(
      'episode',
      {
        kind: 'episode',
        summary: '聊了一个下午',
        participants: [subject],
        // `eventRefs` 是"这段经历由哪些事件组成"（叙事结构），
        // 与 `sourceRefs`（这条记忆凭什么成立）**不是**同一个概念（契约里写明了）
        eventRefs: [tripEvidence.ref.id],
      } as never,
      { sourceRefs: [tripEvidence.ref], epistemicStatus: 'observed' }
    ),
    M4_T0 + 800
  )

  return {
    revisionPair: [String(cilantro.id), String(canEat.id)],
    retractedId: String(osRecord.id),
    disputedId: String(color.id),
    episodeId: trip === null ? null : String(trip.id),
    personFactId: String(edu.id),
  }
}
