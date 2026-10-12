# M9 WP6 交接单 —— 调度与装配（双流调度 + 生产装配）

- **工作包**：WP6（计划 §718–730；ADR-070 §6.3 双流）
- **状态**：✅ 完成（`m9:runtime:verify` 28/28 PASS，EXIT 0）
- **提交链**：`cf27873`（双流调度 + 生产装配）→ `bddff93`（页钳位 + 断点恢复加固）→ `49e5b31`（证据键翻译修复）→ `83d8701`（交互流账本证据查找修复）→ `3217ec3`（门夹具定稿）→ `ab2ab8e`（证据入库）
- **证据**：`artifacts/m9/m9-wp6-runtime-20260927-3217ec38de69-4af7/`（28/28；两轮历史读数 `…-80c8` 22/28、`…-f8cb` 28/28-脏树，如实保留）

## 1. 交付了什么

### 1.1 双流调度器（`src/infrastructure/runtime/belief-scheduler.ts`）

- **流 1 交互评估**：`maybeRunBeliefEvaluation(db, {characterId, activeUserId, activationId?, now?})`
  → `{no_tail | flushed | recovered | failed}`。水位空间 = `conversation_events.sequence`，
  处理器 `belief-interaction-evaluator@1`。
- **流 2 Memory 对账**：`maybeRunBeliefMemoryReconciliation(db, {characterId, now?})`
  → 同形状四态。水位空间 = `character_domain_events.sequence`（按 `MEMORY_*` 六类过滤），
  处理器 `belief-memory-reconciler@1`。
- **双水位独立**（ADR-070 §6.3）：两条流各自具名水位行，互不阻塞、互不覆盖（门 r5-01/r5-06 双向验证）。
- **建档**：`seedBeliefOrigin`（首次调度自动播种 `BELIEF_ORIGIN`，cutover=当前账本最大序号，
  切换前历史**不重放**；并发播种 = 如实 `already`）。
- **页钳位**（计划 §728）：窗口宽度 ≤ `BELIEF_PAGE_SIZE`(2000) ⇒ 区间读永不截断，
  "读了 = 全读"；余量留尾窗，水位绝不越过未读过的事件。门覆盖 2000/2001/4001。
- **断点语义**：
  - enqueue 断点：job pending，重试照常；
  - apply 断点（append 成功 fold 失败）：job 如实 `failed`、水位不动、重试同窗全撞键零新事件；
    纯重试的投影滞后由 `rebuildBeliefProjections` 修复（门 r4-02/03/04 全链验证）；
  - finish 断点：job running → 重试翻 failed → 再重试恢复；
  - **水位断点**：同窗 job 已 completed ⇒ `recovered` 只补水位，**completed 永不改写成 failed**（bddff93 修复的楔点）。
- **失败不阻断回复**：所有失败被 catch 成 `failed` 结果，绝不抛出到调用方。

### 1.2 生产装配（`src/main.ts` 三处 + `src/kernel/app/flags.ts`）

- 开关 `CHARACTER_BELIEF_ENABLED`（**缺省 off**；`readKernelFlags` 消费，`describeKernelFlags` 可见 `belief=on/off`）。
- 三个既有钩子（**无新建定时器/轮询/常驻 worker**——turn hook ≠ 自主后台任务）：
  ① 启动追赶（open）：两流 describe 日志；② 同轮（send 后）：两流各跑一次，`failed`→warn、`flushed/recovered`→info；
  ③ 回合后（post-turn）：两流各跑一次，`failed`→warn。
- 开关关闭 = 零新增认知（`flags.beliefEnabled` 守卫；m4/m4.5 开关消费锁回归通过）。

### 1.3 WP6 门（`scripts/m9-runtime-verify.ts`，`pnpm m9:runtime:verify`）

隔离真库 + 真装配路径（与 main.ts 同一模块同一导出），28 项检查覆盖计划 §728 全部判据：
开关三态 / 冷启动播种·cutover·不重放 / 记根·累计·同轮形成（3 根/2 会话阈值）/ 全不合格窗口
（她的回复·系统·工具·无信封行）/ 重放零重复 / 2000·2001·4001 页边界 / 播种·apply·水位三断点
（含 `rebuildBeliefProjections` 修复投影滞后）/ Memory 流 B-REPORTED 形成 + `dependency_invalidated`
失效传播（不禁根）/ 双水位独立 / 失效重放零重复。

## 2. 门抓出的两个真生产缺陷（第一轮就抓到——这正是这道门存在的意义）

