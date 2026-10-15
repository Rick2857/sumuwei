import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isolateDatabase, resetPluginSqlConnection } from '../src/dev/sandbox.ts'
import { createM4Harness } from './m4-harness.ts'
import { TurnGateway } from '../src/kernel/app/turn-gateway.ts'
import { DEFAULT_CONTEXT_BUDGET } from '../src/kernel/recall/selector.ts'
import type { ReminderMaterial } from '../src/kernel/app/reminder/plan.ts'

process.env.CHARACTER_DB_BACKEND = 'pglite'
process.env.POSTGRES_URL = ''
for (const key of ['LG_PG_EXPECT_DATABASE', 'LG_PG_EXPECT_USER', 'LG_PG_EXPECT_DATABASE_PREFIX', 'LG_PG_EXPECT_USER_PREFIX', 'LG_PG_EXPECT_ADDR', 'LG_PG_EXPECT_PORT']) process.env[key] = ''
isolateDatabase('reminder-material-budget')
const h = await createM4Harness({ label: 'reminder-material-budget' })
const readings: unknown[] = []
try {
  for (const budget of [0, 2000, 0]) {
    const gateway = new TurnGateway({ kernel: h.kernel, definition: h.kernel.definition, identity: h.kernel.identitySnapshot,
      recorder: h.recorder, conversationSequence: h.nextTurnSequence, slowPathEnabled: false, userId: h.userId,
      recallBudget: { ...DEFAULT_CONTEXT_BUDGET, turnContentTokens: budget } })
    const text = '按文档中的事件提前5分钟提醒我'
    const turn = await gateway.beginTurn(text)
    const content = '2026年10月20日 09:00 英语课'
    turn.turnContent = [{ contentId: 'fixture-document', kind: 'document', capability: 'document.read', operation: 'read',
      sourceKind: 'local-disk', resourceRef: 'fixture.txt', resultFingerprint: 'synthetic',
      scope: { totalChars: content.length + 10, includedChars: content.length, truncated: true },
      facts: [], text: content, mediaType: 'text/plain', structure: [] }]
    let materials: readonly ReminderMaterial[] = []
    await gateway.compileTurn({ turn, currentInput: text, recentLines: [], runReminderTurn: async (_recent, _withdrawn, selected) => {
      materials = selected ?? []; return { kind: 'none' }
    } })
    assert.equal(materials.length, budget === 0 ? 0 : 1, '提醒解析必须服从当轮内容额度')
    if (budget) { assert.equal(materials[0]!.id, 'fixture-document'); assert.equal(materials[0]!.truncated, true) }
    readings.push({ budget, count: materials.length })
    await gateway.completeTurn({ turn, replyText: '预算验收占位。' })
  }
} finally { await h.stop(); await resetPluginSqlConnection() }
const out = resolve('artifacts/post-lv2/reminder-planning', `budget-${Date.now()}`)
mkdirSync(out, { recursive: true }); writeFileSync(resolve(out, 'evidence.json'), JSON.stringify({ readings, modelCalls: 0 }, null, 2))
console.log('Reminder material gateway: zero budget, granted budget with truncation, zero-budget recovery PASS')
