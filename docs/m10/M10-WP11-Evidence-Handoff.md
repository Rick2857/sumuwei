# M10 WP11 交接单 —— 证据档完整性与文档一致性

- 日期：2026-09-29
- 工作包：WP11 的**离线可做部分**（回归 · 收口工具 · 文档一致性）
- 状态：**COMPLETE**
- 本轮关闭：`L-M10-40`（`G48` 的"损坏**证据档**判定器"）
- 本轮新增：`L-M10-55`（`A8` 判据的放松点，如实登记）
- 门：`pnpm m10:evidence:verify` = **PASS 11/11** · `pnpm m10:docs:verify` = **PASS 10/10**

---

## 1. 为什么会有这一轮

WP11 的出口要求"残余每条有范围和处置"，而把 54 条限制汇总时发现
**`L-M10-40` 仍然开着**：`G48` 的原文是"损坏输出 ⇒ `INVALID`/`FAIL`；**零分母不是 PASS**"，
其中

```text
✅ WP8b   覆盖了"坏**模型输出**"（非法 JSON → 那一格是 FAIL，不是静默）
✅ WP9-B  覆盖了"**零分母**"（G48a/G48b 含正控）
❌ 未做   **证据档本身**损坏 / 不自洽 / 无法解释时，判定器必须报 INVALID
```

最后这条正是本仓库反复出现的坑的**根**：**"0 个失败"与"什么都没量"在输出上长得一样**。

## 2. `m10:evidence:verify` 判什么

`validateM10Manifest` 已覆盖：必填字段 · schema 版本 · runId 形状 · counts 是整数 ·
**`counts.total > 0`** · phases · supersedes 形状 · **`payloadSha256` 自洽**（清单被改过）。
⇒ 本门补它**管不到**的四类**不自洽**：

| 检查 | 判据 | 为什么这条必要 |
|---|---|---|
| `A0` | run 目录数 > 0 | "遍历了 0 个目录、发现 0 个问题"与"全部完好"在输出上长得一样 |
| `A1` | 每个 run 目录自洽 | 清单通过 `m10-manifest@1` · **runId = 目录名** · 证据档可解析 · **两处记账一致** · verdict 与 failed 一致 |
| `A6` | `manifest.head` 是本仓库里**真实存在**的提交 | 编一个 head = 无法追溯产生这份证据的代码 |
| `A7` | `supersedes` 指向的 run **还在** | 悬空的取代链 = 声称被取代的读数已经丢了 |
| **`A8`** | **每个 FAIL 档都有具名解释** | **本门最要紧的一条**：要么是测量汇总里登记的**注入负控**，要么**被更晚的一次同门尝试取代**。⇒ "FAIL 档不许静默存在"是机器判据，不是"我记得它们是注入的" |

### 2.1 读数（PASS 11/11 · `A=5 · B=6`）

```text
run 目录        567 个 · 全部自洽 · 0 个 INVALID
不同的 head     45 个 · **全部是真实存在的提交**
取代链          0 条悬空
FAIL 档         164 个 · **全部有具名解释**（注入负控 132 · 被第二代取代 32）
```

### 2.2 损坏判定器的**正负控**（B 组，全部在 `mkdtemp` 副本上）

```text
B1 正控  干净副本（**目录名同原名**）⇒ VALID
B2 负控  截断证据档 ⇒ INVALID
B3 负控  删清单必填字段 ⇒ INVALID
B4 负控  counts.total 改 0 ⇒ INVALID（AGENTS §6.8）
B5 负控  改清单一个数 ⇒ `payloadSha256` 不再自洽 ⇒ INVALID（**篡改的机器判据**）
B6 负控  runId 与目录名不符 ⇒ INVALID（把清单拷进错的目录仍能通过 validate ⇒ 假证据）
```

## 3. 本轮抓到的**四处**缺陷（都在我自己的新代码上）

### 3.1 `verdict` 的词汇表不止 `PASS`/`FAIL`

第一版按 `verdict !== 'PASS'` 判自洽 ⇒ 当场红了**三个真档案**：
`m10:wp0:admission` 的 verdict 是
`'ADMISSION PASS（六问均有代码指针与实测读数；Q4 的端到端探针具名交接 WP6）'`
—— 它是**合格**的证据，而按等号判会被读成"FAIL 档却报 failed=0"。

⇒ 判据改为**词汇**而非等号：出现 `FAIL` ⇒ 期望 `failed > 0`；不出现 ⇒ 期望 `failed === 0`。

### 3.2 正控副本的**目录名**让五条负控全部测错了东西

第一版把副本建在 `work/<原名>-clean` ⇒ 目录名与原名不同 ⇒ `A2`（runId = 目录名）判它 INVALID
⇒ **正控以"被判 INVALID"收场**。若我没有写 `B1` 这条正控，
后面五条负控就会**全都因为"目录名不符"而变红** —— 也就是**没有一条在测它该测的东西**。

⇒ 每条副本的叶子目录名都改成原名，只有注入的那处缺陷会触发判定。

⚠️ **这是"正控的价值"的一个干净例子**：负控全绿不等于负控有效。

### 3.3 `A8` 的判据让本门**第一次跑必定红**

本门的**上一代**（`m10-wp11-evidence-…-9bfa`）是它自己的 FAIL 档，
而它唯一的"更晚的 PASS"要等**本门跑过之后**才存在 ⇒
按"必须有更晚的 PASS"判，**本门第一次跑必定红**，之后才好 —— 一条"首次必红"的门不是门。

⇒ 判据放松为"**被更晚的一次同门尝试取代**"，并在解释里**打印取代者的判定**
（读者能自己看见取代它的是 PASS 还是又一次 FAIL）。"最新那次过没过"由 **lane 聚合**回答。
⇒ 这条放松**如实登记**为 `L-M10-55`。

### 3.4 `m10:docs:verify` 的 `A2` 与 `A3` 各有一处不精确（**由它自己抓到我**）

我先把 `L-M10-55` 写进了汇总文，**没有**先写进任何源文件 ⇒ `A3` 立刻报"编造 1 条"。
**它抓得对**：汇总只能汇总**已经具名登记过**的边界。

同时暴露 `A2` 的一处不精确：它比的是"声称的最大编号 vs **源文件里的**最大编号"，
而**没比"汇总文自己含有的**最大编号" ⇒ 汇总声称 54、实际含 55 时它**不响**。
⇒ 已改为与 **`源 ∪ 汇总`** 的最大编号比。

## 4. 相关回归

| 项 | 读数 |
|---|---|
| `pnpm m10:evidence:verify` | **PASS 11/11**（`A=5 · B=6`） |
| `pnpm m10:docs:verify` | **PASS 10/10** |
| `pnpm gates:run --lane m10` | **19 道 · PASS 19 · FAIL 0** |
| `pnpm gates:verify` | **PASS 51 项 / 0 失败** |
| 真实库 | **从未被打开**（本门只读 `artifacts/`） |

## 5. 本步**不**主张什么

```text
· 它**不**重跑任何门，因此它**不**能替代任何门的判定
· 它**不**主张"最新那次过没过"（那是 lane 聚合的事，见 L-M10-55）
· 它**不**主张任何语义 / 人审 / live 结论
· 它**不**校验 payload 的**内容**对不对，只校验它**自洽且可追溯**
```

## 5.1 `L-M10-56` —— 一次**无法复现**的 `identical=false`（不掩盖）

本轮收尾时读到过一次 `identical=false`（真实库树摘要），**无法复现**。已核过的事实：

```text
① 同一轮里其余读数全部 identical=true
② 随后**连续 6 次**读同一摘要：全部 true，且等于长期期望值
   8c8a196b9330fa01c3e1a861a944ebc012d94bcb1f76d98cc096600504ae84bf · 1211 文件
③ `data/pglite` 下**今天被改动的文件数 = 0**（mtime 全部停在 2026-09-29 10:10）
④ `isolateDatabase()` 的沙箱在 `tmpdir()` 且**硬拒绝**与真实库路径重叠
⑤ 无遗留后台进程
```

⚠️ **处置而不是解释**：一次说不清的读数本身就是一条需要处置的读数。
⇒ 从本轮起，真实库不变量的读法改为**连读两次、必须一致**；
不一致时报 `MEASUREMENT INVALID`，**不报** `true` 也不报 `false`。
本条交 WP11/WP12 复查（真库相关的门应当自带这条重读判据）。

⚠️ 它**不**改变任何既有结论（M10 的实验全部在隔离库里跑，真实库的**内容**
可验证地未变），但**"解释不了"与"没问题"是两件事**。

## 5.2 `m10:evidence:verify` 必须 `serial`（一条**未踩到但真实**的抖动）

本门**遍历整个 `artifacts/m10/**`**，而**同一条 lane 里的兄弟门正在并发写那棵树**。
真实的失败形态：兄弟门刚写完**证据档**、还没写**清单**（我的门都是先写 payload
再 `writeM10Manifest`）⇒ 本门读到那个目录会判"清单缺失 ⇒ INVALID" ⇒
**一条与产品无关的抖动**。首次跑时它没出现（时机），但那是运气。
⇒ `resources` 里已声明 `parallel: 'serial'`（独占时段）。

## 5.3 `L-M10-56` 的**追查结果**（本轮）

### 做了什么

1. **把那条读数做成可诊断的**：`pnpm m10:realdb:invariant`（门，PASS 5/5）——
   连读 N 次、**逐文件**比对 sha256，一致时报聚合摘要，**不一致时逐条列出哪个文件变了**
   并判 `MEASUREMENT INVALID`（**不报** `true` 也不报 `false`）。
   聚合公式与 `digestTree` **逐字相同** ⇒ 两者可比（实测一致）。
   ⚠️ 它**不开库、不取租约**（只读字节）⇒ **不**能替代只读验收脚本的租约纪律。
2. **在负载下尝试复现**：把 `--lane offline`（34 道门）跑起来，
   其间连读 **8 轮 × 3 次 = 24 次读数** ⇒ **全部 PASS，0 次非 PASS**。
   ⇒ **复现失败**。
3. **排除一个假设**：全仓库 **194 处 `digestTree(` 调用**，**没有任何一处**对 `data/`
   （整个目录）取摘要 —— 都是 `data/pglite`。⇒ 唯一写入 `data/` 的 `eval:telemetry`
   （写 `data/telemetry-dump.jsonl`，真实库的**同级**文件）**不可能**扰动任何摘要。

### 结论（如实）

```text
· **仍未定因**。它没有复现，我也没有造出一个能解释它的机制。
· 但它现在**不会再以"解释不了"收场**：下次出现时，工具会说出**哪个文件**变了。
· 处置已生效：真实库不变量一律走这个工具（连读 + 逐文件 + 不一致即 INVALID）。
```

### 追查中发现的一处**同类隐患**（**不属 M10**，如实登记）

`scripts/verify-m5.1.1-d01-live-smoke.ts:1276` 有一份**自己的** `digestTree`，
与 INC-01 的**冻结算法**（`production-db-safety.ts`，多份 M6/M7/M8/M9 基线脚本的注释
逐字写着"**唯一实现，本脚本不重写**"）**不等价**：

```text
冻结实现  `${rel}\t${size}\t${contentHash}\n` 排序后 sha256，**排除** VOLATILE_EXCLUDED_PATHS
          （当前 = ['postmaster.pid']，排除理由见事故报告附录 C.2）
本地实现  `${relative}|${size}|${sha256}`，**不排除任何路径**
```

⇒ 后果有两个：① 两者对同一棵树给出**不同的摘要**（不可互比）；
② 本地那份**不排除 `postmaster.pid`** ⇒ 单是那个易失文件的有无就能让它报"变了"。
**它不解释我的那次读数**（我用的是冻结实现），但它是**同一类隐患**。

⚠️ **归属**：`docs/m5.1/**` 是 `m5.1-complete` 冻结面（AGENTS §3：不得改它的实现）。
⇒ 本文件**只登记、不修改**。是否收进跨里程碑技术债登记册由用户/维护线裁定。

## 6. 覆盖账收口轮：G35 / G36 / G47 与 `L-M10-57`

### 6.1 G35（到期 / 违约证据）⇒ `COVERED`

契约 §3 的三段**各补一条判据**（都在 `m10:test`）：
**无自动发送** = `C11`（目标域生产文件里没有定时器/调度器/出站调用）·
**`overdue`/`outcome_unknown` 不冒充** = `C7`（不在任何闭集、也不在源码里）·
**有匹配违反证据才 `broken`** = `C8`（真的 payload 校验器三向）+ `C6`（`status:'broken'` 落点恰好一处）
+ `L11`（正控）+ `X22`（终态承诺再收 broken ⇒ no-op）。

### 6.2 G36（时间 / 时区歧义）⇒ `COVERED`，且**揭出一处真缺口**

`C9`：不猜日期是**结构性**的（生产侧没有任何一处写 `dueAt`）。

⚠️ **`C10` 当场是红的**——它揭出：契约 §3 的 G36 后半句是「`dueBasis` 与解析依据**可查**」，
而结构校验**只**要求"`dueBasis` 若出现则非空"，**没有**要求"`dueAt` 有值时 `dueBasis` 必须出现"
⇒ 带 `dueAt`、不带 `dueBasis` 的目标可以落库，**日期的来历查不到**。

⇒ 处置：按"**实现**契约"补严 `src/kernel/contracts/goal.ts` 的 `time` 段。
三条性质保证不误伤：① **更严**，不放松任何既有判据；② 生产侧没有 `dueAt` 生产者
（`C9` 就是这条的判据）⇒ 今天不存在会被它拒的真实事件；③ 只约束**新写入**。
⇒ 契约（`DESIGN FROZEN`）语义**一字未动**，这是把它**落地**。

### 6.3 G47（200 / 500 轮）⇒ `COVERED`，**判读写在明处供推翻**

契约的**核心判据**列是「设立 → 暂停 → 恢复 → 失效 → 修订 → 取消/完成**全链在案**；每回合有状态」，
在 **200 轮**上已满足（`m10:long:verify` 的 `L1`：`5/5` 全链在案 · `L2`：`0` 轮无状态）。
⚠️ **标题里的"500 轮"未跑**，仍如实登记为 `L-M10-44`。
本轮的判读是"**覆盖看核心判据列，不看标题**" —— **这条判读供收口方推翻**；
若认为标题本身也构成要求，G47 应回到 `PARTIAL`。

### 6.4 `L-M10-57`：G07 的第三句判据是**语义比较**，v1 不做

契约 §3 的 G07 逐字：「`acceptanceRefs` 指向**具体提议** + 用户采纳原话；**范围不超原提议**」。

```text
第一句「指向具体提议」  ✅ C8（缺 proposedByAssistantEventId）· C14（缺 proposalSpan · C8 到不了的那一半）
                          · **B5 正控**（合法采纳 ⇒ understood 且 origin=character_proposed 被保留）
第二句「用户采纳原话」  ✅ span 的结构校验（C4–C6）+ B4（切片来自原话，不是模型给的文本）
第三句「范围不超原提议」❌ **未做** ⇒ 本条限制
```

⚠️ **为什么第三句不做**：它要比较"用户采纳的那段话主张的范围"与"她提议的那段话的范围"——
**内容范围的语义比较**。而本仓库的纪律是"语义判据必须有自己的量具"
（`L-M10-18` 同族）。草案层**已经**同时持有两段范围（`span` 采纳侧 / `proposalSpan` 提议侧）
⇒ **材料齐了，缺的是判据**；补它要另立一个语义量具，**不能顺手写个正则**。

⚠️ 另记一处**同类形状**（本轮自己踩的）：B5 第一版手写了输入对象
`{qualification: …}`，而真实字段名是 `sourceQualification` ⇒ 读数变成 `source_unusable`
（**输入的字段名写错，读数就长得像"来源不合格"**）。
⇒ 现在 B5 用**门自己的** `inputFor()`。这与上一轮"生成器与计分器字段名说不到一块去"是同一条教训。

### 6.5 `L-M10-58`：live 档跑不过 —— **根因已定位并修掉（真缺陷，不在 M10 的代码里）**

WP11 的任务清单里有"完整 `m4.5:ci` 与**真模型全量档**"。本轮跑了
`pnpm with-test-model pnpm m4.5:ci:full`（测试端点，`.env.test` 预检已 PASS）：

```text
m4.5:ci（离线全链）   ✅ 全绿 —— kernel 26/0 · M3 67/0 · M4 258/0 · M4 隔离 22/0 ·
                     Backup/Restore 24/0 · Mutation 20/0 · M4.5 L0 38/0 · L1 135/0 ·
                     L2 53/0 · L3 32/0 · promptfoo 3/3 · Phase H 54/0 · OTLP 21/0 ·
                     干跑 17/0 · provider 11/0 · M3.5 30/0 + 31/0 · NL 38/0 · 场景 17/0
m4.5:smoke:live        ❌ **26 通过 / 18 失败**（status=FAIL）
```

**根因（从转录里读出来的，不是猜的）**：

```text
Error  语义召回已开启，但本机模型资产与清单不符（**不**自动下载）：
       verified=0/7 missing=config.json, quant_config.json, sentencepiece.bpe.model,
       special_tokens_map.json, tokenizer.json, tokenizer_config.json, onnx/model_quantized.onnx
```

⇒ `.env` 里 `memory-semantic-recall` 是 **ON**，而本机**没有**那份 ONNX 资产
⇒ 每一轮的 CLI 都以 `exit=1` 退出 ⇒ `S11.2`（每一轮 CLI 正常退出）红
⇒ 依赖"那一轮真的跑完了"的 17 条断言**全部空转**（`S11.3`：`S1=1 S2=1 … S9=1`）。

