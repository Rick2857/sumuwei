# ADR-043 — Legacy Cognitive Provenance & Epistemic Requalification

```text
状态      : **ACCEPTED / DESIGN FROZEN**（用户 2026-09-19 裁定：批准 A-1…A-5 全部）
编号      : ADR-043（与 ADR-042 并行，但独立裁定）
里程碑    : M5.1.1 Correctness Milestone
上游      : ADR-042 `ACCEPTED / DESIGN FROZEN`（归因）· WP11 `PASS`（Phase 1–3 收口）
本 ADR     : 回答"归因事实应当如何影响**记忆 / 事实采信 / 后续认知行为**"
审查记录  : 设计审查在 `docs/m5.1.1/M5.1.1-ADR-043-Design-Review.md`（已收敛为本文件）
原草案    : `docs/m5.1.1/M5.1.1-ADR-043-Epistemic-Requalification-Draft.md`（问题陈述，正文保留，已标 SUPERSEDED）
配套      : `docs/architecture/cognitive-integrity.md`（INV-CI-01 ~ 05，Sovereign Core 约束）
```

> **本文的编辑约定**：本文件是**规范位置的 ADR 正文**，也是 ADR-043 的**唯一权威**。
> `DR-1`…`DR-12` 是**已批准的裁定**，不得在实现阶段顺手改动；要改必须新开一次 ADR 修订并引用本文件。
> **文件名说明**：本仓库的 ADR 用短 slug（见 `ADR-042-attribution-model.md`）。
> 另一个文件名 `ADR-043-legacy-cognitive-provenance-and-epistemic-requalification.md`
> 只是**重定向**，不承载任何判据 —— 同一概念不允许两处权威。

> ### 批准边界（2026-09-19）
>
> ```text
> 已批准      A-1…A-5 全部（本文件 §1 末的批准记录）
> 当前授权    **只读的 `4-preflight`**
> 当前未授权  `4a`（形成期）· `4b`（存量与行为）—— 各自需要用户**另行放行**
> 完成条件    `4-preflight` 产出精确影响清单后 **必须 STOP**
> ```
>
> **`M5.1-D01` 仍为 `P1 OPEN`；`M5.1.1 Final` 仍为 `BLOCKED`。**
> 批准 ADR **不等于**关闭 D01（`DR-12`）。

---

## 0. Context（为什么需要这个 ADR）

### 0.1 一句话

**把「归因」（谁发起的 / 谁决定的 / 谁执行的 / 凭什么 / 谁记录的 / 内容是谁给的）
从"只记 role"升级为"事件本体里记录、读时不再猜"** —— 这一步（Phase 1–3，ADR-042）
**已经完成**。本 ADR 解决**下一步**：

> 当系统已经能确定某条信息是谁说的、从哪里来、由谁执行之后，
> **这些归因事实究竟应该如何影响苏沐薇的记忆、事实采信和后续认知行为？**

### 0.2 触发实例（`M5.1-D01` 的原始现场，可复核）

```text
$ pnpm memory:list
  mem:…:person_fact-8d64c71c49424b51   active     EXPLICIT_USER_STATEMENT
      education.institution = 示例工程科技大学
$ pnpm memory:sources mem:…:person_fact-8d64c71c49424b51
  conversation_event:…:dm-sumuwei-b8ec0760:27   [user]  「记住，我现在上的大学是示例工程科技大学」
```

那条 `[user]` 发言是**受支持的替发路径**（agent 以用户身份提交）写进去的。
于是记忆的出处 `EXPLICIT_USER_STATEMENT` **技术上成立**（确实有一条 user 角色发言），
但**对人读起来是误导的**：它不等于"用户亲手打了这几个字"。

### 0.3 根因：**用一个不存在的概念承担一个真实问题**

