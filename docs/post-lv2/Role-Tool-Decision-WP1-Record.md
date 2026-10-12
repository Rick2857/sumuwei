# 角色自选工具 · WP1 记录（决策入口已接线 · 读数与边界）

日期：2026-10-05。状态：**WP1 已接线（代码缺省仍是 `rules`）· 决策未激活 · 真实模型选择质量 NOT RUN**。

载体：[`Role-Tool-Decision-Plan-2026-10-05.md`](Role-Tool-Decision-Plan-2026-10-05.md) §6 WP1 ·
[`ADR-104`](../adr/ADR-104-role-tool-decision.md)（`D01`–`D15`）·
[`Role-Tool-Decision-WP0-Baseline.md`](Role-Tool-Decision-WP0-Baseline.md)（WP0 基线）。

---

## 1. 这一轮接线接了什么（四处，都是加法）

```text
① 模式开关     `CHARACTER_TOOL_DECISION_MODE` ∈ {`rules`(缺省), `role`}；非法 ⇒ `rules`
               `CHARACTER_TOOL_DECISION_TIMEOUT_MS`（1s…25s，缺省 8000）
② 决策契约     `src/kernel/action/tool-decision.ts`（WP1 契约，上一轮已落）
               本轮补：`readToolDecision()`（问一次 + 严格解析 + 三桶失败）
③ 执行路径     `action-turn.ts` 的 **role 路径**：配了决策端口就
               "决策一次 → 提案当首份计划 → 走**既有**任务执行环"，
               关键词检测器**整段不参战**（`rules` 档逐字节不变）
④ 装配         `main.ts` 在 `role` 档构造 provider 与**程序生成**的目录；
               目录与任务授权**共用**一份能力清单（`toolCapabilitiesForTurn()`）
```

⚠️ **没有新增执行能力**：域、权限、目标解析、风险额度、账本、归因全是旧的那一套。

### 1.1 "role 档真的接上"需要四件同时成立

```text
① `CHARACTER_TOOL_DECISION_MODE=role`
② 决策端口能构造（有 key、有 provider、有程序生成的目录）
③ 任务执行环在场（`CHARACTER_TASK_AUTONOMY_ENABLED=true`）且**至少一个能力被启用**
   —— 少了这一件，决策**不会被问**（如实记 `branch=skipped · reason=no_task_loop`），
      而不是"问了却做不了"
④ 提案的 `tools` 分支只能走既有执行环（预算 / 期限 / 进度闸 / 暂存 / 账本 / 归因一个不换）
```

⚠️ 第 ③ 条是一件容易漏掉的事：**只开 `role` 而不开任务自主** ⇒ 她仍然什么都不做，
而日志上只会看到一行"决策被跳过"。激活记录必须把这两行一起写（WP4 的检查项）。

### 1.2 两处**共享文件的改动没有随本轮入库**（混合树交接）

```text
`src/main.ts` 与 `src/kernel/app/turn-gateway.ts` 的接线**在工作树里已完成**，
但**本轮没有提交**它们，理由是一条真实的入库纪律（R-01 / AGENTS.md §8）：
  · 这两个文件当前还带着**另一个会话**的在途改动（会话跳号修复 / goal 理解 /
    时延读数 / 文本流），而那些改动**引用了两个尚未跟踪的新模块**：
      `src/kernel/app/bridge/streaming-speech.ts`
      `src/providers/chat-stream.ts`
  · 只提交我对这两个文件的 hunk 做不到：我改的那一处（`beginTurn(...)` 那一行）
    与对方的会话跳号修复**落在同一个两行区域**里，diff 已经把两者并成一个 hunk。
  · 整文件提交则会让 HEAD 引用未跟踪文件 ⇒ 别人检出即编译不过（R-01 的真实事故形状）。
⇒ 处置：**明确交接**（AGENTS.md §8 允许的另一条路）。对方那两个新模块入库后，
  这两个文件可以原样提交；在那之前，工作树里的 role 接线是**已跑通但未入库**的状态。

#### 1.2.1 2026-10-05 复查：为什么**不能**"顺手把对方那两个模块一起提交"

复查发现这条交接**没有更省事的走法**：

```text
· 对方那两个新模块（`streaming-speech.ts` / `chat-stream.ts`）本身可以单独提交，
  但**只提交它们不够** —— `main.ts` / `turn-gateway.ts` 的**入库版本（HEAD）**里
  还没有引用它们，所以 HEAD 仍然缺我的接线。
