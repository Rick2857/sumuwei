import 'dotenv/config'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseReflectionDraft } from '../src/kernel/contracts/reflection.ts'
import { createOpenAiReflectionDraftProvider, type ReflectionProviderObservation } from '../src/infrastructure/model/openai-reflection.ts'
import { diagnoseSemantic } from './m11.1-semantic-diagnostics.ts'
import type { ReflectionDraftCall } from '../src/kernel/app/reflection/draft-port.ts'
import { scoreSemantic, type SemanticReading } from './m11.1-measurement.ts'
import { createM11RunId, openM11RunDir, writeM11Manifest } from './m11-evidence.ts'
import { openM111ModelBatch } from './m11.1-model-batch.ts'

interface Item {
  caseId: string; family: string; sources: { id: string; conversationId: string; sourceClass: 'user_statement' | 'assistant_speech'; text: string }[]
  gold: { adopt: boolean; slot: string | null; supportIds: string[]; counterIds: string[] }
}
async function main() {
  const repairProbe = process.argv.includes('--repair-probe')
  const probe = process.argv.includes('--probe') || repairProbe
  const confirmation = process.argv.includes('--confirm-json-v5')
  if (probe && confirmation) throw new Error('Development probe and formal confirmation are distinct batches')
  const root = resolve('artifacts/m11.1/local/corpus-proposed-v1')
  const status = JSON.parse(readFileSync(join(root, 'review-status.json'), 'utf8')) as {
    status: string; reviewer: string | null; reviewedAt: string | null; semanticSha256: string; behaviorSha256: string
  }
  const corpusBytes = readFileSync(join(root, 'semantic.json'))
  const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
  // Approval is an independent input, not something the running agent synthesizes.
  if (status.status !== 'FROZEN / HUMAN REVIEWED' || !status.reviewer || !status.reviewedAt || sha(corpusBytes) !== status.semanticSha256 || sha(readFileSync(join(root, 'behavior.json'))) !== status.behaviorSha256) throw new Error('Independent corpus review/fingerprint freeze required before the formal batch')
  if (process.env.DSH_TEST_MODEL_WRAPPER !== '1') throw new Error('Run through with-test-model; do not fall back to the production endpoint')
  const confirmationRoot = resolve('artifacts/m11.1/local/json-v5-confirmation-20261003')
  const decisionId = 'M111-JSON-V5-CONFIRMATION-20261003'
  if (confirmation) {
    const decision = JSON.parse(readFileSync(join(confirmationRoot, 'decision.json'), 'utf8'))
    if (decision.status !== 'APPROVED BY USER' || decision.decisionId !== decisionId || decision.maxRequests !== 480 ||
      decision.semanticSha256 !== status.semanticSha256 || decision.promptVersion !== 'reflection-prompt@5' ||
      decision.providerSha256 !== sha(readFileSync('src/infrastructure/model/openai-reflection.ts'))) {
      throw new Error('Separate user approval of the frozen JSON v5 confirmation is required; zero requests started')
    }
  }
  const corpus = JSON.parse(corpusBytes.toString('utf8')) as Item[]
  if (corpus.length !== 160 || new Set(corpus.map(i => i.caseId)).size !== 160) throw new Error('D-02 requires exactly 160 distinct semantic cases')
  // Known failed corpus is development input now; this bounded probe is never new blind evidence.
  const repairIds = ['m111-sem-0-11', 'm111-sem-0-15', 'm111-sem-1-5', 'm111-sem-1-12', 'm111-sem-2-4', 'm111-sem-2-9',
    'm111-sem-risk-0-1', 'm111-sem-risk-0-2', 'm111-sem-risk-1-1', 'm111-sem-risk-1-2',
    'm111-sem-risk-2-1', 'm111-sem-risk-2-2', 'm111-sem-risk-3-1', 'm111-sem-risk-3-11', 'm111-sem-risk-4-1', 'm111-sem-risk-4-2']
  const items = repairProbe ? repairIds.map(id => {
    const item = corpus.find(row => row.caseId === id)
    if (!item) throw new Error(`Frozen repair probe case missing: ${id}`)
    return item
  }) : probe ? [...new Set(corpus.map(item => item.family))].flatMap(family => {
    const group = corpus.filter(item => item.family === family)
    return [group[0]!, group[family === 'scope-and-insufficient' ? 10 : 1]!]
  }) : corpus
  const rounds = probe ? 1 : 3
  const started = new Date().toISOString()
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const runId = createM11RunId({ wpId: probe ? 'm111-semantic-probe' : 'm111-semantic', headShort: head })
  const privateDir = join(resolve('artifacts/m11.1/local'), runId)
  execFileSync('git', ['check-ignore', '--quiet', privateDir])
  mkdirSync(privateDir, { recursive: true })
  const provider = createOpenAiReflectionDraftProvider()
  const batch = openM111ModelBatch({ semantic: status.semanticSha256, behavior: status.behaviorSha256 },
    confirmation ? confirmationRoot : undefined, confirmation ? decisionId : undefined)
  const readings: SemanticReading[] = []
  const diagnostics: unknown[] = []
  let requests = 0
  for (let round = 1; round <= rounds; round++) {
    let cursor = 0
    await Promise.all(Array.from({ length: 4 }, async () => {
      for (;;) {
        const item = items[cursor++]
        if (!item) break
        const call: ReflectionDraftCall = {
          characterId: 'm111-semantic-isolated', deadlineMs: 20_000, triggerReasonCodes: ['trigger_explicit_correction'], counterHandles: [],
          sourceConversationCount: new Set(item.sources.map(source => source.conversationId)).size,
          handles: item.sources.map(s => ({ id: s.id, kind: 'conversation_event' })),
          window: item.sources.map((s, i) => ({ id: s.id, kind: 'conversation_event', revision: i + 1, sourceClass: s.sourceClass,
            fromTrigger: true, conversationId: s.conversationId, text: s.text })),
        }
        const at = performance.now()
        let raw: unknown = null, transportFailed = false
        const finishReservation = await batch.reserveWhenAvailable(probe ? 'short' : 'semantic', `${probe ? `${provider.promptVersion}-${repairProbe ? 'repair' : 'development'}-probe:` : ''}${item.caseId}:round:${round}`)
        requests++
        let observation: ReflectionProviderObservation | null = null
        const caseProvider = createOpenAiReflectionDraftProvider({ onObservation: row => { observation = row } })
        try { raw = await caseProvider.call(call) } catch { transportFailed = true }
        finishReservation(transportFailed ? 'transport_failed' : 'returned')
        const parsed = transportFailed ? { ok: false as const } : parseReflectionDraft(typeof raw === 'string' ? raw : JSON.stringify(raw), { handles: call.handles })
        const ids = new Set(call.handles.map(h => h.id))
        const referencesCorrect = parsed.ok && [...parsed.draft.supportHandles, ...parsed.draft.counterHandles].every(id => ids.has(id)) &&
          item.gold.counterIds.every(id => parsed.draft.counterHandles.includes(id)) &&
          (!item.gold.adopt || (parsed.draft.suggestedSlot === item.gold.slot && item.gold.supportIds.every(id => parsed.draft.supportHandles.includes(id))))
        const row: SemanticReading = { caseId: item.caseId, round, goldAdopt: item.gold.adopt,
          modelAdopt: parsed.ok && parsed.draft.suggestedSlot !== undefined,
          formatValid: parsed.ok, transportFailed, referencesCorrect }
        readings.push(row)
        const diagnostic = { caseId: item.caseId, round, ...diagnoseSemantic(parsed, item.gold, transportFailed), observation }
        diagnostics.push(diagnostic)
        // Private body stays available for audit; public evidence includes only metadata and hashes.
        const body = JSON.stringify({ caseId: item.caseId, round, raw, parsed, row, diagnostic, latencyMs: performance.now() - at }, null, 2) + '\n'
        writeFileSync(join(privateDir, `${item.caseId}-r${round}.json`), body)
      }
    }))
    console.log(JSON.stringify({ runId, round, planned: items.length, actual: readings.filter(r => r.round === round).length }))
  }
  readings.sort((a, b) => a.round - b.round || a.caseId.localeCompare(b.caseId))
  const result = scoreSemantic(readings, items.map(i => i.caseId), rounds)
  const exactPassed = readings.filter(r => r.formatValid && r.referencesCorrect && r.modelAdopt === r.goldAdopt).length
  const dir = openM11RunDir(process.cwd(), runId, 'artifacts/m11.1')
  writeFileSync(join(dir, 'metrics.json'), JSON.stringify(result, null, 2) + '\n')
  writeFileSync(join(dir, 'readings.json'), JSON.stringify(readings, null, 2) + '\n')
  writeFileSync(join(dir, 'diagnostics.json'), JSON.stringify(diagnostics, null, 2) + '\n')
  const paths = ['scripts/m11.1-semantic-eval.ts', 'scripts/m11.1-semantic-diagnostics.ts', 'scripts/m11.1-measurement.ts', 'src/infrastructure/model/openai-reflection.ts', 'docs/m11.1/M11.1-Acceptance-Contract.md']
  writeM11Manifest(dir, { runId, wp: 'M11.1-WP5', head, headShort: head.slice(0, 12), branch: execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim(), date: new Date().toISOString().slice(0, 10),
    toolVersions: { node: process.version }, testType: probe ? 'development-semantic-probe' : confirmation ? 'formal-known-corpus-semantic' : 'formal-independent-semantic', phases: [probe ? 'development' : 'formal'], supersedes: null,
    started, ended: new Date().toISOString(), counts: { total: items.length * rounds, passed: exactPassed,
      failed: readings.filter(r => !(r.formatValid && r.referencesCorrect && r.modelAdopt === r.goldAdopt)).length },
    plannedRequests: items.length * rounds, actualRequests: requests, initialBatchCalls: batch.count(), semanticCaseCount: items.length, rounds,
    verdict: probe ? exactPassed === items.length ? 'DEVELOPMENT PROBE PASS' : 'DEVELOPMENT PROBE FAIL' : result.status,
    cleanClose: true, environment: 'test-model-no-database', capabilityImpact: 'NONE',
    model: process.env.OPENAI_SMALL_MODEL, endpointHost: new URL(process.env.OPENAI_BASE_URL!).host,
    promptVersion: provider.promptVersion,
    ...(repairProbe ? { developmentSelection: 'frozen-repair-probe@1', developmentCaseIds: repairIds } : {}),
    ...(confirmation ? { confirmationDecisionId: decisionId, knownCorpusConfirmation: true, batchLimit: 480 } : {}),
    corpusSha256: status.semanticSha256, reviewStatusSha256: sha(readFileSync(join(root, 'review-status.json'))),
    sourceFingerprints: Object.fromEntries(paths.map(path => [path, sha(readFileSync(path))])),
    limitation: probe ? '16 known development cases, one round. Not a formal G5 run, independent blind corpus, or new approval of the old FAIL.' : confirmation ? '160 known cases x 3 confirmation, not a new blind corpus. All failures retain the original denominator; no model retries.' : 'Support/slot/counter annotations measure structured semantic selection; unrestricted explanation entailment is not mechanically verified.' })
  console.log(JSON.stringify({ runId, result }, null, 2))
  process.exit(probe ? exactPassed === items.length ? 0 : 1 : result.status === 'PASS' ? 0 : 1)
}
main().catch(error => { console.error(error); process.exit(1) })
