/**
 * ActionForecast —— **行动预测的独立契约**（三域应用方案 §2 · §5）。
 *
 * ============================================================================
 *  它为什么必须是**另一个契约**，不能塞进 `TaskPlan`
 * ============================================================================
 * ```text
 * TaskPlan 是**执行指令**：capability / operation / args / purpose。
 *   它的解析是**失败关闭**的（多一个字段就整条计划作废），
 *   它的 args 走**参数白名单**，它的能力来自**授权集合**。
 *
 * ActionForecast 是**预测**：预期可见结果 / 核对条件 / 不确定性 / 依赖。
 *   它**不授权任何东西**（没有 args、没有 capability 白名单语义），
 *   它**不被执行**（程序只拿它当"这次该怎么核对"的读数）。
 * ```
 *
 * ⚠️ 把它塞进 `purpose` 或放松参数白名单 = 让"执行指令"与"预测"共用一条通道：
 *    模型就能用"预测"字段夹带参数、或者用参数字段夹带"预测"，
 *    而校验器只有一套。⇒ **两条契约、两个解析器、两个失败关闭**。
 *
 * ============================================================================
 *  三条不许破的边界
 * ============================================================================
 * ① **核对条件是闭集谓词**：由**程序**拿 `ActionResult` 机械判定。
 *    一句自然语言核对条件只能由模型自己解释 —— 那等于让被考核者给自己打分。
 * ② **预测不扩权**：预测端口拿不到授权集合、拿不到参数、拿不到执行器。
 *    它只看得见"闭集状态 + 具名失败码 + 既有内容预算允许的读回事实"。
 * ③ **不自动探索、不重试副作用、不延长任务**：预测失败或不可比，
 *    任务的**既有**行为逐字不变（只是这一轮少了一个诊断读数）。
 *
 * ⚠️ 纯类型 + 纯函数：不 import 框架 / SQL / `node:*`。
 */

import {
  validateActionForecastCheck,
  validateActionForecastStep,
  WORLD_MODEL_UNCERTAINTIES,
  type ActionForecast,
  type ActionForecastCheck,
  type ActionForecastStep,
  type ComparisonResult,
  type WorldModelUncertainty,
} from '../contracts/world-model.ts'
import type { ActionResult } from './action-result.ts'

// ---------------------------------------------------------------------------
// 端口
// ---------------------------------------------------------------------------

/** 预测端口看得到的**闭集状态**（一行一条；不含正文、不含参数内容）。 */
export interface ActionForecastStateLine {
  /** `能力.操作` */
  readonly step: string
  /** 闭集状态码 */
  readonly status: string
  /** 具名失败码（没有则省略） */
  readonly failureCode?: string
}

export interface ActionForecastInput {
  /** 本任务目标（模型给的原话；只给预测器，不给执行器） */
  readonly goal: string
  /** 候选步骤（**只有** 能力 + 操作 + 一句话用途；**没有参数**） */
  readonly candidateSteps: readonly { readonly capability: string; readonly operation: string; readonly purpose?: string }[]
  /** 已经发生过的步骤（**闭集**：能力.操作 + 状态 + 具名失败码） */
  readonly state: readonly ActionForecastStateLine[]
  /** 本任务还能用几次行动（**真实读数**；预测不得据此扩权） */
  readonly remainingActions: number
  /** 本任务还能用几次规划/模型调用 */
  readonly remainingModelCalls: number
  /**
   * **读回事实**（有界；已过既有内容预算）。
   *
   * ⚠️ 只允许**既有内容预算**里已经拿到的东西（`TurnContent` / `ExternalEvidence` 的渲染行）。
   *    预测**不得**为了拿读回而多发一次请求 —— 那是探索，§2 明令禁止。
   */
  readonly readback?: readonly string[]
  /** 产生时间（**程序给**的毫秒；不是模型自报的时间） */
  readonly producedAt: number
  /** 输入 revision（**程序给**的指纹；比较结论要能回答"比的是哪一版输入"） */
  readonly inputRevision: string
  readonly deadlineMs: number
  readonly signal?: AbortSignal
}

