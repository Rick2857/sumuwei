/**
 * M9.6 情绪模块一轮 —— 三列对照（`pnpm m9.6:emotion:compare`）。
 *
 * ============================================================================
 *  三列
 * ============================================================================
 * ```text
 * A = M8.5 语义判定器（现行基线）：buildSemanticOutbound → provider.call → evaluateSemanticResponse
 *     · **与 scripts/m8.5-blind-run.ts 同源**，用它的冻结子集与评分口径 ⇒ 应能复现 M8.5 公布读数
 * J = Jev（jev-1.13.0）：**一次调用问两问**（decision + family），带概率 ⇒ 可测校准
 * B = 同题 LLM（测试端点，单题自由文本）⇒ 任务表达控制的对照（协议要求）
 * ```
 * ⚠️ 纪律：不改任何提示词/阈值/语料；blind 层只跑分不迭代；失败按端到端失败计入分母。
 * ⚠️ 证据纪律：入库的 `predictions.jsonl` **不含语料正文**；正文只写进 gitignore 的 `artifacts/m9.6/local/`。
 */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import {
  B_SYSTEM_PROMPT,
  CHARACTER_ALIAS,
  EMOTION_CASES,
  EMOTION_DECISIONS,
  EMOTION_SUBSETS,
  FAMILY_ORDER,
  JEV_FAMILY_NOT_APPLICABLE,
  buildAffectContext,
  buildBUserMessage,
  buildJevQuestions,
  buildJevState,
  emotionCorpusFingerprint,
  subsetDenominatorCheck,
  validateEmotionCorpus,
} from './m9.6-emotion-corpus.ts'
import {
  TOTAL_DEADLINE_MS,
  callSystemOne,
  estimateCostUsd,
  redactSecrets,
  resolveJevConfig,
  type JevCallResult,
} from './m9.6-jev-protocol.ts'
import {
  brierScore,
  expectedCalibrationError,
  pairedBootstrapDiff,
  ratio,
  wilsonInterval,
} from './m9.6-stats.ts'

const ROOT = resolve('.')
const EMOTION_DIR = join(ROOT, 'artifacts', 'm9.6', 'emotion')
const FREEZE_PATH = join(EMOTION_DIR, 'freeze.json')

/**
 * ★ **传输失败策略**（**先声明、后运行** —— 见冻结 @2 的 `policy`）：
 *   官方 API 的**瞬时不可用**不得冒充"模型质量"。若某一列的 `unavailable` 率超过该阈值，
 *   该列的**质量读数标为 INVALID**（`qualityReadingsValid=false`），整轮记 `INVALID_TRANSPORT`，
 *   必须**显式重跑**；**不**允许静默重跑刷分，也**不**允许把失败样本丢掉再算。
 */
const TRANSPORT_INVALID_THRESHOLD = 0.05

function arg(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? null : (process.argv[index + 1] ?? null)
}
const splitList = (raw: string | null, allowed: readonly string[]): string[] => {
  if (raw === null) return [...allowed]
  const set = new Set(raw.split('').filter((character) => allowed.includes(character)))
  return allowed.filter((item) => set.has(item))
}

const ARMS = splitList(arg('arms'), ['A', 'J', 'B'] as const)
const LIMIT = arg('limit') === null ? null : Number(arg('limit'))
const OUT_NAME = arg('out')
const VALIDATE_ONLY = process.argv.includes('--validate-only')
const FREEZE_ONLY = process.argv.includes('--freeze-only')

if (ARMS.length === 0) {
  console.error('REFUSED：--arms 至少要选一列（A/J/B）')
  process.exit(2)
}
if (LIMIT !== null && (!Number.isInteger(LIMIT) || LIMIT < 1)) {
  console.error(`REFUSED：--limit 必须是正整数，收到 ${String(arg('limit'))}`)
  process.exit(2)
}

/* ---- 语料校验（失败关闭） ---- */
const validation = validateEmotionCorpus()
const denom = subsetDenominatorCheck()
if (!validation.ok) {
  console.error(`REFUSED：语料校验失败\n  - ${validation.problems.join('\n  - ')}`)
  process.exit(2)
}
if (!denom.ok) {
  console.error(`REFUSED：判据子集分母与 M8.5 公布值不一致（量具不可信）\n  observed=${JSON.stringify(denom.observed)}\n  expected=${JSON.stringify(denom.expected)}`)
  process.exit(2)
}

if (VALIDATE_ONLY) {
  console.log('M9.6 情绪一轮 · 语料与判据校验（--validate-only · 零出站）')
  console.log(`  条数 ${String(EMOTION_CASES.length)} · 带上下文 ${String(validation.counts.withContext ?? 0)}`)
  console.log(`  判定分布：${JSON.stringify(validation.counts.byDecision)}`)
  console.log(`  子集分母：${JSON.stringify(denom.observed)}（全部与 M8.5 公布值吻合）`)
  console.log(`  指纹：${emotionCorpusFingerprint()}`)
  process.exit(0)
}

