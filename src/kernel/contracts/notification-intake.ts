/**
 * QQ 主动联系 —— **通知入口**的判据（WP3）。
 *
 * ============================================================================
 *  载体
 * ============================================================================
 * 计划 §4.1（两类触发的选择权限不同）· §6（参数与迟到处理）· §8 WP3（通知入口与用户控制）·
 * 设计 [`ADR-110`] `D03`（关心可沉默、提醒只决定措辞）· `D07`（排期与许可版本）· `D14`（参数）。
 *
 * ============================================================================
 *  这个模块**只**做两件事（纯函数、零 IO、零时钟）
 * ============================================================================
 * ```text
 * ① **提醒入口**：从本人原话里**确定地**读出一个时刻 —— 读不出来就澄清，**绝不猜**
 * ② **机会预检**：一次自主关心机会够不够格 —— 每条不合格都必须是**具名理由**
 * ```
 * ⚠️ 调用方把 `now` 传进来；本模块**不**读时钟、**不**读数据库、**不**读环境。
 *
 * ============================================================================
 *  三条硬纪律（都是计划逐字）
 * ============================================================================
 * ```text
 * ① "以后提醒""有空再说"这类**不确定表达只澄清**，不偷偷排期（计划 §4.1）
 * ② 提醒的时刻是**候选**，程序校验后才落盘；回复必须依据**实际落盘事实**说"已设置"
 * ③ 夜间普通提醒**顺延**到下个允许时刻；本人**明确指定**夜间时间才对该条例外
 * ```
 * ⚠️ 本模块**不**碰 `Goal`/`Commitment` 的 `dueAt`：那属于目标域，而"目标域生产侧没有任何一处写
 *    `dueAt`"是 M10 的**结构性判据**（G36）。提醒是**独立**结构（`ADR-110` `D03` 逐字）。
 */

import { KernelError, type Timestamp } from './ids.ts'
import {
  DEFAULT_PROACTIVE_POLICY,
  careOpportunityKey,
  isWithinActiveWindow,
  nextActiveWindowStart,
  reminderExpiryState,
  zonedPartsOf,
  type ActiveWindow,
  type ProactivePolicy,
} from './notification.ts'

// ---------------------------------------------------------------------------
// 一、提醒入口（"十分钟后提醒我喝水" → 一个确定时刻，或一次澄清）
// ---------------------------------------------------------------------------

/**
 * 入口的四种结局（**闭集**）。
 *
 * ⚠️ `clarify` 与 `refused` 是**两件不同的事**：
 * ```text
 * clarify —— 本人说的话里有"想被提醒"的意图，但**时刻读不准** ⇒ 问一句（不排期）
 * refused —— 读准了，但**规则不允许**（例如已经过去、或超出允许的边界）⇒ 如实说做不到
 * ```
 * 把两者混成一个"失败"会让"她没听懂"与"她拒绝"在读数和措辞上分不开。
 */
export type ReminderIntakeOutcome =
  | { readonly kind: 'none' }
  | { readonly kind: 'clarify'; readonly code: string; readonly question: string }
  | { readonly kind: 'refused'; readonly code: string; readonly reason: string }
  | {
      readonly kind: 'scheduled'
      readonly dueAt: Timestamp
      readonly timezone: string
      /** 本人**明确指定**了夜间时刻 ⇒ 这一条例外（`D14` 的夜间规则） */
      readonly explicitNight: boolean
      /** 排期是**怎么来的**（可审计；进实例行，不进正文） */
      readonly basis: string
      /** 原话里被用来定时的那一段（供"是哪一句话"的对账） */
      readonly matched: string
    }

/** 夜间窗口之外的普通提醒**顺延**；明确指定则例外（计划 §6 逐字的机器形态） */
export const DEFAULT_ORDINARY_START_HOUR = 9

/** "提醒"意图的词形（闭集；命中任一即认为本人在要求被提醒） */
const REMINDER_VERBS: readonly string[] = ['提醒', '叫我', '记得告诉', '别忘']

/** 明确"不确定"的词形 —— 命中就**只澄清**（绝不排期） */
const VAGUE_TIME_MARKERS: readonly string[] = [
  '以后', '有空', '晚点', '回头', '待会', '过会儿', '看情况', '随便', '找时间', '改天',
]

