# ADR-030：ActionRequest 是**唯一**的执行入口

- **状态**：已接受（M4.5）
- **日期**：2026-09-17
- **相关**：M4.5 计划书 §2 / §7 / §13 / §14 / §61；INV-M45-02；STOP-03
- **代码**：`src/kernel/action/gateway.ts`、`src/kernel/action/action-request.ts`、
  `src/infrastructure/action/adapters/*`

---

## 背景

M4.5 之前，这个仓库里**没有任何"执行"概念**：唯一会改变外部状态的东西是
数据库写入，而它走的是 `ConversationLedgerPort` / `applyAcceptedEvents`
这些**具名端口**。

一旦加入真实能力（先沙箱文件，以后是搜索 / HTTP / 消息 / 调度），
最危险的形态不是"某个能力写错了"，而是：

```text
LLM ──► 某个能力的 SDK ──► 世界
```

这条直连有三个后果，每一个都能让 M4 的教训重演：

| 后果 | 具体表现 |
|---|---|
| **无目标确定性** | 模型把"report.txt"解析成它自己挑的那一个，然后删掉 |
| **无权限判定** | 某插件自己决定"用户说了所以可以执行" |
| **无审计** | 外部世界真的变了，但系统里没有任何一条记录 |

计划书 §13 对此的要求是直白的：禁止 `LLM → Tool SDK`，
必须是 `LLM → ActionRequest → Tool Gateway → Adapter`。

---

## 决策

**所有能力执行都必须先形成一个 `ActionRequest`，并且只有 `ToolGateway.execute()`
可以把它变成副作用。适配器（Adapter）不允许被任何其它模块调用。**

### 1. 请求是一个**值**，不是一次调用

```ts
interface ActionRequest {
  actionId: string
  traceId: string
  capability: string
  operation: string
  requestedBy: { kind: 'user' | 'character' | 'system'; id?: string }
  target?: ActionTarget
  arguments: Record<string, unknown>
  sideEffect: 'none' | 'read' | 'write' | 'destructive'
  idempotencyKey?: string
  createdAt: string
}
```

把它做成值而不是"函数调用"，是为了让三件事成为可能：

- **先判定后执行**：目标解析与策略判定发生在**任何 IO 之前**（ADR-032）
- **可重放**：同一个请求可以离线断言"它会被允许吗"
- **可审计**：请求本身（连目标与证据）进账本

### 2. Gateway 的固定顺序

```text
schema 校验 → registry 查表 → target 解析 → policy → idempotency → adapter 执行
           → 结果归一 → ledger 落账 → 返回 ActionResult
```

顺序里有两处是**刻意的**：

- **target 解析在 policy 之前**：策略要判"目标确定性够不够"，
  必须先有目标（ADR-032）
- **idempotency 在 adapter 之前**：重试不能变成第二次副作用

### 3. 适配器只认 operation，不认"谁想执行"

`CapabilityAdapter.execute(operation, args, ctx)` 拿不到 `requestedBy`，
也拿不到策略结论。它**不判断该不该做**，只负责"怎么做"。
"该不该"全部在 `policy.ts` 里，而策略是纯函数 —— 因而可以被单测穷举。

### 4. 唯一入口是**可机器检查**的

`src/kernel/action/gateway.ts` 之外的任何文件 import
`src/infrastructure/action/adapters/**` 都会被 `m4.5:test` 的
「无绕过」静态锁抓住（`scripts/kernel-tests-action.ts` 里按目录扫描 import）。

这与 M4.1 的「开关必须被真的消费」是同一种手法：
**约定写成代码能自己发现的形状，而不是写在注释里**。

---

## 被否决的备选方案

### 方案 A：让每个能力自己做一个 `execute()`，Gateway 只做日志

**否决理由**：那是把 M4.5 的整个价值（先判定、统一审计、可重放）
降级成"事后记一笔"。日志拦不住任何一次错误的目标。

### 方案 B：Gateway 只做权限，目标解析留给各适配器

**否决理由**：目标语义会分叉 —— 文件系统按路径、消息按联系人、
任务按标题。而"目标确定性不够就不许有副作用"（INV-M45-03）
是一条**系统级**不变量，不能由每个适配器各自解释。

### 方案 C：直接复用 `processed_operations` 做幂等

**否决理由**：动作的幂等需要**记住上一次的结果**（重放要返回同样的
`ActionResult`），而 `processed_operations` 只记"这个键处理过"。
拆开不共享（见 ADR-034 的边界讨论），内存的幂等口保持原样。

---

## 后果

### 正面

- 任何新能力**不可能**绕过目标确定性、权限与审计 —— 除非它绕过 Gateway，
  而那会被静态锁抓住。
- Gateway 是纯编排：策略、目标解析、结果归一各自可独立单测。
- 未来 LLM 提议动作（`requestedBy.kind = 'character'`）不需要改协议，
  只需要多一个"谁来产生请求"的适配层。

### 代价

- 每加一个能力要写三段声明（registry 条目 + 策略可判 + 适配器）。
  这是刻意的摩擦：能力必须被**登记**才存在（ADR-031）。
- Gateway 成为单点。缓解：它没有业务语义、没有 IO（IO 在适配器里），
  因此它出错的空间被压到"编排顺序"这一件事上。

---

## 怎么验证这条决策还成立

| 检查 | 由谁守 |
|---|---|
| 适配器只被 gateway import | `m4.5:test`「无绕过静态锁」 |
| 未登记能力执行 → `capability_not_registered` | `m4.5:test`「registry」 |
| 策略拒绝时适配器**一次都没有被调用** | `m4.5:verify` 阴性控制（调用计数器） |
| 重复 `idempotencyKey` 不产生第二次副作用 | `m4.5:verify` + L4 S7 |
| `ActionRequest` 在适配器之前就已经成形 | `m4.5:verify`「顺序」断言（ledger 中 `ACTION_REQUESTED` 早于 `ACTION_STARTED`） |
