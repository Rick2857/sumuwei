import 'dotenv/config'
import { isolateDatabase, PRODUCTION_DB_DIR } from '../src/dev/sandbox.ts'
const sandbox = isolateDatabase('m111-privacy-performance')
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stringToUuid } from '@elizaos/core'
import { sql } from 'drizzle-orm'
import { createM4Harness } from './m4-harness.ts'
import { digestTree } from '../src/infrastructure/persistence/production-db-safety.ts'
import { ConversationRecorder } from '../src/infrastructure/runtime/conversation-recorder.ts'
import { createHumanConsoleUserTurnIngress, createCharacterAssistantTurnIngress } from '../src/infrastructure/runtime/conversation-attribution.ts'
import { asConversationId } from '../src/kernel/contracts/ids.ts'
import { appendDomainEvent } from '../src/infrastructure/persistence/event-store.ts'
import { latestDomainEventSequence } from '../src/infrastructure/persistence/reflection-input-source.ts'
import { runReflectionWindow } from '../src/infrastructure/runtime/reflection-runner.ts'
import { readReflectionSourceSnapshot } from '../src/infrastructure/persistence/reflection-source-read.ts'
import { readUsableAdaptiveSelfStates, readCurrentReflectionFactPack } from '../src/infrastructure/runtime/reflection-current-state.ts'
import { createOpenAiReflectionDraftProvider } from '../src/infrastructure/model/openai-reflection.ts'
import { REFLECTION_DRAFT_SCHEMA_VERSION, REFLECTION_DRAFT_SCOPE, REFLECTION_SLOTS } from '../src/kernel/contracts/reflection.ts'
import { TurnGateway } from '../src/kernel/app/turn-gateway.ts'
import { DEFAULT_CONTEXT_BUDGET } from '../src/kernel/recall/selector.ts'
import { getTrace } from '../src/infrastructure/persistence/trace-store.ts'
import { createM11RunId, openM11RunDir, writeM11Manifest } from './m11-evidence.ts'

