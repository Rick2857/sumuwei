# WP3.2 Handoff — RECORDED Axis-B Representability Closure

> ## 状态
>
> ```text
> K-24                          = CLOSED
> RECORDED confirmed gate       = PASS（3 行）
> RECORDED unconfirmed gate     = PASS（5 行）
> WP4                           = READY / AUTHORIZED
> ```
>
> **没有开始 WP4。** 没有动真实库、没有改 `MIGRATION_0007`、没有 schema 变更
> （v7 已冻结；本 WP **不需要** v8，见 §0 的判定）。
>
> 下次 execution **先读这份**，再读
> [`WP3.1-Handoff.md`](./WP3.1-Handoff.md)、
> [`M5.1.1-Execution-Plan.md`](./M5.1.1-Execution-Plan.md) **R-21**、
> [`M5.1.1-WP3.2-Compatible-Assertion-Record.md`](./M5.1.1-WP3.2-Compatible-Assertion-Record.md)、
> **ADR-042 §13**（窄幅 addendum）。
> **不要重新探索仓库。**

```text
Completed WP: WP3.2 — RECORDED Axis-B Representability Closure
  §1 K-24 = CLOSED（RECORDED Unconfirmed Axis-B Representability Gap）
  §2 R-21 = RECORDED Axis-B Confirmation Semantics（两分支冻结）
  §3 事件族分类（**不是** PrincipalKind → SourceKind）写进契约
  §4 合法用例 A–E 全部可表示并通过；5 条"不得自动推导"的负控全绿
  §5 两条混合形态必拒（库**接受**、检测器**必响** —— 证明它不是橡皮图章）
  §6 M7/RECORDED 两个分支各 `measured_count > 0`（3 / 5）
  §7 窄幅文档同步（含 ADR-042 §13；**不**重写 §4 / Decision）

Changed Files:
  src/kernel/contracts/source-authority.ts                （改：两分支语义 + 事件族分类 + 判据/断言函数）
  scripts/verify-m5.1.1-wp32-recorded-axisb.ts            （新增：K-24 门）
  scripts/kernel-tests-m5.1.1.ts                          （改：**一条静态锁的判据精炼**；**条数仍 42**）
  package.json                                            （改：+ m5.1.1:wp3.2:verify）
  docs/adr/ADR-042-attribution-model.md                   （改：**追加** §13 窄幅语义 addendum）
  docs/m5.1.1/M5.1.1-Proposed-Schema.md                   （改：§7 ⑩ → 两分支判据）
  docs/m5.1.1/M5.1.1-Test-and-Gate-Plan.md                （改：M7 的 RECORDED 子判据 → 两分支）
  docs/m5.1.1/M5.1.1-Migration-Strategy.md                （改：§3.6 写入期等式 → 只属 confirmed 分支）
  docs/m5.1.1/M5.1.1-Execution-Plan.md                    （改：新增 R-21）
  docs/m5.1.1/M5.1.1-WP3.2-Compatible-Assertion-Record.md （新增：F4 changed-assertion 记录）
  docs/m5.1.1/WP3.2-Handoff.md                            （本文件）
  artifacts/m5.1.1/wp3.2-*.{json,txt,log}                  （新增：9 条门逐字 stdout + 结构化证据）

Tests Run（全部 exit 0；见 wp3.2-gate-exits.txt）:
  pnpm typecheck                  → 0
  pnpm kernel:test                → 0（**26 / 0**）
  pnpm kernel:test:conversation   → 0（**47 / 0**）
  pnpm m5.1.1:test                → 0（**42 / 0**；条数不变）
  pnpm m5.1.1:migration:verify    → 0（**79 / 0**）
  pnpm m5.1.1:k20:verify          → 0（**30 / 0**）
  pnpm m5.1.1:wp3:verify          → 0（**50 / 0**）
  pnpm m5.1.1:wp3.2:verify        → 0（**35 / 0**；两个 RECORDED 分支全绿）
  pnpm m5.1:measurement:verify    → 0（**16 / 0**；AGENTS §5 对新 `verify-*.ts` 的要求）

Tests Passed: 26/26 · 47/47 · 42/42 · 79/79 · 30/30 · 50/50 · 35/35 · 16/16；9 条命令全 exit 0
Tests Failed: 0
Tests Not Run:
  · 真实库 data/pglite 的任何 apply/update（本 WP 的对象是**可表示性**，不是历史数据；门只用
    `isolateDatabase()` 沙箱）
  · WP4（未开始）· Phase 4 / ADR-043（仍 NOT APPROVED）

Evidence Produced:
  artifacts/m5.1.1/wp3.2-recorded-axisb.json  —— K-24 的完整机读事实（分支读数 / A–E / 负控 / schemaFeasibility）
  artifacts/m5.1.1/wp3.2-verify.log           —— K-24 门逐字 stdout
  artifacts/m5.1.1/wp3.2-gate-exits.txt + wp3.2-*.log —— 退出码 + 9 条命令逐字 stdout
  artifacts/m5.1.1/wp3.2-restore-whitelist.txt —— 还原白名单 + fork 说明

Commit Hash: d8bf6a793b981c030970474c7fd8d0fc191b383c   （feat：契约 + 门 + 证据）
             （docs：R-21 + changed-assertion 记录 + 本文件 = 紧随其后的一个提交）
```

