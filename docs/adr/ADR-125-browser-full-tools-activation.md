# ADR-125：浏览器全工具档（任意工具入口）—— 部分推翻计划书 §3.4

日期：2026-10-09。状态：**代码已实现 · 生产已激活并已重启生效**（真机读数见下）。

## 背景与用户授权

用户先要求「更新一下新版，并且启用所有工具」。侦察后我把两件事分开摆明：

1. **没有新版可更**：`@playwright/mcp` 的 npm `latest` = **0.0.83**（2026-09-28 发布），
   GitHub 最新 tag 也是 **v0.0.83**；本机装的就是它。而文档站上那套 cookie / localStorage 工具
   **并不在"更后的版本"里** —— 它们在**这份已发布的 0.0.83 代码里**（`capability: "storage"`），
   只是默认没开 caps。⇒ 本次**不升级任何组件**。
2. 「启用所有工具」**不是一个开关**：上游工具表由 `--caps` 决定（25 → 72），
   而"LG 允不允许调用"是内核的一条闭集策略（原本 7 个名字）。

我给出三档并**逐条写明代价**后，用户明确选择：

> **「C 档：字面意义的全开」** + **「现在做，接受短暂中断」**

即：包含 `browser_evaluate` / `browser_run_code_unsafe`（在用户已登录的浏览器里执行任意 JS）
与 `--caps=storage`（读写 cookie / localStorage / sessionStorage）。本 ADR 就是这次授权的载体，
也**逐条记下**它推翻的东西。

## 决策

1. **部分推翻计划书 §3.4**。§3.4 原文："不向模型暴露任意 MCP 工具入口。
   禁用任意 JavaScript/服务器代码执行、网络头正文抓取、无约束文件访问和全浏览器关闭等非必要工具。"
   本次推翻的是**"LG 永不接线"这个结果**；**没有**推翻当初排除它们的理由。
   ⇒ 那些能力**只**经一条单独登记、单独开关、单独声明风险的路可达。
2. **两层闸门，各自独立、各自可回滚**：
   - sidecar 层：`CHARACTER_BROWSER_SIDECAR_CAPS`（逗号分隔，**闭集校验**，非法名字逐个丢弃并告警）
     ⇒ 决定工具表有几个工具（`config,devtools,network,pdf,storage,testing,vision` ⇒ 72 个）；
   - 内核层：`ALLOWED_MCP_TOOLS`（72 个具名）+ `CHARACTER_BROWSER_FULL_TOOLS`（代码缺省 false）
     ⇒ 决定 LG 会不会真的调用。
   **两层都要成立**才可达；任一层关掉即回到旧形态。
3. **新增独立能力 `browser.mcp`**（`browser:mcp`，operation `call`，参数闭集 `tool` / `toolArgs`），
   声明 **destructive / R3**、**不支持 dryRun**（"什么都可能做"的入口没有诚实的干跑语义）。
   刻意**不**把它塞进 `browser.operate` 的闭集：老那 8 个 action **一个字都没改**，
   `action=evaluate` 仍然 `validation_failed` 且**一个包都不发**（负控仍在，见 `groups-browser` 的 `browser-03`）。
4. **任务额度**：只有在 `browserFullTools` 且 `browserEnabled` 同时成立时，才把**任务级**额度抬到 **R3**；
   全局 `CHARACTER_ACTION_MAX_RISK`（缺省 R1）**一个字都不改**。R2 额度下 `browser.mcp` 被策略拒
   （具名读数 `risk_exceeds_limit` 形状见 `browser-05` 负控①）。
5. **白名单不是手写的**：按上游自己的 `filteredTools` 规则（`能力以 "core" 开头 ∪ caps 里的能力`，
   再剔除 `skillOnly`）从装好的 `coreBundle.js` 算出 72 个；`scripts/productivity-skills/sidecar-tools.ts`
   里**独立抄写**同一份读数，两侧做**双向**核对（"漏一个"也是失败）。
6. **回滚 = 删 `.env` 里两行**（代码缺省：`FULL_TOOLS=false`、caps 为空）。
   回滚后：工具表回到 25、`browser.mcp` 不在能力清单里、权限不授予、额度回到 R2/R1。

## 风险清单（**逐条如实**，不淡化）

