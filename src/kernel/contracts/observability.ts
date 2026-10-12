/**
 * Observability Contract —— **统一既有 tracing，而不是建立第二套真相**
 * （M5.1 WP1 / AT1.3 + AT1.4）。
 *
 * ============================================================================
 *  这份契约只做三件事，而且刻意只做这三件
 * ============================================================================
 * ① **分类法**：把"一轮到底经过了哪些阶段"变成受控枚举（AT4.2），
 *    并给出 `TraceStepKind → stage` 的**唯一**映射。它不新增一条 trace，
 *    也不新增一个 span 生产者 —— 它只给既有事实一个共同的坐标系。
 *
 * ② **相关性**：让 `turnId / traceId / executionId / memoryDecisionId /
 *    controlCommandId` 可以被**关联**（AT4.3），而不强迫所有模块共用同一个 id
 *    （那会把"角色的一轮"与"开发者的一条命令"硬绑成同一件事，而它们不是）。
 *
 * ③ **敏感数据政策**：telemetry attributes 的 **key 级白名单**（AT1.4）。
 *
 * ---------------------------------------------------------------------------
 *  ⚠️ 与既有实现的分工（读这一节之前不要改任何东西）
 * ---------------------------------------------------------------------------
 *  业务真相      `CharacterRunTrace` + `character_traces`（**永远是权威**）
 *  观测端口      `src/infrastructure/telemetry/port.ts` 的 `TelemetryPort`
 *                （`noop` / `phoenix` 两个 adapter）—— **已经存在**，
 *                M5.1 **不新建第二个端口**（Repository Map F-7 的裁定）
 *  值级哨兵      `src/kernel/app/memory/memory-trace.ts` 的
 *                `assertNoMemoryContentInTrace` / `sensitiveTextsOf`
 *                —— 它回答"**值**里有没有正文"，**不删、不搬、不改**
 *  本文件        key 级白名单（"这个键名允不允许出现"）＋ 分类法 ＋ span 形状
 *
 *  两者是**不同的问题**，必须**同时**存在：
 *      key 级拦不住 `attributes.note = 她的原话`（键名合法，值里有正文）；
 *      值级拦不住 `attributes.api_key = "<一个我们不知道的密钥>"`（值不在敏感清单里）。
 *
 * ---------------------------------------------------------------------------
 *  ⚠️ `duration` 是**算出来的**，不是第二个字段
 * ---------------------------------------------------------------------------
 *  `start` / `end` / `duration` 三者只能有两个是独立的。把 duration 也存一份，
 *  迟早出现"start/end 说 12ms，duration 说 1200ms"——那种不一致不会报错，
 *  只会让某一次排查得出相反结论。
 */

import { KernelError, type Timestamp } from './ids.ts'
import { RECALL_EXCLUSION_REASONS } from './recall.ts'
import { CONTROL_REASON_CODES } from './developer-control.ts'
import { ACTION_FAILURE_CODES } from '../action/errors.ts'

export const OBSERVABILITY_SCHEMA_VERSION = 1

export const OBSERVABILITY_LIMITS = {
  /** 单个 span 的 attributes 键数上限 */
  maxAttributesPerSpan: 64,
  /** 单个 attribute 的**键名**长度上限 */
  maxAttributeKeyLength: 64,
  /** 单个 attribute 的字符串值长度上限（值与键是两件事，见 §AT1.4） */
  maxAttributeValueLength: 1024,
  /** 单个 span 允许挂的 provenance 条目上限 */
  maxProvenanceEntries: 8,
  /** `reason_code` 的长度上限 */
  maxReasonCodeLength: 64,
  /** span 标识长度上限（既有 `spanHexId()` 产出 16 位 hex，留足余量） */
  maxSpanIdLength: 64,
} as const

// ---------------------------------------------------------------------------
// AT4.2 —— Canonical Span Taxonomy
// ---------------------------------------------------------------------------

/**
 * 阶段枚举。
 *
 * 前八个来自计划书 AT4.2 点名的清单，后四个是 `recall` 的子阶段
 * （AT4.2 明写 "recall 可拥有 retrieve / eligibility / ranking / selection"）。
 */
export type ObservabilityStage =
  | 'turn'
  | 'context'
  | 'recall'
  | 'model'
  | 'policy'
  | 'action'
  | 'response'
  | 'developer_control'
  | 'retrieve'
  | 'eligibility'
  | 'ranking'
  | 'selection'

export const OBSERVABILITY_STAGES: readonly ObservabilityStage[] = [
  'turn',
  'context',
  'recall',
  'retrieve',
  'eligibility',
  'ranking',
  'selection',
  'model',
  'policy',
  'action',
  'response',
  'developer_control',
]

export function isObservabilityStage(value: unknown): value is ObservabilityStage {
  return typeof value === 'string' && (OBSERVABILITY_STAGES as readonly string[]).includes(value)
}

/**
 * provenance 种类。
 *
 * 每一种都对应一个**既有**的 id 来源（AT4.3 的五个关联键）。
 * ⚠️ 它刻意不叫 "correlationId"：那暗示"所有东西共用同一个 id"，
 *    而实际上"角色的一轮"（traceId）与"开发者的一条命令"（commandId）
 *    是不同的东西，只是**可以被关联**。
 */
