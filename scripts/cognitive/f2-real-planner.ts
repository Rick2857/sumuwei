/**
 * **F2 真实模式的规划器**（唯一含模型调用的模块；只在授权通过的路径里动态加载）。
 *
 * ```text
 * 三臂（协议 `arms` 冻结）：
 *   A  planner_choice       —— 模型规划器；**物理请求只在本模块的 fetch 边界计量**
 *   B  always_authoritative —— 脚本恒定谨慎（**零物理请求**；强基线）
 *   C  planner_choice + 规则—— 模型规划器（同上）；规则否决由产品 F2 分支做
 * ```
 * ⚠️ 计量纪律（本文件是**唯一**的计量点）：
 *   - `meter.beforeRequest(taskId)` 在**发出前**调用（被拒 ⇒ 抛 `F2MeterRefused`，不发出、不计尝试）；
 *   - 响应后 `response.clone().json().usage` ⇒ `meter.charge(...)` **只结算一次**；
 *   - `costConfirmed=false` ⇒ 计量器自己置 `cost_unverifiable`；本模块把该事实如实上报；
 *   - 返回的 `requestCount` = 本次 plan 里**真实发出**的请求数（B=0），供编排层分开统计。
 * ⚠️ 候选顺序是**实验因子**（`candidateOrderPaired`）：模型给候选后，本模块按 `context.order`
 *    做**确定性重排**（缓存优先 / 权威优先），并如实报告 `orderApplied`；顺序**不**由模型自述决定。
 * ⚠️ `fetchImpl` 可被门替换成**假 fetch**（零网络）；import 时不发请求，只有 `plan()` 才会。
 */
import { createHash } from 'node:crypto'
import { createOpenAiTaskPlanner } from '../../src/infrastructure/model/openai-task-planner.ts'
import type { CapabilityRegistry } from '../../src/kernel/action/capability-registry.ts'
import type { F2UnitMeter, F2UnitPlanner, F2UnitPlannerContext } from './f2-unit-runtime.ts'

export const F2_METER_REFUSAL_PREFIX = 'f2_meter_refused'

/** 计量拒绝（`beforeRequest` 的闭集码）；编排层据此记 `meterCode`，**不再**二次扣账。 */
export class F2MeterRefused extends Error {
  constructor (readonly code: string) { super(`${F2_METER_REFUSAL_PREFIX}:${code}`) }
}

/** 从计划里取"写内容"（第一步 args.content）；取不到 ⇒ undefined。 */
export function planWriteContentOf (plan: unknown): string | undefined {
  const steps = (plan as { steps?: readonly { args?: { content?: unknown } }[] } | undefined)?.steps
  const content = steps?.[0]?.args?.content
  return typeof content === 'string' ? content : undefined
}

export type F2CandidateBucket = 'cached' | 'authoritative' | 'other'

/** 候选属于哪个来源桶：**按内容字节**判（不采信标签）。 */
export function candidateBucketOf (
  plan: unknown,
  paths: { readonly cachedBytes: string, readonly authBytes: string },
): F2CandidateBucket {
  const content = planWriteContentOf(plan)
  if (content === undefined) return 'other'
  if (content === paths.cachedBytes) return 'cached'
  if (content === paths.authBytes) return 'authoritative'
  return 'other'
}

/**
 * 按候选顺序因子**确定性重排**（稳定排序）：
 * `cached-first` ⇒ 缓存桶在前；`authoritative-first` ⇒ 权威桶在前；其它桶排最后。
 */
