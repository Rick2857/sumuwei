# 桌面右键补接与"打不开回收站"定位（2026-10-09）

设计依据 [ADR-127](../adr/ADR-127-desktop-right-click.md)。上游与既有边界见 [ADR-106](../adr/ADR-106-desktop-control.md)、[ADR-126](../adr/ADR-126-desktop-double-click-switch-launch.md)。

授权：用户就直接要求「她无法使用右键」在 2026-10-09 本会话显式选择「现在就补 right_click」。
用户同时贴出她那轮的原话：**「右键我按不了，那一下没接进来。……清空这事得先把回收站窗口打开，等窗口真出来，我再看里面有没有清空按钮。……刚才这一轮试过了，卡在超时上，没确认做成。」**

## 一、右键：改了什么

| 位置 | 改动 |
| --- | --- |
| `src/kernel/action/desktop-capability.ts` | 闭集加 `right_click`（六项）；规划说明与回复能力事实同步写清"右键会弹上下文菜单、必须按新快照点菜单项" |
| `src/infrastructure/action/adapters/desktop-control-worker.py` | `ACTION_WHITELIST` 加 `right_click`；派发 `desktop.click((x,y), button='right', clicks=1)`；**读回不用 `window` 过滤**（菜单是另一个顶层窗口） |
| `src/infrastructure/action/adapters/desktop-control.ts` | `right_click` 走同一条控件核对链（window / index / name 三者都要） |
| `scripts/desktop-control/worker-actions-verify.py` | 新增四条正控（右键按键、读回不过滤、守卫不变、干跑不动手）；**原负控从 `right_click` 换成 `scroll`** |
| `scripts/desktop-control/reply-chain.ts` | 同一处夹具换成 `scroll`（它原本拿 `right_click` 当"非法动作"） |
| `scripts/desktop-control/verify-desktop-control.ts` | 新增 `right_click` 正控与两条不合法参数负控；模型契约词表加 `right_click` |

⚠️ **负控换值不是放宽判据**：`right_click` 现在**合法**，继续拿它当"非法动作"会变成一条永远不响的假断言。非法动作仍然必须在**拉起进程之前**以 `validation_failed` 被拒（`scroll` 那一档还在，标记文件没被写）。

## 二、读数

- **离线门**（`node --import tsx scripts/desktop-control/verify-desktop-control.ts --evidence --label=right-click`）：
  **判据 68 条 · 未运行 0 · 未通过 2 · measuredInputs=93**（改动前 65 条 / 2 未通过）。
  ⚠️ 两句必须分列：`right_click` 相关的**新增判据全部 PASS**（含 TS↔worker 闭集逐字一致）；
  两条未通过是**既存**的、与本批无关 —— `dc-audit` 与 `dc-measurement-three-stage`，
  同一根因：`browser.mcp 的参数白名单里有通用执行入口：tool`（全局 `generic_bypass_arg` 检测器命中**浏览器**能力）。
  证据：`artifacts/post-lv2/desktop-control/right-click-20261009T144810-524ddad2-acd7/offline.json`。
- **`pnpm typecheck` EXIT 0**。
- **实机只读实测**（生产 venv + 生产 worker，全程无动作）：`state` 2.72s / 3.02s（import 1.28s + 快照 1.02–1.25s）·
  `apps?query=edge` 3.73s（唯一一条 `microsoft edge`）· `apps`（全量）4.01s / 120 条（有界，`truncated=true`）·
  `launch_app` 干跑 3.63s（`guardChain=passed`）。⇒ **"打开窗口"这个动作本身没有慢到会超时**（预算 inspect 20s / action 30s）。
  原始读数在 `artifacts/post-lv2/local/desktop-rightclick-timeout-20261009/`。
