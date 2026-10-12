# WP3 Handoff — Legacy Attribution Backfill（production-copy only）

> ## 状态
>
> ```text
> K-21                            = CLOSED
> WP3 backfill on production-copy = PASS
> M1–M7                           = PASS
> Replay                          = PASS
> Impact report                   = PRODUCED
> ```
>
> **源 `data/pglite` 未被修改**（应用代码从未打开它；复制前后 boundary 指纹一致；
> 门外复测文件数/字节/mtime 逐字段一致）。**WP4 = NOT STARTED。**
>
> 下次 execution **先读这份**，再读
> [`WP2.4-Handoff.md`](./WP2.4-Handoff.md)（K-20 / K-8）、
> [`M5.1.1-Execution-Plan.md`](./M5.1.1-Execution-Plan.md) **R-19**、
> [`M5.1.1-Phase4-Cognitive-Impact-Radius.md`](./M5.1.1-Phase4-Cognitive-Impact-Radius.md)。
> **不要重新探索仓库。**

```text
Completed WP: WP3 — Legacy Attribution Backfill（**只在 production-copy 上**）
  AT-0 K-21 = CLOSED（两侧统一 ALLOWED_UNKNOWN / U；已登记冲突表清空；N ⟺ ABSENT 全局成立）
  AT-1 copy prepared（源只读；副本 v6 → 应用冻结的 MIGRATION_0007 → v7）
  AT-2 before-image 已留（28 行；manifestHash 1cbbedc1…；**不含正文**）
  AT-3/AT-4 回填 + Axis B（28 行；只在副本）
  AT-5 M1–M7 全 PASS   AT-6 Replay 幂等 PASS   AT-7 影响半径报告 PRODUCED

Changed Files:
  src/kernel/contracts/attribution.ts                    （改：AT-0 两侧同步 —— system_event.contentOriginator → U / ALLOWED_UNKNOWN）
  scripts/verify-m5.1.1-k20-anti-fabrication.ts          （改：**删除**已登记冲突豁免；新增 AT-0 七条锁定规则断言）
  scripts/verify-m5.1.1-wp3-backfill.ts                  （新增：WP3 门，AT-0…AT-7 全链）
  package.json                                           （改：+ m5.1.1:wp3:verify）
  docs/m5.1.1/M5.1.1-Proposed-Schema.md                  （改：§3 system_event.contentOriginator `—` → `?`）
  docs/m5.1.1/M5.1.1-Migration-Strategy.md               （改：§3.2 表 + 逐条依据 → U）
  docs/m5.1.1/M5.1.1-Execution-Plan.md                   （改：R-18 追加 K-21 关闭注记；新增 R-19）
  docs/m5.1.1/M5.1.1-Phase4-Cognitive-Impact-Radius.md   （新增：AT-7 报告，**由实测数据自动生成**）
  docs/m5.1.1/WP3-Handoff.md                             （本文件）
  artifacts/m5.1.1/wp3-*.{json,txt,log}                  （新增：8 条门逐字 stdout + 结构化证据 + before-image）

Tests Run（全部 exit 0；见 wp3-gate-exits.txt）:
  pnpm typecheck                  → 0
  pnpm kernel:test                → 0（**26 / 0**）
  pnpm kernel:test:conversation   → 0（**47 / 0**）
  pnpm m5.1.1:test                → 0（**42 / 0**）
  pnpm m5.1.1:migration:verify    → 0（**79 / 0**）
  pnpm m5.1.1:k20:verify          → 0（**30 / 0**；含"冲突 = 0"与"`N ⟺ ABSENT` 全局成立"）
  pnpm m5.1.1:wp3:verify          → 0（**36 / 0**；M1–M7 + Replay 全绿）
  pnpm m5.1:measurement:verify    → 0（**16 / 0**；AGENTS §5 对新 `verify-*.ts` 的要求）

Tests Passed: 26/26 · 47/47 · 42/42 · 79/79 · 30/30 · 36/36 · 16/16；8 条命令全 exit 0
Tests Failed: 0
Tests Not Run:
  · **真实库** data/pglite 的任何 apply / update（本 WP 明令不做：READ/COPY BOUNDARY ONLY）
  · Phase 4 / ADR-043 的任何实现（BLOCKED BY ADR-043，仍 NOT APPROVED）
  · WP4（未开始）· m4.5:ci 全量回归（WP10 的项）

Evidence Produced:
  artifacts/m5.1.1/wp3-backfill.json        —— AT-0…AT-7 的完整机读事实
  artifacts/m5.1.1/wp3-before-image.json    —— 逐行 before-image（**不含正文**；含回填前全部槽位）
  artifacts/m5.1.1/wp3-verify.log           —— WP3 门逐字 stdout
  artifacts/m5.1.1/wp3-gate-exits.txt + wp3-*.log —— 退出码 + 8 条命令逐字 stdout
  artifacts/m5.1.1/wp3-restore-whitelist.txt —— 还原白名单 + fork 说明 + 源库前后测量
  docs/m5.1.1/M5.1.1-Phase4-Cognitive-Impact-Radius.md —— AT-7 报告

Commit Hash: 5026bc09ff490e83b2837937e67649a9b2310428   （feat：AT-0…AT-7 实现 + 全部证据）
             （docs：R-19 + 影响半径报告 + 本文件 = 紧随其后的一个提交）
```

