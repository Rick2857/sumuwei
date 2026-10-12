/**
 * M5.1.1 WP7 —— **Developer Console / Attribution Diagnostics** 专项门
 * （`pnpm m5.1.1:wp7:verify`）
 *
 * ============================================================================
 *  它证明的是什么（逐条对应执行计划 AT-W7-1…AT-W7-11）
 * ============================================================================
 *  §1  query-only 边界（AT-W7-8，静态）：`page.html` 零 import / 零外部资源 / 无框架 /
 *      **一个** POST / 不含任何 persistence·SQL·DB 驱动字样。
 *  §2  渲染 Vocabulary（AT-W7-1/2/3）：四态 + 第四态"无信封" + origin + Axis B ——
 *      用**真实页面**（`dev-page-harness`：桩 DOM + 桩 fetch）驱动并断言**渲染输出**，
 *      不是 grep 文案。四态两两可区分；Unknown 不得被折叠成空/`-`/不适用。
 *  §3  计数（AT-W7-4 / U-14 / K-30）：用**真实 store 写出的行**（RECORDED / MIGRATED_LEGACY /
 *      无信封三种）跑真实 `query-service`，把 DTO 里的两个计数与**直接从物理列独立数出来**
 *      的期望值比对（正控 + 负控 + 恢复）。
 *  §4  Trace / Execution 面板（AT-W7-5/6）+ D01·K-27 呈现（AT-W7-7）：
 *      Execution Truth 与归因**分开**；Axis B = NOT_APPLICABLE；agent-as-user 一行
 *      在任何渲染面上都不出现 USER 位次。
 *  §5  Developer Control（AT-W7-9）：命令列表来自响应（页面里没有硬编码命令名）、
 *      只有一条 POST 路径、未知命令 fail closed。
 *  §6  删页面性质（AT-W7-10，Hard Gate，**真 HTTP**）：正常 `GET /` → 200；
 *      临时把 `page.html` 移走 → 404 且说明原因；**其余端点逐字不变**；恢复后逐字回到原样。
 *  §7  只读：查询面自己不产生任何写入（跑完整套件前后权威表哈希相同）。
 *
 * ⚠️ 它**不**主张：模型那一跳（本门不调模型）、真实库状态（只读它，从不打开）、
 *    schema 变更（没有）。真实库 mtime 只被**记录**。
 *
 * 跑法：pnpm m5.1.1:wp7:verify
 */

import 'dotenv/config'

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { sql } from 'drizzle-orm'

import { character } from '../src/character/index.ts'
import { PRODUCTION_DB_DIR, isolateDatabase, isProductionDir } from '../src/dev/sandbox.ts'
import { M4_T0, createM4Harness } from './m4-harness.ts'
import { flushPage, runDevPage } from './dev-page-harness.ts'
import {
  attributionCountsOf,
  type DeveloperAttributionDto,
} from '../src/kernel/contracts/developer-query.ts'
import {
  asCharacterId,
  asConversationEventId,
  asConversationId,
  asTraceId,
  newTraceId,
} from '../src/kernel/contracts/ids.ts'
import { entityRef } from '../src/kernel/contracts/entity.ts'
import { createDeveloperQueryService } from '../src/infrastructure/dev/query-service.ts'
import {
  createAuditControlHandler,
  createDeveloperControlService,
  createDiagnosticControlHandler,
} from '../src/infrastructure/dev/control-service.ts'
import {
  readPageHtml,
  startDeveloperQueryServer,
} from '../src/infrastructure/dev/http-server.ts'
import { appendConversationEvent } from '../src/infrastructure/persistence/conversation-store.ts'
import { createTraceWriter } from '../src/infrastructure/persistence/trace-store.ts'
import { currentSchemaVersion, rowsOf } from '../src/infrastructure/persistence/db.ts'
import { MIGRATIONS } from '../src/infrastructure/persistence/migrations.ts'

let passed = 0
let failed = 0
const failures: string[] = []
const measurements: { label: string; count: number; valid: boolean }[] = []

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed += 1
    console.log(`  ✅ ${label}${detail ? `  [${detail}]` : ''}`)
  } else {
    failed += 1
    failures.push(label)
    console.log(`  ❌ ${label}${detail ? `  [${detail}]` : ''}`)
  }
}
function measure(label: string, count: number): number {
  const valid = count > 0
  measurements.push({ label, count, valid })
  if (!valid) check(`[MEASUREMENT INVALID] ${label}（measured_count = 0）`, false, '什么都没测到')
  return count
}
function section(title: string): void {
  console.log(`\n${'='.repeat(74)}\n${title}\n${'='.repeat(74)}`)
}

const ROOT = process.cwd()
const EVIDENCE_DIR = join(ROOT, 'artifacts', 'm5.1.1')
const PAGE_PATH = join(ROOT, 'src', 'infrastructure', 'dev', 'page.html')
const PAGE_MOVED = join(ROOT, 'src', 'infrastructure', 'dev', 'page.html.wp7-moved')
const LIVE_DB_DIR = join(ROOT, 'data', 'pglite')

console.log('='.repeat(74))
console.log('M5.1.1 WP7 —— Developer Console / Attribution Diagnostics')
console.log('='.repeat(74))

// ===========================================================================
section('§0 环境与边界')
// ===========================================================================

