# M11 收口判定：十四槽分列

- 日期：2026-10-01
- 里程碑：**M11 —— Reflection 与有限 Adaptive Self**
- 计划书（权威源，未改一字）：[`M11-Execution-Plan.md`](M11-Execution-Plan.md)（sha256 `12318E897FA204D2…`）
- 设计权威：[ADR-085](../adr/ADR-085-m11-reflection-and-bounded-adaptive-self.md)（`ACCEPTED / DESIGN FROZEN`）
  + [`M11-Acceptance-Contract.md`](M11-Acceptance-Contract.md)（`DESIGN FROZEN`）
- 用户授权：`R-M11-01`（ADR-085 §0.1 逐字）· 2026-10-01 另裁定 **路线 A**（Live 用测试端点）与**调用预算授权**

> ⚠️ **本表不合成一个总分**。十四槽各自有自己的状态值域（计划 §14 逐字）；
> "工程 PASS" **不**等于"行为已测到"，也**不**等于"生产已激活"。

---

## 0. 判定表

| 槽 | 状态 | 依据（机器判据 / 证据） |
|---|---|---|
| **1 Design approval** | **ACCEPTED** | ADR-085 `DESIGN FROZEN`（`D01–D34` + §0.1 `R-M11-01`）· 验收契约 `DESIGN FROZEN` · 计划书 sha256 未变（`m11:docs:verify` D1） |
| **2 Implementation** | **COMPLETE** | WP0–WP11 全部交接单在案；`m11:gates` 离线 lane **13/13 PASS**；22 个实现文件全部有文档归属（D6） |
| **3 Offline mechanical** | **PASS** | 离线必选门 13 道全 PASS（来源/派生链 · 输入 · 放行口 · 行为调整 · 失效 · 恢复 · 上下文 · 量具 · e2e · 离线长轨迹 200/500 · 可观测性） |
| **4 Measurement validity** | **VALID** | `m11:measurement:verify` **24/24**：四判定器**三段式**（正控/负控/恢复）+ **差分负控** + 恒空实现必 FAIL + 语料 320 条**冻结指纹** `945ff576…` |
| **5 Semantic evaluation** | **PASS** | `m11:semantic:eval` 第二代（head `86f97d8b`）：**480/480 全分母** · 编造 handle **0** · 支持膨胀 **0** · 反例漏报 **0** · 格式 **0.900**（最差轮 **0.8688**）· 传输失败 0.0021 |
| **6 Adaptive behavior** | **NOT OBSERVED（没有测出增益）** | `m11:ablation:verify` **7/7**（材料差异：A/B 无块且逐字相同 · C 只多那一段 59 字）；三档对同一配对题的**真实回复语义不可区分** ⇒ 按计划 §11.3 记「没有测出增益」，**不**写"成长有效" |
| **7 Live short** | **FAIL** | `m11:smoke:live` **4/5**：3 次真实调用里 **1 次不是 JSON**（`draft_invalid_json`）。门槛（3/3）**跑之前**写下，看到 2/3 后**不**改 |
| **8 Live long** | **PASS**（含**一处已登记偏差**） | `m11:long:live` **8/8**：200 轮真实账本 + 真实慢路径（采纳 39 / 拒绝 10 / 失效 15 / 调整 3 · 触发过滤 138 轮不发请求 · rebuild 对账 4/4 · 入模引用 501）· ⚠️ **对话回复脚本化**（`dialogueRequests=0`，计划 §11.4 的"200 次对话请求"未兑现） |
| **9 Privacy / authority** | **PASS** | `m11:observability:verify` **18/18**：理由码**可达性机器核对**（草案 7 · 来源 7 · 触发 6 · 审查 8）· 遮蔽（撤回/根被忘/读不到≠遮蔽）· **四个外发面零泄漏**（事实包 / section / trace 属性闭集 / 开发者面）· 全里程碑**零越界**（Memory/Belief/Goal/Commitment 未被动） |
| **10 Regression** | **PASS** | `m11:regression:verify`（`--set=full`）**PASS 6/6**：完整清单 **49** 道（`m4.5:ci` 扁平展开 + M11 各门）· 已声明非零 **2**（`m11:gates` 按设计 · `m5:budget:verify` 继承 `L-M11-13`）· 与 manifest 对账 **12** 道 · 总耗时 **388 s** |
| **11 Human review** | **PASS（2026-10-01 用户裁定：其他无问题 + 四处 remark）** | 材料 v2（32 张 · 行为盲评面）；用户原话「**其他的没有问题**」+ 四处 remark，逐字留档在 [`M11-Human-Review-Record.md`](M11-Human-Review-Record.md)：`R-1` 卡17 **越界承诺调信任**（**真缺陷** `L-M11-40`）· `R-2` 卡13/32 把**根数**讲成"内容互相印证"、卡19 混淆说话者（`L-M11-41`）· `R-3` 八张成长卡**普遍补写未证明的历史**（是 `L-M11-18` 的独立确认，**第 6 槽不翻盘**）· `R-4` 撤回处置**表述含糊**、须讲清"旧终态不翻案 / 新输入重新验证"（`L-M11-42`）。⚠️ 工作表**用户未填**（如实记录）；本里程碑**不代签** |
| **12 Production activation** | **ACTIVATED（2026-10-01）** | 用户逐字授权「**允许生产激活**」⇒ 受控执行（[`M11-Activation-Record.md`](M11-Activation-Record.md)）：真实库**一行**（水位 = 边界 **141**，走 `advanceWatermark`）· `.env` **追加三行**（`REFLECTION_ENABLED=true` / `ADAPTIVE_SELF_ENABLED=true` / `TOKENS=300`）· INC-01 状态机全程 `cleanClose=true` · 激活过程**不调模型**、本域事件 **0**。激活后**独立读回** 8/8 确认：配置层 **ACTIVATED** · 水位 1 条 · 事件 0 · 别的域未被动。⚠️ **顺序刻意与候选文件相反**（先钉边界、后开开关 ⇒ 失败关闭）。回滚 = 删那三行 |
| **13 First use** | **NOT OBSERVED** | 激活后读回仍是 **NOT OBSERVED**（水位 + 事件两个读数都按真实值判，**不凭配置宣布**）。真实首聊后的核对清单见 Activation-Record §7 |
| **14 Capability impact** | **NONE** | 无新外部能力：没有新 capability / adapter / ActionRequest 生产者（`m11:wp0:verify` 的 C5 起点读数 + `m11:policy:verify` 的无跨域写入面） |

