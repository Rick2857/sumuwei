# 「记忆体量」WP0 基线报告（覆盖率量具）

> **日期**：2026-09-30 · **门**：`pnpm memory-coverage:verify` · **判定**：**PASS**（43 条 / 一致 43 / 不一致 0）
> **授权**：用户 2026-09-30 授权 WP0（[`M9.5-Activation-Execution-Plan.md`](../m9.5/M9.5-Activation-Execution-Plan.md)
> §5.1 的 `D-6` 裁定「先做记忆体量那条线」之后的落地）
> **依据**：[`Memory-Coverage-Execution-Plan.md`](Memory-Coverage-Execution-Plan.md) §3 的 `WP0`
> **量具版本**：`memory-coverage-instrument@2` · **语料版本**：`memory-coverage-corpus@1`（rev 2）
> ⚠️ **本报告是 WP0 当时的快照，不回写**：43 条语料 · `extracted` **19**。
> 之后语料经过 rev 3 / rev 4 / **rev 5**（现值 **47 条**），`extracted` 现为 **27**、
> `written` 现为 **27**，登记表可达例子现为 **16 / 21**。
> ⇒ **当前读数以 `pnpm memory-coverage:verify` / `pnpm memory-coverage:e2e` 的输出为准**；
> 本报告的 §4.2 逐条表是**基线**（用它做前后对照的起点），不是今天的读数。
> ⚠️ **本报告只交读数**：判定「要不要扩覆盖、往哪个方向扩」是 [`Memory-Coverage-Execution-Plan.md`](Memory-Coverage-Execution-Plan.md) §2 的 `C-1`…`C-7`（**你的裁定**）。

---

## 0. 一句话

**她只记得住被明确告知的事**（[`memory-invariants.md`](../architecture/memory-invariants.md) §16.11），
而"明确告知"要连过两道闸门。这道门第一次把**每一道闸门各挡下了多少、以及挡住的是哪些说法**量出来：

```text
43 条语料
├── 19 条 走完两道闸门，抽出一个**已登记**的槽位        ← extracted
├── 15 条 意图认出来了，但**内容抽不出**（content_unresolved）  ← 闸门③
├──  6 条 连**意图**都没认出来                          ← 闸门②
├──  2 条 只有"记住"、没说记住什么（content_empty）      ← 正确行为是追问
└──  1 条 意图是 correct ⇒ 走另一条服务路径（本门如实记为 out-of-scope，不判）
```

**其中最能直接用来排期的一组**：登记表自己声明的 **17 个 `examples`** 里，
**10 个抽得出、7 个抽不出**（§4.3 逐条给机制）。这不是"登记表违约"（§16.10 逐字：
线索表的不完整是**被设计允许的**），而是一份**非任意的待办清单**。

---

## 1. 它测什么、不测什么（`AGENTS.md` §6.2 的第一问）

```text
判    "这句话在**生产缺省**的显式路径下走到了哪一步"（可达性）
        · 检测器 = `createExplicitMemoryIntentDetector()`（缺省 = 规则 + **规则型**分类器）
        · 抽取器 = `createRuleOnlyContentExtractor()`（缺省那一份）
        · 两者都是 `src/main.ts` 缺省装配里的那两份，不是另写的仿制品
不判  取值**正确性** —— 那是 ADR-056 与 `pnpm m6.1:extractor:repro` 的职责，本门**不重复**
不判  **写入结果**（成功 / 失败 / 冲突 / 去重）—— 那要库，属隔离库预演（WP1/WP4）
不判  **假阳**（把闲聊记成长期记忆）—— 同上
不判  **后台路径**（`CHARACTER_MEMORY_BACKGROUND_ENABLED`，NOT-WIRED，归 `TD-19`）
不判  **覆盖率百分比** —— 本语料是**抽样**，不是总体；任何百分比都不得外推
不打开任何数据库 —— **构造属性**（本门只 import 纯函数 / 纯数据模块），见 §6
```

⚠️ **一个具体的范围边界**：语料里保留了 `mc-outofscope-0001`（「更正一下，我的专业是历史学。」），
但它的期望是 `not_remember_intent` —— 因为 `correct` 意图走 `service.correct()`
（含 ADR-058 的槽位限定兜底），**不是** `remember` 的抽取层。把它按 `remember` 跑，
量到的就是一个**不是本门要判的东西**（§3 记了这次踩坑）。

