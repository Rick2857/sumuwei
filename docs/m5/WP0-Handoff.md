# WP0 Handoff — M5 Repository Reconnaissance & Baseline

> 计划书 CONTEXT HANDOFF 要求的八字段交接单。下一次 DSH execution（WP1）**先读这份**，
> 再读 [`M5-Execution-Plan.md`](./M5-Execution-Plan.md) 与 [`M5-Implementation-Map.md`](./M5-Implementation-Map.md)，
> 然后**只**打开与 WP1 直接相关的源码文件。禁止重新探索整个仓库。

```text
Completed WP: WP0 — M5 Repository Reconnaissance & Baseline
Changed:
  docs/m5/M5-Execution-Plan.md        （新增，用户给定计划的仓库内固化）
  docs/m5/M5-Implementation-Map.md    （新增，AT0.1–AT0.6 全部答案 + 实现地图 + P0 风险 + Deferred Issues）
  docs/m5/WP0-Handoff.md              （新增，本文件）
  docs/architecture/README.md         （最小编辑：阶段三行 + M5 文档表）
  artifacts/m5/baseline.json          （新增，Evidence Record）
  artifacts/m5/wp0-baseline.log       （新增，四条 baseline 命令的原始输出）

Tests:  pnpm typecheck    → exit 0
        pnpm kernel:test  → 26 通过 / 0 失败（含依赖方向静态锁 + ContextCompiler 组装/预算）
        pnpm m3.5:test    → 30 通过 / 0 失败（含 FC-T08 prompt 与 M3 逐字节一致）
        pnpm m4:test      → 243 通过 / 0 失败（Memory 领域模型 + 装配接线 + 静态锁）
        全部 exit code 0；未跑任何会重写已提交历史证据的门（理由见 Evidence）

Evidence: artifacts/m5/baseline.json + artifacts/m5/wp0-baseline.log
          （M4.5 前置：只读 artifacts/m4.5/gate-results.json —— G12/G13/G14 hard gate 均 PASS）

Known issues:
  D-1 docs/architecture/README.md:295 称 m4:test 228 项，实测 243 项（文档漂移）
  D-2 MemoryIndexPort（compat-audit N4）在代码中不存在 → WP1/WP3 必须新建端口
  D-3 MemoryQueryScope 缺 subject/time/text；listBySubject 不过滤 status
  D-4 docs/m4/current-state.md:275 声称的 "memory section 无人产出" 断言并不存在
      → WP6 应新增正向锁
  D-5 M4 遗留且目标阶段标注 M5 的债务（T31/T32、语义去重第三层、memory:audit retracted 渲染、
      hydrate N+1）→ 只登记，不自动纳入 M5，由用户裁定
  D-6 MI-11 跨进程场景缺口（沿用 M4 记录）
  R1–R6 见 M5-Implementation-Map.md §6（R1 跨用户泄漏面 / R2 查询不过滤 status 是 P0 级）

Interfaces exposed to next WP:
  ★ 唯一插入点：TurnGateway.compileTurn（src/kernel/app/turn-gateway.ts:728）
  ① ContextSectionKind 'memory' + SECTION_PRIORITY.memory = 40   （contracts/context.ts:47/:73，已登记无产出）
  ② character_traces.selected_memory_ids                          （migrations.ts:210，列已存在恒 []）
  ③ isRecallEligible(status) = active || disputed                 （contracts/memory.ts:139，无消费者）
  ④ memory_records (owner_id,status) 等 M4 索引                   （migrations.ts:593-620，已为 M5 建好）
  ⑤ section provider 扩展先例：createMemoryWriteResultProvider / createActionResultProvider（sections.ts:396/:440）
  ⑥ 装配纪律：端口决定接没接上、开关决定要不要用（main.ts:447-517；M4.1 D3 教训）
  ⑦ 门与证据约定：scripts/m4.5-gate-results.ts + artifacts/<milestone>/ + docs/<milestone>/

Do not modify:
  src/kernel/app/memory/**  ·  src/kernel/policies/memory-validator.ts
  src/infrastructure/persistence/memory-store.ts 的 reducer 语义
  src/kernel/contracts/memory.ts 的事件 payload
  迁移 0001–0006（只许追加新版本号）
  src/character/苏沐薇.ts（Seed）  ·  evals/fixtures/m3.5/prompt-baseline.txt
  docs/苏沐薇-使用说明.txt（权威源）
  artifacts/m4-acceptance/** · artifacts/m4.1/** · artifacts/m4.5/**（历史证据，不要顺手重新生成）

Next WP prerequisites:
  1. 读 M5-Execution-Plan.md（WP1 节）+ M5-Implementation-Map.md（§3/§4/§6）
  2. 只改 recall 契约与契约测试：src/kernel/contracts/recall.ts（新文件）+ 契约测试
  3. WP1 允许新增 pnpm m5:test 脚本（WP0 刻意没动 package.json）
  4. 若 M4.5 任一 hard gate 已非 PASS → STOP（计划书 §0.2）
  5. 若发现必须修改冻结区语义 → STOP + report scope conflict（Rule 5）
```