---------------------------------------------------------------------------
 §0 — 要不要 STOP？（任务书 §8 的唯一 STOP 条件）
---------------------------------------------------------------------------
```text
§8：若需要改 schema 约束 ⇒ STOP（v7 已冻结，物理变更要 v8）。

**实测判定：不需要。**
  v7 对 conversation_events 的 Axis B 只有 **5 条** CHECK：
    source_kind_vocab · source_authority_vocab · epistemic_source_vocab ·
    attribution_origin_vocab · axis_b_complete
  ——**没有**任何 "epistemic_source 必须等于 epistemicSourceForKind(source_kind)" 的 CHECK。
  两个词表都含 `UNCONFIRMED_ORIGIN` ⇒ unconfirmed 分支**本来就写得进去**。
⇒ 没有触发 STOP；**没有**改 `MIGRATION_0007`、**没有**要 v8。
```

---------------------------------------------------------------------------
 §1 / §2 — 冻结语义（两分支）
---------------------------------------------------------------------------
```text
RECORDED 的含义（**仅此**）：attribution was recorded at event time。
它 **不** 意味着 epistemic source 已确立。

confirmed   ：source_authority ≠ UNCONFIRMED_ORIGIN
              ⇒ epistemic_source === epistemicSourceForKind(source_kind)
unconfirmed ：source_authority = epistemic_source = UNCONFIRMED_ORIGIN（**成对**；无外部事实资格）

必须拒的混合形态（两条）：
  · UNCONFIRMED source_authority + 非 UNCONFIRMED epistemic_source
  · 已确立 source_authority + UNCONFIRMED epistemic_source

落地：`classifyRecordedAxisB` / `assertRecordedAxisB`（失败关闭）
登记：K-24 = CLOSED · R-21 = RECORDED Axis-B Confirmation Semantics
```

---------------------------------------------------------------------------
 §3 — 事件族分类（**不是** PrincipalKind → SourceKind）
---------------------------------------------------------------------------
```text
SOURCE_KIND_BY_EVENT_FAMILY（族 → kind）：
  user_message → user_statement ／ assistant_message → character_output
  system_event → system_instruction ／ tool_event → tool_output

三条"不得自动推导"的负控（实测断言）：
  · SERVICE principal **不得**自动意味着 system_instruction（族函数不看 principal）
  · EXTERNAL_ACTOR **不得**推出任何 SourceKind
  · actor_type='user' **不得**自动意味着 USER_EXPLICIT（unconfirmed 分支对 user_message 合法）
契约里**没有**（并有静态断言守住）`sourceKindForPrincipalKind` 这类函数。
```

---------------------------------------------------------------------------
 §4 / §5 — 合法用例与负控
---------------------------------------------------------------------------
```text
§4 合法用例（全部**可插入 + 通过**：库接受、判据给对分支）
  A. user_message + contentOriginator=Known(USER/u)          + Axis B **confirmed**   ✅
  B. user_message + contentOriginator=Known(SERVICE/agent)   + Axis B **unconfirmed** ✅
  C. user_message + contentOriginator=Known(EXTERNAL_ACTOR/x)+ Axis B **unconfirmed** ✅
  D. user_message + contentOriginator=Unknown(RUNTIME_UNRESOLVED) + **unconfirmed**   ✅
  E. assistant_message（confirmed / unconfirmed）· system_event（confirmed）·
     tool_event（unconfirmed）                                                       ✅

§5 负控（**库接受、检测器必响** —— 证明检测器相对库不是橡皮图章）
  · UNCONFIRMED authority + 非 UNCONFIRMED epistemic        ⇒ 响 ✅（库接受）
  · 已确立 authority + UNCONFIRMED epistemic                ⇒ 响 ✅（库接受）
  · confirmed 分支但 epistemic 与该 kind 不匹配             ⇒ 响 ✅（库接受）
  · 失败关闭版本 `assertRecordedAxisB` 在非法输入上**真的抛** ✅
```

---------------------------------------------------------------------------
 §6 — M7 / RECORDED 两个分支都测得出来
---------------------------------------------------------------------------
```text
M7 RECORDED **confirmed**  = PASS（**3 行**，measured_count > 0）
M7 RECORDED **unconfirmed**= PASS（**5 行**，measured_count > 0）
M7 全部 RECORDED 行都落在两个合法分支之一 = 0 违规

⚠️ 第一版这里报出 3 条"违规"——那 3 条正是 §5 **我自己造的非法探针**。
   已改成"探针用完即删"，于是 M7 的"全部 RECORDED 行都合法"是**无豁免**的主张。
   （量具的**测量范围**又错了一次；这与 WP3.1 的"查了注释"同类。）
计数型检测器：**13 个，无效 0**
```

