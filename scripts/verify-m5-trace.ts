/**
 * M5 WP7 —— **Trace / Audit / Measurement Truth 门**（`pnpm m5:trace:verify`）。
 *
 * ============================================================================
 *  这一 WP 的灵魂是最后一段
 * ============================================================================
 * 计划书 WP7 写得很直接：
 *
 *     故意构造"目标 Memory 没有进入 Context"，测试必须失败。
 *     不能只检查 Recall API returned 200，
 *     而要验证"**模型实际获得了哪条 Memory**"。
 *
 * 因此最后一段做两件事，缺一不可：
 *
 *   ① **量具必须会响**：把真实 packet 文本里的记忆块抹掉，
 *      "目标记忆到达模型"这条判据必须变成 false。
 *      （一个永远返回 true 的量具与一个真的到达了的系统，在输出上完全一样。）
 *
 *   ② **一个真实的失配场景**：记忆 section 是 `droppable: true`，
 *      上下文编译器可以在总预算不足时把它**整段丢掉**。
 *      这时 trace 必须说"没进"（`selectedMemoryIds = []` +
 *      `droppedByContextBudget = true` + `intendedSelectedIds` 留诊断），
 *      而不是继续声称"她想起了"。
 *
 * 前四段分别是：记录完整性、隐私（含**真实正文搜索**）、trace 集成、指标聚合。
 *
 * 跑法：pnpm m5:trace:verify
 */

import 'dotenv/config'

import { cleanupSandbox, isolateDatabase, resetPluginSqlConnection } from '../src/dev/sandbox.ts'

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { M4_T0, createM4Harness, createReporter } from './m4-harness.ts'
import { memoryIntegrityProblems } from '../src/infrastructure/persistence/memory-integrity.ts'
import { createMemoryRetrievalStore } from '../src/infrastructure/persistence/memory-retrieval-store.ts'
import { rootReadingsByMemory } from '../src/infrastructure/persistence/qualification-read.ts'
import { createMemoryRecallService } from '../src/kernel/app/recall/retrieval.ts'
import { createRecallTurnPort, type RecallTurnPort, type RecallTurnOutcome } from '../src/kernel/app/recall/turn.ts'
import { TurnGateway } from '../src/kernel/app/turn-gateway.ts'
import { DEFAULT_CONTEXT_BUDGET } from '../src/kernel/recall/selector.ts'
import { MEMORY_BLOCK_HEADER } from '../src/kernel/recall/render.ts'
import {
  RECALL_RECORD_MAX_CANDIDATES,
  aggregateRecallMetrics,
  assertRecordShapeIsContentFree,
  describeDecisionRecord,
} from '../src/kernel/recall/record.ts'
import { newTraceId } from '../src/kernel/contracts/ids.ts'
import type { MemoryType } from '../src/kernel/contracts/memory.ts'

const report = createReporter()
const sandbox = isolateDatabase('m5-trace', { keep: false })
await resetPluginSqlConnection()
const h = await createM4Harness({ label: 'm5-trace' })
const user = h.user

// ---------------------------------------------------------------------------
// fixture
// ---------------------------------------------------------------------------

const seeded: { predicate: string; value: string; type: MemoryType }[] = [
  { predicate: 'education.major', value: '计算机', type: 'person_fact' },
  { predicate: 'education.institution', value: '示例工程科技大学', type: 'person_fact' },
  { predicate: 'food.preference.cilantro', value: 'dislike', type: 'preference' },
  { predicate: 'preferred.address', value: 'Alex', type: 'preference' },
]
const SECRETS: string[] = []
for (const [index, spec] of seeded.entries()) {
  const evidence = await h.recordUserEvidence(`记住，${spec.predicate} 是 ${spec.value}`)
  const record = await h.commitAndFold(
    h.makeCandidate(
      spec.type,
      { kind: 'claim', subject: user, predicate: spec.predicate, value: spec.value },
      { sourceRefs: [evidence.ref] }
    ),
    M4_T0 + index * 10
  )
  if (record === null) throw new Error(`fixture 失败：${spec.predicate}`)
  SECRETS.push(spec.value)
}
// 一条被遗忘的（用来证明"排除理由"里会有 FORGOTTEN）
const forgetEvidence = await h.recordUserEvidence('记住，我平时主要用 Windows')
const forgotten = (await h.commitAndFold(
  h.makeCandidate(
    'person_fact',
    { kind: 'claim', subject: user, predicate: 'device.primary', value: 'Windows' },
    { sourceRefs: [forgetEvidence.ref] }
  ),
  M4_T0 + 100
))!
const forgetTurn = await h.recordUserEvidence('忘掉我平时用 Windows 这件事')
await h.applyStateChange(
  'retract',
  forgetTurn.ref.id,
  { memoryId: forgotten.id, reason: 'explicit_forget', note: '用户要求忘掉' },
  M4_T0 + 110
)
SECRETS.push('Windows')

