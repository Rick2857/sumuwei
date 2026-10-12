# 第二批实用能力 · 当轮内容超单轮上限把整轮打死（2026-10-05）

> 触发形态：**头像实测**（`--mode sandbox-copy`，生产库副本），不是假想场景。
> 载体分工：本文 = 事故 + 修法 + 读数 + 边界；跨里程碑登记在
> [`docs/Tech-Debt-Register.md`](../Tech-Debt-Register.md) §0r（`R-53`）；
> 残余进 [`Productivity-Skills-Known-Limitations.md`](Productivity-Skills-Known-Limitations.md)（`L-PS-48…50`）。

---

## 1. 事故（2026-10-05 14:43:51）

用户（语音，外壳转文本）：

```text
还有一件事，能不能帮我查看一下我的电脑桌面上有几个快捷方式？
```

外壳侧读数（Open-LLM-VTuber 控制台）：

```text
14:43:51  User input: 还有一件事，能不能帮我查看一下我的电脑桌面上有几个快捷方式？
14:44:16  LG rejected or failed: turn_content_list_invalid        ← 25 秒之后
14:44:16  Conversation Chain completed（对话被中止）
```

**用户得到的：什么都没有。** 不是"答错了"，是**整轮没发生**。

### 1.1 那一轮真的做了什么（账本原始读数）

trace `30b967d8-a2f6-4f77-8a0b-5e8510e8661a`，**12 个动作，全部是 `local.file.list`**：

| 结果 | 路径 | 次数 |
|---|---|---|
| `ACTION_SUCCEEDED` | `C:\Users\Public\Desktop` | **6** |
| `ACTION_SUCCEEDED` | `C:\Users` | **4** |
| `ACTION_FAILED` | `C:\Users\user\Desktop` | 1 |
| `ACTION_FAILED` | `C:\Users\Administrator\Desktop` | 1 |

⇒ 10 份当轮内容进轮次，而 `TURN_CONTENT_LIMITS.maxItemsPerTurn = 6`
⇒ `selectTurnContentContext` → `assertTurnContentList` **抛错**（`turn_content_list_invalid`）
⇒ 桥把整轮记成 `failed`，外壳中止对话。

⚠️ 两条失败的动作是**模型猜的用户名**（`user` / `Administrator`）——
它列过 `C:\Users`，却**看不到**那份列表（见 §2.2）。

**取证方法**（可复用，**不打开数据库**）：按字节读沙箱副本
`%TEMP%\project-lg-exp-postlv2-avatar-*` 的 `base/**`，用 `trc:` / `Sact:` /
`ACTION_*` 事件名与路径做正则还原 per-trace 的动作清单。
⚠️ 事件名与字段之间是**长度前缀字节**（`0x21` 恰好是 `!`），
所以字面量 `ACTION_REQUESTED!local.file.list` 匹配不到 —— 这是本次踩到的坑。

---

## 2. 根因

### 2.1 触发面（这一步是**对的**，不是缺陷）

```text
"帮我…"             ⇒ looksLikeTask() = true（task-intent.ts）
CHARACTER_TASK_AUTONOMY_ENABLED=true（.env）⇒ 走任务执行环 + 真模型规划器
```

### 2.2 规划器**看不到内容** ⇒ 循环不可能收敛（真正的主因）

修复前，回给规划器的"已经执行过的步骤"只有：

```text
local.file.list.list=success      ← 没有路径、没有条目数、没有指纹
```

于是它既不知道"这个目录我列过了"，也不知道"用户的桌面到底叫什么"。
实测行为：**同一个目录列 6 次 + 猜两个用户名**，直到规划预算（6 次）用光。
⇒ 这不是"模型笨"，是**我们没把它需要的事实给它**。

### 2.3 份数上限是**抛错**，而两个上界本来就矛盾

```text
MAX_STEPS_PER_PLAN = 8   >   maxItemsPerTurn = 6        ← 一次规划就能越顶
任务预算 = 30 次行动 / 6 次规划 / 10 分钟                ← 越顶随时可达
```

