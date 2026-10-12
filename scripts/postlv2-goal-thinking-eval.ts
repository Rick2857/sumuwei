/** Bounded, interleaved comparison. No database; test credentials required. */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildGoalCorpus, GOAL_CORPUS_LAYERS } from '../evals/m10/goal-corpus.ts'
import { buildAgreementCorpus } from '../evals/m10.1/agreement-corpus.ts'
import { understandGoalProposal, type GoalUnderstandingInput } from '../src/kernel/app/goal/understanding.ts'
import { createRealGoalUnderstandingRuntime } from '../src/infrastructure/goal/understanding-runtime.ts'
import { createOpenAiGoalUnderstandingProvider, type GoalThinkingMode } from '../src/infrastructure/model/openai-goal-understanding.ts'

if (process.env.DSH_TEST_MODEL_WRAPPER !== '1' || !process.env.OPENAI_API_KEY?.trim()) {
  throw new Error('Use pnpm with-test-model pnpm postlv2:goal-thinking:eval; no production credential fallback')
}
interface Case {
  id: string
  input: Omit<GoalUnderstandingInput, 'characterId' | 'sourceEventId' | 'sourceQualification'>
  operations: readonly string[]
  commitment?: boolean
  origin?: string
}
const cases: Case[] = GOAL_CORPUS_LAYERS.flatMap(layer =>
  buildGoalCorpus().items.filter(item => item.split === 'test' && item.layer === layer).slice(0, 3).map(item => ({
    id: item.caseId, input: { currentInput: item.sourceText, candidates: item.candidates.map(c => ({ ...c, revision: 1 })) },
    operations: [item.gold.operation],
  })))