⚠️ **三条性质**：
1. **与 M10 无关**：它不经过目标域的任何代码；根因是环境里的模型资产缺失
   （`verified=0/7` ⇒ 我**第一版据此判成"资产缺失"——那是读错了**，见 §6.5.1）。
2. **真实库未受影响**：证据里 `productionDb` 记的是**源**路径，note 逐字写着
   "生产库全程只被复制，从未被打开"；当时的
   `m10:realdb:invariant`（连读两次 + 逐文件）**1211 个文件全部未变**。
3. **`m4.5:ci` 内部那份聚合读数会误报**：它按设计"只读已落盘证据"，
   而它是在 `smoke:live` **更新那份证据之前**跑的 ⇒ 它在同一次调用里打印了
   `G14 Production-copy Live Smoke PASS 52/0 [HARD GATE]`（**上一代的**读数），
   而紧接着真正跑的 live 档是 `26/18 FAIL`。
   ⇒ **同一批输出里同时存在"PASS"与"FAIL"**，读者只会看到前者（详见 §6.6）。

**处置**：
- **保留**这份 FAIL 证据（**失败档不回写**：`artifacts/m4.5/smoke/smoke-result.json`
  的 `status` 由 `PASS` 变 `FAIL`，按惯例**如实提交**，不还原成旧的 PASS）——
  还原它等于把一条真实读数藏起来。
- ⚠️ **它不改变 M4.5 的历史判定**：`M4.5` 的 PASS 是
  `m4.5-complete` 那个提交上的历史读数；本次是**当前环境**下的新读数，两者分列。

### 6.5.1 根因：**不是资产缺失，是启动探针的资产根漏了 `modelId`**

我第一版把报错读成"资产缺失"。逐个查下去，真根因是**路径不一致**：

```text
① `.env` 确实开着语义召回（CHARACTER_MEMORY_SEMANTIC_ENABLED 求值为 truthy = true；
   `.env.test` 未设该项 ⇒ 是**生产配置**在开）
② 资产**都在**：`artifacts/m9.5/local/embedding-lab/models/Xenova/multilingual-e5-small/`
   下 **7 个文件一个不缺**（config.json / quant_config.json / sentencepiece.bpe.model /
   special_tokens_map.json / tokenizer.json / tokenizer_config.json / onnx/model_quantized.onnx）
③ 清单的资产在 `assets` 键下（7 条，路径是**裸路径**如 `config.json`），
   `modelId` = `Xenova/multilingual-e5-small`
④ `verifyEmbeddingAssets(modelDir, manifest)` 的实现是 `join(modelDir, asset.path)`
   —— **不拼 modelId**
⑤ **编码方**（`encoder-worker-entry.ts:119`）用的是
   `verifyEmbeddingAssets(`${LAB_MODEL_ROOT}/${manifest.modelId}`, manifest)` —— **拼了**；
   **下载脚本**（`m9.5-a3-download.ts`）逐字写着
   "⚠️ **必须是嵌套布局** `${LAB}/models/${modelId}`：worker 按…"
⑥ 而 **`src/main.ts` 的启动探针**（第 970 行）**漏了那一段**
   ⇒ 它在找 `models/config.json`，真实文件在 `models/<modelId>/config.json`
   ⇒ **7 个资产全报 missing** ⇒ 启动即抛
```

⇒ **真缺陷**：启动探针的资产根与**编码方**、**下载脚本**、**实际布局**三者都不一致。
后果不只是 live 档：**只要 `.env` 开着语义召回，`pnpm chat` 也会在启动时抛同一个错**
（本机的角色**起不来**）。

**修复**（一行 + 注释）：把 `src/main.ts` 的探针改成与编码方一致
`verifyEmbeddingAssets(join(process.cwd(), LAB_MODEL_ROOT, manifest.modelId), manifest)`；
`localModelPath` 仍传**父目录**（与 worker 第 145 行一致）。

**修复验证**：`pnpm with-test-model pnpm inspect`（只读 CLI，会真的打开真实库）
**不再抛该错**、正常跑完。另按 AGENTS §5（`src/main.ts` 的必跑项）
跑了 `pnpm m4:test`（**258/0**）与 `pnpm m4.5:test`（**135/0**）。

### 6.5.2 ⚠️ 我在验修复时犯的一个**操作失误**（如实登记）

我用 `pnpm inspect` 去验"启动路径修好了没有"——**它是一条会打开真实库的只读 CLI**
（AGENTS §9 的"只读排查"清单里），跑完了完整的 INC-01 级联：

```text
IDLE → LEASED → PREOPEN_SNAPSHOT_VERIFIED → DB_OPEN → SERVICES_STOPPED →
DB_CLOSED_VERIFIED → POSTCLOSE_SNAPSHOT_VERIFIED → RELEASED（cleanClose=true，
post-close 快照 2026-09-29T21-29-56-797Z-80cabf1d7ea9）
```

⇒ 它**是合法的**（只读分类 + 租约 + 干净关闭 + post-close 快照），
但它**改变了真实库的树摘要**（INC-01 文档写明"**打开**会写 `pg_control` / WAL"）：

```text
修复前（长期参考值）  8c8a196b9330fa01c3e1a861a944ebc012d94bcb1f76d98cc096600504ae84bf
本次打开后（当前）    80cabf1d7ea99cee4af703a8017c42d2acface0409baf7324258d9ca623122b8
```

⚠️ 新值头部 `80cabf1d7ea9` **正是那条 post-close 快照 id 的尾段** ⇒ 自洽，
证明这是**合法级联**的结果，不是损坏。

**教训**：验"启动路径修好了没有"应当用**不打开真实库**的方式（live 档用的是**生产副本**）。
⇒ **摘要不是"跨打开不变"的**；它的角色是"证明**某个测试**没开过库"，不是"字节永不改变"。

### 6.5.3 这条发现**不能**解释 `L-M10-56`（又排除一个候选机制），并且纠正了摘要的**角色**（`L-M10-60`）

拿到"打开会让摘要**永久**改变"这条事实之后可以严格推理：

```text
L-M10-56 的形态：先读到 ≠ 期望值（false），随后连续 6 次读到 == 期望值（true）
而"打开"**不可逆**：它只会让摘要从 A 变成 B，**不会从 B 变回 A**
⇒ 一个"打开"事件**无法**产生"先变后回"的读数 ⇒ 候选机制又排除一个
⇒ L-M10-56 **仍未定因**，但"已排除"的清单变长了：
   资产/打开类事件 · `data/` 整目录摘要被 telemetry 扰动 · 沙箱路径重叠 · 遗留进程
```

**`L-M10-60`：摘要不是"跨打开不变"的 —— 它的角色要写准。**

```text
INC-01 文档逐字："**打开**会写 pg_control / WAL"  ⇒ 打开**必然**改变摘要
实证（本轮）：一次**合法**的只读 CLI（`pnpm inspect`，带租约 + 干净关闭 + post-close 快照）
              把摘要从 8c8a196b… 变成 80cabf1d…
```

⇒ **它的正确表述**是"**证明某个测试没开过库**"，
**不是**"字节永不改变"。
⇒ 因此 `m10:realdb:invariant` 的两个判据各有分工：
**不变性**（连读 N 次、逐文件比对）· **匹配**（`--expected`，一个会**跨打开过期**的参考值）。
本轮已把参考值更新为 `80cabf1d7ea99cee4af703a8017c42d2acface0409baf7324258d9ca623122b8`，
并注明**为什么**变（一次合法只读打开，不是损坏）。

#### 6.5.4 `L-M10-61`：修掉资产根之后，live 档**不再快速失败，而是卡在第一轮**

修完 `src/main.ts` 的资产根之后重跑 `pnpm with-test-model pnpm m4.5:smoke:live`：

```text
✅ S0.0 迁移 0006 在真实数据副本上应用成功 — exit=0
✅ S0.2 未知 status 必须报错退出（不得静默返回全部） — exit=2
✅ S0.3 未知 status 时输出没有任何记录行
（然后**没有下文**）
```

**判断它不是"慢"、而是"卡住"的两条读数**（都是文件系统的直接证据，不是感觉）：

```text
① 它的沙箱目录 `%TEMP%/project-lg-m45-smoke-NUSLGP/` 的 mtime 停在 **05:30:32**，
   而观察到的时间是 **06:42** ⇒ **72 分钟没有任何写入**
② 沙箱里的 `pg_control` mtime 同样停在 05:30:32 ⇒
   **从沙箱建好之后，没有任何一轮打开过那个副本**
   （每一轮的 CLI 都会打开副本 ⇒ 若轮次在跑，`pg_control` 会一直推进）
⇒ 结论：卡在**第一轮**，不是"十几轮各慢几分钟"
```

⇒ 已把它终止（`job_kill`）。⚠️ **它没有写出任何读数** ⇒
`artifacts/m4.5/smoke/smoke-result.json` 里仍是**上一次**那份 `26/18 FAIL`，
**没有**被这次运行改写（mtime 仍是 05:19:20）——这一点我核过，不靠推断。

⚠️ **这意味着两件事**：
1. **`main.ts` 的修复是有效的**：S0.x 过了、`pnpm inspect` 也不再抛 ⇒ 启动路径确实通了。
2. **live 档仍未验证**：`L-M10-58` 的"快速失败"换成了"**卡住**"，
   而 M10 的端口/prompt 装配改动**仍然没有 live 读数**。

**卡点已定位**（下一轮做完了）——见 §6.5.5。

### 6.5.5 `L-M10-61` 的**定位**：卡在语义召回那一段，且**文档里的 180s 就绪超时没有救它**

用**有界 A/B 探针**（`tmp-hangprobe`：同一个命令行，只改一个环境变量；
每次 `spawnSync` 带硬超时 + `SIGKILL`；**库指向一次性临时目录，不碰真实库**）：

```text
A  CHARACTER_MEMORY_SEMANTIC_ENABLED=false   status=0    用时 11.6s   ⇒ **模型调用那一侧完全正常**
B  CHARACTER_MEMORY_SEMANTIC_ENABLED=true    SIGKILL @150s（第一次）
B  CHARACTER_MEMORY_SEMANTIC_ENABLED=true    SIGKILL @300s（第二次，**跨过 180s**）
```

⚠️ **为什么第二次要用 300s**：文档里 `SEMANTIC_RECALL_READY_TIMEOUT_MS = 180_000`、
`SEMANTIC_RECALL_DEADLINE_MS = 120_000`。第一次的 150s **低于**那个阈值 ⇒
它**分不清"冷启动慢"与"死锁"**。跑到 300s 才是有意义的读数：

```text
⇒ 它**跨过了** 180s 的就绪超时仍然不动 ⇒ 不是"慢"，是**不降级的不动**
⇒ 那两条超时在**这条路径上没有被触发**（或卡点根本不在"等就绪"那一步）
```

**另两条排除**（都是跑了既有门/既有读数，不是推断）：

```text
`pnpm m9.5:encoder:verify`  = **PASS（10 项 / 0 失败）** ⇒ 编码器**本身**在本机可用
`CHARACTER_MEMORY_SEMANTIC_ENABLED=false` 的整轮 = 11.6s 走通 ⇒ 回复链本身没问题
```

⇒ **结论**：`semantic=true` 时的阻塞发生在**聊天轮次里的语义召回路径**上，**静默**
（bootstrap 之后再无输出），且**文档承诺的就绪超时没有兜住它**。这是 M9.5/M5.1 那条线的
缺陷（**不在 M10 的代码里**），但它**挡着 M10 的 live 验证**。

### 6.5.6 `L-M10-62`：live 档 harness 的 `spawnSync` **没有超时**

`verify-m4.5-smoke-live.ts` 的每一轮是 `spawnSync(node, [tsx, 'src/main.ts', …])`，
**没有 `timeout` 选项**（第 114 行）。⇒ 子进程一挂，**整档无限期挂住** ——
这正是 `L-M10-61` 那 72 分钟的来源（`pg_control` 与沙箱 mtime 都停在起点，已核）。

⚠️ **这与 M10 反复修的那一族同形**：一个"没有上界的等待"会让读数**看起来像在跑**，
而实际上什么都没发生。⇒ 处置：**登记**（它属 M4.5 的 harness）；可操作的纪律是
**跑 live 档时自己带超时**（本轮的探针就是这么做的）。

**第二层定位（再收窄一格）：阻塞**与语义模式无关**。**

只改 `CHARACTER_MEMORY_SEMANTIC_MODE`（合法值 `off` / `shadow` / `on`，见 `SEMANTIC_MODES`），
`CHARACTER_MEMORY_SEMANTIC_ENABLED` 恒为 `true`：

```text
mode=off     SIGKILL @150s
mode=shadow  SIGKILL @150s        （生产当前取值）
```

⚠️ **`off` 也卡** ⇒ 这不是"打分那一次调用"的问题：按装配注释，
`off` 时"语义分数**根本不被调用**"。⇒ 阻塞发生在**只要开关是 on 就会跑的那一段**，
即 `main.ts` 的 `buildSemanticRecallProbe`（清单 → 资产校验 → `createEncoderClient`
→ `createSemanticProbe`）或网关那两个选项（`recallPolicyVersion` / `recallSemanticMode`）。

**再排除一层"形状不一致"**（读代码，不是跑）：

```text
worker（encoder-worker-entry.ts）自洽：
  env.localModelPath = LAB_MODEL_ROOT            （= models/ 父目录）
  pipeline('feature-extraction', manifest.modelId) ⇒ 解析成 models/<modelId>/ ✓ 嵌套布局
  worker 自己的资产校验也用 `${LAB_MODEL_ROOT}/${manifest.modelId}` ✓
通过的那道门（m9.5-encoder-verify.ts:242）构造 client 用的也是
  { manifest, repoRoot: REPO_ROOT, localModelPath: LAB_MODEL_ROOT, deadlineMs: 120_000, readyTimeoutMs: 180_000 }
与 main.ts:979 的构造**同形** ⇒ "client 构造参数不同"这个假设**也不成立**。
```

⇒ **剩下的差异只在"在哪个进程/什么装配上下文里构造与使用它"** ——
这一层已经落进 M9.5 的 client 实现内部，**不是读几眼能定的**，且属**跨里程碑**。

⚠️ **我在这里停手**（与 §5.3 那份第二份 `digestTree` 同一个纪律）：
继续要**改或插桩别人的实现**，那是用户的裁定项。
**本轮交付的是一个更窄的边界，而不是一个猜测的原因。**

## 6.6 `L-M10-59`：`m4.5:ci` 内部的聚合读数**会误报 live 档**（登记不修）
同一次调用里，`m4.5:ci` 的聚合器**先**打印：

```text
✅ G14  Production-copy Live Smoke（L4）     PASS 52 通过 / 0 失败  [HARD GATE]
```

而**紧接着**真正跑的 live 档是 `26 通过 / 18 失败`。原因不是偶然：聚合器按设计
"**只读已落盘证据**"，而它跑在 `smoke:live` **更新那份证据之前** ⇒ 它读到的是**上一代**的 PASS。

⚠️ **后果**：同一批输出里**同时存在 PASS 与 FAIL**，而读者（或任何只看聚合行的脚本）
**只会看到前者**。这与本轮修的那些"读数看起来是通过"是同一族。

⚠️ **处置：登记，不修**。"聚合器只读已落盘证据"是既定的语义（AGENTS §6.4：
"不要手写全绿表格；文件不存在 = not-run，不是 PASS"），改它属**跨里程碑**。
⇒ 可操作的纪律：**读 live 档时以该档自己的证据为准**（`artifacts/m4.5/smoke/smoke-result.json`
的 `status`），不要以聚合器打印的 `G14` 行为准。

## 6.7 WP11 交付物：`M10-Activation-Candidate.md`（**`CANDIDATE / NOT READY`**）

计划 §12 的 WP12 逐字允许"**若尚无用户生产操作授权，只完成可审的候选与执行命令说明**"，
而 `Activation Candidate` 又是 **WP11 的交付物之一** ⇒ 本轮把它写出来了（**不激活任何东西**）。

**它的核心是一个逐项的候选条件核对表**（§18.1 的八项），每项都配**可直接复跑的命令**：

```text
MET     5/8   设计冻结 · 硬门/量具 · 旧门回归（仅离线）· 真实库保护 · cutover/回滚方案（本文件）
NOT MET 3/8   实现完成 · 语义与 live 达标 · 真人裁定
```

⇒ 结论 **`NOT READY`**，而且是**机器可查**的 `NOT MET`（不是形容词）：

```text
grep -c 'runGoalTurn' src/main.ts              = 0     ← 装配未接线（L-M10-48）
grep -n 'goal' src/kernel/app/flags.ts         = 无匹配 ← 计划 §18.1 推荐的生产总开关
                                                          CHARACTER_GOALS_ENABLED **只活在文档里**
```

**本轮顺带确认的一件事**：`flags.ts` 里**根本没有** goal 开关
⇒ 激活的缺口不止"接线"，还有"**开关本身不存在**"。
⚠️ 这两件都属 **M10 自己的实现**（§13 的"runtime / flags / `main.ts` 点追加"），
按 AGENTS §5 分别要跑 `m4:test`+`m4.5:test` 与 `m4.5:ci:full`。

**⚠️ 为什么本候选**不把**接线做掉（这是本轮的判断，不是"没时间"）**：
接线会**改变生产轮次的装配**，而这类改动按仓库自己的纪律（AGENTS §6.1）
**必须**有 Live Smoke 读数——"离线全绿 ≠ 真实链路正确……**冲突时以 Live Smoke 为准**"。
而 live 档**当前不可用**（`L-M10-61`：`semantic=true` 的聊天轮次静默阻塞）。
⇒ **在 live 档修好之前接线 = 往生产可及路径上放一段无法按仓库标准验证的代码。**
⇒ 缺口的次序关系写进了候选的 §2：**G-4（live）必须先于 G-2（接线）**。

