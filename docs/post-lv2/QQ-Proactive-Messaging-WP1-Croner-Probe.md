# QQ 主动联系 WP1 —— Croner 兼容探针记录（2026-10-06）

> 载体：计划 [`QQ-Proactive-Messaging-Execution-Plan-2026-10-06.md`](QQ-Proactive-Messaging-Execution-Plan-2026-10-06.md) §3 / §8 的 **WP1** ·
> 设计 [`ADR-110`](../adr/ADR-110-qq-proactive-messaging.md)（`D02` 指定 Croner 只提供内存时间触发）·
> 基线 [`WP0-Baseline`](QQ-Proactive-Messaging-WP0-Baseline.md)。
>
> WP1 的通过条件逐字（计划 §8）：**"兼容读数非空；固定 lockfile；失败时保留记录并按 §3 切换候选，
> 禁止以安装成功收口。"**

---

## 0. 一句话

```text
六个条件**全部通过**（含正控与负控），事件循环干净退出；依赖已按**精确版本** `croner: 10.0.1` 固定进
`package.json` + `pnpm-lock.yaml`（lockfile diff = 9 行，只加 croner）。
⚠️ 探针第一版**真的抓到一条**库行为：单次触发的"有效瞬间"被**截断到秒**，
   若目标与"现在"落在同一个截断秒里 ⇒ `nextRun()` 返回 `null` ⇒ **静默不排期、一次都不响、不报错**。
   ⇒ 已定成一条**具名约束**（`L-QQP-01`）与一条**程序预判**（WP2 起复用），并把危险档留作**负控**。
```

---

## 1. 冻结与核对（**换版本 = 换一条证据链**）

| 项 | 冻结值 | 核对方式 |
|---|---|---|
| 包名 / 版本 | `croner` `10.0.1` | `node_modules/croner/package.json` 读回 = `10.0.1` |
| integrity | `sha512-ixNtAJndqh173VQ4KodSdJEI6nuioBWI0V1ITNKhZZsO0pEMoDxz539T4FTTbSZ/xIOSuDnzxLVRqBVSvPNE2g==` | ① 注册表 `dist.integrity` **逐字相同**；② **独立重算**：下载 `croner-10.0.1.tgz`（`36747` 字节）→ SHA-512 → base64 = **同一串** ⇒ `match=YES`；③ `pnpm-lock.yaml` 里落的也是同一串 |
| 许可证 | `MIT` | 包内 `LICENSE`（1123 字节）+ 注册表 `license` |
| 运行依赖 | **零** | 注册表 `dependencies` **为空**；`pnpm-lock.yaml` 的 `croner@10.0.1: {}` |
| `engines` | `node >=18.0` | 注册表 + 包的 `package.json` |
| 本机 Node | `v22.23.2` ⇒ **满足** | 探针读数 |
| 模块形态 | ESM 优先（`type: module`，`exports.import → dist/croner.js`），同带 CJS 与 `.d.ts` | 包的 `package.json` |
| 包内产物 | `LICENSE` · `package.json` · `README.md` · `dist/croner.{js,cjs,umd.js,d.ts,d.cts}` | 目录列举（**7 个文件**） |
| 导出符号 | `Cron` · `CronDate` · `CronPattern` · `scheduledJobs` | `dist/croner.d.ts` + 探针实测（`typeof Cron === 'function'`） |
| ⚠️ 说明 | 包**不导出** `Croner` 这个名字（`Cron` 才是类名） | `dist/croner.d.ts` 里 `Croner` **0 命中** |

⚠️ 隔离装的注册表是 **npmmirror**（`resolved` 指向 `registry.npmmirror.com`），
但**integrity 与官方一致**，且我用**官方** tarball 独立复算过 ⇒ 两处同源同内容（**不主张**"镜像与官方逐字节相同"，
主张的是"所装内容的 sha512 与冻结值相同"）。

---

## 2. 六个条件（探针 v2 · `allOk=true`）

命令：

```bash
node node_modules/tsx/dist/cli.mjs artifacts/post-lv2/local/qq-proactive-croner-probe/probe-v2.ts \
  <marker 文件> artifacts/post-lv2/qq-proactive/<runId>/wp1-croner-probe-v2.json
```