| 问 | 内容 | 过去谁回答 | 现在谁回答 | 性质 |
|---|---|---|---|---|
| **Q1** | 这条内容是谁说的 / 从哪来 / 谁执行 | ❌ 只记 role | ✅ 七个归因槽位 + Axis B 三列（ADR-042 / Phase 1–3） | **记录**（事件面，不可变） |
| **Q2** | 这条证据**当时**有多强 | `memory_records.authority`（写入时由 `actor_type` 推导并落库） | 同左（**本 ADR 不动**） | **当时的判定**（记忆面，append-only） |
| **Q3** | 这条认知**现在**还算不算数 | ❌ **不存在** ⇒ 被 Q2 冒充 | ✅ **`MemoryQualification`**（本 ADR 引入的派生量） | **导出量**（读面，可重算） |

```text
D01 = Q3 不存在 ⇒ 系统只能拿 Q2（写入时的判定）当作"当前资格"；
      而 Q2 是 Q1 的**粗粒度投影**（actor_type）⇒
      "这条消息占据 user 角色"被永久读成"这条内容由人类提供"。
```

⇒ 本 ADR 的答案形状因此**不是"改一个阈值"**，而是：**把 Q3 建成一等导出量**，
定义 `Q3 = f(Q2, Q1, 规则版本)`，再逐面规定 Q3 对认知的影响。

### 0.4 由此产生的两难（原草案 §1 的问题）

```text
若不动它 → 一个已知可能错误的认知资格被**永久固化**（append-only，无法回收）
若直接改它 → 对既有认知状态做**追溯性的静默重写**，违反"不得 silent rewrite"
```

---

## 1. Decision（12 条已批准裁定）

| # | 裁定 |
|---|---|
| **DR-1** | 归因经**读时派生**影响当前资格；**不改** `memory_records.authority`（它是"当时的判定"） |
| **DR-2** | **不扩展** `MemoryAuthority` 阶梯；新增**独立派生轴** `MemoryQualification`；`authorityFromSource(UNCONFIRMED_ORIGIN)` 的**抛错保留**（最后一道防线） |
| **DR-3** | 资格为**三值**：`ESTABLISHED` / `UNCONFIRMED_ORIGIN` / `CONTRADICTED_ORIGIN`；"不知道"与"知道不是他"**必须分开** |
| **DR-4** | 存量记忆 = U-06 的 **C 的精确形式**：记录权威**不重算** + 当前资格**派生** + 每个受影响条目**追加一条显式重判记录** |
| **DR-5** | 规则只作用于 `person_fact` / `preference`（= 既有的 `needsExternalFactEvidence` 范围）；**不**扩到 Episode |
| **DR-6** | "来源已确立" = **被证实的（attested）归因**：`contentOriginator = Known(USER)` ∧ 该行 Axis B 为 `confirmed`。**调用方自报的 `provenance` 不算** |
| **DR-7** | 无归因信封（`attribution_origin IS NULL`）一律 fail-closed = `UNCONFIRMED_ORIGIN`；**不按写入时间豁免** |
| **DR-8** | 分三次落地：`4-preflight`（只读）→ `4a`（形成期）→ `4b`（存量与行为）；**4a 不得在精确影响清单出来前开工** |
| **DR-9** | `contaminatedMemories()` 判据**一字不改**；**新增第二个**只读探针 `unestablishedOriginMemories()` |
| **DR-10** | **规则版本化**（`COGNITIVE_QUALIFICATION_RULE_VERSION`）+ 激活记录 + 半径报告 + 用户批准；**不新增 runtime flag、不新增控制命令** |
| **DR-11** | 措辞（"你告诉过我…"）**不做**启发式回复守卫；机械保证到采信 / 排序 / prompt 标签为止，措辞由 Live Smoke 观察 |
| **DR-12** | `M5.1-D01` 的关闭需要 `4a` + `4b` + 门全绿 + **真实链路 Live Smoke 观察** + **用户批准**；**批准 ADR ≠ 关闭 D01** |

**用户批准记录**：2026-09-19，用户对 §7 的 A-1…A-5 选择「**批准 A-1…A-5 全部**」：

```text
A-1  读时派生 + 不扩展 MemoryAuthority（记录权威不可变）        ← DR-1 / DR-2
A-2  三值资格，"已确立"只认受信归因（调用方自报不算）            ← DR-3 / DR-6
A-3  存量记忆不重算；改为"派生资格 + 每条追加一次显式重判记录"    ← DR-4
A-4  先做只读的 4-preflight 并 STOP，看清单之后再放行 4a；4a/4b 分两次  ← DR-8
A-5  不加 runtime flag、不加控制命令；措辞不做启发式守卫          ← DR-10 / DR-11
```

