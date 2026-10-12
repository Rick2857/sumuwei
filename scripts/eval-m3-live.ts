/**
 * M3 评测 —— **真实模型档**（Release Gate）。
 *
 * ============================================================================
 *  计划书第 53 / 142 / 146 节：人格部分的判定必须真的调模型
 * ============================================================================
 * 离线档（`eval-m3.ts`）能证明的全部是**结构性事实**：
 * 身份在不在、来源对不对、序号乱不乱。它证明不了任何一件关于"她像不像她"的事 ——
 * 因为"回复"是引擎合成的机器可读串，而不是她会说出口的话。
 *
 * 这一档补上的正是那部分：PC / SA / Drift / Recovery / trait alignment。
 *
 * ---------------------------------------------------------------------------
 *  两条硬规矩
 * ---------------------------------------------------------------------------
 * 1. **没有 API Key 就直接跳过，退出码 0。**
 *    人格评测不该阻塞别人跑离线 CI。跳过时**明确打印**跳过了什么 ——
 *    一个安静跳过的 Gate 比没有 Gate 更危险（它看起来是绿的）。
 *
 * 2. **judge 解析失败记为 `skipped`，不是 0 分。**
 *    模型偶尔不按格式吐分数是常态。记 0 分会把"模型今天话多"
 *    变成"她人格漂移"（假警报），而抛异常会让后面十几个用例失去结果。
 *    `skipped` 是诚实的：这次没测到，报告里看得见，原始输出还留着。
 *
 * ---------------------------------------------------------------------------
 *  第一轮只建立 Baseline（计划书第 119 / 120 节）
 * ---------------------------------------------------------------------------
 * 默认**不做阈值判定**：`evals/m3/baseline.json` 存在之前，
 * 报告里人格指标只记分数、不判通过。`--write-baseline` 把实测均值写进去，
 * 人工看过之后再显式冻结门槛（见 `evals/m3/thresholds.ts` 的说明）。
 *
 * 跑法：
 *   pnpm eval:m3:live                          全部真实模型用例（1 次）
 *   pnpm eval:m3:live --runs 3                 跑 3 次（baseline 要求 3–5 次）
 *   pnpm eval:m3:live --write-baseline         把实测均值写进 baseline.json
 *   pnpm eval:m3:live --suite long-dialogue    只跑一个套件
 *   pnpm eval:m3:live --turns 100              长对话跑 100 轮（默认 50）
 *
 * ⚠️ 全部在**一次性副本库**上跑：`isolateDatabase()` 在第一行 import 之前调用。
 */

import 'dotenv/config'

import { isolateDatabase } from '../src/dev/sandbox.ts'

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

import { M3_SUITES, findM3Suite, m3SuiteIds } from '../evals/m3/index.ts'
import { runM3 } from '../evals/m3/runtime/engine.ts'
import { M3_HARD_ZERO_METRICS, type EvalReport } from '../evals/m3/types.ts'
import {
  M3_BASELINE_PATH,
  describeThresholds,
  readBaseline,
  thresholdsWithBaseline,
  type M3BaselineFile,
} from '../evals/m3/thresholds.ts'
import { printSummary, type RunSummary } from './kernel-test-kit.ts'

isolateDatabase('eval-m3-live')

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

