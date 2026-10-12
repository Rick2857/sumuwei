# M10 生产激活候选（Activation Candidate）

- 日期：2026-09-30
- 状态：**`CANDIDATE / READY`**（⚠️ **接线已就位**；**激活前仍需两件**：① 接线后的 live 读数 `m4.5:ci:full` ② **用户的生产操作授权**）
  ⚠️ 与"未激活"分列：`READY` 说的是**缺口表里没有开放缺口**（`G-1`…`G-4` 全 `CLOSED`），
  **不是**"现在就可以打开" —— 上面那两件**都不是**机器能替自己批准的（见 §1 #2 的注与 §5）。
- 依据：计划 §18「激活、观察与回滚」（§18.1 候选条件 · §18.2 三层读回 · §18.3 回滚）
- 定位：本文件是 **WP11 的交付物之一**，也是 WP12 在"尚无用户生产操作授权"时
  **被明确允许**产出的东西——计划 §12 WP12 逐字：「**若尚无用户生产操作授权，
  只完成可审的候选与执行命令说明**」。

> ⚠️ **本文件不激活任何东西。** 它是一份**可审的候选 + 执行命令说明**。
> 它**没有**改 `.env`、**没有**加开关、**没有**接装配、**没有**打开真实库。
> §6 的每个结论槽都是 `AWAITING` / `NOT OBSERVED`，**没有一个写成 PASS**
> （计划 §12 WP11 出口逐字：「**未跑项不写 PASS**」）。

---

## 1. 候选条件核对（§18.1 的八项，**逐项**）

判据是**机器可查的指针**，不是形容词。`MET` 表示有在本轮复跑过的读数支持。

| # | §18.1 的条件 | 状态 | 机器可查的指针 |
|---|---|---|---|
| 1 | 设计冻结 | **MET** | `docs/adr/ADR-076-m10-goals-and-commitments.md` = `ACCEPTED / DESIGN FROZEN`；`M10-Acceptance-Contract.md` = `DESIGN FROZEN` |
| 2 | 实现完成 | **MET** | 代码已接（`G-1`/`G-2` 均 `CLOSED`）+ ⭐ **接线后的 live 读数已出**：`m10:onpath:live`（**生产副本 + 交互式入口**）⇒ `资格=ESTABLISHED` · **1 条 `GOAL_CREATED`** · 负控 **0 条** · **真实库逐字未变** ✓ ⇒ 按 **AGENTS §6.1**（冲突时以 Live Smoke 为准）这一项**可以认**了 |
| 3 | 硬门 / 量具有效 | **MET** | `gates:run --lane m10` = **24 道 PASS 24**；`m10:measurement:verify` = **54/54**（覆盖 13/16 道门，`L-M10-50` 记其范围） |
| 4 | 语义与 live **达标** | **MET** | 语义门 `m10:semantic:eval` 全量 **PASS**（140×3 · 准确率 0.7236 vs 基线 0.2840 · 见 [`M10-Semantic-Evaluation-Report.md`](M10-Semantic-Evaluation-Report.md)）；两条 live 门 **PASS 8/8**（`m10:smoke:live` 7 轮 · `m10:long:live` 200 轮，见 [`M10-Live-Report.md`](M10-Live-Report.md)）；`L-M10-61` **已修** |
| 5 | 真人裁定 | **MET** | 逐案方式甲：首轮 70 张答满（一致率 **74.3%**）· **18 条分歧全部裁定完毕、无未决**（见 [`M10-Human-Review-Adjudication.md`](M10-Human-Review-Adjudication.md)） |
| 6 | 旧门回归 | **MET**（⚠️ 见注） | `m4.5:ci` 离线全链 EXIT 0；`gates:run --lane offline --mode release` = 34 道 PASS 34（串行、无缓存） |
| 7 | 真实库保护方案 | **MET** | INC-01 状态机（租约 → pre-open 快照 → token → cleanClose）+ `m10:realdb:invariant`（**连读 N 次 + 逐文件 sha256**）⇒ 本轮实测 **1211 文件全部未变** |
| 8 | cutover 与回滚方案 | **MET**（本文件 §4/§5） | M10 的 cutover 是**结构性**的（`D23`：无 `GOAL_ORIGIN`、无水位预置）⇒ 无 cutover 脚本 |

