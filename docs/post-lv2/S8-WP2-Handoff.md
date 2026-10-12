# S8 · WP2 交接单（世界持久提交与恢复）

状态：**实现完成 · 门 PASS**。日期：2026-10-03。工作包：`POSTLV2-S8`。
载体：[ADR-093](../adr/ADR-093-s8-story-state-and-habit-bridge.md) `D01`/`D05`/`D13`/`D15` ·
[验收契约](S8-Acceptance-Contract.md) · [测量计划](S8-Measurement-Plan.md)。

| 项目 | 读数 |
|---|---|
| 门 | `pnpm postlv2:s8:store:verify` |
| 判定 | **PASS** · `measured_count = 86` · 11/11 检查 |
| 机器证据 | `artifacts/post-lv2/<runId>/s8-store-verify.json`（按 manifest 的 `source.head` 归属） |
| 隔离 | `isolateDatabase()` 一次性沙箱（`%TEMP%`）；`data/pglite` **从未被打开** |
| 出网/模型 | **零**（纯离线） |

---

## 1. 交付物

| 文件 | 是什么 |
|---|---|
| `src/infrastructure/persistence/migrations.ts` | 新迁移 **v12** `post-lv2-s8-story-ledger`：`storyline_commits` + `storyline_observations`（只追加；`0001–0011` 一个字节未改） |
| `src/kernel/storyline/story-ledger.ts` | **纯契约 + 纯函数**：提交身份与读回自检、绑定形状校验、账本行装配、观测行派生、因果键（`D05`/`R-4`）、会话键、缺口检测 |
| `src/kernel/storyline/story-ledger-port.ts` | Kernel 侧端口（`appendCommit` / `readCommit` / `readCommitByIdempotencyKey` / `readObservation` / `listCommits` / `listRuns` / `latestRevision`） |
| `src/infrastructure/storyline/store/story-ledger-store.ts` | SQL 适配 + **完整性探针**（悬挂观测 / 观测缺口 / revision 缺口） |
| `src/kernel/app/storyline/commit-service.ts` | 提交服务：账本折叠 → 纯状态机判定 → 原子追加；`loadStoryRun` / `reconcileStoryRun` |
| `scripts/postlv2-s8-store-verify.ts` | 门本体（T1–T11） |
| `scripts/postlv2-s8-store-restart.ts` | **真子进程**重启读回端（父进程先关连接） |
| `package.json` | 注册 `postlv2:s8:store:verify` |

**没有**做的事：不改任何已发布 DDL、不激活任何开关、不写任何回填数据、
不打开真实库、不发任何模型请求。

## 2. 退出条件逐条对账（计划书 WP2）

| 计划书退出条件 | 机器判据 | 读数 |
|---|---|---|
| 关闭**进程**后重新打开隔离库，提交/可见观测/revision/折叠状态**逐项对账** | `T8` | 子进程 pid ≠ 父进程 pid；提交序列、revision、当前节点、变量、可见集合**逐项一致**；重启前后账本行数不变 |
| 重复选择**不重复提交** | `T4` | 同幂等键重放 ⇒ `already_committed`，提交行数不变 |
| 提交前/后故障恢复均**无半条世界记录** | `T7` | 提交行写入后观测写入失败 ⇒ **整条回滚**（第二条读不回来，run 里只剩第一条） |
| 旧来源无账本时**拒收**，不自动回填 | `T9` | 观测与 run 读回均为 `undefined` / 0 条 |
| 隔离库迁移 | `T1` | `schemaVersion = 12`；两张表在；列数 25/7；`storyline_commits` 约束 28（量具自检非零） |
| （正控，非零分母） | `T2` `T3` `T11` | 3 条提交 / 3 条观测；一次提交 3 个条目 ⇒ 3 条观测**指向同一父提交**；根键 3、会话键 1 |
| （负控） | `T5` `T6` | 同 revision 不同请求拒收；三种伪造绑定全部拒收 |
| （探针三段式） | `T10` | 正控 0 问题 → 注入悬挂观测**必响** → 删除后恢复 0（扫描分母 cmt5/obs7） |

## 3. 本 WP 发现的缺陷与处置（**如实登记，不回写**）

### 3.1 `world-machine.ts` 的可见集合缺口（**已修**，ADR-093 `R-5`）

`advanceFromProposal()` 只按**迁移声明**取可见事件，而：

- `story-types.ts` 对节点 `visibleEvents` 的原文是"进可见集合"；
- `JICHUANG_PACK` 的迁移**故意不声明** `visibleEvents`（注释逐字："可见事件由**节点**承载：
  到达该节点即进入可见集合，迁移不重复声明"）；
- `.ink` 在**每个节点**发 `# visible:<id>`，`ink-runtime.ts` 会累积它们；
- **同文件的 `commitEnding()` 本来就是按目标节点取的**。

⇒ 实测后果：**她只经历了序章那一条**，后面每一步都不进可见集合；纯状态机与 ink 运行器
对同一张图给出**不同的经历集合**。这是来源安全面的分歧（`S8-A03`/`S8-A09` 直接依赖它）。

