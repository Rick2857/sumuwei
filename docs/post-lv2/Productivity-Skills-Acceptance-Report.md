# 苏沐薇第二批实用能力 —— 验收报告

日期：2026-10-04。载体：[`Productivity-Skills-and-Local-File-Execution-Plan-2026-10-04.md`](Productivity-Skills-and-Local-File-Execution-Plan-2026-10-04.md)。

> **2026-10-05 激活修订**：用户授权后，天气 / 办公生成 / 资讯三个生产开关均已开启并回读为 true，见 [ADR-103](../adr/ADR-103-productivity-weather-office-news-activation.md)。首次真实使用仍分别为 `NOT OBSERVED`；浏览器真实会话验收仍未运行。下文 2026-10-04 的开关与验收读数作为当时记录保留，当前配置以 ADR-103 及其回读为准。
基线：[`Productivity-Skills-WP0-Baseline.md`](Productivity-Skills-WP0-Baseline.md) ·
使用与回滚：[`Productivity-Skills-Usage-and-Rollback.md`](Productivity-Skills-Usage-and-Rollback.md) ·
局限：[`Productivity-Skills-Known-Limitations.md`](Productivity-Skills-Known-Limitations.md)。

> ⚠️ **本报告按计划书 §7 的要求分列六类**：全盘文件授权 · 任务自主执行 · 天气 · 办公生成 · 资讯 · 浏览器。
> 每类再列 **安装 / 接线 / 离线 / 真实链 / 启用及残余**。
> 缺证据 = `NOT RUN`；失败 = `FAIL`；**不把准备期来源核对、配置开启或离线全绿当成真实链验证**。

---

## 0. 一句话判定（**不许合成一个总分**）

| 环节 | 判定 | 依据 |
|---|---|---|
| 依赖安装 | **DONE（一项）** | 只有 `rss-parser@3.13.0` 进根 `package.json`（计划书 §1 固定的组件）；办公三库**复用**第一批的专属 venv，未新装。⚠️ 组件的源码/发布指纹沿用计划期的 [`sources.json`](../../artifacts/research/productivity-skills-plan-20261004/sources.json)（6 份源码快照 + npm 元数据）；`@playwright/mcp` 与官方扩展**未安装**（见 §1.6） |
| LG 接线（公共 + 两类 + 四项业务） | **DONE（代码级）** | 真 `TurnGateway` + 真 Gateway/Policy/账本/适配器；本机文件域与任务执行环全链接线 |
| 离线验收（**28 组**） | **PASS 27 · FAIL 0 · NOT RUN 1 · MEASUREMENT INVALID 0**（96 条参数化输入） | `artifacts/post-lv2/productivity-skills/productivity-20261004T174118-2a7922b5-0389/run.json` |
| 真模型短链（**八场景**） | **PASS 6 · FAIL 0 · NOT RUN 2**（EXIT 0） | `artifacts/post-lv2/productivity-skills/productivity-live-live-20261004T165539-32968/live.json` |
| 必要继承回归 | **`pnpm m4.5:ci` EXIT 0** + `pnpm m5.1:measurement:verify` EXIT 0 + `pnpm m5.1:regression:verify` **PASS** + `pnpm m5.1:gates` **Hard Gates PASS** | 见 §7 |
| 生产启用 | **只读 + 写入 + 任务自主 + 浏览器 ACTIVATED / 天气·办公·资讯 NOT ACTIVATED**（用户 2026-10-04 分三轮显式授权） | `.env` 追加四行：`CHARACTER_LOCAL_FILE_READ_ENABLED` / `_WRITE_ENABLED` / `CHARACTER_TASK_AUTONOMY_ENABLED` / `CHARACTER_BROWSER_ENABLED`；**代码缺省仍全 false**；载体 [`ADR-097`](../adr/ADR-097-productivity-skills-local-file-read-activation.md) + [`ADR-099`](../adr/ADR-099-productivity-skills-write-and-task-autonomy-activation.md) + [`ADR-100`](../adr/ADR-100-productivity-skills-browser-activation.md)；回读 `pnpm productivity:activation:readback`：读/写/任务自主/浏览器 **true**，天气/办公/资讯 **false**；**首次真实使用 = NOT OBSERVED** |
| sidecar 自启动 | **IMPLEMENTED / ACTIVATED**（用户 2026-10-04 裁定三处待定项后实现） | 载体 [`ADR-101`](../adr/ADR-101-browser-sidecar-autostart-design.md)；验收 `pnpm productivity:sidecar:autostart:verify` = **17 通过 / 0 失败**（替身驱动；**真入口启动仍 NOT RUN**，由用户下次启动 LG 实测）；`.env` 另加 `_AUTOSTART=true` + `_DIR` + `_TOKEN_FILE` |

⚠️ **因此本批不宣布"四项业务能力全部完成"**：**浏览器**记 `PARTIAL`
（sidecar 已装；离线 ①②③ 组通过；**真实登录态与桌面焦点影响 = NOT RUN**，需要人工首连
—— 逐字步骤见 [`Productivity-Skills-Browser-First-Connect.md`](Productivity-Skills-Browser-First-Connect.md)）。

