# ADR-117 — 普通对话的自动记忆候选抽取

日期：2026-10-07。状态：IMPLEMENTED / DEFAULT OFF / PRODUCTION NOT ACTIVATED。

用户本轮选择先补差距第 1 项，并要求 GitHub 现成方案优先。本次交付为现成组件筛选、候选抽取接入和隔离验收；生产配置未修改。

## 问题与选择

ADR-108 的显式写入已经覆盖自然语言的“记住 / 更正 / 忘掉”要求，但普通陈述不产生长期记忆。ADR-025 定义的后台候选、价值筛选、冲突、Policy、事件和折叠组件可复用，原 `CHARACTER_MEMORY_BACKGROUND_ENABLED` 仍是 NOT-WIRED。

采用 [LangMem](https://github.com/langchain-ai/langmem/tree/48e3c11f5bb527282c7d5339c6a87a0b35abccfc) 的 `create_memory_manager` 纯候选接口。固定提交 `48e3c11f5bb527282c7d5339c6a87a0b35abccfc`、版本 0.0.30、MIT，依赖按该提交的 `uv.lock` 安装到项目实验目录的独立 venv。

没有采用它的 Store Manager、LangGraph 持久化或自动更新/删除。没有替换 LG 的账本、记忆后端、召回、模型提供方或对话框架。比较记录见 [筛选与验收报告](../post-lv2/Automatic-Memory-GitHub-Selection-2026-10-07.md)。

## D01 — 窄输入与纯候选输出

第一版每次处理一条受信的人类 `user_message`，身份必须等于共享核心绑定的用户。`processorEventViewOf` 及受信来源资格检查保持既有权威来源。工具、系统、角色输出、未确认的程序输入不进抽取模型。两入口以同一用户身份消费，事件来自各自账本，文本不跨会话拼接。

允许：明确陈述的长期事实、稳定偏好、用户报告的重要真实经历。经历只有 USER 参与者，不能变成角色亲历或共同经历。第一版不处理多轮联合抽取、隐含特征、模型推断或自我经历。

问句和规则识别出的显式记忆命令在调用模型前排除。引用、假设、虚构、临时感受和普通闲聊由抽取指令要求返回空候选。它们的语义识别存在模型残差，短样本验收不等于普遍保证。

## D02 — 程序约束与既有放行链

每次最多 4 条候选，必须引用当前源事件并带逐字原话。事实/偏好只接受已登记的 text/enum/scale 槽位；text 取值必须是证据原话的连续片段，enum/scale 必须在登记表的 allowed 中。原话包含关系不等于逐句蕴含证明，谓词对应和经历摘要仍有语义风险。

LangMem 输出经 `parseCandidatesJson`、原话/范围/槽位检查、`resolveCandidates` 转成原生候选，再经既有 Value Gate（0.45）、Conflict、MemoryMutationValidator、`applyAcceptedEvents` 和 NativeMemoryStore 折叠。权限和权威不由上游随机 id、模型自报字段或模型置信度决定。

已有同槽位不同值：第一版拒绝自动变更，交给显式更正路径；避免别名差异把已经采信的事实变成争议。相同内容的 retracted/superseded 记录不因自动抽取复活。已有记录在源事件之后被修改，则过期候选不写入。

## D03 — 持久任务与事务

使用已有 `character_jobs`、`processor_watermarks`、`processed_operations`，不新增 schema，不申请生产迁移。处理器为 `automatic-memory-langmem / automatic-memory-langmem@1`，与旧抽取处理器版本分开。

首次启用预置为当前真实账本最大序号，不回判此前聊天。后续从水位读取下一条真实事件，允许全局序号有空洞；单条来源范围固定，不因后来新消息改变重试对象。非用户事件有正常零候选终态。

模型在事务外；候选验证、领域事件、原生折叠、任务完成和水位前进同事务。事务前后均检查晚写 fence。失败落 failed、保存历史、不推进水位；最多三次失败后停在该源，需要开发者处理并恢复，不能越过它继续假装正常。

单次通知最多消费 20 条源事件。较大停机积压需要后续轮次继续触发，没有无限后台追赶或额外定时服务。

## D04 — 单共享消费者与关闭

`ChatSession` 的 owner 在 `openSharedConsumers()` 中构造唯一消费者；QQ/Live2D 借用会话只调用 delegate。每轮 `completeTurn` 后非阻塞通知，当前回复不等模型抽取。

关闭先关闭写 fence、abort Python 子进程，再收拢任务，最后走既有唯一关库链。语义索引维护通过既有 maintenance trigger 投递；语义召回关闭时不会因此启编码器。编码器开着时的自动写入维护接线尚未独立做真实运行验收。

## D05 — 上游调用边界

新 Python worker 只接收源事件及登记表。LangMem inserts 开、updates/deletes 关、existing 空、max_steps=1；trustcall max_attempts=1，SDK max_retries=0。不启动额外的 JSONPatch 修补请求。

HTTP 超时 30 秒，子进程总上限 40 秒，输入原文最多 8000 字符，输出最多 32000 字符，模型 max_tokens=4096。成功的空 MemoryBatch 是正常结果；没有有效批次、格式错误、网络失败是失败，不能被折算成“没有值得记的”。

显式关闭 LangChain/LangSmith tracing。凭证只由现有 OPENAI 环境注入，不写命令行。日志只有任务状态、序号和计数，不含 prompt/候选/原话/provider error body。所选对话会发给现有模型提供方；LangMem 不提供额外的记忆云。

## D06 — 激活与撤回

新开关 `CHARACTER_MEMORY_AUTOMATIC_ENABLED` 缺省 false。启用还需 `CHARACTER_MEMORY_ENABLED=true` 和 `CHARACTER_MEMORY_AUTOMATIC_PYTHON` 指向通过验收的独立 Python 环境。旧 background 开关及历史 NOT-WIRED 门不改。

实验用 Python 3.12.13。Python 3.10 导入失败已经记录，不能沿用项目默认的 3.10。上游声明 >=3.10 与该提交代码的 `typing.NotRequired` 使用不一致。本项目不修改上游源码；worker 校验 LangMem 版本及 extraction.py 的规范化 LF SHA-256。

生产 `.env` 本轮未改、自然生产首次使用 NOT OBSERVED。生产模型 `api.deepseek.com / deepseek-flash` 与验收端点 `ark / deepseek-v4.1-flash` 不同，不能承接其工具调用兼容性、延迟和收益。撤回为开关改回 false 后重启；已有任务、事件、投影保留，不回写历史、不自动删记忆。

## 验收位置

`pnpm postlv2:automatic-memory:verify`：真实 LangMem + 本地模型 HTTP fixture + 新隔离库；另启动真实 `main.ts --bridge`，关闭子进程后读回隔离库。

`pnpm with-test-model pnpm postlv2:automatic-memory:live`：真实测试模型 + 新隔离库 + 原生完整写入链的短语义检查，不打开生产库、不产生实际 QQ 外发。

每次结果另存 `artifacts/research/automatic-memory-20261007/run-*/result.json`；失败档原样保留。类型检查和完整 `m4.5:ci` 的读数分列，不能以组件检查宣称生产能力已经启用。
