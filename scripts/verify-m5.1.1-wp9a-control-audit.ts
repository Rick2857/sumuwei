/**
 * M5.1.1 / WP9-A —— **U-03 Developer Control Durable Audit 专项门**（`pnpm m5.1.1:wp9a:verify`）
 *
 * ============================================================================
 *  这一 WP 要回答的是 E8 的**真值**，不是"HTTP 200"
 * ============================================================================
 * U-03（`docs/m5.1.1/M5.1.1-Unresolved-Decisions.md`，STATUS = DECIDED）要求
 * Privileged Developer Control **最终进入 durable authoritative audit ledger**，
 * 且**不得**把 Control Command 假装成普通 Character Action。
 *
 * WP9 的 E8 门当时只能报 `NOT RUN / BLOCKED`：真实命令跑得到 `verified`，
 * 但审计面**没有生产 writer**，所以"审计行"不可能由真实运行时产生。
 * 本门证明那条缺口已被补上，并且补得**诚实**：
 *
 *   ① **正控 L1↔L2 按真实 id 关联**：真实 HTTP `RUN_DIAGNOSTIC` → ControlResult `verified`（L1）
 *      → `developer_control_events` **恰好一行**（L2），且 `L1.result.commandId === L2.commandId`。
 *      槽位逐格断言（initiator / actor / authority / recordedBy 有值，executor / contentOriginator 必须是
 *      **Absent** —— 冻结矩阵要求），生命周期列（outcome / disposition / verification）**逐字照抄**真实结果。
 *   ② **失败也必须留行**：白名单命令在执行期失败（注入的 throwing handler，真实执行链 + 真实 HTTP 面）
 *      ⇒ `attempted / failed` 的 durable 行。
 *      ⚠️ 物理约束（实测）：`developer_control_events.command_type` 的 CHECK 只允许白名单取值
 *      ⇒ 形状层就被拒的"禁止 / 未知命令"**无法**进这张审计表；因此失败覆盖只能来自执行期失败。
 *   ③ **负控：调用方自报无效**：载荷额外携带 `authorityKind / authorityRef / initiatorKind / initiatorId /
 *      executorKind`（自称 `USER_CONSENT` 权威、`USER/attacker` 发起人）⇒ 权威槽位**一格都不许动**；
 *      若形状层直接拒绝，也必须如实报出来（两种结果都接受，但必须说清是哪一种）。
 *   ④ **负控：transport 只是观测**：同一命令分别以 `cli` / `page` 提交 ⇒ 六个槽位**逐字相同**，
 *      **只有** `transport` 列不同。transport 永远不参与 principal / authority。
 *   ⑤ **负控：与 Character Action 分离**：控制命令**不**给 `character_action_events` 加行，
 *      且那张表里没有 `command_id` 这一列 —— 控制审计与"她做了什么"的账本不是同一条。
 *   ⑥ **三段式恢复（writer 必须承重）**：拆掉 `audit` ⇒ 同一条命令仍然 `verified` 但**没有**行
 *      （E8 会红）；接回 ⇒ 行重新出现。这一条是**真 check**，不是注释。
 *   ⑦ **量具健康**：每个计数型判据都自检 `measured_count > 0`；测到 0 个对象的判据一律
 *      **MEASUREMENT INVALID**，绝不报 PASS。
 *
 * 边界：一个 isolated sandbox DB（真实 schema）、真实 HTTP ingress、真实 Control Service、
 * 真实 Query 面、真实 Action Ledger（用于让"分离"这条负控**非空**）。
 * **不碰** `data/pglite`，**不改** `src/**`，**不写** `artifacts/m5.1/**` 与 `artifacts/m4.5/**`（永久冻结）。
 *
 * 跑法：pnpm m5.1.1:wp9a:verify
 */

import 'dotenv/config'
import { cleanupSandbox, isolateDatabase, isProductionDir, resetPluginSqlConnection } from '../src/dev/sandbox.ts'

const sandbox = isolateDatabase('m5.1.1-wp9a')

import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'

import { M4_T0, createM4Harness } from './m4-harness.ts'
import { currentSchemaVersion, rowsOf } from '../src/infrastructure/persistence/db.ts'
import { createDeveloperQueryService } from '../src/infrastructure/dev/query-service.ts'
import {
  createAuditControlHandler,
  createDeveloperControlService,
  createDiagnosticControlHandler,
} from '../src/infrastructure/dev/control-service.ts'
import {
  createDeveloperControlAuditWriter,
  developerControlAuditCount,
  readDeveloperControlAudit,
  type DeveloperControlAuditRow,
} from '../src/infrastructure/dev/control-audit.ts'
import { startDeveloperQueryServer, type DeveloperHttpServer } from '../src/infrastructure/dev/http-server.ts'
import { entityRef } from '../src/kernel/contracts/entity.ts'
import { createActionLedgerStore } from '../src/infrastructure/action/action-ledger-store.ts'
import { createActionRequest } from '../src/kernel/action/action-request.ts'
import { SYSTEM_ECHO } from '../src/kernel/action/capability-registry.ts'
import { newActionId, newTraceId } from '../src/kernel/contracts/ids.ts'
import { ATTRIBUTION_VALUE_SLOTS, type AttributionValueSlot } from '../src/kernel/contracts/attribution.ts'