- **实机只读门**（`--evidence --label=probe-right-click`）：**14 条 · 未运行 0 · 未通过 1**。
  唯一未通过的是 `dc-probe-dry-run-positive`，读数为 `codes:["no_foreground_element","no_foreground_element","no_foreground_element"]`。
  **归因（同一分钟实测）**：那一刻前台窗口是 **FarCry®6**，游戏窗口的 UIA 元素 **0 个**，上游枚举到的 36 个元素**全部属于任务栏**
  ⇒ 这条判据要求"前台窗口里有一个真实控件"，条件不成立。该判据在 19:58 那次是 **PASS**。
  这不是本改动引起的（它只读 `state`，用的动作是未改动的 `click`；`no_foreground_element` 在任何调用之前就判定了）。
  证据：`artifacts/post-lv2/desktop-control/probe-right-click-20261009T145318-524ddad2-dda6/probe.json`。
  想要 14/14：让一个普通窗口（Edge / VS Code）在前台时重跑 `pnpm desktop-control:probe`。

## 三、未做 / 未证明

- **真实右键没有在用户桌面上按过**：那需要有人在场（`pnpm desktop-control:act --i-am-here`），而当时前台是全屏游戏。
  本次只证到"worker 会把右键交给上游 `uia.RightClick`"这一层（替换 OS/UIA 端口的 4 条正控 + 上游源码 `button="right"` ⇒ `RightClick`）。
- **自然聊天首用 = NOT OBSERVED**：新逻辑要**重启核心**才生效。
- **没有**新增快捷键 / 滚动 / 拖拽 / 剪贴板 / 命令入口；两个开关、任务级 R2、干跑与隐私边界一字不变。

## 四、顺带查清的两件事（这才是她那轮真正卡住的地方）

**① 回收站不在她能启动的目录里 —— 实测。**

`launch_app` 只接受 `desktop.inspect.apps` 交出来的名字；那个目录来自上游 `get_apps_from_start_menu()`
（`Get-StartApps` → 开始菜单快捷方式扫描 → `shell:AppsFolder` 显示名），是**应用**目录，不含 shell 文件夹。

```text
query='回收'    ⇒ appsListed=0
query='recycle' ⇒ appsListed=0
query='bin'     ⇒ appsListed=0
query='垃圾桶'  ⇒ appsListed=0
```

（过滤发生在 120 条上限**之前**，所以这不是"被截断没看到"。）⇒ 她**无法**打开回收站窗口，"看里面有没有清空按钮"这一步从起点就走不通。
这是一个**能力缺口**，不是她的措辞问题，也不是本轮右键改动能解决的。可选修法（需用户裁定，见下）。

**② 前台是全屏游戏时，她几乎什么都看不到。**

上游只枚举**前台窗口**的可交互元素（`L-DC-13`）：前台是 FarCry®6 时，36 个元素**全在任务栏**，目标窗口里的元素一个都读不到。
叠加 `L-DC-03`（无视觉、自绘画布读不到）。⇒ 全屏游戏在前台时，桌面操控这一档实际上不可用。

**③ 她原话里的"卡在超时上"** 与以上两条相容：`desktop.inspect.apps` 查回收站得 0 条 → 重新规划 → 计划预算只有 **6 次规划**
（`task-budget=…/6规划`）→ 一轮里五六次模型调用 + 每次子进程 3–4s，很容易顶到皮套桥的单轮上限 **180s**
（`scripts/postlv2_vtuber_runtime.py:462` 的 `asyncio.wait_for(future, timeout=180)`）。
19:10 那次同型失败留下的读数是 `停止=budget_plans · 规划失败=task_plan_step_operation_unknown`。
**这一条是推断，不是读数**：当轮的核心日志没有被留存（用户手起的核心输出只在那个控制台窗口里），要坐实需要用她的原话+当场日志对一次。

## 五、追加（用户裁定）：有界 shell 文件夹闭集 —— 回收站现在她打得开了

用户就上面的 `L-DC-14` 明确选择「给 launch_app 加一个有限的 shell 文件夹闭集（回收站 / 此电脑 / 控制面板）」。

