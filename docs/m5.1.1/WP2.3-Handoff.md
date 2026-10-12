# WP2.3 Handoff — Evidence Integrity & Pre-WP3 Closure

> ## 状态
>
> ```text
> K-18 = CLOSED
> K-19 = CLOSED
> WP3  = READY
> ```
>
> **`WP3 = READY` 的精确含义**：技术上**无阻塞** —— K-17（回填的消费者影响）与 K-19
> （证据写入完整性）都已闭合，WP3 没有已知前置缺口。
> **但动手许可仍在你手里**（WP2 的 STOP 点未变）：真实库 / production-copy 的
> v6→v7 正式 apply 与 WP3 回填 **= NOT RUN**、WP3 **= NOT STARTED**。
> 若"READY/BLOCKED"要按"能不能动手"读，那它此刻是 *BLOCKED BY 你的放行* ——
> 取哪个读法由你裁定；本报告把两个读法都写出来。
>
> 下次 execution **先读这份**，再读
> [`WP2.2-Handoff.md`](./WP2.2-Handoff.md)（K-17 与 production-copy schema apply）、
> [`M5.1.1-Execution-Plan.md`](./M5.1.1-Execution-Plan.md) §3.1（**实际插入的 WP**）与 R-17（**K-8 触发点**）。
> **不要重新探索仓库。**

```text
Completed WP: WP2.3 — Evidence Integrity & Pre-WP3 Closure
  K-18 = CLOSED（两份 canonical 文档追加 post-freeze 勘误：纯追加 113 行 / 0 删除行）
  K-19 = CLOSED（m5.1.1:test 的证据写入改为显式授权 + fail closed；裸跑哈希逐字节不变）
  K-8  = NOT CLOSED（登记："第一次成功的 production-copy v7 apply"之后锁 MIGRATION_0007 指纹）
  真实库 apply = NOT RUN ｜ WP3 = NOT STARTED

Changed Files:
  scripts/kernel-tests-m5.1.1.ts                        （改：K-19 权威证据写入门 + M511_TEST_SUMMARY）
  scripts/verify-m5.1.1-k19-evidence-integrity.ts       （新增：K-19 专项门，三段式）
  scripts/verify-m5.1.1-migration.ts                    （改：K-8 锁定触发点注释，**comment-only**）
  package.json                                          （改：+ m5.1.1:k19:verify）
  docs/adr/ADR-042-attribution-model.md                 （改：**追加** §12 POST-FREEZE FACTUAL ERRATUM）
  docs/m5.1.1/M5.1.1-D01-Investigation-Report.md        （改：**追加** §15 同名勘误）
  docs/m5.1.1/M5.1.1-Execution-Plan.md                  （改：新增 §3.1 插入登记 · R-16 追加执行结论 · 新增 R-17）
  docs/m5.1.1/WP2.3-Handoff.md                          （本文件）
  artifacts/m5.1.1/wp2.3-k19-evidence-integrity.json    （新增：K-19 证据）
  artifacts/m5.1.1/wp2.3-{typecheck,kernel-test,test,k19-verify,migration-verify,measurement-verify}.log
                                                        （新增 6 份：逐字 stdout）
  artifacts/m5.1.1/wp2.3-gate-exits.txt                 （新增：6 条命令退出码）
  artifacts/m5.1.1/wp2.3-restore-whitelist.txt          （新增：还原白名单 + 前后哈希）

Tests Run（全部 exit 0；见 wp2.3-gate-exits.txt）:
  pnpm typecheck                  → 0
  pnpm kernel:test                → 0（**26 通过 / 0 失败**）
  pnpm m5.1.1:test                → 0（**42 通过 / 0 失败**；并打印 K-19 门自述"非授权运行 ⇒ 不写"）
  pnpm m5.1.1:k19:verify          → 0（**19 通过 / 0 失败**；三段式全绿）
  pnpm m5.1.1:migration:verify    → 0（**77 通过 / 0 失败**；用于确认 K-8 注释改动没碰指纹表）
  pnpm m5.1:measurement:verify    → 0（**16 通过 / 0 失败**；AGENTS §5 对新 `verify-*.ts` 的要求）

Tests Passed: 26/26 · 42/42 · 19/19 · 77/77 · 16/16；6 条命令全 exit 0
Tests Failed: 0
Tests Not Run:
  · 真实库 data/pglite 的 migrate:apply（**等你放行** —— STOP 点未变）
  · WP3 legacy backfill（未开始）
  · pnpm m5.1:gates / m5.1:regression:verify（交付级收尾门；本 WP 无 src/ 改动，未触发）
  · pnpm m4.5:ci / m4.5:ci:full（全量回归，WP10 的项）

Evidence Produced:
  artifacts/m5.1.1/wp2.3-k19-evidence-integrity.json —— K-19 完整事实（快照 / 拒绝 / 授权写入 / 量具读数）
  artifacts/m5.1.1/wp2.3-gate-exits.txt · wp2.3-*.log —— 退出码 + 6 条命令逐字 stdout（UTF-8 无 BOM）
  artifacts/m5.1.1/wp2.3-restore-whitelist.txt —— 还原白名单 + 哈希（含一次几何差异的判据说明）

Commit Hash: 9ea5432e98772fa0ada4834940070f5701582080   （K-19 修复 + 门 + 证据）
             526640a77382b167d281e4a3ad0e96937e998409   （K-18 勘误）
             （本文件所在提交见 git log）
```

