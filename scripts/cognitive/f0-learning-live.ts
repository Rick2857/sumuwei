/**
 * **F0 学习序列运行器（v2 装配：世界 × 臂隔离，学习发生在被测序列里）**
 *
 * 依据 [F0 执行清单@3](../../evals/world-model-pilot/f0-execution-list-v3.json)、
 * [协议 §4 L/§5/§6](docs/architecture/Cognitive-Capability-Experiment-Protocol-2026-10-23.md) 与
 * [F0 归属更正记录](Cognitive-Capability-F0-Live-Record-2026-10-24.md) §1/§4。
 *
 * ============================================================================
 *  三种模式
 * ============================================================================
 *  · `--seal`：零请求。绑定协议/清单/核心/本文件/床位的摘要 + 源码指纹 + 镜像 + 门结果
 *    （`gateReadings` 有 MISSING 就拒绝封存）+ 9 个（世界 × 臂）执行单元 + 预算。
 *  · `--run`：先核对封存摘要，再逐（世界 × 臂）单元在**独立隔离库**里执行；
 *    每个单元内部**连续跑该世界的 8 个任务**（状态保留），**每臂各自生成自己的候选**。
 *  · `--arm <A|B|C> --world <worldId>`：单个（世界 × 臂）单元的执行。
 *
 *  ---------------------------------------------------------------------------
 *  与 v1 装配的差别（2026-10-24 用户核对后修正）
 *  ---------------------------------------------------------------------------
 *  ① **世界 × 臂隔离**（v1 是"任务 × 臂"隔离）：同一臂**连续保留 8 个任务的状态**。
 *  ② **取消自动赠送规则**：床位以 `train: false` 创建 ⇒ 序列**从没有规则开始**，
 *     规则**只能**由被测任务里的真实观察形成（`observe: true`）。
 *  ③ **每臂各自生成**：每个（臂，任务）**各自调用一次模型** ⇒ 臂与"自己的那次生成、
 *     自己的历史"配对（v1 三臂共享一个生成池 ⇒ 配对被破坏）。
 *  ④ **候选覆盖写检查**：生成端必须检查候选池**覆盖**目标写入（写目标路径 + 内容逐字相等
 *     + 其后有该路径的读取）；不覆盖 ⇒ 记为**生成失败**（不是臂的达成失败）。
 *  ⑤ **失败成本不外过滤**：失败任务的生成尝试与 token 单列进成本读数。
 *
 *  纪律：不自动重试；失败保留为结果；完成原规模即止（不补采、不扩围）；真值只在执行器侧。
 */
import 'dotenv/config'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { config } from 'dotenv'
import { createObservingFilePlanningBed, scoreFileTask } from './file-planning-bed.ts'
import {
  generateF0Tasks, listF0Worlds, poolCoversGoal, selectF0Candidate, toCandidate,
  type F0Task, type F0World,
} from './f0-learning-core.ts'
import { type SimulationPlanSelection } from '../../src/infrastructure/runtime/simulation-task-planner.ts'
import { createSimulationPlanning } from '../../src/infrastructure/runtime/simulation-planning.ts'
import { contentFingerprint } from '../../src/infrastructure/action/adapters/sandbox-filesystem.ts'
import { extractTaskPlanJson, type TaskPlan, type TaskPlannerPort } from '../../src/kernel/action/task-plan.ts'
import { runPreparedPgGateInInstance } from '../postgresql/test-harness.ts'

const ARMS = ['A', 'B', 'C'] as const
type Arm = (typeof ARMS)[number]
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const arg = (name: string) => {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}

const LIST_PATH = resolve('evals/world-model-pilot/f0-execution-list-v4.json')
const PROTOCOL_PATH = resolve('docs/architecture/Cognitive-Capability-Experiment-Protocol-2026-10-23.md')
const CORE_PATH = resolve('scripts/cognitive/f0-learning-core.ts')
const LIVE_PATH = resolve('scripts/cognitive/f0-learning-live.ts')
const BED_PATH = resolve('scripts/cognitive/file-planning-bed.ts')
const EVIDENCE_DIR = resolve('artifacts/cognitive/local/e2-page-question-20261023')
const EVIDENCE_ROOT = resolve(process.env.F0_EVIDENCE_DIR ?? 'artifacts/local/f0-learning')

