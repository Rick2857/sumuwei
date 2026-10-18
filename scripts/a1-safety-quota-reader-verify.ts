/**
 * A1 / **WP2 reader 门（第二面 · 映射半）**：`safety_quota` 的**拒绝映射**。
 *
 * ```text
 * 正控：拒绝态 ⇒ { reason: failure.code, at: finishedAt ?? requestedAt }
 * 负控：**`message` 永不出现**（哪怕它带着目标/参数细节）· 非拒绝态**不**混进来 ·
 *       没有 failure.code ⇒ 回落到 status（不编造原因码）· 空 code/空白 code ⇒ 回落 ·
 *       limit 在映射层**再夹一次**（1..20）· 输入顺序不被重排
 * 恢复：把记录改成拒绝态 ⇒ 又能映射出来（判据不是恒真/恒假）
 * ⚠️ 本门**不碰数据库**：`used()`（日额度）那一半还没落地，等"策略时区日界"侦察完再写。
 * ```
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ExecutionRecordView } from '../src/kernel/action/execution-ledger.ts'
import { denialFromRecord, denialRowsFromRecords, createQuotaUsageReader, createSafetyQuotaLedgerReader } from '../src/infrastructure/admin-readers/safety-quota.ts'
import { zonedDayWindow } from '../src/kernel/contracts/notification.ts'

const ROOT = resolve(fileURLToPath(import.meta.url), '../..')
const READER = 'src/infrastructure/admin-readers/safety-quota.ts'

const checks: { name: string; pass: boolean; detail: string }[] = []
const check = (name: string, pass: boolean, detail: string): void => {
  checks.push({ name, pass, detail })
}

/**
 * 造一条记录（只填映射关心的字段；其余用最小占位）。
 *
 * ⚠️ **时间戳用数字**（`Timestamp` 的真实形状）—— 第一版用 ISO 串 + `as unknown as`，
 *    把"`at` 期望 string 而 `Timestamp` 不是 string"这个真错**盖住了**（`tsc` 后来判红）。
 */
const record = (status: string, failure?: { code?: string; message?: string }, finishedAt?: number): ExecutionRecordView =>
  ({
    status,
    requestedAt: Date.parse('2026-10-14T00:00:00.000Z'),
    ...(finishedAt === undefined ? {} : { finishedAt }),
    ...(failure === undefined ? {} : { failure }),
  } as unknown as ExecutionRecordView)

const SECRET_DETAIL = 'target=C:\\secret\\path token=sk-live-abcdefghij'

// ---------------------------------------------------------------------------
// 1. 正控 / 负控：reason 与 at
// ---------------------------------------------------------------------------

const rejected = denialFromRecord(record('rejected', { code: 'quota_exhausted', message: SECRET_DETAIL }))
check('正控 拒绝态 ⇒ reason = failure.code', rejected?.reason === 'quota_exhausted', JSON.stringify(rejected))
check('正控 数字时间戳 ⇒ 归一成 ISO 串（`Timestamp` 不是 string）',
  rejected?.at === '2026-10-14T00:00:00.000Z', String(rejected?.at))
const rejectedNoFinish = denialFromRecord(record('rejected', { code: 'permission_denied' }, Date.parse('2026-10-14T01:00:00.000Z')))
check('正控 有 finishedAt 时取它', rejectedNoFinish?.at === '2026-10-14T01:00:00.000Z', String(rejectedNoFinish?.at))
check('负控 **`message` 永不出现**（哪怕它带着目标与令牌）',
  JSON.stringify(rejected).includes('secret') === false && JSON.stringify(rejected).includes('sk-live') === false,
  JSON.stringify(rejected))
check('负控 输出**只有** reason 与 at 两个键（没有 message 的位置）',
  Object.keys(rejected ?? {}).sort().join(',') === 'at,reason', Object.keys(rejected ?? {}).join(','))

check('负控 非拒绝态（succeeded / failed / partial / cancelled）⇒ 不映射',
  denialFromRecord(record('succeeded')) === undefined &&
  denialFromRecord(record('failed', { code: 'execution_failed' })) === undefined &&
  denialFromRecord(record('partial')) === undefined &&
  denialFromRecord(record('cancelled')) === undefined, '都应 undefined')

