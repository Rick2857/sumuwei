# PostgreSQL 迁移 WP3：生命周期与写入资格 —— Handoff（**部分交付**）

日期：2026-10-13（Asia/Shanghai）。runId：`pg-migration-wp3-20261013T134718`。
状态：**WP3 部分交付** —— 两个真缺陷已修并在真 PG 上取得修前/修后对照读数；
**资格锁、服务器重连、消费者生命周期、共存启停适配、`PG-G03` 门均未开始**（见 §5）。
生产**未切换**；真实库**未被打开**。
上游：[执行计划](PostgreSQL-Migration-Execution-Plan-2026-10-12.md) §4/WP3 ·
[ADR-132](../adr/ADR-132-postgresql-migration-backend-and-activation.md)（`D05`/`D06`）·
[验收契约](PostgreSQL-Migration-Acceptance-Contract.md)（`PG-G03`）·
[WP1 Handoff](PostgreSQL-Migration-WP1-Handoff.md) · [WP2 Handoff](PostgreSQL-Migration-WP2-Handoff.md)。

---

## 1. 本包做了什么（**只有**这两件 + 一处量具修正）

| 文件 | 性质 | 内容 |
|---|---|---|
| `src/infrastructure/persistence/runtime-shutdown.ts` | 改 | **F-WP2-01**：`isDatabaseClosed()` 增加 PostgreSQL 分支 |
| `src/db/index.ts` | 改 | **F-WP2-02**：`initDatabase()` 拆成"失败回收包装层 + 内层正常路径" |
| `scripts/postgresql/init-probe.ts` | 改（量具） | 负控的**前置条件**如实分列（见 §3） |

**没有改**：`production-open-guard.ts`（INV-DB-01…07 照旧）· 任何门脚本的断言 ·
`.env` · 任何与 PG 无关的模块 · `pg` 的依赖声明（仍未成为根依赖，见 §6）。

---

## 2. F-WP2-01 · `isDatabaseClosed()` 的 PostgreSQL 分支

### 2.1 根因（读源码确认，不是推测）

```text
PostgreSQL 下 connection = adapter.manager.getConnection() = pg.Pool
  · pg-pool@3.14.0 全文 `this.closed` 命中 **0**
  · PostgresConnectionManager 暴露的是 isClosed()（方法）与 _closed（私有）
⇒ 旧实现的两个分支（connection.closed / adapter.closed）**都取不到** ⇒ return false
```

### 2.2 判据选的是 `pool.ended`，并且**明确拒用**两个更省事的写法

| 候选 | 源码依据 | 为什么不选 |
|---|---|---|
| **`pool.ended`** | `pg-pool/index.js:141` —— 只在 `this._clients.length === 0` 那一支里置 `true` | ✅ **选它**：这才是"池真的空了" |
| `pool.ending` | `index.js:107` 构造；`end()` 一调用就置 true | ✗ **假阳性**：关还没完成就报"已关闭" |
| `manager._closed` | `PostgresConnectionManager.close()` 是"**先置标记再** `await pool.end()`" | ✗ 同样假阳性；ADR-132 `D06` 明确不许用管理器标记当关闭凭证 |

### 2.3 修前 / 修后（真 PG）

```text
修前：isDatabaseClosed=false，而**池真的关了**
      （pg_stat_activity 里 lg_migrate 会话数 = 0）
      ⇒ 假阴性。方向安全（失败关闭），但"关闭是问出来的"在 PG 上答不出来。

修后：isDatabaseClosed=true
      验证：init-probe 在全新库 lg_test_wp3 上跑完 12 步，该步 PASS
```

⚠️ **顺序刻意如此**：PGlite 客户端**没有** `ended`，`pg.Pool` **没有** `closed`
⇒ 两个分支互不干扰，既有 PGlite 判据**逐字未动**。

---

## 3. F-WP2-02 · 初始化失败回收连接池

### 3.1 根因

```text
initDatabase() 的顺序：
  registerPlugin(sqlPlugin)   ← **这一步就已经建好池**（PG 是 pg.Pool，min=2）
  → 身份核对                  ← 可以抛
  → runPluginMigrations()     ← 可以抛
  → … 更多

抛错时池已存在，而**没有任何人关它** ⇒ Node 事件循环被池的空闲连接撑住 ⇒ 进程永不退出。
PGlite 分支**没有**这个症状（嵌入式客户端不持有撑住事件循环的独立连接）
⇒ 这是**换库才暴露**的缺陷。
```

### 3.2 修法