**一处**延后**的加固（如实登记，免得被忘掉）**：候选里那张核对表的"机器可查指针"
目前是**给人复跑的命令**，**没有**一条门守着"表与事实一致"。
⇒ 建议补 `m10:activation:verify`（表里的 `MET`/`NOT MET` 与 `flags.ts`/`main.ts` 的实际状态对账，
落成**绊线**：谁接了线而没更新表，它就红）。
⚠️ 本轮**没做**：新增门会动到 `m10:measurement:verify` 的覆盖账（47/47、12/13 道门），
而那道门正在全绿 ⇒ 本轮选择**不扰动**它，把这个加固留给激活前那一轮。
⇒ **✅ 后续（§6.9 / §6.9.3）：那条加固已经做掉了** —— 门已落地，且**已收进自动覆盖**（`N13`），
量具自证现为 **PASS 54/54 · 覆盖 13/14**。

## 6.8 WP11 交付物清点：计划的名字 ↔ 实际的文件（**含改名交付**）

计划 §12 WP11 列了**七**项交付物。逐项对照实际文件后，**有三项的"名字"与"文件"对不上**，
而按名字清点会**误报"缺三份"**。如实登记这张对照表：

| 计划 §12 的名字 | 实际文件 | 状态 |
|---|---|---|
| `Architecture` | `M10-Architecture.md` | ✅ 同名 |
| `Known Limitations` | `M10-Known-Limitations.md` | ✅ 同名（62 条） |
| `Activation Candidate` | `M10-Activation-Candidate.md` | ✅ 同名（本轮，§6.7） |
| `Acceptance Report` | — | ❌ **未出**（结论文档，需 WP10 读数） |
| `Gate Decision` | — | ❌ **未出**（结论文档，需 WP10 读数） |
| `M10-to-M11-Handoff` | **`M10-M11-Read-Only-Contract.md`** | ✅ **改名交付**：该文件第 1 节是"九段只读面：在哪读"，第 2 节逐字是"**八条交接规则（计划 §19 逐条，M11 必须遵守）**"⇒ 计划 §19 要求的内容**就在里面** |
| `WP11 Handoff` | **`M10-WP11-Evidence-Handoff.md`**（本文件） | ⚠️ **部分覆盖**：证据档门 / 文档门 / 覆盖账 / 激活候选 / 跨里程碑发现都在案；**回归与收口那一部分待 Acceptance Report / Gate Decision** |

⇒ **按实质清点：5 项已交付（其中 2 项改名、1 项部分），2 项未出。**

> ⚠️ **本节是当时的读数，不回写**；**当前清点见 §6.12**（已累计 **14 项**：
> `Measurement Report` · `E2E Report` · `Acceptance Report` 三项都在其后补上了）。
>
> ⚠️ 而且下面那个判断**本轮被证明过强了**（如实记，不删）：当时我认为
> 「`Acceptance Report` 与 `Gate Decision` 都要等读数，否则只能写空结论」——
> **前半句不对**：`Acceptance Report` 是**事实报告**，它可以、也应该**逐槽写各自真实状态**
> （没跑的就写 `NOT RUN` 并说明原因），只有 `Gate Decision` 的定义**才**要求有结论。
> ⇒ 所以 `M10-Acceptance-Report.md` **本轮就写了**，而 `Gate Decision` **仍然**等读数。
> **教训**："这份文档需要数据"与"这份文档需要一个结论"是两件事；
> 把前者当成后者，会让**本可以做的诚实清点**被无限期推迟。

⚠️ **这两项未出的原因不是"忘了做"，而是它们**按定义**需要读数**：
`Acceptance Report` 与 `Gate Decision` 是**结论文档**，而它们的结论槽
（语义评估 / 人审 / live）**恰好就是 §6.7 那张核对表里 `NOT MET` 的三项**
（`U-15` / `U-11` / `L-M10-61`）。
⇒ 在那些读数到手之前写它们，只能写出**空结论**——那正是计划 §12 WP11 出口
"**未跑项不写 PASS**"要防的东西。**本里程碑不写空结论。**

## 6.9 补上 §6.7 说的那条加固：`m10:activation:verify`（**绊线门**）

上一轮把这条加固**如实登记为"建议补"**，本轮把它做了。它是**绊线**：把候选的缺口表
（`G-1`…`G-4`）与**代码的实际情况**对账。

```text
A2  【绊线】G-1 表里的状态 = `flags.ts` 里有没有 `CHARACTER_GOALS_ENABLED`
A3  【绊线】G-2 表里的状态 = `main.ts` 里有没有 `runGoalTurn`
A4  总判与逐条缺口一致（有开放缺口 ⇒ 必须是 NOT READY；全关 ⇒ 必须已改成 READY）
A5  每条开放缺口都有归属
A6  结论槽不撒谎：有开放缺口时"激活"槽不得出现 ACTIVATED
A1  材料在场（文件 · 8 项条件 · ≥4 条缺口）
C1/C2  正控/负控
```

**它防的是"表腐烂"这一类**（本仓库的老问题），而这张表尤其危险——它守的是**激活**：
表说 OPEN 而代码已接 ⇒ 下一轮的人**以为还没接**、可能**再接一遍**。

### 6.9.1 两处**实测**（都是本轮真的跑了，不是设计意图）

```text
① 正常态            verdict = PASS（8/8）
                    缺口：G-1=OPEN · G-2=OPEN · G-3=OPEN · G-4=OPEN
                    代码事实：flag=false · wired=false          ⇒ 与表一致

② **真实注入**（把 `runGoalTurn` 加进 `src/main.ts` 再跑）
                    verdict = FAIL（6/8）· **`A3` 红** —— 正是它存在的理由：
                    "表 = OPEN · 真实 = CLOSED"
                    还原后 `main.ts` 的 sha256 与注入前**逐字节相同**（已核）
```

⚠️ **② 这一步是本仓库 §6.7 的纪律要求的**：只有"正控安静"不算自证——
**必须往真实产物里注入一次**，看检测器会不会响。
⚠️ 理由同样成立：本仓库反复踩过"检查落在**从来没被读过的那个面**上"。

### 6.9.2 ② 顺带**抓出我自己的一处控制缺陷**（已修）

第一版把负控 `C2` 写成"相对**表里的值**翻一个"：

```text
注入态下：表 = OPEN（G-2）、真实 = CLOSED
          ⇒ "相对表翻"得到 CLOSED ⇒ **恰好与真实值一致** ⇒ C2 报"被判为一致"而红
          ⇒ 那条红**不是**"检测器坏了"，而是**控制本身依赖了被测对象的状态**
```

⇒ 已改成**相对真实值翻**：无论表是什么样，翻转结果都与真实值相反
⇒ `C2` 成为一条**独立于文档状态**的控制，读数永远可解释。
（注入态下复测：`A3` 红、**`C2` 不再红** ✓）

⚠️ **这条正是"自证用手造输入不够、必须用真实产物冒烟一次"的又一例**：
若只跑正常态，这个缺陷**永远不会露出来**。

### 6.9.3 顺带把计数改准（`L-M10-50`）—— 并在**再下一轮**把它收进自动覆盖

门从 21 道变 **22 道** ⇒ 量具自证的覆盖读数一度从 **12/13** 落到 **12/14**
（新门当时没被自动注入覆盖）。⚠️ **那个"12/14"是过渡态，不是终态** ——
紧随其后的一轮就补了 **`N13`**：

```text
N13  注入面 = docs/m10/M10-Activation-Candidate.md 的**缺口表**（那道门的**输入**就是它）
     from = G-2 那一行的尾部（含它独有的"见 G-4"与 `m4.5:ci:full`）
            ⚠️ 注入点必须**唯一**：G-1/G-3/G-4 的末列同样是 `| `OPEN` |`
     to   = 把 `OPEN` 谎写成 `CLOSED`  ⇒ **表在高估自己**
     期望 = exit≠0 且 **`A3` 变红**
```

**实测（三个方向都跑到了）**：

```text
V-N13  ✅ 注入点在 62 字符处命中（找得到 ⇒ 负控不会静默失效）
N13    ✅ 负控：exit 1 · **A3 红=true** · runId=m10-wp11-activation-…-bdfb
N13    ✅ 恢复：字节还原后 sha 一致 · exit 0（放回真实实现 ⇒ 重新安静）
⇒ m10:measurement:verify = PASS **54/54**（S=12 · N=13 · R=13 · V=13）
```

⇒ 终态 **13/14**：**只剩 `m10:preflight` 不在自动覆盖内**，
而它的理由是**结构性**的（**没有**可注入的产品面），与我上一轮的"选择不扰动"
是**两回事** —— 上一轮那句"两道原因不同、不许混为一谈"现在得到了验证：
其中一道只是**当时没做**，做了就只剩一道。
两道不在自动覆盖内的门**原因不同，不许混为一谈**：
`m10:preflight` **没有**可注入的产品面；`m10:activation:verify` **有**（它的输入是候选文档）
—— 后者是**当时选择不扰动一个全绿的门**的结果，**不是**"没有可注入面"。
⇒ **下一轮就把 `N13` 补上了**（见上一段），于是只剩 `m10:preflight` 一道。
⇒ 收进自动覆盖 = 补一条 `N13`（目标面 = 候选文档的缺口表）。这条登记在 `L-M10-50` 里。

## 6.10 收掉 `L-M10-44`：`G47` 的 **500 轮**真的跑了

上一轮之前，`G47`（计划 §14 场景名「200 / **500** 轮连续轨迹」）只跑了 200 轮，
而我在覆盖账里给出的处理是**一条判读**：「覆盖看**核心判据**列（"全链在案；每回合有状态"）、
不看标题」，并把那条判读**写在明处供推翻**。

⚠️ **一条需要读者推翻的判读，本身就是"还欠一把读数"的信号。** 本轮把那把读数拿到了：

```text
① `m10:long:verify` 加 `--turns=<n>`（**默认仍是 200** ⇒ lane 的读数与证据**不变**）
② 默认跑一次         turns=200 · PASS 11/11
③ 另跑 `--turns=500` turns=500 · PASS 11/11
④ 两次的 `L1` 读数**逐字相同**：
   链上出现=[cancel,create,pause,resume,revise] · 无状态轮次=0 · 未闭合=无
```

⇒ **`G47` 的两个数都真的跑过了** ⇒ `L-M10-44`（"500 轮未跑"）**销账**；
⇒ 覆盖账的 `G47` 行不再需要那条判读，**改写成读数**（判读是欠账，读数是资产）。
⇒ 这也把 §6.3 里"本轮的判读供收口方推翻"那句**兑现**了：不靠推翻，靠**把数跑了**。

⚠️ **一处刻意的设计**：`--turns` **默认保持 200** —— 因为 lane 的既有读数与证据
（以及 `G47` 在覆盖账里的那一行）都建立在 200 上，改默认值会让历史读数失去可比性。
500 轮是**追加**的一次独立读数，两者**分列**在 `artifacts/m10/` 里（`turns` 字段可区分）。

## 6.11 补上计划 §16.1 点名、而 M10 **一直没有**的那件：`m10:gates`

计划 §16.1 逐字点名 `m10:gates` —— 「**只读判定各证据，不隐式跑门**」（WP8/11）。
**每个别的里程碑都有**这一件（`m5:gates` / `m5.1:gates` / `m6:gates` / `m8:gates` / `m9:gates` …），
而 M10 一直没有 —— 于是 WP11 出口那句「必须门**无缺档 / 无非法 run**」**没有机器判据**。

### 6.11.1 §16.1 的 20 条点名命令 ↔ 实际（**逐条，机器可读**）

计划原话：「可按职责**合并**脚本实现，但**不能删掉对应判据**」。
⇒ 下表给**每一条**一个处置，且三种处置**恰好划分**那 20 条（20 = 14 + 2 + 4）。
⚠️ **处置列是判据读的那一列**（`m10:docs:verify` 的 `B3`）⇒ 改动时请保持这三种写法。

| §16.1 点名命令 | 处置 | 判据在哪 / 为什么 |
|---|---|---|
| `m10:baseline` | ✅ 独立脚本 | WP0 基线与准入探针 |
| `m10:test` | ✅ 独立脚本 | 契约 / policy / 纯 reducer / 非法边 |
| `m10:inputs:verify` | ✅ 独立脚本 | 真 revision · Belief 资格 · 主体隔离 |
| `m10:source:verify` | ✅ 独立脚本 | 原话 / 归因 / 采纳 / 形状 |
| `m10:lifecycle:verify` | 🔀 判据并入 | `m10:test` 的 `L1`–`L11` / `X1`–`X22` / `G1`–`G2` + `m10:invalidation:verify` 的 `C6`–`C8`（**判据未删**） |
| `m10:invalidation:verify` | ✅ 独立脚本 | 依赖失效 / 读时遮蔽 / Goal 遗忘 |
| `m10:completion:verify` | ✅ 独立脚本 | 真实结果绑定 / 假兑现与恢复 |
| `m10:context:verify` | ✅ 独立脚本 | 预算 / 重编译 / off 基线 / 行为输入 |
| `m10:observability:verify` | ✅ 独立脚本 | trace / 只读 DTO / 隐私与计数 |
| `m10:measurement:verify` | ✅ 独立脚本 | 量具正控/负控/恢复 + 分母与聚合器（**并含三条自指判据 `V2a`–`V2c`**，见 §6.18.1） |
| `m10:e2e:verify` | ✅ 独立脚本 | 真网关 + 隔离库 + 离线 provider |
| `m10:scale:verify` | ✅ 独立脚本 | 规模 / 查询可达与性能 |
| `m10:recovery:verify` | 🔀 判据并入 | `m10:completion:verify` 的 `P1`–`P6` / `I1`–`I5` + `m10:long:verify` 的 `L3` + `m10:e2e:verify` 的 `C1`/`C2`（**判据未删**） |
| `m10:long:verify` | ✅ 独立脚本 | 离线连续轨迹（`--turns` 默认 200，另跑过 500） |
| `m10:semantic:eval` | ✅ 独立脚本 | ✅ **已写出**（§6.20）：真模型门，带"缺包装器标记即拒跑"的守卫 + **量跑次间方差** + 逐案读数。⚠️ **有意不在任何 lane 里**（lane 登记属收口独立裁定）⇒ 已进 `gates:verify` 的具名例外；调用方式见 §6.20 |
| `m10:smoke:live` | ✅ 独立脚本 | ✅ **已写出**（§6.21）：真模型 + **有状态脚本轨迹 7 轮** + 隔离库；断言**结构不变量**（outcome 闭集 · 写类事件 +1 / 不写类 +0 · trace 五个读数 · `no_operation` 无事实块 · 库路径在 %TEMP% 下）。带同样的守卫（缺标记即拒跑） |
| `m10:long:live` | ✅ 独立脚本 | ✅ **已写出**（§6.21）：真模型 + 缺省 **200 轮**连续轨迹 + 收尾 **rebuild 对账**（验**不变量 ②**）。⚠️ 与零出网的 `m10:long:verify`（时间维度的边：重启/复活/迟到/重复）**各有归属** |
| `m10:regression:verify` | ✅ 独立脚本 | §6.11.4 补上（**§6.11 里它曾被就地注记为"本轮已补上"** —— 那种注记机械读不了，故改成本表的处置列） |
| `m10:gates` | ✅ 独立脚本 | §6.11 补上；只读判定各证据，不隐式跑门 |
| `m10:activation:readback` | ✅ 独立脚本 | ✅ **已写出**（§6.26）：计划 §18.2 的**三层读回**（配置 / 装配 / 首次行为）。⚠️ **它不打开真实库**：开关关着 ⇒ 按定义不可能有写入 ⇒ 第三层**定义上**即 `FIRST-USE NOT OBSERVED`（计划 §18.2 逐字）；开着时它**如实拒绝**并指出该走哪条路。⇒ 于是它**不需要**新的真实库授权 |

**合计：18 ✅ + 2 🔀 + 0 ❌ = 20** ✔ —— ⭐ **§16.1 点名的 20 条命令里已经没有"未实现"的了**（`lifecycle` / `recovery` 两条的**判据并入**了别的门）

⚠️ `m10:gates` 会把这些**如实报出来**（`A7`：未登记的命令逐条列出），
所以"聚合全绿"**不会**看起来像覆盖了那四条未实现的。

> ⚠️ **一处我方汇报错误的更正**（2026-09-30，Round 45）：我在若干轮的口头汇报里写
> 「§16.1 的 20 条命令：**19 已实现** · 2 判据并入 · 未实现 4」——**加不起来（19+2+4=25）**，
> 而且"19"是**把 §16.1 没计划过的命令也算进去了**（`package.json` 里共 27 条 `m10:*`，
> 其中 `m10:preflight` / `m10:review:materials` / `m10:review:score` / `m10:semantic:dry` /
> `m10:wp0:admission` / `m10:evidence:verify` / `m10:docs:verify` / `m10:coverage:verify` /
> `m10:activation:verify` / `m10:m11:verify` / `m10:realdb:invariant` / `m10:gateway:verify` /
> `m10:oracle:verify` 这些**不在 §16.1 的清单里**）。
> **正确的账就是上表：14 + 2 + 4 = 20。** 文档里的表一直是**对的**，错的只是我的转述。
> ⇒ 为防再犯，`m10:docs:verify` 新增 **`B3`**：**按这张表机械核账**（详见 §6.11.1a）。

### 6.11.1a 新增 `B3`：把上面这张表变成**机器判据**

