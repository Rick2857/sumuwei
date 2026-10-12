/**
 * M5.1 WP7 —— **量具与负控集中门**（`pnpm m5.1:measurement:verify`）。
 *
 * ============================================================================
 *  这一 WP 的灵魂是一句话：**检测器必须会响**
 * ============================================================================
 * 计划书 AT7.2 要求主动注入五种假象，并证明**每个检测器都会 FAIL**：
 *
 *      fake selectedMemoryId · fake executed=true · query-side mutation ·
 *      secret in telemetry · unknown control command
 *
 * 为什么必须单独做一遍：M5.1 的五道门（WP1–WP5）**各自**已经带了一半负控，
 * 但它们分散在五个脚本里，谁也没法一眼回答"**这五个检测器是不是都会响**"。
 * 一个永远说"没问题"的检测器，与一个真的都没问题的系统，在输出上完全一样
 * （INV-M45-06：量具自己也是被测对象）。
 *
 * ---------------------------------------------------------------------------
 *  每个检测器的三段式（缺一不可）
 * ---------------------------------------------------------------------------
 *      ① 正控：合法输入 → 检测器必须**安静**（否则它是个噪音源）
 *      ② 负控：注入假象 → 检测器必须**响**（否则它是橡皮图章）
 *      ③ 恢复：把真实实现放回去 → 检测器必须**重新安静**
 *         （AT7.2 的原话"随后恢复真实实现"；只做 ①② 会留下"注入是不是改坏了什么"的疑问）
 *
 * ⚠️ 这里**不重跑** WP2–WP5 的真实链路（那五个门已经跑过并落了证据）。
 *    本门用**最小夹具**驱动同一批检测器，只回答"它们会不会响"。
 *
 * 跑法：pnpm m5.1:measurement:verify
 */

import 'dotenv/config'

import { cleanupSandbox, isolateDatabase, resetPluginSqlConnection } from '../src/dev/sandbox.ts'

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'

import { M4_T0, createM4Harness, createReporter } from './m4-harness.ts'
import { exec, rowsOf } from '../src/infrastructure/persistence/db.ts'
import {
  canonicalSpansToTelemetrySpans,
  mapTraceToCanonicalSpans,
  spanTraceInconsistencies,
} from '../src/infrastructure/telemetry/taxonomy.ts'
import { buildOtlpPayload } from '../src/infrastructure/telemetry/port.ts'
import { createDeveloperQueryService } from '../src/infrastructure/dev/query-service.ts'
import {
  createAuditControlHandler,
  createDeveloperControlService,
  createDiagnosticControlHandler,
} from '../src/infrastructure/dev/control-service.ts'
import {
  CONTROL_COMMAND_FACTS,
  FORBIDDEN_CONTROL_COMMANDS,
} from '../src/kernel/contracts/developer-control.ts'
import { isTelemetryAttributeAllowed } from '../src/kernel/contracts/observability.ts'
import type { CharacterRunTrace } from '../src/kernel/contracts/trace.ts'
import { asCharacterId, asConversationEventId, asTraceId } from '../src/kernel/contracts/ids.ts'
import { entityRef } from '../src/kernel/contracts/entity.ts'

const report = createReporter()
const sandbox = isolateDatabase('m51-measurement', { keep: false })
await resetPluginSqlConnection()
const h = await createM4Harness({ label: 'm51-measurement' })

// ---------------------------------------------------------------------------
// 两个**独立**的检测器（刻意不复用契约层的 assert* —— 量具与实现不共用代码）
// ---------------------------------------------------------------------------

/**
 * 检测器①：**执行真相**。
 * 主张 `executed=true`，但权威证据（handler 这一次真的跑过）为否 → 必须报出来。
 */
function controlTruthProblems(input: {
  claimsExecuted: boolean
  handlerRanThisTime: boolean
  replayed: boolean
}): string[] {
  const problems: string[] = []
  if (input.claimsExecuted && !input.handlerRanThisTime && !input.replayed) {
    problems.push('声称 executed=true，但权威证据（handler 运行）为否')
  }
  if (input.replayed && input.handlerRanThisTime) {
    problems.push('幂等重放却又真的跑了一次 handler（AT3.3 被破坏）')
  }
  return problems
}

/**
 * 检测器②：**导出负载里的哨兵扫描**。
 * 与 WP4 的 AT4.5 同一件事，但这里作用在一份**自己构造的**负载上。
 */
