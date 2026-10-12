# 桌面控制 WP5：门与读数记录（2026-10-05）

> 载体：[`ADR-106`](../adr/ADR-106-desktop-control.md) §4 · 计划 [`Desktop-Control-Execution-Plan-2026-10-05.md`](Desktop-Control-Execution-Plan-2026-10-05.md)
> 证据：`artifacts/post-lv2/desktop-control/<runId>/offline.json`（离线）· `.../probe.json`（实机只读）

---

## 1. 三道门（**分列**，不合成一个总分）

| 门 | 命令 | 它测什么 | 本轮读数 |
|---|---|---|---|
| 离线硬门 | `pnpm desktop-control:verify` | 适配器 + 登记表 + 目录 + 参数闭集（夹具 worker，不 import windows-mcp、不碰 UIA） | **43 条判据 · 未运行 0 · 未通过 0 · overall PASS** |
| 实机只读门 | `pnpm desktop-control:probe` | 真 worker + 真实桌面（**只读**：不点击、不输入、不截图） | **14 条判据 · 未运行 0 · 未通过 0 · overall PASS** |
| 真实操作门 | `pnpm desktop-control:act --i-am-here` | 真操作一次 + 读回（目标 = 本门自建的临时记事本） | **NOT RUN**（需用户在场；门已就绪） |

门表登记：`scripts/gates/manifest.ts` 的 `DESKTOP_CONTROL_GATES` / lane `desktop-control`
（`pnpm gates:run --lane desktop-control` = **PASS 2 · FAIL 0**，墙钟约 24s）。
⚠️ **有意不并入 `offline` lane**（那条 lane 的公开声明是"与 `pnpm m4.5:ci` 逐条等价"）。
⚠️ `desktop-control:act` **不登记**在门表里：它需要人在场，只能由人显式跑。

---

## 2. 离线硬门的 43 条判据（分组）

```text
① 固定值与登记（4）        两个能力在登记表里 · 上游版本固定 0.8.7 · 运行时在位且版本一致 ·
                          动作闭集在 TS 侧与 worker 侧**逐字一致**（两处都在，改坏一处就响）
② 登记表覆盖与参数闭集（4） 参数白名单无遗漏/无漂移 · 无通用执行入口（shell/exec/eval…） ·
                          `type` 的正文∈staged（正文不进参数与账本） · inspect 参数只有一个窗口过滤词
③ 适配器协议（5）          正常一行结果 · 空文本如实 `target_not_found` · 多行 ⇒ 协议不符 ·
                          非 JSON ⇒ 失败 · 没有结果行 ⇒ 失败
④ 有界与截断（4）          9000 字符 ⇒ 截到上限且标 truncated · 上游截断如实说出来 ·
                          worker 自报裁剪 ⇒ 如实标 · **worker 裁了但没报** ⇒ 仍如实标
⑤ 失败码映射（10）         十个 worker 具名码 → 内核闭集码，原始码保留在 `details.workerCode`
⑥ "在拉起进程之前就拒掉"（6）非法动作 / 缺目标字段 / 没有 payloadRef / 引用不在暂存 /
                          载荷不是文本 / 一次输入超上限（用"标记文件没被写"证明真的没 spawn）
⑦ 隐私边界（2）            `type` 的正文不进证据与 effect · 桌面文字只在 `turnContent` 里
⑧ 超时与取消（2）          超时 ⇒ `timeout`（工作器被杀且确认退出） · 已取消 ⇒ `cancelled`
⑨ 目录四态（4）            缺省全 off 时 enabled/authorized/connection 三态如实 ·
                          开关打开 + 运行时在位 ⇒ 连接态取**真实读数** · 目录文本不含未登记入口 ·
                          元素上限有界
⑩ 量具自证（2）            三段式（正控安静 / 注入 `shell` 必须响 / 恢复后重新安静） ·
                          `measuredInputs > 0`（计数型判据自检）
```

### 2.1 三段式量具（本仓库 §6.7 的纪律）

