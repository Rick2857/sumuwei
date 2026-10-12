# M4-D1｜显式遗忘会撤销**无关的**正确记忆（S1）

- **发现日期**：2026-09-17
- **发现方式**：**真实链路冒烟**（生产库副本上的真实多轮对话）
  —— 验收阶段新增的所有门（isolation / restore / scale / hardkill / audit）
  都刻意不写真实库，因此**都没有覆盖到这条**
- **等级**：**S1 — Core Semantic Failure**
  （正确的用户事实被错误地判定为"不该保留"）
- **状态**：**未修复**
- **影响判定**：**M4 FAIL**（附件 §41：S1 → FAIL；且 §44 明确
  "CONDITIONAL PASS 不得用于掩盖任何 Memory Correctness 问题"）

---

## 1. 怎么发现的

M4 验收的结论里有"明确未做"的一项：Scenario A–E 的真库多轮黑盒。
用户问"如果先不管会有什么后果"，因此补做了一次**冒烟**——
把 `data/pglite` **复制**一份，在副本上跑真实多轮（生产库一个字节没动）。

冒烟的第一轮就暴露了它。

---

## 2. 复现（最小、确定性）

```powershell
# 1) 复制生产库（绝不打开真实库）
$work = Join-Path $env:TEMP ("m4-t06-" + [guid]::NewGuid().ToString("N"))
Copy-Item -Recurse data\pglite (Join-Path $work "pglite")
$env:PGLITE_DATA_DIR = (Join-Path $work "pglite"); $env:PROJECT_LG_SANDBOX = $env:PGLITE_DATA_DIR

# 2) 基线：库里只有 1 条 active
node node_modules\tsx\dist\cli.mjs src/main.ts --memory-list
#   person_fact  active      education.institution = 示例工程科技大学   ← 唯一的 active
#   preference   retracted   education.institution = 是示例工程科技大学

# 3) 要求忘掉一件**从未存在过**的事（附件 M4-T06 的原始输入）
node node_modules\tsx\dist\cli.mjs src/main.ts "忘掉我养过一只鹦鹉这件事"

# 4) 结果
node node_modules\tsx\dist\cli.mjs src/main.ts --memory-list
#   person_fact  retracted   education.institution = 示例工程科技大学   ← **被它撤了**
#   preference   retracted   education.institution = 是示例工程科技大学
```

实测输出：

```text
=== BEFORE ===      total 2   active 1   retracted 1
=== TURN ===
  我：忘掉我养过一只鹦鹉这件事
  她：行。抹了。
      鹦鹉这事，从现在起没发生过。我这边不留痕。
=== AFTER ===       total 2   active 0   retracted 2     ← 示例工程科技大学 被撤
```

同一个缺陷在冒烟里还有一个更贴近日常的形态：

```text
我：忘掉我用 VS Code 这件事
她：忘了。VS Code 那事已经撤了。
    我没记。你也不用绕这圈来试我。
→ 被撤的仍然是「education.institution = 示例工程科技大学」
```

---

## 3. 根因（定位到行）

`src/kernel/app/memory/target-resolver.ts:335-342` —— 目标解析梯子的**第 3 步**：

```ts
// 第 3 步：same subject（+ 尽量用 predicate 提示收窄）
if (request.subject !== undefined) {
  tried.push('subject_predicate')
  const records = await deps.listBySubject(request.owner, request.subject)
  const active = records.filter((r) => r.status === 'active')

  if (active.length === 1) {
    return { status: 'resolved', record: active[0], via: 'subject_predicate', candidates: 1 }
  }                                        //  ↑ 这里**从不比对用户说的是什么**
  ...
```

**问题不是"挑错了"，而是"只要该 subject 下只剩一条 active，就认定它就是要找的那条"。**
用户说的是"鹦鹉"，而唯一 active 的是"示例工程科技大学" ——
两者毫无关系，但候选数为 1 就被当成**唯一命中**。

⚠️ 这恰恰是这个文件**自己**在文件头警告过的形状（第 28–32 行）：

> 这一层最容易做错的地方不是"找错了"，而是"**找不到时随便挑一个**"。

而它比那句警告更隐蔽：它的输出长得像一次**合法的唯一匹配**（`via: 'subject_predicate'`，
`candidates: 1`），而不是一次猜测 —— 因此 review 与测试都没能抓住它。

### 为什么现有测试没抓到

| 测试 | 它测的是 |
|---|---|
| `kernel-tests-memory.ts:1920` | **第 1 步**（显式 id 找不到 → `not_found`） |
| `verify-m4-persistence.ts:1675` | `active.length > 1` 的分支（报 `ambiguous` 而不是挑一条） |
| `m4:verify` §13 | 显式忘记，但**目标在库里确实存在** |

**`active.length === 1` 这条分支没有任何测试要求"那一条必须与用户说的话相关"。**
候选数为 1 时，"唯一"这个性质替代了"相关"。

---

## 4. 影响面