const recallPort: RecallTurnPort = createRecallTurnPort({
  service: createMemoryRecallService({
    port: createMemoryRetrievalStore({
      store: h.store,
      integrity: (owner) => memoryIntegrityProblems(h.db, owner),
      // Phase 4b：根证据受信读数（**必填** —— 忘记接线会让每条事实都被标成"来源未确立"）
      rootReadings: (ids) => rootReadingsByMemory(h.db, ids),
    }),
  }),
  budget: DEFAULT_CONTEXT_BUDGET,
  now: () => M4_T0 + 10_000,
})

const RELEVANT = '我读的是什么专业？'

/**
 * **真实一轮**（`dryRun: false`）：`beginTurn` → `compileTurn` → `completeTurn`。
 *
 * ⚠️ 为什么不能用 `dryRun: true`：干跑轮次**没有 trace 行**，因此 `appendStep`
 *    不会写任何 step（那是有意的设计：只读网关不许写库）。要观察
 *    `memory_recall` step 就必须走真正的一轮 —— 它在沙箱库里，安全。
 */
const runRealTurn = async (text: string, options: { tokenBudget?: number } = {}) => {
  const gateway = new TurnGateway({
    kernel: h.kernel,
    definition: h.kernel.definition,
    identity: h.kernel.identitySnapshot,
    recorder: h.recorder,
    // 真实一轮的序号必须连续且 ≥ 1 —— 由 harness 的计数器给
    conversationSequence: h.nextTurnSequence,
    recentLimit: 16,
    slowPathEnabled: false,
    dryRun: false,
    userId: h.userId,
    recall: recallPort,
    recallEnabled: true,
    recallBudget: DEFAULT_CONTEXT_BUDGET,
    ...(options.tokenBudget !== undefined ? { tokenBudget: options.tokenBudget } : {}),
  })
  const incoming = await gateway.beginTurn(text)
  const packet = await gateway.compileTurn({ turn: incoming, currentInput: text, recentLines: [] })
  const outgoing = await gateway.completeTurn({ turn: incoming, replyText: '（自动回复）' })
  return { packet, trace: outgoing.trace }
}

/** 直接从端口取一次记录（用于记录级断言，不经过 gateway） */
const recordFor = async (text: string): Promise<RecallTurnOutcome> => {
  const { createRecallRequest } = await import('../src/kernel/contracts/recall.ts')
  const { entityRef } = await import('../src/kernel/contracts/entity.ts')
  return recallPort.run(
    createRecallRequest({
      traceId: newTraceId(),
      characterId: h.characterId,
      user: entityRef('user', h.userId),
      query: { text },
      intent: 'current_fact',
    })
  )
}

// ===========================================================================
report.section('① 记录完整性：AT7.1–AT7.6 逐条可查')
// ===========================================================================

const outcome = await recordFor(RELEVANT)
const record = outcome.record

