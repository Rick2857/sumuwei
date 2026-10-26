/**
 * **G8：F1 正式运行器的守卫与记账（纯逻辑模块）**
 *
 * ============================================================================
 *  它守的是什么（预注册 §8 的 G8 那一行，逐字）
 * ============================================================================
 *  「预算请求前计尝试、逐请求检查、usage 缺失不补 0、参数/源码/镜像漂移拒跑、
 *    started.lock 防重跑」
 *
 *  这些判据**不能**散落在运行器里"顺手写"——那样门没法单独验证它们，
 *  也容易在改运行器时被悄悄放宽。因此它们集中在本模块：
 *
 *  · `createRequestMeter`  —— 逐请求预算 + 尝试计数 + usage 口径（唯一的请求出口）
 *  · `buildSealedManifest` —— 封存清单的唯一构造口（任何 MISSING/UNBOUND/非 PASS ⇒ 拒绝）
 *  · `sealIntegrity`       —— 运行前**逐项**比对封存摘要（漂移 ⇒ 拒绝）
 *  · `assertRunAuthorized` —— 运行授权（封存状态 + 显式授权标记 + serversim + 禁用离线标记）
 *  · `acquireStartedLock`  —— `started.lock`（O_EXCL 原子创建 ⇒ 第二次运行必拒）
 *  · `chargeForUsage` / `F1_USAGE_POLICY` —— **usage 缺失绝不补 0**（按上限保守计费）
 *
 *  ⚠️ 边界：本模块**不**发请求、不碰数据库、不读凭据取值。
 *     它只决定"能不能发、发了怎么记账"，真正发请求的是运行器注入的 transport。
 */

import { createHash } from 'node:crypto'
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs'
import { resolve } from 'node:path'

// ---------------------------------------------------------------------------
// 身份 / 闭集常量
// ---------------------------------------------------------------------------

export const F1_RUNNER_ID = 'f1-live-runner@1'
export const F1_SEAL_SCHEMA = 'f1-sealed-manifest@1'
export const F1_SEAL_KIND = 'f1-qualified-veto-dev@1-sealed'
export const F1_SEAL_STATUS_AUTHORIZED = 'SEALED_RUN_AUTHORIZED'
export const F1_SEAL_STATUS_NOT_AUTHORIZED = 'SEALED_NOT_AUTHORIZED_TO_RUN'

/** 请求用途闭集（三类角色调用；不允许出现第四类而不记账）。 */
export const F1_REQUEST_PURPOSES = ['candidate', 'post_turn_memory', 'reflection'] as const
export type F1RequestPurpose = (typeof F1_REQUEST_PURPOSES)[number]

/**
 * 实际发出的请求参数（**唯一事实源**）。
 *
 * ⚠️ G9 要"有效模型参数/费用口径"：这里的 `temperatureRequested` 是**请求里写的值**，
 *    `temperatureEffective` 是**实测/文档已知的生效值** —— 两者**不是一回事**。
 *    D4 记录已核对：该 `-Preview` 端点**忽略** `temperature:0`、恒为 1 ⇒ 不得把
 *    "temperature=0" 写成确定性采样。
 */
export const F1_REQUEST_PARAMETERS = {
  candidateCount: 3,
  responseFormat: 'json_object',
  maxCompletionTokens: 4096,
  temperatureRequested: 0,
  temperatureEffective: 'PROVIDER_IGNORES_REQUESTED_ZERO_ALWAYS_1_D4_DOCUMENTED_NOT_RECHECKED_THIS_TURN',
  reasoningEffort: null,
  stream: false,
  /** 所有角色调用统一加上的输出上限（测量控制：不靠端点默认可变上限）。 */
  uniformMaxCompletionTokens: true,
} as const

export type F1RequestParameters = typeof F1_REQUEST_PARAMETERS

/**
 * **客户端 abort 的有界未确认成本政策**（用户 2026-10-25 裁定 A）。
 *
 * 事实：真实试点里提供方延迟尾部超过 90 s，客户端的规划器超时/硬超时会把请求 abort
 * （`This operation was aborted` / `TimeoutError`）——此时**没有 usage**，请求却**确实发出过**。
 *
 * 政策（**只针对"未收到响应"的客户端 abort**）：
 *  · 按**已知下限**扣账（`prompt??0 + maxCompletion`）——保守，不会低估预算；
 *  · 记入独立的 `unverifiedCostEvents` 桶（**不**算"成本已确认"）；
 *  · 事件数 **≤ K** 时**继续**序列（不让一次网络抖动废掉整条 9 单元序列）；**> K** 时停止并标 INCOMPLETE；
 *  · **不改变**：不补采、不重试凑齐、不用未确认事件冒充已确认成本。
 *
 * ⚠️ **不适用于**：HTTP 200 但 usage 不完整/缺失（提供方报告异常）、非 abort 的传输失败、
 *    请求在途崩溃。这些仍然按"成本无法确认 ⇒ 立刻停止序列"处理。
 */
export const F1_ABORT_POLICY = {
  maxUnverifiedCostEvents: 8,
  chargeRule: 'chargedFloorTokens = (prompt_tokens ?? 0) + (completion_tokens ?? maxCompletionTokens)',
  scope: 'client_abort_only',
} as const

export const F1_ABORT_POLICY_TEXT =
  '客户端 abort（请求已发出、未收到响应：AbortError/TimeoutError）单列为**有界未确认成本**：' +
  '按已知下限 chargedFloorTokens=(prompt??0)+(completion??maxCompletion) 扣账、记入 unverifiedCostEvents 桶（**不**算成本已确认）；' +
  '事件数 ≤ K(8) 时**继续**序列，> K 时停止并标 INCOMPLETE；HTTP 200 但 usage 不完整、非 abort 传输失败、' +
  '请求在途崩溃仍然**立刻停止**序列；不补采、不重试凑齐'

/** 该错误是否是"请求已发出但没收到响应"的客户端 abort。 */
export function isClientAbort(error: unknown): boolean {
  const name = typeof error === 'object' && error !== null ? String((error as { name?: unknown }).name ?? '') : ''
  const message = error instanceof Error ? error.message : String(error)
  if (name === 'AbortError' || name === 'TimeoutError') return true
  return /aborted|abort|timed?\s?out|timeout/i.test(message)
}

/** usage / 计费口径（G9 复查这个常量）。 */
export const F1_USAGE_POLICY = {
  usageSource: 'provider usage.total_tokens; 或 usage.prompt_tokens + usage.completion_tokens 同时存在时求和',
  missingUsage: 'USAGE_PARTIAL_OR_MISSING_KEEP_KNOWN_TOTAL_UNKNOWN_NEVER_ZERO_FILLED',
  /** ⚠️ 输出上限**不是**总 token 上限：读不到总量时不得把成本记成"已确认"。 */
  missingUsageRule:
    'usage 缺失/不完整 ⇒ **总量标未知**（reportedTokens=null）、保留已知 prompt/completion 分量、' +
    '按**已知下限**记账（已知输入 + 未知输出按上限假设）、成本标记**未确认**，并**停止后续请求**；' +
    '序列标 INCOMPLETE（不补采、不重试）',
  knownFloorCharge: 'chargedTokens = (prompt_tokens ?? 0) + (completion_tokens ?? maxCompletionTokens)；这是**下限**，不是上限',
  inFlightJournaling:
    '请求账本 append-only：每次尝试在**发出前**写 attempt_started、拿到结果后写 attempt_finished、' +
    '被拒请求写 attempt_refused；**只有 started 没有 finished** ⇒ 请求在途崩溃（可能已到达提供方）' +
    '⇒ 成本无法确认 ⇒ 停止整个序列并标 INCOMPLETE',
  clientAbortPolicy: F1_ABORT_POLICY_TEXT,
  budgetEnforcement:
    '每个请求**之前**检查剩余请求数 / 剩余 token / 序列截止时间 / **单题请求数上限**；**尝试数在 transport 之前计**；' +
    '剩余 token 小于单请求上限时，把该请求 max_tokens 缩到剩余量（请求形状仍是封存参数）；' +
    '保守计费可能让累计 token 越过上限 ⇒ 如实记 overshoot 并**停止**后续请求（不补采）',
  billingClaim: '只作本批报告级记账，不是 provider 账单，也不能证明不存在报告外调用',
} as const

