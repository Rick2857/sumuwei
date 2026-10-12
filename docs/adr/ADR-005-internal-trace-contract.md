# ADR-005：内部 Trace Contract + Phoenix 作为默认遥测后端

- **状态**：已采纳（M2.5）
- **日期**：2026-09-16
- **相关**：[tracing.md](../architecture/tracing.md)、SC-007、`scripts/verify-telemetry.ts`

## 背景

Agent 有了长期记忆与外部行动之后，调试会迅速变得困难。
"她引用了一条错误的记忆 / 调用了不合适的工具 / 出现异常行为"这类问题，
仅仅保存聊天记录不足以定位。

M2.5 需要：**一次交互之后能回答"刚才究竟发生了什么"**。

同时有一个反向约束：**观测绝对不能成为业务硬依赖**。
观测系统出问题的方式通常不是"崩了"，而是"变慢"或"偶发超时"。
如果它跑在聊天主链上，用户看到的是**她开始不回话**——
而真正的原因在一个跟角色毫无关系的地方（收集器重启、磁盘满、网络抖动）。

## 决策

### 1. 内部 Trace Contract 优先

```ts
interface CharacterRunTrace {
  traceId, characterId, inputEventId,
  contextCompilerVersion, contextSectionIds[], droppedSectionIds[],
  sourceConversationEventIds[], selectedMemoryIds[],
  projectionRevisionsAtStart / AtEnd,
  domainEventIds[], modelProfile?, outputEventId?,
  postTurnJobIds[], processorVersions{}, steps[],
  status, error?, startedAt, finishedAt?
}
```

它落进 `character_traces` 表，是**业务数据**：
即使观测后端从未接入，这张表也必须完整。

**不允许** Phoenix / Langfuse 的数据结构反过来成为业务结构。

### 2. Phoenix 作为默认的遥测后端

理由：它基于 OpenTelemetry / OpenInference，同时提供
Tracing、Datasets、Experiments 与 Evaluation，
正好覆盖 M3–M12 会反复用到的"跑一批场景、比较结果"这件事。

`TelemetryPort` 有两个实现：

| 实现 | 何时用 |
|---|---|
| `NoopTelemetryAdapter` | **默认**（未显式开启）/ 测试 |
| `PhoenixTelemetryAdapter` | `CHARACTER_TELEMETRY_ENABLED=1` 时 |

### 3. 手写 OTLP，不引入 OTel / Arize SDK

`PhoenixTelemetryAdapter` 自己构造 OTLP/HTTP JSON 并 `fetch` POST 到
`{endpoint}/v1/traces`，只手动标注一个 `openinference.span.kind` 常量。

## 被否决的方案

### 方案 A：引入 `@arizeai/phoenix-otel` + `@opentelemetry/sdk-node`

**否决理由**（三条，按重要性）：
1. plan 第 85 节的依赖 Gate 问"删除它以后系统还能不能运行"——
   手写 OTLP 让这个答案永远是"能"，因为标准库就够了。
2. 它们各自带十几个传递依赖与**全局状态**（OTel SDK 会注册全局
   provider / propagator）。对一个需要精确控制副作用的角色系统来说，
   全局状态是负担。
3. 我们需要的只是"把几个 span POST 到一个 endpoint"。

`@arizeai/openinference-semantic-conventions` 被否决得更彻底：
我们只用到 `openinference.span.kind` 一个字符串常量，
为它引入一个包不值得。

### 方案 B：直接把 Trace 写进 JSONL 文件，不接后端

**否决理由**：JSONL 适合当**证据**（可 grep、可 diff），
不适合**查询**（"最近 20 轮里哪些用了 memory section"这类问题）。
`character_traces` 表已经提供了前者，Phoenix 提供后者，两者互补。

### 方案 C：同时接 Phoenix 与 Langfuse

**否决理由**：plan 第 50 节明确要求二选一作为默认后端。
两个后端意味着两套导出逻辑、两份数据、以及"到底以哪个为准"的持续争论。
内部 Trace Contract 不变的前提下，将来想换后端只需要实现一个新的
`TelemetryPort`。

### 方案 D：Trace 里保存完整 Prompt（便于完全复现）

**否决理由**：完整 Prompt 包含人设、状态、最近对话——
把它外发到观测后端意味着**把聊天内容送出去**。
plan 第 45 节要求"敏感对话正文是否外发要有明确配置"，
M2.5 的选择是：默认**不外发正文**，只导 id、版本、计数、耗时、状态。