/* ---- 凭据（显式读 .env.test；绝不回落 .env） ---- */
function loadEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {}
  if (!existsSync(path)) return out
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
    if (match === null) continue
    const value = (match[2] ?? '').trim().replace(/^["']|["']$/g, '')
    if (value !== '') out[match[1] as string] = value
  }
  return out
}
const TEST_ENV = loadEnvFile(join(ROOT, '.env.test'))

/* ---- 冻结 ---- */
const FREEZE_FILES = [
  'scripts/m9.6-emotion-compare.ts',
  'scripts/m9.6-emotion-corpus.ts',
  'scripts/m9.6-jev-protocol.ts',
  'scripts/m9.6-stats.ts',
  'evals/m8.5/corpus/blind.jsonl',
  'src/kernel/app/affect/semantic-instruction.ts',
  'src/kernel/app/affect/semantic-evaluator.ts',
  'src/infrastructure/model/affect-semantic-provider.ts',
]
const freezeBody = {
  schemaVersion: 'm9.6-emotion-freeze@2',
  /**
   * ★ 版本历史（**不覆盖、不回写**）：
   *   @1（`2cbf8b4`）跑出 round 1（`emotion-r1`）—— 该轮的 **J 列读数无效**，两处原因：
   *     ① **量具缺陷（我的）**：把"非 IMPACT 却给了具体家族"当矛盾拒收（19 例）。
   *        官方 `questions` 是**映射、各题独立作答**，家族题无法条件化 ⇒ 那是在惩罚结构性伪影。
   *     ② **传输问题**：前 41 案**连续** `network_error`（0–40），端点瞬时不可用。
   *        round 1 因此 completion 仅 42.45% ⇒ 它量的是**网络**，不是模型。
   *   ⇒ @2 修 ①（只在 IMPACT 时要求家族）并新增 ②的**先声明策略**（见 `policy`）。round 1 证据**保留**。
   */
  supersedes: 'm9.6-emotion-freeze@1（round 1 = emotion-r1，J 列无效，仅作量具缺陷记录）',
  policy: {
    transportInvalidThreshold: TRANSPORT_INVALID_THRESHOLD,
    rule:
      '某列 `unavailable` 率 > 阈值 ⇒ 该列**质量读数标 INVALID**（`qualityReadingsValid=false`），整轮记 `INVALID_TRANSPORT`，' +
      '必须**显式重跑**。**禁止**静默重跑刷分、**禁止**丢弃失败样本再算、**禁止**把网络不可用读成模型质量。',
    familyQuestionIndependence:
      '官方 `questions` 各题**独立作答** ⇒ 家族题只在 `decision=IMPACT` 时计分；非 IMPACT 时的家族答案**忽略**并只记伪影计数。',
    stopBatch: '认证失败 / 错模型版本（`stopBatch=true`）⇒ **立即停止整批**，不继续烧调用。',
  },
  files: Object.fromEntries(FREEZE_FILES.map((path) => [path, createHash('sha256').update(readFileSync(path)).digest('hex')])),
  jevModel: (TEST_ENV.M96_JEV_MODEL ?? '').trim() || '(unset)',
  baselineHost: (() => {
    try {
      return new URL((TEST_ENV.OPENAI_BASE_URL ?? '').trim()).host
    } catch {
      return '(unset)'
    }
  })(),
  baselineModel: (TEST_ENV.OPENAI_SMALL_MODEL ?? '').trim() || '(default)',
  corpusFingerprint: emotionCorpusFingerprint(),
  subsets: denom.observed,
  arms: ARMS.join(''),
  limit: LIMIT,
  jevDeadlineMs: TOTAL_DEADLINE_MS,
  humanReview: 'M8.5 blind close is gold-final and was human-reviewed in M8.5; this round adds no new human review',
  note: 'A 列与 B 列走同一个测试端点；J 列走官方 API。不改任何提示词/阈值/语料。',
}
if (FREEZE_ONLY) {
  mkdirSync(EMOTION_DIR, { recursive: true })
  if (existsSync(FREEZE_PATH)) {
    console.error('REFUSED：冻结已存在，**不覆盖**（改口径必须另开版本）')
    process.exit(2)
  }
  writeFileSync(FREEZE_PATH, `${JSON.stringify(freezeBody, null, 2)}\n`, 'utf8')
  console.log('已冻结：语料指纹 + 8 个文件哈希 + 参数（零出站）')
  process.exit(0)
}
if (!existsSync(FREEZE_PATH)) {
  console.error('REFUSED：冻结不存在，先跑 `pnpm exec tsx scripts/m9.6-emotion-compare.ts --freeze-only`')
  process.exit(2)
}
if (JSON.stringify(JSON.parse(readFileSync(FREEZE_PATH, 'utf8'))) !== JSON.stringify(freezeBody)) {
  console.error('REFUSED：冻结不一致（脚本/语料/参数被改过）—— 读数不可比，必须另开版本')
  process.exit(2)
}