---------------------------------------------------------------------------
 K-18：两份 canonical 文档的 POST-FREEZE FACTUAL ERRATUM（**纯追加**）
---------------------------------------------------------------------------
落点：`M5.1.1-D01-Investigation-Report.md` **§15** ·
      `docs/adr/ADR-042-attribution-model.md` **§12**

```text
改动形状（机读复核）：+113 行 / **0 删除行**（git diff 逐行核过）
未做的事：✗ 重写历史段落 ✗ 升 Revision ✗ 改 Design Freeze 状态
          ✗ 改 D01 severity/status ✗ 改 D1–D12 ✗ 改 §10/§11 变更历史
复核锚点：ADR-042 L3 仍是 `ACCEPTED / DESIGN FROZEN`；L5 仍是 `P1 · OPEN`；
          L18 变更历史仍是「Draft v1 → Revision 2 → Revision 2.1」；
          L67–69（§1 ④ 原文）**一字未动**
```

勘误**必须说明**的四件事（已逐条写进两处，且**每一条都自己核过源码/证据**，不是转述）：

```text
① v3 已存在 Axis B 三列
   migrations.ts:346-351（MIGRATION_0003，见 :275）
   alter table conversation_events add column if not exists source_kind text
   （同样两条建立 source_authority / epistemic_source；索引 :357-358）
② conversation-store 会写
   conversation-store.ts:264-278 的 INSERT 显式列出这三列（:268 列清单、:276 取值）
③ production-copy v6 为 24/28 非空
   28 行里三列非空 **24 行**（4 行为 0003 之前的旧行）
④ 这些值**仅为 actor_type-derived projection**，不构成独立 provenance evidence
   写入值来自 conversation-event.ts:277-284 的 buildProvenance({ actorType, … })；
   读回侧（conversation-store.ts:79 → deriveSourceForLegacyRow :335-346）同一规则
```

**不要过度更正**（这句是对的，两处勘误都显式写了）：D01 §6 ③ / §7 表 A 与 ADR-042 §1 ④
里关于 **`event-store.ts`** 的那半句**仍然成立** —— 它写的是 `character_domain_events`
（event-store.ts:156），确实没有这三列。错的只是"把 event-store 的结论套到整张
`conversation_events` 上"。

