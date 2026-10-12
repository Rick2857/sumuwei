# ADR-127：补接桌面右键（`right_click`）

状态：ACCEPTED / IMPLEMENTED / 离线门读数在案。生产核心**重启后**才生效；自然聊天首用 **NOT OBSERVED**；真实右键**未在用户桌面上按过**（需人在场）。
日期：2026-10-09。
授权：用户就直接要求「她无法使用右键」在本会话显式选择「现在就补 right_click」。

这是 ADR-106 `D01`/`D11` 与 [ADR-126](ADR-126-desktop-double-click-switch-launch.md) 的具名扩展；两份原文档与历史验收读数一字未改。

- `desktop.operate.act` 的动作闭集增加 `right_click`（现在六项：`click` / `right_click` / `double_click` / `type` / `switch_app` / `launch_app`）。
- `right_click` 与单击走**同一条**核对链（索引 → 控件名 → 所属窗口 → 前台窗口），任何一条不成立照旧失败关闭；通过的调用固定为上游 `Desktop.click(..., button='right', clicks=1)`。
- **它的读回刻意不过滤 `window`**：右键弹出的上下文菜单是**另一个顶层窗口**，菜单项不属于右键前那个窗口。⇒ 交回去的始终是**整个桌面的新快照**（与 `double_click` 同规），点菜单项必须用那份新快照里的窗口名与 index；右键之前那份快照里的控件引用**全部作废**。
- 密码字段仍然一律 `not_actionable`（右键会给出"粘贴"一类入口，不接受）。
- 其余边界**一字不变**：任务级 R2、两个开关（代码缺省仍 false）、闭集在两处（TS 常量 ↔ worker `ACTION_WHITELIST`）、干跑不动手、正文不进证据、失败详情不放桌面文字。
- 原"未登记动作"的负控从 `right_click` 换成 `scroll`（前者现在**合法**，再拿它当负控会变成一条永远不响的假断言）。这不是放宽判据：非法动作仍然必须以 `validation_failed` 在**拉起进程之前**被拒。
- 仍然**没有**：快捷键 / 滚动 / 拖拽 / 剪贴板 / 命令入口。

⚠️ 本扩展**不**解决"打不开回收站"：`launch_app` 只认 `desktop.inspect.apps` 交出来的名字，而那个目录来自上游 `Get-StartApps`／开始菜单扫描／`shell:AppsFolder` 显示名，**不含**回收站、此电脑、控制面板这类 shell 文件夹（实测 `query=回收` / `recycle` / `bin` 都是 0 条）。见 `L-DC-14`。

实现与读数见 [Desktop-Control-Right-Click-2026-10-09.md](../post-lv2/Desktop-Control-Right-Click-2026-10-09.md)。