| 放开的东西 | 具体后果 |
|---|---|
| `browser_evaluate` / `browser_run_code_unsafe` | 在**用户已登录的浏览器**里执行任意 JS：可读出任意站点在**当前标签可及范围内**的一切 |
| `--caps=storage`：`browser_cookie_*` / `localstorage_*` / `sessionstorage_*` / `storage_state` | 会话凭据可被**读出并进入她的上下文**（⇒ 进模型调用、进当轮内容、进 trace 引用），等于会话劫持面 |
| `browser_network_request(s)` | 网络响应正文绕过 `web.read` 的准入与上限 |
| `browser_file_upload` / `browser_route` / `browser_unroute` | 任意路径文件上传、页面响应可被改写 |
| `browser_close` | 关掉**用户正在用**的浏览器 |
| **组合风险** | 她会读网页正文（`web.search`/`web.read` 同轮可用）⇒ **提示注入**可诱导她把凭据读出来发出去；本次授权**没有**加任何针对这一点的护栏 |

**另记**：2026-10-09 的排查里，扩展 token 曾出现在用户截图与我的探测输出中
⇒ 按仓库既有纪律当作**已泄露**，需在扩展状态页重新生成并更新 token 文件。

## 不主张（避免把这次授权读成更多东西）

- **不主张**"她现在能分得出你登没登录了"：读页面快照本来就足以判断登录态
  （登录后有头像 / `Your repositories`）；读 cookie 是**另一种目的**。
- **不主张**已通过语义/行为评测：本次没有跑任何语义评测、没有真人体验读数。
- **不主张**真实已登录 profile 的整链已验收：那仍是 `browser-04` 的 C 集（`NOT RUN`）。
- **不主张**"读到的 cookie/storage 仍然有效或新鲜"：上游返回什么就是什么。
- **不主张** `m4.5:ci` 已跑：它要求生产库热复制前**先停服务**（§5.1），留到停机窗口。

## 幂等接口的诚实边界（登记口逼出来的一个真问题）

第一版把 `browser.mcp` 声明成 `idempotency: 'none'`，`pnpm typecheck` 通过、而**门当场拒收**：

```text
CapabilityRegistry 声明不合法：
destructive_without_idempotency: browser.mcp 是 destructive 却没有声明幂等 —— 重试即重复破坏
```

这条规则不能用"改成 `supported` 糊过去"，所以先把语义查清：

- `'none'`：不查历史；`'supported'`：查历史，键由 `{capability, operation, target, args}` 推导；
  `'required'`：查历史**且**请求必须显式带键（否则策略拒）。
- 本仓库的 `'supported'` **真的会被执行**（`gateway.ts` 在执行前 `findByIdempotencyKey`，
  命中可重放者 ⇒ 直接重放、**不再执行**）。

⇒ 这里声明 `'supported'` 是**真话**，同时有**真代价**（已登记）：

1. **同一 tool + 同一份 toolArgs 成功过一次之后，第二次拿到的是账本里的那次结果**
   （`idempotentReplay`），不是一次新执行。写类工具这正是要的保护；
   读类工具则意味着"可能不是最新的"⇒ 需要新读数时必须让参数真的不同。
2. 键不区分任务/会话 ⇒ 跨轮的同形状调用也会命中重放。
3. 因为无法真正保证"任意工具都幂等"，**不**声明 `'required'`：那会让每一次调用都因为
   缺显式键而被策略拒（等于"开了却永远用不了"）。

## 收尾：把这两道浏览器门纳入门表（2026-10-09，用户要求）

**问题（可复核）**：`productivity:verify` / `productivity:sidecar:autostart:verify` **不在**
`scripts/gates/manifest.ts` 的 `ALL_GATES` 里 ⇒ `affected-map` 引不到它们（引用不存在的门会失败关闭），
于是改 `browser-capability.ts` / `browser-operations.ts` / 浏览器适配器时，`pnpm fast` **一道浏览器门都不跑**。
这与 2026-10-06 修掉的"QQ 主动联系不在 affected-map 里"是**同一个结构缺口**。

**为什么以前进不了表（真原因，不是疏忽）**：`productivity:verify` 的退出码把两件事压成一档 ——

```text
"只有 NOT RUN"（缺人工前置）与"有断言失败"都返回 1
⇒ 门表要么接受 1（等于连 red 一起接受），要么永远进不了表
```

