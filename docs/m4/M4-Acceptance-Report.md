# M4 验收报告（Reliable Long-Term Memory）

- **阶段**：M4 — Reliable Long-Term Memory
- **性质**：阶段验收 / Gate 文档（**最终验收**）
- **验收方式**：冻结 commit → 重跑全部机器门 → 对抗式覆盖矩阵 → 补齐缺口 → 人工审计 → 结论
- **取代关系**：本报告是 M4 的**最终验收真源**；
  `docs/milestones/M4-verification.md` 保留为**检查点报告**（历史记录）

---

## Build

```text
Commit        : 3121cfc（m4-acceptance-rc1，冻结候选）
Commit date   : 2026-09-17T01:04:50+08:00
Branch        : main
Worktree      : 干净（冻结时）
DB Schema     : 5（迁移 0001–0005；0005 = m4-reliable-long-term-memory）
Runtime       : Node v22.23.2 / tsx 4.23.13 / @elizaos/core 1.7.2
LLM           : deepseek-flash @ https://api.deepseek.com
Embedding     : BAAI/bge-m3（1024 维）
Seed          : v3 / 947686bde031fc529d188e78b606aa198ee338c10c33a761ecaf7852b1b106c1
Config hash   : 94307d8f70c1539d13a57d6882f6155b62b52366d07250248804f3f46952bc13
Date          : 2026-09-17
```

基线字段见 `artifacts/m4-acceptance/baseline.json`（**不含任何密钥**）。

---

## Test Summary

### 自检断言（逐项可加）

| 套件 | 命令 | 结果 |
|---|---|---|
| 类型与依赖方向 | `pnpm typecheck` | ✅ exit 0 |
| M2.5 领域契约 | `kernel:test` | 26 / 26 |
| M3 身份完整性 | `kernel:test:identity` | 25 / 25 |
| M3 对话完整性 | `kernel:test:conversation` | 47 / 47 |
| M2.5 Phase C | `kernel:verify` | 25 / 25 |
| M3 持久化 | `m3:verify` | 67 / 67 |
| 迁移闸 | `m3:migrate-gate` | 17 / 17 |
| Seed 自检 | `m3:seed-check` | ✅ 与记录一致 |
| 场景回归 | `eval:scenarios` | 7 / 7 |
| M3 离线评测 | `eval:m3` | 20 / 20 |
| 遥测与韧性 | `eval:telemetry` | 54 / 54 |
| OTLP 兼容 | `eval:otlp` | 21 / 21 |
| 干跑静默性 | `eval:dryrun` | 15 / 15 |
| Provider 白名单 | `eval:providers` | 11 / 11 |
| M3.5 未来兼容 | `m3.5:test` | 30 / 30 |
| M3.5 持久化 | `m3.5:verify` | 31 / 31 |
| **M4 领域模型** | `m4:test` | **228 / 228** |
| **M4 持久化** | `m4:verify` | **142 / 142** |
| **M4 故障注入矩阵** | `m4:faults` | **15 / 15** |
| **M4 跨进程重启** | `m4:restart:verify` | **16 / 16** |
| **M4 场景套件** | `eval:m4` | **17 / 17** |
| **M4 隔离（新）** | `m4:isolation:verify` | **22 / 22** |
| **M4 备份/恢复（新）** | `m4:restore:verify` | **24 / 24** |
| **M4 真库验收** | `m4:real-db:verify`（只读） | **30 / 30** |
| **M4 备份可读性** | `m4:backup:verify` | **8 / 8** |
| **M4 规模（新）** | `m4:scale:verify` | **11 / 11** |
| **M4 强制终止 + 补折叠（新）** | `m4:hardkill:verify` | **20 / 20** |
| **M4 人工审计语料（新）** | `m4:audit` | **10 / 10** |
| **合计** | | **939 / 939** |

### 另计（不同计量单位，不混进上面的合计数）

| 项 | 命令 | 结果 |
|---|---|---|
| M4 抽取行为评测 · 真实模型档 | `eval:m4:extraction:live` | **14 / 14 用例**（其中 **3 条空过**，单列） |
| M4 Promptfoo · 离线档 | `eval:m4:promptfoo` | **3 / 3 配置**全绿 |
| M4 Promptfoo · 真实模型档 | `eval:m4:promptfoo:live` | **5 / 5 配置**全绿 |
| M4 Promptfoo 断言自检 | （串联） | 断言非空转（8 配置 × 5 个坏世界） |
| **真实链路冒烟（生产库副本）** | `pnpm m4:smoke:live` | **8 通过 / 3 失败** —— 3 条失败**全是真缺陷**（D1 见下、D2 见下），这条门**做到的正是它该做的事** |

