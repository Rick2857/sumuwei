# WP9-C1 Handoff —— Final Runtime Requalification

**判定：`WP9-C1 = PASS`** · **`WP9 = PASS`** · **`WP10 = READY / AUTHORIZED`**（已放行，**未开始**）
**`State SYSTEM Attribution = RESOLVED`** · **`Canonical E4/S3 = PASS`（载体经 R-48 裁定）**
**后三项能力仍 `NOT IMPLEMENTED / DEFERRED`** · **`M5.1-D01` 的认知资格仍受 `ADR-043` / `Phase 4` 阻塞**

日期：2026-09-19 · 上游：`WP9-C0 = COMPLETE` · `WP9-B2 = PASS` · `WP9-B1 = PASS` · `WP9-A = PASS`
执行令：**用户 R-48** —— `Q1 = a` · `Q2 = NOT REQUIRED FOR C1` · 只授权 C1 的两件事 · 做完即 **STOP**

---

## R-8 八字段

| 字段 | 内容 |
|---|---|
| **Changed Files** | `scripts/verify-m5.1.1-wp9-runtime-e2e.ts`（+477/−32：E4 换载体 + E8 接生产 writer + 判定拆分 + 证据形状 + 两条新 NOTE）· `scripts/m5.1.1-attribution-gate-registry.ts`（**1 行**：`NON_VERIFIER_SCRIPTS` 里 wp9 的理由文本）· `scripts/verify-m5.1.1-k17-consumer-impact.ts`（**2 行**：wp9 条目的理由文本）· `docs/m5.1.1/M5.1.1-Execution-Plan.md`（追加 **R-48** 行）· `docs/m5.1.1/M5.1.1-WP9C1-Compatible-Assertion-Record.md`（**新增** F4）· `docs/m5.1.1/WP9C1-Handoff.md`（本文件）· `docs/m5.1.1/WP9-Handoff.md` 与 `M5.1.1-WP9-Compatible-Assertion-Record.md`（各加**指针附注**，正文不改）· 证据九份 `artifacts/m5.1.1/wp9-*`。**`src/**` 零改动** |
| **Tests Run** | 提交前：`typecheck` · `wp9:verify` · `k17:verify`。**提交后**（严格按 R-48 §C1-3 顺序）：`typecheck` → `wp9c0:verify` → `wp9b2:verify` → `wp9b1:verify` → `wp9a:verify` → **`wp9:verify`** → **`wp8c3:verify`**（干净树、单独跑）→ `wp8:verify` → `gates` → `k17:verify` → `k29:verify` → `wp8c1:verify` → `wp8c2:verify`；另加 `migration:verify` / `prod-copy:verify` / `m5.1:measurement:verify` 回归。见 §4 |
| **Tests Passed** | 提交前：`typecheck` 0 · **`wp9:verify` 57/0 · `WP9 = PASS`** · `k17:verify` 15/0。**提交后**见 §4 |
| **Tests Failed** | **0**。本 WP **没有**为了变绿而放宽任何断言 —— 详见 F4 的 C1-G1…C1-G15 与 §3 |
| **Evidence Produced** | `artifacts/m5.1.1/wp9-e2e.json`（执行计划冻结名的总证据：E1–E8 逐场景 + `deferredCapabilities` + `capabilityLedger` + 8 条 L1↔L2 关联）· `wp9-runtime-e2e.json`（同内容）· `wp9-level1-results.json` · `wp9-level2-ledger.json` · `wp9-correlations.json`（8 条）· `wp9-d01-k27.json` · `wp9-execution-truth.json` · `wp9-gate-exits.txt`（含 blocking / deferred / ledger 三段）· `wp9-restore-whitelist.txt` · F4：`M5.1.1-WP9C1-Compatible-Assertion-Record.md` |
| **Known Issues** | ① **三项能力仍是缺口**（`DC-1` Conversation SYSTEM Producer · `DC-2` System-origin Action · `DC-3` D01 后台任务）—— 它们**不是**现行 S3 的必要条件（R-48），但**不得**被改成 CLOSED。② `M5.1-D01` 的**认知资格**问题仍受 `ADR-043` / `Phase 4` 阻塞，本 WP 不改它的任何状态。③ `WP9` 门仍**不在** `M511-G2` 里（它的判定由 WP9 自己的验收清单/handoff 承担）；若要让它反映进 `m5.1.1:gates`，那是一次 WP8 注册表变更，需另行裁定。④ `wp7:preflight / AT-W7-0` 仍 `inherited`（历史作用域护栏）。⑤ `Generic trusted-envelope clone resistance` 仍 `OPEN / NOT PROVEN`（独立 WP）。⑥ `wp9c0-e4-boundary.ts` 的 `claimsNotEstablished` 保留为 **C0 时点**陈述（有意不改，见 F4 C1-G14）。 |
| **Architecture Deviations** | **无**。没有新 ADR；没有新 SYSTEM producer；没有调度器/后台子系统；`src/**` 一字未改；`MIGRATION_0009` / `INITIAL_STATE` / manual reset 语义未动；`DISCOVERY_NEEDLES` / `VERIFIERS` / `M511_GATES` / `wp8-mutations.json` 的 7 条锚一字未改；真实库未打开；冻结面零差异。 |
| **Commit Hash** | `bdc2fb2` — `docs(m5.1.1): record R-48 E4/S3 carrier decision and the WP9-C1 assertion record`（**Commit 0**，先于判据改动）· `32d35e0` — `test(m5.1.1): requalify WP9 E4 on the state bootstrap chain and E8 on the production audit writer` · `ee4e919` — `docs(m5.1.1): record WP9-C1 runtime evidence and handoff` · `0634c59` — `docs(m5.1.1): move the WP9-C1 pointer to the record tail so C0 line anchors stay intact`（真实引用漂移的修复，见 §4）· 提交后再鉴定读数与刷新后的门当前读数在 **Commit 4** |

