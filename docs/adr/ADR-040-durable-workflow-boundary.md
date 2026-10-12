# ADR-040：持久工作流边界（Temporal / durable execution）

- 状态：**已采纳**（M5.1 WP6，2026-09-17）
- 里程碑：M5.1（OSS Integration Audit）
- 相关：ADR-030（唯一执行入口）、ADR-033（执行真相先于回复）、
  ADR-034（账本不是记忆）、`docs/m4.5/M4.5-Execution-Truth.md`、`docs/m5.1/M5.1-OSS-Audit.md` §4
- 裁定：**Temporal（调度/重试/长时编排 Provider）= REFERENCE** ·
  **Temporal（Execution Truth Authority）= REJECT** · **M5.1 内接入 = REJECT**

---

## 1. 背景与实测

执行真相今天已经在**我们这边**（仓库实测）：

| 事实 | 形状 |
|---|---|
| 行动账本事件 | **9 种** `ACTION_*`（REQUESTED / TARGET_RESOLVED / AUTHORIZED / REJECTED / STARTED / SUCCEEDED / FAILED / PARTIAL / CANCELLED） |
| 折叠 | `foldExecutionRecord` / `foldRecord` —— **唯一**的"她做过什么" |
| 幂等键 | `actionIdempotencyKey`：由"能力 + 操作 + **已解析目标** + 参数"的**稳定序列化**推导（语义键，不是随机 id / 不是时间戳） |
| 幂等声明 | 能力声明三档：`none` / `supported` / `required`（`required` 缺键即拒绝） |
| 回复层 | 只认 `ActionResult`：`executed === false` 时**不允许成功口吻**（ADR-033） |

Temporal 的一手事实：**Durable Execution** —— Workflow 状态持久化、Activity **原生重试**
（默认无限次，可配指数退避）、"at-least-once" 执行；文档**明确建议** Activity 要幂等，
否则重复执行不应产生意外副作用。来源：[产品页](https://temporal.io/product)、
[Idempotency and durable execution](https://temporal.io/blog/idempotency-and-durable-execution)。

---

## 2. 五项解释

### Landing Target
**`CapabilityAdapter` 之外的编排层**（如果将来需要）：
- 它可以决定"**什么时候重试**""**跨重启继续**""**等一个定时器**"；
- 它**不**决定"这件事有没有成功"（那是 `ActionResult` + 账本）；
- 落点属于 `infrastructure/action/`（或更外层），**不属于** `src/kernel/**`。

### Authority Boundary
| 问题 | 谁来回答（不可让渡） |
|---|---|
| 她做过什么？ | `character_action_events`（ADR-034） |
| 这件事成功了没有？ | `ActionResult`（ADR-033） |
| 这次请求是不是同一次？ | 我们的**语义幂等键**（能力+操作+目标+参数） |
| 允许做吗？ | `policy.ts` + 装配层授予的权限（ADR-031） |
| 什么时候重试？ | ← **只有这一个可以交给 Temporal** |

Temporal 的 Workflow History **不是**事实源：它记录的是"编排执行到哪一步"，
而不是"角色对世界做了什么"。两者混同之后，
"她说她做了但账本里没有"这类差异将无法判定。

### Replacement Strategy
Temporal 与我们的**相容点**恰好是它**要求**幂等，而我们**已经有**语义幂等键 ——
也就是说"接上它"需要补的是**编排接线**，不是重写执行语义。
替换成本：
- 协议层：需要 spike（本轮未做）；
- 语义层：**Activity ↔ 能力操作**的映射；Activity 的 retry 必须携带**同一个**幂等键，
  否则"重试安全"是假的（这正是 Temporal 文档自己强调的那条）。

### Failure Isolation
- Temporal 服务不可用 → 只影响**新的编排**，不影响"她这一轮对世界做了什么"：
  已完成的执行仍在账本里，`foldExecutionRecord` 仍能回答"她做过什么"；
- 长时动作超时 → 必须落 `timeout`（受控码），**不许**当成 pending 永远挂着；
- 一个失败 Activity 的重试**不得**产生第二次副作用 —— 判据是账本里
  `ACTION_STARTED` 的条数与 `idempotentReplay` 标记（M5.1 WP3 已经把
  "重放不得第二次执行"变成了可测的形式）。

### Future Milestone
**未来里程碑**（M5.1 的 G-05 已排除执行架构改造）。准入判据：
1. 先证明"我们的语义幂等键能被 Temporal 的 Activity 用上"（它要求幂等，我们已有键）；
2. 明确写下"Workflow History 不是事实源"这条边界；
3. 只接**编排**：不新增一个回答"成功了吗"的地方。

---

## 3. 备选与否决理由

| 备选 | 否决理由 |
|---|---|
| 用 Temporal 取代 `ActionGateway` | 违反 ADR-030（唯一执行入口）与 ADR-031（能力登记） |
| 用 Workflow History 当审计账本 | 违反 ADR-034；且它记的是编排步骤，不是世界变化 |
| 用 Temporal 的"至少一次"取代我们的幂等闸 | 它保证的是"至少一次"，我们要的是"**副作用至多一次**"（靠语义键 + 账本，两回事） |
| M5.1 内接入 | 引入一个服务端依赖 + 一套新运行模型；且 M5.1 的 Scope Fence 不含执行架构改造 |

---

## 4. 后果

- 本轮**不动任何代码**；行动四件套（请求 / 目标 / 结果 / 账本）原样有效。
- 本条把"长时编排"明确登记为**我们确实没有的能力**（不是缺陷，是范围）——
  将来若要做长时动作，Temporal 是第一个该看的候选，但**不是**事实源的候选。
