# M4 人工审计记录（计划书第 217 节的 Gate）

- **日期**：2026-09-17
- **被测 commit**：`3121cfc`（M4 acceptance candidate）
- **Gate 原文**（计划书第 217 节）：

  > 在进入 M5 前随机抽取：至少数十条正式 Memory，人工审计：
  > 这条东西真的值得记吗？来源正确吗？谁说的？是不是模型猜的？
  > 当前还有效吗？有没有重复？旧版本在哪里？为什么建立？
  > 如果这些问题不能快速回答：M4 不通过。

- **结果**：**37 / 37 条记录、8 / 8 个问题全部可回答**（无一条答不出来）
- **复现命令**：`pnpm m4:audit`（沙箱部分）＋ `pnpm memory:audit --limit 50`（真实库部分，只读）

---

## 1. 审计对象：两个分区，**不混用**

真实库 `data/pglite` 目前只有 **2 条**记忆 —— 不是"她没什么可记"，
是真实使用量还没到那个规模。这一点在 `docs/m4/current-state.md` 里早已裁定：

> 审计对象必须是 ① `evals/m4` 场景在沙箱里产出的记忆
> + ② 真实库随日常使用增长的部分；
> **不能用沙箱数据冒充实库数据**，必须在验收报告里如实写明。

因此本文严格分两区：

| 分区 | 来源 | 条数 | 性质 |
|---|---|---|---|
| **A. 真实库** | `data/pglite`，`pnpm memory:audit --limit 50`（**只读**） | **2** | **穷举**（库里全部记录） |
| **B. 沙箱语料** | `pnpm m4:audit`（`isolateDatabase` 临时库） | **35** | **构造**（覆盖各种形状，**不是**随机抽样） |

**关于"随机抽取"的诚实说明**：第 217 节的措辞是"随机抽取"。
真实库那部分是**穷举**（只有 2 条），沙箱那部分是**按形状构造**的语料，
不是随机样本。构造的理由是：第 ⑤ 问（当前还有效吗）与第 ⑦ 问（旧版本在哪里）
**只有在 superseded / retracted / disputed / 有 revision 链时才答得出来** ——
一份全是 ACTIVE 新建记忆的随机样本会让这两问的答案永远是"无"，
于是它们**看起来都答得出来，其实一次都没被考到**。

**证据文件**：
- `artifacts/m4-acceptance/audit/real-db-audit.txt`（真实库原始输出）
- `artifacts/m4-acceptance/audit/audit-corpus.txt`（沙箱 35 条 × 8 问，由**生产同一套** `renderMemoryAudit()` 渲染）
- `artifacts/m4-acceptance/audit/audit-corpus.json`（结构化：每条的状态 / 权威 / 认识状态 / 槽位 / 指纹 / 证据 / 指针）

---

## 2. 分区 A —— 真实库（2 条，穷举）

### A-1 `person_fact-8d64c71c49424b51`

| # | 问题 | 答案 |
|---|---|---|
| ① | 真的值得记吗 | importance = **0.80**；内容 `education.institution = 示例工程科技大学` —— 用户显式授权写入的稳定身份事实，值得 |
| ② | 来源正确吗 | `conversation_event:cev:…:dm-sumuwei-b8ec0760:27` —— 证据指向**真实账本**里的一句话，非合成 id |
| ③ | 谁说的 | `authority = EXPLICIT_USER_STATEMENT` |
| ④ | 是不是模型猜的 | `epistemic = reported`；权威不是 `CHARACTER_GENERATION` / `MODEL_INFERENCE` |
| ⑤ | 当前还有效吗 | **当前有效**（有效期开放，`validUntil = null`） |
| ⑥ | 有没有重复 | fingerprint `8d64c71c49424b51`；活跃记录中**无同指纹**（全库 2 条） |
| ⑦ | 旧版本在哪里 | supersedes =（无）—— 这条没有前身 |
| ⑧ | 为什么建立 | `explicit-memory@explicit-memory@1` —— 走的是**显式**路径（ADR-024） |

### A-2 `preference-d0696bd4b1e314c1`

