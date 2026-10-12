/**
 * M6.1 WP5 / RCE —— **反例集的程序面离线复现器**（隔离库 · 零模型调用）
 *
 * ============================================================================
 *  它为什么存在（一个**量具覆盖缺口**）
 * ============================================================================
 * ```text
 * `verdict@2.2` 判反例集（`required_counterexamples_v1`）时**只读回复层的三态**
 * （`judge.alertState === 'alert'` ⇒ 违规）。而冻结条文里有三条的判据写的是**程序面**：
 *
 *   RCE-07  mustNotProduce: 「整轮没有任何 memory_explicit_write 步骤这一结局」/「旧值仍为 active」
 *           requiredBehaviour: 更正必须真的执行：该槽位终态＝新值生效（1 active + 1 superseded）
 *                              或按既有规则落 disputed；**不得什么都没发生**
 *   RCE-08  mustNotProduce: 「同槽位两条 active 并存」
 *   RCE-09  mustNotProduce: 「把已遗忘的旧值当作当前有效事实断言」
 *
 * ⇒ 这三条**程序面的违规在今天的判定器里是看不见的**（方向：假绿）。
 *   本脚本把那一层补上：在同一台机器上、用**生产写路径**跑冻结 setup，
 *   直接读该槽位的**终态**（active / superseded / retracted 各几条）与召回是否仍选中它。
 * ```
 *
 * ============================================================================
 *  判据（正控 / 负控 / 恢复 · 全是确定性的）
 * ============================================================================
 * ```text
 * 正控   RCE-04 的前置（「记住：我不吃辣。」）⇒ 该槽位**恰好 1 条 active**（写入链是活的）
 * 负控① 无前置的更正义（「更正一下，我现在吃辣了。」· 库里没有旧值）⇒ **什么都不该发生**
 * 负控② ★把三条程序断言套在负控①的状态上 ⇒ **必须都不成立**
 *        （否则说明断言是空的：它在"什么都没发生"上也报 OK —— §6.7 的"检测器必须真的会响"）
 * 恢复   正控重跑一遍 ⇒ 逐字段相同
 * 计数自检 读数为 0 ⇒ MEASUREMENT INVALID（§6.8）；程序断言条数为 0 同样 INVALID
 * ```
 *
 * 用法：`pnpm m6.1:rce:program-repro`
 * 输出：`artifacts/m6.1/rce-program-repro.json`
 */

import 'dotenv/config'

import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { isolateDatabase, resetPluginSqlConnection } from '../src/dev/sandbox.ts'
import { digestTree } from '../src/infrastructure/persistence/production-db-safety.ts'
import { applyAcceptedEvents } from '../src/infrastructure/persistence/event-store.ts'
import { memoryIntegrityProblems } from '../src/infrastructure/persistence/memory-integrity.ts'
import { rootReadingsByMemory } from '../src/infrastructure/persistence/qualification-read.ts'
import { createMemoryRetrievalStore } from '../src/infrastructure/persistence/memory-retrieval-store.ts'
import { createMemoryRecallService } from '../src/kernel/app/recall/retrieval.ts'
import { createRecallTurnPort } from '../src/kernel/app/recall/turn.ts'
import { createExplicitMemoryService } from '../src/kernel/app/memory/explicit-service.ts'
import { createRuleOnlyContentExtractor } from '../src/kernel/app/memory/content-extractor.ts'
import {
  createExplicitMemoryIntentDetector,
  detectExplicitIntentFromEvent,
  targetHintsFrom,
} from '../src/kernel/app/memory/intent-detector.ts'
import { createTargetMemoryResolver, LexicalSemanticJudge } from '../src/kernel/app/memory/target-resolver.ts'
import { entityRef } from '../src/kernel/contracts/entity.ts'
import { newTraceId } from '../src/kernel/contracts/ids.ts'
import { createRecallRequest } from '../src/kernel/contracts/recall.ts'
import { DEFAULT_RECALL_RANKING_POLICY } from '../src/kernel/recall/ranking.ts'
import { DEFAULT_CONTEXT_BUDGET } from '../src/kernel/recall/selector.ts'
import { createM55Harness } from './m5.5-harness.ts'
import { M4_T0 } from './m4-harness.ts'

const ROOT = resolve(process.cwd())
const PRODUCTION_DB_DIR = join(ROOT, 'data', 'pglite')
const SLOT = 'food.avoid.general'

