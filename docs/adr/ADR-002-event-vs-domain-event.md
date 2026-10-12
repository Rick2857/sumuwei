# ADR-002：ConversationEvent 与 DomainEvent 分成两层

- **状态**：已采纳（M2.5）
- **日期**：2026-09-16
- **相关**：[event-model.md](../architecture/event-model.md)、[invariants.md](../architecture/invariants.md) 铁律 3

## 背景

需要长期记录两类完全不同的东西：

1. **真的发生了什么** —— 用户说了什么、她回了什么。这是事实。
2. **她因此如何变化** —— 关系涨了、记住了什么、形成了什么看法。这是解释。

M1/M2 把这两件事混在 `memories` 一张表里（按 `type` 列区分），
而 `state_events` 只记了变化的结果与一句人类可读的 `reason`。

后果很具体：**无法回答"她为什么变成现在这样"**。
`state_events.reason` 是一句话，不是一个可跳转的引用。

## 决策

两张表、两个 Model：

| | ConversationEvent | DomainEvent |
|---|---|---|
| 表 | `conversation_events` | `character_domain_events` |
| 语义 | 发生了什么 | 她因此如何变化 |
| 可改写 | **不可**（没有 update/delete 导出） | 不可 |
| 来源 | 它**就是**来源 | 必须引用 `sourceConversationEventIds`（不得为空） |
| 序号 | `(character_id, sequence)` 唯一 | 各自独立序列 |

DomainEvent 的类型是**受控登记表**（`DomainEventRegistry`），
不是自由字符串：M2.5 只登记 `TEST_CHARACTER_SIGNAL`，
M4–M11 逐个登记新类型。Validator 只接受登记表里的类型。

## 被否决的方案

### 方案 A：一张 `events` 表，用 `kind` 列区分

**否决理由**：这是最省事的做法，也是最早出问题的做法。两张语义不同的表
合在一起后，"哪些字段对哪些 kind 有意义"会变成一堆积压的条件判断，
而类型系统帮不上任何忙。

更糟的是：**来源隔离会失去落脚点**。ConversationEvent 的 `actorType`
是"她自己的话不能成为外部事实"（铁律 6）的唯一载体；
混进通用事件表后，它会退化成"某些 kind 才有的字段"。

### 方案 B：只保留 ConversationEvent，变化由 Projection 自己推导

**否决理由**：那样"变化"就没有独立的历史。Projection 是**缓存**
（ADR-003 明确它是可重建的），把解释逻辑放在缓存里意味着
改一次算法就丢掉所有旧的解释——包括"当时为什么这么理解"。

### 方案 C：DomainEvent 不强制引用来源

**否决理由**：这会让审计链在**最容易断的地方**断掉，而且是静默断掉。
允许一条没有来源的变化进库，等于允许"她无缘无故变了"。
Validator 对此**失败关闭**：`source_event_missing` 直接拒绝。

## 后果

**正面**
- "为什么她现在 trust=0.61" 有了可跳转的答案：DomainEvent → ConversationEvent → 原话。
- 来源隔离有结构载体（`actorType`），而不是靠 Processor 自觉。
- DomainEvent 的 `idempotency_key` 唯一约束让"重试不产生重复副作用"
  成为数据库层面的事实。

**负面 / 成本**
- 一次交互要写两条事件（用户 + 助手），加上慢路径的领域事件，
  写入次数是 M2 的三倍。实测主链延迟几乎无变化（都是本地 PGlite 写入）。
- 两个序号空间（对话 / 领域）需要分别理解。这是刻意的：
  混用一个会让"第 7 轮对话"和"第 7 次变化"变成同一个数字，从而无法区分。

## 附带的实现决定

**Processor 先自查幂等，再提案**（而不是依赖 Validator 拦下来）。

理由：正常重跑应该是**安静的成功**。把兜底当主路径会让每次重试
都在日志里留下拒绝记录，真出问题时反而淹没在噪声里。

Validator 的 `duplicate_operation` 仍然保留，作为并发下的第二道闸。