check('负控 没有 failure.code ⇒ 回落到 status（**不编造**原因码）',
  denialFromRecord(record('rejected'))?.reason === 'rejected', String(denialFromRecord(record('rejected'))?.reason))
check('负控 code 是空串/空白 ⇒ 同样回落',
  denialFromRecord(record('rejected', { code: '   ' }))?.reason === 'rejected', String(denialFromRecord(record('rejected', { code: '   ' }))?.reason))

// ---------------------------------------------------------------------------
// 2. 列表：顺序、夹紧、跳过
// ---------------------------------------------------------------------------

const many: ExecutionRecordView[] = [
  record('rejected', { code: 'a' }), record('succeeded'), record('rejected', { code: 'b' }),
  record('rejected', { code: 'c' }), record('failed', { code: 'd' }), record('rejected', { code: 'e' }),
]
const rows = denialRowsFromRecords(many, 3)
check('正控 只取拒绝态且**保持输入顺序**（a,b,c）',
  rows.map((r) => r.reason).join(',') === 'a,b,c', rows.map((r) => r.reason).join(','))
/*
 * ⚠️ 第一版用 `many`（只有 4 条拒绝）来测夹紧 —— 4 条时"夹到 20"与"根本不夹"结果一样，
 *    判据**因为错误的理由通过**。改成造 25 条拒绝，才真的能看出上限。
 */
const lots: ExecutionRecordView[] = Array.from({ length: 25 }, (_, index) => record('rejected', { code: `r${String(index)}` }))
check('负控 limit 在映射层**再夹一次**（25 条输入 · 99999 ⇒ 20 · 0/负 ⇒ 回落 5）',
  denialRowsFromRecords(lots, 99_999).length === 20 &&
  denialRowsFromRecords(lots, 0).length === 5 &&
  denialRowsFromRecords(lots, -1).length === 5,
  `99999→${String(denialRowsFromRecords(lots, 99_999).length)} · 0→${String(denialRowsFromRecords(lots, 0).length)}`)
check('负控 给的 limit 比上限小 ⇒ 就按它（3 条）', denialRowsFromRecords(lots, 3).length === 3, String(denialRowsFromRecords(lots, 3).length))
check('负控 输入里没有拒绝 ⇒ 空数组（**不是** null，也不是编造的行）',
  denialRowsFromRecords([record('succeeded'), record('failed')], 5).length === 0, '应 0')
check('负控 空输入 ⇒ 空数组', denialRowsFromRecords([], 5).length === 0, '应 0')

// ---------------------------------------------------------------------------
// 3. 恢复 + 只读边界（结构）
// ---------------------------------------------------------------------------

check('恢复 把同一行从 succeeded 改成 rejected ⇒ 又能映射出来',
  denialFromRecord(record('succeeded')) === undefined && denialFromRecord(record('rejected', { code: 'x' }))?.reason === 'x',
  '应恢复')

const text = readFileSync(resolve(ROOT, READER), 'utf8')
const codeOnly = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
check('只读：**代码**里不出现账本写侧入口（`append`）', !/append[A-Z]/.test(codeOnly), '不应出现')
check('只读：**代码**里不出现 `countQuotaUsage`（`used()` 那一半还没落地，先别偷偷接）',
  !codeOnly.includes('countQuotaUsage'), '不应出现')
check('隐私：**代码**里不出现 `failure.message` 的取值路径', !/\.message\b/.test(codeOnly), '不应出现 .message')
check('判据是活的（剥注释这一步真的生效）', codeOnly.length < text.length, `${codeOnly.length} < ${text.length}`)

// ---------------------------------------------------------------------------
// 3bis. `used()`：日额度窗口（**用真 `zonedDayWindow`**，只把 I/O 注入）
// ---------------------------------------------------------------------------

const AT = new Date('2026-10-14T20:00:00.000Z') // = 上海 10-15 04:00 ⇒ 两个时区的"日"不同
let seenQuery: { characterId: string; dayStart: number; dayEnd: number } | undefined
const usedUtc = await createQuotaUsageReader({
  characterId: 'c-1',
  timeZone: 'UTC',
  now: () => AT.getTime(),
  countUsage: async (query) => {
    seenQuery = query
    return 137
  },
})()