**与 ADR-042 语义的关系（写进了 §12）**：§1 ③（Fact Firewall 唯一输入是 `actorType`）
与 **§4（Axis B 必须真正持久化 / WRITE-READ-NEVER）都不变** ——
被更正的是"**过去**有没有持久化"这个**历史事实**，不是"**应当**持久化"这条**要求**；
库里那三列装的是推导值，所以 §4 的 NEVER 原则依然成立。

---------------------------------------------------------------------------
 K-19：权威证据写入门（fail closed）
---------------------------------------------------------------------------
**真实事故的形状**：本脚本过去**每次**运行都无条件重写
`artifacts/m5.1.1/wp1-contracts.json` 与 `wp1-axis-b-closure.json`。
"顺手重跑一次 `m5.1.1:test`"就把里面的真实退出码 `0` 改写成 `null`，
而两次运行的 stdout **都**打印 `证据已写入：…` —— 从输出上完全看不出证据被降级。

```text
修复后的规则（scripts/kernel-tests-m5.1.1.ts）
  普通 test execution                                   → **一个字节都不写**（连目录都不建）
  M511_AUTHORITATIVE_EVIDENCE=1 且四路测量输入齐全        → 才允许写
  任一不满足                                            → **拒绝写 + 非 0 退出**（fail closed）

两条拒绝原因（各自可观测、机读）
  reason=measured-downgrade        **禁止 existing measured 0 → null**（先查这一条）
  reason=missing-measurement-input 四路 M511_*_EXIT 必须齐全

为什么用环境变量而不是 CLI 开关（一条**发现**）
  `argv[2]` 已经被用作**测试过滤词**（`pnpm m5.1.1:test <filter>`）。
  再加一个位置参数会把过滤词吃掉 → 可能写出"0 条测试通过"的权威证据，
  正是本门要防的事。
```

**K-19 专项门**（`scripts/verify-m5.1.1-k19-evidence-integrity.ts`，19 通过 / 0 失败）：

```text
§0 量具自检（不做这步，正控可能是空转）
   · 同两份文件自比 ⇒ 判"未变"（比较器不会恒报"变"）
   · **真实文件**追加一个字节 ⇒ 判"已变"（比较器不是橡皮图章）
§1 正控：裸跑 pnpm m5.1.1:test
   · exit 0 且 `M511_TEST_SUMMARY` 里 passed=42 / failed=0
     ⚠️ 这条是**防空转的关键**：若裸跑根本没跑起来（编译错/崩了），
        artifact 当然也不会变 —— 那不叫正控，必须证明"测试真的跑了"
   · ★ 两个权威 artifact 的 sha256 **逐字节不变**
§2 负控：不给测量输入 ⇒ 必须拒绝（两种原因各一次）
   · measured-downgrade：seeded 既有 0 ⇒ 拒；被拒后 seeded 文件逐字节不变
   · missing-measurement-input：无既有证据 ⇒ 拒；**连证据目录都不建**
§3 恢复：给全四路 ⇒ **授权写入重新工作**（临时目录）
   · exit 0、两个 artifact 都落盘、既有证据**确实被改写**（证明不是靠"不写"通过）
   · 写进去的是**量到的 0**，不是 null
§4 恢复复核：全部门跑完后，仓库里的权威证据与门开始时**逐字节一致**
```

**裸跑哈希不变（用户指定的判据，实测）**：

```text
artifacts/m5.1.1/wp1-contracts.json        d3807b1bf7483c573a26a4a88a1286aaf06dbd59615db2a5041a669316df5f41（14224 B）
artifacts/m5.1.1/wp1-axis-b-closure.json   6ac63f0c8bed3312998335d3474c35ab7b3e388ceedb6246cebdefe6e8330bcc（6300 B）
裸跑前后**逐字节一致**；`git status --porcelain` 对这两条**无输出**
（机读：wp2.3-k19-evidence-integrity.json 的 before / afterNaked / final 三组快照完全相同）
⇒ **K-19 = PASS**（判据不是"看起来没变"，而是 sha256 相等 + 测试确实跑过）
```

