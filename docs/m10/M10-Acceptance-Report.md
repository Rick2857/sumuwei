# M10 验收报告（Acceptance Report）

- 日期：2026-09-30
- 依据：计划 **§21.2** 点名的交付物之一
- 定位：本文件是**事实报告**（造了什么 · 读数是多少 · 缺口在哪）。
  **判定**（判决书）是 `M10-Gate-Decision.md` 的事 —— 本文件**不下判决**。
- ⚠️ **本文件不主张"验收通过"**：14 个槽里有 **3 个没有读数**（见 §1），
  按本仓库纪律"没有读数就不写结论"。

---

## 1. 十四个槽（按 §21.1 的槽名与词表；**逐槽写它自己的状态**）

| §21.1 的槽 | 当前值 | 依据（可点开核） |
|---|---|---|
| Design | **`ACCEPTED / DESIGN FROZEN`** | [`ADR-076`](../adr/ADR-076-m10-goals-and-commitments.md) + [`M10-Acceptance-Contract.md`](M10-Acceptance-Contract.md) |
| Implementation | **`PARTIAL`** | 全部 WP 已实现，但 **`G-1`**（`CHARACTER_GOALS_ENABLED` 不在 `flags.ts`）与 **`G-2`**（`main.ts` 未引用 `runGoalTurn`）**确实未做** —— 实测两次 grep 均为 **0 处** |
| Input/reference contract | **`PASS`** | `m10:inputs:verify` **25/25**（真 revision / Belief 资格 / 主体隔离）· `m10:source:verify` **42/42**（原话 / 归因 / 采纳 / 形状） |
| Mechanical gates | **`PASS`** | `gates:run --lane m10` = **24 道 · PASS 24 · FAIL 0**；`m10:gates` 逐门判 `PASS 22 · FAIL 0 · NOT RUN 1`（唯一 NOT RUN 是 `m10:preflight`，它有意不写证据档） |
| Measurement validity | **`VALID`** | `m10:measurement:verify` = **54/54**（`S=12 · N=13 · R=13 · V=13`）；覆盖 **13/16**，三道未覆盖**各有不同原因**（`L-M10-50`） |
| Semantic evaluation | **`NOT RUN`** ⚠️ | 语义门一次都没跑。**需要用户**：`U-15`（语料金标已审 ✅）→ 70 张盲审卡填完 → 跑门。⚠️ 该槽的词表**没有 `NOT RUN`**（§3） |
| Live chain | **`NOT RUN`** | `L-M10-61`：`semantic=true` 的聊天轮次静默阻塞。**根因已定位**（交接单 §6.13），**修法待用户裁定** |
| Long trajectory | **两条独立读数** | `--turns=200` → **PASS 11/11**（真档多份，最新 `…-8ec3`）· `--turns=500` → **PASS 11/11**（`…-1ded`）。⚠️ 轮数记在证据的顶层 `turns` 字段（不在 `checks` 里） |
| Human review | **✅ 完成（逐案）** | 方式 = **甲 · 逐案计分**；首轮 70 张答满（未答 0）⇒ 一致率 **74.3%**（52/70）；**18 条分歧集中在 3 个家族，已全部裁定完毕**：`test-ne-02`（5）**审阅人认可金标** · `test-co-01`（8）**审阅人接受金标**（理由：两种读法对**用户可见效果相同**）· `test-dp-01`（5）**拆族后重判**（4 条全一致 + 1 条采纳审阅人移入 cancel 族）。⇒ 语料指纹第 6 次冻结（`6b95ad524e576587`），**新档 0 张需重判**、无未决分歧。见 [`M10-Human-Review-Adjudication.md`](M10-Human-Review-Adjudication.md) |
| Regression | **`EXIT 0`**（具名例外已列） | `m10:regression:verify` **断言 8/8 · 登记 3**（`L-M10-65`）：§16.3 的 **19 条里 16 条有 exit 0 记录 · 0 条非零 · 3 条未记录**（`L-M10-63`：M9.1 三条**无 lane** ⇒ 盘上无 `run.json`；**另行直跑 exit 0**） |
| External Capability Added | **`NONE`** | 计划 §0 逐字："新增外部 Capability = **NONE**"；实测能力表未变 |
| Production activation | **`NOT ACTIVATED`** | 候选条件 **5/8**；缺口 `G-1`/`G-2`/`G-3`/`G-4`；且缺**用户的生产操作授权** |
| First use | **`NOT OBSERVED`** | 依赖激活 |
| Merge / tag | **`NOT REQUESTED`** | 属独立裁定；**不因"计划被批准"自动扩大** |

