/**
 * M8.5 WP0 —— **provider 探针**（`pnpm with-test-model pnpm exec tsx scripts/m8.5-wp0-provider-probe.ts`）。
 *
 * ============================================================================
 *  要测什么（执行计划 §8.3 / §6.2：WP1 冻结数值的实测来源）
 * ============================================================================
 * ① 延迟分布：代表性别"语义互动评估"调用的 min/avg/max（→ §8.3 单次超时初值 10s 的校准）。
 * ② 真实用量：prompt / completion / **reasoning tokens**（→ §6.2 的 3,000/600 token 预算校准；
 *    判别器先例实测过"800 token 被思维链吃光 ⇒ finish_reason=length 且 content 缺失"——
 *    语义任务的推理占用必须实测，不能拍脑袋）。
 * ③ 结构化输出合法率：`json_object` 模式下 JSON 可解析 + §7.1 草稿形状合法的比率
 *    （判别器先例：不加 json 模式时合法率仅 38.6%）。
 * ④ span 可靠性信号：UTF-16 code unit 半开区间 [start,end) 是否落在界内
 *    （→ §7.1"偏移 vs 原文短片段"协议选择的第证据）。
 * ⑤ 拒答 / 截断 / tool_calls / 429+Retry-After 计数（→ §8.3 重试政策）。
 *
 * ⚠️ 这不是语义验收：场景"期望家族"只作**一致性信号**记录，语义正确性归 WP13 真模型盲测。
 *    指令是**草稿**（生产 prompt 由 WP2 冻结）；读数只用于 WP1 参数冻结。
 *
 * 隐私纪律（§6.3）：证据只落**闭集码 + 数字 + 计数**——不落模型原始输出、
 * 不落 reasonCode 取值（只记在场 + 长度）、不落指令全文。七个场景全部是
 * 执行计划 §0.2 的**合成示例**，不含任何真实用户数据；不发送 userId/traceId/路径。
 * 传输范式逐条照抄 `openai-search-need-judge.ts` 先例：原生 fetch、恰好一次调用、
 * 硬超时覆盖响应体读取、失败不读错误正文、Retry-After 有上限。
 */
import 'dotenv/config'

import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dirname, '..')

// ---------------------------------------------------------------------------
// 端点（与判别器先例同一套环境变量——不新增凭证来源、不新增出站目标）
// ---------------------------------------------------------------------------

const API_KEY = (process.env.OPENAI_API_KEY ?? '').trim()
const BASE_URL = ((process.env.OPENAI_BASE_URL ?? '').trim() || 'https://api.deepseek.com').replace(/\/+$/, '')
const MODELS = [...new Set(
  [
    (process.env.OPENAI_LARGE_MODEL ?? '').trim() || 'deepseek-v4.1-flash',
    (process.env.OPENAI_SMALL_MODEL ?? '').trim() || 'deepseek-v4.1-flash',
  ].filter((m) => m !== ''),
)]

const PROBE_TIMEOUT_MS = 30_000
const PROBE_MAX_TOKENS = 2_000 // 宽裕上限：要看真实占用，不是先掐死
const REPEATS = 3
const INTER_CALL_DELAY_MS = 300
const RETRY_AFTER_CAP_MS = 60_000

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------
// 场景（执行计划 §0.2 合成示例 + 2 个补充对照；期望家族 = 一致性信号，非验收）
// ---------------------------------------------------------------------------

interface Scenario {
  id: string
  text: string
  probeHint: string
}
const SCENARIOS: Scenario[] = [
  { id: 's1', text: '这回要是没有你，我真不知道怎么收场。', probeHint: 'A-GRATITUDE' },
  { id: 's2', text: '他说你什么都做不好，但我不这么看。', probeHint: 'NEUTRAL/UNCERTAIN（引述他人攻击）' },
  { id: 's3', text: '你可真行，又把我刚才的话忘了。', probeHint: 'A-HOSTILE（责备/反讽）' },
  { id: 's4', text: '前面说得太重了，我收回那句话。', probeHint: 'A-REPAIR' },
  { id: 's5', text: '今天我不太想说话，不是因为你。', probeHint: 'NEUTRAL/UNCERTAIN（个人状态说明）' },
  { id: 's6', text: '对了，那个文件我放桌上了。', probeHint: 'NEUTRAL（普通交互）' },
  { id: 's7', text: '救命，快帮我看看这个报错！', probeHint: 'A-URGENT' },
]

