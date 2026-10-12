/**
 * M5.1 WP1 —— **开发者平面契约测试**（`pnpm m5.1:test`）。
 *
 * ============================================================================
 *  它测的是"契约能不能挡住它该挡住的东西"
 * ============================================================================
 * 计划书 WP1 的 Tests 是四件事：
 *
 *     serialization stable · required fields
 *     execution-state distinction · sensitive-field negative control
 *
 * 因此这里**没有**数据库、没有模型、没有 HTTP、没有检索实现 ——
 * deterministic、毫秒级。它比"类型能编译"多做六件这一层才做得到的事：
 *
 *   ① **字段接地**（防"凭空造字段"）：每个 DTO 键都必须能在既有权威形状里
 *      找到出处，或者在**显式派生清单**里。造一个 `totallyMadeUpField` 必须失败
 *      —— 而且这个判据自己带**负控**（INV-M45-06：量具也要被验证）。
 *   ② **序列化稳定**：键序置换不变 + 摘要对固定 fixture 有**硬编码期望值**（字节级锁）。
 *   ③ **失败关闭**：缺字段 / 未知命令 / 越界 / 未知字段 / 禁止命令，逐条必须抛。
 *   ④ **执行状态区分**（AT3.6 的五档）：五档必须**两两不同**，且违规组合必须被拒。
 *      外加一条**源码级静态锁**：契约里不许出现名为 `success` 的布尔成员。
 *   ⑤ **敏感字段负控**（AT1.4）：合法键通过；`api_key` / `access_token` /
 *      `prompt_text` / `memory_body` / `credential` … 逐个必须被拒；
 *      并且**抛错信息里不许回显取值**（守卫自己不能变成泄漏点）。
 *      额外一条**反绕过**控制：`api_key_id` 不许因为 `_id` 后缀而蒙混过关。
 *   ⑥ **无死值 / 单一词汇**：每个阶段必须登记生产者；每个命令必须登记事实；
 *      每个理由码必须登记产出者；而阶段理由码一律**引用**既有受控词汇
 *      （M5 的排除理由 / M4.5 的失败码 / 本里程碑的控制理由码），一个都不另造。
 *
 * 跑法：pnpm m5.1:test        （可加过滤词：pnpm m5.1:test 敏感）
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect, group, printSummary, runAll, test } from './kernel-test-kit.ts'
import {
  ACTION_FAILURE_CODES,
  actionFailure,
  type ActionFailure,
} from '../src/kernel/action/errors.ts'
import {
  asActionId,
  asCharacterId,
  asTraceId,
  type ConversationEventId,
} from '../src/kernel/contracts/ids.ts'
import { RECALL_EXCLUSION_REASONS } from '../src/kernel/contracts/recall.ts'
import {
  CONTROL_COMMAND_FACTS,
  CONTROL_COMMAND_TYPES,
  CONTROL_LIMITS,
  CONTROL_REASON_CODES,
  CONTROL_REASON_CODE_FACTS,
  CONTROL_SCHEMA_VERSION,
  CONTROL_VERIFICATIONS,
  FORBIDDEN_CONTROL_COMMANDS,
  assertControlCommandAllowed,
  assertControlDryRunSupported,
  assertControlReasonCodeRegistered,
  assertControlRegistryConsistent,
  assertControlResult,
  assertDeveloperSurfaceAllowed,
  assertDryRunSupportedByFact,
  controlCommandDigest,
  controlLadderBooleansOf,
  controlResultFingerprint,
  createControlCommand,
  describeControlReason,
  describeControlResult,
  parseControlCommand,
  serializeControlCommand,
  type ControlCommand,
  type ControlResult,
  type ControlledCommandFact,
} from '../src/kernel/contracts/developer-control.ts'
import {
  AVAILABLE,
  DEVELOPER_QUERY_CAPABILITY_FACTS,
  DEVELOPER_QUERY_CAPABILITY_IDS,
  DEVELOPER_QUERY_LIMITS,
  DEVELOPER_QUERY_REASON_CODES,
  DEVELOPER_QUERY_SCHEMA_VERSION,
  DEVELOPER_TRACE_DETAIL_IS_GROUNDED,
  DEVELOPER_TRACE_SUMMARY_IS_GROUNDED,
  assertDeveloperCapabilityFact,
  assertDeveloperCursor,
  assertDeveloperExecutionDetail,
  assertDeveloperLimit,
  assertDeveloperLookup,
  attributionCountsOf,
  decodeDeveloperCursor,
  developerDurationMs,
  encodeDeveloperCursor,
  notFound,
  parseExecutionGetQuery,
  parseExecutionListQuery,
  parseMemoryIntegrityQuery,
  parseMemoryStatsQuery,
  parseTraceGetQuery,
  parseTraceListQuery,
  resolveDeveloperLimit,
  summarizeTraceDerived,
  unavailable,
  type DeveloperAttributionDto,
  type DeveloperExecutionDetailDto,
} from '../src/kernel/contracts/developer-query.ts'
import {
  OBSERVABILITY_LIMITS,
  OBSERVABILITY_PROVENANCE_KINDS,
  OBSERVABILITY_SCHEMA_VERSION,
  OBSERVABILITY_STAGES,
  OBSERVABILITY_STAGE_FACTS,
  SENSITIVE_ATTRIBUTE_KEY_SEGMENTS,
  TELEMETRY_ATTRIBUTE_ALLOWLIST,
  TELEMETRY_ATTRIBUTE_PATTERNS,
  TELEMETRY_LEGACY_ATTRIBUTE_ALIASES,
  TELEMETRY_LEGACY_KEYS_OUTSIDE_POLICY,
  assertObservabilityRegistryConsistent,
  assertObservabilitySpan,
  assertTelemetryAttributesAllowed,
  correlationOf,
  describeSensitiveDataPolicy,
  isLegacyAttributeOutsidePolicy,
  isSensitiveAttributeKey,
  isTelemetryAttributeAllowed,
  isTelemetryAttributeAllowedIncludingLegacy,
  spanDurationMs,
  stageOfTraceStepKind,
  stagesWithoutReasonCodes,
  unstagedObservabilityStages,
  type ObservabilitySpanInput,
} from '../src/kernel/contracts/observability.ts'
import type { CharacterRunTrace } from '../src/kernel/contracts/trace.ts'
import type { ExecutionRecordView } from '../src/kernel/action/execution-ledger.ts'
import type { ExecutionRecord } from '../src/kernel/action/execution-record.ts'
import type { MemoryStatsView } from '../src/kernel/app/memory/admin.ts'
import type { MemoryIntegrityProblems } from '../src/infrastructure/persistence/memory-integrity.ts'

const CONTRACTS_DIR = join(process.cwd(), 'src', 'kernel', 'contracts')
const CONTRACT_FILES = ['developer-query.ts', 'developer-control.ts', 'observability.ts'] as const

const readContract = (name: string): string => readFileSync(join(CONTRACTS_DIR, name), 'utf8')

/** 只取 import / export-from 行（注释里出现 `node:*` 这类字样不该误报 —— 与 kernel:test 同一个做法） */
function importLinesOf(source: string): string {
  return source
    .split('\n')
    .filter((line) => /^\s*import\b/.test(line) || /^\s*export\b.*\bfrom\b/.test(line))
    .join('\n')
}

// ===========================================================================
group('AT1.1 契约形状与字段接地（防凭空造字段）')
// ===========================================================================

/** 权威形状的 fixture：字段集与真实类型逐字一致（类型注解本身就是一条判据） */
const TRACE_FIXTURE: CharacterRunTrace = {
  traceId: asTraceId('trace-fixture-1'),
  characterId: asCharacterId('sumuwei'),
  runtimeId: 'runtime-1',
  userId: 'user-1',
  conversationId: 'conv-1',
  seedVersion: 3,
  seedHash: 'seedhash-1',
  identitySourceRefs: ['character-definition:sumuwei@2'],
  inputEventId: 'cev-1' as ConversationEventId,
  outputEventId: 'cev-2' as ConversationEventId,
  contextCompilerVersion: 'context-compiler@2',
  contextSectionIds: ['identity-core'],
  droppedSectionIds: [],
  sourceConversationEventIds: ['cev-1'],
  selectedMemoryIds: ['mem-1'],
  projectionRevisionsAtStart: { diagnostic: 1 },
  projectionRevisionsAtEnd: { diagnostic: 2 },
  domainEventIds: [],
  actionIds: [],
  modelProfile: 'fixture-model',
  postTurnJobIds: [],
  processorVersions: { memory: 'm4@1' },
  steps: [
    {
      kind: 'context_compile',
      label: '组装上下文',
      startedAt: 1000,
      finishedAt: 1005,
      status: 'ok',
      attributes: { section_count: 1 },
    },
  ],
  status: 'completed',
  startedAt: 1000,
  finishedAt: 1010,
}

const EXECUTION_VIEW_FIXTURE: ExecutionRecordView = {
  actionId: asActionId('action-1'),
  traceId: asTraceId('trace-fixture-1'),
  capability: 'system.echo',
  operation: 'echo',
  status: 'success',
  executed: true,
  accepted: true,
  sideEffect: 'none',
  idempotencyKey: 'idem-1',
  idempotentReplay: false,
  evidence: [{ kind: 'adapter', detail: 'echo adapter returned' }],
  requestedAt: 1000,
  startedAt: 1001,
  finishedAt: 1002,
}