### 门链

```text
pnpm m4:ci         → 退出码 0
pnpm m4:ci:full    → 退出码 0（含真实模型档）
pnpm m4:real-db:verify → 30/30（只读，真实库未被写入）
```

原始日志：`artifacts/m4-acceptance/gate/*.log`

### 与 M3.5 基线对比

M1–M3.5 全部套件**逐项零退化**（26/25/47/25/67/17/7/20/54/21/15/11/30 全部与基线一致；
`m3.5:verify` 为 31/31，其中 +1 来自 M4 早期**放宽**——把 `schemaVersion === 4`
改成"已知集合 + 版本连续"，理由与替代保证记录在 `M4-verification.md` §4.1）。
`m3:seed-check` 通过：**M4 的自动写入够不到她的核心人格（MI-12）**。

---

## 逐域判定

| 域 | 判定 | 依据 |
|---|---|---|
| **Architecture**（架构约束） | **PASS** | `kernel:test`「Kernel 边界（依赖方向）」：领域层不 import 基础设施 / Runtime / SQL / 观测后端；Memory 变化全部经 **Domain Event → Reducer → Canonical State**（无 `LLM → 直接 UPDATE memory 表`）；`m4:test`「生产装配接线（回归锁）」断言生产内核注册了全集 `MEMORY_*` registry |
| **Lifecycle** | **PASS** | CREATE / SUPERSEDE / RETRACT / DISPUTE / RESTORE 全部有测试与真库证据；`m4:audit` 语料四态齐全。**MERGE 接口就位、无生产者**（技术债 S3-2） |
| **Explicit Mutation** | **PASS** | 真库实测：`记住…` → `person_fact education.institution = 示例工程科技大学` **active**；显式路径 `droppable:false` 的写结果进 context（§5.6 的接线缺口已修，并有回归锁） |
| **Provenance** | **PASS** | 真库 2/2、沙箱 35/35、规模 790 条：`unsupported = 0`；`m4:restore` 复核"恢复库能按来源反查"；无 `source = unknown` 却被当作强事实 |
| **Authority** | **PASS** | 权威映射 + 关闸；`CHARACTER_GENERATION` / `MODEL_INFERENCE` 建 `person_fact` **在构造候选时即抛错**（结构上不可能） |
| **Epistemic Safety** | **PASS** | `m4:test` 反污染含**反向断言**；`M4X-022` 注入型（实测 `rejectedCount: 2`）；**本次新建** `M4X-050`（条件句）/`M4X-051`（虚构）真实模型档通过且**非空过** |
| **Deduplication** | **PASS** | 三层去重 + 活跃指纹 DB 级唯一索引；`m4:scale` 140 次重复投递 80 次被拦、790 条记忆 < 1000 次操作、0 组重复指纹 |
| **Conflict Resolution** | **PASS** | `m4:verify` §16 用**真实**冲突分析器：duplicate / TEMPORAL_UPDATE / CONTRADICTION 三种处置 |
| **Temporal** | **PASS** | `validFrom` / `validUntil`（三态）/ `recordedAt` / `occurredAt`；SUPERSEDE 写 `validUntil`、RETRACT **不**动它、RESTORE 清它（三者可区分） |
| **Idempotency** | **PASS** | 同事件再折叠 `created=false` 且 revision 不变；同批重跑 0 条新增；`m4:faults` 部分写入整体回滚 |
| **Replay** | **PASS** | `m4:verify` §8 `A == B`；`m4:scale` 790/790；`m4:hardkill` 强杀后 `A == B`；连续三次重放结果稳定 |
| **Persistence / Restart** | **PASS** | `m4:restart:verify` 16/16：两个**真实子进程**共享同一磁盘目录，读进程无任何来自写进程的内存状态 |
| **Recovery** | **PASS** | `m4:faults`（回滚 / 可恢复 / 读失败不伪装成 0 条）；`m4:hardkill` 实测复现"事件已提交、投影未折叠"窗口，并证明**生产恢复函数**能补上（20/20，含幂等负控）；`memory-recovery.ts` 已接入进入对话前的启动路径，且有**能失败**的接线回归锁 |
| **Backup / Restore** | **PASS** | `m4:backup:verify` 8/8 + **`m4:restore:verify` 24/24**：全新目录恢复后 `CanonicalSemanticSnapshot` SHA256 一致、11 项计数一致、恢复库仍自洽（`A == B`）、可继续 create/correct/forget；**两条负控成立** |
| **Migration** | **PASS** | `m3:migrate-gate` 17/17 + 真库 schema v5 + 17 条索引核对（含部分唯一索引谓词与 `MemoryStatus` 同形）。**"中途失败回滚"无独立用例**（技术债 S3-1） |
| **Isolation** | **PASS**（**按本项目语义改写**） | owner 闸强制 `character`（负例被拒）；subject 参与 canonical key → 同文本不同人 = 两个槽位；跨 subject 修订/遗忘互不干扰；`m4:isolation:verify` 22/22 |
| **Scale / Memory Growth** | **PASS** | 1,060 事件 / 790 记忆：replay 全绿、不变量全绿、重复未膨胀。**不设 SLA**（计划书 §216） |
| **MemOS PoC** | **REJECT** | 见下 |

