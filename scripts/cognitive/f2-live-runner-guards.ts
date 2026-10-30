/**
 * **F2 执行器的运行守卫**（纯函数 · 零 IO 除显式文件读写 · 零模型请求）。
 *
 * ============================================================================
 *  这一层回答四个问题（与 F1 执行器同一条纪律，**不复用 F1 的封存材料**）
 * ============================================================================
 * ```text
 * ① 封存绑定什么：协议 v2（protocol.json + task-spec.json）、源码指纹、镜像、任务序列、
 *    门读数、预算上限、模型参数 —— 少一项 / 变了 ⇒ 漂移（fail-closed）
 * ② 能不能跑：封存必须 **已授权**（本批只产出**干封存**：`SEALED_NOT_AUTHORIZED_TO_RUN`）
 * ③ 请求怎么记账：**发出前**计尝试；逐请求检查；usage 缺失 ⇒ 成本不可确认 ⇒ 立即停
 * ④ 崩溃会不会丢题：append-only 请求账本 + 任务账本（`task_started` / `task_finished`）
 * ```
 *
 * ⚠️ 本模块**不**发请求、**不**连数据库、**不**执行动作。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'

/** ⚠️ 单次请求的 prompt token 上界（保守常量，用于**发出前预留**；不是测量值）。 */
export const F2_PROMPT_TOKEN_UPPER_BOUND = 4_000
export const F2_RUNNER_ID = 'f2-live-runner@1'
export const F2_SEAL_SCHEMA = 'f2-sealed-manifest@1'
export const F2_SEAL_KIND = 'f2-benefit-qualified-strategy@2-sealed'
/** 干封存：**没有**真实运行授权。 */
export const F2_SEAL_STATUS_NOT_AUTHORIZED = 'SEALED_NOT_AUTHORIZED_TO_RUN'
export const F2_SEAL_STATUS_AUTHORIZED = 'SEALED_RUN_AUTHORIZED'

export const F2_ARMS = ['A', 'B', 'C'] as const
export const F2_ORDERS = ['cached-first', 'authoritative-first'] as const
export type F2Arm = (typeof F2_ARMS)[number]
export type F2Order = (typeof F2_ORDERS)[number]
/** 单元 = 臂 × 候选顺序（**每个单元独立状态**，见 protocol v2 的 `isolation`）。 */
export const F2_UNITS = F2_ARMS.flatMap(arm => F2_ORDERS.map(order => ({
  unit: `${arm}-${order === 'cached-first' ? 'cf' : 'af'}`, arm, order,
})))
export type F2UnitId = string

/** 每道**测量任务**的模型请求上限（候选 + 失败后恢复 + 有界重试）。 */
export const F2_PER_TASK_REQUESTS = 6
/** 形成阶段是**脚本固定**的 ⇒ 零模型请求。 */
export const F2_FORMATION_MODEL_REQUESTS = 0
export const F2_MEASUREMENT_TASKS_PER_UNIT = 6
/** 每单元请求上限 = 6 题 × 6 次（形成 0 次）；硬上限，不是估计值。 */
export const F2_UNIT_REQUEST_CAP = F2_MEASUREMENT_TASKS_PER_UNIT * F2_PER_TASK_REQUESTS

/** **预算方案（已由用户裁定冻结；运行授权独立）** —— 运行前仍需一次明确授权 + 重新封存。 */
/**
 * 六单元的**物理请求**期望：来自零网络门 `f2-unit-execution-verify` 的实测 fetch 计数。
 * A/C 四单元每单元 6 次（每题一次候选规划）；B 两单元是**脚本**恒定权威 ⇒ 0 次。
 * ⚠️ 旧口径把"脚本候选调用"当模型请求（合计 93）**已作废**。
 */
