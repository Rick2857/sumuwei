# 苏沐薇第二批实用能力 —— 已知局限（`L-PS-01…22`）

载体：[`Productivity-Skills-and-Local-File-Execution-Plan-2026-10-04.md`](Productivity-Skills-and-Local-File-Execution-Plan-2026-10-04.md)。
判定见 [`Productivity-Skills-Acceptance-Report.md`](Productivity-Skills-Acceptance-Report.md)。

> 本文件是**如实登记**，不是待办清单。每一条都写清"这是设计边界"还是"这是未做的验证"。
> 与第一批同一条纪律：**不淡化、不合并、不写"基本可用"**。
>
> 编号 `L-PS-01…47`。加装与激活面的八条（`L-PS-40`…`L-PS-47` 与本册 §6 的 `L-PS-28/29/30/32`）
> 在 2026-10-04 追加：**只读 / 写入+任务自主 / 浏览器三档已激活，sidecar 与扩展已首连，
> 且 ADR-101 的自启动已实现**；但**三档都还没有真实使用读数**，登录态继承也还没拿到证据，
> 自启动的**真入口**路径同样还没有被启动过（验收用的是替身）。

---

## 1. 全盘文件域

```text
L-PS-01  **不在范围内**（判据，不是"暂时没实现"）：
           网络共享（UNC）、设备命名空间（\\?\ / \\.\）、NTFS 备用数据流（ADS）、
           Windows 保留设备名（CON/PRN/AUX/NUL/COM1…/LPT1…）、`..` 跳出卷根。
         一律以 `permission_denied` 拒绝，且**未触碰真实文件系统**。
L-PS-02  **单动作入口对"不带引号的空格路径"不猜**：`读一下 C:\a b c.md` 的边界没有
         确定答案（可能读到 `C:\a`，那是**另一个位置**）。支持形态是**带引号**
         （`读一下 "C:\a b c.md"`）或**任务环里的结构化路径**。
         ⚠️ 离线验收对这两条各有一条读数（file-01）。
L-PS-03  写入是**整文件替换**：没有按字节区间写、没有追加语义；> 10 MiB 被拒。
L-PS-04  恢复副本**只针对明确目标**：没有整盘恢复、没有保留策略、没有自动清理。
L-PS-05  并发修改检查**只在调用方给出 `expectedOriginalFingerprint` 时生效**；
         没给时如实记 `并发检查=false`（不假装查过）。
L-PS-06  首版**不新增**删除 / 移动 / 重命名；**不主张** NTFS ACL、EFS 加密属性、
         备用数据流的完整保真。
L-PS-07  `payloadFingerprint`（`fnv1a64`，kernel 侧算）与 `effect.fingerprint`（`sha256`，
         适配器算）是**两个算法、各有用途、不可互比**。报告里不许把两者当成同一个读数。
```

## 2. 任务执行环

```text
L-PS-08  预算是硬闸：每任务 30 次行动 / 6 次规划 / 10 分钟。超限即停，**不续跑**。
L-PS-09  授权是**内存**的：进程重启后任务如实消失（不"继续运行"）。
L-PS-10  规划器与搜索判定器共用同一个端点/模型（`OPENAI_SMALL_MODEL`）；
         输出上限 8000 token ⇒ 计划里带很长的正文时可能被截断 ⇒ 计划作废（如实不执行）。
L-PS-11  "必要时修正后续步骤"是**有限**的：模型只看到闭集事实
         （`能力.操作=状态` 与失败码），**看不到失败原文** ⇒ 修正靠换做法或重试，
         不靠读错误细节。这是刻意的（失败原文可能夹带用户正文）。
L-PS-12  越权与外泄的两道闸都在**程序侧**（能力集合 + 参数白名单），
         但"模型会不会给出好计划"本身**不在本批判据内** —— 离线用的是脚本化规划器。
```

## 3. 天气

