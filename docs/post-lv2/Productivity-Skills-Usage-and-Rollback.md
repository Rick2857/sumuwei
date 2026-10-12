# 苏沐薇第二批实用能力 —— 使用与回滚

载体：[`Productivity-Skills-and-Local-File-Execution-Plan-2026-10-04.md`](Productivity-Skills-and-Local-File-Execution-Plan-2026-10-04.md)。
基线：[`Productivity-Skills-WP0-Baseline.md`](Productivity-Skills-WP0-Baseline.md)。

> 本文件回答两个问题：**怎么开**、**怎么关**。
> 判定与残余见验收报告 `Productivity-Skills-Acceptance-Report.md`。

---

## 1. 新增的开关（**代码缺省全 off**）

**生产配置现状（2026-10-05）**：`ADR-097` 只读、`ADR-099` 写入 + 任务自主、
`ADR-100` 浏览器、[ADR-103](../adr/ADR-103-productivity-weather-office-news-activation.md) 天气 / 办公生成 / 资讯均已启用。
三项业务开关已回读为 true；新配置由下一次启动的 LG 加载，首次真实使用分别记录。
浏览器服务连接与真实登录会话验收仍待完成。
回读：`pnpm productivity:activation:readback`。

⚠️ **写入与任务自主必须一起开**：写请求**只由任务执行环产生**（单动作路径没有写意图检测器），
因此只开 `CHARACTER_LOCAL_FILE_WRITE_ENABLED` 是**静默**的 —— 权限授予了、适配器构造了，
但没有任何代码路径会产生一次写请求。

| 开关 | 缺省 | 打开后发生什么 |
|---|---|---|
| `CHARACTER_LOCAL_FILE_READ_ENABLED` | `false` | 授予 `local-file:list` / `local-file:read`；构造两个只读适配器；文档/OCR 获得**跨域**读取入口 |
| `CHARACTER_LOCAL_FILE_WRITE_ENABLED` | `false` | 授予 `local-file:write`；构造写入适配器（私有暂存 + 恢复副本 + 并发检查） |
| `CHARACTER_TASK_AUTONOMY_ENABLED` | `false` | 任务形的发言会签发一份**内存**任务授权；规划器（一次模型调用）给出有限计划，由程序校验后分步执行 |
| `CHARACTER_WEATHER_ENABLED` | `false` | `weather.query`：固定 Open-Meteo 地理编码 + 预报 |
| `CHARACTER_OFFICE_GENERATE_ENABLED` | `false` | `office.generate`：受限结构化规格 → 固定 Python 生成器（**还需** `LOCAL_FILE_WRITE`，两条权限都要） |
| `CHARACTER_NEWS_READ_ENABLED` | `false` | `news.read`：受限 HTTPS 获取器 + `rss-parser.parseString` |
| `CHARACTER_BROWSER_ENABLED` | `false` | `browser.read` / `browser.operate`：连接固定 sidecar；**并把任务级风险额度抬到 R2** |

辅助配置（都有代码缺省，**不需要**显式设置）：

```text
LOCAL_FILE_RECOVERY_ROOT             缺省 data/local-file-recovery    覆盖前的恢复副本放这里
CHARACTER_TASK_MAX_ACTIONS           缺省 30        每任务最多几次行动
CHARACTER_TASK_MAX_PLANS             缺省 6         每任务最多几次规划调用
CHARACTER_TASK_DEADLINE_MS           缺省 600000    每任务总时限（10 分钟）
CHARACTER_BROWSER_SIDECAR_URL        缺省 http://localhost:8931/mcp（**不要写 127.0.0.1**）
CHARACTER_BROWSER_SIDECAR_AUTOSTART  缺省 false（**ADR-101**：true ⇒ LG 自己拉起 sidecar）
CHARACTER_BROWSER_SIDECAR_DIR         sidecar 目录（autostart=true 时必填）
CHARACTER_BROWSER_SIDECAR_TOKEN_FILE  token 文件（**凭据**；放被 gitignore 的 private local/）
CHARACTER_BROWSER_SIDECAR_BROWSER     缺省 chrome（闭集：chrome / msedge）
CHARACTER_BROWSER_SIDECAR_PROFILE     可选；缺省不传（让上游自动挑装了扩展的那个）
CHARACTER_BROWSER_SIDECAR_VERSION     缺省 0.0.83（上游换代 ⇒ **拒启动**，不"反正跑起来"）
CHARACTER_BROWSER_SIDECAR_ENTRY_SHA256  cli.js 指纹绊线（覆盖"同一版本被改过"）
CHARACTER_TURN_CONTENT_TOKENS        缺省 0         当轮内容额度（**0 = 一份都不注入**）
```

⚠️ **`browser.operate` 的 R2 是任务级的**：组装层的 `CHARACTER_ACTION_MAX_RISK`
（缺省 R1）**一个字都不改**。普通聊天里 `browser.operate` 永远被策略第 ④ 步拒绝；
只有"已授权的浏览器任务"才拿得到 R2。

