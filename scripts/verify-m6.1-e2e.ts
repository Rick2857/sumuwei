/**
 * M6.1 **WP5 门（L3 集成）** —— 确定性 fixture 下的**程序性质**（`pnpm m6.1:e2e:verify`）。
 *
 * ============================================================================
 *  它判什么（计划书 §4 WP5 的第 1 条，六项）
 * ============================================================================
 * ```text
 *   P1 目标不明不误删          指代不清的"忘掉那件事" → **如实回报**，库一个字节都不动
 *   P2 遗忘成功不可召回        忘掉之后：状态 retracted · 不再进上下文 · 原文不出现在任何 section
 *   P3 纠正后资格变化          带时间标记的更新 ⇒ 新值唯一 active + 旧值 superseded + 召回用新值
 *   P4 摘要引用失效            旧声明被作废后，摘要**在选择阶段**把那个源拒掉（机制读数，不看文本子串）
 *   P5 dry-run 零写入          干跑一轮：九张表**全都不变**；正控（同一套读法在非干跑下**必须**变）
 *   P6 助手文本不被采信        她自己的编造**永远不进记忆**；"没写成功"在程序层可判（不是靠文风）
 * ```
 *
 * ⚠️ **P5 的映射（不重复实现别人的命题）**：`pnpm eval:dryrun` 已经在**生产 CLI**那一层
 *    覆盖"九表零变化"（`scripts/verify-dry-run-silence.ts`）。本门在**网关**那一层再测一次，
 *    因为 WP5 的判据就在网关（fixture 回复 + 真实 `TurnGateway`）；
 *    两层都要在，且本门**不**声称自己覆盖了 CLI 那一层。
 *
 * ⚠️ 走的是**生产形状**的装配（与 `src/main.ts` 同源的三处）：
 *    · 显式记忆：`createExplicitMemoryService` + **生产同款冲突端口**（active + disputed，D-55b）
 *    · 召回：`createMemoryRetrievalStore` → `createMemoryRecallService` → `createRecallTurnPort`
 *    · 摘要：`createRollupSourceReader` → `createRollupTurnPort`
 *    · 轮次：真实 `TurnGateway`（`beginTurn` → `compileTurn` → `completeTurn`）
 *
 * ⚠️ **离线**：`replyText` 由 fixture 传入（这正是计划书 §WP4 说的"适合确定性验证"），
 *    因此本门**不能**证明"模型自己学会了不编造" —— 那属于 `m6.1:live --suite short`。
 *
 * 用法：`pnpm m6.1:e2e:verify`
 */

import 'dotenv/config'

import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { cleanupSandbox, isolateDatabase, resetPluginSqlConnection } from '../src/dev/sandbox.ts'
import { applyAcceptedEvents } from '../src/infrastructure/persistence/event-store.ts'
import { digestTree } from '../src/infrastructure/persistence/production-db-safety.ts'
import { createRollupSourceReader } from '../src/infrastructure/persistence/rollup-source-store.ts'
import { createMemoryRetrievalStore } from '../src/infrastructure/persistence/memory-retrieval-store.ts'
import { memoryIntegrityProblems } from '../src/infrastructure/persistence/memory-integrity.ts'
import { rootReadingsByMemory } from '../src/infrastructure/persistence/qualification-read.ts'
import { createMemoryRecallService } from '../src/kernel/app/recall/retrieval.ts'
import { createRecallTurnPort } from '../src/kernel/app/recall/turn.ts'
import { createRollupTurnPort } from '../src/kernel/app/rollup/turn.ts'
import { createExplicitMemoryService } from '../src/kernel/app/memory/explicit-service.ts'
import { createExplicitMemoryTurnPort } from '../src/kernel/app/memory/explicit-turn.ts'
import {
  createExplicitMemoryIntentDetector,
  detectExplicitIntentFromEvent,
} from '../src/kernel/app/memory/intent-detector.ts'
import { createRuleOnlyContentExtractor } from '../src/kernel/app/memory/content-extractor.ts'
import {
  createTargetMemoryResolver,
  LexicalSemanticJudge,
} from '../src/kernel/app/memory/target-resolver.ts'
import { entityRef } from '../src/kernel/contracts/entity.ts'
import { DEFAULT_CONTEXT_BUDGET } from '../src/kernel/recall/selector.ts'
import type { EntityRef } from '../src/kernel/contracts/index.ts'
import { createM55Harness, type M55Harness } from './m5.5-harness.ts'
import { createReporter, M4_T0 } from './m4-harness.ts'