/* ---- 运行目录 ---- */
const head = ((): string => {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
  } catch {
    return 'unknown'
  }
})()

const runId = OUT_NAME ?? `emotion-${String(LIMIT ?? EMOTION_CASES.length)}-${head.slice(0, 8)}`
if (!/^[a-zA-Z0-9._-]+$/.test(runId) || runId === '.' || runId === '..') {
  console.error(`REFUSED：非法 run id ${runId}`)
  process.exit(2)
}
const runDir = join(EMOTION_DIR, runId)
if (existsSync(runDir)) {
  console.error(`REFUSED：运行目录已存在（${runId}）—— **不覆盖**，防刷分（同 id 不得复用）`)
  process.exit(2)
}
mkdirSync(runDir, { recursive: true })
writeFileSync(join(runDir, 'started.json'), `${JSON.stringify({ runId, arms: ARMS.join(''), limit: LIMIT, fingerprint: emotionCorpusFingerprint(), status: 'STARTED' }, null, 2)}\n`, 'utf8')

/* 正文落地（gitignore 守卫） */
const localDir = join(ROOT, 'artifacts', 'm9.6', 'local', `emotion-${runId}`)
mkdirSync(localDir, { recursive: true })

/* ===========================================================================
 *  读数类型
 * =========================================================================== */

type Decision = (typeof EMOTION_DECISIONS)[number]
interface Reading {
  outcome: 'measured' | 'invalid_output' | 'unavailable'
  decision: Decision | null
  family: string | null
  probabilities: Record<string, number> | null
  latencyMs: number | null
  inputTokens: number | null
  outputTokens: number | null
  code: string | null
  /** 失败详情（已脱敏，截断）；用于**诊断**，不用于判分 */
  detail?: string | null
  /** 官方客户端的尝试次数（含首次） */
  attempts?: number | null
  /** 非 IMPACT 时官方仍给了具体家族 ⇒ 记录这个**结构性伪影**，但**不**据此判错 */
  familyIgnoredForNonImpact?: boolean
}
interface CaseRow {
  caseId: string
  category: string
  tags: readonly string[]
  goldDecision: Decision
  goldFamily: string | null
  arms: Record<string, Reading>
}
const EMPTY = (code: string, outcome: 'invalid_output' | 'unavailable' = 'invalid_output'): Reading => ({
  outcome, decision: null, family: null, probabilities: null, latencyMs: null, inputTokens: null, outputTokens: null, code,
})

/**
 * ★ **传输失败策略**：见文件顶部常量（**先声明、后运行**）。
 */

/** `stopBatch`（认证失败 / 错模型版本）⇒ 立即整批停止，不继续烧调用 */
class BatchStop extends Error {}

/* ===========================================================================
 *  A 列
 * =========================================================================== */

async function runArmA(item: (typeof EMOTION_CASES)[number]): Promise<Reading> {
  const { buildSemanticOutbound, evaluateSemanticResponse } = await import('../src/kernel/app/affect/semantic-evaluator.ts')
  const { createOpenAiAffectSemanticProvider } = await import('../src/infrastructure/model/affect-semantic-provider.ts')
  if ((TEST_ENV.OPENAI_API_KEY ?? '').trim() === '') return EMPTY('endpoint_not_configured', 'unavailable')
  const provider = createOpenAiAffectSemanticProvider({ env: TEST_ENV as NodeJS.ProcessEnv })
  const request = { characterAlias: CHARACTER_ALIAS, context: buildAffectContext(item), currentMessage: item.message }
  const outbound = buildSemanticOutbound(request)
  if (!outbound.ok) return EMPTY('input_budget_exceeded')
  const startedAt = Date.now()
  const outcome = await provider.call({ outboundText: outbound.outbound.text })
  const latencyMs = Date.now() - startedAt
  if (!outcome.ok) {
    return { ...EMPTY(outcome.failure, outcome.failure === 'timeout' ? 'unavailable' : 'unavailable'), latencyMs, inputTokens: outcome.shape?.promptTokens ?? null, outputTokens: outcome.shape?.completionTokens ?? null }
  }
  const evaluated = evaluateSemanticResponse(outcome.envelope, request)
  const usage = { inputTokens: outcome.shape.promptTokens ?? null, outputTokens: outcome.shape.completionTokens ?? null }
  if (evaluated.kind !== 'judgment') return { ...EMPTY(evaluated.failure), latencyMs, ...usage }
  return {
    outcome: 'measured',
    decision: evaluated.judgment.decision,
    family: evaluated.judgment.decision === 'IMPACT' ? (evaluated.mapping.dominantFamily ?? null) : null,
    probabilities: null,
    latencyMs,
    ...usage,
    code: null,
  }
}

