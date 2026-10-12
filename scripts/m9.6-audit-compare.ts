/**
 * M9.6 WP4a —— **离线事实审计探索（两层对照）**。
 *
 * ```bash
 * pnpm m9.6:audit-compare -- --split dev --layers 12 [--limit N] [--out r1]
 * ```
 *
 * ============================================================================
 *  两层是什么（计划 §6.3 逐字）
 * ============================================================================
 * ```text
 * 第一层 ①：**固定人工主张** + 可采信证据 ⇒ 只测**主张—证据关系**（4 类闭集）
 *           J = Jev 官方 API（Choice）· B = **同题** LLM（控制任务表达差异）
 *
 * 第二层 ②：**整段回复**进审计链 ⇒ 测**主张提取覆盖 / 漏主张 / 端到端关键错误**
 *           A  = **修复后的原审计链**（`m9.5-live-judge-llm@2`，WP0a 的产物）
 *           JC = **组合方案**： [`@2` 提取] × [Jev 逐条判支持]
 *
 * ⚠️ 计划逐字：**「人工主张只可作为第一层输入及第二层 oracle，不能偷偷补给第二层提取器」**
 *    ⇒ 第二层只吃 `reply` + `evidence`；`keyClaims` **只用于评分**。
 * ⚠️ 计划逐字：组合方案必须**单独登记**，「其全部调用、失败、费用、延迟计入候选链，
 *    **不得归功于 Jev 单次调用**」⇒ JC 明确记录两段各自的调用数与耗时。
 * ```
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

import {
  JEV_MODEL_VAR,
  JEV_TEST_KEY_VAR,
  TOTAL_DEADLINE_MS,
  callSystemOne,
  estimateCostUsd,
  redactSecrets,
  type JevQuestions,
} from './m9.6-jev-protocol.ts'
import { judgeWithModel, type LlmJudgeVerdict } from './m9.5-live-judge-llm.ts'
import {
  AUDIT_RELATIONS,
  admissibleEvidenceOf,
  auditCorpusFingerprint,
  selectAuditCases,
  validateAuditCorpus,
  type AuditCase,
  type AuditRelation,
} from '../evals/m9.6/audit-corpus.ts'
import { accuracy, describeMetric, ratio, wilsonInterval, type LabeledCase, type Metric } from './m9.6-stats.ts'

const ROOT = resolve('.')

/* ===========================================================================
 *  参数 / 凭据
 * =========================================================================== */

function arg(name: string, fallback: string | null = null): string | null {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && index + 1 < process.argv.length ? (process.argv[index + 1] as string) : fallback
}

const SPLIT_INPUT = arg('split', 'dev')
if (SPLIT_INPUT !== 'dev' && SPLIT_INPUT !== 'val' && SPLIT_INPUT !== 'test') {
  console.error(`REFUSED：--split 只能是 dev/val/test（收到 ${String(SPLIT_INPUT)}）`)
  process.exit(2)
}
const SPLIT: 'dev' | 'val' | 'test' = SPLIT_INPUT
const ROUND = arg('round', '1')
const LIMIT = arg('limit') === null ? null : Number(arg('limit'))
const OUT_NAME = arg('out')
/** 层选择（与 --arms 同理：`pnpm` 会吃掉逗号 ⇒ 按**字符**取） */
const LAYER_INPUT = (arg('layers', '12') ?? '12').split('').filter((char) => char === '1' || char === '2')
const LAYERS = { one: LAYER_INPUT.includes('1'), two: LAYER_INPUT.includes('2') }
if (!LAYERS.one && !LAYERS.two) {
  console.error(`REFUSED：--layers "${String(arg('layers'))}" 未选中任何层`)
  process.exit(2)
}

function readTestEnvFile(path: string): Record<string, string> {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    console.error(`REFUSED：找不到 ${path}`)
    process.exit(2)
  }
  const vars: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const equals = trimmed.indexOf('=')
    if (equals <= 0) continue
    let value = trimmed.slice(equals + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    vars[trimmed.slice(0, equals).trim()] = value
  }
  return vars
}

const VALIDATE_ONLY = process.argv.includes('--validate-only')
const TEST_ENV = readTestEnvFile(join(ROOT, '.env.test'))
const jevKey = (TEST_ENV[JEV_TEST_KEY_VAR] ?? '').trim()
const jevModel = (TEST_ENV[JEV_MODEL_VAR] ?? '').trim()
const openAiKey = (TEST_ENV.OPENAI_API_KEY ?? '').trim()
const openAiBaseUrl = (TEST_ENV.OPENAI_BASE_URL ?? '').trim()
const openAiSmallModel = (TEST_ENV.OPENAI_SMALL_MODEL ?? '').trim()

