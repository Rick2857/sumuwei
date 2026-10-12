# WP1.1 Handoff — Axis B Fail-Closed Compatibility Closure

> **结论：PASS。WP1 Axis B Extension = PASS；WP1 Overall = PASS。**
>
> 下次 execution **先读这份**，再读
> [`WP1-Handoff.md`](./WP1-Handoff.md)（WP1 主体交付）、
> [`M5.1.1-WP1.1-Compatible-Assertion-Record.md`](./M5.1.1-WP1.1-Compatible-Assertion-Record.md)（既有断言改动逐条记录）、
> [`M5.1.1-WP1-Blocking-Issue-Report.md`](./M5.1.1-WP1-Blocking-Issue-Report.md)（为什么需要这个 WP 的历史留档）、
> [`M5.1.1-Execution-Plan.md`](./M5.1.1-Execution-Plan.md)（§1 原文 / §2 修订记录 / §3 批次表）。
> **不要重新探索仓库。**

```text
Completed WP: WP1.1 — Axis B Fail-Closed Compatibility Closure（K-1 = B1）
              WP1 Axis B Extension = PASS · WP1 Overall = PASS

Changed Files:
  src/kernel/contracts/source-authority.ts        （改：Axis B 两个 UNCONFIRMED_ORIGIN；
                                                    既有 6 + 4 个值未改名未换语义；
                                                    EXTERNAL_FACT_AUTHORITIES 未动）
  src/kernel/contracts/memory.ts                  （改：**冻结区**唯一最小改动 ——
                                                    authorityFromSource 新增 fail-closed
                                                    case，不制造也不挑选 MemoryAuthority）
  scripts/kernel-tests-conversation.ts            （改：唯一一条既有断言，精确基数 6 → 7）
  scripts/kernel-tests-m5.1.1.ts                  （改：Axis B 由 BLOCKED 改 VERIFIED +
                                                    四个负控 A/B/C/D + 晋级路径全枚举 +
                                                    检测器三段式自检 + 写第二份证据）
  artifacts/m5.1.1/wp1-contracts.json             （改：axisB.status = VERIFIED）
  artifacts/m5.1.1/wp1-axis-b-closure.json        （新增：WP1.1 专项证据）
  artifacts/m5.1.1/wp1.1-pre-m4ci-artifact-hashes.txt（新增：跑 m4:ci 前的哈希原始捕获）
  artifacts/m5.1.1/wp1.1-artifact-hash-verification.txt（新增：解析后的逐文件核对结果）
  artifacts/m5.1.1/wp1-{typecheck,kernel-test,conversation,contracts-test}.log（新增/更新）
  artifacts/m5.1.1/wp1-m4-ci.log                  （新增：m4:ci 全量逐字 stdout，含 M4CI_EXIT=0）
  docs/m5.1.1/M5.1.1-WP1.1-Compatible-Assertion-Record.md（新增：F4 四条约束的兼容性记录）
  docs/m5.1.1/M5.1.1-WP1-Blocking-Issue-Report.md （改：加 RESOLVED 横幅，正文作为历史留档）
  docs/m5.1.1/WP1.1-Handoff.md                    （本文件）

Tests Run（全部 exit 0）:
  pnpm typecheck                  → 0
  pnpm kernel:test                → 0
  pnpm kernel:test:conversation   → 0（**47 通过 / 0 失败** —— 那条基数断言现为 7）
  pnpm m5.1.1:test                → 0（**41 通过 / 0 失败**，比 WP1 多的 6 条是本 WP 的负控与自检）
  pnpm m4:ci                      → 0（**AGENTS §3 要求的冻结区回归套件**：m3.5:ci ⊃ m3:ci 全套
                                     + m4 全链 m4:test / m4:verify / m4:faults / m4:restart /
                                     m4:isolation / m4:restore / m4:mutation-safety /
                                     m4:nl-mutation / eval:m4 / eval:m4:promptfoo）
  未运行（有意）：m4.5:*/m5:*/m5.1:* 的大门与任何 Live Smoke —— 不在本 WP 范围

Tests Passed: 41/41（m5.1.1:test）· 47/47（conversation）· m4:ci 全链 exit 0 · 五条命令全 exit 0
Tests Failed: 0

Evidence Produced:
  artifacts/m5.1.1/wp1-axis-b-closure.json —— WP1.1 专项，含：
     · hardInvariant 原文、decision（K-1 = B1）
     · frozenAreaChange（文件/函数/改动/理由码/六个既有映射未变/穷尽性锁保留）
     · negativeControls A–D 的逐条 expected/observed（A 返回 throw:…；
       B 返回 "no MemoryAuthority returned (threw)"；C = false；D = 三成员原样）
     · detectorSelfTest：positiveControl = quiet:mapped:EXPLICIT_USER_STATEMENT /
       negativeControl = fired:unconfirmed_origin_cannot_become_memory_authority /
       restored = quiet:mapped:CHARACTER_GENERATION
     · promotionPathEnumeration（7 个 SourceAuthority 逐个 mapped / failed-closed）
     · firewallUnchanged 探针、suites.exits（四个退出码，全部来自包装命令真实退出码）
     · forbiddenScopeRespected：11 项全部 false
  artifacts/m5.1.1/wp1-contracts.json —— axisB.status = "VERIFIED"
  artifacts/m5.1.1/wp1.1-artifact-hash-verification.txt —— **F4 约束 ④ 的证据**：
     83 个已跟踪 artifacts 文件逐条 pre/post sha256；
     IDENTICAL = 80；DIFFERENT = 3，且 3 个全部落在 artifacts/m5.1.1/ 内（**本 WP 自己的证据**，
     有意重新生成），历史证据（m4-acceptance / m4.1 / m5.1 / m4.5 / m5）逐字节相同；
     git diff HEAD 对 m4:ci 重新生成的那 4 个文件为空。

Commit Hash: 5402940eacd0d2dc800d8c66c7fbf273d186f669

Known Issues（含**我自己犯的两个错**，都已改正并如实登记）:
  K-1' 【已解决】WP1 的冻结区阻塞：B1 落地 = memory.ts 加一条 fail-closed 分支。
       硬不变量：UNCONFIRMED_ORIGIN 可作为 provenance 记录，但无 MemoryAuthority 晋级路径。
  K-2  contracts/index.ts 的 re-export 与文件头登记**仍未做**（WP1 的 Allowed Scope 不含它）。
       新契约目前按路径直接 import。留给第一个消费它的 WP（WP4/WP5）或你的批准。
  K-3  **矩阵 ↔ ADR 的 3 格表述差异仍未裁定**（tool_event 的 actor/executor/contentOriginator）：
       本 WP 不改它。**WP4 写工具事件之前必须先有结论**，否则"契约拒写、设计要求写"。
  K-4  【自曝缺陷①】我生成的哈希清单格式是坏的：把 FileHashInfo 对象直接插值进文本
       （`Hash=…; Path=…}  <相对路径>`），于是第一次核对脚本按空白切分解析失败，打印
       `hashes_checked=0 mismatches=83`。那个 83 是**解析失败**，不是 83 个文件不一致
       （AGENTS §6.8 的典型陷阱）。已用正则重新解析原始捕获并得出真实结果
       （80 IDENTICAL / 3 DIFFERENT，且 DIFFERENT 全部是本 WP 自己的证据）。
  K-5  【自曝缺陷②】还原历史证据时，我把 `git status -- artifacts` 的全部条目一起
       `git checkout --`，于是**顺手把我自己的 WP1.1 证据文件也还原成了提交里的旧内容**。
       发现后重新跑了完整的有序验证（四条命令 + 环境变量退出码），证据已按真实结果重新生成。
       教训：还原只应作用于**已知被重新生成的历史证据**（白名单），不能对整个目录做无差别 checkout。
  K-6  本轮 m4:ci 重写了 4 个历史证据文件（isolation-result / restore-result /
       mutation-safety / nl-mutation），已 git checkout -- 还原并逐字节核对（见 Evidence）。

Architecture Deviations:
  D-1  在冻结区 `src/kernel/contracts/memory.ts` 里做了**一条** fail-closed 分支 ——
       这是 WP1.1 任务书 §2 明确授权的最小改动，也是 AGENTS §3 冻结区程序下
       "只追加能力、不改既有语义"的落地方式。既有六个映射与穷尽性锁都未动。
  D-2  契约层仍未进 index.ts 公开出口（K-2）。
  D-3  语义选择沿用 WP1 的 4 条（`?` 也要求被表态 / REQUIRED 允许 RUNTIME_UNRESOLVED 但
       禁止 LEGACY_UNRECORDED / 信封含 attributionOrigin / 回填行只查禁止伪造）。
  D-4  未实现 ADR-043 的任何内容；新值对**已落库**记忆资格的影响仍 MOVED_TO_ADR_043。

Do not modify（后续 WP 只消费，不许顺手改）:
  · src/kernel/contracts/memory.ts 的既有六个映射与穷尽性锁（只能追加 fail-closed 分支，
    且任何进一步语义改动都要走冻结区程序）
  · src/kernel/app/memory/**（extractor.ts:149 / :329）· policies/memory-validator.ts ·
    memory-store.ts reducer · canEvidenceExternalFact / deriveSourceForLegacyRow 的行为
  · 迁移 DDL 0001–0006 · artifacts/{m5.1,m4.5,m5,m4-acceptance,m4.1}/** · data/pglite
  · M5.1 的 m5.1-complete 标签（仍须指向 2aac6ca）

Next WP Preconditions（WP2 — v7 Additive Schema Migration）:
  1. 现在 **M7（Axis B 三列完整性）已不再被阻塞**：`source_kind` / `source_authority` /
     `epistemic_source` 三个取值域齐了（`source_authority` 与 `epistemic_source` 都能取
     `UNCONFIRMED_ORIGIN`，且它 fail-closed）。
  2. 可开工：v7 迁移（conversation_events / character_action_events 各 22 列、
     每槽位 4 条 CHECK、1 个 `attribution_origin` partial 索引）＋ U-03 的控制面审计承载
     （**新建** append-only 表；仓库无既有表可复用）＋ 迁移测试（1..7 连续 / old→v7 /
     fresh→v7 / 幂等 / 无 DROP / 无破坏性 ALTER / 旧代码兼容）＋ migration-preview.txt。
     **只在临时库**跑；**不得**对 data/pglite 执行 migrate:apply。
  3. 契约的消费方式：按路径直接 import（K-2）。
  4. 若某个既有门因本次加值变红：只在 F4 四条约束下做**最小**兼容更新，逐条记录进
     `M5.1.1-WP1.1-Compatible-Assertion-Record.md` 的同类文件，并更新 `M511-G9` 的证据。
  5. 交 WP2-Handoff（九字段）后 STOP。
```

---

## Batch B 的边界

**WP1 + WP1.1 到此 STOP。** 没有开始 WP2：既没有写迁移，也没有碰 persistence 或运行时写入路径。
`K-3`（矩阵 ↔ ADR 的 3 格差异）是**WP4 的前置**，不是 WP2 的前置；但它需要你裁定，早说比晚说好。
