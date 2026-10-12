# S8 Activation Candidate —— WP9 生产激活候选

状态：**PROPOSED / 未执行**（本文件是**手册**；"能不能做"由 [ADR-094](../adr/ADR-094-s8-story-cognition-production-activation.md) 裁定）。
日期：2026-10-03。工作包：`POSTLV2-S8 / WP9`。

> ⏩ 2026-10-04：已执行并读回 PASS，见 `S8-Activation-Record.md`。

> ⚠️ **没有做任何激活**：没改代码、没写 `.env`、没开真实库。
> 本文件的用途是"被批准之后照着执行"，以及"被批准之前先把缺什么说清楚"。

⏩ 2026-10-04：已执行并读回 PASS，见 `S8-Activation-Record.md`。

---

## 1. 激活的是什么（**如实**）

```text
⚠️ 现状：S8 的**引擎**已建完并验过，但**生产链路尚未装配** ——
   `CHARACTER_STORY_COGNITION_ENABLED` 在 src/** 里 0 处；
   `commitStoryTurn` 等只被五道门调用，main.ts / 调度器 / gateway 一次都没调用。
   ⇒ 今天**没有可翻转的开关**。
```

因此"激活"分两段，**分别取证、分别批准**：

| 段 | 内容 | 载体 |
|---|---|---|
| **A · 装配** | `D01` 开关 + `D02` 生产故事入口 + `D03` 消费者调度/水位 + `D04` 额度接线 | [ADR-094](../adr/ADR-094-s8-story-cognition-production-activation.md) `D01`–`D04` + `D11` |
| **B · 激活** | 真实库 v10–v12 → 配置生效 → 读回 → 回滚演练 | 本文件 §3–§5 + 激活记录 |

## 2. 激活前核对清单（逐项，缺一不可）

| # | 项 | 怎么核 | 当前 |
|---|---|---|---|
| 1 | ADR-093 八道 S8 门全 PASS | `pnpm postlv2:s8:gates`（只读已落盘证据） | ✅ HARD GATES PASS |
| 2 | 完整离线纪律 | `pnpm typecheck` + `pnpm m4.5:ci` | ✅ 均 EXIT 0（2026-10-03） |
| 3 | 装配段 A 完成且**开关被真的消费**（不是一个 NOT-WIRED 的惰性开关） | 新门 `postlv2:s8:production:verify` + `m4:test`/`m4.5:test` 的消费锁 | ❌ 未做 |
| 4 | 生产入口的放行口读数：非法选择 / 版本不符 / 非 frontier / 跨 run **全拒且零副作用**；绑定字段**只能**由服务端填 | 同上门 | ❌ 未做 |
| 5 | `D03` 的**至多一次**读数（独立水位，或书面接受替代口径） | `postlv2:s8:lifecycle:verify` 的扩展或新证据 | ❌ 未满足 |
| 6 | 行为槽 `S8-A43`：跑过 **或** 用户书面接受不跑 | 门判定 §0 | ⚠️ `NOT RUN`（已裁定接受，批准时请再确认） |
| 7 | 金标人审 | — | ⚠️ `AWAITING HUMAN REVIEW`（激活不依赖，但不得趁机自签） |
| 8 | 真实库迁移授权 + 已验证快照 | `D06` 的程序 | ❌ 未申请 |
| 9 | 回滚演练（dry-run） | `D07` | ❌ 未做 |

⏩ **2026-10-04 逐项修订（只追加；原「当前」列不回写）**：

| # | 项 | ⏩ 2026-10-04 状态 | 证据 |
|---|---|---|---|
| 1 | ADR-093 八道 S8 门全 PASS | ✅ 已 PASS（激活后 `postlv2:s8:gates` 读数 `ACTIVATED` 在案；门本身未被激活改变） | `S8-Gate-Decision.md` §5 + `scripts/postlv2-s8-gates.ts:178` |
| 2 | 完整离线纪律（`typecheck` + `m4.5:ci`） | ✅ 已 PASS（原样成立） | `S8-Activation-Record.md` |
| 3 | 装配段 A 完成且**开关被真的消费** | ⚠️ **只能部分打勾**：`src/main.ts:1991` 的消费点已落地、`D01` 消费锁已在 `scripts/kernel-tests-memory.ts:3499-3512` PASS；**但**该锁只做**文本**断言（`main.ts` 含两个标识符），**测不到**「有东西可被消费」——`ingestChoice` 在生产里**没有调用者** ⇒ 见 **`L-S8-30`** | `src/main.ts:1991-2002` · `S8-Consumption-Entry-Gap.md` |
| 4 | 生产入口的放行口读数 | ⚠️ **只能部分打勾**：`postlv2:s8:production:verify` PASS 20 + `postlv2:s8:withdraw:verify` PASS 13 覆盖**逻辑**；**但生产入口本身未接线**（无调用者）⇒ 见 **`L-S8-30`** | `src/main.ts:1991` · `S8-Consumption-Entry-Gap.md` |
| 5 | `D03` 的**至多一次**读数 | ✅ 已满足（机制面 + 回路面 `L7`/`L8`/`L9` + `N7`/`N8`） | `S8-Activation-Record.md` §7 |
| 6 | 行为槽 `S8-A43` | ⚠️ 仍 `NOT RUN`（未变；不新增行为主张） | `S8-Gate-Decision.md` §0 |
| 7 | 金标人审 | ⚠️ 仍 `AWAITING HUMAN REVIEW`（未变） | `S8-Gate-Decision.md` §0 |
| 8 | 真实库迁移授权 + 已验证快照 | ✅ 已申请并执行：schema **10 → 13**，零删除 | `S8-Activation-Record.md` §3 迁移行 |
| 9 | 回滚演练（dry-run） | ✅ dry-run 已做（真删未执行） | `S8-Activation-Record.md` §7（`L-S8-27` 行） |

