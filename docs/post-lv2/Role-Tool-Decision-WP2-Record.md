# 角色自选工具 · WP2 记录（实际内容回传 + 已知目录证据）

日期：2026-10-05。状态：**WP2 已实现并接线（代码缺省仍不激活）· 真实模型选择质量 NOT RUN**。

载体：[`Role-Tool-Decision-Plan-2026-10-05.md`](Role-Tool-Decision-Plan-2026-10-05.md) §6 WP2 ·
[`ADR-104`](../adr/ADR-104-role-tool-decision.md) `D14` ·
[`WP0 基线`](Role-Tool-Decision-WP0-Baseline.md) · [`WP1 记录`](Role-Tool-Decision-WP1-Record.md)。

---

## 1. 这一轮补的是计划书 §4 的**缺口 2**

```text
计划书逐字：「决策环能读取预算内的实际目录条目/文件片段/网页内容，而非仅 path=...=success。
             程序提供 Windows 已知目录证据（个人桌面、公共桌面等），处理重定向后的实际路径；
             模型不能猜 user/Administrator。」
```

### 1.1 实际内容回传（**复用既有执行环的"重新规划"**，不新建回路）

```text
每执行完一步：`ActionResult.turnContent` → 收集（同源同指纹去重、最多 8 份）
到下一次规划：`selectTurnContentContext({items, budgetTokens})`  ← **既有**选择器
              → `renderTurnContentEntry(item, label)`            ← **既有**渲染器
              → `TaskPlannerInput.content` → 规划器 prompt
```

⇒ "看结果再决定下一步"第一次成为**真的**：规划器拿到的是目录条目 / 文件正文 / 网页正文，
  而不是 `local.file.list path=C:\x=success`。

⚠️ 两处**同源**是刻意的：规划器看到的文本与"注入她 prompt 的那一份"用**同一个**渲染器
   产出（`renderTurnContentEntry`）—— 不是两份各自转述的摘要（本轮门里有一条判据专门断言
   "规划器拿到的行里含那一份的**完整正文**"）。

### 1.2 已知目录证据（**用系统自己的已知文件夹 API**，不自己解析注册表）

```text
kernel：`src/kernel/action/known-directories.ts`（纯函数）
        键闭集 = personal_desktop | public_desktop
        四档来源 = probe | probe_missing | probe_failed | probe_absent（**分列**）
        解析：`key=path` 逐行；重复取第一条；空路径不算；不认识的行忽略
        渲染：`renderKnownDirectoriesForModel()`（决策器与规划器**共用同一份**）
infra ：`src/infrastructure/action/known-folders.ts`
        固定脚本（**无任何用户输入拼接**）+ `[Console]::OutputEncoding = UTF-8`
        （Windows PowerShell 默认按控制台代码页写 stdout，路径里的中文会乱码）
        + 2 秒硬超时 + 失败如实（**绝不**回落 `%USERPROFILE%\Desktop` 这种猜测）
        用 .NET 的 `[Environment]::GetFolderPath('Desktop' | 'CommonDesktopDirectory')`
        —— 它**自己**处理 OneDrive 等重定向（既有实现，本仓库不重写）
```

---

## 2. 读数

```text
pnpm postlv2:role-tool:path        PASS  53 输入 / 53 判据   ← 本轮从 38 涨到 53
pnpm postlv2:role-tool:known-dirs  PASS（真实探测，只读）
pnpm postlv2:role-tool:verify      PASS  wp0 84/14 · wp1-contract 28/4
pnpm typecheck EXIT 0 · m4:test 259/0 · m4.5:test 146/0
pnpm productivity:verify --only common,files 12/12 PASS
```

### 2.1 离线门新覆盖的判据（13 条）