---

## 1. 本 WP 只做两件事

> R-48 §5：**不建新的 SYSTEM producer**。只把 E4 接到真实 State Bootstrap 生产链、把 E8 接到
> WP9-A 的生产 audit writer 链；`E1–E3 / E5–E7` 的判据保持。

**C1 的实质是"改验收载体"，不是"放宽测试"**：
判据的形状（`Known` 正控 + 诚实 `Unknown` + 无证据伪造必拒 + L1/L2 用真实键 + 真实生产路径）
**一字未改**；变的只是**哪个权威账本**承载 E4。若没有 R-48，把"必须不可达"改成"必须可达"
就**是**放宽 —— 这一点已写进 F4 的 `C1-G6` / `C1-G11`。

---

## 2. E4（新载体）与 E8（生产 writer）的实测读数

### E4 —— 真实首次 State Bootstrap

```text
载体      : state_events（family = state_transition）—— 该行为本来就应该写入的权威账本
L1        : initCharacterState(runtime, characterId, <fresh user>, { bootstrapEvidence: 生产工厂产出的受信证据 })
            → created = true · stateEventId = <真实 uuid>
L2        : 物理行（trigger = init）+ readStateEventAttribution(runtime, 同一个 id)
六格      : initiator = KNOWN|SYSTEM|state-bootstrap|-
            actor     = KNOWN|SYSTEM|state-bootstrap|-
            executor  = ABSENT|-|-|-
            authority = KNOWN|SYSTEM_RULE|state-bootstrap-rule|-
            recordedBy= KNOWN|SYSTEM|kernel|-
            contentOriginator = ABSENT|-|-|-
origin    : RECORDED          subject : 派生 CHARACTER/<character_id>（不落列；user_id 留在行上）
诚实 Unknown 正控 : 普通 3 参调用 ⇒ initiator/actor/authority = UNKNOWN|-|-|RUNTIME_UNRESOLVED
身份伪造负控     : 浅拷贝 + 改 principal ⇒ untrusted_state_bootstrap_evidence，且 state_events 行数不变（2 → 2）
保留的历史读数   : DC-1（Conversation SYSTEM Producer = 0）—— 不删除，降级为 deferred 观察
```

### E8 —— 真实 HTTP → 真实 Control Service → 生产 audit writer → durable 行