---

## 2. 语料与冻结

| 项 | 值 |
|---|---|
| 文件 | `evals/memory-coverage/corpus/memory-coverage-corpus.jsonl`（**43** 条） |
| 冻结清单 | `evals/memory-coverage/corpus/manifest.json` |
| `corpusSha256` | `606c85e78f3ec68409a74bfd4048a663be547971588e6935d6407026a8e5a5b3` |
| 摘要定义 | 对**归一化后**的内容求 sha256（CRLF → LF）—— 理由见 `.gitattributes`（本机 `core.autocrlf = true`，不归一化会让"别人 clone 之后语料变成 CRLF"造成**误报**） |
| 冻结机制 | 每次运行重算并比对；不一致即 **FAIL** ⇒ 改语料必须**有意**重刷 `corpusSha256` |
| 每条都带 | `provenance`（逐字出处）—— 六种来源，定义见 manifest 的 `provenanceKinds` |

**来源分布（`class`）**：

| class | 条数 | 是什么 |
|---|---|---|
| `supported` | 9 | 走完两道闸门、抽出已登记槽位的说法（含 ADR-056 的逐字实测句） |
| `registry_example` | 10 | **登记表自己声明的** `examples`，逐字 |
| `registry_unreachable` | 7 | 同上，但**抽不出** |
| `intent_absent` | 3 | 完全没有显式意图关键词 |
| `intent_not_leading` | 3 | 关键词**在句中**（`remember` 要求句首，见 §4.3 的注） |
| `extract_unresolved` | 8 | 意图认出来了、内容抽不出（含既有的断言句与文档点名的方向） |
| `not_remember_intent` | 1 | 非 `remember` 意图 ⇒ **如实记为 out-of-scope** |
| `content_empty` | 2 | 只说了"记住"没说记住什么 |

⚠️ **取材纪律**：不得"顺手想到一句就加进去"（`m6.1-extractor-repro.ts:53` 的禁令）。
本语料每一条都写明来源：**逐字**（文档 / 冻结条文 / 登记表 examples）· **adapted**（改动逐字写出）·
**constructed**（构造理由写出）。

---

## 3. 判据 / 量具的错（`AGENTS.md` §6.6：不许悄悄改判据）

> 这一段是本报告**最该读**的一段。本门的语料与量具在**第一次运行之后**各改过一次，
> 两次都逐字记在 `evals/memory-coverage/corpus/manifest.json` 的 `revisions` 里。

### 3.1 第一次：量具把**两条服务路径**混在了一起（FAIL 档保留在库）

```text
第一次运行（instrument @1，语料 rev 0）⇒ FAIL
  唯一的不一致：`mc-unresolved-0009`「更正一下，我的专业是历史学。」
  期望 content_unresolved，实测 **extracted**
```

**归因**：该句意图是 `correct`，生产里走 `service.correct()`（含 ADR-058 的槽位限定兜底）；
而初版量具**对任何被检出的意图都跑 `remember` 的抽取流程** ⇒ 它量到的是
"这句话的内容能不能抽出槽位"，而不是"这句话在 `remember` 路径上走到哪一步"。
`AGENTS.md` §6.2 逐字："*我现在测到的东西，真的是我要判断的那个东西吗？*" —— 答案是**否**。

**处置**（两处，都**不是**为了让读数好看）：
1. 量具：非 `remember` 意图如实记为 `not_remember_intent`，**不跑抽取器**；
2. 语料：该条改为 `mc-outofscope-0001` / 期望 `not_remember_intent`；
3. 量具版本 `@1` → **`@2`**（行为变了，版本号必须跟着变，否则那一次 FAIL 档与之后的读数在证据里不可分辨）。

⇒ **那一次 FAIL 的档保留在库、不删**（§7 的 run ①）：它是"正控真的会响"的记录。

### 3.2 第二次：语料**手挑**得太任意 + 三处 `provenance` 归属不准

```text
修订 2（语料 rev 1 → rev 2）
① 把登记表 **17 个 declared examples 完整**收进语料（新增 11 条）
② 修正三处**误归属**：
   · tooling.preference.editor 的逐字例子是「我用 VS Code」，不是我写的「我用的编辑器是 neovim」
   · education.status 的逐字例子是「我现在是大学生」/「我已经毕业了」，不是我写的「我在读本科」
   · 「记住，我平时用的是 Windows 笔记本。」来自 **ADR-056 §4**，不是登记表
③ 类名统一为 `registry_example` / `registry_unreachable`
```