export function orderCandidatesByPrior<T> (
  candidates: readonly T[],
  order: 'cached-first' | 'authoritative-first',
  paths: { readonly cachedBytes: string, readonly authBytes: string },
): T[] {
  const preferred: F2CandidateBucket = order === 'cached-first' ? 'cached' : 'authoritative'
  const rank = (plan: T): number => {
    const bucket = candidateBucketOf(plan, paths)
    if (bucket === 'other') return 2
    return bucket === preferred ? 0 : 1
  }
  return candidates
    .map((plan, index) => ({ plan, index, rank: rank(plan) }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(entry => entry.plan)
}

/** 单次模型调用的**响应形状取证**（零敏感：只记形状/长度/哈希/错误，不记 prompt）。 */
export interface F2PlannerCallDiagnostic {
  readonly callIndex: number
  readonly httpStatus: number | null
  readonly contentType: string | null
  readonly bodyLength: number
  readonly bodySha256: string
  readonly contentShape: 'candidates-array' | 'plan-object' | 'json-array' | 'text' | 'unparsable' | 'empty'
  readonly candidateCount: number | null
  readonly usagePresent: boolean
  readonly finishReason: string | null
  readonly transportError?: string
  readonly contentPreview?: string
  /** 富化取证：envelope 顶层键 / message 键 / reasoning 长度 / token 用量。 */
  readonly envelopeKeys?: readonly string[]
  readonly messageKeys?: readonly string[]
  readonly reasoningLength?: number
  readonly completionTokens?: number | null
  readonly promptTokens?: number | null
  readonly boundedAbort?: boolean
}

export interface F2RealPlannerOptions {
  readonly registry: CapabilityRegistry
  readonly meter: F2UnitMeter
  readonly unit: string
  /** ⚠️ 门用：假 fetch（零网络）。真实路径不传 ⇒ 用 `globalThis.fetch`。 */
  readonly fetchImpl?: typeof fetch
  /** 每次调用的响应形状诊断回调（落盘/报告用）。 */
  readonly onCallDiagnostic?: (diagnostic: F2PlannerCallDiagnostic) => void
  /** 规划器超时（默认 120 s；真实模型在 45 s 处会 abort）。 */
  readonly timeoutMs?: number
  /** 客户端 abort 的有界上限（政策 A；默认 8）。 */
  readonly maxBoundedAborts?: number
  readonly maxCompletionTokens?: number
  /** ⚠️ 任务级执行可选的推理深度（当前固定 'low'；进封存 modelParameters）。 */
  readonly reasoningEffort?: 'low' | 'medium' | 'high'
}

export function createRealPlannerFactory (options: F2RealPlannerOptions) {
  const baseFetch = options.fetchImpl ?? (globalThis.fetch as typeof fetch)
  const maxTokens = options.maxCompletionTokens ?? 8_000
  return (context: F2UnitPlannerContext): F2UnitPlanner => {
    /* B：脚本恒定谨慎 —— **零物理请求**（协议 `always_authoritative`）。 */
    if (context.arm === 'B') {
      return {
        id: `f2-real-B-${options.unit}`,
        endpointHost: 'scripted',
        async plan () {
          return {
            ok: true, requestCount: 0,
            plan: context.authoritativeFirstPlan, candidates: [context.authoritativeFirstPlan],
          }
        },
      }
    }

    const taskId = `${options.unit}:${context.paths.object}`
    let physical = 0
    let reported = 0
    let costUnverifiable = false
    /**
     * ⚠️ 计量拒绝必须**自己记下来**：`createOpenAiTaskPlanner` 会把 fetch 抛出的错误吞成 `call_failed`，
     *    否则编排层看不到 `task_request_cap`（实测过）。拒绝时**不**产生物理请求。
     */
    let refusal: string | undefined
    let callIndex = 0
    const diagnostics: F2PlannerCallDiagnostic[] = []
    const record = (diagnostic: F2PlannerCallDiagnostic): void => {
      diagnostics.push(diagnostic)
      try { options.onCallDiagnostic?.(diagnostic) } catch { /* 诊断不得影响运行 */ }
    }
    const shapeOf = (content: string): { shape: F2PlannerCallDiagnostic['contentShape'], count: number | null } => {
      if (content.trim() === '') return { shape: 'empty', count: null }
      try {
        const parsed = JSON.parse(content) as unknown
        if (Array.isArray(parsed)) return { shape: 'json-array', count: parsed.length }
        if (typeof parsed === 'object' && parsed !== null) {
          const record = parsed as { candidates?: unknown }
          if (Array.isArray(record.candidates)) return { shape: 'candidates-array', count: record.candidates.length }
          return { shape: 'plan-object', count: null }
        }
        return { shape: 'text', count: null }
      } catch { return { shape: 'unparsable', count: null } }
    }

    /** 计量 fetch：**唯一**的物理请求计量点（发出前计数、响应后按 usage 只结算一次）。 */
    const transport: typeof fetch = async (input, init) => {
      const admission = options.meter.beforeRequest(taskId)
      if (!admission.ok) {
        refusal = admission.code
        throw new F2MeterRefused(admission.code)
      }
      const thisCall = callIndex++
      let response: Response
      try {
        response = await baseFetch(input, init)
      } catch (error) {
        /*
         * ⚠️ **网络抛错也必须结算**：账本里已写 `attempt_started`，这里按"成本不可确认"结算
         *    （不补 0、不猜 token）⇒ 计量器置 `cost_unverifiable` 并停止后续请求；然后把错误抛回规划器
         *    （它会转成 `call_failed`，任务环据此停止该题）。
         */
        const aborted = error instanceof Error && error.name === 'AbortError'
        const charged = aborted
          ? options.meter.chargeBoundedUnconfirmed(taskId, 'candidate', 'client_abort')
          : options.meter.charge(taskId, 'candidate', undefined)
        if (!charged.costConfirmed && !aborted) costUnverifiable = true
        if (aborted && 'stopCode' in charged && charged.stopCode === 'cost_unverifiable') costUnverifiable = true
        record({
          callIndex: thisCall, httpStatus: null, contentType: null, bodyLength: 0, bodySha256: '',
          contentShape: 'empty', candidateCount: null, usagePresent: false, finishReason: null,
          boundedAbort: aborted,
          transportError: error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 300) : String(error).slice(0, 300),
        })
        throw error
      }
      physical += 1
      /* ⚠️ 读一次 body 做**形状取证**（clone 后规划器仍能正常读取）。 */
      const rawText = await response.clone().text().catch(() => '')
      let usage: unknown
      let content = ''
      let finishReason: string | null = null
      let envelopeKeys: string[] | undefined
      let messageKeys: string[] | undefined
      let reasoningLength: number | undefined
      let completionTokens: number | null = null
      let promptTokens: number | null = null
      try {
        const body = JSON.parse(rawText) as {
          usage?: unknown
          choices?: { message?: Record<string, unknown>, finish_reason?: unknown }[]
        }
        usage = body.usage
        envelopeKeys = Object.keys(body as Record<string, unknown>)
        const choice = body.choices?.[0]
        const message = choice?.message ?? {}
        messageKeys = Object.keys(message)
        content = typeof message.content === 'string' ? message.content : ''
        const reasoning = message.reasoning_content ?? message.reasoning
        reasoningLength = typeof reasoning === 'string' ? reasoning.length : undefined
        finishReason = typeof choice?.finish_reason === 'string' ? choice.finish_reason : null
        const usageRecord = body.usage as { completion_tokens?: unknown, prompt_tokens?: unknown } | undefined
        completionTokens = typeof usageRecord?.completion_tokens === 'number' ? usageRecord.completion_tokens : null
        promptTokens = typeof usageRecord?.prompt_tokens === 'number' ? usageRecord.prompt_tokens : null
      } catch { usage = undefined }
      const shape = shapeOf(content)
      record({
        callIndex: thisCall,
        httpStatus: response.status,
        contentType: response.headers.get('content-type'),
        bodyLength: rawText.length,
        bodySha256: createHash('sha256').update(rawText).digest('hex').slice(0, 16),
        contentShape: shape.shape,
        candidateCount: shape.count,
        usagePresent: usage !== undefined,
        finishReason,
        ...(envelopeKeys === undefined ? {} : { envelopeKeys }),
        ...(messageKeys === undefined ? {} : { messageKeys }),
        ...(reasoningLength === undefined ? {} : { reasoningLength }),
        completionTokens, promptTokens,
        ...(content === '' ? {} : { contentPreview: content.slice(0, 240) }),
      })
      const charged = options.meter.charge(taskId, 'candidate', usage)
      if (!charged.costConfirmed) costUnverifiable = true
      return response
    }

    const planner = createOpenAiTaskPlanner({
      ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }),
      registry: options.registry, candidateCount: 3, fetchImpl: transport, maxTokens,
      timeoutMs: options.timeoutMs ?? 120_000,
    })

    return {
      id: `f2-real-${context.arm}-${options.unit}`,
      endpointHost: 'openai-compatible',
      async plan (input: unknown) {
        try {
          const result = await planner.plan(input as never)
          const raw = (result as { candidates?: readonly unknown[] }).candidates ?? []
          const candidates = orderCandidatesByPrior(raw, context.order, context.paths)
          const first = candidates[0] ?? (result as { plan?: unknown }).plan
          const delta = physical - reported
          reported = physical
          const refusedCode = refusal
          refusal = undefined
          if (refusedCode !== undefined) {
            return { ok: false, requestCount: 0, failure: 'call_failed' as const, refusal: refusedCode }
          }
          return {
            ok: result.ok,
            plan: first,
            candidates,
            requestCount: delta,
            costUnverifiable,
            diagnostics: [...diagnostics],
            orderApplied: {
              prior: context.order,
              firstCandidate: candidateBucketOf(first, context.paths),
              buckets: candidates.map(plan => candidateBucketOf(plan, context.paths)),
            },
          }
        } catch (error) {
          if (error instanceof F2MeterRefused) {
            return { ok: false, requestCount: 0, failure: 'call_failed' as const, refusal: error.code }
          }
          throw error
        }
      },
    }
  }
}