interface Options {
  suiteIds: string[]
  filter?: string
  runs: number
  turns?: number
  out?: string
  writeBaseline: boolean
  quiet: boolean
  /** 打印实际发给 judge 的 prompt（排查"分数为什么低"的第一步） */
  dumpJudge: boolean
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = { suiteIds: [], runs: 1, writeBaseline: false, quiet: false, dumpJudge: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = (): string => {
      const value = argv[index + 1]
      if (!value) throw new Error(`${arg} 需要一个值`)
      index += 1
      return value
    }
    if (arg === '--suite' || arg === '-s') options.suiteIds.push(next())
    else if (arg.startsWith('--suite=')) options.suiteIds.push(arg.slice(8))
    else if (arg === '--filter' || arg === '-f') options.filter = next()
    else if (arg.startsWith('--filter=')) options.filter = arg.slice(9)
    else if (arg === '--runs' || arg === '-n') options.runs = Math.max(1, Number(next()))
    else if (arg.startsWith('--runs=')) options.runs = Math.max(1, Number(arg.slice(7)))
    else if (arg === '--turns' || arg === '-t') options.turns = Number(next())
    else if (arg.startsWith('--turns=')) options.turns = Number(arg.slice(8))
    else if (arg === '--out') options.out = next()
    else if (arg.startsWith('--out=')) options.out = arg.slice(6)
    else if (arg === '--write-baseline') options.writeBaseline = true
    else if (arg === '--dump-judge') options.dumpJudge = true
    else if (arg === '--quiet' || arg === '-q') options.quiet = true
    else if (arg === '--help' || arg === '-h') {
      console.log(
        [
          'M3 人格评测（真实模型档，需要 OPENAI_API_KEY）',
          '',
          '  --suite <id>       只跑指定套件（可重复）',
          '  --filter <子串>    过滤用例 id / 套件 id / 标签',
          '  --runs <n>         重复次数（baseline 要求 3–5 次）',
          '  --turns <n>        长对话轮数（默认 50；可设 100）',
          '  --out <path>       写出报告 JSON',
          '  --write-baseline   把实测均值写进 evals/m3/baseline.json',
          '  --dump-judge       打印实际发给 judge 的完整 prompt（排查用）',
          '  --quiet            只打印摘要',
          '',
          `套件：${m3SuiteIds().join(', ')}`,
        ].join('\n')
      )
      process.exit(0)
    } else if (!arg.startsWith('-')) options.filter = arg
    else throw new Error(`未知参数：${arg}（--help 看用法）`)
  }
  return options
}

const options = parseArgs(process.argv.slice(2))

for (const id of options.suiteIds) {
  if (!findM3Suite(id)) {
    console.error(`没有这个套件：${id}`)
    console.error(`可用套件：${m3SuiteIds().join(', ')}`)
    process.exit(2)
  }
}

// ---------------------------------------------------------------------------
// 前置检查：没有 Key 就**明确跳过**（退出码 0，不是失败）
// ---------------------------------------------------------------------------

const apiKey = process.env.OPENAI_API_KEY
if (!apiKey || apiKey.trim() === '') {
  console.log('='.repeat(72))
  console.log('M3 真实模型评测：已跳过')
  console.log('='.repeat(72))
  console.log('')
  console.log('  原因：没有配置 OPENAI_API_KEY。')
  console.log('')
  console.log('  这一档测的是**人格**（PC / SA / Drift / Recovery / trait alignment），')
  console.log('  必须真的调模型 —— 用 echo 模式跑它只会得到毫无意义的分数。')
  console.log('')
  console.log('  因此这里选择"明确跳过并给出退出码 0"，而不是：')
  console.log('    · 用空结果假装通过（那会让 Gate 看起来是绿的）')
  console.log('    · 以失败退出（那会阻塞不需要 Key 的离线 CI）')
  console.log('')
  console.log('  离线档（结构性事实、硬零指标）不受影响：pnpm eval:m3')
  console.log('')
  console.log('='.repeat(72))
  process.exit(0)
}

const MODEL_ID = process.env.OPENAI_LARGE_MODEL ?? 'deepseek-flash'
const BASE_URL = process.env.OPENAI_BASE_URL ?? 'https://api.deepseek.com'

if (options.turns !== undefined) {
  process.env.M3_DRIFT_TURNS = String(options.turns)
}

// ---------------------------------------------------------------------------
// 模型调用（两个口：judge 的与她自己的）
// ---------------------------------------------------------------------------

/**
 * 带重试的 POST。
 *
 * ============================================================================
 *  为什么必须重试（实测踩到）
 * ============================================================================
 * 建立 baseline 要连跑 3–5 次，每次十几个用例、每个用例若干次真实调用 ——
 * 也就是**几百次网络往返**。这个量级下偶发 `ECONNRESET` / `terminated`
 * 不是异常而是常态。
 *
 * 第一次实测时第三次运行正好撞上一次连接被重置，而那时脚本**整个崩掉**、
 * 连 baseline.json 都没写出来 —— 前两次的结果全丢了，
 * 而它们本来是有价值的数据。
 *
 * 因此这里做两件事：
 *   1. 调用级重试（指数退避），把偶发网络抖动消化掉
 *   2. 让调用方在**单次运行失败**时不丢掉已有结果（见下面的 try/catch）
 *
 * 重试只针对网络错误与 429/5xx —— 其余 4xx 说明请求本身有问题，
 * 重试只会浪费配额并掩盖真正的错误。
 */
