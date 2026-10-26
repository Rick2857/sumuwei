/**
 * 短程模拟 · **契约**（2026-10-22 · 认知能力建设计划 P2 第 6 步）
 *
 * ============================================================================
 *  它是什么
 * ============================================================================
 *  计划 §3 P2 第 6 步逐字要求：
 *
 *      「单步链成立后再加入**有上限**的多步候选比较；在**未覆盖状态或冲突**处返回**未知**，
 *        **模拟轨迹不写成真实经历**。」
 *
 *  集成架构 §3 补充：「Simulation 使用**模型状态副本**，**不调用真实工具**，
 *  也不把模拟分支写成真实经历。模拟可以比较合法候选路径；获得模型较高评分**不会授予行动权限**。」
 *
 *  ⇒ 本文件给出：**状态副本上的多步推进** ＋ **有上限的候选路径比较** ＋
 *    **未覆盖/冲突 ⇒ 未知** ＋ **模拟轨迹与真实经历分开**的形状。
 *
 * ============================================================================
 *  五条不许破的边界
 * ============================================================================
 * ① **副本**：模拟从 `initialState` 的**深拷贝**出发；输入状态**不被改动**。
 * ② **不调真实工具**：本文件是**纯函数**——它没有执行器、没有账本、没有数据库。
 * ③ **有上限**：步数与路径数都有**硬上限**；超了 ⇒ **截断并如实说**（不是"算完了"）。
 * ④ **未覆盖 / 冲突 ⇒ 未知**：那一步**不编结论**；整条路径就此标成 `unknown`。
 *    ⚠️ 冲突**不覆盖**：同样的状态与动作给出不同结果 ⇒ `unknown`，
 *    **不是**"用后一次覆盖前一次"。
 * ⑤ **模拟 ≠ 经历**：模拟轨迹是**模拟轨迹**（`simulation: true`），
 *    **不进**真实账本、**不结算**成证据、**不授予**任何行动权限。
 *
 * ⚠️ 纯类型 + 纯函数：不 import 框架 / SQL / `node:*`，不读时钟，无副作用。
 */

import { KernelError } from './ids.ts'
import {
  interpretTransition,
  type ObservedActionFact,
  type ObservedTransitionState,
  type TransitionExpectation,
  type RestrictedTransitionRule,
} from './world-model-transition.ts'

/** 本契约自身的版本 */
export const WORLD_MODEL_SIMULATION_VERSION = 'world-model-simulation@1'

// ---------------------------------------------------------------------------
// 模拟的动作与结果
// ---------------------------------------------------------------------------

/**
 * 模拟里的一步（**内部**形状）。
 *
 * ⚠️ 它**带参数**（路径 / 内容指纹）：「预测端口拿不到参数」那条纪律针对的是
 *    **模型端口**（对外的预测面）；**模拟器**是内部组件，它必须知道
 *    "这一步作用在**哪个对象**上"才能推进副本。
 */
export interface SimulationAction {
  readonly capability: string
  readonly operation: string
  /** 作用对象与效果（**闭集键**：path / contentFingerprint） */
  readonly arguments: Readonly<Record<string, string>>
}

/** 一步的结论（三态，与单步链**同形**） */
export type SimulationStepOutcome = 'applied' | 'unknown' | 'conflict'

/** 模拟的一步读数 */
export interface SimulationStep {
  /** 第几步（0 基） */
  readonly index: number
  readonly action: SimulationAction
  readonly outcome: SimulationStepOutcome
  /** 预期（`outcome === 'applied'` 时有） */
  readonly expectation?: TransitionExpectation
  /** 人读说明（**不参与判定**） */
  readonly detail: string
}

/** 一条模拟路径的读数 */
export interface SimulationTrace {
  /** 路径标识（程序给的稳定 id） */
  readonly id: string
  /** 逐步读数 */
  readonly steps: SimulationStep[]
  /** 结论：`completed` 走完 · `unknown` 未覆盖/不可判 · `conflict` 冲突 */
  readonly outcome: 'completed' | 'unknown' | 'conflict'
  /** 停在第几步（`completed` 时是步数） */
  readonly stoppedAt: number
}

/** 模拟报告 */
export interface SimulationReport {
  /** 版本 */
  readonly version: typeof WORLD_MODEL_SIMULATION_VERSION
  /** 本次使用的规则与来源版本；资格由运行时适配器在模拟前核对。 */
  readonly rule: Pick<RestrictedTransitionRule, 'id' | 'version' | 'binding'>
  /** 每条候选路径的读数 */
  readonly traces: readonly SimulationTrace[]
  /** 实际比较了几条路径 */
  readonly comparedPaths: number
  /** 预算（**硬上限**） */
  readonly budget: { readonly maxSteps: number; readonly maxPaths: number }
  /** 候选路径**超过上限**被截断没有（截了 ⇒ "还有没比的"） */
  readonly truncated: boolean
  /** 整体结论；冲突诊断保留在路径里，整体返回未知。 */
  readonly outcome: 'compared' | 'unknown'
  /** ⚠️ **这份报告是模拟**，不是经历 */
  readonly simulation: true
}

