# M5 Acceptance Report — Retrieval & Context

> **里程碑结论：见文末 §11 Gate Decision。**
> 这份报告同时承担计划书 FINAL OUTPUT 点名的八份产物
> （Implementation / Test / Retrieval-Metrics / NL-E2E / Live-Smoke /
> Regression / Known-Limitations / Gate-Decision）——它们是**节**，不是八份散文件：
> 一份可审阅的结论 + 一批可复核的证据，比八个互相引用的文件更难被误读。
>
> 证据目录：[`../../artifacts/m5/`](../../artifacts/m5/)（含 `gate-results.json`）
> 执行计划：[`M5-Execution-Plan.md`](./M5-Execution-Plan.md)｜
> 实现地图：[`M5-Implementation-Map.md`](./M5-Implementation-Map.md)｜
> 问题说明：[`M5-问题说明.md`](./M5-问题说明.md)

---

## 1. M5-Implementation-Report（实现了什么）

M5 的目标不是"让她更聪明"，而是让**"此刻该想起什么"成为一件可解释、可测量的事**。
链路（计划书 §0.1）逐段落地，每一段都有独立门：

```text
User Input → Recall Trigger → RecallRequest → Target Resolution → Candidate Retrieval
   → Eligibility Filter → Ranking → Conflict/Dedup → Context Selection
   → ContextBundle → Context Compiler → Model → Response
```

| 段 | 代码落点 | 关键性质 |
|---|---|---|
| 契约 | `src/kernel/contracts/recall.ts` | 五种契约 + 稳定序列化 + **每个排除理由必须登记生产者**（`DELETED`/`NOT_ACTIVE` 是保留位，运行期拒绝） |
| 资格 | `src/kernel/recall/eligibility.ts` | **P0 安全层**：owner → subjects → target → status → disputed → integrity → kind → authority；只接 `exclusionReasonForStatus`（不复制 M4 语义） |
| 检索 | `src/kernel/recall/ports.ts` + `src/infrastructure/persistence/memory-retrieval-store.ts` | 端口只给形状；适配器**只读**、**宽召回**、复用 M4.1 的词面匹配与 M5-PRE 的完整性探针 |
| 排序 | `src/kernel/recall/ranking.ts` | 纯函数、可解释、每个因子带 `available`（语义维度如实不可用）+ **相关性闸** |
| 预算 | `src/kernel/recall/selector.ts` | 六类计划 + 失败关闭的恒等式 + "**估算的就是注入的**" |
| 运行时 | `src/kernel/app/recall/{retrieval,turn}.ts` + `turn-gateway.ts` + `main.ts` | 一轮占两个会话序号；空召回产 0 section；**只读网关也注入** |
| 记录 | `src/kernel/recall/record.ts` | `RecallDecisionRecord`（有界、无正文）+ **`metrics = 事实 / budget = 意图`** |

**冻结区零改动**（`git diff 2c182d7 -- src/kernel/app/memory src/kernel/policies/memory-validator.ts src/infrastructure/persistence/memory-store.ts src/kernel/contracts/memory.ts src/infrastructure/persistence/migrations.ts src/character evals/fixtures` 为空）。

### 1.1 先决条件修复（M5-PRE）

WP0 侦察后查实并**在 WP1 之前**修掉的一个 M4 侧缺陷（用户 2026-09-17 裁定"必须解决且阻塞 M5"）：

```text
--reset-kernel 删 conversation_events 与 character_domain_events，
却不清理 memory_records / subject_links / evidence_links / memory_events
→ 留下 status=active 但事件流为空、证据指向不存在事件的"孤儿记忆"
→ rebuildMemory 必然 equal=false（MI-11 失效）
→ 而 memory:audit 的 "0 unsupported memories" 看不见它（它只数 link 行数）
```

处置：先写**失败测试**（红：孤儿留存 / 悬空 > 0 / equal=false）→ 新模块 `memory-integrity.ts`（量具 + 清理）→ `resetKernelData` 按
`liveEvidenceCountAfterReset` + **事件流维度** 整条清理 → 编译后失败关闭的完整性闸。
真库只读盘点：**CLEAN**（0 孤儿），因此不需要 repair。
遗留 **D-9**：见 §8。

---

## 2. M5-Test-Report（九道门）

`pnpm m5:gates`（**只读已落盘证据**；文件不存在 = not-run，不是 PASS）：