1. **证据键未翻译**（`49e5b31`）：端口契约传裸证据键（`slotKey|value`），belief-store 行键是
   `belief:evidence:<fnv1aHex>`（写侧 = projections/belief.ts:119 同一函数）。适配层漏了翻译 ⇒
   累计行永远读不到 ⇒ 跨窗口阈值永不满足 ⇒ **生产路径 BELIEF_FORMED 永不触发**。
   内存单测的 map 恰好按裸键存取，所以 kernel 测试全绿——装配路径的缺陷只有装配门能抓。
2. **交互流证据查找锁窗**（`83d8701`）：`runBeliefInteractionWindow` 给 Validator 装的是
   "窗口内事件"查找（引用窗外 = 失败关闭）。但 FORMED 的根**按设计跨窗口**（累计语义 D06；
   生产里每个尾窗通常只有一两条事件）⇒ 跨窗 FORMED 全被 `source_event_missing` 拒；
   且窗口视图缺 `conversationId`/`actorId`，阈值复推也过不去。修复 = 与流 2 同一口径的账本查找
   （`ports.findConversationEvents`）；失败关闭语义不变（切换前/不合格根仍过不了资格四条）。
   WP4 单测的夹具把全部根放进单窗——两缺陷都穿过了它。

## 3. 既知边界（如实登记，不外推）

- **纯重试投影滞后**：apply 断点后重试若 accepted 为空（全撞键），折叠集为空，滞后保留；
  修复 = `rebuildBeliefProjections`（门 r4-04 证明该路径）。与 M8 affect 同先例。
- **序号空间空洞**：对话事件与领域事件共享 `character_sequence_counters`（M2.5 设计；
  M6.1 冻结单 §11 既知现象）。水位语义"账本 ≤N 都已处理"天然容忍空洞；门夹具绕过分配协议后
  需对齐计数器（`greatest(计数器, max)`，只前进）。
- **Memory 流追赶分页**：bulk 场景下一轮只吃一页（2000），追赶需循环到 no_tail——
  生产语义（余量留尾窗），不是缺陷；启动钩子每轮推进一页。
- **M8 affect 调度器同款页边界隐患未动**（无钳位、无边界门覆盖）——M9 计划 §728 只要求 M9 覆盖；
  M8 侧登记为其维护线事项。

## 4. 门与回归读数（全部 EXIT 0）

| 门 | 结果 | 说明 |
|---|---|---|
| `pnpm typecheck` | ✅ 0 | 每次改动后 |
| `pnpm kernel:test` / `kernel:verify` | ✅ 0 | job.ts 改动后（83d8701） |
| `pnpm m9:runtime:verify` | ✅ 28/28 | 提交树 `3217ec3`，runId `…-4af7` |
| `pnpm m9:verify` | ✅ 54/54 | job.ts 改动后复验（validator 未动；runId `m9-wp4-verify-…-87cd`，head `ab2ab8e`） |
| `pnpm m4:test` / `m4.5:test` | ✅ 0 | flags.ts/main.ts 开关消费锁 |
| `pnpm m4.5:ci` | ✅ EXIT 0 | 全量离线链（34 门），WP6 收口读数；6 项历史证据按白名单还原 |

## 5. 给 WP7 的输入

1. **上下文装配入口**：信念行的消费走 `listActiveBeliefs(db, cid)`（belief-store）；
   读侧遮蔽/资格判定用 WP5 的 `recheckBeliefDependencies` + `usableBeliefsOf`（含依赖失效遮蔽）。
2. **优先级与预算**：计划 §731 起——belief section 优先级 50、`ContextBudget` 字段、
   状态标签（active/disputed/superseded/retracted）、Memory 去重（同源记忆与信念不双计）。
3. **prompt 逐字节基线**：开关 off 时 prompt 组装必须逐字节不变（m3.5 基线锁会守）。
4. **trace**：`external_evidence` 先例——记"实际入模"集合，不记正文。
5. **B-INFERRED 独立子开关**在 WP8 装配时强制（本 WP 只做了总开关）。

## 6. 未做 / 不因本 WP 完成而自动发生

- 生产激活（M9-D26）：`.env` 未加 `CHARACTER_BELIEF_ENABLED`——**缺省 off，未激活**。
- 合并 / 打标签 / 真实库写入：均需用户单独授权。
- Memory bootstrap（M9-D12）：未动。
- M8 人审 **已 PASS**（2026-09-27 修订：用户声明式裁定"已审、无异议"，归档
  M8-Gate-Decision §4；原 PENDING 读数保留）。
