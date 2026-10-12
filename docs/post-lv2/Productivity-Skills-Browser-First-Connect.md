# 浏览器 sidecar 首连：逐条操作（人工步骤）

日期：2026-10-04。适用版本 **`@playwright/mcp@0.0.83`**（`playwright-core@1.64.0-alpha-1790635538000`）。
**本文件每一步都对着装好的那份代码 / 真起过的那个进程核对过**，不是照抄上游 README。

相关：[`ADR-097`](../adr/ADR-097-productivity-skills-local-file-read-activation.md) ·
验收报告 §1.6 · 局限 `L-PS-28…32`。

> ⚠️ 这一步**必须由人做**：它要动你自己的浏览器。首连**一次**即可，之后照常聊天。
> ⚠️ 它**不是**每任务的审批。

**本机路径（下文都用它）**：

```text
sidecar 目录  C:\Users\user\Desktop\project LG\artifacts\post-lv2\local\productivity-skills-preparation\browser-sidecar
仓库根        C:\Users\user\Desktop\project LG
```

---

## 0. 先知道"什么算成功"

```text
✅ 成功 = 在你的浏览器里**分享**了某个标签，LG 的快照读到的**就是你那个页面**
❌ 不算成功 = sidecar 自己开了一个浏览器、读到 about:blank
```

⚠️ 这两件事**长得很像**（都回 200、都有快照）。本机实测过：**没有**扩展在跑时，
sidecar 会自己开一个 Chrome，用**它自己的** profile
（`%LOCALAPPDATA%\ms-playwright-mcp\mcp-chrome-<hash>`），快照是 `about:blank`。
⇒ 所以第 5 步有一个**专门的判据**把这两件事分开。

---

## 1. 装扩展（在**你日常用的那个**浏览器 profile 里）

```text
① 打开 Chrome（或 Edge）
② 地址栏输入：chrome://extensions
③ 打开安装页（复制整行到地址栏）：
   https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm
④ 点「添加至 Chrome」→ 确认
⑤ 回到 chrome://extensions，找到「Playwright Extension」，核对它的 ID：
   mmlmfjhmonkocbjadbfplnigmagldckm
```

**ID 对不上 = 装错了东西**，删掉重装。这个 ID 是从装好的代码里读出来的
（`playwright-core/lib/coreBundle.js` 的 `playwrightExtensionId`），不是背的。

⚠️ **最常见的失败是装错 profile**：你平时用「Profile 1」却装到了默认档，
第 3 步的连接就会超时。先确认你要共享标签页的是**哪个** profile 名字
（`chrome://version` 里「配置文件路径」的最后一段，例如 `Profile 1`）。

## 2. 取 token

```text
① 点浏览器工具栏上的 Playwright Extension 图标
   （或直接打开：chrome-extension://mmlmfjhmonkocbjadbfplnigmagldckm/connect.html）
② 页面上显示一串 token —— **只选中那串 token 本身**，复制
```

⚠️ **只复制 token 本身**。扩展页面上有时把它显示成 `PLAYWRIGHT_MCP_EXTENSION_TOKEN=xxx`
整行 —— 若连前缀一起复制，值就变成了 `PLAYWRIGHT_MCP_EXTENSION_TOKEN=xxx`，
与扩展自己的 token **不匹配** ⇒ handshake 失败（本机实测踩过）。

⚠️ token 是**凭据**：只放在**启动 sidecar 的那个终端**里。
**不要**写进 `.env`、不要贴进聊天、不要进任何日志或证据。
⚠️ 万一它进了聊天记录 / 截图 / 日志：**当作已泄露**，去扩展页面找"重新生成"，
或删掉扩展重装一次拿新 token。

## 3. 起 sidecar（**单独开一个终端**，让它一直开着）