⇒ **14 槽里 12 槽有读数、2 槽没有**（`Semantic evaluation` · `Live chain`）。
⚠️ `Human review` 槽**已跑完**（逐案 74.3% + 18 条分歧逐条裁定），
但它的裁定里有 **2 条要改语料**（拆族 + 改上文）⇒ **语义门仍不能跑**：
改了语料指纹就会再变，现在跑等于拿一份**即将作废的题**去考模型。
**三者的挡路者是同两件事**：① 用户填 70 张卡 ② 用户裁定 `L-M10-61` 的修法。

---

## 2. 全部机械门的读数（**逐门分列，不合成一个总分**）

```text
pnpm gates:run --lane m10        →  24 道 · PASS 24 · FAIL 0 · CACHED 0 · TIMEOUT 0（≈216s）

逐门（读各门自己的证据档，`m10:gates` 只读聚合）：
  m10:wp0:admission      ADMISSION PASS  断言 32/32 · 登记 1   （WP0 六问均有代码指针与实测读数）
  m10:inputs:verify      PASS            25/25
  m10:test               PASS            56/56
  m10:source:verify      PASS            42/42
  m10:invalidation:verify PASS           37/37
  m10:completion:verify  PASS            43/43
  m10:context:verify     PASS            26/26
  m10:observability:verify PASS          19/19
  m10:measurement:verify PASS            54/54
  m10:e2e:verify         PASS            19/19   （G=11 · C=3 · X=4 · Z=1；realDbTouched=false）
  m10:scale:verify       PASS            13/13
  m10:long:verify        PASS            断言 9/9 ×2（200 轮 / 500 轮）· 各含登记 2
  m10:gateway:verify     PASS            断言 11/11 · 登记 1
  m10:oracle:verify      PASS             9/9
  m10:semantic:dry       PASS            断言 12/12 · 登记 1   （**离线干跑**，不是语义门本身）
  m10:evidence:verify    PASS            11/11
  m10:docs:verify        PASS            10/10
  m10:coverage:verify    PASS             9/9
  m10:activation:verify  PASS             8/8
  m10:gates             PASS            10/10
  m10:m11:verify         PASS            11/11
  m10:realdb:invariant   PASS             5/5     （连读两次 + 逐文件；真实库**逐字未变**）
  m10:regression:verify  PASS            断言 8/8 · 登记 3
  m10:preflight          NOT RUN                  （**有意不写证据档** ⇒ 聚合门如实报 NOT RUN）
```

⚠️ **`m10:semantic:dry` 不是"语义评估"**：它是**离线干跑**（不调模型），
与那个 `NOT RUN` 的槽**不是一回事** —— 把前者当成后者是本报告要防的混淆。

---

## 3. 一处**词表缺口**（如实登记，不硬塞）

```text
槽「Semantic evaluation」的允许表达 = PASS / FAIL / INCONCLUSIVE / INVALID —— **没有 NOT RUN**。
而它当前的真实状态**就是** NOT RUN。
```

⇒ **不把它写成 `INCONCLUSIVE`**："没跑"与"跑了但结论不确定"是两件事，
塞进去就是**用允许的词表掩盖没跑**（计划 §17 停线条件第 6/7 条要防的正是这个）。
⇒ 本报告**具名声明偏离**：该槽记 `NOT RUN` 并说明原因；收口时若已跑，则按词表如实填。

---

## 4. 这一里程碑造了什么（交付物清点）

```text
代码面：目标域（契约 / 投影 `goal:<goalId>` / 放行口 / 折叠核心 / 上下文 section /
        开发者面 / 只读 oracle / 网关端口 `runGoalTurn`）
        **零迁移**（复用 `character_projections`；迁移目标 NONE = D15）
命令面：**27 条 `m10:*`** 脚本 · **24 道门**（lane 自动派生于 `M10_GATES`）
文档面：见 §21.2 清点（交接单 §6.12）—— 本轮**已交付 13 项**（含 2 项改名），**3 项未出**
        （`Semantic Evaluation` / `Live Report` / `Gate Decision`，各自的挡路者已列）
```

