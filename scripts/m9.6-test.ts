/**
 * M9.6 WP2 —— **离线部件/契约测试**（`pnpm m9.6:test`）。
 *
 * ============================================================================
 *  它证明什么
 * ============================================================================
 * ```text
 * §1 协议事实与**凭据失败关闭**（缺具名变量 ⇒ REFUSED，**绝不**回落 OPENAI_API_KEY）
 * §2 **严格归一化**：24 个失败码逐个真实触达；**概率不修复**；usage 缺失记 UNKNOWN 不记 0
 * §3 终态语义：401/403/错版本**不重试**且要求停止整批；429/529/5xx/网络才重试
 * §4 有界候选生成与 span 还原：上限、去重、确定性、**不拆 surrogate**、无候选行为
 * §5 脱敏：Key 不出现在任何失败 detail 里
 * §6 零真实出站：全局 `fetch` 换成"一调用就抛错"的桩，全部用例仍正常
 * ```
 * ⚠️ 纯离线：不加载 `.env`（注入 config）、不碰数据库、不发网络请求、不改历史证据。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import {
  JEV_FAILURE_CODES,
  JEV_PROTOCOL_FACTS,
  JEV_SHAPE_FAILURE_CODES,
  JEV_TRANSPORT_FAILURE_CODES,
  MAX_JEV_RESPONSE_UNITS,
  type JevFailureCode,
} from './m9.6-jev-protocol.ts'
import {
  JEV_ENDPOINT,
  JEV_TEST_KEY_VAR,
  JEV_MODEL_VAR,
  MAX_ATTEMPTS,
  TOTAL_DEADLINE_MS,
  callSystemOne,
  estimateCostUsd,
  redactSecrets,
  resolveJevConfig,
  type JevCallResult,
  type JevQuestions,
} from './m9.6-jev-protocol.ts'
import {
  MAX_CANDIDATES,
  MAX_CANDIDATE_UNITS,
  NO_CANDIDATE_OPTION,
  buildCandidateCriteria,
  buildCandidates,
  candidateIdToSpan,
} from './m9.6-candidates.ts'
import { isValidAffectSemanticSpan } from '../src/kernel/contracts/affect-semantic.ts'

const ROOT = resolve('.')

let passed = 0
let failed = 0
const failures: string[] = []
const checks: { label: string; ok: boolean; detail: string }[] = []

function check(label: string, ok: boolean, detail = ''): boolean {
  checks.push({ label, ok, detail })
  if (ok) {
    passed += 1
    console.log(`  ✅ ${label}${detail ? `  [${detail}]` : ''}`)
  } else {
    failed += 1
    failures.push(`${label} :: ${detail}`)
    console.log(`  ❌ ${label}${detail ? `  [${detail}]` : ''}`)
  }
  return ok
}

function section(title: string): void {
  console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`)
}

/* 假凭据（**不是**真 key，也不与任何真实变量同名） */
const FAKE_KEY = 'fake-jev-key-0123456789abcdef'
const FAKE_MODEL = 'jev-1.13.0'
const CONFIG = { ok: true as const, apiKey: FAKE_KEY, model: FAKE_MODEL }

interface Counter {
  calls: number
}