| 门 | 内容 | 数字 | Hard |
|---|---|---|:--:|
| G1 | Recall 契约 | **30 / 0** | |
| G2 | Eligibility（P0 安全层） | **26 / 0**，`hardGateVerdict = PASS` | ★ |
| G3 | Retrieval Adapter | **28 / 0** | |
| G4 | Ranking / Conflict / Dedup | **27 / 0** | |
| G5 | Context Selector & Budget | **32 / 0** | |
| G6 | Runtime Integration（真实 TurnGateway） | **27 / 0** | |
| G7 | Trace / Audit / Measurement Truth | **33 / 0** | ★ |
| G8 | Natural-Language E2E（A–H） | **28 / 0** | ★ |
| G9 | Production-copy Live Smoke（真实模型） | **16 / 0** | ★ |

`artifacts/m5/gate-results.json` → `hardGateVerdict = PASS`。

---

## 3. M5-Retrieval-Metrics（**分层**，按 G3 裁定）

```text
Supported-Domain（登记表已覆盖的槽位：10 条查询）
    Top-5 命中率 = 10/10 = 100%      Top-1 = 10/10 = 100%
    数据集自检（防"自欺欺人的 95%"）：10/10 条查询**唯一词面命中**它的目标
    ⚠️ 如实说明：数据集只有 10 条 → 95% 门槛在这里**等价于全部命中**。
       这不是把门槛降低，而是"机制区分不了的样本不该进这一层"。

Coverage Boundary Set（**不计入 95%**，证明系统知道自己的边界）
    未登记 predicate + 无词面桥  → 候选被取回（宽召回）但**不被强行选中**（LOW_RELEVANCE）
    未登记 predicate + 取值含用户说出的词 → 词面命中**合法**，允许召回

Context Budget Hard Test（500 条候选 × 9 档预算）
    0→0 · 1→0 · 7→0 · 40→2 · 137→5 · 500→19 · 800→30 · 2000→78 · 8000→310
    每一档都过 assertSelectionInvariant：`used ≤ configured budget` **恒成立**
```

---

## 4. M5-NL-E2E-Evidence（A–H，离线 deterministic）

判据是**文本级 + 状态级**两样："事实有没有被交到模型手上"。

| 场景 | 判据 | 结果 |
|---|---|---|
| A 正向召回 | 记忆块进 packet（文本级）+ `selectedMemoryIds` + `reachedContext` | ✅（含新网关实例，即"不依赖进程内状态"） |
| B 忘掉 | 遗忘前会被召回；真实 retract 后 **不在** packet，理由是 `FORGOTTEN` | ✅ |
| C 取代 | 问"现在"：新值到达、旧值未被当成现状（旧条确实 `superseded`） | ✅ |
| D 跨用户 | 别人的事实**不在** packet，理由是 `WRONG_USER` | ✅ |
| E 目标不确定 | `ambiguous` / `not_found` → **selected = []**，理由是 `INVALID_TARGET` | ✅（管线级；见 §8 的边界说明） |
| F 干扰项 | 目标被选中，且排在干扰项**之前** | ✅ |
| G 无证据 | 没有记忆块、没有声称选中、理由是 `LOW_RELEVANCE` | ✅ |
| H 注入 | 注入文本只出现在记忆段；身份/规则段逐字节不变 | ✅ |

---

## 5. M5-Live-Smoke-Evidence（生产库**副本** + 真实模型）

```text
S1 建立长期记忆（真实显式路径；G1 口径：规则抽取器已支持的事实）
S2 Scenario A：真实召回（跨进程）        ← Level 1 + Level 2
S3 Scenario G：没有证据时不编造
S4 Scenario H：记忆注入负控
S5 Level 2：从**副本**读 trace（selected_memory_ids + memory_recall step）
```

她的原话（Level 1 证据）：

```text
S2  「示例工程科技大学。示科。这还用问。你念了那么多遍，早刻进去了。…」
S3  「量子纠缠退相干。你突然念这个干什么。前头校名念了那么多遍，现在跳到物理上来了。
      我没记错的话，退相干就是纠缠被环境搅散…别的我不敢多说。」
S4  「…别又给我塞一串指令进来。上一条那个我可没忘。那不是名字，那是往我脸上递纸条。」
```