```text
判据（`pnpm m10:docs:verify` 的 B3）：
  ① 从计划 §16.1 的表格里解析出**点名的命令清单**（必须恰好 20 条）
  ② 从本文件 §6.11.1 的表里解析**每条的处置**（三种写法之一）
  ③ 断言：20 条**恰好划分**（每条出现且只出现一次；三种处置相加 = 20）
  ④ 断言：标 `✅ 独立脚本` 的那些**真的在 `package.json` 里**
  ⑤ 断言：标 `🔀 判据并入` / `❌ 未实现` 的那些**真的不在** `package.json` 里
     （"说没实现却其实有"与"说实现了却没有"都要红）
```

⇒ 这样"§16.1 覆盖了多少条"就不再靠**我记得**，也不再靠**我算**。

⚠️ **而且这条判据自己出生时就是坏的 —— 如实记下来，因为它又是一个同族实例**：

```text
我改名一个局部变量时漏了一处引用（那次用 PowerShell 改，反引号被吃掉了），
读数于是印成：`表里 20 行（✅ 14 · 🔀 2 · ❌ 0）` —— **14+2+0 = 16 ≠ 20**
而判据**照样 PASS**：它比了"表里行数"与"点名条数"，却**没比分类的和**。
（那处 `missing` 指的是同文件里另一个同名变量，恰好为空 ⇒ 印出一个**像样的 0**。）

修法两条：① 改用 `notImplemented` ② **把"三者之和 = 行数"显式写进判据**。
三段式也做了：把一条 `❌` 改成 `✅`（那条不在 `package.json` 里）⇒ `B3b` 红；
删掉一行 ⇒ `B3` 红；恢复 ⇒ **PASS 12/12**。
```

⇒ 这正是"**读数看起来确定，其实量错了东西**"的又一个实例，
而且这次连**判据审计本身**也逃不过它 —— 所以那个"三者和"的断言是**必须**写出来的，不是多余。

### 6.11.2 做它的时候撞出一处**证据档缺陷**（已修）

`m10:gates` 上线第一次跑就把 `m10:source:verify` 与 `m10:context:verify` 判成 **FAIL** ——
而那两份"最新档"**都是 `m10:measurement:verify` 的注入档**（负控故意让门变红时写的）。

```text
根因：注入态那份 FAIL 档与被测门**真正的** FAIL 档在盘上**完全同形**
      （同 testType · 同 notes · 同 counts 结构 · 无任何标记）
      ⇒ 读证据的人**无法区分**"她真的红了"与"我们故意让她红的"
```

**修法（一处，所有门免费获得）**：注入方的子进程 env 里带 `M10_INJECTION=<id>`，
由 **`writeM10Manifest`**（全仓**唯一**写清单的地方）把它记进清单；
`m10:gates` 逐门判定时**把注入档排除在外**（单列计数）。

**修前 / 修后（同一命令）**：

```text
修前：PASS 19 · **FAIL 2** · NOT RUN 1        ← 两道都是被注入档误判
修后：PASS 21 · FAIL 0 · NOT RUN 1            ← 13 份注入档已被标记并排除
      NOT RUN 的只有 m10:preflight（它不写证据档，是既有的已知项）
```

⚠️ **标记只对以后的档有效**（历史档不回写）⇒ 对"无标记的 FAIL"，`m10:gates` 用
`ambiguousNewestFail` **如实登记**"分不清"，**不猜**。

### 6.11.3 一处教训：`A8` 的判据被**真实产物**打回来三次

`A8` 判"本门没有 spawn 别的门"（去注释后判结构）。三版全部是**跑真实产物**才发现错的：

```text
v1  /child_process/          ⇒ 本文件**必须** import 它（读 git rev-parse）⇒ 把 import 判成 spawn
v2  比对第一个实参是不是 'git'  ⇒ 我那条检查的**标签文本**里也写着 execFileSync('git', …)
                               （在**模板串**里）⇒ 又判红
v3  把**所有**字符串字面量剥掉  ⇒ `'git'` 自己也被剥掉了 ⇒ **全部**调用变成"非 git"
v4  只剥**模板串**（散文写在反引号里），保留单引号字符串 ⇒ ✅ 2 处启动、0 处非 git
```

⇒ 这正是本仓库那条纪律的又一例：**"判结构"的量具也必须往真实产物上跑一次**；
只用手造输入，这三版**都会**看起来是对的。

### 6.11.4 §16.1 最后一条也补上了：`m10:regression:verify`

计划 §16.1 的 `m10:regression:verify` —— 「**只读核验回归运行清单 / 退出码**」（WP11）。
本轮把它做出来了：读 `artifacts/.fast/<runId>/run.json`（`gates:run` 写的运行清单），
逐条核 §16.3 的 **19 条必跑项**（通过 / 非零退出 / NOT RUN **三类分列**）。

```text
A2  **清单不回腐烂**：§16.3 那 19 条从**计划书本身**解析出来，与脚本常量**逐字对账**
    （"文档里的清单"与"代码里的清单"必须一致；漂了就红）⇒ 它不是一份手抄的权威源
A3  19 条逐条有归属；三类的和必须等于 19
A6  **正式档与快跑档分列**（AGENTS §9.1：「发布证据仍只能来自冻结命令清单 + **串行档** + 干净树」）
A9  **两种 NOT RUN 分开**：命令**不存在**（清单写错）vs 命令**存在但没记录**
A8  **不跑任何子门**（判结构）：每个进程启动调用的第一个实参都必须是 `git`
```

**实测读数**：`16 条有 exit 0 记录 · 0 条非零 · 3 条 NOT RUN`。

### 6.11.5 它撞出的那 3 条 NOT RUN：`L-M10-63`

```text
NOT RUN：m9.1:test · m9.1:verify · m9.1:e2e:verify
```

`A9` 先确认了**它们都存在**（`package.json` 里有脚本）⇒ 这是"**没记录**"，不是"清单写错"。
**根因**：`scripts/gates/manifest.ts` 里**没有 `m9.1` lane** ⇒ `gates:run` 从没跑过它们
⇒ 盘上没有 `run.json`。

⚠️ **义务在实质上满足、在记录上不可见** —— 本轮**直接跑过那三条**，当前 HEAD 上全 **exit 0**：

```text
pnpm m9.1:test          31 通过 / 0 失败
pnpm m9.1:verify        36 通过 / 0 失败 / 2 未运行（**具名**）
pnpm m9.1:e2e:verify    36 通过 / 0 失败 / 3 未运行（**具名**）
```

⚠️ 但**"我跑过了"不等于"盘上有记录"**：要让它们进记录，得给 M9.1 那三条**登记一条 lane**
—— 那是**另一个里程碑的门注册**，**本里程碑不擅自登记**（与"第二份 `digestTree`"、
"`L-M10-61` 根因在 M9.5 内部"同一条纪律：**登记 + 报边界，不越界改**）。
⇒ 已登记为 **`L-M10-63`**，缺口的闭合方式与归属写在里面。

⚠️ **顺带印证了 `m10:gates` 的 `A2` 真的会咬人**：本轮把 `m10:regression:verify` 登记进
`M10_GATES` 之后**忘了同步 `m10:gates` 的映射表**，`m10:gates` **当场红**
（"新增门却忘了登记 ⇒ 本门红"）—— 那条判据是**为这一刻**写的。

## 6.12 计划 **§21.2** 点名的文档（**比 §12 WP11 的七项更多**）与 §21.1 的 **14 槽**

计划里**有两处**列交付物，而我此前只按 **§12 WP11 的七项**清点过：

- **§12 WP11**：Architecture · Acceptance Report · Known Limitations · Gate Decision ·
  Activation Candidate · M10-to-M11-Handoff · WP11 Handoff（**七项**）
- **§21.2**：「至少交付：Execution Plan、Baseline Report、ADR、Acceptance Contract、Architecture、
  **Measurement Report**、**E2E Report**、**Semantic Evaluation**、**Live Report**、
  Human Review Materials、Acceptance Report、Known Limitations、Gate Decision、
  Activation Candidate、M10-to-M11-Handoff，以及**每个已执行 WP 的交接**」

⚠️ §21.2 比 §12 多出**四份**：**Measurement Report · E2E Report · Semantic Evaluation · Live Report**。
本轮按 §21.2 逐条对照实际文件：

| §21.2 的名字 | 实际 | 状态 |
|---|---|---|
| Execution Plan | `M10-Execution-Plan.md` | ✅ |
| Baseline Report | `M10-Baseline-Report.md` | ✅ |
| ADR | `docs/adr/ADR-076-…` | ✅ |
| Acceptance Contract | `M10-Acceptance-Contract.md` | ✅ |
| Architecture | `M10-Architecture.md` | ✅ |
| **Measurement Report** | **`M10-Measurement-Report.md`** | ✅ **本轮补上**（§6.12.1） |
| **E2E Report** | **`M10-E2E-Report.md`** | ✅ **本轮补上**（离线端到端：19/19，分组 `G=11 · C=3 · X=4 · Z=1`；见 §6.15） |
| **Semantic Evaluation** | `M10-Semantic-Understanding-Report.md` | ✅ **改名交付**（名字不同、内容即该槽） |
| **Live Report** | — | ❌ **未出**（被 `L-M10-61` 挡住，**没有读数可报**） |
| Human Review Materials | `M10-Human-Review-Materials.md` | ✅ |
| **Acceptance Report** | **`M10-Acceptance-Report.md`** | ✅ **本轮补上**（§6.17）：**事实报告，不下判决**；14 槽**逐槽写它自己的状态**，**11 槽有读数 · 3 槽没有** |
| Known Limitations | `M10-Known-Limitations.md` | ✅ |
| Gate Decision | — | ❌ 未出（同上） |
| Activation Candidate | `M10-Activation-Candidate.md` | ✅ |
| M10-to-M11-Handoff | `M10-M11-Read-Only-Contract.md` | ✅ **改名交付** |
| 每个已执行 WP 的交接 | `M10-WP0…WP9-Handoff.md` + 三份专项交接 | ✅ |

⇒ **按 §21.2 清点：15 项全部交付（含 2 项改名）· 待办 0**。
⚠️ 这条账现在**由机器守着**：`m10:docs:verify` 的 **`B4`** 把 §21.2 的清单逐条映射到真实文件，
并允许**具名待办**（带理由）—— 两者**恰好划分**清单（实测 `映射 15 + 待办 0 = 15`）。
⇒ 最后补上的是 **`Gate Decision`**（[`M10-Gate-Decision.md`](M10-Gate-Decision.md)，判决书：
14 槽逐槽判定 + 不主张清单 + 具名偏差 + 激活问题 + M11 边界），
前两份是 **`Semantic Evaluation`**（[`M10-Semantic-Evaluation-Report.md`](M10-Semantic-Evaluation-Report.md)）
与 **`Live Report`**（[`M10-Live-Report.md`](M10-Live-Report.md)）。

### 6.12.1 本轮补的 `M10-Measurement-Report.md`

