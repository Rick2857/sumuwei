/**
 * M6.1 —— **判定引文探针**（诊断工具；不是门、不是量具判定）。
 *
 * ============================================================================
 *  它做什么
 * ============================================================================
 * 从某一轮 run 的 `judge-inputs.jsonl`（判定器当时的**逐字输入**，2026-09-25 用户裁定 C
 * 后由 live-short 留存在 gitignored 的 local）里取出指定条目，用**当前树上的量具**
 * 重新判定 N 次，把每次采样的**逐句断言（quote + label）**完整打出来/落盘。
 *
 * 为什么需要它（2026-09-25 小样的真实缺口）：
 *   SRP-B-10 的报警只知道标签（`UNSUPPORTED_RECOLLECTION` 等），**不知道被标的是哪句话**
 *   —— 归因工具只能给到"reply_violation + 需人读确认"。FMB 契约 §6 的新标注集
 *   要求逐句引文可查；本工具就是那个能力的最小实现。
 *
 * ============================================================================
 *  纪律（失败关闭，与 judge-stability 同一套）
 * ============================================================================
 * ```text
 * ① 必须经测试包装器（DSH_TEST_MODEL_WRAPPER=1）——绝不回落 .env 的原 key
 * ② judge-inputs 行里的 promptVersion 必须 === 当前 M6_1_JUDGE_PROMPT_VERSION
 *    （漂移 ⇒ 拒绝：拿新提示重放旧输入，读数没有指称）
 * ③ 输出文件 judge-quote-probe-<label>.json 已存在 ⇒ 拒绝（不许覆盖旧读数）
 * ④ 本工具是**诊断**：产物标 DIAGNOSTIC，不构成任何门的判定，不进任何 configKey
 * ```
 *
 * 用法：
 * ```bash
 * pnpm with-test-model pnpm exec tsx scripts/m6.1-judge-quote-probe.ts \
 *   --run <runId> --items SRP-B-10 --samples 3 --label <a-z0-9->
 * ```
 */

import 'dotenv/config'

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import { M6_1_LOCAL_PARENT } from './m6.1-evidence.ts'
import { buildJudgePrompt, itemsFromCorpus, M6_1_JUDGE_PROMPT_VERSION, type InstrumentItem } from './m6.1-instrument.ts'
import {
  createOpenAiInstrumentJudge,
  M6_1_JUDGE_MAX_ATTEMPTS,
  M6_1_JUDGE_MIN_INTERVAL_MS,
  M6_1_JUDGE_TIMEOUT_MS,
} from './m6.1-judge-openai.ts'
import { TEST_MODEL_WRAPPER_MARKER } from './m6.1-command-surface.ts'
import { modelRouteFromEnv } from './m6.1-run-guards.ts'

const ROOT = resolve(process.cwd())

const argValue = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

const runId = argValue('--run')
if (runId === undefined || runId.trim() === '') {
  console.error('失败关闭：必须给 --run <runId>（有 judge-inputs.jsonl 的那一轮）')
  process.exit(2)
}
const itemsRaw = argValue('--items')
if (itemsRaw === undefined || itemsRaw.trim() === '') {
  console.error('失败关闭：必须给 --items <id,id,…>（至少一条）')
  process.exit(2)
}
const itemIds = itemsRaw.split(',').map((value) => value.trim()).filter((value) => value !== '')
const samples = Number(argValue('--samples') ?? '3')
if (!Number.isInteger(samples) || samples < 1 || samples > 8) {
  console.error(`失败关闭：--samples 必须是 1..8 的整数（收到 ${String(argValue('--samples'))}）`)
  process.exit(2)
}
const label = argValue('--label')
if (label === undefined || !/^[a-z0-9-]+$/.test(label)) {
  console.error('失败关闭：必须给 --label <a-z0-9->（产物文件名用它 ⇒ 不许覆盖旧读数）')
  process.exit(2)
}
if (process.env[TEST_MODEL_WRAPPER_MARKER] !== '1') {
  console.error(`失败关闭：缺 ${TEST_MODEL_WRAPPER_MARKER} 标记 ⇒ 拒绝运行（绝不回落到 .env 的原 key）。`)
  process.exit(2)
}
if ((process.env.OPENAI_API_KEY ?? '').trim() === '') {
  console.error('失败关闭：OPENAI_API_KEY 为空 ⇒ 拒绝运行（不猜、不回落）。')
  process.exit(2)
}
const outputPath = join(ROOT, 'artifacts', 'm6.1', `judge-quote-probe-${label}.json`)
if (existsSync(outputPath)) {
  console.error(`失败关闭：${outputPath} 已存在 ⇒ 换一个 --label（**不许覆盖已有读数**）`)
  process.exit(2)
}

