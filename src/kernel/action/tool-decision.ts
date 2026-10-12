/**
 * ToolDecision —— **角色自行选择工具**的受限提案契约与严格解析（WP1）。
 *
 * ============================================================================
 *  载体
 * ============================================================================
 * `docs/post-lv2/Role-Tool-Decision-Plan-2026-10-05.md` §6 WP1 · 设计裁定
 * [`ADR-104`](../../../docs/adr/ADR-104-role-tool-decision.md)。
 *
 * ============================================================================
 *  它只做三件事，而且**每一件都复用已有的那一份权威**
 * ============================================================================
 * ```text
 * ① 闭集分支        answer（直接回答）| clarify（问一句）| tools（提议工具步骤）
 * ② 严格解析        多一个字段 / 未知枚举 / 空计划 ⇒ **整条作废**（失败关闭）
 * ③ tools 分支      直接把 `{goal,steps,done}` 交给**既有** `validateTaskPlan`
 *                   ⇒ 能力∈授权集合、操作∈登记表、参数∈`TASK_ARG_KEYS` 闭集，
 *                     全部由 M4.5/第二批那条**唯一**的校验器回答
 * ```
 * ⚠️ **刻意不在这里写第二份参数白名单 / 第二份能力校验**：
 *    两份判据迟早分叉，而分叉的那天就是"模型能让程序做它没打算做的事"的那天
 *    （先例：`task-plan.ts` 文件头那句"计划是执行指令，不是建议"）。
 *
 * ============================================================================
 *  它**不做**什么
 * ============================================================================
 * ```text
 * · 不调模型（端口在装配层接；测试注入 fixture）
 * · 不读环境、不读开关（"这一轮允许哪些能力"由调用方给）
 * · 不判权限、不落账、不执行（提案 ≠ 权限，ADR-030 / ADR-104 D05）
 * ```
 */

import { KernelError } from '../contracts/ids.ts'
import type { CapabilityRegistry } from './capability-registry.ts'
import {
  TASK_PLAN_PARSE_CODES,
  validateTaskPlan,
  type TaskPlan,
  type TaskPlanParseCode,
} from './task-plan.ts'

// ---------------------------------------------------------------------------
// 分支（闭集）
// ---------------------------------------------------------------------------

export const TOOL_DECISION_BRANCHES = ['answer', 'clarify', 'tools'] as const
export type ToolDecisionBranch = (typeof TOOL_DECISION_BRANCHES)[number]

/**
 * **工具决策模式**（装配层开关的取值闭集）。
 *
 * ```text
 * rules  今天的全部行为：词形检测器决定"要不要动作"（**代码缺省**）
 * role   角色模型提议：一轮至多一次决策调用，提案经本文件严格解析
 * ```
 * ⚠️ 缺省是 `rules` 而不是 `role`：新模式改变的是"谁能决定动手"，
 *    而按 ADR-048 以来的先例，这类改变**必须**由独立激活裁定放行
 *    （先例 ADR-065/067/069/071/082/094/095/097/099/100/103）。
 * ⚠️ 非法值 ⇒ `rules`（失败关闭方向：宁可回到今天的行为，不可"猜一个模式"）。
 */
export const TOOL_DECISION_MODES = ['rules', 'role'] as const
export type ToolDecisionMode = (typeof TOOL_DECISION_MODES)[number]

export function isToolDecisionMode(value: unknown): value is ToolDecisionMode {
  return typeof value === 'string' && (TOOL_DECISION_MODES as readonly string[]).includes(value)
}

/** `clarify` 的问句上界（码点）。有界是必要的：这段文本会进下一轮 prompt。 */
export const TOOL_DECISION_MAX_QUESTION_CODEPOINTS = 200

export interface ToolDecisionProposal {
  readonly branch: ToolDecisionBranch
  /** `clarify` 分支：要问对方的那一句话（**程序**决定怎么呈现它） */
  readonly question?: string
  /**
   * `tools` 分支：**就是** `TaskPlan`（`goal` / `steps` / `done` 三个字段）。
   *
   * ⚠️ 刻意复用这个形状而不是另立一个：执行环吃的是 `TaskPlan`，
   *    而"提案 → 执行"之间**不该**有一次形状转换（转换点就是漏判点）。
   */
  readonly plan?: TaskPlan
}

// ---------------------------------------------------------------------------
// 解析（失败关闭）
// ---------------------------------------------------------------------------