/**
 * 每任务预算（与 `execution-draft.json` 的 taskBudget 对齐；运行器可读封存值核对）。
 *
 * ⚠️ `deadlineMs` **按实测重新校准**（2026-10-25 真实试点两轮）：
 *    ① 候选调用实测 5.6–28.7 s/次，规划器产品默认超时 45 s ⇒ 单题 6 次调用最坏 270 s，原 120 s 不可达；
 *    ② 实测有个别请求在 45 s 边界被 abort（无 usage ⇒ 成本未确认 ⇒ 整条序列停止）⇒ **评测侧**把规划器
 *       超时放宽到 90 s（产品默认值不变，见运行器 `F1_PLANNER_TIMEOUT_MS`）；
 *    ⇒ 单题最坏 6 × 90 s = 540 s，取 600 s。
 */
export const F1_TASK_BUDGET = {
  maxActions: 12,
  maxPlans: 6,
  maxModelRequests: 6,
  deadlineMs: 600_000,
  planningContextTokens: 4000,
  finalContextTokens: 4000,
  conditionReadMaxAttempts: 1,
} as const

/**
 * 单元子进程的超时（**由封存预算推导**，不落回 harness 默认值）。
 *
 * ⚠️ 首跑教训：单元子进程若沿用 harness 默认 120 s，会在**真实模型调用还在途**时被杀死
 *    ⇒ 成本无法确认 + 读数丢失。因此：
 *  · 子进程超时 = 任务数 × 单题时限 + 余量（保证单元能走完它自己的每题时限）；
 *  · 剩余序列时间不足一个完整单元时**不启动该单元**（记 budgetStop），而不是启动后被中途杀。
 */
export function deriveUnitTimeoutMs(input: {
  tasksPerUnit: number
  perTaskDeadlineMs: number
  marginMs?: number
}): number {
  const margin = input.marginMs ?? 120_000
  const tasks = Math.max(1, Math.trunc(input.tasksPerUnit))
  const deadline = Math.max(0, input.perTaskDeadlineMs)
  return Math.max(1, tasks * deadline + margin)
}

/**
 * 剩余序列时间是否**足以跑完一个完整单元**。
 *
 * ⚠️ 不足时**不启动该单元**（记 budgetStop）：否则子进程会在半途被超时杀掉 ⇒
 *    请求在途崩溃（成本无法确认）+ 该单元读数丢失。首跑真实教训。
 */
export function canStartUnitWithin(remainingMs: number, unitTimeoutMs: number): boolean {
  return remainingMs >= unitTimeoutMs
}

/** 封存必须绑定的最小项（缺任何一项 ⇒ 拒绝封存）。 */
export const F1_REQUIRED_SEAL_BINDINGS = [
  'preregistration',
  'worlds',
  'tasks',
  'oracle',
  'executionDraft',
  'feasibilityDecision',
  'factory',
  'parityGate',
  'negativeControls',
  'runner',
  'guards',
  'feasibilityDecisionDoc',
] as const
export type F1SealBindingId = (typeof F1_REQUIRED_SEAL_BINDINGS)[number]

export const F1_REQUIRED_GATE_IDS = [
  'G1_common_assembly',
  'G2_timing_calibration',
  /** G3–G7 由四个隔离破坏性控制**共同**支撑（不伪造一对一的独立读数） */
  'G3_G7_destructive_controls',
  'G8_runner_guards',
  'G9_quota_and_parameters',
  'full_ci',
  'preflight_before',
  'preflight_after',
] as const
export type F1GateId = (typeof F1_REQUIRED_GATE_IDS)[number]

// ---------------------------------------------------------------------------
// 错误：闭集码（拒绝必须能机器判定，不能只有人读文本）
// ---------------------------------------------------------------------------

export const F1_GUARD_CODES = [
  'budget_refused',
  'transport_failed',
  'invalid_request_body',
  'invalid_allowance',
  'invalid_parameter',
  'task_request_limit',
  'cost_unverifiable',
  'unverified_cost_limit',
  'binding_missing',
  'binding_unbound',
  'identity_unbound',
  'gate_reading_missing',
  'gate_reading_not_pass',
  'endpoint_invalid',
  'already_started',
  'missing_seal',
  'seal_drift',
  'run_not_authorized',
  'authorization_marker_missing',
  'serversim_required',
  'offline_marker_forbidden',
  'production_activation_forbidden',
  'seal_incomplete',
] as const
export type F1GuardCode = (typeof F1_GUARD_CODES)[number]

export class F1GuardError extends Error {
  readonly code: F1GuardCode

  constructor(code: F1GuardCode, detail: string) {
    super(`[${code}] ${detail}`)
    this.name = 'F1GuardError'
    this.code = code
  }
}

/** 失败关闭的唯一出口：TS 需要**函数声明**才能做 never 收窄。 */
function fail(code: F1GuardCode, detail: string): never {
  throw new F1GuardError(code, detail)
}

// ---------------------------------------------------------------------------
// 摘要 / 文件身份
// ---------------------------------------------------------------------------

export function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** 读文件摘要；文件不存在 ⇒ 显式 `MISSING`（**不**伪造空值/零值）。 */
export function fileDigestOrMissing(path: string): string {
  return existsSync(path) ? sha256Text(readFileSync(path, 'utf8')) : 'MISSING'
}

export interface F1SealBinding {
  id: F1SealBindingId
  path: string
  sha256: string
}

/** 按闭集收集绑定；任何一项 `MISSING` ⇒ 直接 `binding_missing`。 */
export function collectSealBindings(paths: Record<F1SealBindingId, string>): F1SealBinding[] {
  const out: F1SealBinding[] = []
  for (const id of F1_REQUIRED_SEAL_BINDINGS) {
    const digest = fileDigestOrMissing(resolve(paths[id]))
    if (digest === 'MISSING') fail('binding_missing', `${id}: ${paths[id]}`)
    out.push({ id, path: paths[id], sha256: digest })
  }
  return out
}

const isDigest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)

// ---------------------------------------------------------------------------
// 端点元数据（**只**非机密：主机 / 模型 / key 长度）
// ---------------------------------------------------------------------------

export interface F1EndpointMetadata {
  /** 端点主机名（不含路径；**不**记录 key 取值） */
  host: string
  model: string
  apiKeyPresent: boolean
  apiKeyLength: number
}

/** 解析 `.env` 形状的文本为键值对（**纯函数**，不碰环境变量）。 */
export function envValuesFromEnvText(text: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const match = /^(?:export\s+)?([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line)
    if (match === null) continue
    let value = (match[2] ?? '').trim()
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
    if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1)
    values[match[1]!] = value
  }
  return values
}

/** 从 `.env` 形状的文本解析非机密端点元数据；缺项/非法 URL ⇒ `endpoint_invalid`。 */
export function endpointMetadataFromEnvText(text: string): F1EndpointMetadata {
  const values = envValuesFromEnvText(text)
  const baseUrl = (values.OPENAI_BASE_URL ?? '').trim()
  const model = (values.OPENAI_LARGE_MODEL ?? values.OPENAI_SMALL_MODEL ?? '').trim()
  const key = (values.OPENAI_API_KEY ?? '').trim()
  if (baseUrl === '' || model === '') fail('endpoint_invalid', 'OPENAI_BASE_URL / OPENAI_LARGE_MODEL 缺失')
  let host: string
  try {
    host = new URL(baseUrl).hostname
  } catch {
    return fail('endpoint_invalid', `OPENAI_BASE_URL 不是合法 URL：${baseUrl.slice(0, 60)}`)
  }
  if (host === '127.0.0.1' || host === 'localhost' || host === '::1') {
    fail('endpoint_invalid', `端点主机是回环地址（拒绝把仿真桩端点当成真实提供方）：${host}`)
  }
  return { host, model, apiKeyPresent: key !== '', apiKeyLength: key.length }
}

/** 端点元数据摘要：只覆盖 host / model / key 长度（**不含** key 取值）。 */
export function endpointMetadataDigest(metadata: F1EndpointMetadata): string {
  return sha256Text(JSON.stringify({ host: metadata.host, model: metadata.model, apiKeyLength: metadata.apiKeyLength }))
}

// ---------------------------------------------------------------------------
// 请求记账：逐请求预算 + 尝试计数 + usage 口径
// ---------------------------------------------------------------------------

export interface F1RequestAllowance {
  /** 本单元/本序列**剩余**可用请求数（不是累计上限） */
  requests: number
  /** 本单元/本序列**剩余**可用 token（不是累计上限） */
  tokens: number
  /** 序列截止时间（epoch ms） */
  deadlineAt: number
}

export interface F1UsageReading {
  promptTokens: number | null
  completionTokens: number | null
  totalTokens: number | null
}

