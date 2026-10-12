# LG 回复时延优化：网上方案与本项目取舍

日期：2026-10-05。范围：公开官方文档、开源源码与本地调用链核查；没有安装框架、下载模型或运行新的付费模型批量。

**后续执行已完成候选对照，记录见 [Latency-Optimization-2026-10-05](../post-lv2/Latency-Optimization-2026-10-05.md)**：采用只读准备重叠和首句组织提示；思考档和较小播放缓冲均未通过预先采用条件，保留原设置。下面是对照执行之前的研究记录，「本轮」指研究阶段，不代表后续未进行试验。

本轮已实现的只有[目标理解 8 秒限时](../post-lv2/Goal-Understanding-Deadline-2026-10-05.md)。以下均为待验证方案，不能当作已获得的时延收益。用户已取消 5 秒硬目标，采用「等待越短越好、检测与回复事实的代价单列」的取舍。

## 1. 当前链路决定优先级

当前是召回与上下文准备 → 每轮目标理解 → 本轮目标写入/投影/事实 → 主回复 → 检查分句 → CosyVoice → 网页缓冲播放。

目标理解的测量值为 1.515–3.848 秒；97–99% 是它在装配中段的占比。召回另有 0.114、0.143、1.548 秒读数，不能把全部装配都算在目标理解上。20 秒离群轮与原期限吻合，但原始报告没有逐轮证明其实际 timeout 结局，因此不宣称所有离群都由这一条原因造成。

本地 `.env` 的主/小模型均为 DeepSeek 官方 `deepseek-flash`，测试 `.env.test` 则是 Ark 接入的 `deepseek-v4.1-flash`；两套端点与协议能力不能互相当作已验证。本轮仅读取端点与模型名，没有输出凭证。

SSE 与按句检查交给 TTS 已有[独立实现和读数](../post-lv2/Checked-Sentence-Streaming-2026-10-05.md)。无需重新造一套流式框架；当前短回复样本仍是首句 9.835 秒、首音频 12.075 秒，表明首句之前的等待仍值得优先处理。该读数不是本轮前后配对实验。

## 2. 优先候选：只降低目标解析支路的思考开销

DeepSeek 官方文档说明 `thinking` 默认开启、默认思考档为 high，可以显式关闭或降低档位；`temperature` 在 thinking 模式中不生效。[Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/)、[Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)。

本地 `openai-goal-understanding.ts` 只传了 model、temperature、json_object 和 messages，没有传 thinking、reasoning_effort 或 max_tokens。**推断**：生产目标解析可能承担了默认思考的等待；本轮未测 reasoning token，不能宣称这已解释全部耗时。

建议先做目标解析支路的隔离对照：保持相同模型、8 秒期限、候选、提示词和严格校验，分别比较现状、low 与 disabled。主回复的人格推理设置保留现状，不能通过改全局 `OPENAI_SMALL_MODEL` 顺手影响其他消费者；Ark 参数需按它自己的官方接口确认。

代价是指代、隐式接受、重新订立、取消、结清等识别可能退化。先覆盖现有 M10 语料和 M10.1/Lv2 的约定边界，再分列时延、超时、漏记和误写；不能只拿格式通过率作质量证据。此对照未运行，未切换生产。

## 3. 下一候选：并行准备，保持原来的事实提交顺序

