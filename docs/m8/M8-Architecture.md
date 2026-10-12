# M8 Architecture（Affect 情绪状态演化）

> 状态：**ACTIVE**（2026-09-26，随 M8 WP8 收口发布）
> 设计权威源：[ADR-066](../adr/ADR-066-affect-state-evolution.md)（`ACCEPTED / DESIGN FROZEN`，24 项裁定）
> 计划：[M8-Execution-Plan.md](M8-Execution-Plan.md) · 判定：[M8-Gate-Decision.md](M8-Gate-Decision.md)
> 本文是**实现面导读**：ADR-066 说"为什么"，本文说"在哪、怎么接、怎么被验证"。

## 1. 位置：Character 域的第 4 个投影

M8 之前，Character Kernel 已有三个投影（memory / relationship / identity 派生面）。
Affect 加入后，事件溯源骨架**一寸未改**——它是同一条骨架的第 4 次实例化：

```text
conversation_events ──(评估器·词形判据)──> DomainProposal
        │                                    │
        │                            (放行口·fail-closed)
        │                                    ↓
        │                          character_domain_events
        │                                    │
        │                            (纯 reducer)
        │                                    ↓
        │                          character_projections
        │                                    │
        └──(水位·增量消费)──────────> context section 52 ──> prompt
```

复用与新增的分界（能力影响矩阵 = NONE，计划 §14）：

| 层 | 复用 | M8 新增 |
|---|---|---|
| 事件账本 | `conversation_events`（七槽位归因，M5.1.1） | 无 |
| 域事件 | `character_domain_events`（通用域事件表） | `affect:character` 事件类型 + payload 契约 |
| 投影 | `character_projections`（通用投影表） | `affect:character` 投影行 + reducer |
| 调度 | `character_jobs` + 水位（M7 攒尾窗骨架） | affect 评估 job（同形） |
| 上下文 | ContextCompiler section 机制 | `affect` section（id=`affect`，优先级 52） |
| 迁移 | **NONE**（无新表无新列） | — |

## 2. 分层与文件地图

```text
src/kernel/contracts/affect.ts        契约：轴值/事件 payload/注入块形状（纯类型+纯函数）
src/kernel/app/affect/patterns.ts     词形判据（affect-rules@1：七族规则+抑制+毒化+主导裁定）
src/kernel/app/affect/job.ts          评估器（窗口→资格→提案；tool 事件过滤·M8-D04）
src/kernel/policies/affect-validator.ts   放行口（fail-closed；注入 origin 具名拒收）
src/kernel/projections/affect.ts      纯 reducer（ORIGIN/TOUCH/IMPACT → v/a/revision）
src/kernel/context/sections.ts        affect section（52 号；渲染 guidance，无数值泄漏）
src/kernel/app/turn-gateway.ts        AffectTurnObservation 契约 + compileTurn 六步 trace
src/kernel/contracts/trace.ts         6 个 TraceStepKind 字面量（开放 union 追加）
src/kernel/contracts/observability.ts 阶段映射（轮内五步→turn；affect_context→context）
src/infrastructure/persistence/affect-store.ts   投影/事件/水位/rebuild 读写
src/infrastructure/runtime/affect-scheduler.ts    攒尾窗调度 + 同轮观测映射
src/main.ts                           装配：send() 捕获调度→观测→compileTurn 透传
src/kernel/app/flags.ts               CHARACTER_AFFECT_CONTEXT_ENABLED（缺省 false）
```

依赖方向不破例：contracts/policies/projections/context 不 import 基础设施
（`kernel:test` 边界组 26/0 守着）；只有 `app/` 与 infrastructure 接线。

## 3. 数据流（一轮的真实时序）

1. **beginTurn**：用户事件落账（`conversation_events`，七槽位归因）。
2. **maybeRunAffectEvaluation**（同步、确定性、无 LLM、有界）：
   - 水位之后的增量窗口 → 过滤 tool 事件（M8-D04）→ 资格闸
     （`contentOriginator === activeUserId`，M8-D11 fail-closed）；
   - 词形判据 → touch 提案（每合格消息一条）+ impact 提案（消息级主导规则族，
     每消息 ≤1）；
   - 放行口校验（schema + origin 注入拒收 + 越界拒收）→ 域事件落库
     （`AFFECT_TOUCH` / `AFFECT_IMPACT`，payload 带 sourceEventId + ruleId）；
   - 纯 reducer 应用 → 投影 upsert（valence ∈ [−1,1]，arousal ∈ [0,1]，
     revision 单调）；job 行 completed；**commit 后才推水位**。
3. **渲染**：读到**含本轮**的投影（`effectiveAffect`：读时衰减 v 半衰期 4h、
   a 5h，**永不写回**——canonical 值只在投影里）。
4. **compileTurn**：五步轮内观测 trace（eligibility→proposal→validation→
   event→projection）+ packet 之后的 `affect_context`（记 section
   included/dropped/not_generated + `applied_this_turn`）——**reply-truth 绑定**：
   她的回复与程序事实在同一条 trace 树上。
