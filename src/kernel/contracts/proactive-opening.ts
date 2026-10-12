/**
 * ADR-131 · `D15` / `D16` —— **皮套入口的系统发起开口**：机会预检（纯函数）。
 *
 * ============================================================================
 *  它是什么，以及它**不是**什么
 * ============================================================================
 * ```text
 * 是   ：一次"她现在该不该主动开口"的**全部闸**，在**调模型之前**跑完
 * 不是 ：生成内容（`D04`）· 仲裁话权（那在 `character-output.ts`）· 投递（`D18`）
 * ```
 * ⚠️ 本模块是**纯函数**：不读时间、不读环境、不写库、不调模型。
 *    所有读数由调用方按**真实读数**填进来 —— 本模块**不猜**。
 *    这正是"判据不能只活在装配层"那条纪律（先例 `precheckCareOpportunity`、`fallback-channel.ts`）。
 *
 * ============================================================================
 *  判据顺序（**顺序就是判据的一部分**，与 `precheckCareOpportunity` 同一条纪律）
 * ============================================================================
 * ```text
 * ① 形状    入口是不是 avatar · idleMs 是不是合法的非负数
 * ② 幂等    这个机会键是不是已经处理过（ADR-131 `D15`）
 * ③ 该不该跑 暂停 → 入口作用域 → 在途候选 → 活动时段
 * ④ 是不是时候 空闲下限 → 冷却 → 本通道日额度 → **共享总闸**
 * ⑤ 能不能说 依据集非空 → 她没在说 → 用户没在说 → **有活客户端**
 * ```
 * ⇒ ①②③④ 全部不通过时**一次模型调用都不花**；⑤ 里最后一条（没有活客户端）也在这里拦，
 *    否则会"生成完才发现没人听"（白花一次调用）。
 *
 * ============================================================================
 *  ⚠️ 与 ADR-131 §7-U2 的**计数修正**（必须读）
 * ============================================================================
 * U2 写的是"复用 ADR-111 的十条 + 本通道四条 = **十四条**"。落地时逐条核对后发现：
 * ```text
 * · care 那十条里**只有八条**适用于本通道（`mode_off` 与 `previous_care_unanswered` 不适用，理由见下）
 * · 加上本通道四条（U2）
 * · 再加 ADR 在别处已经要求过、但 U2 没计入的**形状两条**（`D01` 的入口/报文形状）
 *   与**幂等一条**（`U1` / 负控 10）
 * ⇒ 实际是 **15 条**（见 {@link OPENING_REFUSAL_CODES}）
 * ```
 * ⇒ 这是**计数修正**，**不是新增裁定**：形状与幂等在 `D01` / `U1` / 负控 10 里已分别被要求过。
 *
 * **两条 care 的码为什么不适用的逐条理由**（不能只说"不适用"）：
 * ```text
 * `mode_off`                  本通道**刻意没有自己的生产开关**（ADR-131 §9 批准记录 ②：
 *                             "不动 .env（本 ADR 不含任何生产开关）"）。它的"关"是**未接线** ——
 *                             没有报文就没有机会，构造上不会跑（先例 ADR-111 `S07` 的
 *                             "未接线 ⇒ 不花模型调用且具名"）。
 * `previous_care_unanswered`  care 的对象是**不在场**的用户，"上一次没被回应"才有意义；
 *                             本通道的对象是**在场且页面连着**的用户，那个语义不存在
 *                             （他就在那儿，不存在"没被回应"）。
 * ```
 */

import { type Timestamp } from './ids.ts'
import {
  DEFAULT_PROACTIVE_POLICY,
  type ProactivePolicy,
  dayKeyOf,
  isWithinActiveWindow,
  nextActiveWindowStart,
  zonedPartsOf,
} from './notification.ts'

/** 本通道绑定的入口（ADR-131 `D01`：开口只发生在皮套） */
export const OPENING_ENTRY = 'avatar' as const

