/**
 * M6.1 WP4 / ADR-055 `D-55d` ②③④：「生产装配 ≡ 受测装配」的**运行期**判据。
 *
 * ============================================================================
 *  静态判据不够（用户 §4.6 的原话）
 * ============================================================================
 * ```text
 * · 共用入口只是**必要不充分** —— 端口注入了不等于开关被消费、
 *   更不等于"这一轮的结果真的进了后续链路"；
 * · 只看 Gateway 会漏掉 `main.ts` 里的**回复守卫**等路径；
 * · 只拔一个端口**无法**证明"开关没被消费"与"结果没进下游"能被发现。
 * ```
 * 因此这里读的是**真实一轮的 trace 事实**，并按能力给出**三读数**：
 *
 * ```text
 * ① 端口接没接     —— 观测里有没有这条能力的痕迹（或"具名地说没接"）
 * ② 开关开没开     —— 端口在、但这一轮被开关关掉时，状态行必须**具名**说 `flag_off`
 * ③ 实际入模没有   —— 选了 / 写了 / 执行了，**是否真的进了后续链路**
 * ```
 *
 * ============================================================================
 *  两条纪律（否则判据自己会变成噪声）
 * ============================================================================
 * ```text
 * ① **每个场景必须预先声明"应该触发什么"** —— `expectations` 是输入的一部分。
 *    没有触发条件的安静轮次**不算**"装配缺失"，但它也**不能**算作该能力的证据：
 *    这种情况报 `trigger_not_declared`，并且该能力在这一轮**不产生读数**。
 * ② 本模块**是纯函数**：输入是已经采集好的 trace 事实，因此它能被离线单测
 *    （正控 / 三条负控 / 恢复，见 `m6.1:test`），而**真实读数**由生产装配跑出来的
 *    run 提供（那属于 WP5/WP6 的 Live 档）。
 * ```
 */

import {
  REPLY_GUARD_NAMES,
  missingReplyGuards,
  type ReplyGuardReport,
} from '../src/kernel/contracts/reply-guard.ts'

export type AssemblyCapability =
  | 'recall'
  | 'memory_write'
  | 'action'
  | 'rollup'
  | 'record_status'
  | 'reply_guards'

export const ASSEMBLY_CAPABILITIES: readonly AssemblyCapability[] = [
  'recall',
  'memory_write',
  'action',
  'rollup',
  'record_status',
  'reply_guards',
]

/**
 * 预先声明的触发条件。
 *
 * ⚠️ `expect: 'must_fire'` 是**判据**：这一轮没观察到它 ⇒ 报
 *    `declared_trigger_not_observed`（不是"安静"）。
 * ⚠️ `expect: 'not_expected'` 同样有意义：**不该发生**的能力若出现痕迹，也要报。
 */
export interface AssemblyExpectation {
  readonly capability: AssemblyCapability
  readonly expect: 'must_fire' | 'not_expected' | 'either'
  /** 该能力**必须**在后续链路上留下的最少条数（`must_fire` 时生效） */
  readonly minDownstream?: number
}

/** 一轮的 trace 事实（**只含 id / 计数 / 枚举**，没有正文） */
export interface RuntimeTurnEvidence {
  readonly scenarioId: string
  /** 这一轮预先声明的触发条件（缺省 = 没声明 ⇒ 该轮不能作任何能力的证据） */
  readonly expectations?: readonly AssemblyExpectation[]
  /** trace 里的 step kind（顺序 = trace 顺序） */
  readonly stepKinds: readonly string[]
  /** 逐 step 的属性（只需要 `memory_record_status` 那一步的 `reason_code` / `outcome`） */
  readonly stepAttributes?: readonly {
    readonly kind: string
    readonly attributes?: Readonly<Record<string, unknown>>
  }[]
  /** 这一轮**实际**进上下文的长期记忆 id（`trace.selectedMemoryIds`） */
  readonly selectedMemoryIds: readonly string[]
  /** 选择器本来选了谁（诊断；与上面不一致就是"选了没进"） */
  readonly intendedSelectedIds?: readonly string[]
  /** 编译后的 section id 与被丢掉的 section id */
  readonly contextSectionIds?: readonly string[]
  readonly droppedSectionIds?: readonly string[]
  /** 显式记忆写入：结果 + 是否发生过状态变化 */
  readonly memoryWrite?: { readonly ok: boolean; readonly statusChanged?: boolean }
  /** 动作：执行结果 + 账本 id */
  readonly actions?: readonly {
    readonly capability: string
    readonly status: string
    readonly ledgerId?: string
  }[]
  /** 摘要：这一轮端口被咨询且产出了 section 吗 */
  readonly rollup?: { readonly status: string; readonly sectionSurvived?: boolean }
  /** 四道回复守卫的报告 */
  readonly replyGuards?: readonly ReplyGuardReport[]
}