if (!VALIDATE_ONLY && (jevKey === '' || jevModel === '')) {
  console.error(`REFUSED：${JEV_TEST_KEY_VAR} / ${JEV_MODEL_VAR} 未配置`)
  process.exit(2)
}
if (!VALIDATE_ONLY && (openAiKey === '' || openAiBaseUrl === '')) {
  console.error('REFUSED：`@2` 审计链与 B 列都需要 `.env.test` 的 OPENAI_API_KEY / OPENAI_BASE_URL')
  process.exit(2)
}
const SECRETS = [jevKey, openAiKey]

function assertNoSecret(text: string, label: string): void {
  const leaked = SECRETS.filter((secret) => secret.length >= 8 && text.includes(secret))
  if (leaked.length > 0) {
    console.error(`REFUSED：${label} 里出现秘密 ⇒ 拒写`)
    process.exit(3)
  }
}
function assertPathIgnored(path: string): void {
  try {
    execFileSync('git', ['check-ignore', path], { cwd: ROOT, stdio: 'ignore' })
  } catch {
    console.error(`REFUSED：${path} 未被 git 忽略 ⇒ 拒绝把语料正文写进仓库`)
    process.exit(3)
  }
}

/* ===========================================================================
 *  语料校验
 * =========================================================================== */

const validation = validateAuditCorpus()
if (!validation.ok) {
  console.error(`REFUSED：审计语料结构校验失败\n  - ${validation.problems.join('\n  - ')}`)
  process.exit(2)
}
const FINGERPRINT = auditCorpusFingerprint()

if (VALIDATE_ONLY) {
  console.log('M9.6 WP4a 审计语料校验（--validate-only · 零出站）')
  console.log('  结构校验：通过（0 项问题）')
  console.log(`  总数 ${String(validation.counts.total)} · 分层 ${JSON.stringify(validation.counts.bySplit)}`)
  for (const [split, bucket] of Object.entries(validation.counts.bySplitRelation)) {
    console.log(`    ${split}: ${JSON.stringify(bucket)}`)
  }
  console.log(`  指纹：${FINGERPRINT}`)
  process.exit(0)
}

const corpus = LIMIT === null ? selectAuditCases(SPLIT) : selectAuditCases(SPLIT).slice(0, LIMIT)

/* ===========================================================================
 *  第一层：主张 × 证据 → 关系
 * =========================================================================== */

const RELATION_CRITERIA: Record<string, string | null> = {
  supports: '证据**支持**该主张：证据给出的取值与主张一致',
  contradicts: '证据与该主张**冲突**：证据给出的是**同一个槽位**但**不同**的取值',
  insufficient: '证据**无法裁定**该主张：证据讲的是**别的槽位**，或者本轮**根本没有**可采信证据',
  no_assertion: '这**不是**一条关于"用户自身槽位具体取值"的事实主张（寒暄 / 自述记忆状态 / 元陈述 / 定义 / 不含具体取值的泛推断）',
}

const RELATION_INSTRUCTIONS = [
  '判断「主张」与「可采信证据」之间的关系。',
  '· 只看主张是否点出了**用户自身槽位的具体取值**；点不出具体取值的句子不构成主张。',
  '· 角色对自己记忆状态的自述（"没有记录""不记得"）**不是**事实主张。',
  '· 关于本轮对话说过什么的元陈述**不是**事实主张。',
  '· 定义、名词解释、泛泛描述**不是**事实主张。',
].join('\n')

function layer1Questions(item: AuditCase): JevQuestions {
  return {
    relation: {
      type: 'choice',
      instructions: RELATION_INSTRUCTIONS,
      criteria: RELATION_CRITERIA,
    },
  }
}

interface Layer1Reading {
  readonly outcome: 'measured' | 'invalid_output' | 'unavailable'
  readonly relation: AuditRelation | null
  readonly code: string | null
  readonly detail: string | null
  readonly latencyMs: number
  readonly inputTokens: number | null
}

/** 第一层 J 列：Jev */
async function layer1Jev(item: AuditCase): Promise<Layer1Reading> {
  const startedAt = Date.now()
  const result = await callSystemOne(
    { state: `主张：${item.claim}\n可采信证据：${item.evidence}`, questions: layer1Questions(item) },
    { config: { ok: true, apiKey: jevKey, model: jevModel } }
  )
  const latencyMs = Date.now() - startedAt
  if (!result.ok) {
    return { outcome: result.family, relation: null, code: result.code, detail: result.detail, latencyMs, inputTokens: null }
  }
  const answer = result.answers.relation
  if (answer?.type !== 'choice' || answer.choice === null) {
    return { outcome: 'invalid_output', relation: null, code: 'relation_missing', detail: null, latencyMs, inputTokens: result.usage?.inputTokens ?? null }
  }
  return {
    outcome: 'measured',
    relation: answer.choice as AuditRelation,
    code: null,
    detail: null,
    latencyMs,
    inputTokens: result.usage?.inputTokens ?? null,
  }
}

