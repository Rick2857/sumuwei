/**
 * **模型输出可靠性校准（单次 · 最多 6 次物理请求）**。
 *
 * 唯一问题：现有 8000 completion 额度内能否稳定返回**可执行的完整结构**。
 * 边界：3 个开发输入 × {current, slim} 两种提示，每组合一次、零重试、不补采；
 *      不测学习收益、不制造消费机会；一次运行即裁定。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

const materialPath = process.env.F2_CAL_MATERIAL ?? 'docs/architecture/f2-preregistration-20261025/output-calibration-2026-10-28.json'
const material = JSON.parse(readFileSync(materialPath, 'utf8')) as {
  id: string, digest: string, inputs: { inputId: string, object: string, condition: string, text: string }[]
  promptVariants?: { slim: { proposedSystemPrompt: string } }
  variant?: { variantId: string, reasoningEffort?: 'low' | 'medium' | 'high' }
  scale: { maxPhysicalRequests: number }, metrics: string[], stopRules: string[]
}
/* ⚠️ 规范化字段必须与冻结脚本一致：v2（reasoning_effort）用 variant，v1 用 promptVariants。 */
const canonical = material.variant === undefined
  ? JSON.stringify({
      id: material.id, inputs: material.inputs, promptVariants: material.promptVariants,
      unchanged: (material as unknown as { unchanged: unknown }).unchanged, scale: material.scale,
      metrics: material.metrics, stopRules: material.stopRules,
    })
  : JSON.stringify({
      id: material.id, inputs: material.inputs, variant: material.variant,
      unchanged: (material as unknown as { unchanged: unknown }).unchanged, scale: material.scale,
      metrics: material.metrics, stopRules: material.stopRules,
    })
const digest = createHash('sha256').update(canonical).digest('hex')
if (digest !== material.digest) { console.error(`材料摘要不符：${digest.slice(0, 16)} vs ${material.digest.slice(0, 16)}`); process.exit(3) }