| # | 问题 | 答案 |
|---|---|---|
| ① | 真的值得记吗 | importance = 0.80；内容 `education.institution = 是示例工程科技大学` —— **这条是错的**（见下） |
| ② | 来源正确吗 | `conversation_event:cev:…:dm-sumuwei-b8ec0760:23` —— 证据**真实存在**（溯源链没断） |
| ③ | 谁说的 | `authority = EXPLICIT_USER_STATEMENT` |
| ④ | 是不是模型猜的 | `epistemic = reported` |
| ⑤ | 当前还有效吗 | **已撤回**（`status = retracted`）—— 不再作为有效事实 |
| ⑥ | 有没有重复 | fingerprint `d0696bd4b1e314c1`；与 A-1 **不同指纹**（不同 type、不同取值），不是重复 |
| ⑦ | 旧版本在哪里 | supersedes =（无）；它由 A-1 **取代了语义**但没有建立 supersede 链（两条是 defect 修复关系，不是"事实演进"关系） |
| ⑧ | 为什么建立 | `explicit-memory@explicit-memory@1` |

**A-2 是什么**：它是 M4 修复前留下的错误记录 —— 抽取器当时写死 `type: 'preference'`、
自由文本取值带前导系词（"**是**示例工程科技大学"）。
它与 A-1 是"同一件事实被记到两个槽位"的活标本，
正是 M4-verification §5.6 记录的那类缺陷。

**它的处置是对的，也正是审计想看到的**：
按 **MI-06（旧事实默认不得物理覆盖）** 它被**保留为历史**并标 `retracted`，
而不是删掉。因此⑧能答、②能答、⑤能答 —— 一条**错误的**记忆，
其来源与处置**依然完全可追溯**。

> 顺带记录一个措辞问题（S4，不影响判定）：
> `memory:audit` 把 `retracted` 一律渲染成"**用户要求忘掉**"，
> 而 A-2 是因为**缺陷修复**被撤回的。判定正确、文案不准 ——
> 列进技术债，不阻断 M4。

---

## 3. 分区 B —— 沙箱语料（35 条）

### 3.1 构成

| 维度 | 覆盖 |
|---|---|
| 记录数 | **35**（active 30 / superseded 1 / retracted 1 / disputed 1） |
| 槽位型 | 10 条，**覆盖登记表里全部 10 个 predicate** |
| Episode | 24 条（无 canonical key —— 一段经历本来就不是"一个事实槽位"） |
| 认识状态 | `observed` / `reported` / `inferred` 三种都有 |
| confidence | 0.3 – 0.95（含"记不太清"的低置信度） |
| importance | 0.3 – 0.8 |
| revision 链 | 1 组：`f55021dd6b61686b`（superseded）→ `9e0f0fe7b97d8531`（active），**共用槽位 `5e54a5f9d26367a7`** |
| 遗忘 | 1 条 `retracted`（槽位 `2588b1bb882feba6`） |
| 存疑 | 1 条 `disputed`（槽位 `c2a590d4b645101e`） |
| 污染尝试 | 1 次：她的猜测（`CHARACTER_GENERATION`）→ **构造候选时即被拒** |

### 3.2 八个问题的答案分布

35 条 × 8 问 = **280 个问题**，逐条答案在 `audit-corpus.txt`（生产渲染器输出）。汇总：

| # | 问题 | 数据来源 | 可回答 |
|---|---|---|---|
| ① | 真的值得记吗 | `importance` / `confidence`（每条都有） | **35 / 35** |
| ② | 来源正确吗 | `sourceRefs` → 真实 `conversation_event`（每条至少 1 个 root 证据，`unsupported = 0`） | **35 / 35** |
| ③ | 谁说的 | `authority`（全部 `EXPLICIT_USER_STATEMENT` / `DIRECT_INTERACTION` 系） | **35 / 35** |
| ④ | 是不是模型猜的 | `epistemicStatus`；`contamination = 0`；且污染尝试在**构造时**被拒 | **35 / 35** |
| ⑤ | 当前还有效吗 | `status` 四态齐全（30 / 1 / 1 / 1），`validUntil` 三态可区分 | **35 / 35** |
| ⑥ | 有没有重复 | 活跃指纹两两不同（**0 组重复**，机械扫描） | **35 / 35** |
| ⑦ | 旧版本在哪里 | `supersededBy` / `supersedes` **双向**成立（缺指针 0 / 悬空 0 / 单向 0） | **35 / 35** |
| ⑧ | 为什么建立 | `processor@version` + 触发它的那条对话事件 | **35 / 35** |

### 3.3 逐形状抽样（完整 8 问）

