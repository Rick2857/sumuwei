# 身份与人格一致性评测（Identity Evaluation）

**阶段**：M3
**回答的问题**：**"她还是不是她"这件事，怎么用数字回答。**
**相关**：[personality-drift.md](./personality-drift.md)、
[ADR-011](../adr/ADR-011-anonymous-persona-evaluation.md)、
[ADR-012](../adr/ADR-012-personality-drift-evaluation.md)

---

## 1. 三层评测，分开计分

计划书第 47 节：

> M3 的人格稳定性测试不能只看"感觉"。我们需要至少三层人格评测：
> 行为规则一致性 / 表层语言风格一致性 / 深层人格倾向一致性。

| 层 | 测什么 | 怎么测 | 失败的含义 |
|---|---|---|---|
| **行为规则一致性** | 边界条款、来源隔离、身份稳定 | **确定性检查**（读 Trace / 账本 / 快照） | 架构坏了 —— 这是硬故障 |
| **表层语言风格（SA）** | 说话像不像她 | LLM judge | 表达漂了，性格未必变 |
| **深层人格倾向（PC）** | 性格对不对 | LLM judge | 人格漂了 |

**PC 与 SA 必须分开**（计划书第 57 节）。若合并成一个分数，下面这个诊断就消失了：

```text
PersonalityConsistency = 高
StyleAdherence         = 中
→ "性格对，但表达风格漂了"
```

---

## 2. 能程序判断的不用 LLM Judge

计划书第 52 节。M3 的两档评测就是这个原则的落地：

| 档 | 命令 | 覆盖 | 需要 Key |
|---|---|---|---|
| 离线 | `pnpm eval:m3` | 20 条用例 + 所有用例里的 **105 条确定性检查** | ❌ |
| 真实模型 | `pnpm eval:m3:live` | 16 条用例 + **21 条 judge 检查** | ✅ |

（数字来自 `tsx scripts/diag-m3-coverage.ts` —— 它存在的理由就是让
"哪一档覆盖了什么"是一个**可核对的清单**，而不是一个会静默漂移的印象。）

离线档覆盖的确定性检查包括：

```text
CharacterId 稳定 / Seed 版本与指纹不变 / 身份 section 每轮都在且不可裁
她的输出不产生外部事实证据 / 系统与工具来源隔离 / 用户确认提升权威
reply graph 完整 / 会话内序号连续 / 新会话不复制旧历史
```

**这些是硬保证，因此它们必须是确定性的** —— 不依赖模型今天心情如何。

---

## 3. 硬零指标不受阈值影响

四条指标在任何情况下都必须是 0（计划书第 115–118 节）：

```ts
M3_HARD_ZERO_METRICS = [
  'SeedMutationViolationCount',        // 普通聊天改了她的 Seed
  'AssistantToFactContaminationRate',  // 她生成的内容被当成外部事实
  'ConversationEventLossRate',         // 处理了却没记进账本
  'EventOrderingErrorRate',            // 序号冲突或倒序
]
```

它们的共同点：**纯确定性，不涉及模型行为**。因此"第一次跑不通"就说明代码有问题，
不存在"等 baseline 再判定"这回事。任何一次非零 → `pnpm eval:m3` 退出码 1
并打 `CRITICAL`。

> ⚠️ 报告里硬零指标显示的是**通过比例**（1.000 = 一次违规都没有）。
> 这一条在 `eval-m3-live.ts` 的输出里有显式说明 —— 因为
> `SeedMutationViolationCount  mean 1.000` 曾被读成"违规了一次"，
> 而它其实是全绿。一个会被反向解读的报告比没有报告更糟。

---

## 4. 匿名模式（RolePlayBench 启发）

计划书第 65–68 节。**同一份 Seed，只换显示名**：

```text
具名：name = 苏沐薇
匿名：name = Character A
```

其余（人格倾向 / 价值 / 风格 / 边界）**逐字节相同**。

### 4.1 为什么需要它

如果模型认识这个名字，它可能靠**训练数据里的联想**演一个"冷淡傲娇的青梅竹马"，
而那个表演会在 PC 上拿高分。于是度量测的是"模型认识这个名字吗"，
而不是"Seed 定义得清楚吗" —— **后者才是 M3 要保证的东西**。