· 一旦要提交这两个共享文件，就等于提交对方**整份在途改动**：他们改的不只是
  这两个文件，还有一批**已跟踪**文件的修改版
  （`src/kernel/app/goal/turn.ts` · `src/kernel/app/goal/understanding.ts` ·
   `src/infrastructure/model/openai-goal-understanding.ts` ·
   `src/infrastructure/runtime/adapters.ts` · `src/infrastructure/bridge/turn-bridge-transport.ts` ·
   `src/kernel/context/expressive-speech-section.ts` · `src/providers/openai-compatible.ts`）。
  那些文件在 HEAD 上是**旧版**，而对方的新 `main.ts` 会调用它们的新接口
  ⇒ 只提交 `main.ts` + 两个新模块，**HEAD 会编译不过**（正是 R-01 那条事故的形状）。
· 要让它编译得过，就必须**整份收编**对方那 7 个改动文件 + 2 个新文件 ——
  那是"顺手提交别人的在途工作"，而且我**无法验证**那份改动是不是处于可提交状态
  （它可能正处在半途）。
```

⇒ 结论：本轮**不提交**这两个文件，把它作为一条**具名交接**留在记录里。
   对方那两个模块最后一次写盘是 2026-10-05 12:41 / 13:11（**已静止 7 小时以上**），
   因此移交的成本很低：他们入库之后，`main.ts` 与 `turn-gateway.ts` 可以原样提交。

⚠️ 由此产生两条**必须如实说**的读数边界：

```text
· 本轮的 commit 里，`flags.ts` 的 `toolDecisionMode` 在 **HEAD 的 main.ts** 里还没有消费者
  （消费者在工作树里）。⇒ 在 HEAD 上它是一个**惰性开关**，而在工作树上不是。
· `pnpm postlv2:role-tool:path` **不依赖 main.ts**（它自己装配床），
  所以那条读数在两种状态下都成立。
```

#### 1.2.3 **交接已解除**（2026-10-05，用户指令「整份收编」）

```text
用户显式指示：把另一个会话的在途改动**整份收编**，以修好 HEAD。已执行：
  · `0ed507b7` chore(shared-tree)：收编对方在途改动集（新模块 2 个 + 已跟踪源码 7 个 +
    脚本/文档若干，**逐字**不动），**不含** devices 证据与 `__pycache__`
  · `8b202617` feat(role-tool)：`main.ts` 与 `turn-gateway.ts` 的接线随之上库
    （这两份文件里对方的 hunk **无法**与我的分开 —— 会话跳号修复与我读决策上下文的那两行
      落在同一处，diff 早已并成一个 hunk；已在提交信息里写明）
```

✅ **验证（干净检出，不是工作树）**：

```text
git worktree add --detach <HEAD=8b202617> + tsc --noEmit  ⇒ **0 个错误**
     （收编前：15 个错误 / 5 个文件；§1.2.2 记的就是那一组，现已全部消失）
同一干净检出上跑 `postlv2:role-tool:verify` ⇒ PASS（wp0 84/14 · wp1-contract 28/4）
```

⇒ 之前那两条"必须如实说"的边界（惰性开关、"HEAD 不编译"）**随本次收编一并解除**；
两处记录按"读数不回写"的纪律保留原文，修正写在这里。


⚠️ 一处**交接期的桥**（`5c019e5d`）：已入库的验收床（`scripts/productivity-skills/assembly.ts`）
调用的 `beginTurn(text, context)` 两参形态住在未入库的 `turn-gateway.ts` 里，
因此床里改成**显式窄化 + 绑回接收者**的调用（`.call(gateway, …)`）。
**它不会静默降级**：参数一旦被忽略，本仓库那条"决策输入：最近对话行原样送到"的判据会
**响亮地**失败。（第一次写这处桥时漏了绑回接收者，门当场报
`Cannot read properties of undefined` —— 这一条也顺便证明该判据是活的。）

#### 1.2.2 本轮的**独立发现**：`main` 的 HEAD 本来就**编译不过**（与本次改动无关）

```text
方法：用 `git worktree` 在**干净检出**上跑 `tsc --noEmit`，两个提交对照。
  · `6d073986`（我动手之前的最后一个提交）= 15 个错误 / 5 个文件
  · `5c019e5d`（本轮结束时）             = 15 个错误 / 5 个文件   ← **同一组**
  · 我这批一度**多出一个**（`scripts/productivity-skills/assembly.ts` 的两参 `beginTurn` 调用）
    ⇒ 已在 `5c019e5d` 修掉（就是上面那处桥）。