const inputsPath = join(ROOT, M6_1_LOCAL_PARENT, runId, 'judge-inputs.jsonl')
if (!existsSync(inputsPath)) {
  console.error(`失败关闭：${inputsPath} 不存在（那一轮没留判定输入，或 runId 写错）`)
  process.exit(2)
}
const judgePartialPath = join(ROOT, 'artifacts', 'm6.1', runId, 'judge.partial.jsonl')
if (!existsSync(judgePartialPath)) {
  console.error(`失败关闭：${judgePartialPath} 不存在（category 要从归档判定行对账）`)
  process.exit(2)
}

interface JudgeInputRow {
  readonly schemaVersion: string
  readonly itemId: string
  readonly setId: string
  readonly turnIndex: number
  readonly responseTextSha256: string
  readonly responseText: string
  readonly factBase: readonly string[]
  readonly eligibleStateText: string
  readonly actualContext: unknown
  readonly actualContextUnavailableReason: string | null
  readonly promptVersion: string
}
const inputRows: JudgeInputRow[] = readFileSync(inputsPath, 'utf8')
  .split(/\r?\n/)
  .filter((line) => line.trim() !== '')
  .map((line) => JSON.parse(line) as JudgeInputRow)

const categoryByItem = new Map<string, string>()
for (const line of readFileSync(judgePartialPath, 'utf8').split(/\r?\n/)) {
  if (line.trim() === '') continue
  const row = JSON.parse(line) as { itemId?: string; category?: string }
  if (typeof row.itemId === 'string' && typeof row.category === 'string') categoryByItem.set(row.itemId, row.category)
}

const selected = itemIds.map((itemId) => {
  const row = inputRows.find((candidate) => candidate.itemId === itemId)
  if (row === undefined) {
    console.error(`失败关闭：${itemId} 在 ${inputsPath} 里没有留判定输入`)
    process.exit(2)
  }
  if (row.promptVersion !== M6_1_JUDGE_PROMPT_VERSION) {
    console.error(
      `失败关闭：${itemId} 的判定输入是 ${row.promptVersion} 落的，当前树是 ${M6_1_JUDGE_PROMPT_VERSION}` +
        ' ⇒ 拿新提示重放旧输入没有指称（要测旧读数请切回那棵树）'
    )
    process.exit(2)
  }
  const category = categoryByItem.get(itemId)
  if (category === undefined) {
    console.error(`失败关闭：${itemId} 的 category 没能在归档判定行里对上账`)
    process.exit(2)
  }
  /* 与 live-short judge 阶段**同一套**条目构造（L1103-1116 的形状） */
  const rawItems = itemsFromCorpus([
    {
      id: row.itemId,
      category,
      responseText: row.responseText,
      factBase: { script: [...row.factBase], itemId: row.itemId, setId: row.setId },
      eligibleState: { memoryListText: row.eligibleStateText },
      actualContext: row.actualContext,
      ...(row.actualContext === null
        ? { actualContextUnavailableReason: row.actualContextUnavailableReason ?? '未给原因' }
        : {}),
      expected: { shouldAlert: false, labels: [] },
    },
  ])
  return { row, instrumentItem: rawItems[0] as InstrumentItem }
})

