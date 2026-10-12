# Memory 生命周期

> **这份文件回答**：一条记忆从建立到失效会经过哪些状态？
> 每个状态转移由**哪个领域事件**引起？旧数据会不会被覆盖？

- **相关 ADR**：ADR-023（supersede 而非覆盖）、ADR-024（显式路径）、ADR-028（时间语义）
- **不变量**：MI-06（旧事实默认不得物理覆盖）、MI-07（纠正可追溯）、MI-08（遗忘 ≠ 删原始对话）
- **守它的测试**：`m4:verify` §5（状态转移）、`m4:test`（reducer 元信息）、`m4:scale`（140 条 superseded / 30 条 retracted）

---

## 1. 四个状态，各自回答**不同**的问题

混起来会让"她现在还信不信"这个问题无法回答：

| 状态 | 回答 | 语义 |
|---|---|---|
| `active` | 现在可以视为有效 | — |
| `superseded` | **当时可能是真的**，但现在有更合适描述当下的新条 | 值变了，旧值仍是历史 |
| `retracted` | 这条认知**本身被判定错误或不应保留** | 不是"变了"，是"不该有" |
| `disputed` | 存在矛盾证据，系统**还判不了**哪个成立 | 不擅自选边 |

⚠️ `superseded` 与 `retracted` 的区别不是措辞：
**SUPERSEDE 会写 `validUntil`，RETRACT 不动它**（计划书第 84 节，有断言守着）。

---

## 2. 六个领域事件（状态变化的唯一来源）

```text
MEMORY_CREATED      建立（payload 带**首版完整快照**，重放从它开始）
MEMORY_SUPERSEDED   旧条 → superseded（写 validUntil + supersededBy）
MEMORY_RETRACTED    这条 → retracted（**不**写 validUntil）
MEMORY_DISPUTED     这条 → disputed（不改内容、不改 validUntil）
MEMORY_RESTORED     disputed → active（**清掉** validUntil）
MEMORY_MERGED       合并（接口完整，**今天没有生产者**）
```

状态变化**必须**经领域事件，不允许 `UPDATE memory_records`（计划书第 71 节）。
`rebuildMemory()` 能从事件流从零重算出每条记忆，`A == B` 是硬 Gate。

---

## 3. 两条写入路径 —— 但**生产里只有一条**

```text
显式路径（用户在等答复，同步）        PRODUCTION ✅
  validate → commit → fold
  ok:true 只在三步全成功

后台路径（没人在看，异步）            EXPERIMENTAL / NOT PRODUCTION-WIRED ⚠️
  job → 抽取 → 值闸 → 冲突分析 → 放行 → 提交 → 折叠
```

两条路径**共享同一个 validator 与 reducer**，差异只在"谁来提议"与"何时提交"。

### ⚠️ 后台路径当前的准确状态（M4.1 / D3 如实标注）

**它实现完整、测试齐全，但生产代码里没有任何地方调用它。**

| 证据 | 内容 |
|---|---|
| 静态 | `src/` 里**没有任何文件** import `kernel/app/memory/job.ts`；`runMemoryExtractionJob` 从未被生产代码调用 |
| 开关 | `CHARACTER_MEMORY_BACKGROUND_ENABLED` 只被 `flags.ts` 读进 flags 并打印，**没有消费者** —— 它是**惰性**的 |
| 实测 | 打开该开关后跑两轮普通陈述（"我最近开始学 Rust 了" / "我平时住在西安"），记忆条数变化 **0** |
| 机器锁 | `m4:test`「生产装配接线（回归锁）」断言 flags 行上必须带 `memory-background(NOT-WIRED)`、且 `main.ts` 必须打印"没有接到任何东西"的告警 |

> ⏩ **2026-10-07 裁定（用户）：`job.ts` = 「被 `ADR-117`/`ADR-118` 取代（保留实现）」。**
> 上表的**事实全部不变**（仍然 import = 0、开关仍然惰性、机器锁仍然在）——变的是**它的性质**：
> **能力（后台/自动记忆写入）已由另一条路径交付**：`infrastructure/runtime/automatic-memory.ts`
> → `kernel/app/memory/pipeline.ts`（同一套抽取链）+ 水位（`job-store`），
> 生命周期在 `main.ts`（构造 / open / drain / close），`.env` 已由 ADR-118 激活。
> ⇒ 本文件里的 `job.ts` 是**未被使用的实现**（保留：让水位补洞 / 幂等 / 断点续跑那条链与它的测试留在案），
> **不是**"待补的生产缺口"。⚠️ **`TD-19` 本体（系统发起与后台路径的完整能力包）不收窄、不销账** ——
> 它比"记忆抽取"宽得多（归因 / 授权 / 幂等 / ledger / trace / 恢复 / 回复真相端到端），仍需独立授权。
> 详见登记册 §0y `R-70`。**下面那段"她目前只记得住被明确告知的事"的口径因此需要重读**：
> 自动记忆已接线并激活（效果与边界见 M9.7 / ADR-117 / ADR-118 的读数）。

⚠️ **因此不要把它读成"生产已有两条完整写入路径"。**
打开那个开关**不会**启用自动记忆抽取。M4.1 **刻意不接生产**：
自动从闲聊抽取记忆会一次引入 false positive / silent write / implicit consent /
model nondeterminism 等一整批新风险，而为了修一个 S3 临时上线它，可能产生新的 S1。

