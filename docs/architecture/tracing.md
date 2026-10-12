# Tracing —— 刚才究竟发生了什么

## 一次交互之后必须能回答

| 问题 | 看哪里 |
|---|---|
| 她用了哪些上下文和记忆？ | `contextSectionIds` / `selectedMemoryIds` |
| 内部状态是否发生变化？ | `projectionRevisionsAtStart` vs `AtEnd` |
| 是否调用了工具，输入结果是什么？ | `steps[]`（M2.5 只有模型调用这一步） |
| 最终产生了什么语言或行为？ | `outputEventId` |
| 为什么这样回答？ | `contextCompilerVersion` + `contextSectionIds` + `droppedSectionIds` |
| 她是不是忘了某事？ | **看 `droppedSectionIds`** —— 被裁了还是根本没召回，修法完全不同 |

---

## 两个东西，别混

```
TraceWriter（业务数据）        → character_traces 表。永远可用，是权威证据。
TelemetryPort（导出）          → Phoenix 等后端。可以缺失，丢的只是可视化。
```

中间由一个镜像器（`TelemetryRecorder`）连接：
把已经落库的 `CharacterRunTrace` 翻成 span。

因此**即使 Phoenix 整晚离线，事后仍然能从 `character_traces` 里补推**。
反过来说：`character_traces` 里的数据在任何情况下都不会因为观测后端
的问题而丢失。

**守着它的测试**：SC-007 →「Trace 是业务数据：遥测挂了，character_traces 里仍然完整」。

---

## Trace 不存什么

```
API Key / Token / 完整系统环境变量 / 数据库凭据   —— 一律不存
对话正文                                          —— 默认不存
完整 Prompt                                       —— 不存
```

要正文去 `conversation_events`；要 Prompt 形状看 section id 列表。
这已经足够定位问题，同时让"哪些数据会被外发到观测后端"这个问题
有一个明确的、可审计的答案（plan 第 45 节）。

**守着它的测试**：`eval:telemetry` →「负载里没有正文级长文本」。

---

## TelemetryPort

```ts
interface TelemetryPort {
  readonly name: string
  startTrace(trace): TraceHandle
  addSpan(traceId, step, parentSpanId?): void
  finish(trace): Promise<void>
  shutdown(): Promise<void>
  exports(): readonly TelemetryExportRecord[]   // 让"真的发出去了吗"可离线断言
}
```

两个实现：

| 实现 | 何时用 | 行为 |
|---|---|---|
| `NoopTelemetryAdapter` | 默认（未显式开启）/ 测试 | 什么都不做，但一切正常 |
| `PhoenixTelemetryAdapter` | 显式开启时 | 标准 OTLP/HTTP JSON → `{endpoint}/v1/traces` |

`exports()` 是刻意加的：它让"遥测真的发出去了"可以被**离线断言**，
不需要真的起一个 Phoenix。也让"Phoenix 离线不影响角色"可以被实测
（记录里是失败，但业务照常）。

---

## 为什么默认是 Phoenix，但不用它的 SDK

**默认 Phoenix 的理由**：它基于 OpenTelemetry / OpenInference，
同时提供 Tracing、Datasets、Experiments 与 Evaluation，
正好覆盖 M3–M12 会用到的"跑一批场景、比较结果"这件事。

**不用 `@arizeai/phoenix-otel` / `@opentelemetry/sdk-node` 的理由**：

1. 它们各自带十几个传递依赖与全局状态；
2. 我们需要的只是"把几个 span POST 到一个 endpoint"；
3. plan 第 85 节的依赖 Gate 要求"删除它以后系统还能不能运行"——
   手写 OTLP 让这个答案永远是"能"，因为标准库就够了。

手动标注 `openinference.span.kind` 只需要写一个字符串常量，
不值得为它引入整个语义约定包。

### 手写 OTLP 的代价：三个只有真后端才会暴露的坑

M2.5 实施时正好把这三个都踩了一遍。它们的共同点是**不报错**——
HTTP 200、span 也存下来了，只是内容是错的或空的：

| # | 现象 | 根因 | 修法 |
|---|---|---|---|
| 1 | 真实 Phoenix 返回 **HTTP 415** | Phoenix 的 `/v1/traces` **只接受 protobuf**，不接受 OTLP JSON | 默认启用 protobuf 编码（`src/infrastructure/telemetry/protobuf.ts`） |
| 2 | Phoenix UI 里 trace 时间全是 **1970-01-01** | `start_time_unix_nano` / `end_time_unix_nano` 是 **`fixed64`**（wire type 1，8 字节小端），我们按 `uint64`（varint）写了。**wire type 不匹配时 protobuf 解码器会静默跳过该字段** | `ProtoWriter.fixed64()` |
| 3 | 失败 span 的状态显示 **UNSET** | `Status.code` 是 **field 3**（field 1 已 reserved），我们写成了 field 2 | `encodeStatus()` 写 field 2/3 |

