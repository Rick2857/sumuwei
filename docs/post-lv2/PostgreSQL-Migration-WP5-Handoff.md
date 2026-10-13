# PostgreSQL 迁移 WP5：数据副本与功能回归 —— Handoff（**进行中**）

日期：2026-10-13（Asia/Shanghai）。runId：`pg-migration-g05-20261013T095334Z`（G05）·
`pg-migration-g06-20261013T120628Z`（G06）· `pg-migration-g08-20261013T115622Z`（G08）·
`pg-migration-bench-20261013T114001Z`（S8）· `pg-migration-live-smoke-20261013T121906Z`（有限真模型）。
状态：**WP5 交付条件全部达成** ——
`PG-G05` **29/29** · `PG-G06` **30/30** · `PG-G07` **47/47** · `PG-G09` **23/23** ·
`S8 资源读数` **12/12** · `PG-G08` **28/28** · **有限真模型 smoke 7/7** ·
`typecheck` 0 · **`pnpm m4.5:ci` EXIT 0**（G12 38/0 · G13 32/0 · G14 52/0 · G2 150/0 · L2 53/0）·
`gates:run --lane postgresql` = **8 道 · PASS 8 · FAIL 0**（本线第一次全绿）。
⚠️ 本包发生过一次真实隔离事故（`PG-ISO-01`）与一次**生产数据写入**（ⓓ 受控重建，用户裁定），
两次都有完整记录。生产**未切换**（切换是 WP7，需单独授权）。
上游：[执行计划](PostgreSQL-Migration-Execution-Plan-2026-10-12.md) §4/WP5 · §6 数据迁移与比较规程 ·
[ADR-132](../adr/ADR-132-postgresql-migration-backend-and-activation.md) ·
[验收契约](PostgreSQL-Migration-Acceptance-Contract.md)（`PG-G05`）·
[门矩阵](PostgreSQL-Migration-Gates-Matrix.md) · [WP4 Handoff](PostgreSQL-Migration-WP4-Handoff.md)。

---

## 1. 它和 `PG-G09` 的分工（别混）

```text
PG-G09  量具**自身**有效吗？   ⇒ 纯函数真值表 + 一张 18 行真表的跨驱动正控 + 四条具名负控
PG-G05  用那个量具比**整个库** ⇒ 54 张表 / 4 261 行逐表规范化摘要 + 主题面 + 六条真数据负控
```

WP4 的 `L-PGW4-01` 写着"比较器只在一张 18 行的真表上做过真跨驱动验证"，
`L-PGW4-13` 写着"逐表行数一致不证明内容一致"。**这两条就是本门要销的账。**

---

## 2. 技术核心：两侧必须拿到**同一段文本**

### 2.1 实测出来的歧义清单（不是猜的）

源是 PGlite（`openPgliteSnapshot`：**复制一次、打开一次、读多表**），
目标是从**同一份快照导出**并恢复出来的真 PG。同一份逻辑值在两个驱动下的形状：

```text
                                 源（PGlite 驱动）        目标（真 PG，经 jsonb_agg）
timestamp without time zone  →   **Date**（解释里带上了时区）  →  无时区的 ISO 文本
vector                       →   **数组**                      →  pgvector 文本 "[1,2,3]"
bigint                       →   number                        →  **JSON 数字**（>2^53 丢精度）
numeric                      →   字符串                        →  **JSON 数字**（>17 位丢精度）
text[]                       →   数组                          →  JSON 数组
```

⇒ 直接比就是"**看起来在比数据、其实在比驱动的编码**"。这正是 WP4 的 `F-WP4-01` 那一类。

### 2.2 修法：一条判据，两个调用点

`scripts/postgresql/column-encoding.ts` 里只有**一条**判据 `requiresTextEncoding(dataType)`，
两个读取器都 import 它（`pglite-reader.ts` 与 `pg-target-reader.ts`）。
**有歧义的类型在 SQL 里就 `::text`**，两侧于是拿到同一段文本。

两条不变式（写在该模块文件头）：

```text
① 只要**两侧拿到同一段文本**，规范化函数对同一段文本的输出必然相同
   ⇒ 时区解释、驱动形状这些歧义**根本不进入**比较
② 转文本**不丢信息**：PG 的类型输出函数是单射（同一存储值 ⇒ 同一文本）
   ⚠️ 反例正是 `numeric → JSON 数字`：那不是单射 ⇒ 必须避开
```

**默认方向是"转文本"**（`requiresTextEncoding` 对不认识的类型返回 `true`）：
不认识就走**不丢信息**的那条路，而不是走"按原生形状猜"那条可能造出**假绿**的路。

⚠️ **`timestamp with time zone` 刻意不转文本**：它的文本输出**依赖会话 TimeZone**
（实测容器是 `Etc/UTC`，而 PGlite 的会话设置是另一件事）⇒ 转文本反而引入一个新的可变因素。
它走 `Date`/ISO 那条路（带时区 ⇒ 解释无歧义）。

### 2.3 顺带修的一处**假绿**风险：`numeric`

`canonicalNumber` 内部是 `Number(value)` + `toPrecision(15)` —— 那是给**二进制浮点**用的
（`real`/`double precision` 本来就没有精确十进制表示，抹掉浮点尾差是对的）。
但 `numeric` 是**精确**十进制，走 `Number()` 会有两个真后果：

```text
① 目标侧经 jsonb_agg 读回时 numeric 是 JSON 数字 ⇒ JS double ⇒ 第 18 位起**静默丢失**
② toPrecision(15) 更是把差异限制在 15 位以内 ⇒ 第 16 位起的差异**一律看不见**
```

⇒ 新增 `canonicalDecimal`（**纯字符串**移动小数点，一位不丢）。它仍然让 `1.50 ≡ 1.5`，
但 `1.00000000000000001 ≠ 1`（`G05.0b` 专门断言这一条）。

