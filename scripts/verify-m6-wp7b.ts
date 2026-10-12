/**
 * M6 **WP7b 门** —— 跨午夜／时区／三个时间通道 + 同轮「记忆 + 搜索 + 摘要」预算竞争 + 本地评审包。
 *
 * ============================================================================
 *  它判什么（一行一条计划书依据）
 * ============================================================================
 * ```text
 *   §3.2 L174  clock 已存在 ⇒ M6 只测：跨午夜 · 时区 · "事件发生时间／记录时间／当前时间"的区分；
 *              **不重复开发"知道时间"**（模拟时间 logicalTime 必须被拒绝）
 *   §3.2 L170  唯一 prompt 入口仍是 ContextCompiler（本门不新造第二入口）
 *   §3.2 L171  摘要保持**可裁**且**最低优先级**；不许挤掉不可裁的身份／完整性规则／当前输入／程序结果事实
 *   §3.2 L172  "**被选中不等于最终入模**" —— 两个读数必须同时存在且可区分
 *   §3.2 L173  不可裁部分超总预算时走明确语义，**不伪报** used <= budget
 *   §WP7 L360  追加覆盖项：同轮「记忆 + 搜索 + 摘要」预算竞争 · 跨午夜
 *   §9   L532  本地合成对话评审包放 gitignored 目录（`artifacts/m6/local/`）；
 *              只提交**无敏感正文**的机器证据
 * ```
 *
 * 三条纪律（与 WP7a 一致）：
 * 1. **用户侧是真的自然语言**：真 `TurnGateway`（`beginTurn` → `compileTurn` → `completeTurn`）
 *    + 生产显式记忆轮次端口；不用内部 API 代替用户表达；
 * 2. **一切都在合成隔离库**（`isolateDatabase`），真实库只做只读摘要；
 * 3. **别人的命题不重实现**：额度合法性的部件级判据由子门 `verify-m5-budget.ts` 承载，
 *    本门只写 `itemCoverage` 映射（少了会互相冒充，多了会两套真理）。
 *
 * ⚠️ 预算不手抄常数：先测"宽预算"那一轮的**实际** section 规模，再按实测值算紧预算。
 *    若实测形状让用例在数学上不可能成立（例如"摘要比记忆还小"），本门如实报红并写明
 *    MEASUREMENT INVALID，而不是悄悄判 PASS（`AGENTS.md` §6.8）。
 *
 * 用法：`pnpm exec tsx scripts/verify-m6-wp7b.ts`
 */
import 'dotenv/config'

import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import { cleanupSandbox, isolateDatabase, resetPluginSqlConnection } from '../src/dev/sandbox.ts'
import { applyAcceptedEvents } from '../src/infrastructure/persistence/event-store.ts'
import { digestTree } from '../src/infrastructure/persistence/production-db-safety.ts'
import { memoryIntegrityProblems } from '../src/infrastructure/persistence/memory-integrity.ts'
import { createMemoryRetrievalStore } from '../src/infrastructure/persistence/memory-retrieval-store.ts'
import { rootReadingsByMemory } from '../src/infrastructure/persistence/qualification-read.ts'
import { createRollupSourceReader } from '../src/infrastructure/persistence/rollup-source-store.ts'
import { createFixtureSearchProvider } from '../src/infrastructure/search/fixture-search-provider.ts'
import { createExplicitMemoryIntentDetector, detectExplicitIntentFromEvent } from '../src/kernel/app/memory/intent-detector.ts'
import { createRuleOnlyContentExtractor } from '../src/kernel/app/memory/content-extractor.ts'
import { createTargetMemoryResolver, LexicalSemanticJudge } from '../src/kernel/app/memory/target-resolver.ts'
import { createExplicitMemoryService } from '../src/kernel/app/memory/explicit-service.ts'
import { createExplicitMemoryTurnPort } from '../src/kernel/app/memory/explicit-turn.ts'
import { createMemoryRecallService } from '../src/kernel/app/recall/retrieval.ts'
import { createRecallTurnPort } from '../src/kernel/app/recall/turn.ts'
import { createRollupTurnPort } from '../src/kernel/app/rollup/turn.ts'
import { CLOCK_TIME_ZONE, renderClockBlock } from '../src/kernel/context/sections.ts'
import { assertEventTime, eventTimeOf } from '../src/kernel/contracts/time.ts'
import { DEFAULT_CONTEXT_BUDGET } from '../src/kernel/recall/selector.ts'
import { createReporter } from './m4-harness.ts'
import { createM55Harness } from './m5.5-harness.ts'
import { measureRealDbDrift } from './inc-01-real-db-drift.ts'

const ROOT = resolve('.')
const REAL_DB = resolve('data/pglite')
const report = createReporter()
const check = (label: string, pass: boolean, reading: string): void =>
  report.check(label, pass, reading)

const head = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
const runId = `m6-wp7b-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${head.slice(0, 12)}`
const outDir = join(ROOT, 'artifacts/m6', runId)
mkdirSync(outDir, { recursive: true })
/** 评审包：**gitignored** 目录（`.gitignore` 里的 `artifacts/m6/local/`） */
const reviewDir = join(ROOT, 'artifacts/m6/local', runId)
mkdirSync(reviewDir, { recursive: true })
const artifactPath = join(outDir, 'e2e.json')
const reviewPath = join(reviewDir, 'review-packet.json')
const realBefore = digestTree(REAL_DB)
console.log(`runId=${runId}\n`)

/**
 * 评审包哨兵：只该出现在**评审包**里，不该出现在 trace、也不该出现在提交的机器证据里。
 * 选一个不会被规则抽取器当记忆写的句子（`我最近…` ⇒ `no_intent`），
 * 这样"它没有出现在别处"就排除了"它根本没被系统看到"这个解释。
 */
const SENTINEL_TAG = '评审包哨兵'
const SENTINEL_BODY = `${SENTINEL_TAG}-我最近喜欢看深夜的云`