export const ACTION_FORECAST_FAILURES = [
  'timeout',
  'call_failed',
  'invalid_output',
] as const
export type ActionForecastFailure = (typeof ACTION_FORECAST_FAILURES)[number]

export const ACTION_FORECAST_PARSE_CODES = [
  'action_forecast_empty',
  'action_forecast_no_json_object',
  'action_forecast_bad_json',
  'action_forecast_not_object',
  'action_forecast_unknown_field',
  'action_forecast_bad_schema_version',
  'action_forecast_bad_steps',
  'action_forecast_step_not_object',
  'action_forecast_step_unknown_field',
  'action_forecast_step_bad_capability',
  'action_forecast_step_bad_operation',
  'action_forecast_step_bad_outcome',
  'action_forecast_step_bad_uncertainty',
  'action_forecast_step_bad_depends_on',
  'action_forecast_step_check_not_object',
  'action_forecast_step_check_bad_kind',
  'action_forecast_step_check_bad_status',
  'action_forecast_step_check_bad_count',
  'unknown_parse_failure',
] as const
export type ActionForecastParseCode = (typeof ACTION_FORECAST_PARSE_CODES)[number]

export function toSafeActionForecastParseCode(error: unknown): ActionForecastParseCode {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && (ACTION_FORECAST_PARSE_CODES as readonly string[]).includes(code)
    ? (code as ActionForecastParseCode)
    : 'unknown_parse_failure'
}

export interface ActionForecastOutcomeOk {
  readonly ok: true
  readonly forecast: ActionForecast
  readonly requestCount: number
}
export interface ActionForecastOutcomeFail {
  readonly ok: false
  readonly failure: ActionForecastFailure
  readonly requestCount: number
  readonly parseFailureCode?: ActionForecastParseCode
}
export type ActionForecastOutcome = ActionForecastOutcomeOk | ActionForecastOutcomeFail

/**
 * 预测端口（**模型边界**）。
 *
 * ⚠️ 与 `TaskPlannerPort` 同一条纪律：输入面**只有** `ActionForecastInput` 里的字段。
 *    授权集合、参数、执行器、账本、数据库在**类型上**就进不来。
 */
export interface ActionForecastPort {
  readonly id: string
  readonly endpointHost: string
  forecast(input: ActionForecastInput): Promise<ActionForecastOutcome>
}

export function describeActionForecast(port: { id: string; endpointHost: string }): string {
  return `action forecast = ${port.id} @ ${port.endpointHost}`
}

// ---------------------------------------------------------------------------
// 严格解析
// ---------------------------------------------------------------------------

/** 预测的 schema 版本（模型必须逐字写出）。 */
export const ACTION_FORECAST_SCHEMA_VERSION = 'action-forecast@1'

const FORECAST_FIELDS = new Set(['schemaVersion', 'steps'])
const FORECAST_STEP_FIELDS = new Set([
  'capability',
  'operation',
  'expectedVisibleOutcome',
  'check',
  'uncertainty',
  'dependsOn',
])

/** 带 `code` 的解析错误（`toSafeActionForecastParseCode` 读的就是它）。 */
class ForecastParseError extends Error {
  constructor(readonly code: ActionForecastParseCode) {
    super(code)
    this.name = 'ForecastParseError'
  }
}