⚠️ **生产分三批开**（都用独立 ADR 记，**不是一个总分**）：

```text
ADR-097  只读档      local-file-read            （2026-10-04 第一轮）
ADR-099  写入+任务档  local-file-write + task-autonomy（2026-10-04 第二轮）
ADR-100  浏览器档     browser（read + operate）   （2026-10-04 第三轮，sidecar + 官方扩展已首连）
未开     天气 / 办公生成 / 资讯
```

⚠️ **浏览器档的特殊性**：它是四条业务能力里**唯一已经真的连上用户浏览器**的一条
（relay 握手、工具表、LG 读页面全通 —— 见 `ADR-100` §2）。但它**尚未拿到登录态继承的证据**：
relay 附着在 sidecar 自己打开的那个连接页标签上（上游 `tabs.update(active:true)` 的副作用，
正是计划书 §3.4 预警的焦点影响），而那个连接页**没有标签选择器**
⇒ 用户要在**那个标签里**打开目标网址，再用 `--expect-url` 命中才算。

**写入与任务自主必须一起开**：`local.file.write` 的请求**只由任务执行环产生**
（单动作路径**没有**写意图检测器，是刻意的设计）⇒ 只开写入档在读数上与"没开"无法区分。
各档的**首次真实使用都还是 NOT OBSERVED** —— 配置生效 ≠ 她在真实对话里读到/写过。

---

## 1. 逐类分列

### 1.1 全盘文件授权（`local.file.list/read/write`）

| 环节 | 判定 | 读数 |
|---|---|---|
| 安装 | **不适用** | 零新依赖（纯 Node 内置 + 既有 crypto） |
| 接线 | **DONE** | 三个能力**恒登记**；两个开关（读 / 写各一个）；`local-file:list/read/write` 按开关授予；适配器按开关构造；旧 `sandbox.file.*` 与 `DEFAULT_GRANTED_PERMISSIONS` **一字未改** |
| 离线 | **PASS**（`common-01…08` + `file-01…04`） | 见 §2 / §3 |
| 真实链 | **PASS** | `live-file-office-success` / `live-file-office-degrade`（真模型 + 合成临时文件） |
| 启用 | **NOT ACTIVATED** | `CHARACTER_LOCAL_FILE_READ_ENABLED` / `_WRITE_ENABLED` 缺省 `false` |

**关键读数（离线）**

```text
沙箱外读取（file-01）    6 条路径 ×（成功 / 期望值命中 / 契约断言 / sourceKind=local-disk / 正文入 packet）全绿
                          中文名 · 带空格（引号） · CSV · JSON · 第二个卷根 · 第二个卷根 + 空格
                          伪装格式：二进制内容的 .txt ⇒ unsupported（**判据是字节，不是扩展名**）
                          触发边界：不带引号的空格路径 ⇒ **不成功**（不猜边界、不读另一个位置）
                          同一路径**在任务环里**（结构化）⇒ 读得到（能力支持空格）
写入（file-02/03/04）     任务环自主"读 → 写"两步 · file_created → file_overwritten · 账本指纹 = 文件指纹
                          恢复副本**逐字节等于**覆盖前原文件（sha256 相同）
                          并发修改：指纹不符 ⇒ validation_failed/concurrent_modification，**文件逐字节未变**
                          无授权 ⇒ **没有任何成功写入**、目标文件不存在
隐私（common-04）         7 张表级扫描哨兵 **0 命中**；写入参数里只有 payloadRef/指纹/字节数
                          正控：注入哨兵后同一判据**必须响**
```

### 1.2 任务自主执行（有限计划 + 分步）

| 环节 | 判定 | 读数 |
|---|---|---|
| 安装 | **不适用** | 规划器复用既有模型端点与凭证来源（**不新增出站目标**） |
| 接线 | **DONE** | 内存任务授权（30 行动 / 6 规划 / 10 分钟，可配）+ 严格计划解析 + 分步走**既有** Registry/Policy/Gateway/Adapter |
| 离线 | **PASS**（`common-06/07` + `file-02/03/04`） | 见下 |
| 真实链 | **PASS** | `live-file-office-success`：真模型给出"读输入 → 生成 Office"计划并真的产出了 docx |
| 启用 | **NOT ACTIVATED** | `CHARACTER_TASK_AUTONOMY_ENABLED` 缺省 `false` |

```text
越权：能力集合之外 ⇒ task_plan_step_capability_not_authorized（**整条计划作废**）
参数白名单：未知参数键 ⇒ task_plan_step_arg_key_not_allowed
未知字段：多一个顶层字段 ⇒ task_plan_unknown_field
风险：R2 操作在 R1 任务额度下 ⇒ permission_denied（**只在额度抬高时**放行）
归因：任务里每一步挂在**同一个 traceId**、requestedBy=user（不伪造轮次）
预算：行动预算 1 ⇒ 只执行 1 次，第二个文件**没有**被创建
```

### 1.3 天气（`weather.query`）