**验证缝（如实登记）**：新引入了 `M511_EVIDENCE_DIR`，**只用于把这个门的"授权写入"
重定向到临时目录**。必要性：该脚本还要从 **cwd** 读 `src/kernel/contracts/**`（静态锁）
与 `docs/m5.1.1/M5.1.1-WP1-Blocking-Issue-Report.md`，所以**不能在别的 cwd 下跑**
（这一点是本 WP 实测发现的，不是推测）。它不削弱 K-19：非授权运行仍然一个字节都不写，
唯一效果是把**授权**写入挪走。

---------------------------------------------------------------------------
 Execution Plan：登记实际插入（**保留原 A–L**）
---------------------------------------------------------------------------
新增 **§3.1「实际插入的 WP（不是原计划）」**，登记 `WP1.1 / WP2.1 / WP2.2 / WP2.3`
各自的插入位置、处理的缺陷、状态与主证据，并写明三条"未变"：

```text
1. §3 批次表本身（Execution 1–12 / Batch A–L / WP0–WP11）**一字未改**
2. **Batch D 仍然 = WP3（Legacy Backfill）**，其"何时可开始"条件未变
3. 当前 STOP 点仍是「用户放行 production-copy v6→v7 的正式 apply 与 WP3 回填」
```

性质声明写在 §3.1 开头：这些 WP **不在**用户原文计划里，**不得**被读成原计划的组成部分、
**不得**用来追溯性改写 §3。另：R-16 行尾追加了 K-18 的**执行结论**（哪两份文档、纯追加多少行、哪些状态没动）。

---------------------------------------------------------------------------
 K-8：NOT CLOSED（登记触发点，不锁值）
---------------------------------------------------------------------------
```text
K-8 = **NOT CLOSED（保持 OPEN）**
触发点（用户 2026-09-18 裁定）：**第一次成功的 production-copy v7 apply 之后**
  → 把 MIGRATION_0007 按与既有六条**同一算法**加进 FROZEN_MIGRATION_FINGERPRINTS
    （sha256 over MIGRATION_0007.statements.join('\n')）
在此之前：**不得**把 v7 指纹写进表里，也**不得**留"候选哈希" ——
  那会制造一份没有强制力、却看起来像答案的真相源
落点：Execution-Plan **R-17** + scripts/verify-m5.1.1-migration.ts:153-165 的注释（comment-only）
确认没碰指纹表：复跑 pnpm m5.1.1:migration:verify = 77 通过 / 0 失败
```

---------------------------------------------------------------------------
 还原白名单（R-13 第②条 / AGENTS §7）—— **K-19 让它变短了**
---------------------------------------------------------------------------
本 WP 复跑门时被重新生成、但不属于本 WP 产物的历史证据，逐个路径 `git checkout --`：

```text
artifacts/m5.1/measurement-negative-controls.json（**冻结的 M5.1 证据**）
artifacts/m5.1.1/wp2-schema.json                  （WP2 证据，仅 generatedAt/沙箱目录刷新）
artifacts/m5.1.1/migration-preview.txt            （WP2 证据，同上）
```

前后哈希、CRLF/LF 判据见 `wp2.3-restore-whitelist.txt`；还原后冻结区 `git status` = **空**。

**★ 与 WP2.2 的区别**：以前跑一次 `m5.1.1:test` 必须还原 `wp1-contracts.json` 与
`wp1-axis-b-closure.json` 两条。**现在裸跑不写它们了，这两条已从白名单移除** ——
本 WP 的 6 条门里包含一次独立裸跑，跑完 `git status` 对它们无输出。