const judge = createOpenAiInstrumentJudge({ model: process.env.OPENAI_SMALL_MODEL })
console.log('==============================================================================')
console.log('M6.1 判定引文探针（诊断：重放留存的判定输入，取逐句 quote + label）')
console.log('==============================================================================')
console.log(`  run        ${runId}`)
console.log(`  条目       ${itemIds.join(', ')} · 每条 ${String(samples)} 次采样`)
console.log(`  量具       ${M6_1_JUDGE_PROMPT_VERSION} · ${judge.baseUrlHost} · ${judge.model}`)
console.log('  ⚠️        诊断档：不构成任何门的判定；采样间有间隔；同输入重判是稳定性证据，不是改判')

interface SampleReadout {
  readonly sample: number
  readonly ok: boolean
  readonly callFailure: string | null
  readonly assertions: readonly { readonly quote: string; readonly label: string }[]
}
const results: { itemId: string; setId: string; samples: SampleReadout[] }[] = []
for (const { row, instrumentItem } of selected) {
  const readouts: SampleReadout[] = []
  for (let sample = 0; sample < samples; sample += 1) {
    if (sample > 0) await new Promise((resolveSleep) => setTimeout(resolveSleep, M6_1_JUDGE_MIN_INTERVAL_MS))
    const startedAt = Date.now()
    const result = await judge.judge(buildJudgePrompt(instrumentItem))
    const callFailure = result.callFailure
    const assertions =
      result.parsed?.ok === true
        ? result.parsed.output.assertions.map((assertion) => ({ quote: assertion.quote, label: assertion.label }))
        : []
    readouts.push({ sample: sample + 1, ok: result.parsed?.ok === true, callFailure, assertions })
    console.log(`      · ${row.itemId} 采样${String(sample + 1)} ${String(Date.now() - startedAt)}ms attempts=${String(result.attempts)}${callFailure !== null ? ` **传输失败=${callFailure}**` : ''}`)
    for (const assertion of assertions) {
      console.log(`          [${assertion.label}] ${assertion.quote}`)
    }
    if (result.parsed?.ok !== true && callFailure === null) {
      console.log(`          （解析失败：${String(result.parsed?.failure ?? '?')}）`)
    }
  }
  results.push({ itemId: row.itemId, setId: row.setId, samples: readouts })
}

const output = {
  schemaVersion: 'm6.1-judge-quote-probe@1',
  testType: 'M6.1 判定引文探针（DIAGNOSTIC：重放留存的判定输入；不构成任何门的判定）',
  at: new Date().toISOString(),
  runId,
  promptVersion: M6_1_JUDGE_PROMPT_VERSION,
  judge: {
    id: judge.id,
    host: judge.baseUrlHost,
    model: judge.model,
    reasoningEffort: judge.reasoningEffort,
    maxTokens: judge.maxTokens,
    timeoutMs: M6_1_JUDGE_TIMEOUT_MS,
    maxAttempts: M6_1_JUDGE_MAX_ATTEMPTS,
    minIntervalMs: M6_1_JUDGE_MIN_INTERVAL_MS,
  },
  modelRoute: modelRouteFromEnv(
    process.env as Record<string, string | undefined>,
    process.env[TEST_MODEL_WRAPPER_MARKER] === '1' &&
      (process.env.OPENAI_BASE_URL ?? '').includes('api.deepseek.com')
      ? '**用户授权的官方 key**（进程环境内联传入，未写入任何文件）'
      : '测试端点包装器（`pnpm with-test-model`）'
  ),
  samples: results,
  notClaimed: [
    '**诊断档**：同输入重判是稳定性/引文定位证据，不是对归档读数的改判（归档不动）。',
    '温度 0 下的标签漂移（若有）= 服务端非确定性（MoE 路由），如实记录，不择优。',
    '本产物不进任何 configKey / 候选冻结件；量具有效性仍由 instrument:live 的两轮协议判定。',
  ],
}
writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8')
console.log(`  证据   ${relative(ROOT, outputPath)}`)