export type ObservabilityProvenance =
  | 'character_trace'
  | 'recall_decision'
  | 'action_ledger'
  | 'control_command'
  | 'memory_integrity'

export const OBSERVABILITY_PROVENANCE_KINDS: readonly ObservabilityProvenance[] = [
  'character_trace',
  'recall_decision',
  'action_ledger',
  'control_command',
  'memory_integrity',
]

export interface ObservabilityProvenanceFact {
  kind: ObservabilityProvenance
  /** 它承载的 id 的名字（AT4.3 的关联键） */
  idField: string
  /** 权威所在（"这个 id 是谁发出来的"） */
  authority: string
}

export const OBSERVABILITY_PROVENANCE_FACTS: Readonly<
  Record<ObservabilityProvenance, ObservabilityProvenanceFact>
> = {
  character_trace: {
    kind: 'character_trace',
    idField: 'traceId',
    authority: 'character_traces（CharacterRunTrace）',
  },
  recall_decision: {
    kind: 'recall_decision',
    idField: 'memoryDecisionId',
    authority: 'kernel/recall/record.ts 的 RecallDecisionRecord',
  },
  action_ledger: {
    kind: 'action_ledger',
    idField: 'executionId',
    authority: 'character_action_events（ExecutionRecordView.actionId）',
  },
  control_command: {
    kind: 'control_command',
    idField: 'controlCommandId',
    authority: 'kernel/contracts/developer-control.ts 的 ControlCommand.commandId',
  },
  memory_integrity: {
    kind: 'memory_integrity',
    idField: 'memoryId',
    authority: 'infrastructure/persistence/memory-integrity.ts 的探针结果',
  },
}

export interface ObservabilityStageFact {
  stage: ObservabilityStage
  /** 子阶段挂父阶段（`recall` 的四个子阶段）。根阶段没有 parent */
  parent?: ObservabilityStage
  /**
   * **谁产出这个阶段的 span**。
   *
   * **空字符串被拒绝** —— 与 M5 的 `RECALL_EXCLUSION_REASON_FACTS` /
   * `RECALL_CHANNEL_FACTS` 是同一条纪律：本项目最贵的缺陷形状之一是
   * "枚举里有一个值，但永远没有任何东西产出它"。
   */
  source: string
  /**
   * 该阶段允许出现的 `reason_code`。
   *
   * 一律引用**既有的受控词汇**（M5 的排除理由 / M4.5 的失败码 / 本里程碑的控制理由码）。
   * **空数组 = 该阶段今天还没有受控理由词汇** —— 此时任何理由码都会被拒绝（fail closed），
   * WP4 想 emit 必须先回来登记（见 `stagesWithoutReasonCodes()`）。
   */
  reasonCodes: readonly string[]
  /** 该阶段允许挂哪些 provenance */
  provenanceRefs: readonly ObservabilityProvenance[]
}

/**
 * 阶段登记表。
 *
 * `reasonCodes` 一律**引用既有的受控词汇**，一个都不另造：
 *   · recall / retrieve / eligibility / ranking / selection → M5 的 `RECALL_EXCLUSION_REASONS`
 *   · action / policy                                     → M4.5 的 `ACTION_FAILURE_CODES`
 *   · developer_control                                   → 本里程碑的 `CONTROL_REASON_CODES`
 *   · turn / context / model / response                   → **空**（今天没有受控词汇）
 *
 * ⚠️ 空数组是**刻意的**，不是遗漏：`assertObservabilitySpan` 会拒绝任何未登记的理由码，
 *    所以 WP4 想 emit 一个新理由码时，**必须先在契约层登记它**。
 *    `stagesWithoutReasonCodes()` 会把这些阶段如实列出来 ——
 *    "这个阶段今天说不出理由"是要被看见的事实，而不是被一个编出来的码糊过去。
 */
