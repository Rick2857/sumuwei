/**
 * M3 评测引擎 —— 把套件定义跑成 `EvalReport`。
 *
 * ============================================================================
 *  离线 / 真实模型走**同一条**代码路径
 * ============================================================================
 * 计划书第 144–146 节把评测分成三档：
 *
 *     PR smoke（离线、秒级）        → `scripts/eval-m3.ts`      modelMode = echo
 *     Release gate（真实模型）      → `scripts/eval-m3-live.ts` modelMode = real
 *     Promptfoo 外层                → 它调上面两支脚本，不重复实现
 *
 * 三档必须**同一套用例、同一套判定**，否则"CI 绿了但 release 挂了"
 * 就永远查不出原因。所以差别只有三处，且都在这里显式写明：
 *
 *   1. 跑哪些用例：`requiresModel === false` vs `=== true`
 *   2. 模型从哪来：不给（echo 回显）vs 注入 `invokeModel`
 *   3. judge 检查：一律 `skipped`（离线）vs 真的打分
 *
 * 确定性检查在两档里**都是真的在跑**（不是桩），这一点很重要：
 * 否则"能程序判断的不用 Judge"（第 52 节）就退化成"离线什么都不判"。
 */

import type {
  CheckResult,
  EvalCase,
  EvalCaseResult,
  EvalCheck,
  EvalObservation,
  EvalReport,
  EvalRuntimeFacade,
  EvalSuite,
  EvalThresholds,
  JudgeCheck,
  M3Metric,
} from '../types.ts'
import { M3_HARD_ZERO_METRICS } from '../types.ts'
import { createM3Host } from './host.ts'
import {
  AGGREGATE_OBSERVATION,
  JUDGE_DIMENSION_TO_METRIC,
  METRIC_DIRECTIONS,
  metricOf,
} from './metrics.ts'
import {
  M3_RUNTIME_PORT,
  parseJudgeOutput,
  type JudgeOutcome,
  type M3RuntimePort,
  type CharacterModelInvoker,
  type ModelInvoker,
} from './ports.ts'

// ---------------------------------------------------------------------------
// 输入
// ---------------------------------------------------------------------------

export interface RunM3Options {
  suites: readonly EvalSuite[]
  live: boolean
  /**
   * judge 用的模型口。
   *
   * 离线时**必须**为 undefined —— 那样 judge 检查一律 `skipped`，
   * 报告里 `live:false`，任何人一眼就能看出"这次没测人格"。
   */
  invokeModel?: ModelInvoker
  /** 只跑指定套件 id */
  suiteIds?: readonly string[]
  /** 子串过滤（匹配用例 id / 套件 id / 标签） */
  filter?: string
  /** 报告里的模型标识 */
  modelProfile: string
  thresholds: EvalThresholds
  /** 进度回调（CLI 用来打点） */
  onCase?: (info: { caseId: string; suiteId: string }) => void
  /** judge 的模型标识（进报告） */
  judgeModel?: string
  /**
   * judge prompt 观察钩子（**诊断用**）。
   *
   * 存在的理由是一次真实事故：live 档跑出 PC = 0.05，而 rubric
   * 因为"类型签名说是 string、实际传进来是 string[]"没有被渲染进 prompt ——
   * judge 对着**没有评分标准**的输入打分，而报告里那个 0.05
   * 看起来像一个真实结论（"她价值取向不对"），实际上只说明评测坏了。
   *
   * 有了这个钩子，`scripts/diag-m3-judge.ts` 能把**实际发出去的 prompt**
   * 打印出来。这是排查评测问题的第一步，与主链路的 `--dump-prompt` 同源：
   * 先看它看到了什么，再问它为什么这么答。
   */
  onJudgePrompt?: (prompt: string) => void
  /**
   * **角色自己**的模型调用口（不传 = 离线 echo 模式）。
   *
   * 与 `invokeModel`（judge 用）刻意分开：一个要的是"她会说的话"，
   * 另一个要的是"一个分数"。共用会让某天她的回复里出现一段 JSON 分数，
   * 而 judge 会认真地去评那段 JSON。
   */
  invokeCharacterModel?: CharacterModelInvoker
}

