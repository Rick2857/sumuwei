import assert from 'node:assert/strict'
import { readReminderRequest } from '../src/kernel/contracts/notification-intake.ts'
import { readReminderDraft, runReminderTurn, type ReminderResolution, type PendingReminder } from '../src/kernel/app/reminder-turn.ts'
import { runReplyGuardChain } from '../src/kernel/app/reply-guard-chain.ts'
import { createOpenAiReminderResolver } from '../src/infrastructure/model/openai-reminder-text.ts'

const now = Date.parse('2026-10-15T12:00:00+08:00')
const parsed = readReminderRequest({ text: '2026年10月20日上午9点提醒我交材料', now })
assert.equal(parsed.kind, 'scheduled')
assert.ok(parsed.kind === 'scheduled' && parsed.dueAt === Date.parse('2026-10-20T09:00:00+08:00'), '完整日期不能被忽略')
let measured = 1
for (const [text, expected] of [
  ['10月20日09:30提醒我', '2026-10-20T09:30:00+08:00'],
  ['2026-10-20 09:30提醒我', '2026-10-20T09:30:00+08:00'],
  ['2026/10/20 09:30提醒我', '2026-10-20T09:30:00+08:00'],
  ['二〇二六年十月二十日上午九点半提醒我', '2026-10-20T09:30:00+08:00'],
  ['后天晚上8点提醒我', '2026-10-17T20:00:00+08:00'],
  ['本周五下午3点提醒我', '2026-10-16T15:00:00+08:00'],
  ['本周日23:00提醒我', '2026-10-18T23:00:00+08:00'],
  ['下周三下午3点提醒我', '2026-10-21T15:00:00+08:00'],
  ['明年1月5日上午9点提醒我', '2027-01-05T09:00:00+08:00'],
  ['2028年2月29日上午9点提醒我', '2028-02-29T09:00:00+08:00'],
] as const) {
  const r = readReminderRequest({ text, now })
  assert.ok(r.kind === 'scheduled' && r.dueAt === Date.parse(expected), JSON.stringify({ text, r })); measured++
}
for (const text of ['2026年2月30日上午9点提醒我', '2027年2月29日上午9点提醒我', '2026年13月20日9点提醒我',
  '2026年10月20日25:00提醒我', '2026年10月20日提醒我', '2026年10月20日上午9点和10月21日上午9点提醒我']) {
  assert.equal(readReminderRequest({ text, now }).kind, 'clarify', text); measured++
}
assert.equal(readReminderRequest({ text: '2026年2月28日上午9点提醒我', now }).kind, 'refused'); measured++
assert.equal(readReminderRequest({ text: '6min后提醒我看月亮', now }).kind, 'scheduled'); measured++

const source = { id: 'table', text: '2026年10月20日 09:00 英语；2026年10月21日 15:00 会议', createdAt: now }
const current = { id: 'request', text: '这些事件分别提前5分钟通过QQ提醒我', createdAt: now }
const pending: PendingReminder[] = []
let resolution: ReminderResolution = { ok: true, draft: { kind: 'batch', items: [
  { operation: 'create', sourceId: source.id, dateText: '2026年10月20日', timeText: '09:00', leadMinutes: 5, text: '英语课签到。' },
  { operation: 'create', sourceId: source.id, dateText: '2026年10月21日', timeText: '15:00', leadMinutes: 5, text: '准备开会。' },
] } }
const draft = resolution.draft as import('../src/kernel/app/reminder/plan.ts').ReminderPlanDraft
const writes: unknown[] = []
const ports = {
  resolve: async () => resolution,
  create: async (input: Omit<PendingReminder, 'id'>) => { writes.push(input); const row = { ...input, id: `intent-${pending.length}` }; pending.push(row); return { ...row, created: true } },
  update: async () => true,
  reschedule: async (row: PendingReminder, dueAt: number) => { row.dueAt = dueAt; return true },
  cancel: async (row: PendingReminder) => { pending.splice(pending.indexOf(row), 1); return true },
}
const call = (text = current.text, enabled = true, materials?: { id: string; text: string; createdAt: number; dataUrl?: string; truncated?: boolean }[]) =>
  runReminderTurn({ current: { ...current, text }, recent: [source], pending, now, enabled, entry: 'qq_private', availableChannels: ['qq_private'], materials }, ports)