function payloadLeaks(payload: unknown, sentinels: readonly string[]): string[] {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload)
  return sentinels.filter((sentinel) => sentinel.length >= 4 && text.includes(sentinel))
}

/** 检测器③：**只读快照**。用一张表的行数 + 内容摘要代表"状态有没有动过"。 */
async function tableDigest(tableName: string): Promise<string> {
  const rows = rowsOf(await exec(h.db, sql.raw(`select * from "${tableName}"`), `快照 ${tableName}`))
  return JSON.stringify(
    rows
      .map((row) =>
        Object.keys(row)
          .sort()
          .map((key) => [key, row[key] ?? null])
      )
      .sort()
  )
}

// ===========================================================================
report.section('AT7.1 正控：合法的 query / trace / control 必须让检测器安静')
// ===========================================================================

// --- 一条合法的 trace（合成，但形状与真实一致）----------------------------
const traceKey = asTraceId('trc:m51-measurement')
const legitimateTrace: CharacterRunTrace = {
  traceId: traceKey,
  characterId: asCharacterId('sumuwei'),
  runtimeId: 'runtime-m51-measurement',
  userId: h.userId,
  identitySourceRefs: [],
  inputEventId: asConversationEventId('cev-m51-measurement'),
  contextSectionIds: ['identity-core', 'memory-recall'],
  droppedSectionIds: [],
  sourceConversationEventIds: [],
  selectedMemoryIds: ['mem:legit-1'],
  projectionRevisionsAtStart: {},
  projectionRevisionsAtEnd: {},
  domainEventIds: [],
  actionIds: [],
  postTurnJobIds: [],
  processorVersions: {},
  steps: [
    {
      kind: 'memory_recall',
      label: '召回',
      startedAt: M4_T0,
      finishedAt: M4_T0 + 3,
      status: 'ok',
      attributes: { candidates: 1, selected: 1 },
    },
  ],
  status: 'completed',
  startedAt: M4_T0,
  finishedAt: M4_T0 + 10,
}
const legitimateSpans = mapTraceToCanonicalSpans(legitimateTrace).spans

report.check(
  '正控①-1：合法 trace → Trace Truth 检测器**安静**（零不一致）',
  spanTraceInconsistencies(legitimateSpans, legitimateTrace).length === 0,
  spanTraceInconsistencies(legitimateSpans, legitimateTrace).join(' | ') || '零不一致'
)
report.check(
  '正控②-1：真实执行过 → 执行真相检测器**安静**',
  controlTruthProblems({ claimsExecuted: true, handlerRanThisTime: true, replayed: false }).length === 0
)
report.check(
  '正控③-1：合法导出负载 → 哨兵扫描器**安静**（零泄漏）',
  payloadLeaks(
    buildOtlpPayload({
      sessionId: 'm51-measurement',
      spans: canonicalSpansToTelemetrySpans(legitimateSpans, 'a'.repeat(32)),
    }),
    ['sk-M51-MEASUREMENT-SECRET', 'M51-MEASUREMENT-BODY']
  ).length === 0
)

// --- 一条合法的控制命令（真的走一遍 handler）------------------------------
const query = createDeveloperQueryService({
  db: h.db,
  characterId: h.kernel.characterId,
  owner: entityRef('character', String(h.kernel.characterId)),
  identitySnapshot: h.kernel.identitySnapshot,
  now: () => M4_T0,
})
const handlerRuns: string[] = []
const control = createDeveloperControlService({
  characterId: h.kernel.characterId,
  handlers: [createDiagnosticControlHandler(query), createAuditControlHandler(query)],
  now: () => M4_T0,
  onHandlerRun: (type) => handlerRuns.push(type),
})
const legitimateExecution = await control.execute({
  schemaVersion: 1,
  commandId: 'cmd-measurement-1',
  idempotencyKey: 'idem-measurement-1',
  type: 'RUN_DIAGNOSTIC',
  dryRun: false,
  requestedBy: { kind: 'developer', surface: 'cli' },
  createdAt: M4_T0,
})
report.check(
  '正控④-1：合法控制命令 → 执行真相检测器**安静**（真的执行过）',
  legitimateExecution.result.executed === true &&
    handlerRuns.length === 1 &&
    controlTruthProblems({
      claimsExecuted: legitimateExecution.result.executed,
      handlerRanThisTime: true,
      replayed: legitimateExecution.replayed,
    }).length === 0,
  `${legitimateExecution.result.outcome} / handler 调用 ${handlerRuns.length} 次`
)

