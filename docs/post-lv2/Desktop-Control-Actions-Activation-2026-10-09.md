# 桌面动作真实验收与生产启动记录（2026-10-09）

五类桌面动作已取得真实适配器执行与效果证据。生产共存实例已验证就绪；当前按用户最新要求 **保持停机，等待用户手动启动**。设计见 [ADR-126](../adr/ADR-126-desktop-double-click-switch-launch.md)，此前实现与离线结果见[动作扩展记录](Desktop-Control-Actions-Extension-2026-10-09.md)。

授权顺序：用户「执行真实桌面动作验收和生产激活」；最终实例的启动指令发出后，收到「不用你启动我待会自己手动启动」，随后立即有序停机，不再启动。

## 真实动作与独立效果

使用真实 `createDesktopAdapters`、产品 Python worker 与固定 Windows-MCP 0.8.7，所有六次动作均非 dry-run、非模拟 worker。测试输入只进入本次自建 WinForms 夹具；动作测试脚本没有打开数据库。这里验证真实适配器与 OS 效果，任务计划、权限与回复接线沿用此前隔离入口证据，不冒充自然聊天首用。

| 动作 | 实际读回 | 判定 |
| --- | --- | --- |
| `click` | 夹具 MouseClick 计数 0 → 1 | PASS |
| `type` | 哨兵从无到有，字符数 10 → 20；焦点点击计数 1 → 2 | PASS |
| `double_click` | MouseDoubleClick 计数 0 → 1 | PASS |
| `launch_app` | 按系统目录精确名称 `microsoft edge` 提交；独立窗口枚举从 1 个 Edge 窗口到 2 个，新增 HWND 13829154 | PASS，实际新窗口已出现 |
| `switch_app`，到 Edge | 精确标题和句柄核对；OS 前台 HWND 匹配，夹具失焦 | PASS |
| `switch_app`，回夹具 | OS 前台 HWND 匹配，夹具重新获得前台 | PASS |

启动记录器最初错误地以“Edge 成为前台”判断启动成功，因此原 `launch-edge.passed=false` 保留。启动操作本身只承诺提交，不承诺抢前台。后续 `sky.list_windows` 独立枚举得到新 Edge 窗口，随后真实切窗验证精确句柄；没有重复启动来改写原结果。其余五次调用的原记录均 PASS。

夹具已通过自己的停止哨兵退出。用户原有 Edge 窗口保留，新增空白 Edge 窗口也保留；未导航网页。worker 的零网络计数不表示 Edge 应用本身不联网。

## 依赖异常与首次停止失败

此前完整回归的源码副本把 `node_modules` 链接到工作区。副本内 pnpm 改写依赖链接后，工作区 pnpm 包装器尝试重建依赖并报权限错误，随后直接 TSX 启动缺包。这是本次源码隔离方式造成的依赖问题，不能计作正常验收。

已移除源码副本上的目录链接本身，将损坏依赖目录移入本次本地证据目录，执行 `pnpm install --offline --frozen-lockfile --ignore-scripts`，EXIT 0；随后直接 Node 类型检查 EXIT 0。未修改锁定版本。原目录和失败日志保留。

旧核心 PID 22340 通过停止哨兵退出码 0，但 owner 记录为 `cleanClose=false`，且没有 post-close 快照。这一关闭失败保留；其具体原因尚未证明，不能只凭依赖异常认定关库根因。没有改写 owner、PID/WAL 或恢复数据库来消除告警。闭库后通过既有租约与快照程序取得 verified snapshot，健康检查只打开一次性副本。后续两次正常关闭不回写该次失败，也不关闭 `AUD-ISO-01`。

## 生产启动与最终停止

| 周期 | 核心 PID | 就绪 | 关闭 |
| --- | --- | --- | --- |
| 验证周期 | 56584 | `COEXIST_READY`、`onebot_owner_private_ready`、`LG_AVATAR_READY`；`/lg/status` 为 production，核心存活 | EXIT 0，`cleanClose=true`，post-close verified snapshot，RELEASED |
| 最终周期 | 39036 | 同样三个 READY | 收到用户手动启动要求后停止；EXIT 0，`cleanClose=true`，post-close verified snapshot，RELEASED |

两个周期都完整经过 `IDLE → LEASED → PREOPEN_SNAPSHOT_VERIFIED → DB_OPEN → SERVICES_STOPPED → DB_CLOSED_VERIFIED → POSTCLOSE_SNAPSHOT_VERIFIED → RELEASED`。核心源码、桌面登记、规划器、决策器、适配器、worker、package 与锁文件共 10 份 SHA-256 在启动取证与最终交付时一致。生产实例从当前工作区加载；没有另外注入生产聊天来测新增动作。

共存编排者退出后，avatar 的 Python 子进程仍持有 12394。本次逐一核对控制台成员，只对已确认的 avatar Python 与其启动器发送原生控制台 Ctrl+C，等待正常退出。最终 supervisor 16532、core 39036、avatar 51952 及启动器 51012 均退出，6751/6752/6753/12394 全部无监听。没有强杀共享核心。

桌面查看/操作、role 决策与 task autonomy 原已开启，本轮没有新增权限开关。`.env` 逐字比较确认只有快照目录从 `./data/snapshots/reminder-channel-activation-20261009` 改为 `./data/snapshots/desktop-actions-activation-20261009`，避免本次自动保留窗口剪掉旧批次快照。新目录五份快照低于自动保留 10 份，手动快照 `keep=30`，均未触发删除。没有数据库迁移或恢复。

关键快照：

- 闭库取证：`2026-10-09T13-45-54-398Z-a9a706bcfb91`。
- 验证周期 post-close：`2026-10-09T13-49-16-328Z-ab020ca719fe`。
- 最终 post-close：`2026-10-09T13-51-40-104Z-c179f9f82b6f`；owner 于 `2026-10-09T13:51:44.697Z` 记录 `cleanClose=true`。

## 手动启动与证据位置

在项目目录 PowerShell 中，用户准备好后手动执行：

```powershell
$env:PROJECT_LG_COEXIST_ACTIVATE = 'coexist@C:\Users\user\Desktop\project LG\data\pglite'
node --import tsx scripts/coexist/supervise.ts --start
```

有序停止可在另一项目终端执行 `node scripts/coexist/stop.mjs`，并检查核心关闭读数和端口释放。以上为交接命令，本次交付不再启动实例。

公开机器摘要：[`acceptance.json`](../../artifacts/post-lv2/desktop-control/real-actions-20261009/acceptance.json)，仅保留事件计数、状态、句柄、源文件指纹与必要配置。完整本地日志、原失败、夹具和私有桌面读数在 `artifacts/post-lv2/local/desktop-actions-activation-20261009/`，不进入仓库。

分列结论：真实适配器动作加效果读回 **PASS（五类、六次）**；生产启动就绪 **VALIDATED**；当前运行状态 **STOPPED / READY FOR MANUAL START**；新增动作自然聊天首用 **NOT OBSERVED**。单机受控验收不外推为任意应用兼容或长期成功率。