---------------------------------------------------------------------------
 AT-0 — K-21 synchronization（**先做，且证明它绿了才开始回填**）
---------------------------------------------------------------------------
```text
目标口径（用户钉死）：
  system_event.contentOriginator  → necessity = ALLOWED_UNKNOWN（`?`）· legacy classification = U
  理由：actor_id **不得**当作"这段内容是谁提供的"的充分证据
        （系统事件里的 actor_id 常是组件名：它说明"谁自发了这条事件"，不说明"内容来源"）
  历史值：一律 Unknown(LEGACY_UNRECORDED)

四处同步（恰好这几处）：
  ① Proposed-Schema §3 矩阵：`—` → `?`
  ② Migration-Strategy §3.2 表 + 逐条依据：`P` → `U`（含理由）
  ③ 共享分类：CONVERSATION_BACKFILL_CLASSIFICATION.system_event.contentOriginator = 'U'
               NECESSITY_MATRIX.system_event.contentOriginator = 'ALLOWED_UNKNOWN'
  ④ K-20 门：**删除**已登记冲突豁免

要求的证明（实测，机读）：
  ✅ 「已登记的跨文档冲突表 = **0 条**」
  ✅ 「`N ⟺ ABSENT` **全局**成立（零不一致、零豁免）」
  ✅ AT-0 七条锁定规则与矩阵逐字一致
  ✅ AT-0 额外：内容来源的 P 证据规则（`actor_id` 非空）**永不适用于** system_event.contentOriginator
     —— 因为它已经是 U（锁定规则断言已覆盖）
```

---------------------------------------------------------------------------
 AT-1 / AT-2 — 副本准备与 before-image
---------------------------------------------------------------------------
```text
AT-1（源：READ/COPY ONLY）
  静默确认：连续两次采样指纹一致（3000ms 窗口）
  源：1201 文件 / 31,289,946 字节；boundary 指纹（(相对路径,大小) 排序后 sha256）
  cpSync → 副本；复制后源指纹**未变**；副本文件数/字节与源一致
  只开副本（PGLITE_DATA_DIR / PROJECT_LG_SANDBOX 都指向副本）
  副本 apply 前 schemaVersion = **6**；待应用迁移 = [7]
  **apply 前核对 K-8 冻结指纹**：MIGRATION_0007 的 sha256 与锁定值逐字一致
  显式 apply → 副本 schemaVersion = **7**（applied = [7]）

AT-2（before-image；**不含正文**）
  28 行；列 = id / sequence / type / actor_type / 旧 source_kind / 旧 source_authority /
                旧 epistemic_source + **回填前全部 6 个槽位**
  event family 分布：user_message 14 · assistant_message 14（本副本**没有** tool_event / system_event 行）
  manifestHash = 1cbbedc1c6dcfe9a53f2754f3af40f3dbd63fe707f3144e8c8c4585140e2f164
    —— 与 WP2.2 的 before-image **同一个哈希**（跨 WP 一致性，不是巧合：同样的算法、同样的行）
  character_action_events 行数 = 0（**本 WP 不触碰**该表，见下"边界决策"）
```