function makeFetch(make: (call: number, init?: { signal?: AbortSignal | null }) => Response, counter: Counter): typeof fetch {
  return ((_input: unknown, init?: { signal?: AbortSignal | null }) => {
    counter.calls += 1
    return Promise.resolve(make(counter.calls, init))
  }) as unknown as typeof fetch
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const QUESTIONS: JevQuestions = {
  mood: { type: 'noul', instructions: '这条消息是否带有情绪影响？' },
  route: { type: 'choice', instructions: '这条消息属于哪一类？', criteria: { billing: '账务', technical: '技术' } },
  severity: { type: 'score', instructions: '强度如何？', criteria: ['平静', '受挫', '非常生气'] },
}

const VALID_ANSWERS = {
  mood: { type: 'noul', noul: 0.9 },
  route: { type: 'choice', choice: 'billing', probabilities: { billing: 0.7, technical: 0.3 }, confidence: 0.4 },
  severity: {
    type: 'score',
    score: 1.2,
    /* ⚠️ 官方 `legend` 是**对象**映射（WP3 预检实测），不是有序数组 */
    legend: { '0': '平静', '1': '受挫', '2': '非常生气' },
    probabilities: { '0': 0.2, '1': 0.5, '2': 0.3 },
    confidence: 0.3,
  },
}

interface FailureSample {
  readonly label: string
  readonly expected: JevFailureCode
  readonly body: unknown
  readonly status?: number
  readonly retryable?: boolean
}

const SHAPE_SAMPLES: readonly FailureSample[] = [
  { label: 'model_missing（响应缺 model）', expected: 'model_missing', body: { answers: VALID_ANSWERS, usage: {} } },
  {
    label: 'model_mismatch（响应版本 ≠ 请求版本）',
    expected: 'model_mismatch',
    body: { model: 'jev-1.12.0', answers: VALID_ANSWERS, usage: {} },
  },
  { label: 'answers_missing（answers 不是对象）', expected: 'answers_missing', body: { model: FAKE_MODEL, answers: [] } },
  {
    label: 'answer_missing（缺某个 question id）',
    expected: 'answer_missing',
    body: { model: FAKE_MODEL, answers: { mood: VALID_ANSWERS.mood, route: VALID_ANSWERS.route } },
  },
  {
    label: 'answer_not_object',
    expected: 'answer_not_object',
    body: { model: FAKE_MODEL, answers: { ...VALID_ANSWERS, mood: 'nope' } },
  },
  {
    label: 'answer_type_mismatch（声明 noul · 返回 choice）',
    expected: 'answer_type_mismatch',
    body: { model: FAKE_MODEL, answers: { ...VALID_ANSWERS, mood: { type: 'choice', choice: 'billing', probabilities: { billing: 1 } } } },
  },
  {
    label: 'noul_invalid（不是有限数）',
    expected: 'noul_invalid',
    body: { model: FAKE_MODEL, answers: { ...VALID_ANSWERS, mood: { type: 'noul', noul: 'high' } } },
  },
  {
    label: 'noul_invalid（越界 1.4）',
    expected: 'noul_invalid',
    body: { model: FAKE_MODEL, answers: { ...VALID_ANSWERS, mood: { type: 'noul', noul: 1.4 } } },
  },
  {
    label: 'choice_invalid（选项未声明）',
    expected: 'choice_invalid',
    body: { model: FAKE_MODEL, answers: { ...VALID_ANSWERS, route: { type: 'choice', choice: 'sales', probabilities: { billing: 0.5, technical: 0.5 } } } },
  },
  {
    label: 'probabilities_invalid（不是对象）',
    expected: 'probabilities_invalid',
    body: { model: FAKE_MODEL, answers: { ...VALID_ANSWERS, route: { type: 'choice', choice: 'billing', probabilities: 'x' } } },
  },
  {
    label: 'probabilities_invalid（键未声明）',
    expected: 'probabilities_invalid',
    body: { model: FAKE_MODEL, answers: { ...VALID_ANSWERS, route: { type: 'choice', choice: 'billing', probabilities: { billing: 0.5, sales: 0.5 } } } },
  },
  {
    label: 'probabilities_invalid（越界负值）',
    expected: 'probabilities_invalid',
    body: { model: FAKE_MODEL, answers: { ...VALID_ANSWERS, route: { type: 'choice', choice: 'billing', probabilities: { billing: 1.5, technical: -0.5 } } } },
  },
  {
    label: '★ probabilities_not_normalized（和 0.8 ⇒ **不修复**，整份判失败）',
    expected: 'probabilities_not_normalized',
    body: { model: FAKE_MODEL, answers: { ...VALID_ANSWERS, route: { type: 'choice', choice: 'billing', probabilities: { billing: 0.5, technical: 0.3 } } } },
  },
  {
    label: '★ probabilities_not_normalized（和 0.98 ⇒ 超过 0.01 容差，仍判失败 —— 边界钉住）',
    expected: 'probabilities_not_normalized',
    body: { model: FAKE_MODEL, answers: { ...VALID_ANSWERS, route: { type: 'choice', choice: 'billing', probabilities: { billing: 0.6, technical: 0.38 } } } },
  },
  {
    label: 'confidence_invalid（不是有限数）',
    expected: 'confidence_invalid',
    body: { model: FAKE_MODEL, answers: { ...VALID_ANSWERS, route: { ...VALID_ANSWERS.route, confidence: 'high' } } },
  },
  {
    label: 'confidence_invalid（越界）',
    expected: 'confidence_invalid',
    body: { model: FAKE_MODEL, answers: { ...VALID_ANSWERS, route: { ...VALID_ANSWERS.route, confidence: 1.5 } } },
  },
  {
    label: 'score_invalid（不是有限数）',
    expected: 'score_invalid',
    body: { model: FAKE_MODEL, answers: { ...VALID_ANSWERS, severity: { ...VALID_ANSWERS.severity, score: 'mid' } } },
  },
  {
    label: 'score_invalid（越界 2.5）',
    expected: 'score_invalid',
    body: { model: FAKE_MODEL, answers: { ...VALID_ANSWERS, severity: { ...VALID_ANSWERS.severity, score: 2.5 } } },
  },
  {
    label: 'legend_mismatch（对象形状，但第 3 档描述与声明不一致）',
    expected: 'legend_mismatch',
    body: { model: FAKE_MODEL, answers: { ...VALID_ANSWERS, severity: { ...VALID_ANSWERS.severity, legend: { '0': '平静', '1': '受挫', '2': '暴怒' } } } },
  },
  {
    label: 'legend_mismatch（legend 是数组 —— 官方形状是对象，数组属协议违规）',
    expected: 'legend_mismatch',
    body: { model: FAKE_MODEL, answers: { ...VALID_ANSWERS, severity: { ...VALID_ANSWERS.severity, legend: ['平静', '受挫', '非常生气'] } } },
  },
  {
    label: '★ response_too_long（超过硬上限）',
    expected: 'response_too_long',
    body: null,
  },
]

const TRANSPORT_SAMPLES: readonly FailureSample[] = [
  { label: 'http_error_unauthenticated（401 · **不重试**）', expected: 'http_error_unauthenticated', body: { error: 'nope' }, status: 401 },
  { label: 'http_error_unauthenticated（403 · **不重试**）', expected: 'http_error_unauthenticated', body: { error: 'nope' }, status: 403 },
  { label: 'rate_limited（429 · 重试）', expected: 'rate_limited', body: { error: 'slow down' }, status: 429, retryable: true },
  { label: 'overloaded（529 · 重试）', expected: 'overloaded', body: { error: 'busy' }, status: 529, retryable: true },
  { label: 'http_error（500 · 重试）', expected: 'http_error', body: { error: 'boom' }, status: 500, retryable: true },
]

/* ===========================================================================
 *  §6 零真实出站（先替换，确保后面任何遗漏都会立刻变红）
 * ========================================================================= */

const REAL_FETCH = globalThis.fetch
let realEgressAttempts = 0
globalThis.fetch = ((..._args: unknown[]) => {
  realEgressAttempts += 1
  throw new Error('真实出站被调用（本门必须零出站）')
}) as unknown as typeof fetch

const observedCodes = new Set<JevFailureCode>()

async function callWith(body: unknown, status = 200, counter?: Counter): Promise<JevCallResult> {
  const localCounter = counter ?? { calls: 0 }
  return await callSystemOne(
    { state: '测试文本', questions: QUESTIONS },
    { config: CONFIG, fetchImpl: makeFetch(() => jsonResponse(body, status), localCounter), deadlineMs: TOTAL_DEADLINE_MS }
  )
}

/* ===========================================================================
 *  §1 协议事实与凭据失败关闭
 * ========================================================================= */

section('§1 协议事实与凭据失败关闭')

check(
  '★ 端点 = POST https://api.typesafe.ai/v1/systemone（**不是** OpenAI 兼容）',
  JEV_ENDPOINT === 'https://api.typesafe.ai/v1/systemone' && JEV_PROTOCOL_FACTS.endpoint === JEV_ENDPOINT,
  JEV_ENDPOINT
)
check(
  '★ 官方问题类型恰好三种：noul / choice / score',
  JEV_PROTOCOL_FACTS.questionTypes.join(',') === 'noul,choice,score',
  JEV_PROTOCOL_FACTS.questionTypes.join(',')
)
check(
  '★ `criteria` 对 choice/score **必填**，且**没有**数值区间字段（区间只能是有序档位）',
  JEV_PROTOCOL_FACTS.criteriaRequiredFor.join(',') === 'choice,score' && JEV_PROTOCOL_FACTS.hasNumericRangeField === false,
  `score 档位 ${String(JEV_PROTOCOL_FACTS.scoreMinLevels)}–${String(JEV_PROTOCOL_FACTS.scoreMaxLevels)} · choice ≤ ${String(JEV_PROTOCOL_FACTS.choiceMaxOptions)}`
)
check(
  '★ Noul **不返回** confidence（计划 §2.1 更正之一）',
  JEV_PROTOCOL_FACTS.noulReturnsConfidence === false,
  'confidence 只用于风险—覆盖率分析，**不是**正确率'
)
check(
  '★ 官方**没有** request id、**没有**超时指引、**没有** OpenAI 兼容模式',
  JEV_PROTOCOL_FACTS.hasRequestId === false &&
    JEV_PROTOCOL_FACTS.documentsTimeoutGuidance === false &&
    JEV_PROTOCOL_FACTS.openAiCompatible === false,
  '所报即所查；不编造字段'
)
check(
  `★ 价格 = $${String(JEV_PROTOCOL_FACTS.pricePerMillionInputTokensUsd)}/百万输入 token，输出免费`,
  JEV_PROTOCOL_FACTS.pricePerMillionInputTokensUsd === 0.042 && JEV_PROTOCOL_FACTS.outputTokensFree === true,
  '最低充值额官方未载明 ⇒ 契约 §12 记为待定，**不填**'
)

{
  const missingBoth = resolveJevConfig({})
  check(
    `★ **失败关闭**：两个具名变量都缺 ⇒ REFUSED 且列出缺项`,
    !missingBoth.ok && missingBoth.code === 'not_configured' && missingBoth.missing.length === 2,
    missingBoth.ok ? '意外通过' : missingBoth.missing.join(',')
  )
  const keyOnly = resolveJevConfig({ [JEV_TEST_KEY_VAR]: FAKE_KEY })
  check('★ 只缺 M96_JEV_MODEL ⇒ 仍 REFUSED', !keyOnly.ok && keyOnly.missing.join(',') === JEV_MODEL_VAR, keyOnly.ok ? '意外通过' : keyOnly.missing.join(','))
  const both = resolveJevConfig({ [JEV_TEST_KEY_VAR]: FAKE_KEY, [JEV_MODEL_VAR]: FAKE_MODEL })
  check('★ 两个都在 ⇒ 通过', both.ok && both.model === FAKE_MODEL, both.ok ? 'ok' : 'refused')
  /*
   * ★ 最关键的一条：环境里**有** OPENAI_API_KEY 时，Jev 仍必须 REFUSED。
   *   "以为在跑 Jev、其实在烧主模型 Key"是这里最坏的失败模式。
   */
  const withOpenAi = resolveJevConfig({ OPENAI_API_KEY: 'sk-should-never-be-used', OPENAI_BASE_URL: 'https://example.invalid/v1' })
  check(
    '★ **绝不回落**：环境里有 OPENAI_API_KEY 也不能让 Jev 跑起来',
    !withOpenAi.ok && withOpenAi.code === 'not_configured',
    withOpenAi.ok ? '危险：回落了' : 'REFUSED'
  )
}
{
  const c: Counter = { calls: 0 }
  const refused = await callSystemOne(
    { state: 'x', questions: QUESTIONS },
    { config: resolveJevConfig({ OPENAI_API_KEY: 'sk-should-never-be-used' }), fetchImpl: makeFetch(() => jsonResponse({}, 200), c) }
  )
  check(
    '★ 未配置时 **连一次请求都不发**（attempts=0）',
    !refused.ok && refused.code === 'not_configured' && refused.attempts === 0 && c.calls === 0,
    `code=${refused.ok ? 'ok' : refused.code} attempts=${String(refused.attempts)} calls=${String(c.calls)}`
  )
  observedCodes.add('not_configured')
}

check(
  '★ 失败码闭集：形状系与传输系**互斥且穷尽**（没有既不在也不重的码）',
  JEV_SHAPE_FAILURE_CODES.length + JEV_TRANSPORT_FAILURE_CODES.length === JEV_FAILURE_CODES.length &&
    new Set(JEV_FAILURE_CODES).size === JEV_FAILURE_CODES.length,
  `形状 ${String(JEV_SHAPE_FAILURE_CODES.length)} + 传输 ${String(JEV_TRANSPORT_FAILURE_CODES.length)} = ${String(JEV_FAILURE_CODES.length)}`
)

/* ===========================================================================
 *  §2 严格归一化
 * ========================================================================= */

section('§2 严格归一化（假 provider · 概率不修复 · usage 不记 0）')

{
  const c: Counter = { calls: 0 }
  const ok = await callWith({ model: FAKE_MODEL, answers: VALID_ANSWERS, usage: { input_tokens: 1234, output_tokens: 56 } }, 200, c)
  check(
    '★ 正控：三种问题全部合法 ⇒ ok，且 noul/choice/score 各自形状正确',
    ok.ok &&
      ok.answers.mood?.type === 'noul' &&
      ok.answers.route?.type === 'choice' &&
      ok.answers.severity?.type === 'score' &&
      c.calls === 1,
    ok.ok ? `servedModel=${ok.servedModel} calls=${String(c.calls)}` : `${ok.code}`
  )
  check(
    '★ 正控：usage 合法 ⇒ 解析成 input/output；requestId 恒为 null（官方无此字段）',
    ok.ok && ok.usageKnown === true && ok.usage?.inputTokens === 1234 && ok.usage.outputTokens === 56 && ok.requestId === null,
    ok.ok ? JSON.stringify(ok.usage) : `${ok.code}`
  )
  check(
    '★ 正控：Noul 答案**没有** confidence 字段（不得填 0 或 1）',
    ok.ok && ok.answers.mood !== undefined && !('confidence' in ok.answers.mood),
    'Noul 无 confidence'
  )
  check(
    '★ 正控：费用 = input_tokens × $0.042/1e6',
    Math.abs((estimateCostUsd({ inputTokens: 1_000_000, outputTokens: 0 }) ?? -1) - 0.042) < 1e-12,
    String(estimateCostUsd({ inputTokens: 1_000_000, outputTokens: 0 }))
  )
}
{
  const noUsage = await callWith({ model: FAKE_MODEL, answers: VALID_ANSWERS })
  check(
    '★ **usage 缺失记 UNKNOWN，不记 0**：usage=null · usageKnown=false · 费用=null',
    noUsage.ok && noUsage.usage === null && noUsage.usageKnown === false && estimateCostUsd(null) === null,
    noUsage.ok ? `usageKnown=${String(noUsage.usageKnown)}` : `${noUsage.code}`
  )
}
{
  const nullChoice = await callWith({
    model: FAKE_MODEL,
    answers: {
      ...VALID_ANSWERS,
      route: { type: 'choice', choice: null, probabilities: { billing: 0.5, technical: 0.5 } },
    },
  })
  check(
    '★ `choice: null` 是**合法**答案（官方允许 criteria 值为 null）⇒ 不判违规',
    nullChoice.ok && nullChoice.answers.route?.type === 'choice' && nullChoice.answers.route.choice === null,
    nullChoice.ok ? 'ok' : `${nullChoice.code}`
  )
}
{
  /*
   * ★ **容差边界钉住**（依据实测：13 选项问题上有 15/100 次返回和恰为 0.99）：
   *   和 0.99 ⇒ **接受**（两位小数的表示舍入），且概率**原样保留不被改写**。
   *   这条与"和 0.98 / 0.8 仍判失败"配对，才算把边界量清楚。
   */
  const boundary = await callWith({
    model: FAKE_MODEL,
    answers: { ...VALID_ANSWERS, route: { type: 'choice', choice: 'billing', probabilities: { billing: 0.69, technical: 0.3 } } },
  })
  const kept = boundary.ok && boundary.answers.route?.type === 'choice' ? boundary.answers.route.probabilities : null
  check(
    '★ **容差边界**：和 0.99 ⇒ 接受，且概率**逐字保留**（不做归一化修复）',
    boundary.ok && kept?.billing === 0.69 && kept.technical === 0.3,
    boundary.ok ? `原样保留 ${JSON.stringify(kept)}` : `被拒：${boundary.code}`
  )
}

for (const sample of SHAPE_SAMPLES) {
  const c: Counter = { calls: 0 }
  const result =
    sample.expected === 'response_too_long'
      ? await callSystemOne(
          { state: 'x', questions: QUESTIONS },
          {
            config: CONFIG,
            deadlineMs: TOTAL_DEADLINE_MS,
            fetchImpl: makeFetch(() => new Response(`{"model":"${FAKE_MODEL}","pad":"${'x'.repeat(MAX_JEV_RESPONSE_UNITS)}"}`, { status: 200 }), c),
          }
        )
      : await callWith(sample.body, sample.status ?? 200, c)
  if (!result.ok) observedCodes.add(result.code)
  /*
   * ⚠️ 计划 §11 逐字：「401/403、**错版本、非法协议不重试**」。
   * 所以形状违规与错版本的 attempts 都是 **1**，不是尝试上限 —— 重试只会烧钱并掩盖协议问题。
   */
  check(
    `★ 形状码 ${sample.label} ⇒ ${sample.expected} / invalid_output · **不重试**（attempts=1）`,
    !result.ok && result.code === sample.expected && result.family === 'invalid_output' && result.attempts === 1 && c.calls === 1,
    result.ok ? '意外 ok' : `${result.code}/${result.family}/attempts=${String(result.attempts)}/calls=${String(c.calls)}`
  )
}

{
  const notJson = await callSystemOne(
    { state: 'x', questions: QUESTIONS },
    { config: CONFIG, fetchImpl: makeFetch(() => new Response('<html>hello</html>', { status: 200 }), { calls: 0 }), deadlineMs: TOTAL_DEADLINE_MS }
  )
  observedCodes.add('envelope_not_json')
  check('★ envelope_not_json（HTTP 200 但正文不是 JSON）', !notJson.ok && notJson.code === 'envelope_not_json', notJson.ok ? '意外 ok' : notJson.code)

  const notObject = await callSystemOne(
    { state: 'x', questions: QUESTIONS },
    { config: CONFIG, fetchImpl: makeFetch(() => jsonResponse([1, 2], 200), { calls: 0 }), deadlineMs: TOTAL_DEADLINE_MS }
  )
  observedCodes.add('envelope_not_object')
  check('★ envelope_not_object（顶层是数组）', !notObject.ok && notObject.code === 'envelope_not_object', notObject.ok ? '意外 ok' : notObject.code)
}

/* ===========================================================================
 *  §3 终态语义
 * ========================================================================= */

section('§3 终态语义（认证/错版本不重试；429/529/5xx/网络才重试）')

for (const sample of TRANSPORT_SAMPLES) {
  const c: Counter = { calls: 0 }
  const result = await callWith(sample.body, sample.status ?? 200, c)
  if (!result.ok) observedCodes.add(result.code)
  const wantAttempts = sample.retryable === true ? MAX_ATTEMPTS : 1
  check(
    `★ ${sample.label} ⇒ ${sample.expected} · attempts=${String(wantAttempts)}`,
    !result.ok && result.code === sample.expected && result.attempts === wantAttempts && c.calls === wantAttempts,
    result.ok ? '意外 ok' : `${result.code}/attempts=${String(result.attempts)}/calls=${String(c.calls)}`
  )
}
{
  const c: Counter = { calls: 0 }
  const mismatch = await callWith({ model: 'jev-1.12.0', answers: VALID_ANSWERS }, 200, c)
  check(
    '★ 错模型版本 ⇒ **不重试**（1 次）且要求**停止整批**',
    !mismatch.ok && mismatch.code === 'model_mismatch' && mismatch.attempts === 1 && mismatch.stopBatch === true && c.calls === 1,
    mismatch.ok ? '意外 ok' : `${mismatch.code}/stopBatch=${String(mismatch.stopBatch)}`
  )
}
{
  const authCounter: Counter = { calls: 0 }
  const auth = await callWith({ error: 'nope' }, 401, authCounter)
  check(
    '★ 401 ⇒ 1 次请求且 `stopBatch` 为真（计划 §10：认证失败立即停止该 provider）',
    !auth.ok && auth.code === 'http_error_unauthenticated' && auth.attempts === 1 && auth.stopBatch === true && authCounter.calls === 1,
    auth.ok ? '意外 ok' : `stopBatch=${String(auth.stopBatch)}/calls=${String(authCounter.calls)}`
  )
}
{
  const hanging = ((_i: unknown, init?: { signal?: AbortSignal | null }) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal ?? null
      if (signal === null) return
      if (signal.aborted) {
        reject(signal.reason as Error)
        return
      }
      signal.addEventListener('abort', () => { reject(signal.reason as Error) }, { once: true })
    })) as unknown as typeof fetch
  const deadline = await callSystemOne({ state: 'x', questions: QUESTIONS }, { config: CONFIG, fetchImpl: hanging, deadlineMs: 60 })
  observedCodes.add('deadline_exceeded')
  check('★ 总期限：慢响应 ⇒ deadline_exceeded（不是挂死）', !deadline.ok && deadline.code === 'deadline_exceeded', deadline.ok ? '意外 ok' : deadline.code)

  const controller = new AbortController()
  controller.abort()
  const cancelled = await callSystemOne(
    { state: 'x', questions: QUESTIONS },
    { config: CONFIG, fetchImpl: hanging, signal: controller.signal }
  )
  observedCodes.add('cancelled')
  check('★ 外部取消 ⇒ cancelled', !cancelled.ok && cancelled.code === 'cancelled', cancelled.ok ? '意外 ok' : cancelled.code)

  const network = await callSystemOne(
    { state: 'x', questions: QUESTIONS },
    {
      config: CONFIG,
      deadlineMs: TOTAL_DEADLINE_MS,
      fetchImpl: ((() => Promise.reject(new TypeError('fetch failed'))) as unknown as typeof fetch),
    }
  )
  observedCodes.add('network_error')
  check(
    `★ 网络错误 ⇒ network_error 且重试到上限（${String(MAX_ATTEMPTS)} 次）`,
    !network.ok && network.code === 'network_error' && network.attempts === MAX_ATTEMPTS,
    network.ok ? '意外 ok' : network.code
  )
}

