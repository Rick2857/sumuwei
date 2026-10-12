# MemOS PoC 报告（M4 Phase 11 / 计划书第 94 – 103、138 – 142、198、215 节）

- **日期**：2026-09-17
- **被测包**：`@memtensor/memos-cloud-dsh-plugin@0.1.1`（`latest`；另有 `0.1.1-beta.0`）
- **发布**：2026-09-07T09:57:39Z｜shasum `21fcf18e5a71afbe9350f186fefbfb98848e91be`
- **仓库**：`MemTensor/MemOS-Cloud-OpenClaw-Plugin`，目录 `packages/dsh`
- **本机 DSH**：`0.1.5-rc.1`
- **结论**：**REJECT（不用于生产架构）**；判据清单与结论见 `docs/m4/ADR-M4-MemOS.md`
- **方式**：**静态 PoC**（只读取包 + 读代码/文档）。**没有**安装到本工程、
  **没有**启用插件、**没有**发起任何 MemOS HTTP 调用、**没有**使用任何凭证。

> ⚠️ 诚实说明范围：这份报告**不是**一次"跑起来的" PoC。
> 做出结论的是**代码与文档层面的判据**（Q1 / Q3 / Q4 / Q5 / Q7 / Q9），
> 而不是运行时行为。凡属于"没有云凭证就测不了"的项，本文一律标为
> `UNKNOWN-WITHOUT-CREDENTIALS` —— **那不构成失败证据**，也不能被读成失败。

---

## 1. 为什么是静态 PoC，而不是"装上去跑一遍"

ADR-027 已经写死了一条**不可协商**的前提：

```text
PoC 在独立 profile / 独立沙箱上做，不修改主项目。
```

而本次静态检查证明：**"装上去"这个动作本身就会违反项目的核心原则**，
因此"先装再判"的顺序是错的。决定性的一条是 Q7：

| | 证据 |
|---|---|
| 两个**无条件**钩子 | `ctx.on("agent/pre-step", handlePreStep, { prepend: true })`、`ctx.on("session/event", handleSessionEvent)`（`lib/index.js:1073-1074`） |
| recall 自动注入 | 把插件生成的 recall 消息插进本次发送的消息列表（`lib/index.js:1024-1027`，辅助函数 `886-915`） |
| capture 自动上报 | 每一轮结束后自动 add，**没有调用方的逐条决定**（`lib/index.js:1043-1072` + `1034-1042`） |
| 默认全开 | `recallEnabled / addEnabled / includeAssistant ?? true`（`lib/index.js:774-776`；README:127-129） |
| **没有调用方写入 API** | 导出只有 `settings.register`(989) + 两个 `ctx.on`(1073-1074) + `ctx.effect`(1081)；**没有注册任何 model tool**（`lib/index.js:1099`） |

也就是说：它不是一个"调用方才决定写什么"的记忆后端，而是
**接管每一轮记忆行为的生命周期 bundle**。这正是 ADR-027 §96 与
MI-02 / ADR-029 明确禁止的形状：

> Assistant 自己生成的话不能自动升级成事实。

### 1.1 顺带确认：assistant 文本默认会上传到第三方云

```js
const content = options.includeAssistant ? textContent(event.data.message.content, …) : void 0
```
（`lib/index.js:635`，以 `role: "assistant"` 上报 `638-644`；`includeAssistant` 默认 `true`，`776`；README:129）

默认上传的是**每轮的用户文本 + 她自己的回复**，目标是
`https://memos.memtensor.cn/api/openmem/v1`（`lib/index.js:719`）。
系统提示 / reasoning / 插件上下文 / 附件被排除（README:16,189；代码 `620-660`），
tool 调用与结果默认不含（`includeToolMemory` 默认 `false`，`636,647,731`）。

对苏沐薇这个项目而言，"她自己说的话自动进第三方云"就是一个独立的
**隐私与语义双重问题**，与 Q7 同源。

---

## 2. 判据逐条（ADR-027 §101 的 10 条）