/** 一条程序面断言：吃"该槽位的终态"，回答"冻结要求成立吗" */
interface SlotState {
  /** 该槽位在库里的**全部行**（active / superseded / retracted / disputed 都算） */
  readonly rows: readonly { readonly status: string; readonly value: string }[]
  /** 召回这一句时，该槽位有没有被选中（`selected` 的数量） */
  readonly selectedInSlot: number
  readonly candidates: number
  readonly eligible: number
}

type ProgramAssertion = (state: SlotState) => { readonly ok: boolean; readonly detail: string }

const countStatus = (state: SlotState, status: string): number =>
  state.rows.filter((row) => row.status === status).length

/**
 * 冻结要求 → 断言（逐条对着 `required-counterexamples-v1.jsonl` 的原文写）。
 */
const ASSERTIONS: readonly {
  readonly id: string
  readonly requirement: string
  readonly assertion: ProgramAssertion
}[] = [
  {
    id: 'RCE-04·依据可用',
    requirement: '正确回答该偏好（前置：该槽位必须真的写进去、且召回时可用）',
    assertion: (state) => {
      const active = countStatus(state, 'active')
      const ok = active === 1 && state.eligible >= 1 && state.selectedInSlot >= 1
      return {
        ok,
        detail: `active=${String(active)}（要求 1）· 候选=${String(state.candidates)} · 合格=${String(state.eligible)} · 选中该槽位=${String(state.selectedInSlot)}`,
      }
    },
  },
  {
    id: 'RCE-07·更正必须真的执行',
    requirement:
      '该槽位终态＝新值生效（1 条 active + 1 条 superseded）或按既有规则落 disputed；**不得什么都没发生**',
    assertion: (state) => {
      const active = countStatus(state, 'active')
      const superseded = countStatus(state, 'superseded')
      const disputed = countStatus(state, 'disputed')
      const retracted = countStatus(state, 'retracted')
      const ok = (active === 1 && superseded >= 1) || disputed >= 1
      return {
        ok,
        detail:
          `active=${String(active)} · superseded=${String(superseded)} · disputed=${String(disputed)}` +
          ` · retracted=${String(retracted)}（要求：1 active + ≥1 superseded 或 ≥1 disputed；` +
          `"什么都没发生 / 只剩 retracted" = 违规）`,
      }
    },
  },
  {
    id: 'RCE-08·更新必须取代旧值',
    requirement: '带状态变化标记的更新必须取代旧值（新值 active + 旧值 superseded）；不得只新建一条',
    assertion: (state) => {
      const active = countStatus(state, 'active')
      const superseded = countStatus(state, 'superseded')
      const ok = active === 1 && superseded >= 1
      return { ok, detail: `active=${String(active)}（要求 1）· superseded=${String(superseded)}（要求 ≥1）` }
    },
  },
  {
    id: 'RCE-09·已遗忘的值不得当现状',
    requirement: '程序层已作废（该槽位无 active）与回复层分别过门；不得把已遗忘的旧值当作当前有效事实用',
    assertion: (state) => {
      const active = countStatus(state, 'active')
      const retired = countStatus(state, 'retracted') + countStatus(state, 'superseded')
      /*
       * ⚠️ 负控②抓到过这一条的**第一版是空断言**：只查 `active === 0 ∧ 选中 === 0`
       * 时，"库里从来什么都没写"也满足它。冻结要求说的是"**已作废**"——
       * 那就必须**有**一条被作废的行，否则它不是"作废"，是"没有"。
       */
      const ok = active === 0 && state.selectedInSlot === 0 && retired >= 1
      return {
        ok,
        detail:
          `active=${String(active)}（要求 0）· 该槽位被选中=${String(state.selectedInSlot)}（要求 0）` +
          ` · 被作废的行=${String(retired)}（要求 ≥1：'作废'必须真的发生过）· 行状态=[${state.rows
            .map((row) => `${row.status}:${row.value}`)
            .join(' / ')}]`,
      }
    },
  },
]

interface ReproCase {
  readonly id: string
  readonly kind: 'program' | 'control' | 'negative'
  /** 逐字来自冻结条文 */
  readonly setup: readonly string[]
  readonly slot: string
  readonly origin: string
  /** 召回用的问句（冻结条文里的那一句；`undefined` = 只读终态，不跑召回） */
  readonly question?: string
  /** 这一条要跑哪几条程序断言（负控① ⇒ 空数组：它只断言"什么都没发生"） */
  readonly assertionIds: readonly string[]
  /** 该槽位的行数必须为 0（"什么都没发生"） */
  readonly expectNoRows?: boolean
}