---

## 2. Inspect（裁定所依据的实测读数）

### 2.1 代码面：今天的"事实采信"链路（逐点带文件与行）

```text
① 写入期（形成一条关于用户的事实）
   src/kernel/app/memory/extractor.ts:148-159  evidenceProfileOf(view)
        sourceAuthority = defaultAuthorityForKind(sourceKindForActor(view.actorType))
        ⇒ **只读 actor_type**，视图里根本没有 Axis B 列
   extractor.ts:173-183                        highestAuthorityOf(profiles)
   extractor.ts:324-326                        闸 3：authority = highestAuthorityOf(...)
   extractor.ts:329-336                        闸 4：person_fact/preference 必须有 canSupportExternalFact 的证据
   src/kernel/contracts/memory.ts:853-898      assertMemoryAuthorityAllows：person_fact/preference 只接受
                                               EXPLICIT_USER_STATEMENT / EXPLICIT_CORRECTION
   src/kernel/contracts/memory.ts:1307-1371    authorityFromSource：UNCONFIRMED_ORIGIN **刻意抛错**

② 证据谓词
   src/kernel/contracts/conversation-event.ts:460-476  canEvidenceExternalFact({type, actorType, sourceAuthority})
        · 有 sourceAuthority ⇒ 只认 USER_EXPLICIT / USER_REPLY_CONFIRMATION / TOOL_OBSERVATION
        · **没有** sourceAuthority ⇒ **回落**到 `actorType === 'user' || 'tool'`
   src/kernel/contracts/source-authority.ts:241-261    EXTERNAL_FACT_AUTHORITIES 白名单（UNCONFIRMED_ORIGIN 不在内）

③ 记录面（信封有没有）
   src/kernel/contracts/conversation-event.ts:395-405
        Axis B 三列 = trusted?.axisB.… ?? provenance.…（**provenance 由 actorType 推导 / 可调用方自报**）
        `attribution` 只在 `trusted !== undefined` 时才带上
   ⇒ 三种可区分状态：attribution_origin = 'RECORDED' | 'MIGRATED_LEGACY' | **NULL**

④ 读面（资格如何影响她的行为）
   src/kernel/recall/eligibility.ts:103-107   DEFAULT minAuthority = 'MODEL_INFERENCE' ⇒ 今天不做任何排除
   src/kernel/recall/ranking.ts:246-250       authority 只影响**排序分**（权重 1）
   src/kernel/recall/render.ts:119-125        **authority 会被渲染进 prompt**：
                                              `- {dataText}（{authority}[ / {status}]）`

⑤ 反污染探针（M4 的 Critical Test 落点）
   src/infrastructure/persistence/memory-store.ts:1069-1086  contaminatedMemories()
        判据：person_fact/preference 且 authority ∉ {EXPLICIT_USER_STATEMENT, EXPLICIT_CORRECTION} ⇒ 污染
   消费方：src/main.ts:1623 · src/infrastructure/dev/query-service.ts:565 ·
          **六道 M4 门**（m4-audit / verify-m4-hardkill / isolation / persistence / scale / restore）
```

### 2.2 语料面：存量影响半径（原草案 §6 要求的那份报告）

`docs/m5.1.1/M5.1.1-Phase4-Cognitive-Impact-Radius.md`
（由 `pnpm m5.1.1:wp3:verify` 在**真实库副本**上生成）：

```text
今天有外部事实资格的记忆          2 条（**全部**）
Phase 4 假设下会失去资格的        2 条
memory authority（MemoryAuthority 词表）  EXPLICIT_USER_STATEMENT
根证据                            conversation_event:…:dm-sumuwei-b8ec0760:27 / :23（actor_type='user'）
回填前 source_authority           USER_EXPLICIT（**调用方/旧规则推导**）
contentOriginator                 Unknown / Absent（**LEGACY_UNRECORDED**，从未记录）
```

