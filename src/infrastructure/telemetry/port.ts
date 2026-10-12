/**
 * TelemetryPort —— 观测**导出**的抽象口。
 *
 * ============================================================================
 *  plan 第 47–49 节：观测绝对不能成为业务硬依赖
 * ============================================================================
 *
 *     CharacterTrace（我们的业务数据）
 *            │
 *     TelemetryPort        ← 抽象
 *            ├─ NoopTelemetryAdapter      （默认；测试与无后端环境）
 *            └─ PhoenixTelemetryAdapter   （默认的观测后端）
 *
 * 三条铁律：
 *   1. 业务代码**不许** `import phoenix`（或任何 OTel SDK）散落各处；
 *      它们只能出现在 `infrastructure/telemetry/` 里。
 *   2. 后端不可用时，`Character unavailable` 是不允许发生的 ——
 *      只能是 `Telemetry unavailable`。因此所有导出都是 fire-and-forget，
 *      永远不把异常抛回业务。
 *   3. 不导出正文与密钥（plan 第 45 节）：只导出 id、版本、计数、耗时、状态。
 *
 * 内部 Trace Contract（`CharacterRunTrace`）**不随后端改变**：
 * 换 Langfuse、换自研后端，业务类型一个字都不用动。
 */

import type { CharacterRunTrace, TraceStep } from '../../kernel/contracts/index.ts'

/** 一次导出的载体：只有 id / 版本 / 计数 / 耗时 / 状态 */
export interface TelemetrySpan {
  name: string
  kind: 'chain' | 'llm' | 'tool' | 'internal'
  traceId: string
  /** 父 span（一轮对话的各个步骤挂在同一个根 span 下） */
  parentSpanId?: string
  spanId: string
  startTimeMs: number
  endTimeMs?: number
  status: 'ok' | 'error' | 'unset'
  attributes: Record<string, string | number | boolean>
}

export interface TraceHandle {
  readonly spanId: string
  end(attributes?: Record<string, string | number | boolean>): void
  error(message: string): void
}

/** 一次导出尝试的结果（供测试断言"到底发出去了没有"） */
export interface TelemetryExportRecord {
  spanCount: number
  ok: boolean
  error?: string
}

export interface TelemetryPort {
  readonly name: string
  /** 一次交互的根 span */
  startTrace(trace: CharacterRunTrace): TraceHandle
  /** 某个步骤（模型调用、Context 编译、投影更新……） */
  addSpan(traceId: string, step: TraceStep, parentSpanId?: string): void
  /** 一轮结束 */
  finish(trace: CharacterRunTrace): Promise<void>
  /**
   * 显式 flush（进程退出前调用；失败不抛）
   */
  shutdown(): Promise<void>
  /**
   * 发一组**不由对话轮次产生**的 span（M5.1 WP4 / AT4.6）。
   *
   * ============================================================================
   *  为什么必须补这一个方法，而不是"再建一个端口"
   * ============================================================================
   * 既有端口的形状是 `startTrace(trace: CharacterRunTrace)` —— 它假定
   * **每一条遥测都挂在某一轮对话上**。这在开发者面出现之后就不成立了：
   * 控制命令没有（也不该有）`CharacterRunTrace`（WP3 的 Known Issue 1：
   * `character_traces.input_event_id` 是 NOT NULL 且指向真实对话事件，
   * 编一个假引用就是 D-7 同形状的悬空证据）。
   *
   * 于是只有两个选择：
   *   ① **再加一个端口** —— 那就是第二套真相（G-01），而且"哪个后端该接哪个端口"
   *      会立刻变成一个没人能回答的问题；
   *   ② **把这个端口补宽一点**（就是这里）—— 它仍然是**唯一**的观测出口，
   *      只是不再假定"遥测必须属于某一轮"。
   *
   * 选 ②。它是**追加**（可选方法），既有的 `startTrace`/`addSpan` 语义一个字没动。
   *
   * ⚠️ `traceKey` 只是**本地缓冲的分组键**（用于同一批 span 共用一棵 trace），
   *    不是"某个角色的 traceId" —— 这正是 AT4.3 那句
   *    "不强制所有模块共享同一 ID"的另一半落点。
   */
  emitSpans?: (traceKey: string, spans: readonly TelemetrySpan[]) => Promise<void>
  /**
   * 目前为止的导出记录。
   *
   * 这一个方法让"遥测真的发出去了"可以被**离线断言**（不需要真的起 Phoenix），
   * 也让"Phoenix 离线不影响角色"可以被实测（记录里是失败，但业务照常）。
   */
  exports(): readonly TelemetryExportRecord[]
}

// ---------------------------------------------------------------------------
// Noop
// ---------------------------------------------------------------------------

/**
 * 什么都不做的实现。
 *
 * 它**不是**占位符，而是一个有实际用途的实现：
 *   · 测试环境（SC-007：Phoenix 不可用时角色仍正常聊天）
 *   · 用户不想开遥测时的默认值
 * 因为所有调用点都只依赖接口，所以"关掉遥测"不需要任何 if 分支。
 */
export function createNoopTelemetry(): TelemetryPort {
  const handle: TraceHandle = {
    spanId: 'noop',
    end: () => {},
    error: () => {},
  }
  return {
    name: 'noop',
    startTrace: () => handle,
    addSpan: () => {},
    finish: async () => {},
    /** 无后端时的"发一组 span"就是什么都不做 —— 与 startTrace 同一个语义 */
    emitSpans: async () => {},
    shutdown: async () => {},
    exports: () => [],
  }
}