## 2. 打开的顺序（建议）

```text
① 只读第一步（零写入风险）：
   CHARACTER_LOCAL_FILE_READ_ENABLED=true
   CHARACTER_TURN_CONTENT_TOKENS=2000
   ⇒ 能不能读出沙箱外的文件、正文会不会进上下文

② 加写入（会真的改本机文件）：
   CHARACTER_LOCAL_FILE_WRITE_ENABLED=true
   ⇒ 覆盖前一定有恢复副本；账本里只有引用与指纹

③ 加任务自主（会多一次模型调用）：
   CHARACTER_TASK_AUTONOMY_ENABLED=true
   ⇒ "帮我读 A 生成 B" 这类一句话任务才会分步执行

④ 四项业务能力**各自独立**：weather / office / news / browser
```

## 3. 回滚

```text
本机文件域     把 CHARACTER_LOCAL_FILE_* 改回 false（旧 sandbox.file.* 原样可用）
任务自主       把 CHARACTER_TASK_AUTONOMY_ENABLED 改回 false（已在跑的内存授权随进程消失）
天气/资讯/办公 各自改回 false
浏览器         把 CHARACTER_BROWSER_ENABLED 改回 false，**并**断开 LG sidecar 与扩展客户端的连接
               （用户浏览器与登录状态**保留**：LG 从不改动 profile）
```

**回滚不会做什么**：

```text
· 不删除已经写下去的产物（那是用户的文件，不是我们的缓存）
· 不删除恢复副本（它们是你覆盖前的原始字节，删掉就没得退了）
· 不删除动作账本里的行（"她做过什么"必须留着）
· 不清理 data/**（真实库不受本批影响）
```

## 4. 浏览器 sidecar（WP5）

计划书 §3.4 的形态是**固定版本 sidecar + 官方扩展**：

```text
LG 侧       只连一个固定地址（CHARACTER_BROWSER_SIDECAR_URL），
            只调 browser-operations.ts 白名单里的 7 个 MCP 工具名
sidecar     自带版本的 @playwright/mcp（装在**自己的目录与自己的 lockfile**，不进 LG 的 package.json）
扩展        官方 Chrome/Edge 扩展：复用**既有 profile** 的 cookie 与登录状态
```

**sidecar 已装**（2026-10-04，`@playwright/mcp@0.0.83`，`npm --ignore-scripts` ⇒ 不含浏览器内核）：

```text
位置   artifacts/post-lv2/local/productivity-skills-preparation/browser-sidecar/
启动   node "<仓库根>\artifacts\post-lv2\local\productivity-skills-preparation\browser-sidecar\node_modules\@playwright\mcp\cli.js" --extension --port 8931 --browser chrome
       （用**绝对路径** ⇒ 与本机当前目录无关；详见 Browser-First-Connect.md §3）
读数   artifacts/post-lv2/productivity-skills/browser-sidecar-install-20261004/install.json
```

⚠️ **人工首连**（这一步必须由人做，不是每次任务的审批）
—— **逐条操作 + 报错对照表在 [`Productivity-Skills-Browser-First-Connect.md`](Productivity-Skills-Browser-First-Connect.md)**：

```text
① 在**日常用的那个 profile** 里装官方扩展（ID mmlmfjhmonkocbjadbfplnigmagldckm）
② 从扩展页面复制 token → 放进启动 sidecar 的**那个终端**（不进 .env、不进证据）
   ⚠️ 只要 token **本身**，不要把 `PLAYWRIGHT_MCP_EXTENSION_TOKEN=` 这个前缀一起复制进去
③ node "C:\Users\user\Desktop\project LG\artifacts\post-lv2\local\productivity-skills-preparation\browser-sidecar\node_modules\@playwright\mcp\cli.js" --extension --port 8931 --browser chrome
   ⚠️ **用绝对路径**（不用先 cd；本机在 System32 下验过）
   ⚠️ **一行写完，不要续行**：`\` 在 PowerShell 里**不是**续行符，会被当成参数的一部分
     ⇒ `--browser chrome\` 让上游抛 `Unsupported channel: "chrome\"`
   ⚠️ **不要**加 --profile-dir-name（省略时它会自动挑"最后用过且装了扩展"的那个）
④ 在浏览器里**分享**你要给她看的那个标签
⑤ 自检：pnpm productivity:sidecar:check --expect-url <那个页面的域名>
      退出码 0 = 全通且命中（**登录态继承的证据**）· 2 = PARTIAL（读到 about:blank ⇒ 不算证据）· 1 = 失败
⑥ CHARACTER_BROWSER_ENABLED=true
```

⚠️ 地址缺省已是 `http://localhost:8931/mcp`；**要显式写就必须写 `localhost`** ——
写 `127.0.0.1` 会拿到 403（上游把回环规范化成 `localhost` 再比对 Host 头，本机实测过）。

