/**
 * M10.1 WP4a —— **约定与结清的事实块**（纯函数；程序渲染）。
 *
 * ============================================================================
 *  它解决什么（R-26 的修法核心）
 * ============================================================================
 * ```text
 * 实测（R-26）：她在**窗口里**反复提同一件事，而"用户明确结清"压不过它 ——
 * 因为窗口里她的历史提及有 2–4 句，**一句用户话压不过"证据量"**。
 * ⇒ 能压过历史锚的只有**程序事实**：把"这条约定已经结清了"当作**事实**说出来。
 *
 * 因此本块按承诺的**当前状态**渲染：
 *   · **未结清** ⇒ 列出它（她可以正常提）
 *   · **已结清 / 已取消 / 已过期** ⇒ 「…**不要再提**」
 * ```
 *
 * ============================================================================
 *  三条纪律
 * ============================================================================
 * ```text
 * ① **程序渲染**：正文只由本模块的模板拼出（没有模型参与、没有自由文本）。
 * ② **到期档不含指控**：`expired` 的措辞是"**时间到了**"，**不是**"你没做到"
 *    （与 `COMMITMENT_EXPIRED` 的语义一致：到期 ≠ 失约）。
 * ③ **失败关闭**：额度连"块头 + 结清行"都放不下 ⇒ **整块不渲染**
 *    （不印半条边界 —— 与 M11 的 `adaptive-self` 块同一手法）。
 * ```
 *
 * ⚠️ 纯函数：不 import SQL / 框架 / `node:*`，不读时钟（`now` 由调用方给），无副作用。
 */

import { SECTION_PRIORITY, type ContextSection, type ContextSectionProvider } from '../../contracts/context.ts'
import type { CommitmentStatus, GoalRowState, GoalSuccessCriterion } from '../../contracts/goal.ts'

/** 块头（程序文本，不是模型输出） */
export const COMMITMENT_BLOCK_HEADER = '【约定与结清（程序事实）】'

/** section id（稳定；trace 与 packet 对账靠它） */
export const COMMITMENT_SECTION_ID = 'commitment-state'

/** 「不要再提」的**唯一**措辞（判据据此断言；改它 = 改语义） */
export const COMMITMENT_DO_NOT_RAISE = '不要再提'

/**
 * **终态行不复述内容**的标记（`L-M10.1-15` 的修法，2026-10-02）。
 *
 * ```text
 * 实测（`A11`）：把已结清那件事**连着内容一起**摆在她面前，**没有**降低她再提的轮数，
 * 方向上反而更多（档 A 2/10 · 档 B 0–1/10）—— 与 R-26 同族：**那条事实本身就是"再启动"锚**。
 * ⇒ 终态档改成**计数式陈述**：只说她"有几条已结清的约定"，**不再列出内容**。
 * ```
 */
export const COMMITMENT_CLOSED_CONTENT_OMITTED = '内容从略'

/** 判据种类的**人话**说法（闭集 → 固定句子） */
export const COMMITMENT_CRITERION_LABELS: Readonly<Record<GoalSuccessCriterion['kind'], string>> = {
  user_report: '由对方报告确认',
  conversation_output: '她给出的对话产物可核对',
  action_result: '动作真实执行成功',
}

/** 渲染输入的一行（调用方从投影读出） */
export interface CommitmentFactRow {
  readonly goalId: string
  /** 承诺范围（有界；调用方已裁剪） */
  readonly scope: string
  readonly status: CommitmentStatus
  readonly criterionKind: GoalSuccessCriterion['kind']
  /** 目标的截止时间（可选 —— 今天没有生产来源，见 `U-04`） */
  readonly dueAt?: number
}

export interface RenderCommitmentStateBlockInput {
  readonly rows: readonly CommitmentFactRow[]
  /** 注入额度（token）；**缺省 0 = 不注入** */
  readonly maxTokens: number
  readonly quantify: (text: string) => number
  /** 排序键（可选）：让同一批行稳定输出 */
  readonly now?: number
}

/** 终态集合（闭集；与 `COMMITMENT_TERMINAL_STATUSES` 同源，这里只用于**措辞分档**） */
const CLOSED_STATUSES: readonly CommitmentStatus[] = ['fulfilled', 'cancelled', 'superseded', 'expired']

/**
 * 终态档的**计数式**说法（`L-M10.1-15` 的修法）。
 *
 * ⚠️ 三条不许丢的性质：
 * ```text
 * ① 仍含「已结清」/「已取消」/「已被替代」/「已过期」与「不要再提」（判据据此断言）；
 * ② 到期档仍含「时间到了」（`D07`：**不含指控** —— 到期 ≠ 失约）；
 * ③ **不含内容**：`scope` 一个字都不出现（否则又把那件事摆出来了）。
 * ```
 */
const CLOSED_STATUS_LABELS: Readonly<Record<string, { readonly label: string; readonly note: string }>> = {
  fulfilled: { label: '已结清', note: '' },
  cancelled: { label: '已取消', note: '' },
  superseded: { label: '已被替代', note: '' },
  expired: { label: '已过期', note: '时间到了；' },
}
/** 固定顺序（同一批行稳定输出；与 `CLOSED_STATUSES` 一致） */
const CLOSED_LINE_ORDER: readonly CommitmentStatus[] = ['fulfilled', 'cancelled', 'superseded', 'expired']

function closedLineOf(status: CommitmentStatus, count: number): string {
  const spec = CLOSED_STATUS_LABELS[status] ?? { label: '已经是终态', note: '' }
  return `- 有 ${count} 条约定${spec.label}（${spec.note}${COMMITMENT_CLOSED_CONTENT_OMITTED}），${COMMITMENT_DO_NOT_RAISE}。`
}