**修法（两步，各自可判）**：

1. **让这道门自己把两档分开**（`scripts/productivity-skills-verify.ts`）：

   ```text
   0  全干净          1  **只有** NOT RUN（仍是"不算过"）       3  有 FAIL / MEASUREMENT INVALID
   2  门自己抛错（既有语义不变）
   ```

   ⚠️ 刻意**不**把两档合成一个非零码，也刻意**不**改"NOT RUN 不算过"这条口径 ——
   改的只是"能不能被机器分辨"。逐条理由写在该文件与门表里。
2. **登记 + 只接受 1**（`scripts/gates/manifest.ts` 的 `PRODUCTIVITY_GATES`）：
   `productivity:verify` 带 `acceptExitCodes: [1]` 与逐字理由（唯一被接受的 NOT RUN 是需真人前置的
   `browser-04`）；`productivity:sidecar:autostart:verify` 无例外码。
   新增 lane `productivity`；`affected-map` 新增一条规则覆盖浏览器能力 / sidecar / 第二批床。

**读数（2026-10-09）**：

```text
pnpm gates:verify                  PASS（51 项断言 · 0 失败）—— 新登记的门通过 G1/G2 自证
node tsx scripts/gates-run.ts --lane productivity
                                  2 道 · PASS 2 · FAIL 0
                                  productivity:verify 88.8s **exit=1 被显式接受**
                                  productivity:sidecar:autostart:verify 4.3s
```

⚠️ **不登记的**：`productivity:sidecar:check`（要一份已连通的扩展与一个被共享的标签，
退出码 2 = PARTIAL 是常态，见 `L-PS-54`）与 `productivity:wp0`（基线采集工具，不是判据）。

## 后补（第二轮，2026-10-09）：两处**更正** + 会话自愈

### 更正①：`browser-05` / `browser-06` 当时**从未执行**（我前面的说法是错的）

本 ADR 上文与提交 `5376cdb8` 的信息里写着"`browser-05` 正负控 PASS"。**那句话当时是错的**：
运行器加进了 `BROWSER_GROUPS`，但跑批按 `GROUP_PLAN` 驱动，而它**漏登记**这两个组
⇒ 读数一直是"28 组"，它们一次都没跑（这也是为什么"参数化输入"只从 102 涨到 104）。
补登记后重跑，两个组**当时都是 FAIL**，暴露了三条门床事实与一条产品缺陷（见下）。
⇒ 历史读数与提交信息**不回写**，更正记在此处与 `L-PS-64/65`。

### 更正②：`browser.mcp` 的 `toolArgs` 是 **JSON 对象字符串**（不是对象）

`task-plan.ts` 的 args 值只接受 `string / number / boolean`，对象会让**整条计划作废**
（症状是"所有判据都没有结果"，不是报错）。⇒ `toolArgs` 改为 JSON 字符串，解析与失败关闭在
适配器里（解析不出来 / 不是对象 ⇒ `validation_failed`，**一个包都不发**）。

### 新增：会话失效自愈（`L-PS-63`）

真机事故：sidecar 一重启，适配器缓存的 `mcp-session-id` 在服务端就不存在了，而
`ensureSession()` 非空即返回 ⇒ 之后**每一次**浏览器调用都 404 ⇒ 用户看到的是"她一直说访问不了"。
修法：未知会话（上游判据：HTTP 404 + `Session not found`，`coreBundle.js:73786-73791` /
`utilsBundle.js:84913-84914`）⇒ 清掉会话、**重建一次并重试一次**，并在结果里加**程序附注**
（旧绑定随旧 sidecar 消失 ⇒ 要在新连接页里重新共享目标页）。边界：每次动作最多重建一次。

### 第二轮读数（2026-10-09）

```text
pnpm typecheck                               EXIT 0
pnpm productivity:verify                     **组：30（PASS 29 · FAIL 0 · NOT RUN 1 · 115 条输入）**
                                             唯一 NOT RUN = browser-04（需真人，已另出真机读数）
                                             browser-05 PASS（8 条输入）· browser-06 PASS（3 条输入）
pnpm m4.5:ci                                 EXIT 0（同一次停机窗口内，见提交信息）
```

