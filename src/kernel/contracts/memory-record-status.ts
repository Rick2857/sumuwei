/**
 * M6.1 WP4 / ADR-055 `D-55e` + `D-55f`：**记录状态**（程序生成的那一行）。
 *
 * ============================================================================
 *  它要解决的是"什么都不说"这件事
 * ============================================================================
 * 实测（设计文档 §2.8 / §1.16）：他这一轮问"我们刚才聊到哪儿了"，而这一轮的
 * 上下文里**一条记忆都没有** —— 提示里没有任何地方说"本轮没有可依据的记录"，
 * 于是她把"什么都没有"读成"自由发挥"，补出一段没发生过的共同经历。
 *
 * ⇒ 修法不是再加一条禁令（禁令本来就在提示里），而是把**程序事实**渲染出来：
 *    「本轮长期记忆召回未向最终上下文提供记录。」
 *
 * ---------------------------------------------------------------------------
 *  五条硬约束（用户 2026-09-24 逐条裁定，见 ADR-055 §2.1）
 * ---------------------------------------------------------------------------
 * ① **不设单选枚举**：同一轮完全可能"有记录进了上下文"**同时**"另有记录被裁 / 已遗忘"
 *    ⇒ `reasons` 是**可并存的列表**，另记"最终入模数量"（否则"可用"会掩盖被遗忘槽位）。
 * ② **默认措辞不得升级**：召回为空时只能说"长期记忆召回未提供记录"；
 *    那句更广的「没有可支持这段共同经历的合格记录」**只在程序确实覆盖了全部相关来源**
 *    时才可用（`allSourcesCovered`）—— 否则它就是在替用户断言世界。
 * ③ `ineligible` **按原因拆开**（遗忘 / 取代 / 来源未确立 / 依据链不完整），
 *    且"槽位"必须**具名**。
 * ④ 补 `search_failed` / `state_unknown`：**失败不得伪装成零结果**。
 * ⑤ 措辞**只讲我们的记录**，不写"事情没发生过"（那是替用户断言世界）——
 *    由 `MEMORY_RECORD_STATUS_FORBIDDEN_PHRASES` 机器守着。
 *
 * ⚠️ 这个文件是**纯契约 + 纯函数**：不 import 框架、不读时钟、不碰数据库。
 */

/**
 * 记录状态的原因（**可并存**，不是单选）。
 *
 * ⚠️ 顺序就是**渲染顺序**（确定性）：同一组原因必须产出逐字节相同的文本。
 */
export type MemoryRecordStatusReason =
  /** 本轮**根本没有发起检索**（端口没接 / 开关关闭 / 没有 userId） */
  | 'not_searched'
  /** 检索**失败**（失败不得伪装成零结果） */
  | 'search_failed'
  /** 读状态本身失败 / 不可用（"不知道"与"没有"是两件事） */
  | 'state_unknown'
  /** 有来源但**检索没命中**（相关性阈值没过） */
  | 'no_relevant'
  /** 有来源但被**预算裁剪**（编译期裁剪或整段被上下文预算丢掉） */
  | 'dropped_by_budget'
  /** 有来源但**资格不合格**：显式遗忘 */
  | 'ineligible:forgotten'
  /** 有来源但**资格不合格**：已被后续记录取代 */
  | 'ineligible:superseded'
  /** 有来源但**资格不合格**：来源尚未确立 */
  | 'ineligible:unconfirmed'
  /** 有来源但**资格不合格**：依据链不完整（悬空证据） */
  | 'ineligible:orphaned'

export const MEMORY_RECORD_STATUS_REASONS: readonly MemoryRecordStatusReason[] = [
  'not_searched',
  'search_failed',
  'state_unknown',
  'no_relevant',
  'dropped_by_budget',
  'ineligible:forgotten',
  'ineligible:superseded',
  'ineligible:unconfirmed',
  'ineligible:orphaned',
]

/**
 * 每一个原因的**可达性事实**。
 *
 * 为什么要有这张表：把"表达得了但永远出不来"的值静默留在枚举里，是仓库反复登记的
 * 那类损失（见 `contracts/recall.ts` 的 `RECALL_EXCLUSION_REASON_FACTS`）。
 * 今天没有生产者的原因必须**具名写下来**，而不是看起来像"已实现"。
 */
export interface MemoryRecordStatusReasonFact {
  /** 今天有没有**真实数据**能触发它 */
  readonly reachable: boolean
  /** 谁产它（源码坐标/机制名） */
  readonly producer: string
  /** `reachable: false` 时必须写明"为什么今天出不来" */
  readonly blocker?: string
}

