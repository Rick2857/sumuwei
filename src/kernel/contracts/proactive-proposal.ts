/**
 * QQ 主动联系 —— **角色选择**的契约与严格解析（WP4）。
 *
 * ============================================================================
 *  载体
 * ============================================================================
 * 计划 §4.1/§4.2（两类触发的选择权限不同 · 闭集提案 · 禁止伪装入站）·
 * 设计 [`ADR-110`] `D04`（私有选择调用）· `D04a`（装配纪律）· `D03`（关心可沉默、提醒只决定措辞）·
 * `D11`（认知边界）。
 *
 * ============================================================================
 *  三次调用、一个闭集（与 `tool-decision.ts` **同形**，不另发明一套）
 * ============================================================================
 * ```text
 * ① **严格解析**（本模块）：模型给的东西在这里被逐字段收窄 —— 多一个字段整条作废
 * ② **闭集输出**：silence / defer / send，外加理由码与**已有依据引用**
 * ③ **来源复核**（本模块）：生成前与发送前各核对一次，失效即作废
 * ```
 * ⚠️ 本模块**不**调模型、**不**读数据库、**不**读时钟：它是纯判据，
 *    真实调用在 WP4 的装配里（`openai-*` 适配器 + 网关的**不落用户事件**的编译入口）。
 *
 * ============================================================================
 *  三条硬纪律
 * ============================================================================
 * ```text
 * ① **禁止**把这次调用包装成 `user_message`：本模块产出的东西**不是**轮次
 *   （它没有 `userText`、没有 `recordUserMessage` 的入口）
 * ② **提醒不能被 `silence` 取消**（`D03`）：决策是 `silence` 时，提醒那一路
 *   走"程序模板 / 记具名阻止原因"，**不**记成提醒完成
 * ③ **不产生来源**：`sourceRefs` 必须来自**程序给的可选集**；不在集合里 ⇒ 整条作废
 *   （"有来源的角色输出"这句话的字面实现）
 */
import { KernelError, type Timestamp } from './ids.ts'
import { MAX_NOTIFICATION_TEXT_CODEPOINTS } from './notification.ts'
import type { NotificationKind } from './notification.ts'

// ---------------------------------------------------------------------------
// 一、闭集（唯一一处）
// ---------------------------------------------------------------------------

/**
 * 角色的三种选择。
 *
 * ⚠️ **不含第四种**。往闭集里加成员 = 改判据（要配负控）；
 *    "用工具查一下再发""先记到记忆里"这类都不在这里 —— 它们是被**禁止**的能力
 *    （`D04` 逐字：模型不得指定收件人、启用工具、建立循环、改调度状态）。
 */
export type ProactiveDecision = 'silence' | 'defer' | 'send'

export const PROACTIVE_DECISIONS: readonly ProactiveDecision[] = ['silence', 'defer', 'send']

/** 提案里**允许出现**的字段（多一个 ⇒ 整条作废） */
const PROPOSAL_FIELDS: ReadonlySet<string> = new Set([
  'decision', 'reasonCode', 'sourceRefs', 'text', 'deferMinutes',
])

/** `defer` 的允许范围（程序给定；**不**允许模型自选任意时刻或建立循环） */
export const PROACTIVE_DEFER_MIN_MINUTES = 15
export const PROACTIVE_DEFER_MAX_MINUTES = 180

/** 单次输出的字数上限（与通知实例的正文上限同一口径） */
export const PROACTIVE_TEXT_MAX_CODEPOINTS = MAX_NOTIFICATION_TEXT_CODEPOINTS

/** 理由码的形状（有界、无正文；进实例行，不进账本正文） */
const REASON_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/

