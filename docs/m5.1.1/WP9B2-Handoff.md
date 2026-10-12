# WP9-B2 Handoff —— Production State Bootstrap Attestation

**判定：`WP9-B2 = PASS`** · **`WP9-GAP-1` 的其余形态仍 `OPEN`** · **`WP9 = PARTIAL / BLOCKED`（不变）**
**`WP9-C = NOT READY`** · **`WP10 = NOT AUTHORIZED`**

日期：2026-09-18/19 · 上游：`WP9-B1 = PASS` · `WP9-A = PASS`
执行令：用户 **`B2-1` 权威裁定**（`DECISION: APPROVED — Option A`）+ **Hard Gate** + "Continue WP9-B2 only. After completion **STOP**."

---

## R-8 八字段

| 字段 | 内容 |
|---|---|
| **Changed Files** | `src/state/bootstrap-attestation.ts`（**新增** ~300 行：冻结身份 `SYSTEM/state-bootstrap` + `SYSTEM_RULE/state-bootstrap-rule` · 无参数受信工厂 `attestStateBootstrapComponentIdentity()` · 品牌类型 + 运行期 `WeakSet` 守卫 · 唯一信封构造点 `stateTransitionAttributionOf()`）· `src/state/init.ts`（+45/−6：可选第 4 参 `StateInitOptions.bootstrapEvidence` + 把信封交给 `recordStateEvent` + `StateInitResult.stateEventId`）· `src/main.ts`（+11/−1：装配根注入受信证据）· `scripts/verify-m5.1.1-wp9b2-verify.ts`（**新增**专项门，1283 行）· `scripts/m5.1.1-attribution-gate-registry.ts`（`NON_VERIFIER_SCRIPTS` +1）· `package.json`（`m5.1.1:wp9b2:verify`）· 文档两份（F4 / 本 handoff）· 证据三份（`wp9b2-attestation.json` / `wp9b2-negatives.json` / `wp9b2-gate-exits.txt`）+ 刷新后的 WP8 harness 当前读数与 `gate-results.json`（F4 §2① / G22） |
| **Tests Run** | 提交前（串行、任何时刻只有一个 pnpm 进程）：`typecheck` · **`wp9b2:verify`（新门）** · `wp9b1:verify` · `migration:verify` · `prod-copy:verify` · `k17:verify` · `k29:verify` · `wp3:verify` · `wp8c2:verify` · `wp9a:verify` · `m5.1.1:test` · `m5.1:measurement:verify` · `m4:test` · `m4.5:test` · `wp7:preflight` · `wp8:verify` · `gates` · `wp9:verify`（只做观察）。**提交后**：`wp8c3:verify` → `wp8:verify` → `gates` → 其余（见 §10） |
| **Tests Passed** | 提交前：`typecheck` 0 · **`wp9b2:verify` 42/0（新门 · 26 个量具 `measurementInvalid = 0`）** · `wp9b1:verify` 56/0 · `migration:verify` 117/0 · `prod-copy:verify` 36/0 · `k17:verify` 15/0 · `k29:verify` 41/0 · `wp3:verify` 0（`Replay = PASS`）· `wp8c2:verify` 25/0（`K-33 = PASS`）· `wp9a:verify` 31/0（`WP9-A = PASS`）· `m5.1.1:test` 43/0 · `m5.1:measurement:verify` 16/0 · `m4:test` 243/0 · `m4.5:test` 135/0 · **`wp8:verify` 0（53/0 · `WP8-B = PASS` · `unexpectedWrites = 0`）**。**提交后（§9）**：`wp8c3:verify` 0（40/0 · `WP8-C3 = PASS`）· `wp8:verify` 0（53/0）· `gates` 0（`G1–G7 PASS · G8 NOT RUN · G9 PASS`）· `typecheck` 0 · `wp9b2` 42/0 · `wp9b1` 56/0 · `migration` 117/0 · `prod-copy` 36/0 · `k17` 15/0 · `wp8c1` 15/0 · `wp8c2` 25/0 · `k29` 41/0 · `wp9a` 31/0 · `m5.1:measurement` 16/0 · `k20` 30/0 · `k19` 19/0 · `wp9:verify` 观察值 **40/0 · `WP9 = PARTIAL / BLOCKED`（EXIT=1，既定判定）** |
| **Tests Failed** | 提交前 **2 条，均已归属**：① `wp7:preflight` **EXIT = 1**（唯一红 = `AT-W7-0 scope`，**既有**历史作用域护栏；分类 `inherited / pending independent confirmation`，按 R-46 §12 不改、不作为验收门）· ② `wp9:verify` 提交前 `38/2`（两条红 `WP9-16` / `WP9-18` 都是**工作区清洁度**判据 —— 未提交 + 跑门改了冻结目录）· 另 `gates` 首次 FAIL（读到 HEAD 上 B1 遗留的红树 manifest，F4 §2① 已处置，重跑后 0）。**提交后 1 条顺序耦合**：`wp9:verify` 第一次 `39/1`（唯一红 `WP9-16`，因紧接其前跑的 `m5.1:measurement:verify` 刷了冻结文件；还原后单独重跑 ⇒ 40/0）。**全部归属完毕，无未解释的红。** |
| **Evidence Produced** | `artifacts/m5.1.1/wp9b2-attestation.json`（E4-A / E4-B 逐格 + Hard Gate 静态读数 + 三个负控 + 冻结面只读比对 + 26 个量具）· `wp9b2-negatives.json`（三个核心负控 + 静态/运行期检测器的**正控/负控/恢复**三段式）· `wp9b2-gate-exits.txt`（逐门退出码，提交后填）· F4：`docs/m5.1.1/M5.1.1-WP9B2-Compatible-Assertion-Record.md`（22 个 criterion-change groups + 四类特别标注 + 三条 instrumentation correction） |
| **Known Issues** | ① `TRUSTED_INGRESS_MARK` 是**类型层**标记 ⇒ 真实受信信封的浅拷贝仍会通过 `isTrustedAttribution`（**B1 既有边界，不是 B2 引入**）。B2 把它作为**读数**登记（不冒充 PASS），并用"生产不可达性"（静态 R7/R3）与"负控 (c1) 四种伪造全部被拒"承担真正的边界。**硬化它属独立 WP，已登记为 OPEN。** ② `wp7:preflight` 的 `AT-W7-0 scope` 仍红（`inherited`；本轮新增列出的两个文件 `state/init.ts` / `state/repository.ts` 正是**用户已授权**的接线面）。③ `wp9:verify` 的 `E4-A` 那一行量的是**对话 pipeline** 的 `system_event` 生产者 ⇒ B2 接线后它**仍然**是 `NOT RUN / BLOCKED`（B2 改的是 `state_transition` 族）。**不能**用"state_side 有 SYSTEM 生产者了"去顶替 conversation 侧。④ `WP9-GAP-1` 的**其余形态**仍未关闭；`WP9-C` 未做 ⇒ `WP9` 不得宣布 PASS。⑤ 提交前的 `artifacts/m5.1.1/wp8-gate-manifest.json` 曾是 B1 遗留的**红树读数**（F4 §2①），本轮以"提交后重跑并提交当前读数"处置。⑥ 执行顺序：`wp8c3:verify` 的 `C3-0` 要求运行前工作区干净 ⇒ 必须**单独**跑，不能排在 `wp8:verify` 之后。 |
| **Architecture Deviations** | **无**。没有新 ADR；没有独立 Policy Registry；没有 scheduler / background 子系统；`src/kernel/contracts/attribution.ts` **一字未改**；`src/state/repository.ts` **一字未改**；`MIGRATION_0009` **一字未改**（指纹仍 FROZEN）；`INITIAL_STATE` 内容未变；manual reset 语义未变；历史 `state_events` 未回填；真实库未打开；冻结面 `artifacts/m5.1/**` 与 `artifacts/m4.5/**` 最终无差异。 |
| **Commit Hash** | `345d59e` — `feat(m5.1.1): add the trusted state bootstrap attribution producer` · `c7bcfdd` — `feat(m5.1.1): wire the production state bootstrap attestation` · `094ecc1` — `test(m5.1.1): add the WP9-B2 bootstrap attestation gate` · `0b76b82` — `docs(m5.1.1): record WP9-B2 evidence, assertion record and handoff` · 提交后重新资格化的读数与刷新后的 WP8 harness 当前读数在本 handoff §9 所在的 docs 提交（**Commit 5**） |