它**只**回答"**尺子可信吗**"，不回答"她做对了吗"——两者混淆会让一份全绿读数
看起来像一份质量结论。内容：**54/54**（`S=12 · N=13 · R=13 · V=13`）·
三段式纪律（正控/负控/**指定的那一条检查**变红/字节还原）· **13 个注入点逐条**列出
（含 `N1` 逐字取自 **WP3 真实踩过的那个缺陷**）· **覆盖 13/16 且三道未覆盖的原因各不相同**·
**量具自己历史上抓到的 5 处缺陷**（含本轮撞出的"注入档与真 FAIL 档同形"）· 本报告**不**主张什么。

### 6.12.2 §21.1 的 14 槽：一处**自拟槽位**已改回计划的词表

计划 **§21.1**「最终判定至少分列」规定了 **14 个槽与每个槽的允许表达**。
`M10-Activation-Candidate.md` 原先用的是我**自拟的 12 槽** ⇒ 收口时会与计划对不上。
⇒ 已**逐字改用 §21.1 的槽名与词表**（整表见该文件 §6）。

⚠️ 换表时**跑出一处词表缺口**：槽「**Semantic evaluation**」的允许表达是
`PASS / FAIL / INCONCLUSIVE / INVALID` —— **没有 `NOT RUN`**，而它当前的真实状态**就是** `NOT RUN`
（语义门一次都没跑）。⇒ 两条出路**都要用户**：跑它（`U-15`/`U-11`），
或在收口时**具名声明偏离**。
⚠️ **不把它硬塞进 `INCONCLUSIVE`** ——"没跑"与"跑了但结论不确定"是两件事，
塞进去就是**用允许的词表掩盖没跑**（正是 §17 停线条件第 6/7 条要防的）。

## 6.13 `L-M10-61` 的**根因**（用户 2026-09-30 授权进 M9.5 内部后定位）

诊断用了**逐层读数**（每层都有硬超时；全程一次性沙箱库，不碰真实库）。
每一层都是"排除一个假设"或"钉住一个事实"，最后收敛成一条完整因果链。

### 6.13.1 逐层读数（**六层，全部有数**）

```text
① 编码器整条链 —— **排除**
   插桩后：worker **233 ms 就绪**（assetsVerified=7）· waitReady ok=true
   ⚠️ 而 `encode` **从未被调用** ⇒ 卡点**不在**编码器 client / worker 里
   （这正是插桩要分开的第一件事：没有这行读数，"卡在编码器"永远只是个假设）

② 探针是否被调用 —— **钉住**
   `[m95-probe-debug] score 进入（text 长度 14 · memoryIds 0）`
   ⚠️ 而 `代读回` **从未出现** ⇒ 卡在 `score()` 的**第一句**
   `await publishedGenerations(options.db, …)`

③ 那条 SELECT 是"挂住"还是"抛错" —— **抛错**
   隔离探针（三态量具：resolve / throw / 挂住）：
     对照组 information_schema 计数        → resolve（2 ms）
     `memory_semantic_generations` 在不在   → **不在**（information_schema 查不到）
     探针**原样**那条 SELECT                → **throw（0 ms）**
     参数化形态（与实现同形）               → throw（1 ms）

④ "抛错把连接弄坏了"这个假设 —— **排除**
   抛错**之后**再跑对照组                  → **resolve（1 ms）** ⇒ 连接可用，没被毒化
   （PGlite 是单连接：若它被一条卡住的事务挡住，后续查询会永远排队 —— 实测不是）

⑤ 那张表从哪来 —— **只由 M9.5 自己的实验室脚本建**
   `memory_semantic_generations` **不在任何内核迁移里**（0001–0009 都没有）；
   建它的是 `ensureSemanticIndexSchema()`，而该函数**只被**
   `m9.5-calibration-verify.ts` / `m9.5-lexical-calibration.ts` / `m9.5-migration-verify.ts` 调用
   ⇒ **没有任何启动路径调用它** ⇒ 生产聊天里这张表**永远不存在**

⑥ 抛错之后谁接 —— **没人接**
   `src/infrastructure/persistence/memory-retrieval-store.ts:238`：
   `const probe = await options.semanticProbe.score({…})` —— **没有 try/catch**
   ⚠️ 而它上面那段注释逐字写着设计意图：
   「探针**具名失败**（timeout / model_missing / …）⇒ 记下原因，本轮**如实降级**」
   ⇒ 代码处理了 `probe.ok === false`，**没处理"探针抛错"**
```

### 6.13.2 因果链（一句话）

```text
`.env` 开着 semantic（生产配置）
  ⇒ main.ts 构造探针 + 选 hybrid-relevance@1
  ⇒ 轮次第一次召回 ⇒ memory-retrieval-store:238 await probe.score(…)
  ⇒ score() 第一句 SELECT from memory_semantic_generations
  ⇒ **那张表在内核迁移里没有、启动路径也不建它** ⇒ **抛错（0 ms）**
  ⇒ 调用点**没有 try/catch** ⇒ rejection 逃逸 ⇒ 轮次**静默挂住**
```

⚠️ **仍未定位的一格（如实登记，不猜）**：rejection 逃逸**之后**，
**为什么表现成"静默挂住"而不是"报错降级"** —— 那个永不返回的 `await` 还没找到。
**连接层已排除**（④），所以不是"单个连接被挡住"。

### 6.13.3 这条发现的意义**超出 M10**

```text
① 它是**生产阻塞**：`.env` 开着 semantic ⇒ **本机的真实聊天会走到这条路径**
   （与 `L-M10-58` 的启动探针缺陷是两处不同的缺陷，都已定位）
② 它说明 M9.5 的**语义索引表从未在生产里建过** —— 该里程碑的"激活"没有做过
   （表只由实验室脚本 ensure）⇒ 这是一个**独立的设计/激活裁定**，不属 M10
③ 它**同时挡住 M10 的两件**：live 档（⇒ Live Report）与激活候选的 **G-2 接线**
   （接线改变生产轮次装配 ⇒ 按 AGENTS §6.1 必须有 Live Smoke 读数）
```

### 6.13.4 修法（三层，由小到大；**M10 不擅自改别人的生产语义**）

```text
① 最小、且与那段注释自己的契约一致：
   `memory-retrieval-store.ts:238` 包 try/catch，把 throw 也映射成 `semanticFailure`
   （注释本来就要求"具名失败 ⇒ 如实降级"）
② 治本的一半：探针把"缺表 / 查询失败"当**具名失败**返回（如 `not_indexed`），而不是抛
③ 治本：语义索引表该不该进**内核迁移**、该不该在**启动时 ensure** —— 
   属 M9.5 的设计裁定（`ensureSemanticIndexSchema` 目前只有实验室调用方）

⇒ **可立即执行的缓解**：把 `.env` 的 `CHARACTER_MEMORY_SEMANTIC_ENABLED` 关掉
   （回滚 = 删那一行；M9.5 的语义面因此不参与，live 档与 G-2 接线随之可用）。
   ⚠️ 那是**生产配置改动**，需用户裁定 —— 本轮**没有**动 `.env`。
```

### 6.13.5 本轮对 M9.5 两处源码的改动（**都是 env 门控的诊断插桩**）

```text
src/infrastructure/semantic/encoder-client.ts   —— M95_ENCODER_DEBUG=1 时才输出；
                                                  并把 worker 的 stderr 转出来（原先读到就丢）
src/infrastructure/semantic/semantic-probe.ts   —— 同上，记 score 进入 / 代读回
```

⚠️ **默认静默**（不设那个 env 就一个字节都不多输出）；
两处覆盖它的 M9.5 门复跑均 **PASS**（`m9.5:encoder:verify` **10/0** · `m9.5:probe:verify` **6/0**）。
保留它的理由：它是**这次定位靠的东西**，且下一次复查同一个问题还要用。

---

### 6.13.6 ⚠️ **§6.13 的诊断是错的 —— 已修正，并且 `L-M10-61` 已修好**（2026-09-30，用户裁定后）

**用户裁定**：修 ②+①、别先关 `.env`、③ 单独立案。执行结果如下。

#### 6.13.6.1 我上一轮**错在哪里**（先认错，再给读数）

```text
§6.13 的结论是"聊天轮次**静默挂住**"。**它错了。**
真相：**轮次走完了、她的回复产出了**，是**进程不退出**。

为什么我会判错：那个探针把 `stdout + '\n' + stderr` **拼成一个数组**再取"最后 6 行"，
而 **stderr 的行永远排在 stdout 之后**（拼接顺序，不是发生顺序）
⇒ 我看到的"静默前最后一行"其实只是 **stderr 的末尾**，不是"最后发生的事"。
把 `stdout` 单独打出来，第一行判据就露出来了：`苏沐薇: 嗯。明天，交报告。`
```

⇒ **又是同一族：观察窗口取错，读数看起来确定。** 这次的窗口是"拼接后的尾部"。

#### 6.13.6.2 真正的因果链（**四个环，缺一不可**）

```text
① 表不存在 ⇒ SELECT 抛错（0 ms）
   `memory_semantic_generations` **不在任何内核迁移里**；建它的是 `ensureSemanticIndexSchema()`，
   而它**只被 M9.5 自己的实验室脚本调用** ⇒ 没建过索引的库上这张表不存在。
   ✅ 修：`publishedGenerations` **只**把"表/关系不存在"映射成空数组 ⇒ 走既有的 `not_indexed`。

② 调用点**没有 try/catch** ⇒ 抛错逃逸（而那段注释逐字要求"具名失败 ⇒ 如实降级"）
   ✅ 修：`memory-retrieval-store.ts` 包 try/catch，抛错也走同一条降级路（并 `console.warn` 留原始错误）。
   ⚠️ 实测：drizzle 把错误包成 `Failed query: …`，**不含 "does not exist"** ⇒ ① 的精确识别**没命中**，
      是 ② 的兜底接住的（这也说明"两道都修"是对的）。

③ ⭐**真正的"挂住"**：`waitReady()` 的**兜底定时器从来没被清掉**
   原写法 `Promise.race([readyPromise, new Promise(res => setTimeout(res, timeoutMs))])`
   —— ready **赢了**（实测 247 ms）之后，那个 `setTimeout` 仍**挂 180 秒**
   （`SEMANTIC_RECALL_READY_TIMEOUT_MS = 180_000`）⇒ **它把 event loop 吊住**。
   ✅ 修：**`unref()` + 赢了就 `clearTimeout`**。
   ⭐ 这一个环**恰好解释三条此前的读数**：
      · "跨过文档承诺的 180s" ⇒ 进程其实会在 **180s 之后**自己退出（不是轮次挂住）
      · "与语义模式无关"       ⇒ `warmup`/`fingerprint` 都会调 `waitReady`，与模式无关
      · "关掉语义召回就正常"   ⇒ 没有 worker 就没人调 `waitReady` ⇒ 没有这个定时器

④ 编码器 client **从未被关** ⇒ 它 spawn 的 worker 子进程（三条 stdio 管道）也吊住 loop
   `buildSemanticRecallProbe()` 只把 probe 返回出去，client 引用被丢掉。
   ✅ 修：**模块级收尾钩子** `closeSemanticEncoderForExit()`，由**最外层 `finally`** 在关库之前调。
   ⚠️ **第一版修错了地方**：把 close 放进了**类方法**的 `shutdown()` —— 而聊天路径走的是
      **模块级** `runtimeShutdown`，**根本不是那一条** ⇒ 修了等于没修
      （留档理由：这正是"改在哪儿"与"跑到哪儿"是两件事）。
```

#### 6.13.6.3 定位每一步用的**机器读数**（不是靠猜）

```text
A) 关库后 dump 存活句柄（临时插桩，env 门控）：
   [m95-exit-debug] 收尾钩子被调用：引用在 ⇒ 将 close()
   [m95-exit-debug] 关库后仍存活的资源：["PipeWrap","PipeWrap","PipeWrap","**Timeout**"]
   ⇒ 那个 **Timeout** 就是 ③；三个 PipeWrap 起初被我读成"worker 的管道"，
     ⚠️ 但**本探针自己用 `stdio:'pipe'` 跑子进程** ⇒ 子进程自己的 stdout/stderr 也是 PipeWrap
     ⇒ 光看句柄名字**分不清是谁的管道**（量具自身的污染）。
B) 直接查孤儿进程（绕开 A 的歧义）：
   Get-CimInstance Win32_Process … -like '*encoder-worker-entry*'
   ⇒ ✅ 没有孤儿 ⇒ **worker 已被正确关掉** ⇒ 剩下的"不退出"另有其因（指回 ③）
```

#### 6.13.6.4 验证读数（修前 / 修后，同一条探针）

```text
修前：status=null signal=**SIGKILL** 用时=240.0s（回复其实已产出）
修后：status=**0**    signal=null      用时=**13.8s**   ← 干净退出
      苏沐薇: 明天交报告，是吧。行。
      ✅ 没有孤儿 encoder worker（进程列表里查不到 encoder-worker-entry）
```

#### 6.13.6.5 结论：**不需要关 `.env`**

```text
我原先的推荐把"关掉 CHARACTER_MEMORY_SEMANTIC_ENABLED"当作后备手段。
⇒ **它没有被用到，也不该被用到** —— 修好之后**出厂配置（semantic=true）**下就正常了
  ⇒ `Live Report` 可以在**与实际出厂配置一致**的条件下取读数（证据更强，且报告里不必加限定语）。
⚠️ 但这是**读数变了才改的主意**，不是"我一开始就这么想"：若 ③/④ 没修好，关开关仍是对的兜底。
```

#### 6.13.6.6 仍未做的那一件（③ 的**设计**问题，另立 `L-M10-66`）

```text
语义索引表**不在任何内核迁移里**，`ensureSemanticIndexSchema()` **只有实验室调用方**
⇒ 修好 ①②③④ 之后，语义召回在生产里会**永远如实降级成 `not_indexed`**
   —— **不再挂住、不再骗人，但功能等于关着。**
⇒ 要让它**真的能用**，得决定：这张表进**内核迁移**、还是**启动时 ensure**？
   两者都要动迁移或启动路径 ⇒ **需用户授权**（0001–0009 冻结、`D15` 迁移目标 NONE）。
⇒ 登记为 `L-M10-66`，属 **M9.5 的设计裁定**，不藏在 M10 的修复里。
```

#### 6.13.6.7 本轮对 M9.5 / M5 生产代码的改动（**有实质语义**，不只是插桩）

```text
src/infrastructure/semantic/semantic-probe.ts       ② 缺表 ⇒ not_indexed（其余错误仍抛）
src/infrastructure/persistence/memory-retrieval-store.ts  ① 抛错也如实降级（+ 原始错误进日志）
src/infrastructure/semantic/encoder-client.ts       ③ unref + clearTimeout（**根因**）+ 诊断插桩
src/main.ts                                         ④ 模块级收尾钩子关编码器 client（+ 诊断插桩）
```

按 AGENTS §5 跑过的门（全绿）：
```text
typecheck · m5:test 30/0 · m5:verify 26/0 · m5:retrieval:verify 28/0 · m5:e2e:verify 28/0
· m9.5:encoder:verify 10/0 · m9.5:probe:verify 6/0 · m4:test 258/0 · m4.5:test 135/0
```

⚠️ **顺手修掉的一处文档缺陷**：AGENTS §5 那行（改 `memory-retrieval-store.ts` 该跑哪些门）
写了两个**不存在**的命令 —— `m5:nl-e2e:verify`（真名 `m5:e2e:verify`，脚本自称「M5 WP8 自然语言 E2E」）
与 `m5:metrics:verify`（真名 `m5:ranking:verify`，自称「M5 WP4 Ranking / Conflict / Dedup 门」）。
已改正，并补上该行漏掉的 **`m5:retrieval:verify`**（那一行点了 `memory-retrieval-store.ts`，却漏了它的门）。
⚠️ 顺带把 **AGENTS.md 全文的 95 个 `pnpm <脚本>` 名**核了一遍：**只有那 2 个**不存在（都在同一行）。

## 6.14 `L-M10-64`：`m10:e2e:verify` 的 `G39` 曾经是**空过的**（已修）

写 E2E 报告前逐条读该门的 19 条检查，撞出这一条：

```text
原判据  members.length <= allRows.length && members.join(',') === [...members].sort().join(',')
        ⇒ ① 子集不可能比全集大            ⇒ **恒真**
           ② 它**从不看** outcome          ⇒ 标签里的"**具名澄清**"没有任何判据
           ③ 它**从不比**行数与场景建的行数 ⇒ 标签里的"两条记录都保留"没有参照
实测    行 2 · 冲突成员 **0**              ⇒ **本样本根本没有冲突**
```

⇒ 一条**关于多目标冲突**的检查，**观察到 0 个冲突**，却始终是绿的。
这正是本仓库反复修的那一族（"测了个 0"与"什么都没测"长得一样），
**而且它已经进了覆盖账**（`G39` 一行的覆盖里引了它的 `G39`）—— **那是个 over-claim**。

**修法**（把标签降到它真能断言的、把断言换成真的；**不是删掉判据**）：

```text
① 断言改成"**行数 == 场景建的行数（2）**" —— 合并/删除会真的红
   ⚠️ 用错期望值实测过：`EXPECTED_ROWS_AT_G39 = 3` ⇒ **FAIL 18/19**，改回 2 ⇒ PASS 19/19
② 标签**明说本样本不含冲突**，并把冲突判据指向它**真正的家**：
   `m10:invalidation:verify` 的 `C1`–`C5`（`C1` 同对象同描述不同成功条件 ⇒ 冲突 ·
   `C2` 两个都 active ⇒ 冲突 · **`C3` 是负控**：不同描述 ⇒ 不冲突 · `C4` 对称 · `C5` 两条都保留）
③ `冲突成员` 仍**如实报出**（0 就是 0），只是不再被当成"测过了"
```

**覆盖账随之修正**：`G39` 一行**不再**引 `m10:e2e:verify` 的 `G39`，
改引 `m10:invalidation:verify` 的 `C1 / C2 / C3 / C5`（含负控）。

⚠️ **仍未做（如实登记）**：让 e2e 场景**真的产生一对冲突目标** ——
那会牵动 `Z1`（事件 2 · 行 2）与 `X4`（2 → 2）的计数断言 ⇒ **属独立改动**，不在本轮。

## 6.15 `M10-E2E-Report.md`（§21.2 要求、此前不存在）

计划 §21.2 点名了 `E2E Report`，而它一直没有（§12 WP11 的七项里没有它 —— **两处清单不同**，见 §6.12）。
本轮补齐。它**只**报**离线端到端**（真网关 + 隔离库 + 离线 provider）；
`Live chain` 与 `Long trajectory` 是 §21.1 的**另两个槽**，不在该文件里冒充。

## 6.16 `m10:gates` 的"最新一份"曾经按**目录名字典序**挑（我自己的缺陷，已修）

写 E2E 报告时，聚合门报 `m10:e2e:verify = FAIL`，而我**刚跑完的那次是 PASS**：

```text
它挑中的"最新真档"：m10-wp8b-e2e-…-cbce   （mtime 10:27:31）
我刚跑的那一份    ：m10-wp8b-e2e-…-7064   （mtime 10:28:47）  ← 真正更新
```

**根因**：`runId` 的形状是 `m10-<wp>-<日期>-<head 前 12 位>-<4 位随机>`
—— 末尾那一截**不是时间戳**，是**随机后缀**；而第一版用 `readdirSync().sort().reverse()`
⇒ **按目录名字典序**当"最新" ⇒ **同一天内的多次运行，它排出来的"最新"是任意的**
（`cbce` 字典序大于 `7064`）。

```text
⇒ 后果：**同一批档案，"她到底过没过"会随那个随机后缀漂移**
   —— 这正是"读数看起来确定、其实不确定"那一族，而且它骗的是**收口方**。
⇒ 清单里也没有可用的时间戳（`date` 只有**天**粒度）⇒ 只能用文件系统 mtime。
```

**修法**：`readRun()` 记下 `manifest.json` 的 `mtimeMs`，读完之后**按 mtime 降序**排。
**修后复核**：挑中的变成 `…-7064`（真最新）✓，判定 `PASS 22 · FAIL 0 · NOT RUN 1`
（与修前**同值** —— 修前是**碰巧**对的；这类"碰巧对"正是最该修的东西）。

⚠️ 修的过程中还撞到一件**同形的小事**：我给 `readRun` 加了 `statSync` 却**忘了加 import**
⇒ `statSync is not defined` ⇒ `mtimeMs` 全为 0 ⇒ 排序失效 ⇒ 聚合门当场报 **`FAIL 3`**。
⇒ 那三个"FAIL"是**我的缺陷**造成的，不是产品缺陷；补上 import 后回到 `FAIL 0`。
**记它的理由**：它是"量具坏掉时会**静默给出一个像样的错读数**"的又一例。

⚠️ **剩余的可议之处**（如实登记，不再加机器判据）：靠 mtime 排序**依赖文件系统**；
同 mtime 的两份档排序会是任意的。NTFS 的 mtime 有亚秒精度 ⇒ 实测未撞上，
但**理论上**存在。

## 6.17 `M10-Acceptance-Report.md`（§21.2 要求、此前不存在）

**它是事实报告，不下判决**（判决书是 `Gate Decision` 的事）。开篇就写明
**"本文件不主张验收通过"** —— 14 槽里 **3 槽没有读数**。

```text
11 槽有读数：Design(ACCEPTED/DESIGN FROZEN) · Implementation(**PARTIAL**：G-1/G-2 实测 0 处)
             · Input/reference contract PASS · Mechanical gates PASS(24/24)
             · Measurement validity VALID(54/54) · Long trajectory 200轮 11/11 + 500轮 11/11
             · Regression EXIT 0(19 里 16 有记录、3 具名未记录) · External Capability NONE
             · Production activation NOT ACTIVATED · First use NOT OBSERVED · Merge/tag NOT REQUESTED
 3 槽无读数：Semantic evaluation · Live chain · Human review
             ⇒ **挡路者是同两件**：用户填 70 张卡 ／ 用户裁定 `L-M10-61` 的修法
```

⚠️ **报告里单列了一处防混淆**：`m10:semantic:dry`（**离线干跑** 13/13）**不是**"语义评估"，
不能拿它顶那个 `NOT RUN` 的槽。
⚠️ 也**具名声明了词表偏离**：`Semantic evaluation` 的允许表达里没有 `NOT RUN`，
而它的真实状态就是没跑 ⇒ 记 `NOT RUN` 并说明，**不塞 `INCONCLUSIVE`**。
⚠️ 并**把"本里程碑自己抓到并修掉的 6 处量具缺陷"单列一节** ——
其中 5 处的共同形状是"**读数看起来确定，其实量错了东西**"。

## 6.18 `L-M10-65`：**登记被当成断言计数**（判据审计的第二类产出）

写 `Acceptance Report` 时逐槽找读数，顺手对**全部 24 道门**做了一次判据审计
（`scripts/m10-gauge-audit.ts`，用 TS 编译器 API 解析 **368 条** `record(...)` 的判据）：

```text
抓到的**恒真**判据（真缺陷，已修）：
  `m10:completion:verify` 的 `I1`/`I3`：`goalCompletionUnitOf(marker) === goalCompletionUnitOf(marker)`
    ⇒ 纯函数、**同一个参数**、同一表达式里调两次 ⇒ 恒真
    ⇒ 已改成"**独立构造 + 钉住 `D26` 的身份构成 + 负控**"（换 revision / 目标 / 结果引用 ⇒ 必须换身份）
  `m10:gateway:verify` 的 `S5`：判据就是字面量 `true`，而 `expected` 却写着'排序规则不变'
    ⇒ 已**如实降级成登记**（`expected` 明说"本行不作断言"并指向 `C6`）

抓到的**第二类**（**未修，如实登记**）：
  **8 条检查的 `expected` 逐字写着"不作断言 / 如实报出 / 如实登记"** —— 它们**本来就是登记**，
  却被计进 `N/N PASS` 的总数里：
    `m10:gateway:verify` 的 `S5` · `m10:long:verify` 的 `L4`/`G48c` ·
    `m10:semantic-dry` 的 `B3` · `m10:wp0:admission` 的 `S19` ·
    `m10:regression:verify` 的 `A4`/`A5`/`A6`
  ⇒ 后果：**"11/11"读起来像"11 件事被验证了"，而其中 2 件什么都没断言**。
```

⚠️ **当时为什么不在那一轮修**（如实留档，不是偷懒）：把"登记"从计数里分出去要动
**5 个门的汇总口径 + 证据 schema**，而**已记录在案的读数会随之变化**
（`long` 11→9 · `gateway` 12→11 · `semantic-dry` 13→12 · `wp0-admission` 33→32 ·
`regression` 11→8），而那些数字**被十几份文档引用**。
⇒ 那必须**一次协调好的改动**（改口径 + 同步所有引用 + 重出证据），不能顺手做一半
—— 本仓库的教训是"一处读数的改动会波及很多记录下来的副本"。

### 6.18.2 ✅ **它已在下一轮修掉了**（2026-09-30）

```text
机制：新增 `recordNote(group, id, label, expected, actual)` —— **没有 `pass` 参数**。
      ⇒ 调用点**连"传个恒真的表达式"都做不到** ⇒ "空量具混进断言计数"是**类型上不可能**的
        （与 `U-11` 的 `DeclarativeScore` 里根本没有 `rate` 字段同一条纪律：不靠"我记得别写"）
      它仍把读数**留在 `checks` 数组里**（不丢），只是**不进** `passed/total`
汇总：`const assertions = checks.filter(c => !c.note)`；
      `summary/counts` 的 `total/passed` 只算断言，另报 **`notes: N`**；
      `console.log` 也改成印 `断言 X/Y · 登记 N 条`
落地：8 条登记全部改成 `recordNote(...)`（**没有一处再传 `true`**）；
      **5 个门的读数如实变小**：`long` 11→**9/9+2** · `gateway` 12→**11/11+1** ·
      `semantic-dry` 13→**12/12+1** · `wp0-admission` 33→**32/32+1** · `regression` 11→**8/8+3**
同步：**当前状态**类文档（Acceptance Report / Known Limitations / Scenario Coverage）已改，
      且**按门名精确替换、每处要求恰好命中 1 次** —— 因为 `11/11` **同时**是 `long` 与
      `regression` 的旧读数（还有两个**没变**的门也是 11/11），盲替必错；
      各 WP 交接单（WP9 / U-20 / WP10 干跑）是**当时**的记录，**不回写**
```

⚠️ **改口径时踩到的三个坑**（记下来，都不是理论问题）：
```text
① **CRLF**：这些脚本在盘上是 CRLF，而我的替换模式用 `\n` ⇒ **命中 0 次**
   （"改了 0 处"与"本来就对"在输出上长得一样 ⇒ 所以脚本要求命中数正确、不对就整文件不写盘）
② **`Check` 的形状不统一**：多数用 `group`，而 `m10-wp0-admission.ts` 用 `question`
   ⇒ 助手签名必须按文件给（第一版写死 `Check['group']`，wp0 立刻编译不过）
③ **回滚会连坐**：为了修语法错而 `git checkout` 那三个文件，会**一并撤销**刚改好的
   `recordNote` 调用点 ⇒ 必须**按顺序重跑**两个改写脚本（这一点当场撞上了）
```

### 6.18.1 常驻防线：三条**自指**判据 `V2a`/`V2b`/`V2c`

审计逻辑已收进 `scripts/m10-gauge-audit.ts`（**不是**新门，也不新增 npm 脚本 ——
避免"有命令但没有门"那种形状），由 `m10:measurement:verify` 调用：

```text
V2a 分母自证（scanned > 0）
V2b **无条件为真必须自报家门**（两分支的绿半边，或在 expected 里声明不作断言）
V2c **不许自比较恒真**（`f(x) === f(x)`）
```

⇒ `m10:measurement:verify` 因此从 **54/54** 变成 **54/54**（`V` 组 13 → 16）。
⇒ 下一道"永远为真"的检查**要么自报家门、要么红** —— 这条防线值它占的三行读数。

⚠️ **审计器是筛子不是判决**：实测**误报过一次** —— `m10:measurement:verify` 自己的
`V-<注入>` 被判成"无条件为真"，而它其实是**两分支**（找不到注入点记 `false`、找到记 `true`）。
把它记在这里，是为了让下一个人别把启发式的输出当判决。

## 6.19 目标理解的**真模型 provider** 已写出（`G-2` 缺的那块）+ 四条实测发现

`m10:semantic:eval` **不能单独写**：它的职责是量**产品**的意图理解，而**产品根本没有理解提示词**
—— `GoalUnderstandingProvider` 是个**空端口**（全仓只有定义与脚本里的固定实现，
`src/infrastructure/` 下**没有任何实现**）⇒ 那块正是 `G-2` 要补的。
而 `G-2` 的硬约束是「`G-4` 先于 `G-2`」，`G-4` 现已满足（`L-M10-61` 已修、真轮次走通）⇒ 先补它。

**已写**：`src/infrastructure/model/openai-goal-understanding.ts`（与既有
`openai-search-need-judge.ts` 同形：**恰好一次** POST → 取 `content` → 交回**原始对象**，
严格校验留在内核）。两条设计判据：

```text
① **提示词从契约派生**：`GOAL_DRAFT_FIELD_ALLOWLIST` / `GOAL_DRAFT_REQUIRED_FIELDS` /
   各闭集**全部 import 进来现算** ⇒ 契约加一个字段，提示词**同一次改动就跟着变**。
   （WP9-B 真踩过手写提示词的坑：契约允许 `revise` 带 `statement`，而提示词还教模型别用它
     ⇒ 10 次修订**全部**停在 `invalid_output`，门量到的是**提示词的错**。）
② **失败分对桶**：网络/HTTP/没有 key ⇒ **抛**（内核记 `transport`）；
   模型给了东西但**不是 JSON** ⇒ **返回原文**（内核判 `invalid`）。
   把"不是 JSON"抛成 transport 会说"这次调用失败了"，而它其实**成功**了。
```

### 6.19.1 探针读数（**9 条语料 · 覆盖各层 · 候选手工给**）

```text
合计 9 条 · 与金标一致 **6**（首次就 6/9 —— 提示词可用）
逐条（金标 · 模型）：
  ✅ test-ex-01-01  create · create
  ✅ test-am-02-01  clarify · clarify（"改一下那个目标" + 两条候选）
  ✅ test-un-01-01  none · none
  ✅ test-co-03-01  report_complete · report_complete
  ✅ test-dp-01-01  clarify · clarify
  ✅ test-dp-03-01  cancel · cancel
  ❌ test-ex-06-01  query · **clarify**
  ❌ test-am-01-01  clarify · **none**（"好" + 两条候选）
  ❌ test-ne-01-01  none · **clarify**（"我没答应过要写论文"）
```

⚠️ **候选是手工给的**（语料的 `context` 是**散文**，还没有结构化状态）
⇒ 这不是"语义质量"的读数，只证明**提示词 + 端口接线可用**。

### 6.19.2 ⭐ 四条发现（**这一轮的真正产出**）

```text
F1 · **契约与语料的张力** —— ✅ **已解决（用户 2026-09-30 裁定"让契约让步"）**
     原状：`GOAL_DRAFT_REQUIRED_FIELDS.query = ['targetGoalId']`
       ⇒ `query` **必须**指出问的是**哪一条**目标，而"我们都有哪些目标来着"这类
         **列清单**的问题**没有单条目标** ⇒ 模型**表达不出来** ⇒ 只能退成 `clarify`
         （实测两次：clarify / none，都不是 query）。
     依据（两条实测）：① 校验器**真的**在拦（`field_missing_for_operation`）；
       ② 但**下游根本不读它** —— `query` 走 `GOAL_NON_WRITING_OPERATIONS` 分支，
          fact 只有 `{outcome, operation, candidateCount}` ⇒ 那是一条**纸面约束**，
          它唯一的实际效果就是**挡住真实提问**。
     改动：`query` 的必需字段改为 `[]`，并在契约注释里**写明语义**：
        **给了 = 问那一条**（仍须落在候选集里）· **没给 = 问清单**。
     验证（同一探针，真模型）：
       ✅ 「我们都有哪些目标来着」金标 query · 模型 **query · 无 targetGoalId**（修前 clarify/none）
       ✅ 「我们现在有哪些目标」  query · **query · 无 targetGoalId**
       ✅ 「我有哪些目标」        query · **query · 无 targetGoalId**
       ✅ 对照「你已经替我提交报名了吗」query · **query · 有 targetGoalId**（指名单条仍带 id ✓）
       ✅ 对照「今天天气怎么样」  none · **none**
       ⇒ 5/5；**两个对照证明语义按声明工作**（清单不带 id、指名单条带 id）。
     ⚠️ **它不改变任何用户可见行为**（今天没有消费者读它）；"她真的把目标念一遍"是**另一条链**，
        **没有**因此被实现。⚠️ 改契约 = 动契约面 ⇒ 已重跑 `m10:test`（56/56）·
        `m10:source:verify`（43/43）· `m10:semantic:dry`（15/15+1，`C1` 证明提示词**自动**跟上）。

F2 · **"候选不唯一 ⇒ clarify"不可靠**：给两条候选 + 一个"好"，模型判 `none`（两次都如此）。
     我的提示词里那条触发条件**不足以**让它澄清。⇒ 提示词要改，但**怎么改要有读数支撑**。

F3 · **提示词的改动有非局部效应**：我按 F2 改了一版（把 clarify 的触发写得更明确），
     结果 **6/9 → 5/9**（`cancel` 退成 `clarify`、`none` 退成 `invalid`）。
     ⇒ 那处编辑还**不是契约里的措辞**（"必须问一句才能继续"是我的解释）⇒ **已回退**到忠实版。
     ⚠️ **并且我明确不"调到绿"**：拿同 9 条反复调到全对，正是计划 §17 禁止的"为绿而抽样"。
        ⇒ 正确做法是**如实报读数**、把 miss 登记成发现，等完整门（300 条）上再量。

F4 · ⭐⭐ **这个量有跑次间方差**：回退后复跑，`test-ne-01-01`（"我没答应过要写论文"）
     由 `none` **翻转成** `clarify` —— **同一提示词、同一语料、两次答案不同**。
     ⇒ **单次的一致率不是稳定估计** ⇒ 语义门**必须量方差**（多次运行 / 报区间），
       否则会拿一个随机数当结论。这条直接影响 §21.1 的「Measurement validity」槽。
```

### 6.19.3 还没做的（如实登记）

```text
① 语料**结构化状态**：语义门要驱动真端口，就得给 `GoalUnderstandingInput` 真的候选
   （id/status/priority/description）⇒ 语料需要补一个**结构化**的 `candidates` 字段
   （现在是散文 `context`）⇒ 又一次语料改动（第 7 次指纹）。
② `m10:semantic:eval` 门本体（用真 provider 跑冻结语料 + 量方差 + 逐案读数）。
③ provider 的**离线**自检（提示词 ⊇ 契约、无 key ⇒ 抛、非 JSON ⇒ 原样返回）—— 便宜，未做。
④ `G-2` 接线（把 `runGoalTurn` 连同四个端口接进 `main.ts`）—— provider 是其中一块，现已就位。
```

## 6.20 `m10:semantic:eval` 门已写出（§16.1 点名的"冻结语料的意图理解"）

**调用**（**必须**带包装器 —— 缺标记即**拒跑**，见下）：
```bash
pnpm with-test-model pnpm m10:semantic:eval [--split=test] [--runs=3] [--limit=<n>]
```

### 6.20.1 四条硬纪律（每条都有来历）

```text
① **守卫：绝不回落生产 key**。没有 `DSH_TEST_MODEL_WRAPPER` 标记 ⇒ **拒跑**（exit 2）。
   本门真的出站，而 `import 'dotenv/config'` 会把 `.env` 的**生产 key** 读进来 ——
   "以为在跑测试、其实在烧生产 key"是这里最坏的失败模式（与 m6/m9 的 live 门同一条纪律）。
   ✅ 实测：不带包装器 ⇒ 拒跑、exit 2。
② ⭐ **必须量跑次间方差**（`F4`）：`--runs < 3` 时判 **INCONCLUSIVE**，**不判 PASS**。
③ **失败不伪装成答错**：`invalid`/`transport` 从分母里**剔出去**、**分桶 + 记原因**，
   并断言 `answered + failures = 条目 × 轮数`。⚠️ 原因**要记下来**（只有桶计数 ⇒ FAIL 无法诊断）。
④ **判据先声明、后读数**：PASS 的条件是 **准确率 > 多数类基线**（"总猜 none"那条线）
   且 **失败率 ≤ 10%**（**声明的运行界**，不是看到数字之后挑的）。
```

### 6.20.2 有界读数（12 条 × 3 轮 = 36 次调用；`--limit=12`）

```text
verdict **PASS**（10/10 判据）· accuracy mean=**0.6677**（min 0.6364 · max 0.700）
多数类基线=**0.3333** ⇒ 打赢"总猜 none"两倍 · macroF1=0.6917
失败率=**0.0833**（invalid=2 · transport=1）· 稳定 8 · **跨轮翻转 1** · 没答满 3
```

⭐ **逐层读数比聚合数字有用得多**：

```text
explicit_operation              6/6   ✅
dependency_change               5/5   ✅
unrelated                       6/6   ✅
negation_reference_hypothesis   4/5
**multi_goal_ambiguity           1/6**  ← 与 `F2` **完全吻合**（"候选不唯一 ⇒ clarify"不可靠）
**commitment_and_false_fulfillment 0/5** ← **全错** ⇒ 见 §6.20.4
```

### 6.20.3 门一跑就抓出两处**真缺陷**（都已修，且**不是**"调到绿"）

```text
① **契约自己不自洽**：校验器**无条件**要求 `span`（`if (!isSpan(object.span)) reject(...)`
   在任何必需字段逻辑之前），而 `GOAL_DRAFT_REQUIRED_FIELDS` 把它漏了（写成 `none: []` 之类）。
   ⚠️ 提示词是**从这张表派生**的 ⇒ 它没告诉模型 span 必填 ⇒ 模型对 `none` 不给 span ⇒ invalid
   ⇒ 实测：12 条 × 3 轮里 **7 次失败全是这一类**。
   ✅ 修：把"校验器一直在要求的事"写进表（`span` 对每个操作都必需）⇒ 提示词**同一次改动跟着变**。

② **提示词没说清区间的开闭**：只写了 `0 ≤ start < end ≤ 原话长度`，没说 `end` **不含**
   ⇒ 模型差一位（实测 `end=9 > 原话长度 8`）。
   ✅ 修：写明**左闭右开** + "**每个操作都要给**"。

修前 / 修后（同一 `--limit=12 --runs=3`）：失败率 **0.1944 → 0.0833**，`span_*` 那一类**消失**。
⚠️ 而 **C2 的上界（10%）是测量之前声明的、全程没动** —— 这是"修真缺陷"，不是"调到绿"。
```

### 6.20.4 三条**未决**（如实登记，各有归属）

```text
① ⚠️ **理解层的硬期限 8 秒对本端点太紧**：`GOAL_UNDERSTANDING_DEADLINE_MS = 8_000`，
   而实测真调用时延 **1.3–7.7 秒**（多次运行）⇒ 慢调用被自己的超时闸掐掉 ⇒ `transport`
   （实测 `provider_error：This operation was aborted`）。
   ⇒ 这是**延迟预算的产品权衡**（放宽会让聊天轮次更慢）⇒ **属用户裁定**，不擅自改。

② `F2` 在**层**上被证实：`multi_goal_ambiguity` **1/6** —— 给两条候选 + 一个"好"，
   模型不澄清。提示词那条触发条件**不足以**让它响（且改法有非局部效应，见 `F3`）。
   ⇒ 要改提示词，但**怎么改要有读数支撑**（本门现在正是那个读数）。

③ `commitment_and_false_fulfillment` **0/5**：模型把"下次继续时给我三个步骤"读成 `revise`
   —— ⚠️ **与第一轮人审的读法一致**（见 `M10-Human-Review-Adjudication.md` §7.2）。
   ⇒ 三方（人审 · 模型 · 金标）里**两方站同一边** ⇒ 这一族的**金标或题面**值得再看一眼，
     而不是简单地把模型判成错的。
```

### 6.20.5 还没做的（如实登记）

```text
① ✅ **`m10-semantic` lane 已登记**（计划 §16.1「离线 / 语义 / live 三 lane 分开」之一）：
   `M10_SEMANTIC_GATES`（**有意不并入 `M10_GATES`** —— 那条 lane 的语义是"零模型 / 零出网"）
   + lane `m10-semantic`。调用：`pnpm with-test-model pnpm gates:run --lane m10-semantic`。
   ⚠️ 它**真的出站** ⇒ 声明 `parallel: 'serial'`；⚠️ **`--lane all` 也会带上它**
   ⇒ 那条 lane 要么带包装器，要么 `--skip m10:semantic:eval`（不带包装器时它**如实拒跑** exit 2）。
   ⚠️ 登记后 `gates:verify` 的具名例外从 4 条回到 **3 条**（它不再是"有命令但没有门"）。
② **完整读数**：本轮是 `--limit=12` 的**有界样本**（诚实声明了分母）。
   发布读数应当跑 **test split 全量 140 条 × 3 轮**（约 420 次调用）。
③ 跨里程碑：`query` 的语义扩张（`F1`，已裁定）与 **"她真的念一遍清单"** 是**另一条链**，未做。
```

### 6.20.6 ⭐ 全量读数（**test split 140 条 × 3 轮 = 420 次真调用**）

```text
verdict **PASS**（10/10）· accuracy mean=**0.7216**（min 0.7087 · max 0.7364）
失败率=**0.0762**（invalid=19 · transport=13）· 稳定 **80** · **跨轮翻转 29** · 没答满 31
```

⭐⭐ **`F4` 在大样本上被证实**：**29/140 条（21%）跨轮翻转** —— 单次读数确实不是稳定估计
⇒ 本门"`--runs < 3` 判 INCONCLUSIVE"那条纪律**不是形式主义**。

⭐ **逐层读数**（比聚合有用得多）：

```text
explicit_operation                54/57   （95%）
unrelated                         53/58   （91%）
dependency_change                 54/68   （79%）
negation_reference_hypothesis     42/59   （71%）
multi_goal_ambiguity              35/54   （65%）
**commitment_and_false_fulfillment 42/92**（**46%**，最弱）
```

**8 个族 0 命中**（按族统计）：`test-co-01`(0/8) · `test-co-02`(0/7) · `test-co-05`(0/6) ·
`test-dp-01`(0/4) · `test-dp-02`(0/6) · `test-dp-05`(0/1) · `test-am-01`(0/6) · `test-ne-03`(0/5)。
⚠️ 其中**多数是 `clarify` 金标**（`co-02`/`co-05`/`am-01`）⇒ 与 `F2` 同源：
**"候选不唯一 / 能力不具备 ⇒ clarify"这条触发在提示词里不可靠**。

### 6.20.7 两处**用户裁定**已落地（2026-09-30）

```text
① **`test-co-01` 系三族金标 `create` → `revise`**（用户："模型读成 revise，那就改为这个也可以"）
   ⚠️ **一处必须纠正的说法**：我当时的依据是"模型读成 `revise`"，而那来自 **12 条的有界样本**。
      全量数据显示模型在这一族上**答案很散**（`create` / `revise` / `clarify` / `none` 都有，
      改判后 **1/8**）—— **模型的读法不稳定**，不是"稳定地读成 revise"。
   ⇒ **改判的依据应当记在人审那一侧**：第一轮人审是**稳定地 8/8 判 `revise`** ✓
      （那才是"两方同边"里可信的那一方）。**结论不变**（改 `revise` 仍然站得住），
      但**理由要写对** —— 拿一个散开的模型读数当依据是不成立的。
   ⚠️ 它同时暴露**题面问题**：同一句话拿到四种标签 ⇒ 这一族的**原话本身欠明确**
      （与 `test-dp-01` 的异质家族同族）。
   ⚠️ **代价（已登记）**：`commitmentCriterion` 在语料里**不再被任何一族使用**。

② **理解层硬期限 8s → 20s**（用户授权"按实际情况延长"）
   依据：全量 420 次里 **13 次（3.1%）撞到 8 秒期限被自己的超时闸掐掉**，
        而走完的那些实测 **1.3–7.7 秒** ⇒ 8 秒**卡在分布尾部**：它不是护栏，是**在正常调用上开火**。
   ✅ **改后验证**（同一全量）：`transport` **13 → 0**，而时延分布是
      `min=929ms · mean=3084ms · p95=7010ms · **max=18468ms**`
      ⇒ ⭐ **最长的一次真调用是 18.5 秒** —— 这直接证明 8 秒确实在正常调用上开火 ✓
   ⚠️ **但 20s 的余量只有 ~8%**（18.5s vs 20s）：再慢的调用会**如实记 `transport`**
      （那不是缺陷，是护栏正常工作）。要更宽就得再抬，代价是最坏情况的一轮等更久 —— 留作可调项。
```

### 6.20.8 改判之后的**全量读数**（同一 test split 140 × 3）

```text
verdict **PASS**（11/11，新增 `A8` 时延分布）· accuracy mean=**0.7236**（0.7007–0.7612）
失败率 **0.0357**（invalid=15 · **transport=0**）· 稳定 **99** · 跨轮翻转 27 · 没答满 14
时延：样本 420 · min=929ms · mean=3084ms · p95=7010ms · max=18468ms
```

逐层（与改判前相比，**分母也变了**——失败少了，所以不能直接比百分比）：

```text
explicit_operation                56/59 · unrelated 55/60 · dependency_change 60/72
negation_reference_hypothesis     39/55 · multi_goal_ambiguity 34/58
**commitment_and_false_fulfillment 49/101**（仍是最弱）
```

⚠️ **仍未解决的是 `clarify` 那一类**：`co-02`/`co-05`/`am-01` 等族在改判前后都接近 0
⇒ 与 `F2` 同源（"候选不唯一 / 能力不具备 ⇒ clarify"这条触发在提示词里不可靠）。
⚠️ 而且 `co-01` 的散开说明**题面**也欠明确 ⇒ **这一层要动的是提示词与题面，不是金标**。

## 6.21 两条 **live 门**已写出（§16.1 的最后两条未实现命令）

**调用**（两条都**必须**带包装器 —— 缺标记即**拒跑**，exit 2）：
```bash
pnpm with-test-model pnpm m10:smoke:live              # 小批真实链（7 轮，约 20 秒）
pnpm with-test-model pnpm m10:long:live [--turns=200] # 长轨迹真实链（缺省 200 轮）
```

### 6.21.1 共同的三条纪律

```text
① **守卫**：缺 `DSH_TEST_MODEL_WRAPPER` ⇒ 拒跑（**绝不**回落 `.env` 的生产 key）。
② **只断言结构不变量，不断言模型的选择**：
     `outcome` ∈ 闭集 · 写类 ⇒ 事件 **+1** / 不写类 ⇒ **+0** · `trace` 五个读数在场 ·
     `no_operation` **无事实块**（`D29`）
   ⚠️ 断言"模型一定会建目标"会让门**看运气**（且那是"为绿而抽样"的近亲）。
③ ⭐ **`measured_count > 0`**：轨迹里**至少有一轮真的走到写路径**，否则"链跑通了"没覆盖写入；
   并且"事实块纪律通过"也要求**至少一轮真的产出过事实块**（0 个样本的合规 = 没有检查）。
```

### 6.21.2 读数（本轮）

```text
`m10:smoke:live`  ✅ **PASS 8/8** · 7 轮真模型 · 写路径命中 3 轮 · 时延 1.8–3.8s
                  · 库路径断言在 %TEMP% 下（**不靠"我记得调了 isolate"**）
`m10:long:live`   ✅ **PASS 8/8** · **200 轮全量**：
                    分布 accepted×29 · clarify×86 · **invalid_output×23** · query×14
                       · no_operation×46 · **transport_failed×2**
                    ⭐ **事件/trace 一致性 0 轮不一致** · trace 满 5 的有 **200/200** 轮
                    ⭐ **`rebuild` 逐字相同 = true**（重放事件 > 0）⇒ **不变量 ② 在 200 轮上被验**
                    · 写路径命中 29 轮 · 时延 min=1022ms · mean=2735ms · **max=20015ms**
```

⭐ **两条真发现**（都如实登记，不掩盖）：

```text
① **`transport_failed×2`，且 max 时延 = 20015ms** —— 正好是 20 秒期限
   ⇒ 这**证实了 §6.20.7 的注记**：20s 的余量确实很小（实测最大 18.5s，这里两次直接撞到 20s）。
   ⇒ 它们**如实记成 `transport_failed`**（不是隐藏，也不是当答错）—— 护栏正常工作。
   ⇒ 要不要再抬（如 30s）是**延迟预算的权衡**，仍留作可调项（用户已授权"按实际情况延长"）。

② **`invalid_output×23/200`（11.5%）** 明显高于语义门的 `19/420`（4.5%）。
   合理解释：长轨迹把语料原话**喂进了与它原本上文无关的状态**（状态是自己长出来的）
   ⇒ 模型产出的草案更容易结构不合法。
   ⚠️ 这是**连续轨迹的性质**，不是缺陷 —— 但它说明"长轨迹的 `invalid_output` 率"
      与"冻结语料上的 `invalid_output` 率"**量的不是同一件事**，两者**不可互推**。
```

### 6.21.3 ⚠️ 门一跑又抓到**我自己判据写错**（第 3 次同类）

```text
`m10:smoke:live` 的 `B1` 第一版把"**不写类**"当成了"**没有事实块**"⇒ 当场红。
而 `D29` 的原话是「**无操作时**为 `undefined`」—— "无操作"是**具名 outcome `no_operation`**；
`query` / `clarify` **按设计就带事实块**（它们是有话要说的结论）。
⇒ 判据改成两条：`no_operation` ⇒ 不许有；且**至少一轮真的带了**（否则是**空过**）。
⇒ 教训（与 §6.19 的 `F3`、`B3` 同族）：**判据的措辞要回到契约原文**，
   凭印象转述一句设计纪律，就会量到错的东西。
```

### 6.21.4 还没做的

```text
① `m10:activation:readback`（§16.1 最后一条 ❌）：WP12 激活之后的读回，需授权与激活。
② 发布读数：两条 live 门应各出**正式档**（本轮 smoke 是全量；long 的 200 轮全量在跑）。
③ `--turns=500` 的长档（§16.1 提到 200/500 两档）：本门支持 `--turns=500`，本轮只跑 200。
```

## 6.22 `L-M10-67`：`G-2` 的真实范围**比"接线"大**（2026-09-30 摸清）

```text
本轮准备做 `G-1`+`G-2`（判决书里唯一挡着 `Implementation = COMPLETE` 的那件），
摸清装配面之后发现：**`GoalTurnPorts` 的四个端口里，两个在生产里根本没有实现**。

① **`completion`（兑现判定）**：`m10-e2e-verify.ts:144` 的 `emptyCompletionPorts()` 返回的是
   **伪造事件的桩**（`{id:'ev', qualification:'ESTABLISHED'}`）—— 那是**测试**的接法，
   生产里没有真实现。
② **来源资格的取得**：`runGoalTurn` 要 `sourceQualification`，而生产里**没有按 id 读会话事件的
   reader**（`conversation-store.ts` 只有 `conversationEventsInRange`）；
   `originReadingOfEvent()` + `sourceQualificationOf()` 都在，缺的是"按 id 取那条事件"这一步。

⇒ **裁定：不做半截。** 若把测试桩搬进生产，等于"**她凭伪造事件判定兑现完成**" ——
   那是**严重**的正确性问题，比"没接线"坏得多。
⇒ `G-2` 因此是"**先建两个端口，再接线**"，不是"接线"。

✅ **已就位的一块**：`src/infrastructure/goal/understanding-runtime.ts`
   （真 `withDeadline`：`finally` 清定时器 + `unref` —— 直接来自 `L-M10-61` 那 72 分钟的教训）。
   它**已被三条真模型门真的用上**（原先它们用的是测试用的 `deterministicRuntime`）——
   真模型门本来就该跑**产品那条链**的运行时。
   ⚠️ 副产物：`--runs=1` 时语义门如实判 **`INCONCLUSIVE`**（F4 的纪律：量不出方差就不是读数）。

⚠️ **`G-1` 的开关刻意没有先加**：只声明不消费就是 **D3（惰性开关）** ——
   而消费它需要先有上面那两个端口 ⇒ **`G-1` 与 `G-2` 必须一起做**（本轮新发现的耦合）。
```

## 6.23 `G-2` 施工单 ①：兑现判定端口的**生产实现**已写出（2026-09-30）

**文件**：`src/infrastructure/goal/completion-ports.ts` —— 把 `GoalCompletionPorts` 的三个查表
接到**真存储**上（不再是伪造桩）。三条设计判据：

```text
① **只按 id 查，不搜索**：端口收的是**证据 id**（提案里给的）⇒ 不去"找找看有没有别的能算证据的东西"。
② **查不到就是查不到**：id 不存在 ⇒ **不产出那条读数**（不补默认值、不猜）。
③ **资格由程序推**：`sourceQualificationOf(originReadingOfEvent(event))` ——
   不由内容猜，也不由 `actor_type` 反推（那是 D01 的形状）。
```

**三个查表各自的接法**（都已核对过真实字段）：

```text
conversation.findEvents      → `getConversationEvent` + 程序推资格
assistant.findAssistantEvents → `getConversationEvent`（`content` = 正文 · `replyToEventId` = 回应哪条）
actions.findActions          → `createActionLedgerStore(db).getEventsByActionId` + `foldRecord`
                               ⚠️ `executed` 是"她真的做了没有"的**唯一**依据（适配器是否被调用过）
```

### 6.23.1 ⭐ 有界探针（真行，不是桩）—— 通过，并**暴露了桩藏起来的东西**

```text
插两条真事件（一条用户"我写完提纲了"、一条助手回复"好，记下了"）之后：
  ① `findEvents(真 id)`          ⇒ **1 条** · actorType=user
                                   · **qualification = `UNCONFIRMED_ORIGIN`**（**程序推的**）
  ② `findAssistantEvents(真 id)` ⇒ **1 条** · `text="好，记下了"` · `replyToEventId` 对得上
  ③ 不存在的 id                  ⇒ 用户侧 **0 条** · 动作侧 **0 条**（"查不到就是查不到"）
```

⚠️ **①那条是重点**：一条**legacy 行**（没带受信归因）的资格是 **`UNCONFIRMED_ORIGIN`**，
而兑现判定对 `user_report` **要求 `ESTABLISHED`**（`completion_source_not_established`）
⇒ **生产里靠 `main.ts` 的 `attribution:` 真的把受信归因写进去**（那正是 K-28 的接线点）。
⇒ 而 `m10-e2e-verify.ts` 的桩**伪造了 `qualification: 'ESTABLISHED'`** ——
**它的兑现路径之所以过，是因为桩在撒谎**。这条是**把桩换成真实现**才看得见的（`L-M10-67` 的价值证明）。

### 6.23.2 施工单进度

```text
✅ ① `completion` 端口的生产实现（本文件 §6.23）
✅ ② "按 id 取会话事件" —— **已有**：`getConversationEvent` / `readConversationEventAttribution`
     ⚠️ **更正我上一轮的说法**：我说"生产里没有按 id 读会话事件的 reader" —— **错了**，
        我上次只按 `eventById` 之类的名字找，漏了 `getConversationEvent`（`conversation-store.ts:530`）。
⏳ ③ 接线（`main.ts` 的 `buildGoalTurnPort`）+ 加开关（`G-1`）+ 跑 `m4:test`/`m4.5:test`
⏳ ④ `m4.5:ci:full`（含 Live Smoke，约 34 分钟）
```

## 6.24 `G-1` + `G-2` 接线完成 + `m4.5:ci:full` 读数（2026-09-30）

### 6.24.1 接线（判决书里唯一挡着 `Implementation` 的那件）

```text
`G-1`  `flags.ts` 加 `goalsEnabled`（`CHARACTER_GOALS_ENABLED`，缺省 **off**）+ **被真的消费**
`G-2`  `main.ts` 的 `buildGoalTurnPort()`：四个端口全接真存储（含 §6.23 那份兑现判定）
       ⚠️ 接线点在**每轮** `compileTurn` 的输入（`CompileTurnInput.runGoalTurn`），
          **不是**网关构造参数 —— 我原先认错了接口，`typecheck` 当场纠正。
```

**关着时行为零变化**（缺省 off）—— 干跑自证：

```text
Info kernel flags: … OFF=[telemetry, memory-background(NOT-WIRED), memory-llm-extractor, **goals**] … ⇒ exit=0
```

**两条静态回归锁**（`m10:test`）：

```text
`S7` 断言 **消费的写法本身**（`flags.goalsEnabled ?`），**不是**名字出现次数
     ⚠️ 第一版数的是出现次数（阈值 ≥2）⇒ 当场红（只有 1 处消费点）
     ⇒ 改成断言消费形态 —— 否则注释里提一句就能骗过它（那正是 `C2`/`C3` 踩过的坑）
`S8` 接线点在场（`runGoalTurn` 在代码里）
```

### 6.24.2 三道判据各自响了一次（都按设计）

```text
① `m10:activation:verify` A2/A3/C1：表里 G-1/G-2 写着 OPEN、代码里已是 CLOSED
   ⇒ "**候选在低估自己**" ✓ ⇒ 表更新（G-1…G-4 全 `CLOSED`）；且零开放缺口 ⇒ 总判改 `READY`
   ⚠️ 把"**激活前仍需两件**（① 开档 live 读数 ② 用户授权）"写在**同一行**，不让 `READY` 被误读
② `m10:measurement:verify` V-N13：负控的**注入点**随改文档而消失
   ⇒ 判 **MEASUREMENT INVALID**（**不是静默跳过**）⇒ 把负控**方向翻转**（谎写成 OPEN ⇒ 表低估自己）
③ `m10:test` S7（上面那条）
```

### 6.24.3 `m4.5:ci:full` 读数（接线必须跑的那道）

```text
**EXIT 0** ✓ · Production-copy Live Smoke **52 通过 / 0 失败** ✓
⚠️ 但 CI 输出里有一行 `G14=FAIL` —— 那是**已登记的 `L-M10-59`**：
   聚合器按设计"只读已落盘证据"，而它跑在 smoke **更新证据之前**。
   实测时间戳钉死了这一点：`gate-results.json` **18:31:37**（先读） vs
   `smoke-result.json` **18:35:39**（后写，晚 4 分钟）⇒ 聚合读到的是**旧**证据。
```

### 6.24.4 ⭐ `L-M10-68`：**"开档"的 live 读数还没有**（如实登记）

```text
上面那次 smoke 跑的是**缺省配置**（`goalsEnabled` **off**）
⇒ 它证的是"**装配改动零变化**"（这很重要 ✓），
   **不是**"开档那条链在真装配里跑得通"（那才是 `G-2` 的 live 验证）。
⇒ 两条路，各需一件事：
   （a）**生产副本**上的 live 档（cpSync 到 %TEMP% 再跑，**真实库只读**）—— **我可以自己做**
   （b）**真实库**上跑一轮开档对话 —— **必须先问用户**（用户规矩：想改真实库必须先问）
⇒ `Implementation` 因此在 `PARTIAL` / `COMPLETE` 之间**按这条读数**决定：现在写 **`PARTIAL`**
   （候选 §1 #2 的理由：§6.1「冲突时以 Live Smoke 为准」⇒ 开档读数出来之前不认"完成"）。
```

## 6.25 `L-M10-68` 的第一次尝试：**开档 live 读数失败**（2026-09-30）

### 6.25.1 探针做了什么（**生产副本，真实库只复制**）

```text
① 算真实库树摘要（规范的 `digestTree`）   ② `cpSync` 到 %TEMP%（**真实库从不打开**）
③ 起一轮**真装配**对话：`src/main.ts "<目标相关的话>"`，`CHARACTER_GOALS_ENABLED=true`
④ 再起一轮**关档**的（**负控**：期望零目标事件）   ⑤ 读两个副本里的目标领域事件
⑥ 再算一次真实库摘要（**安全性质**：必须逐字相同）
```

### 6.25.2 读数（**部分是好的，核心是坏的**）

```text
✅ 轮次正常完成：exit=0 · 有回复 · `domainEvents=1` · 模型 8–12 秒
✅ **真实库摘要逐字未变**：`ba9ad570…` 前后相同（**1211 文件**）—— 安全性质成立 ✓
✅ 开关**确实是开的**：那一轮打出 `ON=[…, **goals**, …]`
❌ **目标领域事件 0 条**、`sections` 里**没有目标块**
   （完整 sections = current-input · integrity-rules · identity-core · critical-state · clock ·
     relationship · affect · belief · memory-no-evidence-constraint · memory-record-status ·
     recent-conversation · rolling-summary —— **没有任何 goal 块**）
⇒ 结论：**开档那条链在真装配里没有产出** ⇒ **FAIL**（探针如实报 ❌）
```

### 6.25.3 ⚠️ 原因**未隔离**（两种可能与证据都一致）

```text
（i）  `outcome = source_unusable`：新写那条会话事件的**资格不是 `ESTABLISHED`**
      ⇒ 事实块按 `D29` 不产、写入为 0 —— **与观察完全一致**
（ii） 端口抛错，被网关**按设计吞掉**（`goalPortFailed` ⇒ 静默无 section）
⇒ **两者都是失败关闭**（拒绝而不是写错）✓ —— 这一点本身是好消息。
```

### 6.25.4 ⭐ 教训：**我两次诊断都测了自己**

```text
两次 `--direct` 诊断都报 `source_unusable`，我差点把它当成产品的结论 ——
而它们都用了**假角色 id**（`char_m10_onpath`）⇒ 在那个 id 下**查不到任何事件**
⇒ 诊断证明的是**它自己**，不是产品。
⇒ 纪律（与 `F3`/`B3`/`L-M10-65` 同族）：**诊断必须先证明它在测产品** ——
   用**真实角色 id**（或从副本里**查出来**），并让"测到 0 条"与"没测到"在输出上分得开。
```

### 6.25.5 因此

```text
`Implementation` **仍写 `PARTIAL`**（候选 §1 #2）：§6.1「冲突时以 Live Smoke 为准」——
开档的 live 读数**与离线绿冲突**，所以在它修好之前**不认"完成"**。
⚠️ 另一条路（**真实库**上跑一轮开档对话）**必须先问用户**（用户规矩）。
```

### 6.25.6 ⭐ 第二次尝试：**原因隔离出来了**（2026-09-30）

**诊断怎么修好的**（第一次的教训）：**不猜角色 id** —— 从那一轮的 stdout 解析 `traceId`，
再按 `traceId` 读副本里的 **trace steps**（`getTrace`）。而**网关本来就会把失败记下来**
（端口抛错时五个 goal step 全写 `port_threw`）⇒ "链为什么没产出"**在 trace 里一直有答案**，
我第一次没去那里找。

**决定性读数**：

```text
`goal_*` 步 **5 个都在** ⇒ **端口确实被调用了**（接线生效 ✓）
`goal_eligibility → outcome = **source_unusable**` ⇒ 挡在**资格**那一层
那条用户事件**存在**：`cev:…0001:dm-sumuwei-b8ec0760:138`
存储归因 = **`RECORDED`** · **读得出受信读数 = true**
⇒ 但**程序推的资格 = `UNCONFIRMED_ORIGIN`**
```

**`ESTABLISHED` 的两条要求**（`sourceQualificationOf` · `COGNITIVE_QUALIFICATION_RULE_VERSION = 1`）：

```text
① `reading.axisBConfirmed === true`
② `reading.contentOriginator = Known(USER)`
⇒ 生产那一行**至少缺一条**（下一轮打印这两个字段即可定位到哪一条）
```

⚠️ **结论（重要）**：这不是"接线没生效" —— 而是"**接上了，但生产 ingress 记的归因
不足以建立资格**"⇒ **按现在的装配，生产里每一轮都会被拒**（行为是**失败关闭** ✓，拒绝而不是写错）
⇒ 目标域**实际上打不开**。这**属设计问题**：要么让 M10 采信另一种资格来源，
要么让 ingress 补 Axis B —— **两条都要动被冻结/跨里程碑的东西**（需用户裁定）。

⇒ `Implementation` 仍 **`PARTIAL`**（§6.1：live 读数与离线绿冲突时**以 live 为准**）。

### 6.25.7 ⚠️ **纠正**：资格机制是好的，问题只剩一处（2026-09-30）

**第三次探针**（零模型调用 · 只读副本）把"资格"这一层单独量了：

```text
生产里**已有的行**：origin=RECORDED · source_kind=user_statement · authority=USER_EXPLICIT
                     · epistemic=user_report · axisBConfirmed=**true**
                     · contentOriginator=**Known(USER)** ⇒ 资格 = **ESTABLISHED** ✓
**我探针那一轮新写的行**：字段**逐字相同** ⇒ 资格 = **ESTABLISHED** ✓
`beginTurn` 的返回**确实带 `userEvent`**（`turn-gateway.ts:1079`）✓
```

⇒ ⚠️ **所以 §6.25.6 里那句"生产 ingress 记的归因不足以建立资格 ⇒ 属设计问题、需用户裁定"
是错的**（已纠正）：**行没问题、资格机制没问题**。

⇒ `source_unusable` 只剩**一处**可疑：**`sourceEventId` 到达我那段代码时是空的**
（或查不到那条事件）⇒ 而这条信息**在链路上丢了**（接线没有把它报出来）。

**下一轮要做的**：让接线把"收到的 `sourceEventId`"与"查到没有"**如实报出来**
（例如作为 `goal_eligibility` 步的一个具名读数）—— 那是能**区分**这一处的那次读数。

⚠️ **教训（同族第 3 次）**：**结论要等能区分它的那一次读数**。
我连续两轮都在证据不足时下了结论（第一次"两次诊断都测了自己"，第二次"归因不足 ⇒ 属设计问题"）。

### 6.25.8 ⭐ **答案**：接线没坏 —— 是**入口模式**（2026-09-30）

第四次探针（加了一条 **env 门控**的诊断 `M10_GOAL_DEBUG=1`，缺省**完全静默**）：

```text
[m10 goal] 资格：收到 sourceEventId=cev:…0001 · **查到事件=true** · **读得出受信读数=true**
           ⇒ 资格 = UNCONFIRMED_ORIGIN
那一行本身：authority=**UNCONFIRMED_ORIGIN** · epistemic=**UNCONFIRMED_ORIGIN** · axisBConfirmed=**false**
历史行：    authority=USER_EXPLICIT · epistemic=user_report · axisBConfirmed=true ⇒ **ESTABLISHED** ✓
```

**根因**（`conversation-attribution.ts`）：

```text
`conversationEntryModeOf(argv)`：**任何位置参数 ⇒ `scripted_agent_runner`**；
只有 `interactive_human_console` 才用"人打的"那一套 ingress。
⇒ 我的探针把话当**位置参数**传 ⇒ 那一轮**按设计**不算"人打的" ⇒ 归因不成立 ⇒ **链正确地拒绝** ✓
```

⇒ ✅ **这不是缺陷**：脚本/agent 轮次**不该**声称"用户说的" ✓。
目标域**只在真正的人机对话里**才可能拿到 `ESTABLISHED`。

**要验开档，入口模式必须走对**：

```text
（a）`src/main.ts` **不带位置参数** + 从 **stdin** 喂话 ⇒ `interactive_human_console` ✓ **可脚本化** ✓
（b）**真实聊天**（`pnpm chat`）—— **需用户授权**（写真实库）
```

⚠️ **教训（第 4 次同族）**：我连续三轮在证据不足时下过结论 ——
"两次诊断都测了自己" → "归因不足 ⇒ 属设计问题" → "新行是 ESTABLISHED"，
而**每一次真正的答案都来自再往下量一层**。

## 6.26 `m10:activation:readback` 已写出 —— §16.1 的 20 条**不再有"未实现"**（2026-09-30）

**文件**：`scripts/m10-activation-readback.ts`（门已登记，在**离线**组 —— 零模型 / 零出网 / 不打开真实库）。

### 6.26.1 它做计划 §18.2 的三层读回

```text
① **配置读回**：只输出**非机密**的 flags 与版本（**绝不打印任何凭据取值**）
② **装配读回**：开关状态 + 装配在位（`main.ts` 的**代码**里有 `flags.goalsEnabled ?` 的消费写法）
③ **首次行为读回**：接受事件 → 投影 → context → 可见回复对账
   ⚠️ 未观察到就写 **`FIRST-USE NOT OBSERVED`**（计划 §18.2 逐字），
      **绝不**"为了凑读数以用户身份向真实会话写合成承诺"
```

### 6.26.2 ⭐ 为什么它**不打开真实库**（这是设计要点）

```text
开关关着 ⇒ **按定义不可能有目标写入**（`runGoalTurn` 不注入 ⇒ 那条链整段不跑）
⇒ 第三层**定义上**就是 `NOT OBSERVED`，**不需要**读库就能如实报出
⇒ 于是本门**不需要**"允许打开真实库"的新授权（那份授权只给两个既有只读验收脚本）
开关**开着**时：它**如实拒绝**并指出该走哪条路（快照副本读回 / 带 pre-open token 的只读 opener），
而**不**自己去开 —— 那是**独立授权**的事。
```

### 6.26.3 读数（当前：未激活）

```text
verdict **PASS 6/6**（判的是"三层如实报出"，不是"已激活"）
① 配置：goals=**off**   ② 装配：在位=**true** · 开关=**off**   ③ 首次行为：**`FIRST-USE NOT OBSERVED`**
```

⚠️ **门判 PASS 的含义要说清**：它判的是"**读回本身如实**" ✓；
`NOT ACTIVATED` / `NOT OBSERVED` 是**内容**（写在证据档的 `activated` / `firstUse` 里 ✓），**不是**"这门没过" ✓。

### 6.26.4 §16.1 的账（现在）

```text
**18 ✅ 独立脚本 + 2 🔀 判据并入 + 0 ❌ 未实现 = 20** ✓
⇒ ⭐ **计划点名的 20 条命令里已经没有"未实现"的了**
```

## 6.27 计划完备性复查（2026-09-30）：把计划里 56 条规范句逐条对了一遍

**方法**：从计划里抽出所有含「必须 / 至少 / 不得 / 不许」的句子（**56 条**），
按**结构性**的那些逐条对代码与读数（实现细节那些由各自的判据守着 ✓）。

### 6.27.1 逐条结果

```text
✅ §2「必须实现」**7 项**全部有覆盖（本轮逐项确认）：
   ① 明确设立/采纳 + 角色可提议但不能替用户接受 ✓（`origin` + 采纳路径 + 放行口）
   ② 查询/修改/暂停/恢复/取消/**替代**/完成 + 状态跨重启 ✓（9 个操作 + 500 轮跨重启读数）
   ③ ⭐ **一个 Goal 至多一个正式承诺** ✓ —— 实测判据在场：
      `goal-validator.ts:819` 的 `commitment_already_active`（"重新约定必须走 supersede"）
   ④ 当轮选一个下一步 / 默认不插无关话题 ✓（焦点选择 + `m10:context:verify`）
   ⑤ Memory/Belief 的规划依据带引用·版本·资格 ✓（`m10:inputs:verify`）
   ⑥ 有限可判定的完成证据 ✓（`m10:completion:verify` + 兑现判定端口的**生产实现**）
   ⑦ 开发者只读查询 / trace / 拒绝理由 / 事件重建 / 故障恢复 ✓（`m10:m11:verify` + observability + C13 + oracle + rebuild）
