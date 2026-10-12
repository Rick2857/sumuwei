# 桌面调用协议与能力自述修复（2026-10-09）

> 本文保留协议修复完成时的读数。后续动作扩展见[动作扩展记录](Desktop-Control-Actions-Extension-2026-10-09.md)，真实验收与最新停机状态见[启动记录](Desktop-Control-Actions-Activation-2026-10-09.md)；下文“只有单击与输入”“尚未重启”属于本次协议修复的历史时点。

状态：**代码已修；生产进程尚未重启加载；完整真实操作验收仍为 PARTIAL**。

## 真实发现

当前共存进程启用了 `desktop-inspect`、`desktop-operate`、`task-autonomy` 和 `tool-decision-mode(role)`。
19:10 的原话「那能不能通过桌面操控打开一下edge浏览器」实际进入了任务环：

```text
desktop.inspect.state=success
desktop.operate.act=rejected/validation_failed
desktop.inspect.state=success
desktop.inspect.state=success
desktop.inspect.state=not_found/target_not_found
停止=budget_plans，规划失败=task_plan_step_operation_unknown
trace=trc:52c4bdd0-a089-48f9-8ecd-ff490657dbc3
```

随后回复却说「桌面操控那一层我够不着，点图标、起程序这种事我做不了」。这与已发生的桌面查看及已启用的点击能力不一致。
原始本地日志：`artifacts/post-lv2/local/reminder-channel-activation-20261009/start.log`。
仅凭当前日志不能还原那次参数校验失败的具体缺项或取值；没有打开正在运行的真实库追查参数。

## 修复

1. 后续规划器的 operation 说明漏了桌面两项。新增决策器与规划器共用的说明，取值直接来自既有常量：`desktop.inspect=state`、`desktop.operate=act`；说明 `action` 闭集与 `window/index/name` 的实际引用要求。
2. 原来的工具目录仅给私有决策调用，最终回复缺少当前桌面能力状态。现在由装配根传入真实开关及运行时读数，回复获得不可裁剪的 `desktop-capabilities` 事实块；无动作轮同样适用，全关时不产生该块。
3. 明确区分任务失败与能力不可用，也区分无独立启动动作与通过已观察到的前台启动按钮打开程序。没有扩展动作、权限、前台规则或工作器协议。

当前依然只有左键单击与输入。若前台启动器已出现 Edge 按钮，可以提出一次受控点击；需要切换前台、双击、右键或快捷键时，仍不能保证完成。这次修复不证明从任意界面启动 Edge 已可用。

## 验证与边界

- 新增协议回归在修复前分别使规划器、决策器断言 FAIL；修复后通过。
- 桌面专项门：**51/51 PASS**，包括真 `src/main.ts`、新建隔离库、模拟模型/桌面工作器的无动作轮、操作拒绝轮、关闭回滚轮与有序关库。
- 操作拒绝轮故意保留上一轮错误的「只有浏览器」自述，核对新轮仍收到独立的程序能力事实和真实失败结果。此项验证接线，不把模拟回复当语义证据。
- `typecheck`、`m3.5:test`、`eval:scenarios`、`eval:dryrun`、`eval:providers`、`m4:test`、M4.5 四项动作门、`m5.1:measurement:verify`、角色工具 path/matrix、工具编排门均 EXIT 0。
- `postlv2:role-tool:verify` **FAIL**：其现有夹具登记表缺少 `local.reminder.message`，导致 3 条目录漂移断言失败。本批没有修改该门或提醒实现。
- 真模型检查使用测试端点，对隔离入口的实际回复消息与合成前台启动按钮进行回放；它验证表述与计划，不执行真实点击。初期 1600 输出 token 档出现过空回复，该次不计为通过。最终读数保存在本地证据目录。
- 最终针对同一失败轮的回复回放已明确承认「能看，也能点」，并说明当前没有 Edge 入口；规划器对合成前台 `Microsoft Edge` 按钮给出合法的 `act/click` 计划。最终样本：`semantic-1791545568140.json`（测试端点，2 次真实模型调用）；这不是成功率评测，也不是生产点击证据。
- `m4.5:ci` / `m4.5:ci:full` **NOT RUN**：当前真实核心持库，完整链含生产源复制，依据 `AGENTS.md` §5.1 留到静止源窗口。
- 运行中的 QQ/皮套核心、生产配置与真实库没有被本轮重启或修改。新逻辑需要有序重启后才能正式生效；之后仍需真实首用与操作读回证据。

本地检查日志与真模型样本：`artifacts/post-lv2/local/desktop-protocol-repair-20261009/`。
最终专项证据：`artifacts/post-lv2/desktop-control/offline-20261009T113249-669b1acd-ea57/offline.json`。
已有 `artifacts/m4.5/` 和量具证据在检查前按路径保存，运行后恢复原字节；本次结果另存本地目录。