// Only user acceptance of an assistant proposal belongs to this fast parser.
for (const item of buildAgreementCorpus().filter(item => item.caseId.startsWith('sem-') || ['pos-time-place', 'pos-time-only', 'pos-action-only'].includes(item.caseId))) {
  const assistant = item.window.find(entry => entry.actorType === 'character')!
  const user = item.window.find(entry => entry.actorType === 'user')!
  const positive = item.caseId.startsWith('pos-')
  cases.push({ id: item.caseId, input: { currentInput: user.text, candidates: [], lastAssistantEventId: assistant.id, lastAssistantText: assistant.text },
    operations: positive ? ['create'] : ['none', 'clarify'], commitment: positive, ...(positive ? { origin: 'character_proposed' } : {}) })
}
const proposal = '你把两份检测报告发来，我先逐项核对，再把差异列成表给你。'
const candidate = { goalId: 'goal:prior', revision: 2, status: 'completed' as const, priority: 'normal' as const, statement: '核对两份检测报告', commitmentStatus: 'fulfilled' as const }
cases.push(
  { id: 'lv2-bounded-workflow', input: { currentInput: '好，就按你说的流程核对。', candidates: [], lastAssistantEventId: 'cev:proposal', lastAssistantText: proposal }, operations: ['create'], commitment: true, origin: 'character_proposed' },
  { id: 'lv2-unselected-alternatives', input: { currentInput: '好，就那样吧。', candidates: [], lastAssistantEventId: 'cev:proposal', lastAssistantText: '你选一项：我只核对数值，或者我只核对版式。' }, operations: ['clarify'], commitment: false },
  { id: 'lv2-reestablish', input: { currentInput: '我们重新约定，明天再核对两份新报告，好吗？我同意重新订立这条约定。', candidates: [candidate] }, operations: ['create'], commitment: true },
  { id: 'lv2-old-restatement', input: { currentInput: '我们之前已经核对过两份检测报告。', candidates: [candidate] }, operations: ['none', 'query'], commitment: false },
  { id: 'lv2-active-repeat', input: { currentInput: '对，我们已经约好了核对两份报告。', candidates: [{ ...candidate, status: 'active', commitmentStatus: 'active' }] }, operations: ['none', 'query'], commitment: false },
)
const modes: GoalThinkingMode[] = ['default', 'low', 'disabled']
const rows: { run: number; id: string; mode: GoalThinkingMode; elapsedMs: number; kind: string; operation?: string; correct: boolean; unsafeCommitment: boolean; usage?: unknown; reasoningChars?: number; reason?: string }[] = []
const dir = join('artifacts', 'post-lv2', `goal-thinking-${new Date().toISOString().replace(/[:.]/g, '-')}`)
mkdirSync(dir, { recursive: true })
const criteria = { runs: 3, calls: cases.length * 9, selection: 'Each baseline-correct case/run must stay correct; no additional failures or unsafe commitments; median latency must decrease. Limited corpus evidence, not full semantic acceptance.' }
writeFileSync(join(dir, 'protocol.json'), JSON.stringify({ endpoint: new URL(process.env.OPENAI_BASE_URL!).host, model: process.env.OPENAI_SMALL_MODEL, criteria, cases }, null, 2))
for (let run = 0; run < 3; run += 1) {
  for (const [index, item] of cases.entries()) {
    for (let offset = 0; offset < modes.length; offset += 1) {
      const mode = modes[(index + run + offset) % modes.length]!
      let usage: unknown
      let reasoningChars: number | undefined
      const provider = createOpenAiGoalUnderstandingProvider({ thinkingMode: mode, fetchImpl: async (...args) => {
        const response = await fetch(...args)
        const json = response.json.bind(response)
        response.json = async () => {
          const payload = await json() as { usage?: unknown; choices?: { message?: { reasoning_content?: string } }[] }
          usage = payload.usage
          reasoningChars = payload.choices?.[0]?.message?.reasoning_content?.length ?? 0
          return payload
        }
        return response
      } })
      const started = performance.now()
      const outcome = await understandGoalProposal(provider, { ...item.input, characterId: 'thinking-probe', sourceEventId: `cev:${item.id}:${run}`, sourceQualification: 'ESTABLISHED' }, createRealGoalUnderstandingRuntime())
      const draft = outcome.kind === 'understood' ? outcome.draft : undefined
      const correct = draft !== undefined && item.operations.includes(draft.operation)
        && (item.commitment === undefined || Boolean(draft.commitment) === item.commitment)
        && (item.origin === undefined || draft.origin === item.origin)
      rows.push({ run, id: item.id, mode, elapsedMs: performance.now() - started, kind: outcome.kind, operation: draft?.operation,
        correct, unsafeCommitment: item.commitment === false && draft?.commitment !== undefined,
        usage, reasoningChars, ...('reason' in outcome ? { reason: outcome.reason } : {}) })
      writeFileSync(join(dir, 'rows.json'), JSON.stringify(rows, null, 2))
    }
    console.log(`run ${run + 1}/3 case ${index + 1}/${cases.length}: ${item.id}`)
  }
}
const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)]!
const baseline = rows.filter(row => row.mode === 'default')
const summary = modes.map(mode => {
  const group = rows.filter(row => row.mode === mode)
  const regressions = group.filter(row => baseline.find(base => base.id === row.id && base.run === row.run)?.correct && !row.correct).map(row => `${row.id}:r${row.run}`)
  return { mode, count: group.length, correct: group.filter(row => row.correct).length, failures: group.filter(row => row.kind !== 'understood').length,
    unsafeCommitments: group.filter(row => row.unsafeCommitment).length, medianMs: median(group.map(row => row.elapsedMs)), maxMs: Math.max(...group.map(row => row.elapsedMs)), regressions }
})
const base = summary[0]!
const eligible = summary.filter(group => group.mode !== 'default' && group.regressions.length === 0 && group.failures <= base.failures && group.unsafeCommitments <= base.unsafeCommitments && group.medianMs < base.medianMs)
const selected = eligible.sort((a, b) => a.medianMs - b.medianMs)[0]?.mode ?? 'default'
const reading = { criteria, summary, selected, scope: 'Parser-only test endpoint; no database, no main reply, no speaker playback, no direct DeepSeek production measurement' }
writeFileSync(join(dir, 'reading.json'), JSON.stringify(reading, null, 2))
console.log(JSON.stringify({ dir, ...reading }, null, 2))
