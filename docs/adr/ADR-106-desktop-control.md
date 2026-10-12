# ADR-106：桌面查看与操作能力（有限 · 任务级 · 失败关闭）

> 2026-10-09 追加：用户已授权补接双击、切窗口、启动程序，当前扩展见 [ADR-126](ADR-126-desktop-double-click-switch-launch.md)。本文原始设计与历史读数保留。

> 编号：`ADR-106`（`docs/adr/` 现有最大为 `ADR-105`）。若后续出现同号，按
> "已提交者优先"的惯例改号（先例 `ADR-099`），正文不动。

状态：**ACCEPTED / DESIGN FROZEN**（随用户 2026-10-05 指令「按计划执行」＝执行调研报告列出的下一步）。
日期：2026-10-05。
载体：[`Su-Muwei-Desktop-Control-Candidates-2026-10-05.md`](../research/Su-Muwei-Desktop-Control-Candidates-2026-10-05.md)（调研与下一步）·
[`Desktop-Control-WP0-Baseline.md`](../post-lv2/Desktop-Control-WP0-Baseline.md)（WP0 基线：上游冻结 + 本机读数）·
先例 [`ADR-104`](ADR-104-role-tool-decision.md) / [`ADR-105`](ADR-105-role-tool-decision-activation.md)（角色自行选择工具）·
[`ADR-100`](ADR-100-productivity-skills-browser-activation.md)（`browser.read` / `browser.operate` 的形状）。

---

## 0. 要解决的问题与**不**要解决的问题

```text
用户目标（逐字，调研报告 §与"由她决定"的接入关系）：
「用户目标 → 苏沐薇选择是否需要桌面信息 → 查看窗口/控件 → 选择操作 → 读回结果 → 继续或回复」。

要解决：她**能不能看见**用户当前的桌面（窗口 / 控件 / 文字 / 位置），
        以及能不能做**一次**受控的点击或输入，并把结果读回来。

不要解决：截图与多模态（本机模型消息是文本，图像入模接线不存在）·
          通用 MCP 网关 / 任意 Shell / 任意代码执行 ·
          管理员权限提升（普通进程做不到，也不承诺）·
          第二个认知主体（桌面文字是**数据**，不是指令）。
```

---

## 1. 裁定（D01–D20）