interface F0List {
  version: string
  size: { worlds: number; tasksPerWorld: number; arms: number; uniqueTasks: number; units: number; generations: number }
  budget: {
    perTaskModelRequests: number; perArmPerTaskActions: number; perArmPerTaskPlans: number
    sequenceModelRequests: number; sequenceWallClockMs: number
    tokenBudget?: { maxCompletionTokensPerRequest: number; maxTotalTokens: number }
  }
}

interface ArmTaskReading {
  taskId: string; phase: string; index: number
  generation: 'OK' | 'NO_COVERAGE' | 'PARSE_FAILED' | 'TRANSPORT_FAILED'
  tokens: number
  selectedIndex?: number; selectionReason?: string
  achieved: boolean; bytesMatch: boolean; readMatched: boolean; falseCompletion: boolean
  actions: number; plans: number; executions: number; elapsedMs: number; epistemicFailures: number
  usableRulesBefore: number; usableRulesAfter: number
  /** 本题走的是**普通规划**还是**模拟选路**（无合格规则时按生产行为走普通规划）。 */
  planningMode: 'ordinary' | 'simulation'
  /** **同池对照**（只在 C 臂记）：在 C 自己的候选池上，A/B 会选哪个编号（**不执行**）。 */
  counterfactualOnOwnPool?: { A: number; B: number }
  /** 参与本次选路的**规则资格快照**（C 臂，模拟模式下）。 */
  usableRuleIds?: string[]
  error?: string
}

interface ArmUnitReport {
  worldId: string; arm: Arm; tasks: ArmTaskReading[]
  generations: number; tokens: number; actions: number
  usableRulesAtEnd: number
  /** 预算停止的原因（没有就是没有）。 */
  budgetStop?: string
  /** 因预算停止而**未运行**的任务（保留，不隐藏）。 */
  unrunTasks: string[]
  /** 是否是**离线模式**（只给门用；封存的真实运行必须是 false）。 */
  offline: boolean
}

/** 离线模式（只给门用）的固定候选池：三条，含一条正确写读、两条别的写法。 */
function offlinePool(task: F0Task): TaskPlan[] {
  const wrongContent: TaskPlan = { goal: 'g', done: true, steps: [
    { capability: 'sandbox.file.write', operation: 'write', args: { path: task.path, content: `${task.content} ` } },
    { capability: 'sandbox.file.read', operation: 'read', args: { path: task.path } },
  ] }
  const writeOnly: TaskPlan = { goal: 'g', done: true, steps: [
    { capability: 'sandbox.file.write', operation: 'write', args: { path: task.path, content: task.content } },
  ] }
  const correct: TaskPlan = { goal: 'g', done: true, steps: [
    { capability: 'sandbox.file.write', operation: 'write', args: { path: task.path, content: task.content } },
    { capability: 'sandbox.file.read', operation: 'read', args: { path: task.path } },
  ] }
  return [correct, wrongContent, writeOnly]
}

/** 任务文本：与文件选择器协议同形。 */
function taskTextFor(task: F0Task): string {
  return `只操作相对路径 ${task.path}。写入以下 JSON 字符串解码后的精确内容，再读回核对：${JSON.stringify(task.content)}。`
}