⚠️ 组数从 28 变 30 = 计划书 §6A 的 28 组 **+** 2026-10-09 追加的 `browser-05`（全工具档正负控）
与 `browser-06`（会话自愈与边界）；计划书原文不改，偏差记在 `groups.ts` 与本节。

## 验证

```text
pnpm typecheck                                  类型（含 scripts/）
pnpm productivity:verify                        browser-01…05：
                                                · 01/02/03 老形状不变（含"老 action 闭集没被放宽"负控）
                                                · 03 新增：白名单 ↔ 全表**双向**一致、名单外仍全拒、
                                                  8 个高危名字**在名单里**（授权留痕）
                                                · 05 新增：全工具档正负控（evaluate/cookie_list 可达、
                                                  R2 额度被拒、开关关着连提出都不成立、
                                                  名字不在名单 / toolArgs 坏形状 ⇒ 零出站）
pnpm productivity:sidecar:autostart:verify      自启动（caps 项必填，本门用空串）
```

真机读数（2026-10-09，有序停机 → 重启后实测）：

```text
sidecar 进程参数 = ...cli.js --extension --port 8931 --browser chrome \
                   --caps config,devtools,network,pdf,storage,testing,vision   ✅ 生效
tools/list 计数 = 72（重启前 25）· browser_evaluate / run_code_unsafe / cookie_* /
                  localstorage_* / sessionstorage_* / storage_state / pdf_save /
                  get_config / route / unroute / verify_* / mouse_* / resume / close 全部在表
pnpm productivity:sidecar:check --expect-url github.com
  ① 传输层 通   ② 工具表 **一致（真实 72 · 白名单 72 全部存在）**   ③ PARTIAL（见下）· EXIT 2
pnpm productivity:verify = 28 组（PASS 27 · FAIL 0 · NOT RUN 1 · 104 条输入）
  唯一 NOT RUN = browser-04（需人工首连真登录态）—— 与批内历史基线**同形**
  （`docs/post-lv2/Productivity-Skills-Turn-Content-Overflow-Fix-2026-10-05.md:117`：
   PASS 27 · FAIL 0 · NOT RUN 1 · 102 条）。⚠️ 本门 EXIT 1 是**既有口径**（NOT RUN 不算过）。
```

③ 是 PARTIAL 且读到的是**它自己那张 connect 页** —— 那不是本次改动的问题，而是 `L-PS-54`
（每个 MCP 会话各自一张 connect 页与标签组）。**要它变绿必须由人做**：在 LG 那条会话的
connect 页标签里打开目标网址，再重跑 `--expect-url`。

⚠️ **`m4.5:ci` 本次未跑**：它的 G14 对生产库热复制，要求复制前先停服务（计划书 §5.1），
留到下一次停机窗口 —— 与共存激活当时的处置同例（`docs/post-lv2/QQ-Live2D-Coexistence-Activation-Record.md`）。

## 后补：browser-04 三条判据的真机实测（2026-10-09）

本 ADR 生效后补做了一次真机验证（人在场、真实 Chrome profile、真实扩展），读数与**不主张**见
[`Browser-04-Live-Readings-2026-10-09.md`](../post-lv2/Browser-04-Live-Readings-2026-10-09.md)：

```text
① 登录态继承   **成立**（两个"未登录进不去"的页面都进去了；没有读任何 cookie 值）
② 焦点影响     **不确定（2 次里 1 次，0.47s）** —— 不是必然，也不是从不；有用户操作干扰
③ 用户标签保留 **PARTIAL** —— 标签没少，但**当前选中被切到代理的标签**
⚠️ `browser-04` 作为**门**仍是 `NOT RUN`：这三条不可能无人值守判定，上面是人工读数。
```

## 影响面

- `src/kernel/action/browser-capability.ts`（新能力登记）
- `src/kernel/action/browser-operations.ts`（白名单 7 → 72）
- `src/infrastructure/action/adapters/browser.ts`（第三条适配器 + 白名单闸）
- `src/kernel/action/task-plan.ts` / `tool-catalog.ts` / `app/flags.ts`
- `src/infrastructure/action/browser-sidecar-supervisor.ts`（`--caps`）
- `src/main.ts`（能力清单 / 权限 / 任务额度 / 装配）
- `scripts/productivity-skills/{groups-browser,browser-fixture,sidecar-tools,assembly,sidecar-autostart-verify}.ts`
- `.env`（两行；**回滚点**）
