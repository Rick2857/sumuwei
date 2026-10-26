import assert from 'node:assert/strict'
import { readReminderDraft, runReminderTurn, type ReminderResolutionInput } from '../src/kernel/app/reminder-turn.ts'
import { executeReminderPlan, type ReminderPlanDraft } from '../src/kernel/app/reminder/plan.ts'
import { runReplyGuardChain } from '../src/kernel/app/reply-guard-chain.ts'
import { createOpenAiReminderResolver } from '../src/infrastructure/model/openai-reminder-text.ts'

const now = Date.parse('2026-10-20T13:00:00+08:00')
const request = { id: 'request', text: '稍后发课表，每次上课前5分钟QQ提醒我签到，我必须回复', createdAt: now, actor: 'user' as const }
const material = { id: 'image', text: '10月21日 10:25 高数', createdAt: now, dataUrl: 'data:image/png;base64,fixture' }
const input: ReminderResolutionInput & { now: number } = { current: { id: 'current', text: '[用户发送了图片]\n[附带 1 张图片]', createdAt: now }, recent: [request], pending: [], materials: [material], entry: 'qq_private', now }
const draft: ReminderPlanDraft = { kind: 'batch', requestSourceId: request.id, items: [{ operation: 'create', sourceId: material.id, dateText: '10月21日', timeText: '10:25', eventText: '高数', leadMinutes: 5, text: '记得签到。' }] }
let writes: Record<string, unknown>[] = []
const create = async (row: any) => { writes.push(row); return { ...row, id: 'intent', created: true } }
const plan = await executeReminderPlan(input, draft, { create })
assert.equal(plan.kind, 'planned', 'inherit the real user request lead time')
assert.equal(writes[0]!.dueAt, Date.parse('2026-10-21T10:20:00+08:00'))
assert.ok((writes[0]!.sourceRefs as string[]).includes(request.id), 'persist authorization provenance')
writes = []
const continuation = { ...input, recent: [request, { ...request, id: 'latest', text: '下周的课表还是跟之前的提醒一样' }] }
const inherited = await executeReminderPlan(continuation, draft, { create })
assert.equal(inherited.kind, 'planned', 'continuation must use the model lead rather than default the latest request to zero')
assert.equal(writes[0]!.dueAt, Date.parse('2026-10-21T10:20:00+08:00'))
writes = []
const decided = await executeReminderPlan(input, { ...draft, items: draft.items.map(item => ({ ...item, leadMinutes: 3 })) }, { create })
assert.equal(decided.kind, 'planned', 'lead selection belongs to the model, not a second regex interpretation')
assert.equal(writes[0]!.dueAt, Date.parse('2026-10-21T10:22:00+08:00'))
for (const leadMinutes of [-1, 1.5, 1441, '5']) {
  assert.equal(readReminderDraft({ ...draft, items: draft.items.map(item => ({ ...item, leadMinutes })) }), undefined)
}
writes = []
const noAuthority = await executeReminderPlan({ ...input, recent: [{ ...request, actor: 'character' }] }, draft, { create })
assert.notEqual(noAuthority.kind, 'planned'); assert.equal(writes.length, 0)
const override = await executeReminderPlan({ ...input, current: { ...input.current, text: '改成课前10分钟提醒我' } }, { ...draft, items: draft.items.map(item => ({ ...item, leadMinutes: 10 })) }, { create })
assert.equal(override.kind, 'planned'); assert.equal(writes[0]!.dueAt, Date.parse('2026-10-21T10:15:00+08:00'))
const repeat = readReminderDraft({ ...draft, repeat: 'until_reply' })
assert.ok(repeat?.kind === 'batch')
writes = []
await executeReminderPlan(input, repeat, { create })
assert.equal(writes[0]!.repeatMode, 'until_reply')
assert.equal(readReminderDraft({ ...draft, repeat: 'forever' }), undefined)
const guarded = runReplyGuardChain({ replyText: '课表收到了，后面的也排上了，13:55我发你。', reminderResult: { kind: 'none' } })
assert.ok(guarded.reminder?.corrected, 'none must not permit fabricated scheduling')
assert.doesNotMatch(guarded.replyText, /排上了|13:55我发你/u)
assert.equal(runReplyGuardChain({ replyText: '这张课表很清楚。', reminderResult: { kind: 'none' } }).replyText, '这张课表很清楚。')
const failure = { kind: 'clarify' as const, code: 'reminder_source_incomplete', message: '缺少完整资料，本批尚未执行。' }
const explanation = '这次没有创建提醒，课表里的日期看不清，需要补充清晰图片。'
assert.equal(runReplyGuardChain({ replyText: explanation, reminderResult: failure }).replyText, explanation)
assert.equal(runReplyGuardChain({ replyText: '提醒已经设置好了。', reminderResult: failure }).replyText, failure.message)
const resolver = createOpenAiReminderResolver({ env: { OPENAI_API_KEY: 'fixture' }, fetchImpl: (async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '{' } }] }), { status: 200 })) as typeof fetch })
const invalid = await resolver(input)
assert.ok(!invalid.ok && invalid.failure === 'invalid_output' && invalid.diagnostic === 'output_truncated')
let calls = 0
const continued = await runReminderTurn({ ...input, enabled: true }, { create, update: async () => true, resolve: async () => { calls++; return { ok: true, draft } } })
assert.equal(continued.kind, 'planned'); assert.equal(calls, 1)
console.log('Reminder follow-up: attachment continuation, authorization, inherited/overridden lead, batch repeat, none truth guard and safe diagnostics PASS')