**含义（对使用者最重要的一句）**：**她目前只记得住被明确告知的事。**

### 一条由用户裁定的产品边界：**陈述式告知不写入**

（`docs/m4/compatibility-audit.md` 明确要求把这一条写进本文：
"否则将来会有人把它当成缺陷去'修'"。）

```text
「记住，我现在上的大学是示例工程科技大学」   → 有指令词 → 会写入
「我们现在上的大学是示例工程科技大学」       → 无指令词 → **不写入**
```

用户 2026-09-16 选择**保持**这条边界，而不是把陈述也算作显式意图。
理由：把陈述算作显式意图等于取消"显式"与"闲聊"的界限，
而记忆一旦写入就不可回溯修正。这类"从日常对话里自动发现值得记的事"
属于**后台抽取路径** —— 而那条路径当前未接线（见上）。

> **不要把它当缺陷修。** 要让陈述式告知自动写入，正确的做法是**接上后台路径**
> （连同它那一整批风险一起评估），而不是把显式路径的判据放宽。

| | 显式路径 | 后台路径 |
|---|---|---|
| 触发 | 用户说"记住 / 改一下 / 忘掉" | 普通对话的抽取窗口 |
| 时机 | **生成回复之前**（不然会回答"记住了"而其实没记） | 后台 job |
| 失败语义 | 三种结果：`written` / `already_applied` / **`not_written`** | `job.status = failed`，可重试 |
| 生产状态 | **PRODUCTION** | **EXPERIMENTAL / NOT PRODUCTION-WIRED** |

⚠️ 显式路径的三种结果是 M4 验收的关键一条：
**不能在 Memory Commit 失败时回答"记住了"**（计划书第 55 节）。
M4.1 起这条由**两层**保证：上下文里那条 `droppable: false` 的指令，
外加 `response-truth.ts` 的**确定性后置守卫**（见
[`explicit-memory-operations.md`](./explicit-memory-operations.md) §6）。

### 3.1 目标不确定时必须安全失败（M4.1 / INV-M41-02）

所有 destructive 操作（forget / retract / update / correction / restore / merge）
都必须先过 **Mutation Gate**：

```text
mayMutate(resolution) === true
  ⟺ status === 'resolved' 且 confidence ∈ { exact, strong }
```

`not_found` / `ambiguous` / `weak` / `none` 一律**不允许改动**。
原则：**宁可不改，也不能猜着改。**

这条是 M4.1 修 D1 的产物：此前"该 subject 下只剩一条 active"被当成了
"唯一命中"，于是"忘掉我养过一只鹦鹉这件事"撤掉了
`education.institution = 示例工程科技大学`。详见
[`../m4/M4-Defect-D1-wrong-target-forget.md`](../m4/M4-Defect-D1-wrong-target-forget.md)
与 [`../m4/M4.1-Correctness-Fix-Report.md`](../m4/M4.1-Correctness-Fix-Report.md)。

---

## 4. 更正 vs 遗忘 vs 存疑：三种"推翻"的语义

| 操作 | 用在什么场景 | 旧条变成 | 历史 |
|---|---|---|---|
| **supersede** | "我现在用 Rider 了"（值变了） | `superseded` + `validUntil` | 保留，双向指针 |
| **retract** | "忘掉我喜欢咖啡"（不该留着） | `retracted` | 保留（逻辑遗忘） |
| **dispute** | "我从来不喜欢蓝色"（无法判断是变化还是玩笑） | `disputed` | 保留，内容不动 |
| **restore** | 后续证据澄清了，蓝色确实成立 | 回到 `active` | 事件留痕 |

**遗忘 ≠ 删除**（MI-08）：`retract` 不动 `conversation_events`。
"物理删除"是另一件事（源数据删除），M4 第一版**默认不做**（计划书第 59 节）。

---

## 5. 崩溃窗口与补折叠

写入是**两步**：事件一个事务、折叠另一个事务。两步之间进程死掉会留下
"已提交、未折叠"的事件 —— 事实**没丢**（在账本里），但投影里没有，
她会**暂时想不起来**，而且**不会自愈**。

这不是推测：`m4:hardkill:verify` 用真实 `taskkill /F` 杀在写入中间，**实测复现**过。

处置：进入对话前调用 `recoverMemoryProjections()`
（`src/infrastructure/persistence/memory-recovery.ts`），把缺口补上。
幂等；`--dry-run` / `--test` 不做（那两个模式承诺不写库）。

⚠️ 只读命令**不做**这件事 —— 它们承诺只读，"审计动作污染它正在审计的库"
是一个比原缺口更糟的回归。这条由 `m4:test`「生产装配接线（回归锁）」守着
（断言补折叠调用在全部只读分支**之后**）。

---

## 6. 已知限制

| 限制 | 说明 |
|---|---|
| `MEMORY_MERGED` 没有生产者 | 重复走 `REJECT_DUPLICATE`；"接口就位、驱动缺失" |
| 同槽位"只能有一条 ACTIVE"不在 DB 层 | 保证在后台冲突分析器里；绕过流水线的新路径要自己跑 |
| 后台 job 的失败重试有上界 | 超过上界后需要人工看 `character_jobs` |
