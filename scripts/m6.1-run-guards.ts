/**
 * M6.1 —— **运行中的中止闸**（装置层，不参与任何产品判定）。
 *
 * ============================================================================
 *  它为什么存在（2026-09-24 实测）
 * ============================================================================
 * ```text
 * 端点健康预检（`m6.1-preflight-lib.ts`）放行了一次正式 round 1（12:40Z · 3/3 探针通过），
 * 而**一分钟内**窗口就崩塌了：
 *   23 个轮次里 **21 个 exit 1 + 回复 0 字**（1.8–2.0 秒的"快速失败"），只有 2 个成功
 *   —— 而且失败与成功**交错**（SRP-A-09 拿到了 60 字回复，紧邻的 A-08 全失败）。
 * ⇒ 三次探针的预检挡不住**抖动**：一轮要跑 59 条 × 约 8 秒，窗口可以在中途死掉。
 *   如果再跑下去，就是 59 条 + 118 次 judge 调用全烧在一个死窗口上（这已经发生过两次）。
 * ```
 * ⇒ 结论：开跑前要证明"现在是通的"（预检），**跑起来之后还要盯着"是不是正在死"**（本闸）。
 *
 * ⚠️ 两个闸都只回答**装置**问题；它们都**不**改变任何产品判据，
 *    也都不允许把"没跑成"读成"她答对了/她违规了"。
 */

/** 连续多少个轮次失败就中止（缺省 3：单次抖动不该中止，连续三次不是抖动） */
export const DEFAULT_MAX_CONSECUTIVE_TURN_FAILURES = 3

/**
 * **传输/服务类**的量具失败码（与"判定不稳定"必须分开 —— 用户裁定）。
 *
 * ⚠️ 这张表是**唯一**来源：run 阶段的中止闸、judge 阶段的中止闸、判定器的失败分类
 *    都从这里取。各处各写一份会让"同一句话在两个地方有两个名字"
 *    （本仓库反复登记的那类静默漂移）。
 */
export const TRANSPORT_FAILURE_CODES: readonly string[] = [
  'timeout',
  'call_failure',
  'network',
  'rate_limited',
  'empty_content',
  'truncated',
  'http_error',
  'no_api_key',
  'bad_shape',
]

export function isTransportFailure(failure: string | null | undefined): boolean {
  return failure !== undefined && failure !== null && TRANSPORT_FAILURE_CODES.includes(failure)
}

/**
 * 量具失败的**三类**：
 *   `transport` 传输/服务（含限流）· `unstable` 两次采样不一致（判定不稳定/不可判）· `other`
 *
 * ⚠️ 用户 2026-09-24 裁定：这三类**不许**笼统写成"技术失败"。
 */
export function failureKindOf(failure: string | null | undefined): 'transport' | 'unstable' | 'other' {
  if (failure === undefined || failure === null) return 'other'
  if (isTransportFailure(failure)) return 'transport'
  if (failure === 'alert_state_disagreement') return 'unstable'
  return 'other'
}

/**
 * **尾部连续失败数**：`statuses` 末尾有多少个非零。
 *
 * ⚠️ 只数**尾部**连续段：中间的历史失败不重置计数（那是"这一轮整体在坏"），
 *    而**中间成功一次**会重置（那是抖动，不是窗口死了）。
 * ⚠️ 空数组 ⇒ `0`，调用方**必须**自己区分"0 个失败"与"一个都没跑"
 *    （AGENTS §6.8：`0 检查 / 0 不一致` 与"全部一致"在输出上长得一样）。
 */
export function consecutiveFailureStreak(statuses: readonly number[]): number {
  let streak = 0
  for (let index = statuses.length - 1; index >= 0; index -= 1) {
    if (statuses[index] === 0) break
    streak += 1
  }
  return streak
}

export interface TurnAbortDecision {
  readonly abort: boolean
  readonly streak: number
  readonly reason: string
}

/**
 * 该不该中止（纯函数；阈值 `<= 0` = 关闭本闸）。
 *
 * `attempted` = 已经跑过的**轮次**总数（不是条目数）：它为 0 时"连续失败 0 次"没有意义，
 * 因此那种情况**不**判中止（由上层按"什么都没跑"处理）。
 */