/**
 * 执行详情的**第二个**权威形状：`ExecutionRecord`（事件流折叠的全字段视图）。
 *
 * 为什么要两个：摘要只投影 `ExecutionRecordView`，而详情还要投影
 * `request` / `decision` / `result`（它们只在 `ExecutionRecord` 上有）。
 * 这条区分本身就是证据 —— "详情的每个字段都能指到哪一份权威"是可回答的。
 */
const EXECUTION_RECORD_FIXTURE: ExecutionRecord = {
  actionId: asActionId('action-1'),
  traceId: asTraceId('trace-fixture-1'),
  capability: 'system.echo',
  operation: 'echo',
  request: {
    actionId: asActionId('action-1'),
    traceId: asTraceId('trace-fixture-1'),
    capability: 'system.echo',
    operation: 'echo',
    requestedBy: { kind: 'system' },
    arguments: { text: 'hi' },
    sideEffect: 'none',
    createdAt: 1000,
  },
  decision: { allowed: true, code: 'allowed', message: 'R0 read-only' },
  result: {
    actionId: asActionId('action-1'),
    traceId: asTraceId('trace-fixture-1'),
    capability: 'system.echo',
    operation: 'echo',
    accepted: true,
    executed: true,
    status: 'success',
  },
  timestamps: { requested: 1000, started: 1001, finished: 1002 },
  evidence: [{ kind: 'adapter', detail: 'echo adapter returned' }],
}

const MEMORY_STATS_FIXTURE: MemoryStatsView = {
  total: 3,
  active: 2,
  superseded: 1,
  retracted: 0,
  disputed: 0,
  byProcessor: [{ processor: 'm4', version: '1', count: 3 }],
  unsupported: 0,
  contaminated: 0,
  unregisteredPredicate: 0,
}

const MEMORY_INTEGRITY_FIXTURE: MemoryIntegrityProblems = {
  danglingEvidenceLinks: [],
  danglingMemoryEvents: [],
  memoriesWithoutLiveEvidence: [],
  memoriesWithoutLiveEvents: [],
}

/** DTO 的**全部**键，逐字钉住：加字段必须同时改这里，否则这条测试会失败 */
const TRACE_SUMMARY_KEYS = [
  'actionIds',
  /*
   * ⚠️ M6 / WP5 补登：`attribution`（WP6-5 追加的派生字段）**没有**出现在这份
   * "全部键"清单里，于是"加字段必须同时改这里"这条纪律一直是**靠自觉**的
   * —— 这份清单漏了两轮都没被机器发现。已把它与 M6 的 `rollup` 一起补齐；
   * 两者都在派生清单里（因此 `ungroundedKeys` 仍然为 []）。
   */
  'attribution',
  'characterId',
  'contextCompilerVersion',
  'contextSectionIds',
  'conversationId',
  'droppedSectionIds',
  'durationMs',
  'finishedAt',
  'hasError',
  'inputEventId',
  'modelProfile',
  'outputEventId',
  'runtimeId',
  'seedHash',
  'seedVersion',
  'selectedMemoryIds',
  'sourceConversationEventIds',
  'startedAt',
  'status',
  'stepCount',
  'traceId',
  'userId',
].sort()

/** 显式派生清单（不来自权威形状、由契约自己算）：与 DTO 头部的注释逐条对应 */
const TRACE_DERIVED_KEYS = ['attribution', 'durationMs', 'hasError', 'stepCount']

/** 详情**独有**的键（M6 / WP5：`rollup` 是派生，接地面是 `context_compile` step 的属性） */
const TRACE_DETAIL_KEYS = [...TRACE_SUMMARY_KEYS, 'counts', 'error', 'rollup'].sort()

/** 详情独有键里**显式派生**的那两个（`counts` / `rollup`）：都不是 `character_traces` 的列 */
const TRACE_DETAIL_DERIVED_KEYS = [...TRACE_DERIVED_KEYS, 'counts', 'rollup']

/**
 * 详情 DTO 的**权威键**。
 *
 * ⚠️ `TRACE_FIXTURE` 是一个**字面量**对象：可选字段没写就看不见。
 * `error`（`contracts/trace.ts:230` 的 `error?: string`）正是这种情况 ——
 * 它在权威形状上，只是这份 fixture 没设它。
 * 因此这里显式把它补进权威键，而**不是**把它塞进"派生清单"
 * （那会把"权威上有的字段"说成"我们算出来的"，是另一种不诚实）。
 */
const TRACE_DETAIL_AUTHORITY_KEYS = [...Object.keys(TRACE_FIXTURE), 'error']

/**
 * 执行 DTO 的派生清单：**扁平化**（嵌套的 `target` / `failure` 摊平）
 * ＋ 由账本派生的 `attempted`（`ACTION_STARTED` 的存在性）。
 */
const EXECUTION_SUMMARY_DERIVED_KEYS = [
  'attempted',
  'durationMs',
  'failureCode',
  'targetCanonicalId',
  'targetConfidence',
  'targetType',
]

/**
 * 详情**独有**的三个投影：AT2.5 点名的 intent / attempt / verification。
 *
 * ⚠️ 它们今天是**派生**的，因为**没有**独立的权威形状（这不是省事，是如实）：
 *   · `intent`      —— 运行时还没有意图分类器（M5 局限 1）→ 只能如实报 `not_available`
 *   · `attempt`     —— 由账本的 `ACTION_STARTED` 派生（Repository Map F-4）
 *   · `verification`—— 账本里今天**没有**核验事件的独立证据（F-4）→ 四态里的 `not_attempted`
 * 三者分别对应 Authority Map 的 F-4 / F-10；等它们各自有权威形状时，这里必须删掉。
 */
const EXECUTION_DETAIL_DERIVED_KEYS = [
  ...EXECUTION_SUMMARY_DERIVED_KEYS,
  'intent',
  'attempt',
  'verification',
  /*
   * WP7（U-14 / K-30）：`counts` 是**由归因槽位算出来的聚合**，不是账本里的列 ⇒ 派生。
   * 接地面与 `attribution` 相同（`character_action_events` 的归因列），
   * 且 `attributionCountsOf()` 是**唯一**实现处（契约里的纯函数）。
   */
  'counts',
]

/** DTO 的**全部**键，逐字钉住：加字段必须同时改这里，否则这条测试会失败 */
const EXECUTION_SUMMARY_KEYS = [
  'accepted',
  'actionId',
  'attempted',
  'capability',
  'durationMs',
  'executed',
  'failureCode',
  'finishedAt',
  'idempotentReplay',
  'operation',
  'requestedAt',
  'sideEffect',
  'startedAt',
  'status',
  'targetCanonicalId',
  'targetConfidence',
  'targetType',
  'traceId',
].sort()

const EXECUTION_DETAIL_KEYS = [
  ...EXECUTION_SUMMARY_KEYS,
  'intent',
  'request',
  'decision',
  'attempt',
  'result',
  'verification',
  'evidence',
  'counts',
].sort()

const MEMORY_STATS_KEYS = [...Object.keys(MEMORY_STATS_FIXTURE), 'integrity'].sort()
const MEMORY_INTEGRITY_KEYS = [...Object.keys(MEMORY_INTEGRITY_FIXTURE), 'integrityOk'].sort()

/**
 * 字段接地的**运行时量具**。
 *
 * ⚠️ 它自己带负控（见下一条测试）：一个永远返回 `[]` 的"量具"会让所有契约
 *    都"接地成功"，而那种绿没有意义（INV-M45-06）。
 */
function ungroundedKeys(
  dtoKeys: readonly string[],
  authorityKeys: readonly string[],
  derivedKeys: readonly string[]
): string[] {
  const authority = new Set(authorityKeys)
  return dtoKeys.filter((key) => !authority.has(key) && !derivedKeys.includes(key))
}

test('编译期接地证明已生效（两条 const 必须为 true）', () => {
  expect.equal(DEVELOPER_TRACE_SUMMARY_IS_GROUNDED, true)
  expect.equal(DEVELOPER_TRACE_DETAIL_IS_GROUNDED, true)
})

test('TraceSummaryDto 的每个键都能落到 CharacterRunTrace 或显式派生清单', () => {
  expect.deepEqual(
    ungroundedKeys(TRACE_SUMMARY_KEYS, Object.keys(TRACE_FIXTURE), TRACE_DERIVED_KEYS),
    [],
    'TraceSummaryDto 出现了凭空造的字段'
  )
})

test('TraceDetailDto 的每个键都能落到 CharacterRunTrace 或显式派生清单（M6 / WP5 追加 rollup）', () => {
  expect.deepEqual(
    ungroundedKeys(TRACE_DETAIL_KEYS, TRACE_DETAIL_AUTHORITY_KEYS, TRACE_DETAIL_DERIVED_KEYS),
    [],
    'TraceDetailDto 出现了凭空造的字段'
  )
  /*
   * 与 execution-detail 那条同型：**派生必须真的是派生**。
   * `counts` 是归因槽位的聚合；`rollup` 是 `context_compile` step 属性的投影 ——
   * 两者都不是 `character_traces` 的列，因此必须在派生清单里。
   */
  for (const key of ['counts', 'rollup'] as const) {
    expect.ok(TRACE_DETAIL_DERIVED_KEYS.includes(key), `${key} 必须在派生清单里`)
  }
})

