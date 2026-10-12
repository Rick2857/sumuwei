# 角色自选工具 · WP4 记录（语义评估 · 交付状态 · 激活候选）

日期：2026-10-05。状态：**工程门 + 语义评估 + 隔离真实链已跑；人审 / 生产激活两项未完成**。

载体：[`Role-Tool-Decision-Plan-2026-10-05.md`](Role-Tool-Decision-Plan-2026-10-05.md) §6 WP4 ·
[`ADR-104`](../adr/ADR-104-role-tool-decision.md) `D03`/`D07`/`D10` ·
[`WP0 基线`](Role-Tool-Decision-WP0-Baseline.md) · [`WP1`](Role-Tool-Decision-WP1-Record.md) ·
[`WP2`](Role-Tool-Decision-WP2-Record.md) · [`WP3`](Role-Tool-Decision-WP3-Record.md)。

---

## 1. 工程门（工作树读数）

```text
pnpm typecheck                                   EXIT 0
pnpm m4:test                                     259 / 0
pnpm m4.5:test                                   146 / 0
pnpm productivity:verify --only common,files     12 组 / 12 PASS（63 条参数化输入）
pnpm postlv2:role-tool:verify                    wp0 84/14 PASS · wp1-contract 28/4 PASS
pnpm postlv2:role-tool:path                      53 / 53 PASS
pnpm postlv2:role-tool:matrix                    A 24/24 · B 32/32 · C 11/11 PASS，4 项 NOT RUN ⇒ overall NOT PASS
pnpm postlv2:role-tool:known-dirs                PASS（真实探测，只读）
pnpm with-test-model pnpm postlv2:role-tool:semantic:eval  硬判据 PASS（v2）· 软指标达标
pnpm with-test-model pnpm postlv2:role-tool:live           10 / 10 PASS（隔离真实链）
干净检出（git worktree + tsc）                    0 个错误
```

---

## 2. 语义评估（固定样本 · 真模型 · 逐案报告）

```bash
pnpm with-test-model pnpm postlv2:role-tool:semantic:eval
```

- **样本**：24 例，**独立撰写**（闲聊 7 · 该用工具 13 · 该澄清 2 · 注入 2）。
- **端点**：`ark.cn-beijing.volces.com` · `deepseek-v4.1-flash`（经 `with-test-model`；
  没有 `DSH_TEST_MODEL_WRAPPER=1` 时本门**拒绝运行**）。
- **阈值在跑之前冻结**（写在脚本里，跑完不回改）：

```text
关键假阳（期望"不该动工具"却提议 tools）= 0        ← 硬判据（代价不对称：误判成工具 = 一次真实的
                                                     外部动作；误判成回答只是一句话）
分支正确率 ≥ 85%（软）· 能力命中率 ≥ 70%（软）
```

### 2.1 两代读数（**同一份冻结样本**，提示词中途改过一次 ⇒ 两代各自归属）

| 读数 | 分支正确 | 关键假阳 | 能力命中 | 解析失败 | 硬判据 |
|---|---|---|---|---|---|
| **v1**（`role-tool-eval-20261005T130846`） | 21/24 = 87.5% | **1**（A6） | 11/12 = 91.7% | **1**（T13） | **NOT PASS** |
| **v2**（`role-tool-eval-20261005T131032`） | 23/24 = 95.8% | **0** | 10/11 = 90.9% | 0 | **PASS** |

v1 的两处不符（**原样保留，不回写**）：

```text
A6 「C:\Windows\notepad.exe 为什么打不开？」⇒ 模型提议 local.file.list
   ⚠️ 这是**问题**不是**委托**。本仓库对这句话的既有立场写在
   `src/kernel/action/task-intent.ts` 的第 ② 条注释里（"播报它会让每一句提到路径的话
   都变成一次规划调用"）⇒ 这条期望不是随手写的。
T13「这张图里写了什么？C:\work\shot.png」⇒ 提案缺计划必需字段
   （闭集码 `tool_decision_tools_missing_plan`）⇒ 按失败关闭处理：**那一轮什么都不做**。
```

### 2.2 改了什么（**两条一般性规则**，不是对着样本打补丁）

```text
① "`goal` / `steps` / `done` **缺一不可**，少一个整条作废、那一轮什么都不会执行"
   （原来只是列举字段，没写后果 ⇒ 模型漏 `done` 时没有任何提示）
② "**问原因 / 要解释 / 打听**（'X 为什么打不开'、'这是怎么回事'）一律 answer：
   句子里出现一个路径**不等于**委托"
```

