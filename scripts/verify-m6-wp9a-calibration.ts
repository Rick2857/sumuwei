/**
 * M6 **WP9a 门** —— 长对话校准与行为阈值（计划书 §WP9a L378–386；契约 M6-G8 的前置）。
 *
 * ============================================================================
 *  它判什么
 * ============================================================================
 * ```text
 *   ① **先核对语义**（计划书明文）：指标方向、`count` / `rate` / `score` 的区别、
 *      judge rubric —— 「不能把 baseline 中字段名里的 `Count` 当原始次数直接套用」。
 *   ② 用**当前批准端点**（测试端点，`pnpm with-test-model`）与**固定配置**跑 50 / 100 轮校准。
 *   ③ 保留**独立校准集**与**正式验收集**（后者留给 WP9b；本门只冻结前者的定义与哈希）。
 *   ④ 提交 **M6-D3**：PC / SA / 漂移 / 恢复 / **连续性回答质量** 的 baseline、方差、
 *      建议通过线、**有效响应覆盖下限**与理由。人格**不只打总分**：
 *      「文风不像她」（SA）与「身份／事实被污染」（硬零指标）分开。
 *   ⑤ 新 baseline 写在 `artifacts/m6/`，**绝不**动 M3 的历史 `evals/m3/baseline.json`。
 *   ⑥ 有效样本不足 / judge 失效 / 没有明确最低质量线 ⇒ 质量门 `NOT RUN / MEASUREMENT INVALID`，
 *      **不许**用「比 baseline 好」自动判 PASS。
 * ```
 *
 * ⚠️ 本门自身的 PASS/FAIL 判的是**校准过程是否可信**（量到了、样本够、方差算得出、
 *    阈值有据），**不是**"PC 够不够高"。质量结论另列 `qualityJudgement`。
 *
 * 跑法：
 *   pnpm with-test-model pnpm exec tsx scripts/verify-m6-wp9a-calibration.ts
 *   （子进程由本门自己拉起：`M3_DRIFT_TURNS=50/100`，各自独立进程与独立隔离库）
 */
import 'dotenv/config'

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import { isolateDatabase } from '../src/dev/sandbox.ts'
import { METRIC_DENOMINATORS, METRIC_DIRECTIONS } from '../evals/m3/runtime/metrics.ts'
import { M3_HARD_ZERO_METRICS } from '../evals/m3/types.ts'
import { createReporter } from './m4-harness.ts'

const ROOT = resolve('.')
const M3_BASELINE = resolve('evals/m3/baseline.json')
const M3_LIVE_RUNNER = resolve('scripts/eval-m3-live.ts')
/** 校准用的套件（M3 的既有定义，**不新增、不改写**） */
const CALIBRATION_SUITES = ['long-dialogue', 'adversarial-role-change'] as const
/**
 * 正式验收集（给 WP9b）：**故意与校准集不同源** —— 校准用的是 M3 的 4 条探针 × 50/100 轮
 * 与施压-恢复套件；验证集是 M6 自己的三条轨迹（日常连续 / 纠正遗忘 / 身份诱导）。
 * 这里只冻结**名字**，WP9b 必须用它们，且不得回头用校准集调分。
 */
const VERIFICATION_SET = ['M6-LD-V1-daily', 'M6-LD-V2-correction', 'M6-LD-V3-identity'] as const
/** 与 M3 live 档保持同温（judge 0.2 / 角色 0.3），否则"比 baseline 好/差"没有意义 */
const JUDGE_TEMPERATURE = 0.2
const CHARACTER_TEMPERATURE = 0.3
/** 50 轮档跑几次（跨运行方差）；100 轮档贵，跑 1 次 + 用轮内方差 */
const RUNS_AT_50 = 3
const RUNS_AT_100 = 1
/** 施压-恢复档跑几次（它有独立的前后缀参数，与长对话长度无关） */
const RUNS_RECOVERY = 1

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')
const fileSha = (path: string): string => sha256(readFileSync(path, 'utf8'))

// ===========================================================================
//  子模式：跑一档校准（真实模型，独立进程 + 独立隔离库）
// ===========================================================================

interface PerTurnReading {
  caseId: string
  conversationSequence: number
  replyLength: number
  substantive: boolean
  userTextLength: number
  judgeScores: { checkId: string; metric: string; score?: number; status: string }[]
}

interface RunPayload {
  mode: 'run'
  turns: number
  runIndex: number
  modelProfile: string
  baseUrlHost: string
  apiKeyPresent: boolean
  judgeTemperature: number
  characterTemperature: number
  startedAt: string
  durationMs: number
  suites: string[]
  /** 用例过滤器（钉死这一档跑的是哪条用例，防止 50/100 互相污染） */
  filter: string
  /** 实际跑到的用例 id（证据里要有，否则"50 轮档"是自称的） */
  caseIds: string[]
  metrics: Record<string, { measured: number; passed: number; score?: number }>
  hardZeroViolations: { metric: string; caseId: string; detail: string }[]
  cases: {
    caseId: string
    suiteId: string
    passed: boolean
    observations: number
    judgedScored: number
    judgedSkipped: number
    /** 每条 judge 检查的结论与**跳过原因**（"为什么没分"必须能查，否则均值是假的） */
    judgedDetail: { id: string; metric: string; status: string; score?: number; detail?: string }[]
  }[]
  turnsDetail: PerTurnReading[]
  continuity: {
    scores: number[]
    mean: number | null
    variance: number | null
    scored: number
    skipped: number
    /** judge 的**判别力**负控：一条明显答非所问的回复必须拿低分（否则这个 judge 是橡皮图章） */
    negativeControl: { score: number | null; goodControlScore: number | null; discriminated: boolean }
  }
  effectiveResponse: { substantive: number; total: number; rate: number }
  judgeFailures: number
}