还有两个同类的"差一位就静默失效"：`KeyValue.value` 必须是 field 2
（写成 field 1 会让后端把所有属性读成空），`trace_id` / `span_id` 是
**原始字节**而不是文本（用字符串写会把 32 字符的 hex 编成 32 字节而不是 16 字节）。

**教训**：手写 protobuf 只做"自己的解码器能读回来"是**不够的**——
自测的逐字段断言在第 2、3 条上全绿，因为它们连"我们自己的形状"是自洽的。
必须用**官方 schema** 校验：`scripts/verify-otlp-compat.ts` 用 protobufjs
（devDependency，不进运行时）加载官方 OTLP proto 定义，解析我们的输出并逐字段断言。

**守着它的测试**：
- `pnpm eval:otlp`（`verify-otlp-compat.ts`，21 项，离线）——官方 schema 校验
- `pnpm eval:telemetry`（54 项，离线）——编码、HTTP 边界、离线韧性、Noop 等价
- `PHOENIX_RUN_LIVE=1 pnpm eval:telemetry`（58 项）——真实 Phoenix 收下并**可回查**
- `pnpm eval:phoenix-chat`——真实对话 → Phoenix 端到端（7 项）

---

## 实测形状

一轮交互 = 根 span + 子 span：

```
character.turn                      [chain]  openinference.span.kind=chain
├─ character.context_compile        [internal]
└─ character.model_call             [llm]
```

根 span 携带（**只有 id、版本、计数、耗时、状态**）：

```
character.id                    = char_sumuwei
input.event.id                  = cev:...
output.event.id                 = cev:...
context.compiler.version        = context-compiler@1
context.section.ids             = current-input,seed-identity,critical-state
context.dropped.sections        = (空)
domain.event.count              = 1
projection.revision.start       = {"diagnostic-counter":0}
projection.revision.end         = {"diagnostic-counter":1}
model.profile                   = deepseek-flash
```

子 span 的 `parentSpanId` 指向根 span，三者共享同一个 `traceId`。

---

## 失败姿态

```
Telemetry unavailable  ≠  Character unavailable
```

实现上这条是**结构性的**，不是靠 `try/catch` 到处包：

1. 未显式开启时，工厂返回 Noop —— "Phoenix 离线"在代码层面
   就等价于"遥测关闭"。
2. `emit()` 里的所有失败只走 `logger.debug`（不是 error：
   Phoenix 没开时这句会每轮出现，不该污染 info 日志）。
3. 导出带 `AbortController` 超时（默认 2s）——
   Phoenix 离线时**不能**拖住聊天主链。
4. `TelemetryRecorder` 的每个方法都不抛异常。

**守着它的测试**：`eval:telemetry` 第 3 节（不可达端点零异常逃逸）
+ SC-007 六条断言（对话照常、证据照常、导出确实失败过、
`trace.error` 不被遥测污染）。

---

## 怎么打开

```ini
CHARACTER_TELEMETRY_ENABLED=1
CHARACTER_TELEMETRY_ADAPTER=phoenix          # 或 noop
CHARACTER_TELEMETRY_TRANSPORT=protobuf       # 默认；json 仅用于人肉排查
PHOENIX_COLLECTOR_ENDPOINT=http://127.0.0.1:6006
# 可选：离线校验负载形状，不发送
CHARACTER_TELEMETRY_DUMP=data/telemetry-dump.jsonl
```

Phoenix 侧：

```bash
docker run -d --name project-lg-phoenix -p 6006:6006 -p 4317:4317 arizephoenix/phoenix:latest

# 1) 编码 + 传输 + 韧性 + 真实后端回查（58 项）
PHOENIX_RUN_LIVE=1 PHOENIX_COLLECTOR_ENDPOINT=http://127.0.0.1:6006 pnpm eval:telemetry

# 2) 真实对话 → Phoenix（7 项：两轮对话、按事件 id 指纹回查、正文不外发）
PHOENIX_COLLECTOR_ENDPOINT=http://127.0.0.1:6006 pnpm eval:phoenix-chat
```

### 实测验证结果（2026-09-16，本机 Docker）

```
✅ Phoenix 服务可达
✅ 真实 Phoenix 接受了 protobuf 导出（HTTP 200）
✅ Phoenix 中能查到写入的 span（回查验证，不只信 HTTP 200）
✅ 同一后端拒绝 JSON 编码（HTTP 415 → 说明默认 protobuf 是必要的）
✅ 真实对话 → Phoenix：7/7（2 轮对话，按 input/output event id 指纹匹配到本次 trace）
```

Phoenix 侧看到的记录（`GET /v1/projects/default/spans`）：

```
character.turn  [chain]  2026-09-16T01:01:49.421+00:00   status OK
  attributes: character.id / input.event.id / output.event.id /
              context.compiler.version / context.section.ids /
              context.dropped.sections / domain.event.count /
              projection.revision.start / projection.revision.end / model.profile
character.model_call [llm]  ← parent 指向上面那个 character.turn
```
