/**
 * M9.6 WP3 —— **官方 Jev 真实预检**（`pnpm m9.6:preflight`）。
 *
 * ============================================================================
 *  它是什么 / 不是什么
 * ============================================================================
 * ```text
 * ✅ 它是**唯一**会真实出站到 api.typesafe.ai 的入口之一，上限 **20 次**调用。
 * ✅ 它核对：TLS/认证头请求体是否真的被接受 · 响应 `model` 是否与请求一致 ·
 *    `usage` 形状 · Noul/Choice/Score 三种返回形状 · 延迟分布 · 错误映射（含 401）·
 *    响应头里有没有限流信息。
 * ❌ 它**不**评价质量（那要 WP4 的语料），也**不**产生任何采用结论。
 * ```
 *
 * **凭据纪律**（计划 §3.2 逐字）：
 * ```text
 * · 只从**具名变量**取：`M96_JEV_TEST_API_KEY` / `M96_JEV_MODEL`。
 * · **显式**从 `.env.test` 读，**不**继承生产环境的同名变量
 *   （"把继承来的当测试配置证据"正是计划点名禁止的）。
 * · **绝不**回落 `OPENAI_API_KEY`。
 * · Key 只进认证头；不进命令行 / 错误正文 / 报告 / 证据 / git。值**从不**打印。
 * · HTTP 错误先脱敏；拒绝跨域重定向（`redirect: 'error'`）。
 * ```
 * 出口（计划 §8）：接口可用；无 Key / 版本错配 / 计费不明 ⇒ **如实停在预检**，不回落。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import {
  JEV_ENDPOINT,
  JEV_MODELS_ENDPOINT,
  JEV_MODEL_VAR,
  JEV_TEST_KEY_VAR,
  TOTAL_DEADLINE_MS,
  callSystemOne,
  estimateCostUsd,
  redactSecrets,
  resolveJevConfig,
  type JevQuestions,
} from './m9.6-jev-protocol.ts'

const ROOT = resolve('.')
const MAX_PREFLIGHT_CALLS = 20

let calls = 0
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

/* ===========================================================================
 *  显式读 `.env.test`（**不**继承、**不**加载 `.env`）
 * ========================================================================= */

interface ParsedEnv {
  readonly ok: boolean
  readonly vars: Record<string, string>
  readonly reason: string
}

function readTestEnvFile(path: string): ParsedEnv {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return { ok: false, vars: {}, reason: `.env.test 不存在（${path}）` }
  }
  const vars: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const equals = trimmed.indexOf('=')
    if (equals <= 0) continue
    const key = trimmed.slice(0, equals).trim()
    let value = trimmed.slice(equals + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    vars[key] = value
  }
  return { ok: true, vars, reason: 'ok' }
}

/* ===========================================================================
 *  探测原语
 * ========================================================================= */

interface Probe {
  /** ★ 显式种类，**不靠**步名字符串匹配（靠字符串匹配会把 `latency#n` 漏在分母外） */
  readonly kind: 'models' | 'systemone'
  readonly step: string
  readonly ok: boolean
  readonly detail: string
  readonly latencyMs: number | null
  readonly status: number | null
  readonly servedModel: string | null
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number } | null
  readonly costUsd: number | null
  readonly note: string
}

/** `/v1/models`：认证与可达性的最廉价探针 */
async function probeModels(apiKey: string, secrets: readonly string[]): Promise<Probe> {
  calls += 1
  const startedAt = Date.now()
  try {
    const response = await fetch(JEV_MODELS_ENDPOINT, {
      method: 'GET',
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(TOTAL_DEADLINE_MS),
      redirect: 'error',
    })
    const latencyMs = Date.now() - startedAt
    const body = await response.text()
    return {
      kind: 'models',
      step: 'GET /v1/models',
      ok: response.ok,
      detail: `HTTP ${String(response.status)}`,
      latencyMs,
      status: response.status,
      servedModel: null,
      usage: null,
      costUsd: null,
      note: redactSecrets(body.slice(0, 400), secrets),
    }
  } catch (error) {
    return {
      kind: 'models',
      step: 'GET /v1/models',
      ok: false,
      detail: (error as Error).name,
      latencyMs: Date.now() - startedAt,
      status: null,
      servedModel: null,
      usage: null,
      costUsd: null,
      note: redactSecrets((error as Error).message.slice(0, 200), secrets),
    }
  }
}