Known Issues:
  K-18 【**CLOSED**】两处勘误已落地（纯追加 113 行 / 0 删除行）。
  K-19 【**CLOSED**】写入器已 fail closed；19/19 三段式证据。
  K-8  【**NOT CLOSED**】登记为"第一次成功的 production-copy v7 apply 之后锁"（R-17）。
  K-7  【登记，留 WP10】`scripts/verify-m4-hardkill.ts:205` 的 `schemaVersion === 5` 已过期。
  K-9  【继续 DEFER】`contracts/index.ts` 的 re-export（等第一个真实消费者）。
  §3.1 【已登记】插入的 WP1.1/WP2.1/WP2.2/WP2.3 已按"不是原计划"如实登记；原 A–L 未动。
  【待裁定】`WP3 = READY`（技术口径）与 `BLOCKED BY 你的放行`（动手口径）取哪个作为正式状态词。

Architecture Deviations:
  D-1  K-19 用**环境变量**而不是 CLI 开关：`argv[2]` 已是测试过滤词，再加位置参数
       会把过滤词吃掉 ⇒ 可能写出"0 条测试通过"的权威证据。
  D-2  新增 `M511_EVIDENCE_DIR` **验证缝**（见上）。它是为"三段式里必须证明授权写入
       仍然工作"而加的；不加它就只能靠"假设守卫是对的"来做负控 —— 那正是要验证的东西。
  D-3  负控一律在**临时目录**里做，**不用**仓库目录：用仓库目录要求"守卫一定是对的"才安全。
  D-4  正控里断言 `passed > 0`：只比哈希的话，"测试没跑起来"与"测试跑了但没写"
       在输出上完全一样（§6.8 的同一课）。
  D-5  勘误是**纯追加**：不重写历史、不升 Revision、不改 Design Freeze 状态。
  D-6  K-8 的注释改动是 **comment-only**；仍然复跑了迁移门确认指纹表完整。

Do not modify（后续 WP 只消费）:
  · 0001–0007 的任何语句（0001–0006 有指纹锁；v7 一旦 applied 即历史）
  · ADR-042 的正文、Decision、Revision 历史与 Design Freeze 状态（§12 是勘误，不是修订入口）
  · 运行时写入路径 / Fact Firewall / extractor / MemoryAuthority / Recall
  · artifacts/{m5.1,m4.5,m5,m4-acceptance,m4.1}/**（还原只按白名单）
  · data/pglite（只有 src/main.ts 能开它）

```text
Next WP Preconditions（WP3 — Legacy Backfill）:
  1. **你放行**：真实库 / production-copy 的 v6→v7 正式 apply 与 WP3 回填的动手许可
     （当前 STOP 点）。备份 → 核对（文件数 + 字节）→ `cpSync` 副本 → 迁移预览 →
     **副本** apply → 计数 → 重放；记录 restore epoch / boundary。
  2. 前置缺陷已清零：**K-16 / K-17 / K-18 / K-19 全部 CLOSED**。
  3. WP3 按 `event-family × slot` 的 D/P/U/N 回填（Migration-Strategy §3.2/§3.3）。
  4. 证据一律 `artifacts/m5.1.1/`；还原按白名单（**注意 K-19 后的白名单变短了**）；
     每个计数检测器都要 `measured_count > 0`，否则 MEASUREMENT INVALID。
  5. 交 WP3-Handoff（九字段）后 STOP。
```

---

## 本次没有做的事（边界）

```text
✗ 没有开始 WP3（没有碰真实库、没有 apply、没有回填、没有进 Phase 4）
✗ 没有改 ADR-042 的正文 / Decision / Revision / Design Freeze 状态（只追加勘误一节）
✗ 没有改 D01 立案文书的 severity / status（仍是 P1 · OPEN）
✗ 没有改 §3 批次表（只**新增** §3.1 登记"实际插入"）
✗ 没有锁 v7 指纹（K-8 保持 OPEN）
✗ 没有在仓库目录里做任何注入式负控（全部在临时目录）
```
