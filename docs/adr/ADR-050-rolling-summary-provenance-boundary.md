# ADR-050 — Rolling Summary 的来源边界与行为契约

```text
状态        : **ACCEPTED / DESIGN FROZEN**（用户 2026-09-21 裁定：D-1 / D-2 / R-2 / R-3 **全部按建议获批**，见 §10）
编号        : ADR-050（现场选取：ADR-049 已占；本文件不预占、不覆写 ADR-049）
编制日期    : 2026-09-21（Asia/Shanghai）
冻结日期    : 2026-09-21（Asia/Shanghai）
归属里程碑  : M6（Lv1 Hardening）· WP1（设计冻结与验收契约）
前序依据    : `M6-DSH-Execution-Plan.md` §3.1 / §3.2 / §6(WP1) · ADR-042 · ADR-043 · ADR-044
副产物      : `docs/m6/M6-Acceptance-Contract.md`（要求矩阵、样例、门与分母）
```

> **本 ADR 的效力声明**：§1 的 12 条裁定与 §9 的四项裁定**已由用户 2026-09-21 批准**
> （记录见 §10），因此本文件自即日起为**冻结设计**：实现（WP2 起）必须逐条满足 §1 与 §3，
> **不得**在实现过程中偷换形态（例如把抽取式换成自由生成 —— 那是另一个 ADR）。
> 若实现证明 §3 不可行，必须先提交失败实例与差距，再申请修订，**不得**在验收途中改设计。

---

## 0. Context（为什么需要它）

### 0.1 一句话

`ContextSectionKind = 'rollup'` 与 `SECTION_PRIORITY.rollup = 20` 从 M5 起就在契约里，
但**到今天为止没有任何 provider 产出它**（全仓 `'rollup'` 只出现在
`src/kernel/contracts/context.ts:65` 与 `:116`；`sections.ts:303` 只是把
recent-conversation 的优先级设成 `rollup + 10`）。于是"历史放不进上下文时，
哪些内容被保留、压缩、排除，理由是什么"这个问题**今天没有答案**。

### 0.2 现场事实（WP0 只读核对所得，可复核）

| 事实 | 位置 |
|---|---|
| Recent Conversation 窗口 = **16 条**（可配） | `src/kernel/context/sections.ts:277`、`:789` |
| 唯一 prompt 入口 = `createContextCompiler`（唯一裁剪算法） | `src/kernel/contracts/context.ts:380` |
| 扩展点 `extraProviders` 已存在，生产装配在 turn 层 | `sections.ts:722/739/791`、`turn-gateway.ts:868-972` |
| 冻结 prompt 基线**不经过 `extraProviders`** | `scripts/m3.5-prompt-baseline.ts:135` |
| `ContextBudget` 4 个**必填**字段、6 类 `ContextCategory` | `src/kernel/recall/selector.ts:53-97` |
| 资格派生已存在且**只有一个实现** | `src/kernel/recall/qualification.ts`、`contracts/attribution.ts:2583` |
| 受信读数只接受 `attribution_origin = 'RECORDED'` | `contracts/attribution.ts:2516-2565` |
| README 明确"Rolling Summary **仍未实现**" | `README.md:51` |

### 0.3 这个 ADR 要回答的三个问题

```text
① 摘要里的每一条**凭什么**可以进这一轮的 prompt？        → §3.2 来源资格
② 它**不是**什么（不是记忆、不是事实、不是第二个权威）？  → §1 DR-1 / DR-2
③ 它怎么**失效**（纠正 / 遗忘 / 撤回 / 资格变化）？        → §3.4 失效规则
```

---

## 1. Decision（12 条**拟定**裁定，待 §9 放行）

