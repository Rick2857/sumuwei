/**
 * QQ 主动联系 —— **通知意图 / 通知实例**的契约与纯函数（WP2）。
 *
 * ============================================================================
 *  载体
 * ============================================================================
 * 计划 [`docs/post-lv2/QQ-Proactive-Messaging-Execution-Plan-2026-10-06.md`] §5 / §6 ·
 * 设计 [`ADR-110`] `D03`（两类触发的选择权限不同）· `D07`（持久化 + 稳定 occurrenceKey）·
 * `D08`（交付真相五态 + 三个终态，不承诺 exactly-once）· `D14`（参数）。
 *
 * ============================================================================
 *  这个模块**只**做三件事（纯函数、零 IO、零框架）
 * ============================================================================
 * ```text
 * ① 稳定键   —— occurrenceKey 的**唯一**构造处（重启不换键、时钟回退不换键）
 * ② 时间判据 —— 单次触发的"可排期"判定（`L-QQP-01`）· 活动时段 · 指定时区的日键
 * ③ 状态机   —— 允许的迁移 + 终态集合 + "哪些状态占额度"
 * ```
 * ⚠️ 它**不**读时钟、**不**读数据库、**不**读环境：调用方把 `now` 传进来。
 *    这条纪律与 `kernel/contracts` 的其它模块一致（"判据"与"授权/IO"分开）。
 *
 * ⚠️ **时区口径**：一律用**具名 IANA 时区**（`Asia/Shanghai`），
 *    **不**继承宿主机时区（计划 §6 逐字）。`Intl` 是语言内建能力（不是 `node:*` 导入），
 *    但它依赖运行时的 tz 数据库 ⇒ 判据里只把它当"给定同一 tz 数据的确定性函数"，
 *    并在门里用**固定瞬间**做正控/负控（不依赖"今天的日期"）。
 */

import { KernelError, type CharacterId, type Timestamp } from './ids.ts'

// ---------------------------------------------------------------------------
// 一、状态与闭集（`D08`）
// ---------------------------------------------------------------------------

/** 触发种类（`D03`）：**两类同等优先**，但选择权限不同 */
export type NotificationKind = 'reminder' | 'care'

export const NOTIFICATION_KINDS: readonly NotificationKind[] = ['reminder', 'care']

/**
 * 意图的状态。
 *
 * ⚠️ `cancelled` 与 `expired` 是**用户可见事实**（"我取消过 / 它过期了"），
 *    不许被后来的任何动作悄悄改回 `pending`（`D13` 的"改回 on 不复活旧授权"同一条纪律）。
 */
export type NotificationIntentStatus =
  | 'pending'
  /** 一次性提醒已经发出（实例到达 `api_accepted` 之后） */
  | 'delivered'
  | 'cancelled'
  | 'expired'
  /** 提醒已过时效且未被交付（与 `expired` 的区别是"从未排上"） */
  | 'missed'

export const NOTIFICATION_INTENT_STATUSES: readonly NotificationIntentStatus[] = [
  'pending',
  'delivered',
  'cancelled',
  'expired',
  'missed',
]

/** 意图的**终态**：一旦进入就不再回到 `pending` */
export const NOTIFICATION_INTENT_TERMINAL_STATUSES: readonly NotificationIntentStatus[] = [
  'delivered',
  'cancelled',
  'expired',
  'missed',
]

/**
 * 实例的状态 —— 与 `ADR-110` `D08` 的图逐字对应：
 *
 * ```text
 * pending → evaluating → prepared → dispatching → api_accepted
 *     └──────────────→ skipped / cancelled / expired
 *                             dispatching → failed_confirmed / delivery_unknown
 * ```
 */
export type NotificationOccurrenceState =
  | 'pending'
  | 'evaluating'
  | 'prepared'
  | 'dispatching'
  | 'api_accepted'
  | 'skipped'
  | 'cancelled'
  | 'expired'
  | 'failed_confirmed'
  | 'delivery_unknown'