```text
写入者    : createDeveloperControlAuditWriter({ db })（与 src/main.ts:2193 同一工厂；不传 developerIdentity）
L1        : 真实 HTTP POST RUN_DIAGNOSTIC ⇒ 200 · outcome = verified · executed = true · commandId = wp9-cmd-1
L2        : developer_control_events 里按 **同一个 commandId** 读回
六格      : initiator = UNKNOWN|-|-|RUNTIME_UNRESOLVED
            actor     = KNOWN|SERVICE|control-service|-
            executor  = ABSENT|-|-|-
            authority = KNOWN|CAPABILITY|developer.control|-
            recordedBy= KNOWN|SYSTEM|kernel|-
            contentOriginator = ABSENT|-|-|-
生命周期  : outcome / disposition / verification **逐字照抄**真实结果；transport = http（只观测）
失败路径  : 注入失败 handler ⇒ HTTP 200 attempted/failed ⇒ **仍有** durable 行且按 id 关联
负控      : 调用方自报 authority/initiator/executor ⇒ claims 不进行、槽位不变
不复用    : 本门**不读** wp9a-control-audit.json（R-48 §C1-2）
```

---

## 3. 判定语义（R-48 §4）

```text
blockingGaps          = []        ← 决定 PASS；E1–E8 全部可达时为空
deferredCapabilities  = [DC-1, DC-2, DC-3]   ← **不**决定判定，但**不得**改成 CLOSED

capabilityLedger（写进证据）
  State SYSTEM Attribution        = RESOLVED
  Canonical E4/S3                 = PASS
  Conversation SYSTEM Producer    = NOT IMPLEMENTED / DEFERRED
  System-origin Action            = NOT IMPLEMENTED / DEFERRED
  D01 原始后台任务能力             = NOT IMPLEMENTED / DEFERRED
```

**过程内没有放宽任何断言**：本门第一版**一次跑通**（57/0）。唯一被改的既有断言是
`WP9-16` / `WP9-18` 之外的**读数升降级**（`C1-G6`），以及两处**理由文本**（`C1-G12` / `C1-G13`）。

---

## 4. 提交后串行重跑 —— 实测读数

按 R-48 §C1-3 的**门集合**（顺序按"`wp8c3` 必须在干净树上单独执行"这一硬约束调整：
实际 `wp8c3` 最先 —— 任何跑过的门都会把被跟踪的 artifacts 写脏）：

| # | 门 | EXIT | 读数 |
|---|---|---|---|
| 1 | `pnpm typecheck` | **0** | |
| 2 | **`pnpm m5.1.1:wp8c3:verify`**（Hard Gate，干净树、最先单独跑） | **0** | 40 通过 / 0 失败 · `WP8-C3 = PASS` → `WP8 = PASS` · C3-0 干净树 ✅（**无**清洁度例外） |
| 3 | **`pnpm m5.1.1:wp8:verify`**（Hard Gate） | **0** | 53 通过 / 0 失败 · `WP8-B = PASS` · `unclassifiedVerifier = 0` · `unexpectedWrites = 0` |
| 4 | `pnpm m5.1.1:gates` | **0** | `G1–G7 PASS · G8 = NOT RUN · G9 PASS` |
| 5 | **`pnpm m5.1.1:wp9:verify`** ★ | **0** | ★★ **57 通过 / 0 失败 · `WP9 = PASS`** ★★ · `blocking gaps = (无)` · `measurementInvalid = 0` |
| 6 | `pnpm m5.1.1:wp9c0:verify` | **0** | 43 通过 / 0 失败 · `WP9-C0 = COMPLETE` |
| 7 | `pnpm m5.1.1:wp9b2:verify` | **0** | 42 通过 / 0 失败 · `WP9-B2 = PASS` |
| 8 | `pnpm m5.1.1:wp9b1:verify` | **0** | 56 通过 / 0 失败 |
| 9 | `pnpm m5.1.1:wp9a:verify` | **0** | 31 通过 / 0 失败 · `WP9-A = PASS` |
| 10 | `pnpm m5.1.1:k17:verify` | **0** | 15 通过 / 0 失败 · `K-17 = PASS` |
| 11 | `pnpm m5.1.1:k29:verify` | **0** | 41 通过 / 0 失败 |
| 12 | `pnpm m5.1.1:wp8c1:verify` | **0** | 15 通过 / 0 失败 · `K-32 = PASS` |
| 13 | `pnpm m5.1.1:wp8c2:verify` | **0** | 25 通过 / 0 失败 · `K-33 = PASS` |
| 14 | `pnpm m5.1.1:migration:verify` | **0** | 117 通过 / 0 失败 |
| 15 | `pnpm m5.1.1:prod-copy:verify` | **0** | 36 通过 / 0 失败 |
| 16 | `pnpm m5.1.1:measurement:verify` | **0** | 16 通过 / 0 失败 |

