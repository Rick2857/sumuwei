# WP7b Handoff —— 跨午夜／时区／三个时间通道 + 同轮预算竞争 + 本地评审包

```text
Completed WP:            WP7b（M6 / Lv1 Hardening；计划书 §WP7 的追加覆盖项 + §3.2 预算与时间）
Commit / branch:         <见提交后的 git log> / feature/m6-lv1-hardening（= main）
Changed files:
  scripts/verify-m6-wp7b.ts                          新增：WP7b 门（T/P/R 三节 21 项断言 + 4 条必跑子门 + Z1）
  scripts/m5.5-harness.ts                            **追加**：`say()` 透传可选 `clockEpochMs`（不传 = 行为逐字不变）
  scripts/m6-evidence.ts                             登记 `wp7b-e2e`（必选门；`m6:gates` 变 10 道）
  artifacts/m6/m6-wp7b-20260921-aa18ab9b2927/e2e.json 新增（本门证据；**2647 字节，无任何对话正文**）
  artifacts/m6/m6-wp3-20260921-aa18ab9b2927/wiring.json 子门 `verify-m6-wp3-wiring.ts` 的 runId 证据
  docs/m6/WP7b-Handoff.md                            本文件

**不提交（gitignored，只在本机）**：
  artifacts/m6/local/m6-wp7b-20260921-aa18ab9b2927/review-packet.json（4393 字节，**含对话正文**）
  —— `.gitignore` 第 104 行 `artifacts/m6/local/`（计划书 §9 L532 指定的位置，
     由 WP4 声明、本门只消费；R1 用 `git check-ignore` 把这条变成机器判据）

User-owned dirty files preserved: **原样未动、未提交**
  artifacts/incidents/inc-01/wp1-lease.json
  （SHA-256 仍为 BB08C5BE9FE13FC6B739D67D00D29ED4921CB2E4D8FCD9D1B5D7F12184BA42B6）

Commands + exact exit codes:
  pnpm typecheck                                    → EXIT 0
  pnpm exec tsx scripts/verify-m6-wp7b.ts           → EXIT 0（**25/25**；子门 4/4 EXIT 0；约 150s）
  子门（逐条独立进程，本门逐条记录退出码）:
    verify-m5-budget.ts          → 0（4s）   额度合法性的**部件级**判据（负数/非整数/超 total ⇒ 装配期失败关闭）
    verify-m6-wp3-wiring.ts      → 0（1s）   摘要接线负控（读取面抛错 ⇒ 不注入）+"只占一个可裁 section"
    verify-m5.1-measurement.ts   → 0（4s）   量具资格化三段式（§5 对新判据的强制要求）
    pnpm m5.5:e2e:verify         → 0（19s）  共享 harness 的改动对 M5.5 链路**惰性**的证明
  pnpm m6:gates                                     → EXIT 0（**Hard Gates = PASS**；必选门 **10** 个，未运行 0，未通过 0）

Evidence produced:
  artifacts/m6/m6-wp7b-20260921-aa18ab9b2927/e2e.json（schemaVersion `m6-wp7b-e2e@1`）
    T 节：跨午夜两轮的 clock 渲染与 `clock:<epoch>` 引用 · 时区负控见证时刻 · 三个时间通道分列
    P 节：宽/紧/更紧/超限四档的 section 与 dropped · 「被选中 ≠ 入模」两套读数
    R 节：`itemCoverage` 映射 · 评审包路径与 cases 数 · 真实库前后摘要
    ⚠️ 本文件**不含对话正文**：写入只有一个出口 `writeArtifact`，含正文哨兵即抛、
       落盘后逐字复核、schemaVersion 与 cases 数不符即抛（失败关闭，不是"检查一下"）

Real data/pglite digest before / after:
  8307173d8b8f12df818008e05356e2ad6df4a56e598347d039650919f39aa4d4（1205 文件 / 31,584,799 字节）
  ⇒ 本门运行前后**逐字相同**（Z1）；与 WP0 基线的关系按"漂移有据"判
  （共用 `scripts/inc-01-real-db-drift.ts`：verified 快照 11 份、cleanClose 的 owner record 1 条、孤儿 manifest 0 份）。
  **本门没有打开真实库**。

Measurements and measured_count:
  真实库 measured_count = 1205（> 0）
  不可裁之和 = 1239 token（实测；四条：current-input 13 · action-result 35 · integrity-rules 48 · identity-core 1141）
  三格额度实测：外部证据 67 · 记忆 45 · 摘要 140（**紧预算由这三个实测值算出来，没有手抄常数**）
  packet 与 trace 记的 token 数**逐字一致**（1491 = 1491）
  零命中自检：`base > 0 && evTokens > 0 && memTokens > 0 && rollupTokens > 0` 全为硬前提（P1b）

Positive / negative / recovery controls:
  T1 跨午夜正控   同一会话相隔 **2 分钟**跨过 +08:00 的 00:00：
                  前轮 `2026-09-21 星期一 23:59`、后轮 `2026-09-22 星期二 00:01`，clock 引用相差 120000ms
  T2 时区负控     UTC 还是 09-21 的那一刻（20:00Z），她看到的是 **09-22 04:00** ——
                  若渲染其实念 UTC，这条必然读到 09-21 20:00；唯一真源 `CLOCK_TIME_ZONE='Asia/Shanghai'`
  T3 三通道分列   ① clock section = 注入的 epoch（她以为的"现在"）；
                  ② 事件的 `createdAt`（=recordedAt）= **系统真实时钟**（±60s 内）且 ≠ 注入 epoch；
                  ③ `occurredAt` 缺省 = `undefined`（"不知道"，**不是**"等于现在"）；
                  正控：`eventTimeOf` 能同时保留两个不同的值
  T3b 负控         `logicalTime` 非空 ⇒ `assertEventTime` 失败关闭 `simulation_time_not_supported`
                  （**不新造模拟时钟** —— 计划书 §3.2「不重复开发'知道时间'」）
  T4 跨午夜集成   午夜前写的记忆到午夜后仍 `active`；午夜后的摘要块里**仍有**午夜前那条声明的原文；
                  `invalidated_by_memory_state = 0`（跨天不触发失效）
  T5 trace 真相   clock section 的引用就是 `clock:<这一轮的 epoch>`，并进了 packet 的来源集合
  P1 宽预算正控   记忆 + 外部证据 + 摘要**三者都真的入模**，dropped 为空
  P1c 顺序        摘要排在 packet **最后**（可裁、最低优先级），记忆与证据在它前面
  P2 竞争         预算 = 不可裁 + 证据 + 记忆 + 30 ⇒ **只有摘要**被裁（dropped 长度 = 1），
                  记忆与证据入模；`rollup_items = 3`（被选中）而 `rollup_section_survived = 0`（没入模）
                  —— **这一对不相等**就是计划书 §3.2 L172 要的那条区分
  P3 更紧         预算 = 不可裁 + 10（仍有 10 token 余量）⇒ 三个可裁**全裁**、四条不可裁全留、
                  `packet = 1239 ≤ 预算 1249`（这一档**没有**超限）；
                  证据 `bundle_attached = 1 / selected = 0 / context_budget_dropped = 1`；
                  记忆 `intendedSelected = 1 / selected = 0 / droppedByContextBudget = true`
  P4 不可裁超限   预算 = 不可裁 − 500 ⇒ 不可裁一条不落全留（`packet = 1239 > 739`）、可裁全掉，
                  且 packet **如实报** `estimatedTokens > tokenBudget`（**不伪报 fits**），trace 记同一个数
  P5 量具自证     额度 0 ⇒ `bundle_attached = 0` 且 `context_budget_dropped = 0`；
                  被上下文裁那档是 `bundle_attached = 1` 且 `context_budget_dropped = 1`
                  —— "压根没附"与"附了被裁"**读数不同**，不会被混成一个（`AGENTS.md` §6.2）
  R1/R2/R5 隐私   评审包在 gitignored 目录（`git check-ignore` 退出码 0）且**确实**含正文哨兵（正控）；
                  机器证据里**没有**哨兵（负控）；trace 里**没有**哨兵（负控）
  R4 关联         5 个评审用例每例都带 `runId / codeCommit / traceId / eventId`，带副作用的另带 `actionId`
  R6（已并入写入口）落盘后逐字复核 + schemaVersion/cases 校验，不符即抛

Deviations or NOT RUN items:
  1. **判据按"实际语义"修正了一次（本门第一次跑 25/1 的那条红）**：P4 原来把
     "预算 = 不可裁 + 10"说成"预算比不可裁之和还小"，于是断言 `packet > budget` 为真 ——
     而那一档根本没有超限（packet 1239 < 预算 1249）。**这是判据写错了，不是系统错了**：
     修正后 P3 = "仍有 10 token 余量但装不下任何可裁段、`used <= budget`"，
     P4 = "预算低于不可裁之和 ⇒ 如实超限"（用 `base − 500` 那一档）。
     两档各自的读数都写进证据，含"这一档没有超限"这句显式说明。
  2. **证据里的 `passed` 与屏幕上的"N 通过"曾经差 1**（第一次绿的那版：文件 25 / 屏幕 26）：
     原因是"落盘复核"那条判据本身跑在写文件**之后**，于是它自己进不了文件里的计数。
     这属于 M6-G12「报告与机器读数一致」的问题，因此改成：**写证据只有一个出口**
     `writeArtifact`，它在所有计数型判据之后调用一次，并把"含哨兵即抛、落盘逐字复核、
     schemaVersion/cases 校验"变成**失败关闭的写入口不变量**；盘上的文件 = 屏幕上那组数（25/25）。
  3. **共享 harness 的改动是追加且可选的**：`scripts/m5.5-harness.ts` 的 `say()` 多了一个
     `clockEpochMs`，不传时与之前**逐字相同**（`TurnGateway` 本来就支持这个字段，
     只是 harness 之前没透出来）。这类"改了共享测试设施"的改动按 §5 的纪律要证明没伤到别人，
     因此把 `pnpm m5.5:e2e:verify`（19s，EXIT 0）作为第 4 条子门固定下来。
  4. **不重实现别人的命题**：额度合法性的**部件级**判据（负数/非整数/超过 total）由子门
     `verify-m5-budget.ts` 承载（它已含 M6 那格 `rollupTokens`）；本门只登记 `itemCoverage` 映射。
  5. **WP7a 的证据不做回溯改写**：`m6-wp7a-.../e2e.json` 的 `itemCoverage` 里仍写着
     "同轮预算竞争 / 跨午夜 = WP7b（下一步：本门尚未覆盖）"—— 那句话在**它那次运行**时是真的，
     §M6-G12「历史不改写」优先；两件事的**当前**承载关系写在本门证据与这份交接单里。
  6. **被重新生成的历史证据按白名单还原**（只还原本门子门会重写的那两个路径）：
     `artifacts/m5.1/measurement-negative-controls.json`、`artifacts/m5/wp5-context-budget.json`
     （逐份核对：`verdict` 行 0 处变化，只有 `generatedAt` / 沙箱路径 / 计数字段）。
  7. **NOT RUN（本门未覆盖，留给 WP8+）**：1k→10k 规模与检索上界 · 50/100/500 轮长对话 ·
     Live（生产形状）· 发布盲审（G1 需真人）。**跨午夜本门只测"挂钟事实与三通道分列"**，
     不主张"她真的理解了隔了一天"（措辞层没有启发式守卫，见 M5.1.1 `DR-11`）。

Root-cause status: 与 INC-01 无关（本门不碰真实库的写路径）；INC-01 根因仍是 `PARTIAL`。
```

---

## 下一步（不自动开工）

`WP8 — 规模、性能与已知容量边界`：先 1,000 再 10,000 次混合操作（复用
`pnpm m4:scale:verify -- 10000`），**不要混淆三种计数**（请求操作数 / 实际持久事件数 /
当前有效记忆数）；正式 10,000-event Replay 必须另证 `replayed_event_count >= 10000`。
第 500 行边界内外放已知合法目标测召回覆盖，采不到的读数记"不可得"，
**性能 SLA 要先校准冻结**（不临时拍一个秒数）。
