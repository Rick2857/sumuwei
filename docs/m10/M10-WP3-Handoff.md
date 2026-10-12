# M10 WP3 交接单

- 日期：2026-09-29
- 工作包：WP3（Goal / Commitment 纯内核与持久化）
- 状态：**COMPLETE** —— 门 `m10:test` = **PASS 48/48**
- 依据：[`ADR-076`](../adr/ADR-076-m10-goals-and-commitments.md) §4.1–§4.4 · §4.7 · §4.8 · `D03` · `D05` · `D15` · `D21` · `D24`
- 前置：[`M10-WP2-Handoff.md`](M10-WP2-Handoff.md)（依赖复核就绪）
- 本轮**没有**：打开真实库 · 调模型 · 出网 · 改任何历史文档或证据

---

## 1. 交付了什么

| 交付物 | 位置 | 作用 |
|---|---|---|
| 领域契约 | [`src/kernel/contracts/goal.ts`](../../src/kernel/contracts/goal.ts) | 状态 / 操作 / criterion / 依赖四组闭集 · 身份派生（`D05`）· 投影行键 · 13 个 payload 形状与**结构校验** |
| id 登记 | [`src/kernel/contracts/ids.ts`](../../src/kernel/contracts/ids.ts) | 追加 `GoalId` / `CommitmentId`（**只追加**，既有 id 类型一字未改） |
| 事件登记 | [`src/kernel/contracts/domain-event.ts`](../../src/kernel/contracts/domain-event.ts) | 13 个类型常量 + `createGoalDomainEventRegistry()` + 接入 `createFullDomainEventRegistry()`（M7/M8/M9 的同款分步） |
| 折叠器 | [`src/kernel/projections/goal.ts`](../../src/kernel/projections/goal.ts) | `goal-fold@1` · 一目标一行 · **唯一**折叠循环 `foldGoalRowsInMemory`（store 与门共用） |
| 放行口 | [`src/kernel/policies/goal-validator.ts`](../../src/kernel/policies/goal-validator.ts) | `validateGoalProposal()` —— 唯一写路径 · 合法边全集 · 乐观锁 · 幂等 · 来源资格 · 遗忘禁用根 · 关联原子性 |
| 存储 | [`src/infrastructure/persistence/goal-store.ts`](../../src/infrastructure/persistence/goal-store.ts) | 零新迁移 · 一族多行 · apply / rebuild 同一折叠核心 · `createGoalStateLookup` 只读端口 |
| 门 | [`scripts/m10-test.ts`](../../scripts/m10-test.ts) → `pnpm m10:test` | 48 项检查（6 组） |
| 改动面映射 | [`scripts/gates/affected-map.ts`](../../scripts/gates/affected-map.ts) | M10 行**补齐** `m10:test`（`U-08` 关闭） |

### 1.1 门读数（`m10:test` = PASS 48/48）

| 组 | 项数 | 它对应 WP3 的哪条出口判据 |
|---|---|---|
| `C` 契约与登记表 | 5 | 13 个类型全登记 · **无 `GOAL_ORIGIN`** · 操作词表自持 · 单行前缀 · reducer 版本 |
| `L` 合法边全触达 | 10 | **"所有合法边均触达"**：create/pause/block/resume/revise/complete/supersede + 三条取消原因 + commit accept→fulfill |
| `X` 非法边拒绝且零事件 | 21 | **"非法边拒绝且零事件"** + 幂等（含"改 status 跳过 validator"两条） |
| `G` 取消后重新设立 | 2 | **"取消后同内容新请求可建立新身份"**（`G14`） |
| `R` 重放一致 | 4 | **"重放不重复"**：分批 == 全量（A==B）· 重放两次状态不变 · 一事件一行 · 版本 |
| `S` 真实写回与事务 | 6 | 领域事件落库 + 投影落 `goal:<id>` · **rebuild 对账 A==B** · **事务故障门** · 持久幂等 · status 旁路被拒 |

### 1.2 相关回归（本步必跑）

| 门 | 读数 |
|---|---|
| `pnpm typecheck` | EXIT 0 |
| `pnpm kernel:test` | **26 通过 / 0 失败** |
| `pnpm kernel:verify` | **25 通过 / 0 失败** |
| `pnpm m10:inputs:verify` | **PASS 25/25**（WP2 的门在契约变更后仍绿） |
| `pnpm gates:verify` | **PASS 48 项 / 0 失败**（改了 `scripts/gates/**` 的必跑项） |
| `pnpm fast:offline` | **34 道 · PASS 34 · FAIL 0**（81s，非发布档） |
| 真实库 | **从未被打开** |

### 1.3 证据（**两代**，与 WP0/WP2 同一纪律）