export const F2_EXPECTED_PHYSICAL_REQUESTS_PER_UNIT = {
  'A-cf': 6, 'A-af': 6, 'B-cf': 0, 'B-af': 0, 'C-cf': 6, 'C-af': 6,
} as const
export const F2_EXPECTED_REQUESTS = Object.values(F2_EXPECTED_PHYSICAL_REQUESTS_PER_UNIT)
  .reduce<number>((total, calls) => total + calls, 0)

// ===========================================================================
//  正式序列（冻结在 task-spec.json 的 `formalSequence`；开发集不参与）
// ===========================================================================
export const F2_FORMAL_SEQUENCE_ID = 'f2-formal-2026-10-26'

export interface F2FormalSequence {
  readonly id: string
  readonly family: string
  readonly formation: readonly unknown[]
  readonly measurement: readonly unknown[]
  readonly units: readonly string[]
  readonly caps: {
    readonly perTaskRequests: number
    readonly perTaskActions: number
    readonly perTaskPlans: number
  }
  readonly sequenceDigest?: string
}

/**
 * 正式序列摘要的**唯一**规范化。
 * ⚠️ 冻结脚本 `artifacts/cognitive/local/f2-executor-20261026/freeze-formal-sequence.cjs`
 *    用的是同一份规范化 ⇒ 改这里必须同时改那边，否则门 ⑩c 会立刻红。
 */
export function f2FormalSequenceDigest(sequence: F2FormalSequence): string {
  return sha256Text(JSON.stringify({
    id: sequence.id,
    family: sequence.family,
    formation: sequence.formation,
    measurement: sequence.measurement,
    units: sequence.units,
    caps: sequence.caps,
  }))
}

/**
 * 读冻结的正式序列并**校验自摘要**（缺 / 形状不对 / 摘要不符 / id 不符 ⇒ 抛，失败关闭）。
 * 返回的 `digest` 就是封存的 `taskSequence` 绑定值。
 */
export function readF2FormalSequence(taskSpecPath: string): { readonly sequence: F2FormalSequence, readonly digest: string } {
  if (!existsSync(taskSpecPath)) throw new Error(`f2_formal_sequence_missing:${taskSpecPath}`)
  const spec = JSON.parse(readFileSync(taskSpecPath, 'utf8')) as { formalSequence?: F2FormalSequence }
  const sequence = spec.formalSequence
  if (sequence === undefined || typeof sequence !== 'object') throw new Error('f2_formal_sequence_missing:formalSequence')
  if (!Array.isArray(sequence.formation) || !Array.isArray(sequence.measurement) || !Array.isArray(sequence.units)) {
    throw new Error('f2_formal_sequence_shape:arrays')
  }
  const digest = f2FormalSequenceDigest(sequence)
  if (sequence.sequenceDigest !== digest) {
    throw new Error(`f2_formal_sequence_digest_mismatch:${String(sequence.sequenceDigest)}`)
  }
  if (sequence.id !== F2_FORMAL_SEQUENCE_ID) throw new Error(`f2_formal_sequence_id_unexpected:${String(sequence.id)}`)
  return { sequence, digest }
}

