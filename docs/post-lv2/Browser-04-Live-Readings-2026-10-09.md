# browser-04 真机读数（2026-10-09）

`browser-04` 组的三条判据：**登录态继承 · 焦点影响 · 用户标签保留**。
它作为**门**仍是 `NOT RUN`（那三条都不可能在无人值守的离线下判定）；本文是**人工触发的一次真机实测**，
载体对齐 [`Productivity-Skills-Browser-First-Connect.md`](./Productivity-Skills-Browser-First-Connect.md) §8。

## 方法（可复现）

```text
被测对象   生产 sidecar（`--extension --port 8931 --browser chrome --caps …`）+ 官方扩展
           + 用户**真实** Chrome profile（`Default`，扩展 0.4.0_0）
会话       MCP over HTTP：initialize（clientInfo = browser-04 / browser-04-focus）
           → notifications/initialized → tools/call
工具调用   **只有** browser_tabs{list} / browser_navigate / browser_snapshot
           （没有任何 close 类调用 —— 可逐条复核）
测量器     ① 前台窗口：user32 `GetForegroundWindow` + `GetWindowText` + 进程名（400ms 采样 88 秒、
              另一次 150ms 采样 ~14 秒）
           ② Chrome 标签：UI Automation（`Chrome_WidgetWin_1` → `ControlType.TabItem`，
              含 `SelectionItemPattern.IsSelected`）
真实库     全程未打开（这条链不碰数据库）
```

## ① 登录态继承 —— **成立**（两条独立证据）

```text
证据 1  navigate → https://github.com/settings/profile
        （该页未登录会被重定向到登录页）
        结果：**停在** /settings/profile · Page Title = "Your profile"
        命中登录标志：Public profile / Profile / Settings
        命中登出标志：**无**（'Sign in to GitHub' / 'Username or email address' 都没出现）
证据 2  navigate → https://github.com/settings/repositories
        结果：导航成功返回（1.2s），该标签标题变成 "Repositories"（窗口标题也随之变化）
        ⇒ 又一个"未登录进不去"的页面
旁证    navigate → https://github.com/ 首页
        登录视图标志：Dashboard / Pull requests / Issues；登出标志（Sign in / Sign up）：**无**
```

**这说明什么**：扩展把**用户真实 profile 的会话（cookie）**用在了这些页面上 —— 即"登录态继承"。
**不说明什么**：LG/我没有**读取**任何 cookie 值（本次没有调用任何 cookie/storage 工具；
LG 的白名单里那些工具存在，但这次一个都没用）。页面正文里出现的账号名等**没有**被复制到任何文档。

## ② 焦点影响 —— **两次里中一次，不能下"必然"的结论**

```text
读数 A（400ms 采样，含用户自己操作）：
  20:50:29.194  发出 initialize（本次第一次建会话）
  20:50:29.667  前台 = chrome | "Welcome - Google Chrome"   ← 0.47 秒后 Chrome 被顶到前台
                （"Welcome" 就是新弹出的 connect 页）
读数 B（150ms 采样，受控：先确认前台=Edge，再建会话 + 只发一次 navigate）：
  20:51:48.237  发起 navigate → https://github.com/settings/repositories（1.2s 返回）
  20:51:44 → 20:51:58 全程前台都是 **msedge（抖音）**，一次都没跳到 Chrome
⇒ 会话创建/动作**可能**抢焦点（A 中 1 次），但**不是必然**（B 中 0 次）。n=2 ⇒ **不是比率**。
```

⚠️ **两个必须写下的混淆项**：
1. 读数 A 期间**用户正在操作这台机器**（同一时间线里出现 `DeepSeek Harness` 窗口与 `explorer`），
   ⇒ 那一次 0.47s 的跳转**可能是用户自己点的**，不能单独作为"扩展抢焦点"的铁证。
2. **本测量没有覆盖 sidecar 启动**那一次（`ADR-101` 的自启动也会弹连接页）。要测它必须停一次服务
   ⇒ 留给下次停机窗口。`L-PS-42/43` 记的"启动时观察到一次"与本文**不矛盾**（量的是不同事件）。

## ③ 用户标签保留 —— **标签没少，但当前选中被切走了 ⇒ PARTIAL**

```text
基线（测量前）    窗口内 5 个标签：GitHub · Playwright Extension Status · Welcome × 3
                  （那 3 个 Welcome 是此前探测留下的 connect 页）
测量后            窗口内 3 个标签：
                    - GitHub                                          ← **用户原来那张，仍在** ✓
                    - GitHub - 属于"Playwright · browser-04"群组        ← 我的第 1 个会话
                    - Repositories - 属于"Playwright · browser-04-focus"群组 ← **当前选中**
两次采样（间隔 3 秒）标签集合逐项一致 ⇒ 稳定读数
```

```text
✅ 没有标签被关闭：用户那张 `GitHub` 一直在。
❌ **当前选中被切走了**：那个窗口的标题现在是 "Repositories"，选中的是**代理的标签**
   ⇒ "动作前后确认你打开的其它标签没被切走"这一条 **不成立**（PARTIAL）。
⚠️ 一个我**不能归因**的变化：`Playwright Extension Status` 与 3 个 `Welcome` 在测量期间消失。
   我本次发出的调用只有 `browser_tabs{list}` / `browser_navigate` / `browser_snapshot`
   —— **没有任何 close 类调用**，所以不是我的调用关的；但我也**不能证明**是谁关的
   （候选：用户自己关的 / 扩展回收了已结束会话的 connect 页）。⇒ 如实记为"未归因"。
```

**顺带证实了一条结构性事实**（对应 `L-PS-54`）：**每个 MCP 会话各自一个标签组**
（两个会话 → 两个 `属于…群组` 的标签，组名就是 clientInfo.clientName）。

## 三条判据的读数汇总

| 判据 | 读数 | 依据 |
|---|---|---|
| ① 登录态继承 | **成立** | 两个"未登录进不去"的页面都进去了 + 首页是登录视图 |
| ② 焦点影响 | **不确定（1/2 观察到）** | 400ms 时间线抓到 1 次 0.47s 的跳转；受控复测 0 次；有用户操作干扰 |
| ③ 用户标签保留 | **PARTIAL** | 标签没少 ✓，但当前选中被切到代理的标签 ✗ |

⚠️ **这不是"browser-04 = PASS"**：门本身仍是 `NOT RUN`（它需要人 + 真登录态，无法无人值守判定）。
本文是一次**人工实测的读数**，与仓库里"声明式人审"先例同形：读数入档，不冒充机械判据。

## 隐私边界（本测量做了什么、没做什么）

```text
✓ 读的是页面**正文**（快照）与你那张标签的**标题**；
✗ 没有调用任何 cookie / localStorage / sessionStorage / evaluate 工具；
✗ 没有把页面里的账号名、邮箱、仓库名等写进本文或任何文档（只写"命中了哪个标志"）；
✗ 没有关闭、移动、固定你原有的任何标签（也没有 close 类调用）；
✓ 真实库全程未打开。
```