// ---------------------------------------------------------------------------
// 检查器 / 量具
// ---------------------------------------------------------------------------

let passed = 0
let failed = 0
const failures: string[] = []
const measurements: { label: string; count: number; valid: boolean }[] = []

function check(label: string, ok: boolean, detail: string): boolean {
  if (ok) {
    passed += 1
    console.log(`  ✅ ${label}  [${detail}]`)
  } else {
    failed += 1
    failures.push(`${label} :: ${detail}`)
    console.log(`  ❌ ${label}  [${detail}]`)
  }
  return ok
}

function section(title: string): void {
  console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`)
}

/**
 * 计数型判据的自我交代。
 *
 * `valid` 的语义是**"我量到了我打算量的那个东西吗"**，不是"结果好不好"：
 * 一个读回 0 行的读取器与一个"读取器坏了"在输出上长得一样，
 * 因此每个判据都要把**被测对象数**报出来；被测对象数为 0 ⇒ MEASUREMENT INVALID。
 */
function measure(label: string, count: number, valid = count > 0): void {
  measurements.push({ label, count, valid })
  console.log(`  · 量：${label} = ${count}${valid ? '' : '   ← MEASUREMENT INVALID'}`)
}

// ---------------------------------------------------------------------------
// §0 沙箱与门边界
// ---------------------------------------------------------------------------

section('§0 沙箱：isolated sandbox DB（真实 schema）+ 门边界')

await resetPluginSqlConnection()
const h = await createM4Harness({ label: 'm511-wp9a' })
const db = h.db
const characterId = h.kernel.characterId
const schemaVersion = await currentSchemaVersion(db)

measure('沙箱 schema 版本', schemaVersion)
check(
  '沙箱 = 真实 schema v8+（注意 AGENTS §6.8：沙箱读数不能当作真实库状态）',
  schemaVersion >= 8,
  `v${schemaVersion}`
)
check(
  '沙箱不是真实库（`isProductionDir === false` 且目录在 tmp 下）',
  isProductionDir(sandbox.dir) === false && sandbox.dir.startsWith(tmpdir()),
  sandbox.dir.replace(tmpdir(), '<tmp>')
)

const query = createDeveloperQueryService({
  db,
  characterId,
  owner: entityRef('character', String(characterId)),
  identitySnapshot: h.kernel.identitySnapshot,
  now: () => M4_T0,
})

// 六个槽位的**独立**期望表（刻意不从实现里读：量具与实现不共用判据）
const EXPECTED_SLOTS: readonly AttributionValueSlot[] = [
  'initiator',
  'actor',
  'executor',
  'authority',
  'recordedBy',
  'contentOriginator',
]
measure('独立写下的期望槽位数', EXPECTED_SLOTS.length, EXPECTED_SLOTS.length === 6)
check(
  '槽位清单与 canonical `ATTRIBUTION_VALUE_SLOTS` 一致（两张清单不漂移）',
  JSON.stringify([...EXPECTED_SLOTS].sort()) === JSON.stringify([...ATTRIBUTION_VALUE_SLOTS].sort()),
  ATTRIBUTION_VALUE_SLOTS.join(',')
)

// 冻结的槽位期望（本门自己写死 —— 不是从 writer 读回来的）
const EXPECTED_ROW_SLOTS: Readonly<Record<AttributionValueSlot, string>> = {
  initiator: 'UNKNOWN|-|-|RUNTIME_UNRESOLVED',
  actor: 'KNOWN|SERVICE|control-service|-',
  executor: 'ABSENT|-|-|-',
  authority: 'KNOWN|CAPABILITY|developer.control|-',
  recordedBy: 'KNOWN|SYSTEM|kernel|-',
  contentOriginator: 'ABSENT|-|-|-',
}

// ---------------------------------------------------------------------------
// §0.5 对照夹具：**真实的** Character Action（让"分离"这条负控不是空转）
// ---------------------------------------------------------------------------

section('§0.5 对照夹具：真实的 Character Action 行（否则"行数不变"是空转）')

const actionLedger = createActionLedgerStore(db)
const fixtureActionId = newActionId()
const fixtureRequest = createActionRequest({
  actionId: fixtureActionId,
  traceId: newTraceId(),
  capability: SYSTEM_ECHO,
  operation: 'echo',
  requestedBy: { kind: 'system' },
  arguments: { text: 'WP9A-SEPARATION-FIXTURE' },
  sideEffect: 'none',
  idempotencyKey: 'wp9a-separation-fixture',
  createdAt: M4_T0,
})
await actionLedger.appendRequested({ characterId, request: fixtureRequest })
await actionLedger.appendAuthorized({
  characterId,
  request: fixtureRequest,
  target: { type: 'none', confidence: 'none' },
  decision: { allowed: true, code: 'allowed', message: 'R0 / no side effect', checks: [] },
})
await actionLedger.appendStarted({ characterId, request: fixtureRequest, target: undefined })
await actionLedger.appendSucceeded({
  characterId,
  request: fixtureRequest,
  target: undefined,
  evidence: [{ kind: 'adapter', detail: 'echo adapter returned' }],
})

const actionRowCount = async (): Promise<number> => {
  const rows = rowsOf(
    (await db.execute(sql`select count(*)::int as c from character_action_events`)) as never
  ) as { c: number }[]
  return Number(rows[0]?.c ?? 0)
}
const actionRowsForIds = async (ids: readonly string[]): Promise<number> => {
  if (ids.length === 0) return 0
  const rows = rowsOf(
    (await db.execute(
      sql`select count(*)::int as c from character_action_events where action_id in (${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `
      )})`
    )) as never
  ) as { c: number }[]
  return Number(rows[0]?.c ?? 0)
}
const actionColumnCount = async (column: string): Promise<number> => {
  const rows = rowsOf(
    (await db.execute(
      sql`select count(*)::int as c from information_schema.columns
            where table_schema = 'public' and table_name = 'character_action_events'
              and column_name = ${column}`
    )) as never
  ) as { c: number }[]
  return Number(rows[0]?.c ?? 0)
}

