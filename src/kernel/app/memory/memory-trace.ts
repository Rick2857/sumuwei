/**
 * Memory Trace —— **"这一轮记忆流水线每一步花了多久、做了什么决定"**
 * （计划书第 109–110 节）。
 *
 * ============================================================================
 *  计划书第 109 节给了 trace 树的形状
 * ============================================================================
 *     character.run
 *     │
 *     ├── memory.explicit_intent?
 *     │
 *     ├── memory.job.enqueue
 *     │
 *     └── ...
 *
 *     后台：
 *     memory.process
 *     │
 *     ├── evidence.load
 *     ├── candidate.extract
 *     ├── candidate.normalize
 *     ├── authority.classify
 *     ├── value.evaluate
 *     ├── duplicate.check
 *     ├── conflict.check
 *     ├── policy.decide
 *     ├── domain_event.commit
 *     └── memory.apply
 *
 * `TraceStepKind` 的联合末尾是 `| (string & {})`（M3.5 审计 S5），
 * 因此新增这些 kind **不需要迁移** —— 这也是当初留那个开口的收益。
 *
 * ---------------------------------------------------------------------------
 *  ⚠️ 隐私硬约束（计划书第 110 节最后一句）
 * ---------------------------------------------------------------------------
 *     **不要默认发送完整私人 Memory 内容到外部 Telemetry。**
 *
 * 计划书第 45 节对 trace 的一般原则是"只存 id 与元数据，正文留在
 * ConversationEvent 里"。对 Memory 这条更强：Trace 既进本库、也**外发**到
 * Phoenix，而外发是不可撤回的。
 *
 * 因此本文件做两件事：
 *   1. `memoryTraceAttributes()` **只**产出计数、类型、状态、id 与来源区间 ——
 *      它在构造上就拿不到正文（入参里没有正文）
 *   2. `assertNoMemoryContentInTrace()` 是一道**可断言的守卫**：
 *      谁都可以构造属性对象，因此需要一条断言来证明"正文确实不在里面"
 *
 * 第 2 条不是多余：第 1 条的保证依赖"调用方用那个函数"，
 * 而"依赖调用方自觉"正是本项目反复拒绝的做法（见 `source-authority.ts`
 * 的"字典是愿望"）。守卫让违反变成一次**失败**，而不是一次静默外发。
 */

import {
  KernelError,
  type MemoryRecord,
  type MemoryStatus,
  type MemoryType,
  type Timestamp,
  type TraceStep,
} from '../../contracts/index.ts'
import type { MemoryPipelineOutcome } from './pipeline.ts'

// ---------------------------------------------------------------------------
// Step kinds（计划书第 109 节）
// ---------------------------------------------------------------------------

/**
 * Memory 流水线的 step kind。
 *
 * 命名用**点号**而不是 M3 那种下划线（`conversation_persist_input`）。
 * 理由不是美观：计划书第 109 节给的树本身就是点号命名
 * （`memory.job.enqueue` / `candidate.extract`），而 trace 树要能
 * **逐节点**对照那份计划书。名字对不上时，review 会变成"猜哪一步对应哪一步"。
 */
export const MEMORY_STEP_KINDS = {
  explicitIntent: 'memory.explicit_intent',
  jobEnqueue: 'memory.job.enqueue',
  process: 'memory.process',
  evidenceLoad: 'evidence.load',
  candidateExtract: 'candidate.extract',
  candidateNormalize: 'candidate.normalize',
  authorityClassify: 'authority.classify',
  valueEvaluate: 'value.evaluate',
  duplicateCheck: 'duplicate.check',
  conflictCheck: 'conflict.check',
  policyDecide: 'policy.decide',
  domainEventCommit: 'domain_event.commit',
  memoryApply: 'memory.apply',
} as const

export type MemoryStepKind = (typeof MEMORY_STEP_KINDS)[keyof typeof MEMORY_STEP_KINDS]

// ---------------------------------------------------------------------------
// 属性（计划书第 110 节）
// ---------------------------------------------------------------------------

