/**
 * M6.1 / WP5 —— **@9 重判存档轮**（裁定 B 之后：用修好的证据面重测同一批产品回复）。
 *
 * ============================================================================
 *  它是什么
 * ============================================================================
 * 对**已归档**的判定轮（live-short 的 run 目录）用 `m6.1-judge-prompt@9` 重新判定：
 * 产品回复**一字不改**（重判保真靠 responseText sha 对账），只换量具的证据面——
 * `assistantTurns`（她此前轮次的回复，从留存的 turns.jsonl 重建）与
 * `referenceClock`（参考时间；旧存档没有逐轮 `at` ⇒ 从 runId 取**日期精度**并如实披露）。
 *
 * 这不是"给 FAIL 补判"：原读数（reading.json / verdict-v3.json）**原样保留**；
 * 本脚本写**新读数**（reading-at9.json + judge-at9.partial.jsonl），与原读数分列，
 * 由收口报告并排呈现。合法性依据 = 用户裁定 B（ADJUDICATION-LOG §22）+
 * ADR-062 D-62c（存档重判的重建义务）。
 *
 * 协议 = 测量协议 v2（裁定 C，与 live-short judge 阶段逐字同款）：
 *   k=2 + a==b；前两次报警性不同 ⇒ 只对这一条加判第 3 次；2/1 多数 = 读数并标
 *   tie_broken；三态互异 / 第 3 次传输失败 ⇒ 弃判。
 *
 * ============================================================================
 *  失败关闭
 * ============================================================================
 * ```text
 * ① 必须经测试包装器（DSH_TEST_MODEL_WRAPPER=1）——绝不回落 .env 的原 key
 * ② 重判保真闸（self-proof 的正控）：turns.jsonl 里被判定轮的 reply 必须与
 *    judge-inputs.jsonl 留存的 responseText **逐字一致**（sha 对账）——对不上一条
 *    ⇒ 整轮拒绝（exit 3）：重判的前提是"判的还是同一条回复"。
 * ③ 负控（--self-proof）：注入一处 corruption 后保真闸**必须**触发（exit 3）；
 *    不触发 = 量具失效（§6.7 三段式）。
 * ④ 输出已存在 ⇒ 拒绝（不许覆盖旧读数；重跑 = 删旧件属违规，应换 run 重跑原轮）
 * ⑤ 传输失败 ⇒ fail-closed 中止（partial 保留）
 * ```
 *
 * 用法：
 * ```bash
 * # 正常重判（官方 key · 内联 env · 直跑）
 * pnpm exec tsx scripts/m6.1-wp5-rejudge.ts --run m6.1-wp5-short-r1-code-default-20260925-9f454ec8fddf-5512 --concurrency 16
 * # 负控自证
 * pnpm exec tsx scripts/m6.1-wp5-rejudge.ts --run <同上> --self-proof
 * ```
 */

import 'dotenv/config'

import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import { M6_1_LOCAL_PARENT } from './m6.1-evidence.ts'
import {
  buildJudgePrompt,
  computeExpectedPointsHitMiss,
  itemsFromCorpus,
  judgmentFromSamples,
  judgmentFromTieBreak,
  M6_1_JUDGE_PROMPT_VERSION,
  type InstrumentItem,
} from './m6.1-instrument.ts'
import { loadSupportedRecallSet } from './m6.1-control-sets.ts'
import {
  createOpenAiInstrumentJudge,
  M6_1_JUDGE_MIN_INTERVAL_MS,
} from './m6.1-judge-openai.ts'
import { TEST_MODEL_WRAPPER_MARKER } from './m6.1-command-surface.ts'
import { modelRouteFromEnv } from './m6.1-run-guards.ts'

const ROOT = resolve(process.cwd())

const argValue = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

