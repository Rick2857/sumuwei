/**
 * Canonical Span Taxonomy —— **既有 tracing 的分类法适配器**（M5.1 WP4 / AT4.1–AT4.4）。
 *
 * ============================================================================
 *  它做的事只有一件：把"已经发生的事实"翻译成**已登记的阶段**
 * ============================================================================
 * 输入是 `CharacterRunTrace`（业务真相，M5.1 全程不动它），
 * 输出是**已经通过 `assertObservabilitySpan` 的**规范 span。
 * 也就是说：分类法（`OBSERVABILITY_STAGE_FACTS`）、相关性（provenance）、
 * 敏感数据白名单（AT1.4）这三条约束，在这里第一次作用在**真实一轮**上。
 *
 * ---------------------------------------------------------------------------
 *  ⚠️ WP4 清点既有 OTLP 时实测到的三件事（都写在这一层里）
 * ---------------------------------------------------------------------------
 *  ① **既有导出路径用的是自由字符串名**（`character.<step.kind>`），
 *     所以 WP1 的分类法契约在 WP4 之前**没有任何消费者** ——
 *     这正是"看起来能表达、永远触发不了"的同一种形状。
 *     本文件就是它的第一个消费者。
 *
 *  ② **既有 wire 键名（点号）与规范白名单（下划线）不一致**，
 *     而既有路径**根本没过白名单**。实测后果：`error.message`
 *     （`message` 是敏感段）在旧 payload 里能合法出去。
 *     本文件对**规范路径**强制白名单，并把被过滤掉的键**如实报出来**
 *     （`filteredAttributeKeys`）—— 不许静默丢弃。
 *
 *  ③ **"选择器选中了谁"与"真的进了上下文的是谁"是两件事**（AT4.4 / M5 的
 *     `applyContextReality`）。因此 `selected_memory_ids` **只**取自
 *     `trace.selectedMemoryIds`（那是编译之后的现实），
 *     绝不取自召回决策里的 `intendedSelectedIds`。
 */

import {
  OBSERVABILITY_STAGE_FACTS,
  assertObservabilitySpan,
  isTelemetryAttributeAllowed,
  spanDurationMs,
  stageOfTraceStepKind,
  type ObservabilitySpanInput,
  type ObservabilityStage,
} from '../../kernel/contracts/observability.ts'
import type { CharacterRunTrace, TraceStep } from '../../kernel/contracts/trace.ts'
import type { ControlExecution } from '../dev/control-service.ts'
import { spanHexId, wireTraceHexId } from './phoenix.ts'
import type { TelemetrySpan } from './port.ts'

/** 一轮的根 span 用 `turn` 阶段；它是唯一的父 span（其余都挂在它下面） */
const ROOT_STAGE: ObservabilityStage = 'turn'

export interface CanonicalSpanSet {
  spans: ObservabilitySpanInput[]
  /**
   * 没有映射到任何已登记阶段的 step kind。
   *
   * **如实报告，不许静默丢掉**：`TraceStepKind` 末尾有 `| (string & {})` 逃生口，
   * 所以新加一个 step kind 而忘了登记阶段时，唯一能让这件事被看见的办法
   * 就是数出来。为 0 才是健康。
   */
  unmappedStepKinds: string[]
  /**
   * 被 AT1.4 白名单过滤掉的属性键（连同来源阶段）。
   *
   * 它们**不是**错误：step 的原始 attributes 里有 M5 的扁平指标
   * （`candidates` / `decisionRecord` / `reachedContext` …），
   * 那些键名不在白名单的七类里。这份清单让"被丢掉了什么"是可见的。
   */
  filteredAttributeKeys: string[]
}

/** span 的稳定标识（同一轮同一阶段永远得到同一个 id） */
function canonicalSpanId(traceId: string, stage: ObservabilityStage, index: number): string {
  return `${traceId}#${stage}#${index}`
}

/** 只保留白名单允许的键（含既有别名）；其余**报出来**而不是静默丢弃 */
function projectAttributes(
  raw: Readonly<Record<string, unknown>>,
  filtered: string[]
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined || value === null) continue
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      // 非标量（数组 / 对象 / JSON 字符串）一律不进属性：OTLP 属性是标量
      filtered.push(key)
      continue
    }
    if (!isTelemetryAttributeAllowed(key)) {
      filtered.push(key)
      continue
    }
    out[key] = value as string | number | boolean
  }
  return out
}

