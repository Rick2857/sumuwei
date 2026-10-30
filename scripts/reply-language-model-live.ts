import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { runReplyGuardChain, type ReplyGuardChainInput } from '../src/kernel/app/reply-guard-chain.ts'
import { reminderFactText } from '../src/kernel/app/reminder-turn.ts'

assert.equal(process.env.DSH_TEST_MODEL_WRAPPER, '1', 'test endpoint wrapper required')
const cases: { name: string; user: string; context: string; facts: Omit<ReplyGuardChainInput, 'replyText'> }[] = [
  { name: 'ordinary-timetable', user: '以后不用我老截屏发了，你现在应该可以直接查我的课表了。',
    context: '已提供课表查询能力。本轮没有调用查询工具，没有修改提醒或新增目标记录。', facts: { reminderResult: { kind: 'none' } } },
  { name: 'quoted-negation', user: '我说“我没说提醒已经设置好了”，只是解释一下，不是在让你建提醒。',
    context: '本轮提醒解析结果为 none，没有创建或修改提醒。正常回应当前话题。', facts: { reminderResult: { kind: 'none' } } },
  { name: 'failed-reminder', user: '刚才让你加的提醒好了吗？', context: '',
    facts: { reminderResult: { kind: 'failed', code: 'reminder_write_failed', message: '这次提醒保存失败；已有提醒未改动。' } } },
  { name: 'cancelled-reminder', user: '消掉体育课那条吧，下雨没课。', context: '',
    facts: { reminderResult: { kind: 'planned', code: 'reminder_plan_result', sourceRefs: ['fixture'], message: '体育课提醒已取消。',
      items: [{ operation: 'cancel', status: 'cancelled', id: 'sports', text: '大学体育：签到。' }] } } },
  { name: 'partial-result', user: '高数和体育的提醒都安排好了吗？', context: '',
    facts: { reminderResult: { kind: 'planned', code: 'reminder_plan_result', sourceRefs: ['fixture'], message: '高数已保存，体育保存失败。',
      items: [{ operation: 'create', status: 'created', id: 'math', text: '高数：签到。' },
        { operation: 'create', status: 'failed', code: 'reminder_write_failed', text: '体育：签到。' }] } } },
]
const rows: Record<string, unknown>[] = []
const directory = `artifacts/post-lv2/local/reply-language-model-${Date.now()}`
mkdirSync(directory, { recursive: true })
try {
  for (const item of cases) {
    const response = await fetch(`${process.env.OPENAI_BASE_URL!.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: process.env.OPENAI_SMALL_MODEL, max_tokens: 1600, messages: [
        { role: 'system', content: '你是苏沐薇，使用自然简短的中文回应用户。结合上下文理解否定、引用和历史表述，严格依据实际操作事实回答，不虚构成功，不照抄内部回执，不输出内部状态码。' },
        { role: 'user', content: item.user },
        { role: 'system', content: [item.context, reminderFactText(item.facts.reminderResult)].filter(Boolean).join('\n') },
      ] }), signal: AbortSignal.timeout(45_000),
    })
    assert.ok(response.ok, `HTTP ${response.status}`)
    const data = await response.json() as any
    const draft = String(data.choices?.[0]?.message?.content ?? '')
    rows.push({ name: item.name, reply: draft, usage: data.usage })
    assert.ok(draft.trim())
    assert.equal(runReplyGuardChain({ ...item.facts, replyText: draft }).replyText, draft)
    console.log(`${item.name}: ${draft}`)
  }
} finally {
  writeFileSync(`${directory}/result.json`, JSON.stringify({ model: process.env.OPENAI_SMALL_MODEL, requests: rows.length,
    database: 'none; synthetic operation results', realDeliveries: 0, rows }, null, 2))
  console.log(`Evidence: ${directory}/result.json`)
}
