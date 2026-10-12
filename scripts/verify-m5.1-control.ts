/**
 * M5.1 WP3 —— **开发者控制面门**（`pnpm m5.1:control:verify`）。
 *
 * ============================================================================
 *  这一 WP 的灵魂是 AT3.6 与 WP3 的 HARD GATE
 * ============================================================================
 * 计划书写得很直接：
 *
 *      分别制造：Rejected / Accepted but not attempted / Attempted but failed /
 *               Executed but verification failed / Verified
 *      验证 ControlResult 能准确区分。
 *
 *      禁止：HTTP 200 == executed
 *
 *      WP3 HARD GATE：执行结果与 Ledger / authoritative state 不一致 → FAIL
 *
 * 因此这个脚本做五件事：
 *
 *   ① **五档全部走真实 HTTP**（`POST /dev/query/control/commands/:type`），
 *      并断言它们的 fingerprint **两两不同** —— 一个把 `accepted` 与 `executed`
 *      看成同一件事的判据，会让 AT3.6 变成一句空话。
 *   ② **"HTTP 200 == executed" 必须可被证伪**：`accepted`（dryRun）与 `verified`
 *      同为 200，而 `attempted`（失败）也是 200，`rejected` 是 400 ——
 *      状态码与执行真想在**两个方向上**都被证明不是一回事。
 *   ③ **HARD GATE：结果与权威状态一致**。三重交叉核对：
 *      · 只读命令执行前后，**领域表**逐字段相同（`mutatesDomain === false` 的可测形式）
 *      · 结果里每一条**权威读数**都必须在**另一个面**（Query API）上复现
 *      · 结果里每一条**执行主张**都必须有对应证据（handler 真的跑过 / 真的是重放）
 *   ④ **量具必须会响**（INV-M45-06）：故意伪造一条**丢掉重放标记**的结果，
 *      一致性检测必须报出来。一个永远说"一致"的检测器与一个真的都一致的系统，
 *      在输出上完全一样。
 *   ⑤ 幂等（AT3.3）：同一个 key 打两次，handler **只被调用一次**，
 *      第二次回的是**逐字相同**的结论 + 明确标出"本次没有再次执行"；
 *      dryRun 不进入执行路径（AT3.2）；七个禁止命令逐个被拒（AT3.5）。
 *
 * 跑法：pnpm m5.1:control:verify
 */

import 'dotenv/config'

import { cleanupSandbox, isolateDatabase, resetPluginSqlConnection } from '../src/dev/sandbox.ts'

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'

import { M4_T0, createM4Harness, createReporter } from './m4-harness.ts'
import { exec, rowsOf } from '../src/infrastructure/persistence/db.ts'
import { createDeveloperQueryService } from '../src/infrastructure/dev/query-service.ts'
import {
  createAuditControlHandler,
  createDeveloperControlService,
  createDiagnosticControlHandler,
  createInMemoryControlIdempotencyStore,
  type ControlCommandHandler,
  type DeveloperControlService,
} from '../src/infrastructure/dev/control-service.ts'
import {
  developerControlRoutePatterns,
  startDeveloperQueryServer,
} from '../src/infrastructure/dev/http-server.ts'
import {
  CONTROL_COMMAND_TYPES,
  FORBIDDEN_CONTROL_COMMANDS,
  controlResultFingerprint,
  describeControlResult,
  type ControlResult,
} from '../src/kernel/contracts/developer-control.ts'

const report = createReporter()
const sandbox = isolateDatabase('m51-control', { keep: false })
await resetPluginSqlConnection()
const h = await createM4Harness({ label: 'm51-control' })
const db = h.db

// ---------------------------------------------------------------------------
// fixture：一条记忆（权威写入路径）
// ---------------------------------------------------------------------------

const MEMORY_SENTINEL = 'M51-CONTROL-SENTINEL-示例工程科技大学'
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

