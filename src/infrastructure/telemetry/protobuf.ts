/**
 * 最小 protobuf 写出器 + OTLP/trace 编码器。
 *
 * ============================================================================
 *  为什么需要它：Phoenix 的 /v1/traces 只收 protobuf
 * ============================================================================
 * 实测（2026-09-16，Phoenix 容器 + curl）：
 *
 *     Content-Type: application/json        → HTTP 415 Unsupported Media Type
 *     Content-Type: application/json;charset → HTTP 415
 *     Content-Type: application/x-protobuf  → HTTP 422（内容不是合法 protobuf）
 *
 * 也就是说 Phoenix 的 OTLP/HTTP 接收端**只接受 protobuf 编码**，
 * 即使 OTLP 规范同时定义了 JSON 编码。
 *
 * 我们的 JSON 实现因此在本地"假接收器"上是绿的、在真实 Phoenix 上是 415 ——
 * 这正是 ADR-005 里"未对真实实例验证"那条限制所掩盖的真实缺陷。
 *
 * ---------------------------------------------------------------------------
 *  为什么手写而不是引入 protobufjs / @opentelemetry/exporter-trace-otlp-proto
 * ---------------------------------------------------------------------------
 * 需要编码的只是 OTLP trace 的一个**很小子集**（见下面的字段号表），
 * 一共十几个字段，全部是 varint / length-delimited 两种线格式。
 * 而引入 protobufjs 或 OTel exporter 会带来：
 *   · 新的重量依赖（ADR-006 的依赖 Gate 要求能回答"删掉它还能不能跑"）；
 *   · OTel SDK 的全局状态（ADR-005 已明确否决）。
 *
 * 因此：手写编码器 + **对这个编码器本身的测试**，
 * 并且用真实 Phoenix 做端到端验证（`PHOENIX_RUN_LIVE=1 pnpm eval:telemetry`）。
 *
 * 参考：opentelemetry-proto 的 `opentelemetry/proto/trace/v1/trace.proto`
 * 与 `common/v1/common.proto`、`resource/v1/resource.proto`。
 */

import type { TelemetrySpan } from './port.ts'

// ---------------------------------------------------------------------------
// protobuf 线格式写出器
// ---------------------------------------------------------------------------

/** protobuf 线格式类型 */
const WIRE_VARINT = 0
const WIRE_I64 = 1
const WIRE_LEN = 2
const WIRE_I32 = 5

/**
 * 一个可增长的 protobuf 写出器。
 *
 * 只实现 OTLP trace 用得到的部分：varint、length-delimited、嵌套消息。
 * 刻意不做通用 protobuf 库——通用性在这里是负资产（更多代码、更多未测路径）。
 */
class ProtoWriter {
  private buffer: Uint8Array
  private length = 0

  constructor(initialCapacity = 1024) {
    this.buffer = new Uint8Array(initialCapacity)
  }

  private ensure(extra: number): void {
    if (this.length + extra <= this.buffer.length) return
    let next = this.buffer.length * 2
    while (next < this.length + extra) next *= 2
    const grown = new Uint8Array(next)
    grown.set(this.buffer.subarray(0, this.length))
    this.buffer = grown
  }

  get byteLength(): number {
    return this.length
  }

  /** 取出已写入的字节（复制一份，避免调用方持有内部缓冲） */
  toBytes(): Uint8Array {
    return this.buffer.slice(0, this.length)
  }