/** 解析失败的**具名**码（闭集；诊断与门用） */
export const PROACTIVE_PARSE_CODES: readonly string[] = [
  'proactive_empty',
  'proactive_no_json_object',
  'proactive_bad_json',
  'proactive_not_object',
  'proactive_unknown_field',
  'proactive_bad_decision',
  'proactive_missing_reason_code',
  'proactive_bad_reason_code',
  'proactive_missing_source_refs',
  'proactive_source_refs_not_array',
  'proactive_source_ref_too_long',
  'proactive_send_without_text',
  'proactive_send_text_too_long',
  'proactive_send_text_control_chars',
  'proactive_non_send_with_text',
  'proactive_defer_without_minutes',
  'proactive_defer_minutes_out_of_range',
  'proactive_non_defer_with_minutes',
  'proactive_unknown_parse_failure',
]

/** 调用侧的失败桶（与 `tool-decision.ts` 同一个三分法） */
export const PROACTIVE_CALL_FAILURES: readonly string[] = ['timeout', 'call_failed', 'invalid_output']
export type ProactiveCallFailure = (typeof PROACTIVE_CALL_FAILURES)[number]

export interface ProactiveProposal {
  readonly decision: ProactiveDecision
  readonly reasonCode: string
  /** 她凭什么说：**必须**是程序给的可选集里的 id（不在这里 ⇒ 整条作废） */
  readonly sourceRefs: readonly string[]
  /** `send` 时必有 */
  readonly text?: string
  /** `defer` 时必有（分钟；落在程序给定的范围内） */
  readonly deferMinutes?: number
}

// ---------------------------------------------------------------------------
// 二、严格解析（**唯一**一处；多一个字段整条作废）
// ---------------------------------------------------------------------------

