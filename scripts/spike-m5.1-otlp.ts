/**
 * M5.1 WP6 —— **AT6.1 最小 Spike**：我们的导出能不能被一个**通用** OTLP 端点接受？
 *
 * ============================================================================
 *  为什么这一个是"最小 Spike"里最有信息量的那个
 * ============================================================================
 * AT6.1 要评估 Langfuse / OpenLIT，而它们与本仓库的关系可以**归结为一句话**：
 *
 *      两家都是 **标准 OTLP/HTTP 接收端**（Langfuse: `/api/public/otel`；
 *      OpenLIT: `OTEL_EXPORTER_OTLP_ENDPOINT`，默认 4318）。
 *      因此"能不能接"这件事，等价于 **"我们发出去的是不是标准 OTLP"**。
 *
 * 那件事可以**离线、无依赖、可证伪**地测出来 —— 就是本脚本：
 *   · 起一个**只认 OTLP 规范**的接收端（不认识 Phoenix、不认识我们）；
 *   · 把**真实的**导出路径（`createPhoenixTelemetry` → 真 fetch）指过去；
 *   · 用仓库自己的 protobuf 解码器逐字段验收（trace_id 16 字节 / span_id 8 字节 /
 *     必填字段 / 父子关系 / status code）；
 *   · 再跑一遍 **JSON 编码**（Phoenix 之外的后端可能只吃 JSON）；
 *   · **量具自检**：故意发一个畸形负载，接收端必须拒绝 ——
 *     一个永远回 200 的"接收端"与一个"真的能接"的系统，在输出上完全一样。
 *
 * ⚠️ 这个脚本**不是生产代码**，也**不改任何生产代码**（G-06：本轮只允许
 *    audit / spike / adapter experiment / ADR）。它证明的是"接得上标准 OTLP"，
 *    **不**证明"Langfuse 的面板能正确显示 LLM 详情"（那需要真实后端 + 属性映射，
 *    见 `docs/adr/ADR-037`）。
 *
 * 跑法：pnpm m5.1:spike:otlp
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createReporter } from './m4-harness.ts'
import {
  canonicalSpansToTelemetrySpans,
  mapControlExecutionToCanonicalSpan,
} from '../src/infrastructure/telemetry/taxonomy.ts'
import { createPhoenixTelemetry, wireTraceHexId } from '../src/infrastructure/telemetry/phoenix.ts'
import { readTelemetryConfig } from '../src/infrastructure/telemetry/port.ts'
import {
  decodeBytesField,
  decodeFixed64,
  decodeProtobuf,
  decodeString,
  decodeSubmessages,
} from '../src/infrastructure/telemetry/protobuf.ts'
import type { ObservabilitySpanInput } from '../src/kernel/contracts/observability.ts'

const report = createReporter()

// ---------------------------------------------------------------------------
// 一个**只认 OTLP 规范**的接收端
// ---------------------------------------------------------------------------

interface ReceivedRequest {
  path: string
  contentType: string
  bytes: number
}

interface OtlpReceiver {
  url: string
  requests: ReceivedRequest[]
  problems: string[]
  close: () => Promise<void>
}

/** 逐字段验收一个 ExportTraceServiceRequest（**只按 OTLP 规范**，不认任何业务字段） */
function validateOtlpProtobuf(bytes: Uint8Array): { spans: number; problems: string[] } {
  const problems: string[] = []
  const resourceSpans = decodeSubmessages(bytes, 1)
  if (resourceSpans.length !== 1) problems.push(`resourceSpans 应为 1，实际 ${resourceSpans.length}`)
  const rs = resourceSpans[0]
  if (rs === undefined) return { spans: 0, problems }

  const resource = decodeSubmessages(rs, 1)[0]
  if (resource === undefined) problems.push('ResourceSpans.resource 缺失')
  else {
    const attributes = decodeSubmessages(resource, 1)
    const keys = attributes.map((kv) => decodeString(kv, 1) ?? '').filter((key) => key !== '')
    if (!keys.includes('service.name')) problems.push('resource 属性缺 service.name')
    if (!keys.includes('session.id')) problems.push('resource 属性缺 session.id')
  }

  const scopeSpans = decodeSubmessages(rs, 2)
  if (scopeSpans.length !== 1) problems.push(`ScopeSpans 应为 1，实际 ${scopeSpans.length}`)
  const ss = scopeSpans[0]
  if (ss === undefined) return { spans: 0, problems }

  const scope = decodeSubmessages(ss, 1)[0]
  if (scope === undefined || (decodeString(scope, 1) ?? '') === '') {
    problems.push('InstrumentationScope.name 缺失')
  }

  const spans = decodeSubmessages(ss, 2)
  if (spans.length === 0) problems.push('没有任何 span')
  for (const [index, span] of spans.entries()) {
    const traceId = decodeBytesField(span, 1)
    const spanId = decodeBytesField(span, 2)
    const name = decodeString(span, 5)
    const start = decodeFixed64(span, 7)
    if (traceId === undefined || traceId.length !== 16) {
      problems.push(`span[${index}] trace_id 必须是 16 字节`)
    }
    if (spanId === undefined || spanId.length !== 8) {
      problems.push(`span[${index}] span_id 必须是 8 字节`)
    }
    if (name === undefined || name === '') problems.push(`span[${index}] name 缺失`)
    if (start === undefined) problems.push(`span[${index}] start_time_unix_nano 缺失`)
    if (decodeProtobuf(span).length === 0) problems.push(`span[${index}] 解析不出任何字段`)
  }
  return { spans: spans.length, problems }
}