契约把"一轮最多 6 份"写成**断言**（而不是像 token 额度那样"装不下就丢、如实计数"），
于是**份数**这个运行约束能把**整轮**打死。这是本次代价最大的那个设计选择。

### 2.4 失败原因被吞掉（为什么这条事故难查）

`turn-bridge.ts` 的 catch 只把 `KernelError.code` 回外壳，
真正的原因（`一轮最多 6 份内容，收到 10`）写在 `message` 里 —— **被丢掉了**。
⇒ 控制台上只有一个码；只能靠读账本原始字节复原。

---

## 3. 修法（`R-53`）

| # | 位置 | 做了什么 |
|---|---|---|
| ① | `src/kernel/contracts/turn-content.ts` | 新增纯函数 `aggregateTurnContentForTurn()`：**同源 + 同指纹去重**（留第一份、保序）+ **超上限如实丢弃并计数**；⚠️ **逐份契约仍是硬的**（对**全部**候选逐份断言，被丢掉的也不例外） |
| ② | `src/kernel/app/turn-gateway.ts` | 收集点改用汇聚（不再原样 flatMap）；读数落在 `IncomingTurn.turnContentAggregation`；`turn_content` 那一步的 `candidate_count` 记**降级之前**的候选数，另加 `kept_count` / `aggregate_duplicate_dropped_count` / `aggregate_limit_dropped_count`；真丢了东西时往 **stderr** 印一行 |
| ③ | `src/kernel/action/task-loop.ts` + `task-plan.ts` | 回给规划器的摘要**带上引用**（`path=` / `url=` / `query=`，单行、≤160 字符、只收引用不收正文）；整份计划都是"已经成功过的引用 + 同一个操作"时**如实停止**，新停止原因 `no_progress`（`TaskCloseReason` 具名追加） |
| ④ | `src/infrastructure/model/openai-task-planner.ts` | 指令里写清：同一个引用成功过就不要重复；凭已有结果能回答就 `steps=[]` + `done=true`；**不要猜名字**（`user` / `Administrator` 这类） |
| ⑤ | `src/kernel/app/bridge/turn-bridge.ts` | KernelError 的 `message` 走 **stderr**（压成一行、≤400 字符）。协议仍然只回具名码 |

**为什么降级发生在汇聚层，而不是把契约放宽**：

```text
契约层（每一份）：形状 / 范围 / 指纹 —— 硬闸，不许弱化
汇聚层（份数）：  运行约束 —— 丢 + 如实计数（与 token 额度同一条纪律）
```

---

## 4. 读数

| 门 | 读数 | 备注 |
|---|---|---|
| `pnpm typecheck` | **EXIT 0** | `src/**` + `scripts/**` |
| `pnpm productivity:verify`（28 组） | **PASS 27 · FAIL 0 · NOT RUN 1**（102 条参数化输入） | 与批内历史读数**同形**（唯一的 NOT RUN = `browser-04`，需人工首连真登录态） |
| `pnpm utility:verify`（32 组） | **PASS 29 · FAIL 3**（150 条输入） | 三条都是 math **超时**；见 §4.1 的分列与隔离复跑 |
| `pnpm kernel:test` / `kernel:verify` | **EXIT 0** / **EXIT 0** | `src/kernel/contracts/**` 改动 |
| `pnpm m4.5:test` / `m4.5:verify` / `m4.5:measurement:verify` / `m4.5:nl-action:verify` | **四个 EXIT 0** | 行动协议 + 任务环 + 量具三段式 + 自然语言行动 |
| `pnpm m4.5:ci`（完整离线链 M1→M4.5） | **EXIT 0** | 交付纪律门；见 §4.1 的第 ⑬ 条 |
| `pnpm m3.5:test` | **EXIT 0** | prompt 逐字节回归（chat prompt 未改） |
| `pnpm postlv2:bridge:verify` | **EXIT 0** | `turn-bridge.ts` 改动（stderr 诊断） |