test('DeveloperExecutionSummaryDto 的每个键都能落到 ExecutionRecordView 或显式派生清单', () => {
  expect.deepEqual(
    ungroundedKeys(
      EXECUTION_SUMMARY_KEYS,
      Object.keys(EXECUTION_VIEW_FIXTURE),
      EXECUTION_SUMMARY_DERIVED_KEYS
    ),
    [],
    'Execution 摘要 DTO 出现了凭空造的字段'
  )
})

test('DeveloperExecutionDetailDto 的每个键都能落到两份权威或显式派生清单', () => {
  const authority = [
    ...Object.keys(EXECUTION_VIEW_FIXTURE),
    ...Object.keys(EXECUTION_RECORD_FIXTURE),
  ]
  expect.deepEqual(
    ungroundedKeys(EXECUTION_DETAIL_KEYS, authority, EXECUTION_DETAIL_DERIVED_KEYS),
    [],
    'Execution 详情 DTO 出现了凭空造的字段'
  )
  // 三个"派生"必须真的是派生（不当派生会掩盖"权威还不存在"这件事）
  for (const key of ['intent', 'attempt', 'verification'] as const) {
    expect.ok(EXECUTION_DETAIL_DERIVED_KEYS.includes(key))
  }
})

test('WP7 / U-14（K-30）：unknown count 的**单位与边界**逐条按裁定', () => {
  const known = { state: 'KNOWN', kind: 'USER', id: 'u-1' } as const
  const unknownRuntime = { state: 'UNKNOWN', reason: 'RUNTIME_UNRESOLVED' } as const
  const unknownLegacy = { state: 'UNKNOWN', reason: 'LEGACY_UNRECORDED' } as const
  const absent = { state: 'ABSENT' } as const
  /** 造一条归因 DTO：六个槽位按数组给（authority 只接受 UNKNOWN/ABSENT —— 本测试不需要 Known 许可） */
  const record = (
    slots: readonly [
      typeof known | typeof unknownRuntime | typeof unknownLegacy | typeof absent,
      typeof known | typeof unknownRuntime | typeof unknownLegacy | typeof absent,
      typeof known | typeof unknownRuntime | typeof unknownLegacy | typeof absent,
      typeof unknownRuntime | typeof unknownLegacy | typeof absent,
      typeof known | typeof unknownRuntime | typeof unknownLegacy | typeof absent,
      typeof known | typeof unknownRuntime | typeof unknownLegacy | typeof absent,
    ]
  ): DeveloperAttributionDto => ({
    attributionOrigin: 'RECORDED',
    subject: { kind: 'CHARACTER', id: 'char-1' },
    initiator: slots[0],
    actor: slots[1],
    executor: slots[2],
    authority: slots[3],
    recordedBy: slots[4],
    contentOriginator: slots[5],
    // Axis B **与计数无关**：这里刻意放一个 unconfirmed 分支
    axisB: {
      availability: 'APPLICABLE',
      sourceKind: 'user_statement',
      sourceAuthority: 'UNCONFIRMED_ORIGIN',
      epistemicSource: 'UNCONFIRMED_ORIGIN',
      branch: 'unconfirmed',
    },
    basisEventType: 'user_message',
    basisSequence: 1,
  })

  // ① 空结果集 ⇒ 两个 0（**显式**的 0，不是"没这个字段"）
  expect.deepEqual(attributionCountsOf([]), { unknownSlotCount: 0, recordsWithUnknownCount: 0 })

  // ② KNOWN 与 ABSENT 都**不计入**
  expect.deepEqual(
    attributionCountsOf([record([known, known, absent, absent, known, known])]),
    { unknownSlotCount: 0, recordsWithUnknownCount: 0 },
    'KNOWN / ABSENT 不得被算成未知'
  )

  // ③ 无信封（字段缺席）也**不计入** —— 但它与 ABSENT 是两件事
  expect.deepEqual(attributionCountsOf([undefined]), { unknownSlotCount: 0, recordsWithUnknownCount: 0 })
  expect.deepEqual(
    attributionCountsOf([undefined, record([unknownRuntime, known, absent, absent, known, known])]),
    { unknownSlotCount: 1, recordsWithUnknownCount: 1 },
    '无信封的记录不参与计数'
  )

  // ④ 两个 reason 都计入：RUNTIME_UNRESOLVED 与 **LEGACY_UNRECORDED（MIGRATED_LEGACY 行）**
  expect.deepEqual(
    attributionCountsOf([record([unknownRuntime, known, absent, absent, known, known])]),
    { unknownSlotCount: 1, recordsWithUnknownCount: 1 }
  )
  expect.deepEqual(
    attributionCountsOf([record([unknownLegacy, known, absent, absent, known, known])]),
    { unknownSlotCount: 1, recordsWithUnknownCount: 1 },
    'MIGRATED_LEGACY 行上的 Unknown **计入**（U-14：它正是要让它可见的那一类）'
  )

  // ⑤ 两个单位分别数：2 条记录、5 个未知槽位 ⇒ {5, 2}
  expect.deepEqual(
    attributionCountsOf([
      record([unknownRuntime, unknownLegacy, known, absent, known, known]),
      record([known, unknownRuntime, unknownRuntime, unknownLegacy, known, known]),
    ]),
    { unknownSlotCount: 5, recordsWithUnknownCount: 2 }
  )

  // ⑥ 六个槽位**逐个**都算（不是只数某几个）
  const onePerSlot = [
    record([unknownRuntime, known, known, absent, known, known]),
    record([known, unknownRuntime, known, absent, known, known]),
    record([known, known, unknownRuntime, absent, known, known]),
    record([known, known, known, unknownRuntime, known, known]),
    record([known, known, known, absent, unknownRuntime, known]),
    record([known, known, known, absent, known, unknownRuntime]),
  ]
  expect.deepEqual(attributionCountsOf(onePerSlot), { unknownSlotCount: 6, recordsWithUnknownCount: 6 })

  // ⑦ 负控：Axis B 的 UNCONFIRMED_ORIGIN **不是**未知（上面的 record() 全是 unconfirmed 分支，
  //    而 ② 的结果是 0 —— 这条自检证明判据读的是**槽位三态**，不是 Axis B）
  expect.equal(
    (
      record([known, known, absent, absent, known, known]).axisB as {
        sourceAuthority?: string
      }
    ).sourceAuthority,
    'UNCONFIRMED_ORIGIN'
  )
})

test('负控：接地量具必须会响（造一个键就必须被报出来）', () => {  const offenders = ungroundedKeys(
    [...TRACE_SUMMARY_KEYS, 'totallyMadeUpField'],
    Object.keys(TRACE_FIXTURE),
    TRACE_DERIVED_KEYS
  )
  expect.deepEqual(offenders, ['totallyMadeUpField'], '量具没响 —— 那它的绿是假的')
})

test('MemoryStatsDto / MemoryIntegrityDto 与既有权威形状一致（只做搬运）', () => {
  expect.deepEqual(
    ungroundedKeys(MEMORY_STATS_KEYS, Object.keys(MEMORY_STATS_FIXTURE), ['integrity']),
    [],
    'MemoryStatsDto 出现了 MemoryStatsView 之外的字段'
  )
  expect.deepEqual(
    ungroundedKeys(MEMORY_INTEGRITY_KEYS, Object.keys(MEMORY_INTEGRITY_FIXTURE), ['integrityOk']),
    [],
    'MemoryIntegrityDto 出现了探针之外的字段'
  )
  // `integrity` / `integrityOk` 是**跨权威**的派生（来自 M5-PRE 探针 / 四类合计），显式列出：
  expect.ok(MEMORY_STATS_KEYS.includes('integrity'))
  expect.ok(MEMORY_INTEGRITY_KEYS.includes('integrityOk'))
})

test('查询能力登记表：8 个端点，每个都有非空 authority', () => {
  expect.equal(DEVELOPER_QUERY_CAPABILITY_IDS.length, 8)
  for (const id of DEVELOPER_QUERY_CAPABILITY_IDS) {
    const fact = DEVELOPER_QUERY_CAPABILITY_FACTS[id]
    expect.ok(fact !== undefined, `能力 ${id} 没有登记事实`)
    expect.ok(fact.authority.trim() !== '', `能力 ${id} 的 authority 为空`)
    assertDeveloperCapabilityFact(fact)
  }
})

test('DeveloperLookup：三态可区分（找到 / 没找到 / 今天填不出来）', async () => {
  assertDeveloperLookup({ found: true, value: 'x' })
  const missing = notFound('not_found', '这条 trace 不存在')
  assertDeveloperLookup(missing)
  expect.equal(missing.found, false)
  expect.equal(missing.reasonCode, 'not_found')

  await expect.rejects(
    async () => assertDeveloperLookup({ found: true, value: 'x', reasonCode: 'not_found' } as never),
    'developer_lookup_found_with_reason'
  )
  await expect.rejects(
    async () =>
      assertDeveloperLookup({
        found: false,
        reasonCode: 'not_found',
        reason: 'x',
        value: 'y',
      } as never),
    'developer_lookup_notfound_with_value'
  )
  await expect.rejects(async () => notFound('not_found', '   '), 'developer_lookup_reason_required')
  await expect.rejects(async () => unavailable('  '), 'developer_availability_reason_required')
  expect.deepEqual(AVAILABLE, { status: 'available' })
})