---

## 1. 本 WP 只做一件事

用户执行令：

> **Implement the minimal trusted state-bootstrap attribution producer.**
> Do not create a separate Policy Registry · Do not introduce a new ADR ·
> Do not change `INITIAL_STATE` content · Do not change `MIGRATION_0009` ·
> Do not modify manual reset semantics.
> **Hard Gate**: Only the trusted production bootstrap may establish this SYSTEM identity and
> SYSTEM_RULE authority. **The ordinary `initCharacterState` call must not itself be sufficient
> attestation.** Continue WP9-B2 only. After completion **STOP**.

本 WP 的实现面就只有三样：**一个受信身份生产者 · 一条接线 · 一道门**。

---

## 2. 冻结的受信身份

```text
  SYSTEM component : SYSTEM/state-bootstrap
  SYSTEM_RULE      : SYSTEM_RULE/state-bootstrap-rule
  family           : state_transition
```

B1 把 `SYSTEM_RULE/state-bootstrap-rule` 只放在**门的测试信封**里，明确"留给 B2 冻结"；
B2 现在把它冻结成 `src/state/bootstrap-attestation.ts` 的两个 `Object.freeze` 常量。

**受信链**（R-45 的正确链条，逐段可测）：

```text
  生产装配根 src/main.ts
      │  attestStateBootstrapComponentIdentity()      ← 无参数工厂；品牌类型 + WeakSet 登记
      ▼
  受信证据 token（不透明；浅拷贝 / JSON 往返 / 手写同形对象**都不是**它）
      │  initCharacterState(runtime, characterId, userId, { bootstrapEvidence })
      ▼
  stateTransitionAttributionOf({ characterId, evidence? })   ← 唯一信封构造点
      │  constructTrustedAttribution（canonical 必要性 + TRUSTED_INGRESS_MARK）
      ▼
  recordStateEvent(runtime, { …, attribution })             ← B1 的边界（只收受信信封）
      ▼
  state_events（19 归因列 + attribution_origin = 'RECORDED'）
```