/**
 * 解析失败的**闭集码**。
 *
 * ⚠️ 它 = 本层的码 **∪** `TASK_PLAN_PARSE_CODES`（**并进来**，不复制）。
 *    理由是实测逼出来的（2026-10-05 WP1 第一次跑本门）：
 *    `tools` 分支的越权/非法参数失败是 `validateTaskPlan` 抛的，
 *    如果只认本层的码，那些失败会被报成"未知解析失败" ——
 *    那等于把"模型越权"与"模型没按格式答"混成一件事（诊断立刻失效）。
 *    引进来而不是抄一份，是因为抄一份就会漂移。
 */
export const TOOL_DECISION_PARSE_CODES = [
  'tool_decision_empty',
  'tool_decision_no_json_object',
  'tool_decision_bad_json',
  'tool_decision_not_object',
  'tool_decision_unknown_field',
  'tool_decision_bad_branch',
  'tool_decision_answer_has_payload',
  'tool_decision_clarify_missing_question',
  'tool_decision_clarify_question_too_long',
  'tool_decision_tools_missing_plan',
  'tool_decision_unknown_parse_failure',
  ...TASK_PLAN_PARSE_CODES,
] as const
export type ToolDecisionParseCode =
  | (typeof TOOL_DECISION_PARSE_CODES)[number]
  | TaskPlanParseCode

export function toSafeToolDecisionParseCode(error: unknown): ToolDecisionParseCode {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && (TOOL_DECISION_PARSE_CODES as readonly string[]).includes(code)
    ? (code as ToolDecisionParseCode)
    : 'tool_decision_unknown_parse_failure'
}

/** 闭集字段：`branch` + `clarify` 的 `question` + `tools` 的三个计划字段 */
const DECISION_FIELDS = new Set(['branch', 'question', 'goal', 'steps', 'done'])
/** `tools` 分支必须整份出现的那三个字段（= `TaskPlan` 的字段集） */
const PLAN_FIELDS: readonly string[] = ['goal', 'steps', 'done']

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 从模型输出里取出那个 JSON 对象（容忍围栏与前后少量文字，其余失败关闭） */
export function extractToolDecisionJson(raw: string): unknown {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new KernelError('validation_error', 'tool_decision_empty', '决策器返回了空内容')
  }
  const withoutFence = raw
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim()
  const start = withoutFence.indexOf('{')
  const end = withoutFence.lastIndexOf('}')
  if (start < 0 || end <= start) {
    throw new KernelError(
      'validation_error',
      'tool_decision_no_json_object',
      '决策器输出里找不到一个 JSON 对象'
    )
  }
  try {
    return JSON.parse(withoutFence.slice(start, end + 1))
  } catch {
    throw new KernelError('validation_error', 'tool_decision_bad_json', '决策器输出的 JSON 解析失败')
  }
}

/**
 * 校验一份提案（纯函数，失败关闭）。
 *
 * 判据顺序与理由：
 * ```text
 * ① 必须是对象、字段必须全部在闭集里          —— 没有"宽容解释"这一档
 * ② `branch` 必须是闭集里的一个              —— 未知分支 ⇒ 没有行为
 * ③ `answer` 不许带任何载荷                   —— 否则"直接回答"也能夹带一个计划
 * ④ `clarify` 必须有界问句、不许带计划         —— 澄清与执行是两件事
 * ⑤ `tools` 必须带**完整的** `{goal,steps,done}` ⇒ 交给 `validateTaskPlan`
 * ```
 * ⚠️ 第 ⑤ 条是**唯一**校验"能力/操作/参数"的地方 —— 本文件不重复那套判据。
 */