export const MEMORY_RECORD_STATUS_REASON_FACTS: Readonly<
  Record<MemoryRecordStatusReason, MemoryRecordStatusReasonFact>
> = {
  not_searched: {
    reachable: true,
    producer: 'turn-gateway.compileTurn · recallForTurn 的三条缺省（端口/开关/userId）',
  },
  search_failed: {
    reachable: true,
    producer: 'turn-gateway.compileTurn · recall.run 抛错被捕获（降级为具名失败，不再中断整轮）',
  },
  state_unknown: {
    reachable: false,
    producer: '（无）',
    blocker:
      '今天没有任何一条读状态的路径会"失败但可继续"：recall.run 是唯一的读状态入口，' +
      '它失败时整轮会中断（不产生状态行）。要让它可达，需要一条"部分维度不可用"的具名能力报告。',
  },
  no_relevant: {
    reachable: true,
    producer: 'RecallDecisionRecord.metrics.exclusionHistogram.LOW_RELEVANCE',
  },
  dropped_by_budget: {
    reachable: true,
    producer:
      'RecallDecisionRecord.metrics.droppedByBudget（BUDGET_EXHAUSTED）与 droppedByContextBudget（整段被上下文预算丢掉）',
  },
  'ineligible:forgotten': {
    reachable: true,
    producer: 'RecallDecisionRecord.metrics.exclusionHistogram.FORGOTTEN',
  },
  'ineligible:superseded': {
    reachable: true,
    producer: 'RecallDecisionRecord.metrics.exclusionHistogram.SUPERSEDED',
  },
  'ineligible:unconfirmed': {
    reachable: false,
    producer: '（无）',
    blocker:
      'M5 的资格层今天**不**为"来源未确立"产生排除理由：`UNCONFIRMED_ORIGIN` 只影响渲染后缀' +
      '（`qualificationLabelSuffix`），不产生 `RecallExclusionReason`。' +
      '它要可达，得先有一条把 `unconfirmed` 记录挡在资格之外的判据。',
  },
  'ineligible:orphaned': {
    reachable: true,
    producer: 'RecallDecisionRecord.metrics.exclusionHistogram.ORPHANED_EVIDENCE',
  },
}

/** 今天可达的原因（其余的是**登记在案的未实现**，不是"已实现"） */
export function reachableMemoryRecordStatusReasons(): MemoryRecordStatusReason[] {
  return MEMORY_RECORD_STATUS_REASONS.filter(
    (reason) => MEMORY_RECORD_STATUS_REASON_FACTS[reason].reachable
  )
}

/** 今天**出不来**的原因（如实列出，不假装都有人用） */
export function reservedMemoryRecordStatusReasons(): MemoryRecordStatusReason[] {
  return MEMORY_RECORD_STATUS_REASONS.filter(
    (reason) => !MEMORY_RECORD_STATUS_REASON_FACTS[reason].reachable
  )
}

/** 没有发起检索的具名原因（使用前提：必须是这三个之一） */
export type NotSearchedCause = 'port_not_wired' | 'flag_off' | 'no_user_id'

/** 逐条措辞里出现的具名原因（中文；**不含任何用户内容**） */
export const NOT_SEARCHED_CAUSE_LABEL: Readonly<Record<NotSearchedCause, string>> = {
  port_not_wired: '端口未接',
  flag_off: '开关关闭',
  no_user_id: '没有 userId',
}

/**
 * 诊断细节。
 *
 * ⚠️ 它进 **trace**，不进 prompt（prompt 里只放简短状态，见 §4.5 ⑤）。
 * ⚠️ 只有 id / 计数 / 枚举标签，**没有任何正文**。
 */
export interface MemoryRecordStatusDetail {
  /** `not_searched` 的具名原因 */
  readonly notSearchedCause?: NotSearchedCause
  /** `search_failed` 的具名原因（错误码/短消息，由调用方给出） */
  readonly searchFailedReason?: string
  /** `state_unknown` 的具名原因 */
  readonly stateUnknownReason?: string
  /** 编译期被预算裁掉的条数 */
  readonly droppedByBudgetCount: number
  /** 未达到相关性阈值的条数 */
  readonly notRelevantCount: number
  /** 各资格不合格原因命中的条数 */
  readonly ineligibleCounts: {
    readonly forgotten: number
    readonly superseded: number
    readonly unconfirmed: number
    readonly orphaned: number
  }
  /**
   * 各资格不合格原因对应的**具名槽位**（`canonicalKey`）。
   *
   * ⚠️ 这是"槽位必须具名"那条前提的落点：拿不到槽位时，渲染器**不许**用
   *    「槽位 <…> 的…」那句（那会变成一句没有指称的断言）。
   */
  readonly ineligibleSlots: Partial<Record<MemoryRecordStatusReason, readonly string[]>>
  /** 选择器选了、但整段被上下文预算丢掉 */
  readonly droppedByContextBudget: boolean
}

