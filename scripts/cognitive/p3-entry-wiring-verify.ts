/**
 * 认知能力建设 · P3-5b · **入口接线门**（`p3:entry:wiring:verify`）
 * ============================================================================
 *  锁住第一批（G1 独立核验接入口 / G5 任务局部读根）的**行为**，全部零真实模型请求：
 *
 *  ```text
 *  G1（独立核验）：
 *    ① 没有受信 requiredSourcePaths ⇒ unknown（**不是**"通过"）
 *    ② 有受信来源但记账时点没有回复正文 ⇒ unknown（引文类判据不可用）
 *    ③ 有来源 + 有正文 + 核验器判 done ⇒ done（且判据来自契约核验器）
 *    ④ 每个被选中技能**必有一条**结论（含 unknown）⇒ 记账层不会回落到任务环自评
 *    ⑤ 自评读数只作事实记录（evidence 里带 `task_loop_self_assessment_not_verification`）
 *    ⑥ 结构锁：`src/main.ts` 把 `outcomes` 传给记账层、并只在三个开关都开时挂读根
 *
 *  G5（任务局部读根）：
 *    ⑦ 受管技能**真的加载成功**后，读根挂到**本次任务授权**上：根外读 → 执行前拒绝
 *       （`droppedReason='read_outside_task_roots'`，执行器**没有被调用**）
 *    ⑧ 只有"受管发布引用"才触发；legacy 回执不触发（与 P3-5a 的 legacy 边界一致）
 *    ⑨ 没配 `readRootScope` ⇒ 根外读照旧执行（旧路径 / 普通文件任务逐字不变）
 *    ⑩ 读根**只许收窄**：重复挂载/换根不会扩大范围
 *  ```
 *
 *  ⚠️ 本门用**真实** `createActionTurnPort` + 真实任务授权 + 真实任务环闸；只把
 *     「网关执行」换成**计数假执行器**（记录"哪条请求真的被执行了"）与「规划器」换成
 *     脚本计划。因此它证明的是**入口接线与闸的位置**，不是模型行为，也不发任何请求。
 *
 *  运行：
 *  ```bash
 *  pnpm p3:entry:wiring:verify
 *  ```
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runTask } from '../../src/kernel/action/task-loop.ts'
import { attestActionInitiatorUnresolved } from '../../src/kernel/contracts/attribution.ts'
import { createCapabilityRegistry } from '../../src/kernel/action/capability-registry.ts'
import { createInMemoryPayloadStaging } from '../../src/kernel/action/payload-staging.ts'
import { createTaskAuthorizationRegistry, applyReadRoots, pathWithinReadRoots } from '../../src/kernel/action/task-authorization.ts'
import { createLearningCapabilityDefinitions } from '../../src/kernel/action/learning-capabilities.ts'
import { createLocalFileCapabilityDefinitions } from '../../src/kernel/action/local-file-capabilities.ts'
import {
  P3_VERIFIED_SKILL_ID,
  independentlyVerifySkillResults,
  realReadPathsOf,
} from '../../src/infrastructure/action/workflow-skill-verification.ts'
import type { ActionGateway } from '../../src/kernel/action/gateway.ts'
import type { ActionTurnResult } from '../../src/kernel/action/action-turn.ts'
import type { TaskPlannerOutcome, TaskPlannerPort } from '../../src/kernel/action/task-plan.ts'

// ---------------------------------------------------------------------------
//  检查表
// ---------------------------------------------------------------------------
interface CheckRow { readonly id: string; readonly title: string; readonly pass: boolean; readonly detail: string }
const checks: CheckRow[] = []
async function check (id: string, title: string, fn: () => string | Promise<string>): Promise<void> {
  try {
    checks.push({ id, title, pass: true, detail: await fn() })
  } catch (error) {
    checks.push({ id, title, pass: false, detail: error instanceof Error ? error.message : String(error) })
  }
}
const startedAt = Date.now()

// ---------------------------------------------------------------------------
//  G1：独立核验（纯函数）
// ---------------------------------------------------------------------------
function actionResultOf (input: {
  capability: string
  operation: string
  path?: string
  evidenceRefs?: readonly string[]
}): ActionTurnResult {
  return {
    kind: 'executed',
    request: { capability: input.capability, operation: input.operation, arguments: input.path === undefined ? {} : { path: input.path } },
    result: {
      status: 'success',
      executed: true,
      accepted: true,
      ...(input.path === undefined ? {} : { effect: { kind: 'content_read' } }),
      evidence: (input.evidenceRefs ?? (input.path === undefined ? [] : [input.path])).map(ref => ({ ref })),
    },
  } as unknown as ActionTurnResult
}

const LIBRARY_ROOT = join(tmpdir(), 'p3-entry-wiring', 'corpus')

await check('01', 'G1：没有受信 requiredSourcePaths ⇒ unknown（不能是 done）', () => {
  const result = independentlyVerifySkillResults({
    skillIds: [P3_VERIFIED_SKILL_ID],
    actionResults: [actionResultOf({ capability: 'local.file.read', operation: 'read', path: join(LIBRARY_ROOT, 'notes/attention-notes.md') })],
    libraryRoot: LIBRARY_ROOT,
  })
  const outcome = result.outcomes[P3_VERIFIED_SKILL_ID]!
  assert.equal(outcome.kind, 'unknown')
  const evidence = outcome.evidence as { reason?: string; realReadCount?: number }
  assert.equal(evidence.reason, 'no_trusted_required_sources')
  assert.equal(evidence.realReadCount, 1, '机械事实（真实读路径数）必须记录')
  return `kind=${outcome.kind} reason=${String(evidence.reason)} realRead=${String(evidence.realReadCount)}`
})

await check('02', 'G1：有受信来源、但记账时点没有回复正文 ⇒ unknown（读过 ≠ 答案正确）', () => {
  const result = independentlyVerifySkillResults({
    skillIds: [P3_VERIFIED_SKILL_ID],
    actionResults: [actionResultOf({ capability: 'local.file.read', operation: 'read', path: join(LIBRARY_ROOT, 'notes/attention-notes.md') })],
    libraryRoot: LIBRARY_ROOT,
    requiredSourcePaths: [join(LIBRARY_ROOT, 'notes/attention-notes.md')],
  })
  const outcome = result.outcomes[P3_VERIFIED_SKILL_ID]!
  assert.equal(outcome.kind, 'unknown', '"读过来源"绝不能单独推出 done')
  assert.equal((outcome.evidence as { reason?: string }).reason, 'reply_text_not_available_at_write_time')
  return `kind=${outcome.kind}（replyTextAvailable=${String(result.mechanical.replyTextAvailable)}）`
})

await check('03', 'G1：有来源 + 有正文 + 契约核验器判 done ⇒ done（判据来自核验器，不是自评）', () => {
  const source = join(LIBRARY_ROOT, 'notes/attention-notes.md')
  const result = independentlyVerifySkillResults({
    skillIds: [P3_VERIFIED_SKILL_ID],
    actionResults: [actionResultOf({ capability: 'local.file.read', operation: 'read', path: source })],
    libraryRoot: LIBRARY_ROOT,
    requiredSourcePaths: [source],
    allowedFactMarkers: ['LGLIB-ALPHA-1'],
    replyText: `答案在这里：${source} 提到 LGLIB-ALPHA-1。`,
  })
  const outcome = result.outcomes[P3_VERIFIED_SKILL_ID]!
  assert.equal(outcome.kind, 'done', `契约核验器应判 done（实际 ${outcome.kind}）`)
  assert.equal((outcome.evidence as { verifier?: string }).verifier, 'personal-library-answer@1')
  return `kind=${outcome.kind} verifier=${String((outcome.evidence as { verifier?: string }).verifier)}`
})

await check('04', 'G1：每个被选中技能都有结论（unknown 也算）⇒ 记账层没有回落自评的缺口', () => {
  const result = independentlyVerifySkillResults({
    skillIds: [P3_VERIFIED_SKILL_ID, 'writing-collaboration'],
    actionResults: [],
    libraryRoot: LIBRARY_ROOT,
  })
  assert.deepEqual(Object.keys(result.outcomes).sort(), ['personal-library', 'writing-collaboration'])
  for (const outcome of Object.values(result.outcomes)) assert.equal(outcome.kind, 'unknown')
  assert.equal((result.outcomes['writing-collaboration']!.evidence as { reason?: string }).reason, 'verifier_not_available_for_skill')
  return '2/2 都有条目且均为 unknown'
})

await check('05', 'G1：任务环自评只作**标注过的事实**记录，不参与结论', () => {
  const achievedTask = {
    ...actionResultOf({ capability: 'local.file.read', operation: 'read', path: join(LIBRARY_ROOT, 'notes/attention-notes.md') }),
    task: { taskId: 't-1', steps: 1, actionsUsed: 1, plansUsed: 1, stopped: 'done', goal: { achieved: true } },
  } as unknown as ActionTurnResult
  const result = independentlyVerifySkillResults({
    skillIds: [P3_VERIFIED_SKILL_ID],
    actionResults: [achievedTask],
    libraryRoot: LIBRARY_ROOT,
  })
  assert.equal(result.outcomes[P3_VERIFIED_SKILL_ID]!.kind, 'unknown', '自评 done 不得变成核验 done')
  const self = result.mechanical.selfAssessment as { kind?: string; evidence?: { label?: string } } | undefined
  assert.equal(self?.kind, 'done')
  assert.equal(self?.evidence?.label, 'task_loop_self_assessment_not_verification')
  return `核验=${result.outcomes[P3_VERIFIED_SKILL_ID]!.kind} 自评=${String(self?.kind)}（标注：${String(self?.evidence?.label)}）`
})

await check('06', 'G1：真实读路径只从"成功 content_read 动作"里取（失败读/写动作不算）', () => {
  const read = actionResultOf({ capability: 'local.file.read', operation: 'read', path: 'a.md' })
  const failedRead = {
    ...actionResultOf({ capability: 'local.file.read', operation: 'read', path: 'b.md' }),
    result: { status: 'failed', executed: false, accepted: true, evidence: [] },
  } as unknown as ActionTurnResult
  const write = {
    ...actionResultOf({ capability: 'local.file.write', operation: 'write', path: 'c.md' }),
    result: { status: 'success', executed: true, accepted: true, effect: { kind: 'file_written' }, evidence: [] },
  } as unknown as ActionTurnResult
  assert.deepEqual(realReadPathsOf([read, failedRead, write]), ['a.md'])
  return 'paths=[a.md]'
})

// ---------------------------------------------------------------------------
//  G5：真实任务环 + 真实任务授权 + 计数假执行器
// ---------------------------------------------------------------------------
const registry = createCapabilityRegistry([
  ...createLearningCapabilityDefinitions(),
  ...createLocalFileCapabilityDefinitions(),
])

interface Executed { readonly capability: string; readonly operation: string; readonly path?: string }
const executed: Executed[] = []
let evidenceRefForLoad = `workflow-skill:${P3_VERIFIED_SKILL_ID}@1#dc31529495560ce34ca90233c4fc1b3a798ed97596b46dcb31e97dbdce4a0f4c`

const fakeGateway = {
  /* ⚠️ 网关的 `execute(characterId, request, invocation?)` 是**三参**签名（`gateway.ts:179`）。 */
  async execute (_characterId: unknown, request: { capability: string, operation: string, arguments: Record<string, unknown> }) {
    const path = typeof request.arguments?.path === 'string' ? request.arguments.path : undefined
    executed.push({ capability: request.capability, operation: request.operation, ...(path === undefined ? {} : { path }) })
    if (request.capability === 'workflow.skill' && request.operation === 'load') {
      return {
        status: 'success', executed: true, accepted: true,
        effect: { kind: 'content_read' },
        evidence: [{ ref: evidenceRefForLoad }],
      }
    }
    return {
      status: 'success', executed: true, accepted: true,
      effect: { kind: 'content_read', fingerprint: `fp:${String(path)}` },
      evidence: path === undefined ? [] : [{ ref: path }],
    }
  },
} as unknown as ActionGateway