test('派生字段只有一个算法（duration 未结束/时间倒退 → 缺省，不是 0）', () => {
  expect.equal(developerDurationMs(1000, 1010), 10)
  expect.equal(developerDurationMs(1000), undefined)
  expect.equal(developerDurationMs(1010, 1000), undefined)

  const derived = summarizeTraceDerived(TRACE_FIXTURE)
  expect.equal(derived.stepCount, 1)
  expect.equal(derived.durationMs, 10)
  expect.equal(derived.hasError, false)
  expect.equal(summarizeTraceDerived({ ...TRACE_FIXTURE, error: '失败了' }).hasError, true)
})

// ===========================================================================
group('序列化稳定')
// ===========================================================================

const COMMAND_FIXTURE = createControlCommand({
  commandId: 'cmd-fixture-1',
  idempotencyKey: 'idem-fixture-1',
  type: 'RUN_DIAGNOSTIC',
  dryRun: true,
  surface: 'cli',
  createdAt: 1_700_000_000_000,
  parameters: { scope: 'memory', limit: 20 },
  characterId: 'sumuwei',
})

test('serialize → parse 往返幂等（同一条命令两次序列化逐字相同）', () => {
  const text = serializeControlCommand(COMMAND_FIXTURE)
  const parsed = parseControlCommand(JSON.parse(text))
  expect.equal(serializeControlCommand(parsed), text, 'serialize ∘ parse 必须是恒等')
})

test('键序不影响序列化与摘要（复用契约层的稳定材料）', () => {
  const shuffled: ControlCommand = {
    parameters: { limit: 20, scope: 'memory' },
    type: 'RUN_DIAGNOSTIC',
    dryRun: true,
    createdAt: 1_700_000_000_000,
    idempotencyKey: 'idem-fixture-1',
    commandId: 'cmd-fixture-1',
    characterId: asCharacterId('sumuwei'),
    requestedBy: { surface: 'cli', kind: 'developer' },
    schemaVersion: CONTROL_SCHEMA_VERSION,
  }
  expect.equal(
    serializeControlCommand(shuffled),
    serializeControlCommand(COMMAND_FIXTURE),
    '键序不该影响规范 JSON'
  )
  expect.equal(controlCommandDigest(shuffled), controlCommandDigest(COMMAND_FIXTURE))
})

test('摘要对固定 fixture 有硬编码期望值（字节级漂移锁）', () => {
  // ⚠️ 这个值只有在**有意改变**规范序列化时才允许更新。
  //    它存在的意义是：任何人顺手改一下 canonicalMaterial，这条测试立刻变红。
  //    已用一份**独立实现**复核过（FNV-1a/64 over 对象的稳定材料，不套引号）。
  expect.equal(
    controlCommandDigest(COMMAND_FIXTURE),
    '926acca306405631',
    '规范摘要变了 —— 先确认那是有意的，再更新这个期望值'
  )
  // 规范 JSON 的**字节形态**同样是判据的一部分（摘要的材料就是它，不带外层引号）
  expect.equal(
    serializeControlCommand(COMMAND_FIXTURE),
    '{"characterId":"sumuwei","commandId":"cmd-fixture-1","createdAt":1700000000000,' +
      '"dryRun":true,"idempotencyKey":"idem-fixture-1","parameters":{"limit":20,"scope":"memory"},' +
      '"requestedBy":{"kind":"developer","surface":"cli"},"schemaVersion":1,"type":"RUN_DIAGNOSTIC"}',
    'serializeControlCommand 输出的必须仍是紧凑、键有序的 JSON'
  )
})

test('游标编解码往返 + 越界/畸形/坏 id 一律拒绝', async () => {
  const cursor = encodeDeveloperCursor({ startedAt: 1_700_000_000_000, id: 'trace:abc.def' })
  assertDeveloperCursor(cursor)
  const key = decodeDeveloperCursor(cursor)
  expect.equal(key.startedAt, 1_700_000_000_000)
  expect.equal(key.id, 'trace:abc.def')

  await expect.rejects(async () => decodeDeveloperCursor('not-a-cursor'), 'developer_cursor_malformed')
  await expect.rejects(async () => decodeDeveloperCursor('v1'), 'developer_cursor_malformed')
  await expect.rejects(async () => decodeDeveloperCursor('v1.5.'), 'developer_cursor_bad_id')
  await expect.rejects(
    async () => decodeDeveloperCursor(`v1.5.${'x'.repeat(DEVELOPER_QUERY_LIMITS.maxCursorLength)}`),
    'developer_cursor_too_long'
  )
  await expect.rejects(
    async () => encodeDeveloperCursor({ startedAt: 1.5, id: 'a' }),
    'developer_cursor_bad_started_at'
  )
  await expect.rejects(
    async () => encodeDeveloperCursor({ startedAt: 5, id: '  ' }),
    'developer_cursor_bad_id'
  )
})

// ===========================================================================
group('必填字段与失败关闭')
// ===========================================================================

test('idempotencyKey 缺省即拒绝（AT3.3）', async () => {
  await expect.rejects(
    async () => createControlCommand({ commandId: 'cmd-1', type: 'RUN_DIAGNOSTIC' }),
    'control_missing_idempotency_key'
  )
  await expect.rejects(
    async () => createControlCommand({ commandId: '   ', idempotencyKey: 'k', type: 'RUN_DIAGNOSTIC' }),
    'control_missing_command_id'
  )
})

test('未知命令 → REJECT（fail closed，AT3.1）', async () => {
  await expect.rejects(async () => assertControlCommandAllowed('DROP_TABLE'), 'command_not_allowed')
  await expect.rejects(
    async () => createControlCommand({ commandId: 'c', idempotencyKey: 'k', type: 'NOPE' as never }),
    'command_not_allowed'
  )
})

test('AT3.5 的七个禁止命令逐个被拒（理由是 command_forbidden，不是 not_allowed）', async () => {
  expect.equal(FORBIDDEN_CONTROL_COMMANDS.length, 7)
  for (const type of FORBIDDEN_CONTROL_COMMANDS) {
    await expect.rejects(async () => assertControlCommandAllowed(type), 'command_forbidden')
  }
})

test('白名单与禁止清单不相交（登记表自洽）', () => {
  assertControlRegistryConsistent()
  const overlap = (CONTROL_COMMAND_TYPES as readonly string[]).filter((type) =>
    (FORBIDDEN_CONTROL_COMMANDS as readonly string[]).includes(type)
  )
  expect.deepEqual(overlap, [], 'AT3.5 的禁止与 AT3.1 的白名单必须互斥')
  expect.equal(CONTROL_COMMAND_TYPES.length, 2)
})

test('M5.1 的命令都是只读的；领域 mutation 会被拦下（STOP 条件 14 的闸）', async () => {
  for (const type of CONTROL_COMMAND_TYPES) {
    expect.equal(CONTROL_COMMAND_FACTS[type].mutatesDomain, false, `${type} 必须是只读命令`)
  }
  // 负控：把"会改变领域"这个事实喂进去，闸必须响
  const mutating: ControlledCommandFact = {
    ...CONTROL_COMMAND_FACTS.RUN_DIAGNOSTIC,
    mutatesDomain: true,
  }
  await expect.rejects(async () => assertDeveloperSurfaceAllowed(mutating), 'would_mutate_domain')
})

test('dryRun 闸：没有声明支持 dryRun 就不许 dryRun（负控走事实层谓词）', async () => {
  assertControlDryRunSupported('RUN_DIAGNOSTIC', true)
  const noDryRun: ControlledCommandFact = {
    ...CONTROL_COMMAND_FACTS.RUN_AUDIT,
    supportsDryRun: false,
  }
  await expect.rejects(
    async () => assertDryRunSupportedByFact(noDryRun, true),
    'dry_run_not_supported'
  )
  // dryRun=false 时不该被这条闸拦住
  assertDryRunSupportedByFact(noDryRun, false)
})