function stepReasonCode(
  stage: ObservabilityStage,
  step: TraceStep,
  trace: CharacterRunTrace
): string | undefined {
  const registered = OBSERVABILITY_STAGE_FACTS[stage].reasonCodes
  const pick = (candidate: string): string | undefined =>
    registered.includes(candidate) ? candidate : undefined

  if (stage === 'model' && step.status === 'failed') return pick('model_step_failed')
  if (stage === 'response' && step.status === 'failed') return pick('output_validation_failed')
  /*
   * `memory_recall`：选出了人但**没进上下文**时，理由码是 `BUDGET_EXHAUSTED`。
   *
   * ⚠️ 这是"事实 × 诊断"的分界：`selectedMemoryIds` 是**事实**（编译之后的现实），
   *    `droppedSectionIds` 里的 `memory-recall` 是**诊断**（为什么没进）。
   *    两者都在 trace 上，因此这个理由码不是猜的。
   */
  if (
    stage === 'recall' &&
    trace.selectedMemoryIds.length === 0 &&
    trace.droppedSectionIds.includes('memory-recall')
  ) {
    return pick('BUDGET_EXHAUSTED')
  }
  return undefined
}

/** 根 span：一轮的**汇总事实**（ID / 计数 / 时长 / 状态），不含正文 */
function buildRootSpan(
  trace: CharacterRunTrace,
  filtered: string[]
): ObservabilitySpanInput {
  const attributes = projectAttributes(
    {
      status: trace.status,
      ...(trace.runtimeId !== undefined ? { runtime_id: trace.runtimeId } : {}),
      ...(trace.userId !== undefined ? { user_id: trace.userId } : {}),
      ...(trace.conversationId !== undefined ? { conversation_id: trace.conversationId } : {}),
      ...(trace.seedVersion !== undefined ? { seed_version: trace.seedVersion } : {}),
      ...(trace.modelProfile !== undefined ? { model_profile: trace.modelProfile } : {}),
      ...(trace.contextCompilerVersion !== undefined
        ? { context_compiler_version: trace.contextCompilerVersion }
        : {}),
      context_section_count: trace.contextSectionIds.length,
      dropped_section_count: trace.droppedSectionIds.length,
      selected_count: trace.selectedMemoryIds.length,
      action_count: trace.actionIds.length,
      domain_event_count: trace.domainEventIds.length,
      step_count: trace.steps.length,
      // ⚠️ 只发"有没有错"，**不发错误文本**。既有路径发的 `error.message` 是
      //    自由文本，而外发不可撤回（见 TELEMETRY_LEGACY_KEYS_OUTSIDE_POLICY）。
      has_error: (trace.error ?? '').trim() !== '',
    },
    filtered
  )

  return {
    traceId: String(trace.traceId),
    spanId: canonicalSpanId(String(trace.traceId), ROOT_STAGE, 0),
    stage: ROOT_STAGE,
    name: `character.${ROOT_STAGE}`,
    status: trace.status === 'failed' ? 'error' : trace.status === 'running' ? 'unset' : 'ok',
    startedAt: trace.startedAt,
    ...(trace.finishedAt !== undefined ? { finishedAt: trace.finishedAt } : {}),
    ...(trace.status === 'failed' ? { reasonCode: 'turn_failed' } : {}),
    provenance: {
      character_trace: String(trace.traceId),
      ...(trace.actionIds.length > 0 ? { action_ledger: trace.actionIds[0]! } : {}),
    },
    attributes,
  }
}