/** 从模型输出里抠出一个 JSON 对象（剥围栏；不在这里下结论） */
export function extractProactiveJson(raw: string): unknown {
  const stripped = String(raw ?? '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
  return JSON.parse(stripped) as unknown
}

export interface ProactiveParseFailure {
  readonly ok: false
  readonly code: string
  readonly detail: string
}

export type ProactiveParseResult = { readonly ok: true; readonly proposal: ProactiveProposal } | ProactiveParseFailure

function fail(code: string, detail: string): ProactiveParseFailure {
  return { ok: false, code, detail }
}

/**
 * 严格解析一条提案。
 *
 * 判据顺序（**顺序本身是判据的一部分**）：
 * ```text
 * ① 是对象 ② 字段全在闭集 ③ decision 在闭集 ④ reasonCode 形状
 * ⑤ sourceRefs 是非空字符串数组且有界
 * ⑥ 分派的**专属**约束：send ⇔ 有 text；defer ⇔ 有 deferMinutes（且在范围内）；
 *    非 send 不许带 text；非 defer 不许带 deferMinutes
 * ```
 * ⚠️ 它**不**校验"来源是否真的存在" —— 那需要程序的可用集，属 `verifyProactiveSources`。
 *    两件事分开是刻意的：解析是**形状**，复核是**事实**。
 */
export function parseProactiveProposal(raw: unknown, options?: { allowSend?: boolean; allowDefer?: boolean }): ProactiveParseResult {
  if (typeof raw === 'string') {
    const text = raw.trim()
    if (text === '') return fail('proactive_empty', '模型什么都没给')
    let parsed: unknown
    try {
      parsed = extractProactiveJson(text)
    } catch {
      return fail('proactive_no_json_object', '模型给了东西但不是 JSON 对象')
    }
    return parseProactiveProposal(parsed, options)
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return fail('proactive_not_object', `提案必须是对象，收到 ${raw === null ? 'null' : typeof raw}`)
  }
  const record = raw as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!PROPOSAL_FIELDS.has(key)) {
      return fail('proactive_unknown_field', `提案出现闭集外的字段：${key}（多一个字段整条作废）`)
    }
  }

  const decision = record.decision
  if (typeof decision !== 'string' || !(PROACTIVE_DECISIONS as readonly string[]).includes(decision)) {
    return fail('proactive_bad_decision', `decision 只能是 ${PROACTIVE_DECISIONS.join(' / ')}`)
  }

  const reasonCode = record.reasonCode
  if (typeof reasonCode !== 'string' || reasonCode.trim() === '') {
    return fail('proactive_missing_reason_code', '提案必须有 reasonCode（"为什么这么选"要可查）')
  }
  if (!REASON_CODE_PATTERN.test(reasonCode)) {
    return fail('proactive_bad_reason_code', `reasonCode 形状不合法：${reasonCode}`)
  }

  const sourceRefs = record.sourceRefs
  if (sourceRefs === undefined) {
    return fail('proactive_missing_source_refs', '提案必须有 sourceRefs（没有依据就没有这次输出）')
  }
  if (!Array.isArray(sourceRefs) || sourceRefs.some((ref) => typeof ref !== 'string')) {
    return fail('proactive_source_refs_not_array', 'sourceRefs 必须是字符串数组')
  }
  if (sourceRefs.some((ref) => String(ref).length > 200)) {
    return fail('proactive_source_ref_too_long', 'sourceRefs 里有超过 200 字符的引用')
  }

  const text = record.text
  const deferMinutes = record.deferMinutes

  if (decision === 'send') {
    if (options?.allowSend === false) {
      return fail('proactive_bad_decision', '这一档不允许 send（程序给定）')
    }
    if (typeof text !== 'string' || text.trim() === '') {
      return fail('proactive_send_without_text', '选了 send 就必须给出要说的话')
    }
    const codepoints = [...text]
    if (codepoints.length > PROACTIVE_TEXT_MAX_CODEPOINTS) {
      return fail(
        'proactive_send_text_too_long',
        `要说的话超过 ${String(PROACTIVE_TEXT_MAX_CODEPOINTS)} 码点（收到 ${String(codepoints.length)}）`
      )
    }
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) {
      return fail('proactive_send_text_control_chars', '要说的话含控制字符')
    }
    if (deferMinutes !== undefined) {
      return fail('proactive_non_defer_with_minutes', 'send 不许带 deferMinutes')
    }
  } else {
    if (text !== undefined) {
      return fail('proactive_non_send_with_text', `${decision} 不许带 text（没要说的话却带了正文）`)
    }
    if (decision === 'defer') {
      if (options?.allowDefer === false) {
        return fail('proactive_bad_decision', '这一档不允许 defer（程序给定）')
      }
      if (typeof deferMinutes !== 'number' || !Number.isSafeInteger(deferMinutes)) {
        return fail('proactive_defer_without_minutes', 'defer 必须给出 deferMinutes（整数分钟）')
      }
      if (
        deferMinutes < PROACTIVE_DEFER_MIN_MINUTES ||
        deferMinutes > PROACTIVE_DEFER_MAX_MINUTES
      ) {
        return fail(
          'proactive_defer_minutes_out_of_range',
          `deferMinutes 必须在 ${String(PROACTIVE_DEFER_MIN_MINUTES)}–${String(PROACTIVE_DEFER_MAX_MINUTES)} 之间（收到 ${String(deferMinutes)}）`
        )
      }
    } else if (deferMinutes !== undefined) {
      return fail('proactive_non_defer_with_minutes', 'silence 不许带 deferMinutes')
    }
  }

  return {
    ok: true,
    proposal: {
      decision: decision as ProactiveDecision,
      reasonCode,
      sourceRefs: sourceRefs.map((ref) => String(ref)),
      ...(typeof text === 'string' ? { text } : {}),
      ...(typeof deferMinutes === 'number' ? { deferMinutes } : {}),
    },
  }
}

// ---------------------------------------------------------------------------
// 三、来源复核（生成前 + 发送前；`D11` ③）
// ---------------------------------------------------------------------------

export interface SourceVerification {
  readonly ok: boolean
  readonly code?: string
  /** 这些引用**已经不在**可用集里（失效 / 被遗忘 / 被结清） */
  readonly staleRefs?: readonly string[]
}

/**
 * 核对提案引用的来源**现在**还算不算数。
 *
 * ⚠️ 它必须在**两个时刻**各跑一次（`D11` ③）：
 * ```text
 * 生成前  …… 候选刚产出时
 * 发送前  …… 复检时（中间可能发生遗忘 / 来源失效 / 任务结清）
 * ```
 * ⚠️ `available` 为**空集**时一律拒绝（失败关闭）：拿不到可用集就**不**输出，
 *    而不是"没查到失效就当它有效"。
 */