/** 本通道的报文体裁（ADR-131 `D18`） */
export const OPENING_PACKET_KIND = 'PROACTIVE_OPPORTUNITY' as const
export const OPENING_RESULT_KIND = 'OPPORTUNITY_RESULT' as const

/**
 * **15 条具名拒绝**（顺序 = {@link precheckOpeningOpportunity} 的判据顺序）。
 *
 * ⚠️ 闭集：**每条都必须与其它条互不相同**（{@link assertOpeningRefusalCodesWellFormed} 守着）；
 *    门里对**每一条**都有负控 —— "达限后零模型调用"这类判据**不能**只靠一句
 *    "should not call"（先例 `precheckCareOpportunity` 的注释）。
 */
export type OpeningRefusalCode =
  /* ① 形状（ADR-131 `D01` / `D18`） */
  | 'opening_wrong_entry'
  | 'opening_invalid_idle'
  /* ② 幂等（ADR-131 `D15` / 负控 10） */
  | 'opening_opportunity_already_handled'
  /* ③ 该不该跑（复用 care 的闸） */
  | 'paused'
  | 'entry_scope_required'
  | 'candidate_in_flight'
  | 'outside_active_window'
  /* ④ 是不是时候（复用 care 的**形状**，但用本通道自己的策略值） */
  | 'not_idle_enough'
  | 'cooldown'
  | 'opening_quota_reached'
  | 'daily_quota_reached'
  /* ⑤ 能不能说（ADR-131 `D16` 的四条） */
  | 'opening_without_evidence'
  | 'opening_she_is_speaking'
  | 'opening_user_is_speaking'
  | 'opening_no_live_client'

export const OPENING_REFUSAL_CODES: readonly OpeningRefusalCode[] = Object.freeze([
  'opening_wrong_entry',
  'opening_invalid_idle',
  'opening_opportunity_already_handled',
  'paused',
  'entry_scope_required',
  'candidate_in_flight',
  'outside_active_window',
  'not_idle_enough',
  'cooldown',
  'opening_quota_reached',
  'daily_quota_reached',
  'opening_without_evidence',
  'opening_she_is_speaking',
  'opening_user_is_speaking',
  'opening_no_live_client',
])

/**
 * 机会键：`<日键>T<小时>`（与 `careOpportunityKey` **同形、不同用途**）。
 *
 * ⇒ 同一小时**最多一次**机会；重复报文 / 回调重入 / 同实例重启算出的键相同
 *   ⇒ 幂等（ADR-131 `D15` 的双键之一；负控 10）。
 */
export function openingOpportunityKey(instant: Timestamp, timeZone: string): string {
  const parts = zonedPartsOf(instant, timeZone)
  return `${dayKeyOf(instant, timeZone)}T${String(parts.hour).padStart(2, '0')}`
}

export interface OpeningPrecheckInput {
  /** 报文里的入口（**必须**是 {@link OPENING_ENTRY}） */
  readonly entry: string
  /** 报文里的空闲时长（**外壳自报 ⇒ 不作为唯一依据**，见下） */
  readonly idleMs: number
  readonly now: Timestamp
  readonly policy?: ProactivePolicy
  /** 用户暂停主动联系（与 care 共用同一份暂停状态） */
  readonly paused: boolean
  /** 入口维度会话隔离（ADR-110 `D14` 的前置；主动功能要求它开着） */
  readonly entryScopedConversations: boolean
  /** 已经有一个候选在途（计划 §4.4：最多一个） */
  readonly candidateInFlight: boolean
  /** 本次机会的依据集大小（**0 ⇒ 拒，且不花模型调用**：ADR-111 `S06`） */
  readonly evidenceCount: number
  /** 她此刻**正在说**（真实读数，由调用方填；本模块不猜） */
  readonly sheIsSpeaking: boolean
  /** 用户此刻**正在说**（同上） */
  readonly userIsSpeaking: boolean
  /** 页面**还连着**（有活客户端；没有就没人听，白花一次调用） */
  readonly hasLiveClient: boolean
  /** 上一次主动开口实际占额的时刻（含结果不明与明确失败 —— 都占额） */
  readonly lastOpeningAt?: Timestamp
  /** 指定时区日界内已开口的条数 */
  readonly openingsUsedToday: number
  /** 指定时区日界内**全类主动消息**已占用的条数（含 care 与提醒） */
  readonly allUsedToday: number
  /** 已经处理过的机会键（幂等；调用方给，本模块不查库） */
  readonly handledOpportunityKeys?: readonly string[]
}

