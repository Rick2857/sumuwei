# Processor 模型 —— 谁有权解释事实

## 定义

> Processor 是"从事实中产生**解释或提案**的组件"。

它是**唯一**允许调用 LLM 的地方（Slow Path）。Fast Path（用户在等回复）
里不允许出现 Processor。

```
Fast Path（用户在等）      : 写事件 → 编译上下文 → 模型 → 写回复
Slow Path（后台，不阻塞）  : 读事件 → Processor → Proposal → Validator
                                          → DomainEvent → Reducer → Projection
```

未来的 Processor：`memory-extractor`（M4）、`relationship-evaluator`（M7）、
`affect-evaluator`（M8）、`belief-evaluator`（M9）、`goal-extractor`（M10）、
`reflection-engine`（M11）。

---

## 契约

```ts
interface CharacterProcessor<TInput = ProcessorInput> {
  readonly name: string
  readonly version: ProcessorVersion   // 独立于应用版本
  process(input: TInput, context: ProcessorContext): Promise<DomainProposal[]>
}
```

三条约定的含义：

| 约定 | 为什么 |
|---|---|
| **必须幂等** | 同一 (输入范围, processor, version) 重复调用产出的提案语义必须相同 |
| **允许返回空数组** | "这批事件里没有值得记住的东西"是正常结论 |
| **抛错 = 任务失败** | 不要用异常表达"没有提案"；那会让 Job 层误以为需要重试 |

### 输入是"事件范围"而不是"一条消息"

```ts
interface ProcessorInput {
  characterId
  events: readonly ProcessorEventView[]   // 已按 sequence 升序
  sourceFromSequence: number
  sourceToSequence: number
}
```

大多数认知判断需要上下文窗口（"他这几次都这样"），而不是单句。
范围与 Job 的幂等键天然对齐，因此断点续跑有明确定义。

### ProcessorEventView 刻意比 ConversationEvent 窄

它看不到 `metadata` 里的内部键。少给一份信息，它就不可能把内部字段
写进记忆——这是"来源污染"在一个非常具体的地方被截断。

---

## Processor 的三个"正确行为"（M2.5 的诊断 Processor 已经体现）

`runDiagnosticProcessor()` 做的事毫无业务价值（每条用户事件产出
`counterDelta = 1`），但它的**行为形状**就是 M4 该照抄的：

### 1. 先自查幂等，再提案

```ts
const keys = idempotencyKeyFor(proposal)
for (const key of keys) {
  if (await store.hasProcessed(key)) {
    return { ..., skippedReason: 'already_processed' }   // 安静地成功
  }
}
```

而不是"先写提案、再指望 Validator 拦下来"。

区别是实际的：正常重跑应该是**安静的成功**，
而 Validator 的 `duplicate_operation` 是**并发兜底**（自查与提交之间的窗口）。
把兜底当主路径会让每次重试都在日志里留下拒绝记录，
真出问题时反而淹没在噪声里。

### 2. 她自己的话不产生外部事实

```ts
const userEvents = input.events.filter(
  (e) => e.type === 'user_message' && e.actorType === 'user'
)
if (userEvents.length === 0) return { skippedReason: 'no_user_evidence' }
```

这是铁律 6 在**链路本身**上的落地：
不是"记得不要污染"，而是"只有用户证据能触发变化"。

SC-002 专门验证这条：只喂 assistant 事件，领域事件必须为 0。

### 3. 其它拒绝原因是重要信号，不能吞掉

```ts
if (codes.every((c) => c === 'duplicate_operation')) { /* 幂等命中，正常 */ }
else { throw new KernelError('diagnostic_proposal_rejected', ...) }
```

幂等命中是正常路径；**来源不存在、类型未登记、payload 超限**是地基问题。
后者必须炸出来，否则会变成"慢路径悄悄什么都不做"——最坏的失败方式。

---

## Validator：唯一的放行口

M2.5 严格实现 plan 第 21 节列的八项检查：

| 检查 | 失败码 |
|---|---|
| Processor / 版本存在 | `processor_version_presence` |
| 来源事件存在 | `source_event_missing` |
| 来源事件属于本角色 | `source_event_foreign` |
| Domain Event 类型在 allowlist 内 | `domain_event_type_not_allowed` |
| 类型已在 Registry 登记 | `domain_event_type_unregistered` |
| payload 符合契约 | `payload_schema_invalid` |
| payload 未超上限 | `payload_too_large` |
| 幂等（未处理过） | `duplicate_operation` |

### 失败关闭（fail closed）

最典型的一条：提案引用了**不存在的 source_event_id**。

```
错误做法：忽略 source，然后继续写 Domain Event
正确做法：reject
```

因为 provenance 是整个项目的地基。一旦允许"来源不明的变化"落库，
那条审计链就断了——而且是**静默**断掉的，这比直接报错危险得多。

**守着它的测试**：`kernel:test` 的 `Validator（失败关闭）` 七条。

### 提案是整体，不是逐条

任一条 target 被拒 → 整个提案不生效（`acceptedEvents` 为空）。

理由：一个提案代表一次语义判断。允许"半个提案"进库，
会让"这条记忆为什么只有一半"变成一个无法回答的问题。

### payload 契约外的字段会被丢弃

```ts
validatePayload: (payload) => ({ counterDelta: delta })   // 只取契约内字段
```

LLM 常常多给字段。丢弃它们比让整条提案失败更符合实际——
而"payload 太大"仍然是独立的拒绝码（`payload_too_large`），
两者可区分。

**守着它的测试**：`kernel:test` →「payload 契约外的字段会被丢弃」
「payload 超限 → 拒绝」。

---

## Job / 水位

```ts
interface CharacterJob {
  characterId, processor, processorVersion,
  sourceFromSequence, sourceToSequence,   // 闭区间
  idempotencyKey,
  status: 'pending' | 'running' | 'completed' | 'failed',
  retryCount, lastError?, createdAt, startedAt?, finishedAt?
}

interface ProcessorWatermark {
  characterId, processor, processorVersion,
  processedThroughSequence, updatedAt
}
```

三件事在 M2.5 就绪、M4 不需要改表：

1. **顺序**：任务处理的是闭区间，而不是"最近一批消息"——
   否则断点续跑无法定义。
2. **幂等**：`character_jobs` 上有**部分唯一索引**，
   只覆盖 `pending / running / completed`。
   这样"已完成的活不会被重复排期"，同时允许失败任务重建——
   否则一次失败会把这个幂等键**永久钉死**，重试反而做不了。
3. **水位**：`advanceWatermark()` **只许前进**
   （回退会让已处理的事件被重复处理），回退直接抛 `watermark_regression`。

M2.5 不实现调度器。目前诊断 Processor 是纯本地函数，
在回复之后立刻跑完（不阻塞用户）。M4 接真模型时只需把这一处
换成 `enqueueJob(...)`，调用方不用改。

---

## LLM 调用与事务分离

```
LLM → Proposal
──────── transaction ────────
Validator → DomainEvent → Projection
──────── commit ────────────
```

`TurnGateway.completeTurn()` 里，模型调用发生在
`applyAcceptedEvents()` 的**事务之外**。

并且 **Slow Path 失败不影响已经产生的回复**：
`completeTurn()` 里那个 `try/catch` 只把错误写进 `trace.error`，
用户看到的话照常发出。

**守着它的测试**：SC-007（遥测/慢路径故障时角色照常运行）。
