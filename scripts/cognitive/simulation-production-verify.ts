import 'dotenv/config'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { createFilePlanningBed } from './file-planning-bed.ts'
import { createSimulationPlanning, explicitFileGoal } from '../../src/infrastructure/runtime/simulation-planning.ts'
import { createOpenAiTaskPlanner } from '../../src/infrastructure/model/openai-task-planner.ts'
import { createActionTurnPort } from '../../src/kernel/action/action-turn.ts'
import { readKernelFlags } from '../../src/kernel/app/flags.ts'
import { asTraceId } from '../../src/kernel/contracts/ids.ts'
import { triggeringConversationEventOf } from '../../src/kernel/contracts/attribution.ts'
import type { TaskRunOutcome } from '../../src/kernel/action/task-loop.ts'

const checks: string[] = []
const check = (name: string, value: unknown) => { assert.ok(value, name); checks.push(name); console.log(`PASS ${name}`) }
const bed = await createFilePlanningBed('simulation-production')
try {
  const path = 'production-goal.txt', content = '精确值\n"a\\b" 🌿\n'
  const text = `只操作相对路径 ${path}。写入以下 JSON 字符串解码后的精确内容，再读回核对：${JSON.stringify(content)}。`
  check('新开关缺省关闭，显式 true 可启用', !readKernelFlags({}).simulationPlannerEnabled && readKernelFlags({ CHARACTER_SIMULATION_PLANNER_ENABLED: 'true' }).simulationPlannerEnabled)
  check('原文可确定路径与正文', explicitFileGoal(text)?.path === path)
  check('含糊、引用附带指令、绝对路径与逃逸均不进入模拟', ['写个文件', `引用：${text}`, text.replace(path, '../out.txt'), text.replace(path, '/tmp/out.txt')].every(s => !explicitFileGoal(s)))
  const plan = (value: string) => ({ goal: 'write/read', done: true, steps: [
    { capability: 'sandbox.file.write', operation: 'write', args: { path, content: value } },
    { capability: 'sandbox.file.read', operation: 'read', args: { path } },
  ] })
  let calls = 0
  const candidatePlanner = createOpenAiTaskPlanner({ registry: bed.registry, candidateCount: 3,
    env: { OPENAI_API_KEY: 'test-only', OPENAI_BASE_URL: 'https://fixture.invalid', OPENAI_SMALL_MODEL: 'fixture' },
    fetchImpl: async (_url, init) => {
      calls++
      const request = JSON.parse(String(init?.body))
      assert.equal(request.max_tokens, 8000)
      assert.ok(request.messages[0].content.includes('candidates'))
      assert.ok(request.messages[0].content.includes('capability、operation、args'))
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ candidates: [plan('wrong'), plan(content), plan(content)] }) } }] }))
    },
  })
  const configurePlanning = createSimulationPlanning({ ...bed.modelOptions, registry: bed.registry, candidatePlanner })
  check('无关任务保持原规划器，不调用候选模型', await configurePlanning('帮我查天气') === undefined && calls === 0)
  const { h, gateway, authorizations, staging, resolveTarget } = bed.turnHarness
  let legacyForecasts = 0, outcome: TaskRunOutcome | undefined
  const port = createActionTurnPort({ registry: bed.registry, gateway, detector: { detect() { throw Error('role_only') } },
    attribution: { adapterId: 'simulation-production' },
    toolDecision: { catalog: 'sandbox', port: { id: 'fixture-role', endpointHost: 'offline', async decide() {
      return { ok: true, raw: { branch: 'tools', ...plan('seed-must-not-bypass-simulation') }, requestCount: 1 }
    } } },
    task: { authorizations, staging, resolveTarget, configurePlanning,
      planner: { id: 'legacy', endpointHost: 'offline', async plan() { throw Error('legacy_unexpected') } },
      capabilitiesFor: () => bed.allowed, riskLevelFor: () => 'R1',
      forecast: { deadlineMs: 1000, port: { id: 'legacy', endpointHost: 'offline', async forecast() { legacyForecasts++; throw Error('conflict') } } },
      onTaskOutcome: value => { outcome = value },
    },
  })
  const event = (await h.recordUserEvidence(text)).event
  const result = await port.handleTurn({ characterId: h.kernel.characterId, text, eventId: String(event.id),
    traceId: asTraceId('production-wiring'), conversationKey: String(event.conversationId), speaker: { kind: 'user', id: h.userId },
    triggeringEvent: triggeringConversationEventOf(event),
  })
  check('role 首份计划不能绕过模拟；只执行选中候选', result.kind === 'executed' && readFileSync(`${bed.root}/${path}`, 'utf8') === content)
  check('一次候选生成使用一份计划预算，真实动作两次', calls === 1 && outcome?.plansUsed === 1 && outcome.actionsUsed === 2)
  check('范围内不同时使用旧预测，真实比较 match', legacyForecasts === 0 && outcome?.simulationsUsed === 1 && outcome.comparisons?.[0]?.verdict === 'match')
  const source = readFileSync('src/main.ts', 'utf8')
  check('main 消费开关并装配原生 EBL、候选规划与范围端口', source.includes('this.flags.simulationPlannerEnabled && this.flags.epistemicBeliefEnabled') && source.includes('configurePlanning: createSimulationPlanning') && source.includes('candidateCount: 3'))
  await bed.store.commit(bed.rule.claimId, { kind: 'withdraw' })
  check('资格撤回后新任务恢复普通规划，零额外候选请求', await configurePlanning(text) === undefined && calls === 1)
  for (const count of [1, 0, 4]) {
    const probe = createOpenAiTaskPlanner({ registry: bed.registry, candidateCount: 3,
      env: { OPENAI_API_KEY: 'fixture' }, fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: {
        content: JSON.stringify({ candidates: Array.from({ length: count }, () => plan(content)) }),
      } }] })),
    })
    const value = await probe.plan({ task: text, allowedCapabilities: bed.allowed, remainingActions: 4, executed: [], failures: [] })
    check(`候选数量边界 ${count}`, count === 1 ? value.ok && value.candidates?.length === 1 : !value.ok)
  }
  writeFileSync(`${bed.output}/production-verification.json`, JSON.stringify({ status: 'PASS', checks: checks.length, execution: 'serversim/simhost', model: 'offline fixture, not semantic benefit', productionOpened: false }, null, 2))
} finally { await bed.stop() }