export interface RunM3Output {
  report: EvalReport
  /** 每条用例的原始观测（给"报告之外还想深挖"的地方用；不进 JSON 报告） */
  observations: Map<string, EvalObservation[]>
  /** judge 的原始输出（解析失败诊断用；键是 `${caseId}::${checkId}`） */
  judgeRaw: Map<string, string>
  /**
   * 具名 / 匿名两轮里**同名检查**的分数（T12 的 Anonymous Persona Gap 用它算）。
   *
   * 之所以由引擎交出来而不是让脚本自己扫报告：只有引擎知道
   * "这条检查在两个模式里是同一个 checkId"。
   */
  scores: Map<string, number>
}

// ---------------------------------------------------------------------------
// 过滤
// ---------------------------------------------------------------------------

export function selectSuites(
  suites: readonly EvalSuite[],
  options: { suiteIds?: readonly string[]; filter?: string }
): EvalSuite[] {
  let selected = [...suites]
  if (options.suiteIds && options.suiteIds.length > 0) {
    const wanted = new Set(options.suiteIds)
    selected = selected.filter((suite) => wanted.has(suite.id))
  }
  if (options.filter) {
    const needle = options.filter.toLowerCase()
    selected = selected
      .map((suite) => ({
        ...suite,
        cases: suite.cases.filter((item) =>
          [item.id, suite.id, ...item.tags].some((value) => value.toLowerCase().includes(needle))
        ),
      }))
      .filter((suite) => suite.cases.length > 0)
  }
  return selected
}

/** 一个用例在这一档评测里要不要跑（离线只跑不需要模型的） */
export function shouldRunCase(item: EvalCase, live: boolean): boolean {
  return live ? item.requiresModel : !item.requiresModel
}

// ---------------------------------------------------------------------------
// 单条用例
// ---------------------------------------------------------------------------

export async function runCase(
  suite: EvalSuite,
  item: EvalCase,
  options: RunM3Options
): Promise<{
  result: EvalCaseResult
  observations: EvalObservation[]
  raw: Map<string, string>
  scores: Map<string, number>
}> {
  const started = Date.now()
  options.onCase?.({ caseId: item.id, suiteId: suite.id })

  const host = await createM3Host(sanitize(item.id), {
    ...(item.displayNameOverride ? { displayName: item.displayNameOverride } : {}),
    // 不传 = 离线（echo）模式：她"看到什么"被回显，人格检查不适用。
    // 传了 = 她真的说话，judge 才有东西可评（见 ports.ts 的说明）。
    ...(options.invokeCharacterModel
      ? { invokeCharacterModel: options.invokeCharacterModel }
      : {}),
  })
  const facade = withHostBindings(host, options)

  const observations: EvalObservation[] = []
  const fixtureAttributes: Record<string, unknown> = {}

  try {
    for (const turn of item.prelude ?? []) {
      observations.push(await facade.say(turn.user))
    }

    // 装置在**对话之外**做准备工作（重启 / 开新会话 / 具名追加事件）
    if (item.fixture) {
      const produced = await item.fixture(facade)
      for (const observation of produced.observations ?? []) observations.push(observation)
      Object.assign(fixtureAttributes, produced.attributes ?? {})
    }

    for (const turn of item.turns) {
      observations.push(await facade.say(turn.user))
    }
  } finally {
    await host.dispose()
  }

  // 用例自己的元数据（例如匿名模式用的显示名）合并进每条观测，
  // 这样"检查只读观测"这条纪律不会被打破。
  //
  // ⚠️ 装置自己造的**聚合观测**（`AGGREGATE_OBSERVATION`）不参与改写：
  // 它本来就是装置按自己的意图攒出来的，再覆盖会把它的语义弄丢。
  //
  // `modelMode` 在这里被写进每条观测：它是"这条检查该不该判"的依据之一。
  // 离线（echo）模式下"回复"不是她的话，而是引擎合成的机器可读串，
  // 因此像"回复里不得出现 section 名"这类检查必须让路
  // （见 `support.ts` 的 `det({ echoAware: true })`）。
  // 判定依据必须来自**引擎**（它才知道有没有注入**角色**模型口），
  // 而不是套件自己声明 —— 也不是看有没有 judge 的口：
  // 两者可以只配一个，而"她有没有真的说话"取决于前者。
  const modelMode = options.invokeCharacterModel ? 'real' : 'echo'
  const enriched = observations.map((observation) =>
    observation.attributes?.[AGGREGATE_OBSERVATION] === true
      ? { ...observation, caseId: item.id }
      : {
          ...observation,
          caseId: item.id,
          attributes: {
            ...(observation.attributes ?? {}),
            caseId: item.id,
            suiteId: suite.id,
            displayName: item.displayNameOverride ?? '苏沐薇',
            modelMode,
            ...fixtureAttributes,
          },
        }
  )

  const raw = new Map<string, string>()
  const scores = new Map<string, number>()
  const deterministic: EvalCaseResult['deterministic'] = []
  const judged: EvalCaseResult['judged'] = []

  // --- 确定性检查：逐条跑，**异常也算失败** ---------------------------------
  for (const check of item.checks) {
    if (check.kind !== 'deterministic') continue
    const outcome = evaluate(check, enriched)
    deterministic.push({
      id: check.id,
      pass: outcome.pass,
      ...(outcome.detail ? { detail: outcome.detail } : {}),
      ...(outcome.measured ? { measured: outcome.measured } : {}),
    })
  }

  // --- judge 检查：离线 skipped；真实模型下失败安全解析 ----------------------
  for (const check of item.checks) {
    if (check.kind !== 'judge') continue
    const scored = await judge(check, item, enriched, options)
    judged.push({
      id: check.id,
      metric: check.metric,
      status: scored.status,
      ...(scored.score === undefined ? {} : { score: scored.score }),
      detail: scored.detail,
    })
    if (scored.raw !== undefined) raw.set(`${item.id}::${check.id}`, scored.raw)
    if (scored.status === 'scored' && scored.score !== undefined) {
      scores.set(`${item.id}::${check.id}`, scored.score)
    }
  }

  const passed =
    deterministic.every((entry) => entry.pass) &&
    judged.every((entry) => entry.status === 'skipped' || (entry.score ?? 0) >= judgeFloor(item))

  return {
    result: {
      caseId: item.id,
      suiteId: suite.id,
      metric: item.metric,
      passed,
      deterministic,
      judged,
      observations: enriched.length,
      durationMs: Date.now() - started,
    },
    observations: enriched,
    raw,
    scores,
  }
}