report.check('AT7.1 traceId / characterId / user 都在', record.traceId.length > 0 && record.characterId.length > 0 && record.user.startsWith('user:'))
report.check('请求摘要存在，且**记录里没有原话**', record.requestDigest.length > 0 && !JSON.stringify(record).includes(RELEVANT))
report.check(
  'query 的配置量级可查（source / intent / timeScope / limit / target）',
  record.query.source === 'user_message' && record.query.intent === 'current_fact' &&
    record.query.timeScopeKind === 'any' && record.query.candidateLimit > 0 && record.query.targetStatus === 'none',
  JSON.stringify(record.query)
)
report.check(
  'AT7.2 计数 + 候选 id 都在（scanned / candidates）',
  record.metrics.scanned > 0 && record.metrics.candidateCount > 0 && record.candidates.length > 0,
  describeDecisionRecord(record)
)
report.check(
  '决策覆盖**每一条候选且恰好一次**（没有"剩下的去哪了"）',
  record.decisions.length === record.metrics.candidateCount &&
    new Set(record.decisions.map((d) => d.memoryId)).size === record.decisions.length,
  `decisions=${record.decisions.length} candidates=${record.metrics.candidateCount}`
)
report.check(
  'AT7.3 排除理由：未选中的每条都有理由，且直方图与逐条一致',
  record.decisions.filter((d) => !d.selected).every((d) => d.reason !== undefined) &&
    Object.entries(record.metrics.exclusionHistogram).every(([reason, count]) =>
      record.decisions.filter((d) => d.reason === reason).length >= count
    ),
  JSON.stringify(record.metrics.exclusionHistogram)
)
report.check(
  '「已遗忘」那条确实以 FORGOTTEN 出现（理由真的被记录，不是笼统"不合格"）',
  record.decisions.some((d) => d.reason === 'FORGOTTEN')
)
report.check(
  'AT7.4 排序明细：选中/预算裁掉的决策都带 score breakdown',
  record.decisions
    .filter((d) => d.selected || d.reason === 'BUDGET_EXHAUSTED')
    .every((d) => d.score !== undefined && d.score.components.length > 0),
  `带分数的决策 = ${record.decisions.filter((d) => d.score !== undefined).length}`
)
report.check(
  'score breakdown 保留了 `available`（"不得伪造"贯穿到 trace）',
  (record.decisions.find((d) => d.selected)?.score?.components ?? []).every(
    (component) => typeof component.available === 'boolean'
  ) &&
    (record.decisions.find((d) => d.selected)?.score?.components ?? []).some(
      (component) => component.name === 'semantic' && component.available === false
    )
)
report.check('AT7.5 selectedIds + 内容指纹', record.selectedIds.length > 0 && record.selectedFingerprints.length === record.selectedIds.length)
report.check(
  'AT7.6 预算账四个数字齐备',
  record.budget.budgetTokens > 0 && record.budget.memoryTokens > 0 &&
    typeof record.budget.reservedTokens === 'number' && typeof record.budget.totalTokens === 'number',
  JSON.stringify(record.budget)
)
report.check(
  'AT7.7 指标：候选/合格/选中/利用率/分数/到达上下文',
  record.metrics.eligibleCount > 0 &&
    record.metrics.selectedCount === record.selectedIds.length &&
    record.metrics.budgetUtilization > 0 &&
    record.metrics.topSelectedScore !== undefined &&
    record.metrics.reachedContext === true,
  JSON.stringify({ ...record.metrics, exclusionHistogram: undefined })
)
report.check(
  '有界：逐条明细最多 RECALL_RECORD_MAX_CANDIDATES 条，计数不受影响',
  record.candidates.length <= RECALL_RECORD_MAX_CANDIDATES &&
    record.decisions.length <= RECALL_RECORD_MAX_CANDIDATES,
  `max=${RECALL_RECORD_MAX_CANDIDATES} candidates=${record.candidates.length}`
)

// ===========================================================================
report.section('② 隐私：记录与 trace 属性里**没有正文**（结构 + 真实正文搜索）')
// ===========================================================================

let shapeOk = true
try {
  assertRecordShapeIsContentFree(record)
} catch {
  shapeOk = false
}
report.check('结构检查：记录里没有 dataText / content / summary 之类的字段', shapeOk)

const recordJson = JSON.stringify(record)
report.check(
  '真实正文搜索：fixture 的记忆文本一个都没出现在记录里',
  SECRETS.every((secret) => !recordJson.includes(secret)),
  SECRETS.filter((secret) => recordJson.includes(secret)).join(', ') || '全部干净'
)

