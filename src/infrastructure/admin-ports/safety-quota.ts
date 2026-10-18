/**
 * A1 / **WP2：`safety_quota` 只读面的真端口**（第二个面）。
 *
 * ============================================================================
 *  两条刻意的设计
 * ============================================================================
 * ```text
 * ① **配置面能读的现在就读**：风险上限 / 额度窗口 / 额度上限来自**有效配置**
 *    （`CHARACTER_ACTION_MAX_RISK` 等）⇒ 不依赖数据库 ⇒ 核心停机时**照样能读**（`A2`/`D02` 的精神）
 * ② **读不到的**（用量、最近拒绝：在动作账本里）**不用 0 冒充**：
 *    行里给 `null`，并把字段名放进 payload 的 `unavailable`
 *    —— "不知道"与"是零"是两件事，这条在本仓库是铁律（沿用 `D08` 的三态口径）
 * ```
 * ⚠️ 账本读数由**注入**的 reader 提供（接口见下）：本模块不 import 数据库。
 */
import type { AdminReadSurfacePayload } from '../admin/query-ports.ts'

/**
 * 额度窗口的**闭集**（与**实际实现**对齐；加第三种要显式改契约 + 冻结清单的语义说明）。
 *
 * ```text
 * ⚠️⚠️ 2026-10-14 **自我更正**：第一版写成 `'deployment_total' | 'per_request'` 并**硬编码**
 *   `deployment_total` —— 那是**一个不存在的窗口**：仓库里真正实现的是
 *   **按策略时区的"日"额度**（`notification-store.ts:894 countQuotaUsage(db, {characterId, dayStart, dayEnd})`；
 *   `main.ts:6633` 注释逐字："日额度 ← countQuotaUsage（按**策略时区**的日界，不是宿主机）"）。
 *   ⇒ 报 `deployment_total` 就是**假读数**（页面会显示一个没人实现过的窗口名）。
 * ⚠️ `per_request`（每轮 ≤1，`search-need.ts:294`）是**另一个**额度，与日额度**不是一个量**，
 *   不许混成一个字段 —— 它作为闭集成员保留，但**不是**本面的默认窗口。
 * ```
 */
export type QuotaWindow = 'daily_policy_tz' | 'per_request'

/** 本面**默认**报的窗口：日额度（按策略时区）——**不是**硬编码一个没实现的名字 */
export const DEFAULT_QUOTA_WINDOW: QuotaWindow = 'daily_policy_tz'

/** 账本侧读数（**注入**；没注入 ⇒ 那两个字段如实 unavailable） */
export interface QuotaLedgerReader {
  /** 指定窗口内的已用量（**原子预留后的**实际占用） */
  used(window: QuotaWindow): Promise<number>
  /** 最近若干条**具名拒绝**（只放原因码与时刻，**不放正文**） */
  recentDenials(limit: number): Promise<{ reason: string; at: string }[]>
}

export interface SafetyQuotaInput {
  /** 有效配置（**注入**：`effective_config` 的同一份来源） */
  readonly config: Readonly<Record<string, string | undefined>>
  /** 账本 reader（可选；缺 ⇒ `quotaUsed`/`recentDenials` 进 `unavailable`） */
  readonly ledger?: QuotaLedgerReader | undefined
  /** 要报哪个窗口（缺省 `daily_policy_tz`；给 `per_request` 时**必须**同时改冻结清单的语义说明） */
  readonly window?: QuotaWindow | undefined
  /** 最近拒绝取几条（缺省 5；上限 20） */
  readonly denialLimit?: number | undefined
  readonly now?: (() => Date) | undefined
}

/**
 * 风险上限的**闭集**（`R1`/`R2`/`R3`）。
 *
 * ⚠️ 第一版写成 `/^R[0-9]$/` ⇒ `R9` 会被当成**合法上限**原样报出去（那是一个**不存在的档**）。
 *    闭集要**具名**：加档必须显式改这里（并同步 `effective_config` 的读法）。
 */
const RISK_CEILINGS: readonly string[] = ['R1', 'R2', 'R3']

/** 从配置里取风险上限（缺省 R1；**不在闭集就不猜**，如实标 `invalid`） */
export function riskCeilingOf(config: Readonly<Record<string, string | undefined>>): string {
  const raw = config.CHARACTER_ACTION_MAX_RISK?.trim()
  if (raw === undefined || raw === '') return 'R1（代码缺省）'
  return RISK_CEILINGS.includes(raw) ? raw : `invalid:${raw}`
}

/** 从配置里取额度上限（缺省 0 = 未启用；非数字 ⇒ 如实标 `invalid`） */
export function quotaLimitOf(config: Readonly<Record<string, string | undefined>>): number | string {
  const raw = config.CHARACTER_WEB_SEARCH_QUOTA?.trim() ?? config.M55_SEARCH_QUOTA?.trim()
  if (raw === undefined || raw === '') return 0
  const parsed = Number(raw)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : `invalid:${raw}`
}

export function createSafetyQuotaPort(input: SafetyQuotaInput): () => Promise<AdminReadSurfacePayload> {
  const denialLimit = Math.min(Math.max(input.denialLimit ?? 5, 1), 20)
  return async () => {
    /* ⚠️ 窗口由调用方给（缺省 = 日额度）；**不再硬编码**一个没实现过的名字 */
    const window: QuotaWindow = input.window ?? DEFAULT_QUOTA_WINDOW
    const row: Record<string, unknown> = {
      riskCeiling: riskCeilingOf(input.config),
      quotaWindow: window,
      quotaLimit: quotaLimitOf(input.config),
      quotaUsed: null,
      recentDenials: null,
    }
    const unavailable: string[] = []
    if (input.ledger === undefined) {
      unavailable.push('quotaUsed', 'recentDenials')
    } else {
      try {
        row.quotaUsed = await input.ledger.used(window)
        row.recentDenials = await input.ledger.recentDenials(denialLimit)
      } catch {
        /* 账本读失败 ⇒ 如实"不可用"，**不**退化成 0（0 会被读成"没用过额度"） */
        row.quotaUsed = null
        row.recentDenials = null
        unavailable.push('quotaUsed', 'recentDenials')
      }
    }
    return {
      surface: 'safety_quota',
      generatedAt: (input.now ?? (() => new Date()))().toISOString(),
      items: [row],
      ...(unavailable.length === 0 ? {} : { unavailable }),
    }
  }
}
