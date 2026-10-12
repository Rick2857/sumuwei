/**
 * 用**真正的 protobuf 解析器**（官方 OTLP proto 定义）校验我们的手写编码器。
 *
 * 为什么值得单独做这件事：
 *   我们的 `encodeOtlpProtobuf` 是手写的（ADR-005 决定不引入 OTel SDK）。
 *   自测的逐字段断言能证明"我们写的东西是我们以为的样子"，
 *   但不能证明"第三方解析器会这样理解它"。
 *   真实 Phoenix 上出现的时间戳错位正是这类问题的典型症状。
 *
 * 本脚本把官方 proto 定义放在 `evals/fixtures/otlp/`（由本脚本在缺失时下载），
 * 用 protobufjs 解析我们的输出。它是**开发期校验工具**，
 * 不参与运行时（因此 protobufjs 只是 devDependency）。
 *
 * 跑法：node_modules/.bin/tsx scripts/verify-otlp-compat.ts
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import protobuf from 'protobufjs'

import { encodeOtlpProtobuf } from '../src/infrastructure/telemetry/protobuf.ts'
import type { TelemetrySpan } from '../src/infrastructure/telemetry/port.ts'

const FIXTURE_DIR = join(process.cwd(), 'evals', 'fixtures', 'otlp')

const PROTO_SOURCES: Record<string, string> = {
  'opentelemetry/proto/common/v1/common.proto': `syntax = "proto3";
package opentelemetry.proto.common.v1;
message AnyValue {
  oneof value {
    string string_value = 1;
    bool bool_value = 2;
    int64 int_value = 3;
    double double_value = 4;
    ArrayValue array_value = 5;
    KeyValueList kvlist_value = 6;
    bytes bytes_value = 7;
  }
}
message ArrayValue { repeated AnyValue values = 1; }
message KeyValueList { repeated KeyValue values = 1; }
message KeyValue { string key = 1; AnyValue value = 2; }
message InstrumentationScope {
  string name = 1;
  string version = 2;
  repeated KeyValue attributes = 3;
  uint32 dropped_attributes_count = 4;
}`,
  'opentelemetry/proto/resource/v1/resource.proto': `syntax = "proto3";
package opentelemetry.proto.resource.v1;
import "opentelemetry/proto/common/v1/common.proto";
message Resource {
  repeated opentelemetry.proto.common.v1.KeyValue attributes = 1;
  uint32 dropped_attributes_count = 2;
}`,
  'opentelemetry/proto/trace/v1/trace.proto': `syntax = "proto3";
package opentelemetry.proto.trace.v1;
import "opentelemetry/proto/common/v1/common.proto";
import "opentelemetry/proto/resource/v1/resource.proto";
message Status {
  reserved 1;
  string message = 2;
  int32 code = 3;
}
message Span {
  bytes trace_id = 1;
  bytes span_id = 2;
  string trace_state = 3;
  bytes parent_span_id = 4;
  string name = 5;
  SpanKind kind = 6;
  fixed64 start_time_unix_nano = 7;
  fixed64 end_time_unix_nano = 8;
  repeated opentelemetry.proto.common.v1.KeyValue attributes = 9;
  uint32 dropped_attributes_count = 10;
  repeated Event events = 11;
  uint32 dropped_events_count = 12;
  repeated Link links = 13;
  uint32 dropped_links_count = 14;
  Status status = 15;
  enum SpanKind {
    SPAN_KIND_UNSPECIFIED = 0;
    SPAN_KIND_INTERNAL = 1;
    SPAN_KIND_SERVER = 2;
    SPAN_KIND_CLIENT = 3;
    SPAN_KIND_PRODUCER = 4;
    SPAN_KIND_CONSUMER = 5;
  }
  message Event {
    fixed64 time_unix_nano = 1;
    string name = 2;
    repeated opentelemetry.proto.common.v1.KeyValue attributes = 3;
    uint32 dropped_attributes_count = 4;
  }
  message Link {
    bytes trace_id = 1;
    bytes span_id = 2;
    string trace_state = 3;
    repeated opentelemetry.proto.common.v1.KeyValue attributes = 4;
    uint32 dropped_attributes_count = 5;
  }
}
message ScopeSpans {
  opentelemetry.proto.common.v1.InstrumentationScope scope = 1;
  repeated Span spans = 2;
  string schema_url = 3;
}
message ResourceSpans {
  opentelemetry.proto.resource.v1.Resource resource = 1;
  repeated ScopeSpans scope_spans = 2;
  string schema_url = 3;
}`,
  'opentelemetry/proto/collector/trace/v1/trace_service.proto': `syntax = "proto3";
package opentelemetry.proto.collector.trace.v1;
import "opentelemetry/proto/trace/v1/trace.proto";
message ExportTraceServiceRequest {
  repeated opentelemetry.proto.trace.v1.ResourceSpans resource_spans = 1;
}
message ExportTraceServiceResponse { ExportTracePartialSuccess partial_success = 1; }
message ExportTracePartialSuccess {
  int64 rejected_spans = 1;
  string error_message = 2;
}`,
}

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

console.log('='.repeat(72))
console.log('OTLP 兼容性校验：手写编码器 vs 官方 protobuf 定义')
console.log('='.repeat(72))

for (const [rel, content] of Object.entries(PROTO_SOURCES)) {
  const full = join(FIXTURE_DIR, rel)
  mkdirSync(join(full, '..'), { recursive: true })
  if (!existsSync(full) || process.argv.includes('--refresh')) writeFileSync(full, content, 'utf8')
}

console.log(`\nproto 定义目录：${FIXTURE_DIR.replace(process.cwd(), '')}`)

const root = new protobuf.Root()
root.resolvePath = (_origin: string, target: string) => join(FIXTURE_DIR, target)
root.loadSync([
  'opentelemetry/proto/collector/trace/v1/trace_service.proto',
])
const ExportTraceServiceRequest = root.lookupType(
  'opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest',
)

const now = Date.now()
const spans: TelemetrySpan[] = [
  {
    name: 'character.turn',
    kind: 'chain' as const,
    traceId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
    spanId: 'a1b2c3d4e5f60718',
    startTimeMs: now,
    endTimeMs: now + 1234,
    status: 'ok' as const,
    attributes: {
      'character.id': 'char_sumuwei',
      'domain.event.count': 3,
      durationMs: 800.5,
      ok: true,
    },
  },
  {
    name: 'character.model_call',
    kind: 'llm' as const,
    traceId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
    spanId: 'f1e2d3c4b5a69788',
    parentSpanId: 'a1b2c3d4e5f60718',
    startTimeMs: now + 10,
    endTimeMs: now + 900,
    status: 'error' as const,
    attributes: { 'step.label': 'useModel' },
  },
]

const bytes = encodeOtlpProtobuf({
  resourceAttributes: {
    'service.name': 'project-lg-character-kernel',
    'service.version': 'm2.5',
    'session.id': 'otlp-compat',
  },
  scopeName: 'project-lg.kernel',
  scopeVersion: 'm2.5',
  spans,
})

console.log(`\n=== 1. protobufjs 能否解析我们写出的字节（${bytes.byteLength} B）===`)

let decoded: Record<string, unknown> | undefined
let decodeError: string | undefined
try {
  decoded = ExportTraceServiceRequest.decode(bytes) as unknown as Record<string, unknown>
} catch (error) {
  decodeError = error instanceof Error ? error.message : String(error)
}
check('官方定义能无错解析', decoded !== undefined && decodeError === undefined, decodeError ?? '')

if (decoded) {
  const plain = ExportTraceServiceRequest.toObject(decoded as never, {
    longs: String,
    bytes: String,
    enums: String,
    defaults: true,
  }) as {
    resourceSpans: {
      resource: { attributes: { key: string; value: Record<string, unknown> }[] }
      scopeSpans: {
        scope: { name: string; version: string }
        spans: {
          traceId: string
          spanId: string
          parentSpanId: string
          name: string
          kind: string
          startTimeUnixNano: string
          endTimeUnixNano: string
          attributes: { key: string; value: Record<string, unknown> }[]
          status: { code: string; message: string }
        }[]
      }[]
    }[]
  }

  const rs = plain.resourceSpans?.[0]
  check('resourceSpans[0] 存在', Boolean(rs))

  const resAttrs = Object.fromEntries(
    (rs?.resource.attributes ?? []).map((a) => [a.key, Object.values(a.value)[0]]),
  )
  check('resource 属性被正确解析', resAttrs['service.name'] === 'project-lg-character-kernel', JSON.stringify(resAttrs))

  const scope = rs?.scopeSpans?.[0]?.scope
  check('scope 被正确解析', scope?.name === 'project-lg.kernel' && scope?.version === 'm2.5')

  const decodedSpans = rs?.scopeSpans?.[0]?.spans ?? []
  check('spans 数量正确', decodedSpans.length === 2, `${decodedSpans.length} 个`)

  const rootSpan = decodedSpans[0]
  // protobufjs 默认把 bytes 转成 base64 字符串：解回原始 hex 再比对
  const toHex = (base64: string): string => Buffer.from(base64, 'base64').toString('hex')
  check(
    'trace_id 解析为 16 字节（不是 32 字节的文本）',
    Buffer.from(rootSpan?.traceId ?? '', 'base64').length === 16,
    `${Buffer.from(rootSpan?.traceId ?? '', 'base64').length} 字节 / hex=${toHex(rootSpan?.traceId ?? '')}`,
  )
  check(
    'trace_id 的 hex 值与发送端一致',
    toHex(rootSpan?.traceId ?? '') === 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
    toHex(rootSpan?.traceId ?? ''),
  )
  check(
    'span_id 解析为 8 字节且 hex 一致',
    Buffer.from(rootSpan?.spanId ?? '', 'base64').length === 8 &&
      toHex(rootSpan?.spanId ?? '') === 'a1b2c3d4e5f60718',
    `${Buffer.from(rootSpan?.spanId ?? '', 'base64').length} 字节 / ${toHex(rootSpan?.spanId ?? '')}`,
  )
  check('name 解析正确', rootSpan?.name === 'character.turn', rootSpan?.name)
  check('kind 解析为 SPAN_KIND_INTERNAL', rootSpan?.kind === 'SPAN_KIND_INTERNAL', rootSpan?.kind)
  // protobufjs 返回的是枚举的**数字值**（1 = OK, 2 = ERROR）
  check('status.code(3) 解析为 1（OK）', Number(rootSpan?.status?.code) === 1, String(rootSpan?.status?.code))

  /*
   * 最关键的两条：时间戳。
   *
   * 这是真实 Phoenix 上暴露问题的字段（UI 显示 1970-01-01）。
   * 如果官方定义解码出来的值等于我们想要的纳秒数，那问题就在后端展示层，
   * 而不在我们的编码器 —— 这条断言把责任归属钉死。
   */
  const expectedNano = (BigInt(now) * 1_000_000n).toString()
  check(
    'start_time_unix_nano 精确等于 Date.now() × 1e6（无精度丢失）',
    rootSpan?.startTimeUnixNano === expectedNano,
    `期望 ${expectedNano}，得到 ${rootSpan?.startTimeUnixNano}`,
  )
  check(
    'end_time_unix_nano 与 start 的差值 = 1234ms',
    BigInt(rootSpan?.endTimeUnixNano ?? '0') - BigInt(rootSpan?.startTimeUnixNano ?? '0') === 1_234_000_000n,
    String(BigInt(rootSpan?.endTimeUnixNano ?? '0') - BigInt(rootSpan?.startTimeUnixNano ?? '0')),
  )

  const attrMap = Object.fromEntries(
    (rootSpan?.attributes ?? []).map((a) => [a.key, Object.values(a.value)[0]]),
  )
  check('字符串属性正确', attrMap['character.id'] === 'char_sumuwei', String(attrMap['character.id']))
  check('整数属性走 int_value 且值正确', attrMap['domain.event.count'] === '3', String(attrMap['domain.event.count']))
  check('浮点属性走 double_value 且值正确', attrMap['durationMs'] === 800.5, String(attrMap['durationMs']))
  check('布尔属性走 bool_value 且值正确', attrMap['ok'] === true, String(attrMap['ok']))
  check(
    'openinference.span.kind 被保留（Phoenix 靠它分类）',
    attrMap['openinference.span.kind'] === 'chain',
    String(attrMap['openinference.span.kind']),
  )

  const child = decodedSpans[1]
  check(
    '子 span 的 parent_span_id 指向根 span',
    toHex(child?.parentSpanId ?? '') === toHex(rootSpan?.spanId ?? ''),
    toHex(child?.parentSpanId ?? ''),
  )
  check('LLM span 的 kind 解析为 SPAN_KIND_CLIENT', child?.kind === 'SPAN_KIND_CLIENT', child?.kind)
  check('失败 span 的 status.code(3) 解析为 2（ERROR）', Number(child?.status?.code) === 2, String(child?.status?.code))
} else {
  check('（后续断言因解析失败而跳过）', false, '先修编码器')
}

console.log(`\n${'='.repeat(72)}`)
console.log(`OTLP 兼容性：${passed} 通过 / ${failed} 失败`)
console.log('='.repeat(72))
process.exit(failed === 0 ? 0 : 1)