export const F2_BUDGET_PROPOSAL = {
  units: F2_UNITS.length,
  measurementTasks: F2_UNITS.length * F2_MEASUREMENT_TASKS_PER_UNIT,
  formationTasks: F2_UNITS.length * 4,
  /** 硬上限：每单元 36 次 ⇒ 合计 216 次（零模型的形成任务不计）。 */
  requestsCap: F2_UNITS.length * F2_UNIT_REQUEST_CAP,
  /** 期望值：六单元候选调用读数合计（cf 54 + af 39 = 93），**不是**占位数字。 */
  requestsExpected: F2_EXPECTED_REQUESTS,
  requestsExpectedBasis: 'zero-network gate f2-unit-execution-verify: 物理 fetch 6/6/0/0/6/6（B 臂=脚本，0 次）',
  /** token 上限：按 216 次 × 1 400 估算（**估算**，不冒充真实读数）。 */
  tokensCapEstimate: 216 * 1_400,
  /** ⚠️ 单次请求 completion 上限（1200 会把真实模型回复截断；4096 是修订后值，改它要重封存）。 */
  maxCompletionTokensPerRequest: 8_000,
  /** token 期望：按 93 次 × 1 400 估算（同样是估算，只用于"够不够"的量级判断）。 */
  tokensExpectedEstimate: F2_EXPECTED_REQUESTS * 1_400,
  perTaskRequests: F2_PER_TASK_REQUESTS,
  perTaskActions: 12,
  perTaskPlans: 8,
  /** ✅ 预算已被用户裁定冻结（2026-10-26）。 */
  approved: true,
  approvedAt: '2026-10-26',
  approvedBasis: '用户裁定（本会话）：裁定预算并按顺序推进（冻结正式序列 → 实现 --unit → 重封存；**运行前另需一次授权**）',
  /** ⚠️ 预算获批 ≠ 运行获批：真实运行仍需要授权 + 重新封存。 */
  runAuthorizationRequired: true,
  note: '提案已被用户裁定冻结；真实运行仍需**明确运行授权**并重新封存（干封存不能直接跑）',
} as const

export const F2_REQUIRED_SEAL_BINDINGS = [
  'protocol', 'taskSpec', 'sourceFingerprint', 'image', 'taskSequence', 'gateReadings', 'budgetCaps', 'modelParameters',
] as const
export type F2SealBindingId = (typeof F2_REQUIRED_SEAL_BINDINGS)[number]

/** 真实运行前必须**全部 PASS** 的门（缺一项 ⇒ 不许封存）。 */
export const F2_REQUIRED_GATE_IDS = [
  'f2-formation-split-calibration-verify',
  'f2-unit-execution-verify',
  'f2-sequence-verify',
  'f2-provisioning-verify',
  'f2-simhost-e2e-verify',
  'f2-planner-shapes-verify',
  'f2-actionturn-closed-loop-verify',
  'f2-task-entry-verify',
  'f2-source-scope-authorization-verify',
  'f2-source-attribution-verify',
  'f2-rule-source-scope-verify',
  'f2-prep-read-verify',
  'f2-assembly-entry-verify',
  'f2-source-veto-integration-verify',
  'f1-precondition-reachability-verify',
] as const

/** 守卫的闭集码（**不得**发明新码）。 */
export const F2_GUARD_CODES = [
  'missing_seal',
  'seal_drift',
  'run_not_authorized',
  'already_started',
  'unit_not_implemented',
  'task_request_cap',
  'budget_requests',
  'budget_tokens',
  'cost_unverifiable',
  'ledger_unreadable',
  'journal_unreadable',
  'unit_mismatch',
] as const
export type F2GuardCode = (typeof F2_GUARD_CODES)[number]

export function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}
export function fileDigestOrMissing(path: string): string {
  return existsSync(path) ? sha256Text(readFileSync(path, 'utf8')) : 'MISSING'
}

export interface F2SealBinding {
  readonly id: F2SealBindingId
  readonly value: string
  readonly source: string
}
/** 收集 8 项绑定（缺文件 ⇒ `MISSING`，**不**当成"没变"）。 */
export function collectF2SealBindings(input: {
  readonly paths: Record<F2SealBindingId, string>
  /** 由调用方给的**计算值**（源码指纹 / 镜像 / 门读数摘要 / 预算摘要 / 模型参数摘要 / 任务序列摘要）。 */
  readonly computed?: Partial<Record<F2SealBindingId, string>>
}): F2SealBinding[] {
  return F2_REQUIRED_SEAL_BINDINGS.map(id => ({
    id,
    value: input.computed?.[id] ?? fileDigestOrMissing(input.paths[id]),
    source: input.computed?.[id] === undefined ? input.paths[id] : 'computed',
  }))
}
export function f2SealDigest(bindings: readonly F2SealBinding[]): string {
  const canonical = [...bindings].sort((a, b) => a.id.localeCompare(b.id)).map(b => `${b.id}=${b.value}`).join('\n')
  return sha256Text(canonical)
}