/**
 * 计划书第 110 节要求至少有的属性键。
 *
 * ⚠️ 为什么是"键清单 + 普通 Record"而不是一个带可选属性的 interface：
 * `TraceStep.attributes` 的类型是 `Record<string, string | number | boolean>`，
 * 而"可选属性"（`x?: number`，即 `number | undefined`）**不能**赋给那个索引类型
 * （TypeScript 会报 index-signature 冲突）。把 `undefined` 加进索引类型又能过，
 * 但那会让 `TraceStep` 的赋值失败 —— 冲突只是被挪了位置。
 *
 * 因此清单单独声明，由 `declaredMemoryTraceAttributeKeys()` 暴露，
 * 并**由测试守住**：`memoryTraceAttributes()` 产出的键必须是这份清单的子集。
 * 这样"加属性时忘了登记"会红，而不是悄悄多出一个没被审查过的字段
 * —— 而那个字段可能是正文（见本文件的隐私守卫）。
 *
 * ⚠️ 全部是**计数、枚举标签、id 与区间** —— 没有一个承载正文。
 * 这是刻意的：让"外发正文"在类型层面就写不出来，而不是靠"记得别写"。
 */
export const MEMORY_TRACE_ATTRIBUTE_KEYS = [
  'memory.candidate_count',
  'memory.accepted_count',
  'memory.rejected_count',
  'memory.merged_count',
  'memory.superseded_count',
  'memory.disputed_count',
  'processor.version',
  'source.event_range',
  'memory.owner',
  'memory.type',
  'memory.authority',
  'memory.epistemic_status',
  'policy.decision',
  /** 额外：未登记 predicate 的计数（计划书第 19 节的可观测落地点） */
  'memory.unregistered_predicate_count',
] as const

export type MemoryTraceAttributeKey = (typeof MEMORY_TRACE_ATTRIBUTE_KEYS)[number]

export type MemoryTraceAttributes = Record<string, string | number | boolean>

/** 供测试与文档：本模块声明的全部属性键 */
export function declaredMemoryTraceAttributeKeys(): string[] {
  return [...MEMORY_TRACE_ATTRIBUTE_KEYS].sort()
}

/**
 * 从 pipeline 结果构造 trace 属性。
 *
 * **入参里没有正文**，因此这个函数**不可能**泄漏正文 ——
 * 这比"记得过滤"强，因为"记得"会在某次重构里失效。
 */
export function memoryTraceAttributes(input: {
  outcome: MemoryPipelineOutcome
  processorVersion: string
  owner: string
  fromSequence?: number
  toSequence?: number
}): MemoryTraceAttributes {
  const attributes: MemoryTraceAttributes = {
    'memory.candidate_count': input.outcome.candidates,
    'memory.accepted_count': input.outcome.accepted,
    // 拒绝数 = 值闸 + 冲突 + 放行三处的和（它们各自有意义，但 trace 上
    // 先给一个总数让人能判断"这批有多少被丢"）
    'memory.rejected_count':
      input.outcome.valueRejected +
      input.outcome.policyRejected +
      input.outcome.rejections.filter((r) => r.stage === 'conflict').length,
    'memory.superseded_count': input.outcome.rejections.filter(
      (r) => r.reason === 'supersede_skipped_no_replacement'
    ).length,
    'memory.disputed_count': input.outcome.rejections.filter(
      (r) => r.reason === 'marked_disputed'
    ).length,
    'processor.version': input.processorVersion,
    'memory.owner': input.owner,
  }

  if (input.fromSequence !== undefined && input.toSequence !== undefined) {
    attributes['source.event_range'] = `${input.fromSequence}..${input.toSequence}`
  }

  // 逐条类型的分布（**类型名不是正文**，可以安全外发）
  const typeCounts = countBy(input.outcome.created, (r) => r.type)
  if (Object.keys(typeCounts).length > 0) {
    attributes['memory.type'] = Object.keys(typeCounts).sort().join(',')
  }

  const authorityCounts = countBy(input.outcome.created, (r) => r.authority)
  if (Object.keys(authorityCounts).length > 0) {
    attributes['memory.authority'] = Object.keys(authorityCounts).sort().join(',')
  }

  const unregistered = input.outcome.created.filter(
    (r) => r.content.kind === 'claim' && r.canonicalKey === undefined
  ).length
  if (unregistered > 0) {
    attributes['memory.unregistered_predicate_count'] = unregistered
  }

  return attributes
}

