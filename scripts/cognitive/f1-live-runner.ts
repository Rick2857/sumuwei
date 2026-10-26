/**
 * **G8：F1 正式运行器（`--seal` / `--run` / `--unit`）**
 *
 * ============================================================================
 *  它是什么 / 不是什么
 * ============================================================================
 *  · **是**：预注册草案 `f1-qualified-veto-dev@1` 的真实模型执行器。同一个共同三臂工厂
 *    （`f1-three-arm-factory.ts`）在**每臂独立迁移库 / 角色 / 文件根**里连续跑 8 题；
 *    三臂的**所有**模型调用（候选生成、轮后记忆、反思尾链）都穿过**同一个**请求记账口
 *    （`createRequestMeter`）。
 *  · **不是**：生产装配、生产激活、收益结论。`--seal` **零请求**；`--run` 必须先有
 *    含运行授权的封存清单 + 显式授权标记，本轮**没有**授权。
 *
 * ============================================================================
 *  G8 五条判据落在哪里
 * ============================================================================
 *  ① 预算请求前计尝试 —— `meter.send()` 先判剩余请求数/token/截止时间，再 `+1` 尝试，再 transport
 *  ② 逐请求检查        —— 同上；剩余 token 小于单请求上限时把该请求 max_tokens 缩到剩余量
 *  ③ usage 缺失不补 0  —— `chargeForUsage()`：读不到 usage 就按输出上限保守计费并标 `usageMissing`
 *  ④ 参数/源码/镜像漂移拒跑 —— `sealIntegrity()` + `assertRunAuthorized()`（运行前逐项比对）
 *  ⑤ started.lock 防重跑 —— `acquireStartedLock()`（`O_EXCL`，第二次运行必拒）
 *
 *  这五条**不在**本文件各自实现一遍，而是调用 `f1-live-runner-guards.ts`（G8 门单独验证它）。
 *
 * ============================================================================
 *  离线模式（**只给门用**）
 * ============================================================================
 *  `F1_OFFLINE_MODE=1` + `F1_ALLOW_OFFLINE=1` ⇒ 用确定性离线 transport（零网络），
 *  只走 `runArmUnit()` 的内部路径；**CLI 的 `--unit` / `--run` 一律拒绝离线标记**。
 *  封存的真实运行**不得**带这些标记（`assertRunAuthorized` 会拦）。
 */

import 'dotenv/config'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createM4Harness } from '../m4-harness.ts'
import { runPreparedPgGateInInstance } from '../postgresql/test-harness.ts'
import { createOpenAiReflectionDraftProvider } from '../../src/infrastructure/model/openai-reflection.ts'
import type { ReflectionDraftProvider } from '../../src/kernel/app/reflection/draft-port.ts'
import {
  createArmBed, ensureWorldDirectories, loadPreregData, simulatorPreconditions,
  type ArmRun, type ArmTaskRow, type F1Arm, type F1OracleEntry, type F1TaskSpec, type PlannerInputSnapshot,
} from './f1-three-arm-factory.ts'
import {
  F1_ABORT_POLICY, F1_REQUEST_PARAMETERS, F1_TASK_BUDGET,
  F1GuardError, accountUnitOutcome, acquireStartedLock, appendTaskJournalEntry, assertRunAuthorized, isClientAbort,
  buildSealedManifest, canStartUnitWithin, collectSealBindings, createRequestMeter, deriveUnitTimeoutMs,
  endpointMetadataDigest, endpointMetadataFromEnvText, envValuesFromEnvText,
  fileDigestOrMissing, loadSealedManifest, readAttemptLedger, readTaskJournal, sealIntegrity, sha256Text,
  type F1AttemptLedgerSummary, type F1RequestAllowance, type F1RequestMeter, type F1RequestPurpose,
  type F1SealedManifest, type F1SealBindingId, type F1SealCurrent, type F1SealGateReading,
  type F1MeterTransport, type F1MeteredCall, type F1GuardCode,
} from './f1-live-runner-guards.ts'

const ARMS: readonly F1Arm[] = ['A', 'B', 'C']
/** 评测侧规划器超时（产品默认 45 s 不变；实测有个别请求在 45 s 边界被 abort）。 */
export const F1_PLANNER_TIMEOUT_MS = 90_000
/** 单请求硬上限：覆盖 memory / reflection 这类没有自带超时的调用。 */
export const F1_REQUEST_HARD_TIMEOUT_MS = 120_000
const REPO = resolve('.')
const DATA_ROOT = resolve('docs/architecture/f1-preregistration-20261024')
const EVIDENCE_ROOT = resolve(process.env.F1_EVIDENCE_ROOT ?? 'artifacts/local/f1-live')
const SEAL_PATH = resolve(EVIDENCE_ROOT, 'sealed-manifest.json')
const GATE_BUNDLE_PATH = resolve(EVIDENCE_ROOT, 'gate-bundle.json')
const ALLOWANCE_PATH = resolve(EVIDENCE_ROOT, 'allowance.json')
const RUNNER_PATH = resolve('scripts/cognitive/f1-live-runner.ts')

/** 封存必须绑定的路径（闭集见 `F1_REQUIRED_SEAL_BINDINGS`；**全部为仓库相对路径**，宿主/容器可移植）。 */
const SEAL_BINDING_PATHS: Record<F1SealBindingId, string> = {
  preregistration: 'docs/architecture/Cognitive-Capability-F1-Preregistration-2026-10-24.md',
  worlds: 'docs/architecture/f1-preregistration-20261024/worlds.json',
  tasks: 'docs/architecture/f1-preregistration-20261024/tasks.json',
  oracle: 'docs/architecture/f1-preregistration-20261024/oracle.json',
  executionDraft: 'docs/architecture/f1-preregistration-20261024/execution-draft.json',
  feasibilityDecision: 'docs/architecture/f1-preregistration-20261024/feasibility-decision.json',
  factory: 'scripts/cognitive/f1-three-arm-factory.ts',
  parityGate: 'scripts/cognitive/f1-three-arm-parity-verify.ts',
  negativeControls: 'scripts/cognitive/f1-prereg-negative-controls-verify.ts',
  runner: 'scripts/cognitive/f1-live-runner.ts',
  guards: 'scripts/cognitive/f1-live-runner-guards.ts',
  feasibilityDecisionDoc: 'docs/architecture/Cognitive-Capability-F1-Feasibility-Decision-2026-10-25.md',
}