---------------------------------------------------------------------------
 §7 — 窄幅文档同步（**不**重写 ADR-042）
---------------------------------------------------------------------------
```text
只改了"声称所有 RECORDED 行都满足该等式"的那几处语义语句：
  · Proposed-Schema §7 ⑩            → 两分支判据
  · Test-and-Gate-Plan M7            → 两分支 + 都要 non-zero 测量
  · Migration-Strategy §3.6          → 该等式只属 confirmed 分支
  · **ADR-042 §13（新增，窄幅 addendum）**：不重写 §4、不改任何 Decision / Revision /
    Design Freeze 状态；只补一句 §4 隐含得过头的话 + 两分支的可执行判据 +
    "物理层不需要变更（故不触发 v8 的 STOP）"的实测依据。
```

Known Issues:
  K-24 【**CLOSED**】两分支语义冻结；A–E 可表示；5 条负控全响；两个分支均有非零测量。
  K-22 【**DEFERRED**】`character_action_events` 的 Axis B 口径未冻结；**阻塞 WP5**、不阻塞 WP4。
  K-23 / K-21 / K-20 / K-8 / K-19 / K-18 / K-17 / K-16 / K-3 【CLOSED】（前序 WP）。
  K-7  【登记，留 WP10】`scripts/verify-m4-hardkill.ts:205` 的 `schemaVersion === 5` 已过期。
  K-9  【继续 DEFER】`contracts/index.ts` 的 re-export（等第一个真实消费者）。
  【待裁定】真实库是否也要 apply v7 + 回填（本系列只覆盖 production-copy）。

Architecture Deviations:
  D-1  **`RECORDED` 被重新定义为"只是记录时机"**，不再隐含"认知来源已确立"——
       这是语义**加强**（unconfirmed 分支让"记下来了但来源未确立"**可表达**，
       而不是被逼着填一个确定 authority，那正是 D01 的病根）。
  D-2  **事件族分类进契约**（`SOURCE_KIND_BY_EVENT_FAMILY`），并静态禁止
       `PrincipalKind → SourceKind`。
  D-3  混合形态由**契约**判、不由 DB 判：v7 的约束只查词表 ⇒ 库会接受混合形态，
       检测器必须自己响（§5 把这一点作为**负控**测出来，而不是假设）。
  D-4  测试**条数保持 42**；changed assertion（一条静态锁的判据精炼）单独记录。
       顺带修掉一个**假阳性**：旧锁把合法的 `sourceAuthority` 当成了 `sourceAuthor`。
  D-5  ADR-042 只**追加** §13；§4 与全部 Decision 一字未改。

Do not modify（后续 WP 只消费）:
  · `MIGRATION_0007` 的任何语句（指纹已锁；**本 WP 没有**触发 v8）
  · ADR-042 正文 / Decision / Revision / Design Freeze（§13 是 addendum）
  · Fact Firewall / MemoryAuthority / extractor / Recall 资格判据
  · artifacts/{m5.1,m5,m4.5,m4-acceptance,m4.1}/**（还原只按白名单；fork 规则见上）
  · data/pglite（只有 src/main.ts 能开它）

Next WP Preconditions（WP4 — 并存记录 / 阶段 2）:
```text
  1. **本 WP = PASS ⇒ WP4 = READY / AUTHORIZED**（任务书 §9）。但本 execution 到 STOP 为止
     **没有**开始 WP4。
  2. WP4 的形态（计划里已冻结）：写入路径**同时**填槽位与 `actor_type`，**不要求语义相等**；
     门 = `actor_type` 必须与 event family 一致；**仍不改变 Fact Firewall 输入**。
     现在多了 R-21 这条：写入路径若要写 unconfirmed 的 RECORDED 行，
     **必须**用 `assertRecordedAxisB` 失败关闭（两列成对）。
  3. **K-22 不阻塞 WP4**；WP5 之前必须裁定它。
  4. 交 WP4-Handoff（九字段）后 STOP。
```

---

## 本次**没有**做的事

```text
✗ 没有开始 WP4
✗ 没有改 schema（**不需要** v8）· 没有改 MIGRATION_0007
✗ 没有动真实库（本门只用 isolateDatabase 沙箱）
✗ 没有改 Fact Firewall / MemoryAuthority / extractor / Recall
✗ 没有做 ADR-043 / Phase 4
✗ 没有重写 ADR-042 的 §4 或任何 Decision（只追加 §13）
✗ 没有重写 WP1 / WP2 / WP2.4 / WP3 / WP3.1 的历史证据（fork + 还原）
```
