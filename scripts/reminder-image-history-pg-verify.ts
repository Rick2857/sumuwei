import assert from 'node:assert/strict'
import { runPreparedPgGate } from './postgresql/test-harness.ts'
import { createM4Harness } from './m4-harness.ts'
import { TurnGateway } from '../src/kernel/app/turn-gateway.ts'
import { asConversationEventId } from '../src/kernel/contracts/ids.ts'
import { IMAGE_INPUT_LIMITS } from '../src/kernel/contracts/image-input.ts'

if (!process.env.LG_TEST_PG_URL) {
  await runPreparedPgGate('image-history', 'scripts/reminder-image-history-pg-verify.ts')
} else {
  const h = await createM4Harness({ label: 'image-history' })
  let checks = 0
  try {
    for (const mode of ['visible', 'withdrawn', 'incomplete', 'foreign', 'budget', 'recovery'] as const) {
      const gateway = new TurnGateway({ kernel: h.kernel, definition: h.kernel.definition, identity: h.kernel.identitySnapshot,
        recorder: h.recorder, conversationSequence: h.nextTurnSequence, slowPathEnabled: false, userId: h.userId, recentLimit: 64 })
      const text = '看看之前的图片'
      const turn = await gateway.beginTurn(text)
      const oldId = asConversationEventId('old-image-event')
      let loaded = 0
      const packet = await gateway.compileTurn({ turn, currentInput: text, recentLines: [],
        loadImageHistory: async () => [{ id: oldId, sequence: 1, createdAt: 1, speaker: 'fixture', text: '原图资料', actorType: 'user',
          conversationId: mode === 'foreign' ? 'another-room' : String(h.recorder.conversationId), imageRefs: ['image:fixture'] }],
        loadImage: async sourceRef => { loaded++; return { sourceRef, dataUrl: `data:image/png;base64,${mode === 'budget' ? 'A'.repeat(Math.ceil((IMAGE_INPUT_LIMITS.maxContextBytes + 1) * 4 / 3)) : 'AAAA'}` } },
        withdrawnMasking: { compute: async () => ({ ok: mode !== 'incomplete', withdrawnEventIds: mode === 'withdrawn' ? [oldId] : [],
          byReason: {}, gaps: mode === 'incomplete' ? ['fixture-gap'] : [], measuredCount: 1 }) },
      })
      const visible = mode === 'visible' || mode === 'recovery'
      assert.equal(packet.images?.length ?? 0, visible ? 1 : 0, mode)
      if (mode === 'foreign' || mode === 'withdrawn' || mode === 'incomplete') assert.equal(loaded, 0, mode)
      checks++
      await gateway.completeTurn({ turn, replyText: '隔离检查。' })
    }
    console.log(`PASS PostgreSQL gateway image history: ${checks} controls (visible, withdrawn, incomplete evidence, foreign conversation, budget, recovery)`)
  } finally { await h.stop() }
}