| # | 判据 | 判定 | 证据（代码 / 文档） |
|---|---|---|---|
| Q1 | 能否保留我们的 `MemoryId` | **NO** | `MemosAddRequest` 没有 id 字段（`index.d.ts:60-72`；builder `index.js:447-459`）；返回 `{success?, task_id?, status?}`（`index.d.ts:111-115`），且 `asyncMode` 默认 `true`（`index.js:749`）—— 连 MemOS 自己的 id 在写入时都不知道；id 由服务端铸造（`index.d.ts:73-83`，`index.js:481`）。CLI `memos add` 同样不收 id |
| Q2 | 能否保留 source provenance | **YES（消息/会话级，不是我们的 MemoryId）** | `conversation_id = dsh:<sessionId>`（`index.js:822-827,850-872`）；message id 与 `chat_time` 保留（`627,630,639,643,654,658`）；`info` 带 integration/dsh_origin/dsh_tags/dsh_agent_preset（`853-859`）；README:190 明确写"Original DSH message IDs and event timestamps are preserved" |
| Q3 | 能否表达 **supersede** | **NO** | 客户端面只有 `search`/`add`/`requestRaw`（`index.d.ts:155-161`，`index.js:345-351`）；任何请求类型都没有 update/replace/supersede 字段（`index.d.ts:46-72`）；dist 与 README 里没有 supersede/merge |
| Q4 | 能否表达 **retract / forget**（且不销毁历史） | **NO** | 插件里**没有任何** delete/retract 路径（grep 只命中 `Set.delete` 与模块 `export`）。生态里唯一的删除是**物理删除**："Delete one memory, or delete all memories for a user"（CLI README:252-266） |
| Q5 | 能否查询历史版本 | **NO** | 客户端（`index.d.ts:155-161`）与 CLI 命令集都没有 history/version；投影只有 `create_time`/`update_time`（`index.d.ts:73-104`，`index.js:480-520`） |
| Q6 | 能否隔离不同 owner | **YES（需显式配置；默认共享命名空间）** | owner key 是 `user_id`（`index.d.ts:47,61`），默认值 `deepseek-harness-user`（`index.js:767`）—— 不设 `MEMOS_USER_ID` 就是**共享的**。另有 conversation_id / agent_id / app_id / allow_knowledgebase_ids 与 user/public/knowledgebase 过滤分支 |
| Q7 | **能否不绕过调用方的 Memory Policy** | **NO —— 自动 capture + 自动 recall 注入，设计如此。否决项。** | 见 §1：无条件钩子 `1073-1074`；recall 注入 `1024-1027`；capture 上报 `1043-1072`；默认全开 `774-776`；**没有**调用方写入 API。文档自述（README:14）："memory is automatic; the model does not decide whether to call a memory tool" |
| Q8 | 后端不可达时主聊天是否还能工作 | **YES（fail-open），但有延迟耦合** | recall 异常 → `warnOnce` → 返回未修改的 decision（`1028-1032`）；add 失败被吞（`1034-1042`）；README:15 "Fail-open: MemOS errors never interrupt the Harness turn"。**但** recall 在轮次关键路径上被 await（`1000-1033`），`timeoutMs=5000` + `searchRetries=1`（`745-746`）→ 后端挂掉时**每轮约 +10.1 s** |
| Q9 | 是否有完整的导出路径 | **NO** | 插件与 CLI 都没有 export/dump/backup 命令或文档。最近的是分页批量读取 `memos get <user_id> --format json --page --size`（CLI README:231-250），但**没有**被文档定义为导出 |
| Q10 | 移除 MemOS 后能否回退到 Native Backend | **YES（本工程）** —— 本工程的真源在账本，不在 MemOS | 插件本地**不持久化任何东西**（`index.js:1-6` 只 import `node:crypto` + DSH/Cordis）；内容全在 MemOS，按 `user_id` 归属。移除**不会**在本工程留下孤儿数据：`conversation_events` + `MEMORY_*` 领域事件本来就在我们自己的库里，capture 是**从会话事件派生**的（`602-661`）。本次验收新加的 `m4:restore:verify` 已在机制上证明"真源可独立恢复" |

### 2.1 `UNKNOWN-WITHOUT-CREDENTIALS`（**不是**失败证据）

| 项 | 为什么测不了 |
|---|---|
| MemOS 内部是否保留被取代的旧版本 | 需要账号才能实际写入并查询；Q5 的判定是"**没有可查询的表面**"，不是"内部一定不留" |
| `/add/message` 上传的 `messages[].id` 是否真的能反查到源记录 | 需要实际调用；`memos origin` 的存在暗示服务端保留了来源 |
| 后端删除是软删还是硬删 | 同上。生态里的 CLI 文档描述为物理删除，但那只描述 CLI 表面 |