/** +08:00 的挂钟时刻 → epoch（只用于**构造**用例；断言一律针对渲染结果） */
const CLOCK_E1 = Date.UTC(2026, 8, 21, 15, 59) // 本地 2026-09-21 星期一 23:59
const CLOCK_E2 = Date.UTC(2026, 8, 21, 16, 1) // 本地 2026-09-22 星期二 00:01（相隔 2 分钟）
const CLOCK_E3 = Date.UTC(2026, 8, 21, 20, 0) // 本地 2026-09-22 星期二 04:00（UTC 日期不同）

const searchFixture = (): ReturnType<typeof createFixtureSearchProvider> =>
  createFixtureSearchProvider({
    id: 'fixture-offline',
    items: [
      {
        title: 'SENTINEL-WP7B-网页标题',
        url: 'https://example.invalid/wp7b',
        snippet: 'SENTINEL-WP7B-网页正文',
      },
    ],
  })

// ---------------------------------------------------------------------------
// 读一轮：把"被选中"与"实际入模"两套读数都取出来（trace 是唯一来源）
// ---------------------------------------------------------------------------

interface SectionReading {
  id: string
  droppable: boolean
  tokens: number
  sourceRefs: string[]
}

interface TurnReading {
  text: string
  replyText: string
  sections: SectionReading[]
  sectionIds: string[]
  dropped: string[]
  estimatedTokens: number
  packetRefs: string[]
  clockText: string | null
  rollupText: string
  rollupItems: number
  rollupSurvived: number
  rollupOmittedEligible: number
  rollupCoverageTruncated: boolean
  rollupRejectedInvalidated: number
  traceEstimatedTokens: number
  memory: {
    selected: number
    intendedSelected: number
    reachedContext: boolean
    droppedByContextBudget: boolean
    budgetTokens: number
  }
  evidence: {
    bundleAttached: number
    selected: number
    candidates: number
    contextBudgetDropped: number
    evidenceBudgetDropped: number
  }
  traceId: string
  eventId: string
  /** 全部 step 的 kind/label/属性序列化 —— 隐私负控（正文哨兵不得出现在这里） */
  traceText: string
}

const numberAttr = (value: unknown, fallback = -1): number =>
  typeof value === 'number' ? value : fallback
const booleanAttr = (value: unknown, fallback = false): boolean =>
  typeof value === 'boolean' ? value : fallback

// ---------------------------------------------------------------------------
// 场景装配
// ---------------------------------------------------------------------------

interface TurnOptions {
  search?: 'off' | 'on'
  evidenceTokens?: number
  rollup?: boolean
  rollupTokens?: number
  tokenBudget?: number
  clockEpochMs?: number
}

interface Scenario {
  label: string
  say: (text: string, replyText: string, options?: TurnOptions) => Promise<TurnReading>
  memoryTurn: (text: string) => Promise<string>
  recordOnly: (text: string) => Promise<{ createdAt: number; occurredAt: number | undefined }>
  activeCount: () => Promise<number>
  lastActionId: () => Promise<string | null>
  dispose: () => Promise<void>
}

let live: Scenario | undefined

