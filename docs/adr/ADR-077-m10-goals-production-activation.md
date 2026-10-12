# ADR-077：M10 目标域生产激活（状态修订 + 迁移链追加一条）

> 状态：**ACCEPTED / EXECUTED**（2026-09-30）
> 类型：状态修订（与 ADR-048 / ADR-065 / ADR-067 / ADR-069 / ADR-071 同形）——
> 本文**不改** [ADR-076](ADR-076-m10-goals-and-commitments.md) 的任何设计裁定，
> 只记录"**用户明确批准 + 独立记录**"这一次执行。
> 判定背景：[`docs/m10/M10-Gate-Decision.md`](../m10/M10-Gate-Decision.md)
> 候选说明书：[`docs/m10/M10-Activation-Candidate.md`](../m10/M10-Activation-Candidate.md)

## 1. 授权（用户 2026-09-30 逐字）

```text
「a新增内核迁移，授权生产激活 / 合并 / 打标签」
```

⇒ **四项分别记录**（**互不替代**，与 M9.1 的 ADR-073 同一条纪律）：

| # | 授权的事 | 本 ADR 的状态 |
|---|---|---|
| ① | `L-M10-66` 的裁定 = **(a) 新增内核迁移** | ✅ **已执行**（§2） |
| ② | **生产激活** | ✅ **已执行**（§3） |
| ③ | **合并** | ✅ **已执行**（§6）：`feature/m7-relationship` → `main`，**ff-only**（**无合并提交**） |
| ④ | **打标签** | ✅ **已执行**（§6）：`m10-complete`，**annotated**，指向 `886845a7` |

## 2. ① 迁移链追加一条（`MIGRATION_0010`）

```text
`MIGRATION_0010 m10-semantic-index-tables` = `[...SEMANTIC_INDEX_DDL]`
  · **逐字复用**拥有它的模块（`memory-semantic-index.ts`）的 DDL 常量 ⇒ **不会漂开**
  · **不碰** 0001–0009 的任何内容（它们的内容指纹仍逐条锁着）
  · **零 backfill** · **不写** `memory_semantic_meta` 的版本行（那本登记簿归该模块独家维护）
```

⚠️ **它覆盖了 `D15`** —— 但那正是 `D15` **自己写着**的出路（ADR-076 逐字）：

> 「复用通用事件 / 投影；**迁移目标 NONE**（WP0 实测支持）… **不够再追加迁移**，绝不改旧 DDL」

⇒ 用户的裁定 = "**不够了、追加一条**" ✓，不是绕过 `D15` ✓。

⚠️ **它修的是"表不存在"这个结构性缺陷**，**不是**"索引已建好" ——
索引的**构建**（标定 / 激活）仍属 **M9.5 的线**，本 ADR **不**代它完成。

### 2.1 真实库应用（唯一会写真实库的一步）

```text
安全链**自动**走完（`guarded` 路径 ⇒ `prepareProductionOpen`：租约 → pre-open 快照 → token）：
  pre-open 快照  pglite-…13-22-41-448Z-**ba9ad570729a**（名字里带**源摘要** = v9 的状态）
  post-close     pglite-…13-22-46-661Z-86092ae62646
应用读数：
  `[kernel] schema 迁移 **9 → 10**：#10 m10-semantic-index-tables` · "已建 41 张表"
读回：
  · `pnpm inspect`（指定只读 CLI）⇒ 表数 **41 → 45**
  · `m10:realdb:invariant`（**零打开**的字节级）⇒ **1228 文件 · 窗口内逐文件不变**
  · 摘要谱系：`80cabf1d…` → **`5619f85d…`**（按 `L-M10-60` 的规则**记录**，不回写旧值）
```

## 3. ② 生产激活

```text
`.env` **追加**一行（**不重写**既有字节 ⇒ 避开 AGENTS §7 的编码坑）：
    # M10 目标域（用户 2026-09-30 授权的生产激活；回滚 = 删这一行）
    CHARACTER_GOALS_ENABLED=true
