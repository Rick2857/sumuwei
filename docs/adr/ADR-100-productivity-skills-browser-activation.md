# ADR-100：第二批实用能力 —— **浏览器档**生产激活

状态：**ACTIVATED（只做状态修订 / 只改配置）**。日期：2026-10-04。
授权：用户 2026-10-04 显式指示「帮我看看有没有配置好，如果配置好了就帮我写一下 .env」，
并按其指引完成了 sidecar + 官方扩展的人工首连。
前置：[`ADR-097`](ADR-097-productivity-skills-local-file-read-activation.md)（只读）·
[`ADR-099`](ADR-099-productivity-skills-write-and-task-autonomy-activation.md)（写入 + 任务自主）。

---

## 0. 这次追加了什么

`.env` **只追加一行**（外加三行注释，说明 token 与地址为什么不在里面）：

```text
CHARACTER_BROWSER_ENABLED=true
```

⇒ 生产聊天里 `browser.read` / `browser.operate` 被授予权限、构造适配器，
**并且任务级风险额度抬到 R2**（`main.ts` 的 `riskLevelFor()`：`browserEnabled ? 'R2' : actionMaxRiskLevel`）。

⚠️ **代码里的缺省仍然是 `false`** —— 与 `ADR-048`/`065`/`067`/`069`/`071`/`082`/`094`/`095`/`097`/`099`
同一条先例。

---

## 1. 生效读数

`pnpm productivity:activation:readback`（不打开数据库、不发起动作、不含凭据）：

```text
localFileReadEnabled     true      ← ADR-097
localFileWriteEnabled    true      ← ADR-099
taskAutonomyEnabled      true      ← ADR-099
browserEnabled           true      ← 本 ADR
weatherEnabled           false
officeGenerateEnabled    false
newsReadEnabled          false

browserSidecarUrl        http://localhost:8931/mcp   ← **localhost，不是 127.0.0.1**（见 §4）
actionMaxRiskLevel       R1                          ← **逐字未改**；R2 只出现在任务级
```

---

## 2. 桥的实测状态（**这一档与前三档的关键差别**）

前三档是"代码 + 离线读数"；这一档**真的连上了用户自己的浏览器**，且下列读数都是实测：

```text
① sidecar 起在 http://localhost:8931（@playwright/mcp@0.0.83，专属目录 + 专属 lockfile）
② 官方扩展装上并连上（ID mmlmfjhmonkocbjadbfplnigmagldckm，版本 0.4.0_0）
   relay 原话：New connection to /extension/… → Extension connection established
   → Playwright MCP connected
③ LG 的生产适配器（createBrowserAdapter）与它握手成功：
   initialize=200 · notifications/initialized=202 · tools/list=200（真实 25 个工具）
④ LG 真的读到了页面（快照正文入当轮内容）
```

⚠️ **④ 读到的是哪个页面取决于用户此刻分享了哪个标签** —— 见 §3，这是**用户侧的选择**，
不是配置项。

---

## 3. 一条**如实登记**的观察：首连时它读的是 connect 页

实测序列（这些都记在验收报告 §4 的 D-13…D-16）：

```text
· relay 说 Extension connection established —— 浏览器确实接上了
· 但 relay 附着的是 sidecar **自己打开的那个连接页所在的标签**
  （上游用 tabs.update(active:true) 把它顶到前台 —— 这正是计划书 §3.4 预警的"桌面焦点影响"）
· 那个连接页**整页只有一句** `✅ "project-lg" connected.`，**没有标签选择器**
⇒ 用户要把目标页面给它，正确做法是**在那个标签里直接打开目标网址**
  （CDP 是 per-tab 的：relay 附着在那个标签上，导航过去就等于分享了它）
```

⇒ 因此本 ADR **不主张**"登录态继承已验证"：那条读数要等用户在**被附着的那个标签**里
打开一个已登录页面、并用 `pnpm productivity:sidecar:check --expect-url <域名>` 命中之后才算。
**在此之前，`browser-04` 仍是 `NOT RUN`。**

---

## 4. 被这一档逼出来的三个工程事实（都已修 / 已登记）

```text
① 地址必须写 `localhost`：上游把回环规范化成 localhost 再比对 Host 头
   ⇒ `http://127.0.0.1:8931/mcp` 会拿到 403（D-10）
② 每一个 POST 都必须带 `Accept: application/json, text/event-stream`，否则 406；
   而通知失败被刻意设计成不阻断 ⇒ 表现是"连上了但工具拿不到东西"（D-12）
③ **LG 自己的自检工具把 token 打进了输出**（connect 页 URL 里带着 `token=`）
   ⇒ 与"连接凭据不进任何证据"直接冲突，已加打码（D-15）
```

---

## 5. 边界：本档**不主张**什么

```text
· 不主张"登录态继承已验证" —— 见 §3，要等 --expect-url 命中
· 不主张"桌面焦点影响已处置" —— 上游 background.ts 的 active:true/focused:true
  在本机**已经被看到一次**（连接页被顶到前台）；按计划书 §3.4，若正常动作也抢焦点，
  需对该调用作最小受控修补并保留上游回退版本（**尚未做**）
· 不主张"用户标签保留已测" —— 尚未测
· 不主张"她能任意操作网页"：只调白名单里的 7 个 MCP 工具（25 个真实工具里其余 18 个一律拒绝）
· 不主张"浏览器动作在普通聊天里可用"：`browser.operate` 是 R2，普通聊天是 R1 ⇒ 会被策略拒
```

---

## 6. 回滚

```text
把 CHARACTER_BROWSER_ENABLED 改回 false（或删掉那一行）⇒ 两个能力立即停止被授予权限。
· **要同时**断开 sidecar 与扩展的连接（关掉那个终端 / 关掉扩展）
· 用户浏览器与登录状态**保留**：LG 从不改动 profile
· 动作账本行保留（"她看过什么"必须留着）
```

---

## 7. 同轮登记的文档缺陷（**都是我的错**，记在这里免得重犯）

```text
D-13  指引里举了 `--profile-dir-name "Profile 1"`，而这台机器上只有 `Default`
D-14  ① 用 bash 的 `\` 当 PowerShell 续行符 ⇒ `--browser chrome\` ⇒ Unsupported channel
      ② 让用户把扩展页上 `PLAYWRIGHT_MCP_EXTENSION_TOKEN=xxx` 整行都赋给了变量
      ③ 命令用相对路径且漏了 cd ⇒ 在 System32 下 Cannot find module
D-15  自检工具把 token 打进自己的输出
```

⇒ 通用教训（值得写进仓库纪律）：**文档/回复里的示例会被逐字执行**。
示例必须"一字不多、一字不少、不依赖任何隐含前提（当前目录、续行符、界面文案）"地可执行。