test('入参解析：每个 query 都有唯一入口，未知字段/越界/坏枚举一律拒绝', async () => {
  const list = parseTraceListQuery({ characterId: 'sumuwei', limit: 10, cursor: 'v1.5.abc' })
  expect.equal(list.characterId, 'sumuwei')
  expect.equal(list.limit, 10)
  expect.equal(list.cursor, 'v1.5.abc')
  expect.equal(resolveDeveloperLimit({}), DEVELOPER_QUERY_LIMITS.defaultLimit)
  expect.equal(resolveDeveloperLimit({ limit: 5 }), 5)

  const detail = parseTraceGetQuery({ characterId: 'sumuwei', traceId: 'trace-1' })
  expect.equal(detail.traceId, 'trace-1')

  expect.equal(parseMemoryStatsQuery({ characterId: 'sumuwei' }).characterId, 'sumuwei')
  expect.equal(
    parseMemoryIntegrityQuery({ characterId: 'sumuwei', maxRows: 5 }).maxRows,
    5
  )
  expect.equal(
    parseExecutionListQuery({ characterId: 'sumuwei', status: 'success' }).status,
    'success'
  )
  expect.equal(
    parseExecutionGetQuery({ characterId: 'sumuwei', actionId: 'action-1' }).actionId,
    'action-1'
  )

  await expect.rejects(
    async () => parseTraceListQuery({ characterId: 'sumuwei', orderBy: 'x' }),
    'developer_query_unknown_field'
  )
  await expect.rejects(
    async () => parseTraceListQuery({ characterId: 'sumuwei', limit: 0 }),
    'developer_limit_out_of_range'
  )
  await expect.rejects(
    async () => parseTraceListQuery({ characterId: 'sumuwei', limit: 101 }),
    'developer_limit_out_of_range'
  )
  await expect.rejects(
    async () => parseTraceListQuery({ characterId: 'sumuwei', status: 'ok' }),
    'developer_query_bad_trace_status'
  )
  await expect.rejects(async () => parseTraceListQuery({}), 'developer_query_missing_character_id')
  await expect.rejects(
    async () => parseTraceGetQuery({ characterId: 'sumuwei' }),
    'developer_query_missing_trace_id'
  )
  await expect.rejects(
    async () => parseMemoryIntegrityQuery({ characterId: 'sumuwei', maxRows: 0 }),
    'developer_query_bad_max_rows'
  )
  await expect.rejects(
    async () =>
      parseMemoryIntegrityQuery({
        characterId: 'sumuwei',
        maxRows: DEVELOPER_QUERY_LIMITS.maxIntegrityRows + 1,
      }),
    'developer_query_bad_max_rows'
  )
})

test('assertDeveloperLimit：越界不夹住、非整数不放过', async () => {
  expect.equal(assertDeveloperLimit(20), 20)
  await expect.rejects(async () => assertDeveloperLimit(0), 'developer_limit_out_of_range')
  await expect.rejects(async () => assertDeveloperLimit(101), 'developer_limit_out_of_range')
  await expect.rejects(async () => assertDeveloperLimit(1.5), 'developer_bad_limit')
  await expect.rejects(async () => assertDeveloperLimit(Number.NaN), 'developer_bad_limit')
})

test('parseControlCommand 拒绝 schemaVersion 不匹配、坏 surface、坏 requester、坏 dryRun', async () => {
  const raw = JSON.parse(serializeControlCommand(COMMAND_FIXTURE)) as Record<string, unknown>
  await expect.rejects(
    async () => parseControlCommand({ ...raw, schemaVersion: 99 }),
    'control_schema_version_mismatch'
  )
  await expect.rejects(
    async () => parseControlCommand({ ...raw, requestedBy: { kind: 'developer', surface: 'telepathy' } }),
    'control_command_bad_surface'
  )
  await expect.rejects(
    async () => parseControlCommand({ ...raw, requestedBy: { kind: 'character', surface: 'cli' } }),
    'control_command_bad_requester'
  )
  await expect.rejects(
    async () => parseControlCommand({ ...raw, dryRun: 'yes' }),
    'control_command_bad_dry_run'
  )
})

test('命令参数必须是标量且有界（长文本会让隐私形态失效）', async () => {
  await expect.rejects(
    async () =>
      createControlCommand({
        commandId: 'c',
        idempotencyKey: 'k',
        type: 'RUN_AUDIT',
        parameters: { nested: { a: 1 } as never },
      }),
    'control_parameter_not_scalar'
  )
  await expect.rejects(
    async () =>
      createControlCommand({
        commandId: 'c',
        idempotencyKey: 'k',
        type: 'RUN_AUDIT',
        parameters: { note: 'x'.repeat(CONTROL_LIMITS.maxParameterValueLength + 1) },
      }),
    'control_parameter_too_long'
  )
})

// ===========================================================================
group('执行状态区分（AT1.1 / AT1.2 / AT3.6）')
// ===========================================================================

const EVIDENCE_OF = {
  accepted: 'control_registry',
  attempted: 'developer_control_trace',
  executed: 'diagnostic_executor',
  verification: 'diagnostic_report',
}

const failure: ActionFailure = actionFailure('execution_failed', '诊断钩子返回非零')

const BASE: ControlResult = {
  schemaVersion: CONTROL_SCHEMA_VERSION,
  commandId: 'cmd-base',
  idempotencyKey: 'k',
  commandType: 'RUN_DIAGNOSTIC',
  outcome: 'rejected',
  disposition: 'none',
  accepted: false,
  attempted: false,
  executed: false,
  verification: 'not_attempted',
  evidenceOf: EVIDENCE_OF,
  dryRun: false,
  startedAt: 1000,
}

/** AT3.6 的五档，逐档显式构造（共用工厂会把"它们真的不同"这件事藏起来） */
const SCENARIO_REJECTED: ControlResult = { ...BASE, reasonCode: 'command_not_allowed' }

const SCENARIO_ACCEPTED: ControlResult = {
  ...BASE,
  commandId: 'cmd-accepted',
  outcome: 'accepted',
  accepted: true,
}

const SCENARIO_ATTEMPTED_FAILED: ControlResult = {
  ...BASE,
  commandId: 'cmd-attempted',
  outcome: 'attempted',
  disposition: 'failed',
  accepted: true,
  attempted: true,
  error: failure,
  finishedAt: 1005,
}

const SCENARIO_EXECUTED_VERIFICATION_FAILED: ControlResult = {
  ...BASE,
  commandId: 'cmd-executed',
  outcome: 'executed',
  disposition: 'succeeded',
  accepted: true,
  attempted: true,
  executed: true,
  verification: 'failed',
  finishedAt: 1010,
}

const SCENARIO_VERIFIED: ControlResult = {
  ...SCENARIO_EXECUTED_VERIFICATION_FAILED,
  commandId: 'cmd-verified',
  outcome: 'verified',
  verification: 'verified',
  verificationEvidence: '诊断报告已在同一 trace 上重读，计数一致',
}

const ALL_SCENARIOS = [
  SCENARIO_REJECTED,
  SCENARIO_ACCEPTED,
  SCENARIO_ATTEMPTED_FAILED,
  SCENARIO_EXECUTED_VERIFICATION_FAILED,
  SCENARIO_VERIFIED,
]

test('五档必须两两不同（判据只取真实字段，不看 id 与时间戳）', () => {
  for (const result of ALL_SCENARIOS) assertControlResult(result)
  const prints = ALL_SCENARIOS.map(controlResultFingerprint)
  expect.equal(new Set(prints).size, 5, '两档被判据看成同一个 —— 那这个判据区分不了 AT3.6 的场景')
})

test('五档的可读摘要也逐档不同（人看的那一份同样区分得开）', () => {
  const lines = ALL_SCENARIOS.map(describeControlResult)
  expect.equal(new Set(lines).size, 5)
  expect.includes(lines[0], 'rejected')
  expect.includes(lines[4], 'verified')
})

test('阶梯 → 布尔只有一处映射，且结果必须与它逐字一致', async () => {
  expect.deepEqual(controlLadderBooleansOf('rejected'), {
    accepted: false,
    attempted: false,
    executed: false,
  })
  expect.deepEqual(controlLadderBooleansOf('verified'), {
    accepted: true,
    attempted: true,
    executed: true,
  })
  const table = (['rejected', 'accepted', 'attempted', 'executed', 'verified'] as const).map((stage) =>
    controlLadderBooleansOf(stage)
  )
  expect.equal(new Set(table.map((item) => JSON.stringify(item))).size, 4)
  await expect.rejects(
    async () => assertControlResult({ ...SCENARIO_ACCEPTED, executed: true }),
    'control_result_ladder_inconsistent'
  )
})

test('违规组合必须逐个被拒（九条负控）', async () => {
  await expect.rejects(
    async () => assertControlResult({ ...SCENARIO_REJECTED, accepted: true }),
    'control_result_ladder_inconsistent'
  )
  await expect.rejects(
    async () => assertControlResult({ ...SCENARIO_REJECTED, disposition: 'failed' }),
    'control_rejected_with_disposition'
  )
  await expect.rejects(
    async () => assertControlResult({ ...BASE, commandId: 'r2', reasonCode: undefined, error: undefined }),
    'control_rejected_without_reason'
  )
  await expect.rejects(
    async () => assertControlResult({ ...SCENARIO_ACCEPTED, disposition: 'succeeded' }),
    'control_accepted_with_disposition'
  )
  await expect.rejects(
    async () =>
      assertControlResult({ ...SCENARIO_EXECUTED_VERIFICATION_FAILED, disposition: 'cancelled' }),
    'control_executed_bad_disposition'
  )
  await expect.rejects(
    async () => assertControlResult({ ...SCENARIO_ATTEMPTED_FAILED, error: undefined }),
    'control_attempted_without_error'
  )
  // "executed 但 verification=verified" —— 核验不允许由执行推导
  await expect.rejects(
    async () =>
      assertControlResult({ ...SCENARIO_EXECUTED_VERIFICATION_FAILED, verification: 'verified' }),
    'control_verified_but_ladder_behind'
  )
  await expect.rejects(
    async () => assertControlResult({ ...SCENARIO_ACCEPTED, verification: 'failed' }),
    'control_verification_failed_without_execution'
  )
  await expect.rejects(
    async () => assertControlResult({ ...SCENARIO_VERIFIED, verificationEvidence: '  ' }),
    'control_verified_without_evidence'
  )
  await expect.rejects(
    async () =>
      assertControlResult({ ...BASE, evidenceOf: { ...EVIDENCE_OF, executed: '' } }),
    'control_result_evidence_missing'
  )
  // 登记期理由码不许出现在非 rejected 的结果上
  await expect.rejects(
    async () =>
      assertControlResult({
        ...SCENARIO_EXECUTED_VERIFICATION_FAILED,
        reasonCode: 'command_forbidden',
      }),
    'control_result_bad_reason_stage'
  )
})