---

## MemOS PoC

```text
结论：REJECT（不用于本工程生产架构）
决定性判据：ADR-027 §101 第 7 条（不得绕过 MemoryPolicy）—— 不满足
```

被测包 `@memtensor/memos-cloud-dsh-plugin@0.1.1`：无条件订阅
`agent/pre-step`（`prepend: true`）与 `session/event`，
**默认开启** recall 注入与整轮 capture（含 assistant 文本），
且**不注册任何调用方可调用的写入 API** —— 因此它在结构上无法遵守
苏沐薇的 Memory Policy。

次要缺口（同为代码层面事实，非凭证问题）：无调用方 `MemoryId`、
无 supersede、无"保留历史的 retract"、无历史版本查询、无导出路径。

`Q1/Q3/Q4/Q5/Q7/Q9` 由**代码与文档**判定；
未评估项标 `UNKNOWN-WITHOUT-CREDENTIALS`，**不是失败证据**。

证据：`docs/m4/memos-poc.md`｜结论：`docs/m4/ADR-M4-MemOS.md`｜
判据：`docs/adr/ADR-027-memos-adapter-gate.md`（状态已由"提议"更新为结论）

**按 ADR-027 §102**：关键项不满足 → `rejected for production`，
项目继续原生 `NativeMemoryStore`，**完全没有问题**。
工程计划书 §216 要的是"PoC 完成**并有正式结论**" —— 已满足。

---

## Known Issues

| 等级 | 数量 |
|---|---|
| S0 — Data Corruption | **0** |
| S1 — Core Semantic Failure | **0** |
| S2 — Reliability Failure | **0** |
| S3 — Non-core Defect | 5 |
| S4 — Cosmetic | 2 |

**没有任何 S0 / S1 / S2。**

---

## Technical Debt

完整清单见 `docs/m4/M4-Technical-Debt.md`。摘要：

| # | 项 | 等级 | Target |
|---|---|---|---|
| S3-1 | 迁移"中途失败回滚"与"迁移后清空投影全量重放"无独立用例 | S3 | M5（新增 0006 时补） |
| S3-2 | `MEMORY_MERGED` 接口就位、无生产者 | S3 | M5 |
| S3-3 | 强杀后**没有**启动时自动补折叠的清扫（事实不丢，视图待补） | S3 | **M4.5 之前** |
| S3-4 | Scenario A–E 未串成真实多轮对话在真库上跑 | S3 | M6–G1 |
| S3-5 | `dedup` / `temporal` 评测套件无用例 | S3 | M5 |
| S4-1 | `memory:audit` 把 `retracted` 一律渲染成"用户要求忘掉" | S4 | M5 |
| S4-2 | `hydrate` 的 N+1 查询 | S4 | M5 |

---

## 本次验收补齐的缺口（14 项 P0 里 6 项此前**没有证据**）