⚠️ **本轮数据里恰好一个 `numeric` 列都没有**（列类型分布：text 324 · jsonb 54 · integer 56 ·
bigint 53 · uuid 46 · timestamp 19 · timestamp with tz 11 · vector 7 · double precision 4 ·
real 2 · boolean 6 · ARRAY 3）⇒ 这条修复是**预防性**的，不是被本批数据逼出来的。
如实登记为 `L-PGW5-02`。

---

## 3. 读数（`pnpm postgresql:g05:verify` = **29/29 · 0 失败 · 0 notRun**）

### 3.1 规模

```text
表          54（public 51 + migrations 3）· 行 4 261 · 空表 14
比较策略    primary-key 53 · **multiset 1**（`public.logs`，421 行 —— 全库唯一无主键表）
导出        11 330 234 B · sqlDigest 0dc0066c2b913363…（**与 WP4 那一轮逐字相同**）
            args `--no-owner --no-privileges --no-comments`
自证        sourceUnchanged=true · copyMatchesSource=true · closedClean=true
            源树摘要 e46d8b39512ab9ab…（1269 文件 / 48 992 858 B）
```

### 3.2 逐表结论

```text
G05.1  完整表清单一致（**双向**差集都为空；public 51 / migrations 3）
G05.2  主键集合 + **列规格**逐表一致
G05.3  ★ 全部 54 张表的**规范化内容摘要**逐表一致 —— **0 处不一致**
G05.8  无主键表走稳定行多重集（且它是全库唯一一张）
```

### 3.3 主题面（`G05.4`–`G05.7`、`G05.9`）

```text
来源/归因/更正撤回链（memory_records 5 行）
  status          {active: 3, **retracted: 2**}      ← 撤回历史**在**
  epistemic_status {reported: 5} · authority {EXPLICIT_USER_STATEMENT: 5}
  superseded_by 非空 0 · valid_until 非空 5
  memory_events.kind {MEMORY_CREATED: 5, **MEMORY_RETRACTED: 2**}
  ⇒ 两侧三个取值面**逐项相同**（不是"行数一样"）

记忆生命周期字段（字段在、取值面同、历史没被物理丢弃）
  valid_from 0 · valid_until 5 · occurred_at 0 · recorded_at 5 ·
  superseded_by 0 · revision 5 · schema_version 5（两侧非空计数逐项相同）
  memories 146 · memory_records 5 · memory_events 7（两侧行数相同）

消费者水位与序号（12 + 3 + 1 + 1）
  processor_watermarks  {affect-semantic-cutover 117, post-turn-model-memory 944,
                         affect-evaluator 1026, belief-memory-reconciler 1028,
                         reflection-scheduler 1028, automatic-memory-langmem 1026, …}
  storyline_consumer_watermarks {affect 1, relationship 1, reflection 1}
  character_sequence_counters.next_sequence 1028 · action 436
  ⇒ 两侧逐项相同（**没有**"推进水位来跳过问题"）

插件历史七张表  agents 1 · memories 146 · rooms 2 · participants 3 · entities 3 · worlds 2 · embeddings 0
迁移登记表      character_schema_migrations 18 行 · 版本 1…18 · 最新 name
                `reminder-repeat-mode-and-attempt`
```

⚠️ `memory_records.status` 里那 **2 条 retracted** 是 M9 的 `F-4`（同内容重述永不复活）
留下的真实历史 —— 迁移**把它带过来了**，而不是"清理掉"。这是"不忽略撤回历史"这条判据的实证。

### 3.4 六条真数据负控（每条**只改一处**，且先证明改动生效）

```text
G05.N1  character_jobs        删一行                  ⇒ row_count_differs      （1133 → 1132）
G05.N2  memories              改一个**主键**值        ⇒ primary_key_set_differs（146 → 146 行）
G05.N3  memory_records        改**归因**字段 authority⇒ content_digest_differs （5 → 5）
G05.N4  memory_semantic_index 改**向量**（逐分量+0.001）⇒ content_digest_differs （5 → 5）
G05.N5  processor_watermarks  **回退**水位            ⇒ content_digest_differs （12 → 12）
G05.N6  logs（无主键）        改**一行内容**          ⇒ multiset_differs       （421 → 421）
G05.N6b                       该表**总行数没变** ⇒ 原因只能是 multiset，不能是 row_count
```

**四条具名原因全部在真数据上触达**（`row_count` / `primary_key_set` / `content_digest` / `multiset`）。

⚠️ 每条负控都先断言 `before !== after`（探针读数**确实变了**）。
否则一条**没生效**的改动会让门报"比较器没抓到" —— 那是**假红**，
而假红会把人引去修一个没坏的东西（WP4 的 `F-WP4-07` 就是量具自己造出的假红）。

### 3.5 恢复

```text
G05.R  重新从**同一份导出**恢复一次（drop + create + restore，三步 rc 全 0）
       ⇒ **全部 54 张表又一致**（不需要额外的回滚机制：恢复本身就是回滚）
```

---

---

## 3.7 `PG-G06` 投影与语义召回：**30/30 · 全绿**（`G06.1f` 的岔路口已由 ⓓ 解决）

```text
pnpm postgresql:g06:verify = **30/30 · 0 失败 · 0 notRun · measured_count = 30**
runId pg-migration-g06-20261013T120628Z · 来源 = pglite-2026-10-13T12-02-14-409Z-90cae4d22dcd（新基线）
```

### 3.7.1 通过的部分（G06.2–G06.5 · G06.1 的多数分支）