/** judge 的通过线：检查自己的，缺省 0.6（`types.ts` 的约定） */
function judgeFloor(item: EvalCase): number {
  const explicit = item.checks
    .filter((check): check is JudgeCheck => check.kind === 'judge')
    .map((check) => check.threshold)
    .filter((value): value is number => typeof value === 'number')
  return explicit.length > 0 ? Math.min(...explicit) : 0.6
}

/** 跑一条确定性检查，并把异常收敛成失败（断言内部报错不该中断整套） */
/**
 * 跑一条确定性检查。
 *
 * ============================================================================
 *  ⚠️ 必须**逐条观测**跑，不能只跑最后一条
 * ============================================================================
 * 第一版只把 `observations[observations.length - 1]` 交给检查。
 * 那个写法在两个真实场景下直接产生假失败：
 *
 *   1. **装置造的观测**（T6/T7/T8 的关键）
 *      `M3-SRC-001` 的装置先用具名操作写一条系统事件并交出一条观测，
 *      然后主轮次又产出另一条 —— 检查要看的正是装置那条，
 *      而"最后一条"永远是主轮次那条。症状是
 *      "装置没有成功写入系统事件"，而库里那条事件是对的。
 *
 *   2. **前置轮次**（`prelude`）
 *      用例用 prelude 制造"已经聊了很久"的处境，
 *      而断言往往要看 prelude 期间的事件。只看最后一条就漏掉了它们。
 *
 * 语义因此定为"**逐条跑，任一通过即通过**"：
 *   · 对"某一条观测该满足"的检查（绝大多数）—— 这是对的
 *   · 对"所有观测都必须满足"的检查 —— 它们**本来就该**用
 *     `everyEvent(...)` / `everyObservation(...)` 这类内部遍历器写出来
 *     （那样失败细节也更准），而不是靠引擎只跑一条来实现
 *
 * 失败时把**各条的结论**都带上：一句"没有系统事件"无法定位问题，
 * 而"第 1 条：✅；第 2 条：❌ 没有 system actor"可以。
 */