/** 一次 `systemone` 调用 → Probe（含真实用法与耗时） */
async function probeSystemOne(
  label: string,
  state: string,
  questions: JevQuestions,
  config: { readonly apiKey: string; readonly model: string }
): Promise<{ readonly probe: Probe; readonly success: boolean }> {
  calls += 1
  const startedAt = Date.now()
  const result = await callSystemOne(
    { state, questions },
    { config: { ok: true, apiKey: config.apiKey, model: config.model } }
  )
  const latencyMs = Date.now() - startedAt
  if (!result.ok) {
    return {
      success: false,
      probe: {
        kind: 'systemone',
        step: label,
        ok: false,
        detail: `${result.code}/${result.family}/attempts=${String(result.attempts)}`,
        latencyMs,
        status: null,
        servedModel: null,
        usage: null,
        costUsd: null,
        note: result.detail,
      },
    }
  }
  return {
    success: true,
    probe: {
      kind: 'systemone',
      step: label,
      ok: true,
      detail: `ok/attempts=${String(result.attempts)}`,
      latencyMs,
      status: 200,
      servedModel: result.servedModel,
      usage: result.usage,
      costUsd: estimateCostUsd(result.usage),
      note: `requestId=${String(result.requestId)}（官方无此字段）· usageKnown=${String(result.usageKnown)}`,
    },
  }
}

/* ===========================================================================
 *  主流程
 * ========================================================================= */

section('§0 凭据与配置（只从 .env.test 的具名变量读）')

const parsed = readTestEnvFile(join(ROOT, '.env.test'))
check('★ `.env.test` 可读（凭据只从这里读，不继承生产环境）', parsed.ok, parsed.reason)

const config = resolveJevConfig(parsed.ok ? parsed.vars : {})
if (!config.ok) {
  console.log(`\n⛔ **REFUSED**：${config.missing.join(', ')} 未配置 ⇒ 按计划 §3.2 停在预检，**不回落** OPENAI_API_KEY`)
  console.log('   未发起任何真实调用。')
  process.exit(2)
}

check(
  `★ 两个具名变量都在（${JEV_TEST_KEY_VAR} · ${JEV_MODEL_VAR}）—— 只报存在性，不打印取值`,
  config.apiKey.length > 0 && config.model.length > 0,
  `${JEV_MODEL_VAR}=${config.model} · key 长度 ${String(config.apiKey.length)}（值不打印）`
)
check(
  '★ 端点固定为官方地址（不允许任意 base URL）',
  JEV_ENDPOINT === 'https://api.typesafe.ai/v1/systemone',
  JEV_ENDPOINT
)
console.log(`\n  调用预算：${String(MAX_PREFLIGHT_CALLS)} 次（当前 0）`)

const secrets = [config.apiKey]
const probes: Probe[] = []

/* ---- §1 可达性与认证 ---- */
section('§1 可达性 / TLS / 认证')

const modelsProbe = await probeModels(config.apiKey, secrets)
probes.push(modelsProbe)
check(
  '★ TLS + 认证头被接受：`GET /v1/models` 返回 2xx',
  modelsProbe.ok,
  `${modelsProbe.detail} · ${String(modelsProbe.latencyMs)}ms`
)

/* ---- §2 Noul ---- */
section('§2 Noul（无 confidence）')

const NOUL_QUESTIONS: JevQuestions = {
  impact: {
    type: 'noul',
    instructions: '这句话是否表达了明显的情绪影响（而不只是陈述事实）？',
    criteria: { true: '有明显的情绪影响', false: '没有明显的情绪影响' },
  },
}

const noulProbe = await probeSystemOne(
  'POST /v1/systemone · noul',
  '我今天特别开心，谢谢你一直陪着我。',
  NOUL_QUESTIONS,
  config
)
probes.push(noulProbe.probe)
check('★ Noul 返回被接受且严格归一通过', noulProbe.success, noulProbe.probe.detail)

/* ---- §3 Choice ---- */
section('§3 Choice（choice + probabilities + confidence）')

const CHOICE_QUESTIONS: JevQuestions = {
  route: {
    type: 'choice',
    instructions: '这句话最像下列哪一类？',
    criteria: { gratitude: '表达感谢', hostile: '表达敌意', neutral: '只是陈述' },
  },
}
const choiceProbe = await probeSystemOne('POST /v1/systemone · choice', '谢谢你一直陪着我。', CHOICE_QUESTIONS, config)
probes.push(choiceProbe.probe)
check('★ Choice 返回被接受（选项、概率和都在容差内）', choiceProbe.success, choiceProbe.probe.detail)

/* ---- §4 Score ---- */
section('§4 Score（score + legend）')

const SCORE_QUESTIONS: JevQuestions = {
  intensity: {
    type: 'score',
    instructions: '表达的情绪强度有多高？',
    criteria: ['平静', '略微', '明显', '强烈', '极强'],
  },
}