export type AssemblyRuntimeProblemKind =
  | 'port_missing'
  | 'flag_not_consumed'
  | 'result_not_in_downstream'
  | 'declared_trigger_not_observed'
  | 'unexpected_capability_activity'
  | 'trigger_not_declared'

export interface AssemblyRuntimeProblem {
  readonly scenarioId: string
  readonly capability: AssemblyCapability
  readonly kind: AssemblyRuntimeProblemKind
  readonly detail: string
}

/** 一个能力的**三读数** */
export interface CapabilityReading {
  readonly capability: AssemblyCapability
  /** 端口接没接 */
  readonly portWired: boolean | 'unknown'
  /** 开关开没开（`false` = 具名地说"被开关关掉了"） */
  readonly flagConsumed: boolean | 'unknown'
  /** 实际进了后续链路的条数 */
  readonly enteredDownstream: number
  /** 这一轮有没有**预先声明**的触发条件 */
  readonly triggerDeclared: boolean
  /** 该读数是否**可作证据**（没声明触发条件的安静轮次 ⇒ false） */
  readonly countsAsEvidence: boolean
}

export interface AssemblyRuntimeReadout {
  readonly readings: readonly CapabilityReading[]
  readonly problems: readonly AssemblyRuntimeProblem[]
  /** 只有真的跑过、且每条读数都可作证据时才是 `PASS` */
  readonly verdict: 'PASS' | 'FAIL' | 'MEASUREMENT INVALID'
}

function stringsOf(values: Readonly<Record<string, unknown>> | undefined): string {
  if (values === undefined) return ''
  const value = values['reason_code']
  return typeof value === 'string' ? value : ''
}

function expectationOf(
  turn: RuntimeTurnEvidence,
  capability: AssemblyCapability
): AssemblyExpectation | undefined {
  return turn.expectations?.find((item) => item.capability === capability)
}

/**
 * 读一轮。
 *
 * ⚠️ 每个能力的判据都**只**用这一轮真实出现过的事实，不推断、不猜：
 *    端口接没接看有没有痕迹（或状态行有没有**具名**说"端口未接"），
 *    开关看状态行有没有具名说 `flag_off`，
 *    入模看 `selectedMemoryIds` / section 名单 / 账本 id。
 */
