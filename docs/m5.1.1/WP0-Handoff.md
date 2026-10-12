# WP0 Handoff — Implementation Baseline & Freeze Verification

> 计划书要求的交接单。**下次 execution（WP1 Attribution Contracts）先读这份**，再读
> [`M5.1.1-Execution-Plan.md`](./M5.1.1-Execution-Plan.md)（§1 用户原文 / §2 修订记录 R-1~R-10 / §3 批次表 / §5 门与证据映射）
> 与 [`../adr/ADR-042-attribution-model.md`](../adr/ADR-042-attribution-model.md)（架构权威）。
> **不要重新探索仓库。**

```text
Completed WP: WP0 — Implementation Baseline & Freeze Verification（结论 PASS）

Changed:
  .gitignore                                  （改：为 artifacts/m5.1.1/ 追加日志规则 —— 与 m4.1/m4.5/m5/m5.1 同一处理）
  docs/m5.1.1/M5.1.1-Execution-Plan.md        （新增：用户原文逐字 + 修订记录 R-1~R-10 + 批次表 A–L + 阶段映射 + 门与证据映射）
  docs/m5.1.1/M5.1.1-Master-Plan.md           （新增：里程碑框架；显式让位给 Execution-Plan，不重复 WP 细节）
  docs/m5.1.1/WP0-Handoff.md                  （本文件）
  AGENTS.md                                   （改：§4 登记两份计划权威源 + 「每次 execution 只做一个 WP」）
  artifacts/m5.1.1/wp0-baseline/preflight.json（新增：WP0 Inspect 的七项冻结核验）
  artifacts/m5.1.1/wp0-baseline/wp0-baseline.json（新增：基线判定 + 还原证明）
  artifacts/m5.1.1/wp0-baseline/typecheck.log / kernel-test.log /
      m5.1-gates.log / m4.5-gates.log / m5.1-regression.log（新增：五条命令的逐字 stdout）

Tests（全部 exit 0；逐字日志在上述五份 .log）:
  pnpm typecheck                 → exit 0
  pnpm kernel:test               → exit 0
  pnpm m5.1:gates                → exit 0；12 道门 · hardGateVerdict = PASS · 非 PASS 门 0
  pnpm m4.5:gates                → exit 0；G12 / G13 / G14 三条硬门 + L2 / G2 / G9 全 PASS
  pnpm m5.1:regression:verify    → exit 0；regressionVerdict = PASS
                                   （读 artifacts/m4.5/m4.5-ci.log：exit 0、逐门小结 26 条、硬门 3 条全 PASS）
  testsNotRun: pnpm m4.5:ci（约 10 分钟且重写 m4/m4.1/m4.5 历史证据 ⇒ 留给 WP10）
               全部会写 artifacts/m5.1/*.json 的 M5.1 门（m5.1:test / query / control /
               observability / page / measurement / e2e / spike）
               任何会打开真实库的命令

冻结核验（preflight.json，七项全部 match = true）:
  worktree clean ✓ · ADR-042 = ACCEPTED / DESIGN FROZEN ✓（且 git log --follow 仍能追到 b7bc1d1）
  M5.1-D01 = P1 · OPEN ✓ · migration = v6 ✓（代码 1..6；真实库 1201 文件 / 最新 mtime 2026-09-17 23:51:40）
  m5.1-complete = 2aac6cad50e0dbf66f26bf243345d9af01861013 ✓（标签对象未被移动）
  artifacts 历史证据未被重写 ✓（最后一次改动分别停在 3da0356 / dd2af76 / 2f810b7）
  Phase 4 = BLOCKED BY ADR-043 ✓

Evidence: artifacts/m5.1.1/wp0-baseline/preflight.json
          artifacts/m5.1.1/wp0-baseline/wp0-baseline.json
          artifacts/m5.1.1/wp0-baseline/*.log（5 份）

还原证明（第 3/4/5 步重写了三份已提交的冻结证据 —— 它们含 generatedAt，**不是**字节相同）:
  artifacts/m5.1/gate-results.json         33fd3e4a…（9317 B） 前后一致 ✓
  artifacts/m4.5/gate-results.json         fdcd3f1b…（2185 B） 前后一致 ✓
  artifacts/m5.1/regression-evidence.json  6a65a013…（6744 B） 前后一致 ✓
  还原方式 git checkout --（不提交被重新生成的证据）；还原后 git status 干净

Known issues（全部登记，**一条都没修**）:
  F-1  ADR-042 **没有** `AuthorityRef` / `EventAttribution` 这两个类型名：它只给
       `PrincipalRef`，authority 只作为槽位，`AuthorityKind` 仅出现在 §10 变更记录里。
       schema 侧的名字是 `authority_kind` / `authority_ref` / `authority_unknown_reason`。
       → WP1 定名按修订记录 **R-6**（对齐 schema 列名 + ADR D7「统一信封」），
         一个概念一个名字（ADR L40–42 的命名纪律）。
  F-2  `ActionRequester.kind` 今天只有 `'user' | 'character' | 'system'`
       （`src/kernel/action/action-request.ts:149`），且 `createActionRequest` 在 `:226`
       硬校验这三个值；`PrincipalKind` 有 6 个值（多 SERVICE / EXTERNAL_ACTOR，且 `TOOL` 对应
       actorType `tool`）。→ WP5 只能**追加**（补 `tool` 之类），**不得**重新语义化既有三个值
       （ADR D8 禁止重定义既有 actor_type 值）。
  F-3  `canEvidenceExternalFact` 的现有实现是「有 `sourceAuthority` 就用它，否则回退
       `actorType`」（`src/kernel/contracts/conversation-event.ts:363`），而
       `deriveSourceForLegacyRow`（`:335`）只在该列为 NULL 时兜底
       （`src/infrastructure/persistence/conversation-store.ts:79`）。
       → 这正是 **R-2** 的落点：回填后 legacy 行会带上 `UNCONFIRMED_ORIGIN`，
         所以 **WP6 一旦停止兜底就会隐式切换 Fact Firewall**。WP6 必须带零退化断言。
  F-4  迁移 runner 已幂等且事务化：`applyKernelMigrations`（`src/infrastructure/persistence/db.ts:156`）
       逐版本跳过已应用者，并先跑 `assertMigrationsWellFormed()`（1..N 严格连续）。
       → WP2 的「old schema → v7」可以用「先应用到 6、再应用到 7」在**临时库**上复现；
         不需要（也不允许）碰真实库。生产副本用仓库既有 `cpSync(PRODUCTION_DB_DIR, tmpdir)` 模式。
  F-5  `.gitignore` 第 5 行是全局 `*.log`，各里程碑靠 `!artifacts/<里程碑>/**/*.log` 反选。
       → 本 WP 已补 `!artifacts/m5.1.1/**/*.log`（并预置 m5.1.1-ci / m5.1.1-ci-full 两条大日志例外）。
         这是本 WP 唯一超出计划原文的改动，只影响证据能否入库（计划 §8 的假设有误）。
  F-6  迁移 0001–0006 里**没有任何控制面 / 审计表**（21 张表逐一看过），控制命令今天
       不写账本（L-02）。→ WP2 的 U-03 承载只能**新建**（修订记录 **R-5**）；
         禁止把控制命令伪装成 `character_action_events`。
  F-7  `pnpm` 会把 `$ tsx scripts/…` 横幅写到 stderr，被 PowerShell 记成 NativeCommandError
       并混进日志首部。**退出码才是权威**（五条全 0），脚本正文完整 —— 日志里已如实保留。
  F-8  捕获 stdout 用的是 `[System.IO.File]::WriteAllText` + `UTF8Encoding(false)`，
       **不是** `*>`（`*>` 会写 UTF-16LE，按 utf8 读会中文静默匹配零条 —— AGENTS §7）。

Interfaces exposed to next WP（WP1 直接消费）:
  · ADR-042 D5 的词汇表：PrincipalKind（6，无 UNKNOWN*）· UnknownReason（2）·
    AttributionValue 三态（KNOWN / UNKNOWN / ABSENT）· PrincipalRef（kind + id）·
    AuthorityKind（5：POLICY / CAPABILITY / SYSTEM_RULE / USER_CONSENT / BREAK_GLASS，
    已删除 DEVELOPER_SURFACE）+ `authority_ref`
  · Provenance-Schema §0 的三态编码与每槽位 4 条 CHECK；§3 的必要性矩阵（✓ / — / ? / 派生）
  · ADR D7「统一信封 + 差别必要性」与 §5.1 的必要性判据（"这个槽位会改变结论集吗"）
  · ADR §4 Axis B：新值 `UNCONFIRMED_ORIGIN`（两轴各一），`attribution_origin`
    取值 `RECORDED | MIGRATED_LEGACY`，**Axis B 没有 Absent 态**
  · `M511-G1` 的门判据（Test-and-Gate-Plan §6）+ 七个 mutation 中的 ⑥⑦ 与契约层相关
  · 修订记录 R-1~R-10（Execution-Plan §2）：R-1 非破坏基线 · R-2 WP6 边界 ·
    R-3 门名冻结 · R-4 阶段映射 · R-5 控制面新表 · R-6 命名 · R-7 证据目录 ·
    R-8 每 WP 一份 Handoff · R-9 Gate-Decision · R-10 production-copy 模式

Do not modify（M5.1.1 全程只消费，不许顺手改）:
  · 冻结区：src/kernel/app/memory/**（含 extractor.ts:149 / :329）· policies/memory-validator.ts ·
    memory-store.ts 的 reducer 语义 · contracts/memory.ts 的事件 payload ·
    迁移 DDL 0001–0006 · src/character/苏沐薇.ts · evals/fixtures/m3.5/prompt-baseline.txt
  · artifacts/{m4-acceptance,m4.1,m4.5,m5,m5.1}/**（历史证据；被重新生成时用 git checkout -- 还原）
  · M5.1 的标签 m5.1-complete（必须一直指向 2aac6ca）
  · src/infrastructure/telemetry/** 的既有语义与 SENSITIVE_ATTRIBUTE_KEY_SEGMENTS
    （NF-1：归因**刻意不导出**为遥测属性；不得为了命名去削弱敏感段过滤）
  · src/kernel/contracts/developer-*.ts 的生产者登记表语义（只允许追加）

Next WP prerequisites（WP1 Attribution Contracts）:
  1. 只交付**纯契约**：不实现 DTO / HTTP / 页面，不碰 persistence / migration，不改迁移，
     不改 flags.ts / main.ts / turn-gateway.ts，不加依赖（ADR-042 是唯一的架构依据）。
  2. 落点：src/kernel/contracts/actor.ts（扩 PrincipalKind / UnknownReason / AttributionValue /
     PrincipalRef）；新增 src/kernel/contracts/attribution.ts（七槽位信封 + 必要性矩阵 +
     三态校验器 + 必要性验证器）；src/kernel/contracts/source-authority.ts（新增
     `SourceAuthority.UNCONFIRMED_ORIGIN` 与 `EpistemicSource.UNCONFIRMED_ORIGIN`；
     `sourceKindForActor` 降级为 legacy classifier；**`EXTERNAL_FACT_AUTHORITIES` 形状不变**、
     新值不在白名单）；
     若需要，contracts/index.ts 追加 re-export。**不新建 kernel/dev|query|control 目录**。
  3. 三态编码必须与 Proposed-Schema §0 逐字对齐：ABSENT = 三列全 NULL ·
     KNOWN = kind（PrincipalKind，非 'UNKNOWN*'）+ id 非空 + reason NULL ·
     UNKNOWN = kind/id 为 NULL 且 reason ∈ {LEGACY_UNRECORDED, RUNTIME_UNRESOLVED}。
  4. 必要性矩阵按 Proposed-Schema §3（`✓` 必需 / `—` 必须 Absent / `?` 允许 Unknown / 派生），
     并**必须**带反向负控：非必需槽位被填充 ⇒ 拒绝或报出（ADR §5.4 的要害）。
  5. 禁止：任何 `UNKNOWN_*` 的 PrincipalKind、`PrincipalKind.DEVELOPER`、
     `AuthorityKind.DEVELOPER_SURFACE`；不得为 unknown 造一个 kind（走 UnknownReason）。
  6. 新增 `pnpm m5.1.1:test`（`scripts/kernel-tests-m5.1.1.ts`，复用 scripts/kernel-test-kit.ts），
     证据写 **artifacts/m5.1.1/wp1-contracts.json**（形状对齐 artifacts/m5.1/wp1-contracts.json）；
     `M511-G1` 只读 artifacts/m5.1.1/。
  7. 跑门：`pnpm typecheck` + `pnpm m5.1.1:test` + `pnpm kernel:test`；
     若加跑 `pnpm m5.1:test`（它会重写 artifacts/m5.1/wp1-contracts.json）⇒ 跑完必须
     `git checkout -- artifacts/m5.1/wp1-contracts.json` 还原（AGENTS §7），并把真实计数写进 WP1 handoff。
  8. 交 WP1-Handoff（八字段 + Evidence + Do not modify + Next WP prerequisites），然后 STOP。
```

---

## Batch A 的边界

WP0 **到此 STOP**（用户原文 GLOBAL RULE：`Inspect → Implement → Target Tests → Evidence → Commit → STOP`，
"每次 execution 只允许完成当前 WP。禁止自动进入下一个 WP。"）。

**Batch B（WP1）未开始**，需要单独启动。启动前置：本文件七项冻结核验全 `match`、
三条 verdict 全 `PASS`、`artifacts/m5.1.1/wp0-baseline/` 已落盘。