/* 期限不靠旁白：直接**窥探**每次 fetch 拿到的 signal */
{
  let sawSignal = false
  let sawAbortable = false
  const spy = ((_i: unknown, init?: { signal?: AbortSignal | null }) => {
    sawSignal = init?.signal instanceof AbortSignal
    sawAbortable = init?.signal?.aborted === false
    return Promise.resolve(jsonResponse({ model: FAKE_MODEL, answers: VALID_ANSWERS }))
  }) as unknown as typeof fetch
  const result = await callSystemOne({ state: 'x', questions: QUESTIONS }, { config: CONFIG, fetchImpl: spy })
  check(
    '★ 每次 fetch 都带**未中止态**的 `AbortSignal` ⇒ 期限与取消真的接在传输上',
    sawSignal && sawAbortable && result.ok,
    `signal=${String(sawSignal)} abortable=${String(sawAbortable)}`
  )
}

/* ===========================================================================
 *  §4 有界候选生成与 span 还原
 * ========================================================================= */

section('§4 有界候选生成与 span 还原')

const LONG_MESSAGE =
  '我最近在做一个毕业设计项目，用的是 TypeScript 和 Node.js。' +
  '导师说下周三要交中期检查材料，我还没写完文献综述。' +
  '另外我昨天把笔记本摔了一下，屏幕右上角有点花。'