// ---------------------------------------------------------------------------
// 草稿指令（生产版由 WP2 冻结；这里只给探针一个 §7.1 形状的稳定输入）
// ---------------------------------------------------------------------------

const DRAFT_INSTRUCTION = [
  '你是互动语义评估器。下面给你用户对角色"苏沐薇"的当前发言。判断这条发言中',
  '是否存在明确针对她的互动行为（感谢/修复/亲近/安慰/敌意/拒绝/急迫求助）。',
  '只输出一个 JSON 对象，形状如下（不要输出任何其它文本）：',
  '{"decision":"IMPACT|NEUTRAL|UNCERTAIN|OUT_OF_SCOPE","target":"CHARACTER",',
  '"candidates":[{"family":"A-GRATITUDE|A-REPAIR|A-WARM-CONTACT|A-COMFORT|A-HOSTILE|A-REJECTION|A-URGENT",',
  '"span":{"start":<整数>,"end":<整数>}}],"contextRefs":[],"reasonCode":"<简短闭集风格代码>"}',
  '规则：decision=IMPACT 时 candidates 恰有 1..3 项，其余决定 candidates 必须为空数组；',
  'span 是当前发言字符串的 UTF-16 code unit 半开区间 [start,end)（0 ≤ start < end ≤ 发言长度），',
  '指向支撑该分类的最小原文片段；本次没有上文，contextRefs 必须为空数组；',
  '引述他人的话、被明确收回的话不算用户自己的立场；普通事务性交流判 NEUTRAL；',
  '依据不足判 UNCERTAIN，不要猜。',
].join('\n')

function buildProbeMessages(text: string): { role: 'system' | 'user'; content: string }[] {
  return [
    { role: 'system', content: DRAFT_INSTRUCTION },
    { role: 'user', content: `【用户当前发言】${text}` },
  ]
}

// ---------------------------------------------------------------------------
// 严格解析（草稿版 §7.1 形状；未知字段一律拒——与判别器同一条纪律）
// ---------------------------------------------------------------------------

const DECISIONS = new Set(['IMPACT', 'NEUTRAL', 'UNCERTAIN', 'OUT_OF_SCOPE'])
const FAMILIES = new Set([
  'A-GRATITUDE', 'A-REPAIR', 'A-WARM-CONTACT', 'A-COMFORT', 'A-HOSTILE', 'A-REJECTION', 'A-URGENT',
])

interface ParsedProposal {
  decision: string
  families: string[]
  spanCount: number
  spanBoundsOk: boolean
  reasonCodePresent: boolean
  reasonCodeLength: number
}

function parseProbeOutput(raw: string, sourceText: string): ParsedProposal {
  const parsed: unknown = JSON.parse(raw) // 抛出 = parse 失败（传输面之外的解析失败）
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('root_not_object')
  }
  const obj = parsed as Record<string, unknown>
  const known = new Set(['decision', 'target', 'candidates', 'contextRefs', 'reasonCode'])
  for (const key of Object.keys(obj)) {
    if (!known.has(key)) throw new Error(`unknown_field:${key}`)
  }
  if (typeof obj.decision !== 'string' || !DECISIONS.has(obj.decision)) {
    throw new Error('bad_decision')
  }
  if (obj.target !== 'CHARACTER') throw new Error('bad_target')
  if (!Array.isArray(obj.candidates)) throw new Error('bad_candidates')
  if (!Array.isArray(obj.contextRefs)) throw new Error('bad_contextRefs')
  if (obj.contextRefs.length > 0) throw new Error('context_refs_not_empty')
  if (obj.decision === 'IMPACT' && (obj.candidates.length < 1 || obj.candidates.length > 3)) {
    throw new Error('impact_candidate_count')
  }
  if (obj.decision !== 'IMPACT' && obj.candidates.length > 0) {
    throw new Error('non_impact_has_candidates')
  }
  const families: string[] = []
  let spanBoundsOk = true
  for (const candidate of obj.candidates) {
    if (typeof candidate !== 'object' || candidate === null) throw new Error('bad_candidate')
    const c = candidate as Record<string, unknown>
    if (typeof c.family !== 'string' || !FAMILIES.has(c.family)) throw new Error('bad_family')
    families.push(c.family)
    const span = c.span
    if (typeof span !== 'object' || span === null) throw new Error('bad_span')
    const s = span as Record<string, unknown>
    const start = s.start
    const end = s.end
    if (
      typeof start !== 'number' || !Number.isInteger(start) ||
      typeof end !== 'number' || !Number.isInteger(end) ||
      !(start >= 0 && start < end && end <= sourceText.length)
    ) {
      spanBoundsOk = false
    }
  }
  const reasonCode = obj.reasonCode
  return {
    decision: obj.decision,
    families,
    spanCount: obj.candidates.length,
    spanBoundsOk,
    reasonCodePresent: typeof reasonCode === 'string' && reasonCode.length > 0,
    reasonCodeLength: typeof reasonCode === 'string' ? reasonCode.length : 0,
  }
}

