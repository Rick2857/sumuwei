# M9 WP3 交接单 —— 产出者（评估器）+ 判据一致性 + 变更流增量读（2026-09-27）

> 状态：**DONE**（`m9:source:verify` **26/26** · 冻结区追加复验全绿）
> 上游：[ADR-070](../adr/ADR-070-belief-perspective-and-revision.md)（D05·D07·§3.4）·
> [M9-WP2-Handoff.md](M9-WP2-Handoff.md)（合同 + 语料 + oracle）
> 下游：WP4（Validator + 投影 reducer + store + 全量登记表接线）

## 1. 交付物

| 文件 | 内容 |
|---|---|
| `src/kernel/app/belief/patterns.ts` | **冻结规则表** belief-inferred-rules@1：9 守卫（任务指涉/引用/假设/代述/提问形/命令式信念注入/中立比较/反讽/过去偏好）**先行**（守卫优先于正控），10 detailed + 10 concise 正控词形（带语料锚点），双值冲突具名回退 `conflicting_values`（不猜） |
| `src/kernel/app/belief/evaluator.ts` | `RuleBasedBeliefEvaluator`：资格四条（user_message + ESTABLISHED + active user + 切换后）+ **会话维度失败关闭**（具名 abstain）；EVIDENCE_NOTED 每命中一根；按 **(槽位, 值)** 合并累计（去重 INV-M9-04/08；窗口 ≤50 最近根切片）；**同值现存 ⇒ 新根即强化**（REINFORCED 不设阈值闸——信念已存在）；FORMED 阈值闸（≥3 根 · 跨 ≥2 会话）+ 确定性 beliefId（formationKey = 合并根最大 sequence）；**异值现存 ⇒ 照提 FORMED**（冲突是真实信号；DISPUTED/SUPERSEDED 归 WP4/WP5）；abstentions 一等输出（具名理由，可审计） |
| `src/kernel/contracts/processor.ts` | 点追加 `conversationId?: ConversationId`（可选 = 既有构造点全合法；B-INFERRED 跨会话判据需要会话维度） |
| `src/kernel/app/memory/extractor.ts` | `processorEventViewOf` 填充 conversationId（**冻结区只追加**，零语义变更；M4 全家复验见 §2） |
| `src/kernel/contracts/belief.ts` | `BeliefFormedPayload.dependsOnMemoryIds` 改可选（校验器语义本就是"空集合用 undefined 不用 []"；B-INFERRED 省略该字段） |
| `src/infrastructure/persistence/event-store.ts` | `domainEventsFor` 点追加 `afterSequence`（**严格大于**；可与 beforeSequence 组合成开区间；不带选项的读法逐字不变——§4 机器证明） |
| `scripts/m9-source-verify.ts` | WP3 门（`m9:source:verify`）四段 26 项：语料一致性 / 资格负控 / 形成生命周期 / afterSequence 集成（隔离库） |

## 2. 门读数（全部机器读数；head = `db1c571`）

| 门 | 读数 | 说明 |
|---|---|---|
| `pnpm typecheck` | EXIT 0 | （另一会话的在途文件 `verify-td10-search-reliability.ts` 一度过红，其自愈；非本 WP 改动） |
| `pnpm m9:source:verify` | **26/26** | runId `m9-wp3-source-20260927-db1c571acaa1-7dc9`；FAIL 中间档 `…-6929`（23/26，head `87747e6`）诚实保留 |
| `pnpm kernel:test` | **26/0** | belief app 过依赖方向静态锁 |
| `pnpm kernel:verify` | **25/0** | Phase C |
| `pnpm m3.5:test` | **30/0** | FC 锁不受 contracts 追加影响 |
| `pnpm m4:test` | **258/0** | 冻结区追加复验 |
| `pnpm m4:verify` | **142/0** | 同上 |
| `pnpm m4:mutation-safety:verify` | **20/0** | 同上 |
| `pnpm m4:nl-mutation:verify` | **38/0** | 同上 |
| `pnpm eval:m4` | **17/0** | 行为回归 |

## 3. 门的校准记录（第一轮，3 个缺陷——由门自己发现）

1. **语料漏判 bi-d-p10**："以后这种地方都要展开"——longterm-style 词形只认 这样/这么，不认 这种地方。补 `bi-d-longterm-expand`（以后…展开/细讲/详细/逐步）。规则表仍 @1：**激活前校准**，任何库里的任何事件都还没引用过这个版本号。
2. **REINFORCED 被阈值闸误拦**（真语义缺陷）：强化 = 信念已存在 + 新根，不需要重新跨阈值；阈值闸只管 FORMED。评估器判序已修正（头注释同步）。
3. **夹具默认参数陷阱**：`userView(..., undefined)` 被 TS 默认参数换成 `ESTABLISHED_ORIGIN`，"无信封"负控实际测的是正控（proposals=1）。改为显式无信封视图字面量。
4. 证据纪律自纠：PASS run `…-d1c3` 产自未提交树（head 归因失真）→ 删除；有效证据 = FAIL `…-6929`（committed `87747e6`）+ PASS `…-7dc9`（committed `db1c571`）。

## 4. WP4 输入（下一步的起点）

- **评估器提案形状已冻结**：EVIDENCE_NOTED（operation=create）/ FORMED（create）/ REINFORCED（reinforce）；proposalType 前缀 `belief:`。Validator 的幂等键推导素材：EVIDENCE_NOTED 按 (rootEventId, ruleId) 天然去重；FORMED 按 beliefId；REINFORCED 按 (beliefId, newRootIds 集合)。
- **累计投影键 = (槽位, 值) 复合**：`beliefEvidenceKeyOf(slotKey, value)`（`slotKey|value` 传给 `beliefEvidenceProjectionTypeOf`）——value 不进**信念槽位键**（D03），但进**累计键**（detailed 的证据不支持 concise）。WP4 reducer 写侧与 Job 读侧必须用同一函数。
- **冲突信号已就位**：异值现存时评估器照提 FORMED——WP4 Validator 需要把它翻译成 DISPUTED（或按修订规则 SUPERSEDED），这是 §4.2 状态机的第一块真实输入。
- **abstentions 是审计面**：Job 层（WP6）应把它们记进 trace/日志（不是提案，不落事件）。
- **afterSequence 可用**：WP5 回查协调器按"上次看过的最大序号"拉新 Memory 事件（`MEMORY_FACT_*` 类型过滤 + afterSequence）。

## 5. 边界（WP3 没做什么）

- 没有 Validator / 投影 reducer / store（WP4）——评估器只提案，**零落库**。
- 没接全量登记表（WP4）；没建 `CHARACTER_BELIEF_ENABLED`（WP6/WP8）。
- 没有 B-REPORTED 产出者（WP5 回查协调器从 Memory 投影侧产出）。
- 没有 NL 修订路由（"她记错了"→ dispute/retract 的入口在 WP5，U-03 未决项）。
- 规则表 @1 的**激活前校准**已完成；激活后（首个引用该版本号的事件落库后）改词形 = 升版本走 ADR-070 §13 变更程序。

## 6. 提交链（本 WP）

```
87747e6  feat(m9): WP3 belief interaction evaluator + frozen rule table + afterSequence additive read
db1c571  fix(m9): WP3 source gate calibration round 1 (3 defects found by the gate)
93a9e44  test(m9): WP3 source gate evidence - PASS 26/26 + FAIL intermediate kept
```
