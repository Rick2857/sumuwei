/**
 * M5.1 WP2 —— **只读查询面门**（`pnpm m5.1:query:verify`）。
 *
 * ============================================================================
 *  这一 WP 的灵魂是 AT2.7 那条 Hard Test
 * ============================================================================
 * 计划书写得很直接：
 *
 *      Snapshot DB / ledger counters
 *             ↓
 *      invoke ALL Query endpoints
 *             ↓
 *      snapshot again
 *             ↓
 *      must be identical
 *
 *      这是 Hard Test。不能只依赖代码审查判断"看起来没有写"。
 *
 * 因此这个脚本做四件事，缺一不可：
 *
 *   ① **量具范围正确**：快照遍历库里**全部**表（动态取 `information_schema`），
 *      并且断言内核的关键表确实都在 —— 量的是一个装好的库，而不是一个空库
 *      （INV-M45-06 的前半句：先证明量到的东西真的是要判断的那个东西）。
 *   ② **真实 HTTP**：不是直接调 service，而是 `fetch()` 打**真实的** loopback
 *      HTTP 端点（8 个全打，含 `:id` 路由）。"handler 里没写 SQL"这件事
 *      只有在真的走一遍 handler 之后才有证据。
 *   ③ **量具必须会响**：做完快照 A → 打全部端点 → 快照 B（必须等于 A）之后，
 *      再**故意写一次**，快照 C 必须**不等于** A。
 *      一个永远返回同一个值的快照函数会让 Hard Test 无条件通过 —— 那种绿没有意义。
 *   ④ **正控 + 隐私负控**：每个端点返回的**值**也要对（trace 的 selectedMemoryIds
 *      与账本一致、memory 统计与**直接 SQL 计数**一致、执行 DTO 的
 *      attempted/executed 与账本一致），且记忆正文与动作参数**一个字都不出现**在响应里。
 *
 * 跑法：pnpm m5.1:query:verify
 */

import 'dotenv/config'

import { cleanupSandbox, isolateDatabase, resetPluginSqlConnection } from '../src/dev/sandbox.ts'

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'

import { M4_T0, createM4Harness, createReporter } from './m4-harness.ts'
import { exec, rowsOf } from '../src/infrastructure/persistence/db.ts'
import { createActionLedgerStore } from '../src/infrastructure/action/action-ledger-store.ts'
import { createDeveloperQueryService } from '../src/infrastructure/dev/query-service.ts'
import {
  DEFAULT_DEVELOPER_HTTP_PORT,
  developerQueryRoutePatterns,
  isLoopbackAddress,
  isLoopbackHost,
  startDeveloperQueryServer,
} from '../src/infrastructure/dev/http-server.ts'
import { createActionRequest } from '../src/kernel/action/action-request.ts'
import { newActionId, newTraceId } from '../src/kernel/contracts/ids.ts'
import { SYSTEM_ECHO } from '../src/kernel/action/capability-registry.ts'

function readFile(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), 'utf8')
}

const report = createReporter()
const sandbox = isolateDatabase('m51-query', { keep: false })
await resetPluginSqlConnection()
const h = await createM4Harness({ label: 'm51-query' })
const db = h.db

// ---------------------------------------------------------------------------
// fixture：记忆 + 一条 trace + 一条执行记录（**全部经权威写入路径**）
// ---------------------------------------------------------------------------

const MEMORY_SENTINEL = 'M51-QUERY-SENTINEL-大学'
const ACTION_ARG_SENTINEL = 'M51-ACTION-ARG-SENTINEL'

const evidence = await h.recordUserEvidence(`记住，我现在上的大学是${MEMORY_SENTINEL}`)
const memoryRecord = await h.commitAndFold(
  h.makeCandidate(
    'person_fact',
    { kind: 'claim', subject: h.user, predicate: 'education.institution', value: MEMORY_SENTINEL },
    { sourceRefs: [evidence.ref] }
  ),
  M4_T0
)
if (memoryRecord === null) throw new Error('fixture 失败：记忆没有落库')