**合计：8 / 8 `MET`** ✅ —— **全部候选条件已满足**（`G-1`…`G-4` 全 `CLOSED`，且接线后的 live 读数已出）。
⚠️ 候选条件**仍未满足**（不是"快好了"）：那两项**都是 M10 自己的实现**，且**都还没做**。

⚠️ **第 6 项的注（不许含糊，已更新）**：`L-M10-61` **已修**（真轮次 `status=0 @13.8s`、回复正常、无孤儿），
⇒ live 档**现在可用**，两条 live 门也已落地并 PASS。**但** `m4.5:ci:full`（含 Live Smoke）**本轮没有重跑**
—— 那是"看起来会影响真实链路"的改动（`G-2` 接线）**必须**跑的那一道，属**接线时**的动作，
不因本文件的更新而自动完成。

---

## 2. 缺什么（具名，逐条归属）

| 编号 | 缺口 | 机器判据 | 归属 | 状态 |
|---|---|---|---|---|
| **G-1** | 生产总开关 **不存在** | ✅ **已加**：`flags.ts` 有 `goalsEnabled`（`CHARACTER_GOALS_ENABLED`，缺省 **false**），且**被 `main.ts` 真的消费**（`m10:test` 的 `S7` 钉的是**消费写法本身**，不是名字出现次数） | **M10 自己的实现** | `CLOSED` |
| **G-2** | **装配未接线**（`L-M10-48`） | ✅ **已接**：`main.ts` 的 `buildGoalTurnPort()` 把四个端口接好（候选 / 写 / 放行口 / **兑现判定**），并在**每轮** `compileTurn` 里按开关注入 `runGoalTurn`（`S8` 钉着接线点） | **M10 自己的实现** | `CLOSED` |
| **G-3** | **真人裁定未做** | ~~`U-15` / `U-11` 在登记册里仍是开放项~~ ⇒ **已做**：逐案方式甲，70 张答满、18 条分歧全部裁定 | **用户**（机器不能替自己批准金标：`L-M10-09`） | **CLOSED** |
| **G-4** | **live 档不可用** | ~~`L-M10-61`：`semantic=true` 的聊天轮次静默阻塞~~ ⇒ **已修**（四环因果，真轮次 `status=0 @13.8s`），且两条 live 门已落地并 **PASS 8/8** | **跨里程碑**（M9.5/M5.1）—— 已闭合 | **CLOSED** |

⚠️ **`状态` 那一列是机器判据的落点**：`pnpm m10:activation:verify` 会把它与
**代码的实际情况对账**（G-1 查 `flags.ts`、G-2 查 `main.ts`），并核对总判
⇒ **谁接了线/加了开关却没更新这张表，那道门就红**（绊线，不是文档装饰）。

⚠️ **G-2 与 G-4 的次序关系必须说清**：
接 G-2 会**改变生产轮次的装配**，而这类改动按仓库自己的纪律**必须**有 Live Smoke 读数
（AGENTS §6.1：「离线全绿 ≠ 真实链路正确……**冲突时以 Live Smoke 为准**」）。
⇒ **在 G-4 解决之前接 G-2，等于往生产可及路径上放一段无法按仓库标准验证的代码。**
⇒ 这就是本候选**不把 G-2 做掉**的理由，而不是"没时间"。

---

## 3. 授权后拟施加的配置（**逐字**，本文件不执行）

```text
① `.env` 追加一行（**唯一**的配置改动）：
     CHARACTER_GOALS_ENABLED=true
   · 代码缺省保持 **false**（与 M7/M8/M8.5/M9 的生产激活完全同构：
     缺省关、`.env` 显式开、回滚 = 删这一行）
   · ⚠️ 施加之前 G-1 必须先落地（今天这一行**没有任何消费者**，
     写进去只会是一个"看起来开了、其实没人读"的开关）

② **不动** M9.5 的 semantic mode：维持 `shadow`（计划 §18.1 逐字：
   "M9.5 的 semantic mode 维持 shadow；**Goal 激活不夹带切 on**"）

③ **不新建迁移**：M10 的迁移目标是 **NONE**（`D15`），
   复用 `character_projections`（PK `(character_id, projection_type)`，族名 `goal:<goalId>`）
   ⇒ 无 `pnpm migrate:apply` 步骤

④ **不做 cutover 脚本**：cutover 是**结构性**的（`D23`：无 `GOAL_ORIGIN`、
   不回溯扫描 conversation events）⇒ 首轮**合法请求**即建立第一条记录
```