{
  const set = buildCandidates(LONG_MESSAGE)
  check(
    `★ 有界：候选个数 ≤ ${String(MAX_CANDIDATES)} · 文本总长 ≤ ${String(MAX_CANDIDATE_UNITS)} 单元`,
    set.candidates.length <= MAX_CANDIDATES &&
      set.candidates.reduce((sum, item) => sum + item.text.length, 0) <= MAX_CANDIDATE_UNITS,
    `${String(set.candidates.length)} 个 · ${String(set.candidates.reduce((s, i) => s + i.text.length, 0))} 单元`
  )
  check(
    '★ **丢弃量被记录**（不是静默截断文本）：cap / budget 两个计数都给出',
    set.droppedByCap >= 0 && set.droppedByBudget >= 0 && set.droppedByCap + set.droppedByBudget > 0,
    `cap=${String(set.droppedByCap)} budget=${String(set.droppedByBudget)}`
  )
  check(
    '★ 每个候选的 `text` 与 `[start,end)` 在原文上**逐字一致**（位置由程序给，不是猜的）',
    set.candidates.every((item) => LONG_MESSAGE.slice(item.start, item.end) === item.text),
    `${String(set.candidates.length)} 个全部一致`
  )
  check(
    '★ 候选 id 形如 C0..C11 且按出现顺序递增',
    set.candidates.every((item, index) => item.id === `C${String(index)}`),
    set.candidates.map((item) => item.id).join(',')
  )
  const again = buildCandidates(LONG_MESSAGE)
  check(
    '★ 确定性：同一输入两次生成**逐字段相同**（无随机、无时钟）',
    JSON.stringify(again) === JSON.stringify(set),
    '两次生成相同'
  )
  check(
    '★ 契约 §6.1 禁止项：候选表**不含**"整条消息"这一项（默认整条消息为证据被明令禁止）',
    set.candidates.every((item) => !(item.start === 0 && item.end === LONG_MESSAGE.length)) || LONG_MESSAGE.length <= 24,
    `消息长 ${String(LONG_MESSAGE.length)} 单元；整句窗口上限 ${String(24)}`
  )
}