/** 相对仓库根的展示路径（封存清单里**不写宿主绝对路径**，否则容器内无法复核）。 */
const repoRelative = (value: string): string =>
  value.startsWith(REPO) ? value.slice(REPO.length + 1).split('\\').join('/') : value

const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}

// ---------------------------------------------------------------------------
// 端点：只读非机密元数据；凭据取值**只**用于真实请求，不落盘、不打印
// ---------------------------------------------------------------------------

function testEnvFilePath(): string {
  for (const candidate of [process.env.F1_TEST_ENV_FILE, process.env.TEST_MODEL_ENV_FILE,
    '/opt/serversim/env/.env.test', '.env.test']) {
    if (candidate !== undefined && candidate.trim() !== '' && existsSync(candidate)) return candidate
  }
  return fail('endpoint_invalid', '找不到测试端点配置文件（F1_TEST_ENV_FILE / TEST_MODEL_ENV_FILE / .env.test）')
}

function loadEndpoint(): { metadata: { host: string; model: string; apiKeyPresent: boolean; apiKeyLength: number }, baseUrl: string, model: string, key: string } {
  const text = readFileSync(testEnvFilePath(), 'utf8')
  const metadata = endpointMetadataFromEnvText(text)
  const values = envValuesFromEnvText(text)
  const baseUrl = (values.OPENAI_BASE_URL ?? '').trim().replace(/\/+$/, '')
  const model = (values.OPENAI_LARGE_MODEL ?? values.OPENAI_SMALL_MODEL ?? '').trim()
  const key = (values.OPENAI_API_KEY ?? '').trim()
  if (key === '') fail('endpoint_invalid', 'OPENAI_API_KEY 缺失（真实运行需要测试端点凭据）')
  return { metadata, baseUrl, model, key }
}

/** 失败关闭的唯一出口：TS 需要**函数声明**才能做 never 收窄。 */
function fail(code: F1GuardCode, detail: string): never {
  throw new F1GuardError(code, detail)
}

// ---------------------------------------------------------------------------
// 离线 transport（只给门用）：从任务文本解析目标/正文/标记，给出确定性候选
// ---------------------------------------------------------------------------

export function createOfflineTransport(options: { omitUsage?: boolean } = {}): F1MeterTransport {
  /*
   * `F1_OFFLINE_SLOW_MS`：**只给门**用的慢速离线传输（每个请求先睡 N 毫秒）。
   * 用途：真实 SIGKILL 测试 —— 在请求在途时把单元子进程杀掉，验证
   * ① 请求账本能判"在途崩溃" ② 任务账本能取回已完成的题。
   */
  const slowMs = Number(process.env.F1_OFFLINE_SLOW_MS ?? 0)
  const reply = (content: string, promptTokens = 11, completionTokens = 7): { status: number, text: string } =>
    ({ status: 200, text: JSON.stringify({ choices: [{ message: { content } }],
      ...(options.omitUsage === true ? {} : { usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens } }) }) })
  return async (purpose: F1RequestPurpose, request) => {
    if (slowMs > 0) await new Promise(resolveWait => setTimeout(resolveWait, slowMs))
    const body = JSON.parse(String(request.init.body ?? '{}')) as { messages?: { role?: string, content?: string }[] }
    if (purpose === 'candidate') {
      const userText = String(body.messages?.at(-1)?.content ?? '')
      const systemText = String(body.messages?.[0]?.content ?? '')
      const path = /相对路径\s+([^\s。]+)。/.exec(userText)?.[1]
      const marker = /条件标记\s+([^\s，]+)，/.exec(userText)?.[1]
      const jsonRaw = /再读回核对：("(?:[^"\\]|\\.)*")/.exec(userText)?.[1]
      if (path === undefined || marker === undefined || jsonRaw === undefined) {
        return reply(JSON.stringify({ candidates: [] }))
      }
      const content = JSON.parse(jsonRaw) as string
      // ⚠️ **受限模拟候选**只允许动目标（产品约束）；普通规划可以读一次授权标记。
      const simulation = systemText.includes('当前为受限模拟候选')
      const steps = [
        { capability: 'sandbox.file.read', operation: 'read', args: { path: marker } },
        { capability: 'sandbox.file.write', operation: 'write', args: { path, content } },
        { capability: 'sandbox.file.read', operation: 'read', args: { path } },
      ]
      const candidate = { goal: 'offline-live-fixture', done: true, steps: simulation ? steps.slice(1) : steps }
      return reply(JSON.stringify({ candidates: [candidate] }))
    }
    if (purpose === 'post_turn_memory') return reply('{"destination":"none","decisions":[]}')
    // 反思：固定 `{}` 与 G1 的离线草案同形（会被原生格式校验拒收，不代表有效反思）
    return reply('{}')
  }
}

// ---------------------------------------------------------------------------
// 三臂的**计量端口**：候选生成 / 轮后记忆 / 反思尾链都从这里出去
// ---------------------------------------------------------------------------

export interface F1MeteredArmPorts {
  /** 传给 `createOpenAiTaskPlanner` 的 fetch（工厂内部的候选生成） */
  fetchImpl: typeof fetch
  /** 传给 `PostTurnModelMemoryConsumer` 的 invoke */
  memoryInvoke: (prompt: string) => Promise<string>
  /** 传给反思尾链的 provider */
  reflectionProvider: ReflectionDraftProvider
}

/**
 * 建三臂的计量端口。
 *
 * ⚠️ 三个角色调用**必须**共用同一个 `meter`：分开建 meter 会让"全模型预算"失效。
 * ⚠️ 所有请求 body 的 `max_tokens` 由 meter 统一改写（只许 ≤ 封存上限）。
 */