export interface F2SealedManifest {
  readonly schema: typeof F2_SEAL_SCHEMA
  readonly kind: typeof F2_SEAL_KIND
  readonly sealedAt: string
  readonly status: string
  readonly startMarker: string
  readonly bindings: readonly F2SealBinding[]
  readonly digest: string
  readonly budget: typeof F2_BUDGET_PROPOSAL
  readonly units: readonly string[]
  readonly note: string
}
export function buildF2SealedManifest(input: {
  readonly bindings: readonly F2SealBinding[]
  readonly sealedAt: string
  readonly authorized?: boolean
  /** ⚠️ 诊断模式：清单嵌入**诊断预算**与**诊断单元表**（与绑定的 budgetCaps 一致）。 */
  readonly budget?: typeof F2_BUDGET_PROPOSAL
  readonly units?: readonly string[]
}): F2SealedManifest {
  const digest = f2SealDigest(input.bindings)
  return {
    schema: F2_SEAL_SCHEMA, kind: F2_SEAL_KIND, sealedAt: input.sealedAt,
    status: input.authorized === true ? F2_SEAL_STATUS_AUTHORIZED : F2_SEAL_STATUS_NOT_AUTHORIZED,
    startMarker: sha256Text(`${input.sealedAt}|${digest}|${F2_RUNNER_ID}`).slice(0, 16),
    bindings: input.bindings, digest, budget: input.budget ?? F2_BUDGET_PROPOSAL,
    units: input.units ?? F2_UNITS.map(item => item.unit),
    note: input.authorized === true
      ? '已授权（本仓库**不**自动创建这种封存）'
      : '干封存：**没有**真实运行授权；`--run` 必须被拒绝',
  }
}
/** 漂移：返回不一致的绑定 id（含 `MISSING` 与数量不符）；空数组 = 一致。 */
export function f2SealDrift(manifest: F2SealedManifest, current: readonly F2SealBinding[]): string[] {
  const problems: string[] = []
  for (const id of F2_REQUIRED_SEAL_BINDINGS) {
    const before = manifest.bindings.find(b => b.id === id)
    const now = current.find(b => b.id === id)
    if (before === undefined || now === undefined || before.value !== now.value) problems.push(id)
  }
  if (manifest.bindings.length !== current.length) problems.push('bindings_count')
  if (f2SealDigest(current) !== manifest.digest) problems.push('digest')
  return problems
}

/** 运行授权：只有**封存状态为已授权** + 授权文件在场 才放行；否则给闭集码。 */
export function assertF2RunAuthorized(input: {
  readonly manifest: F2SealedManifest | undefined
  readonly drift: readonly string[]
  readonly authorizationPresent: boolean
}): { readonly ok: true } | { readonly ok: false, readonly code: F2GuardCode } {
  if (input.manifest === undefined) return { ok: false, code: 'missing_seal' }
  if (input.drift.length > 0) return { ok: false, code: 'seal_drift' }
  if (input.manifest.status !== F2_SEAL_STATUS_AUTHORIZED) return { ok: false, code: 'run_not_authorized' }
  if (!input.authorizationPresent) return { ok: false, code: 'run_not_authorized' }
  return { ok: true }
}