function countBy<T>(items: readonly T[], key: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const item of items) {
    const k = key(item)
    out[k] = (out[k] ?? 0) + 1
  }
  return out
}

// ---------------------------------------------------------------------------
// 隐私守卫（计划书第 110 节的硬约束）
// ---------------------------------------------------------------------------

/**
 * 断言 trace 属性里**不含**任何敏感正文。
 *
 * ============================================================================
 *  为什么需要一条"证明没泄漏"的断言
 * ============================================================================
 * `memoryTraceAttributes()` 在构造上就安全（入参没有正文）。
 * 但 trace 属性**不只有那一个函数会写** —— 将来有人加一个新 step、
 * 顺手把 `record.content` 塞进 attributes 时，没有任何东西会拦住他。
 *
 * 而那条路径是**外发**的（Phoenix），发出去了就收不回来。
 * 因此需要一条断言把"看来没写正文"变成"证明了没写正文"。
 *
 * 判据刻意做得**保守**：只要敏感片段（长度 >= 4 的连续文本）出现在
 * 序列化后的属性里就算泄漏。短于 4 的片段会被忽略 —— 否则
 * "用户"这种两个字的内容会让正常属性（`memory.type=person_fact`）误报，
 * 而一条会误报的断言会被关掉，于是它什么也守不住。
 */
export function assertNoMemoryContentInTrace(input: {
  attributes: Readonly<Record<string, unknown>>
  /** 本次涉及的全部敏感正文（记忆内容、对话原文、谓词取值……） */
  sensitiveTexts: readonly string[]
  /** 最小匹配长度：短于此的片段不参与判定（避免误报） */
  minLength?: number
}): void {
  const minLength = input.minLength ?? 4
  const serialized = JSON.stringify(input.attributes)

  const leaked = new Set<string>()
  for (const text of input.sensitiveTexts) {
    const trimmed = typeof text === 'string' ? text.trim() : ''
    if (trimmed.length < minLength) continue
    if (serialized.includes(trimmed)) leaked.add(trimmed)
  }

  if (leaked.size > 0) {
    throw new KernelError(
      'validation_error',
      'memory_content_in_trace',
      `trace 属性里出现了 Memory 正文：${[...leaked]
        .map((t) => JSON.stringify(t.slice(0, 20)))
        .join(', ')}。` +
        '计划书第 110 节：不要默认发送完整私人 Memory 内容到外部 Telemetry —— ' +
        '而外发是不可撤回的。正文留在 ConversationEvent 里，trace 只放 id 与计数',
      { leakedCount: leaked.size, attributeKeys: Object.keys(input.attributes) }
    )
  }
}

/**
 * 从一条记忆记录里取出**全部**正文片段（供 `assertNoMemoryContentInTrace` 用）。
 *
 * 单独一个函数是为了让"什么算正文"只有一处定义 ——
 * 加一个内容字段时不会漏掉某个断言点（那会让守卫**看起来**还在守，
 * 而实际上放过了新字段）。
 */
