/**
 * M6.1 —— **截断（输出预算耗尽）的单变量实验**（用户 2026-09-23 工作单第 2 项）。
 *
 * ============================================================================
 *  它要回答的问题
 * ============================================================================
 * 两轮全量读数里，失败**全部**是 `truncated`（`finish_reason = length` 且 content 为空）
 * 与 `unresolved`（语义），**没有一次**网络/HTTP 失败。于是只有一个变量值得动：
 * **输出预算**（`max_tokens`）。本脚本只动它。
 *
 * ```text
 *   --phase capability   核实端点**支持**多大的输出预算（逐档试，遇到硬拒绝就停）
 *   --phase compare      固定样本 × 固定预算档 × 固定次数，逐单元记录
 * ```
 *
 * ============================================================================
 *  纪律（写死在代码里，不是口号）
 * ============================================================================
 * ```text
 *   ① 单变量：提示（@4）、模型、reasoning_effort、temperature **一个都不动**；
 *      只有 max_tokens 在两个档之间变化。改别的一律拒绝运行（见 assertDesign）。
 *   ② 不重试到成功：实验单元一律 maxAttempts = 1。失败就是失败，照实记录。
 *   ③ 设计先冻结：样本、预算档、重复次数、停止条件在**跑之前**写进证据。
 *   ④ 一次成功 ≠ 修好：报告里给出**每单元的成功数**，不把"某次过了"写成"已修复"。
 *   ⑤ 单元数固定：跑满就停，不因为"再试一次可能就好了"延长。
 * ```
 *
 * 用法（必须经测试包装器）：
 * ```bash
 * pnpm with-test-model pnpm m6.1:budget:capability
 * pnpm with-test-model pnpm m6.1:budget:compare -- --candidate 32000
 * ```
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import { MeasurementInvalidError } from '../src/infrastructure/persistence/production-db-safety.ts'
import { SPLITS } from './m6.1-contract.ts'
import { TEST_MODEL_WRAPPER_MARKER } from './m6.1-command-surface.ts'
import { sha256OfText } from './m6.1-evidence.ts'
import {
  M6_1_JUDGE_PROMPT_VERSION,
  buildJudgePrompt,
  itemsFromCorpus,
  type InstrumentItem,
} from './m6.1-instrument.ts'
import {
  M6_1_JUDGE_MAX_TOKENS,
  M6_1_JUDGE_REASONING_EFFORT,
  createOpenAiInstrumentJudge,
} from './m6.1-judge-openai.ts'

const ROOT = resolve(process.cwd())
const EVAL_DIR = join(ROOT, 'artifacts', 'm6.1')

/**
 * ⚠️ **失败样本固定为两轮里都复现的 truncated 项**（不是因为"它们看起来难"，而是实测）。
 * 依据：`artifacts/m6.1/m6.1-wpinstr-20260923-139e95c1b8f5-313d` 与 `…-4a3b2a1d50cd-d732`
 * 的拆解（`pnpm m6.1:failures`）—— 第 1 轮 truncated 5 条、第 2 轮 7 条，**交集**就是这 4 条。
 */
const FAILURE_ITEMS = ['J-4', 'J-2', 'I-2', 'D-6'] as const
/** 对照：两轮都判成、且第 1 轮 rawLength 最长的两条（A-1 444 字 / F-1 189 字）。 */
const CONTROL_ITEMS = ['A-1', 'F-1'] as const
/** 重复次数 —— 与 CD-8 的探针档位一致（k=3）。 */
const REPEATS_PER_CELL = 3
/** 端点的能力档：逐档试，**遇到硬拒绝就停在那一档**（不跳过它去试更大的）。 */
const CAPABILITY_BUDGETS = [8000, 16000, 32000, 64000] as const

type Phase = 'capability' | 'compare'

interface CellRecord {
  readonly itemId: string
  readonly kind: 'failure' | 'control'
  readonly budget: number
  readonly repeat: number
  readonly ok: boolean
  readonly callFailure: string | null
  readonly finishReason: string | null
  readonly httpStatus: number | null
  readonly rawLength: number
  readonly durationMs: number
  readonly usage: unknown
}

