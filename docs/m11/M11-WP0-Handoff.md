# M11 WP0 交接单

- 日期：2026-10-01
- 工作包：WP0（基线、归属与前置核对）
- 状态：**COMPLETE** —— 计划 §9 WP0 的交付与出口条件**全部满足**，27 项检查全 PASS，`unknown` 脏文件 0
- 权威读数：[`M11-WP0-Baseline.md`](M11-WP0-Baseline.md)（本交接只给"下一手要什么"）
- 证据（六代，**都保留不回写**，见基线报告 §6.1）：
  - **权威档** `artifacts/m11/m11-wp0-20261001-9a0694a309a6-a58b/`（judge@4，head = 判据修订提交）
  - 三份**判据缺陷档**：`…fedb`（judge@1，把注释当代码）· `…39e7`（judge@3，工具未提交）·
    `…7320`（judge@3，PARTIAL：自产清单没覆盖里程碑面）
  - 其余过程档：`…1d22`（judge@2，工具未提交）· `…ca71`（judge@2，记着"7 个字段"的错读数）
- 本轮**没有**：打开数据库 · 调模型 · 出网 · 改生产 `.env` · 改 Seed/迁移 · 改历史文档或证据

---

## 1. 本轮交付

| 交付物 | 位置 |
|---|---|
| 基线报告（身份、发现、七项核对、继承缺陷、量具有效性） | [`M11-WP0-Baseline.md`](M11-WP0-Baseline.md) |
| 本交接单 | `M11-WP0-Handoff.md` |
| 新命令 | `m11:wp0:verify`（`--phase before\|after`，可选 `--compare-db` / `--compare-env`）|
| 新增脚本 2 个 | [`scripts/m11-evidence.ts`](../../scripts/m11-evidence.ts) · [`scripts/m11-wp0-verify.ts`](../../scripts/m11-wp0-verify.ts) |
| 点追加 2 处 | [`package.json`](../../package.json)（+1 条）· [`.gitignore`](../../.gitignore)（M11 证据段 + `local/` 忽略闸） |

**计划书 [`M11-Execution-Plan.md`](M11-Execution-Plan.md) 一字未改。**

基线命令读数（直接入口调用，理由见 §4⑧）：`tsc --noEmit` **EXIT 0**（无诊断）·
`m10:m11:verify` **PASS 11/11 · EXIT 0**（分组 A=3/3 · B=5/5 · C=3/3；
该次重跑新建 `artifacts/m10/m10-wp11-m11-20261001-b368c5577208-97ab/`）。

---

## 2. 交给 WP1 的输入（带代码指针，不必重新侦察）