---

## 补遗：WP0 之后的调查（AT0.7，2026-09-17）

WP0 交付后做了一次针对性调查（三条风险逐条查实 + DELETED 的表示）。
**结论已写回 `M5-Implementation-Map.md` §2.5 / §6（R7、R8）/ §7（D-7、D-8）**，
原始输出在 [`../../artifacts/m5/investigation-2026-09-17.json`](../../artifacts/m5/investigation-2026-09-17.json)。
对 WP1/WP2 影响最大的四条：

```text
① 中文↔槽位桥**存在**，就是 M4.1 那一份：登记表 description/examples
   + lexicalFragments（CJK bigram）+ lexicalOverlapHits + listBySubject
   → WP2/WP3 **复用**，不要新写词表或新算法（原判断"无桥"已推翻）

② 桥的覆盖度 = 登记表覆盖度（当前 10 个槽位）。未登记 predicate（LLM 自造键）
   对中文问句系统性零命中 → WP4 的目标与 Gold Dataset 必须与这条机制对齐

③ E2E Scenario A 的「生日」在默认装配下**写不进库**（实测 content_unresolved；
   规则表无私生日线索，LLM 抽取器默认 off）→ WP8 必须先裁定夹具
   （或换规则可写的事实，或显式开启 LLM 抽取器并补 flag 消费锁）

④ 【新发现 / 候选 BLOCKING DEFECT】--reset-kernel 不清理 memory_records 与两张
   link 表 → 留下「ACTIVE 但事件流为空、证据已不存在」的孤儿记忆；
   rebuildMemory 报 equal=false，而 memory:audit 的 0-unsupported 探针看不见；
   scripts/ 下没有任何测试跑过 resetKernelData。
   → 沙箱实测证据（Level 2）。
   ★ 用户 2026-09-17 裁定：**必须解决，且阻塞 M5** → 在 WP0 与 WP1 之间插入
     `M5-PRE / State-Integrity Hotfix`（先写失败测试 → 修 resetKernelData →
     修 memory:audit 悬空检测 → 重新 baseline M4 → 再进 WP1）。
     判据 = liveEvidenceCountAfterReset（不能因为失效一条证据就整条删）。
     真库只读盘点已做：**CLEAN**（0 孤儿 / 0 悬空引用），因此不需要 repair。

⑤ 三条能力边界（用户 2026-09-17 裁定：不扩建系统，改契约与验收方式）：
     G1 生日 → 不修抽取能力；E2E Gate 换规则表已支持的事实，生日降级为
              Coverage Boundary Test（不开 LLM 抽取器 —— 那是 Scope Creep）
     G2 第三人 subject → 不扩 Entity Model；Scenario E 改为验证
              not_found/ambiguous → selected_memory_ids = []；禁止直接插库
     G3 词面桥覆盖度 → 接受边界；KPI 拆成 Supported-Domain Recall ≥95%
              + Coverage Boundary Set（不计入 95%）
     另：M5 契约里的 DELETED 与"证据缺失"必须分开 —— 加
         ORPHANED_EVIDENCE / INTEGRITY_INVALID，DELETED 留给将来真正的
         status = deleted（落点在 WP1 契约，不是 Hotfix）

⑥ 【已完成 2026-09-17】M5-PRE / State-Integrity Hotfix：
     · 先写失败测试（`artifacts/m5/pre/red-memory-integrity.log`，8 项红）
     · 修 `resetKernelData`（新模块 `infrastructure/persistence/memory-integrity.ts`）
     · 修 `memory:audit` 的悬空检测（`memory-stats` 单列 dangling / 孤儿）
     · 真库只读盘点：**CLEAN**（无需 repair）
     · 新门 `pnpm m4:memory-integrity:verify` **28 通过 / 0 失败**；
       M4 回归全绿（m4:test 243 / m4:verify 142 / isolation 22 / restore 24 /
       mutation-safety 见 artifacts / nl-mutation 见 artifacts / eval:m4 17）
     · ⚠️ 一处如实偏差（**D-9**）：判据里"只删除失效 evidence"**做不到而不破 MI-11** ——
       `compareRecords` 比对 `sourceRefs`，而重放侧来自 `MEMORY_CREATED` 的 payload 快照。
       实现因此**保留**幸存记忆的失效 link（A==B 优先），并把它单列进探针。
       要让它也归零，需要"为证据移除追加事件"（动冻结区）→ 新里程碑。
       **WP1 起把这条写进 M5 Known Limitations。**
     · 分支说明：M5-PRE 与 WP1 同在 `feature/m5-retrieval-context`
       （它是 M5 路线里被插入的一个阶段，不是并行的修复流）；
       若需要独立的 `fix/*` 分支，这三笔提交可以摘出去。
```