```text
对外 initDatabase() = try { initDatabaseInner() } catch { reclaimAfterInitFailure(); throw }
两条纪律：
  ① **不覆盖**原始错误 —— 原错误才是可诊断的那一个，回收失败只是附注
  ② **不假装**回收成功 —— 回收本身失败就如实记 error，不吞
closeDatabaseConnection() 在没有 adapter 时是**安全 no-op**（AT3.3）
⇒ "assertDatabaseAccessAllowed() 就抛了"这条路径调它也安全。
```

### 3.3 修前 / 修后（真 PG）

| 项 | 修前 | 修后 |
|---|---|---|
| 进程是否退出 | **14 分钟未退出**（PID 40448 仍在） | **1 秒**内退出，exit code 1 |
| 错误是否仍如实 | 是（`db_identity_mismatch`） | 是（**信息一字未变**） |
| 池里是否握着会话 | **1 个**（`idle`/`wait_event_type=Client`） | **0 个**（`lg_migrate_sessions=0`） |
| 是否发生了写入 | 否（表数 0） | 否（表数仍 0） |

⇒ "池真的被回收了"不是靠进程结束推断的，是靠**服务端会话数归零**证明的。

---

## 4. 量具修正（一处，本轮踩到）

`init-probe` 的负控"未放行时 Kernel 迁移闸拦住"**有前置条件**：目标库必须是**全新**的
（`character_schema_migrations` 为空）。对**已有 schema** 的库，`pendingMigrations()` 返回 0
⇒ 闸**没有东西可拦** ⇒ 首次 `initDatabase` 会成功。**那是正确行为，不是闸失效。**

第一版把它记成 `FAIL`（"initDatabase 竟然成功了 ⇒ 闸没生效"）—— **那是量具的错，不是产品的错**。
现在如实分列：新鲜库 ⇒ 断言；已有 schema ⇒ 记进 `notRun` 并**具名原因**。

⇒ 纪律：**负控也要写清前置条件**，否则"负控红了"可能只是环境不对。

---

## 5. WP3 仍未做（下一轮清单）

计划 §4/WP3 的必交付物是"连接池关闭、初始化失败回收、服务器重连；核心资格与消费者生命周期；
共存启停适配"；退出条件是"正常/异常关闭、**断锁**、**在飞模型晚返回**、**第二核心拒绝**场景通过；
其他读客户端可访问，服务器持续运行"。**本包只完成了前两项**：

```text
✅ 连接池关闭            —— F-WP2-01 修完并在真 PG 验证
✅ 初始化失败回收        —— F-WP2-02 修完并在真 PG 验证
✅ 核心资格锁（D05）      —— **已实现 + 已用两个真实 OS 进程验证**（见 §5.1）
✅ 资格锁接进生产装配      —— **已接线**（`src/main.ts` 装配根；见 §5.1 的 W3.1–W3.4）
✅ PG-G03 门（两个真实 OS 进程）—— **已落成**：`pnpm postgresql:g03:verify` = **23/23 · 0 失败**
✅ PG-G02 门             —— 已落成：**31/31 · 0 失败**（含 `G01.7-real-pg` 的行为面）
✅ **G01.7-real-pg**     —— **已关闭**（同进程换目标 ⇒ 具名拒绝；见 §5.2）
✅ **服务器重连**          —— **已关闭**（服务器重启 ⇒ 资格被观测到失效 + 可重新取得；见 §5.3）
⏳ 消费者生命周期 / 共存启停适配 —— 未开始
⏳ 在飞模型晚返回（计划 §5 的 G03.4）—— 未开始
```

---

## 5.3 服务器重连（`G03.6`）：重启 ⇒ 资格必须**重新建立**，不能假设还在

### 它抓的是什么

```text
朴素实现：只在启动时取一次 advisory lock，之后不再核对。
服务器重启 ⇒ 所有会话消失 ⇒ 那条 session 级 advisory lock **也随之消失**
⇒ 旧资格已经不成立。朴素实现会在重启后继续以为自己是唯一执行者 ——
   而实际上另一个核心可以**正当地**取得锁 ⇒ **两个认知执行者同时写**。
```

### 方法（复用既有的 `hold` 模式，不新造探针）

```text
起持有者（--mode=hold --seconds=30）→ 等 4s（确认已取得）→ docker restart --time 20
→ 等实例回到健康（最多 90s）→ 读持有者读数 → 另起一个 try 探针
```

### 读数（四条，全 PASS）

```text
G03.6-前置  容器重启命令成功
G03.6       重启后服务器**确实回来了**（不把实例留在停着的状态）
G03.6b      持有者的资格被**观测到**失效（heldAfterWait=false + 具名可观测原因）  ← 本条核心
G03.6c      重启后**另一个进程可以取得**资格（旧锁真的随会话消失了）
```