| 环节 | 判定 | 读数 |
|---|---|---|
| 安装 | **不适用** | 固定 Open-Meteo 两跳，**无需 SDK** |
| 接线 | **DONE** | 一个能力两个固定服务步骤（地理编码 → 预报）；城市歧义**先澄清** |
| 离线 | **PASS**（`weather-01…04`） | 字段/单位 · 同名候选 · 时区与有效时间 · 限流/坏响应/超时 |
| 真实链 | **PASS** | 真 Open-Meteo：西安 18.4°C / 体感 17.1°C / 三天预报（见下） |
| 启用 | **NOT ACTIVATED** | `CHARACTER_WEATHER_ENABLED` 缺省 `false` |

**真实 API 逼出来的一条规则修正**（`R-…` 见 §5）：真地理编码对"西安"返回 **10 条**
（1 条 `PPLA` 省会 + 9 条同名村庄）。第一版"候选 > 1 就必须澄清"因此把**西安**判成
`target_ambiguous` ⇒ 规则改成"**收窄后恰好只有一个行政中心类候选（PPLC/PPLA/PPLA2/PPLG）
⇒ 选它，并把其余同名候选列进 facts**"；两个都是行政中心（如"朝阳"）仍然澄清。

```text
weather-01 命中：气温 18.4°C · 体感 17.1°C · 三天最高 22.1/20.4/19.8 · 时区 Asia/Shanghai
                   facts 里明说"**不是**现场气象站实测"
weather-02 同名：`target_ambiguous` 且话术**列出候选**（北京市 / 辽宁省），不产出内容
weather-03 facts 逐字含：预报有效时间 2026-10-04T15:00 · 获取时间 · 时区（UTC+8）· 预报天数 3
weather-04 timeout / 429（带状态码）/ 坏 JSON 三档各自如实
```

### 1.4 办公生成（`office.generate`）

| 环节 | 判定 | 读数 |
|---|---|---|
| 安装 | **不适用（复用）** | 既有专属 venv：python-docx **1.2.0** / python-pptx **1.0.2** / openpyxl **3.1.5**（WP0 已逐条核实 MATCH） |
| 接线 | **DONE** | 受限结构化规格 → 固定版本 Python 生成器；两条权限（`office:generate` + `local-file:write`）**都要** |
| 离线 | **PASS**（`office-01…04`） | 见下 |
| 真实链 | **PASS** | `live-file-office-success`（真模型规划 + 真生成 + 真落盘） |
| 启用 | **NOT ACTIVATED** | `CHARACTER_OFFICE_GENERATE_ENABLED` 缺省 `false` |

```text
office-01 DOCX  38,114 字节；重新打开：paragraphs=6 tableRows=3 wantedTexts=5 **missingCount=0**
office-02 XLSX  两个工作表 ["汇总","明细"]；**formulaCells=2**（一条明确类型 + 一条合计）
                ⚠️ 规格里那个以 `=` 开头的**文字**没有被当成公式；textCells=12
office-03 PPTX  slideCount=4（封面 + 3）· tables=1 · charts=1；21 页超限 ⇒ **拒收**且无产物
office-04 生成失败 / 并发冲突 ⇒ 目标文件**逐字节未变**（sha256 前后相同）；覆盖成功 ⇒ 恢复副本
```

### 1.5 资讯（`news.read`）

| 环节 | 判定 | 读数 |
|---|---|---|
| 安装 | **DONE** | `rss-parser@3.13.0`（根 `package.json` 精确版本） |
| 接线 | **DONE** | 复用 LG 受限 HTTPS 获取器 + `parseString()`（**不**用 `parseURL()`） |
| 离线 | **PASS**（`news-01…04`） | RSS/Atom · 去重/未知日期 · 摘要与全文边界 · 坏源与实体声明 |
| 真实链 | **PASS** | 真订阅源（阮一峰网络日志 Atom）：`news.read` 成功 + 当轮内容 delivered |
| 启用 | **NOT ACTIVATED** | `CHARACTER_NEWS_READ_ENABLED` 缺省 `false` |

**真实链逼出来的第二条缺陷**：受限 HTTPS 获取器**只认 HTML**，而真实 RSS/Atom 回的是
`application/xml` ⇒ **每一个真实订阅源都在读正文之前被拒**；离线夹具因为替换掉了整个
fetcher（连带那处 content-type 闸）一个断言都没碰到它。修法：获取器增加
`contentTypeFamily`（缺省仍是 `html`，`web.read` 逐字不变），资讯显式传 `xml`。

```text
news-01 条目/来源/链接/摘要标记 逐字来自夹具；facts 明说解析器是 parseString
news-02 同链接转载**只出现一次**；未知发布时间如实标注"未知"（**不用抓取时间补齐**）
news-03 事实面明说"只带订阅源自身给出的摘要"并指路 web.read；只对订阅源取了 **1 次**
news-04 DTD/ENTITY ⇒ 解析**之前**拒；text/html ⇒ 拒；获取抛错 ⇒ 如实失败；http:// ⇒ 准入拒
真实链  3 条真实条目 · 程序追加了"来源与范围"附录 · 回复「读完了。三篇，都是阮一峰的科技周刊。」
```

