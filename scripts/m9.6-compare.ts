/**
 * M9.6 WP4（**单模块 dev 试点**）—— 搜索需求判定 **A / B / J 三列对照**。
 *
 * ```bash
 * pnpm m9.6:compare -- --split dev --round 1 [--limit N] [--out <runId>]
 * ```
 *
 * ============================================================================
 *  三列是什么（契约 §4）
 * ============================================================================
 * ```text
 * A = 现行判定器（`createOpenAiSearchNeedJudge`，走 `.env.test` 测试端点）⇒ 唯一可用于 G3/G6 的基线
 * B = **同一组 System One 问题**交给普通 LLM（控制"任务表达差异"）· 返回值过**同一把**严格尺
 * J = Jev 官方 API
 * 三列看到**同一条用户发言**与**同一组问题**；调用预算、期限、并发（1）一致。
 * ```
 * ⚠️ **初始网络并发 1**（计划 §9）：串行，不用高频请求制造官方限流。
 * ⚠️ 本试点**只跑 dev**；val/test 必须在 dev 冻结后另行准备（计划 §6.2）。
 * ⚠️ 本试点的人审强度是"用户抽查 + 其余信任"（用户 2026-09-29 裁定），
 *    **不满足**计划 §6.1 的逐条人审强度 —— 报告里如实登记。
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'

import {
  JEV_MODEL_VAR,
  JEV_TEST_KEY_VAR,
  TOTAL_DEADLINE_MS,
  callSystemOne,
  estimateCostUsd,
  normalizeAnswers,
  redactSecrets,
  type JevAnswer,
  type JevQuestions,
} from './m9.6-jev-protocol.ts'
import { buildCandidateCriteria, buildCandidates, candidateIdToSpan, NO_CANDIDATE_OPTION, MAX_CANDIDATES, DEFAULT_CANDIDATE_STRATEGY, type CandidateSet, type CandidateStrategy } from './m9.6-candidates.ts'
import { SEARCH_NEED_JUDGE_MAX_TOKENS } from '../src/kernel/action/search-need-judge.ts'
import {
  SEARCH_DEV_CORPUS,
  SEARCH_DEV_REASONS,
  corpusFingerprint,
  validateCorpus,
  type SearchNeedDecision,
  type SearchNeedReason,
} from '../evals/m9.6/search-need-corpus.ts'
import { SEARCH_EXPERIMENT_CORPORA, experimentFingerprint, experimentGoldSpan as goldSpanOf, validateHeldout, type SearchExperimentCase as SearchDevCase } from '../evals/m9.6/search-heldout.ts'
import {
  accuracy,
  accountOutcomes,
  describeMetric,
  pairedBootstrapDiff,
  ratio,
  type CaseOutcome,
  type LabeledCase,
  type Metric,
  type OutcomeCase,
} from './m9.6-stats.ts'

const ROOT = resolve('.')

/* ===========================================================================
 *  两条写盘纪律（都在**写之前**失败关闭）
 * ========================================================================= */

/** ① 任何要落盘的文本里**不得**出现已知秘密 —— 出现即拒写（不是"警告一下"） */
function assertNoSecret(text: string, label: string): void {
  const leaked = SECRETS.filter((secret) => secret.length >= 8 && text.includes(secret))
  if (leaked.length > 0) {
    console.error(`REFUSED：${label} 里出现了秘密（${String(leaked.length)} 处）⇒ 拒写。`)
    process.exit(3)
  }
}

/**
 * ② 含**语料正文**的材料只能写进 `artifacts/m9.6/local/`，且必须先被 git 忽略。
 *    仓库约定（.gitignore 的 m9/m9.1/m9.5 同形）：写正文前跑 `git check-ignore`，不过即拒写。
 */
function assertPathIgnored(path: string): void {
  try {
    execFileSync('git', ['check-ignore', path], { cwd: ROOT, stdio: 'ignore' })
  } catch {
    console.error(`REFUSED：${path} 未被 git 忽略 ⇒ 拒绝把语料正文写进仓库。请先补 .gitignore。`)
    process.exit(3)
  }
}

function safeWrite(path: string, text: string, label: string): void {
  assertNoSecret(text, label)
  writeFileSync(path, text, 'utf8')
}

/* ===========================================================================
 *  参数与配置
 * =========================================================================== */

function arg(name: string, fallback: string | null = null): string | null {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && index + 1 < process.argv.length ? (process.argv[index + 1] as string) : fallback
}

const SPLIT = arg('split', 'dev')
const ROUND = arg('round', '1')
const LIMIT = arg('limit') === null ? null : Number(arg('limit'))
const OUT_NAME = arg('out')

/** 候选策略（dev 两轮各跑一次；**显式**记录进 manifest，不靠隐含默认值） */
const STRATEGY_INPUT = arg('candidate-strategy', DEFAULT_CANDIDATE_STRATEGY)
if (STRATEGY_INPUT !== 'v1-length-asc' && STRATEGY_INPUT !== 'v2-boundary-anchored') {
  console.error(`REFUSED：未知的 --candidate-strategy ${String(STRATEGY_INPUT)}`)
  process.exit(2)
}
const STRATEGY: CandidateStrategy = STRATEGY_INPUT

/**
 * 候选**上限**（契约 §6.1 冻结值 12）。dev 第 2 轮修订：离线扫描（零出站）显示
 * 上限 48 时金标覆盖从 24/30 升到 **30/30**，而**调用次数不变**、只是每次请求多约 215 个单元的候选文本。
 * ⚠️ 改动它 = 改契约冻结参数 ⇒ 必须登记为 dev 修订轮，且 **test 必须使用新值**。
 */
const MAX_CANDIDATES_INPUT = arg('max-candidates') === null ? MAX_CANDIDATES : Number(arg('max-candidates'))
if (!Number.isInteger(MAX_CANDIDATES_INPUT) || MAX_CANDIDATES_INPUT < 1 || MAX_CANDIDATES_INPUT > 255) {
  console.error(`REFUSED：--max-candidates 必须是 1..255 的整数（官方 Choice 上限 255），收到 ${String(arg('max-candidates'))}`)
  process.exit(2)
}

if (SPLIT !== 'dev' && SPLIT !== 'val' && SPLIT !== 'test') {
  console.error(`REFUSED：本试点只跑 dev（收到 --split ${SPLIT ?? '(空)'}）。val/test 必须在 dev 冻结后另行准备。`)
  process.exit(2)
}