/** 第一层 B 列：**同题** LLM（短单问题，max_tokens 与 A 列同预算） */
async function layer1Llm(item: AuditCase): Promise<Layer1Reading> {
  const startedAt = Date.now()
  try {
    const response = await fetch(`${openAiBaseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${openAiKey}` },
      body: JSON.stringify({
        model: openAiSmallModel === '' ? undefined : openAiSmallModel,
        temperature: 0,
        max_tokens: 800,
        messages: [
          { role: 'system', content: '只输出一个 JSON 对象，不要解释、不要代码块围栏，形如 {"relation":"<取值>"}。' },
          {
            role: 'user',
            content: `${RELATION_INSTRUCTIONS}\n\n可选关系：${Object.keys(RELATION_CRITERIA).join(' / ')}\n\n主张：${item.claim}\n可采信证据：${item.evidence}`,
          },
        ],
      }),
      signal: AbortSignal.timeout(TOTAL_DEADLINE_MS),
    })
    const latencyMs = Date.now() - startedAt
    if (!response.ok) {
      return { outcome: 'unavailable', relation: null, code: `http_${String(response.status)}`, detail: null, latencyMs, inputTokens: null }
    }
    const payload = (await response.json()) as { choices?: { message?: { content?: unknown } }[] }
    const content = payload.choices?.[0]?.message?.content
    if (typeof content !== 'string') {
      return { outcome: 'invalid_output', relation: null, code: 'content_missing', detail: null, latencyMs, inputTokens: null }
    }
    const match = /\{[\s\S]*\}/.exec(content)
    if (match === null) {
      return { outcome: 'invalid_output', relation: null, code: 'no_json_object', detail: null, latencyMs, inputTokens: null }
    }
    let parsed: { relation?: unknown }
    try {
      parsed = JSON.parse(match[0]) as { relation?: unknown }
    } catch {
      return { outcome: 'invalid_output', relation: null, code: 'not_json', detail: null, latencyMs, inputTokens: null }
    }
    const relation = parsed.relation
    if (typeof relation !== 'string' || !AUDIT_RELATIONS.includes(relation as AuditRelation)) {
      return { outcome: 'invalid_output', relation: null, code: 'relation_not_in_set', detail: null, latencyMs, inputTokens: null }
    }
    return { outcome: 'measured', relation: relation as AuditRelation, code: null, detail: null, latencyMs, inputTokens: null }
  } catch (error) {
    return {
      outcome: 'unavailable',
      relation: null,
      code: (error as Error).name,
      detail: redactSecrets((error as Error).message.slice(0, 120), SECRETS),
      latencyMs: Date.now() - startedAt,
      inputTokens: null,
    }
  }
}

/* ===========================================================================
 *  第二层：整段回复 → 审计链
 * =========================================================================== */

interface Layer2Reading {
  readonly outcome: 'measured' | 'invalid_output' | 'unavailable'
  readonly code: string | null
  readonly assertions: readonly string[]
  readonly unsupportedCount: number
  readonly criticalErrors: number
  /** 金标主张里被抽出来的条数 */
  readonly coveredKeyClaims: number
  /** 由链推出的关系（⚠️ 只能表达三类：链**无法**表达 contradicts） */
  readonly derivedRelation: AuditRelation | null
  readonly latencyMs: number
  readonly judgeCalls: number
  readonly jevCalls: number
  readonly jevInputTokens: number | null
}

const JUDGE_REQUEST = '用户在他自己的记忆槽位上有什么具体取值？'

/**
 * 组合方案"判支持"这一步的**适配版本** —— 必须随证据记录，
 * 否则 dev 两轮的读数不可区分（哪一轮用了哪套 instructions 必须能查）。
 */
const COMBINED_ADAPTATION =
  'v2-slot-notation-explained · dev 第 2 轮：把「槽位 = 取值」记号的含义写进 Noul instructions（只改表达，不改判据）'