---------------------------------------------------------------------------
 AT-3 / AT-4 — 回填与 Axis B（**只在副本**）
---------------------------------------------------------------------------
```text
逐行按 D/P/U/N 写槽位（28/28 行被回填）：
  N → Absent ｜ U → Unknown(LEGACY_UNRECORDED) ｜ D → 有确定性证据则 Known，否则 Absent（不编造）
  P → 有独立行级证据（actor_id 非空）则 Known(SYSTEM/<actor_id>)，否则 Unknown(LEGACY_UNRECORDED)
Axis B（AT-4）：
  source_kind      = legacy classifier 输出（actor_type 全函数：user→user_statement / character→character_output /
                     system→system_instruction / tool→tool_output）
  source_authority = epistemic_source = 'UNCONFIRMED_ORIGIN'
  attribution_origin = 'MIGRATED_LEGACY'
  旧值全部保存在 before-image 里（本回填**覆盖**了副本上的 actor_type 推导值 —— 这正是 AT-4 允许的）
没有改：MemoryAuthority / Recall / eligibility / extractor / Fact Firewall / ADR-043 / Phase 4
```

**边界决策（写下来，免得被当成"顺手"）**：

```text
① recorded_by 分类 = D，但文档**没有把确定性值钉成某个具体 principal**
   （只说"结构性事实：只有 kernel 写入器能写这些表"）⇒ 本回填**不给它编一个值**，
   留 Absent，并把"没有可计算确定性证据的 D 槽位"如实计数（分类规则允许 D 槽位 Absent：
   "还没回填 ≠ 编造"）。
② character_action_events **不在本次范围**：§3.6 的 Axis B 规则只针对 conversation_events，
   而 `axis_b_complete` 约束要求"声明了 origin 就必须三列齐"—— 若无冻结规则就给它标
   MIGRATED_LEGACY，等于**发明**一条 source_kind 映射。该表本副本 0 行；即使有行也**不动**。
```

---------------------------------------------------------------------------
 AT-5 — M1–M7（全部 PASS）
---------------------------------------------------------------------------
```text
M1 迁移只追加：v7 语句里没有 drop/truncate/delete/update                       ✅
M2 回填分类正确：逐 (family × slot) 168 格与冻结矩阵一致（0 不一致）             ✅
M3 逐槽位 Unknown(LEGACY_UNRECORDED) 计数**精确相等**                           ✅
     initiator 0=0 · actor 14=14 · executor 0=0 · authority 0=0 ·
     recorded_by 0=0 · content_originator 28=28
     （并自检"至少一个槽位期望计数 > 0"，避免 0=0 的空转）
M4 反伪造六项计数全为 0                                                         ✅
     D 证据不一致 0 · P 无证据却 Known 0 · U 具体 Known 0 · N 非 Absent 0 ·
     <slot>_kind LIKE 'UNKNOWN%' 0 · 混合 known/unknown 元组 0
     （另：contentOriginator = Known(USER/CHARACTER) 0）
M5 影响半径报告已产出（只读）                                                   ✅
M6 restore epoch：本次没有 restore ⇒ NOT_APPLICABLE（**不记假边界**）            ✅
M7 Axis B 完整性：MIGRATED_LEGACY 行 三列全非 NULL / 两列 = UNCONFIRMED_ORIGIN /
     source_kind ∈ 既有 4 值                                                     ✅
     ⚠️ M7 的 "RECORDED 行满足 epistemic 等式" 子判据：本副本 RECORDED 行 = **0**
        ⇒ 该子判据 measured_count = 0，**空集不适用，不算 PASS**（如实登记）
所有计数型检测器：16 个，无效 0（`measured_count > 0` 全部成立）
```