### 两个刻意的设计

```text
① **接受四种失效原因**：connection_error / connection_ended / verify_failed /
   **backend_pid_changed**。
   为什么第四个也在列：重启时"池悄悄换了一条新连接"是可能的（pg.Pool 按需新建）⇒
   那种情形下失效原因是 backend_pid_changed 而不是 connection_error。
   四种都是**可观测事件**；断言不挑具体哪一种，但**必须**是这四种之一。

② **门自己会重启容器 ⇒ 它必须无论断言成败都把实例带回来**（`waitForHealthy` 最多等 90s）。
   否则一次失败的断言会把实例留在停着的状态，后面所有 PG 门跟着失败 ——
   那会把"一个门红了"放大成"整条 PG 线不可用"。
   manifest 的 `why` 已写明这一点，并把该门标为 **serial**（它会打断别的 PG 门）。
```

⚠️ 容器重启**不丢数据**：数据在命名卷 `lg-postgresql-data` 里。

证据：`artifacts/post-lv2/postgresql-migration/pg-migration-wp3-20261013T134718/
server-restart-and-qualification.json`。

---

## 5.2 `G01.7-real-pg`：同进程第二个 PostgreSQL 目标（已关闭）

### 要防的那个实测形状

```text
plugin-sql 的连接池全局键 = `${managerKey}:${useNeonDriver ? 'neon' : 'pg'}`
managerKey 缺省 = 'default'
⇒ **键里没有连接地址**
⇒ 同进程先开 A、再开 B ⇒ createDatabaseAdapter() **复用 A 的池**
⇒ 对 B 的查询**实际落在 A 上**，而调用方从配置上"以为"连的是 B
```

计划 §3.2 的首期裁定是"隔离库用**独立进程**，显式关闭池；**同进程多目标路径必须拒绝**"。

### 实现：`postgresTargetGuard()`（判据用规范化三元组，不按字符串比）

```text
alreadyOpened = undefined            ⇒ 放行（首次打开）
同一目标（含 localhost/127.0.0.1、默认端口、尾斜杠、scheme 别名等写法差异）⇒ 放行（幂等）
**换一个**目标                        ⇒ 具名拒绝 second_postgres_target_in_process
任一侧解析不了                        ⇒ 拒绝（证明不了"是同一个"就失败关闭）
```

接在 `src/db/index.ts` 的 `initDatabase()` 里，位置在 **`registerPlugin` 之前** ——
那一步才是"创建/复用连接池"发生的地方（放它后面等于"先把 B 的查询发到 A 的池上，再回头说目标不对"）。

⚠️ 刻意**不**做"清掉缓存再连"：那正是计划 §3.2 禁止的"直接清空缓存掩盖悬空连接"。

### 真 PG 行为读数（`PG-G02` 的 `G01.7-real-pg` 四条，两个真库）

```text
① 首次打开 A                        ⇒ ok，database=lg_test_g02
② **重复打开同一个** A               ⇒ ok（**对照**：守卫不误伤幂等路径）
③ **换到 B**                        ⇒ 拒绝，code=second_postgres_target_in_process
④ 探针收尾 closedClean=true         ⇒ 进程 1.1s 退出（见下）
```

② 是**必需的对照**：没有它，"③ 被拒"可能只是因为"第二次调用 `initDatabase` 本身就会失败"。

### 本轮踩到的一件事：探针**成功**时也要关池

```text
症状：探针进程**永不退出**（14:56 起，仍在）；pg_stat_activity 里 lg_migrate 握着 1 个
      lg_test_sa 会话；强杀后立刻归 0。
机理：三次尝试**共用同一个池**（插件按 `default:pg` 缓存）。
      它是"F-WP2-02 的另一面" —— F-WP2-02 是"初始化**失败**时没人关池"（已在 initDatabase 修掉）；
      这一条是"初始化**成功**"时池**本来就该开着**（那是应用自己的池）
      ⇒ 失败回收**不会**（也不该）触发 ⇒ **探针/脚本**在正常路径要自己关。
第二次尝试仍挂：`closeDatabaseConnection()` 给的是**失败那次**的 runtime ——
      守卫在 `registerPlugin` **之前**就抛了 ⇒ 那个 runtime 没有 adapter ⇒ 关闭是 no-op（AT3.3）。
      ⇒ 修法：只记**成功开库**的那个 runtime。
```

---

## 5.1 核心资格锁（`D05`）：读数逐条