export const NOTIFICATION_OCCURRENCE_STATES: readonly NotificationOccurrenceState[] = [
  'pending',
  'evaluating',
  'prepared',
  'dispatching',
  'api_accepted',
  'skipped',
  'cancelled',
  'expired',
  'failed_confirmed',
  'delivery_unknown',
]

/** 终态：进入之后**不允许**再迁移（`D08`：已定案的事实不许被后续轮次改写） */
export const NOTIFICATION_TERMINAL_STATES: readonly NotificationOccurrenceState[] = [
  'api_accepted',
  'skipped',
  'cancelled',
  'expired',
  'failed_confirmed',
  'delivery_unknown',
]

/**
 * 允许的迁移表（**唯一**一处）。
 *
 * ⚠️ 三条**刻意的不存在**（`D08` 的负控就靠它们）：
 * ```text
 * · 没有 failed_confirmed → api_accepted（失败不会自己变成功）
 * · 没有 delivery_unknown → api_accepted（结果不明**永远**不明，不猜）
 * · 没有 delivery_unknown → dispatching（**不自动重发**：未知状态按"避免重复"处理）
 * ```
 */
const OCCURRENCE_TRANSITIONS: Readonly<Record<NotificationOccurrenceState, readonly NotificationOccurrenceState[]>> =
  Object.freeze({
    pending: ['evaluating', 'cancelled', 'expired', 'skipped'],
    evaluating: ['prepared', 'skipped', 'cancelled', 'expired', 'failed_confirmed'],
    prepared: ['dispatching', 'skipped', 'cancelled', 'expired', 'failed_confirmed'],
    dispatching: ['api_accepted', 'failed_confirmed', 'delivery_unknown'],
    api_accepted: [],
    skipped: [],
    cancelled: [],
    expired: [],
    failed_confirmed: [],
    delivery_unknown: [],
  })

export function isTerminalOccurrenceState(state: NotificationOccurrenceState): boolean {
  return (NOTIFICATION_TERMINAL_STATES as readonly string[]).includes(state)
}

export function canTransitionOccurrence(
  from: NotificationOccurrenceState,
  to: NotificationOccurrenceState
): boolean {
  return (OCCURRENCE_TRANSITIONS[from] as readonly string[]).includes(to)
}

/** 迁移判据的**唯一**放行口（非法迁移 ⇒ 抛；调用方不许自己比较字符串） */
export function assertOccurrenceTransition(
  from: NotificationOccurrenceState,
  to: NotificationOccurrenceState
): void {
  if (from === to) return
  if (!canTransitionOccurrence(from, to)) {
    throw new KernelError(
      'validation_error',
      'notification_transition_denied',
      `通知实例不允许从 ${from} 迁移到 ${to}（` +
        (isTerminalOccurrenceState(from) ? `${from} 是终态` : '该跳不在迁移表里') +
        `）—— 见 ADR-110 D08`
    )
  }
}

/**
 * 这个状态**是否已经占用频率额度**。
 *
 * ⚠️ 计划 §6 逐字：**"API 接受与结果不明均占额"**。
 *    ⇒ `dispatching`（已经可能发出去了）、`api_accepted`、`delivery_unknown`、
 *      `failed_confirmed` 都占额；`skipped` / `cancelled` / `expired` 不占
 *      （它们保证**没有**任何字节发出去）。
 * ⚠️ `pending` / `evaluating` / `prepared` **不**占额：它们还没提交网络，
 *    取消它们不该消耗当天的额度。
 */
export function occurrenceOccupiesQuota(state: NotificationOccurrenceState): boolean {
  return state === 'dispatching' || state === 'api_accepted' ||
    state === 'delivery_unknown' || state === 'failed_confirmed'
}

/** 这个状态**是否已经证明"网络请求可能已经发出"**（未知/已接受/已拒绝三态） */
export function occurrenceMayHaveReachedPlatform(state: NotificationOccurrenceState): boolean {
  return state === 'dispatching' || state === 'api_accepted' ||
    state === 'delivery_unknown' || state === 'failed_confirmed'
}