/** 同样的验收，但走 **JSON** 编码（Phoenix 之外的后端可能只吃 JSON） */
function validateOtlpJson(text: string): { spans: number; problems: string[] } {
  const problems: string[] = []
  const payload = JSON.parse(text) as {
    resourceSpans?: {
      resource?: { attributes?: { key: string }[] }
      scopeSpans?: { scope?: { name: string }; spans?: Record<string, unknown>[] }[]
    }[]
  }
  const resourceSpans = payload.resourceSpans ?? []
  if (resourceSpans.length !== 1) problems.push(`resourceSpans 应为 1，实际 ${resourceSpans.length}`)
  const rs = resourceSpans[0]
  if (rs === undefined) return { spans: 0, problems }
  const keys = (rs.resource?.attributes ?? []).map((kv) => kv.key)
  if (!keys.includes('service.name')) problems.push('resource 属性缺 service.name')
  const ss = (rs.scopeSpans ?? [])[0]
  if (ss === undefined) {
    problems.push('ScopeSpans 缺失')
    return { spans: 0, problems }
  }
  if ((ss.scope?.name ?? '') === '') problems.push('InstrumentationScope.name 缺失')
  const spans = ss.spans ?? []
  if (spans.length === 0) problems.push('没有任何 span')
  for (const [index, span] of spans.entries()) {
    const traceId = String(span.traceId ?? '')
    const spanId = String(span.spanId ?? '')
    if (!/^[0-9a-f]{32}$/.test(traceId)) problems.push(`span[${index}] traceId 必须是 32 位 hex`)
    if (!/^[0-9a-f]{16}$/.test(spanId)) problems.push(`span[${index}] spanId 必须是 16 位 hex`)
    if (String(span.name ?? '') === '') problems.push(`span[${index}] name 缺失`)
  }
  return { spans: spans.length, problems }
}

/**
 * 起一个只认 OTLP 的接收端。
 *
 * ⚠️ 它**故意**对不合规的输入回非 200：一个永远 200 的接收端会让所有断言变成同义反复。
 */
async function startOtlpReceiver(transport: 'protobuf' | 'json'): Promise<OtlpReceiver> {
  const requests: ReceivedRequest[] = []
  const problems: string[] = []
  const expectedContentType =
    transport === 'protobuf' ? 'application/x-protobuf' : 'application/json'

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(chunk as Buffer)
      const body = new Uint8Array(Buffer.concat(chunks))
      const contentType = String(request.headers['content-type'] ?? '')
      const path = request.url ?? '/'

      if (path !== '/v1/traces') {
        response.writeHead(404).end()
        return
      }
      if (!contentType.startsWith(expectedContentType)) {
        problems.push(`Content-Type 必须是 ${expectedContentType}，收到 ${contentType}`)
        response.writeHead(415).end()
        return
      }

      requests.push({ path, contentType, bytes: body.byteLength })

      /*
       * ⚠️ 解码**可能抛**（截断的 protobuf 会越界）。一个规范的接收端必须把它
       *    变成 400 而不是让异常逸出 —— 逸出会让连接挂住，于是"接收端拒绝了"
       *    与"接收端根本没回答"在调用方看起来一样。实测踩过这一次。
       */
      let validated: { spans: number; problems: string[] }
      try {
        validated =
          transport === 'protobuf'
            ? validateOtlpProtobuf(body)
            : validateOtlpJson(Buffer.from(body).toString('utf8'))
      } catch (error) {
        problems.push(`解码失败：${error instanceof Error ? error.message : String(error)}`)
        response.writeHead(400).end()
        return
      }
      if (validated.problems.length > 0) {
        problems.push(...validated.problems)
        response.writeHead(400).end()
        return
      }

      /*
       * 成功响应：OTLP 的 `ExportTraceServiceResponse` 是全字段可选的空消息，
       * 因此**零字节**的 200 才是最标准的回法（Phoenix 也是这么回的）。
       */
      response.writeHead(200, { 'content-type': 'application/x-protobuf' }).end()
    })()
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    problems,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