| 代 | runId | head | 说明 |
|---|---|---|---|
| 2（**权威**） | `artifacts/m10/m10-wp3-test-20260929-f0b20e74b126-42c9/` | `f0b20e7`（WP3 文档提交） | 产生它的代码**可被 head 定位**（代码在其父提交 `e928b5f`） |
| 2（**权威**·WP2 门复跑） | `artifacts/m10/m10-wp2-inputs-20260929-f0b20e74b126-9b66/` | `f0b20e7` | 契约变更后 WP2 的门仍 **PASS 25/25** |
| 1（历史·**量具缺陷档**） | `artifacts/m10/m10-wp3-test-20260929-c5d85ee*/` ×6 | `c5d85ee`（WP2 证据提交） | 6 次迭代：`39/44` · `47/48` ×3 · `46/48` · 一次 `48/48`。**全部由 §4 的量具缺陷造成，不是产品缺陷**；保留、不回写 |

⚠️ 第一代的那次 `48/48` **不**等于"当时的实现是对的"—— 它只是那一轮的读法；
真正的实现缺陷（§4.1 的行定位、§4.2 的幂等不可观测）是在**后续迭代**里才被抓住的。
**这正是"失败档保留"的用处**：它把"量具改了几轮"这件事留在案上，而不是被最后一次绿盖掉。

---

## 2. 六条追加的拒绝码（ADR-076 §4.8.1）

实现时发现六类情形需要**可区分**的码；按 ADR 头部纪律（"判据变更 = 本 ADR 修订"）
在 §4.8.1 **追加**，原文一条未改：

```text
goal_illegal_transition            非终态但不在转换表里（paused→paused / blocked→paused / paused 被机器证据判完成）
goal_revision_requires_supersede   changed 含实质字段（对象 / 成功条件 / status）
goal_supersede_target_missing      supersede 的新目标不在同一提案
goal_orphan_commitment             取消有 active 承诺的目标却没在同提案取消它
commitment_criterion_unacceptable  v1 不正式接受的承诺 criterion（user_report 型）
processor_version_presence         提案缺 processor / processorVersion（与 memory / belief 同款）
```

前五条由 X 组逐条钉住（`X2`/`X3`/`X7`/`X4`/`X5`/`X13`/`X12`/`X15`/`X17`）。

---

## 3. 三条在实现里定形的东西（WP1 定了语义，这里定了**顺序与形状**）

### 3.1 放行口的三个阶段：**结构 → 身份与幂等 → 语义**

```text
阶段 A  提案级：processor / characterId / 来源非空 / 来源资格 ESTABLISHED
阶段 B  结构：类型登记 + registry payload 校验
阶段 C  身份与幂等：算 id（CREATED / ACCEPTED）+ 规范化 payload + hasProcessed
阶段 D  语义：读状态 → 合法边 → expectedRevision → 关联原子性
```

**为什么幂等必须排在语义之前**（门的 `S3` 把它钉住）：一次**真实的**重试会带着
**原来的** `expectedRevision` 再来一遍，而第一次投递已经把状态推进了。
若先判语义，这次重试得到的是 `goal_revision_conflict`（"并发写者"的形状）——
而幂等键存在的**唯一理由**就是让这种情况被认成"同一次操作"。
排在后面 ⇒ 幂等保证在真实重试下**永远观测不到** ⇒ 它是一句空话。

### 3.2 身份由程序算，且**不改调用方的提案**

`identityOf()` 产出**新的**规范化 payload（派生 id 写在新对象里），
`accept()` 用的是它。因此：

- 提案里的 `goalId` / `commitmentId` 一律被**重写**为程序算出的值
  ⇒ "模型编造 id"在结构上不可能（计划 §7.2）；
- 一次**被拒**的校验**不留下任何副作用**（"提案被拒"与"提案被改过"必须分得清）。

### 3.3 事务边界（**如实登记，不假装更强**）

```text
① 领域事件 + processed_operations ：一个事务（applyAcceptedEvents）
   ⇒ 关联修改（supersede+create / cancel+cancel）**原子**
② 目标投影行                      ：另一个事务（applyGoalRows）
   ⇒ 两次之间崩溃 = 事件在、投影旧。这不是数据丢失：铁律 ②（投影是派生的）
     —— rebuildGoalProjections 能从事件全量重放回来（门的 S2 就是在验这一条）
```

刻意**不**把两步合成一个自写事务：那会复制 `applyAcceptedEvents` 的序号分配 /
幂等记账 / registry 交互，而复制出来的第二份迟早漂移。

---

## 4. 门抓出的两个**真缺陷** + 四处**量具缺陷**（都值得下一个 WP 看）