---

## 4. 三层读回（§18.2）—— 授权后**逐条**执行的确切命令

### 4.1 配置读回（只输出非机密 flags / 版本）

```bash
pnpm inspect                 # 只读 CLI：会走完整 INC-01 级联（租约 → 快照 → 打开 → cleanClose）
                             # ⚠️ 它会**改变真实库的树摘要**（打开会写 pg_control/WAL）⇒ 见 §7
```

判据：flags 读数里出现 `goals` 一项且为 **true**；**只报存在与取值，不打印任何 key**。

### 4.2 装配读回（证明 Goal 服务与 cutover 在位）

```bash
pnpm typecheck                                   # 必须先绿
grep -c 'runGoalTurn' src/main.ts                # 期望 > 0（G-2 已做）
grep -n 'goal' src/kernel/app/flags.ts           # 期望出现开关（G-1 已做）
pnpm gates:run --lane m10                        # 期望 24 道 PASS（G-2 落地后应更多）
pnpm m10:realdb:invariant --reads=2 --expected=<当前参考值>
```

判据：合法入口 + 租约 + pre-open token + verified snapshot + `cleanClose=true`；
`m10:realdb:invariant` 连读两次一致。**cutover 无水位可报**（§3 ④）——如实写"结构性"。

#### 4.2.1 ✅ **真实库 schema 已量**（`U-01`，2026-09-30，**只读副本**）

计划 §18.1 的候选条件之一（"真实库保护方案"）此前**只有方案、没有读数**：`AGENTS.md` 记 v9，
而 ADR-075 的启动读数记 v2 ⇒ WP0 **未开库** ⇒ **无结论**。用户授权后按"**只复制、不打开真实库**"量到了：

```text
cpSync data/pglite → %TEMP% 副本（1212 文件；真实库 1211 —— 差的是 postmaster.pid，在排除表里）
PGLITE_DATA_DIR / PROJECT_LG_SANDBOX 指向副本 ⇒ 沙箱路径，**不走生产状态机**
pnpm exec tsx src/main.ts --migrate（**预览**，只读）
  ⇒ 当前 schema 版本：**9** · ✅ **没有待应用的迁移** · exit 0
删副本 → m10:realdb:invariant（连读两次 + 逐文件）⇒ 真实库摘要**逐字未变**
```

⇒ **v9 与 v2 之争分出了对错：实测 9**（`AGENTS.md` 的那个数对）；
且 **M10 不需要任何迁移动作**（迁移目标 `NONE`，`D15`）。
⚠️ 这是**前置**读数，**不**替代 §4.2 的激活后装配读回 —— 后者仍要证明"Goal 服务与 cutover 在位"。

### 4.3 首次行为读回（**用户真实发起目标之后**）

计划 §18.2 逐字：「用户真实发起目标后，从接受事件→投影→context→可见回复对账；
跨会话续接与取消再单列」，且「**不要为了凑读数以用户身份向真实会话写合成承诺**」。

```bash
pnpm inspect                      # 读回 goal 行（status / revision / sourceRefs）
pnpm dump:prompt                  # 证明 `goals` 两条 section **实际入模**（而不是"装了但没进"）
```

判据：接受事件 → 投影 → context → 可见回复**四段对账**。
**未观察到 ⇒ 写 `FIRST-USE NOT OBSERVED`**，不写 PASS。

---

## 5. 回滚（§18.3）—— 演练计划

```text
① 配置：删掉 `.env` 的 `CHARACTER_GOALS_ENABLED=true`（或改 false）
② 重启/停服按既有合法流程（INC-01 状态机；`runtime-shutdown.ts` 是唯一收尾实现）
③ 效果（计划 §18.3 逐字）：停止**新的**抽取、状态变更与注入；
   **既有 Goal 事件和投影保留**
④ 重新启用：**延续已记录的 cutover**，不扫描旧聊天补承诺
⑤ 演练判据：回滚后 `pnpm dump:prompt` 的 prompt 与"根本没开过"**逐字节相同**
   —— 这一条在**离线**就有判据（`m10:context:verify` 的 `O1`–`O4`，
   其中 `O4` 逐字："M3.5 的逐字节基线里**没有**目标块的任何标题"）
```

