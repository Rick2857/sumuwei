# WP5 Handoff — Minimal Developer Page

> 计划书要求的交接单。**下次 execution（WP6）先读这份**，再读
> [`WP4-Handoff.md`](./WP4-Handoff.md)（观测边界的裁定与那五条前置）。
> **不要重新探索仓库。**

```text
Completed WP: WP5 — Minimal Developer Page（结论 PASS；页面独立性 verdict = PASS）

Changed:
  src/infrastructure/dev/page.html                 （新增：**一个自包含的静态页面**
                                                     —— 内联 CSS + 内联 JS，零外部资源、零框架）
  src/infrastructure/dev/http-server.ts            （改：新增 `servePage` / `pagePath` 与 **html** 路由；
                                                     `readPageHtml()` 每次请求都读（这样"删掉文件"立刻生效）；
                                                     `developerQueryRoutePatterns()` 排除页面与控制路由
                                                     —— 否则 WP2 那条"正好 8 个"会被页面悄悄改成 9 个）
  scripts/verify-m5.1-page.ts                      （新增：26 项 AT 断言 + 真的删一次页面）
  package.json                                     （改：只新增 "m5.1:page:verify"）
  docs/苏沐薇-使用说明.txt                          （改：`--dev-server` 的说明补上"网页"这一段；已 doc:sync）
  artifacts/m5.1/page-evidence.json                 （新增）
  docs/m5.1/WP5-Handoff.md                          （本文件）
  docs/architecture/README.md                       （改：登记 m5.1:page:verify 与 WP5 文档）

Tests（全部 exit 0）:
  pnpm m5.1:page:verify → **27 通过 / 0 失败**
  pnpm m5.1:test 52 · m5.1:query:verify 56 · m5.1:control:verify 41 · m5.1:observability:verify 27
  pnpm kernel:test 26 · m3.5:test 30 · m4:test 243 · m5:test 30 · typecheck · doc:check

Evidence: artifacts/m5.1/page-evidence.json
  pageIndependenceVerdict = PASS

  WP5 ACCEPTANCE（**真的删了一次**，不是承诺）:
    page.html 被移走 → `GET /` 回 **404 + developer_page_missing**（不是 500、不是空白）
    → 其余 **9 个端点**（8 查询 + 控制白名单）的响应**逐字节不变**（changedEndpoints = []）
    → 还原后内容与删除前**逐字相同**（restoredIdentical = true）
    静态面另外证明：`page.html` **零 import**、全仓库只有 `http-server.ts` 提到它、
    kernel 侧不 import 任何 dev 面模块 ⇒ 删除它不可能连带任何核心路径（静态导入图里没有路径）

  AT5.1–AT5.7 逐条:
    AT5.1  guard 复用 `--dev-server`（页面**没有**自己的开关）；只绑回环、逐请求验对端
    AT5.2  总览：health + capabilities + 最近 trace + **最近失败**（status=failed）
    AT5.3  Trace 浏览器：列表 + 详情；trace tree 由 `steps[]` 画（`'├─ '` 那一行是判据）
    AT5.4  记忆诊断：stats + integrity；**没有**任何修改记忆的入口
    AT5.5  执行检查：列表 + 详情，展示 request/intent/targetType/attempt/result/verification/evidence
    AT5.6  控制按钮**来自服务端的白名单端点**（脚本里不含任何命令名字面量）；
           只有**一个** POST，且只打到 `/control/commands/`；
           用页面会拼的那个信封（surface=page, dryRun=true）实测 → accepted 且未执行；
           未知命令仍然 400（页面拿不到"万能控制台"）
    AT5.7  零外部资源（无 http(s):// / 无外链脚本 / 无样式表外链）、
           无框架标记、无 `type="module"`；并且页面的 JS 过 `node --check`
           （一个语法错误会让整页白屏，而白屏在"端点都 200"的判据下完全看不见）

Known issues（三条）:
  1. **页面的 DOM 渲染没有自动化覆盖**：仓库里没有浏览器测试链路，
     本门证明的是"页面要的端点都对、页面的形状合法、删掉它什么也不影响"，
     而不是"按钮点下去界面长成什么样"。
     一个可选的补强：用会话里的浏览器技能人工打开确认一次（本 WP 记录该边界而不假装覆盖）。
  2. **页面是单文件静态资产，没有构建步骤**（这是 AT5.7 的要求，也是它的代价）：
     它不能复用服务端的 TS 类型 —— 页面里的字段名（`detail.verification.state` 等）
     与 DTO 之间**没有编译期约束**。契约一变，页面会在运行时静默少显示一块。
     判据：`scripts/verify-m5.1-page.ts` 的 AT5.5 断言钉住了它读的那七个字段名。
  3. `GET /` 每次请求都 `readFileSync`（为了让"删掉文件"立刻生效）。
     对 loopback + 单用户 + 开发模式这是可接受的；将来若把它做成长期服务，
     应当加一个 mtime 缓存。

Interfaces exposed to next WP（WP6 直接消费）:
  · `GET /` → 开发者页面（资产缺失 → 404 `developer_page_missing`）
  · `startDeveloperQueryServer` 的 `servePage?: boolean` / `pagePath?: string`
  · `readPageHtml(pagePath?)` → `string | undefined`（读不到不抛，是**被支持的**状态）
  · 路由表现在有四种 `kind`：`page` / `lookup` / `control` / `html`
    （每种只有一条状态码规则，handler 改不了状态码）

Do not modify（WP6 只消费）:
  · "页面跟着 `--dev-server`，不建第二套开关"这条（AT5.1）
  · 页面**只**消费 `/dev/query/*`：不得让它读 persistence、不得让它自己实现控制逻辑
  · 页面**不硬编码**命令名（按钮来自白名单端点）
  · `page.html` **零 import** 这条性质（它正是"删掉它不影响任何东西"的依据）
  · `developerQueryRoutePatterns()` 只含 8 个查询端点（页面/控制路由不算）
  · 四道闸、`unwrapLookup`、控制面的阶梯语义（WP2/WP3 的）
  · 冻结区：`contracts/{memory,trace,recall}.ts` / `migrations.ts` / `kernel/app/memory/**` /
    `memory-validator.ts` / `memory-store.ts` reducer 语义 / `infrastructure/telemetry/**`（WP4 的边界） /
    `src/character/苏沐薇.ts` / prompt 基线

Next WP prerequisites（WP6 OSS Integration Audit & Spike）:
  1. WP6 是**只出文档**的一包：`M5.1-OSS-Audit.md` + `ADR/{Observability,Memory-Infra,MCP,Workflow,Sandbox}.md`。
     不落代码（G-06：除 Observability interface 外只允许 audit / spike / adapter experiment / ADR）。
  2. 已经有**一份**可直接引用的先例：`ADR-036`（观测端口边界）与
     `docs/m4/ADR-M4-MemOS.md`（MemOS 的 REJECT 判据）。WP6 的每个裁定都要写出
     `Landing Target / Authority Boundary / Replacement Strategy / Failure Isolation / Future Milestone`。
  3. 已知的**落点事实**（别重新探索）：观测后端今天只有 `phoenix` adapter（手写 OTLP，零 SDK）；
     记忆后端门禁在 ADR-026/027；`src/observability/` 是**空目录**（F-6，WP4 已在 ADR-036 里
     说明端口为何住在 `infrastructure/telemetry/`，WP6 若要再动它就写进 ADR）。
  4. **不要把 spike 结果写成生产代码**：本轮只允许 ADR 级别的裁定（G-06）。
     若某个候选要进核心，先开 Blocking Issue Report 走用户裁定。
```