这三项**都不改变 Q7**。

---

## 3. 次要但记录在案的发现

| 发现 | 证据 | 影响 |
|---|---|---|
| License 元数据与随包 LICENSE 不一致 | `package.json:37` 写 MIT；随包 `LICENSE` 是 Apache-2.0（169 行） | 合规审计时需要澄清；不影响技术结论 |
| 声明与实测的 DSH 版本范围不符 | peerDeps `^0.1.0-rc.6 \|\| ^0.1.2-rc.1`（`package.json:46-64`）；本机 DSH `0.1.5-rc.1`。按 npm 默认的预发布规则**不满足**该范围（只有 `includePrerelease` 才为真） | 厂商只在 `0.1.2-rc.1` / `0.1.0-rc.6` 上测过，README:183 自述 Harness 是 developer preview |
| 内联了未发布的私有包 | dist 内联 `@memtensor/memos-cloud-plugin-core`（`//#region ../core/dist/*`）；该包在 npm 上 `E404`，仅为 devDependency | 供应链审计上属于"随包 vendored"，不是可独立审计的依赖 |
| 它无法作为库被 Character Kernel 采用 | `inject = ["agents","sessions"]`，`apply` 只装生命周期（`index.js:1094-1097`）；需要活的 DSH Cordis context | "通过一个窄 Adapter 接入"（计划书第 95 节）在当前形态下**做不到** |
| 注入的 recall 消息与会话时间线同源 | recall 进入 DSH 的 pre-step 消息列表；capture 通过 `isAppendSurfaceEvent` 过滤（`index.js:612,621`） | 插件注入/读取的内容落在**我们的账本视为权威的**同一条会话时间线上 |

---

## 4. 结论

**REJECT —— 不用于本工程的生产架构。**

单一决定性理由：**Q7**。它不是"调用方才决定写什么"的记忆后端，
而是默认接管每一轮 recall 注入与 capture（含 assistant 文本）的生命周期 bundle，
且**不提供调用方逐条写入的 API** —— 因此它在结构上**无法**遵守
苏沐薇的 Memory Policy。次要缺口（无调用方 `MemoryId`、无 supersede、
无"保留历史的 retract"、无导出）**不能靠配置弥补**。

**必须同时说清的两件事**：

1. ADR-027 §102 的原文是：关键项不满足 → `rejected for production`，
   **项目继续原生 `NativeMemoryStore`，完全没有问题**。本次结论正是这一条。
   它**不影响 M4 PASS**：计划书第 216 节要求的是
   "MemOS Lifecycle PoC 完成并**有正式结论**"，两者满足其一即可。
2. 若把范围收窄成"仅做 harness 侧的 DSH profile 实验"，诚实的评级是
   **DEFER 而不是 REJECT** —— Q7 是它的产品设计，不是缺陷；
   那个范围下真正的障碍是 DSH 版本在测试范围之外，以及没有 retract 与 export。

**保留研究结论**：MemOS 强调的 memory lifecycle、异步 ingestion、
feedback/correction、可组合 memory containers 仍是**设计上值得借鉴**的
（计划书第 196 节）—— 而"借鉴"是一个正当结论，不取决于是否采用它的代码。

---

## 5. 怎么复现这份静态检查

```powershell
# 只读取包（写到临时目录，不碰本工程）
$t = Join-Path $env:TEMP 'memos-poc-static'; New-Item -ItemType Directory -Force -Path $t | Out-Null
npm pack @memtensor/memos-cloud-dsh-plugin --pack-destination $t
# 解开后读 lib/index.js / lib/index.d.ts / README.md / package.json / cordis.patch.yml

npm view @memtensor/memos-cloud-dsh-plugin version description repository.url dist-tags
npm view @memtensor/memos-cloud-cli version
```

本工程侧没有任何改动：`package.json` **不含** 任何 memos 依赖，
主工程未安装该插件。

**如果将来要真正跑一次（M5 Gate B 或重开研究）**，前置条件至少是：
① 一个独立 DSH profile；② MemOS Cloud 凭证；
③ 一个把 recall 注入与 capture **都关掉**、只用其 `add`/`search` 的窄 Adapter
（当前包不提供这个形状，需要先与上游确认）。