{
  const short = buildCandidates('嗯')
  check(
    '★ **无候选**行为：过短消息 ⇒ reason=no_candidate 且候选为空（**不调 Jev**、不默认整条为证据）',
    short.reason === 'no_candidate' && short.candidates.length === 0,
    `reason=${short.reason} n=${String(short.candidates.length)}`
  )
  const resolved = candidateIdToSpan('C0', short, '嗯')
  check('★ 无候选时解析任何 id ⇒ no_candidate（不是静默成功）', !resolved.ok && resolved.code === 'no_candidate', resolved.ok ? '意外成功' : resolved.code)
}

{
  const set = buildCandidates(LONG_MESSAGE)
  const first = set.candidates[0]
  if (first === undefined) throw new Error('候选表为空，测试前提不成立')
  const good = candidateIdToSpan(first.id, set, LONG_MESSAGE)
  check(
    '★ 合法 id ⇒ 还原出**原文区间**且通过冻结契约的 span 校验器',
    good.ok && LONG_MESSAGE.slice(good.span.start, good.span.end) === first.text && isValidAffectSemanticSpan(good.span, LONG_MESSAGE),
    good.ok ? `[${String(good.span.start)},${String(good.span.end)})` : good.code
  )
  const bogus = candidateIdToSpan('C999', set, LONG_MESSAGE)
  check('★ 未声明的 id ⇒ not_a_candidate（**不**默认整个消息为证据）', !bogus.ok && bogus.code === 'not_a_candidate', bogus.ok ? '意外成功' : bogus.code)
  const criteria = buildCandidateCriteria(set)
  check(
    `★ Choice 的 criteria 含显式"没有/不确定"选项（id=${NO_CANDIDATE_OPTION}，值为 null），避免逼模型挑一个存在的候选`,
    NO_CANDIDATE_OPTION in criteria && criteria[NO_CANDIDATE_OPTION] === null && Object.keys(criteria).length === set.candidates.length + 1,
    `${String(Object.keys(criteria).length)} 个选项`
  )
}

