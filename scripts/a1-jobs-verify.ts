/**
 * A1 / **WP2 第三面门**：`jobs` 真端口（cursor 分页 · 缺口 `B9`）。
 *
 * ```text
 * 正控：两页能翻（第二页用第一页的 nextCursor）· 页大小缺省 20 · 字段闭集原样 · 没有下一页 ⇒ 无 nextCursor
 * 负控：`limit=99999` ⇒ 夹到 50（拿不到大页）· 坏游标 ⇒ 服务端 **400**（不是 500）·
 *       没接 reader ⇒ 空数组 + `unavailable: ['jobs']`（**不**冒充"没有任务"）· reader 抛错 ⇒ 500
 * 恢复：坏游标之后换合法游标 ⇒ 200
 * ⚠️ reader 是**注入的桩**（零数据库）；不主张持久化 jobId（属 WP4）。
 * ```
 */
import { hashAdminPassword } from '../src/infrastructure/admin/auth.ts'
import { ADMIN_SESSION_COOKIE, createAdminAuthServer } from '../src/infrastructure/admin/server.ts'
import { AdminQueryError, cursorShapeProblem } from '../src/infrastructure/admin/query-ports.ts'
import {
  JOB_STATES,
  JOB_TERMINAL_STATES,
  clampJobPageSize,
  createJobsPort,
  isJobTerminal,
  jobAdmissionDecision,
  jobStateLabel,
  parameterFingerprint,
  recoveredJobState,
  type JobRecord,
  type JobsReader,
} from '../src/infrastructure/admin-ports/jobs.ts'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(import.meta.url), '../..')

const checks: { name: string; pass: boolean; detail: string }[] = []
const check = (name: string, pass: boolean, detail: string): void => {
  checks.push({ name, pass, detail })
}

// ---------------------------------------------------------------------------
// 1. 纯判据：游标形状 + 页大小夹紧
// ---------------------------------------------------------------------------

check('正控 游标形状：不透明串（base64url）合法 / 空串视为没有',
  cursorShapeProblem('abcDEF123_-') === undefined && cursorShapeProblem('') === undefined && cursorShapeProblem(undefined) === undefined,
  '应合法')
check('负控 游标形状：含 `=` / 空格 / 超长 ⇒ bad_cursor',
  cursorShapeProblem('abc=') === 'bad_cursor' && cursorShapeProblem('a b') === 'bad_cursor' &&
  cursorShapeProblem('x'.repeat(121)) === 'bad_cursor', '应 bad_cursor')
check('正控 页大小：缺省 20 · 给了就用 · 上限 50',
  clampJobPageSize(undefined) === 20 && clampJobPageSize(5) === 5 && clampJobPageSize(99999) === 50, '20 / 5 / 50')
check('负控 页大小：0 或负数 ⇒ 回缺省（不返回空页当"没有任务"）',
  clampJobPageSize(0) === 20 && clampJobPageSize(-3) === 20, '应 20')

// ---------------------------------------------------------------------------
// 2. 端口读数：两页 + 字段闭集
// ---------------------------------------------------------------------------

const records: JobRecord[] = Array.from({ length: 25 }, (_, index) => ({
  jobId: `job-${String(index + 1)}`,
  kind: 'reflection',
  state: index % 3 === 0 ? 'failed' : 'succeeded',
  startedAt: '2026-10-14T00:00:00.000Z',
  ...(index % 3 === 0 ? { failureReason: 'model_timeout' } : {}),
}))
const reader: JobsReader = {
  list: async ({ cursor, limit }) => {
    const start = cursor === undefined ? 0 : Number(cursor)
    const page = records.slice(start, start + limit)
    const next = start + limit < records.length ? String(start + limit) : undefined
    return { items: page, ...(next === undefined ? {} : { nextCursor: next }) }
  },
}
const port = createJobsPort({ reader, now: () => new Date('2026-10-14T00:00:00.000Z') })

const page1 = await port({})
check('正控 第一页缺省 20 条且带 nextCursor', page1.items.length === 20 && page1.nextCursor === '20', `items=${page1.items.length} next=${String(page1.nextCursor)}`)
check('正控 行形状是冻结闭集（jobId/kind/state/startedAt[/finishedAt][/failureReason]）',
  (page1.items ?? []).every((item) => 'jobId' in item && 'kind' in item && 'state' in item && 'startedAt' in item) &&
  !('failureReason' in (page1.items[1] as Record<string, unknown>)),
  JSON.stringify(page1.items[0]))