需要正文时看 `conversation_events`；需要 Prompt 形状看 section id 列表。
这已经足够定位问题。

## 后果

**正面**
- 观测后端离线、超时、报错，都只出现在 `logger.debug` 里，
  不影响她的对话，也不污染 `character_traces.error`。
- `exports()` 让"遥测真的发出去了"可以**离线断言**——
  CI 里不需要起 Phoenix 就能验证导出路径。
- 换后端（Langfuse / 自研）只需要实现一个新 Port，业务类型不动。

**负面 / 成本**
- 手写 OTLP 意味着 OTLP 规范变化时要自己跟。缓解：只用了最小子集
  （resourceSpans / scopeSpans / spans / attributes / status），
  且这批字段已经非常稳定。
- 没有 OTel SDK 的采样、批处理、重试。M2.5 的量级（每轮 3 个 span）
  不需要这些；真需要时再加。

## 补充（2026-09-16，Docker 可用后的真实后端验证）

ADR 首次写下时本机 Docker 未运行，因此"真实 Phoenix"只验证到
HTTP 边界。**Docker 可用后重跑，暴露出三个手写 protobuf 的真实缺陷**，
全部已修并补上了测试：

| # | 真实后端现象 | 根因 | 修法 |
|---|---|---|---|
| 1 | `/v1/traces` 返回 **HTTP 415** | Phoenix 的 OTLP 接收端**只接受 protobuf**，不接受 OTLP JSON（虽然规范定义了 JSON 编码） | 新增 `src/infrastructure/telemetry/protobuf.ts`，默认 `transport: 'protobuf'` |
| 2 | UI 里 trace 时间全是 **1970-01-01** | `start_time_unix_nano` / `end_time_unix_nano` 是 **`fixed64`**，我按 `uint64`（varint）写了；**wire type 不匹配时解码器静默跳过字段** | `ProtoWriter.fixed64()` |
| 3 | span 状态显示 **UNSET** | `Status.code` 是 **field 3**（field 1 已 reserved），我写成了 field 2 | `encodeStatus()` 写 2/3 |

另有两条同类问题在编码器自测阶段就被抓出：
`KeyValue.value` 必须是 field 2（写成 field 1 → 后端把**全部属性**读成空）、
`trace_id` / `span_id` 必须是**原始字节**（用字符串写会编码成 2 倍长度）。

### 这条经历改变了什么

**"本地假接收器全绿"不等于"接得上真实后端"。**
原来的 `verify-telemetry.ts` 用一个本地 HTTP 接收器验证 HTTP 边界，
它不校验 Content-Type，也不解析 protobuf —— 于是上述四条全部通过。

因此验证策略改为四层，缺一不可：

| 层 | 工具 | 能发现什么 |
|---|---|---|
| 1. 自测解码 | `verify-telemetry.ts` 第 1 节 | 字段号、嵌套结构（我们自己的形状是否自洽） |
| 2. **官方 schema** | `verify-otlp-compat.ts`（protobufjs + 官方 OTLP proto） | **wire type 错误、字段号错位**——自测解码器发现不了的那一类 |
| 3. 本地 HTTP 边界 | `verify-telemetry.ts` 第 2 节 | 方法 / 路径 / Content-Type / 字节数 |
| 4. **真实后端回查** | `PHOENIX_RUN_LIVE=1` + `verify-phoenix-live-chat.ts` | 415、时间戳错位、属性丢失——所有"HTTP 200 但内容是错的" |

第 2 层是本 ADR 最重要的修正：**手写 protobuf 必须用官方 schema 校验，
而不是用一个自己写的解码器校验**。protobufjs 因此成为 devDependency
（不参与运行时，符合本 ADR 的依赖原则）。

### 最终实测（本机 Docker，Phoenix `arizephoenix/phoenix:latest`）

```
✅ Phoenix 可达
✅ protobuf 导出 HTTP 200
✅ 回查：Phoenix 中能查到写入的 span
✅ 同一后端拒绝 JSON（HTTP 415 Unsupported content type: application/json）
✅ 真实对话 → Phoenix 7/7（按 input/output event id 指纹匹配到本次 trace）

Phoenix 侧记录：
  character.turn  [chain]  2026-09-16T01:01:49.421+00:00  OK
  character.model_call [llm]  parent 指向 character.turn
```