const actionsBefore = await actionRowCount()
measure('对照夹具写入后的 character_action_events 行数', actionsBefore)
check(
  '对照夹具真的落进了 character_action_events（"行数不变"这条负控必须有非空底数）',
  actionsBefore > 0,
  `${actionsBefore} 行（actionId=${String(fixtureActionId)}）`
)

// ---------------------------------------------------------------------------
// §1 正控：真实 HTTP 命令 → verified → durable 审计行（L1↔L2 按真实 id 关联）
// ---------------------------------------------------------------------------

section('§1 正控：真实 HTTP 命令 → verified → durable 审计行（L1↔L2 按 command_id 关联）')

const writer = createDeveloperControlAuditWriter({ db, now: () => M4_T0 })
const control = createDeveloperControlService({
  characterId,
  handlers: [createDiagnosticControlHandler(query), createAuditControlHandler(query)],
  now: () => M4_T0,
  audit: writer,
})
const server: DeveloperHttpServer = await startDeveloperQueryServer({
  service: query,
  control,
  characterId,
  port: 0,
})

/** writer 自报的位次模型（本门把它与写出来的行**分开**断言：宣言 ≠ 落库） */
measure('writer 自报的位次模型字段数', 4, true)
const writerModel = writer.attributionModel
check(
  'writer 自报模型 = authority CAPABILITY/developer.control · actor SERVICE/control-service · recordedBy SYSTEM/kernel · initiator 来源 = 无身份证据',
  JSON.stringify(writerModel.authority) === JSON.stringify({ kind: 'CAPABILITY', ref: 'developer.control' }) &&
    JSON.stringify(writerModel.actor) === JSON.stringify({ kind: 'SERVICE', id: 'control-service' }) &&
    JSON.stringify(writerModel.recordedBy) === JSON.stringify({ kind: 'SYSTEM', id: 'kernel' }) &&
    writerModel.initiatorSource === 'unknown-runtime-unresolved',
  `${JSON.stringify(writerModel.authority)} · ${JSON.stringify(writerModel.actor)} · ${JSON.stringify(writerModel.recordedBy)} · ${writerModel.initiatorSource}`
)

