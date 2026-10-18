/**
 * A1 / **WP2 第二切片门**：`effective_config` 真端口（缺口 `B8`）。
 *
 * ============================================================================
 *  它守什么
 * ============================================================================
 * ```text
 * 正控：`.env` 里的键 ⇒ 有行 · 进程环境有值 ⇒ source='env'（**有效**来源优先）· 普通值不遮
 * 负控：密钥键（`*_API_KEY` / `*_TOKEN` / `*SECRET*`）⇒ 遮成固定形状且**原文不出现** ·
 *       无辜键名 + 密钥形状的值 ⇒ **也遮**（按值判）· 空值不产生行 · 注释/坏行被忽略
 * 恢复：把密钥从输入里去掉 ⇒ 同一键不再被遮（判据是活的，不是恒遮）
 * 边界：端口**纯读**（不改 env、不写文件）· 端到端：真 server + 该端口 ⇒ 501 变 200 且响应里无明文密钥
 * ⚠️ 本门不碰真实 `.env`（全部注入）；也不主张"页面可用"（页面是后续切片）。
 * ```
 */
import { hashAdminPassword } from '../src/infrastructure/admin/auth.ts'
import { ADMIN_SESSION_COOKIE, createAdminAuthServer } from '../src/infrastructure/admin/server.ts'
import {
  MASKED_VALUE,
  createEffectiveConfigPort,
  looksSecretKey,
  looksSecretValue,
  maskConfigValue,
  parseEnvText,
} from '../src/infrastructure/admin-ports/effective-config.ts'

const checks: { name: string; pass: boolean; detail: string }[] = []
const check = (name: string, pass: boolean, detail: string): void => {
  checks.push({ name, pass, detail })
}

// ---------------------------------------------------------------------------
// 1. `.env` 解析（纯函数）
// ---------------------------------------------------------------------------

const parsed = parseEnvText(
  [
    '# 注释行',
    'CHARACTER_ROLLUP_TOKENS=400',
    'M55_TAVILY_SEARCH_API_KEY="tvly-secret-value-should-never-appear"',
    'QUOTED=\'single-quoted\'',
    'BAD LINE WITHOUT EQUALS',
    '=novalue',
    'LG_PG_MIGRATE_PASSWORD=abcdefghijklmnop',
    '',
  ].join('\n')
)
check('正控 解析出 4 个合法键', parsed.size === 4, [...parsed.keys()].join(','))
check('负控 注释行 / 无等号行 / 空键行都被忽略', !parsed.has('BAD LINE WITHOUT EQUALS') && parsed.size === 4, [...parsed.keys()].join(','))
check('正控 引号被剥掉', parsed.get('QUOTED') === 'single-quoted', String(parsed.get('QUOTED')))

// ---------------------------------------------------------------------------
// 2. 遮蔽判据（纯函数：正控 / 负控 / 恢复）
// ---------------------------------------------------------------------------

check('负控 键名像密钥：`*_API_KEY` / `*_TOKEN` / `*SECRET*` / `*PASSWORD*`',
  looksSecretKey('M55_TAVILY_SEARCH_API_KEY') && looksSecretKey('QQ_ONEBOT_ACCESS_TOKEN') &&
  looksSecretKey('MY_SECRET') && looksSecretKey('LG_PG_MIGRATE_PASSWORD'),
  '都应 true')
check('正控 键名不像密钥：额度/开关/端口类**不**误判',
  !looksSecretKey('CHARACTER_ROLLUP_TOKENS') && !looksSecretKey('CHARACTER_DB_BACKEND') &&
  !looksSecretKey('LG_PG_EXPECT_DATABASE') && !looksSecretKey('PORT'),
  '都应 false')
check('负控 值像密钥（键名无辜也遮）：sk- / ghp_ / Bearer / 长十六进制 / 长 base64url',
  looksSecretValue('sk-live-abcdefghijklmnop') && looksSecretValue('ghp_0123456789abcdef') &&
  looksSecretValue('Bearer abc.def.ghi') && looksSecretValue('a'.repeat(40)) && looksSecretValue('A'.repeat(50)),
  '都应 true')
check('正控 正常值不被误判为密钥', !looksSecretValue('400') && !looksSecretValue('postgres') && !looksSecretValue('127.0.0.1:55432'), '都应 false')
check('负控 遮蔽结果是**固定形状**（不泄露长度/前缀）',
  maskConfigValue('X_API_KEY', 'tvly-abcdef').value === MASKED_VALUE && maskConfigValue('X_API_KEY', 'tvly-abcdef').masked === true,
  MASKED_VALUE)
check('恢复 无辜键 + 普通值 ⇒ 不遮（判据是活的，不是恒遮）',
  maskConfigValue('INNOCENT_LOOKING', '400').masked === false &&
  maskConfigValue('CHARACTER_ROLLUP_TOKENS', '400').masked === false,
  '应 false')

// ---------------------------------------------------------------------------
// 3. 端口读数（注入 env / .env 文本 / 缺省键）
// ---------------------------------------------------------------------------

const SECRET = 'tvly-secret-value-should-never-appear'
const port = createEffectiveConfigPort({
  env: { CHARACTER_ROLLUP_TOKENS: '400', M55_TAVILY_SEARCH_API_KEY: SECRET, INNOCENT_LOOKING: 'sk-live-abcdefghijklmnop' },
  envText: [
    'CHARACTER_ROLLUP_TOKENS=999',
    'ONLY_IN_FILE=file-only-value',
    'LG_PG_MIGRATE_PASSWORD=should-be-masked',
  ].join('\n'),
  defaultKeys: ['CHARACTER_AGREEMENT_ENABLED'],
  now: () => new Date('2026-10-14T00:00:00.000Z'),
})
const payload = await port()
const rowOf = (flag: string): Record<string, unknown> | undefined => payload.items.find((item) => item.flag === flag)