// ---------------------------------------------------------------------------
// 副本与推进
// ---------------------------------------------------------------------------

/** 深拷贝状态（**副本**；输入不被改动） */
function copyState (state: ObservedTransitionState): ObservedTransitionState {
  return {
    actions: state.actions.map(action => ({ ...action, effects: { ...action.effects } })),
    facts: { ...state.facts },
  }
}

/** 在副本上追加一个动作事实（**只改副本**） */
function pushAction (state: ObservedTransitionState, fact: ObservedActionFact): ObservedTransitionState {
  return { actions: [...state.actions, fact], facts: state.facts }
}

/** 在副本上写一个事实（**只改副本**） */
function putFact (state: ObservedTransitionState, key: string, value: string): ObservedTransitionState {
  return { actions: state.actions, facts: { ...state.facts, [key]: value } }
}

/**
 * 推进**一步**（在副本上）。
 *
 * ⚠️ 只认**闭集**的动作形状（读 / 写）；认不得 ⇒ `unknown`（**不猜**）。
 */
function advance (
  state: ObservedTransitionState,
  action: SimulationAction,
  rule: RestrictedTransitionRule
): { outcome: SimulationStepOutcome; nextState: ObservedTransitionState; expectation?: TransitionExpectation; detail: string } {
  const next = copyState(state)
  if (rule.kind !== 'write_then_read_same_bytes' ||
    !((action.capability === 'sandbox.file.write' && action.operation === 'write') ||
      (action.capability === 'sandbox.file.read' && action.operation === 'read'))) {
    return { outcome: 'unknown', nextState: next, detail: '该规则不覆盖此能力与操作' }
  }
  if (Object.entries(rule.conditions).some(([key, value]) => state.facts[key] !== value)) {
    return { outcome: 'unknown', nextState: next, detail: '规则条件未知或不匹配' }
  }
  const path = action.arguments.path
  if (path === undefined || path === '') {
    return { outcome: 'unknown', nextState: next, detail: '这一步没有可认的对象（path）⇒ 未覆盖' }
  }

  if (action.operation === 'write') {
    const fingerprint = action.arguments.contentFingerprint
    if (fingerprint === undefined || fingerprint === '') {
      return { outcome: 'unknown', nextState: next, detail: '写没有内容指纹 ⇒ 未覆盖' }
    }
    const fact: ObservedActionFact = {
      actionId: `sim-${String(next.actions.length)}`,
      capability: action.capability,
      operation: 'write',
      status: 'success',
      effects: { path, contentFingerprint: fingerprint },
    }
    return { outcome: 'applied', nextState: putFact(pushAction(next, fact), `fingerprint:${path}`, fingerprint), detail: `写入 ${path}（指纹 ${fingerprint.slice(0, 8)}…）` }
  }

  if (action.operation === 'read') {
    /*
     * 最新成功写入与当前状态摘要矛盾才是冲突；正常的顺序改写会同步推进摘要。
     */
    const writes = state.actions.filter(
      fact => fact.capability === 'sandbox.file.write' && fact.operation === 'write' && fact.status === 'success' && fact.effects.path === path,
    )
    const lastWrite = writes.at(-1)
    const factFingerprint = state.facts[`fingerprint:${path}`]
    if (
      lastWrite !== undefined &&
      factFingerprint !== undefined &&
      lastWrite.effects.contentFingerprint !== factFingerprint
    ) {
      return {
        outcome: 'conflict',
        nextState: next,
        detail:
          `路径 ${path} 上有两个不同的写入指纹（${String(lastWrite.effects.contentFingerprint).slice(0, 8)}… ` +
          `vs ${factFingerprint.slice(0, 8)}…）⇒ **冲突**（不用后一次覆盖前一次）`,
      }
    }
    const prediction = interpretTransition({ rule, observed: state,
      action: { ...action, subjectId: '' },
    })
    if (prediction.kind !== 'expected' || prediction.expectation === undefined) {
      return { outcome: 'unknown', nextState: next, detail: prediction.detail ?? '单步转移未覆盖' }
    }
    const expectation = prediction.expectation
    const fact: ObservedActionFact = {
      actionId: `sim-${String(next.actions.length)}`,
      capability: action.capability,
      operation: 'read',
      status: 'success',
      effects: { path, contentFingerprint: expectation.expectedFingerprint },
    }
    return { outcome: 'applied', nextState: pushAction(next, fact), expectation, detail: `读回 ${path} ⇒ 与写入一致` }
  }

  return { outcome: 'unknown', nextState: next, detail: `不认的动作 ${action.capability}.${action.operation} ⇒ 未覆盖` }
}

// ---------------------------------------------------------------------------
// 模拟
// ---------------------------------------------------------------------------