/** 读取**测试端点**（容器自身环境是 serversim 桩端点，必须显式覆盖）。 */
function loadEndpoint(): { baseUrl: string; model: string; key: string } {
  const testEnv = process.env.TEST_MODEL_ENV_FILE ?? resolve('.env.test')
  assert.ok(existsSync(testEnv), `missing_test_env:${testEnv}`)
  config({ path: resolve('.env'), override: false })
  config({ path: testEnv, override: true })
  const baseUrl = (process.env.OPENAI_BASE_URL ?? '').trim()
  const model = (process.env.OPENAI_LARGE_MODEL ?? '').trim()
  const key = (process.env.OPENAI_API_KEY ?? '').trim()
  assert.ok(baseUrl !== '' && model !== '' && key !== '', 'test_endpoint_incomplete')
  assert.notEqual(new URL(baseUrl).hostname, '127.0.0.1', 'real_endpoint_required')
  return { baseUrl, model, key }
}

const CANDIDATE_SYSTEM = '输出且只输出 JSON：{"candidates":[plan,plan,plan]}。提出3条均打算完整完成任务的候选，最佳放第一。'
  + '每个plan恰好goal(字符串)、done(布尔)、steps(最多4步)。每步恰好capability、operation、args。'
  + '只允许sandbox.file.write/write，args为path和content字符串；sandbox.file.read/read，args只有path。'
  + '路径逐字采用用户给定相对路径；写入正文为用户指定字符串解码后的原文。不要声明任何已经执行过的动作。每条候选均须包含最终真实读回。'

function worldById(id: string): F0World {
  const world = listF0Worlds().find(item => item.id === id)
  assert.ok(world, `unknown_world:${id}`)
  return world
}