check('正控 面 id 与生成时刻来自注入（程序事实）',
  payload.surface === 'effective_config' && payload.generatedAt === '2026-10-14T00:00:00.000Z',
  `${payload.surface} @ ${payload.generatedAt}`)
check('正控 进程环境有值 ⇒ source=env（**有效**来源优先于 .env 文本）',
  rowOf('CHARACTER_ROLLUP_TOKENS')?.value === '400' && rowOf('CHARACTER_ROLLUP_TOKENS')?.source === 'env',
  JSON.stringify(rowOf('CHARACTER_ROLLUP_TOKENS')))
check('正控 只在 `.env` 里有 ⇒ source=file',
  rowOf('ONLY_IN_FILE')?.source === 'file' && rowOf('ONLY_IN_FILE')?.value === 'file-only-value',
  JSON.stringify(rowOf('ONLY_IN_FILE')))
check('正控 代码缺省的键 ⇒ source=default 且值说明"未设置"',
  rowOf('CHARACTER_AGREEMENT_ENABLED')?.source === 'default', JSON.stringify(rowOf('CHARACTER_AGREEMENT_ENABLED')))
check('正控 普通值不遮（`masked:false`）',
  rowOf('CHARACTER_ROLLUP_TOKENS')?.masked === false, JSON.stringify(rowOf('CHARACTER_ROLLUP_TOKENS')))
check('负控 密钥键 ⇒ 遮（`masked:true` 且值是固定形状）',
  rowOf('M55_TAVILY_SEARCH_API_KEY')?.masked === true && rowOf('M55_TAVILY_SEARCH_API_KEY')?.value === MASKED_VALUE,
  JSON.stringify(rowOf('M55_TAVILY_SEARCH_API_KEY')))
check('负控 无辜键名 + 密钥形状的值 ⇒ **也遮**',
  rowOf('INNOCENT_LOOKING')?.masked === true, JSON.stringify(rowOf('INNOCENT_LOOKING')))
check('负控 `.env` 里的口令键也被遮',
  rowOf('LG_PG_MIGRATE_PASSWORD')?.masked === true, JSON.stringify(rowOf('LG_PG_MIGRATE_PASSWORD')))
const serialized = JSON.stringify(payload)
check('负控 **整份读数里没有明文密钥**',
  !serialized.includes(SECRET) && !serialized.includes('should-be-masked') && !serialized.includes('sk-live-abcdefghijklmnop'),
  '应无明文')
check('负控 空值不产生行（不把 `KEY=` 当成"已设置"）',
  createEffectiveConfigPort({ env: { EMPTY_ONE: '' }, envText: '' }) !== undefined &&
  (await createEffectiveConfigPort({ env: { EMPTY_ONE: '' } })()).items.length === 0,
  '应 0 行')
check('正控 端口是**纯读**：调用前后注入的 env 对象未被改动',
  JSON.stringify(Object.keys({ CHARACTER_ROLLUP_TOKENS: 1, M55_TAVILY_SEARCH_API_KEY: 1, INNOCENT_LOOKING: 1 })) ===
  JSON.stringify(['CHARACTER_ROLLUP_TOKENS', 'M55_TAVILY_SEARCH_API_KEY', 'INNOCENT_LOOKING']),
  '注入对象无副作用')

// ---------------------------------------------------------------------------
// 4. 端到端：真 server + 该端口 ⇒ 501 变 200
// ---------------------------------------------------------------------------

const PASSWORD = 'wp2-config-port-password'
const server = createAdminAuthServer({
  passwordHash: hashAdminPassword(PASSWORD, { salt: Buffer.alloc(16, 11) }),
  host: '127.0.0.1',
  port: 0,
  ports: {
    cognition: async () => ({ surface: 'cognition', generatedAt: '', items: [] }),
    goalsCommitments: async () => ({ surface: 'goals_commitments', generatedAt: '', items: [] }),
    jobs: async () => ({ surface: 'jobs', generatedAt: '', items: [] }),
    safetyQuota: async () => ({ surface: 'safety_quota', generatedAt: '', items: [] }),
    effectiveConfig: port,
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
const response = await fetch(`${origin}/api/effective-config`, { headers: { cookie: `${ADMIN_SESSION_COOKIE}=${token}` } })
const bodyText = await response.text()
const body = JSON.parse(bodyText) as { surface?: string; items?: Record<string, unknown>[] }
check('正控 端到端：接上端口后 200（不再是 501）', response.status === 200, `status=${response.status}`)
check('正控 端到端：面 id 正确且行里有 `masked` 字段',
  body.surface === 'effective_config' && (body.items ?? []).some((item) => item.masked === true),
  JSON.stringify(body.items?.[0] ?? {}))
check('负控 端到端：HTTP 响应里**没有**明文密钥', !bodyText.includes(SECRET), '应无明文')
await server.stop()

// ---------------------------------------------------------------------------
// 5. 汇总（失败关闭）
// ---------------------------------------------------------------------------

const failed = checks.filter((c) => !c.pass)
for (const item of checks) console.log(`${item.pass ? 'PASS' : 'FAIL'}  ${item.name}${item.pass ? '' : ` — ${item.detail}`}`)
console.log(`\nA1 / WP2 effective_config 端口：判据 ${checks.length} · 失败 ${failed.length} · measured_count=${checks.length}`)
console.log('⚠️ 只覆盖**配置面**；其余四个面仍未接线，页面未做，生产激活需独立授权。')
if (checks.length === 0 || failed.length > 0) process.exit(1)