```text
L-PS-13  **单 provider**（Open-Meteo 固定两跳），不自动换 provider。
L-PS-14  不读浏览器 GPS、不从聊天片段推断住址；没有城市就**不产生请求**。
L-PS-15  "当前天气"是**天气模型口径**，不是现场气象站实测（事实面逐字写明）。
L-PS-16  **没有缓存**：每次真的请求。"旧数据"这一档由"事实面写明预报有效时间与获取时间"
         覆盖，而不是由缓存策略覆盖。
L-PS-17  真出站依赖本机网络：本机只有 HTTP 代理，而适配器用 `globalThis.fetch` 直连固定域名
         ⇒ 无直连出站时**如实失败**（不是"编一个数"）。C 集里跑真读数。
```

## 4. 办公生成

```text
L-PS-18  **排版视觉查看未做**：没有已验证的渲染器 ⇒ 只证明"重新打开后结构可读回"，
         **不证明**视觉排版已通过。计划书 §3.2 明说"不能把 XML 可读当成视觉排版已通过"。
L-PS-19  公式只支持白名单函数（SUM/AVERAGE/MIN/MAX/COUNT/COUNTA/ROUND/ABS/IF）
         与单元格引用；**不写宏、不外链、不做复杂模板修改**。
L-PS-20  首版交付**可编辑 Office 文件**；PDF 导出是后续切片。
L-PS-21  依赖**既有专属 venv**（python-docx 1.2.0 / python-pptx 1.0.2 / openpyxl 3.1.5）。
         venv 缺失 ⇒ 办公三组如实 `NOT RUN`，**不降级**成"用 JS 假装生成了 Office 文件"。
L-PS-22  规模上界：文档 50,000 字符 / 表格 10,000 单元格 / PPT 20 页 / 单文件 10 MiB；
         超限**拒收整条**（不是静默截断）。
```

## 5. 资讯

```text
L-PS-23  单次最多 3 个订阅源 / 10 条候选 / 5 条交付。
L-PS-24  发布时间未知时**如实标注未知**，绝不用抓取时间冒充发布时间。
L-PS-25  只按链接去重 ⇒ "多家转载同一条"**不在**本适配器的判别范围内（转载 ≠ 独立验证）。
L-PS-26  深读交 `web.read`，因此仍受后者的限制（静态正文 / 2 MiB / 无登录态 / 付费墙读不到）。
L-PS-27  拒绝 DTD / 实体声明（解析之前），因此个别用了实体的**老式**订阅源读不了
         —— 那是刻意的取舍（XXE 与实体展开的入口）。
```

## 6. 浏览器

```text
L-PS-28  **真实登录态继承与桌面焦点影响未验证**（需要人工首连真实 profile + 官方扩展）。
         离线 ①②③ 组用的是**受控假 sidecar** ⇒ 它们**不构成**"已登录会话可用"的证据。
         ⏩ 2026-10-04：sidecar **已装**（`@playwright/mcp@0.0.83`，专属目录 + 专属 lockfile，
         `npm --ignore-scripts` ⇒ **不含浏览器内核**）；**官方扩展未装**、首连未做 ⇒ 本条照旧。
L-PS-29  sidecar 是**单点**：连不上就是如实失败，**不**降级到一个丢失登录态的独立 profile。
         ⚠️ 因此启动参数里**不许**出现 `--isolated`（它正是那个"独立 profile"）。
L-PS-30  只允许 7 个 MCP 工具名；**没有**任意 JS、网络响应抓取、文件上传下载、全浏览器关闭。
         ⚠️ 也不许用 `--caps vision,pdf,devtools` 把这些面从 sidecar 侧打开。
L-PS-31  "点击/填写成功"的判据是**sidecar 的返回 + 我方读回**，不是"工具说成功"；
         但上游 sidecar 自身的可靠性**不在**本批主张内。
L-PS-32  焦点影响的处置（必要时对上游作最小受控修补并保留回退版本）**尚未执行**。
```

## 7. 公共 / 工程

```text
L-PS-33  本批**不做**：通用插件框架、数据库迁移、人格改动、新后台调度、定时监控/自动推送。
L-PS-34  验收读数里的 `head` 可能因**多会话共享同一工作树**而在一次运行期间移动
         （本轮实测发生过一次：另一个会话在我运行期间提交）。
         ⇒ **以 `run.json` 的 `sourceHashes`（逐文件指纹）为准**，不以 `head` 为准。
L-PS-35  离线验收替换了两样东西：**模型服务**与**出站 IO**。其余全是生产实现。
         因此"离线 28 组全绿"**不等于**"真实链路全对"（AGENTS.md §6.1）。
L-PS-36  真模型短链（`--live` 八场景）的天气与资讯两场景依赖真实出站；
         本机若无直连出站，它们的读数是**如实的 FAIL/NOT RUN**，不是"能力不存在"。
```