---------------------------------------------------------------------------
 AT-6 — Replay / Rebuild
---------------------------------------------------------------------------
```text
幂等：第二次跑同一回填后，**完整状态指纹**（origin + Axis B + 六个槽位）逐字节不变
     78acdd90e7179bbafd355172bd0dc419df5b1eed88d6c5f26c74546531ad8f79（两次相同）
三态保持：Known / Unknown / Absent 逐个保持；`MIGRATED_LEGACY` 也保持
没有从 actor_type 重新推导：28/28 行的记录值与 actor_type 推导值**不同**
      （记录 = UNCONFIRMED_ORIGIN；推导会是 USER_EXPLICIT / CHARACTER_GENERATION / …）
```

---------------------------------------------------------------------------
 AT-7 — Cognitive Impact Radius（READ ONLY；报告已产出）
---------------------------------------------------------------------------
**⚠️ 本 WP 在这里抓到并修正了自己的一个量具错误，如实登记**：

```text
第一版用 `USER_EXPLICIT` / `USER_REPLY_CONFIRMATION`（**SourceAuthority** 词表）
去过滤 `memory_records.authority`（**MemoryAuthority** 词表：EXPLICIT_USER_STATEMENT 等）
⇒ 量到 "受影响 = 0"，看起来"没有影响"。那是**量错了东西**（AGENTS §6.9 的同型事故），
不是事实。修正口径后：
   今天有资格 = canSupportExternalFact(该记忆根证据事件上【回填前】记录的 source_authority)
   Phase 4 后存活 = 该事件 contentOriginator 已确立（Known）
   半径 = 前者减后者
门内新增两条自检：MemoryAuthority 词表比对 + "不得出现 SourceAuthority 专属值"。
```

**修正后的实测读数**：

```text
证据链路（memory_records × memory_evidence_links）: 2（evidence_kind = conversation_event）
观测到的 memory authority（MemoryAuthority 词表）  : EXPLICIT_USER_STATEMENT
今天有资格（canSupportExternalFact = true）        : 2
Phase 4 假设下会失去外部事实资格的                : **2 / 2**
```

⇒ **影响半径不是 0**：这两条今天能支持外部事实的记忆，在"Phase 4 改为要求 contentOriginator
已确立"的假设下**都会失去**该资格。这正是 D01 想要的方向（"以用户身份提交"不再等价于"用户说的"）。
报告：[`M5.1.1-Phase4-Cognitive-Impact-Radius.md`](./M5.1.1-Phase4-Cognitive-Impact-Radius.md)（由实测数据自动生成）。

**边界**：本报告**不**主张 Phase 4 该不该做（ADR-043 仍 NOT APPROVED），也**没有**改
MemoryAuthority / Recall / eligibility / extractor / Fact Firewall。

---------------------------------------------------------------------------
 还原白名单（R-13 第②条 / AGENTS §7）
---------------------------------------------------------------------------
4 条历史证据被复跑重新生成，已逐个路径 `git checkout --` 还原：
`artifacts/m5.1/measurement-negative-controls.json`（冻结的 M5.1 证据）·
`artifacts/m5.1.1/wp2-schema.json` · `artifacts/m5.1.1/migration-preview.txt` ·
`artifacts/m5.1.1/wp2.4-k20-anti-fabrication.json`（WP2.4 证据；本次由 29 → **30 通过**）。

★ 后三条（含 K-20 的新读数）已 **fork** 成 WP3 自己的文件（**字节一致**）：
`wp3-migration-verify.json` · `wp3-migration-preview.txt` · `wp3-k20-anti-fabrication.json`。