const CN_DIGITS: Readonly<Record<string, number>> = Object.freeze({
  零: 0, 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
})

/** 读一个小的中文/阿拉伯数字（0–99；只支持"十""二十""二十三"这类常见写法） */
function readSmallNumber(raw: string): number | undefined {
  const text = raw.trim()
  if (text === '') return undefined
  if (/^\d{1,2}$/.test(text)) return Number(text)
  if (text === '半') return undefined
  if (text.length === 1) return CN_DIGITS[text]
  if (text.startsWith('十')) {
    const rest = readSmallNumber(text.slice(1))
    return rest === undefined ? 10 : 10 + rest
  }
  const at = text.indexOf('十')
  if (at > 0) {
    const tens = CN_DIGITS[text.slice(0, at)]
    if (tens === undefined) return undefined
    const rest = text.slice(at + 1)
    if (rest === '') return tens * 10
    const ones = CN_DIGITS[rest]
    return ones === undefined ? undefined : tens * 10 + ones
  }
  return undefined
}

const NUM_PATTERN = '[0-9]{1,2}|[零一两二三四五六七八九十]{1,3}'

/** 一天里的时段词（决定"早上 8 点"是 08:00 还是 20:00） */
interface DayPartHint {
  readonly words: readonly string[]
  readonly hourBase: number // -1 = 由小时数本身决定
}

const DAY_PART_HINTS: readonly DayPartHint[] = [
  { words: ['凌晨'], hourBase: 0 },
  { words: ['早上', '早晨', '一早', '上午'], hourBase: 0 },
  { words: ['中午'], hourBase: 12 },
  { words: ['下午'], hourBase: 12 },
  { words: ['傍晚'], hourBase: 17 },
  { words: ['晚上', '夜里', '今晚', '明晚'], hourBase: 18 },
]

interface ParsedClock {
  readonly hour: number
  readonly minute: number
  readonly matched: string
}

/** 读"X点(半|Y分|Y)" —— 返回 0–23 的时钟 */
function readClockAt(text: string): ParsedClock | undefined {
  const re = new RegExp(`(${NUM_PATTERN})\\s*[点:：]\\s*(?:(半)|(${NUM_PATTERN})\\s*分?)?`)
  const found = re.exec(text)
  if (found === null) return undefined
  const hour = readSmallNumber(found[1] ?? '')
  if (hour === undefined || hour > 24) return undefined
  let minute = 0
  if (found[2] === '半') minute = 30
  else if (found[3] !== undefined) {
    const parsed = readSmallNumber(found[3])
    if (parsed === undefined || parsed > 59) return undefined
    minute = parsed
  }
  return { hour: hour % 24, minute, matched: found[0].trim() }
}

/** "半个小时后" / "半小时后" / "N个半小时后" */
function readRelative(text: string): { ms: number; matched: string } | undefined {
  const half = /(半\s*个?\s*小时\s*(?:之)?后)/.exec(text)
  if (half !== null) return { ms: 30 * 60_000, matched: half[1]!.trim() }

  /*
   * ⚠️ 2026-10-07 扩了**单位词**（实测踩到）：本人写的是「**6min后**手机将会充好电…」，
   *    而这里原来只认中文单位（`小时|分钟|分|秒|天`）⇒ `reminder_time_unreadable`
   *    ⇒ 判据"读不出就澄清"照旧生效（她如实说"我没记"），但**他要的提醒永远建不起来**。
   * ⇒ 补上英文/缩写单位（`min`/`mins`/`minute(s)`/`h`/`hr(s)`/`hour(s)`），
   *    **大小写不敏感**（他对了下大小写都该认）。
   * ⚠️ 只扩**单位**，不碰「N 的读法」与「后」的方向 —— 那两处本来就对。
   */
  const re = new RegExp(
    `(${NUM_PATTERN})\\s*(个)?\\s*(小时|分钟|分|秒|天|min(?:ute)?s?|h(?:ou)?rs?)\\s*(?:之)?后`,
    'i'
  )
  const found = re.exec(text)
  if (found === null) return undefined
  const value = readSmallNumber(found[1] ?? '')
  if (value === undefined || value <= 0) return undefined
  const unit = (found[3] ?? '').toLowerCase()
  const perUnit: Record<string, number> = {
    小时: 3600_000, 分钟: 60_000, 分: 60_000, 秒: 1000, 天: 86_400_000,
    min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000,
    h: 3600_000, hr: 3600_000, hrs: 3600_000, hour: 3600_000, hours: 3600_000,
  }
  const size = perUnit[unit]
  if (size === undefined) return undefined
  const ms = value * size
  /* 有界：一次提醒不许排到 30 天以外（那多半不是"提醒"，而是日程管理） */
  if (ms > 30 * 86_400_000) return undefined
  return { ms, matched: found[0].trim() }
}