该报告自己也登记了一条教训：**第一版拿 `USER_EXPLICIT`（SourceAuthority 词表）去过滤
`memory_records.authority`（MemoryAuthority 词表）**，量到"受影响 0 条" —— 那是**量错了东西**。

⇒ **存量半径 = 2 条**（真实语料：`conversation_events` 28 行 · `state_events` 1 行 ·
`character_action_events` 0 行）。**但这个"2"只覆盖"记忆行"，不覆盖"会改行为的测试面"。**

### 2.3 一处**尚未测量**的爆炸半径（DR-8 的直接依据）

若 `DR-7` 取严格读法，**任何**"手造一个 `actorType='user'` 的事件、然后期待形成
person_fact/preference"的测试都会变红。实测扫描（`scripts/` + `evals/` + `src/`）：

```text
构造 conversation 事件 / 依赖 USER_EXPLICIT 的文件（前 8，按命中数）
  scripts/verify-m5.1.1-wp61-conversation-ingress.ts   14 处 USER_EXPLICIT · 4 处 createConversationEvent · 4 处 trustedAttribution
  scripts/kernel-tests-conversation.ts                  8 · 5 · 0
  scripts/kernel-tests-m5.1.1.ts                        9 · 0 · 2
  scripts/verify-m5.1.1-wp4-write-path.ts               8 · 1 · 18
  src/kernel/contracts/source-authority.ts              9 · 0 · 0
  scripts/verify-m5.1.1-wp32-recorded-axisb.ts          7 · 0 · 0
  scripts/verify-m5.1.1-k29-necessity.ts                0 · 6 · 3
  scripts/eval-m4-extraction.ts                         0 · 3 · 0     ← **M4 抽取评测：夹具只用 actorType**
合计：51 个文件 · 95 处 USER_EXPLICIT · 45 处 createConversationEvent · 51 处 trustedAttribution
```

**已逐字确认的最危险点**：`scripts/eval-m4-extraction.ts:135-156` 的 `materializeEvents()`
用 `createConversationEvent({ actorType: e.actor, … })` 造事件 —— **没有** `trustedAttribution`。
严格读法下这批夹具 `attribution_origin = NULL` ⇒ 用户事实类用例会被新闸拒绝
⇒ **M4 抽取评测会红**。

⇒ **本 ADR 拒绝在没有这份精确清单之前放行 `4a`。**

---

## 3. Design

### 3.1 派生量：`MemoryQualification`

```ts
/**
 * 当前认知资格 —— **派生量，不落库**。
 * 命名刻意复用 Axis B 已冻结的取值 `UNCONFIRMED_ORIGIN`：
 * 一个概念一个名字（仓库明令禁止两套方言）。
 */
export type MemoryQualification =
  | 'ESTABLISHED'          // 来源已确立，且指向有资格支持该类结论的来源
  | 'UNCONFIRMED_ORIGIN'   // 来源**未确立**（Unknown / Absent / 无信封 / 记录值为 UNCONFIRMED_ORIGIN）
  | 'CONTRADICTED_ORIGIN'  // 来源**已确立，但它不是人类**，而这条记忆却声称是用户事实
```

### 3.2 派生函数（纯函数、只读、规则版本化）

```text
qualificationOf(memory, rootEvidence, ruleVersion) :
  # 只对 person_fact / preference 求值（= needsExternalFactEvidence 的既有范围）
  # COGNITIVE_QUALIFICATION_RULE_VERSION = 1（首版）

  1. 根证据不存在 / 读不到 / 无信封（attribution_origin IS NULL）
        → UNCONFIRMED_ORIGIN            # fail-closed（DR-7）
  2. attribution_origin = 'MIGRATED_LEGACY'
        → UNCONFIRMED_ORIGIN            # 记录值一律 UNCONFIRMED_ORIGIN；**不得**回落到 actor_type
  3. attribution_origin = 'RECORDED'
        a. contentOriginator = Known(USER) ∧ Axis B = confirmed        → ESTABLISHED
        b. contentOriginator = Known(CHARACTER|SERVICE|TOOL|EXTERNAL_ACTOR) → CONTRADICTED_ORIGIN
        c. 其余（Unknown / Absent / Axis B = unconfirmed）              → UNCONFIRMED_ORIGIN
```