{
  /* surrogate 安全：消息里放非 BMP 字符（emoji 占 2 个 UTF-16 单元） */
  const astral = '今天心情不错😀😀，导师刚夸了我一句，晚上想吃火锅。'
  const set = buildCandidates(astral)
  const allValid = set.candidates.every((item) => isValidAffectSemanticSpan({ start: item.start, end: item.end }, astral))
  const noSplitStart = set.candidates.every((item) => {
    const code = astral.charCodeAt(item.start)
    return !(code >= 0xdc00 && code <= 0xdfff)
  })
  const noSplitEnd = set.candidates.every((item) => {
    const code = astral.charCodeAt(item.end - 1)
    return !(code >= 0xd800 && code <= 0xdbff)
  })
  check(
    '★ **不拆 surrogate**：含 emoji 的消息上，每个候选都通过 span 校验且不在一对代理项中间切开',
    set.candidates.length > 0 && allValid && noSplitStart && noSplitEnd,
    `${String(set.candidates.length)} 个候选 · 全部合法=${String(allValid)} · 起点不拆=${String(noSplitStart)} · 终点不拆=${String(noSplitEnd)}`
  )
  /*
   * ⚠️ 上面那条若不配这一条，可能是**空转通过**（碰巧没生成过非法窗口）。
   *    这一条要求：非法窗口**确实被生成又被筛掉**，即筛选器真的在工作。
   */
  check(
    '★ **筛选器非空转**：非法 span 确实被生成过并被计入 `droppedUnsafeSpan`（> 0）',
    set.droppedUnsafeSpan > 0,
    `droppedUnsafeSpan=${String(set.droppedUnsafeSpan)} · cap=${String(set.droppedByCap)} · budget=${String(set.droppedByBudget)}`
  )
}