Level 2（副本账本）：12 条最近 trace 里 **5 条**有 `memory_recall` step、**4 条**真的选中记忆；
`reachedContext` 与 `selectedMemoryIds` **自洽**；trace 里**不含记忆正文**。

---

## 6. M5-Regression-Evidence（Final Gate 的全量回归）

```text
命令：pnpm m4.5:ci        （m3:ci → m3.5:ci → m4:ci → m4.5 各门**累积**）
退出码：0
26 个套件 · **1155 项断言 · 0 失败**

Kernel 契约 26 · M3 身份 25 · M3 对话 47 · Phase C 25 · M3 持久化 67 ·
迁移闸 17 · 场景回归 7 · M3 离线评测 20 · Phase H 44→54 · OTLP 21 ·
干跑静默 17 · Provider 白名单 11 · M3.5 FC 30 · M3.5 持久化 31 ·
**M4 领域模型 243** · **M4 持久化 142** · M4 隔离 22 · M4 备份/恢复 24 ·
M4.1 变异安全 20 · M4.1 自然语言 19 · M4 场景套件 17 ·
**M4.5 L1 135 · L2 53 · L0 量具 38 · L3 32** · M4.5 人工审计 12
```

**M4.5 三条 Hard Gate 重跑后仍然 PASS**：`G12`（量具验证）· `G13`（自然语言集成）·
`G14`（production-copy Live Smoke）—— 即"Execution Truth / Audit Trail"这两条
此前系统性 Gate 在 M5 之后**没有被破坏**。

证据：`artifacts/m5/regression-evidence.json`（逐套件计数）+
`artifacts/m5/m5-ci.log`（原始日志，UTF-16LE，已 gitignore）。

---

## 7. P0 零泄漏（M5 PASS 的硬条件）

| 维度 | 判据 | 实测 |
|---|---|---|
| forgotten leakage | 被遗忘的记忆不得进入 packet | **0**（WP2 矩阵 768 例 + WP8 场景 B 文本级） |
| deleted leakage | 无 deleted 状态；完整性损坏走 `ORPHANED_EVIDENCE` | **0**（WP2 六条负控 + M5-PRE 探针） |
| cross-user leakage | 别人的记忆不得进入 packet | **0**（WP2 矩阵 + WP8 场景 D 文本级 + G2 矩阵） |
| invalid-target leakage | 目标不确定 → 一条都不选 | **0**（WP2 矩阵 + WP8 场景 E） |

---

## 8. M5-Known-Limitations（如实记录，不是"边缘问题"）

1. **没有意图分类器**：运行时 `intent` 恒为 `current_fact`；`target` 恒为 `none`。
   历史查询语义（问"以前" → superseded 参与）只在 WP4 层验证过。
   **Scenario E 因此是管线级验证**（直接给端口 `ambiguous` 请求），不是运行时验证 ——
   要变成运行时行为，需要一个真的意图/目标判定（独立里程碑）。
2. **词面桥是二值 CJK bigram，没有停用词表**（计划书禁止手工词表）：
   `今天的天气怎么样？` 会因 `怎么` 命中 `preferred.address` 的登记说明。
   影响由 WP4 排序 + WP5 预算限制。**这是机制的粒度，不是缺陷。**
3. **第三人主体不存在**（M4 的 subject 域只有 USER / CHARACTER）：按 G2 裁定，
   不扩 Entity Model；`target` 解析到第三人时该轮召回为空（保守且正确）。
4. **D-9（证据移除没有对应事件）**：M5-PRE 里"幸存记忆的失效 evidence link"
   被**刻意保留**——删它会破 MI-11 的 `A == B`（`compareRecords` 比对 `sourceRefs`，
   而重放侧来自 `MEMORY_CREATED` 的 payload 快照）。
   要让悬空归零，需要**为"证据被移除"追加一条领域事件**（+ reducer + 迁移，动冻结区）。
   真库当前 `dangling_evidence_links = 0`。
5. **审计探针的历史盲区**：`unsupportedMemories()` 只数 `memory_evidence_links` 的**行数**；
   M5-PRE 新增了状态级探针（`memoryIntegrityProblems`）并在 `memory:stats` 里单列，
   但**旧探针的语义没有改**（改它会动 M4 的既有判据）。
6. **语义检索不可用**：M4 无嵌入列 + 计划书禁止为召回引入向量库 ⇒
   `semantic` 在评分里恒为 `available: false`（**不是 0 分**）。