```

五个文件与成因：

```text
① `src/kernel/app/bridge/turn-bridge.ts` 与 `src/infrastructure/bridge/turn-bridge-transport.ts`
   在**已提交**的版本里 `import type … from './streaming-speech.ts'`，
   而那个文件**没有入库** ⇒ 检出即 `TS2307`
   —— 这正是 R-01 那条事故的形状，而且它**已经在历史里**（不是本批造成的）
② `src/main.ts` 与已提交的 `turn-bridge.ts` 不匹配
   （`lastTurnIdentity()` 少 `streamStatus`）
③ `scripts/m10-context-verify.ts` / `scripts/verify-m5-budget.ts` 没跟上
   `ContextBudget.turnContentTokens` 变成必填
```

⇒ 这两层交接的**结论**：

```text
· 我的接线未入库（`main.ts` / `turn-gateway.ts`）——见 §1.2。
· 更要紧的是：**HEAD 现在不编译**，而修它必须整份收编另一个会话的在途改动
  （7 个已跟踪文件 + 2 个新文件 + 2 个脚本，其中一部分我无法验证是否处于可提交状态）。
  ⇒ 这不是本会话该单独决定的事：**如实报告**，交给用户或接管会话。
· 工作树本身是**编译得过**的（`pnpm typecheck` EXIT 0）—— 因此本记录里的全部读数
  都是工作树上的读数，这一点必须跟着读数一起说。
```



---

## 2. 读数（两个门，**分开报**）

```text
pnpm postlv2:role-tool:verify   wp0-catalog PASS 84 输入 / 14 判据
                                wp1-decision-contract PASS 28 输入 / 4 判据
pnpm postlv2:role-tool:path     wp1-role-path PASS 38 输入 / 38 判据   ← 本轮新增
pnpm typecheck EXIT 0 · pnpm m4.5:test 146/0 · pnpm m4:test 259/0
```

`postlv2:role-tool:path` 用的是**真 TurnGateway + 真 ActionTurnPort + 真 ActionGateway /
Policy / 账本 / 适配器 + 真 runTask**，只把**决策端口**换成脚本夹具（`modelCalls: 0`）。
因此它量的是"提案怎么被处理"，**不是**"模型会不会好好提案"。

### 2.1 缺口 1（自然语言入口）——**同一句话，两档的对照**

```text
原句（计划书 §1 逐字）：我想问个问题，就是我的电脑桌面上有几个快捷方式。

机器事实：looksLikeTask(原句) = false
          M4.5 检测器 / 本机文件域检测器 / 第一批四项检测器 全部 undefined
rules 档：同一句话 ⇒ actionResults = 0 · 账本 0 行        ← 缺口 1 是真缺口
role  档：同一句话 ⇒ 一次 local.file.list，status = success，账本 1 行
```

### 2.2 缺口 2 的第一半（真实内容回传）——已有读数

```text
role 档那一轮：turnContent 非空，正文里带着合成目录里的**真实条目名**（`notes-cn.txt`）
               `turn-content` section 非空且**含该条目名** ⇒ 内容真的进了 prompt
```

⚠️ 另一半（**决策/规划看到实际内容**而不是 `path=...=success`）**还没做** —— 那是 WP2。
另：本门用的是 `%TEMP%` 下的合成目录，**不是**真实桌面；真实"已知目录证据"也是 WP2。

### 2.3 零动作与失败分篮（每一档都有读数）

```text
answer                ⇒ 0 动作 · trace 记 branch=answer / result=answered
clarify               ⇒ 0 动作
timeout               ⇒ 0 动作 · failure=timeout
端口抛错               ⇒ 0 动作 · failure=call_failed
提案多一个字段          ⇒ 0 动作 · invalid_output / tool_decision_unknown_field
没登记的能力            ⇒ 0 动作 · invalid_output / task_plan_step_capability_not_authorized
开关关着的能力          ⇒ 0 动作 · invalid_output / task_plan_step_capability_not_authorized
（以上每一档都同时断言：账本 0 行 —— 不是"执行了但没返回"）
```

### 2.4 单一入口的**反面**证据

```text
"帮我算一下 0.1+0.2"：旧档的检测器**会**触发计算意图（本门先断言这件事）
role 档 + 决策说 `answer` ⇒ 0 动作
⇒ 关键词不再是权威；同一模式里只有一个入口（D02）。
```

### 2.5 真实库

```text
`data/pglite` 的文件数与最新 mtime 在本门前后**逐字相同**（本门只在隔离库上跑）。
```

### 2.6 本门第一次读数是 FAIL（**留档，不回写**）

```text
role-tool-path-20261005T120525-bc29be11   FAIL  38 输入 / 4 条未通过
role-tool-path-20261005T120656-bc29be11   PASS  38 输入 / 0 条未通过   ← 本节报的读数
```

四条里**三条是量具自己的错**（量错了对象）：
```text
① 期望的合成文件名写成了 `notes.md`，而夹具树里叫 `notes-cn.txt`
   ⇒ "内容没回传"其实是"我在找一个不存在的名字"（AGENTS.md §6.9 的同型）
