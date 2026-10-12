# M4 技术债清单

- **日期**：2026-09-17
- **被测 commit**：`3121cfc`（`m4-acceptance-rc1`）
- **依据**：附件《M4 验收计划书》§41 故障等级 / §44 CONDITIONAL PASS 条件
- **结论**：**无 S0 / S1 / S2**。以下全部为 **S3 / S4**。

> 记录格式按要求：Issue / Impact / Workaround / Owner / Target Stage。

---

## 概述

| 等级 | 数量 | 说明 |
|---|---|---|
| **S0 — Data Corruption** | **0** | |
| **S1 — Core Semantic Failure** | **1** | **D1：显式遗忘会撤销无关的正确记忆** —— ✅ **已在 M4.1 修复**（见下方「M4.1 状态」） |
| **S2 — Reliability Failure** | **0** | |
| **S3 — Non-core Defect** | **5** | 覆盖缺口与已知限制（含 **D3 = 后台抽取未接线**） |
| **S4 — Cosmetic** | **2** | 文案与体验 |

> **2026-09-17 更新（第二轮）**：验收结论为 PASS 之后，补做的
> **真实链路冒烟**（生产库副本上的真实多轮）发现 **S1 = D1**，
> 结论因此改为 **FAIL**。详见
> [`M4-Defect-D1-wrong-target-forget.md`](./M4-Defect-D1-wrong-target-forget.md)。
>
> **2026-09-17 更新（第一轮）**：S3-3（启动补折叠）已修复并验证，
> S3 由 5 → 4；随后 D3 又加回 1 条。

---

## M4.1 状态（2026-09-17）

| # | 项 | 状态 |
|---|---|---|
| **D1**（S1） | 显式遗忘撤销无关记忆 | ✅ **已修复并验证**：相关性闸 + `mayMutate`；`m4:mutation-safety` 20/20、`m4:nl-mutation` 17/17、`m4:smoke:live`（见 RC2 报告） |
| **D2-B** | 未执行却宣称成功 | ✅ **已修复**：`response-truth.ts` 确定性后置守卫；`m4:test` 7 条纯函数用例 |
| **D2-A** | 规则表覆盖面窄 | ⚠️ **本轮不设为默认**：`CHARACTER_MEMORY_LLM_EXTRACTOR_ENABLED`（默认 false）可开。按任务书 §19「Coverage 不完美可以接受，False Success 不可接受」，**未列入 Hard Gate** |
| **D3**（S3） | 后台抽取未接线 | ⚠️ **本轮只如实降级**（不接生产）：flags 标 `NOT-WIRED` + 启动告警 + 文档定性 + 回归锁。**含义：她目前只记得住被明确告知的事** |

> 详细改动与证据见 [`M4.1-Correctness-Fix-Report.md`](./M4.1-Correctness-Fix-Report.md)。

---

## ⚠️ D1 — S1｜显式遗忘会撤销**无关的**正确记忆（必修）

- **Issue**：`target-resolver.ts:340-342` 的第 3 步，只要该 subject 下只剩
  **一条** active，就直接返回 `resolved` —— **从不要求那一条与用户说的话相关**。
  于是"忘掉我养过一只鹦鹉这件事"会撤掉 `education.institution = 示例工程科技大学`。
- **Impact**：用户要求忘掉 A，系统静默撤销了无关的 B，并回复"抹了"。
  数据没丢（逻辑遗忘，可 restore），但一条**正确的用户授权事实**被错误失效。
- **Reproduction**：`docs/m4/M4-Defect-D1-wrong-target-forget.md` §2（确定性，
  在库副本上 4 条命令即可复现）。
- **Workaround**：无（用户侧无法察觉；只能靠 `memory:audit` 事后发现）。
- **Owner**：M4 维护者
- **Target Stage**：**立刻**（附件 §45 的 M4 Fix Cycle）

---

## D3 — S3｜后台抽取路径没有接入生产

- **Issue**：`src/` 里**没有任何文件 import `app/memory/job.ts`**；
  `CHARACTER_MEMORY_BACKGROUND_ENABLED` 只被 `flags.ts` 读进 flags 并打印，
  **没有消费者** —— 开关是惰性的。
- **Impact**：**她目前只记得住被明确告知的事**。"从日常对话里自动发现值得记的事"
  这条路径在生产里不存在，而 `docs/architecture/README.md` 与
  `memory-lifecycle.md` 画的是"两条写入路径"。
- **实测**：开关打开后跑 2 轮普通陈述（"我最近开始学 Rust 了"/"我平时住在西安"），
  记忆条数变化 **0** —— 而她的回复是"西安。住的那条，记了。"（用户可见的假成功）