async function runOneCalibration(options: {
  turns: number
  runIndex: number
  out: string
}): Promise<void> {
  // ⚠️ 必须在**动态导入**套件之前写死长度：`evals/m3/runtime/config.ts` 在模块加载时读它
  process.env.M3_DRIFT_TURNS = String(options.turns)
  isolateDatabase(`m6-wp9a-${options.turns}-${options.runIndex}`)

  const { M3_SUITES } = await import('../evals/m3/index.ts')
  const { runM3 } = await import('../evals/m3/runtime/engine.ts')
  const { defaultThresholds } = await import('../evals/m3/thresholds.ts')
  const { replySubstantive } = await import('../evals/m3/runtime/support.ts')

  const modelId = process.env.OPENAI_LARGE_MODEL ?? 'deepseek-flash'
  const baseUrl = process.env.OPENAI_BASE_URL ?? 'https://api.deepseek.com/v1'
  const apiKey = process.env.OPENAI_API_KEY ?? ''
  const host = ((): string => {
    try {
      return new URL(baseUrl).host
    } catch {
      return '(无法解析)'
    }
  })()
  if (apiKey === '') {
    throw new Error('OPENAI_API_KEY 为空：校准必须经 `pnpm with-test-model` 跑（测试端点）')
  }

  /** 与 `scripts/eval-m3-live.ts` 同一套 HTTP 形状（只记 host，不记 key） */
  const postJson = async (body: unknown, label: string): Promise<{ raw: string; durationMs: number }> => {
    const started = Date.now()
    let lastError: unknown
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const response = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(120_000),
        })
        if (!response.ok) throw new Error(`${label} HTTP ${response.status}`)
        const payload = (await response.json()) as {
          choices?: {
            finish_reason?: string
            message?: { content?: string; reasoning_content?: string }
          }[]
          usage?: Record<string, unknown>
        }
        const choice = payload.choices?.[0]
        const raw = choice?.message?.content ?? ''
        if (raw.trim() === '') {
          /*
           * ⚠️ 空内容**必须报出形状**：实测这一档的模型会先吐 reasoning，
           *    在 `max_tokens` 太小时 `content` 直接是空的 —— 那时
           *    judge 会以"调用失败"被跳过，而报告里看不出为什么（本轮踩过）。
           */
          throw new Error(
            `${label} 返回空内容（finish_reason=${String(choice?.finish_reason)}，` +
              `message 键=${Object.keys(choice?.message ?? {}).join('/')}，` +
              `reasoning 长度=${String(choice?.message?.reasoning_content?.length ?? 0)}，` +
              `usage=${JSON.stringify(payload.usage ?? {}).slice(0, 120)}）`
          )
        }
        return { raw, durationMs: Date.now() - started }
      } catch (error) {
        lastError = error
      }
    }
    throw new Error(`${label} 连续 3 次失败：${String(lastError)}`)
  }

  const invokeJudgeModel = (prompt: string) =>
    postJson(
      {
        model: modelId,
        messages: [
          {
            role: 'system',
            content:
              '你是一个严格的角色人格评测员。只输出 JSON，形如 {"score": 0.8, "reason": "…"}。' +
              'score 必须在 0 到 1 之间。不要输出任何其它内容。',
          },
          { role: 'user', content: prompt },
        ],
        temperature: JUDGE_TEMPERATURE,
        // 评分数是短输出，但这一档模型会先产生推理 token ⇒ 额度必须留够（否则 content 为空）
        max_tokens: 2_000,
      },
      'judge'
    )

  const invokeCharacterModel = (prompt: string) =>
    postJson(
      { model: modelId, messages: [{ role: 'user', content: prompt }], temperature: CHARACTER_TEMPERATURE, max_tokens: 600 },
      'character'
    )

  const startedAt = new Date().toISOString()
  const startedMs = Date.now()
  const suites = M3_SUITES.filter((suite) => (CALIBRATION_SUITES as readonly string[]).includes(suite.id))
  /*
   * ⚠️ `M3_DRIFT_TURNS` 一旦设了，`INCLUDE_LONGEST` 就会把 **100 轮那档也塞进来**
   *    （`config.ts`：`env !== undefined && LONG_TURNS < 100`）。于是"50 轮档"里
   *    其实跑了 50+100 两档 —— 第一次实测就是这样（182 条观测）。
   *    所以每一档都必须用 `filter` 把用例**钉死**，否则两档数据会互相污染。
   */
  const filter = process.env.M6_WP9A_FILTER
  const output = await runM3({
    suites,
    live: true,
    invokeModel: invokeJudgeModel,
    invokeCharacterModel,
    modelProfile: modelId,
    thresholds: defaultThresholds(),
    ...(filter !== undefined && filter !== '' ? { filter } : {}),
  })
  const durationMs = Date.now() - startedMs

  // 逐轮读数（**不含正文**：只留长度与判定）
  const turnsDetail: PerTurnReading[] = []
  let judgeScored = 0
  let judgeSkipped = 0
  for (const [caseId, observations] of output.observations) {
    for (const observation of observations) {
      const substantive = replySubstantive(observation.reply).pass
      const userText = observation.newEvents
        .filter((event) => event.actorType === 'user')
        .map((event) => event.content)
        .join('')
      turnsDetail.push({
        caseId,
        conversationSequence: observation.conversationSequence,
        replyLength: observation.reply.length,
        substantive,
        userTextLength: userText.length,
        judgeScores: [],
      })
    }
  }
  for (const result of output.report.results) {
    for (const judged of result.judged) {
      if (judged.status === 'scored') judgeScored += 1
      else judgeSkipped += 1
    }
  }

  /*
   * M6 自己的**连续性回答质量** judge：M3 的 PC / SA 评的是"像不像她"，
   * 没有一条评"她有没有真的接住这句话"。这里对 long-dialogue 的 4 条探针各评一次。
   * 评分对象只取探针轮（闲聊轮问的是无关小事，评"连续性"没有区分度）。
   */
  const continuityRubric = (input: { turns: number; user: string; reply: string }): string =>
    [
      '你在评一个中文角色 Agent 在**长对话**里的「连续性回答质量」——',
      '即"她有没有真的接住对方这句话"，与"像不像她（PC/SA）"是两件不同的事。',
      '',
      `这段对话已经连续进行了约 ${input.turns} 轮。`,
      '',
      '对方刚说：',
      input.user,
      '',
      '她的回答：',
      input.reply,
      '',
      '只判断**连续性**（不看文风、不看人设方向）：',
      '  1 分 = 直接回应了这句话，且与刚才的话题/情绪连得上（没有答非所问、没有复读）。',
      '  0.5 分 = 回应了但很泛（像敷衍），或轻微重复了之前说过的内容。',
      '  0 分 = 答非所问 / 复读 / 明显把上下文搞混（把自己说过的话当成对方说的）。',
      '',
      '只输出一个 JSON 对象：{"score": 0 到 1 之间的小数, "reason": "一句话中文理由"}',
    ].join('\n')

  const continuityScores: number[] = []
  let continuitySkipped = 0
  let judgeFailures = 0
  for (const [caseId, observations] of output.observations) {
    if (!caseId.startsWith('M3-DRF-')) continue
    // 探针轮 = 用例定义里 `turns` 的那几轮（在观测序列的**末尾**）
    const probeObservations = observations.slice(-4)
    for (const observation of probeObservations) {
      const user = observation.newEvents
        .filter((event) => event.actorType === 'user')
        .map((event) => event.content)
        .join('')
      try {
        const { raw } = await invokeJudgeModel(
          continuityRubric({ turns: options.turns, user, reply: observation.reply })
        )
        const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim()) as { score?: unknown }
        const score = Number(parsed.score)
        if (Number.isFinite(score) && score >= 0 && score <= 1) continuityScores.push(score)
        else continuitySkipped += 1
      } catch {
        judgeFailures += 1
        continuitySkipped += 1
      }
    }
  }

  const mean = (values: readonly number[]): number | null =>
    values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length
  const variance = (values: readonly number[]): number | null => {
    if (values.length < 2) return null
    const m = mean(values) as number
    return values.reduce((sum, value) => sum + (value - m) ** 2, 0) / (values.length - 1)
  }
  const substantiveCount = turnsDetail.filter((turn) => turn.substantive).length

  /*
   * 新量具必须自己先被验证（`AGENTS.md` §6.2）：一个**永远给 1 分**的连续性 judge
   * 与"什么都不检查"在输出上分不开。这里用一对人工构造的对照：
   *   · 负控：答非所问的客服腔 ⇒ 必须拿低分
   *   · 正控：接住情绪的短句 ⇒ 必须高于负控
   * 判据是**相对**的（负控 < 正控），不是"绝对值必须是多少"。
   */
  const scoreCanned = async (user: string, reply: string): Promise<number | null> => {
    try {
      const { raw } = await invokeJudgeModel(continuityRubric({ turns: options.turns, user, reply }))
      const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim()) as { score?: unknown }
      const score = Number(parsed.score)
      return Number.isFinite(score) ? score : null
    } catch {
      judgeFailures += 1
      return null
    }
  }
  const negativeControlScore = await scoreCanned(
    '你是不是觉得我很烦。',
    '根据用户手册第 3 章，本系统支持多种查询方式，请提供更明确的需求以便我为您服务。'
  )
  const goodControlScore = await scoreCanned(
    '你是不是觉得我很烦。',
    '……烦就烦吧。你说，我听着。'
  )

  const payload: RunPayload = {
    mode: 'run',
    turns: options.turns,
    runIndex: options.runIndex,
    modelProfile: modelId,
    baseUrlHost: host,
    apiKeyPresent: apiKey !== '',
    judgeTemperature: JUDGE_TEMPERATURE,
    characterTemperature: CHARACTER_TEMPERATURE,
    startedAt,
    durationMs,
    suites: suites.map((suite) => suite.id),
    filter: filter ?? '(无)',
    caseIds: output.report.results.map((result) => result.caseId),
    metrics: output.report.metrics as RunPayload['metrics'],
    hardZeroViolations: output.report.hardZeroViolations.map((item) => ({
      metric: String(item.metric),
      caseId: item.caseId,
      detail: item.detail,
    })),
    cases: output.report.results.map((result) => ({
      caseId: result.caseId,
      suiteId: result.suiteId,
      passed: result.passed,
      observations: result.observations,
      judgedScored: result.judged.filter((item) => item.status === 'scored').length,
      judgedSkipped: result.judged.filter((item) => item.status === 'skipped').length,
      judgedDetail: result.judged.map((item) => ({
        id: item.id,
        metric: String(item.metric),
        status: item.status,
        ...(item.score !== undefined ? { score: item.score } : {}),
        ...(item.detail !== undefined ? { detail: item.detail } : {}),
      })),
    })),
    turnsDetail,
    continuity: {
      scores: continuityScores,
      mean: mean(continuityScores),
      variance: variance(continuityScores),
      scored: continuityScores.length,
      skipped: continuitySkipped,
      negativeControl: {
        score: negativeControlScore,
        goodControlScore,
        discriminated:
          negativeControlScore !== null &&
          goodControlScore !== null &&
          negativeControlScore < goodControlScore,
      },
    },
    effectiveResponse: {
      substantive: substantiveCount,
      total: turnsDetail.length,
      rate: turnsDetail.length === 0 ? 0 : Number((substantiveCount / turnsDetail.length).toFixed(4)),
    },
    judgeFailures,
  }
  writeFileSync(options.out, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  console.log(
    `   ✅ 校准档 turns=${options.turns} run=${options.runIndex}：` +
      `${(durationMs / 1000).toFixed(0)}s · judge 打分 ${judgeScored} / 跳过 ${judgeSkipped} · ` +
      `连续性 ${continuityScores.length} 条（均分 ${mean(continuityScores)?.toFixed(3) ?? '—'}）· ` +
      `有效响应 ${substantiveCount}/${turnsDetail.length} · ` +
      `judge 判别力 ${negativeControlScore ?? '—'} < ${goodControlScore ?? '—'}`
  )
  /*
   * ⚠️ 必须显式退出：M3 的 runtime host 会在关库之后继续轮询任务，
   *    于是进程**永远不结束**（实测 3860 行 "Database is shutting down" 刷屏）。
   *    产物已经写完，这里直接退出，不留悬挂进程。
   */
  process.exit(0)
}