// ---------------------------------------------------------------------------
// 装配
// ---------------------------------------------------------------------------

const characterId = h.kernel.characterId
const query = createDeveloperQueryService({
  db,
  characterId,
  owner: h.owner,
  identitySnapshot: h.kernel.identitySnapshot,
  now: () => M4_T0,
})

/** handler 真的被调了几次（AT3.3 与 AT3.2 的判据都靠它） */
const handlerRuns: string[] = []
const runsOf = (type: string): number => handlerRuns.filter((item) => item === type).length

/**
 * 故障注入用的 handler。
 *
 * ⚠️ 用**注入**而不是给生产 handler 加一个 `shouldFail` 开关：
 *    那是"测试用的后门进了生产代码"。依赖注入是这个仓库既有的做法
 *    （见 `ActionGatewayOptions.resolveTarget`、`MemoryContentExtractor` 链）。
 *    它让 AT3.6 中间两档有**真实生产者**，而不是只写在文档里。
 */
const faultyHandler = (mode: 'throw' | 'verify-fail'): ControlCommandHandler => ({
  type: 'RUN_DIAGNOSTIC',
  async run() {
    if (mode === 'throw') {
      throw new Error('注入的失败')
    }
    return {
      report: { metrics: { injected: true, claimed_total: 999 }, notes: ['注入的核验失败'] },
      verify: async () => ({
        ok: false,
        evidence: '重读：报告说 999，实际不是（注入的核验失败）',
      }),
    }
  },
})

const sharedStore = createInMemoryControlIdempotencyStore()

function buildControl(options: {
  diagnostic?: ControlCommandHandler
  store?: ReturnType<typeof createInMemoryControlIdempotencyStore>
}): DeveloperControlService {
  return createDeveloperControlService({
    characterId,
    handlers: [
      options.diagnostic ?? createDiagnosticControlHandler(query),
      createAuditControlHandler(query),
    ],
    idempotency: options.store ?? sharedStore,
    now: () => M4_T0,
    onHandlerRun: (type) => handlerRuns.push(type),
  })
}

let control = buildControl({})
let server = await startDeveloperQueryServer({
  service: query,
  control,
  characterId,
  port: 0,
})

async function restartServer(next: DeveloperControlService): Promise<void> {
  await server.close()
  control = next
  server = await startDeveloperQueryServer({ service: query, control: next, characterId, port: 0 })
}

// ---------------------------------------------------------------------------
// 真实 HTTP
// ---------------------------------------------------------------------------

interface ControlHttpResult {
  status: number
  result?: ControlResult
  report?: { metrics: Record<string, string | number | boolean>; notes: string[] }
  replayed?: boolean
  error?: { code: string; message: string }
  text: string
  /** 这一次 HTTP 调用期间 handler 是否真的跑过（权威证据之一） */
  handlerRanThisTime: boolean
}

