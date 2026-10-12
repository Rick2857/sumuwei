import 'dotenv/config'
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { digestTree } from '../src/infrastructure/persistence/production-db-safety.ts'
import { cleanupSandbox } from '../src/dev/sandbox.ts'
import { validateReviewCards, type ReviewCard } from './m11.1-measurement.ts'
import { createM11RunId, openM11RunDir, writeM11Manifest } from './m11-evidence.ts'
import { runM111PrivateWorker } from './m11.1-private-worker.ts'

interface Item { caseId: string; slot: string; class: string; followup: string; preparation?: string[] }
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
async function main() {
  const control = process.argv.includes('--control')
  if (!control && process.env.DSH_TEST_MODEL_WRAPPER !== '1') throw new Error('Run through with-test-model')
  const corpusRoot = resolve('artifacts/m11.1/local/corpus-proposed-v1')
  const status = JSON.parse(readFileSync(join(corpusRoot, 'review-status.json'), 'utf8'))
  const bytes = readFileSync(join(corpusRoot, 'behavior.json'))
  if (status.status !== 'FROZEN / HUMAN REVIEWED' || !status.reviewer || sha(bytes) !== status.behaviorSha256 || sha(readFileSync(join(corpusRoot, 'semantic.json'))) !== status.semanticSha256) throw new Error('Independent corpus freeze required')
  const all = JSON.parse(bytes.toString('utf8')) as Item[]
  if (all.length !== 90 || new Set(all.map(item => item.caseId)).size !== 90) throw new Error('D-02 corpus mismatch')
  const eligible = all.filter(item => item.slot !== 'recheck_goal_before_next_step')
  const selected = control ? [eligible.find(item => item.class === 'legal')!, eligible.find(item => item.class === 'withdrawn')!, eligible.find(item => item.class === 'authority')!] : eligible
  const started = new Date().toISOString()
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const runId = createM11RunId({ wpId: control ? 'm111-behavior-control' : 'm111-behavior-core', headShort: head })
  const privateDir = resolve('artifacts/m11.1/local', runId)
  execFileSync('git', ['check-ignore', '--quiet', privateDir])
  mkdirSync(privateDir, { recursive: true })
  const cards: (ReviewCard & Record<string, any>)[] = []
  const checks: { caseId: string; pass: boolean }[] = []
  const worker = (mode: 'seed' | 'arm', id: string, input: string, output: string, arm: string) => runM111PrivateWorker(mode, id, input, output, arm, control)
  // Each pair is branched from exactly the same closed database, including immutable source IDs.
  const pairs = selected.flatMap(item => (control ? [1] : [1, 2]).map(round => ({ item, round })))
  let cursor = 0
  // Three independent pairs; each arm within its pair remains sequential. Reservations serialize under the shared cap.
  const settlements = await Promise.allSettled(Array.from({ length: 3 }, async () => {
    for (;;) {
      const pair = pairs[cursor++]
      if (!pair) break
      const { item, round } = pair
      const preparation = item.preparation ?? all.find(row => row.slot === item.slot && row.class === 'legal')!.preparation!
      const id = `pair-${randomBytes(6).toString('hex')}`
      const baseline = join(tmpdir(), `project-lg-exp-m111-behavior-${id}`)
      const inputPath = join(privateDir, `${id}-input.json`)
      const seedPath = join(privateDir, `${id}-seed.json`)
      const input = { ...item, preparation, round, semanticSha256: status.semanticSha256, behaviorSha256: status.behaviorSha256 }
      writeFileSync(inputPath, JSON.stringify(input))
      try {
        const seeded = await worker('seed', id, inputPath, seedPath, 'A')
        if (seeded.exitCode !== 0 || !seeded.output.cleanClose) throw new Error(`Baseline seed failed for ${item.caseId}; no pair is silently omitted`)
        const baselineFingerprint = digestTree(baseline, []).treeSha256
        writeFileSync(inputPath, JSON.stringify({ ...input, ...seeded.output, baselineFingerprint }))
        for (const arm of ['A', 'B', 'C'] as const) {
          const armId = `${id}-${arm.toLowerCase()}`
          const armDir = join(tmpdir(), `project-lg-exp-m111-behavior-${armId}`)
          const output = join(privateDir, `${armId}-reply.json`)
          try {
            cpSync(baseline, armDir, { recursive: true })
            if (digestTree(armDir, []).treeSha256 !== baselineFingerprint) throw new Error('Pair copy drift')
            const observed = await worker('arm', armId, inputPath, output, arm)
            const body: Record<string, any> = { ...observed.output, workerExitCode: observed.exitCode }
            // A failure still occupies its planned identity; it cannot enter valid review cards.
            cards.push({ caseId: `${item.caseId}:r${round}:${arm}`, corpusCaseId: item.caseId, pairId: `${item.caseId}:r${round}`,
              arm, round, slot: item.slot, class: item.class, legal: item.class === 'legal', scenario: item.followup,
              reply: '', replySha256: sha(''), traceId: '', databaseId: armId, baselineFingerprint,
              eventIds: [], packetRefs: [], rootIds: [], conversationIds: [], completed: false, liveReply: false, ...body })
            if (control) {
              const enhanced = body.states?.some((state: any) => state.level === 'enhanced')
              const expectedActive = arm === 'C' && item.class === 'legal'
              checks.push({ caseId: `${item.caseId}:${arm}`, pass: observed.exitCode === 0 && body.cleanClose && body.completed &&
                (arm !== 'C' ? body.packetRefs.length === 0 : expectedActive ? body.packetRefs.length > 0 && enhanced : body.packetRefs.length === 0 && !enhanced) })
            }
          } finally { cleanupSandbox(armDir) }
        }
      } finally { cleanupSandbox(baseline) }
      console.log(JSON.stringify({ runId, pair: item.caseId, round, replies: cards.length, mode: control ? 'offline-controls' : 'live-core-slots' }))
    }
  }))
  const interruptions = settlements.flatMap(result => result.status === 'rejected' ? [String(result.reason?.message ?? 'worker failed')] : [])
  for (const { item, round } of pairs) for (const arm of ['A', 'B', 'C'] as const) {
    const caseId = `${item.caseId}:r${round}:${arm}`
    if (!cards.some(card => card.caseId === caseId)) cards.push({ caseId, corpusCaseId: item.caseId, pairId: `${item.caseId}:r${round}`, arm, round, slot: item.slot,
      class: item.class, legal: item.class === 'legal', scenario: item.followup, reply: '', replySha256: sha(''), traceId: '',
      databaseId: `NOT RUN:${caseId}`, baselineFingerprint: 'NOT RUN', eventIds: [], packetRefs: [], rootIds: [], conversationIds: [],
      completed: false, liveReply: false, cleanClose: false, notRun: true })
  }
  cards.sort((a, b) => a.caseId.localeCompare(b.caseId))
  writeFileSync(join(privateDir, 'cards.json'), JSON.stringify(cards, null, 2) + '\n')
  const integrity = validateReviewCards(cards)
  if (control) checks.push({ caseId: 'paired-ledger-card-integrity', pass: integrity.valid && interruptions.length === 0 })
  const dir = openM11RunDir(process.cwd(), runId, 'artifacts/m11.1')
  const metadata = cards.map(card => ({ caseId: card.caseId, corpusCaseId: card.corpusCaseId, arm: card.arm, round: card.round,
    completed: card.completed, cleanClose: card.cleanClose, preparationRequests: card.preparationRequests ?? 0,
    dialogueRequests: card.dialogueRequests ?? 0, traceId: card.traceId, replySha256: card.replySha256,
    baselineFingerprint: card.baselineFingerprint, databaseId: card.databaseId, eventIds: card.eventIds, packetRefs: card.packetRefs }))
  writeFileSync(join(dir, 'readings.json'), JSON.stringify({ metadata, checks, integrity }, null, 2) + '\n')
  const paths = ['scripts/m11.1-behavior-collect.ts', 'scripts/m11.1-behavior-worker.ts', 'scripts/m11.1-private-worker.ts', 'src/infrastructure/persistence/reflection-input-source.ts', 'src/kernel/app/reflection/job.ts', 'src/infrastructure/runtime/reflection-runtime.ts', 'src/infrastructure/runtime/reflection-current-state.ts', 'src/infrastructure/runtime/reflection-runner.ts', 'src/infrastructure/persistence/reflection-source-read.ts', 'src/infrastructure/model/openai-reflection.ts', 'scripts/m11.1-measurement.ts']
  writeM11Manifest(dir, { runId, wp: 'M11.1-WP5', head, headShort: head.slice(0, 12), branch: execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim(),
    date: new Date().toISOString().slice(0, 10), toolVersions: { node: process.version }, testType: control ? 'behavior-collector-offline-controls' : 'formal-behavior-core-collected', phases: control ? ['positive', 'negative', 'recovery'] : ['collect'], supersedes: null,
    started, ended: new Date().toISOString(), counts: { total: control ? checks.length : cards.length, passed: control ? checks.filter(row => row.pass).length : cards.filter(card => card.completed).length,
      failed: control ? checks.filter(row => !row.pass).length : cards.filter(card => !card.completed).length },
    verdict: control ? checks.every(row => row.pass) ? 'PASS' : 'FAIL' : 'COLLECTED / UNSCORED / GOAL SLOT NOT RUN',
    plannedRequests: control ? 0 : 600, plannedDialogueRequests: control ? 0 : 360, maxPreparationRequests: control ? 0 : 240,
    actualRequests: cards.reduce((n, card) => n + (card.dialogueRequests ?? 0) + (card.preparationRequests ?? 0), 0), interruptions,
    completedBehaviorRequests: cards.filter(card => card.liveReply).length, fullD02BehaviorDenominator: 540, missingGoalSlotRequests: control ? 0 : 180,
    scorerStatus: 'NOT SCORED', cleanClose: cards.every(card => card.cleanClose), environment: control ? 'isolated-offline' : 'isolated-test-model', capabilityImpact: 'NONE',
    behaviorCorpusSha256: status.behaviorSha256, semanticCorpusSha256: status.semanticSha256,
    privateCardsSha256: sha(readFileSync(join(privateDir, 'cards.json'))), sourceFingerprints: Object.fromEntries(paths.map(path => [path, sha(readFileSync(path))])),
    limitation: 'Other state evaluators disabled; goal slot awaits M10.1 WP4. Reply collection and program injection are not behavior correctness scores.' })
  console.log(JSON.stringify({ runId, privateCards: join(privateDir, 'cards.json'), integrity, checks }, null, 2))
  process.exit(control && !checks.every(row => row.pass) ? 1 : 0)
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Collector failed'); process.exit(1) })