async function openScenario(label: string): Promise<Scenario> {
  if (live !== undefined) {
    await live.dispose()
    live = undefined
  }
  await resetPluginSqlConnection()
  const sandbox = isolateDatabase(`m6-wp7b-${label}`, { keep: true })
  let disposed = false
  const bed = await createM55Harness({ label: `m6-wp7b-${label}`, provider: searchFixture() })
  const h = bed.h
  const { owner, user, db, store } = h

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
  })
  const memoryPort = createExplicitMemoryTurnPort({ service })
  const detector = createExplicitMemoryIntentDetector()
  const rollupPort = createRollupTurnPort({ reader: createRollupSourceReader(db) })
  const recallPort = createRecallTurnPort({
    service: createMemoryRecallService({
      port: createMemoryRetrievalStore({
        store: h.store,
        integrity: (o) => memoryIntegrityProblems(h.db, o),
        rootReadings: (ids) => rootReadingsByMemory(h.db, ids),
      }),
    }),
    budget: DEFAULT_CONTEXT_BUDGET,
    now: () => Date.now(),
  })

  const scenario: Scenario = {
    label,
    async say(text, replyText, options) {
      const gateway = bed.gatewayOf({
        search: options?.search ?? 'off',
        recall: recallPort,
        ...(options?.rollup === false ? {} : { rollup: rollupPort }),
        ...(options?.rollupTokens !== undefined ? { rollupTokens: options.rollupTokens } : {}),
        ...(options?.evidenceTokens !== undefined ? { evidenceTokens: options.evidenceTokens } : {}),
        ...(options?.tokenBudget !== undefined ? { tokenBudget: options.tokenBudget } : {}),
      })
      const turn = await bed.say({
        gateway,
        text,
        replyText,
        ...(options?.clockEpochMs !== undefined ? { clockEpochMs: options.clockEpochMs } : {}),
      })
      const packet = turn.packet
      const steps = turn.trace.steps
      const stepOf = (kind: string) => steps.find((step) => step.kind === kind)
      const contextStep = stepOf('context_compile')
      const memoryStep = stepOf('memory_recall')
      const evidenceStep = stepOf('external_evidence')
      const clockSection = packet.sections.find((s) => String(s.id) === 'clock')
      const rollupSection = packet.sections.find((s) => String(s.id) === 'rolling-summary')

      /*
       * 记忆那一步的 `droppedByContextBudget` 只在 `decisionRecord` 里（属性表是扁平子集），
       * 所以要解析那个 JSON 字符串。它缺字段/坏掉时**如实报 -1**，不编一个 0。
       */
      const decisionRecord = memoryStep?.attributes.decisionRecord
      let intended = -1
      let droppedByContext = false
      if (typeof decisionRecord === 'string') {
        try {
          const parsed = JSON.parse(decisionRecord) as {
            intendedSelectedIds?: unknown[]
            metrics?: { droppedByContextBudget?: unknown }
          }
          intended = Array.isArray(parsed.intendedSelectedIds) ? parsed.intendedSelectedIds.length : -1
          droppedByContext = parsed.metrics?.droppedByContextBudget === true
        } catch {
          intended = -1
        }
      }
      return {
        text,
        replyText,
        sections: packet.sections.map((s) => ({
          id: String(s.id),
          droppable: s.droppable !== false,
          tokens: numberAttr(s.estimatedTokens, 0),
          sourceRefs: [...(s.sourceRefs ?? [])],
        })),
        sectionIds: packet.sections.map((s) => String(s.id)),
        dropped: [...packet.droppedSectionIds],
        estimatedTokens: numberAttr(packet.estimatedTokens, -1),
        packetRefs: [...packet.sourceConversationEventIds],
        clockText: clockSection === undefined ? null : String(clockSection.content ?? ''),
        rollupText: rollupSection === undefined ? '' : String(rollupSection.content ?? ''),
        rollupItems: numberAttr(contextStep?.attributes.rollup_items),
        rollupSurvived: numberAttr(contextStep?.attributes.rollup_section_survived),
        rollupOmittedEligible: numberAttr(contextStep?.attributes.rollup_omitted_eligible),
        rollupCoverageTruncated: booleanAttr(contextStep?.attributes.rollup_coverage_truncated),
        rollupRejectedInvalidated: numberAttr(contextStep?.attributes.rollup_rejected_invalidated),
        traceEstimatedTokens: numberAttr(contextStep?.attributes.estimatedTokens),
        memory: {
          selected: numberAttr(memoryStep?.attributes.selected),
          intendedSelected: intended,
          reachedContext: booleanAttr(memoryStep?.attributes.reachedContext),
          droppedByContextBudget: droppedByContext,
          budgetTokens: numberAttr(memoryStep?.attributes.budgetTokens),
        },
        evidence: {
          bundleAttached: numberAttr(evidenceStep?.attributes.bundle_attached_count),
          selected: numberAttr(evidenceStep?.attributes.selected_count),
          candidates: numberAttr(evidenceStep?.attributes.candidate_count),
          contextBudgetDropped: numberAttr(evidenceStep?.attributes.context_budget_dropped_count),
          evidenceBudgetDropped: numberAttr(evidenceStep?.attributes.evidence_budget_dropped_count),
        },
        traceId: String(turn.trace.traceId),
        eventId: String(turn.turn.userEvent?.id ?? ''),
        traceText: JSON.stringify(
          steps.map((step) => ({ kind: step.kind, label: step.label, attributes: step.attributes }))
        ),
      }
    },
    async memoryTurn(text) {
      const recorded = await h.recordUserEvidence(text)
      await detectExplicitIntentFromEvent(detector, {
        id: recorded.ref.id as never,
        actorType: 'user',
        content: text,
      })
      const result = await memoryPort.handleTurn({
        owner,
        speaker: user,
        event: { id: recorded.ref.id as never, actorType: 'user', content: text },
      })
      return result === undefined ? 'no_intent' : String(result.kind)
    },
    async recordOnly(text) {
      const recorded = await h.recordUserEvidence(text)
      return { createdAt: recorded.event.createdAt, occurredAt: recorded.event.occurredAt }
    },
    async activeCount() {
      const rows = await store.list({ owner, status: 'active', limit: 50 })
      return rows.length
    },
    async lastActionId() {
      const rows = await bed.actionRows()
      const last = rows[rows.length - 1]
      return last === undefined ? null : String(last.actionId)
    },
    async dispose() {
      // 幂等：显式 dispose 之后，`openScenario` 还会再收一次尾（不幂等就会重复清理沙箱）
      if (disposed) return
      disposed = true
      await bed.dispose()
      cleanupSandbox(sandbox.dir)
    },
  }
  live = scenario
  return scenario
}

/** 收尾（写在函数里：避免顶层流分析把 `live` 收窄成 `never`） */
const disposeLive = async (): Promise<void> => {
  const current = live
  if (current !== undefined) {
    await current.dispose()
    live = undefined
  }
}

// ---------------------------------------------------------------------------
// 评审包（本地、gitignored；人看的）
// ---------------------------------------------------------------------------

interface ReviewCase {
  id: string
  input: string
  reply: string
  readings: Record<string, string | number | boolean>
  reasonCodes: string[]
  runId: string
  codeCommit: string
  traceId: string
  eventId: string
  actionId?: string
}

const reviewCases: ReviewCase[] = []
const reviewCase = (
  id: string,
  turn: TurnReading,
  readings: Record<string, string | number | boolean>,
  reasonCodes: string[],
  actionId?: string
): void => {
  reviewCases.push({
    id,
    input: turn.text,
    reply: turn.replyText,
    readings,
    reasonCodes,
    runId,
    codeCommit: head,
    traceId: turn.traceId,
    eventId: turn.eventId,
    ...(actionId !== undefined ? { actionId } : {}),
  })
}

// ===========================================================================
// T 时钟：跨午夜 / 时区 / 三个时间通道
// ===========================================================================