### 1.6 浏览器（`browser.read` / `browser.operate`）—— **PARTIAL**

| 环节 | 判定 | 读数 |
|---|---|---|
| 安装 | **DONE（sidecar 包）/ 扩展 NOT DONE** | **已装**：`@playwright/mcp@0.0.83`（Apache-2.0）+ `playwright@1.64.0-alpha-1790635538000` + `playwright-core@1.64.0-alpha-1790635538000` —— 装在**专属目录与专属 lockfile** 里（`npm --ignore-scripts`，**没有**下载任何浏览器内核），LG 的 `package.json` / `pnpm-lock.yaml` 未动；CLI 实跑读回 `Version 0.0.83` 且 `--extension` 存在。公开读数 [`install.json`](../../artifacts/post-lv2/productivity-skills/browser-sidecar-install-20261004/install.json)。**官方扩展未装**（需人工首连）。LG 侧只接线到**固定地址**，地址缺省 `http://127.0.0.1:8931/mcp` |
| 接线 | **DONE** | 两个能力恒登记；只连固定 sidecar；**只调 7 个白名单 MCP 工具名**；闭集动作映射 |
| 离线 | **PASS 3 / NOT RUN 1**（`browser-01…04`） | 受控假 sidecar（真 MCP JSON-RPC）：会话 · 点击/填写 + 页面读回 · 白名单/断连 |
| 真实链 | **NOT RUN** | `live-browser-success` 需要**人工首连**真实 profile + 官方扩展 |
| 启用 | **NOT ACTIVATED** | `CHARACTER_BROWSER_ENABLED` 缺省 `false` |

```text
browser-01 会话：请求日志 = initialize → notifications/initialized → tools/call browser_snapshot
           快照来自受控页面（PAGE-MARK-1 + e1…e4 元素引用）
browser-02 填写 ⇒ **从 sidecar 的页面状态读回**值；点击 ⇒ **页面 URL 真的变了**
           过期引用 ⇒ 如实失败（提示重新取快照），**没有**改成点别的元素
browser-03 7 个禁用工具名（任意 JS / 网络抓取 / 文件 / 全浏览器关闭）**全部不在白名单**
           闭集之外的动作 ⇒ validation_failed 且 sidecar **零新增请求**（15 → 15）
           断连 ⇒ execution_failed 且话术**点名** sidecar 地址
browser-04 **NOT RUN**：登录态继承 / 桌面焦点影响 / 用户标签保留 ⇒ 需要人工首连
```

⚠️ **本类不主张"已登录会话可用"**：离线 ①②③ 用的是**受控假 sidecar**，
它**不替代**真实登录态；计划书 §3.4 已登记的上游
`chrome.tabs.update(...active:true)` / `chrome.windows.update(...focused:true)`
焦点影响**尚未实测**。

⚠️ **sidecar 装好之后，剩下的是"只能由人做"的那一步**（`ADR-097` 同轮）：

```text
① 启动（**绝对路径**，与当前目录无关）：
   node "<仓库根>\artifacts\post-lv2\local\productivity-skills-preparation\browser-sidecar\node_modules\@playwright\mcp\cli.js" --extension --port 8931 --browser chrome
   ⚠️ **不许**加 `--isolated`（那会创建一个空白 profile = 计划书 §3.4 明令禁止的
      "丢失登录态的独立 profile"）；**不许**加 `--allow-unrestricted-file-access`
      与 `--caps vision,pdf,devtools`（都是本批**没有接线**的能力面）。
   ⚠️ 不要加 `--profile-dir-name`（除非它挑错了 profile）；命令**一行写完**，不要用续行符。
② 在自己的 Chrome/Edge 里以**既有 profile** 安装官方扩展、选择目标标签、允许连接。
③ 然后把 CHARACTER_BROWSER_ENABLED 置 true（地址缺省已是 `http://localhost:8931/mcp`，
   **不要写 127.0.0.1** —— 见 §4 的 D-10）。
④ 自检：`pnpm productivity:sidecar:check --expect-url <你分享那个页面的域名>`
   —— 退出码 0 = 命中（登录态继承的证据）· 2 = PARTIAL（读到 about:blank，**不算**证据）· 1 = 失败。