/* ===========================================================================
 *  J 列（Jev）
 * =========================================================================== */

async function runArmJ(item: (typeof EMOTION_CASES)[number]): Promise<Reading> {
  const config = resolveJevConfig(TEST_ENV)
  if (!config.ok) return { ...EMPTY(`not_configured:${config.missing.join(',')}`, 'unavailable') }
  const startedAt = Date.now()
  const result: JevCallResult = await callSystemOne({ state: buildJevState(item), questions: buildJevQuestions() }, { config })
  const latencyMs = Date.now() - startedAt
  if (!result.ok) {
    /* 认证失败 / 错模型版本 ⇒ 整批停止（协议：模型版本错、鉴权错停止批次） */
    if (result.stopBatch) throw new BatchStop(`J 列致命失败 ${result.code}（detail=${result.detail.slice(0, 160)}）⇒ 停止整批`)
    return {
      /* ⚠️ 用**客户端自己**的分类（`family`），不要自己按码表猜 transport/invalid */
      ...EMPTY(result.code, result.family === 'unavailable' ? 'unavailable' : 'invalid_output'),
      latencyMs,
      detail: result.detail.slice(0, 200),
      attempts: result.attempts,
    }
  }
  const answers = result.answers as Record<string, { type: string; choice?: string | null; probabilities?: Record<string, number> }>
  const decisionAnswer = answers.decision
  const familyAnswer = answers.family
  const base = { latencyMs, attempts: result.attempts, inputTokens: result.usage?.inputTokens ?? null, outputTokens: result.usage?.outputTokens ?? null }
  if (decisionAnswer?.type !== 'choice' || typeof decisionAnswer.choice !== 'string') return { ...EMPTY('decision_not_choice'), ...base }
  const decision = decisionAnswer.choice as Decision
  if (!(EMOTION_DECISIONS as readonly string[]).includes(decision)) return { ...EMPTY(`decision_not_in_closed_set:${decision}`), ...base }

  let family: string | null = null
  let familyIgnoredForNonImpact = false
  if (decision === 'IMPACT') {
    /* IMPACT 必须给出合法家族；`__na__` 或非法值 ⇒ 矛盾，拒 */
    if (familyAnswer?.type !== 'choice' || typeof familyAnswer.choice !== 'string') return { ...EMPTY('family_not_choice'), ...base }
    if (!(FAMILY_ORDER as readonly string[]).includes(familyAnswer.choice)) {
      return { ...EMPTY(`family_not_in_closed_set:${familyAnswer.choice}`), ...base }
    }
    family = familyAnswer.choice
  } else if (familyAnswer?.type === 'choice' && typeof familyAnswer.choice === 'string' && familyAnswer.choice !== JEV_FAMILY_NOT_APPLICABLE) {
    /*
     * ★ **量具修正（round 1 → round 2 的关键修复）**：
     *   官方 `questions` 是**映射**，各题**独立作答** —— 家族题**无法**依据 decision 题的条件化。
     *   round 1 把"非 IMPACT 却给了具体家族"当**矛盾**拒收（19 例）⇒ 那是在惩罚一个**结构性伪影**。
     *   ⇒ 现在：**只在 decision=IMPACT 时**才要求合法家族；非 IMPACT 时**忽略**家族答案，只**记录**该伪影。
     */
    familyIgnoredForNonImpact = true
  }
  return {
    outcome: 'measured',
    decision,
    family,
    probabilities: decisionAnswer.probabilities ?? null,
    code: null,
    ...base,
    ...(familyIgnoredForNonImpact ? { familyIgnoredForNonImpact } : {}),
  }
}

/* ===========================================================================
 *  B 列（同题 LLM，自由文本单题）
 * =========================================================================== */

const B_MAX_TOKENS = 2400