export function validateToolDecisionProposal(
  value: unknown,
  options: { registry: CapabilityRegistry; allowedCapabilities: readonly string[] }
): ToolDecisionProposal {
  if (!isPlainObject(value)) {
    throw new KernelError('validation_error', 'tool_decision_not_object', '提案必须是一个 JSON 对象')
  }
  for (const key of Object.keys(value)) {
    if (!DECISION_FIELDS.has(key)) {
      throw new KernelError(
        'validation_error',
        'tool_decision_unknown_field',
        `提案里有未知字段：${key}`
      )
    }
  }
  const branch = value.branch
  if (typeof branch !== 'string' || !(TOOL_DECISION_BRANCHES as readonly string[]).includes(branch)) {
    throw new KernelError(
      'validation_error',
      'tool_decision_bad_branch',
      `branch 必须是 ${TOOL_DECISION_BRANCHES.join(' | ')} 之一`
    )
  }

  if (branch === 'answer') {
    for (const field of [...PLAN_FIELDS, 'question']) {
      if (value[field] !== undefined) {
        throw new KernelError(
          'validation_error',
          'tool_decision_answer_has_payload',
          `branch=answer 不许带 ${field}`
        )
      }
    }
    return { branch: 'answer' }
  }

  if (branch === 'clarify') {
    for (const field of PLAN_FIELDS) {
      if (value[field] !== undefined) {
        throw new KernelError(
          'validation_error',
          'tool_decision_clarify_missing_question',
          `branch=clarify 不许带 ${field}`
        )
      }
    }
    const question = value.question
    if (typeof question !== 'string' || question.trim() === '') {
      throw new KernelError(
        'validation_error',
        'tool_decision_clarify_missing_question',
        'branch=clarify 必须有非空 question'
      )
    }
    if ([...question].length > TOOL_DECISION_MAX_QUESTION_CODEPOINTS) {
      throw new KernelError(
        'validation_error',
        'tool_decision_clarify_question_too_long',
        `question 超过 ${String(TOOL_DECISION_MAX_QUESTION_CODEPOINTS)} 码点`
      )
    }
    return { branch: 'clarify', question: question.trim() }
  }

  // branch === 'tools'
  if (value.question !== undefined) {
    throw new KernelError('validation_error', 'tool_decision_tools_missing_plan', 'branch=tools 不许带 question')
  }
  const missing = PLAN_FIELDS.filter((field) => value[field] === undefined)
  if (missing.length > 0) {
    throw new KernelError(
      'validation_error',
      'tool_decision_tools_missing_plan',
      `branch=tools 必须带完整的计划字段，缺：${missing.join(', ')}`
    )
  }
  const plan = validateTaskPlan(
    { goal: value.goal, steps: value.steps, done: value.done },
    { registry: options.registry, allowedCapabilities: options.allowedCapabilities }
  )
  return { branch: 'tools', plan }
}

/** 解析 + 校验（与 `parseTaskPlan` 同形：先取 JSON，再走同一套校验） */
export function parseToolDecisionProposal(
  raw: string,
  options: { registry: CapabilityRegistry; allowedCapabilities: readonly string[] }
): ToolDecisionProposal {
  return validateToolDecisionProposal(extractToolDecisionJson(raw), options)
}

// ---------------------------------------------------------------------------
// 提案 → 动作（**纯映射**，让"零动作"这件事可以被离线判定）
// ---------------------------------------------------------------------------

/**
 * 一次提案最终产生什么。
 *
 * ```text
 * answer / clarify        ⇒ **零动作**（no_action）—— 这是可判定的，不是"应该不会"
 * tools 且 steps 为空      ⇒ **零动作**（模型说"要用工具"却给了空计划 ⇒ 没有要执行的）
 * tools 且 steps 非空      ⇒ 交给既有执行环
 * ```
 * ⚠️ 它**不**做权限判定、**不**落账：那是 Gateway 的事。
 *    这里只回答"这份提案会不会产生动作请求"—— 因为"非法提案拒绝且零动作"
 *    是 WP1 的验收条件之一（计划书 §6 WP1 逐字），而它必须能被**离线**判定。
 */
export type ToolDecisionAction =
  | { readonly kind: 'no_action'; readonly reason: 'answered' | 'clarified' | 'empty_plan' }
  | { readonly kind: 'tools'; readonly plan: TaskPlan }

export function actionOfToolDecision(proposal: ToolDecisionProposal): ToolDecisionAction {
  if (proposal.branch === 'answer') return { kind: 'no_action', reason: 'answered' }
  if (proposal.branch === 'clarify') return { kind: 'no_action', reason: 'clarified' }
  const plan = proposal.plan
  if (plan === undefined || plan.steps.length === 0) {
    return { kind: 'no_action', reason: 'empty_plan' }
  }
  return { kind: 'tools', plan }
}

// ---------------------------------------------------------------------------
// 端口
// ---------------------------------------------------------------------------

export const TOOL_DECISION_FAILURES = ['timeout', 'call_failed', 'invalid_output'] as const
export type ToolDecisionFailure = (typeof TOOL_DECISION_FAILURES)[number]