function scriptedPlanner (plans: readonly { steps: readonly { capability: string, operation: string, args: Record<string, unknown> }[] }[]): TaskPlannerPort {
  let index = 0
  return {
    id: 'gate-scripted-planner@1',
    endpointHost: 'none',
    async plan (): Promise<TaskPlannerOutcome> {
      const plan = plans[Math.min(index, plans.length - 1)]!
      index += 1
      return {
        ok: true,
        requestCount: 0,
        plan: {
          goal: '资料夹整理',
          done: false,
          steps: plan.steps.map(step => ({ capability: step.capability, operation: step.operation, args: step.args })),
        },
      } as unknown as TaskPlannerOutcome
    },
  }
}

async function runScenario (input: {
  plans: Parameters<typeof scriptedPlanner>[0]
  readRootScope?: { skillId: string, roots: readonly string[], source: string }
}): Promise<{ executed: readonly Executed[], stopped: string, steps: readonly { capability: string, operation: string, droppedReason?: string }[] }> {
  executed.length = 0
  const authorizations = createTaskAuthorizationRegistry()
  const issued = authorizations.issue({
    conversationKey: 'conv-p3-entry-gate',
    originalText: '帮我整理资料夹里的笔记',
    triggeringEventId: 'event-p3-entry-gate',
    allowedCapabilities: ['workflow.skill', 'local.file.read'],
    maxRiskLevel: 'R1',
  })
  if (issued === undefined) throw new Error('任务授权没有签发成功')
  const outcome = await runTask({
    gateway: fakeGateway,
    registry,
    authorizations,
    planner: scriptedPlanner(input.plans),
    staging: createInMemoryPayloadStaging(),
    resolveTarget: async (request: { request: { capability: string, arguments: Record<string, unknown> } }) => ({
      target: {
        type: 'local_executor',
        canonicalId: typeof request.request.arguments.path === 'string' ? request.request.arguments.path : request.request.capability,
        confidence: 'exact',
      },
      scopeViolation: false,
    }),
    invocationFor: () => ({ initiatorEvidence: attestActionInitiatorUnresolved({ adapterId: 'p3-entry-wiring-gate' }) }),
    now: () => Date.now(),
    ...(input.readRootScope === undefined ? {} : { readRootScope: input.readRootScope }),
  }, {
    characterId: 'Alex' as never,
    traceId: 'trace-p3-entry-gate' as never,
    text: '帮我整理资料夹里的笔记',
    authorization: issued,
  })
  if (process.env.P3_ENTRY_DEBUG === '1') console.log('[debug]', JSON.stringify(outcome))
  return {
    executed: [...executed],
    stopped: String(outcome.stopped),
    steps: outcome.steps.map(step => ({
      capability: step.capability,
      operation: step.operation,
      ...(step.droppedReason === undefined ? {} : { droppedReason: step.droppedReason }),
    })),
  }
}