**反向也被钉住**：静态判据断言消费者 `src/state/init.ts` 的**代码**里**不出现**
`'SYSTEM'` / `'SYSTEM_RULE'` / `'state-bootstrap'` / `STATE_BOOTSTRAP_*`
（注释里可以有 —— 那是解释；代码里不可以 —— 那是自建身份）。

---

## 3. E4-A / E4-B（实测逐格）

### E4-A：真实首启 + 受信 SYSTEM 证据

```text
  initiator = KNOWN|SYSTEM|state-bootstrap|-          actor = KNOWN|SYSTEM|state-bootstrap|-
  executor  = ABSENT|-|-|-                            authority = KNOWN|SYSTEM_RULE|state-bootstrap-rule|-
  recordedBy= KNOWN|SYSTEM|kernel|-                   contentOriginator = ABSENT|-|-|-
  attribution_origin = 'RECORDED'                     subject = DERIVED CHARACTER/<character_id>
  L1↔L2：initCharacterState 返回的 stateEventId **逐字等于**物理行 id
```

### E4-B：没有受信因果证据（**普通 `initCharacterState` 调用**）

```text
  initiator = UNKNOWN|-|-|RUNTIME_UNRESOLVED
  actor     = UNKNOWN|-|-|RUNTIME_UNRESOLVED
  authority = UNKNOWN|-|-|RUNTIME_UNRESOLVED      ← 授权与身份来自同一份证据 ⇒ 没证据就不能断言
  recordedBy= KNOWN|SYSTEM|kernel|-
  executor / contentOriginator = ABSENT|-|-|-
```

**为什么这是正确的新语义**：矩阵行是 `REQUIRED`，而 `REQUIRED` 允许
`Unknown(RUNTIME_UNRESOLVED)`、**不允许** `Absent`（裁定 U-04）。
所以普通调用必须**如实说出来**"这次没有受信因果证据"，而不是沉默（NULL）、
更不是从 `trigger='init'` 猜一个 `Known(SYSTEM)`。

---

## 4. 三个核心负控（逐条实测）