**C. 槽位型 · 活跃**（`person_fact-…`，槽位 `539c6ff38ddc8076`，证据 `cev#1`）
① 0.80 值得｜② 指向真实对话事件｜③ `EXPLICIT_USER_STATEMENT`｜④ `reported`，非猜测
⑤ active，有效期开放｜⑥ 指纹唯一｜⑦ 无旧版本｜⑧ `memory-extractor@1`

**D. revision 链 · 修订**（`f55021dd6b61686b` → `9e0f0fe7b97d8531`，**同槽位 `5e54a5f9d26367a7`**）
① 新条 0.80｜② 新条证据 `cev#97`（"改一下：我现在主要用 Rider"）｜③ 显式用户陈述
④ `reported`｜⑤ **旧条 `superseded`（不再是现状，`validUntil` 已写）、新条 `active`**｜⑥ 两指纹不同
⑦ **旧条 `supersededBy` → 新条；新条 `supersedes` → 旧条（双向可追溯，MI-07）**｜⑧ `memory-extractor@1`

**E. 遗忘 · retracted**（`96e55bb68b0a1d8a`，槽位 `2588b1bb882feba6`）
⑤ **`retracted`，且不出现在 active 集合里（INV-04）**；记录本身**仍在库里**（逻辑遗忘 ≠ 物理删除，MI-08）
⑦ 无旧版本｜⑧ `memory-extractor@1`，由"忘掉这件事"那条事件触发

**F. 存疑 · disputed**（`f7d32c2d7ba00111`，槽位 `c2a590d4b645101e`）
⑤ **`disputed`（有矛盾陈述、尚未定论）**，内容**未被改写**（不擅自覆盖，计划书第 82 节）
⑧ 由"我从来不喜欢这个"那条事件触发

**G. 推断 · inferred**（episode `9192bf667dff1038`）
④ **`inferred`** —— 明确标成推断，而不是用户事实；且类型是 `episode`（不是 `person_fact`/`preference`），
因此它**不可能**被读成"用户说了什么"

**H. 低置信度 · 不确定**（episode `030f5748e7d2d78d`）
① importance 0.4｜④ `reported` 但 **confidence 0.3** —— 用户"记不太清"的陈述被如实降权，
而不是升格成确定事实（计划书第 55 节）

**I. 污染尝试 · 被拒**
构造 `person_fact` + `authority = CHARACTER_GENERATION` 的候选 →
**在 `createMemoryCandidate()` 里就抛 `authority_cannot_establish_person_fact`**，
根本到不了放行口。这正是计划书第 148 节要的"**结构上**不可能，
而不是靠 prompt 里的一句叮嘱"。

---

## 4. 这份审计**不能**当作证据的东西（如实划界）

1. **它不是"槽位级冲突处置"的证词。**
   沙箱语料走的是**直接提交路径**（`commitAndFold`），
   **没有**经过后台冲突分析器 —— 而"同一槽位不允许两条 ACTIVE"这条保证
   住在**流水线**里（`pipeline.ts` 的冲突分析），**不在 store 里**。
   槽位冲突处置的证据在 `m4:verify` §16（注入式固定抽取器 + 真实分析器）
   与 `m4:test`「冲突分析」分组。
   本语料**刻意**做到"每个槽位只有一条 ACTIVE"，以免伪造出槽位竞争。
2. **它不是随机样本。** 见 §1 的说明。真实库那部分才是穷举。
3. **它不覆盖"她自己说的话"。** 语料的 `authority` 全部来自用户或真实互动；
   "她的输出不能建立用户事实"由 `m4:test` 反污染分组（结构性）+ `eval:m4`
   注入型用例（`M4X-020/021/022`）覆盖，并由本次新加的 `M4X-050/051`
   （条件句 / 虚构）在真实模型档补上。

---

## 5. 结论

- 真实库 **2 / 2**、沙箱 **35 / 35**，合计 **37 / 37** 条记录的
  **8 / 8 个问题全部可快速回答**。
- 没有一条记录出现"来源 unknown 却仍作为强事实"、
  "不知道它为什么存在"、"不知道它是否还有效"的情况。
- 达到计划书第 217 节的规模要求（"至少数十条"：35 条沙箱 + 2 条真实库）。
- 发现 **1 项 S4 文案问题**（`retracted` 一律渲染成"用户要求忘掉"），
  已列入技术债，**不阻断 M4**。