| # | 拟定裁定 |
|---|---|
| **DR-1** | 摘要是**派生上下文**，不是 `MemoryRecord`、不是 DomainEvent、不是事实账本、不是第二个事实权威。**它零写入**：不新增/修改任何持久行，不改 Seed、关系、状态或记忆。 |
| **DR-2** | v1 是**抽取式**（**逐字摘录**），**禁止**改写、概括、合并、翻译、补全。理由：任何改写都会产生一条**新的断言**，而那条断言没有来源 —— 直接违反 `INV-CI-05`（历史可以纠正，不可伪造）。**v1 不引入任何一次模型调用**。 |
| **DR-3** | 每条摘取项必须满足 **`sourceQualificationOf(trustedOriginReadingOf(...)) === 'ESTABLISHED'`**。**不得**以 `actorType === 'user'` 放行。`UNCONFIRMED_ORIGIN` 与 `CONTRADICTED_ORIGIN` **都不入选**，且**分别记录**拒绝理由（三值不可互相折叠）。 |
| **DR-4** | v1 **只**处理**用户来源的对话事件**（`type = 'user_message'` 且受信归因为用户内容）。助手自由文本、`tool_event`、`system_event`、外部证据 / 搜索 snippet / 网页正文 / 来源附录**一律不进**摘要。 |
| **DR-5** | 覆盖范围 = **当前会话**（`conversationId` = 角色 × 用户）× **有界序列窗口**；只覆盖 **Recent 窗口之外**的部分。与 Recent 的重叠按**来源 id 去重**（Recent 优先，摘要不重复同一来源）。 |
| **DR-6** | 资格**每轮重验**，**v1 不持久化、不缓存摘要文本**（按有界来源窗口重新派生）。因此纠正 / 遗忘 / 撤回 / `reset` / 资格变化在**下一轮**自动生效，不存在"靠 TTL 继续可用"的路径。 |
| **DR-7** | 预算走**新增**的 `ContextBudget.rollupTokens`（**缺省 0 = 关闭**）+ **第 7 类** `ContextCategory = 'rolling_summary'`；section `priority = SECTION_PRIORITY.rollup`（20，**最低**）、`droppable: true`。**永不**挤掉不可裁项（identity / integrity-rules / 当前输入 / 程序结果事实）。 |
| **DR-8** | 接线点**只能**是 `turn-gateway.ts` 的 `extraProviders`；**禁止**放进 `buildContextCompilerV2` 的默认 provider 列表。⇒ 冻结 prompt 基线（`evals/fixtures/m3.5/prompt-baseline.txt`）**一字节不动**；"空集合 ⇒ 产 0 个 section"是这条承诺的**机制**（沿用 `turn-gateway.ts:932-933`、`sections.ts:522-524` 的既有约定）。 |
| **DR-9** | trace 只记**引用与计数**：`sectionId` · `sourceRefs` · 条目数 · 覆盖序列范围（watermark 上界）· 每类拒绝理由计数 · 是否被裁。**禁止**把摘要正文写进 trace / 遥测 / 账本（沿用 `serializeContextBundleForTrace` 的既有纪律）。 |
| **DR-10** | **失败关闭**：来源查询失败、资格读不到、形状坏、超出扫描上限且无法证明覆盖 ⇒ **产 0 个 section** 并记降级理由。**绝不**回落到"随手拼几条旧句子"。 |
| **DR-11** | **不新增 runtime flag、不新增控制命令**（沿用 ADR-043 `DR-10`）。"开"与"关"由**额度是否为 0** 表达（先例：ADR-045 的 `externalEvidenceTokens` 缺省 0）。生产启用属于**独立裁定**（先例：ADR-048）。 |
| **DR-12** | **回滚** = 把 `rollupTokens` 归 0（或移除 provider 接线）。因为本设计**不写任何东西**，回滚不需要清理任何持久数据；也不需要重建任何投影。 |

---

## 2. Inspect（裁定所依据的读数）

### 2.1 资格链路的三个既有实现（**复用，不重写**）