const page2 = await port({ cursor: page1.nextCursor })
check('正控 第二页用第一页的游标能翻（5 条且**没有**下一页）',
  page2.items.length === 5 && page2.nextCursor === undefined, `items=${page2.items.length} next=${String(page2.nextCursor)}`)
check('正控 两页不重叠（第一页最后一条 ≠ 第二页第一条）',
  (page1.items.at(-1) as { jobId?: string })?.jobId !== (page2.items[0] as { jobId?: string })?.jobId,
  `${String((page1.items.at(-1) as { jobId?: string })?.jobId)} vs ${String((page2.items[0] as { jobId?: string })?.jobId)}`)
check('正控 失败任务的 `failureReason` 原样带出（原因码，不是正文）',
  (page1.items[0] as { failureReason?: string })?.failureReason === 'model_timeout',
  JSON.stringify(page1.items[0]))
check('负控 `limit=99999` ⇒ 夹到 50（但池里只有 25 条 ⇒ 返回 25）',
  (await port({ limit: 99999 })).items.length === 25, String((await port({ limit: 99999 })).items.length))

let cursorError: string | undefined
try {
  await port({ cursor: 'not a cursor' })
} catch (error) {
  cursorError = error instanceof AdminQueryError ? error.code : 'other'
}
check('负控 坏游标 ⇒ 端口抛 `AdminQueryError(bad_cursor)`（**不**静默返回空页）', cursorError === 'bad_cursor', String(cursorError))

// ---------------------------------------------------------------------------
// 3. 没接 reader / reader 抛错
// ---------------------------------------------------------------------------

const bare = await createJobsPort({})()
check('负控 没接 reader ⇒ 空数组 **且** `unavailable: [\'jobs\']`（不冒充"没有任务"）',
  bare.items.length === 0 && (bare.unavailable ?? []).join(',') === 'jobs', JSON.stringify(bare))
const brokenReader: JobsReader = { list: async () => { throw new Error('ledger exploded: internal-detail-xyz') } }
let brokenThrew = false
try {
  await createJobsPort({ reader: brokenReader })({})
} catch {
  brokenThrew = true
}
check('负控 reader 抛错 ⇒ 端口向上抛（由服务端映射成 500，不吞成空页）', brokenThrew, '应抛')

// ---------------------------------------------------------------------------
// 4. 端到端：真 server（坏游标 400 / 好游标 200 / 没接面 501）
// ---------------------------------------------------------------------------

const PASSWORD = 'wp2-jobs-port-password'
/* ⚠️ 返回**函数**而不是 Promise：端口方法签名是 `(input?) => Promise<…>`
   （第一版写成 `empty('cognition')` 直接返回 Promise ⇒ tsx 照跑、tsc 判红 —— 又一次同型） */
const empty =
  (surface: 'cognition' | 'goals_commitments' | 'safety_quota' | 'effective_config') =>
    async (): Promise<{ surface: typeof surface; generatedAt: string; items: Record<string, unknown>[] }> =>
      ({ surface, generatedAt: '', items: [] })
const server = createAdminAuthServer({
  passwordHash: hashAdminPassword(PASSWORD, { salt: Buffer.alloc(16, 17) }),
  host: '127.0.0.1', port: 0,
  ports: {
    cognition: empty('cognition'),
    goalsCommitments: empty('goals_commitments'),
    jobs: port,
    safetyQuota: empty('safety_quota'),
    effectiveConfig: empty('effective_config'),
    /* 第六个面（用户 2026-10-14 裁定）：本门不测它 ⇒ 如实 unavailable 的桩 */
    coreStatus: async () => ({ surface: 'core_status', generatedAt: '', items: [], unavailable: ['presence'] }),
  },
})
await server.start()
const origin = `http://127.0.0.1:${String(server.port)}`
const login = await fetch(`${origin}/login`, {
  method: 'POST', headers: { 'content-type': 'application/json', origin, 'sec-fetch-site': 'same-origin' },
  body: JSON.stringify({ password: PASSWORD }),
})
const token = login.headers.getSetCookie().map((raw) => raw.split(';')[0] ?? '').find((p) => p.startsWith(`${ADMIN_SESSION_COOKIE}=`))?.split('=')[1] ?? ''
const authed = { cookie: `${ADMIN_SESSION_COOKIE}=${token}` }