export function verifyProactiveSources(input: {
  sourceRefs: readonly string[]
  available: ReadonlySet<string>
}): SourceVerification {
  if (input.sourceRefs.length === 0) {
    return { ok: false, code: 'proactive_without_source' }
  }
  if (input.available.size === 0) {
    return { ok: false, code: 'proactive_source_set_unavailable' }
  }
  const stale = input.sourceRefs.filter((ref) => !input.available.has(ref))
  if (stale.length > 0) {
    return { ok: false, code: 'proactive_source_stale', staleRefs: stale }
  }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// 四、两类触发的**权限差**（`D03`）
// ---------------------------------------------------------------------------

/**
 * 这一次机会的角色能决定什么。
 *
 * ```text
 * 自主关心：silence / defer / send 三者皆可（沉默是**合法结局**）
 * 明确提醒：只决定**措辞**；到点且未取消且策略仍允许 ⇒ **不许**用 silence 自行取消
 * ```
 */
export interface DecisionAuthority {
  readonly allowSilence: boolean
  readonly allowDefer: boolean
  readonly allowSend: boolean
  /** 角色选择 silence 时**程序**该怎么办（提醒 ⇒ 走模板或记具名阻止原因） */
  readonly onSilence: 'accept_as_legal_silence' | 'use_template_or_record_block'
}

export function decisionAuthorityFor(kind: NotificationKind): DecisionAuthority {
  return kind === 'reminder'
    ? {
        /* 提醒到点了：她可以沉默地"不想说"，但那**不构成**取消 —— 程序模板兜底 */
        allowSilence: true,
        allowDefer: false,
        allowSend: true,
        onSilence: 'use_template_or_record_block',
      }
    : {
        allowSilence: true,
        allowDefer: true,
        allowSend: true,
        onSilence: 'accept_as_legal_silence',
      }
}

/**
 * 把"角色的选择"翻译成**程序**的动作（提醒与关心在这里分岔）。
 *
 * ⚠️ 提醒的 `silence` **绝不**翻译成 `skip`：`skip` 会让这一条提醒
 *    以"她决定不说"收场，而本人在等的是**提醒**（`D03` 逐字：
 *    "该类候选的 silence/defer 输出不能记作提醒完成"）。
 */
export type ProactiveProgramAction =
  | { readonly action: 'stay_silent'; readonly code: string }
  | { readonly action: 'defer'; readonly until: Timestamp }
  | { readonly action: 'deliver'; readonly text: string }
  | { readonly action: 'deliver_template'; readonly code: string }
  | { readonly action: 'blocked'; readonly code: string }

export function programActionFor(input: {
  kind: NotificationKind
  proposal: ProactiveProposal
  now: Timestamp
}): ProactiveProgramAction {
  const { kind, proposal, now } = input
  if (proposal.decision === 'send') {
    return { action: 'deliver', text: proposal.text! }
  }
  if (proposal.decision === 'defer') {
    return { action: 'defer', until: now + proposal.deferMinutes! * 60_000 }
  }
  /* silence */
  if (kind === 'reminder') {
    return { action: 'deliver_template', code: 'reminder_silenced_use_template' }
  }
  return { action: 'stay_silent', code: 'care_legal_silence' }
}

/** 模型失败时的兜底（`D03`：提醒可用已校验内容的**程序模板**，关心则放弃本次机会） */
export function programActionOnModelFailure(input: {
  kind: NotificationKind
  failure: ProactiveCallFailure
}): ProactiveProgramAction {
  if (input.kind === 'reminder') {
    return { action: 'deliver_template', code: `reminder_model_${input.failure}` }
  }
  return { action: 'stay_silent', code: `care_model_${input.failure}` }
}

// ---------------------------------------------------------------------------
// 五、给模型的**程序生成**简报（有界、不含"请主动找本人"这种伪装入站的说法）
// ---------------------------------------------------------------------------

/** 一条候选依据（程序给的**可选项**；模型只能从中挑） */
export interface ProactiveSourceOption {
  readonly ref: string
  /** 有界的可读摘要（程序生成；**不**是正文） */
  readonly summary: string
}

export interface ProactiveBriefing {
  readonly kind: NotificationKind
  /** 机会的种类说明（程序写；不是"用户说了什么"） */
  readonly opportunity: string
  /** 当前时刻在该时区的墙上时刻 */
  readonly localTime: string
  readonly timezone: string
  /** 可选依据（最多 8 条；每条摘要 ≤ 120 码点） */
  readonly sources: readonly ProactiveSourceOption[]
  /** 提醒的既定内容（只有提醒有；它是**程序已校验**的那一条） */
  readonly reminderText?: string
  /** 还能说多少字（程序给的上限） */
  readonly textBudget: number
}

export const PROACTIVE_MAX_SOURCE_OPTIONS = 8
export const PROACTIVE_SOURCE_SUMMARY_CODEPOINTS = 120

/**
 * **可用来源**的一条候选（ADR-111 `S01`/`S02`）。
 *
 * ⚠️ 字段名 **不是** `text` 而是 `label`，这是刻意的：调用方**只能**喂
 *    "已经过同一套遮蔽的读时视图"里的条目（记忆事实 / 可用信念 / 未结清目标），
 *    而它们的摘要**由程序生成**。把它叫 `text` 会邀请调用方把**原始对话行**塞进来 ——
 *    而那正是计划 §4.2 逐字禁止的（"其它入口近期原文不因主动调度流入 QQ"）。
 */
export interface ProactiveSourceCandidate {
  /** 稳定 id（必须非空 —— 空 id 的引用是引用不了的） */
  readonly ref: string
  /** 程序生成的**有界标签**（不是正文、不是她要说的话） */
  readonly label: string
}

/**
 * 把读时视图的条目**有界化**成可引用的来源集（ADR-111 `S02`）。
 *
 * ```text
 * ① 丢掉 ref 或 label 为空的（引用必须引用得了东西）
 * ② 按 ref 去重（保留**第一次**出现的那条 ⇒ 结果只与输入顺序有关，是**确定性**的）
 * ③ label 截到 PROACTIVE_SOURCE_SUMMARY_CODEPOINTS 码点（**按码点**，不是按 UTF-16 单元）
 * ④ 只留前 PROACTIVE_MAX_SOURCE_OPTIONS 条
 * ```
 * ⚠️ **不**在这里排序、**不**在这里打分：顺序就是读时视图的顺序
 *    （`S02`：不另发明一套打分）。这样"哪 8 条能被引用"是**可复算**的。
 */
export function boundProactiveSources(
  candidates: readonly ProactiveSourceCandidate[]
): ProactiveSourceOption[] {
  const seen = new Set<string>()
  const out: ProactiveSourceOption[] = []
  for (const candidate of candidates) {
    const ref = String(candidate.ref ?? '').trim()
    const label = String(candidate.label ?? '').trim()
    if (ref === '' || label === '') continue
    if (seen.has(ref)) continue
    seen.add(ref)
    out.push({ ref, summary: [...label].slice(0, PROACTIVE_SOURCE_SUMMARY_CODEPOINTS).join('') })
    if (out.length >= PROACTIVE_MAX_SOURCE_OPTIONS) break
  }
  return out
}

/**
 * post-Lv2 / ADR-110 `D03`（**2026-10-07 用户裁定 B**）：**提醒正文的私有调用**。
 *
 * ============================================================================
 *  为什么要有它
 * ============================================================================
 * ```text
 * `createIntent` 对提醒**强制要求非空正文**（"不许设了一个空提醒"），
 * 而入口 `readReminderRequest` 只读出**时刻**（dueAt/basis/matched），**没有内容**。
 * ⇒ 正文由**模型在创建那一刻**写一句（裁定 B）；失败 ⇒ **不建意图**。
 * ```
 * ⚠️ 它是**第二次**私有调用入口（第一次是关心那一支的 `buildProactiveInstruction`）。
 *    两条都守着 `D04` 的同一套纪律：**一次调用就是一次调用**（不重试、不降级重问）。
 * ⚠️ 提示词**从契约派生**：正文上限直接引 `MAX_NOTIFICATION_TEXT_CODEPOINTS`。
 */
export function buildReminderTextInstruction(): string {
  return [
    '你是"把这件事记成一句提醒"的写作者。读对方整句话，抽出**要提醒的那件事**，',
    '写成**一句**提醒。',
    '',
    '硬规则：',
    '1. **只输出 JSON**：不要解释、不要 markdown 代码围栏、不要在 JSON 前后写任何字。',
    '2. 只能有一个字段 `text`，值是那句提醒（≤' +
      String(MAX_NOTIFICATION_TEXT_CODEPOINTS) +
      ' 字）。**多一个字段整条作废**。',
    '3. 提醒是**将来对她自己说的**：写"该喝水了""记得交材料"，',
    '   **不要**写成"你让我提醒你…"这种转述，也不要复述时间（时间由程序另记）。',
  ].join('\n')
}

/** 提醒正文的**有界校验**（闭集：只有一个 `text`） */
export type ReminderTextResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly code: string }

