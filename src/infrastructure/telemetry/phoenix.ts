/**
 * PhoenixTelemetryAdapter —— **默认**的观测后端。
 *
 * ============================================================================
 *  为什么是 Phoenix，以及为什么不用它的 SDK
 * ============================================================================
 * Phoenix 基于 OpenTelemetry / OpenInference，同时提供 Tracing、Datasets、
 * Experiments 与 Evaluation，正好覆盖 M3–M12 会用到的"跑一批场景、比较结果"
 * 这件事，所以选它作为默认后端（理由写进 ADR-005）。
 *
 * 但 M2.5 **不引入** `@arizeai/phoenix-otel` / `@opentelemetry/sdk-node`：
 *   · 它们各自带十几个传递依赖与全局状态；
 *   · 我们需要的只是"把几个 span POST 到一个 endpoint"；
 *   · plan 第 85 节的依赖 Gate 要求"删除它以后系统还能不能运行"——
 *     手写 OTLP 让这个答案永远是"能"，因为标准库就够了。
 *
 * 因此本文件只做三件事：
 *   1. 把内部 `CharacterRunTrace` 翻成 OTLP/HTTP JSON（见 port.ts 的纯函数）
 *   2. `fetch` POST 到 `{endpoint}/v1/traces`，异步、带超时
 *   3. **任何失败都只写日志，不抛异常**（铁律 12：遥测不能成为运行时依赖）
 *
 * 可选：`CHARACTER_TELEMETRY_DUMP=<path>` 时把负载写到本地 JSONL 而不发送，
 * 用于离线验证负载形状（CI 里跑的就是这条路径，见 verify-phases-def.ts）。
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/*
 * ⚠️ `logger` 已从 ElizaOS 独立出来（M12 · W2）。
 * ⚠️ 行为**与上游同形**：默认 sink 写 stdout/stderr（上游 `info`→stdout、`warn`/`error`→stderr，
 *    2026-10-19 实测）。"日志去了哪"由 `recentLogs()` / `setLogSink()` 可查 —— 见 logger.ts 的说明。
 */
import { logger } from './logger.ts'

import type { CharacterRunTrace, TraceStep } from '../../kernel/contracts/index.ts'
import {
  buildOtlpPayload,
  createNoopTelemetry,
  type TelemetryConfig,
  type TelemetryExportRecord,
  type TelemetryPort,
  type TelemetrySpan,
  type TraceHandle,
} from './port.ts'
import { encodeOtlpProtobuf, type ResourceAttributes } from './protobuf.ts'

/**
 * 64 位 / 32 位十六进制 id。
 *
 * 不用 `crypto.randomUUID()`：OTLP 要的是定长 hex，而且**确定性更好用**——
 * 同一轮重复导出会得到同一个 trace id，便于去重与复现。
 *
 * ⚠️ 一个真实的坑（被 `scripts/verify-phoenix-live-chat.ts` 抓出）：
 *   纯 hex 字符串里只含 `0-9a-f`，而**纯数字前缀的字节序列恰好是合法的 UTF-8**。
 *   实测导出的 span_id 里出现了 `303365383266…`，也就是 ASCII 的
 *   `"03e82f…"` —— Phoenix 把它当成字符串再编一次码，于是：
 *      · span id 在 UI 里变形（看起来像 id 被改写了）
 *      · start_time 被解析成 1970-01-01（字段错位）
 *   这不是我们的编码器写错了（自测的逐字段断言全绿），而是**id 形态**
 *   触发了解析器的启发式。
 *
 *   修法：让 id 的**首字符落在字母区间**（a-f），使它不可能是一个
 *   合法的 UTF-8/ASCII 数字串。代价为零，仍然满足 OTLP 的定长 hex 要求。
 */
function hexId(byteLength: number, seed: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  let out = ''
  let state = hash || 1
  while (out.length < byteLength * 2) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0
    out += state.toString(16).padStart(8, '0')
  }
  return forceNonDigitFirst(out.slice(0, byteLength * 2))
}