test('verification 是四态，不是 boolean（AT3.6 的核心）', async () => {
  expect.equal(CONTROL_VERIFICATIONS.length, 4)
  expect.ok(CONTROL_VERIFICATIONS.includes('not_attempted'))
  expect.ok(CONTROL_VERIFICATIONS.includes('failed'))
  await expect.rejects(
    async () =>
      assertControlResult({ ...SCENARIO_EXECUTED_VERIFICATION_FAILED, verification: 'maybe' as never }),
    'control_bad_verification'
  )
})

test('DeveloperExecutionDetailDto：verified 必须有证据，且不能没执行过（AT2.5）', async () => {
  const detail: DeveloperExecutionDetailDto = {
    actionId: asActionId('action-1'),
    traceId: asTraceId('trace-1'),
    capability: 'system.echo',
    operation: 'echo',
    accepted: true,
    executed: true,
    attempted: true,
    status: 'success',
    sideEffect: 'none',
    idempotentReplay: false,
    requestedAt: 1000,
    startedAt: 1001,
    finishedAt: 1002,
    durationMs: 1,
    intent: { kind: 'current_fact', availability: AVAILABLE },
    request: {
      capability: 'system.echo',
      operation: 'echo',
      requestedByKind: 'system',
      sideEffect: 'none',
      argumentKeys: ['text'],
      createdAt: 1000,
    },
    attempt: { attempted: true, startedAt: 1001, evidenceRef: 'ACTION_STARTED' },
    result: { status: 'success', executed: true, effectKind: 'echo' },
    verification: { state: 'not_attempted' },
    evidence: [{ kind: 'adapter', detail: 'echo adapter returned' }],
    /*
     * WP7：这条夹具**没有** attribution 信封（历史行的形状），
     * 因此按 K-30 裁定两个计数都**必须是 0** ——
     * "没有记录过归因"不产生未知，但它也**不是**"字段缺席"（这是响应自己的字段）。
     */
    counts: { unknownSlotCount: 0, recordsWithUnknownCount: 0 },
  }
  assertDeveloperExecutionDetail(detail)

  // 负控：生产者自己编一个计数 ⇒ 契约不变量必须拒（数字对不上就是错的）
  await expect.rejects(
    async () =>
      assertDeveloperExecutionDetail({
        ...detail,
        counts: { unknownSlotCount: 1, recordsWithUnknownCount: 1 },
      }),
    'developer_attribution_counts_mismatch'
  )

  await expect.rejects(
    async () =>
      assertDeveloperExecutionDetail({
        ...detail,
        verification: { state: 'verified', evidence: '   ' },
      }),
    'developer_execution_verified_without_evidence'
  )
  await expect.rejects(
    async () =>
      assertDeveloperExecutionDetail({
        ...detail,
        executed: false,
        verification: { state: 'verified', evidence: 'x' },
      }),
    'developer_execution_verified_without_execution'
  )
  await expect.rejects(
    async () => assertDeveloperExecutionDetail({ ...detail, attempted: false }),
    'developer_execution_executed_without_attempt'
  )
  await expect.rejects(
    async () =>
      assertDeveloperExecutionDetail({
        ...detail,
        accepted: false,
        attempted: true,
      }),
    'developer_execution_attempted_without_accept'
  )
})

test('被拒绝的结果必须能说出它试图执行什么（WP3 补强）', async () => {
  /*
   * AT3.5 的全部意义是让"有人试图执行 RESET_KERNEL"这件事**被记下来**。
   * 因此 rejected 的结果允许带一个**不在白名单里**的 commandType；
   * 而**声称执行过**的结果必须真的在白名单里 —— 后者是这一条的另一半。
   */
  const forbiddenAttempt: ControlResult = {
    ...SCENARIO_REJECTED,
    commandId: 'cmd-forbidden-attempt',
    commandType: 'RESET_KERNEL',
    reasonCode: 'command_forbidden',
  }
  assertControlResult(forbiddenAttempt)
  expect.equal(forbiddenAttempt.commandType, 'RESET_KERNEL')

  // 反面：**执行过**的结果不许带未知类型
  await expect.rejects(
    async () => assertControlResult({ ...SCENARIO_EXECUTED_VERIFICATION_FAILED, commandType: 'RESET_KERNEL' }),
    'command_forbidden'
  )
  // 空类型也不许（被拒绝也要能说出它是什么）
  await expect.rejects(
    async () => assertControlResult({ ...SCENARIO_REJECTED, commandType: '  ' }),
    'control_rejected_without_type'
  )
})

test('源码级静态锁：契约里不许出现名为 success 的布尔成员（AT1.2）', () => {
  const offenders: string[] = []
  for (const file of CONTRACT_FILES) {
    readContract(file)
      .split('\n')
      .forEach((line, index) => {
        if (/^\s*success\s*\??\s*:/.test(line)) {
          offenders.push(`${file}:${index + 1} ${line.trim()}`)
        }
      })
  }
  expect.deepEqual(offenders, [], 'AT1.2 明令：禁止单一 success: boolean 取代真实执行语义')
})

// ===========================================================================
group('敏感字段负控（AT1.4）')
// ===========================================================================

const SECRET_SENTINEL = 'sk-SENTINEL-9f3a7c-DO-NOT-LEAK'
const MEMORY_BODY_SENTINEL = '她最喜欢的水饺是韭菜鸡蛋的'
const PROMPT_SENTINEL = '你是苏沐薇，一个持续存在的角色'

test('正控：白名单允许的键全部通过', () => {
  assertTelemetryAttributesAllowed({
    trace_id: 'trace-1',
    span_id: 'span-1',
    parent_span_id: 'span-0',
    stage: 'recall',
    status: 'ok',
    reason_code: 'LOW_RELEVANCE',
    candidate_count: 12,
    selected_count: 3,
    duration_ms: 42,
    budget_tokens: 800,
    input_tokens: 1234,
    output_tokens_count: 56,
    model_id: 'fixture-model',
    provider: 'fixture-provider',
    seed_version: 3,
    selected_ids_count: 2,
    accepted: true,
    attempted: true,
    executed: true,
    verification: 'not_attempted',
    dry_run: false,
    capability: 'system.echo',
    operation: 'echo',
    outcome: 'executed',
  })
})

test('负控：敏感键名逐个必须被拒（fail closed）', async () => {
  const denied = [
    'api_key',
    'access_token',
    'refresh_token',
    'prompt_text',
    'system_prompt',
    'memory_body',
    'memory_content',
    'credential',
    'authorization',
    'user_message',
    'raw_memory',
    'transcript',
  ]
  for (const key of denied) {
    await expect.rejects(
      async () => assertTelemetryAttributesAllowed({ [key]: 'x' }),
      'telemetry_sensitive_attribute'
    )
  }
})

test('反绕过：api_key_id 不许因为 _id 后缀而蒙混过关（敏感段优先）', async () => {
  expect.equal(isSensitiveAttributeKey('api_key_id'), true)
  expect.equal(isSensitiveAttributeKey('access_token_ids'), true)
  expect.equal(isSensitiveAttributeKey('system_prompt_version'), true)
  await expect.rejects(
    async () => assertTelemetryAttributesAllowed({ api_key_id: 'x' }),
    'telemetry_sensitive_attribute'
  )
  // 反面：合法的 ID 不许被误伤
  expect.equal(isSensitiveAttributeKey('memory_id'), false)
  expect.equal(isTelemetryAttributeAllowed('memory_id'), true)
  expect.equal(isTelemetryAttributeAllowed('character_id'), true)
  expect.equal(isTelemetryAttributeAllowed('input_tokens'), true)
  expect.equal(isTelemetryAttributeAllowed('action_id'), true)
})

test('默认拒绝：白名单外的普通键也要被拒（不是默认允许）', async () => {
  expect.equal(isTelemetryAttributeAllowed('notes'), false)
  expect.equal(isTelemetryAttributeAllowed('extra_thing'), false)
  await expect.rejects(
    async () => assertTelemetryAttributesAllowed({ notes: '随便一句' }),
    'telemetry_attribute_not_allowed'
  )
})

test('量具自检：抛错信息只报键名，**绝不回显取值**', async () => {
  const cases: [Record<string, string>, string][] = [
    [{ api_key: SECRET_SENTINEL }, SECRET_SENTINEL],
    [{ memory_body: MEMORY_BODY_SENTINEL }, MEMORY_BODY_SENTINEL],
    [{ system_prompt: PROMPT_SENTINEL }, PROMPT_SENTINEL],
    [{ notes: SECRET_SENTINEL }, SECRET_SENTINEL],
  ]
  for (const [attributes, sentinel] of cases) {
    let thrown: unknown
    try {
      assertTelemetryAttributesAllowed(attributes)
    } catch (error) {
      thrown = error
    }
    expect.ok(thrown !== undefined, '这组 attributes 本该被拒')
    const message = String((thrown as Error).message)
    expect.notIncludes(
      message,
      sentinel,
      '守卫在异常消息里回显了它拒绝泄漏的取值 —— 那它自己就是泄漏点'
    )
    expect.includes(message, Object.keys(attributes)[0])
  }
})