/**
 * 重启时对**遗留 `dispatching`** 的处置（`D08` 表格最后一行）。
 *
 * ⚠️ 它**不是**失败、也**不是**成功：进程在"已提交网络、未落回执"之间死掉 ⇒ 结果不明。
 *    返回 `'delivery_unknown'`，并**不**释放额度。
 * ⚠️ 也**不**按"failed 作业可以重建"那条既有规则重跑（`character_jobs` 的语义**不**外溢到这里）。
 */
export function stateForOrphanedDispatching(): NotificationOccurrenceState {
  return 'delivery_unknown'
}

// ---------------------------------------------------------------------------
// 二、稳定键（`D07`）
// ---------------------------------------------------------------------------

/**
 * 提醒实例的稳定键：**通知 id + 计划版本 + 本次预定时刻**。
 *
 * ⚠️ 三个分量都是**程序事实**（存在意图行里的），没有"随机"、没有"当前时间"。
 *    ⇒ 重启后对同一个 (意图, 计划版本, 时刻) 算出的键**逐字相同** ⇒ 唯一索引天然挡住重复发送。
 * ⚠️ 计划版本进键是刻意的：用户把提醒**改时** ⇒ 计划版本 +1 ⇒ 旧实例不再有权触发
 *    （计划 §9 验收行"旧计划版本不再触发"）。
 */
export function reminderOccurrenceKey(input: {
  intentId: string
  planVersion: number
  dueAt: Timestamp
}): string {
  if (input.intentId.trim() === '') {
    throw new KernelError('validation_error', 'notification_intent_missing', '提醒实例缺少意图 id')
  }
  if (!Number.isSafeInteger(input.planVersion) || input.planVersion < 1) {
    throw new KernelError(
      'validation_error',
      'notification_plan_version_bad',
      `提醒的计划版本必须是 >= 1 的整数，收到 ${String(input.planVersion)}`
    )
  }
  if (!Number.isSafeInteger(input.dueAt) || input.dueAt <= 0) {
    throw new KernelError(
      'validation_error',
      'notification_due_at_bad',
      `提醒的预定时刻必须是正安全整数，收到 ${String(input.dueAt)}`
    )
  }
  return `qq-notify:reminder:${input.intentId}:${input.planVersion}:${input.dueAt}`
}

/**
 * 自主关心实例的稳定键：**owner + 许可版本 + 时间机会键**。
 *
 * ⚠️ 关心**没有**用户请求 → 它的键必须锚在"哪一次机会"上，而机会键由**程序**给出
 *    （如 `<日键>T<hour>` 表示某天某个小时的那次机会）⇒ 同一次机会重启后算出的键相同。
 * ⚠️ 许可版本进键：撤销许可后即使把模式改回 `on`，也是**新版本** ⇒ 不复活旧机会（`D13`）。
 */
export function careOccurrenceKey(input: {
  ownerRef: string
  permissionVersion: string
  /** 程序给出的**有界**机会键（调用方保证它不含正文） */
  opportunityKey: string
}): string {
  const parts: [string, string][] = [
    ['ownerRef', input.ownerRef],
    ['permissionVersion', input.permissionVersion],
    ['opportunityKey', input.opportunityKey],
  ]
  for (const [name, value] of parts) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new KernelError(
        'validation_error',
        'notification_care_key_part_missing',
        `自主关心实例键缺少 ${name}`
      )
    }
    if (value.length > 120) {
      throw new KernelError(
        'validation_error',
        'notification_care_key_part_too_long',
        `自主关心实例键的 ${name} 过长（${String(value.length)} > 120）`
      )
    }
  }
  return `qq-notify:care:${input.ownerRef}:${input.permissionVersion}:${input.opportunityKey}`
}

/** 某个角色 + 某类触发的实例键前缀（诊断与按类统计用；**不**参与唯一性） */
export function occurrenceKeyPrefix(kind: NotificationKind): string {
  return `qq-notify:${kind}:`
}

// ---------------------------------------------------------------------------
// 三、时间判据（`L-QQP-01` + 计划 §6）
// ---------------------------------------------------------------------------