/**
 * 把首字符从数字挪到字母区间，保持定长与 hex 合法性。
 *
 * `0` → `a`、`1` → `b` …… `9` → `j` 会超出 hex；所以用
 * "数字 d → 字母 a+d" 的映射并把结果限制在 a-f：
 * 实际做法是简单地把首字符换成 `a`~`f` 中的一个，
 * 由**原首字符**决定换哪一个（保持确定性）。
 */
function forceNonDigitFirst(id: string): string {
  const first = id[0]
  if (first >= 'a' && first <= 'f') return id
  const digit = first >= '0' && first <= '9' ? first.charCodeAt(0) - 0x30 : 0
  // 0..9 → a..f（取模 6，保证仍是合法 hex 字符，且对同一输入确定性）
  const replacement = String.fromCharCode(0x61 + (digit % 6))
  return replacement + id.slice(1)
}

export function traceHexId(trace: CharacterRunTrace): string {
  return hexId(16, `trace:${trace.characterId}:${String(trace.inputEventId)}:${trace.startedAt}`)
}

/**
 * 从任意种子派生 **32 位 hex** 的 traceId（OTLP 的 `trace_id` 是 16 字节）。
 *
 * M5.1 WP4 需要它：控制命令没有 `CharacterRunTrace`，但它同样需要一棵
 * 合法的 wire trace（OTLP 规定必须是 32 位 hex，编码器会校验）。
 * 派生是**确定性**的（同一个 commandId 永远得到同一个 id），
 * 所以"同一条命令的两批 span"在面板上仍然同属一棵 trace。
 */
export function wireTraceHexId(seed: string): string {
  return hexId(16, seed)
}

export function spanHexId(traceId: string, label: string, index: number): string {
  return hexId(8, `span:${traceId}:${label}:${index}`)
}

interface BufferedTrace {
  hexTraceId: string
  rootSpanId: string
  spans: TelemetrySpan[]
}

export interface PhoenixTelemetryOptions {
  config: TelemetryConfig
  /** 注入 fetch 便于测试（默认全局 fetch） */
  fetchImpl?: typeof fetch
}

/** 资源属性：一轮里的每个 span 都带（Phoenix 用它做 project / session 分组） */
function resourceAttributes(sessionId: string): ResourceAttributes {
  return {
    'service.name': 'project-lg-character-kernel',
    'service.version': 'm2.5',
    'session.id': sessionId,
  }
}