## 3. 激活动作（**批准后**才做的全部改动）

### 3.1 配置层（唯一的手工改动）

```bash
# .env（生产基线；**代码缺省保持 false 不变**）
CHARACTER_STORY_COGNITION_ENABLED=true
# 入模额度是**独立**的一件事（缺省 0 = 她看不到；0 时"消费照跑、状态照变、提示词里没有"）
CHARACTER_ADAPTIVE_SELF_TOKENS=<由用户裁定的额度>
```

⚠️ 只追加这两行；不动任何别的键（先例：ADR-048 / ADR-052 / ADR-065 / ADR-067 / ADR-069）。

### 3.2 真实库（独立授权，单独一轮）

```bash
pnpm db:snapshot            # ⚠️ 缺省会按窗口剪旧快照 ⇒ 若不允许删除，用 --keep 30
pnpm migrate                # 预览：应显示 v10–v12 待应用
pnpm migrate:apply          # 需用户当轮逐字授权（PROJECT_LG_ALLOW_KERNEL_MIGRATION=1）
pnpm postlv2:s8:activation-readback   # SELECT-only 读回（本 ADR D08）
```

### 3.3 记录

激活记录写成新的状态修订载体（先例：ADR-048 / ADR-069 / ADR-071 都标"**只做状态修订**"），
**不改** ADR-093 与 ADR-094 的正文。

## 4. 激活后的可观察面（预期，**不是**已观察）

```text
① 真实对话里出现一次**合法选择** ⇒ 世界账本新增一条提交（`storyline_commits` 可查）
② 该提交的 anchor 是触发它的那条用户消息 ⇒ 根解析可追（`story_event`）
③ 情绪 / 关系 各至多多一次有界增量（幂等单元 = 提交身份）
④ 若额度 > 0，且该槽被合法采纳 ⇒ 提示词里出现 `adaptive-self` 块（程序渲染，非模型自由度）
⑤ 撤回（`STORY_EXPERIENCE_RETRACTED`）写下之后 ⇒ 依赖它的槽**立刻**不再入模
```

⚠️ **以上每一条都要在首个真实轮之后**用读数确认 —— 在此之前一律记 `FIRST-USE NOT OBSERVED`。

## 5. 风险与回滚

| 风险 | 缓解 |
|---|---|
| 模型把"选择"解析错（提案错） | 世界判定在**程序**侧（`advanceFromProposal`）：非 frontier / 未知 choice / 版本不符全拒；零副作用 |
| 入模额度给了却没内容 | 额度与开关**分列**取证；读回里分别显示"消费了"与"入模了" |
| 真实库迁移中途失败 | `D06` 的六步 + 已验证快照 + `INCIDENT HOLD`（不自动修复、不反复试开） |
| 状态被故事经历过度推动 | 两张规则表的单事件上限**不放宽**（`MAX_AFFECT_DELTA_PER_EVENT` / 既有关系上限），且自检在**构造期**就跑 |
| 想撤回却撤不干净 | 撤回是**读时**判定（`R-11` 的传播已实现），replay/rebuild 绕不过去 |

**回滚**：删 `.env` 那两行 ⇒ 消费与注入即停；账本、事件、投影、撤回记录、水位**全部保留**；
迁移不回滚（本仓库不写 down），表留着无害。回滚后重跑读回脚本应显示"未消费、未注入"。

## 6. 不因激活新增的主张

- **不**主张能力通过：行为槽 `NOT RUN`、`S8-A38` 为已裁定残差。
- **不**主张存在行为增益：**没有任何**行为读数支持。
- **不**主张"她记住了那次二面"：入模取决于额度与采纳，且措辞层没有启发式守卫（`DR-11`）。
- **不**主张真实库已迁移或已激活：本文件**什么都没执行**。

⏩ 2026-10-04：已执行并读回 PASS，见 `S8-Activation-Record.md`。
