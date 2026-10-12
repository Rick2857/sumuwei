/**
 * M11 WP2 —— **派生链传输门**（`m11:lineage:verify`）。
 *
 * ============================================================================
 *  本门要测的命题（先写命题，再写量具）
 * ============================================================================
 * ```text
 * 「ADR-085 `D25` 说的那条链**真的通了**」：
 *   ① 提案 → Validator → AcceptedDomainEvent → **写入** → 读回，逐字一致；
 *   ② 不带该字段的**旧调用者行为逐字不变**（写 null、读回 undefined、不补写历史）；
 *   ③ 违法的父（不存在 / 别角色）**拒收**；装配缺查询口 ⇒ **失败关闭**；
 *   ④ 结构非法（空数组 / 重复元素）在 createProposal 就被挡下；
 *   ⑤ 已有的旧行**没有被回写**（payload 与序号逐字不变）。
 * ```
 *
 * ⚠️ WP0 的读数说得很清楚：**「字段已存在」不是「链路已具备」**。
 *    因此本门**必须真的 append + 真的读回**，不接受"类型能编译"当证据。
 *
 * ============================================================================
 *  硬边界（判据，不是注释）
 * ============================================================================
 *  · **零模型调用、零出网**；数据库是 `isolateDatabase()` 的**一次性沙箱**。
 *  · 每个负控都断言**具名理由码**，而不是"没成功"——否则"被拒"与"执行器不工作"长得一样。
 *  · 正控与负控**同时存在**（AGENTS §6.3）：A 组必须有非零成功样本，B 组必须有非零拒绝样本。
 *  · `measured_count > 0` 自检：任一组"检查了 0 项" ⇒ 整门判 MEASUREMENT INVALID。
 *
 * 用法：
 *   pnpm m11:lineage:verify [--out artifacts/m11/<runId>]
 */

import 'dotenv/config'

import { isolateDatabase } from '../src/dev/sandbox.ts'

// ⚠️ 必须在**任何**碰数据库的 import 之前（AGENTS §7）：否则构造的是真实库。
isolateDatabase('m11-lineage-verify', { keep: false })

import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { sql } from 'drizzle-orm'

import { M4_T0, createM4Harness } from './m4-harness.ts'
import {
  M11_MANIFEST_VERSION,
  createM11RunId,
  openM11RunDir,
  runIdFromM11OutPath,
  writeM11Manifest,
} from './m11-evidence.ts'
import { DIAGNOSTIC_SIGNAL, createFullDomainEventRegistry } from '../src/kernel/contracts/domain-event.ts'
import {
  asDomainEventId,
  type CharacterId,
  type ConversationEventId,
  type DomainEventId,
} from '../src/kernel/contracts/ids.ts'
import { createProposal } from '../src/kernel/contracts/proposal.ts'
import {
  createDomainPolicyValidator,
  type AcceptedDomainEvent,
  type DomainEventParentLookup,
} from '../src/kernel/policies/validator.ts'
import { expandLineage } from '../src/kernel/app/reflection/lineage.ts'
import type {
  LineageBeliefReading,
  LineageConversationReading,
  LineageDomainEventReading,
  LineageHandle,
  LineageLookup,
  LineageMemoryReading,
} from '../src/kernel/contracts/reflection-lineage.ts'
import { getConversationEvent } from '../src/infrastructure/persistence/conversation-store.ts'
import { exec } from '../src/infrastructure/persistence/db.ts'
import { createReflectionLineageLookup } from '../src/infrastructure/persistence/reflection-lineage-read.ts'
import {
  appendDomainEvent,
  domainEventsFor,
  getDomainEvent,
} from '../src/infrastructure/persistence/event-store.ts'

const REPO_ROOT = resolve(process.cwd())

type Db = Parameters<typeof appendDomainEvent>[0]

interface Check {
  id: string
  group: 'A' | 'B' | 'C' | 'D' | 'E' | 'S'
  label: string
  pass: boolean
  detail: string
}

const checks: Check[] = []

function record(id: string, group: Check['group'], label: string, pass: boolean, detail: string): void {
  checks.push({ id, group, label, pass, detail })
}

/** 把一条 accepted 事件包成最小形状（本门不需要 payload 语义）。 */
function acceptedProbe(input: {
  key: string
  sources: string[]
  causedBy?: DomainEventId[]
}): AcceptedDomainEvent {
  return {
    type: DIAGNOSTIC_SIGNAL,
    operation: 'm11-lineage-probe',
    payload: { counterDelta: 1 },
    sourceConversationEventIds: input.sources as AcceptedDomainEvent['sourceConversationEventIds'],
    idempotencyKey: input.key,
    processor: 'm11-lineage-verify',
    processorVersion: 'm11-lineage-verify@1',
    scope: 'CHARACTER_INTERNAL',
    ...(input.causedBy === undefined ? {} : { causedByDomainEventIds: input.causedBy }),
  }
}