export function readReminderTextResponse(raw: unknown): ReminderTextResult {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, code: 'reminder_text_not_object' }
  }
  const keys = Object.keys(raw as Record<string, unknown>)
  if (keys.length !== 1 || keys[0] !== 'text') {
    return { ok: false, code: 'reminder_text_unknown_field' }
  }
  const value = (raw as { text?: unknown }).text
  if (typeof value !== 'string') return { ok: false, code: 'reminder_text_not_string' }
  const text = value.trim()
  if (text === '') return { ok: false, code: 'reminder_text_empty' }
  if ([...text].length > MAX_NOTIFICATION_TEXT_CODEPOINTS) {
    return { ok: false, code: 'reminder_text_too_long' }
  }
  return { ok: true, text }
}

/**
 * 把可用来源集渲染成 `system_opportunity` section 的文本（ADR-111 `S02`/`S03`）。
 *
 * ============================================================================
 *  它**只**做三件事（判据全在别处）
 * ============================================================================
 * ```text
 * ① 有界化（`boundProactiveSources`：去空 / 去重 / 截断 / 最多 8 条）
 * ② 确定性渲染：把 ref 与标签逐条列出来 —— 这就是给模型的**闭集**
 * ③ **空集 ⇒ `undefined`**（不是"空文本"）：调用方据此得到 **0 个 section**，
 *    与她"没有依据可说"这件事在**结构上**一致（ADR-111 `S06` 的失败关闭）
 * ```
 * ⚠️ 它**不**判断"哪条该被引用"、**不**替模型挑、**不**排序（顺序 = 读时视图的顺序）。
 * ⚠️ 为什么"空 ⇒ undefined"要写在这里而不是让调用方自己判：这样**只有一个地方**
 *    决定"没有依据时会发生什么"，而不是每个调用点各写一遍（写漏一次就等于允许空引用发送）。
 */