```text
受信读数       trustedOriginReadingOf({attributionOrigin, contentOriginator, axisB})
               contracts/attribution.ts:2550
                 · attributionOrigin !== 'RECORDED'  → undefined（失败关闭）
                 · contentOriginator 缺失 / 形状坏     → undefined
                 · 其余 → { contentOriginator, axisBConfirmed }

单条来源资格   sourceQualificationOf(reading)          attribution.ts:2583
                 · undefined                → UNCONFIRMED_ORIGIN
                 · !axisBConfirmed          → UNCONFIRMED_ORIGIN
                 · Known(USER)              → ESTABLISHED
                 · Known(其他位次)           → CONTRADICTED_ORIGIN
                 · Unknown / Absent         → UNCONFIRMED_ORIGIN

记忆级资格     memoryQualificationOf({memoryType, rootReadings, ruleVersion})   recall/qualification.ts:71
                 规则版本 COGNITIVE_QUALIFICATION_RULE_VERSION = 1（attribution.ts:2581）
```

**纪律**：本 ADR **不新增**第二个资格实现。摘取项用的是**同一个** `sourceQualificationOf`。

### 2.2 一个必须写明的后果（**v1 在既有真实历史上会选出 0 条**）

`attribution_origin` 只对 **v7 之后、走升级写入路径**的事件是 `'RECORDED'`；
历史行是 `MIGRATED_LEGACY` 或 NULL，按 `DR-7`（ADR-043）一律 `UNCONFIRMED_ORIGIN`。
M5.1.1 的影响半径报告已记录既有根证据 `contentOriginator = Unknown / Absent (LEGACY_UNRECORDED)`。

⇒ **结论（写进验收契约，不掩饰）**：v1 的摘要**只可能包含"新的、有受信归因的用户发言"**。
在本机既有真实历史上，合法的摘取项数**是 0** —— 这是**正确的失败关闭**，不是缺陷。
其后果是：WP7 / WP9b 的合成夹具**必须真的产生受信归因**（走升级写入路径），
不能拿 legacy 行凑数；否则那批用例会"因为摘要永远为空而全绿"（假绿）。

---

## 3. Design

### 3.1 契约（**拟定**字段名，WP2 落地时以既有类型为准）

```ts
/** 一条摘取项 —— **逐字**来自一个对话事件，不带任何派生措辞 */
interface RollupItem {
  /** 来源对话事件 id（唯一去重键） */
  sourceEventId: ConversationEventId
  /** 来源序列（用于排序与 watermark） */
  sequence: number
  /** **逐字**摘录：来源事件 content 的原文（只允许替换换行，不允许改字） */
  text: string
  /**
   * 程序派生的资格读数。**不是**"已证实"标签，只是"来源确立"的机械结论。
   * 只有 'ESTABLISHED' 能进本结构 —— 另两个值在**选择阶段**就被拒。
   */
  qualification: 'ESTABLISHED'
  /** 生成这份读数时的规则版本（可解释地复现"当时凭什么"） */
  ruleVersion: number
}

/** 一轮的摘要产物（**不落库**） */
interface RollingSummary {
  conversationId: ConversationId
  owner: EntityRef
  userId: EntityRef
  items: readonly RollupItem[]
  /** 覆盖的序列范围（**上界必须如实给出**，超限就是覆盖不足的证据） */
  coveredSequenceRange: { from: number; to: number }
  /** 扫描上限（决定性；超限即 `coverageTruncated = true`） */
  scannedEventCount: number
  /** 窗口内有资格但因预算/上限**未入选**的条数（如实降级，不静默） */
  omittedEligibleCount: number
  coverageTruncated: boolean
  /** 每类拒绝理由的计数（**闭集**，不含正文） */
  rejections: { unconfirmedOrigin: number; contradictedOrigin: number; nonUserSource: number; invalidatedByMemoryState: number; outOfScope: number }
  /** 生成摘要的策略版本（改了就是新版本，进 trace 可比对） */
  selectorVersion: string
}
```

**字段取舍说明**：契约里**没有** `estimatedTokens` / `renderedText` —— 前者由编译器统一量化
（"估算的就是注入的"），后者由渲染函数产出，二者都不该在数据契约里出现第二遍。