/** 原始列读数（**不经** rowToDomainEvent 的映射）——"是 SQL NULL"与"没有数组"是两件事。 */
async function rawCausedBy(db: Db, id: string): Promise<unknown> {
  const rows = await exec(
    db,
    sql`select caused_by_domain_event_ids as v from character_domain_events where id = ${id} limit 1`,
    'M11 lineage：原始列读取'
  )
  return rows[0]?.v
}

/** 真实父事件查询口：走既有的 `getDomainEvent()`（读面唯一入口）。 */
function parentLookupOf(db: Db): DomainEventParentLookup {
  return {
    async findByIds(ids) {
      const out: { id: DomainEventId; characterId: CharacterId; sequence: number }[] = []
      for (const id of ids) {
        const event = await getDomainEvent(db, id)
        if (event !== undefined) {
          out.push({ id: event.id, characterId: event.characterId, sequence: event.sequence })
        }
      }
      return out
    },
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  let out: string | undefined
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--out') out = args[++i]
    else throw new Error(`未知参数：${JSON.stringify(args[i])}`)
  }

  const h = await createM4Harness({ label: 'm11-lineage-verify' })
  const db = h.db
  const characterId = h.kernel.characterId as CharacterId

  // -------------------------------------------------------------------------
  // 来源：一条**真实**对话事件（Validator 要求来源真实存在）
  // -------------------------------------------------------------------------
  const evidence = await h.recordUserEvidence('这是一条用于派生链验证的真实对话事件。')
  const sourceId = evidence.event.id

  // -------------------------------------------------------------------------
  // A 组 —— 传输：append → readback（正向，非零样本）
  // -------------------------------------------------------------------------
  const legacyParent = await appendDomainEvent(
    db,
    characterId,
    acceptedProbe({ key: 'm11-lineage:A-legacy-parent', sources: [sourceId] }),
    M4_T0 + 10
  )
  const parentId = legacyParent.event.id
  const legacyRaw = await rawCausedBy(db, String(parentId))
  const legacyRead = await getDomainEvent(db, parentId)

  record(
    'A1',
    'A',
    '不带 `causedByDomainEventIds` 的旧调用者：写入成功且**读回 undefined**（旧行为逐字不变）',
    legacyParent.created && legacyRead?.causedByDomainEventIds === undefined,
    `created=${String(legacyParent.created)} · readback=${JSON.stringify(legacyRead?.causedByDomainEventIds)}`
  )
  record(
    'A2',
    'A',
    '该行的**原始列**是 SQL NULL（不是空数组 —— 两者在库里长得不同）',
    legacyRaw === null,
    `raw=${JSON.stringify(legacyRaw)}（typeof=${typeof legacyRaw}）`
  )

  const child = await appendDomainEvent(
    db,
    characterId,
    acceptedProbe({ key: 'm11-lineage:A-child', sources: [sourceId], causedBy: [parentId] }),
    M4_T0 + 20
  )
  const childRead = await getDomainEvent(db, child.event.id)
  const childRaw = await rawCausedBy(db, String(child.event.id))
  const childIds = (childRead?.causedByDomainEventIds ?? []).map((id) => String(id))
  record(
    'A3',
    'A',
    '带一个父事件：append → 读回**恰好那一个** id（真实往返，不是类型检查）',
    childIds.length === 1 && childIds[0] === String(parentId),
    `readback=${JSON.stringify(childIds)} · 期望=[${String(parentId)}]`
  )
  record(
    'A4',
    'A',
    '原始列真的是 JSON 数组（与 A2 的 NULL 形成对照）',
    Array.isArray(childRaw) && (childRaw as unknown[]).length === 1,
    `raw=${JSON.stringify(childRaw)}`
  )

  const grandChild = await appendDomainEvent(
    db,
    characterId,
    acceptedProbe({
      key: 'm11-lineage:A-grandchild',
      sources: [sourceId],
      causedBy: [parentId, child.event.id],
    }),
    M4_T0 + 30
  )
  const grandIds = (await getDomainEvent(db, grandChild.event.id))?.causedByDomainEventIds ?? []
  record(
    'A5',
    'A',
    '两个父事件：顺序与集合逐字保持（多跳链的基础）',
    grandIds.length === 2 &&
      String(grandIds[0]) === String(parentId) &&
      String(grandIds[1]) === String(child.event.id),
    `readback=${JSON.stringify(grandIds.map(String))}`
  )

  const beforeReplay = (await domainEventsFor(db, characterId, { type: DIAGNOSTIC_SIGNAL })).length
  const replay = await appendDomainEvent(
    db,
    characterId,
    acceptedProbe({ key: 'm11-lineage:A-child', sources: [sourceId], causedBy: [parentId] }),
    M4_T0 + 40
  )
  const afterReplay = (await domainEventsFor(db, characterId, { type: DIAGNOSTIC_SIGNAL })).length
  record(
    'A6',
    'A',
    '同一幂等键重投（带同样的父）⇒ 不产生第二份业务事件（幂等仍然有效）',
    replay.created === false && afterReplay === beforeReplay,
    `second.created=${String(replay.created)} · 信号事件数 ${String(beforeReplay)}→${String(afterReplay)}`
  )

  // -------------------------------------------------------------------------
  // B 组 —— 语义负控（Validator 必须**具名**拒收）
  // -------------------------------------------------------------------------
  const registry = createFullDomainEventRegistry()
  const sources = {
    async findEvents(
      ids: readonly ConversationEventId[]
    ): Promise<{ id: ConversationEventId; characterId: CharacterId; sequence: number }[]> {
      const rows: { id: ConversationEventId; characterId: CharacterId; sequence: number }[] = []
      for (const id of ids) {
        const event = await getConversationEvent(db, id)
        if (event !== undefined) {
          rows.push({ id: event.id, characterId: event.characterId, sequence: event.sequence })
        }
      }
      return rows
    },
  }
  const processed = { async hasProcessed() { return false } }

  const proposalFor = (causedBy: string[] | undefined, suffix: string): ReturnType<typeof createProposal> =>
    createProposal({
      characterId,
      proposalType: 'm11-lineage-probe',
      sourceConversationEventIds: [sourceId],
      payload: {},
      targetEvents: [
        {
          type: DIAGNOSTIC_SIGNAL,
          operation: 'signal',
          payload: { counterDelta: 1 },
          ...(causedBy === undefined
            ? {}
            : { causedByDomainEventIds: causedBy.map((id) => asDomainEventId(id)) }),
        },
      ],
      processor: 'm11-lineage-verify',
      processorVersion: `m11-lineage-verify@1-${suffix}`,
    })

  const withLookup = createDomainPolicyValidator({
    registry,
    sources,
    processed,
    parents: parentLookupOf(db),
  })
  const withoutLookup = createDomainPolicyValidator({ registry, sources, processed })

  // B1 —— 正控：合法父 ⇒ 放行，且放行结果**带着**派生链
  const okOutcome = await withLookup.validate(proposalFor([String(parentId)], 'ok'))
  const okEvents = okOutcome.acceptedEvents
  record(
    'B1',
    'B',
    '【正控】父事件存在且同角色 ⇒ 放行，且 `AcceptedDomainEvent` **带着**派生链（放行口记录它放行了什么）',
    okOutcome.accepted &&
      okEvents.length === 1 &&
      (okEvents[0]?.causedByDomainEventIds ?? []).map(String)[0] === String(parentId),
    `accepted=${String(okOutcome.accepted)} · rejected=${JSON.stringify(okOutcome.rejected.map((r) => r.code))} · ` +
      `carried=${JSON.stringify((okEvents[0]?.causedByDomainEventIds ?? []).map(String))}`
  )

  // B2 —— 负控：父不存在
  const missing = await withLookup.validate(proposalFor(['de:char_m11_lineage:99999'], 'missing'))
  record(
    'B2',
    'B',
    '【负控】父事件不存在 ⇒ `caused_by_parent_missing`，且**零** acceptedEvents',
    !missing.accepted && missing.rejected.some((r) => r.code === 'caused_by_parent_missing'),
    `codes=${JSON.stringify(missing.rejected.map((r) => r.code))}`
  )

  // B3 —— 负控：父属于别的角色
  const foreignParent = await appendDomainEvent(
    db,
    'char_m11_lineage_foreign' as CharacterId,
    acceptedProbe({ key: 'm11-lineage:B-foreign-parent', sources: [] }),
    M4_T0 + 50
  )
  const foreign = await withLookup.validate(proposalFor([String(foreignParent.event.id)], 'foreign'))
  record(
    'B3',
    'B',
    '【负控】父事件属于**别的角色** ⇒ `caused_by_parent_foreign`',
    !foreign.accepted && foreign.rejected.some((r) => r.code === 'caused_by_parent_foreign'),
    `codes=${JSON.stringify(foreign.rejected.map((r) => r.code))}`
  )

  // B4 —— 负控：装配没给查询口 ⇒ 失败关闭（不许"当作没有派生"）
  const noPort = await withoutLookup.validate(proposalFor([String(parentId)], 'noport'))
  record(
    'B4',
    'B',
    '【负控】字段出现但装配**没有**父查询口 ⇒ `caused_by_lookup_unavailable`（失败关闭，不静默丢链）',
    !noPort.accepted && noPort.rejected.some((r) => r.code === 'caused_by_lookup_unavailable'),
    `codes=${JSON.stringify(noPort.rejected.map((r) => r.code))}`
  )

  // B5 / B6 —— 结构非法：createProposal 阶段就挡下
  const structural = (causedBy: string[]): string => {
    try {
      proposalFor(causedBy, 'structural')
      return '(没有抛)'
    } catch (error) {
      return (error as { code?: string }).code ?? `(无 code: ${String(error)})`
    }
  }
  const emptyCode = structural([])
  const dupCode = structural([String(parentId), String(parentId)])
  record(
    'B5',
    'B',
    '【负控】空数组不是"没有派生"的表达方式 ⇒ `caused_by_malformed`',
    emptyCode === 'caused_by_malformed',
    `code=${emptyCode}`
  )
  record(
    'B6',
    'B',
    '【负控】同一父事件重复出现 ⇒ `caused_by_duplicate`（重复的父不能多计一次）',
    dupCode === 'caused_by_duplicate',
    `code=${dupCode}`
  )

  // -------------------------------------------------------------------------
  // C 组 —— 旧行未被回写（"不补写历史事件"的机器判据）
  // -------------------------------------------------------------------------
  const parentAfter = await getDomainEvent(db, parentId)
  record(
    'C1',
    'C',
    '旧行（A1 那条）在本门全部操作之后：payload / 序号 / 派生列**逐字未变**',
    parentAfter !== undefined &&
      JSON.stringify(parentAfter.payload) === JSON.stringify(legacyParent.event.payload) &&
      parentAfter.sequence === legacyParent.event.sequence &&
      parentAfter.causedByDomainEventIds === undefined,
    `sequence ${String(legacyParent.event.sequence)}→${String(parentAfter?.sequence)} · ` +
      `payload 相同=${String(JSON.stringify(parentAfter?.payload) === JSON.stringify(legacyParent.event.payload))} · ` +
      `causedBy=${JSON.stringify(parentAfter?.causedByDomainEventIds)}`
  )

  const signals = await domainEventsFor(db, characterId, { type: DIAGNOSTIC_SIGNAL })
  record(
    'C2',
    'C',
    '事件总数与非空派生链条数都是**非零**（正控：本门真的写过东西，不是空跑）',
    signals.length >= 3 && signals.filter((e) => (e.causedByDomainEventIds ?? []).length > 0).length >= 2,
    `信号事件=${String(signals.length)} · 带派生链的=${String(signals.filter((e) => (e.causedByDomainEventIds ?? []).length > 0).length)}`
  )

  // -------------------------------------------------------------------------
  // D 组 —— 纯根解析器：**手算图**作独立 oracle（不复用 resolver 算 expected）
  // -------------------------------------------------------------------------
  const CH = 'char_m11_lineage_graph'
  const OTHER = 'char_m11_lineage_other'

  const G = {
    conversations: [
      { id: 'ce:1', characterId: CH, conversationId: 'conv-A', actorType: 'user' },
      { id: 'ce:2', characterId: CH, conversationId: 'conv-B', actorType: 'user' },
      { id: 'ce:3', characterId: CH, conversationId: 'conv-C', actorType: 'user' },
      { id: 'ce:a1', characterId: CH, conversationId: 'conv-A', actorType: 'assistant' },
    ] as LineageConversationReading[],
    domainEvents: [
      { id: 'de:10', characterId: CH, causedByDomainEventIds: [], sourceConversationEventIds: ['ce:1'] },
      { id: 'de:11', characterId: CH, causedByDomainEventIds: [], sourceConversationEventIds: ['ce:2'] },
      // 派生节点：自己没有对话来源，靠两个父事件追到 {ce:1, ce:2}
      { id: 'de:20', characterId: CH, causedByDomainEventIds: ['de:10', 'de:11'], sourceConversationEventIds: [] },
      // 多跳：根仍是 {ce:1, ce:2}，中间的 de:20 不是根
      { id: 'de:21', characterId: CH, causedByDomainEventIds: ['de:20'], sourceConversationEventIds: [] },
      // 追不到原始经历
      { id: 'de:30', characterId: CH, causedByDomainEventIds: [], sourceConversationEventIds: [] },
      // 环（写侧不可能造，但旧数据里可能）
      { id: 'de:X', characterId: CH, causedByDomainEventIds: ['de:Y'], sourceConversationEventIds: [] },
      { id: 'de:Y', characterId: CH, causedByDomainEventIds: ['de:X'], sourceConversationEventIds: [] },
    ] as LineageDomainEventReading[],
    memories: [
      { id: 'mem:A', characterId: CH, evidenceConversationEventIds: ['ce:1'] },
      { id: 'mem:B', characterId: CH, evidenceConversationEventIds: ['ce:2'] },
      { id: 'mem:C', characterId: CH, evidenceConversationEventIds: ['ce:3'] },
      { id: 'mem:FOREIGN', characterId: OTHER, evidenceConversationEventIds: ['ce:1'] },
    ] as LineageMemoryReading[],
    beliefs: [
      { id: 'bel:1', characterId: CH, evidenceRootIds: ['ce:1'], dependsOnMemoryIds: [] },
    ] as LineageBeliefReading[],
  }

  // 深度链：18 跳（< 64 节点 ⇒ 先过节点上限，再由**深度**触发拒收）
  for (let i = 0; i < 18; i += 1) {
    G.domainEvents.push({
      id: `de:deep${String(i)}`,
      characterId: CH,
      causedByDomainEventIds: i === 17 ? [] : [`de:deep${String(i + 1)}`],
      sourceConversationEventIds: i === 17 ? ['ce:1'] : [],
    })
  }
  // 节点链：70 个（> 64 ⇒ 由**节点上限**触发拒收）
  for (let i = 0; i < 70; i += 1) {
    G.domainEvents.push({
      id: `de:wide${String(i)}`,
      characterId: CH,
      causedByDomainEventIds: i === 69 ? [] : [`de:wide${String(i + 1)}`],
      sourceConversationEventIds: i === 69 ? ['ce:1'] : [],
    })
  }

  const graphLookup: LineageLookup = {
    async findConversationEvents(ids) {
      return G.conversations.filter((row) => ids.includes(row.id))
    },
    async findDomainEvents(ids) {
      return G.domainEvents.filter((row) => ids.includes(row.id))
    },
    async findMemories(ids) {
      return G.memories.filter((row) => ids.includes(row.id))
    },
    async findBeliefs(ids) {
      return G.beliefs.filter((row) => ids.includes(row.id))
    },
  }

  const resolve = async (handles: LineageHandle[]) =>
    await expandLineage(graphLookup, handles, { characterId: CH })
  const idsOf = (roots: readonly { id: string }[]): string[] => roots.map((r) => r.id)
  const rejectsOf = (r: { rejections: readonly { reason: string }[] }): string[] =>
    r.rejections.map((x) => x.reason)

  // D1 —— 同一根不增信（契约 §4.4 的第 2 行）
  const d1 = await resolve([
    { kind: 'memory', id: 'mem:A' },
    { kind: 'belief', id: 'bel:1' },
  ])
  record(
    'D1',
    'D',
    '【手算】mem:A(ce:1) + bel:1(roots ce:1) ⇒ 有效根**恰好 1**（同一个根经两条链进来不增信）',
    d1.rootCount === 1 && idsOf(d1.roots).join(',') === 'ce:1' && d1.derivedNodeCount === 2,
    `roots=${JSON.stringify(idsOf(d1.roots))} · rootCount=${String(d1.rootCount)} · derived=${String(d1.derivedNodeCount)} · 期望 roots=[ce:1] derived=2`
  )

  // D2 —— 两个不同根、两个会话
  const d2 = await resolve([
    { kind: 'memory', id: 'mem:A' },
    { kind: 'memory', id: 'mem:B' },
  ])
  record(
    'D2',
    'D',
    '【手算】mem:A + mem:B ⇒ 根 {ce:1, ce:2} = 2 · 会话 = 2',
    d2.rootCount === 2 && d2.conversationCount === 2 && idsOf(d2.roots).join(',') === 'ce:1,ce:2',
    `roots=${JSON.stringify(idsOf(d2.roots))} · conversations=${String(d2.conversationCount)}`
  )

  // D3 —— 派生节点不是根（多跳）
  const d3 = await resolve([{ kind: 'domain_event', id: 'de:21' }])
  record(
    'D3',
    'D',
    '【手算】de:21 → de:20 → {de:10,de:11} → {ce:1,ce:2} ⇒ 根 2 · **派生节点 4 且都不是根**',
    d3.rootCount === 2 &&
      d3.derivedNodeCount === 4 &&
      !idsOf(d3.roots).some((id) => id.startsWith('de:')),
    `roots=${JSON.stringify(idsOf(d3.roots))} · derived=${String(d3.derivedNodeCount)} · 期望 derived=4`
  )

  // D4 —— 三个根、三个会话（达 D10 门槛的正例形状）
  const d4 = await resolve([
    { kind: 'memory', id: 'mem:A' },
    { kind: 'memory', id: 'mem:B' },
    { kind: 'memory', id: 'mem:C' },
  ])
  record(
    'D4',
    'D',
    '【手算】三个独立根 / 三个会话 ⇒ rootCount=3 · conversationCount=3（D10 门槛的两分量）',
    d4.rootCount === 3 && d4.conversationCount === 3 && d4.usable,
    `roots=${JSON.stringify(idsOf(d4.roots))} · conversations=${String(d4.conversationCount)} · usable=${String(d4.usable)}`
  )

  // D5 —— 同一根经**派生链**与**直接引用**各来一次：仍然只算一个
  const d5 = await resolve([
    { kind: 'domain_event', id: 'de:21' },
    { kind: 'memory', id: 'mem:A' },
  ])
  record(
    'D5',
    'D',
    '【手算】de:21(根{ce:1,ce:2}) + mem:A(根 ce:1) ⇒ 合并后仍是 {ce:1, ce:2} = 2（不因多链增信）',
    d5.rootCount === 2 && idsOf(d5.roots).join(',') === 'ce:1,ce:2',
    `roots=${JSON.stringify(idsOf(d5.roots))} · rootCount=${String(d5.rootCount)}`
  )

  // D6 —— 环
  const d6 = await resolve([{ kind: 'domain_event', id: 'de:X' }])
  record(
    'D6',
    'D',
    '【负控·手算】de:X ⇄ de:Y ⇒ `lineage_cycle` 且 usable=false（环检测只在读旧数据时可能触发）',
    !d6.usable && rejectsOf(d6).includes('lineage_cycle'),
    `rejections=${JSON.stringify(rejectsOf(d6))}`
  )

  // D7 —— 深度超限（18 跳 < 64 节点 ⇒ 由深度触发）
  const d7 = await resolve([{ kind: 'domain_event', id: 'de:deep0' }])
  record(
    'D7',
    'D',
    '【负控·手算】18 跳链 ⇒ `lineage_limit_exceeded`，且明细说的是**深度**（D31：不截断假装齐全）',
    !d7.usable &&
      d7.rejections.some((r) => r.reason === 'lineage_limit_exceeded' && r.detail.includes('深度')),
    `rejections=${JSON.stringify(d7.rejections.map((r) => `${r.reason}:${r.detail.slice(0, 24)}`))}`
  )

  // D8 —— 节点上限（70 节点 > 64 ⇒ 由节点数触发）
  const d8 = await resolve([{ kind: 'domain_event', id: 'de:wide0' }])
  record(
    'D8',
    'D',
    '【负控·手算】70 节点链 ⇒ `lineage_limit_exceeded`，且明细说的是**展开节点**',
    !d8.usable &&
      d8.rejections.some((r) => r.reason === 'lineage_limit_exceeded' && r.detail.includes('展开节点')),
    `rejections=${JSON.stringify(d8.rejections.map((r) => `${r.reason}:${r.detail.slice(0, 24)}`))}`
  )

  // D9 —— 悬空引用
  const d9 = await resolve([{ kind: 'memory', id: 'mem:MISSING' }])
  record(
    'D9',
    'D',
    '【负控】handle 指向不存在的记忆 ⇒ 具名拒收（不是"根为空"）',
    !d9.usable && (rejectsOf(d9).includes('node_missing') || rejectsOf(d9).includes('handle_unknown')),
    `rejections=${JSON.stringify(rejectsOf(d9))}`
  )

  // D10 —— 跨角色
  const d10 = await resolve([{ kind: 'memory', id: 'mem:FOREIGN' }])
  record(
    'D10',
    'D',
    '【负控】handle 指向**别的角色**的记忆 ⇒ `node_foreign`',
    !d10.usable && rejectsOf(d10).includes('node_foreign'),
    `rejections=${JSON.stringify(rejectsOf(d10))}`
  )

  // D11 —— 追不到原始经历
  const d11 = await resolve([{ kind: 'domain_event', id: 'de:30' }])
  record(
    'D11',
    'D',
    '【负控·手算】de:30 无对话来源也无父 ⇒ `root_unresolvable`（缺根 ≠ 根为空）',
    !d11.usable && rejectsOf(d11).includes('root_unresolvable'),
    `rejections=${JSON.stringify(rejectsOf(d11))}`
  )

  // D12 —— measured_count 自检：空输入 ⇒ 0 读数 ⇒ 调用方必须判 INVALID
  const d12 = await resolve([])
  record(
    'D12',
    'D',
    '【量具自检】空 handle ⇒ `measuredCount = 0` 且 usable=false ⇒ **调用方必须判 MEASUREMENT INVALID**（AGENTS §6.8）',
    d12.measuredCount === 0 && !d12.usable && d12.rootCount === 0,
    `measuredCount=${String(d12.measuredCount)} · usable=${String(d12.usable)} · rootCount=${String(d12.rootCount)}`
  )

  // D13 —— 五类标签：程序事实优先于推断（user_statement vs user_report 由调用方给）
  const d13a = await resolve([{ kind: 'conversation_event', id: 'ce:1' }])
  const d13b = await resolve([{ kind: 'conversation_event', id: 'ce:a1' }])
  const d13c = await resolve([
    { kind: 'conversation_event', id: 'ce:1', classHint: 'user_report' },
  ])
  record(
    'D13',
    'D',
    '【手算】来源类分列：user 对话 ⇒ user_statement · assistant ⇒ assistant_speech · 调用方 classHint=user_report 时**以程序事实为准**',
    d13a.classCounts.user_statement === 1 &&
      d13b.classCounts.assistant_speech === 1 &&
      d13c.classCounts.user_report === 1 &&
      d13c.classCounts.user_statement === 0,
    `user=${String(d13a.classCounts.user_statement)} · assistant=${String(d13b.classCounts.assistant_speech)} · hint→user_report=${String(d13c.classCounts.user_report)}`
  )

  // D14 —— 分列守恒：五类计数之和 == rootCount
  const d14sum = Object.values(d4.classCounts).reduce((a, b) => a + b, 0)
  record(
    'D14',
    'D',
    '【量具自检】五类标签之和 == rootCount（分列不能凭空多出或少掉根）',
    d14sum === d4.rootCount && d4.classCounts.internal_interpretation === 0,
    `sum=${String(d14sum)} · rootCount=${String(d4.rootCount)} · classCounts=${JSON.stringify(d4.classCounts)}`
  )

  // -------------------------------------------------------------------------
  // E 组 —— **真实库 + 真实适配器**（不许只测内存图）
  // -------------------------------------------------------------------------
  const realLookup = createReflectionLineageLookup(db, { characterId })

  const e1 = await expandLineage(
    realLookup,
    [{ kind: 'conversation_event', id: String(sourceId) }],
    { characterId }
  )
  record(
    'E1',
    'E',
    '真实库：对话事件 handle ⇒ 它就是原始根（`measuredCount > 0`，不是空跑）',
    e1.rootCount === 1 && String(e1.roots[0]?.id) === String(sourceId) && e1.measuredCount > 0,
    `roots=${JSON.stringify(e1.roots.map((r) => r.id))} · measuredCount=${String(e1.measuredCount)}`
  )

  /*
   * E2 是最要紧的一条：造一个**自己没有对话来源**、只有 `causedBy` 的领域事件。
   * ⇒ 能追到根，就**只可能**是适配器真的读了 `caused_by_domain_event_ids` 列。
   */
  const derivedOnly = await appendDomainEvent(
    db,
    characterId,
    acceptedProbe({ key: 'm11-lineage:E-derived-only', sources: [], causedBy: [parentId] }),
    M4_T0 + 60
  )
  const e2 = await expandLineage(
    realLookup,
    [{ kind: 'domain_event', id: String(derivedOnly.event.id) }],
    { characterId }
  )
  record(
    'E2',
    'E',
    '真实库：只有 `causedBy`（**零**自有对话来源）的派生事件 ⇒ 经真实适配器追到父的对话来源（证明那一列真的被读）',
    String(derivedOnly.event.sourceConversationEventIds.length) === '0' &&
      e2.rootCount === 1 &&
      String(e2.roots[0]?.id) === String(sourceId),
    `自有来源数=${String(derivedOnly.event.sourceConversationEventIds.length)} · roots=${JSON.stringify(e2.roots.map((r) => r.id))} · 期望=[${String(sourceId)}]`
  )

  const e3 = await expandLineage(realLookup, [{ kind: 'memory', id: 'mem:does-not-exist' }], {
    characterId,
  })
  record(
    'E3',
    'E',
    '真实库：不存在的记忆 id ⇒ `node_missing`（真实查询返回空，不是"根为空"）',
    !e3.usable && e3.rejections.some((r) => r.reason === 'node_missing'),
    `rejections=${JSON.stringify(e3.rejections.map((r) => r.reason))}`
  )

  const e4Missing = await realLookup.findMemories(['mem:does-not-exist'])
  const e5Missing = await realLookup.findBeliefs(['bel:does-not-exist'])
  record(
    'E4',
    'E',
    '真实库：记忆 / 信念两条查询**可执行**（语法与列名正确，返回空集而不抛）',
    e4Missing.length === 0 && e5Missing.length === 0,
    `memories=${String(e4Missing.length)} · beliefs=${String(e5Missing.length)}（⚠️ 这只证明 SQL 可执行，不证明语义已覆盖）`
  )

  // -------------------------------------------------------------------------
  // S 组 —— 量具自检（AGENTS §6.8：0 检查 0 失败 = MEASUREMENT INVALID）
  // -------------------------------------------------------------------------
  const byGroup = { A: 0, B: 0, C: 0, D: 0, E: 0 }
  for (const c of checks) if (c.group !== 'S') byGroup[c.group] += 1
  record(
    'S1',
    'S',
    '五组都测到**非零**条目（否则本次读数判 MEASUREMENT INVALID，不是 PASS）',
    byGroup.A > 0 && byGroup.B > 0 && byGroup.C > 0 && byGroup.D > 0 && byGroup.E > 0,
    `A=${String(byGroup.A)} · B=${String(byGroup.B)} · C=${String(byGroup.C)} · D=${String(byGroup.D)} · E=${String(byGroup.E)}`
  )
  record(
    'S2',
    'S',
    '负控组的**具名理由码**覆盖了 D25 的四种拒收（missing / foreign / lookup_unavailable / malformed|duplicate）',
    ['caused_by_parent_missing', 'caused_by_parent_foreign', 'caused_by_lookup_unavailable'].every((code) =>
      checks.some((c) => c.detail.includes(code))
    ) && (emptyCode === 'caused_by_malformed' || dupCode === 'caused_by_duplicate'),
    `实到码=${JSON.stringify(checks.filter((c) => c.group === 'B').map((c) => c.detail))}`
  )

  // -------------------------------------------------------------------------
  // 落盘
  // -------------------------------------------------------------------------
  const failed = checks.filter((c) => !c.pass)
  const head = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  }).trim()
  const runId =
    out === undefined
      ? createM11RunId({ wpId: 'wp2', headShort: head })
      : runIdFromM11OutPath(REPO_ROOT, out)
  const dir = openM11RunDir(REPO_ROOT, runId)

  const payload = {
    schema: 'm11-lineage-verify@1',
    manifestVersion: M11_MANIFEST_VERSION,
    runId,
    head,
    databaseScope: 'isolated-sandbox',
    measuredCount: checks.length,
    checks,
    summary: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
    verdict: failed.length === 0 ? 'PASS' : 'FAIL',
  }
  writeFileSync(join(dir, 'lineage-verify.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  writeM11Manifest(dir, {
    runId,
    wp: 'wp2',
    head,
    headShort: head.slice(0, 12),
    branch: 'codex/m11-execution-plan',
    date: new Date().toISOString().slice(0, 10),
    toolVersions: { node: process.version },
    testType: 'lineage',
    counts: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
    phases: ['single'],
    supersedes: null,
    notes: 'm11:lineage:verify（隔离库 · 真实 append/readback）',
  })

  console.log(`runId: ${runId}`)
  for (const c of checks) console.log(`  ${c.pass ? '✅' : '❌'} ${c.id} ${c.label} —— ${c.detail}`)
  console.log(`verdict: ${failed.length === 0 ? 'PASS' : 'FAIL'}（${String(checks.length - failed.length)}/${String(checks.length)}）`)

  /*
   * ⚠️ **显式退出**，而不是只设 `process.exitCode`。
   *
   * 实测（2026-10-01，第一代本门）：判词与证据都已落盘，但**进程不退出** ——
   * M4 harness 会把 embedding 插件的处理循环留在 event loop 上
   * （日志里能看到 `[PLUGIN:BOOTSTRAP:SERVICE:EMBEDDING] Started processing loop`）。
   * ⇒ 在 gates runner 下这会被读成"门挂着"，直到 deadline 才被强杀（假超时）。
   *
   * 这里的库是 `isolateDatabase(..., { keep: false })` 的**一次性沙箱**：
   * 不退出等于把一次成功的门变成一次超时。仓库里 608 处 `process.exit(...)`
   * 是同一个形状（`cli:exit:verify` 那道门守的正是这类孤儿句柄）。
   */
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((error: unknown) => {
  console.error('m11:lineage:verify 抛错（不是被拒，是执行器坏了）：', error)
  process.exit(1)
})