// ---------------------------------------------------------------------------
// 单个（世界 × 臂）单元
// ---------------------------------------------------------------------------
if (process.argv.includes('--arm')) {
  const arm = arg('--arm') as Arm
  assert.ok((ARMS as readonly string[]).includes(arm), `unknown_arm:${String(arm)}`)
  const worldId = arg('--world')!
  const world = worldById(worldId)
  const tasks = generateF0Tasks(world)
  // ⚠️ **离线模式（只给门用）**：不碰端点、用固定候选池；封存的真实运行**不得**用它。
  const offline = process.env.F0_OFFLINE_MODE === '1'
  if (offline) assert.equal(process.env.F0_ALLOW_OFFLINE, '1', 'offline_mode_requires_explicit_marker')
  // ⚠️ 离线模式**不需要**端点凭据（门在容器里跑，那里没有 `.env.test`）。
  const endpoint = offline ? { baseUrl: 'http://offline.invalid/v1', model: 'offline', key: '' } : loadEndpoint()
  // ⚠️ **参数只能来自封存清单**（不许被运行时环境变量改写）：
  //    封存清单是"跑之前写定"的唯一事实源；环境变量与它不一致 ⇒ **拒绝执行**。
  const sealedManifest = JSON.parse(readFileSync(resolve(EVIDENCE_ROOT, 'sealed-manifest.json'), 'utf8')) as {
    budget: { tokenBudget?: { maxCompletionTokensPerRequest: number }; maxRequests: number }
  }
  const maxCompletion = sealedManifest.budget.tokenBudget?.maxCompletionTokensPerRequest
  assert.ok(typeof maxCompletion === 'number' && maxCompletion > 0, 'sealed_max_tokens_missing')
  if (process.env.F0_MAX_COMPLETION_TOKENS !== undefined) {
    assert.equal(Number(process.env.F0_MAX_COMPLETION_TOKENS), maxCompletion, 'sealed_max_tokens_mismatch')
  }
  // ⚠️ **离线模式只给门用**：不碰端点、用固定候选池；封存的真实运行**不得**用它。
  // ⚠️ **预算**：编排器把"剩余额度"写在这里；每个请求**之前**检查。
  const allowance = (() => {
    const path = resolve(EVIDENCE_ROOT, 'allowance.json')
    if (!existsSync(path)) return { requests: Number.POSITIVE_INFINITY, tokens: Number.POSITIVE_INFINITY, deadlineAt: Number.POSITIVE_INFINITY }
    return JSON.parse(readFileSync(path, 'utf8')) as { requests: number; tokens: number; deadlineAt: number }
  })()
  // ⚠️ **不自动赠送规则**：序列从"没有规则"开始，规则只能由被测任务里的真实观察形成。
  const bed = await createObservingFilePlanningBed(`f0-${worldId}-${arm}`)
  const readings: ArmTaskReading[] = []
  let generations = 0
  let tokensTotal = 0
  let actionsTotal = 0
  let budgetStop: string | undefined
  const unrunTasks: string[] = []
  try {
    for (const task of tasks) {
      const started = Date.now()
      const usableBefore = (await bed.usableRules()).length
      const reading: ArmTaskReading = {
        taskId: task.id, phase: task.phase, index: task.index, generation: 'OK', tokens: 0,
        achieved: false, bytesMatch: false, readMatched: false, falseCompletion: false,
        actions: 0, plans: 0, executions: 0, elapsedMs: 0, epistemicFailures: 0,
        usableRulesBefore: usableBefore, usableRulesAfter: usableBefore, planningMode: 'ordinary',
      }
      try {
        // ⚠️ **预算在请求之前检查**（逐请求层面），且**尝试数在 fetch 之前计**。
        if (generations >= allowance.requests) { budgetStop = '请求数上限'; unrunTasks.push(task.id); readings.push(reading); continue }
        if (tokensTotal + maxCompletion > allowance.tokens) { budgetStop = '总 token 上限'; unrunTasks.push(task.id); readings.push(reading); continue }
        if (Date.now() >= allowance.deadlineAt) { budgetStop = '序列时限'; unrunTasks.push(task.id); readings.push(reading); continue }
        // **每臂各自生成**（v1 三臂共享一个池 ⇒ 任务身份配对被破坏）。
        // ⚠️ **尝试数在 fetch 之前计**（网络失败也算一次尝试）。
        generations += 1
        let pool: { candidates?: TaskPlan[] }
        if (offline) {
          // ⚠️ **离线模式（只给门用）**：固定候选池、**不碰端点**。
          pool = { candidates: offlinePool(task) }
        } else {
          const response = await fetch(`${endpoint.baseUrl.replace(/\/$/, '')}/chat/completions`, {
            method: 'POST', signal: AbortSignal.timeout(45_000),
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${endpoint.key}` },
            body: JSON.stringify({ model: endpoint.model, max_tokens: maxCompletion, messages: [
              { role: 'system', content: CANDIDATE_SYSTEM },
              { role: 'user', content: taskTextFor(task) },
            ] }),
          })
          if (!response.ok) throw new Error(`http_${response.status}`)
          const body = await response.json() as { usage?: { total_tokens?: number }; choices?: { message?: { content?: string } }[] }
          reading.tokens = Number(body.usage?.total_tokens ?? 0)
          tokensTotal += reading.tokens
          pool = extractTaskPlanJson(body.choices?.[0]?.message?.content ?? '') as { candidates?: TaskPlan[] }
        }
        const candidates = Array.isArray(pool.candidates) ? pool.candidates : undefined
        if (candidates === undefined || candidates.length !== 3) {
          reading.generation = 'PARSE_FAILED'
          readings.push({ ...reading, elapsedMs: Date.now() - started })
          continue
        }
        // **候选覆盖写检查**：不覆盖 ⇒ 生成失败（不记到臂的达成上）。
        if (!poolCoversGoal(candidates, { path: task.path, content: task.content })) {
          reading.generation = 'NO_COVERAGE'
          readings.push({ ...reading, elapsedMs: Date.now() - started })
          continue
        }
        // **每臂各自生成**（v1 三臂共享一个池 ⇒ 任务身份配对被破坏）。
        let selection: SimulationPlanSelection | undefined
        const staticPick = arm === 'C' ? undefined : selectF0Candidate(arm, candidates.map(toCandidate), { path: task.path, content: task.content })
        // ⚠️ **同一候选池上的"不执行对照"**：三臂各自生成 ⇒ 池不同 ⇒ "三臂选了不同编号"
        //    **不能**证明规则改变了决策；这里额外记下"在 **C 自己的池上** A/B 会选哪个"，
        //    作为**同池**比较的基准（**不执行**任何动作）。
        const counterfactual = arm === 'C'
          ? {
            A: selectF0Candidate('A', candidates.map(toCandidate), { path: task.path, content: task.content }).index,
            B: selectF0Candidate('B', candidates.map(toCandidate), { path: task.path, content: task.content }).index,
          }
          : undefined
        // ⚠️ **普通规划**兜底：无合格规则时走它（动作照常执行 ⇒ 观察得以积累 ⇒ 规则才可能形成）。
        const ordinaryPlanner: TaskPlannerPort = { id: `f0-ordinary-${arm}`, endpointHost: 'cached-test-model', async plan() {
          // ⚠️ 必须同时给 `candidates`：生产入口要的是**候选数组**（缺它会 `invalid_output`）。
          return { ok: true, requestCount: 1, plan: candidates[0]!, candidates }
        } }
        let planner: TaskPlannerPort = arm === 'C'
          ? ordinaryPlanner
          : { id: `f0-arm-${arm}`, endpointHost: 'cached-test-model', async plan() {
            return { ok: true, requestCount: 1, plan: candidates[staticPick!.index]! }
          } }
        let planningMode: 'ordinary' | 'simulation' = 'ordinary'
        let usableRuleIds: string[] = []
        if (arm === 'C') {
          // ⚠️ 走**生产入口** `createSimulationPlanning`：无合格规则时它返回 undefined
          //    ⇒ 外层**继续普通规划**（生产行为）；有合格规则时才把选路交给模拟。
          //    ⚠️ 直接调 `createSimulationTaskPlanner` 会在无规则时 `no_rule` 失败且**不执行动作**
          //    ⇒ 冷启动会**死锁**（规则永远形成不了）。
          const production = createSimulationPlanning({
            ...bed.modelOptions, registry: bed.registry, candidatePlanner: ordinaryPlanner,
            // ⚠️ **接通既有选择回调** ⇒ 能读到**实际选中编号与理由**（之前拿不到）。
            onSelection: value => { selection = value },
          })
          const planned = await production(taskTextFor(task))
          if (planned) {
            planner = planned.planner
            planningMode = 'simulation'
            // 当时的**规则资格快照**（哪些规则参与了这次选路）。
            usableRuleIds = [...planned.usableRuleIds]
          }
        }
        // ⚠️ **开着原生观察** ⇒ 真实执行反馈会推进规则生命周期（v1 没开，等于没在学习）。
        const outcome = await bed.run(planner, { text: taskTextFor(task), observe: true })
        const scored = scoreFileTask(outcome, { root: bed.root, path: task.path, content: task.content })
        readings.push({
          ...reading, ...scored,
          actions: outcome.actionsUsed, plans: outcome.plansUsed, executions: outcome.results.length,
          elapsedMs: Date.now() - started, epistemicFailures: outcome.epistemicFailures ?? 0,
          usableRulesAfter: (await bed.usableRules()).length,
          planningMode,
          ...(usableRuleIds.length === 0 ? {} : { usableRuleIds }),
          ...(counterfactual === undefined ? {} : { counterfactualOnOwnPool: counterfactual }),
          ...(staticPick === undefined ? {} : { selectedIndex: staticPick.index, selectionReason: staticPick.reason }),
          ...(selection === undefined ? {} : { selectedIndex: selection.selectedIndex, selectionReason: selection.reason }),
        })
        actionsTotal += outcome.actionsUsed
      } catch (error) {
        readings.push({ ...reading, generation: 'TRANSPORT_FAILED',
          error: (error instanceof Error ? error.message : String(error)).slice(0, 180), elapsedMs: Date.now() - started })
      }
    }
    const report: ArmUnitReport = {
      worldId, arm, tasks: readings, generations, tokens: tokensTotal, actions: actionsTotal,
      usableRulesAtEnd: (await bed.usableRules()).length,
      ...(budgetStop === undefined ? {} : { budgetStop }),
      unrunTasks,
      offline,
    }
    const outPath = resolve(EVIDENCE_ROOT, `unit-${worldId}-${arm}.json`)
    mkdirSync(resolve(outPath, '..'), { recursive: true })
    writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  } finally { await bed.stop() }
} else if (process.argv.includes('--seal')) {
  // -------------------------------------------------------------------------
  // 封存（零请求）
  // -------------------------------------------------------------------------
  const listText = readFileSync(LIST_PATH, 'utf8')
  const list = JSON.parse(listText) as F0List
  assert.equal(list.version, 'f0-execution-list@4')
  const worlds = listF0Worlds()
  const tasks = worlds.flatMap(world => generateF0Tasks(world))
  assert.equal(tasks.length, list.size.uniqueTasks)
  assert.equal(list.size.uniqueTasks, list.size.worlds * list.size.tasksPerWorld)
  assert.equal(list.size.units, list.size.worlds * list.size.arms)
  assert.equal(list.size.generations, list.size.units * list.size.tasksPerWorld)
  const readDigest = (name: string) => {
    const path = resolve(EVIDENCE_DIR, name)
    return existsSync(path) ? hash(readFileSync(path, 'utf8')) : 'MISSING'
  }
  const gateReadings = {
    documentQuestionGate: readDigest('document-question-gate.json'),
    fullCi: readDigest('ci-run.json'),
    preflight: readDigest('preflight.log'),
    postflight: readDigest('postflight.log'),
  }
  const missing = Object.entries(gateReadings).filter(([, value]) => value === 'MISSING').map(([name]) => name)
  assert.equal(missing.length, 0, `gate_readings_missing:${missing.join(',')}`)
  const endpoint = loadEndpoint()
  const manifest = {
    kind: 'f0-learning@3',
    sealedAt: new Date().toISOString(),
    startMarker: hash(`${Date.now()}:${process.pid}:${list.version}`),
    protocol: { id: 'cognitive-evaluation@1', sha256: hash(readFileSync(PROTOCOL_PATH, 'utf8')) },
    list: { version: list.version, sha256: hash(listText) },
    core: { sha256: hash(readFileSync(CORE_PATH, 'utf8')) },
    runner: { sha256: hash(readFileSync(LIVE_PATH, 'utf8')) },
    bed: { sha256: hash(readFileSync(BED_PATH, 'utf8')) },
    endpoint: { baseUrlHost: new URL(endpoint.baseUrl).host, model: endpoint.model, apiKeyPresent: true, apiKeyLength: endpoint.key.length },
    identity: {
      sourceFingerprint: process.env.F0_SOURCE_FINGERPRINT ?? 'UNBOUND',
      imageDigest: process.env.F0_IMAGE_DIGEST ?? 'UNBOUND',
    },
    gateReadings,
    units: worlds.flatMap(world => ARMS.map(arm => ({ unit: `${world.id}:${arm}`, worldId: world.id, arm, tasks: generateF0Tasks(world).map(task => task.id) }))),
    budget: list.budget,
    assembly: 'world x arm isolation; no gifted rule; native observation on; per-arm own generation',
    note: '清单在任何请求之前写定；--run 先核对以上摘要，变了就拒绝运行。',
  }
  mkdirSync(EVIDENCE_ROOT, { recursive: true })
  const path = resolve(EVIDENCE_ROOT, 'sealed-manifest.json')
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  console.log(`sealed -> ${path}`)
  console.log(`units=${String(manifest.units.length)} tasks=${String(tasks.length)} generations=${String(list.size.generations)} model=${endpoint.model} host=${manifest.endpoint.baseUrlHost} key=present(len ${String(endpoint.key.length)})`)
} else if (process.argv.includes('--run')) {
  // -------------------------------------------------------------------------
  // 执行（真实模型 + 世界×臂隔离）
  // -------------------------------------------------------------------------
  assert.equal(process.env.DSH_TEST_MODEL_WRAPPER, '1', 'real_test_model_wrapper_required')
  assert.ok(process.env.SERVERSIM_MARKER?.startsWith('lg-serversim@'), 'serversim_required')
  const manifestPath = resolve(EVIDENCE_ROOT, 'sealed-manifest.json')
  assert.ok(existsSync(manifestPath), `missing_seal:${manifestPath}`)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    sealedAt: string; startMarker: string
    protocol: { sha256: string }; list: { sha256: string }; core: { sha256: string }
    runner: { sha256: string }; bed: { sha256: string }
    endpoint: { baseUrlHost: string; model: string }
    units: Array<{ unit: string; worldId: string; arm: string; tasks: string[] }>
    budget: F0List['budget']
  }
  const drift: string[] = []
  const compare = (name: string, sealed: string, current: string) => { if (sealed !== current) drift.push(`${name}: ${sealed} -> ${current}`) }
  compare('protocol', manifest.protocol.sha256, hash(readFileSync(PROTOCOL_PATH, 'utf8')))
  compare('list', manifest.list.sha256, hash(readFileSync(LIST_PATH, 'utf8')))
  compare('core', manifest.core.sha256, hash(readFileSync(CORE_PATH, 'utf8')))
  compare('runner', manifest.runner.sha256, hash(readFileSync(LIVE_PATH, 'utf8')))
  compare('bed', manifest.bed.sha256, hash(readFileSync(BED_PATH, 'utf8')))
  assert.equal(drift.length, 0, `seal_drift:${drift.join('; ')}`)
  const endpoint = loadEndpoint()
  assert.equal(new URL(endpoint.baseUrl).host, manifest.endpoint.baseUrlHost, 'endpoint_host_mismatch')
  assert.equal(endpoint.model, manifest.endpoint.model, 'model_mismatch')
  const admin = process.env.LG_SIM_PGTEST_ADMIN_URL!
  assert.ok(admin, 'isolated_pgtest_admin_required')
  const tokenCap = manifest.budget.tokenBudget?.maxTotalTokens ?? 250_000
  const directory = resolve(EVIDENCE_ROOT, `run-${manifest.startMarker.slice(0, 12)}`)
  mkdirSync(directory, { recursive: true })
  closeSync(openSync(resolve(directory, 'started.lock'), 'wx'))
  const units: ArmUnitReport[] = []
  let totalTokens = 0
  let totalGenerations = 0
  let status = 'RUNNING'
  /** 预算停止（单元级或单元内）⇒ 整体状态降为 INCOMPLETE。 */
  let budgetStopReason: string | undefined
  /** 未运行的单元/任务（保留，不隐藏）。 */
  const unrunUnits: Array<{ unit: string; tasks: string[] }> = []
  const unrunTasks: string[] = []
  const perWorldMetrics = () => {
    const out: Record<string, unknown> = {}
    for (const world of listF0Worlds()) {
      const arms: Record<string, unknown> = {}
      for (const arm of ARMS) {
        const unit = units.find(item => item.worldId === world.id && item.arm === arm)
        const tasks = unit?.tasks ?? []
        arms[arm] = {
          achieved: tasks.filter(item => item.achieved).length,
          actions: unit?.actions ?? 0,
          usableRulesAtEnd: unit?.usableRulesAtEnd ?? 0,
          ruleFormationAfterTask: tasks.findIndex(item => item.usableRulesAfter > 0),
        }
      }
      out[world.id] = arms
    }
    return out
  }
  const persist = () => writeFileSync(resolve(directory, 'report.json'), JSON.stringify({
    status, sealedAt: manifest.sealedAt, startMarker: manifest.startMarker,
    units: units.length, generations: totalGenerations, totalTokens, tokenCap,
    // ⚠️ **预算停止**：明确标为**未完成**，并保留**未运行的单元/任务**（不隐藏、不补采）。
    budgetStop: budgetStopReason ?? null,
    unrunUnits: unrunUnits.map(item => item.unit),
    unrunTasks: unrunTasks,
    reports: units,
    metrics: {
      perArm: Object.fromEntries(ARMS.map(arm => {
        const list = units.filter(unit => unit.arm === arm)
        const tasks = list.flatMap(unit => unit.tasks)
        return [arm, {
          tasks: tasks.length,
          achieved: tasks.filter(item => item.achieved).length,
          falseCompletion: tasks.filter(item => item.falseCompletion).length,
          generationFailures: tasks.filter(item => item.generation !== 'OK').length,
          actions: list.reduce((sum, unit) => sum + unit.actions, 0),
          usableRulesAtEnd: list.map(unit => unit.usableRulesAtEnd),
        }]
      })),
      perWorld: perWorldMetrics(),
    },
    execution: 'serversim/simhost', database: 'pgtest: one fresh migrated database + role per (world, arm)',
    productionOpened: false,
  }, null, 2))
  try {
    for (const unit of manifest.units) {
      // ⚠️ **逐请求层面的预算**：剩余额度写进 `allowance.json` ⇒ 单元内部每个请求**之前**检查。
      if (totalTokens >= tokenCap) {
        budgetStopReason = '总 token 上限（单元级）'
        unrunUnits.push(unit)
        units.push({ worldId: unit.worldId, arm: unit.arm as Arm, tasks: [], generations: 0, tokens: 0, actions: 0,
          usableRulesAtEnd: 0, unrunTasks: unit.tasks, offline: false })
        continue
      }
      writeFileSync(resolve(EVIDENCE_ROOT, 'allowance.json'), JSON.stringify({
        requests: Math.max(0, manifest.budget.sequenceModelRequests - totalGenerations),
        tokens: Math.max(0, tokenCap - totalTokens),
        deadlineAt: Date.now() + manifest.budget.sequenceWallClockMs,
      }))
      const saved = process.argv
      try {
        process.argv = [saved[0]!, saved[1]!, '--arm', unit.arm, '--world', unit.worldId]
        await runPreparedPgGateInInstance(admin, `f0-${unit.worldId}-${unit.arm}`, 'scripts/cognitive/f0-learning-live.ts')
      } finally { process.argv = saved }
      const report = JSON.parse(readFileSync(resolve(EVIDENCE_ROOT, `unit-${unit.worldId}-${unit.arm}.json`), 'utf8')) as ArmUnitReport
      units.push(report)
      totalGenerations += report.generations
      totalTokens += report.tokens
      // ⚠️ 单元内部若因预算停止 ⇒ **保留未运行任务**，并把整体状态降为 **INCOMPLETE**（不写 COMPLETE）。
      if (report.budgetStop !== undefined) {
        budgetStopReason = `单元内预算停止：${report.budgetStop}`
        unrunTasks.push(...report.unrunTasks)
        unrunUnits.push({ unit: unit.unit, tasks: report.unrunTasks })
      }
      persist()
      console.log(`UNIT ${unit.unit} generations=${String(report.generations)} tokens=${String(report.tokens)} actions=${String(report.actions)} rulesAtEnd=${String(report.usableRulesAtEnd)}${report.budgetStop === undefined ? '' : ` budgetStop=${report.budgetStop}`}`)
    }
    // ⚠️ 只有**全部单元都跑完**才写 COMPLETE；有任何预算停止 ⇒ **INCOMPLETE**。
    status = unrunUnits.length === 0 && budgetStopReason === undefined ? 'COMPLETE' : 'INCOMPLETE'
  } catch (error) {
    status = 'FAIL'
    console.error(`F0 stopped: ${(error as Error).message.slice(0, 180)}`)
  }
  persist()
  console.log(`f0 learning v2: ${status}; ${directory}`)
  process.exitCode = status === 'COMPLETE' ? 0 : 1
} else {
  throw new Error('usage: --seal | --run | --arm <A|B|C> --world <worldId>')
}