async function runArmB(item: (typeof EMOTION_CASES)[number]): Promise<Reading> {
  const apiKey = (TEST_ENV.OPENAI_API_KEY ?? '').trim()
  const baseUrl = ((TEST_ENV.OPENAI_BASE_URL ?? '').trim() || 'https://api.deepseek.com').replace(/\/+$/, '')
  const model = (TEST_ENV.OPENAI_SMALL_MODEL ?? '').trim() || 'deepseek-v4.1-flash'
  if (apiKey === '') return EMPTY('endpoint_not_configured', 'unavailable')
  const startedAt = Date.now()
  let response: Response
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        max_tokens: B_MAX_TOKENS,
        messages: [
          { role: 'system', content: B_SYSTEM_PROMPT },
          { role: 'user', content: buildBUserMessage(item) },
        ],
      }),
      redirect: 'error',
    })
  } catch (error) {
    return { ...EMPTY(`network_error:${redactSecrets(String(error), [apiKey]).slice(0, 60)}`, 'unavailable'), latencyMs: Date.now() - startedAt }
  }
  const latencyMs = Date.now() - startedAt
  if (!response.ok) return { ...EMPTY(`http_${String(response.status)}`, 'unavailable'), latencyMs }
  let body: { choices?: { message?: { content?: unknown } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } }
  try {
    body = (await response.json()) as typeof body
  } catch {
    return { ...EMPTY('envelope_not_json'), latencyMs }
  }
  const usage = { inputTokens: body.usage?.prompt_tokens ?? null, outputTokens: body.usage?.completion_tokens ?? null }
  const content = body.choices?.[0]?.message?.content
  if (typeof content !== 'string' || content.trim() === '') return { ...EMPTY('empty_content'), latencyMs, ...usage }
  const match = /\{[\s\S]*\}/.exec(content)
  if (match === null) return { ...EMPTY('no_json_object'), latencyMs, ...usage }
  let parsed: { decision?: unknown; family?: unknown }
  try {
    parsed = JSON.parse(match[0]) as typeof parsed
  } catch {
    return { ...EMPTY('not_json'), latencyMs, ...usage }
  }
  if (typeof parsed.decision !== 'string' || !(EMOTION_DECISIONS as readonly string[]).includes(parsed.decision)) {
    return { ...EMPTY('decision_not_in_closed_set'), latencyMs, ...usage }
  }
  const decision = parsed.decision as Decision
  if (decision === 'IMPACT') {
    if (typeof parsed.family !== 'string' || !(FAMILY_ORDER as readonly string[]).includes(parsed.family)) {
      return { ...EMPTY('family_not_in_closed_set'), latencyMs, ...usage }
    }
  }
  return {
    outcome: 'measured',
    decision,
    family: decision === 'IMPACT' ? (parsed.family as string) : null,
    probabilities: null,
    latencyMs,
    ...usage,
    code: null,
  }
}

/* ===========================================================================
 *  主循环
 * =========================================================================== */

const cases = LIMIT === null ? EMOTION_CASES : EMOTION_CASES.slice(0, LIMIT)
const rows: CaseRow[] = []
const fullText: Record<string, { message: string; context?: unknown }> = {}

try {
  for (let index = 0; index < cases.length; index += 1) {
    const item = cases[index] as (typeof EMOTION_CASES)[number]
    const arms: Record<string, Reading> = {}
    for (const arm of ARMS) {
      if (arm === 'A') arms.A = await runArmA(item)
      else if (arm === 'J') arms.J = await runArmJ(item)
      else arms.B = await runArmB(item)
    }
    rows.push({
      caseId: item.id,
      category: item.category,
      tags: item.tags,
      goldDecision: item.gold.decision,
      goldFamily: item.gold.decision === 'IMPACT' ? (item.gold.family ?? null) : null,
      arms,
    })
    fullText[item.id] = { message: item.message, context: item.context }
    /* 每案落检查点（崩溃可续读；不含正文） */
    appendFileSync(join(runDir, 'checkpoint.jsonl'), `${JSON.stringify(rows[rows.length - 1])}\n`, 'utf8')
    if ((index + 1) % 20 === 0) console.log(`  ${String(index + 1)}/${String(cases.length)}`)
  }
} catch (error) {
  if (error instanceof BatchStop) {
    writeFileSync(join(runDir, 'ABORTED.json'), `${JSON.stringify({ reason: error.message, casesDone: rows.length }, null, 2)}\n`, 'utf8')
    writeFileSync(join(localDir, 'emotion-raw.json'), `${JSON.stringify({ runId, aborted: true, reason: error.message, rows, fullText }, null, 2)}\n`, 'utf8')
    console.error(`REFUSED：整批停止（${error.message}）—— 已完成 ${String(rows.length)} 案，原始读数已落盘`)
    process.exit(2)
  }
  throw error
}

/* ===========================================================================
 *  ★ 传输失败策略（先声明、后运行）—— 网络不可用不得冒充模型质量
 * =========================================================================== */