export interface MemoryRecordStatus {
  /** 可并存的原因（顺序按 `MEMORY_RECORD_STATUS_REASONS`） */
  readonly reasons: readonly MemoryRecordStatusReason[]
  /** 本轮**最终**进入上下文的长期记忆条数（编译**之后**的数） */
  readonly includedCount: number
  readonly detail: MemoryRecordStatusDetail
}

/** 渲染选项（只有"全来源覆盖"这一条会改变措辞） */
export interface MemoryRecordStatusRenderOptions {
  /**
   * 程序**确实覆盖了全部相关来源**（长期记忆 + Recent + 摘要…）。
   *
   * ⚠️ 缺省 `false`：默认那句**不得**升级为更广的断言（ADR-055 §2.1 ②）。
   * ⚠️ 传了 `sources` 时，这个布尔**不再单独作数**：必须 `sources` 三个来源都
   *    处于**已知**状态，"更广那句"才允许出现（见 `allSourcesKnown`）。
   */
  readonly allSourcesCovered?: boolean
  /**
   * ==========================================================================
   *  三个来源在**最终上下文**里的覆盖读数（M6.1 WP5 追加，用户 2026-09-24 裁定）
   * ==========================================================================
   * 发现① 的机制：程序只说了「本轮长期记忆召回未向最终上下文提供记录」这一句，
   * 而**没有**说"最近对话有多少轮进了上下文 / 摘要有没有进"。于是那一行
   * 可以被读成"我们之间什么都没有" —— 她接着补出一段没发生过的共同经历。
   *
   * ⇒ 修法：把**长期记忆 / 最近对话 / 摘要**三件事**分列**渲染，而且每一条
   *    都来自**最终 packet**（section 在不在 + `sourceRefs` 有几条），
   *    不是"按配置猜"。三个来源**不得合并成一句**。
   * ⚠️ 缺省 `undefined` ⇒ 保持旧渲染（逐条原因那种）；旧断言因此逐字节不变。
   */
  readonly sources?: ContextSourceCoverage
}

/**
 * 一个来源在**最终上下文**里的覆盖结局。
 *
 * ⚠️ 五种结局**不得合并**（与原因枚举同一条理由）：
 * 「有内容」/「咨询过但没有」/「这一轮没咨询」/「咨询失败」/「状态不可用」
 * 是**五件不同的事**，而"失败不得伪装成零结果"是 ADR-055 §2.1 ④ 的硬要求。
 */
export type ContextSourceOutcome =
  /** 有内容进了最终上下文 */
  | 'provided'
  /** 咨询过这个来源，没有可提供的（**不是**失败，也**不是**"没咨询"） */
  | 'empty'
  /** 这一轮没有咨询这个来源（原因见 `reason`） */
  | 'not_consulted'
  /** 咨询失败（**不得**据此说"没有"） */
  | 'failed'
  /** 状态不可用（"不知道"与"没有"是两件事） */
  | 'unknown'

export interface ContextSourceReading {
  readonly outcome: ContextSourceOutcome
  /** 该来源**真的进了最终上下文**的条目数（`provided` 时 > 0） */
  readonly included: number
  /** `failed` / `unknown` / `not_consulted` 时的**具名**原因 */
  readonly reason?: string
}

/**
 * 三个来源的覆盖读数。
 *
 * ⚠️ 只有这三个 —— 加第四个来源必须同时加"它怎么进 packet、怎么被计数"的判据，
 *    否则那个字段会变成一个没人能证伪的断言。
 */
export interface ContextSourceCoverage {
  /** 长期记忆（召回） */
  readonly longTermMemory: ContextSourceReading
  /** 最近对话（`recent-conversation` section） */
  readonly recentConversation: ContextSourceReading
  /** 摘要 / 滚动摘录（`rollup-summary` section） */
  readonly summary: ContextSourceReading
}

/** 三个来源的**程序用语**（中文；**不含任何用户内容**） */
export const CONTEXT_SOURCE_LABEL = {
  longTermMemory: '长期记忆',
  recentConversation: '最近对话',
  summary: '摘要',
} as const