---

## 1. 工程收口 vs 行为/生产（**不许互相顶替**）

```text
工程面（1–5、9、10）：可查 / 可审计 / 可撤回 —— **已达成**（离线全绿 + 量具有效 + 语义 PASS + 隐私 PASS + 回归 PASS）
行为面（6）：**没有测出增益** —— 这是**读数**，不是失败；但**不能**写成"成长有效"
真实链（7、8）：短链 **FAIL**（格式）· 长链 PASS 但**对话请求未跑**（偏差已登记）
人审（11）：**PENDING** —— 是收口的**必要条件**，我不代签
生产（12、13）：**NOT ACTIVATED / NOT OBSERVED** —— 需独立授权
⏩ 后续修订（2026-10-04）：**已修订** —— 本文件 `:29-30` 记 **Human review = PASS**（2026-10-01 声明式：用户「其他的没有问题」+ 四处 remark，载体 [`M11-Human-Review-Record.md`](M11-Human-Review-Record.md)）与生产 **ACTIVATED**（2026-10-01，载体 [`M11-Activation-Record.md`](M11-Activation-Record.md)）。**两处不一致以 `:29-30` 为准**；上面这段是收口当天、人审裁定与激活授权**之前**的读数，保留不改写。
```

⚠️ 计划 §14 逐字：「拒绝把"工程通过但行为未测到"包装成完整人格成长 PASS」。
本判定表**没有**那样做：第 6 槽是 `NOT OBSERVED`，第 7 槽是 `FAIL`，第 11 槽是 `PENDING`。

⏩ 后续修订（2026-10-04）：本段的「第 11 槽是 `PENDING`」已过时 —— 见本文件 `:29`（第 11 槽 **PASS**，2026-10-01 声明式人审）与 `:30`（第 12 槽 **ACTIVATED**，2026-10-01）。**两处不一致以 `:29-30` 为准**。第 6 槽 `NOT OBSERVED` 与第 7 槽 `FAIL` 不因本次修订改变。

---

## 2. 第 10 槽（Regression）的读数来源

