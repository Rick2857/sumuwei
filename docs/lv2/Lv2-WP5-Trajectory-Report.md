# Lv2 WP5 —— 混合轨迹与重启（进行中 · **未通过**）

> 日期：2026-10-02 · 计划 §`LV2-G5`（50 轮 + 15 次回访 + 真实重启 + 逐字段 rebuild）
> 状态：**NOT RUN**（lane 已建、前哨已跑；**重启段的前提尚未成立**）

---

## 1. 已建成的两个入口

| 入口 | 做什么 | 档位 |
|---|---|---|
| `pnpm lv2:trajectory` | 50 轮混合脚本 + **15 次回访**（期望值写死在脚本事实表里，不从状态反推） | `--preflight` 控制档（0 调用）/ 真实档须经 `with-test-model` |
| `pnpm lv2:restart:preflight` | **两个独立进程**先后接管同一隔离库，并对账跨进程连续性 | 控制档（0 调用） |

## 2. 读数（全部保留 · 不回写）

### 2.0 **真实档 50 轮**（2026-10-02，端点 ark · 测试端点）

```text
runId lv2-wp5-trajectory-20261002-b9829effafd8-e23f（LIVE 真实档 · 50 轮 · 15 次回访）
回访      **15/15 通过**
末轮状态  记忆 2 · **目标 5** · **承诺 0**
rebuild   **记忆 mismatched=0/2** · **目标 5→5（重放 5 行 · 事件 9）** ⇒ **CHECKED_OK**
          —— 这一次**两个域都有对象**，逐字段对账的两半**都成立**
cleanClose true
```

**三点值得单独记**：

```text
① 逐字段 rebuild 第一次**两半都有效**（记忆 2 条 + 目标 5 行；记忆全 `equal`，目标重放后逐行一致）
② **目标域在真模型下真的会写**（50 轮里出现 5 个目标）—— 而**承诺恒为 0**：
   与 `R-33`（200 轮快路径 0 承诺）**同向**，且这是**轨迹尺度**上的复现
③ 15/15 回访在真实档也全过 ⇒ 回访探针本身不是控制档特供
```

⚠️ **证据完整性的一处缺口（如实登记）**：本 run 的 `readings.json` **没有**带上结构化的
`fieldLevelRebuild` / `rebuildReading`（脚本的 JSON 载荷漏了这两个字段；判定与计数在
manifest 与运行日志里）。⇒ 已修脚本（后续 run 会带上）；**本 run 不回写**，
其 rebuild 细节以运行日志那一行为准。

### 2.1 控制档读数

```text
单进程 50 轮        回访 15/15 通过（r3/r6 期望 dislike → r9 起期望 like）· cleanClose=true
重启（两进程）      两段都 exit=0 · 沙箱同一目录 · **连续性 ✗**
```

### 2.1 判别过程（每一步都留了读数）

```text
① 候选 A（指纹对顺序敏感）       → **排除**：改成顺序无关后哈希逐字节不变
② diff 打印"0 对 0、无差异"      → **是量具缺陷**：工作区路径含空格 + `shell: true`
                                  ⇒ `--dump-state` 参数被切开、dump 压根没写；
                                  而 `read()` 读不到就当空 ⇒ 打印出"看起来像结论的失败"
                                  （AGENTS §6.8 的"静默零"同形）
                                  修：dump 路径走**环境变量**；读不到返回 null 且
                                  `dumpsRead < 2` 时 diff 不得当结论（判定里也要求 == 2）
③ 真 diff（读到 2/2）            → seg1 = 2 条 · seg2 = 2 条，但 **id 不同**
④ 指纹改成**内容键**再跑         → **仍不一致** ⇒ 一定是内容不同
⑤ 逐字段对照两份 dump            → **决定性读数**：
     seg1 末态 = food.preference.cilantro（like / dislike）
     seg2 初态 = education.institution = 示例工程科技大学（active / retracted）
     ⇒ **两段看到的根本不是同一个库**，而且 seg2 的内容**连脚本里都没有**
```

## 3. 结论：**"真实重启"的前提没成立** —— 且根因已收窄到"**同一目录会被重新物化**"

### 3.1 现场证据（可复核）

```text
%TEMP% 里只有 `…-seg1-<ts>-1` 这一族目录，**没有任何 seg2 目录**
两段读数里记的 sandboxDir **是同一个字符串**
⇒ 第二段**确实**用了传进去的 `PROJECT_LG_SANDBOX`（环境变量生效，没有被 `shell:true` 吃掉）
```

### 3.2 那么"内容不同"只剩一个解释

```text
第一段把自己的写入落在该目录里（末态 = food.preference.cilantro ✓ 与脚本一致）
第二段打开**同一个目录**，却看到 **基库副本的内容**
  （`education.institution = 示例工程科技大学` / `= 是示例工程科技大学 [retracted]` ——
   这两条**不在**本轨迹脚本里，形状上就是**被复制进来的既有数据**）
⇒ 唯一自洽的机制：**打开时该目录被重新物化（重新从源库复制）**，
  于是第一段的写入被覆盖 —— 这不是"状态没接上"，而是"**根本没接**"。
```