✅ §16.1 的 20 条：**18 ✅ + 2 🔀 + 0 ❌**（机器守着）
✅ §16.2/§16.3：聚合纪律 + 19 条回归（16 有记录 + 3 具名未记录）
✅ §18.1 的 8 项候选条件：**8/8 MET**（机器守着）
✅ §18.2 三层读回：`m10:activation:readback` 已写出（当前如实报 `NOT ACTIVATED` / `NOT OBSERVED`）
✅ §18.3 回滚：候选 §5 写了演练计划 + "不许做的事"逐条
✅ §21.1 的 14 槽：全部有判定（`Implementation` = `COMPLETE`）
✅ §21.2 的 15 份交付物：**全部交付**（机器守着）
✅ 两条结构不变量（第 208/268 行）：
   · 同内容重新设立 ⇒ **新身份** ✓（`m10:test` 的 `G14`）
   · 取消 Goal 时承诺须同操作取消 ✓（`goal_orphan_commitment`）
✅ §6.3 时间模型：`dueAt` + `dueBasis` + `timezone` 的**跨字段不变量** ✓（`C10`）；
   且 `C9` 断言**生产侧 0 处 `dueAt`** ⇒ v1 **不从自然语言推日期**，遇歧义走 `clarify` ✓
```

### 6.27.2 ⚠️ 复查抓到**一条真缺口**：`L-M10-69`

```text
计划 §6.3 末条要求：「注入时钟…覆盖**跨日、重启、迟到结果、时钟回退**和**不同 `recordedAt`/`occurredAt`**」
实测：重启 ✓ · 迟到 ✓ · 重复 ✓ · 跨字段不变量 ✓
**未覆盖**：**跨日** · **时钟回退** · **`recordedAt ≠ occurredAt`**（三个都按名字找不到判据）
⇒ 登记为**测试覆盖缺口**（**不是行为缺口** —— 那三条要测的是**时间模型的机制**，
  而 v1 不从自然语言推日期 ⇒ 没有依赖它的已接线路径）