/**
 * ⚠️ 与 `scripts/m9.6-preflight.ts` 里的同名函数是**同一套纪律**（显式读 `.env.test`、
 *    不继承生产变量、不回落 `OPENAI_API_KEY`）。两处各自独立，是因为每个门都要求
 *    "自己的凭据来源可单独复核"；**不是**共享可信来源。
 */
function readTestEnvFile(path: string): Record<string, string> {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    console.error(`REFUSED：找不到 ${path}（A/B 列需要测试端点，Jev 需要具名变量）`)
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

const TEST_ENV = readTestEnvFile(join(ROOT, '.env.test'))
const jevKey = (TEST_ENV[JEV_TEST_KEY_VAR] ?? '').trim()
const jevModel = (TEST_ENV[JEV_MODEL_VAR] ?? '').trim()
const openAiKey = (TEST_ENV.OPENAI_API_KEY ?? '').trim()
const openAiBaseUrl = (TEST_ENV.OPENAI_BASE_URL ?? '').trim()
const openAiSmallModel = (TEST_ENV.OPENAI_SMALL_MODEL ?? '').trim()

/** 离线模式：只量候选覆盖率，**零出站** ⇒ 不需要任何凭据 */
const COVERAGE_ONLY = process.argv.includes('--coverage-only')

if (!COVERAGE_ONLY && (jevKey === '' || jevModel === '')) {
  console.error(`REFUSED：${JEV_TEST_KEY_VAR} / ${JEV_MODEL_VAR} 未配置 ⇒ Jev 列不可跑，**不回落** OPENAI_API_KEY`)
  process.exit(2)
}
if (!COVERAGE_ONLY && (openAiKey === '' || openAiBaseUrl === '')) {
  console.error('REFUSED：A/B 列需要 `.env.test` 里的 OPENAI_API_KEY / OPENAI_BASE_URL（否则基线不可测）')
  process.exit(2)
}

const SECRETS = [jevKey, openAiKey]

/* ===========================================================================
 *  问题构造（J 与 B 用**同一组**问题）
 * =========================================================================== */

const DECISION_CRITERIA: Record<string, string | null> = {
  search: '需要外部公开资料才能回答：时效性事实、最新消息，或用户明确要求查公开资料，且检索对象公开可检索',
  answer: '不需要联网：常识、闲聊、创作、翻译、代码，或对象的归属在用户自己身上（我的笔记/余额/日程/文件）',
  clarify: '用户想查点什么，但完全没有可检索的对象 —— 连"要查什么"都定不下来',
  deny_search: '用户明确禁止联网，或明确要求只根据已有知识回答',
}

const REASON_CRITERIA: Record<string, string | null> = {
  time_sensitive_fact: '需要随时间变化的时效性事实',
  latest_news: '最新消息/新闻',
  explicit_public_sourcing: '用户明确要求查公开资料',
  stable_knowledge: '稳定常识，无需查证',
  chitchat_or_creative: '闲聊或创作',
  private_object: '对象属于用户自己或私人内容',
  negated_or_forbidden: '明确禁止联网',
  quoted_or_metalinguistic: '引用他人的话，或在讨论字句本身',
  self_reported: '用户自述的内容',
  missing_subject: '没有可检索的对象',
  ambiguous_scope: '检索范围不清',
  local_action_preferred: '更适合本地动作',
  adversarial_input: '对抗输入或注入尝试',
}

const DECISION_INSTRUCTIONS = [
  '判断这条用户发言是否**需要联网查证**。',
  '要点：能发起检索（对象公开可检索）就选 search —— 缺线路/日期/城市只影响答案精确度，不影响该不该先查。',
  '引号里的字句本身不是检索对象；只有问"出处/来源"时才算 search。',
  '对象在用户自己身上，或用户明确禁止联网，一律不得选 search。',
].join('\n')

function buildQuestions(text: string, candidates: CandidateSet): JevQuestions {
  return {
    decision: { type: 'choice', instructions: DECISION_INSTRUCTIONS, criteria: DECISION_CRITERIA },
    reason: {
      type: 'choice',
      instructions: '给出上一步结论的最贴近理由。',
      criteria: REASON_CRITERIA,
    },
    query: {
      type: 'choice',
      instructions:
        '如果上一步是 search，选出**最适合拿去检索**的片段（只含检索对象，不含称谓、其它分句或私人内容）；' +
        '否则选“没有/不确定”。',
      criteria: buildCandidateCriteria(candidates),
    },
  }
}

/* ===========================================================================
 *  三列各自的执行与归一
 * =========================================================================== */

type ArmOutcome = CaseOutcome
type ArmName = 'A' | 'B' | 'J'

interface ArmReading {
  readonly outcome: ArmOutcome
  readonly decision: SearchNeedDecision | null
  readonly reason: SearchNeedReason | null
  readonly span: { readonly start: number; readonly end: number } | null
  /** 提案是否**可进入有效提案**（B 层契约）；未测量时为 false */
  readonly proposalValid: boolean
  readonly code: string | null
  /** 诊断用（**已脱敏**）；数值型如"概率和 ≠ 1"的实测值 */
  readonly detail: string | null
  readonly latencyMs: number
  readonly inputTokens: number | null
  readonly outputTokens: number | null
  readonly requestCount: number
}

const measured = (partial: Omit<ArmReading, 'outcome' | 'detail'>): ArmReading => ({ outcome: 'measured', detail: null, ...partial })
const notMeasured = (
  outcome: ArmOutcome,
  code: string,
  latencyMs: number,
  requestCount: number,
  detail: string | null = null
): ArmReading => ({
  outcome,
  decision: null,
  reason: null,
  span: null,
  proposalValid: false,
  code,
  detail,
  latencyMs,
  inputTokens: null,
  outputTokens: null,
  requestCount,
})

/** 把三列共同的 `answers` 形状映射成提案（J 与 B 共用 ⇒ 契约判定完全一致） */
function proposalFromAnswers(
  answers: Readonly<Record<string, JevAnswer>>,
  text: string,
  candidates: ReturnType<typeof buildCandidates>,
  latencyMs: number,
  usage: { readonly inputTokens: number; readonly outputTokens: number } | null,
  requestCount: number
): ArmReading {
  const decisionAnswer = answers.decision
  const reasonAnswer = answers.reason
  const queryAnswer = answers.query
  if (decisionAnswer?.type !== 'choice' || decisionAnswer.choice === null) {
    return notMeasured('invalid_output', 'decision_missing', latencyMs, requestCount)
  }
  if (reasonAnswer?.type !== 'choice' || reasonAnswer.choice === null) {
    return notMeasured('invalid_output', 'reason_missing', latencyMs, requestCount)
  }
  const decision = decisionAnswer.choice as SearchNeedDecision
  const reason = reasonAnswer.choice as SearchNeedReason

  /* querySpan 只能经**候选 ID → 程序还原**得到（计划 §5：不让模型猜字符位置） */
  let span: { readonly start: number; readonly end: number } | null = null
  if (queryAnswer?.type === 'choice' && queryAnswer.choice !== null && queryAnswer.choice !== NO_CANDIDATE_OPTION) {
    const resolved = candidateIdToSpan(queryAnswer.choice, candidates, text)
    if (resolved.ok) span = resolved.span
  }

  /* B 层契约：decision=search 必须有**合法** querySpan，否则提案无效（G4） */
  const proposalValid = decision !== 'search' || span !== null
  return measured({
    decision,
    reason,
    span,
    proposalValid,
    code: proposalValid ? null : 'search_without_valid_span',
    latencyMs,
    inputTokens: usage?.inputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
    requestCount,
  })
}

/* ---- A 列：现行判定器 ---- */
async function runArmA(item: SearchDevCase): Promise<ArmReading> {
  const { createOpenAiSearchNeedJudge } = await import('../src/infrastructure/model/openai-search-need-judge.ts')
  let inputTokens: number | null = null
  let outputTokens: number | null = null
  const judge = createOpenAiSearchNeedJudge({ env: TEST_ENV, fetchImpl: async (input, init) => {
    const response = await globalThis.fetch(input, init)
    const originalJson = response.json.bind(response)
    Object.defineProperty(response, 'json', { value: async () => {
      const body = await originalJson() as { usage?: { prompt_tokens?: number; completion_tokens?: number } }
      inputTokens = typeof body.usage?.prompt_tokens === 'number' ? body.usage.prompt_tokens : null
      outputTokens = typeof body.usage?.completion_tokens === 'number' ? body.usage.completion_tokens : null
      return body
    } })
    return response
  } })
  const startedAt = Date.now()
  const outcome = await judge.judge({ text: item.request })
  const latencyMs = Date.now() - startedAt
  if (!outcome.ok) {
    const asUnavailable = outcome.failure === 'timeout' || outcome.failure === 'call_failed'
    return notMeasured(asUnavailable ? 'unavailable' : 'invalid_output', outcome.failure, latencyMs, outcome.requestCount, outcome.parseFailureCode ?? outcome.failure)
  }
  const proposal = outcome.proposal
  return measured({
    decision: proposal.decision,
    reason: proposal.reason,
    span: proposal.querySpan === undefined ? null : { start: proposal.querySpan.start, end: proposal.querySpan.end },
    proposalValid: proposal.decision !== 'search' || proposal.querySpan !== undefined,
    code: null,
    latencyMs,
    inputTokens,
    outputTokens,
    requestCount: outcome.requestCount,
  })
}

/* ---- B 列：同一组问题交给普通 LLM ---- */
async function runArmB(item: SearchDevCase, questions: JevQuestions, candidates: CandidateSet): Promise<ArmReading> {
  const startedAt = Date.now()
  const body = {
    model: openAiSmallModel === '' ? undefined : openAiSmallModel,
    temperature: 0,
    /*
     * ⚠️ **必须与 A 列同预算**：A（生产判定器）设了 `max_tokens = 2400`。
     *    B 最初没设 ⇒ 推理模型把 token 花在思维链上 ⇒ 4/6 撞 19s 超时。
     *    这是**量具缺陷**，不是"B 这个方法不行"—— 两边预算不等就无法比较。
     */
    max_tokens: SEARCH_NEED_JUDGE_MAX_TOKENS,
    messages: [
      {
        role: 'system',
        content: [
          '你要回答一组**判定问题**。只输出一个 JSON 对象，不要解释、不要代码块围栏。',
          '输出形状：{"answers": {"<问题 id>": <该问题的答案对象>}}',
          '· choice 类问题的答案对象：{"type":"choice","choice":"<选项id>","probabilities":{"<选项id>":<数>},"confidence":<0..1>}',
          '· 概率必须**归一**（和为 1），只能使用该问题 criteria 里出现过的选项 id。',
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          `待判定的文本（state）：${item.request}`,
          `问题（questions）：${JSON.stringify(questions)}`,
        ].join('\n'),
      },
    ],
  }
  let requestCount = 0
  try {
    requestCount += 1
    const response = await fetch(`${openAiBaseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${openAiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TOTAL_DEADLINE_MS),
    })
    const latencyMs = Date.now() - startedAt
    if (!response.ok) {
      return notMeasured('unavailable', `http_${String(response.status)}`, latencyMs, requestCount, `HTTP ${String(response.status)}`)
    }
    const payload = (await response.json()) as { choices?: { message?: { content?: unknown } }[] }
    const content = payload.choices?.[0]?.message?.content
    if (typeof content !== 'string') return notMeasured('invalid_output', 'content_missing', latencyMs, requestCount, 'choices[0].message.content 不是字符串')
    let parsed: unknown
    try {
      parsed = JSON.parse(content) as unknown
    } catch {
      return notMeasured('invalid_output', 'not_json', latencyMs, requestCount, 'content 不是合法 JSON')
    }
    const answers = (parsed as { answers?: unknown } | null)?.answers
    /* ★ B 也过**同一把**严格尺；B 无独立版本号 ⇒ servedModel 取请求值并在证据里注明 */
    const normalized = normalizeAnswers(answers, questions, openAiSmallModel, openAiSmallModel, SECRETS, 1)
    if (!normalized.ok) return notMeasured(normalized.family, normalized.code, latencyMs, requestCount, normalized.detail)
    return proposalFromAnswers(normalized.answers, item.request, candidates, latencyMs, null, requestCount)
  } catch (error) {
    return notMeasured('unavailable', (error as Error).name, Date.now() - startedAt, requestCount, redactSecrets((error as Error).message.slice(0, 120), SECRETS))
  }
}

/* ---- J 列：Jev 官方 API ---- */
async function runArmJ(item: SearchDevCase, questions: JevQuestions, candidates: CandidateSet): Promise<ArmReading> {
  const startedAt = Date.now()
  const result = await callSystemOne(
    { state: item.request, questions },
    { config: { ok: true, apiKey: jevKey, model: jevModel } }
  )
  const latencyMs = Date.now() - startedAt
  if (!result.ok) return notMeasured(result.family, result.code, latencyMs, result.attempts, result.detail)
  return proposalFromAnswers(result.answers, item.request, candidates, latencyMs, result.usage, result.attempts)
}

/* ===========================================================================
 *  主流程
 * =========================================================================== */

validateHeldout()
const selectedCorpus = SEARCH_EXPERIMENT_CORPORA[SPLIT as 'dev' | 'val' | 'test']
const validation = validateCorpus()
if (!validation.ok) {
  console.error(`REFUSED：语料结构校验失败\n  - ${validation.problems.join('\n  - ')}`)
  process.exit(2)
}

/* `--coverage-only`：只量**候选表是否覆盖金标区间**，**零出站、零凭据需求** */
if (COVERAGE_ONLY) {
  const searchCases = SEARCH_DEV_CORPUS.filter((item) => item.expected.decision === 'search')
  console.log('M9.6 候选覆盖率对比（--coverage-only · 零出站）')
  console.log(`  语料 ${String(SEARCH_DEV_CORPUS.length)} 条 · 需要查询片段的 ${String(searchCases.length)} 条 · 指纹 ${corpusFingerprint().slice(0, 16)}\n`)
  const table: { strategy: CandidateStrategy; covered: number; avgCandidates: number; examples: string[] }[] = []
  for (const runningStrategy of ['v1-length-asc', 'v2-boundary-anchored'] as CandidateStrategy[]) {
    let covered = 0
    let totalCandidates = 0
    const examples: string[] = []
    for (const item of SEARCH_DEV_CORPUS) {
      const set = buildCandidates(item.request, { strategy: runningStrategy })
      totalCandidates += set.candidates.length
      const gold = goldSpanOf(item)
      if (gold === null) continue
      const hit = set.candidates.some((candidate) => candidate.start === gold.start && candidate.end === gold.end)
      if (hit) covered += 1
      else if (item.expected.decision === 'search' && examples.length < 3) {
        examples.push(`${item.caseId} 缺 [${String(gold.start)},${String(gold.end)})`)
      }
    }
    table.push({
      strategy: runningStrategy,
      covered,
      avgCandidates: totalCandidates / SEARCH_DEV_CORPUS.length,
      examples,
    })
  }
  for (const row of table) {
    console.log(
      `  ${row.strategy.padEnd(22)} 金标覆盖 ${String(row.covered)}/${String(searchCases.length)}` +
        ` · 平均候选数 ${row.avgCandidates.toFixed(2)}${row.examples.length === 0 ? '' : ` · 未覆盖例：${row.examples.join(' / ')}`}`
    )
  }
  const best = table.reduce((a, b) => (b.covered > a.covered ? b : a))
  console.log(`\n  最佳：${best.strategy}（覆盖 ${String(best.covered)}/${String(searchCases.length)}）`)

  /*
   * ★ **候选上限扫描**（零出站）：把"接受 LIMITED_FIT"与"加钱换覆盖"从口号变成**曲线**。
   *   候选数增加**不增加调用次数**，只增加每次请求的输入 token ⇒ 代价是线性的、可估的。
   *   ⚠️ 官方 Choice 上限 255 个选项；我们自设的上限远低于它。
   */
  console.log('\n  ★ 候选上限 vs 金标覆盖（v2 策略；**调用次数不变**，只变输入 token）')
  console.log('     上限   覆盖     平均候选文本长度(UTF-16 单元)')
  const caps = [12, 16, 24, 32, 48, 64, 96]
  const sweep: { cap: number; covered: number; avgTextUnits: number }[] = []
  for (const cap of caps) {
    let covered = 0
    let textUnits = 0
    for (const item of SEARCH_DEV_CORPUS) {
      const set = buildCandidates(item.request, { strategy: 'v2-boundary-anchored', maxCandidates: cap })
      textUnits += set.candidates.reduce((sum, candidate) => sum + candidate.text.length, 0)
      const gold = goldSpanOf(item)
      if (gold !== null && set.candidates.some((candidate) => candidate.start === gold.start && candidate.end === gold.end)) covered += 1
    }
    sweep.push({ cap, covered, avgTextUnits: textUnits / SEARCH_DEV_CORPUS.length })
    console.log(
      `     ${String(cap).padStart(4)}   ${String(covered).padStart(2)}/${String(searchCases.length)}    ${(textUnits / SEARCH_DEV_CORPUS.length).toFixed(1)}`
    )
  }
  const fullCap = sweep.find((entry) => entry.covered === searchCases.length)
  console.log(
    fullCap === undefined
      ? '     ⇒ **没有任何扫描到上限能让覆盖达到 100%**（说明缺的是「窗口族之外」的区间，不是名额不够）'
      : `     ⇒ 上限 ${String(fullCap.cap)} 时覆盖达到 100%（平均候选文本 ${fullCap.avgTextUnits.toFixed(1)} 单元）`
  )
  console.log('  ⚠️ 覆盖率 < 100% ⇒ 未覆盖的那些 case 里，**任何**只能选候选 ID 的方案都不可能命中金标区间；')
  console.log('     此时 span 精确率为 0 反映的是**候选表**，不是模型能力（计划 §5 的 LIMITED_FIT 形态）。')
  process.exit(0)
}

/* `--validate-only`：只校验语料与凭据存在性，**零出站** */
if (process.argv.includes('--validate-only')) {
  console.log('M9.6 语料校验（--validate-only · 零出站）')
  console.log(`  结构校验：通过（0 项问题）`)
  console.log(`  当前拆分 ${SPLIT} / ${selectedCorpus.length} 条；历史 dev 总数 ${String(validation.counts.total)} · 正例 ${String(validation.counts.positives)}（explicit ${String(validation.counts.explicitPositives)} / auto ${String(validation.counts.autoPositives)}）`)
  console.log(`  分层：${JSON.stringify(validation.counts.byStratum)}`)
  console.log(`  判定分布：${JSON.stringify(validation.counts.byDecision)}`)
  console.log(`  指纹：${corpusFingerprint()}`)
  console.log(`  凭据：${JEV_TEST_KEY_VAR} ${jevKey === '' ? '缺失' : '已配置'} · ${JEV_MODEL_VAR}=${jevModel} · 测试端点 ${openAiBaseUrl === '' ? '缺失' : '已配置'}`)
  process.exit(0)
}

const corpus = LIMIT === null ? selectedCorpus : selectedCorpus.slice(0, LIMIT)
const fingerprint = experimentFingerprint(selectedCorpus)
if (SPLIT !== 'dev' && (LIMIT !== null || MAX_CANDIDATES_INPUT !== 48 || STRATEGY !== 'v2-boundary-anchored')) throw new Error('heldout requires full split, cap48 and frozen v2 strategy')
const freezePaths = [
  'scripts/m9.6-compare.ts', 'scripts/m9.6-candidates.ts', 'scripts/m9.6-jev-protocol.ts',
  'scripts/m9.6-stats.ts', 'scripts/m9.6-followup-summary.ts', 'evals/m9.6/search-heldout.ts',
  'src/kernel/action/search-need-judge.ts', 'src/infrastructure/model/openai-search-need-judge.ts',
]
const freeze = {
  schemaVersion: 'm9.6-search-followup-freeze@1',
  files: Object.fromEntries(freezePaths.map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')])),
  models: { jev: jevModel, baseline: openAiSmallModel, baselineHost: new URL(openAiBaseUrl).host },
  cap: 48, strategy: 'v2-boundary-anchored', arms: 'AJ', deadlineMs: TOTAL_DEADLINE_MS,
  val: experimentFingerprint(SEARCH_EXPERIMENT_CORPORA.val), test: experimentFingerprint(SEARCH_EXPERIMENT_CORPORA.test),
  humanReview: 'sampling authorized; actual reviewer decisions pending; no claim of full human review',
}
const freezePath = join(ROOT, 'artifacts/m9.6/search-followup/freeze.json')
if (process.argv.includes('--freeze-only')) {
  mkdirSync(join(ROOT, 'artifacts/m9.6/search-followup'), { recursive: true })
  if (existsSync(freezePath)) throw new Error('freeze already exists; never overwrite')
  safeWrite(freezePath, JSON.stringify(freeze, null, 2) + '\n', 'freeze')
  console.log('Frozen val50/test150; zero outbound calls')
  process.exit(0)
}
if (SPLIT !== 'dev' && JSON.stringify(JSON.parse(readFileSync(freezePath, 'utf8'))) !== JSON.stringify(freeze)) throw new Error('freeze mismatch')

const head = ((): string => {
  try {
    const raw = readFileSync(join(ROOT, '.git', 'HEAD'), 'utf8').trim()
    return raw.startsWith('ref: ') ? readFileSync(join(ROOT, '.git', raw.slice(5).trim()), 'utf8').trim() : raw
  } catch {
    return 'unknown'
  }
})()

const runId = OUT_NAME ?? `m9.6-search-dev-r${ROUND}-${head.slice(0, 8)}-${new Date().toISOString().replace(/[:.]/g, '-')}`
const runDir = join(ROOT, 'artifacts', 'm9.6', 'compare', runId)
if (!/^[a-zA-Z0-9._-]+$/.test(runId) || runId === '.' || runId === '..') throw new Error('invalid run id')
if (existsSync(runDir)) throw new Error('run already exists; no overwrite')
mkdirSync(runDir, { recursive: true })
safeWrite(join(runDir, 'started.json'), JSON.stringify({split: SPLIT, round: ROUND, fingerprint, freeze, status: 'STARTED'}), 'started')

console.log(`M9.6 WP4 试点（搜索需求判定）· split=${SPLIT} · round=${ROUND} · ${String(corpus.length)} 例 · 并发 1`)
console.log(`  语料指纹 ${fingerprint.slice(0, 16)} · 语料：${String(validation.counts.total)} 条（正例 ${String(validation.counts.positives)}：explicit ${String(validation.counts.explicitPositives)} / auto ${String(validation.counts.autoPositives)}）`)
console.log(`  A = 现行判定器（测试端点）· B = 同题 LLM · J = Jev ${jevModel}`)
console.log(`  运行目录 artifacts/m9.6/compare/${runId}\n`)

const rows: Record<string, unknown>[] = []
const perArm: Record<ArmName, ArmReading[]> = { A: [], B: [], J: [] }
const totalUsage = { J: { input: 0, output: 0, known: 0, unknown: 0 } }

/*
 * ⚠️ **B 列在某些端点上跑不完**：实测该测试端点的模型在**同一组问题**上
 *    要么撞 20s 共享期限、要么回非 JSON（100 例跑完约需 75 分钟，且约 3/4 不可用）。
 *    计划 §6.2 对此有明确处置：**B 不可用 ⇒ 记 `NOT RUN`**，
 *    并且**不得**声称"表达差异已控制"。⇒ 用 `--arms` 显式选择跑哪几列。
 */
/*
 * ⚠️ 分隔符**不能假定**：`pnpm <script> -- --arms A,J` 会把逗号吃掉变成 `A J`。
 *    所以这里按**字符**取 A/B/J —— 逗号、空格、加号、连写都接受。
 */
const ARM_INPUT = (arg('arms', 'A,J') ?? 'A,J')
  .toUpperCase()
  .split('')
  .filter((char) => char === 'A' || char === 'B' || char === 'J')
const EXECUTED_ARMS = (['A', 'B', 'J'] as ArmName[]).filter((arm) => ARM_INPUT.includes(arm))
if (EXECUTED_ARMS.length === 0) {
  console.error(`REFUSED：--arms "${String(arg('arms'))}" 未选中任何列`)
  process.exit(2)
}

for (const [index, item] of corpus.entries()) {
  const candidates = buildCandidates(item.request, { strategy: STRATEGY, maxCandidates: MAX_CANDIDATES_INPUT })
  const questions = buildQuestions(item.request, candidates)
  const readingsThisCase: Partial<Record<ArmName, ArmReading>> = {}
  const callOrder = (index + Number(ROUND)) % 2 === 0 ? EXECUTED_ARMS : [...EXECUTED_ARMS].reverse()
  for (const arm of callOrder) {
    const reading =
      arm === 'A' ? await runArmA(item) : arm === 'B' ? await runArmB(item, questions, candidates) : await runArmJ(item, questions, candidates)
    readingsThisCase[arm] = reading
    perArm[arm].push(reading)
    if (reading.code === 'model_mismatch' || reading.code === 'http_error_unauthenticated') {
      safeWrite(join(runDir, 'aborted.json'), JSON.stringify({caseId: item.caseId, arm, reading}), 'aborted')
      throw new Error('provider identity failure; batch stopped')
    }
  }
  const readingJ = readingsThisCase.J
  if (readingJ !== undefined && readingJ.outcome === 'measured') {
    if (readingJ.inputTokens === null) totalUsage.J.unknown += 1
    else {
      totalUsage.J.input += readingJ.inputTokens
      totalUsage.J.output += readingJ.outputTokens ?? 0
      totalUsage.J.known += 1
    }
  }

  const gold = goldSpanOf(item)
  /*
   * ★ 计划 §5 逐字要求「**测量金标片段是否被候选覆盖**」。
   *   覆盖 = 程序候选表里存在与金标 **逐字同区间** 的那一项。
   *   若覆盖率为 0，则 B 层的 span 精确率**在数学上不可能**大于 0 ——
   *   那不是模型答错，是**候选表没给出那个选项**（计划 §5 的 `LIMITED_FIT` 形态）。
   */
  const goldCoveredByCandidates =
    gold !== null && candidates.candidates.some((candidate) => candidate.start === gold.start && candidate.end === gold.end)
  const armsOut: Partial<Record<ArmName, ArmReading>> = {}
  const correctOut: Partial<Record<ArmName, boolean>> = {}
  for (const arm of EXECUTED_ARMS) {
    const reading = readingsThisCase[arm]
    if (reading === undefined) continue
    armsOut[arm] = reading
    correctOut[arm] = reading.decision === item.expected.decision
  }
  rows.push({
    caseId: item.caseId,
    stratum: item.stratum,
    mode: item.mode,
    family: item.family ?? item.caseId,
    safety: item.safety ?? false,
    request: item.request,
    expected: { decision: item.expected.decision, reason: item.expected.reason, goldSpan: gold },
    candidateCount: candidates.candidates.length,
    goldCoveredByCandidates,
    arms: armsOut,
    correct: correctOut,
  })
  const { request: _checkpointText, ...checkpoint } = rows[rows.length - 1]
  const checkpointText = JSON.stringify(checkpoint) + '\n'
  assertNoSecret(checkpointText, 'checkpoint')
  appendFileSync(join(runDir, 'checkpoint.jsonl'), checkpointText)
  process.stdout.write(
    `  [${String(index + 1).padStart(3)}/${String(corpus.length)}] ${item.caseId} gold=${item.expected.decision.padEnd(11)} ` +
      EXECUTED_ARMS.map((arm) => {
        const reading = readingsThisCase[arm]
        return `${arm}=${String(reading?.decision ?? reading?.code).padEnd(11)}`
      }).join(' ') +
      ` ${String(readingJ?.latencyMs ?? 0)}ms\n`
  )
}

interface ArmMetrics {
  readonly mainReading: {
    readonly endToEndAccuracy: Metric
    readonly validOnlyAccuracy: Metric
    readonly outputValidRate: Metric
    readonly measured: number
    readonly invalidOutput: number
    readonly unavailable: number
    readonly endToEndDenominator: number
  }
  readonly singleLabelAccuracy: Metric
  readonly recall: { readonly explicit: Metric; readonly autoPublic: Metric; readonly overSearchFpr: Metric }
  readonly contract: {
    readonly searchCases: number
    readonly contractViolations: number
    readonly spanExactMatch: number
    /** ★ 金标区间是否**出现在候选表里**（计划 §5 要求的覆盖测量） */
    readonly goldCovered: number
    readonly goldCoverageRate: Metric
    /** 在**被覆盖**的子集里，span 是否逐字命中 */
    readonly spanExactGivenCovered: number
    readonly queryNoSelection: number
    readonly reasonAgreement: number
  }
  readonly latency: { readonly count: number; readonly medianMs: number | null; readonly p95Ms: number | null; readonly maxMs: number | null }
}

const NOT_RUN_METRIC: Metric = { numerator: 0, denominator: 0, value: null, notRun: true }

/* ---- 度量（每列独立；主分母 = 全部 case） ---- */
function armMetrics(arm: ArmName): ArmMetrics {
  const readings = perArm[arm]
  /* ⚠️ 该列**没跑** ⇒ 记 NOT RUN，**不是** 0（"没量"与"量到 0"必须分列） */
  if (readings.length === 0) {
    return {
      mainReading: {
        endToEndAccuracy: NOT_RUN_METRIC,
        validOnlyAccuracy: NOT_RUN_METRIC,
        outputValidRate: NOT_RUN_METRIC,
        measured: 0,
        invalidOutput: 0,
        unavailable: 0,
        endToEndDenominator: 0,
      },
      singleLabelAccuracy: NOT_RUN_METRIC,
      recall: { explicit: NOT_RUN_METRIC, autoPublic: NOT_RUN_METRIC, overSearchFpr: NOT_RUN_METRIC },
      contract: {
        searchCases: 0,
        contractViolations: 0,
        spanExactMatch: 0,
        goldCovered: 0,
        goldCoverageRate: NOT_RUN_METRIC,
        spanExactGivenCovered: 0,
        queryNoSelection: 0,
        reasonAgreement: 0,
      },
      latency: { count: 0, medianMs: null, p95Ms: null, maxMs: null },
    }
  }
  const cases: OutcomeCase[] = readings.map((reading, index) => ({
    outcome: reading.outcome,
    predictedCorrect: reading.decision === (corpus[index] as SearchDevCase).expected.decision,
  }))
  const accounting = accountOutcomes(cases)
  const labeled: LabeledCase[] = readings.map((reading, index) => ({
    predicted: reading.decision ?? '(未测量)',
    gold: (corpus[index] as SearchDevCase).expected.decision,
  }))
  const decisionAccuracy = accuracy(labeled)

  const expectedSearch = corpus.filter((item) => item.expected.decision === 'search')
  const indexOf = new Map(corpus.map((item, index) => [item.caseId, index]))
  const recallAmong = (subset: readonly SearchDevCase[]): ReturnType<typeof ratio> => {
    const hits = subset.filter((item) => {
      const index = indexOf.get(item.caseId) as number
      return readings[index]?.decision === 'search'
    }).length
    return ratio(hits, subset.length)
  }
  const explicitRecall = recallAmong(expectedSearch.filter((item) => item.mode === 'explicit'))
  const autoRecall = recallAmong(expectedSearch.filter((item) => item.mode === 'auto_public'))
  const nonSearch = corpus.filter((item) => item.expected.decision !== 'search')
  const overSearch = ratio(
    nonSearch.filter((item) => readings[indexOf.get(item.caseId) as number]?.decision === 'search').length,
    nonSearch.length
  )

  /* 契约（B 层）：只对 decision=search 的**已测量**读数判 span 合法性 */
  const searchReadings = readings.filter((reading, index) => (corpus[index] as SearchDevCase).expected.decision === 'search')
  const contractViolations = searchReadings.filter((reading) => reading.outcome === 'measured' && !reading.proposalValid).length
  const spanExact = searchReadings.filter((reading, index) => {
    const gold = goldSpanOf((corpus[index] as SearchDevCase))
    return reading.span !== null && gold !== null && reading.span.start === gold.start && reading.span.end === gold.end
  }).length
  /*
   * ★ 覆盖测量（计划 §5）：金标区间是否**出现在候选表里**。
   *   覆盖率 = 0 ⇒ span 精确率**在数学上不可能** > 0；此时精确率为 0 反映的是
   *   **候选表设计**，不是模型答错。两者必须分列，否则会把量具缺陷记成模型缺陷。
   */
  const searchItems = corpus
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.expected.decision === 'search')
  const isCovered = (item: SearchDevCase): boolean => {
    const gold = goldSpanOf(item)
    if (gold === null) return false
    const set = buildCandidates(item.request, { strategy: STRATEGY, maxCandidates: MAX_CANDIDATES_INPUT })
    return set.candidates.some((candidate) => candidate.start === gold.start && candidate.end === gold.end)
  }
  const coveredCount = searchItems.filter(({ item }) => isCovered(item)).length
  const exactGivenCovered = searchItems.filter(({ item, index }) => {
    const reading = readings[index]
    const gold = goldSpanOf(item)
    return (
      isCovered(item) &&
      reading !== undefined &&
      reading.span !== null &&
      gold !== null &&
      reading.span.start === gold.start &&
      reading.span.end === gold.end
    )
  }).length
  const queryNoSelection = searchReadings.filter((reading) => reading.outcome === 'measured' && reading.span === null).length
  const reasonAgreement = readings.filter((reading, index) => reading.reason === (corpus[index] as SearchDevCase).expected.reason).length

  const okLatencies = readings.filter((reading) => reading.outcome === 'measured').map((reading) => reading.latencyMs).sort((a, b) => a - b)
  const p95Index = okLatencies.length === 0 ? 0 : Math.min(okLatencies.length - 1, Math.ceil(0.95 * okLatencies.length) - 1)

  return {
    mainReading: {
      endToEndAccuracy: accounting.endToEndAccuracy,
      validOnlyAccuracy: accounting.validOnlyAccuracy,
      outputValidRate: accounting.outputValidRate,
      measured: accounting.measured,
      invalidOutput: accounting.invalidOutput,
      unavailable: accounting.unavailable,
      endToEndDenominator: accounting.endToEndDenominator,
    },
    singleLabelAccuracy: decisionAccuracy,
    recall: { explicit: explicitRecall, autoPublic: autoRecall, overSearchFpr: overSearch },
    contract: {
      searchCases: searchReadings.length,
      contractViolations,
      spanExactMatch: spanExact,
      goldCovered: coveredCount,
      goldCoverageRate: ratio(coveredCount, searchItems.length),
      spanExactGivenCovered: exactGivenCovered,
      queryNoSelection,
      reasonAgreement,
    },
    latency: {
      count: okLatencies.length,
      medianMs: okLatencies.length === 0 ? null : (okLatencies[Math.floor(okLatencies.length / 2)] as number),
      p95Ms: okLatencies.length === 0 ? null : (okLatencies[p95Index] as number),
      maxMs: okLatencies.length === 0 ? null : (okLatencies[okLatencies.length - 1] as number),
    },
  }
}

const metrics: Record<ArmName, ArmMetrics> = { A: armMetrics('A'), B: armMetrics('B'), J: armMetrics('J') }

/* ---- 成对非劣（G3）：J vs A，按 **case** 重采样 ---- */
const correctA = perArm.A.map((reading, index) => (reading.decision === (corpus[index] as SearchDevCase).expected.decision ? 1 : 0))
const correctJ = perArm.J.map((reading, index) => (reading.decision === (corpus[index] as SearchDevCase).expected.decision ? 1 : 0))
const paired = EXECUTED_ARMS.includes('A') && EXECUTED_ARMS.includes('J') ? pairedBootstrapDiff(correctJ, correctA) : null
const g3 = {
  pairedDiffJminusA: paired,
  /** G3：95% 成对区间下界 ≥ −3 个百分点 */
  nonInferior: paired === null ? null : paired.low >= -0.03,
  threshold: -0.03,
  note: '分列 case 区间；采用裁定须看三轮最差、家族聚类统计与全部门槛，不由此布尔值单独决定。',
}

const jevCost = estimateCostUsd(
  totalUsage.J.known === 0 ? null : { inputTokens: totalUsage.J.input, outputTokens: totalUsage.J.output }
)

/* ---- 证据 ---- */
const manifest = {
  schemaVersion: 'm9.6-compare-manifest@1',
  module: 'search-need',
  split: SPLIT,
  round: ROUND,
  runId,
  head,
  note:
    'A/B/J 三列同批、同输入、同期限、并发 1。证据含合成 case 引用与预测，不含任何 Key、认证头或真实用户内容。' +
    '人审强度 = 用户抽查 + 其余信任（不满足计划 §6.1 的逐条人审强度）。',
  corpus: { file: SPLIT === 'dev' ? 'evals/m9.6/search-need-corpus.ts' : 'evals/m9.6/search-heldout.ts', fingerprint, total: selectedCorpus.length, used: corpus.length },
  freeze,
  callOrder: 'alternate AJ/JA by case and round',
  models: { jev: jevModel, bEndpointModel: openAiSmallModel, aEndpointHost: openAiBaseUrl.replace(/^https?:\/\//, '').split('/')[0] ?? '' },
  limits: { totalDeadlineMs: TOTAL_DEADLINE_MS, concurrency: 1, maxCandidates: MAX_CANDIDATES_INPUT },
  candidateStrategy: STRATEGY,
  frozen: {
    decisionCriteria: Object.keys(DECISION_CRITERIA),
    reasonCandidates: SEARCH_DEV_REASONS.length,
    prompt: createHash('sha256').update(JSON.stringify({DECISION_INSTRUCTIONS, DECISION_CRITERIA, REASON_CRITERIA})).digest('hex'),
  },
  executedArms: EXECUTED_ARMS,
  armsNotRun: (['A', 'B', 'J'] as ArmName[]).filter((arm) => !EXECUTED_ARMS.includes(arm)),
  invocation: { command: 'pnpm m9.6:compare -- --split dev --round ' + ROUND + ' --arms ' + EXECUTED_ARMS.join(','), limit: LIMIT },
}

mkdirSync(runDir, { recursive: true })

/*
 * ★ **证据分层**（契约 §13）：
 *   入库的 `predictions.jsonl` **只**含合成 case **引用**（id）+ 标签 + 预测 + 计数，
 *   **不含 request 正文**；含正文的完整档写进 `artifacts/m9.6/local/<runId>/`（gitignore），
 *   且写之前必须通过 `git check-ignore`。
 */
const bareRows = rows.map((row) => {
  const { request: _request, ...rest } = row as Record<string, unknown> & { request?: unknown }
  return rest
})
safeWrite(join(runDir, 'predictions.jsonl'), `${bareRows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'predictions.jsonl')
safeWrite(join(runDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'manifest.json')
safeWrite(
  join(runDir, 'metrics.json'),
  `${JSON.stringify({ schemaVersion: 'm9.6-compare-metrics@1', metrics, g3, jevUsage: { ...totalUsage.J, estimatedCostUsd: jevCost } }, null, 2)}\n`,
  'metrics.json'
)

/* 含正文的完整档 —— 私有目录，先验证被忽略 */
const localDir = join(ROOT, 'artifacts', 'm9.6', 'local', runId)
mkdirSync(localDir, { recursive: true })
assertPathIgnored(join(localDir, 'predictions-full.jsonl'))
safeWrite(join(localDir, 'predictions-full.jsonl'), `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'local/predictions-full.jsonl')

const failuresText = `${JSON.stringify(
  {
    schemaVersion: 'm9.6-compare-failures@1',
    note: '失败码全部是**白名单码**，不含任何文本；语料正文不在本文件里。',
    failures: rows
      .filter((row) => {
        const arms = row.arms as Record<string, ArmReading>
        return EXECUTED_ARMS.some((arm) => arms[arm]?.outcome !== 'measured')
      })
      .map((row) => {
        const arms = row.arms as Record<string, ArmReading>
        return {
          caseId: row.caseId,
          A: arms.A?.outcome === 'measured' ? 'ok' : `${String(arms.A?.outcome)}/${String(arms.A?.code)}`,
          B: arms.B?.outcome === 'measured' ? 'ok' : `${String(arms.B?.outcome)}/${String(arms.B?.code)}`,
          J: arms.J?.outcome === 'measured' ? 'ok' : `${String(arms.J?.outcome)}/${String(arms.J?.code)}`,
        }
      }),
  },
  null,
  2
)}\n`
safeWrite(join(runDir, 'failures.json'), failuresText, 'failures.json')

/* ---- 上屏汇总 ---- */
console.log(`\n${'='.repeat(78)}\n度量（主分母 = 全部 ${String(corpus.length)} 例；失败按端到端失败计入）\n${'='.repeat(78)}`)
for (const arm of ['A', 'B', 'J'] as ArmName[]) {
  if (!EXECUTED_ARMS.includes(arm)) {
    console.log(`  ${arm}: **NOT RUN**（本轮 --arms 未选该列；计划 §6.2：B 不可用不得声称表达差异已受控）`)
    continue
  }
  const entry = metrics[arm]
  console.log(
    `  ${arm}: 准确率 ${describeMetric(entry.mainReading.endToEndAccuracy)} · 完成率 ${describeMetric(entry.mainReading.outputValidRate)}` +
      ` · explicit 召回 ${describeMetric(entry.recall.explicit)} · auto 召回 ${describeMetric(entry.recall.autoPublic)} · 过度搜索 ${describeMetric(entry.recall.overSearchFpr)}`
  )
  console.log(
    `     契约：search 用例 ${String(entry.contract.searchCases)} · 违约 ${String(entry.contract.contractViolations)} · span 精确 ${String(entry.contract.spanExactMatch)} · 理由一致 ${String(entry.contract.reasonAgreement)}` +
      ` · 延迟 median ${String(entry.latency.medianMs)}ms / p95 ${String(entry.latency.p95Ms)}ms`
  )
  console.log(
    `     ★ 候选覆盖：金标在候选表里的 ${String(entry.contract.goldCovered)}/${String(entry.contract.searchCases)}（${describeMetric(entry.contract.goldCoverageRate)}）` +
      ` · 被覆盖子集里逐字命中 ${String(entry.contract.spanExactGivenCovered)} · 未选任何片段 ${String(entry.contract.queryNoSelection)}`
  )
}
console.log(`\n  G3 成对（J − A，按 case bootstrap）：${paired === null ? 'NOT RUN' : `${paired.meanDiff.toFixed(4)} [${paired.low.toFixed(4)}, ${paired.high.toFixed(4)}]`}`)
console.log(`     下界 ≥ −0.03 ? ${g3.nonInferior === null ? 'NOT RUN' : String(g3.nonInferior)}（⚠️ dev-only 探索性，**不构成 G3 判定**）`)
console.log(`  Jev usage：${String(totalUsage.J.known)} 条有 / ${String(totalUsage.J.unknown)} 条 UNKNOWN · 估算 $${(jevCost ?? 0).toFixed(6)}`)
console.log(`\n  证据：artifacts/m9.6/compare/${runId}/`)
console.log('  本轮读数不单独构成采用裁定；需三轮最差、全部门槛与证据限制。')
