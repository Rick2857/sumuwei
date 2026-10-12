import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createOpenAiReflectionDraftProvider, buildReflectionInstruction, buildReflectionUserMessage } from '../src/infrastructure/model/openai-reflection.ts'
import { parseReflectionDraft, REFLECTION_DRAFT_SCHEMA_VERSION, REFLECTION_DRAFT_SCOPE } from '../src/kernel/contracts/reflection.ts'
import type { ReflectionDraftCall } from '../src/kernel/app/reflection/draft-port.ts'
import { createM11RunId, openM11RunDir, writeM11Manifest } from './m11-evidence.ts'

const started = new Date().toISOString()
const checks: { id: string; pass: boolean }[] = []
const check = (id: string, pass: boolean) => checks.push({ id, pass })
const call: ReflectionDraftCall = { characterId: 'offline-provider-control', handles: [], window: [], counterHandles: [],
  triggerReasonCodes: [], deadlineMs: 20_000 }
const valid = { schemaVersion: REFLECTION_DRAFT_SCHEMA_VERSION, focusQuestion: '核对来源。', explanation: '暂无稳定处置依据。',
  supportHandles: [], counterHandles: [], scope: REFLECTION_DRAFT_SCOPE }
const env = { OPENAI_API_KEY: 'offline-control-only', OPENAI_BASE_URL: 'https://offline-control.invalid/v1', OPENAI_SMALL_MODEL: 'offline-control' }
const observations: { outcome: string; stage: string; failure: string | null; httpStatus: number | null; firstByteMs: number | null; durationMs: number }[] = []
let requests = 0
async function invoke(fetchImpl: typeof fetch, deadlineMs = 20_000) {
  const options = { env, fetchImpl, onObservation: (row: typeof observations[number]) => observations.push(row) }
  const provider = createOpenAiReflectionDraftProvider(options)
  try { return { returned: true, value: await provider.call({ ...call, deadlineMs }) } }
  catch { return { returned: false, value: undefined } }
}
const response = (content: unknown, status = 200) => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status })
const parsedExample = /输出形状示例：\n(\{[^\n]+\})/.exec(buildReflectionInstruction())?.[1]
check('complete-example-validates-against-native-contract', !!parsedExample && parseReflectionDraft(parsedExample, { handles: [] }).ok)
const sessionMessage = buildReflectionUserMessage({ ...call, sourceConversationCount: 2, window: [
  { id: 'root-a', kind: 'conversation_event', sourceClass: 'user_statement', revision: 1, fromTrigger: true, conversationId: 'private-session-a', text: '经历一' },
  { id: 'root-b', kind: 'conversation_event', sourceClass: 'user_statement', revision: 2, fromTrigger: true, conversationId: 'private-session-a', text: '经历二' },
  { id: 'root-c', kind: 'conversation_event', sourceClass: 'user_statement', revision: 3, fromTrigger: true, conversationId: 'private-session-b', text: '（已遮蔽：来源被遗忘或撤回）' },
  { id: 'unknown', kind: 'domain_event', sourceClass: 'internal_interpretation', revision: 4, fromTrigger: true, text: '程序事件' },
] })
check('session-aliases-group-real-sessions-without-identifiers', (sessionMessage.match(/来源会话S1/g) ?? []).length === 2 &&
  (sessionMessage.match(/来源会话S2/g) ?? []).length === 1 && !sessionMessage.includes('private-session-'))
check('unknown-session-is-not-invented-and-masked-text-is-preserved', sessionMessage.includes('internal_interpretation）：程序事件') &&
  sessionMessage.includes('来源会话S2）：（已遮蔽：来源被遗忘或撤回）'))
let requestBody: any
await invoke(async (_url, init) => { requests++; requestBody = JSON.parse(String(init?.body)); return response(JSON.stringify(valid)) })
check('one-request-json-object-mode', requests === 1 && requestBody.response_format.type === 'json_object')
check('success-observation-is-metadata-only', observations.length === 1 && observations[0]!.outcome === 'returned' &&
  observations[0]!.httpStatus === 200 && observations[0]!.firstByteMs !== null &&
  !JSON.stringify(observations).includes(env.OPENAI_API_KEY))