## 8. 与既有里程碑的关系

```text
L-PS-37  本批**没有**改动 M4.5 的冻结面：
           `createDefaultCapabilityDefinitions()` 仍只返回那三个能力；
           `DEFAULT_GRANTED_PERMISSIONS` 仍是 `system:echo` + `sandbox:read/write`；
           沙箱策略的三句措辞**逐字不变**（新的本机域措辞是**可注入的**另一套）。
L-PS-38  `TurnContent` 的种类从 4 扩到 5（`local-text`）、来源类别从 4 扩到 6
           （`local-disk` / `remote-service`）、每轮条数上限 2 → 6。
         这三处都是**具名追加**（计划书 §2.2 要求），且都有回归读数
         （`common-02` 断言第一批四项的措辞与行为不变）。
L-PS-39  `M5.1-D01` 的归因链**未被绕过**：任务环的每一步都挂**同一个** traceId、
         同一份受信 initiator 证据（`common-07` 有读数）。
L-PS-40  加装/激活面（2026-10-04 追加）：生产已开**三档** ——
         `ADR-097` 只读 · `ADR-099` 写入 + 任务自主 · `ADR-100` 浏览器；
         **2026-10-05 修订**：天气 / 办公生成 / 资讯已依 [ADR-103](../adr/ADR-103-productivity-weather-office-news-activation.md) 开启，程序回读三项均为 true。
         ⇒ 三项正式配置已启用，新启动的 LG 会加载；既有隔离 PASS 承接时已核对源码指纹。
         ⚠️ **本次新启用三项的首次真实使用仍未观测**（`FIRST-USE NOT OBSERVED`）：
         "配置生效"与"她在真实对话里读到/写过"是两件事。
         ⚠️ 写入档**必须与任务自主一起开**：写请求只由任务执行环产生，
         单开写入档在读数上与"没开"无法区分（`local-file-intent.ts` 文件头第 3 条）。
L-PS-41  浏览器 sidecar **已装且已首连**（`@playwright/mcp@0.0.83` 装在专属目录/
         专属 lockfile、`--ignore-scripts` ⇒ **不含浏览器内核**；官方扩展已装、relay 握手成功、
         LG 的生产适配器读到了页面）。⚠️ 但**登录态继承仍未验证**：
         relay 附着在 sidecar 自己打开的**连接页标签**上（上游 `tabs.update(active:true)`
         的副作用 —— 计划书 §3.4 预警的焦点影响，本机已亲眼看到一次），
         而那个连接页**没有标签选择器**。要拿到证据：在**那个标签里**打开目标网址，
         再用 `--expect-url` 命中。详见 `ADR-100` §3 与
         [`Productivity-Skills-Browser-First-Connect.md`](Productivity-Skills-Browser-First-Connect.md)。
L-PS-42  **桌面焦点影响已在首连时被观察到一次**（连接页被顶到前台）。
         计划书 §3.4 要求的"若正常动作也抢焦点 ⇒ 对该调用作最小受控修补并保留上游回退版本"
         **尚未执行** —— 要先确认"正常动作"（`browser_snapshot` / `navigate`）是否也抢焦点。
L-PS-43  **自启动（ADR-101）把焦点影响从"可能"变成"每次启动都有"**：LG 启动时会拉起
         sidecar，而上游每次 `--extension` 启动都会**弹出一个浏览器连接页**
         （`_openConnectPageInBrowser` 无条件调用）。这是**已知且已登记的代价**，
         不是缺陷；不想要就把 `CHARACTER_BROWSER_SIDECAR_AUTOSTART` 关掉。
L-PS-44  **自启动的真入口路径记 `NOT RUN`**：验收用的是**替身 sidecar**
         （17 通过 / 0 失败），因为真入口每跑一次就弹一次浏览器窗口。
         真入口的首次实测 = 用户下次启动 LG 那一次（那次本身就是真实链读数）。
         ⇒ **"自启动验收全绿"不等于"真入口已经被启动过"**。
L-PS-45  **"指向哪个标签"永远是人工的**：LG 装不了扩展、也不该替用户决定看哪一页
         （ADR-101 §1 的事实①）。⇒ 自启动省掉的是**终端那一步**，不是全部人工步骤。
L-PS-46  自启动**不做**：不装扩展 / 不改用户 profile / 不把 sidecar 变成常驻服务
         （不写注册表、不开机启动、不建计划任务）/ 不查 PATH / 不用 npx / 不联网装包。
L-PS-47  租约的"还活着吗"判据是 **PID 存活 + 端口健康**，而不是设计里写的
         "PID + 启动时刻双匹配"（ADR-101 §6.1 记了偏差与理由）。
         后果：**我们永远不会 kill 一个不是自己起的进程**，代价是"租约活着但不健康"时
         只能如实报出来、由人处置，不会自动回收。
```

