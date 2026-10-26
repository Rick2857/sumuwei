/** Code snapshot for the EBL gates; excludes credentials and runtime data. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { EBL_POLICY, EBL_VERSION } from '../src/kernel/contracts/epistemic-belief.ts'
const files = [
  'src/kernel/contracts/epistemic-belief.ts', 'src/kernel/contracts/domain-event.ts', 'src/kernel/policies/validator.ts',
  'src/kernel/app/epistemic-belief-lifecycle/lifecycle.ts', 'src/kernel/app/epistemic-belief-lifecycle/human-policy.ts',
  'src/kernel/action/task-loop.ts', 'src/kernel/action/action-turn.ts',
  'src/kernel/app/flags.ts', 'src/main.ts', 'src/infrastructure/persistence/epistemic-belief-store.ts',
  'src/infrastructure/persistence/epistemic-belief-source.ts', 'src/infrastructure/runtime/epistemic-belief-runtime.ts',
  'src/infrastructure/runtime/epistemic-preference.ts', 'src/infrastructure/runtime/epistemic-human-context.ts',
  'src/infrastructure/runtime/adapters.ts', 'src/infrastructure/runtime/belief-scheduler.ts',
  'src/infrastructure/runtime/post-turn-model-memory.ts', 'src/infrastructure/model/langmem-memory-extractor.ts',
  'src/kernel/contracts/belief-renderer.ts', 'src/kernel/app/turn-gateway.ts',
  'src/infrastructure/action/adapters/sandbox-filesystem.ts', 'evals/epistemic-belief-lifecycle/fixtures.ts',
  'scripts/epistemic-belief-verify.ts', 'scripts/epistemic-belief-pg-verify.ts', 'scripts/epistemic-belief-evidence.ts',
  'scripts/epistemic-belief-human-verify.ts',
]
export function captureEblEvidenceSources() {
  return { processorVersion: EBL_VERSION, policyVersion: EBL_POLICY, measured_files: files.length,
    sourceSha256: Object.fromEntries(files.map(file => [file, createHash('sha256').update(readFileSync(file)).digest('hex')])) }
}