⚠️ 两条都写进 `openai-tool-decision.ts` 的 `buildToolDecisionInstruction()`（**从契约派生**），
并各自留了"这条是被哪一次读数逼出来的"注释。

### 2.3 第三次读数（裁定日同日重跑，**同一份冻结样本**）与**波动**这件事

```text
role-tool-eval-20261005T134513（v2 提示词）：分支 22/24 = 91.7% · **关键假阳 0** ·
能力命中 10/11 = 90.9% ⇒ 硬判据 PASS · 软指标达标
两处不符：A3（期望 answer，实得 clarify —— 追问"刚才那个是什么意思"，问一句也说得通）
          T8（与 §2.4 同一条待复核样本）
```

⇒ **同一份样本三次读数是 21 / 23 / 22**（v1 87.5% · v2 95.8% · 第三次 91.7%）。
这是**真实的运行间波动**，必须如实说，并由此得出两条使用纪律：

```text
① 判据用"**关键假阳 = 0**"这类**对波动稳健**的量：三次都是 0（v1 那次 A6 是唯一的例外，
   而它已被 v2 的一般性规则修掉）。
② 单次"分支正确率"**不能当成阈值**：它 ±1~2 例就会跨过 85%。
   ⇒ 登记 `L-RTD-23`：想用比率做硬判据，必须先定"重复几次取什么统计量"（本批没定）。
```

### 2.4 两条**样本期望待复核**（登记，不改样本）

```text
T8「把这份提纲生成一个 docx 放到 C:\work\report.docx」⇒ 模型 clarify
   复核意见：本轮上下文里**并没有那份提纲** —— 先问一句是**合理**的。
   ⇒ 期望可能需要补上前提（`recentLines` 里给出提纲），那属于**样本 v2**，
     不是"把 v1 改绿"。按读数不回写的纪律：三代读数与这条复核意见**并排留档**。
T10「打开浏览器看看 https://example.com 上有什么」⇒ 模型 web.read（三次都一样）
   复核意见：先读正文再决定要不要开浏览器，**更省**；期望集合可能应接受 `web.read`。
   同一条纪律：登记，不改样本。
```

### 2.5 **代价读数**：决策调用的时延分布（2026-10-05 首次测量）

计划书 §7 逐字要求把代价说清楚（"首版私有决策阶段会增加模型调用与延迟"），
而这条读数在激活时**一次都没量过**（ADR-105 §4 当时只写"待观察"）。现在有了：

```text
同一次语义评估（24 例冻结样本 · 验收端点 · **生产尺寸的目录** 2419 字符 + 已知目录事实）
决策调用 24 次：min 974ms · avg 1725ms · p50 1500ms · p90 2400ms · max 3941ms
**达到/超过 8000ms 期限的：0 次**
第四次读数（同一份样本）：分支 23/24 = 95.8% · 关键假阳 **0** ⇒ 硬判据 PASS
```

两条使用结论（都是数字直接支持的）：

```text
① 缺省期限（`CHARACTER_TOOL_DECISION_TIMEOUT_MS` = 8000ms）在**验收端点**上有约 **2 倍余量**
   （max 3941ms）⇒ "她有时像忘了用工具"在**这条端点**上不是超时造成的。
② ⚠️ 这条结论**只覆盖验收端点**：生产走 `api.deepseek.com`（`L-RTD-21`），
   生产上的时延仍**未量过** —— 激活后的首个真实轮是第一次机会，
   而"超时"与"她决定不用工具"在账本上**长得一样**（都没有动作），
   只有 trace 里的决策读数能把两者分开。
```

⚠️ 它**不是判据**（不决定退出码）：24 例上的比率波动已经证明比率类数字不适合当硬阈值
（`L-RTD-23`）。这里给的是**分布**与**越界计数**。

---

## 3. WP4 的四项（**不许用工程绿代替**）