function lineOf(row: CommitmentFactRow): string {
  /* 终态行（含到期）不在这里出单行 —— 它们由 `closedLineOf` 按状态**合并计数** */
  const due =
    row.dueAt === undefined
      ? '没有截止时间'
      : `截止 ${new Date(row.dueAt).toISOString()}`
  return `- 未结清的约定：「${row.scope}」；判据：${COMMITMENT_CRITERION_LABELS[row.criterionKind]}；${due}。`
}

/**
 * 渲染事实块。
 *
 * ⚠️ 顺序：**终态行在前**（它们是"不要再提"的那部分，优先保住），未结清行在后。
 * ⚠️ `L-M10.1-15` 的修法（2026-10-02）：终态行按状态**合并成计数式陈述**，**不复述内容** ——
 *    实测把内容一起摆出来**不会**降低她再提的概率（档 A 反而更多）。
 */
export function renderCommitmentStateBlock(
  input: RenderCommitmentStateBlockInput,
): readonly ContextSection[] {
  if (input.maxTokens <= 0) return []
  if (input.rows.length === 0) return []

  const closed = input.rows.filter((row) => CLOSED_STATUSES.includes(row.status))
  const pending = input.rows.filter((row) => !CLOSED_STATUSES.includes(row.status))
  /* 终态行的**行文本**：一个状态一行（带计数）；来源账仍逐条留 */
  const closedLines = CLOSED_LINE_ORDER.flatMap((status) => {
    const count = closed.filter((row) => row.status === status).length
    return count === 0 ? [] : [closedLineOf(status, count)]
  })
  const lines: string[] = [COMMITMENT_BLOCK_HEADER]
  let spent = input.quantify(`${COMMITMENT_BLOCK_HEADER}\n`)
  const sourceRefs: string[] = []
  /* ⚠️ 终态行**整组同生同死**（计数式陈述少一条计数就会说谎 ⇒ 放不下就整组不印） */
  for (const line of closedLines) {
    const cost = input.quantify(`${line}\n`)
    if (spent + cost > input.maxTokens) {
      if (lines.length === 1) return []
      break
    }
    lines.push(line)
    spent += cost
  }
  for (const row of closed) sourceRefs.push(`commitment:${row.goalId}`)
  if (closed.length > 0 && lines.length === 1) {
    /*
     * ⚠️ 失败关闭：**有终态行、但它们的计数一条都放不下** ⇒ 整块不渲染。
     *    （计数式陈述是"不要再提"的唯一载体 ⇒ 印不出它就没有理由印这块 —— 与 M11 同手法。）
     * ⚠️ **只有未结清行**时不走这一支（那不是"印不出不要再提"，而是本来就没有终态）。
     */
    return []
  }
  for (const row of pending) {
    const line = lineOf(row)
    const cost = input.quantify(`${line}\n`)
    if (spent + cost > input.maxTokens) break
    lines.push(line)
    sourceRefs.push(`commitment:${row.goalId}`)
    spent += cost
  }

  return [
    {
      id: COMMITMENT_SECTION_ID,
      /*
       * ⚠️ kind 用 `'goals'`（**目标域**）而不是新造一个 —— `ContextSectionKind` 是**闭集**，
       *    而 M5/M10 的门对它有判据；承诺本来就属于目标域。
       *    这一块与 `goal-state` 的区分靠 **`id`**（`commitment-state`），不靠 kind。
       */
      kind: 'goals',
      priority: SECTION_PRIORITY.criticalState,
      content: lines.join('\n'),
      sourceRefs,
      droppable: true,
    },
  ]
}

/**
 * 从投影行映射出事实行（**只读**；`commitment === null` 的行跳过）。
 *
 * ⚠️ 这一层刻意薄：它不判断"该不该提"，只把**程序已存的**状态搬成渲染输入。
 */
export function commitmentFactRowsOf(rows: readonly GoalRowState[]): readonly CommitmentFactRow[] {
  const out: CommitmentFactRow[] = []
  for (const row of rows) {
    const commitment = row.commitment
    if (commitment === null) continue
    out.push({
      goalId: String(row.goal.goalId),
      scope: commitment.scope,
      status: commitment.status,
      criterionKind: commitment.criterion.kind,
      ...(row.goal.time?.dueAt === undefined ? {} : { dueAt: row.goal.time.dueAt }),
    })
  }
  return out
}

export interface CommitmentStateProviderOptions {
  /** 读当前行（**异步**：调用方从投影读；只读） */
  readonly rows: () => Promise<readonly CommitmentFactRow[]>
  /** 注入额度（来自**那一个** `ContextBudget.commitmentTokens`；`D27` 禁止影子默认） */
  readonly maxTokens: number
  readonly quantify: (text: string) => number
}

/**
 * 包装成上下文 provider（**网关唯一的接入点**）。
 *
 * ⚠️ **额度 0 ⇒ 连行都不读**：这样"关闭档的 prompt 与基线逐字节相同"不依赖裁剪逻辑
 *    （与 M10 的 `goal-state` provider 同一手法）。
 */
export function createCommitmentStateProvider(
  options: CommitmentStateProviderOptions,
): ContextSectionProvider {
  return {
    name: COMMITMENT_SECTION_ID,
    async provide(): Promise<ContextSection[]> {
      if (options.maxTokens <= 0) return []
      const rows = await options.rows()
      return [...renderCommitmentStateBlock({ rows, maxTokens: options.maxTokens, quantify: options.quantify })]
    },
  }
}