/* ===========================================================================
 *  §5 脱敏
 * ========================================================================= */

section('§5 脱敏：Key 不进任何落盘/上屏文本')

{
  const raw = `authorization: Bearer ${FAKE_KEY} while calling ${JEV_ENDPOINT}`
  const redacted = redactSecrets(raw, [FAKE_KEY])
  check(
    '★ `redactSecrets` 抹掉已知秘密并留标记',
    !redacted.includes(FAKE_KEY) && redacted.includes('[REDACTED]'),
    redacted
  )
  /*
   * ⚠️ 造一个**会带上秘密**的失败路径：让 fetch 抛出的错误消息里含 key。
   *    真实链路里 baseUrl 与请求头都不该泄漏，但这是"如果发生，也不会落盘"的**负控**。
   */
  const leaky = ((() => Promise.reject(new Error(`connect failed for key=${FAKE_KEY}`))) as unknown as typeof fetch)
  const result = await callSystemOne({ state: 'x', questions: QUESTIONS }, { config: CONFIG, fetchImpl: leaky, deadlineMs: TOTAL_DEADLINE_MS })
  check(
    '★ **负控**：传输错误消息里含 Key 时，失败 `detail` 已脱敏（Key 不落盘）',
    !result.ok && !result.detail.includes(FAKE_KEY) && result.detail.includes('[REDACTED]'),
    result.ok ? '意外 ok' : result.detail
  )
}
{
  const sources = ['scripts/m9.6-jev-protocol.ts', 'scripts/m9.6-candidates.ts', 'scripts/m9.6-stats.ts']
  const offenders = sources.filter((path) => readFileSync(join(ROOT, path), 'utf8').includes('dotenv'))
  check(
    '★ 三个模块都**不加载** `.env`（配置只经环境读取或显式注入）',
    offenders.length === 0,
    offenders.length === 0 ? '无 dotenv 引用' : `意外引用：${offenders.join(',')}`
  )
}