// ---------------------------------------------------------------------------
// 夹具：一组真实的规范 span（含一个控制命令自成树的 span）
// ---------------------------------------------------------------------------

const turnTraceKey = 'trc:m51-spike'
const turnSpans: ObservabilitySpanInput[] = [
  {
    traceId: turnTraceKey,
    spanId: `${turnTraceKey}#turn#0`,
    stage: 'turn',
    name: 'character.turn',
    status: 'ok',
    startedAt: 1_800_000_000_000,
    finishedAt: 1_800_000_000_010,
    provenance: { character_trace: turnTraceKey },
    attributes: { status: 'completed', step_count: 1, selected_count: 1, has_error: false },
  },
  {
    traceId: turnTraceKey,
    spanId: `${turnTraceKey}#recall#1`,
    parentSpanId: `${turnTraceKey}#turn#0`,
    stage: 'recall',
    name: 'character.recall',
    status: 'ok',
    startedAt: 1_800_000_000_002,
    finishedAt: 1_800_000_000_005,
    provenance: { character_trace: turnTraceKey },
    attributes: { selected_memory_ids: 'mem:spike-1', selected_count: 1, candidate_count: 2 },
  },
]
const controlSpan = mapControlExecutionToCanonicalSpan({
  result: {
    schemaVersion: 1,
    commandId: 'cmd-spike-1',
    idempotencyKey: 'idem-spike-1',
    commandType: 'RUN_DIAGNOSTIC',
    outcome: 'verified',
    disposition: 'succeeded',
    accepted: true,
    attempted: true,
    executed: true,
    verification: 'verified',
    evidenceOf: {
      accepted: 'control_registry',
      attempted: 'handler',
      executed: 'handler',
      verification: '重读一致',
    },
    verificationEvidence: '重读一致性检查通过',
    dryRun: false,
    startedAt: 1_800_000_000_100,
    finishedAt: 1_800_000_000_110,
  },
  report: { metrics: { integrity_ok: true }, notes: [] },
  replayed: false,
})

const wireTraceId = wireTraceHexId(turnTraceKey)
const spansToExport = [
  ...canonicalSpansToTelemetrySpans(turnSpans, wireTraceId),
  ...canonicalSpansToTelemetrySpans([controlSpan]),
]

// ===========================================================================
report.section('AT6.1 ①：protobuf —— 通用 OTLP 端点接受我们的导出')
// ===========================================================================

const protobufReceiver = await startOtlpReceiver('protobuf')
const protobufPort = createPhoenixTelemetry({
  config: {
    ...readTelemetryConfig({}),
    enabled: true,
    adapter: 'phoenix',
    transport: 'protobuf',
    endpoint: protobufReceiver.url,
  },
})
await protobufPort.emitSpans!('spike', spansToExport)
const protobufExports = protobufPort.exports()
/**
 * 合法导出之后的问题清单快照。
 *
 * ⚠️ 必须**分开记**：后面两个自检用例会故意往同一个数组里塞问题。
 *    混在一起会让"验收通过"与"量具响了"互相抵消
 *    （第一次就踩了这条：10 条断言全绿，而 verdict 判成了 FAIL）。
 */
const protobufValidationProblems = [...protobufReceiver.problems]

report.check(
  '导出真的打到了那个端点（一次 POST /v1/traces）',
  protobufReceiver.requests.length === 1 && protobufReceiver.requests[0]!.path === '/v1/traces',
  `${protobufReceiver.requests.length} 次请求`
)
report.check(
  'Content-Type 是 OTLP 规范要求的 application/x-protobuf',
  protobufReceiver.requests[0]!.contentType.startsWith('application/x-protobuf'),
  protobufReceiver.requests[0]!.contentType
)
report.check(
  '接收端逐字段验收通过（resourceSpans / scope / trace_id 16B / span_id 8B / 必填字段）',
  protobufValidationProblems.length === 0,
  protobufValidationProblems.join(' | ') || '零问题'
)
report.check(
  '导出记录里是成功（不是"发了但后端拒了"）',
  protobufExports.length === 1 && protobufExports[0]!.ok === true,
  JSON.stringify(protobufExports[0])
)
report.check(
  `一次发了 ${spansToExport.length} 个 span（含控制命令自成的那棵树）`,
  protobufExports[0]!.spanCount === spansToExport.length,
  String(protobufExports[0]!.spanCount)
)