  /** varint（32 位以内的非负数） */
  private writeVarint(value: number): void {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`protobuf varint 只支持非负有限数，收到 ${value}`)
    }
    this.ensure(10)
    let n = Math.floor(value)
    while (n > 0x7f) {
      this.buffer[this.length] = (n & 0x7f) | 0x80
      this.length += 1
      n = Math.floor(n / 128)
    }
    this.buffer[this.length] = n & 0x7f
    this.length += 1
  }

  /** varint（64 位，用 BigInt 以免精度丢失） */
  private writeVarintBig(value: bigint): void {
    if (value < 0n) throw new Error(`protobuf varint 只支持非负数，收到 ${value}`)
    this.ensure(10)
    let n = value
    while (n > 0x7fn) {
      this.buffer[this.length] = Number(n & 0x7fn) | 0x80
      this.length += 1
      n >>= 7n
    }
    this.buffer[this.length] = Number(n)
    this.length += 1
  }

  private writeTag(fieldNumber: number, wireType: number): void {
    this.writeVarint((fieldNumber << 3) | wireType)
  }

  private writeLengthDelimited(fieldNumber: number, bytes: Uint8Array): void {
    this.writeTag(fieldNumber, WIRE_LEN)
    this.writeVarint(bytes.length)
    this.ensure(bytes.length)
    this.buffer.set(bytes, this.length)
    this.length += bytes.length
  }

  // ---- 公开的字段写入方法 ------------------------------------------------

  /** 字符串字段（proto3 默认不写空值，但写了也合法；这里保持总写以便断言） */
  string(fieldNumber: number, value: string): void {
    this.writeLengthDelimited(fieldNumber, new TextEncoder().encode(value))
  }

  /** 非空字符串：空串跳过（省字节，语义等价） */
  stringIfNotEmpty(fieldNumber: number, value: string): void {
    if (value === '') return
    this.string(fieldNumber, value)
  }

  /**
   * 原始字节（`bytes` 类型）。
   *
   * ⚠️ 与 `string()` 的关键差别：**不做 UTF-8 编码**。
   * trace_id / span_id 是 16 / 8 字节的原始 id，用字符串写会把每个字符
   * 编成它的 UTF-8 字节 —— 32 字符的 hex 会变成 32 字节而不是 16 字节。
   * （Phantom 会把它当 32 字节 id 直接拒收或解成乱码。）
   */
  bytes(fieldNumber: number, value: Uint8Array): void {
    this.writeLengthDelimited(fieldNumber, value)
  }

  /** 有符号整数（用 zigzag 之外的方式：非负直接 varint） */
  int32(fieldNumber: number, value: number): void {
    this.writeTag(fieldNumber, WIRE_VARINT)
    this.writeVarint(value)
  }

  /** 无符号 64 位 **varint**（用 BigInt 以免精度丢失） */
  uint64(fieldNumber: number, value: string | bigint): void {
    this.writeTag(fieldNumber, WIRE_VARINT)
    this.writeVarintBig(typeof value === 'string' ? BigInt(value) : value)
  }

  /**
   * `fixed64`：wire type 1，小端 8 字节。
   *
   * ⚠️ 这里踩过 M2.5 最后一个、也是最隐蔽的坑（被 `scripts/verify-otlp-compat.ts`
   * 用**官方 OTLP proto 定义**解析时抓出）：
   *
   *   OTLP 的 `Span.start_time_unix_nano` / `end_time_unix_nano` 是
   *   **`fixed64`**，不是 `uint64`。两者都是 64 位整数，但线格式不同
   *   （fixed64 = wire type 1 定长 8 字节；uint64 = wire type 0 varint）。
   *
   *   我们一开始按 varint 写。后果**没有任何报错**：
   *     · 真实 Phoenix 收下了（HTTP 200）
   *     · span 也存下来了
   *     · 但时间戳被解析成 0 → UI 里显示 `1970-01-01`，整条 trace 的时间轴是废的
   *   而且 protobuf 的解码器遇到 wire type 不匹配会**静默跳过**该字段，
   *   所以这个错误在"字段存在性"级别的检查里完全看不出来。
   *
   *   教训：手写 protobuf 必须用**官方 schema** 校验，而不是只校验自己的编码器。
   */
  fixed64(fieldNumber: number, value: string | bigint): void {
    this.writeTag(fieldNumber, WIRE_I64)
    this.ensure(8)
    let n = typeof value === 'string' ? BigInt(value) : value
    for (let i = 0; i < 8; i += 1) {
      this.buffer[this.length + i] = Number(n & 0xffn)
      n >>= 8n
    }
    this.length += 8
  }

  /** 布尔 */
  bool(fieldNumber: number, value: boolean): void {
    this.writeTag(fieldNumber, WIRE_VARINT)
    this.writeVarint(value ? 1 : 0)
  }

  /** 双精度浮点（wire type 1，小端 8 字节） */
  double(fieldNumber: number, value: number): void {
    this.writeTag(fieldNumber, WIRE_I64)
    this.ensure(8)
    const view = new DataView(this.buffer.buffer, this.buffer.byteOffset + this.length, 8)
    view.setFloat64(0, value, true)
    this.length += 8
  }

  /** 嵌套消息：用子 writer 写好再作为 length-delimited 追加 */
  message(fieldNumber: number, child: ProtoWriter): void {
    this.writeLengthDelimited(fieldNumber, child.toBytes())
  }

  /** 32 位定点（wire type 5），保留给未来的 enum 字段 */
  int32Fixed(fieldNumber: number, value: number): void {
    this.writeTag(fieldNumber, WIRE_I32)
    this.ensure(4)
    const view = new DataView(this.buffer.buffer, this.buffer.byteOffset + this.length, 4)
    view.setInt32(0, value, true)
    this.length += 4
  }
}