⚠️ **回滚不许做的事（计划 §18.3 逐字，我逐条列出以免被"顺手"违反）**：

```text
✗ 说"我已经忘了所有约定"
✗ 说"仍会自动执行"
✗ 在关闭开关时**偷偷生成取消事件**
   （批量取消有效约定要**另走明确的受控状态操作**，不在关开关时做）
```

---

## 6. 结论槽（**按计划 §21.1 的 14 槽与允许表达**，不另立一套）

⚠️ **本轮修正**：本节原先用了一套**自拟的槽位**（12 槽）。而计划 **§21.1「最终判定至少分列」**
已经**规定了 14 个槽与每个槽的允许表达** ⇒ 自拟一套会让收口时的"判定"与计划对不上。
⇒ 现在**逐字采用 §21.1 的槽名与词表**，并在最后一列注明"计划允许的表达"。

| §21.1 的槽 | 当前值 | 缺口 / 依据 | 计划允许的表达 |
|---|---|---|---|
| Design | **`ACCEPTED / DESIGN FROZEN`** | ADR-076 + 契约 | `ACCEPTED / DESIGN FROZEN` 或待裁定 |
| Implementation | **`COMPLETE`** | `G-1`/`G-2` 均已 `CLOSED`（开关 + 装配接线）；⭐ **接线后的 live 读数已出**：`m10:onpath:live`（生产副本 + 交互式入口）⇒ `资格=ESTABLISHED` · **1 条 `GOAL_CREATED`** · 负控 0 条 · **真实库逐字未变** ✓ | `COMPLETE` / `PARTIAL` |
| Input/reference contract | **`PASS`** | `m10:inputs:verify`（真 revision / Belief 资格 / 主体隔离）+ `m10:source:verify`（原话 / 归因 / 采纳 / 形状） | `PASS` / `FAIL` / `INVALID` |
| Mechanical gates | **`PASS`** | `gates:run --lane m10` = **24 道 PASS 24**；`m10:gates` 逐门判 **`PASS 25 · FAIL 0 · NOT RUN 1`**（26 道门，含语义 / live lane） | `PASS` / `FAIL` / `NOT RUN` |
| Measurement validity | **`VALID`** | `m10:measurement:verify` = **54/54**（覆盖 13/16，范围见 `L-M10-50`） | `VALID` / `INVALID` / `NOT RUN` |
| Semantic evaluation | **`PASS`** | `m10:semantic:eval` 全量（test split **140 条 × 3 轮**）：**当前**准确率 **0.8029** vs 多数类基线 **0.2840**（改前 0.7236，`F2` 修法见语义档 §4.1）· 失败率 **0.0714** · **跨轮翻转 19/140** ⇒ 该槽**必须**读多次运行（单次不是稳定估计）。见 [`M10-Semantic-Evaluation-Report.md`](M10-Semantic-Evaluation-Report.md) | `PASS` / `FAIL` / `INCONCLUSIVE` / `INVALID` |
| Live chain | **`PASS`** | `m10:smoke:live` **8/8**（7 轮真模型 · 隔离库 · 结构不变量）· `m10:long:live` **8/8**（**200 轮**：trace 200/200 · **rebuild 逐字相同** ⇒ 不变量 ② 真被验）。见 [`M10-Live-Report.md`](M10-Live-Report.md) | `PASS` / `FAIL` / `NOT RUN` |
| Long trajectory | **四条独立读数**（**离线** 200 **11/11** · **离线** 500 **11/11** · **live** 200 **8/8** · **live** 500 **8/8**） | 离线档证"时间维度的边"（重启/复活/迟到/重复）；**live 档**证"真模型下的长轨迹"，其中 **500 轮 `rebuild` 逐字相同** ⇒ 不变量 ② 在 500 轮真模型轨迹上被验 · trace 满 5 的有 **500/500** 轮 | 各轨迹**独立读数，不合并掩盖失败** |
| Human review | **✅ 完成（逐案）** | 首轮 70 张答满 · 一致率 **74.3%** · **18 条分歧全部裁定完毕**（`ne-02`/`co-01` 共 13 条**审阅人认可金标** · `dp-01` 拆族后重判：4 条全一致 + 1 条采纳审阅人）⇒ 指纹第 **7** 次冻结（`6213680ccfd23205`，含 `co-01` 系改判）· **无未决分歧、0 张待重判** —— 见 [`M10-Human-Review-Adjudication.md`](M10-Human-Review-Adjudication.md) | **逐案 / 声明式分别记录** |
| Regression | **`EXIT 0`**（24 道 lane） | §16.3 的 19 条里 **16 条有记录**；3 条具名未记录（`L-M10-63`），**另行直跑 exit 0** | `EXIT 0` 或**具名失败** |
| External Capability Added | **`NONE`** | 计划 §0 逐字："新增外部 Capability = **NONE**" | 未改变则**始终 `NONE`** |
| Production activation | **`ACTIVATED`** | 候选条件 **8/8 `MET`** ✅（`G-1`…`G-4` 全 `CLOSED`）；✅ **2026-09-30 已激活**：`.env` 追加 `CHARACTER_GOALS_ENABLED=true`（**代码缺省仍 `false`**），载体 [`ADR-077`](../adr/ADR-077-m10-goals-production-activation.md)；`U-01`（真实库 schema）已量（**10 · 无待应用迁移**，应用了 `MIGRATION_0010`） | `ACTIVATED` / `NOT ACTIVATED` |
| First use | **`NOT OBSERVED`** | 依赖激活 | `OBSERVED` / `NOT OBSERVED` |
| Merge / tag | **已合并 + 已打标签** | 用户 2026-09-30 授权并已执行：`feature/m7-relationship` → `main`，**ff-only**（**无合并提交**，`main` = `886845a7`）· 标签 **`m10-complete`**（**annotated**，指向同一提交）· 载体 [`ADR-077`](../adr/ADR-077-m10-goals-production-activation.md) §6。⚠️ **没有推送任何远端**（独立一步，未授权） | 按授权**实际动作分列** |