/** 三个来源是否都处于**已知**状态（`provided` / `empty`）—— "更广那句"的前提 */
export function allSourcesKnown(coverage: ContextSourceCoverage): boolean {
  return [coverage.longTermMemory, coverage.recentConversation, coverage.summary].every(
    (reading) => reading.outcome === 'provided' || reading.outcome === 'empty'
  )
}

/** 程序生成状态行的 header。它让"这一行是代码写的"在 prompt 里可辨认 */
export const MEMORY_RECORD_STATUS_HEADER = '记录状态（程序生成）：'

/**
 * 状态行**自己的额度**（token）。
 *
 * 取 220 的理由（M6.1 WP5 起，用户裁定"三来源分列"之后**上修**）：
 * 最长的一种渲染是 header + 逐来源三行 + 9 条原因 + 计数，
 * 而**分列**之后固定多了两行（最近对话 / 摘要，各约 20–30 字符）。
 * 原有 120 是按"单来源 + 最多 2–3 条原因、60–160 字符"定的；
 * 分列形态实测在 120–260 字符（≈60–130 token）⇒ 取 220 覆盖真实形态并留余量，
 * 同时足够小到"被裁"这件事本身仍是可测的（见 L1 的三态用例：
 * 部分裁剪 / 整段裁剪 / 状态行未入模）。
 *
 * ⚠️ 它是**独立额度**（`ContextSection.budgetGroup === 'status'`），
 *    不从共享 tokenBudget 里扣 —— 否则"多一行状态"就会挤掉记忆。
 */
export const MEMORY_RECORD_STATUS_BUDGET_TOKENS = 220

/** 默认措辞（召回为空；**不得**默认升级） */
export const MEMORY_RECORD_STATUS_DEFAULT_ABSENCE =
  '本轮长期记忆召回未向最终上下文提供记录。'

/** 更广的那句（**只在** `allSourcesCovered === true` 时可用） */
export const MEMORY_RECORD_STATUS_FULL_COVERAGE_ABSENCE =
  '本轮提供的上下文中，没有可支持这段共同经历的合格记录。'

/**
 * **禁止写法**（只在程序生成的状态文本里扫）。
 *
 * ⚠️ 范围**不得**扩展成对模型回复的词形守卫 —— 那会撞 `ADR-043 DR-11`
 *    （措辞层没有启发式守卫）。这里扫的是我们**自己生成的**那一行。
 */
export const MEMORY_RECORD_STATUS_FORBIDDEN_PHRASES: readonly string[] = [
  '我不记得',
  '没有记忆',
  '你没说过',
  '你从没',
  '从未',
  '绝对没',
  '没发生过',
  '不存在的记忆',
]

function slotSentence(reason: MemoryRecordStatusReason, slots: readonly string[]): string | undefined {
  if (slots.length === 0) return undefined
  const named = slots.join('、')
  if (reason === 'ineligible:forgotten') {
    return `槽位 ${named} 的指定旧记录已按遗忘请求作废。`
  }
  if (reason === 'ineligible:superseded') {
    return `槽位 ${named} 的该旧记录已被后续记录取代。`
  }
  return undefined
}

function reasonSentence(status: MemoryRecordStatus, reason: MemoryRecordStatusReason): string | undefined {
  const detail = status.detail
  switch (reason) {
    case 'not_searched':
      return `本轮没有发起记忆检索（${
        NOT_SEARCHED_CAUSE_LABEL[detail.notSearchedCause ?? 'port_not_wired']
      }）。`
    case 'search_failed':
      return `本轮记忆召回失败（${detail.searchFailedReason ?? '未给出原因'}），不能据此判断有无记录。`
    case 'state_unknown':
      return `本轮无法确定该类记录的状态（${detail.stateUnknownReason ?? '未给出原因'}）。`
    case 'no_relevant':
      return '本轮候选记录未达到召回相关性阈值，未提供给上下文。'
    case 'dropped_by_budget':
      return `本轮有符合资格的记录，但被上下文预算裁掉了（${String(
        detail.droppedByBudgetCount
      )} 条）。`
    case 'ineligible:forgotten':
    case 'ineligible:superseded':
      return slotSentence(reason, detail.ineligibleSlots[reason] ?? [])
    case 'ineligible:unconfirmed':
      return '该记录因来源尚未确立，未作为有效依据提供。'
    case 'ineligible:orphaned':
      return '该记录因依据链不完整，未作为有效依据提供。'
  }
}