/* ===========================================================================
 *  §6 零真实出站 · 码覆盖率 · 证据
 * ========================================================================= */

section('§6 零真实出站与失败码覆盖率')

globalThis.fetch = REAL_FETCH

check(
  '★ 全局 `fetch` 在整轮被替换为"一调用就抛错"的桩，全部用例仍正常 ⇒ **真实出站 0**',
  realEgressAttempts === 0,
  `真实出站尝试 ${String(realEgressAttempts)} 次`
)

const declaredCodes = new Set<string>(JEV_FAILURE_CODES)
const notReached = [...declaredCodes].filter((code) => !observedCodes.has(code as JevFailureCode))
check(
  `★ 失败码**无死分支**：声明 ${String(declaredCodes.size)} 个，本门触达 ${String(observedCodes.size)} 个`,
  notReached.length === 0,
  notReached.length === 0 ? '全部触达' : `未触达：${notReached.join(',')}`
)

const head = ((): string => {
  try {
    const raw = readFileSync(join(ROOT, '.git', 'HEAD'), 'utf8').trim()
    return raw.startsWith('ref: ') ? readFileSync(join(ROOT, '.git', raw.slice(5).trim()), 'utf8').trim() : raw
  } catch {
    return 'unknown'
  }
})()

const evidence = {
  testId: 'M9.6 / WP2 offline contract tests (protocol · normalization · candidates · redaction)',
  note: '纯离线：注入假凭据与假 fetch，真实出站 0；不加载 .env、不碰数据库、不写历史证据。无时钟字段 ⇒ 除 head 外重复运行逐字节相同。',
  head,
  passed,
  failed,
  failures,
  checks,
  declaredCodes: [...JEV_FAILURE_CODES],
  reachedCodes: [...observedCodes].sort(),
  unReachedCodes: notReached,
  protocolFacts: JEV_PROTOCOL_FACTS,
  realEgressAttempts,
}
mkdirSync(join(ROOT, 'artifacts', 'm9.6'), { recursive: true })
writeFileSync(join(ROOT, 'artifacts', 'm9.6', 'contract-tests.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')

console.log(`\nM9.6 WP2 契约测试：${String(passed)} 通过 / ${String(failed)} 失败`)
console.log(`  失败码：声明 ${String(declaredCodes.size)} · 触达 ${String(observedCodes.size)} · 真实出站 ${String(realEgressAttempts)}`)
console.log('  证据：artifacts/m9.6/contract-tests.json')
process.exit(failed > 0 ? 1 : 0)