**实现**：`src/infrastructure/persistence/single-core-qualification.ts`。
形状 = **专用连接**（`pool.connect()` 取一条并**持有**，不是借了还）+ 该连接上的
session 级 `pg_try_advisory_lock` + 记录 `(pg_backend_pid, generation)`。
**本模块不 import `pg`**（它不是根依赖；裸 import 会 `ERR_MODULE_NOT_FOUND`）⇒ 用结构化类型。

### lockId 与 plugin-sql 迁移锁**不同源**（改两处，不是一处）

| | plugin-sql（迁移互斥） | 本模块（认知执行者资格） |
|---|---|---|
| 输入 | `pluginName` | `lg:single-core:v1:<角色>` |
| 字节范围 | sha256 的 **0…8** | sha256 的 **8…16** |
| 掩码 | `& 0x7fff…`（63 位），0→1 | 同 |

`D05.3` 断言**两种**最容易被顺手复用的写法都必然不同：① 直接拿角色 id 走插件派生；
② **只改输入、不改字节范围**。后者尤其重要 —— 它证明"只靠命名空间不够"。

### 两个真实 OS 进程（计划 §5 逐字要求）

```text
持有者  --mode=hold  acquired=true  backendPid=8410  lockId=6521252741284615669
挑战者  --mode=try   acquired=false denial=lock_not_acquired  同一 lockId
只读    --mode=read  ok=true        readValue=691   ← **不受资格限制**
```

⇒ **第二核心被拒**（真第二个进程，不是同进程模拟）；**只读连接照常**。

### 失效由**可观测事件**判定（计划 §3.2 的核心要求）

```text
触发：pg_terminate_backend 终止持有者的专用连接（限定 usename='lg_migrate'）
持有者的轻量核对序列： [true, true, true, false]
heldAfterWait        ： false
invalidationReason   ： connection_error      ← **可观测事件**，不是"以为还持有"
```

序列**由真变假**（不是一上来就 false，也不是一直 true）—— 这条被单独断言
（`G03.3b`），否则"失效检测"可能只是恒 false。

### 锁随会话消失 ⇒ 另一个进程可以取得

持有者会话消失后，另一个进程 `acquired=true`。⇒ PG 的 session 级 advisory lock
随会话释放，因此"连接还是那条"蕴含"锁还在"这条推理成立（边界见 `L-PGW3-05`）。

### 服务器持续运行

上述折腾（拒绝 / 终止 / 重取）之后服务器仍在运行、普通查询照常（`G03.1`/`G03.6`）。

### 装配根接线（`W3.1`–`W3.4`，**结构性**）

`src/main.ts` 的装配根现在：

```text
开库（initDatabase）之后
  → dedicatedPoolOf(runtime) 判后端    ← PG 才有池；PGlite（嵌入式，没有 connect）⇒ 跳过
  → acquireSingleCoreQualification(...)  ← 拿不到就**抛具名 KernelError**（拒绝启动）
  → initCharacterState(...)            ← 任何业务写入之前
收尾 afterRun
  → singleCoreQualification.release()   ← 放在 afterRun：放不掉不影响退出码
资格丢失 onInvalidated
  → stopAfterQualificationLoss() → **既有的** shutdown()（不另发明收尾路径）
```

⚠️ **这四条是结构性断言**：它们证明装配根在**正确的位置**取得/拒绝/释放/接线，
**不**证明"真的起两个生产核心时第二个会被拒"—— 那要跑两个完整核心，属 **WP6 的演练**。
行为面由上面那张**两个真实 OS 进程**的表覆盖。

另：`D05.7` 与 `init-probe` 的 `dedicatedPoolOf` 步骤覆盖"按形状区分两种后端"这件事的
**两侧** —— 纯函数侧（PG 形状有 `connect` / PGlite 形状没有 ⇒ 返回 undefined）与
真运行时侧（真 PG 的池 `connect()` 真的给出一条能查询的连接，实测 `pg_backend_pid`）。

证据：`artifacts/post-lv2/postgresql-migration/pg-migration-wp3-20261013T134718/
single-core-qualification.json`。

---

## 6. 边界（`L-PGW3-01…05`）