```text
已知目录（纯解析 + 渲染，**不 spawn**）
 · 探测输出被如实解析，**重定向后**的真实路径被保留（夹具：个人桌面被搬到 OneDrive）
 · 程序**不拼** `%USERPROFILE%\Desktop` 这类猜测
 · 查到了但目录不在 ⇒ `probe_missing`（并**保留**查到的那条路径供排查）
 · 输出不可解析 ⇒ 两档都是 `probe_failed`（宁可说不知道，不许猜）
 · 同一个键出现两次 ⇒ 取第一条
 · `probe_absent`（没探测）与 `probe_failed`（探测失败）**分列**
 · 渲染给出真实路径（模型可以逐字用）
 · 探测失败时渲染如实说"探测失败"，且**一个盘符路径都不给**

实际内容回传（**真执行环**）
 · 执行环真的**重新规划了一次**（先证明这一点，再量"规划器看到了什么"）
 · 重新规划时拿到的是**实际内容**（目录条目名在），不是 `path=…=success`
 · 内容与"注入 prompt 的那一份"**同源**（含那一份的完整正文）
 · 规划器同时拿到**程序给出的已知目录事实**
 · 额度 **0** ⇒ 一份内容都不带（"接了线但额度为 0"是一个真实配置）
 · 额度 0 时**已知目录事实照旧**（两件事各有各的开关）
 · 决策器与规划器拿到的是**同一份**已知目录渲染（一处产出、两处消费）
```

### 2.2 真实探测读数（**env-dependent，单独一支**）

```text
pnpm postlv2:role-tool:known-dirs ⇒ PASS
个人桌面（personal_desktop）：C:\Users\user\Desktop     ← 本机**没有**被重定向
公共桌面（public_desktop）：  C:\Users\Public\Desktop
两档来源都是 `probe`（查到了，且目录真的在）
证据：artifacts/post-lv2/role-tool-decision/role-tool-known-dirs-20261005T122137/known-directories.json
```

---

## 3. 已知边界（如实登记）

```text
L-RTD-09 真实**重定向**未观测：本机桌面没被搬到 OneDrive ⇒ 那一档只有夹具读数。
         本门不主张"在重定向的机器上验过了"。
L-RTD-10 规划器内容额度**复用既有的 `turnContentTokens`**（上限 1200），不新开额度开关：
         计划书 §7 逐字要求"共享本轮/原任务预算，不能借新环规避现有限制"。
         代价：把 prompt 额度调大时，规划器最多也只带 1200（上限是程序常量）。
L-RTD-11 已知目录只覆盖**两项**（个人桌面 / 公共桌面）；下载 / 文档 / 图片等
         要按需扩键（扩一个键要改探测 + 渲染 + 用例，不是配置项）。
L-RTD-12 首次探测失败**不阻塞启动**（只记一行 warn）⇒ 那一轮决策"不知道桌面在哪"。
         这是刻意的：启动因为一次探测失败而挂掉，比她说"我不知道"糟得多。
L-RTD-13 `clarify` 分支仍不发声；决策仍看不到 DB 派生 section（`L-RTD-01` / `L-RTD-05` 照旧）。
L-RTD-14 规划器的内容**只在 role 档接线**；`rules` 档的规划器输入逐字段不变。
```

---

## 4. 不主张

```text
· 不主张"她选得对 / 她读得对"：真实模型的选择质量与"依据内容选下一步"的行为质量
  一次都没量过（离线门 `modelCalls = 0`）。
· 不主张生产已激活：`CHARACTER_TOOL_DECISION_MODE` 代码缺省仍是 `rules`。
· 不主张"内容一定进 prompt / 一定进规划器"：额度为 0 时两处都不带（那是真实配置）。
```

---

## 5. 下一步

```text
交接（先做）：`src/main.ts` / `src/kernel/app/turn-gateway.ts` 入库（见 WP1 记录 §1.2）
WP3 全工具组合：每项工具至少一次被选中、一次被拒绝/不选；关闭 / 断连 / 空结果 /
                权限错误 / 截断 / 重复调用 / 取消 / 格式错误。
WP4 交付与激活：工程门 + 语义评估（固定样本逐案）+ 人审 + 隔离真实链 + 生产激活**分别记录**。
```