```

**首连之后必须实测三件**（现在都是 NOT RUN）：登录态继承 · 桌面焦点影响 · 用户标签保留。
若正常动作会抢焦点，按计划书 §3.4 对该调用作**最小受控修补**并保留上游回退版本，重新测；
未通过时如实记 `PARTIAL`，**不要静默换成一个丢失登录态的独立 profile**。

---

## 2. 离线验收：28 组（计划书 §6A）

**终态读数**：`runId = productivity-20261004T174118-2a7922b5-0389`
→ **PASS 27 · FAIL 0 · NOT RUN 1 · MEASUREMENT INVALID 0 · 96 条参数化输入**
（在**最终交付代码**（`d3db348c`）上跑的那一次；此前两轮读数分别是 27/0/1 与 23/4/1
—— 后者的 4 个 FAIL 是 D-2 的链序问题，已修，读数不回写）。

```text
common-01   8 条 · common-02   4 条 · common-03   5 条 · common-04   4 条
common-05   2 条 · common-06   3 条 · common-07   4 条 · common-08   7 条
file-01    10 条 · file-02     3 条 · file-03     2 条 · file-04     5 条
weather-01  1 条 · weather-02  3 条 · weather-03  1 条 · weather-04  3 条
office-01   1 条 · office-02   1 条 · office-03   2 条 · office-04   3 条
news-01     3 条 · news-02     2 条 · news-03     2 条 · news-04     5 条
browser-01  1 条 · browser-02  4 条 · browser-03  4 条 · browser-04  0 条（NOT RUN）
```

**每组 `measuredCount` > 0**（唯一的 0 是 `browser-04`，它在 `finish()` 里被**显式**记为
`NOT RUN`，不是 `MEASUREMENT INVALID`）。

⚠️ **生产激活之后又重跑了一次（`productivity-20261004T172553-768c61ae-09da`），读数逐项相同**
（27/0/1）。这不是"顺手再跑一遍"，而是一次**针对性检查**：激活改了 `.env`，
而验收床必须**结构上**读不到它 —— 实际上 `assembly.ts` 与验收入口**从不调用
`readKernelFlags()` / 不加载 `dotenv`**，它们是**自己构造**开关对象传给床的。
⇒ "生产开了什么"与"验收床量的是什么"是**两条独立的通道**（否则 `common-01`
那条"缺省关闭"的断言会在激活当天变成假绿）。

**公共第 ⑧ 组（量具正控 / 负控 / 恢复）的两例三段式**：

```text
① 正控：合法绝对路径 ⇒ 判据安静（ok=true）
② 负控：注入"永远放行"的假 inspector ⇒ 同一个判据**必须响**（judge=false）
③ 恢复：放回真实实现 ⇒ 判据重新安静（judge=true）
第二例（任务词形判据）：闲聊 ⇒ 安静；注入"永远说是" ⇒ 响
计数型自检：无路径 ⇒ 0 条 / 有路径 ⇒ 1 条（0/0 与"全对"分得开）
```

---

## 3. 真模型短链：八场景（计划书 §6C）

**终态读数**：`runId = productivity-live-live-20261004T165539-32968`
→ **PASS 6 · FAIL 0 · NOT RUN 2**，`live exit = 0`。

执行形态：`pnpm with-test-model pnpm productivity:verify --live` —— 真 `src/main.ts` 装配 +
真模型（`deepseek-v4.1-flash` @ `ark.cn-beijing.volces.com`）+ **tmpdir 隔离库**
（`productionDbTouched: false`，生产 `data/pglite` 一个字节都没动）。

| 场景 | 判定 | 观察到的程序事实 / 回复 |
|---|---|---|
| `live-weather-success` | **PASS** | 真 Open-Meteo 两跳；回复含城市与单位 |
| `live-weather-degrade` | **PASS** | `青鳉三号星` → 地理编码 0 候选 ⇒ 动作失败；回复**没有**编造气温 |
| `live-file-office-success` | **PASS** | 读合成输入 → 真模型规划 → 真生成 **docx 落盘** |
| `live-file-office-degrade` | **NOT RUN** | 那一轮**没有产生可判定的轮次**（stdout 既无回复也无 traceId，端点 `call_failed`）——**不是**能力失败 |
| `live-news-success` | **PASS** | `ACTION_SUCCEEDED` + `[turn-content-truth] news.read:delivered` + 程序追加来源附录 |
| `live-news-degrade` | **PASS** | 坏源 ⇒ 动作失败；回复如实（无假全文结论） |
| `live-browser-success` | **NOT RUN** | 需要**人工首连**官方扩展与真实 profile（见 §1.6） |
| `live-browser-degrade` | **PASS** | 连不上 sidecar ⇒ 如实失败；回复「看不了。我这边没有页面内容……」 |

⚠️ **本批为 live 量具修了四处**（都不许"把断言改绿"）：

```text
① **不判"没量到"的轮次**：那一轮端点连续 `call_failed`，六个场景的 stdout 既没有回复
   也没有 traceId，而第一版照样判 FAIL —— 并写进了一句**写死的** reason。
   ⇒ 现在：没产生轮次 = NOT RUN（并说明"这不是能力失败"）。
② **reason 必须来自观察**：第一版有几句 reason 是硬编码的，于是证据在**说没发生过的事**。
③ **"能力成功"只能用程序事实判**：`live-news-success` 第一版要求"回复里有 URL" ——
   而那一轮能力**交付成功**、程序**追加了附录**，模型只说「读完了。三篇，都是阮一峰的科技周刊。」
   ⇒ 现在判据是 `ACTION_SUCCEEDED` + `turn-content … delivered`。
④ **否定式表述不算成功口吻**：`live-browser-degrade` 第一版把
   「我这边**没有**页面内容」读成了"声称看到了页面内容" ⇒ 现在复用仓库既有的
   `scanClaims`（4 字符否定窗口，M4.1 起就在用）。