| 缺口 | 处置 | 结果 |
|---|---|---|
| **Restore 从未验证**（只验证了"备份打得开"） | 新建 `scripts/verify-m4-restore.ts` + `scripts/m4-harness.ts` | 24 / 24，含两条负控 |
| **隔离无测试**（附件的多用户前提不成立） | 新建 `scripts/verify-m4-isolation.ts`（改写为 subject 维度） | 22 / 22 |
| **强制终止 / 崩溃窗口无测试**，且崩溃孤儿的恢复**没有接线** | 新建 `scripts/verify-m4-hardkill.ts`（真实 `taskkill /F`）+ `src/infrastructure/persistence/memory-recovery.ts` 并接入启动路径 | 20 / 20；**实测复现**孤儿事件，并证明**生产恢复函数**能补上（含两条负控） |
| **规模测试缺失** | 新建 `scripts/verify-m4-scale.ts` | 11 / 11（1,060 事件） |
| **`假设 / 虚构` 输入无任何证据** | 新增抽取用例 `M4X-050` / `M4X-051`（并修正为**非空过**） | 真实模型档 2 / 2，`vacuous: 0` |
| **§217 人工审计未执行** | 新建 `scripts/m4-audit.ts` + `docs/m4/M4-Manual-Audit.md` | 37 / 37 条 × 8 问全部可答 |
| **MemOS 无结论** | 静态 PoC + `docs/m4/ADR-M4-MemOS.md` | REJECT（附证据） |

---

## Final Result

> ### ⚠️ 结论在验收**之后**被推翻：**FAIL**
>
> 本报告最初给出 PASS。**同一天补做的"真实链路冒烟"（生产库副本上的真实多轮）
> 发现了一个 S1 缺陷**，因此结论改为 **FAIL**。
>
> **先读这份**：`docs/m4/M4-问题说明.md`（一口气说清问题、影响与修复路线）。
> 详细复现与根因：`docs/m4/M4-Defect-D1-wrong-target-forget.md`。

```text
M4 STATUS:

[ ] PASS
[ ] CONDITIONAL PASS
[x] FAIL
```

### 推翻 PASS 的那一条

| # | 缺陷 | 等级 | 复现 |
|---|---|---|---|
| **D1** | **显式遗忘会撤销无关的正确记忆** | **S1** | 库里只有 1 条 active 时，任何**目标不明**的"忘掉…"都会撤掉那一条。实测："忘掉我养过一只鹦鹉这件事" → 撤掉了 `education.institution = 示例工程科技大学` |

**它为什么让结论变成 FAIL**（三条依据，任一条都够）：

1. 附件 §41：**S1 → 直接 FAIL**；§44 又明确"CONDITIONAL PASS **不得**用于掩盖任何 Memory Correctness 问题"。
2. 工程计划书 **§216「Explicit Mutation：Remember / Correct / Forget 全部可靠」不满足** ——
   Forget 撤错了对象不叫"可靠"。§216 的门槛是"只有以下全部完成，才能进入 M5"。
3. **§0 的 FAIL 情形**包含"UPDATE/SUPERSEDE 破坏旧数据"；
   这里是 `retract` 把一条**正确的、用户授权的事实**错误地判定为"不该保留"。

**根因**（定位到行）：`target-resolver.ts:340-342` 的第 3 步 ——
只要该 subject 下只剩一条 active，就直接返回 `resolved`，
**从不要求那一条与用户说的话相关**。

**为什么整套验收都没抓到它**：验收新增的五道门（isolation / restore / scale /
hardkill / audit）都刻意不写真实库，因此都绕过了"**解析器 + 服务 + 真实文本**"
这个组合。这是本项目第三次栽在同一形状上（前两次见 §5 与 `M4-verification.md` §5.6）。

### 判定依据（其余条件仍然成立，但不足以抵消 D1）

| 规则 | 条件 | 状态 |
|---|---|---|
| FAIL 条件 | 任一 FAIL 情形 | ❌ **命中**（见上：retract 破坏了正确的旧数据） |
| CONDITIONAL 条件 | 所有 P0 通过 + **无 S0/S1/S2** | ❌ 有 S1 |
| PASS 额外条件 | §216 全部满足 且 MemOS 有正式结论 且 §217 干净 且 P1/P2 与文档缺口已闭 | ❌ **§216 不满足**（Explicit Mutation） |

**仍然成立的部分**（修 D1 时不必重做）：

1. §216 的其余七个分域 PASS，附件 P0 矩阵 **28 / 28**。
2. **MemOS（Phase 11）有正式结论**：REJECT，判据 = ADR-027 第 7 条（`docs/m4/memos-poc.md`）。
3. **§204 的七篇文档已按名补齐**。
4. 崩溃孤儿的**启动补折叠**已实现并接入（`m4:hardkill` 20/20，含负控）。