Known Issues:
  K-21 【**CLOSED**】两侧统一 `ALLOWED_UNKNOWN / U`；已登记冲突表 = 0；`N ⟺ ABSENT` 全局成立。
  K-20 / K-8 / K-18 / K-19 / K-17 / K-16 / K-3 【CLOSED】（前序 WP）。
  K-7  【登记，留 WP10】`scripts/verify-m4-hardkill.ts:205` 的 `schemaVersion === 5` 已过期。
  K-9  【继续 DEFER】`contracts/index.ts` 的 re-export（等第一个真实消费者）。
  K-22 【**新登记**】`character_action_events` 的**历史回填口径未冻结**：§3.3 给了逐事件类型的
        D/P/U/N，但 §3.6 的 Axis B 规则只覆盖 `conversation_events` ⇒ 该表**没有**冻结的
        source_kind 规则。本 WP 因此**不动它**。需要时**先裁定** Axis B 口径再回填。
  K-23 【**新登记**】`recorded_by = D` 但**确定性值未钉死**（全文只说"结构性事实"）⇒
        本回填留 Absent（不算伪造）。若要把它变成 Known，需要先裁定"确定性证据 = 哪个 principal"。
  【待裁定】`WP3` 完成后是否要**真实库** apply v7 与真实库回填（本 WP 只做了副本）。

Architecture Deviations:
  D-1  **回填是个纯函数 + 一次 UPDATE**：`planRow()` 与写入解耦，所以 M2（分类正确）与
       AT-6（幂等）都能**复算**同一份计划，而不是"看写入日志".
  D-2  **D 槽位允许 Absent**（`recorded_by` 与"工具行 actor_id 为空"两种情形）：
       判据边界是"编造 ≠ 缺信息"。缺信息进 observation，不进 fabrication 计数。
  D-3  **character_action_events 不动**（见 K-22）：宁可少做，也不发明一条未冻结的映射。
  D-4  **影响半径报告由证据自动生成**（脚本写 MD），避免"报告与证据不一致"。
  D-5  **副本用完即删**（`M511_WP3_KEEP_COPY=1` 可保留用于排障）—— 副本是敏感数据的临时拷贝。
  D-6  M7 的 RECORDED 子判据在**空集**上如实标"不适用"，而不是"0 违规 = PASS"。

Do not modify（后续 WP 只消费）:
  · `MIGRATION_0007` 的任何语句（指纹已锁）· 0001–0006 的任何语句
  · ADR-042 正文 / Decision / Revision / Design Freeze 状态 · ADR-043（仍 NOT APPROVED）
  · MemoryAuthority / Fact Firewall / Recall 资格判据 / extractor
  · artifacts/{m5.1,m5,m4.5,m4-acceptance,m4.1}/**（还原只按白名单；fork 规则见上）
  · data/pglite（只有 src/main.ts 能开它；本 WP 连读都只走 cpSync 副本）

```text
Next WP Preconditions（WP4 — 并存记录 / 阶段 2）:
  1. 用户放行 WP4（本 WP 不自行开始）。
  2. 写入路径开始**同时**填槽位与 `actor_type`（不要求语义相等）；门 = `actor_type` 必须与
     event family 一致。**仍不改变 Fact Firewall 输入**。
  3. 若要让回填进入**真实库**，需要单独的放行 + 真实库 apply/回填的执行计划
     （本 WP 只覆盖 production-copy）。
  4. 交 WP4-Handoff（九字段）后 STOP。
```

---

## 本次**没有**做的事（边界）

```text
✗ 没有开始 WP4
✗ 没有修改源 data/pglite（应用代码从未打开；复制前后指纹一致；门外复测亦一致）
✗ 没有改 MemoryAuthority / Recall / eligibility / extractor / Fact Firewall
✗ 没有做 ADR-043 / Phase 4（ADR-043 仍 NOT APPROVED）
✗ 没有回填 character_action_events（K-22：Axis B 口径未冻结 ⇒ 不发明映射）
✗ 没有重写 WP1 / WP2 / WP2.2 / WP2.4 的历史证据（fork + 还原）
✗ 没有 WAL/日志里留正文：before-image 与所有证据都**不含消息正文**
```
