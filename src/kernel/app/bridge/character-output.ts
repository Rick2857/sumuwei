/**
 * Lv4.5 / `P3` —— **有限插话**：有来源的角色输出入口 + 话权仲裁。
 *
 * ============================================================================
 *  载体：计划 §1「有限插话」与 §2 `P3`
 * ============================================================================
 * 计划的原话（逐条对应下面的判据）：
 * ```text
 * 「限于呼唤回应、明确更正冲突、已授权的边查边提醒」   ⇒ 只有这三类来源
 * 「LG 生成并检查短句后让出话权」                    ⇒ 必须短，且说完就**让出**
 * 「用户抢话优先」                                  ⇒ 用户永远压过她
 * 「旧任务不串话」                                  ⇒ 过期版本一律作废
 * ```
 *
 * ---------------------------------------------------------------------------
 *  它**不**是什么（三条边界，都是刻意的）
 * ---------------------------------------------------------------------------
 * ```text
 * ① 它**不是**第二个说话入口：它不产生"她的回复" —— 那是 `SUBMIT_TURN` 的正式轮次。
 *    这里只裁决"一条**已经有来源**的短句能不能在这个时刻说出来"。
 * ② 它**不生成文本**：`text` 必须是**已过回复守卫**的短句，由调用方交进来。
 *    本模块只做"发不发 / 丢弃理由"的判定（与会话层共用同一批守卫）。
 * ③ 它**不产生来源**：`sourceRefs` 必须非空 —— "有来源的角色输出"这句话的字面实现。
 *    没有来源就没有这次输出（失败关闭），而不是补一个默认来源。
 * ```
 */

/**
 * 允许的**四类**来源（第四类由 ADR-131 加入）。
 *
 * ⚠️ 这是一个**闭集**：往里加第五类等于放宽"有限插话"这条边界（改判据，**要配负控**）。
 *
 * ---------------------------------------------------------------------------
 * **2026-10-11 修订（ADR-131 §1）—— 改的是结论，不是理由**
 * ---------------------------------------------------------------------------
 * 原注释写的是"刻意**不包含**主动闲聊…不许从这里溜进来"。那句话的**理由**是：
 * **主动闲聊没有来源** —— 一条无凭据的自由生成。
 *
 * **那条理由仍然成立，并被本修订强化**：`sourceRefs` 非空是硬要求，
 * 为空一律 `output_without_source` 失败关闭，**不补默认来源**。
 *
 * 变的是**结论**：ADR-111 已经把"来源"这个问题解掉了 ——
 * **有界依据集就是 `proactive_opening` 的来源**。
 * ⇒ 它从"无凭据的自由生成"变成"有凭据、有界、可复核的一次输出"，
 *    与当初被排除的那一类**不是同一个东西**。
 *
 * ⚠️ 三件**仍然排除**（ADR-131 §1.3）：
 * ```text
 * ① **日程提醒** —— 那是 `local.reminder.message` 的语义
 *    （ADR-124 决策 6 逐字："不借用角色插话"）
 * ② **"后台任务完成"** —— 属 `TD-19` 的另一档
 * ③ **不得借此放宽 `SUBMIT_TURN` 的入口守卫**
 *    （`scripts/postlv2_vtuber_runtime.py:1119` 一字不改）
 * ```
 */
export type CharacterOutputSource =
  | 'wake_response'
  | 'mid_turn_correction'
  | 'authorized_lookup_notice'
  /** ADR-131：系统发起的一次主动开口（**非紧急**；用户占着话权时让位） */
  | 'proactive_opening'

export const CHARACTER_OUTPUT_SOURCES: readonly CharacterOutputSource[] = [
  'wake_response',
  'mid_turn_correction',
  'authorized_lookup_notice',
  'proactive_opening',
]

