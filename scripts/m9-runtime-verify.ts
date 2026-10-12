/**
 * M9 WP6 门 —— 调度与装配（`m9:runtime:verify`）。
 *
 * ============================================================================
 *  判据来源：计划 §718–730（WP6 出口）+ ADR-070 §6.3（双流）+ WP5 交接单 §7
 * ============================================================================
 * §0 开关：缺省 off；显式 on；describe 可见（"装了没有"一眼可见）。
 * §1 冷启动建档：播种 BELIEF_ORIGIN（cutover=当前账本最大序号——切换前
 *    历史不重放）；重复播种 = already；零 BELIEF_* 事件。
 * §2 交互尾窗（同轮语义）：合格事件 → EVIDENCE_NOTED 落库 + 累计行；
 *    3 根/2 会话 → FORMED 同轮触发；全不合格窗口（她的回复/系统/工具/
 *    无信封用户行）0 提案但水位前进（尾窗有界）；重放零重复。
 * §3 页边界（计划 §728 的 2000/2001/4001）：窗口宽度钳位 ≤ 页大小 ⇒
 *    "读了 = 全读"，余量留尾窗，水位绝不越过没读过的事件。
 * §4 断点覆盖（enqueue/apply/finish/watermark）：播种断点（水位落后
 *    cutover ⇒ 恢复不重放）；apply 断点（append 成功 fold 失败 ⇒ job
 *    如实 failed + 水位不动 + 重试零重复 + rebuild 修复投影滞后——
 *    投影是派生的）；水位断点（job 已 completed ⇒ recovered 只补水位，
 *    **不许把 completed 改写成 failed**）。
 * §5 Memory 流端到端 + 双水位独立：MEMORY_CREATED → B-REPORTED 形成；
 *    MEMORY_RETRACTED → 依赖失效传播（RETRACTED(dependency_invalidated)，
 *    不禁根）；两条流各自水位互不阻塞；重放零重复。
 *
 * 生产装配路径 == 受测路径：本门 import 的 maybeRunBeliefEvaluation /
 * maybeRunBeliefMemoryReconciliation 与 main.ts 是同一模块的同一导出。
 * turn hook ≠ 新建自主后台任务：本门不建任何定时器（装配只有 open/send
 * 两个既有钩子——由 m4/m4.5 的开关消费锁守着）。
 *
 * 证据：`artifacts/m9/m9-wp6-runtime-<date>-<head12>-<suffix4>/`（m9-manifest@1）。
 */
import 'dotenv/config'
import { isolateDatabase } from '../src/dev/sandbox.ts'
isolateDatabase('m9-runtime-verify', { keep: false })

import { AgentRuntime, type Character } from '@elizaos/core'
import sqlPlugin from '@elizaos/plugin-sql'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import { character } from '../src/character/index.ts'
import { initDatabase } from '../src/db/index.ts'
import { initKernel } from '../src/kernel/app/kernel.ts'
import { characterDefinitionFromCharacter } from '../src/infrastructure/runtime/seed-projection.ts'
import { createHumanConsoleUserTurnIngress } from '../src/infrastructure/runtime/conversation-attribution.ts'
import { appendConversationEvent } from '../src/infrastructure/persistence/conversation-store.ts'
import {
  appendDomainEvent,
  domainEventsFor,
} from '../src/infrastructure/persistence/event-store.ts'
import { applyMemoryEvent } from '../src/infrastructure/persistence/memory-store.ts'
import { latestCharacterEventSequence } from '../src/infrastructure/persistence/conversation-store.ts'
import {
  getBelief,
  getBeliefEvidence,
  getBeliefOrigin,
  listActiveBeliefs,
  rebuildBeliefProjections,
} from '../src/infrastructure/persistence/belief-store.ts'
import { forbiddenRootsForSlot } from '../src/infrastructure/persistence/belief-store.ts'
import { getJob, getWatermark, listJobs } from '../src/infrastructure/persistence/job-store.ts'
import { exec, type RawDb } from '../src/infrastructure/persistence/db.ts'
import {
  BELIEF_INTERACTION_EVALUATOR_NAME,
  BELIEF_INTERACTION_EVALUATOR_VERSION,
  beliefEvidenceKeyOf,
} from '../src/kernel/app/belief/evaluator.ts'
import {
  BELIEF_MEMORY_RECONCILER_NAME,
  BELIEF_MEMORY_RECONCILER_VERSION,
} from '../src/kernel/app/belief/job.ts'
import {
  describeBeliefScheduling,
  maybeRunBeliefEvaluation,
  maybeRunBeliefMemoryReconciliation,
} from '../src/infrastructure/runtime/belief-scheduler.ts'
import { readKernelFlags, describeKernelFlags } from '../src/kernel/app/flags.ts'
import {
  BELIEF_INFERRED_PREDICATE,
  BELIEF_INFERRED_SCOPE,
  beliefEvidenceProjectionTypeOf,
  beliefReportedScopeKeyOf,
  beliefSlotKeyOf,
} from '../src/kernel/contracts/belief.ts'
import { DOMAIN_EVENT_SCOPE } from '../src/kernel/contracts/domain-event.ts'
import { asCharacterId, asConversationId, asEntityId } from '../src/kernel/contracts/ids.ts'
import { entityRef } from '../src/kernel/contracts/entity.ts'
import {
  conversationEvidence,
  MEMORY_REDUCER_VERSION,
  MEMORY_SCHEMA_VERSION,
  type MemoryRecord,
} from '../src/kernel/contracts/memory.ts'
import type { AcceptedDomainEvent } from '../src/kernel/policies/validator.ts'
import { createM9RunId, openM9RunDir, writeM9Manifest } from './m9-evidence.ts'

const REPO_ROOT = process.cwd()
const T0 = Date.UTC(2026, 8, 27, 4, 0, 0)
const USER = 'm9-wp6-user'
const CONV_A = asConversationId('m9-wp6-conv-a')
const CONV_B = asConversationId('m9-wp6-conv-b')
const CONV_C = asConversationId('m9-wp6-conv-c')

// ---------------------------------------------------------------------------
// check 汇总（与 m9-verify / m9-invalidation-verify 同一形状）
// ---------------------------------------------------------------------------