### 同一轮冒烟发现的另外两件事

| # | 现象 | 等级 | 状态 |
|---|---|---|---|
| **D2** | 显式"记住/纠正"对**规则抽取器没覆盖的说法**静默失败（`content_unresolved`），而她的回复读起来像已经记下 | 待定（S2/S3） | 需要产品取舍：补线索表（便宜可控）还是接 LLM 兜底（覆盖广但引入不确定性） |
| **D3** | **后台抽取路径没有接入生产**；`CHARACTER_MEMORY_BACKGROUND_ENABLED` 是**惰性**的（`src/` 里没有任何文件 import `app/memory/job.ts`） | S3 | 实测：开关打开后 2 轮普通陈述产出 **0** 条，而她说"住的那条，记了"。**含义：她目前只记得住被明确告知的事** |

### 明确**未做**（用户裁定"2 先别管"）

1. **M4-P02 10,000 事件基准**（P1）。
2. **Scenario A–E 的完整人工盲审**（附件 §52 留给 M6–G1）。
   —— 但**冒烟**已经做了，而且正是它抓到了 D1。

### 剩余技术债

见 `docs/m4/M4-Technical-Debt.md`（本次新增 D1 = S1、D3 = S3 两条）。
修 D1 属于附件 §45 的 **M4 Fix Cycle**：
「发现 defect → 建 reproduction test → 确认 test FAIL → 修 bug → 确认 test PASS →
跑相关 regression → 重新执行所有 P0」。
⚠️ §45 同时禁止"只手动修数据库然后宣布解决"。


### 两项**未做**（如实记录，非隐瞒）

1. **M4-P02 10,000 事件基准**：属 P1；`m4:scale:verify -- 10000` 可直接跑，本次未跑。
2. **Scenario A–E 的真库多轮黑盒**：留 M6–G1（附件 §52 亦如此划分）。

---

## Approval

> ⚠️ **本节是 M4 RC1 的历史记录，结论（FAIL / REJECT）已被 M4.1 重新验收取代。**
> 最新结论见文末「M4.1 重新验收（Re-acceptance）」一节，
> 真源是 `docs/m4/M4.1-Correctness-Fix-Report.md`。
> 这一节**故意保留原文不改**：它是那次 FAIL 的证据，
> 删掉或改写它就等于抹掉"我们曾把一个坏版本判成 PASS"这件事。

```text
Acceptance candidate : 3121cfc（tag: m4-acceptance-rc1 —— 被测试的版本）
Approval commit      : 无 —— 验收**未通过**（FAIL）
Final tag            : m4-complete **已撤销**（它曾指向 ee8c791，但那个 commit
                       之后发现的 S1 = D1 使"正式通过"不成立）
MemOS                : REJECT
Acceptance date      : 2026-09-17（同日被冒烟测试推翻，改为 FAIL）
```

**验收产生的 commit**（都在 `m4-acceptance-rc1` **之后**，
因此"被测试的版本"与"记录验收的版本"是分开的）：

```text
4c2b704  m4(acceptance): 补齐 P0 缺口 —— 隔离 / 备份恢复 / 规模 / 强制终止 + 抽取补测
d6bdb72  m4(acceptance): 冻结基线 + 覆盖矩阵 + 门结果证据
c811934  m4(acceptance): 最终验收报告 + 人工审计 + MemOS 结论 + 文档对齐
0064358  m4(acceptance): 报告补上三个验收 commit 与标签状态
ee8c791  m4(acceptance): 收口 §204 七篇文档 + 启动补折叠（S3-3）→ PASS   ← tag: m4-complete
```

三个标签/版本的语义区分（沿用工程计划书的约定）：

| 名字 | 指向 | 含义 |
|---|---|---|
| `3121cfc` | — | 进入验收前的工作区状态 |
| `m4-acceptance-rc1` | `3121cfc` | **被测试的**版本 |
| `m4-complete` | `ee8c791` | **正式通过验收的**版本 |

> 结论从 CONDITIONAL PASS 变为 **PASS** 的依据写在「判定依据」一节：
> 收口了 §204 与 S3-3，并**显式记录**用户在 2026-09-17
> 把 M4-P02（10,000 基准）与 Scenario A–E 真库黑盒推迟到 M6/G1。
> 若不同意"推迟"这个前提，结论应退回 CONDITIONAL PASS ——
> 其余条件与它无关，都是独立成立的。

