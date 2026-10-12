/** Configuration/asset readback only. No database or model is opened. */
import 'dotenv/config'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { readKernelFlags } from '../src/kernel/app/flags.ts'
import { loadWorkflowSkills } from '../src/infrastructure/action/adapters/workflow-skill.ts'
import { PERSONAL_LIBRARY_ROOT } from '../src/infrastructure/action/adapters/personal-library.ts'
import { verifyArxivRuntimeSync, ARXIV_RUNTIME } from '../src/infrastructure/action/adapters/arxiv.ts'
const flags = readKernelFlags()
const skills = loadWorkflowSkills()
const checks = [
  { name: 'personal-library configured on', pass: flags.personalLibraryEnabled },
  { name: 'workflow-skills configured on', pass: flags.workflowSkillsEnabled },
  { name: 'arxiv configured on', pass: flags.arxivResearchEnabled },
  { name: 'role decision mode active', pass: flags.toolDecisionMode === 'role' },
  { name: 'two trusted workflow fingerprints valid', pass: skills.length === 2 },
  { name: 'fixed MCP source fingerprints valid', pass: verifyArxivRuntimeSync() },
  { name: 'content budget supports bounded arxiv excerpt', pass: flags.turnContentTokens >= 3000 },
]
const destination = resolve('artifacts/post-lv2/learning-skills', `activation-${Date.now()}`)
mkdirSync(destination, { recursive: true })
writeFileSync(join(destination, 'readback.json'), JSON.stringify({ measured_count: checks.length, checks,
  personalLibraryRoot: PERSONAL_LIBRARY_ROOT, arxivRuntime: ARXIV_RUNTIME,
  productionDatabase: 'not opened', scope: 'configuration and packaged assets; real-chain evidence is separate' }, null, 2) + '\n')
for (const check of checks) console.log(`${check.pass ? 'PASS' : 'FAIL'} ${check.name}`)
console.log(`evidence: ${destination}`)
process.exitCode = checks.every(c => c.pass) ? 0 : 1