const batch = await call()
assert.equal(batch.kind, 'planned'); assert.equal(writes.length, 2)
assert.equal(pending[0]!.dueAt, Date.parse('2026-10-20T08:55:00+08:00'))
assert.equal(pending[1]!.dueAt, Date.parse('2026-10-21T14:55:00+08:00'))
assert.equal((await call()).kind, 'planned'); assert.equal(writes.length, 2, '重复提案不得重复创建')
assert.match(runReplyGuardChain({ replyText: '已经全部发送了。', reminderResult: batch }).replyText, /新增2条/u)
measured += 6
resolution = { ok: true, draft: { kind: 'batch', items: [
  { operation: 'create', sourceId: 'table', timeText: '2026年10月20日 09:00', leadMinutes: 5, text: '另一个提醒' },
  { operation: 'create', sourceId: 'forged', timeText: '2026年10月21日 15:00', leadMinutes: 5, text: '注入' },
] } }
assert.equal((await call()).kind, 'clarify'); assert.equal(writes.length, 2, '先校验整批，伪造来源不能导致前半批写入'); measured++
resolution = { ok: true, draft: { kind: 'batch', items: [{ operation: 'create', sourceId: 'table', timeText: '2026年10月22日 12:00', leadMinutes: 5, text: '编造日期' }] } }
assert.equal((await call()).kind, 'refused'); assert.equal(writes.length, 2); measured++
resolution = { ok: true, draft: { kind: 'batch', items: [{ operation: 'create', sourceId: 'table', timeText: '2026年10月20日 09:00', text: '漏减五分钟' }] } }
assert.equal((await call()).kind, 'clarify'); measured++
resolution = { ok: true, draft: { kind: 'batch', items: [{ operation: 'reschedule', targetIntentId: pending[0]!.id, sourceId: 'table', timeText: '2026年10月21日 15:00' }] } }
assert.equal((await call('把英语课提醒改到2026年10月21日15:00')).kind, 'planned')
assert.equal(pending[0]!.dueAt, Date.parse('2026-10-21T15:00:00+08:00')); measured++
resolution = { ok: true, draft: { kind: 'list' } }
assert.match((await call('查看提醒') as { message: string }).message, /待发送提醒共2条/u); measured++
resolution = { ok: true, draft: { kind: 'batch', items: [{ operation: 'cancel', targetIntentId: 'other-user' }] } }
assert.equal((await call('取消提醒')).kind, 'refused'); assert.equal(pending.length, 2); measured++
resolution = { ok: true, draft: { kind: 'batch', items: pending.map(row => ({ operation: 'cancel' as const, targetIntentId: row.id })) } }
assert.equal((await call('取消这两条提醒')).kind, 'planned'); assert.equal(pending.length, 0); measured++
resolution = { ok: true, draft }
assert.equal((await call(current.text, false)).kind, 'refused'); measured++
assert.equal((await call('这是一张课表')).kind, 'none'); measured++
const invalid = { kind: 'batch', items: [{ operation: 'create', sourceId: 'table', timeText: '09:00', text: '签到', dueAt: now }] }
assert.equal(readReminderDraft(invalid), undefined); measured++
assert.equal(readReminderDraft({ kind: 'batch', items: [{ operation: 'create', sourceId: 'table', timeText: '09:00', text: '签到', channel: 'qq_private' }] }), undefined); measured++
assert.ok(readReminderDraft(draft)); measured++
assert.equal(readReminderDraft({ ...draft, items: Array(101).fill(draft.items[0]) }), undefined); measured++

resolution = { ok: true, draft: { kind: 'batch', items: [{ operation: 'create', sourceId: 'table', eventText: '英语',
  dateText: '2026年10月20日', timeText: '09:00', leadMinutes: 5, text: '提前准备。' }] } }
await call()
const namedCount = writes.length
resolution = { ok: true, draft: { kind: 'batch', items: [{ operation: 'create', sourceId: 'table', eventText: '英语',
  dateText: '2026年10月20日', timeText: '09:00', leadMinutes: 5, text: '请记得签到。' }] } }
assert.match((await call() as { message: string }).message, /新增0条，已有1条/u)
assert.equal(writes.length, namedCount, '事件名称相同而提醒措辞不同仍去重'); measured++
resolution = { ok: true, draft: { kind: 'batch', items: [{ operation: 'confirm', targetIntentId: pending[0]!.id, text: '模型改写不应落库' }] } }
const savedText = pending[0]!.text
assert.match((await call() as { message: string }).message, /新增0条，已有1条/u)
assert.equal(pending[0]!.text, savedText); measured++
assert.equal(readReminderDraft({ kind: 'batch', items: [{ operation: 'confirm', targetIntentId: pending[0]!.id, text: {} }] }), undefined); measured++
resolution = { ok: true, draft: { kind: 'batch', items: [{ operation: 'create', sourceId: 'partial',
  dateText: '2026年10月20日', timeText: '09:00', leadMinutes: 5, text: '不完整资料' }] } }
assert.equal((await call(current.text, true, [{ ...source, id: 'partial', truncated: true }])).kind, 'clarify')
assert.equal(writes.length, namedCount); measured++
resolution = { ok: true, draft: { kind: 'batch', items: [{ operation: 'create', sourceId: 'clock-only', timeText: '09:00', leadMinutes: 5, text: '缺日期' }] } }
assert.equal((await call(current.text, true, [{ ...source, id: 'clock-only', text: '09:00 英语' }])).kind, 'clarify'); measured++
resolution = { ok: true, draft }
let attempts = 0
const partial = await runReminderTurn({ current, recent: [source], pending: [], now, enabled: true, entry: 'qq_private', availableChannels: ['qq_private'] }, {
  ...ports, create: async input => { attempts++; if (attempts === 2) throw new Error('fixture failure'); return { ...input, id: 'partial-written', created: true } },
})
assert.equal(attempts, 2)
assert.match((partial as { message: string }).message, /新增1条.*失败1条/u)
assert.match(runReplyGuardChain({ replyText: '全部成功。', reminderResult: partial }).replyText, /失败1条/u); measured++

let transmitted: Record<string, any> = {}
const resolver = createOpenAiReminderResolver({ env: { OPENAI_API_KEY: 'fixture', OPENAI_SMALL_MODEL: 'small', OPENAI_LARGE_MODEL: 'vision' },
  fetchImpl: async (_url, init) => { transmitted = JSON.parse(String(init?.body)); return new Response(JSON.stringify({ choices: [{ message: { content: '{"kind":"list"}' } }] })) } })
await resolver({ current, recent: [], pending: [], materials: [{ id: 'image-ref', text: '本周安排', createdAt: now, dataUrl: 'data:image/png;base64,aGVsbG8=' }] })
assert.equal(transmitted.model, 'vision'); assert.equal(transmitted.messages[1].content[2].type, 'image_url')
assert.ok(!transmitted.messages[1].content[0].text.includes('base64'), '二进制不复制进来源JSON'); measured++
assert.ok(measured > 0)
console.log(`Reminder planning: ${measured} checks PASS (no production database or deliveries)`)