// ---------------------------------------------------------------------------
//  请求记账（**发出前**计尝试；usage 缺失 ⇒ 成本不可确认）
// ---------------------------------------------------------------------------
export interface F2ChargedUsage {
  readonly charged: number
  readonly promptTokens: number
  readonly completionTokens: number
  readonly costConfirmed: boolean
}
/** 与 F1 同一条口径：只有 `total_tokens`（或 prompt+completion 同时存在）才算已确认。 */
export function chargeF2Usage(raw: unknown, maxCompletionTokens: number): F2ChargedUsage {
  const usage = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const total = typeof usage.total_tokens === 'number' ? usage.total_tokens : undefined
  const prompt = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : undefined
  const completion = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : undefined
  if (total !== undefined) {
    return { charged: total, promptTokens: prompt ?? 0, completionTokens: completion ?? 0, costConfirmed: true }
  }
  // 已知下限：`(prompt??0)+(completion??max_tokens)`；**输出上限不是总 token 上限**。
  const charged = (prompt ?? 0) + (completion ?? maxCompletionTokens)
  return { charged, promptTokens: prompt ?? 0, completionTokens: completion ?? 0, costConfirmed: false }
}

export interface F2MeterOptions {
  readonly requestsCap: number
  /** ⚠️ 有界未确认成本：客户端 abort 的上限（超过即按 cost_unverifiable 停）。 */
  readonly maxBoundedAborts?: number
  /** ⚠️ **在途预留**：本请求 prompt token 上界；与 maxCompletionTokens 一起在发出前预留。 */
  readonly reservationTokens?: number
  readonly tokensCap: number
  readonly perTaskRequests: number
  readonly maxCompletionTokens: number
  readonly now: () => number
  /**
   * ⚠️ **即时落盘钩子**：`attempt_started` 在 **fetch 之前**回调、`attempt_finished` 在结算后回调。
   *    单元中途崩溃时，已发生的费用仍有 started 记录 ⇒ 对账判"缺结算 ⇒ 成本未知"。
   */
  readonly onAttempt?: (entry: F2AttemptLedgerEntry) => void
}
export interface F2MeterAttempt {
  readonly taskId: string
  readonly purpose: string
  readonly at: number
  readonly charged: number
  readonly costConfirmed: boolean
  /** 客户端 abort 的有界暂扣（政策 A）：**不是**已确认成本。 */
  readonly bounded?: boolean
}
export interface F2RequestMeter {
  /** **发出前**调用：超限 ⇒ 返回闭集码（**不发出、不计尝试**）。 */
  beforeRequest(taskId: string): { ok: true } | { ok: false, code: F2GuardCode }
  /** 拿到响应后调用；`usage` 缺失 ⇒ `costConfirmed=false`（调用方必须停止后续请求）。 */
  charge(taskId: string, purpose: string, rawUsage: unknown): F2ChargedUsage & { stopCode?: F2GuardCode }
  /** 客户端 abort：按已知下限扣账、计入有界事件；超过上限才置全局停止（政策 A）。 */
  chargeBoundedUnconfirmed(taskId: string, purpose: string, reason: string): F2ChargedUsage & { stopCode?: F2GuardCode, boundedAborts: number }
  readonly state: () => { requests: number, tokens: number, costVerifiable: boolean, stopCode?: F2GuardCode }
  readonly attempts: readonly F2MeterAttempt[]
}
export function createF2Meter(options: F2MeterOptions): F2RequestMeter {
  let requests = 0
  let tokens = 0
  let stopCode: F2GuardCode | undefined
  const perTask = new Map<string, number>()
  const attempts: F2MeterAttempt[] = []
  let boundedAborts = 0
  const maxBoundedAborts = options.maxBoundedAborts ?? 8
  return {
    beforeRequest(taskId) {
      if (stopCode !== undefined) return { ok: false, code: stopCode }
      const used = perTask.get(taskId) ?? 0
      // 逐题上限只拒绝**这道题**（不把整条序列钉死）；总量/token 上限才置全局 stop。
      if (used >= options.perTaskRequests) return { ok: false, code: 'task_request_cap' }
      if (requests >= options.requestsCap) { stopCode = 'budget_requests'; return { ok: false, code: stopCode } }
      /*
       * ⚠️ **发出前预留**（冻结提案）：剩余额度必须覆盖"本次 prompt 上界 + completion 上限"，
       *    否则**不发出**（此前只检查已用量，不能证明已预留）。
       */
      if (tokens + (options.reservationTokens ?? 0) + options.maxCompletionTokens > options.tokensCap) {
        stopCode = 'budget_tokens'
        return { ok: false, code: stopCode }
      }
      if (tokens >= options.tokensCap) { stopCode = 'budget_tokens'; return { ok: false, code: stopCode } }
      requests += 1
      perTask.set(taskId, used + 1)
      /* ⚠️ **发出前**（fetch 之前）就落盘：崩溃也只丢"结算"，不丢"发生了请求"。 */
      options.onAttempt?.({ kind: 'attempt_started', taskId, at: options.now() })
      return { ok: true }
    },
    chargeBoundedUnconfirmed(taskId, purpose, reason) {
      const charged = chargeF2Usage(undefined, options.maxCompletionTokens)
      tokens += charged.charged
      boundedAborts += 1
      const at = options.now()
      attempts.push({ taskId, purpose, at, charged: charged.charged, costConfirmed: false, bounded: true })
      options.onAttempt?.({ kind: 'attempt_finished', taskId, charged: charged.charged, costConfirmed: false, bounded: true, reason, at })
      /* ⚠️ 政策 A：客户端 abort 属**有界**未确认成本（已知下限 + 事件 ≤K 才继续）。 */
      if (boundedAborts > maxBoundedAborts) stopCode = 'cost_unverifiable'
      return { ...charged, boundedAborts, ...(stopCode === undefined ? {} : { stopCode }) }
    },
    charge(taskId, purpose, rawUsage) {
      const charged = chargeF2Usage(rawUsage, options.maxCompletionTokens)
      tokens += charged.charged
      const at = options.now()
      attempts.push({ taskId, purpose, at, charged: charged.charged, costConfirmed: charged.costConfirmed })
      options.onAttempt?.({ kind: 'attempt_finished', taskId, charged: charged.charged, costConfirmed: charged.costConfirmed, at })
      if (!charged.costConfirmed) stopCode = 'cost_unverifiable'
      return { ...charged, ...(stopCode === undefined ? {} : { stopCode }) }
    },
    state: () => ({ requests, tokens, costVerifiable: stopCode !== 'cost_unverifiable', ...(stopCode === undefined ? {} : { stopCode }) }),
    attempts,
  }
}