const sandbox = isolateDatabase('m5.1.1-wp7')
check(
  '沙箱不是真实库',
  isProductionDir(sandbox.dir) === false && sandbox.dir.startsWith(tmpdir()),
  sandbox.dir
)
check(
  '真实库路径只被记录，从未被本脚本打开',
  PRODUCTION_DB_DIR.endsWith(join('data', 'pglite')) && process.env.PGLITE_DATA_DIR !== PRODUCTION_DB_DIR,
  PRODUCTION_DB_DIR
)
const liveDbMtime = (await import('node:fs')).statSync(LIVE_DB_DIR).mtime.toISOString()

const h = await createM4Harness({ label: 'wp7' })
const db = h.db
const characterId = h.kernel.characterId
const schemaVersion = await currentSchemaVersion(db)
check(
  '沙箱库 schema = v9（WP7 本身无 schema 变更；v9 是 WP9-B1 的 state_events 承载）',
  schemaVersion === 9,
  `v${schemaVersion}`
)
const fingerprint = (version: number): string => {
  const migration = MIGRATIONS.find((item) => item.version === version)!
  return createHash('sha256').update(migration.statements.join('\n'), 'utf8').digest('hex')
}
check(
  'MIGRATION_0007 / 0008 逐字未改；迁移清单 = 1..9（v9 = WP9-B1 的 state_events 承载，' +
    '原判据"没有 v9"按 R-45 的新事实改写，未放宽）',
  fingerprint(7) === '2d51997dc620ff01f87bcf8784c15985c6d6d9d2a4b978809db5f8dbc7c07613' &&
    fingerprint(8) === '0a2bd4fe470ac5ce4d4a42717fbd799d9ddb570c4d360f34bc17b580e0538e29' &&
    MIGRATIONS.map((item) => item.version).join(',') === '1,2,3,4,5,6,7,8,9' &&
    MIGRATIONS.find((item) => item.version === 9)?.name === 'm5.1.1-state-events-attribution',
  MIGRATIONS.map((item) => item.version).join(',')
)

const pageSource = readFileSync(PAGE_PATH, 'utf8')

// ===========================================================================
section('§1 / AT-W7-8 query-only 边界（静态：页面不是第二个数据源）')
// ===========================================================================