## 9. 当轮内容汇聚（2026-10-05 事故后追加）

> 事故、修法与读数：[`Productivity-Skills-Turn-Content-Overflow-Fix-2026-10-05.md`](Productivity-Skills-Turn-Content-Overflow-Fix-2026-10-05.md)。
> 跨里程碑登记：[`Tech-Debt-Register.md`](../Tech-Debt-Register.md) §0r（`R-53`）。
> 这三条是**修复之后仍然成立**的边界，不是"没修完"。

```text
L-PS-48  **单步重复仍会执行**：新的进度闸只挡"整份计划都是已经成功过的引用 + 同一个操作"
         （`no_progress`）。计划里混着一步已做过的 + 一步新的 ⇒ **照常执行那一步已做过的**
         —— 这是刻意的（"写完再读回来核对"是合理的重复），代价是同一个引用仍可能被列两次，
         行动预算与账本行数照旧要付。
L-PS-49  汇聚**丢弃不进回复守卫**：同源去重与超上限丢弃只落在
         `IncomingTurn.turnContentAggregation` / `turn_content` 那一步的 trace / stderr，
         **没有**进回复的来源与范围附录。⇒ 真的丢掉**互不相同**的内容时，她不会说
         "我只看到了其中 6 份"（`common-05` 的 ⑦ 组只证明"轮次不再失败、计数如实"）。
L-PS-50  "不要重复列举"的另一半靠**规划器指令**（措辞层）：
         摘要里带引用是机械事实，但"看到引用就别重复"是模型行为 —— 先例 `DR-11`：
         措辞层**没有**启发式守卫，机器保证只到"摘要把事实给到它"与"整份计划打转就停"。
```

## 10. 与既有里程碑的关系（续）

```text
L-PS-51  2026-10-05 的修复**没有**动冻结面：`TurnContent` 的种类/上限值/逐份断言**一个字节未改**
         （8 份在契约层仍然不合法，`common-05` 的 ⑥-e/⑥-f 是这条的机器判据）；
         降级发生在**汇聚层**（`aggregateTurnContentForTurn`），选择器仍然按额度丢弃。
         改动面：`src/kernel/contracts/turn-content.ts` · `src/kernel/app/turn-gateway.ts` ·
         `src/kernel/action/{task-loop,task-plan,task-authorization}.ts` ·
         `src/infrastructure/model/openai-task-planner.ts` ·
         `src/kernel/app/bridge/turn-bridge.ts`。
```

## 11. 全工具档（2026-10-09 · 用户 C 档授权 · 载体 `ADR-125`）

