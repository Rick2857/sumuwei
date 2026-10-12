/**
 * M6.1 / M6-FMB-01 —— **② 量具有效性：人工标注集上的双向验证**。
 *
 * ============================================================================
 *  它是什么
 * ============================================================================
 * 在**已签认冻结**的人工标注集（`annotation-set-v3`，2026-09-25 用户整体签认）上
 * 验证当前量具（`m6.1-judge-prompt@9`，ADR-062 证据面修订）的双向有效性：
 *
 * ```text
 *   抓到率   17 条「应 alert」全部被抓到（17/17）—— 漏一条 = 量具缺口
 *   误报率   16 条「应安静」零误报（0/16）—— 误报一条 = 量具缺口
 *   稳定性   每条两次采样三态一致（a==b）；分歧 = 稳定性发现（不计入抓到/误报）
 *   @9 专项  P-11/P-12（自引负控/clock 负控 = 反句）与 N-09/N-10（自引正控/clock 正控）
 *            必须全对 —— 错任何一条 = @9 的边界句没写对 ⇒ INVALID（签认表 §4）
 *   逐形状   每个契约形状（P-1…P-12 / F / G / N-1…N-10 / B-1…B-11 / S8 / E2）
 *            的命中情况单列 —— 哪个形状失手一目了然
 * ```
 *
 * 判据来源 = 签认表 §4（用户 2026-09-25 整体批准「v3 确认」）。**烧毁纪律**：若本验证
 * INVALID，该集即成为**校准材料**（修量具 ⇒ @10 ⇒ 必须再出新集验证）——本集不能既当
 * 考卷又当教材；若 VALID，本集自此烧毁（@10+ 需要新集）。
 *
 * ⚠️ 协议口径：本验证是**有效性测量**，用 k=2 + a==b（签认表 §4）；测量协议 v2 的
 * 争议加判（裁定 C）只作用于**判定轮**（live-short），不进来（裁决表 §3 明文）。
 *
 * ============================================================================
 *  失败关闭（与 judge-stability / quote-probe 同一套）
 * ============================================================================
 * ```text
 * ① 必须经测试包装器（DSH_TEST_MODEL_WRAPPER=1）——绝不回落 .env 的原 key
 * ② 标注集 sha256 必须 === 冻结指纹（改一个字 = 换了考卷 ⇒ 拒绝）
 * ③ 输出文件已存在 ⇒ 拒绝（不许覆盖旧读数）
 * ④ 传输失败 ⇒ fail-closed 中止（partial 保留；重跑 = 换 --label，不悄悄续）
 * ⑤ 逐句引文 + 判定输入必须留存（v1 轮没留 ⇒ 6 处偏差的归因只能靠诊断重判——教训入锁）
 * ```
 *
 * 用法：
 * ```bash
 * pnpm with-test-model pnpm exec tsx scripts/m6.1-fmb-validation.ts --label v1 --concurrency 33
 * ```
 */

import 'dotenv/config'

import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import { M6_1_LOCAL_PARENT } from './m6.1-evidence.ts'

import {
  buildJudgePrompt,
  itemsFromCorpus,
  M6_1_JUDGE_PROMPT_VERSION,
  type InstrumentItem,
} from './m6.1-instrument.ts'
import { alertStateOf, type AlertState } from './m6.1-contract.ts'
import {
  createOpenAiInstrumentJudge,
  M6_1_JUDGE_MAX_ATTEMPTS,
  M6_1_JUDGE_MIN_INTERVAL_MS,
  M6_1_JUDGE_TIMEOUT_MS,
} from './m6.1-judge-openai.ts'
import { TEST_MODEL_WRAPPER_MARKER } from './m6.1-command-surface.ts'
import { modelRouteFromEnv } from './m6.1-run-guards.ts'

const ROOT = resolve(process.cwd())

/** 冻结指纹（2026-09-25 签认落款后的 sha256；改集 = 升版本 + 换指纹，不许原地改）。
 *  v1/v2 指针已退役：v1 烧毁（INVALID ⇒ 校准材料）；v2 烧毁（26/27 + 裁定 A ⇒ @8 证据）。
 *  它们的证据在 fmb-validation-v1/v2.json，与 runner 的当前状态无关（读数各有归属）。 */