function parseArgs(argv: readonly string[]): { phase: Phase; candidate: number | null } {
  let phase: Phase | null = null
  let candidate: number | null = null
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--phase') {
      const value = argv[index + 1]
      if (value !== 'capability' && value !== 'compare') {
        throw new Error(`--phase 只能是 capability / compare（收到 ${String(value)}）`)
      }
      phase = value
      index += 1
      continue
    }
    if (argv[index] === '--candidate') {
      const value = Number(argv[index + 1] ?? '')
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`--candidate 必须是正整数（收到 ${String(argv[index + 1])}）`)
      }
      candidate = value
      index += 1
    }
  }
  if (phase === null) throw new Error('必须显式给出 --phase capability 或 --phase compare')
  if (phase === 'compare' && candidate === null) {
    throw new Error('--phase compare 必须给出 --candidate <n>（候选预算由人选定，不由脚本猜）')
  }
  return { phase, candidate }
}

function readCorpus(): Map<string, InstrumentItem> {
  const byId = new Map<string, InstrumentItem>()
  for (const split of SPLITS) {
    const abs = join(ROOT, 'evals', 'm6.1', 'corpus', `${split}.jsonl`)
    if (!existsSync(abs)) throw new MeasurementInvalidError(`MEASUREMENT INVALID：缺语料 ${abs}`)
    const rows: unknown[] = []
    for (const line of readFileSync(abs, 'utf8').split('\n')) {
      if (line.trim() === '') continue
      rows.push(JSON.parse(line))
    }
    for (const item of itemsFromCorpus(rows)) byId.set(item.itemId, item)
  }
  return byId
}