export interface F1ChargedUsage {
  usage: F1UsageReading | null
  /** usage 不完整（缺失总量、或只给了分项之一） ⇒ **成本未确认** */
  usageMissing: boolean
  /** 成本是否**可确认**：只有拿到总量（或同时拿到两个分项）才算确认 */
  costVerifiable: boolean
  /** 真实总量（未知就是 null —— **绝不补 0**） */
  reportedTokens: number | null
  /** 已知的输入 token（缺失就是 null；保留已知量，不丢） */
  knownPromptTokens: number | null
  /** 已知的输出 token（缺失就是 null） */
  knownCompletionTokens: number | null
  /** 记账用的**已知下限**（total 已知时等于真值；否则 = 已知输入 + 未确认输出按上限假设） */
  chargedTokens: number
}

/**
 * usage 口径的唯一实现。
 *
 * 规则（顺序固定，后两条**必须**保守）：
 *  1. `usage.total_tokens` 是有限非负数 ⇒ 用它（真读数，成本**已确认**）。
 *  2. 否则 `prompt_tokens` 与 `completion_tokens` **同时**是有限非负数 ⇒ 求和（成本已确认）。
 *  3. 否则 **usage 不完整** ⇒ `reportedTokens = null`（**总量标未知**）、保留已知分项、
 *     `chargedTokens = (prompt_tokens ?? 0) + (completion_tokens ?? maxCompletionTokens)`
 *     —— 这是**下限**，不是上限（输出上限不能当总 token 上限），`costVerifiable = false`。
 *     ⚠️ 计量器收到 `costVerifiable=false` 会**停止后续请求**并把序列标 INCOMPLETE。
 */
export function chargeForUsage(raw: unknown, maxCompletionTokens: number): F1ChargedUsage {
  const numberOrNull = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
  const usage = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : undefined
  const total = numberOrNull(usage?.total_tokens)
  const prompt = numberOrNull(usage?.prompt_tokens)
  const completion = numberOrNull(usage?.completion_tokens)
  if (total !== null) {
    return {
      usage: { promptTokens: prompt, completionTokens: completion, totalTokens: total },
      usageMissing: false, costVerifiable: true,
      reportedTokens: total, knownPromptTokens: prompt, knownCompletionTokens: completion,
      chargedTokens: total,
    }
  }
  if (prompt !== null && completion !== null) {
    return {
      usage: { promptTokens: prompt, completionTokens: completion, totalTokens: null },
      usageMissing: false, costVerifiable: true,
      reportedTokens: prompt + completion, knownPromptTokens: prompt, knownCompletionTokens: completion,
      chargedTokens: prompt + completion,
    }
  }
  return {
    usage: usage === undefined ? null : { promptTokens: prompt, completionTokens: completion, totalTokens: total },
    usageMissing: true, costVerifiable: false,
    reportedTokens: null, knownPromptTokens: prompt, knownCompletionTokens: completion,
    chargedTokens: (prompt ?? 0) + (completion ?? maxCompletionTokens),
  }
}

export type F1MeterOutcome = 'success' | 'transport_failed' | 'budget_refused' | 'client_abort'

export interface F1MeteredCall {
  sequence: number
  purpose: F1RequestPurpose
  /** 实际尝试序号；被预算拒绝的请求 `attempt = 0`（**没有发出**） */
  attempt: number
  taskId: string | null
  ordinal: number | null
  outcome: F1MeterOutcome
  startedAt: number
  elapsedMs: number
  httpStatus: number | null
  usage: F1UsageReading | null
  usageMissing: boolean
  costVerifiable: boolean
  knownPromptTokens: number | null
  knownCompletionTokens: number | null
  reportedTokens: number | null
  chargedTokens: number
  /** 本次请求实际发出的 max_tokens（可能因剩余 token 被缩） */
  effectiveMaxTokens: number | null
  budgetRefusal?: string
  error?: string
  /** 客户端 abort ⇒ 有界未确认成本事件（政策 A） */
  unverifiedReason?: 'client_abort'
}

export interface F1MeterTransportRequest {
  url: string
  init: RequestInit
}

export interface F1MeterTransportResult {
  status: number
  text: string
}

export type F1MeterTransport = (
  purpose: F1RequestPurpose,
  request: F1MeterTransportRequest
) => Promise<F1MeterTransportResult>

export interface F1RequestMeterOptions {
  allowance: F1RequestAllowance
  maxCompletionTokens: number
  /** **单题**请求数上限（候选 + 轮后记忆 + 反思合计；缺省 Infinity ⇒ 只用于纯记账） */
  maxRequestsPerTask?: number
  /** 客户端 abort 的**有界未确认成本**事件上限（缺省 `F1_ABORT_POLICY.maxUnverifiedCostEvents`）。 */
  maxUnverifiedCostEvents?: number
  transport: F1MeterTransport
  now?: () => number
  /** 当前任务标签（运行器按任务切换；只进记账，不进请求） */
  taskTag?: () => { taskId: string | null; ordinal: number | null }
  onCall?: (call: F1MeteredCall) => void
  /**
   * 请求账本路径（append-only）。
   *
   * ⚠️ **计量器自己写**，不是调用方写：这样"请求发出**之前**就留下痕迹"是结构保证，
   *    而不是"调用方记得写"。调用方如果自己 `onCall` 里写，就只能在**请求返回后**记 ⇒
   *    **在途崩溃**（请求发出、进程死在返回前）会**没有记录** ⇒ 成本被少报。
   */
  ledgerPath?: string
}

export interface F1RequestMeter {
  readonly calls: F1MeteredCall[]
  readonly requestsAttempted: number
  readonly tokensCharged: number
  readonly tokensReported: number
  readonly usageMissingCount: number
  /** 出现过**成本未确认**的调用 ⇒ 序列必须停（INCOMPLETE） */
  readonly costUnverifiable: boolean
  readonly overshoot: number
  /** 客户端 abort 的**有界未确认成本**事件（请求已发出、未收到响应）。 */
  readonly unverifiedCostEvents: F1UnverifiedCostEvent[]
  readonly unverifiedFloorTokens: number
  budgetStopReason: () => string | undefined
  taskAttempts: () => Record<string, number>
  send: (purpose: F1RequestPurpose, request: F1MeterTransportRequest) => Promise<F1MeterTransportResult>
  summary: () => {
    requestsAttempted: number
    tokensCharged: number
    tokensReported: number
    usageMissingCount: number
    costUnverifiable: boolean
    unverifiedCostEvents: number
    unverifiedFloorTokens: number
    overshoot: number
    taskAttempts: Record<string, number>
    byPurpose: Record<F1RequestPurpose, { attempts: number; chargedTokens: number; usageMissing: number }>
  }
}

/** 一次"请求已发出、但没收到响应"的客户端 abort（有界未确认成本事件）。 */
export interface F1UnverifiedCostEvent {
  sequence: number
  purpose: F1RequestPurpose
  attempt: number
  taskId: string | null
  ordinal: number | null
  elapsedMs: number
  chargedFloorTokens: number
  reason: 'client_abort'
}

const requestPurpose = (value: string): F1RequestPurpose =>
  (F1_REQUEST_PURPOSES as readonly string[]).includes(value)
    ? (value as F1RequestPurpose)
    : fail('invalid_parameter', `未知请求用途：${value}`)

/**
 * 唯一的请求出口。
 *
 * ⚠️ 顺序**不可调换**：先判**单题上限** ⇒ 再判成本可确认性 ⇒ 再判单元预算 ⇒ 计尝试 ⇒ 发请求 ⇒ 记账。
 *    把"计尝试"放到 transport 之后，网络失败就**不计**尝试 ⇒ 实际请求数被少报。
 *
 * ⚠️ 一旦出现 `costVerifiable=false`（usage 缺失/不完整、或传输失败）⇒ **成本无法确认**：
 *    后续请求一律拒绝（`cost_unverifiable`），序列由编排器标 INCOMPLETE（不补采、不重试）。
 */