| # | 条件（计划 §3 逐字） | 读数 | 判定 |
|---|---|---|---|
| ① | Node 22 / tsx / **ESM 导入** | `node=v22.23.2` · `Cron`/`CronPattern` 都是 function · `scheduledJobs` 是数组 | PASS |
| ② | **单次触发** | 正控 Date（提前 1500ms）**响 1 次** · 正控 ISO 局部时刻（提前 2200ms）**响 1 次** · 响过之后 `nextRun()` = `null`、`isRunning()` = `false` · **负控**（同秒目标）`nextRun()` = `null` 且**响 0 次** | PASS |
| ③ | **Asia/Shanghai 跨日** | 从上海 `2026-10-07 23:30` 起算：`0 1 0 * * *` → **`2026-10-08 00:01`（次日）** = `2026-10-07T16:01:00Z`（逐字等于手算期望）；`0 59 23 * * *` → **当日** `2026-10-07 23:59`；从 `23:58` 起算的两连击 = 当日 23:59 + 次日 23:59；`0 0 0 * * *` → **次日** `00:00` | PASS |
| ④ | **重复启动防重叠** | 具名重复 ⇒ **抛** `Cron: Tried to initialize new named job 'wp1-probe-dup', but name already taken.` · `protect: true` 档：慢回调（2500ms）期间**最大并发 = 1**（5.2s 内响 2 次） · **无 protect 对照**：同一条慢回调**最大并发 = 3**（响 5 次） | PASS |
| ⑤ | **停止后无迟到回调** | `stop()` 后：`isStopped()=true` · `isRunning()=false` · 从 `scheduledJobs` **摘除**（0 条）· 再等 **2600ms**（>2 个周期）触发计数**逐字未变**（1 → 1） | PASS |
| ⑥ | **事件循环正常退出** | 清空后 `scheduledJobs` = 0 · 探针**不调 `process.exit()`** · `unref()` 的 3 秒看门狗**没有**写出 marker（`markerExists=False`）· 进程 EXIT 0 | PASS |

⚠️ 第 ④ 条的"无 protect 对照"是**必要的**：没有它，`protectedMaxConcurrent === 1` 可能只是"探针没量到"。
两个档在同一次运行、同一台机器上打出来（1 vs 3），才算把量具本身也量了。

---

## 3. ⚠️ 探针抓到的**真行为**：单次触发被截断到秒（`L-QQP-01`）

### 3.1 第一版（`probe-discovery.ts`）为什么 FAIL

v1 用 **`new Date(Date.now() + 400)`** 做单次触发 —— 这是一个完全合法的用法 —— 结果是
**`nextRun()` 返回 `null`、作业一次都不响、没有异常、没有告警**。
证据（**保留，不回写**）：`artifacts/post-lv2/qq-proactive/<runId>/wp1-croner-probe.json`（`allOk=false`）。

### 3.2 定点复现（`probe-single-shot.ts`，8 个提前量）

| 提前量 | 构造时 `nextRun()` | 实际响 |
|---|---|---|
| **50 ms** | **`null`** | **0 次** |
| 300 ms | `19:48:01.000` | 1 次 |
| 700 ms | `19:48:01.000` | 1 次 |
| 950 ms | `19:48:01.000` | 1 次 |
| 1050 ms | `19:48:01.000` | 1 次 |
| 1500 ms | `19:48:02.000` | 1 次 |
| 2500 ms | `19:48:03.000` | 1 次 |
| 5000 ms | `19:48:05.000` | 1 次 |

（`targetWall` 示例：提前 950ms 的目标是 `19:48:01.765`，而 `nextRun()` 是 `19:48:01.000`
⇒ **截断到秒（floor）**，不是四舍五入。）

### 3.3 机制（读 `dist/croner.js` 源码，标 **FACT**）

```text
① 时区路径下 `CronDate.getTime()` → `getDate(false)` → `k(b(y, m+1, d, h, i, s, tz), false)`
   而 `b(...)` 只接收 (y,m,d,h,i,s,tz) —— **毫秒参数根本没有被传下去** ⇒ 有效瞬间被 floor 到秒。
② `_next()` 的判据包含 `this._states.once.getTime() <= e.getTime()`，
   其中 `e = new CronDate(undefined, tz)`（= **现在**，同样被 floor）。
③ 两者**截断后同秒** ⇒ 判据成立 ⇒ `nextRun()` = `null`。
④ `schedule()` 见到 `msToNext() == null || nextRun() === null` ⇒ **直接 return**，不设定时器。
```

⇒ 这不是缺陷报告，而是**一条必须在设计里写死的约束**：
**"单次触发的有效瞬间 = floor(目标, 到秒)"**，且
**若它不严格晚于 `floor(现在, 到秒)`，作业静默不排期。**

### 3.4 我们采用的程序判据（WP2 起逐字复用）

```ts
const floorToSecond = (ms: number): number => Math.floor(ms / 1000) * 1000
/** 单次触发只有"有效瞬间严格晚于现在（都截断到秒）"时才排期；否则如实判 expired。 */
const onceShotIsSchedulable = (targetMs: number, nowMs: number): boolean =>
  floorToSecond(targetMs) > floorToSecond(nowMs)
```

**为什么这条判据是必要的而不是过度防御**：
① 它把库的**静默**行为变成**我们自己的具名 `expired`**（与计划 §6 的"迟到处理 / 逾期 30 分钟标 expired"同源）；
② 我们的真实排期是**分钟粒度、提前 ≥30 秒**，所以它天然成立 —— 但"天然成立"必须**被断言**，
否则一次时钟回拨 / 一次立即排期就会静默丢一条提醒（而"没提醒"与"她说没到时间"是两件事）；
③ 它还解释了另一件必须知道的事：**有效瞬间可能比请求瞬间早不到 1 秒**（读数：请求 `19:49:28.096` ⇒ 实排 `19:49:28.000`）。
分钟粒度的提醒不受影响，但"提醒时刻"的语义必须按**秒**记，不能按毫秒宣称。