### 3.2 选择算法（判定顺序即优先级；任一步失败 = 该项不入选并计数）

```text
输入：conversationId · userId · recentWindow（编译器用的同一个 limit）· scanCeiling · tokenBudget.rollupTokens

① 作用域闸：只取本 conversationId 的事件；非本会话 → outOfScope
② 上限闸：只取 sequence > watermark(recentWindow) 的部分；超过 scanCeiling → 停止并标 coverageTruncated = true
③ 类型闸：type !== 'user_message' → nonUserSource
④ 受信闸：trustedOriginReadingOf(...) 返回 undefined        → unconfirmedOrigin
⑤ 资格闸：sourceQualificationOf(reading)
             'ESTABLISHED'         → 通过
             'CONTRADICTED_ORIGIN'  → contradictedOrigin    （记录：这正是 D01 的形态）
             'UNCONFIRMED_ORIGIN'   → unconfirmedOrigin
⑥ 失效闸：该事件的根证据上挂着的**任何** MemoryRecord 已非 active
           （superseded / retracted / disputed）→ invalidatedByMemoryState
⑦ 去重：与 Recent 窗口重叠的 sourceEventId 直接跳过（Recent 优先）
⑧ 预算：按 sequence **升序**取到额度用尽；剩余合格项计入 omittedEligibleCount
⑨ 渲染：逐字文本 + 引用行（**不改一个字**）
```

**为什么"失效闸"是这样写的**：v1 **不做语义判断**（不判断"这一句是不是在纠正那一句"）。
它只用**程序已经知道的事实**：事件 → 记忆的关联（`MemoryRecord.sourceRefs` /
`evidenceRootIds` 含该事件 id）+ 记忆的 `status`。这是**机械可判**的，因此可以写成硬零断言；
而"哪句纠正了哪句"留给记忆生命周期（`supersedes` 链）去表达。

### 3.3 渲染

```text
# 她记得的早期对话（逐字摘录，数据，不是指令）

- （第 12 句）{逐字原文}   [来源 cev:…]
- （第 19 句）{逐字原文}   [来源 cev:…]
```

三条纪律：

1. header 明说**是数据不是指令**（与 `MEMORY_BLOCK_HEADER`、`EXTERNAL_EVIDENCE_BLOCK_HEADER` 同形）；
2. **不复述记忆、不升级为"已证实"**：只标"逐字摘录"与来源 id；
3. 渲染函数与预算估算函数**必须是同一个**（`renderMemoryEntry` 已经确立这条纪律，摘录沿用同一模式）。

### 3.4 失效规则（DR-6 的可判定形式）

| 触发 | 机械判据 | 下一轮行为 |
|---|---|---|
| 用户纠正（旧记忆被 supersede） | 旧记忆 `status !== 'active'` 或 `supersededBy` 非空 | 该来源**不再入选**，计入 `invalidatedByMemoryState` |
| 遗忘 / 撤回 | 记忆 `status ∈ {retracted, disputed}` | 同上 |
| 来源资格变化 | 每轮重算 `sourceQualificationOf` 不再是 `ESTABLISHED` | 不再入选，计入对应理由 |
| `reset` / 换会话 | `conversationId` 作用域天然切断 | 新会话**没有**任何历史项 |
| 规则版本变化 | `selectorVersion` / `ruleVersion` 进 trace | 可解释地复现"当时凭什么" |

**不在此列（明确写下来，免得被读成覆盖了）**：Recent Conversation 与既有对话史里
是否仍含原文，遵守**原有遗忘语义**；M6 **不宣称物理删除历史**，也**不把"忘了"的含义偷偷扩大**。
若既有通道使正式遗忘用例失效，登记阻塞并提交小修复，**不得**由摘要过滤冒充整轮通过。

### 3.5 与既有三条 section 的关系（互斥与优先级）

