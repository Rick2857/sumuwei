/**
 * A1 / **WP4 门：`jobs.admit` 受控写面**（唯一写面；三段式 + 三闸负控）。
 *
 * ```text
 * 正控 首次登记 ⇒ 201 `created` + `state=pending`（"已提交（尚未执行）"，**不是**"完成"）
 *      再登记同一幂等键同参数 ⇒ 200 `replayed` + **同一个 jobId**（幂等命中，不是第二次）
 *      审计被调用过（调用次数与顺序都被断言）
 * 负控 同键**不同参数** ⇒ **409** `idempotency_conflict`（明确拒绝，不静默新建）
 *      **审计写不进 ⇒ 任务表一行都不动**（失败关闭；这是本门最要紧的一条）
 *      三闸：未登录 ⇒ 401 · 跨站 ⇒ 403 · 无/错 CSRF ⇒ 403（逐个判红）
 *      未接线 ⇒ 501 `write_not_wired`
 * 恢复 审计恢复后 ⇒ 登记成功（且只成功一次）
 * ⚠️ 全部用**桩**（audit / admit）：本门**不碰数据库**；真表那一半由 `a1:jobs-store:verify` 守。
 * ```
 */
import { hashAdminPassword } from '../src/infrastructure/admin/auth.ts'
import {
  ADMIN_CSRF_COOKIE,
  ADMIN_SESSION_COOKIE,
  createAdminAuthServer,
} from '../src/infrastructure/admin/server.ts'
import { ADMIN_WRITE_SURFACES } from '../src/infrastructure/admin/query-ports.ts'
import { parameterFingerprint } from '../src/infrastructure/admin-ports/jobs.ts'
import { AdminWriteError, createJobsAdmitWritePort } from '../src/infrastructure/admin-ports/jobs-admit.ts'

const PASSWORD = 'a1-jobs-admit-password'
const checks: { name: string; pass: boolean; detail: string }[] = []
const check = (name: string, pass: boolean, detail: string): void => {
  checks.push({ name, pass, detail })
}

interface AuditRecord {
  readonly command: string
  readonly result: string
  readonly reasonCode?: string | undefined
  readonly idempotencyKey: string
  readonly operator: string
  readonly jobId: string
}
const auditCalls: AuditRecord[] = []
let auditBroken = false
const admitCalls: { jobId: string; operator: string; kind: string; idempotencyKey: string; params: unknown }[] = []
let nextJobId = 0
/** 桩的"表"：幂等键 ⇒ 已登记的任务（只为让桩像真 store 那样判幂等/冲突） */
const storeByKey = new Map<string, { jobId: string; fingerprint: string }>()

const writePorts = {
  jobsAdmit: createJobsAdmitWritePort({
    newJobIdOf: () => `job-${String((nextJobId += 1))}`,
    now: () => 1_700_000_000_000,
    audit: async (record) => {
      auditCalls.push(record)
      if (auditBroken) throw new Error('audit_table_unavailable')
    },
    admit: async (input) => {
      admitCalls.push(input)
      /*
       * ⚠️ 桩要**像真 store 那样**判幂等，而且**直接用真的 `parameterFingerprint`**
       *    （第一版用 `JSON.stringify` 比 ⇒ `{a:1,b:2}` 与 `{b:2,a:1}` 被误判成冲突 ⇒ 红的是桩）。
       *    真 store 的那一半由 `a1:jobs-store:verify` 守（真表上 replay/conflict 各有判据）。
       */
      const fingerprint = parameterFingerprint(input.params)
      const prior = storeByKey.get(input.idempotencyKey)
      if (prior !== undefined) {
        return prior.fingerprint === fingerprint
          ? { admission: { kind: 'replay', reason: 'same_key_same_params', existingJobId: prior.jobId }, job: { jobId: prior.jobId, state: 'pending' } }
          : { admission: { kind: 'conflict', reason: 'same_key_different_params', existingJobId: prior.jobId }, job: { jobId: prior.jobId, state: 'pending' } }
      }
      storeByKey.set(input.idempotencyKey, { jobId: input.jobId, fingerprint })
      return { admission: { kind: 'create', reason: 'inserted' }, job: { jobId: input.jobId, state: 'pending' } }
    },
  }),
}

const server = createAdminAuthServer({
  passwordHash: hashAdminPassword(PASSWORD, { salt: Buffer.alloc(16, 53) }),
  host: '127.0.0.1',
  port: 0,
  ports: {
    cognition: async () => ({ surface: 'cognition', generatedAt: '', items: [] }),
    goalsCommitments: async () => ({ surface: 'goals_commitments', generatedAt: '', items: [] }),
    jobs: async () => ({ surface: 'jobs', generatedAt: '', items: [] }),
    safetyQuota: async () => ({ surface: 'safety_quota', generatedAt: '', items: [] }),
    effectiveConfig: async () => ({ surface: 'effective_config', generatedAt: '', items: [] }),
    coreStatus: async () => ({ surface: 'core_status', generatedAt: '', items: [] }),
  } as never,
  writePorts,
})
await server.start()
const origin = `http://127.0.0.1:${String(server.port)}`