```text
正控：真实登记表 ⇒ 审计 0 处问题
负控：给 `desktop.operate` 的参数表注入一个 `shell` ⇒ 必须报 `generic_bypass_arg`
恢复：把参数表放回原状 ⇒ 审计重新安静（0 处问题）
```
判据 id：`dc-measurement-three-stage`。

### 2.2 这条门**不**测什么（说清楚）

```text
· 不测真机 UIA 到底读到什么（那是 `desktop-control:probe`）
· 不测"点在真实控件上之后世界怎么变"（那是 `desktop-control:act`）
· 不测角色决策会不会提出它（那是 `pnpm postlv2:role-tool:matrix` 的 A18/A19 与 B 组）
```

---

## 3. 角色决策链上的读数（`pnpm postlv2:role-tool:matrix`）

| 读数 | 值 |
|---|---|
| 门结果 | **PASS**（18 项能力 · **未覆盖 0 项**） |
| 登记表面 | 18 项能力 · 当前启用 **16**（桌面两项代码缺省 off）· 已授权 16 |
| A18 桌面查看 | 能力被**选中**并真的执行 · 正文回到轮次（kind = `desktop-state` / sourceKind = `desktop-ui`） |
| A19 桌面操作 | 在**任务级 R2** 额度下被**选中**并真的执行 |
| A19 负控 | **没有**任务级 R2 额度（缺省 R1）⇒ 策略拒（R2 是任务级的，不是全局的） |
| B 组 | 决策说 `answer` 时 `desktop.inspect` / `desktop.operate` 都**不被调用**（零动作 + 账本 0 行） |

⚠️ A18/A19 用的是**夹具适配器**（不接真 worker、不碰 UIA）：本门要判的是"决策提出 ⇒ 既有执行环执行"，
不是"这台机器此刻桌面上有什么"。

---

## 4. 相关门的一并读数（本轮改动的影响面）

| 门 | 读数 | 说明 |
|---|---|---|
| `pnpm typecheck` | **EXIT 0** | 含 `src/` 与 `scripts/` |
| `pnpm kernel:test` | EXIT 0 | 依赖方向与 contracts 的既有判据 |
| `pnpm kernel:verify` | EXIT 0 | 迁移 / Seed / 事件不变量 |
| `pnpm m3.5:test` | EXIT 0 | **prompt 逐字节基线**（桌面关闭 ⇒ 逐字不变） |
| `pnpm m4.5:test` | EXIT 0 | 协议 / 登记表 / 策略 / 账本 / 开关静态锁 |
| `pnpm utility:verify` | 首轮 **FAIL 2 组** ⇒ 单独重跑 **32/32 PASS** | 两次 FAIL 都是 math 相关且都是"没拿到当轮内容"（`math-01` / `common-02`）；单独重跑同一份代码 32/32 全绿 ⇒ 归因 = **并发负载**下子进程超时（同一台机上另有会话在跑门），**不是**代码回归。如实登记，不回写第一读数 |
| `pnpm productivity:verify` | 27 PASS · **0 FAIL** · 1 NOT RUN | 唯一 NOT RUN = `browser-04`（**既有的**"需要人工首连真实浏览器"档，与本批无关） |
| `pnpm postlv2:role-tool:verify` | **PASS** | 目录 18 项 · 缺省只开 M4.5 三项 |
| `pnpm gates:run --lane desktop-control` | **PASS 2 · FAIL 0** | 新 lane（墙钟约 24s） |
| **`pnpm m4.5:ci`** | **EXIT 0** | 完整离线门链（交付纪律：退出码 0 才算过；实测约 12 分钟。⚠️ 它按设计会重写 `artifacts/m4.5/**` 等历史证据文件 —— 那些**不**随本批提交） |

---

## 5. 本记录**不**主张什么

```text
① 不主张"桌面能力已经被验收为可用"：真实操作那一档还没跑。
② 不主张"没有旁路"：无通用绕过的判据只覆盖**这张目录里**的参数名（先例同款边界）。
③ 不主张"并发跑门一定绿"：第 4 节那条 FAIL 就是并发负载下的读数。
```