### 4.1 本节读数（逐条落盘）

> 本轮（2026-10-05）在**当前工作树**上跑的读数。⚠️ 树是**多会话共享**的
> （`run.json` 的 `dirtyEntries = 395`、`head` 在一次运行期间移动过）
> ⇒ 按 `L-PS-34`：**以 `run.json` 的 `sourceHashes`（逐文件指纹）为准**，不以 `head` 为准。

```text
① pnpm typecheck                          EXIT 0
② pnpm kernel:test                        EXIT 0
③ pnpm kernel:verify                      EXIT 0
④ pnpm m4.5:test                          EXIT 0
⑤ pnpm m4.5:verify                        EXIT 0
⑥ pnpm m4.5:measurement:verify            EXIT 0
⑦ pnpm m4.5:nl-action:verify              EXIT 0
⑧ pnpm m3.5:test                          EXIT 0
⑨ pnpm postlv2:bridge:verify              EXIT 0
⑩ pnpm productivity:verify（28 组）
     runId = productivity-20261005T073053-82653e7d-af88
     组：28（PASS 27 · FAIL 0 · NOT RUN 1 · MEASUREMENT INVALID 0）· 参数化输入 102 条
     NOT RUN 1 = browser-04（需人工首连真实已登录 profile —— 与批内历史读数同一个）
     ★ 新增回归全绿：common-05 = 21 条断言（⑥-a…j · ⑦-a…d · ⑧-a）· common-06 = 10 条（④-a…e）
     证据：artifacts/post-lv2/productivity-skills/productivity-20261005T073053-82653e7d-af88/run.json
⑪ pnpm utility:verify（32 组）        **EXIT 1**
     runId = utility-20261005T072035-82653e7d-d220
     组：32（PASS 29 · FAIL 3）—— common-02（② 计算那四条）· math-01 · math-02
     三条的观察值都是 `math.calculate` 的 **`state=timeout`**（不是结果算错）
     ⚠️ 同一形态在**本批改动之前**的旧 run 里出现过（utility-…-5412d892-de8b，2026-10-04T15:49）
     ⚠️ 那个 run 期间本机同时跑着**头像外壳 + 浏览器 sidecar + 本门电池**（负载高）
⑫ pnpm utility:verify --only math       **EXIT 0**
     runId = utility-20261005T072709-82653e7d-a3ac
     组：14（PASS 14 · FAIL 0 · NOT RUN 0）· 参数化输入 75 条
     ⇒ 隔离复跑 math 组全绿 ⇒ ⑪ 的三条判为**负载诱发的超时**，**不是**本次改动引入
       （本次改动不碰 math 适配器 / 数学 worker / 它的超时；改动面见 §3）
⑬ pnpm m4.5:ci（**完整离线链 M1→M4.5**，本仓库的交付纪律门）   **EXIT 0**
     ⚠️ 它会重新生成 artifacts/m4-acceptance/ 与 artifacts/m4.5/ 下的历史证据；
       那些路径**在我动手之前就已经是脏的**（多会话共享树）⇒ 本轮**既没有提交它们、
       也没有回滚它们**（按 AGENTS §7：不对 artifacts/ 做无差别 checkout）。
```

**这两条读数分列，不合成一个"全绿"**（AGENTS §6.4/§6.6）：
`utility:verify` 全量档 = FAIL 3（超时），`math` 隔离档 = PASS 14/0；
旧失败档与新读数**各有归属、互不覆盖**。

### 4.2 新增的机器判据（三段式 + 事故形态回归）