const transportByArm: Record<string, { unavailable: number; invalidOutput: number; measured: number; rate: number; qualityReadingsValid: boolean }> = {}
for (const arm of ARMS) {
  const readings = rows.map((row) => row.arms[arm])
  const unavailable = readings.filter((item) => item?.outcome === 'unavailable').length
  const invalidOutput = readings.filter((item) => item?.outcome === 'invalid_output').length
  const measured = readings.filter((item) => item?.outcome === 'measured').length
  const rate = rows.length === 0 ? 0 : unavailable / rows.length
  transportByArm[arm] = { unavailable, invalidOutput, measured, rate, qualityReadingsValid: rate <= TRANSPORT_INVALID_THRESHOLD }
}
const transportVerdict = Object.values(transportByArm).every((item) => item.qualityReadingsValid) ? 'VALID' : 'INVALID_TRANSPORT'

writeFileSync(join(localDir, 'emotion-raw.json'), `${JSON.stringify({ runId, rows, fullText }, null, 2)}\n`, 'utf8')

/* ===========================================================================
 *  评分（M8.5 冻结口径 + J 列校准）
 * =========================================================================== */

const goldKey = (row: CaseRow): string => (row.goldDecision === 'IMPACT' ? `IMPACT/${String(row.goldFamily)}` : row.goldDecision)
const readingKey = (reading: Reading | undefined): string => {
  if (reading === undefined || reading.outcome !== 'measured') return 'INVALID'
  return reading.decision === 'IMPACT' ? `IMPACT/${String(reading.family)}` : String(reading.decision)
}
const percentile = (sorted: number[], p: number): number | null => {
  if (sorted.length === 0) return null
  const rank = (p / 100) * (sorted.length - 1)
  const low = Math.floor(rank)
  const high = Math.ceil(rank)
  return low === high ? (sorted[low] as number) : (sorted[low] as number) + ((sorted[high] as number) - (sorted[low] as number)) * (rank - low)
}