② 同一条错名连带把 "内容进 prompt" 那一条也判红（同一个根因，两条读数）
③ 目录泄漏扫描把 header 里那句"不要用任意 Shell / 脚本"算成泄漏
   —— 与 WP0 §7.1 完全同型，**又犯了一次**（这次改成只扫条目行）
```
第四条是**真发现**，而且正是混合树最容易出事的那一类：
```text
④ 验收床（`scripts/productivity-skills/assembly.ts`）没有把"role 档追加旧沙箱三件"
   这条规则镜像过去 ⇒ 床里 `allowedCapabilities` 只有两项，而生产（`main.ts` 的
   `toolCapabilitiesForTurn()`）是五项。
   ⇒ 若不修，这扇门会**永远照不到**生产里那三件是否真的进了授权集合
     —— 与那条 `spec_not_staged` 生产缺陷同型（床与生产不同形）。
   修法：床里也按 `role 档 = 任务能力 + 旧沙箱三件` 现算，并把同一份清单同时交给
   任务环与工具目录。
```


---

## 3. 已知边界（**不改写、不隐藏**）

```text
L-RTD-01 决策阶段看不到 DB 派生的 section（记忆 / 关系 / 情绪 / 信念）。
         D08 的代价：完整 ContextPacket 在动作**之后**才编译（ADR-030/033 的冻结顺序）。
L-RTD-02 目录的"无通用绕过接口"只覆盖具名黑名单那一条（WP0 §1 已写明）。
L-RTD-03 连接态在本批离线门里恒为 `unknown`（不连 sidecar）。
L-RTD-04 模型选择质量 **NOT RUN**：本门 `modelCalls = 0`；真模型样本属 W1 语义评估。
L-RTD-05 `clarify` 分支在首版**只表现为"不动作"**：那条问句不会被注入措辞层
         （否则就是"程序替她说话"）。要让它真的问出来，需要单独裁定"问句怎么进回复"。
L-RTD-06 决策段**没有自己的 trace kind**：复用既有 `action_dispatch`（不新增 kind
         ⇒ 不动 `contracts/trace.ts` 的闭集与分类法）。它记的是闭集码，没有正文。
L-RTD-07 真实桌面 / 已知目录证据仍缺（WP2）：模型**不得**猜 `user` / `Administrator`，
         而首版目录里没有"个人桌面 / 公共桌面"这两条程序事实。
L-RTD-08 `role` 档把旧沙箱三件（echo / sandbox.file.read / sandbox.file.write）
         追加进授权集合（计划书 §3 能力矩阵逐字）；`rules` 档**一个字节未变**。
```

---

## 4. 明确**不主张**

```text
· 不主张"她已经能自己选工具了"：代码缺省仍是 `rules`，**生产未激活**。
· 不主张"她选得对"：真实模型的选择质量一次都没量过（`L-RTD-04`）。
· 不主张浏览器 / 天气 / 办公 / 资讯在 role 档真的跑通了：本门只覆盖 `local.file.*`
  与"零动作"各档；全工具组合是 WP3。
· 不主张"关键词那一套没用了"：它仍是 `rules` 档的权威，也是回滚档。
```

---

## 5. 下一步

```text
接续（先做）：把 `src/main.ts` / `src/kernel/app/turn-gateway.ts` 的接线入库
             —— 前置条件只有一个：另一个会话的 `streaming-speech.ts` /
                `chat-stream.ts` 先落地（见 §1.2），之后这两个文件可以原样提交。
WP2 结果闭环与目标：给**既有**执行环的每次重新规划加有界实际内容；
                    程序提供 Windows 已知目录证据（个人桌面 / 公共桌面，含重定向）。
WP3 全工具组合验收：每项工具至少一次被选中、一次被拒绝/不选；关闭 / 断连 / 空结果 /
                    权限错误 / 截断 / 重复调用 / 取消 / 格式错误。
WP4 交付与激活：工程门 + 语义评估（固定样本逐案）+ 人审 + 隔离真实链 + 生产激活**分别记录**。
```