| # | 输入 | 指针 / 读数 |
|---|---|---|
| 1 | **基线树** | `codex/m11-execution-plan` @ `b368c557` = `main@aaef20d8` + 计划提交（变基，§2.1）。旧基线 `22d27cf9` 与它差 **186 提交 / 23 个 `src` 文件**，不得用旧基线核对生产者 |
| 2 | **`causedBy` 缺口（WP2 的主战场）** | 写入固定 null [`event-store.ts:169`](../../src/infrastructure/persistence/event-store.ts#L169) · 读回已映射 [`:106`](../../src/infrastructure/persistence/event-store.ts#L106) · 类型已预留 [`domain-event.ts:267`](../../src/kernel/contracts/domain-event.ts#L267) · 提案与校验层**不传递** ⇒ WP2 只需**追加**字段贯通，**不加迁移**（列已存在） |
| 3 | **三段 revision** | [`goal.ts:434`](../../src/kernel/contracts/goal.ts#L434) / [`:466`](../../src/kernel/contracts/goal.ts#L466) / [`projection.ts:38`](../../src/kernel/contracts/projection.ts#L38)；契约逐字 [M10-M11 §1.1](../m10/M10-M11-Read-Only-Contract.md) |
| 4 | **完成依据只在事件里** | [`goal.ts`](../../src/kernel/contracts/goal.ts) `GoalCompletedPayload.evidenceRefs` · [`projections/goal.ts:232`](../../src/kernel/projections/goal.ts#L232) 不落它 |
| 5 | **读时资格重算口** | [`app/goal/inputs.ts:292`](../../src/kernel/app/goal/inputs.ts#L292) `recheckGoalDependencies()`（带 `measuredCount`；0 ⇒ MEASUREMENT INVALID） |
| 6 | **M9.5 fixture 缺口** | [`handoff-fixtures.ts:84`](../../src/kernel/app/recall/handoff-fixtures.ts#L84) `sourceRevision: 1` 固定 ⇒ 生产**不得**接 fixture |
| 7 | **上下文注入点** | `'adaptive-self' // M11` + 优先级 **44** 已在场（[`context.ts:79`](../../src/kernel/contracts/context.ts#L79) / [`:110`](../../src/kernel/contracts/context.ts#L110)）· `ContextBudget`（**在 `src/kernel/recall/selector.ts`，不在 context.ts**）有 **6** 个既有额度字段（`totalTokens` / `memoryTokens` / `reservedTokens` / `externalEvidenceTokens` / `rollupTokens` / `goalTokens`）、**没有** `adaptiveSelfTokens` ⇒ 追加后是第 **7** 个，缺省 **0**（⚠️ 本行数字是 2026-10-01 判据修订后的读数，见基线报告 §5.2） |
| 8 | **只读面边界** | [M10-M11 只读契约 §3](../m10/M10-M11-Read-Only-Contract.md)：读面里没有写原语 · 目标领域自己的写入口**恰好 2 个**（`goal-store.ts`）· 共享账本追加 1 个（`event-store.ts`）· 开发者面读到的是**遮蔽后**形状 |
| 9 | **环境阻塞** | 本工作树**没有** `.env` / `.env.test` ⇒ Live 与真实聊天必须在**主 checkout** 跑（基线 §2.3）；生产激活（WP12）天然在主 checkout |
| 10 | **两份 `data/pglite`** | 本树的是 2026-09-30 的**陈旧副本**（`5619f85d…`），生产库在主 checkout（`05ada1e1…`）⇒ 实验一律 `isolateDatabase()`；生产副本从主 checkout 的静止快照复制（基线 §2.2） |
| 11 | **能力起点读数** | M11 实现面**全部不存在**（contracts/reflection · contracts/adaptive-self · app/reflection · reflection-policy · 两个开关）⇒ `新增外部能力 = NONE` 的**结构前提**成立；本报告**不**据此宣称实现已完成 |
| 12 | **继承排期** | `D-6` 的记忆体量线**仍未开始**（`CHARACTER_MEMORY_LLM_EXTRACTOR_ENABLED` 不存在）；M11 的推进是用户 2026-10-01 的排期裁定，**不**接管也不跳过那条线 |
| 13 | **⚠️ M10 的额度接线缺陷** | `goalTokens` **从未**被生产装配设置（`main.ts` 只覆盖 `externalEvidenceTokens` + `rollupTokens`）⇒ 生产里 `goal-state` 块不可达，而 M10 记为 `ACTIVATED`（两者不矛盾）。M11 **必须**照 `rollupTokens` 形状真接线 + 静态回归锁（ADR-085 `D34` / `L-M11-10`） |
| 14 | **⚠️ late-write fence 不存在** | `grep fence\|late_write` 在 `src/` **零命中**；`D17` 要求的"关闭后晚返回零写入"今天只有 `close()` 的 abort + 有界等待 ⇒ **M11 必须自己建**（`L-M11-11`，WP7 交付） |

---

## 3. WP1 必须冻结的最小集（并明确哪些**必须**由用户裁定）

WP1 的出口是「设计批准 + `DESIGN FROZEN`」（计划 §9 WP1）。按计划 §5–§8、§11，
`M11-Acceptance-Contract.md` 至少要把下面这些定形；**带 ★ 的项是用户设计裁定**，
不是 WP 自己可以拍板的：

1. ★ **三个行为槽的封闭语义**（计划 §6.3）：`clarify_when_ambiguous` /
   `acknowledge_correction_first` / `recheck_goal_before_next_step` —— 每个槽的
   enhanced 语义、适用范围、反例条件。
2. ★ **稳定采纳门槛**：计划建议「≥3 个有效独立根、来自 ≥2 个会话、无未解决直接冲突」。
   冻结时必须写明它**不是**统计独立性主张（计划 §6.2 末段）。
3. ★ **阈值与上限全集**（计划 §7.1 / §11.2）：每 job 输入上限（建议 50）·
   候选模型输入上限（建议 6000 token）· 每 job 最多 1 条 draft ·
   候选解释长度（建议 300 汉字）· 来源图遍历上限（建议深度 16 / 节点 64）·
   总 deadline（建议 20 秒、每 job 最多 1 次模型请求）· 预算（建议 300、硬上限 800）。
   **先冻结、再运行**（计划 §11.2 逐字）。
4. ★ **事件族与 payload 形状**（计划 §6.1）：`REFLECTION_ORIGIN` /
   `REFLECTION_PROPOSED` / `REFLECTION_REVIEWED` / `REFLECTION_INVALIDATED` /
   `ADAPTIVE_SELF_REVISED` —— 以及"是否拆分 reviewed payload"（计划要求 WP1 定，
   **不许实施时同时发展两套生命周期**）。
5. ★ **两个开关名与缺省**：`CHARACTER_REFLECTION_ENABLED` /
   `CHARACTER_ADAPTIVE_SELF_ENABLED`（代码缺省均 **false**）；生产激活属 WP12 独立裁定。
6. **`ReflectionInput` / `ReflectionDraft` / `ReflectionRecord` / `AdaptiveSelfState` /
   `RevisionIntent` 的字段闭集**（计划 §6.1 的表），含"不允许表达为已证实"的清单。
7. **生命周期状态机**：`pending / accepted / rejected / retracted` 的合法边与非法边；
   与 `ProposalStatus` **共享而不改造**（计划 `M11-D03`）。
8. **来源归一化与计数规则**（计划 §6.2）：根去重、五类标签
   （`user_statement` / `user_report` / `program_result` / `assistant_speech` / 内部解释）、
   资格与撤回**双向**覆盖、超限的具名码 `lineage_limit_exceeded`。
9. **审查顺序与理由码表**（计划 §6.3）：结构 → 来源合法 → 版本/资格 → 支持与反例 →
   目标范围 → 槽位/跨域合法 → 修订冲突；每步给可拒可查的具名码。
10. **跨域只读面与写入口归属**（计划 §6.4）：Memory 走 M4 · Belief 走 M9 ·
    Goal/Commitment 走 M10；`RevisionIntent` **不**直接 `applyGoalRows`。
11. **失效两步**（计划 §6.4 / `M11-D12`）：当前轮注入前资格过滤 + 幂等任务补落账。
12. **回复事实包的五态**（计划 §8）：没有运行 / 失败 / 候选待审 / 已审查未调整 /
    已生效 / 已失效 —— 以及"待审**不得**说已形成习惯"的机器判据。
13. **观测与隐私白名单**（计划 §8 / §12.2）：理由码、分类法、trace 字段、
    `artifacts/m11/local/` 的 `git check-ignore` 闸（本 WP 已落 `.gitignore`）。
14. **GitHub 借鉴登记**（计划 §3）：四个固定 pin（LangMem / Generative Agents /
    Concordia / PersonaMem / LongMemEval / LoCoMo）+ "借鉴内容 / LG 实现 / 未采用部分"。

**WP1 必须同时产出**（计划 §9 WP1「材料」）：一份合法成长**正例**、一份自证错误**负例**、
一份撤回**恢复例**，以及**手算样本**（字段与 expected roots）——
手算样本是 WP2/WP9 的独立 oracle 起点，**不许**用生产的 resolver 算 expected。

---

## 4. 开工纪律（从本 WP 的实测发现直接推出）

```text
① 实验一律 isolateDatabase()；生产副本从主 checkout 的静止快照复制，
   且**永不打开**快照本体（INC-01 / AGENTS §5.1）。
② 本工作树没有 .env / .env.test ⇒ 任何 Live 门在**主 checkout** 跑；
   禁止借生产凭证"顺便验一下"（AGENTS §8.1）。
③ ⭐ **新判据至少要被三件事打过**（WP0 的实测教训：三次修订**没有一次是"门太严"**，
   三次都是"门量错了对象"）：
     · 结构判据先 `stripComments()`（否则注释会把自己打成违规）；
     · 扫描字段先**截出接口体**（否则会数到隔壁接口的同名字段）；
     · 自产前缀按**里程碑面**划，不按文件清单（否则下一个 WP 会被自己的文档判成未知脏文件）。
   ⇒ 新门一律带 `judgeVersion`，缺陷档**保留不回写**。
④ 对照目标（--compare-*）在 before/after 之间**不许换**（A14 已有机器判据）。
⑤ 证据目录形状：artifacts/m11/<runId>/（进仓库，无正文）·
   artifacts/m11/local/<runId>/（人审材料，**不进仓库**，写正文前先 git check-ignore）。
⑥ 新量具一律走「正控 / 负控 / 恢复」三段式，并自检 measured_count > 0；判据修订要
   带 judgeVersion 且**不重写**旧档。⑦ 不把 M9.5 体量线 / 索引线的工作顺手接过来；不打开 CHARACTER_MEMORY_LLM_EXTRACTOR。
⑧ 本机 `pnpm <script>` 被供应链校验阻塞（基线 §1.1 / `L-M11-08`）⇒ 跑门用**同一入口文件**
   直接调用（`node node_modules/tsx/dist/cli.mjs scripts/<entry>.ts`），并在证据里写明调用方式；
   **不**把这记成"门被跳过"。发布档若要 `pnpm`，先确认 pnpm 恢复可用。
```

---

## 5. 下一步

**WP1（ADR + 验收契约 + 反思范围冻结）** —— 出口是设计批准并 `DESIGN FROZEN`，
其中 §3 带 ★ 的项需要用户裁定；在裁定之前，§5 的 `D01–D24` 仍只是**计划建议**，
不得当成实现契约（计划 §5 末段逐字）。