/** 构造"指定时区里的某一天某个钟点"对应的 UTC 瞬间 */
function instantOfZonedWallClock(input: {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  timeZone: string
}): Timestamp | undefined {
  /* 从"该日的 UTC 零点 + 时区偏移"出发，再用偏移修正一次（与 tz 数据一致的确定性做法） */
  const naive = Date.UTC(input.year, input.month - 1, input.day, input.hour, input.minute, 0, 0)
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const offset = timezoneOffsetMs(naive, input.timeZone)
    const candidate = naive - offset
    if (timezoneOffsetMs(candidate, input.timeZone) === offset) return candidate
  }
  return naive - timezoneOffsetMs(naive, input.timeZone)
}

/** 某瞬间在该时区的偏移（毫秒；正 = 本地早于 UTC） */
export function timezoneOffsetMs(instant: Timestamp, timeZone: string): number {
  const parts = zonedPartsOf(instant, timeZone)
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
  return asUtc - Math.floor(instant / 1000) * 1000
}

export interface ReminderIntakeInput {
  readonly text: string
  readonly now: Timestamp
  readonly policy?: ProactivePolicy
  /** 程序判断"这句话是不是冲着提醒来的"之外，还可以由调用方直接指定（测试与显式命令用） */
  readonly forceReminderIntent?: boolean
}

/**
 * 从本人原话里读出一次**单次提醒**。
 *
 * ```text
 * 命中"不确定"词形            ⇒ clarify（**绝不**排期）
 * 没有提醒意图                ⇒ none（这不是一条提醒请求）
 * 有意图但没有可读的时刻      ⇒ clarify
 * 时刻读得出但已过去/太近     ⇒ refused（`due_at_not_future`）
 * 读得出                      ⇒ scheduled（夜间按规则顺延或例外）
 * ```
 * ⚠️ **不猜**：读不出就澄清。这条是"未创建不说已设"的上游保证 ——
 *    连排期都没成立，就不可能出现"她说已设置"。
 */