/*
 * ⚠️ **先看真实形状再写归一化**：本预检第一次运行时，我方对 `legend` 的假设（有序数组）
 *    被判 `legend_mismatch` —— 那是**我方实现**与官方实际返回形状不符，不是服务端故障。
 *    所以这里**单独**做一次原始抓取，把 `answers` 的**真实结构**记进证据，
 *    再据此修正归一化。参数值只有我们自己写的档位描述，不含任何真实用户内容。
 */
async function rawAnswersProbe(
  state: string,
  questions: JevQuestions,
  apiKey: string,
  model: string
): Promise<{ readonly error: string } | { readonly status: number; readonly servedModel: string | null; readonly answers: unknown; readonly usage: unknown }> {
  calls += 1
  try {
    const response = await fetch(JEV_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ state, model, questions }),
      signal: AbortSignal.timeout(TOTAL_DEADLINE_MS),
      redirect: 'error',
    })
    const text = await response.text()
    if (!response.ok) return { error: `HTTP ${String(response.status)}` }
    const parsed = JSON.parse(text) as { model?: unknown; answers?: unknown; usage?: unknown }
    return {
      status: response.status,
      servedModel: typeof parsed.model === 'string' ? parsed.model : null,
      answers: parsed.answers ?? null,
      usage: parsed.usage ?? null,
    }
  } catch (error) {
    return { error: redactSecrets((error as Error).message.slice(0, 200), secrets) }
  }
}

const rawScore = await rawAnswersProbe('我今天特别开心，谢谢你一直陪着我。', SCORE_QUESTIONS, config.apiKey, config.model)
const rawScoreShape =
  'error' in rawScore
    ? { error: rawScore.error }
    : {
        status: rawScore.status,
        servedModel: rawScore.servedModel,
        usage: rawScore.usage,
        answers: rawScore.answers,
      }
console.log(`  原始 answers 形状（用于修正归一化）：${JSON.stringify(rawScoreShape)}`)

const scoreProbe = await probeSystemOne('POST /v1/systemone · score', '我今天特别开心，谢谢你一直陪着我。', SCORE_QUESTIONS, config)
probes.push(scoreProbe.probe)
check('★ Score 返回被接受（score 在档位范围内、legend 与声明一致）', scoreProbe.success, scoreProbe.probe.detail)

/* ---- §5 版本一致性 ---- */
section('§5 版本一致性（错版本必须停止该批）')

const servedModels = probes.map((probe) => probe.servedModel).filter((value): value is string => value !== null)
const allMatch = servedModels.length > 0 && servedModels.every((model) => model === config.model)
check(
  `★ 响应 \`model\` 与请求一致（请求 ${config.model}）`,
  allMatch,
  servedModels.length === 0 ? '无成功响应可核对' : `实际返回：${[...new Set(servedModels)].join(',')}`
)
if (!allMatch && servedModels.length > 0) {
  console.log(`\n⛔ **STOP**：返回版本与请求不一致 ⇒ 按计划 §3.2 停止该评测批次；已产生结果保留，换版本需重新归属。`)
}

/* ---- §6 延迟分布 ---- */
section('§6 延迟分布与失败率（同机同网络实测；G5 的起点读数）')

const LATENCY_SAMPLES = 5
for (let index = 0; index < LATENCY_SAMPLES; index += 1) {
  const probe = await probeSystemOne(`latency#${String(index + 1)}`, '我今天有点累，但还挺好的。', NOUL_QUESTIONS, config)
  probes.push(probe.probe)
}

/*
 * ⚠️ **成功与失败必须分列**（本门第一次运行踩到过）：
 *    把一次 20s 超时混进 min/avg/max，会得到 "avg 4487ms" 这种数 ——
 *    它描述的**不是**"这个 API 平均很慢"，而是"有一次调用挂到了期限"。
 *    AGENTS.md §6.9：数字对 ≠ 数字描述的是你以为的那个东西。
 */
const systemOneProbes = probes.filter((probe) => probe.kind === 'systemone')
const okLatencies = systemOneProbes.filter((probe) => probe.ok && probe.latencyMs !== null).map((probe) => probe.latencyMs as number)
const failuresByCode = new Map<string, number>()
for (const probe of systemOneProbes.filter((item) => !item.ok)) {
  const code = probe.detail.split('/')[0] ?? 'unknown'
  failuresByCode.set(code, (failuresByCode.get(code) ?? 0) + 1)
}
const sortedOk = [...okLatencies].sort((a, b) => a - b)
const latencyStats =
  sortedOk.length === 0
    ? null
    : {
        count: sortedOk.length,
        minMs: sortedOk[0] as number,
        medianMs: sortedOk[Math.floor(sortedOk.length / 2)] as number,
        maxMs: sortedOk[sortedOk.length - 1] as number,
        avgMs: sortedOk.reduce((sum, value) => sum + value, 0) / sortedOk.length,
      }