```text
`m11:regression:verify` —— **跑与判分离**：
  `--record --set=full` 真跑**完整清单**（`m4.5:ci` 的扁平展开 + M11 各门），
  把每道门的 argv / 退出码 / 耗时 / 输出哈希写进账本（`artifacts/m11/local/regression-<head>.json`，gitignored）；
  缺省模式只读账本 + manifest，六条判据（清单齐全 · 退出码 · 不过期 · 与 manifest 对账 ·
  账本形状 · 性能读数）⇒ 判据读数见 `artifacts/m11/m11-wp11-regression-*/regression-verify.json`。
⚠️ `m4.5:ci` 在本机被 `pnpm` 的供应链校验阻塞（`L-M11-08`）⇒ **逐条直接跑入口文件**，
   逐条也便于把退出码逐条落进账本（比"一条 pnpm 命令的总体退出码"更可查）。

### 2.1 ⭐ 本轮实测到的一条**环境依赖**（不是代码回归）

```text
现象：`m4.5:measurement:verify` 在本工作树 exit=1（"不过滤时能读出全部记录 — 0 / 8"），
      而**同一道门**的已提交证据（pre-M11）是 **PASS**。
诊断（两步实测）：
  ① 直接跑生产 CLI：`tsx src/main.ts --action-list`（临时沙箱）
     ⇒ 报「**缺少 OPENAI_API_KEY**：请在项目根目录的 .env 中填入 API Key」⇒ 子进程**空输出**。
  ② 把 `.env.test` 的 key 注入环境后重跑该门 ⇒ **8/8 PASS**（EXIT 0）。
⇒ 结论：**本工作树没有 `.env`**，而该门要 spawn `src/main.ts` 当"生产 CLI"，
  后者在缺 key 时**拒绝启动** ⇒ 空输出被读成"库里没有记录"。**不是 M11 的代码回归。**
修法：`m11:regression:verify` 顶部按 AGENTS §8.1 **加载 `.env.test`**（测试端点），
  让账本反映真实读数；这条依赖也如实写在脚本注释里。
```
```

---

## 3. 可以声称 / 不能声称（计划 §14 逐字）

**可以声称**：在明确范围、来源和样本内，形成**可查 / 可审计 / 可撤回**的反思与行为策略；
合法调整在独立后续场景有**可观察表现**。

⚠️ 就本里程碑的实际读数，"可观察表现"这一句要**收窄**：第 6 槽是 `NOT OBSERVED`
（n=1/档、三档回复语义不可区分）⇒ 本里程碑**能**声称的是"**材料层面**的可观察差异"
（A/B 无块 · C 有块且只多那一段），**不能**声称"行为层面的成长已被测到"。

**不能声称**：不会编造 · 有真实人类意识 · 反思已经校准为真实心理 · root 多就必然可靠 ·
全部人格已经完成人类化 · **M11 完成即 Level 2 全能力通过**。

---

## 4. 未决与残余（分列，不合并）

```text
`L-M11-13` `m5:budget:verify` 继承红（pre-WP8 实测复现 ⇒ 归 M5/M9.5 线）
`L-M11-14` 窗口无正文（**已修**，判据补在 H 组）
`L-M11-15` 真实端点格式失败率（盲测 10% · 长链 11/62 ≈ 17.7% · 冒烟 1/3 —— **三条分列**）
`L-M11-16` 两族语料输入与金标不自洽（**已修**，金标未改，指纹重冻）
`L-M11-17` 门的时序：投影是派生的，折叠必须逐轮做（**已修**）
`L-M11-18` 消融**没有测出增益**（第 6 槽的读数）
`L-M11-19` runId 名字不能当排序键（聚合门挑错代际，**已修**）
偏差 1    `m11:long:live` 无对话模型请求（计划 §11.4 未兑现）
偏差 2    `m11:smoke:live` 保持 FAIL（不改门槛）
待办      WP12（激活）· 人审裁定 · 可选：三 lane 登记进 `scripts/gates/manifest.ts`
```

---

## 5. 载体索引

```text
设计      docs/adr/ADR-085-… · docs/m11/M11-Acceptance-Contract.md · M11-Unresolved-Decisions.md
          M11-OSS-Borrowing-Register.md
工作包    docs/m11/M11-WP{0..11}-Handoff.md（+ M11-WP11-Observability-Handoff.md）
          M11-WP0-Baseline.md
机器证据  artifacts/m11/<runId>/（`m11:gates` 只读聚合可一次列全）
人审      artifacts/m11/local/review-cards.md（私密）· review-key.json（密封）
```