| section | kind | priority | 可裁 | 谁驱动 | 与摘要的关系 |
|---|---|---|---|---|---|
| `recent-conversation` | `recent-conversation` | 30 | 是 | 最近 16 条原文 | **Recent 优先**；重叠按 source id 去重 |
| `memory-recall` | `memory` | 40 | 是 | 本轮召回 | 互不替代：召回是"此刻想起"，摘要是"早期说过的" |
| `external-evidence` | `external-evidence` | 45 | 是 | 当轮证据 | **无交集**（DR-4 禁止外部内容进摘要） |
| **`rolling-summary`（拟）** | `rollup` | **20** | 是 | 有界来源窗口 | 最低 ⇒ **先被裁** |

---

## 4. 效果矩阵（这个 ADR 对 M6 六个问题的答案）

| M6 §0 的问题 | 本 ADR 的答案 | 不覆盖的部分 |
|---|---|---|
| ① 500 轮/切会话/重启后身份与记忆是否连续 | 部分：早期**受信用户发言**可被逐字带过 Recent 窗口 | 重启一致性属 WP6b；身份连续属既有 Seed/投影 |
| ② 哪些内容被保留/压缩/排除，理由是什么 | **是**：每类拒绝理由都有闭集计数，覆盖范围有 watermark | 覆盖不足时如实标 `coverageTruncated` |
| ③ 纠正/遗忘/来源降档后旧内容是否从旁路回来 | **是**（机械判据，见 §3.4），对"摘要"这条旁路成立 | 其它旁路（Recent/历史）单列报告 |
| ④ "记住了/做了/查到了"是否一致 | 否（属 WP6a 的行动与搜索真相） | 全部 |
| ⑤ 断网/模型失败/中断/恢复是否诚实降级 | 部分：摘要失败即产 0 section（DR-10） | 其余属 WP6a/WP6b |
| ⑥ 开发者能否沿同一 trace 找原因 | **是**：引用与计数进 trace（DR-9） | 页面呈现属 WP5 |

---

## 5. Cognitive Integrity 审查结论

依据 `docs/architecture/cognitive-integrity.md`（**Sovereign Core 约束**，效力高于组件设计）。

### 5.1 分类结论

```text
本功能**不写任何持久认知状态**          ⇒ 不是 §4.A 的 Cognitive Intervention
但它确实改变**未来模型输入**            ⇒ 落在 §16 的约束范围内（"自动总结"被明文点名）
⇒ 结论：**不属于 Privileged Cognitive Operation**（无需 §5 警告 / §6 二次确认 / §7 操作者身份），
        但**必须**满足 §16 的"只能提交 evidence / assertion / observation / proposal，
        不能自行宣布 final cognitive truth"。
```

### 5.2 逐条不变量核对

| 不变量 | 本设计如何满足 | 机器判据（拟） |
|---|---|---|
| `INV-CI-01` No Cognitive State Without Provenance | 每条摘取项**必有** `sourceEventId` + `sourceRefs` + 程序派生资格；无来源的项在结构上不可能存在 | 无 `sourceRefs` 的 item 数 = 0 |
| `INV-CI-02` External Access Does Not Imply Cognitive Authority | 摘要**不升级**任何东西的资格：`ESTABLISHED` 是入选**门槛**而非产出标签；渲染明确写"逐字摘录" | 摘要正文中出现"已证实/确认/确认为真"类升级措辞的条数 = 0 |
| `INV-CI-03` Maintenance Must Never Masquerade as Experience | 维护/导入/迁移产生的 legacy 行**一律不入摘要**（`MIGRATED_LEGACY → UNCONFIRMED_ORIGIN`） | 来源 `attribution_origin !== 'RECORDED'` 的 item 数 = 0 |
| `INV-CI-04` Intervention Must Be Explicit / Warned / Authorized / Audited / Verifiable | 本设计不构成干预；**审计**由 trace 承担（DR-9） | trace 中摘要的引用/计数**存在**且非零 |
| `INV-CI-05` History May Be Corrected, But Must Not Be Falsified | **禁止改写**（DR-2）+ **失效规则**（§3.4）⇒ 既不伪造新断言，也不复活已被纠正的内容 | 非 `active` 记忆所挂来源的 item 数 = 0 |