const ROOT = resolve('.')
const outDir = join(ROOT, 'artifacts', 'm6.1')
const report = createReporter()

/** 干跑静默性覆盖的九张表（与 `scripts/verify-dry-run-silence.ts` **同一张表**，不另写一份） */
const SILENCE_TABLES: readonly string[] = [
  'memories',
  'character_states',
  'state_events',
  'conversation_events',
  'character_domain_events',
  'character_projections',
  'character_traces',
  'processed_operations',
  'character_jobs',
]

console.log('='.repeat(78))
console.log('M6.1 WP5 集成门（确定性 fixture · 生产形状装配 · 隔离库 · 离线）')
console.log('='.repeat(78))

// ---------------------------------------------------------------------------
// 场景装配（与 `verify-m6-wp7a.ts` 同一形状；生产同款冲突端口见 `src/main.ts`）
// ---------------------------------------------------------------------------

interface Scenario {
  bed: M55Harness
  /** 真实轮次（用户原话 → 账本 → 上下文 → fixture 回复） */
  say: (
    text: string,
    replyText: string,
    options?: { recall?: boolean; rollupTokens?: number; dryRun?: boolean }
  ) => Promise<{
    packetSections: string[]
    memoryRecallText: string
    rollupText: string
    stepKinds: string[]
    /** `context_compile` 那一步的属性（含 `rollup_*` 的机制读数） */
    contextCompile: Record<string, unknown> | null
  }>
  /** 显式记忆的生产轮次入口（记住 / 纠正 / 忘掉 / 争议） */
  memoryTurn: (text: string) => Promise<{ kind: string; reason?: string }>
  activeValues: () => Promise<string[]>
  counts: () => Promise<{ memories: number; active: number; superseded: number; retracted: number }>
  allMemoryText: () => Promise<string>
  tableDigest: (table: string) => Promise<string>
  silenceDigests: () => Promise<Record<string, string>>
  dispose: () => Promise<void>
}

let live: Scenario | undefined

