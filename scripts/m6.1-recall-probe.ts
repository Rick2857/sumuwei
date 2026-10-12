/**
 * M6.1 WP5 —— **回召回判定探针**：把"候选有了、合格有了、却一条都没被选中"这件事
 * 在**离线**（零模型调用）条件下复现，并读出**是哪一条规则把它筛掉的**。
 *
 * ============================================================================
 *  它复现哪条发现（`M6.1-WP5-Failure-Attribution.md` §4.4）
 * ============================================================================
 * ```text
 * 新候选 round 1 的 trace 读数（SRP-A-08 与 SRP-C-08，**同槽位同问句**，两次复现）：
 *   sections = [current-input, integrity-rules, identity-core, critical-state, clock,
 *               **memory-record-status**, recent-conversation]      ← 没有 `memory-recall`
 *   memory_recall：**候选 1 · 合格 1 · 选中 0** · 预算裁掉 0 · 达上下文 false
 * 槽位 project.background.active · 问句「我现在在写什么？」· setup「记住：我在写毕业论文。」
 * ```
 * ⇒ 不是"库里没有"（合格 1），也不是"预算裁掉"（0）——
 *   **检索/资格/排序这一层把一条合格的记忆筛掉了**。
 *
 * ============================================================================
 *  判据（三段式 · 全是确定性的）—— **两个档**（`--expect`，默认 `fixed`）
 * ============================================================================
 * ```text
 * ── --expect fixed（**默认，当前状态**；ADR-059 之后）─────────────────────
 * 正控   education.institution 那条 ⇒ **必须选中 ≥ 1**（否则"选中 ≥1"说明不了任何事 —— 全链路都不选）
 * 断言   目标那一对（project.background.active 的 SRP-A-08 / SRP-C-08 形状）⇒ **必须选中 ≥ 1**，
 *        且**取值必须对**：更正后那条选中的必须是新值（课程设计），**不得**选中被 supersede 的旧值（毕业论文）
 * 负控   无关问题（「今天午饭吃什么？」）⇒ 选中 **0**，而 `候选 > 0 ∧ 合格 > 0`
 *        （"库里没有"与"被筛掉"必须分得开：候选 = 0 时这条负控**不成立**）
 * 计数自检  ≥1 条零期望 + ≥1 条选中期望 + ≥1 条取值断言，否则 MEASUREMENT INVALID（§6.8）
 * 恢复   正控重跑一遍 ⇒ 与第一次逐字段相同
 *
 * ── --expect found（**历史档**：修前那份发现）─────────────────────────────
 * 负控   发现的那一对 ⇒ 选中 **0** 而 `合格 > 0`（= ADR-059 §0 的修前读数）
 *        ⚠️ 这个档**只在修前的树上**成立；在当前（已修）的树上它会如实报 exit 3，
 *           那是"缺陷已不复现"的正确读数，**不是**回归。
 * ```
 * ⚠️ 它**不修任何东西**：只把成因具名（`exclusionHistogram` 与逐条 `decisions[].reason`）。
 * ⚠️ 它**不打开真实库**（`isolateDatabase` 沙箱）、**不调模型**（fixture 回复）。
 *
 * ============================================================================
 *  量具自证（**断言本身也要被验证**，AGENTS §6.7 / §6.8）
 * ============================================================================
 * ```text
 * 正控   默认档跑一遍 ⇒ 判据安静（PASS / exit 0）
 * 负控   --inject-fake ⇒ 把取值断言喂成必错的形状 ⇒ 判据**必须响**（exit 3，且具名是哪条断言）
 *        （没有这一档，"断言恒真"与"断言真的在检查"在输出上长得一样）
 *        ⚠️ 注入档写**另一个**文件（`recall-probe-injected.json`）⇒ 它**永不**覆盖真实读数
 * 恢复   去掉开关再跑一遍 ⇒ 重新安静
 * ```
 *
 * 用法：`pnpm m6.1:recall-probe [--expect found|fixed] [--inject-fake]`
 */