const ok = await fetch(`${origin}/api/jobs?limit=3`, { headers: authed })
const okBody = (await ok.json()) as { items?: unknown[]; nextCursor?: string }
check('正控 端到端：`?limit=3` ⇒ 200 且 3 条 + nextCursor', ok.status === 200 && okBody.items?.length === 3 && okBody.nextCursor === '3', `status=${ok.status} next=${String(okBody.nextCursor)}`)

const bad = await fetch(`${origin}/api/jobs?cursor=${encodeURIComponent('bad cursor')}`, { headers: authed })
const badBody = (await bad.json()) as { error?: string }
check('负控 端到端：坏游标 ⇒ **400**（不是 500）', bad.status === 400 && badBody.error === 'bad_cursor', `status=${bad.status} body=${JSON.stringify(badBody)}`)

const recovered = await fetch(`${origin}/api/jobs?cursor=3&limit=3`, { headers: authed })
check('恢复 端到端：换合法游标 ⇒ 200', recovered.status === 200, `status=${recovered.status}`)
await server.stop()

// ---------------------------------------------------------------------------
// 5. WP4 纯核心：幂等受理 + 状态机（`R-A1-3`）
// ---------------------------------------------------------------------------

check('正控 指纹稳定：同一对象不同**键序** ⇒ 指纹相同（否则会误报冲突）',
  parameterFingerprint({ a: 1, b: 2 }) === parameterFingerprint({ b: 2, a: 1 }), '应相同')
check('正控 指纹可区分：值不同 ⇒ 指纹不同',
  parameterFingerprint({ a: 1 }) !== parameterFingerprint({ a: 2 }), '应不同')
check('正控 指纹是 sha256 十六进制（64 字符）', /^[0-9a-f]{64}$/.test(parameterFingerprint({ a: 1 })), parameterFingerprint({ a: 1 }))

const existingJob = { jobId: 'job-1', idempotencyKey: 'k-1', fingerprint: parameterFingerprint({ x: 1 }) }
check('正控 无既有任务 ⇒ `create`', jobAdmissionDecision({ incoming: { idempotencyKey: 'k-1', fingerprint: 'f' } }).kind === 'create', '应 create')
check('正控 同键同参数 ⇒ `replay` 且**返回原任务**（不产生第二个任务）',
  (() => { const d = jobAdmissionDecision({ existing: existingJob, incoming: { idempotencyKey: 'k-1', fingerprint: existingJob.fingerprint } }); return d.kind === 'replay' && d.existingJobId === 'job-1' })(),
  '应 replay + job-1')
check('负控 **同键不同参数 ⇒ `conflict`**（明确拒绝，不许悄悄当成新任务）',
  (() => { const d = jobAdmissionDecision({ existing: existingJob, incoming: { idempotencyKey: 'k-1', fingerprint: 'other' } }); return d.kind === 'conflict' && d.reason === 'same_key_different_params' })(),
  '应 conflict')
check('负控 键不同 ⇒ 当新任务，但理由具名（不混淆两种情形）',
  jobAdmissionDecision({ existing: existingJob, incoming: { idempotencyKey: 'k-2', fingerprint: 'f' } }).reason === 'different_idempotency_key',
  '应 different_idempotency_key')
check('负控 **重启后 `running` ⇒ `interrupted`（待核验），且**不自动重跑**',
  recoveredJobState('running') === 'interrupted' && isJobTerminal('interrupted'), '应 interrupted 且是终态')
check('正控 其余状态重启后原样（`pending`/`succeeded`/`failed` 不被改写）',
  recoveredJobState('pending') === 'pending' && recoveredJobState('succeeded') === 'succeeded' && recoveredJobState('failed') === 'failed',
  '应原样')