/** 截断到秒（与 Croner 时区路径的有效瞬间口径**逐字相同**，见 `L-QQP-01`） */
export function floorToSecond(ms: number): number {
  return Math.floor(ms / 1000) * 1000
}

/**
 * **单次触发是否可排期**（`L-QQP-01` 的唯一判据）。
 *
 * ```text
 * 可排期 ⇔ floor(目标,秒) > floor(现在,秒)
 * ```
 *
 * ⚠️ 为什么必须自己判：Croner 在"同秒"时 `nextRun()` 返回 `null` 并**静默不排期**
 *    （没有定时器、没有异常、没有告警）。我们要的是**可预测**：
 *    不能排期 ⇒ 我们**自己**记一条具名 `expired`，而不是让它悄悄消失。
 * ⚠️ WP1 的负控读数就在这条判据上（同秒目标 ⇒ `nextRun()` 为 null 且一次都不响）。
 */
export function onceShotIsSchedulable(targetMs: number, nowMs: number): boolean {
  return floorToSecond(targetMs) > floorToSecond(nowMs)
}

/** 具名 IANA 时区（不是偏移量：偏移量在夏令时/历史变更下会漂） */
export interface ZonedClock {
  readonly timeZone: string
}

export interface ZonedParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
  /** 0=周日 … 6=周六 */
  weekday: number
}

const PARTS_FORMATTERS = new Map<string, Intl.DateTimeFormat>()

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let cached = PARTS_FORMATTERS.get(timeZone)
  if (cached === undefined) {
    cached = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    })
    PARTS_FORMATTERS.set(timeZone, cached)
  }
  return cached
}

const WEEKDAY_INDEX: Readonly<Record<string, number>> = Object.freeze({
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
})

/**
 * 某个瞬间在**指定时区**的墙上时刻。
 *
 * ⚠️ 时区非法 ⇒ **抛**（不静默回落到宿主机时区 —— 那会让"安静时段"在某台机器上失效）。
 */
export function zonedPartsOf(instant: Timestamp, timeZone: string): ZonedParts {
  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = partsFormatter(timeZone).formatToParts(new Date(instant))
  } catch (error) {
    throw new KernelError(
      'validation_error',
      'bad_timezone',
      `不是合法的 IANA 时区：${timeZone}（${error instanceof Error ? error.message : String(error)}）`
    )
  }
  const read = (type: string): number => {
    const found = parts.find((part) => part.type === type)
    return found === undefined ? Number.NaN : Number(found.value)
  }
  const weekdayName = parts.find((part) => part.type === 'weekday')?.value ?? ''
  const hour = read('hour')
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    // `hour12: false` 在某些运行时把午夜给成 24 ⇒ 归一到 0（croner 的 tz 解析里也这么干）
    hour: hour === 24 ? 0 : hour,
    minute: read('minute'),
    second: read('second'),
    weekday: WEEKDAY_INDEX[weekdayName] ?? Number.NaN,
  }
}

/**
 * 该瞬间在指定时区的**日键**（`YYYY-MM-DD`）。
 *
 * ⚠️ 计划 §6 逐字：**"跨日以指定时区计算"**。额度按这个键分组 ——
 *    于是"上海的今天"而不是"宿主机的今天"，也不要 UTC 的今天。
 */
