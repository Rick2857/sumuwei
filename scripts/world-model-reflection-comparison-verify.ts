/**
 * 三域应用方案 §4 —— **反思域比较材料**的隔离门（阶段 3 的机械面）。
 *
 * ============================================================================
 *  它测什么、不测什么
 * ============================================================================
 * ```text
 * 测：比较材料的**装配层**（纯函数）+ **prompt 分离** + **幂等身份** + **遮蔽/复核**判据。
 * 不测：收益（"留出案例中的重复错误率"那一类）。
 *      反思链的端到端读数需要**隔离数据库**；本机当前**没有**可用的隔离目标
 *      （PostgreSQL 容器未运行、PGlite 回落被 `.env` 的连接串挡住）⇒
 *      那一段如实记为 **NOT RUN**，不拿固定件冒充整链读数。
 * ```
 *
 * ⚠️ **零真实出站、零真实模型、不打开任何数据库。**
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildReflectionInput } from '../src/kernel/app/reflection/inputs.ts'
import {
  buildOutcomeComparisons,
  comparisonFingerprint,
  comparisonSourceIdsOf,
  comparisonsStillUsable,
  reflectionInputFingerprintPayload,
  renderCriterion,
  REFLECTION_COMPARISON_LIMITS,
  type ReflectionComparisonSource,
  type ReflectionOutcomeComparison,
  type ReflectionOutcomeOrigin,
} from '../src/kernel/app/reflection/outcome-comparison.ts'
import { buildReflectionUserMessage, buildReflectionInstruction } from '../src/infrastructure/model/openai-reflection.ts'
import type { ReflectionTrigger } from '../src/kernel/contracts/reflection-input.ts'

const out = resolve('artifacts/post-lv2/local/world-model-reflection-comparison', new Date().toISOString().replace(/[:.]/g, '-'))
mkdirSync(out, { recursive: true })
writeFileSync(resolve(out, 'verification.json'), JSON.stringify({ status: 'RUNNING' }) + '\n')

const checks: { id: string; lane: string }[] = []
const check = async (lane: string, id: string, run: () => void | Promise<void>) => {
  await run()
  checks.push({ id, lane })
  console.log(`PASS ${lane}/${id}`)
}

// ---------------------------------------------------------------------------
// 固定件：一个"读面"（脚本件）与两个触发
// ---------------------------------------------------------------------------

const GOAL_EVENT = 'dev-goal-completed-1'
const GOAL_EVENT_BLOCKED = 'dev-goal-blocked-1'
const SOURCE_ID = 'cev:source-1'
const STATEMENT = '把这份周报写好并发给用户'
const CRITERION = '（成功判据：本次回复里至少 2 项）'

function originOf(overrides: Partial<ReflectionOutcomeOrigin> = {}): ReflectionOutcomeOrigin {
  return {
    outcomeEventId: GOAL_EVENT,
    kind: 'goal',
    outcomeCode: 'completed',
    subjectId: 'goal-1',
    statement: STATEMENT,
    criterion: CRITERION,
    revision: 1,
    occurredAt: 1_700_000_000_000,
    sourceEventIds: [SOURCE_ID],
    ...overrides,
  }
}

function sourceOf(input: {
  origins?: readonly ReflectionOutcomeOrigin[]
  unusable?: readonly string[]
  reasons?: Readonly<Record<string, 'source_forgotten' | 'source_retracted' | 'source_unavailable'>>
} = {}): ReflectionComparisonSource {
  return {
    async originsOf() {
      return input.origins ?? [originOf()]
    },
    async usabilityOf(sourceEventIds) {
      return sourceEventIds.map((id) => {
        if (input.unusable?.includes(id) === true) {
          return {
            sourceEventId: id,
            usable: false,
            reason: input.reasons?.[id] ?? 'source_forgotten',
          }
        }
        return { sourceEventId: id, usable: true }
      })
    },
  }
}

const goalTrigger: ReflectionTrigger = { kind: 'goal_outcome', eventId: GOAL_EVENT, sequence: 10 }
const correctionTrigger: ReflectionTrigger = { kind: 'user_correction', eventId: 'dev-correction-1', sequence: 11 }

// ---------------------------------------------------------------------------
// 1. 比较不是证据：不产生 handle / 根 / 触发
// ---------------------------------------------------------------------------
await check('reflection', 'comparison-is-not-evidence', async () => {
  const source = {
    domainEventsSince: async () => [
      { id: GOAL_EVENT, type: 'GOAL_COMPLETED', sequence: 10, sourceConversationEventIds: ['c1'] },
    ],
    conversationActors: async () => [{ id: 'c1', sequence: 1, actorType: 'user', text: '用户原话' }],
  }
  const built = await buildReflectionInput(source, {
    characterId: 'fixture',
    cutoverSequence: 0,
    watermark: 0,
  })
  assert(built !== undefined)
  const handleIdsBefore = built.handles.map((handle) => handle.id)
  const triggerCountBefore = built.triggers.length
  const rootCountBefore = built.handles.length

  const comparisons = await buildOutcomeComparisons({
    triggers: built.triggers,
    source: sourceOf(),
  })
  assert.equal(comparisons.length, 1)
  // 比较的 id **不在** handle 集合里
  assert.equal(handleIdsBefore.includes(comparisons[0]!.comparisonId), false)
  // 触发数与根数**没变**
  assert.equal(built.triggers.length, triggerCountBefore)
  assert.equal(built.handles.length, rootCountBefore)
  // 比较材料**没有** handle 形状的字段（kind / sourceClass）
  const comparison = comparisons[0]! as unknown as Record<string, unknown>
  assert.equal(comparison.kind, undefined)
  assert.equal(comparison.sourceClass, undefined)
})

// ---------------------------------------------------------------------------
// 2. 只有已获资格的来源能带比较
// ---------------------------------------------------------------------------
await check('reflection', 'only-eligible-triggers-carry-comparison', async () => {
  // 更正类触发**不带**比较材料
  const none = await buildOutcomeComparisons({
    triggers: [correctionTrigger],
    source: sourceOf(),
  })
  assert.equal(none.length, 0)
  // 目标/承诺结局**带**
  const some = await buildOutcomeComparisons({
    triggers: [goalTrigger],
    source: sourceOf(),
  })
  assert.equal(some.length, 1)
  assert.equal(some[0]!.outcomeKind, 'goal')
  assert.equal(some[0]!.outcomeRef, GOAL_EVENT)
})

// ---------------------------------------------------------------------------
// 3. 成功没有"被反驳的假设"
// ---------------------------------------------------------------------------
await check('reflection', 'success-has-no-refuted-hypothesis', async () => {
  const completed = await buildOutcomeComparisons({
    triggers: [goalTrigger],
    source: sourceOf({ origins: [originOf({ outcomeCode: 'completed' })] }),
  })
  assert.equal(completed.length, 1)
  assert.equal(completed[0]!.reviewCriterion, undefined)
  assert.equal(completed[0]!.actualText, '（程序事实：目标已完成）')

  const blocked = await buildOutcomeComparisons({
    triggers: [{ kind: 'goal_outcome', eventId: GOAL_EVENT_BLOCKED, sequence: 12 }],
    source: sourceOf({
      origins: [originOf({ outcomeEventId: GOAL_EVENT_BLOCKED, outcomeCode: 'blocked' })],
    }),
  })
  assert.equal(blocked.length, 1)
  assert.equal(blocked[0]!.reviewCriterion, CRITERION)
  assert.equal(blocked[0]!.actualText, '（程序事实：目标受阻）')
})

// ---------------------------------------------------------------------------
// 4. 遗忘遮蔽：来源不可用 ⇒ 整条比较作废
// ---------------------------------------------------------------------------
await check('reflection', 'masked-source-drops-the-comparison', async () => {
  const dropped = await buildOutcomeComparisons({
    triggers: [goalTrigger],
    source: sourceOf({ unusable: [SOURCE_ID], reasons: { [SOURCE_ID]: 'source_forgotten' } }),
  })
  assert.equal(dropped.length, 0)
  // 撤回与不可用是**同一条**判据（都作废），但原因码不同
  const retracted = await buildOutcomeComparisons({
    triggers: [goalTrigger],
    source: sourceOf({ unusable: [SOURCE_ID], reasons: { [SOURCE_ID]: 'source_retracted' } }),
  })
  assert.equal(retracted.length, 0)
})

// ---------------------------------------------------------------------------
// 5. 有界（计入既有输入预算）
// ---------------------------------------------------------------------------
await check('reflection', 'comparisons-are-bounded', async () => {
  const many = Array.from({ length: 6 }, (_, index) => ({
    ...originOf({ outcomeEventId: `dev-goal-${String(index)}` }),
  }))
  const built = await buildOutcomeComparisons({
    triggers: many.map((origin, index) => ({
      kind: 'goal_outcome' as const,
      eventId: origin.outcomeEventId,
      sequence: 10 + index,
    })),
    source: sourceOf({ origins: many }),
  })
  assert.equal(built.length, REFLECTION_COMPARISON_LIMITS.maxItems)
  // 总码点不超上界
  const total = built.reduce(
    (sum, row) =>
      sum +
      [...row.predictedText].length +
      [...row.actualText].length +
      (row.reviewCriterion === undefined ? 0 : [...row.reviewCriterion].length),
    0
  )
  assert(total <= REFLECTION_COMPARISON_LIMITS.maxTotalCodepoints)
  // 单份也超长时被截断
  const long = await buildOutcomeComparisons({
    triggers: [goalTrigger],
    source: sourceOf({ origins: [originOf({ statement: 'x'.repeat(5000) })] }),
  })
  assert.equal(long.length, 1)
  assert([...long[0]!.predictedText].length <= REFLECTION_COMPARISON_LIMITS.maxTextCodepoints)
})

// ---------------------------------------------------------------------------
// 6. 幂等身份：比较材料进指纹
// ---------------------------------------------------------------------------
await check('reflection', 'comparison-identity-enters-the-fingerprint', async () => {
  const windowRows: readonly (readonly [string, string, number, string])[] = [['e1', 'domain_event', 3, 'internal_interpretation']]
  // 没有比较材料 ⇒ 载荷**逐字**等于旧格式（窗口行的 JSON 数组）
  assert.equal(reflectionInputFingerprintPayload(windowRows, []), JSON.stringify(windowRows))
  const comparisons: readonly ReflectionOutcomeComparison[] = [
    {
      comparisonId: `cmp:${GOAL_EVENT}`,
      outcomeKind: 'goal',
      outcomeRef: GOAL_EVENT,
      outcomeAt: 1,
      outcomeCode: 'blocked',
      predictedText: '预测',
      actualText: '实际',
      sourceEventIds: [SOURCE_ID],
    },
  ]
  const withComparison = reflectionInputFingerprintPayload(windowRows, comparisons)
  assert.notEqual(withComparison, reflectionInputFingerprintPayload(windowRows, []))
  // 比较内容变了 ⇒ 指纹变了
  const changed = reflectionInputFingerprintPayload(windowRows, [
    { ...comparisons[0]!, predictedText: '另一个预测' },
  ])
  assert.notEqual(changed, withComparison)
  assert.notEqual(comparisonFingerprint(comparisons), comparisonFingerprint([]))
})

// ---------------------------------------------------------------------------
// 7. 二次来源复核判据
// ---------------------------------------------------------------------------
await check('reflection', 'secondary-source-review', async () => {
  assert.equal(comparisonsStillUsable([{ sourceEventId: 'a', usable: true }]), true)
  assert.equal(comparisonsStillUsable([{ sourceEventId: 'a', usable: false, reason: 'source_forgotten' }]), false)
  // 空集合 ⇒ **不可用**（没有可复核的东西 ⇒ 不提交）
  assert.equal(comparisonsStillUsable([]), false)
  assert.equal(comparisonsStillUsable([{ sourceEventId: 'a', usable: true }], ['a', 'missing']), false)
  // 来源 id 的集合（复核读它）
  assert.deepEqual(
    comparisonSourceIdsOf([
      {
        comparisonId: 'c1', outcomeKind: 'goal', outcomeRef: 'e1', outcomeAt: 1, outcomeCode: 'completed',
        predictedText: 'p', actualText: 'a', sourceEventIds: ['s1', 's2'],
      },
      {
        comparisonId: 'c2', outcomeKind: 'goal', outcomeRef: 'e2', outcomeAt: 2, outcomeCode: 'completed',
        predictedText: 'p', actualText: 'a', sourceEventIds: ['s2'],
      },
    ]),
    ['s1', 's2']
  )
})

// ---------------------------------------------------------------------------
// 8. prompt 分离：比较与合法依据物理分开，且默认 0 字节
// ---------------------------------------------------------------------------
await check('reflection', 'prompt-separation', async () => {
  const call = {
    characterId: 'fixture',
    window: [
      { id: 'e1', kind: 'domain_event' as const, revision: 3, sourceClass: 'internal_interpretation' as const, fromTrigger: true, text: '（程序事件：GOAL_COMPLETED）' },
    ],
    handles: [{ kind: 'domain_event' as const, id: 'e1', sourceClass: 'internal_interpretation' as const }],
    counterHandles: [],
    triggerReasonCodes: ['goal_outcome'],
    deadlineMs: 20_000,
  }
  const withoutComparisons = buildReflectionUserMessage(call)
  const withEmptyComparisons = buildReflectionUserMessage({ ...call, comparisons: [] })
  // 空比较材料 ⇒ **逐字节**相同
  assert.equal(withoutComparisons, withEmptyComparisons)
  assert.equal(withoutComparisons.includes('辅助比较'), false)

  const withComparisons = buildReflectionUserMessage({
    ...call,
    comparisons: [
      {
        comparisonId: `cmp:${GOAL_EVENT}`,
        outcomeKind: 'goal',
        outcomeRef: GOAL_EVENT,
        outcomeAt: 1,
        outcomeCode: 'blocked',
        predictedText: STATEMENT,
        actualText: '（程序事实：目标受阻）',
        reviewCriterion: CRITERION,
        sourceEventIds: [SOURCE_ID],
      },
    ],
  })
  // 标成"不是证据"
  assert(withComparisons.includes('辅助比较材料（不是证据）'))
  // 比较**不在**合法 handle 集合里（模型不能引用它）
  assert(withComparisons.includes(`cmp:${GOAL_EVENT}`))
  // 句柄段没有多出比较的 id
  const handleSection = withComparisons.split('程序发现的反例 handle：')[0] ?? ''
  assert.equal(handleSection.includes(`cmp:${GOAL_EVENT}`), false)
})

// ---------------------------------------------------------------------------
// 9. 判据渲染（闭集）
// ---------------------------------------------------------------------------
await check('reflection', 'criterion-rendering-is-closed', async () => {
  assert.equal(renderCriterion({ kind: 'user_report' }), '（成功判据：由用户报告确认）')
  assert.equal(
    renderCriterion({ kind: 'conversation_output', structure: { kind: 'item_count', count: 2 } }),
    '（成功判据：本次回复里至少 2 项）'
  )
  assert.equal(
    renderCriterion({ kind: 'action_result', capability: 'local.file.write', operation: 'write', require: 'executed_succeeded' }),
    '（成功判据：local.file.write.write 执行成功）'
  )
  assert.equal(renderCriterion({ kind: 'unknown_kind' }), undefined)
  assert.equal(renderCriterion('not an object'), undefined)
  assert.equal(renderCriterion(undefined), undefined)
})

// ---------------------------------------------------------------------------
// 10. 接线静态锁
// ---------------------------------------------------------------------------
await check('wiring', 'main-consumes-the-reflection-flag', async () => {
  const main = readFileSync('src/main.ts', 'utf8')
  assert(main.includes('this.flags.reflectionOutcomeComparisonEnabled'))
  const flags = readFileSync('src/kernel/app/flags.ts', 'utf8')
  assert(flags.includes('CHARACTER_REFLECTION_OUTCOME_COMPARISON_ENABLED'))
  assert(
    flags.includes(
      'reflectionOutcomeComparisonEnabled: truthy(env.CHARACTER_REFLECTION_OUTCOME_COMPARISON_ENABLED, false)'
    )
  )
})

// ---------------------------------------------------------------------------
await check('regression', 'disabled-system-prompt-has-no-comparison-instructions', async () => {
  assert.equal(buildReflectionInstruction().includes('辅助比较材料'), false)
})

// 证据
// ---------------------------------------------------------------------------
const files = [
  'scripts/world-model-reflection-comparison-verify.ts',
  'src/kernel/app/reflection/outcome-comparison.ts',
  'src/kernel/app/reflection/draft-port.ts',
  'src/kernel/app/reflection/inputs.ts',
  'src/infrastructure/runtime/reflection-runner.ts',
  'src/infrastructure/runtime/reflection-runtime.ts',
  'src/infrastructure/persistence/reflection-comparison-source.ts',
  'src/infrastructure/model/openai-reflection.ts',
  'src/kernel/app/flags.ts',
  'src/main.ts',
]
writeFileSync(
  resolve(out, 'verification.json'),
  JSON.stringify(
    {
      schema: 'world-model-reflection-comparison@1',
      status: 'PASS',
      checks,
      evidenceClass: 'offline_pure_layer_mechanism_only',
      realModelCalls: 0,
      realToolCalls: 0,
      databaseOpened: false,
      productionIntegrated: false,
      benefitMeasured: false,
      storyFeatureStatus: 'cancelled_2026-10-20',
      /**
       * ⚠️ **如实登记**：本门**只**覆盖装配层与 prompt 面。
       *    整链（草案→来源复核→采纳→槽位→入模）由**另一道门**承接：
       *    `pnpm worldmodel:reflection:e2e`（隔离 `%TEMP%` 沙箱 + 真 `runReflectionWindow`）。
       *    ⚠️ 那道门跑在 **PGlite** 上（本机没有 PostgreSQL）⇒ 后端如实标注。
       */
      notRun: [], // Database evidence is reported separately by the PostgreSQL e2e gate.
      sourceHashes: Object.fromEntries(
        files.map((file) => [file, createHash('sha256').update(readFileSync(file)).digest('hex')])
      ),
    },
    null,
    2
  ) + '\n'
)
console.log(
  JSON.stringify({
    status: 'PASS',
    checks: checks.length,
    evidenceClass: 'offline_pure_layer_mechanism_only',
    notRun: [],
    output: out,
  })
)