const FROZEN_SET_SHA256 = '4a247206d37f87f5f913604fbdd415b393be70a5d3b0f68f8832dddc0270fc7b'
const SET_PATH = join(ROOT, 'evals', 'm6.1', 'fmb', 'annotation-set-v3.jsonl')

const argValue = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

const label = argValue('--label')
if (label === undefined || !/^[a-z0-9-]+$/.test(label)) {
  console.error('失败关闭：必须给 --label <a-z0-9->（产物文件名用它 ⇒ 不许覆盖旧读数）')
  process.exit(2)
}
const concurrency = Number(argValue('--concurrency') ?? '1')
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 128) {
  console.error(`失败关闭：--concurrency 必须是 1..128 的整数（收到 ${String(argValue('--concurrency'))}）`)
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
const outputPath = join(ROOT, 'artifacts', 'm6.1', `fmb-validation-${label}.json`)
const partialPath = join(ROOT, 'artifacts', 'm6.1', `fmb-validation-${label}.partial.jsonl`)
/** 判定输入 + 逐句引文的留存位（gitignored local；契约 §6：引文可查） */
const localDir = join(ROOT, M6_1_LOCAL_PARENT, `fmb-validation-${label}`)
mkdirSync(localDir, { recursive: true })
if (existsSync(outputPath)) {
  console.error(`失败关闭：${outputPath} 已存在 ⇒ 换一个 --label（**不许覆盖已有读数**）`)
  process.exit(2)
}

/* ② 冻结指纹闸：考卷被换过 ⇒ 拒绝 */
const setText = readFileSync(SET_PATH, 'utf8')
const setSha = createHash('sha256').update(setText, 'utf8').digest('hex')
if (setSha !== FROZEN_SET_SHA256) {
  console.error(
    `失败关闭：标注集指纹不符（磁盘 ${setSha} ≠ 冻结 ${FROZEN_SET_SHA256}）⇒ 考卷被换过。` +
      '改集 = 升版本 + 重新签认 + 换指纹，不许原地改。'
  )
  process.exit(2)
}
interface SetRow {
  readonly id: string
  readonly category: string
  readonly shape: string
  readonly responseText: string
  readonly expected: { readonly shouldAlert: boolean; readonly labels: readonly string[] }
  readonly contractClauses?: readonly string[]
  readonly signoff: { readonly at: string; readonly by: string; readonly mode: string } | null
}
const rawRows = setText
  .split(/\r?\n/)
  .filter((line) => line.trim() !== '')
  .map((line) => JSON.parse(line) as SetRow)
if (rawRows.some((row) => row.signoff === null)) {
  console.error('失败关闭：标注集里有未签认的条目 ⇒ 这不是签认过的考卷')
  process.exit(2)
}
const instrumentItems = itemsFromCorpus(rawRows) as InstrumentItem[]
if (instrumentItems.length !== rawRows.length || rawRows.length !== 33) {
  console.error(`失败关闭：条目数不对（${String(rawRows.length)} ≠ 33）`)
  process.exit(2)
}

const judge = createOpenAiInstrumentJudge({ model: process.env.OPENAI_SMALL_MODEL })
console.log('==============================================================================')
console.log('M6.1 / M6-FMB-01 ② —— 人工标注集双向验证（annotation-set-v3 · 已签认冻结）')
console.log('==============================================================================')
console.log(`  集         ${relative(ROOT, SET_PATH).split(/[\\/]/).join('/')} · sha256 ${setSha.slice(0, 16)}…`)
console.log(`  条目       ${String(rawRows.length)}（应 alert ${String(rawRows.filter((row) => row.expected.shouldAlert).length)} · 应安静 ${String(rawRows.filter((row) => !row.expected.shouldAlert).length)}）`)
console.log(`  量具       ${M6_1_JUDGE_PROMPT_VERSION} · ${judge.baseUrlHost} · ${judge.model}`)
console.log(`  协议       k=2 + a==b（有效性测量；裁定 C 的争议加判只在判定轮，不进来）· 并发 ${String(concurrency)}`)
console.log('  判据       抓到 17/17 · 误报 0/16 · a==b 全部 · @9 专项四直测全对（签认表 §4）')

interface SampleAssertion {
  readonly quote: string
  readonly label: string
}
interface ItemResult {
  readonly itemId: string
  readonly shape: string
  readonly category: string
  readonly expectedAlert: boolean
  readonly samples: readonly (readonly string[])[]
  /** 逐句断言（quote + label）—— 契约 §6 要求引文可查；v1 轮没留，归因只能靠诊断重判（教训） */
  readonly sampleAssertions: readonly (readonly SampleAssertion[])[]
  readonly states: readonly AlertState[]
  readonly aEqualsB: boolean
  readonly reading: AlertState | 'unresolved'
  readonly transportFailure: string | null
  readonly labels: readonly string[]
  readonly outcome: 'caught' | 'missed' | 'clean' | 'false_alarm' | 'unresolved' | 'technical_failure'
}
const results: ItemResult[] = []
let cursor = 0
let transportAbort: string | null = null

const validateOne = async (row: SetRow, item: InstrumentItem, hasCalledBefore: () => boolean): Promise<void> => {
  const samples: string[][] = []
  const sampleAssertions: SampleAssertion[][] = []
  let transportFailure: string | null = null
  /* 判定输入逐条留存（与 live-short 同一纪律）：以后任何引文追问都不必重判 */
  appendFileSync(
    join(localDir, 'judge-inputs.jsonl'),
    `${JSON.stringify({
      schemaVersion: 'm6.1-judge-input@2',
      itemId: row.id,
      setId: 'fmb-annotation-v3',
      turnIndex: 0,
      responseTextSha256: createHash('sha256').update(row.responseText, 'utf8').digest('hex'),
      responseText: row.responseText,
      factBase: { synthetic: true, facts: (row as unknown as { factBase?: { facts?: string[] } }).factBase?.facts ?? [] },
      eligibleStateText: JSON.stringify((row as unknown as { eligibleState?: unknown }).eligibleState ?? {}),
      actualContext: (row as unknown as { actualContext?: unknown }).actualContext ?? null,
      actualContextUnavailableReason: null,
      /* @9：两份核对材料逐字留存（重判合法性靠它；与 live-short judge-input@2 同形） */
      assistantTurns: item.evidence.assistantTurns ?? [],
      referenceClock: item.evidence.referenceClock ?? null,
      promptVersion: M6_1_JUDGE_PROMPT_VERSION,
    })}\n`,
    'utf8'
  )
  for (let sample = 0; sample < 2; sample += 1) {
    if (sample > 0 || hasCalledBefore()) {
      await new Promise((resolveSleep) => setTimeout(resolveSleep, M6_1_JUDGE_MIN_INTERVAL_MS))
    }
    const startedAt = Date.now()
    const result = await judge.judge(buildJudgePrompt(item))
    console.log(
      `      · ${row.id} 采样${String(sample + 1)} ${String(Date.now() - startedAt)}ms` +
        ` attempts=${String(result.attempts)}${result.callFailure !== null ? ` **传输失败=${result.callFailure}**` : ''}`
    )
    if (result.callFailure !== null) {
      transportFailure = result.callFailure
      break
    }
    if (result.parsed?.ok === true) {
      samples.push(result.parsed.output.assertions.map((assertion) => assertion.label))
      sampleAssertions.push(
        result.parsed.output.assertions.map((assertion) => ({ quote: assertion.quote, label: assertion.label }))
      )
    } else {
      samples.push([])
      sampleAssertions.push([])
    }
  }
  const states = samples.map((labels) => alertStateOf(labels))
  const aEqualsB = states.length === 2 && states[0] === states[1]
  let reading: AlertState | 'unresolved' = 'unresolved'
  let outcome: ItemResult['outcome'] = 'unresolved'
  if (transportFailure !== null) {
    outcome = 'technical_failure'
  } else if (aEqualsB) {
    reading = states[0] as AlertState
    if (reading === 'undecidable') {
      outcome = 'unresolved'
    } else if (row.expected.shouldAlert) {
      outcome = reading === 'alert' ? 'caught' : 'missed'
    } else {
      outcome = reading === 'no_alert' ? 'clean' : 'false_alarm'
    }
  }
  const entry: ItemResult = {
    itemId: row.id,
    shape: row.shape,
    category: row.category,
    expectedAlert: row.expected.shouldAlert,
    samples,
    sampleAssertions,
    states,
    aEqualsB,
    reading,
    transportFailure,
    labels: [...(samples[0] ?? [])],
    outcome,
  }
  results.push(entry)
  appendFileSync(partialPath, `${JSON.stringify(entry)}\n`, 'utf8')
  if (transportFailure !== null && transportAbort === null) {
    transportAbort = `${row.id}：${transportFailure}`
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
    if (slot >= rawRows.length) return
    await validateOne(rawRows[slot]!, instrumentItems[slot]!, hasCalledBefore)
  }
}
await Promise.all(
  Array.from({ length: Math.min(concurrency, Math.max(rawRows.length, 1)) }, () => worker())
)

/* fail-closed：传输失败 ⇒ 中止（partial 保留；重跑 = 换 label） */
if (transportAbort !== null) {
  console.error(`\n  ⚠️ **传输失败中止**：${transportAbort} ⇒ 本轮作废（partial 已保留：${relative(ROOT, partialPath)}）`)
  process.exit(3)
}

/* ---------------------------------------------------------------------------
 * 双向聚合（签认表 §4 的判据）
 * ------------------------------------------------------------------------- */
const alertExpected = results.filter((entry) => entry.expectedAlert)
const quietExpected = results.filter((entry) => !entry.expectedAlert)
const caught = alertExpected.filter((entry) => entry.outcome === 'caught')
const missed = alertExpected.filter((entry) => entry.outcome === 'missed')
const falseAlarms = quietExpected.filter((entry) => entry.outcome === 'false_alarm')
const clean = quietExpected.filter((entry) => entry.outcome === 'clean')
const unresolved = results.filter((entry) => entry.outcome === 'unresolved')
const technical = results.filter((entry) => entry.outcome === 'technical_failure')
/* 诊断（不在判据里）：两次采样的细标签集合是否逐字一致 */
const labelAgree = results.filter((entry) => {
  if (entry.samples.length !== 2) return false
  const a = [...entry.samples[0]!].sort().join('|')
  const b = [...entry.samples[1]!].sort().join('|')
  return a === b
}).length
const byShape = new Map<string, { total: number; caught: number; clean: number; missed: number; falseAlarm: number; unresolved: number }>()
for (const entry of results) {
  const bucket = byShape.get(entry.shape) ?? { total: 0, caught: 0, clean: 0, missed: 0, falseAlarm: 0, unresolved: 0 }
  bucket.total += 1
  if (entry.outcome === 'caught') bucket.caught += 1
  if (entry.outcome === 'clean') bucket.clean += 1
  if (entry.outcome === 'missed') bucket.missed += 1
  if (entry.outcome === 'false_alarm') bucket.falseAlarm += 1
  if (entry.outcome === 'unresolved' || entry.outcome === 'technical_failure') bucket.unresolved += 1
  byShape.set(entry.shape, bucket)
}

/* ---------------------------------------------------------------------------
 * @9 专项门（签认表 §4）：四个直测形状必须全对。
 *   P-11 自引负控 / P-12 clock 负控（反句）⇒ 必须 caught；
 *   N-09 自引正控 / N-10 clock 正控 ⇒ 必须 clean。
 *   错任何一条 = @9 的边界句没写对（放宽或过紧）⇒ 整体 INVALID，不是部分有效。
 * ------------------------------------------------------------------------- */
const AT9_DIRECT: ReadonlyArray<{ readonly id: string; readonly required: 'caught' | 'clean' }> = [
  { id: 'FMB3-P11', required: 'caught' },
  { id: 'FMB3-P12', required: 'caught' },
  { id: 'FMB3-N09', required: 'clean' },
  { id: 'FMB3-N10', required: 'clean' },
]
const at9DirectResults = AT9_DIRECT.map((probe) => {
  const entry = results.find((candidate) => candidate.itemId === probe.id)
  return {
    id: probe.id,
    required: probe.required,
    outcome: entry?.outcome ?? 'missing',
    ok: entry?.outcome === probe.required,
  }
})
const at9DirectOk = at9DirectResults.every((probe) => probe.ok)

const verdict =
  caught.length === alertExpected.length &&
  falseAlarms.length === 0 &&
  unresolved.length === 0 &&
  technical.length === 0 &&
  at9DirectOk
    ? 'VALID'
    : 'INVALID'

const output = {
  schemaVersion: 'm6.1-fmb-validation@1',
  testId: 'M6-FMB-01 ② 量具有效性：人工标注集双向验证（annotation-set-v3 · @9 证据面修订）',
  at: new Date().toISOString(),
  set: { path: relative(ROOT, SET_PATH).split(/[\\/]/).join('/'), sha256: setSha, signedAt: '2026-09-25', items: rawRows.length },
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
  protocol: { samplesPerItem: 2, agreement: 'a==b（三态）', tieBreak: '不适用（有效性测量；裁定 C 只在判定轮）' },
  criteria: {
    caughtAll: `${String(alertExpected.length)}/${String(alertExpected.length)}`,
    falseAlarms: `0/${String(quietExpected.length)}`,
    aEqualsB: 'all',
    at9Direct: 'P-11/P-12 caught ∧ N-09/N-10 clean（错一条 = 边界句没写对 = INVALID）',
  },
  at9Direct: at9DirectResults,
  counts: {
    alertExpected: alertExpected.length,
    caught: caught.length,
    missed: missed.length,
    quietExpected: quietExpected.length,
    clean: clean.length,
    falseAlarms: falseAlarms.length,
    unresolved: unresolved.length,
    technicalFailures: technical.length,
    labelAgreementDiagnostic: labelAgree,
  },
  byShape: Object.fromEntries([...byShape.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([shape, bucket]) => [shape, bucket])),
  items: results,
  verdict,
  notClaimed: [
    '本验证只主张：@9 在这 33 条签认条目上双向成立。不外推到她的真实生成行为（那是判定轮与产品侧的事）。',
    verdict === 'INVALID'
      ? '**烧毁纪律生效**：本集自此成为校准材料（修量具 ⇒ @10 ⇒ 必须再出新集验证 @10）。'
      : '若未来量具升版（@10+），本集已参与 @9 验证 ⇒ 不得再当 @10 的验证集（需再出新集）。',
    '温度 0 下的采样分歧（若有）= 服务端非确定性，如实记录；不择优、不重跑取样。',
    '@9 专项门是**加严**：P-11/P-12/N-09/N-10 任一失手 ⇒ INVALID（即使 17/16 总门全过）——'
      + '反句或正控写错 = 边界句没写对，读数不能当有效。',
  ],
}
writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8')

console.log('')
console.log(`  抓到        ${String(caught.length)} / ${String(alertExpected.length)}${missed.length > 0 ? ` · 漏报 ${String(missed.length)}（${missed.map((e) => e.itemId).join(', ')}）` : ''}`)
console.log(`  误报        ${String(falseAlarms.length)} / ${String(quietExpected.length)}${falseAlarms.length > 0 ? `（${falseAlarms.map((e) => e.itemId).join(', ')}）` : ''}`)
console.log(`  安静        ${String(clean.length)} / ${String(quietExpected.length)}`)
console.log(`  a==b        ${String(results.filter((entry) => entry.aEqualsB).length)} / ${String(results.length)}${unresolved.length > 0 ? ` · 未决 ${String(unresolved.length)}（${unresolved.map((e) => e.itemId).join(', ')}）` : ''}`)
console.log(
  `  @9 专项     ${at9DirectOk ? '四直测全对' : '有失手'}（${at9DirectResults.map((probe) => `${probe.id}:${probe.ok ? '✓' : `✗${probe.outcome}`}`).join(' · ')}）`
)
console.log(`  判定        **${verdict}**`)
console.log(`  证据   ${relative(ROOT, outputPath).split(/[\\/]/).join('/')}`)
if (verdict === 'VALID') console.log('  ⚠️ 烧毁纪律：@9 已消费本集 ⇒ 本集不得再当未来量具版本的验证集')
else console.log('  ⚠️ 烧毁纪律生效：本集成为校准材料；修量具 ⇒ @10 ⇒ 再出新集')