export const OBSERVABILITY_STAGE_FACTS: Readonly<Record<ObservabilityStage, ObservabilityStageFact>> = {
  turn: {
    stage: 'turn',
    source: 'kernel/app/turn-gateway.ts（beginTurn / completeTurn / turn_summary step）',
    // WP4：真实生产者 = `infrastructure/telemetry/taxonomy.ts` 的 mapper（trace.status === 'failed' 时）
    reasonCodes: ['turn_failed'],
    provenanceRefs: ['character_trace'],
  },
  context: {
    stage: 'context',
    source: 'kernel/app/turn-gateway.ts 的 context_compile step + kernel/context/sections.ts',
    // WP4：真实生产者 = mapper（trace.droppedSectionIds 非空时）
    reasonCodes: ['section_dropped'],
    provenanceRefs: ['character_trace', 'recall_decision'],
  },
  recall: {
    stage: 'recall',
    source: 'kernel/app/turn-gateway.ts 的 memory_recall step（M5 WP6）',
    reasonCodes: RECALL_EXCLUSION_REASONS,
    provenanceRefs: ['character_trace', 'recall_decision'],
  },
  retrieve: {
    stage: 'retrieve',
    parent: 'recall',
    source: 'kernel/recall/ports.ts 的 MemoryRetrievalPort（适配器 memory-retrieval-store.ts）',
    reasonCodes: RECALL_EXCLUSION_REASONS,
    provenanceRefs: ['recall_decision'],
  },
  eligibility: {
    stage: 'eligibility',
    parent: 'recall',
    source: 'kernel/recall/eligibility.ts 的 evaluateEligibility',
    reasonCodes: RECALL_EXCLUSION_REASONS,
    provenanceRefs: ['recall_decision', 'memory_integrity'],
  },
  ranking: {
    stage: 'ranking',
    parent: 'recall',
    source: 'kernel/recall/ranking.ts 的 rankCandidates',
    reasonCodes: RECALL_EXCLUSION_REASONS,
    provenanceRefs: ['recall_decision'],
  },
  selection: {
    stage: 'selection',
    parent: 'recall',
    source: 'kernel/recall/selector.ts 的 selectMemoryContext + kernel/recall/record.ts 的 applyContextReality',
    reasonCodes: RECALL_EXCLUSION_REASONS,
    provenanceRefs: ['recall_decision', 'character_trace'],
  },
  model: {
    stage: 'model',
    source: 'kernel/app/turn-gateway.ts 的 model_generate / model_call step + infrastructure/runtime/adapters.ts',
    // WP4：真实生产者 = mapper（对应的 step.status === 'failed' 时）
    reasonCodes: ['model_step_failed'],
    provenanceRefs: ['character_trace'],
  },
  policy: {
    stage: 'policy',
    source: 'kernel/action/policy.ts（判定结论经 action_dispatch step 的 attributes 映射）',
    reasonCodes: ACTION_FAILURE_CODES,
    provenanceRefs: ['action_ledger', 'character_trace'],
  },
  action: {
    stage: 'action',
    source: 'kernel/action/gateway.ts + kernel/app/turn-gateway.ts 的 action_dispatch / intent_create / intent_resolve step',
    reasonCodes: ACTION_FAILURE_CODES,
    provenanceRefs: ['action_ledger', 'character_trace'],
  },
  response: {
    stage: 'response',
    source: 'kernel/app/turn-gateway.ts 的 output_validate / conversation_persist_output / transport_deliver step',
    // WP4：真实生产者 = mapper（output_validate step.status === 'failed' 时）
    reasonCodes: ['output_validation_failed'],
    provenanceRefs: ['character_trace'],
  },
  developer_control: {
    stage: 'developer_control',
    source: 'WP3 Control API（ControlResult → span；今天尚无产出者，属 WP4 接线）',
    reasonCodes: CONTROL_REASON_CODES,
    provenanceRefs: ['control_command', 'character_trace'],
  },
}

/** 阶段登记表自洽性（模块加载与测试里都跑） */
export function assertObservabilityRegistryConsistent(): void {
  for (const stage of OBSERVABILITY_STAGES) {
    const fact = OBSERVABILITY_STAGE_FACTS[stage]
    if (fact === undefined) {
      throw new KernelError(
        'validation_error',
        'observability_stage_fact_missing',
        `阶段 ${stage} 在枚举里，却没有登记事实`
      )
    }
    if (fact.source.trim() === '') {
      throw new KernelError(
        'validation_error',
        'observability_stage_without_source',
        `阶段 ${stage} 没有登记生产者：那它就是一个"表达得了但永远出不来的"死值`
      )
    }
    if (fact.parent !== undefined && !isObservabilityStage(fact.parent)) {
      throw new KernelError(
        'validation_error',
        'observability_stage_bad_parent',
        `阶段 ${stage} 的 parent ${String(fact.parent)} 不是已登记的阶段`
      )
    }
    if (fact.parent === stage) {
      throw new KernelError(
        'validation_error',
        'observability_stage_self_parent',
        `阶段 ${stage} 不能是自己的父阶段`
      )
    }
  }
}

assertObservabilityRegistryConsistent()

/**
 * `TraceStepKind → stage` 的**唯一**映射。
 *
 * ⚠️ 两件事决定了它必须写成"查表 + 兜底"而不是穷尽的 `Record`：
 *   ① `TraceStepKind` 末尾有 `| (string & {})` 逃生口（`contracts/trace.ts:107`），
 *      于是它在类型上**不可能**被穷尽；
 *   ② 逃生口是**既有设计**，去掉它要动 `contracts/trace.ts` 并连带
 *      `m3:verify` + `m3.5:verify` + `eval:telemetry` + `eval:otlp` 四条门（AGENTS §5）。
 * 因此：已知字面量给出确定映射，未知字符串返回 `'unknown'`（**不抛错**）——
 * 一条未知 step 不该让整轮 trace 失败，"它没被分类"本身才是要报告的事实。
 */