```text
⇒ WP9-C1 = PASS · WP9 = PASS · WP10 = READY / AUTHORIZED（已放行，**未开始**）
```

**过程内抓到一处真实引用漂移（如实登记）**：第一次提交后跑全量时 `wp9c0:verify` = EXIT 1 · 37/6。
归属：**我自己引入的** —— C1 给 `M5.1.1-WP9-Compatible-Assertion-Record.md` 加"后续进展"指针时
插在了**文件开头**，而 C0 门对该文件有**行号锚点**（`:34` / `:87-104`）⇒ 引用漂移。
处置：指针改到**文件末尾**追加（Commit `0634c59`）⇒ 锚点恢复、`wp9c0:verify` 回到 43/0。
**判据一个字未改**（修的是被引用文档里措辞的位置）。这一条也**验证了 C0 门不是空转判据**。

完整逐门读数见 **`artifacts/m5.1.1/wp9c1-gate-exits.txt`**。

---

## Next WP Preconditions

**下一个 WP 只能是 `WP10 — Production-Copy Migration & Regression`**
（用户 R-48：`WP9 = PASS` + `WP10 = READY / AUTHORIZED` 之后"**立即 STOP，不在同一次 execution 开始 WP10**"）。
**不得**在本次执行开始它。

进入 `WP10` 前必须成立：

1. 本 WP 的账已结清：§4 全部 EXIT=0（含 `wp9:verify` 的 **EXIT 0 / `WP9 = PASS`**、
   `wp8c3:verify` 与 `wp8:verify` 两道 Hard Gate），且 `wp8:verify` 未见任何退化。
2. `WP10` 的既有约束照旧：只允许 **真实 production DB 的 copy**，**禁止** live production destructive migration；
   真库 `data/pglite` 未打开。
3. **不得**在 `WP10` 或任何后继 WP 里把 `DC-1` / `DC-2` / `DC-3` 偷偷改成 CLOSED；
   它们各自需要独立的产品能力 WP（R-48 §三/§五）。
4. 已知待办：`wp7:preflight / AT-W7-0`（`inherited`）· `Generic trusted-envelope clone resistance`
   （`OPEN / NOT PROVEN`）· `K-31`（`OPEN / DEFERRED / NON-BLOCKING`）· C4 文本误报
   （`historical false loud / superseded detector observation`，R-46 §1）。
5. 纪律照旧：一个进程一个沙箱库 · 计数型判据自检 `measured_count > 0` ·
   正控/负控/恢复三段式 · **不要并发跑门** · 冻结面只从 `m5.1-complete` 还原 ·
   绝不 `git add -A` · 历史证据只按**白名单逐路径**还原（AGENTS §7）。

**仍未关闭**：`M5.1-D01` 的认知资格（受 `ADR-043` / `Phase 4` 阻塞）·
`Conversation SYSTEM Producer` · `System-origin Action` · `D01 原始后台任务能力` ·
`K-31` · `ADR-043` · `Phase 4`。

---

## 不主张（R-48 尾部逐字要求）

```text
即使 WP9 最终 PASS，也**不能**写成"D01 已全部关闭"或"苏沐薇已经具备后台自主运行能力"。
D01 的认知资格问题仍受 ADR-043 / Phase 4 阻塞，后台任务能力也继续独立保留。
本裁定的核心：**不人为收窄冻结后的 S3，也不借 S3 的通过冒充尚未建设的高级自主能力。**
```