| 负控 | 读数 |
|---|---|
| **(a) 删 SYSTEM attestation ⇒ `Known SYSTEM` 消失** | 检测器先抓到 E4-A 那一行（正控 `claims = 1`）；普通调用写出的 E4-B 行**不在**其中 |
| **(b) 只保留 `trigger='init'` ⇒ 不得得到 `Known SYSTEM`** | 原始 SQL 插入 v9 之前的形状 ⇒ `attribution = undefined` · 19 列全 NULL · `claims` 仍为 1；静态侧 R5（生产者代码里没有 `init` / `state_events` 字面量）通过 |
| **(c) 调用方自报 `SYSTEM/<id>` ⇒ 不得进入权威槽位** | c1：4 种伪造证据 4/4 `untrusted_state_bootstrap_evidence`、运行期守卫 0/4 通过、账本行数 `3 → 3`；c2：手写权威信封（无标记）⇒ `untrusted_state_event_attribution`；c3：facts 夹带 `authority`/`executor`/`contentOriginator` ⇒ 3/3 `untrusted_attribution_field`；全表攻击者位次出现次数 = **0** |
| **恢复（三段式第三段）** | 受信证据接回去再建一次档 ⇒ `claims = 2`，检测器重新响起 |

**检测器自身的三段式**（静态）：真实 `src` ⇒ 0 条；注入"第二个身份工厂调用点"+"消费者里的 `SYSTEM` 字面量" ⇒ **必响**（R2 + R3）；放回真实实现 ⇒ 0 条。

---

## 5. 为什么"普通调用本身不构成鉴证"（Hard Gate 的可测形式）

```text
  ① 身份常量只在 src/state/bootstrap-attestation.ts 定义一次；
  ② 无参数工厂在生产代码里**恰好一个**调用点，且位于 src/main.ts；
  ③ src/state/init.ts 的代码里没有身份与授权（字面量 / 常量都没有）；
  ④ 工厂无参数、品牌未导出、运行期 WeakSet 登记在位；
  ⑤ 信封的唯一生产调用点是 src/state/init.ts；
  ⑥ 生产者代码里没有 'init' / 'state_events' / 'manual' / 'actor_type'（不得从"事件长什么样"推导）。
```

`initCharacterState(runtime, characterId, userId)` 这个**普通三参调用**仍然合法，
但它只会写出 **E4-B** 的信封 —— 这就是"不构成鉴证"的可执行含义。

---

## 6. 明确**没有**做

- 没有建独立 Policy Registry；没有新 ADR；没有 scheduler / background。
- 没有改 `MIGRATION_0009`（`5a007003…` 仍 FROZEN）· `INITIAL_STATE` · manual reset 语义。
- 没有改 `src/kernel/contracts/attribution.ts` 与 `src/state/repository.ts`。
- 没有回填历史行；没有把 `executor` 填成 actor；没有把 `user_id` 塞进信封。
- 没有打开真实库；没有启动 `WP9-C` / `WP10` / `Phase 4`；没有关闭 `M5.1-D01`。
- **没有**趁机硬化 `isTrustedAttribution` 的浅拷贝边界（属独立 WP，已登记 OPEN）。

---

## 7. 证据

| 文件 | 内容 |
|---|---|
| `artifacts/m5.1.1/wp9b2-attestation.json` | E4-A / E4-B 逐格 · Hard Gate 静态六面 · 负控 (a)(b)(c) · 冻结面只读比对 · 26 个量具 · `boundaryStatement`（含 `supersedes`：B1 的 `deferredToB2` 那句已成为历史读数） |
| `artifacts/m5.1.1/wp9b2-negatives.json` | 三个核心负控 + 静态/运行期检测器的正控/负控/恢复三段式 |
| `artifacts/m5.1.1/wp9b2-gate-exits.txt` | 逐门串行退出码（提交后填） |
| `docs/m5.1.1/M5.1.1-WP9B2-Compatible-Assertion-Record.md` | F4：22 个 criterion-change groups + A–D 四类特别标注 + 3 条 instrumentation correction |

---

## 8. 提交序列

```text
  Commit 1  feat(m5.1.1): add the trusted state bootstrap attribution producer
  Commit 2  feat(m5.1.1): wire the production state bootstrap attestation
  Commit 3  test(m5.1.1): add the WP9-B2 bootstrap attestation gate
  Commit 4  docs(m5.1.1): record WP9-B2 evidence, assertion record and handoff
  Commit 5  docs(m5.1.1): record the post-commit requalification readings for WP9-B2
```

---

## 9. 提交后串行重跑 —— **实测读数**

按 R-46 §10 的清单 + 本轮新增门（**全部串行**，任何时刻只有一个 pnpm 进程）：

