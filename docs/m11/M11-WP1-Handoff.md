# M11 WP1 交接单

- 日期：2026-10-01
- 工作包：WP1（ADR、验收契约与反思范围冻结）
- 状态：**COMPLETE** —— 四份产物已出，**设计已冻结**
  （2026-10-01 用户逐字：「我同意你刚才说的五项方向.继续进行」；
  ADR-085 与验收契约 = `ACCEPTED / DESIGN FROZEN`，逐字引文见 ADR-085 §0.1）
- 上游：[`M11-WP0-Baseline.md`](M11-WP0-Baseline.md) · [`M11-WP0-Handoff.md`](M11-WP0-Handoff.md)（HEAD `e5028472`）
- 下游：**WP2 可开工**（前置已满足）
- 本轮**没有**：改产品代码 · 打开数据库 · 调模型 · 出网 · 改生产 `.env` · 改历史证据

---

## 1. 本轮交付

| 交付物 | 位置 | 状态 |
|---|---|---|
| 设计裁定（D01–D24 冻结 + WP0 驱动的 D25–D33 + §4 技术接口冻结） | [`docs/adr/ADR-085-…`](../adr/ADR-085-m11-reflection-and-bounded-adaptive-self.md) | **PROPOSED**（待用户裁定） |
| 验收契约（阈值 / 三类材料 / 手算根样本 / 消融 / 人审 / 命令 / 十四槽） | [`M11-Acceptance-Contract.md`](M11-Acceptance-Contract.md) | **PROPOSED**（与 ADR 同批） |
| 未决项登记（只登记不影响授权/采纳/失效/遗忘的项） | [`M11-Unresolved-Decisions.md`](M11-Unresolved-Decisions.md) | 登记完成 |
| GitHub 借鉴登记（6 个固定 pin + 逐 WP 四段义务） | [`M11-OSS-Borrowing-Register.md`](M11-OSS-Borrowing-Register.md) | 登记完成 |
| 本交接单 | `M11-WP1-Handoff.md` | 完成 |

**计划书 [`M11-Execution-Plan.md`](M11-Execution-Plan.md) 一字未改。**

---

## 2. ✅ 送审事项（**已裁定**，2026-10-01）

| # | 送审项 | ADR 位置 | 裁定 |
|---|---|---|---|
| 1 | 三个行为槽的语义 | `D09` / §4.6 / 契约 §3.4 | ✅ 按推荐值批准 |
| 2 | 稳定采纳门槛（≥3 独立根 / ≥2 会话 / 无未解决冲突） | `D10` | ✅ 按推荐值批准 |
| 3 | 阈值与上限全集 | `D30` / 契约 §2 | ✅ 按推荐值批准 |
| 4 | 事件族形状与生命周期 | §4.2 / §4.3 | ✅ 按推荐值批准 |
| 5 | 两个开关名与缺省（代码缺省均 false） | `D19` / §4.8 | ✅ 按推荐值批准 |

逐字引文与授权边界见 [ADR-085 §0.1](../adr/ADR-085-m11-reflection-and-bounded-adaptive-self.md)
（`R-M11-01`）。其余裁定（D01–D08 · D11–D29 · D31–D34）用户未提出异议 ⇒ 一并冻结。

**前置已满足**：ADR-085 与验收契约 = `ACCEPTED / DESIGN FROZEN`。

---

## 3. 交给 WP2 的输入（来源链与根解析）

**前置（✅ 已满足）**：ADR-085 = `ACCEPTED / DESIGN FROZEN`（2026-10-01 用户批准，§0.1）。

### 3.1 WP2 的改动面（WP0 已逐条核对过）

```text
① `src/kernel/contracts/proposal.ts`           —— 提案追加 causedByDomainEventIds（可选）
② `src/kernel/policies/validator.ts`           —— accepted event 透传该字段
③ `src/infrastructure/persistence/event-store.ts` —— 写入由固定 `${null}::jsonb`
                                                     （现 `:169`）改为 `accepted.causedByDomainEventIds ?? null`
④ 新增：纯 root resolver + 基础设施**只读**适配（默认不改 DDL）
```

**零迁移**：`caused_by_domain_event_ids` 列已存在，读回已映射（`event-store.ts:106`）。