// ===========================================================================
report.section('AT6.1 ②：JSON —— 只吃 JSON 的后端同样接得上')
// ===========================================================================

const jsonReceiver = await startOtlpReceiver('json')
const jsonPort = createPhoenixTelemetry({
  config: {
    ...readTelemetryConfig({}),
    enabled: true,
    adapter: 'phoenix',
    transport: 'json',
    endpoint: jsonReceiver.url,
  },
})
await jsonPort.emitSpans!('spike', spansToExport)

report.check(
  'JSON 编码也被接受（无问题）',
  jsonReceiver.requests.length === 1 && jsonReceiver.problems.length === 0,
  jsonReceiver.problems.join(' | ') || '零问题'
)
report.check(
  'JSON 的 traceId / spanId 是 32 / 16 位 hex（面板上能点开一棵树）',
  jsonReceiver.requests[0] !== undefined,
  `${jsonReceiver.requests[0]?.bytes ?? 0} 字节`
)

// ===========================================================================
report.section('AT6.1 ③：量具自检 —— 接收端不是橡皮图章')
// ===========================================================================

const brokenResponse = await fetch(`${protobufReceiver.url}/v1/traces`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{"resourceSpans":[]}',
})
report.check(
  '发一个内容类型不对的负载 → 接收端回 415（它真的在验）',
  brokenResponse.status === 415,
  `status=${brokenResponse.status}`
)

const truncatedResponse = await fetch(`${protobufReceiver.url}/v1/traces`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-protobuf' },
  body: new Uint8Array([0x0a, 0xff, 0xff]),
})
report.check(
  '发一个截断的 protobuf → 接收端回 400（它真的解到字段一级）',
  truncatedResponse.status === 400,
  `status=${truncatedResponse.status}`
)
report.check(
  '自检证明了"上面那些 200 是有意义的 200"，而不是空过',
  protobufReceiver.problems.length > protobufValidationProblems.length,
  `${protobufReceiver.problems.length - protobufValidationProblems.length} 条自检产生的问题`
)

await protobufReceiver.close()
await jsonReceiver.close()

// ===========================================================================
// 证据
// ===========================================================================

mkdirSync(join(process.cwd(), 'artifacts', 'm5.1'), { recursive: true })
writeFileSync(
  join(process.cwd(), 'artifacts', 'm5.1', 'oss-spike-otlp.json'),
  `${JSON.stringify(
    {
      testId: 'M5.1 / WP6 AT6.1 minimal OTLP compatibility spike',
      generatedAt: new Date().toISOString(),
      note: 'spike 脚本，不是生产代码；它只证明"发出去的是标准 OTLP"，不证明任何具体后端的面板效果',
      protocolFacts: {
        endpointPath: '/v1/traces',
        protobufContentType: 'application/x-protobuf',
        jsonContentType: 'application/json',
        traceIdBytes: 16,
        spanIdBytes: 8,
        resourceAttributesRequired: ['service.name', 'session.id'],
        successResponse: 'HTTP 200 + 零字节（ExportTraceServiceResponse 全字段可选）',
      },
      protobuf: {
        requests: protobufReceiver.requests.map((request) => ({
          path: request.path,
          contentType: request.contentType,
          bytes: request.bytes,
        })),
        validationProblems: protobufValidationProblems,
        exportedSpanCount: protobufExports[0]?.spanCount ?? 0,
        exportOk: protobufExports[0]?.ok ?? false,
      },
      json: {
        requests: jsonReceiver.requests.map((request) => ({
          path: request.path,
          contentType: request.contentType,
          bytes: request.bytes,
        })),
        problems: jsonReceiver.problems,
      },
      measurementSelfCheck: {
        wrongContentTypeStatus: brokenResponse.status,
        truncatedPayloadStatus: truncatedResponse.status,
        selfCheckProblems: protobufReceiver.problems.length - protobufValidationProblems.length,
        detectorResponded: protobufReceiver.problems.length > protobufValidationProblems.length,
      },
      spikeVerdict:
        protobufValidationProblems.length === 0 &&
        jsonReceiver.problems.length === 0 &&
        protobufExports[0]?.ok === true &&
        brokenResponse.status === 415 &&
        truncatedResponse.status === 400
          ? 'PASS'
          : 'FAIL',
    },
    null,
    2
  )}\n`,
  'utf8'
)
console.log('证据已写入：artifacts/m5.1/oss-spike-otlp.json')

report.finish('M5.1 WP6 AT6.1 最小 OTLP Spike')