```text
G06.1d  **恢复确定性**：同一份导出恢复两次（A / B），29 行投影**逐行相同**
G06.1e  核心在 B 上启动成功，**六个 store 级重建**（affect/relationship/belief/reflection/goal/adaptiveSelf）
        全部返回 —— 用的是**生产代码**，不是我重写一遍折叠
G06.1g  `updated_at` 的排除范围**精确**：被重建的 28 行全变，唯一没变的是 `diagnostic-counter`
        （它**没有** store 级重建函数）⇒ 既证明"重建真的写了"，也证明排除是对的
G06.1h  重建**没有**写领域事件（470 → 470）——"投影是缓存、不是事实本体"
G06.1i  A 库上的命令**全是 SELECT**（核心只在 B 上启动过）
G06.2a  vector 版本差异**显式记录**：源 **0.8.0**（读自源快照）→ 目标 **0.8.7**（读自目标库）
G06.2b  3 代 · 3 条记忆 · 5 行 · dim 384   G06.2c  声明维度 == `vector_dims()` 实读维度
G06.3b  相同向量 ⇒ 最近邻**就是它自己**，距离 ≈ 0
G06.3c  距离 0 的那一组按**集合**恰好是 {探针}
G06.4b  等距夹具：两种 tie-break **顺序不同、集合相同**（`[1,0]`/`[0,1]` 到 `[1,1]` 距离精确相等）
G06.4d  ⇒ 集合判据通过、**顺序判据会失败** —— 所以必须按集合比
G06.5a  编码器指纹 8 个字段 A == B（含 `renderer_version` **两个版本共存**：`semantic-render@1` 与 `@2`）
G06.5b  向量逐字未变（`md5(embedding::text)`）——**没有**"重新编码凑一致"
```

否则一条**没生效**的改动会让门报"比较器没抓到" —— 那是**假红**，
而假红会把人引去修一个没坏的东西（WP4 的 `F-WP4-07` 就是量具自己造出的假红）。

### 3.7.2 ★ FAIL：18/19 条 `goal:` 投影重建后 **`revision` 不同**（state 基本一致）

契约 `G06.1` 逐字要求"先记录恢复后投影，再在**另一个**一次性目标重建并比较"。照做之后：

```text
30 条断言里 1 条红：29 行投影里 **18 行不同**，全部是 `goal:` 家族（19 条里 18 条）
差别落在哪一列（逐列刻画，只报列名不报值）：
  · **revision            18 / 18**      ← 主要差异
  · state_md5              1 / 18        ← 只有 1 条（`…:524617ab`，差异在 state 的 `goal` 子对象里）
  · projection_type / reducer_version / last_domain_event_sequence / last_domain_event_id ：**全部相同**
```

也就是说：**重建折进了不同数量的目标事件，却停在同一事件、得出同一个状态**。

#### 3.7.2a 归因（`G06.1m`）：**不是迁移造成的 —— 是生产缺陷**

同一差异在**源快照**上独立复现（不经 PG、不经迁移、不经本次恢复；用**真实代码**
`rowToDomainEvent` + `GOAL_HANDLED_EVENT_TYPES` + `goalEventTargets` + `foldGoalRowsInMemory`）：

```text
源上目标域相关事件 = **51**（GOAL_CREATED / GOAL_REVISED / GOAL_COMPLETED /
                            COMMITMENT_ACCEPTED / COMMITMENT_FULFILLED）
源上 19 行：**18 行「存的 revision > 折叠出来的 revision」· 0 行 < · Δ合计 563** · state 18/19 相同
同一行举例：**存 52 / 折叠 4**
⇒ 与迁移后目标侧读数（18 行 · Δ563 · state 18/19）**同量级同方向**
```

#### 3.7.2b 根因：生产目标写入器把「**全部历史**」喂给了**增量**折叠（`F-WP5-10`）

```text
src/main.ts:1591-1597                                    目标写入器 commit
src/infrastructure/runtime/agreement-runner.ts:131/137   约定桥（already_applied 分支）
src/infrastructure/runtime/agreement-runner.ts:206/209   约定桥（提交分支）
```

三处同形：

```ts
const stored = (await domainEventsFor(db, characterId)).filter(   // ← 不带 afterSequence/limit
  (event) => GOAL_DOMAIN_EVENT_TYPES.includes(event.type),        //   ⇒ **全部**目标域历史
)
await applyGoalRows(db, characterId, stored, now)                 // ← 而它是**增量**折叠
```

`applyGoalRows` 把**已存在的行**读进 cache（带着当前 `revision`），再折"你给的那批"
⇒ 喂全部历史 ⇒ **每个历史事件每次提交都被重折一次** ⇒ `entry.revision += 1` 每次都加。

⚠️ **本仓库早记录过同一机制**：`scripts/m10-harness.ts:138-151`（`L-M10-35`）逐字写着
"把**全部历史**喂给它 ⇒ 每个事件被重复折一次 ⇒ `goal.revision` **膨胀**。
实测：200 轮轨迹里 32 个事件、32 次 `applyGoalRows` ⇒ revision **487**（而全量重放只有 **32**）。
**长轨迹门就是靠这个差异发现的**"。
⇒ 当时修的是**夹具**（harness 只喂 `fresh`）；**三个生产调用点一处都没修**。

**后果（已证 / 未证分开）**

```text
已证：`revision` **不是事件流的函数**（取决于**提交次数**，不是**事件数**）
已证：一次 `rebuildGoalProjections` 会把它**改小**（18/19 行）⇒ 把 revision 当版本号的消费者会看到"版本回退"
已证：每次提交做一次**全量重放**（O(全部目标域事件)）—— 轨迹越长越贵
已证（否定一条担心）：`saveProjection` 的乐观并发**不会**因此报冲突
      （`expectedRevision` 取自**同一事务内**刚读到的行）⇒ 缺陷**静默**膨胀、不报错
未证：是否有消费者按 `revision` 分支（**没做**全仓消费者扫描）⇒ **不主张**"有功能性后果"
```

**候选处置（需独立裁定 · 本轮不裁定）**

```text
ⓐ 三个生产调用点只喂**这一批**事件（harness 已这么做：按幂等键过滤 / 给 afterSequence）
ⓑ 存量修正：重建 `goal:%` 行 —— 但会**改小** revision（那是**数据迁移**，需单独授权）
ⓒ 或裁定"接受膨胀"并把"revision 不可重建"写进契约 —— 那要改的是**契约**，不是门
⚠️ **不许**放宽 `G06.1f` 的判据去迁就现状（= 改量具让红灯变绿）
```

