import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createCapabilityRegistry } from '../src/kernel/action/capability-registry.ts'
import { createOpenAiToolDecisionPort } from '../src/infrastructure/model/openai-tool-decision.ts'
import { createOpenAiTaskPlanner } from '../src/infrastructure/model/openai-task-planner.ts'
import { taskOrchestrationInstructions } from '../src/infrastructure/model/task-orchestration-instructions.ts'

const cases: { name: string; pass: boolean }[] = []
const check = (name: string, pass: boolean) => { cases.push({ name, pass }) }
let response: unknown = { branch: 'answer' }
let requests: { messages: { content: string }[] }[] = []
const fetchImpl: typeof fetch = async (_url, init) => {
  requests.push(JSON.parse(String(init?.body)))
  return Response.json({ choices: [{ message: { content: JSON.stringify(response) } }] })
}
const env = { OPENAI_API_KEY: 'fixture', OPENAI_BASE_URL: 'https://fixture.invalid', OPENAI_SMALL_MODEL: 'fixture' }
const decision = createOpenAiToolDecisionPort({ env, fetchImpl })
const first = await decision.decide({ text: '读资料后计算并写报告', recentLines: [], catalog: 'system.echo',
  allowedCapabilities: ['system.echo'], hasOpenTask: false, taskBudgetAvailable: true })
check('first proposal uses one request and shared orchestration rules', first.ok && first.requestCount === 1
  && requests[0]!.messages[0]!.content.includes(taskOrchestrationInstructions()))
const planner = createOpenAiTaskPlanner({ env, fetchImpl, registry: createCapabilityRegistry([]) })
const input = { task: '读资料后计算并写报告', executed: ['system.echo.echo=success'], failures: ['document.read=failed'],
  remainingActions: 2, allowedCapabilities: ['system.echo'], content: ['真实结果 fixture-result-491'] }
response = { goal: '已有结果足够', steps: [], done: true }
const planned = await planner.plan(input)
check('replan uses the same rules and actual failures/content', planned.ok
  && requests[1]!.messages[0]!.content.includes(taskOrchestrationInstructions())
  && requests[1]!.messages[1]!.content.includes('fixture-result-491')
  && requests[1]!.messages[1]!.content.includes('document.read=failed'))
response = { goal: '越权负控', steps: [{ capability: 'unregistered.escape', operation: 'exec', args: {} }], done: true }
const denied = await planner.plan(input)
check('unauthorized proposal fails closed', !denied.ok)
response = { goal: '恢复', steps: [], done: true }
check('fresh valid proposal works after rejection', (await planner.plan(input)).ok)
const before = requests.length
check('no capability grant means zero planner requests', !(await planner.plan({ ...input, allowedCapabilities: [] })).ok && requests.length === before)
const directory = join('artifacts/post-lv2/orchestration-controls', `run-${Date.now()}`)
mkdirSync(directory, { recursive: true })
writeFileSync(join(directory, 'result.json'), JSON.stringify({ cases, modelCalls: 0, databaseOpened: false }, null, 2))
console.log(JSON.stringify({ passed: cases.filter(c => c.pass).length, failed: cases.filter(c => !c.pass).length, cases }, null, 2))
assert.ok(cases.every(c => c.pass))