// ---------------------------------------------------------------------------
// AnyValue / KeyValue
// ---------------------------------------------------------------------------

/**
 * `opentelemetry.proto.common.v1.AnyValue` 的字段号：
 *
 *   1 string_value   2 bool_value   3 int_value
 *   4 double_value   5 array_value  6 kvlist_value   7 bytes_value
 *
 * ⚠️ 这里踩过一次真实的坑（被 `scripts/verify-telemetry.ts` 的逐字段断言抓出）：
 *    第一版把内部值当作 AnyValue 的**字段 1** 写入，
 *    结果是 KeyValue 的 value 走了 `0x0a`（field 1, wire 2）而不是
 *    `0x12`（field 2, wire 2）—— 整整多包了一层。
 *   真实 Phoenix 会把它解成"key 是 AnyValue、value 为空"，
 *   也就是**静默丢弃所有属性**。
 *
 *    所以：值必须写在**调用方指定的字段号**上，函数里不能硬编码 field 1。
 */
function writeAnyValue(
  writer: ProtoWriter,
  fieldNumber: number,
  value: string | number | boolean,
): void {
  const anyValue = new ProtoWriter(64)
  if (typeof value === 'string') {
    anyValue.string(1, value)
  } else if (typeof value === 'boolean') {
    anyValue.bool(2, value)
  } else if (Number.isInteger(value)) {
    // int_value 是 int64 → varint
    anyValue.uint64(3, BigInt(value))
  } else {
    anyValue.double(4, value)
  }
  writer.message(fieldNumber, anyValue)
}

/**
 * `common.v1.KeyValue`：**1 key, 2 value(AnyValue)**
 *
 * 字段号必须与 proto 一致 —— 写错不会报错，只会在后端静默丢属性。
 * 因此 `verify-telemetry.ts` 会逐个字段号断言。
 */
function encodeKeyValue(key: string, value: string | number | boolean): ProtoWriter {
  const kv = new ProtoWriter(96)
  kv.string(1, key)
  writeAnyValue(kv, 2, value)
  return kv
}

function encodeAttributes(
  writer: ProtoWriter,
  fieldNumber: number,
  attributes: Record<string, string | number | boolean>,
): void {
  for (const [key, value] of Object.entries(attributes)) {
    writer.message(fieldNumber, encodeKeyValue(key, value))
  }
}

// ---------------------------------------------------------------------------
// OTLP trace 编码
// ---------------------------------------------------------------------------

/** `trace.v1.Span.SpanKind`：1 INTERNAL, 2 SERVER, 3 CLIENT */
function spanKindNumber(kind: TelemetrySpan['kind']): number {
  return kind === 'llm' ? 3 : 1
}

/**
 * `trace.v1.Status` 的字段号：
 *
 *   1 已 reserved（历史遗留）
 *   2 message
 *   3 code（0 UNSET, 1 OK, 2 ERROR）
 *
 * ⚠️ 又是一处"差一位就静默失效"的地方（同为 verify-otlp-compat 抓出）：
 *   第一版写成了 `message = 1, code = 2`，于是真实后端读到的 status 全是
 *   UNSET —— 不报错、不丢 span，只是"成功/失败"这个信息永远丢了。
 *   Status 的 field 3 才是 code，这也是为什么手写 protobuf 必须用官方 schema 校验。
 */