const unknown = await invoke(async () => { requests++; return response(JSON.stringify({ ...valid, type: 'object' })) })
const unknownParsed = parseReflectionDraft(JSON.stringify(unknown.value), { handles: [] })
check('unknown-field-is-preserved-and-rejected', unknown.returned && !unknownParsed.ok && unknownParsed.reason === 'draft_unknown_field')
const missing = await invoke(async () => { requests++; return response(JSON.stringify({ schemaVersion: valid.schemaVersion, focusQuestion: valid.focusQuestion })) })
const missingParsed = parseReflectionDraft(JSON.stringify(missing.value), { handles: [] })
check('missing-fields-are-not-repaired', missing.returned && !missingParsed.ok && missingParsed.reason === 'draft_empty')
const invalidJson = await invoke(async () => { requests++; return response('{invalid') })
check('invalid-json-remains-content-not-transport', invalidJson.returned && invalidJson.value === '{invalid')
const http = await invoke(async () => { requests++; return response('', 429) })
check('http-failure-is-distinguished', !http.returned && observations.at(-1)?.failure === 'http' && observations.at(-1)?.httpStatus === 429)
const network = await invoke(async () => { requests++; throw new Error('controlled-network-failure') })
check('network-failure-is-distinguished', !network.returned && observations.at(-1)?.failure === 'network' && observations.at(-1)?.firstByteMs === null)
const body = await invoke(async () => { requests++; return { ok: true, status: 200, async json() { throw new Error('controlled-body-failure') } } as unknown as Response })
check('body-failure-is-distinguished', !body.returned && observations.at(-1)?.failure === 'body' && observations.at(-1)?.stage === 'body')
const slowBody = await invoke(async () => { requests++; return { ok: true, status: 200, async json() { await new Promise(resolve => setTimeout(resolve, 50)); return {} } } as Response }, 5)
check('body-deadline-is-distinguished', !slowBody.returned && observations.at(-1)?.failure === 'deadline' && observations.at(-1)?.stage === 'body')
const observationCount = observations.length
await new Promise(resolve => setTimeout(resolve, 60))
check('late-body-does-not-produce-a-second-observation', observations.length === observationCount && observations.length === requests)
const recovered = await invoke(async () => { requests++; return response(JSON.stringify(valid)) })
check('recovery-after-failures', recovered.returned && observations.at(-1)?.outcome === 'returned' && observations.at(-1)?.failure === null)
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const runId = createM11RunId({ wpId: 'm111-provider-controls', headShort: head })
const dir = openM11RunDir(process.cwd(), runId, 'artifacts/m11.1')
writeFileSync(join(dir, 'checks.json'), JSON.stringify({ checks, mockedRequests: requests, observations }, null, 2) + '\n')
const paths = ['scripts/m11.1-provider-verify.ts', 'src/infrastructure/model/openai-reflection.ts', 'src/kernel/contracts/reflection.ts']
writeM11Manifest(dir, { runId, wp: 'M11.1-WP5', head, headShort: head.slice(0, 12), branch: execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim(),
  date: new Date().toISOString().slice(0, 10), toolVersions: { node: process.version }, testType: 'provider-offline-controls', phases: ['positive', 'negative', 'recovery'], supersedes: null,
  started, ended: new Date().toISOString(), counts: { total: checks.length, passed: checks.filter(c => c.pass).length, failed: checks.filter(c => !c.pass).length },
  cleanClose: true, environment: 'offline-mock-no-database', plannedRequests: 0, actualRequests: 0, capabilityImpact: 'NONE',
  sourceFingerprints: Object.fromEntries(paths.map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')])) })
console.log(JSON.stringify({ runId, checks, actualRequests: 0 }))
process.exit(checks.every(c => c.pass) ? 0 : 1)