export function renderSystemOpportunitySection(
  candidates: readonly ProactiveSourceCandidate[]
): { readonly text: string; readonly sourceRefs: string[] } | undefined {
  const bounded = boundProactiveSources(candidates)
  if (bounded.length === 0) return undefined
  const lines: string[] = [
    '【这一次机会里可以引用的依据】',
    ...bounded.map((source) => `- ${source.ref}：${source.summary}`),
    '',
    '⚠️ 你**只能**引用上面这些 ref。引用别的、或者一条都不引，整条提案都会被作废。',
  ]
  return { text: lines.join('\n'), sourceRefs: bounded.map((source) => source.ref) }
}

/**
 * 渲染给模型的用户消息。
 *
 * ⚠️ **只说这是"一次机会"**，不说"用户让你主动找他"：
 *    后一种说法会诱导模型把这次调用当成一次入站对话（`D04` 禁止的正是那件事）。
 * ⚠️ 简报里的 `sources` 是**闭集**：模型给出的引用不在这里 ⇒ 整条作废。
 */
export function renderProactiveBriefing(briefing: ProactiveBriefing): string {
  const lines: string[] = []
  lines.push(`【一次${briefing.kind === 'reminder' ? '到点的提醒' : '空闲的机会'}】${briefing.opportunity}`)
  lines.push(`现在是 ${briefing.localTime}（${briefing.timezone}）。`)
  if (briefing.reminderText !== undefined) {
    lines.push('')
    lines.push(`本人之前要求过的内容（**已校验**，逐字如下）：${briefing.reminderText}`)
  }
  lines.push('')
  if (briefing.sources.length === 0) {
    lines.push('现在**没有**可引用的依据。')
  } else {
    lines.push('可以引用的依据（**只能**从这些 ref 里挑，挑不了就别引用）：')
    for (const source of briefing.sources.slice(0, PROACTIVE_MAX_SOURCE_OPTIONS)) {
      const summary = [...source.summary].slice(0, PROACTIVE_SOURCE_SUMMARY_CODEPOINTS).join('')
      lines.push(`- ${source.ref} :: ${summary}`)
    }
  }
  lines.push('')
  lines.push(
    `要说的话最多 ${String(briefing.textBudget)} 个字符；` +
      `不确定要不要说就选 silence（那是**合法**的结局，不是失败）。`
  )
  lines.push('⚠️ 这不是对方发来的一条消息：不要以"回复"的口吻写，也不要假装对方刚说了什么。')
  return lines.join('\n')
}