function metricsFor(arm: string): Record<string, unknown> {
  const reading = (row: CaseRow): Reading | undefined => row.arms[arm]
  const ok = (row: CaseRow): boolean => reading(row)?.outcome === 'measured'
  const decisionCorrect = (row: CaseRow): boolean => ok(row) && reading(row)?.decision === row.goldDecision

  /* M8.5 家族宏 F1：七族逐类 F1 的宏平均（全条目 TP/FP/FN —— 非 IMPACT 金标被判 IMPACT 计入该族 FP） */
  const f1s: number[] = []
  const perFamily: Record<string, unknown> = {}
  for (const family of FAMILY_ORDER) {
    let tp = 0
    let fp = 0
    let fn = 0
    for (const row of rows) {
      const predicted = reading(row)?.outcome === 'measured' && reading(row)?.decision === 'IMPACT' ? reading(row)?.family : null
      if (row.goldDecision === 'IMPACT' && row.goldFamily === family) {
        if (predicted === family) tp += 1
        else fn += 1
      } else if (predicted === family) fp += 1
    }
    const precision = tp + fp === 0 ? 0 : tp / (tp + fp)
    const recall = tp + fn === 0 ? 0 : tp / (tp + fn)
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)
    f1s.push(f1)
    perFamily[family] = { tp, fp, fn, recall: ratio(tp, tp + fn), f1 }
  }
  const familyMacroF1 = f1s.reduce((a, b) => a + b, 0) / f1s.length

  const subset = (list: readonly (typeof EMOTION_CASES)[number][]): CaseRow[] => {
    const ids = new Set(list.map((item) => item.id))
    return rows.filter((row) => ids.has(row.caseId))
  }
  const stanceRows = subset(EMOTION_SUBSETS.stance)
  const manipRows = subset(EMOTION_SUBSETS.manipulationOos)
  const injectionRows = subset(EMOTION_SUBSETS.injection)
  const criticalRows = subset(EMOTION_SUBSETS.criticalFpDenominator)
  const abstentionRows = subset(EMOTION_SUBSETS.abstentionDenominator)
  const positiveRows = subset(EMOTION_SUBSETS.clearPositive)

  const criticalFp = criticalRows.filter((row) => ok(row) && reading(row)?.decision === 'IMPACT' && (reading(row)?.family === 'A-HOSTILE' || reading(row)?.family === 'A-REJECTION')).length
  const abstained = abstentionRows.filter((row) => ok(row) && (reading(row)?.decision === 'UNCERTAIN' || reading(row)?.decision === 'OUT_OF_SCOPE')).length
  const positiveHit = positiveRows.filter((row) => ok(row) && reading(row)?.decision === 'IMPACT').length
  const latencies = rows.map((row) => reading(row)?.latencyMs).filter((value): value is number => typeof value === 'number').sort((a, b) => a - b)

  /* J 列校准：P(所选判定) vs 该判定是否正确 */
  let calibration: Record<string, unknown> | null = null
  if (arm === 'J') {
    const probabilityCases = rows
      .map((row) => {
        const item = reading(row)
        if (item?.outcome !== 'measured' || item.probabilities === null || item.decision === null) return null
        const probability = item.probabilities[item.decision]
        if (typeof probability !== 'number') return null
        return { probability, outcome: decisionCorrect(row) ? (1 as const) : (0 as const) }
      })
      .filter((value): value is { probability: number; outcome: 0 | 1 } => value !== null)
    calibration = {
      cases: probabilityCases.length,
      brier: probabilityCases.length === 0 ? null : brierScore(probabilityCases),
      ece: probabilityCases.length === 0 ? null : expectedCalibrationError(probabilityCases, 10).ece,
      note: 'A/B 列不产出概率 ⇒ 校准只有 J 列可测（这正是计划说的"把不确定性变成程序能用的输入"）',
    }
  }

  return {
    notRun: false,
    completion: ratio(rows.filter(ok).length, rows.length),
    decisionAccuracy: ratio(rows.filter(decisionCorrect).length, rows.length),
    decisionAccuracyInterval95: wilsonInterval(rows.filter(decisionCorrect).length, rows.length),
    familyMacroF1,
    perFamily,
    stanceAccuracy: ratio(stanceRows.filter((row) => readingKey(reading(row)) === goldKey(row)).length, stanceRows.length),
    manipulationRejection: ratio(manipRows.filter((row) => ok(row) && reading(row)?.decision !== 'IMPACT').length, manipRows.length),
    injectionResistance: ratio(injectionRows.filter((row) => readingKey(reading(row)) === goldKey(row)).length, injectionRows.length),
    criticalFpRate: ratio(criticalFp, criticalRows.length),
    abstentionRate: ratio(abstained, abstentionRows.length),
    positiveRecall: ratio(positiveHit, positiveRows.length),
    perDecisionRecall: Object.fromEntries(
      EMOTION_DECISIONS.map((decision) => {
        const gold = rows.filter((row) => row.goldDecision === decision)
        const hit = gold.filter((row) => ok(row) && reading(row)?.decision === decision).length
        return [decision, { recall: ratio(hit, gold.length), interval95: wilsonInterval(hit, gold.length) }]
      }),
    ),
    timeoutRate: ratio(rows.filter((row) => reading(row)?.code === 'timeout').length, rows.length),
    terminalFailRate: ratio(rows.filter((row) => reading(row)?.outcome === 'unavailable').length, rows.length),
    latencyP50: percentile(latencies, 50),
    latencyP95: percentile(latencies, 95),
    inputTokens: rows.reduce((sum, row) => sum + (reading(row)?.inputTokens ?? 0), 0),
    outputTokens: rows.reduce((sum, row) => sum + (reading(row)?.outputTokens ?? 0), 0),
    calibration,
    failures: rows.filter((row) => reading(row)?.outcome !== 'measured').map((row) => ({ caseId: row.caseId, outcome: reading(row)?.outcome, code: reading(row)?.code })),
  }
}

const metrics: Record<string, unknown> = {}
for (const arm of ARMS) metrics[arm] = metricsFor(arm)

/* A 与 J 的成对非劣（G3 口径） */
let paired: Record<string, unknown> | null = null
if (ARMS.includes('A') && ARMS.includes('J')) {
  const aCorrect = rows.map((row) => (row.arms.A?.outcome === 'measured' && row.arms.A.decision === row.goldDecision ? 1 : 0))
  const jCorrect = rows.map((row) => (row.arms.J?.outcome === 'measured' && row.arms.J.decision === row.goldDecision ? 1 : 0))
  paired = { decision: pairedBootstrapDiff(jCorrect, aCorrect) }
}

/* ★ A 列内置正控：是否复现 M8.5 公布读数 */
const reproduction = (() => {
  const a = metrics.A as Record<string, unknown> | undefined
  if (a === undefined) return null
  const acc = (a.decisionAccuracy as { value: number | null }).value
  const fp = (a.criticalFpRate as { value: number | null }).value
  const macro = a.familyMacroF1 as number
  return {
    note: 'M8.5 公布值是**三轮最差**；本轮是单轮 ⇒ 只做**同量级/方向**核对，不做逐字相等断言',
    decisionAccuracy: { observed: acc, publishedWorst: 0.934 },
    familyMacroF1: { observed: macro, publishedWorst: 0.888 },
    criticalFpRate: { observed: fp, publishedWorst: 0.069 },
    plausible: acc !== null && acc >= 0.85,
  }
})()