function encodeStatus(writer: ProtoWriter, status: TelemetrySpan['status']): void {
  const child = new ProtoWriter(16)
  if (status === 'error') {
    child.stringIfNotEmpty(2, 'error')
    child.int32(3, 2)
  } else {
    child.int32(3, 1)
  }
  writer.message(15, child)
}

/**
 * `trace.v1.Span` 的字段号：
 *
 *    1 trace_id   2 span_id   3 trace_state   4 parent_span_id
 *    5 name       6 kind      7 start_time_unix_nano   8 end_time_unix_nano
 *    9 attributes 10 dropped_attributes_count  11 events
 *   12 dropped_events_count  13 links  14 dropped_links_count  15 status
 */
function encodeSpan(span: TelemetrySpan): ProtoWriter {
  const writer = new ProtoWriter(512)

  // trace_id / span_id 是**原始字节**，不是文本：
  // 16 / 8 字节，由 32 / 16 个 hex 字符解析而来。
  writer.bytes(1, hexToBytes(span.traceId, 16))
  writer.bytes(2, hexToBytes(span.spanId, 8))
  if (span.parentSpanId) writer.bytes(4, hexToBytes(span.parentSpanId, 8))
  writer.string(5, span.name)
  writer.int32(6, spanKindNumber(span.kind))
  // ⚠️ fixed64，不是 uint64（见 ProtoWriter.fixed64 的注释）
  writer.fixed64(7, toUnixNano(span.startTimeMs))
  writer.fixed64(8, toUnixNano(span.endTimeMs ?? span.startTimeMs))

  const attributes: Record<string, string | number | boolean> = {
    'openinference.span.kind': span.kind,
    ...span.attributes,
  }
  encodeAttributes(writer, 9, attributes)

  encodeStatus(writer, span.status)
  return writer
}