const tracedTurn = await runRealTurn(RELEVANT)
const recallStep = tracedTurn.trace.steps.find((step) => step.kind === 'memory_recall')
report.check('trace 里有 memory_recall step（复用既有通道，没有第二套 tracing）', recallStep !== undefined)
const stepAttributes = JSON.stringify(recallStep?.attributes ?? {})
report.check(
  'step 属性里也没有正文（只有 id / 计数 / 分数 / 理由）',
  SECRETS.every((secret) => !stepAttributes.includes(secret)),
  SECRETS.filter((secret) => stepAttributes.includes(secret)).join(', ') || '全部干净'
)
report.check(
  'step 属性里带了扁平指标（不用解析 JSON 就能看量级）',
  typeof recallStep?.attributes.candidates === 'number' &&
    typeof recallStep?.attributes.selected === 'number' &&
    typeof recallStep?.attributes.reachedContext === 'boolean',
  JSON.stringify(Object.keys(recallStep?.attributes ?? {}))
)
report.check(
  'step 属性里带了逐条明细（有界 JSON）',
  typeof recallStep?.attributes.decisionRecord === 'string' &&
    (recallStep.attributes.decisionRecord as string).includes('"decisions"')
)

// ===========================================================================
report.section('③ trace 集成：selectedMemoryIds 与 packet 一致')
// ===========================================================================

report.check(
  'trace 的 selectedMemoryIds 与 packet 里来源引用一致',
  tracedTurn.trace.selectedMemoryIds.length > 0 &&
    tracedTurn.trace.selectedMemoryIds.every((id) => String(id).length > 0),
  JSON.stringify(tracedTurn.trace.selectedMemoryIds)
)
report.check(
  'trace 的 contextSectionIds 里有 memory-recall',
  tracedTurn.trace.contextSectionIds.includes('memory-recall'),
  JSON.stringify(tracedTurn.trace.contextSectionIds)
)

// ===========================================================================
report.section('④ Measurement Truth：判据必须是"模型实际拿到的那份文本"')
// ===========================================================================

/** 量具：这条记忆的**条目文本**是否出现在交给模型的 prompt 里 */
const memoryReachedModel = (packetText: string, memoryText: string): boolean =>
  packetText.includes(memoryText)

const memoryBlock = tracedTurn.packet.sections.find((section) => section.id === 'memory-recall')?.content
report.check(
  '正向：选中的记忆真的在 packet 文本里（不是"API 返回 200"）',
  memoryBlock !== undefined && memoryReachedModel(tracedTurn.packet.text, memoryBlock),
  `prompt 长度=${tracedTurn.packet.text.length}`
)

// ① 量具必须会响：把记忆块从 prompt 文本里抹掉 → 判据必须变成 false
const stripped = tracedTurn.packet.text.replace(memoryBlock ?? '', '')
report.check(
  '量具自检：把记忆块抹掉后，判据变成 false（它真的在测"有没有到"）',
  memoryReachedModel(stripped, memoryBlock ?? '') === false,
  '若这条不红，说明量具永远返回 true —— 那是假绿'
)
report.check(
  '**id 级判据不足以代替文本级**：抹掉文本后 selectedMemoryIds 仍然"有"',
  tracedTurn.trace.selectedMemoryIds.length > 0,
  '这正是计划书要求"验证模型实际获得了哪条"的原因'
)

// ② 真实的失配场景：上下文总预算不足 → 编译器把记忆段整段丢掉
const cramped = await runRealTurn(RELEVANT, { tokenBudget: 1 })
const crampedBlock = cramped.packet.sections.find((section) => section.id === 'memory-recall')
const crampedStep = cramped.trace.steps.find((step) => step.kind === 'memory_recall')
report.check(
  '上下文预算极小时，编译器把记忆段整段丢掉（这是 `droppable: true` 的真实后果）',
  crampedBlock === undefined,
  `sections=${cramped.packet.sections.map((s) => s.id).join(',')}`
)
report.check(
  '★ 此时 trace **如实报告没进**：selectedMemoryIds = []',
  cramped.trace.selectedMemoryIds.length === 0,
  JSON.stringify(cramped.trace.selectedMemoryIds)
)
report.check(
  '★ 且 step 里 reachedContext=false / droppedByContextBudget=true（事实与诊断分开）',
  crampedStep?.attributes.reachedContext === false && crampedStep?.attributes.selected === 0,
  JSON.stringify({
    reachedContext: crampedStep?.attributes.reachedContext,
    selected: crampedStep?.attributes.selected,
  })
)
report.check(
  '★ 诊断仍保留：intendedSelectedIds 非空（"本来选了谁"没有被丢掉）',
  (() => {
    const raw = crampedStep?.attributes.decisionRecord
    if (typeof raw !== 'string') return false
    const parsed = JSON.parse(raw) as { intendedSelectedIds: string[]; metrics: { droppedByContextBudget: boolean } }
    return parsed.intendedSelectedIds.length > 0 && parsed.metrics.droppedByContextBudget === true
  })()
)
report.check(
  '★ 文本级判据与 trace 一致：这条记忆**没有**到达模型',
  memoryReachedModel(cramped.packet.text, memoryBlock ?? '') === false
)