async function postJson(
  body: unknown,
  options: { attempts?: number; label: string }
): Promise<{ raw: string; durationMs: number }> {
  const attempts = options.attempts ?? 3
  const url = `${BASE_URL.replace(/\/$/, '')}/chat/completions`
  let lastError: unknown

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const started = Date.now()
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      })

      if (response.ok) {
        const payload = (await response.json()) as {
          choices?: { message?: { content?: string } }[]
        }
        return {
          raw: payload.choices?.[0]?.message?.content ?? '',
          durationMs: Date.now() - started,
        }
      }

      const text = await response.text().catch(() => '')
      const recoverable = response.status === 429 || response.status >= 500
      const error = new Error(`${options.label} HTTP ${response.status}: ${text.slice(0, 200)}`)
      if (!recoverable) throw Object.assign(error, { fatal: true })
      lastError = error
    } catch (error) {
      if ((error as { fatal?: boolean }).fatal) throw error
      lastError = error
    }

    if (attempt < attempts) {
      const backoffMs = 500 * 2 ** (attempt - 1)
      console.log(
        `      ⚠️ ${options.label} 第 ${attempt} 次失败，${backoffMs}ms 后重试：` +
          `${lastError instanceof Error ? lastError.message : String(lastError)}`
      )
      await new Promise((resolve) => setTimeout(resolve, backoffMs))
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`${options.label} 重试 ${attempts} 次后仍失败：${String(lastError)}`)
}

/**
 * judge 的模型口：把一段 prompt 变成一个**分数**。
 *
 * 走 `/chat/completions` 而不是 ElizaOS 的 `useModel`：
 * judge 是**评测设施**，不该依赖被测对象（Runtime）的装配。
 * 若它依赖 Runtime，那"Runtime 挂了导致 judge 也挂了"会被误读成
 * "她人格漂移了"。
 *
 * ⚠️ 刻意**只**暴露文本：分数怎么解析在 `evals/m3/runtime/ports.ts` 里
 * （失败安全）。模型路由与评分逻辑分开，换模型不影响门槛的定义。
 */
async function invokeJudgeModel(prompt: string): Promise<{ raw: string; durationMs: number }> {
  return postJson(
    {
      model: MODEL_ID,
      messages: [
        {
          role: 'system',
          content:
            '你是一个严格的角色人格评测员。只输出 JSON，形如 {"score": 0.8, "reason": "…"}。' +
            'score 必须在 0 到 1 之间。不要输出任何其它内容。',
        },
        { role: 'user', content: prompt },
      ],
      // 低温：judge 要的是可重复的判断，不是创意
      temperature: 0.2,
      max_tokens: 400,
    },
    { label: 'judge 模型调用' }
  )
}

/**
 * **角色自己**的模型调用：把她的 prompt 变成她会说出口的话。
 *
 * ============================================================================
 *  为什么必须与 judge 的那个分开（实测踩到的严重缺陷）
 * ============================================================================
 * 第一版的评测宿主在**任何**模式下都不调模型，`sayOnce()` 返回的是
 * 合成串 `<m3-echo compiler=… sections=…>`。于是 live 档把那段合成串
 * 当成"她的回答"交给 judge，judge 很诚实地给出 0.05 并说明
 * "回答只有一段系统编译标记，没有任何实际内容"。
 *
 * 而报告里那个 0.05 看起来像一个真实结论（"她价值取向不对"）——
 * 实际上它只说明**评测没有真的让她说话**。这是评测里最危险的一类缺陷：
 * 数字看起来合理，但量的是错的东西。
 *
 * 走 `/chat/completions` 的理由与 judge 相同：评测设施不该依赖被测对象
 * （Runtime）的装配 —— 否则"Runtime 挂了导致测不了"会被读成"她人格漂移了"。
 *
 * 温度用项目既有的对话温度（0.3）：人格评测要评的是**她平时的表现**，
 * 不是一个被刻意调低随机性之后的版本。
 */
async function invokeCharacterModel(prompt: string): Promise<{ raw: string; durationMs: number }> {
  return postJson(
    {
      model: MODEL_ID,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 600,
    },
    { label: '角色模型调用' }
  )
}

// ---------------------------------------------------------------------------
// 跑
// ---------------------------------------------------------------------------

console.log('='.repeat(72))
console.log('M3 人格评测（真实模型档）')
console.log('='.repeat(72))
console.log(`  模型   ：${MODEL_ID} @ ${BASE_URL}`)
console.log(`  套件   ：${(options.suiteIds.length > 0 ? options.suiteIds : m3SuiteIds()).join(', ')}`)
if (options.filter) console.log(`  过滤   ：${options.filter}`)
if (options.turns !== undefined) console.log(`  长对话 ：${options.turns} 轮`)
console.log(`  重复   ：${options.runs} 次`)

