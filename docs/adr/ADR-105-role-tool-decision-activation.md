# ADR-105：角色自行选择工具 —— **生产激活**

状态：**ACTIVATED（只做状态修订 / 只改配置）**。日期：2026-10-05。
授权：用户 2026-10-05 显式指示「**生产激活先执行**」。
前置：[`ADR-104`](ADR-104-role-tool-decision.md)（设计冻结 `D01`–`D15`）·
[`WP0 基线`](../post-lv2/Role-Tool-Decision-WP0-Baseline.md) · WP1/WP2/WP3/WP4 记录 ·
[`三项裁定记录`](../post-lv2/Role-Tool-Decision-Rulings-2026-10-05.md)。

---

## 0. 这次追加了什么

`.env` **只追加一行**：

```text
CHARACTER_TOOL_DECISION_MODE=role
```

⇒ 生产聊天里，**每一轮**（在没有开场任务授权时）会多一次**私有决策调用**：
她拿到"本轮原话 + 有界的最近对话行 + **程序生成**的工具目录 + 程序给出的已知目录事实"，
输出一个**闭集提案**（`answer` / `clarify` / `tools`）；`tools` 才走**既有**任务执行环。

⚠️ **代码里的缺省仍然是 `rules`**（与 `ADR-048`/`065`/`067`/`069`/`071`/`082`/`094`/`097`/`099`/`103`
同一条先例）—— 本 ADR **不改一个字节的代码**，只记录配置层的状态切换。

---

## 1. 为什么"只开这一行"就够（前置条件已核）

```text
① `CHARACTER_TASK_AUTONOMY_ENABLED=true`  —— **已是 true**（ADR-099）
   ⚠️ 缺它 ⇒ 决策会被**跳过**（读数 `branch=skipped · reason=no_task_loop`），
      而那在日志上很像"她决定不用工具"—— 所以它是激活记录里必须一起写的一行。
② 决策端点：走 `.env` 现有的 `OPENAI_BASE_URL` / `OPENAI_SMALL_MODEL`（`api.deepseek.com`）。
③ 没有新增凭证、没有新增出站目标、没有新增依赖、没有迁移、没有后台任务。
```

---

## 2. 生效读数（机器判据）

`pnpm postlv2:role-tool:activation:readback`（**只读**：不开库、不出站、不调模型）：

```text
激活前（role-tool-activation-20261005T135136）：toolDecisionMode=rules  ⇒ overall NOT PASS（如实）
激活后（role-tool-activation-20261005T135154）：toolDecisionMode=role
  · env-mode-is-role                 ✅ toolDecisionMode=role
  · code-default-is-still-rules      ✅ 缺省 toolDecisionMode=rules（激活只改配置）
  · task-autonomy-precondition       ✅ taskAutonomyEnabled=true
  · main-consumes-the-flag           ✅ main.ts 的**代码**里有"按模式构造决策端口"那段（去注释后查）
  · decision-port-constructible      ✅ 决策端点 host=api.deepseek.com（不打印凭证）
  overall = PASS
```

⚠️ 本门**第一版量错了对象**：漏了 `import 'dotenv/config'`，于是 `readKernelFlags()` 读的是一个
**没有加载 `.env`** 的 `process.env` ⇒ 它把"配置文件没被读"报成"开关没打开"
（`task-autonomy=false` 那种假读数）。修法：本门显式加载 `.env`，并把这条教训写进文件头。
激活后的那份证据是在**修好之后**跑的。

---

## 3. 回滚

```text
删掉那一行（或改成 `rules`）⇒ **逐字节**回到今天之前的行为（关键词检测器重新成为唯一入口）。
· 不删任何数据：决策是**只读**阶段（不写库），它产生的动作仍然逐条落在既有账本里。
· 已经在进行中的任务授权（内存绑定当前会话）不受影响。
```

---

## 4. 激活**不**新增任何主张

```text
· 人审仍是 **PENDING**（送审材料见 WP4 记录 §2/§2.4/§6）——激活不代替人审。
· 真实模型的选择质量只在 **24 例冻结样本**上量过（三次读数 21/23/22，关键假阳三次都是 0）；
  **不**主张开放对话零误判（`L-RTD-20`）。
· 语义评估跑在**验收端点**（ark/`deepseek-v4.1-flash`），而生产走 `api.deepseek.com`
  ⇒ **生产上的选择质量尚未量过**（`L-RTD-21`）。
  ⏩ **2026-10-05 补：代价读数已量**（验收端点 · 生产尺寸目录）——
  决策调用 24 次：min 974ms · avg 1725ms · p50 1500ms · p90 2400ms · max **3941ms** ·
  **达到/超过 8000ms 期限的 0 次** ⇒ 缺省期限在这条端点上有约 **2 倍余量**。
  ⏩ **2026-10-05 再补：`FIRST-USE OBSERVED`**（用户「真实对话轮已过」；
  机器读数 `pnpm postlv2:role-tool:first-use:readback`，**只读快照副本、从不打开真实库**）：
  ```text
  真实库最近 6 轮里，本方案那一步出现了 **3 次**，**三种分支各一次**：
    answer  · 决策时延 1906ms · 无动作
    tools   · 决策时延 1460ms · 账本 `local.file.list=success`   ← 真实生产里真的动过手
    clarify · 决策时延 2492ms · 无动作
  更早两轮**没有**决策步（落在激活之前）—— 读数按轮分列，不把激活前后混成一件。
  ⇒ 生产侧时延（1.46–2.49s）与验收端点同量级 ⇒ 8000ms 期限在真实端点上也够用。
  ```
  ⚠️ 仍不主张：那是**一轮会话**的读数，不是统计量；`L-RTD-21` 因此**收窄但未关闭**
  （生产侧只有 3 个决策样本），`L-RTD-20`（样本量）照旧。
· **人审 = PASS**（*2026-10-05 声明式裁定*：用户「人审……已过」；先例 M8/M10.1/M11 ——
  声明式裁定归档于 WP4 记录 §3，机器读数原来的 `PENDING` **不回写**）。
· WP3 的**全工具覆盖已达成**（`postlv2:role-tool:matrix` = A 36/36 · B 32/32 · C 11/11 ·
  **未覆盖 0 项 ⇒ overall PASS**）—— 16 项能力每项都有"选中"与"不选"读数。
  ⚠️ 一处更正：曾登记"`image.ocr` 真识别属机器前置、运行时不在"，那是**查错了目录**
  （运行时一直在 `artifacts/post-lv2/local/ocr-runtime`）；用户 2026-10-05 授权跑
  `setup-rapidocr` 时它报"依赖已满足 + 模型指纹校验通过" ⇒ 真识别那一档当场跑通。
· 全部既有边界照旧：`L-RTD-01…23`（含 `L-RTD-16` 旧沙箱读无当轮内容、
  `L-RTD-19` 决策格式失误不重试、`L-RTD-23` 比率不能当硬阈值）。
· 搜索仍受 `ADR-049` 的 `querySpan` 与"每轮至多一次"约束（`D10` 未改）。
```

---

## 5. 与冻结面的关系

```text
· 执行面一个字节没变：唯一入口仍是 `ActionGateway`（ADR-030/031/032 · `INV-M45-01…06`）。
· 记忆 / 关系 / 情绪 / 信念 / 故事语义全部未触碰。
· `data/pglite`：激活前后**都没有被本批打开**（真实链用的是隔离库 + 生产库只比摘要）。
```