| 维度 | 说明 |
|---|---|
| **用户可见后果** | 用户要求忘掉 A，系统**静默撤销了无关的 B**，并且回复"抹了" —— 用户无从知道被抹的是另一件事 |
| **数据是否丢失** | **没有**（`retract` 是逻辑遗忘，记录与证据都在；`MEMORY_RESTORED` 可恢复）→ 因此不是 S0 |
| **但是** | 一条**正确的、用户授权的事实**被错误地判定为"不该保留"，而 M4 的 Exit Criteria 要求"**Forget 可靠**" |
| **触发条件** | 该 subject 下**恰好只有一条 active** 时，任何带 forget 意图但**无法定位到具体槽位**的请求都会中 |
| **为什么现在特别危险** | 真实库当前**正好只有 1 条 active** —— 也就是说**现在每一次目标不明的"忘掉…"都会命中这条** |
| **放大条件** | 真实库的 active 越少，命中概率越高；而 active 少正是今天的常态 |

### 与 §5.6 的关系

`M4-verification.md` §5.6 记录的同类缺陷（她说"记住了"而库里一条都没有）是**没写**；
这一条更重：**写错了对象**，而两者都属于同一类
——「部件都被测过，而**它们被装到一起之后**的那个行为没人测」。

---

## 5. 同一轮冒烟发现的另外两件事（单独记录，不与 D1 混）

| # | 现象 | 等级 | 说明 |
|---|---|---|---|
| **D2** | 显式 "记住"/"纠正" 对**规则抽取器没覆盖的说法**静默失败 | S2/S3（待定） | `tsx scripts/diag-m4-explicit.ts "记住，我平时主要用 VS Code"` → **卡在②内容抽取**（`content_unresolved`）。诊断工具自己写明"这不是系统故障，而是这句话没被听懂"；`main.ts:475` 注释也说明 LLM 兜底"留到下一步"。**但她的回复读起来像已经记下了**，用户无从分辨 —— 这正是 §55 要防的用户体验 |
| **D3** | 后台抽取路径**没有接入生产**；`CHARACTER_MEMORY_BACKGROUND_ENABLED` 是**惰性**的 | S3 | 静态：`src/` 里**没有任何文件 import `app/memory/job.ts`**；`flags.ts` 只把它读进 flags 并打印，没有消费者。实测：打开开关后跑 2 轮普通陈述（"我最近开始学 Rust 了"/"我平时住在西安"），记忆条数变化 **0** —— 而她的回复是"西安。住的那条，记了。" |

⚠️ D3 让 `docs/architecture/README.md` 与 `memory-lifecycle.md` 里画的
「两条写入路径」在**生产里实际只有一条**。这一点必须写进文档（见 §6）。

---

## 6. 修复建议（**未实施**，等裁定）

### D1（S1，必修）

在第 3 步的 `active.length === 1` 分支上加**相关性判据**，而不是只看候选数：

```text
若 request.hints 非空：
  必须至少有一个 hint 命中那条候选（复用 scoreByHints），否则 → not_found
若 request.hints 为空（真的什么线索都没有）：
  → not_found（"没有任何线索"不能被"恰好只剩一条"满足）
```

理由与这个项目既有的安全缺省一致（`target-resolver.ts` 第 86–87 行）：
> 缺省不提供语义判别器 —— 那意味着"多条候选时报 ambiguous"，
> 而这是一个**安全的**缺省：报 ambiguous 让人去管。

**必须同时补的回归测试**（否则修完还会回来）：

1. 该 subject 下**只有一条** active，且请求与它**无关** → 必须 `not_found`，
   **且不得产生任何 retract 事件**（用附件 M4-T06 的原话："忘掉我养过一只鹦鹉这件事"）
2. 该 subject 下只有一条 active，且请求与它**相关**（如"忘掉我上大学这件事"）→ 仍应正常解析
   （防止修复退化成"一律拒绝"）
3. 修复前必须先让测试**红**（这是本项目一贯的做法）

### D2（需要裁定）

两条路线：往 `content-extractor.ts` 的槽位线索表补说法（便宜、可控），
或接上 `ChainedContentExtractor`（规则 → LLM 兜底，覆盖广但引入模型不确定性）。
**这是产品取舍**（"她该听懂多少种说法"），不适合由我单方面决定。

### D3（需要裁定）

要么补上接线（让后台路径真正可开），要么把开关标成"尚未接线"并从文档里去掉
「两条路径」的说法。**这也意味着"她目前只记得住被明确告知的事"** ——
那与 "M4 = Reliable Long-Term Memory（含自动抽取）" 的叙述有差距。

### 文档（无论怎么裁都必须做）

`memory-lifecycle.md` 必须补两件事（`docs/m4/compatibility-audit.md:562`
已明确要求过其中一件）：

1. 后台抽取的**开关默认关闭**，且它属于"从日常对话里自动发现值得记的事"那条路径
2. 用户 2026-09-16 裁定的边界：**陈述式告知不写入**
   （"我们现在上的大学是示例工程科技大学"这种没有指令词的告知不会被显式路径捕获），
   并注明"不要把它当成缺陷去修"