三条**跨里程碑硬性质**的当前状态（任何改动都不许破坏）：

```text
① 她生成的内容永远不能自动变成外部事实
   ⇒ `m10:context:verify` 26/26（G41 注入只当数据 · 事实块由程序生成）
② 投影是派生的：删掉能从事件重放出来，逐字段一致
   ⇒ `m10:e2e:verify` 的 G45（`相同=true · 重放事件=2`）· `m10:test` 的折叠核心唯一性
③ 有副作用就必须有目标确定性、有账本、有 traceId
   ⇒ `m10:completion:verify` 43/43（含两个崩溃窗口 C1/C2 的具名恢复路径）
```

---

## 5. 本里程碑**自己抓到并修掉的量具缺陷**（这一栏是这份报告的信用来源）

```text
1. `m10:source:verify` 的 A8 误报三次（匹配到自己的 import / 自己的标签文本 /
   剥掉字符串字面量后读不到参数）⇒ 改成"只剥注释与模板串"
2. 注入档与真 FAIL 档**同形** ⇒ 聚合门把注入的 FAIL 读成产品缺陷
   ⇒ 加 `M10_INJECTION` 标记（读数 PASS 19·FAIL 2 → PASS 21·FAIL 0）
3. 登记 m10:regression:verify 时没同步 `GATE_TO_TEST_TYPE` ⇒ A2 当场变红（判据按设计工作）
4. `m10:activation:verify` 的 A6：认死中文槽名 + 对整行搜 `ACTIVATED`
   （而行尾"允许的表达"列本来就写着它）⇒ 改成"两种槽名都认 + 只看取值格"
5. `L-M10-64`：`m10:e2e:verify` 的 `G39` **空过**（判据对任何输入都成立，标签却声称测了
   具名澄清与数据保全）⇒ 断言换成真的（行数 == 场景建的行数）、标签降到它真能断言的
6. `m10:gates` 用**目录名字典序**当"最新"（runId 末尾是随机后缀）⇒ 同日多次运行判定任意
   ⇒ 改成按 mtime；修的过程中还因漏加 `statSync` import 让排序失效、当场报 3 个假 FAIL
```

⇒ 六条里**五条**的共同形状是：**读数看起来确定，其实量错了东西**。
这正是 `AGENTS.md` §6.2/§6.7/§6.8 三条纪律要防的，也是 `M10-Measurement-Report.md` 的主题。

---

## 6. 本报告**不**主张什么

```text
① 不主张验收通过：3 个槽没有读数（语义 / live / 人审）
② 不主张"离线全绿 = 真实链路正确"（AGENTS §6.1）；live 档恰是本里程碑的缺口
③ 不主张语义质量：语义门一次没跑；`m10:semantic:dry` 是**离线干跑**
④ 不主张激活：候选 5/8，且 `G-1`/`G-2` 实测不存在
⑤ 不主张"19/19"或"24/24"等于覆盖了 §14 的全部 48 个场景（场景账在 `M10-Scenario-Coverage.md`）
⑥ 不主张首次使用：`NOT OBSERVED`，且它依赖激活
⑦ 不主张 M9.5 的健康：`L-M10-61` 是**它**的缺陷（本里程碑只负责定位与登记）
```

---

## 7. 两个挡路者（**这就是"还缺什么"的全部**）

```text
① 用户裁定 `L-M10-61` 的修法（交接单 §6.13.4 的三层）
   + 是否关掉 `.env` 的 `CHARACTER_MEMORY_SEMANTIC_ENABLED` 以立即缓解
   ⇒ 解锁：Live chain 槽 → Live Report → 之后才能做 `G-2` 接线（次序硬约束 G-4 先于 G-2）
② 用户填完 70 张盲审卡（`--turns` 无关；材料在
   artifacts/m10/m10-wp10-review-<最新>/blind-cards.md，指纹 8a9cdea76bca7812）
   ⇒ 解锁：Human review 槽 → Semantic evaluation 槽 → Gate Decision
```

⚠️ 两件**都不是工程阻塞**（没有"做不下去"的代码问题），而是**裁定与人工输入**。
⇒ 按计划 §17 的口径，这不构成"停线条件"，本里程碑**保持进行中**。