// 一条真实的 trace（走 TraceWriter —— 也就是 trace 的权威写入路径）
const traceId = newTraceId()
await h.kernel.stores.traceWriter.start({
  traceId,
  characterId: h.kernel.characterId,
  runtimeId: 'runtime-m51-query',
  userId: h.userId,
  conversationId: 'conv-m51-query',
  seedVersion: h.kernel.identitySnapshot.seedVersion,
  seedHash: h.kernel.identitySnapshot.snapshotHash,
  identitySourceRefs: [
    `character-definition:${String(h.kernel.characterId)}@${h.kernel.identitySnapshot.seedVersion}`,
  ],
  inputEventId: evidence.event.id,
  contextSectionIds: ['identity-core', 'memory-recall'],
  droppedSectionIds: [],
  sourceConversationEventIds: [String(evidence.event.id)],
  selectedMemoryIds: [String(memoryRecord.id)],
  projectionRevisionsAtStart: {},
  projectionRevisionsAtEnd: {},
  domainEventIds: [],
  actionIds: [],
  modelProfile: 'fixture-model',
  postTurnJobIds: [],
  processorVersions: {},
  steps: [
    {
      kind: 'memory_recall',
      label: '召回',
      startedAt: M4_T0,
      finishedAt: M4_T0 + 3,
      status: 'ok',
      attributes: { candidate_count: 1, selected_count: 1 },
    },
  ],
  status: 'completed',
  startedAt: M4_T0,
  finishedAt: M4_T0 + 10,
})

// 一条真实的执行记录（走 ExecutionLedgerPort —— 行动账本的权威写入路径）
const ledger = createActionLedgerStore(db)
const actionId = newActionId()
const actionTraceId = newTraceId()
const actionRequest = createActionRequest({
  actionId,
  traceId: actionTraceId,
  capability: SYSTEM_ECHO,
  operation: 'echo',
  requestedBy: { kind: 'system' },
  arguments: { text: ACTION_ARG_SENTINEL },
  sideEffect: 'none',
  idempotencyKey: 'm51-query-idem-1',
  createdAt: M4_T0,
})
await ledger.appendRequested({ characterId: h.kernel.characterId, request: actionRequest })
await ledger.appendAuthorized({
  characterId: h.kernel.characterId,
  request: actionRequest,
  target: { type: 'none', confidence: 'none' },
  decision: { allowed: true, code: 'allowed', message: 'R0 / no side effect', checks: [] },
})
await ledger.appendStarted({
  characterId: h.kernel.characterId,
  request: actionRequest,
  target: undefined,
})
await ledger.appendSucceeded({
  characterId: h.kernel.characterId,
  request: actionRequest,
  target: undefined,
  evidence: [{ kind: 'adapter', detail: 'echo adapter returned' }],
})

// ---------------------------------------------------------------------------
// 量具：整库快照
// ---------------------------------------------------------------------------

/**
 * 快照**必须**覆盖到的内核表（正向下限）。
 *
 * ⚠️ 快照本身是**动态**的（遍历 `information_schema` 里的**全部**表），
 *    所以"将来有人加了一张可写表却忘了加进清单"这件事在结构上不会发生。
 *    这张清单回答的是另一个问题：**我们量的确实是一个装好的库**
 *    —— 而不是一个空库（后者会让"零 mutation"变得毫无意义）。
 */
const EXPECTED_TABLES_FLOOR = [
  'character_action_events',
  'character_definition_versions',
  'character_definitions',
  'character_domain_events',
  'character_projections',
  'character_schema_migrations',
  'character_traces',
  'conversation_events',
  'memory_events',
  'memory_evidence_links',
  'memory_records',
  'memory_subject_links',
]

interface TableSnapshot {
  rows: number
  digest: string
}

async function tableNames(): Promise<string[]> {
  const rows = rowsOf(
    await exec(
      db,
      sql`select table_name from information_schema.tables
          where table_schema = 'public' order by table_name`,
      '列出全部表'
    )
  )
  return rows.map((row) => String(row.table_name))
}

/**
 * 整库快照：每张表的**行数** + **内容摘要**。
 *
 * 只数行数抓不到 UPDATE（"改了一行"与"什么都没发生"在计数上完全一样），
 * 因此摘要必须覆盖**每一行每一列的取值**；行序用排序消除
 * （我们比的是内容集合，不是物理顺序）。
 */