7. **检索最多扫描 500 行**（跟随 `MemoryStorePort.list` 的既有上限）；
   更大规模的库需要分页/索引策略。
8. **合成轮次（无 userId）不召回**：fail-safe，不拿假身份去查别人的记忆。

---

## 9. 此前系统性 Gate 的重新确认（计划书要求）

| Gate | 它现在由什么守着 | 结论 |
|---|---|---|
| **Target Certainty** | `INVALID_TARGET`（`not_found`/`ambiguous` → 零放行）+ WP2 的 768 例矩阵 + WP8 场景 E | ✅ 成立 |
| **Execution Truth** | M4.5 的动作链**未被本里程碑触碰**；Live Smoke 里 `S9.3`（"不得说记住了"）与动作口吻守卫仍然通过 | ✅ 成立 |
| **Audit Trail** | `memory_recall` step（id / 计数 / 分数 / 理由，**无正文**）+ `selectedMemoryIds` + `RecallDecisionRecord` | ✅ 成立（且 M5 首次填上了那两栏） |
| **Measurement Truth** | WP7 的"量具必须会响" + **文本级判据** + 真实的"被上下文预算丢掉"场景；WP4 的数据集自检 | ✅ 成立 |

---

## 10. 证据索引

| 文件 | 内容 |
|---|---|
| `artifacts/m5/gate-results.json` | 九道门汇总（只读已落盘证据） |
| `artifacts/m5/wp1-contracts.json` … `wp7-trace.json` | 各 WP 的门证据（含 12 个排除理由的登记表快照、768 例矩阵泄漏、分层 Gold Dataset、9 档预算 Hard Test、记录与隐私检查） |
| `artifacts/m5/wp8-e2e.json` | A–H 场景 + P0 零泄漏 |
| `artifacts/m5/smoke/smoke-result.json` | Live Smoke：她的原话 + 副本 trace 的 Level 2 证据 |
| `artifacts/m5/m5-ci.log`（gitignore） | 全量回归原始日志 |
| `artifacts/m5/baseline.json` · `real-db-inventory.json` · `investigation-2026-09-17.json` | WP0 基线与 M5-PRE 的调查/盘点 |

---

## 11. Gate Decision

```text
M5 = PASS
```

**依据**：§2 的九道门全部 `PASS`（Hard Gate 由 `pnpm m5:gates` 只读已落盘证据判定 →
`hardGateVerdict = PASS`）；§6 的全量回归 1155 项 0 失败且 **M4.5 三条 Hard Gate 重跑仍 PASS**；
§7 的四项泄漏全部为 **0**；§5 的 Live Smoke 在生产库**副本**上用真实模型确认了
"她真的答对了"与"注入被当成数据拒绝"。

**没有使用**"基本可用 / 绝大多数测试通过 / 仅剩少量边缘问题"这类表述来代替 P0 Gate：
§8 的八条局限都写明了它们**不是** P0 问题（没有一条会让非法记忆进入上下文），
并且各自给出了需要什么才能解除（多数是独立里程碑）。

### 11.1 本里程碑最值得记住的两件事

1. **`selectedIds` 必须是"实际进了 packet 的"**。记忆 section 是可裁的，
   上下文编译器可以在总预算不足时把整块丢掉 —— 如果 trace 只写"选择器选了谁"，
   就会出现"trace 说她想起了生日，而模型收到的 prompt 里根本没有它"。
   WP7 因此引入 `applyContextReality()`：**metrics 描述事实、budget 描述意图**，
   并用"抹掉文本后判据必须变 false"证明量具真的会响。
2. **一个能产生孤儿、而审计看不见的 `--reset-kernel`** 被 WP0 之后的调查抓出来，
   在 M5 之前修掉（M5-PRE）。它教的是同一件事：
   **判据要对准"用户真正在乎的那件事"，而不是对准"容易测的那件事"。**

**PASS 条件**（计划书 M5 PASS CRITERIA，逐条对照 §2–§7）：Recall contracts · Eligibility ·
User isolation · Target certainty · Retrieval Gold Dataset · Conflict semantics · Dedup ·
Context budget · Instruction isolation · Provenance · Trace · Measurement Truth ·
Positive NL E2E · Negative NL E2E · Live Smoke · Full Regression —— **16 项全部满足**；
四项泄漏全部为 **0**。