export function createMeteredArmPorts(options: {
  endpoint: { baseUrl: string; model: string; key: string; host: string }
  meter: F1RequestMeter
  maxCompletionTokens: number
}): F1MeteredArmPorts {
  const { endpoint, meter, maxCompletionTokens } = options
  const rewriteBody = (init: RequestInit | undefined): RequestInit => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    body.model = endpoint.model
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Authorization: `Bearer ${endpoint.key}` }
    return { ...init, headers, body: JSON.stringify(body) }
  }
  const meteredFetch = (purpose: F1RequestPurpose) => async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const result = await meter.send(purpose, { url: `${endpoint.baseUrl}/chat/completions`, init: rewriteBody(init) })
    return new Response(result.text, { status: result.status, headers: { 'Content-Type': 'application/json' } })
  }
  const memoryInvoke = async (prompt: string): Promise<string> => {
    const result = await meter.send('post_turn_memory', {
      url: `${endpoint.baseUrl}/chat/completions`,
      init: { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${endpoint.key}` },
        body: JSON.stringify({ model: endpoint.model, messages: [{ role: 'user', content: prompt }],
          temperature: F1_REQUEST_PARAMETERS.temperatureRequested, max_tokens: maxCompletionTokens, stream: false }) },
    })
    try {
      const parsed = JSON.parse(result.text) as { choices?: { message?: { content?: unknown } }[] }
      const content = parsed.choices?.[0]?.message?.content
      return typeof content === 'string' ? content : ''
    } catch {
      return ''
    }
  }
  const reflectionProvider = createOpenAiReflectionDraftProvider({
    env: { OPENAI_API_KEY: endpoint.key, OPENAI_BASE_URL: endpoint.baseUrl, OPENAI_SMALL_MODEL: endpoint.model },
    fetchImpl: meteredFetch('reflection') as unknown as typeof fetch,
  })
  return { fetchImpl: meteredFetch('candidate') as unknown as typeof fetch, memoryInvoke, reflectionProvider }
}

// ---------------------------------------------------------------------------
// 单元执行：共同三臂工厂 + 单一请求记账口
// ---------------------------------------------------------------------------

export interface UnitTaskReading extends ArmTaskRow {
  cost: {
    requests: number
    chargedTokens: number
    reportedTokens: number
    usageMissing: number
    purposes: F1RequestPurpose[]
  }
}

export interface UnitReport {
  schema: 'f1-live-unit@1'
  unit: string
  worldId: string
  arm: F1Arm
  provider: 'live' | 'offline-fixture'
  offline: boolean
  modelRequests: number
  tasks: UnitTaskReading[]
  unrunTasks: string[]
  budgetStop: string | null
  goalAchieved: number
  achievedDenominator: number
  falseCompletion: { observable: boolean, count: number }
  qualification: { before: { readback: boolean, precondition: boolean }, firstJoint: number | null, firstConsumption: number | null }
  actions: number
  plans: number
  cost: ReturnType<F1RequestMeter['summary']> & { maxCompletionTokens: number, overshoot: number }
  calls: F1MeteredCall[]
  /** **每次尝试立即落盘**的请求账本（单元崩溃后仍可对账） */
  ledgerPath: string
  /** 任务账本（第二本账）：每题开始/结束各一行；崩溃后可取回已完成题 */
  taskJournalPath: string
  ledger: F1AttemptLedgerSummary
  plannerInputs: PlannerInputSnapshot[]
  observerErrors: string[]
  reflectionRuns: number
  memoryReadings: ArmRun['memoryReadings']
  endpoint: { host: string, model: string } | null
  startedAt: string
  finishedAt: string
  elapsedMs: number
  productionOpened: false
  notes: string[]
}

const costZero = () => ({ requests: 0, chargedTokens: 0, reportedTokens: 0, usageMissing: 0, purposes: [] as F1RequestPurpose[] })

/** 把一个（世界 × 臂）单元跑完；**不**做授权/封存检查（那是 CLI 的职责）。 */
export async function runArmUnit(options: {
  worldId: string
  arm: F1Arm
  tasks?: readonly F1TaskSpec[]
  oracle?: readonly F1OracleEntry[]
  allowance: F1RequestAllowance
  transportKind: 'live' | 'offline-fixture'
  offlineOmitUsage?: boolean
  evidenceDir?: string
  reportPath?: string
  /** 请求账本路径（**每次尝试立即 append**；缺省由 evidenceDir 推导） */
  ledgerPath?: string
  /** 政策 A：客户端 abort 的有界未确认成本事件上限（缺省取常量 8） */
  maxUnverifiedCostEvents?: number
  endpointOverride?: { baseUrl: string, model: string, key: string, host: string }
}): Promise<UnitReport> {
  const { worlds, tasks: allTasks, oracle: allOracle } = loadPreregData(DATA_ROOT)
  const world = worlds.find(item => item.worldId === options.worldId)
  if (world === undefined) fail('invalid_parameter', `未知世界：${options.worldId}`)
  const unitTasks = options.tasks ?? allTasks.filter(task => task.worldId === options.worldId)
  const unitOracle = options.oracle ?? allOracle.find(item => item.worldId === options.worldId)!.schedule
  const maxCompletionTokens = F1_REQUEST_PARAMETERS.maxCompletionTokens
  const offline = options.transportKind === 'offline-fixture'
  if (offline) assert.ok(process.env.F1_ALLOW_OFFLINE === '1', 'offline_mode_requires_explicit_marker')

  const endpoint = offline
    ? { baseUrl: 'https://offline.invalid/v1', model: 'offline-fixture', key: 'offline-fixture', host: 'offline.invalid' }
    : options.endpointOverride ?? (() => { const loaded = loadEndpoint(); return { baseUrl: loaded.baseUrl, model: loaded.model, key: loaded.key, host: loaded.metadata.host } })()
  const transport: F1MeterTransport = offline
    ? createOfflineTransport({ ...(options.offlineOmitUsage === true ? { omitUsage: true } : {}) })
    : async (_purpose, request) => {
      /*
       * ⚠️ **硬性单请求超时**（与调用方 signal 叠加）：否则 memory / reflection 这类
       *    没有自带超时的调用可能无限挂起，最终由单元子进程超时杀掉 ⇒ 在途崩溃 + 浪费整轮。
       *    超时/阶段失败都走 `transport_failed`（成本未确认）——**不**假装成功。
       */
      const hardTimeout = AbortSignal.timeout(F1_REQUEST_HARD_TIMEOUT_MS)
      const signal = request.init.signal === undefined || request.init.signal === null
        ? hardTimeout
        : AbortSignal.any([request.init.signal, hardTimeout])
      const response = await fetch(request.url, { ...request.init, signal })
      const text = await response.text()
      if (!response.ok) throw new Error(`http_${response.status}`)
      return { status: response.status, text }
    }

  let currentTag: { taskId: string | null, ordinal: number | null } = { taskId: null, ordinal: null }
  const evidenceDirForLedger = options.evidenceDir ?? EVIDENCE_ROOT
  mkdirSync(evidenceDirForLedger, { recursive: true })
  const ledgerPath = options.ledgerPath ?? resolve(evidenceDirForLedger, `ledger-${options.worldId}-${options.arm}.jsonl`)
  /*
   * 任务账本（**第二本账**）：请求账本只记"发了哪些请求"，不记"哪几题已有结论"。
   * 单元子进程若在请求在途时被杀，请求账本能对账，但**已完成的题会全部丢失**。
   * 因此每题开始/结束各落一行；崩溃后可按账本把已完成题**原样取回**（不重跑、不补采）。
   */
  const taskJournalPath = resolve(evidenceDirForLedger, `tasks-${options.worldId}-${options.arm}.jsonl`)
  writeFileSync(taskJournalPath, '', 'utf8')
  // ⚠️ 每个单元开始前清空自己的账本；之后**每次尝试立即 append**（崩溃也留痕）。
  writeFileSync(ledgerPath, '', 'utf8')
  const meter = createRequestMeter({
    allowance: options.allowance, maxCompletionTokens, transport,
    maxRequestsPerTask: F1_TASK_BUDGET.maxModelRequests,
    // 政策 A：客户端 abort 记"有界未确认成本"，事件数 ≤ K 时继续
    maxUnverifiedCostEvents: options.maxUnverifiedCostEvents ?? F1_ABORT_POLICY.maxUnverifiedCostEvents,
    taskTag: () => currentTag,
    // ⚠️ 账本由**计量器自己**写（发出前先记 attempt_started）：调用方写就只能"返回后"记 ⇒
    //    请求在途崩溃（进程死在返回前）会没有记录 ⇒ 成本被少报。
    ledgerPath,
  })

  // 三臂**所有**模型调用都从这里出去：候选 / 轮后记忆 / 反思（共用一个 meter）。
  const ports = createMeteredArmPorts({ endpoint, meter, maxCompletionTokens })

  const h = await createM4Harness({ label: `f1-live-${options.worldId}-${options.arm}`, userId: 'Alex' })
  const evidenceDir = options.evidenceDir ?? EVIDENCE_ROOT
  mkdirSync(evidenceDir, { recursive: true })
  const root = mkdtempSync(resolve(evidenceDir, `files-${options.worldId}-${options.arm}-`))
  ensureWorldDirectories(root, world.knownDirectories)
  const startedAt = new Date()
  const startedMs = Date.now()
  const observerErrors: string[] = []
  try {
    const rows: UnitTaskReading[] = []
    const rowCosts = new Map<string, UnitTaskReading['cost']>()
    let beforeCounters = { requests: 0, charged: 0, calls: 0, reported: 0, missing: 0 }
    const bed = createArmBed({
      arm: options.arm, h, world, tasks: unitTasks, oracle: unitOracle, db: h.db,
      characterId: h.kernel.characterId, userId: h.userId, root,
      budget: { maxActions: F1_TASK_BUDGET.maxActions, maxPlans: F1_TASK_BUDGET.maxPlans, deadlineMs: F1_TASK_BUDGET.deadlineMs },
      plannerTimeoutMs: F1_PLANNER_TIMEOUT_MS,
      candidatePlans: () => [],
      fetchImpl: ports.fetchImpl,
      memoryInvoke: ports.memoryInvoke,
      reflectionProvider: ports.reflectionProvider,
      onTaskStart: task => {
        currentTag = { taskId: task.taskId, ordinal: task.ordinal }
        beforeCounters = { requests: meter.requestsAttempted, charged: meter.tokensCharged, calls: meter.calls.length,
          reported: meter.tokensReported, missing: meter.usageMissingCount }
        appendTaskJournalEntry(taskJournalPath, {
          phase: 'task_started', unit: `${options.worldId}:${options.arm}`, worldId: options.worldId,
          arm: options.arm, taskId: task.taskId, ordinal: task.ordinal, at: Date.now(),
        })
      },
      onTaskEnd: (task, taskRow) => {
        const calls = meter.calls.slice(beforeCounters.calls)
        appendTaskJournalEntry(taskJournalPath, {
          phase: 'task_finished', unit: `${options.worldId}:${options.arm}`, worldId: options.worldId,
          arm: options.arm, taskId: task.taskId, ordinal: task.ordinal, at: Date.now(), row: taskRow,
        })
        rowCosts.set(task.taskId, {
          requests: meter.requestsAttempted - beforeCounters.requests,
          chargedTokens: meter.tokensCharged - beforeCounters.charged,
          reportedTokens: meter.tokensReported - beforeCounters.reported,
          usageMissing: meter.usageMissingCount - beforeCounters.missing,
          purposes: [...new Set(calls.map(call => call.purpose))],
        })
        currentTag = { taskId: null, ordinal: null }
      },
      shouldStop: () => meter.budgetStopReason(),
    })
    const run = await bed.run()
    observerErrors.push(...bed.observerErrors)
    for (const row of run.rows) rows.push({ ...row, cost: rowCosts.get(row.taskId) ?? costZero() })
    const observable = rows.some(row => row.stopped === 'done')
    const ledger = readAttemptLedger(ledgerPath)
    // 预算/成本停止：工厂在下一个任务开始前会停；**单个任务的最后一次**调用造成的停止在这里补记。
    const budgetStop = run.budgetStop ?? meter.budgetStopReason() ?? null
    const report: UnitReport = {
      schema: 'f1-live-unit@1',
      unit: `${options.worldId}:${options.arm}`,
      worldId: options.worldId,
      arm: options.arm,
      provider: offline ? 'offline-fixture' : 'live',
      offline,
      modelRequests: meter.requestsAttempted,
      tasks: rows,
      unrunTasks: run.unrunTasks ?? [],
      budgetStop,
      goalAchieved: rows.filter(row => row.goalAchieved).length,
      achievedDenominator: unitTasks.length,
      falseCompletion: { observable, count: rows.filter(row => row.stopped === 'done' && !row.goalAchieved).length },
      qualification: {
        before: rows[0]?.before ?? { readback: false, precondition: false },
        firstJoint: run.firstJointQualification,
        firstConsumption: run.firstConsumption,
      },
      actions: run.totalActions,
      plans: run.totalPlans,
      cost: { ...meter.summary(), maxCompletionTokens, overshoot: meter.overshoot },
      calls: meter.calls,
      ledgerPath,
      taskJournalPath,
      ledger,
      plannerInputs: run.plannerInputs,
      observerErrors,
      reflectionRuns: run.reflectionRuns.length,
      memoryReadings: run.memoryReadings,
      endpoint: offline ? null : { host: endpoint.host, model: endpoint.model },
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      elapsedMs: Date.now() - startedMs,
      productionOpened: false,
      notes: offline
        ? ['离线确定性 transport（只给门用）：零真实模型请求、零 token 费用']
        : ['真实测试端点；usage 口径见 F1_USAGE_POLICY；usage 缺失/不完整 ⇒ 成本未确认并停止后续请求',
          '每次尝试立即写入请求账本；报告与账本不一致时编排器停止序列'],
    }
    const reportPath = options.reportPath ?? resolve(evidenceDir, `unit-${options.worldId}-${options.arm}.json`)
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    return report
  } finally {
    await h.stop()
  }
}

/** 当前封存状态（跑前逐项比对用）：绑定摘要 / 身份 / 端点 / 参数。 */
function currentSealState(manifest: F1SealedManifest): F1SealCurrent {
  const bindings: Record<string, string> = {}
  for (const binding of manifest.bindings) bindings[binding.id] = fileDigestOrMissing(resolve(binding.path))
  const metadata = endpointMetadataFromEnvText(readFileSync(testEnvFilePath(), 'utf8'))
  return {
    bindings,
    identity: {
      sourceFingerprint: (process.env.F1_SOURCE_FINGERPRINT ?? '').trim() || undefined,
      imageDigest: (process.env.F1_IMAGE_DIGEST ?? '').trim() || undefined,
    },
    endpoint: { ...metadata, metadataSha256: endpointMetadataDigest(metadata) },
    parameters: F1_REQUEST_PARAMETERS,
  }
}

function assertSealedParameterEnvironment(manifest: F1SealedManifest): void {
  if (process.env.F1_MAX_COMPLETION_TOKENS !== undefined) {
    assert.equal(Number(process.env.F1_MAX_COMPLETION_TOKENS), manifest.parameters.maxCompletionTokens,
      'sealed_max_tokens_mismatch：请求参数只能来自封存清单')
  }
  assert.equal(F1_REQUEST_PARAMETERS.maxCompletionTokens, manifest.parameters.maxCompletionTokens, 'sealed_parameters_mismatch')
}

// ---------------------------------------------------------------------------
// 模式：--seal（零请求）
// ---------------------------------------------------------------------------

function runSeal(): void {
  const bundleText = readFileSync(GATE_BUNDLE_PATH, 'utf8')
  const gateBundle = JSON.parse(bundleText) as {
    schema: string
    gates: Array<{ id: string, status: F1SealGateReading['status'], checks: number | null, covers?: string[],
      sources: Array<{ path: string, sha256: string }> }>
  }
  if (gateBundle.schema !== 'f1-gate-bundle@1') {
    throw new F1GuardError('gate_reading_missing', `gate-bundle schema=${gateBundle.schema}`)
  }
  const gateReadings: F1SealGateReading[] = gateBundle.gates.map(gate => {
    const sources = gate.sources.map(source => {
      const digest = fileDigestOrMissing(resolve(source.path))
      if (digest !== source.sha256) {
        throw new F1GuardError('seal_drift', `门读数 ${gate.id} 来源漂移：${source.path} ${source.sha256} -> ${digest}`)
      }
      return { path: source.path, sha256: digest }
    })
    return {
      id: gate.id, status: gate.status, checks: gate.checks, sources,
      ...(gate.covers === undefined ? {} : { covers: gate.covers }),
    }
  })
  const bindings = collectSealBindings(SEAL_BINDING_PATHS)
  const endpoint = loadEndpoint()
  const metadataSha256 = endpointMetadataDigest(endpoint.metadata)
  const { worlds, tasks } = loadPreregData(DATA_ROOT)
  const units = worlds.flatMap(world => ARMS.map(arm => ({
    unit: `${world.worldId}:${arm}`,
    worldId: world.worldId,
    arm,
    tasks: tasks.filter(task => task.worldId === world.worldId).map(task => task.taskId),
  })))
  const manifest = buildSealedManifest({
    protocolId: 'f1-qualified-veto-dev@1',
    sealedAt: new Date().toISOString(),
    bindings,
    identity: {
      sourceFingerprint: (process.env.F1_SOURCE_FINGERPRINT ?? 'UNBOUND').trim(),
      imageDigest: (process.env.F1_IMAGE_DIGEST ?? 'UNBOUND').trim(),
    },
    endpoint: { ...endpoint.metadata, metadataSha256 },
    parameters: F1_REQUEST_PARAMETERS,
    gateBundle: {
      path: repoRelative(GATE_BUNDLE_PATH),
      sha256: sha256Text(bundleText),
    },
    gateReadings,
    budget: { perTask: F1_TASK_BUDGET, sequence: { requests: 432, totalTokens: 2_000_000, wallClockSeconds: 44_520 } },
    policy: F1_ABORT_POLICY,
    units,
    outputPath: repoRelative(EVIDENCE_ROOT),
    authorization: {
      modelCallsAuthorized: process.env.F1_MODEL_CALLS_AUTHORIZED === '1',
      productionActivationAuthorized: false,
      modelRequestsAtSeal: 0,
    },
    notes: [
      '封存函数**不含**任何 fetch/网络调用：封存本身零请求',
      process.env.F1_MODEL_CALLS_AUTHORIZED === '1'
        ? '本清单包含运行授权（用户已明确授权）'
        : '本清单**不含**运行授权；授权后必须重新封存',
      'usage 口径：F1_USAGE_POLICY（usage 缺失按输出上限保守计，绝不补 0）',
    ],
  })
  mkdirSync(EVIDENCE_ROOT, { recursive: true })
  writeFileSync(SEAL_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  console.log(`sealed -> ${SEAL_PATH}`)
  console.log(`status=${manifest.status} units=${String(manifest.units.length)} requests=${String(manifest.budget.sequence.requests)} tokens=${String(manifest.budget.sequence.totalTokens)} wallClock=${String(manifest.budget.sequence.wallClockSeconds)}s startMarker=${manifest.startMarker.slice(0, 12)}`)
  console.log(`endpoint=${manifest.endpoint.host} model=${manifest.endpoint.model} key=present(len ${String(manifest.endpoint.apiKeyLength)}) identity=${manifest.identity.sourceFingerprint === 'UNBOUND' ? 'UNBOUND' : manifest.identity.sourceFingerprint.slice(0, 12)}`)
}

// ---------------------------------------------------------------------------
// 模式：--run（宿主侧编排；真实请求逐单元在隔离库里发生）
// ---------------------------------------------------------------------------

/** 读取编排方登记的"前一次被中止尝试"的已花成本（同一授权预算的已用部分）。 */
function readPriorSpend(): { requests: number, tokens: number, wallClockSeconds: number, note: string } {
  const file = resolve(EVIDENCE_ROOT, 'prior-spend.json')
  if (!existsSync(file)) return { requests: 0, tokens: 0, wallClockSeconds: 0, note: '无前次中止尝试' }
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { requests?: number, tokens?: number, wallClockSeconds?: number, note?: string }
  return {
    requests: Number(parsed.requests ?? 0),
    tokens: Number(parsed.tokens ?? 0),
    wallClockSeconds: Number(parsed.wallClockSeconds ?? 0),
    note: parsed.note ?? '前次中止尝试',
  }
}

async function runSequence(): Promise<void> {
  assert.ok(simulatorPreconditions(), 'serversim_required（真实运行只能在 simhost 内）')
  const manifest = loadSealedManifest(SEAL_PATH)
  const drift = sealIntegrity(manifest, currentSealState(manifest))
  assertRunAuthorized({ manifest, drift, env: process.env })
  assertSealedParameterEnvironment(manifest)
  const adminUrl = (process.env.LG_SIM_PGTEST_ADMIN_URL ?? '').trim()
  assert.ok(adminUrl !== '', 'isolated_pgtest_admin_required')

  const runDir = resolve(EVIDENCE_ROOT, `run-${manifest.startMarker.slice(0, 12)}`)
  mkdirSync(runDir, { recursive: true })
  const lock = acquireStartedLock(runDir, manifest.startMarker)
  // ⚠️ **前一次被中止的尝试也要计入账**（同一授权预算的已花部分）：
  //    否则"本轮 0 请求"会掩盖真实消耗。priorSpend 由编排方按上一轮账本核对后写入。
  const priorSpend = readPriorSpend()
  const deadlineAt = Date.now() + (manifest.budget.sequence.wallClockSeconds - priorSpend.wallClockSeconds) * 1000
  let resumedAfter: string | undefined
  const recoveredTasks: Array<{ unit: string; tasks: number; rows: unknown[] }> = []
  const maxUnverified = manifest.policy?.maxUnverifiedCostEvents ?? F1_ABORT_POLICY.maxUnverifiedCostEvents
  const reports: UnitReport[] = []
  const failedUnits: Array<{ unit: string, error: string, accounting?: Record<string, unknown>, taskJournal?: Record<string, unknown> }> = []
  const unrunUnits: string[] = []
  let budgetStop: string | undefined
  let requestsUsed = 0
  let tokensCharged = 0
  let tokensReported = 0
  let usageMissing = 0
  let costUnverifiable = false
  let status: 'RUNNING' | 'COMPLETE' | 'INCOMPLETE' | 'FAIL' = 'RUNNING'
  const unitLedgerPath = (worldId: string, arm: string): string =>
    resolve(EVIDENCE_ROOT, `ledger-${worldId}-${arm}.jsonl`)
  /** 任务账本（**第二本账**）：崩溃后可把已完成题原样取回。 */
  const unitTaskJournalPath = (worldId: string, arm: string): string =>
    resolve(EVIDENCE_ROOT, `tasks-${worldId}-${arm}.jsonl`)
  const persist = (): void => {
    writeFileSync(resolve(runDir, 'report.json'), `${JSON.stringify({
      schema: 'f1-live-run@1', status, sealedAt: manifest.sealedAt, startMarker: manifest.startMarker,
      /** 封印里的运行授权（G9 用它核对"没有未授权运行"） */
      sealAuthorized: manifest.authorization.modelCallsAuthorized,
      startedLock: lock.path,
      units: manifest.units.length, completedUnits: reports.length, failedUnits, unrunUnits,
      /** 单元在途崩溃时，从**任务账本**取回的已完成题（不重跑、不补采） */
      recoveredTasks,
      budgetStop: budgetStop ?? null,
      budget: manifest.budget.sequence,
      cost: {
        requestsAttempted: requestsUsed,
        tokensCharged,
        tokensReported,
        usageMissingCount: usageMissing,
        costUnverifiable,
        costConfirmed: !costUnverifiable && failedUnits.length === 0,
        requestLimit: manifest.budget.sequence.requests,
        tokenLimit: manifest.budget.sequence.totalTokens,
        /** ⚠️ 同一授权预算的**已花部分**（含前一次被中止的尝试） */
        priorSpend: { requests: priorSpend.requests, tokens: priorSpend.tokens, note: priorSpend.note },
        totalAgainstBudget: {
          requests: requestsUsed + priorSpend.requests,
          tokens: tokensCharged + priorSpend.tokens,
        },
        /** 每个单元的请求账本都单独落盘（崩溃后仍可对账） */
        unitLedgers: manifest.units.map(unit => unitLedgerPath(unit.worldId, unit.arm)),
      },
      reports, productionOpened: false,
      resumedAfter: resumedAfter ?? null,
      policy: manifest.policy ?? F1_ABORT_POLICY,
      measurementScope: 'qualification_veto_and_cost_only',
      benefitClaim: 'MEASUREMENT_NOT_READY（当前八题不是收益协议）',
    }, null, 2)}\n`, 'utf8')
  }
  try {
    const tasksPerUnit = 8
    const unitTimeoutMs = deriveUnitTimeoutMs({ tasksPerUnit, perTaskDeadlineMs: F1_TASK_BUDGET.deadlineMs })
    /*
     * `--resume-after <unit>`：**续跑**（用于基础设施中止后只跑剩余单元）。
     * 约束：被跳过的单元**不重跑**（不补采），它们的已花成本通过 prior-spend.json 结转，
     *       因此"剩余额度"和"累计对账"仍然成立；报告里显式记 `resumedAfter`。
     */
    const resumeAfter = arg('--resume-after')
    let startIndex = 0
    if (resumeAfter !== undefined) {
      const found = manifest.units.findIndex(item => item.unit === resumeAfter)
      if (found < 0) fail('invalid_parameter', `--resume-after 不在封存单元列表里：${resumeAfter}`)
      startIndex = found + 1
      resumedAfter = resumeAfter
    }
    for (let unitIndex = startIndex; unitIndex < manifest.units.length; unitIndex += 1) {
      const unit = manifest.units[unitIndex]!
      const remainingRequests = manifest.budget.sequence.requests - requestsUsed - priorSpend.requests
      const remainingTokens = manifest.budget.sequence.totalTokens - tokensCharged - priorSpend.tokens
      const remainingMs = deadlineAt - Date.now()
      if (remainingRequests <= 0 || remainingTokens <= 0 || remainingMs <= 0) {
        budgetStop = remainingRequests <= 0 ? '请求数上限' : remainingTokens <= 0 ? '总 token 上限' : '序列时限'
        unrunUnits.push(...manifest.units.slice(unitIndex).map(item => item.unit))
        break
      }
      // ⚠️ 剩余时间**不足以跑完一个单元**时**不启动它**（记 budgetStop）——
      //    否则子进程会在半途被超时杀死 ⇒ 在途崩溃 + 读数丢失（首跑真实教训）。
      if (!canStartUnitWithin(remainingMs, unitTimeoutMs)) {
        budgetStop = '序列时限（剩余时间不足一个完整单元）'
        unrunUnits.push(...manifest.units.slice(unitIndex).map(item => item.unit))
        break
      }
      writeFileSync(ALLOWANCE_PATH, `${JSON.stringify({ requests: remainingRequests, tokens: remainingTokens, deadlineAt })}\n`, 'utf8')
      const ledgerPath = unitLedgerPath(unit.worldId, unit.arm)
      // 清掉上一轮同名账本：本单元若在**发出任何请求前**崩溃，账本缺失 ⇒ 成本无法确认 ⇒ 停止序列。
      rmSync(ledgerPath, { force: true })
      const label = `f1-live-${unit.worldId}-${unit.arm}`
      let accounting
      try {
        const saved = process.argv
        const savedLedger = process.env.F1_UNIT_LEDGER
        // ⚠️ 单元子进程的超时必须**由封存预算推导**：harness 默认 120 s 会在真实模型调用还在途时
        //    把子进程杀掉（首跑真实教训：在途崩溃 + 读数丢失）。这里按"任务数 × 单题时限 + 余量"给。
        const savedTimeout = process.env.LG_PG_GATE_TIMEOUT_MS
        const savedMaxUnverified = process.env.F1_MAX_UNVERIFIED_COST_EVENTS
        try {
          process.argv = [saved[0]!, saved[1]!, '--unit', '--world', unit.worldId, '--arm', unit.arm]
          process.env.F1_UNIT_LEDGER = ledgerPath
          process.env.F1_MAX_UNVERIFIED_COST_EVENTS = String(maxUnverified)
          process.env.LG_PG_GATE_TIMEOUT_MS = String(unitTimeoutMs)
          await runPreparedPgGateInInstance(adminUrl, label, RUNNER_PATH)
        } finally {
          process.argv = saved
          if (savedLedger === undefined) delete process.env.F1_UNIT_LEDGER
          else process.env.F1_UNIT_LEDGER = savedLedger
          if (savedTimeout === undefined) delete process.env.LG_PG_GATE_TIMEOUT_MS
          else process.env.LG_PG_GATE_TIMEOUT_MS = savedTimeout
          if (savedMaxUnverified === undefined) delete process.env.F1_MAX_UNVERIFIED_COST_EVENTS
          else process.env.F1_MAX_UNVERIFIED_COST_EVENTS = savedMaxUnverified
        }
        const report = JSON.parse(readFileSync(resolve(EVIDENCE_ROOT, `unit-${unit.worldId}-${unit.arm}.json`), 'utf8')) as UnitReport
        reports.push(report)
        // ⚠️ 成本以**请求账本**为准；报告必须与账本一致，否则视为成本无法确认并停止。
        accounting = accountUnitOutcome({
          ledger: readAttemptLedger(ledgerPath),
          reportCost: {
            requestsAttempted: report.cost.requestsAttempted,
            tokensCharged: report.cost.tokensCharged,
            tokensReported: report.cost.tokensReported,
            usageMissingCount: report.cost.usageMissingCount,
            costUnverifiable: report.cost.costUnverifiable,
          },
          reportExists: true,
        })
        console.log(`UNIT ${unit.unit} requests=${String(accounting.requestsAttempted)} tokens=${String(accounting.tokensCharged)} costConfirmed=${String(accounting.costConfirmed)} achieved=${String(report.goalAchieved)}/${String(report.achievedDenominator)}${report.budgetStop === null ? '' : ` budgetStop=${report.budgetStop}`}`)
        if (accounting.mustStop) {
          budgetStop = accounting.reason
          unrunUnits.push(...manifest.units.slice(unitIndex + 1).map(item => item.unit))
        } else if (report.budgetStop !== null) {
          budgetStop = report.budgetStop
          unrunUnits.push(...report.unrunTasks.map(taskId => `${unit.unit}:${taskId}`))
          unrunUnits.push(...manifest.units.slice(unitIndex + 1).map(item => item.unit))
          // 单元内部预算/成本停止 ⇒ 不再启动后续单元
          if (budgetStop !== undefined) break
        }
      } catch (error) {
        // ⚠️ 失败单元也要**先对账再决定是否继续**：成本无法确认 ⇒ 停止序列并标 INCOMPLETE。
        accounting = accountUnitOutcome({ ledger: readAttemptLedger(ledgerPath), reportExists: false,
          error: error instanceof Error ? error.message : String(error) })
        /*
         * **任务账本取回**：单元死在请求在途时没有单元报告，但任务账本已经落过每一条已完成的题。
         * 这里把已完成题**原样取回**并保留（不重跑、不补采）；在途那一题记在 inFlightTaskIds。
         */
        const taskJournal = readTaskJournal(unitTaskJournalPath(unit.worldId, unit.arm))
        const recovered = taskJournal.readable ? taskJournal.rows.map(item => item.row) : []
        if (recovered.length > 0) recoveredTasks.push({ unit: unit.unit, tasks: recovered.length, rows: recovered })
        failedUnits.push({
          unit: unit.unit,
          error: (error instanceof Error ? error.message : String(error)).slice(0, 300),
          accounting: accounting as unknown as Record<string, unknown>,
          taskJournal: {
            readable: taskJournal.readable, started: taskJournal.started, finished: taskJournal.finished,
            recoveredTasks: recovered.length, inFlightTaskIds: taskJournal.inFlightTaskIds,
          },
        })
        console.error(`UNIT ${unit.unit} FAILED: ${failedUnits.at(-1)!.error} (costConfirmed=${String(accounting.costConfirmed)})`)
        if (accounting.mustStop) {
          budgetStop = accounting.reason
          unrunUnits.push(...manifest.units.slice(unitIndex + 1).map(item => item.unit))
        }
      }
      if (accounting !== undefined) {
        requestsUsed += accounting.requestsAttempted
        tokensCharged += accounting.tokensCharged
        tokensReported += accounting.tokensReported
        usageMissing += accounting.usageMissingCount
        costUnverifiable = costUnverifiable || accounting.costUnverifiable
      }
      persist()
      if (budgetStop !== undefined) break
    }
    status = failedUnits.length === 0 && unrunUnits.length === 0 && budgetStop === undefined && !costUnverifiable
      ? 'COMPLETE'
      : 'INCOMPLETE'
  } catch (error) {
    status = 'FAIL'
    console.error(`F1 live run stopped: ${(error as Error).message.slice(0, 200)}`)
  }
  persist()
  console.log(`f1 live run: ${status}; ${runDir}`)
  process.exitCode = status === 'COMPLETE' ? 0 : 1
}

// ---------------------------------------------------------------------------
// 模式：--unit（每个单元一个独立迁移库；由 `--run` 子进程调用）
// ---------------------------------------------------------------------------

async function runUnitCli(): Promise<void> {
  assert.ok(simulatorPreconditions(), 'serversim_required（真实运行只能在 simhost 内）')
  const manifest = loadSealedManifest(SEAL_PATH)
  const drift = sealIntegrity(manifest, currentSealState(manifest))
  assertRunAuthorized({ manifest, drift, env: process.env })
  assertSealedParameterEnvironment(manifest)
  if (process.env.F1_OFFLINE_MODE !== undefined || process.env.F1_ALLOW_OFFLINE !== undefined) {
    throw new F1GuardError('offline_marker_forbidden', '--unit 不接受离线标记（离线只给门用）')
  }
  const worldId = arg('--world')
  const arm = arg('--arm') as F1Arm | undefined
  if (worldId === undefined || arm === undefined || !ARMS.includes(arm)) fail('invalid_parameter', `--unit 需要 --world 与 --arm`)
  const allowancePath = ALLOWANCE_PATH
  if (!existsSync(allowancePath)) fail('invalid_parameter', `缺少 allowance.json：${allowancePath}`)
  const allowance = JSON.parse(readFileSync(allowancePath, 'utf8')) as F1RequestAllowance
  const ledgerPath = (process.env.F1_UNIT_LEDGER ?? '').trim() !== ''
    ? process.env.F1_UNIT_LEDGER!
    : resolve(EVIDENCE_ROOT, `ledger-${worldId}-${arm}.jsonl`)
  const maxUnverified = process.env.F1_MAX_UNVERIFIED_COST_EVENTS === undefined
    ? undefined
    : Number(process.env.F1_MAX_UNVERIFIED_COST_EVENTS)
  const report = await runArmUnit({
    ...(maxUnverified === undefined ? {} : { maxUnverifiedCostEvents: maxUnverified }), worldId, arm, allowance, transportKind: 'live', ledgerPath })
  console.log(`UNIT ${report.unit}: requests=${String(report.modelRequests)} goals=${String(report.goalAchieved)}/${String(report.achievedDenominator)} tasks=${String(report.tasks.length)} unrun=${String(report.unrunTasks.length)} budgetStop=${String(report.budgetStop)} ledger=${report.ledgerPath}`)
}

// ---------------------------------------------------------------------------
// CLI（**只有作为入口进程时**才执行；门可以 import 本文件的 `runArmUnit`）
// ---------------------------------------------------------------------------
const isEntry = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (isEntry) {
  const mode = ['--seal', '--run', '--unit'].find(flag => process.argv.includes(flag))
  if (mode === undefined) {
    console.error('用法：f1-live-runner.ts --seal | --run | --unit --world <worldId> --arm <A|B|C>')
    process.exit(2)
  }
  if (mode === '--seal') {
    runSeal()
  } else if (mode === '--run') {
    await runSequence()
  } else {
    await runUnitCli()
  }
}