interface Check {
  id: string
  name: string
  pass: boolean
  detail: string
}
const checks: Check[] = []
function check(id: string, name: string, pass: boolean, detail: string): void {
  checks.push({ id, name, pass, detail })
  console.log(`  ${pass ? '✅' : '❌'} ${name} :: ${detail}`)
  if (!pass) process.exitCode = 1
}
function section(title: string): void {
  console.log(`\n=== ${title} ===`)
}

// ===========================================================================
// §0 开关（缺省 off；显式 on；describe 可见）
// ===========================================================================

async function main(): Promise<void> {
  section('§0 开关（缺省 off · 显式 on · describe 可见）')
  {
    const off = readKernelFlags({})
    check(
      'r0-01',
      'CHARACTER_BELIEF_ENABLED 缺省 off（零新增认知的缺省态）',
      off.beliefEnabled === false,
      `beliefEnabled=${String(off.beliefEnabled)}`,
    )
    const on = readKernelFlags({ CHARACTER_BELIEF_ENABLED: 'true' } as NodeJS.ProcessEnv)
    check(
      'r0-02',
      'CHARACTER_BELIEF_ENABLED=true ⇒ on（激活属独立裁定，缺省不变）',
      on.beliefEnabled === true,
      `beliefEnabled=${String(on.beliefEnabled)}`,
    )
    const described = describeKernelFlags(off)
    check(
      'r0-03',
      'describeKernelFlags 含 belief=off/on（"装了没有"一眼可见）',
      described.includes('belief=off') && describeKernelFlags(on).includes('belief=on'),
      `片段=${described.includes('belief=') ? '含 belief=' : '缺 belief='}`,
    )
  }

  // -------------------------------------------------------------------------
  // 隔离库（生产装配路径 == 受测路径：真库真调度器，不是内存替身）
  // -------------------------------------------------------------------------
  const runtime = new AgentRuntime({ character: character as Character, plugins: [], settings: {} })
  await initDatabase(runtime, sqlPlugin)
  await runtime.initialize()
  const kernel = await initKernel(runtime, {
    definition: characterDefinitionFromCharacter(character),
  })
  const db = kernel.stores.db
  const characterId = kernel.characterId
  const userIngress = createHumanConsoleUserTurnIngress()
  const USER_ENTITY = entityRef('user', USER)
  const INFERRED_SLOT = beliefSlotKeyOf({
    perspectiveOwnerId: asEntityId(String(characterId)),
    subject: USER_ENTITY,
    predicate: BELIEF_INFERRED_PREDICATE,
    scopeKey: BELIEF_INFERRED_SCOPE,
  })

  // ---- 夹具助手 -----------------------------------------------------------
  const convCounters = new Map<string, number>()
  let clock = T0
  async function appendEvent(input: {
    conversationId: ReturnType<typeof asConversationId>
    type: 'user_message' | 'assistant_message' | 'system_event' | 'tool_event'
    actorType: 'user' | 'character' | 'system' | 'tool'
    content: string
    withAttribution?: boolean
  }): Promise<{ id: string; sequence: number }> {
    const seq = (convCounters.get(String(input.conversationId)) ?? 0) + 1
    convCounters.set(String(input.conversationId), seq)
    clock += 1000
    const { event } = await appendConversationEvent(
      db,
      {
        characterId,
        conversationId: input.conversationId,
        conversationSequence: seq,
        type: input.type,
        actorType: input.actorType,
        ...(input.actorType === 'user' || input.actorType === 'character'
          ? { actorId: input.actorType === 'user' ? USER : String(characterId) }
          : {}),
        content: input.content,
        createdAt: clock,
        ...(input.withAttribution === true
          ? {
              trustedAttribution: userIngress.attest({
                characterId: String(characterId),
                presenterActorId: USER,
                userId: USER,
              }),
            }
          : {}),
      },
    )
    return { id: String(event.id), sequence: event.sequence }
  }
  /** 合格用户证据（RECORDED 信封 + 指定正文） */
  const qualified = (content: string, conversationId: ReturnType<typeof asConversationId>) =>
    appendEvent({ conversationId, type: 'user_message', actorType: 'user', content, withAttribution: true })

  /**
   * 批量插入无信封行（页边界夹具：不合格 ⇒ 0 提案，只考水位钳位）。
   *
   * ⚠️ 直写绕过了 `nextCharacterSequence` 的计数器协议（M2.5：对话事件与
   * 领域事件**共享**同一计数器，领域事件会在对话序号空间留下空洞——
   * M6.1 冻结单 §11 的既知现象）。夹具绕过后必须把计数器对齐到
   * `greatest(计数器, max(对话序号))`，否则后续 appendConversationEvent
   * 会分配到与批量行冲突的序号（on conflict do nothing ⇒ 回读失败 ⇒ 抛
   * event_append_conflict）。对齐只前进不后退（计数器可能已被领域事件
   * 消耗到更前面）。
   */
  async function bulkUnqualified(count: number, startSequence: number): Promise<number> {
    const rows = await exec(
      db,
      sql`insert into conversation_events
            (id, character_id, conversation_id, sequence, conversation_sequence,
             type, actor_type, content, schema_version, created_at)
          select 'm9-wp6-bulk-' || ${String(startSequence)} || '-' || g,
                 ${String(characterId)}, ${String(CONV_B)},
                 ${String(startSequence)}::int + g - 1, g,
                 'system_event', 'system', 'm9-wp6-bulk', 1, ${String(T0)}::bigint
          from generate_series(1, ${String(count)}::int) as g
          returning sequence`,
      '页边界夹具批量插入',
    )
    await exec(
      db,
      sql`insert into character_sequence_counters (character_id, next_sequence)
          values (${String(characterId)},
                  (select coalesce(max(sequence), 0) from conversation_events
                    where character_id = ${String(characterId)}))
          on conflict (character_id)
            do update set next_sequence = greatest(
              character_sequence_counters.next_sequence, excluded.next_sequence)`,
      '页边界夹具后对齐序号计数器',
    )
    return rows.length
  }

  /** BELIEF_* 事件计数（按类型） */
  async function beliefCounts(): Promise<Record<string, number>> {
    const rows = await exec(
      db,
      sql`select type, count(*)::int as c from character_domain_events
          where character_id = ${String(characterId)} and type like 'BELIEF%'
          group by type`,
      '统计 BELIEF 事件',
    )
    const out: Record<string, number> = {}
    for (const row of rows) out[String(row.type)] = Number(row.c)
    return out
  }
  const totalBeliefEvents = (counts: Record<string, number>): number =>
    Object.values(counts).reduce((a, b) => a + b, 0)

  /** 直接改水位（断点模拟：崩溃发生在 advanceWatermark 之前/之后） */
  async function forceWatermark(processor: string, version: string, value: number): Promise<void> {
    await exec(
      db,
      sql`update processor_watermarks set processed_through_sequence = ${String(value)}
          where character_id = ${String(characterId)}
            and processor = ${processor} and processor_version = ${version}`,
      '断点模拟：回拨水位',
    )
  }
  const interactionWatermark = async (): Promise<number> =>
    (
      await getWatermark(db, characterId, BELIEF_INTERACTION_EVALUATOR_NAME, BELIEF_INTERACTION_EVALUATOR_VERSION)
    )?.processedThroughSequence ?? 0
  const memoryWatermark = async (): Promise<number> =>
    (
      await getWatermark(db, characterId, BELIEF_MEMORY_RECONCILER_NAME, BELIEF_MEMORY_RECONCILER_VERSION)
    )?.processedThroughSequence ?? 0

  /**
   * drizzle `sql` 模块的字符串块不是裸字符串：是 `StringChunk`，其 `value`
   * 是**字符串数组**（m8-wp6-verify 实测踩坑：按裸字符串或 `.value: string`
   * 过滤都会静默匹配零条 ⇒ 负控失效）。此处照抄 m8 的提取器。
   */
  function sqlTextOf(query: unknown): string {
    const chunks = (query as { queryChunks?: unknown[] })?.queryChunks
    if (!Array.isArray(chunks)) return ''
    return chunks
      .map((chunk) => {
        if (typeof chunk === 'string') return chunk
        if (chunk !== null && typeof chunk === 'object' && 'value' in chunk) {
          const value = (chunk as { value: unknown }).value
          if (typeof value === 'string') return value
          if (Array.isArray(value)) {
            return value.filter((v): v is string => typeof v === 'string').join('')
          }
        }
        return ''
      })
      .join('\n')
  }

  /**
   * 失败注入（apply 断点的量具）：拦下 character_projections 的**写**，
   * 其余一切照旧——append 成功、fold 失败，正是"apply 断点"的精确边界。
   * （与 m8-wp6-verify 的 withFailingDomainEventInserts 同一模式。）
   */
  function withFailingProjectionWrites(real: RawDb): RawDb {
    const guard = (handle: RawDb): RawDb => ({
      execute: async (query: unknown) => {
        if (
          /insert\s+into\s+character_projections|update\s+character_projections|delete\s+from\s+character_projections/.test(
            sqlTextOf(query),
          )
        ) {
          throw new Error('m9-wp6-injected-projection-write-failure')
        }
        return handle.execute(query)
      },
    })
    return {
      ...guard(real),
      ...(real.transaction !== undefined
        ? {
            transaction: <T>(fn: (tx: RawDb) => Promise<T>) =>
              real.transaction!((tx) => fn(guard(tx))),
          }
        : {}),
    }
  }

  // =========================================================================
  // §1 冷启动建档（cutover = 当前账本最大序号；切换前历史不重放）
  // =========================================================================
  section('§1 冷启动建档（播种 · cutover · 不重放）')

  // 三条合格事件先落账（它们是"切换前历史"——播种后必须永不被消费）
  await qualified('以后都这么讲，每一步都写出来', CONV_A)
  await qualified('以后每次都展开细讲，别跳步', CONV_B)
  await qualified('我喜欢详细的解释，一步步来', CONV_A)
  const countsAfterSeedFixtures = await beliefCounts()
  check(
    'r1-00',
    '前置：三条切换前历史事件落账，零 BELIEF_* 事件',
    totalBeliefEvents(countsAfterSeedFixtures) === 0,
    `beliefEvents=${String(totalBeliefEvents(countsAfterSeedFixtures))}`,
  )

  const seedRun = await maybeRunBeliefEvaluation(db, {
    characterId,
    activeUserId: USER,
    activationId: 'wp6-verify-seed',
    now: T0 + 10_000,
  })
  const originRow = await getBeliefOrigin(db, characterId)
  check(
    'r1-01',
    '首次调度 ⇒ 播种 BELIEF_ORIGIN（cutover=3，水位=cutover，no_tail）',
    seedRun.kind === 'no_tail' &&
      originRow !== undefined &&
      originRow.state.originated === true &&
      originRow.state.cutoverSequence === 3 &&
      (await interactionWatermark()) === 3,
    `kind=${seedRun.kind} cutover=${String(originRow?.state.cutoverSequence)} watermark=${String(await interactionWatermark())}`,
  )
  check(
    'r1-02',
    '切换前历史不重放：播种后仅 ORIGIN 一条，零 NOTED/FORMED（B-INFERRED 只采切换后互动）',
    totalBeliefEvents(await beliefCounts()) === 1 &&
      ((await beliefCounts())['BELIEF_ORIGIN'] ?? 0) === 1,
    `beliefEvents=${String(totalBeliefEvents(await beliefCounts()))} origin=${String((await beliefCounts())['BELIEF_ORIGIN'] ?? 0)}`,
  )

  const seedAgain = await maybeRunBeliefEvaluation(db, {
    characterId,
    activeUserId: USER,
    activationId: 'wp6-verify-seed-again',
    now: T0 + 11_000,
  })
  const originCounts = (await beliefCounts())['BELIEF_ORIGIN'] ?? 0
  check(
    'r1-03',
    '重复调度不重复建档（ORIGIN 一角色一次；no_tail）',
    seedAgain.kind === 'no_tail' && originCounts === 1,
    `kind=${seedAgain.kind} originEvents=${String(originCounts)}`,
  )

  // =========================================================================
  // §2 交互尾窗（同轮语义：记根 → 累计 → 形成；全不合格窗口；重放）
  // =========================================================================
  section('§2 交互尾窗（记根 · 累计 · 同轮形成 · 全不合格 · 重放）')

  // r2-01：第一条切换后合格证据
  const ev4 = await qualified('以后都这么讲，每一步都写出来', CONV_A)
  const run1 = await maybeRunBeliefEvaluation(db, {
    characterId,
    activeUserId: USER,
    activationId: 'wp6-verify-turn',
    now: T0 + 12_000,
  })
  check(
    'r2-01',
    '合格尾窗 ⇒ flushed：EVIDENCE_NOTED 落库 + 水位前进',
    run1.kind === 'flushed' &&
      run1.window.from === 4 &&
      run1.window.to === ev4.sequence &&
      run1.outcome.applied.createdEvents >= 1 &&
      ((await beliefCounts())['BELIEF_EVIDENCE_NOTED'] ?? 0) === 1 &&
      (await interactionWatermark()) === ev4.sequence,
    `kind=${run1.kind} window=${run1.kind === 'flushed' ? `[${String(run1.window.from)},${String(run1.window.to)}]` : '-'} created=${run1.kind === 'flushed' ? String(run1.outcome.applied.createdEvents) : '-'} wm=${String(await interactionWatermark())}`,
  )

  // r2-02：累计行（跨窗口状态面）——行键 = belief:evidence:<fnv1aHex(证据键)>
  const evidenceRowKey = beliefEvidenceProjectionTypeOf(
    beliefEvidenceKeyOf(INFERRED_SLOT, 'detailed'),
  )
  const accAfterFirst = await getBeliefEvidence(db, characterId, evidenceRowKey)
  check(
    'r2-02',
    '证据累计行落库（rootIds 含新根；跨窗口累计状态面）',
    accAfterFirst !== undefined &&
      accAfterFirst.state.value === 'detailed' &&
      accAfterFirst.state.rootIds.map(String).includes(ev4.id),
    `roots=${String(accAfterFirst?.state.rootIds.length ?? 0)}`,
  )

  // r2-03：第二条（跨会话）——2 根/2 会话，仍不足 3 根
  const ev5 = await qualified('以后每次都展开细讲，别跳步', CONV_B)
  const run2 = await maybeRunBeliefEvaluation(db, {
    characterId,
    activeUserId: USER,
    now: T0 + 13_000,
  })
  check(
    'r2-03',
    '第二条证据：累计 2 根/2 会话，未到阈值 ⇒ 零 FORMED（D06 阈值不放宽）',
    run2.kind === 'flushed' &&
      ((await beliefCounts())['BELIEF_EVIDENCE_NOTED'] ?? 0) === 2 &&
      ((await beliefCounts())['BELIEF_FORMED'] ?? 0) === 0,
    `noted=${String((await beliefCounts())['BELIEF_EVIDENCE_NOTED'] ?? 0)} formed=${String((await beliefCounts())['BELIEF_FORMED'] ?? 0)}`,
  )

  // r2-04：第三条 ⇒ 3 根/2 会话 ⇒ FORMED 同轮触发
  const ev6 = await qualified('我喜欢详细的解释，一步步来', CONV_B)
  const run3 = await maybeRunBeliefEvaluation(db, {
    characterId,
    activeUserId: USER,
    now: T0 + 14_000,
  })
  const activesAfterFormed = await listActiveBeliefs(db, characterId)
  const inferredBelief = activesAfterFormed.find(
    (b) => b.proposition.value === 'detailed' && b.epistemicKind === 'inferred',
  )
  const inferredBeliefId = inferredBelief !== undefined ? String(inferredBelief.beliefId) : ''
  check(
    'r2-04',
    '第三条证据：3 根/2 会话 ⇒ BELIEF_FORMED 同轮落库 + active 行',
    run3.kind === 'flushed' &&
      ((await beliefCounts())['BELIEF_FORMED'] ?? 0) === 1 &&
      inferredBelief !== undefined &&
      inferredBelief.status === 'active' &&
      inferredBelief.evidenceRootIds.length === 3,
    `formed=${String((await beliefCounts())['BELIEF_FORMED'] ?? 0)} roots=${String(inferredBelief?.evidenceRootIds.length ?? 0)}`,
  )

  // r2-05：全不合格窗口（她的回复/系统/工具/无信封用户行）
  const beforeUnqualified = totalBeliefEvents(await beliefCounts())
  await appendEvent({ conversationId: CONV_A, type: 'assistant_message', actorType: 'character', content: '好的，我记住了' })
  await appendEvent({ conversationId: CONV_A, type: 'system_event', actorType: 'system', content: 'system notice' })
  await appendEvent({ conversationId: CONV_A, type: 'tool_event', actorType: 'tool', content: 'tool output' })
  await appendEvent({ conversationId: CONV_A, type: 'user_message', actorType: 'user', content: '以后都这么讲，每一步都写出来' })
  // 序号空间有空洞（领域事件共享计数器）——最新值只能问账本，不能做算术
  const latestAfterUnqualified = await latestCharacterEventSequence(db, characterId)
  const run4 = await maybeRunBeliefEvaluation(db, {
    characterId,
    activeUserId: USER,
    now: T0 + 15_000,
  })
  check(
    'r2-05',
    '全不合格窗口：0 提案但水位前进（尾窗有界；tool 跳过；无信封行不成证据）',
    run4.kind === 'flushed' &&
      run4.outcome.proposals === 0 &&
      run4.outcome.skippedToolEvents === 1 &&
      totalBeliefEvents(await beliefCounts()) === beforeUnqualified &&
      (await interactionWatermark()) === latestAfterUnqualified,
    `kind=${run4.kind} proposals=${run4.kind === 'flushed' ? String(run4.outcome.proposals) : '-'} toolSkip=${run4.kind === 'flushed' ? String(run4.outcome.skippedToolEvents) : '-'} wm=${String(await interactionWatermark())}`,
  )

  // r2-06：重放零重复（水位回拨 ⇒ 同窗重消费 ⇒ 领域幂等键全命中）
  const beforeReplay = totalBeliefEvents(await beliefCounts())
  await forceWatermark(
    BELIEF_INTERACTION_EVALUATOR_NAME,
    BELIEF_INTERACTION_EVALUATOR_VERSION,
    3,
  )
  const replay1 = await maybeRunBeliefEvaluation(db, { characterId, activeUserId: USER, now: T0 + 16_000 })
  const replay2 = await maybeRunBeliefEvaluation(db, { characterId, activeUserId: USER, now: T0 + 16_500 })
  check(
    'r2-06',
    '重放零重复：水位回拨重消费 ⇒ 零新事件 + 水位复位（异步次序与重放安全）',
    replay1.kind === 'flushed' &&
      replay1.outcome.applied.createdEvents === 0 &&
      replay2.kind === 'no_tail' &&
      totalBeliefEvents(await beliefCounts()) === beforeReplay &&
      (await interactionWatermark()) === latestAfterUnqualified,
    `replay1.created=${replay1.kind === 'flushed' ? String(replay1.outcome.applied.createdEvents) : '-'} replay2=${replay2.kind} events=${String(totalBeliefEvents(await beliefCounts()))}/${String(beforeReplay)}`,
  )

  // =========================================================================
  // §3 页边界（2000/2001/4001；窗口钳位 ⇒ 读了 = 全读）
  // =========================================================================
  section('§3 页边界（2000 / 2001 / 4001 —— 钳位，不跳读）')

  // r3-01：恰好 2000 ⇒ 一页吃完
  const base2000 = latestAfterUnqualified
  await bulkUnqualified(2000, base2000 + 1)
  const p1a = await maybeRunBeliefEvaluation(db, { characterId, activeUserId: USER, now: T0 + 20_000 })
  const p1b = await maybeRunBeliefEvaluation(db, { characterId, activeUserId: USER, now: T0 + 20_500 })
  check(
    'r3-01',
    '2000 事件 ⇒ 单页 [W+1, W+2000] 吃完，随后 no_tail（页边界不丢不重）',
    p1a.kind === 'flushed' &&
      p1a.window.from === base2000 + 1 &&
      p1a.window.to === base2000 + 2000 &&
      p1b.kind === 'no_tail' &&
      (await interactionWatermark()) === base2000 + 2000,
    `window=${p1a.kind === 'flushed' ? `[${String(p1a.window.from)},${String(p1a.window.to)}]` : '-'} next=${p1b.kind} wm=${String(await interactionWatermark())}`,
  )

  // r3-02：2001 ⇒ 两页（2000 + 1）
  const base2001 = base2000 + 2000
  await bulkUnqualified(2001, base2001 + 1)
  const p2a = await maybeRunBeliefEvaluation(db, { characterId, activeUserId: USER, now: T0 + 21_000 })
  const p2b = await maybeRunBeliefEvaluation(db, { characterId, activeUserId: USER, now: T0 + 21_500 })
  const p2c = await maybeRunBeliefEvaluation(db, { characterId, activeUserId: USER, now: T0 + 21_700 })
  check(
    'r3-02',
    '2001 事件 ⇒ 两页 [2000]+[1]，随后 no_tail（余量留尾窗，水位不越过未读事件）',
    p2a.kind === 'flushed' &&
      p2a.window.from === base2001 + 1 &&
      p2a.window.to === base2001 + 2000 &&
      p2b.kind === 'flushed' &&
      p2b.window.from === base2001 + 2001 &&
      p2b.window.to === base2001 + 2001 &&
      p2c.kind === 'no_tail',
    `p1=${p2a.kind === 'flushed' ? `[${String(p2a.window.from)},${String(p2a.window.to)}]` : '-'} p2=${p2b.kind === 'flushed' ? `[${String(p2b.window.from)},${String(p2b.window.to)}]` : '-'} next=${p2c.kind}`,
  )

  // r3-03：4001 ⇒ 三页（2000 + 2000 + 1）
  const base4001 = base2001 + 2001
  await bulkUnqualified(4001, base4001 + 1)
  const pages: { from: number; to: number }[] = []
  for (let i = 0; i < 5; i += 1) {
    const run = await maybeRunBeliefEvaluation(db, { characterId, activeUserId: USER, now: T0 + 22_000 + i * 500 })
    if (run.kind === 'flushed') pages.push({ from: run.window.from, to: run.window.to })
    if (run.kind === 'no_tail') break
  }
  const finalWatermark = await interactionWatermark()
  check(
    'r3-03',
    '4001 事件 ⇒ 三页 2000+2000+1 吃完（页边界判据全过；读了 = 全读）',
    pages.length === 3 &&
      pages[0].to - pages[0].from + 1 === 2000 &&
      pages[1].to - pages[1].from + 1 === 2000 &&
      pages[2].to - pages[2].from + 1 === 1 &&
      finalWatermark === base4001 + 4001,
    `pages=${String(pages.length)} widths=${pages.map((p) => String(p.to - p.from + 1)).join('+')} wm=${String(finalWatermark)}`,
  )

  // =========================================================================
  // §4 断点覆盖（enqueue / apply / finish / watermark）
  // =========================================================================
  section('§4 断点覆盖（播种断点 · apply 断点 · 水位断点）')

  // r4-01：播种断点（ORIGIN 在库但水位落后 cutover ⇒ 恢复不重放）
  const beforeSeedRecovery = totalBeliefEvents(await beliefCounts())
  await forceWatermark(BELIEF_INTERACTION_EVALUATOR_NAME, BELIEF_INTERACTION_EVALUATOR_VERSION, 0)
  let seedRecoveryRuns = 0
  let seedRecoveryOutcome: Awaited<ReturnType<typeof maybeRunBeliefEvaluation>> | undefined
  for (let i = 0; i < 20; i += 1) {
    seedRecoveryOutcome = await maybeRunBeliefEvaluation(db, {
      characterId,
      activeUserId: USER,
      now: T0 + 30_000 + i * 500,
    })
    seedRecoveryRuns += 1
    if (seedRecoveryOutcome.kind === 'no_tail') break
  }
  check(
    'r4-01',
    '播种断点：水位落后 cutover ⇒ 从投影重读补推进，重放全撞键零新事件',
    seedRecoveryOutcome?.kind === 'no_tail' &&
      totalBeliefEvents(await beliefCounts()) === beforeSeedRecovery &&
      (await interactionWatermark()) === finalWatermark,
    `runs=${String(seedRecoveryRuns)} events=${String(totalBeliefEvents(await beliefCounts()))}/${String(beforeSeedRecovery)} wm=${String(await interactionWatermark())}`,
  )

  // r4-02：apply 断点（append 成功、fold 失败 ⇒ job 如实 failed + 水位不动）
  const ev13 = await qualified('以后都这么讲，每一步都写出来', CONV_C)
  const beforeApplyBreak = totalBeliefEvents(await beliefCounts())
  const failingDb = withFailingProjectionWrites(db)
  const applyBreakRun = await maybeRunBeliefEvaluation(failingDb, {
    characterId,
    activeUserId: USER,
    now: T0 + 31_000,
  })
  const failedJobs = await listJobs(db, characterId, { status: 'failed', limit: 10 })
  const interactionFailedJob = failedJobs.find(
    (j) => j.processor === BELIEF_INTERACTION_EVALUATOR_NAME,
  )
  const notedAfterBreak = (await beliefCounts())['BELIEF_EVIDENCE_NOTED'] ?? 0
  const reinforcedAfterBreak = (await beliefCounts())['BELIEF_REINFORCED'] ?? 0
  const accAfterBreak = await getBeliefEvidence(db, characterId, evidenceRowKey)
  const rootInAccAfterBreak =
    accAfterBreak !== undefined && accAfterBreak.state.rootIds.map(String).includes(ev13.id)
  const beliefAfterBreak = await getBelief(db, characterId, inferredBeliefId as never)
  const rootInBeliefAfterBreak =
    beliefAfterBreak !== undefined &&
    beliefAfterBreak.state.evidenceRootIds.map(String).includes(ev13.id)
  check(
    'r4-02',
    'apply 断点：append 成功 fold 失败 ⇒ job failed 如实 + 水位不动 + 投影滞后可见',
    applyBreakRun.kind === 'failed' &&
      interactionFailedJob !== undefined &&
      String(interactionFailedJob.lastError ?? '').includes('m9-wp6-injected-projection-write-failure') &&
      notedAfterBreak === 4 && // ev4/5/6 的 3 条 + 断点轮 ev13 的 1 条（append 成功）
      reinforcedAfterBreak === 1 && // 同值现存 ⇒ 新根即强化（append 成功、fold 失败）
      !rootInAccAfterBreak && // fold 失败 ⇒ 累计行没有新根（滞后是真实状态）
      !rootInBeliefAfterBreak && // 信念行同样缺新根
      (await interactionWatermark()) === finalWatermark,
    `kind=${applyBreakRun.kind} jobFailed=${String(interactionFailedJob !== undefined)} noted=${String(notedAfterBreak)} reinforced=${String(reinforcedAfterBreak)} rootFolded=${String(rootInAccAfterBreak)}/${String(rootInBeliefAfterBreak)} wm=${String(await interactionWatermark())}`,
  )
  void beforeApplyBreak

  // r4-03：断点重试（健康库）⇒ 同窗全撞键零新事件 + 水位前进
  const beforeRetry = totalBeliefEvents(await beliefCounts())
  const retryRun = await maybeRunBeliefEvaluation(db, {
    characterId,
    activeUserId: USER,
    now: T0 + 32_000,
  })
  check(
    'r4-03',
    '断点重试：同窗重消费 ⇒ 零新事件（领域键）+ 水位前进（补洞语义）',
    retryRun.kind === 'flushed' &&
      retryRun.outcome.applied.createdEvents === 0 &&
      totalBeliefEvents(await beliefCounts()) === beforeRetry &&
      (await interactionWatermark()) === ev13.sequence,
    `kind=${retryRun.kind} created=${retryRun.kind === 'flushed' ? String(retryRun.outcome.applied.createdEvents) : '-'} wm=${String(await interactionWatermark())}`,
  )

  // r4-04：投影滞后修复（rebuild —— 投影是派生的，INV ②）
  const activeBeforeRebuild = (await listActiveBeliefs(db, characterId)).length
  await rebuildBeliefProjections(db, characterId)
  const accAfterRebuild = await getBeliefEvidence(db, characterId, evidenceRowKey)
  const rootAfterRebuild =
    accAfterRebuild !== undefined && accAfterRebuild.state.rootIds.map(String).includes(ev13.id)
  const beliefAfterRebuild = await getBelief(db, characterId, inferredBeliefId as never)
  const rootInBeliefAfterRebuild =
    beliefAfterRebuild !== undefined &&
    beliefAfterRebuild.state.evidenceRootIds.map(String).includes(ev13.id)
  check(
    'r4-04',
    'rebuild 修复投影滞后：累计行与信念行都补上新根（派生一致性）',
    rootAfterRebuild &&
      rootInBeliefAfterRebuild &&
      beliefAfterRebuild?.state.status === 'active' &&
      (await listActiveBeliefs(db, characterId)).length === activeBeforeRebuild,
    `accRoot=${String(rootAfterRebuild)} beliefRoot=${String(rootInBeliefAfterRebuild)} actives=${String((await listActiveBeliefs(db, characterId)).length)}/${String(activeBeforeRebuild)}`,
  )

  // r4-05：水位断点（job 已 completed ⇒ recovered 只补水位，不改写 completed）
  const retryWindow = retryRun.kind === 'flushed' ? retryRun.window : undefined
  const beforeWmBreak = totalBeliefEvents(await beliefCounts())
  await forceWatermark(
    BELIEF_INTERACTION_EVALUATOR_NAME,
    BELIEF_INTERACTION_EVALUATOR_VERSION,
    (retryWindow?.from ?? ev13.sequence) - 1,
  )
  const wmBreakRun = await maybeRunBeliefEvaluation(db, {
    characterId,
    activeUserId: USER,
    now: T0 + 33_000,
  })
  const completedJobIntact =
    wmBreakRun.kind === 'recovered' ? (await getJob(db, wmBreakRun.jobId as never))?.status : undefined
  const recoveredDescribed =
    wmBreakRun.kind === 'recovered' ? describeBeliefScheduling(wmBreakRun) : ''
  check(
    'r4-05',
    '水位断点：同窗 job 已 completed ⇒ recovered 只补水位（completed 不被改写成 failed）',
    wmBreakRun.kind === 'recovered' &&
      completedJobIntact === 'completed' &&
      totalBeliefEvents(await beliefCounts()) === beforeWmBreak &&
      (await interactionWatermark()) === ev13.sequence &&
      recoveredDescribed.includes('水位断点恢复'),
    `kind=${wmBreakRun.kind} jobStatus=${String(completedJobIntact)} wm=${String(await interactionWatermark())} describe=${recoveredDescribed.slice(0, 40)}`,
  )

  // =========================================================================
  // §5 Memory 流端到端 + 双水位独立
  // =========================================================================
  section('§5 Memory 流端到端（B-REPORTED 形成 · 失效传播 · 双水位独立）')

  // 夹具：一条真实 Memory（MEMORY_CREATED 走真 append + 真 fold → memories 行）
  const memRootEvent = await qualified('今天天气不错', CONV_A)
  const memId = 'mem-m9-wp6-001'
  const memPredicate = 'preference.answer_length'
  const memValue = 'concise_summary'
  const memScope = beliefReportedScopeKeyOf({ context: 'technical' })
  const memRecord: MemoryRecord = {
    id: memId as never,
    owner: entityRef('character', String(characterId)),
    type: 'preference',
    content: {
      kind: 'claim',
      subject: USER_ENTITY,
      predicate: memPredicate,
      value: memValue,
      qualifiers: { context: 'technical' },
    } as never,
    subjects: [USER_ENTITY],
    epistemicStatus: 'reported',
    authority: 'EXPLICIT_USER_STATEMENT',
    importance: 0.8,
    confidence: 0.9,
    status: 'active',
    sourceRefs: [conversationEvidence(memRootEvent.id)],
    evidenceRootIds: [memRootEvent.id],
    recordedAt: T0 + 40_000,
    contentFingerprint: 'm9-wp6-mem-fp-1',
    revision: 0,
    canonicalKey: 'm9-wp6:answer-length',
    // 行级必填（insertRecord 直插这些列；真实路径由记录构造方填写）
    reducerVersion: MEMORY_REDUCER_VERSION,
    schemaVersion: MEMORY_SCHEMA_VERSION,
    createdAt: T0 + 40_000,
  } as unknown as MemoryRecord
  const memCreatedAccepted: AcceptedDomainEvent = {
    type: 'MEMORY_CREATED',
    operation: 'create',
    payload: { memoryId: memId, mutation: 'explicit', record: memRecord },
    sourceConversationEventIds: [memRootEvent.id as never],
    idempotencyKey: 'm9-wp6:memory:create:001',
    processor: 'm9-wp6-gate',
    processorVersion: 'm9-wp6-gate@1',
    scope: DOMAIN_EVENT_SCOPE,
  }
  const memCreatedAppend = await appendDomainEvent(db, characterId, memCreatedAccepted, T0 + 40_100)
  await applyMemoryEvent(db, memCreatedAppend.event, T0 + 40_200)
  check(
    'r5-00',
    '前置：MEMORY_CREATED 落库 + memory 行折叠（真路径夹具）',
    memCreatedAppend.created,
    `created=${String(memCreatedAppend.created)}`,
  )

  // r5-01：交互流无尾窗时，Memory 流独立消费（方向 1：互不阻塞）
  // ⚠️ Memory 流的水位空间 = character_domain_events.sequence，与对话事件
  // **共享同一计数器**（M2.5）——bulk 夹具把领域序号推到 ~8000+，窗口钳位
  // ⇒ 一轮只吃一页。追赶必须循环到 no_tail（生产语义：余量留尾窗）。
  const runMemoryStream = async (baseNow: number, cap = 20) => {
    const kinds: string[] = []
    let formed = 0
    let invalidation = 0
    let created = 0
    for (let i = 0; i < cap; i += 1) {
      const run = await maybeRunBeliefMemoryReconciliation(db, {
        characterId,
        now: baseNow + i * 500,
      })
      kinds.push(run.kind)
      if (run.kind === 'flushed') {
        formed += run.outcome.formedProposals
        invalidation += run.outcome.invalidationProposals
        created += run.outcome.applied.createdEvents
      }
      if (run.kind === 'no_tail') break
    }
    return { kinds, formed, invalidation, created }
  }
  const interactionIdle = await maybeRunBeliefEvaluation(db, {
    characterId,
    activeUserId: USER,
    now: T0 + 41_000,
  })
  const memoryCatchUp1 = await runMemoryStream(T0 + 41_500)
  const reportedSlot = beliefSlotKeyOf({
    perspectiveOwnerId: asEntityId(String(characterId)),
    subject: USER_ENTITY,
    predicate: memPredicate,
    scopeKey: memScope,
  })
  const reportedBelief = (await listActiveBeliefs(db, characterId)).find(
    (b) => b.epistemicKind === 'reported' && b.proposition.value === memValue,
  )
  check(
    'r5-01',
    'MEMORY_CREATED → B-REPORTED 形成（交互流不阻塞 Memory 流；钳位分页追赶）',
    interactionIdle.kind === 'flushed' &&
      memoryCatchUp1.kinds[memoryCatchUp1.kinds.length - 1] === 'no_tail' &&
      memoryCatchUp1.formed >= 1 &&
      reportedBelief !== undefined &&
      reportedBelief.status === 'active' &&
      (reportedBelief.dependsOnMemoryIds ?? []).map(String).includes(memId),
    `interaction=${interactionIdle.kind} runs=${String(memoryCatchUp1.kinds.length)} kinds=${memoryCatchUp1.kinds.join('>')} formed=${String(memoryCatchUp1.formed)}`,
  )

  // r5-02：双水位行并存且独立（两条具名流，互不覆盖）
  const wmInteraction = await interactionWatermark()
  const wmMemory = await memoryWatermark()
  check(
    'r5-02',
    '双水位独立：interaction 与 memory 各自的具名水位行（ADR-070 §6.3）',
    wmInteraction >= ev13.sequence && wmMemory >= memCreatedAppend.event.sequence,
    `interactionWm=${String(wmInteraction)} memoryWm=${String(wmMemory)}`,
  )

  // r5-03：Memory 流重放零重复
  const beforeMemReplay = totalBeliefEvents(await beliefCounts())
  await forceWatermark(BELIEF_MEMORY_RECONCILER_NAME, BELIEF_MEMORY_RECONCILER_VERSION, 0)
  const memReplay = await runMemoryStream(T0 + 42_000)
  check(
    'r5-03',
    'Memory 流重放零重复：水位回拨重消费 ⇒ 零新事件 + 水位复位（completed 窗走 recovered）',
    memReplay.kinds[memReplay.kinds.length - 1] === 'no_tail' &&
      memReplay.created === 0 &&
      totalBeliefEvents(await beliefCounts()) === beforeMemReplay,
    `runs=${String(memReplay.kinds.length)} kinds=${memReplay.kinds.join('>')} created=${String(memReplay.created)} events=${String(totalBeliefEvents(await beliefCounts()))}/${String(beforeMemReplay)}`,
  )

  // r5-04：MEMORY_RETRACTED → 依赖失效传播（RETRACTED(dependency_invalidated)，不禁根）
  const memRetractAccepted: AcceptedDomainEvent = {
    type: 'MEMORY_RETRACTED',
    operation: 'create',
    payload: { memoryId: memId, reason: 'explicit_forget' },
    sourceConversationEventIds: [],
    idempotencyKey: 'm9-wp6:memory:retract:001',
    processor: 'm9-wp6-gate',
    processorVersion: 'm9-wp6-gate@1',
    scope: DOMAIN_EVENT_SCOPE,
  }
  const memRetractAppend = await appendDomainEvent(db, characterId, memRetractAccepted, T0 + 43_000)
  await applyMemoryEvent(db, memRetractAppend.event, T0 + 43_100)
  const invalidationCatchUp = await runMemoryStream(T0 + 43_500)
  const retractedBeliefRow = reportedBelief
    ? (await listActiveBeliefs(db, characterId)).find((b) => String(b.beliefId) === String(reportedBelief.beliefId))
    : undefined
  const beliefRowAfterRetract = retractedBeliefRow === undefined && reportedBelief !== undefined
  const retractedEvents = await domainEventsFor(db, characterId, { type: 'BELIEF_RETRACTED' })
  const retractionReasons = retractedEvents.map(
    (e) => String((e.payload as Record<string, unknown>).reason ?? ''),
  )
  const forbiddenForReportedSlot = await forbiddenRootsForSlot(db, characterId, reportedSlot)
  check(
    'r5-04',
    'MEMORY_RETRACTED → 依赖失效传播：RETRACTED(dependency_invalidated)，不禁根（B31 通道）',
    invalidationCatchUp.kinds[invalidationCatchUp.kinds.length - 1] === 'no_tail' &&
      invalidationCatchUp.invalidation >= 1 &&
      retractionReasons.includes('dependency_invalidated') &&
      beliefRowAfterRetract && // active 集合里不再有它
      !forbiddenForReportedSlot.map(String).includes(memRootEvent.id), // 依赖失效不禁根
    `runs=${String(invalidationCatchUp.kinds.length)} invalidation=${String(invalidationCatchUp.invalidation)} reasons=${retractionReasons.join('|')} forbidden含根=${String(forbiddenForReportedSlot.map(String).includes(memRootEvent.id))}`,
  )

  // r5-05：失效传播重放零重复
  const beforeInvReplay = totalBeliefEvents(await beliefCounts())
  await forceWatermark(BELIEF_MEMORY_RECONCILER_NAME, BELIEF_MEMORY_RECONCILER_VERSION, 0)
  const invReplay = await runMemoryStream(T0 + 44_000)
  check(
    'r5-05',
    '失效传播重放零重复：信念已终态 ⇒ planMemoryInvalidation noop + 领域键拦截',
    invReplay.kinds[invReplay.kinds.length - 1] === 'no_tail' &&
      invReplay.created === 0 &&
      totalBeliefEvents(await beliefCounts()) === beforeInvReplay,
    `runs=${String(invReplay.kinds.length)} kinds=${invReplay.kinds.join('>')} created=${String(invReplay.created)} events=${String(totalBeliefEvents(await beliefCounts()))}/${String(beforeInvReplay)}`,
  )

  // r5-06：方向 2 独立——Memory 流 no_tail 时交互流照常消费
  const ev15 = await qualified('今天天气不错', CONV_A)
  const memIdle = await maybeRunBeliefMemoryReconciliation(db, { characterId, now: T0 + 45_000 })
  const interactionFlush = await maybeRunBeliefEvaluation(db, {
    characterId,
    activeUserId: USER,
    now: T0 + 45_500,
  })
  check(
    'r5-06',
    '方向 2 独立：Memory 流 no_tail 不阻塞交互流（新对话事件照常消费）',
    memIdle.kind === 'no_tail' &&
      interactionFlush.kind === 'flushed' &&
      (await interactionWatermark()) === ev15.sequence,
    `memory=${memIdle.kind} interaction=${interactionFlush.kind} wm=${String(await interactionWatermark())}`,
  )

  // =========================================================================
  // 汇总 + 证据
  // =========================================================================
  const passed = checks.filter((c) => c.pass).length
  const failed = checks.length - passed
  console.log('\n---')
  console.log(
    `M9 runtime verify：${String(checks.length)} 项 · 通过 ${String(passed)} · 失败 ${String(failed)}`,
  )

  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  const runId = createM9RunId({ wpId: 'wp6-runtime', headShort: head })
  const dir = openM9RunDir(REPO_ROOT, runId)
  writeFileSync(
    join(dir, 'runtime-verify.json'),
    `${JSON.stringify(
      {
        schema: 'm9-wp6-runtime-verify@1',
        runId,
        head,
        checks,
        summary: { total: checks.length, passed, failed },
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  writeM9Manifest(dir, {
    runId,
    wp: 'wp6',
    head,
    headShort: head.slice(0, 12),
    branch: execFileSync('git', ['branch', '--show-current'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim(),
    date: new Date().toISOString().slice(0, 10),
    toolVersions: { node: process.version },
    testType: 'verify',
    counts: { total: checks.length, passed, failed },
    phases: [
      'flags',
      'seed-cutover',
      'interaction-window',
      'page-boundaries',
      'breakpoints',
      'memory-stream-dual-watermark',
    ],
    supersedes: null,
    notes:
      '生产装配路径==受测路径（真库真调度器）· 冷启动播种/cutover 不重放 · 同轮记根/累计/形成 · ' +
      '全不合格窗口水位有界 · 2000/2001/4001 页钳位 · 播种/apply/水位断点恢复（job 如实 failed，' +
      'completed 不改写）· Memory 流 B-REPORTED 形成 + 依赖失效传播不禁根 · 双水位独立 · 重放零重复',
    mode: 'offline',
    databaseScope: 'isolated',
  })
  console.log(`runId: ${runId}`)

  process.exitCode = failed === 0 ? 0 : 1
}

await main()
