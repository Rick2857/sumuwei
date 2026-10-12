# ADR-126：补接桌面双击、窗口切换与应用启动

状态：ACCEPTED / IMPLEMENTED / REAL ACTIONS ACCEPTED。生产启动已验证就绪；按用户最新要求保持停机，等待用户手动启动。新增动作自然聊天首用未观测。
日期：2026-10-09。
授权：用户「那就先补一下相应动作吧」，承接上一轮讨论的双击、切窗口、启动程序。
后续授权：「执行真实桌面动作验收和生产激活」；最新运行约束：「不用你启动我待会自己手动启动」。

这是 ADR-106 D01/D11 的具名扩展，原始冻结文档与历史验收读数保留。

- `desktop.operate.act` 增加 `double_click`、`switch_app`、`launch_app`，原有 `click/type` 保留。
- `double_click` 复用控件索引、名称、窗口、前台核对，调用固定上游 `Desktop.click(..., clicks=2)`。
- `switch_app` 必须带快照里的完整 `window` 与正整数 `handle`。重新核对标题与句柄后，调用上游 `bring_window_to_top(handle)`；读取实际前台 HWND，未匹配则失败。
- 为启动定位补充只读 `desktop.inspect.apps`（可选 `query`），读取上游 `get_apps_from_start_menu()` 的系统目录，有界返回名称。
- `launch_app` 只接受目录中唯一、大小写不敏感精确匹配的完整 `name`。目标路径/AppID 仅从系统目录解析，使用 Windows Shell 的 `os.startfile`，不拼接模型命令，不开放路径、argv 或 cwd。Windows-MCP 的模糊应用匹配不作为 LG 执行依据。
- 所有写动作仍须任务级 R2 和现有桌面权限；默认开关与运行时版本不变。不新增 MCP 服务、通用命令入口或后台自主执行。
- 双击、切窗、启动后读取全局桌面状态；启动结果只证明请求提交，不能仅凭提交成功宣称窗口已经打开。目标应用自身可能联网，worker 的零网络计数不代表目标应用不联网。
- `dryRun: true` 全部目标核对后返回，禁止点击、激活窗口或提交启动。应用目录不暴露启动路径/AppID。

验证与交付记录见 [Desktop-Control-Actions-Extension-2026-10-09.md](../post-lv2/Desktop-Control-Actions-Extension-2026-10-09.md)。后续五类动作、六次真实适配器调用已取得实际效果证据，见[真实验收与启动记录](../post-lv2/Desktop-Control-Actions-Activation-2026-10-09.md)。受控操作验收、生产就绪与自然聊天首用分别记账。

2026-10-09 当日后续：动作闭集又加了一项**右键** `right_click`（第六类，见 [ADR-127](ADR-127-desktop-right-click.md)）；本文与上文的历史读数一字未改。