export interface ToolDecisionInput {
  /** 本轮用户原话（**逐字**；触发仍是这条原用户事件，ADR-104 D06） */
  readonly text: string
  /**
   * 有界的最近对话行（**已经过撤销遮蔽**；由轮次层给，取不到就是空数组）。
   *
   * ⚠️ 它是"角色上下文"在本阶段能拿到的那一部分：完整的 `ContextPacket` 在
   *    **动作之后**才编译（ADR-030/033 的顺序），因此这里看不到 DB 派生的 section。
   *    这是**已知边界**，如实登记（ADR-104 D08 · `L-RTD-01`）。
   */
  readonly recentLines: readonly string[]
  /** 程序生成的工具目录文本（`renderToolCatalogForModel`） */
  readonly catalog: string
  /**
   * WP2：**程序给出的已知目录事实**（已渲染；个人桌面 / 公共桌面，含重定向后的实际路径）。
   *
   * ⚠️ 缺省/空 ⇒ 决策只看得到"目录里有哪些能力"，看不到"这几个目录在哪"。
   *    它存在的理由是一条实测故障：模型会**猜** `user` / `Administrator` 去凑路径
   *    （同一个 trace 里两次猜错 ⇒ 规划永远收敛不了）。
   */
  readonly knownDirectories?: readonly string[]
  /** 这一轮**真的**允许的能力（装配层按开关算；模型不能扩大它） */
  readonly allowedCapabilities: readonly string[]
  /** 本会话是否已有一份仍然有效的任务授权（第二轮的提案会接在它后面） */
  readonly hasOpenTask: boolean
  /** 本会话是否还有任务预算（没有预算就不该提议工具） */
  readonly taskBudgetAvailable: boolean
  readonly signal?: AbortSignal
}

export interface ToolDecisionOutcomeOk {
  readonly ok: true
  /**
   * **原始**对象（模型给的那一份，可能是一个字符串 —— 它"不是 JSON"也是一种如实结果）。
   *
   * ⚠️ 端口**不做**校验：严格校验只有本文件那一处（与目标理解同一条分工：
   *    provider 负责"怎么问、怎么收"，内核负责"收上来的东西合不合法"）。
   */
  readonly raw: unknown
  readonly requestCount: number
}
export interface ToolDecisionOutcomeFail {
  readonly ok: false
  readonly failure: ToolDecisionFailure
  readonly requestCount: number
}
export type ToolDecisionOutcome = ToolDecisionOutcomeOk | ToolDecisionOutcomeFail

/** 一次决策的**最终读数**（含校验结论）—— 调用方只需要看这一个 */
export type ToolDecisionReading =
  | { readonly ok: true; readonly proposal: ToolDecisionProposal; readonly requestCount: number }
  | {
      readonly ok: false
      readonly failure: ToolDecisionFailure
      readonly requestCount: number
      readonly parseFailureCode?: ToolDecisionParseCode
    }

/**
 * 决策器端口。
 *
 * ⚠️ 与规划器 / 判定器端口同一条纪律：**输入面只有上面那几个字段** ——
 *    人设正文、记忆正文、检索结果在类型上就进不来。
 *    决策器看到的是"对方说了什么 + 现在有什么工具"，不是"她记得什么"。
 */
export interface ToolDecisionPort {
  readonly id: string
  readonly endpointHost: string
  decide(input: ToolDecisionInput): Promise<ToolDecisionOutcome>
}

/**
 * **问一次 + 严格解析**（调用方唯一需要调用的那一个函数）。
 *
 * 三条失败各自成桶（诊断必须分得开）：
 * ```text
 * 端口抛错            ⇒ call_failed   （没有结论）
 * 端口报 timeout       ⇒ timeout      （有界时间内没答完）
 * 拿到了东西但解析不过  ⇒ invalid_output + 闭集码（**答了，但不合规**）
 * ```
 * ⚠️ 它**不重试**、**不回落关键词**：失败就是"这一轮没有工具结论"（ADR-104 D07）。
 */
export async function readToolDecision(
  port: ToolDecisionPort,
  input: ToolDecisionInput,
  options: { registry: CapabilityRegistry; allowedCapabilities: readonly string[] }
): Promise<ToolDecisionReading> {
  let outcome: ToolDecisionOutcome
  try {
    outcome = await port.decide(input)
  } catch {
    return { ok: false, failure: 'call_failed', requestCount: 0 }
  }
  if (!outcome.ok) {
    return { ok: false, failure: outcome.failure, requestCount: outcome.requestCount }
  }
  try {
    const proposal = validateToolDecisionProposal(outcome.raw, options)
    return { ok: true, proposal, requestCount: outcome.requestCount }
  } catch (error) {
    return {
      ok: false,
      failure: 'invalid_output',
      requestCount: outcome.requestCount,
      parseFailureCode: toSafeToolDecisionParseCode(error),
    }
  }
}

export function describeToolDecisionPort(port: { id: string; endpointHost: string }): string {
  return `tool decision = ${port.id} @ ${port.endpointHost}`
}