```text
L-PGW3-01  本包**没有**跑 `m4.5:ci:full`（含真实模型档）。理由：它是**交付候选**纪律
           （计划 §5 把完整 m4.5:ci 定在 WP5/交付候选），单个 WP 的最小纪律是
           typecheck + 相关门。完整 `m4.5:ci` 本包**已跑**（见 §7）。

L-PGW3-02  `pg` 仍**不是**根依赖。本包没动依赖声明 —— 那属 WP1 的实现改动清单
           （ADR-132 D04 路线 B 需要它），本包只修生命周期。⇒ 仍未销账。
           ⚠️ 资格锁模块因此**不 import pg**（结构化类型）；代价：它只能拿到
              "看起来像 Pool 的东西"，编译期不校验真 pg 的形状。

L-PGW3-03  F-WP2-02 的修法只覆盖 `initDatabase()` 这一条路径。**其它**可能建池的路径
           （例如直接 `createDatabaseAdapter()`、或 runtime 自己的 `initialize()` 失败）
           **没有**被本包覆盖 ⇒ 不主张"所有初始化失败都会回收"。

L-PGW3-04  ✅ **2026-10-13 已接线**（原本是"资格锁已实现但尚未接进生产装配"）：
           `src/main.ts` 的装配根现在在**开库之后、状态引导之前**取得资格；
           拿不到就**抛具名 `KernelError`**（拒绝启动，不是警告后继续）；
           收尾在 `afterRun` 里**释放**；丢失资格时接上**既有的** `shutdown()` 链。
           ⚠️ 这条接线的验证是**结构性**的（PG-G03 的 W3.1–W3.4 四条静态断言）：
              它们证明"装配根确实在正确的位置取得/拒绝/释放/接线"。
           ⚠️ 它们**不**证明"真的起两个生产核心时第二个会被拒" ——
              那需要跑两个**完整核心**（角色、插件、模型、入口），属 **WP6 的演练/Runbook**。
              本门不做，也不假装做了。
           ⇒ 行为面由**模块级**的两个真实 OS 进程读数覆盖（§5.1）。
           ⇒ 因此**仍不主张**"生产上第二个核心会被拒绝"；主张的是
              "模块已实现并验证 + 装配根已接线并有结构断言"。计划 §3.2 的
              "WP3 故障门未过前不允许生产切换"**仍未过**。

L-PGW3-05  `verifyStillHeld()` 的推理链是"同一条连接 ⇒ 锁还在"（依赖 PG 的
  session 级锁随会话消失）。这条推理**在直连下成立**，但**没有**覆盖：
  连接池代理（pgbouncer 的 transaction 模式会让 session 锁失效）、
  连接被中间层"透明重连"而 pid 恰好复用的情形。
  ⇒ 计划 §1 首期不引入 PgBouncer 是**必要条件**；若将来引入，本判据要重新设计。
```

---

## 7. 回归读数

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | **EXIT 0**（0 错） |
| `pnpm postlv2:database-env:verify` | **EXIT 0**，`productionDatabaseOpened: false` |
| `pnpm inc-01:test` | **25 项断言 / 0 失败**，含 **T24**：中央闸仍在 `runtime.registerPlugin(sqlPlugin)` **之前** ⇒ 本包的包装层**没有**把 INC-01 的保护移位 |
| `pnpm m4.5:ci` | **EXIT 0**（本包源码改动后重跑）：G12 **38/0** · G13 **32/0** · G14 **52/0**（三个 HARD GATE）· G2 150/0 · L2 53/0 · G9 12/0 · 场景回归 7/0 · G14 选档器自证 5/5。日志 `artifacts/post-lv2/postgresql-migration/m45ci-wp3-20261013.log` |

**本包改动后的指纹**（`m4.5:ci` 读数对应这一组）：

```text
src/infrastructure/persistence/runtime-shutdown.ts   2596c16f527ed832   14608
src/db/index.ts                                      f8230adb660a4806   23618
scripts/postgresql/init-probe.ts                     d057667a5a059641   11428
```

⚠️ **为什么本包必须重跑 `m4.5:ci`**：WP1 那份 `m4.5:ci` EXIT 0 的读数对应的是**改动前**的指纹；
本包动了 `runtime-shutdown.ts` 与 `src/db/index.ts` ⇒ 那份读数按计划 §5 的拒收条件"指纹不适用"。
⇒ 重跑是新读数，**不覆盖**旧读数（两份各自归属）。两次都是 EXIT 0，且硬门读数逐项相同。

---

## 8. 不主张

```text
· 不主张 WP3 完成 —— 计划 §4/WP3 的六项里只完成两项（见 §5）
· 不主张"第二核心会被拒绝"（资格锁未做，L-PGW3-04）
· 不主张"所有初始化失败都会回收"（只覆盖 initDatabase 这一条路径，L-PGW3-03）
· 不主张 PG-G02 / PG-G03 已 PASS（门未立）
· 不主张 `pg` 已成为显式依赖（L-PGW3-02）
· 不主张本轮关闭或推进任何历史事故、里程碑或技术债
```