- **Workaround**：无。
- **Owner**：M4 维护者
- **Target Stage**：需要裁定 —— 要么补接线，要么把开关标成"尚未接线"
  并从文档里去掉"两条路径"的说法

---

## D2 — 待定｜显式路径对规则表未覆盖的说法静默失败

- **Issue**：`tsx scripts/diag-m4-explicit.ts "记住，我平时主要用 VS Code"`
  → **卡在②内容抽取**（`content_unresolved`）。显式路径的缺省抽取器是
  **规则**抽取器（`main.ts:474` 注释说明 LLM 兜底"留到下一步"）。
- **Impact**：用户说"记住…"而库里没有；她的回复读起来像已经记下，用户无从分辨
  —— 这正是计划书 §55 要防的用户体验（与 `M4-verification.md` §5.6 同一类）。
- **两条路线**：补 `content-extractor.ts` 的槽位线索表（便宜可控）
  vs 接 `ChainedContentExtractor`（覆盖广、引入模型不确定性）。
  **属产品取舍，需裁定。**
- **Owner**：用户裁定 → M4 维护者
- **Target Stage**：M4 Fix Cycle

---

---

## S3-1｜迁移"中途失败 → 回滚"与"迁移后清空投影全量重放"没有单独用例

- **Issue**：附件 M4-T32 要求"迁移失败必须明确失败、不能执行一半假装成功"；
  M4-T31 要求"迁移后清空 Projection → Replay，最终状态一致"。
  两者目前**没有**独立用例。
- **Impact**：低。迁移 0005 **全部**是 `create table/index if not exists`，
  **不对既有表做任何 ALTER、不装载任何数据** ——
  因此计划书预览里警告的那条风险形态（M3 的 0003"新增非空列"）**不适用**。
  既有保证：`m3:migrate-gate` 17/17（拦 / 放行 / 错误信息形状 / 真实副本端到端）
  + `m4:verify` §7（reducer 版本守卫强制先 rebuild）。
- **Workaround**：升级前用 `pnpm migrate`（预览，逐条打印语句）人工确认；
  已有备份 `data/pglite.backup-m4-*` 且经 `m4:backup:verify` 验证可读。
- **Owner**：M4 维护者
- **Target Stage**：M5 之前（新增 0006 时一并补 T31/T32 用例）

---

## S3-2｜`MEMORY_MERGED` 接口完整但没有生产者

- **Issue**：`merge` 在 validator 与 reducer 里都通，但**没有任何组件构造 merge 提案**
  （`resolveConflict()` 的重复走 `REJECT_DUPLICATE`）。
- **Impact**：低（但**易被误读**）。§216 的 Lifecycle 要求含 MERGE；
  正确描述是"**接口就位、驱动缺失**"，不得读成"合并功能已验证"。
- **Workaround**：无（不去使用不存在的路径）。
- **Owner**：M4 维护者
- **Target Stage**：M5（语义去重第三层的语义判别器接上之后）

---

## ~~S3-3｜强制终止后没有"启动时自动补折叠"的清扫~~ ✅ **已收口（2026-09-17）**

- **Issue**：写入是两步 —— `appendDomainEvent`（一个事务）+
  `applyMemoryEvent`（另一个事务），因此存在"**领域事件已提交、投影尚未折叠**"
  的窗口。`m4:hardkill:verify` 用真实 `taskkill /F` **实测复现过**这个窗口。
  该事件**可以**被重新折叠，但当时**没有**组件在启动时自动做。
- **影响**：事实没有丢（真源在账本），丢的是**派生视图** ——
  即"她暂时想不起来"，且不会自愈。
- **修复**：见下方「已收口」。
- **Owner**：M4 维护者
- **Target Stage**：~~M4.5 之前~~ → **已完成**

---

## 已收口（2026-09-17，用户裁定"修 1 与 3"）

### 1. §204 的七篇文档已按名补齐

`docs/architecture/` 下现在有 `memory-model.md`、`memory-lifecycle.md`、
`memory-authority.md`、`memory-provenance.md`、`memory-temporal-semantics.md`、
`explicit-memory-operations.md`、`memory-backend-contract.md`。
每篇指向对应 ADR / 不变量 / **守着它的测试**。
入口见 [`../architecture/README.md`](../architecture/README.md)。

### 3. 启动补折叠（S3-3）已实现且有机器证据

| 项 | 内容 |
|---|---|
| 模块 | `src/infrastructure/persistence/memory-recovery.ts` |
| 函数 | `unfoldedMemoryEvents(db)`（探针）/ `recoverMemoryProjections(db)`（修复） |
| 接入 | `src/main.ts`：**进入对话之前**调用，在 `!dryRun` 守卫里 |
| 幂等 | 折叠前用**纯 reducer** 预览；`changed === false` 时**只补登记索引、不改投影**（否则会出现"状态没变但 revision +1"） |
| 顺序 | 按 `sequence` 升序 —— 与 Replay 同一个顺序契约 |
| 失败语义 | 收集而非抛出：一条坏事件不该让她整个起不来；失败项下次启动还会被扫到 |

