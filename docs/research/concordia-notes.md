# Concordia 架构笔记

**性质**：`REFERENCE ONLY`（计划书第 53 / 54 / 99 节）
**是否新增生产依赖**：**否**
**是否接入其 runtime**：**否**

---

## 0. 为什么写这份笔记

计划书第 98 节说得很清楚：

> 只记录：我们借用了什么架构思想 / 我们明确没有采用什么。
> **避免未来开发者误以为：项目计划以后必须迁移到 Concordia。**

因此这份文件最重要的作用是**防止误解**，而不是记录"我们要做什么"。

---

## 1. 我们借的三条架构原则（计划书第 53 节）

```text
Agent ≠ World

Action ≠ Result

Observation → Agent → Action → Environment → Observation
```

以及它的分层思想：

```text
Agent          角色自己的推理与产出
Game Master    世界如何回应
Engine         时间与调度
```

### 这三条具体落到哪里

| 借来的原则 | 在本项目的落地点 | 对应文档 / 代码 |
|---|---|---|
| `Agent ≠ World` | Character Kernel 不拥有世界事实；`character_domain_events` 永不含世界真相 | `future-world-boundary.md`、`assertCharacterInternalScope` |
| `Action ≠ Result` | `CharacterIntent` → `IntentResolver` → `IntentResolution`（`rejected` / `failed` 分开） | `intent.ts`、`observation-intent-boundary.md` |
| `Observation → Agent → …` | `Observation` 是 Kernel 的输入边界；结果以 Observation 回来 | `observation.ts`、FC-01/FC-03 |
| `perspective isolation` | `perspectiveOwnerId` 约定（M9 才实现） | `entity.ts`、FC-06 |

---

## 2. 我们**明确没有**采用的东西（计划书第 54 节）

```text
完整 simulation runtime
Game Master 实现
Prefab（预设场景/预制体）
社会模拟系统
```

```text
依赖：                不引入
pip install：         不做
runtime 迁移：         不计划
```

**关键的一句话**：本项目**不会**"有一天迁移到 Concordia"。
我们不使用它的代码、不依赖它的抽象类、不按它的目录结构组织代码。
我们借的只有三条**思想**，而且这三条已经被翻译成本项目自己的类型与测试。

如果某天有人提议"接入 Concordia"，那属于新阶段 + 新 ADR 的范围，
而不是"M3.5 预留好的下一步"。

---

## 3. 为什么不直接用它

| 理由 | 说明 |
|---|---|
| 语言与形态不匹配 | 本项目是 TypeScript + ElizaOS Runtime；Concordia 是 Python 的仿真框架 |
| 目标不同 | Concordia 的目标是**社会仿真研究**；本项目是一个**持久角色智能体** |
| 依赖门槛 | ADR-006 要求新增依赖回答"删除它以后系统还能否运行"。答案会是"删不掉，因为它会变成骨架" |
| 规模失控 | 接入它必然带来 Game Master / Engine / Prefab，而计划书第 3 / 102 节明确禁止 |

---

## 4. 怎么验证"我们真的没有依赖它"

| 检查 | 由谁守 |
|---|---|
| `package.json` 里没有任何 concordia 相关依赖 | ADR-006 依赖闸 + code review |
| `src/` 内不存在 Game Master / 仿真调度实现 | `m3.5:test` FC-T04 的符号守卫 |
| 世界相关能力仍只以 Observation / Intent 的形式存在 | `m3.5:test` FC-T01 ~ T08 |

---

## 5. 一句话总结

> 我们借的是**边界的划法**，不是**实现**。
> Concordia 在本项目里的角色是"一张建筑图纸"，不是"一个要住进去的房子"。