**三条不变量**：① 纯函数、只读；② **不读也不写** `memory_records`（只读 `memory_evidence_links` 与事件面）；
③ 规则版本是**输入** ⇒ "同一个账本 + 不同版本 ⇒ 可解释的不同结果"。

### 3.3 效果矩阵（本 ADR 对那个问题的**答案**）

| 面 | `ESTABLISHED` | `UNCONFIRMED_ORIGIN` | `CONTRADICTED_ORIGIN` |
|---|---|---|---|
| **① 记忆形成**（新 person_fact / preference） | 允许（按既有权威政策） | **拒绝**（`evidence_origin_not_established`） | **拒绝**（`evidence_origin_contradicts_claim`） |
| **①′ 闸序** | 新闸放在**权威推导之前** | 同上 | 同上 —— 否则 `authorityFromSource(UNCONFIRMED_ORIGIN)` 会**抛异常**而不是**干净拒绝**（`extractor.ts:325` 先于 `:329`） |
| **② 记录权威** `memory_records.authority` | 按既有规则落库 | **不适用**（不形成新记忆） | 不适用 |
| **③ 既有记忆的当前资格** | 保持 | 降为 `UNCONFIRMED_ORIGIN` | 降为 `CONTRADICTED_ORIGIN` |
| **④ 事实采信**（可否充当外部事实） | **可以** | **不可以** | **不可以** |
| **⑤ Recall 入选** | 允许 | **仍允许**（不删她的记忆 —— `INV-CI-05`） | 仍允许 |
| **⑥ 排序** | authority 全额 | authority 分**按降一档**计（**不改库值**） | 同左；若 `status = disputed` 再降 |
| **⑦ Prompt 标签**（`render.ts:124`） | `（{authority}）` | `（{authority} / 来源未确立）` | `（{authority} / 来源与记录不符）` |
| **⑧ 她可以说** | 「你告诉过我…」 | 「我记得…（但我不确定这是不是你说的）」 | **不得**称"你说过"；须承认可能记岔 |
| **⑨ 可回滚** | — | **是**：派生量 ⇒ 版本回退即精确恢复 | 同左 |

**⑧ 的诚实边界**：⑧ **不是**机械保证（见 `DR-11` 与 §6 `L-3`）。

### 3.4 与五条 Cognitive Integrity 不变量的关系

| 不变量 | 本 ADR 如何满足 |
|---|---|
| `INV-CI-01` No Cognitive State Without Provenance | 读法钉死为「without **established** provenance」：未确立的来源**不得**建立认知资格（① + ④） |
| `INV-CI-02` External Access Does Not Imply Cognitive Authority | "Agent 以 user 角色替发"正是"外部访问"，它**不再**隐含认知权威（`DR-6` + 矩阵 ④） |
| `INV-CI-03` Maintenance Must Never Masquerade as Experience | 不受影响（Episode 面不进本规则，`DR-5`） |
| `INV-CI-04` Intervention Must Be Explicit, Warned, Authorized, Audited, Verifiable | 激活 / 回滚走 **prepare → preview（半径报告）→ warn → explicit confirm → execute → verify**，并追加激活记录（`DR-10`） |
| `INV-CI-05` History May Be Corrected, But Must Not Be Falsified | `memory_records.authority` 与 `MemoryStatus` **都不改**；重判记录是**追加**（`DR-1` + `DR-4`） |

### 3.5 为什么**不**扩展 `MemoryAuthority`（`DR-2` 的完整理由）

```text
① 语义不同类：MemoryAuthority 回答"这条证据有多强"（证据的属性）；
   「来源确没确立」回答"我们知不知道它从哪来"（知识的属性）。
   合并之后，"不知道怎么归类"会退化成"权威低一点"—— 而那正是
   memory.ts:1335-1351 与 :1300-1305 两段注释**明令拒绝**的回落。

② 会改一个已验收的判据：contaminatedMemories（memory-store.ts:1078）判的是
   "person_fact 的 authority 不是 EXPLICIT_*"。若把 UNCONFIRMED_ORIGIN 放进阶梯并落库，
   六道 M4 门会在**正控**上变红 —— 而它们**没有错**。

③ 会让 prompt 撒谎：render.ts:124 把 authority 直接写进她的上下文。
   若把"来源未确立"编码成"权威=MODEL_INFERENCE"，她读到的标签就**是错的**。
```