export function createPhoenixTelemetry(options: PhoenixTelemetryOptions): TelemetryPort {
  const { config } = options
  const doFetch = options.fetchImpl ?? fetch
  const url = `${config.endpoint}/v1/traces`

  /** 每轮一个缓冲：一轮结束时一次性 POST（少一次往返、顺序天然正确） */
  const buffers = new Map<string, BufferedTrace>()
  let exportFailures = 0
  const exportLog: TelemetryExportRecord[] = []

  const emit = async (spans: TelemetrySpan[]): Promise<void> => {
    if (spans.length === 0) return

    /*
     * 编码：默认 protobuf。
     *
     * ⚠️ 这里踩过一个真实的坑（记录在 ADR-005）：
     *   最初只实现 JSON 编码，并用一个**本地假接收器**验证通过（HTTP 200）。
     *   但真实 Phoenix 的 /v1/traces 只接受 application/x-protobuf，
     *   对 JSON 返回 **415 Unsupported Media Type** —— 也就是说
     *   "本地全绿"并不等于"接得上真实后端"。假接收器不会校验 Content-Type。
     *   所以现在的默认值是 protobuf，且 JSON 仅作为可选项保留。
     */
    const useProtobuf = config.transport !== 'json'
    const jsonPayload = useProtobuf ? undefined : buildOtlpPayload({ sessionId: config.sessionId, spans })
    const protobufPayload = useProtobuf
      ? encodeOtlpProtobuf({
          resourceAttributes: resourceAttributes(config.sessionId),
          scopeName: 'project-lg.kernel',
          scopeVersion: 'm2.5',
          spans,
        })
      : undefined

    // 离线模式：写本地 JSONL。CI 与"机器上没有 Phoenix"都走这条。
    // 注意 dump 始终用 JSON（可读、可 grep）；protobuf 的字节长度一并记下，
    // 这样离线也能看出编码器产出了多少字节。
    if (config.dumpPath) {
      try {
        mkdirSync(dirname(config.dumpPath), { recursive: true })
        const payload = jsonPayload ?? buildOtlpPayload({ sessionId: config.sessionId, spans })
        const record = {
          ...payload,
          _m2_5: {
            transport: useProtobuf ? 'protobuf' : 'json',
            protobufBytes: protobufPayload?.byteLength ?? null,
          },
        }
        appendFileSync(config.dumpPath, `${JSON.stringify(record)}\n`, 'utf8')
        exportLog.push({ spanCount: spans.length, ok: true })
      } catch (error) {
        exportFailures += 1
        exportLog.push({
          spanCount: spans.length,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })
        logger.debug(`[telemetry] dump 失败（已忽略）: ${String(error)}`)
      }
      return
    }

    // 超时用 AbortController：Phoenix 离线时**不能**拖住聊天主链
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), config.timeoutMs)
    try {
      const response = await doFetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': useProtobuf ? 'application/x-protobuf' : 'application/json',
          ...config.headers,
        },
        // protobuf 要发原始字节；JSON 走字符串。
        // 不用 `BodyInit` 类型名：它属于 DOM lib，本项目只装 @types/node。
        body: protobufPayload
          ? (protobufPayload as unknown as string)
          : JSON.stringify(jsonPayload),
        signal: controller.signal,
      })
      if (!response.ok) {
        exportFailures += 1
        const detail = await response.text().catch(() => '')
        exportLog.push({
          spanCount: spans.length,
          ok: false,
          error: `HTTP ${response.status}${detail ? ` ${detail.slice(0, 120)}` : ''}`,
        })
        logger.debug(
          `[telemetry] Phoenix 拒绝导出 HTTP ${response.status}（已忽略）。` +
            `${response.status === 415 ? '提示：该后端可能只接受 protobuf（CHARACTER_TELEMETRY_TRANSPORT=protobuf）' : ''}`,
        )
      } else {
        exportLog.push({ spanCount: spans.length, ok: true })
      }
    } catch (error) {
      exportFailures += 1
      const message = error instanceof Error ? error.message : String(error)
      exportLog.push({ spanCount: spans.length, ok: false, error: message })
      // 只 debug 级：Phoenix 没开时这句会每轮出现，不该污染 info 日志
      logger.debug(`[telemetry] Phoenix 导出失败（已忽略，不影响角色运行）: ${message}`)
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    name: 'phoenix',

    startTrace(trace: CharacterRunTrace): TraceHandle {
      const hexTraceId = traceHexId(trace)
      const rootSpanId = spanHexId(hexTraceId, 'character.turn', 0)
      const rootSpan: TelemetrySpan = {
        name: 'character.turn',
        kind: 'chain',
        traceId: hexTraceId,
        spanId: rootSpanId,
        startTimeMs: trace.startedAt,
        status: 'unset',
        attributes: {
          'character.id': String(trace.characterId),
          'input.event.id': String(trace.inputEventId),
          'context.compiler.version': trace.contextCompilerVersion ?? 'legacy',
        },
      }
      buffers.set(String(trace.traceId), { hexTraceId, rootSpanId, spans: [rootSpan] })

      return {
        spanId: rootSpanId,
        end: (attributes) => {
          if (attributes) Object.assign(rootSpan.attributes, attributes)
        },
        error: (message) => {
          rootSpan.status = 'error'
          rootSpan.attributes['error.message'] = message
        },
      }
    },

    addSpan(traceId: string, step: TraceStep, parentSpanId?: string): void {
      const buffer = buffers.get(traceId)
      if (!buffer) return
      buffer.spans.push({
        name: `character.${step.kind}`,
        kind: step.kind === 'model_call' ? 'llm' : 'internal',
        traceId: buffer.hexTraceId,
        spanId: spanHexId(buffer.hexTraceId, step.label, buffer.spans.length),
        parentSpanId: parentSpanId ?? buffer.rootSpanId,
        startTimeMs: step.startedAt,
        endTimeMs: step.finishedAt ?? step.startedAt,
        status: step.status === 'failed' ? 'error' : 'ok',
        attributes: { 'step.label': step.label, ...step.attributes },
      })
    },

    async finish(trace: CharacterRunTrace): Promise<void> {
      const buffer = buffers.get(String(trace.traceId))
      buffers.delete(String(trace.traceId))
      if (!buffer) return
      const root = buffer.spans[0]
      root.endTimeMs = trace.finishedAt ?? Date.now()
      root.status = trace.status === 'failed' ? 'error' : 'ok'
      Object.assign(root.attributes, {
        'output.event.id': trace.outputEventId ? String(trace.outputEventId) : '(none)',
        'context.section.ids': trace.contextSectionIds.join(','),
        'context.dropped.sections': trace.droppedSectionIds.join(','),
        'domain.event.count': trace.domainEventIds.length,
        'projection.revision.start': JSON.stringify(trace.projectionRevisionsAtStart),
        'projection.revision.end': JSON.stringify(trace.projectionRevisionsAtEnd),
        'model.profile': trace.modelProfile ?? '(none)',
        // --- M3.5（计划书第 89 节）：感知与意图 ---------------------------
        // 只发**标签**，不发内容：Observation 的正文与 Intent 的 payload
        // 都不进 trace（隐私原则，与 M2.5/M3 一致）。
        // 合成轮次没有它们时发 '(none)'，让面板上"这轮有没有感知"
        // 是一个明确的值，而不是一个缺失的字段。
        'observation.id': trace.observationId ?? '(none)',
        'observation.type': trace.observationType ?? '(none)',
        'intent.id': trace.intentId ?? '(none)',
        'intent.type': trace.intentType ?? '(none)',
        ...(trace.error ? { 'error.message': trace.error } : {}),
      })

      await emit(buffer.spans)
    },

    /*
     * M5.1 WP4 / AT4.6：发一组**不由对话轮次产生**的 span
     * （今天的唯一来源是开发者面：控制命令、规范分类法投影）。
     *
     * 实现就是复用同一个 `emit` —— 也就是说它们与对话 span
     * **共用同一条编码 / 发送 / 失败隔离路径**，而不是旁路。
     * `traceKey` 只用于本地分组，不参与 OTLP（每批自己带 traceId）。
     */
    async emitSpans(_traceKey: string, spans: readonly TelemetrySpan[]): Promise<void> {
      await emit([...spans])
    },

    async shutdown(): Promise<void> {
      if (exportFailures > 0) {
        logger.debug(`[telemetry] 本次运行共有 ${exportFailures} 次导出失败（已忽略）`)
      }
      buffers.clear()
    },

    exports(): readonly TelemetryExportRecord[] {
      return exportLog
    },
  }
}

/**
 * 按配置选择实现。
 *
 * 只有"显式开启"才会走 Phoenix；其余情况一律 Noop ——
 * 于是"Phoenix 离线"在代码层面就等价于"遥测关闭"，不可能影响角色运行。
 */
export function createTelemetry(config: TelemetryConfig, fetchImpl?: typeof fetch): TelemetryPort {
  if (!config.enabled || config.adapter === 'noop') return createNoopTelemetry()
  return createPhoenixTelemetry({ config, fetchImpl })
}