[Pipecat ParallelPipeline](https://docs.pipecat.ai/api-reference/server/pipeline/parallel-pipeline)提供独立分支同时执行、协调输出的机制，实际实现见[源码](https://github.com/pipecat-ai/pipecat/blob/main/src/pipecat/pipeline/parallel_pipeline.py)。本项目可借鉴这一组织方式，用现有 TypeScript 异步任务完成，不引入第二套语音 runtime。

LG 可考察把已经完成来源资格、遮蔽和输入快照的目标**解析**与只读召回重叠执行；解析结果仍在原位置经过校验、写入、投影，然后才编译主回复。不能直接让整个 `runGoalTurn` 提早并发，因为它包含写入，可能改变其他状态读取的先后关系。信念去重仍必须等待实际召回集合。

按现有三条时间账，无资源竞争时可节省的上界约为两项较小者：A 1.548 秒、B 0.143 秒、C 0.114 秒。这是调度估算，实际收益可能更低；冷召回可能更有价值，热轮次不一定明显。出口验证包括同轮目标事实仍入模、写入顺序、来源/遮蔽、取消、迟到结果和原回归。

## 4. 低成本核查：固定前缀与 JSON 输出长度

DeepSeek 的缓存按已持久化的相同前缀命中，默认自动运行，不需要另装缓存服务。[Context Caching](https://api-docs.deepseek.com/guides/kv_cache/)。目标解析已有固定 system 提示与动态 user 消息分离，不能把「加缓存」自动当成新的收益。先读取 usage 的命中/未命中计数和耗时，再考虑保持前缀稳定或等价精简重复指令。

官方 JSON 指南要求合理设置 max_tokens，避免 JSON 被中途截断；也说明 JSON 输出可能为空。[JSON Output](https://api-docs.deepseek.com/guides/json_mode/)。本地解析适配器没有显式设置输出上界，可以对照足以容纳完整合法草案的预算；不能直接套一个很小的数字，吞掉 statement/span/commitment 或掐断思考后只看到空正文。格式约束仍不等于语义正确。

本轮没有删指令、降低 token 预算或添加缓存。目标状态和记忆结果不可跨轮无条件复用。

## 5. 交付侧：更早完成首句，按抖动调缓冲

现有 CheckedSpeechStream 等一个完整 segment JSON 对象后再检查和发送；长段落包成一个对象会延迟首句。可优先让每个 segment 保持完整、自然的短句，首句经过原守卫后立刻开始合成，后文继续生成。不得播放不完整 JSON、未检查 token 或用占位音冒充实质回答。

网页当前首播要等累计 3 秒音频内容或 final，调度 lead 为 0.4 秒。3 秒是音频内容量，不是固定墙钟等待。降低它们可能加快真正首播，也可能增加欠载断音；应记录首音频包到达、播放器 playing、underruns 与重复播放，按同负载进行对照。限时的离线门不证明该项已变快。

## 6. 后置候选：提前推测与本地小模型

[LiveKit 提前生成](https://docs.livekit.io/agents/multimodality/audio/#preemptive-speech-generation)会在话轮确认前开始 LLM 工作；上下文或 tools 改变则丢弃并重算，默认把 TTS 留到确认后。它明确有额外 token 与废弃计算成本。

适合 LG 的借鉴是「只读准备 + 版本核对 + 改口作废」，而不是在 partial 上提前正式写入，或先播没有本轮目标事实的主回复。LG 的同轮状态更新会使准备上下文失效，因此完整回答推测可能频繁废弃；先证明低成本准备的净收益，再评估此路线。本轮未启用推测回复。

[vLLM structured outputs](https://docs.vllm.ai/en/stable/examples/features/structured_outputs/)提供 JSON schema 等解码约束，但不保证中文目标语义、证据坐标或约定判断正确。本地小模型还需评估本机部署、质量和与 CosyVoice 的 GPU 竞争；暂不为这一处解析增加服务、模型权重或迁移平台。

## 7. 复用结论与下一步

本次核查 [Pipecat LICENSE](https://raw.githubusercontent.com/pipecat-ai/pipecat/main/LICENSE)为 BSD-2-Clause；[LiveKit Agents LICENSE](https://raw.githubusercontent.com/livekit/agents/main/LICENSE)为 Apache-2.0。此次均只作为架构参考，没有复制代码或安装依赖；若后续直接复用，须固定版本并保留相应版权和许可材料。

建议顺序：8 秒限时 → 目标解析支路思考档对照 → 独立准备重叠 → 首句与缓冲对照。前缀缓存先核查已有命中，完整回答推测和本地小模型留作后备。每项单独改变一个主要变量，并分列首播等待与目标/承诺质量。

研究来源是官方页面检索内容及开源文件；DeepSeek 文档直接 open 多次超时，相关说明采用其官方搜索快照，未调用真实 API 验证服务默认值。上游说明、调度估算和文档中的延迟目标均不是本机收益证据。