check('正控 终态闭集 = succeeded / failed / interrupted（`pending`/`running` 不是终态）',
  isJobTerminal('succeeded') && isJobTerminal('failed') && isJobTerminal('interrupted') && !isJobTerminal('pending') && !isJobTerminal('running'),
  JOB_TERMINAL_STATES.join(','))

// ---------------------------------------------------------------------------
// 6. 库层与端口层**同一份状态语义**（迁移 `0020` 的 CHECK ↔ `JOB_STATES`）
// ---------------------------------------------------------------------------

/*
 * ⚠️ 这两处一旦分叉，就会出现"端口认为合法、库层拒绝"（或反之）的**静默不一致**。
 *    判据只落在**结构**上：从迁移源码里把 `state in (…)` 的字面量抽出来，与 `JOB_STATES` 逐个比。
 */
const migrationsSource = readFileSync(resolve(ROOT, 'src/infrastructure/persistence/migrations.ts'), 'utf8')
/*
 * ⚠️ **必须收窄到 `admin_jobs` 那个建表块内**：第一版直接在整份 `migrations.ts` 里找第一个
 *    `state in (…)` —— 命中的是**通知实例表**的闭集（pending/evaluating/prepared/…）⇒ 判据判红，
 *    但红的是**判据**，不是代码（同型教训第 N 次）。
 */
const adminJobsBlock = /create table if not exists admin_jobs \(([\s\S]*?)\)`/.exec(migrationsSource)?.[1] ?? ''
const stateCheck = /state in \(([^)]*)\)/.exec(adminJobsBlock)
const migrationStates = (stateCheck?.[1] ?? '')
  .split(',')
  .map((part) => part.trim().replace(/^'|'$/g, ''))
  .filter((part) => part !== '')
check('迁移 `0020` 的 `admin_jobs` 块里有 `state in (…)` 的 CHECK（库层兜一次）',
  adminJobsBlock !== '' && stateCheck !== null, stateCheck?.[0]?.slice(0, 60) ?? '(未见)')
check('⚠️ 库层闭集与 `JOB_STATES` **逐字一致**（顺序无关，集合相等）',
  migrationStates.length > 0 &&
  [...migrationStates].sort().join(',') === [...JOB_STATES].sort().join(','),
  `迁移=${migrationStates.join(',')} · 端口=${JOB_STATES.join(',')}`)
check('迁移里的 `idempotency_key` **唯一索引**在场（幂等的机器保证，不是靠提示词）',
  /create unique index if not exists admin_jobs_idempotency[\s\S]{0,80}idempotency_key/.test(migrationsSource), '应在')

// ---------------------------------------------------------------------------
// 7. WP5 切片：`accepted ≠ 执行成功`（契约 §5 的"真假"一行）
// ---------------------------------------------------------------------------

check('WP5 `pending` ⇒ 「已提交（尚未执行）」—— **不许**说成"完成"',
  jobStateLabel('pending') === '已提交（尚未执行）', jobStateLabel('pending'))
check('WP5 `interrupted` ⇒ 「中断（待核验）」—— 不说"失败"（不知道就是不知道）',
  jobStateLabel('interrupted') === '中断（待核验）', jobStateLabel('interrupted'))
check('WP5 五个状态各有**互不相同**的标签（判据是活的）',
  new Set(JOB_STATES.map((state) => jobStateLabel(state))).size === JOB_STATES.length,
  JOB_STATES.map((state) => jobStateLabel(state)).join(' / '))
check('WP5 未知状态 ⇒ 「未知状态：<原样>」（不猜、不美化）',
  jobStateLabel('weird') === '未知状态：weird', jobStateLabel('weird'))

const failedChecks = checks.filter((c) => !c.pass)
for (const item of checks) console.log(`${item.pass ? 'PASS' : 'FAIL'}  ${item.name}${item.pass ? '' : ` — ${item.detail}`}`)
console.log(`\nA1 / WP2 jobs 端口：判据 ${checks.length} · 失败 ${failedChecks.length} · measured_count=${checks.length}`)
console.log('⚠️ reader 是注入桩：生产里"任务来源"尚未接线（持久化 jobId 属 WP4）⇒ 真服务里该面会如实 `unavailable`。')
if (checks.length === 0 || failedChecks.length > 0) process.exit(1)