async function main() {
  const started = new Date().toISOString()
  const before = digestTree(PRODUCTION_DB_DIR, [])
  cpSync(PRODUCTION_DB_DIR, sandbox.dir, { recursive: true })
  if (digestTree(sandbox.dir, []).treeSha256 !== before.treeSha256 || digestTree(PRODUCTION_DB_DIR, []).treeSha256 !== before.treeSha256) throw new Error('Copy drift; no database opened at real path')
  const h = await createM4Harness({ label: 'm111-privacy-performance', userId: stringToUuid(`user-${process.env.USER_NAME ?? 'Alex'}`) })
  const characterId = h.kernel.characterId
  const checks: { caseId: string; pass: boolean; observed?: unknown }[] = []
  const check = (caseId: string, pass: boolean, observed?: unknown) => checks.push({ caseId, pass, observed })
  const canary = 'M111_PRIVATE_SOURCE_CANARY_a217'
  const roots: string[] = []
  const recorders = [0, 1].map(i => new ConversationRecorder({ db: h.db, characterId, conversationId: asConversationId(`m111-performance-${i}`),
    userId: h.userId, userName: 'Alex', characterName: '苏沐薇', transport: 'm111-isolated-control', dryRun: false,
    attribution: [createHumanConsoleUserTurnIngress(), createCharacterAssistantTurnIngress()] }))
  let slot: string = REFLECTION_SLOTS[0]!
  let mockedCalls = 0
  const envelopes: { method: string; destination: string; fields: string[]; roles: string[]; jsonObjectMode: boolean; hasCanary: boolean }[] = []
  const provider = createOpenAiReflectionDraftProvider({ env: { OPENAI_API_KEY: 'offline-control', OPENAI_BASE_URL: 'https://offline-control.invalid/v1', OPENAI_SMALL_MODEL: 'offline-control' },
    fetchImpl: (async (url, init) => {
      mockedCalls++
      const body = JSON.parse(String(init?.body))
      envelopes.push({ method: String(init?.method), destination: String(url), fields: Object.keys(body).sort(),
        jsonObjectMode: body.response_format?.type === 'json_object' && Object.keys(body.response_format).length === 1,
        roles: body.messages.map((message: any) => message.role), hasCanary: JSON.stringify(body).includes(canary) })
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ schemaVersion: REFLECTION_DRAFT_SCHEMA_VERSION,
        scope: REFLECTION_DRAFT_SCOPE, focusQuestion: '隔离来源边界控制', explanation: '控制候选，无原文。', supportHandles: roots, counterHandles: [], suggestedSlot: slot }) } }] }), { status: 200 })
    }) as typeof fetch })
  let cleanClose = false
  let scale: unknown
  try {
    for (let i = 0; i < 3; i++) {
      const recorded = await recorders[i % 2]!.recordUserMessage(`隔离合法反馈：${canary}；对象含糊时先核对。`, Math.floor(i / 2) + 1)
      roots.push(String(recorded.event!.id))
    }
    const trigger = async (identity: string) => {
      const watermark = await latestDomainEventSequence(h.db, characterId)
      await appendDomainEvent(h.db, characterId, { type: 'GOAL_COMPLETED', operation: 'm111-privacy-fixture',
        payload: { goalId: `goal:privacy-fixture:${identity}`, basis: 'user_report', expectedRevision: 1 }, sourceConversationEventIds: roots as never,
        idempotencyKey: identity, processor: 'm111-privacy-fixture', processorVersion: 'm111-privacy@1', scope: 'CHARACTER_INTERNAL' })
      return watermark
    }
    for (const candidate of REFLECTION_SLOTS) {
      slot = candidate
      const result = await runReflectionWindow(h.db, { characterId, activeUserId: h.userId, watermark: await trigger(candidate), adaptiveEnabled: true, provider })
      check(`nonzero-enhancement-${candidate}`, result.kind === 'accepted' && result.eventsWritten === 3)
    }
    check('mock-outbound-positive-reads-qualified-body', mockedCalls === 3 && envelopes.every(row => row.hasCanary))
    check('json-mode-outbound-envelope', envelopes.every(row => row.method === 'POST' && row.destination === 'https://offline-control.invalid/v1/chat/completions' &&
      JSON.stringify(row.fields) === JSON.stringify(['messages', 'model', 'response_format', 'temperature']) && row.jsonObjectMode &&
      JSON.stringify(row.roles) === JSON.stringify(['system', 'user'])), envelopes.map(({ hasCanary, ...row }) => row))
    const timings: number[] = []
    for (let i = 0; i < 40; i++) {
      const at = performance.now()
      await readReflectionSourceSnapshot(h.db, characterId, roots.map(id => ({ id, kind: 'conversation_event' })), { activeUserId: h.userId })
      timings.push(performance.now() - at)
    }
    timings.sort((a, b) => a - b)
    check('production-profile-source-p95', timings[37]! <= 50, { samples: 40, p95Ms: timings[37], effectiveRoots: 3, conversations: 2 })
    const compile = async (enabled: boolean) => {
      const gateway = new TurnGateway({ kernel: h.kernel, definition: h.kernel.definition, identity: h.kernel.identitySnapshot, recorder: h.recorder,
        conversationSequence: h.nextTurnSequence, recentLimit: 16, slowPathEnabled: false, userId: h.userId,
        recallBudget: { ...DEFAULT_CONTEXT_BUDGET, adaptiveSelfTokens: enabled ? 300 : 0 } })
      const turn = await gateway.beginTurn('隔离性能控制：核对当前对象。')
      const at = performance.now()
      const packet = await gateway.compileTurn({ turn, currentInput: '隔离性能控制：核对当前对象。', recentLines: [],
        ...(enabled ? { buildAdaptiveSelfStates: () => readUsableAdaptiveSelfStates(h.db, characterId, h.userId),
          buildReflectionFactPack: () => readCurrentReflectionFactPack(h.db, characterId, h.userId) } : {}) })
      const duration = performance.now() - at
      await gateway.completeTurn({ turn, replyText: '隔离占位回复，不作行为评分。', modelDurationMs: 0 })
      const trace = await getTrace(h.db, turn.traceId)
      const metadata = JSON.stringify({ trace, sections: packet.sections, fact: await readCurrentReflectionFactPack(h.db, characterId, h.userId) })
      return { duration, refs: packet.sections.filter(row => row.id === 'adaptive-self').flatMap(row => row.sourceRefs ?? []), leaked: metadata.includes(canary) }
    }
    const added: number[] = []
    for (let i = 0; i < 20; i++) {
      const order = i % 2 === 0 ? [false, true] : [true, false]
      const measured = []
      for (const enabled of order) measured.push({ enabled, ...await compile(enabled) })
      // Both sides use the same database/profile. No model latency is included.
      const on = measured.find(row => row.enabled)!, off = measured.find(row => !row.enabled)!
      check(`actual-packet-and-trace-${i}`, on.refs.length > 0 && on.refs.length <= 3 && off.refs.length === 0 && !on.leaked && !off.leaked,
        { actualUsedRefs: on.refs.length, configuredEnhancedSlots: 3 })
      added.push(on.duration - off.duration)
    }
    added.sort((a, b) => a - b)
    check('production-profile-front-added-p95', added[18]! <= 100, { samples: 20, p95AdditionalMs: added[18], enhancedSlots: 3, budget: 300 })
    // Corrupt only this copy's presenter identity, retaining the original attested origin.
    await h.db.execute(sql`update conversation_events set actor_id = 'another-user' where id = ${roots[0]!}`)
    const callsBefore = mockedCalls
    const blocked = await runReflectionWindow(h.db, { characterId, activeUserId: h.userId, watermark: await trigger('foreign-root'), adaptiveEnabled: true, provider })
    check('unqualified-root-never-outbound', mockedCalls === callsBefore && blocked.kind !== 'accepted')
    check('unavailable-root-blocks-current-packet', (await compile(true)).refs.length === 0)
    await h.db.execute(sql`update conversation_events set actor_id = ${h.userId} where id = ${roots[0]!}`)
    check('qualification-control-restored', (await compile(true)).refs.length > 0)
    scale = await h.db.execute(sql`select (select count(*) from memory_records) as memories, (select count(*) from conversation_events) as conversations,
      (select count(*) from character_domain_events) as domain_events`)
  } finally { await h.stop(); cleanClose = true }
  const after = digestTree(PRODUCTION_DB_DIR, [])
  check('real-tree-unchanged-including-volatile-files', after.treeSha256 === before.treeSha256, { before, after })
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const runId = createM11RunId({ wpId: 'm111-privacy-performance', headShort: head })
  const dir = openM11RunDir(process.cwd(), runId, 'artifacts/m11.1')
  writeFileSync(join(dir, 'checks.json'), JSON.stringify({ checks, scale, mockedCalls, realOutboundRequests: 0 }, null, 2) + '\n')
  const paths = ['scripts/m11.1-privacy-performance.ts', 'src/infrastructure/persistence/reflection-source-read.ts', 'src/infrastructure/runtime/reflection-runner.ts',
    'src/infrastructure/runtime/reflection-current-state.ts', 'src/infrastructure/model/openai-reflection.ts', 'src/kernel/app/turn-gateway.ts']
  writeM11Manifest(dir, { runId, wp: 'M11.1-WP7', head, headShort: head.slice(0, 12), branch: execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim(),
    date: new Date().toISOString().slice(0, 10), toolVersions: { node: process.version }, testType: 'production-profile-privacy-performance', phases: ['positive', 'negative', 'recovery'], supersedes: null,
    started, ended: new Date().toISOString(), counts: { total: checks.length, passed: checks.filter(row => row.pass).length, failed: checks.filter(row => !row.pass).length },
    cleanClose, plannedRequests: 0, actualRequests: 0, environment: 'production-copy-offline-mock-fetch', capabilityImpact: 'NONE',
    sourceFingerprints: Object.fromEntries(paths.map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')])),
    limitation: 'Current copied history plus three synthetic roots/two sessions/three enhanced slots. Mock fetch makes no network requests; no dialogue scoring or natural first-use claim.' })
  console.log(JSON.stringify({ runId, checks: checks.map(({ caseId, pass }) => ({ caseId, pass })), cleanClose }, null, 2))
  process.exit(checks.every(row => row.pass) ? 0 : 1)
}
main().catch(error => { console.error(error); process.exit(1) })