/**
 * **非紧急**来源：用户占着话权（`floor.userSpeaking`）时一律**让位**，不插断。
 *
 * ADR-131 `D07` 把 `proactive_opening` 加入本集合 —— 理由与 `authorized_lookup_notice`
 * 完全相同：它**不紧急**。用一句主动开口去打断用户，换来的信息量远小于打断的代价。
 *
 * ⚠️ 另两类（`wake_response` / `mid_turn_correction`）**是紧急的**，不在本集合里：
 * 前者是"她在回应一次呼唤"，后者是"她把刚说错的那条撤回来"。
 */
export const NON_URGENT_CHARACTER_OUTPUT_SOURCES: readonly CharacterOutputSource[] = [
  'authorized_lookup_notice',
  'proactive_opening',
]

export interface CharacterOutputCandidate {
  /** 她要说的话（**必须是已过回复守卫**的文本；本模块不检查守卫，只检查"发不发"） */
  text: string
  source: CharacterOutputSource
  /**
   * 这条输出属于哪一版（话权协调的键）。
   *
   * ⚠️ 用户那边也有一个版本。**用户的版本更新** ⇒ 这条输出过期 ⇒ 作废。
   *    这正是"旧任务不串话"的机器形态。
   */
  turnRevision: number
  /** 它是**凭什么**要说的：证据/事件 id（可审计；**只放 id，不放正文**） */
  sourceRefs: readonly string[]
}

/** 用户当前的话权状态（由调用方按真实读数填，不由本模块猜） */
export interface FloorState {
  /** 用户此刻还在说（VAD/最后一块音频之后的窗口） */
  userSpeaking: boolean
  /** 用户当前的版本（比候选新 ⇒ 候选过期） */
  userRevision: number
}

export type CharacterOutputDecision =
  | {
      action: 'speak'
      text: string
      source: CharacterOutputSource
      /**
       * ⚠️ 恒为 `true`：说完**就让出话权**（计划 §1 的字面要求）。
       *    它不是装饰 —— 消费方（会话/外壳）必须据此**不**把话权继续握在自己手里。
       */
      yieldFloor: true
    }
  | { action: 'drop'; code: string }
  | { action: 'yield_to_user'; code: string }

/** 一条插话的长度上限（**有限**插话的"有限"）：句数与字数**同时**受限 */
export const CHARACTER_OUTPUT_LIMITS = {
  /** 最多几句（按中英句末标点切） */
  maxSentences: 2,
  /** 最多几个字符（按去空白后的长度） */
  maxCharacters: 60,
} as const

/** 切句（与表达契约同一套标点；只用于**计数**，不改写文本） */
function sentenceCount(text: string): number {
  const parts = text.split(/[。！？!?；;\n]+/).filter((part) => part.trim() !== '')
  return parts.length === 0 ? 1 : parts.length
}

/**
 * 裁决：这条有来源的短句，**现在**该不该说。
 *
 * ============================================================================
 *  判据顺序（顺序本身就是判据的一部分）
 * ============================================================================
 * ```text
 * ① 形状：空文本 / 无来源 / 无版本 ⇒ drop（失败关闭，各带具名码）
 * ② 长度：超过句数或字数 ⇒ drop（"有限插话"的有限）
 * ③ 来源：不在闭集里 ⇒ drop（类型上已保证，运行时再挡一次以防调用方绕过类型）
 * ④ 过期：候选版本**旧于**用户版本 ⇒ drop（旧任务不串话）
 * ⑤ 话权：用户在说话时，只有**紧急两类**能插（呼唤回应 / 明确更正）；
 *    非紧急的两类（进度通报 / **主动开口**）让给用户 ⇒ yield_to_user
 *    （ADR-131 `D07` 起含 `proactive_opening`，集合见 `NON_URGENT_CHARACTER_OUTPUT_SOURCES`）
 * ⑥ 否则 ⇒ speak（并**让出话权**）
 * ```
 *
 * ⚠️ 为什么非紧急的都要让：它们**不紧急**。用户正在说话时用一条进度通报去打断他，
 *    换来的信息量远小于打断的代价 —— 计划把它列在"已授权"里，指的是**允许提前查**，
 *    不是"允许打断用户"。`proactive_opening` 同理：它是**机会**，不是**义务**。
 */