/** 模拟的输入 */
export interface SimulationInput {
  /** 受限规则（含条件、版本与来源绑定；由当前合格快照构造） */
  readonly rule: RestrictedTransitionRule
  /** 起始状态（**不会被改动**） */
  readonly initialState: ObservedTransitionState
  /** 候选路径（每条一串动作） */
  readonly candidates: readonly { readonly id: string; readonly actions: readonly SimulationAction[] }[]
  /** 步数硬上限（默认 4） */
  readonly maxSteps?: number
  /** 路径数硬上限（默认 8） */
  readonly maxPaths?: number
}

/** 默认预算（**有上限**是纪律，不是参数） */
export const SIMULATION_DEFAULT_MAX_STEPS = 4
export const SIMULATION_DEFAULT_MAX_PATHS = 8

/**
 * 在**状态副本**上比较有上限的多步候选路径。
 *
 * ⚠️ **纯函数**：不调工具、不写账本、不结算证据。
 *    ⇒ 调用方拿到的 `simulation: true` 报告**不是经历**。
 */
export function simulateTransitionPaths (input: SimulationInput): SimulationReport {
  const requestedSteps = input.maxSteps ?? SIMULATION_DEFAULT_MAX_STEPS
  const requestedPaths = input.maxPaths ?? SIMULATION_DEFAULT_MAX_PATHS
  if (!Number.isSafeInteger(requestedSteps) || requestedSteps < 1 ||
      !Number.isSafeInteger(requestedPaths) || requestedPaths < 1) {
    throw new KernelError('validation_error', 'simulation_bad_budget', 'simulation_bad_budget: 预算必须为正安全整数')
  }
  const maxSteps = Math.min(requestedSteps, 32)
  const maxPaths = Math.min(requestedPaths, 64)
  let truncated = input.candidates.length > maxPaths
  const selected = input.candidates.slice(0, maxPaths)

  const traces: SimulationTrace[] = []
  let anyUnknown = selected.length === 0 || truncated
  let anyConflict = false

  for (const candidate of selected) {
    let state = copyState(input.initialState)
    const steps: SimulationStep[] = []
    let outcome: SimulationTrace['outcome'] = 'completed'
    let stoppedAt = 0
    for (const [index, action] of candidate.actions.entries()) {
      if (index >= maxSteps) {
        truncated = true
        outcome = 'unknown'
        stoppedAt = index
        steps.push({
          index,
          action,
          outcome: 'unknown',
          detail: `超过步数上限 ${String(maxSteps)} ⇒ 截断（**不是**"算完了"）`,
        })
        break
      }
      const advanced = advance(state, action, input.rule)
      steps.push({
        index,
        action,
        outcome: advanced.outcome,
        ...(advanced.expectation === undefined ? {} : { expectation: advanced.expectation }),
        detail: advanced.detail,
      })
      if (advanced.outcome === 'unknown') {
        outcome = 'unknown'
        stoppedAt = index
        break
      }
      if (advanced.outcome === 'conflict') {
        outcome = 'conflict'
        stoppedAt = index
        break
      }
      state = advanced.nextState
      stoppedAt = index + 1
    }
    if (outcome === 'unknown') anyUnknown = true
    if (outcome === 'conflict') anyConflict = true
    traces.push({ id: candidate.id, steps, outcome, stoppedAt })
  }

  return {
    version: WORLD_MODEL_SIMULATION_VERSION,
    rule: { id: input.rule.id, version: input.rule.version, binding: { ...input.rule.binding } },
    traces,
    comparedPaths: traces.length,
    budget: { maxSteps, maxPaths },
    truncated,
    outcome: anyConflict || anyUnknown ? 'unknown' : 'compared',
    simulation: true,
  }
}

/** 校验一条模拟路径的动作（**闭集**） */
export function validateSimulationAction (value: unknown): SimulationAction {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new KernelError('validation_error', 'simulation_action_not_object', '模拟动作必须是一个对象')
  }
  const raw = value as Record<string, unknown>
  if (Object.keys(raw).some(key => !['capability', 'operation', 'arguments'].includes(key))) {
    throw new KernelError('validation_error', 'simulation_action_unknown_field', '模拟动作包含未知字段')
  }
  if (typeof raw.capability !== 'string' || raw.capability.trim() === '') {
    throw new KernelError('validation_error', 'simulation_action_bad_capability', '模拟动作缺少 capability')
  }
  if (typeof raw.operation !== 'string' || raw.operation.trim() === '') {
    throw new KernelError('validation_error', 'simulation_action_bad_operation', '模拟动作缺少 operation')
  }
  const argumentsRaw = raw.arguments
  if (argumentsRaw === null || typeof argumentsRaw !== 'object' || Array.isArray(argumentsRaw)) {
    throw new KernelError('validation_error', 'simulation_action_bad_arguments', '模拟动作的 arguments 必须是键值对象')
  }
  const args: Record<string, string> = {}
  for (const [key, item] of Object.entries(argumentsRaw as Record<string, unknown>)) {
    if (!['path', 'contentFingerprint'].includes(key) || typeof item !== 'string') {
      throw new KernelError('validation_error', 'simulation_action_bad_arguments', '模拟动作只接受 path/contentFingerprint 字符串参数')
    }
    args[key] = item
  }
  return { capability: raw.capability, operation: raw.operation, arguments: args }
}
