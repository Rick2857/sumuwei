# M11 WP12 交接单（进行中）

- 日期：2026-10-01
- 状态：**COMPLETE（3/3）** —— ①**慢路径的生产接线**（`L-M11-20` 的修复）②**`m11:activation:verify`**
  （生产**副本**上的 cutover / 开关独立性 / 回滚，**PASS 9/9**）③**`m11:activation:readback`**
  （真实库 **SELECT-only** 读回，**PASS 8/8**）全部落地
- 授权：用户 2026-10-01 当轮**逐字授权** `m11:activation:verify` / `m11:activation:readback`
- 设计权威：[ADR-085](../adr/ADR-085-m11-reflection-and-bounded-adaptive-self.md) §7.1 / `D33` · 计划 §12.1 / §14 第 12 槽

---

## 1. ⭐ 本轮修掉的**生产缺口**：`L-M11-20`

```text
现象（实测）：全仓只有 `m11-recovery-verify.ts` 调用 `maybeRunReflectionEvaluation` ——
              `src/main.ts` **从来没有**调用过它，也没有引用 `reflectionEnabled` / `cutoverSequence`。
⇒ 后果：**生产里没有任何东西会跑这条慢路径**（触发不被扫描、候选不生成、事件不写）。
   ⚠️ 这与 M10 的 `L-M11-10`（`goalTokens` 从未接线）是**同一类**缺口；
      而 WP9 的 e2e 门之所以没抓到，是因为它**在测试里**自己把零件串起来跑通了 ——
      "零件能串起来" ≠ "生产装配真的串了"。
```

### 1.1 补法（三件）

```text
① `src/infrastructure/runtime/reflection-runner.ts`（新）：把窗口变成业务事件的**生产执行器**
   （输入装配 → **一次**模型调用 → 严格校验 → 审查 → 事件 → 投影）。
   四条边界：不吞错（失败如实返回，调度层落 failed）· 一次窗口一次调用（`D30`）·
   只用**程序解析**的根判门槛 · 不碰别的域。
② `src/main.ts`：挂上 `maybeRunReflectionEvaluation`（与关系/情绪/信念三个域同一条纪律）：
   **开关关 ⇒ 什么都不发生** · **干跑不执行** · **失败不抛** · **不回判历史**。
   端口来自 `reflection-input-source.ts` 新增的两个只读函数
   （`latestDomainEventSequence` / `readReflectionWindowEvents`）。
③ `reflection-scheduler.ts`：新增 `cutover_preset` 分支 —— 水位行不存在时**预置 cutover 且本次不消费**。
```

### 1.2 为什么必须有 `cutover_preset`（`D33` 的唯一交点）

```text
水位行不存在时：
  · 只 `no_tail` 不建行 ⇒ 水位永远建不起来 ⇒ 慢路径**永不运行**（假功能）
  · 按 0 起读          ⇒ 第一次就**回判全部历史**（违反 `D33`）
⇒ 预置：把边界一次性钉在**此刻**的账本序号上，本次不消费；之后从它往后走。
```

### 1.3 判据跟着改（**故意的语义变更**，记录在案）

```text
`m11:recovery:verify` 的 B1 原本期望"首次即 `ran`"（改之前的语义）⇒ 变红。
修法：B1 改成断言 `cutover_preset`（水位预置成 0、**不调用模型**）· 新增 B1b 断言"预置之后才消费"
（第二次 `ran`、水位 3）· B2 保持"再跑是 `no_tail`"。复跑 **18/18 PASS**。
```

---

## 2. `m11:activation:verify`：生产**副本**上的激活语义（**PASS 9/9**）

```text
做法：`cpSync(生产库目录 → %TEMP%)` 后，把 `PGLITE_DATA_DIR` / `PROJECT_LG_SANDBOX` 都指向副本
      ⇒ 此后**所有打开与写入都在副本上**（沙箱路径）；真实库**只被 `cpSync` 读**，从不作为数据库打开。
      不 import `src/main.ts`；模型用**固定 provider**（本门不出网 —— 要验的是**程序的裁决**）。
```

| 判据 | 读数（**权威代**：真实生产库副本） |
|---|---|
| A1 一次性 cutover（`D33`） | 首次调用 ⇒ `cutover_preset` · 边界 **141**（= 真实账本最大序号）· **本次不消费** |
| A2 不移动 | 第二次（即使传更小的 cutover）⇒ `no_tail` · 水位仍是 **141** |
| A3 不回判历史 | 边界之前的窗口**一条都没有**被消费（反思事件 0 条） |
| B1 开关独立·调整关 | `adaptiveEnabled=false` ⇒ `no_change`（`adaptive_disabled`）—— 即使候选与槽位都合法 |
| B2 开关独立·调整开 | 同一份输入 ⇒ `revise`（`D19` 的两档**可表达**） |
| C1 回滚·不注入 | 额度 0 ⇒ **0 个 section**；三槽 revision **不变**（回滚 ≠ 删数据） |
| D1 **源不被触碰** | 真实库目录 files **1229→1229** · bytes **32 985 690→32 985 690** · 最新 mtime **相同** |
| D2 副本非空 | 副本边界 141（生产账本的历史真的在）—— 否则 A3 没有意义 |

### 2.1 两代读数（**分列**，因为源不同）