```

---

## 4. 本批逼出来的真实缺陷（**逐一记名，含修法与证据**）

> 这一节是本批最有价值的部分：它们全都**穿过了各自的量具**，是真链路、真数据或
> **真上游组件**逼出来的。`D-10`/`D-11`/`D-12` 来自同一轮"把真 sidecar 起起来探一次"——
> 那三步（读上游源码 → 真起一次 → 逐字比对工具表）花的时间远少于它省下的首连排错时间。

```text
D-1  kernel 侧载荷指纹是 fnv1a64、适配器拿 sha256 比对
     ⇒ **每一次暂存写入都被判成"篡改"**（offline file-02/03/04 全红）。
     修法：两个指纹各有用途、各有算法，各自显式命名（common-04 / file-02/03 复绿）。

D-2  M4.5 沙箱检测器会把 `C:\x\a b.txt` 切成丢盘符的片段
     ⇒ 一条把**本机域**说成"越出沙箱范围"的 permission_denied。
     修法：**链序**（本机域检测器排在前面），M4.5 逐字不动。
     ⚠️ 曾试图"在 M4.5 里先挖掉绝对路径"，被 `pnpm m4.5:ci` 的 `NL-05` **三条断言打红**
     ⇒ 那条门是冻结的，它赢；链序才是解法（`e772a6f4`）。

D-3  `s://news.example.com/feed.xml` 里的 **`s:`** 被当成盘符
     ⇒ "读一下这个订阅源 https://…/feed.xml" 被抢成 `local.file.read`，目标是一个
     **根本不存在**的位置。修法：盘符前置否定环视 `(?<![A-Za-z0-9:])`。

D-4  **`office.generate` 的 `spec` 里任何嵌套对象都被拒**
     ⇒ 真模型的一次办公计划整条作废（`task_plan_step_arg_value_not_allowed`），
     而**离线 28 组一个断言都没碰到** —— 因为脚本化规划器**从不经过校验器**。
     修法：① 校验器改成"我们已经在 spec 里面了吗"；② **执行环自己也校验一遍**（同一个函数）。

D-5  **生产里有两个载荷暂存实例**（任务环一个、写入/办公适配器一个）
     ⇒ 计划把正文放进 A、适配器去 B 取 ⇒ 每一次 `office.generate` 都是
     `validation_failed / spec_not_staged`。修法：一处实例；验收床改成与生产**同形**。

D-6  受限 HTTPS 获取器**只认 HTML** ⇒ **每一个真实 RSS/Atom 都被在读正文之前拒**。
     修法：`contentTypeFamily`（缺省 `html` 不变；资讯显式 `xml`）。

D-7  办公生成器的 stdout 走 **Windows 系统代码页** ⇒ 中文工作表名进当轮内容时是乱码
     （`"sheetNames":["����","��ϸ"]`）。修法：`PYTHONIOENCODING=utf-8` + `PYTHONUTF8=1`，
     并加一条**正控**断言（工作表名逐字正确）——只数"两个工作表"是量不到这件事的。

D-8  `invalid_output` 被当成不可恢复 ⇒ "模型多写了一个参数名"直接终结整个任务。
     修法：形状失败**有界重试**（规划预算 × 连续上限 3），并把失败码喂回下一轮规划；
     同时把 `content` / `spec` 的区分写进规划器指令。

D-9  live 量具四处（不判未测轮次 / reason 来自观察 / 用程序事实判成功 / 否定式表述）
     —— 见 §3 末段。

D-10 **真 sidecar 的 Host 允许名单把 `127.0.0.1` 拒成 403**
     —— 上游把回环地址**规范化**成 `localhost` 之后比对 `Host` 头
     ⇒ 缺省 `http://127.0.0.1:8931/mcp` 的**首连必然失败**。
     实测：同一个请求，`127.0.0.1` 回 `403 Access is only allowed at localhost:8931`，
     `localhost` 回 `200` + `202`。修法：缺省改成 `localhost`。
     ⚠️ 它是**读上游源码 + 真起一次 sidecar 探一次**才发现的，任何夹具都照不到。

D-11 **浏览器白名单的"负控"在测空气**：第一版手写的 7 个"禁用名字"里
     `browser_run_code` / `browser_download` / `browser_close_all` 在真 sidecar 上
     **根本不存在**（真名是 `browser_run_code_unsafe`；另两个没有对应工具），
     而真正高危的 `browser_network_request`（单条网络请求体）**没被点名**。
     那条断言**看起来是绿的**。修法：把真 sidecar `tools/list` 的 **25 个原名**存成读数，
     负控改成"真实表里除白名单外一个都不许放行"，并补**正控**（7 个必须被放行 ——
     否则一个"永远拒绝"的实现能骗过全部负控）。

D-12 官方 MCP Streamable HTTP 传输要求**每一个 POST** 都带
     `Accept: application/json, text/event-stream`，否则 **406**；
     而 `notifications/initialized` 只发了 `Content-Type`。
     因为通知失败被刻意设计成**不阻断**，表现会是"看起来连上了、工具调用却拿不到东西"。
     修法：补上头；并给受控夹具**复刻官方的 406/415 两条闸** ⇒ 这类缺陷以后离线就能照到。