### 复现本次验收

```bash
pnpm m4:ci              # 离线全量门（含隔离 + 恢复）
pnpm m4:ci:full         # 含真实模型档（需要 OPENAI_API_KEY）
pnpm m4:backup:verify   # 备份可读性（8）
pnpm m4:real-db:verify  # 真库验收（只读，30）
pnpm m4:scale:verify    # 规模（11）
pnpm m4:hardkill:verify # 强制终止 + 启动补折叠（20）
pnpm m4:audit           # 人工审计语料（10）
pnpm m4:smoke:live      # ⚠️ **真实链路冒烟（生产库副本）** —— 就是它抓到了 D1
pnpm memory:audit --limit 50   # 真实库审计（只读）
```

证据目录：`artifacts/m4-acceptance/`

---

## M4.1 重新验收（Re-acceptance）

> 真源是 `docs/m4/M4.1-Correctness-Fix-Report.md`（修复计划书 §41 的收口文档）。
> 本节只记录"结论从 FAIL 变回 PASS"这件事与它的边界。

### 为什么会有这一节

M4 的 RC1 结论是 **FAIL**，原因是一个**真实链路**缺陷（S1 = D1）：

```text
用户：忘掉我养过一只鹦鹉这件事
库里：只有一条 active —— education.institution = 示例工程科技大学
结果：**示科那条被撤销了**（用户明确没提它）
```

`target-resolver.ts` 第 3 步把"**唯一** active"当成了"**相关**"：
`if (active.length === 1) return resolved`。后果是**任何**遗忘说法都能改掉
那条唯一的记忆。当时 939 项自检断言全绿 —— 因为没有任何一项
是"从真实文本出发、跑完整链路、再看库里发生了什么"。

### 结论

```text
Acceptance candidate : e5702a5（tag: m4-acceptance-rc2 —— 被测试的版本）
Approval commit      : 本次提交（tag: m4-complete —— 正式通过验收的版本）
MemOS                : ACCEPT
Acceptance date      : 2026-09-17
Gate                 : G1–G13 全 PASS（G12 / G13 为 Hard Gate）
自检断言             : 993（离线，全绿）
```

### 与 RC1 的差异（只列"结论会因此不同"的部分）

| 项 | RC1 | M4.1 |
|---|---|---|
| 唯一 active + 不相关 forget | ❌ 改掉了无关记录（D1） | ✅ 词面相关才允许命中（正控 S3 + 负控 S4/S5 双向锁定） |
| 明确要求忘掉、且目标真的存在 | ✅ | ✅ 未退化（`L3-03` / G13 S3） |
| 抽取不支持的说法 | ⚠️ 可能用成功口吻回答而库未变 | ✅ 回复与执行结果绑定（`applyResponseTruthPolicy`） |
| 自动记忆路径（D3） | 文档宣称可用，实际没有消费者 | ✅ 标注 `NOT-WIRED` + 启动告警 + 回归锁（**如实降级，不是修复**） |
| Production-copy Live Smoke | 抓到了 D1（FAIL） | ✅ 16 / 0（Hard Gate G13） |

### 边界（必须一起读，否则会误读这个 PASS）

1. **推迟项不变**：M4-P02 10,000 事件基准、Scenario A–E 真库多轮黑盒
   仍按用户决定推迟到 M6/G1。本轮修的是"安全地不写 / 不删"，
   推迟的两项测的是"规模与语义召回"。
2. **D3 仍然没有接生产**，这是**如实记录**。用户说"记住某事"走的显式路径
   是可靠的；普通陈述式对话目前不会写库，她**可能**仍口头说"我记着"
   —— 这是用户选定的"陈述式告知不写入"边界的**表现**，不是守卫失效
   （`executed === undefined`，即没有可撤销的执行）。
3. **993 项全绿在修复前也是全绿**。真正把 D1 与它的同源缺口抓出来的是
   Layer D（真实多轮）。这一条已写进 `memory-invariants.md`
   （INV-M41-01..05），是本次事故最有价值的产出。

### 复现重新验收

```bash
git checkout m4-acceptance-rc2
pnpm m4:ci          # 离线全量门（退出码 0）
pnpm m4:ci:full     # 含真实模型档（需要 OPENAI_API_KEY）
pnpm m4:smoke:live  # Layer D / Hard Gate：生产库副本真实多轮（16 / 0）
```