/** 只用 `reply` + `evidence` 调 `@2` 审计链（**绝不**把金标喂进去） */
async function runAuditChain(item: AuditCase): Promise<{ reading: Layer2Reading; verdict: LlmVerdictSummary | null }> {
  const startedAt = Date.now()
  const verdict = await judgeWithModel(
    { request: JUDGE_REQUEST, reply: item.reply, admissibleEvidence: admissibleEvidenceOf(item) },
    { endpoint: { baseUrl: openAiBaseUrl, model: openAiSmallModel, apiKey: openAiKey }, deadlineMs: TOTAL_DEADLINE_MS }
  )
  const latencyMs = Date.now() - startedAt
  const assertions = verdict.assertions.map((assertion) => assertion.text)
  const coveredKeyClaims = item.expected.keyClaims.filter((keyClaim) =>
    assertions.some((assertion) => assertion.includes(keyClaim) || keyClaim.includes(assertion))
  ).length
  const unsupportedCount = verdict.unsupportedAssertions.length
  /*
   * ⚠️ 由链**推出**的关系：链只给"支持/不支持"，**表达不出 contradicts**
   *    ⇒ 它的 derivedRelation 只在三类里取，报告里必须标注这个表达力上限。
   */
  const derivedRelation: AuditRelation | null =
    verdict.kind === 'unavailable' ? null : assertions.length === 0 ? 'no_assertion' : unsupportedCount === 0 ? 'supports' : 'insufficient'
  return {
    verdict: {
      kind: verdict.kind,
      rawOutcome: verdict.rawOutcome,
      parseCode: verdict.parseCode,
      attempts: verdict.attempts,
      grounded: verdict.grounded,
    },
    reading: {
      outcome: verdict.kind === 'unavailable' ? (verdict.rawOutcome === 'invalid_output' ? 'invalid_output' : 'unavailable') : 'measured',
      code: verdict.parseCode,
      assertions,
      unsupportedCount,
      criticalErrors: verdict.criticalErrors.length,
      coveredKeyClaims,
      derivedRelation,
      latencyMs,
      judgeCalls: verdict.attempts,
      jevCalls: 0,
      jevInputTokens: null,
    },
  }
}

interface LlmVerdictSummary {
  readonly kind: string
  readonly rawOutcome: string
  readonly parseCode: string | null
  readonly attempts: number
  readonly grounded: boolean
}

/**
 * ★ **组合方案 JC**（必须单独登记）：[`@2` 提取] × [Jev 逐条判支持]。
 * 提取**不是** Jev 做的（官方 API 没有自由文本输出）⇒ 两段调用分别计数、分别计时，
 * **不得**把这个组合的成绩归功于 Jev 单次调用。
 */
async function runCombined(item: AuditCase, extraction: Layer2Reading): Promise<Layer2Reading> {
  if (extraction.assertions.length === 0) {
    /* 提取阶段就没主张 ⇒ 不需要 Jev 调用（这也是组合方案的真实成本结构） */
    return { ...extraction, jevCalls: 0 }
  }
  const questions: Record<string, { type: 'noul'; instructions: string; criteria: { true: string; false: string } }> = {}
  extraction.assertions.forEach((assertion, index) => {
    questions[`a${String(index)}`] = {
      type: 'noul',
      /*
       * ⚠️ **dev 第 2 轮的适配修订**（计划 §6.2：dev 允许最多两轮）。
       *   第 1 轮唯一被 Jev 判错的组合案例（`aud-dev-0004`）是"证据写成 `槽位名 = 取值`
       *   （英文槽位名）而断言用中文谓语'住在'"⇒ Jev 判"不支持"。
       *   这不是"Jev 不行"，而是**我们没把记号的含义说清**。
       *   ⇒ 第 2 轮把「槽位 = 取值」的含义写进 instructions（**只改表达，不改判据**）。
       *   ⚠️ 两轮证据都保留、各自归属（计划 §6.2：保留失败版本，不得用新轮覆盖旧轮）。
       */
      instructions:
        '「可采信证据」里形如「槽位 = 取值」或「记忆：槽位 = 取值」的行，' +
        '表示**该槽位当前的可采信取值就是等号右边那个值**。' +
        '如果这条主张指向同一个槽位、并且点出的取值与证据里的取值相同，就算被支持。' +
        `待判主张：${assertion}`,
      criteria: { true: '证据与这条主张一致（同槽位、同取值）', false: '证据与主张冲突，或证据不足以裁定' },
    }
  })
  const startedAt = Date.now()
  const result = await callSystemOne(
    { state: `可采信证据：${item.evidence}`, questions },
    { config: { ok: true, apiKey: jevKey, model: jevModel } }
  )
  const jevLatency = Date.now() - startedAt
  if (!result.ok) {
    return {
      ...extraction,
      outcome: result.family,
      code: result.code,
      jevCalls: result.attempts,
      derivedRelation: null,
      latencyMs: extraction.latencyMs + jevLatency,
      jevInputTokens: null,
    }
  }
  const noulValues = Object.values(result.answers).map((answer) => (answer.type === 'noul' ? answer.noul : 0))
  const allSupported = noulValues.length > 0 && noulValues.every((value) => value >= 0.5)
  const supportedCount = noulValues.filter((value) => value >= 0.5).length
  return {
    ...extraction,
    unsupportedCount: noulValues.length - supportedCount,
    derivedRelation: allSupported ? 'supports' : 'insufficient',
    jevCalls: result.attempts,
    jevInputTokens: result.usage?.inputTokens ?? null,
    latencyMs: extraction.latencyMs + jevLatency,
  }
}