const thresholds = thresholdsWithBaseline()
console.log(`  阈值   ：${describeThresholds(thresholds)}`)
console.log(`  硬零   ：${M3_HARD_ZERO_METRICS.join(', ')}`)
console.log('')

/** --dump-judge 时攒下来的 judge prompt */
const judgePrompts: string[] = []

const reports: EvalReport[] = []
const started = Date.now()

for (let run = 1; run <= options.runs; run += 1) {
  if (options.runs > 1) console.log(`\n--- 第 ${run}/${options.runs} 次 ---`)
  /*
   * ⚠️ 单次运行失败**不能**丢掉已有结果。
   *
   * 实测踩到过：第 3 次运行撞上一次 `ECONNRESET`，整个脚本崩掉，
   * 连 baseline.json 都没写出 —— 而前两次已经跑完了，它们本来是有价值的数据。
   *
   * 因此这里把每次运行包起来：失败的记下来、成功的继续攒。
   * 只要有**至少一次**成功就还能产出 baseline（并在报告里写明实际次数），
   * 全部失败才退出。
   */
  try {
    const { report } = await runM3({
      suites: M3_SUITES,
      live: true,
      // judge 的口：它要给出一个**分数**
      invokeModel: invokeJudgeModel,
      // 角色自己的口：她要说出**她会说的话**。
      // 少了这一个，人格评测量的是引擎的合成串（见上面的说明）。
      invokeCharacterModel,
      ...(options.suiteIds.length > 0 ? { suiteIds: options.suiteIds } : {}),
      ...(options.filter ? { filter: options.filter } : {}),
      modelProfile: MODEL_ID,
      thresholds,
      // 诊断入口：把实际发给 judge 的 prompt 攒起来，`--dump-judge` 时打印。
      // 排查"分数为什么这么低"的第一步永远是"看它看到了什么"。
      ...(options.dumpJudge
        ? { onJudgePrompt: (prompt: string) => judgePrompts.push(prompt) }
        : {}),
      onCase: options.quiet
        ? undefined
        : ({ caseId, suiteId }) => {
            process.stdout.write(`  ⏳ ${caseId}  (${suiteId})\n`)
          },
    })
    reports.push(report)
    console.log(
      `  本次：${report.results.filter((r) => r.passed).length}/${report.results.length} 用例通过，` +
        `硬零违规 ${report.hardZeroViolations.length} 次`
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.log(`  ⚠️ 第 ${run} 次运行失败（已跳过，保留前几次的结果）：${message.slice(0, 200)}`)
  }
}

if (reports.length === 0) {
  console.log('')
  console.log('='.repeat(72))
  console.log('❌ 没有任何一次运行成功 —— 无法产出结算结果')
  console.log('='.repeat(72))
  console.log('')
  console.log('  这**不是**"她人格漂移"，而是**这次测量没有完成**。')
  console.log('  报告里不会写出任何分数 —— 编一个数字比不写更糟。')
  console.log('')
  console.log('  常见原因：网络/API 不稳定（已重试 3 次仍失败）、额度用尽、模型名不对。')
  console.log('  建议：稍后重跑；或先用 --suite 缩小范围定位问题。')
  console.log('='.repeat(72))
  process.exit(2)
}

// ---------------------------------------------------------------------------
// 汇总（多次运行时算 mean / variance —— 计划书第 120 节）
// ---------------------------------------------------------------------------

/** 把多份报告按指标聚合成 mean 与 variance（judge 分数与通过率都算） */
function aggregate(
  items: readonly EvalReport[]
): { metric: string; mean: number; variance: number; samples: number }[] {
  const buckets = new Map<string, number[]>()
  for (const report of items) {
    for (const [metric, entry] of Object.entries(report.metrics)) {
      // 有 judge 分数就用分数，否则用确定性通过率
      const value =
        entry.score !== undefined
          ? entry.score
          : entry.measured > 0
            ? entry.passed / entry.measured
            : Number.NaN
      if (!Number.isFinite(value)) continue
      const list = buckets.get(metric) ?? []
      list.push(value)
      buckets.set(metric, list)
    }
  }

  return [...buckets.entries()]
    .map(([metric, values]) => {
      const mean = values.reduce((sum, v) => sum + v, 0) / values.length
      const variance =
        values.length > 1
          ? values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1)
          : 0
      return { metric, mean, variance, samples: values.length }
    })
    .sort((a, b) => a.metric.localeCompare(b.metric))
}