// ---------------------------------------------------------------------------
// 闭集形状（照抄判别器：只取长度/计数/闭集枚举，绝不取文本）
// ---------------------------------------------------------------------------

function toFinishReason(raw: unknown): string {
  if (typeof raw !== 'string') return 'other'
  if (['stop', 'length', 'content_filter', 'tool_calls', 'function_call'].includes(raw)) return raw
  return 'other'
}

interface CallRecord {
  scenarioId: string
  model: string
  attempt: number
  httpStatus: number
  latencyTotalMs: number
  finishReason: string
  contentKind: 'string' | 'missing' | 'other'
  refusalPresent: boolean
  toolCallCount: number
  promptTokens: number | null
  completionTokens: number | null
  reasoningTokens: number | null
  parseOk: boolean
  schemaOk: boolean
  parseFailureCode: string
  decision: string
  families: string[]
  spanCount: number
  spanBoundsOk: boolean
  reasonCodePresent: boolean
  reasonCodeLength: number
  retryAfterMs: number
}

function parseRetryAfter(raw: string | null, nowMs: number): number {
  if (raw === null || raw.trim() === '') return -1
  const value = raw.trim()
  if (/^\d+$/.test(value)) return Math.min(Number(value) * 1000, RETRY_AFTER_CAP_MS)
  const at = Date.parse(value)
  if (Number.isNaN(at)) return -1
  return Math.min(Math.max(at - nowMs, 0), RETRY_AFTER_CAP_MS)
}