⚠️ 代码里的**缺省仍是 `false`** —— 与 ADR-048 / ADR-065 / ADR-067 / ADR-069 / ADR-071 同一条规矩。
```

**激活读回**（`pnpm m10:activation:readback`，计划 §18.2 三层）：

```text
verdict **PASS 6/6**
① 配置：goals=**on**
② 装配：在位=true · 开关=**on**
③ 首次行为：**`FIRST-USE NOT OBSERVED`**（待**授权读回**：快照副本 / 带 pre-open token 的只读 opener）
```

⚠️ **`First use` 现在是 `NOT OBSERVED`，且这是如实的**：计划 §18.2 逐字要求
"首次行为未观察到就写 `FIRST-USE NOT OBSERVED`"，且"**不要为了凑读数以用户身份向真实会话写合成承诺**" ✓
⇒ 真实用户发起第一个目标之后，才由**授权读回**把它翻成 `OBSERVED` ✓。

## 4. 回滚（计划 §18.3）

```text
① 删掉 `.env` 里那一行（或改回 `false`）并按合法流程重启 / 停服
   ⇒ 停止新的抽取、状态变更与注入；**既有 Goal 事件与投影保留**
② 重新启用**不扫描旧聊天补承诺**（不追溯生成）
③ ⚠️ 回滚**不会**让已经告诉用户的约定从历史上消失 ⇒ 用户查询时应能**如实得知当前功能未启用**，
   **不能**说"我已经忘了所有约定"或"仍会自动执行"
④ ⚠️ 若需批量取消有效约定 ⇒ 另走**明确的受控状态操作**，**不在关闭开关时偷偷生成取消事件**
⑤ ⚠️ `MIGRATION_0010` **不可回退**（本仓库不写 down 迁移）—— 但它是**纯追加**
   （两张新表 + 索引），**回滚功能不需要回滚它**：表留着、开关关着 ⇒ 那条链整段不跑 ✓
```

## 5. 本 ADR **不**主张什么

```text
· 不主张"她已经在用目标域"—— `First use` = `NOT OBSERVED`（首聊之后才有读数）
· 不主张"语义召回已经能用"—— 索引的**构建**仍属 M9.5 的线（本 ADR 只补了表结构）
· 不主张"合并 / 打标签已完成"—— 那两项**各属独立一步**（§1 的表）
· 不改 ADR-076 的任何设计裁定（`D01`…`D30` 与 `R-1`…`R-6` 一字未动）
```

## 6. 合并与标签（③④，2026-09-30）

```text
合并：`feature/m7-relationship` → `main`，**ff-only**
  · 前置：`git merge-base --is-ancestor main HEAD` = **真**（⇒ 必然快进）· 工作树干净 · 领先 475 提交 / 落后 0
  · 结果：`main` = `886845a729e5` = `feature/m7-relationship`（**同一提交** ⇒ 无合并提交 ✓）
标签：`m10-complete`，**annotated**，指向 **`886845a729e5`**（= 合并后的 tip）
  · ⚠️ 消息**写文件后用 `-F` 传**（避开 PowerShell 吃 ASCII 双引号的坑，AGENTS §7）
  · ⚠️ **没有推送到任何远端**（那是独立一步，未被授权）
⇒ 其后文档/读数提交以**最新权威报告**为准（TD-16 读取规则，与 M7/M8/M9 同一条）
```

## 7. 关联

- 判定：[`M10-Gate-Decision.md`](../m10/M10-Gate-Decision.md)（14 槽 · `Implementation` = `COMPLETE`）
- 候选：[`M10-Activation-Candidate.md`](../m10/M10-Activation-Candidate.md)（8/8 `MET` · 回滚预案 §5）
- 局限：[`M10-Known-Limitations.md`](../m10/M10-Known-Limitations.md)（`L-M10-66` ✅ 已修 · `L-M10-68` ✅ 已修）
- 设计：[`ADR-076`](ADR-076-m10-goals-and-commitments.md)（`ACCEPTED / DESIGN FROZEN`）