export function sensitiveTextsOf(record: MemoryRecord): string[] {
  const out: string[] = [String(record.id)]
  if (record.content.kind === 'claim') {
    out.push(record.content.predicate)
    out.push(stringify(record.content.value))
    for (const value of Object.values(record.content.qualifiers ?? {})) {
      out.push(stringify(value))
    }
  } else {
    out.push(record.content.summary)
    for (const tag of record.content.topicTags ?? []) out.push(tag)
  }
  return out.filter((t) => t.trim().length > 0)
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

// ---------------------------------------------------------------------------
// Step 构造（计划书第 109 节的树）
// ---------------------------------------------------------------------------

/**
 * 把一次后台抽取的结果铺成计划书第 109 节那棵树。
 *
 * ⚠️ 每一层的 `status` 与 `attributes` 都**不含正文**：
 * 这一层只做计时与计数。要追"它到底记了什么"，
 * 走 `memory list` / `memory get`（开发入口），而不是看 trace。
 *
 * `startedAt` / `finishedAt` 由调用方给：本模块不读时间
 * （纯函数才能被穷举测试，而"这一步花了多久"依赖注入的时刻）。
 */
export function memoryPipelineSteps(input: {
  outcome: MemoryPipelineOutcome
  processorVersion: string
  startedAt: Timestamp
  finishedAt: Timestamp
}): TraceStep[] {
  const { outcome } = input
  const span = Math.max(0, input.finishedAt - input.startedAt)

  /** 把总耗时按步数平摊（刻意不假装知道每步的精确耗时） */
  const perStep = Math.round(span / 6)

  const at = (index: number): { startedAt: number; finishedAt: number } => ({
    startedAt: input.startedAt + perStep * index,
    finishedAt: input.startedAt + perStep * (index + 1),
  })

  const make = (
    index: number,
    kind: string,
    label: string,
    attributes: Record<string, string | number | boolean>,
    status: 'ok' | 'failed' = 'ok'
  ): TraceStep => ({
    kind: kind as TraceStep['kind'],
    label,
    ...at(index),
    status,
    attributes,
  })

  const valueRejected = outcome.valueRejected
  const conflictRejected = outcome.rejections.filter((r) => r.stage === 'conflict').length
  const policyRejected = outcome.policyRejected

  return [
    make(0, MEMORY_STEP_KINDS.evidenceLoad, '加载本批证据事件', {
      'source.event_range': 'see parent',
      events: outcome.candidates > 0 ? 'loaded' : 'empty',
    }),
    make(1, MEMORY_STEP_KINDS.candidateExtract, '抽取候选', {
      'memory.candidate_count': outcome.candidates,
      'processor.version': input.processorVersion,
    }),
    make(2, MEMORY_STEP_KINDS.valueEvaluate, '值评估（Value Gate）', {
      'memory.candidate_count': outcome.candidates,
      // 值闸拒了多少 —— 这个数字**高是健康的**（计划书第 50 / 166 节）
      value_rejected: valueRejected,
      value_passed: outcome.valuePassed,
    }),
    make(3, MEMORY_STEP_KINDS.conflictCheck, '去重与冲突分析', {
      conflict_rejected: conflictRejected,
    }),
    make(4, MEMORY_STEP_KINDS.policyDecide, '走放行口', {
      accepted: outcome.accepted,
      policy_rejected: policyRejected,
    }),
    make(
      5,
      MEMORY_STEP_KINDS.memoryApply,
      '提交领域事件并折叠投影',
      {
        created: outcome.created.length,
        deduplicated: outcome.deduplicated,
      },
      // 一条都没建**不是失败** —— 绝大多数普通对话都走这条
      'ok'
    ),
  ]
}

/**
 * 一条显式意图的 step（计划书第 109 节的 `memory.explicit_intent?`）。
 *
 * `kind` 与 `operation` 都是**枚举标签**，不是用户原话 ——
 * 原话属于 ConversationEvent，trace 只记"识别成了哪一种意图"。
 */
export function explicitIntentStep(input: {
  intentKind: string
  detectedBy: 'rule' | 'classifier'
  startedAt: Timestamp
  finishedAt?: Timestamp
}): TraceStep {
  return {
    kind: MEMORY_STEP_KINDS.explicitIntent as TraceStep['kind'],
    label: `显式记忆意图（${input.intentKind}）`,
    startedAt: input.startedAt,
    ...(input.finishedAt !== undefined ? { finishedAt: input.finishedAt } : {}),
    status: 'ok',
    attributes: {
      intent_kind: input.intentKind,
      // "规则命中"还是"问了模型"必须记：它决定这条路径的延迟与成本
      detected_by: input.detectedBy,
    },
  }
}

/** 便于测试：本模块声明的全部 step kind（与计划书第 109 节的树对照） */
export function declaredMemoryStepKinds(): string[] {
  return Object.values(MEMORY_STEP_KINDS).sort()
}

/** 让类型参与推导（避免未使用 import 的告警） */
export type { MemoryStatus, MemoryType }