D-13 **我写的首连指引里的 `--profile-dir-name "Profile 1"` 是错的**（这台机器上没有 `Profile 1`）
     —— 用户逐字照抄后，sidecar 报
     `Playwright Extension not found in "...\User Data\Profile 1"`，
     而扩展其实**已经装好**、装在 `Default` 里（版本 `0.4.0_0`）。
     ⚠️ 这是**文档造成的失败**，不是产品缺陷 —— 但代价是用户白跑一轮。
     两级修法：
     ```text
     ① 指引改成**默认不写** --profile-dir-name（省略时上游会自动挑"最后用过且装了扩展"的那个），
        并写明"profile 名字 = User Data 下的**目录名**（Default / Profile 1 / …）"
     ② productivity:sidecar:check **认得这条 preflight 报错**：扫盘列出**哪个 profile 真的装了扩展**，
        并给出两个可直接照做的修法（改名字 / 去掉参数）
     ```
     ⇒ 通用教训：**文档里的示例参数会被逐字执行**，所以示例必须是"在多数机器上成立"的那一个。

D-14 **同一类问题的另外两处**（2026-10-04 首连时又踩了）：
     ```text
     ① 我在回复里用 bash 风格的 `\` 当续行符写 PowerShell 命令
        ⇒ 用户抄到的第一条以 `\` 结尾 ⇒ `--browser chrome\`
        ⇒ 上游抛 `Unsupported channel: "chrome\"`（coreBundle.js 逐字确认）
        —— `\` 在 PowerShell 里**不是**续行符（反引号才是）
     ② 扩展页面上 token 显示成 `PLAYWRIGHT_MCP_EXTENSION_TOKEN=xxx` 一整行
        ⇒ 用户把**整行**赋给了环境变量 ⇒ 值与扩展自己的 token 不匹配 ⇒ handshake 失败
     ③ 我给的命令块漏了 `cd`，而用的是**相对路径** `node_modules\...`
        ⇒ 用户在 `C:\Windows\System32` 下执行 ⇒ `Cannot find module
          'C:\Windows\System32\node_modules\@playwright\mcp\cli.js'`
     ```
     ⇒ 修法：**所有命令一律一行写完、不用任何续行符**；
     **一律用 `cli.js` 的绝对路径**（这样与当前目录无关，在哪都能跑；本机在 System32 下验过）；
     token 步骤逐字写明"只要 token 本身"；三条都进首连的报错对照表。
     **D-13 与 D-14 是同一条教训的三次实例**：示例会被逐字执行，
     所以示例必须"一字不多、一字不少、且不依赖任何隐含前提"地可执行。

D-15 **我的自检工具把连接凭据打进了自己的输出**（2026-10-04，首连当场发现）：
     扩展刚连上、还没分享目标页面时，`browser_snapshot` 读到的**就是 sidecar 自己
     打开的那个 connect 页**，而它的 URL 里带着 token：
     ```text
     chrome-extension://mmlm…/connect.html?mcpRelayUrl=…&token=PxsgbPTG…(43 位)
     ```
     第一版把 `页面 URL` **原样打印** ⇒ 凭据进了终端输出 / run.json / 工单记录 ——
     **与本批自己的隐私边界直接冲突**（"连接凭据不进任何证据"）。
     修法：`maskCredentialQuery()` 把查询串里名字像凭据的键（token/key/secret/password/auth）
     打码成 `前 4 位***(长度)`；**并且**对快照正文也打码（不能只打那一行 URL）。
     ⇒ 同一条纪律也补进了本工具：它现在**单列**"分享的是 connect 页"这一态，
     不再让它混进"读到了页面"（那正是最容易被误判成成功的一态）。

D-16 顺带记下这一态的**正确处置**（已实测确认）：relay 说 `Extension connection established`
     时浏览器确实接上了，但 relay 盯的是那个连接页**所在的标签**；
     而那个连接页**整页只有一句** `✅ "project-lg" connected.` —— **没有标签选择器**。
     ⇒ 正确做法是在**那个标签里直接打开目标网址**（CDP 是 per-tab 的，导航过去就等于分享了它），
     然后 `--expect-url` 才有意义。