const runArg = argValue('--run') ?? ''
if (runArg === '') {
  console.error('失败关闭：必须给 --run <bareRunDirName>（工具自己前缀 artifacts/m6.1/）')
  process.exit(2)
}
const runDir = join(ROOT, 'artifacts', 'm6.1', runArg)
if (!existsSync(runDir)) {
  console.error(`找不到运行目录：artifacts/m6.1/${runArg}`)
  process.exit(2)
}
const selfProof = process.argv.includes('--self-proof')
const concurrency = Number(argValue('--concurrency') ?? '16')
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 64) {
  console.error(`失败关闭：--concurrency 必须是 1..64 的整数（收到 ${String(argValue('--concurrency'))}）`)
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

/* ---------------------------------------------------------------------------
 * 输入：留存的判定输入（@1/@2 兼容）+ 本地轮次正文 + 原读数元数据
 * ------------------------------------------------------------------------- */
interface ArchivedJudgeInput {
  readonly schemaVersion: string
  readonly itemId: string
  readonly setId: string
  readonly turnIndex: number
  readonly responseTextSha256: string
  readonly responseText: string
  readonly factBase: unknown
  readonly eligibleStateText: string
  readonly actualContext: unknown | null
  readonly actualContextUnavailableReason: string | null
  readonly assistantTurns?: readonly string[]
  readonly referenceClock?: string | null
  readonly promptVersion: string
}
interface LocalTurnRow {
  readonly itemId?: string
  readonly setId?: string
  readonly category?: string
  readonly turnIndex?: number
  readonly reply?: string
  readonly at?: string
}

const localDir = join(ROOT, M6_1_LOCAL_PARENT, runArg)
const judgeInputsPath = join(localDir, 'judge-inputs.jsonl')
const turnsPath = join(localDir, 'turns.jsonl')
for (const path of [judgeInputsPath, turnsPath]) {
  if (!existsSync(path)) {
    console.error(`失败关闭：留存的判定输入不在（${relative(ROOT, path)}）⇒ 无法重判（保真无从对账）`)
    process.exit(2)
  }
}
const archivedInputs = readFileSync(judgeInputsPath, 'utf8')
  .split(/\r?\n/)
  .filter((line) => line.trim() !== '')
  .map((line) => JSON.parse(line) as ArchivedJudgeInput)
if (archivedInputs.length === 0) {
  console.error('失败关闭：judge-inputs.jsonl 解析出 0 条 ⇒ 计数型检测器拒绝空转（§6.8）')
  process.exit(2)
}
const turnRows = readFileSync(turnsPath, 'utf8')
  .split(/\r?\n/)
  .filter((line) => line.trim() !== '')
  .map((line) => JSON.parse(line) as LocalTurnRow)
const replyIndex = new Map<string, string>()
const turnClockIndex = new Map<string, string>()
const categoryIndex = new Map<string, string>()
for (const row of turnRows) {
  if (typeof row.itemId === 'string' && typeof row.turnIndex === 'number') {
    const key = `${row.itemId}#${String(row.turnIndex)}`
    if (typeof row.reply === 'string') replyIndex.set(key, row.reply)
    if (typeof row.at === 'string') turnClockIndex.set(key, row.at)
    if (typeof row.category === 'string' && !categoryIndex.has(row.itemId)) categoryIndex.set(row.itemId, row.category)
  }
}

/* 原读数只取**元数据**（round/arm/diagnostic/sandboxIsolation）——正文与判定一字不读不改 */
const originalReadingPath = join(runDir, 'reading.json')
if (!existsSync(originalReadingPath)) {
  console.error('失败关闭：原读数 reading.json 不在 ⇒ 这不是 live-short 的运行目录')
  process.exit(2)
}
const originalMeta = JSON.parse(readFileSync(originalReadingPath, 'utf8')) as {
  round?: number
  arm?: string
  diagnostic?: boolean
  sandboxIsolation?: string | null
}

/* ---------------------------------------------------------------------------
 * referenceClock 重建（ADR-062 D-62c：旧存档没有逐轮 `at` ⇒ runId 日期精度 + 披露）
 * ------------------------------------------------------------------------- */
const runDateMatch = /-(\d{4})(\d{2})(\d{2})-/.exec(runArg)
if (runDateMatch === null) {
  console.error('失败关闭：runId 里解析不出日期（YYYYMMDD）⇒ referenceClock 无从重建')
  process.exit(2)
}
const runDateIso = `${runDateMatch[1]}-${runDateMatch[2]}-${runDateMatch[3]}`
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const
const runDateWeekday = WEEKDAYS[new Date(`${runDateIso}T12:00:00Z`).getUTCDay()] ?? '?'
const runDateClock = `${runDateIso}（${runDateWeekday}；日期精度——来自 runId，该存档未留逐轮时刻）`

/* ---------------------------------------------------------------------------
 * 重判保真闸（正控）：被判定轮的 reply 必须与留存 responseText 逐字一致
 * ------------------------------------------------------------------------- */
interface RebuiltItem {
  readonly itemId: string
  readonly setId: string
  readonly category: string
  readonly turnIndex: number
  readonly responseText: string
  readonly instrumentItem: InstrumentItem
  readonly referenceClockSource: 'turn-at' | 'archived' | 'run-date'
}
const sha256OfText = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

const rebuildAll = (injectCorruption: boolean): { ok: true; items: RebuiltItem[] } | { ok: false; detail: string } => {
  const items: RebuiltItem[] = []
  for (const row of archivedInputs) {
    const key = `${row.itemId}#${String(row.turnIndex)}`
    const archivedReply = replyIndex.get(key)
    if (archivedReply === undefined) {
      return { ok: false, detail: `${row.itemId}：turns.jsonl 里没有第 ${String(row.turnIndex)} 轮的 reply` }
    }
    const shaExpected = injectCorruption && row === archivedInputs[0]
      ? sha256OfText(`${row.responseText}（负控注入）`)
      : sha256OfText(row.responseText)
    if (sha256OfText(archivedReply) !== shaExpected || archivedReply !== row.responseText) {
      return {
        ok: false,
        detail: `${row.itemId}：reply 与留存 responseText 不一致（sha ${sha256OfText(archivedReply).slice(0, 12)}… ≠ ${shaExpected.slice(0, 12)}…）`,
      }
    }
    /* @9 证据重建（镜像 live-short judgeOneItem 的构造，逐字段同形） */
    const assistantTurns: string[] = []
    for (let prior = 0; prior < row.turnIndex; prior += 1) {
      const priorReply = replyIndex.get(`${row.itemId}#${String(prior)}`)
      if (priorReply !== undefined) assistantTurns.push(priorReply)
    }
    const turnAt = turnClockIndex.get(key)
    const referenceClock = turnAt ?? row.referenceClock ?? runDateClock
    const referenceClockSource: RebuiltItem['referenceClockSource'] =
      turnAt !== undefined ? 'turn-at' : row.referenceClock !== undefined ? 'archived' : 'run-date'
    const rawItems = itemsFromCorpus([
      {
        id: row.itemId,
        category: categoryIndex.get(row.itemId) ?? '',
        responseText: row.responseText,
        factBase: { script: row.factBase, itemId: row.itemId, setId: row.setId },
        eligibleState: { memoryListText: row.eligibleStateText },
        actualContext: row.actualContext ?? null,
        ...(row.actualContext === null && row.actualContextUnavailableReason !== null
          ? { actualContextUnavailableReason: row.actualContextUnavailableReason }
          : {}),
        assistantTurns,
        referenceClock,
        expected: { shouldAlert: false, labels: [] },
      },
    ])
    items.push({
      itemId: row.itemId,
      setId: row.setId,
      category: categoryIndex.get(row.itemId) ?? '',
      turnIndex: row.turnIndex,
      responseText: row.responseText,
      instrumentItem: rawItems[0] as InstrumentItem,
      referenceClockSource,
    })
  }
  return { ok: true, items }
}

/* ---------------------------------------------------------------------------
 * 负控（--self-proof）：注入 corruption ⇒ 保真闸必须触发
 * ------------------------------------------------------------------------- */
if (selfProof) {
  const negative = rebuildAll(true)
  if (negative.ok === true) {
    console.error('负控失败：注入 corruption 后保真闸**没有**触发 ⇒ 重判量具失效（§6.7）')
    process.exit(3)
  }
  const positive = rebuildAll(false)
  if (positive.ok === false) {
    console.error(`正控失败：不注入时保真闸不应触发（${positive.detail}）`)
    process.exit(3)
  }
  console.log('self-proof：负控触发 ✓ · 正控安静 ✓ · 重判保真闸工作正常')
  console.log(`  负控明细：${(negative as { ok: false; detail: string }).detail}`)
  process.exit(0)
}

const rebuilt = rebuildAll(false)
if (rebuilt.ok === false) {
  console.error(`失败关闭：重判保真闸触发（${rebuilt.detail}）⇒ 整轮拒绝——重判的前提是"判的还是同一条回复"`)
  process.exit(3)
}
const items = rebuilt.items

/* ---------------------------------------------------------------------------
 * 输出件（不许覆盖旧读数）
 * ------------------------------------------------------------------------- */
const judgePartialPath = join(runDir, 'judge-at9.partial.jsonl')
const readingAtPath = join(runDir, 'reading-at9.json')
const localInputsPath = join(localDir, 'judge-inputs-at9.jsonl')
if (existsSync(judgePartialPath) || existsSync(readingAtPath)) {
  console.error(`失败关闭：${relative(ROOT, readingAtPath)} 或 judge-at9.partial.jsonl 已存在 ⇒ 不许覆盖已有读数`)
  process.exit(2)
}
mkdirSync(localDir, { recursive: true })

/* ---------------------------------------------------------------------------
 * 判定（协议 v2：k=2 + 争议加判，与 live-short judge 阶段逐字同款）
 * ------------------------------------------------------------------------- */
const judge = createOpenAiInstrumentJudge({ model: process.env.OPENAI_SMALL_MODEL })
const supportedSpecs = loadSupportedRecallSet(ROOT)

interface JudgedRow {
  readonly itemId: string
  readonly setId: string
  readonly category: string
  readonly alertState: 'alert' | 'no_alert' | 'undecidable'
  readonly labels: readonly string[]
  readonly ok: boolean
  readonly failure: string | null
  readonly samples: readonly string[]
  readonly expectedPointsHit: readonly string[]
  readonly expectedPointsMissed: readonly string[]
  readonly forbiddenHit: readonly string[]
  readonly tieBroken?: true
  readonly tieBreakSample?: readonly string[]
}
const judged: JudgedRow[] = []
let cursor = 0
let transportAbort: string | null = null

const rejudgeOne = async (item: RebuiltItem, hasCalledBefore: () => boolean): Promise<void> => {
  /* @9 判定输入逐条留存（重判的复测合法性靠它；与 live judge-input@2 同形） */
  appendFileSync(
    localInputsPath,
    `${JSON.stringify({
      schemaVersion: 'm6.1-judge-input@2',
      itemId: item.itemId,
      setId: item.setId,
      turnIndex: item.turnIndex,
      responseTextSha256: sha256OfText(item.responseText),
      responseText: item.responseText,
      factBase: item.instrumentItem.evidence.factBase,
      eligibleStateText: item.instrumentItem.evidence.eligibleState,
      actualContext: item.instrumentItem.evidence.actualContext ?? null,
      actualContextUnavailableReason: item.instrumentItem.evidence.actualContextUnavailableReason ?? null,
      assistantTurns: item.instrumentItem.evidence.assistantTurns ?? [],
      referenceClock: item.instrumentItem.evidence.referenceClock ?? null,
      promptVersion: M6_1_JUDGE_PROMPT_VERSION,
      rejudgeOf: runArg,
    })}\n`,
    'utf8'
  )
  const samples: string[][] = []
  let transportFailure: string | null = null
  const takeSample = async (sampleIndex: number): Promise<void> => {
    if (sampleIndex > 0 || hasCalledBefore()) {
      await new Promise((resolveSleep) => setTimeout(resolveSleep, M6_1_JUDGE_MIN_INTERVAL_MS))
    }
    const startedAt = Date.now()
    const result = await judge.judge(buildJudgePrompt(item.instrumentItem))
    console.log(
      `      · ${item.itemId} 采样${String(sampleIndex + 1)} ${String(Date.now() - startedAt)}ms` +
        ` attempts=${String(result.attempts)}${result.callFailure !== null ? ` **传输失败=${result.callFailure}**` : ''}`
    )
    if (result.callFailure !== null) {
      transportFailure = result.callFailure
      return
    }
    samples.push(result.parsed?.ok === true ? result.parsed.output.assertions.map((a) => a.label) : [])
  }
  await takeSample(0)
  await takeSample(1)
  let judgment = judgmentFromSamples(item.instrumentItem, samples, transportFailure, 2)
  let tieBroken = false
  if (
    judgment.ok !== true &&
    judgment.failure === 'alert_state_disagreement' &&
    samples.length === 2 &&
    transportFailure === null
  ) {
    await takeSample(2)
    judgment = judgmentFromTieBreak(item.instrumentItem, samples, transportFailure)
    tieBroken = judgment.ok === true
    console.log(
      tieBroken
        ? `      · ${item.itemId} 争议加判 ⇒ ${judgment.alertState}（2/1 多数 · tie_broken 披露）`
        : `      · ${item.itemId} 争议加判仍未决 ⇒ 弃判（${String(judgment.failure)}）`
    )
  }
  /* 确定性诊断复算（同一份冻结条目 + 同一条回复 ⇒ 与原读数同源） */
  const spec = supportedSpecs.find((candidate) => candidate.id === item.itemId)
  const reply = item.responseText
  const entry: JudgedRow = {
    itemId: item.itemId,
    setId: item.setId,
    category: item.category,
    alertState: judgment.alertState,
    labels: judgment.predictedLabels,
    ok: judgment.ok,
    failure: judgment.failure ?? null,
    samples: samples.map((labels) => labels.join(',')),
    /* 要点命中走共享 point-match v2（裁定 ②；与 live-short 同一实现，不另立口径） */
    expectedPointsHit: computeExpectedPointsHitMiss(spec?.expectedPoints ?? [], reply).hit,
    expectedPointsMissed: computeExpectedPointsHitMiss(spec?.expectedPoints ?? [], reply).missed,
    forbiddenHit: (spec?.forbidden ?? []).filter((token) => reply.includes(token)),
    ...(tieBroken ? { tieBroken: true as const, tieBreakSample: samples[2] ?? [] } : {}),
  }
  judged.push(entry)
  appendFileSync(judgePartialPath, `${JSON.stringify(entry)}\n`, 'utf8')
  console.log(
    `  ${item.itemId.padEnd(10)} 量具 ${judgment.ok ? judgment.alertState : `失败(${String(judgment.failure)})`} · 标签 ${judgment.predictedLabels.join(',') || '(无)'}`
  )
  if (transportFailure !== null && transportAbort === null) {
    transportAbort = `${item.itemId}:${transportFailure}`
  }
}

const worker = async (): Promise<void> => {
  let hasCalled = false
  const hasCalledBefore = (): boolean => {
    if (hasCalled) return true
    hasCalled = true
    return false
  }
  for (;;) {
    const slot = cursor
    cursor += 1
    if (slot >= items.length) return
    if (transportAbort !== null) return
    await rejudgeOne(items[slot]!, hasCalledBefore)
  }
}
console.log('==============================================================================')
console.log(`M6.1 / WP5 —— @9 重判存档轮（裁定 B · ADR-062 D-62c）`)
console.log('==============================================================================')
console.log(`  运行        ${runArg}`)
console.log(`  条目        ${String(items.length)}（来自留存的 judge-inputs.jsonl · 保真对账全过）`)
console.log(`  量具        ${M6_1_JUDGE_PROMPT_VERSION} · ${judge.baseUrlHost} · ${judge.model}`)
console.log(`  参考时间    ${runDateClock}`)
console.log(`  协议        v2（k=2 + 争议加判，与 live-short judge 阶段同款）· 并发 ${String(concurrency)}`)
console.log(`  原读数      reading.json / verdict-v3.json 原样保留（本读数另立 reading-at9.json）`)
await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))
if (transportAbort !== null) {
  console.error(`\n  ⚠️ **传输失败中止**：${transportAbort} ⇒ partial 保留；本读数不完整，不得用于判定`)
  process.exit(3)
}
if (judged.length !== items.length) {
  console.error(`失败关闭：判了 ${String(judged.length)} / ${String(items.length)} ⇒ 读数不完整`)
  process.exit(3)
}