export const TRACE_STEP_STAGE: Readonly<Partial<Record<string, ObservabilityStage>>> = {
  message_normalize: 'turn',
  actor_resolve: 'turn',
  conversation_persist_input: 'turn',
  turn_summary: 'turn',
  observation_adapt: 'turn',
  identity_load: 'context',
  context_compile: 'context',
  memory_recall: 'recall',
  /*
   * M5.5（ADR-045 `D-15`/`A6`）：外部证据**映射到既有的 `context` 阶段**，
   * 不新增第 13 个观测阶段 —— `OBSERVABILITY_STAGES.length === 12` 是 M5.1 门的
   * 机器判据，改它就等于重开 M5.1。语义上它也确实属于"上下文是怎么组装的"。
   */
  external_evidence: 'context',
  /*
   * 实用能力加装：**当轮内容**（计算 / 文档 / 网页正文 / OCR）的注入结局也用既有的
   * `context` 阶段（理由与 `external_evidence` / `affect_context` / `belief_context` 同：
   * 不为一个新 step kind 新开第 13 个阶段 —— `OBSERVABILITY_STAGES.length === 12`
   * 是 M5.1 门的机器判据）。语义上它确实属于"上下文是怎么组装的"：
   * 它记的是"程序实际取得的正文里，哪一部分真的入了模"。
   */
  turn_content: 'context',
  /*
   * M6.1 WP4 / ADR-055 `D-55e`：**记录状态行的结局** 也用既有的 `recall` 阶段
   * （理由与 `external_evidence` 那条相同：不为一个新 step kind 新开第 13 个阶段）。
   * 语义上它确实属于"召回发生了什么"——它就是召回结果对模型可见性的那一句。
   */
  memory_record_status: 'recall',
  /*
   * M6.1 WP4 / ADR-055 `D-55g`：**回复守卫的观测三态** 映射到既有的 `response` 阶段。
   * 语义上它就是"我们对输出做了什么校验"（`output_validate` 的同一条链），
   * 因此不为它新开阶段，也不改既有的 `output_validate` 映射。
   */
  reply_guard: 'response',
  /*
   * M8 / ADR-066 §6.3（WP6 任务 7）：同轮情绪评估的五步观测映射到既有的
   * `turn` 阶段——它们发生在 beginTurn 之后、compileTurn 之前，语义上就是
   * "这一轮的轮内处理"。不为它们新开第 13 个阶段（`OBSERVABILITY_STAGES.length
   * === 12` 是 M5.1 门的机器判据，先例：external_evidence / memory_record_status）。
   */
  affect_eligibility: 'turn',
  affect_proposal: 'turn',
  affect_validation: 'turn',
  affect_event: 'turn',
  affect_projection: 'turn',
  /*
   * M8：注入块结局映射到既有的 `context` 阶段——它写的是"编译器之后的事实"
   * （section 入模/被裁/缺席），与 external_evidence 同一条纪律。
   */
  affect_context: 'context',
  /*
   * M9 / WP7：信念注入块结局映射到既有的 `context` 阶段——与 affect_context
   * 同一条纪律（"编译器之后的事实"），不为它新开阶段。
   */
  belief_context: 'context',
  /*
   * M9.1 / ADR-072 `D-20`：撤销遮蔽判定映射到既有的 `context` 阶段——
   * 它发生在 compileTurn 内、任何消费者之前（D15），语义上就是
   * "上下文是怎么组装的"的一部分。不为它新开第 13 个阶段
   * （`OBSERVABILITY_STAGES.length === 12` 是 M5.1 门的机器判据，
   * 先例：external_evidence / memory_record_status / belief_context）。
   */
  withdrawn_masking: 'context',
  /*
   * M10 / WP7b：目标域的五步观测映射到既有的 `turn` 与 `context` 两个阶段——
   * 前四步发生在"这一轮的目标理解与写入"期间，语义上就是轮内处理；
   * 最后一步写的是"编译器之后的事实"（section 入模/被裁/缺席），与
   * affect_context / belief_context 同一条纪律。
   *
   * ⚠️ 不为它们新开第 13 个阶段（`OBSERVABILITY_STAGES.length === 12` 是 M5.1 门的
   *    机器判据，先例：external_evidence / memory_record_status / belief_context /
   *    affect_* / withdrawn_masking）。
   *
   * ⚠️ 五步的**载荷里不许有正文**（§6）：只带操作名、拒绝码、计数与 id。
   *    这一点由 `m10:observability:verify` 的 `R` 组从**类型**上钉住
   *    （读的是本文件的步骤名与 M10 各层的 reading 类型，不是靠约定）。
   */
  goal_eligibility: 'turn',
  goal_proposal: 'turn',
  goal_validation: 'turn',
  goal_event: 'turn',
  goal_context: 'context',
  /*
   * M11 / WP8：行为策略块的注入步。
   * ⚠️ 只**追加**一条 kind→stage 映射，**不**新开阶段（12 阶段冻结是 M5.1 门的判据）。
   */
  adaptive_self_context: 'context',
  model_generate: 'model',
  model_call: 'model',
  intent_create: 'action',
  intent_resolve: 'action',
  action_dispatch: 'action',
  output_validate: 'response',
  conversation_persist_output: 'response',
  transport_deliver: 'response',
}

export function stageOfTraceStepKind(kind: string): ObservabilityStage | 'unknown' {
  return TRACE_STEP_STAGE[kind] ?? 'unknown'
}

/** 今天**没有**任何 `TraceStepKind` 映射到它们的阶段（如实列出，不假装都有人用） */
export function unstagedObservabilityStages(): ObservabilityStage[] {
  const staged = new Set(Object.values(TRACE_STEP_STAGE))
  return OBSERVABILITY_STAGES.filter((stage) => !staged.has(stage))
}

/**
 * 今天**说不出理由码**的阶段（`reasonCodes` 为空）。
 *
 * 这不是缺陷，是**如实**：一个还没有受控理由词汇的阶段，
 * 比一个"编了几个看起来很像的理由码"的阶段更可信。
 * WP4 要给某个阶段加理由码时，先在这里登记 —— 否则 `assertObservabilitySpan` 会拒绝它。
 */