### 3.2 WP2 必须满足（ADR `D25` 的落成）

```text
· 旧调用者缺字段 ⇒ 仍写 null（兼容）；**不补写历史事件**，不改旧事件的证据含义。
· 校验（失败关闭）：父事件存在 · 同 character · 序号早于本事件 · 无环；
  跨用户引用按各来源的 subject/target 规则复核。
· 历史事件缺二跳字段 ⇒ 从 Memory evidence / Belief roots / Goal sourceRefs 解析；
  无法追溯 ⇒ **降为不可用于采纳**（不许猜父事件）。
· 遍历上限：深度 16 / 节点 64 ⇒ 超过返回 `lineage_limit_exceeded`，**不截断假装根已齐全**。
· 根**按真实 ID 去重**：同一 root 的重复检索 / 不同摘要 / 多个派生节点**不**增量计证。
· 五类标签分列：user_statement / user_report / program_result / assistant_speech / 内部解释。
```

### 3.3 WP2 的验证（**不是只测类型**）

```text
· 真实 append/readback（隔离库），不是只测 TypeScript 类型。
· 同根不同派生链 ⇒ 有效根恰好 1；不同根 ⇒ 计数正确。
· 负控：缺根 / 循环 / 父事件晚于子事件 / 跨角色 / 超限 各自有具名码，且**都不可用于采纳**。
· 旧事件 null 可读；旧折叠与字节**未被回写**（0001–0010 内容指纹不变）。
· 量具：用**独立手算图**（契约 §4.4 的表）验证，**不得**复用 resolver 算 expected。
```

### 3.4 借鉴登记（WP 交接单必须写四段，见[登记册](M11-OSS-Borrowing-Register.md) §3）

```text
WP2 涉及：Generative Agents 的证据映射（`reflect.py`，pin fe05a71d…）→ 只借"引用只能来自程序候选"，
          不借用它的 thought 写 memory / 递归 thought / 占位 insight。
```

### 3.5 环境纪律（WP0 的实测发现，直接适用）

```text
① 一律 `isolateDatabase()`；本工作树的 `data/pglite` 是**陈旧副本**，不是生产库（L-M11-05）。
② Live 门在主 checkout 跑（本树无 .env/.env.test，L-M11-04）。
③ 本机 `pnpm <script>` 被供应链校验阻塞 ⇒ 用同一入口文件直接调用并写明（L-M11-08）。
④ 结构判据先 `stripComments()` 再判（WP0 判据缺陷 #1 的教训）。
```

### 3.6 WP3–WP8 的形状指针（2026-10-01 侦察所得，**不必重新发现**）