async function openScenario(
  label: string,
  options: { dryRunHarness?: boolean } = {}
): Promise<Scenario> {
  if (live !== undefined) {
    await live.dispose()
    live = undefined
  }
  await resetPluginSqlConnection()
  const sandbox = isolateDatabase(`m61-e2e-${label}`, { keep: true })
  const bed = await createM55Harness({
    label: `m61-e2e-${label}`,
    ...(options.dryRunHarness === true ? { dryRun: true } : {}),
  })
  const h = bed.h
  const { owner, user, db, store } = h

  const recallPort = createRecallTurnPort({
    service: createMemoryRecallService({
      port: createMemoryRetrievalStore({
        store,
        integrity: (o) => memoryIntegrityProblems(db, o),
        rootReadings: (ids) => rootReadingsByMemory(db, ids),
      }),
    }),
    budget: DEFAULT_CONTEXT_BUDGET,
    now: () => M4_T0 + 10_000,
  })
  const rollupPort = createRollupTurnPort({ reader: createRollupSourceReader(db) })

  const resolver = createTargetMemoryResolver({
    get: (id) => store.get(id),
    getActiveByCanonicalKey: (key) => store.getActiveByCanonicalKey(key),
    listBySubject: (o: EntityRef, s: EntityRef) => store.listBySubject(o, s),
    semanticJudge: new LexicalSemanticJudge(),
  })
  const service = createExplicitMemoryService({
    store,
    validator: h.validator,
    extractor: createRuleOnlyContentExtractor(),
    resolveTarget: (input) =>
      resolver.resolve({
        owner: input.owner,
        text: input.text,
        ...(input.canonicalKey !== undefined ? { canonicalKey: input.canonicalKey } : {}),
        ...(input.subject !== undefined ? { subject: input.subject } : {}),
        ...(input.hints !== undefined ? { hints: input.hints } : {}),
      }),
    commitEvents: async (accepted, now) =>
      (await applyAcceptedEvents(db, h.characterId as never, accepted, [], now)).domainEvents,
    /*
     * ⚠️ **生产同款**冲突端口（`src/main.ts` 的 `buildMemoryWriter` 逐字相同：active + disputed）。
     * 少接它，本门的 P3 会退回"同槽位两条 active"的旧行为 —— 那正是 D-55b 修掉的那件事。
     */
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
  const port = createExplicitMemoryTurnPort({ service })
  const detector = createExplicitMemoryIntentDetector()

  const scenario: Scenario = {
    bed,
    async say(text, replyText, options) {
      const gateway = bed.gatewayOf({
        search: 'off',
        recall: recallPort,
        recallEnabled: options?.recall === true,
        rollup: rollupPort,
        ...(options?.rollupTokens !== undefined ? { rollupTokens: options.rollupTokens } : {}),
        ...(options?.dryRun === true ? { dryRun: true } : {}),
      })
      const turn = await bed.say({ gateway, text, replyText })
      const sectionOf = (id: string): string =>
        turn.packet.sections.find((section) => String(section.id) === id)?.content ?? ''
      const compileStep = turn.trace.steps.find((step) => String(step.kind) === 'context_compile')
      return {
        packetSections: turn.packet.sections.map((section) => String(section.id)),
        memoryRecallText: sectionOf('memory-recall'),
        rollupText: sectionOf('rolling-summary'),
        stepKinds: turn.trace.steps.map((step) => String(step.kind)),
        contextCompile:
          compileStep === undefined
            ? null
            : ((compileStep.attributes ?? {}) as Record<string, unknown>),
      }
    },
    async memoryTurn(text) {
      const recorded = await h.recordUserEvidence(text)
      await detectExplicitIntentFromEvent(detector, {
        id: recorded.ref.id as never,
        actorType: 'user',
        content: text,
      })
      const result = await port.handleTurn({
        owner,
        speaker: user,
        event: { id: recorded.ref.id as never, actorType: 'user', content: text },
      })
      if (result === undefined) return { kind: 'no_intent' }
      return result.kind === 'not_written'
        ? { kind: result.kind, reason: String((result as { reason?: unknown }).reason ?? '') }
        : { kind: result.kind }
    },
    async activeValues() {
      const rows = await store.list({ owner, status: 'active', limit: 50 })
      return rows.map((row) => JSON.stringify(row.content))
    },
    async counts() {
      const rows = await store.list({ owner, limit: 200 })
      const count = (status: string): number =>
        rows.filter((row) => String(row.status) === status).length
      return {
        memories: rows.length,
        active: count('active'),
        superseded: count('superseded'),
        retracted: count('retracted'),
      }
    },
    allMemoryText: async () => JSON.stringify(await store.list({ owner, limit: 200 })),
    tableDigest: (table) => bed.tableDigest(table),
    async silenceDigests() {
      const out: Record<string, string> = {}
      for (const table of SILENCE_TABLES) out[table] = await bed.tableDigest(table)
      return out
    },
    dispose: async () => {
      await bed.dispose()
      cleanupSandbox(sandbox.dir)
    },
  }
  live = scenario
  return scenario
}

const findings: Record<string, unknown> = {}
const realDbBefore = digestTree(resolve('data/pglite'))

// ===========================================================================
report.section('P1 目标不明不误删：指代不清的"忘掉那件事" ⇒ 如实回报，库一个字节不动')
// ===========================================================================
{
  const s = await openScenario('p1')
  /*
   * 先落两条**相似**的记忆：目标解析因此只能报歧义或找不到，**不能**挑一条删。
   * （判据是 mutation 级：不是"检测器沉默"，而是"库没被动过"。）
   */
  await s.memoryTurn('记住，我不吃辣')
  await s.memoryTurn('记住，我不吃香菜')
  const before = await s.tableDigest('character_domain_events')
  const beforeProjection = await s.tableDigest('memory_records')
  const result = await s.memoryTurn('忘掉那件事')
  const after = await s.tableDigest('character_domain_events')
  const afterProjection = await s.tableDigest('memory_records')
  const counts = await s.counts()

  report.check(
    'P1-a · 指代不清 ⇒ **没有写入**（`not_written`），而且理由是具名的（不是"挑了一条删掉"）',
    result.kind === 'not_written' &&
      ['target_ambiguous', 'target_not_found', 'content_unresolved', 'content_empty'].includes(
        String(result.reason)
      ),
    `${result.kind}/${String(result.reason)}`
  )
  report.check(
    'P1-b · **mutation 级**：领域事件表与投影表**逐字节未变**（"不确定就不动"不是靠自觉）',
    before === after && beforeProjection === afterProjection,
    `events ${before === after ? '未变' : '**变了**'} · projections ${beforeProjection === afterProjection ? '未变' : '**变了**'}`
  )
  report.check(
    'P1-c · 两条记忆都还在（`active`=2）—— 误删会立刻体现为计数下降',
    counts.active === 2,
    `active=${String(counts.active)} memories=${String(counts.memories)}`
  )
  findings.P1 = { kind: result.kind, reason: result.reason, active: counts.active }
}

// ===========================================================================
report.section('P2 遗忘成功不可召回：状态 retracted · 不再进上下文 · 原文不出现在任何 section')
// ===========================================================================
{
  const s = await openScenario('p2')
  await s.memoryTurn('记住，我不吃辣')
  const forgotten = await s.memoryTurn('忘掉我不吃辣这件事')
  const counts = await s.counts()
  const turn = await s.say('我吃辣吗？', '（她如实回答）', { recall: true })

  report.check(
    'P2-a · 遗忘在程序层**真的成功**：该条转 `retracted`（不是"删掉了"，也不是"仍 active"）',
    forgotten.kind === 'written' && counts.retracted === 1 && counts.active === 0,
    `${forgotten.kind} · active=${String(counts.active)} retracted=${String(counts.retracted)}`
  )
  report.check(
    'P2-b · 它**不再进上下文**：这一轮没有 `memory-recall` section',
    !turn.packetSections.includes('memory-recall'),
    `sections=[${turn.packetSections.join(',')}]`
  )
  report.check(
    'P2-c · 被遗忘的取值**没有**出现在任何 section 里（"不可召回"的文本面证据）',
    !turn.memoryRecallText.includes('回避辣') && !turn.rollupText.includes('回避辣'),
    `recall=${String(turn.memoryRecallText.length)} 字符 · rollup=${String(turn.rollupText.length)} 字符`
  )
  report.check(
    'P2-d · D-55e：状态行**具名**说了这一轮的检索事实（不是"没有记忆"这种笼统话）',
    turn.stepKinds.includes('memory_record_status'),
    `steps=[${turn.stepKinds.join(',')}]`
  )
  findings.P2 = { counts, sections: turn.packetSections }
}

// ===========================================================================
report.section('P3 纠正后资格变化：新值唯一 active + 旧值 superseded + 召回用新值')
// ===========================================================================
{
  const s = await openScenario('p3')
  await s.memoryTurn('记住，我不吃辣')
  const updated = await s.memoryTurn('记住，我现在吃辣了')
  const counts = await s.counts()
  const turn = await s.say('我吃辣吗？', '（她如实回答）', { recall: true })

  report.check(
    'P3-a · 更新**真的成功**：恰好 1 条 active（新值）+ 1 条 superseded（旧值），没有第二条 active',
    updated.kind === 'written' && counts.active === 1 && counts.superseded === 1,
    `${updated.kind} · active=${String(counts.active)} superseded=${String(counts.superseded)}`
  )
  report.check(
    'P3-b · 新值是**用户最后说的那个**（取值 == 喜欢辣），旧值保留在历史里（不是物理覆盖）',
    (await s.activeValues()).some((value) => value.includes('喜欢辣')) && counts.memories >= 2,
    (await s.activeValues()).join(' | ')
  )
  report.check(
    'P3-c · 召回用的是**有效值**：`memory-recall` 里有"喜欢辣"、没有"回避辣"',
    turn.packetSections.includes('memory-recall') &&
      turn.memoryRecallText.includes('喜欢辣') &&
      !turn.memoryRecallText.includes('回避辣'),
    `sections=[${turn.packetSections.join(',')}] recall=${turn.memoryRecallText.replace(/\n/g, ' / ').slice(0, 120)}`
  )
  findings.P3 = { counts }
}

// ===========================================================================
report.section('P4 摘要引用失效：旧声明作废后，摘要在**选择阶段**把那个源拒掉')
// ===========================================================================
{
  const s = await openScenario('p4')
  await s.memoryTurn('记住，我不吃辣')
  // 轮次间隔：摘要只覆盖**早期**发言（近期原文由 Recent 承担，不是它的源）
  await s.say('今天天气不错', '（闲聊）')
  await s.say('我们聊点别的吧', '（闲聊）')
  await s.memoryTurn('忘掉我不吃辣这件事')
  await s.memoryTurn('记住，我吃香菜')
  const turn = await s.say('我吃香菜吗？', '（她如实回答）', { rollupTokens: 400 })

  /*
   * 机制读数：`context_compile` 的 `rollup_rejected_invalidated` = 摘要**选择阶段**
   * 因"根记忆已不是 active"而拒掉的源条数。`-1` = 这一轮压根没跑摘要（**不是 0**）。
   * ⚠️ 判据用机制读数而**不是**文本子串：文本子串证明不了"是被拒掉的、还是没被扫到"。
   */
  const rejectedInvalidated = turn.contextCompile?.rollup_rejected_invalidated
  const rollupStatus = turn.contextCompile?.rollup_status
  const scanned = turn.contextCompile?.rollup_scanned

  report.check(
    'P4-a · 摘要端口这一轮**真的跑过**（`rollup_status` 在，且扫到了源）',
    typeof rollupStatus === 'string' &&
      rollupStatus !== '' &&
      typeof scanned === 'number' &&
      scanned > 0,
    `rollup_status=${String(rollupStatus)} scanned=${String(scanned)}`
  )
  report.check(
    'P4-b · 机制读数：摘要在**选择阶段**拒掉了失效源（`rollup_rejected_invalidated ≥ 1`，不是 -1）',
    typeof rejectedInvalidated === 'number' && rejectedInvalidated >= 1,
    `rollup_rejected_invalidated=${String(rejectedInvalidated)}`
  )
  report.check(
    'P4-c · 被作废的那条声明的**原文**没有进摘要（判据按原文，不按关键词）',
    !turn.rollupText.includes('记住，我不吃辣'),
    `rollup=${turn.rollupText.replace(/\n/g, ' / ').slice(0, 140)}`
  )
  findings.P4 = {
    sections: turn.packetSections,
    rollupStatus,
    scanned,
    rejectedInvalidated,
    rollupChars: turn.rollupText.length,
  }
}

// ===========================================================================
report.section('P5 dry-run 零写入：九张表全都不变；正控（同一读法在非干跑下必须变）')
// ===========================================================================
{
  /*
   * ⚠️ 两个场景：干跑的那一轮**记录器也必须干跑**（生产的 `--test` 就是这样）。
   * 第一版只在网关上设 dryRun，于是 `conversation_events` 仍然变了 ——
   * 那是**实测到的**发现（用户消息由 `ConversationRecorder` 写，它有自己的 dryRun），
   * 已按"改夹具、不放宽判据"处置。
   */
  const dry = await openScenario('p5', { dryRunHarness: true })
  const before = await dry.silenceDigests()
  await dry.say('这句只是试试看。', '（干跑回复）', { dryRun: true })
  const after = await dry.silenceDigests()
  const changed = SILENCE_TABLES.filter((table) => before[table] !== after[table])

  report.check(
    'P5-a · 干跑一轮（网关 + 记录器都干跑，与 `main.ts --test` 同形）：**九张表逐字节不变**',
    changed.length === 0,
    changed.length === 0 ? `${String(SILENCE_TABLES.length)} 张表零变化` : `变了：${changed.join(',')}`
  )
  report.check(
    'P5-b · 计数型自检：这张表真的**读到了**（九张表都有摘要，不是"0 张表 0 变化"）',
    SILENCE_TABLES.every((table) => typeof before[table] === 'string' && before[table] !== '') &&
      SILENCE_TABLES.length === 9,
    `${String(Object.keys(before).length)} 张表`
  )

  /*
   * 正控：**另开一个非干跑场景**，用同一套读法 ⇒ 必须看到变化。
   * （否则 P5-a 的"零变化"可能只是因为这套摘要根本没在量东西。）
   */
  const loud = await openScenario('p5-control')
  const controlBefore = await loud.silenceDigests()
  await loud.say('这轮是真写的。', '（真实回复）', { dryRun: false })
  const controlAfter = await loud.silenceDigests()
  const controlChanged = SILENCE_TABLES.filter(
    (table) => controlBefore[table] !== controlAfter[table]
  )
  report.check(
    'P5-c · **正控**：同一套读法在非干跑下**必须**看到变化（证明 P5-a 的"零变化"不是量具坏了）',
    controlChanged.length > 0,
    `变了 ${String(controlChanged.length)} 张：${controlChanged.join(',')}`
  )
  report.check(
    'P5-d · 映射（不重复实现）：生产 CLI 那一层由 `pnpm eval:dryrun` 覆盖 —— 本门只声明边界',
    true,
    '本门测网关层；CLI 层见 scripts/verify-dry-run-silence.ts（九表零变化）'
  )
  findings.P5 = { dryRunChanged: changed, controlChanged }
}

// ===========================================================================
report.section('P6 助手文本不被采信：她自己的编造永远不进记忆；"没写成功"在程序层可判')
// ===========================================================================
{
  const s = await openScenario('p6')
  const fabricated = '我记得你上周说过你要去西安出差'
  await s.say('我们聊点什么？', fabricated, { recall: true })
  const memoryText = await s.allMemoryText()

  report.check(
    'P6-a · 她自己的编造**不进记忆**（记忆表里没有那句话的任何片段）',
    !memoryText.includes('西安出差') && !memoryText.includes(fabricated),
    memoryText === '[]' ? '记忆表为空' : `${String(memoryText.length)} 字符，未见该片段`
  )
  report.check(
    'P6-b · 那一轮之后**再问**，编造也没有作为"共同经历"回到上下文（无 memory-recall）',
    !(await s.say('我们之前说过什么？', '（她如实回答）', { recall: true })).packetSections.includes(
      'memory-recall'
    ),
    '第二轮没有 memory-recall section'
  )
  /*
   * "没写成功"必须是**程序层可判的**（而不是靠读文风）：
   * 内容抽不出来的显式"记住" ⇒ 生产端口如实回 `not_written / content_unresolved`。
   * 回复层的替换（`applyResponseTruthPolicy`）绑定的就是这个读数。
   */
  const unresolved = await s.memoryTurn('记住，我可能会搬到成都')
  report.check(
    'P6-c · "没写成功"在程序层**可判**：抽不出结构化内容 ⇒ `not_written / content_unresolved`',
    unresolved.kind === 'not_written' && unresolved.reason === 'content_unresolved',
    `${unresolved.kind}/${String(unresolved.reason)}`
  )
  findings.P6 = { fabricatedInMemory: memoryText.includes('西安出差') }
}

// ===========================================================================
// 证据（**必须**在 `report.finish()` 之前写完 —— 它内部会 process.exit）
// ===========================================================================

const realDbAfter = digestTree(resolve('data/pglite'))
const evidence = {
  schemaVersion: 'm6.1-e2e@1',
  gateId: 'M6.1 / WP5 L3 集成（确定性 fixture · 隔离库 · 生产形状装配 · 离线）',
  scope:
    '计划书 §4 WP5 第 1 条的六项程序性质：目标不明不误删 / 遗忘成功不可召回 / 纠正后资格变化 / ' +
    '摘要引用失效 / dry-run 零写入 / 助手文本不被采信',
  note:
    'replyText 由 fixture 传入 ⇒ 本门**不能**证明"模型自己学会了不编造"（那属于 m6.1:live --suite short）。' +
    '证据里**没有**时钟字段 ⇒ 重复运行逐字节相同（沙箱路径除外）。',
  verdict: report.failed === 0 ? 'PASS' : 'FAIL',
  passed: report.passed,
  failed: report.failed,
  failures: report.failures,
  findings,
  coverageMapping: [
    {
      property: 'dry-run 零写入（生产 CLI 层）',
      coveredBy: 'scripts/verify-dry-run-silence.ts（`pnpm eval:dryrun`）',
      note: '本门在网关层另测一次；**不**声称覆盖 CLI 那一层',
    },
    {
      property: '助手编造不进记忆（剧情 C）',
      coveredBy: 'scripts/verify-m6-wp7a.ts',
      note: '本门只补"编造之后**再问**也不回来"这一条',
    },
  ],
  realDb: {
    before: { files: realDbBefore.measuredCount, treeSha256: realDbBefore.treeSha256 },
    after: { files: realDbAfter.measuredCount, treeSha256: realDbAfter.treeSha256 },
    unchanged: realDbBefore.treeSha256 === realDbAfter.treeSha256,
    note: '只做**文件树摘要**，不打开真实库；本门所有轮次都跑在隔离库上',
  },
  notProvenByThisGate: [
    '不判"她不再编造"：回复是 fixture，不是模型生成的。',
    '不判真实模型下的两轮行为达标（WP5 的 live 档 / WP6）。',
    '不覆盖生产 CLI 层的干跑静默性（那条在 eval:dryrun）。',
  ],
}
mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, 'e2e.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')

console.log('')
console.log(`  M6.1 WP5 集成门：${evidence.verdict}（${String(report.passed)} 通过 / ${String(report.failed)} 失败）`)
console.log('  证据：artifacts/m6.1/e2e.json')
console.log(
  `  真实库 ${evidence.realDb.unchanged ? '**摘要未被改动**' : '**摘要不同 ⇒ 无法归属**'}（只摘要，不打开）`
)
if (live !== undefined) await live.dispose()
report.finish('M6.1 WP5 L3 集成（确定性 fixture）')