/* ---------------------------------------------------------------------------
 * 新读数落盘（与原读数分列；元数据从原读数继承）
 * ------------------------------------------------------------------------- */
const byState = (state: string): number => judged.filter((entry) => entry.ok && entry.alertState === state).length
const readingAt9 = {
  schemaVersion: 'm6.1-wp5-reading-at9@1',
  testId: 'M6.1 WP5 @9 重判存档轮（同一批产品回复 · 修好的证据面 · 裁定 B）',
  at: new Date().toISOString(),
  runId: runArg,
  round: originalMeta.round ?? null,
  arm: originalMeta.arm ?? null,
  diagnostic: originalMeta.diagnostic === true,
  sandboxIsolation: originalMeta.sandboxIsolation ?? null,
  promptVersion: M6_1_JUDGE_PROMPT_VERSION,
  modelRoute: modelRouteFromEnv(process.env, 'inline process env（官方 key · 不落盘）'),
  protocol: { samplesPerItem: 2, tieBreak: '争议加判第 3 次（裁定 C；2/1 多数 = 读数并标 tie_broken）' },
  rejudge: {
    of: 'reading.json（原样保留，一字未改）',
    basis: '用户裁定 B（ADJUDICATION-LOG §22）+ ADR-062 D-62c',
    fidelity: `保真对账 ${String(items.length)}/${String(items.length)}（turns.jsonl reply 与留存 responseText 逐字一致）`,
    assistantTurnsSource: 'turns.jsonl（她此前轮次的回复，按 turnIndex 重建）',
    referenceClockSource: `runId 日期精度（${runDateClock}）——该存档未留逐轮时刻，如实披露`,
    itemsRejudged: items.length,
  },
  counts: {
    judged: judged.length,
    alert: byState('alert'),
    noAlert: byState('no_alert'),
    undecidable: byState('undecidable'),
    technicalFailure: judged.filter((entry) => !entry.ok).length,
    tieBroken: judged.filter((entry) => entry.tieBroken === true).length,
  },
  perItem: judged.map((entry) => ({
    itemId: entry.itemId,
    setId: entry.setId,
    category: entry.category,
    alertState: entry.alertState,
    labels: entry.labels,
    ok: entry.ok,
    failure: entry.failure,
    samples: entry.samples.length,
    expectedPointsHit: entry.expectedPointsHit,
    expectedPointsMissed: entry.expectedPointsMissed,
    forbiddenHit: entry.forbiddenHit,
    ...(entry.tieBroken === true ? { tieBroken: true as const } : {}),
  })),
  notClaimed: [
    '**不主张**原读数被推翻——reading.json / verdict-v3.json 原样保留；本读数与它们**分列**，由收口报告并排呈现。',
    'referenceClock 是**日期精度**（runId）：能核对日期/星期/天数差，不能核对钟点——按此精度解读判定。',
    '重判只换量具证据面（@9），不重跑产品回复：产品行为读数仍是原轮的那一次。',
    '本读数的量具有效性依据 = 裁定 B（v3-r1 验证 + 引文级归因）；@10+ 需新集重验。',
  ],
}
writeFileSync(readingAtPath, `${JSON.stringify(readingAt9, null, 2)}\n`, 'utf8')
console.log('')
console.log(`  判定读数    alert ${String(readingAt9.counts.alert)} · no_alert ${String(readingAt9.counts.noAlert)} · 弃判 ${String(readingAt9.counts.undecidable)} · 技术失败 ${String(readingAt9.counts.technicalFailure)} · tie_broken ${String(readingAt9.counts.tieBroken)}`)
console.log(`  证据        ${relative(ROOT, readingAtPath).split(/[\\/]/).join('/')} + judge-at9.partial.jsonl`)
console.log(`  判定输入    ${relative(ROOT, localInputsPath).split(/[\\/]/).join('/')}（local · 复测合法性）`)