// ---------------------------------------------------------------------------
// OTLP 负载构造（纯函数，可单测）
// ---------------------------------------------------------------------------

/**
 * OpenInference 的 span kind 取值（Arize 约定）。
 *
 * 手动写上这几个属性，就不需要引入 `@arizeai/openinference-semantic-conventions`：
 * 它们只是字符串常量，而"少一个重量依赖"对 M2.5 是明确要求
 * （plan 第 78/85 节：不做 speculative architecture、新依赖必须过 Gate）。
 */
export const OPENINFERENCE_SPAN_KIND = 'openinference.span.kind'

function toUnixNano(ms: number): string {
  return (BigInt(Math.max(0, Math.floor(ms))) * 1_000_000n).toString()
}

interface OtlpKeyValue {
  key: string
  value: { stringValue?: string; intValue?: string; doubleValue?: number; boolValue?: boolean }
}

function toOtlpValue(value: string | number | boolean): OtlpKeyValue['value'] {
  if (typeof value === 'boolean') return { boolValue: value }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value }
  }
  return { stringValue: value }
}

export interface OtlpSpanInput {
  sessionId: string
  spans: TelemetrySpan[]
}

/**
 * 构造 OTLP/HTTP JSON 负载。
 *
 * 手写而不是用 `@opentelemetry/sdk-node`：那套 SDK 会带来十几个传递依赖
 * 与全局状态，而 M2.5 需要的只是"把几个 span 发到一个 endpoint"。
 * 结果仍然是标准 OTLP，Phoenix 原生接受（`/v1/traces`）。
 */
export function buildOtlpPayload(input: OtlpSpanInput): Record<string, unknown> {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: 'project-lg-character-kernel' } },
            { key: 'service.version', value: { stringValue: 'm2.5' } },
            { key: 'session.id', value: { stringValue: input.sessionId } },
          ],
        },
        scopeSpans: [
          {
            scope: { name: 'project-lg.kernel', version: 'm2.5' },
            spans: input.spans.map((span) => {
              const attributes: OtlpKeyValue[] = [
                { key: OPENINFERENCE_SPAN_KIND, value: { stringValue: span.kind } },
                { key: 'span.kind.source', value: { stringValue: span.name } },
                ...Object.entries(span.attributes).map(([key, value]) => ({
                  key,
                  value: toOtlpValue(value),
                })),
              ]
              return {
                traceId: span.traceId,
                spanId: span.spanId,
                ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
                name: span.name,
                kind: span.kind === 'llm' ? 3 : 1, // SPAN_KIND_CLIENT / INTERNAL
                startTimeUnixNano: toUnixNano(span.startTimeMs),
                endTimeUnixNano: toUnixNano(span.endTimeMs ?? span.startTimeMs),
                attributes,
                status: span.status === 'error' ? { code: 2, message: 'error' } : { code: 1 },
              }
            }),
          },
        ],
      },
    ],
  }
}

// ---------------------------------------------------------------------------
// 工厂
// ---------------------------------------------------------------------------

export interface TelemetryConfig {
  enabled: boolean
  /** 后端类型；M2.5 默认 phoenix（见 ADR-005） */
  adapter: 'noop' | 'phoenix'
  /**
   * OTLP 线上编码。
   *
   * **必须是 protobuf**：实测 Phoenix 的 `/v1/traces` 只接受
   * `Content-Type: application/x-protobuf`（JSON 返回 415），
   * 尽管 OTLP 规范同时定义了 JSON 编码。
   *
   * 保留 `json` 选项的理由：其它后端（或未来的 Phoenix 版本）可能接受 JSON，
   * 且 JSON 更容易人肉排查。默认值取 `protobuf`，因为默认值必须能
   * 对真实后端工作。
   */
  transport: 'protobuf' | 'json'
  endpoint: string
  /** 导出超时（毫秒）。超时即放弃，绝不等它 */
  timeoutMs: number
  sessionId: string
  headers: Record<string, string>
  /** 调试：把负载写进 data/telemetry-dump.jsonl 而不是真发（离线回归用） */
  dumpPath?: string
}

export function readTelemetryConfig(env: NodeJS.ProcessEnv = process.env): TelemetryConfig {
  const truthy = (v: string | undefined, fallback: boolean) => {
    if (v === undefined || v.trim() === '') return fallback
    const n = v.trim().toLowerCase()
    return ['1', 'true', 'yes', 'on'].includes(n) ? true : ['0', 'false', 'no', 'off'].includes(n) ? false : fallback
  }

  const endpoint =
    env.PHOENIX_COLLECTOR_ENDPOINT?.trim() ||
    env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() ||
    'http://127.0.0.1:6006'

  const transport =
    env.CHARACTER_TELEMETRY_TRANSPORT?.trim().toLowerCase() === 'json' ? 'json' : 'protobuf'

  return {
    enabled: truthy(env.CHARACTER_TELEMETRY_ENABLED, false),
    adapter: (env.CHARACTER_TELEMETRY_ADAPTER?.trim().toLowerCase() as 'noop' | 'phoenix') || 'phoenix',
    transport,
    endpoint: endpoint.replace(/\/$/, ''),
    timeoutMs: Number(env.CHARACTER_TELEMETRY_TIMEOUT_MS ?? 2000),
    sessionId: env.CHARACTER_TELEMETRY_SESSION ?? `cli-${process.pid}`,
    headers: env.PHOENIX_API_KEY ? { Authorization: `Bearer ${env.PHOENIX_API_KEY}` } : {},
    dumpPath: env.CHARACTER_TELEMETRY_DUMP?.trim() || undefined,
  }
}