### 5.3 顺序硬约束（AGENTS §4）

```text
"归因（M5.1-D01）必须先于任何注入入口落地"
⇒ M5.1-D01 = CLOSED（ADR-044，2026-09-20）           ✅ 前置已满足
⇒ 但 D01 的关闭只买到"可查/可审计/可降档"（ADR-043 DR-11）
⇒ 本设计**不**主张"她不会再说错" —— 措辞层没有启发式守卫，这条照旧
```

### 5.4 审查提出的两条**必须写进验收契约**的限制

1. **摘要不是"记忆"的替代**：它**不能**让未通过资格闸的内容进 prompt；
   它**也不能**因为"只是上下文"而被解释成不受约束（§16 明文反例："只是临时测试"不构成例外）。
2. **正文不进 trace 的边界要可证**：DR-9 必须由门断言（正控：引用与计数在；
   负控：把正文塞进 trace 的注入必须让门失败）。

---

## 6. Landing（拟：与 M6 工作包的对应）

| 步 | 做什么 | 出口 | 门 |
|---|---|---|---|
| WP2 | 纯逻辑：契约 + 选择 + 渲染 + 失效（领域层，无 IO、无模型 SDK） | 部件门 PASS | `typecheck` · `kernel:test` · `kernel:verify` · 新 rollup 部件门 |
| WP3 | 接线：`turn-gateway` 的 `extraProviders` + 只读来源端口 + 预算 | 接线门 PASS | `m3.5:test` · `eval:scenarios` · `eval:dryrun` · `eval:providers` · `m5:budget:verify` |
| WP4 | 量具资格化：正控/负控/恢复 + 第 5 条负控（"永远不摘要也能全绿"必须被抓住） | `HARNESS QUALIFIED` | 新量具门 + `m6:measurement:verify` |
| WP5 | 开发者面：来源数量/范围/拒绝理由/是否被裁 | 页面与真相一致 | `m5.1:*` 五门 |

---

## 7. Consequences

**好处**：① 让"历史压缩"第一次有机械判据；② 复用资格链，不产生第二套方言；
③ 因为不写、不缓存、不调模型，回滚与失效都是**平凡**的；
④ 与既有 `extraProviders` 约定同形 ⇒ 冻结 prompt 基线可不动。

**代价**：① `ContextBudget` 新增必填字段会波及约 10 处字面量（`typecheck` 全部能找到，失败关闭）；
② `ContextCategory` 变 7 类，`m5:budget:verify` 的断言必须**同步更新**（不是放宽）；
③ R-2 的选择会影响"要不要重刷冻结基线"这一程序动作。

---

## 8. Limits（**不主张**清单）

1. 不主张摘要是"完整的长期记忆压缩" —— 它是**有界窗口内的逐字摘录**；
2. 不主张覆盖全部历史 —— 超限如实标 `coverageTruncated`，旧信息由 M5 合法召回承接；
3. 不主张"她不会再说错"（`DR-11` 照旧）；
4. 不主张物理删除历史，也不扩大"忘记"的含义；
5. 不主张摘要能提升回答质量 —— 质量阈值属 M6-D3（WP9a 才校准）；
6. 不主张在既有真实历史上会有内容（§2.2：v1 在那里选出 0 条，这是失败关闭而非缺陷）。

---

## 9. 裁定包（**这一节是 ADR 的出口**）