**保留 `authorityFromSource(UNCONFIRMED_ORIGIN)` 的抛错**：它是**最后一道防线**。
新闸让它"正常路径不可达"，但一旦有人绕过新闸，它会立刻抛 —— 这正是
"刻意失败关闭而不是回落"的原意。

---

## 4. Landing（落地拆分与门）

### 4.1 三次执行（`DR-8`）

```text
4-preflight  **只读**影响半径预检（本 ADR **未**做，见 §2.3）
             产出：受影响的 gate/eval 脚本**精确清单** + 每条的影响类型 + 夹具改造方案
             Hard Gate：`measured_count > 0`（不许"检查了 0 个文件、发现 0 处影响"）
             STOP：清单交用户看过后才可进入 4a

4a  形成期：新记忆不许由**未确立 / 与声称矛盾**的来源建立
             改动面：extractor 新增一道闸（**追加**，不改既有闸判据）+ 新理由码 +
                     `ProcessorEventView` 带上 Axis B 读数
             门：m4:test · m4:verify · m4:mutation-safety:verify · m4:nl-mutation:verify ·
                 eval:m4 · kernel:test（contracts）+ 新增专项门
             必须：M3/M4 夹具改走**生产 trusted ingress**（F4 逐条记录；**不是**放宽判据）

4b  存量与行为：当前资格派生 + 排序 + prompt 标签 + 探针 + 重判记录
             改动面：qualification 派生（新文件）· recall ranking/eligibility/render ·
                     第二个只读探针 · developer-query DTO 暴露资格
             门：m5:test · m5:verify · m5:metrics:verify · m5:nl-e2e:verify ·
                 m3.5:test（**prompt 基线会变**，需 `pnpm m3.5:baseline` 重刷并说明理由）·
                 m5.1:*（开发者平面）· 新增专项门
```

**为什么必须分开**：`4a` 改的是**形成**（不可逆：错误建立的记忆已入库）；
`4b` 改的是**资格**（纯派生、可回滚）。混在一起出问题无法归因。

### 4.2 新门必须带的判据（正控 / 负控 / 恢复三段式）

```text
N-1 负控  伪造"agent 以 user 角色替发"的事件（**无**受信归因）⇒ 新闸必须拒绝
N-2 正控  同一内容带**受信的人类**归因 ⇒ 必须**正常形成**（防"什么都不做也能过"）
N-3 正控  既有 legacy 记忆的资格 = UNCONFIRMED_ORIGIN ∧ `memory_records.authority` **逐字节未变**
N-4 恢复  规则版本回退 ⇒ 资格恢复 ESTABLISHED ∧ 账本**未被改写**（可回滚且不伪造历史）
N-5 正控  `contaminatedMemories()` 仍 = 0（**不得**把新状态算成污染）
N-6 自检  受影响条目数 / 受影响脚本数必须 > 0，否则 **MEASUREMENT INVALID**（不是 PASS）
```

**`N-3` 与 `N-6` 最重要**：前者证明"纠正资格"没有变成"改写历史"；
后者防的是"半径只有 2 条 ⇒ 门看起来全绿但其实什么都没量到"（AGENTS §6.8）。

### 4.3 激活记录与回滚（`DR-10`）

```text
激活 = 一次 **Privileged Cognitive Operation**（cognitive-integrity §4A）
  prepare / preview / warn / confirm（**用户显式确认**）/ execute / verify / audit
  audit → `docs/m5.1.1/M5.1.1-ADR-043-Activation-Record.md`（**追加**，不删旧记录）

回滚 = 同一条路径的第二次操作（版本回退 + **追加**一条记录）。
       **因为 4b 不向认知写入任何东西，回滚是精确且免费的。**
```

