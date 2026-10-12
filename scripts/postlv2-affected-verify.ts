import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { planAffected, escalatedGateIds } from './gates/affected-map.ts'
import { OFFLINE_SPECIALTY_IDS, laneById } from './gates/manifest.ts'

const cases: { name: string; pass: boolean }[] = []
for (const [path, gate] of [
  ['src/infrastructure/media/image-input.ts', 'postlv2:image:verify'],
  ['src/kernel/contracts/image-input.ts', 'postlv2:image:verify'],
  ['src/infrastructure/action/adapters/arxiv.ts', 'learning:contracts:verify'],
  ['src/infrastructure/action/adapters/personal-library.ts', 'learning:contracts:verify'],
  ['src/infrastructure/action/adapters/workflow-skill.ts', 'learning:contracts:verify'],
  ['src/infrastructure/model/task-orchestration-instructions.ts', 'postlv2:orchestration:verify'],
  ['src/infrastructure/runtime/automatic-memory.ts', 'postlv2:automatic-memory:recovery:verify'],
  ['src/main.ts', 'postlv2:image:verify'],
  ['src/main.ts', 'learning:contracts:verify'],
  ['scripts/postlv2_speech_client.js', 'postlv2:oss-mechanisms:verify'],
  ['scripts/postlv2_vtuber_runtime.py', 'postlv2:oss-mechanisms:verify'],
  ['src/kernel/recall/selector.ts', 'postlv2:oss-mechanisms:verify'],
  ['src/db/index.ts', 'postlv2:database-env:verify'],
  ['src/kernel/contracts/chat-channel.ts', 'reminder:channels:verify'],
  ['src/infrastructure/runtime/reminder-scheduling.ts', 'reminder:channels:verify'],
  ['scripts/postlv2_reminder_client.js', 'reminder:channels:verify'],
  ['src/main.ts', 'reminder:channels:verify'],
] as const) {
  const plan = planAffected([path])
  cases.push({ name: `${path} selects ${gate}`, pass: plan.gateIds.includes(gate) })
}
cases.push({ name: 'documentation does not select executable gates', pass: planAffected(['docs/audit/example.md']).gateIds.length === 0 })
cases.push({ name: 'unknown source escalates rather than claiming coverage', pass: planAffected(['src/unknown/file.py']).escalateToOffline })
const escalated = escalatedGateIds(planAffected(['package.json', 'src/infrastructure/media/image-input.ts']), laneById('offline')!.gateIds!, OFFLINE_SPECIALTY_IDS)
cases.push({ name: 'global escalation preserves image specialty and full offline lane', pass: escalated.includes('postlv2:image:verify') && laneById('offline')!.gateIds!.every(id => escalated.includes(id)) })
cases.push({ name: 'M5 recall specialties survive package escalation', pass: ['m5:test', 'm5:verify', 'm5:e2e:verify'].every(id => escalatedGateIds(planAffected(['package.json', 'src/kernel/recall/selector.ts']), [], OFFLINE_SPECIALTY_IDS).includes(id)) })
cases.push({ name: 'asset/live gates are not pulled into an escalation', pass: !escalatedGateIds({ ...planAffected([]), gateIds: ['postlv2:automatic-memory:verify', 'postlv2:image:live'] }, [], OFFLINE_SPECIALTY_IDS).length })
cases.push({ name: 'negative control catches the former replacement behavior', pass: !laneById('offline')!.gateIds!.includes('postlv2:image:verify') })
const directory = join('artifacts/post-lv2/affected-selection', `run-${Date.now()}`)
mkdirSync(directory, { recursive: true })
writeFileSync(join(directory, 'result.json'), JSON.stringify({ cases, modelCalls: 0, databaseOpened: false }, null, 2))
console.log(JSON.stringify({ passed: cases.filter(c => c.pass).length, failed: cases.filter(c => !c.pass).length, cases }, null, 2))
assert.ok(cases.every(c => c.pass))
