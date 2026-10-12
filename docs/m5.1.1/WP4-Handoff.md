# WP4 Handoff — Trusted Attribution Construction / Coexist Recording

> ## 状态（**必须按字面读**）
>
> ```text
> WP4 = **PASS**（step 1/3 契约层 + step 1/3b K-25 + step 2/3 写路径接线 + step 3/3-fix 读路径 + 专项门）
>   · WP4 专项门（pnpm m5.1.1:wp4:verify）         = **PASS（48 通过 / 0 失败）**
>   · 六个真实读写场景（逐槽位 写=库=读）           = **PASS（6/6）**
>   · D01 回归硬断言（任何 USER 替换 = FAIL）       = **PASS（9/9）**
>   · attestation 正控 / 负控 / 恢复                = **PASS**
>   · legacy 回归（MIGRATED_LEGACY 不覆盖 RECORDED）= **PASS（正控 3 + 负控 1）**
>   · 回读等值（六个槽位 + Axis B + origin）         = **PASS**
>   · 八条必须继承的门                               = **PASS（全部 exit 0）**
>   · K-26（新发现并关闭的伪造入口）                 = **CLOSED**（见 R-23）
> ```
>
> **没有开始 WP5。没有做 K-22 物理落地。没有动真实库。没有改 `MIGRATION_0007`。**
> **没有碰 Fact Firewall / MemoryAuthority / extractor / Recall（AT-W4-9）。**
>
> ```text
> 上一版（本文件的历史内容）：
>   WP4 = PARTIAL；step 2/3 = PASS；step 3/3 = FAIL（9 通过 / 7 失败）
>   —— 失败的两个原因：① 读路径没有重建归因信封（AT-W4-8 读半边不成立）
>                     ② 专项门自己的序号分配把恢复用例的会话内序号吃掉了
> 本步（step 3/3-fix）只关闭这两个原因 + 一个由任务书 §7 的负控**实测暴露**的边界缺口（K-26）。
> ```
>
> 下次 execution **先读这份**，再读
> [`M5.1.1-Execution-Plan.md`](./M5.1.1-Execution-Plan.md) 的 **R-23 / R-24 / R-25**
> 与 WP4 小节末尾的闭包注记、`artifacts/m5.1.1/wp4-attestation.json`。
> **不要重新探索仓库。**

