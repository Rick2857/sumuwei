/**
 * A1 / **WP2 装配根门**：**真命令** `a1:admin:serve` 端到端（起真服务 ⇒ 登录 ⇒ 真读数 ⇒ 停机）。
 *
 * ============================================================================
 *  为什么要有这一道（与 `a1:effective-config:verify` 的分工）
 * ============================================================================
 * ```text
 * `a1:effective-config:verify`  测**端口本身**（纯函数 + 桩装配）
 * 本门                         测**装配根**：`scripts/a1-admin.ts serve` 这条**真命令**里
 *                               端口到底有没有被注入 —— 否则"端口存在"与"服务里能读到"
 *                               是两件事，而上一轮正是**装配根没接**（真服务里仍是 501）。
 * ```
 * 读数：真子进程 · 真 HTTP · 只 loopback · 临时凭证目录 · 零数据库 / 零核心依赖。
 * ⚠️ 本门**不**打印任何配置值；只断言"形状对、密钥被遮、未接面如实 501"。
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ADMIN_SESSION_COOKIE } from '../src/infrastructure/admin/server.ts'

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..')
const TSX = resolve(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs')
const CLI = resolve(REPO_ROOT, 'scripts/a1-admin.ts')

const checks: { name: string; pass: boolean; detail: string }[] = []
const check = (name: string, pass: boolean, detail: string): void => {
  checks.push({ name, pass, detail })
}

const work = mkdtempSync(join(tmpdir(), 'a1-serve-'))
const dir = join(work, 'creds')
const PASSWORD = 'a1-serve-end-to-end-password'
const passwordFile = join(work, 'pw.txt')
writeFileSync(passwordFile, `${PASSWORD}\n`, 'utf8')
const init = spawnSync(process.execPath, [TSX, CLI, 'init', '--dir', dir, '--password-file', passwordFile], {
  encoding: 'utf8', cwd: REPO_ROOT, timeout: 120_000,
})
check('前置 真命令 `init` 退出码 0', init.status === 0, `status=${String(init.status)} ${init.stderr.slice(0, 120)}`)

const child = spawn(process.execPath, [TSX, CLI, 'serve', '--dir', dir, '--port', '0'], {
  cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
})
let stdout = ''
let stderr = ''
child.stdout.setEncoding('utf8')
child.stderr.setEncoding('utf8')
child.stdout.on('data', (chunk: string) => { stdout += chunk })
child.stderr.on('data', (chunk: string) => { stderr += chunk })

const waitFor = async (test: () => boolean, label: string, attempts = 240): Promise<void> => {
  for (let i = 0; i < attempts; i++) {
    if (test()) return
    await new Promise((done) => setTimeout(done, 250))
  }
  throw new Error(`超时：${label}`)
}

let url = ''
let loginStatus = 0
let configStatus = 0
let configBody: { surface?: string; items?: Record<string, unknown>[]; droppedFields?: number } = {}
let cognitionStatus = 0
let rawResponse = ''
let authedResponseNoSecret = false
try {
  await waitFor(() => /https?:\/\/127\.0\.0\.1:\d+/.test(stdout), '服务打印 URL')
  url = /https?:\/\/127\.0\.0\.1:\d+/.exec(stdout)![0]
  check('正控 真命令起服务并打印 loopback URL', url.startsWith('http://127.0.0.1:'), url)
  check('正控 启动横幅如实分列"已接面/未接面"（五个面都已在端口层接线 ⇒ 无 501 面）',
    stdout.includes('已接面（五个）：effective_config') && stdout.includes('未接面（501）：无'),
    stdout.split('\n').filter((l) => l.includes('已接面') || l.includes('未接面')).join(' ').slice(0, 180))

  const login = await fetch(`${url}/login`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: url, 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ password: PASSWORD }),
  })
  loginStatus = login.status
  const token = login.headers.getSetCookie().map((raw) => raw.split(';')[0] ?? '')
    .find((pair) => pair.startsWith(`${ADMIN_SESSION_COOKIE}=`))?.split('=')[1] ?? ''
  check('正控 真命令服务可登录（200 + 会话 cookie）', login.status === 200 && token !== '', `status=${login.status}`)

  const config = await fetch(`${url}/api/effective-config`, { headers: { cookie: `${ADMIN_SESSION_COOKIE}=${token}` } })
  configStatus = config.status
  rawResponse = await config.text()
  configBody = JSON.parse(rawResponse) as typeof configBody
  check('正控 **装配根真的注入了端口**：`/api/effective-config` = 200（不再是 501）', config.status === 200, `status=${config.status}`)
  check('正控 读到的是**真配置行**（不是空数组）', (configBody.items?.length ?? 0) > 0, `rows=${String(configBody.items?.length)}`)
  check('正控 面 id 正确', configBody.surface === 'effective_config', String(configBody.surface))
  check('正控 行形状是冻结闭集（flag/value/source/masked）',
    (configBody.items ?? []).every((item) => 'flag' in item && 'value' in item && 'source' in item && 'masked' in item),
    JSON.stringify(configBody.items?.[0] ?? {}))
  check('正控 至少有一行 `source=env`（进程环境是有效来源）',
    (configBody.items ?? []).some((item) => item.source === 'env'), '应至少一行')
  const maskedRows = (configBody.items ?? []).filter((item) => item.masked === true)
  check('负控 被遮的行值**恒为固定形状**（不泄露长度/前缀）',
    maskedRows.length > 0 && maskedRows.every((item) => item.value === '******'), `masked 行数=${maskedRows.length}`)
  authedResponseNoSecret = !/sk-[A-Za-z0-9]{8,}/.test(rawResponse) && !/tvly-[A-Za-z0-9]{8,}/.test(rawResponse)
  check('负控 真响应里**没有**密钥形状的明文', authedResponseNoSecret, '应无')

  /*
   * ⚠️ 逐个面查（不只查一个）：真命令起来之后，**五个面各自的诚实形状**都要成立 ——
   *    "1 个真读数 + 4 个如实 `unavailable`" 这个状态本身是判据，
   *    否则将来某个面悄悄退化成"空数组/0"不会被发现。
   */
  const unwired: { path: string; field: string }[] = [
    { path: '/api/safety-quota', field: 'quotaUsed' },
    { path: '/api/jobs', field: 'jobId' },
    { path: '/api/goals-commitments', field: 'openGoals' },
    { path: '/api/cognition', field: 'characterId' },
  ]
  for (const face of unwired) {
    const response = await fetch(`${url}${face.path}`, { headers: { cookie: `${ADMIN_SESSION_COOKIE}=${token}` } })
    const body = (await response.json()) as { items?: Record<string, unknown>[]; unavailable?: string[] }
    if (face.path === '/api/cognition') cognitionStatus = response.status
    const row = body.items?.[0]
    /*
     * ⚠️ **两种诚实形状都合法**（实测出来的不一致，已如实登记）：
     *    · 单行面（cognition / goals_commitments / safety_quota）：一行、字段是 `null` + `unavailable` 具名
     *    · **列表面**（jobs）：**空列表** + `unavailable` 具名 —— 空列表在这里不算"冒充"，
     *      因为 `unavailable` 已经说明"这一面没接线"；关键是**不许有编造的行**（`items.length === 0`）
     *    ⇒ 共同的硬判据只有一条：**`unavailable` 必须具名**（"不知道"必须说出来）
     */
    const namedUnavailable = (body.unavailable ?? []).some((name) => name === face.field || name === 'jobs')
    const shapeOk = row === undefined
      ? (body.items?.length ?? 0) === 0
      : row[face.field] === null
    check(`负控 ${face.path} ⇒ **200 + 如实 \`unavailable\`**（不是 501、也不是空数组/0 冒充"没有数据"）`,
      response.status === 200 && namedUnavailable && shapeOk,
      `status=${response.status} unavailable=${String(body.unavailable)} items=${String(body.items?.length)} ${face.field}=${String(row?.[face.field])}`)
  }
  const unauth = await fetch(`${url}/api/effective-config`)
  check('负控 未登录读真读数 ⇒ 401', unauth.status === 401, `status=${unauth.status}`)
} catch (error) {
  check('端到端 未抛错地跑完', false, error instanceof Error ? error.message : String(error))
} finally {
  child.kill()
  await new Promise((done) => setTimeout(done, 500))
}

check('正控 停机后子进程已退出', child.killed === true || child.exitCode !== null, `killed=${String(child.killed)} exit=${String(child.exitCode)}`)
check('本门不碰数据库（只连 loopback；stderr 里无库相关拒绝）',
  !/postgres|pglite|数据库/.test(stderr), stderr.slice(0, 160) || '(stderr 空)')

const failed = checks.filter((c) => !c.pass)
for (const item of checks) console.log(`${item.pass ? 'PASS' : 'FAIL'}  ${item.name}${item.pass ? '' : ` — ${item.detail}`}`)
console.log(`\nA1 / WP2 装配根（真命令端到端）：判据 ${checks.length} · 失败 ${failed.length} · measured_count=${checks.length}`)
console.log(`  读数：login=${loginStatus} · effective-config=${configStatus} · cognition(数据源未接)=${cognitionStatus} · 行数=${String(configBody.items?.length ?? 0)}`)
console.log('⚠️ 只覆盖"装配根接上五个面 + 配置面有真读数"；其余四个面的**数据源**未接线，页面人审未做，生产激活需独立授权。')
if (checks.length === 0 || failed.length > 0) process.exit(1)
