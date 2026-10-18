/**
 * A1 / **WP2 第二面门**：`safety_quota` 真端口。
 *
 * ```text
 * 正控：配置里能读的现在就给出（风险上限 / 窗口 / 上限）· 接了账本 ⇒ 用量与最近拒绝是真数
 * 负控：**没接账本 ⇒ `null` + `unavailable` 具名**（不用 0 冒充"没用过"）·
 *       账本抛错 ⇒ 同样 unavailable（不静默变 0）· 非法配置值 ⇒ 如实标 `invalid`（不猜、不吞）
 * 恢复：接上账本 ⇒ 同一字段从 `null` 变成真数，`unavailable` 清空
 * 端到端：真 server + 该端口 ⇒ 200，且 `unavailable` 如实出现在响应里
 * ⚠️ 不碰数据库（账本 reader 是注入的桩）；不主张页面可用。
 * ```
 */
import { hashAdminPassword } from '../src/infrastructure/admin/auth.ts'
import { ADMIN_SESSION_COOKIE, createAdminAuthServer } from '../src/infrastructure/admin/server.ts'
import {
  createSafetyQuotaPort,
  quotaLimitOf,
  riskCeilingOf,
  type QuotaLedgerReader,
} from '../src/infrastructure/admin-ports/safety-quota.ts'

const checks: { name: string; pass: boolean; detail: string }[] = []
const check = (name: string, pass: boolean, detail: string): void => {
  checks.push({ name, pass, detail })
}

// ---------------------------------------------------------------------------
// 1. 配置侧纯判据
// ---------------------------------------------------------------------------

check('正控 风险上限：给了合法值 ⇒ 原样', riskCeilingOf({ CHARACTER_ACTION_MAX_RISK: 'R2' }) === 'R2', '应 R2')
check('正控 风险上限：没给 ⇒ 明说"代码缺省"（不编造值）',
  riskCeilingOf({}) === 'R1（代码缺省）', riskCeilingOf({}))
check('正控 风险上限：闭集内三档都原样（R1/R2/R3）',
  riskCeilingOf({ CHARACTER_ACTION_MAX_RISK: 'R1' }) === 'R1' &&
  riskCeilingOf({ CHARACTER_ACTION_MAX_RISK: 'R2' }) === 'R2' &&
  riskCeilingOf({ CHARACTER_ACTION_MAX_RISK: 'R3' }) === 'R3', '三档都应原样')
check('负控 风险上限：非法值 ⇒ 如实标 invalid（不猜、不吞）',
  riskCeilingOf({ CHARACTER_ACTION_MAX_RISK: 'R9' }) === 'invalid:R9' &&
  riskCeilingOf({ CHARACTER_ACTION_MAX_RISK: 'high' }) === 'invalid:high', '应 invalid:…')
check('正控 额度上限：数字原样 / 缺省 0',
  quotaLimitOf({ CHARACTER_WEB_SEARCH_QUOTA: '500' }) === 500 && quotaLimitOf({}) === 0, '应 500 / 0')
check('负控 额度上限：非数字 ⇒ 如实标 invalid',
  quotaLimitOf({ CHARACTER_WEB_SEARCH_QUOTA: 'many' }) === 'invalid:many', '应 invalid:many')

// ---------------------------------------------------------------------------
// 2. 没接账本 ⇒ 不许用 0 冒充
// ---------------------------------------------------------------------------

const config = { CHARACTER_ACTION_MAX_RISK: 'R2', CHARACTER_WEB_SEARCH_QUOTA: '500' }
const bare = await createSafetyQuotaPort({ config, now: () => new Date('2026-10-14T00:00:00.000Z') })()
const bareRow = bare.items[0] as Record<string, unknown>
check('正控 配置侧读数是真的（上限 500 / 风险 R2 / 窗口 = **日额度**）',
  bareRow.riskCeiling === 'R2' && bareRow.quotaLimit === 500 && bareRow.quotaWindow === 'daily_policy_tz',
  JSON.stringify(bareRow))
check('负控 窗口**不许**再报那个不存在的 `deployment_total`（2026-10-14 自我更正）',
  bareRow.quotaWindow !== 'deployment_total', String(bareRow.quotaWindow))
check('正控 窗口可由调用方指定（`per_request` 是**另一个**量，不是默认）',
  ((await createSafetyQuotaPort({ config, window: 'per_request' })()).items[0] as Record<string, unknown>).quotaWindow === 'per_request',
  '应 per_request')
check('负控 **没接账本 ⇒ `null` 而不是 0**',
  bareRow.quotaUsed === null && bareRow.recentDenials === null, JSON.stringify(bareRow))