```text
⑥-a 正控  3 份互不相同 ⇒ 一份不丢、保序、两个计数都是 0
⑥-b 负控  注入 8 份 ⇒ 留 6 / 超上限丢 2（**保序**丢后面两份）
⑥-c 自检  负控里 droppedByLimit > 0（量具真的量到了，不是零分母 —— AGENTS §6.8）
⑥-d 恢复  放回 3 份 ⇒ 重新安静
⑥-e/f **契约没有被改弱**：8 份在契约层仍然不合法，选择器仍然抛 turn_content_list_invalid
⑥-g 降级后的列表**仍然合法**
⑥-h 同源同指纹 8 次列举 ⇒ 只留 1 份（动作仍在账本里）
⑥-i 指纹不同 ⇒ **不**去重（同一路径读两次而中间被改过 = 两条事实）
⑥-j 混进一份非法内容 ⇒ 汇聚层照样抛 turn_content_invalid（降级不掩盖生产者缺陷）
⑦-a 8 步都产出内容 ⇒ **轮次照样成功**（修复前：整轮失败）
⑦-b 汇聚读数如实（候选 8 / 入轮 6 / 超上限 2，且 8 = 6 + 0 + 2）
⑦-c 动作一个都没少（8 条都真的执行了）
⑦-d trace 记的是**降级之前**的候选数
⑧-a 事故原始形态：同一个目录列 8 次 ⇒ 轮次上只剩 1 份，但 8 次动作都发生过
④-a/b/c 重复计划 ⇒ 只执行一次 · 停止原因 `no_progress`（**不是** done）· 已做的动作仍在
④-d/e **进度闸的负控**（这条比 ④-a/b/c 更重要）：读 A → **写 A**（正文换掉）→ 再读 A
        ⇒ 三次都执行、`stopped=done`、文件内容真的变成 SECOND。它同时证明两件事：
        · 带载荷的步骤（`local.file.write` 的 `content`）**永不**进进度闸
          —— 同一个路径 + 不同正文是两件事，误判会让那一写根本不发生
        · 有副作用的步骤会**作废**同一条引用上的读取记录（世界变了 ⇒ 再读回来核对是合理的）
```

**两处安全边界**（写在 `task-loop.ts` 的 `succeededReferenceSteps` 上方，机器判据是 ④-d/④-e）：

```text
① 只有 `taskStepReferenceIsExclusive()` 的步骤进"已经成功过"集合
   （args 的键**全部**是引用键：`{path}` ✅ / `{path, content}` ❌）
② 成功的**写**步骤作废同一条引用上的读取记录（`hasSideEffect`）
```

---

## 5. 本批**不主张**什么（逐条）

```text
① 不主张"她不会再重复列举"：机械保证只到"整份计划都在打转就停" + "摘要里带引用"。
   单步重复（计划里混了一步已做过的 + 一步新的）仍会执行 —— 那是刻意的
   （写完再读回来核对是**合理**的重复）。
② 不主张"规划器现在看得到内容"：它看到的是**引用**（path/url/query），
   正文仍然只在**回复**那一侧的当轮内容里。这是设计边界，不是本次没做。
③ 不主张"回复层知道有几份被丢弃"：汇聚读数落在 turn / trace / stderr，
   **没有**进回复守卫的来源与范围附录 ⇒ 真丢掉互不相同的内容时，她不会说
   "我只看到了其中 6 份"（`L-PS-49`）。
④ 不主张"离线 28 组全绿 = 真实链路全对"：离线替换了模型服务与出站 IO 两样东西；
   本次回归里的 8 步计划由**脚本化规划器**给出（形状确定），不是真模型的输出。
⑤ 不主张本次改了 M4.5 的冻结面 / 记忆语义 / 归因链：改动面见 §3 的五处文件。
```

---

## 6. 残余（进局限册）

| ID | 残余 |
|---|---|
| `L-PS-48` | 单步重复仍会执行（只挡"整份计划都在打转"）—— 行动预算与账本行数仍可能被同一个引用吃掉 |
| `L-PS-49` | 汇聚丢弃**不进回复守卫**（她不知道有几份没进上下文） |
| `L-PS-50` | "不要重复列举"的另一半靠**规划器指令**（措辞层，先例 `DR-11`：没有启发式守卫） |