import 'dotenv/config'

import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { cleanupSandbox, isolateDatabase, resetPluginSqlConnection } from '../src/dev/sandbox.ts'
import { createMemoryRetrievalStore } from '../src/infrastructure/persistence/memory-retrieval-store.ts'
import { memoryIntegrityProblems } from '../src/infrastructure/persistence/memory-integrity.ts'
import { rootReadingsByMemory } from '../src/infrastructure/persistence/qualification-read.ts'
import { createMemoryRecallService } from '../src/kernel/app/recall/retrieval.ts'
import { createRecallTurnPort } from '../src/kernel/app/recall/turn.ts'
import { createExplicitMemoryService } from '../src/kernel/app/memory/explicit-service.ts'
import {
  createExplicitMemoryIntentDetector,
  detectExplicitIntentFromEvent,
  targetHintsFrom,
} from '../src/kernel/app/memory/intent-detector.ts'
import { createRuleOnlyContentExtractor } from '../src/kernel/app/memory/content-extractor.ts'
import { createTargetMemoryResolver, LexicalSemanticJudge, lexicalFragments, lexicalOverlapHits } from '../src/kernel/app/memory/target-resolver.ts'
import { registeredPredicates } from '../src/kernel/contracts/memory-predicates.ts'
import { entityRef } from '../src/kernel/contracts/entity.ts'
import { newTraceId } from '../src/kernel/contracts/ids.ts'
import { createRecallRequest } from '../src/kernel/contracts/recall.ts'
import { DEFAULT_CONTEXT_BUDGET } from '../src/kernel/recall/selector.ts'
import { DEFAULT_RECALL_RANKING_POLICY } from '../src/kernel/recall/ranking.ts'
import { createM55Harness } from './m5.5-harness.ts'
import { M4_T0 } from './m4-harness.ts'

const ROOT = resolve(process.cwd())

/**
 * 这一条在判据里**扮演什么角色**（角色决定它被断言成什么形状）。
 * 角色与"运行档"（`--expect found|fixed`）正交：`target` 在历史档里期望选中 0，
 * 在默认档里期望选中 ≥1 且取值正确。
 */
type CaseRole = 'control' | 'target' | 'negative'

interface ProbeCase {
  readonly id: string
  /** 依次说的用户原话（显式记忆） */
  readonly setup: readonly string[]
  /** 问句（召回查询文本） */
  readonly question: string
  readonly slot: string
  readonly origin: string
  readonly role: CaseRole
  /** 修后档的**取值断言**：选中的取值里**必须**有这些（顺序无关） */
  readonly expectSelectedValues?: readonly string[]
  /** 修后档的**取值断言**：选中的取值里**不得**有这些（例：被 supersede 的旧值） */
  readonly expectNotSelectedValues?: readonly string[]
}

/**
 * 期望 = 角色 × 档（这就是 `expectation` 字段的来源，产物里逐条记着它）。
 *
 *   control                                  ⇒ must_select
 *   negative                                 ⇒ expect_zero_while_eligible
 *   target  + 历史档 `found`                  ⇒ expect_zero_while_eligible（修前那份发现）
 *   target  + 默认档 `fixed`                  ⇒ expect_selected_while_eligible
 */
type Expectation = 'must_select' | 'expect_zero_while_eligible' | 'expect_selected_while_eligible'

const expectationFor = (role: CaseRole, mode: 'found' | 'fixed'): Expectation =>
  role === 'control'
    ? 'must_select'
    : role === 'negative'
      ? 'expect_zero_while_eligible'
      : mode === 'found'
        ? 'expect_zero_while_eligible'
        : 'expect_selected_while_eligible'