report.section('T 时钟：跨午夜 · 时区 · 事件发生时间／记录时间／当前时间')
let sentinelWitnessTrace = ''
{
  const s = await openScenario('t')
  // 午夜前：走**生产显式记忆入口**写一条（它自己也会落一条 user_message 事件）
  const written = await s.memoryTurn('记住，我不吃香菜')
  const beforeMidnight = await s.say(SENTINEL_BODY, '（她如实应答）', {
    rollupTokens: 400,
    clockEpochMs: CLOCK_E1,
  })
  const afterMidnight = await s.say('我们刚聊到哪儿了？', '（她如实应答）', {
    rollupTokens: 400,
    clockEpochMs: CLOCK_E2,
  })
  const activeAfterMidnight = await s.activeCount()
  const recordedProbe = await s.recordOnly('（探针：只读时间字段，不给评审看）')
  const systemNow = Date.now()

  const clockRefBefore = beforeMidnight.sections.find((x) => x.id === 'clock')?.sourceRefs ?? []
  const clockRefAfter = afterMidnight.sections.find((x) => x.id === 'clock')?.sourceRefs ?? []
  const epochOf = (refs: string[]): number => {
    const ref = refs.find((r) => r.startsWith('clock:'))
    return ref === undefined ? Number.NaN : Number(ref.slice('clock:'.length))
  }
  const localLine = (r: TurnReading): string | null => r.clockText?.split('\n')[2] ?? null

  check(
    'T1 · 跨午夜：同一会话前后两轮（相隔 **2 分钟**）跨过 +08:00 的 00:00 —— 前一轮 23:59 星期一、后一轮 00:01 星期二，两轮 clock 引用相差 120000ms',
    beforeMidnight.clockText?.includes('2026-09-21 星期一 23:59') === true &&
      afterMidnight.clockText?.includes('2026-09-22 星期二 00:01') === true &&
      beforeMidnight.clockText?.includes('东八区') === true &&
      afterMidnight.clockText?.includes('东八区') === true &&
      epochOf(clockRefAfter) - epochOf(clockRefBefore) === 120_000,
    `前=${JSON.stringify(localLine(beforeMidnight))} ref=${JSON.stringify(clockRefBefore)} · 后=${JSON.stringify(localLine(afterMidnight))} ref=${JSON.stringify(clockRefAfter)}`
  )

  /*
   * 时区负控：取一个"UTC 日期与本地日期不同"的时刻。若渲染其实念的是 UTC，
   * 这一条会读到 2026-09-21 20:00；只有真按 `CLOCK_TIME_ZONE` 换算才会是 09-22 04:00。
   */
  const shifted = renderClockBlock(CLOCK_E3)
  const utcDate = new Date(CLOCK_E3).toISOString().slice(0, 10)
  check(
    'T2 · 时区**真的被应用**（负控）：UTC 还是 09-21 的那一刻，她看到的是 09-22 04:00 —— 不是把 UTC 直接念出来；唯一真源是 `CLOCK_TIME_ZONE`',
    shifted.includes('2026-09-22 星期二 04:00') &&
      shifted.includes('东八区') &&
      utcDate === '2026-09-21' &&
      CLOCK_TIME_ZONE === 'Asia/Shanghai',
    `utc=${utcDate} · 本地渲染=${JSON.stringify(shifted.split('\n')[2] ?? null)} · tz=${CLOCK_TIME_ZONE}`
  )

  /*
   * 三个通道**分列**：她以为的"现在"（clock section）／系统**记录**这条事件的时刻（createdAt）
   * ／这件事**发生**的时刻（occurredAt —— 缺省是"不知道"，而**不是**"等于现在"）。
   */
  const recordIsSystemClock = Math.abs(recordedProbe.createdAt - systemNow) < 60_000
  const recordIsNotBelievedNow = recordedProbe.createdAt !== CLOCK_E1
  const occurredAtAbsent = recordedProbe.occurredAt === undefined
  const R = 1_700_000_000_000
  const O = R - 86_400_000
  const twoTimes = eventTimeOf(R, O)
  let logicalTimeCode = '(没有抛)'
  try {
    assertEventTime({ recordedAt: R, logicalTime: '2026-09-22T00:01:00+08:00' })
  } catch (error) {
    logicalTimeCode = String((error as { code?: unknown }).code ?? '(无 code)')
  }
  check(
    'T3 · 三个通道**分列**：她看到的"现在"来自注入的 clock epoch；事件的 `createdAt`（=recordedAt）来自**系统真实时钟**且 ≠ 她以为的现在；`occurredAt` 缺省是"不知道"（不是"等于现在"）',
    recordIsSystemClock &&
      recordIsNotBelievedNow &&
      occurredAtAbsent &&
      twoTimes.recordedAt === R &&
      twoTimes.occurredAt === O,
    `createdAt 来自系统时钟=${String(recordIsSystemClock)} · ≠注入时钟=${String(recordIsNotBelievedNow)} · occurredAt 缺省=${String(occurredAtAbsent)} · 两个值可同时保留=${String(twoTimes.occurredAt === O)}`
  )
  check(
    'T3b · 不新造模拟时钟（负控）：`logicalTime` 非空 ⇒ `assertEventTime` 失败关闭（`simulation_time_not_supported`），不是"存下来但没人按它排序"',
    logicalTimeCode === 'simulation_time_not_supported',
    `code=${logicalTimeCode}`
  )
  check(
    'T4 · 跨午夜**不重置记忆**：午夜前写的记忆到午夜后仍是 active；午夜后的摘要块里仍有午夜前那条声明的原文；`invalidated_by_memory_state` 为 0',
    written === 'written' &&
      activeAfterMidnight >= 1 &&
      afterMidnight.clockText?.includes('2026-09-22') === true &&
      afterMidnight.rollupText.includes('记住，我不吃香菜') &&
      afterMidnight.rollupRejectedInvalidated === 0,
    `memoryTurn=${written} · active=${activeAfterMidnight} · 跨午夜摘要含午夜前声明=${String(afterMidnight.rollupText.includes('记住，我不吃香菜'))} · rollupItems=${afterMidnight.rollupItems} · 失效拒收=${afterMidnight.rollupRejectedInvalidated}`
  )
  check(
    'T5 · trace 能回答"她那一轮以为现在是几点"：clock section 的引用就是 `clock:<这一轮的 epoch>`（不是进程启动时刻），并进了 packet 的来源集合',
    clockRefBefore.includes(`clock:${CLOCK_E1}`) &&
      clockRefAfter.includes(`clock:${CLOCK_E2}`) &&
      beforeMidnight.packetRefs.includes(`clock:${CLOCK_E1}`),
    `refs=${JSON.stringify(clockRefBefore)} → ${JSON.stringify(clockRefAfter)} · packetRefs 含 clock=${String(beforeMidnight.packetRefs.includes(`clock:${CLOCK_E1}`))}`
  )

  reviewCase(
    'T-午夜前（带哨兵）',
    beforeMidnight,
    {
      clock: localLine(beforeMidnight) ?? '',
      sections: beforeMidnight.sectionIds.join(','),
      rollupItems: beforeMidnight.rollupItems,
    },
    ['CLOCK_INJECTED'],
    undefined
  )
  reviewCase(
    'T-午夜后',
    afterMidnight,
    {
      clock: localLine(afterMidnight) ?? '',
      sections: afterMidnight.sectionIds.join(','),
      rollupMentionsPreMidnightClaim: afterMidnight.rollupText.includes('记住，我不吃香菜'),
    },
    ['CROSS_MIDNIGHT'],
    undefined
  )
  sentinelWitnessTrace = beforeMidnight.traceText
  await s.dispose()
}