test('值长度有界（长文本会随遥测外发且不可撤回）', async () => {
  await expect.rejects(
    async () =>
      assertTelemetryAttributesAllowed({
        reason_code: 'x'.repeat(OBSERVABILITY_LIMITS.maxAttributeValueLength + 1),
      }),
    'telemetry_attribute_value_too_long'
  )
})

test('政策描述必须同时点出"键级白名单"与"值级哨兵"的分工', () => {
  const text = describeSensitiveDataPolicy()
  expect.includes(text, 'assertNoMemoryContentInTrace')
  expect.includes(text, '优先')
  expect.ok(TELEMETRY_ATTRIBUTE_ALLOWLIST.length > 30)
  expect.ok(TELEMETRY_ATTRIBUTE_PATTERNS.includes('_id'))
  expect.ok(SENSITIVE_ATTRIBUTE_KEY_SEGMENTS.includes('key'))
})

test('WP4：既有 wire 键的别名表必须是**有限**的，且每个别名都指向白名单里的规范名', async () => {
  /*
   * 别名表是"既有导出路径用点号键、规范白名单用下划线键"这个实测差距的**有限登记**。
   * 它不许变成后门：每个别名的目标都必须是白名单（或模式）认得的规范名。
   */
  const aliasEntries = Object.entries(TELEMETRY_LEGACY_ATTRIBUTE_ALIASES)
  expect.ok(aliasEntries.length > 0 && aliasEntries.length <= 20, `别名 ${aliasEntries.length} 条`)
  const badTargets = aliasEntries.filter(
    ([, canonical]) => !isTelemetryAttributeAllowed(canonical)
  )
  expect.deepEqual(
    badTargets.map(([legacy, canonical]) => `${legacy} → ${canonical}`),
    [],
    '别名指向了一个不在白名单里的规范名 —— 那它就是在开一个后门'
  )
  // 敏感段优先：别名救不了敏感键
  expect.equal(isTelemetryAttributeAllowedIncludingLegacy('api.key'), false)
  expect.equal(isTelemetryAttributeAllowedIncludingLegacy('character.id'), true)
  // 落在政策之外的键被**钉住**（不许悄悄增长）
  expect.deepEqual(
    [...TELEMETRY_LEGACY_KEYS_OUTSIDE_POLICY].sort(),
    ['error.message', 'span.kind.source', 'step.label'],
    '既有 payload 里"超出 AT1.4 七类"的键集合变了 —— 要么收紧它，要么更新这条断言'
  )
  for (const key of TELEMETRY_LEGACY_KEYS_OUTSIDE_POLICY) {
    expect.equal(isLegacyAttributeOutsidePolicy(key), true)
  }
  /*
   * ⚠️ 实测到的更强结论：`error.message` **连敏感段规则都过不了**
   *    （`message` 是敏感段）。它在既有 payload 里能出去，
   *    正是因为**既有导出路径根本没有过白名单** ——
   *    这正是 WP4 要把它变成"有限且被钉住"的原因。
   */
  await expect.rejects(
    async () => assertTelemetryAttributesAllowed({ 'error.message': 'x' }),
    'telemetry_sensitive_attribute'
  )
})

// ===========================================================================
group('分类法完整性与无死值（AT1.3 / AT4.2）')
// ===========================================================================

test('阶段登记表自洽：每个阶段都有事实与生产者', () => {
  assertObservabilityRegistryConsistent()
  expect.equal(OBSERVABILITY_STAGES.length, 12)
  for (const stage of OBSERVABILITY_STAGES) {
    const fact = OBSERVABILITY_STAGE_FACTS[stage]
    expect.ok(fact.source.trim() !== '', `阶段 ${stage} 没有生产者`)
  }
})

test('recall 的子阶段确实挂在 recall 下（AT4.2）', () => {
  for (const sub of ['retrieve', 'eligibility', 'ranking', 'selection'] as const) {
    expect.equal(OBSERVABILITY_STAGE_FACTS[sub].parent, 'recall')
  }
  expect.equal(OBSERVABILITY_STAGE_FACTS.turn.parent, undefined)
  expect.equal(OBSERVABILITY_STAGE_FACTS.developer_control.parent, undefined)
})

test('stageOfTraceStepKind：已知字面量给出确定映射，未知字符串返回 unknown 且不抛', () => {
  expect.equal(stageOfTraceStepKind('context_compile'), 'context')
  expect.equal(stageOfTraceStepKind('memory_recall'), 'recall')
  expect.equal(stageOfTraceStepKind('model_generate'), 'model')
  expect.equal(stageOfTraceStepKind('action_dispatch'), 'action')
  expect.equal(stageOfTraceStepKind('transport_deliver'), 'response')
  expect.equal(stageOfTraceStepKind('model_call'), 'model')
  // TraceStepKind 末尾有 | (string & {})（逃生口）—— 未知 step 不该让整轮失败
  expect.equal(stageOfTraceStepKind('some_future_step'), 'unknown')
  // 映射出来的每一个阶段都必须是已登记的阶段
  for (const stage of Object.values(OBSERVABILITY_STAGE_FACTS)) {
    expect.ok(OBSERVABILITY_STAGES.includes(stage.stage))
  }
})

test('如实报告：今天还没有产出者的阶段 / 还没有受控理由词汇的阶段', () => {
  const unstaged = unstagedObservabilityStages()
  expect.ok(unstaged.includes('developer_control'), 'developer_control 今天确实没有 TraceStepKind 映射')
  expect.ok(unstaged.length > 0, '把"全都有产出者"当默认值，会让空缺永远不被发现')

  /*
   * WP4 之后，**12 个阶段全部都有受控理由码**（turn/context/model/response 在 WP4 补上，
   * 且每个都注明了真实生产者）。因此这里断言的是"没有空缺"，
   * 而不是"空缺存在" —— 而这个函数仍然要在：一旦将来有人加一个没有理由码的阶段，
   * 它就会如实列出来（那时这条断言会红，正好提醒更新它）。
   */
  const noReasons = stagesWithoutReasonCodes()
  expect.deepEqual(noReasons, [], '有阶段没有受控理由码 —— 要么补登记，要么如实更新这条断言')
  expect.notOk(noReasons.includes('eligibility'), 'eligibility 必须引用 M5 的排除理由词汇')
  expect.notOk(noReasons.includes('developer_control'))
  // 报告函数仍然只返回已登记的阶段（不许返回不存在的名字）
  for (const stage of unstaged) expect.ok(OBSERVABILITY_STAGES.includes(stage))
})

test('单一词汇：阶段理由码一律引用既有受控词汇，一个都不另造', () => {
  expect.deepEqual(OBSERVABILITY_STAGE_FACTS.eligibility.reasonCodes, RECALL_EXCLUSION_REASONS)
  expect.deepEqual(OBSERVABILITY_STAGE_FACTS.ranking.reasonCodes, RECALL_EXCLUSION_REASONS)
  expect.deepEqual(OBSERVABILITY_STAGE_FACTS.action.reasonCodes, ACTION_FAILURE_CODES)
  expect.deepEqual(OBSERVABILITY_STAGE_FACTS.developer_control.reasonCodes, CONTROL_REASON_CODES)
})

test('每个理由码都登记了产出者（拒绝"表达得了但永远触发不了"的死值）', () => {
  for (const code of CONTROL_REASON_CODES) {
    assertControlReasonCodeRegistered(code)
    const fact = CONTROL_REASON_CODE_FACTS[code]
    expect.ok(fact.producer.trim() !== '', `${code} 的 producer 为空`)
    expect.includes(describeControlReason(code), code)
  }
  for (const type of CONTROL_COMMAND_TYPES) {
    const fact = CONTROL_COMMAND_FACTS[type]
    expect.ok(fact.producer.trim() !== '', `${type} 的 producer 为空`)
    expect.ok(fact.authority.trim() !== '', `${type} 的 authority 为空`)
    for (const code of fact.reasonCodes) assertControlReasonCodeRegistered(code)
  }
})

test('span 断言：父子自环/未登记阶段/未登记理由码/未登记 provenance/坏时间必须被拒', async () => {
  const good: ObservabilitySpanInput = {
    traceId: 'trace-1',
    spanId: 'span-1',
    parentSpanId: 'span-0',
    stage: 'selection',
    name: 'memory.selection',
    status: 'ok',
    startedAt: 1000,
    finishedAt: 1010,
    reasonCode: 'BUDGET_EXHAUSTED',
    provenance: { character_trace: 'trace-1', recall_decision: 'decision-1' },
    attributes: { selected_count: 3, duration_ms: 10 },
  }
  assertObservabilitySpan(good)

  await expect.rejects(
    async () => assertObservabilitySpan({ ...good, parentSpanId: 'span-1' }),
    'observability_span_self_parent'
  )
  await expect.rejects(
    async () => assertObservabilitySpan({ ...good, stage: 'nope' as never }),
    'observability_unknown_stage'
  )
  await expect.rejects(
    async () => assertObservabilitySpan({ ...good, reasonCode: 'MADE_UP_REASON' }),
    'observability_reason_code_not_registered'
  )
  await expect.rejects(
    async () => assertObservabilitySpan({ ...good, provenance: { control_command: 'cmd-1' } }),
    'observability_provenance_not_allowed'
  )
  await expect.rejects(
    async () => assertObservabilitySpan({ ...good, finishedAt: 999 }),
    'observability_end_before_start'
  )
  await expect.rejects(
    async () => assertObservabilitySpan({ ...good, attributes: { api_key: 'x' } }),
    'telemetry_sensitive_attribute'
  )
  await expect.rejects(
    async () => assertObservabilitySpan({ ...good, status: 'green' as never }),
    'observability_bad_status'
  )
})