### 6.1 ⚠️ 一处**词表缺口**（本表跑出来的，如实登记）

```text
槽「Semantic evaluation」的允许表达 = PASS / FAIL / INCONCLUSIVE / INVALID —— **没有 NOT RUN**。
而它当前的真实状态就是 **NOT RUN**（语义门一次都没跑过）。
```

⇒ 两条出路，**都要用户**：要么**跑它**（`U-15`/`U-11`），要么在收口时**具名声明偏离**
（"该槽无允许表达可用，故记 `NOT RUN` 并说明原因"）。
⚠️ **不把它硬塞进 `INCONCLUSIVE`** —— "没跑"与"跑了但结论不确定"是两件事，
塞进去就是**用允许的词表掩盖没跑**（正是计划 §17 停线条件第 6/7 条要防的）。

⚠️ 另记**两处与 §21.1 的对照**（本表**多/少**的槽，说明理由而不是默默不一致）：
本节**不再单列**"真实库保护"槽（它属"Evidence/纪律"而非 §21.1 的 14 槽之一，
其读法已写在 §4.2 与 `L-M10-60`）；也**不合并** Long trajectory 的两条读数（§21.1 逐字要求"不合并掩盖失败"）。

---

## 7. 本文件**不**主张什么

```text
① 不主张"M10 已生效"——`L-M10-48` 在案：**生产轮次目前根本不会调用目标域**。
   在接线 + 激活之前，任何"M10 已生效 / 目标已经在管"的说法都是**错的**。
② 不主张 live 达标——live 档本轮 FAIL 且**无读数**（`L-M10-61`）。
③ 不主张人审已过——`U-15`/`U-11` 开放中。
④ 不主张本文件构成授权——它**是**被 §12 WP12 允许产出的"可审的候选"。
⑤ 不主张真实库被打开过——本文件未打开它；§4.1 的 `pnpm inspect` **会在授权后**打开它，
   而那**会改变树摘要**（`L-M10-60`：摘要的角色是"证明某个测试没开过库"，
   不是"字节永不改变"）⇒ 施加前先记下当前参考值，施加后如实登记**为什么**变了。
```