export function stagesWithoutReasonCodes(): ObservabilityStage[] {
  return OBSERVABILITY_STAGES.filter(
    (stage) => OBSERVABILITY_STAGE_FACTS[stage].reasonCodes.length === 0
  )
}

export function describeObservabilityStage(stage: ObservabilityStage): string {
  const fact = OBSERVABILITY_STAGE_FACTS[stage]
  return (
    `${stage}${fact.parent !== undefined ? `（${fact.parent} 的子阶段）` : ''}` +
    ` ← ${fact.source}`
  )
}

// ---------------------------------------------------------------------------
// Span 形状（AT1.3）
// ---------------------------------------------------------------------------

export type ObservabilitySpanStatus = 'ok' | 'error' | 'unset'

export interface ObservabilitySpanInput {
  traceId: string
  spanId: string
  parentSpanId?: string
  stage: ObservabilityStage
  /** 人类可读名（既有 `TelemetrySpan.name`）。**不含正文** */
  name: string
  status: ObservabilitySpanStatus
  startedAt: Timestamp
  finishedAt?: Timestamp
  reasonCode?: string
  /**
   * 关联信息：AT4.3 的五个键按种类挂在下面。
   *
   * 刻意是 `Partial<Record<...>>` —— "不强制所有模块共享同一 ID"是计划书的原话；
   * 一个只读了 trace 的 span 不该被要求也去编一个 commandId。
   */
  provenance?: Partial<Record<ObservabilityProvenance, string>>
  attributes: Readonly<Record<string, string | number | boolean>>
}

/**
 * `duration` 的**唯一**算法。
 *
 * 未结束 / 时间倒退 / 非有限数 → 缺省（而不是 0 或负数）：
 * "不知道花了多久"与"花了 0 毫秒"是两件事。
 */
export function spanDurationMs(span: Pick<ObservabilitySpanInput, 'startedAt' | 'finishedAt'>): number | undefined {
  if (span.finishedAt === undefined) return undefined
  if (!Number.isFinite(span.startedAt) || !Number.isFinite(span.finishedAt)) return undefined
  if (span.finishedAt < span.startedAt) return undefined
  return span.finishedAt - span.startedAt
}

/** AT4.3：把 span 的关联键摊平（供 trace 属性 / 证据文件用）。**不含正文** */
export function correlationOf(span: ObservabilitySpanInput): Record<string, string> {
  const out: Record<string, string> = { traceId: span.traceId }
  for (const [kind, value] of Object.entries(span.provenance ?? {})) {
    if (value === undefined) continue
    const fact = OBSERVABILITY_PROVENANCE_FACTS[kind as ObservabilityProvenance]
    if (fact === undefined) continue
    out[fact.idField] = String(value)
  }
  return out
}

/**
 * span 一致性断言。
 *
 * 守八件事：标识非空且有界 / 父子不自环 / 阶段已登记 / 状态受控 /
 * 理由码已登记且**属于该阶段** / provenance 键已登记 / attributes 过白名单 / 时间自洽。
 */
export function assertObservabilitySpan(span: ObservabilitySpanInput): void {
  assertIdentifier(span.traceId, 'traceId', OBSERVABILITY_LIMITS.maxSpanIdLength)
  assertIdentifier(span.spanId, 'spanId', OBSERVABILITY_LIMITS.maxSpanIdLength)
  if (span.parentSpanId !== undefined) {
    assertIdentifier(span.parentSpanId, 'parentSpanId', OBSERVABILITY_LIMITS.maxSpanIdLength)
    if (span.parentSpanId === span.spanId) {
      throw new KernelError(
        'validation_error',
        'observability_span_self_parent',
        `span ${span.spanId} 的 parentSpanId 等于它自己 —— 这会让 trace 树无法遍历`
      )
    }
  }
  if (!isObservabilityStage(span.stage)) {
    throw new KernelError(
      'validation_error',
      'observability_unknown_stage',
      `未登记的阶段 ${String(span.stage)}：阶段是受控枚举，不是自由字符串`
    )
  }
  if (span.status !== 'ok' && span.status !== 'error' && span.status !== 'unset') {
    throw new KernelError(
      'validation_error',
      'observability_bad_status',
      `span.status 必须是 ok / error / unset，收到 ${String(span.status)}`
    )
  }
  assertSpanTime(span)

  const fact = OBSERVABILITY_STAGE_FACTS[span.stage]
  if (span.reasonCode !== undefined) {
    if (span.reasonCode.trim() === '') {
      throw new KernelError(
        'validation_error',
        'observability_empty_reason_code',
        `阶段 ${span.stage} 的 reasonCode 不能是空字符串`
      )
    }
    if (span.reasonCode.length > OBSERVABILITY_LIMITS.maxReasonCodeLength) {
      throw new KernelError(
        'validation_error',
        'observability_reason_code_too_long',
        `reasonCode 超过 ${OBSERVABILITY_LIMITS.maxReasonCodeLength} 字符上限`
      )
    }
    if (!fact.reasonCodes.includes(span.reasonCode)) {
      throw new KernelError(
        'validation_error',
        'observability_reason_code_not_registered',
        `阶段 ${span.stage} 没有登记理由码 ${String(span.reasonCode)}。` +
          `该阶段已登记：${fact.reasonCodes.join(', ') || '(无)'}。` +
          '未登记的理由码会在面板上永远筛不出来 —— 那是"表达得了但永远触发不了"的同一种形状'
      )
    }
  }

  const provenanceKeys = Object.keys(span.provenance ?? {})
  if (provenanceKeys.length > OBSERVABILITY_LIMITS.maxProvenanceEntries) {
    throw new KernelError(
      'validation_error',
      'observability_too_many_provenance',
      `provenance 条目超过 ${OBSERVABILITY_LIMITS.maxProvenanceEntries} 条上限`
    )
  }
  for (const key of provenanceKeys) {
    if (!OBSERVABILITY_PROVENANCE_KINDS.includes(key as ObservabilityProvenance)) {
      throw new KernelError(
        'validation_error',
        'observability_unknown_provenance',
        `未登记的 provenance 种类 ${key}。已登记：${OBSERVABILITY_PROVENANCE_KINDS.join(', ')}`
      )
    }
    if (!fact.provenanceRefs.includes(key as ObservabilityProvenance)) {
      throw new KernelError(
        'validation_error',
        'observability_provenance_not_allowed',
        `阶段 ${span.stage} 不允许挂 provenance.${key}（已允许：${fact.provenanceRefs.join(', ') || '(无)'}）`
      )
    }
  }

  assertTelemetryAttributesAllowed(span.attributes)
}