export type OpeningPrecheckResult =
  | {
      readonly eligible: true
      readonly opportunityKey: string
      /** ★ 实际生效的空闲读数（**来自外壳自报**，不是本模块推算的） */
      readonly idleMs: number
      /** 模型调用的期限（ADR-131 `D17`；由策略给，不散成模块常量） */
      readonly deadlineMs: number
    }
  | {
      readonly eligible: false
      readonly code: OpeningRefusalCode
      readonly detail: string
      /** 只在"时候未到"这类可延后的拒绝上出现 */
      readonly deferredUntil?: Timestamp
    }

/**
 * 一次主动开口机会够不够格。
 *
 * ⚠️ **本函数保证：任何 `eligible: false` 的路径都不花模型调用。**
 *    调用方**不得**在 `eligible: false` 时再去问模型 —— 那是本模块存在的全部意义。
 */
export function precheckOpeningOpportunity(input: OpeningPrecheckInput): OpeningPrecheckResult {
  /* 与 `precheckCareOpportunity` 同一条口径：缺策略就用缺省（纯函数；**不读环境**） */
  const policy = input.policy ?? DEFAULT_PROACTIVE_POLICY
  const timeZone = policy.timeZone
  const reject = (
    code: OpeningRefusalCode,
    detail: string,
    deferredUntil?: Timestamp
  ): OpeningPrecheckResult => ({
    eligible: false,
    code,
    detail,
    ...(deferredUntil === undefined ? {} : { deferredUntil }),
  })

  /* ---------------- ① 形状 ---------------- */
  if (input.entry !== OPENING_ENTRY) {
    return reject('opening_wrong_entry', `入口必须是 ${OPENING_ENTRY}，收到 ${input.entry}`)
  }
  if (!Number.isFinite(input.idleMs) || input.idleMs < 0) {
    return reject('opening_invalid_idle', `idleMs 必须是非负有限数，收到 ${String(input.idleMs)}`)
  }

  /* ---------------- ② 幂等 ---------------- */
  const opportunityKey = openingOpportunityKey(input.now, timeZone)
  if ((input.handledOpportunityKeys ?? []).includes(opportunityKey)) {
    return reject(
      'opening_opportunity_already_handled',
      `机会键 ${opportunityKey} 已经处理过（同一小时最多一次）`
    )
  }

  /* ---------------- ③ 该不该跑 ---------------- */
  if (input.paused) return reject('paused', '用户已暂停主动联系')
  if (!input.entryScopedConversations) {
    return reject(
      'entry_scope_required',
      '入口作用域会话未开启：皮套近期窗口可能混入别的入口，拒绝跑主动机会'
    )
  }
  if (input.candidateInFlight) return reject('candidate_in_flight', '已经有一个候选在途')

  /*
   * ★ 活动时段**约束本通道**（ADR-131 `D11` 列了"时段"）。
   *
   * 这不是把 ADR-113 读反了：ADR-113 的**理由**逐字是
   * 「活动时段**只**约束**自主关心** —— 也就是"**没有来源、不该半夜自己冒出来**"的那一类」。
   * ⇒ 判据是"**系统自己冒出来的**" vs "**本人明确要求的**"。
   *   开口是前者（用户没要求，她自己开口）⇒ **受约束**；提醒是后者 ⇒ 不受约束。
   */
  if (!isWithinActiveWindow(input.now, policy.activeWindow)) {
    return reject(
      'outside_active_window',
      '不在主动活动时段内（系统自发的一类不该在半夜自己冒出来）',
      nextActiveWindowStart(input.now, policy.activeWindow)
    )
  }

  /* ---------------- ④ 是不是时候 ---------------- */
  /*
   * ⚠️ 这里量的是**外壳自报的 `idleMs`**，与 care 的 `idleMs`（**两路真实入站**的空闲）
   *    是**不同的东西**。ADR-131 `D15` 明说"LG 不信任外壳报来的 idleMs" ⇒
   *    它只作为"页面还连着且用户没在操作"的**提示**；本模块另外还要求
   *    `hasLiveClient` / `userIsSpeaking` / `sheIsSpeaking` 三个**独立读数**。
   */
  if (input.idleMs < policy.openingMinIdleMs) {
    return reject(
      'not_idle_enough',
      `外壳报来的空闲不足（${String(Math.round(input.idleMs / 1_000))} < ${String(policy.openingMinIdleMs / 1_000)} 秒）`,
      input.now + (policy.openingMinIdleMs - input.idleMs)
    )
  }

  if (input.lastOpeningAt !== undefined && input.now - input.lastOpeningAt < policy.openingCooldownMs) {
    return reject(
      'cooldown',
      `距上次开口不足冷却（${String(Math.round((input.now - input.lastOpeningAt) / 60_000))} < ${String(policy.openingCooldownMs / 60_000)} 分钟）`,
      input.lastOpeningAt + policy.openingCooldownMs
    )
  }

  if (input.openingsUsedToday >= policy.maxOpeningsPerDay) {
    return reject(
      'opening_quota_reached',
      `今日开口已达上限（${String(input.openingsUsedToday)}/${String(policy.maxOpeningsPerDay)}）`
    )
  }
  /* ★ 共享总闸：开口与 care／提醒**分闸独立、总闸共享**（ADR-131 `D15` ③） */
  if (input.allUsedToday >= policy.maxProactiveMessagesPerDay) {
    return reject(
      'daily_quota_reached',
      `今日主动消息总数已达上限（${String(input.allUsedToday)}/${String(policy.maxProactiveMessagesPerDay)}）`
    )
  }

  /* ---------------- ⑤ 能不能说 ---------------- */
  if (input.evidenceCount <= 0) {
    return reject(
      'opening_without_evidence',
      '没有可采信依据 ⇒ 不说（且**不花模型调用**：ADR-111 `S06`）'
    )
  }
  if (input.sheIsSpeaking) {
    return reject('opening_she_is_speaking', '她正在说：这一次机会必然被话权仲裁让掉，预检先拒以免白花一次调用')
  }
  if (input.userIsSpeaking) {
    return reject('opening_user_is_speaking', '用户正在说：非紧急来源要让位（ADR-131 `D07`），预检先拒')
  }
  if (!input.hasLiveClient) {
    return reject(
      'opening_no_live_client',
      '页面没有连着：生成完也没人听（`character_output_no_live_client`），预检先拒'
    )
  }

  return {
    eligible: true,
    opportunityKey,
    idleMs: input.idleMs,
    deadlineMs: policy.openingDeadlineMs,
  }
}

/**
 * 自检：15 条具名码**互不相同**且都非空。
 *
 * ⚠️ 为什么要有它：门要"对每一条都有负控"，而**两条拒绝共用一个码**会让
 *    "这条负控在量哪一条"变得不可知 —— 那正是"量具说 A、实际量 B"的老形状。
 */
export function assertOpeningRefusalCodesWellFormed(): void {
  const seen = new Set<string>()
  for (const code of OPENING_REFUSAL_CODES) {
    if (typeof code !== 'string' || code.trim() === '') {
      throw new Error('opening_refusal_code_empty')
    }
    if (seen.has(code)) throw new Error(`opening_refusal_code_duplicated:${code}`)
    seen.add(code)
  }
  if (OPENING_REFUSAL_CODES.length !== 15) {
    throw new Error(`opening_refusal_code_count_changed:${String(OPENING_REFUSAL_CODES.length)}`)
  }
}
