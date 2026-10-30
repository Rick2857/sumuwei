import assert from 'node:assert/strict'
import { runReminderTurn, type ReminderResolution, type PendingReminder } from '../src/kernel/app/reminder-turn.ts'
import { resolveLocalTarget } from '../src/kernel/action/local-target.ts'
import { createLocalListAdapter } from '../src/infrastructure/action/adapters/local-filesystem.ts'

const now = Date.parse('2026-10-25T22:50:00+08:00')
const source = { id: 'table', text: '第8周：十月二十六日，上午八点半，高等数学', createdAt: now, truncated: true }
const pending: PendingReminder[] = [{ id: 'old', text: '旧提醒', dueAt: now + 3600000, sourceRefs: [] }]
let calls = 0
let writes = 0
let resolution: ReminderResolution = { ok: true, draft: { kind: 'none' } }
const ports = {
  resolve: async () => { calls++; return resolution },
  create: async (row: any) => { writes++; return { ...row, id: 'new', created: true } },
  update: async () => true,
}
for (const text of ['再试一遍', '指第8周那张', '重新进行一次', '默认吧', '好', '今天午饭很好吃', '[用户发送了图片]']) {
  const before = calls
  assert.equal((await runReminderTurn({ current: { id: 'current', text, createdAt: now }, recent: [], pending, now, enabled: true }, ports)).kind, 'none')
  assert.equal(calls, before + 1, `${text}: model must decide, without keyword or confirmation shortcuts`)
}
assert.equal(writes, 0, 'model none never writes')
resolution = { ok: true, draft: { kind: 'batch', requestSourceId: 'current', items: [
  { operation: 'create', sourceId: source.id, dateText: '2026年10月26日', timeText: '08:30', eventText: '高数', leadMinutes: 5, text: '记得签到。' },
] } }
const input = { current: { id: 'current', text: '指第8周那张', createdAt: now }, recent: [source], pending, now, enabled: true }
const result = await runReminderTurn(input, ports)
assert.ok(result.kind === 'planned' && result.items[0]?.status === 'created', JSON.stringify(result))
assert.equal(result.items[0]?.dueAt, Date.parse('2026-10-26T08:25:00+08:00'))
assert.equal(writes, 1, 'model can resolve normalized date, event and continuation from available source')
const invalid = await runReminderTurn({ ...input, recent: [] }, ports)
assert.equal(invalid.kind, 'clarify'); assert.equal(writes, 1, 'nonexistent source still cannot write')
resolution = { ok: true, draft: { kind: 'batch', items: [{ operation: 'cancel', targetIntentId: 'other-owner' }] } }
assert.equal((await runReminderTurn(input, ports)).kind, 'refused')
resolution = { ok: false, failure: 'timeout' }
assert.equal((await runReminderTurn(input, ports)).kind, 'failed'); assert.equal(writes, 1)
const platform = process.platform === 'win32' ? 'win32' : 'posix'
for (const path of ['/opt/project-lg/data/personal-library', '/opt/project-lg/data', '/']) {
  if (platform !== 'posix') continue
  const target = resolveLocalTarget({ targetType: 'local_file', rawPath: path, platform })
  assert.equal(target.target.confidence, 'exact', path)
  assert.equal(target.target.canonicalId, path)
}
assert.equal(resolveLocalTarget({ targetType: 'local_file', rawPath: 'relative/file', platform }).target.confidence, 'weak')
assert.equal(resolveLocalTarget({ targetType: 'local_file', rawPath: 'C:\\Users\\file.txt', platform: 'win32' }).target.confidence, 'exact')
if (platform === 'posix') {
  const target = resolveLocalTarget({ targetType: 'local_file', rawPath: '/opt/project-lg/data', platform }).target
  const listed = await createLocalListAdapter().execute({ actionId: 'path-probe' as any, operation: 'list', target, args: {}, context: {} } as any)
  assert.ok(listed.effect?.kind === 'content_read' && listed.turnContent?.[0]?.resourceRef === '/opt/project-lg/data', 'native path must reach actual directory adapter')
}
console.log('PASS model reminder decisions: every turn, no confirmation shortcut, normalized partial source, actual writes, invalid source/target, timeout; native paths and Windows regression')