export function arbitrateCharacterOutput(input: {
  candidate: CharacterOutputCandidate
  floor: FloorState
  limits?: { maxSentences: number; maxCharacters: number }
}): CharacterOutputDecision {
  const limits = input.limits ?? CHARACTER_OUTPUT_LIMITS
  const candidate = input.candidate

  const text = String(candidate?.text ?? '').trim()
  if (text === '') return { action: 'drop', code: 'output_without_checked_text' }
  if (!Array.isArray(candidate.sourceRefs) || candidate.sourceRefs.length === 0) {
    return { action: 'drop', code: 'output_without_source' }
  }
  if (!Number.isSafeInteger(candidate.turnRevision) || candidate.turnRevision <= 0) {
    return { action: 'drop', code: 'output_without_revision' }
  }
  if (sentenceCount(text) > limits.maxSentences || text.replace(/\s/g, '').length > limits.maxCharacters) {
    return { action: 'drop', code: 'output_too_long' }
  }
  if (!(CHARACTER_OUTPUT_SOURCES as readonly string[]).includes(candidate.source)) {
    return { action: 'drop', code: 'output_source_not_registered' }
  }
  /* ④ 旧任务不串话：用户那边已经更新过 ⇒ 这条属于"旧话题" */
  if (candidate.turnRevision < input.floor.userRevision) {
    return { action: 'drop', code: 'output_stale_against_user_revision' }
  }
  /* ⑤ 用户优先：他在说话时，非紧急来源一律让位（ADR-131 `D07` 起含 `proactive_opening`） */
  if (
    input.floor.userSpeaking &&
    (NON_URGENT_CHARACTER_OUTPUT_SOURCES as readonly string[]).includes(candidate.source)
  ) {
    return { action: 'yield_to_user', code: 'user_holds_floor_for_non_urgent_output' }
  }
  return { action: 'speak', text, source: candidate.source, yieldFloor: true }
}

/**
 * **用户抢话** ⇒ 正在说的插话立刻作废（用户优先）。
 *
 * ⚠️ 与会话层的取消是同一条纪律的两面：这里裁的是**表达**，不撤销任何已提交的东西。
 */
export function revokeForUserCutIn(input: {
  /** 正在说的那条属于哪一版 */
  speakingRevision: number
  /** 用户抢话时的版本 */
  userRevision: number
}): { revoked: boolean; code: string } {
  if (input.userRevision > input.speakingRevision) {
    return { revoked: true, code: 'revoked_by_user_cut_in' }
  }
  if (input.userRevision === input.speakingRevision) {
    return { revoked: true, code: 'revoked_by_same_turn_user_speech' }
  }
  return { revoked: false, code: 'still_current' }
}

/**
 * **呼唤回应**的程序既定短句。
 *
 * ============================================================================
 *  为什么是"既定"而不是"现场生成"
 * ============================================================================
 * ```text
 * ① 它**不是**一条自由生成的回复：呼唤回应由**程序**产出，与 M5.5 的
 *    `truthfulSearchSentence(state)` 同一种东西（既有先例：程序产出确定性短句）。
 * ② 计划 §1 要求"LG 生成并检查短句后让出话权" —— 这里的"检查"是**构造性**的：
 *    句子既定 ⇒ 它不可能带未经守卫的断言。**不是**"先生成再指望守卫拦住"。
 * ③ 它是**闭集里的一条**：加第二句 = 改判据（要配负控），不是顺手。
 * ```
 *
 * ⚠️ 长度必须落在 {@link CHARACTER_OUTPUT_LIMITS} 内 —— 否则它会被自己的仲裁丢掉，
 *    而那种失败看起来像"没触发"，不像"配置错了"。
 */
export const WAKE_RESPONSE_TEXT = '我在。'

/** 承载呼唤回应的表达线索（**既定**，不由模型给） */
export const WAKE_RESPONSE_CUE = 'firm'