#### 3.7.2c ⏩ **已修（2026-10-13，用户「按你的建议来」）**：修在**折叠**里，不是只修调用方

```text
改动：`src/kernel/projections/goal.ts` 的 `foldGoalRowsInMemory` 加**幂等闸**：
      event.sequence <= 该行已折到的序号 ⇒ 跳过（不再重折）
```

⚠️ **与我原来的建议不同，这里说明白**：原建议是"三个调用点只喂这一批"。实现时发现那会**退化**
`agreement-runner.ts:131-138` 的 `already_applied` 支 —— 那是**修复/追赶**路径
（`eventsWritten: 0`），改成只喂这一批后它的折叠输入变成**空集** ⇒ **追赶能力消失**
（崩在"事件已写、投影未写"之间就再也补不回来）。
⇒ 修在闸上：**喂全部历史仍然安全**，追赶保留、膨胀消失。这也与 `applyMemoryEvent` 的**既有**闸同源
（"已经折叠过：不重复 reduce（否则 revision 会叠加，而 Replay 会算不出来）"）—— 目标域缺的就是这一条。

**行为级证明**（`scripts/postgresql/goal-fold-idempotency-probe.ts`，只读源快照，
照生产调用点的形状"读回全部事件 → 喂增量折叠"）：

```text
带闸（当前代码）  ：变化行 **0** · Δ合计 **0**
不带闸（对照实现）：变化行 **19** · Δ合计 **51**   ← 恰好等于目标域事件数
```

**相关门全部仍绿**：`m10:test` 59/59 · **`m10:long:verify` 12/12**（盯 revision 的那道门）·
`m10:scale:verify` 13/13（含 `rebuild` 对账）· `m10:e2e:verify` · `m10.1:agreement:verify` · `typecheck`。

#### 3.7.2e ⏩ **ⓓ 已执行（2026-10-13，用户裁定）⇒ `G06.1f` 绿了，`PG-G06` = 30/30**

```text
载体：`scripts/postgresql-goal-rebuild-apply.ts` · 操作类别 `goal_projection_rebuild`（枚举**追加**）
状态机：IDLE → LEASED → PREOPEN_SNAPSHOT_VERIFIED → DB_OPEN → SERVICES_STOPPED
        → DB_CLOSED_VERIFIED → POSTCLOSE_SNAPSHOT_VERIFIED → RELEASED（cleanClose = true）
pre-open 快照  2026-10-13T12-02-09-596Z-da3d92413269（回滚点）
post-close 快照 2026-10-13T12-02-14-409Z-90cae4d22dcd（**新迁移来源**）
goal 行 19→19 · 事件 470→470（重建不写事件）· **A==B：19/19 行 · 0 处不符**
逐行 revision 52→4 · 42→2 · 74→4 …；**总和 614 → 51 = 目标域事件数** ⇒ revision 重新是事件数的函数
快照保留：**没有剪枝**（旧快照全在 ⇒ 未发生需单独授权的"删旧快照"）
```

**门读数**：`PG-G06` **30/30 · 0 失败 · 0 notRun**（`differing 0`）· `PG-G05` 29/29（新来源上 54 表仍逐表一致）
· `gates:run --lane postgresql` = **8 道 · PASS 8 · FAIL 0** —— 本线**第一次全绿**。

⚠️ `G06.1m` **换了方向**（不是放宽）：原来是**归因**判据（断言"差异在**源**上就已存在"）；
源修干净后那组断言按定义不再成立 ⇒ 现在守**修复的回归**（`storedGreater=0` · `deltaSum=0` · `stateEqual=19`）。
历史归因保留在 §3.7.2b 与登记册追加③。

⚠️ **迁移来源已重新基线化**（旧来源被这次写入改变了）：11 个脚本/探针的默认来源已改为
`pglite-2026-10-13T12-02-14-409Z-90cae4d22dcd`（用 node 改，**不走 PowerShell**）。
⚠️ **真实库指纹按设计变了**：`e46d8b39…` → `137b723369c7184b4371f2855a93b90a3896285d1728865c69372c5bd3fcaefe`
（1269 文件 / 49 009 242 B）。从此"真实库有没有被动过"的参照物是**新快照**。

#### 3.7.2d ⚠️ **`G06.1f` 曾经仍然红 —— 我原来的判断错了，这里更正**（历史记录，已由 §3.7.2e 解决）

我原先说"改调用点 ⇒ 18 行差异消失 ⇒ 可以真绿"。**那是错的**。修完重跑（runId
`pg-migration-g06-20261013T113118Z`）= **29/30**，`G06.1f` 仍然红，Δ 与修之前**逐字相同（563）**：

```text
闸只堵住**未来**的膨胀，**不会**改写**历史**已存下的值；
而 `G06.1f` 比的是"**恢复出来的行** vs **重建出来的行**" —— 前者带历史污染值，后者是干净值。
⚠️ 也**不能**靠"迁移时顺手重建投影"绕过：`PG-G05` 要求**源与目标逐表内容相同**，
   在目标侧重重建 ⇒ 目标 ≠ 源 ⇒ G05 立刻红。
```

⇒ 岔路口（**本轮唯一悬着的决定**，见登记册"追加 ③"节）：**ⓑ 改契约** / **ⓒ 保持红** /
**ⓓ 修源数据**（受控重建 + 新快照 ⇒ 源与目标都干净 ⇒ `G06.1f` 真绿，但那是一次**生产数据写入**，
需单独授权、要在核心停机窗口做）。**我建议 ⓓ 或 ⓑ**，取决于你是否愿意动生产数据。

### 3.7.3 ⚠️ 本门引入的一次真实隔离事故（`PG-ISO-01`）