> ⏩ **2026-10-04 起，这一步可以省掉**：`ADR-101` 让 **LG 自己拉起 sidecar**
> （`.env` 里 `CHARACTER_BROWSER_SIDECAR_AUTOSTART=true`）。
> 走那条路时你只需要**把 token 写进那个私有文件**（见 §3.1），然后在 LG 启动时
> 处理它自己弹出的那个连接页。下面这套手动的仍然有效，用于排错或临时顶替。

⚠️ 下面三条**各自独立**，逐条粘进 PowerShell 即可 —— **不需要先 `cd`**
（用的是 `cli.js` 的**绝对路径**，所以在哪个目录都能跑；本机在 `System32` 下也验过）。

```powershell
$env:PLAYWRIGHT_MCP_EXTENSION_TOKEN = "<只放 token 本身，不要带 PLAYWRIGHT_MCP_EXTENSION_TOKEN= 前缀>"
$env:DEBUG = "pw:mcp:relay"
node "C:\Users\user\Desktop\project LG\artifacts\post-lv2\local\productivity-skills-preparation\browser-sidecar\node_modules\@playwright\mcp\cli.js" --extension --port 8931 --browser chrome
```

### 3.1 自启动那条路：token 放哪

```text
文件   artifacts\post-lv2\local\productivity-skills-preparation\browser-sidecar\extension-token.txt
内容   一行，**只有 token 本身**（不要把 PLAYWRIGHT_MCP_EXTENSION_TOKEN= 前缀也写进去）
```

⚠️ 该路径**已被 gitignore**（`artifacts/post-lv2/local/`），与本仓库"凭据只放私有 local/"
的纪律一致；LG **只读它**，从不把它写进任何日志或证据。
⚠️ 文件不存在或为空 ⇒ LG **在启动时**就打出 `token_file_missing` / `token_file_empty`
（不等到你用浏览器才发现），其余能力不受影响。

⚠️ **先不要加 `--profile-dir-name`** —— 省略时它会自动挑"最后用过**且装了扩展**"的那个
profile；单 profile 的机器（Chrome 上只有 `Default`）这样就是对。只有当扩展装在**多个**
profile 里的某一个、而它挑错了，才需要显式指定它。

参数逐个说明：

```text
--extension                 连"已经在跑的浏览器"（靠第 1 步的扩展）
--port 8931                 MCP 的 HTTP 端口；**必须与 CHARACTER_BROWSER_SIDECAR_URL 一致**
--browser chrome            或 msedge
--profile-dir-name "..."    可选。⚠️ 名字是 User Data 下的**目录名**（`Default` / `Profile 1` / …），
                            写错会直接失败 —— 见 §7（本机实测踩过）
```

它会**自动打开一个连接页**（`chrome-extension://…/connect.html?mcpRelayUrl=…`），
扩展据此回连。**这个终端不要关。**

⚠️ **不要加**这三样（都会绕过本批的接线边界）：

```text
--isolated                          空白 profile = 丢失登录态（计划书明令禁止用它替代）
--allow-unrestricted-file-access    计划书 §3.4 禁用；文件走 LG 自己那条通道
--caps vision,pdf,devtools          本批**没有接线**的能力面
```

## 4. 在你自己的浏览器里分享一个标签

⚠️ **连接页上没有"选择标签"的控件**（本机实测：它整页只有一句
`✅ "project-lg" connected.`）⇒ 不要在那页上找按钮。扩展盯着的是**它打开的那个标签**，
所以最简单的一步是：

```text
在那个已经打开的连接页标签里，**直接在地址栏输入你要给她看的网址**
（例如 https://github.com ），回车。
```

—— 因为 relay 已经附着在**那个标签**上（CDP 是 per-tab 的），导航过去就等于"把这个标签分享给她"。

（若你的用法是另一个标签：切到那个标签并点一下扩展图标，部分版本会改盯当前活动标签；
但**上面那种"就在连接页标签里打开目标网址"是最稳的一条**。）