```text
① 工作树副本：边界 **137**（工作树那份 `data/pglite` 是陈旧副本）· PASS 9/9
② **主 checkout 副本（权威）**：边界 **141**（真实生产账本）· PASS 9/9
   runId `m11-wp12-activation-20261001-0440670a572a-178f`（证据已入分支）
⚠️ 权威代在**主 checkout** 跑（那里才是真实库）⇒ 工作树那代只是**管道验证**，不得当权威。
```

### 2.2 一处操作坑（记下来免得再犯）

```text
第一次把主 checkout 快进时**被拒**：门上刚在那边写下的证据目录是**未跟踪**文件，
而同一个路径在分支里**已经被提交**（我从那边复制回来提交了）⇒ `git merge --ff-only`
拒绝覆盖未跟踪文件（`Select-Object -Last 1` 把那条消息截掉了，看起来像"更新了但 HEAD 没动"）。
处置：先比哈希（两份**逐字节相同**）⇒ 删掉未跟踪那份 ⇒ 再 ff ⇒ 干净。
```

---

## 3. `m11:activation:readback`：真实库**只读**读回（**PASS 8/8**）

```text
走 INC-01 生产状态机（**真的**开了真实库，但构造上只读）：
  IDLE → LEASED → PREOPEN_SNAPSHOT_VERIFIED → DB_OPEN → SERVICES_STOPPED →
  DB_CLOSED_VERIFIED → POSTCLOSE_SNAPSHOT_VERIFIED → RELEASED（cleanClose=**true**）
  pre-open 快照 `2026-10-01T13-49-19-696Z-05ada1e16cdb` · post-close 快照 `…68e83b1df684`
```

| 判据 | 读数（真实库） |
|---|---|
| R1 配置可读（`.env` **文本**） | `CHARACTER_REFLECTION_ENABLED` / `CHARACTER_ADAPTIVE_SELF_ENABLED` / `…_TOKENS` **三个键都没设置** |
| R2 激活状态 | **NOT ACTIVATED**（配置层）—— 这是**读数**，不是失败 |
| R3 水位 | **没有水位行** ⇒ 慢路径从未在生产里跑过（与未激活自洽） |
| R4 本域事件与投影 | 事件 **0** · 投影 **0** |
| R5 零越界（结构面） | 别的域读数 `{memory:3, belief:2, goal:0, commitment:0}` —— M11 **没有**动过它们 |
| R6 **FIRST-USE 分列** | **NOT OBSERVED**（无水位且无事件）—— **不凭配置宣布** |
| R7 只读自检 | 非 SELECT 语句被**构造性拒绝**（`delete …` 尝试被拒 ✓） |
| R8 干净关闭 | `closed === true`（收尾是**问出来的**） |

⚠️ **未激活时本门仍然 PASS**：它读到的就是 `NOT ACTIVATED` —— 把"没激活"读成"失败"是**另一种**错；
读回的任务是**如实读数**，不是要求已激活。生产激活本身仍是独立裁定（§14 第 12 槽）。

---

## 4. 下一轮（收口）

```text
② `m11:activation:verify`：在**生产副本**上验证 —— 两个开关**独立**（反思开 + 调整关可表达）·
   一次性 cutover（第二次调用不移动边界）· **不回判历史**（首次窗口从边界之后开始）·
   失效恢复 · 回滚（删两行 ⇒ 注入与消费都停，事件/投影保留）。
   ⚠️ 走 INC-01 纪律：租约 → pre-open 已验证快照 → token；**快照本体从不打开**；
      前后比源摘要（不用 git 证明 `data/` 没被动）。
③ `m11:activation:readback`：真实库 **SELECT-only** 读回（开关文本 / 水位 / 事件与投影计数），
   **FIRST-USE 分列**（不凭配置宣布"已运行"）。
```

---

## 3. 本轮另一件事：**M11 已迁移进主 checkout**（用户当轮要求）

```text
`C:\Users\user\Desktop\project LG`：`main` **快进**到 `e0a1473d`（M11 分支 tip；无合并提交、无冲突）。
前置核查：那棵树当时**干净**（0 dirty）· 30 分钟内无写入活动 · `main` 是 M11 分支的祖先（⇒ 可 ff）。
迁移后核查：`git status` **干净** · **typecheck EXIT 0** · `scripts/m11-*.ts` **21** 个 ·
`docs/m11/*.md` **19** 份 · `artifacts/m11/` **244** 个 run 目录。
⚠️ 私密材料**不走 git**（gitignored）：另**单独复制**了 `artifacts/m11/local/`
   （review-cards.md/json · review-key.json · 三档 ablation 原文）——复制后那棵树仍**干净**。
```

---

## 4. 受影响门的读数（本轮改了 `main.ts` / 调度器 / 输入源）

```text
kernel:test EXIT 0 · kernel:verify EXIT 0 · m4:test EXIT 0 · m4.5:test EXIT 0 ·
m3.5:test EXIT 0（prompt 逐字节）· eval:dryrun EXIT 0
m11：recovery **18/18** · inputs 43/43 · e2e 12/12 · gates 离线 13/13（`m11:gates` 自身 exit 1 = 如实报 FAIL）
⚠️ `m5:budget:verify` 仍红（`L-M11-13`，继承）
```