/** 从契约**派生**的指令（提示词与闭集不会漂移；导出是为了让门断言"两者同步"） */
export function buildProactiveInstruction(): string {
  return [
    '你正在做一次**私有选择**：现在要不要联系对方。',
    '',
    '硬规则：',
    '1. **只输出一个 JSON 对象**：不要解释、不要 markdown 围栏、不要在 JSON 前后写任何字。',
    `2. \`decision\` 只能是 ${PROACTIVE_DECISIONS.map((d) => `\`${d}\``).join(' / ')} 之一。`,
    '3. 必须有 `reasonCode`（小写字母/数字/下划线，≤64 字符）说明你为什么这么选。',
    '4. 必须有 `sourceRefs`（数组）：**只能**用简报里列出的 ref；一条都没有就选 `silence`。',
    '   ⚠️ 不许自己编 ref，也不许把摘要当成 ref。',
    `5. \`send\` 必须带 \`text\`（≤${String(PROACTIVE_TEXT_MAX_CODEPOINTS)} 字符）；` +
      '`silence` / `defer` **不许**带 `text`。',
    `6. \`defer\` 必须带 \`deferMinutes\`（${String(PROACTIVE_DEFER_MIN_MINUTES)}–${String(PROACTIVE_DEFER_MAX_MINUTES)} 的整数）；` +
      '其它 decision **不许**带它。',
    '7. 你**不能**在这条 JSON 里指定收件人、不能启用任何工具、不能改时间表、不能写记忆。',
    '8. 不要在正文里写"我看到你很久没说话"这类**你无法知道**的判断：你只知道"现在是一次机会"。',
    '',
    '输出示例（形状，不是答案）：',
    '{"decision":"silence","reasonCode":"nothing_worth_saying","sourceRefs":[]}',
    '{"decision":"defer","reasonCode":"too_late_today","sourceRefs":["mem:abc"],"deferMinutes":60}',
    '{"decision":"send","reasonCode":"follow_up_progress","sourceRefs":["mem:abc"],"text":"上次那个报告写完啦？"}',
  ].join('\n')
}

/** 兜底模板：提醒的程序既定句（**不携带**原请求里的任何工具指令，`D03` 逐字） */
export function reminderTemplateText(reminderText: string): string {
  const trimmed = reminderText.trim()
  if (trimmed === '') {
    throw new KernelError('validation_error', 'reminder_template_empty', '提醒模板不能为空')
  }
  return `提醒你一下：${trimmed}`
}