export function readReminderRequest(input: ReminderIntakeInput): ReminderIntakeOutcome {
  const text = String(input.text ?? '').trim()
  if (text === '') return { kind: 'none' }
  const policy = input.policy ?? DEFAULT_PROACTIVE_POLICY
  const timeZone = policy.timeZone

  const hasIntent =
    input.forceReminderIntent === true || REMINDER_VERBS.some((verb) => text.includes(verb))
  if (!hasIntent) return { kind: 'none' }

  /* ① 不确定表达 ⇒ 只澄清 */
  const vague = VAGUE_TIME_MARKERS.find((marker) => text.includes(marker))
  if (vague !== undefined) {
    return {
      kind: 'clarify',
      code: 'reminder_time_unspecified',
      question: '你想让我什么时候提醒你？（说一个具体时间，比如"十分钟后"或"今晚八点"）',
    }
  }

  const relative = readRelative(text)
  let dueAt: Timestamp | undefined
  let basis = ''
  let matched = ''
  let explicitNight = false

  if (relative !== undefined) {
    dueAt = input.now + relative.ms
    basis = `relative:${relative.matched}`
    matched = relative.matched
    explicitNight = false
  } else {
    const clock = readClockAt(text)
    if (clock !== undefined) {
      const nowParts = zonedPartsOf(input.now, timeZone)
      const hint = DAY_PART_HINTS.find((entry) => entry.words.some((word) => text.includes(word)))
      let hour = clock.hour
      if (hint !== undefined) {
        /* "下午3点" ⇒ 15；"晚上8点" ⇒ 20；"早上8点" ⇒ 8 */
        if (hint.hourBase === 12 && hour < 12) hour += 12
        else if (hint.hourBase === 18 && hour < 12) hour += 12
        else if (hint.hourBase === 0 && hour === 12) hour = 0
        else if (hint.hourBase === 17 && hour < 12) hour += 12
      }
      const explicitTomorrow = text.includes('明天') || text.includes('明晚') || text.includes('次日')
      const explicitToday = text.includes('今天') || text.includes('今晚') || text.includes('今早')
      let dayOffset = explicitTomorrow ? 1 : 0
      let candidate = instantOfZonedWallClock({
        year: nowParts.year, month: nowParts.month, day: nowParts.day + dayOffset,
        hour, minute: clock.minute, timeZone,
      })
      if (candidate === undefined) return { kind: 'none' }
      /* 未指明是哪一天、且今天这个点已经过了 ⇒ 顺延到明天（这是常识，不是猜测） */
      if (!explicitTomorrow && !explicitToday && candidate <= input.now) {
        dayOffset += 1
        candidate = instantOfZonedWallClock({
          year: nowParts.year, month: nowParts.month, day: nowParts.day + dayOffset,
          hour, minute: clock.minute, timeZone,
        })
        if (candidate === undefined) return { kind: 'none' }
      }
      dueAt = candidate
      basis = `clock:${String(hour).padStart(2, '0')}:${String(clock.minute).padStart(2, '0')}` +
        (explicitTomorrow ? ':tomorrow' : explicitToday ? ':today' : ':next_occurrence') +
        (hint === undefined ? '' : `:${hint.words[0]}`)
      matched = clock.matched
      /* "明确指定夜间时间" = 本人**说出了**一个落在夜间窗口之外的钟点 */
      explicitNight = !isWithinActiveWindow(candidate, policy.activeWindow)
    }
  }

  if (dueAt === undefined) {
    return {
      kind: 'clarify',
      code: 'reminder_time_unreadable',
      question: '我没读准时间 —— 你想让我几点提醒你？',
    }
  }

  /*
   * ② 时刻必须**严格晚于现在**（`L-QQP-01` 的同一条口径，截断到秒）。
   *    读出来是过去 ⇒ 如实拒绝，**不**"顺手挪到明天"（那是替本人改主意）。
   */
  const floorToSecond = (ms: number): number => Math.floor(ms / 1000) * 1000
  if (floorToSecond(dueAt) <= floorToSecond(input.now)) {
    return { kind: 'refused', code: 'reminder_due_at_not_future', reason: '那个时间已经过去了' }
  }

  /*
   * ③ 活动时段**只约束自主关心**（2026-10-07 用户裁定；本条**改的是语义**，见 ADR-113）。
   *
   * ============================================================================
   *  裁定原话
   * ============================================================================
   * ```text
   * 「没有来源的自主关心别在半夜自己冒出来，但是既然我提到了 or 有明确要求，
   *   就不用管作息表了」
   * ```
   * ⚠️ **旧语义**（ADR-110 `D14`）：普通提醒若落在时段外 ⇒ 顺延到下一个活动时段起点；
   *    只有"本人**说出了**一个时段外的钟点"才走 `explicit_night_exception`。
   * ⚠️ **为什么旧语义在这里是空的**：能走到这一步的提醒，**本来就要求**原话里有提醒动词
   *    （`REMINDER_VERBS`）⇒ **每一条提醒都是"本人明确要求"**
   *    ⇒ 旧的那条顺延**从来没有"拦下过一条他没明确要求的提醒"**，它拦的全是他要的。
   * ⇒ 新语义：**不因活动时段顺延**（他说几点就几点）；
   *    时段只留给**自主关心**那一侧（`proactive-scheduler` 的 `fireCare()` 里那道闸，
   *    本文件 409 行的预检也仍然管着关心）—— 那才是"没有来源、不该半夜冒出来"的那一类。
   * ⚠️ 只把"这一段落在时段外"**如实记进 `basis`**（可审计）：不静默、不假装它在时段内。
   */
  if (!isWithinActiveWindow(dueAt, policy.activeWindow)) {
    basis = `${basis}>outside_window_allowed`
  }

  return { kind: 'scheduled', dueAt, timezone: timeZone, explicitNight, basis, matched }
}