async function snapshotDatabase(): Promise<Record<string, TableSnapshot>> {
  const names = await tableNames()
  const out: Record<string, TableSnapshot> = {}
  for (const name of names) {
    const rows = rowsOf(await exec(db, sql.raw(`select * from "${name}"`), `快照 ${name}`))
    const serialized = rows
      .map((row) =>
        JSON.stringify(
          Object.keys(row)
            .sort()
            .map((key) => [key, row[key] ?? null])
        )
      )
      .sort()
    out[name] = {
      rows: rows.length,
      digest: createHash('sha256').update(serialized.join('\n')).digest('hex').slice(0, 32),
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// 真实 HTTP
// ---------------------------------------------------------------------------

const service = createDeveloperQueryService({
  db,
  characterId: h.kernel.characterId,
  owner: h.owner,
  runtimeId: 'runtime-m51-query',
  identitySnapshot: h.kernel.identitySnapshot,
  now: () => M4_T0,
})
const server = await startDeveloperQueryServer({
  service,
  characterId: h.kernel.characterId,
  port: 0,
})

interface HttpResult {
  status: number
  body: unknown
  text: string
}

async function get(path: string): Promise<HttpResult> {
  const response = await fetch(`${server.url}${path}`)
  const text = await response.text()
  return { status: response.status, body: JSON.parse(text) as unknown, text }
}

async function send(method: string, path: string): Promise<HttpResult> {
  const response = await fetch(`${server.url}${path}`, { method })
  const text = await response.text()
  return { status: response.status, body: JSON.parse(text) as unknown, text }
}

const ALL_PATHS = [
  '/dev/query/health',
  '/dev/query/capabilities',
  '/dev/query/traces',
  '/dev/query/traces/:id',
  '/dev/query/memory/stats',
  '/dev/query/memory/integrity',
  '/dev/query/executions',
  '/dev/query/executions/:id',
]

/** 8 个具体 URL（`:id` 那两个分别指向真实 trace 与真实 action） */
const INVOCATION_URLS = [
  '/dev/query/health',
  '/dev/query/capabilities',
  '/dev/query/traces',
  `/dev/query/traces/${String(traceId)}`,
  '/dev/query/memory/stats',
  '/dev/query/memory/integrity',
  '/dev/query/executions',
  `/dev/query/executions/${String(actionId)}`,
]

// ===========================================================================
report.section('AT2.3 / AT2.6：路由表与 8 个端点')
// ===========================================================================

report.check(
  '端点清单正好是 AT2.6 的 8 个（prefix = /dev/query）',
  JSON.stringify(developerQueryRoutePatterns()) === JSON.stringify(ALL_PATHS),
  developerQueryRoutePatterns().join(' , ')
)

for (const path of INVOCATION_URLS) {
  const result = await get(path)
  report.check(`GET ${path} → 200`, result.status === 200, `status=${result.status}`)
}

// ===========================================================================
report.section('AT2.7 HARD TEST：调用全部 Query 端点不得产生任何 mutation')
// ===========================================================================

const tables = await tableNames()
const missingFloor = EXPECTED_TABLES_FLOOR.filter((name) => !tables.includes(name))
report.check(
  '量具范围正确：快照覆盖库里全部表，且内核的关键表都在（量的不是空库）',
  missingFloor.length === 0,
  missingFloor.length === 0
    ? `${tables.length} 张表全部纳入快照`
    : `以下关键表不存在：${missingFloor.join(', ')}`
)

const before = await snapshotDatabase()
const invocationResults: { path: string; status: number }[] = []
for (const path of INVOCATION_URLS) {
  const result = await get(path)
  invocationResults.push({ path, status: result.status })
}
const after = await snapshotDatabase()

const changed = Object.keys({ ...before, ...after }).filter(
  (name) => JSON.stringify(before[name]) !== JSON.stringify(after[name])
)
const queryMutationCount = changed.length
report.check(
  'Query Mutation Count = 0（前后快照逐字段相同）',
  queryMutationCount === 0,
  queryMutationCount === 0
    ? `${tables.length} 张表 / ${tables.reduce((sum, name) => sum + (before[name]?.rows ?? 0), 0)} 行，逐字段相同`
    : `发生变化的表：${changed.join(', ')}`
)

/*
 * ⚠️ 量具自检：一个永远返回同一个值的快照函数会让上面那条**无条件通过**。
 *    因此这里故意写一次（走权威写入路径），快照必须变。
 */
await ledger.appendRequested({
  characterId: h.kernel.characterId,
  request: createActionRequest({
    actionId: newActionId(),
    traceId: newTraceId(),
    capability: SYSTEM_ECHO,
    operation: 'echo',
    requestedBy: { kind: 'system' },
    arguments: {},
    sideEffect: 'none',
    createdAt: M4_T0 + 1,
  }),
})
const afterDeliberateWrite = await snapshotDatabase()
const deliberateWriteChanged = Object.keys(afterDeliberateWrite).filter(
  (name) => JSON.stringify(before[name]) !== JSON.stringify(afterDeliberateWrite[name])
)
const detectorResponded = deliberateWriteChanged.length > 0
report.check(
  '量具必须会响：故意写一次之后快照必须变化',
  detectorResponded,
  detectorResponded
    ? `变化的表：${deliberateWriteChanged.join(', ')}`
    : '快照函数没响 —— 上面那条"零 mutation"的绿是假的'
)

// ===========================================================================
report.section('AT2.2 正控：health / capabilities 的值')
// ===========================================================================

const health = await get('/dev/query/health')
const healthBody = health.body as {
  status: string
  schemaVersion: number
  migrationVersion?: number
  seedVersion?: number
  integrityOk?: boolean
  details: { name: string; status: string }[]
}
report.check('health.status 非 failed', healthBody.status !== 'failed', healthBody.status)
report.check(
  'health.migrationVersion 与库实际一致（>= 6）',
  typeof healthBody.migrationVersion === 'number' && healthBody.migrationVersion >= 6,
  `v${String(healthBody.migrationVersion)}`
)
report.check(
  'health.seedVersion 来自注入的身份快照（唯一来源）',
  healthBody.seedVersion === h.kernel.identitySnapshot.seedVersion,
  `seed=v${String(healthBody.seedVersion)}`
)
report.check(
  'health.integrityOk 来自 M5-PRE 探针（本 fixture 应为 true）',
  healthBody.integrityOk === true
)
report.check(
  'health.details 覆盖 schema / memory_integrity / identity',
  ['schema', 'memory_integrity', 'identity'].every((name) =>
    healthBody.details.some((detail) => detail.name === name)
  ),
  healthBody.details.map((detail) => `${detail.name}=${detail.status}`).join(' ')
)

const capabilities = (await get('/dev/query/capabilities')).body as {
  query: { id: string; authority: string }[]
  runtime: { id: string; availability: { status: string; reason?: string } }[]
}
report.check(
  'capabilities.query 有 8 个端点且每个都有 authority',
  capabilities.query.length === 8 && capabilities.query.every((item) => item.authority !== '')
)
report.check(
  'capabilities.runtime 含动作能力（来自 M4.5 登记表）与召回通道',
  capabilities.runtime.some((item) => item.id === SYSTEM_ECHO) &&
    capabilities.runtime.some((item) => item.id === 'semantic_retrieval')
)
const semantic = capabilities.runtime.find((item) => item.id === 'semantic_retrieval')
report.check(
  '语义检索**如实**标为 not_available（不是 0 分）',
  semantic?.availability.status === 'not_available' && (semantic?.availability.reason ?? '') !== '',
  semantic?.availability.status ?? '(缺失)'
)

// ===========================================================================
report.section('AT2.3 正控：trace 分页与详情（与账本一致）')
// ===========================================================================

const traceList = (await get('/dev/query/traces?limit=5')).body as {
  items: {
    traceId: string
    selectedMemoryIds: string[]
    stepCount: number
    hasError: boolean
    durationMs?: number
  }[]
  hasMore: boolean
  limit: number
}
const listed = traceList.items.find((item) => item.traceId === String(traceId))
report.check('traces 列表里有刚写的 trace', listed !== undefined)
report.check(
  'trace 摘要的 selectedMemoryIds 与写入逐字一致',
  JSON.stringify(listed?.selectedMemoryIds) === JSON.stringify([String(memoryRecord.id)]),
  JSON.stringify(listed?.selectedMemoryIds)
)
report.check(
  'trace 摘要的 stepCount / durationMs 是派生值',
  listed?.stepCount === 1 && listed?.durationMs === 10
)
report.check('trace 列表回显 limit', traceList.limit === 5)

const traceDetail = (await get(`/dev/query/traces/${String(traceId)}`)).body as {
  steps: { kind: string; durationMs?: number }[]
  contextSectionIds: string[]
  identitySourceRefs: string[]
}
report.check(
  'trace 详情的 steps 含 memory_recall 且 duration 是派生的',
  traceDetail.steps.some((step) => step.kind === 'memory_recall' && step.durationMs === 3),
  traceDetail.steps.map((step) => step.kind).join(',')
)
report.check(
  'trace 详情的 contextSectionIds 与写入一致',
  JSON.stringify(traceDetail.contextSectionIds) === JSON.stringify([
    'identity-core',
    'memory-recall',
  ])
)
report.check(
  'trace 详情的 identitySourceRefs 指向 Seed 版本',
  (traceDetail.identitySourceRefs[0] ?? '').includes('@')
)

const missingTrace = await get('/dev/query/traces/trace-does-not-exist')
report.check(
  '不存在的 trace → 404 且理由码是 not_found',
  missingTrace.status === 404 &&
    (missingTrace.body as { error: { code: string } }).error.code === 'not_found',
  `status=${missingTrace.status}`
)

// ===========================================================================
report.section('AT2.4 正控：memory 诊断（与直接 SQL 计数一致，不重实现）')
// ===========================================================================

const stats = (await get('/dev/query/memory/stats')).body as {
  total: number
  active: number
  integrity: { integrityOk: boolean; danglingEvidenceLinks: unknown[] }
  unsupported: number
  contaminated: number
}
const directCounts = rowsOf(
  await exec(
    db,
    sql`select status, count(*)::int as c from memory_records
        where owner_kind = 'character' and owner_id = ${String(h.kernel.characterId)}
        group by status`,
    '直接统计记忆'
  )
)
const directTotal = directCounts.reduce((sum, row) => sum + Number(row.c), 0)
const directActive = Number(directCounts.find((row) => String(row.status) === 'active')?.c ?? 0)
report.check(
  'memory stats 的 total / active 与**直接 SQL** 计数一致',
  stats.total === directTotal && stats.active === directActive,
  `dto=${stats.total}/${stats.active} sql=${directTotal}/${directActive}`
)
report.check(
  'memory stats 里嵌了 M5-PRE 的完整性结论',
  stats.integrity !== undefined && stats.integrity.integrityOk === true
)

const integrity = (await get('/dev/query/memory/integrity')).body as {
  danglingEvidenceLinks: unknown[]
  memoriesWithoutLiveEvidence: unknown[]
  integrityOk: boolean
}
report.check(
  'integrity 端点与 stats 里的那一段同源（同一探针）',
  integrity.integrityOk === stats.integrity.integrityOk &&
    integrity.danglingEvidenceLinks.length === stats.integrity.danglingEvidenceLinks.length
)

// ===========================================================================
report.section('AT2.5 正控：执行 DTO（attempted / executed / verification 如实）')
// ===========================================================================

const executions = (await get('/dev/query/executions?limit=10')).body as {
  items: {
    actionId: string
    accepted: boolean
    attempted: boolean
    executed: boolean
    status: string
    durationMs?: number
    failureCode?: string
  }[]
  hasMore: boolean
}
const listedAction = executions.items.find((item) => item.actionId === String(actionId))
report.check('executions 列表里有刚写的 action', listedAction !== undefined)
report.check(
  'attempted / executed 与账本一致（本 fixture 是 executed）',
  listedAction?.accepted === true &&
    listedAction?.attempted === true &&
    listedAction?.executed === true,
  JSON.stringify(listedAction)
)
report.check(
  '执行的 keyset 分页**如实**回 hasMore=false（账本查询口没有 cursor）',
  executions.hasMore === false
)

/*
 * ⚠️ 这条断言是**被一次真实缺陷**催生的：service 曾经自己写 `finishedAt - requestedAt`
 *    （绕开契约层的 `developerDurationMs`），于是当账本的 `createdAt` 用真实时钟、
 *    而 fixture 用固定时刻时，`durationMs` 变成了一个**负数**
 *    （实测 `-10351909773`）—— 而当时**所有**断言都是绿的。
 *
 *    耗时的语义是"**非负**或**未知**"，因此这里把两者分开量：
 *    不是"必须等于某个数"，而是"不许是负数"。
 */
const negativeDurations = [...traceList.items, ...executions.items].filter(
  (item) => item.durationMs !== undefined && item.durationMs < 0
)
report.check(
  '所有派生耗时要么缺省、要么非负（时间倒退 → 缺省，不是负数）',
  negativeDurations.length === 0,
  negativeDurations.length === 0
    ? `${traceList.items.length + executions.items.length} 条记录，无负数耗时`
    : JSON.stringify(negativeDurations.slice(0, 2))
)

const detail = (await get(`/dev/query/executions/${String(actionId)}`)).body as {
  intent: { availability: { status: string; reason?: string } }
  verification: { state: string; evidence?: string }
  request: { argumentKeys: string[] }
  attempt: { attempted: boolean; evidenceRef: string }
  result: { status: string; executed: boolean }
  evidence: { kind: string; detail: string }[]
}
report.check(
  'intent **如实**标为 not_available（没有意图分类器，不编一个值）',
  detail.intent.availability.status === 'not_available' &&
    (detail.intent.availability.reason ?? '').includes('意图分类器'),
  detail.intent.availability.status
)
report.check(
  'verification 是 not_attempted（不是 failed —— 没核验过与核验失败是两件事）',
  detail.verification.state === 'not_attempted' && (detail.verification.evidence ?? '') !== ''
)
report.check(
  'attempt 带证据引用（ACTION_STARTED）',
  detail.attempt.attempted === true && detail.attempt.evidenceRef.includes('ACTION_STARTED')
)
report.check(
  'result 与账本终态一致',
  detail.result.status === 'success' && detail.result.executed === true
)
report.check('evidence 被投影出来', detail.evidence.length > 0, `${detail.evidence.length} 条`)
report.check(
  '请求参数**只回键名**（argumentKeys 含 text）',
  detail.request.argumentKeys.includes('text')
)

// ===========================================================================
report.section('隐私负控：记忆正文与动作参数一个字都不出现在响应里')
// ===========================================================================

const bodies: Record<string, string> = {}
for (const path of INVOCATION_URLS) {
  bodies[path] = (await get(path)).text
}
const leakedMemory = Object.entries(bodies).filter(([, text]) => text.includes(MEMORY_SENTINEL))
const leakedArgs = Object.entries(bodies).filter(([, text]) => text.includes(ACTION_ARG_SENTINEL))
report.check(
  '记忆正文不出现在任何 Query 响应里',
  leakedMemory.length === 0,
  leakedMemory.map(([path]) => path).join(', ')
)
report.check(
  '动作参数取值不出现在任何 Query 响应里',
  leakedArgs.length === 0,
  leakedArgs.map(([path]) => path).join(', ')
)

// ===========================================================================
report.section('AT5.1 四道闸：loopback / 只读 / 未知路由 / 参数失败关闭')
// ===========================================================================

report.check(
  'isLoopbackHost：127.0.0.1 / ::1 / localhost / 127.0.0.5 都是回环',
  [
    isLoopbackHost('127.0.0.1'),
    isLoopbackHost('::1'),
    isLoopbackHost('localhost'),
    isLoopbackHost('127.0.0.5'),
  ].every(Boolean)
)
report.check(
  'isLoopbackHost：0.0.0.0 / 局域网 IP / 主机名都不是回环',
  [isLoopbackHost('0.0.0.0'), isLoopbackHost('192.168.1.10'), isLoopbackHost('example.com')].every(
    (value) => value === false
  )
)
report.check(
  'isLoopbackAddress：IPv4 映射形式也要认',
  isLoopbackAddress('::ffff:127.0.0.1') === true && isLoopbackAddress('10.0.0.2') === false
)

let nonLoopbackRejected = false
try {
  await startDeveloperQueryServer({
    service,
    characterId: h.kernel.characterId,
    host: '0.0.0.0',
    port: 0,
  })
} catch (error) {
  nonLoopbackRejected = String((error as Error).message).includes('只允许绑回环地址')
}
report.check('闸②：host=0.0.0.0 直接拒绝启动（不"警告后继续"）', nonLoopbackRejected)

const postAttempt = await send('POST', '/dev/query/health')
report.check(
  '闸④：写方法一律 405（Query 面没有写语义）',
  postAttempt.status === 405,
  `status=${postAttempt.status}`
)

const unknownRoute = await get('/dev/query/does-not-exist')
report.check('未知路由 → 404', unknownRoute.status === 404)

const badLimit = await get('/dev/query/traces?limit=0')
report.check(
  '?limit=0 → 400 developer_limit_out_of_range（不夹住、不静默默认）',
  badLimit.status === 400 &&
    (badLimit.body as { error: { code: string } }).error.code === 'developer_limit_out_of_range',
  `status=${badLimit.status}`
)
const nanLimit = await get('/dev/query/traces?limit=abc')
report.check(
  '?limit=abc → 400 developer_bad_limit（不悄悄兜底成默认值）',
  nanLimit.status === 400 &&
    (nanLimit.body as { error: { code: string } }).error.code === 'developer_bad_limit',
  `status=${nanLimit.status}`
)
const unknownParam = await get('/dev/query/traces?orderBy=x')
report.check(
  '未知查询参数 → 400 developer_query_unknown_field（静默忽略会让参数"传了没生效"）',
  unknownParam.status === 400 &&
    (unknownParam.body as { error: { code: string } }).error.code ===
      'developer_query_unknown_field',
  `status=${unknownParam.status}`
)
const badStatus = await get('/dev/query/traces?status=green')
report.check(
  '?status=green → 400（状态是受控枚举）',
  badStatus.status === 400,
  `status=${badStatus.status}`
)
report.check(
  '错误响应里没有 stack（只有 code + message）',
  !('stack' in (unknownRoute.body as Record<string, unknown>)) &&
    Object.keys(unknownRoute.body as Record<string, unknown>).join(',') === 'error'
)

// ===========================================================================
report.section('静态锁：这一层里没有 SQL，也没有写方法')
// ===========================================================================

const httpSource = readFile('src/infrastructure/dev/http-server.ts')
const serviceSource = readFile('src/infrastructure/dev/query-service.ts')
report.check(
  'HTTP handler 层不含任何 SQL 字面量',
  !/\b(select|insert\s+into|update\s+\w+\s+set|delete\s+from)\b/i.test(httpSource),
  'AT2.1：不得在 HTTP handler 内编写 arbitrary SQL'
)
report.check(
  'query-service 只出现 select（没有 insert / update / delete）',
  !/\b(insert\s+into|update\s+\w+\s+set|delete\s+from)\b/i.test(serviceSource),
  'G-03：Query 面不可能写'
)

// ===========================================================================
// 证据
// ===========================================================================

await server.close()

mkdirSync(join(process.cwd(), 'artifacts', 'm5.1'), { recursive: true })
writeFileSync(
  join(process.cwd(), 'artifacts', 'm5.1', 'query-negative-control.json'),
  `${JSON.stringify(
    {
      testId: 'M5.1 / WP2 unified read-only query API',
      generatedAt: new Date().toISOString(),
      sandbox: sandbox.dir,
      endpointPatterns: developerQueryRoutePatterns(),
      invocationUrls: INVOCATION_URLS,
      invoked: invocationResults,
      snapshot: {
        tableCount: tables.length,
        rowCount: Object.values(before).reduce((sum, item) => sum + item.rows, 0),
        tables: Object.keys(before).sort(),
        before,
        after,
        queryMutationCount,
        changedTables: changed,
        detectorSelfCheck: {
          deliberateWriteChangedTables: deliberateWriteChanged,
          detectorResponded,
        },
      },
      privacy: {
        memorySentinelLeaks: leakedMemory.map(([path]) => path),
        actionArgumentLeaks: leakedArgs.map(([path]) => path),
      },
      hardGateVerdict: queryMutationCount === 0 && detectorResponded ? 'PASS' : 'FAIL',
      guardChecks: {
        nonLoopbackRejected,
        postMethodStatus: postAttempt.status,
        unknownRouteStatus: unknownRoute.status,
        badLimitStatus: badLimit.status,
        nanLimitStatus: nanLimit.status,
        unknownParamStatus: unknownParam.status,
        badStatusStatus: badStatus.status,
      },
      defaultPort: DEFAULT_DEVELOPER_HTTP_PORT,
      expectedTableFloor: EXPECTED_TABLES_FLOOR,
    },
    null,
    2
  )}\n`,
  'utf8'
)
console.log('证据已写入：artifacts/m5.1/query-negative-control.json')

await h.stop()
cleanupSandbox(sandbox.dir)
report.finish('M5.1 WP2 只读查询面门')
