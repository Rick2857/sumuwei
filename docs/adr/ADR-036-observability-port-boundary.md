# ADR-036：观测端口边界（ObservabilityPort 不新建，改为把既有端口补宽）

- 状态：**已采纳**（M5.1 WP4，2026-09-17）
- 里程碑：M5.1（Developer Plane / OSS Audit / E2E）
- 相关：ADR-005（内部 trace 契约）、ADR-006（第三方依赖门）、
  `docs/architecture/tracing.md`、`docs/m5.1/M5.1-Authority-Map.md`、`docs/m5.1/WP4-Handoff.md`

---

## 1. 背景

M5.1 计划书 AT4.6 写的是：

> 创建：`ObservabilityPort`。已有 OTLP 作为 adapter。第三方 backend 不进入 kernel。

WP0 侦察（`M5.1-Repository-Map.md` 的 F-7）实测到的却是：

```
src/infrastructure/telemetry/port.ts     TelemetryPort（:55）
                                         createNoopTelemetry()（:86）
                                         buildOtlpPayload()（:144）
src/infrastructure/telemetry/phoenix.ts  createPhoenixTelemetry() / createTelemetry()
src/infrastructure/telemetry/protobuf.ts 手写 OTLP/protobuf 编码（零第三方 SDK）
```

也就是说：**端口已经存在**，而且已经满足 AT4.6 想守的东西 —— 第三方后端
（Phoenix）只出现在 `infrastructure/telemetry/` 里，
`src/kernel/**` 一个字符都不 import 它（由 `kernel:test` 的依赖方向静态锁守着）。

于是"照字面再建一个 `ObservabilityPort`"会得到一个**第二端口**，
而第二端口正是 G-01 要禁止的"第二套真相"：一旦有两个观测出口，
"哪条遥测走哪个端口"就变成一个没人能回答的问题，而且它们必然漂移。

---

## 2. WP4 实测到的两个缝（这才是真正需要决策的地方）

### 缝 ①：端口的形状假定"遥测必然属于某一轮对话"

```ts
startTrace(trace: CharacterRunTrace): TraceHandle
addSpan(traceId: string, step: TraceStep, parentSpanId?: string): void
finish(trace: CharacterRunTrace): Promise<void>
```

开发者面出现之后这个假定不成立了：控制命令**没有**（也不该有）
`CharacterRunTrace` —— `character_traces.input_event_id` 是 **NOT NULL**
且语义上指向"触发这一轮的真实对话事件"（`migrations.ts:205`）。
给它编一个假引用，就会造出**指向不存在的行**的 trace，
那正是 D-7 那次库损坏的形状（见 `M5.1-Repository-Map.md` 的 D-9 讨论）。

结果是：`developer_control` 阶段的 span **没有地方可去**。

### 缝 ②：既有路径用的是点号键名，而且**根本没过白名单**

既有 `phoenix.ts` 发的是 `character.id` / `context.section.ids` /
`error.message` 这类**点号**键；而 M5.1 WP1 的规范白名单
（AT1.4）是**下划线**键名，且**从未被接到既有路径上**。

实测后果（`scripts/kernel-tests-dev-plane.ts` 里被钉住）：

```
assertTelemetryAttributesAllowed({ 'error.message': 'x' })
→ KernelError('validation_error', 'telemetry_sensitive_attribute')
  （`message` 是 SENSITIVE_ATTRIBUTE_KEY_SEGMENTS 里的一段）
```

也就是说：**今天真实发出的遥测里有规范规则会直接拒的键**。
`error.message` 的值来自 `CharacterRunTrace.error`，
`contracts/trace.ts` 承诺它"不含正文"，但它是**无界**的 ——
任何上游把一段带内容的错误文本塞进去，它就会被原样外发，而外发**不可撤回**。

---

## 3. 决策

### 决策 1：**不新建** `ObservabilityPort`；把既有 `TelemetryPort` **追加式补宽**

```ts
// 新增（可选方法，既有实现语义一个字未动）
emitSpans?: (traceKey: string, spans: readonly TelemetrySpan[]) => Promise<void>
```

