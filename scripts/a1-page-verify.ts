/**
 * A1 / **WP2 页面门**：首版管理页（`A1-G4` 的机器可判部分）。
 *
 * ============================================================================
 *  本门证什么、**不**证什么（必须说清）
 * ============================================================================
 * ```text
 * 证：① HTML 可取（200 · text/html · no-store）② **页面不含任何数据/密钥**（把真配置值塞进桩端口，
 *      页面 HTML 里一个都不许出现）③ 脚本只调用**冻结清单里的**路径（不多不少）
 *      ④ 那些路径带会话可取（真 HTTP 复核）⑤ 未登录读数据面仍是 401（页面拿不到数据）
 * 不证：**渲染是否正确**（首版**没有**真浏览器量具）⇒ 这一条要**人**看一眼，如实登记。
 * ```
 */
import { hashAdminPassword } from '../src/infrastructure/admin/auth.ts'
import { ADMIN_SESSION_COOKIE, createAdminAuthServer } from '../src/infrastructure/admin/server.ts'
import { ADMIN_READ_SURFACES } from '../src/infrastructure/admin/query-ports.ts'
import { escapeHtml, renderAdminPage } from '../src/infrastructure/admin/page.ts'

const checks: { name: string; pass: boolean; detail: string }[] = []
const check = (name: string, pass: boolean, detail: string): void => {
  checks.push({ name, pass, detail })
}

// ---------------------------------------------------------------------------
// 1. 纯函数：HTML 里**没有**数据
// ---------------------------------------------------------------------------

const SECRET_VALUE = 'sk-page-should-never-appear'
const html = renderAdminPage()
check('正控 渲染是纯函数：同一输入两次逐字相同', renderAdminPage() === html, '应逐字相同')
check('正控 是完整 HTML 文档', html.startsWith('<!doctype html>') && html.includes('</html>'), html.slice(0, 24))
check('负控 页面**不含**任何配置值/密钥（它只吃冻结清单，不吃读数）',
  !html.includes(SECRET_VALUE) && !/scrypt\$/.test(html) && !/sk-[A-Za-z0-9]{8,}/.test(html), '应无')
check('正控 脚本调用的路径**恰好**是冻结清单那五个',
  ADMIN_READ_SURFACES.every((surface) => html.includes(`"${surface.path}"`)) &&
  (html.match(/\/api\/[a-z-]+/g) ?? []).length >= 5, '五条路径都应在')
check('负控 页面**不**把 `/login` 之外的写接口写进去（首版只读）',
  !/\/api\/[a-z-]+\/[a-z]+/.test(html), '不应有子路径')
check('正控 `unavailable` 渲染成「不可用」而不是 0/空',
  html.includes('不可用') && html.includes('不把它显示成 0'), '应有该分支')
check('负控 HTML 转义判据是活的（`<`/`&`/引号都被转）',
  escapeHtml('<b>&"\'') === '&lt;b&gt;&amp;&quot;&#39;', escapeHtml('<b>&"\''))

// ---------------------------------------------------------------------------
// 2. 真 server：页面可取 + 数据面仍需会话
// ---------------------------------------------------------------------------

const PASSWORD = 'wp2-page-password'
const server = createAdminAuthServer({
  passwordHash: hashAdminPassword(PASSWORD, { salt: Buffer.alloc(16, 23) }),
  host: '127.0.0.1', port: 0,
  ports: {
    cognition: async () => ({ surface: 'cognition', generatedAt: '', items: [] }),
    goalsCommitments: async () => ({ surface: 'goals_commitments', generatedAt: '', items: [] }),
    jobs: async () => ({ surface: 'jobs', generatedAt: '', items: [] }),
    safetyQuota: async () => ({ surface: 'safety_quota', generatedAt: '', items: [] }),
    effectiveConfig: async () => ({
      surface: 'effective_config', generatedAt: '',
      items: [{ flag: 'SECRET_FLAG', value: SECRET_VALUE, source: 'env', masked: false }],
    }),
    /* 第六个面（用户 2026-10-14 裁定）：页面导航要列出它 ⇒ 这里给如实 unavailable 的桩 */
    coreStatus: async () => ({ surface: 'core_status', generatedAt: '', items: [], unavailable: ['presence'] }),
  },
})
await server.start()
const origin = `http://127.0.0.1:${String(server.port)}`