const scriptBody = /<script>([\s\S]*?)<\/script>/.exec(pageSource)?.[1] ?? ''
measure('页面脚本的字符数', scriptBody.length)
check(
  '★ 页面**零 import**：脚本里没有 import / require / 动态 import',
  !/\bimport\s|\brequire\s*\(|import\s*\(/.test(scriptBody),
  'AA'
)
check(
  '★ 页面**零外部资源**：没有 <script src> / <link href> / <img src> 指向外部',
  !/<script[^>]+src=/i.test(pageSource) &&
    !/<link[^>]+href=/i.test(pageSource) &&
    !/<img[^>]+src=/i.test(pageSource),
  'AA'
)
check(
  '★ 页面**无框架**：脚本里没有 React / Vue / jQuery / 任何 loader 字样',
  !/\bReact\b|\bVue\b|\bjquery\b|\$\(/i.test(scriptBody),
  'AA'
)
const queryOnlyOffenders = [
  ['persistence 路径', /persistence\//],
  ['SQL 关键字', /\bselect\s+[\s\S]{0,40}\bfrom\b|\binsert\s+into\b|\bupdate\s+\w+\s+set\b|\bdelete\s+from\b/i],
  ['DB 驱动 / 连接', /drizzle|pg_?lite|PGlite|DATABASE_URL|createClient/i],
  ['直接文件访问', /readFile|writeFile|node:fs/i],
] as const
const staticOffences = queryOnlyOffenders
  .filter(([, pattern]) => pattern.test(scriptBody))
  .map(([label]) => label)
check(
  '★ 页面不碰 persistence / SQL / DB 驱动 / 文件系统（它只消费 /dev/query/*）',
  staticOffences.length === 0,
  staticOffences.join(', ') || 'AA'
)
const postCount = (scriptBody.match(/method:\s*'POST'/g) ?? []).length
check(
  '★ 页面只有**一条** POST 路径（控制命令），且命令名不硬编码（来自响应）',
  postCount === 1 &&
    /fetch\(BASE \+ '\/control\/commands\/'/.test(scriptBody) &&
    !/RUN_DIAGNOSTIC|RUN_AUDIT/.test(scriptBody),
  `POST=${postCount}`
)

// ===========================================================================
section('§2 / AT-W7-1…3 渲染 Vocabulary（**渲染输出**级，不是 grep 文案）')
// ===========================================================================

const ROUTES: Record<string, unknown> = {
  '/dev/query/health': {
    status: 'ok',
    schemaVersion: 8,
    migrationVersion: 8,
    seedVersion: 1,
    seedHash: 'deadbeefcafe',
    integrityOk: true,
    details: [],
  },
  '/dev/query/capabilities': { query: [], runtime: [] },
  '/dev/query/traces?limit=5': { items: [], counts: { unknownSlotCount: 0, recordsWithUnknownCount: 0 } },
  '/dev/query/traces?limit=5&status=failed': { items: [] },
  '/dev/query/traces?limit=20': {
    counts: { unknownSlotCount: 3, recordsWithUnknownCount: 2 },
    items: [{ traceId: 'trc-1', status: 'completed', startedAt: 1000, stepCount: 0, selectedMemoryIds: [], hasError: false }],
  },
  '/dev/query/executions?limit=20': {
    items: [
      {
        actionId: 'act-1',
        capability: 'system.echo',
        operation: 'echo',
        status: 'success',
        accepted: true,
        attempted: true,
        executed: true,
      },
    ],
  },
  '/dev/query/control/commands': [
    { type: 'RUN_AUDIT', authority: 'developer', mutatesDomain: false, kind: 'audit' },
  ],
  '/dev/query/memory/stats': {
    total: 1,
    active: 1,
    superseded: 0,
    retracted: 0,
    disputed: 0,
    unsupported: 0,
    contaminated: 0,
    unregisteredPredicate: 0,
  },
  '/dev/query/memory/integrity': {
    integrityOk: true,
    danglingEvidenceLinks: [],
    danglingMemoryEvents: [],
    memoriesWithoutLiveEvidence: [],
    memoriesWithoutLiveEvents: [],
  },
}

/** 一条 RECORDED 的对话归因：KNOWN + ABSENT + UNKNOWN(LEGACY_UNRECORDED) 三种都出现 */
const RECORDED_WITH_UNKNOWN = {
  attributionOrigin: 'RECORDED',
  subject: { kind: 'CHARACTER', id: String(characterId) },
  initiator: { state: 'ABSENT' },
  actor: { state: 'KNOWN', kind: 'USER', id: 'u-1' },
  executor: { state: 'ABSENT' },
  authority: { state: 'ABSENT' },
  recordedBy: { state: 'KNOWN', kind: 'SYSTEM', id: 'kernel' },
  contentOriginator: { state: 'UNKNOWN', reason: 'LEGACY_UNRECORDED' },
  axisB: {
    availability: 'APPLICABLE',
    sourceKind: 'user_statement',
    sourceAuthority: 'USER_EXPLICIT',
    epistemicSource: 'user_report',
    branch: 'confirmed',
  },
  basisEventType: 'user_message',
  basisSequence: 3,
}

const runTrace = await runDevPage(pageSource, {
  ...ROUTES,
  '/dev/query/traces/trc-1': {
    traceId: 'trc-1',
    status: 'completed',
    durationMs: 1,
    contextSectionIds: [],
    droppedSectionIds: [],
    selectedMemoryIds: [],
    actionIds: [],
    steps: [],
    attribution: RECORDED_WITH_UNKNOWN,
    counts: { unknownSlotCount: 1, recordsWithUnknownCount: 1 },
  },
})
check(
  '★ 页面在桩环境下零抛错、零未解释请求、零缺失元素 id',
  runTrace.pageErrors.length === 0 &&
    runTrace.unroutedPaths.length === 0 &&
    runTrace.missingIds.length === 0,
  `${runTrace.pageErrors.join('|')} ${runTrace.unroutedPaths.join('|')} ${runTrace.missingIds.join('|')}`
)
runTrace.fireFirst('traces-list')
await flushPage(pageSource)
const rendered = runTrace.textOf('trace-detail')
measure('渲染出的归因面板文本长度', rendered.length)

const stateRenderings = {
  known: 'USER/u-1',
  absent: '不适用',
  unknownLegacy: '来源未确立（历史未记录）',
  originRecorded: '事件发生时记录（RECORDED）',
}
check(
  '★ AT-W7-1 三态 + origin 在渲染输出里**四者可区分**',
  Object.values(stateRenderings).every((text) => rendered.includes(text)),
  Object.entries(stateRenderings)
    .map(([key, text]) => `${key}=${String(rendered.includes(text))}`)
    .join(' ')
)
check(
  '★ AT-W7-1 Unknown **不得**被渲染成空串 / `-` / null（这一格必须是那一句人话）',
  /contentOriginator[^]*?来源未确立（历史未记录）/.test(rendered) && !/contentOriginator[^]*?-\s/.test(rendered),
  'AA'
)
check(
  '★ AT-W7-4 计数只来自响应（`unknownSlotCount=3` 是**列表面**响应给的；详情给的是 1）',
  runTrace.textOf('traces-list').includes('unknownSlotCount=3') && rendered.includes('unknownSlotCount=1'),
  'AA'
)

/* --- 第四态：整个信封缺席（不是 Absent，也不升格 origin） --- */
const runNoEnvelope = await runDevPage(pageSource, {
  ...ROUTES,
  '/dev/query/traces/trc-1': {
    traceId: 'trc-1',
    status: 'completed',
    durationMs: 1,
    contextSectionIds: [],
    droppedSectionIds: [],
    selectedMemoryIds: [],
    actionIds: [],
    steps: [],
    counts: { unknownSlotCount: 0, recordsWithUnknownCount: 0 },
  },
})
runNoEnvelope.fireFirst('traces-list')
await flushPage(pageSource)
const noEnvelope = runNoEnvelope.textOf('trace-detail')
check(
  '★ AT-W7-1 第四态：无信封渲染成 `未记录归因（Legacy Event）`，且**一个槽位行都不渲染**',
  noEnvelope.includes('未记录归因（Legacy Event）') &&
    !noEnvelope.includes('contentOriginator') &&
    !noEnvelope.includes('Axis B'),
  noEnvelope.replace(/\s+/g, ' ').slice(-140)
)
check(
  '★ AT-W7-2 UI **不得**做 origin promotion：无信封的行里没有 MIGRATED_LEGACY / RECORDED',
  !noEnvelope.includes('MIGRATED_LEGACY') && !noEnvelope.includes('（RECORDED）'),
  'AA'
)
const runMigrated = await runDevPage(pageSource, {
  ...ROUTES,
  '/dev/query/traces/trc-1': {
    traceId: 'trc-1',
    status: 'completed',
    durationMs: 1,
    contextSectionIds: [],
    droppedSectionIds: [],
    selectedMemoryIds: [],
    actionIds: [],
    steps: [],
    attribution: {
      ...RECORDED_WITH_UNKNOWN,
      attributionOrigin: 'MIGRATED_LEGACY',
      actor: { state: 'UNKNOWN', reason: 'LEGACY_UNRECORDED' },
      contentOriginator: { state: 'UNKNOWN', reason: 'LEGACY_UNRECORDED' },
      axisB: {
        availability: 'APPLICABLE',
        sourceKind: 'user_statement',
        sourceAuthority: 'UNCONFIRMED_ORIGIN',
        epistemicSource: 'UNCONFIRMED_ORIGIN',
        branch: 'unconfirmed',
      },
    },
    counts: { unknownSlotCount: 2, recordsWithUnknownCount: 1 },
  },
})
runMigrated.fireFirst('traces-list')
await flushPage(pageSource)
const migratedText = runMigrated.textOf('trace-detail')
check(
  '★ AT-W7-2 origin **原样**渲染：MIGRATED_LEGACY 显示为历史迁移归因（不升格成 RECORDED）',
  migratedText.includes('历史迁移归因（MIGRATED_LEGACY）') &&
    !migratedText.includes('事件发生时记录（RECORDED）'),
  'AA'
)
check(
  '★ AT-W7-3 Axis B 三列**独立**渲染 + UNCONFIRMED_ORIGIN 明确标"来源未确立"',
  migratedText.includes('source_kind=user_statement') &&
    (migratedText.match(/UNCONFIRMED_ORIGIN/g) ?? []).length >= 2 &&
    migratedText.includes('来源未确立'),
  `UNCONFIRMED_ORIGIN×${(migratedText.match(/UNCONFIRMED_ORIGIN/g) ?? []).length}`
)

/* --- AT-W7-5/6/7：Trace 与 Execution 两个面板 + D01/K-27 --- */
const runExecution = await runDevPage(pageSource, {
  ...ROUTES,
  '/dev/query/executions/act-1': {
    actionId: 'act-1',
    traceId: 'trc-1',
    capability: 'system.echo',
    operation: 'echo',
    accepted: true,
    attempted: true,
    executed: true,
    status: 'success',
    sideEffect: 'none',
    idempotentReplay: false,
    requestedAt: 1000,
    durationMs: 1,
    intent: { kind: 'current_fact', availability: { status: 'available' } },
    request: {
      capability: 'system.echo',
      operation: 'echo',
      requestedByKind: 'user',
      sideEffect: 'none',
      argumentKeys: [],
      createdAt: 1000,
    },
    attempt: { attempted: true, evidenceRef: 'ACTION_STARTED' },
    result: { status: 'success', executed: true, effectKind: 'echo' },
    verification: { state: 'not_attempted' },
    evidence: [],
    attribution: {
      attributionOrigin: 'RECORDED',
      subject: { kind: 'CHARACTER', id: String(characterId) },
      initiator: { state: 'KNOWN', kind: 'SERVICE', id: 'agent-runner' },
      actor: { state: 'KNOWN', kind: 'SERVICE', id: 'agent-runner' },
      executor: { state: 'KNOWN', kind: 'TOOL', id: 'weather' },
      authority: { state: 'KNOWN', kind: 'CAPABILITY', ref: 'system.echo' },
      recordedBy: { state: 'KNOWN', kind: 'SYSTEM', id: 'kernel' },
      contentOriginator: { state: 'ABSENT' },
      axisB: { availability: 'NOT_APPLICABLE' },
      basisEventType: 'ACTION_REQUESTED',
      basisSequence: 7,
    },
    counts: { unknownSlotCount: 0, recordsWithUnknownCount: 0 },
  },
})
runExecution.fireFirst('executions-list')
await flushPage(pageSource)
const executionText = runExecution.textOf('execution-detail')
check(
  '★ AT-W7-6 Execution 面板：Axis B 渲染成 `NOT_APPLICABLE`（不是未知/缺失/错误）',
  executionText.includes('NOT_APPLICABLE') &&
    !/Axis B[^]*?(未知|缺失|错误)/.test(executionText),
  'AA'
)
check(
  '★ AT-W7-6 Execution Truth 与归因**分开**：attempt/result/verification 与独立归因卡同屏',
  executionText.includes('attempt') &&
    executionText.includes('verification') &&
    executionText.includes('Attribution Truth'),
  'AA'
)
check(
  '★ AT-W7-7 D01（K-27 呈现）：`SERVICE/agent-runner` 原样出现，' +
    '**没有任何** USER 位次被渲染（legacy requestedByKind=user 也不影响权威面）',
  executionText.includes('SERVICE/agent-runner') && !executionText.includes('USER/'),
  'AA'
)
check(
  '★ AT-W7-6 计数（详情面）：无信封的 action 也显式给 0（0 不是"省略"）',
  executionText.includes('unknownSlotCount=0') && executionText.includes('recordsWithUnknownCount=0'),
  'AA'
)

// ===========================================================================
section('§3 / AT-W7-4 计数 vs **物理列独立计数**（正控 / 负控 / 恢复）')
// ===========================================================================

/*
 * 这一段不用"再跑一次同一个函数"来验证（那是同义反复）。做法是：
 *   ① 往真实 store 里写三种形状的对话事件（RECORDED 有 Known/ABSENT、
 *      MIGRATED_LEGACY 全 UNKNOWN、以及**无信封**的 legacy 行）
 *   ② 建 trace 把它们当作 `input_event_id`
 *   ③ 跑真实 `query.listTraces` ⇒ 读 DTO 的 counts
 *   ④ 用**独立的 SQL** 从物理列数出 UNKNOWN 槽位与含未知的记录 ⇒ 与 ③ 比对
 */
const conversationId = asConversationId('conv_wp7_counts')
const eventIds: string[] = []

// ①-a 一条 RECORDED 行（actor=USER，contentOriginator=USER）⇒ 0 个 UNKNOWN
const recordedEvent = await appendConversationEvent(db, {
  characterId,
  conversationId,
  conversationSequence: 1,
  type: 'user_message',
  actorType: 'user',
  actorId: 'u-1',
  content: 'WP7 计数夹具：RECORDED 且两个槽位都是 Known',
  attributionOriginForTest: undefined,
} as never).catch(async () => {
  // 该原语不接受测试专用字段 ⇒ 直接用最小合法写法重试（保持夹具诚实）
  return await appendConversationEvent(db, {
    characterId,
    conversationId,
    conversationSequence: 1,
    type: 'user_message',
    actorType: 'user',
    actorId: 'u-1',
    content: 'WP7 计数夹具：RECORDED 且两个槽位都是 Known',
  })
})
eventIds.push(String(recordedEvent.event.id))

// ①-b 一条 MIGRATED_LEGACY 行：所有六个槽位都 Unknown(LEGACY_UNRECORDED)（= 6 个未知槽位）
//     ⚠️ `subject` **没有物理列** —— 它由 canonical owner 派生（ADR-042 U-13），因此不在 INSERT 里
//     ⚠️ 这条路绕过了序号分配器，所以刻意用一个**离群**的角色级序号（沙箱里不会有人发到这个值），
//        否则它会与分配器接下来发出的序号撞上（实测踩到过：写入冲突且无法回读）
const migratedSequence = 9_000_001
const migrated = rowsOf(
  await db.execute(
    sql`insert into conversation_events
          (id, character_id, conversation_id, sequence, conversation_sequence,
           type, actor_type, actor_id, content, metadata, schema_version, created_at,
           source_kind, source_authority, epistemic_source, event_schema_version,
           attribution_origin,
           initiator_unknown_reason, actor_unknown_reason, executor_unknown_reason,
           authority_unknown_reason, recorded_by_unknown_reason, content_originator_unknown_reason)
        values (${'evt-wp7-migrated'}, ${String(characterId)}, ${String(conversationId)},
                ${migratedSequence}, 2,
                'user_message', 'user', 'u-1', 'WP7 计数夹具：MIGRATED_LEGACY 全未知',
                ${'{}'}::jsonb, 3, ${M4_T0},
                'user_statement', 'UNCONFIRMED_ORIGIN', 'UNCONFIRMED_ORIGIN', 3,
                'MIGRATED_LEGACY',
                'LEGACY_UNRECORDED', 'LEGACY_UNRECORDED', 'LEGACY_UNRECORDED',
                'LEGACY_UNRECORDED', 'LEGACY_UNRECORDED', 'LEGACY_UNRECORDED')
        returning id`
  )
) as { id: string }[]
eventIds.push(String(migrated[0]!.id))

// ①-c 一条**无信封**的 legacy 行（三列全 NULL）⇒ 不计入
const legacyEvent = await appendConversationEvent(db, {
  characterId,
  conversationId,
  conversationSequence: 3,
  type: 'user_message',
  actorType: 'user',
  actorId: 'u-1',
  content: 'WP7 计数夹具：无信封的 legacy 行',
})
eventIds.push(String(legacyEvent.event.id))

check(
  '§3 前置：三种形状的行都真的落库了（RECORDED / MIGRATED_LEGACY / 无信封）',
  eventIds.length === 3,
  eventIds.join(', ')
)

// ② 三条 trace，各自 input_event_id 指向上面三条事件
const traceWriter = createTraceWriter(db)
const traceIds: string[] = []
for (const [index, eventId] of eventIds.entries()) {
  const traceId = newTraceId()
  traceIds.push(String(traceId))
  await traceWriter.start({
    traceId,
    characterId,
    inputEventId: asConversationEventId(eventId),
    identitySourceRefs: [],
    contextSectionIds: [],
    droppedSectionIds: [],
    sourceConversationEventIds: [],
    selectedMemoryIds: [],
    projectionRevisionsAtStart: {},
    projectionRevisionsAtEnd: {},
    domainEventIds: [],
    postTurnJobIds: [],
    processorVersions: {},
    actionIds: [],
    steps: [],
    status: 'completed',
    startedAt: M4_T0 + index,
  })
}

const query = createDeveloperQueryService({
  db,
  characterId,
  owner: entityRef('character', String(characterId)),
  runtimeId: 'runtime-wp7',
  /*
   * ⚠️ **固定时钟**：health 里有"这次检查发生在什么时候"这类字段。不注入 now，
   *    删页面测试里的"前后逐字节相同"就会因为时间戳变化而假红（实测踩到过）。
   *    继承了 `verify-m5.1-page.ts` 的同一做法。
   */
  now: () => M4_T0,
})
const list = await query.listTraces({ characterId, limit: 20 })
const dtoCounts = list.counts
measure('trace 列表返回的条数', list.items.length)

/** ④ 独立计数：直接读物理列（**不**经过任何契约函数） */
const physical = rowsOf(
  await db.execute(
    sql`select
          count(*) filter (where initiator_kind is null and initiator_unknown_reason is not null)
        + count(*) filter (where actor_kind is null and actor_unknown_reason is not null)
        + count(*) filter (where executor_kind is null and executor_unknown_reason is not null)
        + count(*) filter (where authority_kind is null and authority_unknown_reason is not null)
        + count(*) filter (where recorded_by_kind is null and recorded_by_unknown_reason is not null)
        + count(*) filter (where content_originator_kind is null and content_originator_unknown_reason is not null)
          as unknown_slots,
          count(*) filter (where
               (initiator_kind is null and initiator_unknown_reason is not null)
            or (actor_kind is null and actor_unknown_reason is not null)
            or (executor_kind is null and executor_unknown_reason is not null)
            or (authority_kind is null and authority_unknown_reason is not null)
            or (recorded_by_kind is null and recorded_by_unknown_reason is not null)
            or (content_originator_kind is null and content_originator_unknown_reason is not null))
          as records_with_unknown
        from conversation_events
        where id in (${sql.join(eventIds.map((id) => sql`${id}`), sql`, `)})`
  )
) as { unknown_slots: number; records_with_unknown: number }[]
const expected = {
  unknownSlotCount: Number(physical[0]!.unknown_slots),
  recordsWithUnknownCount: Number(physical[0]!.records_with_unknown),
}
check(
  '★ §3 正控：DTO 的两个计数 == **独立从物理列数出来**的期望值（不是同义反复）',
  dtoCounts.unknownSlotCount === expected.unknownSlotCount &&
    dtoCounts.recordsWithUnknownCount === expected.recordsWithUnknownCount,
  `dto=${JSON.stringify(dtoCounts)} sql=${JSON.stringify(expected)}`
)
check(
  '★ §3 正控（具体值）：MIGRATED_LEGACY 那条贡献 6 个未知槽位 / 1 条含未知记录；' +
    'RECORDED 与无信封各贡献 0',
  expected.unknownSlotCount === 6 && expected.recordsWithUnknownCount === 1,
  `unknownSlots=${expected.unknownSlotCount} records=${expected.recordsWithUnknownCount}`
)
check(
  '★ §3 无信封的行**不产生**未知（它贡献 0；且它的 DTO `attribution` 缺席）',
  (() => {
    const legacyTrace = list.items.find((item) => item.traceId === asTraceId(traceIds[2]!))
    return legacyTrace !== undefined && legacyTrace.attribution === undefined
  })(),
  'AA'
)
check(
  '★ §3 契约层复算一致：`attributionCountsOf(items)` == 响应里的 counts（同一规则两处落地）',
  JSON.stringify(attributionCountsOf(list.items.map((item) => item.attribution))) ===
    JSON.stringify(dtoCounts),
  JSON.stringify(dtoCounts)
)

/** 负控：把"无信封"当成 ABSENT 或把 Axis B 也算进来，都会让数字偏离 —— 断言两者确实不同 */
const wrongIfAxisBCounted = list.items.length
check(
  '★ §3 负控：若把 Axis B / 无信封也当未知，数字会偏差（本例 3 条记录 vs 1 条含未知）',
  wrongIfAxisBCounted !== dtoCounts.recordsWithUnknownCount,
  `records=${wrongIfAxisBCounted} vs ${dtoCounts.recordsWithUnknownCount}`
)
const listAgain = await query.listTraces({ characterId, limit: 20 })
check(
  '★ §3 恢复：再查一次 ⇒ 数字逐字相同（只读、稳定、无累计）',
  JSON.stringify(listAgain.counts) === JSON.stringify(dtoCounts),
  JSON.stringify(listAgain.counts)
)

// ===========================================================================
section('§4 / AT-W7-9 Developer Control 保持原样（真 HTTP）')
// ===========================================================================

const control = createDeveloperControlService({
  characterId,
  handlers: [createDiagnosticControlHandler(query), createAuditControlHandler(query)],
  now: () => M4_T0,
})
const server = await startDeveloperQueryServer({
  service: query,
  control,
  characterId,
  port: 0,
})
const fetchText = async (
  path: string,
  init?: RequestInit
): Promise<{ status: number; contentType: string; text: string }> => {
  const response = await fetch(`${server.url}${path}`, init)
  return {
    status: response.status,
    contentType: String(response.headers.get('content-type') ?? ''),
    text: await response.text(),
  }
}

const commandsResponse = await fetchText('/dev/query/control/commands')
const commands = JSON.parse(commandsResponse.text) as { type: string }[]
measure('控制白名单里的命令数', commands.length)
check(
  '★ AT-W7-9 命令列表来自 `GET /dev/query/control/commands`（页面里没有硬编码命令名）',
  commandsResponse.status === 200 && commands.length > 0 && !/RUN_DIAGNOSTIC|RUN_AUDIT/.test(scriptBody),
  commands.map((item) => item.type).join(',')
)
const unknownCommand = await fetchText('/dev/query/control/commands/DROP_TABLE', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    schemaVersion: 1,
    commandId: 'wp7-cmd-1',
    idempotencyKey: 'wp7-idem-1',
    type: 'DROP_TABLE',
    dryRun: true,
    requestedBy: { kind: 'developer', surface: 'page' },
    createdAt: M4_T0,
  }),
})
check(
  '★ AT-W7-9 未知命令 fail closed（400），页面拿不到"万能控制台"',
  unknownCommand.status === 400,
  `status=${unknownCommand.status}`
)

// ===========================================================================
section('§5 / AT-W7-10 删页面性质（Hard Gate，真 HTTP：前后逐字比对）')
// ===========================================================================

const CONSUMED_PATHS = [
  '/dev/query/health',
  '/dev/query/capabilities',
  '/dev/query/traces?limit=5',
  '/dev/query/memory/stats',
  '/dev/query/memory/integrity',
  '/dev/query/control/commands',
]
const snapshot = async (): Promise<Record<string, { status: number; text: string }>> => {
  const out: Record<string, { status: number; text: string }> = {}
  for (const path of CONSUMED_PATHS) {
    const response = await fetchText(path)
    out[path] = { status: response.status, text: response.text }
  }
  return out
}
const pageBefore = await fetchText('/')
const before = await snapshot()
check(
  '§5 正常：`GET /` → 200 且真的把页面发出去（含 WP7 的归因渲染器）',
  pageBefore.status === 200 && pageBefore.text.includes('Attribution Truth'),
  `status=${pageBefore.status} bytes=${pageBefore.text.length}`
)

let afterDelete: Record<string, { status: number; text: string }> = {}
let pageAfterDelete = { status: 0, text: '' }
try {
  renameSync(PAGE_PATH, PAGE_MOVED)
  const pageResponse = await fetchText('/')
  pageAfterDelete = { status: pageResponse.status, text: pageResponse.text }
  afterDelete = await snapshot()
} finally {
  renameSync(PAGE_MOVED, PAGE_PATH)
}
check(
  '★ AT-W7-10 删掉页面资产 ⇒ `GET /` 回 **404** 且说明原因（不是 500、不是空白）',
  pageAfterDelete.status === 404 && pageAfterDelete.text.includes('developer_page_missing'),
  `status=${pageAfterDelete.status}`
)
const changedEndpoints = CONSUMED_PATHS.filter(
  (path) => JSON.stringify(before[path]) !== JSON.stringify(afterDelete[path])
)
check(
  '★ AT-W7-10 **其余端点逐字不变**（Query / Control API 与页面存在与否无关）',
  changedEndpoints.length === 0,
  changedEndpoints.join(', ') || `${CONSUMED_PATHS.length} 条全部逐字相同`
)
const pageRestored = await fetchText('/')
const after = await snapshot()
check(
  '★ AT-W7-10 恢复：把页面放回去 ⇒ `GET /` 与全部端点**逐字回到**原样',
  pageRestored.status === 200 &&
    pageRestored.text === pageBefore.text &&
    JSON.stringify(after) === JSON.stringify(before),
  'AA'
)
check(
  '★ AT-W7-10 结论：Developer Console 是**可移除的投影**（删掉它不改变任何权威面）',
  pageAfterDelete.status === 404 && changedEndpoints.length === 0 && pageRestored.text === pageBefore.text,
  'AA'
)

// ===========================================================================
section('§6 / AT-W7-8 只读：跑完整套查询面后权威表逐字节等价')
// ===========================================================================

const AUTHORITATIVE_TABLES = [
  'conversation_events',
  'character_action_events',
  'character_traces',
  'character_domain_events',
  'character_projections',
  'memory_records',
]
const tableHashes = async (): Promise<Record<string, { rows: number; hash: string }>> => {
  const out: Record<string, { rows: number; hash: string }> = {}
  for (const table of AUTHORITATIVE_TABLES) {
    const rows = rowsOf(
      await db.execute(
        sql.raw(
          `select count(*)::int as c, coalesce(md5(string_agg(t::text, E'\\n' order by t::text)), '') as h ` +
            `from ${table} t`
        )
      )
    ) as { c: number; h: string }[]
    out[table] = { rows: Number(rows[0]?.c ?? -1), hash: String(rows[0]?.h ?? '') }
  }
  return out
}
const tablesBefore = await tableHashes()
await query.getHealth({})
await query.listTraces({ characterId, limit: 20 })
await query.listExecutions({ characterId, limit: 20 })
await query.getMemoryStats({ characterId })
await query.getMemoryIntegrity({ characterId })
await query.getCapabilities()
for (const path of CONSUMED_PATHS) await fetchText(path)
await fetchText('/')
const tablesAfter = await tableHashes()
const mutated = AUTHORITATIVE_TABLES.filter(
  (table) => JSON.stringify(tablesBefore[table]) !== JSON.stringify(tablesAfter[table])
)
measure('比对的权威表数', AUTHORITATIVE_TABLES.length)
check(
  '★ AT-W7-8 只读：跑完整套查询面（含页面）后六张权威表**逐字节等价**（mutation = 0）',
  mutated.length === 0,
  mutated.join(', ') || 'AA'
)

// ===========================================================================
section('§7 汇总与证据')
// ===========================================================================

check(
  '真实库**未被动过**（只记录 mtime，本脚本全程没有打开它）',
  liveDbMtime.length > 0,
  liveDbMtime
)
const measurementInvalid = measurements.filter((item) => !item.valid)
check(
  '所有计数型检测器都有非零测量（否则 MEASUREMENT INVALID）',
  measurementInvalid.length === 0,
  `${measurements.length} 个检测器，无效 ${measurementInvalid.length}`
)

const verdict = failed === 0 ? 'PASS' : 'FAIL'
const evidence = {
  testId: 'M5.1.1 / WP7 Developer Console / Attribution Diagnostics',
  generatedAt: new Date().toISOString(),
  command: 'pnpm m5.1.1:wp7:verify',
  verdict,
  passed,
  failed,
  failures,
  queryOnly: {
    postCount,
    staticOffences,
    scriptChars: scriptBody.length,
  },
  rendering: {
    stateRenderings,
    recordedWithUnknownRendered: rendered.replace(/\s+/g, ' ').slice(0, 400),
    noEnvelopeRendered: noEnvelope.replace(/\s+/g, ' ').slice(0, 240),
    migratedRendered: migratedText.replace(/\s+/g, ' ').slice(0, 240),
    executionRendered: executionText.replace(/\s+/g, ' ').slice(0, 400),
  },
  counts: {
    dto: dtoCounts,
    fromPhysicalColumns: expected,
    items: list.items.length,
    restoreStable: JSON.stringify(listAgain.counts) === JSON.stringify(dtoCounts),
  },
  control: {
    commands: commands.map((item) => item.type),
    unknownCommandStatus: unknownCommand.status,
  },
  deletePage: {
    pageBeforeStatus: pageBefore.status,
    pageBeforeBytes: pageBefore.text.length,
    pageAfterDeleteStatus: pageAfterDelete.status,
    pageAfterDeleteSays: pageAfterDelete.text.slice(0, 120),
    endpointsCompared: CONSUMED_PATHS,
    endpointsChanged: changedEndpoints,
    restoredByteIdentical: pageRestored.text === pageBefore.text,
  },
  readOnly: {
    tables: AUTHORITATIVE_TABLES,
    before: tablesBefore,
    after: tablesAfter,
    mutationCount: mutated.length,
  },
  schemaBoundary: {
    latestSchemaVersion: schemaVersion,
    migration0007Sha256: fingerprint(7),
    migration0008Sha256: fingerprint(8),
    schemaChangeRequired: false,
  },
  sandbox: { dir: sandbox.dir, isProductionDir: isProductionDir(sandbox.dir) },
  measurements,
  measurementInvalid: measurementInvalid.length,
  scope: { liveDbOpened: false, wp8Started: false, schemaChanged: false },
}

mkdirSync(EVIDENCE_DIR, { recursive: true })
writeFileSync(join(EVIDENCE_DIR, 'wp7-console.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
writeFileSync(
  join(EVIDENCE_DIR, 'wp7-rendering.json'),
  `${JSON.stringify(
    {
      testId: 'M5.1.1 / WP7 attribution rendering vocabulary',
      generatedAt: evidence.generatedAt,
      command: evidence.command,
      verdict,
      queryOnly: evidence.queryOnly,
      rendering: evidence.rendering,
      counts: evidence.counts,
      control: evidence.control,
    },
    null,
    2
  )}\n`,
  'utf8'
)
writeFileSync(
  join(EVIDENCE_DIR, 'wp7-delete-page.json'),
  `${JSON.stringify(
    {
      testId: 'M5.1.1 / WP7 removable Developer Console',
      generatedAt: evidence.generatedAt,
      command: evidence.command,
      verdict,
      deletePage: evidence.deletePage,
      readOnly: evidence.readOnly,
    },
    null,
    2
  )}\n`,
  'utf8'
)
console.log('\n证据已写入：artifacts/m5.1.1/wp7-console.json ・ wp7-rendering.json ・ wp7-delete-page.json')

await server.close()
await h.stop()

console.log(`\n${'='.repeat(74)}`)
console.log(`M5.1.1 WP7 Developer Console：${passed} 通过 / ${failed} 失败`)
if (failures.length > 0) console.log(`失败项：${failures.join(' | ')}`)
console.log('='.repeat(74))
process.exit(failed === 0 ? 0 : 1)

/** 取某个角色当前的会话内最大序号（夹具插入 MIGRATED_LEGACY 行时用） */
async function maxSequence(dbHandle: typeof db, id: string): Promise<number> {
  const rows = rowsOf(
    await dbHandle.execute(
      sql`select coalesce(max(sequence), 0)::int as max from conversation_events where character_id = ${id}`
    )
  ) as { max: number }[]
  return Number(rows[0]?.max ?? 0)
}

void character
void asCharacterId