⚠️ **仍未验证的部分**（下一轮第一件事）：目录的 mtime 是否落在第二段启动之后、
以及**重新物化发生在哪一层**（`isolateDatabase` / 插件 SQL 适配器 / 打开器的沙箱分支）。
⇒ 在那之前，本节只是**最自洽的解释**，不是已证结论 —— 按纪律标成**待验证**。

### 3.3 因此

```text
· "跨进程连续" 这一条**没有被测到**（不是"测出来不连续"，而是**测的东西不对**）
· `LV2-G5` 依然 **NOT RUN**；本 lane 的两条读数都**不能**当作 G5 的依据
```

⚠️ **不做的事**：**不**为了让这条变绿去动 `src/dev/sandbox.ts` 或数据库打开路径 ——
那块是 `INC-01` 的防复发控制区（真实库单持有 / 快照 / 恢复），要动必须有**单独裁定**。

## 4. 下一步（按依赖）

```text
① ✅ **真实重启已成立**（本轮）：两个独立进程用 `isolateDatabase(label, {runId:'<固定>', keep:true})`
   复用同一目录 ⇒ `STATE_SHA(seg1) == INITIAL_STATE_SHA(seg2)` = `ebcdb67a75d03570` ⇒ **连续 ✓**
   （详见 §6；此前"不一致"的两次根因分别是**只设 PROJECT_LG_SANDBOX**（`R-38`）
     与**label 里含段标记**（两段算出两个目录 ⇒ 第二段拿到空库））
② **逐字段 rebuild 对账**（仍未实现）—— 受控入口**已探明**，见下
③ 然后才是真实档 50 轮（真模型 · 测试端点）
```

### 4.1 逐字段 rebuild 的**受控入口**（已探明，直接接即可）

```text
逐条记忆   `src/infrastructure/persistence/memory-store.ts:893`  rebuildMemory(db, memoryId, now?)
           —— 它自己会取该记忆的事件流 `replayMemory(...)` 并与 `before` 对照，返回 `MemoryRebuildResult`
目标域     `src/infrastructure/persistence/goal-store.ts:235`    rebuildGoalProjections(db, characterId, now?)
           —— 事务内先 `listGoalRows` 再逐条 `deleteProjection` 后重放
通用       `src/infrastructure/persistence/event-store.ts:670`   rebuildProjection<TState>(…)
同族（本次不需要，但登记以免重复找）：
           belief-store:444 · adaptive-self-store:143 · affect-store:74/143 ·
           relationship-store:74 · reflection-store:149

接法（下一轮）：
  在 `lv2-trajectory.ts` 里加 `--rebuild-check`：
    ① 跑完轨迹后取一次 live 快照（内容键）
    ② 对每条记忆调 `rebuildMemory`、对目标域调 `rebuildGoalProjections`
    ③ 再取一次快照，与 ① **逐字段**比（谓词/取值/规范键/状态/声明/终态）
    ④ 把 `fieldLevelRebuild` 从 `NOT IMPLEMENTED` 改成 `CHECKED`，并把
       "重建后的投影 == 重建前的投影" 写成一条机器判据（不一致 ⇒ FAIL，逐条在案）
  ⚠️ 未知返回形状不许"猜成通过"：形状不认识时记 **`unknown`**，不得默认 true
```

---

## 6. 真实重启：读数与两次修正（2026-10-02）

```text
runId lv2-wp5-restart-20261002-ca9304dd720c-c85f（50 轮 · 第 25 轮后重启 · 控制档）
第一段 exit=0 · 沙箱 project-lg-exp-lv2-trajectory-50-control-restart-1790948949760
第二段 exit=0（**全新进程**，同一固定 runId 复用**同一**沙箱）
STATE_SHA(seg1) = ebcdb67a75d03570  ==  INITIAL_STATE_SHA(seg2) = ebcdb67a75d03570  ⇒ **连续 ✓**
diff：memories 2/2（只在seg1=[] · 只在seg2=[]）· goals 0/0 · commitments 0/0
verdict = **PASS** · measured_count=3 · cleanClose=true · realDb.opened=false
```

**两次修正**（都留档、不回写）：

| 修正 | 症状 | 根因 |
|---|---|---|
| `R-38` | 第二段看到**真实库**内容 | 只设 `PROJECT_LG_SANDBOX`（闸以为隔离）而未设 `PGLITE_DATA_DIR`（PGlite 落到缺省 `./data/pglite`） |
| label 含段标记 | 第二段拿到**空库**（两段目录不同） | 目录名 = `project-lg-exp-<label>-<runId>`，段标记进了 label ⇒ 两段各算一个目录 |

⇒ 现在两段**都**走 `isolateDatabase(label, { runId, keep: true })`：与仓库注释逐字一致
（"同一 id 会复用目录 / keep=true 时不自动清理，用于需要跨进程复用同一目录的实验"）。

## 5. 顺带记下的一条**独立发现**（未外推）

```text
`makeMemoryId(characterId, slot)` 的 `slot` 形如 `<批次内序号>-<规范化谓词>`
（`src/kernel/contracts/ids.ts:212-217`），而"批次内序号"是**进程局部**的
⇒ 同一个持久化事实在不同进程里会得到**不同的 id**。
本读数只在**本 lane** 里观测到；是否影响任何生产路径（跨进程引用 memoryId 的地方）
**未验证、不外推**，另行立案。
```