⚠️ **上线前必须先测桌面影响**：计划书 §3.4 已登记上游 `background.ts` 含
`chrome.tabs.update(...active:true)` 与 `chrome.windows.update(...focused:true)` ——
即官方扩展**可能抢焦点**。首连与正常动作各测一次；若正常动作会抢焦点，
按计划书对该调用作**最小受控修补**并保留上游回退版本，重新测。
**未通过时如实记 `PARTIAL`，不要静默换成一个丢失登录态的独立 profile。**

## 5. 验收怎么跑

```bash
pnpm productivity:verify --only files,weather      # 开发中短测（公共 8 组始终跑）
pnpm productivity:verify                           # 28 组完整组合
pnpm productivity:verify --list                    # 只打印形状，不跑任何东西
pnpm with-test-model pnpm productivity:verify --live  # 八场景真模型短链
```

⚠️ 运行时的三条事实：

```text
· 它跑在 **isolateDatabase() 的副本**上：真实库 data/pglite 一个字节都不动
· 合成输入文件建在 **%TEMP%** 下（沙箱外），只写新建的合成文件，**不碰任何真实私人文件**
· 每组都会打印"床"的路径（`dir=` 与 `db=`），可以事后独立复核
```

## 6. 恢复副本在哪、怎么用

```text
位置    <LOCAL_FILE_RECOVERY_ROOT>/<yyyy-mm-dd>/<原文件名>.<时间戳>.<覆盖前 sha256 前 8 位>.bak
命名    里面带着**覆盖前**的指纹 ⇒ "这个副本对应哪一次覆盖"可以逐字核对
范围    只针对**那一个**目标；本批不做整盘恢复、也不删历史记录
```

⚠️ 它**不是**备份系统：没有保留策略、没有自动清理、没有跨设备复制。
真正的数据安全仍然由既有快照/备份链负责（`docs/incidents/INC-01-*`）。

## 7. 隐私边界（一条也不要越）

```text
· 写入正文**只**经私有暂存：账本 / trace / 开发者面里只有 payloadRef + 指纹 + 字节数
· 读到的正文**只**进当轮上下文与可裁 section：不进账本、不进长期记忆
· 浏览器 cookie / 连接 token **不进**账本 / trace / 开发者面；页面 URL 只记 origin
  ⚠️ **2026-10-09 修订（ADR-125）**：全工具档下 `browser.mcp` 的**返回值**（可能含 cookie /
  本地存储 / 网络正文）会进入**当轮内容**（她的上下文）—— 那是它存在的理由，不是缺陷；
  但"不进账本 / trace"这半边**照旧**（那里只有引用 + 指纹 + 字节数）。
  另：**连接页的正文含 token**，别让她读连接页（见 §8）。
· 订阅源与天气的响应体**不进**账本（只留引用与指纹）
```

## 8. 全工具档（2026-10-09 / `ADR-125`）

```text
两个开关（都在 .env；代码缺省都是"关"）
  CHARACTER_BROWSER_FULL_TOOLS=true                     内核：允许 browser.mcp（任意工具入口）
  CHARACTER_BROWSER_SIDECAR_CAPS=config,devtools,network,pdf,storage,testing,vision
                                                        sidecar：工具表 25 → 72

回滚 = 删掉这两行（或把 FULL_TOOLS 改成 false）⇒ 工具表回到 25 个、browser.mcp 不在能力清单里、
      权限不授予、任务额度回到 R2/R1。已提交的事件与账本不变。

它的形状
  browser.mcp 是一条**独立登记的能力**（destructive / R3 / 不支持 dryRun），参数闭集只有
  tool（上游工具名，必须逐字在 ALLOWED_MCP_TOOLS 那 72 个里）与 toolArgs（原样转交）。
  老的两个能力（browser.read / browser.operate）**一个字都没改**。
  ⚠️ 因此它比别的能力"难用"是**设计**：需要 browserFullTools + 已授权浏览器任务 + 任务额度 R3。

怎么用（每会话都要做一次）
  ① 让 LG 起来（或任何新会话）⇒ 浏览器会弹一张 connect 页（标题形如 client 名）；
  ② **在那一张标签里**打开你要给她看的网址（不是另开一张）—— relay 附着的是那张标签；
  ③ 需要"点/填/翻页"时她得拿到任务级 R2（普通聊天里 browser.operate 永远被拒）；
     需要"任意工具"时还要 R3（全工具档）。
  ④ 自检：pnpm productivity:sidecar:check --expect-url <域名>；退出码 0 = 读到的真是你那个页面。
     ⚠️ 它自己也会开一个**新**会话 ⇒ 它报 PARTIAL 不等于 LG 那条路坏了（L-PS-54）。

代价（逐条见 Known-Limitations §11）
  提示注入无护栏 · 幂等重放可能给旧读数 · 每会话要重新共享标签 · connect 页带 token 不打码。
```