const ACCOUNT_DIR = 'artifacts/cognitive/local/f2-diagnostic-4q'
const AUTH = resolve(ACCOUNT_DIR, 'f2-calibration-authorization.json')
if (!existsSync(AUTH)) { console.error('拒绝运行：缺少校准运行授权文件'); process.exit(3) }
const accountingPath = resolve(ACCOUNT_DIR, 'accounting.jsonl')
const entries = existsSync(accountingPath) ? readFileSync(accountingPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
const usedRequests = entries.reduce((sum: number, entry: { requests?: number }) => sum + Number(entry.requests ?? 0), 0)
const usedTokens = entries.reduce((sum: number, entry: { tokens?: number }) => sum + Number(entry.tokens ?? 0), 0)
const remainingRequests = Math.min(material.scale.maxPhysicalRequests, 24 - usedRequests)
const remainingTokens = Math.max(0, 120_000 - usedTokens)
if (remainingRequests <= 0 || remainingTokens <= 0) { console.error('拒绝运行：累计额度已用尽'); process.exit(3) }

const outDir = resolve('artifacts/local/f2-output-calibration', `run-${Date.now()}`)
mkdirSync(outDir, { recursive: true })
const ledgerPath = resolve(outDir, 'ledger-calibration.jsonl')

const { createF2Meter } = await import('./f2-live-runner-guards.ts')
const { createOpenAiTaskPlanner } = await import('../../src/infrastructure/model/openai-task-planner.ts')
const { createCapabilityRegistry, createDefaultCapabilityDefinitions } = await import('../../src/kernel/action/capability-registry.ts')
const { appendF2AttemptLedger } = await import('./f2-live-runner-guards.ts')

const registry = createCapabilityRegistry(createDefaultCapabilityDefinitions())
const meter = createF2Meter({
  requestsCap: remainingRequests, tokensCap: remainingTokens, perTaskRequests: 1, maxCompletionTokens: 8_000,
  reservationTokens: 4_000, now: () => Date.now(),
  onAttempt: entry => appendF2AttemptLedger(ledgerPath, entry),
})

/** 计量 fetch：发出前 beforeRequest、响应后按 usage 只结算一次。 */
let lastDiagnostic: Record<string, unknown> = {}
let currentTaskId = 'calibration'
const meteredFetch: typeof fetch = async (input, init) => {
  const admission = meter.beforeRequest(currentTaskId)
  if (!admission.ok) throw new Error(`meter_refused:${admission.code}`)
  const response = await fetch(input, init)
  let usage: unknown
  let contentShape = 'empty'
  let candidateCount: number | null = null
  let finishReason: string | null = null
  let reasoningLength: number | undefined
  let bodyLength = 0
  try {
    const text = await response.clone().text()
    bodyLength = text.length
    const body = JSON.parse(text) as { choices?: { message?: Record<string, unknown>, finish_reason?: string }[], usage?: unknown }
    usage = body.usage
    const message = body.choices?.[0]?.message ?? {}
    finishReason = body.choices?.[0]?.finish_reason ?? null
    const content = typeof message.content === 'string' ? message.content : ''
    const reasoning = message.reasoning_content ?? message.reasoning
    reasoningLength = typeof reasoning === 'string' ? reasoning.length : undefined
    try {
      const parsed = JSON.parse(content) as { candidates?: unknown[] }
      if (Array.isArray(parsed.candidates)) { contentShape = 'candidates-array'; candidateCount = parsed.candidates.length } else contentShape = 'plan-object'
    } catch { if (content.trim() !== '') contentShape = 'unparsable' }
  } catch { usage = undefined }
  const charged = meter.charge(currentTaskId, 'calibration', usage)
  lastDiagnostic = { finishReason, contentShape, candidateCount, reasoningLength, bodyLength, usagePresent: usage !== undefined, costConfirmed: charged.costConfirmed, stopCode: charged.stopCode }
  return response
}

/** 本地结构校验（镜像任务契约字段；不是 validateTaskPlan 本身，如实标注）。 */
const validate = (plan: unknown): { ok: boolean, reason?: string } => {
  if (typeof plan !== 'object' || plan === null) return { ok: false, reason: 'plan_not_object' }
  const record = plan as { goal?: unknown, done?: unknown, steps?: unknown }
  if (typeof record.goal !== 'string' || typeof record.done !== 'boolean' || !Array.isArray(record.steps)) return { ok: false, reason: 'plan_fields' }
  if (record.steps.length > 4) return { ok: false, reason: 'too_many_steps' }
  for (const step of record.steps as { capability?: unknown, operation?: unknown, args?: unknown }[]) {
    if (typeof step.capability !== 'string' || typeof step.operation !== 'string' || typeof step.args !== 'object' || step.args === null) return { ok: false, reason: 'step_fields' }
    const args = step.args as { path?: unknown, content?: unknown }
    if (step.capability === 'sandbox.file.write') {
      if (step.operation !== 'write' || typeof args.path !== 'string' || typeof args.content !== 'string') return { ok: false, reason: 'write_args' }
    } else if (step.capability === 'sandbox.file.read') {
      if (step.operation !== 'read' || typeof args.path !== 'string') return { ok: false, reason: 'read_args' }
    } else return { ok: false, reason: 'capability_not_allowed' }
  }
  return { ok: true }
}

const results: Record<string, unknown>[] = []
const variants: ('current' | 'slim' | 'low')[] = material.variant === undefined ? ['current', 'slim'] : ['low']
let stopped: string | undefined
for (const input of material.inputs) {
  for (const variant of variants) {
    if (meter.state().stopCode !== undefined) { stopped = meter.state().stopCode; break }
    const before = meter.state().tokens
    currentTaskId = `${input.inputId}:${variant}`
    const planner = createOpenAiTaskPlanner({
      registry, candidateCount: 3, maxTokens: 8_000, timeoutMs: 120_000, fetchImpl: meteredFetch,
      ...(variant === 'slim' && material.promptVariants !== undefined ? { systemPrompt: material.promptVariants.slim.proposedSystemPrompt } : {}),
      ...(material.variant?.reasoningEffort === undefined ? {} : { reasoningEffort: material.variant.reasoningEffort }),
    })
    let outcome: { ok: boolean, plan?: unknown, candidates?: unknown[], failure?: string }
    try {
      outcome = await planner.plan({ task: input.text, allowedCapabilities: ['sandbox.file.read', 'sandbox.file.write'], executed: [], failures: [] } as never) as never
    } catch (error) {
      outcome = { ok: false, failure: error instanceof Error ? error.message.slice(0, 120) : 'throw' }
    }
    const tokensUsed = meter.state().tokens - before
    const validation = validate(outcome.plan)
    results.push({
      inputId: input.inputId, object: input.object, condition: input.condition, variant,
      ok: outcome.ok, failure: outcome.failure ?? null, candidateCount: (outcome.candidates?.length ?? null),
      planValid: validation.ok, planInvalidReason: validation.reason ?? null,
      tokensUsed, ...lastDiagnostic, meterStop: meter.state().stopCode ?? null,
    })
    if (meter.state().stopCode !== undefined) { stopped = meter.state().stopCode; break }
  }
  if (stopped !== undefined) break
}

const requests = meter.state().requests
const tokens = meter.state().tokens
const report = {
  schema: 'f2-output-calibration@1',
  measuredAt: new Date().toISOString(),
  material: { id: material.id, digest: material.digest },
  budget: { remainingRequests, remainingTokens, usedRequests: requests, usedTokens: tokens, cumulativeRequests: usedRequests + requests, cumulativeTokens: usedTokens + tokens },
  results,
  summary: {
    combinations: results.length,
    truncated: results.filter(item => (item as { finishReason?: string }).finishReason === 'length').length,
    parsed: results.filter(item => (item as { contentShape?: string }).contentShape === 'candidates-array').length,
    planValid: results.filter(item => (item as { planValid?: boolean }).planValid === true).length,
  },
  stopCode: stopped ?? null,
  boundary: [
    '只测输出结构可靠性；不测学习收益、不制造消费机会',
    '每组合一次、零重试、不补采；6 次上限',
    '3 个输入不能证明长期稳定；结论只作阶段依据',
    '本地结构校验镜像契约字段，不是 validateTaskPlan 本身（如实标注）',
  ],
}
writeFileSync(resolve(outDir, 'report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8')
appendFileSync(accountingPath, JSON.stringify({ at: new Date().toISOString(), startMarker: 'calibration', units: 0, requests, tokens, status: stopped === undefined ? 'CALIBRATION_DONE' : 'CALIBRATION_STOPPED' }) + '\n', 'utf8')
rmSync(AUTH, { force: true })
console.log(`校准完成：组合 ${results.length}，请求 ${requests}，token ${tokens}，停止码 ${stopped ?? '无'}`)
for (const item of results) console.log(JSON.stringify(item))