**为什么改**：原 `supported` 组是**我手挑**的句式，任意性太强；而 WP0 要回答的正是
"**登记表声明的东西，生产缺省路径够不够得着**" ⇒ 登记表自己的 `examples` 是一份
**非任意**的可测集合。②是**我自己的声明错了**，与实现无关。

⚠️ **边界（重要）**：这两次修订**没有**为了读数好看而改任何**期望**。
`registry_*` 组的期望是**特征化**（由逐条读线索表推出，本次实测逐条相符）——
抽取器一旦改好，它们**会报红**，强制回来更新语料（这正是基线该有的性质）。

---

## 4. 基线读数

### 4.1 闸门分布

| 闸门 | 条数 | 含义 |
|---|---|---|
| `extracted` | **19** | 两道闸门都过；抽出的槽位**全部已登记**（`extractedButUnregistered = 0`） |
| `content_unresolved` | **15** | 意图认出来了，内容抽不出 ⇒ **真的没进记忆** |
| `intent_not_detected` | **6** | 连显式意图都没认出来（其中 3 条是"关键词在句中"） |
| `content_empty` | **2** | 只有"记住" ⇒ 正确行为是追问 |
| `not_remember_intent` | **1** | 非 `remember` ⇒ 本门不判 |
| 合计 | **43** | `measuredCount = 43`（> 0，§6.8 自检通过） |

### 4.2 逐条读数（分组）

**`supported`（9）** —— 两道闸门都过：

| id | 语料 | 实测闸门 | 抽出的槽位 / 取值 |
|---|---|---|---|
| `mc-supported-0001` | 记住，我在示例工程科技大学 | extracted | `education.institution` = 示例工程科技大学 |
| `mc-supported-0002` | 记住，我的专业是汉语言文学。 | extracted | `education.major` = 汉语言文学 |
| `mc-supported-0003` | 记住，我平时用的是 Windows 笔记本。 | extracted | `device.primary` = Windows 笔记本 |
| `mc-supported-0006` | 记住，我在读本科 | extracted | `education.status` = undergraduate |
| `mc-supported-0007` | 记住，我在读研究生 | extracted | `education.status` = graduate |
| `mc-supported-0010` | 记住，现在简短说就行 | extracted | `preferred.explanation.style` = brief |
| `mc-supported-0011` | 记住，我在做 project LG | extracted | `project.background.active` = project LG |
| `mc-supported-0012` | 记住，我用的编辑器是 neovim | extracted | `tooling.preference.editor` = 用的编辑器是neovim |
| `mc-supported-0013` | 记住：我在江城大学读书。 | extracted | `education.institution` = 江城大学 |

**`registry_example`（10）** —— 登记表 17 个 declared examples 里**够得着**的那些：

| id | 语料（登记表逐字） | 实测闸门 | 抽出的槽位 / 取值 |
|---|---|---|---|
| `mc-registry-0001` | 记住，我不吃香菜 | extracted | `food.preference.cilantro` = dislike |
| `mc-registry-0002` | 记住，我现在能吃香菜了 | extracted | `food.preference.cilantro` = like |
| `mc-registry-0003` | 记住，我不吃辣 | extracted | `food.avoid.general` = 回避辣 |
| `mc-registry-0004` | 记住，我现在是大学生 | extracted | `education.status` = undergraduate |
| `mc-registry-0005` | 记住，我学的是计算机 | extracted | `education.major` = 计算机 |
| `mc-registry-0006` | 记住，我不是计算机专业的 | extracted | `education.major` = 的 ⚠️ |
| `mc-registry-0007` | 记住，我在 XX 大学 | extracted | `education.institution` = XX大学 ⚠️ |
| `mc-registry-0008` | 记住，技术问题我喜欢详细解释 | extracted | `preferred.explanation.style` = detailed |
| `mc-registry-0009` | 记住，叫我 Alex 就行 | extracted | `preferred.address` = Alex 就行 ⚠️ |
| `mc-registry-0010` | 记住，我在做一个角色 Agent 的项目 | extracted | `project.background.active` = 的项目 ⚠️ |

⚠️ 带 ⚠️ 的取值**不是本门的判定**（本门只判可达性）—— 它们是 §4.4 的**附带观察**。