```

**从"真 sidecar 只读探测"得到的传输层读数**（不需要浏览器即可复现；`D-12` 的判据在这里）：

```text
initialize                  → 200 + Mcp-Session-Id
notifications/initialized   → 202
tools/list                  → 200 · 25 个工具
白名单 7 个名字              全部命中真实表；其余 18 个全部被拒
```

---

## 5. 必要继承回归（计划书 §6B）

```text
pnpm typecheck                  EXIT 0
pnpm m4.5:ci                    EXIT 0（见 §7 的逐门小结；日志 = artifacts/m5.1/wp9-m4.5-ci.log）
pnpm m5.1:measurement:verify    EXIT 0（16 通过 / 0 失败：正控 / 负控 / 恢复三段式）
pnpm m5.1:regression:verify     PASS（读同一次 m4.5:ci 的日志：exit=0 · 编码=utf-8 · 逐门小结 26 条 · 硬门 3 条）
pnpm m5.1:gates                 Hard Gates PASS（含 G10 全量回归·既有 Hard Gate 零退化）
```

⚠️ **两处必须讲清的工程事实**：

```text
① `m4.5:ci` 在本批**跑了三次**，三次读数都留着：
   第 1 次 = **EXIT 1**（D-2 打红了 NL-05 三条断言）—— 归档
             artifacts/post-lv2/local/productivity-skills-preparation/m4.5-ci-fail-NL-05-20261004.log
   第 2 次 = EXIT 0（在 D-2 修好之后）
   第 3 次 = EXIT 0（在 D-3…D-9 全部修好、即**最终交付版本**上）
   ⇒ 计划书要求"最终保留一次串行、无缓存完整 `m4.5:ci`"：**第 3 次就是那一次**；
     前两次是同一段代码的**过程读数**（如实保留，不回写）。

② `artifacts/m5.1/wp9-m4.5-ci.log` 上的 `EXIT_CODE=0` 是**本次追加的真实退出码**
   （UTF-8 无 BOM；连同"逐门小结 26 条 / 硬门 3 条"一起供 `m5.1:regression:verify` 读）。
   跑门过程中**没有** `git add`，也没有对 `artifacts/` 做无差别 `git checkout`。
```

---

## 6. 本批**不主张**的事

```text
· 不主张"全盘文件授权已可用"：生产只开了**只读**两项（`ADR-097`）；**写入未授权**
· 不主张"她说读到过"：本档 **FIRST-USE NOT OBSERVED** —— 生效后还没有真实对话轮
· 不主张"浏览器可用"（**PARTIAL**：sidecar 已装；**扩展 + 真实登录态 + 桌面焦点 = NOT RUN**）
· 不主张"离线 28 组全绿 = 真实链路全对"（离线替换了模型服务与出站 IO 两样东西）
· 不主张"她能完成任意的多步任务"：预算是 30 行动 / 6 规划 / 10 分钟；任务是**内存**授权
· 不主张"办公排版通过"：**没有**已验证的渲染器 ⇒ 只证明结构可读回
· 不主张"资讯全文"：只带订阅源自身给出的摘要；深读交 web.read，仍受后者限制
· 不主张"天气是实测"：那是天气模型数据（事实面逐字写明）
· 不新建通用插件框架 / 数据库迁移 / 人格改动 / 新后台调度
```

---

## 7. 证据索引

```text
公开（进仓库）
  artifacts/post-lv2/productivity-skills/productivity-20261004T174118-2a7922b5-0389/run.json    28 组终态读数 + 源指纹
  artifacts/post-lv2/productivity-skills/productivity-20261004T154… / …T1608… / …T1623… / …T1646…  run.json   过程读数（不回写）
  artifacts/post-lv2/productivity-skills/productivity-wp0-20261004T151549-8594b902/wp0-baseline.json
  artifacts/post-lv2/productivity-skills/productivity-live-live-20261004T165539-32968/live.json  八场景读数
  artifacts/post-lv2/productivity-skills/browser-sidecar-install-20261004/install.json          sidecar 安装读数
  docs/adr/ADR-097-productivity-skills-local-file-read-activation.md                            生产激活（只读档）
  docs/post-lv2/Productivity-Skills-WP0-Baseline.md
  docs/post-lv2/Productivity-Skills-Usage-and-Rollback.md
  docs/post-lv2/Productivity-Skills-Known-Limitations.md（L-PS-01…39）

⚠️ `.env` **不进仓库**（gitignore）：激活靠 `ADR-097` + 回读命令复现，
   `pnpm productivity:activation:readback` 只输出开关与闭集配置，**不含凭据**。

raw（已忽略，artifacts/post-lv2/local/productivity-skills-preparation/）
  live/<runId>/*.log                                  每个场景的子进程原始输出（正文只在这里）
  m4.5-ci-fail-NL-05-20261004.log                     第 1 次 m4.5:ci 的 FAIL 读数（不回写）
  prior-wp9-m4.5-ci-20261004.log                      跑门之前那份（第一批的）回归日志留档
  wp0/<runId>.json                                    WP0 基线 raw 副本

⚠️ **多会话共享工作树**：本批的三次证据里的 `head` 可能不同（另一个会话在本批运行期间提交过）。
   ⇒ 判定以 `run.json` 的 `sourceHashes`（逐文件指纹）为准（`L-PS-34`）。
   ⚠️ 而且目录里**同时有另一个会话跑本门产生的 run.json**（`runId` 里带着它们的提交短号，
   例如 `…-d1a7a614-…` / `…-ece10b61-…`）。它们**不是**本报告引用的那两次读数：
   本报告的判定只引用上面点名的两个 `runId`（`…d3db348c-87e1` 与 `…165539-32968`）。
   其余 run.json 一律是**过程读数**，不回写、也不计入判定。
```