## 5. 自检（另开一个终端，仓库根目录）

```powershell
cd "C:\Users\user\Desktop\project LG"
pnpm productivity:sidecar:check --expect-url <你刚分享那个页面的域名片段>
# 例：pnpm productivity:sidecar:check --expect-url github.com
```

它用**生产适配器**去打你的 sidecar，三段逐个给读数。**退出码就是判据**：

```text
0  全通，且命中 --expect-url ⇒ **这就是登录态继承的证据**
2  PARTIAL：能读页面，但**不构成**登录态证据（例如读到 about:blank）
1  明确失败
```

### 成功时你应当看到

```text
sidecar = http://localhost:8931/mcp
① 传输层：**通**（initialize=200 · notify=202 · tools/list=200）
② 工具表：**一致**（真实 25 个 · 白名单 7 个全部存在）
③ 真浏览器：**通过 —— 这就是登录态继承的证据**
   页面 URL：https://github.com/…（你分享的那个）
   快照 N 字符；命中你给的 --expect-url "github.com"
```

⚠️ 若第 ③ 段是 **PARTIAL 且 `页面 URL：about:blank`**：
说明 sidecar 开的是**它自己**的浏览器、你的扩展**没连上**。
回到第 4 步，或按第 7 步逐条查。

## 6. 让 LG 用上它

在仓库根 `.env` 里追加（**代码缺省是 off，必须显式打开**）：

```text
CHARACTER_BROWSER_ENABLED=true
```

⚠️ **地址不必写**：缺省已经是 `http://localhost:8931/mcp`。
若你要显式写，**必须写 `localhost`，不要写 `127.0.0.1`** —— 本机实测：
上游把回环规范化成 `localhost` 再比对 `Host` 头，
用 `127.0.0.1` 会拿到 **403 `Access is only allowed at localhost:8931`**。

⚠️ **并注意**（刻意的设计，不是疏漏）：`browser.operate` 是 **R2**，
而组装层的 `CHARACTER_ACTION_MAX_RISK` 缺省是 **R1**
⇒ 普通聊天里 `browser.operate` **永远被策略拒绝**，只有"已授权的浏览器任务"
才拿得到任务级 R2（`main.ts` 的 `riskLevelFor()`）；只读的 `browser.read` 不受此限。

## 7. 连不上时：报错 → 原因 → 怎么办