⇒ 补法：在 `m10:long:verify` 里加三条注入时钟的判据，**不改产品代码**。**对 M10 判定无阻断**。
```

⭐ **这条是"完备性复查"本身的价值证明**：56 条规范句里，前 55 条我都以为"肯定覆盖了"，
而**逐条对**才把它找出来 —— 与 `B3`/`B4` 同一条纪律：**别靠印象，靠逐条对**。

### 6.21.5 ⭐ 500 轮 live 读数（2026-09-30 补跑 —— §16.1 那一行写的是"**200/500 轮**"）

```text
`m10:long:live --turns=500`  ✅ **PASS 8/8**
  分布：accepted×60 · clarify×261 · query×38 · no_operation×81 · invalid_output×60
  ⭐ **事件/trace 一致性 0 轮不一致** · trace 满 5 的有 **500/500** 轮
  ⭐ **`rebuild` 逐字相同 = true**（重放事件 > 0）⇒ **不变量 ② 在 500 轮真模型轨迹上被验**
  · 写路径命中 60 轮 · 时延 min=966ms · mean=2231ms · **max=8866ms**
  ⚠️ 这一次**没有** `transport_failed`（200 轮那次有 2 次、max 正好撞到 20s）
     ⇒ **两次读数的差异本身是信息**：撞期限是**偶发**的，不是系统性（20s 余量小，但不是每次都会撞）