// ---------------------------------------------------------------------------
//  账本与任务账本（append-only；崩溃 ⇒ 已完成题可取回、在途题被标出）
// ---------------------------------------------------------------------------
/** 账本行的两种形态（append-only）：**发出前** started、**结算后** finished。 */
export interface F2AttemptStartedEntry {
  readonly kind: 'attempt_started'
  readonly taskId: string
  readonly at: number
}
export interface F2AttemptFinishedEntry {
  readonly kind: 'attempt_finished'
  readonly taskId: string
  readonly charged: number
  readonly costConfirmed: boolean
  /** 客户端 abort：有界未确认成本（政策 A）。 */
  readonly bounded?: boolean
  readonly reason?: string
  readonly at: number
}
export type F2AttemptLedgerEntry = F2AttemptStartedEntry | F2AttemptFinishedEntry
export function appendF2AttemptLedger(path: string, entry: F2AttemptLedgerEntry): void {
  mkdirSync(path.replace(/[\\/][^\\/]+$/, ''), { recursive: true })
  writeFileSync(path, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', flag: 'a' })
}
export interface F2AttemptLedgerSummary {
  readonly readable: boolean
  readonly entries: readonly F2AttemptLedgerEntry[]
  /** 已**发出**的尝试数（started 计数；被计量拒绝的不计）。 */
  readonly requests: number
  /** 已结算的 token（只加 finished；**不**把未结算当 0）。 */
  readonly tokens: number
  /** 未确认成本：finished 里 costConfirmed=false 的个数 + **缺结算**的在途尝试数。 */
  readonly unconfirmed: number
  /** 有 started 但**没有 finished** 的尝试数（崩溃/网络抛错都会留下它）。 */
  readonly inFlight: number
  /** 有界未确认（客户端 abort）事件数；它们**不**单独导致序列停止（超上限由计量器停）。 */
  readonly boundedUnconfirmed: number
}
export function readF2AttemptLedger(path: string): F2AttemptLedgerSummary {
  const empty = { readable: false, entries: [] as F2AttemptLedgerEntry[], requests: 0, tokens: 0, unconfirmed: 0, inFlight: 0, boundedUnconfirmed: 0 }
  if (!existsSync(path)) return empty
  try {
    const entries = readFileSync(path, 'utf8').split(/\r?\n/).filter(line => line.trim() !== '')
      .map(line => JSON.parse(line) as F2AttemptLedgerEntry)
    const startedByTask = new Map<string, number>()
    const finishedByTask = new Map<string, number>()
    let tokens = 0
    let unconfirmedFinished = 0
    let boundedUnconfirmed = 0
    for (const entry of entries) {
      if (entry.kind === 'attempt_started') startedByTask.set(entry.taskId, (startedByTask.get(entry.taskId) ?? 0) + 1)
      else {
        finishedByTask.set(entry.taskId, (finishedByTask.get(entry.taskId) ?? 0) + 1)
        tokens += entry.charged
        if (!entry.costConfirmed && entry.bounded === true) boundedUnconfirmed += 1
        else if (!entry.costConfirmed) unconfirmedFinished += 1
      }
    }
    let inFlight = 0
    for (const [taskId, started] of startedByTask) inFlight += Math.max(0, started - (finishedByTask.get(taskId) ?? 0))
    return {
      readable: true, entries,
      requests: [...startedByTask.values()].reduce((sum, count) => sum + count, 0),
      tokens, unconfirmed: unconfirmedFinished + inFlight, inFlight, boundedUnconfirmed,
    }
  } catch { return empty }
}

export interface F2TaskJournalEntry {
  readonly kind: 'task_started' | 'task_finished'
  readonly unit: string
  readonly taskId: string
  readonly at: number
  readonly row?: Readonly<Record<string, unknown>>
}
export function appendF2TaskJournal(path: string, entry: F2TaskJournalEntry): void {
  mkdirSync(path.replace(/[\\/][^\\/]+$/, ''), { recursive: true })
  writeFileSync(path, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', flag: 'a' })
}
export interface F2TaskJournalSummary {
  readonly readable: boolean
  readonly started: readonly string[]
  readonly finished: readonly { readonly taskId: string, readonly row?: Readonly<Record<string, unknown>> }[]
  readonly inFlightTaskIds: readonly string[]
}
export function readF2TaskJournal(path: string): F2TaskJournalSummary {
  if (!existsSync(path)) return { readable: false, started: [], finished: [], inFlightTaskIds: [] }
  try {
    const entries = readFileSync(path, 'utf8').split(/\r?\n/).filter(line => line.trim() !== '')
      .map(line => JSON.parse(line) as F2TaskJournalEntry)
    const finished = entries.filter(entry => entry.kind === 'task_finished')
    const finishedIds = new Set(finished.map(entry => entry.taskId))
    const started = entries.filter(entry => entry.kind === 'task_started').map(entry => entry.taskId)
    return { readable: true, started,
      finished: finished.map(entry => ({ taskId: entry.taskId, row: entry.row })),
      inFlightTaskIds: started.filter(id => !finishedIds.has(id)) }
  } catch { return { readable: false, started: [], finished: [], inFlightTaskIds: [] } }
}

/** 单元成本能否确认：账本/任务账本不可读、或含未确认成本 ⇒ 不能确认（停止序列）。 */
export function accountF2Unit(input: {
  readonly unit: string
  readonly reportTaskIds: readonly string[]
  readonly ledger: F2AttemptLedgerSummary
  readonly journal: F2TaskJournalSummary
}): { readonly costConfirmed: boolean, readonly codes: readonly F2GuardCode[], readonly recoveredTasks: readonly string[] } {
  const codes: F2GuardCode[] = []
  if (!input.ledger.readable) codes.push('ledger_unreadable')
  if (!input.journal.readable) codes.push('journal_unreadable')
  /* 未确认成本 = finished 里 costConfirmed=false **+ 缺结算的在途尝试**（崩溃/网络抛错）。 */
  if (input.ledger.unconfirmed > 0) codes.push('cost_unverifiable')
  const recovered = input.journal.finished.map(entry => entry.taskId)
    .filter((id, index, all) => all.indexOf(id) === index)
  if (input.ledger.readable && input.reportTaskIds.length !== 0) {
    const reported = new Set(input.reportTaskIds)
    if (input.ledger.entries.some(entry => entry.kind === 'attempt_finished' && !reported.has(entry.taskId) && entry.costConfirmed)) {
      // 账本里有**未进报告**的已确认成本 ⇒ 成本对账不一致
      codes.push('unit_mismatch')
    }
  }
  return { costConfirmed: codes.length === 0, codes, recoveredTasks: recovered }
}

/**
 * 二次运行拦截（`started.lock`）——**绑定封存身份、固定位置、原子创建**。
 *
 * ```text
 * 锁路径 = <baseDir>/locks/<startMarker>.lock
 * ```
 * ⚠️ `baseDir` 必须是**固定**目录（执行器目录），**不是**每次带新时间戳的运行目录：
 *    否则换个运行目录就能用同一封存再跑一次（用户核对指出的缺口）。
 * ⚠️ 原子性靠 `flag:'wx'`（O_CREAT|O_EXCL）：并发启动时**只有一个**能创建成功，其余 `EEXIST`。
 */
export function acquireF2StartedLock(directory: string, startMarker: string): { readonly path: string } | { readonly code: 'already_started' } {
  const lockDir = `${directory}/locks`
  mkdirSync(lockDir, { recursive: true })
  const path = `${lockDir}/${startMarker}.lock`
  try {
    writeFileSync(path, JSON.stringify({ startMarker, runner: F2_RUNNER_ID, at: Date.now() }), { encoding: 'utf8', flag: 'wx' })
    return { path }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return { code: 'already_started' }
    throw error
  }
}
// ---------------------------------------------------------------------------
//  门读数（真实运行前**全部 PASS** 才允许封存；缺一项 ⇒ 拒绝）
// ---------------------------------------------------------------------------
export type F2GateReadingStatus = 'PASS' | 'FAIL' | 'MISSING'
export type F2GateReadings = Readonly<Record<string, F2GateReadingStatus>>
/**
 * 门读数摘要：**缺项/失败 ⇒ 抛**（fail-closed，不把"没读到"当"通过"）。
 * 返回 `{ digest, passed }`（digest 进封存绑定）。
 */
export function f2GateReadingsDigest(readings: F2GateReadings): { readonly digest: string, readonly passed: readonly string[] } {
  const missing = F2_REQUIRED_GATE_IDS.filter(id => readings[id] === undefined || readings[id] === 'MISSING')
  const failed = F2_REQUIRED_GATE_IDS.filter(id => readings[id] === 'FAIL')
  if (missing.length > 0) throw new Error(`f2_seal_gate_missing:${missing.join(',')}`)
  if (failed.length > 0) throw new Error(`f2_seal_gate_failed:${failed.join(',')}`)
  const canonical = F2_REQUIRED_GATE_IDS.map(id => `${id}=PASS`).join('\n')
  return { digest: sha256Text(canonical), passed: [...F2_REQUIRED_GATE_IDS] }
}