export function readTurnAssembly(turn: RuntimeTurnEvidence): {
  readings: CapabilityReading[]
  problems: AssemblyRuntimeProblem[]
} {
  const problems: AssemblyRuntimeProblem[] = []
  const readings: CapabilityReading[] = []
  const has = (kind: string) => turn.stepKinds.includes(kind)
  const statusStep = turn.stepAttributes?.find((step) => step.kind === 'memory_record_status')
  const reasonCodes = stringsOf(statusStep?.attributes)
  const statusOutcome = statusStep?.attributes?.['outcome']
  const sectionIds = turn.contextSectionIds ?? []
  const dropped = turn.droppedSectionIds ?? []

  const push = (
    capability: AssemblyCapability,
    reading: Omit<CapabilityReading, 'capability'>
  ): void => {
    readings.push({ capability, ...reading })
  }

  /* ------------------------------- recall -------------------------------- */
  {
    const expectation = expectationOf(turn, 'recall')
    const declaresPortNotWired = reasonCodes.includes('not_searched:port_not_wired')
    const declaresFlagOff = reasonCodes.includes('not_searched:flag_off')
    const intended = turn.intendedSelectedIds?.length ?? 0
    const selected = turn.selectedMemoryIds.length
    const sectionKept = sectionIds.includes('memory-recall')
    const portWired = has('memory_recall') || has('memory_record_status') ? !declaresPortNotWired : 'unknown'
    const entered = Math.max(selected, sectionKept ? 1 : 0)
    push('recall', {
      portWired,
      flagConsumed: declaresFlagOff ? false : portWired === 'unknown' ? 'unknown' : true,
      enteredDownstream: entered,
      triggerDeclared: expectation !== undefined,
      countsAsEvidence:
        expectation !== undefined &&
        (expectation.expect === 'must_fire' ? !declaresFlagOff && !declaresPortNotWired : true),
    })
    if (expectation?.expect === 'must_fire') {
      if (declaresPortNotWired) {
        problems.push({
          scenarioId: turn.scenarioId,
          capability: 'recall',
          kind: 'port_missing',
          detail: '状态行具名说 `not_searched:port_not_wired`，而这一轮声明了必须召回',
        })
      } else if (declaresFlagOff) {
        problems.push({
          scenarioId: turn.scenarioId,
          capability: 'recall',
          kind: 'flag_not_consumed',
          detail: '状态行具名说 `not_searched:flag_off` —— 端口在、开关把它关掉了',
        })
      } else if (!has('memory_recall') && !has('memory_record_status')) {
        problems.push({
          scenarioId: turn.scenarioId,
          capability: 'recall',
          kind: 'declared_trigger_not_observed',
          detail: '声明了必须召回，但 trace 里既没有 `memory_recall` 也没有 `memory_record_status` 步骤',
        })
      }
      const min = expectation.minDownstream ?? 0
      if (entered < min) {
        problems.push({
          scenarioId: turn.scenarioId,
          capability: 'recall',
          kind: 'result_not_in_downstream',
          detail: `选了 ${String(intended)} 条、进上下文的只有 ${String(entered)} 条（要求 ≥${String(min)}）`,
        })
      }
    }
  }

  /* ---------------------------- memory_write ----------------------------- */
  {
    const expectation = expectationOf(turn, 'memory_write')
    const wrote = turn.memoryWrite
    const stepPresent = has('memory_explicit_write')
    const entered = wrote?.ok === true ? 1 : 0
    push('memory_write', {
      portWired: stepPresent || wrote !== undefined ? true : 'unknown',
      flagConsumed: 'unknown',
      enteredDownstream: entered,
      triggerDeclared: expectation !== undefined,
      countsAsEvidence: expectation !== undefined,
    })
    if (expectation?.expect === 'must_fire') {
      if (wrote === undefined) {
        problems.push({
          scenarioId: turn.scenarioId,
          capability: 'memory_write',
          kind: 'port_missing',
          detail: '声明了必须写入，但这一轮没有任何显式写入的读数',
        })
      } else if (wrote.ok && !stepPresent) {
        problems.push({
          scenarioId: turn.scenarioId,
          capability: 'memory_write',
          kind: 'result_not_in_downstream',
          detail: '写入回报成功，但 trace 里没有 `memory_explicit_write` 步骤（结果没进后续链路）',
        })
      }
    }
  }

  /* -------------------------------- action -------------------------------- */
  {
    const expectation = expectationOf(turn, 'action')
    const actions = turn.actions ?? []
    const executed = actions.filter((item) => item.status === 'success' || item.status === 'partial')
    const withLedger = executed.filter((item) => item.ledgerId !== undefined && item.ledgerId !== '')
    push('action', {
      portWired: actions.length > 0 || has('action_dispatch') ? true : 'unknown',
      flagConsumed: 'unknown',
      enteredDownstream: withLedger.length,
      triggerDeclared: expectation !== undefined,
      countsAsEvidence: expectation !== undefined,
    })
    if (expectation?.expect === 'must_fire') {
      if (actions.length === 0 && !has('action_dispatch')) {
        problems.push({
          scenarioId: turn.scenarioId,
          capability: 'action',
          kind: 'declared_trigger_not_observed',
          detail: '声明了必须有动作，但这一轮没有任何动作痕迹',
        })
      } else if (withLedger.length < executed.length) {
        problems.push({
          scenarioId: turn.scenarioId,
          capability: 'action',
          kind: 'result_not_in_downstream',
          detail: `${String(executed.length)} 个动作成功，其中只有 ${String(withLedger.length)} 个有账本 id`,
        })
      }
    }
  }

  /* -------------------------------- rollup -------------------------------- */
  {
    const expectation = expectationOf(turn, 'rollup')
    const rollupRan = turn.rollup !== undefined
    const survived = turn.rollup?.sectionSurvived === true || sectionIds.includes('rolling-summary')
    const droppedByBudget = dropped.includes('rolling-summary')
    push('rollup', {
      portWired: rollupRan || sectionIds.includes('rolling-summary') ? true : 'unknown',
      flagConsumed: 'unknown',
      enteredDownstream: survived ? 1 : 0,
      triggerDeclared: expectation !== undefined,
      countsAsEvidence: expectation !== undefined,
    })
    if (expectation?.expect === 'must_fire' && rollupRan && !survived && !droppedByBudget) {
      problems.push({
        scenarioId: turn.scenarioId,
        capability: 'rollup',
        kind: 'result_not_in_downstream',
        detail: '摘要端口跑过了，但既没有 section、也没有"被预算裁掉"的痕迹',
      })
    }
  }

  /* ----------------------------- record_status ---------------------------- */
  {
    const expectation = expectationOf(turn, 'record_status')
    const present = has('memory_record_status')
    const included = statusOutcome === 'included'
    push('record_status', {
      portWired: present ? true : 'unknown',
      flagConsumed: 'unknown',
      enteredDownstream: included ? 1 : 0,
      triggerDeclared: expectation !== undefined,
      countsAsEvidence: expectation !== undefined,
    })
    if (expectation?.expect === 'must_fire') {
      if (!present) {
        problems.push({
          scenarioId: turn.scenarioId,
          capability: 'record_status',
          kind: 'declared_trigger_not_observed',
          detail: '声明了必须有记录状态行，但 trace 里没有那一步',
        })
      } else if (!included && statusOutcome !== 'dropped') {
        problems.push({
          scenarioId: turn.scenarioId,
          capability: 'record_status',
          kind: 'result_not_in_downstream',
          detail: `状态行既没入模、也不是"被裁"（outcome=${String(statusOutcome)}）`,
        })
      }
    }
  }

  /* ----------------------------- reply_guards ----------------------------- */
  {
    const expectation = expectationOf(turn, 'reply_guards')
    const step = turn.stepAttributes?.find((item) => item.kind === 'reply_guard')
    const reports = turn.replyGuards
    const missing = reports === undefined ? [...REPLY_GUARD_NAMES] : missingReplyGuards(reports)
    push('reply_guards', {
      portWired: step !== undefined || reports !== undefined ? true : 'unknown',
      flagConsumed: 'unknown',
      enteredDownstream: reports === undefined ? 0 : reports.length,
      triggerDeclared: expectation !== undefined,
      countsAsEvidence: expectation !== undefined,
    })
    if (reports !== undefined && missing.length > 0) {
      problems.push({
        scenarioId: turn.scenarioId,
        capability: 'reply_guards',
        kind: 'result_not_in_downstream',
        detail: `守卫报告缺 ${String(missing.length)} 道：${missing.join(',')}`,
      })
    }
    if (expectation?.expect === 'must_fire' && step === undefined && reports === undefined) {
      problems.push({
        scenarioId: turn.scenarioId,
        capability: 'reply_guards',
        kind: 'declared_trigger_not_observed',
        detail: '声明了必须有守卫报告，但 trace 里没有 `reply_guard` 那一步',
      })
    }
  }

  /*
   * `expect: 'not_expected'` 也要判：**不该发生**的能力若留下痕迹，同样要报。
   * 没有这一条，"预先声明"就只剩一半（只能发现"该有的没有"，发现不了"不该有的有了"）。
   */
  for (const expectation of turn.expectations ?? []) {
    if (expectation.expect !== 'not_expected') continue
    const reading = readings.find((item) => item.capability === expectation.capability)
    if (reading === undefined) continue
    if (reading.portWired === true || reading.enteredDownstream > 0) {
      problems.push({
        scenarioId: turn.scenarioId,
        capability: expectation.capability,
        kind: 'unexpected_capability_activity',
        detail:
          `声明了这一轮**不该**发生，但观测到了痕迹` +
          `（portWired=${String(reading.portWired)} / enteredDownstream=${String(reading.enteredDownstream)}）`,
      })
    }
  }

  /*
   * `trigger_not_declared`：这一轮**没有任何预先声明** ⇒ 它的"安静"不能当证据。
   * 它是**问题**而不是通过 —— 否则"什么都没检查"与"全都没问题"在输出上一样（§4.6 ④）。
   */
  if ((turn.expectations ?? []).length === 0) {
    problems.push({
      scenarioId: turn.scenarioId,
      capability: 'recall',
      kind: 'trigger_not_declared',
      detail: '这一轮没有预先声明"应该触发什么" ⇒ 它不能作为任何能力的装配证据',
    })
  }

  return { readings, problems }
}