/** 一个 step → 一个 span（阶段来自 `stageOfTraceStepKind`，**唯一**映射） */
function buildStepSpan(
  trace: CharacterRunTrace,
  step: TraceStep,
  index: number,
  rootSpanId: string,
  filtered: string[],
  unmapped: string[]
): ObservabilitySpanInput | undefined {
  const mapped = stageOfTraceStepKind(step.kind)
  let stage: ObservabilityStage
  if (mapped === 'unknown') {
    unmapped.push(step.kind)
    /*
     * 未登记的 step kind：**降级挂到 turn 阶段**而不是丢掉整条 span。
     * 丢掉会让"这一步发生过"这件事从观测里消失；
     * 而挂到 turn 上 + 在 `unmappedStepKinds` 里如实报出来，两件事都保住了。
     * （`span_kind_source` 属性即"它原本是什么"，值只可能是（含敏感词时除外）……）
     */
    stage = ROOT_STAGE
  } else {
    stage = mapped
  }

  /*
   * 顺序**就是**不变量：先放 step 的原始 attributes（含 M5 的扁平指标），
   * 再放显式映射 —— 这样"事实"永远覆盖"诊断"。
   * 反过来的话，step 里的 `selected` / `intendedSelectedIds` 就能盖掉
   * 编译之后的现实，而 AT4.4 要的正是现实赢。
   */
  const rawAttributes: Record<string, unknown> = {
    ...step.attributes,
    ...(mapped === 'unknown' ? { span_kind_source: step.kind } : {}),
    status: step.status,
  }
  if (stage === 'recall') {
    // ⚠️ AT4.4：`selected_memory_ids` **只**取自 trace 的 `selectedMemoryIds`
    //    （编译之后的现实），绝不取自 step 里"本来选了谁"的诊断字段。
    rawAttributes.selected_memory_ids = [...trace.selectedMemoryIds].join(',')
    rawAttributes.selected_count = trace.selectedMemoryIds.length
    if (typeof step.attributes.candidates === 'number') {
      rawAttributes.candidate_count = step.attributes.candidates
    }
  }
  if (stage === 'context' && typeof step.attributes.estimatedTokens === 'number') {
    rawAttributes.used_tokens = step.attributes.estimatedTokens
  }

  /*
   * step 的原始 attributes **不整体带过去**：它们里面有 M5 的扁平指标
   * （`candidates` / `decisionRecord` / `reachedContext` …），
   * 键名不在白名单的七类里。`projectAttributes` 只保留合规的，
   * 其余**报出来**（`filteredAttributeKeys`）—— 不许静默丢弃。
   */
  const attributes = projectAttributes(rawAttributes, filtered)

  const reasonCode = stepReasonCode(stage, step, trace)
  const durationMs = spanDurationMs(step)

  return {
    traceId: String(trace.traceId),
    spanId: canonicalSpanId(String(trace.traceId), stage, index + 1),
    parentSpanId: rootSpanId,
    stage,
    name: `character.${stage}`,
    status: step.status === 'failed' ? 'error' : 'ok',
    startedAt: step.startedAt,
    ...(step.finishedAt !== undefined ? { finishedAt: step.finishedAt } : {}),
    ...(reasonCode !== undefined ? { reasonCode } : {}),
    attributes: durationMs !== undefined ? { ...attributes, duration_ms: durationMs } : attributes,
    provenance: { character_trace: String(trace.traceId) },
  }
}

/**
 * **AT4.2 + AT4.4 的主入口**：真实一轮 → 规范 span 集合。
 *
 * 每一个产出的 span 都过一遍 `assertObservabilitySpan` —— 也就是说，
 * 阶段必须已登记、理由码必须属于该阶段、provenance 必须被该阶段允许、
 * 属性必须全在白名单里。任何一条不满足，这里就会抛，而不是把不合规的东西发出去。
 */
export function mapTraceToCanonicalSpans(trace: CharacterRunTrace): CanonicalSpanSet {
  const filtered: string[] = []
  const unmapped: string[] = []

  const root = buildRootSpan(trace, filtered)
  const spans: ObservabilitySpanInput[] = [root]
  trace.steps.forEach((step, index) => {
    const span = buildStepSpan(trace, step, index, root.spanId, filtered, unmapped)
    if (span !== undefined) spans.push(span)
  })

  for (const span of spans) assertObservabilitySpan(span)

  return {
    spans,
    unmappedStepKinds: [...new Set(unmapped)],
    filteredAttributeKeys: [...new Set(filtered)],
  }
}

/**
 * **AT4.3**：控制命令 → 规范 span。
 *
 * ⚠️ 控制命令**没有** `CharacterRunTrace`（WP3 的 Known Issue 1：
 *    `character_traces.input_event_id` 是 NOT NULL 且指向真实对话事件，
 *    给它编一个假引用就是 D-7 同形状的悬空证据）。
 *    因此它**自成一棵单 span 的 trace**，id 由 commandId 稳定派生。
 *    这正是 AT4.3 那句"不强制所有模块共用同一 ID"的落点：
 *    能**关联**（`provenance.control_command`），但不假装是同一条 trace。
 */
export function mapControlExecutionToCanonicalSpan(
  execution: ControlExecution
): ObservabilitySpanInput {
  const result = execution.result
  const traceKey = `control:${result.commandId}`
  const filtered: string[] = []
  const attributes = projectAttributes(
    {
      command_type: result.commandType,
      command_id: result.commandId,
      outcome: result.outcome,
      disposition: result.disposition,
      verification: result.verification,
      accepted: result.accepted,
      attempted: result.attempted,
      executed: result.executed,
      dry_run: result.dryRun,
      replayed: execution.replayed,
      ...(result.error !== undefined ? { error_code: result.error.code } : {}),
      ...(result.reasonCode !== undefined ? { reason_code: result.reasonCode } : {}),
      ...(execution.report !== undefined ? { metric_count: Object.keys(execution.report.metrics).length } : {}),
    },
    filtered
  )
  const durationMs = spanDurationMs(result)

  const span: ObservabilitySpanInput = {
    traceId: traceKey,
    spanId: canonicalSpanId(traceKey, 'developer_control', 0),
    stage: 'developer_control',
    name: 'character.developer_control',
    status: result.disposition === 'failed' ? 'error' : 'ok',
    startedAt: result.startedAt,
    ...(result.finishedAt !== undefined ? { finishedAt: result.finishedAt } : {}),
    ...(result.reasonCode !== undefined ? { reasonCode: result.reasonCode } : {}),
    provenance: { control_command: result.commandId },
    attributes: {
      ...attributes,
      ...(durationMs !== undefined ? { duration_ms: durationMs } : {}),
    },
  }
  assertObservabilitySpan(span)
  return span
}