**修法**：`newlyVisible = 迁移声明 ∪ 目标节点声明`（去重、保持作者顺序、只增不减）。
只改实现使其符合**已文档化**的语义，没有改契约。
复跑 `postlv2:story:verify`(172) · `postlv2:world:verify`(24) · `postlv2:source:verify`(69) ·
`postlv2:source-root:verify`(31) 四道既有门 **全 PASS**。

### 3.2 `FC-T04` 伪装通道判据的子串误报（**已修**）

`m3.5:test` 的 `FC-T04` 用 `code.includes('observations')` 判"伪装通道"，
于是 `storyline_observations`（本 WP 的世界观测表）与形参名 `observations` 被误判成违规。

**修法**：判据改成"**表名** + SQL 关键字上下文 + `\b` 词边界"，并补 **正控/负控/恢复**
三段式自检（真表定义必须响 / 复合名与形参**不得**响）。
`m3.5:test` 由 **29 通过 / 1 失败** 变为 **30 通过 / 0 失败**。
⚠️ 这**不放宽**任何东西：直接建/查 `observations` 表照样被拦；变的是**不再误报**。

### 3.3 本 WP 自己的量具缺陷（**四处，全部已修并留下说明**）

| # | 缺陷 | 症状 | 修法 |
|---|---|---|---|
| 1 | 基线门迁移正则写 `\{\n` | Windows 检出是 **CRLF** ⇒ 实读版本 `[]`，而"连续"在空数组上假绿 | 改 `\r?\n` + 加"逐条定义数 vs `MIGRATIONS` 数组登记数"第二条独立判据 |
| 2 | 观测写入用 `on conflict do nothing` | 与另一条提交的观测撞上时**静默跳过** ⇒ "N 个条目、N-1 条观测"的半条记录 | 去掉 `do nothing`（幂等已由提交行处理）⇒ 冲突抛错、事务回滚 |
| 3 | 重启检查直接关连接 | bootstrap 的 task 服务在已关闭的库上无限重试，进程不退出 | 先 `h.stop()` 再关；判据改为"**没有残留连接**"而不是"`reset` 返回 true" |
| 4 | 幂等回读按**目标 revision** 查 | 重试的提交落在 `state.revision` 上 ⇒ 查不到 ⇒ 被判 `story_stale_revision`（**假失败**） | 改按**幂等键**回读（新增端口方法），并加"这次请求与那条既有提交是不是同一件事"的比对 |

## 4. 残余（进登记册）

| ID | 内容 |
|---|---|
| `L-S8-06` | 退出路径（`RUN_EXITED`）的可见事件：纯状态机不带出 `ending_exited_by_user`，`.ink` 侧带出（`R-6`）。本 WP **不改**退出的节点语义，由 WP3 的可见性判据明确以哪一侧为准 |
| `L-S8-07` | 迁移 v12 只在**空库/沙箱**验证过；真实库应用（若需要）属 WP9 独立授权 |
| `L-S8-08` | `storyline_*` 两张表**没有外键**（沿用本仓库既有 DDL 纪律：append-only + 显式完整性探针）。悬挂观测由 `storyLedgerIntegrityProblems()` 报出，不由级联删除掩盖 |

⏩ 后续修订（2026-10-04，只追加）：`L-S8-07` 的真实库半边已销账 —— 真实库已由 WP9 独立授权应用至 **v13**（`S8-Activation-Record.md` §3 迁移行，提交 `161d94ed`；活库只读读回 schema=13 见同文件 §4）。原判定保留。

## 5. 本交接单**不**主张什么

- **不**主张 S8 已可用：WP3–WP6 的消费者接线**尚未开始**，故事经历目前**进不了**任何认知域。
- **不**主张真实库被动过：本 WP 全程只碰 `%TEMP%` 下的隔离沙箱。
- **不**主张上面的判据修正"只是形式"：`R-5` 改变了**可见集合**的内容（这是有意为之，
  且由四道既有门复跑背书），`FC-T04` 的修正改变了**门自身的判据**（已加三段式自检与说明）。
- **不**主张 v12 已经可以应用到真实库：那需要 WP9 的独立授权与只读读回证据。

## 6. 下一步（WP3）

1. 把 `story_event` 接入 `EvidenceKind`、`LineageHandleKind`(=`story_event`)、`LineageSourceClass`(=`story_experience`)、
   提案的 `sourceStoryRefs` 与 `sourceConversationEventIds` 的**语义分离**；
2. 根解析：`rootReadingsByMemory` / `expandLineage` 认识 `story_event`，并按 `D05`/`R-4` 的
   **因果键**去重（`S8-A03`/`S8-A13`/`S8-A14`）；
3. 新门 `postlv2:s8:contracts:verify`（类型/边界/旧版本兼容/kind 与 actor 不混用）
   与 `postlv2:s8:roots:verify`（`S8-C01`/`C02`/`C06`）。