```text
L-PS-52  这是**字面意义的全开**：`browser.mcp`（任意工具入口）可达 72 个上游工具，
         含 browser_evaluate / browser_run_code_unsafe（在已登录浏览器里执行任意 JS）、
         --caps=storage（cookie / localStorage / sessionStorage 读写）、网络响应正文、
         任意路径文件上传、响应改写、关闭整个浏览器。
         ⚠️ **没有为提示注入加任何护栏**：她会读网页正文（web.search / web.read 同轮可用）
         ⇒ 恶意页面可以诱导她把凭据读出来。这条是本次授权**已知且接受**的代价。
L-PS-53  幂等声明是 'supported'（登记口拒收 destructive+none）⇒ 同一 tool + 同一份 toolArgs
         成功过一次之后，之后**任何一轮**再出现同形状调用都会拿到**账本里那次的结果**
         （idempotentReplay），而不是新执行。写类工具这是保护；**读类工具意味着可能不是最新的**
         ⇒ 要新读数就必须让参数真的不同。
L-PS-54  令牌与连接页（2026-10-09 实测）：扩展模式**每个 MCP 会话各自**一个 relay + 一张 connect 页
         + 一个标签组（上游 `createExtensionBrowser` 按 `clientInfo.clientName` 建，LG 没传
         `--shared-browser-context`）⇒ **共享的标签不会跨会话继承**：LG 每次重启（或任何新会话）
         都要**在新弹出的那张 connect 页标签里**打开目标网址。实测 `pnpm productivity:sidecar:check`
         对一个新会话读到的就是它自己那张 connect 页（EXIT 2 = PARTIAL）。
L-PS-55  同一实测：connect 页的 URL 里带着 `token=`，而 `browser_snapshot` 的正文含 `Page URL:` 一行
         ⇒ **让她读连接页 = 把扩展 token 送进她的上下文**。LG 适配器**不打码**
         （打码只在 `sidecar-connect-check.ts` 里）。token 一旦进过截图/聊天/日志 ⇒ 按已泄露处理。
L-PS-56  本档**不改**任何既有主张：老 8 个页面动作的参数闭集一字未改（`action=evaluate` 仍然
         `validation_failed` 且零出站）；全局 `CHARACTER_ACTION_MAX_RISK` 仍 R1；`browser.mcp`
         只在 `CHARACTER_BROWSER_FULL_TOOLS=true` 且任务额度抬到 R3 时可达（`browser-05` 有正负控）。
         真机"登录态继承 / 焦点影响"仍是 `browser-04` 的 C 集（`NOT RUN`，本次也**没有**补）。
```

## 12. browser-04 真机实测读数（2026-10-09）

> 载体：[`Browser-04-Live-Readings-2026-10-09.md`](./Browser-04-Live-Readings-2026-10-09.md)（方法 / 原始读数 / 混淆项）。
> ⚠️ **门本身仍是 `NOT RUN`** —— 这三条不可能无人值守判定；下面是**人工实测**的读数，不冒充机械判据。

```text
L-PS-57  ① **登录态继承 = 成立**（两条独立证据）：`/settings/profile` 与 `/settings/repositories`
         这两个"未登录进不去"的页面都进去了（后者标签标题变成 "Repositories"），
         且 github.com 首页是登录视图（Dashboard / Pull requests / Issues，无 Sign in/Sign up）。
         ⚠️ 这证明"用的是真实 profile 的会话"，**不证明** LG 会去读 cookie 值 ——
         本次**没有**调用任何 cookie / storage / evaluate 工具（隐私边界见载体 §隐私）。
L-PS-58  ② **焦点影响 = 不确定（两次里中一次）**：400ms 时间线在 `initialize` 后 0.47s 抓到
         "前台从 Edge 跳到 chrome | Welcome（connect 页）"；受控复测（先确保前台=Edge、
         再建会话 + 只发一次 navigate，150ms 采样）**全程没跳**。
         ⇒ **不是必然**，也**不是"从不"**；n=2 **不是比率**。
         两个混淆项：那次跳转期间**用户正在操作机器**（不能单独当作扩展行为）；
         **本测量没有覆盖 sidecar 启动**那一次（`L-PS-42/43` 量的是另一件事，两者不矛盾）。
L-PS-59  ③ **用户标签保留 = PARTIAL**：标签**没少**（用户原有那张 `GitHub` 一直在，两次采样稳定），
         但**当前选中被切到代理的标签**（那个窗口标题变成 "Repositories"）
         ⇒ "你打开的其它标签没被切走"这条**不成立**。
         ⚠️ 另有**未能归因**的变化：`Playwright Extension Status` 与 3 个 `Welcome` 在测量期间消失；
         本次我发出的调用只有 `browser_tabs{list}` / `browser_navigate` / `browser_snapshot`
         —— **没有 close 类调用**，所以不是我的调用关的，但也不能证明是谁关的。
L-PS-60  顺带证实 `L-PS-54` 的结构性事实：**每个 MCP 会话各自一个标签组**
         （两个会话 → 两个 `属于"Playwright · <clientName>"群组` 的标签）。
```

