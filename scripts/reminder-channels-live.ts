import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createOpenAiReminderResolver } from '../src/infrastructure/model/openai-reminder-text.ts'
import { runReminderTurn, type PendingReminder } from '../src/kernel/app/reminder-turn.ts'
import { CHAT_CHANNELS, type ChatChannel } from '../src/kernel/contracts/chat-channel.ts'

assert.equal(process.env.DSH_TEST_MODEL_WRAPPER, '1', '真模型必须经过 with-test-model')
const resolver = createOpenAiReminderResolver()
const checks = [
  ['avatar', '十分钟后提醒我拔插头，通过QQ发消息', 'qq_private'],
  ['qq_private', '十分钟后通过皮套提醒我拔插头', 'avatar'],
  ['avatar', '十分钟后用控制台文字提醒我拔插头', 'cli'],
  ['cli', '十分钟后提醒我拔插头', 'cli'],
  ['avatar', '十分钟后提醒我打开QQ', 'avatar'],
  ['avatar', '十分钟后用微信提醒我拔插头', 'unsupported'],
  ['qq_private', '十分钟后就在这里提醒我拔插头', 'qq_private'],
  ['avatar', '把这条提醒改到控制台', 'cli'],
] as const
const readings: unknown[] = []
try {
  for (const [entry, text, expected] of checks) {
    const now = Date.now()
    const pending: PendingReminder[] = text.startsWith('把')
      ? [{ id: 'pending', text: '记得拔插头。', dueAt: now + 600000, sourceRefs: ['earlier'], channel: 'qq_private' }] : []
    const result = await runReminderTurn({ current: { id: 'current', text, createdAt: now }, recent: [], pending,
      now, enabled: true, entry, availableChannels: CHAT_CHANNELS }, {
      resolve: resolver,
      create: async input => ({ id: 'synthetic-no-database', ...input, created: true }),
      update: async (_target, _text, _refs, channel) => channel === expected as ChatChannel,
    })
    readings.push({ entry, text, expected, result })
    if (expected === 'unsupported') assert.equal(result.kind, 'refused', JSON.stringify(result))
    else assert.ok('channel' in result && result.channel === expected, JSON.stringify(result))
    console.log(`PASS ${entry} -> ${expected}`)
  }
} finally {
  const out = resolve('artifacts/post-lv2/reminder-channels', `live-${Date.now()}`)
  mkdirSync(out, { recursive: true })
  writeFileSync(resolve(out, 'evidence.json'), JSON.stringify({ database: 'NOT_OPENED', deliveries: 'NOT_SENT', readings }, null, 2))
}
console.log(`真实模型渠道理解：${readings.length} PASS；未打开数据库、未发送提醒`)
