import assert from 'node:assert/strict'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { createOpenAiReminderResolver } from '../src/infrastructure/model/openai-reminder-text.ts'
import { runReminderTurn, type PendingReminder, type ReminderResolutionInput } from '../src/kernel/app/reminder-turn.ts'

assert.equal(process.env.DSH_TEST_MODEL_WRAPPER, '1', '真实模型只能经过 with-test-model')
const now = Date.now()
const dates = [1, 2, 3].map(days => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now + days * 86_400_000))
const text = `${dates[0]} 10:00 英语课\n${dates[1]} 15:00 项目会议\n${dates[2]} 09:30 报告提交`
const expected = dates.map((date, index) => Date.parse(`${date.replaceAll('/', '-')}T${['09:55', '14:55', '09:25'][index]}:00+08:00`))
const suppliedImage = process.argv.find(value => value.startsWith('--image='))?.slice('--image='.length)
const imagePath = suppliedImage ?? resolve(tmpdir(), `lg-reminder-live-${now}.png`)
if (!suppliedImage) {
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`
  const rows = dates.map((date, index) => `${date}        ${['10:00', '15:00', '09:30'][index]}        ${['英语课', '项目会议', '报告提交'][index]}`)
  const script = `Add-Type -AssemblyName System.Drawing
    $bitmap=New-Object System.Drawing.Bitmap 1400,440
    $graphics=[System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.Clear([System.Drawing.Color]::White)
    $font=New-Object System.Drawing.Font 'Microsoft YaHei',25
    $graphics.DrawString('未来三天安排（合成测试资料）',$font,[System.Drawing.Brushes]::Black,35,25)
    $graphics.DrawString('日期                    时间          事项',$font,[System.Drawing.Brushes]::Black,35,105)
    $rows=@(${rows.map(quote).join(',')})
    for($i=0;$i -lt 3;$i++){ $graphics.DrawString($rows[$i],$font,[System.Drawing.Brushes]::Black,35,(175+70*$i)) }
    $bitmap.Save(${quote(imagePath)},[System.Drawing.Imaging.ImageFormat]::Png)
    $graphics.Dispose(); $font.Dispose(); $bitmap.Dispose()`
  const generated = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, encoding: 'utf8' })
  assert.equal(generated.status, 0, '合成测试图片生成失败')
}
const dataUrl = `data:image/png;base64,${readFileSync(imagePath).toString('base64')}`
const candidates: unknown[] = []
const resolver = createOpenAiReminderResolver({ fetchImpl: async (url, options) => {
  try {
    const response = await fetch(url, options)
    if (!response.ok) {
      const body = await response.clone().json().catch(() => ({})) as { error?: { code?: string; message?: string } }
      console.log(JSON.stringify({ status: response.status, code: body.error?.code }))
    } else {
      const payload = await response.clone().json() as { choices?: { message?: { content?: string } }[] }
      candidates.push(payload.choices?.[0]?.message?.content)
    }
    return response
  } catch (error) {
    console.log(JSON.stringify({ transportError: (error as Error).name, cause: (error as { cause?: { code?: string } }).cause?.code }))
    throw error
  }
} })
const readings: unknown[] = []
try {
  for (const kind of ['text', 'image'] as const) {
    const pending: PendingReminder[] = []
    const input: ReminderResolutionInput & { now: number; enabled: boolean } = { current: { id: `request-${kind}`, text: '按这份安排中的所有事件，分别提前5分钟通过QQ提醒我。', createdAt: now },
      recent: kind === 'text' ? [{ id: 'document', text, createdAt: now - 1000 }] : [],
      materials: kind === 'image' ? [{ id: 'image-fixture', text: '这是我未来三天的安排', dataUrl, createdAt: now - 1000 }] : [],
      pending, now, enabled: true, entry: 'qq_private', availableChannels: ['qq_private'] }
    const ports = {
      resolve: resolver,
      create: async (input: Omit<PendingReminder, 'id'>) => { const row = { ...input, id: `fixture-${pending.length}` }; pending.push(row); return { ...row, created: true } },
      update: async () => false,
    }
    const result = await runReminderTurn(input, ports)
    readings.push({ kind, result, actual: pending.map(row => row.dueAt), expected })
    assert.equal(result.kind, 'planned', JSON.stringify(result))
    assert.deepEqual(pending.map(row => row.dueAt).sort(), [...expected].sort(), `${kind}事件时间及提前量`)
    assert.equal(pending.length, 3)
    console.log(`PASS real-model ${kind}: 3 dated reminders with exact five-minute offsets`)
    const repeated = await runReminderTurn({ ...input, current: { ...input.current, id: `repeated-${kind}` } }, ports)
    readings.push({ kind: `${kind}-repeat`, result: repeated, count: pending.length })
    assert.equal(pending.length, 3, `${kind}重复请求不得受提醒措辞变化影响而重复建单`)
    assert.equal(repeated.kind, 'planned', JSON.stringify(repeated))
    console.log(`PASS real-model ${kind}: repeat remains exactly 3 reminders`)
  }
} finally {
  const out = resolve('artifacts/post-lv2/reminder-planning', `live-${now}`)
  mkdirSync(out, { recursive: true }); writeFileSync(resolve(out, 'evidence.json'), JSON.stringify({ readings, candidates,
    database: 'NOT OPENED', deliveries: 'NOT SENT', source: 'synthetic schedule; not a real user timetable' }, null, 2))
}
