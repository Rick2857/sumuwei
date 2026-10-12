# WP3.1 Handoff — Recorder Attribution Closure

> ## 状态
>
> ```text
> K-23                     = CLOSED
> WP3.1 production-copy    = PASS
> WP4                      = READY / AUTHORIZED
> K-22                     = DEFERRED（阻塞 WP5 · 不阻塞 WP4）
> ```
>
> **源 `data/pglite` 未被修改**（READ/COPY ONLY；复制前后指纹一致；门外复测一致）。
> **WP4 未开始**（本 WP 只做 K-23 收口）。
>
> 下次 execution **先读这份**，再读
> [`WP3-Handoff.md`](./WP3-Handoff.md)、
> [`M5.1.1-Execution-Plan.md`](./M5.1.1-Execution-Plan.md) **R-20 / R-19**、
> [`M5.1.1-WP3.1-Compatible-Assertion-Record.md`](./M5.1.1-WP3.1-Compatible-Assertion-Record.md)。
> **不要重新探索仓库。**

```text
Completed WP: WP3.1 — Recorder Attribution Closure
  §1 K-23 = CLOSED（canonical ledger recorder 冻结为 Known(SYSTEM, "kernel")）
  §2 受信构造规则（recordedBy 不得由调用方提供）已落成契约规则 + 结构性证明
  §3 production-copy replay：fresh copy → apply 冻结 v7 → WP3 回填 + recordedBy = SYSTEM/kernel
  §4 三段式控制全绿（正控 / 5 个负控 / mutation / Absent / 恢复）
  §5 M2/M3/M4 重算：recordedBy Known 计数 28 = 适用行 28；Absent = 0
  §6 K-22 只登记，未触碰 character_action_events

Changed Files:
  src/kernel/contracts/attribution.ts                  （改：CANONICAL_LEDGER_RECORDER / TRUSTED_LEDGER_WRITERS /
                                                        isCanonicalRecorder + MIGRATED_LEGACY 行的 recorder 判据与理由码）
  scripts/kernel-tests-m5.1.1.ts                        （改：夹具 id + 正控 recordedBy + 新增 5 个负控/1 个正控；**条数仍 42**）
  scripts/verify-m5.1.1-wp3-backfill.ts                 （改：recordedBy 确定性证据 + 结构性证明 + AT-4b 三段式 + M3/M4(K-23) + replay 逐字校验）
  docs/m5.1.1/M5.1.1-Execution-Plan.md                  （改：新增 R-20；K-22 = DEFERRED 登记）
  docs/m5.1.1/M5.1.1-Migration-Strategy.md              （改：§3.2 recordedBy 依据 → canonical recorder + 受信构造规则）
  docs/m5.1.1/M5.1.1-WP3.1-Compatible-Assertion-Record.md （新增：F4 changed-assertion 记录）
  docs/m5.1.1/WP3.1-Handoff.md                          （本文件）
  artifacts/m5.1.1/wp3.1-*.{json,txt,log}               （新增：8 条门逐字 stdout + 结构化证据）

Tests Run（全部 exit 0；见 wp3.1-gate-exits.txt）:
  pnpm typecheck                  → 0
  pnpm kernel:test                → 0（**26 / 0**）
  pnpm kernel:test:conversation   → 0（**47 / 0**）
  pnpm m5.1.1:test                → 0（**42 / 0**；条数不变）
  pnpm m5.1.1:migration:verify    → 0（**79 / 0**）
  pnpm m5.1.1:k20:verify          → 0（**30 / 0**）
  pnpm m5.1.1:wp3:verify          → 0（**50 / 0**；M1–M7 + Replay + K-23 控制全绿）
  pnpm m5.1:measurement:verify    → 0（**16 / 0**；AGENTS §5）

Tests Passed: 26/26 · 47/47 · 42/42 · 79/79 · 30/30 · 50/50 · 16/16；8 条命令全 exit 0
Tests Failed: 0
Tests Not Run:
  · 真实库 data/pglite 的任何 apply/update（READ/COPY ONLY）
  · character_action_events 的 Axis B 回填（**K-22 = DEFERRED**，本 WP 明令不碰）
  · WP4（未开始）· Phase 4 / ADR-043（仍 NOT APPROVED）

Evidence Produced:
  artifacts/m5.1.1/wp3.1-backfill.json        —— AT-0…AT-7 + **k23 段**（计数 / 控制 / 结构性证明）+ k22 登记
  artifacts/m5.1.1/wp3.1-before-image.json    —— 逐行 before-image（**不含正文**）
  artifacts/m5.1.1/wp3.1-verify.log           —— WP3.1 门逐字 stdout
  artifacts/m5.1.1/wp3.1-gate-exits.txt + wp3.1-*.log —— 退出码 + 8 条命令逐字 stdout
  artifacts/m5.1.1/wp3.1-restore-whitelist.txt —— 还原白名单 + fork 说明 + 源库前后测量

Commit Hash: 2a46d02f2a3737fa422ac9556fc764d0293832f1   （feat：契约 + 门 + 证据）
             （docs：R-20 + changed-assertion 记录 + 本文件 = 紧随其后的一个提交）
```