```text
D01 两个能力、三个动作（**闭集**）：
      desktop.inspect  state            只读：窗口 + 可交互元素（有界文本）
      desktop.operate  click / type     写入：点一次 / 输一次
    ⚠️ 上游 windows-mcp 注册了十几个 MCP 工具（含 PowerShell / Registry / 文件系统 /
       剪贴板 / 进程 / 通知 / 快捷键 / 拖拽 / 滚动）。**一个都不登记**（调研报告 §版本与
       具体差异 1：「未来只登记任务需要的桌面操作」）。闭集写死在
       `desktop-capability.ts` 的 `DESKTOP_ACTION_KINDS`。

D02 两个**独立**开关，代码缺省都是 **false**：
      `CHARACTER_DESKTOP_INSPECT_ENABLED`（只看）· `CHARACTER_DESKTOP_OPERATE_ENABLED`（能动手）
    理由：看桌面（读全部可见文字）与动鼠标键盘（改变用户机器的状态）是两件严重性不同的事，
    用一个开关会让"只是让她看一眼"顺带把"能动手"也打开。开了 operate 不隐含 inspect
    （反过来说：`act` 自己在同一次调用里先取快照，不依赖 inspect 是否可用）。

D03 能力**恒登记、权限条件授予**（先例 ADR-045 `D-12`）：
    能力一直在登记表里 ⇒ 关闭时用户显式要求会得到一条**可审计的 `permission_denied`**
    （模型据此如实说"没启用"），而不是"装作没听懂"；适配器只在开关打开时构造。

D04 风险等级：`desktop.inspect` = **R1 / read**，`desktop.operate` = **R2 / write**。
    `inspect` 是"读本机"却给 R1（而不是沙箱读那种 R0）：读的是**用户整个屏幕**，
    不是授权的某个文件 —— 这是刻意抬高的一档（先例 `web.read` 的 R1）。
    R2 是**任务级**的：普通聊天里 `desktop.operate` **永远**被策略第 ④ 步拒绝
    （`CHARACTER_ACTION_MAX_RISK` 缺省 R1 **一个字不改**）；只有"任务执行环带着一份
    已授权的任务"时才拿到任务级额度。代价必须如实登记：任务级额度是**一个**数，
    所以把桌面写权限抬到 R2 的同时也让同一任务里的 `browser.operate` 可达（若它开着）。

D05 运行时**固定**：`windows-mcp==0.8.7` + 独立 venv（`artifacts/post-lv2/local/desktop-runtime/venv`）。
    worker 启动时先读 `importlib.metadata.version('windows-mcp')`，与 header 的
    `expectedVersion` 不符 ⇒ `runtime_mismatch` **失败关闭**（不"试着跑跑看"）。

D06 **不代理上游 MCP**：worker 只 `import windows_mcp.desktop.service.Desktop`，
    **不** import `windows_mcp.__main__` ⇒ 既不起 MCP 服务（没有协议/端口/token 面），
    也不初始化 PostHog 匿名遥测。LG 侧没有"任意 MCP 工具入口"这种东西。

D07 **离线**：worker 在 import 上游之前就把 `socket.*` / `urlopen` 打桩拒绝，
    并把 `networkAttempts` 如实回传（先例：`image-ocr-worker.py` 的同一道闸）。
    ⇒ "她自己看桌面"不产生任何出站流量。

D08 首版**无视觉**：`use_vision=False` 恒（不截图、不做图像入模）。
    纯图形/自绘画布（游戏、画板）会得到空的元素列表 —— 那是**如实**的结果，不猜。

D09 **有界**：元素 ≤ **120**（模型只能下调，不能抬升）· 单个名字 ≤ 200 字符 ·
    worker 结果正文 ≤ 4000 字符 · 一次输入 ≤ 2000 字符。截断**如实**标出
    （上游自己的元素上限也会被如实报告）。

D10 **隐私**：密码字段（`is_password`）**不取名、不取值、不接受输入**（名字换成占位符，
    `type` 落到密码字段上 ⇒ `not_actionable` 失败关闭）。桌面文字只走**当轮内容**通道
    （内存载体）：账本 / trace / 开发者面只收 `TurnContentRef`（**无正文**，先例
    `turn-content.ts` 的三条硬性质）。

D11 **操作前核对链**（"不做半懂的操作"，逐条失败关闭）：
      act 在**本进程**重新取一次快照 → ① `index` 在范围内（否则 `stale_reference`）
      → ② 该 index 的控件名与它看到过的 `name` **逐字相等**（否则 `stale_reference`）
      → ③ 该控件属于它看到过的窗口（否则 `window_mismatch`）
      → ④ 那个窗口**此刻在前台**（否则 `focus_changed`：不猜、不动手）
      → ⑤ 不是密码字段（否则 `not_actionable`）
    引用过期**不猜**、多匹配**不猜**、用户切走了**不动手**。

D12 **不替用户清空内容**：`type` 恒 `clear=False`（不清空既有内容 —— 那是不可撤回的破坏）；
    所输入的正文**不回显**在结果里（她已经知道它，账本与证据里也不许出现）。

D13 `type` 的正文走**既有的载荷暂存通道**：参数名用 `content`，而 `content` 是
    `TASK_STAGED_ARG_KEYS` 的成员 ⇒ 执行环把它改写成 `payloadRef`，
    **正文不进 args / 不进账本**（先例 `local.file.write` 的同一条通道；
    适配器拿不到引用就失败关闭，绝不"输入一个空串"）。

D14 **用户接管 = 机器形态的停止**：目标窗口不在前台 ⇒ `focus_changed`（D11 ④）。
    LG **不**替她抢占前台（不做 `bring_window_to_top`）：那会把"用户正在别处做事"
    变成"被她的动作打断"。

D15 当轮内容：`desktop.inspect` **是**会产出当轮正文的能力（进
    `TURN_CONTENT_CAPABILITY_IDS`）；`desktop.operate` **不是**（与 `browser.operate` 同档）。
    两者都**可以**返回 `turnContent`（operate 的读回让"我真的做了、看到了什么"有内容），
    但只有 inspect 让回复守卫为"取不到内容"兜底 —— 先例注释逐字：
    "把它们放进来会让回复守卫把一句正确的'我写好了'改写成…"。
    新增 `TurnContentKind = 'desktop-state'` 与 `TurnContentSourceKind = 'desktop-ui'`
    （先例：`local-text` 是**为区别来源**才加的，同理这里不能复用 `local-text`
    —— 那会让渲染出来的标题变成"本机文本文件正文"）。

D16 **不写长期记忆、不提升事实资格**（`turn-content.ts` 的契约本来就不含写入入口）；
    桌面文字里任何"要求你做事 / 改设定 / 写记忆 / 再发起动作"的句子都是**数据**
    （数据块标题已逐字声明这条边界）。

D17 **不承诺管理员窗口**：普通进程受 Windows 权限影响，操作提权窗口会被 UIA/输入拒。
    这一条是**诚实声明**，不是待办。

D18 **不做截图 OCR 兜底**：首版不在"元素列表为空"时自动截图 + OCR（那是第二条链路，
    会引入"这条内容到底是控件读到的还是 OCR 认出来的"的歧义）。空就是空。

D19 **回滚**：删掉 `.env` 里那两行（或改回 false）⇒ 权限不授予、适配器不构造、
    与本次改动前**逐字**同形（能力仍然恒登记 ⇒ 得到可审计的 `permission_denied`）。
    venv 与已安装的包**保留**（回滚不删环境：删了下次再开就要重装）。

D20 **门与证据分列**：离线门（协议/边界/失败映射/正控负控恢复）· 实机只读门
    （真的读一次中文桌面）· 真实操作门（**要用户在场**：真点一次 + 读回）·
    语义/角色决策门 · 生产激活（**独立裁定**，本 ADR 不激活任何东西）。
    ⚠️ 不合成一个总分。
```