**为什么不用 runtime flag**：`on/off` 开关会让"她信什么"取决于进程环境 ⇒
出现**两个行为真相**（两套都要测、两套都会腐坏 —— M4.1 的教训）。
规则版本是**代码 + 文档 + 证据**三处一致的单点，可被门断言。

---

## 5. Consequences（对既有里程碑的影响面）

| 受影响面 | 变更类型 | 必须跑的 |
|---|---|---|
| `src/kernel/contracts/**`（qualification 类型与派生、`ProcessorEventView` 加读数） | **追加** | `kernel:test` + `kernel:verify` |
| `src/kernel/app/memory/extractor.ts`（**冻结区**） | **追加一道闸**（不改既有闸判据） | `m4:test` + `m4:verify` + `m4:mutation-safety:verify` + `m4:nl-mutation:verify` + `eval:m4` |
| `src/kernel/recall/**`（ranking / eligibility / render） | 判据**追加** | `m5:test` + `m5:verify` + `m5:metrics:verify` + `m5:nl-e2e:verify` |
| `renderMemoryEntry` 输出 | **prompt 字节变化** | `m3.5:test` ⇒ 需 `pnpm m3.5:baseline` 重刷并说明理由 |
| `src/infrastructure/persistence/memory-store.ts` | **只加一个新探针**（既有探针不动） | `m4:verify` + `m4:isolation:verify` |
| `src/infrastructure/dev/**` + `developer-query` 契约 | DTO **追加**资格字段 | `m5.1:test` + `m5.1:query:verify` + `m5.1:control:verify` + `m5.1:page:verify` |
| 观测 / 分类法 | 新理由码与计数登记 | `m5.1:observability:verify` + `m5.1:measurement:verify` |
| 真实链路 | 行为变化 | **`m4.5:ci:full`（Live Smoke）**；本机无 key ⇒ `NOT RUN`，**不得 mock** |
| `M5.1-D01` 状态 | **本 ADR 不动** | 见 `DR-12` |
| 阶段 5（日落 `actor_type`） | **不在本 ADR** | 需 `Compatibility-Matrix.md` §4 四条日落条件 |

**正面后果**：

```text
· `M5.1-D01` 第一次有了**可执行的关闭路径**（4a + 4b + Live Smoke + 批准）
· "以用户身份替发"不再能取得认知权威；而账本**未损失**任何信息（角色仍照记）
· 纠正资格**可回滚且不伪造历史**（派生量的性质）
· 六道 M4 门的既有判据**字面保持成立**（`DR-9`）
```

---

## 6. Limits（已知局限 —— **不主张**清单）

```text
L-1  存量半径只有 2 条，但语义变化很大。不得因为 N 小就说"影响可以忽略"：
     这两条正是 D01 的原始触发点；真正的风险在**未来**（任何一次"以用户身份替发"）。
L-2  **4a 的爆炸半径在本 ADR 冻结时仍未测量。** §2.3 给的是**候选清单**
     （51 个文件 / 95 处 USER_EXPLICIT / 45 处 createConversationEvent），**不是**受影响清单。
     4-preflight 必须把它变成精确清单；在那之前 4a **不得开工**。
L-3  ⑧「她不能再说'你告诉过我'」**不是机械保证**。机械保证只到采信 / 排序 / prompt 标签。
     措辞正确性只能由 Live Smoke 与 eval 场景**观察**。本 ADR **不**造启发式回复守卫。
L-4  `attribution_origin IS NULL` 无法区分"M5.1.1 之前写的"与"之后的非受信路径写的"。
     因此**不按时间豁免**；代价是 M3/M4 夹具必须改走生产 ingress。
L-5  本 ADR 不解决 U-16/U-17（11 类 CognitiveOrigin）与 U-19（外部审计 sink）。
L-6  本 ADR 不新增任何注入入口。
L-7  `m4.5:ci:full`（Live Smoke）在**已记录的 WP10-A/C/D 证据里**是 `NOT RUN`。
     ⚠️ **2026-09-19 更正（原文保留在上行）**：那几道门（`wp10a` / `wp10b` / `wp10c`）
     只 import `node:*`，**没有加载 `.env`**，所以它们读到的 `process.env.OPENAI_API_KEY`
     是空的 —— 那是**门的环境**，**不是本机没有 key**。原句把二者混为一谈。
     ⇒ 准确表述：**那三步确实没有跑 Live Smoke**（这才是 `NOT RUN` 的依据）；
       "本机有没有 key"与它无关，机器上 `.env` 里**有** key。
     用户 2026-09-19 另定：真实聊天用 `.env` 的原 key，**执行测试用 `.env.test` 的测试端点**
     （`pnpm with-test-model <命令>`）；预算无上限。
     ⇒ `DR-12` 的"D01 可关闭"在本机**当前不可达成**；这一条必须如实带进 Gate-Decision。
L-8  本 ADR 的审查没有打开真实库、没有改任何数据。
```