function assertIdentifier(value: unknown, what: string, maxLength: number): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new KernelError(
      'validation_error',
      'observability_empty_identifier',
      `${what} 必须是非空字符串`
    )
  }
  if (value.length > maxLength) {
    throw new KernelError(
      'validation_error',
      'observability_identifier_too_long',
      `${what} 超过 ${maxLength} 字符上限`
    )
  }
}

function assertSpanTime(span: Pick<ObservabilitySpanInput, 'startedAt' | 'finishedAt'>): void {
  if (span.startedAt !== undefined && !Number.isFinite(span.startedAt)) {
    throw new KernelError(
      'validation_error',
      'observability_bad_start_time',
      `startedAt 必须是有限数，收到 ${String(span.startedAt)}`
    )
  }
  if (span.finishedAt !== undefined) {
    if (!Number.isFinite(span.finishedAt)) {
      throw new KernelError(
        'validation_error',
        'observability_bad_end_time',
        `finishedAt 必须是有限数，收到 ${String(span.finishedAt)}`
      )
    }
    if (span.finishedAt < span.startedAt) {
      throw new KernelError(
        'validation_error',
        'observability_end_before_start',
        `finishedAt (${span.finishedAt}) 早于 startedAt (${span.startedAt}) —— ` +
          '时间倒退会让 duration 变成一个没有意义的数，而不是爆一个错'
      )
    }
  }
}

// ---------------------------------------------------------------------------
// AT1.4 —— 敏感数据政策（**key 级**白名单）
// ---------------------------------------------------------------------------

/**
 * 显式的允许键名单。
 *
 * 计划书 AT1.4 的允许集合是：IDs / counts / durations / status / reason codes /
 * budget / model·provider identifiers。这张表就是它的逐字落地。
 */
export const TELEMETRY_ATTRIBUTE_ALLOWLIST: readonly string[] = [
  // --- IDs（只记引用，不记内容）---
  'trace_id',
  'span_id',
  'parent_span_id',
  'turn_id',
  'conversation_id',
  'character_id',
  'user_id',
  'runtime_id',
  'action_id',
  'command_id',
  'memory_id',
  'job_id',
  'intent_id',
  'observation_id',
  'domain_event_id',
  'input_event_id',
  'output_event_id',
  'decision_id',
  'capability',
  'operation',
  'command_type',
  'surface',
  // --- counts ---
  'count',
  'total',
  'candidate_count',
  'selected_count',
  'dropped_count',
  'step_count',
  'section_count',
  'excluded_count',
  // --- durations / time ---
  'duration_ms',
  'started_at',
  'finished_at',
  'elapsed_ms',
  // --- status / reason codes ---
  'stage',
  'status',
  'reason_code',
  'error_code',
  'severity',
  'outcome',
  'disposition',
  'verification',
  'attempted',
  'executed',
  'verified',
  'accepted',
  'dry_run',
  'idempotent_replay',
  'side_effect',
  'risk_level',
  // --- budget / identifiers ---
  'budget_tokens',
  'used_tokens',
  'input_tokens_count',
  'output_tokens_count',
  'model_id',
  'model_profile',
  'provider',
  'seed_version',
  'schema_version',
  'reducer_version',
  'processor_version',
  // --- WP4：既有 wire 键 `projection.revision.start/end` 的规范等价物 ---
  //     它们是**版本号映射**（投影 → revision），不是任意文本；
  //     值仍然受长度上限保护（见 assertTelemetryAttributesAllowed）。
  'projection_revision_start',
  'projection_revision_end',
]

/**
 * 允许的**后缀**模式（AT1.4 的 "IDs / counts / durations" 那几类天然是后缀族）。
 *
 * ⚠️ 模式只在"敏感段检查通过"之后才生效（见 `isTelemetryAttributeAllowed`）——
 *    否则 `api_key_id` 这类键会因为 `_id` 后缀而被放行。
 */
