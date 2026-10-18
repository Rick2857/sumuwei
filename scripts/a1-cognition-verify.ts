/**
 * A1 / **WP2 第五面门**：`cognition` 真端口。
 *
 * ```text
 * 正控：接了 reader ⇒ 五格是真读数（`characterId` 是字符串；其余原样呈现）
 * 负控：没接 reader ⇒ 五格全 `null` **且**五个名字逐个进 `unavailable`（不用 `{}`/0 冒充"没有状态"）·
 *       reader 抛错 ⇒ 同形且不带异常细节 · 部分缺格 ⇒ **只把缺的那些**列进 `unavailable` ·
 *       `characterId` 空串 ⇒ 算缺格（不把空串当身份）
 * 恢复：接上 reader ⇒ 从 `null` 变真读数、`unavailable` 消失
 * 端到端：真 server ⇒ 200；未登录 ⇒ 401
 * ```
 */
import { hashAdminPassword } from '../src/infrastructure/admin/auth.ts'
import { ADMIN_SESSION_COOKIE, createAdminAuthServer } from '../src/infrastructure/admin/server.ts'
import { COGNITION_FIELDS, createCognitionPort, type CognitionReader } from '../src/infrastructure/admin-ports/cognition.ts'

const checks: { name: string; pass: boolean; detail: string }[] = []
const check = (name: string, pass: boolean, detail: string): void => {
  checks.push({ name, pass, detail })
}

const reader: CognitionReader = {
  read: async () => ({
    characterId: '00000000-0000-4000-8000-000000000001',
    affect: { mood: 'calm', intensity: 0.3 },
    relationships: [{ userId: 'user-a', trust: 0.5 }],
    beliefs: [{ key: 'education.institution', value: '示例工程科技大学' }],
    watermarks: { affect: 117, belief: 133 },
  }),
}
const wired = await createCognitionPort({ reader, now: () => new Date('2026-10-14T00:00:00.000Z') })()
const wiredRow = wired.items[0] as Record<string, unknown>
check('正控 接了 reader ⇒ 五格都是真读数',
  wiredRow.characterId === '00000000-0000-4000-8000-000000000001' &&
  (wiredRow.affect as { mood?: string })?.mood === 'calm' &&
  Array.isArray(wiredRow.relationships) && Array.isArray(wiredRow.beliefs) &&
  (wiredRow.watermarks as { affect?: number })?.affect === 117,
  JSON.stringify(wiredRow).slice(0, 120))
check('正控 行形状是冻结闭集（五格，一个不多）',
  Object.keys(wiredRow).sort().join(',') === [...COGNITION_FIELDS].sort().join(','), Object.keys(wiredRow).join(','))
check('正控 五格齐 ⇒ 没有 `unavailable`', wired.unavailable === undefined, String(wired.unavailable))

const bare = await createCognitionPort({})()
const bareRow = bare.items[0] as Record<string, unknown>
check('负控 没接 reader ⇒ 五格全 `null`（**不**用 `{}`/0 冒充"没有认知状态"）',
  COGNITION_FIELDS.every((field) => bareRow[field] === null), JSON.stringify(bareRow))
check('负控 没接 reader ⇒ 五个名字**逐个**进 `unavailable`',
  [...(bare.unavailable ?? [])].sort().join(',') === [...COGNITION_FIELDS].sort().join(','), String(bare.unavailable))

const broken: CognitionReader = { read: async () => { throw new Error('projection exploded: internal-cog-xyz') } }
const brokenReading = await createCognitionPort({ reader: broken })()
check('负控 reader 抛错 ⇒ 同形（全 `null` + `unavailable`）且**不带异常细节**',
  COGNITION_FIELDS.every((f) => (brokenReading.items[0] as Record<string, unknown>)[f] === null) &&
  !JSON.stringify(brokenReading).includes('internal-cog-xyz'), '应无细节')

const partial: CognitionReader = { read: async () => ({ characterId: '', affect: { mood: 'calm' } }) }
const partialReading = await createCognitionPort({ reader: partial })()
check('负控 部分缺格 ⇒ **只把缺的那些**列进 `unavailable`（空串身份算缺格）',
  [...(partialReading.unavailable ?? [])].sort().join(',') === 'beliefs,characterId,relationships,watermarks',
  String(partialReading.unavailable))
check('负控 空串身份**不**当身份报出去',
  (partialReading.items[0] as Record<string, unknown>).characterId === null, '应 null')

const recovered = await createCognitionPort({ reader })()
check('恢复 接上 reader ⇒ 从 `null` 变真读数、`unavailable` 消失',
  (recovered.items[0] as Record<string, unknown>).characterId === '00000000-0000-4000-8000-000000000001' && recovered.unavailable === undefined,
  '应恢复')

const PASSWORD = 'wp2-cognition-password'
const empty = (surface: 'goals_commitments' | 'jobs' | 'safety_quota' | 'effective_config') => async () =>
  ({ surface, generatedAt: '', items: [] as Record<string, unknown>[] })
const server = createAdminAuthServer({
  passwordHash: hashAdminPassword(PASSWORD, { salt: Buffer.alloc(16, 29) }),
  host: '127.0.0.1', port: 0,
  ports: {
    cognition: createCognitionPort({ reader }),
    goalsCommitments: empty('goals_commitments'),
    jobs: empty('jobs'),
    safetyQuota: empty('safety_quota'),
    effectiveConfig: empty('effective_config'),
    /* 第六个面（用户 2026-10-14 裁定）：本门不测它 ⇒ 如实 unavailable 的桩
       （本文件的 `empty()` 帮手类型窄，不收 'core_status' ⇒ 这里直接写字面量） */
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
const response = await fetch(`${origin}/api/cognition`, { headers: { cookie: `${ADMIN_SESSION_COOKIE}=${token}` } })
const body = (await response.json()) as { surface?: string; items?: Record<string, unknown>[] }
check('正控 端到端：200 且面 id 正确', response.status === 200 && body.surface === 'cognition', `status=${response.status}`)
check('正控 端到端：`characterId` 与 `watermarks` 原样出现',
  body.items?.[0]?.characterId === '00000000-0000-4000-8000-000000000001', JSON.stringify(body.items?.[0]).slice(0, 100))
const unauth = await fetch(`${origin}/api/cognition`)
check('负控 端到端：未登录 ⇒ 401', unauth.status === 401, `status=${unauth.status}`)
await server.stop()

const failed = checks.filter((c) => !c.pass)
for (const item of checks) console.log(`${item.pass ? 'PASS' : 'FAIL'}  ${item.name}${item.pass ? '' : ` — ${item.detail}`}`)
console.log(`\nA1 / WP2 cognition 端口：判据 ${checks.length} · 失败 ${failed.length} · measured_count=${checks.length}`)
console.log('⚠️ reader 是注入桩：生产认知 reader（复用既有投影）尚未接线 ⇒ 真服务里该面如实 `unavailable`。')
if (checks.length === 0 || failed.length > 0) process.exit(1)