export function decideTurnAbort(input: {
  readonly statuses: readonly number[]
  readonly maxConsecutiveFailures: number
}): TurnAbortDecision {
  const streak = consecutiveFailureStreak(input.statuses)
  if (input.maxConsecutiveFailures <= 0) {
    return { abort: false, streak, reason: '本闸已关闭（--max-consecutive-failures 0）' }
  }
  if (input.statuses.length === 0) {
    return { abort: false, streak: 0, reason: '还没有跑过任何轮次' }
  }
  if (streak < input.maxConsecutiveFailures) {
    return {
      abort: false,
      streak,
      reason: `尾部连续失败 ${String(streak)} < 阈值 ${String(input.maxConsecutiveFailures)}`,
    }
  }
  return {
    abort: true,
    streak,
    reason:
      `尾部连续 ${String(streak)} 个轮次 exit ≠ 0（阈值 ${String(input.maxConsecutiveFailures)}）` +
      ' ⇒ 判为**端点窗口正在崩塌**（不是产品、也不是量具），立即中止，不再烧后面的条目与 judge 调用',
  }
}

/**
 * 轮次失败时**等待并重试**的缺省值（只对 `rate_limited` 生效）。
 *
 * ============================================================================
 *  为什么必须有它（实测：TPM 配额约 10 个轮次就见底）
 * ============================================================================
 * ```text
 * 2026-09-24 第三次尝试：--turn-interval-ms 3000 下前 10 个轮次 100% 成功，
 *   随后 SRP-A-05 turn1 与 SRP-A-06 两轮连续 429 ⇒ 中止闸在 12 个轮次处停下。
 * ⇒ TPM 是**滑动分钟窗**：429 的正确处置是"等一个窗口再试"，而不是"记一次失败"。
 *   否则中止闸会一直在第 10 个轮次把我们打断，130 个轮次永远跑不完。
 * ```
 * ⚠️ 默认 60s：TPM 窗是分钟级的，等一个整窗最稳。
 * ⚠️ 重试**只在** `rate_limited` 上发生 —— 超时/鉴权/5xx 重试不会变好，那三种该如实失败。
 */
export const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60_000
export const DEFAULT_RATE_LIMIT_RETRIES = 5

export interface RateLimitRetryDecision {
  readonly retry: boolean
  readonly waitMs: number
  readonly reason: string
}

/**
 * 这一次失败该不该"等一个冷却窗再试"（纯函数）。
 *
 * `attempt` 从 1 起（第 1 次失败 = attempt 1）。`maxRetries <= 0` ⇒ 关闭重试。
 */
export function decideRateLimitRetry(input: {
  readonly attempt: number
  readonly maxRetries: number
  readonly cooldownMs: number
  readonly hint: TurnFailureHint
}): RateLimitRetryDecision {
  if (input.hint !== 'rate_limited') {
    return { retry: false, waitMs: 0, reason: `不是限流（${input.hint}）⇒ 不重试（重试不会变好）` }
  }
  if (input.maxRetries <= 0) {
    return { retry: false, waitMs: 0, reason: '限流重试已关闭（--rate-limit-retries 0）' }
  }
  if (input.attempt > input.maxRetries) {
    return {
      retry: false,
      waitMs: 0,
      reason: `已重试 ${String(input.maxRetries)} 次仍限流 ⇒ 放弃这一轮（如实记失败）`,
    }
  }
  return {
    retry: true,
    waitMs: input.cooldownMs,
    reason: `限流（第 ${String(input.attempt)} 次）⇒ 等 ${String(Math.round(input.cooldownMs / 1000))}s 后重试同一轮`,
  }
}

/**
 * **模型路由**（端点 + 模型名）—— 只记可公开的部分（host / 模型名 / key 长度）。
 *
 * ============================================================================
 *  为什么它必须进证据（2026-09-24 用户裁定：这一轮改用官方 key）
 * ============================================================================
 * ```text
 * 同一天的读数可以来自**两套配置**：
 *   测试端点  r.dis.115.zone        · deepseek-v4.1-flash（被 TPM 限流反复打断）
 *   官方端点  api.deepseek.com      · deepseek-flash（用户授权，只用于这一轮）
 * 而 `--resume` 原先**只**核对"运行相关树指纹" ⇒ 树一样、配置不同时，
 * 它会把两套配置的读数**悄悄接在一起** —— 正是用户明令禁止的"混成一次验收"。
 * ⇒ 路由进证据 + 进续跑闸；`key` 只记**长度**，永不记取值。
 * ```
 */
export interface ModelRouteReading {
  readonly baseUrlHost: string
  readonly largeModel: string
  readonly smallModel: string
  readonly apiKeyLength: number
  /** 这套环境是从哪来的（人可读；**不含取值**） */
  readonly keySource: string
}

/** 两个路由是否**同一套配置**（host + 两个模型名；不看 key 取值） */
export function sameModelRoute(
  a: ModelRouteReading | null | undefined,
  b: ModelRouteReading | null | undefined
): boolean {
  if (a === undefined || a === null || b === undefined || b === null) return false
  return (
    a.baseUrlHost === b.baseUrlHost &&
    a.largeModel === b.largeModel &&
    a.smallModel === b.smallModel
  )
}