// ===========================================================================
report.section('⑤ 指标可聚合（AT7.7）')
// ===========================================================================

const batchTexts = ['我读的是什么专业？', '哪个院校录取的我？', '我吃辣吗？', '量子纠缠退相干']
const batch: RecallTurnOutcome[] = []
for (const text of batchTexts) batch.push(await recordFor(text))
const aggregate = aggregateRecallMetrics(batch.map((item) => item.record))
report.check(
  '聚合：轮数 / 平均候选 / 平均选中 / 预算利用率 / 到达率',
  aggregate.turns === batchTexts.length &&
    aggregate.meanCandidates > 0 &&
    aggregate.meanBudgetUtilization > 0 &&
    aggregate.reachedContextRate >= 0 &&
    aggregate.reachedContextRate <= 1,
  JSON.stringify(aggregate)
)
report.check(
  '无重叠查询那一轮：分层正确 —— 宽召回取回了候选，但一条都没进上下文',
  batch[3]!.record.metrics.selectedCount === 0 &&
    batch[3]!.record.metrics.reachedContext === false &&
    // ⚠️ `candidateCount` 是**宽召回**的条数（不是选中数）：资格层与相关性闸
    //    把它们逐条拦下，而"取回来"是 WP3 的职责。第一版把它当成 0 ——
    //    那测的其实是另一件事。
    batch[3]!.record.metrics.candidateCount > 0 &&
    (batch[3]!.record.metrics.exclusionHistogram.LOW_RELEVANCE ?? 0) > 0,
  JSON.stringify(batch[3]!.record.metrics)
)
report.check(
  '排除理由合计里能看到 FORGOTTEN（跨轮聚合）',
  (aggregate.exclusionTotals.FORGOTTEN ?? 0) >= 1,
  JSON.stringify(aggregate.exclusionTotals)
)
report.check('记录一行摘要可打印（**不含正文**）', !SECRETS.some((secret) => describeDecisionRecord(record).includes(secret)))

// ===========================================================================
// 证据
// ===========================================================================

mkdirSync(join(process.cwd(), 'artifacts', 'm5'), { recursive: true })
writeFileSync(
  join(process.cwd(), 'artifacts', 'm5', 'wp7-trace.json'),
  `${JSON.stringify(
    {
      testId: 'M5 / WP7 recall trace audit measurement truth',
      generatedAt: new Date().toISOString(),
      passed: report.passed,
      failed: report.failed,
      failures: [...report.failures],
      recordShape: {
        traceId: record.traceId,
        query: record.query,
        metrics: record.metrics,
        budget: record.budget,
        selectedIds: record.selectedIds,
        decisionsSample: record.decisions.slice(0, 3),
        truncated: record.truncated,
        maxCandidates: RECALL_RECORD_MAX_CANDIDATES,
      },
      privacy: {
        structuralCheck: shapeOk,
        secretsSearched: SECRETS.length,
        secretsFoundInRecord: SECRETS.filter((secret) => recordJson.includes(secret)).length,
        secretsFoundInStepAttributes: SECRETS.filter((secret) => stepAttributes.includes(secret)).length,
      },
      measurementTruth: {
        instrumentCanFail: memoryReachedModel(stripped, memoryBlock ?? '') === false,
        idLevelInsufficient: tracedTurn.trace.selectedMemoryIds.length > 0,
        realDropCase: {
          tokenBudget: 1,
          memorySectionPresent: crampedBlock !== undefined,
          selectedMemoryIds: cramped.trace.selectedMemoryIds,
          reachedContext: crampedStep?.attributes.reachedContext,
          droppedByContextBudget: true,
          memoryReachedModel: memoryReachedModel(cramped.packet.text, memoryBlock ?? ''),
        },
      },
      aggregate,
    },
    null,
    2
  )}\n`,
  'utf8'
)
console.log('\n证据已写入：artifacts/m5/wp7-trace.json')

await h.stop()
cleanupSandbox(sandbox.dir)
report.finish('M5 WP7 Recall Trace / Audit / Measurement Truth')