**`registry_unreachable`（7）** —— 登记表 17 个 declared examples 里**够不着**的那些（**逐条给机制**）：

| id | 语料（登记表逐字） | 期望槽位 | 抽不出的机制 |
|---|---|---|---|
| `mc-registry-0011` | 记住，海鲜过敏 | `food.avoid.general` | 该槽位的 cues 只有 `['辣','辣椒']` ⇒ 一个都不命中 |
| `mc-registry-0012` | 记住，我已经毕业了 | `education.status` | cues 是 `['研究生','硕士','大学生','本科','在读生']` ⇒「毕业」不在表里 —— 而该槽位的 `allowed` 枚举里**有** `graduated` |
| `mc-registry-0013` | 记住，我每天睡 7 小时 | `health.sleep.duration` | **`PREDICATE_RULES` 里没有任何规则**指向这个槽位（登记了但完全不可达） |
| `mc-registry-0014` | 记住，我每天睡 420 分钟 | `health.sleep.duration` | 同上 |
| `mc-registry-0015` | 记住，现在简单说就行 | `preferred.explanation.style` | brief 那一支的 cues 是 `['简洁','简短','简单点','简略','不要太长']` ⇒「简单说」不命中（`mc-supported-0010` 换成「简短」就抽得出） |
| `mc-registry-0016` | 记住，我平时用 Windows | `device.primary` | cues 是 `['电脑','设备','系统','用的是']` ⇒「我平时用 Windows」一个都不命中 |
| `mc-registry-0017` | 记住，我用 VS Code | `tooling.preference.editor` | cue 是**小写** `vscode`，而句子写的是 `VS Code`；`text.includes(cue)` **区分大小写**（`content-extractor.ts:549`） |

**`intent_absent`（3）** —— 闸门②挡住（没有意图关键词）：

| id | 语料 | 实测闸门 |
|---|---|---|
| `mc-intent-absent-0001` | 我最近开始学 Rust 了 | intent_not_detected |
| `mc-intent-absent-0002` | 我平时住在西安 | intent_not_detected |
| `mc-intent-absent-0003` | 我不吃香菜，也不吃辣 | intent_not_detected |

⚠️ `mc-intent-absent-0003` 与 `mc-registry-0001/0003` **内容逐字相同、只差一个"记住"**
⇒ 它把"意图闸门"与"抽取闸门"分开量：**同一件事，加一个词就记得住，不加就永远记不住**。

**`intent_not_leading`（3）** —— 关键词在句中 ⇒ 规则不命中：

| id | 语料 | 实测闸门 | 证据（量具记的 `keywordHits`） |
|---|---|---|---|
| `mc-intent-notleading-0001` | 我想让你记住我喜欢咖啡 | intent_not_detected | `记住` 在**第 4 个字符** |
| `mc-intent-notleading-0002` | 你要记得我不吃香菜 | intent_not_detected | `要记得` 在第 1 个字符 |
| `mc-intent-notleading-0003` | 麻烦帮我记住我的专业是历史学 | intent_not_detected | `帮我记住` 在第 2 个字符 |

**机制**（`intent-detector.ts:301` 逐字）：`remember` 那一支带 `requiresLeading: true`，
理由是"'我记住了' 是**她**在说话的场景，不是用户在要求记住"。⇒ 代价是**句中提及**的
"我想让你记住…"也一并落空，而缺省分类器是规则型 ⇒ 直接 `undefined`。

**`extract_unresolved`（8）** —— 意图认出来了、内容抽不出（**真的没进记忆**）：

| id | 语料 | 来源 |
|---|---|---|
| `mc-unresolved-0001` | 记住，我平时主要用 VS Code | D2-A 样板句（`memory-invariants.md:473`） |
| `mc-unresolved-0002` | 记住，我最近不太能喝奶了 | `m4:verify` 的断言句 |
| `mc-unresolved-0003` | 记住，我可能会搬到成都 | `verify-m6-wp7a.ts:283` 的断言句 |
| `mc-unresolved-0004` | 记住：我的皮料是植鞣革。 | M6.1 根因档的实测句 |
| `mc-unresolved-0005` | 记住，我的生日是 3 月 14 日 | M5 `G1` 点名的方向（birthday） |
| `mc-unresolved-0006` | 记住，我老家在成都 | 同上（hometown） |
| `mc-unresolved-0007` | 记住，我养了一只叫豆豆的猫 | 同上（relationship） |
| `mc-unresolved-0008` | 记住，我周三要答辩 | 已裁定记录里的"设计使然"句 |