// ===========================================================================
// P 同轮「记忆 + 搜索 + 摘要」预算竞争
// ===========================================================================

report.section('P 同轮预算竞争：记忆 + 搜索 + 摘要 争同一份额度')
{
  const s = await openScenario('p')
  await s.memoryTurn('记住，我不吃香菜')
  const ask = '我平时吃香菜吗？顺便帮我查一下香菜的做法'

  // ① 宽预算正控：三者都真的入模（否则后面的"被裁"说明不了问题）
  const wide = await s.say(ask, '（她如实回答）', { search: 'on', rollupTokens: 400 })
  const tokensOf = (r: TurnReading, id: string): number =>
    r.sections.find((x) => x.id === id)?.tokens ?? -1
  const base = wide.sections.filter((x) => !x.droppable).reduce((sum, x) => sum + x.tokens, 0)
  const evTokens = tokensOf(wide, 'external-evidence')
  const memTokens = tokensOf(wide, 'memory-recall')
  const rollupTokens = tokensOf(wide, 'rolling-summary')

  check(
    'P1 · 宽预算正控：同轮里记忆、外部证据、摘要**三者都真的入模**，且没有任何 section 被裁',
    wide.sectionIds.includes('memory-recall') &&
      wide.sectionIds.includes('external-evidence') &&
      wide.sectionIds.includes('rolling-summary') &&
      wide.sectionIds.includes('identity-core') &&
      wide.dropped.length === 0 &&
      wide.rollupItems >= 1 &&
      wide.rollupSurvived === 1 &&
      wide.memory.selected >= 1 &&
      wide.memory.reachedContext &&
      wide.evidence.bundleAttached >= 1 &&
      wide.evidence.selected >= 1 &&
      wide.evidence.contextBudgetDropped === 0,
    `sections=${JSON.stringify(wide.sectionIds)} dropped=${JSON.stringify(wide.dropped)} · 摘要 选中=${wide.rollupItems}/入模=${wide.rollupSurvived} · 记忆 选中=${wide.memory.selected}/入模=${String(wide.memory.reachedContext)} · 证据 选中=${wide.evidence.selected}/附=${wide.evidence.bundleAttached}/上下文裁=${wide.evidence.contextBudgetDropped}`
  )
  check(
    'P1b · 量具自检（`measured_count > 0`）：不可裁之和与三格额度都**实测** > 0，且 packet 与 trace 记的 token 数逐字一致 —— 后面的紧预算才是有意义的比较',
    base > 0 &&
      evTokens > 0 &&
      memTokens > 0 &&
      rollupTokens > 0 &&
      wide.estimatedTokens === wide.traceEstimatedTokens &&
      wide.memory.budgetTokens === DEFAULT_CONTEXT_BUDGET.memoryTokens,
    `不可裁=${base} · 证据=${evTokens} · 记忆=${memTokens} · 摘要=${rollupTokens} · packet=${wide.estimatedTokens}=trace=${wide.traceEstimatedTokens} · 记忆额度=${wide.memory.budgetTokens}`
  )
  check(
    'P1c · 优先级顺序（packet 顺序 = 优先级顺序）：摘要排在**最后**（可裁、最低优先级），记忆与证据都在它前面',
    wide.sectionIds.indexOf('rolling-summary') === wide.sectionIds.length - 1 &&
      wide.sectionIds.indexOf('external-evidence') < wide.sectionIds.indexOf('rolling-summary') &&
      wide.sectionIds.indexOf('memory-recall') < wide.sectionIds.indexOf('rolling-summary'),
    `order=${JSON.stringify(wide.sectionIds)}`
  )

  /*
   * 所有紧预算都从**实测**值算出来，不手抄常数：
   *   · 不可裁之和 = base，永远保留（可能超预算）
   *   · 可裁按优先级依次装：证据 → 记忆 → 摘要
   * 于是"预算落在哪一段"就能**决定性地**选择谁被裁。
   */
  const budgetRollupDropped = base + evTokens + memTokens + 30
  const budgetAllDroppableDropped = base + 10
  const budgetOverNonDroppable = Math.max(1, base - 500)
  const roomForAll = base + evTokens + memTokens + rollupTokens

  check(
    'P2 · 用例可成立性（红了 = 用例在数学上不可能，视为 MEASUREMENT INVALID）：摘要必须比"记忆+证据"的余量更大，才能造出"只有摘要被裁"那一档',
    evTokens > 0 &&
      memTokens > 0 &&
      rollupTokens > 30 &&
      budgetRollupDropped > base + evTokens + memTokens &&
      budgetRollupDropped < roomForAll,
    `预算=${budgetRollupDropped} · 装下记忆+证据需 ${base + evTokens + memTokens} · 装下全部需 ${roomForAll}`
  )
  const tight1 = await s.say(ask, '（她如实回答）', {
    search: 'on',
    rollupTokens: 400,
    tokenBudget: budgetRollupDropped,
  })
  check(
    'P2a · 竞争（实测）：摘要被裁而**记忆与证据入模**，四条不可裁全在，且只裁了一条',
    tight1.dropped.includes('rolling-summary') &&
      tight1.sectionIds.includes('memory-recall') &&
      tight1.sectionIds.includes('external-evidence') &&
      tight1.sectionIds.includes('identity-core') &&
      tight1.sectionIds.includes('integrity-rules') &&
      tight1.sectionIds.includes('current-input') &&
      tight1.dropped.length === 1,
    `sections=${JSON.stringify(tight1.sectionIds)} dropped=${JSON.stringify(tight1.dropped)}`
  )
  check(
    'P2b · 竞争（实测）：`rollup_items ≥ 1`（**被选中**）而 `rollup_section_survived = 0`（**没入模**）—— 两个读数不相等，正是计划书 §3.2 要求的那条区分',
    tight1.rollupItems >= 1 && tight1.rollupSurvived === 0,
    `rollup_items=${tight1.rollupItems} · rollup_section_survived=${tight1.rollupSurvived} · dropped=${JSON.stringify(tight1.dropped)}`
  )

  const tight2 = await s.say(ask, '（她如实回答）', {
    search: 'on',
    rollupTokens: 400,
    tokenBudget: budgetAllDroppableDropped,
  })
  check(
    'P3 · 更紧（仍有 10 token 余量）：**三个可裁 section 全被裁**、四条不可裁全留；证据的"附了但没进"与记忆的"本可入模但被上下文丢掉"各有**独立读数**；此时 packet 仍然 `used <= budget`（这一档**没有**超限，别把超限混进来）',
    tight2.dropped.includes('rolling-summary') &&
      tight2.dropped.includes('external-evidence') &&
      tight2.dropped.includes('memory-recall') &&
      tight2.sections.every((x) => !x.droppable) &&
      tight2.estimatedTokens === base &&
      tight2.estimatedTokens <= budgetAllDroppableDropped &&
      tight2.evidence.bundleAttached >= 1 &&
      tight2.evidence.selected === 0 &&
      tight2.evidence.contextBudgetDropped >= 1 &&
      tight2.memory.intendedSelected >= 1 &&
      tight2.memory.selected === 0 &&
      tight2.memory.droppedByContextBudget,
    `dropped=${JSON.stringify(tight2.dropped)} · 不可裁=${base} · packet=${tight2.estimatedTokens} ≤ 预算=${budgetAllDroppableDropped} · 证据 附=${tight2.evidence.bundleAttached}/选中=${tight2.evidence.selected}/上下文裁=${tight2.evidence.contextBudgetDropped} · 记忆 本可入模=${tight2.memory.intendedSelected}/选中=${tight2.memory.selected}/上下文丢=${String(tight2.memory.droppedByContextBudget)}`
  )
  /*
   * 这一档才是**不可裁超限**：预算比不可裁之和还小（`§3.2 L173` 说的正是这一档）。
   * 期望：不可裁**一条不落**全留（可能超）、可裁全掉、且读数**如实**说 `estimatedTokens > tokenBudget`
   * —— 不伪报 fits。
   */
  const overflow = await s.say(ask, '（她如实回答）', {
    search: 'on',
    rollupTokens: 400,
    tokenBudget: budgetOverNonDroppable,
  })
  check(
    'P4 · 不可裁超限：预算 = 不可裁 − 500 ⇒ 不可裁**一条不落**全留、可裁全掉，且 packet **如实报** `estimatedTokens > tokenBudget`（不伪报 fits）；trace 与 packet 记的是同一个数',
    budgetOverNonDroppable < base &&
      overflow.dropped.length === 3 &&
      overflow.sections.length > 0 &&
      overflow.sections.every((x) => !x.droppable) &&
      overflow.estimatedTokens === base &&
      overflow.estimatedTokens > budgetOverNonDroppable &&
      overflow.estimatedTokens === overflow.traceEstimatedTokens,
    `不可裁=${base} · packet=${overflow.estimatedTokens} > 预算=${budgetOverNonDroppable} · trace=${overflow.traceEstimatedTokens} · dropped=${JSON.stringify(overflow.dropped)}`
  )

  /*
   * 负控：把**证据额度**设成 0。此时"没进去"的原因是"压根没附 bundle"，
   * 与上面"附了但被上下文裁掉"是**两个不同的读数** —— 量具自证（`AGENTS.md` §6.2）。
   */
  const zeroBudget = await s.say(ask, '（她如实回答）', {
    search: 'on',
    rollupTokens: 400,
    evidenceTokens: 0,
  })
  check(
    'P5 · 量具自证：额度 0 ⇒ `bundle_attached_count = 0` 且 `context_budget_dropped_count = 0`；被上下文裁掉那一档是 `bundle_attached ≥ 1` 且 `context_budget_dropped ≥ 1` —— 两个原因**读数不同**，不会被混成一个',
    zeroBudget.evidence.bundleAttached === 0 &&
      zeroBudget.evidence.selected === 0 &&
      zeroBudget.evidence.contextBudgetDropped === 0 &&
      !zeroBudget.sectionIds.includes('external-evidence') &&
      tight2.evidence.bundleAttached >= 1 &&
      tight2.evidence.contextBudgetDropped >= 1,
    `额度0：附=${zeroBudget.evidence.bundleAttached}/选中=${zeroBudget.evidence.selected}/上下文裁=${zeroBudget.evidence.contextBudgetDropped} · 上下文裁那档：附=${tight2.evidence.bundleAttached}/上下文裁=${tight2.evidence.contextBudgetDropped}`
  )

  const actionId = await s.lastActionId()
  reviewCase(
    'P-宽预算（三者入模）',
    wide,
    {
      sections: wide.sectionIds.join(','),
      dropped: wide.dropped.join(',') || '(无)',
      rollupItems: wide.rollupItems,
      rollupSurvived: wide.rollupSurvived,
      memorySelected: wide.memory.selected,
      evidenceSelected: wide.evidence.selected,
    },
    ['ALL_IN_CONTEXT'],
    actionId ?? undefined
  )
  reviewCase(
    'P-紧预算（只有摘要被裁）',
    tight1,
    {
      sections: tight1.sectionIds.join(','),
      dropped: tight1.dropped.join(','),
      rollupItems: tight1.rollupItems,
      rollupSurvived: tight1.rollupSurvived,
    },
    ['SELECTED_NOT_IN_CONTEXT'],
    undefined
  )
  reviewCase(
    'P-更紧（可裁全裁）',
    tight2,
    {
      sections: tight2.sectionIds.join(','),
      dropped: tight2.dropped.join(','),
      estimatedTokens: tight2.estimatedTokens,
      budget: budgetAllDroppableDropped,
      evidenceBundleAttached: tight2.evidence.bundleAttached,
      evidenceSelected: tight2.evidence.selected,
      memoryIntended: tight2.memory.intendedSelected,
      memorySelected: tight2.memory.selected,
    },
    ['NON_DROPPABLE_OVER_BUDGET', 'HONEST_OVERFLOW'],
    undefined
  )
  await s.dispose()
}