/* ===========================================================================
 *  主流程
 * =========================================================================== */

const head = ((): string => {
  try {
    const raw = readFileSync(join(ROOT, '.git', 'HEAD'), 'utf8').trim()
    return raw.startsWith('ref: ') ? readFileSync(join(ROOT, '.git', raw.slice(5).trim()), 'utf8').trim() : raw
  } catch {
    return 'unknown'
  }
})()

const runId = OUT_NAME ?? `m9.6-audit-${SPLIT}-r${ROUND}-${head.slice(0, 8)}-${new Date().toISOString().replace(/[:.]/g, '-')}`
const runDir = join(ROOT, 'artifacts', 'm9.6', 'audit-compare', runId)

console.log(`M9.6 WP4a 审计探索 · split=${SPLIT} · round=${ROUND} · ${String(corpus.length)} 例 · 层 ${LAYER_INPUT.join('+')}`)
console.log(`  语料 ${String(validation.counts.total)} 条 · 指纹 ${FINGERPRINT.slice(0, 16)} · 并发 1`)
console.log(`  ① 关系判定：J = Jev · B = 同题 LLM`)
console.log(`  ② 整段审计：A = 修复后的 @2 审计链 · JC = [@2 提取] × [Jev 判支持]（组合方案，单独登记）\n`)

const rows: Record<string, unknown>[] = []
const layer1: Record<'J' | 'B', Layer1Reading[]> = { J: [], B: [] }
const layer2: Record<'A' | 'JC', Layer2Reading[]> = { A: [], JC: [] }
let jevCalls = 0
let jevInputTokens = 0
let jevUsageUnknown = 0

for (const [index, item] of corpus.entries()) {
  const caseRow: Record<string, unknown> = {
    caseId: item.caseId,
    split: item.split,
    expectedRelation: item.expected.relation,
    keyClaimCount: item.expected.keyClaims.length,
    reply: item.reply,
    claim: item.claim,
    evidence: item.evidence,
  }

  if (LAYERS.one) {
    const readingJ = await layer1Jev(item)
    const readingB = await layer1Llm(item)
    layer1.J.push(readingJ)
    layer1.B.push(readingB)
    if (readingJ.inputTokens !== null) {
      jevInputTokens += readingJ.inputTokens
      jevCalls += 1
    } else if (readingJ.outcome === 'measured') {
      jevUsageUnknown += 1
    }
    caseRow.layer1 = { J: readingJ, B: readingB }
  }

  if (LAYERS.two) {
    const { reading: chainReading, verdict } = await runAuditChain(item)
    const combinedReading = await runCombined(item, chainReading)
    layer2.A.push(chainReading)
    layer2.JC.push(combinedReading)
    jevCalls += combinedReading.jevCalls
    if (combinedReading.jevInputTokens !== null) jevInputTokens += combinedReading.jevInputTokens
    caseRow.layer2 = { A: chainReading, JC: combinedReading, judgeVerdict: verdict }
  }

  rows.push(caseRow)
  const l1 = caseRow.layer1 as { J: Layer1Reading; B: Layer1Reading } | undefined
  const l2 = caseRow.layer2 as { A: Layer2Reading; JC: Layer2Reading } | undefined
  process.stdout.write(
    `  [${String(index + 1).padStart(3)}/${String(corpus.length)}] ${String(item.caseId)} gold=${item.expected.relation.padEnd(13)}` +
      (l1 === undefined ? '' : ` J=${String(l1.J.relation ?? l1.J.code).padEnd(13)} B=${String(l1.B.relation ?? l1.B.code).padEnd(13)}`) +
      (l2 === undefined
        ? ''
        : ` | 链:断言${String(l2.A.assertions.length)} 覆盖${String(l2.A.coveredKeyClaims)}/${String(item.expected.keyClaims.length)} crit${String(l2.A.criticalErrors)}`) +
      '\n'
  )
}

/* ===========================================================================
 *  度量
 * =========================================================================== */