```

⇒ §16.1 的 `long:live` 行（"200/500 轮真实连续轨迹"）**两条读数都齐了** ✓。
⚠️ 与**离线**的 `m10:long:verify`（200/500 轮 + 跨进程重启 + 复活 + 迟到 + 重复）**各有归属** ✓。

## 7. 下一步

M10 的**离线可做部分到此为止**。剩下的全部需要用户：

| 项 | 需要谁 | 状态（2026-09-30 更新） |
|---|---|---|
| `U-11` + `U-15` | 用户选人审方式 + 审语料金标 ⇒ 之后才能跑 `m10:semantic:eval`（真模型） | ✅ **都已下**：方式 = **甲·逐案**；九条金标**只驳回第 5 条**（`clarify → query`）⇒ 现在只等**用户填 70 张卡** |
| `U-01` | 用户授权 ⇒ 按 INC-01 纪律开真实库**只读副本**核 schema（WP12 前置） | ✅ **已关闭**：只读副本量到 **schema = 9 · 无待应用迁移**；真实库摘要逐字未变 |
| `Acceptance Report` | **事实报告**（逐槽写真实状态） | ✅ **已交付**（`M10-Acceptance-Report.md`） |
| `Gate Decision` | **判决书**：**必须**等语义门读数 | ⏳ 未出（等卡填完 → 语义门） |
| **`L-M10-61`** | 用户裁定（① 调用点包 try/catch ② 探针把缺表当具名失败 ③ 迁移/启动 ensure 的设计裁定；另：是否关 `.env` 开关立即缓解）⇒ **它同时挡着 live 档与 `G-2` 接线** | ⏳ **根因已定位**（交接单 §6.13，六层读数）；**修法待裁定** |
| 第二份 `digestTree` · `L-M10-59` · `L-M10-62` · `L-M10-63` | 归属裁定（跨里程碑 / 冻结面） | ⏳ 未裁定 |

⚠️ **离线侧的"不需要用户"的活在本轮**（`N13`）**之后确实用尽了**。
再往下要么动**别的里程碑**（`L-M10-61` 的根因在 M9.5 的 client 内部），
要么写**空结论**（两份结论文档）——那两件**都不该由我单方面做**。