/**
 * 逐来源渲染（**每来源一行**；三件事不得合并）。
 *
 * ⚠️ **只吃程序事实**：函数签名里**没有**用户文本 / 回复文本 / 关键词 ——
 *    因此它**不可能**变成词形触发（用户 2026-09-24 的硬约束："no word-form triggers"）。
 * ⚠️ 长期记忆那一行的**原因句**沿用 `reasonSentence()` 的既有措辞，
 *    保证既有断言（如「本轮没有发起记忆检索」）继续成立。
 */
export function renderContextSourceCoverage(
  coverage: ContextSourceCoverage,
  status: MemoryRecordStatus
): string[] {
  const lines: string[] = []

  /* ---- ① 长期记忆 ---- */
  const longTerm = coverage.longTermMemory
  const ordered = MEMORY_RECORD_STATUS_REASONS.filter((reason) => status.reasons.includes(reason))
  if (longTerm.outcome === 'provided' || status.includedCount > 0) {
    lines.push(`  · ${CONTEXT_SOURCE_LABEL.longTermMemory}：本轮有 ${String(status.includedCount)} 条记录进入最终上下文。`)
  } else if (longTerm.outcome === 'not_consulted') {
    lines.push(
      `  · ${CONTEXT_SOURCE_LABEL.longTermMemory}：${reasonSentence(status, 'not_searched') ?? '本轮没有发起检索。'}`
    )
  } else if (longTerm.outcome === 'failed') {
    lines.push(
      `  · ${CONTEXT_SOURCE_LABEL.longTermMemory}：${reasonSentence(status, 'search_failed') ?? '本轮召回失败。'}`
    )
  } else if (longTerm.outcome === 'unknown') {
    lines.push(
      `  · ${CONTEXT_SOURCE_LABEL.longTermMemory}：${reasonSentence(status, 'state_unknown') ?? '本轮无法确定记录状态。'}`
    )
  } else {
    /*
     * `empty`：咨询过、没有可提供的。此时把**具名原因**逐条说清
     * （阈值没过 / 被预算裁 / 资格不合格）—— 它们与"没有记录"是不同的事实。
     * 一条原因都没有 ⇒ 退回收敛过的那一句。
     */
    const detailLines = ordered
      .map((reason) => reasonSentence(status, reason))
      .filter((sentence): sentence is string => sentence !== undefined)
    if (detailLines.length === 0) {
      lines.push(`  · ${CONTEXT_SOURCE_LABEL.longTermMemory}：${MEMORY_RECORD_STATUS_DEFAULT_ABSENCE}`)
    } else {
      for (const sentence of detailLines) {
        lines.push(`  · ${CONTEXT_SOURCE_LABEL.longTermMemory}：${sentence}`)
      }
      if (status.includedCount > 0) {
        lines.push(`  · ${CONTEXT_SOURCE_LABEL.longTermMemory}：本轮另有 ${String(status.includedCount)} 条记录进入最终上下文。`)
      }
    }
  }

  /* ---- ② 最近对话 ---- */
  const recent = coverage.recentConversation
  if (recent.outcome === 'provided') {
    lines.push(`  · ${CONTEXT_SOURCE_LABEL.recentConversation}：本轮有 ${String(recent.included)} 轮对话进入最终上下文。`)
  } else if (recent.outcome === 'empty') {
    lines.push(`  · ${CONTEXT_SOURCE_LABEL.recentConversation}：本轮没有对话进入最终上下文。`)
  } else if (recent.outcome === 'failed' || recent.outcome === 'unknown') {
    lines.push(
      `  · ${CONTEXT_SOURCE_LABEL.recentConversation}：${
        recent.outcome === 'failed' ? '无法读取' : '状态不可用'
      }（${recent.reason ?? '未给出原因'}），不能据此判断有没有对话。`
    )
  } else {
    lines.push(`  · ${CONTEXT_SOURCE_LABEL.recentConversation}：本轮没有咨询最近对话（${recent.reason ?? '未给出原因'}）。`)
  }

  /* ---- ③ 摘要 ---- */
  const summary = coverage.summary
  if (summary.outcome === 'provided') {
    lines.push(
      `  · ${CONTEXT_SOURCE_LABEL.summary}：本轮有 ${String(summary.included)} 段摘录进入最终上下文。`
    )
  } else if (summary.outcome === 'empty') {
    lines.push(`  · ${CONTEXT_SOURCE_LABEL.summary}：本轮没有摘录进入最终上下文。`)
  } else if (summary.outcome === 'failed' || summary.outcome === 'unknown') {
    lines.push(
      `  · ${CONTEXT_SOURCE_LABEL.summary}：${summary.outcome === 'failed' ? '读取失败' : '状态不可用'}（${
        summary.reason ?? '未给出原因'
      }），不能据此判断有没有摘录。`
    )
  } else {
    lines.push(`  · ${CONTEXT_SOURCE_LABEL.summary}：本轮没有咨询摘要（${summary.reason ?? '未给出原因'}）。`)
  }

  return lines
}