---

## 7. Alternatives（被否决的备选，逐条记下理由）

| # | 备选 | 否决理由 |
|---|---|---|
| **ALT-1** | **重算**并落库 `memory_records.authority`（U-06 的 B） | 对既有认知状态的**追溯性静默重写**，违反原草案 §4 第 2 条与 `INV-CI-05`；append-only 下"改回来"没有可靠路径 |
| **ALT-2** | **不处理**（U-06 的 A） | 把**已知可能错误**的认知资格永久固化；D01 永远关不掉 |
| **ALT-3** | **扩展 `MemoryAuthority`** 加 `UNCONFIRMED_ORIGIN` | §3.5 三条独立理由 |
| **ALT-4** | 双参纯函数 `canSupportExternalFact(authority, attribution)`（U-09 的 B） | **部分采纳**：增加了输入，但加在**新的派生量**上；否则 M3 契约测试面被改，且"来源未确立"会**藏在第二个参数里、不可查询不可审计** |
| **ALT-5** | 用 `MemoryStatus` 表达"资格失效" | **D01 的同型错误**：`status` 是**记录的**生命周期决定、有自己的 provenance；合并后"她曾经相信什么"与"现在还认不认"再次无法分别回答 |
| **ALT-6** | 用**写入期**机制阻止这类事件成为 `user_statement`（U-09 的 C） | 与 ADR-042 D8「`actor_type` 由 event family 决定」冲突；且会**丢掉一个真事实**（这条消息确实占据 user 角色） |
| **ALT-7** | 用 **runtime flag** 控制 Phase 4 | 制造**两个行为真相**（M4.1 的教训）。改用规则版本 |
| **ALT-8** | 加**启发式回复守卫**拦"你告诉过我…" | 会**假绿**的量具（AGENTS §6.2 的原题）：正则会拦住措辞，拦不住语义 |
| **ALT-9** | 按**写入时间**豁免 M5.1.1 之前的行 | `attribution_origin IS NULL` **不携带时间信息** ⇒ 会留一个**永久后门**（`L-4`） |
| **ALT-10** | 为测试保留"调用方自报也算已确立"的后门 | cognitive-integrity §20：**不得因为"只是临时测试"而获得例外** |
| **ALT-11** | 一次做完 4a + 4b | 4a 不可逆、4b 可回滚；混在一起出问题无法归因 |
| **ALT-12** | 直接关闭 `M5.1-D01`（理由：设计已定稿） | 与 ADR-042 已确立的纪律逐字冲突：**ADR 批准 ≠ D01 关闭**（`DR-12`） |

---

## 8. Status Vocabulary（本 ADR 生效后各对象的状态）

```text
ADR-043                  ACCEPTED / DESIGN FROZEN
Phase 4                  NOT RUN（闸 = ADR-043 已批准；待 `4-preflight`，**不得直接开工**）
4-preflight              NOT RUN
4a / 4b                  NOT RUN
M5.1-D01                 **P1 OPEN**（关闭需 4a + 4b + Live Smoke + 用户批准）
M5.1.1 Final             **BLOCKED**
```

**原文纪律保持不变**：不得写 `M5.1.1 PASS`；不得写 `D01 CLOSED`；即使 Phase 1–3 全绿。