/**
 * 规范 span → **既有 wire 形状**（`TelemetrySpan`）。
 *
 * 这一层是"分类法与既有导出之间**唯一**的桥"：
 *   · id 复用既有 `traceHexId` / `spanHexId`（wire 上必须是 16 位 hex，Phoenix 认这个）
 *   · 属性原样带过去（它们**已经**过了白名单）
 * 因此不存在"第二套编码"，也不存在"绕过白名单的旁路"。
 */
export function canonicalSpanToTelemetrySpan(
  span: ObservabilitySpanInput,
  index: number,
  wireTraceId?: string
): TelemetrySpan {
  // OTLP 的 trace_id 必须是 32 位 hex（16 字节）—— 由 `wireTraceHexId` 保证
  const hexTraceId = wireTraceId ?? wireTraceHexId(span.traceId)
  return {
    name: span.name,
    kind: span.stage === 'model' ? 'llm' : span.stage === ROOT_STAGE ? 'chain' : 'internal',
    traceId: hexTraceId,
    spanId: spanHexId(hexTraceId, span.name, index),
    ...(span.parentSpanId !== undefined && index > 0
      ? { parentSpanId: spanHexId(hexTraceId, span.name, 0) }
      : {}),
    startTimeMs: span.startedAt,
    ...(span.finishedAt !== undefined ? { endTimeMs: span.finishedAt } : {}),
    status: span.status,
    attributes: { ...span.attributes, stage: span.stage },
  }
}

/**
 * 一轮的规范 span 集合 → wire span 集合。
 *
 * `wireTraceId` 缺省时，每个 span 用 `memoryDigest(span.traceId)` 自己派生
 * （控制命令那棵树走这条路：它没有 `CharacterRunTrace`，id 由 commandId 稳定派生）。
 */
export function canonicalSpansToTelemetrySpans(
  spans: readonly ObservabilitySpanInput[],
  wireTraceId?: string
): TelemetrySpan[] {
  return spans.map((span, index) => canonicalSpanToTelemetrySpan(span, index, wireTraceId))
}

/**
 * **AT4.4 的量具**：span 里的事实必须与 trace 的实际一致。
 *
 * 返回**不一致项**（空数组 = 一致）。它与 `assertObservabilitySpan` 分工不同：
 * 后者查"span 自身合不合规"，这里查"它说的和真相一样吗"。
 *
 * 尤其是 `selected_memory_ids`：它必须等于 `trace.selectedMemoryIds`
 * ——**编译之后的现实**，而不是选择器本来想选的那些。
 */
export function spanTraceInconsistencies(
  spans: readonly ObservabilitySpanInput[],
  trace: CharacterRunTrace
): string[] {
  const problems: string[] = []
  const root = spans.find((span) => span.stage === ROOT_STAGE)
  if (root === undefined) {
    problems.push('没有 turn 根 span')
    return problems
  }
  if (root.provenance?.character_trace !== String(trace.traceId)) {
    problems.push(`根 span 的 provenance.character_trace=${String(root.provenance?.character_trace)} 与 trace 不符`)
  }
  if (root.attributes.status !== trace.status) {
    problems.push(`根 span status=${String(root.attributes.status)} 与 trace=${trace.status} 不符`)
  }
  if (root.attributes.step_count !== trace.steps.length) {
    problems.push(`根 span step_count=${String(root.attributes.step_count)} 与 trace=${trace.steps.length} 不符`)
  }
  if (root.attributes.selected_count !== trace.selectedMemoryIds.length) {
    problems.push(
      `根 span selected_count=${String(root.attributes.selected_count)} 与 trace=${trace.selectedMemoryIds.length} 不符`
    )
  }

  const recallSpan = spans.find((span) => span.stage === 'recall')
  if (recallSpan !== undefined) {
    const actual = String(recallSpan.attributes.selected_memory_ids ?? '')
    const expected = [...trace.selectedMemoryIds].join(',')
    if (actual !== expected) {
      problems.push(
        `recall span 的 selected_memory_ids=${JSON.stringify(actual)} 与 trace 的实际 ` +
          `${JSON.stringify(expected)} 不符 —— ` +
          '它必须报"编译之后真的进了上下文的那几条"，而不是选择器本来想选的那几条'
      )
    }
  }
  return problems
}