const rate = (numerator: number, denominator: number): number | null => (denominator === 0 ? null : numerator / denominator)
const timeoutCount = failuresByCode.get('deadline_exceeded') ?? 0

check(
  `★ 延迟采样只在**成功**的调用上算（成功 ${String(sortedOk.length)}/${String(systemOneProbes.length)} 次 systemone 调用）`,
  latencyStats !== null,
  latencyStats === null ? 'NOT RUN（无成功样本）' : `min ${String(latencyStats.minMs)} / median ${String(latencyStats.medianMs)} / max ${String(latencyStats.maxMs)} ms`
)
check(
  '★ **失败率与超时率分列**，分母 = 全部 systemone 尝试（不是"只看成功的"）',
  rate(systemOneProbes.filter((probe) => !probe.ok).length, systemOneProbes.length) !== null,
  `失败 ${String(systemOneProbes.filter((p) => !p.ok).length)}/${String(systemOneProbes.length)} · 超时 ${String(timeoutCount)}/${String(systemOneProbes.length)} · 明细 ${[...failuresByCode.entries()].map(([code, n]) => `${code}×${String(n)}`).join(',') || '无'}`
)
if (timeoutCount > 0) {
  console.log(
    `  ⚠️ **真发现**：${String(LATENCY_SAMPLES)} 次小样本里有 ${String(timeoutCount)} 次调用撞到 ${String(TOTAL_DEADLINE_MS)}ms 总期限。` +
      `\n     这不是偶发：与 L-M55-12（前一个 provider 的真实超时是常态）同型。` +
      `\n     ⇒ 样本太小（n=${String(systemOneProbes.length)}）**不能**据此判定 G5 的 ≤5% 超时率达标或失败；` +
      `\n       必须在 WP4 用冻结语料取更大样本，并把"提高共享总期限"当作**显式政策变更**（要重述代价），不得为了让数字好看而静默调参。` +
      `\n     ⇒ 另注意：总期限**跨重试共用**（计划 §11），所以一次 20s 挂起会吃掉整个预算 ⇒ attempts=1，**根本没有重试机会**。`
  )
}

/* ---- §7 错误映射（401）---- */
section('§7 错误映射：故意用无效 Key 核对 401')

const badKeyProbe = await callSystemOne(
  { state: 'x', questions: NOUL_QUESTIONS },
  { config: { ok: true, apiKey: 'invalid-key-deliberately-wrong', model: config.model } }
)
calls += 1
const badKeyMapped = !badKeyProbe.ok && badKeyProbe.code === 'http_error_unauthenticated' && badKeyProbe.stopBatch === true
check(
  '★ 无效 Key ⇒ 我们的映射给出 `http_error_unauthenticated` 且要求停止整批（不重试）',
  badKeyMapped,
  badKeyProbe.ok ? '意外成功' : `${badKeyProbe.code}/stopBatch=${String(badKeyProbe.stopBatch)}/attempts=${String(badKeyProbe.attempts)}`
)
check(
  '★ 401 的失败详情里**没有** Key（脱敏生效）',
  badKeyProbe.ok || !badKeyProbe.detail.includes(config.apiKey),
  badKeyProbe.ok ? '意外成功' : badKeyProbe.detail
)

/* ---- §8 用量与费用 ---- */
section('§8 usage 与费用（缺失记 UNKNOWN，不记 0）')

const successful = probes.filter((probe) => probe.ok && probe.usage !== null)
const unknownUsage = probes.filter((probe) => probe.ok && probe.usage === null)
const totalInput = successful.reduce((sum, probe) => sum + (probe.usage?.inputTokens ?? 0), 0)
const totalOutput = successful.reduce((sum, probe) => sum + (probe.usage?.outputTokens ?? 0), 0)
const totalCost = successful.reduce((sum, probe) => sum + (probe.costUsd ?? 0), 0)
check(
  '★ 成功响应的 `usage` 可解析（若缺失则记 UNKNOWN 并如实计数）',
  successful.length > 0,
  `${String(successful.length)} 条有 usage · ${String(unknownUsage.length)} 条 UNKNOWN`
)

/* ---- §9 预算 ---- */
section('§9 调用预算')