function evaluate(check: EvalCheck, observations: readonly EvalObservation[]): CheckResult {
  if (check.kind !== 'deterministic') return { pass: false, detail: '不是确定性检查' }
  if (observations.length === 0) {
    return { pass: false, detail: '用例没有产出任何观测（装置可能失败了）' }
  }

  const outcomes: { index: number; result: CheckResult }[] = []
  for (let index = 0; index < observations.length; index += 1) {
    try {
      outcomes.push({ index, result: check.check(observations[index]) })
    } catch (error) {
      outcomes.push({
        index,
        result: {
          pass: false,
          detail: `检查抛出异常：${error instanceof Error ? error.message : String(error)}`,
        },
      })
    }
  }

  const passed = outcomes.find((o) => o.result.pass)
  if (passed) return passed.result

  // 全都没过：第一条的细节最接近"主轮次"，但把它逐条列出更有用
  const detail = outcomes
    .map((o) => `第 ${o.index + 1} 条：${o.result.detail ?? '未通过'}`)
    .join('；')
  return { pass: false, detail }
}

// ---------------------------------------------------------------------------
// judge
// ---------------------------------------------------------------------------

async function judge(
  check: JudgeCheck,
  item: EvalCase,
  observations: readonly EvalObservation[],
  options: RunM3Options
): Promise<JudgeOutcome> {
  if (!options.invokeModel) {
    return {
      status: 'skipped',
      detail: '离线模式（echo）：judge 检查不做，须用 scripts/eval-m3-live.ts 跑',
    }
  }
  if (observations.length === 0) {
    return { status: 'skipped', detail: '没有可评分的观测（用例没有产出回复）' }
  }

  const last = observations[observations.length - 1]
  const prompt = renderRubric(check.rubric, {
    reply: last.reply,
    question: item.turns[item.turns.length - 1]?.user ?? '',
    seedTraits: renderSeedTraits(last.identity.definition),
    seedValues: renderSeedValues(last.identity.definition),
    seedStyle: renderSeedStyle(last.identity.definition),
  })

  // 诊断钩子：让排查脚本能拿到**实际发给模型的那段 prompt**。
  // 与 `--dump-prompt` 对主链路的意义相同 —— 排查评测问题时，
  // 第一步永远是"看它到底看到了什么"，而不是猜分数为什么低。
  options.onJudgePrompt?.(prompt)

  try {
    const result = await options.invokeModel(prompt)
    const parsed = parseJudgeOutput(result.raw)
    return { ...parsed, durationMs: result.durationMs }
  } catch (error) {
    // 模型调用失败**不等于**她人格漂移：记为 skipped，报告里写明原因
    return {
      status: 'skipped',
      detail: `judge 调用失败：${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/**
 * rubric 变量替换。
 *
 * 只支持具名变量，没有模板引擎 —— 因为 rubric 是**数据**，
 * 一旦它变成能求值的东西，"评分标准是什么"就不再是可审阅的文本了。
 *
 * ---------------------------------------------------------------------------
 *  ⚠️ 必须显式处理"传进来的是数组"这种情况
 * ---------------------------------------------------------------------------
 * 套件里的 rubric 大多写成多行字符串数组（`[...].join('\n')`），
 * 那个 `.join` 有时会被漏掉。而**漏掉的后果是静默的**：
 * `Array.prototype.replaceAll` 不存在 → 调用会抛错 →
 * 但更隐蔽的形态是"数组被当成值参与拼接"，于是整个 rubric 变成一串
 * 用逗号连接的片段，模型读到的是**没有评分标准的残句**。
 *
 * 实测踩到过：judge 实际收到的 prompt 只有 800 字符（就是最后那行 JSON 模板），
 * 于是它对着"没有任何评分标准"的输入打分，给出 0.05 ——
 * 而报告里那个 0.05 看起来像一个真实结论（"她价值取向不对"），
 * 实际上它只说明**评测本身坏了**。
 *
 * 因此这里把"字符串化"做成显式的一步：数组就用换行连接。
 * 这一类"类型签名说 string、实际传了 string[]"的问题
 * 不会报错，只会安静地测出一堆垃圾数字。
 */
export function renderRubric(
  rubric: string | readonly string[],
  values: {
    reply: string
    question: string
    seedTraits: string
    seedValues: string
    seedStyle: string
  }
): string {
  const template = Array.isArray(rubric) ? rubric.join('\n') : String(rubric)
  return template
    .replaceAll('{{reply}}', values.reply)
    .replaceAll('{{question}}', values.question)
    .replaceAll('{{seedTraits}}', values.seedTraits)
    .replaceAll('{{seedValues}}', values.seedValues)
    .replaceAll('{{seedStyle}}', values.seedStyle)
}

/** Seed → rubric 里的"人设表"（只重排，不发明） */
export function renderSeedTraits(definition: EvalObservation['identity']['definition']): string {
  return definition.personality.traits
    .map(
      (trait) =>
        `- ${trait.trait}（强度 ${trait.strength.toFixed(2)}）：${trait.description}` +
        (trait.counterExamples.length > 0
          ? `\n  · 不意味着：${trait.counterExamples.join('；')}`
          : '')
    )
    .join('\n')
}

export function renderSeedValues(definition: EvalObservation['identity']['definition']): string {
  return definition.values
    .map(
      (value) =>
        `- ${value.value}（优先级 ${value.priority.toFixed(2)}）：${value.description}` +
        (value.tradeoffNotes.length > 0
          ? `\n  · 权衡：${value.tradeoffNotes.join('；')}`
          : '')
    )
    .join('\n')
}

export function renderSeedStyle(definition: EvalObservation['identity']['definition']): string {
  const style = definition.communicationStyle
  return [
    `- 语气：${style.tone.join('、')}`,
    style.verbosity ? `- 详略：${style.verbosity}` : '',
    style.vocabulary?.length ? `- 用词：${style.vocabulary.join('、')}` : '',
    ...(style.habits ?? []).map((habit) => `- 习惯：${habit}`),
    ...(style.avoidances ?? []).map((item) => `- 不用：${item}`),
  ]
    .filter((line) => line !== '')
    .join('\n')
}

// ---------------------------------------------------------------------------
// 整套跑
// ---------------------------------------------------------------------------

export async function runM3(options: RunM3Options): Promise<RunM3Output> {
  const suites = selectSuites(options.suites, options)
  const results: EvalCaseResult[] = []
  const observations = new Map<string, EvalObservation[]>()
  const judgeRaw = new Map<string, string>()
  const scores = new Map<string, number>()

  for (const suite of suites) {
    for (const item of suite.cases) {
      if (!shouldRunCase(item, options.live)) continue
      const outcome = await runCase(suite, item, options)
      results.push(outcome.result)
      observations.set(item.id, outcome.observations)
      for (const [key, value] of outcome.raw) judgeRaw.set(key, value)
      for (const [key, value] of outcome.scores) scores.set(key, value)
    }
  }

  const hardZeroViolations = findHardZeroViolations(suites, results)

  return {
    report: {
      generatedAt: new Date().toISOString(),
      modelProfile: options.modelProfile,
      live: options.live && options.invokeModel !== undefined,
      results,
      metrics: aggregateMetrics(suites, results),
      thresholds: options.thresholds,
      hardZeroViolations,
    },
    observations,
    judgeRaw,
    scores,
  }
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

/**
 * 把逐条检查折叠成指标。
 *
 * 口径（也写在 `METRIC_DENOMINATORS` 里，方便报告与文档引用）：
 *   `measured` = 参与判定的检查条数
 *   `passed`   = 其中通过的条数
 *   `score`    = judge 类指标的平均分（确定性指标没有它）
 *
 * ⚠️ 硬零指标用**计数**口径（`measured` 恒为 1，`passed` = 违规次数为 0 ? 1 : 0），
 * 因为计划书第 116 节说的是"任何一次都属于 critical failure"：
 * 一个比率会掩盖"只错了一次"。
 */
export function aggregateMetrics(
  suites: readonly EvalSuite[],
  results: readonly EvalCaseResult[]
): EvalReport['metrics'] {
  const checkMetric = new Map<string, M3Metric | undefined>()
  for (const suite of suites) {
    for (const item of suite.cases) {
      for (const check of item.checks) {
        checkMetric.set(
          `${item.id}::${check.id}`,
          check.kind === 'judge' ? JUDGE_DIMENSION_TO_METRIC[check.metric] : metricOf(check)
        )
      }
    }
  }

  const buckets = new Map<
    M3Metric,
    { measured: number; passed: number; scores: number[]; violations: number }
  >()
  const bucket = (metric: M3Metric) => {
    const existing = buckets.get(metric)
    if (existing) return existing
    const created = { measured: 0, passed: 0, scores: [] as number[], violations: 0 }
    buckets.set(metric, created)
    return created
  }

  for (const result of results) {
    for (const entry of result.deterministic) {
      const metric = checkMetric.get(`${result.caseId}::${entry.id}`)
      if (!metric) continue
      const target = bucket(metric)
      if (METRIC_DIRECTIONS[metric] === 'zero') {
        // 硬零指标：measured 记 1（这是"一次观测"），不通过就是一次违规
        target.measured += 1
        if (entry.pass) target.passed += 1
        else target.violations += 1
      } else {
        target.measured += 1
        if (entry.pass) target.passed += 1
      }
    }
    for (const entry of result.judged) {
      const metric = JUDGE_DIMENSION_TO_METRIC[entry.metric as JudgeCheck['metric']]
      if (!metric) continue
      const target = bucket(metric)
      target.measured += 1
      if (entry.status === 'scored' && entry.score !== undefined) {
        target.scores.push(entry.score)
        if (entry.score >= 0.6) target.passed += 1
      } else {
        // skipped 计为通过：它不是失败，只是这次没测到（诚实优于虚假的绿灯）
        target.passed += 1
      }
    }
  }

  const metrics: EvalReport['metrics'] = {}
  for (const metric of buckets.keys()) {
    const target = buckets.get(metric)!
    const entry: EvalReport['metrics'][string] = {
      measured: target.measured,
      passed: target.passed,
    }
    if (target.scores.length > 0) {
      entry.score = target.scores.reduce((sum, value) => sum + value, 0) / target.scores.length
    }
    metrics[metric as string] = entry
  }
  return metrics
}

/**
 * 硬零指标的违规判定。
 *
 * 四个硬零指标**只有一种**通过形态：整份报告里一条违规都没有。
 * 因此这里不看比率，只看"有没有"—— 这正是计划书第 116 节要的语义。
 *
 * ⚠️ 重要：只有**真的跑过**的用例才参与判定。离线档跳过的人格用例
 * （`requiresModel`）不该被算成"没违规所以通过"，也不该被算成违规 ——
 * 报告里它们根本不出现在 `results` 里，所以这里是自然的。
 */
export function findHardZeroViolations(
  suites: readonly EvalSuite[],
  results: readonly EvalCaseResult[]
): EvalReport['hardZeroViolations'] {
  const violations: EvalReport['hardZeroViolations'] = []
  const hardZero = new Set<string>(M3_HARD_ZERO_METRICS)

  const checkMetric = new Map<string, M3Metric | undefined>()
  for (const suite of suites) {
    for (const item of suite.cases) {
      for (const check of item.checks) {
        checkMetric.set(
          `${item.id}::${check.id}`,
          check.kind === 'judge' ? JUDGE_DIMENSION_TO_METRIC[check.metric] : metricOf(check)
        )
      }
    }
  }

  for (const result of results) {
    for (const entry of result.deterministic) {
      const metric = checkMetric.get(`${result.caseId}::${entry.id}`)
      if (!metric || !hardZero.has(metric)) continue
      if (!entry.pass) {
        violations.push({
          metric,
          value: 1,
          caseId: result.caseId,
          detail: entry.detail ?? `${entry.id} 未通过`,
        })
      }
    }
  }
  return violations
}

// ---------------------------------------------------------------------------
// 内部
// ---------------------------------------------------------------------------

/**
 * 给 facade 挂上"这台运行环境是谁"。
 *
 * 装置的签名是 `(facade) => …`，因此它只能通过 `facade` 拿到能力。
 * 把运行环境句柄放进 `attributes`（类型里已存在的自由通道）之后，
 * 装置与检查都能取到它，而**冻结类型一个字都不用改**。
 */
function withHostBindings(
  host: Awaited<ReturnType<typeof createM3Host>>,
  options: RunM3Options
): EvalRuntimeFacade {
  const port = host.facade.attributes[M3_RUNTIME_PORT] as
    | M3RuntimePort
    | undefined
  if (port && options.invokeModel) port.invokeModel = options.invokeModel
  return host.facade
}

/** 用例 id 里的非法字符（进目录名） */
function sanitize(text: string): string {
  return text.replace(/[^A-Za-z0-9_-]+/g, '-')
}

export { M3_RUNTIME_PORT, type M3RuntimePort }
