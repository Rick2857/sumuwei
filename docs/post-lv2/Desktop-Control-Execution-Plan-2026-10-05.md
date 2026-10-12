# 苏沐薇桌面查看与操作：执行计划与进度（2026-10-05）

> 上游调研：[`Su-Muwei-Desktop-Control-Candidates-2026-10-05.md`](../research/Su-Muwei-Desktop-Control-Candidates-2026-10-05.md)
> （用户给的"计划"：`安装` · `桌面实机探针` · `LG 适配` · `生产激活` 四项 = **NOT RUN**）。
> 设计冻结：[`ADR-106`](../adr/ADR-106-desktop-control.md)（`ACCEPTED / DESIGN FROZEN`）。
> 基线：[`Desktop-Control-WP0-Baseline.md`](Desktop-Control-WP0-Baseline.md)。

---

## 0. 一句话

```text
安装 ✅ · 实机只读探针 ✅ · LG 适配 ✅（两个能力 / 三个动作 / 43 条离线判据 · 14 条实机判据）
真实操作 ⏸（要人在场 · 门已就绪 · 未跑） · 生产激活 ⏸（**未做**，需用户单独裁定）
```

---

## 1. 范围（逐字来自调研报告，不改写）

```text
用户目标：用户目标 → 苏沐薇选择是否需要桌面信息 → 查看窗口/控件 → 选择操作 → 读回结果 → 继续或回复
本轮做：把"她能看见 / 能动手"这件事接进**既有**权威（登记表 / 策略 / 任务环 / 预算 / 账本 / 回复守卫）
本轮不做：截图与多模态 · 通用 MCP 网关 · 任意 Shell · 管理员权限提升 · 第二个认知主体
```

---

## 2. 工作包与状态

| WP | 内容 | 状态 | 载体 / 证据 |
|---|---|---|---|
| WP0 | 基线：上游冻结 + LG 现状 + 环境 | **DONE** | [`Desktop-Control-WP0-Baseline.md`](Desktop-Control-WP0-Baseline.md) |
| WP1 | 独立运行时安装（固定 `windows-mcp==0.8.7`） | **DONE** | `artifacts/post-lv2/local/desktop-runtime/`（不进仓库）· wheel sha256 与 PyPI 一致 |
| WP2 | 实机只读探针（中文控件读得到、0 出站、失败关闭） | **DONE** | [`Desktop-Control-WP2-Probe-Record.md`](Desktop-Control-WP2-Probe-Record.md)（**含一次事故记录**） |
| WP3 | 设计冻结 | **DONE** | [`ADR-106`](../adr/ADR-106-desktop-control.md) |
| WP4 | 适配：两个能力 + 闭集动作 + 开关 + 参数闭集 + 装配接线 | **DONE** | `desktop-capability.ts` · `desktop-control.ts` · `desktop-control-worker.py` · `desktop-control-assets.ts` · `main.ts` |
| WP5 | 离线硬门（协议 / 有界 / 失败映射 / 闭集 / 隐私 / 目录四态 / 三段式） | **DONE** | `pnpm desktop-control:verify` = **43 条 · 0 未运行 · 0 未通过**（[记录](Desktop-Control-WP5-Gates-Record.md)） |
| WP5b | 实机只读门（真 worker + 真实桌面 + 失败关闭负控） | **DONE** | `pnpm desktop-control:probe` = **14 条 · 0 未运行 · 0 未通过** |
| WP6 | 角色决策链上的"选中 / 不选"读数 | **DONE** | `pnpm postlv2:role-tool:matrix` = **PASS**（18 项能力 · 未覆盖 **0**；含 A18/A19 与 R2 负控） |
| WP7 | 真实操作一次 + 读回（**需用户在场**） | **NOT RUN（门已就绪）** | `pnpm desktop-control:act --i-am-here`（自建记事本目标） |
| WP8 | 生产激活 | **NOT DONE（需用户单独裁定）** | 见 [`Desktop-Control-Activation-Candidate.md`](Desktop-Control-Activation-Candidate.md) |

---

## 3. 交付的能力面（冻结在 ADR-106 `D01`）

```text
desktop.inspect  state            R1  read   当前桌面：窗口 + 可交互元素（有界文本）
desktop.operate  act              R2  write  闭集动作：click / type（**仅两个**）
```

```text
开关（代码缺省都是 false）
  CHARACTER_DESKTOP_INSPECT_ENABLED    看：窗口 / 控件 / 名字 / 位置 / 可编辑控件的当前值
  CHARACTER_DESKTOP_OPERATE_ENABLED    动手：click / type（**任务级 R2**）

刻意**没有**登记（上游有，我们一个都不要）：
  PowerShell · Registry · Filesystem · Process · Clipboard · Notification · Display ·
  Scrape · Multi · App 启动/切换 · 快捷键 · 拖拽 · 滚动 · 截图
```

---

## 4. 与既有权威的关系（一处都没换）

| 既有权威 | 本批怎么用它 |
|---|---|
| 角色决策（ADR-104/105） | `desktop.*` 只经"她提议 → 任务环执行"；`rules` 档**不可达**（如实登记 `L-DC-06`） |
| 策略 / 风险等级 | `inspect` = R1；`operate` = **R2 且只是任务级**（普通聊天永远被拒） |
| 任务预算 / 期限 / 进度闸 | 一个字节没改（桌面动作走同一条环） |
| 载荷暂存 | `type` 的正文用**既有** `content` 通道（执行环改写成 `payloadRef`） |
| 账本 / trace / 开发者面 | 只收 `TurnContentRef`（**无正文**）；密码字段不取名不取值 |
| 回复守卫 | `desktop.inspect` 进"会产出当轮内容"清单；`desktop.operate` **不进**（与 `browser.operate` 同规） |

---

## 5. 本批**不**主张什么（完整清单见 ADR-106 §6 与 [Known-Limitations](Desktop-Control-Known-Limitations.md)）

```text
① 不主张"她能操作桌面"是**已验收**的：真实操作那一档还没跑（要人在场）。
② 不主张"任何窗口都能读"：绘图/自绘画布基本读不到；提权窗口不保证。
③ 不主张"她是后台跑的"：她的动作会动用户真实的鼠标与键盘、会抢焦点。
④ 不主张"升级 windows-mcp 没问题"：换版本 = 重做一次验收（`D05`）。
```