/** 读一整套运行（多轮） */
export function readAssemblyRuntime(turns: readonly RuntimeTurnEvidence[]): AssemblyRuntimeReadout {
  if (turns.length === 0) {
    return { readings: [], problems: [], verdict: 'MEASUREMENT INVALID' }
  }
  const readings: CapabilityReading[] = []
  const problems: AssemblyRuntimeProblem[] = []
  for (const turn of turns) {
    const { readings: turnReadings, problems: turnProblems } = readTurnAssembly(turn)
    readings.push(...turnReadings)
    problems.push(...turnProblems)
  }
  const failures = problems.filter((problem) => problem.kind !== 'trigger_not_declared')
  const evidence = readings.filter((reading) => reading.countsAsEvidence)
  /*
   * 三层判决，缺一不可：
   *   ① 没有可作证据的读数 ⇒ **MEASUREMENT INVALID**（"没测到"不是 PASS）
   *   ② 有具名缺陷 ⇒ FAIL
   *   ③ 其余 ⇒ PASS（且"未声明触发条件"的那些轮次已经在 problems 里如实列着）
   */
  const verdict =
    evidence.length === 0 ? 'MEASUREMENT INVALID' : failures.length > 0 ? 'FAIL' : 'PASS'
  return { readings, problems, verdict }
}