| 面 | 照抄对象（文件 : 行） | 必须遵守的既有纪律 |
|---|---|---|
| **来源/引用契约** | `contracts/goal-reference.ts`（`MemoryReference` / `BeliefReference` / `ReferenceRejectionReason` 闭集 / `REFERENCE_REJECTION_FACTS` / `ReferenceUsability = hard\|soft`）· `app/goal/inputs.ts`（`recheckGoalDependencies` 的 `measuredCount` 与"0 ⇒ MEASUREMENT INVALID"） | 按**确切 ID**回查、批量去重（不逐条 N+1）；**禁止**用 Recall 排名/top-k 判断依赖是否存在；任一端口抛错 ⇒ **全部** `unavailable`（失败关闭） |
| **根与同轮叠加** | `app/belief/eligibility.ts`（`recheckBeliefDependencies` 去重 · `applyInvalidationOverlay` 纯函数、**只降不升**）· `app/goal/inputs.ts:488-529` 同款 | 同轮刚失效的 id 进 overlay ⇒ 依赖它的项**同轮**排除；"没给引用" ≠ "假装检查过" |
| **撤回/遗忘** | `contracts/withdrawn-evidence.ts`（`WithdrawnSetResult.measuredCount` · 失败关闭分级）· `infrastructure/persistence/withdrawn-evidence.ts:81`（记录面 + 事件面两条路径） | 不新增表/列；链上限 20；缺 reason ⇒ 按**最宽**处置 + 具名 gap |
| **遮蔽单一来源** | `app/goal/invalidation.ts:242` `goalContentMustBeMasked()`（对话侧与开发者面**共用**） | "两处各写一遍『什么算可用』迟早漂移" |
| **事件注册** | `contracts/domain-event.ts`：`DomainEventTypeSpec`（`validatePayload` 抛**普通 Error** + `maxPayloadBytes`）· `createGoalDomainEventRegistry()` · `createFullDomainEventRegistry()` 组合 | `DomainEventType = string`（**无联合**）；allowlist = 注册表 + `<DOMAIN>_DOMAIN_EVENT_TYPES`；**先登记、后接线** |
| **提案与放行** | `contracts/goal-proposal.ts`（`*_SCHEMA_VERSION`）· `policies/goal-validator.ts`（`reject()` 累积 `RejectedTarget{type,code,message}`，**不抛**；域内幂等键 `goalUnitOperationOf()`） | 提案是**原子的**：任一目标被拒 ⇒ 整份 `acceptedEvents: []`；`KernelError` 只用于契约/基础设施违约 |
| **投影与写路径** | `projections/goal.ts`（`goal-fold@1` + 前缀 `goal:`）· `persistence/goal-store.ts`（`applyGoalRows` / `rebuildGoalProjections`）· `withdrawn-evidence.ts` 的薄适配层 | 本域写入口**恰好 2 个**；读面**不得**出现 `insertProjection/saveProjection/deleteProjection/inTransaction`（判结构先 `stripComments()`） |
| **上下文注入** | `context/goal-sections.ts`（`maxTokens <= 0` 时**根本不渲染** ⇒ 关闭档 prompt 逐字节相同）· `turn-gateway.ts:1316-1347`（`maxTokens` 来自**那一个** `ContextBudget`）· `main.ts:1048-1065` 的 `recallBudget` 块 | **selector 是唯一预算权威**；renderer/provider **不得**写第二个默认；被裁 ⇒ **不算**入模 |
| **"实际入模"的记法** | `turn-gateway.ts:1977-2070`（`goal_context` 的 `fact_included` / `state_included` / `state_row_ids` **只来自最终 packet**）· `record.ts:288-302` `applyContextReality` · `external-evidence.ts:710-737` `evidenceContextReality` | "选择器选了谁" ≠ "模型看到了谁"；候选/计划/实际**分列** |
| **可观测性** | `contracts/observability.ts` 的 kind→stage 映射表（M10 五条）· `TELEMETRY_ATTRIBUTE_ALLOWLIST` + 敏感片段 | **12 个阶段冻结**，不加第 13 个；理由码**先登记**（空数组 = 全拒）；正文被键级/值级/类型级三层挡着 |
| **后台任务** | `infrastructure/runtime/belief-scheduler.ts`（水位门 · `no_tail` / `recovered` / `failed` 四态）· `affect-scheduler.ts:434-449`（**catch 必须落 `failed`**）· `affect/job.ts:200-215`（**跳过 tool 同时推进水位**） | 不新增守护进程/定时器（挂在 `open`/`send` 两个既有钩子上）；`failed` 的幂等键可重建 |
| **超时/取消** | `infrastructure/goal/understanding-runtime.ts:33-59` `withDeadline`（`finally` 里 clear + unref）· provider 的 `AbortController` 形状 · `encoder-client.ts:268-298`（未清理定时器吊住进程 180 s 的教训） | 仓库**没有**通用 `withTimeout`；**不得**留下未清理的定时器 |

⚠️ **两处事实更正**（2026-10-01 侦察 + 判据修订确认）：
① `ContextBudget` 在 `src/kernel/recall/selector.ts`（**不在** `contracts/context.ts`），且是 **6** 个额度字段；
② **late-write fence 在仓库里不存在**（`D17` 要求它真实生效 ⇒ M11 要自己建，见 `L-M11-11`）。

---

## 4. 后续 WP 的依赖顺序（本 WP 之后）

```text
WP2 来源链 → WP3 输入/候选 → WP4 审查 → WP5 行为策略 → WP6 跨域/失效
             → WP7 任务/装配 → WP8 上下文/解释 → WP9 量具/离线
             → WP10 真模型/人审 → WP11 收口 → WP12 激活候选
```

每份 WP 交接单必须含：实际路径、提交、验证命令、退出码、runId、发现、未做事项、下游约束，
以及 §3.4 的四段借鉴登记。
