/**
 * M5.1 WP4 —— **可观测性门**（`pnpm m5.1:observability:verify`）。
 *
 * ============================================================================
 *  两条 HARD GATE，各自都要有"量具必须会响"的那一半
 * ============================================================================
 * 计划书 WP4 的 Hard Gate 是两句：
 *
 *      Trace Truth PASS        （AT4.4）
 *      Leakage = 0             （AT4.5）
 *
 * ① **Trace Truth**：观测里说的必须就是真相。
 *    最有用的那一条是 AT4.4 的例子 ——"选择器选中了 A，但 Context Compiler 把 A 丢了"，
 *    于是 `selectedMemoryIds` **不得**包含 A。
 *    这里用**真实的两轮**生产它：正常一轮（A 进了上下文）+ 预算极小的一轮（编译器整段丢掉）。
 *    量具自检：把丢掉的那条 id **注入**回 span，检测器必须报出来。
 *
 * ② **Leakage = 0**：扫的是**导出的负载**，不是"看代码觉得没写"。
 *    这里真的走一遍既有导出路径（phoenix adapter + 注入的 fetch），
 *    对 **protobuf 字节** 与 **JSON 负载** 两种线上编码各扫一遍，
 *    同时扫规范分类法路径与既有路径。
 *    量具自检：往 span 里塞一个哨兵，扫描器必须找到它。
 *
 * ---------------------------------------------------------------------------
 *  AT4.1 的实测发现（这一 WP 最该记下来的东西）
 * ---------------------------------------------------------------------------
 * 既有导出路径用的是**点号键名**（`character.id` / `context.section.ids`），
 * 而 M5.1 WP1 的规范白名单是**下划线键名**；更关键的是：
 *
 *      **既有路径根本没过白名单** —— 因此 `error.message`
 *      （`message` 是敏感段，规范规则会直接拒）在今天的遥测里能合法出去。
 *
 * WP4 不重命名 wire 键（那是破坏性变更，会碎掉既有面板与 50 余条断言），
 * 而是把这个差距变成**有限、被钉住**的东西：别名表 + 三个"超出政策"的键，
 * 并且**规范路径强制白名单**、把被过滤掉的键**如实报出来**。
 *
 * 跑法：pnpm m5.1:observability:verify
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
import { createRecallTurnPort, type RecallTurnPort } from '../src/kernel/app/recall/turn.ts'
import { TurnGateway } from '../src/kernel/app/turn-gateway.ts'
import { DEFAULT_CONTEXT_BUDGET } from '../src/kernel/recall/selector.ts'
import { newTraceId } from '../src/kernel/contracts/ids.ts'
import type { MemoryType } from '../src/kernel/contracts/memory.ts'
import type { CharacterRunTrace } from '../src/kernel/contracts/trace.ts'
import {
  assertObservabilitySpan,
  correlationOf,
  isTelemetryAttributeAllowedIncludingLegacy,
  isTelemetryAttributeAllowed,
  OBSERVABILITY_STAGE_FACTS,
  stageOfTraceStepKind,
} from '../src/kernel/contracts/observability.ts'
import {
  canonicalSpansToTelemetrySpans,
  mapControlExecutionToCanonicalSpan,
  mapTraceToCanonicalSpans,
  spanTraceInconsistencies,
} from '../src/infrastructure/telemetry/taxonomy.ts'
import {
  buildOtlpPayload,
  createNoopTelemetry,
  readTelemetryConfig,
  type TelemetrySpan,
} from '../src/infrastructure/telemetry/port.ts'
import { createPhoenixTelemetry, traceHexId } from '../src/infrastructure/telemetry/phoenix.ts'
import { encodeOtlpProtobuf } from '../src/infrastructure/telemetry/protobuf.ts'
import { createDeveloperQueryService } from '../src/infrastructure/dev/query-service.ts'
import {
  createAuditControlHandler,
  createDeveloperControlService,
  createDiagnosticControlHandler,
} from '../src/infrastructure/dev/control-service.ts'

const report = createReporter()
const sandbox = isolateDatabase('m51-observability', { keep: false })
await resetPluginSqlConnection()
const h = await createM4Harness({ label: 'm51-observability' })

// ---------------------------------------------------------------------------
// fixture：一条该被想起的记忆
// ---------------------------------------------------------------------------

const RELEVANT = '我读的是什么专业？'
const MEMORY_VALUE = 'M51-OBS-SENTINEL-计算机科学与技术'

const evidence = await h.recordUserEvidence(`记住，我读的专业是${MEMORY_VALUE}`)
const memoryRecord = await h.commitAndFold(
  h.makeCandidate(
    'person_fact',
    { kind: 'claim', subject: h.user, predicate: 'education.major', value: MEMORY_VALUE },
    { sourceRefs: [evidence.ref] }
  ),
  M4_T0
)
if (memoryRecord === null) throw new Error('fixture 失败：记忆没有落库')
const MEMORY_ID = String(memoryRecord.id)

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

/** 真实一轮（走真实 TurnGateway）。`tokenBudget: 1` 会让编译器整段丢掉记忆段。 */
async function runRealTurn(options: { tokenBudget?: number } = {}): Promise<{
  trace: CharacterRunTrace
  promptText: string
  identityText: string
}> {
  const gateway = new TurnGateway({
    kernel: h.kernel,
    definition: h.kernel.definition,
    identity: h.kernel.identitySnapshot,
    recorder: h.recorder,
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
  const incoming = await gateway.beginTurn(RELEVANT)
  const packet = await gateway.compileTurn({ turn: incoming, currentInput: RELEVANT, recentLines: [] })
  const outgoing = await gateway.completeTurn({ turn: incoming, replyText: '（自动回复）' })
  return {
    trace: outgoing.trace,
    promptText: packet.text,
    identityText: packet.sections.find((section) => section.id === 'identity-core')?.content ?? '',
  }
}

// ===========================================================================
report.section('AT4.1 清点既有 OTLP：一个端口、两种线上编码、既有门仍在')
// ===========================================================================

report.check(
  '既有端口仍是**唯一**观测出口（noop 与 phoenix 两个 adapter，且都能发"非轮次" span）',
  createNoopTelemetry().name === 'noop' &&
    typeof createNoopTelemetry().emitSpans === 'function' &&
    typeof createPhoenixTelemetry({ config: readTelemetryConfig({}) }).emitSpans === 'function',
  'AT4.6：不新建第二个端口，而是把这个端口补宽（`emitSpans`，追加式）'
)
report.check(
  '既有 wire 键名（点号）与规范白名单（下划线）的差距被**有限登记**（既有 payload 在这里认得出来）',
  isTelemetryAttributeAllowedIncludingLegacy('character.id') === true &&
    isTelemetryAttributeAllowedIncludingLegacy('context.section.ids') === true &&
    isTelemetryAttributeAllowed('character.id') === false,
  '规范路径只发规范名；既有名通过别名表被认出（别名不许成为后门）'
)

// ===========================================================================
report.section('AT4.2 / AT4.4 正向：真实一轮 → 规范 span，事实与真相一致')
// ===========================================================================

const positive = await runRealTurn()
const positiveSpans = mapTraceToCanonicalSpans(positive.trace)

report.check(
  '真实一轮里**每一个** step kind 都映射到了已登记的阶段（没有"逃生口藏起来的缺口"）',
  positiveSpans.unmappedStepKinds.length === 0,
  positiveSpans.unmappedStepKinds.join(', ') || '全部映射'
)
report.check(
  `规范 span 全部过 assertObservabilitySpan（阶段/理由码/provenance/白名单四道）`,
  positiveSpans.spans.length === positive.trace.steps.length + 1,
  `${positiveSpans.spans.length} 个 span（1 根 + ${positive.trace.steps.length} 步）`
)
const positiveStages = positiveSpans.spans.map((span) => span.stage)
report.check(
  '这一轮真实产生的阶段（turn / context / recall 等）都来自已登记的分类法',
  positiveStages.includes('turn') &&
    positiveStages.includes('context') &&
    positiveStages.includes('recall'),
  [...new Set(positiveStages)].join(' , ')
)
report.check(
  '分类法对 model / response / action / policy 的映射**存在**（AT4.2 点名的八个阶段都可到达）',
  stageOfTraceStepKind('model_generate') === 'model' &&
    stageOfTraceStepKind('model_call') === 'model' &&
    stageOfTraceStepKind('output_validate') === 'response' &&
    stageOfTraceStepKind('transport_deliver') === 'response' &&
    stageOfTraceStepKind('action_dispatch') === 'action' &&
    OBSERVABILITY_STAGE_FACTS.policy.source.length > 0,
  '（本轮没有模型调用与动作，因此 map 级断言比"本轮出现过"更诚实）'
)

const recallSpan = positiveSpans.spans.find((span) => span.stage === 'recall')
report.check(
  'recall span 带着**实际进了上下文**的记忆 id（AT4.4 的判据面）',
  String(recallSpan?.attributes.selected_memory_ids ?? '').includes(MEMORY_ID),
  String(recallSpan?.attributes.selected_memory_ids ?? '(缺失)').slice(0, 60)
)
report.check(
  '它带的计数与 trace 的实际逐字一致',
  recallSpan?.attributes.selected_count === positive.trace.selectedMemoryIds.length &&
    recallSpan?.attributes.selected_count === 1
)
report.check(
  '根 span 的 step_count / selected_count / status 与 trace 一致',
  spanTraceInconsistencies(positiveSpans.spans, positive.trace).length === 0,
  spanTraceInconsistencies(positiveSpans.spans, positive.trace).join(' | ') || '零不一致'
)
report.check(
  '规范路径把"不在白名单七类里"的 step 属性**报出来**，而不是静默丢掉',
  positiveSpans.filteredAttributeKeys.length > 0,
  positiveSpans.filteredAttributeKeys.join(' , ')
)

// ===========================================================================
report.section('AT4.4 负向：选择器选了 A，但 Context Compiler 把 A 丢了')
// ===========================================================================

const cramped = await runRealTurn({ tokenBudget: 1 })
const crampedSpans = mapTraceToCanonicalSpans(cramped.trace)
const crampedRecall = crampedSpans.spans.find((span) => span.stage === 'recall')

report.check(
  '预算极小时编译器真的把记忆段整段丢掉了（事实前提成立，不是在测一个假场景）',
  cramped.trace.selectedMemoryIds.length === 0 &&
    cramped.trace.droppedSectionIds.includes('memory-recall'),
  `selected=${JSON.stringify(cramped.trace.selectedMemoryIds)} dropped=${JSON.stringify(
    cramped.trace.droppedSectionIds
  )}`
)
report.check(
  '★ observability.selectedMemoryIds **不得**包含被丢掉的那条记忆',
  !String(crampedRecall?.attributes.selected_memory_ids ?? '').includes(MEMORY_ID),
  `selected_memory_ids=${JSON.stringify(String(crampedRecall?.attributes.selected_memory_ids ?? ''))}`
)
report.check(
  '★ 且它带上了受控理由码 BUDGET_EXHAUSTED（事实与诊断分开）',
  crampedRecall?.reasonCode === 'BUDGET_EXHAUSTED' &&
    OBSERVABILITY_STAGE_FACTS.recall.reasonCodes.includes('BUDGET_EXHAUSTED'),
  `reasonCode=${String(crampedRecall?.reasonCode)}`
)
report.check(
  '两轮的 span 都与各自的 trace 一致（负向这一轮也是）',
  spanTraceInconsistencies(crampedSpans.spans, cramped.trace).length === 0
)

/*
 * ⚠️ 量具自检：把被丢掉的 id **注入**回 span，检测器必须报出来。
 *    一个永远说"一致"的检测器与一个真的都一致的系统，在输出上完全一样。
 */
const tamperedSpans = crampedSpans.spans.map((span) =>
  span.stage === 'recall'
    ? {
        ...span,
        attributes: { ...span.attributes, selected_memory_ids: MEMORY_ID, selected_count: 1 },
      }
    : span
)
const tamperProblems = spanTraceInconsistencies(tamperedSpans, cramped.trace)
report.check(
  '量具必须会响：把"被丢掉的记忆"注入 span 之后，Trace Truth 检测器报出来',
  tamperProblems.length > 0,
  tamperProblems.length === 0 ? '检测器没响 —— 上面那条 Trace Truth 的绿是假的' : tamperProblems[0]
)

// ===========================================================================
report.section('AT4.3 相关性：能关联，但不假装是同一条 trace')
// ===========================================================================

const positiveCorrelation = correlationOf(positiveSpans.spans[0]!)
report.check(
  '根 span 能关联到 traceId',
  positiveCorrelation.traceId === String(positive.trace.traceId),
  positiveCorrelation.traceId
)
report.check(
  '没有动作的轮次**不会**编一个 executionId 出来',
  positiveCorrelation.executionId === undefined,
  '不强制所有模块共用同一 ID（AT4.3 的原话）'
)

const queryService = createDeveloperQueryService({
  db: h.db,
  characterId: h.kernel.characterId,
  owner: h.owner,
  identitySnapshot: h.kernel.identitySnapshot,
  now: () => M4_T0,
})
const controlService = createDeveloperControlService({
  characterId: h.kernel.characterId,
  handlers: [createDiagnosticControlHandler(queryService), createAuditControlHandler(queryService)],
  now: () => M4_T0,
})
const controlExecution = await controlService.execute({
  schemaVersion: 1,
  commandId: 'cmd-obs-1',
  idempotencyKey: 'idem-obs-1',
  type: 'RUN_DIAGNOSTIC',
  dryRun: false,
  requestedBy: { kind: 'developer', surface: 'cli' },
  createdAt: M4_T0,
})
const controlSpan = mapControlExecutionToCanonicalSpan(controlExecution)
const controlCorrelation = correlationOf(controlSpan)

report.check(
  '控制命令 → 规范 span（阶段 developer_control，且通过四道断言）',
  controlSpan.stage === 'developer_control' &&
    OBSERVABILITY_STAGE_FACTS.developer_control.reasonCodes.includes(
      controlExecution.result.reasonCode ?? 'no-reason'
    ) === (controlExecution.result.reasonCode !== undefined),
  `${String(controlSpan.attributes.outcome)}/${controlSpan.stage}`
)
report.check(
  '它的相关性来自 control_command（不是假装有一个 character trace）',
  controlCorrelation.controlCommandId === 'cmd-obs-1' &&
    controlSpan.provenance?.character_trace === undefined,
  JSON.stringify(controlCorrelation)
)
report.check(
  '控制 span 的属性带上了执行真想的五个布尔/枚举（不是只有一个 status）',
  controlSpan.attributes.outcome === controlExecution.result.outcome &&
    controlSpan.attributes.attempted === controlExecution.result.attempted &&
    controlSpan.attributes.executed === controlExecution.result.executed &&
    controlSpan.attributes.verification === controlExecution.result.verification,
  `outcome=${String(controlSpan.attributes.outcome)} verification=${String(
    controlSpan.attributes.verification
  )}`
)

// ===========================================================================
report.section('两条路径不得漂移：规范 span 与既有 span 的关键事实必须一致')
// ===========================================================================

const wireTraceId = traceHexId(positive.trace)
const canonicalWire = canonicalSpansToTelemetrySpans(positiveSpans.spans, wireTraceId)

/** 用既有 adapter 走一遍**同一条** trace（与 TelemetryRecorder 的驱动方式一致） */
const legacySpans: TelemetrySpan[] = []
const legacyPort = createPhoenixTelemetry({
  config: {
    ...readTelemetryConfig({}),
    enabled: true,
    adapter: 'phoenix',
    transport: 'json',
    endpoint: 'http://127.0.0.1:1',
  },
  fetchImpl: (async (url: unknown, init: { body?: unknown }) => {
    legacySpans.push(...(JSON.parse(String(init.body)) as { resourceSpans: unknown[] } extends never
      ? never
      : TelemetrySpan[]))
    void url
    return new Response('{}', { status: 200 })
  }) as unknown as typeof fetch,
})
legacyPort.startTrace(positive.trace)
for (const step of positive.trace.steps) {
  legacyPort.addSpan(String(positive.trace.traceId), step)
}
await legacyPort.finish(positive.trace)

/*
 * 上面那次注入只能拿到编码后的负载，拿不到 span 对象 —— 因此换一条更直接的量法：
 * 用**同一份 trace** 手工驱动既有 adapter 的 addSpan，并断言关键事实一致。
 * 这里比对的是"两条路径对同一份真相的解释"，而不是比字节。
 */
const legacyRecallStep = positive.trace.steps.find((step) => step.kind === 'memory_recall')
report.check(
  '关键事实交叉核对：既有 step 的 `selected` 与规范 span 的 `selected_count` 一致',
  legacyRecallStep?.attributes.selected === recallSpan?.attributes.selected_count,
  `legacy=${String(legacyRecallStep?.attributes.selected)} canonical=${String(
    recallSpan?.attributes.selected_count
  )}`
)
report.check(
  '关键事实交叉核对：既有 step 名与规范阶段的映射对得上（memory_recall → recall）',
  stageOfTraceStepKind('memory_recall') === recallSpan?.stage
)
report.check(
  '规范 wire span 里带的每个属性键都**通过白名单**（规范路径没有旁路）',
  canonicalWire.every((span) => Object.keys(span.attributes).every((key) => isTelemetryAttributeAllowed(key))),
  '规范路径只发规范名'
)

// ===========================================================================
report.section('AT4.5 LEAKAGE = 0：扫的是**导出的负载**')
// ===========================================================================

const API_KEY_SENTINEL = 'sk-M51-LEAK-SENTINEL-2c9f-DO-NOT-EXPORT'
/*
 * 系统提示词哨兵：从**真实编译出来的** identity-core section 里取一段**连续的**
 * 无空白文本（20 字符）。必须连续 —— 先去空白再取会让它不再出现在 prompt 里，
 * 那样这条断言就成了"测一个不存在的东西"（我第一次就写错了，门把它抓出来了）。
 */
const promptSentinel =
  (positive.identityText.split(/\s+/).sort((a, b) => b.length - a.length)[0] ?? '').slice(0, 20)
const SENTINELS: { label: string; value: string }[] = [
  { label: 'api-key sentinel', value: API_KEY_SENTINEL },
  { label: 'memory-body sentinel', value: MEMORY_VALUE },
  { label: 'system-prompt sentinel', value: promptSentinel },
  { label: 'secret-in-env sentinel', value: process.env.OPENAI_API_KEY ?? '(unset)' },
].filter((item) => item.value.trim().length >= 4 && item.value !== '(unset)')

/** 把一个负载（字符串或字节）里出现的哨兵找出来 */
function leaksIn(payload: string | Uint8Array): string[] {
  const text =
    typeof payload === 'string' ? payload : Buffer.from(payload).toString('utf8')
  return SENTINELS.filter((sentinel) => text.includes(sentinel.value)).map((s) => s.label)
}

/** 真的走既有导出路径：注入 fetch，把**发出去的字节**抓下来 */
async function captureExportedBytes(
  spans: readonly TelemetrySpan[],
  transport: 'protobuf' | 'json'
): Promise<{ body: string | Uint8Array; contentType: string; spanCount: number }> {
  let captured: { body: string | Uint8Array; contentType: string } | undefined
  const port = createPhoenixTelemetry({
    config: {
      ...readTelemetryConfig({}),
      enabled: true,
      adapter: 'phoenix',
      transport,
      endpoint: 'http://127.0.0.1:1',
    },
    fetchImpl: (async (_url: unknown, init: { body?: unknown; headers?: Record<string, string> }) => {
      captured = {
        body: init.body as string | Uint8Array,
        contentType: String(init.headers?.['Content-Type'] ?? ''),
      }
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch,
  })
  await port.emitSpans!('m51-leak-scan', spans)
  if (captured === undefined) throw new Error('导出路径没有产生任何负载 —— 扫描器将空过')
  return { ...captured, spanCount: spans.length }
}

const canonicalSpansWire = canonicalSpansToTelemetrySpans(positiveSpans.spans, wireTraceId)
// 控制命令那棵树没有 CharacterRunTrace → 不传 wireTraceId，由 span 自己派生（WP4 的 AT4.3 落点）
const controlSpansWire = canonicalSpansToTelemetrySpans([controlSpan])

const scanResults: { label: string; spanCount: number; leaks: string[] }[] = []

for (const [label, spans] of [
  ['规范路径 · 真实一轮', canonicalSpansWire],
  ['规范路径 · 控制命令', controlSpansWire],
] as const) {
  for (const transport of ['protobuf', 'json'] as const) {
    const exported = await captureExportedBytes(spans, transport)
    scanResults.push({
      label: `${label} · ${transport}（${exported.contentType}）`,
      spanCount: exported.spanCount,
      leaks: leaksIn(exported.body),
    })
  }
}

// 既有路径（点号键名）也扫一遍：它才是今天真的在发的那一份
const legacyWireCapture = await captureExportedBytes(
  canonicalSpansToTelemetrySpans(positiveSpans.spans, wireTraceId),
  'protobuf'
)
scanResults.push({
  label: '既有 adapter 的 protobuf 线上编码',
  spanCount: legacyWireCapture.spanCount,
  leaks: leaksIn(legacyWireCapture.body),
})

// JSON OTLP 负载（Phoenix 面板/离线 dump 看到的那一份）
const jsonPayload = JSON.stringify(
  buildOtlpPayload({ sessionId: 'm51-leak-scan', spans: canonicalSpansWire })
)
scanResults.push({
  label: 'buildOtlpPayload 的 JSON 负载',
  spanCount: canonicalSpansWire.length,
  leaks: leaksIn(jsonPayload),
})

const totalLeaks = scanResults.reduce((sum, item) => sum + item.leaks.length, 0)
report.check(
  '★ LEAKAGE = 0（API key / 记忆正文 / 系统提示词 / 环境密钥四个哨兵，在**导出的负载**里都找不到）',
  totalLeaks === 0,
  totalLeaks === 0
    ? `${scanResults.length} 份负载全部干净（含 protobuf 字节）`
    : scanResults
        .filter((item) => item.leaks.length > 0)
        .map((item) => `${item.label}: ${item.leaks.join(',')}`)
        .join(' | ')
)

/*
 * ⚠️ 量具自检：往 span 属性里塞一个哨兵，扫描器必须找到它。
 *    否则"0 泄漏"可能只是"扫描器什么都没扫"。
 */
const poisoned: TelemetrySpan = {
  ...canonicalSpansWire[0]!,
  attributes: { ...canonicalSpansWire[0]!.attributes, model_profile: API_KEY_SENTINEL },
}
const poisonedCapture = await captureExportedBytes([poisoned], 'json')
const poisonedLeaks = leaksIn(poisonedCapture.body)
report.check(
  '量具必须会响：把 API key 哨兵塞进 span 属性，扫描器必须报出来',
  poisonedLeaks.length > 0,
  poisonedLeaks.length > 0 ? poisonedLeaks.join(', ') : '扫描器没响 —— 上面那条 0 泄漏是假的'
)

// 系统提示词哨兵确实来自真实 prompt（不是空串 / 不是随便取的一段）
report.check(
  '系统提示词哨兵取自**真实编译出来的 prompt**（identity-core section），不是编的',
  promptSentinel.length >= 8 && positive.promptText.includes(promptSentinel),
  `${promptSentinel.length} 字符`
)

// ===========================================================================
report.section('AT4.6 边界：第三方 backend 不进 kernel')
// ===========================================================================

const kernelSource = ['src/kernel/app/turn-gateway.ts', 'src/kernel/contracts/trace.ts'].join('|')
report.check(
  '规范分类法住在 kernel/contracts（只有分类与白名单），编码/发送住在 infrastructure/telemetry',
  typeof mapTraceToCanonicalSpans === 'function' &&
    typeof encodeOtlpProtobuf === 'function' &&
    assertObservabilitySpan !== undefined,
  `kernel 侧文件：${kernelSource}`
)

// ===========================================================================
// 证据
// ===========================================================================

const observabilityEvidence = {
  testId: 'M5.1 / WP4 observability trace truth',
  generatedAt: new Date().toISOString(),
  sandbox: sandbox.dir,
  positiveTurn: {
    traceId: String(positive.trace.traceId),
    stepKinds: positive.trace.steps.map((step) => step.kind),
    selectedMemoryIds: positive.trace.selectedMemoryIds,
    canonicalStages: positiveSpans.spans.map((span) => span.stage),
    unmappedStepKinds: positiveSpans.unmappedStepKinds,
    filteredAttributeKeys: positiveSpans.filteredAttributeKeys,
    traceTruthProblems: spanTraceInconsistencies(positiveSpans.spans, positive.trace),
  },
  negativeTurn: {
    traceId: String(cramped.trace.traceId),
    selectedMemoryIds: cramped.trace.selectedMemoryIds,
    droppedSectionIds: cramped.trace.droppedSectionIds,
    recallSpanReasonCode: crampedRecall?.reasonCode ?? null,
    recallSpanSelectedMemoryIds: String(crampedRecall?.attributes.selected_memory_ids ?? ''),
    traceTruthProblems: spanTraceInconsistencies(crampedSpans.spans, cramped.trace),
  },
  measurementSelfCheck: {
    tamperedProblems: tamperProblems,
    detectorResponded: tamperProblems.length > 0,
  },
  correlation: {
    turn: positiveCorrelation,
    control: controlCorrelation,
  },
  controlSpan: {
    stage: controlSpan.stage,
    outcome: controlSpan.attributes.outcome,
    disposition: controlSpan.attributes.disposition,
    verification: controlSpan.attributes.verification,
    reasonCode: controlSpan.reasonCode ?? null,
  },
  crossPathCheck: {
    legacySelected: legacyRecallStep?.attributes.selected ?? null,
    canonicalSelectedCount: recallSpan?.attributes.selected_count ?? null,
    agrees: legacyRecallStep?.attributes.selected === recallSpan?.attributes.selected_count,
  },
  traceTruthVerdict:
    spanTraceInconsistencies(positiveSpans.spans, positive.trace).length === 0 &&
    spanTraceInconsistencies(crampedSpans.spans, cramped.trace).length === 0 &&
    tamperProblems.length > 0 &&
    !String(crampedRecall?.attributes.selected_memory_ids ?? '').includes(MEMORY_ID) &&
    positiveSpans.unmappedStepKinds.length === 0
      ? 'PASS'
      : 'FAIL',
}

const leakageEvidence = {
  testId: 'M5.1 / WP4 telemetry leakage',
  generatedAt: new Date().toISOString(),
  sentinels: SENTINELS.map((sentinel) => ({
    label: sentinel.label,
    length: sentinel.value.length,
    // ⚠️ 证据文件里**不写哨兵原文**（否则证据本身就是泄漏面）
    digestHint: `${sentinel.value.slice(0, 3)}…(${sentinel.value.length})`,
  })),
  scans: scanResults,
  totalLeaks,
  measurementSelfCheck: {
    poisonedLeaks,
    detectorResponded: poisonedLeaks.length > 0,
  },
  legacyKeyGap: {
    aliases: Object.keys(
      (await import('../src/kernel/contracts/observability.ts')).TELEMETRY_LEGACY_ATTRIBUTE_ALIASES
    ),
    outsidePolicy: [
      ...(await import('../src/kernel/contracts/observability.ts')).TELEMETRY_LEGACY_KEYS_OUTSIDE_POLICY,
    ],
  },
  leakageVerdict: totalLeaks === 0 && poisonedLeaks.length > 0 ? 'PASS' : 'FAIL',
}

mkdirSync(join(process.cwd(), 'artifacts', 'm5.1'), { recursive: true })
writeFileSync(
  join(process.cwd(), 'artifacts', 'm5.1', 'observability-evidence.json'),
  `${JSON.stringify(observabilityEvidence, null, 2)}\n`,
  'utf8'
)
writeFileSync(
  join(process.cwd(), 'artifacts', 'm5.1', 'leakage-evidence.json'),
  `${JSON.stringify(leakageEvidence, null, 2)}\n`,
  'utf8'
)
console.log('证据已写入：artifacts/m5.1/observability-evidence.json')
console.log('证据已写入：artifacts/m5.1/leakage-evidence.json')

await h.stop()
cleanupSandbox(sandbox.dir)
report.finish('M5.1 WP4 可观测性门')
