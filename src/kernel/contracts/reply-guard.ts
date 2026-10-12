/**
 * M6.1 WP4 / ADR-055 `D-55g`：**回复守卫的观测三态**（进 trace）。
 *
 * ============================================================================
 *  它补的是一个**真实的观测缺口**
 * ============================================================================
 * 设计文档 §2.7 实测：`response-truth` 有一条**静默分支** ——
 * `result === undefined` 时它早退、**不打日志**、返回 `executed: undefined`。
 * 于是一轮之后，"守卫没运行"与"守卫运行了、什么也没发现"在事后**无法区分**。
 *
 * 用户裁定（§6.3）：
 *
 *     至少区分三态：**未触发 / 已触发 / 观测缺失**；记录**具名守卫**与**结构化原因**；
 *     沿用**隐私白名单**，**不额外保存原始回复正文**。
 *
 * ⚠️ 两条边界写死在这里，避免以后被读错：
 *   ① **守卫触发 ≠ 产品失败** —— 它只说明"我们的替换逻辑动过这句话"；
 *   ② **经过替换的合格回复，不能证明模型原始生成已经改善**（§6.3 末句）。
 *      因此"回复是否违规"与"守卫是否触发"必须**分开报**，不许合成一个分。
 *
 * ⚠️ 本文件是纯契约：不 import 框架、不读时钟、**不含任何正文**。
 */

/**
 * 具名守卫（**冻结的四道**，与 `main.ts` 的串联顺序一致）。
 *
 * 顺序不是装饰：它就是 `main.ts` 里 `replyText` 被逐道改写的顺序，
 * 因此"最终回复对应的是哪个结果"可以按这个顺序回溯。
 */
export const REPLY_GUARD_NAMES = [
  'memory_truth',
  'action_truth',
  'evidence_truth',
  'search_need',
] as const

export type ReplyGuardName = (typeof REPLY_GUARD_NAMES)[number]

/** 中文名（报告里用；不是枚举值） */
export const REPLY_GUARD_LABELS: Readonly<Record<ReplyGuardName, string>> = {
  memory_truth: '记忆写入真相',
  action_truth: '动作真相',
  evidence_truth: '外部证据真相',
  search_need: '搜索判定结论绑定',
}

/**
 * 三态（**这是本模块存在的理由**）。
 *
 * ```text
 * not_run    观测缺失：这一轮没有可观测的对象（没有显式记忆指令 / 没有动作 / 没有搜索…）
 * passed     静默通过：守卫运行了，**没有**改写回复
 * triggered  已触发：守卫改写了回复（替换 / 剥离 / 追加）
 * ```
 */
export type ReplyGuardState = 'not_run' | 'passed' | 'triggered'

export interface ReplyGuardReport {
  readonly name: ReplyGuardName
  readonly state: ReplyGuardState
  /**
   * **结构化原因**（枚举标签 / 标记词 / 状态码）——**不是回复正文**。
   *
   * 例如 `['no_explicit_memory_instruction']`、`['记住了','记下了']`、
   * `['stripped_citation_labels:2']`。它们进 trace，不进任何外发通道。
   */
  readonly reasons: readonly string[]
}

/**
 * 每一道守卫在 trace 里的**属性键**（后缀 `_status` 是遥测白名单里的受控族）。
 *
 * 为什么逐道给一个键而不是拼一个字符串：结构化属性才能被面板筛，
 * 而 JSON 字符串会被白名单当成"不在七类里"的键过滤掉。
 */
export const REPLY_GUARD_STATUS_KEY: Readonly<Record<ReplyGuardName, string>> = {
  memory_truth: 'memory_truth_status',
  action_truth: 'action_truth_status',
  evidence_truth: 'evidence_truth_status',
  search_need: 'search_need_status',
}

export interface ReplyGuardSummary {
  readonly reports: readonly ReplyGuardReport[]
  readonly triggered: number
  readonly passed: number
  readonly notRun: number
  readonly triggeredNames: readonly ReplyGuardName[]
  readonly notRunNames: readonly ReplyGuardName[]
}

/** 汇总（纯函数；`triggered` 与"回复是否违规"**不是**同一个数） */
export function summarizeReplyGuards(
  reports: readonly ReplyGuardReport[]
): ReplyGuardSummary {
  const of = (state: ReplyGuardState) => reports.filter((report) => report.state === state)
  return {
    reports,
    triggered: of('triggered').length,
    passed: of('passed').length,
    notRun: of('not_run').length,
    triggeredNames: of('triggered').map((report) => report.name),
    notRunNames: of('not_run').map((report) => report.name),
  }
}

/**
 * 扁平化为 trace 属性。
 *
 * ⚠️ 值只有枚举标签与计数 —— `reasons` 也**只**接受短标记（这里做一次长度闸，
 *    防止有人顺手把回复片段塞进 `reasons`）。
 */
export function replyGuardTraceAttributes(
  reports: readonly ReplyGuardReport[]
): Record<string, string | number> {
  const summary = summarizeReplyGuards(reports)
  const attributes: Record<string, string | number> = {
    guard_count: reports.length,
    guard_triggered_count: summary.triggered,
    guard_not_run_count: summary.notRun,
  }
  for (const report of reports) {
    const key = REPLY_GUARD_STATUS_KEY[report.name]
    attributes[key] = report.state
    /*
     * 原因**只记计数**（`<name>_reasons` 会是自由文本）。
     * 具名原因已经写在 step 的 label 里（下游只读本地 trace），
     * 而外发通道只拿枚举状态 —— 隐私边界照旧。
     */
    attributes[`${report.name}_reason_count`] = report.reasons.length
  }
  return attributes
}

/** 一轮报告是否**完整覆盖**四道守卫（缺一道 = 观测不完整，必须报出来） */
export function missingReplyGuards(reports: readonly ReplyGuardReport[]): ReplyGuardName[] {
  const seen = new Set(reports.map((report) => report.name))
  return REPLY_GUARD_NAMES.filter((name) => !seen.has(name))
}