async function postCommand(payload: Record<string, unknown>): Promise<ControlHttpResult> {
  const type = String(payload.type)
  const runsBefore = handlerRuns.length
  const response = await fetch(
    `${server.url}/dev/query/control/commands/${encodeURIComponent(type)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }
  )
  const text = await response.text()
  const parsed = JSON.parse(text) as Record<string, unknown>
  return {
    status: response.status,
    text,
    handlerRanThisTime: handlerRuns.length > runsBefore,
    ...('result' in parsed ? { result: parsed.result as ControlResult } : {}),
    ...('report' in parsed ? { report: parsed.report as ControlHttpResult['report'] } : {}),
    ...('replayed' in parsed ? { replayed: parsed.replayed as boolean } : {}),
    ...('error' in parsed ? { error: parsed.error as ControlHttpResult['error'] } : {}),
  }
}

let commandCounter = 0
function command(type: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  commandCounter += 1
  return {
    schemaVersion: 1,
    commandId: `cmd-${type.toLowerCase()}-${commandCounter}`,
    idempotencyKey: `idem-${commandCounter}`,
    type,
    dryRun: false,
    requestedBy: { kind: 'developer', surface: 'http' },
    createdAt: M4_T0,
    ...extra,
  }
}

// ===========================================================================
report.section('AT3.1 / AT3.5：白名单、禁止清单、未知命令')
// ===========================================================================

report.check(
  '控制面只登记两个命令（AT3.1 的"显式白名单"）',
  CONTROL_COMMAND_TYPES.length === 2 &&
    CONTROL_COMMAND_TYPES.join(',') === 'RUN_DIAGNOSTIC,RUN_AUDIT',
  CONTROL_COMMAND_TYPES.join(' , ')
)
report.check(
  '控制路由只有两条（GET 白名单 + POST 执行）',
  JSON.stringify(developerControlRoutePatterns()) ===
    JSON.stringify(['GET /dev/query/control/commands', 'POST /dev/query/control/commands/:type']),
  developerControlRoutePatterns().join(' , ')
)

const whitelistResponse = await fetch(`${server.url}/dev/query/control/commands`)
const whitelistBody = (await whitelistResponse.json()) as {
  type: string
  mutatesDomain: boolean
  authority: string
}[]
report.check(
  'GET 白名单：两条命令都如实声明 mutatesDomain=false，且都登记了 authority',
  whitelistResponse.status === 200 &&
    whitelistBody.length === 2 &&
    whitelistBody.every((fact) => fact.mutatesDomain === false && fact.authority !== ''),
  whitelistBody.map((fact) => `${fact.type}:${String(fact.mutatesDomain)}`).join(' ')
)

const unknown = await postCommand(command('DROP_TABLE'))
report.check(
  '未知命令 → 400 + outcome=rejected + reasonCode=command_not_allowed',
  unknown.status === 400 &&
    unknown.result?.outcome === 'rejected' &&
    unknown.result?.reasonCode === 'command_not_allowed',
  `status=${unknown.status} outcome=${unknown.result?.outcome} reason=${unknown.result?.reasonCode}`
)
report.check(
  '被拒绝的结果**说出了它试图执行什么**（commandType 保留下来）',
  unknown.result?.commandType === 'DROP_TABLE'
)

let forbiddenRejected = 0
const forbiddenProblems: string[] = []
for (const type of FORBIDDEN_CONTROL_COMMANDS) {
  const attempt = await postCommand(command(type))
  const ok =
    attempt.status === 400 &&
    attempt.result?.outcome === 'rejected' &&
    attempt.result?.reasonCode === 'command_forbidden'
  if (ok) forbiddenRejected += 1
  else {
    forbiddenProblems.push(
      `${type}→${attempt.status}/${attempt.result?.reasonCode ?? attempt.error?.code ?? '?'}`
    )
  }
}
report.check(
  `AT3.5 的 ${FORBIDDEN_CONTROL_COMMANDS.length} 个禁止命令逐个被拒，且理由是 command_forbidden（不是 not_allowed）`,
  forbiddenRejected === FORBIDDEN_CONTROL_COMMANDS.length,
  forbiddenProblems.length === 0 ? `${forbiddenRejected} 个全部拒绝` : forbiddenProblems.join(' , ')
)

const badShape = await postCommand({ type: 'RUN_DIAGNOSTIC' })
report.check(
  '缺 idempotencyKey 的形状非法命令 → 400 + rejected',
  badShape.status === 400 && badShape.result?.outcome === 'rejected',
  `status=${badShape.status} reason=${badShape.result?.reasonCode}`
)

const notJson = await fetch(`${server.url}/dev/query/control/commands/RUN_DIAGNOSTIC`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{not json',
})
report.check(
  '请求体不是 JSON → 400 developer_control_body_not_json',
  notJson.status === 400,
  `status=${notJson.status}`
)

// ===========================================================================
report.section('AT3.6 ①：Accepted but not attempted（dryRun 的真实落点）')
// ===========================================================================

const dryRun = await postCommand(command('RUN_DIAGNOSTIC', { dryRun: true }))
report.check(
  'dryRun → 200 + accepted（而非 executed）',
  dryRun.status === 200 && dryRun.result?.outcome === 'accepted',
  `status=${dryRun.status} outcome=${dryRun.result?.outcome}`
)
report.check(
  'dryRun 的三个布尔是 accepted=true / attempted=false / executed=false',
  dryRun.result?.accepted === true &&
    dryRun.result?.attempted === false &&
    dryRun.result?.executed === false
)
report.check(
  'dryRun **没有**进入执行路径（这一次 HTTP 期间 handler 未被调用）',
  dryRun.handlerRanThisTime === false
)
report.check('dryRun 没有产出报告（没执行就没有产出）', dryRun.report === undefined)

// ===========================================================================
report.section('AT3.6 ②：Verified（真实执行 + 重读权威状态一致）')
// ===========================================================================

const verified = await postCommand(command('RUN_DIAGNOSTIC'))
report.check(
  'verified → 200 + outcome=verified + verification=verified',
  verified.status === 200 &&
    verified.result?.outcome === 'verified' &&
    verified.result?.verification === 'verified',
  `status=${verified.status} ${verified.result ? describeControlResult(verified.result) : '(无结果)'}`
)
report.check(
  'verified 必须带核验证据（不是自报）',
  (verified.result?.verificationEvidence ?? '').includes('重读完整性探针'),
  verified.result?.verificationEvidence
)
report.check('verified 这一次真的调了 handler', verified.handlerRanThisTime === true)
report.check(
  'verified 带着报告（只读命令的产出确实回来了）',
  verified.report !== undefined && Object.keys(verified.report.metrics).length > 0,
  `${Object.keys(verified.report?.metrics ?? {}).length} 项指标`
)

// ===========================================================================
report.section('AT3.6 ③：Attempted but failed（handler 抛错）')
// ===========================================================================

await restartServer(buildControl({ diagnostic: faultyHandler('throw') }))
const attempted = await postCommand(command('RUN_DIAGNOSTIC'))
report.check(
  'handler 抛错 → 200 + outcome=attempted + disposition=failed',
  attempted.status === 200 &&
    attempted.result?.outcome === 'attempted' &&
    attempted.result?.disposition === 'failed',
  `status=${attempted.status} ${attempted.result ? describeControlResult(attempted.result) : '(无结果)'}`
)
report.check(
  'attempted 带受控失败码（复用 M4.5 的失败语义，不另造）',
  attempted.result?.error?.code === 'execution_failed' &&
    attempted.result?.reasonCode === 'diagnostic_failed',
  `error=${attempted.result?.error?.code} reason=${attempted.result?.reasonCode}`
)
report.check(
  'attempted 的 verification 是 not_attempted（没跑完就无从核验）',
  attempted.result?.verification === 'not_attempted'
)
report.check('attempted 的 executed 是 false（handler 没返回）', attempted.result?.executed === false)

// ===========================================================================
report.section('AT3.6 ④：Executed but verification failed')
// ===========================================================================

await restartServer(buildControl({ diagnostic: faultyHandler('verify-fail') }))
const executedNotVerified = await postCommand(command('RUN_DIAGNOSTIC'))
report.check(
  'handler 返回但重读不一致 → 200 + outcome=executed + verification=failed',
  executedNotVerified.status === 200 &&
    executedNotVerified.result?.outcome === 'executed' &&
    executedNotVerified.result?.verification === 'failed',
  `status=${executedNotVerified.status} ${
    executedNotVerified.result ? describeControlResult(executedNotVerified.result) : '(无结果)'
  }`
)
report.check(
  'executed 的三个布尔全 true、终局 succeeded（与"被拒"完全不同）',
  executedNotVerified.result?.accepted === true &&
    executedNotVerified.result?.attempted === true &&
    executedNotVerified.result?.executed === true &&
    executedNotVerified.result?.disposition === 'succeeded'
)
report.check(
  '核验失败时**没有** verificationEvidence（不许给自己发合格证）',
  executedNotVerified.result?.verificationEvidence === undefined
)

// ===========================================================================
report.section('AT3.6 ⑤：五档两两不同，且 HTTP 状态码不能替代阶梯')
// ===========================================================================

await restartServer(buildControl({}))

const rungs = [
  { label: 'rejected', http: unknown },
  { label: 'accepted(dryRun)', http: dryRun },
  { label: 'attempted(failed)', http: attempted },
  { label: 'executed(verification failed)', http: executedNotVerified },
  { label: 'verified', http: verified },
]
const fiveRungs = rungs.map((item) => item.http.result!)
const fingerprints = fiveRungs.map(controlResultFingerprint)

report.check(
  'AT3.6 的五档 fingerprint 两两不同',
  new Set(fingerprints).size === 5,
  fiveRungs.map((result) => `${result.outcome}/${result.disposition}/${result.verification}`).join(' , ')
)
report.check(
  '五档的可读摘要也逐档不同',
  new Set(fiveRungs.map(describeControlResult)).size === 5
)
report.check(
  '**禁止 "HTTP 200 == executed"**：accepted（未执行）与 verified 同为 200',
  dryRun.status === 200 && verified.status === 200 && dryRun.result?.executed === false,
  'accepted=200(executed=false) · verified=200(executed=true)'
)
report.check(
  '反向也成立：400 只对应 rejected，而 attempted(failed) 仍是 200',
  unknown.status === 400 && unknown.result?.outcome === 'rejected' && attempted.status === 200,
  'rejected=400 · attempted(failed)=200'
)

/** 独立写一遍阶梯表（**刻意不复用**实现里的 `controlLadderBooleansOf`：量具与实现不共用代码） */
const LADDER = {
  rejected: [false, false, false],
  accepted: [true, false, false],
  attempted: [true, true, false],
  executed: [true, true, true],
  verified: [true, true, true],
} as const
report.check(
  '阶梯 → 布尔与独立写下的期望表逐档一致',
  fiveRungs.every((result) => {
    const expected = LADDER[result.outcome as keyof typeof LADDER]
    return (
      result.accepted === expected[0] &&
      result.attempted === expected[1] &&
      result.executed === expected[2]
    )
  })
)

// ===========================================================================
report.section('WP3 HARD GATE：执行结果必须与权威状态一致')
// ===========================================================================

/** 领域表：只读命令**不许**碰它们（`mutatesDomain === false` 的可测形式） */
const DOMAIN_TABLES = [
  'conversation_events',
  'character_domain_events',
  'character_projections',
  'character_states',
  'state_events',
  'memory_records',
  'memory_subject_links',
  'memory_evidence_links',
  'memory_events',
]

async function tableDigest(name: string): Promise<string> {
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
  return createHash('sha256').update(serialized.join('\n')).digest('hex')
}

async function domainDigest(): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const name of DOMAIN_TABLES) out[name] = await tableDigest(name)
  return out
}

/**
 * 结果 ↔ 权威状态的一致性检查（**独立实现**，不复用契约层的断言）。
 *
 * 它回答的是"这条结果的每一处主张，都有对应的权威证据吗"：
 *   · 执行主张 ↔ 这次的 handler 是否真的跑过 / 是不是重放
 *   · 核验主张 ↔ 有没有核验证据
 *   · 阶梯自洽 ↔ 与上面那张独立期望表
 *   · 证据非空 ↔ 说不出证据的执行真相不算证据
 */
function inconsistencies(
  result: ControlResult,
  authority: { replayed: boolean; handlerRanThisTime: boolean }
): string[] {
  const problems: string[] = []
  const expected = LADDER[result.outcome as keyof typeof LADDER]
  if (expected === undefined) {
    problems.push(`未登记的 outcome：${String(result.outcome)}`)
  } else if (
    result.accepted !== expected[0] ||
    result.attempted !== expected[1] ||
    result.executed !== expected[2]
  ) {
    problems.push(`${result.outcome} 的阶梯与独立期望表不一致`)
  }

  for (const [field, value] of Object.entries(result.evidenceOf)) {
    if (String(value).trim() === '') problems.push(`evidenceOf.${field} 为空`)
  }

  if (result.executed === true && authority.handlerRanThisTime === false && !authority.replayed) {
    problems.push('声称 executed=true，但这次的权威证据（handler 运行）为否')
  }
  if (authority.replayed && !(result.evidenceOf.executed ?? '').includes('重放')) {
    problems.push('这次是幂等重放，但结果没有标出来（会被读成"又执行了一次"）')
  }
  if (result.verification === 'verified') {
    if (result.outcome !== 'verified') problems.push('verification=verified 但 outcome 不是 verified')
    if ((result.verificationEvidence ?? '').trim() === '') {
      problems.push('verification=verified 却没有核验证据')
    }
    if (result.executed !== true) problems.push('verification=verified 但 executed=false')
  }
  if (result.outcome === 'executed' && result.verification === 'verified') {
    problems.push('outcome=executed 却带着 verification=verified')
  }
  if (result.outcome === 'rejected' && (result.accepted || result.attempted || result.executed)) {
    problems.push('rejected 却带着执行痕迹')
  }
  if (result.outcome === 'accepted' && result.executed !== false) {
    problems.push('accepted 却声称执行过')
  }
  return problems
}

const domainBefore = await domainDigest()

const gateDiagnostic = await postCommand(command('RUN_DIAGNOSTIC'))
const gateAudit = await postCommand(command('RUN_AUDIT'))

const domainAfter = await domainDigest()
const mutatedTables = DOMAIN_TABLES.filter((name) => domainBefore[name] !== domainAfter[name])
report.check(
  '只读命令执行前后，**领域表**逐字段相同（mutatesDomain=false 不是一句话）',
  mutatedTables.length === 0,
  mutatedTables.length === 0
    ? `${DOMAIN_TABLES.length} 张领域表逐字段相同`
    : mutatedTables.join(', ')
)

const authorityChecks: { label: string; problems: string[] }[] = []
for (const execution of [gateDiagnostic, gateAudit]) {
  const result = execution.result!
  authorityChecks.push({
    label: `${result.commandType}·执行主张`,
    problems: inconsistencies(result, {
      replayed: execution.replayed === true,
      handlerRanThisTime: execution.handlerRanThisTime,
    }),
  })
}

// 报告里的数必须在**另一个面**（Query API）上复现得到
const integrityNow = await query.getMemoryIntegrity({ characterId })
authorityChecks.push({
  label: 'RUN_DIAGNOSTIC·integrity_ok',
  problems:
    gateDiagnostic.report?.metrics.integrity_ok === integrityNow.integrityOk
      ? []
      : [
          `报告 integrity_ok=${String(gateDiagnostic.report?.metrics.integrity_ok)} ` +
            `权威=${String(integrityNow.integrityOk)}`,
        ],
})
const statsNow = await query.getMemoryStats({ characterId })
authorityChecks.push({
  label: 'RUN_AUDIT·memory_total',
  problems:
    gateAudit.report?.metrics.memory_total === statsNow.total
      ? []
      : [`报告 memory_total=${String(gateAudit.report?.metrics.memory_total)} 权威=${statsNow.total}`],
})
authorityChecks.push({
  label: 'RUN_AUDIT·memory_active',
  problems:
    gateAudit.report?.metrics.memory_active === statsNow.active
      ? []
      : [
          `报告 memory_active=${String(gateAudit.report?.metrics.memory_active)} 权威=${statsNow.active}`,
        ],
})

const allProblems = authorityChecks.flatMap((item) =>
  item.problems.map((problem) => `${item.label}: ${problem}`)
)
report.check(
  'HARD GATE：执行结果与权威状态一致（逐条交叉核对，无一条不一致）',
  allProblems.length === 0,
  allProblems.length === 0
    ? `${authorityChecks.length} 项交叉核对全部一致`
    : allProblems.join(' | ')
)

/*
 * ⚠️ 量具自检：上面那个一致性检测必须**会响**。
 *    一个永远返回 [] 的检测器会让 HARD GATE 无条件通过。
 *    这里故意伪造一条**丢掉重放标记**的结果：权威证据说"这次是重放"，
 *    而结果却把自己写成一次真实执行 —— 检测器必须报出来。
 */
const tampered: ControlResult = {
  ...fiveRungs[4]!,
  evidenceOf: {
    accepted: 'control_registry + preflight',
    attempted: 'RUN_DIAGNOSTIC handler 已被调用',
    executed: 'RUN_DIAGNOSTIC handler 已返回',
    verification: '重读权威状态一致',
  },
}
const detectorInconsistencies = inconsistencies(tampered, {
  replayed: true,
  handlerRanThisTime: false,
})
report.check(
  '量具必须会响：伪造"重放却声称本次执行过"的结果，检测器必须报出来',
  detectorInconsistencies.length > 0,
  detectorInconsistencies.length === 0
    ? '检测器没响 —— 上面那条 HARD GATE 的绿是假的'
    : detectorInconsistencies[0]
)

// ===========================================================================
report.section('AT3.3：幂等（同一 key 重放不得造成第二次执行）')
// ===========================================================================

const replayKey = 'idem-replay-fixed-1'
const first = await postCommand(command('RUN_DIAGNOSTIC', { idempotencyKey: replayKey }))
const second = await postCommand(command('RUN_DIAGNOSTIC', { idempotencyKey: replayKey }))

report.check('第一次执行真的调了 handler', first.handlerRanThisTime === true)
report.check(
  '重放**没有**再次调用 handler（AT3.3 的核心）',
  second.handlerRanThisTime === false
)
report.check(
  '重放的结论与第一次**逐字相同**（幂等的定义）',
  controlResultFingerprint(second.result!) === controlResultFingerprint(first.result!),
  `${second.result?.outcome}/${second.result?.verification}`
)
report.check(
  '重放被明确标出（evidenceOf 说明"本次没有再次执行"）',
  second.replayed === true && (second.result?.evidenceOf.executed ?? '').includes('重放'),
  `replayed=${String(second.replayed)}`
)
report.check('非重放的那一次没有被标成重放', first.replayed === false)

const dryKey = 'idem-replay-dry-1'
const dryFirst = await postCommand(command('RUN_AUDIT', { dryRun: true, idempotencyKey: dryKey }))
const drySecond = await postCommand(command('RUN_AUDIT', { dryRun: true, idempotencyKey: dryKey }))
report.check(
  'dryRun 的幂等记录同样生效（第二次回放第一次的结论）',
  dryFirst.result?.outcome === 'accepted' &&
    drySecond.result?.outcome === 'accepted' &&
    drySecond.replayed === true
)
report.check(
  '幂等存储真的记下了（条数 > 0）',
  (await control.idempotencySize()) > 0,
  `${await control.idempotencySize()} 条`
)

// ===========================================================================
report.section('AT3.4：今天没有触发（这是一个结论，不是省略）')
// ===========================================================================

report.check(
  '两个白名单命令都是只读的 ⇒ AT3.4（暴露既有 mutation command）今天不适用',
  whitelistBody.every((fact) => fact.mutatesDomain === false),
  '若将来有命令会改变领域状态，它必须经 ActionGateway（STOP 条件 14）'
)

// ===========================================================================
report.section('隐私负控：命令参数取值与记忆正文都不出现在控制响应里')
// ===========================================================================

const leakKey = 'M51-CONTROL-ARG-LEAK-SENTINEL'
const leakProbe = await postCommand(command('RUN_DIAGNOSTIC', { parameters: { note: leakKey } }))
report.check(
  '命令参数取值不出现在控制响应里（回显只有 type / dryRun / surface）',
  !leakProbe.text.includes(leakKey),
  leakProbe.text.includes(leakKey) ? '出现了参数取值' : '无参数取值'
)

const controlTexts = [verified.text, gateDiagnostic.text, gateAudit.text, attempted.text]
report.check(
  '记忆正文不出现在任何控制响应里',
  controlTexts.every((text) => !text.includes(MEMORY_SENTINEL)),
  `${controlTexts.length} 个响应全部干净`
)

// ===========================================================================
// 证据
// ===========================================================================

const storeSize = await control.idempotencySize()
await server.close()

mkdirSync(join(process.cwd(), 'artifacts', 'm5.1'), { recursive: true })
writeFileSync(
  join(process.cwd(), 'artifacts', 'm5.1', 'control-execution-truth.json'),
  `${JSON.stringify(
    {
      testId: 'M5.1 / WP3 developer control api',
      generatedAt: new Date().toISOString(),
      sandbox: sandbox.dir,
      controlRoutes: developerControlRoutePatterns(),
      whitelist: whitelistBody,
      forbiddenCommands: FORBIDDEN_CONTROL_COMMANDS,
      forbiddenRejected,
      fiveRungs: rungs.map((item) => ({
        label: item.label,
        httpStatus: item.http.status,
        outcome: item.http.result?.outcome,
        disposition: item.http.result?.disposition,
        accepted: item.http.result?.accepted,
        attempted: item.http.result?.attempted,
        executed: item.http.result?.executed,
        verification: item.http.result?.verification,
        reasonCode: item.http.result?.reasonCode ?? null,
        errorCode: item.http.result?.error?.code ?? null,
        handlerRanThisTime: item.http.handlerRanThisTime,
        fingerprint: controlResultFingerprint(item.http.result!),
        description: describeControlResult(item.http.result!),
      })),
      hardGate: {
        domainTables: DOMAIN_TABLES,
        domainDigestBefore: domainBefore,
        domainDigestAfter: domainAfter,
        mutatedTables,
        authorityChecks,
        problems: allProblems,
        detectorSelfCheck: {
          tamperedResultProblems: detectorInconsistencies,
          detectorResponded: detectorInconsistencies.length > 0,
        },
      },
      idempotency: {
        firstHandlerRan: first.handlerRanThisTime,
        replayHandlerRan: second.handlerRanThisTime,
        replayFingerprintEqual:
          controlResultFingerprint(second.result!) === controlResultFingerprint(first.result!),
        replayedFlag: second.replayed === true,
        storeSize,
        scope: 'process-only：持久化需要一条新迁移（F-11：M5.1 不做）',
      },
      privacy: {
        commandArgumentLeaked: leakProbe.text.includes(leakKey),
        memoryBodyLeaked: controlTexts.some((text) => text.includes(MEMORY_SENTINEL)),
      },
      hardGateVerdict:
        mutatedTables.length === 0 &&
        allProblems.length === 0 &&
        detectorInconsistencies.length > 0 &&
        second.handlerRanThisTime === false &&
        second.replayed === true &&
        new Set(fingerprints).size === 5 &&
        forbiddenRejected === FORBIDDEN_CONTROL_COMMANDS.length
          ? 'PASS'
          : 'FAIL',
    },
    null,
    2
  )}\n`,
  'utf8'
)
console.log('证据已写入：artifacts/m5.1/control-execution-truth.json')

await h.stop()
cleanupSandbox(sandbox.dir)
report.finish('M5.1 WP3 开发者控制面门')