test('duration 是算出来的，不是第二个字段（未结束 / 倒退 → 缺省）', () => {
  expect.equal(spanDurationMs({ startedAt: 1000, finishedAt: 1010 }), 10)
  expect.equal(spanDurationMs({ startedAt: 1000 }), undefined)
  expect.equal(spanDurationMs({ startedAt: 1010, finishedAt: 1000 }), undefined)
})

test('AT4.3 相关性：五个关联键可被摊平；不强制共用同一个 id', () => {
  const span: ObservabilitySpanInput = {
    traceId: 'trace-1',
    spanId: 'span-1',
    stage: 'action',
    name: 'action.dispatch',
    status: 'ok',
    startedAt: 1000,
    provenance: { character_trace: 'trace-1', action_ledger: 'action-1' },
    attributes: { status: 'ok' },
  }
  const correlation = correlationOf(span)
  expect.equal(correlation.traceId, 'trace-1')
  expect.equal(correlation.executionId, 'action-1')
  expect.equal(correlation.controlCommandId, undefined, '没有命令时不该编一个出来')

  const commandSpan: ObservabilitySpanInput = {
    ...span,
    stage: 'developer_control',
    reasonCode: 'command_not_allowed',
    provenance: { control_command: 'cmd-1' },
  }
  assertObservabilitySpan(commandSpan)
  expect.equal(correlationOf(commandSpan).controlCommandId, 'cmd-1')
  expect.equal(correlationOf(commandSpan).executionId, undefined)
})

test('provenance 种类登记表完整（AT4.3 的五个关联键都在）', () => {
  expect.equal(OBSERVABILITY_PROVENANCE_KINDS.length, 5)
  expect.deepEqual(OBSERVABILITY_PROVENANCE_KINDS, [
    'character_trace',
    'recall_decision',
    'action_ledger',
    'control_command',
    'memory_integrity',
  ])
  expect.equal(OBSERVABILITY_SCHEMA_VERSION, 1)
  expect.equal(DEVELOPER_QUERY_SCHEMA_VERSION, 1)
  expect.equal(CONTROL_SCHEMA_VERSION, 1)
})

// ===========================================================================
group('零基础设施依赖（静态锁）')
// ===========================================================================

test('三个新契约文件的 import 全部落在允许范围内', () => {
  /** 允许的跨模块 import：只有 M4.5 的失败语义（在 developer-control.ts 头部有逐条交代） */
  const ALLOWED_EXTERNAL = ['../action/errors.ts']
  const offenders: string[] = []

  for (const file of CONTRACT_FILES) {
    const imports = importLinesOf(readContract(file))
    for (const specifier of imports.match(/from\s+'([^']+)'/g) ?? []) {
      const path = specifier.replace(/^from\s+'/, '').replace(/'$/, '')
      if (path.startsWith('./')) continue
      if (ALLOWED_EXTERNAL.includes(path)) continue
      offenders.push(`${file} → ${path}`)
    }
  }
  expect.deepEqual(
    offenders,
    [],
    '契约层新增了未交代的跨模块 import：多一条就要先说明它为什么不是第二套真相'
  )
})

test('三个新契约文件不 import 任何框架 / SQL / node:* / 观测后端', () => {
  const forbidden = ['@elizaos/', 'drizzle-orm', 'node:', 'phoenix', 'opentelemetry']
  const offenders: string[] = []
  for (const file of CONTRACT_FILES) {
    const imports = importLinesOf(readContract(file))
    for (const pattern of forbidden) {
      if (imports.includes(`'${pattern}`) || imports.includes(`"${pattern}`)) {
        offenders.push(`${file} → ${pattern}`)
      }
    }
  }
  expect.deepEqual(offenders, [], '契约层的依赖方向必须是单向的')
})

test('查询端口是只读的：8 个方法，没有任何写语义的方法名', () => {
  const source = readContract('developer-query.ts')
  for (const verb of ['insert', 'update', 'delete', 'append', 'mutate']) {
    expect.notOk(
      new RegExp(`\\b${verb}[A-Z]\\w*\\s*\\(`).test(source),
      `developer-query.ts 里出现了像写操作的方法名（${verb}）`
    )
  }
  expect.ok(source.includes('interface DeveloperQueryService'))
  expect.equal(DEVELOPER_QUERY_REASON_CODES.length, 4)
})

// ===========================================================================
// 证据（给 M5.1 的验收报告用）
// ===========================================================================

const summary = await runAll({ filter: process.argv[2] })
printSummary(summary, 'M5.1 WP1 开发者平面契约测试')

mkdirSync(join(process.cwd(), 'artifacts', 'm5.1'), { recursive: true })
writeFileSync(
  join(process.cwd(), 'artifacts', 'm5.1', 'wp1-contracts.json'),
  `${JSON.stringify(
    {
      testId: 'M5.1 / WP1 developer plane contracts',
      generatedAt: new Date().toISOString(),
      passed: summary.passed,
      failed: summary.failed,
      failures: summary.failures.map((item) => item.name),
      schemaVersions: {
        developerQuery: DEVELOPER_QUERY_SCHEMA_VERSION,
        developerControl: CONTROL_SCHEMA_VERSION,
        observability: OBSERVABILITY_SCHEMA_VERSION,
      },
      limits: {
        developerQuery: DEVELOPER_QUERY_LIMITS,
        control: CONTROL_LIMITS,
        observability: OBSERVABILITY_LIMITS,
      },
      queryCapabilities: DEVELOPER_QUERY_CAPABILITY_IDS.map((id) => ({
        ...DEVELOPER_QUERY_CAPABILITY_FACTS[id],
      })),
      queryReasonCodes: DEVELOPER_QUERY_REASON_CODES,
      controlCommands: CONTROL_COMMAND_TYPES.map((type) => ({ ...CONTROL_COMMAND_FACTS[type] })),
      forbiddenCommands: FORBIDDEN_CONTROL_COMMANDS,
      controlReasonCodes: CONTROL_REASON_CODES.map((code) => ({
        ...CONTROL_REASON_CODE_FACTS[code],
      })),
      controlLadder: (['rejected', 'accepted', 'attempted', 'executed', 'verified'] as const).map(
        (stage) => ({ stage, ...controlLadderBooleansOf(stage) })
      ),
      executionTruthScenarios: ALL_SCENARIOS.map((result) => ({
        commandId: result.commandId,
        outcome: result.outcome,
        disposition: result.disposition,
        accepted: result.accepted,
        attempted: result.attempted,
        executed: result.executed,
        verification: result.verification,
        fingerprint: controlResultFingerprint(result),
        description: describeControlResult(result),
      })),
      observabilityStages: OBSERVABILITY_STAGES.map((stage) => ({
        ...OBSERVABILITY_STAGE_FACTS[stage],
      })),
      unstagedStages: unstagedObservabilityStages(),
      stagesWithoutReasonCodes: stagesWithoutReasonCodes(),
      provenanceKinds: OBSERVABILITY_PROVENANCE_KINDS,
      sensitiveDataPolicy: {
        allowlist: TELEMETRY_ATTRIBUTE_ALLOWLIST,
        patterns: TELEMETRY_ATTRIBUTE_PATTERNS,
        sensitiveSegments: SENSITIVE_ATTRIBUTE_KEY_SEGMENTS,
        description: describeSensitiveDataPolicy(),
      },
      commandFixture: {
        commandId: COMMAND_FIXTURE.commandId,
        digest: controlCommandDigest(COMMAND_FIXTURE),
        serialized: serializeControlCommand(COMMAND_FIXTURE),
      },
      fieldGrounding: {
        traceSummaryKeys: TRACE_SUMMARY_KEYS,
        traceDerivedKeys: TRACE_DERIVED_KEYS,
        executionSummaryKeys: EXECUTION_SUMMARY_KEYS,
        executionSummaryDerivedKeys: EXECUTION_SUMMARY_DERIVED_KEYS,
        executionDetailKeys: EXECUTION_DETAIL_KEYS,
        executionDetailDerivedKeys: EXECUTION_DETAIL_DERIVED_KEYS,
        memoryStatsKeys: MEMORY_STATS_KEYS,
        memoryIntegrityKeys: MEMORY_INTEGRITY_KEYS,
      },
    },
    null,
    2
  )}\n`,
  'utf8'
)
console.log('证据已写入：artifacts/m5.1/wp1-contracts.json')

process.exit(summary.failed === 0 ? 0 : 1)