/** 提醒内容的去重键（"同一件事不许排两次"）：原来源 + 计划时刻 */
export function reminderDedupeKey(input: { sourceEventId: string; dueAt: Timestamp }): string {
  if (String(input.sourceEventId).trim() === '') {
    throw new KernelError('validation_error', 'reminder_without_source', '提醒必须有原来源事件')
  }
  return `qq-notify:reminder:${input.sourceEventId}:${input.dueAt}`
}

/** 关心意图的去重键：owner + 许可版本（同一条许可只登记一次） */
export function careDedupeKey(input: { ownerRef: string; permissionVersion: string }): string {
  return `qq-notify:care:${input.ownerRef}:${input.permissionVersion}`
}

// ---------------------------------------------------------------------------
// 二、自主关心的机会预检（每条不合格都必须**具名**）
// ---------------------------------------------------------------------------

export type ProactiveMode = 'off' | 'shadow' | 'on'

/** 预检输入：全部是**程序读数**（没有一项来自模型或载荷） */
export interface CarePrecheckInput {
  readonly mode: ProactiveMode
  readonly paused: boolean
  /** 装配前置：入口作用域会话必须开着（`ADR-110` `D14`） */
  readonly entryScopedConversations: boolean
  readonly now: Timestamp
  readonly policy?: ProactivePolicy
  /** 两路真实入站里**最近**的一次（读不到 = 从未有过入站） */
  readonly lastInboundAt?: Timestamp
  /** 上一次关心实际占额的时刻（含结果不明与明确失败 —— 计划 §6：两者都占额） */
  readonly lastCareAt?: Timestamp
  /** 上一次关心之后**有没有**新的真实入站（没有 ⇒ 暂停继续关心） */
  readonly newInboundSinceLastCare: boolean
  /** 指定时区日界内已占用的条数 */
  readonly careUsedToday: number
  readonly allUsedToday: number
  /** 是否已经有一个候选在途（计划 §4.4：最多一个候选在途） */
  readonly candidateInFlight: boolean
  readonly permissionVersion: string
}

export type CarePrecheckResult =
  | {
      readonly eligible: true
      readonly opportunityKey: string
      readonly permissionVersion: string
      /** `shadow` 档：完整产生选择与审计，但**不**真的发（`ADR-110` `D14`） */
      readonly dryRun: boolean
      readonly idleMs: number
    }
  | { readonly eligible: false; readonly code: string; readonly detail: string; readonly deferredUntil?: Timestamp }

/**
 * 一次自主关心机会够不够格。
 *
 * ⚠️ **顺序就是判据的一部分**（先问"该不该跑"，再问"是不是时候"）：
 * ```text
 * off → paused → 入口作用域 → 在途候选 → 活动时段 → 空闲 → 冷却 → 未被回应 → 日额度
 * ```
 * ⚠️ 每条不合格都给**具名码**：门里对**每一条**都有负控（"达限后零发送"之类的判据
 *    不能只靠一句"should not send"）。
 */