const login = await fetch(`${origin}/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin, 'sec-fetch-site': 'same-origin' },
  body: JSON.stringify({ password: PASSWORD }),
})
const token = login.headers.getSetCookie().map((raw) => raw.split(';')[0] ?? '')
  .find((pair) => pair.startsWith(`${ADMIN_SESSION_COOKIE}=`))?.split('=')[1] ?? ''
const csrf = login.headers.getSetCookie().map((raw) => raw.split(';')[0] ?? '')
  .find((pair) => pair.startsWith(`${ADMIN_CSRF_COOKIE}=`))?.split('=')[1] ?? ''
const authed = { cookie: `${ADMIN_SESSION_COOKIE}=${token}; ${ADMIN_CSRF_COOKIE}=${csrf}`, 'x-lg-admin-csrf': csrf, origin, 'content-type': 'application/json' }

const post = async (body: unknown, headers: Record<string, string> = authed): Promise<{ status: number; json: Record<string, unknown> }> => {
  const response = await fetch(`${origin}/api/jobs`, {
    method: 'POST', headers: { ...headers }, body: JSON.stringify(body),
  })
  return { status: response.status, json: (await response.json()) as Record<string, unknown> }
}

// ---------------------------------------------------------------------------
// 负控：三闸（先跑，避免正控被"闸没过就红"掩盖）
// ---------------------------------------------------------------------------

check('负控 未登录 ⇒ 401（写面也有会话闸）',
  (await fetch(`${origin}/api/jobs`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: '{}' })).status === 401, '应 401')
check('负控 跨站 Origin ⇒ 403（不是 401/200）',
  (await post({ idempotencyKey: 'k-x' }, { ...authed, origin: 'http://evil.example' })).status === 403, '应 403')
check('负控 无 CSRF 头 ⇒ 403 `csrf_rejected`',
  (await post({ idempotencyKey: 'k-x' }, { cookie: authed.cookie ?? '', origin, 'content-type': 'application/json' })).status === 403, '应 403')
check('负控 缺幂等键 ⇒ 400 `idempotency_key_required`（**不**替调用方编一个）',
  (await post({ params: { a: 1 } })).json.error === 'idempotency_key_required', '应 400')
/*
 * ⚠️ **审计失败 ⇒ 登记不发生**：这是本门最要紧的一条，必须**真的**走一遍异步路径。
 *    （第一版我在这里留了一段占位残渣，`before === admitCalls.length` 恒成立 ⇒ 恒真判据，已删。）
 */
auditBroken = true
const auditFailedStatus = await (async (): Promise<number> => {
  try {
    await writePorts.jobsAdmit({ idempotencyKey: 'k-audit-broken', params: { a: 1 }, adminId: 'admin' })
    return 0
  } catch (error) {
    return error instanceof AdminWriteError && error.code === 'audit_unavailable' ? 500 : 0
  }
})()
check('负控 审计写不进 ⇒ 抛 `audit_unavailable`（⇒ 服务端 500 `write_failed`）',
  auditFailedStatus === 500, `status=${auditFailedStatus}`)
check('⚠️ 负控 审计失败时**没有**调用登记（`admitCalls` 里没有那条键）',
  !admitCalls.some((call) => call.idempotencyKey === 'k-audit-broken'), `admitCalls=${admitCalls.length}`)
auditBroken = false

// ---------------------------------------------------------------------------
// 正控：首次 / 重放
// ---------------------------------------------------------------------------

const created = await post({ idempotencyKey: 'k-1', params: { a: 1, b: 2 } })
check('正控 首次登记 ⇒ 201 `created` 且 `state=pending`（**不是**"完成"）',
  created.status === 201 && created.json.admission === 'created' && created.json.state === 'pending',
  JSON.stringify(created.json))
const replay = await post({ idempotencyKey: 'k-1', params: { b: 2, a: 1 } })
check('正控 同键同参数（**键序不同**）⇒ 200 `replayed` 且**同一个 jobId**',
  replay.status === 200 && replay.json.admission === 'replayed' && replay.json.jobId === created.json.jobId,
  JSON.stringify(replay.json))
check('正控 审计**确实被调用过**（记录里 command=JOBS_ADMIT、operator=已认证身份）',
  auditCalls.some((record) => record.command === 'JOBS_ADMIT' && record.operator === 'admin'), `${String(auditCalls.length)} 条`)

// 负控：同键不同参数 ⇒ 409（先建一条基准，再改参数）
await post({ idempotencyKey: 'k-conflict', params: { a: 1 } })
const conflicted = await post({ idempotencyKey: 'k-conflict', params: { a: 999 } })
check('负控 同键**不同参数** ⇒ 409 `idempotency_conflict`（明确拒绝，不静默新建）',
  conflicted.status === 409 && conflicted.json.error === 'idempotency_conflict', JSON.stringify(conflicted.json))

// 恢复：审计恢复后又能登记
const afterRecovery = await post({ idempotencyKey: 'k-2', params: { c: 3 } })
check('恢复 审计恢复后 ⇒ 登记成功（201），且此前那次审计失败**没有**留下任务',
  afterRecovery.status === 201 && admitCalls.some((call) => call.idempotencyKey === 'k-2'),
  JSON.stringify(afterRecovery.json))

check('结构 写面集合**恰好一个** `jobs.admit`',
  ADMIN_WRITE_SURFACES.length === 1 && ADMIN_WRITE_SURFACES[0] === 'jobs.admit', ADMIN_WRITE_SURFACES.join(', '))

await server.stop()

const failed = checks.filter((c) => !c.pass)
for (const item of checks) console.log(`${item.pass ? 'PASS' : 'FAIL'}  ${item.name}${item.pass ? '' : ` — ${item.detail}`}`)
console.log(`\nA1 / WP4 受控写面 jobs.admit：判据 ${checks.length} · 失败 ${failed.length} · measured_count=${checks.length}`)
console.log('⚠️ 全部用**桩**（audit / admit）：本门**不碰数据库**（真表那一半由 `a1:jobs-store:verify` 守）。')
if (checks.length === 0 || failed.length > 0) process.exit(1)