export function createRequestMeter(options: F1RequestMeterOptions): F1RequestMeter {
  const { allowance, maxCompletionTokens, transport } = options
  if (!Number.isFinite(allowance.requests) && allowance.requests !== Number.POSITIVE_INFINITY) {
    fail('invalid_allowance', `requests 非有限数：${String(allowance.requests)}`)
  }
  if (allowance.requests < 0) fail('invalid_allowance', `requests 为负：${allowance.requests}`)
  if (allowance.tokens < 0) fail('invalid_allowance', `tokens 为负：${allowance.tokens}`)
  if (!(maxCompletionTokens > 0)) fail('invalid_parameter', `maxCompletionTokens 非正：${String(maxCompletionTokens)}`)
  const maxRequestsPerTask = options.maxRequestsPerTask ?? Number.POSITIVE_INFINITY
  if (maxRequestsPerTask < 1) fail('invalid_parameter', `maxRequestsPerTask 非正：${String(maxRequestsPerTask)}`)
  const maxUnverifiedCostEvents = options.maxUnverifiedCostEvents ?? F1_ABORT_POLICY.maxUnverifiedCostEvents
  if (!(maxUnverifiedCostEvents >= 0)) fail('invalid_parameter', `maxUnverifiedCostEvents 为负：${String(maxUnverifiedCostEvents)}`)
  const now = options.now ?? (() => Date.now())
  const calls: F1MeteredCall[] = []
  const attemptsByTask = new Map<string, number>()
  let requestsAttempted = 0
  let tokensCharged = 0
  let tokensReported = 0
  let usageMissingCount = 0
  let costUnverifiable = false
  /** 客户端 abort 的有界未确认成本事件（政策 A）。 */
  const unverifiedCostEvents: F1UnverifiedCostEvent[] = []
  let unverifiedFloorTokens = 0

  const refusalCall = (
    sequence: number, purpose: F1RequestPurpose, tag: { taskId: string | null, ordinal: number | null },
    reason: string
  ): F1MeteredCall => {
    const call: F1MeteredCall = {
      sequence, purpose, attempt: 0, taskId: tag.taskId, ordinal: tag.ordinal, outcome: 'budget_refused',
      startedAt: now(), elapsedMs: 0, httpStatus: null, usage: null, usageMissing: false,
      costVerifiable: true, knownPromptTokens: null, knownCompletionTokens: null,
      reportedTokens: null, chargedTokens: 0, effectiveMaxTokens: null, budgetRefusal: reason,
    }
    calls.push(call)
    options.onCall?.(call)
    if (options.ledgerPath !== undefined) {
      appendLedgerEntry(options.ledgerPath, {
        phase: 'attempt_refused', sequence, purpose, attempt: 0, taskId: tag.taskId, ordinal: tag.ordinal,
        startedAt: call.startedAt, finishedAt: call.startedAt, elapsedMs: 0,
        httpStatus: null, usageMissing: false, costVerifiable: true,
        knownPromptTokens: null, knownCompletionTokens: null, reportedTokens: null, chargedTokens: 0,
        effectiveMaxTokens: null, budgetRefusal: reason, error: null,
      })
    }
    return call
  }

  const budgetStopReason = (): string | undefined => {
    if (unverifiedCostEvents.length > maxUnverifiedCostEvents) return '未确认成本事件超过上限'
    if (costUnverifiable) return 'usage 不完整（成本无法确认）'
    if (requestsAttempted >= allowance.requests) return '请求数上限'
    if (tokensCharged >= allowance.tokens) return '总 token 上限'
    if (now() >= allowance.deadlineAt) return '序列时限'
    return undefined
  }

  const taskAttempts = (): Record<string, number> => Object.fromEntries(attemptsByTask)

  const send = async (
    purposeValue: F1RequestPurpose,
    request: F1MeterTransportRequest
  ): Promise<F1MeterTransportResult> => {
    const purpose = requestPurpose(purposeValue)
    const tag = options.taskTag?.() ?? { taskId: null, ordinal: null }
    const sequence = calls.length + 1

    // ① **单题**请求数上限（候选 + 轮后记忆 + 反思合计；同一 taskId 第 7 次即拒）
    if (tag.taskId !== null && (attemptsByTask.get(tag.taskId) ?? 0) >= maxRequestsPerTask) {
      refusalCall(sequence, purpose, tag, '单题请求数上限')
      throw new F1GuardError('task_request_limit', `单题请求数上限（${String(maxRequestsPerTask)}）`)
    }
    // ② 未确认成本**事件数超上限** ⇒ 停止（政策 A 的上限闸）
    if (unverifiedCostEvents.length > maxUnverifiedCostEvents) {
      refusalCall(sequence, purpose, tag, '未确认成本事件超过上限')
      throw new F1GuardError('unverified_cost_limit', `未确认成本事件超过上限（> ${String(maxUnverifiedCostEvents)}）⇒ 停止后续请求`)
    }
    // ②b 成本已无法确认（提供方 usage 异常等）⇒ **停止后续请求**（不再发）
    if (costUnverifiable) {
      refusalCall(sequence, purpose, tag, 'usage 不完整（成本无法确认）')
      throw new F1GuardError('cost_unverifiable', 'usage 不完整（成本无法确认）⇒ 停止后续请求')
    }
    // ③ 单元/序列预算
    const refusal = budgetStopReason()
    if (refusal !== undefined) {
      refusalCall(sequence, purpose, tag, refusal)
      throw new F1GuardError('budget_refused', refusal)
    }

    // 剩余 token 小于单请求上限 ⇒ 把**本次** max_tokens 缩到剩余量（请求仍是被封存的参数形状）
    const remainingTokens = Math.max(0, allowance.tokens - tokensCharged)
    const effectiveMaxTokens = Math.max(1, Math.min(maxCompletionTokens, remainingTokens))
    const body = request.init.body
    if (typeof body !== 'string') fail('invalid_request_body', '请求 body 必须是 JSON 字符串')
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(body) as Record<string, unknown>
    } catch {
      return fail('invalid_request_body', '请求 body 不是合法 JSON')
    }
    parsed.max_tokens = effectiveMaxTokens
    parsed.stream = false
    const rewritten: F1MeterTransportRequest = { url: request.url, init: { ...request.init, body: JSON.stringify(parsed) } }

    // ⚠️ **尝试数在 transport 之前计**：网络失败也算一次真实尝试；单题计数同样先计。
    requestsAttempted += 1
    if (tag.taskId !== null) attemptsByTask.set(tag.taskId, (attemptsByTask.get(tag.taskId) ?? 0) + 1)
    const attempt = requestsAttempted
    const startedAt = now()
    const base = {
      sequence, purpose, attempt, taskId: tag.taskId, ordinal: tag.ordinal,
      startedAt, httpStatus: null, effectiveMaxTokens,
    }
    // ⚠️ **发出前**先落"在途"痕迹：进程若死在请求返回前，账本里仍有这一次尝试
    //    （只有 started 没有 finished ⇒ 在途崩溃 ⇒ 成本无法确认 ⇒ 序列停止）。
    if (options.ledgerPath !== undefined) {
      appendLedgerEntry(options.ledgerPath, {
        phase: 'attempt_started', sequence, purpose, attempt, taskId: tag.taskId, ordinal: tag.ordinal,
        startedAt, effectiveMaxTokens,
      })
    }
    let call: F1MeteredCall
    try {
      const result = await transport(purpose, rewritten)
      let usageRaw: unknown
      try {
        usageRaw = (JSON.parse(result.text) as { usage?: unknown }).usage
      } catch {
        usageRaw = undefined
      }
      const charged = chargeForUsage(usageRaw, maxCompletionTokens)
      tokensCharged += charged.chargedTokens
      if (charged.reportedTokens !== null) tokensReported += charged.reportedTokens
      if (charged.usageMissing) usageMissingCount += 1
      if (!charged.costVerifiable) costUnverifiable = true
      call = {
        ...base, outcome: 'success', elapsedMs: now() - startedAt, httpStatus: result.status,
        usage: charged.usage, usageMissing: charged.usageMissing, costVerifiable: charged.costVerifiable,
        knownPromptTokens: charged.knownPromptTokens, knownCompletionTokens: charged.knownCompletionTokens,
        reportedTokens: charged.reportedTokens, chargedTokens: charged.chargedTokens,
      }
      calls.push(call)
      options.onCall?.(call)
      if (options.ledgerPath !== undefined) {
        appendLedgerEntry(options.ledgerPath, {
          phase: 'attempt_finished', sequence, purpose, attempt, taskId: tag.taskId, ordinal: tag.ordinal,
          startedAt, finishedAt: now(), elapsedMs: call.elapsedMs, httpStatus: result.status,
          usageMissing: charged.usageMissing, costVerifiable: charged.costVerifiable,
          knownPromptTokens: charged.knownPromptTokens, knownCompletionTokens: charged.knownCompletionTokens,
          reportedTokens: charged.reportedTokens, chargedTokens: charged.chargedTokens,
          effectiveMaxTokens, error: null,
        })
      }
      return { status: result.status, text: result.text }
    } catch (error) {
      /*
       * 传输失败分两类（政策 A）：
       *  · **客户端 abort**（请求已发出、未收到响应：AbortError/TimeoutError）⇒ 记"有界未确认成本"事件，
       *    按已知下限扣账，**继续**后续请求（事件数 > K 才停）；
       *  · 其它传输失败 / HTTP 非 2xx / usage 不完整 ⇒ 仍按"成本无法确认"**立刻停止**。
       */
      const aborted = isClientAbort(error)
      const charged = chargeForUsage(undefined, maxCompletionTokens)
      tokensCharged += charged.chargedTokens
      usageMissingCount += 1
      if (aborted) {
        unverifiedFloorTokens += charged.chargedTokens
        unverifiedCostEvents.push({
          sequence, purpose, attempt, taskId: tag.taskId, ordinal: tag.ordinal,
          elapsedMs: now() - startedAt, chargedFloorTokens: charged.chargedTokens, reason: 'client_abort',
        })
      } else {
        costUnverifiable = true
      }
      call = {
        ...base, outcome: aborted ? 'client_abort' : 'transport_failed', elapsedMs: now() - startedAt,
        usage: null, usageMissing: true, costVerifiable: false,
        knownPromptTokens: null, knownCompletionTokens: null,
        reportedTokens: null, chargedTokens: charged.chargedTokens,
        error: (error instanceof Error ? error.message : String(error)).slice(0, 180),
        ...(aborted ? { unverifiedReason: 'client_abort' as const } : {}),
      }
    }
    calls.push(call)
    options.onCall?.(call)
    if (options.ledgerPath !== undefined) {
      appendLedgerEntry(options.ledgerPath, {
        phase: 'attempt_finished', sequence, purpose, attempt, taskId: tag.taskId, ordinal: tag.ordinal,
        startedAt, finishedAt: now(), elapsedMs: call.elapsedMs, httpStatus: null,
        usageMissing: true, costVerifiable: false,
        knownPromptTokens: null, knownCompletionTokens: null,
        reportedTokens: null, chargedTokens: call.chargedTokens, effectiveMaxTokens, error: call.error ?? null,
        ...(call.unverifiedReason === undefined
          ? {}
          : { unverifiedReason: call.unverifiedReason, chargedFloorTokens: call.chargedTokens }),
      })
    }
    return fail('transport_failed', `请求失败（不自动重试）：${call.error ?? ''}`)
  }

  const summary = () => {
    const byPurpose = Object.fromEntries(F1_REQUEST_PURPOSES.map(purpose => [purpose,
      { attempts: 0, chargedTokens: 0, usageMissing: 0 }])) as Record<F1RequestPurpose,
      { attempts: number; chargedTokens: number; usageMissing: number }>
    for (const call of calls) {
      const bucket = byPurpose[call.purpose]
      bucket.attempts += call.attempt === 0 ? 0 : 1
      bucket.chargedTokens += call.chargedTokens
      bucket.usageMissing += call.usageMissing ? 1 : 0
    }
    return {
      requestsAttempted, tokensCharged, tokensReported, usageMissingCount, costUnverifiable,
      unverifiedCostEvents: unverifiedCostEvents.length, unverifiedFloorTokens,
      overshoot: Math.max(0, tokensCharged - allowance.tokens), taskAttempts: taskAttempts(), byPurpose,
    }
  }

  return {
    calls,
    get requestsAttempted() { return requestsAttempted },
    get tokensCharged() { return tokensCharged },
    get tokensReported() { return tokensReported },
    get usageMissingCount() { return usageMissingCount },
    get costUnverifiable() { return costUnverifiable },
    get overshoot() { return Math.max(0, tokensCharged - allowance.tokens) },
    get unverifiedCostEvents() { return unverifiedCostEvents },
    get unverifiedFloorTokens() { return unverifiedFloorTokens },
    budgetStopReason,
    taskAttempts,
    send,
    summary,
  }
}