check('正控 `used()` 返回注入读数的值', usedUtc === 137, String(usedUtc))
check('正控 日界来自**既有算法** `zonedDayWindow(AT.getTime(), timeZone)`（不是自己算的）',
  seenQuery?.dayStart === zonedDayWindow(AT.getTime(), 'UTC').start && seenQuery?.dayEnd === zonedDayWindow(AT.getTime(), 'UTC').end,
  JSON.stringify(seenQuery))
check('负控 **不是宿主机日界**：UTC 窗口 ≠ 上海窗口（若自己 `setHours(0,0,0,0)` 就会相等）',
  seenQuery?.dayStart !== zonedDayWindow(AT.getTime(), 'Asia/Shanghai').start,
  `utc=${String(seenQuery?.dayStart)} sh=${String(zonedDayWindow(AT.getTime(), 'Asia/Shanghai').start)}`)
check('正控 characterId 原样传给读数（不换人）', seenQuery?.characterId === 'c-1', String(seenQuery?.characterId))

let shanghaiStart: number | undefined
await createQuotaUsageReader({
  characterId: 'c-1',
  timeZone: 'Asia/Shanghai',
  now: () => AT.getTime(),
  countUsage: async (query) => {
    shanghaiStart = query.dayStart
    return 0
  },
})()
check('恢复 换时区 ⇒ 窗口真的跟着变（参数有意义）',
  shanghaiStart !== undefined && shanghaiStart !== seenQuery?.dayStart, `${String(shanghaiStart)} vs ${String(seenQuery?.dayStart)}`)

// ---------------------------------------------------------------------------
// 3ter. 账本 reader 组合（`createSafetyQuotaLedgerReader`）
// ---------------------------------------------------------------------------

let ledgerQuery: { characterId: string; status?: string; capability?: string; limit: number } | undefined
const ledgerReader = createSafetyQuotaLedgerReader({
  characterId: 'c-1',
  timeZone: 'UTC',
  now: () => AT.getTime(),
  countUsage: async () => 42,
  ledger: {
    listRecords: async (query) => {
      ledgerQuery = query
      return [record('rejected', { code: 'quota_exhausted' }), record('succeeded')]
    },
  },
})

check('正控 组合：`used()` 委托给日额度读法（42）', (await ledgerReader.used()) === 42, String(await ledgerReader.used()))
const denials = await ledgerReader.recentDenials(5)
check('正控 组合：`recentDenials` 只映射拒绝态（1 条）', denials.length === 1 && denials[0]?.reason === 'quota_exhausted', JSON.stringify(denials))
check('⚠️ 正控 过滤**交给 SQL**（查询里带 `status: \'rejected\'`）—— `ActionLedgerQuery` 逐字要求',
  ledgerQuery?.status === 'rejected', JSON.stringify(ledgerQuery))
check('正控 组合把 `characterId` 与 `limit` 原样传下去（不换人、不放大页）',
  ledgerQuery?.characterId === 'c-1' && ledgerQuery?.limit === 5, JSON.stringify(ledgerQuery))
check('负控 组合的 limit 也**再夹一次**（99999 ⇒ ≤20）',
  (await ledgerReader.recentDenials(99_999)).length <= 20 && (ledgerQuery?.limit ?? 0) <= 20, String(ledgerQuery?.limit))

const failed = checks.filter((c) => !c.pass)
for (const item of checks) console.log(`${item.pass ? 'PASS' : 'FAIL'}  ${item.name}${item.pass ? '' : ` — ${item.detail}`}`)
console.log(`\nA1 / WP2 safety_quota reader（映射半 + 日额度窗口）：判据 ${checks.length} · 失败 ${failed.length} · measured_count=${checks.length}`)
console.log('⚠️ 本门**不碰数据库**：日界走既有 `zonedDayWindow`、I/O 注入 ⇒ 真服务里该面仍是如实 `unavailable`（真 db 注入见交接单 §1bis）。')
if (checks.length === 0 || failed.length > 0) process.exit(1)