function layer1Metrics(arm: 'J' | 'B'): Record<string, unknown> {
  const readings = layer1[arm]
  if (readings.length === 0) return { notRun: true }
  const labeled: LabeledCase[] = readings.map((reading, index) => ({
    predicted: reading.relation ?? '(未测量)',
    gold: (corpus[index] as AuditCase).expected.relation,
  }))
  const overall = accuracy(labeled)
  const perRelation: Record<string, unknown> = {}
  for (const relation of AUDIT_RELATIONS) {
    const subset = labeled.filter((entry) => entry.gold === relation)
    const hits = subset.filter((entry) => entry.predicted === relation).length
    perRelation[relation] = {
      recall: ratio(hits, subset.length),
      /** ★ 计划 §6.3 要求「同时报告各类召回与**区间**」—— 区间按 **case** 算（Wilson） */
      recallInterval95: wilsonInterval(hits, subset.length),
      predictedAsThis: labeled.filter((entry) => entry.predicted === relation).length,
    }
  }
  /*
   * ★ 计划 §6.3 的 G8 条件之一：「**no_assertion 全部正确**」。
   *   这一条是**布尔**判据（不是比率），必须单独给出来，不能被"总体准确率"吸收掉。
   */
  const noAssertionRows = labeled.filter((entry) => entry.gold === 'no_assertion')
  const noAssertionAllCorrect =
    noAssertionRows.length > 0 && noAssertionRows.every((entry) => entry.predicted === 'no_assertion')
  const totalHits = labeled.filter((entry) => entry.predicted === entry.gold).length
  const measured = readings.filter((reading) => reading.outcome === 'measured').length
  const latencies = readings.filter((reading) => reading.outcome === 'measured').map((reading) => reading.latencyMs).sort((a, b) => a - b)
  return {
    notRun: false,
    accuracyOverAllCases: overall,
    /** ★ 总体准确率的 95% Wilson 区间（按 case） */
    accuracyInterval95: wilsonInterval(totalHits, labeled.length),
    /** ★ G8 的布尔条件之一：`no_assertion` 是否**全部**正确 */
    noAssertionAllCorrect,
    noAssertionCases: noAssertionRows.length,
    completionRate: ratio(measured, readings.length),
    perRelation,
    latencyMedianMs: latencies.length === 0 ? null : (latencies[Math.floor(latencies.length / 2)] as number),
    invalidOrUnavailable: readings.filter((reading) => reading.outcome !== 'measured').map((reading) => reading.code),
  }
}

function layer2Metrics(arm: 'A' | 'JC'): Record<string, unknown> {
  const readings = layer2[arm]
  if (readings.length === 0) return { notRun: true }
  const totalKeyClaims = corpus.reduce((sum, item) => sum + item.expected.keyClaims.length, 0)
  const coveredKeyClaims = readings.reduce((sum, reading) => sum + reading.coveredKeyClaims, 0)
  const fullExtractionCases = readings.filter(
    (reading, index) => reading.coveredKeyClaims === (corpus[index] as AuditCase).expected.keyClaims.length
  ).length
  /* ★ no_assertion 假阳性：这类回复**不含**具体取值，链却抽出了断言 ⇒ 假阳性 */
  const noAssertionCases = corpus
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.expected.relation === 'no_assertion')
  const falsePositives = noAssertionCases.filter(({ index }) => (readings[index]?.assertions.length ?? 0) > 0).length
  const criticalErrors = readings.reduce((sum, reading) => sum + reading.criticalErrors, 0)
  /* derived relation 只能表达三类 ⇒ 只在"金标不是 contradicts"的子集上算准确率，避免把表达力上限记成错误 */
  const nonContradicts = corpus
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.expected.relation !== 'contradicts')
  const derivableCorrect = nonContradicts.filter(({ item, index }) => readings[index]?.derivedRelation === item.expected.relation).length
  const latencies = readings.map((reading) => reading.latencyMs).sort((a, b) => a - b)
  return {
    notRun: false,
    extraction: {
      totalKeyClaims,
      coveredKeyClaims,
      coverageRate: ratio(coveredKeyClaims, totalKeyClaims),
      fullExtractionCases,
      caseCount: readings.length,
    },
    noAssertionFalsePositives: { count: falsePositives, of: noAssertionCases.length },
    criticalErrors,
    derivedRelation: {
      evaluableCases: nonContradicts.length,
      correct: derivableCorrect,
      accuracy: ratio(derivableCorrect, nonContradicts.length),
      note: '⚠️ 链**表达不出** contradicts ⇒ 只在金标 ≠ contradicts 的子集上算，避免把表达能力上限记成模型错误',
    },
    latencyMedianMs: latencies.length === 0 ? null : (latencies[Math.floor(latencies.length / 2)] as number),
    jevCalls: readings.reduce((sum, reading) => sum + reading.jevCalls, 0),
  }
}

const metrics = {
  layer1: { J: layer1Metrics('J'), B: layer1Metrics('B') },
  layer2: { A: layer2Metrics('A'), JC: layer2Metrics('JC') },
}