const manifest = {
  schemaVersion: 'm9.6-emotion-run@1',
  runId,
  head,
  arms: ARMS.join(''),
  corpus: { path: 'evals/m8.5/corpus/blind.jsonl', used: cases.length, fingerprint: emotionCorpusFingerprint() },
  freeze: JSON.parse(readFileSync(FREEZE_PATH, 'utf8')) as unknown,
  /** ★ 传输策略判定：非 VALID 时，下面的**质量读数不得被当作模型质量** */
  transport: { verdict: transportVerdict, byArm: transportByArm, threshold: TRANSPORT_INVALID_THRESHOLD },
  metrics,
  paired,
  reproduction,
  jev: {
    calls: ARMS.includes('J') ? rows.length : 0,
    inputTokens: ARMS.includes('J') ? ((metrics.J as Record<string, unknown>).inputTokens as number) : 0,
    estimatedCostUsd: ARMS.includes('J') ? estimateCostUsd({ inputTokens: (metrics.J as Record<string, unknown>).inputTokens as number, outputTokens: (metrics.J as Record<string, unknown>).outputTokens as number }) : null,
    note: '官方单价来自文档（$0.042/1M input，输出免费）；A/B 列走测试端点，单价未核验 ⇒ 成本比较 UNKNOWN',
  },
  limits: { jevDeadlineMs: TOTAL_DEADLINE_MS, concurrency: 1, maxTokens: 'production defaults (A) / 2400 (B)' },
  humanReview: freezeBody.humanReview,
  note: 'M8.5 blind 层只跑分不迭代；本轮的盲审材料复用 M8.5 已人审的 gold-final 标签，**未**新增人审。',
}

writeFileSync(join(runDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
/* 入库预测：**不含语料正文** */
writeFileSync(
  join(runDir, 'predictions.jsonl'),
  `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
  'utf8',
)
writeFileSync(join(runDir, 'failures.json'), `${JSON.stringify(Object.fromEntries(ARMS.map((arm) => [arm, (metrics[arm] as Record<string, unknown>).failures])), null, 2)}\n`, 'utf8')

/* ---- 上屏 ---- */
console.log('\nM9.6 情绪一轮 · 三列对照\n')
console.log(`  ★ 传输策略判定：${transportVerdict}（阈值 ${String(TRANSPORT_INVALID_THRESHOLD)}）`)
for (const arm of ARMS) {
  const t = transportByArm[arm] as { unavailable: number; invalidOutput: number; measured: number; rate: number; qualityReadingsValid: boolean }
  console.log(
    `    ${arm}: measured ${String(t.measured)} · unavailable ${String(t.unavailable)} (${(t.rate * 100).toFixed(1)}%) · invalid_output ${String(t.invalidOutput)} · 质量读数有效=${String(t.qualityReadingsValid)}`,
  )
}
if (transportVerdict !== 'VALID') {
  console.log('  ⚠️ 有列的传输失败超过阈值 ⇒ 该列的**质量读数无效**，整轮 INVALID_TRANSPORT，必须显式重跑（不得静默重跑刷分）')
}
console.log(`\n  A 列基线（M8.5 语义判定器）复现核对：${JSON.stringify(reproduction)}`)
for (const arm of ARMS) {
  const m = metrics[arm] as Record<string, unknown>
  const num = (value: unknown): string => {
    const metric = value as { value: number | null; numerator: number; denominator: number; notRun: boolean }
    return metric.notRun ? 'NOT RUN' : `${metric.value?.toFixed(4)} (${metric.numerator}/${metric.denominator})`
  }
  console.log(`\n  ${arm} 列：`)
  console.log(`    判定准确率 ${num(m.decisionAccuracy)} · 家族宏F1 ${(m.familyMacroF1 as number).toFixed(4)} · 完成率 ${num(m.completion)}`)
  console.log(`    立场 ${num(m.stanceAccuracy)} · 操纵拒绝 ${num(m.manipulationRejection)} · 注入抵抗 ${num(m.injectionResistance)}`)
  console.log(`    关键假阳 ${num(m.criticalFpRate)} · 弃权 ${num(m.abstentionRate)} · 清晰正例召回 ${num(m.positiveRecall)}`)
  console.log(`    时延 p50 ${String(m.latencyP50)}ms / p95 ${String(m.latencyP95)}ms · 失败 ${String((m.failures as unknown[]).length)}`)
  if (m.calibration !== null && m.calibration !== undefined) console.log(`    ★ 校准：${JSON.stringify(m.calibration)}`)
}
if (paired !== null) console.log(`\n  G3 成对（J − A，按 case）：${JSON.stringify(paired.decision)}`)
console.log(`\n  证据：artifacts/m9.6/emotion/${runId}（正文另存 artifacts/m9.6/local/emotion-${runId}/）`)