// ---------------------------------------------------------------------------
// 任务账本：**每题结束立即落盘**（单元在途崩溃也能保住已完成的题）
// ---------------------------------------------------------------------------

/**
 * 任务账本的**阶段**。
 *
 * · `task_started`  —— 该题**即将开始**（在途标记）
 * · `task_finished` —— 该题**已有结论**（行读数整条落盘）
 *
 * ⚠️ 为什么需要第二本账：请求账本只记"发了哪些请求"，**不记"哪几题已经有结论"**。
 *    真实试点已出现过：单元子进程在请求在途时被杀 ⇒ 请求账本能对账（在途崩溃被捕获），
 *    但**该单元已经跑完的题全部丢失**（没有单元报告 ⇒ 没有逐题行）。
 *    任务账本把每一题在完成时立刻落盘，崩溃后可以把已完成题**原样取回**（不重跑、不补采）。
 */
export type F1TaskJournalPhase = 'task_started' | 'task_finished'

// ---------------------------------------------------------------------------
// 请求账本：**发出前**留痕、完成后补记（单元崩溃/在途崩溃都能对账）
// ---------------------------------------------------------------------------

export interface F1TaskJournalEntry {
  phase: F1TaskJournalPhase
  unit: string
  worldId: string
  arm: 'A' | 'B' | 'C'
  taskId: string
  ordinal: number
  at: number
  /** `task_finished` 才有：整条任务行读数（与单元报告里的行同形） */
  row?: unknown
}

/** 追加一条任务账本（append-only；每题开始/结束各一次）。 */
export function appendTaskJournalEntry(path: string, entry: F1TaskJournalEntry): void {
  appendFileSync(path, `${JSON.stringify(entry)}\n`, 'utf8')
}

export interface F1TaskJournalSummary {
  readable: boolean
  lines: number
  started: number
  finished: number
  /** 已完成的题（**崩溃后可原样取回**；顺序与执行顺序一致） */
  rows: Array<{ taskId: string; ordinal: number; row: unknown }>
  /** 已开始但没有结论的题（崩溃时在途的那一题） */
  inFlightTaskIds: string[]
}

const emptyTaskJournal = (readable: boolean, lines: number, unverifiable: boolean): F1TaskJournalSummary => ({
  readable, lines, started: 0, finished: 0, rows: [], inFlightTaskIds: [],
  ...(unverifiable ? {} : {}),
})

/** 读任务账本：文件不存在/损坏 ⇒ `readable=false`（**不**假装没有题）。 */
export function readTaskJournal(path: string): F1TaskJournalSummary {
  if (!existsSync(path)) return emptyTaskJournal(false, 0, false)
  let text: string
  try { text = readFileSync(path, 'utf8') } catch { return emptyTaskJournal(false, 0, false) }
  const lines = text.split(/\r?\n/).filter(line => line.trim() !== '')
  const startedIds: string[] = []
  const rows: Array<{ taskId: string; ordinal: number; row: unknown }> = []
  for (const line of lines) {
    let entry: F1TaskJournalEntry
    try { entry = JSON.parse(line) as F1TaskJournalEntry } catch {
      // 账本被截断/写坏 ⇒ 不可读（保守：不让"读不出来"变成"没有"）
      return { ...emptyTaskJournal(false, lines.length, true), lines: lines.length }
    }
    if (entry.phase === 'task_started') startedIds.push(entry.taskId)
    if (entry.phase === 'task_finished' && entry.row !== undefined) {
      rows.push({ taskId: entry.taskId, ordinal: entry.ordinal, row: entry.row })
    }
  }
  const finishedIds = new Set(rows.map(item => item.taskId))
  return {
    readable: true, lines: lines.length,
    started: startedIds.length, finished: rows.length, rows,
    inFlightTaskIds: startedIds.filter(taskId => !finishedIds.has(taskId)),
  }
}

/**
 * 账本条目的**阶段**。
 *
 * · `attempt_started`  —— 请求**即将发出**（在途标记；此时还没有 usage）
 * · `attempt_finished` —— 请求**已有结果**（带 usage / 扣账）
 * · `attempt_refused`  —— 请求**被守卫拒绝**（没有发出；不计尝试、不计成本）
 */
export type F1LedgerPhase = 'attempt_started' | 'attempt_finished' | 'attempt_refused'

export interface F1LedgerEntry {
  phase: F1LedgerPhase
  sequence: number
  purpose: F1RequestPurpose
  attempt: number
  taskId: string | null
  ordinal: number | null
  startedAt: number
  finishedAt?: number
  elapsedMs?: number
  httpStatus?: number | null
  usageMissing?: boolean
  costVerifiable?: boolean
  knownPromptTokens?: number | null
  knownCompletionTokens?: number | null
  reportedTokens?: number | null
  chargedTokens?: number
  effectiveMaxTokens?: number | null
  budgetRefusal?: string | null
  error?: string | null
  /** 客户端 abort ⇒ 有界未确认成本事件（政策 A）；不计入"成本已确认" */
  unverifiedReason?: 'client_abort'
  /** 该次 abort 的**已知下限**扣账 */
  chargedFloorTokens?: number
}