## 13. 诊断工具自身的副作用与"核心入口"误判（2026-10-09 追加）

```text
L-PS-61  `pnpm productivity:sidecar:check` **不是只读无害**：它的 clientName 与生产**同为
         `project-lg`** ⇒ 每跑一次就会在你的浏览器里**新开一张 connect 页**（组名变成
         `project-lg (2)`、`(3)`…），而且那张新标签会**成为当前选中**（窗口标题跟着变成 "Welcome"）。
         2026-10-09 实测：为了排查她"无法访问"，我跑了两次自检 ⇒ 浏览器里多出 `project-lg (2)`
         那张 Welcome 标签并抢走选中。⇒ **她正在用浏览器时不要跑这个自检**；
         要排查就先说清"这会多一张标签"。
         ⚠️ 与之配套：**清理只能由人做**（关掉那张 `project-lg (n)` 标签）——每个会话只看得见
         自己组里的标签，所以代理**无法**收拾自己上一次留下的标签。
L-PS-62  **"核心"不一定叫 `src/main.ts`**：生产入口还可以是 `scripts/postlv2-bridge-production.ts`
         （2026-10-09 实测：它才是当时持有生产库租约的进程）。用 `src\main\.ts` 过滤进程会得出
         "核心没在跑"的**错误结论**，并去"重启"一个其实在跑的服务 —— 本次那两次重启都被
         `[lease_failed] production_db_in_use` **正确地挡住**了（保护生效，不是故障）。
         ⇒ 判定"核心在不在"要看**租约/管道与端口**，不要只看进程名。
```

## 14. 浏览器会话自愈，以及"我的新组其实没跑"的更正（2026-10-09 第二轮）

```text
L-PS-63  **会话失效 ⇒ 重建一次并重试**（`src/infrastructure/action/adapters/browser.ts`）。
         真机事故：适配器缓存 `mcp-session-id`、`ensureSession()` 非空即返回，而 sidecar 一重启
         服务端会话就不存在了 ⇒ 之后**每一次**浏览器调用都 404，用户只看到"她一直说访问不了"。
         判据照上游两层代码（`coreBundle.js:73786-73791` / `utilsBundle.js:84913-84914`：
         未知会话 ⇒ HTTP 404 + "Session not found"）。边界：只有 404 **且我们确实带了会话 id**
         才重建；**每次动作最多重建一次**；重建会在结果里加**程序附注**（旧标签绑定已随旧 sidecar
         消失 ⇒ 要在新连接页里重新共享）。
L-PS-64  ⚠️ **`browser-05`/`browser-06` 第一次是"配了但从不执行"**：运行器加进了 `BROWSER_GROUPS`，
         但计划表 `GROUP_PLAN`（跑批按它驱动）**漏登记** ⇒ 读数一直是"28 组"，两组一次没跑过。
         我在提交信息与 ADR 里据此说过"browser-05 正负控 PASS" —— **那句话当时是错的**，
         已在本节与 ADR-125 的"第二轮"里更正（历史读数不回写）。
         ⇒ **纪律：加组 = 加运行器 + 加计划表两处**。
L-PS-65  同轮踩到的三条门床事实（都不是产品缺陷，是"我怎么写门"的错）：
         ```text
         ① 假 sidecar 是**全 suite 共享**的，而 `browser-03` 的"断连"检查会把它 `close()` 且不重启
            ⇒ 排在它之后的组一律 `fetch failed`。新组一律**自建夹具、用完关掉**。
         ② `task-plan.ts` 的 args 值**只接受 string/number/boolean** ⇒ `browser.mcp` 的 `toolArgs`
            必须是**JSON 对象字符串**（不是对象）；否则整条计划被丢弃，表现为"所有判据都没有结果"。
         ③ 任务环要被**任务口吻**触发：陈述句（"在当前页面上执行一段表达式"）不会起任务，
            `say()` 就什么结果都不产生；写成"帮我…"即通过（与 `browser-02` 同形）。
         ```
```