interface PostResult {
  status: number
  result: Record<string, unknown>
  replayed: unknown
  text: string
}
const post = async (
  url: string,
  type: 'RUN_DIAGNOSTIC' | 'RUN_AUDIT',
  body: Record<string, unknown>
): Promise<PostResult> => {
  const res = await fetch(`${url}/dev/query/control/commands/${type}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  const parsed = JSON.parse(text) as { result?: Record<string, unknown>; replayed?: unknown }
  return { status: res.status, result: parsed.result ?? {}, replayed: parsed.replayed, text }
}

const payloadFor = (
  commandId: string,
  surface: 'cli' | 'http' | 'page',
  extra: Record<string, unknown> = {}
): Record<string, unknown> => ({
  schemaVersion: 1,
  commandId,
  idempotencyKey: `idem-${commandId}`,
  type: 'RUN_DIAGNOSTIC',
  dryRun: false,
  requestedBy: { kind: 'developer', surface },
  createdAt: M4_T0,
  ...extra,
})

const okBody = payloadFor('wp9a-ok', 'http')
const okRes = await post(server.url, 'RUN_DIAGNOSTIC', okBody)
const okRows = await readDeveloperControlAudit(db, 'wp9a-ok')
const okRow: DeveloperControlAuditRow | undefined = okRows[0]

check(
  'L1：真实 HTTP 控制命令到达 `verified`（不是"200 就算执行过"）',
  okRes.status === 200 && okRes.result.outcome === 'verified',
  `status=${okRes.status} outcome=${String(okRes.result.outcome)} · body=${okRes.text.slice(0, 200)}`
)
measure('正控读回的审计行数（期望恰好 1）', okRows.length, okRows.length === 1)
check(
  'L2：`command_id = wp9a-ok` 在 `developer_control_events` 里**恰好一行**（不多不少）',
  okRows.length === 1,
  `${okRows.length} 行（sequence=${okRows.map((r) => r.sequence).join(',') || '-'}）`
)
check(
  'L1↔L2 关联：`L1.result.commandId === L2.commandId`（同一个真实 id，不是两次各自造的数）',
  okRow !== undefined && String(okRes.result.commandId) === okRow.commandId,
  `L1=${String(okRes.result.commandId)} · L2=${String(okRow?.commandId)}`
)

measure(
  '正控逐格比对的槽位数',
  EXPECTED_SLOTS.length,
  okRow !== undefined && EXPECTED_SLOTS.length === 6
)
const slotMismatches = EXPECTED_SLOTS.filter((slot) => okRow?.slots[slot] !== EXPECTED_ROW_SLOTS[slot])
check(
  'L2 槽位逐格精确：initiator=Unknown(RUNTIME_UNRESOLVED) · actor=Known(SERVICE/control-service) · authority=Known(CAPABILITY/developer.control) · recordedBy=Known(SYSTEM/kernel) · executor/contentOriginator=Absent',
  okRow !== undefined && slotMismatches.length === 0,
  EXPECTED_SLOTS.map((slot) => `${slot}=${String(okRow?.slots[slot])}`).join(' · ')
)
check(
  'L2 的 actor / authority 与调用方无关：控制面自己做的（SERVICE）· 权威来自白名单能力面（CAPABILITY）',
  okRow?.slots.actor === 'KNOWN|SERVICE|control-service|-' &&
    okRow?.slots.authority === 'KNOWN|CAPABILITY|developer.control|-',
  `actor=${String(okRow?.slots.actor)} · authority=${String(okRow?.slots.authority)}`
)
check(
  'L2 生命周期列**逐字照抄**真实结果（outcome / disposition / verification 不解释、不改写）',
  okRow !== undefined &&
    okRow.outcome === String(okRes.result.outcome) &&
    okRow.disposition === String(okRes.result.disposition) &&
    okRow.verification === String(okRes.result.verification),
  `L2=${String(okRow?.outcome)}/${String(okRow?.disposition)}/${String(okRow?.verification)} · L1=${String(okRes.result.outcome)}/${String(okRes.result.disposition)}/${String(okRes.result.verification)}`
)
check(
  '`transport` 列 = 真实 transport（http）；它**只**是观测，不参与任何 principal / authority',
  okRow?.transport === 'http' &&
    okRow.slots.authority === EXPECTED_ROW_SLOTS.authority &&
    okRow.slots.initiator === EXPECTED_ROW_SLOTS.initiator,
  `transport=${String(okRow?.transport)}`
)
check(
  '审计行确实按矩阵执行（executor / contentOriginator 是 Absent，不是 Unknown —— 两者不可折叠）',
  okRow?.slots.executor === 'ABSENT|-|-|-' && okRow?.slots.contentOriginator === 'ABSENT|-|-|-',
  `${String(okRow?.slots.executor)} · ${String(okRow?.slots.contentOriginator)}`
)

// ---------------------------------------------------------------------------
// §2 失败：白名单命令在执行期失败 ⇒ 也必须有 durable 行
// ---------------------------------------------------------------------------

section('§2 失败：白名单命令在执行期失败 ⇒ 也必须有 durable 行')

const failControl = createDeveloperControlService({
  characterId,
  handlers: [
    createDiagnosticControlHandler(query),
    {
      type: 'RUN_AUDIT',
      run: async () => {
        throw new Error('wp9a 注入的 handler 失败（走真实控制服务与真实 HTTP 面，零副作用）')
      },
    },
  ],
  now: () => M4_T0,
  audit: writer,
})
const failServer = await startDeveloperQueryServer({
  service: query,
  control: failControl,
  characterId,
  port: 0,
})
const failRes = await post(failServer.url, 'RUN_AUDIT', {
  ...payloadFor('wp9a-fail', 'http'),
  type: 'RUN_AUDIT',
})
await failServer.close()

const failRows = await readDeveloperControlAudit(db, 'wp9a-fail')
const failRow: DeveloperControlAuditRow | undefined = failRows[0]
measure('失败路径驱动的命令数', 1, true)
measure('失败命令读回的审计行数（期望恰好 1）', failRows.length, failRows.length === 1)
check(
  'L1：失败经**真实 HTTP** 回来（200 + attempted/failed，受控失败码，不是连接层错误）',
  failRes.status === 200 &&
    failRes.result.outcome === 'attempted' &&
    failRes.result.disposition === 'failed',
  `status=${failRes.status} ${String(failRes.result.outcome)}/${String(failRes.result.disposition)} reason=${String(failRes.result.reasonCode)}`
)
check(
  'L2：失败也有 durable 行（`attempted` / `failed`）—— 审计不是"只在成功后补一行"',
  failRow !== undefined && failRow.outcome === 'attempted' && failRow.disposition === 'failed',
  `outcome=${String(failRow?.outcome)} disposition=${String(failRow?.disposition)} reason=${String(failRow?.reasonCode)}`
)
check(
  'L2：失败行的 command_type 是**白名单内**的真实类型（CHECK 只允许白名单 ⇒ 被拒命令在物理上无法进这张表，这一点如实记下）',
  failRow?.commandType === 'RUN_AUDIT',
  `command_type=${String(failRow?.commandType)}`
)
check(
  'L1↔L2：失败路径同样按真实 id 关联',
  failRow !== undefined && String(failRes.result.commandId) === failRow.commandId,
  `L1=${String(failRes.result.commandId)} · L2=${String(failRow?.commandId)}`
)

// ---------------------------------------------------------------------------
// §3 负控：调用方自报 authority / initiator 无效
// ---------------------------------------------------------------------------

section('§3 负控：调用方自报 authority / initiator / executor 无效')

const FORGED_CLAIMS = {
  authorityKind: 'USER_CONSENT',
  authorityRef: 'caller.claimed',
  initiatorKind: 'USER',
  initiatorId: 'attacker',
  executorKind: 'TOOL',
} as const
const forgedRes = await post(server.url, 'RUN_DIAGNOSTIC', payloadFor('wp9a-forged', 'http', { ...FORGED_CLAIMS }))
const forgedRows = await readDeveloperControlAudit(db, 'wp9a-forged')
const forgedRow: DeveloperControlAuditRow | undefined = forgedRows[0]

measure('被检验的调用方自报字段数', Object.keys(FORGED_CLAIMS).length, Object.keys(FORGED_CLAIMS).length === 5)
/*
 * 两种可接受的结果（必须说清是哪一种）：
 *   a) 形状层直接拒绝（`parseControlCommand` 抛错）⇒ 请求根本没进权威执行链 ⇒ 无审计行；
 *   b) 形状层忽略这些字段 ⇒ 命令照常执行，但槽位只能是受信口径。
 * 今天实现走的是 (b)：`parseControlCommand` 只认识它自己的键。
 */
const forgedShapeRejected = forgedRows.length === 0
const forgedClaimsAppearInRow = forgedRows.some((row) => {
  const text = JSON.stringify(row)
  return text.includes('USER_CONSENT') || text.includes('attacker') || text.includes('caller.claimed')
})
const forgedSlotsUntouched =
  forgedRow !== undefined &&
  forgedRow.slots.authority === EXPECTED_ROW_SLOTS.authority &&
  forgedRow.slots.initiator === EXPECTED_ROW_SLOTS.initiator &&
  forgedRow.slots.executor === EXPECTED_ROW_SLOTS.executor &&
  forgedRow.slots.actor === EXPECTED_ROW_SLOTS.actor &&
  forgedRow.slots.recordedBy === EXPECTED_ROW_SLOTS.recordedBy &&
  forgedRow.slots.contentOriginator === EXPECTED_ROW_SLOTS.contentOriginator
check(
  '负控①：调用方自报的 authority / initiator / executor **一格都没进权威槽位**（要么形状层拒绝，要么被完全忽略；两种都如实接受）',
  forgedShapeRejected
    ? forgedRes.status === 400 && forgedRes.result.outcome === 'rejected'
    : forgedSlotsUntouched,
  forgedShapeRejected
    ? `形状层拒绝：HTTP ${forgedRes.status} outcome=${String(forgedRes.result.outcome)} reason=${String(forgedRes.result.reasonCode)}（无权威身份可审计）`
    : `authority=${String(forgedRow?.slots.authority)} · initiator=${String(forgedRow?.slots.initiator)} · executor=${String(forgedRow?.slots.executor)}`
)
check(
  '负控①-b：自报的取值**不出现在**任何权威列的读数里（即使它进了 payload，也不进槽位）',
  forgedShapeRejected || forgedClaimsAppearInRow === false,
  forgedShapeRejected
    ? '形状层拒绝 ⇒ 无行可查'
    : forgedClaimsAppearInRow
      ? '⚠️ 自报取值出现在了行里'
      : 'USER_CONSENT / attacker / caller.claimed 三者在行里零命中'
)
check(
  '负控①-c：自报权威被忽略之后，命令仍然如实走到 `verified`（忽略 ≠ 静默丢弃这次执行）',
  forgedShapeRejected || (forgedRes.status === 200 && forgedRes.result.outcome === 'verified'),
  forgedShapeRejected ? '形状层拒绝（不适用）' : `status=${forgedRes.status} outcome=${String(forgedRes.result.outcome)}`
)

// ---------------------------------------------------------------------------
// §4 负控：transport 只是观测（cli / page 只改 transport 列）
// ---------------------------------------------------------------------------

section('§4 负控：`surface` 换成 cli / page ⇒ 只有 `transport` 列不同')

const cliRes = await post(server.url, 'RUN_DIAGNOSTIC', payloadFor('wp9a-cli', 'cli'))
const pageRes = await post(server.url, 'RUN_DIAGNOSTIC', payloadFor('wp9a-page', 'page'))
const cliRows = await readDeveloperControlAudit(db, 'wp9a-cli')
const pageRows = await readDeveloperControlAudit(db, 'wp9a-page')
const cliRow: DeveloperControlAuditRow | undefined = cliRows[0]
const pageRow: DeveloperControlAuditRow | undefined = pageRows[0]

measure(
  '参与 transport 对比的审计行数（期望 2）',
  [cliRow, pageRow].filter((row) => row !== undefined).length,
  cliRow !== undefined && pageRow !== undefined
)
const transportSlotDiffs = EXPECTED_SLOTS.filter(
  (slot) => cliRow?.slots[slot] !== pageRow?.slots[slot]
)
measure('transport 对比逐格比对的槽位数', EXPECTED_SLOTS.length, cliRow !== undefined && pageRow !== undefined)
check(
  '负控②：六个槽位逐字相同（authority / actor / recordedBy / initiator 都不随 surface 变化）',
  cliRow !== undefined && pageRow !== undefined && transportSlotDiffs.length === 0,
  transportSlotDiffs.length === 0
    ? EXPECTED_SLOTS.map((slot) => `${slot}=${String(cliRow?.slots[slot])}`).join(' · ')
    : `不同的槽位：${transportSlotDiffs.join(', ')}`
)
check(
  '负控②-b：两行**只**在 `transport` 列不同（cli vs page），生命周期列逐字相同',
  cliRow !== undefined &&
    pageRow !== undefined &&
    cliRow.transport === 'cli' &&
    pageRow.transport === 'page' &&
    cliRow.outcome === pageRow.outcome &&
    cliRow.disposition === pageRow.disposition &&
    cliRow.verification === pageRow.verification,
  `cli.transport=${String(cliRow?.transport)} · page.transport=${String(pageRow?.transport)} · ${String(cliRow?.outcome)}/${String(pageRow?.outcome)}`
)
check(
  '负控②-c：L1 两次都到达 `verified`（对比不是拿一次失败去比）',
  cliRes.result.outcome === 'verified' && pageRes.result.outcome === 'verified',
  `${String(cliRes.result.outcome)} / ${String(pageRes.result.outcome)}`
)

// ---------------------------------------------------------------------------
// §5 负控：Developer Control 与 Character Action 分离
// ---------------------------------------------------------------------------

section('§5 负控：Developer Control 与 Character Action 分离')

const controlCommandIds = ['wp9a-ok', 'wp9a-fail', 'wp9a-forged', 'wp9a-cli', 'wp9a-page']
const actionsAfter = await actionRowCount()
/** 控制命令的 id 有没有被当成 action_id 落进行动账本（应当 0 行） */
const actionRowsHoldingControlIds = await actionRowsForIds(controlCommandIds)
/** 行动账本**有没有** `command_id` 这一列（结构上的分离） */
const commandIdColumnInActionTable = await actionColumnCount('command_id')

measure(
  '对照比较的 character_action_events 行数（before + after 合计，必须非空）',
  actionsBefore + actionsAfter,
  actionsBefore > 0 && actionsAfter > 0
)
check(
  '负控③：控制命令前后 `character_action_events` 行数**不变**（控制审计没有污染 Execution Truth）',
  actionsBefore === actionsAfter,
  `${actionsBefore} → ${actionsAfter}`
)
check(
  '负控③-b：控制命令的 id 在 `character_action_events` 里**零命中**（审计行不在行动账本里）',
  actionRowsHoldingControlIds === 0,
  `${actionRowsHoldingControlIds} 行（查了 ${controlCommandIds.length} 个控制命令 id）`
)
check(
  '负控③-c：`character_action_events` 结构上**没有** `command_id` 列 ⇒ 控制审计不可能"顺手"写进去',
  commandIdColumnInActionTable === 0,
  `information_schema 命中 ${commandIdColumnInActionTable} 列`
)

// ---------------------------------------------------------------------------
// §6 三段式恢复：拆掉 writer ⇒ 行消失（E8 必须红）；接回 ⇒ 行重现
// ---------------------------------------------------------------------------

section('§6 三段式恢复：writer 是承重的（拆掉 ⇒ 行消失；接回 ⇒ 行重现）')

const detached = createDeveloperControlService({
  characterId,
  handlers: [createDiagnosticControlHandler(query), createAuditControlHandler(query)],
  now: () => M4_T0,
  // 刻意**不**传 audit：这正是"writer 被拆掉"的负控入口
})
const detachedServer = await startDeveloperQueryServer({
  service: query,
  control: detached,
  characterId,
  port: 0,
})
const detachedRes = await post(detachedServer.url, 'RUN_DIAGNOSTIC', payloadFor('wp9a-detached', 'http'))
await detachedServer.close()
const detachedRows = await readDeveloperControlAudit(db, 'wp9a-detached')

const reattachedRes = await post(server.url, 'RUN_DIAGNOSTIC', payloadFor('wp9a-reattached', 'http'))
const reattachedRows = await readDeveloperControlAudit(db, 'wp9a-reattached')

measure('三段式驱动的阶段数（拆掉 / 接回）', 2, true)
check(
  '正控（读取器可用）：同一个读取器在**接了 writer** 的阶段读回 1 行 —— 所以下面的 0 不是"读取器坏了"',
  okRows.length === 1,
  `attached（wp9a-ok）读回 ${okRows.length} 行`
)
check(
  '负控④：拆掉 writer ⇒ 命令仍然 `verified`，但**没有** durable 行 ⇒ E8 必须红（不能靠 HTTP 200 / verified 字样继续绿）',
  detachedRes.status === 200 &&
    detachedRes.result.outcome === 'verified' &&
    detachedRows.length === 0,
  `status=${detachedRes.status} outcome=${String(detachedRes.result.outcome)} · rows=${detachedRows.length}`
)
check(
  '恢复：接回 writer ⇒ 审计行重新出现（判据不是死的，也不是"什么都没写所以没有不一致"）',
  reattachedRes.result.outcome === 'verified' && reattachedRows.length === 1,
  `outcome=${String(reattachedRes.result.outcome)} · rows=${reattachedRows.length}`
)

await server.close()
const totalAuditRows = await developerControlAuditCount(db)
measure('审计表（developer_control_events）总行数', totalAuditRows, totalAuditRows > 0)
check(
  '全表读数与逐命令读数自洽：总行数 == 本门驱动的成功/失败命令数（detached 那次不算）',
  totalAuditRows ===
    okRows.length + failRows.length + forgedRows.length + cliRows.length + pageRows.length + reattachedRows.length,
  `${totalAuditRows} == ${
    okRows.length + failRows.length + forgedRows.length + cliRows.length + pageRows.length + reattachedRows.length
  }`
)

// ---------------------------------------------------------------------------
// §7 量具健康 + 判定 + 证据
// ---------------------------------------------------------------------------

section('§7 量具健康 / 判定 / 证据')

const measurementInvalid = measurements.filter((item) => !item.valid)
check(
  '所有计数型判据都自检过 `measured_count > 0`（测到 0 个对象的一律 MEASUREMENT INVALID，不报 PASS）',
  measurementInvalid.length === 0,
  `${measurements.length} 个量具，无效 ${measurementInvalid.length} 个${
    measurementInvalid.length > 0 ? `：${measurementInvalid.map((m) => m.label).join(' , ')}` : ''
  }`
)

const verdict = failed === 0 && measurementInvalid.length === 0 ? 'PASS' : 'FAIL'
const ART = join(process.cwd(), 'artifacts', 'm5.1.1')
mkdirSync(ART, { recursive: true })

const evidence = {
  testId: 'M5.1.1 / WP9-A U-03 Developer Control durable authoritative audit',
  generatedAt: new Date().toISOString(),
  command: 'pnpm m5.1.1:wp9a:verify',
  verdict,
  passed,
  failed,
  failures,
  runtimeBoundary: {
    sandboxDir: sandbox.dir.replace(tmpdir(), '<tmp>'),
    schemaVersion,
    productionDbOpened: false,
    ingress: 'startDeveloperQueryServer（真实 node:http，仅 loopback）+ 真实 createDeveloperControlService',
    actionFixture: '真实 createActionLedgerStore + createActionRequest（为了让"分离"负控有非空底数）',
  },
  writerModel,
  expectedRowSlots: EXPECTED_ROW_SLOTS,
  level1: {
    commandId: okRes.result.commandId ?? null,
    httpStatus: okRes.status,
    outcome: okRes.result.outcome ?? null,
    disposition: okRes.result.disposition ?? null,
    verification: okRes.result.verification ?? null,
  },
  level2: {
    rowCount: okRows.length,
    correlation: {
      l1CommandId: String(okRes.result.commandId ?? ''),
      l2CommandId: okRow?.commandId ?? null,
      agree: okRow !== undefined && String(okRes.result.commandId) === okRow.commandId,
    },
    slots: okRow?.slots ?? null,
    slotMismatches,
    outcome: okRow?.outcome ?? null,
    disposition: okRow?.disposition ?? null,
    verification: okRow?.verification ?? null,
    reasonCode: okRow?.reasonCode ?? null,
    transport: okRow?.transport ?? null,
    createdAt: okRow?.createdAt ?? null,
  },
  failureRow: {
    rowCount: failRows.length,
    httpStatus: failRes.status,
    level1: {
      outcome: failRes.result.outcome ?? null,
      disposition: failRes.result.disposition ?? null,
      reasonCode: failRes.result.reasonCode ?? null,
    },
    level2: failRow ?? null,
  },
  callerSelfReport: {
    claims: FORGED_CLAIMS,
    shapeRejected: forgedShapeRejected,
    rowCount: forgedRows.length,
    claimsAppearInRow: forgedClaimsAppearInRow,
    slotsUntouched: forgedSlotsUntouched,
    row: forgedRow ?? null,
    httpStatus: forgedRes.status,
    outcome: forgedRes.result.outcome ?? null,
  },
  transportComparison: {
    slotsCompared: EXPECTED_SLOTS.length,
    slotDiffs: transportSlotDiffs,
    cli: { transport: cliRow?.transport ?? null, slots: cliRow?.slots ?? null },
    page: { transport: pageRow?.transport ?? null, slots: pageRow?.slots ?? null },
    onlyTransportDiffers: cliRow !== undefined && pageRow !== undefined && transportSlotDiffs.length === 0,
  },
  characterActionSeparation: {
    before: actionsBefore,
    after: actionsAfter,
    unchanged: actionsBefore === actionsAfter,
    actionRowsHoldingControlIds,
    controlCommandIdsChecked: controlCommandIds,
    commandIdColumnInActionTable,
  },
  restore: {
    attached: { commandId: 'wp9a-ok', rows: okRows.length },
    detached: {
      httpStatus: detachedRes.status,
      outcome: detachedRes.result.outcome ?? null,
      rows: detachedRows.length,
      expectation: 'rows === 0 ⇒ E8 在没有 writer 时是红的',
    },
    reattached: {
      httpStatus: reattachedRes.status,
      outcome: reattachedRes.result.outcome ?? null,
      rows: reattachedRows.length,
    },
  },
  auditTable: { totalRows: totalAuditRows },
  measurements,
  measurementInvalid: measurementInvalid.length,
  scope: {
    srcChangedByThisGate: false,
    frozenDirsWritten: false,
    liveDbTouched: false,
    note: '本门只写 artifacts/m5.1.1/**；artifacts/m5.1/** 与 artifacts/m4.5/** 一字未动',
  },
}
writeFileSync(join(ART, 'wp9a-control-audit.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
writeFileSync(
  join(ART, 'wp9a-gate-exits.txt'),
  `# WP9-A 专项门（U-03 Developer Control durable authoritative audit）
pnpm m5.1.1:wp9a:verify => EXIT=${verdict === 'PASS' ? 0 : 1}  **WP9-A = ${verdict}**
passed=${passed} failed=${failed} measurementInvalid=${measurementInvalid.length}

# 关键读数
level1.commandId=${String(okRes.result.commandId)}
level2.rows=${okRows.length}
level2.slots=${EXPECTED_SLOTS.map((slot) => `${slot}=${String(okRow?.slots[slot])}`).join(' | ')}
failureRow.outcome=${String(failRow?.outcome)}/${String(failRow?.disposition)}
callerSelfReport.shapeRejected=${forgedShapeRejected} claimsInRow=${forgedClaimsAppearInRow}
transport.cli=${String(cliRow?.transport)} transport.page=${String(pageRow?.transport)} slotDiffs=${transportSlotDiffs.length}
characterActionEvents=${actionsBefore}->${actionsAfter}
restore.detachedRows=${detachedRows.length} restore.reattachedRows=${reattachedRows.length}
auditTable.totalRows=${totalAuditRows}
measurements=${measurements.length} invalid=${measurementInvalid.length}

# 证据目录纪律：只写 artifacts/m5.1.1/**；artifacts/m5.1/** 与 artifacts/m4.5/** 永久冻结，一字未动
frozen_paths_written=0
${failures.map((failure) => `FAILED | ${failure}`).join('\n')}
`,
  'utf8'
)
console.log('  ↳ 证据：artifacts/m5.1.1/wp9a-control-audit.json · artifacts/m5.1.1/wp9a-gate-exits.txt')

await h.stop()
cleanupSandbox(sandbox.dir)

console.log(`\n${'='.repeat(78)}`)
console.log(
  `M5.1.1 WP9-A（U-03 Developer Control durable audit）：${passed} 通过 / ${failed} 失败｜**WP9-A = ${verdict}**`
)
console.log('='.repeat(78))
if (failed > 0) console.log(`失败项：\n${failures.map((failure) => `    - ${failure}`).join('\n')}`)
process.exit(failed === 0 && measurements.every((m) => m.valid) ? 0 : 1)