/**
 * 追加一行请求账本（append-only）。
 *
 * ⚠️ **两次写**：计量器在请求**发出前**写 `attempt_started`，拿到结果后写 `attempt_finished`。
 *    只有 started 没有 finished ⇒ **在途崩溃**（请求可能已经到达提供方）⇒ 成本**无法确认**。
 */
export function appendLedgerEntry(path: string, entry: F1LedgerEntry): void {
  appendFileSync(path, `${JSON.stringify(entry)}\n`, 'utf8')
}

/** 兼容入口：把一次已完成的调用写成 `attempt_finished`（旧调用方用）。 */
export function appendAttemptLedger(path: string, call: F1MeteredCall): void {
  appendLedgerEntry(path, {
    phase: call.outcome === 'budget_refused' ? 'attempt_refused' : 'attempt_finished',
    sequence: call.sequence, purpose: call.purpose, attempt: call.attempt, taskId: call.taskId,
    ordinal: call.ordinal, startedAt: call.startedAt, finishedAt: call.startedAt + call.elapsedMs,
    elapsedMs: call.elapsedMs, httpStatus: call.httpStatus, usageMissing: call.usageMissing,
    costVerifiable: call.costVerifiable, knownPromptTokens: call.knownPromptTokens,
    knownCompletionTokens: call.knownCompletionTokens, reportedTokens: call.reportedTokens,
    chargedTokens: call.chargedTokens, effectiveMaxTokens: call.effectiveMaxTokens,
    budgetRefusal: call.budgetRefusal ?? null, error: call.error ?? null,
  })
}

export interface F1AttemptLedgerSummary {
  readable: boolean
  lines: number
  /** 发出过的请求数（`attempt_started` 计数） */
  requestsAttempted: number
  /** 已有结果的请求数（`attempt_finished` 计数） */
  requestsFinished: number
  /** 被拒绝（未发出）的请求数 */
  requestsRefused: number
  /** **在途崩溃**：started 但没有 finished 的尝试数（>0 ⇒ 成本无法确认） */
  inFlightAttempts: number
  /** 客户端 abort 的**有界未确认成本**事件数（政策 A；≤K 不阻断序列） */
  unverifiedCostEventCount: number
  /** 上述事件的已知下限扣账合计 */
  unverifiedFloorTokens: number
  tokensCharged: number
  tokensReported: number
  usageMissingCount: number
  costUnverifiable: boolean
}

const emptyLedger = (readable: boolean, lines: number, unverifiable: boolean): F1AttemptLedgerSummary => ({
  readable, lines,
  requestsAttempted: 0, requestsFinished: 0, requestsRefused: 0, inFlightAttempts: 0,
  unverifiedCostEventCount: 0, unverifiedFloorTokens: 0,
  tokensCharged: 0, tokensReported: 0, usageMissingCount: 0, costUnverifiable: unverifiable,
})

/**
 * 读请求账本：**不补 0** —— 文件不存在/读不了就显式 `readable=false`。
 *
 * ⚠️ **在途崩溃的判定**：`attempt_started` 没有配对的 `attempt_finished` ⇒ 该请求**可能已经
 *    到达提供方**（进程死在返回前）⇒ 成本**无法确认** ⇒ 编排器必须停止序列。
 *
 * ⚠️ **客户端 abort**（`unverifiedReason='client_abort'`）**不**判为"成本无法确认"：
 *    它是政策 A 的有界未确认事件，单独计数；是否阻断由事件数上限 K 决定。
 */
export function readAttemptLedger(path: string): F1AttemptLedgerSummary {
  if (!existsSync(path)) return emptyLedger(false, 0, false)
  let text: string
  try { text = readFileSync(path, 'utf8') } catch { return emptyLedger(false, 0, false) }
  const lines = text.split(/\r?\n/).filter(line => line.trim() !== '')
  const started = new Set<number>()
  const finished = new Set<number>()
  let refused = 0
  let charged = 0
  let reported = 0
  let missing = 0
  let unverifiable = false
  let abortEvents = 0
  let abortFloor = 0
  for (const line of lines) {
    let entry: Record<string, unknown>
    try { entry = JSON.parse(line) as Record<string, unknown> } catch {
      return { ...emptyLedger(false, lines.length, true), lines: lines.length }
    }
    const phase = entry.phase as F1LedgerPhase | undefined
    const sequence = typeof entry.sequence === 'number' ? entry.sequence : undefined
    if (phase === 'attempt_started' && sequence !== undefined) started.add(sequence)
    if (phase === 'attempt_finished') {
      if (sequence !== undefined) finished.add(sequence)
      if (typeof entry.chargedTokens === 'number') charged += entry.chargedTokens
      if (typeof entry.reportedTokens === 'number') reported += entry.reportedTokens
      if (entry.usageMissing === true) missing += 1
      const isAbort = entry.unverifiedReason === 'client_abort'
      if (isAbort) {
        abortEvents += 1
        abortFloor += typeof entry.chargedFloorTokens === 'number'
          ? entry.chargedFloorTokens
          : (typeof entry.chargedTokens === 'number' ? entry.chargedTokens : 0)
      } else if (entry.costVerifiable === false) {
        unverifiable = true
      }
    }
    if (phase === 'attempt_refused') refused += 1
  }
  const inFlightAttempts = [...started].filter(sequence => !finished.has(sequence)).length
  if (inFlightAttempts > 0) unverifiable = true
  return {
    readable: true, lines: lines.length,
    requestsAttempted: started.size, requestsFinished: finished.size, requestsRefused: refused,
    inFlightAttempts,
    unverifiedCostEventCount: abortEvents, unverifiedFloorTokens: abortFloor,
    tokensCharged: charged, tokensReported: reported, usageMissingCount: missing,
    costUnverifiable: unverifiable,
  }
}

export interface F1UnitAccounting {
  /** 成本是否可入账（已确认，或仅含 ≤K 个有界未确认事件） */
  costConfirmed: boolean
  /**
   * `confirmed` = 全部已确认；`confirmed_with_unverified_events` = 含 ≤K 个客户端 abort 的有界未确认事件；
   * `unverifiable` = 成本无法确认（必须停止）。
   */
  costStatus: 'confirmed' | 'confirmed_with_unverified_events' | 'unverifiable'
  /** 是否必须停止整个序列并标 INCOMPLETE */
  mustStop: boolean
  reason?: string
  requestsAttempted: number
  tokensCharged: number
  tokensReported: number
  usageMissingCount: number
  costUnverifiable: boolean
  unverifiedCostEventCount: number
  unverifiedFloorTokens: number
}

/**
 * 一个单元结束后的**统一对账**（成功、失败、崩溃都走这里；编排器只信账本）。
 *
 * 判据（缺一即 cannot confirm）：
 *  · 请求账本不可读/损坏 ⇒ 无法确认（**必须停止序列**，因为有请求可能已发生但没账）
 *  · 账本里出现 `costVerifiable=false` ⇒ 成本未确认（停止）
 *  · 有单元报告但与账本不一致 ⇒ 成本未确认（停止）
 *  · 单元失败但账本可读且可确认 ⇒ 成本已确认（**不**强制停止；整体仍记 INCOMPLETE）
 */
