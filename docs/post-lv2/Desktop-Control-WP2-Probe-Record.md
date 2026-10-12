# 桌面控制 WP2：实机探针记录（2026-10-05）

> 载体：[`ADR-106`](../adr/ADR-106-desktop-control.md) · 计划 [`Desktop-Control-Execution-Plan-2026-10-05.md`](Desktop-Control-Execution-Plan-2026-10-05.md)
> 证据（进仓库，只有计数与布尔）：`artifacts/post-lv2/desktop-control/<runId>/probe.json`
> 原始正文（**不进仓库**）：`artifacts/post-lv2/local/desktop-control/<runId>/desktop-state-raw.txt`

---

## 1. 这一档要回答什么

```text
① 中文 Windows 上，UI Automation 到底读不读得到"窗口 + 控件 + 中文名字"？
② 读一次要多久、有多大、会不会出站？
③ 该不动手的时候，它**真的**不动手吗？
```

---

## 2. 读数（`pnpm desktop-control:probe`，**14 条判据 · 0 未运行 · 0 未通过**）

| 读数 | 值 |
|---|---|
| 运行时 | `windows-mcp 0.8.7`（独立 venv，版本闸通过） |
| 一次完整读取（含 Python import） | **≈2.3s**（冷启动首次约 3.4s） |
| 返回文本 | 7 个窗口 · 77 个可交互元素 · 原始 5062 字符 ⇒ 取 4001 字符（**上限处截断，范围如实标出**） |
| 中文 | **读得到**（中文控件名与窗口名都在） |
| 网络 | worker 自报 `networkAttempts = 0` |
| 截图 | 无（`use_vision=False` 恒） |

### 2.1 失败关闭的四条负控（**都不动手**）

```text
window_not_found   窗口不存在                      ⇒ 内核 target_not_found
stale_reference    索引在合法区间但这次不存在       ⇒ 内核 target_not_found
stale_reference    同一个索引现在叫别的名字         ⇒ 内核 target_not_found
focus_changed      控件真实存在、但窗口不在前台     ⇒ 内核 target_uncertain
runtime_mismatch   期望版本改成 0.0.1              ⇒ 内核 unsupported
```

### 2.2 正控（**干跑**）：`dryRun=true` 让"会做"与"做了"分开

前台窗口里拿一个**真实**控件走完整条核对链 ⇒ `ok=true` · `dryRun=true` ·
`guardChain=passed` · **`performed` 字段不存在**。

> 这一条是本门最要害的断言：它同时证明（a）合法目标确实会被放行，
> （b）本门**没有**动用户的东西。

---

## 3. ⚠️ 事故记录（如实写，不回写）

**本门的第一版在用户浏览器里真的点了一次。**

```text
时间：2026-10-05（本轮 WP2 门槛搭建期间）
现象：`dc-probe-neg-focus-changed` 返回 ok=true，effect 写着
      "桌面动作 click：按钮「新建标签页」@764,31" ⇒ 用户在 Edge 里多开了一个标签页。
```

### 3.1 根因（两层，都是**量具**的问题，不是产品的问题）

```text
① 判据侧：第一版从**渲染后的文本**里正则抽窗口名（`｜窗口「(.*?)」`），
   而那个窗口名里本身含「」⇒ 抽出来的是**被截断的前缀**。
   于是"拿前缀和前台窗口全名比"必然不等 ⇒ 误以为它是后台窗口。
② 结构侧：worker 的 `focus_changed` 判据是**子串**匹配（`requested in active.name`），
   那个前缀**确实**是前台窗口标题的前缀 ⇒ 核对链如实放行。
   ⇒ 产品判据没错；错的是"我拿一个文本前缀当成一个窗口引用"。
```

### 3.2 修法（两条，都是结构性的）

```text
① 本门改成**直接驱动 worker 的结构化快照**（不再从文本反推）：
   `element.window` 与 `activeWindow.name` 逐字比对；"不在前台"是**比出来的**。
② 新增 `dryRun`（干跑）档：核对链**全部跑完**，但**不做动作**；
   本门所有负控与正控**一律**带 `dryRun: true` ⇒ 即使核对链意外放行，
   也不可能有任何动作（"两把锁"而不是"一把锁 + 一句承诺"）。
   ⚠️ `dryRun` **不在** `TASK_ARG_KEYS` 里 ⇒ 模型给不出这个字段（只有程序能给）。
```

### 3.3 这条事故说明了什么（登记为教训）

```text
· "只读门"这个**名字**不是保证；保证必须是"结构上做不到"（干跑 + 不接动作路径）。
· 从**渲染后的文本**反推结构化事实，是本仓库已经踩过的同一类坑
  （§6.9：数字对 ≠ 数字描述的是你以为的那个东西）。
· 事故的代价是用户浏览器里多一个标签页 —— 已如实告知用户；
  **没有**做任何"自动回滚"（不去动用户的浏览器）。
```

---

## 4. 同时发现的一处**产品**缺陷（夹具是绿的，真机读数才暴露）

```text
现象：真机读数里 `scope.totalChars = 4001`、`includedChars = 4001`、`truncated = false`
      —— 而这份文本**其实被裁过**（上限 4000 + 省略号）。
根因：worker 先把文本裁到上限，适配器再拿"裁过的那一段"去判"有没有超上限"
      ⇒ `truncated` **永远**是 false（"我说这是全文"而其实不是）。
为什么离线门没照到：夹具 worker 不预裁剪 ⇒ 那一档永远是绿的。
修法：worker 如实回传 `textCharsBeforeClip` / `textClipped`，适配器据此算范围；
      并在离线门里补**两档**夹具（报了的 / 没报的）——43 条判据里的
      `dc-worker-reported-clip` 与 `dc-silent-clip-still-marked`。
```

> 这正是本仓库 `INV-M45-06` 的老话：**量具自己也要被验证**。
> 同一件事在别处也成立：离线门测的是适配器；worker 的判定链只有**实机门**能测。

---

## 5. 本记录**不**主张什么

```text
① 不主张"所有界面都读得到"：只在一台机器、一个时刻上读过。
② 不主张"真实操作能成功"：本门**没有**真点击/真输入（那是 `desktop-control:act`）。
③ 不主张"焦点冲突不会发生"：只主张"目标窗口不在前台时**不动手**"。
```