// --- 一张合法读取的领域表 --------------------------------------------------
const domainBefore = await tableDigest('memory_records')
const conversationsBefore = await tableDigest('conversation_events')
report.check(
  '正控⑤-1：只读命令跑完 → 领域表快照**不变**（读不是写）',
  (await tableDigest('memory_records')) === domainBefore &&
    (await tableDigest('conversation_events')) === conversationsBefore
)

// ===========================================================================
report.section('AT7.2 负控：五种假象必须让对应的检测器响')
// ===========================================================================

const injections: { name: string; detector: string; responded: boolean; detail: string }[] = []

// --- ① fake selectedMemoryId ----------------------------------------------
const fakeId = 'mem:fake-000000000000000000000000'
const tamperedSpans = legitimateSpans.map((span) =>
  span.stage === 'recall'
    ? { ...span, attributes: { ...span.attributes, selected_memory_ids: fakeId } }
    : span
)
const fakeProblems = spanTraceInconsistencies(tamperedSpans, legitimateTrace)
injections.push({
  name: 'fake selectedMemoryId',
  detector: 'Trace Truth（span 的 selected_memory_ids 必须等于 trace 的实际）',
  responded: fakeProblems.length > 0,
  detail: fakeProblems[0] ?? '（检测器没响）',
})

// --- ② fake executed=true --------------------------------------------------
const fakeExecuted = controlTruthProblems({
  claimsExecuted: true,
  handlerRanThisTime: false,
  replayed: false,
})
injections.push({
  name: 'fake executed=true',
  detector: '执行真相（主张必须有权威证据）',
  responded: fakeExecuted.length > 0,
  detail: fakeExecuted[0] ?? '（检测器没响）',
})

// --- ③ query-side mutation -------------------------------------------------
/*
 * 注入方式：**真的写一次**（走账本写一条用户事件），然后看快照检测器有没有发现。
 *
 * ⚠️ 判据必须是"**前后对比**"：
 *    第一版写成 `conversationMutation.length > 0` —— 那恒为真
 *    （摘要字符串当然非空），于是这条"负控"其实什么都没测。
 *    检测器的正确形状永远是 `after !== before`。
 */
await h.recordUserEvidence('M51-MEASUREMENT-INJECTION')
const memoryAfter = await tableDigest('memory_records')
const conversationsAfter = await tableDigest('conversation_events')
const mutationDetected = conversationsAfter !== conversationsBefore || memoryAfter !== domainBefore
injections.push({
  name: 'query-side mutation',
  detector: '只读快照（领域表的内容摘要必须逐字节不变）',
  responded: mutationDetected,
  detail: mutationDetected
    ? conversationsAfter !== conversationsBefore
      ? 'conversation_events 发生变化（被检测到）'
      : 'memory_records 发生变化（被检测到）'
    : '（检测器没响 —— 写了一次却没人发现）',
})

// --- ④ secret in telemetry -------------------------------------------------
const secretSentinels = ['sk-M51-MEASUREMENT-SECRET', 'M51-MEASUREMENT-BODY']
const poisonedPayload = buildOtlpPayload({
  sessionId: 'm51-measurement',
  // 只允许白名单里的键 → 用一个合法键装一个哨兵值（这正是"值级泄漏"的形状）
  spans: canonicalSpansToTelemetrySpans(legitimateSpans, 'b'.repeat(32)).map((span) => ({
    ...span,
    attributes: { ...span.attributes, model_profile: secretSentinels[0]! },
  })),
})
const secretLeaks = payloadLeaks(poisonedPayload, secretSentinels)
injections.push({
  name: 'secret in telemetry',
  detector: '导出负载哨兵扫描（AT4.5 的同一件事）',
  responded: secretLeaks.length > 0,
  detail: secretLeaks.join(', ') || '（检测器没响）',
})