| 你看到的 | 原因 | 怎么办 |
|---|---|---|
| `③ … Playwright Extension not found in "…\User Data\…"` | **扩展装在了别的 profile**（本机实测：装在 `Default`，命令里写了不存在的 `Profile 1`） | 重启 sidecar 时**去掉** `--profile-dir-name`，或改成报错里那个路径对应的目录名。⚠️ **`pnpm productivity:sidecar:check` 会自动扫盘告诉你它到底装在哪个 profile** —— 照它给的两个修法做 |
| `③ … This operation was aborted`（约 30 秒后） | 扩展**没连上**：token 不对 / 没点分享 / 报错页没人看 | 见下面两行；并**看一眼那个 connect 页面**（它会把原因写在页面上） |
| `Error: Cannot find module 'C:\Windows\System32\node_modules\@playwright\mcp\cli.js'` | 当前目录不是 sidecar 目录 | 用 §3 那条**绝对路径**的命令；**不需要 cd** |
| sidecar 抛 `Unsupported channel: "chrome\"` | 命令里 `--browser chrome\` 带了**多余的反斜杠** —— `\` 在 PowerShell 里不是续行符，被当成参数的一部分 | 写成 `--browser chrome`，**整条命令一行写完** |
| 扩展就是连不上，token 看着也对 | 你把扩展页面上那一整行 `PLAYWRIGHT_MCP_EXTENSION_TOKEN=xxx` 都复制进变量了 | 变量值只放 **token 本身**：`$env:PLAYWRIGHT_MCP_EXTENSION_TOKEN = "xxx"`，**不要**带 `…=` 前缀 |
| `① 传输层：**403** Access is only allowed at localhost:8931` | URL 里写了 `127.0.0.1` | 换成 `http://localhost:8931/mcp` |
| `① 传输层：**连不上**` | sidecar 没在跑 / 端口不对 | 回第 3 步；确认 `--port` 与 URL 端口一致 |
| `notify=406` | 少发 `Accept: text/event-stream` | 本项目已修（`browser.ts`）；若又出现说明**被回退**了，重跑 `--only browser` |
| sidecar 打印 `Playwright extension did not connect within 30s … installed in the Chrome profile "X" and PLAYWRIGHT_MCP_EXTENSION_TOKEN matches its token` | ①profile 名不对 ②token 不匹配 | ①同第一行 ②回第 2 步重新复制（只复制 token 本身） |
| `③ … Browser is already in use for …mcp-chrome-<hash>` | sidecar **自己那个**浏览器还开着（profile 是持久的） | 关掉那个窗口或重启 sidecar；**不要**为绕开它去加 `--isolated` |
| `③ … 读到的不是你给的那个页面` | 扩展连上了，但**分享的标签不是那个** | 在浏览器里切到目标标签，重新分享 |
| `③ … 扩展连上了，但它分享的是 connect 页面自己`（URL 是 `chrome-extension://…/connect.html`） | relay 盯的是 sidecar 自己打开的那个连接页所在的标签 | 在这个连接页上选目标标签；**没有选择器就直接在这个标签里打开你要给她看的网址**，然后重跑 `--expect-url` |

## 8. 首连之后**必须实测**的三件（现在是 `NOT RUN`）

```text
① **登录态继承**：用一个已登录页面跑第 5 步并命中 --expect-url，
   再看快照里是不是"已登录视图"（而不是登录页）
   ⚠️ `about:blank` 或未命中的快照**都不算**这一条的证据
② **桌面焦点影响**：⚠️ 上游 background.ts 含 chrome.tabs.update(...active:true) /
   chrome.windows.update(...focused:true) —— 即扩展**可能抢焦点**。
   做一个动作时看窗口有没有被抢到前台；若抢，按计划书 §3.4 对该调用作
   **最小受控修补**并保留上游回退版本，然后重新测。
③ **用户标签保留**：动作前后确认你打开的其它标签**一个都没少、没被切走**
```

⚠️ **未通过时如实记 `PARTIAL`**，不要静默换成一个丢失登录态的独立 profile。
⚠️ 把这三条的读数**追加**到验收报告 §1.6 与局限 `L-PS-28/32`（**不回写历史读数**）。

### 8.1 2026-10-09 实测读数（追加，不回写）

```text
① 登录态继承      = **成立**（`/settings/profile` 与 `/settings/repositories` 都进去了；
                    github.com 首页是登录视图）。没有读任何 cookie 值。
② 桌面焦点影响    = **不确定（2 次里 1 次）**：400ms 时间线在 initialize 后 0.47s 抓到
                    "前台从 Edge 跳到 chrome | Welcome"；受控复测（150ms 采样）全程没跳。
                    ⇒ 不主张"每次都会抢"。本测量**未覆盖 sidecar 启动**那一次。
③ 用户标签保留    = **PARTIAL**：标签没少（用户原有那张 GitHub 一直在），但**当前选中被切走**
                    （窗口标题变成 "Repositories"）。另有 `Extension Status` 与 3 个 `Welcome`
                    在测量期间消失 —— **未归因**（本次没有任何 close 类调用）。
```

载体（方法 / 混淆项 / 隐私边界）：[`Browser-04-Live-Readings-2026-10-09.md`](./Browser-04-Live-Readings-2026-10-09.md)。
⚠️ `browser-04` 作为**门**仍是 `NOT RUN`；上面是**人工实测**读数（与"声明式人审"先例同形）。