- `noop` 实现为"什么都不做"（与 `startTrace` 同语义）
- `phoenix` 实现为复用**同一个** `emit()` —— 因此非轮次 span
  与对话 span 共用同一条**编码 / 发送 / 失败隔离**路径，而不是旁路
- `traceKey` 只是本地缓冲的分组键，**不是**"某个角色的 traceId"
  （AT4.3："不强制所有模块共享同一 ID"）

**代价**：端口多了一个可选方法。
**换来的**：仍然只有一个观测出口，且"哪条遥测走哪个端口"这个问题不存在。

### 决策 2：分类法住在 kernel，编码/发送住在 infrastructure

```
kernel/contracts/observability.ts     阶段枚举 + 生产者登记 + span 形状 + AT1.4 白名单
infrastructure/telemetry/taxonomy.ts  CharacterRunTrace/ControlExecution → 规范 span
                                      （并强制白名单、把被过滤的键如实报出来）
infrastructure/telemetry/phoenix.ts   编码与发送（OTLP/protobuf，零第三方 SDK）
```

M5.1 之前，`OBSERVABILITY_STAGE_FACTS` **没有任何消费者** ——
这就是本仓库最贵的缺陷形状之一（"枚举里有值，但永远没有东西产出它"）。
WP4 的 `taxonomy.ts` 是它的第一个消费者，并由
`pnpm m5.1:observability:verify` 在**真实一轮**上证明它是活的。

### 决策 3：既有 wire 键名**不重命名**，但把差距变成**有限且被钉住**的

- `TELEMETRY_LEGACY_ATTRIBUTE_ALIASES`：点号名 → 规范名（16 条）
- `TELEMETRY_LEGACY_KEYS_OUTSIDE_POLICY`：**只有三个**键落在 AT1.4 的七类之外
  （`error.message` / `step.label` / `span.kind.source`），且被断言**不许增长**
- **规范路径强制白名单**；既有路径维持原状（见下"未决"）

不重命名的理由：wire 键名是**对外契约**（Phoenix 面板、既有 50 余条
`eval:telemetry` 断言都钉着它），改名是破坏性变更，属于独立里程碑。

---

## 4. 备选方案与否决理由

| 备选 | 否决理由 |
|---|---|
| 新建 `ObservabilityPort`（照 AT4.6 字面） | 第二端口 = 第二套真相（G-01）；"哪条遥测走哪个端口"无解 |
| 把 `TelemetryPort` 从 infrastructure 搬到 kernel | 端口的实现要 `fetch` / `node:fs`（dump）；搬进 kernel 会破依赖方向静态锁 |
| 给控制命令造一个 `CharacterRunTrace` | `input_event_id` NOT NULL 且语义指向真实对话事件 → 制造 D-7 同形状的悬空证据 |
| 直接按规范白名单去拒既有 payload | 会把**真实遥测全部拦下**（点号键一条都过不了），等于关掉观测 |
| 把既有 wire 键改成规范名 | 破坏性变更（面板 + 50 余条断言），不属于 M5.1 |

---

## 5. 后果与未决事项

**已达成**
- 唯一观测出口，且能承载非轮次 span（AT4.6 的实质）
- 分类法第一次作用在真实一轮上，且**每个 step kind 都映射到已登记阶段**
  （`unmappedStepKinds = []`）
- 规范路径的每个属性键都过白名单，被过滤的键**如实报出来**
- 导出负载四个哨兵零泄漏（含 protobuf 字节），且扫描器自带量具自检

**未决（留给后续里程碑，不在 M5.1 顺手做）**
1. **既有路径仍未过白名单** —— `error.message` 是唯一真正有风险的键。
   建议：给既有路径补 `error.code`，停发自由文本；`step.label` /
   `span.kind.source` 换成规范名。这会改既有面板与断言，属独立里程碑。
2. **删掉别名表**：wire 键迁移到规范名之后，`TELEMETRY_LEGACY_ATTRIBUTE_ALIASES`
   应当整体删除（它的存在本身就是"两套命名"的证据）。
3. **控制命令没有持久 trace**（WP3 的 Known Issue 1）：
   要持久化需要一条新迁移（`character_traces.input_event_id` 需要能表达
   "非对话触发"）。在此之前，控制 span 只在导出里存在，且自成一棵单 span 的 trace。