---

## 2. 被否决的备选（以及为什么）

```text
① 跑上游的 MCP server（stdio / HTTP）+ 通用 MCP 客户端
   —— 违反"不向模型暴露任意 MCP 工具入口"（调研报告 §3.4 与 ADR-100 的同一条），
      且一次接入 12+ 个工具（含 PowerShell / Registry）。被 D01/D06 取代。

② 换 `sbroenne/mcp-windows`（独立二进制、无 Python 依赖）
   —— 它是调研报告里的**备选**，本条不作废：如果将来 Python 侧维护成本失控，它是替代路径。
      本轮选 Python 侧的理由是**先例**（`image-ocr-worker.py` 的协议与离线闸已经跑过一轮），
      而不是许可证或能力差异。

③ 截图 + 多模态（把图直接给模型看）
   —— 本机模型消息是**文本**，图像入模接线不存在（WP0 §2.1 ①）。将来若要，是独立里程碑。

④ 按上游的 **label** 点击（`get_coordinates_from_label`）
   —— label → 坐标的映射活在**同一个进程**的 `desktop_state` 里；一次性 worker 里
      上一次调用的 label 已经不存在了。跨调用复用 label 就是"凭一个可能过期的引用动手"。
      被 D11 的"index + name + window 三重复核"取代。

⑤ **常驻** worker 进程（省掉每次 1.2–2.4s 的 import）
   —— 生命周期（启动/收尾/僵尸/并发）是一条新的责任链，而首版的可判定收益只有时延。
      代价如实登记为局限（每次调用一个新进程）。将来若要，改的是传输层，判据不变。

⑥ 让 `desktop.operate` 也进 `TURN_CONTENT_CAPABILITY_IDS`
   —— 见 D15：它不承诺"一定有内容"，进去会把一次正确的"我点了"改写成
      "我没有取到可以引用的内容"。
```