第一次把**真核心**对着 PG 目标启动时，连接串只设在了 `process.env.POSTGRES_URL`，
而插件读的是 `runtime.getSetting("POSTGRES_URL")` ⇒ `postgresUrl` 是 `undefined`
⇒ 插件建了一个 **PGlite** 适配器、`dataDir` 取 `.env` 的 `PGLITE_DATA_DIR=./data/pglite`
⇒ **真实库被打开并被写入集群级文件**。门自己的身份核对把它拦住了（报 `实际 template1`，
那是 PGlite 内嵌实例的库名），拦在**任何迁移与业务写入之前**。

```text
影响评估（`scripts/postgresql/production-touch-assessment.ts`，只读源目录、只在 %TEMP% 副本上打开）：
  54/54 张表的规范化内容摘要与 verified 参照快照**完全相同**
  (路径,大小) 摘要 e46d8b39512ab9ab…（1269 文件 / 48 992 858 B）与事故前**逐字相同**
  ⇒ 只发生**原地重写**（pg_control / WAL / pg_xact / pg_internal.init / postmaster.pid），无文件增删改大小
未证：干净关闭（该目录本就是陈旧 postmaster.pid 的不洁净状态）· 不清现场（未删 pid、未动 WAL）
```

三道防线（已落地）：① 连接串走 `runtime.settings`；② `PGLITE_DATA_DIR` 指向本次实验的独占临时目录
（`G06.1j` 断言它 ≠ 真实库）；③ **`G06.1k` 把"真实库目录逐字未动"变成门内断言**
（文件数 + `(路径,大小)` 摘要 + 最新 mtime，启动核心前后必须相同）——
此前这是我**每轮收尾手工看**的一行，现在是**跑门就会验**的一条。

---

## 3.8 资源读数（契约 `S8`）：`pnpm postgresql:bench:verify` = **12/12**

```text
runId pg-migration-bench-20261013T104603Z · 两侧 = **同一份快照**（PG 目标从它恢复 · PGlite 是它的副本）
两侧前置：`B03` 断言"同一条查询在两边的结果相同" ⇒ 比的是**同一个库的两份**
```

### 3.8.1 ①服务端执行时间（`EXPLAIN (ANALYZE, FORMAT JSON)` 的 `Execution Time`，ms）

| 查询 | PG p50/p95 | PGlite p50/p95 |
|---|---|---|
| Q1 全表计数（`conversation_events` 548 行） | 0.130 / 0.160 | 0.246 / 0.299 |
| Q2 带谓词计数 | 0.125 / 0.131 | 0.157 / 0.187 |
| Q3 小表计数 | 0.061 / 0.082 | 0.054 / 0.060 |
| Q4 投影表计数 | 0.064 / 0.066 | 0.074 / 0.084 |
| Q5 `max(sequence)`（水位类读） | 0.148 / 0.164 | 0.262 / 0.465 |
| **Q6 向量最近邻（pgvector `<=>`）** | **0.362 / 0.403** | **0.066 / 0.132** |
| Q7 jsonb 展开 | 0.480 / 0.542 | 0.643 / 0.780 |
| Q8 中等表计数（`character_jobs` 1133 行） | 0.143 / 0.176 | 0.415 / 0.987 |

⚠️ **全部在亚毫秒级**，因为库很小（4 261 行 / PG 侧 19.7 MB）。
⚠️ 这一列**不是**"谁更快"的判据（见 §3.8.4）；唯一值得记的形态差异是 Q6：
向量最近邻在这一档规模上 PG 侧更慢（0.362 vs 0.066 ms p50），
而 Q8 反过来（0.143 vs 0.415）。**两者都不构成任何主张**。

### 3.8.2 ②端到端往返（ms）—— **含各自客户端开销，不互相比较**

| 查询 | PG p50/p95 | PGlite p50/p95 |
|---|---|---|
| Q1 | 0.14 / 0.28 | 0.371 / 0.990 |
| Q6（向量） | 0.14 / 0.19 | 0.338 / 0.678 |
| Q7（jsonb） | 0.31 / 0.39 | 0.729 / 1.142 |

⚠️ PG 侧这 8 行是**在同一个 psql 会话里**用 `\timing on` 连跑 20 次取的
（每题 20 个 `Time:` 样本，`B06` 断言一个不少）。
**为什么必须这么做**：每条查询另起一个 `docker exec psql` 的墙钟约 **85 ms**，
那量的是**进程启动 + 连接**，不是数据库的工作量 —— 本门把这两件事**分开两个读数**。

### 3.8.3 资源与运维读数

```text
PG 库大小           19 740 339 B（≈18.8 MiB）· PGlite 目录 48 992 858 B（≈46.7 MiB）
                    ⚠️ 不是同一种计量对象（PGlite 目录含它自己的 WAL/布局）⇒ 不互相比较
容器 CPU·内存       空闲 0.02% / 78.9 MiB   ⇒  **负载下 83.28% / 82.96 MiB**
负载下连接数         **2**（写入进程 + 只读客户端**同时在连**）
PGlite 侧           "内存" = 本门进程 RSS 350 MB（含 PGlite 实例）· "磁盘" = 快照副本目录
                    ⚠️ PGlite 没有"容器"这种计量对象 ⇒ **分列**
**并发只读**         写入进行中连续读 4 秒：**24 次全部成功 · 0 次失败**
                    （每次 ≈86 ms —— 那是 `docker exec` 的**进程启动**开销，不是查询时延）
**写入进行中的备份** **231 ms · 11 127 245 B · exit 0**，期间提交 **129** 批
```

### 3.8.4 读数归属（写进判据里的一条）

```text
计划 §5 逐字："**未设性能收益目标**，不为更快数字关闭持久性设置"
⇒ `B11` 是**结构性**断言：读数的 JSON 里**不许**出现 faster / winner / speedup / improvement
  之类的判优字段。本门只把读数**分列记下来**，供 WP6/WP7 的运维决策用。
⇒ 迁移的动机是**运维能力**（核心在线时可独立查询/备份/并发访问），不是时延。
```

---

## 3.9 `PG-G08` 功能整链与回归：**20/20 断言通过，但有 2 项具名未运行 ⇒ 按纪律不报 PASS**