const INSIDE = join(LIBRARY_ROOT, 'notes/attention-notes.md')
const OUTSIDE = join(tmpdir(), 'p3-entry-wiring', 'outside-secret.md')
const MANUAL_SCOPE = {
  skillId: P3_VERIFIED_SKILL_ID,
  roots: [LIBRARY_ROOT],
  source: 'gate:main:p3-managed-personal-library',
}

await check('07', 'G5：受管技能加载成功后，根外读在**执行前**被拒绝（执行器没被调用）', async () => {
  evidenceRefForLoad = `workflow-skill:${P3_VERIFIED_SKILL_ID}@1#dc31529495560ce34ca90233c4fc1b3a798ed97596b46dcb31e97dbdce4a0f4c`
  const scenario = await runScenario({
    plans: [{ steps: [
      { capability: 'workflow.skill', operation: 'load', args: { skill: P3_VERIFIED_SKILL_ID } },
      { capability: 'local.file.read', operation: 'read', args: { path: INSIDE } },
      { capability: 'local.file.read', operation: 'read', args: { path: OUTSIDE } },
    ] }],
    readRootScope: MANUAL_SCOPE,
  })
  const paths = scenario.executed.filter(item => item.capability === 'local.file.read').map(item => item.path)
  assert.ok(paths.includes(INSIDE), `根内读没有执行：${JSON.stringify(paths)}`)
  assert.ok(!paths.includes(OUTSIDE), `根外读被执行了：${JSON.stringify(paths)}`)
  assert.ok(
    scenario.steps.some(step => step.droppedReason === 'read_outside_task_roots'),
    `没有留下执行前拒绝的记录：${JSON.stringify(scenario.steps.map(step => step.droppedReason ?? step.capability))}`,
  )
  return `根内读执行 ${String(paths.filter(path => path === INSIDE).length)} 次 · 根外读 0 次 · droppedReason 已留痕`
})