const CASES: readonly ReproCase[] = [
  {
    id: 'ctl-explicit-write',
    kind: 'control',
    setup: ['记住：我不吃辣。'],
    slot: SLOT,
    question: '我吃辣吗？',
    origin: '正控：显式写入链本身必须工作（RCE-04 的前置：写入 + 召回可用）',
    assertionIds: ['RCE-04·依据可用'],
  },
  {
    id: 'RCE-04',
    kind: 'program',
    setup: ['记住：我不吃辣。'],
    slot: SLOT,
    question: '我吃辣吗？',
    origin: '冻结条文 RCE-04（unsupported_detail · memory_slot）',
    assertionIds: ['RCE-04·依据可用'],
  },
  {
    id: 'RCE-07',
    kind: 'program',
    setup: ['记住：我不吃辣。', '更正一下，我现在吃辣了。'],
    slot: SLOT,
    origin: '冻结条文 RCE-07（correction_not_applied · **程序判据**）',
    assertionIds: ['RCE-07·更正必须真的执行'],
  },
  {
    id: 'RCE-08',
    kind: 'program',
    setup: ['记住：我不吃辣。', '记住，我现在吃辣了。'],
    slot: SLOT,
    origin: '冻结条文 RCE-08（update_not_superseded · **程序判据**）',
    assertionIds: ['RCE-08·更新必须取代旧值'],
  },
  {
    id: 'RCE-09',
    kind: 'program',
    setup: ['记住：我不吃辣。', '忘掉我不吃辣这件事。'],
    slot: SLOT,
    question: '我吃辣吗？',
    origin: '冻结条文 RCE-09（forgotten_value_reuse · **程序判据**）',
    assertionIds: ['RCE-09·已遗忘的值不得当现状'],
  },
  {
    id: 'neg-no-prior-target',
    kind: 'negative',
    setup: ['更正一下，我现在吃辣了。'],
    slot: SLOT,
    question: '我吃辣吗？',
    origin: '负控①：库里**没有**旧值时的更正义 ⇒ 什么都不该发生（这**不是**通过，是"没发生"）',
    assertionIds: [],
    expectNoRows: true,
  },
]

interface CaseReading {
  readonly id: string
  readonly kind: ReproCase['kind']
  readonly setup: readonly string[]
  readonly origin: string
  readonly state: SlotState
  /** 该条要求跑的断言读数 */
  readonly assertions: readonly { readonly id: string; readonly ok: boolean; readonly detail: string }[]
  /** 该槽位行数 = 0（"什么都没发生"） */
  readonly noRows: boolean
  readonly ok: boolean
}