/**
 * 造一条**呼唤回应**候选（有来源、有版本）。
 *
 * ⚠️ `revision` 必须由调用方给出（它决定"这条属于哪一版"）——
 *    本模块**不**自己造版本号，否则"旧任务不串话"那条判据会失去意义。
 */
export function buildWakeResponseCandidate(input: {
  revision: number
  /** 触发它的那次呼唤（**只放 id / 版本，不放正文**） */
  signalRef: string
}): CharacterOutputCandidate {
  return {
    text: WAKE_RESPONSE_TEXT,
    source: 'wake_response',
    turnRevision: input.revision,
    sourceRefs: [input.signalRef],
  }
}

/**
 * **边听边查**的程序既定短句（`P3` 选项 B）。
 *
 * ============================================================================
 *  为什么它也是"既定"的
 * ============================================================================
 * 与 {@link WAKE_RESPONSE_TEXT} 同一条纪律：这一句**不携带任何事实** ——
 * 它只说"查到了"，**具体内容仍由正式轮次给出**。
 * ```text
 * ① 它不带任何检索结论（否则就成了"用短句绕过回复守卫"）
 * ② 它是**程序**产出的既定句 ⇒ 检查是**构造性**的
 * ③ 来源仍必须非空：那条证据的 id 由 host 给出，可审计
 * ```
 * ⚠️ 长度必须落在 {@link CHARACTER_OUTPUT_LIMITS} 内。
 */
export const LOOKUP_NOTICE_TEXT = '查到了。'

/** 承载"边听边查"提醒的表达线索（**既定**，不由模型给） */
export const LOOKUP_NOTICE_CUE = 'natural'

/**
 * **中途纠正**的程序既定短句（`P3` 的第三类来源里的"纠正"那一档）。
 *
 * ============================================================================
 *  它为什么也必须是"既定"的
 * ============================================================================
 * 与呼唤回应、"查到了"同一条纪律：**它不携带任何事实**。
 * ```text
 * 它做的事是**信号**：告诉用户"刚说的那条不算，我会重说"
 * 实质内容由**重新判断过的那一轮**给出（那一条才过完整的回复守卫与来源附录）
 * ```
 * ⇒ 于是"纠正段本身"可以在**构造上**被检查（它是程序产出的常量），
 *    而"纠正的内容对不对"仍由既有链路负责。
 *
 * ⚠️ 长度必须落在 {@link CHARACTER_OUTPUT_LIMITS} 内。
 */
export const MID_TURN_CORRECTION_TEXT = '等一下，这条我得更正。'

/** 承载"中途纠正"的表达线索（**既定**，不由模型给） */
export const MID_TURN_CORRECTION_CUE = 'firm'

/**
 * 造一条**中途纠正**候选（有来源、有版本）。
 *
 * ⚠️ 与"查到了"一样：`sourceRefs` 为空 ⇒ 仲裁以 `output_without_source` 失败关闭，
 *    这里**不补默认值**（"没有来源就补一个"正好把这层边界的意义抹掉）。
 */
export function buildMidTurnCorrectionCandidate(input: {
  revision: number
  sourceRefs: readonly string[]
}): CharacterOutputCandidate {
  return {
    text: MID_TURN_CORRECTION_TEXT,
    source: 'mid_turn_correction',
    turnRevision: input.revision,
    sourceRefs: [...input.sourceRefs],
  }
}

/**
 * 造一条**边听边查**候选（有来源、有版本）。
 *
 * ⚠️ `sourceRefs` 直接来自 host 的检索读数；为空时
 *    `arbitrateCharacterOutput` 会以 `output_without_source` 失败关闭 —— 这里**不补默认值**
 *    （"没有来源就补一个"正好把这层边界的意义抹掉）。
 */
export function buildLookupNoticeCandidate(input: {
  revision: number
  sourceRefs: readonly string[]
}): CharacterOutputCandidate {
  return {
    text: LOOKUP_NOTICE_TEXT,
    source: 'authorized_lookup_notice',
    turnRevision: input.revision,
    sourceRefs: [...input.sourceRefs],
  }
}