```text
Completed WP: WP4 — Trusted Attribution Construction / Coexist Recording（step 2/3 + step 3/3-fix）
  §1 RECORDED 读路径重建：六个槽位按 18 个物理列逐字解码（三态精确，不推断、不补默认值）
  §2 Axis B 逐字读存储值 + 复核 R-21 两个合法分支（拒绝而不改写）
  §3 legacy 兼容：MIGRATED_LEGACY / 无 origin 走既有读行为，**永不**覆盖 RECORDED
  §4 verifier 自己的序号分配修好：期望失败的负控不消耗恢复用例的会话内序号
  §5 六个真实场景：**逐槽位**证明 写入时 == DB 存储 == 立即回读
  §6 D01 回归 9 条硬断言（actor_type=user ∧ actor=SERVICE/agent ∧ contentOriginator=SERVICE/agent
     ∧ Axis B 成对 UNCONFIRMED ∧ origin=RECORDED；任何 USER 替换 = FAIL）
  §7 attestation 三段式：正控安静 / 四组负控必响 / 恢复安静（每个计数检测器 measured_count > 0）
  §8 K-26：把不透明性从"证据 token"扩展到"上下文本身"（冻结 + 运行期登记 + 写入路径拒绝）

Changed Files:
  src/kernel/contracts/attribution.ts        （改：+ decodeAttributionSlot(s) / AttributionSlotCells /
                                                isTrustedAttributionContext / 上下文冻结 + WeakSet 登记）
  src/kernel/contracts/conversation-event.ts （改：+ 未登记上下文拒绝 + 读路径文档）
  src/infrastructure/persistence/conversation-store.ts
                                             （改：rowToEvent 按 attribution_origin 拆两条路 + recordedAttributionOf）
  scripts/verify-m5.1.1-wp4-write-path.ts    （改：逐槽位三方等值 / D01 硬断言 / 三段式 / legacy 回归 / 序号审计）
  docs/m5.1.1/M5.1.1-Execution-Plan.md       （改：+ R-23 / R-24 / R-25 + WP4 闭包注记）
  docs/m5.1.1/WP4-Handoff.md                 （本文件）
  artifacts/m5.1.1/wp4-attestation.json      （新增：计划书登记的 WP4 证据名）
  artifacts/m5.1.1/wp4-write-path.json       （改：同一份内容，上一版执行用的续读名）
  artifacts/m5.1.1/wp4e-*.log · wp4e-gate-exits.txt · wp4e-restore-whitelist.txt
                                             （新增：八条门逐字 stdout + 退出码 + 还原白名单）

Tests Run（全部 exit 0；见 wp4e-gate-exits.txt）:
  pnpm typecheck                  → 0
  pnpm kernel:test                → 0（**26 / 0**）
  pnpm kernel:test:conversation   → 0（**47 / 0**）
  pnpm m5.1.1:test                → 0（**42 / 0**；条数不变，纯增量）
  pnpm m5.1.1:k25:verify          → 0（**22 / 0**；K-25 = PASS）
  pnpm m5.1.1:wp3.2:verify        → 0（**35 / 0**；confirmed 3 行 / unconfirmed 5 行）
  pnpm m5.1.1:wp4:verify          → 0（**48 / 0**；六场景 + D01 + 三段式 + legacy + 序号审计）
  pnpm m5.1:measurement:verify    → 0（**16 / 0**；AGENTS §5 对新 `verify-*.ts` 的要求）

Tests Passed: 26/26 · 47/47 · 42/42 · 22/22 · 35/35 · 48/48 · 16/16；8 条命令全 exit 0
Tests Failed: 0
Tests Not Run（**本步没有跑，理由明确**）:
  · pnpm m4.5:ci / m4.5:ci:full（约 10–15 分钟，且会重写 m4/m4.1/m4.5 历史证据；不在任务书 §8
    的清单里。本步只改 M5.1.1 的归因契约 / 读回路径与一个专项门，未触 Fact Firewall / extractor / Recall）
  · pnpm m5.1:gates / m5.1:regression:verify（它们读 m4.5:ci 的日志；本轮没有重跑 m4.5:ci）
  · 真实库 data/pglite 的任何 apply / update（本轮所有门都跑在 isolateDatabase() 沙箱上；
    data/pglite 的 mtime 仍停在 2026-09-17，未被动过）
  · WP5 / K-22 物理落地 · Phase 4 / ADR-043（仍 NOT APPROVED）· 里程碑标签（需要你批准）

Evidence Produced:
  artifacts/m5.1.1/wp4-attestation.json        —— WP4 专项门完整机读事实（六场景三方逐槽位读数 /
                                                  D01 db+readback / attestation 四组负控 / legacy 回归 /
                                                  sequenceAudit / 14 个计数检测器）
  artifacts/m5.1.1/wp4-write-path.json         —— 同一份内容（上一版执行用的名字，便于续读）
  artifacts/m5.1.1/wp4e-{typecheck,kernel-test,conversation,test,k25-verify,wp32-verify,wp4-verify,measurement-verify}.log
                                               —— 八条命令的逐字 stdout（UTF-8 无 BOM）
  artifacts/m5.1.1/wp4e-gate-exits.txt         —— 八条命令的退出码 + 结论行
  artifacts/m5.1.1/wp4e-restore-whitelist.txt  —— 还原白名单（三条历史证据的 before/after sha256）

Commit Hash:
  8881a50b0e16a35d16aa6ddacebf15b6add3c59e  （fix：读路径重建 + 受信上下文不透明化）
  5f40cbb                                    （test：WP4 专项门 + 证据）
  （docs：R-23/R-24/R-25 + 本文件 = 紧随其后的一个提交）
```

---------------------------------------------------------------------------
 WP4 verdict —— 逐条对照任务书 §9