---------------------------------------------------------------------------
 §1 — K-23 冻结
---------------------------------------------------------------------------
```text
canonical historical recorder:
  Known(PrincipalKind.SYSTEM, "kernel")
含义（**仅此**）：权威 kernel 账本写入器**物理写下了这一行**。
它**不**说明、也**不得**推出：actor · initiator · contentOriginator · executor
（"谁写下了这一行"与"这一行讲的是谁做的"是两件事；一个推另一个正是 M5.1-D01 的病根。）

落地（契约，`src/kernel/contracts/attribution.ts`）：
  CANONICAL_LEDGER_RECORDER = { kind: 'SYSTEM', id: 'kernel' }
  CANONICAL_LEDGER_RECORDER_SOURCE（出处常量）
  TRUSTED_LEDGER_WRITERS = [{ writerId: 'kernel-ledger-writer', principal: SYSTEM/kernel }]
  isCanonicalRecorder(value)
理由码：`migrated_legacy_recorder_not_canonical`
  —— 回填行的 recordedBy 若不是**恰好** canonical ⇒ 违规；
     **`Absent` 也算违规**（适用行缺 recorder = **迁移完整性失败**，不是"还没填"）

登记：K-23 = CLOSED · R-20 = Canonical Ledger Recorder Principal（见 Execution-Plan）
```

---------------------------------------------------------------------------
 §2 — 受信构造规则