/** ⚠️ 逐字来自冻结条文（`evals/m6.1/control/supported-recall-positive-v1.jsonl`） */
const CASES: readonly ProbeCase[] = [
  {
    id: 'control-institution',
    setup: ['记住：我在江城大学读书。'],
    question: '我在哪个学校读书？',
    slot: 'education.institution',
    origin: 'SRP-A-01 的 setup 与问句（正控：这条链路必须能选中）',
    role: 'control',
  },
  {
    id: 'finding-project',
    setup: ['记住：我在写毕业论文。'],
    question: '我现在在写什么？',
    slot: 'project.background.active',
    origin: 'SRP-A-08 的 setup 与问句（发现：候选 1 · 合格 1 · 选中 0）',
    role: 'target',
    expectSelectedValues: ['毕业论文'],
  },
  {
    id: 'finding-project-after-correction',
    setup: ['记住：我在写毕业论文。', '更正一下，我现在在做课程设计。'],
    question: '我现在在写什么？',
    slot: 'project.background.active',
    origin: 'SRP-C-08 的 setup 与问句（同槽位同问句的第二次复现）',
    role: 'target',
    /* ★ 双候选形状（候选 2 · 合格 1）：选中的**必须**是更正后的新值，旧值不得当现状（SRP-C-08 的 forbidden） */
    expectSelectedValues: ['课程设计'],
    expectNotSelectedValues: ['毕业论文'],
  },
  {
    id: 'neg-unrelated-lunch',
    setup: ['记住：我在写毕业论文。'],
    question: '今天午饭吃什么？',
    slot: 'project.background.active',
    origin: '★ 修后负控：同一个库里的**无关问题** ⇒ 必须"候选 > 0 却选中 0"（扩词面不许乱召回）',
    role: 'negative',
  },
]

interface CaseReading {
  readonly id: string
  readonly slot: string
  readonly origin: string
  readonly question: string
  readonly expectation: Expectation
  readonly role: CaseRole
  /** 库里该槽位的 active 取值（证明"记忆真的写进去了"） */
  readonly storedValues: readonly string[]
  /** 生成期就扫到的候选行（**打分的输入**） */
  readonly scanned: readonly {
    readonly predicate: string | null
    readonly value: string
    readonly status: string
    readonly importance: number
    readonly authority: string
  }[]
  /** 登记表里这个槽位的说明与例子（lexical 通道就是拿它们做词面重叠的） */
  readonly registry: { readonly description: string; readonly examples: readonly string[] } | null
  /** 词面闸的读数：问句被切成哪些片段、命中了几条（与检索店**同一个实现**） */
  readonly lexical: {
    readonly queryFragments: readonly string[]
    readonly hitCount: number
    readonly hitPredicates: readonly string[]
    /**
     * **逐片段**归因：把每一个片段**单独**喂给同一个 `lexicalOverlapHits`。
     *
     * ⚠️ 这不是重写打分器 —— 用的是同一个导出函数；它回答的是
     *    "**是哪个片段**把这条候选捞上来的"（否则"命中 1 条"是一个不可解释的数）。
     */
    readonly perFragment: readonly { readonly fragment: string; readonly hitCount: number }[]
  }
  readonly policy: { readonly minTotal: number; readonly requireRelevanceEvidence: boolean }
  readonly candidates: number
  readonly eligible: number
  readonly selected: number
  readonly selectedIds: readonly string[]
  /** 被选中的那些行的**取值**（SRP-C-08 那条靠它区分"新值当选"还是"旧值当现状"） */
  readonly selectedValues: readonly string[]
  readonly droppedByBudget: number
  readonly reachedContext: boolean
  readonly exclusionHistogram: Readonly<Record<string, number>>
  /** 逐条候选的排除理由（**成因就在这里**） */
  readonly decisions: readonly { readonly memoryId: string; readonly reason: string }[]
  readonly memoryTokens: number
  readonly budgetTokens: number
}