export function precheckCareOpportunity(input: CarePrecheckInput): CarePrecheckResult {
  const policy = input.policy ?? DEFAULT_PROACTIVE_POLICY
  const timeZone = policy.timeZone
  const reject = (
    code: string,
    detail: string,
    deferredUntil?: Timestamp
  ): CarePrecheckResult => ({
    eligible: false,
    code,
    detail,
    ...(deferredUntil === undefined ? {} : { deferredUntil }),
  })

  if (input.mode === 'off') return reject('mode_off', '主动模式未开启（off）')
  if (input.paused) return reject('paused', '用户已暂停主动联系')
  if (!input.entryScopedConversations) {
    return reject(
      'entry_scope_required',
      '入口作用域会话未开启：QQ 近期窗口可能混入别的入口，拒绝跑主动机会'
    )
  }
  /* 计划 §4.4：最多一个候选在途 —— 已经有一个在跑就不再开新的 */
  if (input.candidateInFlight) return reject('candidate_in_flight', '已经有一个候选在途')

  if (!isWithinActiveWindow(input.now, policy.activeWindow)) {
    return reject(
      'outside_active_window',
      '不在自主活动时段内',
      nextActiveWindowStart(input.now, policy.activeWindow)
    )
  }

  const lastActivity = input.lastInboundAt
  const idleMs = lastActivity === undefined ? Number.POSITIVE_INFINITY : input.now - lastActivity
  if (idleMs < policy.idleMs) {
    return reject(
      'not_idle_enough',
      `两路真实入站还不够空闲（${String(Math.round(idleMs / 60_000))} < ${String(policy.idleMs / 60_000)} 分钟）`,
      (lastActivity ?? input.now) + policy.idleMs
    )
  }

  if (input.lastCareAt !== undefined && input.now - input.lastCareAt < policy.careCooldownMs) {
    return reject(
      'cooldown',
      `距上次关心不足冷却时间（${String(Math.round((input.now - input.lastCareAt) / 60_000))} < ${String(policy.careCooldownMs / 60_000)} 分钟）`,
      input.lastCareAt + policy.careCooldownMs
    )
  }

  /* 计划 §6：「有 1 条未得到新入站回应时暂停继续关心」 */
  if (input.lastCareAt !== undefined && !input.newInboundSinceLastCare) {
    return reject('previous_care_unanswered', '上一次关心之后没有新的真实入站，暂停继续关心')
  }

  if (input.careUsedToday >= policy.maxCarePerDay) {
    return reject(
      'care_quota_reached',
      `今日关心已达上限（${String(input.careUsedToday)}/${String(policy.maxCarePerDay)}）`
    )
  }
  if (input.allUsedToday >= policy.maxProactiveMessagesPerDay) {
    return reject(
      'daily_quota_reached',
      `今日主动消息总数已达上限（${String(input.allUsedToday)}/${String(policy.maxProactiveMessagesPerDay)}）`
    )
  }

  return {
    eligible: true,
    opportunityKey: careOpportunityKey(input.now, timeZone),
    permissionVersion: input.permissionVersion,
    dryRun: input.mode === 'shadow',
    idleMs,
  }
}

// ---------------------------------------------------------------------------
// 三、提醒的到点判定（与 `notification.ts` 的迟到处理同一口径）
// ---------------------------------------------------------------------------

export type ReminderDueAction =
  | { readonly action: 'deliver'; readonly grace: 'on_time' | 'within_grace' }
  | { readonly action: 'expire'; readonly code: 'reminder_expired' | 'reminder_not_due_yet' }

/**
 * 到点的提醒该发还是该判过期。
 *
 * ⚠️ 它把 `notification.ts` 的 `reminderExpiryState` 与"H 小时后别补发"合在一处：
 * ```text
 * due（还没到）        ⇒ **不发**（调用方不该在这时调它）；这里按"未到点"拒绝
 * grace（逾期 ≤ 30min）⇒ 发（连接恢复后重新预检，时效允许才处理）
 * expired（> 30min）   ⇒ 判 `expired`，**不伪报已提醒**（计划 §6）
 * ```
 */
export function decideReminderDue(input: {
  dueAt: Timestamp
  now: Timestamp
  graceMs?: number
}): ReminderDueAction {
  const state = reminderExpiryState(input)
  if (state === 'expired') return { action: 'expire', code: 'reminder_expired' }
  if (state === 'due') {
    /* 未到点：调用方不该在这里问；如实按"还没到"处理，而不是提前发 */
    return { action: 'expire', code: 'reminder_not_due_yet' }
  }
  return { action: 'deliver', grace: 'within_grace' }
}

/** 诊断用一行（**不含正文**） */
export function describePrecheck(result: CarePrecheckResult): string {
  return result.eligible
    ? `eligible key=${result.opportunityKey} dryRun=${String(result.dryRun)}`
    : `rejected ${result.code}`
}

/** 活动时段在**指定时区**的文本形态（措辞与诊断用） */
export function describeActiveWindow(window: ActiveWindow = DEFAULT_PROACTIVE_POLICY_ACTIVE_WINDOW): string {
  return `${window.timeZone} ${String(window.startHour).padStart(2, '0')}:00–${String(window.endHour).padStart(2, '0')}:00`
}

const DEFAULT_PROACTIVE_POLICY_ACTIVE_WINDOW: ActiveWindow = DEFAULT_PROACTIVE_POLICY.activeWindow