---------------------------------------------------------------------------
```text
"recordedBy MUST NOT be caller supplied" 的**可执行形式**（两条结构性证明，只查代码不查注释）：
  ① 全 src **恰好一个**文件会 `insert into conversation_events` → src/infrastructure/persistence/conversation-store.ts
     ⇒ 每一行历史上都是这个写入器写下的 ⇒ recordedBy 的确定性证据**不依赖行上任何字段**
  ② `recordedBy` 除 `contracts/attribution.ts` 外**零出现**（`filesMentioningRecordedByOutsideContract = []`）
     ⇒ 写路径**没有任何地方**能由调用方提供它（今天它根本不参与写入；它是回填期的位次）

将来的写入器：必须**显式登记**进 `TRUSTED_LEDGER_WRITERS` 才能拥有 recorder 位次 ——
**不要**为了"看起来更通用"就顺手发明 `SERVICE/*`。

⚠️ 第一版这两条证明是**假阳性**：正则把 `attribution.ts` 里**我自己写的说明**
（"全 src 里只有 conversation-store.ts 会 `insert into conversation_events`"）也算成了写入者。
已改成 `codeOnly()`（剥注释）—— 与 `kernel-tests-m5.1.1.ts` 同一个坑、同一个解法。
```

---------------------------------------------------------------------------
 §3 / §4 — production-copy replay 与三段式控制
---------------------------------------------------------------------------
```text
§3  fresh copy ← 源（静默确认 → 指纹/文件数/字节 → cpSync → 复核源未变）
    只开副本；apply 前 schemaVersion = 6、待应用 = [7]、**K-8 指纹核对一致**
    显式 apply 冻结的 MIGRATION_0007 → 副本 v7
    跑 WP3 的同一套回填，**外加**：conversation_events.recordedBy = Known(SYSTEM/kernel)
       （对**每一行**——因为唯一写入者就是 kernel；见 §2 的证明①）
    before-image 仍是权威迁移证据（逐行旧值，**不含正文**）
    源 data/pglite：READ/COPY ONLY（证据里 `openedByApplicationCode = false`、复制前后指纹 identical）

§4  三段式（全部实测，机读在 wp3.1-backfill.json 的 k23.controls）：
    正控   ：kernel 写下的历史行 → SYSTEM/kernel ⇒ 检测器**安静**（0 违规 / 28 行）
    负控×5 ：USER/kernel · CHARACTER/kernel · TOOL/kernel · SERVICE/kernel ·
             mutation（SYSTEM/kernel → SYSTEM/not-the-kernel）⇒ **每一次都必响**
    负控×1 ：适用行的 recordedBy **缺失（Absent）** ⇒ 必响（迁移完整性失败）
    恢复   ：改回 SYSTEM/kernel ⇒ 检测器**重新安静**
```

---------------------------------------------------------------------------
 §5 — M2/M3/M4 重算（全部 PASS）
---------------------------------------------------------------------------
```text
M2 逐 (family × slot) 168 格与冻结矩阵一致                                      ✅ 0 不一致
M3 逐槽位 Unknown(LEGACY_UNRECORDED) 精确相等                                   ✅
     initiator 0=0 · actor 14=14 · executor 0=0 · authority 0=0 ·
     recorded_by 0=0 · content_originator 28=28
M3(K-23) D `recordedBy` 的 **Known 计数精确等于**适用回填行数                    ✅ 28 vs 28
M4 六项反伪造计数全 0                                                            ✅
M4(K-23) recordedBy 等于 canonical recorder 的行数 = 适用行数                    ✅ 28 vs 28
M4(K-23) 适用行 recordedBy **Absent = 0**（缺它 = 迁移完整性失败）                ✅ 0
M5 影响半径报告已产出（只读；2 条链路，Phase-4 假设下会失去资格 2 条）           ✅
M6 restore epoch = NOT_APPLICABLE（本次没有 restore，不记假边界）                ✅
M7 Axis B 完整性（三列非 NULL / 两列 = UNCONFIRMED_ORIGIN / source_kind ∈ 4 值）  ✅
     ⚠️ M7 的 RECORDED 子判据仍为**空集不适用**（本副本 RECORDED 行 = 0）
AT-6 Replay：完整状态指纹两次相同（幂等）；三态逐个保持；
     **K-23：replay 逐字保住 SYSTEM/kernel**（0 行被改写）                        ✅
计数型检测器：**21 个，无效 0**
```

---------------------------------------------------------------------------
 §6 — K-22 边界（只登记，不触碰）
---------------------------------------------------------------------------
```text
K-22 = DEFERRED
  topic : character_action_events 的 Axis B 历史回填口径（§3.6 只覆盖 conversation_events）
  blocksWp5 : **true**
  blocksWp4 : **false**
本 WP **没有**触碰 `character_action_events` 的 Axis B（该表本副本 0 行；即使有行也不动）。
理由同 WP3：没有冻结的 source_kind 规则就给它标 MIGRATED_LEGACY = **发明**一条映射。
```

Known Issues:
  K-23 【**CLOSED**】canonical recorder 冻结；三段式全绿；计数 28/28；Absent = 0。
  K-22 【**DEFERRED**】见 §6：**阻塞 WP5**、不阻塞 WP4。
  K-21 / K-20 / K-8 / K-19 / K-18 / K-17 / K-16 / K-3 【CLOSED】（前序 WP）。
  K-7  【登记，留 WP10】`scripts/verify-m4-hardkill.ts:205` 的 `schemaVersion === 5` 已过期。
  K-9  【继续 DEFER】`contracts/index.ts` 的 re-export（等第一个真实消费者）。
  【待裁定】真实库是否也要 apply v7 + 回填（本系列只覆盖 production-copy）。

Architecture Deviations:
  D-1  **recorder 位次是"可判定"的**：它的确定性证据不依赖行上任何字段（唯一写入者 + 无调用方入口）
       ⇒ 契约层就能判，不必等库级门；`Absent` 也因此是**违规**而不是"还没填"。
  D-2  **一个不推另一个**：recorder 判据只谈"谁写下了这一行"，对 actor/initiator/
       contentOriginator/executor 一个字都不说（写进常量文档与理由码 detail）。
  D-3  结构性证明**只查代码不查注释**（`codeOnly()`）—— 第一版的假阳性就是被注释骗了。
  D-4  测试**条数保持 42**（改夹具 + 改一条正控 + 加负控组）⇒ 冻结的 WP1 证据不失真；
       changed assertion 单独记录（F4 第①条）。
  D-5  WP3.1 的**门沿用** `m5.1.1:wp3:verify`（不另起命令）：任务书 §3 要求"run the existing
       WP3 legacy backfill **plus** recordedBy"，所以扩展同一个门、证据 fork 成 `wp3.1-*`。

Do not modify（后续 WP 只消费）:
  · MIGRATION_0007 的任何语句（指纹已锁）· 0001–0006 的任何语句
  · ADR-042 正文 / Decision / Revision / Design Freeze · ADR-043（仍 NOT APPROVED）
  · MemoryAuthority / Fact Firewall / Recall 资格判据 / extractor
  · artifacts/{m5.1,m5,m4.5,m4-acceptance,m4.1}/**（还原只按白名单；fork 规则见上）
  · data/pglite（只有 src/main.ts 能开它）

Next WP Preconditions（WP4 — 并存记录 / 阶段 2）:
```text
  1. **本 WP = PASS ⇒ WP4 = READY / AUTHORIZED**（任务书 §7）。但"授权"不等于"已开始"：
     本 execution 到 STOP 为止，**没有**开始 WP4。
  2. WP4 的形态（冻结在计划里）：写入路径**同时**填槽位与 `actor_type`，**不要求语义相等**；
     门 = `actor_type` 必须与 event family 一致；**仍不改变 Fact Firewall 输入**。
  3. **K-22 不阻塞 WP4**；但 WP5 之前必须裁定它。
  4. 交 WP4-Handoff（九字段）后 STOP。
```

---

## 本次**没有**做的事

```text
✗ 没有开始 WP4
✗ 没有修改源 data/pglite（READ/COPY ONLY；复制前后指纹一致；门外复测一致）
✗ 没有触碰 character_action_events 的 Axis B（K-22 = DEFERRED）
✗ 没有改 MemoryAuthority / Fact Firewall / Recall / eligibility / extractor
✗ 没有做 ADR-043 / Phase 4
✗ 没有重写 WP1 / WP2 / WP2.4 / WP3 的历史证据（fork + 还原）
✗ 证据与 before-image 里**没有**消息正文
```