```text
① 隔离真实链（计划书 §6 的"隔离真实链"）
   状态：**已完成**（`postlv2:role-tool:live`，本节下面补记）
② 人审（计划书 §6 的"人审 PASS"）
   状态：~~**PENDING**~~ → ⏩ **2026-10-05 声明式裁定：PASS**（用户原话「人审……已过」；
   先例 M8/M10.1/M11：声明式裁定归档于本节，机器读数原来的 `PENDING` **不回写**）。
   送审材料 = 本记录 §2 四次读数 + §2.4 两条复核意见 + §2.5 代价读数 + §6 边界清单。
③ 生产激活
   状态：~~**NOT AUTHORIZED**~~ → ⏩ **2026-10-05 已激活**（用户指示「生产激活先执行」；
   载体 [`ADR-105`](../adr/ADR-105-role-tool-decision-activation.md)，**只做状态修订**）。
   `.env` 只追加一行 `CHARACTER_TOOL_DECISION_MODE=role`；代码缺省仍是 `rules`。
   机器判据：`pnpm postlv2:role-tool:activation:readback` = **PASS**（激活前如实 NOT PASS）。
   候选配置与前置条件照 §4 保留（回滚 = 删那一行）。
④ **首轮真实使用**
   状态：~~`FIRST-USE NOT OBSERVED`~~ → ⏩ **2026-10-05 `FIRST-USE OBSERVED`**
   （用户原话「真实对话轮已过」；**机器读数**见 §3.2，不凭口述）。
```

### 3.1 隔离真实链的读数（真模型 **且** 真执行）
```bash
pnpm with-test-model pnpm postlv2:role-tool:live
```

```text
wp4-live-chain PASS（10 条输入）· 端点 ark.cn-beijing.volces.com
runId = role-tool-live-20261005T131623-358b50f5
```

```text
L1 该用工具的一句真话（"帮我看看这个目录里有哪些文件：<合成树>"）
   · 她**真的选了**工具（决策读数 branch=tools，落在 trace 的属性上）
   · 动作**真的被执行**（真适配器、status=success、executed=true）
   · **真实内容**回到轮次（含合成树里的真实文件名 notes-cn.txt）
   · 那份内容**真的进了 prompt**（turn-content section 含文件名）
   · **账本**里有对应的执行记录（Level 2 证据）
L2 闲聊（"今天有点累，随便聊两句吧。"）⇒ branch=answer 且**零动作**、账本不增
L3 指代不明（"帮我把它整理一下。"）⇒ **零动作**（不许猜一个目标就动手）
L4 `data/pglite` 的文件摘要前后逐字相同（本支从不打开真实库）
```

⚠️ 本支**同时逮到一个真缺陷并已修**（可观测性缺口）：role 档**真的动过手**的轮次里，
决策读数原来**根本不落 trace**（那一步只在"什么都没做"时才写）⇒ 现在两种情形都写：
动过手的挂在既有 `action_dispatch` 步的属性上（`decision` / `decisionStopped`，闭集码、无正文、
**不新增 step kind**），没动过的仍是原来那一步。

⚠️ 本支自己的量具也修了两处（都记在这里，因为它们是"量错了对象"的同一种形态）：
按**标签**找那一步（成功执行的轮次标签不含"角色决策"）、以及只认 `branch` 键却忽略
`decision` 键（两种记录形状）⇒ 现在按"属性里有没有决策码"找，并在量具里做键的归一。

### 3.2 首轮真实使用（**生产库快照副本上的机器读数**）

```bash
pnpm postlv2:role-tool:first-use:readback        # 只读；**从不打开真实库**
```

**它读的是什么**（安全边界写死在代码里）：

```text
真实对话发生之后，系统自己在会话收尾时留了一份 **verified 快照**
  （`data/snapshots/<id>` + `<id>.manifest.json`；本条来自一份
   `operationKind=chat` · `cleanClose=true` 的会话：14:43:23Z → 14:46:44Z）。
本支把那份快照**复制**到 %TEMP%，只在**副本**上做 SELECT-only 读回：
  · 从不打开真实库（先判"副本与真实库不重叠"）
  · 唯一的查询口逐句检查首词，非 SELECT 直接拒绝（与 `verify-m4-real-db` 同形）
  · 证据里没有她的回复、没有文件内容 —— 只有闭集码 / 计数 / 时延
```

运行读数（真实库，最近 6 轮）：

| 轮次（trace 前缀） | 决策分支 | 决策那一步时延 | 这一轮的动作 |
|---|---|---|---|
| `trc:816a23fe…` | **answer** | 1906ms | （无） |
| `trc:99a0c34d…` | **tools** | 1460ms | **`local.file.list=success`** |
| `trc:29315a79…` | **clarify** | 2492ms | （无） |
| `trc:4461adfd…` | （无决策步） | — | `web.search=success` · `web.read=timeout` · `news.read=failed` |
| `trc:38759278…` · `trc:d3935995…` | （无决策步） | — | （无） |

**这份读数说明四件事**（每一条都是机器读数，不是口述）：

