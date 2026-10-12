# 普通交流自动记忆：GitHub 筛选与接入记录

2026-10-07。本轮用户选择先补第 1 项“从普通交流中沉淀长期事实/偏好/重要经历”，GitHub 方案优先。

## 结论

选择 LangMem 的候选抽取接口，已接入现有 LG 记忆生命周期。新入口默认关闭，未激活生产。它补的是“普通陈述 → 候选”，当前对话框架、原生账本、Policy、事件折叠和召回继续沿用。

通过 Exa 检索两条方向共 23 个搜索结果，再阅读官方文档和固定提交源码、许可、包配置，并做本机导入与真实抽取探针。上游介绍不作为 LG 行为验收。

## 候选比较

| 候选 | 核对版本 / 许可 | 能直接复用的部分 | 主要接入代价 | 本轮选择 |
| --- | --- | --- | --- | --- |
| [LangMem](https://github.com/langchain-ai/langmem/tree/48e3c11f5bb527282c7d5339c6a87a0b35abccfc) | 0.0.30，MIT；固定 48e3c11 | `create_memory_manager` 返回结构化候选，无 Store 端口 | 新独立 Python venv，50 个锁定包；启动/请求成本；需覆盖默认推断指令 | 直接采用候选接口 |
| [Mem0](https://github.com/mem0ai/mem0/tree/d62ce07faceafedd4b10d60704db2b9d89d0afff) | mem0-ts 3.3.1，Apache-2.0，Node >=18 | 管理式事实抽取、记忆增改与检索 | 标准 `Memory.add` 接法管理其 own store/vector lifecycle，需再约束或拆私有抽取阶段；部分存储 SDK 是可选依赖 | 留作参考，未安装 |
| [Graphiti](https://github.com/getzep/graphiti/tree/aa5bb2706929fce502d99d8c7c4ddbb77bff4995) | 固定 aa5bb27，Python 图谱组件 | 事件到实体/事实关系，时态与证据关联 | 标准路线引入图数据库/embedding 和其时态图真相；本轮缺口不要求知识图谱 | 未采用 |
| [Mastra Memory](https://github.com/mastra-ai/mastra/tree/2f6dbe0f8969b18d49aaab61bf830ede623b4656/packages/memory) | 1.36.0，Apache-2.0，Node >=22.13 | Observational Memory 对长历史观察/反思；自定义 observation schema | 运行期依赖 Mastra core、Agent/processor/storage 及线程观察状态，标准路径还管理历史 | 未采用 |

Graphiti 的官方要求见 [README](https://github.com/getzep/graphiti/blob/aa5bb2706929fce502d99d8c7c4ddbb77bff4995/README.md)。Mastra 的行为见 [Observational Memory 官方文档](https://mastra.ai/reference/memory/observational-memory)。这些方案不是全局否定；本次只比较在现有 LG 中补该单一缺口的代价。

## LangMem 真实边界

[固定源码](https://github.com/langchain-ai/langmem/blob/48e3c11f5bb527282c7d5339c6a87a0b35abccfc/src/langmem/knowledge/extraction.py) 中，纯 `MemoryManager` 和 `MemoryStoreManager` 是不同接口。LG 使用前者，独立 schema 返回 MemoryBatch；后者不接。

默认 memory 指令鼓励推断、概念总结与模型行为学习，不符合 LG 事实采信边界，因此覆盖为直接陈述、逐字证据、无推断的指令。上游随机 memory id 不进入 LG MemoryId。外部组件不持有数据库句柄。

仅 max_steps=1 还不能限制 trustcall 的内部修补；其默认 max_attempts=3。接入显式设 max_attempts=1，SDK retry=0，并验证坏 schema 只发一次请求。没有有效结构化批次时抛错，不把失败变成空记忆。

## 已实测的兼容性

- 本机 Python 3.10：导入 FAIL，`typing.NotRequired` 不存在。上游 pyproject 声明 >=3.10，声明与此固定提交实现不一致；没有改上游来绕过。
- 已有 Python 3.12.13：按上游 uv.lock 建独立 venv，导入 PASS；真实工具调用抽取路径已执行。
- Git for Windows 的 CRLF 导致第一版源码 hash 校验 FAIL，规范化 LF 后与下载的固定源码相同。旧 FAIL 保留。
- 第一版 Live 中“示科”与全称的取值差异造成同槽位冲突，FAIL 保留。最终 text 取值必须来自原话，并禁止自动候选修改既有不同值槽位。
- 改动没有新增 Node 依赖、全局 Python 包或生产数据库迁移。模型提供方、密钥和端点沿用既有环境。

## 能力与限制

已实现：受信普通陈述的候选抽取；登记槽位/原话检查；重要用户报告经历；原生价值筛选与写入；去重；不回判历史；持久任务与水位；失败恢复；三次重试后停住；单共享消费者；轮后非阻塞通知；关闭的晚写阻断；生产开关默认 off。

这版只新增长期事实/偏好/经历。不同取值走显式更正；自动路径不复活相同的已遗忘内容。只处理单条来源，不拼接多轮，不把用户报告当成她自己的经历。未登记槽位及 boolean/number 型槽位暂不接自动路径。

模型仍可能错误识别引用、假设、临时状态或摘要含义，逐字原话检查不证明蕴含。短链不是大语料语义覆盖率，尚无 200/500 轮效果与人格收益验收。测试端点不等于生产 DeepSeek 端点；生产首次使用、实际延迟/token 代价和语义索引维护真链仍未验收。

积压单次至多 20 条。三次失败停住时后续事件不越过水位，需要开发者修复后处理；本轮不加管理 UI/自动跳过/无限重试。

## 复现与证据

上游 clone 与实验 venv：`artifacts/post-lv2/local/automatic-memory-20261007/langmem/`（隔离实验目录，未变成生产安装）。

独立环境复现：clone 官方仓库，checkout 上述完整提交 SHA，使用已经安装的 Python 3.12 执行 `uv sync --frozen --no-dev --python <python312.exe>`。不要使用默认 Python 3.10，也不要运行无锁安装。

核对的上游文件及依赖 manifest 放在 `artifacts/research/automatic-memory-20261007/`。每次 `run-*/result.json` 分列 offline/live 和失败，不覆盖旧档。完整回归的日志及新产生的历史固定路径 artifact 内容另归档到 `regression-*/generated/`，仓库中此前的证据字节恢复保留。

运行命令：

```powershell
pnpm typecheck
pnpm postlv2:automatic-memory:verify
pnpm with-test-model pnpm postlv2:automatic-memory:live
pnpm m4.5:ci
```

准确的本轮终读数见同目录 `acceptance.json`，设计与激活边界见 [ADR-117](../adr/ADR-117-automatic-memory-langmem.md)。

## 本轮终读数

| 维度 | 结果 | 证据 |
| --- | --- | --- |
| 默认开关 | OFF，生产未激活 | `readKernelFlags({})` 与 `.env` 中没有新开关 |
| 离线专项 | PASS 20/20，含真实 main bridge 关闭后读回 | `run-1791374598536/result.json` |
| 真实测试模型短链 | PASS 13/13，原生写入管线与语义负例 | `run-1791374609136/result.json` |
| 类型检查 | EXIT 0 | 实际执行 `pnpm typecheck` |
| 完整离线回归 | `pnpm m4.5:ci` EXIT 0；含前置 typecheck 耗时约 402 秒 | `regression-1791374449978/ci.log` 与 `result.json` |
| 生产首次使用 / 生产模型兼容性 / 长轨收益 | NOT OBSERVED / NOT RUN | 未拿短链读数外推 |

完整离线回归中聚合器承接已有 Live Smoke，它不是本轮重跑的 production-copy Live。原来的 6 个固定路径证据文件已逐字节恢复，本轮新内容另存 regression 的 generated 子目录。

原始短链报告的 `modelCalls` 只统计本地 fixture 请求，live 报告中的 0 不能解读成“没发模型请求”；真实模型调用次数/Token 没有量具计量，汇总按 NOT MEASURED 标注。运行器后续输出将该字段明确改名为 `fixtureModelCalls`。

## 后续生产激活（状态追加，2026-10-07）

用户随后授权“好的进行生产激活”，已按 [ADR-118](../adr/ADR-118-automatic-memory-production-activation.md) 执行。独立生产 venv 部署、新配置、生效启动和水位副本读回均已完成；水位 765，历史未回判，既有 4 条记忆未改写。核心及 QQ/Live2D 外壳已恢复常驻，自然生产首次写入仍 NOT OBSERVED。详见[激活记录](Automatic-Memory-Activation-Record-2026-10-07.md)。上面的未激活读数作为前一轮历史保留。