**`not_remember_intent`（1）** / **`content_empty`（2）**：

| id | 语料 | 实测闸门 | 说明 |
|---|---|---|---|
| `mc-outofscope-0001` | 更正一下，我的专业是历史学。 | not_remember_intent | 意图 `correct` ⇒ 走另一条服务路径（ADR-058 兜底）⇒ 本门不判 |
| `mc-content-empty-0001` | 记住 | content_empty | 正确行为是追问"记住什么" |
| `mc-content-empty-0002` | 记住。 | content_empty | 探测结果：**句号也被剥掉了** ⇒ payload 为空 ⇒ 走 `content_empty`（不是 `content_unresolved`） |

### 4.3 登记表 17 个 declared examples 的完整扫描（**本报告的核心读数**）

```text
登记表 11 个槽位 · 共声明 17 个 examples
├── 10 个够得着（§4.2 的 registry_example 组）
└──  7 个够不着（§4.2 的 registry_unreachable 组，逐条给了机制）
    ├── 3 个是"线索词表里没有对应说法"：海鲜过敏 / 我已经毕业了 / 现在简单说就行
    ├── 2 个是"整条槽位没有任何规则"：health.sleep.duration ×2
    ├── 1 个是"cue 与说法不匹配"：我平时用 Windows（cues 是 电脑/设备/系统/用的是）
    └── 1 个是"大小写"：我用 VS Code（cue 是小写 vscode）
```

⚠️ **这组读数怎么用、不能怎么用**：

```text
✅ 可以用   当"扩线索表"这条方向的**待办清单**（每条都给了机制 ⇒ 修法明确）
✅ 可以用   当**前后对照的起点**（改完再跑这道门，读数会变 ⇒ 有意的）
⛔ 不能用   说"登记表违约了" —— `memory-invariants.md` §16.10 逐字：
            "线索表的不完整是**被设计允许的**"（`:110-111` 同一条）
⛔ 不能用   说"覆盖率是 10/17" —— 这不是覆盖率（分母是**登记表声明的例子**，
            不是真实对话里出现的说法）；本门**不产覆盖率百分比**
```

### 4.4 附带观察（**不是本门的判定**）：取值质量问题

量具为了判"抽出了哪个槽位"顺手记下了取值。有 5 条**可达但取值可疑**，**逐条列出**，
但它们**不属于本门**——取值边界归 ADR-056 / `pnpm m6.1:extractor:repro`
（`ADR-056` §5 逐字把"扩覆盖"与"修取值"划成两件事）：

| 语料 | 实测取值 | 观察 |
|---|---|---|
| 记住，我不是计算机专业的 | `education.major` = **「的」** | ⚠️ **单字取值** —— 与 ADR-056 修掉的那一类（机构名抽成「书」/「了」）**同一形状**；ADR-056 只修了机构名那一条规则 |
| 记住，我在 XX 大学 | `education.institution` = 「XX大学」 | 线索词「大学」**漏进了取值**（句子里是占位符，但形状问题与取值内容无关） |
| 记住，我在做一个角色 Agent 的项目 | `project.background.active` = 「的项目」 | 线索词「项目」之后为空 ⇒ 落回"往前"，把「的」也带上了 |
| 记住，我用的编辑器是 neovim | `tooling.preference.editor` = 「用的编辑器是neovim」 | 线索词整段漏进取值 |
| 记住，叫我 Alex 就行 | `preferred.address` = 「Alex 就行」 | 尾部「就行」没被剥掉（较轻） |

⇒ **处置建议**：**不**在本线顺手修（那会把两条线混在一起 —— `ADR-056` §5 与
`M6.1-WP5-Failure-Attribution.md:146` 都逐字禁止"混成一个问题组"）。
它们应当**单独登记**，走取值边界那条线。⚠️ 本报告**只登记，不主张它们是缺陷**
（"取值该是什么"要另立判据）。

---

## 5. 三段式自证与计数自检（`AGENTS.md` §6.7 / §6.8）