// ===========================================================================
// R 本地评审包（gitignored）与隐私边界
// ===========================================================================

report.section('R 本地评审包：正文只进 gitignored 的评审包，不进提交的机器证据')
const reviewPacket = {
  schemaVersion: 'm6-review-packet@1',
  runId,
  codeCommit: head,
  generatedAt: new Date().toISOString(),
  note:
    '本地人工评审用：含**对话正文**。它落在 gitignored 的 `artifacts/m6/local/`，' +
    '不随机器证据提交；提交的 `e2e.json` 只有计数、id 与理由码。',
  cases: reviewCases,
}
const reviewPacketText = `${JSON.stringify(reviewPacket, null, 2)}\n`
writeFileSync(reviewPath, reviewPacketText)

check(
  'R1 · 评审包落在 **gitignored** 目录：`git check-ignore` 退出码 0 —— 正文不会随证据提交',
  spawnSync('git', ['check-ignore', '-q', relative(ROOT, reviewPath)], { cwd: ROOT }).status === 0,
  `path=${relative(ROOT, reviewPath).split(/[\\/]/).join('/')}`
)
check(
  'R2 · 评审包**确实**含正文哨兵（正控：否则"别处没有"是空过）',
  reviewPacketText.includes(SENTINEL_TAG) && reviewCases.length >= 5,
  `cases=${reviewCases.length} · 含哨兵=${String(reviewPacketText.includes(SENTINEL_TAG))}`
)
check(
  'R3 · 隐私边界（负控）：**trace** 里没有正文哨兵 —— 她的原话不会被写进遥测属性',
  !sentinelWitnessTrace.includes(SENTINEL_TAG) && sentinelWitnessTrace.length > 0,
  `traceBytes=${sentinelWitnessTrace.length} · 含哨兵=${String(sentinelWitnessTrace.includes(SENTINEL_TAG))}`
)
check(
  'R4 · 每例都关联 `runId` / `traceId` / `eventId`（有副作用的另带 actionId）—— 计划书 §WP7 的关联要求在评审包里逐条成立',
  reviewCases.every(
    (c) =>
      c.runId === runId &&
      c.codeCommit === head &&
      c.traceId.startsWith('trc:') &&
      c.eventId.length > 0
  ) && reviewCases.some((c) => (c.actionId ?? '').length > 0),
  `cases=${reviewCases.length} · 带 actionId=${reviewCases.filter((c) => c.actionId !== undefined).length}`
)