### 3.5 登记为局限

```text
L-QQP-01  单次触发的有效瞬间被截断到秒；同秒目标 ⇒ Croner 静默不排期。
          处置：生产侧一律先过 onceShotIsSchedulable()，不过则记具名 expired（不排期、不假装已排）。
          影响面：提醒时刻的精度是**秒**（我们只用分钟粒度）；不会造成"晚发"，只可能"更早不到 1 秒"。
```

---

## 4. 从源码读到的两条**与生产设计有关**的性质（FACT）

| 性质 | 读数 | 对设计的意义 |
|---|---|---|
| 内部定时器**每次最多等 30 秒** | `dist/croner.js` 常量 `W = 30 * 1000`；`schedule()` 里 `if (t > W) t = W` | 作业即使排在几小时后，也会**每 ≤30 秒**醒一次再重算。⇒ ① 它**持有**一个活句柄（不 `unref` 就维持事件循环）；② "跨日 / 时钟回拨"在实现上是被**反复重算**的，不是一次性算好 —— 这与计划 §6"跨日、时钟回退、休眠与重启"的要求方向一致，但**不**等于持久化（重启仍是全丢） |
| 具名作业**全局唯一** | 构造时查全局 `scheduledJobs`，重名**抛错** | 这正是"重复启动防重叠"可用的**第一道**机器闸：一个进程里同名作业不可能有两份。⚠️ 它是**进程内**性质，**不**提供重启后的唯一性（计划 §3 已逐字声明） |
| `stop()` 会**摘除**全局登记并清定时器 | `stop()`：`kill = true` → `clearTimeout` → 从 `scheduledJobs` splice | 收尾可核对（"还剩几个作业"是**可读**的）⇒ 适合做停机的正控 |
| `protect` 与"busy"是两件事 | `blocking` 在回调期间为 `true`；`protect` 决定"busy 时是否照常触发"（函数形态可收到通知） | 生产侧用 `protect: true`（或函数形态记录"被挡掉一次"）以拿到**可计数的抑制读数** |

---

## 5. 依赖固定（lockfile）

```text
package.json     "croner": "10.0.1"        ← **精确**版本（无 ^ / ~；与 drizzle-orm / inkjs 同一写法）
pnpm-lock.yaml   croner:
                   specifier: 10.0.1
                   version: 10.0.1
                 croner@10.0.1:
                   resolution: {integrity: sha512-ixNtAJndqh173VQ4KodSdJEI6nuioBWI0V1ITNKhZZsO0pEMoDxz539T4FTTbSZ/xIOSuDnzxLVRqBVSvPNE2g==}
                   engines: {node: '>=18.0'}
                 croner@10.0.1: {}          ← 零运行依赖

diff 规模：package.json +10 行 · pnpm-lock.yaml **+9 行**（只加 croner，未触碰任何既有包）
```

⚠️ **不自动升级为 latest**（计划 §3 逐字）。升级 = 换一条证据链（§1 的 integrity 与 §2 的六条读数都要重出）。

---

## 6. WP1 **不**主张什么

```text
① 不主张"换了别的 Croner 版本也一样"：本节全部读数只对 `10.0.1` 生效。
② 不主张"它能提供重启持久化"：它是**内存**触发；重启后什么都没有（计划 §3 已声明，本探针未反驳）。
③ 不主张"它提供 exactly-once"：⑥ 之后进程干净退出，但**跨进程/跨崩溃**的唯一性不在这条证据里。
④ 不主张"镜像与官方逐字节相同"：主张的是"所装内容的 sha512 与冻结值相同"（§1 的 ⚠️）。
⑤ 不主张"六条通过 = 主动联系可用"：WP1 只回答"时间组件能不能用"。
   能力登记、持久表、角色选择、投递与验收在 WP2–WP6。
⑥ 不主张"protect 覆盖了跨进程重叠"：它只在**一个进程内**挡住重入（④ 的对照读数在同一进程里取得）。
⑦ 不主张"截断到秒只是这一台机器的问题"：它是**源码路径**（`b()` 不接收毫秒），与机器无关；
   但仍只在本机 Node 22.23.2 + croner 10.0.1 上实测。
⑧ 不主张 node-cron 更好或更差：**未**安装、**未**探测（计划 §3 的切换条件**没有触发**）。
```

---

## 7. 证据位置

| 文件 | 内容 | 说明 |
|---|---|---|
| `artifacts/post-lv2/qq-proactive/qq-proactive-20261006T193748-53442a14/wp1-croner-probe.json` | 探针 **v1**（`allOk=false`） | **失败读数，保留不回写** |
| `…/wp1-croner-probe-v2.json` | 探针 **v2**（`allOk=true`，含正控与负控） | 当前判定依据 |
| `artifacts/post-lv2/local/qq-proactive-croner-probe/`（**gitignore**） | 隔离安装 + `probe-discovery.ts` / `probe-single-shot.ts` / `probe-v2.ts` | 探针源码与被隔离装的那一份 croner |