```text
pnpm postgresql:g08:verify = **20/20 · 0 失败 · 2 notRun**（`measured_count = 20`）
runId pg-migration-g08-20261013T111509Z
⇒ 退出码 **1**：不是"有断言红了"，而是**缺证据 ⇒ 拒收**（契约："缺证据…均拒收"）
```

### 3.9.1 它怎么"用生产代码"（而不是自己重写一遍）

同一个 PG 目标上**起两次真核心**（`initDatabase` + `initKernel`，与装配根同一条路）：

```text
核心 #1 ── 真实写入路径
  · 记忆：`appendDomainEvent` + `applyMemoryEvent`（**事件溯源真路径**，不是我直接写表）
          读回用真 store `createNativeMemoryStore(db).getActiveByCanonicalKey(...)`
  · 通知：`createIntent` / `reserveOccurrence` / `deferOccurrence` / `pendingCareDeferrals`（真 store）
──断连── `closeDatabaseConnection` + **断言旧句柄真的用不了了**
核心 #2 ── 同一个目标上再起一次（重启续跑）
```

### 3.9.2 场景 A：记忆**增 / 改 / 撤回**（全过）

```text
增    `MEMORY_CREATED` 落库；真 store 读回 `active`（不是我自己写 SQL 查出来的）
幂等  同一个事件**再折一次** ⇒ `created:false`（投影不重复叠加，revision 不叠加）
改    `MEMORY_SUPERSEDED` ⇒ 旧行 `superseded` **且 `supersededBy` 可追溯**
撤回  `MEMORY_RETRACTED` ⇒ 该行不再是 `active`
读数  `…v1=superseded|supersededBy=mem-g08-continuity-v2 ; …v2=retracted|supersededBy=null`
```

### 3.9.3 场景 B：通知（`repeat_mode` / 实例幂等 / `deferred_until`）（全过）

```text
`repeat_mode='until_reply'` **真的落库**（这一列是"跨重启续发"的载体）
  读数：`g08-continuity-dedupe-care=null, g08-continuity-dedupe-reminder=until_reply`
实例幂等：同一个 `occurrenceKey` 第一次 `created:true`、**第二次 `created:false`**
          ⇒ 同一次机会只产生一个外发尝试（**跨重启仍然如此**，见场景 C）
`deferred_until`：
  负控① 对 `reminder` 改期 ⇒ **具名拒绝** `occurrence_defer_not_care`（它只对 `care` 生效）
  正控  对 `care` 改期 ⇒ `ok:true`
  负控② `pendingCareDeferrals` 在"**还压着**"时返回 **1** 条、到点之后返回 **0** 条
```

### 3.9.4 场景 C：重启续跑 + 断连恢复（全过）

```text
核心 #2 在**同一个** PG 目标上启动成功
记忆      状态与关库前**逐行一致**（`v1=superseded` / `v2=retracted`），`supersededBy` 那行仍在
事件      领域事件数**没有增加**（**重启不产生重复写入**）· 投影摘要不变
水位      `processor_watermarks` **12 行的摘要不变**（重启不抹掉、不回退消费水位）
通知      意图与实例**跨重启存活**（`repeat_mode` 与 `deferred_until` 逐字仍在）·
          **跨重启**之后同一个 `occurrenceKey` 仍然 `created:false` ⇒ **重启不会重复外发**
断连      关库后**旧句柄执行查询必须失败**（否则"关库"是空话）· 重连后本门写入的行仍全部可读
```

### 3.9.5 场景 D：外部发送在测试中受控（全过）

```text
`outboundAttempts = 0` · `deliveryChannelsConstructed = 0` · `qqProcessesSpawned = 0`
本门**从不**构造投递通道/适配器，也不起任何 QQ / NapCat 进程；
读到的 QQ/NapCat 环境变量名只**记名字**（**不读值**），本轮为空。
⇒ **没有任何测试消息会发向真实联系人。**
另一条结构性断言：读数里**不许**出现 `@qq.com` / `group_id` / `friend_id` / `uin:` 之类的字段。
```

### 3.9.6 具名未运行（⇒ 本门不报 PASS）

```text
g08.6  后台消费者长跑（真实 tick 循环 + 在飞任务）
       本轮实现了"重启续跑 + 水位不变"，但**没有**起真实消费者 tick 循环跑一段
g08.7  QQ / Live2D 双入口路由
       需要 `ChatSession` 级别的入口维度会话（`CHARACTER_ENTRY_SCOPED_CONVERSATIONS`），本轮未接
```

### 3.9.7 本门自己踩的两个坑（都已登记）

```text
F-WP5-14  **场景级联**：第一版把记忆、通知、关库放在**同一个** try 里 ⇒ 通知那步抛错后
          "关库"与"关库前后比对"根本没执行 ⇒ **9 条断言一起红，其中 8 条没有信息量**
          （它们只是在报"上一个场景没跑完"）。
          ⇒ 修：每个场景 `isolated(label, fn)` **独立兜底**；"关库前读数"与"断连"两步
            **无论场景成败都跑**。修完 20/20（同一份代码，只有隔离方式变了）。

F-WP5-15  **契约细节漏了**：`kind:'reminder'` 的 `createIntent` **必须**给 `sourceRefs`
          （失败关闭：「明确提醒必须有**原请求来源**」），而 `kind:'care'` 反过来**不许**给
          （正文与来源都不许）。第一版没给 ⇒ 通知整段抛错（并被 F-WP5-14 放大成 9 条红）。
          ⇒ 纪律：**调用生产 API 前先把它的失败关闭条件读一遍**，不要靠报错反推。
```

---

## 3.10 有限真模型 smoke：`pnpm with-test-model pnpm postgresql:live:smoke` = **7/7**

```text
runId pg-migration-live-smoke-20261013T121906Z
来源  verified_snapshot · **2026-10-13T12-02-14-409Z-90cae4d22dcd**（ⓓ 之后的新基线）
模型  **deepseek-v4.1-flash**（`.env.test` 指定的测试模型）· provider `openai-chat-completions`
      @ **ark.cn-beijing.volces.com**（测试端点，不是生产端点）
```