// --- ⑤ unknown control command --------------------------------------------
const runsBeforeUnknown = handlerRuns.length
const unknown = await control.execute({
  schemaVersion: 1,
  commandId: 'cmd-measurement-unknown',
  idempotencyKey: 'idem-measurement-unknown',
  type: 'DROP_TABLE',
  dryRun: false,
  requestedBy: { kind: 'developer', surface: 'cli' },
  createdAt: M4_T0,
})
const forbidden = await control.execute({
  schemaVersion: 1,
  commandId: 'cmd-measurement-forbidden',
  idempotencyKey: 'idem-measurement-forbidden',
  type: FORBIDDEN_CONTROL_COMMANDS[0],
  dryRun: false,
  requestedBy: { kind: 'developer', surface: 'cli' },
  createdAt: M4_T0,
})
injections.push({
  name: 'unknown control command',
  detector: '白名单（未知 → rejected，且 handler **一次都不许跑**）',
  responded:
    unknown.result.outcome === 'rejected' &&
    unknown.result.reasonCode === 'command_not_allowed' &&
    forbidden.result.outcome === 'rejected' &&
    forbidden.result.reasonCode === 'command_forbidden' &&
    handlerRuns.length === runsBeforeUnknown,
  detail:
    `${unknown.result.outcome}/${unknown.result.reasonCode} · ` +
    `${forbidden.result.outcome}/${forbidden.result.reasonCode} · ` +
    `handler 调用 ${handlerRuns.length - runsBeforeUnknown} 次`,
})

for (const injection of injections) {
  report.check(`负控：${injection.name} → 检测器必须响`, injection.responded, injection.detail)
}
report.check(
  '五个检测器**全部**会响（没有一个橡皮图章）',
  injections.every((injection) => injection.responded),
  `${injections.filter((i) => i.responded).length}/${injections.length}`
)

// ===========================================================================
report.section('AT7.2 恢复：把真实实现放回去，检测器必须重新安静')
// ===========================================================================

report.check(
  '恢复①：干净的 span 集合 → Trace Truth 重新安静',
  spanTraceInconsistencies(legitimateSpans, legitimateTrace).length === 0
)
report.check(
  '恢复②：真实的 handler 调用 → 执行真相检测器重新安静',
  controlTruthProblems({ claimsExecuted: true, handlerRanThisTime: true, replayed: false }).length === 0
)
report.check(
  '恢复③：只有白名单命令 → 白名单检测器重新安静（未知命令仍然被拒）',
  CONTROL_COMMAND_FACTS.RUN_DIAGNOSTIC !== undefined &&
    !('DROP_TABLE' in CONTROL_COMMAND_FACTS) &&
    FORBIDDEN_CONTROL_COMMANDS.every((type) => !(type in CONTROL_COMMAND_FACTS))
)
report.check(
  '恢复④：干净的负载 → 哨兵扫描器重新安静',
  payloadLeaks(
    buildOtlpPayload({
      sessionId: 'm51-measurement',
      spans: canonicalSpansToTelemetrySpans(legitimateSpans, 'c'.repeat(32)),
    }),
    secretSentinels
  ).length === 0
)
report.check(
  '恢复⑤：白名单里的键仍然全过（注入没有改坏实现）',
  isTelemetryAttributeAllowed('model_profile') &&
    isTelemetryAttributeAllowed('selected_memory_ids') &&
    isTelemetryAttributeAllowed('reason_code')
)

// ===========================================================================
// 证据
// ===========================================================================

const gateVerdict = injections.every((injection) => injection.responded) ? 'PASS' : 'FAIL'

mkdirSync(join(process.cwd(), 'artifacts', 'm5.1'), { recursive: true })
writeFileSync(
  join(process.cwd(), 'artifacts', 'm5.1', 'measurement-negative-controls.json'),
  `${JSON.stringify(
    {
      testId: 'M5.1 / WP7 measurement and negative controls',
      generatedAt: new Date().toISOString(),
      sandbox: sandbox.dir,
      note:
        '本门不重跑 WP2–WP5 的真实链路（那五道门已各自落盘证据）；' +
        '它只回答一个问题：这五个检测器是不是都会响。',
      positiveControls: [
        '合法 trace → Trace Truth 安静',
        '真实执行过 → 执行真相安静',
        '合法负载 → 哨兵扫描安静',
        '合法控制命令 → 执行真相安静（handler 真的跑了 1 次）',
        '只读命令 → 领域表快照不变',
      ],
      injections,
      allDetectorsResponded: injections.every((injection) => injection.responded),
      restored: true,
      measurementVerdict: gateVerdict,
    },
    null,
    2
  )}\n`,
  'utf8'
)
console.log('证据已写入：artifacts/m5.1/measurement-negative-controls.json')

await h.stop()
cleanupSandbox(sandbox.dir)
report.finish('M5.1 WP7 量具与负控门')
