# M11 GitHub 借鉴登记（固定 pin）

> 状态：**登记完成**（2026-10-01，M11 WP1 产物）
> 设计权威：[ADR-085](../adr/ADR-085-m11-reflection-and-bounded-adaptive-self.md)
> 计划源：[`M11-Execution-Plan.md`](M11-Execution-Plan.md) §3（上游核对结果与固定版本）
> 纪律：**一个概念一处实现**；本里程碑**不引入运行时依赖**，不迁移平台。

---

## 0. 登记纪律（先写清楚，再列项目）

```text
① **机制借鉴 ≠ 已接入**：本文登记的是"读了什么、借了什么结构、LG 自己怎么实现、哪部分不用"。
   不得在报告里写成"接入了 LangMem / Generative Agents"。
② **固定 pin**：下表提交是计划编写时（2026-09-30）的核对读数。**开工时若更新 pin**，
   先出差异审查、再修改本登记 —— 不允许用浮动 `main` 同时声称引用的是固定实现。
③ **无代码移植** ⇒ 本里程碑不产生上游许可证的再分发义务。
   若将来逐段移植代码，**必须**保留该项目的 LICENSE/NOTICE 并在此登记（含许可证原文复核）。
④ **数据许可与代码许可分开**：任何上游**数据**（语料/标注）在许可核验前**不得**导入；
   LoCoMo 的数据是 **CC BY-NC 4.0**（不是 MIT），默认只借题型。
⑤ **运行时依赖 NONE**：四个借鉴点都不新增 `package.json` 依赖，也不新增外部服务。
```

---

## 1. 固定版本与借鉴内容

| 项目 / 固定提交 | 许可（按计划 §3.1 的 2026-09-30 读数） | 借鉴内容 | LG 实际使用方式 | **不直接采用**的部分 | 落点 WP |
|---|---|---|---|---|---|
| [LangMem](https://github.com/langchain-ai/langmem/tree/9d033b47d9ce53e37e92c92241b0496c0278932e) `9d033b47…` | MIT（仓库代码） | 后台整合的**任务分离**、取消与 shutdown 生命周期；结构化候选 | **机制借鉴**，适配 LG 现有 TypeScript jobs / scheduler / 水位；运行时依赖 **NONE** | 独立 LangGraph store；其 Memory insert/update/delete 权限；prompt optimizer 自动修改核心提示 | WP3 / WP7 |
| [Generative Agents](https://github.com/joonspk-research/generative_agents/tree/fe05a71d3e4ed7d10bf68aa4eda6dd995ec070f4) `fe05a71d…` | Apache-2.0 | 从经历形成**焦点问题**，再生成带**证据映射**的 insight | **算法结构借鉴**；原始引用由 LG 程序映射、复核、去重（`D05`/`D06`） | 生成 thought 即直接写 memory；递归 thought 充当新证据；异常时返回占位 insight | WP2 / WP3 / WP4 |
| [Concordia](https://github.com/google-deepmind/concordia/tree/405584db8e09e001da6deb147a6389f7a7f44e28) `405584db…` | Apache-2.0 | **有限近期观察**、内部问题与决策上下文**分离** | 延续既有 [研究记录](../research/concordia-notes.md)；借鉴**模块职责**划分 | Python Runtime / World 引擎；生成回答自动加到记忆；原始 prompt 推理日志 | WP1 / WP8 |
| [PersonaMem](https://github.com/bowen-upenn/PersonaMem/tree/d07e6ade22e85e0e5d562247323a9c3e07553226) `d07e6ade…` | MIT（仓库代码）；**数据许可另核** | 多会话资料变化、偏好更新与一致性测试 | **评测设计借鉴**，编写独立中文场景 | 把用户画像变化等同于角色人格成长；直接套用其成绩 | WP9 / WP10 |
| [LongMemEval](https://github.com/xiaowu0162/LongMemEval/tree/9e0b455f4ef0e2ab8f2e582289761153549043fc) `9e0b455f…` | MIT（仓库代码）；**数据使用单独核验** | 更新、时间关系、多会话推理、**信息不足时拒答** | **评测设计借鉴**；来源回查与遗忘用 LG 自建语料 | 把记忆问答分数当作反思或行为成长证据；为评测顺带接入外部工具 | WP9 |
| [LoCoMo](https://github.com/snap-research/locomo/tree/3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376) `3eb6f2c5…` | **`LICENSE.txt` = CC BY-NC 4.0**（**不得**误写 MIT） | 长对话的时间 / 多跳 / **信息不足**题型，事件总结 | **题型借鉴**，默认自行编写中文轨迹 | 原始数据复制；整套代码迁入；扩到多模态 | WP9 / WP10 |

⚠️ 许可一栏是**计划 §3.1 的读数**，不是本 WP 重新逐仓复核的结论。
本 WP0/WP1 **没有**下载或复制任何上游代码；将来若要逐段移植，按 §0③ 重新复核许可原文。

---

## 2. 可复核的上游代码入口 → LG 的纪律映射

| 上游入口 | 需转化为 LG 的具体纪律 | 落点 |
|---|---|---|
| [LangMem `reflection.py`](https://github.com/langchain-ai/langmem/blob/9d033b47d9ce53e37e92c92241b0496c0278932e/src/langmem/reflection.py) | 排队、取消与关闭必须有**真实效果**；LG 仍用自己的持久任务、水位和事务 | WP7（`D15`/`D17`） |
| [LangMem `optimization.py`](https://github.com/langchain-ai/langmem/blob/9d033b47d9ce53e37e92c92241b0496c0278932e/src/langmem/prompts/optimization.py) | 提示优化只是参考；M11 **不**自动修改 Seed 或完整性规则 | ADR-085 `D02` / `D32` |
| [Generative Agents `reflect.py`](https://github.com/joonspk-research/generative_agents/blob/fe05a71d3e4ed7d10bf68aa4eda6dd995ec070f4/reverie/backend_server/persona/cognitive_modules/reflect.py) | 模型给出的证据序号**只能引用程序提供的候选**；派生 insight **不增加**独立根数量；占位输出**不可**当成成功 | WP2/WP3/WP4（`D05`/`D06`/`D31`） |
| [Concordia `question_of_recent_memories.py`](https://github.com/google-deepmind/concordia/blob/405584db8e09e001da6deb147a6389f7a7f44e28/concordia/components/agent/question_of_recent_memories.py) | 观察与解释**分开**；解释**不自动**获得 Memory 权威；**不记录**原始推理 prompt | ADR-085 `D04` / §6 |

---

## 3. 逐 WP 的交接义务

每个用到借鉴的 WP 交接单**必须**写四段（计划 §3.2 逐字）：

```text
① 借鉴内容（哪个上游入口、哪条机制）
② LG 实际实现（文件与判据，说明它**不是**上游代码的移植）
③ 未采用部分（以及为什么）
④ 固定提交（本登记表里的 pin）
```

**缺这四段的 WP 交接单视为未完成**（WP11 收口时逐份核对）。