const aggregates = aggregate(reports)
const lastReport = reports[reports.length - 1]

/*
 * ⚠️ "一条都没测到"必须显式警告，不能安静地绿。
 *
 * 实测踩到过：`--suite identity-core` 看起来跑得好好的、硬零指标全绿、
 * 退出码 0 —— 而实际上那个套件的 4 条用例全部 `requiresModel: false`，
 * 属于**离线档**，真实模型档一条都没跑。
 *
 * 这类"看起来通过、实际什么都没量"的状态比失败更危险：
 * 失败会有人去查，而绿色的空报告不会。
 */
if (lastReport.results.length === 0) {
  console.log('')
  console.log('='.repeat(72))
  console.log('⚠️  本次没有测到任何用例')
  console.log('='.repeat(72))
  console.log('')
  console.log('  真实模型档只跑 `requiresModel: true` 的用例。你选中的范围里')
  console.log('  一条这样的用例都没有 —— 因此这次"全绿"**不代表任何人格结论**。')
  console.log('')
  console.log('  · 想看哪些用例属于哪一档：tsx scripts/diag-m3-coverage.ts')
  console.log('  · 不带 --suite 跑全部：      pnpm eval:m3:live --quiet')
  console.log('')
  console.log('='.repeat(72))
}

console.log('')
console.log('='.repeat(72))
console.log(`指标（${options.runs} 次运行的 mean / variance）`)
console.log('='.repeat(72))
console.log('')
console.log('  说明：人格指标是 judge 分数（越高越好）；硬零指标是**通过比例**')
console.log('        （1.000 = 一次违规都没有，0.000 = 全部违规）。')
console.log('')

const width = Math.max(...aggregates.map((entry) => entry.metric.length), 12)
const HARD_ZERO = new Set<string>(M3_HARD_ZERO_METRICS)

for (const entry of aggregates) {
  const frozen = thresholds.minimums[entry.metric as keyof typeof thresholds.minimums]

  /*
   * ⚠️ 两类指标的"均值"含义完全不同，必须分开呈现。
   *
   * 实测踩到过的误读：`SeedMutationViolationCount  mean 1.000` 看起来
   * 像是"违规了一次"，而它其实是**通过比例 100%**（一次违规都没有）。
   * 一个把"全绿"读成"最坏情况"的报告，会让人去查一个不存在的问题 ——
   * 而查不到之后，下一次真正的问题也会被忽略。
   */
  const isZero = HARD_ZERO.has(entry.metric)
  const label = isZero ? '通过比例' : 'mean    '
  const verdict = isZero
    ? entry.mean >= 1
      ? '✅ 零违规'
      : `🔴 违规 ${Math.round((1 - entry.mean) * entry.samples)} / ${entry.samples} 次`
    : frozen === undefined
      ? '（未冻结阈值）'
      : entry.mean >= frozen
        ? `✅ ≥ ${frozen}`
        : `❌ < ${frozen}`

  console.log(
    `  ${entry.metric.padEnd(width)}  ${label} ${entry.mean.toFixed(3)}  ` +
      `var ${entry.variance.toFixed(4)}  ${verdict}`
  )
}

// --- 逐条用例的 judge 结果 -------------------------------------------------
//
// 只打**有分**的那些：没有分说明这条用例不需要模型，打出来只是噪声。
// 但 skipped 的要打 —— "这次没测到"与"这次测到了且通过"必须能区分。
console.log('')
console.log('逐条 judge 结果：')
let printedJudge = 0
for (const result of lastReport.results) {
  const scored = result.judged.filter((entry) => entry.status === 'scored')
  const skipped = result.judged.filter((entry) => entry.status === 'skipped')
  if (scored.length === 0 && skipped.length === 0) continue
  printedJudge += 1
  console.log(`  ${result.passed ? '✅' : '❌'} ${result.caseId}  (${result.suiteId})`)
  for (const entry of scored) {
    const mark = (entry.score ?? 0) >= (thresholds.minimums['PersonalityConsistency'] ?? 0.6)
      ? '  '
      : ' ⚠️'
    console.log(`       ${entry.metric} ${entry.score?.toFixed(2)}${mark}  ${entry.id}`)
    if (entry.detail) console.log(`           ${entry.detail.slice(0, 200)}`)
  }
  for (const entry of skipped) {
    console.log(`       ⏭️  ${entry.id}：${entry.detail ?? '跳过'}`)
  }
  // 确定性检查的失败也要在这里现身（否则"用例红但看不到原因"）
  for (const entry of result.deterministic.filter((item) => !item.pass)) {
    console.log(`       ❌ [${entry.id}] ${entry.detail ?? '未通过'}`)
  }
}
if (printedJudge === 0) console.log('  （本次没有任何 judge 检查：选中的用例都不需要模型）')