async function main(): Promise<void> {
  if ((process.env[TEST_MODEL_WRAPPER_MARKER] ?? '') === '') {
    console.error(
      `[m6.1-budget-probe] wrapper_required：必须经测试包装器运行` +
        `（pnpm with-test-model …）：缺少 ${TEST_MODEL_WRAPPER_MARKER} 标记 ⇒ 拒绝，**绝不**回落到 .env 的原 Key`
    )
    process.exit(2)
  }
  const { phase, candidate } = parseArgs(process.argv.slice(2))
  if ((process.env.OPENAI_API_KEY ?? '').trim() === '') {
    console.error('[m6.1-budget-probe] no_api_key：测试端点没有 key ⇒ 拒绝运行')
    process.exit(2)
  }

  const startedAt = new Date().toISOString()
  const budgetOptions = phase === 'capability' ? CAPABILITY_BUDGETS : [M6_1_JUDGE_MAX_TOKENS, candidate as number]
  const outPath = join(EVAL_DIR, `budget-probe-${phase}.json`)
  const corpus = readCorpus()

  /*
   * 提示正文摘要：证明"两个预算档之间提示逐字相同"。
   * 只声明"我没改提示"不算证据 —— 摘要相同才算。
   * 用**固定样本真实会喂进去的那几条提示**算，而不是拿 id 拼一个占位串。
   */
  const promptDigest =
    phase === 'capability'
      ? sha256OfText('(capability 档用固定极简提示，不涉及语料)')
      : sha256OfText(
          [...FAILURE_ITEMS, ...CONTROL_ITEMS]
            .map((id) => {
              const item = corpus.get(id)
              if (item === undefined) {
                throw new MeasurementInvalidError(
                  `MEASUREMENT INVALID：固定样本 ${id} 不在冻结语料里 ⇒ 摘要算不出来，拒绝运行`
                )
              }
              return `${id}\u0000${buildJudgePrompt(item)}`
            })
            .join('\u0001')
        )

  /*
   * ---- 设计先冻结：**跑之前**把样本、档位、次数、停止条件写进证据 ----
   * 事后补设计就等于事后挑结果；这里先落盘再开跑。
   */
  const design = {
    phase,
    promptVersion: M6_1_JUDGE_PROMPT_VERSION,
    promptDigest,
    failureItems: [...FAILURE_ITEMS],
    controlItems: [...CONTROL_ITEMS],
    budgets: budgetOptions,
    repeatsPerCell: REPEATS_PER_CELL,
    maxAttemptsPerCell: 1,
    holdConstant: [
      '提示 = m6.1-judge-prompt@4（逐字）',
      '模型 = 包装器给的 model',
      `reasoning_effort = ${M6_1_JUDGE_REASONING_EFFORT}`,
      'temperature = 0',
    ],
    onlyVariable: 'max_tokens（输出预算）',
    stoppingCondition:
      phase === 'capability'
        ? '逐档向上试；**遇到第一个硬拒绝（HTTP 非 2xx）就停在那一档**，不跳过它去试更大的'
        : `跑满 ${String((FAILURE_ITEMS.length + CONTROL_ITEMS.length) * budgetOptions.length * REPEATS_PER_CELL)} 个单元即停；` +
          '不提前停、不重试到成功、失败照实记录',
    notClaimed: [
      '一次成功 ≠ 已修复：本实验只给每单元的**成功数**，修复判定属于后续裁定。',
      '本实验不产生量具读数，**不**参与有效性判定。',
    ],
    startedAt,
  }

  const judgeInfo = createOpenAiInstrumentJudge({ model: process.env.OPENAI_SMALL_MODEL })
  const cells: CellRecord[] = []
  const capability: { budget: number; accepted: boolean; detail: string }[] = []
  /*
   * 断点：每跑完一个单元就落盘一次。
   *
   * 这个实验可能跑几十分钟（截断项的时延 30–70s/次），被杀掉时不能整轮作废 ——
   * 而且"跑到一半被杀"必须能与"跑完了"区分：只有最终那份 JSON 才是读数。
   */
  const partialPath = join(EVAL_DIR, `budget-probe-${phase}.partial.jsonl`)
  /*
   * ⚠️ **先清空再追加**。第一版直接 append ⇒ 连跑两次的断点文件里会有两份实验的单元
   * （8 行 vs 最终 4 行），事后照着它复核就会把两次运行混成一次 —— 那正是本仓库
   * 反复登记的那类"证据与描述不符"。断点文件必须**只属于这一次运行**。
   */
  writeFileSync(partialPath, '', 'utf8')
  const recordCell = (cell: CellRecord): void => {
    cells.push(cell)
    appendFileSync(partialPath, `${JSON.stringify(cell)}\n`, 'utf8')
  }

  if (phase === 'capability') {
    /*
     * 能力档：只问"端点**收不收**这个预算"，不问判定质量。
     * 用固定极简提示 ⇒ 输出必然很短 ⇒ 这里量的是**配置上限**，不是内容长度。
     */
    const capPrompt = '只回复两个字：收到'
    for (const budget of CAPABILITY_BUDGETS) {
      const judge = createOpenAiInstrumentJudge({
        model: process.env.OPENAI_SMALL_MODEL,
        maxTokens: budget,
        maxAttempts: 1,
      })
      const result = await judge.judge(capPrompt)
      const hardRejected = result.httpStatus !== null && (result.httpStatus < 200 || result.httpStatus >= 300)
      capability.push({
        budget,
        accepted: !hardRejected && result.callFailure !== 'http_error' && result.callFailure !== 'no_api_key',
        detail:
          hardRejected || result.callFailure === 'http_error'
            ? `HTTP ${String(result.httpStatus)} ⇒ 端点拒绝该预算`
            : `callFailure=${String(result.callFailure)} finish=${String(result.finishReason)} usage=${JSON.stringify(result.usage)}`,
      })
      recordCell({
        itemId: '(capability)',
        kind: 'failure',
        budget,
        repeat: 1,
        ok: result.ok,
        callFailure: result.callFailure,
        finishReason: result.finishReason,
        httpStatus: result.httpStatus,
        rawLength: result.rawLength,
        durationMs: result.durationMs,
        usage: result.usage,
      })
      /*
       * 停在**第一个硬拒绝**就结束 —— 继续往更大试没有信息量，
       * 而且"跳过一个被拒的档去试下一个"会让结论变成"某个更大的值也许行"。
       */
      if (hardRejected || result.callFailure === 'http_error') break
      await new Promise<void>((resolve) => setTimeout(resolve, 1_500))
    }
  } else {
    const plan: { id: string; kind: 'failure' | 'control' }[] = [
      ...FAILURE_ITEMS.map((id) => ({ id, kind: 'failure' as const })),
      ...CONTROL_ITEMS.map((id) => ({ id, kind: 'control' as const })),
    ]
    for (const budget of budgetOptions) {
      const judge = createOpenAiInstrumentJudge({
        model: process.env.OPENAI_SMALL_MODEL,
        maxTokens: budget,
        maxAttempts: 1,
      })
      for (const entry of plan) {
        const item = corpus.get(entry.id)
        if (item === undefined) {
          throw new MeasurementInvalidError(
            `MEASUREMENT INVALID：固定样本 ${entry.id} 不在冻结语料里 ⇒ 实验不可复现，拒绝运行`
          )
        }
        const prompt = buildJudgePrompt(item)
        for (let repeat = 0; repeat < REPEATS_PER_CELL; repeat += 1) {
          await new Promise<void>((resolve) => setTimeout(resolve, 1_500))
          const result = await judge.judge(prompt)
          const cell: CellRecord = {
            itemId: entry.id,
            kind: entry.kind,
            budget,
            repeat,
            ok: result.ok,
            callFailure: result.callFailure,
            finishReason: result.finishReason,
            httpStatus: result.httpStatus,
            rawLength: result.rawLength,
            durationMs: result.durationMs,
            usage: result.usage,
          }
          recordCell(cell)
          console.log(
            `  ${budget.toString().padStart(6)} ${entry.id.padEnd(6)} #${String(repeat)} ` +
              `${cell.ok ? 'ok ' : 'FAIL'} ${String(cell.callFailure ?? '-').padEnd(11)} ` +
              `finish=${String(cell.finishReason ?? '-')} len=${String(cell.rawLength)} ms=${String(cell.durationMs)} ` +
              `usage=${JSON.stringify(cell.usage)}`
          )
        }
      }
    }
  }

  if (cells.length === 0) {
    throw new MeasurementInvalidError('MEASUREMENT INVALID：一个单元都没跑 ⇒ 实验无从谈起')
  }

  /** 逐单元汇总：成功数 / 总数，**不**把"某次过"写成"已修复"。 */
  const summary = budgetOptions.map((budget) => {
    const cellsOfBudget = cells.filter(
      (cell) => cell.budget === budget && (phase === 'capability' || cell.itemId !== '(capability)')
    )
    const byItem = [...FAILURE_ITEMS, ...CONTROL_ITEMS].map((id) => {
      const mine = cellsOfBudget.filter((cell) => cell.itemId === id)
      return {
        itemId: id,
        ok: mine.filter((cell) => cell.ok).length,
        total: mine.length,
        budgetExhausted: mine.filter((cell) => cell.callFailure === 'truncated').length,
      }
    })
    return {
      budget,
      cells: cellsOfBudget.length,
      ok: cellsOfBudget.filter((cell) => cell.ok).length,
      truncated: cellsOfBudget.filter((cell) => cell.callFailure === 'truncated').length,
      byItem,
    }
  })

  const observed = {
    schemaVersion: `m6.1-budget-probe-${phase}@1`,
    testId:
      phase === 'capability'
        ? 'M6.1 端点支持的最大输出预算（核实）'
        : 'M6.1 截断的单变量预算对照（固定样本 × 固定预算档 × 固定次数）',
    design,
    judge: { id: judgeInfo.id, host: judgeInfo.baseUrlHost, model: judgeInfo.model },
    capability: phase === 'capability' ? capability : null,
    summary,
    cells,
    finishedAt: new Date().toISOString(),
  }

  writeFileSync(outPath, `${JSON.stringify(observed, null, 2)}\n`, 'utf8')

  console.log('='.repeat(78))
  console.log(observed.testId)
  console.log('='.repeat(78))
  console.log(`  判定器 ${judgeInfo.id} · host=${judgeInfo.baseUrlHost} · model=${judgeInfo.model}`)
  console.log(`  两个档位之间**只**改 max_tokens；提示 ${M6_1_JUDGE_PROMPT_VERSION} 逐字不变`)
  for (const entry of summary) {
    console.log(
      `\n  预算 ${String(entry.budget)}：单元 ${String(entry.cells)} · 成功 ${String(entry.ok)} · ` +
        `预算耗尽 ${String(entry.truncated)}`
    )
    for (const item of entry.byItem) {
      console.log(
        `    ${item.itemId.padEnd(6)} 成功 ${String(item.ok)}/${String(item.total)} · ` +
          `truncated ${String(item.budgetExhausted)}`
      )
    }
  }
  if (phase === 'capability') {
    console.log('\n  端点能力：')
    for (const entry of capability) {
      console.log(`    ${String(entry.budget).padStart(6)} ${entry.accepted ? '接受' : '**拒绝**'} — ${entry.detail}`)
    }
  }
  console.log(`\n证据：${relative(ROOT, outPath).split(/[\\/]/).join('/')}`)
  console.log(
    '\n⚠️ 一次成功 ≠ 已修复：上表是**每单元的成功数**。修复判定需要后续裁定，本实验不产生量具读数。'
  )
}

try {
  await main()
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[m6.1-budget-probe] 失败关闭：${message}`)
  if (error instanceof MeasurementInvalidError) {
    console.error('[m6.1-budget-probe] 这是 MEASUREMENT INVALID，不是"没问题"')
  }
  process.exit(2)
}