check(
  `★ 实际调用 **≤ ${String(MAX_PREFLIGHT_CALLS)}** 次（计划 §8 WP3 出口）`,
  calls <= MAX_PREFLIGHT_CALLS,
  `实际 ${String(calls)} 次`
)

/* ===========================================================================
 *  结论与证据
 * ========================================================================= */

const interfaceUsable = modelsProbe.ok && noulProbe.success && choiceProbe.success && scoreProbe.success && allMatch
const verdict = interfaceUsable ? 'USABLE' : !config.ok ? 'REFUSED' : 'NOT USABLE'

section(`§10 预检结论：${verdict}`)

const head = ((): string => {
  try {
    const raw = readFileSync(join(ROOT, '.git', 'HEAD'), 'utf8').trim()
    return raw.startsWith('ref: ') ? readFileSync(join(ROOT, '.git', raw.slice(5).trim()), 'utf8').trim() : raw
  } catch {
    return 'unknown'
  }
})()

const evidence = {
  testId: 'M9.6 / WP3 official Jev preflight (TLS · auth · three question types · version · latency · error mapping · usage)',
  verdict,
  note:
    '真实出站到官方端点。证据只含合成文本、形状摘要、计数与耗时；**不含** Key、认证头或真实对话。' +
    '费用为**估算**（单价来自官方文档 2026-09-29，未与账单核对）。',
  head,
  requestedModel: config.model,
  endpoint: JEV_ENDPOINT,
  modelsEndpoint: JEV_MODELS_ENDPOINT,
  totalDeadlineMs: TOTAL_DEADLINE_MS,
  callsUsed: calls,
  callBudget: MAX_PREFLIGHT_CALLS,
  passed,
  failed,
  failures,
  checks,
  probes: probes.map((probe) => ({
    step: probe.step,
    ok: probe.ok,
    detail: probe.detail,
    latencyMs: probe.latencyMs,
    status: probe.status,
    servedModel: probe.servedModel,
    usage: probe.usage,
    costUsd: probe.costUsd,
    note: probe.note,
  })),
  latencyStats,
  reliability: {
    systemOneAttempts: systemOneProbes.length,
    succeeded: systemOneProbes.filter((probe) => probe.ok).length,
    failed: systemOneProbes.filter((probe) => !probe.ok).length,
    failureRate: rate(systemOneProbes.filter((probe) => !probe.ok).length, systemOneProbes.length),
    timeoutCount,
    timeoutRate: rate(timeoutCount, systemOneProbes.length),
    byCode: Object.fromEntries([...failuresByCode.entries()].sort()),
    note:
      '样本极小（n≈8）⇒ 这些比率只是**起点读数**，不足以判定 G5 的 ≤5% 超时率是否达标。' +
      '总期限跨重试共用 ⇒ 一次挂起即吃掉全部预算、没有重试机会（attempts=1）。',
    sampleTooSmallForG5: true,
  },
  observedScoreAnswerShape: rawScoreShape,
  usage: {
    successfulWithUsage: successful.length,
    successfulWithoutUsage: unknownUsage.length,
    totalInputTokens: totalInput,
    totalOutputTokens: totalOutput,
    estimatedCostUsd: successful.length > 0 ? totalCost : null,
    priceSource: 'official docs 2026-09-29 · $0.042 / 1M input tokens · output free',
    costStatus: 'estimated (未与账号账单核对)',
  },
}

mkdirSync(join(ROOT, 'artifacts', 'm9.6'), { recursive: true })
writeFileSync(join(ROOT, 'artifacts', 'm9.6', 'preflight.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')

console.log(`\nM9.6 WP3 预检：${String(passed)} 通过 / ${String(failed)} 失败 · 调用 ${String(calls)}/${String(MAX_PREFLIGHT_CALLS)}`)
console.log(`  结论：${verdict}`)
if (latencyStats !== null) {
  console.log(`  成功调用延迟：min ${String(latencyStats.minMs)} · median ${String(latencyStats.medianMs)} · max ${String(latencyStats.maxMs)} ms（n=${String(latencyStats.count)}）`)
}
console.log(
  `  可靠性：成功 ${String(systemOneProbes.filter((p) => p.ok).length)}/${String(systemOneProbes.length)} · 超时 ${String(timeoutCount)}/${String(systemOneProbes.length)}（样本小 ⇒ 不足判 G5）`
)
console.log(`  usage：${String(successful.length)} 条有 · ${String(unknownUsage.length)} 条 UNKNOWN · 估算 $${totalCost.toFixed(6)}`)
console.log('  证据：artifacts/m9.6/preflight.json')
process.exit(verdict === 'USABLE' && failed === 0 ? 0 : 1)