async function runCase(
  bed: Awaited<ReturnType<typeof createM55Harness>>,
  probe: ProbeCase,
  mode: 'found' | 'fixed'
): Promise<CaseReading> {
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
  const resolver = createTargetMemoryResolver({
    get: (id) => store.get(id),
    getActiveByCanonicalKey: (key) => store.getActiveByCanonicalKey(key),
    listBySubject: (o, s) => store.listBySubject(o, s),
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
      (await (await import('../src/infrastructure/persistence/event-store.ts')).applyAcceptedEvents(
        db,
        h.characterId as never,
        accepted,
        [],
        now
      )).domainEvents,
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
  const detector = createExplicitMemoryIntentDetector()

  /* ① 逐句走**生产**显式记忆路径（与 `verify-m6.1-e2e.ts` 的 `memoryTurn` 逐字同形） */
  for (const text of probe.setup) {
    const recorded = await h.recordUserEvidence(text)
    const intent = await detectExplicitIntentFromEvent(detector, {
      id: recorded.ref.id as never,
      actorType: 'user',
      content: text,
    })
    if (intent === undefined) continue
    await service.handle({
      owner,
      speaker: user,
      intent,
      triggerEventId: recorded.ref.id,
      hints: targetHintsFrom(intent),
    })
  }

  /* ② 召回：与 `turn-gateway.recallForTurn` **逐字同形**的请求构造 */
  const outcome = await recallPort.run(
    createRecallRequest({
      traceId: newTraceId(),
      characterId: String(h.characterId),
      user: entityRef('user', String(h.user.id)),
      query: { text: probe.question, source: 'user_message' },
      intent: 'current_fact',
      contextBudget: { memoryTokens: DEFAULT_CONTEXT_BUDGET.memoryTokens },
    })
  )

  const allRows = await store.list({ owner, limit: 500 })
  const activeInSlot = allRows.filter(
    (record) =>
      (record.content as { predicate?: string }).predicate === probe.slot && record.status === 'active'
  )
  const selectedValues = outcome.record.selectedIds.map((id) => {
    const row = allRows.find((candidate) => String(candidate.id) === String(id))
    return row === undefined ? String(id) : String((row.content as { value?: unknown }).value ?? '')
  })

  /* 打分的**输入**：与检索店同一套只读接口 + 同一个词面实现（不另写一份打分器） */
  const scannedRows = (await store.list({ owner, limit: 50 })).filter(
    (record) => (record.content as { predicate?: string }).predicate === probe.slot
  )
  const registryRow = registeredPredicates().find((row) => row.key === probe.slot)
  const fragments = lexicalFragments(probe.question)
  const hits = lexicalOverlapHits(probe.question, scannedRows)

  return {
    id: probe.id,
    slot: probe.slot,
    origin: probe.origin,
    question: probe.question,
    expectation: expectationFor(probe.role, mode),
    role: probe.role,
    storedValues: activeInSlot.map((record) => String((record.content as { value?: unknown }).value)),
    scanned: scannedRows.map((record) => ({
      predicate: (record.content as { predicate?: string }).predicate ?? null,
      value: String((record.content as { value?: unknown }).value ?? ''),
      status: String(record.status),
      importance: record.importance,
      authority: String(record.authority),
    })),
    registry:
      registryRow === undefined
        ? null
        : { description: String(registryRow.description ?? ''), examples: [...(registryRow.examples ?? [])] },
    lexical: {
      queryFragments: fragments,
      hitCount: hits.length,
      hitPredicates: hits.map((record) => String((record.content as { predicate?: string }).predicate ?? '')),
      perFragment: fragments.map((fragment) => ({
        fragment,
        hitCount: lexicalOverlapHits(fragment, scannedRows).length,
      })),
    },
    policy: {
      minTotal: DEFAULT_RECALL_RANKING_POLICY.minTotal,
      requireRelevanceEvidence: DEFAULT_RECALL_RANKING_POLICY.requireRelevanceEvidence,
    },
    candidates: outcome.record.metrics.candidateCount,
    eligible: outcome.record.metrics.eligibleCount,
    selected: outcome.record.metrics.selectedCount,
    selectedIds: [...outcome.record.selectedIds],
    selectedValues,
    droppedByBudget: outcome.record.metrics.droppedByBudget,
    reachedContext: outcome.record.metrics.reachedContext,
    exclusionHistogram: { ...outcome.trace.exclusionHistogram },
    decisions: outcome.record.decisions.map((decision) => ({
      memoryId: String(decision.memoryId),
      reason: String(decision.reason),
    })),
    memoryTokens: outcome.trace.account.memoryTokens,
    budgetTokens: outcome.trace.account.budgetTokens,
  }
}

async function openCase(label: string): Promise<Awaited<ReturnType<typeof createM55Harness>>> {
  await resetPluginSqlConnection()
  isolateDatabase(`m61-recall-probe-${label}`, { keep: false })
  return createM55Harness({ label: `m61-recall-probe-${label}` })
}

/* ---------------------------------------------------------------------------
 * 运行档（`--expect`）与量具自证开关（`--inject-fake`）
 * ------------------------------------------------------------------------- */
const expectIndex = process.argv.indexOf('--expect')
const mode = (expectIndex === -1 ? 'fixed' : String(process.argv[expectIndex + 1] ?? 'fixed')) as
  | 'found'
  | 'fixed'
if (mode !== 'found' && mode !== 'fixed') {
  console.error(`--expect 只接受 found | fixed（收到 ${JSON.stringify(mode)}）`)
  process.exit(2)
}
/**
 * ★ 量具自证：把一条**取值断言**喂成必错的形状 ⇒ 判据**必须响**。
 * 它只影响本进程的判据，且**只写另一个文件**（见文末）⇒ 永不覆盖真实读数。
 */
const injectFake = process.argv.includes('--inject-fake')

const readings: CaseReading[] = []
for (const probe of CASES) {
  const bed = await openCase(probe.id)
  try {
    readings.push(await runCase(bed, probe, mode))
  } finally {
    await bed.dispose()
  }
}
await resetPluginSqlConnection()

/* ---------------------------------------------------------------------------
 * 判据（正控 / 断言 / 负控 / 恢复）
 * ------------------------------------------------------------------------- */

const control = readings.find((row) => row.expectation === 'must_select')
const zeroExpect = readings.filter((row) => row.expectation === 'expect_zero_while_eligible')
const selectExpect = readings.filter((row) => row.expectation === 'expect_selected_while_eligible')
const controlOk = control !== undefined && control.selected >= 1
const zeroOk =
  zeroExpect.length > 0 &&
  zeroExpect.every((row) => row.selected === 0 && row.eligible > 0 && row.candidates > 0)
/**
 * 选中期望：**必须选中 ≥1**，且候选/合格都 > 0（与零期望同一条纪律：
 * "库里没有"不算"被选中"，否则这条断言可以被一个空库通过）。
 */
const selectOk =
  selectExpect.length > 0 &&
  selectExpect.every((row) => row.selected >= 1 && row.eligible > 0 && row.candidates > 0)

/** 取值断言：逐条具名（哪一条、期望什么、实际选了什么） */
const valueProblems: string[] = []
let valueAssertions = 0
for (const row of selectExpect) {
  const definition = CASES.find((candidate) => candidate.id === row.id)
  if (definition === undefined) continue
  for (const expected of definition.expectSelectedValues ?? []) {
    valueAssertions += 1
    if (injectFake) {
      valueProblems.push(`${row.id}：★注入假象 —— 期望选中「${expected}」，实际选中 [${row.selectedValues.join(' / ') || '(空)'}]`)
    } else if (!row.selectedValues.includes(expected)) {
      valueProblems.push(`${row.id}：期望选中「${expected}」，实际选中 [${row.selectedValues.join(' / ') || '(空)'}]`)
    }
  }
  for (const forbidden of definition.expectNotSelectedValues ?? []) {
    valueAssertions += 1
    if (injectFake) {
      valueProblems.push(`${row.id}：★注入假象 —— 期望**不**选中「${forbidden}」`)
    } else if (row.selectedValues.includes(forbidden)) {
      valueProblems.push(`${row.id}：被 supersede 的旧值「${forbidden}」**不得**当选现状，实际选中 [${row.selectedValues.join(' / ')}]`)
    }
  }
}

/* 恢复：正控那条**重跑一遍**（新沙箱、同语料）⇒ 逐字段相同 */
const replayBed = await openCase('control-replay')
let replay: CaseReading | undefined
try {
  replay = await runCase(replayBed, CASES[0]!, mode)
} finally {
  await replayBed.dispose()
}
await resetPluginSqlConnection()
const restoreOk =
  control !== undefined &&
  replay !== undefined &&
  control.selected === replay.selected &&
  control.eligible === replay.eligible &&
  control.candidates === replay.candidates

const failures: string[] = []
if (!controlOk) failures.push('正控未成立：换一个槽位也必须能选中 ≥1（否则"选中 0"说明不了任何事）')
if (!zeroOk) {
  failures.push(
    '负控未成立：零期望的那几条必须"选中 0 ∧ 合格 > 0 ∧ 候选 > 0" —— ' +
      '候选 = 0 时那是"库里没有"，不是"被筛掉"，这条负控就不该被算成触发'
  )
}
if (selectExpect.length > 0 && !selectOk) {
  failures.push('断言未成立：修后档里目标那几条必须"选中 ≥1 ∧ 合格 > 0 ∧ 候选 > 0"（选中 0 = 依据仍没进上下文）')
}
for (const problem of valueProblems) failures.push(`取值断言未成立：${problem}`)
/* 计数自检（AGENTS §6.8）：断言条数为 0 与"断言全过"在输出上长得一样 */
if (zeroExpect.length === 0) failures.push('计数自检：修后档必须有 ≥1 条零期望负控')
if (mode === 'fixed' && selectExpect.length === 0) failures.push('计数自检：默认档必须有 ≥1 条选中期望')
if (mode === 'fixed' && valueAssertions === 0) failures.push('计数自检：默认档必须有 ≥1 条取值断言（否则本档什么都没检查）')
if (!restoreOk) failures.push('恢复未回到正控读数')

console.log('='.repeat(96))
console.log(`M6.1 WP5 · 召回判定探针（离线 · 零模型调用 · 隔离库）· 档 = --expect ${mode}${injectFake ? ' · ★注入假象（量具自证）' : ''}`)
console.log('='.repeat(96))
for (const row of readings) {
  console.log(`  【${row.id}】${row.origin}`)
  console.log(`     问句「${row.question}」· 槽位 ${row.slot}`)
  console.log(`     槽位说明「${row.registry?.description ?? '(未登记)'}」· 例子 ${JSON.stringify(row.registry?.examples ?? [])}`)
  console.log(
    `     库里该槽位的行 = ${row.scanned.map((r) => `${r.status}:${r.value}`).join(' / ') || '(无)'}` +
      `（active 取值 [${row.storedValues.join(' / ') || '(无)'}]）`
  )
  console.log(
    `     词面闸：问句片段 ${JSON.stringify([...row.lexical.queryFragments])} ⇒ 命中 ${String(row.lexical.hitCount)} 条` +
      `${row.lexical.hitCount > 0 ? `（${row.lexical.hitPredicates.join(',')}）` : ''}`
  )
  console.log(
    `     逐片段归因：${
      row.lexical.perFragment.map((entry) => `${entry.fragment}→${String(entry.hitCount)}`).join(' ') || '(无片段)'
    }`
  )
  console.log(
    `     候选 ${String(row.candidates)} · 合格 ${String(row.eligible)} · **选中 ${String(row.selected)}**` +
      ` · 预算裁掉 ${String(row.droppedByBudget)} · 达上下文 ${String(row.reachedContext)}` +
      ` · 阈值 minTotal=${String(row.policy.minTotal)}`
  )
  console.log(`     选中取值 = [${row.selectedValues.join(' / ') || '(空)'}] · 期望 = ${row.expectation}`)
  console.log(
    `     排除分布 = ${Object.entries(row.exclusionHistogram).map(([k, v]) => `${k}:${String(v)}`).join(' ') || '(空)'}`
  )
  console.log(`     逐条理由 = ${row.decisions.map((d) => d.reason).join(' / ') || '(无候选)'}`)
  console.log(`     记忆额度 ${String(row.memoryTokens)} / 预算 ${String(row.budgetTokens)}`)
}
console.log('')
console.log(
  `  三段式：正控（${control?.id ?? '?'} 选中 ${String(control?.selected ?? 0)} ≥ 1）= ${controlOk ? 'PASS' : '**未成立**'}` +
    ` · 断言（${selectExpect.map((row) => `${row.id}:选中${String(row.selected)}/[${row.selectedValues.join('|')}]`).join(' ') || '(本档无)'}）= ${
      selectExpect.length === 0 ? '不适用' : selectOk && valueProblems.length === 0 ? '成立' : '**未成立**'
    }` +
    ` · 负控（${zeroExpect.map((row) => `${row.id}:选中${String(row.selected)}/合格${String(row.eligible)}`).join(' ') || '(无)'}）= ${
      zeroOk ? '成立' : '**未成立**'
    }` +
    ` · 恢复 = ${restoreOk ? 'PASS' : '**失败**'}`
)
if (injectFake) console.log('  ★ 本档注入了假象：判据**必须**响（exit 3），否则说明断言是空的。')

const evidence = {
  schemaVersion: 'm6.1-recall-probe@2',
  testId: 'M6.1 / WP5 回召回判定探针（候选有、合格有、却选中 0 → 修后是否进上下文）',
  mode,
  injectedFake: injectFake,
  what: '在隔离库里按生产路径写入冻结条文的 setup，再用生产同形的召回请求问同一句，读出候选/合格/选中/**选中取值**与逐条排除理由。',
  why: '归因表 §4.4 里"依据未入模"的子形态 b（跑了召回但一条都没被选中）需要具名成因，不能停在计数上；ADR-059 修完之后，本探针改为断言"目标那几条必须进上下文且取值正确"。',
  cases: readings,
  selfProof: {
    control_must_select: { ok: controlOk, detail: control ?? null },
    target_selected_while_eligible: { ok: selectOk, detail: selectExpect },
    target_value_assertions: { ok: valueProblems.length === 0, assertions: valueAssertions, problems: valueProblems },
    negative_zero_while_eligible: { ok: zeroOk, detail: zeroExpect },
    restore_replay_control: { ok: restoreOk, detail: replay ?? null },
    inject_fake: injectFake,
  },
  failures,
  verdict: failures.length > 0 ? 'INCOMPLETE' : 'PASS',
  notProduced: [
    '本探针**不修任何东西**：它把成因具名（排除理由 + 直方图 + 选中取值）。',
    '它**不**证明"这是唯一的成因"：同一槽位在真实运行里还叠着模型与提示层的行为。',
    '它**不**打开真实库、**不**调模型 ⇒ 它证明的是"这条链在这一组语料上的判定"，不是"她实际会怎么答"。',
    '`--expect found` 是**历史档**（ADR-059 §0 的修前读数）：它在已修的树上会如实报 exit 3，那不是回归。',
  ],
}
mkdirSync(join(ROOT, 'artifacts', 'm6.1'), { recursive: true })
const evidencePath = injectFake ? 'recall-probe-injected.json' : 'recall-probe.json'
writeFileSync(join(ROOT, 'artifacts', 'm6.1', evidencePath), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
console.log(`  证据：artifacts/m6.1/${evidencePath}`)

if (failures.length > 0) {
  console.error('\n  ⚠️ 自证未成立 ⇒ 读数不可用：')
  for (const message of failures) console.error(`     · ${message}`)
  process.exitCode = 3
} else {
  process.exitCode = 0
}