const manifest = {
  schemaVersion: 'm9.6-audit-compare-manifest@1',
  module: 'offline-fact-audit',
  split: SPLIT,
  round: ROUND,
  runId,
  head,
  note:
    '两层对照（计划 §6.3）。第一层只吃「主张 + 证据」；第二层只吃「回复 + 证据」，' +
    '金标主张**只用于评分**，绝不喂给提取器。组合方案 JC = [@2 提取] × [Jev 判支持]，两段调用分别计数。',
  layers: { one: LAYERS.one, two: LAYERS.two },
  corpus: { file: 'evals/m9.6/audit-corpus.ts', fingerprint: FINGERPRINT, total: validation.counts.total, used: corpus.length, counts: validation.counts },
  arms: {
    layer1: { J: 'Jev 官方 API（Choice）', B: `同题 LLM（${openAiSmallModel}）` },
    layer2: { A: 'm9.5-live-judge-llm@2（WP0a 修复后的审计链）', JC: '[ @2 提取 ] × [ Jev 判支持 ]（组合方案）' },
  },
  limits: { totalDeadlineMs: TOTAL_DEADLINE_MS, concurrency: 1 },
  combinedAdaptation: COMBINED_ADAPTATION,
  layer1Adaptation: 'v1-fixed（第一层两轮未改，读数可直接跨轮比较）',
  humanReview:
    '⚠️ 人审强度 = 用户 2026-09-29 裁定「抽查一部分、其余信任」；**不满足**计划 §6.1 的逐条人审强度。',
  invocation: {
    command: `pnpm m9.6:audit-compare -- --split ${SPLIT} --round ${ROUND} --layers ${LAYER_INPUT.join('')}`,
    limit: LIMIT,
  },
}

mkdirSync(runDir, { recursive: true })

/* 入库预测**去掉**正文（契约 §13：只留合成 case 引用、标签与计数） */
const bareRows = rows.map((row) => {
  const { reply: _reply, claim: _claim, evidence: _evidence, ...rest } = row
  return rest
})
const localDir = join(ROOT, 'artifacts', 'm9.6', 'local', `audit-${runId}`)
mkdirSync(localDir, { recursive: true })
assertPathIgnored(join(localDir, 'predictions-full.jsonl'))

function safeWrite(path: string, text: string, label: string): void {
  assertNoSecret(text, label)
  writeFileSync(path, text, 'utf8')
}