console.log('')
if (lastReport.hardZeroViolations.length === 0) {
  console.log('硬零指标：全部为 0 ✅')
} else {
  console.log('='.repeat(72))
  console.log('CRITICAL —— 硬零指标不为 0（计划书第 115–118 节）')
  console.log('='.repeat(72))
  for (const violation of lastReport.hardZeroViolations) {
    console.log(`  🔴 ${violation.metric}  用例 ${violation.caseId}`)
    console.log(`       ${violation.detail}`)
  }
}

const summary: RunSummary = {
  passed: lastReport.results.filter((result) => result.passed).length,
  failed: lastReport.results.filter((result) => !result.passed).length,
  failures: lastReport.results
    .filter((result) => !result.passed)
    .map((result) => ({
      name: result.caseId,
      failure: {
        message:
          result.deterministic.find((entry) => !entry.pass)?.detail ??
          result.judged.find((entry) => entry.status === 'scored' && (entry.score ?? 1) < 0.6)
            ?.detail ??
          '未通过（原因见报告）',
      },
    })),
  durationMs: Date.now() - started,
}
printSummary(summary, 'M3 真实模型评测结果（最后一次运行）')

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

if (options.out) {
  const target = join(process.cwd(), options.out)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, `${JSON.stringify(reports, null, 2)}\n`, 'utf8')
  console.log(`报告已写出：${relative(process.cwd(), target)}`)
}

// ---------------------------------------------------------------------------
// baseline
// ---------------------------------------------------------------------------

if (options.writeBaseline) {
  const target = join(process.cwd(), M3_BASELINE_PATH)
  const existing = readBaseline(target)

  const values: Record<string, number> = {}
  const variance: Record<string, number> = {}
  for (const entry of aggregates) {
    values[entry.metric] = Number(entry.mean.toFixed(4))
    variance[entry.metric] = Number(entry.variance.toFixed(6))
  }

  const baseline: M3BaselineFile = {
    baseline: {
      model: MODEL_ID,
      temperature: 0.2,
      runs: options.runs,
      measuredAt: new Date().toISOString(),
    },
    values: values as M3BaselineFile['values'],
    variance: variance as M3BaselineFile['variance'],
    cases: lastReport.results.map((result) => ({
      caseId: result.caseId,
      suiteId: result.suiteId,
      passed: result.passed,
      ...(result.judged.find((entry) => entry.score !== undefined)?.score === undefined
        ? {}
        : { score: result.judged.find((entry) => entry.score !== undefined)!.score }),
    })),
    // ⚠️ `minimums` 刻意**不自动填**：从"实测均值"到"可接受的回退线"
    // 中间有一步人的判断（计划书第 120 节）。若这里自动写进去，
    // 门槛就会跟着第一次跑偏的结果一起定下来。
    ...(existing && 'minimums' in existing
      ? { minimums: (existing as { minimums?: Record<string, number> }).minimums }
      : {}),
  } as M3BaselineFile

  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8')
  console.log('')
  console.log(`baseline 已写出：${M3_BASELINE_PATH}`)
  console.log(
    `  模型 ${MODEL_ID}｜${options.runs} 次运行｜` +
      (existsSync(target) ? '（重复运行会覆盖；minimums 不会被自动填）' : '')
  )
  console.log('')
  console.log('  下一步（人工）：')
  console.log('    1. 看 mean 与 variance：variance 大的指标说明这次测量本身不稳，先别冻结')
  console.log('    2. 在 baseline.json 里补 "minimums"，把门槛**显式**写下来')
  console.log('    3. 之后的运行就会按它判定（改动可见：一次 diff 就能看出门槛被调过）')
}

if (options.dumpJudge) {
  console.log('')
  console.log('='.repeat(72))
  console.log(`实际发给 judge 的 prompt（${judgePrompts.length} 次调用）`)
  console.log('='.repeat(72))
  judgePrompts.forEach((prompt, index) => {
    console.log(`\n--- 调用 #${index + 1}（${prompt.length} 字符）---`)
    console.log(prompt)
  })
}
process.exit(lastReport.hardZeroViolations.length === 0 && summary.failed === 0 ? 0 : 1)