设计见 [ADR-128](../adr/ADR-128-desktop-shell-folders.md)。落地：

| 位置 | 改动 |
| --- | --- |
| `src/kernel/action/desktop-capability.ts` | 新增程序常量表 `DESKTOP_SHELL_FOLDERS`（三个文件夹 + 中英别名 + 目标）；`apps`／`launch_app` 的规划说明与能力事实同步写明"也在目录里、按名字打开、不得自己拼路径" |
| `src/infrastructure/action/adapters/desktop-control-worker.py` | 同表 `SHELL_FOLDERS`；`resolve_application` → `resolve_launch_target`（先查常量表、再查应用目录，返回 `(显示名, 目标, 类别)`）；`apps` 分两段列、两段都参与 `query` 过滤；新增 `shellFolders` 字段 |
| `src/infrastructure/action/adapters/desktop-control.ts` | `apps` 的当轮内容事实改为"应用目录与三个系统文件夹" |
| 门（两处） | TS↔worker **表与目标逐字一致**；协议/事实必须列出三个名字且写明"不要自己拼路径 / CLSID / shell: 命令"；适配器 2 条注入负控；worker 5 条注入负控 + 干跑负控 + 目录过滤正控 |

**为什么这样划**：回收站这类**不是应用**（不在 `Get-StartApps` / 开始菜单扫描 / `shell:AppsFolder` 里），
所以"目录里看不到 ⇒ 只能猜"是死路；而"让她自己拼 `shell:` 命令"会打开一条通用 shell 通道。
⇒ 取中间：**程序常量表**给三个具名目标，模型只贡献一个**名字**，目标永不出自模型。

**读数**（`--evidence --label=shell-folders`）：离线门 **72 条 · 未运行 0 · 未通过 2**（仍是那两条既存 `browser.mcp` 的 `tool`）·
`pnpm typecheck` **EXIT 0** · worker 单测 **26 项全 OK**（新增 4 项）·
新增四条第落地判据全 PASS（`dc-shell-folder-parity` · `dc-shell-folder-contract` ·
`dc-invalid-launch_app-{"name":"shell:RecycleBinFolder"}` · `dc-invalid-launch_app-{"name":"::{645FF040-…}"}`）。
证据：`artifacts/post-lv2/desktop-control/shell-folders-20261009T154711-e2ea2b85-25ef/offline.json`。

**只读实测（不开窗口）**：三个 shell 路径在本机 `Shell.Application.NameSpace()` 均解析成功
（`Recycle Bin` / `This PC` / `All Control Panel Items`），而不存在的路径返回 `null`（负控成立）。
**改完之后再用生产 worker 只读跑一遍 `apps`**：`appsListed=120` · `shellFolders=回收站 / 此电脑 / 控制面板`，
给模型看的文本末尾多出「系统文件夹（同样按名字启动；它们不是应用）：回收站 / 此电脑 / 控制面板」；
`query=回收` ⇒ `shellFolders=回收站`。**⇒ "她现在查目录能看到回收站"是读数，不是设计意图。**

**没做 / 不主张**：
- **"窗口真的出现了"没有读数**：本轮只证到"目标会以我们给的常量提交给 `os.startfile`"（OS 端口被替换的 26 项单测）。
  真的开一次是**人在场**的动作；用户本轮明确选择"先不试，只把核心重启用起来"。
  ⚠️ 机制上的旁证只有一条：既有代码早就在用同一个机制提交 `shell:AppsFolder\<AppID>` 并真的开出了窗口（21:37 那次）。
- **不主张通用 shell 通道**：闭集只有这三个；第四个要再一次显式裁定。
- 一处**没顺手改**的小漂移：`desktop.operate` 的能力版本字符串仍是 `@2`（本轮两次扩动作集都没升版，
  ADR-126 也没升）。它不是判据（全仓库没有断言读它），登记在此，避免下次误以为"版本没变就没改过"。