const page = await fetch(`${origin}/`)
const pageText = await page.text()
check('正控 真 server：`GET /` ⇒ 200 且是 HTML', page.status === 200 && /text\/html/.test(String(page.headers.get('content-type'))), `status=${page.status}`)
check('正控 真 server：页面响应 `no-store`', page.headers.get('cache-control') === 'no-store', String(page.headers.get('cache-control')))
check('负控 真 server：**页面本身不需要会话**（空壳；数据在 /api/* 后面）', page.status === 200, `status=${page.status}`)
const index = await fetch(`${origin}/index.html`)
check('正控 真 server：`/index.html` 与 `/` 逐字相同', (await index.text()) === pageText, '应相同')

const unauthApi = await fetch(`${origin}/api/effective-config`)
check('负控 真 server：未登录读数据面 ⇒ 401（页面拿不到数据）', unauthApi.status === 401, `status=${unauthApi.status}`)

const login = await fetch(`${origin}/login`, {
  method: 'POST', headers: { 'content-type': 'application/json', origin, 'sec-fetch-site': 'same-origin' },
  body: JSON.stringify({ password: PASSWORD }),
})
const token = login.headers.getSetCookie().map((raw) => raw.split(';')[0] ?? '').find((p) => p.startsWith(`${ADMIN_SESSION_COOKIE}=`))?.split('=')[1] ?? ''
const authedConfig = await fetch(`${origin}/api/effective-config`, { headers: { cookie: `${ADMIN_SESSION_COOKIE}=${token}` } })
const authedBody = (await authedConfig.json()) as { items?: Record<string, unknown>[] }
check('正控 真 server：带会话读那一面 ⇒ 200', authedConfig.status === 200, `status=${authedConfig.status}`)
/*
 * ⚠️ 第一版这条写成 `… ? true : true`（恒真）—— **空判据**，自己骗自己。
 *    改成真判据：**页面 HTML 里不许出现那一面任何一条读数的值**（"页面不含数据"由此可判）。
 *    ⚠️ 注意桩端口故意返回**未遮蔽**的值：那是**桩**的问题（真端口由 `a1:effective-config:verify` 守遮蔽），
 *       本门只回答"页面上有没有它"。
 */
const apiValues = (authedBody.items ?? []).flatMap((item) => Object.values(item).map((value) => String(value)))
/*
 * ⚠️ 只比**有区分度**的值（长度 ≥ 8）：桩里那个 `source:'env'` 会撞上页面脚本里的 `event`
 *    （子串命中 ≠ 泄露）。这条阈值写在判据里，免得下一个人以为"短词命中"是事故。
 */
const distinctive = apiValues.filter((value) => value.length >= 8)
check('负控 页面 HTML 里**不含**那一面任何一条**有区分度**的读数值（页面 = 空壳）',
  distinctive.length > 0 && distinctive.every((value) => !pageText.includes(value)),
  `对比了 ${distinctive.length}/${apiValues.length} 个值（≥8 字符）`)
await server.stop()

const failed = checks.filter((c) => !c.pass)
for (const item of checks) console.log(`${item.pass ? 'PASS' : 'FAIL'}  ${item.name}${item.pass ? '' : ` — ${item.detail}`}`)
console.log(`\nA1 / WP2 首版页面：判据 ${checks.length} · 失败 ${failed.length} · measured_count=${checks.length}`)
console.log('⚠️ **渲染是否正确本门不证**：首版没有真浏览器量具 ⇒ 需要人看一眼（如实登记，不算作已验收）。')
if (checks.length === 0 || failed.length > 0) process.exit(1)