**只读承诺未被侵蚀**（这点比原缺口更关键）：补折叠**只**在真的进入对话之前跑 ——
只读命令（`memory:*` / `--kernel-status` / `--seed-status` / `--inspect` /
`--dump-prompt`）在各自的分支里已经 `return`。
`--dry-run` / `--test` **不做**（那两个模式的承诺是"不写库"）。

**验证**：

| 证据 | 结果 |
|---|---|
| `m4:hardkill` §3d：确定性注入一条"只提交不折叠"的事件 → 生产恢复函数补上 | **20 / 20** |
| 同上：真实强杀留下的孤儿（本次 1 条）也被同一次扫描补上 | 扫描 2 → 补折叠 2 / 失败 0 |
| 负控：再扫一次是 0 条（幂等，不会永远报缺口） | ✅ |
| 负控：注入的事件在补折叠**之前确实没有投影**（否则测试空转） | ✅ |
| `m4:test`「生产装配接线（回归锁）」：断言调用存在、在 `!dryRun` 里、且在**全部只读分支之后** | ✅ 228 / 228 |
| 该锁**被验证过能失败**：临时移除调用 → 立刻红 | ✅（`227 通过 / 1 失败`） |


---

## S3-4｜Scenario A–E 未串成真实多轮对话在真库上跑

- **Issue**：附件§33 的五个黑盒剧情（一周式偏好变化、错误与修正、
  假设陷阱、污染陷阱、forget）目前只有**机制级**覆盖。
- **Impact**：低。机制已覆盖：`eval:m4` 场景套件 17/17、
  `M4X-050/051`（假设 / 虚构）、`m4:restore:verify` §7（create/correct/forget 链）、
  Promptfoo `contamination` 配置。
- **Workaround**：需要端到端确认时手工跑一段对话。
- **Owner**：M6 / G1 负责人
- **Target Stage**：M6–G1（附件 §52 明确把"完整人工盲审"留给那一阶段）

---

## S3-5｜`dedup` / `temporal` 两个评测套件没有用例

- **Issue**：两个套件在 `ExtractionEvalSuite` 类型里预留，用例表里为空。
- **Impact**：低。对应能力由其它门覆盖：
  dedup → `m4:scale`（140 次重复投递 / 80 次被拦）+ `m4:verify` §4/§16；
  temporal → `m4:test`「时间语义」「时间线」+ `m4:verify` §5。
- **Workaround**：无（生成器会**显式打印**这两个未覆盖套件名，不静默）。
- **Owner**：M4 维护者
- **Target Stage**：M5

---

## S4-1｜`memory:audit` 把 `retracted` 一律渲染成"用户要求忘掉"

- **Issue**：真实库中那条因**缺陷修复**被撤回的记录（`preference-d0696bd4b1e314c1`）
  在审计清单里显示为"**已撤回**（用户要求忘掉；历史保留）"。
- **Impact**：极低（判定正确，文案不准确）。会让审计者误以为存在一次用户 forget 请求。
- **Workaround**：看 `memory:history` / `memory:sources` 确认真实触发事件。
- **Owner**：M4 维护者
- **Target Stage**：M5（建议按 `retract` 的 `reason` 字段分别渲染）

---

## S4-2｜`hydrate` 的 N+1 查询

- **Issue**：`list(limit=50)` 约 150 次查询（每条记录 1 次 subject + 1 次 evidence + 1 次 supersedes）。
- **Impact**：极低。功能正确；在本次 `m4:scale`（790 条记忆）下未造成可见问题。
- **Workaround**：无。
- **Owner**：M4 维护者
- **Target Stage**：M5（召回规模上来之后）

---

## 附：本次验收**主动登记**的两条观察（**不是**缺陷）

| 观察 | 为什么不是缺陷 |
|---|---|
| canonical 槽位上**没有** DB 级"同槽位一条 ACTIVE"唯一约束 | 该保证**刻意**放在后台冲突分析器里（`m4:verify` §16 用真实分析器覆盖）。**含义**：任何绕过流水线的新写入路径必须自己跑冲突分析 —— 这正是 §216"不得绕过既有 Memory Policy"的落点，已写进覆盖矩阵 D8 |
| 真实库只有 2 条记忆，达不到 §217 的"数十条" | 已按 `docs/m4/current-state.md` 的裁定分区处理（沙箱 35 条 + 真实库 2 条穷举），**不混用、不冒充**。属规模事实 |