| ID | 裁定项 | 选项 | 建议 | 不选的后果 |
|---|---|---|---|---|
| **D-1** | M6 / G1 与原始 Lv1 的范围关系 | ① 按计划 §0.1 三分（M6 工程 / G1 综合 / 原始 Lv1 保留 `PARTIAL`）② 要求 G1 覆盖原始 Lv1 每一项 | **①** | 选②则 G1 必须等状态演化能力，M6 不能收口 |
| **D-2** | 摘要实现形态 | ① 抽取式、逐字、引用保留、不持久化、不调模型（本 ADR §1）② 先做自由生成摘要再补来源约束 | **①** | 选②会立刻引入模型调用、幻觉、输出验证与超时，且新增正文的长期保存问题 |
| **R-2** | provider 插入点 / prompt 基线承诺 | ① 走 `extraProviders`，**承诺冻结基线一字节不动**，并新增负控"摘要为空时 packet.text 与基线逐字节相同" ② 放进工厂默认列表，按程序重刷基线 | **①** | 选②要改 `evals/fixtures/m3.5/prompt-baseline.txt` 并刷新基线，属"有意改 prompt" |
| **R-3** | 摘要额度落点 | ① 新增必填 `rollupTokens`（缺省 0）+ 第 7 类 `rolling_summary`，同步改 `m5:budget:verify` 断言 ② 复用 `reservedTokens` 内部切分 | **①** | 选②零契约变更，但"摘要能占多少"变成不可审阅的隐含值；且与 ADR-045 的先例不一致 |

**裁定后**：本文件状态已置为 `ACCEPTED / DESIGN FROZEN`（见 §10）。
**在裁定之前**：不得进入 WP2（计划书 WP1 的出口条件）—— 该条件已于 2026-09-21 满足。

---

## 10. 裁定记录（用户 2026-09-21）

```text
裁定人    : 用户（经 DSH 的裁定包提问，一次性回答）
裁定日期  : 2026-09-21（Asia/Shanghai）
裁定方式  : 四项各自二选一，**全部选择"建议"项**
```

| ID | 裁定项 | 用户裁定 | 含义 |
|---|---|---|---|
| **D-1** | M6 / G1 与原始 Lv1 的范围关系 | **① 三分状态** | `M6` 工程验收 / `G1` 当前阶段综合验收 / `Original Lv1 = PARTIAL`（状态演化仍延期 M7）。**不得**借 `G1 = PASS` 宣布原始 Lv1 完成 |
| **D-2** | 摘要实现形态 | **① 抽取式逐字** | 零写入、零模型调用、引用保留、**不持久化**；资格用既有 `sourceQualificationOf` 派生 |
| **R-2** | provider 插入点 / prompt 基线 | **① 走 `extraProviders`** | **承诺冻结 prompt 基线一字节不动**（不重刷 `evals/fixtures/m3.5/prompt-baseline.txt`），并新增负控"摘要为空时 `packet.text` 与基线逐字节相同" |
| **R-3** | 摘要额度落点 | **① 新增必填 `rollupTokens: 0` + 第 7 类 `rolling_summary`** | 同步更新 `assertContextBudget` / `planContextBudget` / `pnpm m5:budget:verify` 的断言（**不是**放宽分母） |
| 附 | 执行范围 | **① 批准后直接进 WP2** | 沿用计划书 §4"不每个 WP 重复询问"；WP2 = 领域层纯逻辑 + 部件门，**不接线、不碰真实库** |

**四项裁定的直接约束（实现时逐条对照）**：

1. `DR-2` 的"逐字"是**硬性质**：渲染出的 item 文本必须与来源事件 `content` 逐字相等（只允许换行处理）；
2. `DR-3` 的资格闸**只有** `ESTABLISHED` 能过；`actorType === 'user'` 单独成立**不构成**理由；
3. `DR-8` 的插入点**只有** `extraProviders`；把 provider 放进 `buildContextCompilerV2` 默认列表**违反**本次裁定；
4. `DR-7` 的 `rollupTokens` 是**必填**字段、缺省 **0**；`ContextCategory` 变 **7 类**。

**本次裁定没有授权的事**（照旧）：WP3 及以后的接线 · Live 门 · 生产激活 · 真实库迁移/恢复 ·
`m6-complete` 标签 · 合并 · M7+ 任何能力。