/** 从模型输出里取出那个 JSON 对象（容忍代码块围栏；其余失败关闭）。 */
export function extractActionForecastJson(raw: string): unknown {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ForecastParseError('action_forecast_empty')
  }
  const withoutFence = raw
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim()
  const start = withoutFence.indexOf('{')
  const end = withoutFence.lastIndexOf('}')
  if (start < 0 || end <= start) throw new ForecastParseError('action_forecast_no_json_object')
  try {
    return JSON.parse(withoutFence.slice(start, end + 1))
  } catch {
    throw new ForecastParseError('action_forecast_bad_json')
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 解析 + 校验一份预测（**纯函数**，失败关闭）。
 *
 * ============================================================================
 *  两条不同的失败纪律（**别混**）
 * ============================================================================
 * ```text
 * 形状不合法（未知字段 / 枚举越界 / 依赖不是整数） ⇒ **整份预测拒收**（致命）
 * 身份对不上（说的不是计划里的这一步）           ⇒ **这一条不绑定**（不致命）
 * ```
 * ⚠️ 为什么身份对不上**不致命**（2026-10-20 dev 段的**实测**）：
 *    第一版要求"预测的第 i 项**逐字**对应计划的第 i 步"，真实模型
 *    （MiniMax-M3.1-Flash-Preview）**会把步骤重排** ⇒ 整份预测被拒
 *    ⇒ 机制**根本没有生效**（dev 段 4 个夹具里有 1 个因此完全没进核对）。
 *    ⇒ 改成**按身份绑定**：`能力.操作` 逐字相同的才是同一件事。
 *    身份对不上的条目被**丢掉**（那一步**没有**闸 ⇒ 行为与今天相同），
 *    **不会**被错配到别的步骤上。
 *
 * ⚠️ 绑定的确定性：同一份 `(能力, 操作)` 出现在计划里多次时，
 *    取**第一个还没被绑定**的下标（保序 ⇒ 可复现）。
 *    重复的条目（第二个同身份的）被丢掉。
 *
 * ⚠️ `dependsOn` 的语义转换：模型写的是"**它自己那份列表**里的第几项"，
 *    程序把它**重映射**成**计划里的下标**（0 = 计划第一步）。
 *    重映射后必须**指向更早**的步骤，否则这条**不绑定**（无闸）。
 */
export function parseActionForecast(
  raw: string,
  options: { planSignature: readonly string[]; producedAt: number; inputRevision: string }
): ActionForecast {
  const value = extractActionForecastJson(raw)
  if (!isPlainObject(value)) throw new ForecastParseError('action_forecast_not_object')
  for (const key of Object.keys(value)) {
    if (!FORECAST_FIELDS.has(key)) throw new ForecastParseError('action_forecast_unknown_field')
  }
  if (value.schemaVersion !== ACTION_FORECAST_SCHEMA_VERSION) {
    throw new ForecastParseError('action_forecast_bad_schema_version')
  }
  const stepsRaw = value.steps
  if (!Array.isArray(stepsRaw)) throw new ForecastParseError('action_forecast_bad_steps')
  if (stepsRaw.length > 32) throw new ForecastParseError('action_forecast_bad_steps')

  // ---- ① 形状校验（致命） -------------------------------------------------
  const entries: {
    capability: string
    operation: string
    expectedVisibleOutcome: string
    check: ActionForecastCheck
    uncertainty: ActionForecast['steps'][number]['uncertainty']
    dependsOn: readonly number[]
  }[] = []
  for (const item of stepsRaw) {
    if (!isPlainObject(item)) throw new ForecastParseError('action_forecast_step_not_object')
    for (const key of Object.keys(item)) {
      if (!FORECAST_STEP_FIELDS.has(key)) throw new ForecastParseError('action_forecast_step_unknown_field')
    }
    const capability = item.capability
    const operation = item.operation
    if (typeof capability !== 'string' || capability.trim() === '') {
      throw new ForecastParseError('action_forecast_step_bad_capability')
    }
    if (typeof operation !== 'string' || operation.trim() === '') {
      throw new ForecastParseError('action_forecast_step_bad_operation')
    }
    const expectedVisibleOutcome = item.expectedVisibleOutcome
    if (typeof expectedVisibleOutcome !== 'string' || expectedVisibleOutcome.trim() === '') {
      throw new ForecastParseError('action_forecast_step_bad_outcome')
    }
    const uncertainty = item.uncertainty
    if (typeof uncertainty !== 'string') throw new ForecastParseError('action_forecast_step_bad_uncertainty')
    if (!WORLD_MODEL_UNCERTAINTIES.includes(uncertainty as (typeof WORLD_MODEL_UNCERTAINTIES)[number])) {
      throw new ForecastParseError('action_forecast_step_bad_uncertainty')
    }
    const dependsOn = item.dependsOn
    if (!Array.isArray(dependsOn)) throw new ForecastParseError('action_forecast_step_bad_depends_on')
    const dependsOnNumbers: number[] = []
    for (const dep of dependsOn) {
      if (typeof dep !== 'number' || !Number.isInteger(dep) || dep < 0) {
        throw new ForecastParseError('action_forecast_step_bad_depends_on')
      }
      dependsOnNumbers.push(dep)
    }
    entries.push({
      capability,
      operation,
      expectedVisibleOutcome,
      check: validateActionForecastCheck(item.check),
      uncertainty: uncertainty as ActionForecast['steps'][number]['uncertainty'],
      dependsOn: dependsOnNumbers,
    })
  }

  // ---- ② 按身份绑定（不致命） -------------------------------------------
  const boundPlanIndexOfEntry: number[] = []
  const takenPlanIndices = new Set<number>()
  for (const entry of entries) {
    const key = `${entry.capability}.${entry.operation}`
    let target = -1
    for (let index = 0; index < options.planSignature.length; index += 1) {
      if (options.planSignature[index] !== key) continue
      if (takenPlanIndices.has(index)) continue
      target = index
      break
    }
    if (target >= 0) takenPlanIndices.add(target)
    boundPlanIndexOfEntry.push(target)
  }

  // ---- ③ 重排成计划顺序 + 重映射 dependsOn --------------------------------
  const byPlanIndex = new Map<number, (typeof entries)[number]>()
  for (const [entryIndex, entry] of entries.entries()) {
    const planIndex = boundPlanIndexOfEntry[entryIndex]!
    if (planIndex < 0) continue
    const remapped: number[] = []
    let valid = true
    for (const dep of entry.dependsOn) {
      const depPlanIndex = dep < boundPlanIndexOfEntry.length ? boundPlanIndexOfEntry[dep]! : -1
      if (depPlanIndex < 0 || depPlanIndex >= planIndex) {
        valid = false
        break
      }
      if (!remapped.includes(depPlanIndex)) remapped.push(depPlanIndex)
    }
    if (!valid) continue
    byPlanIndex.set(planIndex, { ...entry, dependsOn: remapped })
  }

  const steps: ActionForecastStep[] = []
  const planStepIndices: number[] = []
  for (let index = 0; index < options.planSignature.length; index += 1) {
    const bound = byPlanIndex.get(index)
    if (bound === undefined) continue
    planStepIndices.push(index)
    steps.push(
      validateActionForecastStep(bound, {
        planStepCount: options.planSignature.length,
        stepIndex: index,
      })
    )
  }
  return { producedAt: options.producedAt, inputRevision: options.inputRevision, steps, planStepIndices }
}

// ---------------------------------------------------------------------------
// 核对条件的程序判定
// ---------------------------------------------------------------------------

/** 核对结论闭集。 */
export const FORECAST_CHECK_VERDICTS = ['pass', 'fail', 'unknown'] as const
export type ForecastCheckVerdict = (typeof FORECAST_CHECK_VERDICTS)[number]

/**
 * 用**真实结果**判定一个核对条件。
 *
 * ⚠️ `unknown` 是**一等结论**：没观测到的事实不能被判成"通过"，
 *    也不能被判成"失败"（§5："对比时未观测、超时和部分成功各自保留"）。
 */
export function evaluateForecastCheck(
  check: ActionForecastCheck,
  result: Pick<ActionResult, 'status' | 'error' | 'effect' | 'turnContent' | 'externalEvidence'>
): ForecastCheckVerdict {
  switch (check.kind) {
    case 'status_is':
      return result.status === check.status ? 'pass' : 'fail'
    case 'no_error':
      if (result.error !== undefined) return 'fail'
      return result.status === 'success' ? 'pass' : 'unknown'
    case 'effect_recorded':
      if (result.effect === undefined) return 'unknown'
      return result.effect.kind === 'none' || result.effect.kind === 'no_change' ? 'fail' : 'pass'
    case 'turn_content_count_at_least': {
      const count = result.turnContent?.length
      if (count === undefined) return 'unknown'
      return count >= check.count ? 'pass' : 'fail'
    }
    case 'external_evidence_count_at_least': {
      const count = result.externalEvidence?.length
      if (count === undefined) return 'unknown'
      return count >= check.count ? 'pass' : 'fail'
    }
    default:
      return 'unknown'
  }
}

/**
 * 把**一步预测**与**一次真实结果**比一比。
 *
 * ⚠️ 不可比时结论是 `unknown`，**不是**"不符"：把"没观测到"记成"被反驳"
 *    就是在制造伪确定性（§5 明令禁止）。
 */
export function compareForecastStep(
  step: ActionForecastStep,
  result: Pick<ActionResult, 'status' | 'error' | 'effect' | 'turnContent' | 'externalEvidence'>,
  options: { actualSourceRef: string; ruleVersion?: string }
): ComparisonResult {
  const verdict = evaluateForecastCheck(step.check, result)
  if (verdict === 'unknown') {
    return {
      comparable: false,
      verdict: 'unknown',
      actualSourceRef: options.actualSourceRef,
      reason: 'check_not_evaluable',
    }
  }
  if (verdict === 'pass') {
    return {
      comparable: true,
      verdict: 'match',
      actualSourceRef: options.actualSourceRef,
    }
  }
  return {
    comparable: true,
    verdict: 'mismatch',
    ...(options.ruleVersion !== undefined ? { refutedRuleVersion: options.ruleVersion } : {}),
    actualSourceRef: options.actualSourceRef,
  }
}

/** 找出**某一步**对应的预测（按 能力 + 操作；取第一条）。 */
export function forecastStepFor(
  forecast: ActionForecast,
  capability: string,
  operation: string
): ActionForecastStep | undefined {
  return forecast.steps.find(
    (step) => step.capability === capability && step.operation === operation
  )
}

/**
 * 预测里的**依赖**是否仍然**站得住**。
 *
 * ⚠️ `refuted` 是"**核对结论为 `mismatch`** 的步骤下标"集合。
 *    依赖了其中任何一个 ⇒ 这一步**不该**沿用上游的结果 ⇒ 程序应当
 *    **不执行**它（并重新规划），而不是"照做但打个标记"。
 *
 * ⚠️ **只挡"被反驳"，不挡"没核对过"**：`unknown`（没观测到 / 不可判定）
 *    **不**在这个集合里 —— 把"没观测到"当成"失败"会让正常链路凭空断掉
 *    （§5："对比时未观测、超时和部分成功各自保留"）。
 */
export function forecastDependenciesSatisfied(
  step: ActionForecastStep,
  refuted: ReadonlySet<number>
): boolean {
  return step.dependsOn.every((index) => !refuted.has(index))
}

/** 一行诊断（**只含闭集与计数**；不含模型原文）。 */
export function describeForecast(forecast: ActionForecast): string {
  const byUncertainty = new Map<WorldModelUncertainty, number>()
  for (const step of forecast.steps) {
    byUncertainty.set(step.uncertainty, (byUncertainty.get(step.uncertainty) ?? 0) + 1)
  }
  const parts = [...byUncertainty.entries()].map(([key, count]) => `${key}=${String(count)}`)
  return `forecast=${String(forecast.steps.length)} 步 · ${parts.join(' ')} · revision=${forecast.inputRevision}`
}
