# WP2 Handoff — v7 Additive Schema Migration

> **结论：WP2 = PASS（临时库范围，含 K-4 修正）。**
> **production-copy migration = NOT RUN** —— 按用户原文，WP2 到此**等你放行**才进入真实副本的迁移测试。
>
> 下次 execution **先读这份**，再读
> [`M5.1.1-Execution-Plan.md`](./M5.1.1-Execution-Plan.md)（§1 原文 / §2 修订记录，**新增 R-11 K-4、R-12 K-3、R-13 执行纪律**）、
> [`WP1.1-Handoff.md`](./WP1.1-Handoff.md)（Axis B 的取值域与 fail-closed 边界）、
> [`M5.1.1-WP1.1-Compatible-Assertion-Record.md`](./M5.1.1-WP1.1-Compatible-Assertion-Record.md)（§6 = 本 WP 的断言改动）。
> **不要重新探索仓库。**

```text
Completed WP: WP2 — v7 Additive Schema Migration（PASS · 临时库范围）
              K-4（物理三态编码）= CLOSED IN WP2
              production-copy migration = NOT RUN（等用户放行）

Changed Files:
  src/infrastructure/persistence/migrations.ts   （改：新增 MIGRATION_0007，114 条语句；
                                                  0001–0006 一字未改）
  scripts/verify-m5.1.1-migration.ts             （新增：WP2 的门，77 项断言）
  scripts/verify-m4-persistence.ts               （改：**一条**既有断言的最小兼容更新 C-2）
  package.json                                   （改：新增 m5.1.1:migration:verify）
  artifacts/m5.1.1/wp2-schema.json               （新增：WP2 证据）
  artifacts/m5.1.1/migration-preview.txt         （新增：v7 的逐条语句 + 待应用清单）
  artifacts/m5.1.1/wp2-gate-exits.txt            （新增：10 条命令的真实退出码）
  artifacts/m5.1.1/wp2-*.log（11 份）            （新增：逐字 stdout）
  artifacts/m5.1.1/wp1-*.json（2 份）            （改：重新生成为**带真实退出码**的版本）
  docs/m5.1.1/M5.1.1-Execution-Plan.md           （改：R-11 / R-12 / R-13）
  docs/m5.1.1/M5.1.1-WP1.1-Compatible-Assertion-Record.md（改：§6 = 本 WP 的 C-2）
  AGENTS.md                                      （改：§3 迁移行、§6.8 计数自检、§7 restore whitelist）
  docs/m5.1.1/WP2-Handoff.md                     （本文件）

Tests Run（全部 exit 0）:
  pnpm typecheck                      → 0
  pnpm kernel:test                    → 0
  pnpm kernel:test:conversation       → 0
  pnpm m5.1.1:test                    → 0（41 通过 / 0 失败）
  pnpm m5.1.1:migration:verify        → 0（**77 通过 / 0 失败**）
  pnpm m3:verify                      → 0
  pnpm m3.5:verify                    → 0
  pnpm m3:migrate-gate                → 0
  pnpm m4:verify                      → 0（142 通过 / 0 失败）
  pnpm m4.5:test                      → 0
  未运行：m4:ci / m4.5:ci / m5:gates / m5.1:gates / 任何 Live Smoke
  （WP2 只需要 AGENTS §5 对 migrations.ts 的那五道 + 自己的门；整链回归留给 WP10）

Tests Passed: 77/77（迁移门）· 41/41（契约门）· 142/0（m4:verify）· 10 条命令全 exit 0
Tests Failed: 0
Tests Not Run: production-copy migration（等放行）；m4:hardkill:verify（见 K-7）

Evidence Produced:
  artifacts/m5.1.1/wp2-schema.json —— 含：
    · k4：用户裁定原文、样板非法元组、**真值表**（草案 4 条 CHECK 放过它 / K-4 三分支拒绝它）
    · static：1..7 序列、0001–0006 内容指纹、M1 破坏性语句扫描 = 0、v7 语句 114 条、
      DDL 列名 == 契约的 22 列、**7 个受控词汇逐条与契约常量比对（全部相等）**
    · database：沙箱路径（tmpdir，isProductionDir=false）、fresh→v7、v6→v7（applied=[7]）、
      幂等（applied=0/skipped=7）、**净新增列数（20→39 = +19；12→34 = +22）**、
      两张表各 23 条 CHECK（6 三态 + 6 kind 词表 + 6 reason 词表 + Axis B 5 条）、
      唯一 partial 索引、控制面审计表 22 条 CHECK
    · probes：三态 10 个组合 + authority 4 个 + Axis B 6 个 + 旧代码兼容 + 控制面 5 个，
      **每一条都带 expected/observed**（数据库是裁判）
    · measurements：19 个计数型检测器，**无效 0**（全部 measured_count > 0）
  artifacts/m5.1.1/migration-preview.txt —— v7 的 114 条语句逐条可读 + v6 库上的待应用清单
  artifacts/m5.1.1/wp2-gate-exits.txt —— 10 条命令的真实退出码（来自包装命令，非手打）

Commit Hash: 950be2f5735e0a5d412eb0f7ffa42ca087f22ef2

Known Issues（含本 WP 自己踩的坑，全部如实登记）:
  K-4  【已闭环】三态物理编码：**不采用** Proposed-Schema §0 的 4 条草案 CHECK。
       实测该草案允许 `(kind='USER', id=NULL, reason=NULL)` 这一非法第四状态
       （证据里用真值表 + 真实插入复现）。改为一条精确三分支 CHECK + 独立词表 CHECK。
       **约束数量不是架构不变量，三态精确互斥才是**（R-11）。
  K-7  `scripts/verify-m4-hardkill.ts:205` 写死了 `schemaVersion === 5` ——
       代码现在 v6、WP2 之后 v7，因此这条断言在任何情况下都会报 FAIL（**已过期，早于本 WP**）。
       它既不在 WP2 的必跑清单里，也不在 `m4:ci` 链里。**本 WP 未改它、也未运行它**
       （这里说的是读代码得到的事实，不是运行结论）。建议你决定何时把它改成
       `schemaVersion === latestSchemaVersion()`（与 m3.5:verify / m4:verify 同一写法）。
  K-8  v7 的内容指纹**刻意还没锁**（`FROZEN_MIGRATION_FINGERPRINTS` 只有 0001–0006）：
       它还没 applied 到任何真实库。等 WP10 正式 applied 之后再把 v7 的指纹补进去
       （否则现在锁会把"还在改 v7"变成噪声）。
  K-9  `contracts/index.ts` 的 re-export **仍然 DEFER**（你已裁定：留给第一个真正需要它的 WP）。
       因此本 WP 的门与 m4 的兼容更新都是**按路径直接 import** `contracts/attribution.ts`。
  K-10 **K-3 的矩阵同步仍然 PENDING**（R-12）：`tool_event` 的
       `actor=REQUIRED / contentOriginator=REQUIRED / executor=ABSENT`（历史迁移 D/D/N）已裁定，
       但 `Proposed-Schema` / `Migration-Strategy` / WP1 必要性矩阵 / 契约测试四处**还没同步**。
       它是 **WP3 与 WP4 的强制前置**；本 WP 未动它们（WP2 是 schema-only）。
  K-11 【自曝缺陷①】我的 WP2 门第一版把"6 个槽位各一条 kind 词表"用朴素后缀 `_kind_vocab`
       去数，把 `source_kind_vocab` 也算进来 ⇒ 报 7 条。已改成按槽位名匹配。
  K-12 【自曝缺陷②】控制面审计表的 K-4 探针用 `input.actorId ?? 'dev-console'`，
       于是"显式传 null"被换成了默认值 —— **探针自己把要测的非法元组变成了合法行**，
       报出"非法元组竟然通过了"。已改成区分"没传"与"传了 null"。
  K-13 【自曝缺陷③】回退成 v6 的第一版把 22 列**全 drop**，于是把迁移 0003 建立的
       `source_kind` / `source_authority` / `epistemic_source` 也删了，模拟出来的不是 v6
       而是"v6 再缺三列"（列数 17 而不是 20）。已改成只 drop **净新增的 19 列**，
       并显式删掉那三列上的 v7 词表约束。**这条缺陷正是"净新增 19 / 22"被单独量出来的原因。**
  K-14 【自曝缺陷④】一次包装脚本把退出码环境变量**在跑完 `m5.1.1:test` 之后**才设置，
       于是那一轮把 WP1.1 的证据写成了 `suiteExits = null`。已用正确的顺序（先跑其余命令、
       记下真实退出码、**最后**跑 m5.1.1:test）重新生成。
  K-15 `m4:verify` 的一条既有断言（C-2）因 v7 纯追加列而变红，已做**最小兼容更新**并逐条记录
       （兼容性记录 §6）。**判据没有被放宽**：仍是精确集合相等（39 列）。

Architecture Deviations:
  D-1  **K-4 物理闭合**改变了"每条槽位 4 条 CHECK"的字面实现：改为 1 条精确三分支 CHECK
       + 2 条词表 CHECK（kind / reason）。这是**编码修正**，不是 ADR-042 语义变更
       —— ADR-042 一个字未改。
  D-2  额外加了 `axis_b_complete`（声明了 origin 就必须 Axis B 三列齐）：这是 M7 的**库级形式**，
       超出 K-4 的字面清单，但属于同一条"让数据库执行已冻结语义"的授权。
       未加的是"回填行不得有具体 content_originator"（那是 WP3 的**计数门 M4**，不是写入期形状）。
  D-3  v7 的 DDL 用**字面量**词汇表而不是 import 契约常量（已发布迁移必须冻结；
       否则同一个迁移在新库上会生成不同的约束 ⇒ 库间差异）。漂移由门里的
       "DDL 词表 == 契约常量"断言负责发现。
  D-4  控制面审计承载 `developer_control_events` **没有** Axis B 三列：
       它是运维审计，不是内容事件的认知轴（U-03 的最小物理表示）。
       它的 `command_type` / `outcome` / `disposition` / `verification` 四个短闭集加了词表 CHECK；
       `reason_code` 不加（那是开发者平面的可扩展登记表，留给 WP5 的门去守）。

Do not modify（后续 WP 只消费）:
  · 0001–0006 的任何一条（指纹锁会红）；v7 的既有语句（它一旦 applied 就是历史）
  · 运行时写入路径 / 读出侧语义 / Fact Firewall / extractor / Recall / MemoryAuthority
  · artifacts/{m5.1,m4.5,m5,m4-acceptance,m4.1}/**（历史证据；还原只按 whitelist）
  · data/pglite（真实库；只有 src/main.ts 能开它）
  · M5.1 的 m5.1-complete 标签（仍须指向 2aac6ca）

Next WP Preconditions（WP3 — Legacy Backfill）:
  1. **先做 K-3 的矩阵同步**（R-12，一个很小的任务）：把 Proposed-Schema / Migration-Strategy /
     WP1 必要性矩阵 / 契约测试四处统一成
     `tool_event.actor=REQUIRED · contentOriginator=REQUIRED · executor=ABSENT`（历史 D/D/N）。
     **不得让旧的冲突矩阵静默变成实现真相** —— 它是 WP3/WP4 的强制前置。
  2. WP3 的回填按 `event-family × slot` 的 D/P/U/N 矩阵执行；`M511-G6` 的 **M7 现在不再被阻塞**
     （Axis B 两列取值域齐了，且 `UNCONFIRMED_ORIGIN` fail-closed）。
  3. **需要你放行**才可以进入真实副本的迁移测试（WP2 的 STOP 点就在这里）：
     `备份 → 核对(文件数+字节) → cpSync 副本 → migrate 预览 → 副本 apply → 计数 → 重放`，
     并记录 restore epoch / boundary（Migration-Strategy §7）。
     真实库**只复制、从不打开**。
  4. 证据一律写 `artifacts/m5.1.1/`；若某条既有断言因本次追加而变红 ⇒
     按 F4 做最小兼容更新并追加到兼容性记录的同类小节。
  5. 交 WP3-Handoff（九字段）后 STOP。
```

---

## Batch C 的边界

WP2 **到此 STOP**。没有开始 WP3：没有写任何回填逻辑，没有读/写真实库，
`data/pglite` 全程只被记录路径、从未被打开。

**为什么说 PASS 却又把 production-copy 记成 NOT RUN**：用户原文的 WP2 STOP 点是
"等待用户允许进入真实 production-copy migration 测试"。
本 WP 完成的是**物理承载能力**（schema + 约束 + 门 + 证据），并且是在**临时库**上证明的；
把 v7 施加到真实数据的副本上，是 WP3/WP10 的事 —— 那一步需要你先放行。