| 段 | 做法 | 读数 |
|---|---|---|
| **正控** | 真语料 ⇒ 每条实测闸门与语料声明的期望比对 | 一致 **43 / 43** |
| **负控①** | 注入"**只含规则本来就能抽**"的假语料（19 条，全部期望 `extracted`）⇒ **必须报出分辨力不足** | ✅ 如实报出（理由：期望闸门只有一种 ⇒ 量的是一个恒等函数） |
| **负控②** | 把某一条的期望**故意写错**（`mc-supported-0001` → `content_unresolved`）⇒ **必须报出不一致** | ✅ 报出 1 条不一致（证明比对真的在比） |
| **恢复** | 再用真语料跑一遍 ⇒ 与正控**逐字段相同** | ✅ 相同 |
| **计数自检** | `measuredCount > 0` | **PASS**（43 项） |

⚠️ **负控①为什么是关键**：一个只在"规则本来就会"的集合上跑的量具，命中率天然很高，
而它"什么都不检查"在输出上**无法区分**。这道自检让"拿坏语料伪造覆盖率"变成**失败关闭**。

---

## 6. 证据位置与复现

```text
机器证据：artifacts/memory-coverage/<runId>/
            manifest.json（runId / verdict / counts / corpusSha256 / instrumentVersion /
                           sourceTreeHash / artifactHashes / dbKind / isolationProof）
            coverage.json（逐条 readings：期望 / 实测 / 意图 / 槽位 / 取值 / keywordHits / provenance）
复现    ：pnpm memory-coverage:verify          （退出码 0 = PASS · 3 = FAIL / MEASUREMENT INVALID）
聚合    ：pnpm gates:run --lane memory-coverage
改动面  ：pnpm fast 在改动 src/kernel/app/memory/** 或 evals/memory-coverage/** 时自动带出
```

**真实库纪律**：本门**不打开任何数据库** —— 这是**构造属性**（只 import 纯函数 / 纯数据模块：
`intent-detector` / `content-extractor` / `memory-predicates`；**不** import `src/db/**`、
`src/infrastructure/persistence/**`、`src/dev/sandbox.ts`）。
⇒ 它**没有能力**打开库，因此**不**用"真实库树摘要前后相同"当证据 ——
那不是本门能观察到的东西（`m9.5:test` 同款立场）。证据里如实记 `dbKind: 'not-applicable'`。

---

## 7. 档清单（**4 个 run，一个都没删**）

| run | 判定 | 量具 | 语料 sha256（前 8） | head | 它是什么 |
|---|---|---|---|---|---|
| `…20260930160520.-4b75f7e41b0e-11e5` | **FAIL** | `@1` | `40bbfa6d` | `4b75f7e4` | **第一次运行**：量具/语料把两条服务路径混在一起的记录（§3.1）。保留不删 |
| `…20260930160657-…-34ac` | PASS | `@2` | `a4663859` | `4b75f7e4` | 语料 **rev 1** 的读数（32 条） |
| `…20260930160935-…-60fd` | PASS | `@2` | `a4663859` | `91f776ad` | 语料 **rev 1** 的读数（同一版语料、脚本提交之后重跑） |
| **`…20260930161340-720d00fbc936-57d4`** | **PASS** | `@2` | **`606c85e7`** | **`720d00fb`** | ★ **本报告的基线读数**（语料 rev 2 / 43 条） |

⚠️ 中间两次（rev 1）与最终这次（rev 2）**各有归属**：语料版本写在各自的 `corpusSha256` 里，
量具版本写在 `instrumentVersion` 里 ⇒ 一个读者可以逐档分辨它们量的是什么，不需要靠猜。

---

## 8. 本报告**不主张**

```text
· 不主张覆盖率达标 —— 本门**不产覆盖率百分比**，语料是抽样不是总体
· 不主张"登记表违约" —— 线索表的不完整是**被设计允许的**（§16.10）
· 不主张取值正确性 —— §4.4 只**登记**观察，判定属 ADR-056 / m6.1:extractor:repro
· 不主张写入结果 / 假阳 / 端到端行为 —— 那要库，属隔离库预演（WP1/WP4）
· 不主张"她记得更多 = 她记得更对"（DR-11）
· 不主张扩覆盖的**方向**已定 —— 那是 `Memory-Coverage-Execution-Plan.md` §2 的 C-1…C-7（你的裁定）
· 不主张 `M4 D2-A` 已解决、也不主张 `TD-22` 关闭
```