| # | 门 | EXIT | 读数 |
|---|---|---|---|
| 1 | **`pnpm m5.1.1:wp8c3:verify`**（Hard Gate，干净树、单独跑） | **0** | **40 通过 / 0 失败 · `WP8-C3 = PASS` → `WP8 = PASS`** |
| 2 | **`pnpm m5.1.1:wp8:verify`**（Hard Gate） | **0** | **53 通过 / 0 失败 · `WP8-B = PASS`** · `unexpectedWrites = 0` · `redGates = []` |
| 3 | `pnpm m5.1.1:gates` | **0** | **`G1–G7 PASS · G8 = NOT RUN · G9 PASS`** |
| 4 | `pnpm typecheck` | **0** | |
| 5 | **`pnpm m5.1.1:wp9b2:verify`**（本 WP 新门） | **0** | **42 通过 / 0 失败** |
| 6 | `pnpm m5.1.1:wp9b1:verify` | **0** | 56 通过 / 0 失败 |
| 7 | `pnpm m5.1.1:migration:verify` | **0** | 117 通过 / 0 失败 |
| 8 | `pnpm m5.1.1:prod-copy:verify` | **0** | 36 通过 / 0 失败 |
| 9 | `pnpm m5.1.1:k17:verify` | **0** | 15 通过 / 0 失败 |
| 10 | `pnpm m5.1.1:wp8c1:verify` | **0** | 15 通过 / 0 失败 · `K-32 = PASS` |
| 11 | `pnpm m5.1.1:wp8c2:verify` | **0** | 25 通过 / 0 失败 · `K-33 = PASS` |
| 12 | `pnpm m5.1.1:k29:verify` | **0** | 41 通过 / 0 失败 |
| 13 | `pnpm m5.1.1:wp9a:verify` | **0** | 31 通过 / 0 失败 · `WP9-A = PASS` |
| 14 | `pnpm m5.1:measurement:verify` | **0** | 16 通过 / 0 失败 |
| 15 | `pnpm m5.1.1:k20:verify` | **0** | 30 通过 / 0 失败 |
| 16 | `pnpm m5.1.1:k19:verify` | **0** | 19 通过 / 0 失败 |
| 17 | `pnpm m5.1.1:wp9:verify`（**只做观察**） | **1** | **40 通过 / 0 失败 · `WP9 = PARTIAL / BLOCKED`**（既定判定）· **没有新的 scenario failure** |

**唯一的顺序耦合**：第一次 `wp9:verify` = EXIT 2 · 39/1，唯一红 `WP9-16`
（`artifacts/m5.1/measurement-negative-controls.json` 被**紧接在它之前**的 `m5.1:measurement:verify` 刷过）；
按白名单还原冻结面后**单独重跑** ⇒ 40/0 · EXIT 1。**不是** B2 的回归。

**提交前读数**（同样串行）：`typecheck` 0 · `wp9b2` 42/0 · `wp9b1` 56/0 · `migration` 117/0 ·
`prod-copy` 36/0 · `k17` 15/0 · `k29` 41/0 · `wp3` 0 · `wp8c2` 25/0 · `wp9a` 31/0 ·
`m5.1.1:test` 43/0 · `m5.1:measurement` 16/0 · `m4:test` 243/0 · `m4.5:test` 135/0 ·
`wp8` 53/0 · `wp7:preflight` **EXIT 1**（`inherited` / `AT-W7-0 scope`，不作验收门）·
`wp9` 38/2（两条红均为工作区清洁度）· `gates` FAIL（读到 HEAD 上 B1 遗留的**红树** manifest ⇒ F4 §2① 已处置）。

完整逐门读数（含提交前的每一条）见 **`artifacts/m5.1.1/wp9b2-gate-exits.txt`**。

---

## R-47 附注 —— 本 WP 的 PASS 被**接受但范围被收紧**（2026-09-19 用户裁定）

> ⚠️ 本节是**后加的附注**（用户 **R-47**，见 `M5.1.1-Execution-Plan.md` 的 R-47 行）。
> 它**不改**本 handoff 与 F4 的正文结论 —— R-47 逐字："这不撤销 B1/B2 的建设成果"。
> 它只收紧本 WP PASS 的**适用范围**。