export const TELEMETRY_ATTRIBUTE_PATTERNS: readonly string[] = [
  '_id',
  '_ids',
  '_count',
  '_counts',
  '_ms',
  '_tokens',
  '_status',
  '_version',
  '_code',
  '_at',
  '_kind',
  '_level',
  /**
   * WP4 补入：`observation_type` / `intent_type` 这类**受控标签**。
   * 它们与 `_status` 同类（枚举标签，不是内容）；
   * 而 `credential_type` 这类仍然会被敏感段规则拦下（`credential` 优先）。
   */
  '_type',
]

/**
 * 敏感的**键名段**（用 `_` 切分后逐段比对）。
 *
 * 这是与"允许后缀"**对抗**的一道闸，而且它**优先**：
 * `attributes.api_key_id` 的键名段是 `['api','key','id']` → 命中 `key` → 拒绝。
 *
 * ⚠️ 刻意**不含** `memory` / `user` / `character` 这些词：
 *    `memory_id` / `user_id` 是合法的 ID，把它们一刀切会让整个白名单不可用。
 *    "值里有没有记忆正文"是**另一个问题**，由既有值级哨兵
 *    `assertNoMemoryContentInTrace` 负责（本文件不重复实现它）。
 */
export const SENSITIVE_ATTRIBUTE_KEY_SEGMENTS: readonly string[] = [
  'api',
  'apikey',
  'key',
  'keys',
  'secret',
  'secrets',
  'token',
  'password',
  'passwd',
  'credential',
  'credentials',
  'authorization',
  'auth',
  'bearer',
  'cookie',
  'session',
  'prompt',
  'prompts',
  'content',
  'contents',
  'body',
  'text',
  'message',
  'messages',
  'raw',
  'payload',
  'transcript',
  'utterance',
  'speech',
]

export function sensitiveSegmentsOf(key: string): string[] {
  return key
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((segment) => segment !== '')
    .filter((segment) => SENSITIVE_ATTRIBUTE_KEY_SEGMENTS.includes(segment))
}

export function isSensitiveAttributeKey(key: string): boolean {
  return sensitiveSegmentsOf(key).length > 0
}

/**
 * 判定一个 attribute 键是否允许。
 *
 * **顺序即不变量**：
 *   ① 键名长度有界
 *   ② **敏感段优先**：命中即拒（fail closed）
 *   ③ 显式白名单
 *   ④ 后缀模式
 *   ⑤ 其余一律拒绝（默认拒绝，不是默认允许）
 */
export function isTelemetryAttributeAllowed(key: string): boolean {
  if (typeof key !== 'string' || key.trim() === '') return false
  if (key.length > OBSERVABILITY_LIMITS.maxAttributeKeyLength) return false
  if (isSensitiveAttributeKey(key)) return false
  const lower = key.toLowerCase()
  if (TELEMETRY_ATTRIBUTE_ALLOWLIST.includes(lower)) return true
  return TELEMETRY_ATTRIBUTE_PATTERNS.some((suffix) => lower.endsWith(suffix))
}

/**
 * 校验一组 attributes。
 *
 * ⚠️ 抛错信息里**只出现键名，绝不出现值**。
 *    否则这个守卫本身就成了泄漏点："它拒绝把 api_key 发出去，
 *    但是在异常消息里把 api_key 的值完整打了出来。"
 *    ——这一条有一条专门的测试（量具自检）。
 */
export function assertTelemetryAttributesAllowed(
  attributes: Readonly<Record<string, string | number | boolean>>
): void {
  const keys = Object.keys(attributes)
  if (keys.length > OBSERVABILITY_LIMITS.maxAttributesPerSpan) {
    throw new KernelError(
      'validation_error',
      'telemetry_too_many_attributes',
      `attributes 键数超过 ${OBSERVABILITY_LIMITS.maxAttributesPerSpan} 上限（收到 ${keys.length}）`
    )
  }

  const deniedSensitive = keys.filter((key) => isSensitiveAttributeKey(key))
  if (deniedSensitive.length > 0) {
    throw new KernelError(
      'validation_error',
      'telemetry_sensitive_attribute',
      `telemetry attributes 里出现了敏感键名：${deniedSensitive.join(', ')}。` +
        '计划书 AT1.4：默认不得记录 raw memory / full prompt / credential / API key / secret。' +
        '（只报告键名，不回显任何取值）'
    )
  }

  const notAllowed = keys.filter((key) => !isTelemetryAttributeAllowed(key))
  if (notAllowed.length > 0) {
    throw new KernelError(
      'validation_error',
      'telemetry_attribute_not_allowed',
      `telemetry attributes 里出现了不在白名单里的键：${notAllowed.join(', ')}。` +
        '默认拒绝而不是默认允许 —— 加一个字段时要显式说明它为什么不是正文'
    )
  }

  for (const key of keys) {
    const value = attributes[key]
    if (typeof value === 'string' && value.length > OBSERVABILITY_LIMITS.maxAttributeValueLength) {
      throw new KernelError(
        'validation_error',
        'telemetry_attribute_value_too_long',
        `attribute ${key} 的字符串值超过 ${OBSERVABILITY_LIMITS.maxAttributeValueLength} 字符 —— ` +
          '长文本会随遥测**外发且不可撤回**'
      )
    }
  }
}