// ---------------------------------------------------------------------------
// 子门：别人的命题（本门只登记映射与退出码）
// ---------------------------------------------------------------------------

report.section('额外覆盖：由各自的门承载（本门只登记映射与退出码）')
const childSpecs: { id: string; cmd: string; covers: string }[] = [
  {
    id: 'm5-budget',
    cmd: 'pnpm exec tsx scripts/verify-m5-budget.ts',
    covers: '额度合法性的**部件级**判据（负数/非整数/超过 total ⇒ 装配期失败关闭）',
  },
  {
    id: 'm6-wp3-wiring',
    cmd: 'pnpm exec tsx scripts/verify-m6-wp3-wiring.ts',
    covers: '摘要接线的负控（读取面抛错 ⇒ 不注入）与"只占一个可裁 section"',
  },
  {
    id: 'm5.1-measurement',
    cmd: 'pnpm exec tsx scripts/verify-m5.1-measurement.ts',
    covers: '量具资格化（正控／负控／恢复三段式）—— §5 对新判据的强制要求',
  },
  {
    id: 'm5.5:e2e:verify',
    cmd: 'pnpm m5.5:e2e:verify',
    /*
     * 本门给共享 harness（`scripts/m5.5-harness.ts`）加了一个**可选**的 `clockEpochMs`
     * 透传。这一条子门证明那次改动对 M5.5 那条链路是**惰性**的（不传 = 行为逐字不变）。
     */
    covers: '共享 harness 的改动对 M5.5 链路惰性（同一套 `say` 路径没被改坏）',
  },
]
interface ChildReading {
  id: string
  command: string
  covers: string
  exitCode: number | null
  seconds: number
  status: string
}
const childReadings: ChildReading[] = []
for (const spec of childSpecs) {
  const startedAt = Date.now()
  const child = spawnSync(spec.cmd, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: true,
    timeout: 3_600_000,
    env: process.env,
  })
  const seconds = Math.round((Date.now() - startedAt) / 1000)
  const exitCode = child.status ?? -1
  const status = child.error !== undefined ? 'SPAWN FAILED' : exitCode === 0 ? 'PASS' : 'FAIL'
  childReadings.push({ id: spec.id, command: spec.cmd, covers: spec.covers, exitCode, seconds, status })
  console.log(`   ${status === 'PASS' ? '✅' : '❌'} ${spec.id.padEnd(20)} exit=${exitCode} (${seconds}s)`)
}
for (const reading of childReadings) {
  check(
    `X-${reading.id} · 额外覆盖 \`${reading.command}\` EXIT 0 —— ${reading.covers}`,
    reading.status === 'PASS',
    `exit=${String(reading.exitCode)} (${reading.seconds}s)`
  )
}

// ---------------------------------------------------------------------------
// 真实库安全 + 证据
// ---------------------------------------------------------------------------

const realAfter = digestTree(REAL_DB)
const drift = measureRealDbDrift(realBefore, realAfter)
check(
  'Z1 · 真实 `data/pglite` 在本门运行前后**逐字不变**（本门全部跑在合成隔离库上）',
  drift.unchangedDuringRun && realAfter.measuredCount > 0 && (drift.matchesWp0Baseline || drift.driftExplained),
  `measured=${realAfter.measuredCount} · ${drift.reading}`
)

await disposeLive()

