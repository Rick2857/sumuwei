import 'dotenv/config'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { readKernelFlags } from '../../src/kernel/app/flags.ts'
import { capabilityHealth } from '../../src/infrastructure/action/capability-health.ts'
const flags = readKernelFlags()
const configured: Record<string, boolean> = {
  'workflow.skill': flags.workflowSkillsEnabled, 'library.search': flags.personalLibraryEnabled,
  'document.read': flags.documentReadEnabled, 'office.generate': flags.officeGenerateEnabled,
  'math.calculate': flags.mathCalculateEnabled, 'research.arxiv': flags.arxivResearchEnabled,
  'image.ocr': flags.imageOcrEnabled, 'sandbox.file.read': flags.actionEnabled, 'sandbox.file.write': flags.actionEnabled,
}
const capabilities = Object.entries(configured).map(([id, on]) => ({ id, configured: on,
  ...(on ? capabilityHealth(id, { fresh: true, sandboxRoot: flags.actionSandboxRoot })
    : { ready: false, reason: 'configured_off' }) }))
const output = { kind: 'project-lg/local-capability-health', capturedAt: new Date().toISOString(),
  node: process.version, scope: 'local dependencies only; no authorization or remote service claim', capabilities }
const file = process.argv[2]
if (file) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(output, null, 2) + '\n') }
console.log(JSON.stringify(output, null, 2))
process.exitCode = capabilities.some(item => item.configured && !item.ready) ? 1 : 0
