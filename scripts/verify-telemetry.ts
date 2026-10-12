/**
 * M2.5 Phase H 验收：遥测（Phoenix / OTLP）与"观测不是硬依赖"。
 *
 * ============================================================================
 *  这个脚本回答五个问题
 * ============================================================================
 *   1. 我们产出的 protobuf 负载，字段号与嵌套结构对不对？
 *      （Phoenix 的 /v1/traces **只接受 protobuf**，见 ADR-005）
 *   2. HTTP 边界发出的方法 / 路径 / Content-Type / body 是否符合 OTLP？
 *   3. Phoenix 不可达时，角色还能跑吗？
 *   4. 未开启遥测时，行为是否完全等价（Noop）？
 *   5. 真实 Phoenix 能不能查到这些 span？（需 PHOENIX_RUN_LIVE=1）
 *
 * 第 1、2、3、4 节全部离线，CI 里无需 Docker 即可跑。
 *
 * 跑法：
 *   node_modules/.bin/tsx scripts/verify-telemetry.ts
 *   PHOENIX_RUN_LIVE=1 PHOENIX_COLLECTOR_ENDPOINT=http://127.0.0.1:6006 \
 *     node_modules/.bin/tsx scripts/verify-telemetry.ts
 */

import 'dotenv/config'

import { existsSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'

import {
  buildOtlpPayload,
  createNoopTelemetry,
  createTelemetry,
  decodeBytesField,
  decodeFixed64,
  decodeProtobuf,
  decodeString,
  decodeSubmessages,
  decodeVarint,
  encodeOtlpProtobuf,
  readTelemetryConfig,
  type TelemetryConfig,
  type TelemetrySpan,
} from '../src/infrastructure/telemetry/index.ts'
import { createPhoenixTelemetry } from '../src/infrastructure/telemetry/phoenix.ts'
import type { CharacterRunTrace } from '../src/kernel/contracts/index.ts'
import { asCharacterId, asConversationEventId, asTraceId } from '../src/kernel/contracts/index.ts'

let passed = 0
let failed = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (ok) {
    passed += 1
    console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    failed += 1
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const dumpPath = join(process.cwd(), 'data', 'telemetry-dump.jsonl')
if (existsSync(dumpPath)) rmSync(dumpPath)

const baseConfig = (overrides: Partial<TelemetryConfig> = {}): TelemetryConfig => ({
  ...readTelemetryConfig({} as NodeJS.ProcessEnv),
  enabled: true,
  adapter: 'phoenix',
  transport: 'protobuf',
  sessionId: 'verify-telemetry',
  ...overrides,
})

console.log('='.repeat(72))
console.log('M2.5 Phase H 验收：遥测导出与韧性')
console.log('='.repeat(72))

const sampleSpans: TelemetrySpan[] = [
  {
    name: 'character.turn',
    kind: 'chain',
    traceId: 'a'.repeat(32),
    spanId: 'b'.repeat(16),
    startTimeMs: 1_700_000_000_000,
    endTimeMs: 1_700_000_001_234,
    status: 'ok',
    attributes: { 'character.id': 'char_sumuwei', 'domain.event.count': 3 },
  },
  {
    name: 'character.model_call',
    kind: 'llm',
    traceId: 'a'.repeat(32),
    spanId: 'c'.repeat(16),
    parentSpanId: 'b'.repeat(16),
    startTimeMs: 1_700_000_000_100,
    endTimeMs: 1_700_000_000_900,
    status: 'ok',
    // 刻意用带小数的值：这样"浮点走 double_value(4)、整数走 int_value(3)"
    // 两条分支都能被断言到（整数用 800 只会走 int_value）
    attributes: { 'step.label': 'useModel(TEXT_LARGE)', durationMs: 800.5, cached: false },
  },
]

// ---------------------------------------------------------------------------
console.log('\n=== 1. protobuf 编码：字段号与嵌套结构（离线逐字段断言）===')
// ---------------------------------------------------------------------------

const encoded = encodeOtlpProtobuf({
  resourceAttributes: {
    'service.name': 'project-lg-character-kernel',
    'service.version': 'm2.5',
    'session.id': 'verify-telemetry',
  },
  scopeName: 'project-lg.kernel',
  scopeVersion: 'm2.5',
  spans: sampleSpans,
})

check('编码产出非空字节', encoded.byteLength > 0, `${encoded.byteLength} 字节`)

// ExportTraceServiceRequest.resource_spans = 1
const resourceSpansList = decodeSubmessages(encoded, 1)
check('ExportTraceServiceRequest.resource_spans(1) 存在且唯一', resourceSpansList.length === 1)
const resourceSpans = resourceSpansList[0]

// ResourceSpans.resource = 1, .scope_spans = 2
const resourceMsgs = decodeSubmessages(resourceSpans, 1)
const scopeSpansMsgs = decodeSubmessages(resourceSpans, 2)
check('ResourceSpans.resource(1) 存在', resourceMsgs.length === 1)
check('ResourceSpans.scope_spans(2) 存在且唯一', scopeSpansMsgs.length === 1)

// Resource.attributes = 1（KeyValue 列表）
const resourceKvs = decodeSubmessages(resourceMsgs[0], 1)
check('Resource.attributes(1) 有 3 条', resourceKvs.length === 3, `${resourceKvs.length} 条`)
const serviceNameKv = resourceKvs.find((kv) => decodeString(kv, 1) === 'service.name')
check('资源属性里有 service.name', Boolean(serviceNameKv))
const serviceNameValue = serviceNameKv ? decodeSubmessages(serviceNameKv, 2)[0] : undefined
check(
  'KeyValue.value(2) 是 AnyValue，且 AnyValue.string_value(1) 能正确读出',
  serviceNameValue !== undefined
    ? decodeString(serviceNameValue, 1) === 'project-lg-character-kernel'
    : false,
  serviceNameValue ? (decodeString(serviceNameValue, 1) ?? '(空)') : '(没有 value 子消息)',
)

// ScopeSpans.scope = 1, .spans = 2
const scopeMsgs = decodeSubmessages(scopeSpansMsgs[0], 1)
const spanMsgs = decodeSubmessages(scopeSpansMsgs[0], 2)
check('ScopeSpans.scope(1) 存在', scopeMsgs.length === 1)
check('ScopeSpans.spans(2) 有 2 个 span', spanMsgs.length === 2, `${spanMsgs.length} 个`)
check('InstrumentationScope.name(1) 正确', decodeString(scopeMsgs[0], 1) === 'project-lg.kernel')

// Span 逐字段
const root = spanMsgs[0]
check(
  'Span.trace_id(1) 是 16 字节原始字节（不是 32 字符的文本）',
  decodeBytesField(root, 1) !== undefined && Buffer.from(decodeBytesField(root, 1)!).length === 16,
  `${Buffer.from(decodeBytesField(root, 1) ?? []).length} 字节`,
)
check(
  'Span.span_id(2) 是 8 字节原始字节',
  decodeBytesField(root, 2) !== undefined && Buffer.from(decodeBytesField(root, 2)!).length === 8,
  `${Buffer.from(decodeBytesField(root, 2) ?? []).length} 字节`,
)
check('Span.name(5) 正确', decodeString(root, 5) === 'character.turn')

const rootFields = decodeProtobuf(root)
const kindField = rootFields.find((f) => f.fieldNumber === 6)
check('Span.kind(6) = 1（INTERNAL，chain）', kindField?.value === 1n, String(kindField?.value))
check(
  'Span.start_time_unix_nano(7) 是 fixed64 且值精确（uint64 varint 会让后端读成 0）',
  decodeFixed64(root, 7) === 1_700_000_000_000_000_000n,
  String(decodeFixed64(root, 7)),
)
check(
  'Span.end_time_unix_nano(8) 与 start 的差值 = 1234ms',
  decodeFixed64(root, 8)! - decodeFixed64(root, 7)! === 1_234_000_000n,
  String((decodeFixed64(root, 8) ?? 0n) - (decodeFixed64(root, 7) ?? 0n)),
)

const rootAttrs = decodeSubmessages(root, 9)
const attrKeys = rootAttrs.map((kv) => decodeString(kv, 1))
check('Span.attributes(9) 含 openinference.span.kind', attrKeys.includes('openinference.span.kind'))
check('Span.attributes(9) 含 character.id', attrKeys.includes('character.id'))

const intAttr = rootAttrs.find((kv) => decodeString(kv, 1) === 'domain.event.count')
const intValue = intAttr ? decodeSubmessages(intAttr, 2)[0] : undefined
const intValueFields = intValue ? decodeProtobuf(intValue) : []
check(
  '整数字段走 AnyValue.int_value(3) 而不是 double_value(4)',
  intValueFields.some((f) => f.fieldNumber === 3 && f.value === 3n) &&
    !intValueFields.some((f) => f.fieldNumber === 4),
  intValueFields.map((f) => `f${f.fieldNumber}=${String(f.value)}`).join(' ') || '(无)',
)

// Span.status = 15 → Status.code = 2
const statusFields = decodeSubmessages(root, 15)
check('Span.status(15) 存在', statusFields.length === 1)
check(
  'Status.code(3) = 1（OK）—— 注意是 field 3，写成 2 会让状态永远 UNSET',
  decodeVarint(statusFields[0], 3) === 1n,
  String(decodeVarint(statusFields[0], 3)),
)

// 第二个 span：LLM 用 kind=3，parent_span_id=4
const child = spanMsgs[1]
check('子 span 的 Span.kind(6) = 3（CLIENT，llm）',
  decodeProtobuf(child).find((f) => f.fieldNumber === 6)?.value === 3n)
check(
  '子 span 的 parent_span_id(4) 与根 span 的 span_id 一致（raw bytes）',
  Buffer.from(decodeBytesField(child, 4) ?? []).equals(Buffer.from(decodeBytesField(root, 2) ?? [])),
)
check(
  '子 span 的浮点属性走 AnyValue.double_value(4)（整数不能用它，浮点必须用它）',
  (() => {
    const attrs = decodeSubmessages(child, 9)
    const durationKv = attrs.find((kv) => decodeString(kv, 1) === 'durationMs')
    if (!durationKv) return false
    const value = decodeSubmessages(durationKv, 2)[0]
    if (!value) return false
    const fields = decodeProtobuf(value)
    return fields.some((f) => f.fieldNumber === 4) && !fields.some((f) => f.fieldNumber === 3)
  })(),
  (() => {
    const attrs = decodeSubmessages(child, 9)
    const durationKv = attrs.find((kv) => decodeString(kv, 1) === 'durationMs')
    const value = durationKv ? decodeSubmessages(durationKv, 2)[0] : undefined
    return value
      ? decodeProtobuf(value)
          .map((f) => `f${f.fieldNumber}=${String(f.value)}`)
          .join(' ')
      : '(未找到 durationMs)'
  })(),
)

check(
  '子 span 的布尔属性走 AnyValue.bool_value(2)',
  (() => {
    const attrs = decodeSubmessages(child, 9)
    const cachedKv = attrs.find((kv) => decodeString(kv, 1) === 'cached')
    if (!cachedKv) return false
    const value = decodeSubmessages(cachedKv, 2)[0]
    if (!value) return false
    return decodeProtobuf(value).some((f) => f.fieldNumber === 2 && f.value === 0n)
  })(),
)

// 未知字段不该出现：只有我们写的那些字段号
const usedFieldNumbers = new Set(spanMsgs.flatMap((s) => decodeProtobuf(s).map((f) => f.fieldNumber)))
const unexpected = [...usedFieldNumbers].filter((n) => ![1, 2, 4, 5, 6, 7, 8, 9, 15].includes(n))
check('没有写入 Span 之外的字段号', unexpected.length === 0, unexpected.join(',') || '无')

check(
  'protobuf 比 JSON 明显更省（字段名不落线）',
  encoded.byteLength < JSON.stringify(buildOtlpPayload({ sessionId: 'verify-telemetry', spans: sampleSpans })).length,
  `${encoded.byteLength} B vs JSON ${JSON.stringify(buildOtlpPayload({ sessionId: 'verify-telemetry', spans: sampleSpans })).length} B`,
)

// ---------------------------------------------------------------------------
console.log('\n=== 2. HTTP 边界：protobuf 与 JSON 两条线上的实际请求 ===')
// ---------------------------------------------------------------------------

interface ReceivedRequest {
  method: string
  path: string
  contentType: string
  bytes: number
  json?: unknown
}

const received: ReceivedRequest[] = []
const receiver = createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', (chunk: Buffer) => chunks.push(chunk))
  req.on('end', () => {
    const buffer = Buffer.concat(chunks)
    let json: unknown
    try {
      json = JSON.parse(buffer.toString('utf8'))
    } catch {
      json = undefined
    }
    received.push({
      method: req.method ?? '',
      path: req.url ?? '',
      contentType: String(req.headers['content-type'] ?? ''),
      bytes: buffer.length,
      json,
    })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('{}')
  })
})