```text
WP9-B2 = PASS                        （接受，但其范围为：State Bootstrap 的受信 SYSTEM 归因）
State-origin SYSTEM Attribution
  = IMPLEMENTED / VERIFIED
WP9-GAP-1 = PARTIALLY RESOLVED       （State branch: RESOLVED · Canonical E4/S3: OPEN）
```

- **B2 证明的是**：状态引导组件能以自己的受信身份建立 `Known(SYSTEM/state-bootstrap)`，
  写进 `state_events`，并受信读回。**它不自动证明** canonical `E4/S3` 已经完成。
- **三项能力必须独立判定**（R-47 §2 逐字："不能把第一行的 PASS 复制给后两行"）：

  | 能力 | 状态 |
  |---|---|
  | State-origin SYSTEM attribution | **PASS，B2 已证明** |
  | Conversation-origin SYSTEM attribution | **尚未证明真实生产可达** |
  | Background/system-origin Action attribution | **尚未证明真实生产可达** |

- **原"B2 完成后 `WP9-GAP-1 = RESOLVED IN PRODUCTION`"的预计范围过宽**，已由 R-47 修正为
  `PARTIALLY RESOLVED`。
- 浅拷贝受信信封的词汇也被 R-47 细化为三行：`Bootstrap token authenticity = B2 PASS` ·
  `Generic trusted-envelope clone resistance = OPEN / NOT PROVEN` ·
  `External exploitability = NOT ESTABLISHED`（**不得**写成"已发生的生产漏洞"，也不得写成"已经安全"）。

---

## Next WP Preconditions

**下一个 WP 只能是 `WP9-C0 — Canonical E4 Acceptance Boundary Review`**
（用户 R-47 §5：**只读** · **无生产代码改动** · **无既有 verifier 判据改动** · 做完即 **STOP**）。
**不得**在同一次 execution 里开始 `WP9-C1 Final Requalification`；**不得**直接宣布 `WP9 = PASS`；
**不得**提前创建 Conversation SYSTEM producer 或真实后台任务入口。

进入 `WP9-C0` 前必须成立：

1. 本 WP 的账已结清：§9 全部 EXIT=0（含 `wp8c3:verify` 与 `wp8:verify` 两道 Hard Gate），
   `wp9:verify` 观察值仍为 `WP9 = PARTIAL / BLOCKED`，且**没有新的 scenario failure**。
2. `WP9-C0` 必须回答的问题是：冻结的 `E4/S3` 究竟要求**哪个生产事件族**、**哪一类系统发起行为**、
   **哪些权威账本**提供证据；并对照四份材料（执行计划 canonical E4 · Test-and-Gate-Plan S3 ·
   原 WP9-Handoff/F4 的 `WP9-GAP-1` 阻塞入口 · 本 WP 的 `state_events` E4-A/E4-B 证据）
   输出**不可省略的覆盖率矩阵**。**不得**用"这些能力理论上可以复用 B2 的工厂"替代生产可达性。
3. `WP9-C0` **不**裁定载体归属（`Q1`）与后台任务含义（`Q2`）—— 那是用户的选择；
   C0 只负责把问题、逐字出处与各自后果写清楚。
4. 已知待办（B2 交出去的）：`isTrustedAttribution` 的浅拷贝硬化（F4 §2②，OPEN）·
   `wp7:preflight` 的 `AT-W7-0 scope`（`inherited`）· C4 文本误报（`historical false loud /
   superseded detector observation`，R-46 §1 有意不修）。
5. 纪律照旧：一个进程一个沙箱库 · 计数型判据自检 `measured_count > 0` ·
   正控/负控/恢复三段式 · **不要并发跑门** · 冻结面只从 `m5.1-complete` 还原 ·
   绝不 `git add -A` · 历史证据只按**白名单逐路径**还原（AGENTS §7）。

**仍未授权 / 未关闭**：`WP9-GAP-1` 的 State 分支 = `RESOLVED`，其 `Canonical E4/S3` = `OPEN` ·
`WP9 = PARTIAL / BLOCKED` · `WP9-C1 Final Requalification = NOT READY` · `WP10 = NOT AUTHORIZED` ·
`K-31 = OPEN / DEFERRED / NON-BLOCKING` · `ADR-043 = NOT APPROVED` · `Phase 4 = BLOCKED` ·
`M5.1-D01` 未关闭 · `wp7:preflight` 的历史 scope 条 = `inherited / pending independent confirmation`。