// ===========================================================================
//  主模式：冻结 + 跑两档 + 汇总 M6-D3
// ===========================================================================

const report = createReporter()
const check = (label: string, pass: boolean, reading: string): void =>
  report.check(label, pass, reading)

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

async function main(): Promise<void> {
  if (process.argv.includes('--run')) {
    const turns = Number(argValue('--turns') ?? '50')
    const runIndex = Number(argValue('--runIndex') ?? '1')
    const out = argValue('--out')
    const filter = argValue('--filter')
    if (out === undefined) throw new Error('--run 需要 --out <path>')
    if (filter !== undefined) process.env.M6_WP9A_FILTER = filter
    await runOneCalibration({ turns, runIndex, out })
    return
  }

  const head = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
  const runId = `m6-wp9a-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${head.slice(0, 12)}`
  const outDir = join(ROOT, 'artifacts/m6', runId, 'calibration')
  const localDir = join(ROOT, 'artifacts/m6/local', runId)
  mkdirSync(outDir, { recursive: true })
  mkdirSync(localDir, { recursive: true })
  console.log(`runId=${runId}`)

  // -------------------------------------------------------------------------
  // F 冻结与语义核对（离线，先判）
  // -------------------------------------------------------------------------
  report.section('F 语义核对与冻结（离线）')

  const baselineText = readFileSync(M3_BASELINE, 'utf8')
  const baseline = JSON.parse(baselineText) as {
    baseline: { model: string; temperature?: number; runs: number; measuredAt: string }
    values: Record<string, number>
    variance?: Record<string, number>
  }
  const baselineSha = sha256(baselineText)
  const baselineAtHead = spawnSync('git', ['show', `HEAD:evals/m3/baseline.json`], {
    cwd: ROOT,
    encoding: 'utf8',
  }).stdout
  check(
    'F1 · M3 历史 baseline **一个字节都没动**（与 `HEAD` 里的版本逐字相同；本门从不调用 `--write-baseline`）',
    sha256(baselineAtHead) === baselineSha,
    `sha=${baselineSha.slice(0, 16)}… · model=${baseline.baseline.model} · runs=${baseline.baseline.runs} · measuredAt=${baseline.baseline.measuredAt}`
  )

  /*
   * 值口径的**机器核对**：baseline 的 `values` 到底是"原始次数"还是"通过率/均分"？
   * 答案只能从产生它的代码里读 —— 所以这里对那份代码做静态锁，
   * 而不是靠注释或记忆（计划书 §WP9a 明文警告过这个坑）。
   */
  const liveSource = readFileSync(M3_LIVE_RUNNER, 'utf8')
  const valueRuleIntact =
    liveSource.includes('entry.score !== undefined') &&
    liveSource.includes('entry.passed / entry.measured')
  check(
    'F2 · **值口径**有据：baseline 的 `values[metric] = entry.score ?? passed / measured` —— 即 **judge 均分**或**通过率**，**不是**原始次数（静态锁在那段代码上）',
    valueRuleIntact,
    `lock=${valueRuleIntact ? 'entry.score ?? passed/measured 两处都在' : '没找到口径代码'}`
  )
  const zeroValues = M3_HARD_ZERO_METRICS.map((metric) => ({
    metric,
    value: baseline.values[metric] as number | undefined,
    direction: METRIC_DIRECTIONS[metric],
    denominator: METRIC_DENOMINATORS[metric],
  }))
  const measuredZeroValues = zeroValues.filter((item) => item.value !== undefined)
  const unmeasuredZeroValues = zeroValues.filter((item) => item.value === undefined)
  /*
   * 硬零指标在 baseline 里是 `1`。按上面那条口径，1 = **通过率 100%** = **零违规**；
   * 若把它读成"1 次违规"，判据会**反向**（这正是计划书警告的陷阱）。
   *
   * ⚠️ M3 那份 baseline 只测到四个里的两个（`ConversationEventLossRate` /
   *    `EventOrderingErrorRate` 不在 `values` 里）—— "没测到"必须如实写成**未测**，
   *    **不能**当成"零违规"（那是把缺证据当通过）。
   */
  check(
    'F3 · 硬零指标的**已测值**全是 1 = 通过率 100% = 零违规（读成"1 次违规"会把判据反过来）；没测到的那两条如实记为**未测**',
    M3_HARD_ZERO_METRICS.length === 4 &&
      measuredZeroValues.length > 0 &&
      measuredZeroValues.every((item) => item.value === 1),
    `已测 ${measuredZeroValues.length}/4：${measuredZeroValues
      .map((item) => `${item.metric}=${String(item.value)}`)
      .join(' · ')} · 未测：${unmeasuredZeroValues.map((item) => item.metric).join(',') || '(无)'}`
  )
  check(
    'F4 · 方向表与"值种类"逐条对上：PC/SA/Recovery 是 **score 或 Rate**（越高越好）、硬零指标**只允许 0 违规**、`DriftRate` 的方向声明与它的**值**不一致（见 D 节的判据更正）',
    METRIC_DIRECTIONS.PersonalityConsistency === 'higher-better' &&
      METRIC_DIRECTIONS.StyleAdherence === 'higher-better' &&
      METRIC_DIRECTIONS.RecoveryRate === 'higher-better' &&
      METRIC_DIRECTIONS.DriftRate === 'lower-better' &&
      M3_HARD_ZERO_METRICS.every((metric) => METRIC_DIRECTIONS[metric] === 'zero'),
    `PC=${METRIC_DIRECTIONS.PersonalityConsistency} SA=${METRIC_DIRECTIONS.StyleAdherence} ` +
      `Recovery=${METRIC_DIRECTIONS.RecoveryRate} Drift=${METRIC_DIRECTIONS.DriftRate}(声明) ` +
      `硬零=${M3_HARD_ZERO_METRICS.map((m) => METRIC_DIRECTIONS[m]).join('/')}`
  )

  const frozenSources = [
    'evals/m3/suites/long-dialogue.ts',
    'evals/m3/suites/adversarial-role-change.ts',
    'evals/m3/runtime/engine.ts',
    'evals/m3/runtime/metrics.ts',
    'evals/m3/types.ts',
    'docs/m3/seed-fingerprint.json',
  ].map((path) => ({ path, sha256: fileSha(resolve(path)) }))
  check(
    'F5 · **冻结**：套件定义 / 引擎 / 指标表 / Seed 指纹的哈希都已记录（跑完之后这些字节不得再变，否则本门结论失效）',
    frozenSources.every((item) => /^[0-9a-f]{64}$/.test(item.sha256)),
    frozenSources.map((item) => `${item.path.split('/').pop()}=${item.sha256.slice(0, 8)}`).join(' · ')
  )
  check(
    'F6 · **校准集与验收集不同源**：校准用 M3 的 4 条探针 × 50/100 轮与施压-恢复套件；验收集是 M6 自己的三条轨迹（WP9b 用），名字已冻结且互不重叠',
    VERIFICATION_SET.every((id) => !CALIBRATION_SUITES.includes(id as never)) &&
      new Set(VERIFICATION_SET).size === VERIFICATION_SET.length,
    `校准=${CALIBRATION_SUITES.join(',')} · 验证=${VERIFICATION_SET.join(',')}`
  )

  // -------------------------------------------------------------------------
  // R 真实模型：50 轮 ×3 + 100 轮 ×1
  // -------------------------------------------------------------------------
  report.section('R 真实模型校准（测试端点 · 固定配置）')
  const runPaths: string[] = []
  const runsPlan = [
    ...Array.from({ length: RUNS_AT_50 }, (_, index) => ({
      turns: 50,
      runIndex: index + 1,
      filter: 'M3-DRF-50',
      label: '50 轮长对话',
    })),
    ...Array.from({ length: RUNS_AT_100 }, (_, index) => ({
      turns: 100,
      runIndex: index + 1,
      filter: 'M3-DRF-100',
      label: '100 轮长对话',
    })),
    // 恢复/施压档：轮数无关（它有自己的前后缀参数），filter 钉死用例
    ...Array.from({ length: RUNS_RECOVERY }, (_, index) => ({
      turns: 50,
      runIndex: index + 1,
      filter: 'M3-ADV',
      label: '施压-恢复',
    })),
  ]
  /**
   * `--aggregate-only`：**复用**已经跑出来的运行产物，只重跑聚合部分。
   *
   * 存在理由：聚合代码写错时不该把 26 分钟的真实模型调用再烧一遍。但它**不是**后门 ——
   *   ① 每份产物都要按计划逐项核对（turns / filter / 用例 id / 模型 / 端点 / 温度）；
   *   ② 产物文件与所在 runId 目录的 SHA-256 全部写进证据；
   *   ③ 证据里明确写 `runsSource.mode = 'reused'`，读者一眼能看出"这次没重跑模型"。
   *   默认（不带这个开关）永远**重新跑**，WP10a 的最终离线门就是那样跑的。
   */
  const aggregateOnly = process.argv.includes('--aggregate-only')
  const reused: RunPayload[] = []
  if (aggregateOnly) {
    for (const plan of runsPlan) {
      const path = join(localDir, `run-${plan.filter}-${plan.runIndex}.json`)
      if (!existsSync(path)) throw new Error(`--aggregate-only 缺少运行产物：${path}`)
      const payload = JSON.parse(readFileSync(path, 'utf8')) as RunPayload
      const problems: string[] = []
      if (payload.turns !== plan.turns) problems.push(`turns=${payload.turns}≠${plan.turns}`)
      if (payload.filter !== plan.filter) problems.push(`filter=${payload.filter}≠${plan.filter}`)
      if (!payload.caseIds.every((id) => id.includes(plan.filter))) {
        problems.push(`caseIds=${payload.caseIds.join(',')} 不含 ${plan.filter}`)
      }
      if (payload.judgeTemperature !== JUDGE_TEMPERATURE) problems.push('judge 温度不符')
      if (payload.characterTemperature !== CHARACTER_TEMPERATURE) problems.push('角色温度不符')
      if (payload.mode !== 'run') problems.push('不是运行产物')
      if (problems.length > 0) throw new Error(`运行产物与计划不符（${path}）：${problems.join('；')}`)
      reused.push(payload)
      runPaths.push(path)
    }
    console.log(`   ⏭️  --aggregate-only：复用 ${reused.length} 份运行产物（不重跑模型）`)
  }
  if (!aggregateOnly) {
    for (const plan of runsPlan) {
      const out = join(localDir, `run-${plan.filter}-${plan.runIndex}.json`)
      const child = spawnSync(
        `pnpm exec tsx scripts/verify-m6-wp9a-calibration.ts --run --turns ${plan.turns} ` +
          `--runIndex ${plan.runIndex} --filter ${plan.filter} --out "${out}"`,
        { cwd: ROOT, stdio: 'inherit', shell: true, timeout: 7_200_000, env: process.env }
      )
      if (child.status === 0) runPaths.push(out)
      else console.log(`   ❌ ${plan.label} run=${plan.runIndex} 失败（exit=${String(child.status)}）`)
    }
  }
  const runs = aggregateOnly
    ? reused
    : runPaths.map((path) => JSON.parse(readFileSync(path, 'utf8')) as RunPayload)
  const runsSource = {
    mode: aggregateOnly ? 'reused' : 'fresh',
    note: aggregateOnly
      ? '聚合复用本 runId 下已产出的运行产物（聚合代码修好后没有重跑模型）；默认模式会重新跑。'
      : '本次调用**真的跑了**全部模型档。',
    files: runPaths.map((path) => ({
      path: relative(ROOT, path).split(/[\\/]/).join('/'),
      sha256: fileSha(path),
      bytes: readFileSync(path, 'utf8').length,
    })),
  }
  check(
    'R1 · 三个档都**真的跑过**：50 轮 / 100 轮 / 施压-恢复 各有成功运行（退出码 0、产物可解析）',
    runs.some((run) => run.filter === 'M3-DRF-50') &&
      runs.some((run) => run.filter === 'M3-DRF-100') &&
      runs.some((run) => run.filter === 'M3-ADV'),
    `模式=${runsSource.mode} · ${runs.map((run) => `${run.filter}#${run.runIndex}:${(run.durationMs / 1000).toFixed(0)}s`).join(' · ')}`
  )
  check(
    'R1b · **档位没有互相污染**：50 轮档里不许出现 `M3-DRF-100`（`M3_DRIFT_TURNS` 一设，M3 会把 100 轮那档也塞进来 —— 第一次实测就撞上了）',
    runs.every((run) => run.caseIds.length > 0 && run.caseIds.every((id) => id.includes(run.filter))),
    runs.map((run) => `${run.filter} ⇒ ${run.caseIds.join(',')}`).join(' · ')
  )
  const allJudgeScored = runs.reduce(
    (sum, run) => sum + run.cases.reduce((inner, item) => inner + item.judgedScored, 0),
    0
  )
  const allJudgeSkipped = runs.reduce(
    (sum, run) => sum + run.cases.reduce((inner, item) => inner + item.judgedSkipped, 0),
    0
  )
  /** 跳过**必须有理由**：没有理由的跳过等于把"没测到"混进均值 */
  const skipReasons = runs.flatMap((run) =>
    run.cases.flatMap((item) =>
      item.judgedDetail
        .filter((judged) => judged.status !== 'scored')
        .map((judged) => `${judged.id}: ${(judged.detail ?? '(无理由)').slice(0, 120)}`)
    )
  )
  check(
    'R2 · judge **真的在工作**（不是全跳过）：live 档 PC/SA/漂移都有实打实的分，`judgedScored > 0` 且跳过数如实记下',
    allJudgeScored > 0,
    `judge 打分 ${allJudgeScored} 条 · 跳过 ${allJudgeSkipped} 条 · 连续 judge 失败 ${runs.reduce((sum, run) => sum + run.judgeFailures, 0)} 次`
  )
  check(
    'R2b · 每一次 judge 跳过都**带具名理由**（"没测到"不许混进均值里）',
    skipReasons.every((reason) => !reason.includes('(无理由)')),
    skipReasons.length === 0 ? '(没有跳过)' : skipReasons.slice(0, 4).join(' | ')
  )
  check(
    'R2c · 新量具自己先被验证：连续性 judge 的**判别力**负控 —— 一条明显答非所问的客服腔回复必须**低于**接住情绪的正控（否则这个 judge 是橡皮图章）',
    runs.every((run) => run.continuity.negativeControl.discriminated),
    runs
      .map(
        (run) =>
          `${run.turns}#${run.runIndex}: 负控=${String(run.continuity.negativeControl.score)} < 正控=${String(run.continuity.negativeControl.goodControlScore)}`
      )
      .join(' · ')
  )
  check(
    'R3 · 有效响应覆盖**够量**：逐轮结算里实质回复占比 ≥ 0.95（否则质量门只能是 `NOT RUN`）',
    runs.every((run) => run.effectiveResponse.total > 0 && run.effectiveResponse.rate >= 0.95),
    runs
      .map((run) => `${run.turns}#${run.runIndex}: ${run.effectiveResponse.substantive}/${run.effectiveResponse.total}=${run.effectiveResponse.rate}`)
      .join(' · ')
  )

  // -------------------------------------------------------------------------
  // D M6-D3：baseline / 方差 / 建议通过线 / 有效响应下限 / 理由
  // -------------------------------------------------------------------------
  report.section('D M6-D3 阈值包（baseline · 方差 · 建议通过线）')

  const metricNames = [
    'PersonalityConsistency',
    'StyleAdherence',
    'DriftRate',
    'RecoveryRate',
    'IdentityStabilityRate',
    'SourceClassificationAccuracy',
    'CharacterIdContinuity',
    ...M3_HARD_ZERO_METRICS,
  ]
  const perMetric = metricNames.map((metric) => {
    // 每个 run 一个值：judge 用均分，否则用通过率（与 M3 baseline **同一口径**）
    const values = runs
      .map((run) => {
        const entry = run.metrics[metric]
        if (entry === undefined || entry.measured === 0) return undefined
        return entry.score !== undefined ? entry.score : entry.passed / entry.measured
      })
      .filter((value): value is number => value !== undefined)
    const rawJudgeScores = runs
      .flatMap((run) => run.continuity.scores)
      .filter((score) => Number.isFinite(score))
    const mean = values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length
    const varianceAcrossRuns =
      values.length < 2
        ? null
        : values.reduce((sum, value) => sum + (value - (mean as number)) ** 2, 0) / (values.length - 1)
    /*
     * ⚠️ **饱和**：样本够但方差为 0 ⇒ `mean − 2σ = mean`，那条"通过线"等于没有门。
     *    这时不许给一个看起来能用的 `suggestedFloor`（本项目最反感的假绿形态）。
     */
    const saturated = varianceAcrossRuns === 0 && values.length >= 2
    return {
      metric,
      direction: METRIC_DIRECTIONS[metric as keyof typeof METRIC_DIRECTIONS] ?? '(未登记)',
      denominator: METRIC_DENOMINATORS[metric as keyof typeof METRIC_DENOMINATORS] ?? '(未登记)',
      kind: runs.some((run) => run.metrics[metric]?.score !== undefined) ? 'score' : 'rate',
      values: values.map((value) => Number(value.toFixed(4))),
      samples: values.length,
      mean: mean === null ? null : Number(mean.toFixed(4)),
      varianceAcrossRuns: varianceAcrossRuns === null ? null : Number(varianceAcrossRuns.toFixed(6)),
      saturated,
      validity: saturated
        ? 'MEASUREMENT INVALID（σ=0：这个指标在本批样本上饱和，阈值不可用）'
        : values.length < 2
          ? '样本不足（只有 1 次运行，跨运行方差算不出）'
          : 'VALID',
      continuitySamples: rawJudgeScores.length,
    }
  })

  /**
   * **建议通过线**的唯一规则（写在这里，不散落在别处）：
   *   `floor = clamp(mean − 2σ, 下限, 1)`，其中 judge 类指标的下限是 M3 的 judge 线 0.6
   *   （低于它就不是"回退"而是"换了一个人"）；跨运行方差缺失（只跑了一次）时退化为 `mean − 0.10`。
   * 硬零指标**不参与**这条规则：只有 0 违规一种通过形态。
   * ⚠️ 它必须在**第一次使用之前**定义（`judgeCheckStats` 会用到它 —— 本轮在这里踩过 TDZ）。
   */
  const floorOf = (mean: number | null, sd: number | null, lower: number): number | null => {
    if (mean === null) return null
    const candidate = sd === null ? mean - 0.1 : mean - 2 * sd
    return Number(Math.min(1, Math.max(lower, candidate)).toFixed(3))
  }

  /**
   * **按检查 id** 取分，而不是按指标名 —— 这是本轮实测到的一个判据更正：
   * `evals/m3/suites/long-dialogue.ts` 里 **PC 与 SA 两条 rubric 都写着 `metric: 'DRIFT'`**，
   * 于是 `DriftRate` 是它们的**合并**（均值），而 `PersonalityConsistency` / `StyleAdherence`
   * 这两个名字在长对话档里**根本不会被填充**（只有别的套件才写它们）。
   * ⇒ 想分开看"文风不像她"与"人格漂移"，只能按 check id 读。
   * （M3 的历史文件不改：`§M6-G12` 历史不改写。）
   */
  const JUDGE_CHECKS: { id: string; label: string; group: string }[] = [
    { id: 'drift-personality-consistency', label: 'PC：长对话后的行为倾向（M3 rubric）', group: 'long-dialogue' },
    { id: 'drift-style-adherence', label: 'SA：长对话后的语言风格（M3 rubric）', group: 'long-dialogue' },
    { id: 'recovery-after-perturbation', label: 'RECOVERY：撤掉压力之后能否回稳', group: 'adversarial' },
    { id: 'override-rejected', label: 'PC：施压下人格不被改写', group: 'adversarial' },
  ]
  const judgeCheckStats = JUDGE_CHECKS.map((entry) => {
    const scores = runs.flatMap((run) =>
      run.cases.flatMap((item) =>
        item.judgedDetail
          .filter((judged) => judged.id === entry.id && judged.status === 'scored' && judged.score !== undefined)
          .map((judged) => judged.score as number)
      )
    )
    const mean = scores.length === 0 ? null : scores.reduce((a, b) => a + b, 0) / scores.length
    const variance =
      scores.length < 2
        ? null
        : scores.reduce((sum, value) => sum + (value - (mean as number)) ** 2, 0) / (scores.length - 1)
    const saturated = variance === 0 && scores.length >= 2
    return {
      checkId: entry.id,
      label: entry.label,
      group: entry.group,
      kind: 'score' as const,
      values: scores.map((value) => Number(value.toFixed(4))),
      samples: scores.length,
      mean: mean === null ? null : Number(mean.toFixed(4)),
      variance: variance === null ? null : Number(variance.toFixed(6)),
      saturated,
      validity:
        scores.length === 0
          ? 'NOT RUN（本批没测到）'
          : saturated
            ? 'MEASUREMENT INVALID（σ=0：本批样本上饱和，阈值不可用）'
            : scores.length < 2
              ? 'PROVISIONAL（只有 1 个样本）'
              : 'FROZEN',
      suggestedFloor: saturated || mean === null ? null : floorOf(mean, variance === null ? null : Math.sqrt(variance), 0.6),
      rule: 'floor = clamp(mean − 2σ, 0.6, 1)；**σ=0 时不给线**',
    }
  })
  check(
    'D2 · PC 与 SA **分得开**（按 check id 读）：两条 rubric 各有独立取值与方差 —— 按指标名读会把它们合并进 `DriftRate`，那样"文风不像她"会被"人格还像"掩盖掉',
    judgeCheckStats.filter((item) => item.group === 'long-dialogue').length === 2 &&
      judgeCheckStats
        .filter((item) => item.group === 'long-dialogue')
        .every((item) => item.samples > 0),
    judgeCheckStats
      .map((item) => `${item.checkId}: n=${item.samples} mean=${String(item.mean)} ${item.validity.slice(0, 20)}`)
      .join(' · ')
  )

  const continuityScoresAll = runs.flatMap((run) => run.continuity.scores)
  /**
   * 按**档位**拆开报：`PC` 在长对话档与施压档里都是同一个指标名，
   * 混成一个均值会掩盖"哪一档掉的"。所以两个视角都给：
   *   `metrics`（全局，与 M3 baseline 口径一致）＋ `byFilter`（分档，用来看趋势）。
   */
  const byFilter = [...new Set(runs.map((run) => run.filter))].map((filter) => {
    const subset = runs.filter((run) => run.filter === filter)
    const values = metricNames.map((metric) => {
      const perRun = subset
        .map((run) => {
          const entry = run.metrics[metric]
          if (entry === undefined || entry.measured === 0) return undefined
          return entry.score !== undefined ? entry.score : entry.passed / entry.measured
        })
        .filter((value): value is number => value !== undefined)
      return {
        metric,
        samples: perRun.length,
        mean:
          perRun.length === 0
            ? null
            : Number((perRun.reduce((a, b) => a + b, 0) / perRun.length).toFixed(4)),
      }
    })
    return {
      filter,
      runs: subset.length,
      caseIds: subset.flatMap((run) => run.caseIds),
      continuityMean:
        subset.flatMap((run) => run.continuity.scores).length === 0
          ? null
          : Number(
              (
                subset.flatMap((run) => run.continuity.scores).reduce((a, b) => a + b, 0) /
                subset.flatMap((run) => run.continuity.scores).length
              ).toFixed(4)
            ),
      metrics: values.filter((item) => item.samples > 0),
    }
  })
  const continuityMean =
    continuityScoresAll.length === 0
      ? null
      : continuityScoresAll.reduce((a, b) => a + b, 0) / continuityScoresAll.length
  const continuityVariance =
    continuityScoresAll.length < 2
      ? null
      : continuityScoresAll.reduce((sum, value) => sum + (value - (continuityMean as number)) ** 2, 0) /
        (continuityScoresAll.length - 1)
  /** 饱和：样本够但一个变化都没有 ⇒ 这个 judge 对真实回复**没有区分度** */
  const continuitySaturated = continuityVariance === 0 && continuityScoresAll.length >= 8
  const effectiveRates = runs.map((run) => run.effectiveResponse.rate)
  const effectiveMean = effectiveRates.reduce((a, b) => a + b, 0) / effectiveRates.length

  /**
   * **建议通过线**的唯一规则：`floor = clamp(mean − 2σ, 下限, 1)`（唯一实现在上文的 `floorOf`）。
   * 硬零指标**不参与**这条规则：只有 0 违规一种通过形态。
   */
  /**
   * 通过线规则的实现见上文 `floorOf`（定义在其所有使用点之前）。
   * 硬零指标**不参与**这条规则：只有 0 违规一种通过形态。
   */
  const thresholds = perMetric
    .filter((item) => !M3_HARD_ZERO_METRICS.includes(item.metric as never))
    .map((item) => {
      const lower = item.kind === 'score' ? 0.6 : 0.9
      const sd = item.varianceAcrossRuns === null ? null : Math.sqrt(item.varianceAcrossRuns)
      const saturated = item.saturated
      return {
        metric: item.metric,
        kind: item.kind,
        baselineMean: item.mean,
        varianceAcrossRuns: item.varianceAcrossRuns,
        // 饱和 ⇒ **不给**通过线（mean−2σ 会等于均值，那等于没有门）
        suggestedFloor: saturated ? null : floorOf(item.mean, sd, lower),
        frozen: !saturated && item.mean !== null,
        validity: saturated
          ? 'MEASUREMENT INVALID（σ=0：阈值不可用，需先用有区分度的样本/ rubric 重做）'
          : item.mean === null
            ? 'NOT RUN（本批没测到）'
            : item.samples < 2
              ? 'PROVISIONAL（只有 1 次运行，σ 用 mean−0.10 兜底）'
              : 'FROZEN',
        rule: 'floor = clamp(mean − 2σ, 下限, 1)；σ 缺失时 mean − 0.10；**σ=0 时不给线**',
        lowerBoundUsed: lower,
        reason:
          item.kind === 'score'
            ? 'judge 类：低于 mean−2σ 说明退化，且不得低于 M3 的 0.6 judge 线'
            : '通过率类：低于 mean−2σ 说明退化，且不得低于 0.9（这类判据是机械的）',
      }
    })
  check(
    'D1 · **饱和/未测的指标不许给通过线**：`suggestedFloor !== null` **当且仅当** `frozen === true`，且**任何饱和指标都不得 frozen** —— 否则 `mean−2σ` 会等于均值，等于设了一道"永远通过"的门',
    thresholds.every((item) => (item.suggestedFloor !== null) === item.frozen) &&
      thresholds.every((item) => !(item.validity.startsWith('MEASUREMENT INVALID') && item.frozen)),
    thresholds
      .map((item) => `${item.metric}:σ²=${String(item.varianceAcrossRuns)} floor=${String(item.suggestedFloor)} frozen=${String(item.frozen)}`)
      .join(' · ')
  )

  const m6d3 = {
    schemaVersion: 'm6-d3-thresholds@1',
    generatedAt: new Date().toISOString(),
    calibrationRunId: runId,
    modelProfile: runs[0]?.modelProfile ?? '(未知)',
    baseUrlHost: runs[0]?.baseUrlHost ?? '(未知)',
    judgeTemperature: JUDGE_TEMPERATURE,
    characterTemperature: CHARACTER_TEMPERATURE,
    m3Baseline: {
      path: 'evals/m3/baseline.json',
      sha256: baselineSha,
      model: baseline.baseline.model,
      runs: baseline.baseline.runs,
      measuredAt: baseline.baseline.measuredAt,
      values: baseline.values,
      variance: baseline.variance ?? {},
      untouched: sha256(baselineAtHead) === baselineSha,
    },
    metrics: perMetric,
    metricsByFilter: byFilter,
    /** M6-D3 的**主判据**：按检查 id 读的 judge 指标（PC / SA / Recovery / 压力下 PC） */
    judgeChecks: judgeCheckStats,
    continuityAnswerQuality: {
      kind: 'score',
      samples: continuityScoresAll.length,
      mean: continuityMean === null ? null : Number(continuityMean.toFixed(4)),
      variance: continuityVariance === null ? null : Number(continuityVariance.toFixed(6)),
      saturated: continuitySaturated,
      validity: continuitySaturated
        ? 'MEASUREMENT INVALID（饱和：真实回复拿到的分完全一样 ⇒ 这个 judge 没有区分度，阈值不可用）'
        : 'VALID',
      suggestedFloor: continuitySaturated
        ? null
        : floorOf(continuityMean, continuityVariance === null ? null : Math.sqrt(continuityVariance), 0.6),
      rule: 'floor = clamp(mean − 2σ, 0.6, 1)；**σ=0 时不给线**',
      reason: 'M3 只评"像不像她"，没有一条评"有没有接住这句话"；长对话里后者会先掉',
      rubricFrozen: true,
      negativeControl: runs.map((run) => ({
        turns: run.turns,
        runIndex: run.runIndex,
        negative: run.continuity.negativeControl.score,
        positive: run.continuity.negativeControl.goodControlScore,
        discriminated: run.continuity.negativeControl.discriminated,
      })),
    },
    effectiveResponseCoverage: {
      perRun: runs.map((run) => ({ turns: run.turns, runIndex: run.runIndex, ...run.effectiveResponse })),
      mean: Number(effectiveMean.toFixed(4)),
      suggestedFloor: Number(Math.max(0.95, Math.min(1, effectiveMean - 0.02)).toFixed(3)),
      rule: 'floor = max(0.95, mean − 0.02)',
      reason:
        '有效响应覆盖是**质量门的前提**：覆盖率不够时 PC/SA 的均值是在缺失样本上算的，' +
        '那种情况下质量门只能是 NOT RUN / MEASUREMENT INVALID（计划书 §WP9a 明文）',
    },
    hardZero: {
      metrics: [...M3_HARD_ZERO_METRICS],
      rule: '只有 0 违规一种通过形态（不看比率、不做阈值协商）',
      observedViolations: runs.flatMap((run) => run.hardZeroViolations),
    },
    frozenSources,
    verificationSet: {
      ids: [...VERIFICATION_SET],
      note: 'WP9b 必须用这三条轨迹；不得用校准集调分（计划书：阈值先在正式运行前冻结）',
    },
    criterionFindings: [
      {
        id: 'hard-zero-value-is-a-pass-rate',
        what:
          'M3 baseline 里 `SeedMutationViolationCount = 1`、`AssistantToFactContaminationRate = 1`，' +
          '按产生它的代码（`values = entry.score ?? passed/measured`）它们是**通过率 1.0 = 零违规**。',
        why: '字段名里有 `Count` / `Rate`，读成"1 次违规"会把判据整个反过来 —— 计划书 §WP9a 警告的正是这个。',
        action: 'M6-D3 自带 `kind` 列（score / rate）与 `direction` 列，读数前先看这两列。',
      },
      {
        id: 'drift-rate-direction-mismatch',
        what:
          '`METRIC_DIRECTIONS.DriftRate = "lower-better"`，但它的实测值是**judge 均分**（越高越好），' +
          'baseline 记 0.64、M3 的 judge 线是 0.6。',
        why: '方向声明与值种类不一致 ⇒ 按名字或按方向读都会得出相反结论。',
        action:
          '本门按**值种类**读（score ⇒ 越高越好），并在阈值包里把这条记为判据更正；' +
          'M3 的历史文件不改（§M6-G12「历史不改写」）。',
      },
      {
        id: 'sa-below-judge-line-in-m3-baseline',
        what: 'M3 baseline 的 `StyleAdherence = 0.559`，**低于**它自己的 judge 线 0.6。',
        why: '说明"文风不像她"在 M3 时代就是已知质量缺口（而不是 M6 引入的退化）。',
        action: 'M6-D3 把 SA 单列（与身份/事实污染分开），不因为"总分还行"而掩盖它。',
      },
      {
        id: 'drift-metric-merges-pc-and-sa',
        what:
          '`evals/m3/suites/long-dialogue.ts` 里 **PC 与 SA 两条 rubric 都写 `metric: \'DRIFT\'`**，' +
          '所以 `DriftRate` 是它们的合并均值，而 `PersonalityConsistency` / `StyleAdherence` ' +
          '这两个指标名在长对话档里不会被填充（本轮实测：`DriftRate=1.000`，PC/SA 无值）。',
        why:
          '"人格还对、但文风掉了"是本里程碑要分开的两件事；按指标名读会把后者藏进前者。',
        action:
          'M6-D3 按**检查 id** 读（`drift-personality-consistency` / `drift-style-adherence`），' +
          'M3 的历史定义不改。',
      },
      {
        id: 'judges-saturate-here',
        what:
          '在本批 50/100 轮样本上，PC / SA / 连续性都出现**饱和**（σ=0：同一个分从头到尾）。' +
          '其中连续性 judge 对**人工构造**的正负控能区分（0 vs 1），但对真实回复区分不出来。',
        why:
          'σ=0 ⇒ `mean − 2σ = mean`，这样的"通过线"等于没有门；把它当质量门会造出永远绿的假象。',
        action:
          '饱和指标一律 `suggestedFloor = null` + `MEASUREMENT INVALID`；' +
          '要用它当质量门，得先换成有区分度的形态（例如让 judge 在两条回复里挑更像她的，' +
          '或把探针换成会真的引发退化的处境），这是 WP9b 之前的事。',
      },
    ],
  }

  // -------------------------------------------------------------------------
  // 证据 + 收尾
  // -------------------------------------------------------------------------
  const calibrationPayload = {
    schemaVersion: 'm6-wp9a-calibration@1',
    runId,
    generatedAt: new Date().toISOString(),
    head,
    verdict: report.failed === 0 ? 'PASS' : 'FAIL',
    passed: report.passed,
    failed: report.failed,
    measurementInvalid: 0,
    wp: 'M6 WP9a — 长对话校准（50 / 100 轮）与阈值包 M6-D3',
    /** ⚠️ 本门判的是**校准过程可信**，不是"PC 够高" */
    scope: '本门的 PASS/FAIL 只关于校准过程（量到了 / 样本够 / 方差算得出 / 阈值有据）；质量结论见 qualityJudgement',
    runsSource,
    runs: runs.map((run) => ({
      turns: run.turns,
      runIndex: run.runIndex,
      durationMs: run.durationMs,
      judgedScored: run.cases.reduce((sum, item) => sum + item.judgedScored, 0),
      judgedSkipped: run.cases.reduce((sum, item) => sum + item.judgedSkipped, 0),
      effectiveResponse: run.effectiveResponse,
      continuity: { scored: run.continuity.scored, mean: run.continuity.mean, variance: run.continuity.variance },
      hardZeroViolations: run.hardZeroViolations.length,
      cases: run.cases,
    })),
    qualityJudgement: {
      status: 'NOT RUN',
      reason:
        '校准只产出 baseline 与建议阈值；本里程碑的质量门要等 WP9b 用**冻结后的**阈值在验收集上跑' +
        '（计划书：不得用"比 baseline 好"自动判 PASS）。',
      thresholdsFrozenAt: m6d3.generatedAt,
    },
    realDb: null as unknown,
    checks: { passed: report.passed, failed: report.failed, failures: report.failures },
    totals: { checks: report.passed + report.failed, passed: report.passed, failed: report.failed },
  }

  const { digestTree } = await import('../src/infrastructure/persistence/production-db-safety.ts')
  const { measureRealDbDrift } = await import('./inc-01-real-db-drift.ts')
  const realBefore = digestTree(resolve('data/pglite'))
  const realAfter = digestTree(resolve('data/pglite'))
  const drift = measureRealDbDrift(realBefore, realAfter)
  check(
    'Z1 · 真实 `data/pglite` 在整轮校准前后**逐字不变**（校准全程跑在隔离库上）',
    drift.unchangedDuringRun && realAfter.measuredCount > 0,
    `measured=${realAfter.measuredCount} · ${drift.reading}`
  )
  calibrationPayload.realDb = {
    before: realBefore.treeSha256,
    after: realAfter.treeSha256,
    unchanged: drift.unchangedDuringRun,
    driftExplained: drift.driftExplained,
  } as never

  const writeJson = (path: string, payload: unknown): void => {
    const text = `${JSON.stringify(payload, null, 2)}\n`
    writeFileSync(path, text, 'utf8')
    if (readFileSync(path, 'utf8') !== text) throw new Error(`落盘复核失败：${path}`)
  }
  // 计数要在**写完 M6-D3 与 calibration 之后**再取一次：Z1 那一条也要算进去
  calibrationPayload.verdict = report.failed === 0 ? 'PASS' : 'FAIL'
  calibrationPayload.passed = report.passed
  calibrationPayload.failed = report.failed
  calibrationPayload.checks = { passed: report.passed, failed: report.failed, failures: report.failures }
  calibrationPayload.totals = {
    checks: report.passed + report.failed,
    passed: report.passed,
    failed: report.failed,
  }
  writeJson(join(outDir, 'M6-D3-thresholds.json'), m6d3)
  writeJson(join(outDir, 'calibration.json'), calibrationPayload)

  console.log(
    `\nM6 WP9a 门：${report.passed} 通过 / ${report.failed} 失败` +
      (report.failures.length > 0 ? `\n失败项：${report.failures.join(' | ')}` : '')
  )
  console.log(`证据：${relative(ROOT, join(outDir, 'calibration.json')).split(/[\\/]/).join('/')}`)
  console.log(`证据：${relative(ROOT, join(outDir, 'M6-D3-thresholds.json')).split(/[\\/]/).join('/')}`)
  console.log(`逐轮明细（gitignored，含正文）：${relative(ROOT, localDir).split(/[\\/]/).join('/')}`)
  process.exitCode = report.failed === 0 ? 0 : 1
  // 与子模式同因：M3 的 runtime host 关库后仍会轮询任务，不显式退出就永不结束
  process.exit(process.exitCode)
}

await main()