/** 只取 host（`https://api.deepseek.com/v1` → `api.deepseek.com`）；解析不了就原样回。 */
export function hostOfBaseUrl(baseUrl: string): string {
  try {
    return new URL(baseUrl).host
  } catch {
    return baseUrl.trim() === '' ? '(未设置)' : baseUrl.trim()
  }
}

/**
 * 从进程环境读**模型路由**（绝不读/打印 key 取值，只记长度）。
 *
 * `keySource` 由调用方给一句人可读的说明（例如"测试端点包装器"或"用户授权的官方 key"）——
 * 它是**归属**信息：哪一轮用了哪套配置，必须能事后查到。
 */
export function modelRouteFromEnv(
  env: Record<string, string | undefined>,
  keySource: string
): ModelRouteReading {
  return {
    baseUrlHost: hostOfBaseUrl(env.OPENAI_BASE_URL ?? ''),
    largeModel: env.OPENAI_LARGE_MODEL ?? '(未设置)',
    smallModel: env.OPENAI_SMALL_MODEL ?? '(未设置)',
    apiKeyLength: (env.OPENAI_API_KEY ?? '').trim().length,
    keySource,
  }
}

/**
 * 轮次失败的**具名提示**（从子进程 stderr 分类；**只留类别，不留正文**）。
 *
 * ============================================================================
 *  为什么需要它（2026-09-24 的教训）
 * ============================================================================
 * ```text
 * 那一轮 23 个轮次里 21 个 exit 1，而我**说不出为什么** ——
 * 因为 `spawnCliTurn` 当时只收 stdout，**把 stderr 丢了**。
 * 于是"限流 / 超时 / 鉴权失败 / 服务端 5xx"这四种完全不同的处置（等一会儿 / 换网络 /
 * 换 key / 报服务端）在我这里长得一模一样。用户问"是不是限流"，我只能答"我没测到"。
 * ⇒ 现在：stderr 的**分类**进 git（可长期审计），**正文**只进 gitignored 的 local 目录。
 * ```
 */
export type TurnFailureHint =
  | 'none'
  /** 429 / too many requests —— 用户 2026-09-24 判断的那种 */
  | 'rate_limited'
  /** 401 / 403 / invalid api key */
  | 'auth_failed'
  /** 余额 / quota / insufficient */
  | 'quota'
  /** 超时（含上游 socket 超时） */
  | 'timeout'
  /** 连接层（reset / DNS / socket hang up） */
  | 'connection'
  /** 5xx */
  | 'server_error'
  /** 有失败但看不出类别（**不许**猜成上面任何一种） */
  | 'unknown'

const FAILURE_HINT_PATTERNS: readonly { readonly hint: TurnFailureHint; readonly pattern: RegExp }[] = [
  { hint: 'rate_limited', pattern: /(^|[^0-9])429([^0-9]|$)|too many requests|rate[\s_-]?limit/i },
  { hint: 'auth_failed', pattern: /(^|[^0-9])40[13]([^0-9]|$)|unauthorized|forbidden|invalid api key|incorrect api key/i },
  { hint: 'quota', pattern: /insufficient|quota|balance|exceeded your current/i },
  { hint: 'timeout', pattern: /timeout|timed out|ETIMEDOUT|AbortError/i },
  { hint: 'connection', pattern: /ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed/i },
  { hint: 'server_error', pattern: /(^|[^0-9])5[0-9]{2}([^0-9]|$)|bad gateway|service unavailable/i },
]

/**
 * 退出码 + stderr → 具名提示。`status === 0` ⇒ `none`（跑成功了，stderr 有噪声也不算失败）。
 * ⚠️ 认不出来就返回 `unknown` —— **不猜**（猜错的类别会把处置引到错的方向）。
 */
export function classifyTurnFailure(status: number, stderr: string): TurnFailureHint {
  if (status === 0) return 'none'
  for (const row of FAILURE_HINT_PATTERNS) {
    if (row.pattern.test(stderr)) return row.hint
  }
  return 'unknown'
}

/**
 * 中止时对"为什么"的**一句话**（给 `aborted.json` 与终端）。
 *
 * ⚠️ 只用**类别**：正文（可能含请求体）不进 git。
 */
export function failureHintSummary(hints: readonly TurnFailureHint[]): string {
  const failed = hints.filter((hint) => hint !== 'none')
  if (failed.length === 0) return '没有失败的轮次'
  const counts = new Map<TurnFailureHint, number>()
  for (const hint of failed) counts.set(hint, (counts.get(hint) ?? 0) + 1)
  return [...counts.entries()].map(([hint, count]) => `${hint}:${String(count)}`).join(' ')
}