### 4.2 怎么读结果

计划书第 67 节：

```text
苏沐薇模式  PC = 90
匿名模式    PC = 55
```

说明模型可能过度依赖名字/隐含联想，而不是 Seed。对原创角色理论上差距应该比较小。

**Gap 大不是失败，而是诊断信号。** 正确的反应是**强化 Seed 的可判定性**
（更具体的行为例子、更清晰的反例），而不是把名字删掉 —— 名字是产品的一部分。

### 4.3 参考项目不是运行时依赖

RolePlayBench 只借 `anonymous evaluation methodology`（计划书第 68 节）。
不引入其整套 benchmark runtime：匿名化本身是几行代码
（`EvalCase.displayNameOverride`），而 ADR-006 的依赖 Gate 要求
新增依赖必须回答"删除它以后系统还能否运行"。

---

## 5. Personality Interview（InCharacter 启发）

计划书第 62/63/111 节。

### 5.1 为什么需要它

表面风格很容易伪装。她可能仍然用同样的语气，
但深层行为已经从「谨慎」变成「完全冲动」—— 普通聊天不容易发现。

访谈针对**决策倾向 / 人际态度 / 风险态度 / 价值冲突**做间接测试。

### 5.2 题库是自建的

计划书第 63 节明确要求**不要**直接拿 InCharacter 的角色题库当真值：

> 建立自己的 `evals/m3/personality-interview/`，根据 Seed Identity 设计问题。

M3 的题库在 `evals/m3/suites/personality-interview-bank.ts`，
**20–40 道**间接问题，且每道都能追到 Seed 里的一条具体倾向。

### 5.3 评的是 trait direction，不是措辞

计划书第 64 节：

> 人格一致不等于 deterministic text。所以测试的是 trait direction，
> 不是 exact wording。

这条约束写在每个 `JudgeCheck.rubric` 的规范里，因为它是最容易被破坏的一点：
把 judge 写成"必须包含某个词"之后，一个完全正确的回答会因为换了个说法而失败。

---

## 6. 怎么跑

```bash
# 离线档（PR smoke，秒级，不需要 Key —— 结构性与硬零保证都在这里）
pnpm eval:m3

# 单套件 / 过滤
pnpm eval:m3 --suite source-separation
pnpm eval:m3 --filter M3-SRC

# 机器可读报告 / 外层 Runner
pnpm eval:m3 --json data/m3-report.json
pnpm eval:m3:promptfoo            # 12 个套件各一个 Promptfoo 配置

# 真实模型档（人格部分；Release Gate）
pnpm eval:m3:live --quiet                 # 全部可人格评测的用例
pnpm eval:m3:live --runs 3 --write-baseline   # 建立 baseline
pnpm eval:m3:live --turns 100             # 长对话跑 100 轮
pnpm eval:m3:live --dump-judge            # 打印实际发给 judge 的 prompt（排查）

# 覆盖分布（"哪一档覆盖了什么"）
tsx scripts/diag-m3-coverage.ts
```

### 6.1 没有 API Key 时

`pnpm eval:m3:live` **明确跳过并给退出码 0**，并把跳过了什么打印出来。

不这样做的两个选项都被否决过：
- 用空结果假装通过 → 让 Gate 看起来是绿的（最危险）
- 以失败退出 → 阻塞不需要 Key 的离线 CI

### 6.2 "一条都没测到"必须响

`--suite identity-core` 在真实模型档下一条都不跑（那 4 条是离线用例）。
这类"全绿但什么都没量"的状态比失败更危险 —— 失败会有人去查，绿色的空报告不会。

因此 live 脚本在这种情况会打一段显式警告。

---

## 7. 指标与阈值

### 7.1 正式指标（计划书第 114 节）