async function probeCall(
  scenario: Scenario,
  model: string,
  attempt: number
): Promise<CallRecord> {
  const record: CallRecord = {
    scenarioId: scenario.id,
    model,
    attempt,
    httpStatus: 0,
    latencyTotalMs: -1,
    finishReason: 'other',
    contentKind: 'other',
    refusalPresent: false,
    toolCallCount: 0,
    promptTokens: null,
    completionTokens: null,
    reasoningTokens: null,
    parseOk: false,
    schemaOk: false,
    parseFailureCode: '',
    decision: '',
    families: [],
    spanCount: 0,
    spanBoundsOk: true,
    reasonCodePresent: false,
    reasonCodeLength: 0,
    retryAfterMs: -1,
  }
  const started = Date.now()
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, PROBE_TIMEOUT_MS)

  try {
    const response = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: buildProbeMessages(scenario.text),
        temperature: 0,
        max_tokens: PROBE_MAX_TOKENS,
        stream: false,
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    })
    record.httpStatus = response.status
    if (!response.ok) {
      record.retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), Date.now())
      record.latencyTotalMs = Date.now() - started
      record.parseFailureCode = `http_${response.status}` // 不读错误正文
      return record
    }

    // 超时必须覆盖响应体读取（判别器先例的同一条坑）
    const abortedSignal = new Promise<'aborted'>((resolve) => {
      if (controller.signal.aborted) resolve('aborted')
      else controller.signal.addEventListener('abort', () => resolve('aborted'), { once: true })
    })
    const raced = await Promise.race([
      response
        .json()
        .then((value) => ({ kind: 'body' as const, value: value as Record<string, unknown> }))
        .catch(() => ({ kind: 'bad' as const })),
      abortedSignal.then(() => ({ kind: 'aborted' as const })),
    ])
    record.latencyTotalMs = Date.now() - started
    if (raced.kind === 'aborted') {
      record.parseFailureCode = timedOut ? 'timeout' : 'aborted'
      return record
    }
    if (raced.kind === 'bad') {
      record.parseFailureCode = 'response_not_json'
      return record
    }

    const payload = raced.value as {
      choices?: { message?: { content?: unknown; refusal?: unknown; tool_calls?: unknown }; finish_reason?: unknown }[]
      usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; completion_tokens_details?: { reasoning_tokens?: unknown } }
    }
    const choice = payload.choices?.[0]
    const message = choice?.message
    const content = message?.content
    record.finishReason = toFinishReason(choice?.finish_reason)
    record.contentKind = typeof content === 'string' ? 'string' : content === undefined ? 'missing' : 'other'
    record.refusalPresent =
      message !== undefined && message !== null &&
      Object.prototype.hasOwnProperty.call(message, 'refusal') && message.refusal !== null
    record.toolCallCount = Array.isArray(message?.tool_calls) ? message.tool_calls.length : 0
    const toTokens = (raw: unknown): number | null =>
      typeof raw === 'number' && Number.isFinite(raw) ? raw : null
    record.promptTokens = toTokens(payload.usage?.prompt_tokens)
    record.completionTokens = toTokens(payload.usage?.completion_tokens)
    record.reasoningTokens = toTokens(payload.usage?.completion_tokens_details?.reasoning_tokens)

    if (typeof content !== 'string') {
      record.parseFailureCode = 'content_not_string'
      return record
    }
    record.parseOk = true
    try {
      const proposal = parseProbeOutput(content, scenario.text)
      record.schemaOk = true
      record.decision = proposal.decision
      record.families = proposal.families
      record.spanCount = proposal.spanCount
      record.spanBoundsOk = proposal.spanBoundsOk
      record.reasonCodePresent = proposal.reasonCodePresent
      record.reasonCodeLength = proposal.reasonCodeLength
    } catch (error) {
      record.parseFailureCode = `schema:${error instanceof Error ? error.message : 'unknown'}`
    }
    return record
  } catch {
    record.latencyTotalMs = Date.now() - started
    record.parseFailureCode = timedOut ? 'timeout' : 'fetch_error'
    return record
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (API_KEY === '') {
    console.error('[m8.5-wp0-provider-probe] 缺 OPENAI_API_KEY——探针拒绝运行（不回落任何其它凭证来源）')
    process.exitCode = 2
    return
  }
  console.log(
    `[m8.5-wp0-provider-probe] host=${hostOf(BASE_URL)} · models=[${MODELS.join(', ')}] · ` +
      `key 长度=${API_KEY.length}（不打印取值）`
  )

  const records: CallRecord[] = []
  for (const model of MODELS) {
    for (const scenario of SCENARIOS) {
      for (let attempt = 1; attempt <= REPEATS; attempt += 1) {
        const record = await probeCall(scenario, model, attempt)
        records.push(record)
        const mark = record.schemaOk ? '✅' : record.parseOk ? '⚠️' : '❌'
        console.log(
          `${mark} ${scenario.id} ×${attempt} @${model} — ` +
            `${record.httpStatus} ${record.latencyTotalMs}ms ` +
            `p=${record.promptTokens ?? '?'} c=${record.completionTokens ?? '?'} r=${record.reasoningTokens ?? '?'} ` +
            `${record.decision || record.parseFailureCode}`
        )
        await new Promise((r) => setTimeout(r, INTER_CALL_DELAY_MS))
      }
    }
  }

  // ---- 汇总（measured_count 自检：0 次调用 = INVALID）-----------------------
  const byModel = MODELS.map((model) => {
    const rs = records.filter((r) => r.model === model)
    const ok = rs.filter((r) => r.schemaOk)
    const latencies = rs.filter((r) => r.latencyTotalMs > 0).map((r) => r.latencyTotalMs).sort((a, b) => a - b)
    const promptTokens = rs.map((r) => r.promptTokens).filter((t): t is number => t !== null)
    const completionTokens = rs.map((r) => r.completionTokens).filter((t): t is number => t !== null)
    const reasoningTokens = rs.map((r) => r.reasoningTokens).filter((t): t is number => t !== null)
    const avg = (xs: number[]): number => (xs.length === 0 ? -1 : Math.round(xs.reduce((a, b) => a + b, 0) / xs.length))
    return {
      model,
      calls: rs.length,
      schemaOkCount: ok.length,
      parseOkCount: rs.filter((r) => r.parseOk).length,
      jsonParseRate: rs.length === 0 ? -1 : Number((rs.filter((r) => r.parseOk).length / rs.length).toFixed(3)),
      schemaValidRate: rs.length === 0 ? -1 : Number((ok.length / rs.length).toFixed(3)),
      latency: {
        min: latencies[0] ?? -1,
        avg: avg(latencies),
        max: latencies[latencies.length - 1] ?? -1,
      },
      promptTokens: { min: Math.min(...promptTokens, -1), avg: avg(promptTokens), max: Math.max(...promptTokens, -1) },
      completionTokens: { min: Math.min(...completionTokens, -1), avg: avg(completionTokens), max: Math.max(...completionTokens, -1) },
      reasoningTokens: { min: Math.min(...reasoningTokens, -1), avg: avg(reasoningTokens), max: Math.max(...reasoningTokens, -1) },
      truncationCount: rs.filter((r) => r.finishReason === 'length').length,
      refusalCount: rs.filter((r) => r.refusalPresent).length,
      toolCallCount: rs.filter((r) => r.toolCallCount > 0).length,
      http429Count: rs.filter((r) => r.httpStatus === 429).length,
      spanBoundsViolationCount: rs.filter((r) => r.parseOk && !r.spanBoundsOk).length,
      decisionCounts: Object.fromEntries(
        [...new Set(rs.map((r) => r.decision).filter((d) => d !== ''))].map((d) => [d, rs.filter((r) => r.decision === d).length]),
      ),
    }
  })

  const measuredCalls = records.length
  const anySchemaOk = records.some((r) => r.schemaOk)
  const verdict = measuredCalls === 0 ? 'MEASUREMENT INVALID' : anySchemaOk ? 'READINGS OBTAINED' : 'ALL CALLS FAILED'

  const summary = {
    milestone: 'M8.5',
    workPackage: 'WP0',
    experiment: 'provider-probe',
    verdict,
    measuredCalls,
    endpointHost: hostOf(BASE_URL),
    modelsProbed: MODELS,
    keyPresent: true,
    keyLength: API_KEY.length,
    config: {
      timeoutMs: PROBE_TIMEOUT_MS,
      maxTokens: PROBE_MAX_TOKENS,
      temperature: 0,
      responseFormat: 'json_object',
      repeatsPerScenario: REPEATS,
      scenarioCount: SCENARIOS.length,
      instructionKind: 'draft-v0 (production prompt frozen by WP2)',
      spanProtocol: 'utf16-code-unit half-open [start,end)',
    },
    scenarioHints: Object.fromEntries(SCENARIOS.map((s) => [s.id, s.probeHint])),
    byModel,
    records,
  }

  const runId = `wp0-provider-probe-${new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-')}`
  const runDir = join(REPO_ROOT, 'artifacts', 'm8.5', runId)
  mkdirSync(runDir, { recursive: true })
  const evidencePath = join(runDir, 'probe.json')
  writeFileSync(evidencePath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')

  console.log('----------------------------------------------------------------------------')
  for (const m of byModel) {
    console.log(
      `@${m.model}: ${m.calls} 调用 · JSON 合法率 ${m.jsonParseRate} · schema 合法率 ${m.schemaValidRate} · ` +
        `延迟 min/avg/max = ${m.latency.min}/${m.latency.avg}/${m.latency.max}ms · ` +
        `prompt avg ${m.promptTokens.avg} · completion avg ${m.completionTokens.avg} · reasoning avg ${m.reasoningTokens.avg} · ` +
        `截断 ${m.truncationCount} · 拒答 ${m.refusalCount} · 429 ${m.http429Count} · span 越界 ${m.spanBoundsViolationCount}`
    )
  }
  console.log(`M8.5 WP0 provider 探针：${verdict}（${measuredCalls} 次调用）`)
  console.log(`证据：${evidencePath}`)
  process.exitCode = measuredCalls > 0 && anySchemaOk ? 0 : 1
}

main().catch((error) => {
  console.error('[m8.5-wp0-provider-probe] 未预期失败：', error)
  process.exitCode = 1
})