check('负控 拿不到的字段**具名列出** `unavailable`',
  (bare.unavailable ?? []).join(',') === 'quotaUsed,recentDenials', String(bare.unavailable))
check('负控 `null` 与 0 **不同**（这条判据是活的）', bareRow.quotaUsed !== 0, String(bareRow.quotaUsed))

// ---------------------------------------------------------------------------
// 3. 接了账本 ⇒ 真数；账本坏 ⇒ 回到 unavailable（不静默变 0）
// ---------------------------------------------------------------------------

const ledger: QuotaLedgerReader = {
  used: async () => 137,
  recentDenials: async () => [{ reason: 'quota_exhausted', at: '2026-10-14T00:00:00.000Z' }],
}
const wired = await createSafetyQuotaPort({ config, ledger })()
const wiredRow = wired.items[0] as Record<string, unknown>
check('恢复 接上账本 ⇒ 用量是真数（137）', wiredRow.quotaUsed === 137, String(wiredRow.quotaUsed))
check('恢复 接上账本 ⇒ 最近拒绝是真数且只含原因码与时刻',
  Array.isArray(wiredRow.recentDenials) && (wiredRow.recentDenials as { reason?: string }[])[0]?.reason === 'quota_exhausted',
  JSON.stringify(wiredRow.recentDenials))
check('恢复 接上账本 ⇒ `unavailable` 清空', wired.unavailable === undefined, String(wired.unavailable))

const brokenLedger: QuotaLedgerReader = {
  used: async () => { throw new Error('ledger exploded: internal-detail-xyz') },
  recentDenials: async () => [],
}
const broken = await createSafetyQuotaPort({ config, ledger: brokenLedger })()
const brokenRow = broken.items[0] as Record<string, unknown>
check('负控 账本抛错 ⇒ 仍是 `null` + `unavailable`（**不**退化成 0）',
  brokenRow.quotaUsed === null && (broken.unavailable ?? []).includes('quotaUsed'), JSON.stringify(brokenRow))
check('负控 账本抛错不把异常细节带出来',
  !JSON.stringify(broken).includes('internal-detail-xyz'), '应无细节')

check('负控 最近拒绝条数有界（上限 20）',
  (await createSafetyQuotaPort({ config, ledger, denialLimit: 999 })()).items.length === 1, '面只出一行')

// ---------------------------------------------------------------------------
// 4. 端到端：真 server + 该端口（`unavailable` 要如实出现在响应里）
// ---------------------------------------------------------------------------

const PASSWORD = 'wp2-safety-quota-password'
const server = createAdminAuthServer({
  passwordHash: hashAdminPassword(PASSWORD, { salt: Buffer.alloc(16, 13) }),
  host: '127.0.0.1', port: 0,
  ports: {
    cognition: async () => ({ surface: 'cognition', generatedAt: '', items: [] }),
    goalsCommitments: async () => ({ surface: 'goals_commitments', generatedAt: '', items: [] }),
    jobs: async () => ({ surface: 'jobs', generatedAt: '', items: [] }),
    safetyQuota: createSafetyQuotaPort({ config }),
    effectiveConfig: async () => ({ surface: 'effective_config', generatedAt: '', items: [] }),
    /* 第六个面（用户 2026-10-14 裁定）：本门不测它 ⇒ 给一个**如实 unavailable** 的桩 */
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
const response = await fetch(`${origin}/api/safety-quota`, { headers: { cookie: `${ADMIN_SESSION_COOKIE}=${token}` } })
const body = (await response.json()) as { surface?: string; items?: Record<string, unknown>[]; unavailable?: string[] }
check('正控 端到端：200 且面 id 正确', response.status === 200 && body.surface === 'safety_quota', `status=${response.status}`)
check('正控 端到端：行里 `quotaLimit` 是真数、`quotaUsed` 是 `null`',
  body.items?.[0]?.quotaLimit === 500 && body.items?.[0]?.quotaUsed === null, JSON.stringify(body.items?.[0]))
check('负控 端到端：`unavailable` **如实**出现在响应里（页面据此显示"不可用"）',
  (body.unavailable ?? []).join(',') === 'quotaUsed,recentDenials', String(body.unavailable))
await server.stop()

const failed = checks.filter((c) => !c.pass)
for (const item of checks) console.log(`${item.pass ? 'PASS' : 'FAIL'}  ${item.name}${item.pass ? '' : ` — ${item.detail}`}`)
console.log(`\nA1 / WP2 safety_quota 端口：判据 ${checks.length} · 失败 ${failed.length} · measured_count=${checks.length}`)
console.log('⚠️ 账本侧读数（用量/最近拒绝）在生产里**尚未接线** ⇒ 真服务里那两个字段会如实进 `unavailable`。')
if (checks.length === 0 || failed.length > 0) process.exit(1)