/** hex 字符串 → 原始字节（长度必须与期望字节数一致） */
function hexToBytes(hex: string, expectedBytes: number): Uint8Array {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length !== expectedBytes * 2) {
    throw new Error(
      `OTLP id 必须是 ${expectedBytes * 2} 个 hex 字符（${expectedBytes} 字节），收到 ${JSON.stringify(hex)}`,
    )
  }
  const out = new Uint8Array(expectedBytes)
  for (let i = 0; i < expectedBytes; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

function toUnixNano(ms: number): string {
  return (BigInt(Math.max(0, Math.floor(ms))) * 1_000_000n).toString()
}

export interface ResourceAttributes {
  'service.name': string
  'service.version': string
  'session.id': string
  [key: string]: string | number | boolean
}

/**
 * 编码整个 `ExportTraceServiceRequest`：
 *
 *   1 resource_spans(ResourceSpans)
 *       1 resource(Resource) → 1 attributes(KeyValue)
 *       2 scope_spans(ScopeSpans)
 *           1 scope(InstrumentationScope) → 1 name, 2 version
 *           2 spans(Span)
 */
export function encodeOtlpProtobuf(input: {
  resourceAttributes: ResourceAttributes
  scopeName: string
  scopeVersion: string
  spans: readonly TelemetrySpan[]
}): Uint8Array {
  const scope = new ProtoWriter(48)
  scope.string(1, input.scopeName)
  scope.stringIfNotEmpty(2, input.scopeVersion)

  const scopeSpans = new ProtoWriter(1024)
  scopeSpans.message(1, scope)
  for (const span of input.spans) scopeSpans.message(2, encodeSpan(span))

  const resource = new ProtoWriter(256)
  encodeAttributes(resource, 1, input.resourceAttributes)

  const resourceSpans = new ProtoWriter(2048)
  resourceSpans.message(1, resource)
  resourceSpans.message(2, scopeSpans)

  const request = new ProtoWriter(4096)
  request.message(1, resourceSpans)
  return request.toBytes()
}

// ---------------------------------------------------------------------------
// 供测试使用的最小解码器（只解码我们自己写出的形状）
// ---------------------------------------------------------------------------

export interface DecodedField {
  fieldNumber: number
  wireType: number
  value: string | bigint | Uint8Array
}

/**
 * 最小 protobuf 读取器。
 *
 * 存在的唯一理由：让"编码器到底写对了没有"可以被**离线断言**，
 * 而不必依赖真实后端。它只解析我们自己的形状（varint / 64 位 / length-delimited）。
 */
export function decodeProtobuf(bytes: Uint8Array): DecodedField[] {
  if (!(bytes instanceof Uint8Array)) {
    throw new Error(
      `decodeProtobuf 需要一个 Uint8Array，收到 ${typeof bytes}。` +
        '（常见原因：用了 `decodeSubmessages(x, n)[i]` 但该字段不存在，得到 undefined）',
    )
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const fields: DecodedField[] = []
  let offset = 0

  const readVarint = (): bigint => {
    let result = 0n
    let shift = 0n
    for (;;) {
      if (offset >= bytes.length) throw new Error('protobuf 读取越界（varint 未结束）')
      const byte = view.getUint8(offset)
      offset += 1
      result |= BigInt(byte & 0x7f) << shift
      if ((byte & 0x80) === 0) break
      shift += 7n
    }
    return result
  }

  while (offset < bytes.length) {
    const tag = Number(readVarint())
    const fieldNumber = tag >>> 3
    const wireType = tag & 0x7

    if (wireType === WIRE_VARINT) {
      fields.push({ fieldNumber, wireType, value: readVarint() })
    } else if (wireType === WIRE_I64) {
      // fixed64 / double 共用 wire type 1：按无符号 64 位整数读，
      // 这样纳秒时间戳可以精确断言（float64 会丢精度）。
      const value = view.getBigUint64(offset, true)
      offset += 8
      fields.push({ fieldNumber, wireType, value })
    } else if (wireType === WIRE_LEN) {
      const len = Number(readVarint())
      const slice = bytes.subarray(offset, offset + len)
      offset += len
      fields.push({ fieldNumber, wireType, value: slice })
    } else if (wireType === WIRE_I32) {
      const value = view.getInt32(offset, true)
      offset += 4
      fields.push({ fieldNumber, wireType, value: value as unknown as string })
    } else {
      throw new Error(`不支持的 wire type ${wireType}（字段 ${fieldNumber}）`)
    }
  }

  return fields
}

/** 便捷：取某个 length-delimited 字段（可重复） */
export function decodeSubmessages(bytes: Uint8Array, fieldNumber: number): Uint8Array[] {
  return decodeProtobuf(bytes)
    .filter((f) => f.fieldNumber === fieldNumber && f.wireType === WIRE_LEN)
    .map((f) => f.value as Uint8Array)
}

/** 便捷：把 length-delimited 字段当 UTF-8 字符串读 */
export function decodeString(bytes: Uint8Array, fieldNumber: number): string | undefined {
  const found = decodeProtobuf(bytes).find((f) => f.fieldNumber === fieldNumber && f.wireType === WIRE_LEN)
  return found ? new TextDecoder().decode(found.value as Uint8Array) : undefined
}

/** 便捷：把 length-delimited 字段当**原始字节**读（trace_id / span_id 用） */
export function decodeBytesField(bytes: Uint8Array, fieldNumber: number): Uint8Array | undefined {
  const found = decodeProtobuf(bytes).find((f) => f.fieldNumber === fieldNumber && f.wireType === WIRE_LEN)
  return found ? (found.value as Uint8Array) : undefined
}

/** 便捷：读一个 varint 字段（uint64 / int32 / bool） */
export function decodeVarint(bytes: Uint8Array, fieldNumber: number): bigint | undefined {
  const found = decodeProtobuf(bytes).find((f) => f.fieldNumber === fieldNumber && f.wireType === WIRE_VARINT)
  return found ? (found.value as bigint) : undefined
}

/** 便捷：读一个 fixed64 字段（纳秒时间戳） */
export function decodeFixed64(bytes: Uint8Array, fieldNumber: number): bigint | undefined {
  const found = decodeProtobuf(bytes).find((f) => f.fieldNumber === fieldNumber && f.wireType === WIRE_I64)
  return found ? (found.value as bigint) : undefined
}

export { ProtoWriter }