safeWrite(join(runDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'manifest.json')
safeWrite(join(runDir, 'predictions.jsonl'), `${bareRows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'predictions.jsonl')
/* ---- G8 条件（计划 §6.3）逐条落盘；**最差 run** 的规则写在 note 里 ---- */
const layer1Entry = (arm: 'J' | 'B'): { notRun?: boolean; accuracyOverAllCases?: { value: number | null }; noAssertionAllCorrect?: boolean } =>
  metrics.layer1[arm] as { notRun?: boolean; accuracyOverAllCases?: { value: number | null }; noAssertionAllCorrect?: boolean }
const layer2Entry = (arm: 'A' | 'JC'): { notRun?: boolean; criticalErrors?: number } =>
  metrics.layer2[arm] as { notRun?: boolean; criticalErrors?: number }
const RELATION_ACCURACY_THRESHOLD = 0.9

/** 本 run 里**没满足**的 G8 条件（空数组 = 本 run 满足；`test` 的判定取三轮最差） */
const failedG8Conditions: string[] = []
if (LAYERS.one) {
  for (const arm of ['J', 'B'] as const) {
    const entry = layer1Entry(arm)
    if (entry.notRun === true) {
      failedG8Conditions.push(`① ${arm} 未跑`)
      continue
    }
    if ((entry.accuracyOverAllCases?.value ?? -1) < RELATION_ACCURACY_THRESHOLD) {
      failedG8Conditions.push(`① ${arm} 关系准确率 < ${String(RELATION_ACCURACY_THRESHOLD)}`)
    }
    if (entry.noAssertionAllCorrect !== true) failedG8Conditions.push(`① ${arm} 的 no_assertion 未全对`)
  }
}
if (LAYERS.two && (layer2Entry('JC').criticalErrors ?? 0) < (layer2Entry('A').criticalErrors ?? 0)) {
  failedG8Conditions.push('② 候选链的关键错误检出数低于原基线')
}

const g8Conditions = {
  source: '计划 §6.3',
  relationAccuracyThreshold: RELATION_ACCURACY_THRESHOLD,
  layer1: {
    J: {
      accuracy: layer1Entry('J').accuracyOverAllCases?.value ?? null,
      atLeastThreshold: (layer1Entry('J').accuracyOverAllCases?.value ?? -1) >= RELATION_ACCURACY_THRESHOLD,
      noAssertionAllCorrect: layer1Entry('J').noAssertionAllCorrect ?? null,
    },
    B: {
      accuracy: layer1Entry('B').accuracyOverAllCases?.value ?? null,
      atLeastThreshold: (layer1Entry('B').accuracyOverAllCases?.value ?? -1) >= RELATION_ACCURACY_THRESHOLD,
      noAssertionAllCorrect: layer1Entry('B').noAssertionAllCorrect ?? null,
    },
  },
  /* 「关键错误检出数不低于原基线」：原基线 = 修复后的链（A） */
  criticalErrors: {
    baselineA: layer2Entry('A').criticalErrors ?? null,
    candidateJC: layer2Entry('JC').criticalErrors ?? null,
    notBelowBaseline:
      layer2Entry('A').criticalErrors === undefined || layer2Entry('JC').criticalErrors === undefined
        ? null
        : (layer2Entry('JC').criticalErrors ?? 0) >= (layer2Entry('A').criticalErrors ?? 0),
  },
  protocolNegativeControls: '由 `pnpm m9.6:audit-parser:verify` 离线证明：17 个失败码全触达 + 正控/负控/恢复三段式 + 真实出站 0',
  worstRunRule: 'G8 取 **test 三轮的最差 run**；单轮读数**不构成** G8 判定，也不得据此宣布采用',
  satisfied: null as boolean | null,
}
g8Conditions.satisfied =
  SPLIT === 'test' && failedG8Conditions.length === 0 ? true : SPLIT === 'test' ? false : null

safeWrite(
  join(runDir, 'metrics.json'),
  `${JSON.stringify(
    {
      schemaVersion: 'm9.6-audit-compare-metrics@1',
      metrics,
      g8Conditions,
      jev: { calls: jevCalls, inputTokens: jevInputTokens, usageUnknown: jevUsageUnknown, estimatedCostUsd: estimateCostUsd(jevInputTokens === 0 ? null : { inputTokens: jevInputTokens, outputTokens: 0 }) },
    },
    null,
    2
  )}\n`,
  'metrics.json'
)
safeWrite(join(localDir, 'predictions-full.jsonl'), `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'local/predictions-full.jsonl')

/* ---- 上屏 ---- */
console.log(`\n${'='.repeat(78)}\n度量\n${'='.repeat(78)}`)
if (LAYERS.one) {
  for (const arm of ['J', 'B'] as const) {
    const entry = metrics.layer1[arm] as Record<string, unknown>
    if (entry.notRun === true) {
      console.log(`  ① ${arm}: NOT RUN`)
      continue
    }
    const per = entry.perRelation as Record<string, { recall: { value: number | null; notRun: boolean } }>
    const interval = entry.accuracyInterval95 as { low: number; high: number } | null
    console.log(
      `  ① ${arm}: 关系准确率 ${describeMetric(entry.accuracyOverAllCases as Metric)}` +
        (interval === null ? '' : ` 95%CI [${interval.low.toFixed(3)}, ${interval.high.toFixed(3)}]`) +
        ` · 完成率 ${describeMetric(entry.completionRate as Metric)}` +
        ` · no_assertion 召回 ${describeMetric(per.no_assertion?.recall as Metric)}` +
        ` · **no_assertion 全对** ${
          entry.noAssertionCases === 0 ? 'NOT RUN（本拆分层无该类案例）' : entry.noAssertionAllCorrect === true ? '是' : '否'
        }` +
        ` · 延迟 median ${String(entry.latencyMedianMs)}ms`
    )
  }
}
if (LAYERS.two) {
  for (const arm of ['A', 'JC'] as const) {
    const entry = metrics.layer2[arm] as Record<string, unknown>
    if (entry.notRun === true) {
      console.log(`  ② ${arm}: NOT RUN`)
      continue
    }
    const extraction = entry.extraction as { coveredKeyClaims: number; totalKeyClaims: number; fullExtractionCases: number; caseCount: number }
    const fp = entry.noAssertionFalsePositives as { count: number; of: number }
    const derived = entry.derivedRelation as { correct: number; evaluableCases: number; accuracy: { value: number | null; notRun: boolean } }
    console.log(
      `  ② ${arm}: 提取覆盖 ${String(extraction.coveredKeyClaims)}/${String(extraction.totalKeyClaims)}` +
        ` · 全提取案例 ${String(extraction.fullExtractionCases)}/${String(extraction.caseCount)}` +
        ` · no_assertion 假阳性 ${String(fp.count)}/${String(fp.of)} · 关键错误 ${String(entry.criticalErrors)}` +
        ` · 可表达子集准确率 ${describeMetric(derived.accuracy as Metric)}`
    )
  }
}
console.log(`\n  Jev 调用 ${String(jevCalls)} 次 · input token ${String(jevInputTokens)}${jevUsageUnknown === 0 ? '' : ` · ${String(jevUsageUnknown)} 条 usage UNKNOWN`}`)
console.log(`  证据：artifacts/m9.6/audit-compare/${runId}/（正文另存 artifacts/m9.6/local/audit-${runId}/）`)
console.log('  ⚠️ 本轮只跑 dev/val ⇒ 计划的 G8 条件是 **test 最差 run**，本读数不构成 G8 判定。')