5. **completeTurn**：助手回复事件落账（被下窗消费但**永不是情绪证据**——
   assistant 零提案，负控 A09）。

## 4. 关键设计裁定的实现锚点（ADR-066 → 代码）

| 裁定 | 实现锚点 | 机器证据 |
|---|---|---|
| M8-D02 单一 canonical writer | flag 开 ⇒ `affect:character` 是唯一权威；旧 `src/state` 字段不写不读 | WP5 负控（基线逐字节不变） |
| M8-D03 单投影不分片 | `affect:character`（per-Character） | WP4 门 |
| M8-D04 tool 内容不是证据 | `job.ts` 过滤 + `skippedToolEvents` 计数 | e2e A10 |
| M8-D05 建档 cutover=账本尾 | ORIGIN 事件 payload `cutoverSequence`；旧历史永不回评 | e2e A19 + Live LV-ORIGIN（生产副本 cutover=117） |
| M8-D06 origin 注入 fail-closed | validator 具名拒收 `affect_origin_injection_not_enabled` | e2e A20 |
| M8-D11 归因资格闸 | `contentOriginator === activeUserId` | e2e A11/A18 |
| M8-D14 flag 缺省 false | `flags.ts`；`.env` 无该键 | WP5 基线门 |
| 读时衰减不写回 | `effectiveAffect` 纯函数 | e2e A16（+8h 衰减读数带"已衰减"） |
| 失败分类法不新增 | 调度 catch → failed（不抛不重试不等待）+ 注入块如实边界行 | WP6 N2 + e2e 恢复组 |
| 语义评估器预留 | `A-UNCERTAIN` 具名回退（v1 恒不产 impact） | WP3 门 |

## 5. 失败与恢复的形状

```text
评估输入失败   → job 行落 failed（WP7 修复）→ 水位不动 → 下窗一次补洞（域键幂等保零重复）
store 写入失败 → 事务回滚（零半写）→ 同上
崩溃模拟       → 水位停在最后 commit → 重启 no_tail / 同窗重放撞 duplicate_operation
投影损坏       → rebuildAffectProjection 删行重放 === 在线（不变量②）
```

同窗重试的完整语义（WP7 修复后）：failed 键可重建（job-store 部分唯一索引的
设计契约）；completed 键不可重跑——"finishJob 与推水位之间崩溃"的 stale-completed
形状是**两步自愈**（先 `job_not_pending` 如实转 failed，再重建靠域键幂等零重复），
e2e A12 冻结该行为（L-M8-14）。

## 6. 上下文注入块（用户可见面的唯一出口）

section 52（`affect`）：确定性渲染，**无数值泄漏**——不出现 valence/arousal
数值、规则名、小数；只有定性 guidance（行为倾向行）+ 边界行
（`appliedThisTurn === false` 时如实写"本轮未完成情绪更新"）。
注入块明示"这是内部程序状态，不是对对方真实情绪的判断"。
机器面查词形级泄漏（Live LV-REPLY 零命中）；语义级由盲审把关（L-M8-12）。

## 7. 观测面（trace 六步 + 遥测边界）

```text
affect_eligibility → affect_proposal → affect_validation
→ affect_event → affect_projection → (packet 后) affect_context
```

- trace 属性纪律：只有 id/计数/拒码/布尔——**无对话正文、无情绪数值**
  （valence/arousal 的值永远不进 trace）。
- 遥测白名单对齐 AT1.4 后缀族：`_count`/`_ids`/`outcome` 进 span；
  `applied_this_turn`/`window_from`/`revision_to` 仅 trace 行可见。
- 阶段映射不开第 13 阶段（`OBSERVABILITY_STAGES.length===12` 的 M5.1 门不动）。

## 8. 与 M7 的并存关系

两个投影、两个 section、两个调度 job 类型——**语义零耦合**：
关系读数不是情绪输入，情绪读数不是关系输入（ADR-066 §8.3）。
e2e A17 证明双 section 并存且词形互不污染；长轨迹 L-M7 证明 500 轮混跑
零混入。M7 的两个潜伏缺陷（tool 楔死 + catch 不 finishJob）登记 L-M8-13
交 M7 维护线，M8 未动 M7 已交付文件。

## 9. 验证骨架（怎么知道它是对的）

四条车道 + 一个汇总（详见 Acceptance-Report §4）：

```text
部件门（WP2–WP6）   隔离库 + 真实 TurnGateway + store 失败注入
e2e（A01–A20+L2）   正控/负控/恢复三段式 + 开发者面读回
长轨迹（1×500）     边界夹紧 + rebuild 对账 + 重启探针 + 衰减弧线
Live Smoke（副本）  真模型 + 交互控制台 + 真实历史零重判 + 回复零泄漏 + 库未动
m8:gates            只读已落盘证据（缺文件=NOT RUN；失败档分列保留）
```

量具有效性（INV-M45-06）的 M8 落地：语料不变量开跑闸（纯函数自证，
破损即拒跑）+ 负控的第二道独立断言（Live 的 IMPACT sourceEventId 全员
∈ 冻结文本）+ 计数对账防线（长轨迹的事件总数 === ORIGIN + 各窗之和）。