await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve))
const localEndpoint = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`

const boundaryTrace: CharacterRunTrace = {
  traceId: asTraceId('trc:verify:boundary'),
  characterId: asCharacterId('char_sumuwei'),
  inputEventId: asConversationEventId('cev:char_sumuwei:dm-test:1'),
  contextCompilerVersion: 'context-compiler@1',
  contextSectionIds: ['current-input', 'seed-identity'],
  // M3：身份快照字段（每一轮都必须能查到用了哪版人格）
  identitySourceRefs: ['character-definition:char_sumuwei@1'],
  droppedSectionIds: [],
  sourceConversationEventIds: ['cev:char_sumuwei:dm-test:1'],
  selectedMemoryIds: [],
  projectionRevisionsAtStart: { 'diagnostic-counter': 0 },
  projectionRevisionsAtEnd: { 'diagnostic-counter': 1 },
  domainEventIds: [],
  actionIds: [],
  modelProfile: 'deepseek-flash',
  outputEventId: asConversationEventId('cev:char_sumuwei:dm-test:2'),
  postTurnJobIds: [],
  processorVersions: { 'diagnostic-processor': 'diagnostic-processor@1' },
  steps: [],
  status: 'completed',
  startedAt: Date.now() - 400,
  finishedAt: Date.now(),
}

for (const transport of ['protobuf', 'json'] as const) {
  const port = createPhoenixTelemetry({
    config: baseConfig({ endpoint: localEndpoint, transport, timeoutMs: 3000 }),
  })
  const trace: CharacterRunTrace = { ...boundaryTrace, traceId: asTraceId(`trc:verify:${transport}`) }
  const handle = port.startTrace(trace)
  port.addSpan(
    trace.traceId,
    {
      kind: 'model_call',
      label: `${transport} boundary`,
      startedAt: Date.now() - 120,
      finishedAt: Date.now(),
      status: 'ok',
      attributes: { durationMs: 120 },
    },
    handle.spanId,
  )
  await port.finish(trace)
  handle.end()
  await port.shutdown()

  const request = received[received.length - 1]
  const expectedContentType = transport === 'protobuf' ? 'application/x-protobuf' : 'application/json'
  check(`[${transport}] 用 POST`, request?.method === 'POST', request?.method)
  check(`[${transport}] 打到 /v1/traces`, request?.path === '/v1/traces', request?.path)
  check(
    `[${transport}] Content-Type = ${expectedContentType}`,
    (request?.contentType ?? '').includes(expectedContentType),
    request?.contentType,
  )
  check(`[${transport}] HTTP 200 记为成功导出`, port.exports().every((r) => r.ok))
}

const protobufRequest = received.find((r) => r.contentType.includes('protobuf'))
const jsonRequest = received.find((r) => r.contentType.includes('json'))
check('protobuf 请求体是二进制（无法按 JSON 解析）', protobufRequest?.json === undefined)
check('JSON 请求体可解析（用于人肉排查的备选路径）', typeof jsonRequest?.json === 'object')
check(
  'protobuf 请求比 JSON 请求更省字节',
  (protobufRequest?.bytes ?? 0) > 0 && (protobufRequest?.bytes ?? 0) < (jsonRequest?.bytes ?? 0),
  `${protobufRequest?.bytes} B vs ${jsonRequest?.bytes} B`,
)

await new Promise<void>((resolve) => receiver.close(() => resolve()))

// ---------------------------------------------------------------------------
console.log('\n=== 3. dump 模式：整轮生命周期被完整记录（离线）===')
// ---------------------------------------------------------------------------

const dumpPort = createPhoenixTelemetry({
  config: baseConfig({ endpoint: 'http://127.0.0.1:1', dumpPath }),
})

const dumpTrace: CharacterRunTrace = { ...boundaryTrace, traceId: asTraceId('trc:verify:dump') }
const dumpHandle = dumpPort.startTrace(dumpTrace)
dumpPort.addSpan(
  dumpTrace.traceId,
  {
    kind: 'model_call',
    label: 'useModel(TEXT_LARGE)',
    startedAt: Date.now() - 300,
    finishedAt: Date.now(),
    status: 'ok',
    attributes: { durationMs: 300 },
  },
  dumpHandle.spanId,
)
await dumpPort.finish(dumpTrace)
dumpHandle.end()

check('dump 文件已生成', existsSync(dumpPath))
const dumped = existsSync(dumpPath) ? readFileSync(dumpPath, 'utf8').trim().split('\n').filter(Boolean) : []
check('导出了 1 个负载', dumped.length === 1, `${dumped.length} 行`)

if (dumped.length > 0) {
  const exported = JSON.parse(dumped[0])
  const spans = exported.resourceSpans[0].scopeSpans[0].spans as Record<string, unknown>[]
  check('一轮 = 根 span + 子 span', spans.length === 2, `${spans.length} 个 span`)
  check('子 span 的 parentSpanId 指向根 span', spans[1]?.parentSpanId === spans[0]?.spanId)
  check('所有 span 共享同一个 traceId', spans[0]?.traceId === spans[1]?.traceId)
  check(
    'dump 里标注了线上编码与字节数（离线也能看出编码器产出）',
    exported._m2_5?.transport === 'protobuf' && exported._m2_5?.protobufBytes > 0,
    `transport=${String(exported._m2_5?.transport)} bytes=${String(exported._m2_5?.protobufBytes)}`,
  )

  const rootAttrs2 = (spans[0].attributes as { key: string; value: Record<string, unknown> }[])
  const unwrap = (key: string): string =>
    JSON.stringify(rootAttrs2.find((a) => a.key === key)?.value ?? '')
  check(
    '根 span 记录了输入/输出事件与 Context 版本',
    unwrap('input.event.id').includes('cev:char_sumuwei:dm-test:1') &&
      unwrap('output.event.id').includes('cev:char_sumuwei:dm-test:2') &&
      unwrap('context.compiler.version').includes('context-compiler@1'),
  )
  check(
    '根 span 记录了投影版本变化（可回答"这轮她状态变了吗"）',
    unwrap('projection.revision.start').includes('diagnostic-counter') &&
      unwrap('projection.revision.end').includes('diagnostic-counter'),
  )
  check('负载里没有正文级长文本或密钥', !/OPENAI_API_KEY|Bearer |sk-/.test(JSON.stringify(exported)))
}

// ---------------------------------------------------------------------------
console.log('\n=== 4. Phoenix 离线：导出失败但绝不抛异常、绝不影响业务 ===')
// ---------------------------------------------------------------------------

const deadPort = createPhoenixTelemetry({
  config: baseConfig({ endpoint: 'http://127.0.0.1:1', timeoutMs: 500 }),
})

let threw = false
const deadTrace: CharacterRunTrace = { ...boundaryTrace, traceId: asTraceId('trc:verify:dead') }
try {
  const deadHandle = deadPort.startTrace(deadTrace)
  deadPort.addSpan(deadTrace.traceId, {
    kind: 'model_call',
    label: 'dead endpoint',
    startedAt: Date.now(),
    status: 'ok',
    attributes: {},
  })
  await deadPort.finish(deadTrace)
  deadHandle.end()
  await deadPort.shutdown()
} catch (error) {
  threw = true
  console.log(`     意外抛出：${String(error)}`)
}
check('面向不可达后端时没有任何异常逃逸到调用方', !threw)

const deadSummary = deadPort.exports()
check('导出确实被尝试过', deadSummary.length > 0, `${deadSummary.length} 次`)
check(
  '导出被标记为失败（不是假装成功）',
  deadSummary.length > 0 && deadSummary.every((r) => !r.ok),
  deadSummary.map((r) => r.error).join(' | ').slice(0, 120) || '(没有尝试)',
)

// ---------------------------------------------------------------------------
console.log('\n=== 5. Noop 与关闭态：行为完全等价 ===')
// ---------------------------------------------------------------------------

const noop = createNoopTelemetry()
const noopHandle = noop.startTrace(boundaryTrace)
noopHandle.end()
noopHandle.error('不该抛')
await noop.finish(boundaryTrace)
await noop.shutdown()
check('Noop 不产生导出记录', noop.exports().length === 0)
check('Noop 的名字可辨认', noop.name === 'noop')

check('未启用时工厂返回 Noop（不会偷偷连网）', createTelemetry(baseConfig({ enabled: false })).name === 'noop')
check(
  '显式选 noop 适配器时也返回 Noop',
  createTelemetry(baseConfig({ adapter: 'noop' })).name === 'noop',
)

// ---------------------------------------------------------------------------
console.log('\n=== 6. 真实 Phoenix（PHOENIX_RUN_LIVE=1）===')
// ---------------------------------------------------------------------------

if (process.env.PHOENIX_RUN_LIVE === '1') {
  const endpoint = process.env.PHOENIX_COLLECTOR_ENDPOINT ?? 'http://127.0.0.1:6006'

  let uiReachable = false
  try {
    const ui = await fetch(endpoint, { signal: AbortSignal.timeout(5000) })
    uiReachable = ui.ok
  } catch (error) {
    console.log(`     UI 不可达：${error instanceof Error ? error.message : String(error)}`)
  }
  check(`Phoenix 服务可达（${endpoint}）`, uiReachable)

  const liveTrace: CharacterRunTrace = {
    ...boundaryTrace,
    traceId: asTraceId(`trc:live:${Date.now()}`),
    steps: [],
  }
  const live = createPhoenixTelemetry({
    config: baseConfig({
      endpoint,
      transport: 'protobuf',
      timeoutMs: 10000,
      sessionId: `verify-telemetry-live-${Date.now()}`,
    }),
  })

  const liveHandle = live.startTrace(liveTrace)
  live.addSpan(
    liveTrace.traceId,
    {
      kind: 'model_call',
      label: 'live smoke',
      startedAt: Date.now() - 100,
      finishedAt: Date.now(),
      status: 'ok',
      attributes: { durationMs: 100 },
    },
    liveHandle.spanId,
  )
  await live.finish(liveTrace)
  liveHandle.end()

  const liveRecords = live.exports()
  const accepted = liveRecords.some((r) => r.ok)
  check(
    '真实 Phoenix 接受了 protobuf 导出',
    accepted,
    accepted ? 'HTTP 200' : liveRecords.map((r) => r.error).join(' | '),
  )

  /*
   * 关键一步：不只信 HTTP 200，而是**回查** Phoenix 里到底有没有这些 span。
   * 这正是本地假接收器做不到、而真实后端才暴露问题的地方
   * （JSON 编码在假接收器上 200、在真实 Phoenix 上 415 —— 见 ADR-005）。
   */
  let storedSpans = 0
  let queryNote = '(未查询)'
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const query = new URL(`${endpoint}/v1/projects/default/spans`)
      query.searchParams.set('condition', "name == 'character.turn'")
      query.searchParams.set('limit', '50')
      const response = await fetch(query, { signal: AbortSignal.timeout(5000) })
      if (response.ok) {
        const body = (await response.json()) as { data?: unknown[] }
        storedSpans = Array.isArray(body.data) ? body.data.length : 0
        queryNote = `HTTP 200，查到 ${storedSpans} 个 character.turn span`
        if (storedSpans > 0) break
      } else {
        queryNote = `HTTP ${response.status}`
      }
    } catch (error) {
      queryNote = error instanceof Error ? error.message : String(error)
    }
    await new Promise((resolve) => setTimeout(resolve, 1500))
  }

  check('Phoenix 中能查到我们写入的 span（回查验证，不只信 HTTP 200）', storedSpans > 0, queryNote)

  // JSON 编码在同一后端上应当是**失败**的 —— 这条断言把"为什么默认 protobuf"钉死。
  // 注意必须用**新的 traceId**：缓冲是按 traceId 索引的，复用旧 id 会取不到缓冲，
  // 于是"没有导出尝试"会让 `every(!ok)` 空真通过（虚过），什么也没证明。
  const jsonProbeTrace: CharacterRunTrace = {
    ...liveTrace,
    traceId: asTraceId(`trc:json-probe:${Date.now()}`),
  }
  const jsonProbe = createPhoenixTelemetry({
    config: baseConfig({ endpoint, transport: 'json', timeoutMs: 8000 }),
  })
  jsonProbe.startTrace(jsonProbeTrace)
  await jsonProbe.finish(jsonProbeTrace)

  const jsonProbeRecords = jsonProbe.exports()
  check(
    '同一后端拒绝 JSON 编码（说明默认 protobuf 是必要的，不是偏好）',
    jsonProbeRecords.length > 0 && jsonProbeRecords.every((r) => !r.ok),
    jsonProbeRecords.map((r) => r.error).join(' | ') || '(没有导出尝试 —— 断言无效)',
  )
  await jsonProbe.shutdown()

  await live.shutdown()
  console.log(`  打开 ${endpoint} 可以看到这些 trace（project = default）`)
} else {
  console.log('（未设置 PHOENIX_RUN_LIVE=1，跳过真实 Phoenix 导出验证）')
  console.log('  启用方式：')
  console.log(
    '    docker run -d --name project-lg-phoenix -p 6006:6006 -p 4317:4317 arizephoenix/phoenix:latest',
  )
  console.log('    PHOENIX_RUN_LIVE=1 PHOENIX_COLLECTOR_ENDPOINT=http://127.0.0.1:6006 pnpm eval:telemetry')
}

console.log(`\n${'='.repeat(72)}`)
console.log(`Phase H 结果：${passed} 通过 / ${failed} 失败`)
console.log('='.repeat(72))
process.exit(failed === 0 ? 0 : 1)