### 4.1 真缺陷 ①：`goalRowKeyFromEvent` 漏了 `GOAL_CREATED`

`GOAL_CREATED` 的 payload 把 id 嵌在 `goal.goalId` 里（首版完整快照的形状），
其余 12 种事件带**顶层** `goalId`。第一版按"全都带顶层 goalId"写，
于是**建目标的事件折不出行** —— 而且**不报错**（行定位返回 `undefined` ⇒ 静默跳过）。
⇒ 现在显式分派，并由门的 `R3`（"每个目标事件命中恰好一行"）钉住。

### 4.2 真缺陷 ②：幂等保证在真实重试下不可观测（见 §3.1）

这是本轮最有价值的一条：**它只有在"真的落库受理一次、再投同一个提案"时才暴露**。
只做纯校验的测试永远看不到它。

### 4.3 量具缺陷（四处，都是"测错了对象"）

| 检查 | 缺陷 | 修法 |
|---|---|---|
| `C2` / `C3` | 用 `text.includes('GOAL_ORIGIN')` / `includes('ProposalOperation')` 判"代码里没有它" —— 结果被**注释里提到同一个词**打成 FAIL | 改成结构性判据：登记表里有没有这个类型 / **去掉注释后的代码**里有没有这个依赖（`codeLinesOf`） |
| `X11` | 前置的"被忘掉的目标"行了 `forbiddenSourceEventIds` —— 于是这条负控**什么都没测到** | 前置改成真的非空禁用根 |
| `S3` | 只 `validate` 一遍就断言"第二次被拒" —— 没有落库就没有幂等记录 | 前置改成**真的应用一次** |
| `S4` / `S5` | 与 `S3` 共用同一个目标，而 `S3` 会推进它的状态 ⇒ 后两条看到"被改过的世界" | 幂等探针改用**另一个目标**；S4/S5 各自**重读**基线 |

⇒ **教训**：门里的探针必须**互不污染**，且静态检查要判**结构**而不是判**文本**。

---

## 5. 具名限制（交给 WP11 的 Known-Limitations）

| 编号（建议） | 限制 | 依据 / 现状 |
|---|---|---|
| `L-M10-05` | `applyAcceptedEvents` 与 `applyGoalRows` 是**两个**事务 | 见 §3.3。事件原子、投影可重建；但"事件已提交而投影未更新"的窗口真实存在（下次合法调用或 rebuild 收敛）。**没有**新增后台调度 |
| `L-M10-06` | `listGoals` 是"列出**全部**投影行 + 内存前缀过滤" | 与 `L-M10-02`（belief）同源；放行口**每次校验**都要 `listGoals`（为了全局的遗忘禁用根）⇒ 成本随**全部**投影行增长。WP9 必须实测（ADR-076 `D24`） |
| `L-M10-07` | Goal 域**没有**独立 oracle | `U-14`。13 个事件的规模上，一份独立实现更像"第二份要维护的代码"而不是独立证据；手写预期 + A==B 覆盖了合法边与重放。若 WP8/WP9 发现某个折叠分支缺可信复核，那时再立 |
| `L-M10-08` | `commitmentNeedsCancellation` 只覆盖"取消目标"这一条路径 | `GOAL_SUPERSEDED` 时 active 承诺是否随之作废，WP4/WP5 必须显式裁定（今天的放行口**不**强制它，因此 supersede 一个带 active 承诺的目标会留下"挂在已 superseded 目标上的 active 承诺"）。**这是有意留白**：它的正确处置取决于"改目标对象时原承诺算什么"，属依赖语义（WP5） |

---

## 6. 下一步入口

**WP4：语义提案与明确请求链。**

```text
输入  ADR-076 §7.1（来源资格矩阵）· §7.2（六步验证）· §7.3（避免词形工程）
      · `D07`（模型只产有界提案）· `D28`（提议不是持久实体）· §4.8 + §4.8.1（拒绝码）
      + WP3 已就绪的 `validateGoalProposal`（程序侧的唯一放行口）
载体  evals/m10/ 语料（dev 100 / val 60 / test 140，六层）+ 离线固定 provider 测试
出口  机械链全绿，语义负控有**有效分母**；非法输出与传输失败均保留；
      理解质量未达时**不靠缩小统计分母**发布
门    m10:source:verify（新增）
前置  ⚠️ `.env.test` 端点预检（`U-02`）—— **必须在第一个真模型门之前**做
```

**边界**：WP4 **不**做 WP5 的依赖类别处置（`L-M10-08` 的留白属它），
也**不**做 WP6 的兑现判定。程序侧的放行口在 WP3 已经定了，WP4 只补"自然语言 → 目标提案"这一段。