---------------------------------------------------------------------------
```text
WP4 verifier = PASS                        ✅ pnpm m5.1.1:wp4:verify → 48/0，exit 0
all six real read/write scenarios = PASS   ✅ 逐槽位（state/kind/id/reason）+ Axis B 逐列，
                                              写入时 == DB == 立即回读，6/6
D01 regression = PASS                      ✅ 9 条硬断言；actor=SERVICE/agent 与
                                              contentOriginator=SERVICE/agent 原样落库并原样回读，
                                              任何 USER 替换都会红
attestation positive/negative/restore = PASS
                                           ✅ 正控安静；负控①caller 注入 ②不可信载荷字段
                                              ③构造后篡改 ④证据克隆 ⑤族不符 全部必响；
                                              恢复复用被拒号码后重新安静
legacy regression = PASS                   ✅ legacy store 行 / 迁移前旧行 / MIGRATED_LEGACY 行
                                              全部可读且不制造信封；RECORDED 行不被推导覆盖
readback equality = PASS                   ✅ 六个槽位 + origin + Axis B（confirmed / unconfirmed
                                              两个分支都走了一遍）
all required inherited gates = PASS        ✅ 八条命令全 exit 0（见 Tests Run）
⇒ **WP4 = PASS**（否则应为 PARTIAL / FAIL 并 STOP）
```

---------------------------------------------------------------------------
 §1–§3 读路径：两条互不覆盖的路（R-24）
---------------------------------------------------------------------------
```text
                      attribution_origin
                             │
        ┌────────────────────┴────────────────────┐
        │ 'RECORDED'                              │ 'MIGRATED_LEGACY' / NULL
        ▼                                         ▼
  权威路径（本步新增）                        legacy 兼容路径（逐字保留）
  · 六个槽位 ← 18 个物理列逐字解码            · row.X ?? deriveSourceForLegacyRow(actor_type).X
    （decodeAttributionSlots，三态精确）        · **不**制造 event.attribution
  · Axis B ← 存储值，复核 R-21 两分支          · **永不**覆盖 RECORDED（RECORDED 行不走这条路）
  · 落不进三态之一 ⇒ 拒绝（不猜、不补默认值）
  · Axis B 混合形态 / 列不齐 ⇒ 拒绝（不改写存储值）
```

关键实测（`wp4-attestation.json` 的 `scenarios[].slots`）：

| 场景 | actor / contentOriginator | Axis B | origin | 写=库=读 |
|---|---|---|---|---|
| ① 受信人类用户 | Known(USER/u-1) | confirmed（USER_EXPLICIT / user_report） | RECORDED | ✅ |
| ② **D01：agent 以 user 角色提交** | **Known(SERVICE/agent)** | **unconfirmed（成对 UNCONFIRMED_ORIGIN）** | RECORDED | ✅ |
| ③ assistant | Known(CHARACTER/char_sumuwei) | confirmed | RECORDED | ✅ |
| ④ system | Known(SYSTEM/event-ledger) | confirmed | RECORDED | ✅ |
| ⑤ tool | Known(TOOL/weather) | confirmed | RECORDED | ✅ |
| ⑥ runtime-unresolved | actor=Absent / originator=Unknown(RUNTIME_UNRESOLVED) | unconfirmed | RECORDED | ✅ |

---------------------------------------------------------------------------
 §4 序号审计：旧的空洞只在 harness（R-25）
---------------------------------------------------------------------------
```text
观测（wp4-attestation.json 的 sequenceAudit）:
  主链 conv_wp4 的会话内序号        = [1,2,3,4,5,6]（连续；负控一个号都没啃）
  负控会话 conv_wp4_neg             = [1,2]（正控 1 + 恢复 2；两次被拒尝试零残留）
  恢复复用被拒尝试用过的号码 2       = 成功（该号码从未被占用 ⇒ 从未被消耗）
  角色级序号（9 行）                = 严格单调且唯一
  分配了但没落行的角色级号          = 2，**恰好等于**"走到分配器后被拒的写入数" = 2

结论: 上一版那条 conversation_sequence_gap 是**执行脚本自己**把会话内序号 +1 造成的
      （9 > 7+1），生产侧没有持久化任何非法序号。

如实登记（不是缺陷，见 R-25）: appendConversationEvent 在 createConversationEvent 校验**之前**
调用 nextCharacterSequence ⇒ 一次"走到分配器后被拒"的写入会消耗一个**合法但未使用**的角色级序号。
分配器的契约只承诺单调 + 唯一（sequence.ts）；号码合法、无重复、无倒退、事件行不存在。
该顺序是 M2.5/M3 既有形状，本步**没有**改它（任务书 §4 只允许修 verifier 自己的分配）。
```

---------------------------------------------------------------------------
 §8 K-26：本次实测暴露并关闭的边界缺口（R-23）
