# WP8-C2 Handoff — K-33 Writer-Boundary Precision Repair

> **执行令**：`K-32 = CLOSED` · `K-33 = OPEN / P1` · `WP8-B = PARTIAL / BLOCKED (49/1)`。
> **只做 K-33，做完即 STOP；不得跑 WP8 final requalification（那是 C3），不得开始 WP9。**
>
> **判定**：`pnpm m5.1.1:wp8c2:verify` = **25 通过 / 0 失败｜K-33 = PASS**；
> `pnpm m5.1.1:wp3:verify` = **51 通过 / 0 失败｜PASS**（改前 49 / 1）。
> ⇒ **`K-33 = CLOSED` · `WP8-C2 = PASS`**；但 **`WP8-B = PARTIAL / AWAITING FINAL REQUALIFICATION`**，
> **不要在这里宣布 WP8 PASS**。

```text
Changed Files

  新增（K-33 的修复本体 = 唯一一份判据实现 + 专项门）
    scripts/m5.1.1-k23-recorder-boundary.ts   AST 能力分析器：mutation 面 / 列映射 / 值提供者 / 引用分类 / 计数
    scripts/verify-m5.1.1-wp8c2-k33.ts        pnpm m5.1.1:wp8c2:verify（三类 control + 全量边界报告）
  改动
    scripts/verify-m5.1.1-wp3-backfill.ts     证明②退休 → 换成能力判据（证明②+证明③）；证据发布完整边界清单
    package.json                              注册 m5.1.1:wp8c2:verify
    docs/m5.1.1/M5.1.1-Execution-Plan.md      R-40（K-33 CLOSED）
    docs/m5.1.1/M5.1.1-WP8C2-Compatible-Assertion-Record.md   F4（四问 + Old/New）
  证据
    artifacts/m5.1.1/wp8c2-*（8 个文件，含 C2-0 红灯基线）
  没有改
    src/**（零行生产代码）· migrations.ts · schema（无 v9）· page.html · developer-query 语义 · 归因语义
    TRUSTED_LEDGER_WRITERS（仍只有 kernel-ledger-writer）· CANONICAL_LEDGER_RECORDER（仍 SYSTEM/kernel）
    data/pglite（只读）

Tests Run

  pnpm typecheck                 EXIT=0
  pnpm m5.1.1:wp8c2:verify       EXIT=0   **25 / 0｜K-33 = PASS**
  pnpm m5.1.1:wp3:verify         EXIT=0   **51 / 0｜PASS**（改前 49 / 1）
  pnpm m5.1.1:k17:verify         EXIT=0
  pnpm m5.1.1:wp8c1:verify       EXIT=0   （K-32 仍然 CLOSED：15 / 0）
  pnpm m5.1:measurement:verify   EXIT=0

Tests Passed

  C2 专项门 25 / 0，其中"证据链 + 三类 control"逐条：
    权威 mutation 面自动发现 = 3（insert@conversation-store:435 · update@conversation-store:697 · delete@event-store:768）
    权威 writer 文件（insert）**恰好 1 个** = src/infrastructure/persistence/conversation-store.ts
    该 INSERT 经本地常量展开后确实绑定 recorded_by_kind / recorded_by_id / recorded_by_unknown_reason
    envelope 生产者**恰好 1 处** = src/kernel/contracts/conversation-event.ts:400（attributionSlotsOfContext(trusted)）
    受信上下文产出点**恰好 1 处** = src/kernel/contracts/attribution.ts:1569
    canonical recorder = Known(SYSTEM, kernel)（attribution.ts:1927）· writer registry principal 一致
    recordedBy 值构造点 = 2，**全部**使用 canonical 常量（1025 回填 · 1576 受信构造器）
    写链入口携带者：appendConversationEvent(input: AppendEventInput) → AppendEventInput.trustedAttribution → TrustedAttributionContext.recordedBy
      ⇒ **经由受信载体**（不是公共输入面直接给值）
    **callerControlledProviders = 0** · unexplainedReferences = 0
    非 insert 的 mutation 面（update / delete）**不绑定** recorded_by_*
    wp3 门：51 / 0（证明①②③ + 行级 M3/M4/AT-4b/AT-6 全部通过）

Tests Failed

  0（本 execution 没有留下红灯）
  ⚠️ 但**不要**把它读成 WP8 PASS：完整九门 requalification 是 C3 的事，本 execution 没有跑。

Evidence Produced

  artifacts/m5.1.1/wp8c2-k33-baseline-red.log   C2-0 改前红灯基线（**先存证，后改判据**）
  artifacts/m5.1.1/wp8c2-k23-boundary.json      真实仓库的完整边界报告
  artifacts/m5.1.1/wp8c2-k33-verify.json        25 / 0 + 三类 control 实测
  artifacts/m5.1.1/wp8c2-wp3-after.log          wp3 门改判据后全文（51 / 0）
  artifacts/m5.1.1/wp8c2-k17.log · wp8c2-k32.log · wp8c2-measurement.log   回归三门口
  artifacts/m5.1.1/wp3-backfill.json            k23.structuralProofs 现发布完整边界清单（规范证据）

Known Issues

  1. 旧字段 `filesMentioningRecordedByOutsideContract` **已退休**（不再出现在证据里）。
     它不是被"改名"，而是被替换成能力判据的边界清单 —— 见 F4 §1–§4。
  2. 本门的分辨力来自 AST 能力信号，不是完备的数据流分析：它能证明
     "唯一 INSERT + envelope 唯一产出 + 受信上下文唯一产出 + 值构造只用 canonical + 调用方可控 = 0"，
     但**不是**一个通用的 taint 分析器。这个边界如实写进 F4 §4；三个注入负控证明它在**这一类**问题上会响。
  3. `M5L_FREEZE.commit` 实际存的是 annotated tag object id 的命名问题**不属于 K-33**，按你的安排留到 C3 做纯命名明确化。
  4. 冻结证据的恢复规则（`artifacts/m5.1/**` 只能从 `m5.1-complete` 还原）已由 C1 建成不变量：
     本 WP 的回归里碰 `artifacts/m5.1/measurement-negative-controls.json` 时用的就是 **tag blob**
     （回归后 `git diff m5.1-complete..HEAD -- artifacts/m5.1 artifacts/m4.5` = 0）。
  5. K-31 仍 OPEN / DEFERRED / NON-BLOCKING；本 WP 一字未碰。

Architecture Deviations

  1. **单一 analyzer**（C2-10）：recorder 判断只此一份，wp3 门与 K-33 专项门共同消费；
     旧的"文件出现扫描"整段删除，避免第二次 drift。
  2. **wp3 门的断言数 50 → 51**：旧证明②（1 条）换成新证明②（边界）+ 证明③（非 insert 面），净 +1；
     原本红的那条现在绿 ⇒ `49 通过 / 1 失败` → `51 通过 / 0 失败`。
  3. **门里对"0"的读数纪律**：`callerControlledProviders = 0` 与 `unexplainedReferences = 0` 是**结论**，
     不喂给 `measure()`（否则会被读成 MEASUREMENT INVALID）；`measured_count > 0` 由同门 4 条 scope 量承担。
  4. 负控 B 在 **src 的临时副本**上做注入（`mkdtempSync` + `cpSync`），仓库一个字节都不动；
     恢复段是"销毁副本 + 重分析真实 src ⇒ 重新安静"，与 K-17/WP8 的三段式同形。

Commit Hash

  fed2f69  fix(m5.1.1): make the K-23 recorder boundary proof measure capability, not mentions (K-33)
  c205322  test(m5.1.1): WP8-C2 / K-33 evidence -- baseline, boundary report, controls, regression
  （F4 记录、R-40 与本 handoff 在同一份 docs 提交里 —— 该提交本身不列在此）

Next WP Preconditions（**不要在本 execution 开始**）

  1. **WP8-C3 / Full Harness Requalification**：`pnpm m5.1.1:wp8:verify` + `pnpm m5.1.1:gates`，
     目标 `M511-G1…G7` PASS · `G8` NOT RUN · `G9` PASS · `measurementInvalid = 0` ·
     `crossGateConsistencyViolations = 0`。顺带做 C3 约定的纯命名明确化（`M5L_FREEZE` 的 tag object vs commit）。
  2. 只有 C3 全绿，才允许 `WP8 = PASS` · `WP9 = READY / AUTHORIZED`。
  3. K-31 仍 OPEN / DEFERRED；Phase 4 / ADR-043 仍 NOT APPROVED；
     `m4.5:ci` / `m5.1:gates` / `m5.1:regression:verify` 仍留给 WP10。

STOP
```
