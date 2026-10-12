# 苏沐薇网页读取与浏览器操作实测（2026-10-06）

用户要求运行检查。结论：**生产适配器在真实浏览器上的基本操作通过；公开 HTTPS 正文读取有成功读数；整体动作冒烟仍 FAIL。**

本次启动使用 LG 的 `createBrowserSidecarSupervisor`，操作使用 `createBrowserAdapter`，不是假 sidecar。开始时 8931 未监听；监管器成功启动固定版本 sidecar，扩展已连接。首个快照读到的是扩展连接页，因此没有据此宣称登录态继承通过。

在新建的临时标签里打开本地测试页，按每次真实快照返回的元素引用执行操作。输入 `LG-live-4711`，选择 Beta，点击确认后读回页面生成的 `CONFIRMED:LG-live-4711:b`；最后切回原活动标签。基本检查 8/8：列出标签、新建标签、导航与读取、输入与读回、选择与读回、点击与读回、等待、恢复原活动标签。临时测试标签保留；测试服务器及本次启动的 sidecar 已关闭，正常启动 LG 会按既有配置自动启动桥接。

## 发现并修复的缺陷

真实 `browser_type` 报错：`Invalid input: expected string, received undefined → at target`。

从正在运行的 sidecar 的 `tools/list` 读取到：`browser_type`、`browser_click`、`browser_select_option` 都要求参数 `target`。LG 原来的映射传 `ref`，是假 sidecar 接受了这个错误参数，导致原离线测试漏报。

修复仅涉及：

- `src/kernel/action/browser-operations.ts`：三个操作把 LG 内部快照 `ref` 映射成上游 `target`。LG 对模型暴露的参数和工具白名单不变。
- `scripts/productivity-skills/browser-fixture.ts`：要求上游 `target`，拒绝错误参数 `ref`，并按 `target` 查找元素。

先加强夹具，再运行原映射：`browser-02` 失败，12 组中 10 PASS / 1 FAIL / 1 NOT RUN。修复映射后恢复为 11 PASS / 0 FAIL / 1 NOT RUN；`browser-04` 的登录态与桌面影响验收仍 NOT RUN，整体定向聚合仍 NOT PASS。真实浏览器复测基本操作 8/8。

## 网页读取与回归

| 检查 | 当前实测 |
|---|---|
| 真实公开 HTTPS 正文读取 | `https://example.com/` 成功提取 156 字符，并核对正文中的指定句子 |
| Python 官网正文读取 | FAIL：`https://www.python.org/about/` 返回 gzip，当前 `web.read` 只处理未压缩响应；未扩展读取器 |
| `pnpm typecheck` | EXIT 0 |
| `pnpm m5.1:measurement:verify` | 16/16，EXIT 0 |
| `pnpm m4.5:ci` | EXIT 0（从完整命令的原始日志分离离线段；`ci && smoke` 已进入 smoke，证明前段退出码为 0） |
| `pnpm with-test-model pnpm m4.5:ci:full` | EXIT 1；本轮 Production-copy Live Smoke **43 PASS / 7 FAIL** |
| 既有 `m4.5:gates`、`m5.1:gates`、`m5.1:regression:verify` | EXIT 0；使用继承证据，**不覆盖本轮新出的 43/7 FAIL** |

冒烟失败项：S4.1、S5.1、S5.3、S6.1、S6.1b、S6b.1、S9.1。S5 期待拒绝读取 `C:\Windows\win.ini`，但当前 `CHARACTER_LOCAL_FILE_READ_ENABLED=true`，冒烟继承该配置，实际读取成功；其余失败涉及模糊目标或失败场景未产生原用例期待的动作终态。**未修改冻结预期、权限或角色决策来凑通过。**

测试使用既有隔离库与生产库副本。运行前保存了历史证据；新读数独立归档后，10 个被回归重写的历史文件已逐个恢复到运行前字节，并核对摘要相同。原本已修改的文件保留其运行前内容。

## 证据与未验收范围

机器证据：[`result.json`](../../artifacts/post-lv2/browser-live-check-20261006/result.json)，包含真实失败→修复后读回、已安装工具 schema、公开网页成功/失败、源指纹、本轮动作冒烟原始结果。回归改写的证据新版本另存于同目录 `evidence/`。原始日志与临时探针保存在已忽略的 `artifacts/post-lv2/local/browser-live-check-20261006/`。

本次不构成登录态继承、桌面焦点影响、全部用户标签保留或真模型自然语言浏览器任务的验收。基本操作已验证与这些未验收项分别记录。重启 LG 后会加载修复后的映射。