await check('08', 'G5：只有**受管发布引用**才触发读根；legacy 回执不触发（边界与试点一致）', async () => {
  evidenceRefForLoad = 'workflow-skill@1#legacy-fingerprint' // 旧格式：没有 `<id>@` 段
  const scenario = await runScenario({
    plans: [{ steps: [
      { capability: 'workflow.skill', operation: 'load', args: { skill: P3_VERIFIED_SKILL_ID } },
      { capability: 'local.file.read', operation: 'read', args: { path: OUTSIDE } },
    ] }],
    readRootScope: MANUAL_SCOPE,
  })
  const paths = scenario.executed.filter(item => item.capability === 'local.file.read').map(item => item.path)
  assert.ok(paths.includes(OUTSIDE), 'legacy 回执不应触发读根收窄')
  return 'legacy 回执 ⇒ 读根未挂，根外读照旧执行'
})

await check('09', 'G5：未配置 readRootScope ⇒ 旧路径逐字不变（根外读照旧执行）', async () => {
  evidenceRefForLoad = `workflow-skill:${P3_VERIFIED_SKILL_ID}@1#dc31529495560ce34ca90233c4fc1b3a798ed97596b46dcb31e97dbdce4a0f4c`
  const scenario = await runScenario({
    plans: [{ steps: [
      { capability: 'workflow.skill', operation: 'load', args: { skill: P3_VERIFIED_SKILL_ID } },
      { capability: 'local.file.read', operation: 'read', args: { path: OUTSIDE } },
    ] }],
  })
  const paths = scenario.executed.filter(item => item.capability === 'local.file.read').map(item => item.path)
  assert.ok(paths.includes(OUTSIDE), '没有 readRootScope 时根外读应当照旧执行')
  return '无 readRootScope ⇒ 根外读执行（普通文件任务不受影响）'
})

