/**
 * A1 / **WP2 第四面门**：`goals_commitments` 真端口。
 *
 * ```text
 * 正控：接了 reader ⇒ 四个计数是真数（**0 也是真数**）· 行形状是冻结闭集
 * 负控：没接 reader ⇒ 四个字段全 `null` **且**四个名字都进 `unavailable`（不用 0 冒充）·
 *       reader 抛错 ⇒ 同形（不知道就是不知道）· 计数非法（负数/小数/字符串）⇒ 只把**坏的那些**列进 unavailable
 * 恢复：接上 reader ⇒ 同一字段从 `null` 变成真数、`unavailable` 消失
 * 端到端：真 server ⇒ 200 且 `unavailable` 如实出现
 * ```
 */
import { hashAdminPassword } from '../src/infrastructure/admin/auth.ts'
import { ADMIN_SESSION_COOKIE, createAdminAuthServer } from '../src/infrastructure/admin/server.ts'
import {
  GOALS_COMMITMENTS_FIELDS,
  countProblem,
  createGoalsCommitmentsPort,
  type GoalsCommitmentsReader,
} from '../src/infrastructure/admin-ports/goals-commitments.ts'

const checks: { name: string; pass: boolean; detail: string }[] = []
const check = (name: string, pass: boolean, detail: string): void => {
  checks.push({ name, pass, detail })
}

check('正控 计数合法性：非负整数才算（0 是合法读数）',
  countProblem(0) === undefined && countProblem(7) === undefined, '应合法')
check('负控 计数合法性：负数/小数/字符串/NaN ⇒ invalid',
  countProblem(-1) === 'invalid' && countProblem(1.5) === 'invalid' &&
  countProblem('3') === 'invalid' && countProblem(Number.NaN) === 'invalid', '应 invalid')

const reader: GoalsCommitmentsReader = {
  counts: async () => ({ openGoals: 2, completedGoals: 5, openCommitments: 0, settledCommitments: 3 }),
}
const wired = await createGoalsCommitmentsPort({ reader, now: () => new Date('2026-10-14T00:00:00.000Z') })()
const wiredRow = wired.items[0] as Record<string, unknown>
check('正控 接了 reader ⇒ 四个计数是真数（含 **0**）',
  wiredRow.openGoals === 2 && wiredRow.completedGoals === 5 && wiredRow.openCommitments === 0 && wiredRow.settledCommitments === 3,
  JSON.stringify(wiredRow))
check('正控 行形状是冻结闭集（四个字段，一个不多）',
  Object.keys(wiredRow).sort().join(',') === [...GOALS_COMMITMENTS_FIELDS].sort().join(','), Object.keys(wiredRow).join(','))
check('正控 接了 reader ⇒ 没有 `unavailable`', wired.unavailable === undefined, String(wired.unavailable))

const bare = await createGoalsCommitmentsPort({})()
const bareRow = bare.items[0] as Record<string, unknown>
check('负控 没接 reader ⇒ 四个字段全 `null`（**不用 0 冒充"没有目标/承诺"**）',
  GOALS_COMMITMENTS_FIELDS.every((field) => bareRow[field] === null), JSON.stringify(bareRow))
check('负控 没接 reader ⇒ 四个名字**逐个**进 `unavailable`',
  [...(bare.unavailable ?? [])].sort().join(',') === [...GOALS_COMMITMENTS_FIELDS].sort().join(','), String(bare.unavailable))
check('负控 `null` 与 0 **不同**（这条判据是活的）', bareRow.openCommitments !== 0, String(bareRow.openCommitments))

const broken: GoalsCommitmentsReader = { counts: async () => { throw new Error('projection exploded: internal-xyz') } }
const brokenReading = await createGoalsCommitmentsPort({ reader: broken })()
check('负控 reader 抛错 ⇒ 同形（全 `null` + `unavailable`），且**不带异常细节**',
  GOALS_COMMITMENTS_FIELDS.every((f) => (brokenReading.items[0] as Record<string, unknown>)[f] === null) &&
  !JSON.stringify(brokenReading).includes('internal-xyz'), '应无细节')

const partial: GoalsCommitmentsReader = {
  counts: async () => ({ openGoals: 1, completedGoals: -2, openCommitments: 3, settledCommitments: 4 }),
}
const partialReading = await createGoalsCommitmentsPort({ reader: partial })()
check('负控 部分计数非法 ⇒ **只把坏的那些**列进 `unavailable`（其余照常给）',
  (partialReading.unavailable ?? []).join(',') === 'completedGoals' &&
  (partialReading.items[0] as Record<string, unknown>).completedGoals === null,
  `unavailable=${String(partialReading.unavailable)}`)

const recovered = await createGoalsCommitmentsPort({ reader })()
check('恢复 接上 reader ⇒ 同一字段从 `null` 变真数、`unavailable` 消失',
  (recovered.items[0] as Record<string, unknown>).openGoals === 2 && recovered.unavailable === undefined, '应恢复')

const PASSWORD = 'wp2-goals-port-password'
const empty = (surface: 'cognition' | 'jobs' | 'safety_quota' | 'effective_config') => async () =>
  ({ surface, generatedAt: '', items: [] as Record<string, unknown>[] })
const server = createAdminAuthServer({
  passwordHash: hashAdminPassword(PASSWORD, { salt: Buffer.alloc(16, 19) }),
  host: '127.0.0.1', port: 0,
  ports: {
    cognition: empty('cognition'),
    goalsCommitments: createGoalsCommitmentsPort({ reader }),
    jobs: empty('jobs'),
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
const response = await fetch(`${origin}/api/goals-commitments`, { headers: { cookie: `${ADMIN_SESSION_COOKIE}=${token}` } })
const body = (await response.json()) as { surface?: string; items?: Record<string, unknown>[] }
check('正控 端到端：200 且面 id 正确', response.status === 200 && body.surface === 'goals_commitments', `status=${response.status}`)
check('正控 端到端：四个计数原样出现在响应里',
  body.items?.[0]?.openGoals === 2 && body.items?.[0]?.openCommitments === 0, JSON.stringify(body.items?.[0]))
const unauth = await fetch(`${origin}/api/goals-commitments`)
check('负控 端到端：未登录 ⇒ 401', unauth.status === 401, `status=${unauth.status}`)
await server.stop()

const failed = checks.filter((c) => !c.pass)
for (const item of checks) console.log(`${item.pass ? 'PASS' : 'FAIL'}  ${item.name}${item.pass ? '' : ` — ${item.detail}`}`)
console.log(`\nA1 / WP2 goals_commitments 端口：判据 ${checks.length} · 失败 ${failed.length} · measured_count=${checks.length}`)
console.log('⚠️ reader 是注入桩：生产里的目标/承诺 reader 尚未接线 ⇒ 真服务里该面如实 `unavailable`。')
if (checks.length === 0 || failed.length > 0) process.exit(1)