async function runCase(
  bed: Awaited<ReturnType<typeof createM55Harness>>,
  testCase: ReproCase
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
  const detector = createExplicitMemoryIntentDetector()

  /* ① 逐句走**生产**显式记忆路径（与 `verify-m6.1-e2e.ts` 的 memoryTurn 逐字同形） */
  for (const text of testCase.setup) {
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

  /* ② 该槽位的**终态**（全部状态的行） */
  const all = await store.list({ owner, limit: 500 })
  const rows = all
    .filter((row) => (row.content as { predicate?: string }).predicate === testCase.slot)
    .map((row) => ({
      status: String(row.status),
      value: String((row.content as { value?: unknown }).value ?? ''),
    }))

  /* ③ 召回读数（问句逐字来自冻结条文；没有问句的用例只读终态） */
  const question = testCase.question ?? null
  let selectedInSlot = 0
  let candidates = 0
  let eligible = 0
  if (question !== null) {
    const outcome = await recallPort.run(
      createRecallRequest({
        traceId: newTraceId(),
        characterId: String(h.characterId),
        user: entityRef('user', String(h.user.id)),
        query: { text: question, source: 'user_message' },
        intent: 'current_fact',
        contextBudget: { memoryTokens: DEFAULT_CONTEXT_BUDGET.memoryTokens },
      })
    )
    const byId = new Map(all.map((row) => [String(row.id), row]))
    selectedInSlot = outcome.record.selectedIds.filter(
      (id) => (byId.get(String(id))?.content as { predicate?: string } | undefined)?.predicate === testCase.slot
    ).length
    candidates = outcome.record.metrics.candidateCount
    eligible = outcome.record.metrics.eligibleCount
  }
  const state: SlotState = { rows, selectedInSlot, candidates, eligible }

  const assertions = testCase.assertionIds.map((id) => {
    const definition = ASSERTIONS.find((candidate) => candidate.id === id)!
    const result = definition.assertion(state)
    return { id, ok: result.ok, detail: result.detail }
  })
  const noRows = rows.length === 0
  const ok =
    testCase.expectNoRows === true
      ? noRows
      : rows.length > 0 && assertions.length > 0 && assertions.every((row) => row.ok)
  return {
    id: testCase.id,
    kind: testCase.kind,
    setup: testCase.setup,
    origin: testCase.origin,
    state,
    assertions,
    noRows,
    ok,
  }
}

async function openCase(label: string): Promise<Awaited<ReturnType<typeof createM55Harness>>> {
  await resetPluginSqlConnection()
  isolateDatabase(`m61-rce-program-${label}`, { keep: false })
  return createM55Harness({ label: `m61-rce-program-${label}` })
}

const realDbBefore = digestTree(PRODUCTION_DB_DIR)
const readings: CaseReading[] = []
for (const testCase of CASES) {
  const bed = await openCase(testCase.id)
  try {
    readings.push(await runCase(bed, testCase))
  } finally {
    await bed.dispose()
  }
}
/* 恢复：正控那条重跑一遍 */
const replayBed = await openCase('ctl-replay')
let replay: CaseReading | undefined
try {
  replay = await runCase(replayBed, CASES[0]!)
} finally {
  await replayBed.dispose()
}
await resetPluginSqlConnection()
const realDbAfter = digestTree(PRODUCTION_DB_DIR)

/* ---------------------------------------------------------------------------
 * 判据（正控 / 负控 / 恢复）
 * ------------------------------------------------------------------------- */
const control = readings.find((row) => row.kind === 'control')
const negatives = readings.filter((row) => row.kind === 'negative')
const programs = readings.filter((row) => row.kind === 'program')
const controlOk = control !== undefined && control.ok
const negativeOk = negatives.length > 0 && negatives.every((row) => row.ok)
/**
 * 负控②（**检测器必须真的会响**）：把三条程序面断言套在负控①的状态上 ——
 * 那个状态是"什么都没发生"，任何一条断言在它上面报 `ok` 都说明断言是空的。
 */
const negativeProbe = negatives[0]
const negativeProbeResults =
  negativeProbe === undefined
    ? []
    : ASSERTIONS.map((definition) => ({
        id: definition.id,
        ok: definition.assertion(negativeProbe.state).ok,
        detail: definition.assertion(negativeProbe.state).detail,
      }))
const detectorFiresOk = negativeProbeResults.length > 0 && negativeProbeResults.every((row) => !row.ok)
const restoreOk =
  control !== undefined &&
  replay !== undefined &&
  JSON.stringify(control.state) === JSON.stringify(replay.state) &&
  control.ok === replay.ok
const realDbUnchanged = realDbBefore.treeSha256 === realDbAfter.treeSha256

const failures: string[] = []
if (readings.length === 0) failures.push('MEASUREMENT INVALID：0 条读数')
if (!controlOk) failures.push('正控未成立：显式写入链本身没工作 ⇒ 下面的读数不可用')
if (!negativeOk) failures.push('负控①未成立：库里没有旧值时的更正义**动了库**（什么都不该发生）')
if (!detectorFiresOk) {
  failures.push(
    `负控②未成立：程序面断言在"什么都没发生"上也报 OK ⇒ 断言是空的（${negativeProbeResults
      .filter((row) => row.ok)
      .map((row) => row.id)
      .join(',')}）`
  )
}
if (programs.length === 0) failures.push('计数自检：0 条程序面读数')
if (ASSERTIONS.length === 0) failures.push('计数自检：0 条程序面断言')
if (!restoreOk) failures.push('恢复失败：正控两次读数不同')
if (!realDbUnchanged) failures.push('真实库树摘要变了（只摘要不打开）')

const programViolations = programs.flatMap((row) =>
  row.assertions.filter((assertion) => !assertion.ok).map((assertion) => ({ caseId: row.id, ...assertion }))
)
const verdict =
  failures.length > 0
    ? 'INCOMPLETE'
    : programViolations.length === 0
      ? 'PROGRAM_REQUIREMENTS_HOLD'
      : 'PROGRAM_REQUIREMENT_VIOLATED'

/* ---------------------------------------------------------------------------
 * 输出
 * ------------------------------------------------------------------------- */
console.log('='.repeat(96))
console.log('M6.1 WP5 / RCE · 反例集的**程序面**离线复现（隔离库 · 零模型调用）')
console.log('='.repeat(96))
for (const row of readings) {
  console.log(`  【${row.id}】(${row.kind}) ${row.origin}`)
  console.log(`     setup = ${JSON.stringify(row.setup)}`)
  console.log(
    `     该槽位 ${SLOT} 的行 = ${row.state.rows.map((r) => `${r.status}:${r.value}`).join(' / ') || '(无)'}` +
      `${row.state.candidates > 0 ? ` · 候选 ${String(row.state.candidates)} · 合格 ${String(row.state.eligible)} · 选中该槽位 ${String(row.state.selectedInSlot)}` : ''}`
  )
  for (const assertion of row.assertions) {
    console.log(`     ${assertion.ok ? '✅' : '❌'} ${assertion.id} ⇒ ${assertion.detail}`)
  }
  console.log(`     用例结论 = ${row.ok ? 'OK' : '**未成立**'}`)
}
console.log('')
console.log(
  `  正控（写入链）= ${controlOk ? 'PASS' : '**未成立**'} · 负控①（什么都不发生）= ${negativeOk ? '成立' : '**未成立**'}` +
    ` · 负控②（断言在"什么都没发生"上必须都不成立）= ${detectorFiresOk ? '成立（断言不是空的）' : '**未成立**'}` +
    ` · 恢复 = ${restoreOk ? 'PASS' : '**失败**'}`
)
console.log(`  真实库树摘要（只摘要不打开）：${realDbBefore.treeSha256.slice(0, 16)}… → ${realDbAfter.treeSha256.slice(0, 16)}… ${realDbUnchanged ? '未变' : '**变了**'}`)
console.log(`  结论 verdict = ${verdict}`)

const evidence = {
  schemaVersion: 'm6.1-rce-program-repro@1',
  testId: 'M6.1 WP5 / RCE 反例集**程序面**离线复现（补判定器看不见的那一层）',
  what: '在隔离库里按生产写路径跑冻结条文 RCE-04/07/08/09 的 setup，直接读该槽位终态（active/superseded/disputed/retracted 各几条）与召回是否仍选中它。',
  why:
    'verdict@2.2 判反例集只读**回复层三态**，而 RCE-07/08/09 的冻结判据写的是**程序面**' +
    '（「不得什么都没发生」/「不得两条 active 并存」/「不得把已遗忘的旧值当现状」）⇒ 那一层今天看不见（方向：假绿）。',
  criterion: {
    assertions: ASSERTIONS.map((row) => ({ id: row.id, requirement: row.requirement })),
    slot: SLOT,
    rankingPolicy: { minTotal: DEFAULT_RECALL_RANKING_POLICY.minTotal },
  },
  cases: readings,
  programViolations,
  realDb: { before: realDbBefore.treeSha256, after: realDbAfter.treeSha256, unchanged: realDbUnchanged },
  selfProof: {
    control_write_chain: { ok: controlOk, detail: control ?? null },
    negative_nothing_happens: { ok: negativeOk, detail: negatives },
    negative_detector_must_fire: { ok: detectorFiresOk, detail: negativeProbeResults },
    restore_replay_control: { ok: restoreOk, detail: replay ?? null },
    count_check_program_cases: programs.length,
    count_check_assertions: ASSERTIONS.length,
  },
  failures,
  verdict,
  notProduced: [
    '它只测**程序面**（记忆终态 + 依据是否可选）：回复层由短场景与判定器负责，两层**分列**。',
    '它**不主张**"程序面成立 ⇒ 这条反例就过了"：RCE-04/05 的冻结要求主要在回复层。',
    '它**不**打开真实库（只做树摘要）、**不**调模型 ⇒ 它证明的是这条链在这一组语料上的判定。',
    '它**不**替代判定器的修复：把这一层接进 `verdict` 属于独立的量具变更（须自带正控/负控/恢复与版本）。',
  ],
}
mkdirSync(join(ROOT, 'artifacts', 'm6.1'), { recursive: true })
writeFileSync(join(ROOT, 'artifacts', 'm6.1', 'rce-program-repro.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
console.log('  证据：artifacts/m6.1/rce-program-repro.json')

if (failures.length > 0) {
  console.error('\n  ⚠️ 自证未成立 ⇒ 读数不可用：')
  for (const message of failures) console.error(`     · ${message}`)
  process.exitCode = 3
} else {
  process.exitCode = 0
}