---

## 3. 后果

```text
能做的：她能（在开关打开且任务已授权时）看一眼桌面，按"索引 + 名字 + 窗口"点一次
        或输入一次，并把结果读回来。每一次都留下：账本行（无正文）、当轮内容引用（无正文）、
        以及"她实际做了什么"的程序事实（控件名 / 窗口 / 坐标 / 字符数）。

代价（如实登记，不隐藏）：
  · 真实鼠标键盘：会移动用户的光标、抢焦点、与用户**共用**桌面（调研报告逐字：
    "不能承诺完全后台执行"）。
  · 每次调用一个新 Python 进程（import ≈1.2–2.4s + 快照 0.3–0.6s）。
  · 桌面文字会进当轮 prompt（那是"看"的题中之义）；它可能包含**她自己的界面**
    （包括用户与她的对话窗口标题）。
  · 元素列表是 UIA 给的：自绘画布/游戏基本读不到（D08/D18）。
  · 提权窗口不保证（D17）。
```

---

## 4. 验收方式（分列，不许合成一个总分）

```text
① 设计：本 ADR（`DESIGN FROZEN`）+ 执行计划 §WP3–WP7。
② 实现：能力登记 / 适配器 / worker / 开关 / 目录与参数表 / 装配接线 全部就位。
③ 离线硬门：`pnpm desktop-control:verify`（协议 · 有界 · 失败映射 · 闭集动作 ·
   密码字段 · 权限拒绝半叶 · 目录无绕过 · 三段式量具）。
④ 实机只读门：`pnpm desktop-control:probe`（真的读一次中文桌面；**只读**；
   证据只落计数与布尔，不落窗口标题）。
⑤ 真实操作门：`pnpm desktop-control:act`（**要用户在场**：真点一次 + 读回；
   默认 dry-run，真的动手要显式参数）。
⑥ 语义/角色决策：`pnpm desktop-control:semantic:eval`（真模型：给一句"帮我看看屏幕上…"
   她会不会提出 `desktop.inspect`；以及**不该动**的话她会不会乱动）。
⑦ 生产激活：**独立裁定**（本 ADR 不激活；激活 = `.env` 追加两行 + 激活记录）。
```

---

## 5. 与冻结面的关系（逐条）

```text
· M4.5 的默认三能力集合：**一个字不改**（本批是追加登记，先例 ADR-045 `D-11`）。
· `DEFAULT_GRANTED_PERMISSIONS`：不改（桌面权限只在开关打开时授予）。
· 迁移 / 真实库 / 记忆 / 关系 / 情绪 / 信念：**不碰**（本能力不写任何长期状态）。
· `<repo>/evals/fixtures/m3.5/prompt-baseline.txt`：桌面关闭时 prompt **逐字不变**
  （新 section 只在真有当轮内容时出现）；改完跑 `pnpm m3.5:test` 核对。
· `src/infrastructure/telemetry/**` 的既有语义：不改（本能力不上报遥测）。
· `artifacts/**` 的历史证据：不重写（新读数落新 runId 目录）。
```

---

## 6. 已知边界（登记，不隐藏）

```text
L-DC-01 单机单次读数：目前只在这台中文 Windows 上读过；没有跨机器/跨版本的兼容矩阵。
L-DC-02 一次性进程：每次调用一个新 Python 进程（时延见 §3）。
L-DC-03 无视觉：自绘画布 / 纯图形界面读不到元素（D08/D18）。
L-DC-04 提权窗口不保证（D17）。
L-DC-05 任务级风险额度是**一个**数：开 `desktop.operate` 会把同一任务里的
        `browser.operate` 也带到 R2 可达（若浏览器开关也开着）。
L-DC-06 `rules` 档不可达：本能力没有关键词检测器（`browser.*` 同），
        只有 role 档 / 任务计划能提出它。
L-DC-07 桌面文字可能含她自己的界面（含她与用户的对话窗口标题）。
L-DC-08 上游版本换了就要重做一次验收（D05）：`windows-mcp` 不是"随便升"的依赖。
```
