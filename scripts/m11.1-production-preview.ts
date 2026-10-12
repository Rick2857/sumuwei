import 'dotenv/config'
import { isolateDatabase, PRODUCTION_DB_DIR } from '../src/dev/sandbox.ts'
const sandbox = isolateDatabase('m111-production-preview')
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { stringToUuid } from '@elizaos/core'
import { digestTree } from '../src/infrastructure/persistence/production-db-safety.ts'
import { createM4Harness } from './m4-harness.ts'
import { createM11RunId, openM11RunDir, writeM11Manifest } from './m11-evidence.ts'
import { listReflectionRecords } from '../src/infrastructure/persistence/reflection-store.ts'
import { listAdaptiveSelfStates } from '../src/infrastructure/persistence/adaptive-self-store.ts'
import { readReflectionSourceSnapshot } from '../src/infrastructure/persistence/reflection-source-read.ts'
import { readUsableAdaptiveSelfStates, readCurrentReflectionFactPack } from '../src/infrastructure/runtime/reflection-current-state.ts'
import { meetsStabilityThreshold } from '../src/kernel/app/reflection/inputs.ts'
import { planInvalidation } from '../src/kernel/app/reflection/invalidation.ts'
import { listJobs, getWatermark } from '../src/infrastructure/persistence/job-store.ts'
import { REFLECTION_PROCESSOR } from '../src/infrastructure/runtime/reflection-scheduler.ts'
import { REFLECTION_PROCESSOR_VERSION } from '../src/infrastructure/runtime/reflection-runner.ts'