### 3.10.1 它是什么（以及**刻意不是什么**）

```text
是   ：在**隔离 PG 目标**（从 verified 快照恢复）上起真核心，让**真模型真的被调用一次**，
       并把这一轮消费者 tick 的**具名结局**如实记下来。
不是 ：接受性评测（不是"她答得好不好"）· 不是长轨迹 · 不是语义质量读数。
⇒ 它只回答一件事：**"在 PG 后端上，真模型这条路真的通"**。
```

⚠️ **与 `PG-G08` 的关系**：G08 的消费者场景用**隔离 provider**（`g08.invalid`，绝不出站）。
本 smoke **只换 provider**，其余（建库/恢复/起核心/造合格来源/tick）**逐字相同** ——
这样"通/不通"的差异只可能来自真模型那一段。

### 3.10.2 读数

```text
tick      kind=ran · scanned=1 · processed=1 · **noImpact=1** · rejectedByValidator=0 ·
          terminalFailed=0 · retryableDeferred=0
耗时      **1734 ms**（一次真调用）
断言      7/7 · 0 失败 · 0 未运行
外部发送  没有 NapCat 容器 · 从不构造投递通道 ⇒ 不向真实联系人发消息
真实库目录 **逐字未动**（`L09z`）
```

⇒ 真模型返回的判定被**解析并提交**为 `noImpact`（中性判定）—— 即"真模型 → 解析 → 提交"
这条链在 PG 后端上是通的，且结局**具名**（不是抛异常、也不是静默）。

### 3.10.3 两条失败关闭（都实测过）

```text
① **必须**经 `pnpm with-test-model` 跑（缺 `DSH_TEST_MODEL_WRAPPER=1` ⇒ 拒绝）
   实测：不带包装器 ⇒ `measured_count = 0` ⇒ INVALID（**绝不回落到生产 key**）
② 来源必须是**已验证快照**：第一版没给 `--snapshot-source` ⇒ `liveSmokeSource` 回落到
   "已干净关闭的真实库" ⇒ 而导出工具**拒绝**导出真实库（"导出工具只对副本工作"）⇒ 当场红。
   ⇒ 修法：显式给 `--snapshot-source=<新基线快照>`。**这是保护生效，不是缺陷。**
```

---

## 4. 本轮抓到并修掉的缺陷