/**
 * 渲染记录状态行。
 *
 * 返回值语义（**三态都真实存在**）：
 *   · `string`    —— 生成了状态行
 *   · `undefined` —— 这一轮**没有要说的事**（且入模数量为 0 的情形也不成立）
 *
 * ⚠️ 有内容进上下文、且**没有任何**负面原因时返回 `undefined`：
 *    那时记忆 section 自己就带着内容，再加一行"状态"只是噪声
 *    （而且会让**每一轮**的 prompt 都变长）。
 * ⚠️ 召回为空且没有其他原因时**必须**返回默认那句 —— 那正是 R-2 要修的场景。
 * ⚠️ 传了 `options.sources` 时，正文改成**逐来源**那三行（长期记忆 / 最近对话 / 摘要）——
 *    这是 M6.1 WP5 发现① 的修复：单一那句没有说清"另外两个来源有没有东西"。
 */
export function renderMemoryRecordStatus(
  status: MemoryRecordStatus,
  options: MemoryRecordStatusRenderOptions = {}
): string | undefined {
  const ordered = MEMORY_RECORD_STATUS_REASONS.filter((reason) =>
    status.reasons.includes(reason)
  )

  /*
   * "更广那句"的前提：程序真的覆盖了全部来源。
   * ⚠️ 传了 `sources` 时以**覆盖率读数**为准（调用方给的布尔不足以作数）——
   *    否则一个过时的 `true` 就能把措辞升级，而那正是"替用户断言世界"。
   */
  const covered =
    options.allSourcesCovered === true &&
    (options.sources === undefined || allSourcesKnown(options.sources))

  if (options.sources !== undefined) {
    /* 有内容进上下文、且没有任何负面原因 ⇒ 不产状态行（与旧行为一致，避免噪声） */
    if (ordered.length === 0 && status.includedCount > 0) return undefined
    /*
     * 逐来源三行**总是**产出（长期记忆 / 最近对话 / 摘要）——
     * 发现① 的场景正是"长期记忆为空"的时候，而那时她必须同时看见
     * "最近对话有多少轮进来了 / 摘要有没有进来"，否则那一行会被读成"我们之间什么都没有"。
     */
    const lines = [MEMORY_RECORD_STATUS_HEADER, ...renderContextSourceCoverage(options.sources, status)]
    if (ordered.length === 0 && status.includedCount === 0 && covered) {
      lines.push(`  · ${MEMORY_RECORD_STATUS_FULL_COVERAGE_ABSENCE}`)
    }
    return lines.join('\n')
  }

  if (ordered.length === 0) {
    if (status.includedCount > 0) return undefined
    return covered ? MEMORY_RECORD_STATUS_FULL_COVERAGE_ABSENCE : MEMORY_RECORD_STATUS_DEFAULT_ABSENCE
  }

  const lines: string[] = [MEMORY_RECORD_STATUS_HEADER]
  for (const reason of ordered) {
    const sentence = reasonSentence(status, reason)
    if (sentence === undefined) continue
    lines.push(`  · ${sentence}`)
  }
  if (status.includedCount > 0) {
    lines.push(`  · 本轮另有 ${String(status.includedCount)} 条长期记忆进入最终上下文。`)
  }

  /*
   * 所有原因都因为没有具名槽位而渲染不出来（例如只有 `ineligible:forgotten`
   * 却拿不到槽位）⇒ **不产出**一个只有 header 的空壳。
   * "说不出具名指称" 与 "说出来了" 必须不同；宁可退回"没有状态行"。
   */
  if (lines.length === 1) return undefined

  return lines.join('\n')
}

/** 程序生成的状态文本里有没有**禁止写法**（机器判据；只扫这一行） */
export function forbiddenPhrasesInStatusText(text: string): string[] {
  return MEMORY_RECORD_STATUS_FORBIDDEN_PHRASES.filter((phrase) => text.includes(phrase))
}