```text
IdentityStabilityRate            身份稳定性（确定性）
CharacterIdContinuity            角色连续性（确定性）
SourceClassificationAccuracy     来源分类正确率（确定性）
SeedMutationViolationCount       普通聊天改 Seed 的次数（硬零）
AssistantToFactContaminationRate 她的话被当事实的比例（硬零）
ConversationEventLossRate        事件丢失率（硬零）
EventOrderingErrorRate           序号错误率（硬零）
PersonalityConsistency           人格一致性（judge）
StyleAdherence                   风格一致度（judge）
DriftRate                        漂移率（judge）
RecoveryRate                     回稳率（judge）
AnonymousPersonaGap              具名/匿名差距（对比）
```

每个指标的分母口径写在 `evals/m3/runtime/metrics.ts` 的 `METRIC_DENOMINATORS` 里，
报告末尾会打印 —— 因为"12/12"如果没人知道 12 是什么，它就不是一个指标。

### 7.2 第一轮只建立 Baseline（计划书第 119/120 节）

```text
pnpm eval:m3:live --runs 3 --write-baseline
```

写出 `evals/m3/baseline.json`：

```json
{
  "baseline": { "model": "deepseek-flash", "temperature": 0.2, "runs": 3, "measuredAt": "…" },
  "values":   { "PersonalityConsistency": 0.xx, "StyleAdherence": 0.xx },
  "variance": { "PersonalityConsistency": 0.xx }
}
```

**`minimums` 刻意不自动填。** 从"实测均值"到"可接受的回退线"中间有一步人的判断，
而那一步必须显式做（一次 diff 就能看出门槛被调过）。
自动生成的门槛会在第一次跑偏时被一起带偏。

冻结流程：

```text
1. 看 mean 与 variance：variance 大的指标说明这次测量本身不稳，先别冻结
2. 在 baseline.json 里补 "minimums"
3. 之后的运行就会按它判定
```

### 7.3 ⚠️ 单次 live 运行**不能**当回归判据

实测（5 次运行，`deepseek-flash`）：

```text
PersonalityConsistency   mean 0.881   variance 0.0071   → 标准差 ≈ 0.08  （可用于判据）
StyleAdherence           mean 0.559   variance 0.1230   → 标准差 ≈ 0.35  （**单次不可用**）
DriftRate                mean 0.640   variance 0.1042   → 标准差 ≈ 0.32  （**单次不可用**）
```

SA 的单次结果可能落在 **0.20 – 0.55** 之间（3 次运行那一档的均值是 0.367，
5 次那一档是 0.559 —— 差异只来自样本量）。

**因此**：

- 用 `pnpm eval:m3:live` 的**单次**结果去判定回归，等于让红绿取决于随机性
- 判据应当是 `--runs 3` 以上的**均值**，并且**先确认 variance 足够小**
- 确定性指标（身份 / 来源 / 硬零）variance 全为 0，那几条现在就可以冻结

一个把噪声当门槛的 Gate，最终会训练人忽略红色 —— 那比没有 Gate 更糟。

---

## 8. 计划书之外多加的两个套件

计划书第 49 节的目录清单列了 10 个 YAML。M3 生成了 **12 个**：

| 多出来的 | 为什么 |
|---|---|
| `anonymous/anonymous-persona.yaml` | 第 110 节把它列为 T12 测试组，而目录清单里漏了 |
| `personality-interview/interview-bank.yaml` | 第 111 节列为 T13，同样漏了 |

多出来的两个不是偏离计划，而是把"测试矩阵里有、目录清单里漏了"的两项补上。

---

## 9. 参考项目的定位（全部只借方法，不引入运行时）

| 项目 | M3 借什么 | 是否依赖 |
|---|---|---|
| **Promptfoo** | 外层回归执行器 | ✅ 开发依赖 |
| **Phoenix / OpenInference** | Trace 与 experiment | ✅ 观测适配器 |
| **PersonaForge** | Drift / Recovery 的测试设计 | ❌ 参考 |
| **InCharacter** | Personality Interview 方法 | ❌ 参考 |
| **RolePlayBench** | Anonymous Persona 评测方法 | ❌ 参考 |
| CharacterEval | 中文角色评测的维度参考 | ❌ 参考 |
| MemOS / Graphiti / Honcho / LangMem | **不属于 M3** | ❌ |

`package.json` 里没有任何一项因为评测而新增的运行时依赖。