export function accountUnitOutcome(input: {
  ledger: F1AttemptLedgerSummary
  reportCost?: { requestsAttempted: number, tokensCharged: number, tokensReported: number, usageMissingCount: number, costUnverifiable: boolean }
  reportExists: boolean
  error?: string
  /** 政策 A 的事件上限 K（缺省 `F1_ABORT_POLICY.maxUnverifiedCostEvents`） */
  maxUnverifiedCostEvents?: number
}): F1UnitAccounting {
  const base = {
    requestsAttempted: input.ledger.requestsAttempted,
    tokensCharged: input.ledger.tokensCharged,
    tokensReported: input.ledger.tokensReported,
    usageMissingCount: input.ledger.usageMissingCount,
    costUnverifiable: input.ledger.costUnverifiable,
    unverifiedCostEventCount: input.ledger.unverifiedCostEventCount,
    unverifiedFloorTokens: input.ledger.unverifiedFloorTokens,
  }
  if (!input.ledger.readable) {
    return { ...base, costConfirmed: false, costStatus: 'unverifiable', mustStop: true, reason: '请求账本不可读（无法确认成本）' }
  }
  if (input.ledger.inFlightAttempts > 0) {
    return {
      ...base, costConfirmed: false, costStatus: 'unverifiable', mustStop: true,
      reason: `请求在途崩溃（账本有 ${String(input.ledger.inFlightAttempts)} 次未完成的尝试）`,
    }
  }
  // 政策 A：客户端 abort 的有界未确认事件**超过上限**才阻断序列
  const maxUnverified = input.maxUnverifiedCostEvents ?? F1_ABORT_POLICY.maxUnverifiedCostEvents
  if (input.ledger.unverifiedCostEventCount > maxUnverified) {
    return {
      ...base, costConfirmed: false, costStatus: 'unverifiable', mustStop: true,
      reason: `未确认成本事件超过上限（${String(input.ledger.unverifiedCostEventCount)} > ${String(maxUnverified)}）`,
    }
  }
  if (input.ledger.costUnverifiable) {
    return { ...base, costConfirmed: false, costStatus: 'unverifiable', mustStop: true, reason: 'usage 不完整（成本无法确认）' }
  }
  if (input.reportExists && input.reportCost !== undefined) {
    if (input.reportCost.requestsAttempted !== base.requestsAttempted
      || input.reportCost.tokensCharged !== base.tokensCharged
      || input.reportCost.tokensReported !== base.tokensReported
      || input.reportCost.usageMissingCount !== base.usageMissingCount
      || input.reportCost.costUnverifiable !== base.costUnverifiable) {
      return { ...base, costConfirmed: false, costStatus: 'unverifiable', mustStop: true, reason: '单元报告与请求账本不一致（成本无法确认）' }
    }
  }
  return {
    ...base, costConfirmed: true, mustStop: false,
    costStatus: input.ledger.unverifiedCostEventCount > 0 ? 'confirmed_with_unverified_events' : 'confirmed',
  }
}

// ---------------------------------------------------------------------------
// started.lock：防重跑
// ---------------------------------------------------------------------------

/**
 * 在运行目录里原子创建 `started.lock`。
 *
 * ⚠️ 用 `O_EXCL`（`flag: 'wx'`）：**文件已存在就必拒**，不删、不覆盖、不"清空再跑"。
 *    真实运行**不提供**释放/删除 API —— 删锁是手工事故动作，不该由代码自动做。
 */
export function acquireStartedLock(directory: string, startMarker: string, now = Date.now()): { path: string } {
  mkdirSync(directory, { recursive: true })
  const path = resolve(directory, 'started.lock')
  let fd: number
  try {
    fd = openSync(path, 'wx')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return fail('already_started', `started.lock 已存在（同一封存不能跑第二次）：${path}`)
    }
    throw error
  }
  try {
    writeSync(fd, `${JSON.stringify({ marker: startMarker, pid: process.pid, startedAt: now })}\n`)
  } finally {
    closeSync(fd)
  }
  return { path }
}

// ---------------------------------------------------------------------------
// 封存清单：构造 / 校验 / 漂移
// ---------------------------------------------------------------------------

export interface F1SealGateSource {
  path: string
  sha256: string
}

export interface F1SealGateReading {
  id: F1GateId | string
  status: 'PASS' | 'FAIL' | 'NOT RUN' | 'INVALID' | 'MISSING'
  checks: number | null
  /** 这份读数覆盖的预注册门（如 G3–G7 由同一组控制共同支撑） */
  covers?: string[]
  /** 一份门读数可以由多份报告支撑（例：G2 的三个世界报告） */
  sources: F1SealGateSource[]
}

export interface F1SealIdentity {
  sourceFingerprint: string
  imageDigest: string
}

export interface F1SealAuthorizationInput {
  modelCallsAuthorized: boolean
  productionActivationAuthorized: false
  /** 本次封存是否零请求（必须为 0；封存本身不许发请求） */
  modelRequestsAtSeal: 0
}

export interface F1SealAuthorization extends F1SealAuthorizationInput {
  /** 授权后必须**重新封存**（本次清单不含运行授权时为 true） */
  requiresResealOnAuthorization: boolean
}

export interface F1SealInput {
  protocolId: string
  sealedAt: string
  bindings: F1SealBinding[]
  identity: F1SealIdentity
  endpoint: F1EndpointMetadata & { metadataSha256: string }
  parameters: F1RequestParameters
  /** 门读数索引文件（本身也要进封存；索引里的每份报告摘要都复核过） */
  gateBundle: { path: string, sha256: string }
  gateReadings: F1SealGateReading[]
  budget: {
    perTask: typeof F1_TASK_BUDGET
    sequence: { requests: number; totalTokens: number; wallClockSeconds: number }
  }
  /** 成本/中止政策（政策 A：客户端 abort 的有界未确认成本 + 事件上限 K） */
  policy?: typeof F1_ABORT_POLICY
  units: Array<{ unit: string; worldId: string; arm: 'A' | 'B' | 'C'; tasks: string[] }>
  outputPath: string
  authorization: F1SealAuthorizationInput
  notes?: string[]
}

export interface F1SealedManifest extends F1SealInput {
  schema: typeof F1_SEAL_SCHEMA
  kind: typeof F1_SEAL_KIND
  runnerId: typeof F1_RUNNER_ID
  status: typeof F1_SEAL_STATUS_AUTHORIZED | typeof F1_SEAL_STATUS_NOT_AUTHORIZED
  startMarker: string
  /** 封存清单的**自指纹**（对上面全部字段；运行前可复核） */
  selfDigest: string
}

const stable = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stable)
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort()) out[key] = stable(source[key])
    return out
  }
  return value === undefined ? '__undefined__' : value
}
const stableJson = (value: unknown): string => JSON.stringify(stable(value))

/**
 * 构造封存清单：**任何缺项都拒绝**（fail-closed）。
 *
 * 拒绝条件（逐条，G8 门会单独断言）：
 *  · 绑定项不全 / 摘要不是 64 hex / `MISSING`
 *  · 身份 `UNBOUND`（源码指纹或镜像 id 没绑定）
 *  · 门结果里有 `MISSING` / `NOT RUN` / `FAIL` / `INVALID`（没有 PASS 读数就不许封存）
 *  · 端点非法（回环 / 空模型 / 无 key）
 *  · 参数与 `F1_REQUEST_PARAMETERS` 不一致（封存参数只能来自这一份常量）
 *  · 预算非正、单元数与预注册规模不一致
 */