---------------------------------------------------------------------------
```text
伪造的形状（正是 D01 的伪造本身）:
  actor             = Known(SERVICE/agent)        ← 说明这是服务提交的
  contentOriginator = Known(USER/u-1)             ← 却自称人类是内容作者
  recordedBy        = Known(USER/u-1)             ← 甚至自称是人类写下的这一行
  axisB             = user_statement + USER_EXPLICIT + user_report + confirmed
  family / presenterActorType / subject 全部对得上

实测: 该对象满足写入路径**其它每一条**判据 —— 包括 classifyRecordedAxisB 也判它是**合法的
      confirmed 分支**。K-25 的不透明性只加在**证据 token** 上，而上下文本身是普通对象 ⇒
      没有守卫时它会被当成权威归因落库（这正是 AT-W4-7 负控要防的事在真实 store 上不成立）。

关闭: buildTrustedAttributionContext() 的返回值 ① 冻结（Object.freeze，含 subject / 位次 /
      axisB / evidence），② 登记进模块内 WeakSet；createConversationEvent 对未登记的
      trustedAttribution 抛 untrusted_attribution_context。

门的证明: ① 注入被拒且库里零残留；② 全库扫描"actor=SERVICE 却 source_authority=USER_EXPLICIT"
         = 0 行（扫描范围自检 7 行 > 0）；③ 构造后篡改 contentOriginator ⇒ 抛且值不变。
```

---------------------------------------------------------------------------
 架构偏差 / 已知问题（如实登记）
---------------------------------------------------------------------------
```text
1. 本步新增了一个写入期拒绝条件（untrusted_attribution_context）。它不是"新语义"，
   而是把 R-22/K-25 已经声明的"证据不可伪造"补到**上下文**这一层 —— 没有这一层时，
   AT-W4-7 的负控（不可信调用方不得自报 contentOriginator）在**真实 store 上不成立**。
2. 读路径现在可能**抛**（recorded_axisb_missing / recorded_axisb_invalid /
   attribution_slot_shape_invalid / attribution_slot_value_invalid）。这是刻意的失败关闭：
   一条形状非法的 RECORDED 行要有人来看，而不是被静默改写成"看起来合理"的值。
   v7 的 CHECK（三态三分支 + 词表 + axis_b_complete）使这些形状在库里本不可能出现；
   本步没有新增任何"读会失败"的**合法**数据形状。
3. ADR-042 是 ACCEPTED / DESIGN FROZEN，本步**没有**改它（R-23/R-24/R-25 只进 Execution-Plan
   的修订记录）。若你认为 K-26 需要一条 ADR-042 addendum，请批准后再补（WP3.2 的 §13 先例）。
4. MIGRATED_LEGACY 行**不**暴露 event.attribution（槽位只在物理列上）。这是按任务书 §3
   "legacy / no-attribution → 兼容路径"的字面执行；若 WP6 需要读回填槽位，那属于 WP6 的改动。
5. K-22（character_action_events 的 Axis B 回填口径）仍 **DEFERRED**，**阻塞 WP5**；
   本步没有触碰该表，也没有开始 WP5。
6. Phase 4（切 Fact Firewall 输入）与 ADR-043 仍 **BLOCKED / NOT APPROVED**；
   canEvidenceExternalFact 的行为一字未改。
7. `artifacts/m5.1.1/{wp3.2-recorded-axisb.json, wp4-k25-trusted-attestation.json}` 与
   `artifacts/m5.1/measurement-negative-controls.json` 被继承门重新生成过 —— 已按
   **restore whitelist only** 还原，before/after sha256 见 wp4e-restore-whitelist.txt。
```

---------------------------------------------------------------------------
 Next WP Preconditions（**不要自行开始 WP5**）
---------------------------------------------------------------------------
```text
WP5（Action & Execution Attribution）的前置条件（等你的放行）:
  □ 本文件的字段表逐条满足（本轮全部满足）
  □ WP4 的 G-AT-4 三类负控"拒绝 / 覆盖 / 不可传入" —— **已由本步的负控①③④⑤证明**
  □ K-22（character_action_events Axis B 回填口径）**仍然 DEFERRED** ⇒ WP5 的**物理落地**
    仍被它阻塞；**必须先有你对 K-22 的裁定**，不得顺手开始
  □ 不要合并 WP4 + WP5；一次 execution 只做一个 WP，做完即 STOP
```