/** 供文档与 UI 共用的一句人话（`--help` / 开发者页面直接用它） */
export function describeSensitiveDataPolicy(): string {
  return (
    'Telemetry attributes 默认**只**允许：IDs / counts / durations / status / reason codes / ' +
    'budget / model·provider identifiers（`TELEMETRY_ATTRIBUTE_ALLOWLIST` + `TELEMETRY_ATTRIBUTE_PATTERNS`）。' +
    '默认**拒绝**：raw memory / full prompt / credential / API key / secret ' +
    '（`SENSITIVE_ATTRIBUTE_KEY_SEGMENTS`，且它优先于允许规则）。' +
    '键级白名单不代替值级哨兵 —— 值里有没有正文仍由 `assertNoMemoryContentInTrace` 把关。'
  )
}

// ---------------------------------------------------------------------------
// WP4：既有 wire 键名 与 规范键名 的**有限**差距（AT4.1 的实测产物）
// ---------------------------------------------------------------------------

/**
 * 既有导出路径（`infrastructure/telemetry/phoenix.ts`）用的是**点号**键名
 * （`character.id` / `context.section.ids` / …），而本契约的白名单是**下划线**规范名
 * （`character_id` / `context_section_ids` / …）。
 *
 * 这是 M5.1 WP4 清点既有 OTLP 时**实测到**的第一件事，而且是必须说清的一件事：
 *   · 它不是"两套真相"（两边都从同一份 `CharacterRunTrace` 派生），
 *     但它是**两套命名**，而两套命名迟早会漂移。
 *   · 直接按规范白名单去拒既有 payload 会把真实遥测全部拦下
 *     （`verify-telemetry.ts` 的 50 余条断言钉的就是点号名）。
 *   · 重命名 wire 键是**破坏性变更**（Phoenix 面板与既有断言都会碎）——
 *     属于独立里程碑，不属于 M5.1。
 *
 * 于是这里把它变成一个**有限、可断言**的东西：一张别名表。
 * `assertTelemetryAttributesAllowed` 会先看规范名，再看这张表；
 * 而 `scripts/kernel-tests-dev-plane.ts` 有一条断言要求
 * **每个别名的目标都必须是白名单里的规范名**（别名不许变成后门）。
 *
 * 退出路径（写进 ADR-036）：把 wire 键迁到规范名并删掉这张表。
 */
export const TELEMETRY_LEGACY_ATTRIBUTE_ALIASES: Readonly<Record<string, string>> = {
  'character.id': 'character_id',
  'input.event.id': 'input_event_id',
  'output.event.id': 'output_event_id',
  'context.compiler.version': 'context_compiler_version',
  'context.section.ids': 'context_section_ids',
  'context.dropped.sections': 'context_dropped_section_ids',
  'domain.event.count': 'domain_event_count',
  'projection.revision.start': 'projection_revision_start',
  'projection.revision.end': 'projection_revision_end',
  'model.profile': 'model_profile',
  'observation.id': 'observation_id',
  'observation.type': 'observation_type',
  'intent.id': 'intent_id',
  'intent.type': 'intent_type',
}

/**
 * 既有 payload 里**落在 AT1.4 允许类别之外**的键 —— 刻意只有这三个，
 * 而且它们被**钉住**（`scripts/kernel-tests-dev-plane.ts` 断言这个集合不许增长）。
 *
 *   `error.message`   自由文本，**唯一真正有风险的一个**。`contracts/trace.ts`
 *                     承诺它"不含正文"，但它是**无界**的：任何上游把一段带内容的
 *                     错误文本塞进 `trace.error`，它就会被原样外发，
 *                     而外发**不可撤回**。
 *                     ⚠️ 实测：这个键**连敏感段规则都过不了**（`message` 是敏感段），
 *                     也就是说它在今天的 payload 里能出去，正是因为
 *                     **既有导出路径根本没有过白名单**。这一条是 WP4 最该修的边界。
 *   `step.label`      人类可读的一句中文标签（如"组装上下文"）。由代码写死、
 *                     不来自用户，因此不构成泄漏面，但也不属于 AT1.4 的七类。
 *   `span.kind.source`  span 的代码常量名（如 `context_compile`）。同样的理由。
 *
 * 处置建议（写进 ADR-036 与 WP4 handoff）：规范路径只发
 * `has_error` + `error_length`（已经在做）；给既有路径补一个 `error_code`
 * 并停发自由文本，属独立里程碑（会改既有面板与断言）。
 */
export const TELEMETRY_LEGACY_KEYS_OUTSIDE_POLICY: readonly string[] = [
  'error.message',
  'step.label',
  'span.kind.source',
]

export function isLegacyAttributeOutsidePolicy(key: string): boolean {
  return TELEMETRY_LEGACY_KEYS_OUTSIDE_POLICY.includes(key)
}

/** 一个键在白名单里的判定：规范名 → 别名 → 拒绝（敏感段始终优先，别名救不了它） */
export function isTelemetryAttributeAllowedIncludingLegacy(key: string): boolean {
  if (isTelemetryAttributeAllowed(key)) return true
  if (isSensitiveAttributeKey(key)) return false
  return TELEMETRY_LEGACY_ATTRIBUTE_ALIASES[key] !== undefined
}