export function dayKeyOf(instant: Timestamp, timeZone: string): string {
  const parts = zonedPartsOf(instant, timeZone)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${String(parts.year).padStart(4, '0')}-${pad(parts.month)}-${pad(parts.day)}`
}

/**
 * 某个瞬间所在**那一天**的窗口（指定时区的当地 00:00 → 次日 00:00）。
 *
 * ```text
 * [start, end) 半开区间 —— 与 `countQuotaUsage` 的 `>= start and < end` 逐字对齐。
 * ⚠️ 日界必须按**策略时区**算，不能按宿主机：`L-QQP` 的额度是"她的一天"里的条数。
 * ⚠️ 用 `timezoneOffsetMs` 求当地午夜，而不是 `Date.parse('YYYY-MM-DDT00:00:00+08:00')`
 *    —— 后者把时区写死在字面量里，改时区就得改代码。
 * ```
 */
export function zonedDayWindow(
  instant: Timestamp,
  timeZone: string
): { readonly start: Timestamp; readonly end: Timestamp; readonly dayKey: string } {
  const parts = zonedPartsOf(instant, timeZone)
  /* 当地墙上时刻的 00:00 —— 先当成 UTC 算出来，再减去当时的偏移 */
  const localMidnightAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, 0, 0, 0, 0)
  /*
   * ⚠️ 偏移**在这里就地算**，不从 `notification-intake.ts` 引 ——
   *    那一侧是从本文件 import 的（引回来就成了环）。
   *    算法与那一侧逐字相同：`Date.UTC(当地墙时) - 该瞬间`。
   */
  const offset =
    Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - instant
  const start = localMidnightAsUtc - offset
  return { start: start as Timestamp, end: (start + 86_400_000) as Timestamp, dayKey: dayKeyOf(instant, timeZone) }
}

/** 自主活动时段（计划 §6：`Asia/Shanghai` 09:00–22:00，**不**继承宿主机时区） */
export interface ActiveWindow {
  readonly timeZone: string
  /** 含该整点（0–23） */
  readonly startHour: number
  /** **不含**该整点（0–24）；`endHour <= startHour` ⇒ 视为跨午夜窗口 */
  readonly endHour: number
}

export const DEFAULT_ACTIVE_WINDOW: ActiveWindow = Object.freeze({
  timeZone: 'Asia/Shanghai',
  startHour: 9,
  endHour: 22,
})

export function isWithinActiveWindow(instant: Timestamp, window: ActiveWindow = DEFAULT_ACTIVE_WINDOW): boolean {
  const { hour } = zonedPartsOf(instant, window.timeZone)
  if (window.startHour === window.endHour) return false
  if (window.startHour < window.endHour) return hour >= window.startHour && hour < window.endHour
  /* 跨午夜窗口（例如 22:00–06:00） */
  return hour >= window.startHour || hour < window.endHour
}

/**
 * 下一个活动时段的**起点**（毫秒）。
 *
 * ⚠️ 它用"逐分钟试探 + 上限"实现，而**不是**做时区算术：时区规则（夏令时、历史变更）
 *    由 `Intl` 负责，我只负责找第一个落在窗口内的整点。
 *    有界（最多 48 小时）⇒ 不会因为窗口配置荒谬而无限循环。
 */
export function nextActiveWindowStart(instant: Timestamp, window: ActiveWindow = DEFAULT_ACTIVE_WINDOW): Timestamp {
  if (isWithinActiveWindow(instant, window)) return instant
  const parts = zonedPartsOf(instant, window.timeZone)
  /* 从"下一个整点"开始试探（一小时的粒度足够：窗口按整点定义） */
  const startOfNextHour = instant + (3600_000 - (parts.minute * 60_000 + parts.second * 1000 + (instant % 1000)))
  for (let step = 0; step < 48; step += 1) {
    const candidate = startOfNextHour + step * 3600_000
    if (isWithinActiveWindow(candidate, window)) return candidate
  }
  return startOfNextHour + 48 * 3600_000
}

// ---------------------------------------------------------------------------
// 四、额度与时效（计划 §6）
// ---------------------------------------------------------------------------

/** 计划 §6 的**待冻结建议值**（`ADR-110` `D14`）。它们随策略版本一起存进通知行。 */
export interface ProactivePolicy {
  readonly timeZone: string
  readonly activeWindow: ActiveWindow
  /** 机会检查的间隔（毫秒）—— 每 30 分钟一次**程序预检** */
  readonly opportunityIntervalMs: number
  /** 自主关心的"两路真实入站空闲"下限 */
  readonly idleMs: number
  /** 两次自主关心之间的冷却 */
  readonly careCooldownMs: number
  /** 每日自主关心上限 */
  readonly maxCarePerDay: number
  /** 全类主动消息每日上限 */
  readonly maxProactiveMessagesPerDay: number
  /** 单次提醒逾期多久之后判 `expired` */
  readonly reminderGraceMs: number
  /** 单次模型评估的期限 */
  readonly evaluationTimeoutMs: number
  /** 首版待办提醒上限 */
  readonly maxPendingReminders: number
  /**
   * ---------------------------------------------------------------------------
   * 皮套入口的**系统发起开口**（ADR-131 `D15` / `D17`；2026-10-11 设计冻结）
   * ---------------------------------------------------------------------------
   * ⚠️ 与上面 care 那几个的**区别**（不要混用）：
   *   · `idleMs`（2h）是 care 的"**两路真实入站空闲**"；本组的 `openingMinIdleMs`（3min）
   *     是"**外壳报来的页面空闲**"—— 量的是不同的东西
   *   · `evaluationTimeoutMs`（15s）是"**用户不在场**"档；`openingDeadlineMs`（8s）是
   *     "**用户在线**"档 —— 主动开口发生在用户眼前，他能直接感到卡
   */
  /** 外壳报来的 `idleMs` 至少这么长才受理（ADR-131 `D15` ①） */
  readonly openingMinIdleMs: number
  /** 两次主动开口之间的冷却（ADR-131 `D15` ②） */
  readonly openingCooldownMs: number
  /** 每日主动开口上限（ADR-131 `D15` ③；**并计入** `maxProactiveMessagesPerDay` 总闸） */
  readonly maxOpeningsPerDay: number
  /** 单次主动开口的模型调用期限（ADR-131 `D17`：与 role-tool 决策调用同一档，有实测支撑） */
  readonly openingDeadlineMs: number
}

export const DEFAULT_PROACTIVE_POLICY: ProactivePolicy = Object.freeze({
  timeZone: 'Asia/Shanghai',
  activeWindow: DEFAULT_ACTIVE_WINDOW,
  opportunityIntervalMs: 30 * 60_000,
  idleMs: 2 * 3600_000,
  careCooldownMs: 3 * 3600_000,
  maxCarePerDay: 2,
  maxProactiveMessagesPerDay: 10,
  reminderGraceMs: 30 * 60_000,
  evaluationTimeoutMs: 15_000,
  maxPendingReminders: 20,
  // ADR-131 `D15` / `D17`：**待冻结建议值**（批准时随策略版本一并定档）
  openingMinIdleMs: 3 * 60_000,
  openingCooldownMs: 30 * 60_000,
  maxOpeningsPerDay: 4,
  openingDeadlineMs: 8_000,
})

/**
 * 关心的**时间机会键**（程序给出、有界、不含正文）。
 *
 * 形如 `<日键>T<小时>`：同一天同一小时**最多一次**机会
 * ⇒ 重复 tick / 回调重入 / 同实例重启算出的键相同（计划 §9 验收行"同 occurrence 只产生一个外发尝试"）。
 */
export function careOpportunityKey(instant: Timestamp, timeZone: string): string {
  const parts = zonedPartsOf(instant, timeZone)
  return `${dayKeyOf(instant, timeZone)}T${String(parts.hour).padStart(2, '0')}`
}

/** 某个候选是否**已经过了时效**（用于"迟到处理"，计划 §6） */
export function reminderExpiryState(input: {
  dueAt: Timestamp
  now: Timestamp
  graceMs?: number
}): 'due' | 'grace' | 'expired' {
  const grace = input.graceMs ?? DEFAULT_PROACTIVE_POLICY.reminderGraceMs
  if (input.now < input.dueAt) return 'due'
  if (input.now - input.dueAt <= grace) return 'grace'
  return 'expired'
}

// ---------------------------------------------------------------------------
// 五、正文指纹（`D09`：正文不进账本/trace，只留指纹与长度）
// ---------------------------------------------------------------------------

/**
 * 正文指纹（**不是**正文）。
 *
 * ⚠️ 与 `memory_records.content_fingerprint` 同一条纪律：账本 / trace / 作业错误信息里
 *    只能出现这个指纹与长度，**不能**出现正文本身。
 * ⚠️ 这里用的是与仓库既有幂等键同款的 FNV-1a 64 位（无依赖、确定性）；
 *    它**不是**安全用途，只用于"这条候选是不是同一条"以及事后对账。
 */
export function notificationTextFingerprint(text: string): string {
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  const mask = 0xffffffffffffffffn
  for (let index = 0; index < text.length; index += 1) {
    hash ^= BigInt(text.charCodeAt(index))
    hash = (hash * prime) & mask
  }
  return `ntf:${hash.toString(16).padStart(16, '0')}`
}

/** 候选正文的有界长度（计划 §5："有界候选正文"） */
export const MAX_NOTIFICATION_TEXT_CODEPOINTS = 500

export interface NotificationCandidateDraft {
  readonly text: string
  readonly fingerprint: string
  readonly length: number
}

/**
 * 校验并打包一份候选正文（**唯一**的入口）。
 *
 * ⚠️ 空 / 超长 / 含控制字符 ⇒ **抛**（失败关闭）。理由：候选正文是要**发到真人手机上**的，
 *    "差不多能用"不是可接受的标准。
 */
export function buildNotificationCandidate(text: string): NotificationCandidateDraft {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new KernelError('validation_error', 'notification_candidate_empty', '候选正文不能为空')
  }
  const codepoints = [...text]
  if (codepoints.length > MAX_NOTIFICATION_TEXT_CODEPOINTS) {
    throw new KernelError(
      'validation_error',
      'notification_candidate_too_long',
      `候选正文超过 ${String(MAX_NOTIFICATION_TEXT_CODEPOINTS)} 码点（收到 ${String(codepoints.length)}）`
    )
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) {
    throw new KernelError(
      'validation_error',
      'notification_candidate_control_chars',
      '候选正文含控制字符（不许把不可见字符发到真人手机上）'
    )
  }
  return { text, fingerprint: notificationTextFingerprint(text), length: codepoints.length }
}

// ---------------------------------------------------------------------------
// 六、七槽归因的具名身份（`ADR-110` §2 / `D05a`）
// ---------------------------------------------------------------------------

/** 系统侧**具名**身份：它是"谁让这次动作发生"的可查答案（不是"未知"） */
export const PROACTIVE_SCHEDULER_PRINCIPAL_ID = 'qq-proactive-scheduler'

/** 两个后台处理器的**具名**（`D02` 的许可表与它们逐字对应） */
export const PROACTIVE_REMINDER_PROCESSOR = 'qq-proactive-reminder'
export const PROACTIVE_CARE_PROCESSOR = 'qq-proactive-care'

export function processorForKind(kind: NotificationKind): string {
  return kind === 'reminder' ? PROACTIVE_REMINDER_PROCESSOR : PROACTIVE_CARE_PROCESSOR
}

/** 诊断用一行（**不含正文**） */
export function describeNotificationIntent(intent: {
  id: string
  kind: NotificationKind
  status: NotificationIntentStatus
  scheduledAt: Timestamp
}): string {
  return `${intent.kind}:${intent.id} status=${intent.status} at=${new Date(intent.scheduledAt).toISOString()}`
}

/** 品牌化的意图 id 形态（与 `ids.ts` 的其它 id 同族） */
export function assertIntentIdShape(value: string): void {
  if (!/^qni:[0-9a-f-]{8,}$/.test(value)) {
    throw new KernelError(
      'validation_error',
      'notification_intent_id_shape',
      `意图 id 形状不合法：${value}（期望 qni:<uuid>）`
    )
  }
}

export function assertCharacterOwnedIntent(characterId: CharacterId, intentCharacterId: CharacterId): void {
  if (String(characterId) !== String(intentCharacterId)) {
    throw new KernelError(
      'validation_error',
      'notification_intent_character_mismatch',
      `通知意图属于 ${String(intentCharacterId)}，不是 ${String(characterId)}`
    )
  }
}