```text
F-WP5-01  `listTargetTables` 里把分隔符写成**裸控制字符**（`n.nspname||<U+0001>||…`），
          而它在**字符串字面量**里的写法（`'<U+0001>'`）是对的 ⇒
          同一条 SQL 里两种写法只差一对引号，报的是
          `ERROR: syntax error at or near ""`，表现为"目标表清单读不出来"。
          修：SQL 里一律用 **`chr(1)` 生成**分隔符，命令行参数里**不放控制字符**。
          ⇒ 纪律：**分隔符不要用不可见字符**；一定要用就在 SQL 里生成，不要嵌进 argv。

F-WP5-02  ★ 两侧形状不同会造出**假不等**：源把无时区 `timestamp` 给成 `Date`（带上了时区解释）、
          `vector` 给成数组、`bigint` 给成 number ⇒ 与目标侧的文本/JSON 数字对不上。
          修：两侧共用的 `column-encoding.ts`（见 §2.2）。
          ⚠️ 这条与 F-WP4-01（**假相等**）方向相反：那条把不一致报成一致，
          这条会把一致报成不一致。**两个方向都要有判据**。

F-WP5-03  `numeric` 走 `Number()`+`toPrecision(15)` ⇒ 第 16 位起的差异**一律看不见**（假绿）。
          修：`canonicalDecimal`（纯字符串、一位不丢）。⚠️ 本轮数据里**没有 numeric 列**
          ⇒ 预防性修复（`L-PGW5-02`），但它是真的：修复前
          `1.00000000000000001` 与 `1` 会判成相同。

F-WP5-04  编辑 `pg-target-reader.ts` 时把 `export interface TargetTableReading {` **整行**
          当成锚点换掉了 ⇒ 3 条 tsc 错（`TS1011` ×2 + `TS1128`），整轮门没跑起来。
          修：补回声明。⇒ 代价只有时间（tsc 立刻可见），但它说明"锚点行别选边界行"。
```

---

## 5. WP5 仍未做

```text
✅ PG-G05 迁移完整性（全库逐表内容比较 · 主题面 · 真数据负控 · 重新恢复）
⚠️ PG-G06 投影与语义召回：**29/30 —— 一条真 FAIL**（`goal:` 的 revision 不可重建；
   已归因到**生产写入器**的 `F-WP5-10`，见 §3.7.2）⇒ 它**不是**"还没做"，是"做了并且红了"
⏳ **PG-G08 功能整链与回归**：记忆增/改/撤回端到端 · 认知恢复（水位/投影/消费者）·
   后台消费者续跑 · 通知与提醒（deferred_until / repeat_mode / repeat_attempt）·
   QQ / Live2D 两条入口路由 · 重启后续跑 · 外部发送在测试中受控 ·
   `typecheck` + **`m4.5:ci` EXIT 0**
⏳ **资源测量**（计划 §5 逐字）：预热后固定仓储操作与有限整链的 p50/p95、错误/超时数、
   连接数、CPU/内存/磁盘、备份耗时；PGlite 对照用**同一快照的一次性副本**（禁止为测速独占真实库）
⏳ **有限真模型**（受控 smoke：隔离 PG + 指定测试模型）
⏳ 性能与行为读数**分列**
```

⚠️ **本轮的 `m4.5:ci` 未跑**，具名原因：`PG-G06` 有一条**真 FAIL** 且未裁定 ⇒
WP5 **不是**交付候选（计划 §5 要求"WP5 / 交付候选必须运行 `m4.5:ci` 并退出 0"）。
本轮跑的是**与该改动相关的那几道门**：`gates:run --lane postgresql` + `typecheck`。
⇒ 这不是"忘了跑"，是"按规矩不跑"；等 `G06.1f` 裁定并修好之后再跑。

---

## 6. 边界

```text
L-PGW5-01  **14 张表两侧都是 0 行**（含 `embeddings`、`relationships`、`tasks`、`channels`…）
           ⇒ 它们的判据是"**结构性**一致"（表在、列在、主键在、0 == 0），
             **不是内容一致**。⇒ 不主张"这 14 张表的内容已验证"。
           连带：`embeddings` 的 6 个 `vector(384…3072)` 列**全是 NULL**
           ⇒ 真正走到向量归一化路径的只有 `memory_semantic_index.embedding`（5 行）。

L-PGW5-02  本轮**没有 `numeric` 列** ⇒ `canonicalDecimal` 只在纯函数层被验证
           （`G05.0b/G05.0c`），**没有**在真数据上验证过。⇒ 不主张"numeric 迁移已验证"。

L-PGW5-03  `bytea` 列本轮**一个都没有** ⇒ `x:` 家族（二进制）仍然只在纯函数层验证过
           （与 `L-PGW4-01` 同一条）。

L-PGW5-04  `timestamptz` 走 `Date`/ISO 那条路 ⇒ **毫秒以下被截断**。
           两个只差亚毫秒的时间戳会被判成相同（**假相等**，方向上是宽的一侧）。
           本批数据里时间戳都来自 JS `Date`（毫秒精度）⇒ 未触达；如实登记。

L-PGW5-05  比较的是**数据**，不是 schema 细节（约束 / 索引 / 序列定义 / 默认值）。
           本门断言了"列规格 + 主键集合"一致；其余 schema 面由表清单与 WP6 的审查负责。

L-PGW5-06  门自建的对象（测试库）在结束时清理；但**六条负控**期间目标库确实被改过
           —— 它们靠"再恢复一次"回到一致（`G05.R`），**不是**靠逐条回滚语句。
           ⇒ 若将来把负控改成"就地回滚"，必须重新证明回滚是完整的。

L-PGW5-07  源侧读取是 `openPgliteSnapshot`（一次复制、打开一次、读多表）。
           它**仍然复制整个目录**（约 49 MB / 1269 文件）—— 只是从"每表一次"降到"整轮一次"。
           `L-PGW4-03`/`L-PGW4-06` 的"复制一次、用多次"在本门已落地。

L-PGW5-08  ⚠️ `PG-G06` **未通过**（29/30，见 §3.7.2）：`goal:` 家族的 `revision` 在
           "增量写入"与"全量重放"两条路径上数得不一样（18/19 条）。**已完整归因**：
           同一差异在**源快照**上独立复现（Δ合计 563、方向一致）⇒ 根因是
           **三个生产调用点把全部历史喂给了增量折叠**（`F-WP5-10`，`src/main.ts:1591-1597`
           与 `agreement-runner.ts` 两处）⇒ **产品缺陷，不是迁移缺陷**。处置需独立裁定。
           ⇒ **不主张**"投影在 PG 上可无条件重建"。

L-PGW5-09  `goal-fold@1` 的**版本串没有变**，而重建结果与恢复出来的行不同 ⇒
           版本串**没有覆盖**"折叠语义可重建"这个性质。⇒ 版本号纪律的一个反例（同 `L-PGW5-08`）。

L-PGW5-10  `diagnostic-counter` **没有** store 级重建函数（只有 `createDiagnosticReducer()`），
           本门**没有**重建它 ⇒ 它的 `updated_at` 未变是**预期**的（`G06.1g` 精确断言了这一点）。
           ⇒ 不主张"29 行全部被重建过"（被重建的是 28 行）。

L-PGW5-11  `G06.2` 的向量读数只有 **5 行 / 3 条记忆 / 3 代**（`embeddings` 表 0 行、
           6 个 `vector(384…3072)` 列全 NULL）⇒ 向量面覆盖的是 `memory_semantic_index`。
           ⇒ 不主张"向量路径在真实规模上验证过"。

L-PGW5-12  `G06.4` 的**等距**场景是用**合成夹具**（3 条 2 维向量）做出来的：
           真实那 5 行里没有并列（`G06.3a` 专门断言了探针内容哈希唯一）。
           ⇒ 不主张"真实数据上出现过等距"；主张的是"判据在等距时按集合比"。

L-PGW5-13  ⚠️ **`PG-ISO-01`**：本门第一次跑时核心静默回退到 PGlite 并打开了真实库
           （见 §3.7.3 与 [事故记录](../incidents/PG-ISO-01-G06-Kernel-Fallback-to-Production-PGlite.md)）。
           内容评估证明**用户数据未变**，但**不主张**"真实库一个字节都没变"
           （集群级文件确实被原地重写过），也**不主张**"干净关闭已证"。
```

---

## 7. 不主张

```text
· 不主张 WP5 完成 —— `PG-G06` 有一条**真 FAIL**（§3.7.2），`PG-G08` / 资源测量 / 有限真模型没做（§5）
· 不主张"投影在 PG 上可无条件重建" —— `goal:` 家族的 `revision` 不可重建（`L-PGW5-08/09`）
· 不主张"整库内容已验证"到"每一列都覆盖"的程度 —— 14 张空表 + 无 numeric + 无 bytea（§6）
· 不主张"比较器同时是 schema 比较器"（只比列规格与主键集合）
· 不主张"性能/资源读数"—— 本门只记了规模与耗时，没有 p50/p95、连接数、CPU/内存/磁盘
· 不主张"对真实核心做过整链回归" —— 本门只碰隔离实例
· ⚠️ 不主张"真实库一个字节都没变"：`PG-ISO-01` 里集群级文件**确实被原地重写过**；
  有证据的是"**用户数据（54/54 表内容摘要）与参照快照相同**"与"干净关闭**未证**"
· 不主张本轮关闭或推进任何历史事故、里程碑或技术债
```