```text
① **FIRST-USE OBSERVED**：真实生产轮里出现了本方案那一步（trace 属性里的 `decision`），
   而且**三种分支都用到了**（answer / tools / clarify）——
   这正是"她自己判断"应当有的样子：不是每条都动手。
② **真实生产里真的动过手**：`tools` 那一轮的账本写着 `local.file.list=success`
   （动作经既有 Gateway / 账本落库，Level 2 证据）。
③ **决策时延 1.46–2.49 秒**，与 §2.5 在验收端点上的分布（min 974 / max 3941ms）同量级
   ⇒ 8000ms 期限在**真实端点**上也够用（这是 `L-RTD-21` 的第一份生产侧读数）。
④ 更早那两轮**没有**决策步（`(无)`）—— 它们落在激活之前（或走的是旧路径）；
   这本身说明"按轮分列"是必要的：混在一起会把激活前后的行为读成一件事。
```

⚠️ 仍**不**主张：这是**一轮会话**的读数（不是统计量）；`web.read=timeout` 那一行来自
M5.5 的搜索链，与本方案无关（既有 `L-M55-12` 已登记"真实超时是常态"）。

---

## 4. 激活候选（**只写候选，不激活**）

```text
要追加的那一行（`.env`，**只追加一行**）：
    CHARACTER_TOOL_DECISION_MODE=role

前缀条件（缺一项就等于没接上）：
  · `CHARACTER_TASK_AUTONOMY_ENABLED=true` ← **当前已经是 true**（ADR-099）。
    只开 role 而不开它 ⇒ 决策会被**跳过**（日志/读数记 `branch=skipped · reason=no_task_loop`）。
  · 决策端点可达：生产走 `.env` 的 `OPENAI_BASE_URL` / `OPENAI_SMALL_MODEL`；
    ⚠️ **生产端点 ≠ 验收端点**（本记录的语义评估跑在 ark；先例 `L-M85-14`）
    ⇒ 激活后的**首个真实对话轮**要回看读数（延迟 / 失败率），不许拿验收端点的数字当生产读数。
回滚：删掉那一行（或改成 `rules`）⇒ 逐字节回到今天的行为。
不因激活而新增的主张：`L-RTD-01…21` 全部照旧。
```

---

## 5. 残余（本批新增，**不改写既有编号**）

```text
L-RTD-19 决策提示词的**格式合规率不是 100%**：v1 有 1/24 因缺计划字段被拒
         （`tool_decision_tools_missing_plan`），v2 为 0/24。按 `D07` 决策**不重试**
         ⇒ 一次格式失误 = 那一轮不用工具（如实降级，不是错答）。
         可选的将来改动：给决策加**一次有界重试**（与任务规划器的
         `MAX_INVALID_OUTPUT_STREAK` 同形）——那是 `D07` 的修订，需单独裁定。
L-RTD-20 样本只有 **24 例**：它证明"在这 24 例上关键假阳为 0"，**不**证明开放对话零误判
         （计划书 §6 逐字要求不许这样宣称）。
L-RTD-21 语义评估跑在**验收端点**（ark/`deepseek-v4.1-flash`），生产端点不同 ⇒
         生产上的选择质量**尚未量过**（激活后首个真实轮是第一次机会）。
L-RTD-16 `sandbox.file.read` 不产出当轮内容 —— **用户 2026-10-05 裁定：保持现状并写明**
         （要看正文用 `local.file.read`；见 Rulings 记录 §1）
L-RTD-17 ~~旧沙箱写在任务环里永远 `validation_failed`~~ → **已裁定 + 已修**
         （教适配器读暂存引用；同 Rulings 记录 §2）
L-RTD-18 ~~`document.read` 作用域与跨域入口矛盾~~ → **已裁定 + 已实现**
         （用户：**允许访问本机所有文件**；同 Rulings 记录 §3 —— 只放宽**读**的域，
          写侧域、风险等级、路径闸（网络共享/设备路径/ADS）一个字节未动）
L-RTD-22 T8 / T10 两条**样本期望待复核**（见 §2.4）：它们今天记成"不符"，
         但复核意见认为模型的答案更合理 ⇒ 样本 v2 要么补前提、要么放宽期望。
```

---

## 6. 不主张

```text
· 不主张"全工具覆盖完成"：WP3 仍有 4 项 NOT RUN。
· 不主张"生产已激活"：`CHARACTER_TOOL_DECISION_MODE` 代码缺省仍是 `rules`。
· 不主张"她一定选得对"：24 例固定样本上的读数，不等于开放对话。
· 不主张真实链已过：隔离真实链**还没跑**。
```
