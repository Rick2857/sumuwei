# ADR-128：桌面 shell 文件夹闭集（回收站 / 此电脑 / 控制面板）

状态：ACCEPTED / IMPLEMENTED / 离线门读数在案。生产核心**重启后**才生效；"窗口真的出现"的真实读数 **NOT TAKEN**（需人在场，见记录 §5）。
日期：2026-10-09。
授权：用户就「打不开回收站」在本会话显式选择「给 launch_app 加一个有限的 shell 文件夹闭集（回收站 / 此电脑 / 控制面板）」。

这是 ADR-106 `D01`/`D11` 与 [ADR-126](ADR-126-desktop-double-click-switch-launch.md)、[ADR-127](ADR-127-desktop-right-click.md) 的具名扩展；那三份原文档与历史读数一字未改。

- 新增**程序侧的闭集表**（两处同表，门核对逐字一致）：`DESKTOP_SHELL_FOLDERS`（TS）↔ `SHELL_FOLDERS`（worker）——
  回收站 → `shell:RecycleBinFolder`、此电脑 → `shell:MyComputerFolder`、控制面板 → `shell:ControlPanelFolder`；
  每项带中英别名（本机 shell 命名空间标题是英文，而系统显示语言是中文，两个写法都要认）。
- `desktop.inspect.apps` 现在**分成两段**列：应用目录 + 系统文件夹；两者都参与 `query` 过滤。
  理由是既有事实：回收站这类**不是应用**，不在 `Get-StartApps`／开始菜单扫描／`shell:AppsFolder` 显示名里
  （实测 `query=回收` / `recycle` / `bin` / `垃圾桶` 全 **0 条**，且过滤发生在 120 条上限**之前**）——
  她若在目录里看不到它，就只能靠猜，而猜是这条能力明确不许的。
- `launch_app` 的名字解析顺序：**先**查程序常量表（精确匹配、大小写不敏感），**再**查系统应用目录。
- **目标永不来自模型**：提交给 ShellExecute 的字符串只可能来自①本表常量 ②系统目录解析出的 AppID / 快捷方式路径。
  含 `\`、`/`、`:` 的名字（绝对路径、`shell:` 前缀、`::{CLSID}`）在**适配器与 worker 两处**都被拒；
  形如 `{CLSID}`（没有冒号）的名字不匹配任何表项 ⇒ `window_not_found`，且**不提交任何东西**。
  三档负控已成机器判据（适配器 2 条"标记文件没被写" + worker 5 条"`os.startfile` 没被调"）。
- 边界一字不变：任务级 R2、两个开关（代码缺省仍 false）、干跑不动手、正文不进证据、密码字段 `not_actionable`、
  请求提交 ≠ 窗口出现（回复仍必须按读回说明结果）。
- 仍然**没有**：快捷键 / 滚动 / 拖拽 / 剪贴板 / 任意命令；**其它** shell 文件夹（网络、用户目录、打印机…）**明确不在**闭集里。

⚠️ 本扩展**不**主张"她能替代用户操作电脑"：这三个文件夹是一次**逐项裁定**的闭集，不是通用 shell 通道；
加第四个 = 再一次显式改动（表 + worker + 用例 + 负控）。

实现与读数见 [Desktop-Control-Right-Click-2026-10-09.md](../post-lv2/Desktop-Control-Right-Click-2026-10-09.md) §5。