export function buildSealedManifest(input: F1SealInput): F1SealedManifest {
  for (const id of F1_REQUIRED_SEAL_BINDINGS) {
    const binding = input.bindings.find(item => item.id === id)
    if (binding === undefined) fail('binding_missing', `缺少绑定：${id}`)
    if (!isDigest(binding.sha256)) fail('binding_unbound', `${id}: ${binding.sha256}`)
  }
  if (input.bindings.length !== F1_REQUIRED_SEAL_BINDINGS.length) {
    fail('seal_incomplete', `绑定项数量 ${input.bindings.length} ≠ ${F1_REQUIRED_SEAL_BINDINGS.length}`)
  }
  if (!isDigest(input.identity.sourceFingerprint) || input.identity.sourceFingerprint === 'UNBOUND') {
    fail('identity_unbound', `sourceFingerprint=${input.identity.sourceFingerprint}`)
  }
  if (input.identity.imageDigest === 'UNBOUND' || input.identity.imageDigest.trim() === '') {
    fail('identity_unbound', `imageDigest=${input.identity.imageDigest}`)
  }
  if (!isDigest(input.endpoint.metadataSha256)) fail('endpoint_invalid', 'metadataSha256 非法')
  if (!(input.endpoint.apiKeyLength > 0) || !input.endpoint.apiKeyPresent) {
    fail('endpoint_invalid', 'key 缺失（封存不记取值，但必须证明存在）')
  }
  if (!isDigest(input.gateBundle.sha256)) fail('gate_reading_missing', `gate bundle: ${input.gateBundle.sha256}`)
  for (const gate of input.gateReadings) {
    if (gate.status === 'MISSING') fail('gate_reading_missing', `${gate.id}`)
    if (gate.sources.length === 0) fail('gate_reading_missing', `${gate.id}: 没有来源`)
    for (const source of gate.sources) {
      if (!isDigest(source.sha256)) fail('gate_reading_missing', `${gate.id}: ${source.path}=${source.sha256}`)
    }
    if (gate.status !== 'PASS') fail('gate_reading_not_pass', `${gate.id}: ${gate.status}`)
  }
  for (const id of F1_REQUIRED_GATE_IDS) {
    if (!input.gateReadings.some(gate => gate.id === id)) fail('gate_reading_missing', `缺少门读数：${id}`)
  }
  const parameters = input.parameters
  if (parameters.candidateCount !== F1_REQUEST_PARAMETERS.candidateCount
    || parameters.responseFormat !== F1_REQUEST_PARAMETERS.responseFormat
    || parameters.maxCompletionTokens !== F1_REQUEST_PARAMETERS.maxCompletionTokens
    || parameters.temperatureRequested !== F1_REQUEST_PARAMETERS.temperatureRequested
    || parameters.reasoningEffort !== F1_REQUEST_PARAMETERS.reasoningEffort) {
    fail('invalid_parameter', '请求参数偏离 F1_REQUEST_PARAMETERS（不许按结果换参数）')
  }
  const { requests, totalTokens, wallClockSeconds } = input.budget.sequence
  if (!(requests > 0) || !(totalTokens > 0) || !(wallClockSeconds > 0)) {
    fail('invalid_parameter', `序列预算非正：${String(requests)}/${String(totalTokens)}/${String(wallClockSeconds)}`)
  }
  if (input.units.length !== 9) fail('seal_incomplete', `执行单元 ${input.units.length} ≠ 9`)
  const expectedTasks = input.units.reduce((sum, unit) => sum + unit.tasks.length, 0)
  if (expectedTasks !== 72) fail('seal_incomplete', `臂任务 ${expectedTasks} ≠ 72`)
  if (input.authorization.modelRequestsAtSeal !== 0) {
    fail('seal_incomplete', '封存本身不得发模型请求')
  }
  if (input.authorization.productionActivationAuthorized !== false) {
    fail('production_activation_forbidden', '本实验封存不得包含生产激活授权')
  }

  const status = input.authorization.modelCallsAuthorized
    ? F1_SEAL_STATUS_AUTHORIZED
    : F1_SEAL_STATUS_NOT_AUTHORIZED
  const body: Omit<F1SealedManifest, 'startMarker' | 'selfDigest' | 'authorization'> & {
    authorization: F1SealAuthorization
  } = {
    schema: F1_SEAL_SCHEMA,
    kind: F1_SEAL_KIND,
    runnerId: F1_RUNNER_ID,
    status,
    ...input,
    authorization: { ...input.authorization, requiresResealOnAuthorization: !input.authorization.modelCallsAuthorized },
  }
  const startMarker = sha256Text(stableJson({
    sealedAt: input.sealedAt,
    bindings: input.bindings.map(item => ({ id: item.id, sha256: item.sha256 })).sort((a, b) => a.id.localeCompare(b.id)),
    identity: input.identity,
    endpoint: input.endpoint,
    parameters: input.parameters,
    gateBundle: input.gateBundle.sha256,
    gates: input.gateReadings.map(item => ({
      id: item.id,
      status: item.status,
      sources: item.sources.map(source => ({ path: source.path, sha256: source.sha256 })).sort((a, b) => a.path.localeCompare(b.path)),
    })).sort((a, b) => a.id.localeCompare(b.id)),
    budget: input.budget,
    units: input.units.map(item => item.unit).sort(),
  }))
  const manifest = { ...body, startMarker, selfDigest: sha256Text(stableJson({ ...body, startMarker })) }
  return manifest
}

export interface F1SealCurrent {
  bindings: Record<string, string>
  identity: { sourceFingerprint: string | undefined; imageDigest: string | undefined }
  endpoint: { host: string; model: string; apiKeyLength: number; metadataSha256: string }
  parameters: F1RequestParameters
}

/**
 * 封存漂移检查：**逐项**列出不一致；任何一条 ⇒ 运行器拒绝跑（不"挑着看"）。
 */
export function sealIntegrity(manifest: F1SealedManifest, current: F1SealCurrent): string[] {
  const drift: string[] = []
  for (const binding of manifest.bindings) {
    const digest = current.bindings[binding.id]
    if (digest === undefined) drift.push(`binding ${binding.id}: 当前缺失`)
    else if (digest === 'MISSING') drift.push(`binding ${binding.id}: 当前 MISSING`)
    else if (digest !== binding.sha256) drift.push(`binding ${binding.id}: ${binding.sha256} -> ${digest}`)
  }
  if (current.identity.sourceFingerprint === undefined) drift.push('identity sourceFingerprint: 当前未提供')
  else if (current.identity.sourceFingerprint !== manifest.identity.sourceFingerprint) {
    drift.push(`identity sourceFingerprint: ${manifest.identity.sourceFingerprint} -> ${current.identity.sourceFingerprint}`)
  }
  if (current.identity.imageDigest === undefined) drift.push('identity imageDigest: 当前未提供')
  else if (current.identity.imageDigest !== manifest.identity.imageDigest) {
    drift.push(`identity imageDigest: ${manifest.identity.imageDigest} -> ${current.identity.imageDigest}`)
  }
  if (current.endpoint.host !== manifest.endpoint.host) {
    drift.push(`endpoint host: ${manifest.endpoint.host} -> ${current.endpoint.host}`)
  }
  if (current.endpoint.model !== manifest.endpoint.model) {
    drift.push(`endpoint model: ${manifest.endpoint.model} -> ${current.endpoint.model}`)
  }
  if (current.endpoint.apiKeyLength !== manifest.endpoint.apiKeyLength) {
    drift.push(`endpoint key length: ${manifest.endpoint.apiKeyLength} -> ${current.endpoint.apiKeyLength}`)
  }
  if (current.endpoint.metadataSha256 !== manifest.endpoint.metadataSha256) {
    drift.push('endpoint metadata digest 不一致')
  }
  if (current.parameters.candidateCount !== manifest.parameters.candidateCount) drift.push('parameters candidateCount')
  if (current.parameters.responseFormat !== manifest.parameters.responseFormat) drift.push('parameters responseFormat')
  if (current.parameters.maxCompletionTokens !== manifest.parameters.maxCompletionTokens) drift.push('parameters maxCompletionTokens')
  if (current.parameters.temperatureRequested !== manifest.parameters.temperatureRequested) drift.push('parameters temperatureRequested')
  if (current.parameters.reasoningEffort !== manifest.parameters.reasoningEffort) drift.push('parameters reasoningEffort')
  return drift
}

const hasText = (value: string | undefined): boolean => (value ?? '').trim() !== ''

/**
 * 运行授权闸（G8 的"参数/源码/镜像漂移拒跑"＋"防重跑"之外的**授权**那一层）。
 *
 * ⚠️ 这是**实验运行授权**，不是生产激活：`productionActivationAuthorized` 必须为 false。
 */
export function assertRunAuthorized(input: {
  manifest: F1SealedManifest
  drift: string[]
  env: Record<string, string | undefined>
}): void {
  const { manifest, drift, env } = input
  if (drift.length > 0) fail('seal_drift', drift.join('; '))
  if (manifest.status !== F1_SEAL_STATUS_AUTHORIZED || manifest.authorization.modelCallsAuthorized !== true) {
    fail('run_not_authorized', '封存清单不含运行授权（须用户明确授权后重新封存）')
  }
  if (env.F1_MODEL_CALLS_AUTHORIZED !== '1') {
    fail('authorization_marker_missing', '缺少显式授权标记 F1_MODEL_CALLS_AUTHORIZED=1')
  }
  if (!(env.SERVERSIM_MARKER ?? '').startsWith('lg-serversim@')) {
    fail('serversim_required', '真实运行必须在 serversim 内（SERVERSIM_MARKER）')
  }
  if (hasText(env.F1_OFFLINE_MODE) || hasText(env.F1_ALLOW_OFFLINE)) {
    fail('offline_marker_forbidden', '真实运行禁止离线/夹具标记')
  }
  if (manifest.authorization.productionActivationAuthorized !== false) {
    fail('production_activation_forbidden', '实验封存不得授权生产激活')
  }
}

/** 读封存清单；文件不存在 ⇒ `missing_seal`（不是"跳过封存"）。 */
export function loadSealedManifest(path: string): F1SealedManifest {
  if (!existsSync(path)) return fail('missing_seal', path)
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as F1SealedManifest
  if (parsed.schema !== F1_SEAL_SCHEMA || parsed.kind !== F1_SEAL_KIND) {
    fail('seal_incomplete', `封存清单 schema/kind 不符：${String(parsed.schema)}/${String(parsed.kind)}`)
  }
  // 自指纹复核：清单被手改过就拒绝（防止"改一个字再跑"）
  const { selfDigest, ...body } = parsed
  if (selfDigest !== sha256Text(stableJson(body))) fail('seal_drift', '封存清单自指纹不符（清单被修改）')
  return parsed
}