/**
 * 证据写入的**唯一**出口，而且它是**失败关闭**的（不是"检查一下就完事"）：
 *   · 文本里出现正文哨兵 ⇒ 抛（隐私不变量，机器强制）
 *   · 落盘后逐字复核 ⇒ 不一致就抛（"判据对着盘上的文件"，不是对着内存里的对象）
 *   · schemaVersion 与评审包 cases 数不符 ⇒ 抛
 * 返回**实际落盘的那份文本**（调用方用它打印字节数，并让"屏幕读数 = 文件读数"）。
 * `AGENTS.md` §6.4：红了也要留证据 ⇒ 这个出口在所有计数型判据之后调用一次。
 */
const writeArtifact = (payload: Record<string, unknown>): string => {
  const text = `${JSON.stringify(payload, null, 2)}\n`
  if (text.includes(SENTINEL_TAG)) {
    throw new Error('隐私边界被破坏：机器证据里出现了对话正文哨兵')
  }
  writeFileSync(artifactPath, text, 'utf8')
  const onDisk = readFileSync(artifactPath, 'utf8')
  if (onDisk !== text) throw new Error('落盘复核失败：盘上的内容与受检文本不一致')
  if (onDisk.includes(SENTINEL_TAG)) throw new Error('落盘复核失败：盘上的证据含正文哨兵')
  const parsed = JSON.parse(onDisk) as {
    schemaVersion?: unknown
    localReviewPacket?: { cases?: unknown }
  }
  if (parsed.schemaVersion !== 'm6-wp7b-e2e@1') {
    throw new Error(`落盘复核失败：schemaVersion=${String(parsed.schemaVersion)}`)
  }
  if (parsed.localReviewPacket?.cases !== reviewCases.length) {
    throw new Error('落盘复核失败：评审包 cases 数与证据记的不一致')
  }
  return onDisk
}

const buildPayload = (): Record<string, unknown> => ({
  schemaVersion: 'm6-wp7b-e2e@1',
  runId,
  generatedAt: new Date().toISOString(),
  head,
  verdict: report.failed === 0 ? 'PASS' : 'FAIL',
  /*
   * ⚠️ 顶层 `passed` / `failed` / `measurementInvalid` 是 `readLandedEvidence` 的读法
   * （`m6-evidence.ts`）。只放在嵌套对象里 ⇒ 汇总读到 0 ⇒ 假红 `rollup_no_positive_example`。
   */
  passed: report.passed,
  failed: report.failed,
  measurementInvalid: 0,
  wp: 'M6 WP7b — 跨午夜／时区／三个时间通道 + 同轮预算竞争 + 本地评审包',
  clock: {
    timeZone: CLOCK_TIME_ZONE,
    crossMidnight: { before: CLOCK_E1, after: CLOCK_E2, deltaMs: CLOCK_E2 - CLOCK_E1 },
    timezoneShiftWitness: CLOCK_E3,
  },
  childGates: childReadings,
  itemCoverage: {
    '额度合法性的部件级判据（负数/非整数/超过 total）': 'verify-m5-budget.ts（子门）',
    '摘要接线的负控（读取面抛错 ⇒ 不注入）': 'verify-m6-wp3-wiring.ts（子门）',
    '量具资格化三段式': 'verify-m5.1-measurement.ts（子门）',
    '共享 harness 改动对 M5.5 链路惰性': '`m5.5:e2e:verify`（子门）',
    '唯一 prompt 入口 / 没有第二份摘要拼接': '`m6:wp3-wiring` 的静态锁',
    'A–E 剧情与摘要/召回跨模块': 'WP7a（`wp7a-e2e`）',
    '1k→10k 规模与检索上界': 'WP8（尚未执行）',
    '长对话 50/100/500 轮': 'WP9a/WP9b（尚未执行）',
  },
  localReviewPacket: {
    path: relative(ROOT, reviewPath).split(/[\\/]/).join('/'),
    gitignored: true,
    cases: reviewCases.length,
    note: '评审包含对话正文，落在 gitignored 目录；本文件（机器证据）不含正文。',
  },
  realDb: {
    before: drift.before.treeSha256,
    after: drift.after.treeSha256,
    unchangedDuringThisRun: drift.unchangedDuringRun,
    driftExplained: drift.driftExplained,
  },
  checks: { passed: report.passed, failed: report.failed, failures: report.failures },
  totals: { checks: report.passed + report.failed, passed: report.passed, failed: report.failed },
  artifactIntegrity:
    '写证据只有一个出口 `writeArtifact`：含正文哨兵即抛、落盘后逐字复核、schemaVersion 与评审包 cases 数不符即抛；' +
    '本文件的 `passed/failed` 就是屏幕上的那组数（同一次调用算出来的）。',
  didNotOpenRealDatabase: true,
})

// ① 隐私负控：**要提交的那份文本**里没有哨兵；评审包里有；trace 里没有
const payloadText = JSON.stringify(buildPayload(), null, 2)
check(
  'R5 · 隐私边界（负控）：机器证据（要提交的那份）里**没有**正文哨兵 —— 提交的是计数与 id，不是对话',
  !payloadText.includes(SENTINEL_TAG) &&
    reviewPacketText.includes(SENTINEL_TAG) &&
    !sentinelWitnessTrace.includes(SENTINEL_TAG),
  `证据字节=${payloadText.length} 含哨兵=${String(payloadText.includes(SENTINEL_TAG))} · 评审包含哨兵=${String(reviewPacketText.includes(SENTINEL_TAG))}`
)
// ② 收尾唯一一次写入：**计数已经包含全部判据**（`passed` 与屏幕上的"N 通过"必然相等）
const shipped = writeArtifact(buildPayload())
console.log(
  `\nM6 WP7b 门：${report.passed} 通过 / ${report.failed} 失败` +
    (report.failures.length > 0 ? `\n失败项：${report.failures.join(' | ')}` : '')
)
console.log(`证据：${relative(ROOT, artifactPath).split(/[\\/]/).join('/')}（${shipped.length} 字节，已逐字复核）`)
console.log(`评审包（gitignored）：${relative(ROOT, reviewPath).split(/[\\/]/).join('/')}`)
process.exitCode = report.failed === 0 ? 0 : 1