async function main() {
  const started = new Date().toISOString()
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const runId = createM11RunId({ wpId: 'm111-production-preview', headShort: head })
  const dir = openM11RunDir(process.cwd(), runId, 'artifacts/m11.1')
  const privateDir = resolve('artifacts/m11.1/local', runId)
  execFileSync('git', ['check-ignore', '--quiet', privateDir])
  mkdirSync(privateDir, { recursive: true })
  // Only read filesystem bytes at the real path. All database opens target the copy.
  const before = digestTree(PRODUCTION_DB_DIR, [])
  cpSync(PRODUCTION_DB_DIR, sandbox.dir, { recursive: true })
  const copied = digestTree(sandbox.dir, [])
  const afterCopy = digestTree(PRODUCTION_DB_DIR, [])
  if (before.treeSha256 !== afterCopy.treeSha256 || copied.treeSha256 !== before.treeSha256) throw new Error('Source changed during filesystem copy; preview is invalid')
  const userId = stringToUuid(`user-${process.env.USER_NAME ?? 'Alex'}`)
  const h = await createM4Harness({ label: 'm111-production-preview', userId })
  let cleanClose = false
  const candidates: unknown[] = []
  let report: Record<string, unknown> = {}
  try {
    const characterId = h.kernel.characterId
    const records = await listReflectionRecords(h.db, characterId)
    const states = await listAdaptiveSelfStates(h.db, characterId)
    const usable = await readUsableAdaptiveSelfStates(h.db, characterId, userId)
    for (const record of records.filter(row => row.status === 'accepted' || row.status === 'pending')) {
      const snapshot = await readReflectionSourceSnapshot(h.db, characterId, record.roots.map(id => ({ id,
        kind: id.startsWith('cev:') ? 'conversation_event' as const : 'domain_event' as const,
      })), { activeUserId: userId })
      const stability = meetsStabilityThreshold({ rootCount: snapshot.roots.length, conversationCount: snapshot.conversationCount, unresolvedConflict: snapshot.unresolvedConflict })
      const invalidation = planInvalidation({ reflectionId: record.reflectionId, roots: snapshot.roots,
        rootVerdicts: snapshot.sourceVerdicts.map(row => ({ rootId: row.handleId, usable: row.usable, reason: row.reason })),
      })
      candidates.push({ reflectionId: record.reflectionId, status: record.status,
        recordedRootCount: record.rootCount, recordedConversationCount: record.conversationCount,
        measuredRootCount: snapshot.roots.length, measuredConversationCount: snapshot.conversationCount,
        currentUsable: snapshot.usable, stabilityMet: stability.met, unresolvedConflict: snapshot.unresolvedConflict,
        currentVerdicts: snapshot.sourceVerdicts, frozenLifecyclePlan: invalidation,
        disposition: invalidation.kind === 'invalidate' ? 'PREVIEW ONLY / existing lifecycle candidate' :
          !snapshot.usable || !stability.met ? 'BLOCK CURRENT USE / permanent disposition requires separate decision' : 'CURRENTLY QUALIFIED',
      })
    }
    const timings: number[] = []
    for (let i = 0; i < 40; i++) {
      const at = performance.now()
      await readUsableAdaptiveSelfStates(h.db, characterId, userId)
      timings.push(performance.now() - at)
    }
    timings.sort((a, b) => a - b)
    const body = JSON.stringify({ records, states, usable, candidates }, null, 2) + '\n'
    writeFileSync(join(privateDir, 'record-preview.json'), body)
    const jobs = (await listJobs(h.db, characterId)).filter(job => job.processor === REFLECTION_PROCESSOR)
    report = { recordCount: records.length, acceptedCount: records.filter(row => row.status === 'accepted').length,
      enhancedCount: states.filter(row => row.level === 'enhanced').length,
      currentlyUsableEnhancedCount: usable.filter(row => row.level === 'enhanced').length,
      candidates, jobs: jobs.map(job => ({ jobId: job.id, status: job.status, createdAt: job.createdAt })),
      watermark: await getWatermark(h.db, characterId, REFLECTION_PROCESSOR, REFLECTION_PROCESSOR_VERSION),
      currentFactPack: await readCurrentReflectionFactPack(h.db, characterId, userId),
      readerPerformance: { samples: 40, p95Ms: timings[37], scope: 'Current production-copy state count; no front-end/model latency claim' },
      configuration: { reflection: process.env.CHARACTER_REFLECTION_ENABLED, adaptive: process.env.CHARACTER_ADAPTIVE_SELF_ENABLED,
        tokens: process.env.CHARACTER_ADAPTIVE_SELF_TOKENS },
      configurationChanged: false, realDatabaseOpened: false, realDatabaseWrites: 0, copyUserMessagesWritten: 0,
      naturalFirstUse: 'NOT OBSERVED / this preview is not user traffic',
      privateBodySha256: createHash('sha256').update(body).digest('hex'),
    }
  } finally { await h.stop(); cleanClose = true }
  const after = digestTree(PRODUCTION_DB_DIR, [])
  const unchanged = before.treeSha256 === after.treeSha256
  writeFileSync(join(dir, 'preview.json'), JSON.stringify({ ...report, productionTreeBefore: before, productionTreeAfter: after, unchanged, cleanClose }, null, 2) + '\n')
  const paths = ['scripts/m11.1-production-preview.ts', 'src/infrastructure/runtime/reflection-current-state.ts', 'src/infrastructure/persistence/reflection-source-read.ts']
  writeM11Manifest(dir, { runId, wp: 'M11.1-WP8', head, headShort: head.slice(0, 12), branch: execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim(),
    date: new Date().toISOString().slice(0, 10), toolVersions: { node: process.version }, testType: 'production-copy-preview', phases: ['preview'], supersedes: null,
    started, ended: new Date().toISOString(), counts: { total: before.measuredCount, passed: unchanged ? before.measuredCount : 0, failed: unchanged ? 0 : before.measuredCount },
    verdict: unchanged ? 'PREVIEW COMPLETE / MAINTENANCE NOT APPLIED' : 'INVALID', cleanClose, plannedRequests: 0, actualRequests: 0,
    environment: 'production-filesystem-copy-only', capabilityImpact: 'NONE',
    sourceFingerprints: Object.fromEntries(paths.map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')])),
  })
  console.log(JSON.stringify({ runId, ...report, unchanged, cleanClose }, null, 2))
  process.exit(unchanged ? 0 : 1)
}
main().catch(error => { console.error(error); process.exit(1) })