await check('10', 'G5：读根只许收窄（重复挂载/换根不会扩大范围）', () => {
  const task = {
    readRoots: undefined as undefined | { roots: readonly string[], source: string },
  }
  applyReadRoots(task as never, { roots: [LIBRARY_ROOT], source: 'assembly' })
  assert.deepEqual(task.readRoots?.roots, [LIBRARY_ROOT.replace(/\\/g, '/')])
  const before = JSON.stringify(task.readRoots?.roots)
  applyReadRoots(task as never, { roots: [join(tmpdir(), 'p3-entry-wiring'), LIBRARY_ROOT], source: 'assembly' })
  assert.equal(JSON.stringify(task.readRoots?.roots), before, '重复挂载把范围放大了')
  assert.ok(pathWithinReadRoots(INSIDE, task.readRoots!.roots))
  assert.ok(!pathWithinReadRoots(OUTSIDE, task.readRoots!.roots))
  return `roots=${JSON.stringify(task.readRoots?.roots)}`
})

// ---------------------------------------------------------------------------
//  结构锁：main.ts 真的接上了（不是只在门里成立）
// ---------------------------------------------------------------------------
const mainSource = readFileSync(new URL('../../src/main.ts', import.meta.url), 'utf8')
const loopSource = readFileSync(new URL('../../src/kernel/action/task-loop.ts', import.meta.url), 'utf8')

await check('11', '结构锁：main.ts 把独立核验的 outcomes 传给记账层（不再回落自评）', () => {
  assert.ok(mainSource.includes('independentlyVerifySkillResults('), 'main.ts 没有调用独立核验')
  assert.ok(mainSource.includes('outcomes: independent.outcomes'), 'main.ts 没有把独立结论交给记账层')
  assert.ok(!mainSource.includes('outcomes: undefined'), 'main.ts 里出现了"显式不传 outcomes"的写法')
  return 'main.ts: independentlyVerifySkillResults → outcomes'
})

await check('12', '结构锁：读根只在三个开关同时打开时挂，且来源可审计', () => {
  assert.ok(mainSource.includes('this.flags.workflowSkillsEnabled && this.flags.workflowSkillCatalogEnabled && this.flags.personalLibraryEnabled'))
  assert.ok(mainSource.includes('source: \'main:p3-managed-personal-library\''))
  assert.ok(loopSource.includes("droppedReason: 'read_outside_task_roots'"), '任务环没有执行前拒绝分支')
  assert.ok(loopSource.includes('applyReadRoots(authorization'), '任务环没有在受管加载成功后挂读根')
  return '三开关 + 具名 droppedReason + applyReadRoots'
})

// ---------------------------------------------------------------------------
//  收尾
// ---------------------------------------------------------------------------
const passed = checks.filter(row => row.pass).length
const failed = checks.length - passed
const elapsedMs = Date.now() - startedAt
for (const row of checks) {
  console.log(`${row.pass ? 'PASS' : 'FAIL'} ${row.id} ${row.title}${row.pass ? `（${row.detail}）` : `\n     ↳ ${row.detail}`}`)
}
console.log(`\nP3-5b 入口接线门：${String(passed)} PASS / ${String(failed)} FAIL / ${String(checks.length)} total（${String(elapsedMs)} ms）`)
process.exitCode = failed === 0 && checks.length > 0 ? 0 : 1
